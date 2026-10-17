// The entity store (docs/M1-DESIGN.md §1.5.7, §2.3, §3 phases 4d and 18, §8.3; package P06): bodies created and removed
// in id order, the body each state gets, anchoring and isAnchored (joint records only: the joint store is P10's, so the
// tests hand the store joint records through a stand-in `joints.get`), the impulse queue applied in phase 4d of the
// next step in id order, the mirror, rest, sleep and determinism, `touched`, release, keep-awake, reshape and the save
// records.
//
// Scene numbers (masses, the 500 N push, the prop geometry) are test constants, never tuning (§9), so a tuning change
// can't move a margin silently.
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EntityRecV1 } from '../src/save/schema';
import { DT, Rng } from '../src/sim/math';
import { reducedMass } from '../src/sim/rules';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { ENTITY_TUNING } from '../src/world/entities';
import { collisionGroups, pieceGraceCollisionGroups, solverGroups } from '../src/world/groups';
import { MATERIALS } from '../src/world/materials';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import { shapeVolume } from '../src/world/shapes';
import type { Anchor, Entity, EntitySpec, JointKind, JointRecord, MaterialId, Pose3, Quat, Shape, V3 } from '../src/world/types';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

/**
 * This file's time limit (Vitest's default is 5 s). The longest test steps two worlds 1,200 ticks (about 1 s alone);
 * on a loaded machine running every package's tests at once it took 7 s. §11's convention for long tests is an explicit
 * timeout.
 */
vi.setConfig({ testTimeout: 60_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', player: false, size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('PHYSICS_TUNING');
  resetTuning('ENTITY_TUNING');
  resetTuning('WORLD_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

const deg = (rad: number): number => (rad * 180) / Math.PI;

/** The circumradius of an N-gon prism of `length` with mass `massKg` of a material of `density`. */
function prismR(massKg: number, density: number, length: number, sides: number): number {
  const area = massKg / density / length;
  return Math.sqrt(area / ((sides / 2) * Math.sin((2 * Math.PI) / sides)));
}

/** A rotation of `angle` rad about a unit axis. */
function axisAngle(ax: V3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(angle / 2) };
}

/** Lying along world z (the prism's axis is local +y). */
const LYING_Z: Quat = axisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);

/** The angle between an entity's local +y and world +y, degrees. */
function tiltDeg(q: Quat): number {
  const y = 1 - 2 * (q.x * q.x + q.z * q.z);
  return deg(Math.acos(Math.max(-1, Math.min(1, y))));
}

/** The angle between two rotations, degrees. */
function turnDeg(a: Quat, b: Quat): number {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return deg(2 * Math.acos(Math.min(1, d)));
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
const f32 = (v: V3): V3 => ({ x: Math.fround(v.x), y: Math.fround(v.y), z: Math.fround(v.z) });

function prism(material: MaterialId, o: { length: number; r: number; sides: number; p: V3; q?: Quat; state?: EntitySpec['state']; generated?: boolean; look?: string }): EntitySpec {
  return {
    material,
    shape: { kind: 'cylinder', halfHeight: o.length / 2, r: o.r, sides: o.sides },
    p: o.p,
    q: o.q,
    state: o.state,
    generated: o.generated,
    look: o.look ?? 'log',
  };
}

function box(material: MaterialId, half: [number, number, number], p: V3, o: { state?: EntitySpec['state']; generated?: boolean; q?: Quat } = {}): EntitySpec {
  return { material, shape: { kind: 'box', hx: half[0], hy: half[1], hz: half[2] }, p, q: o.q, state: o.state, generated: o.generated, look: 'box' };
}

/** An icosahedral stone hull of `massKg`, resting on a face (a face's normal turned onto −y), local points. */
function icosahedron(massKg: number, density: number): { points: number[]; bottom: number } {
  const ph = (1 + Math.sqrt(5)) / 2;
  const raw: [number, number, number][] = [
    [-1, ph, 0], [1, ph, 0], [-1, -ph, 0], [1, -ph, 0], [0, -1, ph], [0, 1, ph], [0, -1, -ph], [0, 1, -ph], [ph, 0, -1], [ph, 0, 1], [-ph, 0, -1], [-ph, 0, 1],
  ];
  const n = Math.hypot(1, ph);
  // The face (−1,−φ,0), (1,−φ,0), (0,−1,−φ) has its outward normal along (0, −(2φ+1), −φ): turn it onto −y about x.
  const ang = Math.atan2(-ph, 2 * ph + 1);
  const volUnit = (5 / 12) * (3 + Math.sqrt(5)) * (2 / n) ** 3; // circumradius 1, edge 2/n
  const R = Math.cbrt(massKg / density / volUnit);
  const points: number[] = [];
  for (const [a, b, c] of raw) {
    const y = b / n;
    const z = c / n;
    points.push((a / n) * R, (y * Math.cos(ang) + z * Math.sin(ang)) * R, (-y * Math.sin(ang) + z * Math.cos(ang)) * R);
  }
  let bottom = Infinity;
  for (let i = 1; i < points.length; i += 3) bottom = Math.min(bottom, points[i]);
  return { points, bottom: -bottom };
}

/** The slot index of a Rapier handle (handles are f64 bit casts of [u32 index, u32 generation], MAP rapier §1). */
function slotOf(handle: number): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, handle, true);
  return dv.getUint32(0, true);
}

/** The body's own pose (the f32 values Rapier holds). */
function bodyPose(e: Entity): Pose3 {
  const t = e.body!.translation();
  const r = e.body!.rotation();
  return { p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w } };
}

/** A downward ray at (x, z): the owner it meets first (entities and terrain). */
function rayDown(w: World, x: number, z: number): string {
  const hit = w.queries.castRay({ x, y: 20, z }, { x: 0, y: -1, z: 0 }, 40, {});
  if (!hit) return 'none';
  return hit.owner.kind === 'entity' ? `entity:${hit.owner.id}` : hit.owner.kind;
}

/**
 * A stand-in for the joint store's records (P10 fills JointStore): `joints.get` answers from the returned map, and
 * `join` adds a record and lists it on its entities, as JointStore will.
 */
function fakeJoints(w: World): { records: Map<number, JointRecord>; join: (kind: JointKind, a: Anchor, b: Anchor) => number } {
  const records = new Map<number, JointRecord>();
  (w.joints as { get: (id: number) => JointRecord | undefined }).get = (id) => records.get(id);
  let next = 1;
  const join = (kind: JointKind, a: Anchor, b: Anchor): number => {
    const id = next++;
    records.set(id, { id, kind, a, b, rope: null, breakEnergyJ: Infinity, axis: null, limits: null, motor: null, holdsBend: null, tension: [0, 0, 0], pullN: 0, credit: [] });
    for (const end of [a, b]) {
      if (end.entity === null) continue;
      const e = w.entities.get(end.entity)!;
      e.joints.push(id);
      e.joints.sort((x, y) => x - y);
    }
    return id;
  };
  return { records, join };
}

const at = (entity: number | null): Anchor => ({ entity, local: { x: 0, y: 0, z: 0 } });

/** Everything the mirror writes, as exact text. */
function mirrorText(w: World): string {
  return JSON.stringify(w.entities.all().map((e) => [e.id, e.pose, e.prevPose, e.vel, e.restTicks, e.touched, e.age, e.body?.isSleeping() ?? null]));
}

// ---------------------------------------------------------------------------
// Creation and removal
// ---------------------------------------------------------------------------

