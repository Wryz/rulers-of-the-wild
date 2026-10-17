// Procedural sound (docs/M1-DESIGN.md §10.9; SPEC:581, 849-851): DungeonStyle's WebAudio synth — noise bursts and pitched
// thumps through a compressor, no assets — extended to the Clearing: chops, wood creaking and cracking, rope strain and
// snaps, thuds by mass and material, a tree's fall and crash, digging, knapping, footsteps by surface, the giant's
// footfalls and roar, the ape's hoot, and the jungle that goes quiet when the giant is near.
//
// Audio is presentation (rule 6): nothing here is read by the sim, and it never touches the sim's random streams (rule
// 7; the variety below is the browser's Math.random). Every Sfx method is a no-op until unlock() has made an
// AudioContext, so the game runs (and tests run) without one. feel/sfxPort.ts decides which sound each sim event makes.
//
// Every starting value that sets a level, a range, a rate or a threshold is in FEEL_TUNING (the dev panel's
// "Client › feel"); the master volume is GAME_TUNING.volume. A sound's recipe — the partials, filters and envelopes that
// make a chop sound like a chop — is its definition and stays in its method, as DungeonStyle's recipes do.
import { defineTuning } from '@wild/sim';
import { GAME_TUNING } from '../game/game';

/** What a foot lands on (§10.9). */
export type Surface = 'grass' | 'dirt' | 'leaves' | 'rock' | 'log';
/** The background bed (§10.9: the Clearing's jungle; 'none' is silence). */
export type Ambience = 'jungle' | 'none';
/**
 * What a struck or landing thing sounds like. Renamed from DungeonStyle's `Material` (it collided with the sim's
 * Material, MAP client §9); 'stone' is new (stone tools and throwing stones).
 */
export type ImpactSound = 'wood' | 'metal' | 'pan' | 'axe' | 'glass' | 'stone';
/** A sim material's sound family (feel/sfxPort.ts maps MaterialId → this). */
export type SoundMaterial = 'wood' | 'stone' | 'dirt' | 'leaves' | 'rope' | 'soft' | 'bone';

/** A weight class of a blow (DungeonStyle's Weight, repeated so audio needs no sim type). */
type Weight = 'light' | 'medium' | 'heavy';

const metaF = (unit: string, source: string, min: number, max: number, step: number, label?: string) =>
  label === undefined ? { unit, source, min, max, step } : { unit, source, min, max, step, label };

/**
 * Feel: sound levels and ranges, and the giant's footfalls felt through the camera. §9.1's four rows first; the rest
 * are this package's starting values (`NEW: P37`), each with what it sets.
 */
