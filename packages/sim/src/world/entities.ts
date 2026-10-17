// The entity store (docs/M1-DESIGN.md §1.5.7, §2.3, §3 phases 4d and 18, §8.3): entities created and removed in id
// order with their Rapier bodies, anchoring and isAnchored, the impulse queue applied in phase 4d of the next step, the
// record mirror (phase 18), `touched`, released-entity marks, and the entity records of the save.
//
// Bodies (§2.3):
// - `fixed` and `anchored` → a fixed body (an anchored stake is static for m_eff, trips and shoves, D-19);
// - `free` → a dynamic body with PHYSICS_TUNING's extra solver iterations (a 2 kg prop under a 300 kg log holds with +4,
//   falls with 0, MAP rapier finding 11), linear and angular damping, sleeping allowed, and CCD while its smallest
//   half-extent is under ccdMinHalfExtent, while it is thrown, and while it is a falling trunk (SPEC:267);
// - `held` → the same dynamic body, disabled (hidden from the solver and from queries, MAP gap-5 §6.2); the record pose
//   follows the hand (verbs, phase 4b) and the body is put back at the record pose when it is enabled again;
// - `stowed`, `tied`, `projectile`, `frozen` → no body.
// Every entity collider is in the ENTITY collision and solver groups (§2.11), or the piece grace filter while
// `e.grace` is set (setGrace), with COLLISION_EVENTS; a dynamic one also raises CONTACT_FORCE_EVENTS above
// forceEventThresholdN (a dev cross-check only, never an outcome).
//
// The record pose of an entity with an enabled body is the body's (read back at every mirror): code moves such an
// entity with setPose. Writing `e.pose` directly moves only a held or bodiless entity (the hands' pose, which the body
// takes when it is enabled again).
//
// Order (§8.1): bodies are created and removed in id order (create() takes the next id, so a caller that creates
// several bodies in a phase creates them in id order by construction; restoreRecord rebuilds in id order); every loop
// here runs in id order; queued impulses are applied in entity id order (queue order within one id). Rapier handles
// never leave the runtime fields (`body`, `collider`) and are never saved.
//
// Runtime state that is not part of the record (never saved, rebuilt with the body): the CCD flag last set, the test
// harness's keep-awake flag, the generated pose (for `touched`), the pose at the last mirror (`prevPose`), and the
// shape's reach and smallest half-extent.
import RAPIER from '@dimforge/rapier3d-compat';
import type { EntityRecV1 } from '../save/schema';
import { DT } from '../sim/math';
import { defineTuning } from '../tuning/registry';
import { collisionGroups, pieceGraceCollisionGroups, solverGroups } from './groups';
import { LOAD_TUNING } from './loads';
import { MATERIALS } from './materials';
import { ownerKey, PHYSICS_TUNING } from './physics';
import { colliderDesc, shapeMass, shapeVolume, triangulate } from './shapes';
import type { Entity, EntitySpec, EntityState, Owner, PlantState, Pose3, Quat, Shape, SharpPoint, V3 } from './types';
import { VERB_TUNING } from './verbs/tuning';
import type { World } from './world';

/**
 * The entity store's own starting values. DEVIATION (P06): §13.0 adds no tuning table after P05, but P05 registered
 * none for this file and §9.1 has no row for these three values, which the design states only in prose (§2.3, §8.3);
 * CLAUDE.md puts every starting value in a live tuning table, so they live here until a P05-fix moves them into
 * PHYSICS_TUNING (then this table goes and the reads below change to PHYSICS_TUNING).
 */
export const ENTITY_TUNING = defineTuning(
  'ENTITY_TUNING',
  'Physics › entities',
  {
    touchedMoveM: 0.01,
    touchedTurnDeg: 1,
    anchorJoinDepth: 3,
  },
  {
    touchedMoveM: { unit: 'm', source: 'NEW: §2.3, §8.3 (a generated entity moved > 1 cm is touched and saved)' },
    touchedTurnDeg: { unit: '°', source: 'NEW: §2.3, §8.3 (a generated entity turned > 1° is touched and saved)' },
    anchorJoinDepth: { unit: 'joints', source: 'NEW: §2.3 (lash/hinge-joined to an anchored entity, depth ≤ 3)' },
  },
);

/** Which body an entity state has (§2.3). */
type BodyKind = 'none' | 'fixed' | 'dynamic' | 'disabled';

function bodyKindOf(s: EntityState): BodyKind {
  switch (s) {
    case 'fixed':
    case 'anchored':
      return 'fixed';
    case 'free':
      return 'dynamic';
    case 'held':
      return 'disabled';
    case 'stowed':
    case 'tied':
    case 'projectile':
    case 'frozen':
      return 'none';
  }
}

/** Per-entity runtime state (never saved). */
interface Runtime {
  /** CCD as last set on the body (dynamic bodies only). */
  ccd: boolean;
  /** Test harness only: wakeUp every phase 4d (RT-4). */
  keepAwake: boolean;
  /** The pose a generated entity was generated at (null once touched, or for other entities). */
  genPose: Pose3 | null;
  /** The record pose at the end of the last mirror (or creation): the next mirror's prevPose. */
  last: Pose3;
  /** The shape the collider was built from. */
  shape: Shape;
  /** m: the farthest point of the shape from its local origin, plus the centre of mass's distance from it. */
  reach: number;
  /** m: the shape's smallest half-extent (CCD below PHYSICS_TUNING.ccdMinHalfExtent). */
  minHalf: number;
}

/** The PHYSICS_TUNING values a dynamic body carries, as last applied to every body. */
interface BodyTuning {
  iters: number;
  linDamp: number;
  angDamp: number;
  forceN: number;
}

interface QueuedImpulse {
  id: number;
  j: V3;
  at: V3 | null;
}

