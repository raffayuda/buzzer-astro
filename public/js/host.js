/**
 * Client Script Sisi Host / Juri
 * Menangani kontrol bel pertandingan, shortcut keyboard, soundboard, dan render live queue via Socket.IO
 */

let socket = null;
let hostState = {
  status: 'LOCKED',
  buzzList: [],
  settings: {
    mode: 'all',
    timerSeconds: 5
  }
};

// DOM Elements
const statusPill = document.getElementById('status-pill');
const statusLabel = document.getElementById('status-label');
const btnUnlock = document.getElementById('btn-unlock');
const btnReset = document.getElementById('btn-reset');
const btnLock = document.getElementById('btn-lock');

const sfxLie = document.getElementById('sfx-lie');
const sfxTruth = document.getElementById('sfx-truth');
const btnTimer = document.getElementById('btn-timer');
const timerDisplayBtn = document.getElementById('timer-display-btn');

const buzzListEl = document.getElementById('buzz-list');
const queueCountEl = document.getElementById('queue-count');
const emptyQueueEl = document.getElementById('empty-queue');

const qrImg = document.getElementById('qr-img');
const joinLink = document.getElementById('join-link');
const settingMode = document.getElementById('setting-mode');
const settingTimer = document.getElementById('setting-timer');
const volumeSlider = document.getElementById('volume-slider');

// 1. Inisialisasi Koneksi Socket.IO
function initSocket() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => {
    fetchInfo();
  });

  socket.on('disconnect', () => {
    if (statusPill && statusLabel) {
      statusPill.className = 'badge-pill status-locked';
      statusLabel.textContent = 'TERPUTUS';
    }
  });

  socket.on('connect_error', () => {
    if (statusPill && statusLabel) {
      statusPill.className = 'badge-pill status-locked';
      statusLabel.textContent = 'MENGHUBUNGKAN...';
    }
  });

  // Menerima siaran event real-time dari server
  socket.on('buzzer:event', (event) => {
    handleHostEvent(event);
  });
}

// 2. Ambil Info Server (IP, QR Code, dan State Awal)
async function fetchInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.qrCodeDataUrl && qrImg) {
      qrImg.src = data.qrCodeDataUrl;
    }
    if (data.joinUrl && joinLink) {
      joinLink.href = data.joinUrl;
      joinLink.textContent = data.joinUrl;
    }
    if (data.state) {
      hostState = data.state;
      renderState();
    }
  } catch (err) {
    console.error('Gagal mengambil info server:', err);
  }
}

// 3. Tangani Event Real-time
function handleHostEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'STATE_UPDATE':
      if (hostTimerInterval) {
        clearInterval(hostTimerInterval);
        hostTimerInterval = null;
        if (btnTimer) {
          btnTimer.style.borderColor = '';
          btnTimer.style.color = '';
        }
        const defaultSec = hostState.settings?.timerSeconds || 5;
        if (timerDisplayBtn) timerDisplayBtn.textContent = `${defaultSec}s`;
      }
      hostState = event.state;
      renderState();
      break;

    case 'BUZZ':
      hostState.buzzList = event.buzzList;
      hostState.status = event.status;
      renderState();
      // Mainkan suara buzzer saat peserta memencet bel pertama
      if (event.buzz && event.buzz.rank === 1) {
        window.soundEngine.playBuzzer();
      }
      break;

    case 'PLAY_SOUND':
      if (event.sound === 'truth' || event.sound === 'correct') {
        window.soundEngine.playTruth();
      } else if (event.sound === 'lie' || event.sound === 'wrong') {
        window.soundEngine.playLie();
      }
      break;

    case 'TIMER_START':
      handleHostTimer(event.seconds || 5);
      break;

    case 'SETTINGS_UPDATE':
      hostState.settings = event.settings;
      if (settingMode) settingMode.value = hostState.settings.mode;
      if (settingTimer) settingTimer.value = hostState.settings.timerSeconds;
      if (timerDisplayBtn) timerDisplayBtn.textContent = `${hostState.settings.timerSeconds}s`;
      break;
  }
}

// 4. Render State ke UI Host
function renderState() {
  if (!statusPill || !statusLabel) return;

  const status = hostState.status;
  if (status === 'ACTIVE') {
    statusPill.className = 'badge-pill status-active';
    statusLabel.textContent = 'BEL DIBUKA (SIAP REBUTAN)';
  } else if (status === 'LOCKED') {
    statusPill.className = 'badge-pill status-locked';
    statusLabel.textContent = 'BEL TERKUNCI';
  } else if (status === 'BUZZED') {
    statusPill.className = 'badge-pill status-buzzed';
    statusLabel.textContent = 'BEL SUDAH DITEKAN';
  }

  // Render Nomor Ronde
  const currentRound = hostState.round || 1;
  const hostRoundNum = document.getElementById('host-round-number');
  const settingRoundDisplay = document.getElementById('setting-round-display');
  if (hostRoundNum) hostRoundNum.textContent = currentRound;
  if (settingRoundDisplay) settingRoundDisplay.textContent = currentRound;

  // Render Antrean Buzz
  renderBuzzList(hostState.buzzList);
}

