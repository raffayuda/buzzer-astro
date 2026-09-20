/**
 * Client Script Sisi Host / Juri
 * Menangani kontrol bel pertandingan, shortcut keyboard, soundboard, dan render live queue
 */

let centrifuge = null;
let currentSubscription = null;
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
const sfxCorrect = document.getElementById('sfx-correct') || sfxTruth;
const sfxWrong = document.getElementById('sfx-wrong') || sfxLie;
const sfxBuzzer = document.getElementById('sfx-buzzer');
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

// 1. Inisialisasi Koneksi Centrifugo (Mendukung Cloudflare Tunnel HTTPS/WSS dan Lokal)
async function initCentrifugo() {
  let wsUrl = '';
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.qrCodeDataUrl) qrImg.src = data.qrCodeDataUrl;
    if (data.joinUrl) {
      joinLink.href = data.joinUrl;
      joinLink.textContent = data.joinUrl;
    }
    if (data.state) {
      hostState = data.state;
      renderState();
    }
    if (data.centrifugoWsUrl) {
      wsUrl = data.centrifugoWsUrl;
    }
  } catch (err) {
    console.error('Gagal mengambil info server:', err);
  }

  if (!wsUrl) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${protocol}//${window.location.host}/connection/websocket`;
  }

  centrifuge = new Centrifuge(wsUrl);

  centrifuge.on('connected', () => {
    fetchInfo();
  });

  currentSubscription = centrifuge.newSubscription('buzzer:events');
  currentSubscription.on('publication', (ctx) => {
    handleHostEvent(ctx.data);
  });

  currentSubscription.subscribe();
  centrifuge.connect();
}

// 2. Ambil Info Server (IP, QR Code, dan State Awal)
async function fetchInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.qrCodeDataUrl) {
      qrImg.src = data.qrCodeDataUrl;
    }
    if (data.joinUrl) {
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
      hostState = event.state;
      renderState();
      if (event.soundTrigger === 'unlock') window.soundEngine.playUnlock();
      else if (event.soundTrigger === 'reset') window.soundEngine.playReset();
      break;

    case 'BUZZ':
      hostState.buzzList = event.buzzList;
      hostState.status = event.status;
      renderState();
      // Mainkan suara truth saat peserta memencet bel pertama
      if (event.buzz.rank === 1) {
        window.soundEngine.playTruth();
      }
      break;

    case 'PLAY_SOUND':
      if (event.sound === 'truth' || event.sound === 'correct') window.soundEngine.playTruth();
      else if (event.sound === 'lie' || event.sound === 'wrong') window.soundEngine.playLie();
      else if (event.sound === 'buzzer') window.soundEngine.playBuzzer();
      break;

    case 'SETTINGS_UPDATE':
      hostState.settings = event.settings;
      settingMode.value = hostState.settings.mode;
      settingTimer.value = hostState.settings.timerSeconds;
      timerDisplayBtn.textContent = `${hostState.settings.timerSeconds}s`;
      break;
  }
}

// 4. Render State ke UI Host
function renderState() {
  // Status Pill
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

  // Render Antrean Buzz
  renderBuzzList(hostState.buzzList);
}

function renderBuzzList(list) {
  if (!list || list.length === 0) {
    buzzListEl.innerHTML = `
      <div id="empty-queue" style="text-align: center; padding: 3rem 1rem; color: var(--text-dim);">
        Belum ada bel yang ditekan.<br>Klik <strong>"Buka Bel"</strong> agar peserta dapat berebut.
      </div>
    `;
    queueCountEl.textContent = '0 Peserta';
    return;
  }

  queueCountEl.textContent = `${list.length} Peserta`;
  buzzListEl.innerHTML = '';

  list.forEach(item => {
    const isFirst = item.rank === 1;
    const deltaText = isFirst ? 'Pemenang Bel (0 ms)' : `+${(item.deltaMs / 1000).toFixed(3)}s (+${item.deltaMs} ms)`;

    const div = document.createElement('div');
    div.className = `buzz-item ${isFirst ? 'rank-1' : ''}`;
    div.innerHTML = `
      <div class="buzz-rank-badge">#${item.rank}</div>
      <div class="buzz-user-info">
        <span class="team-indicator" style="background: ${item.color}; color: ${item.color};"></span>
        <span class="buzz-user-name">${escapeHtml(item.name)}</span>
      </div>
      <div class="buzz-delta-time">${deltaText}</div>
    `;
    buzzListEl.appendChild(div);
  });
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// 5. Eksekusi Kontrol Host API
async function sendControl(action, payload = {}) {
  window.soundEngine.init();
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
  }
}

// 6. Action Button Listeners
btnUnlock.addEventListener('click', () => sendControl('unlock'));
btnReset.addEventListener('click', () => sendControl('reset'));
btnLock.addEventListener('click', () => sendControl('lock'));

// Soundboard Listeners
if (sfxLie) {
  sfxLie.addEventListener('click', () => {
    window.soundEngine.playLie();
    sendControl('sound', { sound: 'lie' });
  });
}

if (sfxTruth) {
  sfxTruth.addEventListener('click', () => {
    window.soundEngine.playTruth();
    sendControl('sound', { sound: 'truth' });
  });
}

if (sfxCorrect && sfxCorrect !== sfxTruth) {
  sfxCorrect.addEventListener('click', () => {
    window.soundEngine.playTruth();
    sendControl('sound', { sound: 'truth' });
  });
}

if (sfxWrong && sfxWrong !== sfxLie) {
  sfxWrong.addEventListener('click', () => {
    window.soundEngine.playLie();
    sendControl('sound', { sound: 'lie' });
  });
}

sfxBuzzer.addEventListener('click', () => {
  window.soundEngine.playBuzzer();
  sendControl('sound', { sound: 'buzzer' });
});

btnTimer.addEventListener('click', () => {
  const sec = parseInt(settingTimer.value) || 5;
  sendControl('timer', { seconds: sec });
});

// Settings Listeners
settingMode.addEventListener('change', () => {
  sendControl('settings', { mode: settingMode.value });
});

settingTimer.addEventListener('change', () => {
  const sec = parseInt(settingTimer.value);
  timerDisplayBtn.textContent = `${sec}s`;
  sendControl('settings', { timerSeconds: sec });
});

volumeSlider.addEventListener('input', (e) => {
  window.soundEngine.setVolume(parseFloat(e.target.value));
});

// 7. Shortcut Keyboard Global untuk Juri / Host
window.addEventListener('keydown', (e) => {
  // Cegah shortcut jika pengguna sedang mengetik di input/select
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

  if (e.code === 'Space') {
    e.preventDefault();
    sendControl('unlock');
  } else if (e.code === 'Enter') {
    e.preventDefault();
    sendControl('reset');
  } else if (e.code === 'Escape') {
    e.preventDefault();
    sendControl('lock');
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    window.soundEngine.playLie();
    sendControl('sound', { sound: 'lie' });
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    window.soundEngine.playTruth();
    sendControl('sound', { sound: 'truth' });
  } else if (e.key === 'b' || e.key === 'B') {
    e.preventDefault();
    window.soundEngine.playTruth();
    sendControl('sound', { sound: 'truth' });
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    window.soundEngine.playLie();
    sendControl('sound', { sound: 'lie' });
  }
});

// Inisialisasi
window.addEventListener('DOMContentLoaded', () => {
  initCentrifugo();
});