describe('creation and removal', () => {
  it('creates entities and their bodies in id order and removes them; ids are never reused', async () => {
    const w = await make();
    const specs: EntitySpec[] = [
      prism('dryWood', { length: 2, r: 0.15, sides: 6, p: { x: 0, y: 0.2, z: 0 }, q: LYING_Z }),
      prism('greenWood', { length: 1, r: 0.04, sides: 8, p: { x: 2, y: 0.2, z: 0 }, state: 'anchored', look: 'stake' }),
      box('dryWood', [0.5, 0.25, 0.5], { x: -2, y: 0.25, z: 0 }, { state: 'fixed' }),
      box('stone', [0.2, 0.2, 0.2], { x: 0, y: 0.2, z: 3 }),
    ];
    const made = specs.map((s) => w.entities.create(s));
    expect(made.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(w.entities.all().map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(w.physics.rapier.bodies.len()).toBe(4);
    // Rapier's arena gives the bodies their slots in creation order.
    const slots = made.map((e) => slotOf(e.body!.handle));
    expect(slots).toEqual([...slots].sort((a, b) => a - b));
    expect(new Set(slots).size).toBe(4);
    for (const e of made) {
      expect(w.entities.get(e.id)).toBe(e);
      expect(w.physics.ownerOf(e.collider!.handle)).toEqual({ kind: 'entity', id: e.id });
      expect(e.collider!.collisionGroups()).toBe(collisionGroups('ENTITY'));
      expect(e.collider!.solverGroups()).toBe(solverGroups('ENTITY'));
    }
    expect(w.events).toEqual(made.map((e) => ({ type: 'spawn', entity: e.id })));

    // all() is a snapshot: creating or removing while iterating it is safe.
    const before = w.entities.all();
    w.entities.remove(2);
    expect(before.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(w.entities.all().map((e) => e.id)).toEqual([1, 3, 4]);
    expect(w.entities.get(2)).toBeUndefined();
    expect(w.physics.rapier.bodies.len()).toBe(3);
    expect(made[1].body).toBeNull();
    expect(w.events.at(-1)).toEqual({ type: 'remove', entity: 2 });
    expect(() => w.entities.remove(2)).toThrow(/no entity 2/);
    expect(() => w.removeEntity(99)).toThrow(/no entity 99/);

    const again = w.entities.create(box('stone', [0.2, 0.2, 0.2], { x: 3, y: 0.2, z: 3 }));
    expect(again.id).toBe(5);
    expect(w.addEntity(box('stone', [0.2, 0.2, 0.2], { x: 4, y: 0.2, z: 3 }))).toBe(6);
    expect(w.entities.all().map((e) => e.id)).toEqual([1, 3, 4, 5, 6]);
    expect(w.entities.removedGenerated()).toEqual([]);
  });

  it('two worlds that create and remove the same entities in the same order stay bit-identical', async () => {
    const run = async (): Promise<string[]> => {
      const w = await make();
      const out: string[] = [];
      for (let t = 0; t < 180; t++) {
        if (t % 20 === 0) w.entities.create(prism('dryWood', { length: 1.5, r: 0.12, sides: 6, p: { x: (t / 20) * 0.3 - 1, y: 1 + t / 100, z: 0.1 * (t % 3) }, q: axisAngle({ x: 0, y: 0, z: 1 }, 1.2 + t / 50) }));
        if (t === 90 || t === 130) w.entities.remove(w.entities.all()[1].id);
        w.step();
        if (t % 30 === 29) out.push(mirrorText(w));
      }
      return out;
    };
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
  });

  it('a free entity is a dynamic body: density × volume, +4 solver iterations, damping, events, f32 record', async () => {
    const w = await make();
    const spec = prism('dryWood', { length: 2.2, r: prismR(40, MATERIALS.dryWood.density, 2.2, 6), sides: 6, p: { x: 0.1, y: 0.3, z: 0.7 }, q: LYING_Z });
    const log = w.entities.create(spec, ['p2', 'p1']);
    expect(log.state).toBe('free');
    expect(log.mass).toBeCloseTo(40, 9);
    expect(log.mass).toBe(MATERIALS.dryWood.density * shapeVolume(spec.shape));
    expect(log.body!.mass()).toBeCloseTo(40, 3); // Rapier's f32 mass from the collider's density
    expect(log.body!.isDynamic()).toBe(true);
    expect(log.body!.additionalSolverIterations()).toBe(PHYSICS_TUNING.entityExtraSolverIters);
    expect(PHYSICS_TUNING.entityExtraSolverIters).toBe(4);
    expect(log.body!.linearDamping()).toBe(Math.fround(PHYSICS_TUNING.entityLinDamp));
    expect(log.body!.angularDamping()).toBe(Math.fround(PHYSICS_TUNING.entityAngDamp));
    expect(log.collider!.activeEvents()).toBe(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    expect(log.collider!.contactForceEventThreshold()).toBe(PHYSICS_TUNING.forceEventThresholdN);
    expect(log.collider!.friction()).toBe(Math.fround(MATERIALS.dryWood.friction));
    // The record holds the f32 pose Rapier holds from the start.
    expect(log.pose.p).toEqual(f32(spec.p));
    expect(log.pose).toEqual(bodyPose(log));
    expect(log.prevPose).toEqual(log.pose);
    expect(log.prevPose).not.toBe(log.pose);
    expect(log.credit).toEqual(['p1', 'p2']);
    expect([log.integrity, log.moisture, log.burning, log.age, log.restTicks, log.touched, log.generated]).toEqual([1, 0, false, 0, 0, false, false]);
    expect(log.loadHist.length).toBe(12);
    expect(log.joints).toEqual([]);

    const fixed = w.entities.create(box('dryWood', [1, 0.1, 1], { x: 5, y: 0.1, z: 5 }, { state: 'fixed' }));
    expect(fixed.body!.isFixed()).toBe(true);
    expect(fixed.collider!.activeEvents()).toBe(RAPIER.ActiveEvents.COLLISION_EVENTS);
    expect(fixed.vel).toEqual({ lin: { x: 0, y: 0, z: 0 }, ang: { x: 0, y: 0, z: 0 } });

    // A rotation is stored as a unit quaternion.
    const turned = w.entities.create(box('stone', [0.1, 0.1, 0.1], { x: -5, y: 0.1, z: 5 }, { q: { x: 0, y: 2, z: 0, w: 2 } }));
    expect(Math.hypot(turned.pose.q.x, turned.pose.q.y, turned.pose.q.z, turned.pose.q.w)).toBeCloseTo(1, 6);
    expect(turnDeg(turned.pose.q, axisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2))).toBeLessThan(0.1); // f32, through acos
  });

  it('refuses a bad spec without spending an id', async () => {
    const w = await make();
    const next = w.ids.entity.next;
    expect(() => w.entities.create({ ...box('stone', [0.1, 0.1, 0.1], { x: 0, y: 1, z: 0 }), material: 'adamant' as MaterialId })).toThrow(/unknown material/);
    expect(() => w.entities.create(box('stone', [0, 0.1, 0.1], { x: 0, y: 1, z: 0 }))).toThrow(/no volume/);
    expect(() => w.entities.create(box('stone', [0.1, 0.1, 0.1], { x: NaN, y: 1, z: 0 }))).toThrow(/non-finite/);
    expect(() => w.entities.create(box('stone', [0.1, 0.1, 0.1], { x: 0, y: 1, z: 0 }, { q: { x: 0, y: 0, z: 0, w: 0 } }))).toThrow(/quaternion/);
    expect(() => w.entities.create({ ...box('stone', [0.1, 0.1, 0.1], { x: 0, y: 1, z: 0 }), integrity: 2 })).toThrow(/integrity/);
    expect(w.ids.entity.next).toBe(next);
    expect(w.entities.all()).toHaveLength(0);
  });

  it('turns CCD on for small, thrown and falling bodies, in phase 4d', async () => {
    const w = await make();
    const stick = w.entities.create(prism('dryWood', { length: 1.2, r: 0.03, sides: 8, p: { x: 0, y: 0.05, z: 0 }, q: LYING_Z }));
    const log = w.entities.create(prism('dryWood', { length: 2, r: 0.25, sides: 6, p: { x: 3, y: 0.25, z: 0 }, q: LYING_Z }));
    const trunk = w.entities.create({ ...prism('greenWood', { length: 6, r: 0.2, sides: 8, p: { x: -3, y: 3, z: 0 } }), plant: { diameter: 0.4, height: 6 } });
    expect(stick.body!.isCcdEnabled()).toBe(true); // half-extent 0.03 m < ccdMinHalfExtent
    expect(log.body!.isCcdEnabled()).toBe(false);
    expect(trunk.body!.isCcdEnabled()).toBe(false);
    log.thrown = { by: 1, tick: w.tick };
    trunk.plant!.phase = 'falling';
    expect(log.body!.isCcdEnabled()).toBe(false); // switched in the next phase 4d
    w.step();
    expect(log.body!.isCcdEnabled()).toBe(true);
    expect(trunk.body!.isCcdEnabled()).toBe(true);
    log.thrown = null;
    trunk.plant!.phase = 'felled';
    w.step();
    expect(log.body!.isCcdEnabled()).toBe(false);
    expect(trunk.body!.isCcdEnabled()).toBe(false);
    expect(stick.body!.isCcdEnabled()).toBe(true);
  });

  it('gives live PHYSICS_TUNING edits to existing bodies at the next phase 4d', async () => {
    const w = await make();
    const log = w.entities.create(prism('dryWood', { length: 2, r: 0.2, sides: 6, p: { x: 0, y: 0.2, z: 0 }, q: LYING_Z }));
    setTuningValue('PHYSICS_TUNING', 'entityAngDamp', 0.5);
    setTuningValue('PHYSICS_TUNING', 'entityExtraSolverIters', 6);
    expect(log.body!.angularDamping()).toBe(Math.fround(0.1));
    w.step();
    expect(log.body!.angularDamping()).toBe(Math.fround(0.5));
    expect(log.body!.additionalSolverIterations()).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

describe('anchoring', () => {
  it('an anchored stake is a fixed body, static for m_eff, holding its anchor capacity', async () => {
    const w = await make();
    const stake = w.entities.create(prism('greenWood', { length: 1, r: 0.04, sides: 8, p: { x: 0, y: 0.2, z: 0 }, state: 'anchored', look: 'stake' }));
    expect(stake.state).toBe('anchored');
    expect(stake.anchor).toEqual({ depthM: VERB_TUNING.stakeAnchorDepthM, capacityN: VERB_TUNING.stakeAnchorDepthM * VERB_TUNING.anchorHoldNPerM });
    expect(stake.anchor).toEqual({ depthM: 0.3, capacityN: 1200 });
    expect(stake.body!.isFixed()).toBe(true);
    expect(stake.body!.effectiveInvMass()).toEqual({ x: 0, y: 0, z: 0 });
    expect(w.entities.isAnchored(stake)).toBe(true);
    // Static for m_eff (§4.3): a bone meeting it keeps its own mass.
    const mEff = reducedMass(4.5, w.entities.isAnchored(stake) ? Infinity : stake.mass);
    expect(mEff).toBe(4.5);

    // Its queued impulse is dropped, and a 300 kg log laid across it doesn't move it (set down from 2 cm: dropped from
    // 0.5 m, ≈ 1.5 kJ beats capacity × loadLeverM = 120 J and knocks the stake loose, §2.3, P10).
    const pose = structuredClone(stake.pose);
    w.entities.queueImpulse(stake.id, { x: 500, y: 0, z: 0 }, null);
    const r = prismR(300, MATERIALS.greenWood.density, 3, 6);
    w.entities.create(prism('greenWood', { length: 3, r, sides: 6, p: { x: 0, y: 0.7 + r + 0.02, z: 0 }, q: LYING_Z }));
    for (let t = 0; t < 120; t++) w.step();
    expect(w.entities.pendingImpulses()).toEqual([]);
    expect(stake.pose).toEqual(pose);
    expect(stake.vel).toEqual({ lin: { x: 0, y: 0, z: 0 }, ang: { x: 0, y: 0, z: 0 } });

    // Pulled loose: dynamic, awake, no anchor, not resting ground any more; an impulse moves it now.
    expect(stake.restTicks).toBeGreaterThanOrEqual(120);
    w.entities.unanchor(stake);
    expect(stake.restTicks).toBe(0);
    expect(stake.state).toBe('free');
    expect(stake.anchor).toBeNull();
    expect(stake.body!.isDynamic()).toBe(true);
    expect(stake.body!.isSleeping()).toBe(false);
    expect(stake.body!.additionalSolverIterations()).toBe(PHYSICS_TUNING.entityExtraSolverIters);
    expect(stake.collider!.activeEvents()).toBe(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    expect(stake.body!.mass()).toBeCloseTo(stake.mass, 3);
    expect(w.entities.isAnchored(stake)).toBe(false);
    expect(stake.touched).toBe(true);
  });

  it('anchor() drives a free stake: fixed body, depth × anchorHoldNPerM, velocities zero', async () => {
    const w = await make();
    const stake = w.entities.create(prism('greenWood', { length: 1, r: 0.04, sides: 8, p: { x: 0, y: 0.8, z: 0 } }));
    w.step();
    expect(stake.vel.lin.y).toBeLessThan(0);
    w.entities.anchor(stake, 0.45);
    expect(stake.state).toBe('anchored');
    expect(stake.anchor!.depthM).toBe(0.45);
    expect(stake.anchor!.capacityN).toBeCloseTo(1800, 9);
    expect(stake.body!.isFixed()).toBe(true);
    expect(stake.vel).toEqual({ lin: { x: 0, y: 0, z: 0 }, ang: { x: 0, y: 0, z: 0 } });
    expect(stake.collider!.activeEvents()).toBe(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const pose = structuredClone(stake.pose);
    for (let t = 0; t < 30; t++) w.step();
    expect(stake.pose).toEqual(pose);
    expect(() => w.entities.anchor(stake, 0)).toThrow(/bad depth/);
    // setState('anchored') keeps the depth; leaving 'anchored' clears it.
    w.entities.setState(stake, 'free');
    expect(stake.anchor).toBeNull();
    w.entities.setState(stake, 'anchored');
    expect(stake.anchor).toEqual({ depthM: 0.3, capacityN: 1200 });
  });

  it('a log lashed (or hinged) to an anchored stake is anchored, through at most anchorJoinDepth joints (records only)', async () => {
    const w = await make();
    const { join } = fakeJoints(w);
    const mk = (x: number, state?: EntitySpec['state']): Entity =>
      w.entities.create(prism('dryWood', { length: 1, r: 0.1, sides: 6, p: { x, y: 0.1, z: 0 }, q: LYING_Z, state }));
    const stake = mk(0, 'anchored');
    const log = mk(2);
    expect(w.entities.isAnchored(log)).toBe(false);
    join('lash', at(log.id), at(stake.id));
    expect(w.entities.isAnchored(log)).toBe(true);
    // Whatever its mass: a staked log is static for m_eff (SPEC:781, 879).
    expect(reducedMass(9, w.entities.isAnchored(log) ? Infinity : log.mass)).toBe(9);

    // A chain: stake — a — b — c — d, each lashed to the last.
    const a = mk(4);
    const b = mk(6);
    const c = mk(8);
    const d = mk(10);
    join('hinge', at(stake.id), at(a.id));
    join('lash', at(a.id), at(b.id));
    join('lash', at(c.id), at(b.id));
    join('lash', at(c.id), at(d.id));
    expect([a, b, c, d].map((e) => w.entities.isAnchored(e))).toEqual([true, true, true, false]);
    ENTITY_TUNING.anchorJoinDepth = 4; // live
    expect(w.entities.isAnchored(d)).toBe(true);
    ENTITY_TUNING.anchorJoinDepth = 3;

    // Rope and bend joints, held ends and loose ends never anchor; a lash to a world point joins the world itself.
    const e1 = mk(-2);
    const e2 = mk(-4);
    const e3 = mk(-6);
    const e4 = mk(-8);
    join('rope', at(e1.id), at(stake.id));
    join('bend', at(e2.id), at(stake.id));
    join('lash', at(e3.id), { entity: null, local: { x: 0, y: 0, z: 0 }, fighter: 1 });
    join('lash', at(e3.id), { entity: null, local: { x: 0, y: 0, z: 0 }, loose: true });
    expect([e1, e2, e3].map((e) => w.entities.isAnchored(e))).toEqual([false, false, false]);
    join('hinge', at(e4.id), at(null));
    expect(w.entities.isAnchored(e4)).toBe(true);

    // Fixed counts like anchored; free stakes don't.
    const tree = mk(12, 'fixed');
    const f1 = mk(14);
    const f2 = mk(16);
    join('lash', at(f1.id), at(tree.id));
    join('lash', at(f2.id), at(e1.id));
    expect(w.entities.isAnchored(f1)).toBe(true);
    expect(w.entities.isAnchored(f2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Impulses
// ---------------------------------------------------------------------------

describe('impulses', () => {
  it('500 N impulses move a 40 kg log and not an 800 kg hull (no KCC yet)', async () => {
    const w = await make({ size: 200 });
    const rLog = prismR(40, MATERIALS.dryWood.density, 2.2, 6);
    // Lying along z, a flat face down, so a push along x is across it (as a player walks into it).
    const log = w.entities.create(prism('dryWood', { length: 2.2, r: rLog, sides: 6, p: { x: 0, y: rLog * Math.cos(Math.PI / 6) + 0.002, z: 0 }, q: { ...LYING_Z } }));
    const ico = icosahedron(800, MATERIALS.stone.density);
    const stone = w.entities.create({ material: 'stone', shape: { kind: 'hull', points: ico.points }, p: { x: 0, y: ico.bottom + 0.002, z: 8 }, look: 'stone' });
    expect(log.mass).toBeCloseTo(40, 9);
    expect(stone.mass).toBeCloseTo(800, 6);
    for (let t = 0; t < 120; t++) w.step(); // settle
    const log0 = structuredClone(log.pose.p);
    const stone0 = structuredClone(stone.pose.p);
    const push = { x: 500 * DT, y: 0, z: 0 }; // 500 N for one tick, every tick
    for (let t = 0; t < 180; t++) {
      w.entities.queueImpulse(log.id, push, null);
      w.entities.queueImpulse(stone.id, push, null);
      w.step();
    }
    expect(hdist(log.pose.p, log0)).toBeGreaterThan(1);
    expect(hdist(stone.pose.p, stone0)).toBeLessThan(0.01);
  });

  it('queued impulses land in phase 4d of the next step, in entity id order (queue order within one entity)', async () => {
    WORLD_TUNING.gravityY = 0; // bodies in free space
    const w = await make();
    const [b1, b2, b3] = [0, 1, 2].map((k) => w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 3 * k, y: 2, z: 0 })));
    const idOf = new Map([b1, b2, b3].map((e) => [e.body!.handle, e.id]));
    // Every Rapier impulse call, as (entity id, |impulse|), in call order.
    const calls: [number, number][] = [];
    const real = RAPIER.RigidBody.prototype.applyImpulse;
    const realAt = RAPIER.RigidBody.prototype.applyImpulseAtPoint;
    vi.spyOn(RAPIER.RigidBody.prototype, 'applyImpulse').mockImplementation(function (this: RAPIER.RigidBody, j, wake) {
      calls.push([idOf.get(this.handle)!, Math.hypot(j.x, j.y, j.z)]);
      real.call(this, j, wake);
    });
    vi.spyOn(RAPIER.RigidBody.prototype, 'applyImpulseAtPoint').mockImplementation(function (this: RAPIER.RigidBody, j, p, wake) {
      calls.push([idOf.get(this.handle)!, Math.hypot(j.x, j.y, j.z)]);
      realAt.call(this, j, p, wake);
    });
    // Phase 4d is the only place they are applied: count the calls made inside it.
    const inPhase: number[] = [];
    const store = w.entities;
    const apply = store.applyImpulses.bind(store);
    vi.spyOn(store, 'applyImpulses').mockImplementation(() => {
      const n = calls.length;
      apply();
      inPhase.push(calls.length - n);
    });

    w.entities.queueImpulse(b3.id, { x: 3, y: 0, z: 0 }, null);
    w.entities.queueImpulse(b1.id, { x: 1, y: 0, z: 0 }, null);
    w.entities.queueImpulse(b2.id, { x: 2, y: 0, z: 0 }, null);
    w.entities.queueImpulse(b1.id, { x: 0, y: 4, z: 0 }, { x: b1.pose.p.x + 0.2, y: b1.pose.p.y, z: b1.pose.p.z });
    expect(w.entities.pendingImpulses().map((q) => q.id)).toEqual([b3.id, b1.id, b2.id, b1.id]);
    expect(calls).toEqual([]); // nothing applied before the step
    expect(b1.body!.linvel()).toEqual({ x: 0, y: 0, z: 0 });

    w.step();
    expect(calls).toEqual([
      [b1.id, 1],
      [b1.id, 4],
      [b2.id, 2],
      [b3.id, 3],
    ]);
    expect(inPhase).toEqual([4]);
    expect(w.entities.pendingImpulses()).toEqual([]);
    for (const [e, jx] of [[b1, 1], [b2, 2], [b3, 3]] as const) expect(e.vel.lin.x).toBeCloseTo(jx / e.mass, 5);
    expect(b1.vel.lin.y).toBeCloseTo(4 / b1.mass, 5);
    // The impulse at a point off the centre of mass spins b1; the others don't spin.
    expect(Math.abs(b1.vel.ang.z)).toBeGreaterThan(0.1);
    expect(Math.hypot(b2.vel.ang.x, b2.vel.ang.y, b2.vel.ang.z)).toBe(0);
    // Queued once, applied once.
    w.step();
    expect(calls).toHaveLength(4);
  });

  it('drops impulses on held, fixed and removed entities, and refuses unknown ids and non-finite values', async () => {
    WORLD_TUNING.gravityY = 0;
    const w = await make();
    const held = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 0, y: 2, z: 0 }));
    const fixed = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 2, y: 2, z: 0 }, { state: 'fixed' }));
    const gone = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 4, y: 2, z: 0 }));
    const free = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 6, y: 2, z: 0 }));
    const idOf = new Map([held, fixed, gone, free].map((e) => [e.body!.handle, e.id]));
    // Every Rapier impulse call, by entity id.
    const calls: number[] = [];
    const real = RAPIER.RigidBody.prototype.applyImpulse;
    const realAt = RAPIER.RigidBody.prototype.applyImpulseAtPoint;
    vi.spyOn(RAPIER.RigidBody.prototype, 'applyImpulse').mockImplementation(function (this: RAPIER.RigidBody, j, wake) {
      calls.push(idOf.get(this.handle) ?? -1);
      real.call(this, j, wake);
    });
    vi.spyOn(RAPIER.RigidBody.prototype, 'applyImpulseAtPoint').mockImplementation(function (this: RAPIER.RigidBody, j, p, wake) {
      calls.push(idOf.get(this.handle) ?? -1);
      realAt.call(this, j, p, wake);
    });
    w.entities.setState(held, 'held');
    for (const e of [held, fixed, gone, free]) w.entities.queueImpulse(e.id, { x: 5, y: 0, z: 0 }, null);
    w.entities.queueImpulse(fixed.id, { x: 5, y: 0, z: 0 }, { x: 2.1, y: 2, z: 0 });
    w.entities.remove(gone.id);
    w.step();
    // Only the free body got one: nothing reached the held, fixed or removed entity's body.
    expect(calls).toEqual([free.id]);
    expect(w.entities.pendingImpulses()).toEqual([]);
    expect(free.vel.lin.x).toBeGreaterThan(0);
    expect(fixed.pose.p).toEqual(f32({ x: 2, y: 2, z: 0 }));
    expect(() => w.entities.queueImpulse(gone.id, { x: 1, y: 0, z: 0 }, null)).toThrow(/no entity/);
    expect(() => w.entities.queueImpulse(held.id, { x: NaN, y: 0, z: 0 }, null)).toThrow(/non-finite/);
    expect(() => w.entities.queueImpulse(held.id, { x: 1, y: 0, z: 0 }, { x: 0, y: Infinity, z: 0 })).toThrow(/non-finite/);
  });
});

