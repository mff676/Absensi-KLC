import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import {
  SUBJECTS_BY_PROGRAM, METHOD_LABELS, STATUS_LABELS, ATTENDANCE_COLUMNS, statusKey, statusBadge, formatDate, formatTime,
  formatDateTime, mapsUrl, fixDeadline, getLocation, stampPhoto, watermarkLines, downloadCsv, attendanceDetailHtml, showAttendancePhoto
} from "./attendance-utils.js";
import { LEGACY_HEADERS, prepareLegacyRows } from "./legacy-import.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = (selector) => document.querySelector(selector);
const views = {
  loading: $("#loading-view"),
  login: $("#login-view"),
  denied: $("#access-denied-view"),
  app: $("#app-view"),
  teacher: $("#teacher-attendance-view")
};

let currentUser = null;
let teacherRows = [];
let programRows = [];
let assignmentRows = [];
let studentRows = [];
let attendanceStudentRows = [];
let isPsd = false;
let isTeacher = false;
let teacherRecord = null;
let assignedPrograms = [];
let openAttendance = null;
let recapRows = [];
let recapLoaded = false;

const fields = {
  id: $("#teacher-id"),
  name: $("#full-name"),
  email: $("#login-email"),
  bankName: $("#bank-name"),
  bankNumber: $("#bank-account-number"),
  walletName: $("#ewallet-name"),
  walletNumber: $("#ewallet-number"),
  active: $("#is-active")
};

