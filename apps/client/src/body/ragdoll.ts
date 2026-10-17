// The powered ragdoll (DungeonStyle, presentation only: rule 6). One rigid body per bone in the presentation Rapier
// world (game/presentationWorld.ts), linked with ball joints and driven toward the fighter's animated pose by
// velocity-level "muscles". It never writes the fighter: the sim decides where a body is, and the ragdoll follows.
//
// M1 changes (docs/M1-DESIGN.md §10.5, P33):
// - Down-follow: while the fighter is knocked down or KO'd, the root gets a weak drive (RAGDOLL_TUNING.downRootGain,
//   DS: 0) toward the sim's slab (world.downed), so the visible body lies where the sim's body lies.
// - The throw comes from the sim's `launch` event (launch(vel, angVel, centre): the slab's velocity at each bone and
//   its spin), not from a presentation-computed throw.
// - Collision slots are owned by the presentation world (RagdollSlots, D-42), not module state, and recycled on
//   dispose.
// - RAGDOLL_TUNING is a registered live table (folder "Client › ragdoll").
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import {
  type BoneName,
  BONE_MASS,
  BONES,
  defineTuning,
  DT,
  type Fighter,
  type HurtZone,
  limbBones,
  type MoveDef,
  type Rig,
  SKELETON,
  smoothstep,
  type V3,
  type Weight,
} from '@wild/sim';

type R = typeof RAPIER_NS;

export const GROUP_ENV = 0x0001;
export const GROUP_BODY = 0x0002;
export const groups = (membership: number, filter: number) => (membership << 16) | filter;

/** Each ragdoll gets its own collision bit (bits 2..15) so bodies can touch each other. */
export const SLOT_BITS = 0xfffc;
/** How many ragdolls one presentation world can hold (one bit each). */
export const SLOT_COUNT = 14;

/**
 * The collision bits of one presentation world's ragdolls (D-42: owned by that world, never module state, so two
 * worlds — a rebuild, a test — never share or leak them). A bit is claimed when a ragdoll is built and released when
 * it is disposed, so a later ragdoll gets it again.
 */
export class RagdollSlots {
  private used = 0;

  /** The lowest free bit, now in use; 0 when every slot is taken. */
  claim(): number {
    let bit = 0x0004;
    while (bit & this.used && bit < 0x10000) bit <<= 1;
    if (bit >= 0x10000) return 0;
    this.used |= bit;
    return bit;
  }

  release(slot: number): void {
    this.used &= ~slot;
  }

  /** The bits in use. */
  get mask(): number {
    return this.used;
  }

  /** How many slots are in use. */
  get count(): number {
    let n = 0;
    for (let b = this.used & SLOT_BITS; b; b &= b - 1) n++;
    return n;
  }
}

/** Live-tunable ragdoll parameters (the dev panel's "Client › ragdoll" folder). */
export const RAGDOLL_TUNING = defineTuning(
  'RAGDOLL_TUNING',
  'Client › ragdoll',
  {
    /** Fraction of pose error corrected per step by joint "muscles" at full strength. */
    muscleGain: 0.55,
    /** Same for the pelvis anchoring the body to the gameplay position. */
    rootGain: 0.45,
    /** Global multiplier on hit impulses. */
    impulseMul: 1,
    /** Global multiplier on how much a hit relaxes muscles. */
    dipMul: 1,
    /** Muscle strength while knocked down. */
    limpStrength: 0.12,
    /** Muscle gain while throwing a strike: crisp, on-time technique. */
    strikeGain: 0.92,
    /** The root's pull toward the sim's slab while down (DS: 0, a free body that drifted from the sim). */
    downRootGain: 0.15,
  },
  {
    muscleGain: { unit: 'DS units (fraction of pose error per step)', source: 'DS (ragdoll.ts:20)', min: 0.05, max: 1, step: 0.01, label: 'muscle gain' },
    rootGain: { unit: 'DS units (fraction of pose error per step)', source: 'DS (ragdoll.ts:20)', min: 0.05, max: 1, step: 0.01, label: 'balance gain' },
    impulseMul: { unit: '×', source: 'DS (ragdoll.ts:20)', min: 0, max: 4, step: 0.05, label: 'impulse ×' },
    dipMul: { unit: '×', source: 'DS (ragdoll.ts:20)', min: 0, max: 1.5, step: 0.05, label: 'hit limpness' },
    limpStrength: { unit: 'DS units (muscle strength)', source: 'DS (ragdoll.ts:20)', min: 0, max: 0.6, step: 0.01, label: 'downed muscle' },
    strikeGain: { unit: 'DS units (fraction of pose error per step)', source: 'DS (ragdoll.ts:20)', min: 0.05, max: 1, step: 0.01, label: 'strike gain' },
    downRootGain: { unit: 'fraction per step', source: 'NEW: down-follow toward the sim slab (§10.5)', min: 0, max: 1, step: 0.01, label: 'down follow' },
  },
);

