// Downed and launched bodies (docs/M1-DESIGN.md §1.5.8, §4.5): a sim-side dynamic rounded slab per player/ape, enabled
// while it is down; launch, follow, settle, the stand-spot search and the hand-back to the controller. The client's
// ragdoll follows it (rule 6).
//
// - The slab (departure X2: a lying capsule rolls down any slope and never rests, MAP gap-4 §3) is built with the
//   fighter and disabled: roundCuboid(halfWidth, halfLength, halfThick, border) × scale (0.48 × 1.81 × 0.20 m at scale
//   1), mass f.mass, CCD on, groups DOWNED (standing controllers walk through it, DS), COLLISION_EVENTS. Local +Y runs
//   feet → head, +Z is the fighter's forward, +X its left.
// - Phase 4a: a fighter that is knocked down or KO'd and has no active slab gets it, standing where the fighter stood
//   (feet at f.pos, yaw), launched with (f.vel + f.walkVel)_xz (at least minPush along the blow), the DS presentation
//   pop (liftBase + liftPerLift × the move's lift) when a melee blow put it down this tick, and any queued Δv; it topples
//   at toppleRadS/√scale about up × dir. f.vel and f.walkVel go to 0 (the body owns the momentum); the controller and the
//   zones are disabled; a `launch` event carries the velocities to the client's ragdoll.
// - Clear of dynamic bodies (core-fix). DEVIATION (§4.5 enables the slab where the fighter stood and leaves the rest to
//   Rapier): a slab is never solved against a dynamic body it was enabled inside. When the slab comes into the world
//   (the launch in phase 4a, or a downed fighter's teleport) it lists the dynamic bodies (entities, other slabs, a
//   tripped ruler) that reach its spine (its long axis thickened to the core's half-thickness, halfThick × scale: the
//   body's centre line), and the step leaves those pairs out (PhysicsWorld.addPairFilter). In every later phase 4a the
//   list only shrinks: a body that no longer reaches the spine leaves it and is solid to the slab from then on; nothing
//   joins it. A slab enabled where the fighter stood inside a falling log no longer has Rapier throw the log out of it (a
//   300 kg log that pressed the player from 4 m went back up at +4.95 m/s, AC-6 part 2): the log falls on through to the
//   ground, as it fell through the standing zones, and the body falls against it once they are apart. A body that comes
//   onto the slab later is always solved against it, however deep a fast one ends a step inside it (a log has no CCD:
//   at 10-17 m/s it moves 0.17-0.29 m a tick, past the 4 cm border): listing it then would let it fall through the body
//   unscored. Fixed bodies and the terrain are always solid to the slab, and a body touching it or overlapping only its
//   edge at the launch is solved as usual. The list is saved (bodies[].slab.notClearOf) and restored as it is.
// - Phase 13a: f.pos follows the slab's hip (x, z; y = the support under it). On the frame before the getup a slab
//   still moving faster than settleSpeed holds the fighter down (at most settleMaxHold frames); then the stand-spot
//   search finds where the standing capsule fits, the slab is disabled and the controller is teleported there. The
//   zones come back in the next phase 4a, posed at the getup's rig, with their history reset and a contact grace (RF-1).
// - A KO'd body keeps its slab (the corpse) until the fighter is removed or stands again (a respawn: phase 4a hands
//   it back where the fighter now is).
import RAPIER from '@dimforge/rapier3d-compat';
import type { BoneName } from '../body/skeleton';
import type { SlabRecV1 } from '../save/schema';
import type { Fighter } from '../sim/fighter';
import { defineTuning } from '../tuning/registry';
import { CHARACTER_TUNING } from './characters';
import { collisionGroups, GROUP, kccQueryGroups, solverGroups } from './groups';
import { ownerKey } from './physics';
import type { Quat, V3 } from './types';
import type { World } from './world';