function showView(viewName) {
  Object.values(views).forEach((view) => view.classList.add("hidden"));
  views[viewName].classList.remove("hidden");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function clean(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function hasCompletePaymentData(teacher) {
  // Ditandai lengkap jika tersedia sekurangnya satu jalur pembayaran yang utuh.
  const bankComplete = Boolean(teacher.bank_name && teacher.bank_account_number);
  const walletComplete = Boolean(teacher.ewallet_name && teacher.ewallet_number);
  return bankComplete || walletComplete;
}

function completenessLabel(teacher) {
  return hasCompletePaymentData(teacher)
    ? '<span class="badge badge-complete">Data pembayaran tersedia</span>'
    : '<span class="badge badge-incomplete">Perlu dilengkapi</span>';
}

function bankText(teacher) {
  if (!teacher.bank_name && !teacher.bank_account_number) return '<span class="muted">Belum diisi</span>';
  return `<div>${escapeHtml(teacher.bank_name || "Nama bank belum diisi")}</div>
    <span class="cell-subtext">${escapeHtml(teacher.bank_account_number || "Nomor rekening belum diisi")}</span>`;
}

function walletText(teacher) {
  if (!teacher.ewallet_name && !teacher.ewallet_number) return '<span class="muted">Belum diisi</span>';
  return `<div>${escapeHtml(teacher.ewallet_name || "Nama e-wallet belum diisi")}</div>
    <span class="cell-subtext">${escapeHtml(teacher.ewallet_number || "Nomor belum diisi")}</span>`;
}

function filteredTeachers() {
  const query = $("#search-input").value.trim().toLocaleLowerCase("id");
  const completeness = $("#completeness-filter").value;
  const active = $("#active-filter").value;
  return teacherRows.filter((teacher) => {
    const matchesName = `${teacher.full_name || ""} ${teacher.login_email || ""}`.toLocaleLowerCase("id").includes(query);
    const complete = hasCompletePaymentData(teacher);
    const matchesCompleteness = completeness === "all" ||
      (completeness === "complete" && complete) ||
      (completeness === "incomplete" && !complete);
    const matchesActive = active === "all" ||
      (active === "active" && teacher.is_active) ||
      (active === "inactive" && !teacher.is_active);
    return matchesName && matchesCompleteness && matchesActive;
  });
}

function renderProgramTags(teacherId) {
  const assignedIds = new Set(assignmentRows.filter((a) => a.teacher_id === teacherId && a.is_active).map((a) => a.program_id));
  const names = programRows.filter((p) => assignedIds.has(p.id)).map((p) => p.name);
  return names.length
    ? `<div class="program-tags">${names.map((name) => `<span class="program-tag">${escapeHtml(name)}</span>`).join("")}</div>`
    : '<span class="muted">Belum ditugaskan</span>';
}

function renderOverview() {
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = String(value); };
  set("overview-teacher-count", teacherRows.length);
  set("overview-active-teacher-count", teacherRows.filter((teacher) => teacher.is_active).length);
  set("overview-incomplete-count", teacherRows.filter((teacher) => !hasCompletePaymentData(teacher)).length);
  set("overview-student-count", studentRows.length);
  set("overview-active-student-count", studentRows.filter((student) => student.is_active).length);
  set("overview-program-count", programRows.length);
}

function switchPsdSection(sectionName) {
  const sections = { overview: "psd-overview-section", teachers: "psd-teachers-section", students: "psd-students-section", attendance: "psd-attendance-section", managers: "psd-managers-section" };
  Object.entries(sections).forEach(([key, id]) => document.getElementById(id)?.classList.toggle("hidden", key !== sectionName));
  document.querySelectorAll("[data-psd-section]").forEach((button) => {
    const active = button.dataset.psdSection === sectionName;
    if (button.classList.contains("sidebar-link")) button.classList.toggle("active", active);
    if (button.classList.contains("shortcut-card")) button.setAttribute("aria-current", active ? "page" : "false");
  });
  // Rekap baru dimuat saat menu pertama kali dibuka, agar dashboard awal tetap ringan.
  if (sectionName === "attendance" && !recapLoaded) loadAttendanceRecap();
  if (sectionName === "managers") loadProgramManagers();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ===== Rekap Absensi (PSD) ===== */

// Mengubah objek Date menjadi "YYYY-MM-DD" memakai tanggal lokal perangkat (bukan UTC).
function toLocalDateString(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function recapTeacher(row) {
  return teacherRows.find((t) => t.id === row.teacher_id) || null;
}

function recapTeacherName(row) {
  return recapTeacher(row)?.full_name || "Pengajar tidak ditemukan";
}

function recapProgramName(row) {
  // programRows hanya berisi program aktif; class_type dipakai sebagai cadangan.
  return programRows.find((p) => p.id === row.program_id)?.name || row.class_type || "-";
}

function recapStudentCount(row) {
  return row.student_count ?? row.attendance_students?.length ?? 0;
}

function setDefaultRecapDates() {
  // Bawaan: dari tanggal 1 bulan berjalan sampai hari ini.
  const today = new Date();
  if (!$("#recap-date-from").value) $("#recap-date-from").value = toLocalDateString(new Date(today.getFullYear(), today.getMonth(), 1));
  if (!$("#recap-date-to").value) $("#recap-date-to").value = toLocalDateString(today);
}

function fillRecapProgramFilter() {
  const select = $("#recap-program-filter");
  const current = select.value || "all";
  select.innerHTML = '<option value="all">Semua program</option>' + programRows
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  select.value = programRows.some((p) => p.id === current) ? current : "all";
}

async function loadAttendanceRecap() {
  if (!isPsd) return;
  setDefaultRecapDates();
  fillRecapProgramFilter();
  const dateFrom = $("#recap-date-from").value;
  const dateTo = $("#recap-date-to").value;
  const body = $("#recap-table-body");
  if (dateFrom && dateTo && dateFrom > dateTo) {
    recapRows = [];
    renderAttendanceRecap();
    body.innerHTML = '<tr><td colspan="9" class="empty-cell">Tanggal awal tidak boleh setelah tanggal akhir.</td></tr>';
    return;
  }
  body.innerHTML = '<tr><td colspan="9" class="empty-cell">Memuat rekap absensi...</td></tr>';
  $("#recap-result-count").textContent = "Memuat data...";
  $("#reload-recap-btn").disabled = true;
  try {
    // RLS tetap berlaku: PSD membaca lewat can_read_attendance_row() dan is_current_user_psd().
    let query = supabase
      .from("attendance")
      .select(ATTENDANCE_COLUMNS)
      .order("teaching_date", { ascending: false })
      .order("clock_in_at", { ascending: false });
    if (dateFrom) query = query.gte("teaching_date", dateFrom);
    if (dateTo) query = query.lte("teaching_date", dateTo);
    const { data, error } = await query;
    if (error) throw error;
    recapRows = data || [];
    recapLoaded = true;
    renderAttendanceRecap();
  } catch (error) {
    recapRows = [];
    renderAttendanceRecap();
    body.innerHTML = `<tr><td colspan="9" class="empty-cell">Gagal memuat rekap: ${escapeHtml(errorMessage(error))}</td></tr>`;
    $("#recap-result-count").textContent = "Gagal memuat data.";
  } finally {
    $("#reload-recap-btn").disabled = false;
  }
}

// Filter program, status, dan nama pengajar dilakukan di browser dari data yang sudah dimuat.
function filteredRecapRows() {
  const programId = $("#recap-program-filter").value;
  const status = $("#recap-status-filter").value;
  const teacherQuery = $("#recap-teacher-search").value.trim().toLocaleLowerCase("id");
  return recapRows.filter((row) => {
    const matchesProgram = programId === "all" || row.program_id === programId;
    const matchesStatus = status === "all" || statusKey(row) === status;
    const matchesTeacher = recapTeacherName(row).toLocaleLowerCase("id").includes(teacherQuery);
    return matchesProgram && matchesStatus && matchesTeacher;
  });
}

function renderAttendanceRecap() {
  const rows = filteredRecapRows();
  const openCount = rows.filter((row) => !row.clock_out_at).length;
  $("#recap-total-count").textContent = String(rows.length);
  $("#recap-open-count").textContent = String(openCount);
  $("#recap-done-count").textContent = String(rows.length - openCount);
  $("#recap-result-count").textContent = `${rows.length} dari ${recapRows.length} sesi pada rentang tanggal ini`;
  $("#recap-table-body").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${escapeHtml(formatDate(row.teaching_date))}</td>
      <td><span class="teacher-name">${escapeHtml(recapTeacherName(row))}</span></td>
      <td>${escapeHtml(recapProgramName(row))}<span class="cell-subtext">${escapeHtml(row.subject || "-")}</span></td>
      <td>${escapeHtml(METHOD_LABELS[row.method] || "-")}</td>
      <td>${escapeHtml(formatTime(row.clock_in_at))}</td>
      <td>${row.method === "cancel" ? '<span class="muted">-</span>'
      : row.clock_out_at ? `${escapeHtml(formatTime(row.clock_out_at))}${row.auto_closed ? '<span class="cell-subtext">otomatis</span>' : ""}`
        : '<span class="muted">Belum clock-out</span>'}</td>
      <td>${escapeHtml(recapStudentCount(row))} adik</td>
      <td>${statusBadge(row)}</td>
      <td><button class="row-action" type="button" data-attendance-id="${escapeHtml(row.id)}">Detail</button></td>
    </tr>`).join("")
    : '<tr><td colspan="9" class="empty-cell">Tidak ada sesi absensi untuk filter ini.</td></tr>';
}

let detailAttendanceId = null;

function openAttendanceDetail(attendanceId) {
  const row = recapRows.find((item) => item.id === attendanceId);
  if (!row) return;
  detailAttendanceId = row.id;
  $("#attendance-detail-title").textContent = `${recapTeacherName(row)} · ${formatDate(row.teaching_date)}`;
  $("#attendance-detail-content").innerHTML = attendanceDetailHtml(row, { program: recapProgramName(row) });
  // PSD bisa memutuskan selama sesi sudah selesai dan belum terkirim.
  const canReview = Boolean(row.clock_out_at) && row.review_status !== "sent";
  $("#review-box").classList.toggle("hidden", !canReview);
  $("#review-note").value = "";
  $("#review-message").textContent = "";
  $("#attendance-detail-dialog").showModal();
  showAttendancePhoto(supabase, row.clock_in_photo_path, "recap-photo-in");
  if (row.method !== "cancel") showAttendancePhoto(supabase, row.clock_out_photo_path, "recap-photo-out");
}

async function submitReview(decision) {
  const note = $("#review-note").value.trim();
  if (decision === "reject" && !note) {
    $("#review-message").textContent = "Tulis alasan penolakan agar guru tahu apa yang harus diperbaiki.";
    return;
  }
  const buttons = [$("#review-approve-btn"), $("#review-reject-btn")];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const { error } = await supabase.rpc("review_attendance", {
      p_attendance_id: detailAttendanceId,
      p_decision: decision,
      p_note: note || null
    });
    if (error) throw error;
    $("#attendance-detail-dialog").close();
    showNotice(decision === "approve" ? "Sesi disetujui." : "Sesi ditolak. Guru bisa memperbaikinya dari riwayat.");
    await loadAttendanceRecap();
  } catch (error) {
    $("#review-message").textContent = errorMessage(error);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

// Nama PJ/PSD yang mengecek tidak bisa dibaca (tabel profiles hanya milik sendiri),
// jadi ekspor cukup mencantumkan waktunya.
function exportRows(rows) {
  const header = ["Tanggal", "Jam masuk", "Jam keluar", "Ditutup otomatis", "Nama pengajar", "Email", "Bank", "Nomor rekening",
    "E-wallet", "Nomor e-wallet", "Program", "Mapel", "Metode", "Jumlah adik", "Nama adik", "Status",
    "Dicek PJ", "Dicek PSD", "Terkirim", "Catatan guru", "Lokasi masuk", "Lokasi keluar"];
  const when = (value) => (value ? formatDateTime(value) : "");  // kosong, bukan "-", agar rapi di Excel
  const body = rows.map((row) => {
    const teacher = recapTeacher(row) || {};
    const students = (row.attendance_students || []).map((s) => `${s.student_name_snapshot} (${s.class_name_snapshot})`).join("; ");
    return [
      row.teaching_date, formatTime(row.clock_in_at), row.method === "cancel" || !row.clock_out_at ? "" : formatTime(row.clock_out_at),
      row.auto_closed ? "Ya" : "Tidak", teacher.full_name || "", teacher.login_email || "", teacher.bank_name || "",
      teacher.bank_account_number || "", teacher.ewallet_name || "", teacher.ewallet_number || "",
      recapProgramName(row), row.subject || "", METHOD_LABELS[row.method] || "", recapStudentCount(row), students,
      STATUS_LABELS[statusKey(row)], when(row.pj_checked_at), when(row.psd_checked_at), when(row.sent_at), row.note || "", mapsUrl(row.clock_in_lat, row.clock_in_lng) || "",
      mapsUrl(row.clock_out_lat, row.clock_out_lng) || ""
    ];
  });
  return [header, ...body];
}

// Id sesi yang terakhir diekspor sebagai "siap kirim"; hanya sesi ini yang ditandai terkirim.
let lastReadyExportIds = [];

async function exportReadyToSend() {
  if (!isPsd) return;
  const button = $("#export-ready-btn");
  button.disabled = true;
  try {
    // Semua sesi Disetujui dari bulan mana pun, agar sesi susulan tidak terlewat.
    const { data, error } = await supabase
      .from("attendance")
      .select(ATTENDANCE_COLUMNS)
      .eq("review_status", "approved")
      .order("teaching_date", { ascending: true })
      .order("clock_in_at", { ascending: true });
    if (error) throw error;
    if (!data?.length) {
      showNotice("Belum ada sesi berstatus Disetujui yang perlu dikirim.", "error");
      return;
    }
    downloadCsv(`rekap-bendahara-klc-${toLocalDateString(new Date())}.csv`, exportRows(data));
    lastReadyExportIds = data.map((row) => row.id);
    $("#mark-sent-btn").classList.remove("hidden");
    $("#mark-sent-btn").textContent = `✓ Tandai ${data.length} sesi sudah dikirim`;
    showNotice(`File berisi ${data.length} sesi siap kirim. Periksa filenya, lalu tekan "Tandai sudah dikirim".`);
  } catch (error) {
    showNotice(errorMessage(error), "error");
  } finally {
    button.disabled = false;
  }
}

async function markExportedAsSent() {
  if (!lastReadyExportIds.length) return;
  const ok = window.confirm(`Tandai ${lastReadyExportIds.length} sesi sebagai sudah dikirim ke bendahara? Sesi yang terkirim tidak bisa diubah lagi.`);
  if (!ok) return;
  const button = $("#mark-sent-btn");
  button.disabled = true;
  try {
    const { data, error } = await supabase.rpc("mark_attendance_sent", { p_attendance_ids: lastReadyExportIds });
    if (error) throw error;
    lastReadyExportIds = [];
    button.classList.add("hidden");
    showNotice(`${data} sesi ditandai terkirim.`);
    await loadAttendanceRecap();
  } catch (error) {
    showNotice(errorMessage(error), "error");
  } finally {
    button.disabled = false;
  }
}

function exportCurrentView() {
  const rows = filteredRecapRows();
  if (!rows.length) { showNotice("Tidak ada sesi pada tabel untuk diekspor.", "error"); return; }
  downloadCsv(`rekap-absensi-klc-${toLocalDateString(new Date())}.csv`, exportRows(rows));
}

function renderTeachers() {
  const rows = filteredTeachers();
  $("#total-count").textContent = String(teacherRows.length);
  $("#complete-count").textContent = String(teacherRows.filter(hasCompletePaymentData).length);
  $("#incomplete-count").textContent = String(teacherRows.filter((t) => !hasCompletePaymentData(t)).length);
  $("#result-count").textContent = `${rows.length} dari ${teacherRows.length} pengajar`;
  $("#empty-state").classList.toggle("hidden", rows.length > 0);
  $("#teacher-table-body").innerHTML = rows.length ? rows.map((teacher) => `
    <tr>
      <td><span class="teacher-name">${escapeHtml(teacher.full_name)}</span></td>
      <td>${teacher.login_email ? escapeHtml(teacher.login_email) : '<span class="muted">Belum diisi</span>'}</td>
      <td>${renderProgramTags(teacher.id)}</td>
      <td class="account-cell">${bankText(teacher)}</td>
      <td class="account-cell">${walletText(teacher)}</td>
      <td>${completenessLabel(teacher)}</td>
      <td>${teacher.is_active
      ? '<span class="badge badge-active">Aktif</span>'
      : '<span class="badge badge-inactive">Nonaktif</span>'}</td>
      <td><button class="row-action" type="button" data-edit-id="${escapeHtml(teacher.id)}">Edit</button></td>
    </tr>`).join("") : "";
  if (!rows.length) {
    $("#teacher-table-body").innerHTML = '<tr><td colspan="8" class="empty-cell">Tidak ada data untuk ditampilkan.</td></tr>';
  }
}

function showNotice(message, type = "success") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = `notice notice-${type}`;
  notice.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function errorMessage(error) {
  console.error(error);
  if (error?.code === "42501" || /row-level security|permission denied/i.test(error?.message || "")) {
    return "Akses ditolak oleh kebijakan keamanan Supabase. Pastikan akun ini memiliki peran PSD dan RLS sudah disiapkan.";
  }
  return error?.message || "Terjadi kesalahan. Silakan coba lagi.";
}

async function checkAccess() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  currentUser = session?.user ?? null;
  updateTopbarAuth(!!currentUser);
  if (!currentUser) {
    $("#user-email").textContent = "";
    $("#sign-out-btn").classList.add("hidden");
    showView("login");
    return;
  }

  
  // Profil harus dibuat/disetujui oleh admin; role tidak boleh ditentukan dari frontend.
  let { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, is_active, email, full_name")
    .eq("id", currentUser.id)
    .maybeSingle();
  if (profileError) throw profileError;

  // Pengajar yang belum ditautkan dapat menautkan akun melalui email login yang cocok.
  if (!profile || profile.role === "teacher") {
    const { error: linkError } = await supabase.rpc("link_my_teacher_account");
    if (linkError && !profile) {
      console.warn("Akun belum berhasil ditautkan ke data pengajar:", linkError.message);
    }
    const refreshed = await supabase
      .from("profiles")
      .select("id, role, is_active, email")
      .eq("id", currentUser.id)
      .maybeSingle();
    if (refreshed.error) throw refreshed.error;
    profile = refreshed.data;
  }
  $("#user-email").textContent = profile?.full_name || currentUser.email || ""; $("#sign-out-btn").classList.remove("hidden");
  
  isPsd = profile?.role === "psd" && profile?.is_active === true;
  isTeacher = profile?.role === "teacher" && profile?.is_active === true;

  if (!profile || profile.is_active !== true || !["psd", "teacher"].includes(profile.role)) {
    showView("denied");
    return;
  }

  if (isTeacher) {
    showView("teacher");
    await loadTeacherAttendance();
    return;
  }

  if (!isPsd) {
    showView("denied");
    return;
  }

  $("#export-btn").disabled = false;
  $("#add-teacher-btn").disabled = false;
  showView("app");
  await loadTeachers();
}

async function loadTeachers() {
  $("#teacher-table-body").innerHTML = '<tr><td colspan="8" class="empty-cell">Memuat data...</td></tr>';
  const { data, error } = await supabase
    .from("teachers")
    .select("id, profile_id, full_name, login_email, bank_name, bank_account_number, ewallet_name, ewallet_number, is_active, created_at, updated_at")
    .order("full_name", { ascending: true });

  if (error) throw error;
  teacherRows = data || [];
  const programsResult = await supabase.from("programs").select("id, code, name, is_active").eq("is_active", true).order("name");
  if (programsResult.error) throw programsResult.error;
  programRows = programsResult.data || [];
  const assignmentsResult = await supabase.from("teacher_program_assignments").select("id, teacher_id, program_id, is_active");
  if (assignmentsResult.error) throw assignmentsResult.error;
  assignmentRows = assignmentsResult.data || [];
  const studentsResult = await supabase.from("students").select("id, class_name, full_name, program_id, is_active, created_at").order("class_name").order("full_name");
  if (studentsResult.error) throw studentsResult.error;
  studentRows = studentsResult.data || [];
  renderTeachers();
  renderStudentRoster();
  renderOverview();
  // Nama pengajar & program di rekap diambil dari data di atas, jadi render ulang jika rekap sudah terbuka.
  if (recapLoaded) { fillRecapProgramFilter(); renderAttendanceRecap(); }
}

function renderProgramAssignmentOptions(teacherId) {
  const assigned = new Set(assignmentRows.filter((a) => a.teacher_id === teacherId && a.is_active).map((a) => a.program_id));
  const container = $("#program-assignment-list");
  if (!programRows.length) {
    container.innerHTML = '<p class="form-hint">Belum ada program aktif. Periksa tabel programs di Supabase.</p>';
    return;
  }
  container.innerHTML = programRows.map((program) => `
    <label class="program-assignment-option">
      <input type="checkbox" name="assigned-program" value="${escapeHtml(program.id)}" ${assigned.has(program.id) ? "checked" : ""}>
      <span>${escapeHtml(program.name)}</span>
    </label>`).join("");
}

function openTeacherDialog(teacher = null) {
  $("#teacher-form").reset();
  $("#form-message").textContent = "";
  fields.id.value = teacher?.id || "";
  fields.name.value = teacher?.full_name || "";
  fields.email.value = teacher?.login_email || "";
  fields.bankName.value = teacher?.bank_name || "";
  fields.bankNumber.value = teacher?.bank_account_number || "";
  fields.walletName.value = teacher?.ewallet_name || "";
  fields.walletNumber.value = teacher?.ewallet_number || "";
  fields.active.checked = teacher ? Boolean(teacher.is_active) : true;
  renderProgramAssignmentOptions(teacher?.id || "");
  $("#dialog-title").textContent = teacher ? "Edit data pengajar" : "Tambah pengajar";
  $("#save-btn").textContent = teacher ? "Simpan perubahan" : "Simpan data";
  $("#teacher-dialog").showModal();
  fields.name.focus();
}

function showTeacherNotice(message, type = "success") {
  const notice = $("#teacher-notice");
  notice.textContent = message;
  notice.className = `notice notice-${type}`;
  notice.classList.remove("hidden");
}

function selectedProgram() {
  return assignedPrograms.find((program) => program.id === $("#attendance-program").value) || null;
}

async function updateAttendanceForm() {
  const program = selectedProgram();
  const wrap = $("#student-select-wrap");
  const select = $("#attendance-students");
  fillSubjectSelect($("#attendance-subject"), program?.code);
  wrap.classList.toggle("hidden", !program);
  select.required = Boolean(program);
  select.innerHTML = '<option value="">Pilih program terlebih dahulu...</option>';
  attendanceStudentRows = [];
  $("#student-selection-count").textContent = "0 dari maksimal 6 adik dipilih.";
  if (!program) return;
  select.innerHTML = '<option disabled>Memuat daftar adik...</option>';
  try {
    const { data, error } = await supabase.from("students")
      .select("id, class_name, full_name, program_id")
      .eq("program_id", program.id).eq("is_active", true)
      .order("class_name").order("full_name");
    if (error) throw error;
    attendanceStudentRows = data || [];
    select.innerHTML = attendanceStudentRows.length
      ? attendanceStudentRows.map((student) => `<option value="${escapeHtml(student.id)}">${escapeHtml(student.class_name)} · ${escapeHtml(student.full_name)}</option>`).join("")
      : '<option disabled>Tidak ada adik aktif untuk program ini</option>';
    $("#attendance-form-message").textContent = attendanceStudentRows.length ? "" : "Belum ada data adik untuk program ini. Hubungi PSDM untuk mengimpor daftar adik.";
  } catch (error) {
    select.innerHTML = '<option disabled>Gagal memuat daftar adik</option>';
    $("#attendance-form-message").textContent = errorMessage(error);
  }
}

function updateSelectedStudentCount() {
  const selected = Array.from($("#attendance-students").selectedOptions).filter((option) => option.value);
  $("#student-selection-count").textContent = `${selected.length} dari maksimal 6 adik dipilih.`;
  for (const option of $("#attendance-students").options) {
    if (!option.selected && option.value) option.disabled = selected.length >= 6;
    else if (option.value) option.disabled = false;
  }
}

async function loadTeacherAttendance() {
  $("#attendance-loading").classList.remove("hidden");
  $("#attendance-content").classList.add("hidden");
  const { data: contextRows, error: contextError } = await supabase.rpc("get_my_teacher_attendance_context");
  if (contextError) throw contextError;
  if (!contextRows?.length) throw new Error("Data pengajar belum terhubung atau tidak aktif. Hubungi PSD.");
  const firstContext = contextRows[0];
  teacherRecord = { id: firstContext.teacher_id, full_name: firstContext.teacher_name };
  assignedPrograms = contextRows
    .filter((row) => row.program_id && row.program_code && row.program_name)
    .map((row) => ({ id: row.program_id, code: row.program_code, name: row.program_name }));

  const select = $("#attendance-program");
  select.innerHTML = '<option value="">Pilih program...</option>' + assignedPrograms.map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
  ).join("");
  $("#clock-in-btn").disabled = assignedPrograms.length === 0;
  if (!assignedPrograms.length) {
    $("#attendance-form-message").textContent = "Belum ada program aktif yang ditugaskan kepadamu. Hubungi PJ atau PSD.";
  } else {
    $("#attendance-form-message").textContent = "";
  }

  const { data: session, error: sessionError } = await supabase
    .from("attendance")
    .select("id, program_id, class_type, subject, method, student_count, teaching_date, clock_in_at")
    .eq("teacher_id", teacherRecord.id)
    .not("clock_in_at", "is", null)
    .is("clock_out_at", null)
    .order("clock_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sessionError) throw sessionError;
  openAttendance = session || null;
  const openCard = $("#open-session-card");
  openCard.classList.toggle("hidden", !openAttendance);
  $("#clock-in-form").classList.toggle("hidden", Boolean(openAttendance));
  if (openAttendance) {
    const programName = assignedPrograms.find((p) => p.id === openAttendance.program_id)?.name || openAttendance.class_type;
    $("#open-session-title").textContent = `Sesi ${programName}${openAttendance.subject ? " · " + openAttendance.subject : ""} belum ditutup`;
    $("#open-session-detail").textContent = `Tanggal ${openAttendance.teaching_date}, absen masuk ${new Date(openAttendance.clock_in_at).toLocaleString("id-ID")}`;
  }
  $("#attendance-loading").classList.add("hidden");
  $("#attendance-content").classList.remove("hidden");
  updateAttendanceForm();
  await loadTeacherHistory();
}

async function uploadAttendancePhoto(file, kind) {
  if (!file) throw new Error("Foto wajib diambil sebelum melanjutkan.");
  const allowedTypes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = allowedTypes[file.type];
  if (!extension) throw new Error("Gunakan foto berformat JPG, PNG, atau WebP.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Ukuran foto maksimal 10 MB.");
  const folderId = crypto.randomUUID();
  const path = `${currentUser.id}/${folderId}/${kind}.${extension}`;
  const { error } = await supabase.storage.from("attendance-photos").upload(path, file, {
    contentType: file.type,
    upsert: false
  });
  if (error) throw error;
  return path;
}

function fillSubjectSelect(select, programCode, selected = "") {
  const subjects = SUBJECTS_BY_PROGRAM[programCode] || [];
  select.innerHTML = subjects.length
    ? '<option value="">Pilih mapel...</option>' + subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")
    : '<option value="">Pilih program terlebih dahulu...</option>';
  select.value = subjects.includes(selected) ? selected : "";
}

function updateMethodHint() {
  const isCancel = $("#attendance-method").value === "cancel";
  $("#attendance-note-required").classList.toggle("hidden", !isCancel);
  $("#clock-in-btn").textContent = isCancel ? "Absen cancel class" : "Absen masuk";
}

// Ambil lokasi, lalu tempel watermark ke foto. Urutan ini penting:
// jika lokasi ditolak, absen berhenti sebelum foto diunggah.
async function takeStampedPhoto(file, kind, program, subject, method) {
  if (!file) throw new Error("Foto wajib diambil sebelum melanjutkan.");
  const location = await getLocation();
  const lines = watermarkLines({
    kind,
    teacherName: teacherRecord.full_name,
    programName: program?.name,
    subject,
    method,
    location
  });
  const photo = await stampPhoto(file, lines);
  return { photo, location };
}

async function submitClockIn(event) {
  event.preventDefault();
  if (!isTeacher || !teacherRecord) return;
  const message = $("#attendance-form-message");
  const program = selectedProgram();
  const subject = $("#attendance-subject").value;
  const method = $("#attendance-method").value;
  const note = $("#attendance-note").value.trim();
  const photoFile = $("#clock-in-photo").files?.[0];
  const studentIds = Array.from($("#attendance-students").selectedOptions).map((option) => option.value).filter(Boolean);

  if (!program) { message.textContent = "Pilih program terlebih dahulu."; return; }
  if (!subject) { message.textContent = "Pilih mapel yang diajarkan."; return; }
  if (studentIds.length < 1 || studentIds.length > 6) { message.textContent = "Pilih minimal 1 dan maksimal 6 nama adik."; return; }
  if (method === "cancel" && !note) { message.textContent = "Tulis alasan cancel class di kolom catatan."; return; }
  if (!photoFile) { message.textContent = "Ambil foto terlebih dahulu."; return; }

  const button = $("#clock-in-btn");
  button.disabled = true;
  button.textContent = "Mengambil lokasi...";
  message.textContent = "";
  try {
    const { photo, location } = await takeStampedPhoto(photoFile, method === "cancel" ? "Cancel class" : "Absen masuk", program, subject, method);
    button.textContent = "Mengunggah foto...";
    const photoPath = await uploadAttendancePhoto(photo, "clock-in");
    const { error } = await supabase.rpc("clock_in_v2", {
      p_program_id: program.id,
      p_subject: subject,
      p_method: method,
      p_student_ids: studentIds,
      p_photo_path: photoPath,
      p_lat: location.lat,
      p_lng: location.lng,
      p_note: note || null
    });
    if (error) throw error;
    $("#clock-in-form").reset();
    updateMethodHint();
    showTeacherNotice(method === "cancel" ? "Cancel class berhasil dicatat." : "Absen masuk berhasil dicatat.");
    await loadTeacherAttendance();
  } catch (error) {
    message.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
    updateMethodHint();
  }
}

async function submitClockOut() {
  if (!isTeacher || !openAttendance) return;
  const photoFile = $("#clock-out-photo").files?.[0];
  if (!photoFile) { showTeacherNotice("Ambil foto absen keluar terlebih dahulu.", "error"); return; }
  const button = $("#clock-out-btn");
  button.disabled = true;
  button.textContent = "Mengambil lokasi...";
  try {
    const program = assignedPrograms.find((p) => p.id === openAttendance.program_id);
    const { photo, location } = await takeStampedPhoto(photoFile, "Absen keluar", program, openAttendance.subject, openAttendance.method);
    button.textContent = "Mengunggah foto...";
    const photoPath = await uploadAttendancePhoto(photo, "clock-out");
    const { data: result, error } = await supabase.rpc("clock_out_v2", {
      p_attendance_id: openAttendance.id,
      p_photo_path: photoPath,
      p_lat: location.lat,
      p_lng: location.lng,
      p_note: $("#clock-out-note").value.trim() || null
    });
    if (error) throw error;
    $("#clock-out-photo").value = "";
    $("#clock-out-note").value = "";
    if (result === "auto_closed") {
      showTeacherNotice("Sesi sudah lewat 120 menit sehingga ditutup otomatis. PJ akan memutuskan sesi ini.", "error");
    } else {
      showTeacherNotice("Absen keluar berhasil dicatat.");
    }
    await loadTeacherAttendance();
  } catch (error) {
    showTeacherNotice(errorMessage(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = "Absen keluar";
  }
}

/* ===== Riwayat absen guru ===== */

let historyRows = [];

async function loadTeacherHistory() {
  if (!teacherRecord) return;
  const monthInput = $("#history-month");
  if (!monthInput.value) {
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const [year, month] = monthInput.value.split("-").map(Number);
  const firstDay = `${monthInput.value}-01`;
  const lastDay = `${monthInput.value}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const body = $("#history-table-body");
  body.innerHTML = '<tr><td colspan="8" class="empty-cell">Memuat riwayat...</td></tr>';
  try {
    // Filter teacher_id wajib: guru yang juga PJ bisa membaca absen guru lain di programnya.
    const { data, error } = await supabase
      .from("attendance")
      .select(ATTENDANCE_COLUMNS)
      .eq("teacher_id", teacherRecord.id)
      .gte("teaching_date", firstDay)
      .lte("teaching_date", lastDay)
      .order("teaching_date", { ascending: false })
      .order("clock_in_at", { ascending: false });
    if (error) throw error;
    historyRows = data || [];
    renderTeacherHistory();
    await updateRejectedBanner();
  } catch (error) {
    body.innerHTML = `<tr><td colspan="8" class="empty-cell">Gagal memuat riwayat: ${escapeHtml(errorMessage(error))}</td></tr>`;
  }
}

function canFix(row) {
  return row.review_status === "rejected" && new Date() <= fixDeadline(row.teaching_date);
}

function historyProgramName(row) {
  return assignedPrograms.find((p) => p.id === row.program_id)?.name || row.class_type || "-";
}

function renderTeacherHistory() {
  const done = historyRows.filter((r) => ["approved", "sent"].includes(r.review_status)).length;
  $("#history-total").textContent = String(historyRows.length);
  $("#history-approved").textContent = String(done);
  $("#history-rejected").textContent = String(historyRows.filter((r) => r.review_status === "rejected").length);
  $("#history-table-body").innerHTML = historyRows.length ? historyRows.map((row) => `
    <tr>
      <td>${escapeHtml(formatDate(row.teaching_date))}</td>
      <td>${escapeHtml(historyProgramName(row))}<span class="cell-subtext">${escapeHtml(row.subject || "-")}</span></td>
      <td>${escapeHtml(METHOD_LABELS[row.method] || "-")}</td>
      <td>${escapeHtml(formatTime(row.clock_in_at))}</td>
      <td>${row.method === "cancel" ? "-" : escapeHtml(formatTime(row.clock_out_at))}${row.auto_closed ? '<span class="cell-subtext">otomatis</span>' : ""}</td>
      <td>${escapeHtml(row.student_count ?? row.attendance_students?.length ?? 0)}</td>
      <td>${statusBadge(row)}${row.review_status === "rejected" ? `<span class="cell-subtext reject-note">${escapeHtml(row.review_note || "")}</span>` : ""}</td>
      <td>${canFix(row) ? `<button class="row-action" type="button" data-fix-id="${escapeHtml(row.id)}">Perbaiki</button>` : ""}</td>
    </tr>`).join("")
    : '<tr><td colspan="8" class="empty-cell">Belum ada absen di bulan ini.</td></tr>';
}

// Tanda di halaman utama jika ada absen ditolak yang masih bisa diperbaiki (dari bulan mana pun).
async function updateRejectedBanner() {
  const banner = $("#history-rejected-banner");
  const { data, error } = await supabase
    .from("attendance")
    .select("id, teaching_date")
    .eq("teacher_id", teacherRecord.id)
    .eq("review_status", "rejected");
  if (error) { console.error(error); return; }
  const fixable = (data || []).filter((row) => new Date() <= fixDeadline(row.teaching_date));
  banner.classList.toggle("hidden", !fixable.length);
  if (fixable.length) {
    const months = [...new Set(fixable.map((r) => r.teaching_date.slice(0, 7)))].join(", ");
    banner.textContent = `Ada ${fixable.length} absen ditolak yang perlu diperbaiki (bulan ${months}). Pilih bulan tersebut lalu tekan "Perbaiki" sebelum hari Minggu pertama bulan berikutnya pukul 11.59 WIB.`;
  }
}

/* ===== Perbaikan absen ditolak ===== */

let fixRow = null;

async function loadFixStudents(programId, selectedIds = []) {
  const select = $("#fix-students");
  select.innerHTML = '<option disabled>Memuat daftar adik...</option>';
  const { data, error } = await supabase.from("students")
    .select("id, class_name, full_name")
    .eq("program_id", programId).eq("is_active", true)
    .order("class_name").order("full_name");
  if (error) { select.innerHTML = '<option disabled>Gagal memuat daftar adik</option>'; return; }
  select.innerHTML = (data || []).map((s) =>
    `<option value="${escapeHtml(s.id)}" ${selectedIds.includes(s.id) ? "selected" : ""}>${escapeHtml(s.class_name)} · ${escapeHtml(s.full_name)}</option>`
  ).join("") || '<option disabled>Tidak ada adik aktif untuk program ini</option>';
}

async function openFixDialog(attendanceId) {
  fixRow = historyRows.find((row) => row.id === attendanceId);
  if (!fixRow) return;
  const isCancel = fixRow.method === "cancel";
  $("#fix-title").textContent = `Perbaiki absen ${formatDate(fixRow.teaching_date)}`;
  $("#fix-reason").textContent = `Alasan ditolak: ${fixRow.review_note || "-"}`;
  $("#fix-program").innerHTML = assignedPrograms.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  $("#fix-program").value = assignedPrograms.some((p) => p.id === fixRow.program_id) ? fixRow.program_id : (assignedPrograms[0]?.id || "");
  // Metode tidak bisa diubah dari/ke cancel class (aturan yang sama dicek di Supabase).
  $("#fix-method").innerHTML = isCancel
    ? '<option value="cancel">Cancel class</option>'
    : '<option value="offline">Offline</option><option value="online">Online</option>';
  $("#fix-method").value = isCancel ? "cancel" : (fixRow.method === "online" ? "online" : "offline");
  $("#fix-note").value = fixRow.note || "";
  $("#fix-photo-in").value = "";
  $("#fix-photo-out").value = "";
  $("#fix-photo-out-wrap").classList.toggle("hidden", isCancel);
  $("#fix-message").textContent = "";
  const program = assignedPrograms.find((p) => p.id === $("#fix-program").value);
  fillSubjectSelect($("#fix-subject"), program?.code, fixRow.subject);
  $("#fix-dialog").showModal();
  await loadFixStudents($("#fix-program").value, (fixRow.attendance_students || []).map((s) => s.student_id));
}

async function changeFixProgram() {
  const program = assignedPrograms.find((p) => p.id === $("#fix-program").value);
  fillSubjectSelect($("#fix-subject"), program?.code, $("#fix-subject").value);
  await loadFixStudents($("#fix-program").value, []);
}

async function submitFix(event) {
  event.preventDefault();
  if (!fixRow) return;
  const message = $("#fix-message");
  const program = assignedPrograms.find((p) => p.id === $("#fix-program").value);
  const subject = $("#fix-subject").value;
  const method = $("#fix-method").value;
  const note = $("#fix-note").value.trim();
  const studentIds = Array.from($("#fix-students").selectedOptions).map((o) => o.value).filter(Boolean);
  if (!program || !subject) { message.textContent = "Program dan mapel wajib dipilih."; return; }
  if (studentIds.length < 1 || studentIds.length > 6) { message.textContent = "Pilih minimal 1 dan maksimal 6 nama adik."; return; }
  if (method === "cancel" && !note) { message.textContent = "Alasan cancel class wajib diisi."; return; }
  const button = $("#save-fix-btn");
  button.disabled = true;
  button.textContent = "Menyimpan...";
  message.textContent = "";
  try {
    // Foto pengganti tetap diberi watermark dengan jam & lokasi saat diunggah ulang.
    let inPath = null;
    let outPath = null;
    const inFile = $("#fix-photo-in").files?.[0];
    const outFile = $("#fix-photo-out").files?.[0];
    if (inFile) {
      const { photo } = await takeStampedPhoto(inFile, "Foto pengganti absen masuk", program, subject, method);
      inPath = await uploadAttendancePhoto(photo, "clock-in-fix");
    }
    if (outFile && method !== "cancel") {
      const { photo } = await takeStampedPhoto(outFile, "Foto pengganti absen keluar", program, subject, method);
      outPath = await uploadAttendancePhoto(photo, "clock-out-fix");
    }
    const { error } = await supabase.rpc("fix_rejected_attendance", {
      p_attendance_id: fixRow.id,
      p_program_id: program.id,
      p_subject: subject,
      p_method: method,
      p_student_ids: studentIds,
      p_note: note || null,
      p_clock_in_photo_path: inPath,
      p_clock_out_photo_path: outPath
    });
    if (error) throw error;
    $("#fix-dialog").close();
    showTeacherNotice("Perbaikan tersimpan. Absen kembali menunggu cek PJ.");
    await loadTeacherHistory();
  } catch (error) {
    message.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
    button.textContent = "Simpan perbaikan";
  }
}

function exportCsv() {
  if (!isPsd || !currentUser) {
    showNotice("Hanya pengguna PSD yang berhak mengekspor data.", "error");
    return;
  }
  const rows = filteredTeachers();
  if (!rows.length) {
    showNotice("Tidak ada data yang dapat diekspor dengan filter saat ini.", "error");
    return;
  }
  const headers = ["Nama Lengkap", "Email Login", "Jenis Rekening", "Nomor Rekening", "E-Wallet", "Nomor E-Wallet", "Kelengkapan", "Status Pengajar"];
  const csvCell = (value) => {
    // Mitigasi CSV formula injection ketika file dibuka di spreadsheet.
    let text = String(value ?? "");
    if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [
    headers.map(csvCell).join(","),
    ...rows.map((t) => [
      t.full_name, t.login_email, t.bank_name, t.bank_account_number, t.ewallet_name, t.ewallet_number,
      hasCompletePaymentData(t) ? "Data pembayaran tersedia" : "Perlu dilengkapi",
      t.is_active ? "Aktif" : "Nonaktif"
    ].map(csvCell).join(","))
  ].join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `data-pengajar-klc-${date}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showNotice(`CSV berhasil disiapkan (${rows.length} pengajar). Simpan file dengan aman.`);
}
function updateTopbarAuth(isLoggedIn) {
  const accountArea = document.querySelector(".account-area");
  const rightSide = document.querySelector(".right-side");

  if (accountArea) {
    accountArea.classList.toggle("hidden", !isLoggedIn);
  }

  if (rightSide) {
    rightSide.classList.toggle("hidden", isLoggedIn);
  }
}

function parseCsv(text) {
  // Parser CSV kecil yang mendukung koma, tanda kutip, dan baris baru di dalam kutipan.
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((v) => v.trim())) rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); if (row.some((v) => v.trim())) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[ _-]+/g, ""));
  const aliases = {
    full_name: ["namalengkap", "namapengajar", "nama", "fullname"],
    login_email: ["emaillogin", "email", "emailgoogle", "loginemail"],
    bank_name: ["namabank", "jenisrekening", "bank", "bankname"],
    bank_account_number: ["nomorrekening", "rekeningbank", "bankaccountnumber"],
    ewallet_name: ["namaewallet", "ewallet", "ewalletname"],
    ewallet_number: ["nomorewallet", "nomorwallet", "ewalletnumber"]
  };
  const index = {};
  for (const [key, names] of Object.entries(aliases)) index[key] = headers.findIndex((h) => names.includes(h));
  if (index.full_name < 0 || index.login_email < 0) throw new Error("CSV wajib memiliki kolom Nama Lengkap dan Email Login. Gunakan header: Nama Lengkap, Email Login, Nama Bank, Nomor Rekening, Nama E-wallet, Nomor E-wallet.");
  return rows.map((r, i) => {
    const get = (key) => index[key] >= 0 ? (r[index[key]] || "").trim() : "";
    const full_name = get("full_name"); const login_email = get("login_email").toLowerCase();
    if (!full_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login_email)) throw new Error(`Baris ${i + 2}: nama atau email tidak valid.`);
    return { full_name, login_email, bank_name: get("bank_name") || null, bank_account_number: get("bank_account_number") || null, ewallet_name: get("ewallet_name") || null, ewallet_number: get("ewallet_number") || null, is_active: true, updated_at: new Date().toISOString() };
  });
}

async function importTeachers(file) {
  if (!isPsd) throw new Error("Impor hanya tersedia untuk PSDM.");
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error("Ukuran CSV maksimal 2 MB.");
  const rows = parseCsv(await file.text());
  if (!rows.length) throw new Error("CSV tidak memiliki baris data.");
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.login_email)) throw new Error(`Email duplikat di file CSV: ${row.login_email}`);
    seen.add(row.login_email);
  }
  const button = $("#import-btn"); button.disabled = true; button.textContent = "Mengimpor...";
  try {
    let added = 0, updated = 0;
    for (const row of rows) {
      const existing = teacherRows.find((t) => (t.login_email || "").toLowerCase() === row.login_email);
      const result = existing
        ? await supabase.from("teachers").update(row).eq("id", existing.id)
        : await supabase.from("teachers").insert(row);
      if (result.error) throw new Error(`${row.login_email}: ${result.error.message}`);
      if (existing) updated++; else added++;
    }
    await loadTeachers();
    showNotice(`Impor selesai: ${added} pengajar baru, ${updated} data diperbarui.`);
  } finally { button.disabled = false; button.textContent = "↑ Impor CSV"; $("#import-file").value = ""; }
}

function renderStudentRoster() {
  const body = $("#student-table-body");
  if (!body) return;
  body.innerHTML = studentRows.length ? studentRows.map((student) => {
    const programName = programRows.find((p) => p.id === student.program_id)?.name || "Program tidak ditemukan";
    return `<tr>
      <td>${escapeHtml(student.class_name)}</td>
      <td>${escapeHtml(student.full_name)}</td>
      <td>${escapeHtml(programName)}</td>
      <td>${student.is_active ? '<span class="badge badge-active">Aktif</span>' : '<span class="badge badge-inactive">Nonaktif</span>'}</td>
      <td><button class="row-action" type="button" data-edit-student-id="${escapeHtml(student.id)}">Edit</button></td>
    </tr>`;
  }).join("") : '<tr><td colspan="5" class="empty-cell">Belum ada data adik. Tambahkan manual atau impor CSV.</td></tr>';
}

function openStudentDialog(student = null) {
  if (!isPsd) {
    showNotice("Pengelolaan data adik hanya tersedia untuk PSDM pada halaman ini.", "error");
    return;
  }
  const form = $("#student-form");
  form.reset();
  $("#student-id").value = student?.id || "";
  $("#student-dialog-title").textContent = student ? "Edit data adik" : "Tambah adik";
  $("#student-full-name").value = student?.full_name || "";
  $("#student-class-name").value = student?.class_name || "";
  $("#student-is-active").checked = student?.is_active ?? true;
  $("#student-program-id").innerHTML = '<option value="">Pilih program</option>' + programRows
    .filter((program) => program.is_active)
    .map((program) => `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("");
  $("#student-program-id").value = student?.program_id || "";
  $("#student-form-message").textContent = "";
  $("#save-student-btn").disabled = false;
  $("#save-student-btn").textContent = student ? "Simpan perubahan" : "Tambah adik";
  $("#student-dialog").showModal();
}

async function saveStudent(event) {
  event.preventDefault();
  if (!isPsd) throw new Error("Hanya PSDM yang dapat menambah atau mengubah data adik melalui halaman ini.");
  const id = clean($("#student-id").value);
  const full_name = clean($("#student-full-name").value);
  const class_name = clean($("#student-class-name").value);
  const program_id = clean($("#student-program-id").value);
  const is_active = $("#student-is-active").checked;
  if (!full_name || !class_name || !program_id) throw new Error("Nama adik, kelas, dan program wajib diisi.");
  const duplicate = studentRows.find((row) => row.id !== id && row.class_name.trim().toLocaleLowerCase("id") === class_name.toLocaleLowerCase("id") && row.full_name.trim().toLocaleLowerCase("id") === full_name.toLocaleLowerCase("id"));
  if (duplicate) throw new Error("Nama adik tersebut sudah terdaftar di kelas yang sama.");
  const payload = { full_name, class_name, program_id, is_active };
  const button = $("#save-student-btn");
  const message = $("#student-form-message");
  button.disabled = true;
  button.textContent = "Menyimpan...";
  message.textContent = "";
  try {
    const result = id
      ? await supabase.from("students").update(payload).eq("id", id)
      : await supabase.from("students").insert(payload);
    if (result.error) throw result.error;
    const refreshed = await supabase.from("students").select("id, class_name, full_name, program_id, is_active, created_at").order("class_name").order("full_name");
    if (refreshed.error) throw refreshed.error;
    studentRows = refreshed.data || [];
    renderStudentRoster();
    $("#student-dialog").close();
    showNotice(id ? "Data adik berhasil diperbarui." : "Adik baru berhasil ditambahkan.");
  } catch (error) {
    message.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
    button.textContent = id ? "Simpan perubahan" : "Tambah adik";
  }
}

function parseStudentCsv(text) {
  const rawRows = parseCsvRows(text);
  if (!rawRows.length) throw new Error("CSV tidak memiliki baris data.");
  const normalize = (value) => value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[ _-]+/g, "");
  const headers = rawRows.shift().map(normalize);
  const findIndex = (aliases) => headers.findIndex((h) => aliases.includes(h));
  const classIndex = findIndex(["kelas", "namakelas", "kelompok", "kelompokbelajar", "class"]);
  const nameIndex = findIndex(["namaadik", "nama", "namasiswa", "fullname"]);
  const programIndex = findIndex(["program", "programyangdipilih", "namaprogram"]);
  if ([classIndex, nameIndex, programIndex].some((i) => i < 0)) {
    throw new Error("Header CSV harus memuat KELAS, NAMA ADIK, dan PROGRAM.");
  }
  const programKey = (value) => normalize(value).replace(/^program/, "");
  const programByName = new Map();
  for (const p of programRows) {
    programByName.set(programKey(p.code), p);
    programByName.set(programKey(p.name), p);
  }
  const seen = new Set();
  return rawRows.map((row, i) => {
    const class_name = (row[classIndex] || "").trim();
    const full_name = (row[nameIndex] || "").trim();
    const programText = programKey(row[programIndex] || "");
    const program = programByName.get(programText);
    if (!class_name || !full_name || !program) throw new Error(`Baris ${i + 2}: kelas, nama adik, atau program tidak valid.`);
    const key = `${class_name.toLowerCase()}|${full_name.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Baris ${i + 2}: nama adik duplikat dalam kelas yang sama (${full_name}).`);
    seen.add(key);
    return { class_name, full_name, program_id: program.id, is_active: true };
  });
}

function parseCsvRows(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((v) => v.trim())) rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); if (row.some((v) => v.trim())) rows.push(row); }
  return rows;
}