export const FEEL_TUNING = defineTuning(
  'FEEL_TUNING',
  'Client › feel',
  {
    giantShakeRadiusPerScale: 6,
    giantShakePerScale: 0.05,
    ambienceQuietRangeM: 40,
    creakFrom: 0.5,
    mix: { compressorThresholdDb: -14, compressorRatio: 6 },
    space: { refDistM: 6, maxDistM: 160, pan: 0.7, inaudibleGain: 0.01 },
    steps: { runSpeed: 3.8, giantFromScale: 2.5, coverGrass: 0.35, onEntityM: 0.12, jumpLandSpeed: 3.2, jumpLandScaleMul: 1.15, teleportSpeed: 30 },
    thuds: { bodyHardSpeed: 5, entityHardSpeed: 8, minEnergyJ: 2 },
    creaks: { ropePeriodS: 1.2, treePeriodS: 1.8, treeFallWhooshS: 0.7 },
    jungle: { gain: 0.6, birdsPerS: 0.4, insectGain: 0.012, windGain: 0.01, fadeS: 2.5 },
    loud: { step: 1, combat: 1.5, chop: 3, creak: 2, crack: 4, snap: 4, dig: 2, treeFall: 8, crash: 10, giantStep: 6, roar: 20, hoot: 6 },
  },
  {
    giantShakeRadiusPerScale: metaF('m per scale', 'NEW: SPEC:849 (§10.9: felt inside 6·scale m, 33 m for the giant)', 0, 20, 0.5, 'giant shake radius / scale'),
    giantShakePerScale: metaF('trauma per scale', 'NEW: SPEC:849 (§10.9: 0.05·(scale − 1)·near; DS game.ts footsteps)', 0, 0.5, 0.005, 'giant shake / scale'),
    ambienceQuietRangeM: metaF('m', 'NEW: SPEC:851 (the jungle goes quiet when a ruler is near)', 0, 200, 1, 'jungle quiet range'),
    creakFrom: metaF('strain', 'NEW: SPEC:357 (rope under tension creaks louder near breaking)', 0, 1, 0.01, 'rope creaks from'),
    mix: {
      compressorThresholdDb: metaF('dB', 'DS (audio.ts unlock)', -60, 0, 1, 'compressor threshold'),
      compressorRatio: metaF('×', 'DS (audio.ts unlock)', 1, 20, 0.5, 'compressor ratio'),
    },
    space: {
      refDistM: metaF('m', 'NEW: P37 (full volume within this, × the sound family\'s loud)', 0.5, 50, 0.5, 'reference distance'),
      maxDistM: metaF('m', 'NEW: P37 (silent beyond this, × loud)', 10, 1000, 5, 'max distance'),
      pan: metaF('0-1', 'NEW: P37 (how far left/right a sound beside the camera is panned)', 0, 1, 0.05),
      inaudibleGain: metaF('0-1', 'NEW: P37 (quieter than this is not played)', 0, 0.2, 0.005, 'inaudible below'),
    },
    steps: {
      runSpeed: metaF('m/s (÷ scale)', 'DS (game.ts footsteps: weight = speed / 3.8)', 0.5, 10, 0.1, 'full-weight step speed'),
      giantFromScale: metaF('× scale', 'NEW: P37 (a fighter this big steps as a giant: giantStep)', 1, 10, 0.1, 'giant steps from scale'),
      coverGrass: metaF('cover 0-1', 'NEW: P37 (ground cover above this sounds like grass)', 0, 1, 0.05, 'grass from cover'),
      onEntityM: metaF('m', 'NEW: P37 (a foot this far above the terrain stands on an entity)', 0, 1, 0.01, 'on an entity above'),
      jumpLandSpeed: metaF('m/s', 'NEW: P37 (a fall at least this fast lands with both feet, DS landings)', 0.5, 15, 0.1, 'jump landing from'),
      jumpLandScaleMul: metaF('× scale', 'DS (game.ts landings: footstep(…, 1.15·scale))', 0.5, 3, 0.05, 'jump landing weight'),
      teleportSpeed: metaF('m/s', 'NEW: P37 (faster than this between frames is a teleport, not a fall)', 5, 200, 1, 'teleport speed'),
    },
    thuds: {
      bodyHardSpeed: metaF('m/s', 'DS (game.ts bodyLanding: hard = fall speed / 5)', 0.5, 20, 0.5, 'body hard at'),
      entityHardSpeed: metaF('m/s', 'DS (game.ts thud: hard = speed / 12), for the Clearing\'s heavier things', 0.5, 30, 0.5, 'entity hard at'),
      minEnergyJ: metaF('J', 'NEW: P37 (a landing with less energy makes no thud)', 0, 100, 0.5, 'quietest thud'),
    },
    creaks: {
      ropePeriodS: metaF('s', 'NEW: SPEC:357 (one creak this often at creakFrom, quicker toward breaking)', 0.1, 10, 0.05, 'rope creak period'),
      treePeriodS: metaF('s', 'NEW: SPEC:581 (a notched tree creaks before it goes)', 0.1, 10, 0.05, 'tree creak period'),
      treeFallWhooshS: metaF('s', 'NEW: SPEC:581 (the crown\'s whoosh after the first creak of a fall)', 0, 3, 0.05, 'fall whoosh after'),
    },
    jungle: {
      gain: metaF('0-1', 'NEW: SPEC:851 (the jungle bed\'s level)', 0, 2, 0.05),
      birdsPerS: metaF('calls/s', 'NEW: SPEC:851', 0, 5, 0.05, 'bird calls / s'),
      insectGain: metaF('0-1', 'NEW: SPEC:851', 0, 0.1, 0.001, 'insects'),
      windGain: metaF('0-1', 'NEW: SPEC:851', 0, 0.1, 0.001, 'wind'),
      fadeS: metaF('s', 'NEW: SPEC:851 (how fast the jungle hushes and comes back)', 0.1, 20, 0.1, 'hush fade'),
    },
    loud: {
      step: metaF('× ref distance', 'NEW: P37 (how far a footstep carries)', 0.1, 50, 0.1),
      combat: metaF('× ref distance', 'NEW: P37 (DS blows, blocks, swings)', 0.1, 50, 0.1),
      chop: metaF('× ref distance', 'NEW: P37', 0.1, 50, 0.1),
      creak: metaF('× ref distance', 'NEW: P37', 0.1, 50, 0.1),
      crack: metaF('× ref distance', 'NEW: P37', 0.1, 50, 0.1),
      snap: metaF('× ref distance', 'NEW: P37', 0.1, 50, 0.1),
      dig: metaF('× ref distance', 'NEW: P37', 0.1, 50, 0.1),
      treeFall: metaF('× ref distance', 'NEW: P37', 0.1, 50, 0.1, 'tree fall'),
      crash: metaF('× ref distance', 'NEW: P37 (a felled tree or a heavy thing landing)', 0.1, 50, 0.1),
      giantStep: metaF('× ref distance', 'NEW: SPEC:849', 0.1, 50, 0.1, 'giant step'),
      roar: metaF('× ref distance', 'NEW: SPEC:850 (every ruler has a distinct roar)', 0.1, 100, 0.5),
      hoot: metaF('× ref distance', 'NEW: P37 (the ape\'s call)', 0.1, 50, 0.1),
    },
  },
);

