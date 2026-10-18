-- =====================================================================
-- KLC Absensi v2
-- Jalankan SEKALI di Supabase > SQL Editor (seluruh isi file sekaligus).
--
-- Isi:
--   1. Kolom baru di tabel attendance (mapel, metode, lokasi, catatan, status cek)
--   2. Fungsi bantu (guru yang sedang login, tenggat perbaikan)
--   3. RPC absen masuk / keluar versi baru
--   4. RPC cek PJ/PSD, perbaikan oleh guru, tandai terkirim
--   5. Penutupan otomatis sesi > 120 menit
--   6. Hak akses: RPC lama ditutup, RPC baru hanya untuk user login
--
-- Tidak ada tabel baru dan tidak ada policy SELECT yang diubah.
-- Tabel attendance TIDAK punya policy INSERT/UPDATE, jadi semua perubahan
-- data absensi wajib lewat fungsi di file ini (lebih aman dan terkontrol).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Kolom baru
-- ---------------------------------------------------------------------
alter table public.attendance
  add column if not exists subject        text,              -- mapel
  add column if not exists method         text,              -- offline / online / cancel
  add column if not exists note           text,              -- catatan guru (kendala/evaluasi/saran/alasan cancel)
  add column if not exists clock_in_lat   double precision,
  add column if not exists clock_in_lng   double precision,
  add column if not exists clock_out_lat  double precision,
  add column if not exists clock_out_lng  double precision,
  add column if not exists auto_closed    boolean not null default false,
  add column if not exists pj_checked_by  uuid references public.profiles(id),
  add column if not exists pj_checked_at  timestamptz,
  add column if not exists psd_checked_by uuid references public.profiles(id),
  add column if not exists psd_checked_at timestamptz,
  add column if not exists sent_by        uuid references public.profiles(id),
  add column if not exists sent_at        timestamptz;

alter table public.attendance drop constraint if exists attendance_method_check;
alter table public.attendance
  add constraint attendance_method_check check (method is null or method in ('offline', 'online', 'cancel'));

