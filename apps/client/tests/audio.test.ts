// Sound (docs/M1-DESIGN.md §10.9, P37): every Sfx method is a no-op without an AudioContext; with one, every sound
// builds a valid graph (no exponential ramp to zero, every source stopped); FEEL_TUNING holds §9.1's values; and the
// adapter (feel/sfxPort.ts) turns the sim's events and state into the right sounds, from where they happen, reading the
// world and never writing it.
import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { type Fighter, HUMANOID_MASS, TERRAIN_TUNING, TUNING, type World, type WorldEvent } from '@wild/sim';
import { distanceGain, FEEL_TUNING, giantStepTrauma, Sfx } from '../src/feel/audio';
import { SfxAdapter, SOUND_OF, surfaceOf } from '../src/feel/sfxPort';
import type { SimEvent } from '../src/game/ports';
import { RENDER_TUNING } from '../src/render/terrainView';

// ---------------------------------------------------------------------------
// A fake AudioContext that checks what a browser would refuse.
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
  constructor(private readonly log: FakeCtx) {}
  setValueAtTime(v: number) {
    this.check(v, 'setValueAtTime');
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.check(v, 'linearRamp');
    return this;
  }
  exponentialRampToValueAtTime(v: number) {
    // Browsers throw on an exponential ramp to 0, a negative or a non-finite value.
    if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`exponentialRampToValueAtTime(${v})`);
    this.log.ramps++;
    return this;
  }
  setTargetAtTime(v: number) {
    this.check(v, 'setTargetAtTime');
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  private check(v: number, what: string) {
    if (!Number.isFinite(v)) throw new TypeError(`${what}(${v})`);
  }
}

class FakeNode {
  readonly gain: FakeParam;
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  readonly pan: FakeParam;
  readonly threshold: FakeParam;
  readonly ratio: FakeParam;
  readonly playbackRate: FakeParam;
  type = '';
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  constructor(readonly ctx: FakeCtx) {
    this.gain = new FakeParam(ctx);
    this.frequency = new FakeParam(ctx);
    this.Q = new FakeParam(ctx);
    this.pan = new FakeParam(ctx);
    this.threshold = new FakeParam(ctx);
    this.ratio = new FakeParam(ctx);
    this.playbackRate = new FakeParam(ctx);
  }
  connect<T>(to: T): T {
    return to;
  }
  disconnect() {}
  start(t = 0) {
    if (!Number.isFinite(t)) throw new TypeError('start');
    this.started = true;
    this.ctx.sources.push(this);
  }
  stop(t = 0) {
    if (!Number.isFinite(t)) throw new TypeError('stop');
    this.stopped = true;
  }
}

class FakeCtx {
  readonly sources: FakeNode[] = [];
  ramps = 0;
  currentTime = 1;
  sampleRate = 8000;
  state = 'running';
  destination = {};
  private make = () => new FakeNode(this);
  createOscillator = this.make;
  createGain = this.make;
  createBiquadFilter = this.make;
  createBufferSource = this.make;
  createDynamicsCompressor = this.make;
  createStereoPanner = this.make;
  createBuffer(_ch: number, len: number) {
    const data = new Float32Array(len);
    return { getChannelData: () => data };
  }
  resume() {
    return Promise.resolve();
  }
}

/** Every public Sfx method and some arguments for it (wrong-typed ones are fine without an AudioContext). */
const CALLS: Record<string, unknown[]> = {
  footstep: ['grass', 0.5, 1],
  giantStep: [0.7],
  exhale: [true, 1],
  pant: [true, 1],
  grunt: [1],
  flesh: [true, 'heavy'],
  impact: ['stone', true],
  bump: [],
  hit: ['medium', true],
  block: [true],
  whoosh: ['heavy'],
  dodge: [],
  counterReady: [],
  slice: [true],
  sever: [],
  clank: [true],
  landing: [2, true, 1],
  thud: [300, 'wood', 0.8],
  chime: [],
  bodyFall: [1, 1],
  knockdown: [],
  ko: [],
  chop: [0.3, true],
  creak: [0.6],
  crack: [40, 'wood'],
  snap: [],
  treeFall: [700],
  treeLand: [700],
  dig: [],
  knap: [],
  scrape: [],
  rustle: [],
  roar: [5.5, 1],
  apeHoot: [],
  setAmbience: ['jungle'],
  setJungleLevel: [0.4],
  ambienceTick: [1],
  applyTuning: [],
  setVolume: [0.5],
  unlock: [],
};
/** Internals (they need the AudioContext the public methods check for) and the one that takes it. */
const NOT_SOUNDS = new Set(['constructor', 'noiseBurst', 'thump', 'tone', 'applyJungleLevel', 'birdCall', 'attach', 'emit', 'later']);

