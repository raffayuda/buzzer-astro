/**
 * Client Script Tampilan Layar Proyektor / TV Panggung
 * Menampilkan animasi pemenang tercepat, runner-up, sound FX panggung, dan QR Code
 */

let centrifuge = null;
let currentSubscription = null;
let projectorState = {
  status: 'LOCKED',
  buzzList: [],
  round: 1
};
let timerInterval = null;

// DOM Elements
const projectorStatus = document.getElementById('projector-status');
const standbyView = document.getElementById('standby-view');
const standbyTitle = document.getElementById('standby-title');
const standbySub = document.getElementById('standby-sub');

const winnerView = document.getElementById('winner-view');
const championName = document.getElementById('champion-name');
const runnersRow = document.getElementById('runners-row');
const runner2 = document.getElementById('runner-2');
const runner2Name = document.getElementById('runner-2-name');
const runner2Delta = document.getElementById('runner-2-delta');
const runner3 = document.getElementById('runner-3');
const runner3Name = document.getElementById('runner-3-name');
const runner3Delta = document.getElementById('runner-3-delta');

const projQrImg = document.getElementById('proj-qr-img');
const projJoinUrl = document.getElementById('proj-join-url');
const roundNumber = document.getElementById('round-number');
const timerBarWrap = document.getElementById('timer-bar-wrap');
const timerBarFill = document.getElementById('timer-bar-fill');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnSoundToggle = document.getElementById('btn-sound-toggle');

// Inisialisasi Audio Context pada klik pertama di proyektor
let soundEnabled = false;
function enableAudio() {
  if (!soundEnabled) {
    window.soundEngine.init();
    soundEnabled = true;
    btnSoundToggle.textContent = 'Audio Aktif';
    btnSoundToggle.style.color = '#86efac';
  }
}
document.addEventListener('click', enableAudio, { once: true });
btnSoundToggle.addEventListener('click', () => {
  enableAudio();
  window.soundEngine.playCorrect();
});

// Fullscreen Toggle
btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    btnFullscreen.textContent = 'Keluar Layar Penuh';
  } else {
    document.exitFullscreen().catch(() => {});
    btnFullscreen.textContent = 'Layar Penuh';
  }
});

// 1. Inisialisasi Centrifugo (Mendukung Cloudflare Tunnel HTTPS/WSS dan Lokal)
async function initCentrifugo() {
  let wsUrl = '';
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.qrCodeDataUrl) projQrImg.src = data.qrCodeDataUrl;
    if (data.joinUrl) projJoinUrl.textContent = data.joinUrl;
    if (data.state) {
      projectorState = data.state;
      renderProjector();
    }
    if (data.centrifugoWsUrl) {
      wsUrl = data.centrifugoWsUrl;
    }
  } catch (err) {
    console.error('Gagal mengambil info:', err);
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
    handleProjectorEvent(ctx.data);
  });

  currentSubscription.subscribe();
  centrifuge.connect();
}

// 2. Ambil Info Server (IP, QR Code, dan State)
async function fetchInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();
    if (data.qrCodeDataUrl) {
      projQrImg.src = data.qrCodeDataUrl;
    }
    if (data.joinUrl) {
      projJoinUrl.textContent = data.joinUrl;
    }
    if (data.state) {
      projectorState = data.state;
      renderProjector();
    }
  } catch (err) {
    console.error('Gagal mengambil info:', err);
  }
}

