// Character controllers for the player and apes (docs/M1-DESIGN.md §1.5.8, §4.2): a kinematic capsule and a Rapier
// KinematicCharacterController per fighter, the 500 N push queue, jump, fall and landing, teleport, the verbs' tether
// hook and the crouch height with headroom. The FighterMover CombatSim calls at the separate() site (phase 3).
//
// - The capsule (r = capsuleR × scale, half-height capsuleHalfH × scale: 1.8 × scale tall) is in the CHAR collision
//   group and solves only against TERRAIN (§2.11): a falling log passes through it and reaches the fighter through its
//   zones (MAP rapier §4.2). Every sweep passes EXCLUDE_SENSORS and the KCC groups explicitly (MAP rapier findings 5, 6),
//   so other fighters' capsules, slabs and every sensor are never in the way: fighter spacing stays separate()'s (MAP
//   gap-1 §4: with characters in each other's filter both stop at capsule contact and fight separate()).
// - A sweep starts from the capsule's pose as of the last physics step (MAP gap-1 R1), which is last tick's resolved
//   f.pos, and moves it toward this tick's proposal (f.pos after locomote and separate()'s push). f.pos then holds the
//   f32 position Rapier will hold (MAP gap-1 R4): f.pos.x/z are the capsule centre's, f.pos.y its centre less the foot
//   offset (half-height + radius + the controller's offset).
// - Grounded, the sweep's dy is 0 (autostep only works without a downward component, MAP rapier finding 5) and the
//   controller snaps itself down slopes (Rapier's own snap acts only on a sweep that already moves down); airborne,
//   gravity integrates vy. Climbing (autostep, D-28) steps over static bodies and over dynamic ones the push can't
//   shove (anchored, too heavy, or jammed: pushed last tick and not moving); a light log is pushed instead (see
//   resolve).
// - Built-in pushing is off (SPEC:374, MAP rapier finding 1). A computed collision with a dynamic, non-anchored entity
//   queues pushN × DT along the horizontal −normal1, once per entity per controller per tick, applied in phase 4d
//   through the entity store's impulse queue in entity id order; friction decides (a 40 kg log slides, an 800 kg hull
//   doesn't). A surface the fighter can stand on (a normal within maxSlopeClimbDeg of up) is ground, not pushed.
// - footwork.landed holds the feet that touched down this tick: it is emptied here, before CombatSim's updatePose runs
//   the footwork, so the noise bus (phase 17b) and the client read this tick's footsteps after step(). (DungeonStyle's
//   client emptied it after reading; nothing did in world mode.)
import RAPIER from '@dimforge/rapier3d-compat';
import { BONE_ZONE } from '../body/mass';
import type { KccRecV1 } from '../save/schema';
import { MOVE_CROUCH } from '../sim/commands';
import type { Fighter } from '../sim/fighter';
import { applyImpact } from '../sim/impact';
import { DT } from '../sim/math';
import { boneMass, DAMAGE_TUNING, impactEnergy, MOVE_TUNING, zoneToughness } from '../sim/rules';
import { SPECIES_BODY } from '../sim/species';
import { defineTuning } from '../tuning/registry';
import { collisionGroups, kccQueryGroups, solverGroups } from './groups';
import { MATERIALS } from './materials';
import type { FighterMover, Impact, ImpactCause, PostureId, V3 } from './types';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