function renderBuzzList(list) {
  if (!buzzListEl) return;

  if (!list || list.length === 0) {
    buzzListEl.innerHTML = `
      <div id="empty-queue" style="text-align: center; padding: 3rem 1rem; color: var(--text-dim); font-size: 0.95rem;">
        Belum ada bel yang ditekan.<br>Klik <strong style="color: var(--astro-blue);">"Buka Bel (Start)"</strong> agar peserta dapat berebut menjawab.
      </div>
    `;
    if (queueCountEl) queueCountEl.textContent = '0 Peserta';
    return;
  }

  if (queueCountEl) queueCountEl.textContent = `${list.length} Peserta`;
  buzzListEl.innerHTML = '';

  list.forEach(item => {
    const isFirst = item.rank === 1;
    const deltaText = isFirst ? 'Pemenang Bel (0 ms)' : `+${(item.deltaMs / 1000).toFixed(3)}s (+${item.deltaMs} ms)`;

    const div = document.createElement('div');
    div.className = `buzz-item ${isFirst ? 'rank-1' : ''}`;
    div.innerHTML = `
      <div class="buzz-rank-badge">#${item.rank}</div>
      <div class="buzz-user-info">
        <span class="participant-indicator team-indicator" style="background: ${item.color}; color: ${item.color};"></span>
        <span class="buzz-user-name">${escapeHtml(item.name)}</span>
      </div>
      <div class="buzz-delta-time">${deltaText}</div>
    `;
    buzzListEl.appendChild(div);
  });
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// Toast notification helper untuk konfirmasi aksi host
function showHostToast(text, color = 'var(--astro-blue)') {
  let toast = document.getElementById('host-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'host-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '2rem';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    toast.style.padding = '0.75rem 1.75rem';
    toast.style.borderRadius = 'var(--radius-full)';
    toast.style.fontFamily = 'var(--font-heading)';
    toast.style.fontSize = '0.92rem';
    toast.style.fontWeight = '700';
    toast.style.color = '#ffffff';
    toast.style.boxShadow = 'var(--shadow-gloss), 0 8px 24px rgba(30, 58, 138, 0.25)';
    toast.style.zIndex = '9999';
    toast.style.opacity = '0';
    toast.style.transition = 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
    toast.style.pointerEvents = 'none';
    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.background = color;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 1800);
}

// 5. Eksekusi Kontrol Host
async function sendControl(action, payload = {}) {
  window.soundEngine.init();

  // Feedback toast langsung
  if (action === 'reset') {
    showHostToast('Antrean Bel Dikosongkan (Reset)', 'linear-gradient(135deg, #f59e0b, #d97706)');
  } else if (action === 'unlock') {
    showHostToast('Bel Dibuka (Siap Berebut)', 'linear-gradient(135deg, #10b981, #059669)');
  } else if (action === 'lock') {
    showHostToast('Bel Terkunci', 'linear-gradient(135deg, #f43f5e, #e11d48)');
  } else if (action === 'sound') {
    if (payload.sound === 'truth') showHostToast('Suara TRUTH (Benar) Diputar', '#059669');
    else if (payload.sound === 'lie') showHostToast('Suara LIE (Salah) Diputar', '#e11d48');
  } else if (action === 'timer') {
    showHostToast(`Timer ${(payload && payload.seconds) || 5}s Dimulai`, '#3b82f6');
  }

  if (socket && socket.connected) {
    socket.emit('CONTROL', { action, payload }, (res) => {
      if (res && res.state) {
        hostState = res.state;
        renderState();
      }
    });
    return;
  }

  // Fallback REST API jika socket belum terhubung
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload })
    });
    const data = await res.json();
    if (data.state) {
      hostState = data.state;
      renderState();
    }
  } catch (err) {
    console.error('Gagal mengirim perintah host:', err);
    showHostToast('Gagal menghubungi server!', '#e11d48');
  }
}

// 6. Action Button Listeners
if (btnUnlock) {
  btnUnlock.addEventListener('click', () => {
    triggerBtnVisual(btnUnlock);
    sendControl('unlock');
  });
}

if (btnReset) {
  btnReset.addEventListener('click', () => {
    triggerBtnVisual(btnReset);
    sendControl('reset');
  });
}

if (btnLock) {
  btnLock.addEventListener('click', () => {
    triggerBtnVisual(btnLock);
    sendControl('lock');
  });
}