async function importStudents(file) {
  if (!isPsd) throw new Error("Impor daftar adik hanya tersedia untuk PSDM.");
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) throw new Error("Ukuran CSV maksimal 5 MB.");
  const rows = parseStudentCsv(await file.text());
  if (!rows.length) throw new Error("CSV tidak memiliki baris data.");
  const message = $("#student-roster-message");
  const button = $("#import-students-btn");
  button.disabled = true; button.textContent = "Mengimpor..."; message.textContent = "";
  try {
    let added = 0, updated = 0;
    for (const row of rows) {
      const existing = studentRows.find((s) => s.class_name.trim().toLowerCase() === row.class_name.toLowerCase() && s.full_name.trim().toLowerCase() === row.full_name.toLowerCase());
      const result = existing
        ? await supabase.from("students").update(row).eq("id", existing.id)
        : await supabase.from("students").insert(row);
      if (result.error) throw new Error(`${row.class_name} / ${row.full_name}: ${result.error.message}`);
      if (existing) updated++; else added++;
    }
    const result = await supabase.from("students").select("id, class_name, full_name, program_id, is_active, created_at").order("class_name").order("full_name");
    if (result.error) throw result.error;
    studentRows = result.data || [];
    renderStudentRoster();
    message.textContent = `Impor selesai: ${added} adik baru, ${updated} data diperbarui. Data lama yang tidak ada di CSV tidak dihapus.`;
    showNotice("Daftar adik berhasil diperbarui.");
  } finally { button.disabled = false; button.textContent = "↑ Impor CSV adik"; $("#import-students-file").value = ""; }
}