export const DOWNED_TUNING = defineTuning(
  'DOWNED_TUNING',
  'Bodies › downed',
  {
    halfWidth: 0.2,
    halfLength: 0.865,
    halfThick: 0.06,
    border: 0.04,
    friction: 0.9,
    restitution: 0.05,
    linDamp: 0.05,
    angDamp: 0.6,
    toppleRadS: 2.5,
    liftBase: 1.2,
    liftPerLift: 3,
    minPush: 0.8,
    settleSpeed: 0.5,
    settleMaxHold: 300,
    standRings: [0.35, 0.7, 1.05],
    standDirs: 8,
    maxStandSlopeDeg: 45,
    boneBands: [0.5, 0.94, 1.09, 1.29, 1.55],
    // Not §9.1 rows (values MAP gap-4 §6's stand-spot search uses, kept here so no file holds them as bare constants):
    // the cast of the standing capsule starts this far above the hip and reaches this far down from there.
    standCastUp: 2.5,
    standCastLength: 6,
  },
  {
    halfWidth: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    halfLength: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    halfThick: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    border: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    friction: { unit: '—', source: 'NEW: MAP gap-4' },
    restitution: { unit: '—', source: 'NEW: MAP gap-4' },
    linDamp: { unit: '1/s', source: 'NEW: MAP gap-4' },
    angDamp: { unit: '1/s', source: 'NEW: MAP gap-4' },
    toppleRadS: { unit: 'rad/s ÷ √scale', source: 'NEW: MAP gap-4' },
    liftBase: { unit: 'm/s', source: 'DS (game.ts launch)' },
    liftPerLift: { unit: 'm/s per lift', source: 'DS (game.ts launch)' },
    minPush: { unit: 'm/s', source: 'NEW: MAP gap-4' },
    settleSpeed: { unit: 'm/s', source: 'NEW' },
    settleMaxHold: { unit: 'frames', source: 'NEW' },
    standRings: { unit: 'm', source: 'NEW: MAP gap-4 §6' },
    standDirs: { unit: 'directions', source: 'NEW' },
    maxStandSlopeDeg: { unit: '°', source: 'NEW' },
    boneBands: { unit: 'm along the slab × scale (shin/thigh/pelvis/abdomen/chest/head)', source: 'NEW: from the skeleton' },
    standCastUp: { unit: 'm × scale above the hip', source: 'NEW: MAP gap-4 §6 (lab2.mjs standSpot)' },
    standCastLength: { unit: 'm × scale', source: 'NEW: MAP gap-4 §6 (lab2.mjs standSpot)' },
  },
);

interface Slab {
  readonly f: Fighter;
  readonly body: RAPIER.RigidBody;
  readonly col: RAPIER.Collider;
  /** m: half the slab's length, border included (per-body state, fixed when the slab is built). */
  readonly halfLen: number;
  readonly key: string;
  active: boolean;
  /** Frames the getup has been held (settling, or no stand spot yet). */
  hold: number;
  /** Handed back in the last phase 13a: the zones come back in the next phase 4a. */
  handedBack: boolean;
  /** Δv queued by world impacts (applied in the next phase 4a). */
  dv: V3 | null;
  /**
   * The handles of the dynamic bodies the slab isn't clear of: those that reached its spine when it came into the world
   * (launch, teleport) and have reached it in every phase 4a since. The step leaves those pairs out. Saved by owner id
   * (bodies[].slab.notClearOf); empty while the slab is off.
   */
  clearOf: Set<number>;
}

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
/** The groups of dynamic bodies a slab collides with (entities, other slabs, a tripped ruler's solid bones). */
const COLLIDES_DOWNED_DYNAMIC = GROUP.ENTITY | GROUP.DOWNED | GROUP.RULER_SOLID;
const DOWN = Object.freeze({ x: 0, y: -1, z: 0 });

export class DownedBodies {
  readonly world: World;
  private readonly byId = new Map<number, Slab>();

  /** Body handle of an active slab with bodies it isn't clear of → that slab (the pair filter's index). */
  private readonly ghosts = new Map<number, Slab>();

  constructor(world: World) {
    this.world = world;
    world.physics.addPairFilter((b1, b2) => this.ghostPair(b1, b2) || this.ghostPair(b2, b1));
  }