export class EntityStore {
  readonly world: World;

  private readonly byId = new Map<number, Entity>();
  private readonly rt = new Map<number, Runtime>();
  /** Every entity in id order (kept sorted on create, remove and restore). */
  private readonly sorted: Entity[] = [];
  /** all()'s answer: a copy of `sorted`, made again after a change (so a caller may create or remove while iterating). */
  private snapshot: readonly Entity[] | null = null;
  /** Generated ids no longer present. */
  private readonly removedGen = new Set<number>();
  private queue: QueuedImpulse[] = [];
  /** The PHYSICS_TUNING body values every dynamic body has (bodies made later read the table when they are made). */
  private applied: BodyTuning;

  constructor(world: World) {
    this.world = world;
    this.applied = bodyTuningNow();
  }

  get(id: number): Entity | undefined {
    return this.byId.get(id);
  }

  /** Id order. The array is a snapshot: creating or removing entities while iterating it is safe. */
  all(): readonly Entity[] {
    this.snapshot ??= Object.freeze(this.sorted.slice());
    return this.snapshot;
  }

  // -------------------------------------------------------------------------
  // Creation and removal
  // -------------------------------------------------------------------------

  /**
   * Id from world.ids.entity; the body is created now (visible to queries after the next physics step). `credit` is
   * merged with spec.credit (sorted, de-duplicated). Pushes a `spawn` event. The record's pose and velocities are read
   * back from the body, so they are the f32 values Rapier holds from the start.
   */
  create(spec: EntitySpec, credit?: string[]): Entity {
    checkSpec(spec);
    const state = spec.state ?? 'free';
    const id = this.world.ids.entity.take();
    const q = unitQuat(spec.q);
    const still = bodyKindOf(state) === 'fixed';
    const depth = spec.anchorDepthM ?? VERB_TUNING.stakeAnchorDepthM;
    const e: Entity = {
      id,
      material: spec.material,
      shape: copyShape(spec.shape),
      mass: shapeMass(spec.shape, MATERIALS[spec.material]),
      state,
      pose: { p: copyV3(spec.p), q },
      vel: { lin: still ? zero() : copyV3(spec.lin ?? ZERO), ang: still ? zero() : copyV3(spec.ang ?? ZERO) },
      integrity: spec.integrity ?? 1,
      // M2 rules (SPEC:178-181): no moisture, ambient temperature (0 until M2 gives the scale), not burning.
      moisture: 0,
      temperature: 0,
      burning: false,
      sharpPoints: (spec.sharpPoints ?? []).map(copySharpPoint),
      joints: [],
      age: 0,
      credit: normCredit([...(spec.credit ?? []), ...(credit ?? [])]),
      look: spec.look,
      plant: spec.plant ? { diameter: spec.plant.diameter, height: spec.plant.height, phase: 'standing', cut: null, stump: null, fall: null } : null,
      anchor: state === 'anchored' ? anchorOf(depth) : null,
      rope: spec.rope ? { lengthM: spec.rope.lengthM } : null,
      crossCut: null,
      thrown: null,
      loadHist: new Float32Array(loadHistLength()),
      restTicks: 0,
      generated: spec.generated ?? false,
      touched: false,
      grace: null,
      releasedBy: null,
      body: null,
      collider: null,
      prevPose: { p: copyV3(spec.p), q: { ...q } },
    };
    const rt = runtimeFor(e, null);
    this.insert(e, rt);
    try {
      this.makeBody(e, rt, false);
    } catch (err) {
      // No bodiless entity and no spent id are left behind (a hull Rapier can't build, a WASM error).
      this.forget(e);
      this.removedGen.delete(id);
      const ids = this.world.ids.entity;
      if (ids.next === id + 1) ids.next = id;
      throw err;
    }
    this.readBack(e);
    rt.last = copyPose(e.pose);
    e.prevPose = copyPose(e.pose);
    if (e.generated) rt.genPose = copyPose(e.pose);
    this.world.events.push({ type: 'spawn', entity: id });
    return e;
  }

  /**
   * Removes the entity and its body. Its joints still in the joint store are released first (JointStore.remove(…,
   * 'release')), so no Rapier joint outlives its body. A removed generated id is remembered for the save. Pushes a
   * `remove` event. Callers removing several entities in one phase remove them in id order.
   */
  remove(id: number): void {
    const e = this.byId.get(id);
    if (!e) throw new Error(`EntityStore.remove: no entity ${id}`);
    const joints = this.world.joints;
    for (const j of [...e.joints]) if (joints.get(j)) joints.remove(j, 'release');
    // Releasing a joint may already have removed this entity (a rope entity left with no joint, P10).
    if (this.byId.get(id) !== e) return;
    this.forget(e);
    this.world.events.push({ type: 'remove', entity: id });
  }

  // -------------------------------------------------------------------------
  // State changes
  // -------------------------------------------------------------------------

  /**
   * Rebuilds, switches, disables or drops the body for the new state (see the top of this file) and marks the entity
   * touched. 'anchored' is anchor() at the entity's anchor depth (or VERB_TUNING.stakeAnchorDepthM); leaving
   * 'anchored' clears `anchor`. A body enabled again (held → free) is put at the record pose with the record velocity.
   * The same state with the same shape changes nothing.
   */
  setState(e: Entity, s: EntityState): void {
    this.own(e, 'setState');
    if (s === 'anchored') {
      this.anchor(e, e.anchor?.depthM ?? VERB_TUNING.stakeAnchorDepthM);
      return;
    }
    this.transition(e, s);
  }

