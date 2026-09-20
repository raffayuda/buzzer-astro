import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const CENTRIFUGO_PORT = 8000;
const CENTRIFUGO_API_KEY = 'buzzer-secret-api-key';
const CENTRIFUGO_URL = `http://127.0.0.1:${CENTRIFUGO_PORT}`;

// Deteksi alamat IP lokal (LAN Wi-Fi) untuk akses smartphone peserta
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
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

// Fungsi mem-publish event ke Centrifugo HTTP API
async function publishToCentrifugo(channel, data) {
  try {
    const response = await fetch(`${CENTRIFUGO_URL}/api/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `apikey ${CENTRIFUGO_API_KEY}`
      },
      body: JSON.stringify({ channel, data })
    });
    if (!response.ok) {
      console.error(`Centrifugo publish status: ${response.status}`);
    }
  } catch (err) {
    console.error('Gagal publish ke Centrifugo:', err.message);
  }
}

// Inisialisasi Express
const app = express();
app.use(cors());

// Reverse Proxy untuk WebSocket dan HTTP Centrifugo (Mendukung Cloudflare Tunnel)
const wsProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${CENTRIFUGO_PORT}`,
  changeOrigin: true,
  ws: true
});
app.use('/connection', wsProxy);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Routing Halaman
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/projector', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'projector.html'));
});

// API Info Jaringan & QR Code (Mendukung Deteksi Otomatis Domain Cloudflare Tunnel)
app.get('/api/info', async (req, res) => {
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
  const forwardedProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';

  let joinUrl = `${forwardedProto}://${forwardedHost}`;
  if (!forwardedHost || forwardedHost.includes('localhost') || forwardedHost.includes('127.0.0.1')) {
    joinUrl = `http://${localIp}:${PORT}`;
  }

  let qrCodeDataUrl = '';
  try {
    qrCodeDataUrl = await qrcode.toDataURL(joinUrl, {
      margin: 1,
      color: { dark: '#090d16ff', light: '#ffffffff' }
    });
  } catch (err) {
    console.error('Gagal generate QR Code:', err);
  }

  const centrifugoWsUrl = process.env.CENTRIFUGO_WS_URL || '';

  res.json({
    localIp,
    port: PORT,
    joinUrl,
    centrifugoPort: CENTRIFUGO_PORT,
    centrifugoWsUrl,
    qrCodeDataUrl,
    state
  });
});

// API Buzzer Press (Arbitrasi Timestamp Resmi Server)
app.post('/api/buzz', async (req, res) => {
  const { id, name, color } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'Nama peserta wajib diisi' });
  }

  // Jika bel belum dibuka atau sudah selesai (pada mode first_only)
  if (state.status === 'LOCKED') {
    return res.status(400).json({ success: false, error: 'Bel sedang terkunci! Tunggu aba-aba.' });
  }

  if (state.settings.mode === 'first_only' && state.buzzList.length > 0) {
    return res.status(400).json({ success: false, error: 'Bel sudah didahului peserta lain!' });
  }

  // Cek apakah peserta ini sudah menekan bel di ronde ini
  const existingIndex = state.buzzList.findIndex(item => item.id === id || item.name.toLowerCase() === name.toLowerCase());
  if (existingIndex !== -1) {
    return res.status(400).json({
      success: false,
      error: 'Anda sudah menekan bel!',
      rank: state.buzzList[existingIndex].rank,
      deltaMs: state.buzzList[existingIndex].deltaMs
    });
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

  // Siarkan event BUZZ ke seluruh subscriber Centrifugo
  await publishToCentrifugo('buzzer:events', {
    type: 'BUZZ',
    buzz: buzzRecord,
    buzzList: state.buzzList,
    status: state.status,
    sound: rank === 1 ? 'truth' : null
  });

  return res.json({
    success: true,
    rank,
    deltaMs,
    buzzRecord
  });
});

