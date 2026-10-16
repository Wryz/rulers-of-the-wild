import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import type { HurtZone } from '../sim/combat';
import type { Fighter } from '../sim/fighter';
import { DT, smoothstep } from '../sim/math';
import type { MoveDef, Weight } from '../sim/moves';
import { type BoneName, BONES, SKELETON } from './skeleton';

type R = typeof RAPIER_NS;

export const GROUP_ENV = 0x0001;
export const GROUP_BODY = 0x0002;
export const groups = (membership: number, filter: number) => (membership << 16) | filter;

/** Each ragdoll gets its own collision bit (bits 2..15) so bodies can touch each other. */
const SLOT_BITS = 0xfffc;
let usedSlots = 0;

/** Live-tunable ragdoll parameters (exposed in the debug panel). */
export const RAGDOLL_TUNING = {
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
};

const MASS: Record<BoneName, number> = {
  pelvis: 10,
  abdomen: 8,
  chest: 15,
  head: 5.5,
  upperArmL: 2.2,
  foreArmL: 1.7,
  upperArmR: 2.2,
  foreArmR: 1.7,
  thighL: 9,
  shinL: 4.5,
  thighR: 9,
  shinR: 4.5,
};

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

const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _v2 = new Vector3();
const _w = new Vector3();
const _vd = new Vector3();
const _com = new Vector3();
const _pcom = new Vector3();
const _jp = new Vector3();

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
  /** This ragdoll's own collision bit. */
  readonly slot: number;
  private contactMask = -1;

  constructor(
    RAPIER: R,
    private readonly world: RAPIER_NS.World,
    fighter: Fighter,
  ) {
    const rig = fighter.rig;
    const sc = fighter.scale;
    let bit = 0x0004;
    while (bit & usedSlots && bit < 0x10000) bit <<= 1;
    this.slot = bit < 0x10000 ? bit : 0;
    usedSlots |= this.slot;
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
      cd.setMass(MASS[name] * Math.pow(sc, 2.5)).setFriction(0.9).setRestitution(0.05).setCollisionGroups(groups(GROUP_BODY | this.slot, GROUP_ENV));
      world.createCollider(cd, body);
      this.bodies[name] = body;
      this.prev[name] = { p: x.pos.clone(), q: x.rot.clone() };
      this.cur[name] = { p: x.pos.clone(), q: x.rot.clone() };
    }
    for (const name of BONES) {
      const def = SKELETON[name];
      if (!def.parent) continue;
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

  dispose() {
    usedSlots &= ~this.slot;
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

  applyHit(zone: HurtZone, point: Vector3, dir: Vector3, move: MoveDef, scale = 1) {
    const w = WEIGHT_SCALE[move.weight];
    const dips = ZONE_DIPS[zone];
    for (const [k, depth] of Object.entries(dips) as [BoneName | 'root', number][]) {
      const dd = Math.min(1, depth * w.depth * RAGDOLL_TUNING.dipMul * scale);
      const existing = this.dips.get(k);
      if (!existing || this.dipValue(k) < dd) this.dips.set(k, { depth: dd, hold: w.hold, recover: w.recover, t: 0 });
    }
    const lift = move.lift ?? 0.05;
    _v.copy(dir).multiplyScalar(1 - lift).addScaledVector(_v2.set(0, 1, 0), lift).normalize();
    const mag = move.impulse * RAGDOLL_TUNING.impulseMul * scale;
    let bone = ZONE_BODY[zone];
    if (zone === 'legs') {
      const l = this.bodies.shinL.translation();
      const r = this.bodies.shinR.translation();
      const dl = (l.x - point.x) ** 2 + (l.z - point.z) ** 2;
      const dr = (r.x - point.x) ** 2 + (r.z - point.z) ** 2;
      bone = dl < dr ? 'shinL' : 'shinR';
    }
    this.bodies[bone].applyImpulseAtPoint(
      { x: _v.x * mag * 0.7, y: _v.y * mag * 0.7, z: _v.z * mag * 0.7 },
      { x: point.x, y: point.y, z: point.z },
      true,
    );
    // Share of the shove goes through the whole body.
    this.bodies.pelvis.applyImpulse({ x: _v.x * mag * 0.3, y: _v.y * mag * 0.3, z: _v.z * mag * 0.3 }, true);
  }

  /** Small reaction for a blocked strike: arms absorb it. */
  applyBlock(dir: Vector3, move: MoveDef) {
    for (const k of ['upperArmL', 'foreArmL', 'upperArmR', 'foreArmR', 'chest'] as const) {
      this.dips.set(k, { depth: 0.6 * RAGDOLL_TUNING.dipMul, hold: 2, recover: 10, t: 0 });
    }
    this.dips.set('root', { depth: 0.25, hold: 2, recover: 10, t: 0 });
    const mag = move.impulse * 0.35 * RAGDOLL_TUNING.impulseMul;
    for (const k of ['foreArmL', 'foreArmR'] as const) {
      this.bodies[k].applyImpulse({ x: dir.x * mag * 0.3, y: 0, z: dir.z * mag * 0.3 }, true);
    }
    this.bodies.chest.applyImpulse({ x: dir.x * mag * 0.4, y: 0, z: dir.z * mag * 0.4 }, true);
  }

  /** Throw the whole body (knockdown / KO). */
  launch(vel: Vector3) {
    for (const name of BONES) {
      const b = this.bodies[name];
      const lv = b.linvel();
      b.setLinvel({ x: lv.x + vel.x, y: lv.y + vel.y, z: lv.z + vel.z }, true);
    }
    this.limpTimer = 0;
  }

  /** Teleport the body to the fighter's current target pose (respawn). */
  snapTo(f: Fighter) {
    for (const name of BONES) {
      if (this.loose.has(name)) continue;
      const x = f.rig[name];
      const b = this.bodies[name];
      b.setTranslation({ x: x.pos.x, y: x.pos.y, z: x.pos.z }, true);
      b.setRotation({ x: x.rot.x, y: x.rot.y, z: x.rot.z, w: x.rot.w }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.prev[name].p.copy(x.pos);
      this.prev[name].q.copy(x.rot);
      this.cur[name].p.copy(x.pos);
      this.cur[name].q.copy(x.rot);
    }
    this.dips.clear();
    this.prevRootTarget.copy(f.rig.pelvis.pos);
  }

  /** Strengths for the fighter's current state: [root, muscle]. */
  private baseStrength(f: Fighter): [number, number] {
    switch (f.state) {
      case 'knockdown':
        this.limpTimer++;
        return [0, RAGDOLL_TUNING.limpStrength];
      case 'ko':
        return [0, 0.05];
      case 'getup': {
        const u = f.stateFrame / Math.max(1, f.stunFrames);
        return [smoothstep(u / 0.6), RAGDOLL_TUNING.limpStrength + (1 - RAGDOLL_TUNING.limpStrength) * smoothstep(u / 0.25)];
      }
      default:
        return [1, 1];
    }
  }

  /** Call once per fixed step, before `world.step()`. */
  drive(f: Fighter) {
    const [rootBase, muscleBase] = this.baseStrength(f);
    this.rootStrength = rootBase * (1 - this.dipValue('root'));
    const rig = f.rig;
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
        const target = rig.pelvis;
        const s = this.rootStrength;
        if (s <= 0.001) continue;
        const rootGain = f.state === 'attack' ? Math.max(T.rootGain, 0.7) : T.rootGain;
        angularCorrection(rot, target.rot, rootGain, _w);
        // Feed-forward target velocity + positional correction, at the joint origin.
        // (Scaled by 1 - gain: with the full target velocity on top of the positional
        // correction the body settles a whole frame ahead of its target.)
        _vd.subVectors(target.pos, this.prevRootTarget).divideScalar(DT);
        if (_vd.lengthSq() > 400) _vd.set(0, 0, 0); // teleport
        _vd.multiplyScalar(1 - rootGain);
        _vd.addScaledVector(_v.subVectors(target.pos, pos), rootGain / DT);
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

  /** Call right before `world.step()`. */
  capturePrev() {
    for (const name of BONES) {
      this.prev[name].p.copy(this.cur[name].p);
      this.prev[name].q.copy(this.cur[name].q);
    }
  }

  /** Call right after `world.step()`. */
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
