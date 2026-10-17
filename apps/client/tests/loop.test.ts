// The game loop (docs/M1-DESIGN.md §10.2, rule 8): every time effect only changes how many sim steps run in a frame.
// Driven with a fake world (counts its steps) and a fake presenter; one test drives a real World. Then the beats: the
// time effects game.ts asks the loop for, event by event (beatOf, pure).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Command, createPlayer, createWorld, DT, PLAYER_MOVES, type StepResult, type World } from '@wild/sim';
import { bootParams, rebuildSearch } from '../src/dev';
import { type Beat, type BeatContext, beatOf, GAME_TUNING } from '../src/game/game';
import { GameLoop, type LoopGame, LOOP_TUNING, type LoopWorld } from '../src/game/loop';
import type { LoopPort, SimEvent, VerbInputPort } from '../src/game/ports';
import type { InputFrame } from '../src/input/input';
import { VerbInput } from '../src/input/verbInput';
import { Vector3 } from 'three';

class FakeWorld implements LoopWorld {
  tick = 0;
  steps = 0;
  readonly pushed: Command[] = [];
  readonly commands = { push: (c: Command) => void this.pushed.push(c) };
  /** The save bytes the next step returns (a `meta 'save'` was due). */
  saveNext: Uint8Array | null = null;
  step(): StepResult {
    this.tick++;
    this.steps++;
    const save = this.saveNext;
    this.saveNext = null;
    return { combat: [], world: [], save };
  }
}

const frameOf = (o: Partial<InputFrame> = {}): InputFrame => ({ moveX: 0, moveY: 0, presses: [], pickup: false, keys: [], ...o });

class FakeInput {
  readonly queue: InputFrame[] = [];
  poll(): InputFrame {
    return this.queue.shift() ?? frameOf();
  }
}

/** A presenter that records what the loop asks of it. */
class FakeGame<W extends LoopWorld> implements LoopGame<W> {
  menuOpen = false;
  presents = 0;
  freezes = 0;
  presentationSteps = 0;
  readonly renders: { realDt: number; gameDt: number; alpha: number }[] = [];
  readonly keys: string[] = [];
  readonly saves: Uint8Array[] = [];
  /** Called on each presented step (a hit raising a hit-pause, say). */
  onPresent: ((r: StepResult, loop: LoopPort) => void) | null = null;
  readonly presentation = { step: (_w: W) => void this.presentationSteps++ };
  constructor(readonly verbInput: VerbInputPort) {}
  beginFrame(_inp: InputFrame, _loop: LoopPort): void {}
  /** Called on each key the loop hands on (a rebuild stopping the loop, say). */
  onKey: ((code: string) => void) | null = null;
  metaKey(code: string): void {
    this.keys.push(code);
    this.onKey?.(code);
  }
  present(r: StepResult, loop: LoopPort): void {
    this.presents++;
    this.onPresent?.(r, loop);
  }
  freezeFrame(): void {
    this.freezes++;
  }
  render(realDt: number, gameDt: number, alpha: number): void {
    this.renders.push({ realDt, gameDt, alpha });
  }
  onSave(bytes: Uint8Array): void {
    this.saves.push(bytes);
  }
}

/** verbInput's stand-in: one move per frame, exactly as the stub does (the commands themselves are VerbInput's test). */
const oneMove: VerbInputPort = {
  mode: 'idle',
  commands: (inp, tick) => [{ tick, player: 1, kind: 'move', dir: 0, speed: Math.round(inp.moveY * 256) }],
};

function rig(opts: { cineActive?: boolean; cineScale?: number } = {}) {
  const world = new FakeWorld();
  const game = new FakeGame<FakeWorld>(oneMove);
  const input = new FakeInput();
  const cineUpdates: number[] = [];
  const cine = { active: opts.cineActive ?? false, timeScale: opts.cineScale ?? 1, update: (dt: number) => void cineUpdates.push(dt) };
  const loop = new GameLoop(world, game, input, cine);
  return { world, game, input, cine, cineUpdates, loop };
}

const frames = (loop: { frame(dt: number): void }, n: number, dt = DT) => {
  for (let i = 0; i < n; i++) loop.frame(dt);
};