  /** Fixed body, anchor capacity depthM × VERB_TUNING.anchorHoldNPerM (§5.7, D-19); velocities zero; touched. */
  anchor(e: Entity, depthM: number): void {
    this.own(e, 'anchor');
    if (!(depthM > 0) || !Number.isFinite(depthM)) throw new Error(`EntityStore.anchor: bad depth ${depthM} for entity ${e.id}`);
    e.anchor = anchorOf(depthM);
    this.transition(e, 'anchored', true);
  }

  /**
   * Dynamic, awake (a pulled-out stake, a dug-out stake, a stake whose capacity a load or impact beat; a felled trunk, a
   * bent sapling). An entity that was `anchored` (driven) is lifted straight up until no vertex of its shape is below
   * the terrain; others stay where they are. Returns the lift (m; 0 when none).
   * A driven stake's end is 0.15-0.3 m inside the heightfield, and Rapier pushes a dynamic body that deep down through
   * the heightfield's triangles about half the time (a 6 kg stake 0.15 m in, measured by P10: it falls out of the
   * world), so it never starts dynamic inside the ground: the lift is the smallest move that clears it (P10's
   * workaround in breaking.ts, moved here). A fixed entity turned free keeps its pose: a falling trunk turns about its
   * hinge on the stump, a bent sapling about its root.
   */
  unanchor(e: Entity): number {
    this.own(e, 'unanchor');
    const driven = e.state === 'anchored';
    this.transition(e, 'free', true);
    if (!driven) return 0;
    const lift = this.depthBelowGround(e.shape, e.pose);
    if (lift > 0) this.setPose(e, { p: { x: e.pose.p.x, y: e.pose.p.y + lift, z: e.pose.p.z }, q: e.pose.q });
    return lift;
  }

