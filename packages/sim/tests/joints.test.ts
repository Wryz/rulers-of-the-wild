// P10, joints and ropes (docs/M1-DESIGN.md §2.4, §4.9, §1.5.7): lash, hinge, rope, bend; the Rapier joint made from
// the record and made again when an end's body changes; rope sensors; the non-negative least-squares tension fit,
// strands and snaps; tripwire loads by root momentum with queued shares and exemptions; held ends and the haul model;
// tying off a held end; coils; the joint store's save records.
//
// - still 300 kg → 2.94 kN (SPEC:261); released from horizontal → ≈ 8.8 kN peak (sinew holds), one vine snaps, two vine
//   strands hold (SPEC:266); the swinging-log statics 2.94 / 2.94 / 5.09 kN within 1 % [C lab: e3_swing].
// - tripwire numbers (§4.9 [I verified: fell.mjs]): a player at 1.5 m/s → 1,099 N, an ape at 4 m/s → 3,902 N (a vine
//   holds both), the giant at 4 m/s → 560 kN (snaps); the ape's 3,902 N crossing of a vine tied to an 18 kg prop holds
//   (the shares are queued for the next 4d and never enter the fit, RF-2); a hand reaching into a rope it is working on
//   is no tripwire (RT-5); a hanging vine from the factory has a loose end and is never a tripwire.
// - the haul model (I-2): a 30 kg log hauled by 500 N from 9 m reaches ≥ 30° within 8 s; a held end tied off stays.
// - a lashing breaks on an impact above its energy (600 J for vine, D-18); the starter axe stays lashed through stow →
//   draw → drop (the Rapier joint is made again from the record); a bend springs back when its holding rope is cut.
//
// Scene numbers (masses, lengths, positions, speeds, ticks) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { createPlayer } from '../src/sim/roster';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { spawnBox, spawnLog, spawnRopeCoil, spawnSapling, spawnStarterAxe, spawnStick, spawnTree } from '../src/world/factory';
import { bendAngle, JOINT_TUNING, nnls, revoluteAngle } from '../src/world/joints';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import type { Anchor, Entity, JointRecord, Quat, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 101, scene: 'empty', nav: 'off', size: 50, player: false, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

const G = 9.81;
/** A prism's axis (local +y) along world z. */
const ALONG_Z: Quat = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };

function ent(w: World, id: number): Entity {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
}

function joint(w: World, id: number): JointRecord {
  const j = w.joints.get(id);
  if (!j) throw new Error(`no joint ${id}`);
  return j;
}

