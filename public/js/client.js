/**
 * Client Script Sisi Peserta (User)
 * Menangani interaksi tombol buzzer, getaran HP, suara, dan koneksi Socket.IO
 */

let socket = null;
let participant = {
  id: null,
  name: '',
  color: '#ef4444'
};
let serverState = {
  status: 'LOCKED',
  buzzList: []
};
let hasBuzzedThisRound = false;

// DOM Elements
const regSection = document.getElementById('reg-section');
const buzzerSection = document.getElementById('buzzer-section');
const joinForm = document.getElementById('join-form');
const playerNameInput = document.getElementById('player-name');
const profileName = document.getElementById('profile-name');
const profileIndicator = document.getElementById('profile-indicator');
const btnChangeName = document.getElementById('btn-change-name');

const buzzerBtn = document.getElementById('buzzer-btn');
const buzzerHalo = document.getElementById('buzzer-halo');
const statusText = document.getElementById('status-text');
const btnLabel = document.getElementById('btn-label');
const resultBox = document.getElementById('result-box');
const resultTitle = document.getElementById('result-title');
const resultDelta = document.getElementById('result-delta');
const resultRank = document.getElementById('result-rank');
const connBadge = document.getElementById('conn-badge');
const connText = document.getElementById('conn-text');

// 1. Inisialisasi & Ambil data Profil dari LocalStorage
function initProfile() {
  const savedId = localStorage.getItem('buzzer_player_id');
  const savedName = localStorage.getItem('buzzer_player_name');
  const savedColor = localStorage.getItem('buzzer_player_color');

  if (savedId) {
    participant.id = savedId;
  } else {
    participant.id = 'p_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('buzzer_player_id', participant.id);
  }

  if (savedName) {
    participant.name = savedName;
    participant.color = savedColor || '#ef4444';
    showBuzzerScreen();
  } else {
    showRegistrationScreen();
  }
}

// 2. Setup Pemilihan Warna
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    participant.color = btn.dataset.color;
  });
});

// 3. Form Submit Masuk Arena
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = playerNameInput.value.trim();
  if (!name) return;

  participant.name = name;
  localStorage.setItem('buzzer_player_name', name);
  localStorage.setItem('buzzer_player_color', participant.color);

  showBuzzerScreen();
});

// Ganti Nama
btnChangeName.addEventListener('click', () => {
  showRegistrationScreen();
});

function showRegistrationScreen() {
  regSection.style.display = 'block';
  buzzerSection.style.display = 'none';
  playerNameInput.value = participant.name || '';
}

function showBuzzerScreen() {
  regSection.style.display = 'none';
  buzzerSection.style.display = 'flex';
  profileName.textContent = participant.name;
  profileIndicator.style.backgroundColor = participant.color;
  profileIndicator.style.color = participant.color;
}

// 4. Koneksi Socket.IO (Otomatis deteksi host, auto-reconnect, tanpa port terpisah)
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    connBadge.className = 'badge-pill status-active';
    connText.textContent = 'Terhubung';
  });

  socket.on('disconnect', () => {
    connBadge.className = 'badge-pill status-locked';
    connText.textContent = 'Terputus';
  });

  socket.on('connect_error', () => {
    connBadge.className = 'badge-pill status-locked';
    connText.textContent = 'Menghubungkan...';
  });

  // Menerima siaran event real-time dari server
  socket.on('buzzer:event', (event) => {
    handleServerEvent(event);
  });
}

// 5. Tangani Event Real-time
function handleServerEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'STATE_UPDATE':
      serverState = event.state;
      hasBuzzedThisRound = false;
      updateUIState();
      break;

    case 'BUZZ':
      serverState.buzzList = event.buzzList;
      serverState.status = event.status;
      if (event.buzz.rank === 1) {
        if (event.buzz.id !== participant.id && serverState.settings?.mode === 'first_only') {
          buzzerBtn.disabled = true;
          statusText.textContent = `Ditekan oleh: ${event.buzz.name}`;
        }
      }
      break;

    case 'PLAY_SOUND':
      // Suara dinonaktifkan di sisi peserta (hanya aktif di Host dan Proyektor)
      break;
  }
}