export const CHARACTER_TUNING = defineTuning(
  'CHARACTER_TUNING',
  'Bodies › controllers',
  {
    pushN: 500,
    // A body this controller pushed last tick that moves slower than this along the push has not yielded (jammed
    // against a rock, a stake, a pile): the controller climbs it if it is low enough (D-28), as it would a fixed one.
    pushYieldSpeed: 0.02,
    capsuleR: 0.3,
    capsuleHalfH: 0.6,
    kccOffset: 0.02,
    snapToGround: 0.3,
    autostepMaxH: 0.4,
    autostepMinW: 0.2,
    autostepDynamic: true,
    maxSlopeClimbDeg: 45,
    minSlopeSlideDeg: 30,
    jumpSpeed: 4.2,
    landingKnockdownSpeed: 9,
    crouchHeightFrac: 0.7,
    // The 12 standing hit zones' shapes (world/zones.ts; §4.8: "bone-shaped sensor colliders"), the bone colliders of
    // DungeonStyle's ragdoll (apps/client/src/body/ragdoll.ts), so a zone is where the body is drawn and falls (rule 3).
    // Per bone frame, × scale: the head a ball `headUp` along the bone; pelvis, abdomen and chest boxes [hx, hy, hz, up];
    // every limb a capsule along its bone (SKELETON radius and length), its half-height length/2 − radius × limbInset,
    // at least minLimbHalf. Read when a fighter's zones are built (per-body state, §1.5.11).
    zoneShapes: {
      headR: 0.11,
      headUp: 0.15,
      pelvis: [0.14, 0.08, 0.09, 0.03],
      abdomen: [0.13, 0.1, 0.09, 0.1],
      chest: [0.17, 0.13, 0.1, 0.13],
      limbInset: 0.5,
      minLimbHalf: 0.01,
    },
  },
  {
    pushN: { unit: 'N', source: 'SPEC:374, 881' },
    pushYieldSpeed: {
      unit: 'm/s',
      source: 'NEW: a 40 kg log jammed against a kerb reads −0.01 m/s after a push, a free one 0.15 m/s (P08 review)',
    },
    capsuleR: { unit: 'm × scale', source: 'DS (BODY_RADIUS)' },
    capsuleHalfH: { unit: 'm × scale', source: 'NEW: 1.8 m tall' },
    kccOffset: { unit: 'm × scale', source: 'NEW: MAP rapier §3' },
    snapToGround: { unit: 'm × scale', source: 'NEW: MAP rapier §3' },
    autostepMaxH: { unit: 'm × scale', source: 'NEW: D-28 (climb = autostep)' },
    autostepMinW: { unit: 'm × scale', source: 'NEW' },
    autostepDynamic: { unit: '—', source: 'NEW' },
    maxSlopeClimbDeg: { unit: '°', source: 'NEW: MAP rapier §3' },
    minSlopeSlideDeg: { unit: '°', source: 'NEW: MAP rapier §3' },
    jumpSpeed: { unit: 'm/s × √scale', source: 'NEW: D-28 (≈ 0.9 m jump)' },
    landingKnockdownSpeed: { unit: 'm/s', source: 'NEW' },
    crouchHeightFrac: { unit: '× capsule height', source: 'NEW: a crouched ape is 1.39 m, so it fits under a deadfall log (RT-4)' },
    zoneShapes: {
      headR: { unit: 'm × scale', source: 'DS (ragdoll.ts head ball)' },
      headUp: { unit: 'm × scale along the bone', source: 'DS (ragdoll.ts head ball)' },
      pelvis: { unit: 'm × scale [hx, hy, hz, up]', source: 'DS (ragdoll.ts pelvis box)' },
      abdomen: { unit: 'm × scale [hx, hy, hz, up]', source: 'DS (ragdoll.ts abdomen box)' },
      chest: { unit: 'm × scale [hx, hy, hz, up]', source: 'DS (ragdoll.ts chest box)' },
      limbInset: { unit: '× bone radius', source: 'DS (ragdoll.ts limb capsules)' },
      minLimbHalf: { unit: 'm × scale', source: 'DS (ragdoll.ts limb capsules)' },
    },
  },
);

/** Postures that hold the body low (§4.2 "a stooped work posture"): the capsule crouches under them. */
const STOOPED: ReadonlySet<PostureId> = new Set<PostureId>(['workLow', 'digScoop', 'crouch']);
const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const UP = Object.freeze({ x: 0, y: 1, z: 0 });
const DOWN = Object.freeze({ x: 0, y: -1, z: 0 });
const DEG = Math.PI / 180;

/** The KCC settings a controller was last given (live CHARACTER_TUNING edits reach it at its next sweep). */
interface Params {
  offset: number;
  snap: number;
  stepH: number;
  stepW: number;
  stepDyn: boolean;
  climb: number;
  slide: number;
}

interface Controller {
  readonly f: Fighter;
  readonly body: RAPIER.RigidBody;
  readonly col: RAPIER.Collider;
  readonly cc: RAPIER.KinematicCharacterController;
  /** m: the capsule's radius and standing half-height (per-body state, fixed when the controller is built). */
  readonly r: number;
  readonly halfH: number;
  /** m: the capsule's half-height now (halfH standing, smaller crouched). */
  halfNow: number;
  crouched: boolean;
  enabled: boolean;
  /** m/s, vertical, while airborne (0 on the ground). */
  vy: number;
  grounded: boolean;
  /** Feet point the next resolve puts the capsule at, skipping the sweep (World.teleport, the slab hand-back). */
  teleport: V3 | null;
  /** Entity ids the last sweep touched, and the ones it pushed (in contact order; read-outs for tests and AC-6). */
  readonly collided: number[];
  readonly pushed: number[];
  /**
   * The pushes this controller queued at tick `pushTick` (entity id, unit horizontal direction): the next tick's sweep
   * reads whether each of those bodies yielded (see metUnyielding). Saved with the record.
   */
  lastPushes: PushDir[];
  pushTick: number;
  params: Params;
}

