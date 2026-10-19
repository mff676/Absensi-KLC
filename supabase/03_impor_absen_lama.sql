-- =====================================================================
-- KLC: impor absen lama dari Google Form (SEMENTARA)
-- Jalankan SETELAH 01_absensi_v2.sql dan SEBELUM memasang frontend versi ini.
--
-- Isi:
--   1. Kolom is_legacy di attendance (penanda data hasil impor GForm)
--   2. RPC import_legacy_attendance (PSD saja) untuk memasukkan banyak baris sekaligus
--
-- Data impor: jam masuk = jam keluar = Timestamp GForm (waktu kirim form),
-- tanpa lokasi, foto berupa link Google Drive.
-- Baris yang sama (guru + Timestamp sama) tidak akan masuk dua kali.
-- =====================================================================

begin;

alter table public.attendance
  add column if not exists is_legacy boolean not null default false;

drop function if exists public.import_legacy_attendance(jsonb);

-- p_rows: array JSON, tiap elemen berisi
--   teacher_id, program_id, teaching_date (YYYY-MM-DD), submitted_at (timestamp + zona),
--   subject, method (offline/online/cancel), student_ids (array uuid), note,
--   photo_in, photo_out (link), status (pending/pj_approved/approved)
create or replace function public.import_legacy_attendance(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r           jsonb;
  v_id        uuid;
  v_code      text;
  v_students  uuid[];
  v_count     integer;
  v_at        timestamptz;
  v_inserted  integer := 0;
  v_skipped   integer := 0;
  v_index     integer := 0;
begin
  if not public.is_current_user_psd() then
    raise exception 'Hanya PSD yang bisa mengimpor absen lama.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Format data impor tidak valid.';
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_index := v_index + 1;
    v_at := (r->>'submitted_at')::timestamptz;
    v_students := array(select jsonb_array_elements_text(r->'student_ids')::uuid);

    select code into v_code from public.programs where id = (r->>'program_id')::uuid;
    if v_code is null then raise exception 'Baris %: program tidak ditemukan.', v_index; end if;
    if not exists (select 1 from public.teachers where id = (r->>'teacher_id')::uuid) then
      raise exception 'Baris %: pengajar tidak ditemukan.', v_index;
    end if;
    if coalesce(r->>'method', '') not in ('offline', 'online', 'cancel') then
      raise exception 'Baris %: metode tidak valid.', v_index;
    end if;
    if coalesce(r->>'status', '') not in ('pending', 'pj_approved', 'approved') then
      raise exception 'Baris %: status tidak valid.', v_index;
    end if;

    -- Adik wajib terdaftar di program yang sama (aktif atau nonaktif, karena ini data lama).
    select count(distinct x) into v_count from unnest(v_students) as x;
    if v_count < 1 then raise exception 'Baris %: tidak ada adik.', v_index; end if;
    if (select count(*) from public.students s
        where s.id = any(v_students) and s.program_id = (r->>'program_id')::uuid) <> v_count then
      raise exception 'Baris %: ada adik yang bukan dari program ini.', v_index;
    end if;

    -- Lewati jika baris yang sama sudah pernah diimpor.
    if exists (select 1 from public.attendance
               where is_legacy and teacher_id = (r->>'teacher_id')::uuid and clock_in_at = v_at) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.attendance (
      teacher_id, program_id, class_type, teaching_date, subject, method, note, student_count,
      clock_in_at, clock_out_at, clock_in_photo_path, clock_out_photo_path,
      review_status, is_legacy
    ) values (
      (r->>'teacher_id')::uuid, (r->>'program_id')::uuid, v_code, (r->>'teaching_date')::date,
      nullif(btrim(r->>'subject'), ''), r->>'method', nullif(btrim(r->>'note'), ''), v_count,
      v_at, v_at, nullif(btrim(r->>'photo_in'), ''), nullif(btrim(r->>'photo_out'), ''),
      r->>'status', true
    ) returning id into v_id;

    insert into public.attendance_students (attendance_id, student_id, student_name_snapshot, class_name_snapshot, program_id_snapshot)
    select v_id, s.id, s.full_name, s.class_name, s.program_id
    from public.students s
    where s.id = any(v_students);

    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped);
end $$;

revoke all on function public.import_legacy_attendance(jsonb) from public, anon;
grant execute on function public.import_legacy_attendance(jsonb) to authenticated;

commit;

-- Setelah impor selesai dan tidak dibutuhkan lagi, fungsi impor boleh dihapus:
--   drop function public.import_legacy_attendance(jsonb);
-- Kolom is_legacy JANGAN dihapus selama frontend masih membacanya.
