// The verb UI (docs/M1-DESIGN.md §10.7, §5.14; package P35), headless with a real World: scripted input frames produce
// exactly the expected commands. Focus only when the pick changes (and never one the sim would refuse, nor while
// locked on); take and drop on the sim's focus; Tab cycling; a ground focus; the two-step lash (radial → second target
// → confirm, cancel, timeout); throw aim and charge, quantised; place yaw, pitch (a sloped pitch from the ghost's cast
// onto a prop, then set by the sim at that angle) and drive; pull on and off with a rope end; strikes, and the clicks
// and keys the modes consume; the move flags; the belt; the pad; the radial's refusals in words; the prompts. And the
// package's definition of done: every verb of the radial runs from the keyboard and mouse and from a pad, each as the
// one command the sim accepts (stand-in handlers for the verbs P15 and P16 register).
//
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  AIM_STEPS,
  aimOf,
  aimVector,
  axisPitch,
  COMMAND_STEPS,
  type Command,
  createWorld,
  type JointRecord,
  MOVE_CROUCH,
  MOVE_SPRINT,
  PHYSICS_TUNING,
  physicsReady,
  planThrow,
  prismRForMass,
  resetTuning,
  type RopeView,
  spawnBox,
  spawnLog,
  spawnRopeCoil,
  spawnSapling,
  spawnStick,
  spawnStone,
  toCm,
  validateVerb,
  VERB_TUNING,
  type VerbCommand,
  type VerbHandler,
  type World,
  withVerbHandler,
} from '@wild/sim';
import { type Action, PAD } from '../src/input/bindings';
import type { FullInputFrame, InputFrame, PadFrame } from '../src/input/input';
import { chargeAfter, promptFor, VERB_UI_TUNING, VerbInput, type VerbUiDeps, yawSteps } from '../src/input/verbInput';
import { AimArc } from '../src/render/aimArc';
import { Ghost } from '../src/render/ghost';
import { Highlight } from '../src/render/highlight';
import { Radial, type RadialOption, reasonText, sectorAt, sectorDir } from '../src/ui/radial';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const live: World[] = [];

async function make(size = 40): Promise<World> {
  const w = await createWorld({ seed: 11, scene: 'empty', nav: 'off', size });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('VERB_UI_TUNING');
});

/** A frame with nothing pressed, held or moved, but `o`. */
function frame(o: Partial<FullInputFrame> = {}): InputFrame {
  return {
    moveX: 0,
    moveY: 0,
    presses: [],
    pickup: false,
    keys: [],
    pressed: [],
    held: new Set<Action>(),
    released: [],
    cycle: 0,
    cancel: false,
    mouse: { dx: 0, dy: 0, left: false, right: false },
    clicks: [],
    wheel: 0,
    look: { dx: 0, dy: 0, stickX: 0, stickY: 0, zoom: 0, aim: false },
    pad: null,
    ...o,
  };
}

/** A key going down this frame (and held). */
const keyDown = (a: Action, held: Action[] = []): Partial<FullInputFrame> => ({ pressed: [a], held: new Set([a, ...held]) });
const held = (...a: Action[]): Partial<FullInputFrame> => ({ held: new Set(a) });
const click = (button: 0 | 2, down = true): Partial<FullInputFrame> => ({ clicks: [{ button, down }], mouse: { dx: 0, dy: 0, left: button === 0 && down, right: button === 2 && down } });

/** A pad frame: buttons held (by index), the edges against `prev`, the sticks. */
function pad(down: number[], prev: number[] = [], sticks: Partial<Pick<PadFrame, 'lx' | 'ly' | 'rx' | 'ry'>> = {}): PadFrame {
  const h: boolean[] = [];
  for (let i = 0; i < 17; i++) h[i] = down.includes(i);
  return {
    held: h,
    pressed: down.filter((b) => !prev.includes(b)),
    released: prev.filter((b) => !down.includes(b)),
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    ...sticks,
  };
}

const verbs = (cmds: Command[], verb?: VerbCommand['verb']): VerbCommand[] => cmds.filter((c): c is VerbCommand => c.kind === 'verb' && (verb === undefined || c.verb === verb));
const buttons = (cmds: Command[]): string[] => cmds.flatMap((c) => (c.kind === 'button' ? [c.button] : []));
const moveOf = (cmds: Command[]) => {
  const m = cmds[0];
  if (m.kind !== 'move') throw new Error('the first command is the move');
  return m;
};

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A world, a camera and the verb UI over them. */
class Rig {
  readonly cam = new PerspectiveCamera(52, 16 / 9, 0.1, 600);
  fight = false;
  holdToCrouch = false;
  readonly scene = new Scene();
  readonly highlight = new Highlight(this.scene);
  readonly ghost = new Ghost(this.scene);
  readonly arc = new AimArc(this.scene);
  readonly radial = new Radial(null);
  readonly vi: VerbInput;

  constructor(
    readonly w: World,
    deps: Partial<VerbUiDeps> = {},
  ) {
    this.vi = new VerbInput(() => this.basis(), {
      world: w,
      view: () => ({ camera: this.cam, fight: this.fight }),
      prefs: () => ({ holdToCrouch: this.holdToCrouch }),
      highlight: this.highlight,
      ghost: this.ghost,
      arc: this.arc,
      radial: this.radial,
      ...deps,
    });
  }

  basis() {
    const d = new Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    d.y = 0;
    d.normalize();
    return { forward: d, right: new Vector3(-d.z, 0, d.x) };
  }

  /** The camera at `from`, looking at `to`. */
  look(from: P3, to: P3): void {
    this.cam.position.set(from.x, from.y, from.z);
    this.cam.lookAt(to.x, to.y, to.z);
    this.cam.updateMatrixWorld();
  }

  /** One frame: its commands, queued for the next tick, which is then stepped (`step` false: queued only, not stepped). */
  frame(o: Partial<FullInputFrame> = {}, step = true): Command[] {
    const cmds = this.vi.commands(frame(o), this.w.tick + 1);
    for (const c of cmds) this.w.commands.push(c);
    if (step) this.w.step();
    return cmds;
  }
}

/** The player at (x, z) facing `yaw`, settled. */
function stand(w: World, x: number, z: number, yaw = 0): void {
  w.teleport(w.player!, x, z, yaw);
  for (let i = 0; i < 3; i++) w.step();
}

/** A dry stick lying along x at (x, z). */
const stick = (w: World, x: number, z: number, length = 1, r = 0.03): number => spawnStick(w, { p: { x, y: r + 0.01, z }, length, r });

/** Steps until the player is free with nothing buffered. */
function untilFree(w: World, max = 600): void {
  for (let t = 0; t < max; t++) {
    w.step();
    const p = w.player!;
    if (p.free && !p.verbRequest && !p.work) return;
  }
  throw new Error(`the player was not free within ${max} ticks`);
}

// ---------------------------------------------------------------------------
// Focus, take, drop
// ---------------------------------------------------------------------------

