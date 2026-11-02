// Angka pengingat di menu: berapa pekerjaan yang masih menunggu PJ atau PSD.
// Hanya membaca data yang sudah dipakai halaman (payroll_overview dan tabel attendance), tanpa SQL baru.
import { previousMonthValue, monthToPeriod } from "./attendance-utils.js";

// Pasang atau perbarui angka di sebuah tombol. kind "action" = perlu tindakanmu (merah), "info" = menunggu orang lain (abu).
// Angka 0 menghapus lencananya.
export function setBadge(button, count, { kind = "action", title = "" } = {}) {
  if (!button) return;
  let badge = button.querySelector(`.nav-badge[data-kind="${kind}"]`);
  if (!count) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = `nav-badge nav-badge-${kind}`;
    badge.dataset.kind = kind;
    button.appendChild(badge);
  }
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.title = `${count} ${title}`.trim();
}

// Rekap gaji yang dihitung adalah bulan lalu (pilihan bawaan di menu Rekap Gaji).
export const reminderPeriod = () => monthToPeriod(previousMonthValue());

// Sesi yang sudah selesai dan menunggu dicek. programIds = batasi ke program tertentu (PJ).
export async function pendingSessions(supabase, programIds = null) {
  let query = supabase.from("attendance").select("id, teacher_id, program_id")
    .eq("review_status", "pending").not("clock_out_at", "is", null);
  if (programIds) query = query.in("program_id", programIds);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// PSD: guru yang rekapnya menunggu persetujuan PSD, dan guru yang masih menunggu ACC PJ.
// Aturannya sama dengan status di tabel Rekap Gaji.
export function psdPayrollCounts(rows) {
  const byTeacher = new Map();
  rows.forEach((r) => { if (!byTeacher.has(r.teacher_id)) byTeacher.set(r.teacher_id, []); byTeacher.get(r.teacher_id).push(r); });
  let waitingPsd = 0, waitingPj = 0;
  for (const list of byTeacher.values()) {
    if (list.every((r) => r.paid_at) || list.every((r) => r.psd_approved_at)) continue;
    if (list.some((r) => !r.pj_acc_at)) waitingPj += 1; else waitingPsd += 1;
  }
  return { waitingPsd, waitingPj };
}

// PJ: rekap yang perlu ACC (bulan selesai, semua sesi disetujui) atau dikembalikan PSD.
export function pjPayrollCount(rows) {
  return rows.filter((r) => !r.pj_acc_at && !r.psd_approved_at && !r.is_own && (!r.not_ready_count || r.return_note)).length;
}
