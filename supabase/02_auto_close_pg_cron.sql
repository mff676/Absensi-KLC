-- =====================================================================
-- KLC: jadwal penutupan otomatis sesi > 120 menit
-- Jalankan SETELAH 01_absensi_v2.sql.
--
-- Syarat: extension pg_cron sudah aktif.
--   Supabase Dashboard > Database > Extensions > cari "pg_cron" > Enable.
--
-- Job ini berjalan setiap 10 menit dan memanggil auto_close_attendance().
-- Sesi yang ditutup otomatis: jam keluar = jam masuk + 120 menit,
-- auto_closed = true, tanpa foto keluar. PJ yang memutuskan setujui/tolak.
-- =====================================================================

-- Hapus job lama dengan nama sama (aman dijalankan ulang).
select cron.unschedule(jobid) from cron.job where jobname = 'klc-auto-close-attendance';

select cron.schedule(
  'klc-auto-close-attendance',
  '*/10 * * * *',
  $$ select public.auto_close_attendance(); $$
);

-- Cek: harus muncul 1 baris dengan schedule */10 * * * *
select jobid, jobname, schedule, active from cron.job where jobname = 'klc-auto-close-attendance';
