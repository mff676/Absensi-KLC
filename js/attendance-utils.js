// Fungsi bantu absensi yang dipakai bersama oleh app.js (guru & PSD) dan pj.js (PJ).
// Aturan yang benar-benar mengikat (validasi, hak akses, tenggat) tetap dicek di Supabase;
// fungsi di sini hanya untuk tampilan dan kenyamanan pengguna.

// Daftar mapel per kode program (lihat dokumen spesifikasi).
const REGULAR_SUBJECTS = [
  "IPA SMP", "IPS SMP", "Matematika SMP", "Bahasa Inggris SMP", "Matematika SMA", "Bahasa Inggris SMA",
  "Biologi", "Kimia", "Fisika", "Geografi", "Sosiologi", "TKA", "Ekonomi"
];
export const SUBJECTS_BY_PROGRAM = {
  reguler: REGULAR_SUBJECTS,
  privat: REGULAR_SUBJECTS,
  utbk: [
    "Penalaran Umum", "Pemahaman Bacaan dan Menulis", "Pengetahuan dan Pemahaman Umum", "Pengetahuan Kuantitatif",
    "Penalaran dan Literasi", "Literasi Bahasa Indonesia", "Literasi Bahasa Inggris", "Penalaran Matematika"
  ]
};

export const METHOD_LABELS = { offline: "Offline", online: "Online", cancel: "Cancel class" };

// Kunci status yang dipakai di filter dan badge.
// "running" bukan nilai di database: artinya clock_out_at masih kosong.
export const STATUS_LABELS = {
  running: "Berjalan",
  pending: "Menunggu PJ",
  pj_approved: "Menunggu PSD",
  approved: "Disetujui",
  rejected: "Ditolak",
  sent: "Terkirim"
};

export function statusKey(row) {
  return row.clock_out_at ? row.review_status : "running";
}

export function statusBadge(row) {
  const key = statusKey(row);
  const css = { approved: "badge-active", sent: "badge-active", rejected: "badge-rejected" }[key] || "badge-incomplete";
  return `<span class="badge ${css}">${STATUS_LABELS[key] || key}</span>`;
}

export function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

