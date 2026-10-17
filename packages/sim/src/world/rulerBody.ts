// The ruler's hybrid body (docs/M1-DESIGN.md §1.5.8, §4.7, §4.3): one Rapier body for life, kinematic with 12 sensor
// bone colliders standing and dynamic with solid colliders when tripped; RulerMover (support, slope and step limits,
// climb, shove, block, deflect, trip, ledge), the trip switch, the tripped rig, in-pit, pinned and the get-up.
//
// - The body (§4.7): kinematicPositionBased at the pelvis joint, setCanSleep(true) (fixed at creation, MAP gap-3 §1.3),
//   CCD on; 12 colliders in BONES order with the bone shapes of the zones (world/zones.ts boneZoneShape, the ragdoll's ×
//   scale), each carrying its bone's mass (f.mass × boneShare), friction and restitution from RULER_BODY_TUNING, sensors
//   in RULER_ZONE (ActiveCollisionTypes.ALL, COLLISION_EVENTS), owners { fighter, part 'ruler', bone }. Sensor masses
//   count, so the body weighs f.mass once it is dynamic.
// - Standing (phase 4c): posed from the rig like the zones of players and apes (setNextKinematic* at the pelvis, each
//   collider setTranslationWrtParent/RotationWrtParent), and the collider centres of the last two posings are kept: the
//   previous tick's motion is what a trip carries into the dynamic body (RF-14).
// - RulerMover.resolve (phase 3, the separate() site; §4.7 steps 1-7): the proposal d = f.pos − the last resolved root.
//   Climbing out of a pit relaxes the slope and step limits (step 3); otherwise a rise steeper than maxSlopeDeg or a
//   step over stepUpMaxM is blocked (step 2). A vertical capsule (radius BODY_RADIUS × scale, its straight part from the
//   ankle to the hip) is swept along d against blocking-class entities (fixed, anchored, or ≥ shoveLimitKg) whose top
//   rises above the ankle (lower ones are stepped over, step 4): at the first hit it deflects (under deflectMaxDeg to the
//   obstacle's long axis), trips (faster than tripSpeed into an obstacle whose top lies between its ankle and knee) or is
//   blocked (step 6). The root then stands on its ground (step 1): the terrain, or the top of a fixed, anchored or
//   resting entity no more than the ankle above max(terrain, its own height), so a pit cover is ground while it stands.
//   A root that would drop more than ledgeTripDropFrac × knee height in one tick, or a front foot whose ground lies
//   that far below the planted foot's, trips it 'ledge' (step 7; 'cover' when a support under it broke within
//   coverTripWindowTicks). Shoveable entities (dynamic, < shoveLimitKg, not anchored) the capsule overlaps are pushed
//   aside with the ruler's momentum (step 5), applied in phase 4d (applyShoves). While a trip is pending the root keeps
//   its height (the fall is the dynamic body's).
// - legStrike (phase 9b, from the contact pipeline): a standing ruler's shin that meets a blocker before the capsule
//   does gets step 6's rule for the leg (deflect left to the mover, else the trip band), so the strike trips it before
//   the struck entity breaks or loses its lashings (SPEC:782, 344; a departure from steps 4-6, recorded there).
// - The trip switch (phase 4c, outside every callback): the pose frozen pelvis-relative (tripPose 'freeze'), the colliders
//   solid in RULER_SOLID, the body dynamic with the momentum fit of the zones' previous-tick velocities, damping, extra
//   solver iterations and CCD; the fighter 'tripped' for getupAfterS; a `trip` event; the history reset (RF-1).
// - Phase 13b: the tripped rig from the body (rig = body ∘ frozen local, f.pos the terrain under the pelvis, the pose's
//   root and pelvis re-expressed so CombatSim's forward kinematics reproduces it); in-pit (the ground the root stands on,
//   or the lying pelvis, more than pitDownDepthFrac × knee height below the original ground, RR-1; out again only on the
//   rim: within pitOutDepthFrac of it, off the pit wall; §4.7 says "both planted feet", see updatePit) with a `pit`
//   event; pinned (D-38: the dynamic mass resting on it, transitively, by contact manifolds, with hysteresis) with a
//   `pinned` event; the get-up at getupAfterS when not pinned (light loads shoved off first, sensors again, the yaw that
//   makes kneeling shortest, a getupFrames rise through `kneel` that ends in a riseBlendFrames blend into the stance, a
//   `rise` event, the history reset and a contact grace, RF-1); and, for a standing ruler, cover failure: a support that
//   vanished under it (a load break, §4.11) is remembered as the cause of a 'cover' trip, which it requests at once when
//   the drop under its feet is beyond the ledge threshold (step 8).
// - The save (RR-19, §8.3 bodies[].ruler): the body's pose and velocity (0 standing: Rapier derives a kinematic body's
//   from the next pose), the frozen local pose, the pose history, sleep, and the mover's memory (climb floor, deflection,
//   supports, cover break); restoreRecord puts it back kinematic or dynamic.
// - A ruler knocked out standing collapses: the same switch, no `trip` event; its corpse stays (world/deaths.ts).
// - Footfalls: the mover empties footwork.landed before the footwork runs, so it holds the feet set down this tick, as
//   the KCC does for players: the noise bus hears them as the giant's footsteps (§6.2, 6 × scale walking) and the
//   client shakes and thuds from the footwork (SPEC:849). No `land` event: that is a body coming down, which the noise
//   bus hears as a heavy landing by its mass (≈ 120 m for a 2 t leg) and the client draws as a fall.
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { boolFromRecord, numFromRecord } from '../body/animator';
import { getPose } from '../body/poses';
import { ANKLE_HEIGHT, BONES, type BoneName, bonePoint, type Rig, SKELETON } from '../body/skeleton';
import type { RulerBodyRecV1 } from '../save/schema';
import type { Fighter } from '../sim/fighter';
import { DT } from '../sim/math';
import { RULER_TUNING } from '../sim/ruler';
import { DAMAGE_TUNING } from '../sim/rules';
import { defineTuning } from '../tuning/registry';
import { collisionGroups, solverGroups } from './groups';
import { compareOwners, ownerKey, PHYSICS_TUNING } from './physics';
import { cylinderPoints, principalAxis } from './shapes';
import type { Entity, FighterMover, ImpactCause, Pose3, Quat, RulerState, TripWhy, V3 } from './types';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';
import { boneZoneDesc, boneZoneShape } from './zones';

export const RULER_BODY_TUNING = defineTuning(
  'RULER_BODY_TUNING',
  'Ruler › body',
  {
    tripSpeed: 4,
    getupAfterS: 4,
    shoveLimitKg: 500,
    deflectMaxDeg: 30,
    impactTripMinKg: 500,
    sweepSkinM: 0.05,
    ledgeTripDropFrac: 0.5,
    getupFrames: 94,
    getupKneelFrame: 52,
    trippedLinDamp: 0.1,
    trippedAngDamp: 1,
    trippedExtraIters: 4,
    tripPose: 'freeze' as 'freeze',
    friction: 0.9,
    restitution: 0.05,
    stepUpMaxM: 1.0,
    maxSlopeDeg: 40,
    climbRateMps: 0.4,
    climbWalkMps: 0.5,
    climbMaxM: 4.5,
    pitDownDepthFrac: 0.5,
    coverTripWindowTicks: 30,
    // Not §9.1 rows (P11): values §4.7 gives in prose or leaves open, kept here so the file holds no bare constants.
    climbLookM: 3,
    pitOutDepthFrac: 0.15,
    deflectAxisMinXZ: 0.5,
    getupShoveMps: 2,
    riseBlendFrames: 40,
    slideGrazeDeg: 2,
  },
  {
    tripSpeed: { unit: 'm/s (root horizontal)', source: 'SPEC:782, 879; D-10' },
    getupAfterS: { unit: 's', source: 'SPEC:782, 879' },
    shoveLimitKg: { unit: 'kg', source: 'SPEC:781, 880' },
    deflectMaxDeg: { unit: '°', source: 'SPEC:781' },
    impactTripMinKg: { unit: 'kg', source: 'SPEC:879 (blocking class)' },
    sweepSkinM: { unit: 'm', source: 'NEW' },
    ledgeTripDropFrac: { unit: '× knee height (1.4 m)', source: 'NEW: D-9 (e)' },
    getupFrames: { unit: 'frames', source: 'NEW: 40·√5.5, MAP gap-3 §2.3' },
    getupKneelFrame: { unit: 'frame', source: 'NEW: DS 0.55 of the track' },
    trippedLinDamp: { unit: '1/s', source: 'NEW: orchestrator decision 5, MAP gap-3' },
    trippedAngDamp: { unit: '1/s', source: 'NEW: orchestrator decision 5' },
    trippedExtraIters: { unit: 'iterations', source: 'NEW: MAP gap-3' },
    tripPose: { unit: '—', source: 'NEW: MAP gap-3', options: ['freeze'] },
    friction: { unit: '—', source: 'NEW' },
    restitution: { unit: '—', source: 'NEW' },
    stepUpMaxM: { unit: 'm per tick', source: "NEW: the ruler nav layer's climb (RR-1, RF-14)" },
    maxSlopeDeg: { unit: '°', source: "NEW: the ruler nav layer's slope (RR-1)" },
    climbRateMps: { unit: 'm/s', source: 'NEW: climbing out of a pit (3 m max dig + 1 m berm < 4.5 m) (RR-1)' },
    climbWalkMps: { unit: 'm/s', source: 'NEW: climbing out of a pit (RR-1)' },
    climbMaxM: { unit: 'm', source: 'NEW: climbing out of a pit (3 m max dig + 1 m berm < 4.5 m) (RR-1)' },
    pitDownDepthFrac: { unit: '× knee height (1.4 m)', source: 'NEW: "in a pit" (SPEC:504), the ledge threshold (RR-1)' },
    coverTripWindowTicks: { unit: 'ticks', source: "NEW: a ledge trip this soon after a cover load break is a 'cover' trip (RT-1)" },
    climbLookM: { unit: 'm', source: 'NEW: §4.7 step 3 ("a support no more than climbMaxM above the pit floor within 3 m ahead")' },
    pitOutDepthFrac: {
      unit: '× knee height (0.41 m)',
      source:
        "NEW: \"down until it has climbed out\" (SPEC:504, RR-1): once in a pit, the ruler is out only when it stands within this of the original ground on ground no steeper than maxSlopeDeg (the rim, not the pit wall it is climbing)",
    },
    deflectAxisMinXZ: {
      unit: 'horizontal share of the axis',
      source: "NEW: §4.7 step 6.1: an obstacle whose long axis is steeper than this (an upright trunk or stake) is round, deflecting along the tangent ⟂ n̂",
    },
    getupShoveMps: {
      unit: 'm/s',
      source: "NEW: §4.7 get-up: light bodies resting on the ruler are shoved off at this speed before its colliders turn to sensors (MAP gap-3 §3.5)",
    },
    slideGrazeDeg: {
      unit: '°',
      source:
        "NEW: §4.7 step 6.1's slide: a blocker whose surface the slide moves into by no more than this is grazed, not met (the capsule ends a deflection touching the face; Rapier's grazing hits on it came 0.6° off the face and stalled a 25° slide mid-wall)",
      min: 0,
    },
    riseBlendFrames: {
      unit: 'frames',
      source:
        "NEW: the blend from the rise's last key into the ruler's own stance (DS's 4-frame fade swings a 5.5× arm at 88 m/s, over AC-5's 30 m/s; with 40 frames the blend peaks at 8.3 m/s, and the fastest part of the whole rise is 12.6 m/s, through the kneel; measured on AC-5's fixture log)",
    },
  },
);