// ---------------------------------------------------------------------------
// The prop (MAP rapier finding 11)
// ---------------------------------------------------------------------------

describe('a 2 kg prop under a 300 kg log', () => {
  /**
   * The C lab's probe with prisms: a 300 kg green-wood hex log, 3 m long, one end on the ground and the other on the
   * top of an upright 2 kg green-wood 8-gon stick 0.8 m tall, overhanging it by 0.25 m. Both start 2 mm clear.
   */
  async function propScene(): Promise<{ w: World; stick: Entity; log: Entity }> {
    const w = await make();
    const rho = MATERIALS.greenWood.density;
    const L = 3;
    const overhang = 0.25;
    const gap = 0.002;
    const rl = prismR(300, rho, L, 6);
    const rs = prismR(2, rho, 0.8, 8);
    const stick = w.entities.create(prism('greenWood', { length: 0.8, r: rs, sides: 8, p: { x: 0, y: 0.4 + gap, z: 0 }, look: 'stick' }));
    // The log's bottom face rests on the stick's top edge nearest the log's lower end (its 157.5° and 202.5° vertices).
    const Q = { x: rs * Math.cos((157.5 * Math.PI) / 180), y: 0.8 + gap };
    const s = L - overhang;
    const th = Math.asin(Q.y / s);
    const d = { x: Math.cos(th), y: Math.sin(th) };
    const down = { x: Math.sin(th), y: -Math.cos(th) }; // the bottom face's outward normal (the prism's local +x)
    const rin = rl * Math.cos(Math.PI / 6);
    const low = { x: Q.x - s * d.x, y: Q.y - s * d.y }; // the bottom face's lower edge, on the ground
    const C = { x: low.x + (L / 2) * d.x - rin * down.x, y: low.y + (L / 2) * d.y - rin * down.y + gap, z: 0 };
    const log = w.entities.create(prism('greenWood', { length: L, r: rl, sides: 6, p: C, q: axisAngle({ x: 0, y: 0, z: 1 }, th - Math.PI / 2) }));
    expect(log.mass).toBeCloseTo(300, 9);
    expect(stick.mass).toBeCloseTo(2, 9);
    return { w, stick, log };
  }

  it(`holds 10 s, awake, with PHYSICS_TUNING.entityExtraSolverIters (+4)`, async () => {
    const { w, stick, log } = await propScene();
    expect(stick.body!.additionalSolverIterations()).toBe(4);
    expect(log.body!.additionalSolverIterations()).toBe(4);
    w.entities.keepAwake(stick.id, true);
    w.entities.keepAwake(log.id, true);
    const y0 = log.pose.p.y;
    const base0 = structuredClone(stick.pose.p);
    let maxTilt = 0;
    for (let t = 0; t < 600; t++) {
      w.step();
      maxTilt = Math.max(maxTilt, tiltDeg(stick.pose.q));
      expect(stick.body!.isSleeping() || log.body!.isSleeping()).toBe(false);
    }
    expect(maxTilt).toBeLessThan(5);
    expect(y0 - log.pose.p.y).toBeLessThan(0.02);
    expect(hdist(stick.pose.p, base0)).toBeLessThan(0.02);
  });

  it('falls with no extra solver iterations (the control)', async () => {
    PHYSICS_TUNING.entityExtraSolverIters = 0;
    const { w, stick, log } = await propScene();
    expect(stick.body!.additionalSolverIterations()).toBe(0);
    const y0 = log.pose.p.y;
    for (let t = 0; t < 600; t++) w.step();
    expect(tiltDeg(stick.pose.q)).toBeGreaterThan(45);
    expect(y0 - log.pose.p.y).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// The mirror: falling, resting, sleeping, deterministically
// ---------------------------------------------------------------------------

describe('the mirror', () => {
  /** A pile of logs, sticks, boxes and stones dropped from seeded poses onto dug ground. */
  async function pile(): Promise<World> {
    const w = await make({ seed: 7 });
    for (const [x, z] of [[1, 1], [-1.5, 0.5], [0.5, -2]]) w.terrain.lower(x, z, 1);
    const rng = new Rng(20261017);
    const randQuat = (): Quat => {
      const ax = { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) };
      const n = Math.hypot(ax.x, ax.y, ax.z) || 1;
      return axisAngle({ x: ax.x / n, y: ax.y / n, z: ax.z / n }, rng.range(0, Math.PI));
    };
    for (let k = 0; k < 16; k++) {
      const p = { x: rng.range(-3, 3), y: rng.range(0.6, 3), z: rng.range(-3, 3) };
      const q = randQuat();
      switch (k % 4) {
        case 0:
          w.entities.create(prism('dryWood', { length: rng.range(1, 2.5), r: rng.range(0.08, 0.2), sides: 6, p, q }));
          break;
        case 1:
          w.entities.create(prism('greenWood', { length: rng.range(0.6, 1.4), r: rng.range(0.02, 0.05), sides: 8, p, q, look: 'stick' }));
          break;
        case 2:
          w.entities.create(box('rottenWood', [rng.range(0.1, 0.4), rng.range(0.05, 0.2), rng.range(0.1, 0.4)], p, { q }));
          break;
        default: {
          const ico = icosahedron(rng.range(2, 30), MATERIALS.stone.density);
          w.entities.create({ material: 'stone', shape: { kind: 'hull', points: ico.points }, p, q, look: 'stone' });
        }
      }
    }
    return w;
  }

  it('entities fall, rest, sleep and mirror their bodies, bit-identically in two worlds', async () => {
    const a = await pile();
    const b = await pile();
    expect(mirrorText(b)).toBe(mirrorText(a));
    // By id: light pieces of the pile may break on landing (§4.10, P10), which replaces them with new ids.
    let prev = new Map(a.entities.all().map((e) => [e.id, structuredClone(e.pose)]));
    for (let t = 1; t <= 1200; t++) {
      a.step();
      b.step();
      // prevPose is the pose one tick earlier; pose is the body's own f32 pose.
      const now = a.entities.all();
      for (let i = 0; i < now.length; i++) {
        if (prev.has(now[i].id)) expect(now[i].prevPose).toEqual(prev.get(now[i].id));
        if (t % 120 === 0) expect(now[i].pose).toEqual(bodyPose(now[i]));
      }
      prev = new Map(now.map((e) => [e.id, structuredClone(e.pose)]));
      if (t % 60 === 0) expect(mirrorText(b)).toBe(mirrorText(a));
    }
    for (const e of a.entities.all()) {
      expect(e.body!.isSleeping(), `entity ${e.id} asleep`).toBe(true);
      expect(e.restTicks, `entity ${e.id} at rest`).toBeGreaterThanOrEqual(PHYSICS_TUNING.restTicks);
      expect(e.vel).toEqual({ lin: { x: 0, y: 0, z: 0 }, ang: { x: 0, y: 0, z: 0 } });
      expect(e.pose).toEqual(e.prevPose);
      expect(e.pose.p.y).toBeGreaterThan(a.terrain.heightAt(e.pose.p.x, e.pose.p.z) - 0.5);
      expect(e.age).toBeCloseTo(1200 * DT, 9);
    }
  });

  it('counts rest by the fastest point of the body: a body spinning in place is not at rest', async () => {
    WORLD_TUNING.gravityY = 0;
    const w = await make();
    const spin = w.entities.create({ ...prism('dryWood', { length: 2, r: 0.1, sides: 6, p: { x: 0, y: 3, z: 0 } }), ang: { x: 0, y: 0, z: 0.2 } });
    const still = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 4, y: 3, z: 0 }));
    for (let t = 0; t < 20; t++) w.step();
    expect(Math.hypot(spin.vel.lin.x, spin.vel.lin.y, spin.vel.lin.z)).toBeLessThan(PHYSICS_TUNING.restSpeed);
    expect(spin.restTicks).toBe(0); // its ends move at ~0.2 m/s
    expect(still.restTicks).toBe(20);
    w.entities.setState(still, 'held');
    w.step();
    expect(still.restTicks).toBe(0);
  });

  it('a held entity mirrors the pose the hands give it; prevPose is the pose one tick earlier', async () => {
    const w = await make();
    const e = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 0, y: 0.2, z: 0 }));
    w.entities.setState(e, 'held');
    const poses: Pose3[] = [];
    for (let t = 0; t < 5; t++) {
      e.pose = { p: { x: t * 0.1, y: 1.2, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } }; // what verbs.syncHeld does in phase 4b
      poses.push(structuredClone(e.pose));
      w.step();
      expect(e.pose).toEqual(poses[t]);
      if (t > 0) expect(e.prevPose).toEqual(poses[t - 1]);
    }
  });

  it('age advances by DT each tick, except while frozen', async () => {
    const w = await make();
    const e = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 0, y: 0.2, z: 0 }));
    for (let t = 0; t < 30; t++) w.step();
    expect(e.age).toBeCloseTo(30 * DT, 12);
    w.entities.setState(e, 'frozen');
    expect(e.body).toBeNull();
    for (let t = 0; t < 30; t++) w.step();
    expect(e.age).toBeCloseTo(30 * DT, 12);
  });
});

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

