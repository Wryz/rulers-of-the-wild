// Hit zones of standing players and apes (docs/M1-DESIGN.md §1.5.8, §4.8, §4.3): a kinematic body and 12 bone sensor
// colliders per fighter, posed from the rig in phase 4b, with the pose history the damage rule reads and its reset.
//
// - One kinematicPositionBased body at the pelvis joint carries 12 sensor colliders in BONES order, the bone shapes of
//   DungeonStyle's ragdoll × scale (CHARACTER_TUNING.zoneShapes), groups ZONE, ActiveCollisionTypes.ALL (sensor vs
//   fixed and sensor vs sensor need it, MAP rapier §4.3), COLLISION_EVENTS; each registered as the owner
//   { fighter, part 'zone', bone }. A severed bone's collider is disabled.
// - Phase 4b: setNextKinematicTranslation/Rotation(pelvis) and each collider setTranslationWrtParent /
//   setRotationWrtParent from the rig (§3). Rapier's narrow phase tests start-of-step poses, so a step sees the body
//   where the previous tick set it; but a collider's offset from its body, set before a step, is already tested by
//   that step (measured, Rapier 0.21), so the narrow phase tests the previous tick's pelvis with this tick's limb
//   offsets. The pre-step store reads whole poses as the last step left them (the previous tick's), which is what
//   carryV is built from.
// - The pose history (carryV = the previous tick's delta, prevP/prevQ for the normal cast) is the physics world's
//   pre-step store, keyed by owner (world/physics.ts storePreStep): a kinematic collider's stored pose is the one the
//   previous step left. resetHistory asks the physics world to store the current pose as the previous one too (carryV
//   0), puts the body at the new pose at once at the next phase 4b (setTranslation: no kinematic sweep across the
//   jump), and opens the fighter's contact grace (§4.3, RF-1).
// - Disabled while the fighter is down (the slab takes over; otherwise a falling log hits a standing ghost, MAP gap-4
//   §6); enabled again (with resetHistory) in phase 4a after the slab is handed back.
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { type BoneName, BONES, type Rig, SKELETON } from '../body/skeleton';
import type { Fighter } from '../sim/fighter';
import { DAMAGE_TUNING } from '../sim/rules';
import { CHARACTER_TUNING } from './characters';
import { collisionGroups, solverGroups } from './groups';
import { ownerKey } from './physics';
import type { Pose3, V3 } from './types';
import type { World } from './world';

/** A bone's zone shape in the bone's own frame, × scale (CHARACTER_TUNING.zoneShapes; DS ragdoll.ts). */
export type BoneZoneShape =
  | { kind: 'ball'; r: number; off: V3 }
  | { kind: 'box'; hx: number; hy: number; hz: number; off: V3 }
  | { kind: 'capsule'; halfHeight: number; r: number; off: V3 };

/** The zone shape of `bone` for a body of `scale` (shared with the ruler's bones, §4.7: "bone shapes from ragdoll.ts"). */
export function boneZoneShape(bone: BoneName, scale: number): BoneZoneShape {
  const Z = CHARACTER_TUNING.zoneShapes;
  const box = (b: readonly number[]): BoneZoneShape => ({ kind: 'box', hx: b[0] * scale, hy: b[1] * scale, hz: b[2] * scale, off: { x: 0, y: b[3] * scale, z: 0 } });
  switch (bone) {
    case 'head':
      return { kind: 'ball', r: Z.headR * scale, off: { x: 0, y: Z.headUp * scale, z: 0 } };
    case 'pelvis':
      return box(Z.pelvis);
    case 'abdomen':
      return box(Z.abdomen);
    case 'chest':
      return box(Z.chest);
    default: {
      const d = SKELETON[bone];
      const half = Math.max(Z.minLimbHalf, d.length / 2 - d.radius * Z.limbInset) * scale;
      return { kind: 'capsule', halfHeight: half, r: d.radius * scale, off: { x: 0, y: (d.dir * d.length * scale) / 2, z: 0 } };
    }
  }
}

