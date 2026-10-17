// The rope verbs (docs/M1-DESIGN.md §5.8, §5.9, §5.12, §4.9; package P16), headless, through commands: lash (a fixed
// lashing when the anchors touch, a taut rope otherwise; the coil shrinks by what was used; snap assist: flint across a
// stick's end is an axe, along it a spear), tie (a coil to the hand, paid out as the player walks; a held end at the
// current distance), splice (12 + 8 → 19.5 m, the weaker material, a held vine extended past its length), untie (back to
// a coil in the hands), the hands' reach (an anchor 3 m up is refused), bend (a 6 cm sapling bent and held, a 12 cm one
// tooStiff), pull (reel-in ≤ 1.5 m/s; the yank 1,200 N for 9 ticks then 500 N), a hauled 30 kg log tied off to a stake
// mid-haul (§11.2(c)), and a notched tree pulled over through its hanging vine from 15.6 m (§4.12): cut to 0.3 it falls
// to the yank, cut to 0.5 it doesn't.
//
// Rule 1: nothing here is a trap; a tripwire is a rope tied across a gap, a pull rope a coil tied on and walked out.
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorld } from '../src/save/load';
import { serializeWorld } from '../src/save/serialize';
import { moveCommand, toCm, type VerbCommand } from '../src/sim/commands';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { spawnBox, spawnLog, spawnRopeCoil, spawnSapling, spawnStick, spawnTree, stoneHull } from '../src/world/factory';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import { principalAxis, shapeVolume } from '../src/world/shapes';
import type { Entity, JointRecord, Quat, V3, WorldEvent } from '../src/world/types';
import { ROPE_TUNING } from '../src/world/verbs/lash';
import { pullForce } from '../src/world/verbs/pull';
import { chestPoint, handPoint, verbsFor } from '../src/world/verbs/targets';
import { toolClass, verbGeom } from '../src/world/verbs/tools';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 180_000 });

const live: World[] = [];
async function make(seed = 61): Promise<World> {
  const w = await createWorld({ seed, scene: 'empty', nav: 'off', size: 60 });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('VERB_TUNING');
  resetTuning('ROPE_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type VerbEvent = Extract<WorldEvent, { type: 'verb' }>;

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): VerbCommand {
  const c = { tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand;
  w.commands.push(c);
  return c;
}

/** n ticks (calling `each` before every step); the world events, copied. */
function run(w: World, n: number, each?: (t: number) => void): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < n; t++) {
    each?.(t);
    out.push(...w.step().world);
  }
  return out;
}

/** Steps until the player is free with nothing buffered (at least one tick); the world events, copied. */
function untilFree(w: World, max = 600): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < max; t++) {
    out.push(...w.step().world);
    const p = w.player!;
    if (p.free && !p.verbRequest) return out;
  }
  throw new Error(`the player was not free within ${max} ticks`);
}

const verbs = (evs: WorldEvent[], name?: VerbCommand['verb']): VerbEvent[] =>
  evs.filter((e): e is VerbEvent => e.type === 'verb' && (!name || e.verb === name));
const jointEvents = (evs: WorldEvent[]): Extract<WorldEvent, { type: 'joint' }>[] =>
  evs.filter((e): e is Extract<WorldEvent, { type: 'joint' }> => e.type === 'joint');

const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};
const joint = (w: World, id: number): JointRecord => {
  const j = w.joints.get(id);
  if (!j) throw new Error(`no joint ${id}`);
  return j;
};
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const deg = (r: number): number => (r * 180) / Math.PI;

/** A prism's axis (local +y) along world z; upright (local +y up). */
const ALONG_Z: Quat = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
const UPRIGHT: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** A coil of `material` rope, out of the way, put straight into the player's hands (carried). */
function holdCoil(w: World, lengthM: number, material: 'vine' | 'sinew' = 'vine'): number {
  const id = spawnRopeCoil(w, { at: { x: 20, y: 0, z: 20 }, material, lengthM });
  expect(w.verbs.putInHands(w.player!, id)).toBe(true);
  return id;
}

/** A coil lying on the ground at (x, z). */
function coilAt(w: World, lengthM: number, x: number, z: number, material: 'vine' | 'sinew' = 'vine'): number {
  return spawnRopeCoil(w, { at: { x, y: 0, z }, material, lengthM });
}

/** A dry stick r × length lying at (x, z), along x (or `q`). */
function stick(w: World, length: number, r: number, x: number, z: number, q?: Quat): number {
  return spawnStick(w, { p: { x, y: r + 0.005, z }, q, length, r });
}

/**
 * Two dry 1 m × r 0.03 sticks lying along z whose facing faces (an 8-gon's flat side, at its inradius) are 1 m apart, at
 * x = ±0.5, z = 1.1; FACES_1M aims a lash at those two faces.
 */
function facingSticks(w: World): [number, number] {
  const inR = 0.03 * Math.cos(Math.PI / 8);
  return [stick(w, 1.0, 0.03, -0.5 - inR, 1.1, ALONG_Z), stick(w, 1.0, 0.03, 0.5 + inR, 1.1, ALONG_Z)];
}
const FACES_1M = { at: toCm({ x: -0.5, y: 0.03, z: 1.1 }), at2: toCm({ x: 0.5, y: 0.03, z: 1.1 }) };

/** A stake r 0.05 × 1 m driven upright at (x, z): anchored (1,200 N), its top 0.7 m up. */
function stake(w: World, x: number, z: number): number {
  return spawnLog(w, { p: { x, y: 0.2, z }, q: UPRIGHT, length: 1, r: 0.05, state: 'anchored' });
}


/** Every rope joint (made of a rope) added since `before`. */
const newJoints = (w: World, before: number): JointRecord[] => w.joints.all().filter((j) => j.id >= before);