-- review_status dipakai sebagai status cek:
--   pending      = menunggu PJ
--   pj_approved  = disetujui PJ, menunggu PSD
--   approved     = disetujui PSD, siap diekspor
--   rejected     = ditolak (alasan di review_note)
--   sent         = sudah dikirim ke bendahara (terkunci)
-- Constraint lama yang membatasi review_status dihapus lalu diganti.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.attendance'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%review_status%'
  loop
    execute format('alter table public.attendance drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.attendance
  add constraint attendance_review_status_check
  check (review_status in ('pending', 'pj_approved', 'approved', 'rejected', 'sent'));

-- Tanggal mengajar memakai tanggal WIB, bukan UTC.
alter table public.attendance
  alter column teaching_date set default ((now() at time zone 'Asia/Jakarta')::date);

-- ---------------------------------------------------------------------
-- 2. Fungsi bantu
-- ---------------------------------------------------------------------

-- id pengajar aktif milik akun yang sedang login (null jika bukan guru aktif)
create or replace function public.klc_current_teacher_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select t.id
  from public.teachers t
  join public.profiles pf on pf.id = t.profile_id
  where t.profile_id = auth.uid()
    and t.is_active
    and pf.role = 'teacher'
    and pf.is_active
  limit 1;
$$;

-- Tenggat perbaikan absen ditolak:
-- hari Minggu pertama bulan berikutnya, pukul 11.59 WIB.
create or replace function public.klc_fix_deadline(p_teaching_date date)
returns timestamptz
language sql immutable set search_path = ''
as $$
  select ((first_day + ((7 - extract(dow from first_day)::int) % 7)) + time '11:59')
         at time zone 'Asia/Jakarta'
  from (select (date_trunc('month', p_teaching_date) + interval '1 month')::date as first_day) x;
$$;

-- Validasi daftar adik: 1-6 adik aktif dari program yang sama. Mengembalikan jumlah adik.
create or replace function public.klc_check_students(p_program_id uuid, p_student_ids uuid[])
returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare v_count integer;
begin
  select count(distinct x) into v_count from unnest(p_student_ids) as x;
  if v_count < 1 or v_count > 6 then
    raise exception 'Pilih 1 sampai 6 adik.';
  end if;
  if (select count(*) from public.students s
      where s.id = any(p_student_ids) and s.program_id = p_program_id and s.is_active) <> v_count then
    raise exception 'Ada adik yang tidak aktif atau bukan dari program ini.';
  end if;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 5. Penutupan otomatis (> 120 menit tanpa absen keluar)
--    Dipanggil pg_cron setiap 10 menit (file 02) dan juga saat guru absen.
--    p_teacher_id null = semua guru.
-- ---------------------------------------------------------------------
create or replace function public.auto_close_attendance(p_teacher_id uuid default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  update public.attendance
  set clock_out_at = clock_in_at + interval '120 minutes',
      auto_closed  = true
  where clock_out_at is null
    and clock_in_at is not null
    and clock_in_at <= now() - interval '120 minutes'
    and (p_teacher_id is null or teacher_id = p_teacher_id);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 3. Absen masuk & keluar
-- ---------------------------------------------------------------------
create or replace function public.clock_in_v2(
  p_program_id  uuid,
  p_subject     text,
  p_method      text,
  p_student_ids uuid[],
  p_photo_path  text,
  p_lat         double precision,
  p_lng         double precision,
  p_note        text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := public.klc_current_teacher_id();
  v_code    text;
  v_count   integer;
  v_id      uuid;
  v_now     timestamptz := now();
  v_note    text := nullif(btrim(p_note), '');
begin
  if v_teacher is null then
    raise exception 'Akun ini bukan pengajar aktif.';
  end if;

  select p.code into v_code
  from public.programs p
  join public.teacher_program_assignments a on a.program_id = p.id
  where p.id = p_program_id and p.is_active
    and a.teacher_id = v_teacher and a.is_active;
  if v_code is null then
    raise exception 'Program ini tidak ditugaskan kepadamu.';
  end if;

  if nullif(btrim(p_subject), '') is null then raise exception 'Mapel wajib dipilih.'; end if;
  if p_method is null or p_method not in ('offline', 'online', 'cancel') then raise exception 'Metode tidak valid.'; end if;
  if p_method = 'cancel' and v_note is null then raise exception 'Alasan cancel class wajib diisi di catatan.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Lokasi wajib diizinkan untuk absen.';
  end if;
  -- Foto harus berada di folder milik akun ini di bucket attendance-photos.
  if p_photo_path is null or p_photo_path not like auth.uid()::text || '/%' then
    raise exception 'Foto absen tidak valid.';
  end if;

  v_count := public.klc_check_students(p_program_id, p_student_ids);

  -- Cadangan jika pg_cron terlambat: tutup dulu sesi lama milik guru ini yang > 120 menit.
  perform public.auto_close_attendance(v_teacher);
  if exists (select 1 from public.attendance where teacher_id = v_teacher and clock_out_at is null) then
    raise exception 'Masih ada sesi yang belum absen keluar.';
  end if;

  insert into public.attendance (
    teacher_id, program_id, class_type, teaching_date, subject, method, note, student_count,
    clock_in_at, clock_in_photo_path, clock_in_lat, clock_in_lng, clock_out_at, review_status
  ) values (
    v_teacher, p_program_id, v_code, (v_now at time zone 'Asia/Jakarta')::date, btrim(p_subject), p_method, v_note, v_count,
    v_now, p_photo_path, p_lat, p_lng,
    case when p_method = 'cancel' then v_now end,   -- cancel class langsung selesai
    'pending'
  ) returning id into v_id;

  -- Snapshot nama, kelas, program adik saat ini.
  insert into public.attendance_students (attendance_id, student_id, student_name_snapshot, class_name_snapshot, program_id_snapshot)
  select v_id, s.id, s.full_name, s.class_name, s.program_id
  from public.students s
  where s.id = any(p_student_ids);

  return v_id;
end $$;

drop function if exists public.clock_out_v2(uuid, text, double precision, double precision, text);
create or replace function public.clock_out_v2(
  p_attendance_id uuid,
  p_photo_path    text,
  p_lat           double precision,
  p_lng           double precision,
  p_note          text default null
)
returns text   -- 'closed' = absen keluar tercatat, 'auto_closed' = sudah lewat 120 menit
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := public.klc_current_teacher_id();
  r public.attendance%rowtype;
begin
  select * into r from public.attendance where id = p_attendance_id for update;
  if not found or v_teacher is null or r.teacher_id <> v_teacher then
    raise exception 'Sesi tidak ditemukan.';
  end if;
  if r.clock_out_at is not null then raise exception 'Sesi ini sudah ditutup.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Lokasi wajib diizinkan untuk absen.';
  end if;
  if p_photo_path is null or p_photo_path not like auth.uid()::text || '/%' then
    raise exception 'Foto absen tidak valid.';
  end if;
  -- Lewat 120 menit: sesi ditutup otomatis (bukan error, agar penutupan tetap tersimpan).
  if r.clock_in_at <= now() - interval '120 minutes' then
    perform public.auto_close_attendance(v_teacher);
    return 'auto_closed';
  end if;

  update public.attendance
  set clock_out_at = now(),
      clock_out_photo_path = p_photo_path,
      clock_out_lat = p_lat,
      clock_out_lng = p_lng,
      note = coalesce(nullif(btrim(p_note), ''), note)
  where id = p_attendance_id;
  return 'closed';
end $$;

-- ---------------------------------------------------------------------
-- 4a. Cek oleh PJ atau PSD
--     p_decision: 'approve' atau 'reject' (reject wajib catatan)
-- ---------------------------------------------------------------------
create or replace function public.review_attendance(
  p_attendance_id uuid,
  p_decision      text,
  p_note          text default null
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_note   text := nullif(btrim(p_note), '');
  v_status text;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'Keputusan tidak valid.'; end if;
  if p_decision = 'reject' and v_note is null then raise exception 'Catatan penolakan wajib diisi.'; end if;

  select a.*, t.profile_id as teacher_profile_id into r
  from public.attendance a
  join public.teachers t on t.id = a.teacher_id
  where a.id = p_attendance_id
  for update of a;
  if not found then raise exception 'Sesi tidak ditemukan.'; end if;
  if r.clock_out_at is null then raise exception 'Sesi masih berjalan.'; end if;
  if r.review_status = 'sent' then raise exception 'Sesi sudah dikirim ke bendahara dan terkunci.'; end if;

  if public.is_current_user_psd() then
    -- PSD boleh memutuskan kapan saja selama belum terkirim, tanpa menunggu PJ.
    v_status := case when p_decision = 'approve' then 'approved' else 'rejected' end;
    update public.attendance
    set review_status  = v_status,
        psd_checked_by = auth.uid(),
        psd_checked_at = now(),
        reviewed_by    = auth.uid(),
        reviewed_at    = now(),
        review_note    = case when p_decision = 'reject' then v_note end
    where id = p_attendance_id;
    return v_status;
  end if;

  if not public.is_current_user_program_manager(r.program_id) then
    raise exception 'Kamu tidak berhak mengecek sesi ini.';
  end if;
  -- PJ yang juga mengajar tidak boleh mengecek absennya sendiri.
  if r.teacher_profile_id = auth.uid() then
    raise exception 'Absen milikmu sendiri dicek oleh PSD.';
  end if;
  if r.review_status <> 'pending' then
    raise exception 'Sesi ini sudah dicek.';
  end if;

  v_status := case when p_decision = 'approve' then 'pj_approved' else 'rejected' end;
  update public.attendance
  set review_status = v_status,
      pj_checked_by = auth.uid(),
      pj_checked_at = now(),
      reviewed_by   = auth.uid(),
      reviewed_at   = now(),
      review_note   = case when p_decision = 'reject' then v_note end
  where id = p_attendance_id;
  return v_status;
end $$;

-- ---------------------------------------------------------------------
-- 4b. Perbaikan absen ditolak oleh guru pemiliknya (sebelum tenggat)
--     Jam dan lokasi tidak bisa diubah. Foto boleh diganti (null = tetap).
--     Metode tidak bisa diubah dari/ke cancel class.
-- ---------------------------------------------------------------------
create or replace function public.fix_rejected_attendance(
  p_attendance_id          uuid,
  p_program_id             uuid,
  p_subject                text,
  p_method                 text,
  p_student_ids            uuid[],
  p_note                   text default null,
  p_clock_in_photo_path    text default null,
  p_clock_out_photo_path   text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := public.klc_current_teacher_id();
  r public.attendance%rowtype;
  v_code  text;
  v_count integer;
  v_note  text := nullif(btrim(p_note), '');
begin
  select * into r from public.attendance where id = p_attendance_id for update;
  if not found or v_teacher is null or r.teacher_id <> v_teacher then raise exception 'Sesi tidak ditemukan.'; end if;
  if r.review_status <> 'rejected' then raise exception 'Hanya absen yang ditolak yang bisa diperbaiki.'; end if;
  if now() > public.klc_fix_deadline(r.teaching_date) then raise exception 'Batas waktu perbaikan sudah lewat.'; end if;

  select p.code into v_code
  from public.programs p
  join public.teacher_program_assignments a on a.program_id = p.id
  where p.id = p_program_id and p.is_active and a.teacher_id = v_teacher and a.is_active;
  if v_code is null then raise exception 'Program ini tidak ditugaskan kepadamu.'; end if;

  if nullif(btrim(p_subject), '') is null then raise exception 'Mapel wajib dipilih.'; end if;
  if p_method is null or p_method not in ('offline', 'online', 'cancel') then raise exception 'Metode tidak valid.'; end if;
  if (coalesce(r.method, 'offline') = 'cancel') <> (p_method = 'cancel') then
    raise exception 'Metode tidak bisa diubah dari atau ke cancel class.';
  end if;
  if p_method = 'cancel' and v_note is null then raise exception 'Alasan cancel class wajib diisi di catatan.'; end if;
  if p_clock_in_photo_path is not null and p_clock_in_photo_path not like auth.uid()::text || '/%' then raise exception 'Foto absen tidak valid.'; end if;
  if p_clock_out_photo_path is not null and p_clock_out_photo_path not like auth.uid()::text || '/%' then raise exception 'Foto absen tidak valid.'; end if;

  v_count := public.klc_check_students(p_program_id, p_student_ids);

  update public.attendance
  set program_id           = p_program_id,
      class_type           = v_code,
      subject              = btrim(p_subject),
      method               = p_method,
      note                 = v_note,
      student_count        = v_count,
      clock_in_photo_path  = coalesce(p_clock_in_photo_path, clock_in_photo_path),
      clock_out_photo_path = coalesce(p_clock_out_photo_path, clock_out_photo_path),
      review_status        = 'pending',   -- kembali dicek PJ
      review_note          = null,
      reviewed_by          = null,
      reviewed_at          = null,
      pj_checked_by        = null,
      pj_checked_at        = null,
      psd_checked_by       = null,
      psd_checked_at       = null
  where id = p_attendance_id;

  delete from public.attendance_students where attendance_id = p_attendance_id;
  insert into public.attendance_students (attendance_id, student_id, student_name_snapshot, class_name_snapshot, program_id_snapshot)
  select p_attendance_id, s.id, s.full_name, s.class_name, s.program_id
  from public.students s
  where s.id = any(p_student_ids);
end $$;

-- ---------------------------------------------------------------------
-- 4c. Tandai sudah dikirim ke bendahara (PSD saja). Hanya sesi 'approved'.
-- ---------------------------------------------------------------------
create or replace function public.mark_attendance_sent(p_attendance_ids uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare v_count integer;
begin
  if not public.is_current_user_psd() then raise exception 'Hanya PSD yang bisa menandai terkirim.'; end if;
  update public.attendance
  set review_status = 'sent', sent_by = auth.uid(), sent_at = now()
  where id = any(p_attendance_ids) and review_status = 'approved';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 4d. Nama pengajar untuk rekap PJ.
--     PJ tidak boleh membaca tabel teachers (ada data rekening), jadi
--     fungsi ini hanya memberikan id + nama pengajar di program yang dia pegang.
-- ---------------------------------------------------------------------
create or replace function public.get_my_program_teacher_names()
returns table (id uuid, full_name text)
language sql stable security definer set search_path = ''
as $$
  select distinct t.id, t.full_name
  from public.teachers t
  where exists (
          select 1 from public.teacher_program_assignments a
          join public.program_managers pm on pm.program_id = a.program_id
          where a.teacher_id = t.id and pm.profile_id = auth.uid() and pm.is_active)
     or exists (
          select 1 from public.attendance at
          join public.program_managers pm on pm.program_id = at.program_id
          where at.teacher_id = t.id and pm.profile_id = auth.uid() and pm.is_active);
$$;

-- ---------------------------------------------------------------------
-- 6. Hak akses fungsi
-- ---------------------------------------------------------------------

-- RPC absen lama ditutup supaya absen selalu lewat versi baru (wajib mapel, metode, lokasi).
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('clock_in_with_students', 'clock_out')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

revoke all on function public.klc_current_teacher_id()                from public, anon, authenticated;
revoke all on function public.klc_check_students(uuid, uuid[])          from public, anon, authenticated;
revoke all on function public.auto_close_attendance(uuid)               from public, anon, authenticated;
revoke all on function public.klc_fix_deadline(date)                    from public, anon;
revoke all on function public.clock_in_v2(uuid, text, text, uuid[], text, double precision, double precision, text) from public, anon;
revoke all on function public.clock_out_v2(uuid, text, double precision, double precision, text)                    from public, anon;
revoke all on function public.review_attendance(uuid, text, text)       from public, anon;
revoke all on function public.fix_rejected_attendance(uuid, uuid, text, text, uuid[], text, text, text) from public, anon;
revoke all on function public.mark_attendance_sent(uuid[])              from public, anon;
revoke all on function public.get_my_program_teacher_names()            from public, anon;

grant execute on function public.klc_fix_deadline(date) to authenticated;
grant execute on function public.clock_in_v2(uuid, text, text, uuid[], text, double precision, double precision, text) to authenticated;
grant execute on function public.clock_out_v2(uuid, text, double precision, double precision, text) to authenticated;
grant execute on function public.review_attendance(uuid, text, text) to authenticated;
grant execute on function public.fix_rejected_attendance(uuid, uuid, text, text, uuid[], text, text, text) to authenticated;
grant execute on function public.mark_attendance_sent(uuid[]) to authenticated;
grant execute on function public.get_my_program_teacher_names() to authenticated;

commit;
