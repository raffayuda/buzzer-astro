/**
 * Client Script Sisi Host / Juri
 * Menangani kontrol bel pertandingan, shortcut keyboard, soundboard, dan render live queue via Socket.IO
 */

let socket = null;
let hostState = {
  status: 'LOCKED',
  buzzList: [],
  teams: [],
  settings: {
    mode: 'all',
    timerSeconds: 5,
    showScoreboard: true,
    pointsCorrect: 10,
    pointsWrong: -5
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
  socket = io({ auth: { token: window.hostAuth.getToken() } });

  // Status akses juri dikirim server setiap (re)connect
  socket.on('auth:status', ({ isHost } = {}) => {
    if (isHost) {
      hideLoginOverlay();
    } else {
      window.hostAuth.clearToken();
      socket.auth = {};
      showLoginOverlay();
    }
  });

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
    const urlParams = new URLSearchParams(window.location.search);
    const publicUrl = urlParams.get('public_url') || (window.location.hostname.includes('oktaa.my.id') ? 'https://astro.nurulfikri.ac.id/buzzer' : '');
    const apiUrl = publicUrl ? `/api/info?public_url=${encodeURIComponent(publicUrl)}` : '/api/info';
    const res = await fetch(apiUrl);
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
      renderScoreSettings();
      renderBuzzList(hostState.buzzList);
      break;

    case 'SCORE_UPDATE':
      hostState.teams = event.teams || [];
      if (event.buzzList) {
        hostState.buzzList = event.buzzList;
        renderBuzzList(hostState.buzzList);
      }
      renderTeamList();
      break;

    case 'JUDGE':
      hostState.teams = event.teams || [];
      hostState.buzzList = event.buzzList || [];
      renderBuzzList(hostState.buzzList);
      renderTeamList();
      if (event.sound === 'truth') window.soundEngine.playTruth();
      else if (event.sound === 'lie') window.soundEngine.playLie();
      if (event.buzz) {
        if (event.result === 'undo') {
          showHostToast(`Penilaian ${event.buzz.name} dibatalkan`, '#64748b');
        } else {
          const label = event.result === 'correct' ? 'BENAR' : 'SALAH';
          showHostToast(`${event.buzz.name}: ${label} ${formatDelta(event.points)} poin`, event.result === 'correct' ? '#059669' : '#e11d48');
        }
      }
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

  // Render Papan Skor
  renderScoreSettings();
  renderTeamList();
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
    const pc = Number(hostState.settings?.pointsCorrect ?? 10);
    const pw = Number(hostState.settings?.pointsWrong ?? -5);
    if (item.judged) div.classList.add(item.judged === 'correct' ? 'is-judged-correct' : 'is-judged-wrong');

    const actions = item.judged
      ? `<span class="judge-badge ${item.judged === 'correct' ? 'is-up' : 'is-down'}">
           ${item.judged === 'correct' ? '✓ BENAR' : '✗ SALAH'} ${formatDelta(item.judgedDelta)}
         </span>
         <button type="button" class="btn-quick-score is-muted" data-result="${item.judged === 'correct' ? 'wrong' : 'correct'}" title="Koreksi penilaian">Ubah</button>
         <button type="button" class="btn-quick-score is-muted" data-result="undo" title="Batalkan penilaian & kembalikan poin">Batal</button>`
      : `<button type="button" class="btn-quick-score is-up" data-result="correct" title="Jawaban benar">Benar ${formatDelta(pc)}</button>
         <button type="button" class="btn-quick-score is-down" data-result="wrong" title="Jawaban salah">Salah ${formatDelta(pw)}</button>`;

    div.innerHTML = `
      <div class="buzz-rank-badge">#${item.rank}</div>
      <div class="buzz-user-info">
        <span class="participant-indicator team-indicator" style="background: ${escapeHtml(item.color)}; color: ${escapeHtml(item.color)};"></span>
        <span class="buzz-user-name">${escapeHtml(item.name)}</span>
      </div>
      <div class="buzz-delta-time">${deltaText}</div>
      <div class="buzz-score-actions">${actions}</div>
    `;
    div.querySelectorAll('.btn-quick-score').forEach(btn => {
      btn.addEventListener('click', () => {
        sendControl('judge', { rank: item.rank, result: btn.dataset.result });
      });
    });
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
const SUCCESS_TOASTS = {
  reset: ['Antrean Bel Dikosongkan (Reset)', 'linear-gradient(135deg, #f59e0b, #d97706)'],
  unlock: ['Bel Dibuka (Siap Berebut)', 'linear-gradient(135deg, #10b981, #059669)'],
  lock: ['Bel Terkunci', 'linear-gradient(135deg, #f43f5e, #e11d48)']
};

function handleControlResponse(action, payload, res) {
  if (!res) return;
  if (res.success === false) {
    if (res.code === 'UNAUTHORIZED') {
      window.hostAuth.clearToken();
      showLoginOverlay(res.error);
    } else if (res.error) {
      showHostToast(res.error, '#e11d48');
    }
    return;
  }

  // Toast hanya setelah server mengonfirmasi aksi berhasil
  if (SUCCESS_TOASTS[action]) {
    showHostToast(...SUCCESS_TOASTS[action]);
  } else if (action === 'timer') {
    showHostToast(`Timer ${(payload && payload.seconds) || 5}s Dimulai`, '#3b82f6');
  } else if (action === 'judge' && res.soundOnly) {
    showHostToast('Antrean kosong / sudah dinilai semua — hanya efek suara', '#64748b');
  }

  if (res.state) {
    hostState = res.state;
    renderState();
  }
}

async function sendControl(action, payload = {}) {
  window.soundEngine.init();

  if (socket && socket.connected) {
    socket.emit('CONTROL', { action, payload }, (res) => handleControlResponse(action, payload, res));
    return;
  }

  // Fallback REST API jika socket belum terhubung
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-token': window.hostAuth.getToken() },
      body: JSON.stringify({ action, payload })
    });
    handleControlResponse(action, payload, await res.json());
  } catch (err) {
    console.error('Gagal mengirim perintah host:', err);
    showHostToast('Gagal menghubungi server!', '#e11d48');
  }
}