/** A swing angle (deg) of a body hanging under a beam at height `beamY` above (0, 0). */
function swingDeg(e: Entity, beamY: number): number {
  const c = e.pose.p;
  return deg(Math.atan2(Math.hypot(c.x, c.z), beamY - c.y));
}

/** The rope end the player holds (its joint), or null. */
function heldJoint(w: World): JointRecord | null {
  const h = w.player!.inventory!.hands;
  return h?.mode === 'ropeEnd' && h.joint !== null ? (w.joints.get(h.joint) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Lash (§5.8)
// ---------------------------------------------------------------------------

describe('lash (§5.8): a fixed lashing or a taut rope, cut from the coil', () => {
  it('touching anchors make a fixed lashing (contacts off, 600 J for vine) of 1.0 m of rope; the coil shrinks by 1.0 m', async () => {
    const w = await make();
    const p = w.player!;
    const coil = holdCoil(w, 5);
    const a = stick(w, 1.2, 0.03, 0, 1.1);
    const b = stick(w, 1.2, 0.03, 0, 1.18);
    run(w, 2);
    const start = w.tick;
    const firstJoint = w.ids.joint.next;
    verb(w, { verb: 'lash', target: a, second: b, at: toCm({ x: 0, y: 0.035, z: 1.11 }), at2: toCm({ x: 0, y: 0.035, z: 1.17 }) });
    const ev = untilFree(w);
    const ok = verbs(ev, 'lash');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ ok: true, entity: a });
    // The work action: lashFrames, the effect at its end.
    expect(w.tick - start).toBeGreaterThanOrEqual(VERB_TUNING.lashFrames);
    const made = newJoints(w, firstJoint);
    expect(made).toHaveLength(1);
    const j = made[0];
    expect(j.kind).toBe('lash');
    expect([j.a.entity, j.b.entity]).toEqual([a, b]);
    expect(ent(w, a).joints).toContain(j.id);
    expect(ent(w, b).joints).toContain(j.id);
    expect(j.breakEnergyJ).toBeCloseTo(600, 6);
    expect(j.credit).toEqual(['p1']);
    // The piece: 1.0 m of vine, tied (no body), and the coil 1.0 m shorter, lighter by as much, still in the hands.
    const piece = ent(w, j.rope!.entity);
    expect(piece.id).not.toBe(coil);
    expect(piece.state).toBe('tied');
    expect(piece.body).toBeNull();
    expect(piece.rope!.lengthM).toBeCloseTo(VERB_TUNING.lashRopeUseM, 9);
    expect(ent(w, coil).rope!.lengthM).toBeCloseTo(5 - VERB_TUNING.lashRopeUseM, 9);
    expect(ent(w, coil).mass / piece.mass).toBeCloseTo(4, 6);
    expect(p.inventory!.hands).toMatchObject({ entity: coil, mode: 'carry' });
    expect(p.load!.massKg).toBeCloseTo(ent(w, coil).mass, 9);
    expect(ent(w, a).credit).toContain('p1');
    expect(ent(w, b).credit).toContain('p1');
    // A fixed joint holds them as one: lifted, they move together.
    expect(w.physics.rapier.impulseJoints.len()).toBe(1);
  });

  it('anchors 1 m apart make a 1.00 m rope taking 1.5 m off the coil (distance + the knots); rope is conserved', async () => {
    const w = await make();
    const coil = holdCoil(w, 5);
    const [a, b] = facingSticks(w);
    run(w, 2);
    const firstJoint = w.ids.joint.next;
    const m0 = ent(w, coil).mass;
    verb(w, { verb: 'lash', target: a, second: b, ...FACES_1M });
    const ev = untilFree(w);
    expect(verbs(ev, 'lash')[0]).toMatchObject({ ok: true });
    const [j] = newJoints(w, firstJoint);
    expect(j.kind).toBe('rope');
    expect(j.rope!.lengthM).toBeCloseTo(1.0, 5);
    const piece = ent(w, j.rope!.entity);
    const used = 1.0 + ROPE_TUNING.knotAllowanceM;
    expect(piece.rope!.lengthM).toBeCloseTo(used, 5);
    expect(ent(w, coil).rope!.lengthM).toBeCloseTo(5 - used, 5);
    expect(ent(w, coil).rope!.lengthM + piece.rope!.lengthM).toBeCloseTo(5, 9);
    // Mass is density × volume: the coil lost what the piece weighs.
    expect(ent(w, coil).mass + piece.mass).toBeCloseTo(m0, 6);
    expect(ent(w, coil).mass).toBeCloseTo((m0 * (5 - piece.rope!.lengthM)) / 5, 6);
  });

  it('a coil with less than coilMinM left goes into the piece whole, out of the hands', async () => {
    const w = await make();
    const p = w.player!;
    const coil = holdCoil(w, 1.3);
    const a = stick(w, 1.2, 0.03, 0, 1.1);
    const b = stick(w, 1.2, 0.03, 0, 1.18);
    run(w, 2);
    const firstJoint = w.ids.joint.next;
    verb(w, { verb: 'lash', target: a, second: b, at: toCm({ x: 0, y: 0.035, z: 1.11 }), at2: toCm({ x: 0, y: 0.035, z: 1.17 }) });
    untilFree(w);
    const [j] = newJoints(w, firstJoint);
    expect(j.kind).toBe('lash');
    expect(j.rope!.entity).toBe(coil);
    expect(ent(w, coil).state).toBe('tied');
    expect(ent(w, coil).rope!.lengthM).toBeCloseTo(1.3, 9);
    expect(p.inventory!.hands).toBeNull();
  });

  it('refusals change nothing: no rope, a rope too short, a rope as one side, the same entity twice, an anchor 3 m up (outOfReach)', async () => {
    const w = await make();
    const a = stick(w, 1.2, 0.03, 0, 1.1);
    const b = stick(w, 1.2, 0.03, 0, 1.18);
    const post = spawnBox(w, { p: { x: 0.6, y: 2, z: 1.3 }, size: [0.3, 4, 0.3], material: 'dryWood', state: 'fixed', look: 'post' });
    run(w, 2);
    const pair = { at: toCm({ x: 0, y: 0.035, z: 1.11 }), at2: toCm({ x: 0, y: 0.035, z: 1.17 }) };
    const refused = (cmd: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): string | undefined => {
      verb(w, cmd);
      const ev = run(w, 1);
      const r = verbs(ev, cmd.verb);
      expect(r, JSON.stringify(cmd)).toHaveLength(1);
      expect(r[0].ok).toBe(false);
      return r[0].reason;
    };
    expect(refused({ verb: 'lash', target: a, second: b, ...pair })).toBe('noRope');
    const short = holdCoil(w, 0.8);
    expect(refused({ verb: 'lash', target: a, second: b, ...pair })).toBe('ropeTooShort');
    w.verbs.letGo(w.player!);
    const coil = holdCoil(w, 5);
    const lying = coilAt(w, 3, 1.0, 1.2);
    run(w, 2);
    expect(refused({ verb: 'lash', target: a, second: lying, at: pair.at, at2: toCm({ x: 1.0, y: 0.05, z: 1.2 }) })).toBe('ropeLike');
    expect(refused({ verb: 'lash', target: a, second: a, at: pair.at, at2: pair.at })).toBe('noTarget');
    // The post's face 3 m up: beyond the hands' reach from anywhere a standing player can step to (§5.0).
    expect(refused({ verb: 'lash', target: a, second: post, at: pair.at, at2: toCm({ x: 0.6, y: 3.0, z: 1.15 }) })).toBe('outOfReach');
    expect(w.joints.all()).toHaveLength(0);
    expect(ent(w, coil).rope!.lengthM).toBe(5);
    expect(ent(w, short).rope!.lengthM).toBe(0.8);
    // 2.2 m up is in reach: a tie there is made.
    verb(w, { verb: 'tie', target: post, at: toCm({ x: 0.6, y: 2.2, z: 1.15 }) });
    const ev = untilFree(w);
    expect(verbs(ev, 'tie')[0]).toMatchObject({ ok: true, entity: post });
  });
});