afterEach(() => {
  GAME_TUNING.paused = false;
  GAME_TUNING.timeScale = 1;
  vi.unstubAllGlobals();
});

describe('GameLoop: stepping', () => {
  it('a frame of one tick steps the world once and tags the input for the next tick', () => {
    const { world, game, loop } = rig();
    loop.frame(DT);
    expect(world.steps).toBe(1);
    expect(world.pushed).toHaveLength(1);
    expect(world.pushed[0]).toMatchObject({ tick: 1, kind: 'move' });
    loop.frame(DT);
    expect(world.pushed[1]).toMatchObject({ tick: 2 });
    expect(game.presents).toBe(2);
    expect(game.presentationSteps).toBe(2);
    expect(game.renders).toHaveLength(2);
  });

  it('runs real time × time scale in whole ticks, and renders every frame', () => {
    const { world, game, loop } = rig();
    frames(loop, 240);
    expect(world.steps).toBe(240);
    expect(game.renders).toHaveLength(240);
    GAME_TUNING.timeScale = 0.5;
    const before = world.steps;
    frames(loop, 240);
    expect(Math.abs(world.steps - before - 120)).toBeLessThanOrEqual(1);
  });

  it(`never runs more than ${LOOP_TUNING.maxStepsPerFrame} steps in a frame, and drops the backlog`, () => {
    const { world, loop } = rig();
    loop.frame(0.5); // 30 ticks due
    expect(world.steps).toBe(6);
    expect(LOOP_TUNING.maxStepsPerFrame).toBe(6);
    loop.frame(DT);
    expect(world.steps).toBe(7);
    GAME_TUNING.timeScale = 1.5;
    loop.frame(1);
    expect(world.steps).toBe(13);
  });

  it('a requested step counts toward the cap: never a 7th step in a frame', () => {
    const { world, loop } = rig();
    loop.requestStep();
    loop.frame(0.5);
    expect(world.steps).toBe(LOOP_TUNING.maxStepsPerFrame);
  });

  it('a key that stops the loop (dev Backspace: rebuild) ends the frame: no step on a disposed world', () => {
    const { world, game, input, loop } = rig();
    game.onKey = (code) => {
      if (code === 'Backspace') loop.stop();
    };
    input.queue.push(frameOf({ keys: ['Backspace'], moveY: 1 }));
    loop.frame(DT);
    expect(game.keys).toEqual(['Backspace']);
    expect(world.steps).toBe(0);
    expect(world.pushed).toEqual([]);
    expect(game.renders).toHaveLength(0);
    loop.frame(DT);
    expect(world.steps).toBe(0);
  });

  it('presents each stepped tick, hands its save bytes on, and steps the presentation after the sim', () => {
    const { world, game, loop } = rig();
    const order: string[] = [];
    game.onPresent = () => order.push(`present ${world.tick}`);
    game.presentation.step = () => void order.push(`presentation ${world.tick}`);
    world.saveNext = new Uint8Array([1, 2, 3]);
    frames(loop, 2);
    expect(order).toEqual(['present 1', 'presentation 1', 'present 2', 'presentation 2']);
    expect(game.saves).toEqual([new Uint8Array([1, 2, 3])]);
  });
});

describe('GameLoop: hit-pause', () => {
  it('5 hit-pause frames run no world.step', () => {
    const { world, game, loop } = rig();
    loop.hitstop = 5;
    frames(loop, 5);
    expect(world.steps).toBe(0);
    expect(world.tick).toBe(0);
    expect(game.freezes).toBe(5);
    expect(game.presentationSteps).toBe(0);
    // The picture holds while the pause lasts (no game time passes, nothing interpolates).
    for (const r of game.renders.slice(0, 4)) expect(r).toMatchObject({ gameDt: 0, alpha: 1 });
    loop.frame(DT);
    expect(world.steps).toBe(1);
  });

  it('a blow presented in a step swallows the next steps', () => {
    const { world, game, loop } = rig();
    game.onPresent = (_r, l) => {
      if (world.tick === 1) l.hitstop = Math.max(l.hitstop, 5);
    };
    frames(loop, 6);
    expect(world.steps).toBe(1);
    expect(game.freezes).toBe(5);
    loop.frame(DT);
    expect(world.steps).toBe(2);
  });

  it('a camera cut clears the hit-pause: the cut is already the slow beat', () => {
    const { world, loop } = rig({ cineActive: true, cineScale: 1 });
    loop.hitstop = 5;
    loop.frame(DT);
    expect(loop.hitstop).toBe(0);
    expect(world.steps).toBe(1);
  });
});