// Soundboard Listeners
if (sfxLie) {
  sfxLie.addEventListener('click', () => {
    triggerBtnVisual(sfxLie);
    sendControl('sound', { sound: 'lie' });
  });
}

if (sfxTruth) {
  sfxTruth.addEventListener('click', () => {
    triggerBtnVisual(sfxTruth);
    sendControl('sound', { sound: 'truth' });
  });
}

if (btnTimer) {
  btnTimer.addEventListener('click', () => {
    triggerBtnVisual(btnTimer);
    const sec = parseInt(settingTimer?.value) || 5;
    sendControl('timer', { seconds: sec });
  });
}

// Settings Listeners
if (settingMode) {
  settingMode.addEventListener('change', () => {
    sendControl('settings', { mode: settingMode.value });
  });
}

if (settingTimer) {
  settingTimer.addEventListener('change', () => {
    const sec = parseInt(settingTimer.value);
    if (timerDisplayBtn) timerDisplayBtn.textContent = `${sec}s`;
    sendControl('settings', { timerSeconds: sec });
  });
}

if (volumeSlider) {
  volumeSlider.addEventListener('input', (e) => {
    window.soundEngine.setVolume(parseFloat(e.target.value));
  });
}

// Helper feedback visual saat tombol keyboard ditekan
function triggerBtnVisual(btn) {
  if (!btn) return;
  btn.style.transform = 'translateY(2px) scale(0.97)';
  btn.style.boxShadow = 'inset 0 2px 4px rgba(0, 0, 0, 0.2)';
  setTimeout(() => {
    btn.style.transform = '';
    btn.style.boxShadow = '';
  }, 120);
}

// 7. Shortcut Keyboard Global untuk Juri / Host
window.addEventListener('keydown', (e) => {
  // Cegah shortcut jika pengguna sedang fokus pada form input, select, atau textarea
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

  if (e.code === 'Space') {
    e.preventDefault();
    triggerBtnVisual(btnUnlock);
    sendControl('unlock');
  } else if (e.code === 'Enter') {
    e.preventDefault();
    triggerBtnVisual(btnReset);
    sendControl('reset');
  } else if (e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    triggerBtnVisual(btnLock);
    sendControl('lock');
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    triggerBtnVisual(sfxLie);
    sendControl('sound', { sound: 'lie' });
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    triggerBtnVisual(sfxTruth);
    sendControl('sound', { sound: 'truth' });
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    triggerBtnVisual(btnTimer);
    const sec = parseInt(settingTimer?.value) || 5;
    sendControl('timer', { seconds: sec });
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    sendControl('reset-round');
    showToast('Ronde di-reset ke 1', 'var(--astro-blue)');
  }
});

// Listener Kontrol Ronde
const btnResetRound = document.getElementById('btn-reset-round');
const btnQuickResetRound = document.getElementById('btn-quick-reset-round');
const btnRoundInc = document.getElementById('btn-round-inc');
const btnRoundDec = document.getElementById('btn-round-dec');

if (btnResetRound) {
  btnResetRound.addEventListener('click', () => {
    sendControl('reset-round');
    showToast('Ronde di-reset ke 1', 'var(--astro-blue)');
  });
}

if (btnQuickResetRound) {
  btnQuickResetRound.addEventListener('click', () => {
    sendControl('reset-round');
    showToast('Ronde di-reset ke 1', 'var(--astro-blue)');
  });
}

if (btnRoundInc) {
  btnRoundInc.addEventListener('click', () => {
    const nextRound = (hostState.round || 1) + 1;
    sendControl('set-round', { round: nextRound });
  });
}

if (btnRoundDec) {
  btnRoundDec.addEventListener('click', () => {
    const prevRound = Math.max(1, (hostState.round || 1) - 1);
    sendControl('set-round', { round: prevRound });
  });
}

// Helper Countdown Timer di Sisi Host
let hostTimerInterval = null;
function handleHostTimer(seconds) {
  if (hostTimerInterval) clearInterval(hostTimerInterval);
  let remaining = seconds;
  if (btnTimer) {
    btnTimer.style.borderColor = 'var(--astro-yellow)';
    btnTimer.style.color = '#b45309';
  }
  if (timerDisplayBtn) timerDisplayBtn.textContent = `${remaining}s`;

  hostTimerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      if (timerDisplayBtn) timerDisplayBtn.textContent = `${remaining}s`;
    } else {
      clearInterval(hostTimerInterval);
      hostTimerInterval = null;
      if (btnTimer) {
        btnTimer.style.borderColor = '';
        btnTimer.style.color = '';
      }
      const defaultSec = hostState.settings?.timerSeconds || 5;
      if (timerDisplayBtn) timerDisplayBtn.textContent = `${defaultSec}s`;
    }
  }, 1000);
}

// Inisialisasi - Langsung panggil initSocket jika DOM sudah siap
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initSocket);
} else {
  initSocket();
}