/** m: the ruler's ankle above its ground (the skeleton's ankle × scale; 0.39 m at 5.5): what it steps over and onto. */
export function rulerAnkleM(f: Fighter): number {
  return ANKLE_HEIGHT * f.scale;
}

/** m: the ruler's standing knee height (shin + ankle × scale; 2.75 m at 5.5): the ledge and in-pit scale. */
export function rulerKneeM(f: Fighter): number {
  return (SKELETON.shinL.length + ANKLE_HEIGHT) * f.scale;
}

/** m: the ruler's standing hip height (thigh + shin + ankle × scale; 5.17 m at 5.5): the top of the mover's sweep. */
export function rulerHipM(f: Fighter): number {
  return (SKELETON.thighL.length + SKELETON.shinL.length + ANKLE_HEIGHT) * f.scale;
}

/** One ruler's body and the state of its mover and its trips. */
interface RulerBody {
  readonly f: Fighter;
  readonly body: RAPIER.RigidBody;
  /** BONES order. */
  readonly cols: RAPIER.Collider[];
  /** Each collider's offset in its bone's frame (m, × scale), BONES order. */
  readonly offs: V3[];
  readonly keys: string[];
  /** Tripped, or a corpse: the body is dynamic and its colliders solid. */
  dynamic: boolean;
  /** While dynamic: each bone's frame relative to the body (the pelvis frame frozen at the trip), BONES order. */
  local: Pose3[] | null;
  /** Collider centres (world, 3 numbers a bone in BONES order) at the last two posings: [last, the one before]. */
  hist: [number[], number[]] | null;
  /** The next phase 4c puts the body at its pose at once and fills the history with it (an enable, a teleport, a load). */
  jump: boolean;
  /** The root after the last resolve: the start of this tick's proposal (f.pos at every tick end for a standing ruler). */
  readonly last: Vector3;
  /** The root's height when the climb out of a pit began (climbMaxM is measured from it), or null. */
  climbFloor: number | null;
  /** The obstacle it last deflected along, and when (a `deflect` event marks the start of a slide, not every tick). */
  deflect: { entity: number; tick: number } | null;
  /** Entities that held up its root or a foot lately, by id: the tick last seen and their credit (cover failure, step 8). */
  readonly supports: Map<number, { tick: number; credit: string[] }>;
  /** The last support that vanished under it (a load break): a ledge trip this soon after it is a 'cover' trip. */
  coverBreak: { tick: number; cause: ImpactCause } | null;
  /**
   * The root's horizontal velocity as the last resolve proposed it (m/s; after the slope limit and the climb's cap, before
   * the sweep), and that tick: legStrike reads it in phase 9 of the same tick (any other tick's reads as still).
   */
  move: { tick: number; x: number; z: number };
}

/** A shove queued in phase 3 for phase 4d (§4.7 step 5). */
interface Shove {
  readonly f: Fighter;
  readonly entity: number;
  readonly j: V3;
}

const DEG = Math.PI / 180;
const DOWN: Readonly<V3> = Object.freeze({ x: 0, y: -1, z: 0 });
const ZERO3: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
const IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const Y_AXIS = new Vector3(0, 1, 0);
const SIDES = ['L', 'R'] as const;
/** A length below this is no length (a numerical device of the geometry, not a starting value). */
const TINY = 1e-9;

const _q = new Quaternion();
const _qi = new Quaternion();
const _p = new Vector3();
const _o = new Vector3();
const _a = new Vector3();
const _n: V3 = { x: 0, y: 1, z: 0 };

export class RulerBodies {
  readonly world: World;
  /** RulerMover: CombatSim's mover for a standing ruler (§4.7). */
  readonly mover: FighterMover;
  private readonly byId = new Map<number, RulerBody>();
  /** Shoves found in phase 3, applied in phase 4d of the same tick (empty at every tick end). */
  private shoves: Shove[] = [];

  constructor(world: World) {
    this.world = world;
    this.mover = { resolve: (f, radius) => this.resolve(f, radius) };
  }

