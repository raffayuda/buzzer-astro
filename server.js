import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;

// Deteksi alamat IP lokal (LAN Wi-Fi) untuk akses smartphone peserta
function getLocalIpAddress() {
  if (process.env.HOST_IP) return process.env.HOST_IP;

  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Abaikan link-local APIPA (169.254.x.x)
        if (iface.address.startsWith('169.254.')) continue;
        candidates.push({ name, address: iface.address });
      }
    }
  }

  // 1. Cek apakah ada IP spesifik 192.168.123.6
  const userLan = candidates.find(c => c.address === '192.168.123.6');
  if (userLan) return userLan.address;

  // 2. Cek subnet 192.168.x.x lainnya (kecuali VirtualBox 192.168.56.x)
  const standardLan = candidates.find(c => c.address.startsWith('192.168.') && !c.address.startsWith('192.168.56.'));
  if (standardLan) return standardLan.address;

  // 3. Jika di dalam container docker (10.x / 172.x), fallback ke IP host lokal user
  const nonDockerLan = candidates.find(c => !c.address.startsWith('10.') && !c.address.startsWith('172.'));
  if (nonDockerLan) return nonDockerLan.address;

  // Default fallback untuk akses lokal
  return '192.168.123.6';
}

const localIp = getLocalIpAddress();

// State Global Buzzer
const state = {
  status: 'LOCKED', // 'LOCKED' | 'ACTIVE' | 'BUZZED'
  round: 1,
  buzzList: [],
  // Papan skor peserta/tim: [{ id, name, color, score }] (urutan tetap sesuai urutan input)
  teams: [],
  settings: {
    mode: 'all', // 'all' (semua urutan) | 'first_only' (kunci langsung setelah #1)
    timerSeconds: 5,
    showScoreboard: true, // tampilkan papan skor di layar proyektor
    pointsCorrect: 10, // poin default jawaban benar (tombol cepat di antrean)
    pointsWrong: -5 // poin default jawaban salah (tombol cepat di antrean)
  }
};

// ---------------------------------------------------------------------------
// Persistensi Papan Skor (agar skor tidak hilang jika server restart)
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SCORE_FILE = path.join(DATA_DIR, 'scoreboard.json');
const MAX_TEAMS = 30;
const MAX_NAME_LENGTH = 40;
const MAX_ABS_DELTA = 10000;

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#3b82f6';
}

function sanitizeSettings(payload) {
  const out = {};
  if (payload.mode === 'all' || payload.mode === 'first_only') out.mode = payload.mode;
  const timer = parseInt(payload.timerSeconds);
  if (!isNaN(timer) && timer > 0 && timer <= 120) out.timerSeconds = timer;
  if (typeof payload.showScoreboard === 'boolean') out.showScoreboard = payload.showScoreboard;
  const pc = Number(payload.pointsCorrect);
  if (payload.pointsCorrect !== undefined && Number.isFinite(pc) && Math.abs(pc) <= MAX_ABS_DELTA) out.pointsCorrect = pc;
  const pw = Number(payload.pointsWrong);
  if (payload.pointsWrong !== undefined && Number.isFinite(pw) && Math.abs(pw) <= MAX_ABS_DELTA) out.pointsWrong = pw;
  return out;
}

function loadScoreboard() {
  try {
    if (!fs.existsSync(SCORE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SCORE_FILE, 'utf-8'));
    if (Array.isArray(saved.teams)) {
      state.teams = saved.teams
        .filter(t => t && typeof t.name === 'string' && t.name.trim())
        .slice(0, MAX_TEAMS)
        .map(t => ({
          id: String(t.id || makeId()),
          name: t.name.trim().slice(0, MAX_NAME_LENGTH),
          color: sanitizeColor(t.color),
          score: Number.isFinite(Number(t.score)) ? Number(t.score) : 0
        }));
    }
    if (saved.settings && typeof saved.settings === 'object') {
      state.settings = { ...state.settings, ...sanitizeSettings(saved.settings) };
    }
    console.log(`Papan skor dimuat: ${state.teams.length} tim (${SCORE_FILE})`);
  } catch (err) {
    console.error('Gagal memuat papan skor:', err.message);
  }
}