// API Kontrol Host
app.post('/api/control', async (req, res) => {
  const { action, payload } = req.body;

  switch (action) {
    case 'unlock':
      state.status = 'ACTIVE';
      state.buzzList = [];
      state.round += 1;
      await publishToCentrifugo('buzzer:events', {
        type: 'STATE_UPDATE',
        state,
        soundTrigger: 'unlock'
      });
      break;

    case 'lock':
      state.status = 'LOCKED';
      await publishToCentrifugo('buzzer:events', {
        type: 'STATE_UPDATE',
        state,
        soundTrigger: null
      });
      break;

    case 'reset':
      state.status = 'LOCKED';
      state.buzzList = [];
      await publishToCentrifugo('buzzer:events', {
        type: 'STATE_UPDATE',
        state,
        soundTrigger: 'reset'
      });
      break;

    case 'sound':
      if (payload && payload.sound) {
        await publishToCentrifugo('buzzer:events', {
          type: 'PLAY_SOUND',
          sound: payload.sound
        });
      }
      break;

    case 'lie':
      await publishToCentrifugo('buzzer:events', {
        type: 'PLAY_SOUND',
        sound: 'lie'
      });
      break;

    case 'truth':
      await publishToCentrifugo('buzzer:events', {
        type: 'PLAY_SOUND',
        sound: 'truth'
      });
      break;

    case 'timer':
      const seconds = (payload && payload.seconds) || state.settings.timerSeconds || 5;
      await publishToCentrifugo('buzzer:events', {
        type: 'TIMER_START',
        seconds
      });
      break;

    case 'score':
      if (payload && payload.name) {
        state.scores[payload.name] = (state.scores[payload.name] || 0) + (payload.delta || 0);
        await publishToCentrifugo('buzzer:events', {
          type: 'SCORE_UPDATE',
          scores: state.scores
        });
      }
      break;

    case 'settings':
      if (payload) {
        state.settings = { ...state.settings, ...payload };
        await publishToCentrifugo('buzzer:events', {
          type: 'SETTINGS_UPDATE',
          settings: state.settings
        });
      }
      break;

    default:
      return res.status(400).json({ success: false, error: 'Aksi tidak dikenal' });
  }

  res.json({ success: true, state });
});

// Manajemen Otomatis Centrifugo Server Binary
let centrifugoProcess = null;

function startCentrifugo() {
  console.log('Memulai Centrifugo server...');
  const exePath = path.join(__dirname, 'centrifugo.exe');
  
  centrifugoProcess = spawn(exePath, ['--config', 'config.json'], {
    cwd: __dirname,
    stdio: 'ignore',
    detached: false
  });

  centrifugoProcess.on('error', (err) => {
    console.error('Gagal menjalankan centrifugo.exe:', err.message);
  });

  centrifugoProcess.on('exit', (code) => {
    console.log(`Centrifugo server berhenti dengan exit code: ${code}`);
  });
}

// Tangani shutdown bersih
process.on('SIGINT', () => {
  if (centrifugoProcess) {
    centrifugoProcess.kill();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (centrifugoProcess) {
    centrifugoProcess.kill();
  }
  process.exit(0);
});

// Jalankan Centrifugo dan Web Server dengan HTTP Server Wrapper
startCentrifugo();

const server = http.createServer(app);
server.on('upgrade', wsProxy.upgrade);

server.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log('APLIKASI BUZZER LOMBA CERDAS CERMAT BERJALAN!');
  console.log('====================================================');
  console.log(`Sisi Peserta (HP)   : http://${localIp}:${PORT}`);
  console.log(`Sisi Host / Juri   : http://${localIp}:${PORT}/host`);
  console.log(`Tampilan Proyektor  : http://${localIp}:${PORT}/projector`);
  console.log(`WebSocket Endpoint  : ws://${localIp}:${PORT}/connection/websocket`);
  console.log('Dukungan Cloudflare Tunnel: AKTIF (via port ' + PORT + ')');
  console.log('====================================================');
});
