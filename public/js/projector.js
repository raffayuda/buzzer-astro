/**
 * Client Script Tampilan Layar Proyektor / TV Panggung
 * Menampilkan animasi pemenang tercepat, runner-up, sound FX panggung, dan QR Code via Socket.IO
 */

let socket = null;
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
// Inisialisasi Audio Context pada interaksi pertama di proyektor
let soundEnabled = false;
function enableAudio() {
  if (!soundEnabled) {
    window.soundEngine.init();
    soundEnabled = true;
  }
}
document.addEventListener('click', enableAudio, { once: true });
document.addEventListener('keydown', enableAudio, { once: true });
document.addEventListener('touchstart', enableAudio, { once: true });

// Toggle Fullscreen dengan double-click di mana saja pada layar proyektor
document.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// 1. Inisialisasi Socket.IO
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    fetchInfo();
  });

  socket.on('disconnect', () => {
    projectorStatus.className = 'projector-status-box status-box-locked';
    projectorStatus.textContent = 'TERPUTUS';
  });

  socket.on('connect_error', () => {
    projectorStatus.className = 'projector-status-box status-box-locked';
    projectorStatus.textContent = 'MENGHUBUNGKAN...';
  });

  // Menerima siaran event real-time dari server
  socket.on('buzzer:event', (event) => {
    handleProjectorEvent(event);
  });
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
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
        if (timerBarWrap) timerBarWrap.style.display = 'none';
      }
      projectorState = event.state;
      renderProjector();
      if (event.soundTrigger === 'unlock') {
        window.soundEngine.playUnlock();
        showFeedbackFlash('BEL DIBUKA (START)', '#10b981');
      } else if (event.soundTrigger === 'reset') {
        window.soundEngine.playReset();
        showFeedbackFlash('ANTREAN DI-RESET', '#f59e0b');
      }
      break;

    case 'BUZZ':
      projectorState.buzzList = event.buzzList;
      projectorState.status = event.status;
      renderProjector();
      // Mainkan suara BUZZER saat peserta memencet bel pertama
      if (event.buzz && event.buzz.rank === 1) {
        window.soundEngine.playBuzzer();
      }
      break;

    case 'PLAY_SOUND':
      if (event.sound === 'truth' || event.sound === 'correct') {
        window.soundEngine.playTruth();
        showFeedbackFlash('TRUTH (BENAR)', '#10b981');
      } else if (event.sound === 'lie' || event.sound === 'wrong') {
        window.soundEngine.playLie();
        showFeedbackFlash('LIE (SALAH)', '#f43f5e');
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

  if (status === 'ACTIVE') {
    // Bel Terbuka / Siap Berebut
    projectorStatus.className = 'projector-status-box status-box-active';
    projectorStatus.textContent = 'SIAP / BEREBUT BEL';

    standbyView.style.display = 'flex';
    standbyTitle.textContent = 'SIAPKAN JARI ANDA DI ATAS BEL';
    standbyTitle.style.color = '#059669';
    standbySub.textContent = 'Bel sudah terbuka. Peserta tercepat mendapat giliran menjawab.';

    winnerView.style.display = 'none';
  } else if (status === 'LOCKED' && list.length === 0) {
    // Bel Terkunci (Standby)
    projectorStatus.className = 'projector-status-box status-box-locked';
    projectorStatus.textContent = 'MENUNGGU SOAL';

    standbyView.style.display = 'flex';
    standbyTitle.textContent = 'MENUNGGU ABA-ABA JURI';
    standbyTitle.style.color = '#1e3a8a';
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
  window.soundEngine.playTick(remaining <= 2);

  timerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      window.soundEngine.playTick(remaining <= 2);
    } else {
      clearInterval(timerInterval);
      timerInterval = null;
      window.soundEngine.playLie();
      showFeedbackFlash('⏱ WAKTU HABIS!', '#ef4444');
      setTimeout(() => {
        timerBarWrap.style.display = 'none';
      }, 1200);
    }
  }, 1000);
}

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
    flashEl.style.padding = '1.2rem 3rem';
    flashEl.style.borderRadius = 'var(--radius-full)';
    flashEl.style.fontFamily = 'var(--font-title)';
    flashEl.style.fontSize = '2.5rem';
    flashEl.style.fontWeight = '900';
    flashEl.style.letterSpacing = '0.04em';
    flashEl.style.color = '#fff';
    flashEl.style.boxShadow = 'var(--shadow-gloss), 0 16px 40px rgba(30, 58, 138, 0.3)';
    flashEl.style.pointerEvents = 'none';
    flashEl.style.transition = 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)';
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

  if (socket && socket.connected) {
    socket.emit('CONTROL', { action, payload }, (res) => {
      if (res && res.state) {
        projectorState = res.state;
        renderProjector();
      }
    });
    return;
  }

  // Fallback REST API
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

// Shortcut Keyboard untuk Layar Proyektor (Bisa dikontrol via keyboard tanpa tombol UI)
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

  if (e.code === 'Space') {
    e.preventDefault();
    sendControl('unlock');
  } else if (e.code === 'Enter') {
    e.preventDefault();
    sendControl('reset');
  } else if (e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    sendControl('lock');
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    enableAudio();
    sendControl('sound', { sound: 'lie' });
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    enableAudio();
    sendControl('sound', { sound: 'truth' });
  } else if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    enableAudio();
    sendControl('timer', { seconds: 5 });
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    sendControl('reset-round');
    showFeedbackFlash('RONDE DI-RESET KE 1', '#3b82f6');
  }
});

// Listener Klik Indikator Ronde di Layar Proyektor
const roundIndicatorEl = document.getElementById('round-indicator');
if (roundIndicatorEl) {
  roundIndicatorEl.addEventListener('click', () => {
    sendControl('reset-round');
    showFeedbackFlash('RONDE DI-RESET KE 1', '#3b82f6');
  });
}

// Inisialisasi
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initSocket);
} else {
  initSocket();
}
