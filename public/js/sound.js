/**
 * Audio Player untuk ASTRO 2026 Buzzer
 * Hanya menggunakan audio resmi dari folder /media/:
 * 1. Truth (Benar / Pemenang Bel Pertama): /media/truth-detector-bassboosted.mp3
 * 2. Lie (Salah): /media/wrong-lie-incorrect-buzzer.mp3
 */
class SoundEngine {
  constructor() {
    this.volume = 0.85;
    this.muted = false;

    // Path audio resmi dari folder media
    this.truthPath = '/media/truth.mp3';
    this.liePath = '/media/lie.mp3';
    this.buzzerPath = '/media/buzzer.mp3';

    // Preload audio
    this.preloadAudio();
  }

  // Preload audio agar instan saat diputar
  preloadAudio() {
    try {
      this.audioTruth = new Audio(this.truthPath);
      this.audioLie = new Audio(this.liePath);
      this.audioBuzzer = new Audio(this.buzzerPath);
      this.audioTruth.preload = 'auto';
      this.audioLie.preload = 'auto';
      this.audioBuzzer.preload = 'auto';
    } catch (e) {
      console.warn('Preload audio error:', e);
    }
  }

  // Inisialisasi Audio Context jika diperlukan untuk interaksi browser
  init() {
    // Membuka blokir autoplay di browser modern
    if (this.audioTruth) {
      this.audioTruth.volume = this.volume;
    }
    if (this.audioLie) {
      this.audioLie.volume = this.volume;
    }
    if (this.audioBuzzer) {
      this.audioBuzzer.volume = this.volume;
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.audioTruth) this.audioTruth.volume = this.volume;
    if (this.audioLie) this.audioLie.volume = this.volume;
    if (this.audioBuzzer) this.audioBuzzer.volume = this.volume;
  }

  setMuted(isMuted) {
    this.muted = isMuted;
  }

  // Helper pemutaran audio (memanfaatkan preloaded instance untuk 0 latency)
  playAudioFile(src) {
    if (this.muted) return;
    try {
      let sound = null;
      if (src === this.truthPath && this.audioTruth) {
        sound = this.audioTruth;
      } else if (src === this.liePath && this.audioLie) {
        sound = this.audioLie;
      } else if (src === this.buzzerPath && this.audioBuzzer) {
        sound = this.audioBuzzer;
      }

      if (sound) {
        sound.currentTime = 0;
        sound.volume = this.volume;
        const promise = sound.play();
        if (promise !== undefined) {
          promise.catch(err => {
            console.warn(`Audio playback failed for ${src}:`, err);
            // Fallback clone jika audio sedang terkunci/sibuk
            const clone = sound.cloneNode(true);
            clone.volume = this.volume;
            clone.play().catch(e => console.warn('Fallback play error:', e));
          });
        }
      } else {
        const fresh = new Audio(src);
        fresh.volume = this.volume;
        fresh.play().catch(e => console.warn('Direct play error:', e));
      }
    } catch (e) {
      console.warn('Audio error:', e);
    }
  }

  // 1. Suara TRUTH (Benar / Host: T)
  playTruth() {
    if (this.muted) return;
    this.playAudioFile(this.truthPath);
  }

  // 2. Suara LIE (Salah / Host: L)
  playLie() {
    if (this.muted) return;
    this.playAudioFile(this.liePath);
  }

  // 3. Suara BUZZER (Saat peserta memencet "Tekan Sekarang")
  playBuzzer() {
    if (this.muted) return;
    this.playAudioFile(this.buzzerPath);
  }

  // Alias kompatibilitas
  playCorrect() {
    this.playTruth();
  }

  playWrong() {
    this.playLie();
  }

  // Web Audio Context untuk countdown tick dan timeout buzzer
  getAudioContext() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  // 4. Efek suara detik countdown (Ticking clock tegas, lantang & jelas di speaker)
  playTick(isUrgent = false) {
    if (this.muted) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      // Kombinasi triangle + sine untuk ketukan perkusi detak jam yang tebal dan jelas terdengar
      osc1.type = 'triangle';
      osc2.type = 'sine';

      const baseFreq = isUrgent ? 1180 : 820;
      osc1.frequency.setValueAtTime(baseFreq, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.45, ctx.currentTime + 0.1);

      osc2.frequency.setValueAtTime(baseFreq * 1.5, ctx.currentTime);
      osc2.frequency.exponentialRampToValueAtTime(baseFreq * 0.5, ctx.currentTime + 0.08);

      // Volume lantang, punchy & bertenaga
      gain.gain.setValueAtTime(this.volume * 0.95, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start();
      osc2.start();
      osc1.stop(ctx.currentTime + 0.15);
      osc2.stop(ctx.currentTime + 0.15);
    } catch (e) {
      console.warn('Play tick error:', e);
    }
  }

  // 5. Efek suara waktu habis: memutar sound LIE (media/lie.mp3) sesuai instruksi
  playTimeout() {
    this.playLie();
  }

  // Bel lain dinonaktifkan sesuai instruksi
  playUnlock() {}
  playReset() {}
}

// Instance global
window.soundEngine = new SoundEngine();

// Auto unlock audio context pada gestur interaksi pertama
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    if (window.soundEngine) {
      window.soundEngine.init();
    }
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
  };
  window.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  window.addEventListener('touchstart', unlockAudio);
}