  /** The slab, disabled, standing where the fighter stands. */
  create(f: Fighter): void {
    if (this.byId.has(f.id)) throw new Error(`DownedBodies.create: fighter ${f.id} already has a slab`);
    const T = DOWNED_TUNING;
    const s = f.scale;
    const halfLen = (T.halfLength + T.border) * s;
    const physics = this.world.physics;
    const body = physics.rapier.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setEnabled(false)
        .setTranslation(f.pos.x, f.pos.y + halfLen, f.pos.z)
        .setRotation(yawQuat(f.yaw))
        .setLinearDamping(T.linDamp)
        .setAngularDamping(T.angDamp)
        .setCcdEnabled(true),
    );
    const col = physics.rapier.createCollider(
      RAPIER.ColliderDesc.roundCuboid(T.halfWidth * s, T.halfLength * s, T.halfThick * s, T.border * s)
        .setMass(f.mass)
        .setFriction(T.friction)
        .setRestitution(T.restitution)
        .setCollisionGroups(collisionGroups('DOWNED'))
        .setSolverGroups(solverGroups('DOWNED'))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    const owner = { kind: 'fighter' as const, id: f.id, part: 'slab' as const };
    physics.register(col, owner);
    this.byId.set(f.id, { f, body, col, halfLen, key: ownerKey(owner), active: false, hold: 0, handedBack: false, dv: null, clearOf: new Set() });
  }

  remove(f: Fighter): void {
    const s = this.byId.get(f.id);
    if (!s) return;
    this.byId.delete(f.id);
    this.ghosts.delete(s.body.handle);
    this.world.physics.unregister(s.col);
    this.world.physics.rapier.removeRigidBody(s.body);
  }

  /**
   * Phase 4a, in fighter order: fighters that went down this tick (or in phase 9 of the last) get their slab, launched;
   * a queued Δv reaches an active slab; a slab handed back last tick gets the zones back; a fighter standing again
   * without a hand-back (a respawn) gets its controller and zones back where it is now.
   */
  syncDown(w: World): void {
    // The lift of the melee blow that put each fighter down this tick (DS game.ts's launch pop).
    let lifts: Map<Fighter, number> | null = null;
    for (const e of w.combat.events) {
      if (e.type !== 'hit' || !(e.knockdown || e.ko)) continue;
      (lifts ??= new Map()).set(e.defender, e.move.lift ?? 0);
    }
    for (const f of w.combat.fighters) {
      const s = this.byId.get(f.id);
      if (!s) continue;
      const down = f.state === 'knockdown' || f.state === 'ko';
      if (s.handedBack) {
        s.handedBack = false;
        if (!down && !s.active) w.zones.setEnabled(f, true);
      }
      if (!s.active) {
        if (down) {
          this.launch(w, f, s, lifts?.get(f) ?? null);
          this.updateClear(s, true);
        } else {
          // A Δv meant for a standing fighter is CombatSim's (f.vel); one left over from a launch that didn't happen goes.
          s.dv = null;
          this.updateClear(s, false);
        }
      } else {
        if (s.dv) {
          const v = s.body.linvel();
          s.body.setLinvel({ x: v.x + s.dv.x, y: v.y + s.dv.y, z: v.z + s.dv.z }, true);
          s.dv = null;
        }
        if (!down) this.standUp(w, f, s);
        this.updateClear(s, false);
      }
    }
  }

  /**
   * Phase 13a, in fighter order: f.pos ← the slab hip's support point; on the frame before the getup, the settle hold
   * or the stand-spot search and the hand-back to the controller (§4.5).
   */
  postStep(w: World): void {
    const T = DOWNED_TUNING;
    for (const f of w.combat.fighters) {
      const s = this.byId.get(f.id);
      if (!s || !s.active) continue;
      f.footwork.landed.length = 0;
      const hip = this.hipOf(s);
      f.pos.set(hip.x, w.supportAt(hip.x, hip.z, hip.y), hip.z);
      if (f.state !== 'knockdown' || f.stateFrame < f.stunFrames - 1) continue;
      // The frame before the getup (CombatSim's advance gets the fighter up when stateFrame reaches stunFrames).
      const v = s.body.linvel();
      const a = s.body.angvel();
      const speed = Math.hypot(v.x, v.y, v.z) + Math.hypot(a.x, a.y, a.z) * s.halfLen;
      if (speed > T.settleSpeed && s.hold < T.settleMaxHold) {
        this.hold(f, s);
        continue;
      }
      const spot = this.standSpot(f, s, hip);
      if (!spot && s.hold < T.settleMaxHold) {
        this.hold(f, s);
        continue;
      }
      // No stand spot within the hold: up where the hip is (the controller resolves from there).
      this.handBack(w, f, s, spot ?? { x: hip.x, y: w.supportAt(hip.x, hip.z, hip.y), z: hip.z });
    }
  }