function publicMethods(): string[] {
  return Object.getOwnPropertyNames(Sfx.prototype).filter((k) => {
    const d = Object.getOwnPropertyDescriptor(Sfx.prototype, k)!;
    return typeof d.value === 'function' && !NOT_SOUNDS.has(k);
  });
}

describe('Sfx', () => {
  it('is a no-op without an AudioContext: every method, any arguments', () => {
    const sfx = new Sfx();
    const methods = publicMethods();
    // Every method is listed above (a new sound must be added there, and so is checked here).
    expect(methods.sort()).toEqual(Object.keys(CALLS).sort());
    const s = sfx as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of methods) {
      expect(() => s[m](...CALLS[m]), m).not.toThrow();
      expect(() => s[m](1, 'x', null, undefined), `${m} (odd arguments)`).not.toThrow();
      expect(() => s[m](), `${m} (no arguments)`).not.toThrow();
    }
    const fn = vi.fn();
    sfx.emit(1, 0, fn);
    sfx.later(0.5, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(sfx.live).toBe(false);
  });

  it('with an AudioContext, every sound builds a valid graph and stops what it starts', () => {
    const ctx = new FakeCtx();
    const sfx = new Sfx();
    sfx.attach(ctx as unknown as AudioContext);
    expect(sfx.live).toBe(true);
    const s = sfx as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of publicMethods()) {
      if (m === 'unlock' || m === 'setAmbience' || m === 'setVolume' || m === 'applyTuning' || m === 'setJungleLevel' || m === 'ambienceTick') continue;
      const before = ctx.sources.length;
      expect(() => s[m](...CALLS[m]), m).not.toThrow();
      expect(ctx.sources.length, m).toBeGreaterThan(before);
    }
    // Extremes: no mass, huge mass, zero intensity, out-of-range inputs.
    for (const call of [() => sfx.thud(0, 'stone', 0), () => sfx.thud(1e6, 'dirt', 5), () => sfx.creak(-1), () => sfx.crack(0), () => sfx.roar(0, 0), () => sfx.chop(0, false), () => sfx.treeLand(0), () => sfx.footstep('leaves', -1, 0)]) {
      expect(call).not.toThrow();
    }
    // Every one-shot source is stopped (only the ambience bed loops).
    expect(ctx.sources.filter((n) => !n.stopped)).toEqual([]);
    expect(ctx.ramps).toBeGreaterThan(0);
  });

  it('plays inside an emitter (gain, pan) and later, and skips what is inaudible', () => {
    const ctx = new FakeCtx();
    const sfx = new Sfx();
    sfx.attach(ctx as unknown as AudioContext);
    const fn = vi.fn(() => sfx.snap());
    sfx.emit(0.5, -0.4, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    sfx.emit(FEEL_TUNING.space.inaudibleGain / 2, 0, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    const n = ctx.sources.length;
    sfx.later(0.4, () => sfx.dig());
    expect(ctx.sources.length).toBeGreaterThan(n);
  });

  it('runs the jungle bed, hushes it and calls birds only when alive', () => {
    const ctx = new FakeCtx();
    const sfx = new Sfx();
    sfx.setAmbience('jungle'); // before unlock: remembered
    sfx.attach(ctx as unknown as AudioContext);
    const loops = ctx.sources.filter((s) => !s.stopped).length;
    expect(loops).toBeGreaterThanOrEqual(3); // insects, their flutter and swell, wind
    sfx.setJungleLevel(0);
    const before = ctx.sources.length;
    for (let i = 0; i < 200; i++) sfx.ambienceTick(0.5);
    expect(ctx.sources.length).toBe(before); // a hushed jungle: no bird calls
    sfx.setJungleLevel(1);
    for (let i = 0; i < 200; i++) sfx.ambienceTick(0.5);
    expect(ctx.sources.length).toBeGreaterThan(before);
    sfx.setAmbience('none');
    expect(() => sfx.applyTuning()).not.toThrow();
  });
});

describe('FEEL_TUNING', () => {
  it("is registered in 'Client › feel' with §9.1's starting values", () => {
    const e = TUNING.find((t) => t.name === 'FEEL_TUNING')!;
    expect(e.folder).toBe('Client › feel');
    expect(FEEL_TUNING.giantShakeRadiusPerScale).toBe(6);
    expect(FEEL_TUNING.giantShakePerScale).toBe(0.05);
    expect(FEEL_TUNING.ambienceQuietRangeM).toBe(40);
    expect(FEEL_TUNING.creakFrom).toBe(0.5);
    // DS's mix values are tuning too.
    expect(FEEL_TUNING.mix).toEqual({ compressorThresholdDb: -14, compressorRatio: 6 });
  });

  it("a giant's footfall jolts the camera 0.05·(scale − 1)·near inside 6·scale m (33 m for the giant)", () => {
    expect(giantStepTrauma(5.5, 0)).toBeCloseTo(0.225, 10);
    expect(giantStepTrauma(5.5, 16.5)).toBeCloseTo(0.1125, 10);
    expect(giantStepTrauma(5.5, 33)).toBe(0);
    expect(giantStepTrauma(5.5, 50)).toBe(0);
    expect(giantStepTrauma(1, 0)).toBe(0);
  });

  it('sounds fade with distance: full within the reference distance, then ref/d, silent past the max', () => {
    const S = FEEL_TUNING.space;
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(S.refDistM)).toBe(1);
    expect(distanceGain(S.refDistM * 4)).toBeCloseTo(0.25, 10);
    expect(distanceGain(S.maxDistM + 1)).toBe(0);
    expect(distanceGain(S.maxDistM + 1, 2)).toBeGreaterThan(0); // a loud family carries further
  });
});