describe('GameLoop: slow motion', () => {
  it('slow motion runs a quarter of the steps', () => {
    const normal = rig();
    frames(normal.loop, 240);
    const slow = rig();
    slow.loop.slowmo = 100;
    frames(slow.loop, 240);
    expect(LOOP_TUNING.slowmoScale).toBe(0.25);
    expect(normal.world.steps).toBe(240);
    expect(Math.abs(slow.world.steps - normal.world.steps / 4)).toBeLessThanOrEqual(1);
  });

  it('runs down in real seconds, then full speed returns', () => {
    const { world, loop } = rig();
    loop.slowMotion('parry');
    expect(loop.slowmo).toBe(LOOP_TUNING.parrySlowmoS);
    frames(loop, 60); // 1 s real: 0.35 s slow (≈ 5 ticks), 0.65 s full speed (≈ 39 ticks)
    expect(loop.slowmo).toBe(0);
    expect(Math.abs(world.steps - (0.35 * 60 * 0.25 + 0.65 * 60))).toBeLessThanOrEqual(1.5);
    // Slow motion is raised, never shortened.
    loop.slowmo = 1;
    loop.slowMotion('parry');
    expect(loop.slowmo).toBe(1);
    loop.slowMotion('playerKo');
    expect(loop.slowmo).toBe(LOOP_TUNING.playerKoSlowmoS);
  });

  it("a cut's time scale replaces slow motion", () => {
    const { world, cineUpdates, loop } = rig({ cineActive: true, cineScale: 0.5 });
    loop.slowmo = 100;
    frames(loop, 240);
    expect(Math.abs(world.steps - 120)).toBeLessThanOrEqual(1);
    expect(cineUpdates).toHaveLength(240);
  });

  it('a felled tree landing near the camera is a short hit-pause; far away it is not', () => {
    const { loop } = rig();
    loop.treeLanded(LOOP_TUNING.treeFallHitstopRangeM + 1);
    expect(loop.hitstop).toBe(0);
    loop.treeLanded(LOOP_TUNING.treeFallHitstopRangeM - 1);
    expect(loop.hitstop).toBe(LOOP_TUNING.treeFallHitstop);
  });
});

