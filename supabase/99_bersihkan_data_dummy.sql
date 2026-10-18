-- =====================================================================
-- KLC: bersihkan data uji coba SEBELUM sosialisasi
-- JANGAN dijalankan setelah aplikasi dipakai sungguhan.
--
-- Langkah:
--   1. Jalankan bagian CEK dulu, pastikan isinya memang data uji coba.
--   2. Jalankan bagian HAPUS ABSENSI.
--   3. Bagian adik dan pengajar sengaja dijadikan komentar (--).
--      Hapus tanda -- hanya jika data tersebut juga dummy.
--   4. Foto uji coba dihapus manual: Storage > attendance-photos.
-- =====================================================================

-- CEK
select count(*) as jumlah_absensi from public.attendance;
select count(*) as jumlah_snapshot from public.attendance_students;
select count(*) as jumlah_adik from public.students;
select full_name, login_email, is_active from public.teachers order by full_name;

-- HAPUS ABSENSI (snapshot dulu, baru sesi)
begin;
delete from public.attendance_students;
delete from public.attendance;
commit;

-- HAPUS ADIK DUMMY (opsional, hanya jika semua adik di tabel ini dummy)
-- begin;
-- delete from public.students;
-- commit;

-- HAPUS PENGAJAR DUMMY (opsional). Ganti daftar email sesuai data dummy.
-- Penugasan program dihapus dulu karena terhubung ke pengajar.
-- begin;
-- delete from public.teacher_program_assignments
--   where teacher_id in (select id from public.teachers where login_email in ('contoh1@gmail.com', 'contoh2@gmail.com'));
-- delete from public.teachers where login_email in ('contoh1@gmail.com', 'contoh2@gmail.com');
-- commit;