/** What a blow needs to say to a body: the move's weight class, its impulse (N·s) and lift (DS MoveDef fields). */
export type BlowLike = Pick<MoveDef, 'weight' | 'impulse' | 'lift'>;

/** Where the root goes while the fighter is down: the sim slab's hip, the pelvis turned with the slab, its velocity. */
export interface DownTarget {
  at: Vector3;
  rot: Quaternion;
  vel: Vector3;
}

/** A rigid move of a whole body: p' = to + rot·(p − from), q' = rot·q (laying a standing rig on its slab). */
export interface BodyMove {
  from: Vector3;
  to: Vector3;
  rot: Quaternion;
}

interface Dip {
  depth: number;
  hold: number;
  recover: number;
  t: number;
}

const ZONE_DIPS: Record<HurtZone, Partial<Record<BoneName | 'root', number>>> = {
  head: { head: 0.95, chest: 0.6, abdomen: 0.3, upperArmL: 0.7, foreArmL: 0.7, upperArmR: 0.7, foreArmR: 0.7, root: 0.45 },
  chest: { chest: 0.85, abdomen: 0.6, head: 0.55, upperArmL: 0.6, foreArmL: 0.6, upperArmR: 0.6, foreArmR: 0.6, root: 0.5 },
  abdomen: { abdomen: 0.9, chest: 0.65, head: 0.45, upperArmL: 0.5, foreArmL: 0.5, upperArmR: 0.5, foreArmR: 0.5, root: 0.6 },
  legs: { thighL: 0.9, shinL: 0.9, thighR: 0.9, shinR: 0.9, abdomen: 0.3, root: 0.6 },
};

const ZONE_BODY: Record<HurtZone, BoneName> = { head: 'head', chest: 'chest', abdomen: 'abdomen', legs: 'shinL' };
const WEIGHT_SCALE: Record<Weight, { depth: number; hold: number; recover: number }> = {
  light: { depth: 0.45, hold: 2, recover: 10 },
  medium: { depth: 0.85, hold: 5, recover: 20 },
  heavy: { depth: 1, hold: 8, recover: 28 },
};

const MAX_LIN = 25;
const MAX_ANG = 45;
const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });

const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _w = new Vector3();
const _vd = new Vector3();
const _com = new Vector3();
const _pcom = new Vector3();
const _jp = new Vector3();
const _mean = new Vector3();
const _c = new Vector3();
const _bc = new Vector3();

function toV(v: { x: number; y: number; z: number }, out = new Vector3()) {
  return out.set(v.x, v.y, v.z);
}
function toQ(q: { x: number; y: number; z: number; w: number }, out = new Quaternion()) {
  return out.set(q.x, q.y, q.z, q.w);
}

