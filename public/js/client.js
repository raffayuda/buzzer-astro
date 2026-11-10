/**
 * Client Script Sisi Peserta (User)
 * Menangani pemilihan tim, tombol buzzer, getaran HP, papan skor live, aturan poin,
 * dan notifikasi penilaian juri via Socket.IO
 */

let socket = null;
let participant = {
  id: null,
  teamId: null,
  name: '',
  color: '#ef4444'
};
let serverState = {
  status: 'LOCKED',
  buzzList: [],
  teams: [],
  settings: {}
};
let hasBuzzedThisRound = false;
let verdictTimeout = null;

// DOM Elements
const regSection = document.getElementById('reg-section');
const buzzerSection = document.getElementById('buzzer-section');
const joinForm = document.getElementById('join-form');
const playerNameInput = document.getElementById('player-name');
const freeNameGroup = document.getElementById('free-name-group');
const colorGroup = document.getElementById('color-group');
const teamPickerGroup = document.getElementById('team-picker-group');
const teamPicker = document.getElementById('team-picker');
const regNotice = document.getElementById('reg-notice');
const regSubtitle = document.getElementById('reg-subtitle');
const btnJoin = document.getElementById('btn-join');
const profileName = document.getElementById('profile-name');
const profileIndicator = document.getElementById('profile-indicator');
const profileScore = document.getElementById('profile-score');
const btnChangeName = document.getElementById('btn-change-name');

const buzzerBtn = document.getElementById('buzzer-btn');
const buzzerHalo = document.getElementById('buzzer-halo');
const statusText = document.getElementById('status-text');
const btnLabel = document.getElementById('btn-label');
const resultBox = document.getElementById('result-box');
const resultTitle = document.getElementById('result-title');
const resultDelta = document.getElementById('result-delta');
const resultRank = document.getElementById('result-rank');
const verdictBanner = document.getElementById('verdict-banner');
const connBadge = document.getElementById('conn-badge');
const connText = document.getElementById('conn-text');