  /** The body at the rig's pelvis with the 12 bone sensors where the rig has its bones (CombatSim.add posed the rig). */
  create(f: Fighter): void {
    if (this.byId.has(f.id)) throw new Error(`RulerBodies.create: fighter ${f.id} already has a ruler body`);
    const T = RULER_BODY_TUNING;
    const physics = this.world.physics;
    const pelvis = f.rig.pelvis;
    const body = physics.rapier.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pelvis.pos.x, pelvis.pos.y, pelvis.pos.z)
        .setRotation({ x: pelvis.rot.x, y: pelvis.rot.y, z: pelvis.rot.z, w: pelvis.rot.w })
        .setCanSleep(true)
        .setCcdEnabled(true),
    );
    const cols: RAPIER.Collider[] = [];
    const offs: V3[] = [];
    const keys: string[] = [];
    for (const b of BONES) {
      const shape = boneZoneShape(b, f.scale);
      const local = localPose(f.rig, b, shape.off);
      const desc = boneZoneDesc(shape)
        .setMass(f.mass * f.boneShare[b])
        .setFriction(T.friction)
        .setRestitution(T.restitution)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('RULER_ZONE'))
        .setSolverGroups(solverGroups('RULER_ZONE'))
        .setTranslation(local.p.x, local.p.y, local.p.z)
        .setRotation(local.q);
      const col = physics.rapier.createCollider(desc, body);
      const owner = { kind: 'fighter' as const, id: f.id, part: 'ruler' as const, bone: b };
      physics.register(col, owner);
      cols.push(col);
      offs.push(shape.off);
      keys.push(ownerKey(owner));
    }
    this.byId.set(f.id, {
      f,
      body,
      cols,
      offs,
      keys,
      dynamic: false,
      local: null,
      hist: null,
      jump: true,
      last: f.pos.clone(),
      climbFloor: null,
      deflect: null,
      supports: new Map(),
      coverBreak: null,
      move: { tick: -1, x: 0, z: 0 },
    });
  }

  remove(f: Fighter): void {
    const rb = this.byId.get(f.id);
    if (!rb) return;
    this.byId.delete(f.id);
    const physics = this.world.physics;
    for (const c of rb.cols) physics.unregister(c);
    physics.rapier.removeRigidBody(rb.body);
    this.shoves = this.shoves.filter((s) => s.f !== f);
  }

  /**
   * A trip for the next phase 4c (this tick's, when asked in phase 3). Ignored while tripped or out, and while another
   * trip is pending (the first one stands). A 'ledge' within coverTripWindowTicks of a support breaking under this ruler
   * is that cover's trip (`'cover'`, with its cause; RT-1).
   */
  requestTrip(f: Fighter, why: TripWhy, cause: ImpactCause | null): void {
    const r = f.ruler;
    if (!r || f.state === 'tripped' || f.state === 'ko' || r.pendingTrip) return;
    const tick = this.world.tick;
    let w = why;
    let c = cause;
    const cb = this.byId.get(f.id)?.coverBreak;
    if (why === 'ledge' && cb && tick - cb.tick <= RULER_BODY_TUNING.coverTripWindowTicks) {
      w = 'cover';
      c = cb.cause;
    }
    r.pendingTrip = { why: w, tick, cause: c ? copyCause(c) : null };
  }

  /**
   * A standing ruler's shin met entity `e` (a new contact episode, phase 9b; `point` the contact, `n` its normal out of
   * the shin): §4.7 step 6's rule for the leg itself, in D-11's order, at the root speed this tick's resolve proposed
   * (after the slope limit and the climb's cap). A blocker (fixed, anchored, ≥ shoveLimitKg; not a fresh piece) whose
   * long axis lies within deflectMaxDeg of the motion (a round one: its tangent ⟂ n̂) is left to the mover, which
   * deflects along it; otherwise, while the root moves faster than tripSpeed, an obstacle whose top lies between the
   * ankle and the knee trips it 'obstacle', with the obstacle as the cause. Anything else (slow, a low or tall obstacle,
   * a light one) is the mover's.
   * DEVIATION (§4.7 steps 4-6 decide the trip from the root's capsule sweep alone): SPEC:782 trips a ruler "when its
   * legs strike a blocking obstacle between ankle and knee height while it moves faster than 4 m/s", and a striding
   * shin reaches an obstacle before the 1.65 m capsule does (AC-5's log: 0.34 m, 3-4 ticks ahead at 6 m/s). By then the
   * strike has been scored on the obstacle (§4.10): a 300 kg dry log takes 18.5 kJ from an 859 kg shin at 6.56 m/s
   * against its 9 kJ break energy and breaks into 100 kg pieces the capsule shoves aside, and a lashed log loses its
   * lashings (600 J), so it is no blocker either. The strike trips the ruler before the struck entity breaks, as an
   * impact's damage is applied before it breaks (SPEC:344).
   */
  legStrike(f: Fighter, e: Entity, point: V3, n: V3): void {
    const rb = this.byId.get(f.id);
    const r = f.ruler;
    if (!rb || !r || rb.dynamic || f.state === 'tripped' || f.state === 'ko' || r.pendingTrip) return;
    // A blocker whose top rises above its ankle (lower ones are stepped over, step 4), as the sweep's castBlocker.
    if (e.grace || !this.blocks(e) || !(entityTop(e) > f.pos.y + rulerAnkleM(f))) return;
    const T = RULER_BODY_TUNING;
    // v: the root's speed as this tick's phase 3 resolved it (after the slope limit and the climb's cap), as step 6.2
    // reads it; a climbing giant driven fast moves at climbWalkMps.
    const m = rb.move;
    const v = m.tick === this.world.tick ? Math.hypot(m.x, m.z) : 0;
    if (!(v > T.tripSpeed)) return;
    const ux = m.x / v;
    const uz = m.z / v;
    // 6.1: along the obstacle, the mover deflects it when its capsule meets it. A long obstacle is judged by its axis
    // against the motion alone (the normal of a shin's first touch may be vertical, or the motion itself when they began
    // overlapped); a round one by the tangent ⟂ n̂ (n̂ horizontal, from the leg into it; the motion when it has none).
    const axis = longAxisXZ(e);
    let t: { x: number; z: number };
    if (axis) t = axis;
    else {
      const nl = Math.hypot(n.x, n.z);
      t = nl > TINY ? { x: -n.z / nl, z: n.x / nl } : { x: -uz, z: ux };
    }
    const cos = Math.min(1, Math.abs(t.x * ux + t.z * uz));
    if (Math.acos(cos) < T.deflectMaxDeg * DEG) return;
    // 6.2: an obstacle whose top lies between the ankle and the knee.
    const top = entityTop(e) - this.world.terrain.heightAt(point.x, point.z);
    const band = legBand(f, f.pos.y);
    if (top >= band.ankle && top <= band.knee) {
      this.requestTrip(f, 'obstacle', { kind: 'entity', entityId: e.id, fighterId: null, credit: [...e.credit], held: false, feature: 'fall' });
    }
  }

  /**
   * Phase 4c, in fighter order: a ruler knocked out standing collapses; a pending trip switches the body to dynamic;
   * a standing or rising ruler's zones are posed from the rig (§4.7).
   */
  preStep(w: World): void {
    for (const f of w.combat.fighters) {
      const rb = this.byId.get(f.id);
      if (!rb) continue;
      const r = f.ruler;
      if (rb.dynamic) {
        if (r) r.pendingTrip = null;
        continue;
      }
      if (f.state === 'ko') {
        if (r) r.pendingTrip = null;
        this.goDynamic(f, rb);
        this.resetHistory(f);
        continue;
      }
      if (r?.pendingTrip) {
        this.trip(w, f, rb, r);
        continue;
      }
      this.poseStanding(f, rb);
    }
  }

  /** Phase 4d: the shoves of this tick's phase 3, in (fighter, entity) order, each with a `shove` event. */
  applyShoves(): void {
    if (this.shoves.length === 0) return;
    const q = this.shoves;
    this.shoves = [];
    const w = this.world;
    for (const s of q) {
      const b = w.entities.get(s.entity)?.body;
      if (!b || !b.isEnabled() || !b.isDynamic()) continue;
      b.applyImpulse(s.j, true);
      w.events.push({ type: 'shove', ruler: s.f, entity: s.entity });
    }
  }

  /**
   * Phase 13b, in fighter order: a dynamic ruler's rig from its body; in-pit; pinned and the get-up while tripped; a
   * standing ruler's cover failure (§4.7 step 8).
   */
  postStep(w: World): void {
    for (const f of w.combat.fighters) {
      const rb = this.byId.get(f.id);
      const r = f.ruler;
      if (!rb || !r) continue;
      if (rb.dynamic) {
        this.rigFromBody(w, f, rb);
        if (f.state !== 'tripped') continue;
        this.updatePit(w, f, rb, r);
        const load = this.restingLoad(rb);
        const was = r.pinned;
        stepPinned(r, load.kg);
        if (r.pinned !== was) {
          w.events.push({ type: 'pinned', f, on: r.pinned });
          if (r.pinned) this.pinnedBy(w, r, load.entities);
        }
        if (f.stateFrame >= f.stunFrames && !r.pinned) this.getUp(w, f, rb, load.entities);
      } else {
        // The rise's last frame: into the ruler's own stance over riseBlendFrames instead of DS's 4-frame fade (which
        // CombatSim's advance would start next tick), so the end of the rise is as slow as the rise (AC-5's 30 m/s).
        if (f.state === 'getup' && f.stateFrame >= f.stunFrames - 1) f.enterLocomotion(RULER_BODY_TUNING.riseBlendFrames);
        this.updatePit(w, f, rb, r);
        if (f.state !== 'ko') this.coverFailure(w, f, rb);
      }
    }
  }

  /**
   * As ZoneBodies.resetHistory (§4.3, RF-1): the colliders' pose history is the current pose (carryV 0), the next phase
   * 4c puts a standing body at its pose at once, the mover's proposal starts from where the fighter is, and the
   * fighter's contacts get a grace of DAMAGE_TUNING.zoneGraceTicks from the next tick. Called on creation's first pose,
   * World.teleport, both directions of the trip switch, and a load.
   */
  resetHistory(f: Fighter): void {
    const rb = this.byId.get(f.id);
    if (!rb) return;
    for (const k of rb.keys) this.world.physics.resetHistory(k);
    rb.jump = true;
    rb.last.copy(f.pos);
    this.world.contacts.grace(f.id, this.world.tick + 1 + DAMAGE_TUNING.zoneGraceTicks);
  }

  /**
   * m: the highest support above the terrain World.teleport stands a ruler on: its ankle (rulerAnkleM). A fighter with a
   * RulerState and no ruler body (a test's stand-in, which the mover also leaves alone) has no cap: Infinity.
   */
  ankleM(f: Fighter): number {
    return this.byId.has(f.id) ? rulerAnkleM(f) : Infinity;
  }

  /** Whether the fighter's ruler body is dynamic (tripped, or a corpse). */
  isDynamic(f: Fighter): boolean {
    return this.byId.get(f.id)?.dynamic ?? false;
  }

  /** Read-only (client, tests): the ruler body's pose as Rapier holds it, else null. */
  pose(fighterId: number): Pose3 | null {
    const rb = this.byId.get(fighterId);
    if (!rb) return null;
    const p = rb.body.translation();
    const q = rb.body.rotation();
    return { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  /**
   * Each collider's speed now (m/s, BONES order): v + ω × (centre − COM) while dynamic, the last posing's centre delta /
   * DT while kinematic (AC-5's "body part", §11.5). Empty without a body.
   */
  partSpeeds(f: Fighter): number[] {
    const rb = this.byId.get(f.id);
    if (!rb) return [];
    const out: number[] = [];
    if (rb.dynamic) {
      const v = rb.body.linvel();
      const om = rb.body.angvel();
      const com = rb.body.worldCom();
      for (const c of rb.cols) {
        const t = c.translation();
        const rx = t.x - com.x;
        const ry = t.y - com.y;
        const rz = t.z - com.z;
        out.push(Math.hypot(v.x + om.y * rz - om.z * ry, v.y + om.z * rx - om.x * rz, v.z + om.x * ry - om.y * rx));
      }
      return out;
    }
    const h = rb.hist;
    for (let i = 0; i < rb.cols.length; i++) {
      if (!h) {
        out.push(0);
        continue;
      }
      const k = 3 * i;
      out.push(Math.hypot(h[0][k] - h[1][k], h[0][k + 1] - h[1][k + 1], h[0][k + 2] - h[1][k + 2]) / DT);
    }
    return out;
  }

  /** By fighter id (§8.3 `bodies[].ruler`, RR-19). */
  toRecord(): { fighter: number; ruler: RulerBodyRecV1 }[] {
    return [...this.byId.values()]
      .sort((a, b) => a.f.id - b.f.id)
      .map((rb) => {
        const p = rb.body.translation();
        const q = rb.body.rotation();
        // A standing (kinematic) body's velocity is Rapier's from the last posing, derived again by the next step from
        // the next pose before anything reads it (the zones' motion is the pose history): saved as 0, as a load leaves it.
        const v = rb.dynamic ? rb.body.linvel() : ZERO3;
        const a = rb.dynamic ? rb.body.angvel() : ZERO3;
        const ruler: RulerBodyRecV1 = {
          dynamic: rb.dynamic,
          pose: { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } },
          lin: { x: v.x, y: v.y, z: v.z },
          ang: { x: a.x, y: a.y, z: a.z },
          local: rb.local ? rb.local.map((l, i) => ({ bone: BONES[i], p: { ...l.p }, q: { ...l.q } })) : [],
          history: rb.hist ? [...rb.hist[0], ...rb.hist[1]] : [],
          sleeping: rb.body.isSleeping(),
          jump: rb.jump,
          climbFloor: rb.climbFloor,
          deflect: rb.deflect ? { entity: rb.deflect.entity, tick: rb.deflect.tick } : null,
          supports: [...rb.supports]
            .sort((x, y) => x[0] - y[0])
            .map(([entity, s]) => ({ entity, tick: s.tick, credit: [...s.credit] })),
          coverBreak: rb.coverBreak ? { tick: rb.coverBreak.tick, cause: copyCause(rb.coverBreak.cause) } : null,
        };
        return { fighter: rb.f.id, ruler };
      });
  }

  /**
   * Puts each listed ruler's body back as recorded (the fighters were added to the world first, and their records and
   * RulerStates restored, so the rig is the saved pose's). Every field is read through a checking reader: a broken save
   * fails at the field it breaks.
   */
  restoreRecord(r: { fighter: number; ruler: RulerBodyRecV1 }[]): void {
    for (const { fighter, ruler: rec } of r) {
      const rb = this.byId.get(fighter);
      if (!rb) throw new Error(`RulerBodies.restoreRecord: fighter ${fighter} has no ruler body`);
      const at = `bodies[fighter ${fighter}].ruler`;
      const f = rb.f;
      const dynamic = boolFromRecord(rec.dynamic, `${at}.dynamic`);
      const pose = readPose(rec.pose, `${at}.pose`);
      const lin = readVec(rec.lin, `${at}.lin`);
      const ang = readVec(rec.ang, `${at}.ang`);
      const hist = readList(rec.history, `${at}.history`).map((x, i) => numFromRecord(x, `${at}.history[${i}]`));
      if (hist.length !== 0 && hist.length !== 6 * BONES.length) throw new Error(`${at}.history holds ${hist.length} numbers, not 0 or ${6 * BONES.length}`);
      const n3 = 3 * BONES.length;
      rb.hist = hist.length === 0 ? null : [hist.slice(0, n3), hist.slice(n3)];
      rb.jump = boolFromRecord(rec.jump, `${at}.jump`);
      rb.climbFloor = rec.climbFloor === null ? null : numFromRecord(rec.climbFloor, `${at}.climbFloor`);
      const d = rec.deflect as { entity: unknown; tick: unknown } | null | undefined;
      if (d === undefined) throw new Error(`${at}.deflect is missing`);
      rb.deflect = d === null ? null : { entity: numFromRecord(d.entity, `${at}.deflect.entity`), tick: numFromRecord(d.tick, `${at}.deflect.tick`) };
      rb.supports.clear();
      readList(rec.supports, `${at}.supports`).forEach((x, i) => {
        const s = x as { entity: unknown; tick: unknown; credit: unknown };
        const credit = readList(s.credit, `${at}.supports[${i}].credit`).map((c, k) => {
          if (typeof c !== 'string') throw new Error(`${at}.supports[${i}].credit[${k}] is not a string`);
          return c;
        });
        rb.supports.set(numFromRecord(s.entity, `${at}.supports[${i}].entity`), { tick: numFromRecord(s.tick, `${at}.supports[${i}].tick`), credit });
      });
      const cb = rec.coverBreak as { tick: unknown; cause: ImpactCause } | null | undefined;
      if (cb === undefined) throw new Error(`${at}.coverBreak is missing`);
      rb.coverBreak = cb === null ? null : { tick: numFromRecord(cb.tick, `${at}.coverBreak.tick`), cause: copyCause(cb.cause) };
      rb.last.copy(f.pos);

      rb.body.setTranslation(pose.p, false);
      rb.body.setRotation(pose.q, false);
      if (dynamic) {
        const local = readList(rec.local, `${at}.local`).map((x, i) => {
          const l = x as { bone: unknown; p: V3; q: Quat };
          if (l.bone !== BONES[i]) throw new Error(`${at}.local[${i}] is bone ${String(l.bone)}, not ${BONES[i]}`);
          return readPose({ p: l.p, q: l.q }, `${at}.local[${i}]`);
        });
        if (local.length !== BONES.length) throw new Error(`${at}.local holds ${local.length} bones, not ${BONES.length}`);
        rb.local = local;
        for (let i = 0; i < rb.cols.length; i++) {
          const c = colliderLocal(local[i], rb.offs[i]);
          rb.cols[i].setTranslationWrtParent(c.p);
          rb.cols[i].setRotationWrtParent(c.q);
        }
        this.makeSolid(rb);
        rb.body.setLinvel(lin, false);
        rb.body.setAngvel(ang, false);
        rb.dynamic = true;
        if (boolFromRecord(rec.sleeping, `${at}.sleeping`)) rb.body.sleep();
        else rb.body.wakeUp();
      } else {
        rb.local = null;
        if (rb.dynamic) this.makeSensors(rb);
        rb.dynamic = false;
        for (let i = 0; i < rb.cols.length; i++) {
          const l = localPose(f.rig, BONES[i], rb.offs[i]);
          rb.cols[i].setTranslationWrtParent(l.p);
          rb.cols[i].setRotationWrtParent(l.q);
        }
      }
      for (const k of rb.keys) this.world.physics.resetHistory(k);
    }
  }

  // -------------------------------------------------------------------------
  // RulerMover (phase 3, §4.7 steps 1-7)
  // -------------------------------------------------------------------------

  private resolve(f: Fighter, radius: number): void {
    const rb = this.byId.get(f.id);
    const r = f.ruler;
    // A fighter with a RulerState but no ruler body (a test's stand-in) keeps its proposal as it is.
    if (!rb || !r || rb.dynamic) return;
    // The feet set down this tick are counted from here (the footwork runs in updatePose, after the mover).
    f.footwork.landed.length = 0;
    const T = RULER_BODY_TUNING;
    // A support gone since the last tick (removed before this phase 3) is a cover break for the ledge rule below.
    this.vanishedSupports(this.world, rb);
    const prev = { x: rb.last.x, y: rb.last.y, z: rb.last.z };
    let dx = f.pos.x - prev.x;
    let dz = f.pos.z - prev.z;

    // 3. Climbing out of a pit: slow, and only toward ground no higher than climbMaxM above where the climb began.
    let climbing = false;
    if (f.drive?.climb) {
      if (rb.climbFloor === null) rb.climbFloor = prev.y;
      const l = Math.hypot(dx, dz);
      const most = T.climbWalkMps * DT;
      if (l > most) {
        dx *= most / l;
        dz *= most / l;
      }
      const ll = Math.hypot(dx, dz);
      if (ll > TINY) {
        const ahead = this.groundAt(f, prev.x + (dx / ll) * T.climbLookM, prev.z + (dz / ll) * T.climbLookM, rb.climbFloor + T.climbMaxM, prev.y, null);
        climbing = ahead.y <= rb.climbFloor + T.climbMaxM;
      }
    } else rb.climbFloor = null;

    // 2. Slope and step limits (a block, never a trip).
    if (!climbing) [dx, dz] = this.slopeLimit(f, prev, dx, dz);

    // 4-6. The sweep against blocking-class entities: deflect, trip or block at the first hit.
    rb.move = { tick: this.world.tick, x: dx / DT, z: dz / DT };
    const end = this.sweep(f, rb, r, prev, dx, dz, radius, true);

    // 1. Ground (relaxed while climbing: the root rises at climbRateMps, in place until the ground ahead is reachable).
    let x = end.x;
    let z = end.z;
    let y: number;
    const g = this.groundAt(f, x, z, prev.y + T.stepUpMaxM, prev.y, rb);
    if (climbing) {
      if (g.y <= prev.y + T.climbRateMps * DT) y = g.y;
      else {
        x = prev.x;
        z = prev.z;
        y = prev.y + T.climbRateMps * DT;
      }
    } else y = g.y;

    // 7. Ledges: a root that would fall more than the ledge drop in one tick, or a front foot whose ground lies that far
    //    below the planted foot's.
    if (!r.pendingTrip && !climbing) {
      const drop = T.ledgeTripDropFrac * rulerKneeM(f);
      if (prev.y - y > drop) this.requestTrip(f, 'ledge', null);
      else if (f.free && this.frontFootDrop(f, rb, prev, x, z) > drop) this.requestTrip(f, 'ledge', null);
    }
    // While a trip is pending the root keeps its height: the fall is the dynamic body's, from where it stood (RF-14).
    if (r.pendingTrip) y = Math.max(y, prev.y);

    // 5. Shoveable entities the capsule overlaps at its end pose, pushed aside with the ruler's momentum (phase 4d).
    this.findShoves(f, prev, x, y, z, radius);

    f.pos.set(x, y, z);
    rb.last.copy(f.pos);
  }

  /**
   * §4.7 step 2: a move whose rise along it is steeper than maxSlopeDeg (the terrain under the new root) loses its
   * uphill component, and walkVel with it; a step up of more than stepUpMaxM in one tick is no move at all.
   */
  private slopeLimit(f: Fighter, prev: V3, dx0: number, dz0: number): [number, number] {
    const T = RULER_BODY_TUNING;
    const w = this.world;
    const tanMax = Math.tan(T.maxSlopeDeg * DEG);
    let dx = dx0;
    let dz = dz0;
    for (let pass = 0; pass < 2; pass++) {
      const l = Math.hypot(dx, dz);
      if (!(l > TINY)) return [0, 0];
      const n = w.terrain.normalAt(prev.x + dx, prev.z + dz, { x: 0, y: 1, z: 0 });
      const gx = -n.x / n.y;
      const gz = -n.z / n.y;
      const rise = (gx * dx + gz * dz) / l;
      if (!(rise > tanMax)) break;
      if (pass === 1) return [0, 0];
      const gl = Math.hypot(gx, gz);
      const ux = gx / gl;
      const uz = gz / gl;
      const along = dx * ux + dz * uz;
      dx -= along * ux;
      dz -= along * uz;
      const wv = f.walkVel.x * ux + f.walkVel.z * uz;
      if (wv > 0) {
        f.walkVel.x -= wv * ux;
        f.walkVel.z -= wv * uz;
      }
    }
    const l = Math.hypot(dx, dz);
    if (!(l > TINY)) return [0, 0];
    const up = w.terrain.heightAt(prev.x + dx, prev.z + dz) - prev.y;
    if (up > T.stepUpMaxM) {
      const ux = dx / l;
      const uz = dz / l;
      const wv = f.walkVel.x * ux + f.walkVel.z * uz;
      if (wv > 0) {
        f.walkVel.x -= wv * ux;
        f.walkVel.z -= wv * uz;
      }
      return [0, 0];
    }
    return [dx, dz];
  }

  /**
   * §4.7 steps 4 and 6: the capsule swept from `from` along (dx, dz); at the first blocking-class entity it meets it
   * deflects (then sweeps the rest along the obstacle, once), trips, or is blocked. Returns where the root ends.
   */
  private sweep(f: Fighter, rb: RulerBody, r: RulerState, from: V3, dx: number, dz: number, radius: number, first: boolean): { x: number; z: number } {
    const T = RULER_BODY_TUNING;
    const l = Math.hypot(dx, dz);
    if (!(l > TINY)) return { x: from.x, z: from.z };
    const hit = first ? this.castBlocker(f, rb, from, dx, dz, radius) : this.slideBlocker(f, rb, from, dx, dz, radius);
    if (!hit) return { x: from.x + dx, z: from.z + dz };
    const adv = Math.max(0, hit.toi * l - T.sweepSkinM);
    const px = from.x + (dx / l) * adv;
    const pz = from.z + (dz / l) * adv;
    if (!first) return { x: px, z: pz };
    const e = hit.e;
    const ux = dx / l;
    const uz = dz / l;
    // n̂: horizontal, from the ruler toward the obstacle (against the struck surface's outward normal).
    let nx = -hit.normal.x;
    let nz = -hit.normal.z;
    const nl = Math.hypot(nx, nz);
    if (nl > TINY) {
      nx /= nl;
      nz /= nl;
    } else {
      nx = ux;
      nz = uz;
    }
    // 6.1 Deflect along the obstacle's long axis (a round one: the tangent ⟂ n̂), signed along the motion (D-11).
    const t = deflectAxis(e, nx, nz);
    if (t.x * ux + t.z * uz < 0) {
      t.x = -t.x;
      t.z = -t.z;
    }
    const cos = Math.min(1, t.x * ux + t.z * uz);
    if (Math.acos(cos) < T.deflectMaxDeg * DEG) {
      const rest = (l - adv) * cos;
      const end = this.sweep(f, rb, r, { x: px, y: from.y, z: pz }, t.x * rest, t.z * rest, radius, false);
      const along = f.walkVel.x * t.x + f.walkVel.z * t.z;
      f.walkVel.x = along * t.x;
      f.walkVel.z = along * t.z;
      r.deflectedHeading = Math.atan2(t.x, t.z);
      const tick = this.world.tick;
      const d = rb.deflect;
      // One event per slide: a new obstacle, or the same one after a gap longer than a bounce (impactCooldownTicks).
      if (!d || d.entity !== e.id || tick - d.tick > DAMAGE_TUNING.impactCooldownTicks) {
        this.world.events.push({ type: 'deflect', ruler: f, along: { x: t.x, y: 0, z: t.z } });
      }
      rb.deflect = { entity: e.id, tick };
      return end;
    }
    // 6.2 Trip: fast enough into an obstacle whose top above the ground lies between the ankle and the knee (D-10).
    if (l / DT > T.tripSpeed) {
      const top = entityTop(e) - this.world.terrain.heightAt(hit.point.x, hit.point.z);
      const band = legBand(f, from.y);
      if (top >= band.ankle && top <= band.knee) {
        this.requestTrip(f, 'obstacle', { kind: 'entity', entityId: e.id, fighterId: null, credit: [...e.credit], held: false, feature: 'fall' });
        return { x: px, z: pz };
      }
    }
    // 6.3 Block: walkVel loses its component into the obstacle.
    const wn = f.walkVel.x * nx + f.walkVel.z * nz;
    if (wn > 0) {
      f.walkVel.x -= wn * nx;
      f.walkVel.z -= wn * nz;
    }
    return { x: px, z: pz };
  }

  /**
   * The blocker that stops a deflection's slide along (dx, dz) (step 6.1's "move the rest of d projected on t̂"): the
   * first one castBlocker meets whose surface the slide moves into by more than slideGrazeDeg. A surface the slide runs
   * along is grazed, not met: it is left out and the cast made again. The capsule ends a deflection in touch with the
   * obstacle's face (its skin is taken along the motion, toward the face), and a slide parallel to that face reported a
   * grazing hit (toi 0.32 of the step, its normal 0.6° off the face's) that stopped it for good: a 25° approach stalled
   * mid-wall, at 9.2 m along a 16 m wall.
   */
  private slideBlocker(f: Fighter, rb: RulerBody, from: V3, dx: number, dz: number, radius: number): { e: Entity; toi: number; point: V3; normal: V3 } | null {
    const l = Math.hypot(dx, dz);
    const minInto = Math.sin(RULER_BODY_TUNING.slideGrazeDeg * DEG);
    const grazed = new Set<number>();
    for (;;) {
      const hit = this.castBlocker(f, rb, from, dx, dz, radius, grazed);
      if (!hit) return null;
      const nl = Math.hypot(hit.normal.x, hit.normal.z);
      // A face the slide moves into (against its outward normal): a block. A flat one (a top) blocks too.
      if (!(nl > TINY) || -(hit.normal.x * dx + hit.normal.z * dz) / (nl * l) > minInto) return hit;
      grazed.add(hit.e.id);
    }
  }

  /**
   * The first blocking-class entity (fixed, anchored, or ≥ shoveLimitKg; not a fresh piece in its grace; not one of
   * `skip`) whose top rises above the ankle over `from.y`, met by the capsule (radius `radius`, its straight part from
   * the ankle to the hip above `from.y`) moving along (dx, dz) within the tick. A capsule that starts inside an obstacle
   * is not stopped by it while it moves out (stopAtPenetration false). toi is the fraction of (dx, dz).
   */
  private castBlocker(
    f: Fighter,
    rb: RulerBody,
    from: V3,
    dx: number,
    dz: number,
    radius: number,
    skip: ReadonlySet<number> | null = null,
  ): { e: Entity; toi: number; point: V3; normal: V3 } | null {
    const w = this.world;
    const ankle = rulerAnkleM(f);
    const hip = rulerHipM(f);
    const shape = new RAPIER.Capsule((hip - ankle) / 2, radius);
    const centre = { x: from.x, y: from.y + (ankle + hip) / 2, z: from.z };
    const floor = from.y + ankle;
    const hit = w.physics.rapier.castShape(
      centre,
      IDENTITY,
      { x: dx, y: 0, z: dz },
      shape,
      0,
      1,
      false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      rb.body,
      (c) => {
        const e = this.entityOf(c);
        return !!e && !e.grace && !skip?.has(e.id) && this.blocks(e) && entityTop(e) > floor;
      },
    );
    if (!hit) return null;
    const e = this.entityOf(hit.collider);
    if (!e) return null;
    return { e, toi: hit.time_of_impact, point: { x: hit.witness1.x, y: hit.witness1.y, z: hit.witness1.z }, normal: { x: hit.normal1.x, y: hit.normal1.y, z: hit.normal1.z } };
  }

  /** A blocker (§4.7 step 6, SPEC:781): fixed, anchored (or joined to an anchor), or a dynamic body of ≥ shoveLimitKg. */
  private blocks(e: Entity): boolean {
    return e.state === 'fixed' || e.state === 'anchored' || e.mass >= RULER_BODY_TUNING.shoveLimitKg || this.world.entities.isAnchored(e);
  }

  private entityOf(c: RAPIER.Collider): Entity | null {
    const o = this.world.physics.ownerOf(c.handle);
    return o?.kind === 'entity' ? (this.world.entities.get(o.id) ?? null) : null;
  }

  /**
   * §4.7 step 1: the height the ruler stands on over (x, z): the terrain, or the top of a fixed, anchored or resting
   * (restTicks ≥ PHYSICS_TUNING.restTicks, or asleep) entity found by a downward ray from fromY + supportReachM, whose
   * top is no more than the ankle above max(terrain, refY) (World.supportAt's rule with the ruler's cap). Taller entities
   * are obstacles, never ground; the cap is measured from where the ruler stands as well as from the terrain, so a pit
   * cover level with the rim it walks off is ground while it stands (the terrain under it is the pit floor), and stakes
   * standing in a pit are not ground for a ruler on the pit floor. `rb` set: the entity found is remembered as one of its
   * supports (cover failure, step 8). `exclude`: entities left out (a cover that just broke).
   */
  private groundAt(f: Fighter, x: number, z: number, fromY: number, refY: number, rb: RulerBody | null, exclude: readonly number[] = []): { y: number; entity: number | null } {
    const w = this.world;
    const terrain = w.terrain.heightAt(x, z);
    const cap = Math.max(terrain, refY) + rulerAnkleM(f);
    const top = fromY + WORLD_TUNING.supportReachM;
    if (!(top > terrain)) return { y: terrain, entity: null };
    const ex = [...exclude];
    for (;;) {
      const hit = w.queries.castRay({ x, y: top, z }, DOWN, top - terrain, { terrain: false, entities: 'all', exclude: { entities: ex } });
      if (!hit || hit.owner.kind !== 'entity') return { y: terrain, entity: null };
      const id = hit.owner.id;
      // A solid ray starting inside a collider stops at once (toi 0): that entity's top is not below the reach.
      if (hit.toi > 0) {
        const e = w.entities.get(id);
        const resting =
          !!e &&
          (e.state === 'fixed' || e.state === 'anchored' || e.restTicks >= PHYSICS_TUNING.restTicks || (e.body?.isSleeping() ?? false));
        if (e && resting && hit.point.y <= cap) {
          if (rb) rb.supports.set(id, { tick: w.tick, credit: [...e.credit] });
          return { y: Math.max(terrain, hit.point.y), entity: id };
        }
      }
      ex.push(id);
    }
  }

  /**
   * §4.7 step 7: how far the front foot's ground lies below the planted foot's (0 when it isn't lower). The front foot is
   * the one further along the motion (or the facing); a stepping foot counts where it will land. Their supports are
   * remembered (step 8).
   */
  private frontFootDrop(f: Fighter, rb: RulerBody, prev: V3, x: number, z: number): number {
    const T = RULER_BODY_TUNING;
    let ux = x - prev.x;
    let uz = z - prev.z;
    const l = Math.hypot(ux, uz);
    if (l > TINY) {
      ux /= l;
      uz /= l;
    } else {
      ux = Math.sin(f.yaw);
      uz = Math.cos(f.yaw);
    }
    const feet = SIDES.map((side) => {
      const foot = f.footwork.foot(side);
      const pt = foot.stepping ? foot.to : foot.pos;
      const g = this.groundAt(f, pt.x, pt.z, prev.y + T.stepUpMaxM, prev.y, rb);
      return { along: (pt.x - x) * ux + (pt.z - z) * uz, y: g.y };
    });
    const [front, back] = feet[0].along >= feet[1].along ? [feet[0], feet[1]] : [feet[1], feet[0]];
    return Math.max(0, back.y - front.y);
  }

  /** §4.7 step 5: the shoveable entities the capsule overlaps at its end pose, each pushed with the ruler's momentum. */
  private findShoves(f: Fighter, prev: V3, x: number, y: number, z: number, radius: number): void {
    const T = RULER_BODY_TUNING;
    const w = this.world;
    const ankle = rulerAnkleM(f);
    const hip = rulerHipM(f);
    const vx = (x - prev.x) / DT;
    const vz = (z - prev.z) / DT;
    if (!(Math.hypot(vx, vz) > TINY)) return;
    const owners = w.queries.overlaps(
      { kind: 'capsule', halfHeight: (hip - ankle) / 2, r: radius },
      { p: { x, y: y + (ankle + hip) / 2, z }, q: { ...IDENTITY } },
      { terrain: false, entities: 'all' },
    );
    for (const o of owners) {
      if (o.kind !== 'entity') continue;
      const e = w.entities.get(o.id);
      const b = e?.body;
      if (!e || !b || !b.isDynamic() || !b.isEnabled() || e.grace || e.mass >= T.shoveLimitKg || w.entities.isAnchored(e)) continue;
      if (entityTop(e) <= y + ankle) continue;
      let nx = e.pose.p.x - x;
      let nz = e.pose.p.z - z;
      const nl = Math.hypot(nx, nz);
      if (nl > TINY) {
        nx /= nl;
        nz /= nl;
      } else {
        const vl = Math.hypot(vx, vz);
        nx = vx / vl;
        nz = vz / vl;
      }
      const dv = Math.max(0, vx * nx + vz * nz - (e.vel.lin.x * nx + e.vel.lin.z * nz));
      if (!(dv > 0)) continue;
      this.shoves.push({ f, entity: e.id, j: { x: e.mass * dv * nx, y: 0, z: e.mass * dv * nz } });
    }
  }

  // -------------------------------------------------------------------------
  // Standing pose, the trip switch, the tripped rig, the get-up
  // -------------------------------------------------------------------------

  /** Phase 4c, standing or rising: the body at the rig's pelvis, each collider where its bone is (§4.7 "Standing"). */
  private poseStanding(f: Fighter, rb: RulerBody): void {
    const pel = f.rig.pelvis;
    const p = { x: pel.pos.x, y: pel.pos.y, z: pel.pos.z };
    const q = { x: pel.rot.x, y: pel.rot.y, z: pel.rot.z, w: pel.rot.w };
    if (rb.jump) {
      rb.body.setTranslation(p, true);
      rb.body.setRotation(q, true);
    } else {
      rb.body.setNextKinematicTranslation(p);
      rb.body.setNextKinematicRotation(q);
    }
    for (let i = 0; i < BONES.length; i++) {
      const l = localPose(f.rig, BONES[i], rb.offs[i]);
      rb.cols[i].setTranslationWrtParent(l.p);
      rb.cols[i].setRotationWrtParent(l.q);
    }
    const c = rigCentres(f.rig, rb.offs);
    rb.hist = rb.jump || !rb.hist ? [c, c.slice()] : [c, rb.hist[0]];
    rb.jump = false;
  }

  /** Phase 4c: the trip switch (§4.7), then the fighter tripped for getupAfterS, the down cause and wound, the event. */
  private trip(w: World, f: Fighter, rb: RulerBody, r: RulerState): void {
    const T = RULER_BODY_TUNING;
    const pending = r.pendingTrip!;
    r.pendingTrip = null;
    this.goDynamic(f, rb);
    f.vel.set(0, 0, 0);
    f.walkVel.set(0, 0, 0);
    f.setState('tripped');
    f.stunFrames = Math.round(T.getupAfterS / DT);
    // What put it down (§4.6): the trip's cause, and the wound the trip tick's impact opened, if it opened one.
    r.downCause = pending.cause ? copyCause(pending.cause) : null;
    const opened = r.wounds.filter((x) => x.tick === pending.tick);
    const byCause = pending.cause?.entityId != null ? opened.filter((x) => x.cause.entityId === pending.cause!.entityId) : [];
    const wound = (byCause.length > 0 ? byCause : opened).at(-1);
    if (wound) r.downWound = wound.id;
    r.lastWorldTrip = { tick: w.tick, cause: pending.cause ? copyCause(pending.cause) : null };
    w.events.push({ type: 'trip', f, at: { x: f.pos.x, y: f.pos.y, z: f.pos.z }, why: pending.why, cause: pending.cause ? copyCause(pending.cause) : null });
    this.resetHistory(f);
  }

  /**
   * The switch to a dynamic body (§4.7, MAP gap-3 §3.3): the body at the rig's pelvis with each collider where its bone
   * is, the pose frozen there (tripPose 'freeze'), solid colliders, and the momentum of the previous tick's motion: v =
   * Σ m_b v_b / M and ω = I⁻¹ Σ m_b (c_b − com) × (v_b − v), with v_b the collider centres' previous-tick velocities.
   */
  private goDynamic(f: Fighter, rb: RulerBody): void {
    const n = BONES.length;
    const vb: V3[] = [];
    for (let i = 0; i < n; i++) {
      const h = rb.hist;
      const k = 3 * i;
      vb.push(h && !rb.jump ? { x: (h[0][k] - h[1][k]) / DT, y: (h[0][k + 1] - h[1][k + 1]) / DT, z: (h[0][k + 2] - h[1][k + 2]) / DT } : { x: 0, y: 0, z: 0 });
    }
    const pel = f.rig.pelvis;
    rb.body.setTranslation({ x: pel.pos.x, y: pel.pos.y, z: pel.pos.z }, true);
    rb.body.setRotation({ x: pel.rot.x, y: pel.rot.y, z: pel.rot.z, w: pel.rot.w }, true);
    const local: Pose3[] = [];
    _qi.copy(pel.rot).invert();
    for (let i = 0; i < n; i++) {
      const x = f.rig[BONES[i]];
      _p.copy(x.pos).sub(pel.pos).applyQuaternion(_qi);
      _q.copy(_qi).multiply(x.rot);
      const l = { p: { x: _p.x, y: _p.y, z: _p.z }, q: { x: _q.x, y: _q.y, z: _q.z, w: _q.w } };
      local.push(l);
      const c = colliderLocal(l, rb.offs[i]);
      rb.cols[i].setTranslationWrtParent(c.p);
      rb.cols[i].setRotationWrtParent(c.q);
    }
    this.makeSolid(rb);
    // The momentum fit, about the centre of the bone masses (the colliders' centres of mass).
    const centres = rigCentres(f.rig, rb.offs);
    let M = 0;
    const v = { x: 0, y: 0, z: 0 };
    const com = { x: 0, y: 0, z: 0 };
    const m: number[] = [];
    for (let i = 0; i < n; i++) {
      const mi = f.mass * f.boneShare[BONES[i]];
      m.push(mi);
      M += mi;
      v.x += mi * vb[i].x;
      v.y += mi * vb[i].y;
      v.z += mi * vb[i].z;
      com.x += mi * centres[3 * i];
      com.y += mi * centres[3 * i + 1];
      com.z += mi * centres[3 * i + 2];
    }
    if (M > 0) {
      v.x /= M;
      v.y /= M;
      v.z /= M;
      com.x /= M;
      com.y /= M;
      com.z /= M;
    }
    const L = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const rx = centres[3 * i] - com.x;
      const ry = centres[3 * i + 1] - com.y;
      const rz = centres[3 * i + 2] - com.z;
      const ux = vb[i].x - v.x;
      const uy = vb[i].y - v.y;
      const uz = vb[i].z - v.z;
      L.x += m[i] * (ry * uz - rz * uy);
      L.y += m[i] * (rz * ux - rx * uz);
      L.z += m[i] * (rx * uy - ry * ux);
    }
    const om = invInertiaTimes(rb.body, L);
    rb.body.setLinvel(v, true);
    rb.body.setAngvel(om, true);
    rb.local = local;
    rb.dynamic = true;
    rb.hist = [centres, centres.slice()];
  }

  /** Solid colliders (RULER_SOLID) on a dynamic body with the tripped damping, extra iterations and CCD. */
  private makeSolid(rb: RulerBody): void {
    const T = RULER_BODY_TUNING;
    for (const c of rb.cols) {
      c.setSensor(false);
      c.setCollisionGroups(collisionGroups('RULER_SOLID'));
      c.setSolverGroups(solverGroups('RULER_SOLID'));
    }
    rb.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    rb.body.recomputeMassPropertiesFromColliders();
    rb.body.setLinearDamping(T.trippedLinDamp);
    rb.body.setAngularDamping(T.trippedAngDamp);
    rb.body.setAdditionalSolverIterations(T.trippedExtraIters);
    rb.body.enableCcd(true);
  }

  /** Sensors again (RULER_ZONE) on a kinematic body. */
  private makeSensors(rb: RulerBody): void {
    rb.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    for (const c of rb.cols) {
      c.setSensor(true);
      c.setCollisionGroups(collisionGroups('RULER_ZONE'));
      c.setSolverGroups(solverGroups('RULER_ZONE'));
    }
  }

  /**
   * Phase 13b, dynamic: rig[b] = body ∘ local[b]; f.pos the terrain under the pelvis; the pose's root and pelvis
   * re-expressed in (f.pos, f.yaw) so forward kinematics reproduces the rig (the children keep their frozen rotations);
   * the collider history follows the body (RF-1).
   */
  private rigFromBody(w: World, f: Fighter, rb: RulerBody): void {
    const local = rb.local;
    if (!local) return;
    const t = rb.body.translation();
    const qb = rb.body.rotation();
    _q.set(qb.x, qb.y, qb.z, qb.w);
    _p.set(t.x, t.y, t.z);
    for (let i = 0; i < BONES.length; i++) {
      const x = f.rig[BONES[i]];
      const l = local[i];
      x.rot.set(l.q.x, l.q.y, l.q.z, l.q.w).premultiply(_q);
      x.pos.set(l.p.x, l.p.y, l.p.z).applyQuaternion(_q).add(_p);
    }
    f.pos.set(t.x, w.terrain.heightAt(t.x, t.z), t.z);
    reexpressPose(f);
    const c = rigCentres(f.rig, rb.offs);
    rb.hist = rb.hist ? [c, rb.hist[0]] : [c, c.slice()];
  }

  /**
   * §4.7 "Get-up": light loads still on the body are shoved off (they would fall through the sensors); the body turns
   * kinematic with sensors; the fighter stands where its pelvis is, facing the yaw that makes kneeling shortest (the
   * twist of pelvisRot · kneelPelvis⁻¹ about +Y), its lying pose re-expressed there, and rises over getupFrames through
   * `kneel` (DS's one-frame kneel key would sweep the zones at 398.8 m/s, MAP gap-3 §2.3); a `rise` event; the history
   * reset and a contact grace (RF-1).
   */
  private getUp(w: World, f: Fighter, rb: RulerBody, resting: readonly number[]): void {
    const T = RULER_BODY_TUNING;
    const com = rb.body.worldCom();
    for (const id of resting) {
      const e = w.entities.get(id);
      if (!e) continue;
      let nx = e.pose.p.x - com.x;
      let nz = e.pose.p.z - com.z;
      const nl = Math.hypot(nx, nz);
      if (nl > TINY) {
        nx /= nl;
        nz /= nl;
      } else {
        nx = Math.sin(f.yaw);
        nz = Math.cos(f.yaw);
      }
      const dv = Math.max(0, T.getupShoveMps - (e.vel.lin.x * nx + e.vel.lin.z * nz));
      if (dv > 0) w.entities.queueImpulse(id, { x: e.mass * dv * nx, y: 0, z: e.mass * dv * nz }, null);
    }
    this.makeSensors(rb);
    rb.dynamic = false;
    rb.local = null;
    const pel = f.rig.pelvis;
    _q.copy(pel.rot).multiply(_qi.copy(getPose('kneel').rot.pelvis).invert());
    f.yaw = 2 * Math.atan2(_q.y, _q.w);
    f.pos.set(pel.pos.x, this.groundAt(f, pel.pos.x, pel.pos.z, w.terrain.heightAt(pel.pos.x, pel.pos.z), w.terrain.heightAt(pel.pos.x, pel.pos.z), null).y, pel.pos.z);
    reexpressPose(f);
    f.enterGetup(T.getupFrames, [
      { f: T.getupKneelFrame, pose: getPose('kneel'), ease: 'inOut' },
      { f: T.getupFrames, pose: getPose('guard'), ease: 'inOut' },
    ]);
    w.events.push({ type: 'rise', f });
    this.resetHistory(f);
  }

  /**
   * §4.7 "In a pit" (RR-1): into a pit when the ruler's ground (while dynamic: the pelvis) lies more than
   * pitDownDepthFrac × knee height below the original ground; out of it again only when that point is within
   * pitOutDepthFrac × knee height of the original ground and, standing, the terrain under the root is no steeper than
   * maxSlopeDeg (it stands on the rim, not on the pit wall it is climbing); a `pit` event on change.
   * INTERPRETATION (§4.7 says "both planted feet"): the ground the root stands on, which the feet stand around. A 5.5×
   * stride plants a foot on the rim while the body still stands at the foot of the pit wall (the root stops there,
   * step 2), and by the feet it would be out of the pit (and recovering) with its body still in it.
   * INTERPRETATION (hysteresis; §4.7 gives one threshold): the climb (step 3) raises the root up the wall face, and with
   * one threshold in-pit went off halfway up the wall; the mind's climb (§6.4: while ruler.inPit) then stopped, the wall
   * blocked it as a slope (step 2) and it stood on the wall for good, in-pit flickering every tick. "Down until it has
   * climbed out" (SPEC:504) is the rim: within a small step of the original ground, off the wall.
   */
  private updatePit(w: World, f: Fighter, rb: RulerBody, r: RulerState): void {
    const T = RULER_BODY_TUNING;
    const knee = rulerKneeM(f);
    const p = rb.dynamic ? f.rig.pelvis.pos : f.pos;
    const below = w.terrain.originalHeightAt(p.x, p.z) - p.y;
    let inPit: boolean;
    if (!r.inPit) inPit = below > T.pitDownDepthFrac * knee;
    else if (below > T.pitOutDepthFrac * knee) inPit = true;
    else inPit = !rb.dynamic && w.terrain.normalAt(p.x, p.z, _n).y < Math.cos(T.maxSlopeDeg * DEG);
    if (inPit !== r.inPit) {
      r.inPit = inPit;
      w.events.push({ type: 'pit', f, on: inPit });
    }
  }

  /**
   * D-38: the dynamic mass resting on the ruler: bodies in contact with one of its colliders with the normal out of
   * the ruler pointing up (· up > pinnedNormalY), and transitively the bodies resting the same way on those, each body's
   * mass once. Read from contact manifolds, which persist while the island sleeps (MAP gap-3 §2.4). Also the entities
   * among them (by id).
   */
  private restingLoad(rb: RulerBody): { kg: number; entities: number[] } {
    const rapier = this.world.physics.rapier;
    const minY = RULER_TUNING.pinnedNormalY;
    const found = new Map<number, RAPIER.RigidBody>();
    const frontier: RAPIER.Collider[] = [...rb.cols];
    for (let k = 0; k < frontier.length; k++) {
      const c1 = frontier[k];
      const others: RAPIER.Collider[] = [];
      rapier.contactPairsWith(c1, (c2) => {
        others.push(c2);
      });
      others.sort((a, b) => a.handle - b.handle);
      for (const c2 of others) {
        const b2 = c2.parent();
        if (!b2 || b2.handle === rb.body.handle || found.has(b2.handle) || !b2.isDynamic() || !b2.isEnabled()) continue;
        let rests = false;
        rapier.contactPair(c1, c2, (mf, flipped) => {
          if (mf.numContacts() === 0) return;
          const ny = mf.normal().y;
          if ((flipped ? -ny : ny) > minY) rests = true;
        });
        if (!rests) continue;
        found.set(b2.handle, b2);
        for (let i = 0; i < b2.numColliders(); i++) frontier.push(b2.collider(i));
      }
    }
    // Summed in owner order (§4.3), not by handle: handles aren't saved, and pinnedKg is (a loaded world must sum the
    // same masses in the same order to the last bit).
    const physics = this.world.physics;
    const keyed = [...found.values()].map((b) => ({ b, o: b.numColliders() > 0 ? physics.ownerOf(b.collider(0).handle) : null }));
    keyed.sort((x, y) => (x.o && y.o ? compareOwners(x.o, y.o) : x.o ? -1 : y.o ? 1 : 0) || x.b.handle - y.b.handle);
    let kg = 0;
    const entities: number[] = [];
    for (const { b } of keyed) {
      kg += b.mass();
      for (let i = 0; i < b.numColliders(); i++) {
        const o = this.world.physics.ownerOf(b.collider(i).handle);
        if (o?.kind === 'entity' && !entities.includes(o.id)) entities.push(o.id);
      }
    }
    return { kg, entities: entities.sort((a, b) => a - b) };
  }

  /**
   * Pinned with nothing down yet (§4.6): the newest wound a pinning body opened becomes downWound; the heaviest pinning
   * entity (lowest id on a tie) is downCause when there is none.
   */
  private pinnedBy(w: World, r: RulerState, entities: readonly number[]): void {
    if (r.downWound === null) {
      const wound = r.wounds.filter((x) => x.cause.entityId !== null && entities.includes(x.cause.entityId)).at(-1);
      if (wound) r.downWound = wound.id;
    }
    if (r.downCause === null) {
      let heaviest: Entity | null = null;
      for (const id of entities) {
        const e = w.entities.get(id);
        if (e && (!heaviest || e.mass > heaviest.mass)) heaviest = e;
      }
      if (heaviest) r.downCause = { kind: 'entity', entityId: heaviest.id, fighterId: null, credit: [...heaviest.credit], held: false, feature: 'falling' };
    }
  }

  /**
   * §4.7 step 8 (cover failure), phase 13b for a standing ruler: a support of the last coverTripWindowTicks that is gone
   * (a load break split it in phase 12, or it was removed) is remembered as a cover break; when it held the ruler up in
   * the last tick, the drop under its root and planted feet with it gone, beyond ledgeTripDropFrac × knee height, trips
   * it 'cover' with that cover as the cause. (A load break the loads pass reports itself through requestTrip in phase
   * 11; the first request stands.) Supports seen longer ago than the window are forgotten.
   */
  private coverFailure(w: World, f: Fighter, rb: RulerBody): void {
    const T = RULER_BODY_TUNING;
    for (const v of this.vanishedSupports(w, rb)) {
      if (!v.recent) continue;
      const limit = T.ledgeTripDropFrac * rulerKneeM(f);
      const ankle = rulerAnkleM(f);
      let drop = f.pos.y - this.groundAt(f, f.pos.x, f.pos.z, f.pos.y + T.stepUpMaxM, f.pos.y, null, [v.id]).y;
      for (const side of SIDES) {
        if (f.free && f.footwork.foot(side).stepping) continue;
        const shin: BoneName = side === 'L' ? 'shinL' : 'shinR';
        bonePoint(f.rig, shin, SKELETON[shin].length, _a);
        const footY = _a.y - ankle;
        drop = Math.max(drop, footY - this.groundAt(f, _a.x, _a.z, footY + T.stepUpMaxM, footY, null, [v.id]).y);
      }
      if (drop > limit) this.requestTrip(f, 'cover', v.cause);
    }
  }

  /**
   * The supports of the last coverTripWindowTicks that are gone (a load break split them, or they were removed), each
   * now the ruler's cover break (a ledge trip within the window is that cover's trip, step 7), by id, with whether it
   * held the ruler up in the last tick; supports seen longer ago than the window are forgotten. Checked by the mover
   * (a support gone before phase 3) and in phase 13b (a load break of phase 11-12).
   */
  private vanishedSupports(w: World, rb: RulerBody): { id: number; cause: ImpactCause; recent: boolean }[] {
    const T = RULER_BODY_TUNING;
    const tick = w.tick;
    if (rb.coverBreak && tick - rb.coverBreak.tick > T.coverTripWindowTicks) rb.coverBreak = null;
    const out: { id: number; cause: ImpactCause; recent: boolean }[] = [];
    for (const id of [...rb.supports.keys()].sort((a, b) => a - b)) {
      const s = rb.supports.get(id)!;
      if (w.entities.get(id)) {
        if (tick - s.tick > T.coverTripWindowTicks) rb.supports.delete(id);
        continue;
      }
      rb.supports.delete(id);
      const cause: ImpactCause = { kind: 'entity', entityId: id, fighterId: null, credit: [...s.credit], held: false, feature: 'cover' };
      rb.coverBreak = { tick, cause };
      out.push({ id, cause, recent: tick - s.tick <= 1 });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pinned (D-38, with hysteresis)
// ---------------------------------------------------------------------------

/**
 * One tick of the pin rule with `kg` resting on the ruler: pinned turns on at ≥ pinnedKg; once on, it turns off only
 * after unpinTicks consecutive ticks below unpinnedKg (manifolds of a settling, sleeping island would flicker it
 * otherwise, MAP gap-3 §3.6). pinnedKg records the measure.
 */
export function stepPinned(r: Pick<RulerState, 'pinned' | 'pinnedKg' | 'unpinTicks'>, kg: number): void {
  const T = RULER_TUNING;
  r.pinnedKg = kg;
  if (!r.pinned) {
    r.unpinTicks = 0;
    if (kg >= T.pinnedKg) r.pinned = true;
    return;
  }
  if (kg < T.unpinnedKg) {
    r.unpinTicks++;
    if (r.unpinTicks >= T.unpinTicks) {
      r.pinned = false;
      r.unpinTicks = 0;
    }
  } else r.unpinTicks = 0;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * A bone's collider pose relative to the pelvis body: the bone's world pose from the rig, moved by the shape's offset
 * in the bone frame, in the pelvis frame (qp⁻¹·(p_b + q_b·off − p_p), qp⁻¹·q_b), as world/zones.ts poses its zones.
 */
function localPose(rig: Rig, bone: BoneName, off: V3): Pose3 {
  const pel = rig.pelvis;
  const x = rig[bone];
  _o.set(off.x, off.y, off.z).applyQuaternion(x.rot);
  _qi.copy(pel.rot).invert();
  _p.copy(x.pos).add(_o).sub(pel.pos).applyQuaternion(_qi);
  _q.copy(_qi).multiply(x.rot);
  return { p: { x: _p.x, y: _p.y, z: _p.z }, q: { x: _q.x, y: _q.y, z: _q.z, w: _q.w } };
}

/** A collider's pose relative to the body from its bone's frame relative to the body and the shape's offset. */
function colliderLocal(l: Pose3, off: V3): Pose3 {
  _q.set(l.q.x, l.q.y, l.q.z, l.q.w);
  _o.set(off.x, off.y, off.z).applyQuaternion(_q);
  return { p: { x: l.p.x + _o.x, y: l.p.y + _o.y, z: l.p.z + _o.z }, q: { x: l.q.x, y: l.q.y, z: l.q.z, w: l.q.w } };
}

/** The colliders' world centres from the rig (rig[b].pos + rig[b].rot · off[b]), 3 numbers a bone in BONES order. */
function rigCentres(rig: Rig, offs: readonly V3[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < BONES.length; i++) {
    const x = rig[BONES[i]];
    _o.set(offs[i].x, offs[i].y, offs[i].z).applyQuaternion(x.rot).add(x.pos);
    out.push(_o.x, _o.y, _o.z);
  }
  return out;
}

/** The pose's root and pelvis rotation for the rig's pelvis in the fighter's frame (f.pos, f.yaw, f.scale). */
function reexpressPose(f: Fighter): void {
  const pel = f.rig.pelvis;
  _qi.setFromAxisAngle(Y_AXIS, f.yaw).invert();
  f.pose.root.copy(pel.pos).sub(f.pos).applyQuaternion(_qi).divideScalar(f.scale);
  f.pose.rot.pelvis.copy(_qi).multiply(pel.rot);
}

/** The ankle and knee heights above `groundY` (§4.7 step 6.2: bonePoint(rig, shinX, length) and rig.shinX.pos). */
function legBand(f: Fighter, groundY: number): { ankle: number; knee: number } {
  let ankle = Infinity;
  let knee = -Infinity;
  for (const side of SIDES) {
    const shin: BoneName = side === 'L' ? 'shinL' : 'shinR';
    bonePoint(f.rig, shin, SKELETON[shin].length, _a);
    ankle = Math.min(ankle, _a.y - groundY);
    knee = Math.max(knee, f.rig[shin].pos.y - groundY);
  }
  return { ankle, knee };
}

/**
 * The horizontal unit direction a ruler deflects along off `e` (§4.7 step 6.1): its shape's long axis in the world,
 * projected to xz, when it meets the obstacle's long side; a round obstacle (an axis steeper than deflectAxisMinXZ, or a
 * ball), and the end or a corner of a long one, give the tangent ⟂ n̂.
 * INTERPRETATION (§4.7 says the long axis for every non-round obstacle): met at its end or a corner (n̂ more than
 * deflectMaxDeg off perpendicular to the axis), sliding along the axis would push the ruler into the obstacle's end, so
 * it slides round the corner instead; on the long side the two are the same direction.
 */
function deflectAxis(e: Entity, nx: number, nz: number): { x: number; z: number } {
  const t = longAxisXZ(e);
  if (t && Math.abs(t.x * nx + t.z * nz) <= Math.sin(RULER_BODY_TUNING.deflectMaxDeg * DEG)) return t;
  return { x: -nz, z: nx };
}

/**
 * A long obstacle's axis in the world, projected to xz and made unit (either sign), or null for a round one: a ball, a
 * shape no longer than it is thick, or one whose axis is steeper than deflectAxisMinXZ (an upright trunk or stake).
 */
function longAxisXZ(e: Entity): { x: number; z: number } | null {
  const ax = principalAxis(e.shape);
  const q = e.pose.q;
  _q.set(q.x, q.y, q.z, q.w);
  _a.set(ax.dir.x, ax.dir.y, ax.dir.z).applyQuaternion(_q);
  const h = Math.hypot(_a.x, _a.z);
  const long = e.shape.kind !== 'ball' && ax.max - ax.min > 2 * ax.crossHalf;
  return long && h >= RULER_BODY_TUNING.deflectAxisMinXZ ? { x: _a.x / h, z: _a.z / h } : null;
}

/** m: the highest point of an entity's shape at its record pose (the pose as of the last physics step). */
export function entityTop(e: Entity): number {
  const s = e.shape;
  const p = e.pose.p;
  _q.set(e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w);
  switch (s.kind) {
    case 'ball':
      return p.y + s.r;
    case 'capsule':
      _a.set(0, s.halfHeight, 0).applyQuaternion(_q);
      return p.y + Math.abs(_a.y) + s.r;
    case 'box': {
      let top = 0;
      for (const [x, y, z] of [
        [s.hx, 0, 0],
        [0, s.hy, 0],
        [0, 0, s.hz],
      ]) {
        _a.set(x, y, z).applyQuaternion(_q);
        top += Math.abs(_a.y);
      }
      return p.y + top;
    }
    case 'cylinder':
      return p.y + maxRotatedY(cylinderPoints(s));
    case 'hull':
      return p.y + maxRotatedY(s.points);
  }
}

/** The largest y of local xyz triples rotated by _q. */
function maxRotatedY(pts: readonly number[]): number {
  let top = -Infinity;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    _a.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(_q);
    if (_a.y > top) top = _a.y;
  }
  return top === -Infinity ? 0 : top;
}

/**
 * I⁻¹ L for a rigid body whose rotation was just set: the world inertia R·diag(I)·Rᵀ with R = the body's rotation ·
 * its principal inertia frame (Rapier's mass properties from its colliders, pose-independent).
 */
function invInertiaTimes(body: RAPIER.RigidBody, L: V3): V3 {
  const I = body.principalInertia();
  const fr = body.principalInertiaLocalFrame();
  const rot = body.rotation();
  _q.set(rot.x, rot.y, rot.z, rot.w).multiply(_qi.set(fr.x, fr.y, fr.z, fr.w));
  // L in the principal frame, scaled by 1/I, back to the world.
  _a.set(L.x, L.y, L.z).applyQuaternion(_qi.copy(_q).invert());
  _a.set(I.x > 0 ? _a.x / I.x : 0, I.y > 0 ? _a.y / I.y : 0, I.z > 0 ? _a.z / I.z : 0).applyQuaternion(_q);
  return { x: _a.x, y: _a.y, z: _a.z };
}

function copyCause(c: ImpactCause): ImpactCause {
  return { kind: c.kind, entityId: c.entityId, fighterId: c.fighterId, credit: [...c.credit], held: c.held, feature: c.feature };
}

// ---------------------------------------------------------------------------
// Record readers
// ---------------------------------------------------------------------------

function readList(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${at} is not a list`);
  return v;
}

function readVec(v: unknown, at: string): V3 {
  const o = v as V3 | null;
  if (!o || typeof o !== 'object') throw new Error(`${at} is not a vector`);
  return { x: numFromRecord(o.x, `${at}.x`), y: numFromRecord(o.y, `${at}.y`), z: numFromRecord(o.z, `${at}.z`) };
}

function readPose(v: unknown, at: string): Pose3 {
  const o = v as Pose3 | null;
  if (!o || typeof o !== 'object' || !o.q || typeof o.q !== 'object') throw new Error(`${at} is not a pose`);
  return {
    p: readVec(o.p, `${at}.p`),
    q: { x: numFromRecord(o.q.x, `${at}.q.x`), y: numFromRecord(o.q.y, `${at}.q.y`), z: numFromRecord(o.q.z, `${at}.q.z`), w: numFromRecord(o.q.w, `${at}.q.w`) },
  };
}