// 3. Tangani Event Real-Time dari Server
function handleProjectorEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'STATE_UPDATE':
      projectorState = event.state;
      renderProjector();
      if (event.soundTrigger === 'unlock') window.soundEngine.playUnlock();
      else if (event.soundTrigger === 'reset') window.soundEngine.playReset();
      break;

    case 'BUZZ':
      projectorState.buzzList = event.buzzList;
      projectorState.status = event.status;
      renderProjector();
      // Mainkan suara TRUTH untuk pemencet bel pertama
      if (event.buzz.rank === 1) {
        window.soundEngine.playTruth();
      }
      break;

    case 'PLAY_SOUND':
      if (event.sound === 'truth' || event.sound === 'correct') {
        window.soundEngine.playTruth();
        showFeedbackFlash('TRUTH (BENAR)', '#16a34a');
      } else if (event.sound === 'lie' || event.sound === 'wrong') {
        window.soundEngine.playLie();
        showFeedbackFlash('LIE (SALAH)', '#dc2626');
      } else if (event.sound === 'buzzer') {
        window.soundEngine.playBuzzer();
      }
      break;

    case 'TIMER_START':
      startTimer(event.seconds || 5);
      break;
  }
}

// 4. Render Tampilan Proyektor Sesuai State
function renderProjector() {
  const status = projectorState.status;
  const list = projectorState.buzzList || [];
  roundNumber.textContent = projectorState.round || 1;

  if (btnProjStart && btnProjReset) {
    if (status === 'ACTIVE') {
      btnProjStart.style.opacity = '0.7';
      btnProjStart.innerHTML = '<span>BEL TERBUKA</span> <kbd>Spasi</kbd>';
      btnProjReset.style.animation = 'none';
    } else if (status === 'BUZZED') {
      btnProjStart.style.opacity = '1';
      btnProjStart.innerHTML = '<span>BUKA (START)</span> <kbd>Spasi</kbd>';
      btnProjReset.style.animation = 'none';
    } else {
      btnProjStart.style.opacity = '1';
      btnProjStart.innerHTML = '<span>BUKA (START)</span> <kbd>Spasi</kbd>';
      btnProjReset.style.animation = 'none';
    }
  }

  if (status === 'ACTIVE') {
    // Bel Terbuka / Siap Berebut
    projectorStatus.className = 'projector-status-box status-box-active';
    projectorStatus.textContent = 'SIAP / BEREBUT BEL';

    standbyView.style.display = 'flex';
    standbyTitle.textContent = 'SIAPKAN JARI ANDA DI ATAS BEL';
    standbyTitle.style.color = '#86efac';
    standbySub.textContent = 'Bel sudah terbuka. Peserta tercepat mendapat giliran menjawab.';

    winnerView.style.display = 'none';
  } else if (status === 'LOCKED' && list.length === 0) {
    // Bel Terkunci (Standby)
    projectorStatus.className = 'projector-status-box status-box-locked';
    projectorStatus.textContent = 'MENUNGGU SOAL';

    standbyView.style.display = 'flex';
    standbyTitle.textContent = 'MENUNGGU ABA-ABA JURI';
    standbyTitle.style.color = '#fff';
    standbySub.textContent = 'Juri akan membuka bel setelah selesai membacakan pertanyaan.';

    winnerView.style.display = 'none';
  } else if (list.length > 0) {
    // Sudah Ada Peserta yang Memencet Bel
    projectorStatus.className = 'projector-status-box status-box-buzzed';
    projectorStatus.textContent = 'BEL DITEKAN';

    standbyView.style.display = 'none';
    winnerView.style.display = 'flex';

    // Juara 1 (Pemenang Bel)
    const champ = list[0];
    championName.textContent = champ.name;
    championName.style.textShadow = 'none';

    // Posisi #2 dan #3
    if (list.length > 1) {
      runnersRow.style.display = 'flex';

      // Posisi #2
      runner2.style.display = 'flex';
      runner2Name.textContent = list[1].name;
      runner2Delta.textContent = `+${(list[1].deltaMs / 1000).toFixed(3)}s`;

      // Posisi #3
      if (list.length > 2) {
        runner3.style.display = 'flex';
        runner3Name.textContent = list[2].name;
        runner3Delta.textContent = `+${(list[2].deltaMs / 1000).toFixed(3)}s`;
      } else {
        runner3.style.display = 'none';
      }
    } else {
      runnersRow.style.display = 'none';
      runner2.style.display = 'none';
      runner3.style.display = 'none';
    }
  }
}