describe('GameLoop: pause', () => {
  it('a hidden tab pauses: no steps, no commands, no timers; it comes back without a backlog', () => {
    const { world, game, cineUpdates, loop, input } = rig();
    loop.slowmo = 1;
    loop.setHidden(true);
    expect(loop.paused).toBe(true);
    for (let i = 0; i < 30; i++) input.queue.push(frameOf({ moveY: 1, presses: ['lpunch'] }));
    frames(loop, 30);
    expect(world.steps).toBe(0);
    expect(world.pushed).toEqual([]);
    expect(loop.slowmo).toBe(1);
    expect(cineUpdates).toEqual([]);
    expect(game.renders).toHaveLength(30);
    for (const r of game.renders) expect(r).toMatchObject({ gameDt: 0, alpha: 1 });
    loop.setHidden(false);
    loop.slowmo = 0;
    loop.frame(DT);
    expect(world.steps).toBe(1);
    expect(world.pushed).toHaveLength(1);
  });

  it('start() pauses on visibilitychange', () => {
    const listeners: (() => void)[] = [];
    const doc = { hidden: false, addEventListener: (_t: string, f: () => void) => listeners.push(f), removeEventListener: () => {} };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const { world, loop } = rig();
    loop.start();
    expect(listeners).toHaveLength(1);
    doc.hidden = true;
    listeners[0]();
    expect(loop.paused).toBe(true);
    loop.frame(DT);
    expect(world.steps).toBe(0);
    doc.hidden = false;
    listeners[0]();
    loop.frame(DT);
    expect(world.steps).toBe(1);
    loop.stop();
  });

  it('dev P pauses (still rendering), `.` steps one tick, T cycles the time scale', () => {
    const { world, game, loop, input } = rig();
    input.queue.push(frameOf({ keys: ['KeyP'] }));
    frames(loop, 10);
    expect(GAME_TUNING.paused).toBe(true);
    expect(world.steps).toBe(0);
    expect(game.renders).toHaveLength(10);
    input.queue.push(frameOf({ keys: ['Period'] }));
    loop.frame(DT);
    expect(world.steps).toBe(1);
    loop.requestStep();
    loop.frame(DT);
    expect(world.steps).toBe(2);
    input.queue.push(frameOf({ keys: ['KeyP', 'KeyT'] }));
    loop.frame(DT);
    expect(GAME_TUNING.paused).toBe(false);
    expect(GAME_TUNING.timeScale).toBe(LOOP_TUNING.devTimeScales[1]);
    // The time keys are the loop's; every other key goes to the presenter.
    input.queue.push(frameOf({ keys: ['Escape', 'KeyL', 'KeyB'] }));
    loop.frame(DT);
    expect(game.keys).toEqual(['Escape', 'KeyL', 'KeyB']);
  });

  it('an open menu pauses and turns no input into commands', () => {
    const { world, game, loop, input } = rig();
    game.menuOpen = true;
    input.queue.push(frameOf({ moveY: 1 }));
    frames(loop, 5);
    expect(world.steps).toBe(0);
    expect(world.pushed).toEqual([]);
    game.menuOpen = false;
    loop.frame(DT);
    expect(world.steps).toBe(1);
  });

  it('advance(n) runs n steps at once (dev, headless checks)', () => {
    const { world, loop } = rig();
    GAME_TUNING.paused = true;
    loop.advance(7);
    expect(world.steps).toBe(7);
  });
});

describe('GameLoop: commands it sends itself', () => {
  it("dev ops and saves are `meta` commands for the next tick, from player 1", () => {
    const { world, loop } = rig();
    world.tick = 41;
    loop.dev('setTuning', [], { table: 'WORLD_TUNING', key: 'aiNearM', value: 61 });
    loop.dev('spawnApe', [3, -4]);
    loop.save();
    expect(world.pushed).toEqual([
      { tick: 42, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'setTuning', args: [], tuning: { table: 'WORLD_TUNING', key: 'aiNearM', value: 61 } } },
      { tick: 42, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'spawnApe', args: [3, -4] } },
      { tick: 42, player: 1, kind: 'meta', meta: 'save' },
    ]);
  });
});

describe('GameLoop with a real World', () => {
  it('held W walks the player: the input reaches the sim only as commands', async () => {
    const world = await createWorld({ seed: 7, scene: 'empty', nav: 'off' });
    try {
      const p = world.player!;
      const start = p.pos.clone();
      // The camera looks along +z: W walks the player toward +z.
      const verbInput = new VerbInput(() => ({ forward: new Vector3(0, 0, 1), right: new Vector3(-1, 0, 0) }));
      const game = new FakeGame<World>(verbInput);
      const input = new FakeInput();
      const loop = new GameLoop(world, game, input, { active: false, timeScale: 1, update: () => {} });
      for (let i = 0; i < 120; i++) input.queue.push(frameOf({ moveY: 1 }));
      frames(loop, 120);
      expect(world.tick).toBe(120);
      expect(p.pos.z - start.z).toBeGreaterThan(1);
      expect(Math.abs(p.pos.x - start.x)).toBeLessThan(0.5);
    } finally {
      world.dispose();
    }
  });
});