const rulesSection = document.getElementById('rules-section');
const rulesList = document.getElementById('rules-list');
const scoreSection = document.getElementById('score-section');
const participantScoreboard = document.getElementById('participant-scoreboard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function formatSigned(value) {
  const n = Math.round(Number(value) || 0);
  return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('id-ID')}`;
}

function teams() {
  return serverState.teams || [];
}

function isTeamMode() {
  return teams().length > 0;
}

function findMyTeam() {
  const list = teams();
  if (participant.teamId) {
    const byId = list.find(t => t.id === participant.teamId);
    if (byId) return byId;
  }
  if (participant.name) {
    const key = participant.name.trim().toLowerCase();
    return list.find(t => t.name.toLowerCase() === key) || null;
  }
  return null;
}

function isMine(buzz) {
  if (!buzz) return false;
  if (participant.teamId && buzz.teamId === participant.teamId) return true;
  return Boolean(participant.name) && buzz.name.toLowerCase() === participant.name.trim().toLowerCase();
}

function saveProfile() {
  storageSet('buzzer_player_name', participant.name || null);
  storageSet('buzzer_player_color', participant.color || null);
  storageSet('buzzer_player_team', participant.teamId || null);
}

// ---------------------------------------------------------------------------
// 1. Profil Peserta
// ---------------------------------------------------------------------------
function initProfile() {
  participant.id = storageGet('buzzer_player_id');
  if (!participant.id) {
    participant.id = 'p_' + Math.random().toString(36).substring(2, 11);
    storageSet('buzzer_player_id', participant.id);
  }

  participant.name = storageGet('buzzer_player_name') || '';
  participant.color = storageGet('buzzer_player_color') || '#ef4444';
  participant.teamId = storageGet('buzzer_player_team') || null;

  if (participant.name) showBuzzerScreen();
  else showRegistrationScreen();
}

// 2. Pemilihan Warna (mode tanpa tim terdaftar)
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    participant.color = btn.dataset.color;
  });
});

// 3. Form Masuk Arena
let pickedTeamId = null;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();

  if (isTeamMode()) {
    const team = teams().find(t => t.id === pickedTeamId);
    if (!team) {
      showRegNotice('Pilih tim Anda terlebih dahulu.');
      return;
    }
    participant.teamId = team.id;
    participant.name = team.name;
    participant.color = team.color;
  } else {
    const name = playerNameInput.value.trim();
    if (!name) return;
    participant.teamId = null;
    participant.name = name;
  }

  saveProfile();
  showBuzzerScreen();
});

btnChangeName.addEventListener('click', () => {
  showRegistrationScreen();
});

function showRegNotice(message) {
  if (!regNotice) return;
  regNotice.textContent = message || '';
  regNotice.style.display = message ? 'block' : 'none';
}

function renderRegistrationForm() {
  const teamMode = isTeamMode();
  freeNameGroup.style.display = teamMode ? 'none' : 'block';
  colorGroup.style.display = teamMode ? 'none' : 'block';
  teamPickerGroup.style.display = teamMode ? 'block' : 'none';
  playerNameInput.required = !teamMode;
  regSubtitle.textContent = teamMode
    ? 'Pilih tim Anda yang sudah didaftarkan panitia'
    : 'Masukkan nama Anda untuk bergabung ke arena bel lomba';

  if (!teamMode) {
    btnJoin.disabled = false;
    return;
  }

  if (!pickedTeamId) pickedTeamId = findMyTeam()?.id || null;
  if (pickedTeamId && !teams().some(t => t.id === pickedTeamId)) pickedTeamId = null;

  teamPicker.innerHTML = '';
  teams().forEach(team => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `team-pick${team.id === pickedTeamId ? ' selected' : ''}`;
    btn.style.setProperty('--team-color', team.color);
    btn.setAttribute('aria-pressed', team.id === pickedTeamId ? 'true' : 'false');

    const dot = document.createElement('span');
    dot.className = 'team-pick-dot';
    const label = document.createElement('span');
    label.className = 'team-pick-name';
    label.textContent = team.name;
    btn.append(dot, label);

    btn.addEventListener('click', () => {
      pickedTeamId = team.id;
      showRegNotice('');
      renderRegistrationForm();
    });
    teamPicker.appendChild(btn);
  });
  btnJoin.disabled = !pickedTeamId;
}

function showRegistrationScreen(notice = '') {
  regSection.style.display = 'block';
  buzzerSection.style.display = 'none';
  playerNameInput.value = participant.teamId ? '' : (participant.name || '');
  pickedTeamId = null;
  showRegNotice(notice);
  renderRegistrationForm();
  renderInfoCards();
}

function showBuzzerScreen() {
  regSection.style.display = 'none';
  buzzerSection.style.display = 'flex';
  renderProfile();
  renderInfoCards();
}

function isOnBuzzerScreen() {
  return buzzerSection.style.display !== 'none';
}

// Pastikan profil masih valid terhadap daftar tim terbaru dari panitia
function syncProfileWithTeams() {
  if (!isTeamMode()) {
    if (isOnBuzzerScreen()) renderProfile();
    else renderRegistrationForm();
    return;
  }
  const team = findMyTeam();
  if (team) {
    if (participant.teamId !== team.id || participant.name !== team.name || participant.color !== team.color) {
      participant.teamId = team.id;
      participant.name = team.name;
      participant.color = team.color;
      saveProfile();
    }
  } else if (isOnBuzzerScreen() && participant.name) {
    showRegistrationScreen('Tim Anda tidak ada di daftar panitia. Silakan pilih tim Anda.');
    return;
  }
  if (isOnBuzzerScreen()) renderProfile();
  else renderRegistrationForm();
}

function renderProfile() {
  profileName.textContent = participant.name;
  profileIndicator.style.backgroundColor = participant.color;
  profileIndicator.style.color = participant.color;

  const team = findMyTeam();
  const scoreVisible = Boolean(team) && serverState.settings?.showScoreboard !== false;
  profileScore.style.display = scoreVisible ? 'inline-flex' : 'none';
  if (scoreVisible) profileScore.textContent = `${team.score.toLocaleString('id-ID')} poin`;
}

// ---------------------------------------------------------------------------
// 4. Aturan Poin & Papan Skor
// ---------------------------------------------------------------------------
function renderRules() {
  const s = serverState.settings || {};
  const correct = s.pointsCorrect ?? 10;
  const wrong = s.pointsWrong ?? -5;
  const rules = [
    ['up', `Jawaban <strong>BENAR</strong>: <strong>${formatSigned(correct)} poin</strong>`],
    ['down', wrong === 0
      ? 'Jawaban <strong>SALAH</strong>: <strong>tidak mengurangi poin</strong>'
      : `Jawaban <strong>SALAH</strong>: <strong>${formatSigned(wrong)} poin</strong>`],
    ['info', 'Tekan bel <strong>hanya setelah juri membuka bel</strong>. Satu tim hanya bisa menekan sekali per soal.'],
    ['info', s.mode === 'first_only'
      ? 'Hanya <strong>tim tercepat</strong> yang mendapat kesempatan menjawab.'
      : 'Urutan bel dicatat. Jika jawaban salah, kesempatan berpindah ke <strong>urutan berikutnya</strong>.'],
    ['info', `Waktu menjawab: <strong>${Number(s.timerSeconds) || 5} detik</strong> setelah juri memulai hitung mundur.`],
    ['info', 'Keputusan juri bersifat <strong>final</strong>.']
  ];
  rulesList.innerHTML = rules
    .map(([kind, html]) => `<li class="rule-item rule-${kind}">${html}</li>`)
    .join('');
}

function renderScoreboard() {
  const list = teams();
  const visible = list.length > 0 && serverState.settings?.showScoreboard !== false;
  scoreSection.style.display = visible ? 'block' : 'none';
  if (!visible) return;

  const myTeam = findMyTeam();
  const sorted = [...list].sort((a, b) => b.score - a.score);
  participantScoreboard.innerHTML = '';

  let lastScore = null;
  let lastRank = 0;
  sorted.forEach((team, index) => {
    // Skor sama = peringkat sama
    const rank = team.score === lastScore ? lastRank : index + 1;
    lastScore = team.score;
    lastRank = rank;
    const isMe = Boolean(myTeam) && myTeam.id === team.id;

    const row = document.createElement('div');
    row.className = `p-score-row${isMe ? ' is-me' : ''}`;
    row.style.setProperty('--team-color', team.color);

    const rankEl = document.createElement('span');
    rankEl.className = 'p-score-rank';
    rankEl.textContent = `#${rank}`;
    const dot = document.createElement('span');
    dot.className = 'p-score-dot';
    const name = document.createElement('span');
    name.className = 'p-score-name';
    name.textContent = team.name + (isMe ? ' (Anda)' : '');
    const value = document.createElement('span');
    value.className = 'p-score-value';
    value.textContent = team.score.toLocaleString('id-ID');

    row.append(rankEl, dot, name, value);
    participantScoreboard.appendChild(row);
  });
}