// 5. Animasi Countdown Timer Bar
function startTimer(seconds) {
  if (timerInterval) clearInterval(timerInterval);

  timerBarWrap.style.display = 'block';
  timerBarFill.style.width = '100%';
  timerBarFill.style.transition = 'none';

  // Trigger reflow
  void timerBarFill.offsetWidth;

  timerBarFill.style.transition = `width ${seconds}s linear`;
  timerBarFill.style.width = '0%';

  let remaining = seconds;
  window.soundEngine.playTick();

  timerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      window.soundEngine.playTick();
    } else {
      clearInterval(timerInterval);
      window.soundEngine.playWrong();
      setTimeout(() => {
        timerBarWrap.style.display = 'none';
      }, 1000);
    }
  }, 1000);
}

// 6. Kontrol Host dari Halaman Proyektor (Start, Reset, Lock)
const btnProjStart = document.getElementById('btn-proj-start');
const btnProjReset = document.getElementById('btn-proj-reset');
const btnProjLock = document.getElementById('btn-proj-lock');
const btnProjLie = document.getElementById('btn-proj-lie');

// Visual Flash Notification di Layar Proyektor
function showFeedbackFlash(text, color) {
  let flashEl = document.getElementById('feedback-flash');
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.id = 'feedback-flash';
    flashEl.style.position = 'fixed';
    flashEl.style.top = '35%';
    flashEl.style.left = '50%';
    flashEl.style.transform = 'translate(-50%, -50%)';
    flashEl.style.zIndex = '9999';
    flashEl.style.padding = '1.25rem 2.5rem';
    flashEl.style.borderRadius = '12px';
    flashEl.style.fontFamily = 'var(--font-display)';
    flashEl.style.fontSize = '2.25rem';
    flashEl.style.fontWeight = '700';
    flashEl.style.letterSpacing = '0.02em';
    flashEl.style.color = '#fff';
    flashEl.style.boxShadow = '0 10px 30px rgba(0,0,0,0.6)';
    flashEl.style.pointerEvents = 'none';
    flashEl.style.transition = 'all 0.2s ease';
    document.body.appendChild(flashEl);
  }

  flashEl.textContent = text;
  flashEl.style.backgroundColor = color;
  flashEl.style.opacity = '1';
  flashEl.style.transform = 'translate(-50%, -50%) scale(1)';

  setTimeout(() => {
    flashEl.style.opacity = '0';
    flashEl.style.transform = 'translate(-50%, -50%) scale(0.95)';
  }, 1500);
}

async function sendControl(action, payload = {}) {
  enableAudio();
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload })
    });
    const data = await res.json();
    if (data.state) {
      projectorState = data.state;
      renderProjector();
    }
  } catch (err) {
    console.error('Gagal mengirim perintah kontrol:', err);
  }
}

if (btnProjStart) btnProjStart.addEventListener('click', () => sendControl('unlock'));
if (btnProjReset) btnProjReset.addEventListener('click', () => sendControl('reset'));
if (btnProjLock) btnProjLock.addEventListener('click', () => sendControl('lock'));
if (btnProjLie) btnProjLie.addEventListener('click', () => {
  enableAudio();
  window.soundEngine.playLie();
  sendControl('sound', { sound: 'lie' });
});

// Shortcut Keyboard untuk Layar Proyektor
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

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
    enableAudio();
    window.soundEngine.playLie();
    sendControl('sound', { sound: 'lie' });
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    enableAudio();
    window.soundEngine.playTruth();
    sendControl('sound', { sound: 'truth' });
  } else if (e.key === 'b' || e.key === 'B') {
    e.preventDefault();
    enableAudio();
    window.soundEngine.playTruth();
    sendControl('sound', { sound: 'truth' });
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    enableAudio();
    window.soundEngine.playLie();
    sendControl('sound', { sound: 'lie' });
  }
});

// Inisialisasi
window.addEventListener('DOMContentLoaded', () => {
  initCentrifugo();
});