/** A push queued in phase 3, applied in phase 4d. */
interface Push {
  entity: number;
  j: V3;
}

/** The direction of a push a controller queued (unit, horizontal). */
interface PushDir {
  entity: number;
  x: number;
  z: number;
}

export class CharacterControllers implements FighterMover {
  readonly world: World;
  private readonly byId = new Map<number, Controller>();
  private pending: Push[] = [];

  constructor(world: World) {
    this.world = world;
  }

  /** The capsule at the fighter's feet (f.pos), standing, grounded, enabled. */
  create(f: Fighter): void {
    if (this.byId.has(f.id)) throw new Error(`CharacterControllers.create: fighter ${f.id} already has a controller`);
    const T = CHARACTER_TUNING;
    const s = f.scale;
    const r = T.capsuleR * s;
    const halfH = T.capsuleHalfH * s;
    const params = paramsFor(s);
    const rapier = this.world.physics.rapier;
    const body = rapier.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(f.pos.x, f.pos.y + halfH + r + params.offset, f.pos.z),
    );
    const col = rapier.createCollider(
      RAPIER.ColliderDesc.capsule(halfH, r).setCollisionGroups(collisionGroups('CHAR')).setSolverGroups(solverGroups('CHAR')),
      body,
    );
    this.world.physics.register(col, { kind: 'fighter', id: f.id, part: 'kcc' });
    const cc = rapier.createCharacterController(params.offset);
    // Built-in pushing off (SPEC:374; MAP rapier finding 1): the push is the code push of this file.
    cc.setApplyImpulsesToDynamicBodies(false);
    cc.setSlideEnabled(true);
    configure(cc, params);
    this.byId.set(f.id, {
      f,
      body,
      col,
      cc,
      r,
      halfH,
      halfNow: halfH,
      crouched: false,
      enabled: true,
      vy: 0,
      grounded: true,
      teleport: null,
      collided: [],
      pushed: [],
      lastPushes: [],
      pushTick: -1,
      params,
    });
  }

  remove(f: Fighter): void {
    const c = this.byId.get(f.id);
    if (!c) return;
    this.byId.delete(f.id);
    const physics = this.world.physics;
    physics.unregister(c.col);
    physics.rapier.removeCharacterController(c.cc);
    physics.rapier.removeRigidBody(c.body);
  }

  /**
   * f.pos holds this tick's proposal; resolve it in place, y included (§4.2). Called by CombatSim's separate() for
   * every standing fighter (not knocked down, KO'd or tripped), in fighter order.
   */
  resolve(f: Fighter, _radius: number, _propPad: number): void {
    const c = this.byId.get(f.id);
    if (!c) return;
    f.footwork.landed.length = 0;
    c.collided.length = 0;
    c.pushed.length = 0;
    // Last tick's pushes (a body pushed then and not moving now has not yielded); none after a gap or a teleport.
    const tick = this.world.tick;
    const prior = c.pushTick === tick - 1 ? c.lastPushes : [];
    c.lastPushes = [];
    c.pushTick = tick;
    // Standing again with the controller still off (a respawn, a revive): it comes back where the fighter is now; the
    // slab is handed back in phase 4a (world/downed.ts).
    if (!c.enabled) {
      this.setEnabled(f, true);
      c.teleport ??= { x: f.pos.x, y: f.pos.y, z: f.pos.z };
    }
    this.applyParams(c);
    if (c.teleport) {
      this.place(c, c.teleport);
      c.teleport = null;
      return;
    }
    // The verbs' tether (a dragged grip, a held rope end) shortens the proposal before the sweep (§5.1, §5.12).
    this.world.verbs.tether(f, f.pos);
    const t = c.col.translation();
    const T = CHARACTER_TUNING;
    if (f.jumpRequest > 0 && c.grounded && !c.crouched && f.free && f.stamina >= MOVE_TUNING.jumpStamina) {
      // A jump (§5.5, D-28): CombatSim buffers the press; the controller takes it on the ground and spends its stamina.
      c.vy = T.jumpSpeed * Math.sqrt(f.scale);
      c.grounded = false;
      f.jumpRequest = 0;
      f.stamina = Math.max(0, f.stamina - MOVE_TUNING.jumpStamina);
    }
    let dy = 0;
    if (!c.grounded) {
      c.vy += WORLD_TUNING.gravityY * DT;
      dy = c.vy * DT;
    }
    const desired = { x: f.pos.x - t.x, y: dy, z: f.pos.z - t.z };
    const filter = this.heldFilter(f);
    // Climbing (D-28) steps over static bodies, and over a dynamic one only when the push can't shove it (a felled
    // trunk, a staked log, a light log jammed against a rock): a log the push moves is pushed, not climbed (AC-6
    // part 1). DEVIATION (§9 autostepDynamic): Rapier's autostep takes dynamic bodies all or none; with all, the
    // controller climbs onto a 40 kg log instead of pushing it (measured: it moved 0.32 m walking, 0.06 m running,
    // against AC-6's > 1 m; the C lab's 2.26 m was measured with dynamic bodies left out). So the sweep leaves them out,
    // and is run again with them in only when it met a dynamic body that doesn't yield to the push.
    this.sweep(c, desired, filter, false);
    if (c.params.stepDyn && this.metUnyielding(c, prior)) this.sweep(c, desired, filter, true);
    const m = c.cc.computedMovement();
    // Standing still (no horizontal proposal), the controller moves the fighter only up or down (snap, fall, out of the
    // ground): it never shoves a fighter sideways that isn't going anywhere (a log rolled against it, a teleport next to
    // a stake). Rapier's KCC pushes a capsule out of an overlap even on a zero sweep, without reporting a collision
    // (measured: 0.27 m in one tick, beside a stake 0.15 m from the capsule's axis). A body that moves into a fighter
    // reaches it through the zones and knockback (SPEC:375); the sweep resolves the overlap as soon as the fighter
    // moves. Nor does a fighter standing still push anything (SPEC:374's push is a walk into a body).
    const still = f.pos.x === t.x && f.pos.z === t.z;
    const x = still ? t.x : Math.fround(t.x + m.x);
    let y = Math.fround(t.y + m.y);
    const z = still ? t.z : Math.fround(t.z + m.z);
    const wasAir = !c.grounded;
    let grounded = c.cc.computedGrounded();
    if (!grounded && !wasAir && dy === 0) {
      // Snap to ground (MAP rapier §3): Rapier 0.21 snaps only a sweep that already moves down, and a grounded sweep
      // must not (autostep fails with any downward component, MAP rapier finding 5), so going downhill the controller
      // snaps itself: the capsule cast down at most snapToGround × scale onto a surface it could stand on.
      const snap = this.snapDown(c, { x, y, z }, filter);
      if (snap !== null) {
        y = Math.fround(y - snap);
        grounded = true;
      }
    }
    c.grounded = grounded;
    // Rising and stopped short by more than the controller's skin (a ceiling): the jump is spent.
    if (dy > 0 && m.y + c.params.offset < dy) c.vy = Math.min(c.vy, 0);
    this.queuePushes(c, still);
    // Crouch (§4.2): this sweep used the old shape, the next one sees the new shape at the new centre (feet fixed).
    const crouch = this.wantsCrouch(f);
    if (crouch !== c.crouched) {
      const half = crouch ? crouchHalf(c) : c.halfH;
      if (crouch || this.headroom(c, f, { x, y, z })) {
        y = Math.fround(y + (half - c.halfNow));
        c.col.setHalfHeight(half);
        c.halfNow = half;
        c.crouched = crouch;
      }
    }
    c.body.setNextKinematicTranslation({ x, y, z });
    f.pos.set(x, y - footOffset(c), z);
    if (c.grounded) {
      const v = wasAir ? Math.max(0, -c.vy) : 0;
      c.vy = 0;
      if (wasAir) this.landed(f, c, v);
    }
  }

  /** Off: the capsule leaves the world (a downed fighter's slab takes over); on: back where it was until a teleport. */
  setEnabled(f: Fighter, on: boolean): void {
    const c = this.byId.get(f.id);
    if (!c || c.enabled === on) return;
    c.enabled = on;
    c.body.setEnabled(on);
    c.vy = 0;
    c.grounded = true;
    c.lastPushes = [];
  }

  /** The next resolve places the capsule here (feet point) and skips the sweep (MAP gap-1 §3.6). */
  teleport(f: Fighter, x: number, y: number, z: number): void {
    const c = this.byId.get(f.id);
    if (!c) return;
    c.teleport = { x, y, z };
  }

  /** Whether the fighter's capsule is in the world (off while its slab is down). */
  isEnabled(f: Fighter): boolean {
    return this.byId.get(f.id)?.enabled ?? false;
  }

  /** Whether a teleport waits for the next resolve. */
  teleportPending(f: Fighter): boolean {
    return !!this.byId.get(f.id)?.teleport;
  }

  /** Phase 4d: the pushes queued by this tick's sweeps, into the entity store's impulse queue in entity id order. */
  applyPushes(): void {
    if (this.pending.length === 0) return;
    const list = this.pending;
    this.pending = [];
    list.sort((a, b) => a.entity - b.entity); // stable: controller (fighter) order within one entity
    const entities = this.world.entities;
    for (const p of list) if (entities.get(p.entity)) entities.queueImpulse(p.entity, p.j, null);
  }

  grounded(f: Fighter): boolean {
    return this.byId.get(f.id)?.grounded ?? true;
  }

  /** Capsule at crouchHeightFrac (§4.2). */
  crouched(f: Fighter): boolean {
    return this.byId.get(f.id)?.crouched ?? false;
  }

  /** m/s: the vertical speed of an airborne controller (0 on the ground). */
  verticalSpeed(f: Fighter): number {
    return this.byId.get(f.id)?.vy ?? 0;
  }

  /** m: the capsule's height now (2 × (half-height + radius)). */
  heightOf(f: Fighter): number {
    const c = this.byId.get(f.id);
    return c ? 2 * (c.halfNow + c.r) : 0;
  }

  /** m: from the feet (f.pos.y) to the capsule's centre: half-height + radius + the controller's offset. */
  footOffsetOf(f: Fighter): number {
    const c = this.byId.get(f.id);
    return c ? footOffset(c) : 0;
  }

  /** Entity ids the fighter's last sweep touched (AC-6: "the KCC reported a computed collision with the boulder"). */
  collidedEntities(f: Fighter): readonly number[] {
    return this.byId.get(f.id)?.collided ?? [];
  }

  /** Entity ids the fighter's last sweep queued a push on. */
  pushedEntities(f: Fighter): readonly number[] {
    return this.byId.get(f.id)?.pushed ?? [];
  }

  /** The capsule's body pose as Rapier holds it (f32), or null. */
  capsulePose(f: Fighter): { p: V3; q: { x: number; y: number; z: number; w: number } } | null {
    const c = this.byId.get(f.id);
    if (!c) return null;
    const p = c.body.translation();
    const q = c.body.rotation();
    return { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  /** By fighter id. */
  toRecord(): { fighter: number; kcc: KccRecV1 }[] {
    return [...this.byId.values()]
      .sort((a, b) => a.f.id - b.f.id)
      .map((c) => {
        const p = c.body.translation();
        const q = c.body.rotation();
        const kcc: KccRecV1 = {
          pose: { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } },
          vy: c.vy,
          grounded: c.grounded,
          crouched: c.crouched,
          enabled: c.enabled,
          halfHeight: c.halfNow,
          teleport: c.teleport ? { ...c.teleport } : null,
          pushes: c.lastPushes.map((p) => ({ entity: p.entity, x: p.x, z: p.z })),
          pushTick: c.pushTick,
        };
        return { fighter: c.f.id, kcc };
      });
  }

  /**
   * Puts each listed fighter's controller back as recorded (the fighters were added to the world first). The capsules'
   * colliders are moved with their bodies at once (Rapier moves a collider with its body only at the next step), so the
   * first sweep after a load starts where the record says, not where the capsule was before it.
   */
  restoreRecord(r: { fighter: number; kcc: KccRecV1 }[]): void {
    for (const { fighter, kcc } of r) {
      const c = this.byId.get(fighter);
      if (!c) throw new Error(`CharacterControllers.restoreRecord: fighter ${fighter} has no controller`);
      const half = typeof kcc.halfHeight === 'number' ? kcc.halfHeight : kcc.crouched ? crouchHalf(c) : c.halfH;
      if (half !== c.halfNow) {
        c.col.setHalfHeight(half);
        c.halfNow = half;
      }
      c.crouched = kcc.crouched;
      const enabled = kcc.enabled !== false;
      if (enabled !== c.enabled) {
        c.enabled = enabled;
        c.body.setEnabled(enabled);
      }
      c.body.setTranslation(kcc.pose.p, true);
      c.body.setRotation(kcc.pose.q, true);
      c.vy = kcc.vy;
      c.grounded = kcc.grounded;
      const tp = kcc.teleport as V3 | null | undefined;
      c.teleport = tp ? { x: tp.x, y: tp.y, z: tp.z } : null;
      const pushes = Array.isArray(kcc.pushes) ? (kcc.pushes as PushDir[]) : [];
      c.lastPushes = pushes.map((p) => ({ entity: p.entity, x: p.x, z: p.z }));
      c.pushTick = typeof kcc.pushTick === 'number' ? kcc.pushTick : -1;
      c.collided.length = 0;
      c.pushed.length = 0;
    }
    this.world.physics.rapier.propagateModifiedBodyPositionsToColliders();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A teleport: the capsule is put at the feet point at once (no sweep through the world), at rest on the ground. */
  private place(c: Controller, feet: V3): void {
    const off = footOffset(c);
    const x = Math.fround(feet.x);
    const y = Math.fround(feet.y + off);
    const z = Math.fround(feet.z);
    c.body.setTranslation({ x, y, z }, true);
    c.f.pos.set(x, y - off, z);
    c.vy = 0;
    c.grounded = true;
  }

  /** Live CHARACTER_TUNING edits reach the controller (only the values that changed are set again). */
  private applyParams(c: Controller): void {
    const want = paramsFor(c.f.scale);
    const had = c.params;
    if (sameParams(want, had)) return;
    if (want.offset !== had.offset) {
      // The feet stay where they are: the centre moves with the offset (and the collider with it now, for this sweep).
      const t = c.body.translation();
      c.body.setTranslation({ x: t.x, y: Math.fround(t.y + want.offset - had.offset), z: t.z }, true);
      this.world.physics.rapier.propagateModifiedBodyPositionsToColliders();
    }
    configure(c.cc, want);
    c.params = want;
  }

  /** MOVE_CROUCH, a stooped work posture, or a mind's tug script (§4.2). */
  private wantsCrouch(f: Fighter): boolean {
    if ((f.moveFlags & MOVE_CROUCH) !== 0) return true;
    const p = f.posture;
    if (p && p.weight > 0 && STOOPED.has(p.id)) return true;
    return this.world.minds.get(f)?.script?.kind === 'tug';
  }

  /**
   * Room to stand up (§4.2): the crouched capsule cast straight up by the height it would gain, from `centre` (this
   * tick's resolved centre), meets nothing (terrain, entities, the tripped ruler; sensors, other fighters and the held
   * entity left out). A cast that starts touching the ground below and moves away from it is not a hit
   * (stopAtPenetration false).
   */
  private headroom(c: Controller, f: Fighter, centre: V3): boolean {
    const rise = 2 * (c.halfH - c.halfNow);
    if (!(rise > 0)) return true;
    const hit = this.world.physics.rapier.castShape(
      centre,
      IDENTITY,
      UP,
      new RAPIER.Capsule(c.halfNow, c.r),
      c.params.offset,
      rise,
      false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      kccQueryGroups(),
      c.col,
      c.body,
      this.heldFilter(f),
    );
    return hit === null;
  }

  /** One KCC sweep from the capsule's last-step pose, autostep over dynamic bodies or not. */
  private sweep(c: Controller, desired: V3, filter: ((col: RAPIER.Collider) => boolean) | undefined, stepDynamic: boolean): void {
    const p = c.params;
    if (stepDynamic) c.cc.enableAutostep(p.stepH, p.stepW, true);
    c.cc.computeColliderMovement(c.col, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccQueryGroups(), filter);
    if (stepDynamic) c.cc.enableAutostep(p.stepH, p.stepW, false);
  }

  /**
   * Whether the last sweep met a dynamic entity the push can't shove: anchored (lashed to a stake); heavy enough that
   * its friction (its material's coefficient × its weight) is at least pushN; or pushed by this controller last tick
   * (`prior`) and moving slower than pushYieldSpeed along that push now (jammed: a light log against a rock or a kerb).
   * The first contact always pushes, so a free log slides (AC-6); a jammed one is climbed from the next tick on. The
   * speed is the body's velocity now, as last tick's step left it (saved with the entity, so a load reads it too), not
   * the pre-step store (phase 5), which holds the push's own impulse (+0.20 m/s on a jammed 40 kg log).
   */
  private metUnyielding(c: Controller, prior: readonly PushDir[]): boolean {
    const physics = this.world.physics;
    const entities = this.world.entities;
    const n = c.cc.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const col = c.cc.computedCollision(i)?.collider;
      if (!col) continue;
      const o = physics.ownerOf(col.handle);
      if (!o || o.kind !== 'entity') continue;
      const e = entities.get(o.id);
      const b = e?.body;
      if (!e || !b || !b.isEnabled() || !b.isDynamic()) continue;
      if (entities.isAnchored(e)) return true;
      if (MATERIALS[e.material].friction * e.mass * Math.abs(WORLD_TUNING.gravityY) >= CHARACTER_TUNING.pushN) return true;
      const last = prior.find((p) => p.entity === e.id);
      if (last) {
        const v = b.linvel();
        if (v.x * last.x + v.z * last.z < CHARACTER_TUNING.pushYieldSpeed) return true;
      }
    }
    return false;
  }

  /**
   * How far down (m) the capsule at `centre` snaps onto ground it could stand on (a normal within maxSlopeClimbDeg of
   * up), ending the controller's offset above it; null when nothing is within snapToGround × scale.
   */
  private snapDown(c: Controller, centre: V3, filter: ((col: RAPIER.Collider) => boolean) | undefined): number | null {
    const hit = this.world.physics.rapier.castShape(
      centre,
      IDENTITY,
      DOWN,
      new RAPIER.Capsule(c.halfNow, c.r),
      c.params.offset,
      c.params.snap,
      false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      kccQueryGroups(),
      c.col,
      c.body,
      filter,
    );
    if (!hit || hit.normal1.y < Math.cos(c.params.climb)) return null;
    return hit.time_of_impact;
  }

  /** A predicate that leaves the entity in the fighter's hands out of its sweeps (a carried or dragged load). */
  private heldFilter(f: Fighter): ((col: RAPIER.Collider) => boolean) | undefined {
    const held = f.inventory?.hands?.entity;
    if (held === undefined) return undefined;
    const physics = this.world.physics;
    return (col) => {
      const o = physics.ownerOf(col.handle);
      return !(o && o.kind === 'entity' && o.id === held);
    };
  }

  /** The sweep's computed collisions: read-outs, and a push for each dynamic, non-anchored entity walked into. */
  private queuePushes(c: Controller, still: boolean): void {
    const physics = this.world.physics;
    const entities = this.world.entities;
    const standCos = Math.cos(CHARACTER_TUNING.maxSlopeClimbDeg * DEG);
    const n = c.cc.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const hit = c.cc.computedCollision(i);
      const col = hit?.collider;
      if (!hit || !col) continue;
      const o = physics.ownerOf(col.handle);
      if (!o || o.kind !== 'entity') continue;
      if (!c.collided.includes(o.id)) c.collided.push(o.id);
      if (still || c.pushed.includes(o.id)) continue;
      const e = entities.get(o.id);
      const b = e?.body;
      if (!e || !b || !b.isEnabled() || !b.isDynamic() || entities.isAnchored(e)) continue;
      // normal1 points out of the obstacle toward the character (MAP rapier §3): a surface steep enough to stand on is
      // ground (standing on a log doesn't shove it); the push goes the other way, horizontally.
      const nrm = hit.normal1;
      if (nrm.y >= standCos) continue;
      const hx = -nrm.x;
      const hz = -nrm.z;
      const l = Math.hypot(hx, hz);
      if (!(l > 0)) continue;
      const J = CHARACTER_TUNING.pushN * DT;
      this.pending.push({ entity: o.id, j: { x: (hx / l) * J, y: 0, z: (hz / l) * J } });
      c.pushed.push(o.id);
      c.lastPushes.push({ entity: o.id, x: hx / l, z: hz / l });
    }
  }

  /**
   * Touchdown after a jump or a fall at `v` m/s (§4.2): a `land` event (thud, dust, noise); a hard landing scored by the
   * rule on the shin, feet first, against what is under the feet (landingImpact); faster than landingKnockdownSpeed, a
   * knockdown (the slab takes over in phase 4a).
   */
  private landed(f: Fighter, c: Controller, v: number): void {
    const w = this.world;
    const point = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
    // What the feet came down on: a ray from inside the capsule's foot to just under the feet.
    const probe = c.r + c.params.offset;
    const under = w.queries.castRay({ x: point.x, y: point.y + c.r, z: point.z }, DOWN, 2 * probe, { terrain: true, entities: 'all' });
    const entityId = under?.owner.kind === 'entity' ? under.owner.id : null;
    const e = entityId !== null ? w.entities.get(entityId) : undefined;
    const cause: ImpactCause = e
      ? { kind: 'entity', entityId: e.id, fighterId: null, credit: [...e.credit], held: false, feature: 'fall' }
      : { kind: 'terrain', entityId: null, fighterId: null, credit: [], held: false, feature: 'fall' };
    const impactorMass = !e || e.state === 'fixed' || e.state === 'anchored' || w.entities.isAnchored(e) ? Infinity : e.mass;
    const impact = landingImpact(f, v, cause, point, impactorMass);
    w.events.push({ type: 'land', entity: e ? e.id : null, f, point, energy: impact?.energy ?? 0, mass: f.mass });
    if (impact) applyImpact(w.combat, impact);
    if (v > CHARACTER_TUNING.landingKnockdownSpeed && f.alive && f.state !== 'knockdown') f.enterKnockdown();
  }
}