/** Angular velocity that rotates `from` to `to` by `gain` of the way in one step. */
function angularCorrection(from: Quaternion, to: Quaternion, gain: number, out: Vector3) {
  _q.copy(to).multiply(_q2.copy(from).invert());
  if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
  const s = Math.sqrt(1 - Math.min(1, _q.w * _q.w));
  const angle = 2 * Math.acos(Math.min(1, _q.w));
  if (s < 1e-5 || angle < 1e-5) return out.set(0, 0, 0);
  return out.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar((angle * gain) / DT);
}

function clampLen(v: Vector3, max: number) {
  const l = v.length();
  if (l > max) v.multiplyScalar(max / l);
  return v;
}

/** `move` applied to a point (into `out`). */
export function movePoint(move: BodyMove, p: Vector3, out: Vector3): Vector3 {
  return out.copy(p).sub(move.from).applyQuaternion(move.rot).add(move.to);
}

/**
 * Powered ragdoll: one rigid body per bone, linked with ball joints, driven toward the
 * animated target pose by velocity-level "muscles". Hits temporarily relax the muscles
 * around the impact and add an impulse, so reactions are physical but always recover.
 */
export class Ragdoll {
  readonly bodies = {} as Record<BoneName, RAPIER_NS.RigidBody>;
  readonly prev = {} as Record<BoneName, { p: Vector3; q: Quaternion }>;
  readonly cur = {} as Record<BoneName, { p: Vector3; q: Quaternion }>;
  private readonly joints: RAPIER_NS.ImpulseJoint[] = [];
  private readonly jointOf = new Map<BoneName, RAPIER_NS.ImpulseJoint>();
  /** Bones cut loose from the body (no longer driven). */
  readonly loose = new Set<BoneName>();
  private readonly dips = new Map<BoneName | 'root', Dip>();
  private readonly prevRootTarget = new Vector3();
  private rootStrength = 1;
  private limpTimer = 0;
  /** This ragdoll's own collision bit (from its world's RagdollSlots). */
  readonly slot: number;
  private contactMask = -1;
  private disposed = false;