// ---------------------------------------------------------------------------
// Snap assist (§5.8)
// ---------------------------------------------------------------------------

describe('snap assist (§5.8): a light head moved flush to a stick’s end', () => {
  /** A 0.6 kg flint nodule with a 0.9 edge at the + end of its long axis (local x), yawed by `yaw`, lying at (x, z). */
  function flint(w: World, x: number, z: number, yaw: number): number {
    const shape = stoneHull(0.6, 0, 'flint');
    const ax = principalAxis(shape);
    let low = Infinity;
    for (let i = 1; i < shape.points.length; i += 3) low = Math.min(low, shape.points[i]);
    const q: Quat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    return w.entities.create({
      material: 'flint',
      shape,
      p: { x, y: -low + 0.005, z },
      q,
      sharpPoints: [{ local: { x: ax.max, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, sharpness: 0.9 }],
      look: 'flint',
    }).id;
  }

  it('flint across a stick’s end is lashed on as an axe head; along a long stick’s end, as a spear point', async () => {
    for (const [len, yaw, want] of [
      [0.55, Math.PI / 2, 'stoneAxe'],
      [1.8, 0, 'spear'],
    ] as const) {
      const w = await make();
      holdCoil(w, 3);
      const s = stick(w, len, 0.02, 0, 1.2);
      const end = len / 2;
      // The flint lies 0.25 m beyond the stick's +x end, 6 cm off its axis.
      const fl = flint(w, end + 0.25, 1.26, yaw);
      run(w, 30);
      expect(toolClass(w, s)).toBe('stick');
      const firstJoint = w.ids.joint.next;
      verb(w, { verb: 'lash', target: s, second: fl, at: toCm({ x: end, y: 0.02, z: 1.2 }), at2: toCm(ent(w, fl).pose.p) });
      const ev = untilFree(w);
      expect(verbs(ev, 'lash')[0], want).toMatchObject({ ok: true });
      const [j] = newJoints(w, firstJoint);
      expect(j.kind, want).toBe('lash');
      // Moved flush to the end: its centre on the stick's axis line, its nearest face on the end plane.
      const S = ent(w, s);
      const F = ent(w, fl);
      const axis = verbGeom.dirToWorld(S.pose, { x: 0, y: 1, z: 0 });
      const E = verbGeom.pointToWorld(S.pose, { x: 0, y: end, z: 0 });
      const off = verbGeom.sub(F.pose.p, E);
      const lateral = verbGeom.sub(off, verbGeom.scale(axis, verbGeom.dot(off, axis)));
      expect(Math.hypot(lateral.x, lateral.z), want).toBeLessThan(0.01);
      expect(dist(w.joints.anchorPoint(j.a)!, w.joints.anchorPoint(j.b)!), want).toBeLessThan(VERB_TUNING.lashTouchM);
      // No recipe: the held object's properties make it a tool.
      expect(toolClass(w, s), want).toBe(want);
      expect(toolClass(w, fl), want).toBe(want);
    }
  });
});

// ---------------------------------------------------------------------------
// Splice (§5.8)
// ---------------------------------------------------------------------------

describe('splice (§5.8): two ropes knotted into one', () => {
  it('12 + 8 → 19.5 m (spliceLossM), credit merged, the other rope gone; a sinew and a vine splice to vine (the weaker)', async () => {
    for (const [held, lying, want] of [
      ['vine', 'vine', 'vine'],
      ['sinew', 'vine', 'vine'],
    ] as const) {
      const w = await make();
      const p = w.player!;
      const a = holdCoil(w, 12, held);
      const b = coilAt(w, 8, 0, 1.1, lying);
      ent(w, b).credit = ['p2'];
      run(w, 2);
      verb(w, { verb: 'tie', target: b, at: toCm(ent(w, b).pose.p) });
      const ev = untilFree(w);
      expect(verbs(ev, 'tie')[0]).toMatchObject({ ok: true, entity: a });
      expect(w.entities.get(b)).toBeUndefined();
      const e = ent(w, a);
      expect(e.rope!.lengthM).toBeCloseTo(12 + 8 - VERB_TUNING.spliceLossM, 9);
      expect(e.material).toBe(want);
      expect(e.mass).toBeCloseTo(MATERIALS[want].density * shapeVolume(e.shape), 6);
      expect(e.credit).toEqual(['p1', 'p2']);
      expect(p.inventory!.hands).toMatchObject({ entity: a, mode: 'carry' });
    }
  });

  it('a held vine end spliced to a belt coil pays the added rope out at the hand (§11.3: a vine extended past its length)', async () => {
    const w = await make();
    const p = w.player!;
    const { vine } = spawnTree(w, { at: { x: 0, z: 2 }, diameter: 0.3, height: 8, vine: { anchorH: 3, lengthM: 6, yaw: 0 } });
    const coil = holdCoil(w, 8);
    verb(w, { verb: 'stow', target: 0, slot: 0 });
    untilFree(w);
    expect(p.inventory!.belt[0]).toBe(coil);
    // The vine's loose end lies 3 m beyond the trunk; the player goes to it and takes it.
    w.teleport(p, 0, 4.6, 0);
    run(w, 2);
    verb(w, { verb: 'take', target: vine!.rope });
    untilFree(w);
    expect(p.inventory!.hands).toMatchObject({ entity: vine!.rope, mode: 'ropeEnd', joint: vine!.joint });
    const before = joint(w, vine!.joint).rope!.lengthM;
    verb(w, { verb: 'tie', target: coil });
    const ev = untilFree(w);
    expect(verbs(ev, 'tie')[0]).toMatchObject({ ok: true, entity: vine!.rope });
    const added = 8 - VERB_TUNING.spliceLossM;
    expect(ent(w, vine!.rope).rope!.lengthM).toBeCloseTo(6 + added, 9);
    expect(joint(w, vine!.joint).rope!.lengthM).toBeCloseTo(before + added, 9);
    expect(p.inventory!.belt[0]).toBeNull();
    expect(w.entities.get(coil)).toBeUndefined();
    // Still held, and now he can walk the longer rope out (the tether allows the new free length).
    expect(heldJoint(w)?.id).toBe(vine!.joint);
  });
});

// ---------------------------------------------------------------------------
// Tie and untie (§5.8)
// ---------------------------------------------------------------------------

describe('tie and untie (§5.8)', () => {
  it('a coil tied to a stake is a rope end in the hand, paid out as he walks; its end tied to a second stake is a taut rope at that distance', async () => {
    const w = await make();
    const p = w.player!;
    const coil = holdCoil(w, 4);
    const s1 = stake(w, 0, 1.0);
    const s2 = stake(w, 3, 1.0);
    run(w, 2);
    verb(w, { verb: 'tie', target: s1, at: toCm({ x: 0, y: 0.6, z: 0.95 }) });
    const ev = untilFree(w);
    expect(verbs(ev, 'tie')[0]).toMatchObject({ ok: true, entity: s1 });
    const j = heldJoint(w)!;
    expect(j).not.toBeNull();
    expect(j.rope).toEqual({ entity: coil, lengthM: 4 });
    expect(j.a.entity).toBe(s1);
    expect(j.b.fighter).toBe(p.id);
    expect(ent(w, coil).state).toBe('tied');
    expect(p.load).toMatchObject({ mode: 'rope' });
    // Walking away for 4 s: the rope pays out to its length and no further (the tether, P14's, which holds the chest
    // point within the free length of the anchor; the hand reaches past it by the arm).
    const anchor = w.joints.anchorPoint(j.a)!;
    let far = 0;
    run(w, 240, () => {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, -1));
      far = Math.max(far, dist(chestPoint(p), anchor));
    });
    expect(far).toBeLessThanOrEqual(4 + 0.01);
    expect(far).toBeGreaterThan(3.9);
    expect(joint(w, j.id).rope!.lengthM).toBe(4);
    // To the second stake, and tied there: a rope between the two stakes at the distance of that tick, nothing held.
    w.commands.push(moveCommand(w.tick + 1, 1, 0, 0));
    w.teleport(p, 3, 0.3, 0);
    run(w, 2);
    verb(w, { verb: 'tie', target: s2, at: toCm({ x: 3, y: 0.6, z: 0.95 }) });
    const ev2 = untilFree(w);
    expect(verbs(ev2, 'tie')[0]).toMatchObject({ ok: true, entity: s2 });
    const t = joint(w, j.id);
    expect([t.a.entity, t.b.entity]).toEqual([s1, s2]);
    expect(t.b.fighter).toBeUndefined();
    expect(t.rope!.lengthM).toBeCloseTo(dist(w.joints.anchorPoint(t.a)!, w.joints.anchorPoint(t.b)!), 6);
    expect(t.rope!.lengthM).toBeCloseTo(3, 1);
    expect(p.inventory!.hands).toBeNull();
    expect(p.load).toBeNull();
    expect(t.credit).toContain('p1');
  });

  it('untie returns the rope to a coil in empty hands; one `joint … untie` event; out of reach it is refused', async () => {
    const w = await make();
    const p = w.player!;
    holdCoil(w, 5);
    const [a, b] = facingSticks(w);
    run(w, 2);
    const firstJoint = w.ids.joint.next;
    verb(w, { verb: 'lash', target: a, second: b, ...FACES_1M });
    untilFree(w);
    const [j] = newJoints(w, firstJoint);
    const piece = j.rope!.entity;
    verb(w, { verb: 'drop', target: 0 });
    untilFree(w);
    expect(p.inventory!.hands).toBeNull();
    verb(w, { verb: 'untie', target: piece });
    const ev = untilFree(w);
    expect(verbs(ev, 'untie')[0]).toMatchObject({ ok: true, entity: piece });
    expect(jointEvents(ev)).toEqual([expect.objectContaining({ joint: j.id, what: 'untie' })]);
    expect(w.joints.get(j.id)).toBeUndefined();
    const e = ent(w, piece);
    expect(e.joints).toEqual([]);
    expect(e.rope!.lengthM).toBeCloseTo(1.5, 5);
    expect(e.shape.kind).toBe('cylinder');
    expect(e.state).toBe('held');
    expect(p.inventory!.hands).toMatchObject({ entity: piece, mode: 'carry' });
    expect(ent(w, a).joints).toEqual([]);
    // A hanging vine tied 6 m up: no anchor in reach.
    const { vine } = spawnTree(w, { at: { x: 2, z: 1.5 }, diameter: 0.3, height: 10, vine: { anchorH: 6, lengthM: 6.5, yaw: Math.PI } });
    run(w, 2);
    verb(w, { verb: 'untie', target: vine!.rope });
    const r = verbs(run(w, 1), 'untie');
    expect(r[0]).toMatchObject({ ok: false, reason: 'outOfReach' });
    expect(w.joints.get(vine!.joint)).toBeDefined();
  });

  it('the radial offers lash, tie, bend and untie with the rope rules’ reasons', async () => {
    const w = await make();
    const p = w.player!;
    const a = stick(w, 1.0, 0.03, 0, 1.1);
    const sap = spawnSapling(w, { at: { x: 1, z: 1.5 }, diameter: 0.06, height: 2 });
    const { vine } = spawnTree(w, { at: { x: -1.2, z: 1.0 }, diameter: 0.3, height: 10, vine: { anchorH: 6, lengthM: 6.5, yaw: 0 } });
    run(w, 2);
    const opts = (id: number, at: V3) => {
      const out: Record<string, string | undefined> = {};
      for (const o of verbsFor(w, p, { kind: 'entity', id, at: new Vector3(at.x, at.y, at.z) })) if (o.verb !== 'take' || !(o.verb in out)) out[o.verb] = o.reasonIfDisabled ?? 'ok';
      return out;
    };
    expect(opts(a, { x: 0, y: 0.03, z: 1.1 })).toMatchObject({ lash: 'noRope', tie: 'noRope' });
    expect(opts(sap, { x: 1, y: 1, z: 1.5 })).toMatchObject({ bend: 'noRope' });
    expect(opts(vine!.rope, { x: -1.2, y: 5, z: 1.23 })).toMatchObject({ untie: 'outOfReach' });
    holdCoil(w, 5);
    expect(opts(a, { x: 0, y: 0.03, z: 1.1 })).toMatchObject({ lash: 'ok', tie: 'ok' });
    expect(opts(sap, { x: 1, y: 1, z: 1.5 })).toMatchObject({ bend: 'ok' });
    // A rope offers a splice: lash with it is on while there is rope to splice it to.
    expect(opts(vine!.rope, { x: -1.2, y: 5, z: 1.23 })).toMatchObject({ lash: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// Bend (§5.9)
// ---------------------------------------------------------------------------

describe('bend (§5.9): a sapling pulled over and held by a short rope', () => {
  /** The tilt from upright of a sapling's axis, deg. */
  const tilt = (e: Entity): number => deg(Math.acos(Math.min(1, verbGeom.dirToWorld(e.pose, { x: 0, y: 1, z: 0 }).y)));

  it('a 6 cm × 2 m sapling bends toward a stake 1.45 m from it and is held there; a 12 cm × 2 m one is tooStiff', async () => {
    for (const [d, want] of [
      [0.06, 'ok'],
      [0.12, 'tooStiff'],
    ] as const) {
      const w = await make();
      const coil = holdCoil(w, 3);
      const sap = spawnSapling(w, { at: { x: 0, z: 2.5 }, diameter: d, height: 2 });
      const anchor = stake(w, 0, 1.0);
      run(w, 2);
      const firstJoint = w.ids.joint.next;
      verb(w, { verb: 'bend', target: sap, second: anchor, at2: toCm({ x: 0, y: 0.6, z: 1.05 }) });
      const ev = untilFree(w);
      const r = verbs(ev, 'bend');
      if (want !== 'ok') {
        // 500 N at the top of a 12 cm × 2 m sapling (k = 3,456 N·m/rad) holds it only 16.6° over: under bendMinDeg.
        expect(r[0], `${d}`).toMatchObject({ ok: false, reason: want });
        expect(w.joints.all()).toHaveLength(0);
        expect(ent(w, sap).plant!.phase).toBe('standing');
        expect(ent(w, coil).rope!.lengthM).toBe(3);
        continue;
      }
      expect(r[0]).toMatchObject({ ok: true, entity: sap });
      const made = newJoints(w, firstJoint);
      expect(made.map((j) => j.kind)).toEqual(['bend', 'rope']);
      const [bend, hold] = made;
      expect(hold.holdsBend).toBe(bend.id);
      expect([hold.a.entity, hold.b.entity]).toEqual([sap, anchor]);
      const s = ent(w, sap);
      expect(s.plant!.phase).toBe('bent');
      expect(s.body!.isDynamic()).toBe(true);
      // The holding rope came off the coil: its length once bent, plus the knots.
      const piece = ent(w, hold.rope!.entity);
      expect(piece.rope!.lengthM).toBeCloseTo(hold.rope!.lengthM + ROPE_TUNING.knotAllowanceM, 6);
      expect(ent(w, coil).rope!.lengthM).toBeCloseTo(3 - piece.rope!.lengthM, 6);
      // Bent well over (the force's limit, 66°: 500 N × 2 m ÷ 864 N·m/rad) and held: 2 s on, still there.
      const bent = tilt(s);
      expect(bent).toBeGreaterThan(55);
      const later = run(w, 120);
      expect(jointEvents(later)).toEqual([]);
      expect(Math.abs(tilt(ent(w, sap)) - bent)).toBeLessThan(3);
      expect(s.credit).toContain('p1');
    }
  });

  it('a 12 cm × 3 m sapling is not refused: it bends only as far as 500 N allows (k θ / L = 500 N: 24.9°)', async () => {
    const w = await make();
    holdCoil(w, 3);
    const sap = spawnSapling(w, { at: { x: 0, z: 2.5 }, diameter: 0.12, height: 3 });
    const anchor = stake(w, 0, 1.0);
    run(w, 2);
    verb(w, { verb: 'bend', target: sap, second: anchor, at2: toCm({ x: 0, y: 0.6, z: 1.05 }) });
    const ev = untilFree(w);
    expect(verbs(ev, 'bend')[0]).toMatchObject({ ok: true });
    const k = 4e5 * MATERIALS.greenWood.springiness * 0.12 * 0.12;
    expect(tilt(ent(w, sap))).toBeCloseTo(deg((VERB_TUNING.bendMaxForceN * 3) / k), 0);
  });
});

// ---------------------------------------------------------------------------
// Pull (§5.12)
// ---------------------------------------------------------------------------

describe('pull (§5.12): reel in, then the yank, then the steady haul', () => {
  /** A 10 m vine coil tied to a fixed post 1.2 m up in front of the player, and the player walked `back` m back. */
  async function postRope(back: number): Promise<{ w: World; j: number; coil: number }> {
    const w = await make();
    const p = w.player!;
    const coil = holdCoil(w, 10);
    const post = spawnBox(w, { p: { x: 0, y: 1, z: 1.4 }, size: [0.4, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    run(w, 2);
    verb(w, { verb: 'tie', target: post, at: toCm({ x: 0, y: 1.0, z: 1.2 }) });
    untilFree(w);
    const j = heldJoint(w)!.id;
    expect(joint(w, j).rope!.entity).toBe(coil);
    w.teleport(p, 0, -back, 0);
    run(w, 30);
    return { w, j, coil };
  }

  it('reels in at ≤ 1.5 m/s, then 1,200 N for 9 ticks once taut, then 500 N; the hauler is braced: not drawn to the post, tiring at 0.15/s', async () => {
    // Back 7 m: about 3 m of the 10 m rope lies slack.
    const { w, j } = await postRope(6);
    const p = w.player!;
    const at = { x: p.pos.x, z: p.pos.z };
    const stamina0 = p.stamina;
    verb(w, { verb: 'pull', target: 0, charge: 255 });
    const pulls: number[] = [];
    const lengths: number[] = [joint(w, j).rope!.lengthM];
    let moved = 0;
    run(w, 300, (t) => {
      moved = Math.max(moved, Math.hypot(p.pos.x - at.x, p.pos.z - at.z));
      if (t === 0) return;
      pulls.push(joint(w, j).pullN);
      lengths.push(joint(w, j).rope!.lengthM);
    });
    // The free length only shortens: reeled in at the hand speed while slack (about 3 m: two seconds); on the tick the
    // rope comes taut the haul takes it to the hand's distance (the last ≤ haulTautM), and then it follows the hand.
    const first = pulls.indexOf(VERB_TUNING.pullYankN);
    expect(first).toBeGreaterThan(90);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeLessThanOrEqual(lengths[i - 1] + 1e-9);
      const reel = VERB_TUNING.pullHandSpeedMps / 60;
      expect(lengths[i - 1] - lengths[i]).toBeLessThanOrEqual(i - 1 === first ? reel + VERB_TUNING.haulTautM : reel + 1e-9);
      if (i - 1 < first) expect(lengths[i - 1] - lengths[i]).toBeCloseTo(reel, 9);
    }
    expect(pulls.slice(0, first).every((x) => x === VERB_TUNING.pullForceN)).toBe(true);
    expect(pulls.slice(first, first + VERB_TUNING.pullYankTicks)).toEqual(new Array(VERB_TUNING.pullYankTicks).fill(VERB_TUNING.pullYankN));
    expect(pulls.slice(first + VERB_TUNING.pullYankTicks).every((x) => x === VERB_TUNING.pullForceN)).toBe(true);
    expect(lengths[0] - lengths[lengths.length - 1]).toBeGreaterThan(2.5);
    // Braced: the rope-end tether never draws a hauler to what he pulls on (P16 review: he was drawn 2.92 m in 5 s).
    expect(moved).toBeLessThanOrEqual(0.02);
    expect(p.posture?.id).toBe('haulRope');
    // Tiring: the pull drains 0.15/s and replaces the rest regen (CombatSim's tickTimers), as a sprint does.
    expect(stamina0 - p.stamina).toBeCloseTo((300 * VERB_TUNING.pullStaminaPerS) / 60, 2);
    // One yank per pull: stepped a metre in, the rope goes slack, is reeled in and comes taut again with no second yank.
    w.teleport(p, 0, p.pos.z + 1, 0);
    const again: number[] = [];
    let wasSlack = false;
    for (let t = 0; t < 120; t++) {
      const before = w.verbs.continuousOf(p)!.data.taut;
      w.step();
      again.push(joint(w, j).pullN);
      if (w.verbs.continuousOf(p)!.data.taut === before) wasSlack = true;
    }
    expect(wasSlack).toBe(true);
    expect(again.every((x) => x < VERB_TUNING.pullYankN)).toBe(true);
    expect(w.verbs.continuousOf(p)).toMatchObject({ verb: 'pull', data: { taut: expect.any(Number) } });
    // Let go of the punch: the pull is spent, the posture eased, and the rest regen back.
    verb(w, { verb: 'pull', target: 0, charge: 0 });
    run(w, 2);
    expect(joint(w, j).pullN).toBe(0);
    expect(p.posture).toBeNull();
    expect(w.verbs.continuousOf(p)).toBeNull();
    expect(heldJoint(w)?.id).toBe(j);
    const s1 = p.stamina;
    run(w, 30);
    expect(p.stamina).toBeGreaterThan(s1);
  });

  it('a hauler walking away from a taut rope is stopped where he stands (rule 3); let go of the pull, the hand stays within the free length', async () => {
    const { w, j } = await postRope(6);
    const p = w.player!;
    verb(w, { verb: 'pull', target: 0, charge: 255 });
    run(w, 200);
    expect(w.verbs.continuousOf(p)!.data.taut).toBeGreaterThan(30);
    const anchor = w.joints.anchorPoint(joint(w, j).a)!;
    const bodyDist = (): number => Math.hypot(p.pos.x - anchor.x, p.pos.z - anchor.z);
    const d0 = bodyDist();
    // Backing off (allowed, braced, at pullWalkMul of the walk) against the taut rope: held where he is.
    let far = 0;
    run(w, 120, () => {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, -1));
      far = Math.max(far, bodyDist());
    });
    expect(far).toBeLessThanOrEqual(d0 + 0.02);
    // The pull let go: still the rope's free length is all the hand has.
    verb(w, { verb: 'pull', target: 0, charge: 0 });
    const L = (): number => joint(w, j).rope!.lengthM;
    far = 0;
    for (let t = 0; t < 120; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, -1));
      w.step();
      if (t < 2) continue;
      const h = handPoint(p);
      far = Math.max(far, Math.hypot(h.x - anchor.x, h.z - anchor.z) - Math.sqrt(L() ** 2 - (h.y - anchor.y) ** 2));
    }
    // (The tether carries the hand's offset from the last pose; a stride swings the arm a few centimetres within a tick.)
    expect(far).toBeLessThanOrEqual(0.1);
    // Walking toward the post, nothing holds him back.
    const zBack = p.pos.z;
    run(w, 60, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, 1)));
    expect(p.pos.z - zBack).toBeGreaterThan(1);
  });

  it('at zero stamina the pull drops to 60 %; a creature pulls × 1.5 × scale²; with no rope end it is refused', async () => {
    const w = await make();
    const p = w.player!;
    verb(w, { verb: 'pull', target: 0, charge: 255 });
    expect(verbs(run(w, 1), 'pull')[0]).toMatchObject({ ok: false, reason: 'noRopeEnd' });
    expect(pullForce(p, 1)).toBe(VERB_TUNING.pullYankN);
    expect(pullForce(p, VERB_TUNING.pullYankTicks + 1)).toBe(VERB_TUNING.pullForceN);
    p.stamina = 0;
    expect(pullForce(p, 0)).toBeCloseTo(VERB_TUNING.pullForceN * VERB_TUNING.pullTiredMul, 9);
    const ape = w.spawnCreature('ape', { x: 10, z: 10 });
    expect(pullForce(ape, 50)).toBeCloseTo(VERB_TUNING.pullForceN * VERB_TUNING.creaturePullMul * ape.scale * ape.scale, 6);
  });

  it('a hauled 30 kg log tied off to a stake mid-haul stays at the angle reached (§11.2(c)): one yank, the hauler braced, nothing snaps or pulls loose', async () => {
    const w = await make();
    const p = w.player!;
    // The gate's swing (§11.2(c) steps 1-4, staged): a 30 kg dry hex log 4 m along z, its centre 0.47 m up, hung by its
    // ends (local z ±1.6) from two points 8 m up at z ±2.4 by 7.57 m vines.
    const beam = spawnBox(w, { p: { x: 0, y: 8.2, z: 0 }, size: [0.4, 0.4, 5.2], material: 'dryWood', state: 'fixed', look: 'beam' });
    const log = spawnLog(w, { p: { x: 0, y: 0.47, z: 0 }, q: ALONG_Z, length: 4, mass: 30 });
    for (const z of [-1, 1]) {
      const top = { x: 0, y: 8, z: 2.4 * z };
      const L = dist(top, { x: 0, y: 0.47, z: 1.6 * z });
      const rope = spawnRopeCoil(w, { at: { x: 20, y: 0, z: 20 + 2 * z }, material: 'vine', lengthM: L + 0.5 });
      w.joints.rope({ entity: beam, local: { x: 0, y: -0.2, z: 2.4 * z } }, { entity: log, local: { x: 0, y: 1.6 * z, z: 0 } }, L, { entity: rope, lengthM: L }, []);
    }
    // Step 5: the tie stake, a 1.4 m stick driven at (−9, 0, 0.6), its top 1.1 m up.
    const tieStake = spawnLog(w, { p: { x: -9, y: 0.4, z: 0.6 }, q: UPRIGHT, length: 1.4, r: 0.05, state: 'anchored' });
    w.teleport(p, -1.0, 0, Math.PI / 2);
    holdCoil(w, 10);
    run(w, 30);
    // A 10 m vine coil tied to the log's back face, walked out in front of the stake 9 m back, and pulled for 5 s. (The gate
    // pulls 8 s, but at pullStaminaPerS with no rest regen a fresh hauler is spent at 6.7 s and then pulls 300 N: the log
    // sags to 27° by 8 s, and a tie made while he is spent lands mid-swing. Tied off while he can still pull, it holds.)
    verb(w, { verb: 'tie', target: log, at: toCm({ x: -0.065, y: 0.47, z: 0 }) });
    expect(verbs(untilFree(w), 'tie')[0]).toMatchObject({ ok: true, entity: log });
    const j = heldJoint(w)!.id;
    w.teleport(p, -8.4, 0, Math.PI / 2);
    run(w, 30);
    verb(w, { verb: 'pull', target: 0, charge: 255 });
    let peak = 0;
    let yanks = 0;
    let moved = 0;
    const hauled = run(w, 300, () => {
      peak = Math.max(peak, swingDeg(ent(w, log), 8));
      moved = Math.max(moved, Math.abs(p.pos.x - -8.4));
      if (joint(w, j).pullN === VERB_TUNING.pullYankN) yanks++;
    });
    // Hauled back (the lab: 28-45° after 8 s, peaks 38-52° [I-rev ran: swing_light.out]), with one yank of 9 ticks in all.
    expect(peak).toBeGreaterThanOrEqual(38);
    expect(yanks).toBe(VERB_TUNING.pullYankTicks);
    // Braced: the swinging log never drew him to it (P16 review: from −8.40 to −4.31 m, his stake left out of range).
    expect(moved).toBeLessThanOrEqual(0.05);
    // Tied off mid-haul: the haul holds through the tie's work action, and the end is tied at the tick it lands.
    expect(joint(w, j).pullN).toBeGreaterThan(0);
    verb(w, { verb: 'tie', target: tieStake, at: toCm({ x: -9, y: 1.0, z: 0.55 }) });
    const tying = untilFree(w);
    expect(verbs(tying, 'tie')[0]).toMatchObject({ ok: true, entity: tieStake });
    const t = joint(w, j);
    expect([t.a.entity, t.b.entity]).toEqual([log, tieStake]);
    expect(p.inventory!.hands).toBeNull();
    expect(w.verbs.continuousOf(p)).toBeNull();
    const tied = swingDeg(ent(w, log), 8);
    expect(tied).toBeGreaterThanOrEqual(28);
    const after = run(w, 180);
    const all = [...hauled, ...tying, ...after];
    expect(all.filter((e) => e.type === 'joint' && e.what === 'snap')).toEqual([]);
    expect(all.filter((e) => e.type === 'tripwire')).toEqual([]);
    expect(ent(w, tieStake).state).toBe('anchored');
    expect(Math.abs(swingDeg(ent(w, log), 8) - tied)).toBeLessThan(8);
    // At rest on its three ropes: the cinch (if any) is over, and the tie holds well under a vine's 6 kN.
    expect(joint(w, j).pullN).toBe(0);
    expect(Math.max(...joint(w, j).tension)).toBeLessThan(1000);
  });

  it('a pull saved mid-yank goes on as it would have: the loaded world matches the original tick for tick (§8.3, AC-7)', async () => {
    const { w, j } = await postRope(5);
    const p = w.player!;
    verb(w, { verb: 'pull', target: 0, charge: 255 });
    for (let t = 0; t < 400 && (w.verbs.continuousOf(p)?.data.taut ?? 0) < 3; t++) w.step();
    expect(w.verbs.continuousOf(p)!.data.taut).toBe(3);
    const loaded = await loadWorld(serializeWorld(w), { nav: 'off' });
    live.push(loaded);
    // The pull is the fighter's continuous verb, saved with its yank count; the posture and the held end's pull with him.
    expect(loaded.verbs.continuousOf(loaded.player!)).toEqual(w.verbs.continuousOf(p));
    expect(loaded.player!.posture).toEqual(p.posture);
    expect(joint(loaded, j).pullN).toBe(joint(w, j).pullN);
    const a: number[] = [];
    const b: number[] = [];
    for (let t = 0; t < 60; t++) {
      w.step();
      loaded.step();
      a.push(joint(w, j).pullN);
      b.push(joint(loaded, j).pullN);
    }
    // The yank's last 6 ticks, then the steady pull, in both.
    expect(a.slice(0, 7)).toEqual([...new Array(6).fill(VERB_TUNING.pullYankN), VERB_TUNING.pullForceN]);
    expect(b).toEqual(a);
    const text = (u: Uint8Array): string => new TextDecoder().decode(u);
    expect(text(serializeWorld(loaded))).toBe(text(serializeWorld(w)));
  });

  it('through a hanging vine anchored 10 m up, pulled from 15.6 m on the fall line: a tree cut to 0.3 falls to the yank; cut to 0.5 it doesn’t, nor at 0.3 without the yank', async () => {
    for (const [remaining, yank, falls] of [
      [0.3, true, true],
      [0.5, true, false],
      [0.3, false, false],
    ] as const) {
      const w = await make();
      const p = w.player!;
      if (!yank) setTuningValue('VERB_TUNING', 'pullYankN', VERB_TUNING.pullForceN);
      const { tree, vine } = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 15, vine: { anchorH: 10, lengthM: 18.2, yaw: Math.PI / 2 } });
      w.felling.chop(tree, { x: -1, y: 0, z: 0 }, 0.3 * (1 - remaining), ['p1']);
      expect(ent(w, tree).plant!.cut!.remaining).toBeCloseTo(remaining, 9);
      // The vine's loose end lies 8.2 m out along +x: the player takes it there…
      w.teleport(p, 7.7, 0, Math.PI / 2);
      run(w, 2);
      verb(w, { verb: 'take', target: vine!.rope });
      untilFree(w);
      expect(heldJoint(w)?.id).toBe(vine!.joint);
      // …walks out to 15.6 m on the fall line (the rope 17.96 m to the hand), and pulls, braced where he stands.
      w.teleport(p, 15.6, 0, -Math.PI / 2);
      run(w, 10);
      verb(w, { verb: 'pull', target: 0, charge: 255 });
      let moved = 0;
      const ev = run(w, 150, () => {
        moved = Math.max(moved, Math.abs(p.pos.x - 15.6));
      });
      const fell = ev.find((e): e is Extract<WorldEvent, { type: 'fell' }> => e.type === 'fell' && e.tree === tree);
      const tag = `remaining ${remaining}, yank ${yank}`;
      expect(!!fell, tag).toBe(falls);
      if (fell) expect(deg(Math.acos(fell.dir.x / Math.hypot(fell.dir.x, fell.dir.z))), tag).toBeLessThan(1);
      else expect(ent(w, tree).plant!.phase, tag).toBe('notched');
      expect(moved, tag).toBeLessThanOrEqual(0.05);
    }
  });
});