/* ===== Format CSV (template kosong) untuk impor ===== */

// Header sama dengan yang dibaca parseCsv / parseStudentCsv / prepareLegacyRows.
const CSV_TEMPLATES = {
  teachers: { file: "format-impor-pengajar.csv", headers: ["Nama Lengkap", "Email Login", "Nama Bank", "Nomor Rekening", "Nama E-wallet", "Nomor E-wallet"] },
  students: { file: "format-impor-adik.csv", headers: ["KELAS", "NAMA ADIK", "PROGRAM"] },
  legacy: { file: "format-impor-absen-lama.csv", headers: LEGACY_HEADERS }
};

function downloadTemplate(name) {
  const template = CSV_TEMPLATES[name];
  downloadCsv(template.file, [template.headers]);
}

/* ===== IMPOR ABSEN LAMA DARI GFORM (SEMENTARA) ===== */

let legacyRowsToImport = [];

async function openLegacyImport(file) {
  if (!isPsd || !file) return;
  if (file.size > 5 * 1024 * 1024) { showNotice("Ukuran file maksimal 5 MB.", "error"); return; }
  try {
    // Data siswa termasuk yang nonaktif, karena absen lama bisa berisi adik yang sudah keluar.
    const result = prepareLegacyRows(await file.text(), { teachers: teacherRows, programs: programRows, students: studentRows });
    legacyRowsToImport = result.valid;
    $("#legacy-summary").innerHTML = `<strong>${result.valid.length}</strong> baris siap diimpor, <strong>${result.errors.length}</strong> baris bermasalah.`;
    $("#legacy-errors").innerHTML = result.errors.length
      ? `<div class="form-section-title">Baris bermasalah (tidak ikut diimpor)</div><ul class="legacy-list">${result.errors.map((e) => `<li><strong>Baris ${e.line}:</strong> ${escapeHtml(e.message)}</li>`).join("")}</ul>
         <p class="form-hint">Perbaiki di sheet lalu impor ulang. Baris yang sudah masuk tidak akan dobel.</p>`
      : "";
    $("#legacy-preview").innerHTML = result.preview.length
      ? `<div class="form-section-title">Contoh baris siap diimpor</div><ul class="legacy-list">${result.preview.slice(0, 5).map((p) =>
          `<li>Baris ${p.line}: ${escapeHtml(formatDate(p.date))} · ${escapeHtml(p.teacher)} · ${escapeHtml(p.program)} · ${escapeHtml(p.subject || "-")} · ${p.count} adik · ${escapeHtml(STATUS_LABELS[p.status])}</li>`).join("")}</ul>`
      : "";
    $("#legacy-message").textContent = "";
    $("#confirm-legacy-btn").disabled = !result.valid.length;
    $("#confirm-legacy-btn").textContent = `Impor ${result.valid.length} baris`;
    $("#legacy-dialog").showModal();
  } catch (error) {
    showNotice(errorMessage(error), "error");
  } finally {
    $("#legacy-import-file").value = "";
  }
}

