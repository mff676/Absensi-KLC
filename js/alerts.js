// Alert dan konfirmasi memakai SweetAlert2 (dimuat dari CDN di index.html dan pj.html).
// Jika CDN gagal dimuat, otomatis memakai alert/confirm bawaan browser agar aplikasi tetap jalan.

// <dialog> bawaan browser tampil di lapisan paling atas, jadi popup harus dipasang DI DALAM dialog yang sedang terbuka.
function popupTarget() {
  return document.querySelector("dialog[open]") || document.body;
}

const swal = () => window.Swal || null;

// Pesan singkat di pojok kanan atas, hilang sendiri. Untuk keberhasilan.
export function toast(message, icon = "success") {
  const Swal = swal();
  if (!Swal) { window.alert(message); return Promise.resolve(); }
  return Swal.fire({
    toast: true, position: "top-end", icon, title: message, target: popupTarget(),
    showConfirmButton: false, timer: 3500, timerProgressBar: true
  });
}

// Pesan yang harus dibaca dan ditutup pengguna. Untuk error dan peringatan.
export function showAlert(message, { title, icon = "error" } = {}) {
  const Swal = swal();
  if (!Swal) { window.alert(message); return Promise.resolve(); }
  return Swal.fire({
    icon, title: title || (icon === "error" ? "Terjadi kesalahan" : icon === "warning" ? "Perhatian" : "Info"),
    text: message, target: popupTarget(), confirmButtonText: "Mengerti", confirmButtonColor: "#29477F"
  });
}

// Pemberitahuan sesuai jenis: success -> toast, error -> alert yang harus ditutup.
export function notify(message, type = "success") {
  return type === "error" ? showAlert(message) : toast(message, type);
}

// Tanya ya/tidak. Hasil: true jika pengguna menekan tombol konfirmasi.
export async function confirmDialog({ title = "Yakin?", text = "", confirmText = "Ya, lanjutkan", cancelText = "Batal", icon = "question" } = {}) {
  const Swal = swal();
  if (!Swal) return window.confirm(text || title);
  const result = await Swal.fire({
    icon, title, text, target: popupTarget(), showCancelButton: true, reverseButtons: true, focusCancel: true,
    confirmButtonText: confirmText, cancelButtonText: cancelText, confirmButtonColor: "#29477F"
  });
  return result.isConfirmed;
}