  /**
   * How far `shape` at `pose` reaches below the terrain (m; 0 when it doesn't): its deepest vertex under the surface.
   * The one measure of "inside the ground" for a body about to turn dynamic (unanchor, and the pieces of a driven stake
   * that broke, world/breaking.ts).
   */
  depthBelowGround(shape: Shape, pose: Pose3): number {
    const { positions } = triangulate(shape, pose);
    const terrain = this.world.terrain;
    let d = 0;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const below = terrain.heightAt(positions[i], positions[i + 2]) - positions[i + 1];
      if (below > d) d = below;
    }
    return d;
  }

  /**
   * Fixed or anchored, or joined by a lash or hinge joint to one (transitively, at most
   * ENTITY_TUNING.anchorJoinDepth joints away, §2.3). A lash or hinge to a world point joins the entity to the world
   * itself; rope and bend joints, held ends and loose ends never anchor.
   */
  isAnchored(e: Entity): boolean {
    const maxDepth = ENTITY_TUNING.anchorJoinDepth;
    const joints = this.world.joints;
    const seen = new Set<number>([e.id]);
    let frontier: Entity[] = [e];
    for (let depth = 0; frontier.length > 0; depth++) {
      for (const x of frontier) if (x.state === 'fixed' || x.state === 'anchored') return true;
      if (depth >= maxDepth) return false;
      const next: Entity[] = [];
      for (const x of frontier) {
        for (const jid of x.joints) {
          const j = joints.get(jid);
          if (!j || (j.kind !== 'lash' && j.kind !== 'hinge')) continue;
          for (const end of [j.a, j.b]) {
            if (end.fighter !== undefined || end.loose) continue;
            if (end.entity === null) return true;
            if (seen.has(end.entity)) continue;
            seen.add(end.entity);
            const o = this.byId.get(end.entity);
            if (o) next.push(o);
          }
        }
      }
      frontier = next.sort(byId);
    }
    return false;
  }

  /**
   * Replaces the entity's shape (felling's trunk above the cut, a shaped end, a cut piece kept in place): the mass
   * becomes density × the new volume, the collider is rebuilt on the same body, and when `offset` is given (the new
   * shape's origin in the old local frame, as shapes.ts's pieces give it) the pose moves to it. Marks touched.
   */
  reshape(e: Entity, shape: Shape, offset: V3 | null = null): void {
    this.own(e, 'reshape');
    checkShape(shape, `entity ${e.id}`);
    if (offset) {
      const d = rotate(e.pose.q, offset);
      e.pose = { p: { x: e.pose.p.x + d.x, y: e.pose.p.y + d.y, z: e.pose.p.z + d.z }, q: { ...e.pose.q } };
    }
    e.shape = copyShape(shape);
    e.mass = shapeMass(e.shape, MATERIALS[e.material]);
    const rt = this.rt.get(e.id)!;
    const fresh = runtimeFor(e, rt);
    rt.shape = fresh.shape;
    rt.reach = fresh.reach;
    rt.minHalf = fresh.minHalf;
    if (e.body) {
      const b = e.body;
      if (e.collider) {
        this.world.physics.unregister(e.collider);
        this.world.physics.rapier.removeCollider(e.collider, true);
      }
      e.collider = this.makeCollider(e, b);
      b.recomputeMassPropertiesFromColliders();
      this.refreshReach(e, b);
      if (offset) {
        b.setTranslation(e.pose.p, true);
        this.world.physics.resetHistory(ownerKey(ownerOf(e)));
      }
      this.readBack(e);
    }
    e.touched = true;
  }

  /**
   * Sets (or, with null, ends) a fresh piece's grace (§4.10, RF-7) and its collider's collision filter with it: while
   * grace lasts the piece is an ENTITY whose filter drops CHAR, ZONE, RULER_ZONE, RULER_SOLID and DOWNED (§2.11). Every
   * collider the store builds later (a state change, a reshape, a load) takes the filter from `e.grace`. Marks touched.
   */
  setGrace(e: Entity, g: { from: Owner; minUntil: number; maxUntil: number } | null): void {
    this.own(e, 'setGrace');
    e.grace = g ? { from: copyOwner(g.from), minUntil: g.minUntil, maxUntil: g.maxUntil } : null;
    e.collider?.setCollisionGroups(entityCollisionGroups(e));
    e.touched = true;
  }

  /**
   * Moves the entity to `pose` by code (a snap-assist lash, a dev move): an enabled body is put there (awake, its
   * velocities kept) and its pose history reset, so the jump is never read as a speed; the record reads the f32 pose
   * back. Marks touched. Writing `e.pose` directly moves only a held or bodiless entity's record (the hands' pose, which
   * the body takes when it is enabled again); an entity with an enabled body takes its pose from the body at every mirror.
   */
  setPose(e: Entity, pose: Pose3): void {
    this.own(e, 'setPose');
    if (!finiteV3(pose.p)) throw new Error(`EntityStore.setPose: a non-finite position for entity ${e.id}`);
    e.pose = { p: copyV3(pose.p), q: unitQuat(pose.q) };
    const b = e.body;
    if (b && b.isEnabled()) {
      b.setTranslation(e.pose.p, true);
      b.setRotation(e.pose.q, true);
      this.world.physics.resetHistory(ownerKey(ownerOf(e)));
      this.readBack(e);
    }
    e.touched = true;
  }

  // -------------------------------------------------------------------------
  // Impulses, release, keep-awake
  // -------------------------------------------------------------------------

  /**
   * Applied in phase 4d of the NEXT step in entity id order, by every source: strike pushes, contact reactions and
   * tripwire shares of phase 9 (never addForce, C F3; never inside phase 9-10, RF-2). `j` in N·s, `at` a world point
   * (null: at the centre of mass). An impulse reaches only a body that is dynamic and enabled when it is applied: an
   * anchored, fixed, held or removed entity's impulse is dropped (an anchor's load is the joints' and breaking's rule).
   */
  queueImpulse(id: number, j: V3, at: V3 | null): void {
    if (!this.byId.has(id)) throw new Error(`EntityStore.queueImpulse: no entity ${id}`);
    if (!finiteV3(j) || (at !== null && !finiteV3(at))) throw new Error(`EntityStore.queueImpulse: a non-finite impulse or point for entity ${id}`);
    this.queue.push({ id, j: copyV3(j), at: at ? copyV3(at) : null });
  }

  /** Drop, throw, place: no contact between e and that fighter's bodies is scored until they have been apart 2 ticks. */
  release(e: Entity, byFighter: number): void {
    this.own(e, 'release');
    e.releasedBy = { fighter: byFighter, apartTicks: 0 };
    e.touched = true;
  }

  /** Test harness only: wakeUp every tick (RT-4), so "holds 120 s awake" is tested awake. */
  keepAwake(id: number, on: boolean): void {
    const rt = this.rt.get(id);
    if (!rt) throw new Error(`EntityStore.keepAwake: no entity ${id}`);
    rt.keepAwake = on;
  }

  /**
   * Phase 4d (last): the store's pre-step pass, in entity id order. Live PHYSICS_TUNING edits reach every dynamic body
   * (extra solver iterations, damping, the force-event threshold); CCD follows each dynamic body's need (small, thrown,
   * a falling trunk); kept-awake bodies are woken; then the queued impulses are applied in entity id order.
   */
  applyImpulses(): void {
    this.applyBodyTuning();
    for (const e of this.sorted) {
      const b = e.body;
      if (!b || !b.isEnabled() || !b.isDynamic()) continue;
      const rt = this.rt.get(e.id)!;
      const ccd = this.wantsCcd(e, rt);
      if (ccd !== rt.ccd) {
        b.enableCcd(ccd);
        rt.ccd = ccd;
      }
      if (rt.keepAwake) b.wakeUp();
    }
    if (this.queue.length === 0) return;
    const q = this.queue;
    this.queue = [];
    q.sort((a, b) => a.id - b.id); // stable: queue order within one entity
    for (const it of q) {
      const b = this.byId.get(it.id)?.body;
      if (!b || !b.isEnabled() || !b.isDynamic()) continue;
      if (it.at) b.applyImpulseAtPoint(it.j, it.at, true);
      else b.applyImpulse(it.j, true);
    }
  }

  /** Impulses queued and not yet applied (in queue order), for tests and the dev panel. */
  pendingImpulses(): readonly { id: number; j: V3; at: V3 | null }[] {
    return this.queue.map((x) => ({ id: x.id, j: copyV3(x.j), at: x.at ? copyV3(x.at) : null }));
  }

  // -------------------------------------------------------------------------
  // Phase 18
  // -------------------------------------------------------------------------

  /**
   * Phase 18, in id order: prevPose ← the pose at the last mirror; pose and velocities from an enabled body (the f32
   * values Rapier returns; a fixed body's velocities are zero); restTicks counts ticks in which no point of the body
   * moves faster than PHYSICS_TUNING.restSpeed (|v| + |ω| × reach), and is 0 without an enabled body; a generated
   * entity whose pose leaves its generated pose by more than ENTITY_TUNING.touchedMoveM or touchedTurnDeg is touched;
   * age advances by DT (every entity is active in M1; a frozen one ages when it wakes, M3).
   */
  mirror(): void {
    const restSpeed = PHYSICS_TUNING.restSpeed;
    for (const e of this.sorted) {
      const rt = this.rt.get(e.id)!;
      e.prevPose = rt.last;
      const b = e.body;
      if (b && b.isEnabled()) {
        e.pose = readPose(b);
        if (b.isDynamic()) {
          e.vel = { lin: copyV3(b.linvel()), ang: copyV3(b.angvel()) };
          const speed = norm(e.vel.lin) + norm(e.vel.ang) * rt.reach;
          e.restTicks = speed < restSpeed ? e.restTicks + 1 : 0;
        } else {
          e.vel = { lin: zero(), ang: zero() };
          e.restTicks++;
        }
      } else {
        e.restTicks = 0;
      }
      rt.last = copyPose(e.pose);
      if (rt.genPose && !e.touched && movedFrom(rt.genPose, e.pose)) e.touched = true;
      if (e.touched) rt.genPose = null;
      if (e.state !== 'frozen') e.age += DT;
    }
  }

  // -------------------------------------------------------------------------
  // Save records (§8.3)
  // -------------------------------------------------------------------------

  /** Every non-generated entity and every touched generated one, in id order (§8.3). */
  toRecord(): EntityRecV1[] {
    const out: EntityRecV1[] = [];
    for (const e of this.sorted) if (!e.generated || e.touched) out.push(recordOf(e));
    return out;
  }

  /** Generated ids no longer present, sorted. */
  removedGenerated(): number[] {
    return [...this.removedGen].sort((a, b) => a - b);
  }

  /**
   * The loader's step after generation (§8.3): removes the generated entities in `removed`, then restores every record
   * (a touched generated entity replaces the regenerated one with its id; any other record is added with its id),
   * rebuilding their bodies in id order, awake, at the saved f32 poses and velocities. Joints are not touched: Rapier
   * joints on a rebuilt body go with it, so the joint store's restoreRecord (which runs after this one) rebuilds them.
   * The entity counter is moved past every restored id. Pushes no events.
   */
  restoreRecord(r: EntityRecV1[], removed: number[]): void {
    for (let i = 1; i < r.length; i++) {
      if (!(r[i].id > r[i - 1].id)) throw new Error('EntityStore.restoreRecord: records must be in strictly increasing id order');
    }
    for (const id of [...removed].sort((a, b) => a - b)) {
      const e = this.byId.get(id);
      if (e) this.forget(e);
      this.removedGen.add(id); // remembered even when generation no longer made it, so the next save keeps it
    }
    // Drop the bodies being replaced (id order), then rebuild every restored body (id order).
    for (const rec of r) {
      const old = this.byId.get(rec.id);
      if (old) this.forget(old);
      this.removedGen.delete(rec.id);
    }
    const restored: Entity[] = [];
    for (const rec of r) {
      checkShape(rec.shape, `record ${rec.id}`);
      if (!MATERIALS[rec.material]) throw new Error(`EntityStore.restoreRecord: unknown material ${rec.material} in record ${rec.id}`);
      const e = entityFromRecord(rec);
      const rt = runtimeFor(e, null);
      rt.last = copyPose(e.pose);
      if (e.generated && !e.touched) rt.genPose = copyPose(e.pose);
      this.insert(e, rt);
      restored.push(e);
    }
    // Rapier body order after a load: the restored bodies are created after the untouched generated ones kept from
    // generation (and may take slots their dropped generated bodies freed), so Rapier's arena order differs from that of
    // the world that saved. Two loads of one save build the same order and stay bit-identical to each other; a loaded
    // world matches the saved one within SPEC:730's 1 cm and 1° at rest, not bit for bit.
    for (const e of restored) this.makeBody(e, this.rt.get(e.id)!, true);
    const ids = this.world.ids.entity;
    for (const e of restored) if (e.id >= ids.next) ids.next = e.id + 1;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private own(e: Entity, what: string): void {
    if (this.byId.get(e.id) !== e) throw new Error(`EntityStore.${what}: entity ${e.id} is not in this store`);
  }

  private insert(e: Entity, rt: Runtime): void {
    this.byId.set(e.id, e);
    this.rt.set(e.id, rt);
    const s = this.sorted;
    if (s.length === 0 || s[s.length - 1].id < e.id) s.push(e);
    else {
      let lo = 0;
      let hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s[mid].id < e.id) lo = mid + 1;
        else hi = mid;
      }
      s.splice(lo, 0, e);
    }
    this.snapshot = null;
  }

  /** Drops the body and the record (no joint release, no event). */
  private forget(e: Entity): void {
    this.dropBody(e);
    this.byId.delete(e.id);
    this.rt.delete(e.id);
    const i = this.sorted.indexOf(e);
    if (i >= 0) this.sorted.splice(i, 1);
    this.snapshot = null;
    if (e.generated) this.removedGen.add(e.id);
  }

  /**
   * Moves the entity to state `s` and its body to match. `force`: run even when the state is unchanged (anchor() with
   * a new depth, unanchor() of a free entity).
   */
  private transition(e: Entity, s: EntityState, force = false): void {
    const rt = this.rt.get(e.id)!;
    if (!force && e.state === s && e.shape === rt.shape) return;
    if (s !== 'anchored') e.anchor = null;
    // A new kind of body has not rested yet (an unanchored stake is no longer ground for World.supportAt).
    if (bodyKindOf(s) !== bodyKindOf(e.state)) e.restTicks = 0;
    e.state = s;
    if (bodyKindOf(s) === 'fixed') e.vel = { lin: zero(), ang: zero() };
    if (e.shape !== rt.shape) this.rebuildShape(e, rt);
    this.syncBody(e, rt);
    this.readBack(e);
    e.touched = true;
  }

  /** The shape object changed under the store (a caller replaced e.shape): rebuild from it. */
  private rebuildShape(e: Entity, rt: Runtime): void {
    checkShape(e.shape, `entity ${e.id}`);
    e.mass = shapeMass(e.shape, MATERIALS[e.material]);
    const fresh = runtimeFor(e, rt);
    rt.shape = fresh.shape;
    rt.reach = fresh.reach;
    rt.minHalf = fresh.minHalf;
    if (e.body && e.collider) {
      this.world.physics.unregister(e.collider);
      this.world.physics.rapier.removeCollider(e.collider, true);
      e.collider = this.makeCollider(e, e.body);
      e.body.recomputeMassPropertiesFromColliders();
      this.refreshReach(e, e.body);
    }
  }

  /** Makes the body match the state: create, switch type, enable or disable, or drop it. */
  private syncBody(e: Entity, rt: Runtime): void {
    const want = bodyKindOf(e.state);
    if (want === 'none') {
      this.dropBody(e);
      return;
    }
    if (!e.body) {
      this.makeBody(e, rt, true);
      return;
    }
    const b = e.body;
    const key = ownerKey(ownerOf(e));
    const type = want === 'fixed' ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic;
    if (b.bodyType() !== type) {
      b.setBodyType(type, true);
      this.configure(e, b, rt);
      this.world.physics.resetHistory(key);
    }
    if (want === 'disabled') {
      if (b.isEnabled()) b.setEnabled(false);
      return;
    }
    if (!b.isEnabled()) {
      // Back from the hands: the body jumps to the record pose (the verbs kept it at the hand) with the record velocity.
      b.setTranslation(e.pose.p, false);
      b.setRotation(e.pose.q, false);
      if (want === 'dynamic') {
        b.setLinvel(e.vel.lin, false);
        b.setAngvel(e.vel.ang, false);
      }
      b.setEnabled(true);
      this.world.physics.resetHistory(key);
    }
    if (want === 'dynamic') b.wakeUp();
  }

  /**
   * Creates the body and collider at the record pose and velocity, and registers the collider's owner. `reset`: the
   * owner key may have a pose history from an earlier body (a rebuild), so it is reset.
   */
  private makeBody(e: Entity, rt: Runtime, reset: boolean): void {
    const want = bodyKindOf(e.state);
    if (want === 'none') return;
    const fixed = want === 'fixed';
    const desc = fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(e.pose.p.x, e.pose.p.y, e.pose.p.z).setRotation(e.pose.q);
    if (!fixed) {
      const t = PHYSICS_TUNING;
      rt.ccd = this.wantsCcd(e, rt);
      desc
        .setLinvel(e.vel.lin.x, e.vel.lin.y, e.vel.lin.z)
        .setAngvel(e.vel.ang)
        .setLinearDamping(t.entityLinDamp)
        .setAngularDamping(t.entityAngDamp)
        .setAdditionalSolverIterations(t.entityExtraSolverIters)
        .setCanSleep(true)
        .setCcdEnabled(rt.ccd);
      if (want === 'disabled') desc.setEnabled(false);
    } else rt.ccd = false;
    const body = this.world.physics.rapier.createRigidBody(desc);
    e.body = body;
    e.collider = this.makeCollider(e, body);
    this.refreshReach(e, body);
    if (reset) this.world.physics.resetHistory(ownerKey(ownerOf(e)));
  }

  /**
   * The entity's collider on `body`: its material's density and friction, the ENTITY groups (a fresh piece's grace
   * filter while `e.grace` is set, §2.11, §4.10), its events; registered under the entity's owner.
   */
  private makeCollider(e: Entity, body: RAPIER.RigidBody): RAPIER.Collider {
    const d = colliderDesc(e.shape, MATERIALS[e.material])
      .setCollisionGroups(entityCollisionGroups(e))
      .setSolverGroups(solverGroups('ENTITY'));
    if (body.isDynamic()) {
      d.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
      d.setContactForceEventThreshold(PHYSICS_TUNING.forceEventThresholdN);
    } else d.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const c = this.world.physics.rapier.createCollider(d, body);
    this.world.physics.register(c, ownerOf(e));
    return c;
  }

  /** The rest test's radius from the body's current centre of mass (call after the mass properties are up to date). */
  private refreshReach(e: Entity, body: RAPIER.RigidBody): void {
    const rt = this.rt.get(e.id);
    if (rt) rt.reach = shapeRadius(e.shape) + norm(body.localCom());
  }

  /** A body that just switched type gets that type's settings (dynamic: iterations, damping, CCD, force events). */
  private configure(e: Entity, b: RAPIER.RigidBody, rt: Runtime): void {
    const c = e.collider;
    if (b.isDynamic()) {
      const t = PHYSICS_TUNING;
      b.setLinearDamping(t.entityLinDamp);
      b.setAngularDamping(t.entityAngDamp);
      b.setAdditionalSolverIterations(t.entityExtraSolverIters);
      rt.ccd = this.wantsCcd(e, rt);
      b.enableCcd(rt.ccd);
      if (c) {
        c.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
        c.setContactForceEventThreshold(t.forceEventThresholdN);
      }
    } else {
      b.enableCcd(false);
      rt.ccd = false;
      if (c) c.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    }
  }

  private dropBody(e: Entity): void {
    if (e.collider) this.world.physics.unregister(e.collider);
    if (e.body) this.world.physics.rapier.removeRigidBody(e.body);
    e.body = null;
    e.collider = null;
  }

  /** The record pose (and velocities for an enabled body) from the body, as the f32 values Rapier holds. */
  private readBack(e: Entity): void {
    const b = e.body;
    if (!b || !b.isEnabled()) return;
    e.pose = readPose(b);
    e.vel = b.isDynamic() ? { lin: copyV3(b.linvel()), ang: copyV3(b.angvel()) } : { lin: zero(), ang: zero() };
  }

  /** CCD: a small body (smallest half-extent < ccdMinHalfExtent), a thrown one, a falling trunk (§2.3, SPEC:267). */
  private wantsCcd(e: Entity, rt: Runtime): boolean {
    return rt.minHalf < PHYSICS_TUNING.ccdMinHalfExtent || e.thrown !== null || e.plant?.phase === 'falling';
  }

  /** Live tuning: when a PHYSICS_TUNING body value changed (a `setTuning` command in phase 1c), every dynamic body gets it. */
  private applyBodyTuning(): void {
    const now = bodyTuningNow();
    const was = this.applied;
    if (was.iters === now.iters && was.linDamp === now.linDamp && was.angDamp === now.angDamp && was.forceN === now.forceN) return;
    this.applied = now;
    for (const e of this.sorted) {
      const b = e.body;
      if (!b || !b.isDynamic()) continue;
      b.setAdditionalSolverIterations(now.iters);
      b.setLinearDamping(now.linDamp);
      b.setAngularDamping(now.angDamp);
      e.collider?.setContactForceEventThreshold(now.forceN);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
const zero = (): V3 => ({ x: 0, y: 0, z: 0 });
const copyV3 = (v: { x: number; y: number; z: number }): V3 => ({ x: v.x, y: v.y, z: v.z });
const copyQuat = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const copyPose = (p: Pose3): Pose3 => ({ p: copyV3(p.p), q: copyQuat(p.q) });
const norm = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z);
const finiteV3 = (v: V3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const byId = (a: Entity, b: Entity): number => a.id - b.id;
const ownerOf = (e: Entity): Owner => ({ kind: 'entity', id: e.id });

/** An entity collider's collision groups: ENTITY, or a fresh piece's grace filter while `e.grace` is set (§2.11). */
const entityCollisionGroups = (e: Entity): number => (e.grace ? pieceGraceCollisionGroups() : collisionGroups('ENTITY'));

function readPose(b: RAPIER.RigidBody): Pose3 {
  const t = b.translation();
  const r = b.rotation();
  return { p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w } };
}

/** The unit quaternion of `q` (identity when absent). */
function unitQuat(q: Quat | undefined): Quat {
  if (!q) return { x: 0, y: 0, z: 0, w: 1 };
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error('EntityStore: a rotation must be a non-zero, finite quaternion');
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** v rotated by the unit quaternion q. */
function rotate(q: Quat, v: V3): V3 {
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Whether `p` left `from` by more than ENTITY_TUNING.touchedMoveM or turned by more than touchedTurnDeg. */
function movedFrom(from: Pose3, p: Pose3): boolean {
  const d = Math.hypot(p.p.x - from.p.x, p.p.y - from.p.y, p.p.z - from.p.z);
  if (d > ENTITY_TUNING.touchedMoveM) return true;
  const dot = Math.abs(from.q.x * p.q.x + from.q.y * p.q.y + from.q.z * p.q.z + from.q.w * p.q.w);
  const angle = 2 * Math.acos(Math.min(1, dot));
  return angle > (ENTITY_TUNING.touchedTurnDeg * Math.PI) / 180;
}

function bodyTuningNow(): BodyTuning {
  const t = PHYSICS_TUNING;
  return { iters: t.entityExtraSolverIters, linDamp: t.entityLinDamp, angDamp: t.entityAngDamp, forceN: t.forceEventThresholdN };
}

function anchorOf(depthM: number): { depthM: number; capacityN: number } {
  return { depthM, capacityN: depthM * VERB_TUNING.anchorHoldNPerM };
}

/** The load history's length: LOAD_TUNING.loadWindowS of ticks (12, §4.11). */
function loadHistLength(): number {
  return Math.max(1, Math.round(LOAD_TUNING.loadWindowS / DT));
}

/** Player ids, sorted (code-unit order) and de-duplicated (SPEC:186, 473). */
function normCredit(c: readonly string[]): string[] {
  return [...new Set(c)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function runtimeFor(e: Entity, prev: Runtime | null): Runtime {
  return {
    ccd: prev?.ccd ?? false,
    keepAwake: prev?.keepAwake ?? false,
    genPose: prev?.genPose ?? null,
    last: prev?.last ?? copyPose(e.pose),
    shape: e.shape,
    reach: shapeRadius(e.shape),
    minHalf: minHalfExtent(e.shape),
  };
}

/** m: the farthest point of the shape from its local origin. */
function shapeRadius(s: Shape): number {
  switch (s.kind) {
    case 'ball':
      return s.r;
    case 'box':
      return Math.hypot(s.hx, s.hy, s.hz);
    case 'capsule':
      return s.halfHeight + s.r;
    case 'cylinder':
      return Math.hypot(s.r, s.halfHeight);
    case 'hull': {
      let r = 0;
      for (let i = 0; i + 2 < s.points.length; i += 3) r = Math.max(r, Math.hypot(s.points[i], s.points[i + 1], s.points[i + 2]));
      return r;
    }
  }
}

/** m: the shape's smallest half-extent (a prism's across its flats; a hull's smallest local box half-width). */
function minHalfExtent(s: Shape): number {
  switch (s.kind) {
    case 'ball':
    case 'capsule':
      return s.r;
    case 'box':
      return Math.min(s.hx, s.hy, s.hz);
    case 'cylinder':
      return Math.min(s.halfHeight, s.r * Math.cos(Math.PI / s.sides));
    case 'hull': {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 2 < s.points.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], s.points[i + k]);
          hi[k] = Math.max(hi[k], s.points[i + k]);
        }
      }
      return Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
    }
  }
}

function checkSpec(spec: EntitySpec): void {
  if (!MATERIALS[spec.material]) throw new Error(`EntityStore.create: unknown material ${String(spec.material)}`);
  checkShape(spec.shape, 'EntityStore.create');
  if (!finiteV3(spec.p)) throw new Error('EntityStore.create: a non-finite position');
  if ((spec.lin && !finiteV3(spec.lin)) || (spec.ang && !finiteV3(spec.ang))) throw new Error('EntityStore.create: a non-finite velocity');
  if (spec.integrity !== undefined && !(spec.integrity >= 0 && spec.integrity <= 1)) throw new Error(`EntityStore.create: integrity ${spec.integrity} outside 0..1`);
  if (spec.anchorDepthM !== undefined && !(spec.anchorDepthM > 0 && Number.isFinite(spec.anchorDepthM))) throw new Error(`EntityStore.create: bad anchor depth ${spec.anchorDepthM}`);
  unitQuat(spec.q);
}

function checkShape(s: Shape, where: string): void {
  const v = shapeVolume(s);
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`${where}: a ${s.kind} shape with no volume`);
  if (s.kind === 'cylinder' && !(Number.isInteger(s.sides) && s.sides >= 3)) throw new Error(`${where}: a prism needs 3 or more sides`);
}