async function confirmLegacyImport() {
  if (!legacyRowsToImport.length) return;
  const button = $("#confirm-legacy-btn");
  button.disabled = true;
  button.textContent = "Mengimpor...";
  try {
    const { data, error } = await supabase.rpc("import_legacy_attendance", { p_rows: legacyRowsToImport });
    if (error) throw error;
    $("#legacy-dialog").close();
    legacyRowsToImport = [];
    showNotice(`Impor selesai: ${data.inserted} absen baru, ${data.skipped} dilewati karena sudah pernah diimpor. Atur rentang tanggal untuk melihatnya.`);
    await loadAttendanceRecap();
  } catch (error) {
    $("#legacy-message").textContent = errorMessage(error);
    button.disabled = false;
    button.textContent = "Coba lagi";
  }
}

/* ===== Penugasan PJ (PSD) ===== */
// Semua perubahan lewat RPC khusus PSD, karena email akun ada di auth.users yang tidak bisa dibaca frontend.

let managerRows = [];

function fillManagerForm() {
  const select = $("#manager-program");
  const current = select.value;
  select.innerHTML = '<option value="">Pilih program...</option>' + programRows
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  select.value = programRows.some((p) => p.id === current) ? current : "";
  // Saran email dari Data Pengajar (PJ sering juga pengajar).
  $("#manager-email-options").innerHTML = teacherRows.filter((t) => t.login_email)
    .map((t) => `<option value="${escapeHtml(t.login_email)}">${escapeHtml(t.full_name)}</option>`).join("");
}

