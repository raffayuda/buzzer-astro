import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
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

// ---------------------------------------------------------------------------
// PIN Juri — wajib untuk semua aksi kontrol (buka bel, penilaian, skor, pengaturan).
// Set lewat env HOST_PIN. Jika kosong, PIN acak 6 digit dibuat & dicetak di log saat start.
// ---------------------------------------------------------------------------
const HOST_PIN_FROM_ENV = (process.env.HOST_PIN || '').trim();
const HOST_PIN = HOST_PIN_FROM_ENV || String(crypto.randomInt(100000, 1000000));
const HOST_PIN_HASH = crypto.createHash('sha256').update(HOST_PIN).digest();
const AUTH_MAX_FAILS = 8;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const authFailures = new Map(); // ip -> { count, resetAt }

function isValidPin(pin) {
  if (typeof pin !== 'string' || !pin.trim()) return false;
  const hash = crypto.createHash('sha256').update(pin.trim()).digest();
  return crypto.timingSafeEqual(hash, HOST_PIN_HASH);
}

// Cek PIN dengan pembatasan percobaan per IP (anti tebak PIN)
function checkPin(ip, pin) {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (entry && now > entry.resetAt) authFailures.delete(ip);
  const current = authFailures.get(ip);
  if (current && current.count >= AUTH_MAX_FAILS) {
    return { ok: false, error: 'Terlalu banyak percobaan PIN salah. Coba lagi dalam beberapa menit.' };
  }
  if (isValidPin(pin)) {
    authFailures.delete(ip);
    return { ok: true };
  }
  const next = current || { count: 0, resetAt: now + AUTH_WINDOW_MS };
  next.count += 1;
  authFailures.set(ip, next);
  return { ok: false, error: 'PIN juri salah' };
}

// Token sesi juri: diberikan setelah PIN benar, dipakai saat reconnect/reload.
// Jadi pembatasan percobaan PIN tidak pernah mengunci juri yang sudah login.
const hostTokens = new Set();

function issueHostToken() {
  const token = crypto.randomBytes(24).toString('hex');
  hostTokens.add(token);
  return token;
}

function isValidHostToken(token) {
  return typeof token === 'string' && token.length === 48 && hostTokens.has(token);
}

function socketIp(socket) {
  const headers = socket.handshake.headers || {};
  const forwarded = headers['cf-connecting-ip'] || (headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || socket.handshake.address || 'unknown';
}

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
  const timer = Number(payload.timerSeconds);
  if (Number.isInteger(timer) && timer > 0 && timer <= 120) out.timerSeconds = timer;
  if (typeof payload.showScoreboard === 'boolean') out.showScoreboard = payload.showScoreboard;
  // Poin benar: bilangan bulat 0..MAX. Poin salah: bilangan bulat -MAX..0 (0 = tanpa pengurangan).
  const pc = Number(payload.pointsCorrect);
  if (payload.pointsCorrect !== undefined && payload.pointsCorrect !== '' && Number.isInteger(pc) && pc >= 0 && pc <= MAX_ABS_DELTA) {
    out.pointsCorrect = pc;
  }
  const pw = Number(payload.pointsWrong);
  if (payload.pointsWrong !== undefined && payload.pointsWrong !== '' && Number.isInteger(pw) && pw <= 0 && pw >= -MAX_ABS_DELTA) {
    out.pointsWrong = pw;
  }
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
    buzzList: state.buzzList,
    change
  });
}