function copyShape(s: Shape): Shape {
  switch (s.kind) {
    case 'ball':
      return { kind: 'ball', r: s.r };
    case 'box':
      return { kind: 'box', hx: s.hx, hy: s.hy, hz: s.hz };
    case 'capsule':
      return { kind: 'capsule', halfHeight: s.halfHeight, r: s.r };
    case 'cylinder':
      return { kind: 'cylinder', halfHeight: s.halfHeight, r: s.r, sides: s.sides };
    case 'hull':
      return { kind: 'hull', points: [...s.points] };
  }
}

const copySharpPoint = (s: SharpPoint): SharpPoint => ({ local: copyV3(s.local), dir: copyV3(s.dir), sharpness: s.sharpness });

function copyPlant(p: PlantState): PlantState {
  return {
    diameter: p.diameter,
    height: p.height,
    phase: p.phase,
    cut: p.cut ? { fromDir: copyV3(p.cut.fromDir), remaining: p.cut.remaining, chops: p.cut.chops, depthSumM: p.cut.depthSumM } : null,
    stump: p.stump,
    fall: p.fall ? { hinge: copyV3(p.fall.hinge), axis: copyV3(p.fall.axis), torn: p.fall.torn } : null,
  };
}

function copyOwner(o: Owner): Owner {
  switch (o.kind) {
    case 'terrain':
      return { kind: 'terrain' };
    case 'entity':
      return { kind: 'entity', id: o.id };
    case 'rope':
      return { kind: 'rope', joint: o.joint };
    case 'fighter':
      return o.bone === undefined ? { kind: 'fighter', id: o.id, part: o.part } : { kind: 'fighter', id: o.id, part: o.part, bone: o.bone };
  }
}