async function loadProgramManagers() {
  if (!isPsd) return;
  fillManagerForm();
  const body = $("#manager-table-body");
  body.innerHTML = '<tr><td colspan="6" class="empty-cell">Memuat penugasan PJ...</td></tr>';
  const { data, error } = await supabase.rpc("psd_list_program_managers");
  if (error) {
    body.innerHTML = `<tr><td colspan="6" class="empty-cell">Gagal memuat: ${escapeHtml(errorMessage(error))}</td></tr>`;
    return;
  }
  managerRows = data || [];
  body.innerHTML = managerRows.length ? managerRows.map((m) => `
    <tr>
      <td>${escapeHtml(m.program_name)}</td>
      <td><span class="teacher-name">${escapeHtml(m.full_name || "-")}</span></td>
      <td>${escapeHtml(m.email || "-")}</td>
      <td>${m.role === "teacher" ? "PJ + Pengajar" : "PJ"}</td>
      <td>${m.is_active ? '<span class="badge badge-active">Aktif</span>' : '<span class="badge badge-inactive">Nonaktif</span>'}</td>
      <td><button class="row-action" type="button" data-manager-id="${escapeHtml(m.id)}" data-manager-active="${m.is_active ? "false" : "true"}">${m.is_active ? "Nonaktifkan" : "Aktifkan"}</button></td>
    </tr>`).join("")
    : '<tr><td colspan="6" class="empty-cell">Belum ada PJ yang ditugaskan.</td></tr>';
}