describe('focus and take (§10.7: on change only; the sim’s focus is what a verb acts on)', () => {
  it('sends one focus when the pick changes, none while it stays, and G takes the sim’s focus', async () => {
    const w = await make();
    stand(w, 0, 0);
    const s = stick(w, 0, 1.2);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0.4, y: 2.6, z: -3.2 }, { x: 0, y: 0.04, z: 1.2 });
    let cmds = r.frame();
    expect(verbs(cmds)).toEqual([{ tick: w.tick, player: 1, kind: 'verb', verb: 'focus', target: s }]);
    expect(w.verbs.focusedEntity(w.player!)).toBe(s);
    for (let i = 0; i < 5; i++) expect(verbs(r.frame())).toEqual([]);
    // The outline is on the sim's focus, with its prompt.
    expect(r.highlight.visible).toBe(true);
    expect(promptFor(w, w.player!, r.vi.actTarget(w, w.player!))).toBe('G take · V verbs');
    cmds = r.frame({ pickup: true, pressed: ['pickup'], held: new Set(['pickup']) });
    expect(verbs(cmds)).toEqual([{ tick: w.tick, player: 1, kind: 'verb', verb: 'take', target: s }]);
    expect(buttons(cmds)).toEqual([]);
    untilFree(w);
    expect(w.player!.inventory!.hands?.entity).toBe(s);
    // Held, it is no target: the pick moves off it (a clear, or the ground), once.
    cmds = r.frame();
    const f = verbs(cmds, 'focus');
    expect(f).toHaveLength(1);
    expect(f[0].target).not.toBe(s);
    // G with nothing to take drops what the hands hold.
    r.look({ x: 0, y: 3, z: -3 }, { x: 0, y: 6, z: 20 });
    r.frame();
    cmds = r.frame({ pickup: true, pressed: ['pickup'] });
    expect(verbs(cmds)).toEqual([expect.objectContaining({ verb: 'drop', target: 0 })]);
  });

  it('never focuses what the sim would refuse, and sends none while locked on (the sim drops a focus then)', async () => {
    const w = await make();
    stand(w, 0, 0);
    // In the cone but 4 m away: out of reach, so no candidate (and no refused focus to pop up).
    stick(w, 0, 4.2);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 0.04, z: 4.2 });
    expect(verbs(r.frame(), 'focus').filter((c) => c.target > 0)).toEqual([]);
    // Every focus the UI sends, the sim accepts.
    const near = stick(w, 0, 1.2);
    w.step();
    const p = w.player!;
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 0.04, z: 1.2 });
    p.lockedOn = true;
    expect(verbs(r.vi.commands(frame(), w.tick + 1), 'focus')).toEqual([]);
    p.lockedOn = false;
    const cmds = r.vi.commands(frame(), w.tick + 1);
    expect(verbs(cmds, 'focus')).toEqual([expect.objectContaining({ target: near })]);
    for (const c of verbs(cmds, 'focus')) expect(validateVerb(w, p, c).ok).toBe(true);
  });

  it('Tab and Shift+Tab (D-pad → ←) cycle the candidates in score order', async () => {
    const w = await make();
    stand(w, 0, 0);
    const a = stick(w, -0.7, 1.4);
    const b = stick(w, 0.7, 1.4);
    w.step();
    const r = new Rig(w);
    // Aimed nearer b: b first.
    r.look({ x: 0.3, y: 2.6, z: -3 }, { x: 0.5, y: 0.04, z: 1.4 });
    expect(verbs(r.frame(), 'focus')).toEqual([expect.objectContaining({ target: b })]);
    expect(r.vi.targeting.candidates.map((c) => c.id)).toEqual([b, a]);
    expect(verbs(r.frame({ cycle: 1 }), 'focus')).toEqual([expect.objectContaining({ target: a })]);
    // Kept while the set is unchanged.
    expect(verbs(r.frame(), 'focus')).toEqual([]);
    expect(verbs(r.frame({ cycle: -1 }), 'focus')).toEqual([expect.objectContaining({ target: b })]);
    expect(verbs(r.frame({ pad: pad([PAD.right]) }), 'focus')).toEqual([expect.objectContaining({ target: a })]);
    expect(verbs(r.frame({ pad: pad([PAD.left], [PAD.right]) }), 'focus')).toEqual([expect.objectContaining({ target: b })]);
  });

  it('focuses the ground where the ray meets it within reach, again once the point moves groundRefocusM, and clears when there is none', async () => {
    const w = await make();
    stand(w, 0, 0);
    const r = new Rig(w);
    r.look({ x: 0, y: 2.8, z: -1.2 }, { x: 0, y: 0, z: 1.5 });
    let f = verbs(r.frame(), 'focus');
    expect(f).toHaveLength(1);
    expect(f[0].target).toBe(0);
    expect(f[0].at![2]).toBeGreaterThan(145);
    expect(f[0].at![2]).toBeLessThan(155);
    expect(Math.abs(f[0].at![1])).toBeLessThanOrEqual(1);
    expect(w.verbs.focusOf(w.player!)).toEqual({ target: 0, at: expect.objectContaining({ z: expect.closeTo(1.5, 1) }) });
    // 4 cm: not again; 20 cm: again.
    r.look({ x: 0, y: 2.8, z: -1.2 }, { x: 0, y: 0, z: 1.54 });
    expect(verbs(r.frame(), 'focus')).toEqual([]);
    r.look({ x: 0, y: 2.8, z: -1.2 }, { x: 0, y: 0, z: 1.7 });
    f = verbs(r.frame(), 'focus');
    expect(f).toHaveLength(1);
    expect(f[0].at![2]).toBeGreaterThan(165);
    // At the sky: a clear (target 0, no point).
    r.look({ x: 0, y: 2.8, z: -1.2 }, { x: 0, y: 6, z: 20 });
    expect(verbs(r.frame(), 'focus')).toEqual([{ tick: w.tick, player: 1, kind: 'verb', verb: 'focus', target: 0 }]);
    expect(w.verbs.focusOf(w.player!)).toBeNull();
  });

  it('in the fight camera aims along the facing, with the wider cone', async () => {
    const w = await make();
    stand(w, 0, 0, 0);
    const s = stick(w, 0.3, 1.0);
    w.step();
    const r = new Rig(w);
    // The camera looks away; the facing (+z) sees the stick.
    r.look({ x: 3, y: 2, z: 0 }, { x: 10, y: 2, z: 0 });
    expect(verbs(r.frame(), 'focus').filter((c) => c.target > 0)).toEqual([]);
    r.fight = true;
    expect(verbs(r.frame(), 'focus')).toEqual([expect.objectContaining({ target: s })]);
  });
});

// ---------------------------------------------------------------------------
// The radial and the two-step lash
// ---------------------------------------------------------------------------

/** A stand-in for a verb P15 or P16 registers: it acts on nothing, so only the commands are under test. */
const standIn = (verb: VerbHandler['verb'], target: VerbHandler['target'], second = false): VerbHandler => ({ verb, target, second, validate: () => null, start: () => null });
const STAND_IN_LASH = standIn('lash', 'entity', true);
/** Every radial verb whose module isn't merged yet (verbsFor leaves out a verb with no handler). */
const STAND_INS: readonly VerbHandler[] = [
  STAND_IN_LASH,
  standIn('tie', 'entity'),
  standIn('bend', 'entity', true),
  standIn('untie', 'entity'),
  standIn('cut', 'entity'),
  standIn('shape', 'entity'),
  standIn('dig', 'ground'),
];

/** Runs `run` with every stand-in in place. */
function withStandIns<T>(run: () => T, hs: readonly VerbHandler[] = STAND_INS): T {
  return hs.length === 0 ? run() : withVerbHandler(hs[0], () => withStandIns(run, hs.slice(1)));
}

/** How a test drives the verb UI: the keyboard and mouse, or a pad. */
type Via = 'keys' | 'pad';

/**
 * Opens the radial (V held, or the pad's LB held), points at the option `pick` chooses (the mouse, or the right stick),
 * and lets go: the commands of that last frame. The option must be offered and enabled. (`step` false: nothing is
 * stepped.)
 */
function radialRun(r: Rig, via: Via, pick: (o: RadialOption) => boolean, step = true): Command[] {
  r.frame(via === 'keys' ? keyDown('verb') : { pad: pad([PAD.lb]) }, step);
  expect(r.vi.mode).toBe('radial');
  const opts = r.radial.shown;
  const i = opts.findIndex(pick);
  expect(i, `offered: ${opts.map((o) => `${o.verb}${o.slot ?? ''}`).join(', ')}`).toBeGreaterThanOrEqual(0);
  expect(opts[i].disabled, `${opts[i].verb} refused`).toBeNull();
  const d = sectorDir(i, opts.length);
  if (via === 'keys') r.frame({ ...held('verb'), mouse: { dx: d.x * 80, dy: d.y * 80, left: false, right: false } }, step);
  else r.frame({ pad: pad([PAD.lb], [PAD.lb], { rx: d.x, ry: d.y }) }, step);
  expect(r.radial.selected).toBe(opts[i]);
  return r.frame(via === 'keys' ? { released: ['verb'] } : { pad: pad([], [PAD.lb], { rx: d.x, ry: d.y }) }, step);
}

/** Opens the radial with V, moves the cursor onto `verb`'s sector, releases: the commands of that last frame. */
function radialPick(r: Rig, verb: VerbCommand['verb']): Command[] {
  return radialRun(r, 'keys', (o) => o.verb === verb);
}

/** The second target's confirm: LMB, or the pad's A. */
const confirmSecond = (r: Rig, via: Via): Command[] => r.frame(via === 'keys' ? click(0) : { pad: pad([PAD.a]) });