// ---------------------------------------------------------------------------
// The adapter, against a recording Sfx and a fake world (frozen where the adapter could write).
// ---------------------------------------------------------------------------

type Call = [string, ...unknown[]];

function recSfx(): { sfx: Sfx; calls: Call[]; emits: { gain: number; pan: number; calls: string[] }[] } {
  const calls: Call[] = [];
  const emits: { gain: number; pan: number; calls: string[] }[] = [];
  let into: string[] | null = null;
  const target = { volume: 0.7 };
  const sfx = new Proxy(target, {
    get(t, k) {
      if (k === 'volume') return t.volume;
      if (k === 'emit') {
        return (gain: number, pan: number, fn: () => void) => {
          const e = { gain, pan, calls: [] as string[] };
          emits.push(e);
          const prev = into;
          into = e.calls;
          try {
            fn();
          } finally {
            into = prev;
          }
        };
      }
      if (k === 'later') return (_d: number, fn: () => void) => fn();
      return (...a: unknown[]) => {
        calls.push([String(k), ...a]);
        into?.push(String(k));
      };
    },
  }) as unknown as Sfx;
  return { sfx, calls, emits };
}

interface FakeFoot {
  side: 'L' | 'R';
  stepping: boolean;
  pos: Vector3;
}

function fighter(o: { id: number; x: number; z: number; scale?: number; ruler?: boolean; speed?: number }) {
  const pos = new Vector3(o.x, 0, o.z);
  const L: FakeFoot = { side: 'L', stepping: true, pos: new Vector3(o.x - 0.1, 0, o.z) };
  const R: FakeFoot = { side: 'R', stepping: false, pos: new Vector3(o.x + 0.1, 0, o.z) };
  const scale = o.scale ?? 1;
  const f = {
    id: o.id,
    pos,
    scale,
    alive: true,
    state: 'walk',
    walkVel: { x: o.speed ?? 3.8 * scale, z: 0 },
    stamina: 1,
    mass: HUMANOID_MASS * scale ** 3,
    ruler: o.ruler ? { inPit: false } : null,
    footwork: Object.freeze({ L, R }),
    inventory: null,
    isAirborne: () => false,
  };
  return { f: Object.freeze(f) as unknown as Fighter, L, R, pos };
}