async function saveProgramManager(event) {
  event.preventDefault();
  const message = $("#manager-message");
  const programId = $("#manager-program").value;
  const email = $("#manager-email").value.trim().toLowerCase();
  if (!programId) { message.textContent = "Pilih program terlebih dahulu."; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { message.textContent = "Masukkan email Google yang valid."; return; }
  const programName = programRows.find((p) => p.id === programId)?.name || "program ini";
  // Aturan maks 2 PJ per program & 1 orang 1 program dicek di Supabase; pesan errornya tampil di bawah form.
  const button = $("#save-manager-btn");
  button.disabled = true;
  message.textContent = "";
  try {
    const { error } = await supabase.rpc("psd_assign_program_manager", {
      p_program_id: programId,
      p_email: email,
      p_full_name: $("#manager-name").value.trim() || null
    });
    if (error) throw error;
    $("#manager-form").reset();
    showNotice(`${email} sekarang menjadi PJ ${programName}.`);
    await loadProgramManagers();
  } catch (error) {
    message.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function toggleProgramManager(id, active) {
  const row = managerRows.find((m) => m.id === id);
  if (!row) return;
  const text = active
    ? `Aktifkan ${row.full_name || row.email} sebagai PJ ${row.program_name}?`
    : `Nonaktifkan ${row.full_name || row.email} sebagai PJ ${row.program_name}?`;
  if (!window.confirm(text)) return;
  const { error } = await supabase.rpc("psd_set_program_manager_active", { p_id: id, p_active: active });
  if (error) { showNotice(errorMessage(error), "error"); return; }
  showNotice(active ? "PJ diaktifkan." : "PJ dinonaktifkan.");
  await loadProgramManagers();
}

function exportStudentsCsv() {
  if (!isPsd) { showNotice("Ekspor daftar adik hanya tersedia untuk PSDM.", "error"); return; }
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [["KELAS", "NAMA ADIK", "PROGRAM"], ...studentRows.map((s) => [s.class_name, s.full_name, programRows.find((p) => p.id === s.program_id)?.name || ""])];
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a"); link.href = url; link.download = `daftar-adik-klc-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

async function saveTeacherProgramAssignments(teacherId) {
  const selectedIds = Array.from(document.querySelectorAll('input[name="assigned-program"]:checked')).map((el) => el.value);
  const existing = assignmentRows.filter((a) => a.teacher_id === teacherId);
  const toDeactivate = existing.filter((a) => a.is_active && !selectedIds.includes(a.program_id));
  for (const assignment of toDeactivate) {
    const { error } = await supabase.from("teacher_program_assignments").update({ is_active: false }).eq("id", assignment.id);
    if (error) throw error;
  }
  for (const programId of selectedIds) {
    const row = existing.find((a) => a.program_id === programId);
    if (row) {
      if (!row.is_active) {
        const { error } = await supabase.from("teacher_program_assignments").update({ is_active: true }).eq("id", row.id);
        if (error) throw error;
      }
    } else {
      const { error } = await supabase.from("teacher_program_assignments").insert({ teacher_id: teacherId, program_id: programId, is_active: true });
      if (error) throw error;
    }
  }
}

async function saveTeacher(event) {
  event.preventDefault();
  if (!isPsd) {
    $("#form-message").textContent = "Akses hanya untuk PSD.";
    return;
  }
  const fullName = fields.name.value.trim();
  const loginEmail = fields.email.value.trim().toLowerCase();
  if (!fullName) {
    $("#form-message").textContent = "Nama lengkap wajib diisi.";
    fields.name.focus();
    return;
  }
  if (!loginEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginEmail)) {
    $("#form-message").textContent = "Masukkan email login yang valid.";
    fields.email.focus();
    return;
  }

  const duplicate = teacherRows.find((t) => (t.login_email || "").toLowerCase() === loginEmail && t.id !== fields.id.value);
  if (duplicate) {
    $("#form-message").textContent = "Email ini sudah digunakan oleh pengajar lain.";
    fields.email.focus();
    return;
  }

  const payload = {
    full_name: fullName,
    login_email: loginEmail,
    bank_name: clean(fields.bankName.value),
    bank_account_number: clean(fields.bankNumber.value),
    ewallet_name: clean(fields.walletName.value),
    ewallet_number: clean(fields.walletNumber.value),
    is_active: fields.active.checked,
    updated_at: new Date().toISOString()
  };

  const saveButton = $("#save-btn");
  saveButton.disabled = true;
  saveButton.textContent = "Menyimpan...";
  $("#form-message").textContent = "";

  try {
    let result;
    if (fields.id.value) {
      result = await supabase.from("teachers").update(payload).eq("id", fields.id.value).select("id").single();
    } else {
      result = await supabase.from("teachers").insert(payload).select("id").single();
    }
    if (result.error) throw result.error;
    const savedTeacherId = result.data?.id || fields.id.value;
    if (savedTeacherId) await saveTeacherProgramAssignments(savedTeacherId);
    $("#teacher-dialog").close();
    await loadTeachers();
    showNotice(fields.id.value ? "Data pengajar dan penugasan program berhasil diperbarui." : "Data pengajar dan penugasan program berhasil ditambahkan.");
  } catch (error) {
    $("#form-message").textContent = errorMessage(error);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = fields.id.value ? "Simpan perubahan" : "Simpan data";
  }
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) {
    showNotice(errorMessage(error), "error");
    return;
  }
  currentUser = null;
  isPsd = false;
  teacherRows = [];
  updateTopbarAuth(false);
  showView("login");
}

$("#google-login-btn").addEventListener("click", async () => {
  $("#google-login-btn").disabled = true;
  $("#login-message").textContent = "";
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
  } catch (error) {
    $("#login-message").textContent = errorMessage(error);
    $("#google-login-btn").disabled = false;
  }
});

document.querySelectorAll("[data-psd-section]").forEach((button) => {
  button.addEventListener("click", () => switchPsdSection(button.dataset.psdSection));
});

$("#sign-out-btn").addEventListener("click", signOut);
$("#denied-sign-out-btn").addEventListener("click", signOut);
$("#add-teacher-btn").addEventListener("click", () => openTeacherDialog());
$("#export-btn").addEventListener("click", exportCsv);
$("#import-btn").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (event) => {
  try { await importTeachers(event.target.files?.[0]); }
  catch (error) { showNotice(errorMessage(error), "error"); }
});
$("#teacher-form").addEventListener("submit", saveTeacher);
$("#close-dialog-btn").addEventListener("click", () => $("#teacher-dialog").close());
$("#cancel-btn").addEventListener("click", () => $("#teacher-dialog").close());
$("#search-input").addEventListener("input", renderTeachers);
$("#completeness-filter").addEventListener("change", renderTeachers);
$("#active-filter").addEventListener("change", renderTeachers);

