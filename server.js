import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
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
  scores: {},
  settings: {
    mode: 'all', // 'all' (semua urutan) | 'first_only' (kunci langsung setelah #1)
    timerSeconds: 5
  }
};

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

    case 'score':
      if (payload && payload.name) {
        state.scores[payload.name] = (state.scores[payload.name] || 0) + (payload.delta || 0);
        broadcast({
          type: 'SCORE_UPDATE',
          scores: state.scores
        });
      }
      break;

    case 'settings':
      if (payload) {
        state.settings = { ...state.settings, ...payload };
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
  let joinUrl = process.env.PUBLIC_URL || '';

  if (!joinUrl) {
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
    let forwardedProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';

    // Cloudflare Tunnel header check (cf-visitor / cf-connecting-ip)
    if (req.headers['cf-visitor']) {
      try {
        const cfVisitor = JSON.parse(req.headers['cf-visitor']);
        if (cfVisitor.scheme) forwardedProto = cfVisitor.scheme;
      } catch {}
    }

    if (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')) {
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