function fakeWorld(o: { fighters?: Fighter[]; entities?: Record<number, unknown>; ropes?: unknown[]; cover?: number; under?: number | null; tick?: number }) {
  const ents = new Map<number, unknown>(Object.entries(o.entities ?? {}).map(([k, v]) => [Number(k), Object.freeze(v)]));
  const w = {
    tick: o.tick ?? 10,
    combat: { fighters: o.fighters ?? [] },
    entities: { get: (id: number) => ents.get(id), all: () => [...ents.values()] },
    joints: { view: () => o.ropes ?? [] },
    terrain: { heightAt: () => 0 },
    cover: { at: () => o.cover ?? 0 },
    queries: { castRay: () => (o.under ? { owner: { kind: 'entity', id: o.under }, toi: 0.3, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } } : null) },
  };
  return w as unknown as World & { tick: number };
}

const ev = (e: unknown) => e as SimEvent;

describe('SfxAdapter', () => {
  it('maps every sim material to a sound family, and a surface underfoot', () => {
    for (const m of Object.keys(SOUND_OF)) expect(SOUND_OF[m as keyof typeof SOUND_OF]).toBeTruthy();
    expect(surfaceOf('dryWood')).toBe('log');
    expect(surfaceOf('stone')).toBe('rock');
    expect(surfaceOf('leaves')).toBe('leaves');
    expect(surfaceOf('dirt')).toBe('dirt');
  });

  it('chops, creaks, snaps, digs, cracks and crashes from the world events, heard from where they happen', () => {
    const { sfx, calls, emits } = recSfx();
    const tree = { id: 5, material: 'greenWood', mass: 720, pose: { p: { x: 40, y: 0, z: 0 } }, plant: { diameter: 0.32, phase: 'notched', cut: { remaining: 0.5 } } };
    const log = { id: 6, material: 'dryWood', mass: 60, pose: { p: { x: 2, y: 0, z: 0 } }, plant: null };
    const stone = { id: 7, material: 'stone', mass: 12, pose: { p: { x: 1, y: 0, z: 0 } }, plant: null };
    const w = fakeWorld({ entities: { 5: tree, 6: log, 7: stone } });
    const a = new SfxAdapter(sfx, () => null);
    a.setListener(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    a.handle(ev({ type: 'chop', tree: 5, point: { x: 40, y: 1, z: 0 }, remaining: 0.5 }), w);
    expect(calls.at(-1)).toEqual(['chop', 0.32, true]);
    // Heard 40 m away, quieter, and panned fully to its side (+x is the left of a listener looking along +z).
    const chop = emits.at(-1)!;
    expect(chop.gain).toBeCloseTo(distanceGain(Math.hypot(40, 1), FEEL_TUNING.loud.chop), 10);
    expect(chop.gain).toBeLessThan(1);
    expect(Math.abs(chop.pan)).toBeCloseTo(FEEL_TUNING.space.pan, 10);
    // The last chops before it goes creak (RENDER_TUNING.creakBelowRemaining, where the look creaks too).
    a.handle(ev({ type: 'chop', tree: 5, point: { x: 40, y: 1, z: 0 }, remaining: RENDER_TUNING.creakBelowRemaining / 2 }), w);
    expect(calls.slice(-2).map((c) => c[0])).toEqual(['chop', 'creak']);
    a.handle(ev({ type: 'joint', joint: 3, what: 'snap' }), w);
    expect(calls.at(-1)).toEqual(['snap']);
    a.handle(ev({ type: 'dig', point: { x: 1, y: 0, z: 1 }, volumeM3: 0.04, pile: null }), w);
    expect(calls.at(-1)).toEqual(['dig']);
    a.handle(ev({ type: 'break', entity: 9, pieces: [6], point: { x: 2, y: 0, z: 0 }, energy: 500 }), w);
    expect(calls.at(-1)).toEqual(['crack', 60, 'wood']);
    // A tree falls: a groan and a whoosh, then its landing is the crash.
    a.handle(ev({ type: 'fell', tree: 5, dir: { x: 1, y: 0, z: 0 } }), w);
    expect(calls.at(-1)).toEqual(['treeFall', 720]);
    a.handle(ev({ type: 'land', entity: 5, f: null, point: { x: 50, y: 0, z: 0 }, energy: 9000, mass: 720 }), w);
    expect(calls.at(-1)).toEqual(['treeLand', 720]);
    // Other landings thud by mass and material; a body falls by its mass in bodies.
    a.handle(ev({ type: 'land', entity: 7, f: null, point: { x: 1, y: 0, z: 0 }, energy: 12 * 0.5 * 16, mass: 12 }), w);
    expect(calls.at(-1)).toEqual(['thud', 12, 'stone', 4 / FEEL_TUNING.thuds.entityHardSpeed]);
    const body = fighter({ id: 2, x: 3, z: 0 }).f;
    a.handle(ev({ type: 'land', entity: null, f: body, point: { x: 3, y: 0, z: 0 }, energy: 0.5 * body.mass * 25, mass: body.mass }), w);
    expect(calls.at(-1)![0]).toBe('bodyFall');
    expect(calls.at(-1)![1]).toBeCloseTo(1, 10);
    expect(calls.at(-1)![2]).toBeCloseTo(1, 10);
    // Too soft to hear.
    const n = calls.length;
    a.handle(ev({ type: 'land', entity: 6, f: null, point: { x: 2, y: 0, z: 0 }, energy: FEEL_TUNING.thuds.minEnergyJ / 2, mass: 60 }), w);
    expect(calls.length).toBe(n);
    // Shaping flint knaps; shaping wood scrapes.
    const me = fighter({ id: 1, x: 0, z: 0 }).f;
    a.handle(ev({ type: 'verb', f: me, verb: 'shape', ok: true, entity: 7 }), w);
    expect(calls.at(-1)).toEqual(['knap']);
    a.handle(ev({ type: 'verb', f: me, verb: 'shape', ok: true, entity: 6 }), w);
    expect(calls.at(-1)).toEqual(['scrape']);
    // A wounded ruler bellows.
    const giant = fighter({ id: 3, x: 20, z: 0, scale: 5.5, ruler: true }).f;
    a.handle(ev({ type: 'wound', ruler: giant, wound: { severe: true }, byWorld: true }), w);
    expect(calls.at(-1)).toEqual(['roar', 5.5, 1]);
  });

  it("an impact sounds like what struck: the entity's material and mass, then the body", () => {
    const { sfx, calls } = recSfx();
    const log = { id: 6, material: 'greenWood', mass: 80, pose: { p: { x: 0, y: 0, z: 0 } }, plant: null };
    const w = fakeWorld({ entities: { 6: log } });
    const a = new SfxAdapter(sfx, () => null);
    const ape = fighter({ id: 4, x: 0, z: 0 }).f;
    a.handle(ev({ type: 'impact', defender: ape, point: { x: 0, y: 1, z: 0 }, zone: 'chest', weight: 'heavy', energy: 900, damage: 20, cause: { kind: 'entity', entityId: 6, feature: 'swinging' } }), w);
    expect(calls.map((c) => c[0])).toEqual(['thud', 'flesh']);
    expect(calls[0].slice(1, 3)).toEqual([80, 'wood']);
  });

  it('reads footsteps from feet landing between frames, on what they stand on, and never writes the fighter', () => {
    const { sfx, calls } = recSfx();
    const me = fighter({ id: 1, x: 0, z: 0 });
    const w = fakeWorld({ fighters: [me.f] });
    const a = new SfxAdapter(sfx, () => me.f);
    a.setListener(new Vector3(0, 2, -4));
    a.ambience(w, 1 / 60, 1 / 60); // the first frame only learns the feet
    expect(calls.filter((c) => c[0] === 'footstep')).toEqual([]);
    me.L.stepping = false; // the left foot landed
    w.tick++;
    a.ambience(w, 1 / 60, 1 / 60);
    const steps = calls.filter((c) => c[0] === 'footstep');
    expect(steps).toEqual([['footstep', surfaceOf(TERRAIN_TUNING.material), 1, 1]]);
    // On ground cover it's grass; on a leaf cover entity, leaves.
    const grass = fakeWorld({ fighters: [me.f], cover: 0.9 });
    const b = new SfxAdapter(sfx, () => me.f);
    b.ambience(grass, 1 / 60, 1 / 60);
    me.R.stepping = true;
    b.ambience(grass, 1 / 60, 1 / 60);
    me.R.stepping = false;
    b.ambience(grass, 1 / 60, 1 / 60);
    expect(calls.at(-1)?.[1]).toBe('grass');
    expect(b.surfaceAt(fakeWorld({ entities: { 9: { id: 9, material: 'leaves' } }, under: 9 }), { x: 0, y: 0.5, z: 0 })).toBe('leaves');
    expect(b.surfaceAt(fakeWorld({ entities: { 9: { id: 9, material: 'dryWood' } }, under: 9 }), { x: 0, y: 0.5, z: 0 })).toBe('log');
    // While paused (no game time) nothing steps.
    const stepsNow = () => calls.filter((c) => c[0] === 'footstep').length;
    const n = stepsNow();
    me.L.stepping = true;
    a.ambience(w, 1 / 60, 0);
    me.L.stepping = false;
    a.ambience(w, 1 / 60, 0);
    expect(stepsNow()).toBe(n);
  });

  it("the giant's footfalls are giantStep, felt through the camera inside 6·scale m", () => {
    const { sfx, calls } = recSfx();
    const me = fighter({ id: 1, x: 0, z: 0 });
    const giant = fighter({ id: 3, x: 0, z: 11, scale: 5.5, ruler: true });
    const w = fakeWorld({ fighters: [me.f, giant.f] });
    const a = new SfxAdapter(sfx, () => me.f);
    const trauma = vi.fn();
    a.onTrauma = trauma;
    a.setListener(new Vector3(0, 2, -4));
    a.ambience(w, 1 / 60, 1 / 60);
    giant.L.stepping = false;
    w.tick++;
    a.ambience(w, 1 / 60, 1 / 60);
    const d = Math.hypot(giant.L.pos.x, giant.L.pos.z);
    const near = 1 - d / (6 * 5.5);
    const step = calls.find((c) => c[0] === 'giantStep')!;
    expect(step[1]).toBeCloseTo(near, 10);
    expect(trauma).toHaveBeenCalledTimes(1);
    expect(trauma.mock.calls[0][0]).toBeCloseTo(0.05 * 4.5 * near, 10);
    expect(calls.filter((c) => c[0] === 'footstep')).toEqual([]);
  });

  it('a fall that stops is a jump landing (both feet), and a teleport is not', () => {
    const { sfx, calls } = recSfx();
    const me = fighter({ id: 1, x: 0, z: 0 });
    me.L.stepping = false;
    const w = fakeWorld({ fighters: [me.f] });
    const a = new SfxAdapter(sfx, () => me.f);
    me.pos.y = 1;
    a.ambience(w, 1 / 60, 1 / 60);
    // Falling at 6 m/s for two ticks, then on the ground.
    for (const y of [0.9, 0.8]) {
      me.pos.y = y;
      w.tick++;
      a.ambience(w, 1 / 60, 1 / 60);
    }
    expect(calls.filter((c) => c[0] === 'footstep')).toEqual([]);
    me.pos.y = 0.8;
    w.tick++;
    a.ambience(w, 1 / 60, 1 / 60);
    expect(calls.filter((c) => c[0] === 'footstep').map((c) => c[2])).toEqual([1, 0.9]);
    // A teleport down 50 m in a tick makes no sound.
    calls.length = 0;
    me.pos.y = -49.2;
    w.tick++;
    a.ambience(w, 1 / 60, 1 / 60);
    w.tick++;
    a.ambience(w, 1 / 60, 1 / 60);
    expect(calls.filter((c) => c[0] === 'footstep')).toEqual([]);
  });

  it('ropes past FEEL_TUNING.creakFrom creak, more the nearer to breaking; slack ones are silent', () => {
    const { sfx, calls } = recSfx();
    const ropes = [
      { joint: 1, a: { x: 0, y: 2, z: 0 }, b: { x: 4, y: 2, z: 0 }, lengthM: 4, taut: true, strain: 0.95 },
      { joint: 2, a: { x: 0, y: 2, z: 0 }, b: { x: 0, y: 2, z: 4 }, lengthM: 4, taut: true, strain: 0.2 },
    ];
    const w = fakeWorld({ ropes });
    const a = new SfxAdapter(sfx, () => null);
    for (let i = 0; i < 600; i++) {
      w.tick++;
      a.ambience(w, 1 / 60, 1 / 60);
    }
    const creaks = calls.filter((c) => c[0] === 'creak');
    expect(creaks.length).toBeGreaterThan(5);
    for (const c of creaks) expect(c[1]).toBeCloseTo((0.95 - FEEL_TUNING.creakFrom) / (1 - FEEL_TUNING.creakFrom), 10);
  });

  it('the jungle hushes as the giant comes within FEEL_TUNING.ambienceQuietRangeM', () => {
    const { sfx, calls } = recSfx();
    const me = fighter({ id: 1, x: 0, z: 0 });
    const giant = fighter({ id: 3, x: 0, z: 20, scale: 5.5, ruler: true });
    const a = new SfxAdapter(sfx, () => me.f);
    a.setListener(new Vector3(0, 0, 0));
    expect(a.jungleLevel(fakeWorld({ fighters: [me.f] }))).toBe(1);
    expect(a.jungleLevel(fakeWorld({ fighters: [me.f, giant.f] }))).toBeCloseTo(20 / FEEL_TUNING.ambienceQuietRangeM, 10);
    a.ambience(fakeWorld({ fighters: [me.f, giant.f] }), 1 / 60, 1 / 60);
    expect(calls.find((c) => c[0] === 'setAmbience')).toEqual(['setAmbience', 'jungle']);
    expect(calls.find((c) => c[0] === 'setJungleLevel')![1]).toBeCloseTo(0.5, 10);
  });

  it("keeps DungeonStyle's fight sounds", () => {
    const { sfx, calls } = recSfx();
    const a = new SfxAdapter(sfx, () => null);
    const w = fakeWorld({});
    const att = fighter({ id: 1, x: 0, z: 0 }).f;
    const def = fighter({ id: 2, x: 1, z: 0 }).f;
    const p = new Vector3(0.5, 1.5, 0);
    a.handle(ev({ type: 'hit', attacker: att, defender: def, move: { weight: 'heavy', weapon: false }, point: p, zone: 'head', damage: 10, weapon: null, sever: null, fatal: null }), w);
    expect(calls.map((c) => c[0])).toEqual(['flesh', 'grunt']);
    a.handle(ev({ type: 'block', move: { weight: 'light' }, point: p, parry: true, perfect: true }), w);
    expect(calls.slice(-2).map((c) => c[0])).toEqual(['block', 'counterReady']);
    a.handle(ev({ type: 'ko', victim: def, point: p }), w);
    expect(calls.at(-1)).toEqual(['ko']);
  });

  it('writes nothing it reads: events are handled with the world, its entities and the fighters frozen', () => {
    const { sfx } = recSfx();
    const me = fighter({ id: 1, x: 0, z: 0 });
    const w = Object.freeze(fakeWorld({ fighters: [me.f], entities: { 6: { id: 6, material: 'dryWood', mass: 50, pose: { p: { x: 0, y: 0, z: 0 } }, plant: null } } }));
    const a = new SfxAdapter(sfx, () => me.f);
    const events: unknown[] = [
      { type: 'land', entity: 6, f: null, point: { x: 0, y: 0, z: 0 }, energy: 200, mass: 50 },
      { type: 'land', entity: null, f: me.f, point: { x: 0, y: 0, z: 0 }, energy: 200, mass: 73 },
      { type: 'chop', tree: 6, point: { x: 0, y: 1, z: 0 }, remaining: 0.1 },
      { type: 'respawn', f: me.f, at: { x: 0, y: 0, z: 0 } },
      { type: 'tripwire', joint: 1, by: { kind: 'terrain' }, loadN: 10, snapped: false, loosed: [] },
    ];
    for (const e of events) expect(() => a.handle(e as WorldEvent, w)).not.toThrow();
    expect(() => a.ambience(w, 1 / 60, 1 / 60)).not.toThrow();
  });
});