$("#attendance-program").addEventListener("change", () => { updateAttendanceForm(); });
$("#attendance-students").addEventListener("change", updateSelectedStudentCount);
$("#import-students-btn").addEventListener("click", () => $("#import-students-file").click());
$("#import-students-file").addEventListener("change", async (event) => {
  try { await importStudents(event.target.files?.[0]); }
  catch (error) { $("#student-roster-message").textContent = errorMessage(error); showNotice(errorMessage(error), "error"); }
});
$("#export-students-btn").addEventListener("click", exportStudentsCsv);
$("#manager-form").addEventListener("submit", saveProgramManager);
$("#reload-managers-btn").addEventListener("click", loadProgramManagers);
$("#manager-table-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-manager-id]");
  if (button) toggleProgramManager(button.dataset.managerId, button.dataset.managerActive === "true");
});
$("#teacher-template-btn").addEventListener("click", () => downloadTemplate("teachers"));
$("#student-template-btn").addEventListener("click", () => downloadTemplate("students"));
$("#legacy-template-btn").addEventListener("click", () => downloadTemplate("legacy"));
$("#legacy-import-btn").addEventListener("click", () => $("#legacy-import-file").click());
$("#legacy-import-file").addEventListener("change", (event) => openLegacyImport(event.target.files?.[0]));
$("#confirm-legacy-btn").addEventListener("click", confirmLegacyImport);
$("#close-legacy-btn").addEventListener("click", () => $("#legacy-dialog").close());
$("#cancel-legacy-btn").addEventListener("click", () => $("#legacy-dialog").close());
$("#add-student-btn").addEventListener("click", () => openStudentDialog());
$("#student-form").addEventListener("submit", saveStudent);
$("#close-student-dialog-btn").addEventListener("click", () => $("#student-dialog").close());
$("#cancel-student-btn").addEventListener("click", () => $("#student-dialog").close());
$("#student-table-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-student-id]");
  if (!button) return;
  const student = studentRows.find((item) => item.id === button.dataset.editStudentId);
  if (student) openStudentDialog(student);
});
$("#reload-recap-btn").addEventListener("click", loadAttendanceRecap);
$("#recap-date-from").addEventListener("change", loadAttendanceRecap);
$("#recap-date-to").addEventListener("change", loadAttendanceRecap);
$("#recap-program-filter").addEventListener("change", renderAttendanceRecap);
$("#recap-teacher-search").addEventListener("input", renderAttendanceRecap);
$("#recap-table-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-attendance-id]");
  if (button) openAttendanceDetail(button.dataset.attendanceId);
});
$("#close-attendance-detail-btn").addEventListener("click", () => $("#attendance-detail-dialog").close());
$("#close-attendance-detail-bottom").addEventListener("click", () => $("#attendance-detail-dialog").close());
$("#recap-status-filter").addEventListener("change", renderAttendanceRecap);
$("#review-approve-btn").addEventListener("click", () => submitReview("approve"));
$("#review-reject-btn").addEventListener("click", () => submitReview("reject"));
$("#export-ready-btn").addEventListener("click", exportReadyToSend);
$("#mark-sent-btn").addEventListener("click", markExportedAsSent);
$("#export-view-btn").addEventListener("click", exportCurrentView);
$("#attendance-method").addEventListener("change", updateMethodHint);
$("#history-month").addEventListener("change", loadTeacherHistory);
$("#history-table-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-fix-id]");
  if (button) openFixDialog(button.dataset.fixId);
});
$("#fix-program").addEventListener("change", changeFixProgram);
$("#fix-form").addEventListener("submit", submitFix);
$("#close-fix-btn").addEventListener("click", () => $("#fix-dialog").close());
$("#cancel-fix-btn").addEventListener("click", () => $("#fix-dialog").close());
$("#clock-in-form").addEventListener("submit", submitClockIn);
$("#clock-out-btn").addEventListener("click", submitClockOut);

$("#teacher-table-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-id]");
  if (!button) return;
  const teacher = teacherRows.find((item) => item.id === button.dataset.editId);
  if (teacher) openTeacherDialog(teacher);
});

supabase.auth.onAuthStateChange((_event, session) => {
  updateTopbarAuth(!!session);

  // Jadwalkan check agar tidak melakukan operasi jaringan di dalam callback auth.
  // updateTopbarAuth(!!session);
  if (!session) {
    currentUser = null;
    isPsd = false;
    isTeacher = false;
    teacherRecord = null;
    assignedPrograms = [];
    openAttendance = null;
    teacherRows = [];
    recapRows = [];
    recapLoaded = false;
    showView("login");
  }
});

(async function init() {
  if (SUPABASE_URL.includes("YOUR_PROJECT") || SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE")) {
    showView("login");
    $("#login-message").textContent = "Isi Supabase URL dan publishable/anon key di js/config.js terlebih dahulu.";
    return;
  }
  try {
    showView("loading");
    await checkAccess();
  } catch (error) {
    showView("login");
    $("#login-message").textContent = errorMessage(error);
  }
})();