function renderInfoCards() {
  renderRules();
  renderScoreboard();
  rulesSection.style.display = 'block';
}

// Banner penilaian juri untuk tim sendiri
function showVerdict(result, points) {
  if (!verdictBanner) return;
  clearTimeout(verdictTimeout);

  if (result === 'undo') {
    verdictBanner.className = 'verdict-banner is-neutral';
    verdictBanner.textContent = 'Penilaian dibatalkan juri';
  } else {
    const correct = result === 'correct';
    verdictBanner.className = `verdict-banner ${correct ? 'is-up' : 'is-down'}`;
    verdictBanner.textContent = `${correct ? 'BENAR!' : 'SALAH'} ${points ? `${formatSigned(points)} poin` : ''}`.trim();
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(correct ? [80, 40, 80] : [300]);
      } catch {}
    }
  }
  verdictBanner.style.display = 'block';
  verdictTimeout = setTimeout(() => {
    verdictBanner.style.display = 'none';
  }, 3500);
}

// ---------------------------------------------------------------------------
// 5. Koneksi Socket.IO
// ---------------------------------------------------------------------------
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

  socket.on('buzzer:event', (event) => {
    handleServerEvent(event);
  });
}

// 6. Tangani Event Real-time
function handleServerEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'STATE_UPDATE':
      serverState = { ...serverState, ...event.state };
      hasBuzzedThisRound = false;
      syncProfileWithTeams();
      updateUIState();
      renderInfoCards();
      break;

    case 'BUZZ':
      serverState.buzzList = event.buzzList;
      serverState.status = event.status;
      if (event.buzz.rank === 1 && !isMine(event.buzz) && serverState.settings?.mode === 'first_only') {
        buzzerBtn.disabled = true;
        statusText.textContent = `Ditekan oleh: ${event.buzz.name}`;
      }
      break;

    case 'SCORE_UPDATE':
      serverState.teams = event.teams || [];
      if (event.buzzList) serverState.buzzList = event.buzzList;
      syncProfileWithTeams();
      renderScoreboard();
      break;

    case 'SETTINGS_UPDATE':
      serverState.settings = event.settings || serverState.settings;
      renderInfoCards();
      if (isOnBuzzerScreen()) renderProfile();
      break;

    case 'JUDGE':
      serverState.teams = event.teams || [];
      serverState.buzzList = event.buzzList || [];
      syncProfileWithTeams();
      renderScoreboard();
      if (isOnBuzzerScreen() && isMine(event.buzz)) {
        showVerdict(event.result, event.points);
      }
      break;

    case 'PLAY_SOUND':
      // Suara dinonaktifkan di sisi peserta (hanya aktif di Host dan Proyektor)
      break;
  }
}