/** Steps `n` ticks, collecting the world events (and calling `each` before every step). */
function run(w: World, n: number, each?: () => void): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = 0; i < n; i++) {
    each?.();
    w.step();
    out.push(...w.events);
  }
  return out;
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const worldOf = (e: Entity, local: V3): V3 => {
  const q = e.pose.q;
  const tx = 2 * (q.y * local.z - q.z * local.y);
  const ty = 2 * (q.z * local.x - q.x * local.z);
  const tz = 2 * (q.x * local.y - q.y * local.x);
  return {
    x: e.pose.p.x + local.x + q.w * tx + (q.y * tz - q.z * ty),
    y: e.pose.p.y + local.y + q.w * ty + (q.z * tx - q.x * tz),
    z: e.pose.p.z + local.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

/** A fixed scaffold box (the hanging point), its underside at `y`. */
function post(w: World, x: number, y: number, z: number): number {
  return spawnBox(w, { p: { x, y: y + 0.2, z }, size: [0.4, 0.4, 0.4], material: 'dryWood', state: 'fixed', look: 'scaffold' });
}

/** A rope coil of `material` lying out of the way (the rope a joint is made of). */
function coil(w: World, material: 'vine' | 'sinew', lengthM: number, x = 20): number {
  return spawnRopeCoil(w, { at: { x, y: 0, z: 20 }, material, lengthM });
}

/** A rope joint, taut, between two anchors (made of a fresh coil). */
function tieRope(w: World, a: Anchor, b: Anchor, material: 'vine' | 'sinew' = 'vine', x = 20): number {
  const pa = a.entity === null ? a.local : worldOf(ent(w, a.entity), a.local);
  const pb = b.entity === null ? b.local : worldOf(ent(w, b.entity), b.local);
  const L = dist(pa, pb);
  return w.joints.rope(a, b, L, { entity: coil(w, material, L + 0.5, x), lengthM: L }, []);
}

const snaps = (ev: readonly WorldEvent[]): Extract<WorldEvent, { type: 'joint' }>[] =>
  ev.filter((e): e is Extract<WorldEvent, { type: 'joint' }> => e.type === 'joint' && e.what === 'snap');

// ---------------------------------------------------------------------------
// The tension fit (§4.9)
// ---------------------------------------------------------------------------

describe('the non-negative least squares', () => {
  it('solves an exact non-negative system and clips a negative unknown to 0', () => {
    // Two columns, b = 2·c0 + 3·c1.
    const c0 = [1, 0, 0, 0, 0, 0];
    const c1 = [0, 1, 0, 0, 0, 0];
    const x0 = nnls([c0, c1], [2, 3, 0, 0, 0, 0], 16);
    expect(x0[0]).toBeCloseTo(2, 6);
    expect(x0[1]).toBeCloseTo(3, 6);
    // b = −1·c0 + 3·c1: the best non-negative answer drops c0.
    const x1 = nnls([c0, c1], [-1, 3, 0, 0, 0, 0], 16);
    expect(x1[0]).toBe(0);
    expect(x1[1]).toBeCloseTo(3, 6);
    // Two parallel columns share (strands are one unknown in the store, but the solver must not blow up).
    const x = nnls([c0, c0], [4, 0, 0, 0, 0, 0], 16);
    expect(x[0] + x[1]).toBeCloseTo(4, 6);
    expect(Math.min(...x)).toBeGreaterThanOrEqual(0);
  });
});

describe('rope tension (§4.9)', () => {
  /** A 300 kg dry hex log (4 m, axis along z) hanging by its centre `L` below a post at (0, 8, 0). */
  function hangingLog(w: World, L: number, material: 'vine' | 'sinew', strands = 1): { log: number; joints: number[] } {
    const top = post(w, 0, 8, 0);
    const log = spawnLog(w, { p: { x: 0, y: 8 - L, z: 0 }, q: ALONG_Z, length: 4, mass: 300 });
    const joints: number[] = [];
    for (let k = 0; k < strands; k++) joints.push(tieRope(w, { entity: top, local: { x: 0, y: -0.2, z: 0 } }, { entity: log, local: { x: 0, y: 0, z: 0 } }, material, 20 + k));
    return { log, joints };
  }

  it('a still 300 kg log pulls 2.94 kN (SPEC:261), and its rope entity is tied with no body', async () => {
    const w = await make();
    const { log, joints } = hangingLog(w, 4, 'vine');
    const j = joint(w, joints[0]);
    expect(ent(w, j.rope!.entity).state).toBe('tied');
    expect(ent(w, j.rope!.entity).body).toBeNull();
    const ev = run(w, 120);
    expect(snaps(ev)).toEqual([]);
    const m = ent(w, log).body!.mass();
    expect(m).toBeCloseTo(300, 0);
    expect(j.tension[2]).toBeCloseTo(m * G, -1);
    expect(Math.abs(j.tension[2] - 2943) / 2943).toBeLessThan(0.01);
  });

  it('released from horizontal: ≈ 8.8 kN at the bottom (sinew holds); one vine snaps; two vine strands hold', async () => {
    const L = 4;
    /** The log released with its rope horizontal; returns the largest per-strand tension and the snap events. */
    const swing = async (material: 'vine' | 'sinew', strands: number): Promise<{ peak: number; snapped: number[] }> => {
      const w = await make();
      const top = post(w, 0, 8, 0);
      const log = spawnLog(w, { p: { x: L, y: 8, z: 0 }, q: ALONG_Z, length: 4, mass: 300 });
      const js: number[] = [];
      for (let k = 0; k < strands; k++) js.push(tieRope(w, { entity: top, local: { x: 0, y: -0.2, z: 0 } }, { entity: log, local: { x: 0, y: 0, z: 0 } }, material, 20 + k));
      let peak = 0;
      const ev = run(w, 90, () => {
        for (const id of js) {
          const j = w.joints.get(id);
          if (j) peak = Math.max(peak, ...j.tension);
        }
      });
      return { peak, snapped: snaps(ev).map((e) => e.joint) };
    };
    const sinew = await swing('sinew', 1);
    expect(sinew.snapped).toEqual([]);
    expect(Math.abs(sinew.peak - 3 * 300 * G) / (3 * 300 * G)).toBeLessThan(0.03);
    const one = await swing('vine', 1);
    expect(one.snapped).toHaveLength(1);
    const two = await swing('vine', 2);
    expect(two.snapped).toEqual([]);
    // Two strands share the swing: each about half of it.
    expect(two.peak).toBeGreaterThan(0.45 * 3 * 300 * G);
    expect(two.peak).toBeLessThan(MATERIALS.vine.strength && 'ropeKN' in MATERIALS.vine.strength ? MATERIALS.vine.strength.ropeKN * 1000 : 0);
  });

  it('the swinging-log statics: two hanging ropes 2.94 kN each and the tie 5.09 kN at 60°, within 1 % [C lab: e3_swing]', async () => {
    const w = await make();
    const H = 8;
    const L = 8 - 1.55;
    const th = Math.PI / 3;
    const P = { x: -L * Math.sin(th), y: H - L * Math.cos(th), z: 0 };
    const branch = post(w, 0, H, 0);
    const log = spawnLog(w, { p: P, q: ALONG_Z, length: 4, mass: 300 });
    const tiePost = post(w, P.x - 1.0 - 0.2, P.y - 0.2, 0);
    const hangA = tieRope(w, { entity: branch, local: { x: 0, y: -0.2, z: -1.6 } }, { entity: log, local: { x: 0, y: -1.6, z: 0 } }, 'vine', 20);
    const hangB = tieRope(w, { entity: branch, local: { x: 0, y: -0.2, z: 1.6 } }, { entity: log, local: { x: 0, y: 1.6, z: 0 } }, 'vine', 22);
    const tie = tieRope(w, { entity: tiePost, local: { x: 0.2, y: 0, z: 0 } }, { entity: log, local: { x: 0, y: 0, z: 0 } }, 'vine', 24);
    const ev = run(w, 120);
    expect(snaps(ev)).toEqual([]);
    const m = ent(w, log).body!.mass();
    const hang = (m * G) / (2 * Math.cos(th));
    const tieT = m * G * Math.tan(th);
    expect(Math.abs(joint(w, hangA).tension[2] - hang) / hang).toBeLessThan(0.01);
    expect(Math.abs(joint(w, hangB).tension[2] - hang) / hang).toBeLessThan(0.01);
    expect(Math.abs(joint(w, tie).tension[2] - tieT) / tieT).toBeLessThan(0.01);
    expect(hang).toBeCloseTo(2943, -1);
    expect(tieT).toBeCloseTo(5097, -1);
    // The view the client draws: taut, strain = tension / one strand's strength.
    const v = w.joints.view().find((r) => r.joint === tie)!;
    expect(v.taut).toBe(true);
    expect(v.strain).toBeCloseTo(Math.max(...joint(w, tie).tension) / 6000, 9);
  });
});

// ---------------------------------------------------------------------------
// Tripwires (§4.9, 9d)
// ---------------------------------------------------------------------------

/** Another fighter (a player-built body of `massKg`) at (x, z), standing. */
function body(w: World, massKg: number, x: number, z: number): Fighter {
  const ids = w.ids.fighter;
  const f = createPlayer({ ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  f.massKg = massKg;
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  w.addFighter(f, null);
  w.teleport(f, x, z, 0);
  return f;
}

/** Two fixed posts with a rope between their inner faces along x at height y (x from −half to +half, z = 0). */
function wire(w: World, half: number, y: number, material: 'vine' | 'sinew' = 'vine'): { joint: number; a: number; b: number } {
  const a = spawnBox(w, { p: { x: -half - 0.2, y, z: 0 }, size: [0.4, 2 * y, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
  const b = spawnBox(w, { p: { x: half + 0.2, y, z: 0 }, size: [0.4, 2 * y, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
  const joint = tieRope(w, { entity: a, local: { x: 0.2, y: 0, z: 0 } }, { entity: b, local: { x: -0.2, y: 0, z: 0 } }, material);
  return { joint, a, b };
}

const tripwires = (ev: readonly WorldEvent[]): Extract<WorldEvent, { type: 'tripwire' }>[] =>
  ev.filter((e): e is Extract<WorldEvent, { type: 'tripwire' }> => e.type === 'tripwire');

/** Forgets which crossings the joint store has counted this tick (several direct calls in one test tick). */
const newCrossings = (w: World): void => {
  (w.joints as unknown as { tripped: { tick: number; keys: Set<string> } }).tripped = { tick: -1, keys: new Set() };
};

describe('tripwires (§4.9)', () => {
  it('load = M·|v·n̂| / 0.1 s by root momentum: a player at 1.5 m/s 1,099 N and an ape at 4 m/s 3,902 N hold a vine; the giant at 4 m/s (560 kN) snaps it', async () => {
    const w = await make({ player: true });
    const { joint: wireId } = wire(w, 2, 0.3);
    run(w, 5);
    const zone = (f: Fighter) => ({ kind: 'fighter' as const, id: f.id, part: 'zone' as const });
    const cross = (f: Fighter, speed: number): Extract<WorldEvent, { type: 'tripwire' }> => {
      w.events.length = 0;
      f.vel.set(0, 0, 0);
      // Root velocity across the rope (z), plus some along it (x), which doesn't count.
      f.walkVel.set(0.7, 0, speed);
      w.joints.tripwire(w, wireId, zone(f));
      const t = tripwires(w.events);
      expect(t).toHaveLength(1);
      return t[0];
    };
    const p = w.player!;
    expect(p.mass).toBeCloseTo(73.3, 6);
    const t1 = cross(p, 1.5);
    expect(t1.loadN).toBeCloseTo((73.3 * 1.5) / 0.1, 6);
    expect(t1.loadN).toBeCloseTo(1099.5, 6);
    expect(t1).toMatchObject({ joint: wireId, by: zone(p), snapped: false, loosed: [] });
    const ape = body(w, 97.56, 6, 6);
    const t2 = cross(ape, 4);
    expect(t2.loadN).toBeCloseTo(3902.4, 6);
    expect(t2.snapped).toBe(false);
    expect(w.joints.get(wireId)).toBeDefined();
    const giant = body(w, 14000, -6, 6);
    const t3 = cross(giant, 4);
    expect(t3.loadN).toBeCloseTo(560000, 3);
    expect(t3.snapped).toBe(true);
    expect(w.joints.get(wireId)).toBeUndefined();
    expect(w.events.filter((e) => e.type === 'joint')).toEqual([expect.objectContaining({ joint: wireId, what: 'snap', point: expect.objectContaining({ x: expect.any(Number) }) })]);
  });

  it('an ape’s 3,902 N crossing of a vine tied to an 18 kg prop holds: its half of p is queued for the next 4d and never read by the fit (RF-2)', async () => {
    const w = await make();
    const postId = spawnBox(w, { p: { x: -2.2, y: 0.3, z: 0 }, size: [0.4, 0.6, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    const prop = spawnStick(w, { p: { x: 3.2, y: 0.07, z: 0 }, length: 2.4, r: 0.07 });
    expect(ent(w, prop).mass).toBeGreaterThan(17);
    expect(ent(w, prop).mass).toBeLessThan(19);
    run(w, 30);
    const vine = tieRope(w, { entity: postId, local: { x: 0.2, y: 0, z: 0 } }, { entity: prop, local: { x: 0, y: -1.2, z: 0 } }, 'vine');
    const ape = body(w, 97.56, 0, 0);
    run(w, 5);
    w.events.length = 0;
    ape.vel.set(0, 0, 0);
    ape.walkVel.set(0, 0, 4);
    // RF-2 is about the queue, so this crossing gives the prop the uncapped half of p (195 N·s, which the fit read as
    // 11.7 kN when it saw the shares): the end-speed cap (tripwireEndSpeedMul, SIM-fix) would give it 72 N·s and hide a
    // fit that reads shares. With the cap, the prop's share is checked below.
    setTuningValue('JOINT_TUNING', 'tripwireEndSpeedMul', Infinity);
    w.joints.tripwire(w, vine, { kind: 'fighter', id: ape.id, part: 'zone' });
    const [t] = tripwires(w.events);
    expect(t).toMatchObject({ joint: vine, snapped: false, loosed: [] });
    expect(t.loadN).toBeCloseTo(3902.4, 6);
    // Half of p on the prop (the post is fixed), along the rope toward the crossing point, queued.
    const q = w.entities.pendingImpulses().filter((x) => x.id === prop);
    expect(q).toHaveLength(1);
    expect(Math.hypot(q[0].j.x, q[0].j.y, q[0].j.z)).toBeCloseTo((97.56 * 4) / 2, 6);
    expect(q[0].j.x).toBeLessThan(0);
    let peak = 0;
    const ev = run(w, 120, () => {
      const j = w.joints.get(vine);
      if (j) peak = Math.max(peak, ...j.tension);
    });
    expect(snaps(ev)).toEqual([]);
    expect(w.joints.get(vine)).toBeDefined();
    expect(peak).toBeLessThan(6000);
    // With the cap (the default), the same crossing gives the 18 kg prop its mass × the ape's 4 m/s across the rope.
    resetTuning('JOINT_TUNING');
    run(w, 30);
    w.events.length = 0;
    newCrossings(w);
    ape.vel.set(0, 0, 0);
    ape.walkVel.set(0, 0, 4);
    w.joints.tripwire(w, vine, { kind: 'fighter', id: ape.id, part: 'zone' });
    // (The prop has moved since, so the rope's line, and the speed across it, are new: read from the load.)
    const [t2] = tripwires(w.events);
    expect(t2.snapped).toBe(false);
    const across = (t2.loadN * JOINT_TUNING.tripwireWindowS) / 97.56;
    expect(across).toBeGreaterThan(1);
    const q2 = w.entities.pendingImpulses().filter((x) => x.id === prop);
    expect(q2).toHaveLength(1);
    const share2 = Math.hypot(q2[0].j.x, q2[0].j.y, q2[0].j.z);
    expect(share2).toBeCloseTo(ent(w, prop).mass * across, 6);
    expect(share2).toBeLessThan((97.56 * across) / 2);
  });

  it('a fighter working on a rope or the entity at its end is no tripwire (RT-5); standing still in it carries nothing across', async () => {
    const w = await make();
    const { joint: rope, a } = wire(w, 2, 0.3);
    const f = body(w, 97.56, 0, 0);
    run(w, 3);
    const ropeEntity = joint(w, rope).rope!.entity;
    const crossing = (): number => {
      newCrossings(w);
      w.events.length = 0;
      f.vel.set(0, 0, 0);
      f.walkVel.set(0, 0, 0.8);
      w.joints.tripwire(w, rope, { kind: 'fighter', id: f.id, part: 'zone' });
      return tripwires(w.events).length;
    };
    const workOn = (target: number): void => {
      f.setState('pickup');
      f.work = { kind: 'untie', frames: 60, actAt: 30, faceAt: { x: 0, y: 0.3, z: 0 }, keys: [], cmd: { tick: w.tick, player: 1, kind: 'verb', verb: 'untie', target } };
    };
    for (const target of [ropeEntity, a]) {
      workOn(target);
      expect(crossing(), `working on ${target}`).toBe(0);
    }
    // Working on something else: the same crossing trips it.
    workOn(9999);
    expect(crossing()).toBe(1);
    // A hand reaching into it while the body stands still: no momentum across the rope, no tripwire.
    f.setState('idle');
    f.work = null;
    newCrossings(w);
    w.events.length = 0;
    f.walkVel.set(0, 0, 0);
    w.joints.tripwire(w, rope, { kind: 'fighter', id: f.id, part: 'zone' });
    expect(tripwires(w.events)).toEqual([]);
  });

  it('a crossing whose load beats an anchored stake’s capacity pulls it loose (an ape’s 3,902 N against 1,200 N): `loosed`, free, dynamic, its capped share queued, and it leaves no faster than the ape crossed; a player’s 1,099 N leaves it driven', async () => {
    const w = await make();
    const postId = spawnBox(w, { p: { x: -2.2, y: 0.3, z: 0 }, size: [0.4, 0.6, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    const stakeAt = (z: number): number => spawnLog(w, { p: { x: 2.2, y: 0.2, z }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
    const stake = stakeAt(0);
    const post2 = spawnBox(w, { p: { x: -2.2, y: 0.3, z: 6 }, size: [0.4, 0.6, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    const stake2 = stakeAt(6);
    expect(ent(w, stake).anchor!.capacityN).toBe(1200);
    run(w, 5);
    const vine = tieRope(w, { entity: postId, local: { x: 0.2, y: 0, z: 0 } }, { entity: stake, local: { x: 0, y: 0.3, z: 0 } }, 'vine');
    const vine2 = tieRope(w, { entity: post2, local: { x: 0.2, y: 0, z: 0 } }, { entity: stake2, local: { x: 0, y: 0.3, z: 0 } }, 'vine', 24);
    const ape = body(w, 97.56, 0, 0);
    const man = body(w, 73.3, 0, 6);
    run(w, 3);
    w.events.length = 0;
    man.vel.set(0, 0, 0);
    man.walkVel.set(0, 0, 1.5);
    w.joints.tripwire(w, vine2, { kind: 'fighter', id: man.id, part: 'zone' });
    ape.vel.set(0, 0, 0);
    ape.walkVel.set(0, 0, 4);
    w.joints.tripwire(w, vine, { kind: 'fighter', id: ape.id, part: 'zone' });
    const [t2, t1] = tripwires(w.events);
    expect(t2).toMatchObject({ joint: vine2, snapped: false, loosed: [] });
    expect(t2.loadN).toBeCloseTo(1099.5, 6);
    expect(ent(w, stake2).state).toBe('anchored');
    expect(t1).toMatchObject({ joint: vine, snapped: false, loosed: [stake] });
    expect(t1.loadN).toBeCloseTo(3902.4, 6);
    const s = ent(w, stake);
    expect(s.state).toBe('free');
    expect(s.anchor).toBeNull();
    expect(s.body!.isDynamic()).toBe(true);
    // Its share, along the rope toward the crossing point (−x), queued for the next 4d: half of p (195 N·s) capped at
    // the stake's mass × the ape's 4 m/s across the rope × tripwireEndSpeedMul (≈ 9.2 N·s for this 2.3 kg stake).
    // (Before the cap it was the whole half of p, which sent the stake off at ≈ 85 m/s to shatter on the post.)
    const q = w.entities.pendingImpulses().filter((x) => x.id === stake);
    expect(q).toHaveLength(1);
    const share = Math.hypot(q[0].j.x, q[0].j.y, q[0].j.z);
    expect(share).toBeCloseTo(s.mass * 4 * JOINT_TUNING.tripwireEndSpeedMul, 6);
    expect(share).toBeLessThan((97.56 * 4) / 2);
    expect(q[0].j.x).toBeLessThan(0);
    expect(w.entities.pendingImpulses().filter((x) => x.id === stake2)).toEqual([]);
    // Lifted clear of the ground (knockLoose: its driven end out of the heightfield).
    expect(s.pose.p.y - 0.5).toBeGreaterThanOrEqual(w.terrain.heightAt(s.pose.p.x, s.pose.p.z) - 1e-6);
    // The vine holds (3,902 N < 6 kN); the stake leaves at the ape's speed across the rope (its centre: the share over
    // its mass; one tick of gravity on top), and stays whole.
    // The share alone sends its centre off at the ape's 4 m/s across the rope (its body's mass is the record's).
    expect(share / s.body!.mass()).toBeCloseTo(4 * JOINT_TUNING.tripwireEndSpeedMul, 5);
    // Then physics: applied at its top, the share spins it, and its foot sliding on the ground adds a little (4.7 m/s
    // measured), an order of magnitude under the uncapped 85 m/s; it doesn't shatter.
    let fastest = 0;
    const ev = run(w, 30, () => {
      const e = w.entities.get(stake);
      if (e) fastest = Math.max(fastest, Math.hypot(e.vel.lin.x, e.vel.lin.y, e.vel.lin.z));
    });
    const e = ent(w, stake);
    fastest = Math.max(fastest, Math.hypot(e.vel.lin.x, e.vel.lin.y, e.vel.lin.z));
    expect(snaps(ev)).toEqual([]);
    expect(w.joints.get(vine)).toBeDefined();
    expect(fastest).toBeGreaterThan(2);
    expect(fastest).toBeLessThan(2 * 4 * JOINT_TUNING.tripwireEndSpeedMul);
    expect(ev.filter((x) => x.type === 'break' && x.entity === stake)).toEqual([]);
    expect(e.integrity).toBe(1);
  });

  it('a fighter attacking the entity it has focused is no tripwire for a rope tied to it (RT-5); idle, or attacking something else, it is', async () => {
    const w = await make();
    const { joint: rope, a } = wire(w, 2, 0.3);
    const f = body(w, 97.56, 0, 0);
    run(w, 3);
    const focus = vi.spyOn(w.verbs, 'focusedEntity').mockReturnValue(a);
    const crossing = (): number => {
      newCrossings(w);
      w.events.length = 0;
      f.vel.set(0, 0, 0);
      f.walkVel.set(0, 0, 0.8);
      w.joints.tripwire(w, rope, { kind: 'fighter', id: f.id, part: 'zone' });
      return tripwires(w.events).length;
    };
    f.setState('attack');
    expect(crossing()).toBe(0);
    focus.mockReturnValue(9999);
    expect(crossing()).toBe(1);
    focus.mockReturnValue(a);
    f.setState('idle');
    expect(crossing()).toBe(1);
  });

  it('a player running across a vine between two posts trips it through the contact pipeline, once, by his root momentum; the vine holds', async () => {
    const w = await make({ player: true });
    const { joint: rope } = wire(w, 2, 0.3);
    const p = w.player!;
    w.teleport(p, 0, -2.5, 0);
    run(w, 10);
    const ev: WorldEvent[] = [];
    let load: number | null = null;
    for (let t = 0; t < 150 && load === null; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
      w.step();
      ev.push(...w.events);
      const tw = tripwires(w.events);
      if (tw.length > 0) {
        load = tw[0].loadN;
        // Phase 9 read the root velocity phase 3 left (nothing changes it after).
        expect(tw[0].loadN).toBeCloseTo((p.mass * Math.abs(p.walkVel.z + p.vel.z)) / JOINT_TUNING.tripwireWindowS, 6);
      }
    }
    expect(load).not.toBeNull();
    expect(load!).toBeGreaterThan(1000);
    ev.push(...run(w, 60, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, 1))));
    expect(tripwires(ev)).toHaveLength(1);
    expect(w.joints.get(rope)).toBeDefined();
  });

  it('a hanging vine from the factory has a loose end and is never a tripwire; a log falling through it trips nothing', async () => {
    const w = await make();
    const { tree, vine } = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 8, vine: { anchorH: 6, lengthM: 4, yaw: 0 } });
    const j = joint(w, vine!.joint);
    expect(j.kind).toBe('rope');
    expect(j.a.entity).toBe(tree);
    expect(j.b).toEqual({ entity: null, local: expect.any(Object), loose: true });
    // Shorter than its anchor height: it hangs in the air below the anchor.
    expect(j.b.local.y).toBeCloseTo(worldOf(ent(w, tree), j.a.local).y - 4, 6);
    const f = body(w, 14000, 3, 3);
    run(w, 3);
    f.walkVel.set(4, 0, 4);
    w.events.length = 0;
    w.joints.tripwire(w, j.id, { kind: 'fighter', id: f.id, part: 'zone' });
    expect(tripwires(w.events)).toEqual([]);
    // A log dropped through its sensor: the contact pipeline hands it over, the store ignores it.
    const bottom = j.b.local;
    spawnLog(w, { p: { x: bottom.x, y: bottom.y + 1.5, z: bottom.z + 0.2 }, length: 1.5, mass: 30 });
    const ev = run(w, 90);
    expect(tripwires(ev)).toEqual([]);
    expect(w.joints.get(j.id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Held ends, the haul model, tying off (§4.9, I-2)
// ---------------------------------------------------------------------------

describe('held ends and the haul model (§4.9)', () => {
  /** A 30 kg dry hex log (4 m along z) hanging by both ends from a fixed beam 8 m up, its centre 1.5 m up. */
  function hungLog(w: World): { log: number; beamY: number } {
    const beam = spawnBox(w, { p: { x: 0, y: 8.2, z: 0 }, size: [0.4, 0.4, 4], material: 'dryWood', state: 'fixed', look: 'beam' });
    const log = spawnLog(w, { p: { x: 0, y: 1.5, z: 0 }, q: ALONG_Z, length: 4, mass: 30 });
    tieRope(w, { entity: beam, local: { x: 0, y: -0.2, z: -1.6 } }, { entity: log, local: { x: 0, y: -1.6, z: 0 } }, 'vine', 20);
    tieRope(w, { entity: beam, local: { x: 0, y: -0.2, z: 1.6 } }, { entity: log, local: { x: 0, y: 1.6, z: 0 } }, 'vine', 22);
    return { log, beamY: 8 };
  }

  /** The rope from the log's centre to the player's hand, taken in hand. */
  function takeEnd(w: World, log: number): number {
    const p = w.player!;
    const hand = w.joints.anchorPoint({ entity: null, local: { x: 0, y: 0, z: 0 }, fighter: p.id })!;
    const j = tieRope(w, { entity: log, local: { x: 0, y: 0, z: 0 } }, { entity: null, local: hand }, 'vine', 24);
    w.joints.holdEnd(j, 'b', p.id);
    return j;
  }

  const swingDeg = (w: World, log: number, beamY: number): number => {
    const c = ent(w, log).pose.p;
    return (Math.atan2(Math.hypot(c.x, c.z), beamY - c.y) * 180) / Math.PI;
  };

  it('a 30 kg log hauled by 500 N from 9 m reaches ≥ 30° within 8 s (I-2), the free length only shortening, the hand never pulled', async () => {
    const w = await make({ player: true });
    const { log, beamY } = hungLog(w);
    const p = w.player!;
    w.teleport(p, -9, 0, Math.PI / 2);
    run(w, 30);
    const j = takeEnd(w, log);
    expect(joint(w, j).b.fighter).toBe(p.id);
    let peak = 0;
    let len = joint(w, j).rope!.lengthM;
    const start = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    run(w, 480, () => {
      w.joints.setPull(j, 500);
      const now = joint(w, j).rope!.lengthM;
      expect(now).toBeLessThanOrEqual(len + 1e-9);
      len = now;
      peak = Math.max(peak, swingDeg(w, log, beamY));
    });
    expect(peak).toBeGreaterThanOrEqual(30);
    // The kinematic hand pulls; nothing pulls it (SPEC:268).
    expect(Math.hypot(p.pos.x - start.x, p.pos.z - start.z)).toBeLessThan(0.05);
    // The last pull stays in the record until the next 4d (a tie landing in phase 3 still sees it), which spends a pull
    // nobody set again: one tick without setPull and it is gone.
    expect(joint(w, j).pullN).toBe(500);
    w.step();
    expect(joint(w, j).pullN).toBe(0);
    // setPull is a held end's: on a rope with no held end it does nothing.
    const other = tieRope(w, { entity: log, local: { x: 0, y: 0, z: 0 } }, { entity: null, local: { x: 0, y: 8, z: 0 } }, 'vine', 26);
    w.joints.setPull(other, 500);
    expect(joint(w, other).pullN).toBe(0);
    w.joints.remove(other, 'untie');
    // The held rope's tension reads the hand's pull while it hauls (max(pullN, fitted)).
    w.joints.setPull(j, 500);
    w.step();
    expect(Math.max(...joint(w, j).tension)).toBeGreaterThanOrEqual(500);
  });

  it('a haul whose pull beats an anchored stake’s capacity (1,200 N) pulls it loose; 1,000 N leaves it driven', async () => {
    for (const [pull, loose] of [
      [1000, false],
      [1500, true],
    ] as const) {
      const w = await make({ player: true });
      const p = w.player!;
      w.teleport(p, -3, 0, Math.PI / 2);
      const stake = spawnLog(w, { p: { x: 2, y: 0.2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
      run(w, 10);
      const hand = w.joints.anchorPoint({ entity: null, local: { x: 0, y: 0, z: 0 }, fighter: p.id })!;
      const j = tieRope(w, { entity: stake, local: { x: 0, y: 0.4, z: 0 } }, { entity: null, local: hand }, 'vine', 24);
      w.joints.holdEnd(j, 'b', p.id);
      run(w, 5, () => w.joints.setPull(j, pull));
      const s = ent(w, stake);
      expect(s.state, `${pull} N`).toBe(loose ? 'free' : 'anchored');
      if (loose) {
        expect(s.anchor).toBeNull();
        expect(s.body!.isDynamic()).toBe(true);
        // Pulled toward the hand.
        expect(s.pose.p.x).toBeLessThan(2);
      } else expect(s.body!.isFixed()).toBe(true);
    }
  });

  it('tieHeldEnd: the held end becomes a rope joint to a post at that tick’s distance, and the log stays there', async () => {
    const w = await make({ player: true });
    const { log, beamY } = hungLog(w);
    const p = w.player!;
    w.teleport(p, -9, 0, Math.PI / 2);
    const postId = spawnBox(w, { p: { x: -8.8, y: 3, z: 0.6 }, size: [0.3, 6, 0.3], material: 'dryWood', state: 'fixed', look: 'post' });
    run(w, 30);
    const j = takeEnd(w, log);
    // Hauled, then tied with the haul off at a turning point of its swing about the 500 N equilibrium, level with the log
    // (a rope that holds a pendulum across its arc): tied at once. A tie made while the haul is on and the log still
    // runs along the rope cinches first (the next test).
    const speed = (): number => Math.hypot(ent(w, log).vel.lin.x, ent(w, log).vel.lin.y, ent(w, log).vel.lin.z);
    for (let t = 0; t < 480 && (t < 120 || speed() > 0.3); t++) run(w, 1, () => w.joints.setPull(j, 500));
    expect(speed()).toBeLessThan(0.3);
    const top: Anchor = { entity: postId, local: { x: 0.15, y: ent(w, log).pose.p.y - 3, z: -0.6 } };
    const d = dist(worldOf(ent(w, log), { x: 0, y: 0, z: 0 }), worldOf(ent(w, postId), top.local));
    w.joints.setPull(j, 0);
    w.joints.tieHeldEnd(j, top);
    const rec = joint(w, j);
    expect(rec.b).toEqual(top);
    expect(rec.rope!.lengthM).toBeCloseTo(d, 6);
    expect(rec.pullN).toBe(0);
    expect(ent(w, postId).joints).toContain(j);
    const tied = swingDeg(w, log, beamY);
    expect(tied).toBeGreaterThan(30);
    const ev = run(w, 180);
    expect(snaps(ev)).toEqual([]);
    expect(Math.abs(swingDeg(w, log, beamY) - tied)).toBeLessThan(3);
    // The tie holds the hauled log by statics: m g tan θ along the level rope.
    const th = (swingDeg(w, log, beamY) * Math.PI) / 180;
    const m = ent(w, log).body!.mass();
    expect(Math.abs(joint(w, j).tension[2] - m * G * Math.tan(th)) / (m * G * Math.tan(th))).toBeLessThan(0.05);
  });

  it('a held end tied off while the haul is on, at any phase of the swing, cinches until the log stops along the rope: nothing snaps and the log stays hauled back', async () => {
    // P10 review finding 3: a rigid rope made around a log still running along it caught it in one step (a 30 kg log tied
    // at ≈ 2 m/s snapped its vine tie, 6 of 39 to 8 of 39 phases); one tied while coming in came back to the tie's length
    // at that speed. The tie lands in phase 3 (§5.8), so the pull it keeps is the one the last 4d applied.
    const out: { va: number; cinchTicks: number; peak: number; drift: number }[] = [];
    for (let k = 150; k <= 320; k += 17) {
      const w = await make({ player: true });
      const { log, beamY } = hungLog(w);
      const p = w.player!;
      w.teleport(p, -9, 0, Math.PI / 2);
      const postId = spawnBox(w, { p: { x: -8.8, y: 3, z: 0.6 }, size: [0.3, 6, 0.3], material: 'dryWood', state: 'fixed', look: 'post' });
      run(w, 30);
      const j = takeEnd(w, log);
      run(w, k, () => w.joints.setPull(j, 500));
      const A = worldOf(ent(w, log), { x: 0, y: 0, z: 0 });
      const top: Anchor = { entity: postId, local: { x: 0.15, y: A.y - 3, z: -0.6 } };
      const T = worldOf(ent(w, postId), top.local);
      const u = { x: (T.x - A.x) / dist(A, T), y: (T.y - A.y) / dist(A, T), z: (T.z - A.z) / dist(A, T) };
      const b = ent(w, log).body!;
      const v = b.linvel();
      const va = v.x * u.x + v.y * u.y + v.z * u.z;
      const tiedAt = swingDeg(w, log, beamY);
      expect(joint(w, j).pullN).toBe(500);
      w.joints.tieHeldEnd(j, top);
      const rec = joint(w, j);
      expect(rec.b).toEqual(top);
      expect(rec.pullN, `phase ${k}`).toBe(Math.abs(va) > JOINT_TUNING.tieStillMps ? 500 : 0);
      let len = rec.rope!.lengthM;
      let cinchTicks = 0;
      let peak = 0;
      const ev = run(w, 240, () => {
        const r = joint(w, j);
        if (r.pullN > 0) {
          cinchTicks++;
          // Cinching: no rigid rope yet (the two hanging vines only), and the free length never grows.
          expect(w.physics.rapier.impulseJoints.len()).toBe(2);
          expect(r.rope!.lengthM).toBeLessThanOrEqual(len + 1e-9);
          len = r.rope!.lengthM;
        } else peak = Math.max(peak, r.tension[2]);
      });
      expect(snaps(ev), `phase ${k}`).toEqual([]);
      // The cinch ended (within 1 s) and the tie is a rope joint at the distance it ended at.
      expect(cinchTicks, `phase ${k}`).toBeLessThan(60);
      expect(joint(w, j).pullN).toBe(0);
      expect(w.physics.rapier.impulseJoints.len()).toBe(3);
      out.push({ va, cinchTicks, peak, drift: Math.abs(swingDeg(w, log, beamY) - tiedAt) });
    }
    // Not vacuous: ties made while the log ran out, while it came in, and every one cinched.
    expect(out.some((o) => o.va < -1)).toBe(true);
    expect(out.some((o) => o.va > 1)).toBe(true);
    expect(out.every((o) => o.cinchTicks > 0)).toBe(true);
    // Held by statics afterwards, well under a vine's 6 kN, near the angle it was tied at.
    for (const o of out) {
      expect(o.peak).toBeLessThan(3000);
      expect(o.drift).toBeLessThan(8);
    }
  });

  it('a cinching tie is saved: its pull stays in the record, the store rebuilt from the records goes on cinching without a rigid rope', async () => {
    const w = await make({ player: true });
    const { log } = hungLog(w);
    const p = w.player!;
    w.teleport(p, -9, 0, Math.PI / 2);
    const postId = spawnBox(w, { p: { x: -8.8, y: 3, z: 0.6 }, size: [0.3, 6, 0.3], material: 'dryWood', state: 'fixed', look: 'post' });
    run(w, 30);
    const j = takeEnd(w, log);
    // A phase where the log runs out from the post (the test above: va ≈ −2 m/s after 235 ticks of haul).
    run(w, 235, () => w.joints.setPull(j, 500));
    w.joints.tieHeldEnd(j, { entity: postId, local: { x: 0.15, y: ent(w, log).pose.p.y - 3, z: -0.6 } });
    expect(joint(w, j).pullN).toBe(500);
    run(w, 2);
    const rec = w.joints.toRecord().find((r) => r.id === j)!;
    expect(rec.pullN).toBe(500);
    w.joints.restoreRecord(w.joints.toRecord());
    expect(w.physics.rapier.impulseJoints.len()).toBe(2);
    let ticks = 0;
    while (joint(w, j).pullN > 0 && ticks < 120) {
      w.step();
      ticks++;
    }
    expect(joint(w, j).pullN).toBe(0);
    expect(w.physics.rapier.impulseJoints.len()).toBe(2);
    w.step();
    expect(w.physics.rapier.impulseJoints.len()).toBe(3);
  });

  it('dropEnd lets a held end lie loose; with both ends loose the joint is gone and the rope a coil on the ground', async () => {
    const w = await make({ player: true });
    const p = w.player!;
    const hand = w.joints.anchorPoint({ entity: null, local: { x: 0, y: 0, z: 0 }, fighter: p.id })!;
    const c = coil(w, 'vine', 6);
    const j = w.joints.rope({ entity: null, local: { x: hand.x + 3, y: 0, z: hand.z }, loose: true }, { entity: null, local: hand }, 4, { entity: c, lengthM: 4 }, []);
    w.joints.holdEnd(j, 'b', p.id);
    expect(ent(w, c).state).toBe('tied');
    w.events.length = 0;
    w.joints.dropEnd(j, { x: hand.x, y: 0, z: hand.z });
    expect(w.joints.get(j)).toBeUndefined();
    expect(w.events.filter((e) => e.type === 'joint')).toEqual([expect.objectContaining({ joint: j, what: 'loose' })]);
    const e = ent(w, c);
    expect(e.state).toBe('free');
    expect(e.body).not.toBeNull();
    expect(e.joints).toEqual([]);
    expect(e.pose.p.y).toBeCloseTo(w.terrain.heightAt(e.pose.p.x, e.pose.p.z) + (e.shape as { halfHeight: number }).halfHeight, 6);
  });
});

// ---------------------------------------------------------------------------
// Lashings, bends, coils
// ---------------------------------------------------------------------------

describe('lashings, bends and coils', () => {
  it('a lashing is a fixed joint with break energy ropeKN × 1000 × lashLeverM (vine 600 J, sinew 1,800 J, D-18), listed on both ends', async () => {
    const w = await make();
    const a = spawnStick(w, { p: { x: 0, y: 0.05, z: 0 }, length: 1, r: 0.03 });
    const b = spawnStick(w, { p: { x: 0, y: 0.05, z: 1 }, length: 1, r: 0.03 });
    const s = spawnStick(w, { p: { x: 0, y: 0.05, z: 2 }, length: 1, r: 0.03 });
    const vine = w.joints.lash({ entity: a, local: { x: 0, y: 0.5, z: 0 } }, { entity: b, local: { x: 0, y: 0.5, z: -1 } }, { entity: coil(w, 'vine', 1), lengthM: 1 }, ['p1']);
    const sinew = w.joints.lash({ entity: b, local: { x: 0, y: 0.5, z: 0 } }, { entity: s, local: { x: 0, y: 0.5, z: -1 } }, { entity: coil(w, 'sinew', 1, 25), lengthM: 1 }, []);
    expect(joint(w, vine).breakEnergyJ).toBeCloseTo(600, 9);
    expect(joint(w, sinew).breakEnergyJ).toBeCloseTo(1800, 9);
    expect(joint(w, vine).credit).toEqual(['p1']);
    expect(ent(w, a).joints).toEqual([vine]);
    expect(ent(w, b).joints).toEqual([vine, sinew]);
    expect(w.physics.rapier.impulseJoints.len()).toBe(2);
  });

  it('the starter axe stays lashed through stow → draw → drop: the Rapier joint is made again from the record', async () => {
    const w = await make();
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 0 });
    const rapierJoints = (): number => w.physics.rapier.impulseJoints.len();
    expect(rapierJoints()).toBe(1);
    run(w, 30);
    const stick = ent(w, axe.stick);
    const head = ent(w, axe.head);
    const gap = (): number => dist(stick.pose.p, head.pose.p);
    const before = gap();
    for (const e of [stick, head]) w.entities.setState(e, 'held');
    for (const e of [stick, head]) w.entities.setState(e, 'stowed');
    expect(rapierJoints()).toBe(0);
    for (const e of [stick, head]) w.entities.setState(e, 'held');
    // Drawn and dropped 1 m up (the hands keep the parts' relative pose).
    for (const e of [stick, head]) e.pose = { p: { x: e.pose.p.x, y: e.pose.p.y + 1, z: e.pose.p.z }, q: e.pose.q };
    for (const e of [stick, head]) w.entities.setState(e, 'free');
    w.step();
    expect(rapierJoints()).toBe(1);
    expect(joint(w, axe.joint).kind).toBe('lash');
    // A kick on the head alone: the stick goes with it.
    w.entities.queueImpulse(head.id, { x: 0, y: 0, z: 3 }, null);
    run(w, 60);
    expect(Math.abs(gap() - before)).toBeLessThan(0.005);
    expect(Math.abs(stick.pose.p.z)).toBeGreaterThan(0.05);
  });

  it('bend: a 6 cm sapling bent toward a stake and held by its rope; cut, it springs back and roots again', async () => {
    const w = await make();
    const sap = spawnSapling(w, { at: { x: 0, z: 0 }, diameter: 0.06, height: 3 });
    const stake = spawnLog(w, { p: { x: 2, y: 0.2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
    run(w, 5);
    const top: Anchor = { entity: sap, local: { x: 0, y: 1.5, z: 0 } };
    const hold: Anchor = { entity: stake, local: { x: 0, y: 0.5, z: 0 } };
    const { bend, hold: rope } = w.joints.bend(sap, top, hold, { entity: coil(w, 'vine', 2), lengthM: 2 }, ['p1']);
    expect(rope).toBe(bend + 1);
    const s = ent(w, sap);
    expect(s.plant!.phase).toBe('bent');
    expect(s.body!.isDynamic()).toBe(true);
    const b = joint(w, bend);
    expect(b.kind).toBe('bend');
    expect(b.motor!.restAngle).toBe(0);
    expect(b.motor!.stiffness).toBeCloseTo(JOINT_TUNING.bendK * MATERIALS.greenWood.springiness * 0.06 * 0.06, 9);
    expect(b.motor!.stiffness).toBeCloseTo(864, 9);
    expect(joint(w, rope).holdsBend).toBe(bend);
    const tilt = (): number => {
      const q = s.pose.q;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      return (Math.acos(Math.max(-1, Math.min(1, upY))) * 180) / Math.PI;
    };
    const bent = tilt();
    expect(bent).toBeGreaterThan(45);
    const ev1 = run(w, 120);
    expect(snaps(ev1)).toEqual([]);
    expect(Math.abs(tilt() - bent)).toBeLessThan(8);
    w.events.length = 0;
    w.joints.remove(rope, 'cut');
    expect(w.events.filter((e) => e.type === 'joint').map((e) => (e as { what: string }).what)).toEqual(['cut', 'release']);
    let minTilt = 90;
    const ev2 = run(w, 600, () => {
      minTilt = Math.min(minTilt, tilt());
    });
    expect(snaps(ev2)).toEqual([]);
    expect(minTilt).toBeLessThan(JOINT_TUNING.bendSettleDeg);
    expect(s.plant!.phase).toBe('standing');
    expect(s.state).toBe('fixed');
    expect(w.joints.get(bend)).toBeUndefined();
  });

  it('revoluteAngle reads 0 for bodies turned alike and the turn between them about the axis otherwise', () => {
    const z = { x: 0, y: 0, z: 1 };
    const id: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const turnZ = (a: number): Quat => ({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) });
    expect(revoluteAngle(id, z, id, z)).toBeCloseTo(0, 12);
    // A body turned by a about z, with its local axis the same world axis: it reads ±a.
    for (const a of [0.3, -1.2, 2.5]) expect(Math.abs(revoluteAngle(id, z, turnZ(a), z))).toBeCloseTo(Math.abs(a), 9);
    // Both turned alike: 0, whatever the turn.
    expect(revoluteAngle(turnZ(1), z, turnZ(1), z)).toBeCloseTo(0, 9);
  });

  it('a hinge is a revolute about its axis that stops at its limits; with no limits it swings down free', async () => {
    /** A 2 m plank sticking out horizontally along +x from a fixed post, hinged at the post's face about z. */
    const droop = async (limits: [number, number] | null): Promise<number> => {
      const w = await make();
      const top = post(w, 0, 3, 0);
      const ALONG_X: Quat = { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 };
      const plank = spawnLog(w, { p: { x: 1.2, y: 3.2, z: 0 }, q: ALONG_X, length: 2, r: 0.05, mass: 10 });
      const h = w.joints.hinge({ entity: top, local: { x: 0.2, y: 0, z: 0 } }, { entity: plank, local: { x: 0, y: -1, z: 0 } }, { x: 0, y: 0, z: 1 }, limits, { entity: coil(w, 'vine', 1), lengthM: 1 }, []);
      expect(joint(w, h)).toMatchObject({ kind: 'hinge', breakEnergyJ: 600 });
      // Kept in Rapier's reference: the plank is turned a quarter turn about the axis from the post, so the record's
      // limits are the asked ones moved by that angle (the same width).
      const rec = joint(w, h).limits;
      if (limits) {
        expect(rec![1] - rec![0]).toBeCloseTo(limits[1] - limits[0], 9);
        expect(Math.abs(rec![0] - limits[0])).toBeCloseTo(Math.PI / 2, 5);
      } else expect(rec).toBeNull();
      // The largest angle of the plank's axis (local +y) below the horizontal over 3 s, rad.
      let most = 0;
      run(w, 180, () => {
        const q = ent(w, plank).pose.q;
        most = Math.max(most, Math.asin(-(1 - 2 * (q.x * q.x + q.z * q.z))));
      });
      return most;
    };
    const held = await droop([-0.3, 0.3]);
    expect(held).toBeGreaterThan(0.2);
    expect(held).toBeLessThan(0.3 + 0.03);
    const free = await droop(null);
    expect(free).toBeGreaterThan(1.2);
  });

  it('shorten reels in a slack rope by dl, never shorter than the distance between its ends; nothing for dl ≤ 0', async () => {
    const w = await make();
    const a = spawnBox(w, { p: { x: -1.7, y: 1, z: 0 }, size: [0.4, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    const b = spawnBox(w, { p: { x: 1.7, y: 1, z: 0 }, size: [0.4, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    const j = w.joints.rope({ entity: a, local: { x: 0.2, y: 0, z: 0 } }, { entity: b, local: { x: -0.2, y: 0, z: 0 } }, 5, { entity: coil(w, 'vine', 6), lengthM: 5 }, []);
    const len = (): number => joint(w, j).rope!.lengthM;
    w.joints.shorten(j, 0.5);
    expect(len()).toBeCloseTo(4.5, 12);
    w.joints.shorten(j, 0);
    w.joints.shorten(j, -1);
    expect(len()).toBeCloseTo(4.5, 12);
    w.joints.shorten(j, 10);
    expect(len()).toBeCloseTo(3, 6);
    w.joints.shorten(j, 1);
    expect(len()).toBeCloseTo(3, 6);
    run(w, 2);
    expect(w.joints.view().find((v) => v.joint === j)!.taut).toBe(true);
  });

  it('a bend’s holding rope that loses an end (its anchor end lying loose, or taken in hand) releases the bend: `release`, it springs back and roots again', async () => {
    for (const how of ['loose', 'hold'] as const) {
      const w = await make({ player: how === 'hold' });
      const sap = spawnSapling(w, { at: { x: 0, z: 0 }, diameter: 0.06, height: 3 });
      const stake = spawnLog(w, { p: { x: 2, y: 0.2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
      run(w, 5);
      const { bend, hold: rope } = w.joints.bend(sap, { entity: sap, local: { x: 0, y: 1.5, z: 0 } }, { entity: stake, local: { x: 0, y: 0.5, z: 0 } }, { entity: coil(w, 'vine', 2), lengthM: 2 }, []);
      run(w, 30);
      w.events.length = 0;
      if (how === 'loose') w.joints.loosen(rope, 'b', w.joints.anchorPoint(joint(w, rope).b)!);
      else w.joints.holdEnd(rope, 'b', w.player!.id);
      const what = w.events.filter((e) => e.type === 'joint').map((e) => [(e as { joint: number }).joint, (e as { what: string }).what]);
      expect(what, how).toEqual(how === 'loose' ? [[rope, 'loose'], [bend, 'release']] : [[bend, 'release']]);
      expect(joint(w, rope).holdsBend).toBeNull();
      run(w, 600);
      const s = ent(w, sap);
      expect(s.plant!.phase, how).toBe('standing');
      expect(s.state).toBe('fixed');
      expect(w.joints.get(bend)).toBeUndefined();
    }
  });

  it('bendAngle is the angle bend() poses a sapling at, and says when the force at its top limits it (§5.9)', async () => {
    const w = await make();
    const thin = spawnSapling(w, { at: { x: 0, z: 0 }, diameter: 0.06, height: 3 });
    const stiff = spawnSapling(w, { at: { x: 0, z: 6 }, diameter: 0.12, height: 3 });
    const stakeA = spawnLog(w, { p: { x: 2, y: 0.2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
    const stakeB = spawnLog(w, { p: { x: 2, y: 0.2, z: 6 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
    run(w, 5);
    const top = { x: 0, y: 1.5, z: 0 };
    const holdA = w.joints.anchorPoint({ entity: stakeA, local: { x: 0, y: 0.5, z: 0 } })!;
    const holdB = w.joints.anchorPoint({ entity: stakeB, local: { x: 0, y: 0.5, z: 0 } })!;
    const a = bendAngle(ent(w, thin), top, holdA)!;
    expect(a.stiffness).toBeCloseTo(864, 9);
    // k θ / L ≤ 500 N: the 6 cm sapling isn't held back by the force (1.74 rad > its reach); the 12 cm one is (0.43 rad).
    expect(a.forceTheta).toBeCloseTo((VERB_TUNING.bendMaxForceN * 3) / 864, 6);
    expect(a.forceLimited).toBe(false);
    expect(a.theta).toBeCloseTo(Math.min(a.reachTheta, Math.PI / 2), 12);
    const b = bendAngle(ent(w, stiff), top, holdB)!;
    expect(b.stiffness).toBeCloseTo(4 * 864, 6);
    expect(b.forceLimited).toBe(true);
    expect(b.theta).toBeCloseTo((VERB_TUNING.bendMaxForceN * 3) / (4 * 864), 6);
    expect((b.theta * 180) / Math.PI).toBeGreaterThan(VERB_TUNING.bendMinDeg);
    // Straight above its base: no direction to bend in.
    expect(bendAngle(ent(w, thin), top, { x: ent(w, thin).pose.p.x, y: 5, z: ent(w, thin).pose.p.z })).toBeNull();
    // bend() poses each at that angle.
    const tilt = (id: number): number => {
      const q = ent(w, id).pose.q;
      return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
    };
    w.joints.bend(thin, { entity: thin, local: top }, { entity: stakeA, local: { x: 0, y: 0.5, z: 0 } }, { entity: coil(w, 'vine', 2), lengthM: 2 }, []);
    w.joints.bend(stiff, { entity: stiff, local: top }, { entity: stakeB, local: { x: 0, y: 0.5, z: 0 } }, { entity: coil(w, 'vine', 2, 24), lengthM: 2 }, []);
    expect(tilt(thin)).toBeCloseTo(a.theta, 6);
    expect(tilt(stiff)).toBeCloseTo(b.theta, 6);
  });

  it('remove: the joint event carries its point; untied, the rope becomes a coil on the ground under it; an unknown id does nothing', async () => {
    const w = await make();
    const top = post(w, 0, 3, 0);
    const log = spawnLog(w, { p: { x: 0, y: 1, z: 0 }, q: ALONG_Z, length: 2, mass: 20 });
    const j = tieRope(w, { entity: top, local: { x: 0, y: -0.2, z: 0 } }, { entity: log, local: { x: 0, y: 0, z: 0 } });
    const ropeId = joint(w, j).rope!.entity;
    run(w, 10);
    w.events.length = 0;
    w.joints.remove(j, 'untie');
    const ev = w.events.find((e) => e.type === 'joint') as Extract<WorldEvent, { type: 'joint' }>;
    expect(ev).toMatchObject({ joint: j, what: 'untie' });
    expect(ev.point!.y).toBeGreaterThan(1);
    expect(ev.point!.y).toBeLessThan(3);
    expect(ent(w, ropeId).state).toBe('free');
    expect(ent(w, top).joints).toEqual([]);
    expect(ent(w, log).joints).toEqual([]);
    w.joints.remove(j, 'untie');
    w.joints.remove(9999, 'release');
    expect(w.events.filter((e) => e.type === 'joint')).toHaveLength(1);
    // Removing an entity releases its joints (EntityStore.remove → JointStore.remove(…, 'release')).
    const j2 = tieRope(w, { entity: top, local: { x: 0, y: -0.2, z: 0 } }, { entity: log, local: { x: 0, y: 0, z: 0 } });
    w.events.length = 0;
    w.removeEntity(log);
    expect(w.joints.get(j2)).toBeUndefined();
    expect(w.events.map((e) => e.type)).toEqual(['joint', 'remove']);
  });
});