let saveTimeout = null;
function saveScoreboard() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${SCORE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ teams: state.teams, settings: state.settings }, null, 2));
      fs.renameSync(tmp, SCORE_FILE);
    } catch (err) {
      console.error('Gagal menyimpan papan skor:', err.message);
    }
  }, 150);
}

function findTeam({ id, name } = {}) {
  if (id) {
    const byId = state.teams.find(t => t.id === id);
    if (byId) return byId;
  }
  if (typeof name === 'string' && name.trim()) {
    const key = name.trim().toLowerCase();
    return state.teams.find(t => t.name.toLowerCase() === key) || null;
  }
  return null;
}

function addTeam(name, color) {
  const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
  if (!cleanName) return { error: 'Nama tim wajib diisi' };
  if (findTeam({ name: cleanName })) return { error: `Tim "${cleanName}" sudah ada` };
  if (state.teams.length >= MAX_TEAMS) return { error: `Maksimal ${MAX_TEAMS} tim` };
  const team = { id: makeId(), name: cleanName, color: sanitizeColor(color), score: 0 };
  state.teams.push(team);
  return { team };
}

function broadcastScores(change = null) {
  saveScoreboard();
  broadcast({
    type: 'SCORE_UPDATE',
    teams: state.teams,
    change
  });
}

loadScoreboard();

// Inisialisasi Express & HTTP Server
const app = express();
app.set('trust proxy', true); // Dukungan Cloudflare Tunnel & Reverse Proxy (X-Forwarded headers)
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));

const server = http.createServer(app);

// Inisialisasi Socket.IO Server
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Helper siaran event ke seluruh klien (Peserta, Juri, Proyektor)
function broadcast(eventData) {
  io.emit('buzzer:event', eventData);
}