/**
 * A hard landing by the rule (§4.2, §4.3): bone shinL (feet first), m_eff = the shin's bone mass, v_n = the landing
 * speed, s = 0, minus the species' safe landing ½·m·v_safe² (v_safe = 6·√scale, D-4) while hardLandingBluntOnly holds;
 * null below DAMAGE_TUNING.minImpactJ (no Δv either way: the ground is static). `point` is the feet, the normal points
 * out of the fighter (down).
 */
export function landingImpact(f: Fighter, v: number, cause: ImpactCause, point: V3, impactorMass: number): Impact | null {
  const bone = 'shinL' as const;
  const mb = boneMass(f, bone);
  let E = impactEnergy(mb, v, 0);
  if (DAMAGE_TUNING.hardLandingBluntOnly) E = Math.max(0, E - impactEnergy(mb, safeLandingSpeed(f), 0));
  if (!(E >= DAMAGE_TUNING.minImpactJ)) return null;
  const zone = BONE_ZONE[bone];
  return {
    target: f,
    bone,
    zone,
    rulerZone: null,
    point: { x: point.x, y: point.y, z: point.z },
    normal: { x: 0, y: -1, z: 0 },
    mEff: mb,
    vn: v,
    sharpness: 0,
    energy: E,
    toughness: zoneToughness(f, zone),
    dv: { x: 0, y: 0, z: 0 },
    impactorMass,
    cause,
  };
}