/** The one command of `cmds` besides a focus, which the sim accepts; no strike or jump came with it. */
function onlyVerb(w: World, cmds: Command[]): VerbCommand {
  const v = verbs(cmds).filter((c) => c.verb !== 'focus');
  expect(v).toHaveLength(1);
  expect(validateVerb(w, w.player!, v[0])).toEqual({ ok: true });
  expect(buttons(cmds)).toEqual([]);
  return v[0];
}

/** A command's whole-cm point lies on the entity's surface (an anchor the sim accepts). */
function expectOnSurface(w: World, id: number, at: readonly number[] | undefined): void {
  expect(at).toBeDefined();
  expect(w.queries.projectPoint(id, { x: at![0] / 100, y: at![1] / 100, z: at![2] / 100 }).dist).toBeLessThan(0.02);
}

/**
 * A rope tied between two world points, made of the rope entity `rope` (now 'tied'). P10's joints aren't merged: the
 * joint store's reads stand in for its one rope joint (what targeting draws and the sim measures range and anchors to).
 */
function fakeTiedRope(w: World, rope: number, a: P3, b: P3): void {
  w.entities.setState(w.entities.get(rope)!, 'tied');
  const lengthM = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const rec: JointRecord = {
    id: 1,
    kind: 'rope',
    a: { entity: null, local: { ...a } },
    b: { entity: null, local: { ...b } },
    rope: { entity: rope, lengthM },
    breakEnergyJ: Infinity,
    axis: null,
    limits: null,
    motor: null,
    holdsBend: null,
    tension: [0, 0, 0],
    pullN: 0,
    credit: [],
  };
  const view: RopeView = { joint: 1, a: { ...a }, b: { ...b }, lengthM, taut: true, strain: 0 };
  w.joints.all = () => [rec];
  w.joints.get = (id: number) => (id === 1 ? rec : undefined);
  w.joints.view = () => [view];
}

describe('the radial and the two-step lash (§10.7, D-48)', () => {
  it('V opens verbsFor’s options for the focus; lash goes to the second target; LMB confirms one lash with both anchors', async () => {
    const w = await make();
    stand(w, 0, 0);
    const a = stick(w, -0.7, 1.3);
    const b = stick(w, 0.7, 1.3);
    w.step();
    const r = new Rig(w);
    withVerbHandler(STAND_IN_LASH, () => {
      r.look({ x: -0.5, y: 2.6, z: -3 }, { x: -0.6, y: 0.04, z: 1.3 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(a);
      const last = radialPick(r, 'lash');
      expect(verbs(last).filter((c) => c.verb !== 'focus')).toEqual([]);
      expect(r.vi.mode).toBe('second');
      expect(r.vi.first).toMatchObject({ kind: 'entity', id: a });
      expect(r.radial.isOpen).toBe(false);
      // The second target: aim at b, then LMB.
      r.look({ x: 0.5, y: 2.6, z: -3 }, { x: 0.6, y: 0.04, z: 1.3 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(b);
      const cmds = r.frame(click(0));
      const lash = verbs(cmds, 'lash');
      expect(lash).toEqual([{ tick: w.tick, player: 1, kind: 'verb', verb: 'lash', target: a, second: b, at: expect.any(Array), at2: expect.any(Array) }]);
      // The left click was the mode's, not a punch.
      expect(buttons(cmds)).toEqual([]);
      expect(r.vi.mode).toBe('idle');
      // The anchors lie on their sticks (whole cm), as the sim requires (anchorSurfaceTolM).
      const dist = (id: number, at: readonly number[]) => w.queries.projectPoint(id, { x: at[0] / 100, y: at[1] / 100, z: at[2] / 100 }).dist;
      expect(dist(a, lash[0].at!)).toBeLessThan(0.02);
      expect(dist(b, lash[0].at2!)).toBeLessThan(0.02);
      expect(validateVerb(w, w.player!, lash[0]).ok).toBe(true);
    });
  });

  it('E confirms too; RMB, Esc or pad B cancels; it lapses after secondTimeoutS; the first target alone never confirms', async () => {
    const w = await make();
    stand(w, 0, 0);
    const a = stick(w, -0.7, 1.3);
    const b = stick(w, 0.7, 1.3);
    w.step();
    const r = new Rig(w);
    withVerbHandler(STAND_IN_LASH, () => {
      const toSecond = () => {
        r.look({ x: -0.5, y: 2.6, z: -3 }, { x: -0.6, y: 0.04, z: 1.3 });
        r.frame();
        radialPick(r, 'lash');
        expect(r.vi.mode).toBe('second');
      };
      // Still on the first: LMB waits.
      toSecond();
      expect(verbs(r.frame(click(0)), 'lash')).toEqual([]);
      expect(r.vi.mode).toBe('second');
      // E on the second.
      r.look({ x: 0.5, y: 2.6, z: -3 }, { x: 0.6, y: 0.04, z: 1.3 });
      r.frame();
      const e = r.frame({ pressed: ['rpunch'], presses: ['rpunch'], held: new Set(['rpunch']) });
      expect(verbs(e, 'lash')).toEqual([expect.objectContaining({ target: a, second: b })]);
      expect(buttons(e)).toEqual([]);
      for (const cancel of [click(2), { cancel: true }, { pad: pad([PAD.b]) }] as Partial<FullInputFrame>[]) {
        toSecond();
        const c = r.frame(cancel);
        expect(r.vi.mode).toBe('idle');
        expect(verbs(c, 'lash')).toEqual([]);
        expect(buttons(c)).toEqual([]);
      }
      toSecond();
      const late = r.vi.commands(frame(click(0)), w.tick + Math.round(VERB_UI_TUNING.secondTimeoutS * 60) + 1);
      expect(verbs(late, 'lash')).toEqual([]);
      expect(r.vi.mode).toBe('idle');
    });
  });

  it('greys refused options with their reason, and running one sends nothing; the pad’s LB opens it and the stick picks', async () => {
    const w = await make();
    stand(w, 0, 0);
    const L = 4;
    const heavy = spawnLog(w, { p: { x: 0, y: 0.5, z: 1.6 }, length: L, mass: 300 });
    for (let i = 0; i < 30; i++) w.step();
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 0.2, z: 1.6 });
    r.frame();
    expect(w.verbs.focusedEntity(w.player!)).toBe(heavy);
    expect(promptFor(w, w.player!, r.vi.actTarget(w, w.player!))).toBe('too heavy (300 kg) · V verbs');
    r.frame(keyDown('verb'));
    const take = r.radial.shown.find((o) => o.verb === 'take');
    expect(take).toEqual({ verb: 'take', label: 'Take', disabled: 'too heavy (300 kg)' });
    const d = sectorDir(r.radial.shown.indexOf(take!), r.radial.shown.length);
    r.frame({ ...held('verb'), mouse: { dx: d.x * 80, dy: d.y * 80, left: false, right: false } });
    expect(verbs(r.frame({ released: ['verb'] })).filter((c) => c.verb !== 'focus')).toEqual([]);
    expect(r.vi.mode).toBe('idle');
    // The pad: LB opens it, the stick points, releasing LB runs it (here the refused take: nothing).
    r.frame({ pad: pad([PAD.lb]) });
    expect(r.vi.mode).toBe('radial');
    r.frame({ pad: pad([PAD.lb], [PAD.lb], { rx: d.x, ry: d.y }) });
    expect(r.radial.selected?.verb).toBe('take');
    r.frame({ pad: pad([], [PAD.lb]) });
    expect(r.vi.mode).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Every radial verb, from the keyboard and mouse and from a pad (P35's definition of done)
// ---------------------------------------------------------------------------

describe.each(['keys', 'pad'] as const)('every radial verb runs from the %s, as the one command the sim accepts (§5.13, §5.14)', (via) => {
  it('tie, cut, shape and take on a stick (each anchor on its surface)', async () => {
    const w = await make();
    stand(w, 0, 0);
    const s = stick(w, 0, 1.2);
    w.step();
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: 0.4, y: 2.6, z: -3.2 }, { x: 0, y: 0.04, z: 1.2 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(s);
      const tie = onlyVerb(w, radialRun(r, via, (o) => o.verb === 'tie'));
      expect(tie).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'tie', target: s, at: expect.any(Array) });
      expectOnSurface(w, s, tie.at);
      expect(onlyVerb(w, radialRun(r, via, (o) => o.verb === 'cut'))).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'cut', target: s });
      const shape = onlyVerb(w, radialRun(r, via, (o) => o.verb === 'shape'));
      expect(shape).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'shape', target: s, at: expect.any(Array), charge: 1 });
      expectOnSurface(w, s, shape.at);
      expect(onlyVerb(w, radialRun(r, via, (o) => o.verb === 'take'))).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'take', target: s });
      expect(r.vi.mode).toBe('idle');
      untilFree(w);
      expect(w.player!.inventory!.hands?.entity).toBe(s);
    });
  });

  it('lash: the radial, then the second target, confirmed (LMB, or A)', async () => {
    const w = await make();
    stand(w, 0, 0);
    const a = stick(w, -0.7, 1.3);
    const b = stick(w, 0.7, 1.3);
    w.step();
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: -0.5, y: 2.6, z: -3 }, { x: -0.6, y: 0.04, z: 1.3 });
      r.frame();
      expect(verbs(radialRun(r, via, (o) => o.verb === 'lash')).filter((c) => c.verb !== 'focus')).toEqual([]);
      expect(r.vi.mode).toBe('second');
      r.look({ x: 0.5, y: 2.6, z: -3 }, { x: 0.6, y: 0.04, z: 1.3 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(b);
      const lash = onlyVerb(w, confirmSecond(r, via));
      expect(lash).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'lash', target: a, second: b, at: expect.any(Array), at2: expect.any(Array) });
      expectOnSurface(w, a, lash.at);
      expectOnSurface(w, b, lash.at2);
      expect(r.vi.mode).toBe('idle');
    });
  });

  it('bend: a rooted sapling, then what holds it down, confirmed (LMB, or A)', async () => {
    const w = await make();
    stand(w, 0, 0);
    const sapling = spawnSapling(w, { at: { x: -0.6, z: 1.3 }, diameter: 0.05, height: 2.5 });
    const stake = stick(w, 0.7, 1.3);
    w.step();
    expect(w.entities.get(sapling)!.plant).not.toBeNull();
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: -0.5, y: 2.2, z: -3 }, { x: -0.6, y: 1.1, z: 1.3 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(sapling);
      expect(verbs(radialRun(r, via, (o) => o.verb === 'bend')).filter((c) => c.verb !== 'focus')).toEqual([]);
      expect(r.vi.mode).toBe('second');
      expect(r.vi.first).toMatchObject({ kind: 'entity', id: sapling });
      r.look({ x: 0.5, y: 2.6, z: -3 }, { x: 0.6, y: 0.04, z: 1.3 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(stake);
      const bend = onlyVerb(w, confirmSecond(r, via));
      expect(bend).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'bend', target: sapling, second: stake, at2: expect.any(Array) });
      expectOnSurface(w, stake, bend.at2);
      expect(r.vi.mode).toBe('idle');
    });
  });

  it('untie a tied rope (aimed at along its segment)', async () => {
    const w = await make();
    stand(w, 0, 0);
    const rope = spawnRopeCoil(w, { at: { x: 0, y: 0.05, z: 1.4 }, material: 'vine', lengthM: 2 });
    w.step();
    fakeTiedRope(w, rope, { x: -0.8, y: 1, z: 1.4 }, { x: 0.8, y: 1, z: 1.4 });
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: 0.2, y: 2.4, z: -3 }, { x: 0.1, y: 1, z: 1.4 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(rope);
      expect(onlyVerb(w, radialRun(r, via, (o) => o.verb === 'untie'))).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'untie', target: rope });
    });
  });

  it('dig the ground where the aim meets it', async () => {
    const w = await make();
    stand(w, 0, 0);
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: 0, y: 2.8, z: -1.2 }, { x: 0, y: 0, z: 1.5 });
      r.frame();
      expect(w.verbs.focusOf(w.player!)?.target).toBe(0);
      const dig = onlyVerb(w, radialRun(r, via, (o) => o.verb === 'dig'));
      expect(dig).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'dig', target: 0, at: expect.any(Array), charge: 1 });
      expect(Math.abs(dig.at![2] - 150)).toBeLessThanOrEqual(5);
      expect(Math.abs(dig.at![1])).toBeLessThanOrEqual(1);
    });
  });

  it('with nothing aimed at: stow what the hands hold on the belt or the back, or drop it', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const stone = spawnStone(w, { p: { x: 0.4, y: 0.2, z: 0.4 }, mass: 1 });
    w.step();
    expect(w.verbs.putInHands(p, stone)).toBe(true);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 6, z: 20 });
    r.frame();
    expect(w.verbs.focusOf(p)).toBeNull();
    // (Nothing is stepped: each runs on the stone still in the hands.)
    const belt = onlyVerb(w, radialRun(r, via, (o) => o.verb === 'stow' && o.slot === 0, false));
    expect(belt).toEqual({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'stow', target: 0, slot: 0 });
    const back = onlyVerb(w, radialRun(r, via, (o) => o.verb === 'stow' && o.slot === 3, false));
    expect(back).toEqual({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'stow', target: 0, slot: 3 });
    const drop = onlyVerb(w, radialRun(r, via, (o) => o.verb === 'drop', false));
    expect(drop).toEqual({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'drop', target: 0 });
  });
});