  /**
   * World.teleport of a fighter that is down on its active slab (knocked down or KO'd): the slab goes with it, at rest,
   * turned by `turn` (rad) about the vertical, its hip over (x, z) and its lowest point on `y` (the support World.teleport
   * found there); its pose history is reset (§4.3, RF-1; World.teleport opens the contact grace). Phase 13a then reads
   * f.pos from it there. Returns false, moving nothing, for a fighter not down on its slab (a standing one is the
   * controller's; one that went down this tick gets its slab where f.pos is in the next phase 4a).
   */
  teleport(f: Fighter, x: number, y: number, z: number, turn: number): boolean {
    const s = this.byId.get(f.id);
    if (!s || !s.active || (f.state !== 'knockdown' && f.state !== 'ko')) return false;
    const T = DOWNED_TUNING;
    const sc = f.scale;
    const q0 = s.body.rotation();
    const q = mulQuat(yawQuat(turn), { x: q0.x, y: q0.y, z: q0.z, w: q0.w });
    const toHip = rotate(q, { x: 0, y: T.boneBands[1] * sc - s.halfLen, z: 0 });
    const down = verticalExtent(q, T.halfWidth * sc, T.halfLength * sc, T.halfThick * sc) + T.border * sc;
    s.body.setTranslation({ x: x - toHip.x, y: y + down, z: z - toHip.z }, true);
    s.body.setRotation(q, true);
    s.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    s.dv = null;
    this.world.physics.resetHistory(s.key);
    // In the world anew where it lands: what it isn't clear of there (what it left behind is solid to it again).
    this.updateClear(s, true);
    return true;
  }

  /** A world impact's Δv for a downed or launched fighter (applied in the next phase 4a). */
  queueDv(f: Fighter, dv: V3): void {
    const s = this.byId.get(f.id);
    if (!s) return;
    s.dv = s.dv ? { x: s.dv.x + dv.x, y: s.dv.y + dv.y, z: s.dv.z + dv.z } : { x: dv.x, y: dv.y, z: dv.z };
  }

