import type { Weight } from '../sim/moves';

export type Surface = 'canvas' | 'asphalt' | 'tile' | 'sand' | 'wood' | 'concrete' | 'gravel';
export type Ambience = 'ring' | 'street' | 'grocery' | 'colosseum' | 'warehouse' | 'bar' | 'dojo' | 'rooftop';
export type Material = 'wood' | 'metal' | 'pan' | 'axe' | 'glass';

/** Exponential ramps can't reach (or start from) zero: a quiet sound is just very quiet. */
const pos = (v: number) => (Number.isFinite(v) ? Math.max(0.0001, v) : 0.0001);

/** Procedural impact sounds (no assets): noise bursts + pitched thumps through a compressor. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  volume = 0.7;

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    if (this.wantAmbience) this.setAmbience(this.wantAmbience);
  }

  // -------------------------------------------------------------------------
  // Ambience: the room you fight in, and a crowd that reacts.
  // -------------------------------------------------------------------------

  private wantAmbience: Ambience | null = null;
  private ambNodes: AudioNode[] = [];
  private ambSources: AudioScheduledSourceNode[] = [];

  /** A looping, filtered noise bed (gain, filter, optional slow swell). */
  private hum(freq: number, gain: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(this.master);
    o.start();
    this.ambSources.push(o);
    this.ambNodes.push(g);
  }

  /** Swap the background sound for an arena. */
  setAmbience(kind: Ambience) {
    this.wantAmbience = kind;
    if (!this.ctx) return;
    for (const s of this.ambSources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    for (const n of this.ambNodes) n.disconnect();
    this.ambSources = [];
    this.ambNodes = [];
    // (No continuous noise beds: filtered hiss under everything reads as running
    // water, not a crowd. Only the rooms' own electrical hum stays.)
    switch (kind) {
      case 'warehouse':
        this.hum(50, 0.01);
        break;
      case 'bar':
        // A jukebox thumping somewhere.
        this.hum(55, 0.012);
        this.hum(82.4, 0.008);
        break;
      case 'grocery':
        // Fridges and fluorescent buzz.
        this.hum(60, 0.012);
        this.hum(120, 0.008);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Bodies: feet, breath, flesh.
  // -------------------------------------------------------------------------

  /** A foot landing. `weight` 0..1 (walk → sprint), bigger bodies thud lower. */
  footstep(surface: Surface, weight: number, scale = 1) {
    if (!this.ctx) return;
    const w = 0.35 + 0.65 * weight;
    const low = 1 / Math.sqrt(scale);
    switch (surface) {
      case 'canvas':
        this.thump(110 * low, 60 * low, 0.18 * w * scale, 0.07);
        this.noiseBurst('lowpass', 900, 0.7, 0.07 * w, 0.002, 0.05);
        if (Math.random() < 0.15) this.noiseBurst('bandpass', 2600, 6, 0.03, 0.005, 0.05); // shoe squeak
        break;
      case 'asphalt':
        this.thump(130 * low, 70 * low, 0.12 * w * scale, 0.05);
        this.noiseBurst('bandpass', 1600, 1.2, 0.09 * w, 0.002, 0.07, 900);
        break;
      case 'tile':
        this.noiseBurst('highpass', 3000, 0.9, 0.08 * w, 0.001, 0.03);
        this.thump(180 * low, 90 * low, 0.1 * w * scale, 0.04);
        break;
      case 'sand':
        this.noiseBurst('lowpass', 1100, 0.6, 0.11 * w, 0.01, 0.12, 500);
        this.thump(90 * low, 50 * low, 0.08 * w * scale, 0.06);
        break;
      case 'wood':
        // Hollow boards: a resonant knock.
        this.thump(160 * low, 95 * low, 0.16 * w * scale, 0.09, 'triangle');
        this.noiseBurst('bandpass', 700, 1.5, 0.06 * w, 0.002, 0.06);
        break;
      case 'concrete':
        this.thump(120 * low, 65 * low, 0.13 * w * scale, 0.05);
        this.noiseBurst('bandpass', 2200, 1, 0.08 * w, 0.001, 0.05, 1200);
        break;
      case 'gravel':
        this.noiseBurst('bandpass', 1800, 0.8, 0.12 * w, 0.004, 0.11, 900);
        this.noiseBurst('highpass', 4000, 0.6, 0.04 * w, 0.002, 0.06);
        this.thump(100 * low, 55 * low, 0.08 * w * scale, 0.05);
        break;
    }
  }

  /** Breath out on a strike — a sharp "tss" for quick ones, a heavier "hah" for big ones. */
  exhale(heavy: boolean, scale = 1) {
    if (!this.ctx) return;
    const low = 1 / Math.sqrt(scale);
    if (heavy) this.noiseBurst('bandpass', 1100 * low, 1.6, 0.11, 0.02, 0.16, 700 * low);
    else this.noiseBurst('bandpass', 4200 * low, 2.2, 0.06, 0.005, 0.07, 3000 * low);
  }

  /** One breath of a gassed fighter: in (higher) or out (lower, longer). */
  pant(out: boolean, intensity: number) {
    if (!this.ctx) return;
    if (out) this.noiseBurst('bandpass', 950, 1.8, 0.05 * intensity, 0.04, 0.22, 650);
    else this.noiseBurst('bandpass', 1600, 2.2, 0.03 * intensity, 0.06, 0.16, 2000);
  }

  /** A grunt when a big one lands. */
  grunt(scale = 1) {
    if (!this.ctx) return;
    const low = 1 / Math.sqrt(scale);
    this.noiseBurst('bandpass', 420 * low, 3, 0.18, 0.01, 0.16, 300 * low);
    this.thump(150 * low, 110 * low, 0.08, 0.14, 'sawtooth');
  }

  /** Fist or foot on a body: a crisp slap on the face, a deep thud to the body. */
  flesh(head: boolean, weight: Weight) {
    if (!this.ctx) return;
    const w = weight === 'light' ? 0.6 : weight === 'medium' ? 0.8 : 1;
    if (head) {
      this.noiseBurst('highpass', 1800, 0.7, 0.45 * w, 0.001, 0.05);
      this.thump(220, 90, 0.4 * w, 0.08);
    } else {
      this.noiseBurst('lowpass', 700, 0.8, 0.5 * w, 0.002, 0.09);
      this.thump(110, 45, 0.75 * w, 0.16);
    }
  }

  /** What the weapon is made of, when it lands. */
  impact(material: Material, heavy: boolean) {
    if (!this.ctx) return;
    switch (material) {
      case 'wood':
        // Bat / club / haft: a hollow knock.
        this.thump(380, 180, 0.4, 0.09, 'triangle');
        this.noiseBurst('bandpass', 900, 3, 0.4, 0.001, 0.07);
        this.thump(100, 45, heavy ? 0.7 : 0.45, 0.16);
        break;
      case 'pan': {
        // A frying pan rings like a bell.
        const f = 480 + Math.random() * 60;
        this.thump(f, f * 0.99, 0.22, 0.9, 'sine');
        this.thump(f * 2.76, f * 2.74, 0.08, 0.5, 'sine');
        this.thump(f * 5.4, f * 5.38, 0.04, 0.3, 'sine');
        this.thump(110, 50, 0.5, 0.12);
        break;
      }
      case 'metal':
        // Folding chair: a clattering bang.
        for (let i = 0; i < 3; i++) this.thump(700 + Math.random() * 900, 400, 0.08, 0.12 + i * 0.05, 'square');
        this.noiseBurst('bandpass', 2400, 2, 0.4, 0.001, 0.14);
        this.thump(120, 50, 0.6, 0.14);
        break;
      case 'glass':
        // A heavy bottle: a hard clink and a dull knock.
        this.thump(2100, 1900, 0.1, 0.08, 'sine');
        this.noiseBurst('highpass', 3500, 1.2, 0.3, 0.001, 0.05);
        this.thump(130, 55, 0.55, 0.12);
        break;
      case 'axe':
        // Heavy blade biting in: a deep chop.
        this.thump(140, 45, 0.9, 0.22);
        this.noiseBurst('lowpass', 1400, 0.8, 0.6, 0.001, 0.12, 400);
        break;
    }
  }

  /** A weapon thudding against a body with nothing behind it. */
  bump() {
    if (!this.ctx) return;
    this.thump(140, 70, 0.3, 0.08);
    this.noiseBurst('lowpass', 600, 0.8, 0.2, 0.002, 0.06);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  private noiseBurst(type: BiquadFilterType, freq: number, q: number, gain: number, attack: number, decay: number, sweepTo?: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(pos(sweepTo), t + attack + decay);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pos(gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  private thump(from: number, to: number, gain: number, decay: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(pos(to), t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(pos(gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  hit(weight: Weight, counter = false) {
    if (!this.ctx) return;
    const w = weight === 'light' ? 0 : weight === 'medium' ? 1 : 2;
    this.noiseBurst('lowpass', [2600, 1800, 1200][w], 0.8, [0.5, 0.7, 0.9][w], 0.002, [0.07, 0.1, 0.16][w]);
    this.thump([170, 140, 120][w], [70, 55, 40][w], [0.5, 0.7, 0.95][w], [0.1, 0.14, 0.22][w]);
    if (w >= 1) this.noiseBurst('highpass', 3500, 0.7, 0.35, 0.001, 0.03);
    if (counter) this.thump(900, 600, 0.12, 0.12, 'triangle');
  }

  block(heavy: boolean) {
    if (!this.ctx) return;
    this.noiseBurst('bandpass', 1400, 2.5, 0.6, 0.002, heavy ? 0.09 : 0.06);
    this.thump(260, 140, 0.35, 0.08, 'square');
  }

  whoosh(weight: Weight) {
    if (!this.ctx) return;
    const w = weight === 'light' ? 0 : weight === 'medium' ? 1 : 2;
    this.noiseBurst('bandpass', [900, 700, 500][w], 1.2, [0.12, 0.18, 0.26][w], 0.03, [0.08, 0.11, 0.16][w], [2400, 2000, 1500][w]);
  }

  dodge() {
    if (!this.ctx) return;
    this.noiseBurst('bandpass', 500, 0.9, 0.12, 0.04, 0.12, 1400);
  }

  counterReady() {
    if (!this.ctx) return;
    this.thump(1320, 1300, 0.07, 0.18, 'sine');
    this.thump(1980, 1970, 0.04, 0.14, 'sine');
  }

  coin() {
    if (!this.ctx) return;
    const f = 1300 + Math.random() * 300;
    this.thump(f, f * 1.01, 0.08, 0.09, 'square');
    this.thump(f * 1.5, f * 1.5, 0.05, 0.14, 'sine');
  }

  /** Edge through flesh: a wet, tearing high-frequency rip plus a dull thud. */
  slice(heavy: boolean) {
    if (!this.ctx) return;
    this.noiseBurst('highpass', 2200, 0.9, heavy ? 0.6 : 0.45, 0.002, heavy ? 0.16 : 0.1, 6000);
    this.noiseBurst('bandpass', 700, 1.4, 0.5, 0.004, heavy ? 0.2 : 0.12, 300);
    this.thump(heavy ? 120 : 150, 50, heavy ? 0.7 : 0.45, heavy ? 0.2 : 0.12);
  }

  /** A limb coming off: crunch and a heavy wet tear. */
  sever() {
    if (!this.ctx) return;
    this.noiseBurst('bandpass', 1800, 3, 0.7, 0.001, 0.05);
    this.noiseBurst('lowpass', 900, 0.6, 0.8, 0.004, 0.35, 200);
    this.thump(95, 35, 0.9, 0.3);
  }

  /** Metal and wood: grabbing or dropping a weapon. */
  clank(pickup: boolean) {
    if (!this.ctx) return;
    this.thump(pickup ? 620 : 420, pickup ? 900 : 300, 0.12, 0.1, 'square');
    this.noiseBurst('bandpass', pickup ? 3200 : 2000, 4, 0.25, 0.001, 0.12);
  }

  /**
   * Something hitting the floor: heavier is lower and longer, metal rings, wood knocks.
   * @param mass kg  @param metal metal (vs wood)  @param hard 0..1 how hard it landed
   */
  landing(mass: number, metal: boolean, hard = 1) {
    if (!this.ctx) return;
    const h = Math.max(0.15, Math.min(1, hard));
    const low = 1 / Math.sqrt(Math.max(0.3, mass));
    this.thump(150 * low, 55 * low, Math.min(0.9, 0.18 * Math.sqrt(mass)) * h, 0.08 + 0.05 * mass);
    if (metal) {
      this.noiseBurst('bandpass', 2600 * low + 900, 6, 0.22 * h, 0.001, 0.12 + 0.03 * mass);
      this.thump(900 * low + 300, 880 * low + 280, 0.05 * h, 0.25, 'triangle');
    } else {
      this.noiseBurst('bandpass', 900 * low + 300, 2, 0.16 * h, 0.001, 0.07);
    }
  }

  chime() {
    if (!this.ctx) return;
    this.thump(660, 660, 0.08, 0.5, 'sine');
    this.thump(990, 990, 0.06, 0.7, 'sine');
  }

  /** A body hitting the floor: deeper and longer the heavier it is. */
  bodyFall(mass: number, hard = 1) {
    if (!this.ctx) return;
    const h = Math.max(0.2, Math.min(1, hard));
    const low = 1 / Math.cbrt(Math.max(0.3, mass));
    this.thump(95 * low, 32 * low, Math.min(1, 0.6 + 0.12 * mass) * h, 0.3 + 0.08 * Math.min(4, mass));
    this.noiseBurst('lowpass', 520 * low, 0.7, 0.45 * h, 0.004, 0.25 + 0.05 * Math.min(4, mass));
  }

  knockdown() {
    if (!this.ctx) return;
    this.thump(90, 35, 0.9, 0.35);
    this.noiseBurst('lowpass', 500, 0.7, 0.5, 0.005, 0.3);
  }

  ko() {
    if (!this.ctx) return;
    this.thump(70, 28, 1, 0.8);
    this.noiseBurst('lowpass', 900, 0.5, 0.7, 0.003, 0.5);
    this.thump(440, 220, 0.15, 0.6, 'triangle');
  }
}