describe('boot parameters', () => {
  const never = () => {
    throw new Error('no random seed wanted');
  };

  it('?seed=N is the world seed (as uint32); without one the seed is random', () => {
    expect(bootParams('?seed=42', false, never).seed).toBe(42);
    expect(bootParams('?seed=-1', false, never).seed).toBe(0xffffffff);
    expect(bootParams('?seed=4294967297', false, never).seed).toBe(1);
    expect(bootParams('', false, () => 1234).seed).toBe(1234);
    expect(bootParams('?seed=abc', false, () => 99).seed).toBe(99);
    expect(bootParams('?seed=1.5', false, () => 98).seed).toBe(98);
  });

  it('?mode=training asks for the sparring ape in developer mode only (D-50)', () => {
    expect(bootParams('?mode=training&seed=3', true, never)).toEqual({ seed: 3, sparringApe: true });
    expect(bootParams('?mode=training&seed=3', false, never)).toEqual({ seed: 3, sparringApe: false });
    expect(bootParams('?seed=3', true, never).sparringApe).toBe(false);
  });

  it('a rebuild keeps the seed and the mode', () => {
    expect(bootParams(rebuildSearch('?mode=training', 77), true, never)).toEqual({ seed: 77, sparringApe: true });
    expect(rebuildSearch('?seed=5&dev', 6)).toBe('?seed=6&dev=');
  });
});