// 5b. Overlay Login PIN Juri
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginPin = document.getElementById('login-pin');
const loginError = document.getElementById('login-error');
const loginSubmit = document.getElementById('login-submit');

function isLoginOverlayOpen() {
  return Boolean(loginOverlay && loginOverlay.style.display !== 'none');
}

function showLoginOverlay(message = '') {
  if (!loginOverlay) return;
  loginOverlay.style.display = 'flex';
  if (loginError) loginError.textContent = message;
  setTimeout(() => loginPin && loginPin.focus(), 50);
}

function hideLoginOverlay() {
  if (!loginOverlay) return;
  loginOverlay.style.display = 'none';
  if (loginError) loginError.textContent = '';
  if (loginPin) loginPin.value = '';
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = loginPin.value.trim();
    if (!pin) return;
    loginSubmit.disabled = true;
    const res = await window.hostAuth.login(socket, pin);
    loginSubmit.disabled = false;
    if (res.success) {
      hideLoginOverlay();
      showHostToast('Login juri berhasil', '#059669');
      fetchInfo();
    } else {
      loginError.textContent = res.error || 'PIN salah';
      loginPin.select();
    }
  });
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
    sendControl('judge', { result: 'wrong' });
  });
}

if (sfxTruth) {
  sfxTruth.addEventListener('click', () => {
    triggerBtnVisual(sfxTruth);
    sendControl('judge', { result: 'correct' });
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
  if (isLoginOverlayOpen()) return;

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
    sendControl('judge', { result: 'wrong' });
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    triggerBtnVisual(sfxTruth);
    sendControl('judge', { result: 'correct' });
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    triggerBtnVisual(btnTimer);
    const sec = parseInt(settingTimer?.value) || 5;
    sendControl('timer', { seconds: sec });
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    sendControl('reset-round');
    showHostToast('Ronde di-reset ke 1', 'var(--astro-blue)');
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
    showHostToast('Ronde di-reset ke 1', 'var(--astro-blue)');
  });
}