// Logika Pemrosesan Tekan Bel (Buzzer Press)
function handleBuzz({ id, name, color }) {
  if (!name || !name.trim()) {
    return { success: false, error: 'Nama peserta wajib diisi' };
  }

  // Jika bel belum dibuka atau sudah selesai (pada mode first_only)
  if (state.status === 'LOCKED') {
    return { success: false, error: 'Bel sedang terkunci! Tunggu aba-aba.' };
  }

  if (state.settings.mode === 'first_only' && state.buzzList.length > 0) {
    return { success: false, error: 'Bel sudah didahului peserta lain!' };
  }

  // Cek apakah peserta ini sudah menekan bel di ronde ini
  const existingIndex = state.buzzList.findIndex(
    item => item.id === id || item.name.toLowerCase() === name.trim().toLowerCase()
  );
  if (existingIndex !== -1) {
    return {
      success: false,
      error: 'Anda sudah menekan bel!',
      rank: state.buzzList[existingIndex].rank,
      deltaMs: state.buzzList[existingIndex].deltaMs
    };
  }

  const now = Date.now();
  const rank = state.buzzList.length + 1;
  const deltaMs = rank === 1 ? 0 : (now - state.buzzList[0].time);

  const buzzRecord = {
    rank,
    id: id || `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    name: name.trim(),
    color: color || '#ef4444',
    time: now,
    deltaMs
  };

  state.buzzList.push(buzzRecord);

  // Jika ini buzz pertama, ubah status jadi BUZZED
  if (rank === 1) {
    state.status = 'BUZZED';
  }

  // Siarkan event BUZZ ke seluruh klien via Socket.IO
  broadcast({
    type: 'BUZZ',
    buzz: buzzRecord,
    buzzList: state.buzzList,
    status: state.status,
    sound: rank === 1 ? 'buzzer' : null
  });

  return {
    success: true,
    rank,
    deltaMs,
    buzzRecord
  };
}

// Logika Pemrosesan Aksi Juri (Control)
function handleControl(action, payload = {}) {
  switch (action) {
    case 'unlock':
      state.status = 'ACTIVE';
      state.buzzList = [];
      state.round += 1;
      broadcast({
        type: 'STATE_UPDATE',
        state,
        soundTrigger: 'unlock'
      });
      break;

    case 'lock':
      state.status = 'LOCKED';
      broadcast({
        type: 'STATE_UPDATE',
        state,
        soundTrigger: null
      });
      break;

    case 'reset':
      state.status = 'LOCKED';
      state.buzzList = [];
      broadcast({
        type: 'STATE_UPDATE',
        state,
        soundTrigger: 'reset'
      });
      break;

    case 'reset-round':
      state.round = 1;
      broadcast({
        type: 'STATE_UPDATE',
        state,
        soundTrigger: null
      });
      break;

    case 'set-round':
      const r = parseInt(payload && payload.round);
      state.round = (!isNaN(r) && r > 0) ? r : 1;
      broadcast({
        type: 'STATE_UPDATE',
        state,
        soundTrigger: null
      });
      break;

    case 'sound':
      if (payload && payload.sound) {
        broadcast({
          type: 'PLAY_SOUND',
          sound: payload.sound
        });
      }
      break;

    case 'lie':
      broadcast({
        type: 'PLAY_SOUND',
        sound: 'lie'
      });
      break;

    case 'truth':
      broadcast({
        type: 'PLAY_SOUND',
        sound: 'truth'
      });
      break;

    case 'timer':
      const seconds = (payload && payload.seconds) || state.settings.timerSeconds || 5;
      broadcast({
        type: 'TIMER_START',
        seconds
      });
      break;

    case 'score': {
      // payload: { id?, name?, color?, delta } — jika tim belum ada & name diberikan, tim dibuat otomatis
      const delta = Number(payload && payload.delta);
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > MAX_ABS_DELTA) {
        return { success: false, error: 'Nilai poin tidak valid' };
      }
      let team = findTeam(payload || {});
      if (!team) {
        if (!payload || !payload.name) return { success: false, error: 'Tim tidak ditemukan' };
        const created = addTeam(payload.name, payload.color);
        if (created.error) return { success: false, error: created.error };
        team = created.team;
      }
      team.score += delta;
      broadcastScores({ id: team.id, delta });
      break;
    }

    case 'score-set': {
      const team = findTeam({ id: payload && payload.id });
      const value = Number(payload && payload.score);
      if (!team) return { success: false, error: 'Tim tidak ditemukan' };
      if (payload.score === '' || !Number.isFinite(value) || Math.abs(value) > 1000000) {
        return { success: false, error: 'Nilai skor tidak valid' };
      }
      const delta = value - team.score;
      team.score = value;
      broadcastScores(delta !== 0 ? { id: team.id, delta } : null);
      break;
    }

    case 'team-add': {
      const created = addTeam(payload && payload.name, payload && payload.color);
      if (created.error) return { success: false, error: created.error };
      broadcastScores();
      break;
    }

    case 'team-move': {
      const idx = state.teams.findIndex(t => t.id === (payload && payload.id));
      const target = idx + (payload && payload.direction === 'up' ? -1 : 1);
      if (idx === -1 || target < 0 || target >= state.teams.length) break;
      [state.teams[idx], state.teams[target]] = [state.teams[target], state.teams[idx]];
      broadcastScores();
      break;
    }

    case 'team-remove': {
      const before = state.teams.length;
      state.teams = state.teams.filter(t => t.id !== (payload && payload.id));
      if (state.teams.length === before) return { success: false, error: 'Tim tidak ditemukan' };
      broadcastScores();
      break;
    }

    case 'score-reset':
      state.teams.forEach(t => { t.score = 0; });
      broadcastScores();
      break;

    case 'teams-clear':
      state.teams = [];
      broadcastScores();
      break;

    case 'settings':
      if (payload) {
        state.settings = { ...state.settings, ...sanitizeSettings(payload) };
        saveScoreboard();
        broadcast({
          type: 'SETTINGS_UPDATE',
          settings: state.settings
        });
      }
      break;

    default:
      return { success: false, error: 'Aksi tidak dikenal' };
  }

  return { success: true, state };
}

// Event Socket.IO
io.on('connection', (socket) => {
  // Kirim state awal secara instan saat klien terhubung
  socket.emit('buzzer:event', {
    type: 'STATE_UPDATE',
    state,
    soundTrigger: null
  });

  // Listener tekan bel via socket
  socket.on('BUZZ', (data, callback) => {
    const result = handleBuzz(data);
    if (typeof callback === 'function') callback(result);
  });

  // Listener kontrol juri via socket
  socket.on('CONTROL', ({ action, payload }, callback) => {
    const result = handleControl(action, payload);
    if (typeof callback === 'function') callback(result);
  });
});

// Routing Halaman
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/projector', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'projector.html'));
});

// API Info Jaringan & QR Code (Mendukung Deteksi Otomatis Cloudflare Tunnel / Reverse Proxy / IP Lokal)
app.get('/api/info', async (req, res) => {
  let joinUrl = req.query.public_url || process.env.PUBLIC_URL || '';

  if (!joinUrl) {
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
    let forwardedProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const referer = req.headers.referer || '';

    // Cloudflare Tunnel header check (cf-visitor / cf-connecting-ip)
    if (req.headers['cf-visitor']) {
      try {
        const cfVisitor = JSON.parse(req.headers['cf-visitor']);
        if (cfVisitor.scheme) forwardedProto = cfVisitor.scheme;
      } catch {}
    }

    // Jika berjalan di domain produksi (oktaa.my.id / astro) atau diakses via iframe astro, arahkan link peserta ke domain resmi
    if (
      (forwardedHost && (forwardedHost.includes('oktaa.my.id') || forwardedHost.includes('astro.nurulfikri.ac.id'))) ||
      referer.includes('astro.nurulfikri.ac.id')
    ) {
      joinUrl = 'https://astro.nurulfikri.ac.id/buzzer';
    } else if (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')) {
      joinUrl = `${forwardedProto}://${forwardedHost}`;
    } else {
      joinUrl = `http://${localIp}:${PORT}`;
    }
  }

  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await qrcode.toDataURL(joinUrl, {
      margin: 1,
      color: { dark: '#1e3a8aff', light: '#ffffffff' }
    });
  } catch (err) {
    console.error('Gagal generate QR Code:', err);
  }

  res.json({
    localIp,
    port: PORT,
    joinUrl,
    qrCodeDataUrl,
    state
  });
});

// API Buzzer Press (Dukungan REST API)
app.post('/api/buzz', (req, res) => {
  const result = handleBuzz(req.body);
  if (!result.success && !result.rank) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

// API Kontrol Host (Dukungan REST API)
app.post('/api/control', (req, res) => {
  const { action, payload } = req.body;
  const result = handleControl(action, payload);
  if (!result.success) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

// Jalankan Server HTTP & WebSocket dalam 1 proses tunggal di 0.0.0.0
server.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log('ASTRO 2026 BUZZER RUNNING (LISTEN ON 0.0.0.0)');
  console.log('====================================================');
  console.log(`Bind Interface     : 0.0.0.0:${PORT} (Menerima semua koneksi)`);
  console.log(`Akses Lokal / LAN  : http://${localIp}:${PORT}`);
  console.log(`Sisi Host / Juri   : http://${localIp}:${PORT}/host`);
  console.log(`Tampilan Proyektor  : http://${localIp}:${PORT}/projector`);
  console.log(`Cloudflare Tunnel  : Siap (X-Forwarded & CF-Visitor aktif)`);
  console.log(`Socket.IO Realtime  : AKTIF (Port ${PORT})`);
  console.log('====================================================');
});