// Lepas status penilaian di antrean (dipakai saat skor di-nol-kan / tim dihapus)
function clearJudgements(teamId = null) {
  state.buzzList.forEach(b => {
    if (teamId === null || b.teamId === teamId) {
      b.judged = null;
      b.judgedDelta = 0;
    }
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
function handleBuzz({ id, name, color, teamId } = {}) {
  let cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
  let cleanColor = sanitizeColor(color);
  let team = null;

  // Jika panitia sudah mendaftarkan tim, hanya tim terdaftar yang boleh memencet bel
  if (state.teams.length > 0) {
    team = findTeam({ id: typeof teamId === 'string' ? teamId : null, name: cleanName });
    if (!team) {
      return { success: false, code: 'TEAM_NOT_FOUND', error: 'Tim tidak terdaftar. Pilih tim Anda dari daftar.' };
    }
    cleanName = team.name;
    cleanColor = team.color;
  }

  if (!cleanName) {
    return { success: false, error: 'Nama peserta wajib diisi' };
  }
  const cleanId = typeof id === 'string' && id ? id.slice(0, 64) : null;

  // Jika bel belum dibuka atau sudah selesai (pada mode first_only)
  if (state.status === 'LOCKED') {
    return { success: false, error: 'Bel sedang terkunci! Tunggu aba-aba.' };
  }

  if (state.settings.mode === 'first_only' && state.buzzList.length > 0) {
    return { success: false, error: 'Bel sudah didahului peserta lain!' };
  }

  // Cek apakah peserta ini sudah menekan bel di ronde ini
  const existingIndex = state.buzzList.findIndex(
    item => (cleanId && item.id === cleanId) || item.name.toLowerCase() === cleanName.toLowerCase()
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
    id: cleanId || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    teamId: team ? team.id : null,
    name: cleanName,
    color: cleanColor,
    time: now,
    deltaMs,
    judged: null, // null | 'correct' | 'wrong'
    judgedDelta: 0 // poin yang benar-benar diterapkan ke tim
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

// Logika Penilaian Jawaban (BENAR / SALAH / BATAL) — poin diambil dari pengaturan server
function handleJudge(payload = {}) {
  const result = payload.result;
  if (!['correct', 'wrong', 'undo'].includes(result)) {
    return { success: false, error: 'Jenis penilaian tidak valid' };
  }

  // Target: peserta antrean sesuai rank, atau peserta teratas yang belum dinilai
  let buzz = null;
  if (payload.rank !== undefined && payload.rank !== null) {
    buzz = state.buzzList.find(b => b.rank === Number(payload.rank)) || null;
    if (!buzz) return { success: false, error: 'Peserta di antrean tidak ditemukan' };
  } else if (result !== 'undo') {
    buzz = state.buzzList.find(b => !b.judged) || null;
  }

  if (!buzz) {
    if (result === 'undo') return { success: false, error: 'Tidak ada penilaian untuk dibatalkan' };
    // Tidak ada peserta yang menunggu penilaian: hanya putar efek suara
    broadcast({ type: 'PLAY_SOUND', sound: result === 'correct' ? 'truth' : 'lie' });
    return { success: true, soundOnly: true, state };
  }

  if (result === 'undo' && !buzz.judged) {
    return { success: false, error: `${buzz.name} belum dinilai` };
  }
  if (result !== 'undo' && buzz.judged === result) {
    return { success: false, error: `${buzz.name} sudah dinilai ${result === 'correct' ? 'BENAR' : 'SALAH'}` };
  }

  let team = findTeam({ id: buzz.teamId, name: buzz.name });
  const previousDelta = team ? buzz.judgedDelta : 0;

  // Batalkan poin penilaian sebelumnya (jika juri mengoreksi / membatalkan)
  if (team && previousDelta) team.score -= previousDelta;

  if (result === 'undo') {
    buzz.judged = null;
    buzz.judgedDelta = 0;
  } else {
    const points = result === 'correct' ? state.settings.pointsCorrect : state.settings.pointsWrong;
    if (!team && points !== 0) {
      const created = addTeam(buzz.name, buzz.color);
      // team === null di sini, jadi belum ada poin yang berubah
      if (created.error) return { success: false, error: created.error };
      team = created.team;
    }
    if (team) {
      team.score += points;
      buzz.teamId = team.id;
    }
    buzz.judged = result;
    buzz.judgedDelta = team ? points : 0;
  }

  const netDelta = buzz.judgedDelta - previousDelta;
  saveScoreboard();
  broadcast({
    type: 'JUDGE',
    result,
    buzz,
    points: buzz.judgedDelta,
    buzzList: state.buzzList,
    teams: state.teams,
    change: team && netDelta ? { id: team.id, delta: netDelta } : null,
    sound: result === 'correct' ? 'truth' : result === 'wrong' ? 'lie' : null
  });

  return { success: true, state };
}

// Logika Pemrosesan Aksi Juri (Control)
function handleControl(action, payload = {}) {
  payload = payload && typeof payload === 'object' ? payload : {};
  switch (action) {
    case 'judge':
      return handleJudge(payload);

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
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ABS_DELTA) {
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
      if (payload.score === '' || !Number.isInteger(value) || Math.abs(value) > 1000000) {
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
      clearJudgements(payload.id);
      broadcastScores();
      break;
    }

    case 'score-reset':
      state.teams.forEach(t => { t.score = 0; });
      clearJudgements();
      broadcastScores();
      break;

    case 'teams-clear':
      state.teams = [];
      clearJudgements();
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
  const ip = socketIp(socket);
  socket.data.isHost = false;

  // Juri / proyektor yang sudah login mengirim token sesi saat handshake (socket.auth.token)
  socket.data.isHost = isValidHostToken(socket.handshake.auth && socket.handshake.auth.token);

  // Kirim state awal secara instan saat klien terhubung
  socket.emit('buzzer:event', {
    type: 'STATE_UPDATE',
    state,
    soundTrigger: null
  });
  socket.emit('auth:status', { isHost: socket.data.isHost });

  // Login juri dengan PIN
  socket.on('AUTH', (data, callback) => {
    const result = checkPin(ip, data && typeof data.pin === 'string' ? data.pin : '');
    socket.data.isHost = result.ok;
    if (typeof callback === 'function') {
      callback(result.ok ? { success: true, token: issueHostToken() } : { success: false, error: result.error });
    }
  });

  // Listener tekan bel via socket (terbuka untuk peserta)
  socket.on('BUZZ', (data, callback) => {
    const result = handleBuzz(data && typeof data === 'object' ? data : {});
    if (typeof callback === 'function') callback(result);
  });

  // Listener kontrol juri via socket (wajib PIN)
  socket.on('CONTROL', (data, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    if (!socket.data.isHost) {
      return reply({ success: false, code: 'UNAUTHORIZED', error: 'Akses juri diperlukan. Masukkan PIN juri.' });
    }
    const { action, payload } = data && typeof data === 'object' ? data : {};
    reply(handleControl(action, payload));
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
  const result = handleBuzz(req.body && typeof req.body === 'object' ? req.body : {});
  if (!result.success && !result.rank) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

// API Kontrol Host (Dukungan REST API)
app.post('/api/control', (req, res) => {
  const auth = isValidHostToken(req.get('x-host-token'))
    ? { ok: true }
    : checkPin(req.ip || 'unknown', req.get('x-host-pin') || '');
  if (!auth.ok) {
    return res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: auth.error });
  }
  const { action, payload } = req.body || {};
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
  console.log(HOST_PIN_FROM_ENV
    ? 'PIN Juri           : dari env HOST_PIN'
    : `PIN Juri           : ${HOST_PIN}  (acak — set env HOST_PIN agar tetap)`);
  console.log('====================================================');
});
