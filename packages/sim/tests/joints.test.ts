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
import { createPlayer } from '../src/sim/roster';
import { resetTuning } from '../src/tuning/registry';
import { BREAK_TUNING } from '../src/world/breaking';
import { spawnBox, spawnLog, spawnRopeCoil, spawnSapling, spawnStarterAxe, spawnStick, spawnTree } from '../src/world/factory';
import { JOINT_TUNING, nnls } from '../src/world/joints';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
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