/** m/s: the species' v_safe (SPEC_BODY, 6·√scale, D-4); a fighter of no species lands as a human of its scale. */
export function safeLandingSpeed(f: Fighter): number {
  return f.species ? SPECIES_BODY[f.species].vSafe : SPECIES_BODY.human.vSafe * Math.sqrt(f.scale);
}

function paramsFor(scale: number): Params {
  const T = CHARACTER_TUNING;
  return {
    offset: T.kccOffset * scale,
    snap: T.snapToGround * scale,
    stepH: T.autostepMaxH * scale,
    stepW: T.autostepMinW * scale,
    stepDyn: T.autostepDynamic,
    climb: T.maxSlopeClimbDeg * DEG,
    slide: T.minSlopeSlideDeg * DEG,
  };
}

function sameParams(a: Params, b: Params): boolean {
  return (
    a.offset === b.offset &&
    a.snap === b.snap &&
    a.stepH === b.stepH &&
    a.stepW === b.stepW &&
    a.stepDyn === b.stepDyn &&
    a.climb === b.climb &&
    a.slide === b.slide
  );
}

/** The KCC's settings; autostep leaves dynamic bodies out (a sweep that needs them sets them for itself, see resolve). */
function configure(cc: RAPIER.KinematicCharacterController, p: Params): void {
  cc.setOffset(p.offset);
  cc.enableSnapToGround(p.snap);
  cc.enableAutostep(p.stepH, p.stepW, false);
  cc.setMaxSlopeClimbAngle(p.climb);
  cc.setMinSlopeSlideAngle(p.slide);
}

/** m: feet (f.pos.y) to capsule centre. */
function footOffset(c: Controller): number {
  return c.halfNow + c.r + c.params.offset;
}

/** m: the half-height that makes the capsule crouchHeightFrac of its standing height, feet fixed (§4.2). */
function crouchHalf(c: Controller): number {
  return Math.max(0, CHARACTER_TUNING.crouchHeightFrac * (c.halfH + c.r) - c.r);
}