export function formatDate(dateText) {
  if (!dateText) return "-";
  return new Date(`${dateText}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

export function formatTime(timestamp) {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(timestamp) {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

export function mapsUrl(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Tenggat perbaikan absen ditolak: Minggu pertama bulan berikutnya pukul 11.59 WIB.
// Rumus yang sama ada di fungsi SQL klc_fix_deadline (yang dipakai Supabase untuk menolak).
export function fixDeadline(teachingDate) {
  const [year, month] = teachingDate.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, month, 1)); // tanggal 1 bulan berikutnya
  const offset = (7 - firstDay.getUTCDay()) % 7;        // jarak ke hari Minggu
  const sunday = new Date(Date.UTC(year, month, 1 + offset));
  // 11.59 WIB = 04.59 UTC
  return new Date(Date.UTC(sunday.getUTCFullYear(), sunday.getUTCMonth(), sunday.getUTCDate(), 4, 59));
}

// Ambil lokasi GPS. Absen diblokir jika lokasi tidak tersedia.
export function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Perangkat ini tidak mendukung lokasi. Gunakan HP dengan GPS."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (error) => {
        const messages = {
          1: "Izin lokasi ditolak. Izinkan akses lokasi untuk website ini di pengaturan browser, lalu coba lagi.",
          2: "Lokasi tidak ditemukan. Pastikan GPS menyala, lalu coba lagi.",
          3: "Pengambilan lokasi terlalu lama. Pastikan GPS menyala, lalu coba lagi."
        };
        reject(new Error(messages[error.code] || "Lokasi tidak dapat diambil."));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

// Mengecilkan foto dan menempelkan watermark (mirip aplikasi Timemark).
// lines = array teks, baris pertama ditulis tebal. Hasil: Blob JPEG ±150–300 KB.
export async function stampPhoto(file, lines) {
  if (!file) throw new Error("Foto wajib diambil sebelum melanjutkan.");
  if (!file.type.startsWith("image/")) throw new Error("File yang dipilih bukan foto.");
  // createImageBitmap mengikuti orientasi foto HP (tidak miring).
  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, width, height);

  // Pita gelap di bawah foto agar teks terbaca.
  const fontSize = Math.max(16, Math.round(width / 38));
  const lineHeight = Math.round(fontSize * 1.35);
  const padding = Math.round(fontSize * 0.8);
  const bandHeight = padding * 2 + lineHeight * lines.length;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, height - bandHeight, width, bandHeight);
  ctx.fillStyle = "#ffd54a";
  ctx.fillRect(0, height - bandHeight, Math.max(4, Math.round(fontSize / 4)), bandHeight);

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  lines.forEach((text, index) => {
    ctx.font = `${index === 0 ? "700" : "400"} ${fontSize}px system-ui, sans-serif`;
    ctx.fillText(text, padding * 1.5, height - bandHeight + padding + index * lineHeight, width - padding * 3);
  });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Foto gagal diproses."))), "image/jpeg", 0.72);
  });
}

// Membuat teks watermark standar KLC.
export function watermarkLines({ kind, teacherName, programName, subject, method, location, time = new Date() }) {
  const dateText = time.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeText = time.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const lines = [
    `KARISMA Learning Center · ${kind}`,
    `${timeText} · ${dateText}`,
    `${teacherName}`
  ];
  if (programName || subject || method) {
    lines.push([programName, subject, METHOD_LABELS[method]].filter(Boolean).join(" · "));
  }
  lines.push(`Lokasi: ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`);
  return lines;
}

// CSV aman untuk Excel/Google Sheets (mencegah formula injection).
export function downloadCsv(filename, rows) {
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = rows.map((row) => row.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Isi dialog detail sesi yang sama untuk PSD dan PJ.
// names = { teacher, program } sudah berupa teks biasa.
export function attendanceDetailHtml(row, names) {
  const students = [...(row.attendance_students || [])].sort((a, b) =>
    `${a.class_name_snapshot} ${a.student_name_snapshot}`.localeCompare(`${b.class_name_snapshot} ${b.student_name_snapshot}`, "id"));
  const isCancel = row.method === "cancel";
  const clockOut = isCancel
    ? "- (cancel class)"
    : row.clock_out_at ? `${formatDateTime(row.clock_out_at)}${row.auto_closed ? " · ditutup otomatis" : ""}` : "Belum absen keluar";
  const locationLink = (lat, lng) => {
    const url = mapsUrl(lat, lng);
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Buka di Maps</a>` : "-";
  };
  const checkLine = (label, time) => (time ? `<dt>${label}</dt><dd>${escapeHtml(formatDateTime(time))}</dd>` : "");
  return `
    <dl class="recap-detail-list">
      <dt>Program</dt><dd>${escapeHtml(names.program)}</dd>
      <dt>Mapel</dt><dd>${escapeHtml(row.subject || "-")}</dd>
      <dt>Metode</dt><dd>${escapeHtml(METHOD_LABELS[row.method] || "-")}</dd>
      <dt>Jam masuk</dt><dd>${escapeHtml(formatDateTime(row.clock_in_at))}</dd>
      <dt>Jam keluar</dt><dd>${escapeHtml(clockOut)}</dd>
      <dt>Lokasi masuk</dt><dd>${locationLink(row.clock_in_lat, row.clock_in_lng)}</dd>
      <dt>Lokasi keluar</dt><dd>${locationLink(row.clock_out_lat, row.clock_out_lng)}</dd>
      <dt>Status</dt><dd>${statusBadge(row)}</dd>
      ${row.is_legacy ? "<dt>Sumber</dt><dd>Impor GForm lama (jam = waktu kirim form, tanpa lokasi)</dd>" : ""}
      ${checkLine("Dicek PJ", row.pj_checked_at)}
      ${checkLine("Dicek PSD", row.psd_checked_at)}
      ${checkLine("Terkirim", row.sent_at)}
      <dt>Catatan guru</dt><dd>${escapeHtml(row.note || "-")}</dd>
      ${row.review_status === "rejected" ? `<dt>Alasan ditolak</dt><dd>${escapeHtml(row.review_note || "-")}</dd>` : ""}
    </dl>
    <div class="form-section-title">Adik yang hadir (${students.length})</div>
    ${students.length
      ? `<ol class="recap-student-list">${students.map((s) => `<li><strong>${escapeHtml(s.student_name_snapshot)}</strong> <span class="cell-subtext">${escapeHtml(s.class_name_snapshot)}</span></li>`).join("")}</ol>`
      : '<p class="form-hint">Tidak ada snapshot adik yang dapat dibaca untuk sesi ini.</p>'}
    <div class="form-section-title">Foto bukti</div>
    <div class="recap-photo-grid">
      <div><span class="form-hint">Absen masuk</span><div id="recap-photo-in" class="form-hint">Memuat foto...</div></div>
      <div><span class="form-hint">Absen keluar</span><div id="recap-photo-out" class="form-hint">${isCancel ? "Tidak ada (cancel class)." : "Memuat foto..."}</div></div>
    </div>`;
}

// Foto ada di bucket privat, jadi dibuka lewat signed URL berumur 5 menit.
export async function showAttendancePhoto(supabase, path, targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!path) { if (target.textContent === "Memuat foto...") target.innerHTML = '<span class="muted">Tidak ada foto.</span>'; return; }
  // Data impor GForm menyimpan link Google Drive, bukan file di Storage.
  if (/^https?:\/\//i.test(path)) {
    target.innerHTML = `<a href="${escapeHtml(path)}" target="_blank" rel="noopener">Buka foto (Google Drive)</a>`;
    return;
  }
  const { data, error } = await supabase.storage.from("attendance-photos").createSignedUrl(path, 300);
  if (error || !data?.signedUrl) {
    console.error(error);
    // Foto lama yang sudah di-backup lalu dihapus manual juga masuk ke sini.
    target.innerHTML = '<span class="muted">Foto tidak tersedia (sudah diarsipkan atau tidak ada izin).</span>';
    return;
  }
  target.innerHTML = `<a href="${escapeHtml(data.signedUrl)}" target="_blank" rel="noopener"><img class="recap-photo" src="${escapeHtml(data.signedUrl)}" alt="Foto absensi"></a>`;
}

// Kolom yang dibaca dari tabel attendance untuk rekap PSD, PJ, dan riwayat guru.
export const ATTENDANCE_COLUMNS = "id, teacher_id, program_id, teaching_date, class_type, subject, method, note, student_count, clock_in_at, clock_out_at, clock_in_photo_path, clock_out_photo_path, clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng, auto_closed, is_legacy, review_status, review_note, pj_checked_at, psd_checked_at, sent_at, attendance_students(student_id, student_name_snapshot, class_name_snapshot)";
