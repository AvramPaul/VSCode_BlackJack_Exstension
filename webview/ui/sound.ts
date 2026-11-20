/**
 * Short synthesized sounds (plan §7.2): WebAudio only, created on the first user action (autoplay rules),
 * quiet, and switched off by the in-game mute or `devjack.sound`.
 */
export type SoundName = 'card' | 'chip' | 'win' | 'blackjack' | 'lose' | 'needsYou' | 'shuffle';

export class Sound {
  private ctx: AudioContext | undefined;
  private unlocked = false;
  muted = false;
  allowed = true; // devjack.sound

  /** Call from a user gesture (key or click). */
  unlock() {
    this.unlocked = true;
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  private audio(): AudioContext | undefined {
    if (!this.unlocked || this.muted || !this.allowed) return undefined;
    if (!this.ctx) {
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!Ctor) return undefined;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  play(name: SoundName) {
    const ctx = this.audio();
    if (!ctx) return;
    const t = ctx.currentTime;
    switch (name) {
      case 'card':
        return this.noise(ctx, t, 0.07, 2600, 0.12);
      case 'shuffle':
        for (let i = 0; i < 6; i++) this.noise(ctx, t + i * 0.05, 0.05, 2200 + i * 150, 0.07);
        return;
      case 'chip':
        this.tone(ctx, t, 2900, 0.035, 0.05, 'triangle');
        return this.tone(ctx, t + 0.04, 3700, 0.03, 0.04, 'triangle');
      case 'win':
        this.tone(ctx, t, 784, 0.18, 0.06);
        return this.tone(ctx, t + 0.11, 1047, 0.24, 0.06);
      case 'blackjack':
        [784, 988, 1175, 1568].forEach((f, i) => this.tone(ctx, t + i * 0.08, f, 0.22, 0.05));
        return;
      case 'lose':
        return this.tone(ctx, t, 220, 0.2, 0.04, 'sine');
      case 'needsYou':
        this.tone(ctx, t, 880, 0.16, 0.06);
        return this.tone(ctx, t + 0.18, 660, 0.22, 0.06);
    }
  }

  private tone(ctx: AudioContext, at: number, freq: number, dur: number, vol: number, type: OscillatorType = 'sine') {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private noise(ctx: AudioContext, at: number, dur: number, freq: number, vol: number) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(at);
  }
}