  /** Read-only (client ragdoll): the active slab's pose as Rapier holds it, else null. */
  pose(fighterId: number): { p: V3; q: Quat } | null {
    const s = this.byId.get(fighterId);
    if (!s || !s.active) return null;
    const p = s.body.translation();
    const q = s.body.rotation();
    return { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  /** Whether the fighter's slab is in the world. */
  active(f: Fighter): boolean {
    return this.byId.get(f.id)?.active ?? false;
  }

  /**
   * The ids of the entities the step leaves out of the fighter's active slab this tick (Slab.clearOf: they reached its
   * spine when it came into the world and in every phase 4a since), in id order; [] when it is clear of every entity.
   */
  notClearOf(f: Fighter): number[] {
    const s = this.byId.get(f.id);
    if (!s || s.clearOf.size === 0) return [];
    const out: number[] = [];
    for (const e of this.world.entities.all()) if (e.body && s.clearOf.has(e.body.handle)) out.push(e.id);
    return out;
  }

  /** The active slab's linear and angular velocity (f32), else null. */
  velocity(fighterId: number): { lin: V3; ang: V3 } | null {
    const s = this.byId.get(fighterId);
    if (!s || !s.active) return null;
    const v = s.body.linvel();
    const a = s.body.angvel();
    return { lin: { x: v.x, y: v.y, z: v.z }, ang: { x: a.x, y: a.y, z: a.z } };
  }

  /** The active slab's hip point (world), else null. */
  hip(fighterId: number): V3 | null {
    const s = this.byId.get(fighterId);
    return s && s.active ? this.hipOf(s) : null;
  }

  /**
   * The bone a contact at world `point` on the fighter's slab meets (§4.5: damage while down): the point's height
   * along the slab from its foot end, ÷ scale, against boneBands (shin, thigh, pelvis, abdomen, chest, else head); a
   * shin or thigh on the side of the axis the point is on (local +X is the fighter's left). Null without a slab.
   */
  boneAt(f: Fighter, point: V3): BoneName | null {
    const s = this.byId.get(f.id);
    if (!s) return null;
    const p = s.body.translation();
    const q = s.body.rotation();
    const l = rotateInv(q, { x: point.x - p.x, y: point.y - p.y, z: point.z - p.z });
    const h = (l.y + s.halfLen) / f.scale;
    const B = DOWNED_TUNING.boneBands;
    const side = l.x >= 0 ? 'L' : 'R';
    if (h < B[0]) return side === 'L' ? 'shinL' : 'shinR';
    if (h < B[1]) return side === 'L' ? 'thighL' : 'thighR';
    if (h < B[2]) return 'pelvis';
    if (h < B[3]) return 'abdomen';
    if (h < B[4]) return 'chest';
    return 'head';
  }

  /** By fighter id. */
  toRecord(): { fighter: number; slab: SlabRecV1 }[] {
    return [...this.byId.values()]
      .sort((a, b) => a.f.id - b.f.id)
      .map((s) => {
        const p = s.body.translation();
        const q = s.body.rotation();
        const v = s.body.linvel();
        const a = s.body.angvel();
        const slab: SlabRecV1 = {
          enabled: s.active,
          pose: { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } },
          lin: { x: v.x, y: v.y, z: v.z },
          ang: { x: a.x, y: a.y, z: a.z },
          hold: s.hold,
          handedBack: s.handedBack,
          dv: s.dv ? { ...s.dv } : null,
          notClearOf: this.clearOfRecord(s),
        };
        return { fighter: s.f.id, slab };
      });
  }

  /**
   * Puts each listed fighter's slab back as recorded (the fighters and the entities were added to the world first), with
   * the standing zones as they are at a tick end beside it: off exactly while the slab is active, and until the phase 4a
   * after it was handed back (syncDown); on otherwise (ZoneBodies.setEnabled(true) resets their history and opens a
   * grace, RF-1). What an active slab isn't clear of is the record's (notClearOf), never derived again from the poses: the
   * loader's zero-length step and the first tick leave out the pairs the saved world's would. A slab that isn't active
   * has none (a record that says otherwise is broken), and a listed id must name an entity with a body, another
   * fighter's slab or a ruler's body.
   */
  restoreRecord(r: { fighter: number; slab: SlabRecV1 }[]): void {
    for (const { fighter, slab } of r) {
      const s = this.byId.get(fighter);
      if (!s) throw new Error(`DownedBodies.restoreRecord: fighter ${fighter} has no slab`);
      s.body.setTranslation(slab.pose.p, false);
      s.body.setRotation(slab.pose.q, false);
      s.active = slab.enabled;
      s.body.setEnabled(slab.enabled);
      s.body.setLinvel(slab.lin, slab.enabled);
      s.body.setAngvel(slab.ang, slab.enabled);
      s.hold = typeof slab.hold === 'number' ? slab.hold : 0;
      s.handedBack = slab.handedBack === true;
      const dv = slab.dv as V3 | null | undefined;
      s.dv = dv ? { x: dv.x, y: dv.y, z: dv.z } : null;
      this.world.physics.resetHistory(s.key);
      this.world.zones.setEnabled(s.f, !(s.active || s.handedBack));
    }
    for (const { fighter, slab } of r) this.restoreClear(this.byId.get(fighter)!, slab.notClearOf);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Phase 4a: the slab takes the fighter where it stands, with the launch velocity (§4.5). */
  private launch(w: World, f: Fighter, s: Slab, lift: number | null): void {
    const T = DOWNED_TUNING;
    const sc = f.scale;
    // Feet at f.pos (plus a DS authored jump's height), long axis vertical, the fighter's yaw.
    s.body.setTranslation({ x: f.pos.x, y: f.pos.y + s.halfLen + f.airHeight(), z: f.pos.z }, false);
    s.body.setRotation(yawQuat(f.yaw), false);
    s.body.setLinearDamping(T.linDamp);
    s.body.setAngularDamping(T.angDamp);
    s.col.setFriction(T.friction);
    s.col.setRestitution(T.restitution);
    if (s.col.mass() !== f.mass) {
      s.col.setMass(f.mass);
      s.body.recomputeMassPropertiesFromColliders();
    }
    // Along the blow: (f.vel + f.walkVel) read after CombatSim's step, so every DS knockback rule is in it (KO +1.5,
    // fatal +0.6, sever +1, blade ×0.4, pushScale up to 3); a body with no push (a bleed-out) falls backwards.
    const vx = f.vel.x + f.walkVel.x;
    const vz = f.vel.z + f.walkVel.z;
    const h = Math.hypot(vx, vz);
    const dx = h > 1e-9 ? vx / h : -Math.sin(f.yaw);
    const dz = h > 1e-9 ? vz / h : -Math.cos(f.yaw);
    const speed = Math.max(h, T.minPush);
    // DS's presentation pop (game.ts launch), now the sim's, for a melee blow: liftBase + liftPerLift × the move's lift.
    // DEVIATION (§4.5 adds it to every launch): no pop without a blow (a bleed-out collapse, a hard landing, a world
    // impact whose Δv already carries its own direction), as MAP gap-4 §4 measured the collapse ("no pop").
    const up = lift === null ? 0 : T.liftBase + T.liftPerLift * lift;
    const dv = s.dv ?? { x: 0, y: 0, z: 0 };
    s.dv = null;
    const lin = { x: dx * speed + dv.x, y: up + dv.y, z: dz * speed + dv.z };
    // Toppling with the blow: about up × dir, so the head goes the way the body is pushed.
    const wr = T.toppleRadS / Math.sqrt(sc);
    const ang = { x: dz * wr, y: 0, z: -dx * wr };
    s.body.setEnabled(true);
    s.body.setLinvel(lin, true);
    s.body.setAngvel(ang, true);
    s.active = true;
    s.hold = 0;
    s.handedBack = false;
    f.vel.set(0, 0, 0);
    f.walkVel.set(0, 0, 0);
    w.kcc.setEnabled(f, false);
    w.zones.setEnabled(f, false);
    w.events.push({ type: 'launch', f, vel: lin, angVel: ang });
  }

  /**
   * What the slab isn't clear of (Slab.clearOf; see the top of this file), at the slab's pose now and the other bodies'
   * (each collider placed on its body's pose: a body moved since the last step counts where it is). `fresh` (the slab
   * has just come into the world: the launch, a teleport) lists every dynamic body that reaches its spine (a capsule
   * along its long axis, of the core's half-thickness: inside the body, not at its surface); otherwise (every other phase
   * 4a) the list only loses the bodies that no longer reach it, or are gone, disabled or no longer dynamic. None while the
   * slab is off. Fixed and kinematic bodies, sensors and anything the slab doesn't collide with are never listed.
   */
  private updateClear(s: Slab, fresh: boolean): void {
    if (!s.active) s.clearOf.clear();
    else if (fresh || s.clearOf.size > 0) {
      const T = DOWNED_TUNING;
      const sc = s.f.scale;
      const core = new RAPIER.Capsule((T.halfLength - T.halfThick) * sc, T.halfThick * sc);
      const p = s.body.translation();
      const q = s.body.rotation();
      const rapier = this.world.physics.rapier;
      if (fresh) {
        s.clearOf.clear();
        rapier.colliders.forEach((c) => {
          const b = c.parent();
          if (b && !s.clearOf.has(b.handle) && reachesSpine(s, b, c, core, p, q)) s.clearOf.add(b.handle);
        });
      } else {
        for (const h of [...s.clearOf]) {
          const b = rapier.getRigidBody(h);
          // (Rapier's sets index bodies by slot: a gone body's slot may hold a newer body with another handle.)
          let still = false;
          if (b && b.handle === h) for (let i = 0; i < b.numColliders() && !still; i++) still = reachesSpine(s, b, b.collider(i), core, p, q);
          if (!still) s.clearOf.delete(h);
        }
      }
    }
    this.indexClear(s);
  }

  /**
   * The ghost index and the collider's hook flag follow Slab.clearOf. The flag is set only on an enabled slab and only
   * when it changes: setting a collider's flags puts it back into the broad phase even while its body is disabled
   * (measured: a disabled slab set each tick met the falling log and took 2 m/s off the AC-6 press). A disabled slab
   * keeps its flag; its pairs are solved as usual (it has none while off) and the phase 4a that enables it sets the flag
   * again before the step.
   */
  private indexClear(s: Slab): void {
    if (s.clearOf.size > 0) this.ghosts.set(s.body.handle, s);
    else this.ghosts.delete(s.body.handle);
    if (!s.active) return;
    const want = s.clearOf.size > 0 ? RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS : RAPIER.ActiveHooks.NONE;
    if (s.col.activeHooks() !== want) s.col.setActiveHooks(want);
  }

  /**
   * Slab.clearOf by owner (SlabRecV1.notClearOf): the entities by id and the fighters (another's slab, a tripped ruler)
   * by id, each increasing. A body gone since the last phase 4a is left out (that phase 4a drops it).
   */
  private clearOfRecord(s: Slab): { entities: number[]; fighters: number[] } {
    const entities: number[] = [];
    const fighters: number[] = [];
    const physics = this.world.physics;
    for (const h of s.clearOf) {
      const b = physics.rapier.getRigidBody(h);
      if (!b || b.handle !== h || b.numColliders() === 0) continue;
      const o = physics.ownerOf(b.collider(0).handle);
      if (o?.kind === 'entity') entities.push(o.id);
      else if (o?.kind === 'fighter') fighters.push(o.id);
    }
    const up = (a: number, b: number): number => a - b;
    return { entities: entities.sort(up), fighters: fighters.sort(up) };
  }

  /** Slab.clearOf from a record (restoreRecord): each id to the body it names in the loaded world. */
  private restoreClear(s: Slab, r: { entities: number[]; fighters: number[] }): void {
    s.clearOf.clear();
    const n = r.entities.length + r.fighters.length;
    if (n > 0 && !s.active) throw new Error(`DownedBodies.restoreRecord: fighter ${s.f.id}'s slab is off but lists bodies it isn't clear of`);
    const physics = this.world.physics;
    for (const id of r.entities) {
      const b = this.world.entities.get(id)?.body;
      if (!b) throw new Error(`DownedBodies.restoreRecord: fighter ${s.f.id}'s slab isn't clear of entity ${id}, which has no body`);
      s.clearOf.add(b.handle);
    }
    let rulers: Map<number, number> | null = null;
    for (const id of r.fighters) {
      let h = id === s.f.id ? undefined : this.byId.get(id)?.body.handle;
      if (h === undefined && id !== s.f.id) {
        // A ruler's body (it has no slab): found by its colliders' owner.
        if (!rulers) {
          const found = new Map<number, number>();
          physics.rapier.colliders.forEach((c) => {
            const o = physics.ownerOf(c.handle);
            const b = c.parent();
            if (b && o?.kind === 'fighter' && o.part === 'ruler') found.set(o.id, b.handle);
          });
          rulers = found;
        }
        h = rulers.get(id);
      }
      if (h === undefined) throw new Error(`DownedBodies.restoreRecord: fighter ${s.f.id}'s slab isn't clear of fighter ${id}, who has no other slab or ruler body`);
      s.clearOf.add(h);
    }
    this.indexClear(s);
  }

  /** The pair filter: `slab` is an active slab's body and `other` a body it isn't clear of. */
  private ghostPair(slab: number, other: number): boolean {
    return this.ghosts.get(slab)?.clearOf.has(other) ?? false;
  }

  /** Keep the fighter down one more tick (CombatSim gets it up when stateFrame reaches stunFrames). */
  private hold(f: Fighter, s: Slab): void {
    // DEVIATION (§4.5 says stunFrames = stateFrame + 1): phase 13a runs after this tick's advance(), and the next
    // advance() gets the fighter up as soon as stateFrame + 1 ≥ stunFrames, so the hold needs stateFrame + 2.
    f.stunFrames = f.stateFrame + 2;
    s.hold++;
  }

  /** Phase 13a: the slab leaves the world, the controller comes back at `feet`; the zones follow in the next 4a. */
  private handBack(w: World, f: Fighter, s: Slab, feet: V3): void {
    s.body.setEnabled(false);
    s.active = false;
    s.hold = 0;
    s.handedBack = true;
    w.kcc.setEnabled(f, true);
    w.kcc.teleport(f, feet.x, feet.y, feet.z);
    f.pos.set(feet.x, feet.y, feet.z);
  }

  /** Phase 4a: standing again with the slab active (a respawn, a revive): controller and zones back where f.pos is. */
  private standUp(w: World, f: Fighter, s: Slab): void {
    s.body.setEnabled(false);
    s.active = false;
    s.hold = 0;
    s.handedBack = false;
    // The controller normally came back in this tick's phase 3 already (CharacterControllers.resolve of a standing
    // fighter), taking the respawn's teleport; if not, it comes back where the fighter is.
    if (!w.kcc.isEnabled(f)) {
      w.kcc.setEnabled(f, true);
      if (!w.kcc.teleportPending(f)) w.kcc.teleport(f, f.pos.x, f.pos.y, f.pos.z);
    }
    w.zones.setEnabled(f, true);
  }

  /** The slab's hip: boneBands[1] (the hip joint) along the axis from the foot end. */
  private hipOf(s: Slab): V3 {
    const p = s.body.translation();
    const q = s.body.rotation();
    const along = DOWNED_TUNING.boneBands[1] * s.f.scale - s.halfLen;
    const d = rotate(q, { x: 0, y: along, z: 0 });
    return { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z };
  }

  /**
   * Where the standing controller fits (MAP gap-4 §6): the standing capsule cast down from standCastUp × scale above
   * the hip, at the hip and then on rings of standRings × standDirs directions (fixed order), accepting the first hit
   * whose surface is no steeper than maxStandSlopeDeg and where the capsule, lifted by the controller's offset, overlaps
   * nothing (the slab, sensors and other fighters left out: the KCC's own filter). Returns the feet point, or null.
   */
  private standSpot(f: Fighter, s: Slab, hip: V3): V3 | null {
    const T = DOWNED_TUNING;
    const C = CHARACTER_TUNING;
    const sc = f.scale;
    const r = C.capsuleR * sc;
    const hh = C.capsuleHalfH * sc;
    const off = C.kccOffset * sc;
    const rapier = this.world.physics.rapier;
    const shape = new RAPIER.Capsule(hh, r);
    const minUp = Math.cos((T.maxStandSlopeDeg * Math.PI) / 180);
    const tryAt = (dx: number, dz: number): V3 | null => {
      const start = { x: hip.x + dx, y: hip.y + T.standCastUp * sc, z: hip.z + dz };
      const hit = rapier.castShape(start, IDENTITY, DOWN, shape, 0, T.standCastLength * sc, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccQueryGroups(), undefined, s.body);
      if (!hit || hit.normal1.y < minUp) return null;
      const centre = { x: start.x, y: start.y - hit.time_of_impact + off, z: start.z };
      if (rapier.intersectionWithShape(centre, IDENTITY, shape, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccQueryGroups(), undefined, s.body)) return null;
      return { x: centre.x, y: centre.y - hh - r - off, z: centre.z };
    };
    const at = tryAt(0, 0);
    if (at) return at;
    const dirs = Math.max(1, Math.round(T.standDirs));
    for (const ring of T.standRings) {
      for (let k = 0; k < dirs; k++) {
        const a = (2 * Math.PI * k) / dirs;
        const spot = tryAt(ring * Math.cos(a), ring * Math.sin(a));
        if (spot) return spot;
      }
    }
    return null;
  }
}

/**
 * Whether collider `c` of body `b` keeps the slab `s` from being clear of `b` (Slab.clearOf): `b` is another dynamic,
 * enabled body, `c` an enabled solid collider in a group the slab collides with (COLLIDES_DOWNED_DYNAMIC), and `c`, placed
 * on `b`'s pose now, overlaps `core` (the slab's spine) at the slab's pose `p`, `q`.
 */
function reachesSpine(s: Slab, b: RAPIER.RigidBody, c: RAPIER.Collider, core: RAPIER.Shape, p: RAPIER.Vector, q: RAPIER.Rotation): boolean {
  if (b.handle === s.body.handle || !b.isDynamic() || !b.isEnabled() || c.isSensor() || !c.isEnabled()) return false;
  if (!((c.collisionGroups() >>> 16) & COLLIDES_DOWNED_DYNAMIC)) return false;
  const bp = b.translation();
  const bq = b.rotation();
  const lp = c.translationWrtParent() ?? { x: 0, y: 0, z: 0 };
  const lq = c.rotationWrtParent() ?? IDENTITY;
  const d = rotate(bq, lp);
  return core.intersectsShape(p, q, c.shape, { x: bp.x + d.x, y: bp.y + d.y, z: bp.z + d.z }, mulQuat(bq, lq));
}

/** The rotation of `yaw` about +Y (the fighter yaw convention: 0 faces +z). */
function yawQuat(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** v rotated by unit quaternion q. */
function rotate(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** a·b (b applied first). */
function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** The half-height along world y of a box of half extents (hx, hy, hz) turned by q. */
function verticalExtent(q: Quat, hx: number, hy: number, hz: number): number {
  return Math.abs(rotate(q, { x: hx, y: 0, z: 0 }).y) + Math.abs(rotate(q, { x: 0, y: hy, z: 0 }).y) + Math.abs(rotate(q, { x: 0, y: 0, z: hz }).y);
}

/** v rotated by the inverse of unit quaternion q. */
function rotateInv(q: Quat, v: V3): V3 {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}