if (btnQuickResetRound) {
  btnQuickResetRound.addEventListener('click', () => {
    sendControl('reset-round');
    showHostToast('Ronde di-reset ke 1', 'var(--astro-blue)');
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

// 8. Panel Papan Skor Peserta
const teamListEl = document.getElementById('team-list');
const teamAddForm = document.getElementById('team-add-form');
const teamNameInput = document.getElementById('team-name');
const teamColorInput = document.getElementById('team-color');
const settingShowScoreboard = document.getElementById('setting-show-scoreboard');
const settingPointsCorrect = document.getElementById('setting-points-correct');
const settingPointsWrong = document.getElementById('setting-points-wrong');
const btnScoreReset = document.getElementById('btn-score-reset');
const btnTeamsClear = document.getElementById('btn-teams-clear');

const TEAM_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

function formatDelta(delta) {
  const n = Number(delta) || 0;
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;
}

function renderScoreSettings() {
  const s = hostState.settings || {};
  const truthPoints = document.getElementById('sfx-truth-points');
  const liePoints = document.getElementById('sfx-lie-points');
  if (truthPoints) truthPoints.textContent = formatDelta(s.pointsCorrect ?? 10);
  if (liePoints) liePoints.textContent = formatDelta(s.pointsWrong ?? -5);
  if (settingShowScoreboard) settingShowScoreboard.checked = s.showScoreboard !== false;
  if (settingPointsCorrect && document.activeElement !== settingPointsCorrect) {
    settingPointsCorrect.value = s.pointsCorrect ?? 10;
  }
  if (settingPointsWrong && document.activeElement !== settingPointsWrong) {
    settingPointsWrong.value = s.pointsWrong ?? -5;
  }
}

function renderTeamList() {
  if (!teamListEl) return;
  const teams = hostState.teams || [];

  // Saran warna berikutnya untuk tim baru
  if (teamColorInput && document.activeElement !== teamColorInput && !teamColorInput.dataset.touched) {
    teamColorInput.value = TEAM_COLORS[teams.length % TEAM_COLORS.length];
  }

  if (teams.length === 0) {
    teamListEl.innerHTML = `
      <div class="team-list-empty">
        Belum ada tim. Tambahkan tim di atas, atau klik tombol <strong>Benar</strong> / <strong>Salah</strong>
        pada antrean bel — tim akan dibuat otomatis dari nama peserta yang memencet bel.
      </div>
    `;
    return;
  }

  // Jangan render ulang saat operator sedang mengetik skor manual
  const focusedId = document.activeElement?.closest?.('.team-row')?.dataset.id;
  const focusedValue = document.activeElement?.classList?.contains('team-custom-input') ? document.activeElement.value : null;

  teamListEl.innerHTML = '';
  teams.forEach((team, index) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.dataset.id = team.id;
    row.innerHTML = `
      <div class="team-order">
        <button type="button" class="team-move" data-dir="up" title="Pindah ke atas" ${index === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="team-move" data-dir="down" title="Pindah ke bawah" ${index === teams.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <span class="team-dot" style="background: ${escapeHtml(team.color)};"></span>
      <span class="team-name" title="${escapeHtml(team.name)}">${escapeHtml(team.name)}</span>
      <span class="team-score">${team.score}</span>
      <div class="team-quick">
        <button type="button" class="btn-delta is-down" data-delta="-10">−10</button>
        <button type="button" class="btn-delta is-down" data-delta="-5">−5</button>
        <button type="button" class="btn-delta is-up" data-delta="5">+5</button>
        <button type="button" class="btn-delta is-up" data-delta="10">+10</button>
      </div>
      <form class="team-custom">
        <input type="number" class="form-input team-custom-input" placeholder="±poin" step="1" title="Poin custom (negatif untuk mengurangi)">
        <button type="submit" class="btn-delta">OK</button>
      </form>
      <button type="button" class="team-remove" title="Hapus tim">✕</button>
    `;

    row.querySelectorAll('.btn-delta[data-delta]').forEach(btn => {
      btn.addEventListener('click', () => {
        sendControl('score', { id: team.id, delta: Number(btn.dataset.delta) });
      });
    });

    row.querySelector('.team-custom').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = e.currentTarget.querySelector('input');
      const delta = Number(input.value);
      if (!input.value || !Number.isInteger(delta) || delta === 0) {
        showHostToast('Poin harus bilangan bulat selain 0', '#e11d48');
        return;
      }
      input.value = '';
      input.blur();
      sendControl('score', { id: team.id, delta });
      showHostToast(`${team.name} ${formatDelta(delta)} poin`, delta > 0 ? '#059669' : '#e11d48');
    });

    row.querySelectorAll('.team-move').forEach(btn => {
      btn.addEventListener('click', () => {
        sendControl('team-move', { id: team.id, direction: btn.dataset.dir });
      });
    });

    row.querySelector('.team-remove').addEventListener('click', () => {
      if (!confirm(`Hapus tim "${team.name}" beserta skornya (${team.score})?`)) return;
      sendControl('team-remove', { id: team.id });
    });

    teamListEl.appendChild(row);

    if (focusedId === team.id && focusedValue !== null) {
      const input = row.querySelector('.team-custom-input');
      input.value = focusedValue;
      input.focus();
    }
  });
}

