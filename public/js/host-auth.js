/**
 * Helper autentikasi PIN Juri (dipakai panel juri & layar proyektor).
 * PIN hanya dikirim sekali; server membalas token sesi yang disimpan di localStorage
 * agar tidak perlu login ulang setiap reload/reconnect (berlaku sampai server restart).
 */
window.hostAuth = {
  storageKey: 'buzzer_host_token',

  getToken() {
    try {
      return localStorage.getItem(this.storageKey) || '';
    } catch {
      return '';
    }
  },

  saveToken(token) {
    try {
      localStorage.setItem(this.storageKey, token);
    } catch {}
  },

  clearToken() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {}
  },

  /** Kirim PIN ke server via socket. Resolve { success, error }. */
  login(socket, pin) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) {
        resolve({ success: false, error: 'Belum terhubung ke server' });
        return;
      }
      socket.emit('AUTH', { pin }, (res) => {
        if (res && res.success && res.token) {
          this.saveToken(res.token);
          socket.auth = { token: res.token }; // dipakai otomatis saat reconnect
        }
        resolve(res || { success: false, error: 'Tidak ada respons server' });
      });
    });
  }
};