describe('state changes', () => {
  it('held disables the body (hidden from queries); a drop puts it back at the record pose; stowed and the like drop it', async () => {
    const w = await make();
    const e = w.entities.create(box('dryWood', [0.3, 0.2, 0.3], { x: 0, y: 0.2, z: 0 }));
    for (let t = 0; t < 30; t++) w.step();
    expect(rayDown(w, 0, 0)).toBe(`entity:${e.id}`);
    expect(e.touched).toBe(false);

    w.entities.setState(e, 'held');
    expect(e.state).toBe('held');
    expect(e.touched).toBe(true);
    const body = e.body!;
    expect(body).not.toBeNull();
    expect(body.isEnabled()).toBe(false);
    w.step();
    expect(rayDown(w, 0, 0)).toBe('terrain');

    // The hands carried it to (3, 1, 2); the drop puts the body there with the record velocity, awake.
    e.pose = { p: { x: 3, y: 1, z: 2 }, q: axisAngle({ x: 0, y: 1, z: 0 }, 0.3) };
    e.vel = { lin: { x: 0.5, y: 0, z: 0 }, ang: { x: 0, y: 0, z: 0 } };
    w.entities.setState(e, 'free');
    expect(e.body).toBe(body);
    expect(body.isEnabled()).toBe(true);
    expect(body.isSleeping()).toBe(false);
    expect(bodyPose(e).p).toEqual(f32({ x: 3, y: 1, z: 2 }));
    expect(e.pose).toEqual(bodyPose(e));
    expect(body.linvel().x).toBeCloseTo(0.5, 6);
    for (let t = 0; t < 60; t++) w.step();
    expect(rayDown(w, e.pose.p.x, e.pose.p.z)).toBe(`entity:${e.id}`);

    // Stowed: no body; drawn and dropped again: a new body at the record pose.
    const bodies = w.physics.rapier.bodies.len();
    const handle = e.collider!.handle;
    w.entities.setState(e, 'stowed');
    expect([e.body, e.collider]).toEqual([null, null]);
    expect(w.physics.rapier.bodies.len()).toBe(bodies - 1);
    w.step();
    expect(w.physics.ownerOf(handle)).toBeNull();
    e.pose = { p: { x: -2, y: 0.5, z: -2 }, q: { x: 0, y: 0, z: 0, w: 1 } };
    w.entities.setState(e, 'held');
    expect(e.body!.isEnabled()).toBe(false);
    w.entities.setState(e, 'free');
    expect(e.pose.p).toEqual(f32({ x: -2, y: 0.5, z: -2 }));
    expect(w.physics.ownerOf(e.collider!.handle)).toEqual({ kind: 'entity', id: e.id });

    for (const s of ['tied', 'projectile', 'frozen'] as const) {
      w.entities.setState(e, s);
      expect(e.state).toBe(s);
      expect(e.body).toBeNull();
      w.entities.setState(e, 'free');
      expect(e.body!.isDynamic()).toBe(true);
    }

    // The same state again changes nothing.
    const f = w.entities.create(box('dryWood', [0.3, 0.2, 0.3], { x: 6, y: 0.2, z: 0 }));
    const fb = f.body;
    w.entities.setState(f, 'free');
    expect(f.body).toBe(fb);
    expect(f.touched).toBe(false);
    expect(() => w.entities.setState({ ...f }, 'held')).toThrow(/not in this store/);
  });

  it('a held stake driven into the ground (held → anchored) gets a fixed body at the placed pose', async () => {
    const w = await make();
    const stake = w.entities.create(prism('greenWood', { length: 1, r: 0.04, sides: 8, p: { x: 0, y: 0.04, z: 0 }, q: LYING_Z }));
    w.entities.setState(stake, 'held');
    stake.pose = { p: { x: 1, y: 0.2, z: 1 }, q: { x: 0, y: 0, z: 0, w: 1 } };
    w.entities.anchor(stake, 0.3);
    expect(stake.body!.isFixed()).toBe(true);
    expect(stake.body!.isEnabled()).toBe(true);
    expect(stake.pose.p).toEqual(f32({ x: 1, y: 0.2, z: 1 }));
    w.entities.setState(stake, 'held');
    expect(stake.anchor).toBeNull();
    expect(stake.body!.isDynamic()).toBe(true);
    expect(stake.body!.isEnabled()).toBe(false);
  });

  it('reshape rebuilds the collider and the mass on the same body and moves the pose by the offset', async () => {
    WORLD_TUNING.gravityY = 0;
    const w = await make();
    const e = w.entities.create(prism('greenWood', { length: 4, r: 0.15, sides: 8, p: { x: 0, y: 3, z: 0 }, q: axisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2) }));
    const body = e.body;
    const old = e.collider!.handle;
    const half: Shape = { kind: 'cylinder', halfHeight: 1, r: 0.15, sides: 8 };
    w.entities.reshape(e, half, { x: 0, y: 1, z: 0 }); // the upper half: its origin 1 m up the old axis
    expect(e.body).toBe(body);
    expect(e.collider!.handle).not.toBe(old);
    expect(w.physics.ownerOf(e.collider!.handle)).toEqual({ kind: 'entity', id: e.id });
    expect(e.mass).toBeCloseTo(MATERIALS.greenWood.density * shapeVolume(half), 9);
    expect(e.body!.mass()).toBeCloseTo(e.mass, 2);
    expect(e.pose.p.x).toBeCloseTo(-1, 6); // local +y is world −x here
    expect(e.pose.p.y).toBeCloseTo(3, 6);
    expect(e.touched).toBe(true);
    expect(() => w.entities.reshape(e, { kind: 'box', hx: 0, hy: 1, hz: 1 })).toThrow(/no volume/);

    // The rest radius is measured from the new centre of mass: a hull box whose centre sits 0.5 m off its origin.
    const offCentre: Shape = { kind: 'hull', points: [0, 0.1, 0.1, 0, -0.1, 0.1, 0, 0.1, -0.1, 0, -0.1, -0.1, 1, 0.1, 0.1, 1, -0.1, 0.1, 1, 0.1, -0.1, 1, -0.1, -0.1] };
    w.entities.reshape(e, offCentre);
    const com = e.body!.localCom();
    expect(com.x).toBeCloseTo(0.5, 5);
    const reach = (w.entities as unknown as { rt: Map<number, { reach: number }> }).rt.get(e.id)!.reach;
    expect(reach).toBeCloseTo(Math.hypot(1, 0.1, 0.1) + 0.5, 5);
  });

  it('setGrace sets the piece filter, and every collider the store builds later keeps it', async () => {
    const w = await make();
    const e = w.entities.create(box('dryWood', [0.2, 0.05, 0.05], { x: 0, y: 0.05, z: 0 }));
    expect(e.collider!.collisionGroups()).toBe(collisionGroups('ENTITY'));
    const grace = { from: { kind: 'fighter', id: 1, part: 'ruler', bone: 'shinL' } as const, minUntil: w.tick + 10, maxUntil: w.tick + 600 };
    w.entities.setGrace(e, grace);
    expect(e.grace).toEqual(grace);
    expect(e.touched).toBe(true);
    expect(e.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    // A new body (stowed → free), a new collider (reshape), a type switch (anchor): the filter stays.
    w.entities.setState(e, 'stowed');
    w.entities.setState(e, 'free');
    expect(e.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    w.entities.reshape(e, { kind: 'box', hx: 0.15, hy: 0.05, hz: 0.05 });
    expect(e.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    w.entities.anchor(e, 0.1);
    expect(e.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    w.entities.setState(e, 'free');
    w.entities.setGrace(e, null);
    expect(e.grace).toBeNull();
    expect(e.collider!.collisionGroups()).toBe(collisionGroups('ENTITY'));
    w.entities.setState(e, 'stowed');
    w.entities.setState(e, 'held');
    expect(e.collider!.collisionGroups()).toBe(collisionGroups('ENTITY'));
  });

  it('setPose moves an enabled body (velocities kept, awake, history reset) and only the record of a held one', async () => {
    WORLD_TUNING.gravityY = 0;
    const w = await make();
    const e = w.entities.create({ ...box('dryWood', [0.2, 0.2, 0.2], { x: 0, y: 2, z: 0 }), lin: { x: 1, y: 0, z: 0 } });
    const reset = vi.spyOn(w.physics, 'resetHistory');
    const to: Pose3 = { p: { x: 3, y: 2.5, z: -1 }, q: axisAngle({ x: 0, y: 1, z: 0 }, 0.4) };
    w.entities.setPose(e, to);
    expect(bodyPose(e).p).toEqual(f32(to.p));
    expect(turnDeg(bodyPose(e).q, to.q)).toBeLessThan(0.1);
    expect(e.pose).toEqual(bodyPose(e));
    expect(e.body!.linvel().x).toBeCloseTo(1, 6);
    expect(e.touched).toBe(true);
    expect(reset).toHaveBeenCalledWith(`entity:${e.id}`);
    w.step();
    expect(e.pose.p.x).toBeCloseTo(3 + DT, 5);

    // A fixed body moves too (it moves only when code moves it).
    const f = w.entities.create(box('stone', [0.2, 0.2, 0.2], { x: 6, y: 0.2, z: 0 }, { state: 'fixed', generated: true }));
    w.entities.setPose(f, { p: { x: 6, y: 0.2, z: 1 }, q: { x: 0, y: 0, z: 0, w: 1 } });
    expect(bodyPose(f).p).toEqual(f32({ x: 6, y: 0.2, z: 1 }));
    expect(f.touched).toBe(true);

    // Held: the record moves; the disabled body takes that pose when it is enabled again.
    w.entities.setState(e, 'held');
    const stale = bodyPose(e);
    w.entities.setPose(e, { p: { x: -2, y: 1, z: 0 }, q: { x: 0, y: 0, z: 0, w: 2 } });
    expect(bodyPose(e)).toEqual(stale);
    expect(e.pose).toEqual({ p: { x: -2, y: 1, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } });
    w.entities.setState(e, 'free');
    expect(bodyPose(e).p).toEqual(f32({ x: -2, y: 1, z: 0 }));
    expect(() => w.entities.setPose(e, { p: { x: NaN, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } })).toThrow(/non-finite/);
  });

  it('a create whose body fails leaves no entity, no body, no event and no spent id', async () => {
    const w = await make();
    w.entities.create(box('stone', [0.1, 0.1, 0.1], { x: 0, y: 0.1, z: 0 }));
    w.events.length = 0;
    const next = w.ids.entity.next;
    const bodies = w.physics.rapier.bodies.len();
    vi.spyOn(w.physics.rapier, 'createCollider').mockImplementationOnce(() => {
      throw new Error('a hull Rapier cannot build');
    });
    expect(() => w.entities.create({ ...box('stone', [0.1, 0.1, 0.1], { x: 2, y: 0.1, z: 0 }), generated: true })).toThrow(/cannot build/);
    expect(w.ids.entity.next).toBe(next);
    expect(w.entities.all()).toHaveLength(1);
    expect(w.entities.get(next)).toBeUndefined();
    expect(w.physics.rapier.bodies.len()).toBe(bodies);
    expect(w.entities.removedGenerated()).toEqual([]);
    expect(w.events).toEqual([]);
    expect(w.entities.create(box('stone', [0.1, 0.1, 0.1], { x: 2, y: 0.1, z: 0 })).id).toBe(next);
  });
});

// ---------------------------------------------------------------------------
// touched, release, keep-awake
// ---------------------------------------------------------------------------

describe('touched, release and keep-awake', () => {
  it('a generated entity is touched once it moves more than 1 cm or turns more than 1°, or a state changes', async () => {
    const w = await make();
    const g = w.entities.create(box('stone', [0.3, 0.3, 0.3], { x: 0, y: 0.3, z: 0 }, { state: 'fixed', generated: true }));
    const g2 = w.entities.create(box('stone', [0.3, 0.3, 0.3], { x: 3, y: 0.3, z: 0 }, { state: 'fixed', generated: true }));
    const g3 = w.entities.create(box('stone', [0.3, 0.3, 0.3], { x: 6, y: 0.3, z: 0 }, { generated: true }));
    const n = w.entities.create(box('stone', [0.3, 0.3, 0.3], { x: 9, y: 0.3, z: 0 }));
    for (let t = 0; t < 60; t++) w.step();
    expect([g, g2, g3, n].map((e) => e.touched)).toEqual([false, false, false, false]);
    expect(w.entities.toRecord().map((r) => r.id)).toEqual([n.id]);

    // Fixed bodies move only when code moves them (a test stand-in for a verb).
    g.body!.setTranslation({ x: 0.009, y: 0.3, z: 0 }, true);
    g2.body!.setRotation(axisAngle({ x: 0, y: 1, z: 0 }, (0.9 * Math.PI) / 180), true);
    w.step();
    expect([g.touched, g2.touched]).toEqual([false, false]);
    g.body!.setTranslation({ x: 0.0105, y: 0.3, z: 0 }, true);
    g2.body!.setRotation(axisAngle({ x: 0, y: 1, z: 0 }, (1.1 * Math.PI) / 180), true);
    w.step();
    expect([g.touched, g2.touched]).toEqual([true, true]);
    // ...and stays touched when it moves back.
    g.body!.setTranslation({ x: 0, y: 0.3, z: 0 }, true);
    w.step();
    expect(g.touched).toBe(true);

    w.entities.release(g3, 1);
    expect(g3.releasedBy).toEqual({ fighter: 1, apartTicks: 0 });
    expect(g3.touched).toBe(true);
    expect(w.entities.toRecord().map((r) => r.id)).toEqual([g.id, g2.id, g3.id, n.id]);

    w.entities.remove(g2.id);
    w.entities.remove(n.id);
    w.entities.remove(g.id);
    expect(w.entities.removedGenerated()).toEqual([g.id, g2.id]);
  });

  it('keepAwake keeps a resting body awake; off, it falls asleep', async () => {
    const w = await make();
    const e = w.entities.create(box('dryWood', [0.3, 0.2, 0.3], { x: 0, y: 0.21, z: 0 }));
    w.entities.keepAwake(e.id, true);
    for (let t = 0; t < 240; t++) w.step();
    expect(e.body!.isSleeping()).toBe(false);
    expect(e.restTicks).toBeGreaterThan(PHYSICS_TUNING.restTicks);
    w.entities.keepAwake(e.id, false);
    for (let t = 0; t < 240; t++) w.step();
    expect(e.body!.isSleeping()).toBe(true);
    expect(() => w.entities.keepAwake(99, true)).toThrow(/no entity/);
  });

  it('remove releases the joints the entity still has, before its body goes', async () => {
    const w = await make();
    const { records, join } = fakeJoints(w);
    const a = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 0, y: 0.2, z: 0 }));
    const b = w.entities.create(box('dryWood', [0.2, 0.2, 0.2], { x: 1, y: 0.2, z: 0 }));
    const j1 = join('lash', at(a.id), at(b.id));
    const j2 = join('rope', at(a.id), at(null));
    a.joints.push(77); // a joint the joint store no longer has
    const released: [number, string, boolean][] = [];
    (w.joints as { remove: (id: number, why: string) => void }).remove = (id, why) => {
      released.push([id, why, a.body !== null]);
      records.delete(id);
      for (const e of [a, b]) e.joints = e.joints.filter((x) => x !== id);
    };
    w.entities.remove(a.id);
    expect(released).toEqual([
      [j1, 'release', true],
      [j2, 'release', true],
    ]);
    expect(b.joints).toEqual([]);

    // A release that removes the entity itself (a rope entity left with no joint, P10): removed once, one event.
    const rope = w.entities.create(box('vine', [0.05, 0.05, 0.5], { x: 3, y: 0.05, z: 0 }));
    join('rope', at(rope.id), at(b.id));
    (w.joints as { remove: (id: number, why: string) => void }).remove = (id) => {
      records.delete(id);
      rope.joints = [];
      b.joints = [];
      w.entities.remove(rope.id);
    };
    w.events.length = 0;
    w.entities.remove(rope.id);
    expect(w.entities.get(rope.id)).toBeUndefined();
    expect(w.events).toEqual([{ type: 'remove', entity: rope.id }]);
  });
});