describe('the pad’s own paths (§5.14)', () => {
  it('RS takes the focus, and drops what the hands hold when nothing takeable is focused', async () => {
    const w = await make();
    stand(w, 0, 0);
    const s = stick(w, 0, 1.2);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0.4, y: 2.6, z: -3.2 }, { x: 0, y: 0.04, z: 1.2 });
    r.frame();
    const take = r.frame({ pad: pad([PAD.rs]) });
    expect(onlyVerb(w, take)).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'take', target: s });
    untilFree(w);
    expect(w.player!.inventory!.hands?.entity).toBe(s);
    r.look({ x: 0, y: 3, z: -3 }, { x: 0, y: 6, z: 20 });
    r.frame();
    // (Not stepped: the drop is checked against the hands still holding it.)
    expect(onlyVerb(w, r.frame({ pad: pad([PAD.rs]) }, false))).toEqual({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'drop', target: 0 });
  });

  it('the stick’s pick stays as it springs back, so a flick and a release of LB runs it; B closes the radial, running nothing', async () => {
    const w = await make();
    stand(w, 0, 0);
    const s = stick(w, 0, 1.2);
    w.step();
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: 0.4, y: 2.6, z: -3.2 }, { x: 0, y: 0.04, z: 1.2 });
      r.frame();
      const flickTo = (verb: VerbCommand['verb']) => {
        r.frame({ pad: pad([PAD.lb]) });
        const opts = r.radial.shown;
        const d = sectorDir(
          opts.findIndex((o) => o.verb === verb),
          opts.length,
        );
        r.frame({ pad: pad([PAD.lb], [PAD.lb], { rx: d.x, ry: d.y }) });
        // The stick springs back while LB is still held.
        r.frame({ pad: pad([PAD.lb], [PAD.lb]) });
        expect(r.radial.selected?.verb).toBe(verb);
      };
      flickTo('cut');
      // Let go with the stick centred: it runs.
      expect(onlyVerb(w, r.frame({ pad: pad([], [PAD.lb]) }))).toEqual({ tick: w.tick, player: 1, kind: 'verb', verb: 'cut', target: s });
      expect(r.vi.mode).toBe('idle');
      flickTo('cut');
      const b = r.frame({ pad: pad([PAD.lb, PAD.b], [PAD.lb]) });
      expect(r.vi.mode).toBe('idle');
      expect(r.radial.isOpen).toBe(false);
      expect(verbs(b).filter((c) => c.verb !== 'focus')).toEqual([]);
      // B closed it: no crouch, and letting go of LB then runs nothing.
      expect(moveOf(b).flags ?? 0).toBe(0);
      expect(verbs(r.frame({ pad: pad([], [PAD.lb, PAD.b]) })).filter((c) => c.verb !== 'focus')).toEqual([]);
    });
  });
});