/** Every saved field of an entity (§2.3, §8.3), as fresh plain data. */
function recordOf(e: Entity): EntityRecV1 {
  return {
    id: e.id,
    material: e.material,
    shape: copyShape(e.shape),
    mass: e.mass,
    state: e.state,
    pose: copyPose(e.pose),
    vel: { lin: copyV3(e.vel.lin), ang: copyV3(e.vel.ang) },
    integrity: e.integrity,
    moisture: e.moisture,
    temperature: e.temperature,
    burning: e.burning,
    sharpPoints: e.sharpPoints.map(copySharpPoint),
    joints: [...e.joints],
    age: e.age,
    credit: [...e.credit],
    look: e.look,
    plant: e.plant ? copyPlant(e.plant) : null,
    anchor: e.anchor ? { depthM: e.anchor.depthM, capacityN: e.anchor.capacityN } : null,
    rope: e.rope ? { lengthM: e.rope.lengthM } : null,
    crossCut: e.crossCut ? { axisT: e.crossCut.axisT, remaining: e.crossCut.remaining, fromDir: copyV3(e.crossCut.fromDir) } : null,
    thrown: e.thrown ? { by: e.thrown.by, tick: e.thrown.tick } : null,
    loadHist: Array.from(e.loadHist),
    restTicks: e.restTicks,
    generated: e.generated,
    touched: e.touched,
    grace: e.grace ? { from: copyOwner(e.grace.from), minUntil: e.grace.minUntil, maxUntil: e.grace.maxUntil } : null,
    releasedBy: e.releasedBy ? { fighter: e.releasedBy.fighter, apartTicks: e.releasedBy.apartTicks } : null,
  };
}