// 7. Perbarui Tampilan UI Berdasarkan Status Server
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
    const mine = (serverState.buzzList || []).find(isMine);
    if (mine) {
      // Mis. setelah reload/reconnect: tampilkan lagi urutan tim sendiri
      hasBuzzedThisRound = true;
      buzzerBtn.disabled = true;
      displayResult(mine.rank, mine.deltaMs);
    } else if (serverState.settings?.mode === 'first_only') {
      buzzerBtn.disabled = true;
      statusText.textContent = 'BEL SUDAH DITEKAN';
    }
  }
}

// 8. Event Menekan Tombol Buzzer
function handleBuzzResponse(res) {
  if (!res) return;
  if (res.success) {
    displayResult(res.rank, res.deltaMs);
    return;
  }
  if (res.code === 'TEAM_NOT_FOUND') {
    showRegistrationScreen(res.error);
    return;
  }
  statusText.textContent = res.error || 'Gagal memencet bel';
  if (res.rank) displayResult(res.rank, res.deltaMs);
}

async function onBuzzerPress() {
  if (buzzerBtn.disabled || hasBuzzedThisRound) return;

  hasBuzzedThisRound = true;
  buzzerBtn.classList.add('pressed');
  buzzerBtn.disabled = true;

  // Haptic feedback / Getaran pada smartphone
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate([150, 50, 150]);
    } catch {}
  }

  const payload = {
    id: participant.id,
    teamId: participant.teamId,
    name: participant.name,
    color: participant.color
  };

  if (socket && socket.connected) {
    socket.emit('BUZZ', payload, handleBuzzResponse);
    return;
  }

  // Fallback REST API jika socket sedang reconnecting
  try {
    const res = await fetch('/api/buzz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    handleBuzzResponse(await res.json());
  } catch (err) {
    console.error('Error saat menekan bel:', err);
    statusText.textContent = 'Gagal menghubungi server!';
  }
}

// 9. Tampilkan Hasil Peringkat di Layar Peserta
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