/**
 * How hard a giant's footfall jolts the camera of someone `distM` away (§10.9): 0.05·(scale − 1)·near, near =
 * 1 − distance / (6·scale), so the giant (scale 5.5) is felt inside 33 m. For the camera (render owners wire it).
 */
export function giantStepTrauma(scale: number, distM: number): number {
  const T = FEEL_TUNING;
  const radius = T.giantShakeRadiusPerScale * scale;
  if (!(radius > 0) || scale <= 1) return 0;
  const near = Math.max(0, 1 - distM / radius);
  return T.giantShakePerScale * (scale - 1) * near;
}

/** The volume of a sound `distM` from the listener: 1 within the reference distance, then ref/d, 0 past the max. */
export function distanceGain(distM: number, loud = 1): number {
  const S = FEEL_TUNING.space;
  const ref = Math.max(1e-3, S.refDistM * loud);
  if (distM > S.maxDistM * loud) return 0;
  return distM <= ref ? 1 : ref / distM;
}

/** Exponential ramps can't reach (or start from) zero: a quiet sound is just very quiet. */
const pos = (v: number) => (Number.isFinite(v) ? Math.max(0.0001, v) : 0.0001);
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Procedural sounds (no assets): noise bursts + pitched thumps through a compressor. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  /** Where the next sound goes: the master, or an emitter's gain and pan (emit). */
  private out!: AudioNode;
  private noise!: AudioBuffer;
  /** Seconds after now the next sound starts (later). */
  private offset = 0;
  volume = GAME_TUNING.volume;

  /** Must be called from a user gesture (browsers only start audio from one). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    if (typeof window === 'undefined') return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.attach(new Ctx());
  }

  /** Builds the graph on an AudioContext (unlock; tests hand in a fake one). */
  attach(ctx: AudioContext) {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    this.comp = comp;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp).connect(ctx.destination);
    this.out = this.master;
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0;
    this.ambBus.connect(this.master);
    this.applyTuning();
    if (this.wantAmbience) this.setAmbience(this.wantAmbience);
  }

  /**
   * Applies FEEL_TUNING's mix and ambience levels to the running graph (the panel edits them live; feel/sfxPort.ts
   * calls this once a frame, and it only touches what changed).
   */
  applyTuning() {
    if (!this.ctx) return;
    const T = FEEL_TUNING;
    const J = T.jungle;
    const key = `${T.mix.compressorThresholdDb}|${T.mix.compressorRatio}|${J.gain}|${J.insectGain}|${J.windGain}|${J.fadeS}`;
    if (key === this.tuned) return;
    this.tuned = key;
    this.comp.threshold.value = T.mix.compressorThresholdDb;
    this.comp.ratio.value = T.mix.compressorRatio;
    if (this.bed) {
      this.bed.insects.gain.value = J.insectGain;
      this.bed.swell.gain.value = J.insectGain * 0.8;
      this.bed.wind.gain.value = J.windGain;
    }
    this.applyJungleLevel();
  }

  private tuned = '';

  /** Is there an AudioContext (has unlock run)? */
  get live(): boolean {
    return this.ctx !== null;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  /**
   * Plays what `fn` makes as if from an emitter: `gain` 0..1 (distance), `pan` −1 (left) … 1 (right). Every sound
   * method called inside `fn` goes through this emitter.
   */
  emit(gain: number, pan: number, fn: () => void) {
    if (!this.ctx) return;
    if (!(gain > FEEL_TUNING.space.inaudibleGain)) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, gain);
    const p = Math.max(-1, Math.min(1, pan));
    if (p !== 0 && typeof ctx.createStereoPanner === 'function') {
      const sp = ctx.createStereoPanner();
      sp.pan.value = p;
      g.connect(sp).connect(this.master);
    } else g.connect(this.master);
    const prev = this.out;
    this.out = g;
    try {
      fn();
    } finally {
      this.out = prev;
    }
  }

  /** Plays what `fn` makes `delayS` seconds from now (a fall's whoosh after its first creak). */
  later(delayS: number, fn: () => void) {
    if (!this.ctx) return;
    const prev = this.offset;
    this.offset = prev + Math.max(0, delayS);
    try {
      fn();
    } finally {
      this.offset = prev;
    }
  }

  // -------------------------------------------------------------------------
  // Ambience: the jungle (birds, insects, wind) that hushes when a ruler is near (SPEC:851).
  // -------------------------------------------------------------------------

  private wantAmbience: Ambience | null = null;
  private ambBus!: GainNode;
  private ambNodes: AudioNode[] = [];
  private ambSources: AudioScheduledSourceNode[] = [];
  /** The jungle bed's level controls (setAmbience('jungle')). */
  private bed: { insects: GainNode; swell: GainNode; wind: GainNode } | null = null;
  private jungleLevel = 1;
  private birdT = 0;

  /** Swap the background bed. */
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
    this.bed = null;
    if (kind === 'none') {
      this.applyJungleLevel();
      return;
    }
    const ctx = this.ctx;
    const J = FEEL_TUNING.jungle;
    // Insects: a cicada buzz (a high tone chopped at ~40 Hz), swelling slowly in and out.
    const tone = ctx.createOscillator();
    tone.frequency.value = 4600;
    const chop = ctx.createGain();
    chop.gain.value = 0.5;
    const chopLfo = ctx.createOscillator();
    chopLfo.type = 'square';
    chopLfo.frequency.value = 42;
    const chopDepth = ctx.createGain();
    chopDepth.gain.value = 0.5;
    chopLfo.connect(chopDepth).connect(chop.gain);
    const insects = ctx.createGain();
    insects.gain.value = J.insectGain;
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.07;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = J.insectGain * 0.8;
    swell.connect(swellDepth).connect(insects.gain);
    tone.connect(chop).connect(insects).connect(this.ambBus);
    // Wind: a low, slow rumble (kept low: filtered hiss under everything reads as running water, DS).
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    wind.playbackRate.value = 0.25;
    const windLp = ctx.createBiquadFilter();
    windLp.type = 'lowpass';
    windLp.frequency.value = 260;
    const windGain = ctx.createGain();
    windGain.gain.value = J.windGain;
    wind.connect(windLp).connect(windGain).connect(this.ambBus);
    for (const s of [tone, chopLfo, swell, wind]) {
      s.start();
      this.ambSources.push(s);
    }
    this.ambNodes.push(chop, chopDepth, insects, swellDepth, windLp, windGain);
    this.bed = { insects, swell: swellDepth, wind: windGain };
    this.applyJungleLevel();
  }

  /** How alive the jungle is, 0 (hushed: a ruler is near) … 1; it fades there over FEEL_TUNING.jungle.fadeS. */
  setJungleLevel(level: number) {
    if (!this.ctx) return;
    const l = clamp01(level);
    if (Math.abs(l - this.jungleLevel) < 0.01) return;
    this.jungleLevel = l;
    this.applyJungleLevel();
  }

  private applyJungleLevel() {
    const ctx = this.ctx;
    if (!ctx) return;
    const g = this.ambBus.gain;
    const target = this.wantAmbience === 'jungle' ? FEEL_TUNING.jungle.gain * this.jungleLevel : 0;
    g.cancelScheduledValues(ctx.currentTime);
    g.setTargetAtTime(target, ctx.currentTime, Math.max(0.01, FEEL_TUNING.jungle.fadeS / 3));
  }

  /** Per rendered frame of game time: the birds call now and then (fewer as the jungle hushes). */
  ambienceTick(dt: number) {
    if (!this.ctx || this.wantAmbience !== 'jungle' || !(dt > 0)) return;
    this.birdT -= dt;
    if (this.birdT > 0) return;
    this.birdT = -Math.log(1 - Math.random() * 0.999) / Math.max(1e-3, FEEL_TUNING.jungle.birdsPerS);
    if (Math.random() > this.jungleLevel) return;
    // A bird somewhere around: left or right, near or far.
    const prev = this.out;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = rand(0.15, 0.6);
    if (typeof ctx.createStereoPanner === 'function') {
      const sp = ctx.createStereoPanner();
      sp.pan.value = rand(-0.9, 0.9);
      g.connect(sp).connect(this.ambBus);
    } else g.connect(this.ambBus);
    this.out = g;
    try {
      this.birdCall();
    } finally {
      this.out = prev;
    }
  }

  /** A few quick whistled notes. */
  private birdCall() {
    const base = rand(1900, 3600);
    const notes = 2 + Math.floor(Math.random() * 4);
    const gap = rand(0.07, 0.16);
    for (let i = 0; i < notes; i++) {
      const up = Math.random() < 0.5;
      this.tone(base * (up ? 0.9 : 1.15), base * (up ? 1.2 : 0.85), 0.05, rand(0.05, 0.09), 'sine', i * gap);
    }
  }

  // -------------------------------------------------------------------------
  // Bodies: feet, breath, flesh.
  // -------------------------------------------------------------------------

  /** A foot landing. `weight` 0..1 (walk → sprint), bigger bodies thud lower. */
  footstep(surface: Surface, weight: number, scale = 1) {
    if (!this.ctx) return;
    const w = 0.35 + 0.65 * clamp01(weight);
    const low = 1 / Math.sqrt(Math.max(0.1, scale));
    switch (surface) {
      case 'grass':
        // A soft swish over a muffled thud.
        this.noiseBurst('highpass', 2600, 0.7, 0.07 * w, 0.01, 0.09, 4200);
        this.thump(100 * low, 55 * low, 0.1 * w * scale, 0.06);
        break;
      case 'dirt':
        // Packed earth: a dull crunch (DS sand).
        this.noiseBurst('lowpass', 1100, 0.6, 0.11 * w, 0.006, 0.1, 500);
        this.thump(95 * low, 50 * low, 0.12 * w * scale, 0.06);
        break;
      case 'leaves':
        // Dry leaves crackle under the foot.
        for (let i = 0; i < 3; i++) this.noiseBurst('bandpass', rand(2200, 5200), 3, 0.06 * w, 0.001, rand(0.02, 0.05), undefined, i * rand(0.01, 0.035));
        this.thump(90 * low, 50 * low, 0.07 * w * scale, 0.05);
        break;
      case 'rock':
        // A hard click and a short knock (DS tile/concrete).
        this.noiseBurst('highpass', 3000, 0.9, 0.07 * w, 0.001, 0.03);
        this.thump(170 * low, 90 * low, 0.11 * w * scale, 0.04);
        break;
      case 'log':
        // Hollow wood: a resonant knock (DS boards).
        this.thump(160 * low, 95 * low, 0.16 * w * scale, 0.09, 'triangle');
        this.noiseBurst('bandpass', 700, 1.5, 0.06 * w, 0.002, 0.06);
        break;
    }
  }

  /** A giant's footfall: a ground-shaking thump, more of it the nearer (`near` 0..1), and a far rumble always. */
  giantStep(near: number) {
    if (!this.ctx) return;
    const n = clamp01(near);
    this.thump(46, 21, 0.55 + 0.45 * n, 0.55 + 0.25 * n);
    this.noiseBurst('lowpass', 240, 0.7, 0.25 + 0.35 * n, 0.01, 0.45);
    if (n > 0.2) this.noiseBurst('bandpass', 1500, 1.2, 0.08 * n, 0.002, 0.12, 700, 0.04); // debris rattle
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
  impact(sound: ImpactSound, heavy: boolean) {
    if (!this.ctx) return;
    switch (sound) {
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
      case 'stone':
        // A stone head: a hard clack and a dense knock.
        this.noiseBurst('highpass', 2800, 1.4, 0.4, 0.001, 0.035);
        this.thump(900, 600, 0.08, 0.05, 'triangle');
        this.thump(120, 50, heavy ? 0.75 : 0.5, 0.14);
        break;
    }
  }

  /** A weapon thudding against a body with nothing behind it. */
  bump() {
    if (!this.ctx) return;
    this.thump(140, 70, 0.3, 0.08);
    this.noiseBurst('lowpass', 600, 0.8, 0.2, 0.002, 0.06);
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
   * Something small hitting the floor (DS): heavier is lower and longer, metal rings, wood knocks.
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

  /**
   * A thing of the Clearing landing or struck (SPEC:849: impacts by material and mass): a log, a stone, a dirt pile,
   * an armful of leaves. Pitch falls with the cube root of the mass (an audible floor keeps 800 kg a sound, not a
   * tremor), the knock's colour is the material's. `hard` 0..1.
   */
  thud(massKg: number, material: SoundMaterial, hard = 1) {
    if (!this.ctx) return;
    const h = Math.max(0.15, clamp01(hard));
    const m = Math.max(0.05, massKg);
    const low = Math.max(0.22, Math.min(2.5, Math.cbrt(10 / m)));
    const body = Math.min(1, 0.25 + 0.18 * Math.log10(1 + m)) * h;
    const tail = Math.min(0.9, 0.08 + 0.09 * Math.log10(1 + m));
    switch (material) {
      case 'wood':
        this.thump(170 * low, 60 * low, body, tail + 0.05);
        this.thump(420 * low, 210 * low, 0.18 * h, 0.07, 'triangle'); // hollow knock
        this.noiseBurst('bandpass', 800 * low + 200, 1.8, 0.2 * h, 0.001, 0.08);
        break;
      case 'stone':
        this.noiseBurst('highpass', 2400, 1.2, 0.35 * h, 0.001, 0.04); // the clack
        this.thump(200 * low, 70 * low, body, tail);
        this.noiseBurst('bandpass', 1300 * low + 400, 2.5, 0.12 * h, 0.001, 0.06);
        break;
      case 'dirt':
        this.thump(110 * low, 40 * low, body * 0.9, tail + 0.05);
        this.noiseBurst('lowpass', 900, 0.6, 0.3 * h, 0.006, 0.18, 300); // a dull crumble
        break;
      case 'leaves':
        this.noiseBurst('highpass', 3200, 0.6, 0.18 * h, 0.01, 0.22, 5200);
        this.thump(90 * low, 45 * low, body * 0.4, 0.08);
        break;
      case 'rope':
        this.noiseBurst('bandpass', 1500, 1.2, 0.12 * h, 0.004, 0.08);
        this.thump(120 * low, 70 * low, body * 0.35, 0.06);
        break;
      case 'bone':
        this.noiseBurst('bandpass', 2600, 3, 0.25 * h, 0.001, 0.04);
        this.thump(260 * low, 120 * low, body * 0.6, 0.07, 'triangle');
        break;
      case 'soft':
        this.thump(100 * low, 45 * low, body * 0.8, tail);
        this.noiseBurst('lowpass', 600, 0.8, 0.25 * h, 0.003, 0.1);
        break;
    }
  }

  chime() {
    if (!this.ctx) return;
    this.thump(660, 660, 0.08, 0.5, 'sine');
    this.thump(990, 990, 0.06, 0.7, 'sine');
  }

  /** A body hitting the floor: deeper and longer the heavier it is (mass in humans: 1 = one adult). */
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

  // -------------------------------------------------------------------------
  // Wood, rope, stone, earth (SPEC:357, 362, 581, 849).
  // -------------------------------------------------------------------------

  /** An axe biting into a trunk (or a blunt knock on one): thicker trunks knock lower. */
  chop(diameterM: number, edged = true) {
    if (!this.ctx) return;
    const d = Math.max(0.02, Math.min(1.5, diameterM));
    const low = Math.sqrt(0.3 / d);
    this.thump(430 * low, 170 * low, 0.32, 0.07, 'triangle');
    this.thump(135 * low, 60 * low, 0.6, 0.16);
    if (edged) {
      this.noiseBurst('bandpass', 2600, 2.5, 0.35, 0.001, 0.05, 1200);
      this.noiseBurst('highpass', 5000, 1, 0.12, 0.001, 0.03, undefined, 0.012); // chips flying
    } else this.noiseBurst('lowpass', 900, 0.8, 0.3, 0.002, 0.08);
  }

  /**
   * Wood or rope under strain: a stick-slip groan, louder, higher and longer the closer to breaking (`intensity`
   * 0..1). Ropes over FEEL_TUNING.creakFrom, notched trees before they go, a tree as it starts to fall.
   */
  creak(intensity: number) {
    if (!this.ctx) return;
    const i = clamp01(intensity);
    const ctx = this.ctx;
    const t = ctx.currentTime + this.offset;
    const dur = 0.3 + 0.6 * i;
    const f0 = rand(65, 120) + 50 * i;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * rand(1.1, 1.35), t + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650 + 550 * i;
    bp.Q.value = 6;
    // Stick-slip: the groan stutters at 12-30 Hz.
    const am = ctx.createGain();
    am.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 12 + 18 * i + rand(-2, 2);
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(am.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pos(0.06 + 0.24 * i), t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(am).connect(g).connect(this.out);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /** Something breaking: wood splinters (a sharp crack and a crackle), stone cracks; heavier is deeper. */
  crack(massKg: number, kind: 'wood' | 'stone' = 'wood') {
    if (!this.ctx) return;
    const m = Math.max(0.1, massKg);
    const low = Math.max(0.3, Math.min(2, Math.cbrt(20 / m)));
    if (kind === 'stone') {
      this.noiseBurst('highpass', 2000, 1, 0.55, 0.001, 0.05);
      this.thump(240 * low, 90 * low, 0.5, 0.12);
      this.noiseBurst('bandpass', 1200 * low + 300, 3, 0.25, 0.001, 0.1, undefined, 0.02);
      return;
    }
    this.noiseBurst('highpass', 1800, 0.9, 0.7, 0.001, 0.04); // the crack
    this.thump(300 * low, 90 * low, 0.45, 0.1, 'triangle');
    const splinters = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < splinters; i++) {
      this.noiseBurst('bandpass', rand(1500, 4500), 4, rand(0.08, 0.2), 0.001, rand(0.015, 0.04), undefined, 0.02 + i * rand(0.012, 0.03));
    }
  }

  /** A rope snapping: a whip crack and the twang of the parted ends. */
  snap() {
    if (!this.ctx) return;
    this.noiseBurst('highpass', 3200, 0.8, 0.75, 0.001, 0.025);
    this.thump(340, 75, 0.3, 0.22, 'triangle');
    this.noiseBurst('bandpass', 900, 1.5, 0.2, 0.004, 0.18, 2600, 0.02); // the ends whipping through the air
  }

  /**
   * A tree starting to fall (SPEC:581): a long groan, then the crown's whoosh. Its crash is treeLand, played when the
   * sim says it landed (the `land` event), so the sound follows the sim.
   */
  treeFall(massKg: number) {
    if (!this.ctx) return;
    const big = clamp01(Math.log10(Math.max(1, massKg)) / 3.2);
    this.creak(0.8 + 0.2 * big);
    this.later(FEEL_TUNING.creaks.treeFallWhooshS, () => {
      this.creak(1);
      this.noiseBurst('bandpass', 280, 0.8, 0.22 + 0.2 * big, 0.5, 1.1, 1400); // leaves rushing through the air
    });
  }

  /** A felled tree hitting the ground: DS landing's thud at the tree's mass, branches cracking, leaves thrashing. */
  treeLand(massKg: number) {
    if (!this.ctx) return;
    const m = Math.max(1, massKg);
    const low = Math.max(0.25, Math.min(1, Math.cbrt(150 / m)));
    this.thump(85 * low, 22, 1, 0.9);
    this.noiseBurst('lowpass', 420, 0.6, 0.85, 0.008, 0.7, 120);
    for (let i = 0; i < 6; i++) this.noiseBurst('bandpass', rand(900, 3200), 3, rand(0.15, 0.35), 0.001, rand(0.03, 0.08), undefined, rand(0, 0.35));
    this.noiseBurst('highpass', 3000, 0.6, 0.35, 0.02, 0.6, 5500, 0.03); // the crown thrashing
  }

  /** A blade or a stick going into the ground and the dirt coming out. */
  dig() {
    if (!this.ctx) return;
    this.thump(120, 55, 0.35, 0.09);
    this.noiseBurst('lowpass', 1300, 0.7, 0.32, 0.004, 0.13, 450);
    this.noiseBurst('bandpass', 2000, 1.5, 0.08, 0.002, 0.08, undefined, 0.07); // grit rattling off
  }

  /** Stone on stone: a bright click and a tick (knapping flint). */
  knap() {
    if (!this.ctx) return;
    const f = rand(2600, 3600);
    this.thump(f, f * 0.97, 0.12, 0.06, 'sine');
    this.noiseBurst('highpass', 4000, 1.2, 0.3, 0.001, 0.025);
    this.thump(220, 120, 0.18, 0.05);
  }

  /** Something dragged or shaved along wood or stone (shaping a point, a ruler shoving a log). */
  scrape() {
    if (!this.ctx) return;
    this.noiseBurst('bandpass', rand(700, 1100), 2.5, 0.22, 0.03, 0.22, rand(1400, 2200));
  }

  /** Foliage and fibre: leaves brushing, a vine coiled or tied, something stowed. */
  rustle() {
    if (!this.ctx) return;
    this.noiseBurst('highpass', 3800, 0.6, 0.1, 0.02, 0.16, 5600);
    this.noiseBurst('bandpass', 2400, 1.5, 0.05, 0.005, 0.06, undefined, rand(0.04, 0.1));
  }

  // -------------------------------------------------------------------------
  // Voices (SPEC:850: every ruler has a distinct roar).
  // -------------------------------------------------------------------------

  /** A roar: low and long for a big body (`scale`), `intensity` 0..1 from a grumble to a full bellow. */
  roar(scale: number, intensity: number) {
    if (!this.ctx) return;
    const i = clamp01(intensity);
    const ctx = this.ctx;
    const t = ctx.currentTime + this.offset;
    const s = Math.max(0.5, scale);
    const f0 = 150 / Math.sqrt(s);
    const dur = 0.8 + 1.4 * i * Math.min(1.5, Math.sqrt(s) / 2);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * 0.8, t);
    o.frequency.linearRampToValueAtTime(f0 * (1.1 + 0.2 * i), t + dur * 0.35);
    o.frequency.linearRampToValueAtTime(f0 * 0.7, t + dur);
    // A throat: two formants and a ragged vibrato.
    const vib = ctx.createOscillator();
    vib.frequency.value = rand(5, 8);
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = f0 * 0.06;
    vib.connect(vibDepth).connect(o.frequency);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 520 / Math.sqrt(s) + 200;
    f1.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(pos(0.35 + 0.45 * i), t + 0.12);
    g.gain.setValueAtTime(pos(0.35 + 0.45 * i), t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f1).connect(g).connect(this.out);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
    // Breath and chest under it.
    this.noiseBurst('lowpass', 700 / Math.sqrt(s) + 150, 0.8, 0.3 + 0.4 * i, 0.1, dur * 0.9, 200);
    this.thump(70 / Math.sqrt(s) + 20, 25, 0.3 * i, dur * 0.6);
  }

  /** The ape's call: a few hoots rising into each other. */
  apeHoot() {
    if (!this.ctx) return;
    const n = 3 + Math.floor(Math.random() * 3);
    let at = 0;
    for (let k = 0; k < n; k++) {
      const f = 290 + k * rand(18, 30);
      this.tone(f, f * 1.25, 0.18 + 0.03 * k, 0.16 - 0.015 * k, 'triangle', at);
      at += 0.22 - 0.025 * k;
    }
  }

  // -------------------------------------------------------------------------
  // Building blocks
  // -------------------------------------------------------------------------

  private noiseBurst(type: BiquadFilterType, freq: number, q: number, gain: number, attack: number, decay: number, sweepTo?: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + this.offset + delay;
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
    src.connect(f).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  private thump(from: number, to: number, gain: number, decay: number, type: OscillatorType = 'sine') {
    this.tone(from, to, gain, decay, type, 0);
  }

  /** A pitched blip gliding from `from` to `to` Hz, `delay` s from now. */
  private tone(from: number, to: number, gain: number, decay: number, type: OscillatorType, delay: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + this.offset + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(pos(from), t);
    o.frequency.exponentialRampToValueAtTime(pos(to), t + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(pos(gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + decay + 0.02);
  }
}