describe('the radial’s aimed point (§5.2 anchors)', () => {
  it('lies on the target’s surface: a boulder seen corner-on still offers tie, and the tie is accepted', async () => {
    const w = await make();
    stand(w, 0, 0);
    const boulder = spawnStone(w, { p: { x: 0, y: 1, z: 2.2 }, mass: 2000 });
    for (let i = 0; i < 60; i++) w.step();
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: -0.6, y: 2.4, z: -2.5 }, { x: 1.2, y: 0.8, z: 2.2 });
      r.frame();
      expect(w.verbs.focusedEntity(w.player!)).toBe(boulder);
      // The pick's point is on the box bounding the boulder, further off its surface than an anchor may be.
      const pick = r.vi.target;
      expect(pick?.kind).toBe('entity');
      expect(w.queries.projectPoint(boulder, pick!.at).dist).toBeGreaterThan(VERB_TUNING.anchorSurfaceTolM);
      // What the verbs get is on the surface.
      expect(w.queries.projectPoint(boulder, r.vi.actTarget(w, w.player!)!.at).dist).toBeLessThan(1e-3);
      const tie = onlyVerb(w, radialRun(r, 'keys', (o) => o.verb === 'tie'));
      expect(tie).toMatchObject({ verb: 'tie', target: boulder });
      expectOnSurface(w, boulder, tie.at);
    });
  });
});

describe('the radial’s arithmetic and words', () => {
  it('sectors run clockwise from the top, none inside the dead zone', () => {
    expect(sectorAt(0, -50, 4, 28)).toBe(0);
    expect(sectorAt(50, 0, 4, 28)).toBe(1);
    expect(sectorAt(0, 50, 4, 28)).toBe(2);
    expect(sectorAt(-50, 0, 4, 28)).toBe(3);
    expect(sectorAt(10, -10, 4, 28)).toBeNull();
    expect(sectorAt(10, -50, 0, 28)).toBeNull();
    for (let n = 1; n <= 8; n++) for (let i = 0; i < n; i++) expect(sectorAt(sectorDir(i, n).x * 60, sectorDir(i, n).y * 60, n, 28)).toBe(i);
    expect(reasonText('tooHeavy', 210.4)).toBe('too heavy (210 kg)');
    expect(reasonText('noEdge')).toBe('needs an edge');
    const r = new Radial(null);
    r.open([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ verb: 'take' as const, label: `o${i}`, disabled: null })));
    expect(r.shown).toHaveLength(8);
    // The cursor stays on the ring.
    r.point(1000, 0);
    expect(Math.hypot(r.cursor.x, r.cursor.y)).toBeCloseTo(VERB_UI_TUNING.radialRadiusPx);
  });
});

// ---------------------------------------------------------------------------
// Throw
// ---------------------------------------------------------------------------

describe('throw (§5.11, §10.7)', () => {
  async function withStone(): Promise<{ w: World; r: Rig; stone: number }> {
    const w = await make();
    stand(w, 0, 0);
    const stone = spawnStone(w, { p: { x: 0.4, y: 0.2, z: 0.4 }, mass: 1 });
    w.step();
    expect(w.verbs.putInHands(w.player!, stone)).toBe(true);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0.55, y: 2.1, z: -3.5 }, { x: 0.55, y: 2.6, z: 20 });
    return { w, r, stone };
  }

  it('hold X: the arc and a charge rising over throwChargeS in sim ticks; release throws once, the aim and charge quantised', async () => {
    const { w, r } = await withStone();
    r.frame(keyDown('throw'));
    expect(r.vi.mode).toBe('throwAim');
    const t0 = w.tick;
    while (w.tick - t0 < 17) r.frame(held('throw'));
    expect(r.arc.visible).toBe(true);
    expect(r.arc.last!.points).toHaveLength(VERB_UI_TUNING.arcPoints);
    // The arc starts at the hand and rises along the aim before it falls.
    const pts = r.arc.last!.points;
    expect(pts[1].y).toBeGreaterThan(pts[0].y);
    const cmds = r.frame({ released: ['throw'] });
    const thr = verbs(cmds, 'throw');
    // Released 18 ticks after the press: 0.3 s of throwChargeS 0.6 s, half way from 0.5 to full speed.
    expect(thr).toEqual([{ tick: w.tick, player: 1, kind: 'verb', verb: 'throw', target: 0, aim: expect.any(Array), charge: 128 }]);
    expect(chargeAfter(18)).toBe(128);
    const [yaw, pitch] = thr[0].aim!;
    for (const v of [yaw, pitch, thr[0].charge!]) expect(Number.isInteger(v)).toBe(true);
    expect(yaw).toBeGreaterThanOrEqual(0);
    expect(yaw).toBeLessThan(AIM_STEPS);
    expect(thr[0].aim).toEqual(aimOf(r.vi.aiming.dir));
    // Forward (+z) and up a little, converging on what the crosshair rests on.
    const d = aimVector(thr[0].aim!, new Vector3());
    expect(d.z).toBeGreaterThan(0.95);
    expect(d.y).toBeGreaterThan(0);
    expect(r.vi.mode).toBe('idle');
    expect(buttons(cmds)).toEqual([]);
    expect(validateVerb(w, w.player!, thr[0]).ok).toBe(true);
  });

  it('caps the charge at 255; LMB, Esc or pad B cancel (the release then throws nothing); the pad’s RB aims and throws', async () => {
    const { w, r } = await withStone();
    expect(chargeAfter(36)).toBe(255);
    expect(chargeAfter(1000)).toBe(255);
    expect(chargeAfter(0)).toBe(0);
    r.frame(keyDown('throw'));
    r.vi.commands(frame(held('throw')), w.tick + 100);
    expect(r.vi.aiming.charge).toBe(COMMAND_STEPS - 1);
    // LMB cancels: no punch, and no throw on the release.
    let cmds = r.frame({ ...held('throw'), ...click(0) });
    expect(buttons(cmds)).toEqual([]);
    expect(r.vi.mode).toBe('idle');
    expect(verbs(r.frame({ released: ['throw'] }), 'throw')).toEqual([]);
    for (const cancel of [{ cancel: true }, { pad: pad([PAD.b]) }] as Partial<FullInputFrame>[]) {
      r.frame(keyDown('throw'));
      r.frame({ ...held('throw'), ...cancel });
      expect(r.vi.mode).toBe('idle');
      expect(verbs(r.frame({ released: ['throw'] }), 'throw')).toEqual([]);
    }
    r.frame({ pad: pad([PAD.rb]) });
    expect(r.vi.mode).toBe('throwAim');
    r.frame({ pad: pad([PAD.rb], [PAD.rb]) });
    cmds = r.frame({ pad: pad([], [PAD.rb]) });
    expect(verbs(cmds, 'throw')).toEqual([expect.objectContaining({ verb: 'throw', charge: chargeAfter(2) })]);
  });

  it('in the fight camera throws along the facing, pitched up fightThrowPitchDeg (aim doesn’t override the fight camera)', async () => {
    const { w, r } = await withStone();
    r.fight = true;
    r.frame(keyDown('throw'));
    const thr = verbs(r.frame({ released: ['throw'] }), 'throw');
    const p = w.player!;
    const want = VERB_UI_TUNING.fightThrowPitchDeg * (Math.PI / 180);
    expect(thr[0].aim).toEqual(aimOf({ x: Math.sin(p.yaw) * Math.cos(want), y: Math.sin(want), z: Math.cos(p.yaw) * Math.cos(want) }));
  });

  it('nothing in the hands, a dragged log or a rope end: X (RB) starts no aim, and C (D-pad ↓) no placement', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 2, z: 20 });
    const noModes = (what: string) => {
      for (const start of [keyDown('throw'), keyDown('place'), { pad: pad([PAD.rb]) }, { pad: pad([PAD.down]) }] as Partial<FullInputFrame>[]) {
        r.frame(start);
        expect(r.vi.mode, what).toBe('idle');
        const end = verbs(r.frame({ released: ['throw', 'place'], pad: pad([]) }));
        expect(end.filter((c) => c.verb === 'throw' || c.verb === 'place'), what).toEqual([]);
      }
    };
    noModes('empty hands');
    const log = spawnLog(w, { p: { x: 0, y: 0.4, z: 1.5 }, length: 3, mass: 100 });
    w.step();
    expect(w.verbs.putInHands(p, log)).toBe(true);
    w.step();
    expect(p.inventory!.hands?.mode).toBe('drag');
    noModes('dragging');
    // (Holding a rope end needs P10's joints; the hands' record is what the UI reads.)
    p.inventory!.hands = { entity: log, mode: 'ropeEnd', grip: { x: 0, y: 0, z: 0 }, twoHanded: false, joint: null };
    for (const start of [keyDown('throw'), keyDown('place')]) {
      r.frame(start, false);
      expect(r.vi.mode, 'a rope end').toBe('idle');
    }
  });

  it('the arc: the sim’s own launch velocity, with the walk for a thrown body (not for a projectile), ending on what is in the way', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const heavy = spawnStone(w, { p: { x: 0.4, y: 0.3, z: 0.4 }, mass: 3 });
    w.step();
    expect(w.verbs.putInHands(p, heavy)).toBe(true);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0.55, y: 2.1, z: -3.5 }, { x: 0.55, y: 2.6, z: 20 });
    r.frame(keyDown('throw'), false);
    r.frame(held('throw'), false);
    expect(r.vi.mode).toBe('throwAim');
    const plan = (charge: number) => planThrow(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'throw', target: 0, aim: aimOf(r.vi.aiming.dir), charge });
    const pl = plan(r.vi.aiming.charge);
    if (!pl.ok) throw new Error('the throw is refused');
    expect(pl.plan.path).toBe('body');
    const still = r.vi.throwVelocity(w, p)!;
    expect(still.distanceTo(new Vector3(pl.plan.dir.x, pl.plan.dir.y, pl.plan.dir.z).multiplyScalar(pl.plan.speed))).toBeLessThan(1e-9);
    // Walking: a thrown body takes the walk with it (§5.11: linvel = aim·v + walkVel).
    p.walkVel.set(1.5, 0, 0.5);
    const walking = r.vi.throwVelocity(w, p)!;
    expect(walking.clone().sub(still).distanceTo(new Vector3(1.5, 0, 0.5))).toBeLessThan(1e-9);
    // The arc's first step leaves the hand at that velocity.
    r.frame(held('throw'), false);
    const pts = r.arc.last!.points;
    const dt = r.arc.last!.t / (pts.length - 1);
    expect(pts[1].x - pts[0].x).toBeCloseTo(r.vi.throwVelocity(w, p)!.x * dt, 6);
    // On open ground it lands on the terrain.
    expect(r.arc.last!.landed).toBe(true);
    expect(r.arc.last!.struck).toBe(false);
    const open = pts[pts.length - 1].z;
    // A wall in the way: the arc ends on it.
    spawnBox(w, { p: { x: 0.5, y: 1.5, z: 3 }, size: [4, 3, 0.4], material: 'stone', state: 'fixed', look: 'wall' });
    w.step();
    expect(open).toBeGreaterThan(3);
    r.frame(held('throw'), false);
    const arc = r.arc.last!;
    expect(arc.struck).toBe(true);
    expect(arc.points[arc.points.length - 1].z).toBeCloseTo(2.8, 1);
    p.walkVel.set(0, 0, 0);
  });

  it('a wielded tool of ≤ projectileMaxKg flies as a projectile: no walk added', async () => {
    const { w, r } = await withStone();
    const p = w.player!;
    r.frame(keyDown('throw'), false);
    const still = r.vi.throwVelocity(w, p)!;
    p.walkVel.set(1.5, 0, 0.5);
    expect(r.vi.throwVelocity(w, p)!.distanceTo(still)).toBeLessThan(1e-9);
    p.walkVel.set(0, 0, 0);
  });
});

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