// ---------------------------------------------------------------------------
// Save records
// ---------------------------------------------------------------------------

describe('save records', () => {
  /** The generated part of a scene: what generation makes again from the seed. */
  function generate(w: World): void {
    w.entities.create(box('stone', [0.3, 0.3, 0.3], { x: -4, y: 0.3, z: 0 }, { generated: true }));
    w.entities.create(prism('dryWood', { length: 2, r: 0.15, sides: 6, p: { x: -2, y: 0.14, z: 0 }, q: LYING_Z, generated: true }));
    w.entities.create(prism('greenWood', { length: 8, r: 0.15, sides: 8, p: { x: 0, y: 4, z: 3 }, state: 'fixed', generated: true }));
    w.entities.create(box('rottenWood', [0.3, 0.05, 0.3], { x: 2, y: 0.05, z: 0 }, { generated: true }));
  }

  /** A saved world: generated entities touched and removed, entities added in every state, fields changed. */
  async function savedScene(): Promise<World> {
    const w = await make({ seed: 3 });
    generate(w);
    const [, log, tree, mat] = w.entities.all();
    tree.plant = { diameter: 0.3, height: 8, phase: 'notched', cut: { fromDir: { x: 1, y: 0, z: 0 }, remaining: 0.6, chops: 6, depthSumM: 0.12 }, stump: null, fall: null };
    tree.touched = true; // felling marks what it changes
    const stake = w.entities.create(prism('greenWood', { length: 1, r: 0.04, sides: 8, p: { x: 4, y: 0.2, z: 0 }, state: 'anchored', look: 'stake' }), ['p1']);
    stake.sharpPoints.push({ local: { x: 0, y: 0.5, z: 0 }, dir: { x: 0, y: 1, z: 0 }, sharpness: 0.5 });
    const held = w.entities.create(box('dryWood', [0.1, 0.1, 0.4], { x: 5, y: 0.1, z: 2 }));
    const stowed = w.entities.create(box('flint', [0.05, 0.03, 0.05], { x: 6, y: 0.03, z: 2 }));
    const thrown = w.entities.create(prism('dryWood', { length: 1.6, r: 0.03, sides: 8, p: { x: -6, y: 1.5, z: 4 }, q: LYING_Z }));
    for (let t = 0; t < 30; t++) {
      w.entities.queueImpulse(log.id, { x: 3, y: 0, z: 0 }, null);
      w.step();
    }
    w.entities.setState(held, 'held');
    held.pose = { p: { x: 5, y: 1.1, z: 2 }, q: { x: 0, y: 0, z: 0, w: 1 } };
    w.entities.setState(stowed, 'stowed');
    w.entities.remove(mat.id);
    w.entities.release(thrown, 1);
    thrown.thrown = { by: 1, tick: w.tick };
    // minUntil past the 240 ticks below: from minUntil, P10's grace ends as soon as the piece is clear of its breaker
    // (RF-7), and this one never touched it.
    w.entities.setGrace(thrown, { from: { kind: 'fighter', id: 1, part: 'zone', bone: 'shinL' }, minUntil: w.tick + 300, maxUntil: w.tick + 600 });
    thrown.crossCut = { axisT: 0.2, remaining: 0.5, fromDir: { x: 0, y: 0, z: 1 } };
    thrown.loadHist[3] = 120.5;
    thrown.credit = ['p1'];
    for (let t = 0; t < 240; t++) w.step();
    return w;
  }

  it('toRecord holds every saved field in id order; restoreRecord rebuilds those entities at the saved f32 poses', async () => {
    const a = await savedScene();
    const rec = a.entities.toRecord();
    const removed = a.entities.removedGenerated();
    expect(removed).toEqual([4]);
    // Untouched generated entities aren't saved (the stone at rest, never moved).
    expect(rec.map((r) => r.id)).toEqual([2, 3, 5, 6, 7, 8]);
    const keys = Object.keys(rec[0]).sort();
    const expected: (keyof EntityRecV1)[] = [
      'id', 'material', 'shape', 'mass', 'state', 'pose', 'vel', 'integrity', 'moisture', 'temperature', 'burning', 'sharpPoints', 'joints', 'age',
      'credit', 'look', 'plant', 'anchor', 'rope', 'crossCut', 'thrown', 'loadHist', 'restTicks', 'generated', 'touched', 'grace', 'releasedBy',
    ];
    expect(keys).toEqual([...expected].sort());
    // Records are plain data, detached from the live entities.
    const json = JSON.stringify(rec);
    expect(JSON.parse(json)).toEqual(rec);
    rec[0].pose.p.x += 1;
    expect(a.entities.get(2)!.pose.p.x).not.toBe(rec[0].pose.p.x);
    rec[0].pose.p.x -= 1;

    // Load: generation again, then the records.
    const b = await make({ seed: 3 });
    generate(b);
    b.ids.entity.next = 5; // the counter as generation left it (P13 restores the saved counter)
    // Which saved pose each new Rapier body is created at, in creation order.
    const created: number[] = [];
    const create = b.physics.rapier.createRigidBody.bind(b.physics.rapier);
    vi.spyOn(b.physics.rapier, 'createRigidBody').mockImplementation((desc) => {
      const r = rec.find((x) => x.pose.p.x === desc.translation.x && x.pose.p.z === desc.translation.z);
      created.push(r ? r.id : -1);
      return create(desc);
    });
    b.entities.restoreRecord(JSON.parse(json) as EntityRecV1[], removed);
    vi.mocked(b.physics.rapier.createRigidBody).mockRestore();
    expect(created).toEqual([2, 3, 5, 6, 8]); // id order; the stowed 7 has no body
    expect(JSON.stringify(b.entities.toRecord())).toBe(json);
    expect(b.entities.removedGenerated()).toEqual(removed);
    expect(b.entities.all().map((e) => e.id)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    expect(b.ids.entity.next).toBe(a.ids.entity.next);
    const savedIds = new Set(rec.map((r) => r.id));
    for (const e of b.entities.all()) {
      const src = a.entities.get(e.id)!;
      expect(e.state).toBe(src.state);
      if (savedIds.has(e.id)) {
        expect(e.pose).toEqual(src.pose);
        if (e.body && e.body.isEnabled()) expect(bodyPose(e)).toEqual(src.pose);
      } else {
        // An untouched generated entity comes back where generation puts it: within 1 cm and 1° of where it was.
        expect(e.touched).toBe(false);
        expect(dist(e.pose.p, src.pose.p)).toBeLessThan(ENTITY_TUNING.touchedMoveM);
        expect(turnDeg(e.pose.q, src.pose.q)).toBeLessThan(ENTITY_TUNING.touchedTurnDeg);
      }
    }
    expect(b.entities.get(3)!.body!.isFixed()).toBe(true);
    expect(b.entities.get(5)!.body!.isFixed()).toBe(true);
    expect(b.entities.get(6)!.body!.isEnabled()).toBe(false);
    expect(b.entities.get(7)!.body).toBeNull();
    expect(b.entities.get(8)!.body!.isCcdEnabled()).toBe(true);
    // A piece restored in its grace keeps the grace filter (§2.11, §4.10); the others are plain ENTITY colliders.
    expect(a.entities.get(8)!.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    expect(b.entities.get(8)!.grace).not.toBeNull();
    expect(b.entities.get(8)!.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    for (const id of [2, 3, 5, 6]) expect(b.entities.get(id)!.collider!.collisionGroups()).toBe(collisionGroups('ENTITY'));
    expect(b.entities.isAnchored(b.entities.get(5)!)).toBe(true);
    expect(b.physics.ownerOf(b.entities.get(2)!.collider!.handle)).toEqual({ kind: 'entity', id: 2 });

    // A world at rest stays within 1 cm and 1° of the saved poses for 10 s (SPEC:730; the M3 gate's preview).
    for (let t = 0; t < 600; t++) b.step();
    for (const e of b.entities.all()) {
      if (e.state === 'held' || e.state === 'stowed') continue;
      const saved = a.entities.get(e.id)!.pose;
      expect(dist(e.pose.p, saved.p), `entity ${e.id}`).toBeLessThan(0.01);
      expect(turnDeg(e.pose.q, saved.q), `entity ${e.id}`).toBeLessThan(1);
    }
  });

  it('restores into an empty world, moves the counter past the restored ids, and refuses unordered records', async () => {
    const a = await savedScene();
    const rec = a.entities.toRecord();
    const b = await make({ seed: 3 });
    b.entities.restoreRecord(structuredClone(rec), a.entities.removedGenerated());
    expect(b.entities.all().map((e) => e.id)).toEqual(rec.map((r) => r.id));
    expect(b.entities.get(8)!.collider!.collisionGroups()).toBe(pieceGraceCollisionGroups());
    expect(b.ids.entity.next).toBe(9);
    expect(b.entities.removedGenerated()).toEqual([4]);
    expect(b.entities.create(box('stone', [0.1, 0.1, 0.1], { x: 0, y: 3, z: 9 })).id).toBe(9);
    const c = await make({ seed: 3 });
    expect(() => c.entities.restoreRecord([rec[1], rec[0]], [])).toThrow(/increasing id order/);
    expect(c.events).toEqual([]);
  });
});
