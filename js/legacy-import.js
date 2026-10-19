// IMPOR ABSEN LAMA DARI GOOGLE FORM (SEMENTARA)
// File ini hanya membaca dan memeriksa file. Penyimpanan dilakukan RPC import_legacy_attendance.
// Setelah semua data lama masuk, file ini dan tombolnya boleh dihapus.

// Header persis seperti GForm lama + kolom PROGRAM yang diisi manual.
export const LEGACY_HEADERS = [
  "Timestamp", "Email Address", "Tanggal Mengajar", "Nama Pengajar", "Mapel Yang DIajarkan",
  "Nama-Nama Murid Yang Diajarkan", "Belajar Via", "Bukti Foto Clock In", "Bukti Foto Clock Out",
  "Kendala selama di kelas (Opsional)", "Evaluasi (Opsional", "Masukan/Saran (Opsional)",
  "Checked By PJ", "Checked By PSD", "PROGRAM"
];

// Huruf kecil, tanpa spasi/tanda baca: "Checked By PJ" -> "checkedbypj"
const key = (text) => String(text || "").replace(/^﻿/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const norm = (text) => String(text || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("id");

// Membaca CSV (koma) atau hasil salin dari Google Sheets (tab).
export function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((v) => v.trim())) rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); if (row.some((v) => v.trim())) rows.push(row); }
  return rows;
}

// Tanggal GForm berformat bulan/hari/tahun, contoh "8/18/2026 17:39:35". Juga menerima "2026-08-18".
function parseDateTime(text) {
  const value = String(text || "").trim();
  let m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  let year, month, day, hour = 0, minute = 0, second = 0;
  if (m) { [, month, day, year] = m.map(Number); if (m[4]) { hour = +m[4]; minute = +m[5]; second = +(m[6] || 0); } }
  else {
    m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    [, year, month, day] = m.map(Number); if (m[4]) { hour = +m[4]; minute = +m[5]; second = +(m[6] || 0); }
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month)}-${pad(day)}`;
  // Waktu di GForm adalah waktu WIB.
  return { date, iso: `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+07:00` };
}

const isTrue = (text) => ["true", "ya", "yes", "1", "✓", "v", "x"].includes(norm(text));

function methodOf(text) {
  const v = norm(text);
  if (v.includes("cancel") || v.includes("batal")) return "cancel";
  if (v.includes("online") || v.includes("daring")) return "online";
  if (v.includes("offline") || v.includes("luring") || v.includes("tatap muka")) return "offline";
  return null;
}

// Cocokkan satu nama adik dengan data siswa di program yang sama.
// 1) nama lengkap sama persis, 2) jika tidak ada: satu-satunya adik yang namanya diawali kata tersebut.
function matchStudent(name, programStudents) {
  const target = norm(name);
  const exact = programStudents.filter((s) => norm(s.full_name) === target);
  if (exact.length === 1) return { student: exact[0] };
  if (exact.length > 1) return { error: `"${name}" ada ${exact.length} adik dengan nama sama` };
  const prefix = programStudents.filter((s) => norm(s.full_name).startsWith(target + " "));
  if (prefix.length === 1) return { student: prefix[0] };
  if (prefix.length > 1) return { error: `"${name}" cocok dengan beberapa adik (${prefix.map((s) => s.full_name).join(", ")}); tulis nama lengkapnya` };
  return { error: `"${name}" tidak ditemukan di data siswa program ini` };
}

// Hasil: { valid: [baris siap kirim ke RPC], errors: [{ line, message }], preview: [ringkasan valid] }
export function prepareLegacyRows(text, { teachers, programs, students }) {
  const rows = parseDelimited(text);
  if (rows.length < 2) throw new Error("File tidak berisi data.");
  const headers = rows[0].map(key);
  const col = (...names) => headers.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const idx = {
    timestamp: col("timestamp"), email: col("emailaddress", "email"), date: col("tanggalmengajar"),
    teacher: col("namapengajar"), subject: col("mapel"), students: col("namanamamurid", "namamurid"),
    via: col("belajarvia"), photoIn: col("buktifotoclockin"), photoOut: col("buktifotoclockout"),
    kendala: col("kendala"), evaluasi: col("evaluasi"), saran: col("masukan", "saran"),
    pj: col("checkedbypj"), psd: col("checkedbypsd"), program: headers.findIndex((h) => h === "program")
  };
  const missing = [["Timestamp", idx.timestamp], ["Nama-Nama Murid", idx.students], ["Belajar Via", idx.via], ["PROGRAM", idx.program]]
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (idx.email < 0 && idx.teacher < 0) missing.push("Email Address / Nama Pengajar");
  if (missing.length) throw new Error(`Kolom wajib tidak ditemukan: ${missing.join(", ")}. Gunakan tombol "Format absen lama".`);

  const valid = []; const errors = []; const preview = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2; // nomor baris di spreadsheet (baris 1 = header)
    const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] || "").trim() : "");
    const problems = [];

    const stamp = parseDateTime(get("timestamp"));
    if (!stamp) problems.push(`Timestamp "${get("timestamp")}" tidak terbaca (format bulan/hari/tahun jam:menit:detik)`);
    let teachingDate = stamp?.date;
    if (get("date")) {
      const d = parseDateTime(get("date"));
      if (d) teachingDate = d.date; else problems.push(`Tanggal Mengajar "${get("date")}" tidak terbaca`);
    }

    const email = norm(get("email"));
    const teacher = teachers.find((t) => email && norm(t.login_email) === email)
      || teachers.find((t) => get("teacher") && norm(t.full_name) === norm(get("teacher")));
    if (!teacher) problems.push(`pengajar "${get("teacher") || get("email")}" tidak ditemukan di Data Pengajar`);

    const programText = key(get("program")).replace(/^program/, "");
    const program = programs.find((p) => key(p.code) === programText || key(p.name) === programText);
    if (!program) problems.push(`PROGRAM "${get("program")}" harus Privat, Reguler, atau UTBK`);

    const method = methodOf(get("via"));
    if (!method) problems.push(`Belajar Via "${get("via")}" harus Offline, Online, atau Cancel`);

    const studentIds = [];
    if (program) {
      const programStudents = students.filter((s) => s.program_id === program.id);
      const names = get("students").split(/[,;\n/&]+|\s+dan\s+/i).map((s) => s.trim()).filter(Boolean);
      if (!names.length) problems.push("nama murid kosong");
      names.forEach((name) => {
        const found = matchStudent(name, programStudents);
        if (found.error) problems.push(found.error);
        else if (!studentIds.includes(found.student.id)) studentIds.push(found.student.id);
      });
    }

    if (problems.length) { errors.push({ line, message: problems.join("; ") }); return; }

    const notes = [["Kendala", get("kendala")], ["Evaluasi", get("evaluasi")], ["Saran", get("saran")]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    const pj = isTrue(get("pj")); const psd = isTrue(get("psd"));
    // PSD boleh menyetujui tanpa PJ, jadi PSD TRUE = Disetujui.
    const status = psd ? "approved" : pj ? "pj_approved" : "pending";

    valid.push({
      teacher_id: teacher.id, program_id: program.id, teaching_date: teachingDate, submitted_at: stamp.iso,
      subject: get("subject"), method, student_ids: studentIds, note: ["[Data GForm]", notes.join(" | ")].filter(Boolean).join(" "),
      photo_in: get("photoIn"), photo_out: get("photoOut"), status
    });
    preview.push({ line, date: teachingDate, teacher: teacher.full_name, program: program.name, subject: get("subject"), count: studentIds.length, status });
  });
  return { valid, errors, preview };
}
