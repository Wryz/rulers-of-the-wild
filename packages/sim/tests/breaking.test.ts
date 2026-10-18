// P10, breaking (docs/M1-DESIGN.md §4.10, §2.3, §1.5.7): integrity loss by the break-energy rule, the split into
// pieces (impact fracture, load break across the axis), what the pieces inherit, joints and anchors failing first, and
// the pieces' grace until they are clear of their breaker (RF-7).
//
// - E_b = strength × mass (SPEC:344); an impact of E lowers integrity by max(0, E − E_b)/E_b; at 0 the entity splits
//   into n = clamp(2 + ⌊E/E_b − 1⌋, 2, 4) pieces, parents in id order and piece ids in that order.
// - pieces keep material, moisture, temperature, burning, age and credit; integrity 1; the velocity of their centre
//   from the parent's rigid motion (v + ω × (c − com)); each sharp point goes to the piece holding it.
// - lashings and hinges snap on an impact above their break energy (lashed structures fail at their joints first);
//   an anchored stake struck with more than capacity × loadLeverM is knocked loose (§2.3).
// - a load break snaps across the long axis at the load point: 2 pieces, or 3 when two load points are more than
//   loadPointSplitM apart (RT-7); it takes precedence over an impact break in the same tick.
// - a broken stake's pieces stay non-colliding with the lying giant until clear of it, and are crushed at 600 ticks if
//   never clear (RF-7).
//
// A note for the felling tests: a 30 cm × 15 m green-wood trunk (≈ 850 kg, E_b ≈ 34 kJ) lands tip first at ≈ 20 m/s,
// and the contact rule scores it on its whole mass (P09, §4.3), far above E_b: it lands in pieces. That is recorded as
// a deviation for P09 (an effective mass at the contact point); felling.test.ts measures the fall line while falling.
//
// Scene numbers (masses, lengths, positions, speeds, energies) are test constants, never tuning (§9).
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetTuning } from '../src/tuning/registry';
import { BREAK_TUNING } from '../src/world/breaking';
import { spawnBox, spawnLog, spawnRopeCoil, spawnStick, spawnStone } from '../src/world/factory';
import { collisionGroups, GROUP, solverGroups } from '../src/world/groups';
import { breakEnergyJ, MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import type { Entity, Owner, Quat, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
async function make(): Promise<World> {
  const w = await createWorld({ seed: 202, scene: 'empty', nav: 'off', size: 50, player: false });
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

/** A prism's axis (local +y) standing up. */
const UPRIGHT: Quat = { x: 0, y: 0, z: 0, w: 1 };

function ent(w: World, id: number): Entity {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
}

function run(w: World, n: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = 0; i < n; i++) {
    w.step();
    out.push(...w.events);
  }
  return out;
}

type BreakEvent = Extract<WorldEvent, { type: 'break' }>;
type JointEvent = Extract<WorldEvent, { type: 'joint' }>;
const breaks = (ev: readonly WorldEvent[]): BreakEvent[] => ev.filter((e): e is BreakEvent => e.type === 'break');
const jointEvents = (ev: readonly WorldEvent[]): JointEvent[] => ev.filter((e): e is JointEvent => e.type === 'joint');

const Eb = (e: Entity): number => breakEnergyJ(MATERIALS[e.material], e.mass);
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
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

/** A dry-wood log of `mass` lying along x on the ground at (x, z). */
function groundLog(w: World, x: number, z: number, mass: number, length = 2): number {
  return spawnLog(w, { p: { x, y: 0.2, z }, length, mass });
}

/** A fake giant's body (P11 builds the real one): a fixed RULER_SOLID box registered as a fighter's ruler bone. */
function giantBox(w: World, fighter: number, centre: V3, half: V3): RAPIER.Collider {
  const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(centre.x, centre.y, centre.z));
  const c = w.physics.rapier.createCollider(
    RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setCollisionGroups(collisionGroups('RULER_SOLID'))
      .setSolverGroups(solverGroups('RULER_SOLID'))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
  );
  w.physics.register(c, { kind: 'fighter', id: fighter, part: 'ruler', bone: 'chest' });
  return c;
}

/** Whether a collider's collision filter lets it meet RULER_SOLID colliders. */
const meetsRulerSolid = (c: RAPIER.Collider): boolean => ((c.collisionGroups() & 0xffff) & GROUP.RULER_SOLID) !== 0;

// ---------------------------------------------------------------------------
// Integrity and the split
// ---------------------------------------------------------------------------

describe('integrity and the split (§4.10, SPEC:344)', () => {
  it('an impact lowers integrity by (E − E_b)/E_b; at or below E_b nothing; at 0 the entity splits into clamp(2 + ⌊E/E_b − 1⌋, 2, 4) pieces, parents in id order', async () => {
    const w = await make();
    const a = groundLog(w, -4, 0, 10);
    const b = groundLog(w, 0, 0, 10);
    const c = groundLog(w, 4, 0, 10);
    run(w, 30);
    const ea = ent(w, a);
    const E = Eb(ea);
    expect(E).toBeCloseTo(300, 6); // dry wood 30 J/kg × 10 kg
    // At or below E_b, and nonsense energies, change nothing.
    for (const x of [E, 0.5 * E, 0, -50, Number.NaN, Number.POSITIVE_INFINITY]) w.breaking.hit(ea, x, ea.pose.p, null);
    expect(ea.integrity).toBe(1);
    w.breaking.hit(ea, 1.5 * E, ea.pose.p, null);
    expect(ea.integrity).toBeCloseTo(0.5, 12);
    // The impact that breaks each: 1.6 E_b (from 0.5) → 2 pieces; 2 E_b → 3; 10 E_b → 4 (clamped).
    w.breaking.hit(ea, 1.6 * E, ea.pose.p, null);
    const eb = ent(w, b);
    const ec = ent(w, c);
    w.breaking.hit(ec, 10 * E, ec.pose.p, null);
    w.breaking.hit(eb, 2 * E, { ...eb.pose.p, y: eb.pose.p.y + 0.1 }, null);
    expect([ea.integrity, eb.integrity, ec.integrity]).toEqual([0, 0, 0]);
    const masses = [ea.mass, eb.mass, ec.mass];
    const before = Math.max(...w.entities.all().map((e) => e.id));
    w.step();
    const ev = breaks(w.events);
    expect(ev.map((x) => x.entity)).toEqual([a, b, c]);
    expect(ev.map((x) => x.pieces.length)).toEqual([2, 3, 4]);
    expect(ev.map((x) => x.energy)).toEqual([1.6 * E, 2 * E, 10 * E]);
    expect(ev[1].point.y).toBeCloseTo(eb.pose.p.y + 0.1, 5);
    // Piece ids in parent id order, after every id before the break.
    const ids = ev.flatMap((x) => x.pieces);
    expect(ids).toEqual([...ids].sort((p, q) => p - q));
    expect(ids[0]).toBeGreaterThan(before);
    ev.forEach((x, i) => {
      expect(w.entities.get(x.entity)).toBeUndefined();
      const pieces = x.pieces.map((id) => ent(w, id));
      const m = pieces.reduce((s, p) => s + p.mass, 0);
      expect(Math.abs(m - masses[i]) / masses[i]).toBeLessThan(1e-6);
      for (const p of pieces) {
        expect(p.material).toBe('dryWood');
        expect(p.integrity).toBe(1);
        expect(p.state).toBe('free');
        expect(p.grace).toBeNull(); // no breaker
      }
    });
  });

  it('pieces keep material, moisture, temperature, burning, age and credit, the parent’s rotation, and its rigid motion v + ω × (c − com)', async () => {
    const w = await make();
    const id = spawnLog(w, { p: { x: 0, y: 12, z: 0 }, q: { x: 0.2, y: 0.3, z: 0.1, w: 0.927 }, length: 2.4, mass: 20 });
    w.step();
    const e = ent(w, id);
    e.moisture = 0.4;
    e.temperature = 31;
    e.age = 123.5;
    e.credit = ['p1', 'p2'];
    e.body!.setLinvel({ x: 1, y: 0, z: 2 }, true);
    e.body!.setAngvel({ x: 0, y: 3, z: 1 }, true);
    w.breaking.hit(e, 5 * Eb(e), e.pose.p, null);
    w.step();
    const ev = breaks(w.events);
    expect(ev).toHaveLength(1);
    expect(ev[0].pieces).toHaveLength(4);
    const pieces = ev[0].pieces.map((p) => ent(w, p));
    const M = pieces.reduce((s, p) => s + p.mass, 0);
    const vCom = { x: 0, y: 0, z: 0 };
    for (const p of pieces) {
      expect(p.material).toBe('dryWood');
      expect(p.moisture).toBe(0.4);
      expect(p.temperature).toBe(31);
      expect(p.burning).toBe(false);
      expect(p.age).toBeGreaterThanOrEqual(123.5);
      expect(p.credit).toEqual(['p1', 'p2']);
      expect(p.look).toBe('log');
      // One rotation and one angular velocity for every piece, the parent's.
      expect(Math.abs(p.pose.q.x * pieces[0].pose.q.x + p.pose.q.y * pieces[0].pose.q.y + p.pose.q.z * pieces[0].pose.q.z + p.pose.q.w * pieces[0].pose.q.w)).toBeGreaterThan(1 - 1e-6);
      expect(len(sub(p.vel.ang, pieces[0].vel.ang))).toBeLessThan(1e-4);
      vCom.x += (p.mass * p.vel.lin.x) / M;
      vCom.y += (p.mass * p.vel.lin.y) / M;
      vCom.z += (p.mass * p.vel.lin.z) / M;
    }
    expect(len(sub(pieces[0].vel.ang, { x: 0, y: 3, z: 1 }))).toBeLessThan(0.05);
    // Each piece moves as a point of the parent: v_i − v_j = ω × (c_i − c_j).
    for (const p of pieces) {
      const rel = sub(p.vel.lin, pieces[0].vel.lin);
      const want = cross(pieces[0].vel.ang, sub(p.pose.p, pieces[0].pose.p));
      expect(len(sub(rel, want))).toBeLessThan(1e-3);
    }
    // The pieces' momentum is the parent's (one step of gravity after the velocities were set).
    expect(len(sub(vCom, { x: 1, y: -9.81 / 60, z: 2 }))).toBeLessThan(0.02);
    // Rotating, the parent's off-centre pieces don't all move alike.
    expect(Math.max(...pieces.map((p) => len(sub(p.vel.lin, vCom))))).toBeGreaterThan(0.05);
  });

  it('a sharp point goes to the piece that holds it and stays where it was in the world (impact and load breaks)', async () => {
    const w = await make();
    const s1 = spawnStick(w, { p: { x: 0, y: 0.1, z: 0 }, length: 2, r: 0.03, sharp: { end: 1, s: 0.5 } });
    const s2 = spawnStick(w, { p: { x: 0, y: 0.1, z: 3 }, length: 2, r: 0.03, sharp: { end: 1, s: 0.5 } });
    run(w, 60);
    const e1 = ent(w, s1);
    const e2 = ent(w, s2);
    const tip1 = worldOf(e1, e1.sharpPoints[0].local);
    const tip2 = worldOf(e2, e2.sharpPoints[0].local);
    const sharpness = e1.sharpPoints[0].sharpness;
    w.breaking.hit(e1, 2.5 * Eb(e1), e1.pose.p, null); // ratio 2.5: 3 pieces
    // Snapped across its axis 0.5 m from the middle toward the point: the point's piece is the 0.5 m one.
    const at = worldOf(e2, { x: 0, y: 0.5, z: 0 });
    w.breaking.loadBreak(e2, at, null);
    w.step();
    const ev = breaks(w.events);
    expect(ev.map((x) => [x.entity, x.pieces.length])).toEqual([
      [s1, 3],
      [s2, 2],
    ]);
    for (const [x, tip] of [
      [ev[0], tip1],
      [ev[1], tip2],
    ] as const) {
      const holders = x.pieces.map((id) => ent(w, id)).filter((p) => p.sharpPoints.length > 0);
      expect(holders).toHaveLength(1);
      const sp = holders[0].sharpPoints[0];
      expect(sp.sharpness).toBe(sharpness);
      expect(len(sub(worldOf(holders[0], sp.local), tip))).toBeLessThan(2e-3);
    }
    const lb = ev[1].pieces.map((id) => ent(w, id));
    const holder = lb.find((p) => p.sharpPoints.length > 0)!;
    const other = lb.find((p) => p.sharpPoints.length === 0)!;
    // The point's piece is the 0.5 m one: a third of the 1.5 m one's length, and lighter than a third (its tip tapers).
    expect(holder.mass / other.mass).toBeLessThan(1 / 3);
    expect(holder.mass / other.mass).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// Joints and anchors fail first
// ---------------------------------------------------------------------------

describe('joints and anchors fail first (§2.3, SPEC:344)', () => {
  it('a lashing snaps on an impact above its break energy (vine 600 J) before the logs lose integrity; a weaker impact or a sinew lashing holds', async () => {
    const w = await make();
    const a = groundLog(w, 0, 0, 50, 2);
    const b = groundLog(w, 0, 0.5, 50, 2);
    const c = groundLog(w, 0, 1, 50, 2);
    run(w, 20);
    const vineCoil = spawnRopeCoil(w, { at: { x: 10, y: 0, z: 10 }, material: 'vine', lengthM: 1 });
    const sinewCoil = spawnRopeCoil(w, { at: { x: 12, y: 0, z: 10 }, material: 'sinew', lengthM: 1 });
    const vine = w.joints.lash({ entity: a, local: { x: 0, y: 0, z: 0.25 } }, { entity: b, local: { x: 0, y: 0, z: -0.25 } }, { entity: vineCoil, lengthM: 1 }, []);
    const sinew = w.joints.lash({ entity: b, local: { x: 0, y: 0, z: 0.25 } }, { entity: c, local: { x: 0, y: 0, z: -0.25 } }, { entity: sinewCoil, lengthM: 1 }, []);
    w.step();
    const ea = ent(w, a);
    const eb = ent(w, b);
    expect(Eb(ea)).toBeCloseTo(1500, 6);
    w.breaking.hit(ea, 550, ea.pose.p, null);
    expect(w.joints.get(vine)).toBeDefined();
    w.breaking.hit(eb, 700, eb.pose.p, null);
    expect(w.events.length).toBeGreaterThan(0);
    expect(w.joints.get(vine)).toBeUndefined();
    expect(w.joints.get(sinew)).toBeDefined(); // 700 J < 1,800 J
    const snap = jointEvents(w.events).find((x) => x.joint === vine)!;
    expect(snap.what).toBe('snap');
    expect(snap.point).toBeDefined();
    expect([ea.integrity, eb.integrity]).toEqual([1, 1]);
    expect(ea.joints).toEqual([]);
    expect(eb.joints).toEqual([sinew]);
  });

  it('an anchored stake struck with more than capacity × loadLeverM (1,200 N × 0.1 m = 120 J) is knocked loose', async () => {
    const w = await make();
    const s = spawnLog(w, { p: { x: 0, y: 0.45, z: 0 }, q: UPRIGHT, length: 1.2, mass: 6, state: 'anchored' });
    run(w, 5);
    const e = ent(w, s);
    expect(e.state).toBe('anchored');
    const knock = e.anchor!.capacityN * BREAK_TUNING.loadLeverM;
    expect(knock).toBeCloseTo(120, 6);
    w.breaking.hit(e, 0.9 * knock, e.pose.p, null);
    expect(e.state).toBe('anchored');
    w.breaking.hit(e, 1.05 * knock, e.pose.p, null);
    expect(e.state).toBe('free');
    expect(e.anchor).toBeNull();
    expect(e.integrity).toBe(1); // 126 J < E_b = 180 J
    expect(e.body!.isDynamic()).toBe(true);
  });

  it('a stake knocked loose, or broken where it was driven, is lifted out of the ground and never falls through it', async () => {
    // Driven 0.15 m into the heightfield, a loose stake (or splinter) fell through it at about half of these spots.
    const spots = [
      [0, 0],
      [0.13, 0.04],
      [0.06, 0.19],
      [5.1, 5.1],
    ];
    for (const [x, z] of spots) {
      for (const times of [1.05, 4]) {
        const w = await make();
        const s = spawnLog(w, { p: { x, y: 0.45, z }, q: UPRIGHT, length: 1.2, mass: 6, state: 'anchored' });
        run(w, 3);
        const e = ent(w, s);
        const knock = Math.max(e.anchor!.capacityN * BREAK_TUNING.loadLeverM, Eb(e));
        w.breaking.hit(e, times * knock, { x, y: 0.9, z }, null);
        expect(e.state).toBe('free');
        // Its lowest point is on the surface now.
        expect(Math.min(...[-0.6, 0.6].map((t) => worldOf(e, { x: 0, y: t, z: 0 }).y))).toBeCloseTo(0, 3);
        const ev = run(w, 240);
        const ids = times > 2 ? breaks(ev).flatMap((b) => b.pieces) : [s];
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(ent(w, id).pose.p.y, `${x},${z} ×${times} entity ${id}`).toBeGreaterThan(0);
      }
    }
  });

  it('a broken entity’s rope ends lie loose where they were; its other joints are released', async () => {
    const w = await make();
    const post = spawnBox(w, { p: { x: 0, y: 3, z: 0 }, size: [0.4, 0.4, 0.4], material: 'dryWood', state: 'fixed', look: 'scaffold' });
    const a = groundLog(w, 0, 0, 5, 2);
    const b = groundLog(w, 0, 0.5, 5, 2);
    run(w, 20);
    const ea = ent(w, a);
    const ropeCoil = spawnRopeCoil(w, { at: { x: 10, y: 0, z: 10 }, material: 'vine', lengthM: 4 });
    const lashCoil = spawnRopeCoil(w, { at: { x: 12, y: 0, z: 10 }, material: 'vine', lengthM: 1 });
    const end = { x: 0.8, y: 0, z: 0 };
    const rope = w.joints.rope({ entity: post, local: { x: 0, y: -0.2, z: 0 } }, { entity: a, local: end }, 3.5, { entity: ropeCoil, lengthM: 3.5 }, []);
    const lash = w.joints.lash({ entity: a, local: { x: 0, y: 0, z: 0.25 } }, { entity: b, local: { x: 0, y: 0, z: -0.25 } }, { entity: lashCoil, lengthM: 1 }, []);
    run(w, 120); // at rest, so the end is where the next step leaves it
    expect(ea.restTicks).toBeGreaterThan(30);
    const at = worldOf(ea, end);
    // 300 J, twice E_b and below the lashing's 600 J: it breaks in phase 12 with its joints still on it.
    w.breaking.hit(ea, 2 * Eb(ea), ea.pose.p, null);
    w.step();
    expect(breaks(w.events).map((x) => x.entity)).toEqual([a]);
    const je = jointEvents(w.events);
    expect(je.map((x) => [x.joint, x.what])).toEqual([
      [rope, 'loose'],
      [lash, 'release'],
    ]);
    const r = w.joints.get(rope)!;
    expect(r.b.entity).toBeNull();
    expect(r.b.loose).toBe(true);
    expect(len(sub(r.b.local, at))).toBeLessThan(1e-3);
    expect(w.joints.get(lash)).toBeUndefined();
    expect(ent(w, b).joints).toEqual([]);
    expect(ent(w, post).joints).toEqual([rope]);
  });
});

// ---------------------------------------------------------------------------
// Load breaks
// ---------------------------------------------------------------------------

describe('load breaks (§4.10, RT-7)', () => {
  it('a load break snaps across the long axis at the load point: 2 pieces, 3 for two load points more than loadPointSplitM apart; it beats an impact break in the same tick', async () => {
    const w = await make();
    const one = groundLog(w, 0, -3, 20, 4);
    const two = groundLog(w, 0, 0, 20, 4);
    const near = groundLog(w, 0, 3, 20, 4);
    const both = groundLog(w, 0, 6, 20, 4);
    run(w, 30);
    const [e1, e2, e3, e4] = [one, two, near, both].map((id) => ent(w, id));
    const along = (e: Entity, t: number): V3 => worldOf(e, { x: 0, y: t, z: 0 }); // the prism's axis is local y
    w.breaking.loadBreak(e1, along(e1, 1), { kind: 'fighter', id: 9, part: 'kcc' });
    w.breaking.loadBreak(e2, along(e2, -1), null);
    w.breaking.loadBreak(e2, along(e2, 0.8), null); // 1.8 m from the first: a third piece
    w.breaking.loadBreak(e3, along(e3, 0.4), null);
    w.breaking.loadBreak(e3, along(e3, 0.7), null); // 0.3 m from the first: still 2 pieces
    w.breaking.hit(e4, 10 * Eb(e4), e4.pose.p, null); // an impact break (4 pieces)…
    w.breaking.loadBreak(e4, along(e4, -1.5), null); // …overridden by the load break in the same tick
    w.breaking.hit(e4, 10 * Eb(e4), e4.pose.p, null); // and a later impact doesn't take it back
    const masses = [e1, e2, e3, e4].map((e) => e.mass);
    w.step();
    const ev = breaks(w.events);
    expect(ev.map((x) => [x.entity, x.pieces.length])).toEqual([
      [one, 2],
      [two, 3],
      [near, 2],
      [both, 2],
    ]);
    // Each piece's share of the mass is its length's share of the 4 m log (cuts at 3 / 1, 1 / 1.8 / 1.2, 2.4 / 1.6, 0.5 / 3.5).
    const shares = ev.map((x) => x.pieces.map((id) => ent(w, id).mass));
    const want = [
      [3 / 4, 1 / 4],
      [1 / 4, 1.8 / 4, 1.2 / 4],
      [2.4 / 4, 1.6 / 4],
      [0.5 / 4, 3.5 / 4],
    ];
    shares.forEach((s, i) => s.forEach((m, k) => expect(m / masses[i]).toBeCloseTo(want[i][k], 3)));
    // The pieces lie end to end along the parent's axis, the cut where the load was.
    const p1 = ev[0].pieces.map((id) => ent(w, id));
    expect(p1[0].pose.p.x).toBeCloseTo(-0.5, 2);
    expect(p1[1].pose.p.x).toBeCloseTo(1.5, 2);
    // A load break's breaker is the loader: its pieces' grace names it.
    expect(p1[0].grace?.from).toEqual({ kind: 'fighter', id: 9, part: 'kcc' });
    expect(ev[1].energy).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Grace until clear (RF-7)
// ---------------------------------------------------------------------------

describe('grace until clear (RF-7)', () => {
  it('pieces broken inside a giant’s body ignore it and fall through it as if it weren’t there; their grace ends once they are clear, not at minUntil', async () => {
    // The same break twice: inside the giant's body, and with no giant (the control).
    const giant: Owner = { kind: 'fighter', id: 77, part: 'ruler', bone: 'chest' };
    const scene = async (withGiant: boolean) => {
      const w = await make();
      // A log held up in a fixed scaffold at 2 m (r 0.12 m), its whole upper half inside the giant's body (from 1.7 m up).
      const log = spawnLog(w, { p: { x: 0, y: 2, z: 0 }, length: 2, r: 0.12, state: 'fixed' });
      if (withGiant) giantBox(w, 77, { x: 0, y: 2.6, z: 0 }, { x: 1.5, y: 0.9, z: 1.5 });
      run(w, 2);
      const e = ent(w, log);
      w.breaking.hit(e, 3 * Eb(e), e.pose.p, giant);
      w.step();
      const ev = breaks(w.events);
      expect(ev).toHaveLength(1);
      return { w, t0: w.tick, pieces: ev[0].pieces.map((id) => ent(w, id)) };
    };
    const inside = await scene(true);
    const control = await scene(false);
    const { w, t0, pieces } = inside;
    expect(pieces.map((p) => p.id)).toEqual(control.pieces.map((p) => p.id));
    for (const p of pieces) {
      expect(p.grace).toEqual({ from: giant, minUntil: t0 + BREAK_TUNING.pieceGraceTicks, maxUntil: t0 + BREAK_TUNING.pieceGraceMaxTicks });
      expect(meetsRulerSolid(p.collider!)).toBe(false);
    }
    const graceEnd = new Map<number, number>();
    for (let i = 0; i < 120 && graceEnd.size < pieces.length; i++) {
      w.step();
      control.w.step();
      pieces.forEach((p, k) => {
        if (graceEnd.has(p.id)) return;
        if (p.grace === null) {
          graceEnd.set(p.id, w.tick);
          expect(meetsRulerSolid(p.collider!)).toBe(true);
          return;
        }
        // Inside the giant, nothing pushes it: it moves exactly as it does with no giant there.
        const twin = control.pieces[k];
        expect(len(sub(p.vel.lin, twin.vel.lin))).toBeLessThan(1e-4);
        expect(len(sub(p.pose.p, twin.pose.p))).toBeLessThan(1e-4);
      });
    }
    expect(graceEnd.size).toBe(pieces.length);
    for (const p of pieces) {
      // Still inside at minUntil (every piece holds the log's axis at 2 m and had fallen ≈ 0.15 m by then), so the
      // grace outlived the minimum; it ended when the piece was clear of the body's underside.
      expect(graceEnd.get(p.id)!).toBeGreaterThan(t0 + BREAK_TUNING.pieceGraceTicks);
      expect(w.entities.get(p.id)).toBe(p);
    }
  });

  it('a broken stake under the lying giant stays non-colliding with it and is crushed at pieceGraceMaxTicks (a break event with no pieces)', async () => {
    const w = await make();
    const s = spawnLog(w, { p: { x: 0, y: 0.45, z: 0 }, q: UPRIGHT, length: 1.2, mass: 6, state: 'anchored' });
    run(w, 3);
    // The giant lies over the stake, its body reaching into the ground.
    const giant: Owner = { kind: 'fighter', id: 77, part: 'ruler', bone: 'chest' };
    giantBox(w, 77, { x: 0, y: 0.6, z: 0 }, { x: 1.5, y: 1.0, z: 1.5 });
    w.step();
    // The 9c hit and the phase-12 split of the tick the giant landed (the stake is never a free body in between).
    const e = ent(w, s);
    w.breaking.hit(e, 4 * Eb(e), { x: 0, y: 0.9, z: 0 }, giant);
    expect(e.state).toBe('free');
    w.breaking.update(w);
    const ev = breaks(w.events);
    expect(ev.map((x) => x.entity)).toEqual([s]);
    const t0 = w.tick;
    const pieces = ev[0].pieces;
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    const crushed = new Map<number, number>();
    for (let i = 0; i < BREAK_TUNING.pieceGraceMaxTicks + 5; i++) {
      w.step();
      for (const x of breaks(w.events)) {
        expect(x.pieces).toEqual([]);
        crushed.set(x.entity, w.tick);
      }
      for (const id of pieces) {
        const p = w.entities.get(id);
        if (!p) continue;
        expect(p.grace?.from).toEqual(giant);
        expect(meetsRulerSolid(p.collider!)).toBe(false);
        // Never depenetrated out of the giant into a launch.
        expect(len(p.vel.lin)).toBeLessThan(8);
      }
    }
    expect([...crushed.keys()]).toEqual(pieces);
    for (const id of pieces) {
      expect(crushed.get(id)).toBe(t0 + BREAK_TUNING.pieceGraceMaxTicks);
      expect(w.entities.get(id)).toBeUndefined();
    }
  });

  it('the pipeline: a stone dropped on a rotten stick breaks it in the impact tick; the pieces’ grace names the stone', async () => {
    const w = await make();
    const stick = spawnStick(w, { p: { x: 0, y: 0.1, z: 0 }, length: 1.5, r: 0.04, material: 'rottenWood' });
    run(w, 30);
    const stone = spawnStone(w, { p: { x: 0, y: 3, z: 0 }, mass: 40 });
    let ev: BreakEvent[] = [];
    for (let i = 0; i < 120 && ev.length === 0; i++) {
      w.step();
      ev = breaks(w.events);
    }
    expect(ev.map((x) => x.entity)).toEqual([stick]);
    expect(ev[0].energy).toBeGreaterThan(Eb({ material: 'rottenWood', mass: 1 } as Entity));
    for (const id of ev[0].pieces) expect(ent(w, id).grace?.from).toEqual({ kind: 'entity', id: stone });
  });
});
