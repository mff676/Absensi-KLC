import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { METHOD_LABELS, ATTENDANCE_COLUMNS, statusKey, statusBadge, formatDate, formatTime, attendanceDetailHtml, showAttendancePhoto, formatRupiah, formatDateTime, monthToPeriod, previousMonthValue, formatMonth } from "./attendance-utils.js";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const $ = (s) => document.querySelector(s);
let user = null, managedPrograms = [], students = [];
const views = ["#pj-loading", "#pj-login", "#pj-denied", "#pj-app"];
function view(id) { views.forEach((v) => $(v).classList.add("hidden")); $(id).classList.remove("hidden"); }
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

function esc(v="") { return String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c])); }
function notice(message, error=false) { const el=$("#pj-notice"); el.textContent=message; el.className=`notice ${error?'notice-error':'notice-success'}`; el.classList.remove("hidden"); }
function err(e) { console.error(e); return e?.message || "Terjadi kesalahan. Coba lagi."; }
async function signIn() { const {error}=await supabase.auth.signInWithOAuth({provider:"google",options:{redirectTo:location.origin+location.pathname}}); if(error) $("#pj-login-message").textContent=err(error); }
async function signOut() { await supabase.auth.signOut(); location.reload(); }
async function boot() {
  view("#pj-loading");
  const {data:{session},error}=await supabase.auth.getSession(); if(error) throw error;
  user=session?.user||null;
  updateTopbarAuth(!!user)
  if(!user) { view("#pj-login"); return; }
const { data: managers, error: managerError } = await supabase
  .from("program_managers")
  .select("program_id, programs(id, code, name, is_active)")
  .eq("profile_id", user.id)
  .eq("is_active", true);

const { data: profile, error: profileError } = await supabase
  .from("profiles")
  .select("full_name")
  .eq("id", user.id)
  .maybeSingle();

if (profileError) {
  console.error("Gagal mengambil username:", profileError);
}

$("#pj-user-email").textContent =
  profile?.full_name || user.email || "";

$("#pj-sign-out").classList.remove("hidden");
  if(managerError) throw managerError;
  managedPrograms=(managers||[]).map(x=>x.programs).filter(p=>p&&p.is_active);
  if(!managedPrograms.length) { view("#pj-denied"); return; }
  const select=$("#pj-program-filter"); select.innerHTML='<option value="all">Semua program yang dikelola</option>'+managedPrograms.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("#pj-student-program").innerHTML=managedPrograms.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  view("#pj-app"); await loadStudents();
}
async function loadStudents() {
  const {data,error}=await supabase.from("students").select("id, class_name, full_name, program_id, is_active, created_at, updated_at").order("class_name").order("full_name");
  if(error) throw error; students=data||[]; render();
}
function filtered() {
  const q=$("#pj-search").value.trim().toLocaleLowerCase("id"), prog=$("#pj-program-filter").value, status=$("#pj-status-filter").value;
  return students.filter(s=>(prog==="all"||s.program_id===prog)&&(!q||`${s.class_name} ${s.full_name}`.toLocaleLowerCase("id").includes(q))&&(status==="all"||(status==="active"&&s.is_active)||(status==="inactive"&&!s.is_active)));
}
function render() {
  const rows=filtered();
  $("#pj-student-table").innerHTML=rows.length?rows.map(s=>`<tr><td>${esc(s.class_name)}</td><td>${esc(s.full_name)}</td><td>${esc(managedPrograms.find(p=>p.id===s.program_id)?.name||"Program")}</td><td>${s.is_active?'<span class="badge badge-active">Aktif</span>':'<span class="badge badge-inactive">Nonaktif</span>'}</td><td><button class="row-action" data-pj-edit="${esc(s.id)}" type="button">Edit</button></td></tr>`).join(""):'<tr><td colspan="5" class="empty-cell">Tidak ada data adik.</td></tr>';
}
function openForm(s=null) {
  $("#pj-student-form").reset(); $("#pj-student-id").value=s?.id||""; $("#pj-dialog-title").textContent=s?"Edit data adik":"Tambah adik";
  $("#pj-student-name").value=s?.full_name||""; $("#pj-student-class").value=s?.class_name||""; $("#pj-student-active").checked=s?.is_active??true;
  $("#pj-student-program").value=s?.program_id||managedPrograms[0]?.id||""; $("#pj-student-program").disabled=Boolean(s); $("#pj-student-message").textContent=""; $("#pj-student-dialog").showModal();
}
async function saveStudent(event) {
  event.preventDefault(); const id=$("#pj-student-id").value||null, full_name=$("#pj-student-name").value.trim(), class_name=$("#pj-student-class").value.trim(), program_id=$("#pj-student-program").value, is_active=$("#pj-student-active").checked;
  if(!full_name||!class_name||!program_id) { $("#pj-student-message").textContent="Nama, kelas, dan program wajib diisi."; return; }
  if(!managedPrograms.some(p=>p.id===program_id)) { $("#pj-student-message").textContent="Program tidak termasuk penugasan PJ ini."; return; }
  const dup=students.find(s=>s.id!==id&&s.program_id===program_id&&s.class_name.toLocaleLowerCase("id")===class_name.toLocaleLowerCase("id")&&s.full_name.toLocaleLowerCase("id")===full_name.toLocaleLowerCase("id"));
  if(dup) { $("#pj-student-message").textContent="Nama adik sudah terdaftar pada kelas dan program ini."; return; }
  const btn=$("#pj-save-student"); btn.disabled=true; btn.textContent="Menyimpan...";
  try {
    const payload={full_name,class_name,program_id,is_active};
    const result=id?await supabase.from("students").update(payload).eq("id",id):await supabase.from("students").insert(payload);
    if(result.error) throw result.error; await loadStudents(); $("#pj-student-dialog").close(); notice(id?"Data adik berhasil diperbarui.":"Adik berhasil ditambahkan.");
  } catch(e) { $("#pj-student-message").textContent=err(e); }
  finally { btn.disabled=false; btn.textContent="Simpan data"; }
}
function exportCsv() {
  const rows=[["KELAS","NAMA ADIK","PROGRAM"],...filtered().map(s=>[s.class_name,s.full_name,managedPrograms.find(p=>p.id===s.program_id)?.name||""])];
  const csv=rows.map(r=>r.map(v=>'"'+String(v??"").replace(/"/g,'""')+'"').join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8;"})); const a=document.createElement("a"); a.href=url; a.download="daftar-adik-pj-klc.csv"; a.click(); URL.revokeObjectURL(url);
}
$("#pj-google-login").addEventListener("click",signIn); $("#pj-sign-out").addEventListener("click",signOut); $("#pj-denied-sign-out").addEventListener("click",signOut);
$("#pj-add-student").addEventListener("click",()=>openForm()); $("#pj-export-students").addEventListener("click",exportCsv); $("#pj-search").addEventListener("input",render); $("#pj-program-filter").addEventListener("change",render); $("#pj-status-filter").addEventListener("change",render);
$("#pj-student-table").addEventListener("click",e=>{const b=e.target.closest("[data-pj-edit]");if(b)openForm(students.find(s=>s.id===b.dataset.pjEdit));});
$("#pj-student-form").addEventListener("submit",saveStudent); $("#pj-close-dialog").addEventListener("click",()=>$("#pj-student-dialog").close()); $("#pj-cancel-dialog").addEventListener("click",()=>$("#pj-student-dialog").close());
/* ===== Rekap Absensi PJ ===== */
let pjAttendance = [], pjTeacherNames = new Map(), myTeacherId = null, pjAttendanceLoaded = false, pjDetailId = null;

function showPjTab(tab) {
  $("#pj-students-tab").classList.toggle("hidden", tab !== "students");
  $("#pj-attendance-tab").classList.toggle("hidden", tab !== "attendance");
  $("#pj-payroll-tab").classList.toggle("hidden", tab !== "payroll");
  document.querySelectorAll("[data-pj-tab]").forEach((b) => b.classList.toggle("active", b.dataset.pjTab === tab));
  if (tab === "attendance" && !pjAttendanceLoaded) loadPjAttendance();
  if (tab === "payroll") loadPjPayroll();
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function pjTeacherName(row) { return pjTeacherNames.get(row.teacher_id) || "Pengajar"; }
function pjProgramName(row) { return managedPrograms.find((p) => p.id === row.program_id)?.name || row.class_type || "-"; }

async function loadPjAttendance() {
  const body = $("#pj-attendance-table");
  const from = $("#pj-date-from"), to = $("#pj-date-to");
  if (!from.value) { const now = new Date(); from.value = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)); }
  if (!to.value) to.value = localDate(new Date());
  body.innerHTML = '<tr><td colspan="9" class="empty-cell">Memuat rekap absensi...</td></tr>';
  try {
    // PJ tidak boleh membaca tabel teachers (ada data rekening), jadi nama pengajar diambil lewat fungsi khusus.
    const names = await supabase.rpc("get_my_program_teacher_names");
    if (names.error) throw names.error;
    pjTeacherNames = new Map((names.data || []).map((t) => [t.id, t.full_name]));
    // Record pengajar milik PJ sendiri (jika PJ juga mengajar) untuk menyembunyikan tombol cek.
    const own = await supabase.from("teachers").select("id").eq("profile_id", user.id).maybeSingle();
    myTeacherId = own.data?.id || null;
    // RLS hanya mengembalikan absen di program yang dipegang PJ (dan absen miliknya sendiri).
    const { data, error } = await supabase.from("attendance").select(ATTENDANCE_COLUMNS)
      .in("program_id", managedPrograms.map((p) => p.id))
      .gte("teaching_date", from.value).lte("teaching_date", to.value)
      .order("teaching_date", { ascending: false }).order("clock_in_at", { ascending: false });
    if (error) throw error;
    pjAttendance = data || [];
    pjAttendanceLoaded = true;
    renderPjAttendance();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" class="empty-cell">Gagal memuat rekap: ${esc(err(e))}</td></tr>`;
  }
}

function filteredPjAttendance() {
  const status = $("#pj-attendance-status").value;
  const q = $("#pj-teacher-search").value.trim().toLocaleLowerCase("id");
  return pjAttendance.filter((row) => (status === "all" || statusKey(row) === status) && pjTeacherName(row).toLocaleLowerCase("id").includes(q));
}

function renderPjAttendance() {
  const rows = filteredPjAttendance();
  $("#pj-pending-count").textContent = String(pjAttendance.filter((r) => statusKey(r) === "pending").length);
  $("#pj-running-count").textContent = String(pjAttendance.filter((r) => !r.clock_out_at).length);
  $("#pj-total-count").textContent = String(rows.length);
  $("#pj-attendance-table").innerHTML = rows.length ? rows.map((row) => `<tr>
      <td>${esc(formatDate(row.teaching_date))}</td>
      <td><span class="teacher-name">${esc(pjTeacherName(row))}</span></td>
      <td>${esc(pjProgramName(row))}<span class="cell-subtext">${esc(row.subject || "-")}</span></td>
      <td>${esc(METHOD_LABELS[row.method] || "-")}</td>
      <td>${esc(formatTime(row.clock_in_at))}</td>
      <td>${row.method === "cancel" ? "-" : esc(formatTime(row.clock_out_at))}${row.auto_closed ? '<span class="cell-subtext">otomatis</span>' : ""}</td>
      <td>${esc(row.student_count ?? row.attendance_students?.length ?? 0)}</td>
      <td>${statusBadge(row)}</td>
      <td><button class="row-action" type="button" data-pj-attendance="${esc(row.id)}">Detail</button></td>
    </tr>`).join("") : '<tr><td colspan="9" class="empty-cell">Tidak ada sesi untuk filter ini.</td></tr>';
}

function openPjDetail(id) {
  const row = pjAttendance.find((r) => r.id === id);
  if (!row) return;
  pjDetailId = row.id;
  $("#pj-detail-title").textContent = `${pjTeacherName(row)} · ${formatDate(row.teaching_date)}`;
  $("#attendance-detail-content").innerHTML = attendanceDetailHtml(row, { program: pjProgramName(row) });
  // PJ hanya mengecek sesi yang sudah selesai, masih "Menunggu PJ", dan bukan absennya sendiri.
  const isOwn = row.teacher_id === myTeacherId;
  // PJ boleh mengubah keputusan selama rekap gaji belum di-ACC (Supabase yang menolak jika sudah terkunci).
  const canReview = ["pending", "pj_approved", "approved", "rejected"].includes(statusKey(row)) && !isOwn;
  $("#pj-review-box").classList.toggle("hidden", !canReview);
  $("#pj-review-info").classList.toggle("hidden", canReview);
  $("#pj-review-info").textContent = isOwn ? "Ini absen milikmu sendiri, jadi dicek oleh PSD." : "Sesi ini belum selesai atau sudah dibayar.";
  $("#pj-review-note").value = "";
  $("#pj-review-message").textContent = "";
  $("#pj-detail-dialog").showModal();
  showAttendancePhoto(supabase, row.clock_in_photo_path, "recap-photo-in");
  if (row.method !== "cancel") showAttendancePhoto(supabase, row.clock_out_photo_path, "recap-photo-out");
}

async function submitPjReview(decision) {
  const note = $("#pj-review-note").value.trim();
  if (decision === "reject" && !note) { $("#pj-review-message").textContent = "Tulis alasan penolakan agar guru tahu apa yang harus diperbaiki."; return; }
  const buttons = [$("#pj-approve-btn"), $("#pj-reject-btn")];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const { error } = await supabase.rpc("review_attendance", { p_attendance_id: pjDetailId, p_decision: decision, p_note: note || null });
    if (error) throw error;
    $("#pj-detail-dialog").close();
    notice(decision === "approve" ? "Sesi disetujui dan diteruskan ke PSD." : "Sesi ditolak. Guru bisa memperbaikinya dari riwayat.");
    await loadPjAttendance();
  } catch (e) { $("#pj-review-message").textContent = err(e); }
  finally { buttons.forEach((b) => { b.disabled = false; }); }
}

document.querySelectorAll("[data-pj-tab]").forEach((b) => b.addEventListener("click", () => showPjTab(b.dataset.pjTab)));
$("#pj-reload-attendance").addEventListener("click", loadPjAttendance);
$("#pj-date-from").addEventListener("change", loadPjAttendance);
$("#pj-date-to").addEventListener("change", loadPjAttendance);
$("#pj-attendance-status").addEventListener("change", renderPjAttendance);
$("#pj-teacher-search").addEventListener("input", renderPjAttendance);
$("#pj-attendance-table").addEventListener("click", (e) => { const b = e.target.closest("[data-pj-attendance]"); if (b) openPjDetail(b.dataset.pjAttendance); });
$("#pj-approve-btn").addEventListener("click", () => submitPjReview("approve"));
$("#pj-reject-btn").addEventListener("click", () => submitPjReview("reject"));
$("#pj-close-detail").addEventListener("click", () => $("#pj-detail-dialog").close());
$("#pj-close-detail-bottom").addEventListener("click", () => $("#pj-detail-dialog").close());

/* ===== Rekap Gaji PJ ===== */
// PJ melihat fee (hanya baca), lalu meng-ACC rekap tiap guru di programnya setelah bulannya selesai.
let pjPayrollRows = [], pjPayrollAdjustments = [];

function pjPayrollPeriod() {
  if (!$("#pj-payroll-month").value) $("#pj-payroll-month").value = previousMonthValue();
  return monthToPeriod($("#pj-payroll-month").value);
}

function pjPayrollStatus(r) {
  if (r.paid_at) return '<span class="badge badge-active">Sudah dibayar</span>';
  if (r.psd_approved_at) return '<span class="badge badge-active">Rekap gaji disetujui PSD</span>';
  if (r.pj_acc_at) return '<span class="badge badge-incomplete">Menunggu PSD</span>';
  if (r.return_note) return `<span class="badge badge-rejected">Dikembalikan PSD</span><span class="cell-subtext reject-note">${esc(r.return_note)}</span>`;
  if (r.not_ready_count) return `<span class="badge badge-inactive">${r.not_ready_count} sesi belum disetujui</span>`;
  return '<span class="badge badge-incomplete">Siap di-ACC</span>';
}

async function loadPjPayroll() {
  const body = $("#pj-payroll-table");
  body.innerHTML = '<tr><td colspan="7" class="empty-cell">Memuat rekap gaji...</td></tr>';
  $("#pj-payroll-message").textContent = "";
  const period = pjPayrollPeriod();
  const [overview, adjustments] = await Promise.all([
    supabase.rpc("payroll_overview", { p_period: period }),
    supabase.rpc("payroll_adjustment_list", { p_period: period })
  ]);
  if (overview.error || adjustments.error) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell">Gagal memuat: ${esc(err(overview.error || adjustments.error))}</td></tr>`;
    return;
  }
  pjPayrollRows = overview.data || [];
  pjPayrollAdjustments = adjustments.data || [];
  const monthEnded = period < monthToPeriod(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`);
  body.innerHTML = pjPayrollRows.length ? pjPayrollRows.map((r) => {
    const adjustment = pjPayrollAdjustments.filter((a) => a.teacher_id === r.teacher_id).reduce((sum, a) => sum + a.amount, 0);
    // Tombol ACC: bulan sudah selesai, semua sesi disetujui, belum di-ACC, dan bukan rekap milik sendiri.
    const canAcc = monthEnded && !r.pj_acc_at && !r.psd_approved_at && !r.not_ready_count && !r.is_own;
    const accInfo = r.is_own ? '<span class="cell-subtext">Rekap milikmu di-ACC PSD</span>'
      : !monthEnded ? '<span class="cell-subtext">ACC setelah bulan selesai</span>' : "";
    return `<tr>
      <td><span class="teacher-name">${esc(r.teacher_name)}</span></td>
      <td>${esc(r.program_name)}</td>
      <td>${r.session_count}${r.missing_fee_count ? `<span class="cell-subtext">${r.missing_fee_count} tanpa tarif</span>` : ""}</td>
      <td>${esc(formatRupiah(r.total_fee))}</td>
      <td>${adjustment ? esc(formatRupiah(adjustment)) : "-"}</td>
      <td>${pjPayrollStatus(r)}</td>
      <td><button class="row-action" type="button" data-pj-payroll-detail="${esc(r.teacher_id)}" data-program="${esc(r.program_id)}">Detail</button>
        ${canAcc ? `<button class="row-action" type="button" data-pj-acc="${esc(r.teacher_id)}" data-program="${esc(r.program_id)}">ACC</button>` : ""}${accInfo}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="7" class="empty-cell">Tidak ada sesi untuk direkap pada bulan ini.</td></tr>';
}

async function accPjPayroll(teacherId, programId) {
  const row = pjPayrollRows.find((r) => r.teacher_id === teacherId && r.program_id === programId);
  if (!row || !window.confirm(`ACC rekap ${row.teacher_name} (${row.program_name}) sebesar ${formatRupiah(row.total_fee)}? Setelah ACC, sesinya terkunci sampai PSD mengembalikan.`)) return;
  const { error } = await supabase.rpc("pj_acc_payroll", { p_teacher_id: teacherId, p_program_id: programId, p_period: pjPayrollPeriod() });
  if (error) { $("#pj-payroll-message").textContent = err(error); return; }
  notice("Rekap di-ACC dan diteruskan ke PSD.");
  await loadPjPayroll();
}

async function openPjPayrollDetail(teacherId, programId) {
  const row = pjPayrollRows.find((r) => r.teacher_id === teacherId && r.program_id === programId);
  if (!row) return;
  $("#pj-payroll-title").textContent = `${row.teacher_name} · ${row.program_name} · ${formatMonth($("#pj-payroll-month").value)}`;
  $("#pj-payroll-content").innerHTML = '<p class="muted">Memuat rincian...</p>';
  $("#pj-payroll-dialog").showModal();
  const { data, error } = await supabase.rpc("payroll_sessions", { p_period: pjPayrollPeriod(), p_teacher_id: teacherId });
  if (error) { $("#pj-payroll-content").innerHTML = `<p class="message">${esc(err(error))}</p>`; return; }
  const sessions = (data || []).filter((s) => s.program_id === programId);
  const adjustments = pjPayrollAdjustments.filter((a) => a.teacher_id === teacherId);
  $("#pj-payroll-content").innerHTML = `
    ${row.return_note && !row.pj_acc_at ? `<p class="notice notice-error">Catatan PSD: ${esc(row.return_note)}. Tolak sesi yang perlu direvisi di tab Rekap Absensi, lalu ACC lagi.</p>` : ""}
    ${row.pj_acc_at ? `<p class="form-hint">ACC oleh ${esc(row.pj_acc_name || "-")} · ${esc(formatDateTime(row.pj_acc_at))}</p>` : ""}
    <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>Mapel</th><th>Metode</th><th>Adik</th><th>Status</th><th>Tarif</th><th>Fee</th></tr></thead><tbody>
      ${sessions.map((s) => `<tr><td>${esc(formatDate(s.teaching_date))}</td><td>${esc(s.subject || "-")}</td><td>${esc(METHOD_LABELS[s.method] || "-")}</td>
        <td>${esc(s.student_count ?? "-")}</td><td>${statusBadge({ ...s, clock_out_at: true })}</td>
        <td>${esc(s.fee_manual ? "Manual (PSD)" : s.special_rate_name || "Standar")}</td><td>${s.fee == null ? "Tarif belum diatur" : esc(formatRupiah(s.fee))}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="form-section-title">Penyesuaian dari PSD (seluruh gaji guru bulan ini)</div>
    <ul class="legacy-list">${adjustments.map((a) => `<li>${esc(formatRupiah(a.amount))} — ${esc(a.reason)}</li>`).join("") || "<li>Tidak ada.</li>"}</ul>
    <p class="payroll-total">Total fee program ini: <strong>${esc(formatRupiah(row.total_fee))}</strong></p>`;
}

$("#pj-payroll-month").addEventListener("change", loadPjPayroll);
$("#pj-payroll-table").addEventListener("click", (e) => {
  const acc = e.target.closest("[data-pj-acc]");
  if (acc) { accPjPayroll(acc.dataset.pjAcc, acc.dataset.program); return; }
  const detail = e.target.closest("[data-pj-payroll-detail]");
  if (detail) openPjPayrollDetail(detail.dataset.pjPayrollDetail, detail.dataset.program);
});
$("#pj-close-payroll").addEventListener("click", () => $("#pj-payroll-dialog").close());
$("#pj-close-payroll-bottom").addEventListener("click", () => $("#pj-payroll-dialog").close());

supabase.auth.onAuthStateChange((_event,session)=>{  updateTopbarAuth(!!session?.user);if(!session){view("#pj-login");$("#pj-sign-out").classList.add("hidden");}});
(async()=>{if(SUPABASE_URL.includes("YOUR_PROJECT")||SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE")){view("#pj-login");$("#pj-login-message").textContent="Isi konfigurasi Supabase di js/config.js terlebih dahulu.";return;}try{await boot();}catch(e){view("#pj-login");$("#pj-login-message").textContent=err(e);}})();