  /**
   * Built on `fighter.rig` with a collision bit from `slots` (released by dispose). Limbs the sim has already cut off
   * (`fighter.severed`) start loose: no joint, dead weight.
   */
  constructor(
    RAPIER: R,
    private readonly world: RAPIER_NS.World,
    fighter: Fighter,
    private readonly slots: RagdollSlots,
  ) {
    const rig = fighter.rig;
    const sc = fighter.scale;
    this.slot = slots.claim();
    for (const name of BONES) {
      const def = SKELETON[name];
      const x = rig[name];
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x.pos.x, x.pos.y, x.pos.z)
        .setRotation({ x: x.rot.x, y: x.rot.y, z: x.rot.z, w: x.rot.w })
        .setCanSleep(false)
        .setLinearDamping(0.05)
        .setAngularDamping(0.6);
      const body = world.createRigidBody(desc);
      let cd: RAPIER_NS.ColliderDesc;
      if (name === 'head') {
        cd = RAPIER.ColliderDesc.ball(0.11 * sc).setTranslation(0, 0.15 * sc, 0);
      } else if (name === 'pelvis') {
        cd = RAPIER.ColliderDesc.cuboid(0.14 * sc, 0.08 * sc, 0.09 * sc).setTranslation(0, 0.03 * sc, 0);
      } else if (name === 'abdomen') {
        cd = RAPIER.ColliderDesc.cuboid(0.13 * sc, 0.1 * sc, 0.09 * sc).setTranslation(0, 0.1 * sc, 0);
      } else if (name === 'chest') {
        cd = RAPIER.ColliderDesc.cuboid(0.17 * sc, 0.13 * sc, 0.1 * sc).setTranslation(0, 0.13 * sc, 0);
      } else {
        const half = Math.max(0.01, def.length / 2 - def.radius * 0.5) * sc;
        cd = RAPIER.ColliderDesc.capsule(half, def.radius * sc).setTranslation(0, (def.dir * def.length * sc) / 2, 0);
      }
      cd.setMass(BONE_MASS[name] * Math.pow(sc, 2.5)).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups(GROUP_BODY | this.slot, GROUP_ENV));
      world.createCollider(cd, body);
      this.bodies[name] = body;
      this.prev[name] = { p: x.pos.clone(), q: x.rot.clone() };
      this.cur[name] = { p: x.pos.clone(), q: x.rot.clone() };
    }
    // What the sim has already cut off hangs on nothing (a body rebuilt by level of detail, or after a respawn that
    // kept a wound: §4.14 clears them, so normally none).
    for (const cut of fighter.severed) for (const b of limbBones(cut)) this.loose.add(b);
    for (const name of BONES) {
      const def = SKELETON[name];
      if (!def.parent || this.loose.has(name)) continue;
      const jd = RAPIER.JointData.spherical(
        { x: def.offset[0] * sc, y: def.offset[1] * sc, z: def.offset[2] * sc },
        { x: 0, y: 0, z: 0 },
      );
      const j = world.createImpulseJoint(jd, this.bodies[def.parent], this.bodies[name], true);
      j.setContactsEnabled(false);
      this.joints.push(j);
      this.jointOf.set(name, j);
    }
    this.prevRootTarget.copy(rig.pelvis.pos);
  }

  /**
   * Which other bodies this one is solid against. Two fighters on their feet are kept
   * apart by the fight sim (powered bodies pressing on each other would only shake);
   * a body that's down collides with everyone, so a fighter falls against and onto the
   * other, not through them.
   */
  setContacts(down: boolean, downSlots: number) {
    const others = (down ? SLOT_BITS : downSlots) & ~this.slot;
    if (others === this.contactMask) return;
    this.contactMask = others;
    const g = groups(GROUP_BODY | this.slot, GROUP_ENV | others);
    for (const name of BONES) {
      const b = this.bodies[name];
      for (let i = 0; i < b.numColliders(); i++) b.collider(i).setCollisionGroups(g);
    }
  }

  /** Removes the bodies and joints and gives the collision bit back to the world's slots (once). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.slots.release(this.slot);
    for (const j of this.joints) this.world.removeImpulseJoint(j, false);
    for (const name of BONES) this.world.removeRigidBody(this.bodies[name]);
  }

  /**
   * Cuts the body apart at `bone`: the joint to its parent goes, and that part (with
   * everything below it) is flung free as dead weight.
   */
  sever(bone: BoneName, bones: BoneName[], impulse: Vector3) {
    const j = this.jointOf.get(bone);
    if (j) {
      this.world.removeImpulseJoint(j, true);
      this.joints.splice(this.joints.indexOf(j), 1);
      this.jointOf.delete(bone);
    }
    for (const b of bones) {
      this.loose.add(b);
      const body = this.bodies[b];
      const m = body.mass();
      body.applyImpulse({ x: impulse.x * m, y: impulse.y * m, z: impulse.z * m }, true);
      // A tumble that depends on the cut, not on Math.random (keeps replays identical).
      body.applyTorqueImpulse({ x: (impulse.z - impulse.y) * m * 0.02, y: (impulse.x - impulse.z) * m * 0.02, z: (impulse.y - impulse.x) * m * 0.02 }, true);
    }
  }

  /** Current pelvis position (physics). */
  pelvisPos(out = new Vector3()) {
    return toV(this.bodies.pelvis.translation(), out);
  }

  /** The mass-weighted centre of the attached bones (world). */
  centreOfMass(out = new Vector3()): Vector3 {
    out.set(0, 0, 0);
    let m = 0;
    for (const name of BONES) {
      if (this.loose.has(name)) continue;
      const b = this.bodies[name];
      const bm = b.mass();
      out.addScaledVector(toV(b.worldCom(), _bc), bm);
      m += bm;
    }
    return m > 0 ? out.divideScalar(m) : this.pelvisPos(out);
  }

  private dipValue(key: BoneName | 'root'): number {
    const d = this.dips.get(key);
    if (!d) return 0;
    if (d.t < d.hold) return d.depth;
    const u = (d.t - d.hold) / d.recover;
    if (u >= 1) return 0;
    return d.depth * (1 - smoothstep(u));
  }

  private tickDips() {
    for (const [k, d] of this.dips) {
      d.t++;
      if (d.t > d.hold + d.recover) this.dips.delete(k);
    }
  }

  /** A blow (DS: a melee hit's move; M1: a world impact's presentation hints, the same three fields). */
  applyHit(zone: HurtZone, point: Vector3 | V3, dir: Vector3 | V3, move: BlowLike, scale = 1) {
    const w = WEIGHT_SCALE[move.weight];
    const dips = ZONE_DIPS[zone];
    for (const [k, depth] of Object.entries(dips) as [BoneName | 'root', number][]) {
      const dd = Math.min(1, depth * w.depth * RAGDOLL_TUNING.dipMul * scale);
      const existing = this.dips.get(k);
      if (!existing || this.dipValue(k) < dd) this.dips.set(k, { depth: dd, hold: w.hold, recover: w.recover, t: 0 });
    }
    const lift = move.lift ?? 0.05;
    _v.set(dir.x, dir.y, dir.z).multiplyScalar(1 - lift).addScaledVector(_v2.set(0, 1, 0), lift).normalize();
    const mag = move.impulse * RAGDOLL_TUNING.impulseMul * scale;
    let bone = ZONE_BODY[zone];
    if (zone === 'legs') {
      const l = this.bodies.shinL.translation();
      const r = this.bodies.shinR.translation();
      const dl = (l.x - point.x) ** 2 + (l.z - point.z) ** 2;
      const dr = (r.x - point.x) ** 2 + (r.z - point.z) ** 2;
      bone = dl < dr ? 'shinL' : 'shinR';
    }
    if (!this.loose.has(bone)) {
      this.bodies[bone].applyImpulseAtPoint(
        { x: _v.x * mag * 0.7, y: _v.y * mag * 0.7, z: _v.z * mag * 0.7 },
        { x: point.x, y: point.y, z: point.z },
        true,
      );
    }
    // Share of the shove goes through the whole body.
    this.bodies.pelvis.applyImpulse({ x: _v.x * mag * 0.3, y: _v.y * mag * 0.3, z: _v.z * mag * 0.3 }, true);
  }

  /** Small reaction for a blocked strike: arms absorb it. */
  applyBlock(dir: Vector3, move: Pick<MoveDef, 'impulse'>) {
    for (const k of ['upperArmL', 'foreArmL', 'upperArmR', 'foreArmR', 'chest'] as const) {
      this.dips.set(k, { depth: 0.6 * RAGDOLL_TUNING.dipMul, hold: 2, recover: 10, t: 0 });
    }
    this.dips.set('root', { depth: 0.25, hold: 2, recover: 10, t: 0 });
    const mag = move.impulse * 0.35 * RAGDOLL_TUNING.impulseMul;
    for (const k of ['foreArmL', 'foreArmR'] as const) {
      if (this.loose.has(k)) continue;
      this.bodies[k].applyImpulse({ x: dir.x * mag * 0.3, y: 0, z: dir.z * mag * 0.3 }, true);
    }
    this.bodies.chest.applyImpulse({ x: dir.x * mag * 0.4, y: 0, z: dir.z * mag * 0.4 }, true);
  }

  /**
   * The sim's launch (§4.5: the `launch` event; the slab's linear velocity `vel` and spin `angVel` about `centre`,
   * by default the body's centre of mass). The body's bulk motion becomes the slab's — its velocity at each bone,
   * plus its spin — while what a blow already set moving inside the body keeps moving (the struck limb's jerk). Loose
   * limbs fly on their own.
   */
  launch(vel: V3, angVel: V3 = ZERO, centre?: V3) {
    const c = centre ? _c.set(centre.x, centre.y, centre.z) : this.centreOfMass(_c);
    const cx = c.x;
    const cy = c.y;
    const cz = c.z;
    // The mass-weighted mean velocity of the attached bones: the part of their motion the slab replaces.
    _mean.set(0, 0, 0);
    let m = 0;
    for (const name of BONES) {
      if (this.loose.has(name)) continue;
      const b = this.bodies[name];
      const bm = b.mass();
      _mean.addScaledVector(toV(b.linvel(), _v), bm);
      m += bm;
    }
    if (m > 0) _mean.divideScalar(m);
    for (const name of BONES) {
      if (this.loose.has(name)) continue;
      const b = this.bodies[name];
      const lv = b.linvel();
      const av = b.angvel();
      const com = b.worldCom();
      const rx = com.x - cx;
      const ry = com.y - cy;
      const rz = com.z - cz;
      // v = v − v̄ + vel + ω × r
      b.setLinvel(
        {
          x: lv.x - _mean.x + vel.x + (angVel.y * rz - angVel.z * ry),
          y: lv.y - _mean.y + vel.y + (angVel.z * rx - angVel.x * rz),
          z: lv.z - _mean.z + vel.z + (angVel.x * ry - angVel.y * rx),
        },
        true,
      );
      b.setAngvel({ x: av.x + angVel.x, y: av.y + angVel.y, z: av.z + angVel.z }, true);
    }
    this.limpTimer = 0;
  }

  /**
   * Teleport the body to a rig (by default the fighter's current target pose: a spawn or a respawn), optionally moved
   * rigidly (`move`: a downed body laid on its slab). Velocities zeroed, interpolation and dips reset.
   */
  snapTo(f: Fighter, rig: Rig = f.rig, move: BodyMove | null = null) {
    for (const name of BONES) {
      if (this.loose.has(name)) continue;
      const x = rig[name];
      const b = this.bodies[name];
      const p = move ? movePoint(move, x.pos, _v) : _v.copy(x.pos);
      const q = move ? _q2.copy(move.rot).multiply(x.rot) : _q2.copy(x.rot);
      b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.prev[name].p.copy(p);
      this.prev[name].q.copy(q);
      this.cur[name].p.copy(p);
      this.cur[name].q.copy(q);
    }
    this.dips.clear();
    this.prevRootTarget.copy(rig.pelvis.pos);
  }

  /** Strengths for the fighter's current state: [root, muscle]. Down, the root follows the sim slab when there is one. */
  private baseStrength(f: Fighter, down: DownTarget | null): [number, number] {
    switch (f.state) {
      case 'knockdown':
        this.limpTimer++;
        return [down ? RAGDOLL_TUNING.downRootGain : 0, RAGDOLL_TUNING.limpStrength];
      case 'ko':
        return [down ? RAGDOLL_TUNING.downRootGain : 0, 0.05];
      case 'getup': {
        const u = f.stateFrame / Math.max(1, f.stunFrames);
        return [smoothstep(u / 0.6), RAGDOLL_TUNING.limpStrength + (1 - RAGDOLL_TUNING.limpStrength) * smoothstep(u / 0.25)];
      }
      default:
        return [1, 1];
    }
  }

  /**
   * Call once per fixed step, before the presentation world steps. `down`: where the sim's slab holds the body while
   * the fighter is knocked down or KO'd (null: standing, or no slab, when the root is free as in DS). `rig`: the pose
   * the standing root follows (f.rig, or a fresh rig built at a respawn before the sim's next pose update).
   */
  drive(f: Fighter, down: DownTarget | null = null, rig: Rig = f.rig) {
    const lying = f.state === 'knockdown' || f.state === 'ko';
    const slab = lying ? down : null;
    const [rootBase, muscleBase] = this.baseStrength(f, slab);
    this.rootStrength = rootBase * (1 - this.dipValue('root'));
    const T = RAGDOLL_TUNING;

    for (const name of BONES) {
      if (this.loose.has(name)) continue;
      const def = SKELETON[name];
      const body = this.bodies[name];
      const rot = toQ(body.rotation());
      const pos = toV(body.translation());
      toV(body.worldCom(), _com);
      const lv = toV(body.linvel());
      const av = toV(body.angvel());

      if (!def.parent) {
        const s = this.rootStrength;
        if (s <= 0.001) continue;
        const rootGain = f.state === 'attack' ? Math.max(T.rootGain, 0.7) : T.rootGain;
        if (slab) {
          // Down: toward the slab's hip, turned with the slab, carried at the slab's velocity there.
          angularCorrection(rot, slab.rot, rootGain, _w);
          _vd.copy(slab.vel).multiplyScalar(1 - rootGain);
          _vd.addScaledVector(_v.subVectors(slab.at, pos), rootGain / DT);
        } else {
          const target = rig.pelvis;
          angularCorrection(rot, target.rot, rootGain, _w);
          // Feed-forward target velocity + positional correction, at the joint origin.
          // (Scaled by 1 - gain: with the full target velocity on top of the positional
          // correction the body settles a whole frame ahead of its target.)
          _vd.subVectors(target.pos, this.prevRootTarget).divideScalar(DT);
          if (_vd.lengthSq() > 400) _vd.set(0, 0, 0); // teleport
          _vd.multiplyScalar(1 - rootGain);
          _vd.addScaledVector(_v.subVectors(target.pos, pos), rootGain / DT);
        }
        // Convert to centre-of-mass velocity.
        _vd.add(_v.crossVectors(_w, _v2.subVectors(_com, pos)));
        lv.lerp(clampLen(_vd, MAX_LIN), s);
        av.lerp(clampLen(_w, MAX_ANG), s);
      } else {
        const parent = this.bodies[def.parent];
        const s = muscleBase * (1 - this.dipValue(name));
        if (s <= 0.001) continue;
        const pRot = toQ(parent.rotation());
        const pAv = toV(parent.angvel());
        const pLv = toV(parent.linvel());
        toV(parent.worldCom(), _pcom);
        const desired = pRot.multiply(f.pose.rot[name]);
        const gain = f.state === 'attack' ? T.strikeGain : T.muscleGain;
        angularCorrection(rot, desired, gain, _w).add(pAv);
        // Velocity of the joint point as carried by the parent, then rigidly to our COM.
        _jp.copy(pos);
        _vd.copy(pLv).add(_v.crossVectors(pAv, _v2.subVectors(_jp, _pcom)));
        _vd.add(_v.crossVectors(_w, _v2.subVectors(_com, _jp)));
        lv.lerp(clampLen(_vd, MAX_LIN), s);
        av.lerp(clampLen(_w, MAX_ANG), s);
      }
      body.setLinvel({ x: lv.x, y: lv.y, z: lv.z }, true);
      body.setAngvel({ x: av.x, y: av.y, z: av.z }, true);
    }
    this.prevRootTarget.copy(rig.pelvis.pos);
    this.tickDips();
  }

  /** Call right before the presentation world steps. */
  capturePrev() {
    for (const name of BONES) {
      this.prev[name].p.copy(this.cur[name].p);
      this.prev[name].q.copy(this.cur[name].q);
    }
  }

  /** Call right after the presentation world steps. */
  captureCur() {
    for (const name of BONES) {
      const b = this.bodies[name];
      toV(b.translation(), this.cur[name].p);
      toQ(b.rotation(), this.cur[name].q);
    }
  }

  freezeInterpolation() {
    for (const name of BONES) {
      this.prev[name].p.copy(this.cur[name].p);
      this.prev[name].q.copy(this.cur[name].q);
    }
  }
}