if (teamAddForm) {
  teamAddForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = teamNameInput.value.trim();
    if (!name) return;
    sendControl('team-add', { name, color: teamColorInput.value });
    teamNameInput.value = '';
    delete teamColorInput.dataset.touched;
    teamNameInput.focus();
  });
}

if (teamColorInput) {
  teamColorInput.addEventListener('input', () => {
    teamColorInput.dataset.touched = '1';
  });
}

if (settingShowScoreboard) {
  settingShowScoreboard.addEventListener('change', () => {
    sendControl('settings', { showScoreboard: settingShowScoreboard.checked });
  });
}

[[settingPointsCorrect, 'pointsCorrect'], [settingPointsWrong, 'pointsWrong']].forEach(([input, key]) => {
  if (!input) return;
  input.addEventListener('change', () => {
    const value = Number(input.value);
    const signOk = key === 'pointsCorrect' ? value >= 0 : value <= 0;
    if (input.value === '' || !Number.isInteger(value) || !signOk || Math.abs(value) > 10000) {
      showHostToast(
        key === 'pointsCorrect'
          ? 'Poin benar harus bilangan bulat 0 s/d 10000'
          : 'Poin salah harus bilangan bulat 0 s/d -10000 (0 = tanpa pengurangan)',
        '#e11d48'
      );
      renderScoreSettings();
      return;
    }
    sendControl('settings', { [key]: value });
  });
});

if (btnScoreReset) {
  btnScoreReset.addEventListener('click', () => {
    if (!confirm('Nolkan skor SEMUA tim? Daftar tim tetap ada.')) return;
    sendControl('score-reset');
    showHostToast('Semua skor di-nol-kan', '#d97706');
  });
}

if (btnTeamsClear) {
  btnTeamsClear.addEventListener('click', () => {
    if (!confirm('Hapus SEMUA tim beserta skornya? Tindakan ini tidak bisa dibatalkan.')) return;
    sendControl('teams-clear');
    showHostToast('Semua tim dihapus', '#e11d48');
  });
}

// Inisialisasi - Langsung panggil initSocket jika DOM sudah siap
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initSocket);
} else {
  initSocket();
}