/** An entity from its record (no body yet). */
function entityFromRecord(r: EntityRecV1): Entity {
  const pose = copyPose(r.pose);
  return {
    id: r.id,
    material: r.material,
    shape: copyShape(r.shape),
    mass: r.mass,
    state: r.state,
    pose,
    vel: { lin: copyV3(r.vel.lin), ang: copyV3(r.vel.ang) },
    integrity: r.integrity,
    moisture: r.moisture,
    temperature: r.temperature,
    burning: r.burning,
    sharpPoints: r.sharpPoints.map(copySharpPoint),
    joints: [...r.joints],
    age: r.age,
    credit: [...r.credit],
    look: r.look,
    plant: r.plant ? copyPlant(r.plant) : null,
    anchor: r.anchor ? { depthM: r.anchor.depthM, capacityN: r.anchor.capacityN } : null,
    rope: r.rope ? { lengthM: r.rope.lengthM } : null,
    crossCut: r.crossCut ? { axisT: r.crossCut.axisT, remaining: r.crossCut.remaining, fromDir: copyV3(r.crossCut.fromDir) } : null,
    thrown: r.thrown ? { by: r.thrown.by, tick: r.thrown.tick } : null,
    loadHist: Float32Array.from(r.loadHist),
    restTicks: r.restTicks,
    generated: r.generated,
    touched: r.touched,
    grace: r.grace ? { from: copyOwner(r.grace.from), minUntil: r.grace.minUntil, maxUntil: r.grace.maxUntil } : null,
    releasedBy: r.releasedBy ? { fighter: r.releasedBy.fighter, apartTicks: r.releasedBy.apartTicks } : null,
    body: null,
    collider: null,
    prevPose: copyPose(pose),
  };
}