/** A Rapier collider descriptor for a bone zone shape (no pose, no groups). */
export function boneZoneDesc(s: BoneZoneShape): RAPIER.ColliderDesc {
  switch (s.kind) {
    case 'ball':
      return RAPIER.ColliderDesc.ball(s.r);
    case 'box':
      return RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(s.halfHeight, s.r);
  }
}

interface ZoneSet {
  readonly f: Fighter;
  readonly body: RAPIER.RigidBody;
  /** BONES order. */
  readonly cols: RAPIER.Collider[];
  /** Each zone's offset in its bone's frame (m), BONES order. */
  readonly offs: V3[];
  readonly keys: string[];
  enabled: boolean;
  /** The next phase 4b puts the body at its pose at once (after an enable or a history reset). */
  jump: boolean;
}

const _bq = new Quaternion();
const _bqi = new Quaternion();
const _q = new Quaternion();
const _p = new Vector3();
const _o = new Vector3();

export class ZoneBodies {
  readonly world: World;
  private readonly byId = new Map<number, ZoneSet>();

  constructor(world: World) {
    this.world = world;
  }

  /** The body at the rig's pelvis and the 12 zones where the rig has its bones (CombatSim.add posed the rig). */
  create(f: Fighter): void {
    if (this.byId.has(f.id)) throw new Error(`ZoneBodies.create: fighter ${f.id} already has zones`);
    const physics = this.world.physics;
    const pelvis = f.rig.pelvis;
    const body = physics.rapier.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pelvis.pos.x, pelvis.pos.y, pelvis.pos.z)
        .setRotation({ x: pelvis.rot.x, y: pelvis.rot.y, z: pelvis.rot.z, w: pelvis.rot.w }),
    );
    const cols: RAPIER.Collider[] = [];
    const offs: V3[] = [];
    const keys: string[] = [];
    for (const b of BONES) {
      const shape = boneZoneShape(b, f.scale);
      const local = localPose(f.rig, b, shape.off);
      const desc = boneZoneDesc(shape)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ZONE'))
        .setSolverGroups(solverGroups('ZONE'))
        .setTranslation(local.p.x, local.p.y, local.p.z)
        .setRotation(local.q);
      const col = physics.rapier.createCollider(desc, body);
      const owner = { kind: 'fighter' as const, id: f.id, part: 'zone' as const, bone: b };
      physics.register(col, owner);
      if (f.isSevered(b)) col.setEnabled(false);
      cols.push(col);
      offs.push(shape.off);
      keys.push(ownerKey(owner));
    }
    this.byId.set(f.id, { f, body, cols, offs, keys, enabled: true, jump: false });
  }

  remove(f: Fighter): void {
    const z = this.byId.get(f.id);
    if (!z) return;
    this.byId.delete(f.id);
    const physics = this.world.physics;
    for (const c of z.cols) physics.unregister(c);
    physics.rapier.removeRigidBody(z.body);
  }

  /** Off while the fighter is down; on again with resetHistory (§4.3: every setEnabled(true) resets, RF-1). */
  setEnabled(f: Fighter, on: boolean): void {
    const z = this.byId.get(f.id);
    if (!z || z.enabled === on) return;
    z.enabled = on;
    z.body.setEnabled(on);
    if (on) this.resetHistory(f);
  }

  /** Whether the fighter's zones are in the world. */
  enabled(f: Fighter): boolean {
    return this.byId.get(f.id)?.enabled ?? false;
  }

  /** Phase 4b: standing and rising players/apes posed from the rig; the pose history is the physics world's store. */
  pose(w: World): void {
    for (const f of w.combat.fighters) {
      const z = this.byId.get(f.id);
      if (!z || !z.enabled) continue;
      const pelvis = f.rig.pelvis;
      const p = { x: pelvis.pos.x, y: pelvis.pos.y, z: pelvis.pos.z };
      const q = { x: pelvis.rot.x, y: pelvis.rot.y, z: pelvis.rot.z, w: pelvis.rot.w };
      if (z.jump) {
        z.body.setTranslation(p, true);
        z.body.setRotation(q, true);
        z.jump = false;
      } else {
        z.body.setNextKinematicTranslation(p);
        z.body.setNextKinematicRotation(q);
      }
      for (let i = 0; i < BONES.length; i++) {
        const b = BONES[i];
        const c = z.cols[i];
        const on = !f.isSevered(b);
        if (c.isEnabled() !== on) c.setEnabled(on);
        if (!on) continue;
        const local = localPose(f.rig, b, z.offs[i]);
        c.setTranslationWrtParent(local.p);
        c.setRotationWrtParent(local.q);
      }
    }
  }

  /**
   * N−1 and N−2 := the current pose (carryV 0) + zone grace (§4.3, RF-1): every zone key's history is reset in the
   * physics world, the next phase 4b puts the body at its new pose at once, and the fighter's contacts get a grace of
   * DAMAGE_TUNING.zoneGraceTicks from the next tick (a caller that knows the pose tick better, World.teleport, opens its
   * own grace as well).
   */
  resetHistory(f: Fighter): void {
    const z = this.byId.get(f.id);
    if (!z) return;
    for (const k of z.keys) this.world.physics.resetHistory(k);
    z.jump = true;
    this.world.contacts.grace(f.id, this.world.tick + 1 + DAMAGE_TUNING.zoneGraceTicks);
  }

  /**
   * The zone pose history of a fighter, for the save (§8.3 `bodies.zonesHistory`): per bone in BONES order, the pose
   * the last phase 5 stored (p xyz, q xyzw) and the one stored before it (prevP, prevQ): 14 numbers a bone. A zone not
   * stored then (disabled, or before the first step) gives its collider's current pose twice.
   */
  historyRecord(f: Fighter): number[] {
    const z = this.byId.get(f.id);
    if (!z) return [];
    const out: number[] = [];
    for (let i = 0; i < z.cols.length; i++) {
      const s = this.world.physics.pre(z.keys[i]);
      if (s) {
        out.push(s.p.x, s.p.y, s.p.z, s.q.x, s.q.y, s.q.z, s.q.w, s.prevP.x, s.prevP.y, s.prevP.z, s.prevQ.x, s.prevQ.y, s.prevQ.z, s.prevQ.w);
      } else {
        const t = z.cols[i].translation();
        const r = z.cols[i].rotation();
        out.push(t.x, t.y, t.z, r.x, r.y, r.z, r.w, t.x, t.y, t.z, r.x, r.y, r.z, r.w);
      }
    }
    return out;
  }

  /** The world pose a zone collider has in Rapier now (f32), or null. */
  zonePose(f: Fighter, bone: BoneName): Pose3 | null {
    const z = this.byId.get(f.id);
    if (!z) return null;
    const c = z.cols[BONES.indexOf(bone)];
    const t = c.translation();
    const r = c.rotation();
    return { p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }
}

/**
 * A zone's pose relative to the pelvis body: the bone's world pose from the rig, moved by the shape's offset in the
 * bone frame, expressed in the pelvis frame (qp⁻¹·(p_b + q_b·off − p_p), qp⁻¹·q_b).
 */
function localPose(rig: Rig, bone: BoneName, off: V3): { p: V3; q: { x: number; y: number; z: number; w: number } } {
  const pel = rig.pelvis;
  const x = rig[bone];
  _bq.copy(x.rot);
  _o.set(off.x, off.y, off.z).applyQuaternion(_bq);
  _bqi.copy(pel.rot).invert();
  _p.copy(x.pos).add(_o).sub(pel.pos).applyQuaternion(_bqi);
  _q.copy(_bqi).multiply(_bq);
  return { p: { x: _p.x, y: _p.y, z: _p.z }, q: { x: _q.x, y: _q.y, z: _q.z, w: _q.w } };
}
