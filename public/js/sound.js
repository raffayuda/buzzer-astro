/**
 * Sound Synthesizer & Audio Player
 * Mendukung audio MP3 (Truth / Lie) dengan fallback otomatis ke Web Audio API Synthesizer
 */
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.volume = 0.85;
    this.muted = false;

    // Preload file MP3
    this.audioTruth = new Audio('/sounds/truth.mp3');
    this.audioLie = new Audio('/sounds/lie.mp3');
    this.audioTruth.preload = 'auto';
    this.audioLie.preload = 'auto';
  }

  // Inisialisasi AudioContext pada interaksi pertama pengguna
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    if (this.audioTruth) this.audioTruth.volume = this.volume;
    if (this.audioLie) this.audioLie.volume = this.volume;
  }

  setMuted(isMuted) {
    this.muted = isMuted;
  }

  // Helper pemutaran file audio MP3 dengan fallback
  playAudioFile(src, fallback) {
    if (this.muted) return;
    try {
      const sound = new Audio(src);
      sound.volume = this.volume;
      const playPromise = sound.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.warn(`Audio play failed for ${src}, falling back to synth:`, err);
          if (fallback) fallback();
        });
      }
    } catch (e) {
      if (fallback) fallback();
    }
  }

  // Suara TRUTH (Benar / Pemencet Bel Pertama)
  playTruth() {
    if (this.muted) return;
    this.init();
    this.playAudioFile('/sounds/truth.mp3', () => this.playCorrectSynth());
  }

  // Suara LIE (Salah / Jawaban Salah)
  playLie() {
    if (this.muted) return;
    this.init();
    this.playAudioFile('/sounds/lie.mp3', () => this.playWrongSynth());
  }

  // Alias kompatibilitas
  playCorrect() {
    this.playTruth();
  }

  playWrong() {
    this.playLie();
  }

  // Fallback Suara Benar (Synthesizer Chime)
  playCorrectSynth() {
    if (!this.ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    const now = this.ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const noteTime = now + (idx * 0.08);
      const noteDuration = 0.45;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, noteTime);

      gain.gain.setValueAtTime(0.001, noteTime);
      gain.gain.linearRampToValueAtTime(0.4 * this.volume, noteTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteTime + noteDuration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(noteTime);
      osc.stop(noteTime + noteDuration);
    });
  }

  // Fallback Suara Salah (Synthesizer Buzz)
  playWrongSynth() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const pulses = [
      { freq: 110, start: now, dur: 0.18 },
      { freq: 95, start: now + 0.22, dur: 0.35 }
    ];

    pulses.forEach(pulse => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(pulse.freq, pulse.start);

      gain.gain.setValueAtTime(0.001, pulse.start);
      gain.gain.linearRampToValueAtTime(0.6 * this.volume, pulse.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, pulse.start + pulse.dur);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(pulse.start);
      osc.stop(pulse.start + pulse.dur);
    });
  }

  // Suara Bel Klasik
  playBuzzer() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const duration = 0.55;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(145, now);
    osc1.frequency.exponentialRampToValueAtTime(120, now + duration);

    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(149, now);
    osc2.frequency.exponentialRampToValueAtTime(124, now + duration);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.frequency.exponentialRampToValueAtTime(600, now + duration);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.85 * this.volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration);
    osc2.stop(now + duration);
  }

  // Suara Bel Terbuka / Siap Berebut
  playUnlock() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(750, now + 0.18);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.4 * this.volume, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.25);
  }

  // Suara Reset
  playReset() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(260, now + 0.15);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.3 * this.volume, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.2);
  }

  // Suara Detik Timer
  playTick() {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.25 * this.volume, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.06);
  }
}

// Instance global
window.soundEngine = new SoundEngine();