// 6. Perbarui Tampilan UI Berdasarkan Status Server
function updateUIState() {
  const status = serverState.status;

  if (status === 'ACTIVE') {
    hasBuzzedThisRound = false;
    buzzerBtn.disabled = false;
    buzzerBtn.classList.remove('pressed');
    buzzerHalo.classList.add('active');
    btnLabel.textContent = 'TEKAN SEKARANG';
    statusText.textContent = 'SIAP / BEREBUT BEL';
    statusText.className = 'game-status-text status-txt-active';
    resultBox.style.display = 'none';
  } else if (status === 'LOCKED') {
    hasBuzzedThisRound = false;
    buzzerBtn.disabled = true;
    buzzerBtn.classList.remove('pressed');
    buzzerHalo.classList.remove('active');
    btnLabel.textContent = 'BEL TERKUNCI';
    statusText.textContent = 'MENUNGGU SOAL';
    statusText.className = 'game-status-text status-txt-locked';
    resultBox.style.display = 'none';
  } else if (status === 'BUZZED') {
    buzzerHalo.classList.remove('active');
    if (!hasBuzzedThisRound) {
      if (serverState.settings?.mode === 'first_only') {
        buzzerBtn.disabled = true;
        statusText.textContent = 'BEL SUDAH DITEKAN';
      }
    }
  }
}

// 7. Event Menekan Tombol Buzzer
async function onBuzzerPress() {
  if (buzzerBtn.disabled || hasBuzzedThisRound) return;

  hasBuzzedThisRound = true;
  buzzerBtn.classList.add('pressed');
  buzzerBtn.disabled = true;

  // Haptic feedback / Getaran pada smartphone
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate([150, 50, 150]);
    } catch (e) {}
  }

  const payload = {
    id: participant.id,
    name: participant.name,
    color: participant.color
  };

  // Kirim via Socket.IO instan jika terhubung
  if (socket && socket.connected) {
    socket.emit('BUZZ', payload, (res) => {
      if (res && res.success) {
        displayResult(res.rank, res.deltaMs);
      } else if (res) {
        statusText.textContent = res.error || 'Gagal memencet bel';
        if (res.rank) displayResult(res.rank, res.deltaMs);
      }
    });
    return;
  }

  // Fallback REST API jika socket sedang reconnecting
  try {
    const res = await fetch('/api/buzz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      displayResult(data.rank, data.deltaMs);
    } else {
      statusText.textContent = data.error || 'Gagal memencet bel';
      if (data.rank) displayResult(data.rank, data.deltaMs);
    }
  } catch (err) {
    console.error('Error saat menekan bel:', err);
    statusText.textContent = 'Gagal menghubungi server!';
  }
}

// 8. Tampilkan Hasil Peringkat di Layar Peserta
function displayResult(rank, deltaMs) {
  resultBox.style.display = 'flex';
  resultRank.textContent = `#${rank}`;

  if (rank === 1) {
    resultTitle.textContent = 'TERCEPAT (PERINGKAT #1)';
    resultTitle.style.color = '#d97706';
    resultDelta.textContent = 'Selisih: 0 ms (Pemenang Bel)';
    statusText.textContent = 'ANDA MEMENCET PALING CEPAT';
    statusText.className = 'game-status-text status-txt-active';
  } else {
    resultTitle.textContent = `URUTAN KE-${rank}`;
    resultTitle.style.color = '#1e3a8a';
    const deltaSec = (deltaMs / 1000).toFixed(3);
    resultDelta.textContent = `Selisih: +${deltaSec} detik (+${deltaMs} ms)`;
    statusText.textContent = `Urutan #${rank}`;
    statusText.className = 'game-status-text';
  }
}

// Event Listeners Tombol Buzzer
buzzerBtn.addEventListener('pointerdown', onBuzzerPress);

function startClient() {
  initProfile();
  initSocket();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startClient);
} else {
  startClient();
}