describe('Game beats: what an event asks of the loop and the camera (beatOf)', () => {
  const me = createPlayer();
  const them = createPlayer();
  const moves = Object.values(PLAYER_MOVES);
  const light = moves.find((m) => m.weight === 'light' && m.hitstop > 0)!;
  const heavy = moves.find((m) => m.weight === 'heavy' && m.hitstop > 0)!;
  const ctx = (o: Partial<BeatContext> = {}): BeatContext => ({ player: me, cues: false, hitstop: 0, falling: new Set(), camera: { x: 0, y: 2, z: 0 }, ...o });
  /** An event with only the fields a beat reads (the rest of the sim's event doesn't matter here). */
  const ev = <T extends SimEvent['type']>(type: T, fields: Record<string, unknown>) => ({ type, ...fields }) as unknown as Extract<SimEvent, { type: T }>;
  const hit = (o: Record<string, unknown> = {}) =>
    ev('hit', { attacker: them, defender: me, move: light, weapon: null, counter: false, ko: false, armored: false, sever: null, fatal: null, ...o });
  /** Applies a beat's time effects to a real loop, as Game.present does. */
  const applyTo = (loop: GameLoop<FakeWorld>, b: Beat) => {
    loop.hitstop = b.hitstop;
    if (b.slow) loop.slowMotion(b.slow);
    if (b.treeLanded) loop.treeLanded(b.treeLanded.distanceM);
  };

  it("a blow's hit-pause comes from its move, kept short without cues; the struck body shivers", () => {
    const b = beatOf(hit(), ctx());
    expect(b.hitstop).toBe(Math.min(Math.round(light.hitstop), Math.max(2, Math.round(light.hitstop * 0.45))));
    expect(b.victim).toBe(me);
    expect(b.shake).toBeCloseTo(light.shake * 0.6);
    expect(b.slow).toBeNull();
    const cued = beatOf(hit({ move: heavy, counter: true }), ctx({ cues: true }));
    expect(cued.hitstop).toBe(Math.round(heavy.hitstop * 1.35));
    expect(cued.punch).toBe(1);
    // A longer pause already running is never shortened by a blow (with cues on).
    expect(beatOf(hit(), ctx({ cues: true, hitstop: 50 })).hitstop).toBe(50);
  });

  it('a severed limb or a split skull: slow motion (dismember), a bigger jolt', () => {
    const { loop } = rig();
    const b = beatOf(hit({ sever: 'foreArmL' }), ctx());
    expect(b.slow).toBe('dismember');
    expect(b.punch).toBe(1.2);
    applyTo(loop, b);
    expect(loop.slowmo).toBe(LOOP_TUNING.dismemberSlowmoS);
    expect(LOOP_TUNING.dismemberSlowmoS).toBe(0.6);
    expect(beatOf(hit({ fatal: 'split' }), ctx()).slow).toBe('dismember');
  });

  it('a perfect parry or your perfect dodge: slow motion (0.35 s); a plain block: a 3-step pause, 8 on a guard break', () => {
    const { loop } = rig();
    const parry = beatOf(ev('block', { attacker: them, defender: me, move: light, guardBreak: false, parry: true, perfect: true }), ctx());
    expect(parry.slow).toBe('parry');
    applyTo(loop, parry);
    expect(loop.slowmo).toBe(0.35);
    expect(beatOf(ev('block', { attacker: them, defender: me, move: light, guardBreak: false, parry: false }), ctx()).hitstop).toBe(3);
    expect(beatOf(ev('block', { attacker: them, defender: me, move: light, guardBreak: true, parry: false }), ctx()).hitstop).toBe(8);
    expect(beatOf(ev('dodge', { attacker: them, defender: me, move: light, kind: 'slip', perfect: true }), ctx()).slow).toBe('parry');
    expect(beatOf(ev('dodge', { attacker: me, defender: them, move: light, kind: 'slip', perfect: true }), ctx()).slow).toBeNull();
  });

  it("the player's KO: slow motion (1.5 s) and the colour drains; someone else's: a jolt only", () => {
    const { loop } = rig();
    const b = beatOf(ev('ko', { victim: me }), ctx());
    expect(b.slow).toBe('playerKo');
    expect(b.mood).toBe('death');
    expect(b.shake).toBeCloseTo(0.5 * me.scale);
    applyTo(loop, b);
    expect(loop.slowmo).toBe(1.5);
    const other = beatOf(ev('ko', { victim: them }), ctx());
    expect([other.slow, other.mood]).toEqual([null, null]);
    expect(other.shake).toBeGreaterThan(0);
  });

  it('a felled tree landing within 25 m of the camera is a 4-step hit-pause; farther, none', () => {
    const fell = beatOf(ev('fell', { tree: 9, dir: { x: 1, y: 0, z: 0 } }), ctx());
    expect(fell.treeFalling).toBe(9);
    const falling = new Set([9]);
    const near = beatOf(ev('land', { entity: 9, f: null, point: { x: 20, y: 2, z: 0 }, energy: 1e5, mass: 900 }), ctx({ falling }));
    expect(near.treeLanded).toEqual({ tree: 9, distanceM: 20 });
    const a = rig();
    applyTo(a.loop, near);
    expect(a.loop.hitstop).toBe(4);
    const far = beatOf(ev('land', { entity: 9, f: null, point: { x: 30, y: 2, z: 0 }, energy: 1e5, mass: 900 }), ctx({ falling }));
    const b = rig();
    applyTo(b.loop, far);
    expect(b.loop.hitstop).toBe(0);
    // A log that wasn't a falling tree is no beat.
    expect(beatOf(ev('land', { entity: 4, f: null, point: { x: 1, y: 0, z: 0 }, energy: 10, mass: 30 }), ctx({ falling })).treeLanded).toBeNull();
  });

  it("a world impact raises the sim's hit-pause hint and shakes the camera when it is yours", () => {
    const b = beatOf(ev('impact', { defender: me, hitstop: 5, shake: 0.3 }), ctx({ hitstop: 2 }));
    expect([b.hitstop, b.victim, b.shake]).toEqual([5, me, 0.3]);
    const other = beatOf(ev('impact', { defender: them, hitstop: 0, shake: 0.3 }), ctx({ hitstop: 2 }));
    expect([other.hitstop, other.shake]).toEqual([2, 0]);
  });

  it('death and respawn: the banner counts to the respawn tick, the respawn snaps the camera and the body back', () => {
    expect(beatOf(ev('death', { f: me, respawnTick: 700 }), ctx()).respawnTick).toBe(700);
    expect(beatOf(ev('death', { f: them, respawnTick: 700 }), ctx()).respawnTick).toBeUndefined();
    const r = beatOf(ev('respawn', { f: me, at: { x: 0, y: 0, z: 0 } }), ctx());
    expect([r.respawnTick, r.mood, r.snap]).toEqual([null, '', me]);
    expect(beatOf(ev('respawn', { f: them, at: { x: 0, y: 0, z: 0 } }), ctx()).snap).toBeNull();
  });

  it('a refused verb of yours says why', () => {
    expect(beatOf(ev('verb', { f: me, verb: 'take', ok: false, reason: 'tooHeavy' }), ctx()).popup).toBe('take: tooHeavy');
    expect(beatOf(ev('verb', { f: me, verb: 'take', ok: true }), ctx()).popup).toBeNull();
    expect(beatOf(ev('verb', { f: them, verb: 'take', ok: false }), ctx()).popup).toBeNull();
  });
});