describe('place (§5.7, §10.7)', () => {
  /**
   * The AC-2(a) lean (as P17's place test builds it): a dry stick r 0.07 m × 2.4 m set upright as a free prop at
   * x = propX; a dry hex log 5 m, 40 kg in the hands, the player at (2, −1.2); the camera looking along +x at the ground
   * at the origin, where the log's lower end is to go.
   */
  async function leanScene(): Promise<{ w: World; r: Rig; prop: number; log: number }> {
    const w = await make(60);
    const p = w.player!;
    const inradius = 0.07 * Math.cos(Math.PI / 8);
    const propX = 3.71 + inradius;
    const prop = spawnStick(w, { p: { x: 5, y: 0.08, z: -3 }, length: 2.4, r: 0.07 });
    w.step();
    stand(w, propX, -1.2);
    expect(w.verbs.putInHands(p, prop)).toBe(true);
    w.step();
    w.commands.push({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'place', target: 0, at: toCm({ x: propX, y: 1.2, z: 0 }), yaw: 0, pitch: 64, drive: 0 });
    untilFree(w);
    for (let i = 0; i < 60; i++) w.step();
    expect(w.entities.get(prop)!.state).toBe('free');
    const r0 = prismRForMass(40, 5, 550, PHYSICS_TUNING.logFacets);
    const log = spawnLog(w, { p: { x: 2, y: r0 + 0.01, z: -3 }, length: 5, mass: 40 });
    w.step();
    stand(w, 2, -1.2);
    expect(w.verbs.putInHands(p, log)).toBe(true);
    w.step();
    expect(p.inventory!.hands?.mode).toBe('carry');
    const r = new Rig(w);
    r.look({ x: -2.5, y: 2.2, z: 0 }, { x: 0, y: 0, z: 0 });
    return { w, r, prop, log };
  }

  it('C previews; RMB cycles lying → upright → sloped; sloped carries the pitch of the cast onto the prop; LMB sets it there', async () => {
    const { w, r, log } = await leanScene();
    r.frame(keyDown('place'));
    expect(r.vi.mode).toBe('place');
    // The ghost along the view (+x: yaw 64/256 turn), lying.
    expect(r.vi.preview?.cmd).toMatchObject({ verb: 'place', yaw: 64, pitch: 0 });
    expect(r.vi.placing.orientation).toBe('lying');
    expect(r.ghost.visible).toBe(true);
    r.frame({ ...held('place'), ...click(2) });
    expect(r.vi.placing.orientation).toBe('upright');
    expect(r.vi.preview?.cmd.pitch).toBe(64);
    r.frame({ ...held('place'), ...click(2) });
    expect(r.vi.placing.orientation).toBe('sloped');
    const pv = r.vi.preview!;
    expect(pv.ok).toBe(true);
    expect(r.ghost.fits).toBe(true);
    // 2.4 m up over 3.71 m: 32.9°, the command's 23/256 turn (the sim's own cast refines it when it lands).
    expect(pv.cmd.pitch).toBe(Math.round((32.9 / 360) * COMMAND_STEPS));
    expect(pv.cmd.yaw).toBe(64);
    expect(pv.cmd.drive).toBeUndefined();
    const cmds = r.frame({ ...held('place'), ...click(0) });
    const place = verbs(cmds, 'place');
    expect(place).toEqual([{ ...pv.cmd, tick: w.tick }]);
    expect(buttons(cmds)).toEqual([]);
    expect(r.vi.mode).toBe('idle');
    untilFree(w);
    for (let i = 0; i < 30; i++) w.step();
    const le = w.entities.get(log)!;
    expect(le.state).toBe('free');
    expect(w.player!.inventory!.hands).toBeNull();
    expect(Math.abs((axisPitch(le) * 180) / Math.PI - 32.9)).toBeLessThan(0.6);
  });

  it('the wheel turns it wheelStepDeg a notch; Shift cycles drive auto → on → off; releasing C cancels', async () => {
    const { r } = await leanScene();
    r.frame(keyDown('place'));
    const yaw0 = r.vi.placing.yawDeg;
    r.frame({ ...held('place'), wheel: 1 });
    expect(r.vi.placing.yawDeg).toBeCloseTo(yaw0 + VERB_UI_TUNING.wheelStepDeg);
    expect(r.vi.preview?.cmd.yaw).toBe(yawSteps(yaw0 + 15));
    // A trackpad's fractions add up to whole notches.
    r.frame({ ...held('place'), wheel: -0.6 });
    expect(r.vi.placing.yawDeg).toBeCloseTo(yaw0 + 15);
    r.frame({ ...held('place'), wheel: -0.6 });
    expect(r.vi.placing.yawDeg).toBeCloseTo(yaw0);
    // Shift is the drive toggle while placing, not a sprint.
    let cmds = r.frame({ pressed: ['sprint'], held: new Set<Action>(['place', 'sprint']) });
    expect(r.vi.preview?.cmd.drive).toBe(1);
    expect(moveOf(cmds).flags ?? 0).toBe(0);
    r.frame({ pressed: ['sprint'], held: new Set<Action>(['place', 'sprint']) });
    expect(r.vi.preview?.cmd.drive).toBe(0);
    r.frame({ pressed: ['sprint'], held: new Set<Action>(['place', 'sprint']) });
    expect(r.vi.preview?.cmd).not.toHaveProperty('drive');
    cmds = r.frame({ released: ['place'] });
    expect(r.vi.mode).toBe('idle');
    expect(verbs(cmds, 'place')).toEqual([]);
    expect(r.ghost.visible).toBe(false);
  });

  it('the pad: D-pad ↓ toggles it, the stick turns it padRotateDegS and flicks the orientation, X drive, A sets, B cancels', async () => {
    const { w, r } = await leanScene();
    r.frame({ pad: pad([PAD.down]) });
    expect(r.vi.mode).toBe('place');
    const yaw0 = r.vi.placing.yawDeg;
    // (That frame's tick; the frames below come at the ticks given, without stepping.)
    const t0 = w.tick;
    // Half a second at full right stick: 45°.
    r.vi.commands(frame({ pad: pad([], [PAD.down], { rx: 1 }) }), t0 + 30);
    expect(r.vi.placing.yawDeg).toBeCloseTo(yaw0 + VERB_UI_TUNING.padRotateDegS * 0.5);
    r.vi.commands(frame({ pad: pad([], [], { ry: -0.9 }) }), t0 + 31);
    r.vi.commands(frame({ pad: pad([], [], { ry: -0.9 }) }), t0 + 32);
    expect(r.vi.placing.orientation).toBe('upright');
    r.vi.commands(frame({ pad: pad([]) }), t0 + 33);
    r.vi.commands(frame({ pad: pad([], [], { ry: 0.9 }) }), t0 + 34);
    expect(r.vi.placing.orientation).toBe('sloped');
    r.vi.commands(frame({ pad: pad([PAD.x]) }), t0 + 35);
    expect(r.vi.placing.drive).toBe(1);
    const set = r.vi.commands(frame({ pad: pad([PAD.a], [PAD.x]) }), t0 + 36);
    expect(verbs(set, 'place')).toHaveLength(1);
    // A sets, and never jumps.
    expect(buttons(set)).toEqual([]);
    r.vi.commands(frame({ pad: pad([PAD.down]) }), t0 + 37);
    expect(r.vi.mode).toBe('place');
    r.vi.commands(frame({ pad: pad([PAD.down], [PAD.down]) }), t0 + 38);
    r.vi.commands(frame({ pad: pad([PAD.b]) }), t0 + 39);
    expect(r.vi.mode).toBe('idle');
    r.vi.commands(frame({ pad: pad([PAD.down]) }), t0 + 40);
    expect(r.vi.mode).toBe('place');
    r.vi.commands(frame({ pad: pad([PAD.down], [PAD.down]) }), t0 + 41);
    r.vi.commands(frame({ pad: pad([], [PAD.down]) }), t0 + 42);
    r.vi.commands(frame({ pad: pad([PAD.down]) }), t0 + 43);
    expect(r.vi.mode).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Pull, strikes, the walk, the belt
// ---------------------------------------------------------------------------

describe('pull, strikes and the walk', () => {
  it('holding a rope end, a punch held hauls it (pull on, then off when no punch is held); kicks still kick', async () => {
    const w = await make();
    stand(w, 0, 0);
    const coil = stick(w, 0.5, 0.5);
    w.step();
    const p = w.player!;
    // (Holding a rope end needs P10's joints; the hands' record is what the UI reads.)
    p.inventory!.hands = { entity: coil, mode: 'ropeEnd', grip: { x: 0, y: 0, z: 0 }, twoHanded: false, joint: null };
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 6, z: 20 });
    const q = r.frame({ presses: ['lpunch'], ...keyDown('lpunch') }, false);
    expect(verbs(q, 'pull')).toEqual([{ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'pull', target: 0, charge: 255 }]);
    expect(buttons(q)).toEqual([]);
    expect(verbs(r.frame(held('lpunch'), false), 'pull')).toEqual([]);
    // Q up, LMB down: still on.
    expect(verbs(r.frame({ released: ['lpunch'], ...click(0) }, false), 'pull')).toEqual([]);
    expect(verbs(r.frame({ clicks: [{ button: 0, down: false }] }, false), 'pull')).toEqual([expect.objectContaining({ verb: 'pull', charge: 0 })]);
    // The pad's X and Y too.
    expect(verbs(r.frame({ pad: pad([PAD.y]) }, false), 'pull')).toEqual([expect.objectContaining({ charge: 255 })]);
    expect(verbs(r.frame({ pad: pad([], [PAD.y]) }, false), 'pull')).toEqual([expect.objectContaining({ charge: 0 })]);
    const kick = r.frame({ presses: ['lkick'], ...keyDown('lkick') }, false);
    expect(buttons(kick)).toEqual(['lkick']);
    expect(verbs(kick, 'pull')).toEqual([]);
    // Letting go of the end with a punch held switches the pull off.
    r.frame({ presses: ['rpunch'], ...keyDown('rpunch') }, false);
    p.inventory!.hands = null;
    expect(verbs(r.frame(held('rpunch'), false), 'pull')).toEqual([expect.objectContaining({ charge: 0 })]);
  });

  it('idle, the mouse’s buttons and the pad’s X/Y/LT/RT strike; in a mode they are the mode’s', async () => {
    const w = await make();
    stand(w, 0, 0);
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 6, z: 20 });
    expect(buttons(r.frame(click(0), false))).toEqual(['lpunch']);
    expect(buttons(r.frame(click(2), false))).toEqual(['rpunch']);
    expect(buttons(r.frame({ presses: ['lkick', 'rpunch'], pressed: ['lkick', 'rpunch'] }, false))).toEqual(['lkick', 'rpunch']);
    expect(buttons(r.frame({ pad: pad([PAD.x, PAD.y, PAD.lt, PAD.rt]) }, false))).toEqual(['lpunch', 'rpunch', 'lkick', 'rkick']);
    // In the radial nothing strikes.
    r.frame(keyDown('verb'), false);
    expect(r.vi.mode).toBe('radial');
    expect(buttons(r.frame({ ...held('verb'), ...click(0), presses: ['lkick'] }, false))).toEqual([]);
  });

  it('move flags: Shift held sprints; Ctrl toggles crouch (or holds it with "hold to crouch"); the pad’s LS sprint ends when you stop; B crouches (either way); Space and A jump', async () => {
    const w = await make();
    stand(w, 0, 0);
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 1.2, z: 5 });
    const flags = (cmds: Command[]) => moveOf(cmds).flags ?? 0;
    expect(flags(r.frame({ moveY: 1, ...held('up', 'sprint') }, false))).toBe(MOVE_SPRINT);
    expect(moveOf(r.frame({ moveY: 1 }, false)).speed).toBe(COMMAND_STEPS);
    expect(flags(r.frame(keyDown('crouch'), false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({}, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame(keyDown('crouch'), false))).toBe(0);
    r.holdToCrouch = true;
    expect(flags(r.frame(held('crouch'), false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({}, false))).toBe(0);
    // With "hold to crouch" the pad's B still toggles, and the key's hold doesn't undo it.
    expect(flags(r.frame({ pad: pad([PAD.b]) }, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({ pad: pad([], [PAD.b]) }, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({ ...keyDown('crouch'), pad: pad([]) }, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({ released: ['crouch'], pad: pad([]) }, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({ pad: pad([PAD.b]) }, false))).toBe(0);
    r.holdToCrouch = false;
    expect(flags(r.frame({ moveY: 1, pad: pad([PAD.ls]) }, false))).toBe(MOVE_SPRINT);
    expect(flags(r.frame({ moveY: 1, pad: pad([], [PAD.ls]) }, false))).toBe(MOVE_SPRINT);
    expect(flags(r.frame({ moveY: 0, pad: pad([]) }, false))).toBe(0);
    expect(flags(r.frame({ moveY: 1, pad: pad([]) }, false))).toBe(0);
    expect(flags(r.frame({ pad: pad([PAD.b]) }, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({ pad: pad([PAD.b], [PAD.b]) }, false))).toBe(MOVE_CROUCH);
    expect(flags(r.frame({ pad: pad([PAD.b]) }, false))).toBe(0);
    expect(buttons(r.frame(keyDown('jump'), false))).toEqual(['jump']);
    expect(buttons(r.frame({ pad: pad([PAD.a]) }, false))).toEqual(['jump']);
  });

  it('1-3 and 4: stow what the hands hold onto that slot, or draw from it into empty hands; the pad’s Back cycles the belt, D-pad ↑ stows', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const stone = spawnStone(w, { p: { x: 0.4, y: 0.2, z: 0.4 }, mass: 1 });
    w.step();
    expect(w.verbs.putInHands(p, stone)).toBe(true);
    w.step();
    const r = new Rig(w);
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 6, z: 20 });
    r.frame({}, false);
    expect(verbs(r.frame(keyDown('belt2'), false))).toEqual([expect.objectContaining({ verb: 'stow', slot: 1 })]);
    expect(verbs(r.frame(keyDown('back'), false))).toEqual([expect.objectContaining({ verb: 'stow', slot: 3 })]);
    // The pad's D-pad ↑ finds a slot that takes it.
    const up = verbs(r.frame({ pad: pad([PAD.up]) }, false));
    expect(up).toEqual([expect.objectContaining({ verb: 'stow', slot: 0 })]);
    expect(validateVerb(w, p, up[0]).ok).toBe(true);
    // Empty hands: draw (the belt as a record, the UI reads it).
    p.inventory!.hands = null;
    p.inventory!.belt = [stone, null, 99];
    expect(verbs(r.frame(keyDown('belt1'), false))).toEqual([expect.objectContaining({ verb: 'draw', slot: 0 })]);
    expect(verbs(r.frame({ pad: pad([PAD.back]) }, false))).toEqual([expect.objectContaining({ verb: 'draw', slot: 0 })]);
    expect(verbs(r.frame({ pad: pad([PAD.back], [PAD.back]) }, false))).toEqual([]);
    expect(verbs(r.frame({ pad: pad([]) }, false))).toEqual([]);
    expect(verbs(r.frame({ pad: pad([PAD.back]) }, false))).toEqual([expect.objectContaining({ verb: 'draw', slot: 2 })]);
    // The back slot comes last in the cycle (so a pad can draw from it), then round again.
    p.inventory!.back = 98;
    r.frame({ pad: pad([]) }, false);
    expect(verbs(r.frame({ pad: pad([PAD.back]) }, false))).toEqual([expect.objectContaining({ verb: 'draw', slot: 3 })]);
    r.frame({ pad: pad([]) }, false);
    expect(verbs(r.frame({ pad: pad([PAD.back]) }, false))).toEqual([expect.objectContaining({ verb: 'draw', slot: 0 })]);
    p.inventory!.belt = [null, null, null];
    p.inventory!.back = null;
  });
});

describe('a window blur (InputFrame.lost)', () => {
  it('cancels the mode: the blur’s releases throw nothing and run no radial option, and start nothing', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const stone = spawnStone(w, { p: { x: 0.4, y: 0.2, z: 0.4 }, mass: 1 });
    const s = stick(w, 0, 1.2);
    w.step();
    expect(w.verbs.putInHands(p, stone)).toBe(true);
    w.step();
    const r = new Rig(w);
    withStandIns(() => {
      r.look({ x: 0.4, y: 2.6, z: -3.2 }, { x: 0, y: 0.04, z: 1.2 });
      r.frame();
      expect(w.verbs.focusedEntity(p)).toBe(s);
      // Aiming a throw: alt-tab.
      r.frame(keyDown('throw'));
      for (let i = 0; i < 10; i++) r.frame(held('throw'));
      let cmds = r.frame({ released: ['throw'], lost: true });
      expect(r.vi.mode).toBe('idle');
      expect(verbs(cmds).filter((c) => c.verb !== 'focus')).toEqual([]);
      // The radial open, the cursor on Cut: alt-tab.
      r.frame(keyDown('verb'));
      const opts = r.radial.shown;
      const d = sectorDir(
        opts.findIndex((o) => o.verb === 'cut'),
        opts.length,
      );
      r.frame({ ...held('verb'), mouse: { dx: d.x * 80, dy: d.y * 80, left: false, right: false } });
      expect(r.radial.selected?.verb).toBe('cut');
      cmds = r.frame({ released: ['verb'], lost: true });
      expect(r.vi.mode).toBe('idle');
      expect(r.radial.isOpen).toBe(false);
      expect(verbs(cmds).filter((c) => c.verb !== 'focus')).toEqual([]);
      // A key going down as the window loses focus starts no mode (its release comes with it).
      r.frame({ pressed: ['throw'], released: ['throw'], lost: true });
      expect(r.vi.mode).toBe('idle');
      expect(verbs(r.frame({})).filter((c) => c.verb !== 'focus')).toEqual([]);
      // Placing: alt-tab (its release of C cancels, as it would anyway).
      r.frame(keyDown('place'));
      expect(r.vi.mode).toBe('place');
      expect(verbs(r.frame({ released: ['place'], ...click(0, false), lost: true }), 'place')).toEqual([]);
      expect(r.vi.mode).toBe('idle');
    });
  });
});

describe('the visuals hold no geometry for what they no longer show', () => {
  it('the outline keeps only what it outlines; the ghost lets all go when hidden', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const sticks = [-0.8, -0.3, 0.2, 0.7].map((x) => stick(w, x, 1.3));
    w.step();
    const r = new Rig(w);
    for (const id of sticks) {
      const e = w.entities.get(id)!;
      r.look({ x: e.pose.p.x, y: 2.6, z: -3 }, { x: e.pose.p.x, y: 0.04, z: 1.3 });
      r.frame();
      r.frame();
      expect(w.verbs.focusedEntity(p)).toBe(id);
      expect(r.highlight.cached).toBe(1);
    }
    r.look({ x: 0, y: 2.6, z: -3 }, { x: 0, y: 6, z: 20 });
    r.frame();
    r.frame();
    expect(r.highlight.cached).toBe(0);
    expect(w.verbs.putInHands(p, sticks[0])).toBe(true);
    w.step();
    r.frame(keyDown('place'));
    expect(r.ghost.visible).toBe(true);
    expect(r.ghost.cached).toBe(1);
    r.frame({ released: ['place'] });
    expect(r.ghost.visible).toBe(false);
    expect(r.ghost.cached).toBe(0);
  });
});

describe('prompts and the bare stub', () => {
  it('the prompt names the take the sim’s rule allows, with the mass', async () => {
    const w = await make();
    stand(w, 0, 0);
    const p = w.player!;
    const s = stick(w, 1, 1);
    const drag = spawnLog(w, { p: { x: -2, y: 0.4, z: 2 }, length: 3, mass: 100 });
    const carry = spawnLog(w, { p: { x: 2, y: 0.3, z: 3 }, length: 2, mass: 20 });
    w.step();
    const at = new Vector3();
    expect(promptFor(w, p, { kind: 'entity', id: s, at })).toBe('G take · V verbs');
    expect(promptFor(w, p, { kind: 'entity', id: drag, at })).toBe('G drag (100 kg) · V verbs');
    expect(promptFor(w, p, { kind: 'entity', id: carry, at })).toBe('G carry (20 kg) · V verbs');
    expect(promptFor(w, p, { kind: 'ground', at })).toBe('V verbs');
    expect(promptFor(w, p, null)).toBeNull();
    expect(VERB_TUNING.targetRadiusM).toBe(2.5);
  });

  it('without a world: a move, the strikes, DS’s pick-up button and jump (P31’s stub behaviour)', () => {
    const vi = new VerbInput(() => ({ forward: new Vector3(0, 0, 1), right: new Vector3(-1, 0, 0) }));
    const cmds = vi.commands(frame({ moveY: 1, presses: ['lpunch'], pickup: true, ...click(2), pressed: ['jump'] }), 5);
    expect(cmds).toEqual([
      { tick: 5, player: 1, kind: 'move', dir: 0, speed: COMMAND_STEPS },
      { tick: 5, player: 1, kind: 'button', button: 'lpunch' },
      { tick: 5, player: 1, kind: 'button', button: 'rpunch' },
      { tick: 5, player: 1, kind: 'button', button: 'pickup' },
      { tick: 5, player: 1, kind: 'button', button: 'jump' },
    ]);
    // A frame with only DungeonStyle's fields is still a frame.
    expect(vi.commands({ moveX: 0, moveY: 0, presses: [], pickup: false, keys: [] }, 6)).toEqual([{ tick: 6, player: 1, kind: 'move', dir: 0, speed: 0 }]);
  });
});
