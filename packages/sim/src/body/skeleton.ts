import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

/**
 * Shared humanoid skeleton. Used by the combat sim (for hit detection against the
 * animated target pose) and by the ragdoll (which physically follows that pose).
 *
 * Fighter-local space: +Z forward (toward the opponent), +Y up, +X is the fighter's
 * LEFT side. Fighters stand orthodox: left side leads.
 */
export const BONES = [
  'pelvis',
  'abdomen',
  'chest',
  'head',
  'upperArmL',
  'foreArmL',
  'upperArmR',
  'foreArmR',
  'thighL',
  'shinL',
  'thighR',
  'shinR',
] as const;

export type BoneName = (typeof BONES)[number];

export interface BoneDef {
  name: BoneName;
  parent: BoneName | null;
  /** Joint position in the parent's local frame. */
  offset: [number, number, number];
  length: number;
  /** +1: bone extends along local +Y (spine). -1: along -Y (limbs). */
  dir: 1 | -1;
  /** Physics capsule radius. */
  radius: number;
}

export const STAND_HEIGHT = 0.97;
const SHOULDER_X = 0.19;
const HIP_X = 0.095;

export const SKELETON: Record<BoneName, BoneDef> = {
  pelvis: { name: 'pelvis', parent: null, offset: [0, 0, 0], length: 0.12, dir: 1, radius: 0.13 },
  abdomen: { name: 'abdomen', parent: 'pelvis', offset: [0, 0.12, 0], length: 0.2, dir: 1, radius: 0.13 },
  chest: { name: 'chest', parent: 'abdomen', offset: [0, 0.2, 0], length: 0.26, dir: 1, radius: 0.15 },
  head: { name: 'head', parent: 'chest', offset: [0, 0.26, 0], length: 0.26, dir: 1, radius: 0.11 },
  upperArmL: { name: 'upperArmL', parent: 'chest', offset: [SHOULDER_X, 0.21, 0], length: 0.29, dir: -1, radius: 0.05 },
  foreArmL: { name: 'foreArmL', parent: 'upperArmL', offset: [0, -0.29, 0], length: 0.26, dir: -1, radius: 0.045 },
  upperArmR: { name: 'upperArmR', parent: 'chest', offset: [-SHOULDER_X, 0.21, 0], length: 0.29, dir: -1, radius: 0.05 },
  foreArmR: { name: 'foreArmR', parent: 'upperArmR', offset: [0, -0.29, 0], length: 0.26, dir: -1, radius: 0.045 },
  thighL: { name: 'thighL', parent: 'pelvis', offset: [HIP_X, -0.03, 0], length: 0.44, dir: -1, radius: 0.075 },
  shinL: { name: 'shinL', parent: 'thighL', offset: [0, -0.44, 0], length: 0.43, dir: -1, radius: 0.055 },
  thighR: { name: 'thighR', parent: 'pelvis', offset: [-HIP_X, -0.03, 0], length: 0.44, dir: -1, radius: 0.075 },
  shinR: { name: 'shinR', parent: 'thighR', offset: [0, -0.44, 0], length: 0.43, dir: -1, radius: 0.055 },
};

/** Distance from the wrist joint (forearm end) to the centre of the fist. */
export const FIST_OFFSET = 0.05;
/** Ankle sits this far above the ground when standing on a flat foot. */
export const ANKLE_HEIGHT = 0.07;

export type Side = 'L' | 'R';
export const SIDE_SIGN: Record<Side, number> = { L: 1, R: -1 };

export interface Pose {
  /** Pelvis joint position in fighter-local space. */
  root: Vector3;
  /** Local rotation of each bone relative to its parent (pelvis: relative to fighter). */
  rot: Record<BoneName, Quaternion>;
  /** Direction a held weapon points from the rear fist (fighter-local, unit). */
  blade: Vector3;
  /**
   * How far up the handle the top hand rides (0 = down by the bottom hand, 1 = choked
   * right up toward the head). Heavy two-handers are held and wound up with the hands
   * apart and swung with the top hand sliding down to meet the bottom one.
   */
  slide: number;
}

/** Weapon held up and forward when a pose doesn't say otherwise. */
export const DEFAULT_BLADE: V3 = [0.1, 0.72, 0.68];

export function makePose(): Pose {
  const rot = {} as Record<BoneName, Quaternion>;
  for (const b of BONES) rot[b] = new Quaternion();
  return { root: new Vector3(0, STAND_HEIGHT, 0), rot, blade: new Vector3(...DEFAULT_BLADE).normalize(), slide: 0 };
}

export function copyPose(src: Pose, out: Pose): Pose {
  out.root.copy(src.root);
  for (const b of BONES) out.rot[b].copy(src.rot[b]);
  out.blade.copy(src.blade);
  out.slide = src.slide;
  return out;
}

export function blendPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  out.root.lerpVectors(a.root, b.root, t);
  for (const n of BONES) out.rot[n].slerpQuaternions(a.rot[n], b.rot[n], t);
  slerpDir(a.blade, b.blade, t, out.blade);
  out.slide = a.slide + (b.slide - a.slide) * t;
  return out;
}

const _dirAxis = new Vector3();
const _invChest = new Quaternion();
const _local = new Vector3();
const _back = new Vector3();
const _from = new Vector3();
const _q = new Quaternion();

/**
 * Turn one direction into another by rotating it (constant length, steady angular
 * speed) — a weapon swings round, it doesn't shrink through the middle and flip. A
 * reversal (wind-up behind to strike in front) goes over the top.
 */
export function slerpDir(a: Vector3, b: Vector3, t: number, out: Vector3): Vector3 {
  _from.copy(a).normalize();
  const dot = Math.max(-1, Math.min(1, _from.dot(b) / (b.length() || 1)));
  _dirAxis.crossVectors(_from, b);
  if (_dirAxis.lengthSq() < 1e-6) {
    if (dot > 0) return out.copy(b).normalize();
    _dirAxis.set(0, 1, 0).cross(_from);
    if (_dirAxis.lengthSq() < 1e-6) _dirAxis.set(1, 0, 0);
    _dirAxis.negate();
  }
  _q.setFromAxisAngle(_dirAxis.normalize(), Math.acos(dot) * t);
  return out.copy(_from).applyQuaternion(_q).normalize();
}

// ---------------------------------------------------------------------------
// Forward kinematics
// ---------------------------------------------------------------------------

export interface BoneXform {
  pos: Vector3; // joint position (world or fighter-local)
  rot: Quaternion;
  /** Uniform body scale (giants > 1, small creatures < 1). */
  s: number;
}

export type Rig = Record<BoneName, BoneXform>;

export function makeRig(): Rig {
  const r = {} as Rig;
  for (const b of BONES) r[b] = { pos: new Vector3(), rot: new Quaternion(), s: 1 };
  return r;
}

const _v = new Vector3();
const _yawQ = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);

/**
 * Computes joint transforms. With `origin`/`yaw` the result is in world space,
 * otherwise in fighter-local space.
 */
export function forwardKinematics(pose: Pose, out: Rig, origin?: Vector3, yaw = 0, scale = 1): Rig {
  _yawQ.setFromAxisAngle(Y_AXIS, yaw);
  for (const name of BONES) {
    const def = SKELETON[name];
    const x = out[name];
    x.s = scale;
    if (!def.parent) {
      x.pos.copy(pose.root).multiplyScalar(scale).applyQuaternion(_yawQ);
      if (origin) x.pos.add(origin);
      x.rot.copy(_yawQ).multiply(pose.rot[name]);
    } else {
      const p = out[def.parent];
      x.pos.set(def.offset[0] * scale, def.offset[1] * scale, def.offset[2] * scale).applyQuaternion(p.rot).add(p.pos);
      x.rot.copy(p.rot).multiply(pose.rot[name]);
    }
  }
  return out;
}

/** Point along a bone, `t` metres from its joint (negative/over-length allowed). */
export function bonePoint(rig: Rig, bone: BoneName, t: number, out: Vector3): Vector3 {
  const def = SKELETON[bone];
  return out.set(0, def.dir * t * rig[bone].s, 0).applyQuaternion(rig[bone].rot).add(rig[bone].pos);
}

export function fistPoint(rig: Rig, side: Side, out: Vector3): Vector3 {
  const fore = side === 'L' ? 'foreArmL' : 'foreArmR';
  return bonePoint(rig, fore, SKELETON[fore].length + FIST_OFFSET, out);
}

/** Front of the foot (ball of the foot), approximated as ankle + forward. */
export function footPoint(rig: Rig, side: Side, out: Vector3): Vector3 {
  const shin = side === 'L' ? 'shinL' : 'shinR';
  bonePoint(rig, shin, SKELETON[shin].length + 0.04, out);
  // Push a little along the shin's local forward axis (toes).
  _v.set(0, 0, 0.08 * rig[shin].s).applyQuaternion(rig[shin].rot);
  return out.add(_v);
}

// ---------------------------------------------------------------------------
// Pose authoring + two-bone IK
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

export interface LimbTarget {
  /** Fist / ankle target in fighter-local space. */
  at: V3;
  /** Direction the elbow / knee should point, fighter-local. */
  hint?: V3;
}

export interface PoseSpec {
  root?: V3;
  /** Euler XYZ (radians), relative to parent. */
  pelvis?: V3;
  abdomen?: V3;
  chest?: V3;
  head?: V3;
  handL?: LimbTarget;
  handR?: LimbTarget;
  footL?: LimbTarget;
  footR?: LimbTarget;
  /** Direct rotations for limbs (used by limp / ragdoll-ish poses instead of IK). */
  rot?: Partial<Record<BoneName, V3>>;
  /** Where a held weapon points from the rear fist (fighter-local direction). */
  blade?: V3;
  /** Top hand's place up the handle of a heavy two-hander (0 bottom .. 1 choked up). */
  slide?: number;
}

const _e = new Euler();
function setEuler(q: Quaternion, e: V3 | undefined) {
  if (!e) q.identity();
  else q.setFromEuler(_e.set(e[0], e[1], e[2], 'XYZ'));
}

const _m = new Matrix4();
const _d = new Vector3();
const _hint = new Vector3();
const _axis = new Vector3();
const _thighDir = new Vector3();
const _knee = new Vector3();
const _shinDir = new Vector3();
const _xA = new Vector3();
const _yA = new Vector3();
const _zA = new Vector3();
const _invParent = new Quaternion();
const _target = new Vector3();
const _root = new Vector3();
const _tmpRig = makeRig();

/**
 * Solves a two-bone chain (upper bone hanging along -Y) so its end reaches `target`.
 * All vectors are in the same space as `rootPos` / `parentRot`.
 * `bendSign`: legs bend so the knee points along `hint` (+1);
 * arms bend so the elbow points along `hint` (-1, the forearm folds toward local +Z).
 */
function solveTwoBone(
  rootPos: Vector3,
  parentRot: Quaternion,
  target: Vector3,
  hint: Vector3,
  a: number,
  b: number,
  bendSign: 1 | -1,
  outUpper: Quaternion,
  outLower: Quaternion,
) {
  _d.subVectors(target, rootPos);
  let L = _d.length();
  const minL = Math.abs(a - b) + 0.01;
  const maxL = a + b - 0.001;
  if (L < 1e-5) _d.set(0, -1, 0);
  L = Math.min(Math.max(L, minL), maxL);
  _d.normalize();

  // Bend plane: contains d and the hint. A hint (nearly) parallel to the reach direction
  // gives an unstable plane, so bias it downward (elbows/knees default to hanging).
  _hint.copy(hint).normalize();
  _axis.crossVectors(_d, _hint);
  const unstable = _axis.lengthSq();
  if (unstable < 0.12) {
    // Prefer "down" (perpendicular to the reach); for a near-vertical reach use "back".
    // Fade the bias in as the hint lines up with the reach — switching it on at a hard
    // threshold flips the limb's roll (and the elbow / knee plane) from one frame to the next.
    // (Both blended, so a limb hanging straight down doesn't flip between them.)
    if (bendSign < 0) {
      // Arms: elbows go back when the hand is low, out and forward when it's raised
      // (never back behind a hand held up by the face).
      const sx = Math.sign(hint.x) || 1;
      const up = (_d.y + 1) / 2;
      _back.set(sx * (0.3 + 0.5 * up), 0, -1 + 1.6 * up);
      _axis.copy(_back).addScaledVector(_d, -_d.dot(_back));
    } else {
      _axis.set(0, -1, 0).addScaledVector(_d, _d.y);
      const down = _axis.lengthSq();
      _back.set(0, 0, -1).addScaledVector(_d, _d.z);
      _axis.addScaledVector(_back, Math.max(0, 1 - down / 0.3));
    }
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    const w = 1 - unstable / 0.12;
    _hint.addScaledVector(_axis.normalize(), 0.9 * w * w * (3 - 2 * w)).normalize();
    _axis.crossVectors(_d, _hint);
  }
  if (_axis.lengthSq() < 1e-6) {
    _hint.set(0, 0, 1);
    _axis.crossVectors(_d, _hint);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
  }
  _axis.normalize();

  const cosA = (a * a + L * L - b * b) / (2 * a * L);
  const alpha = Math.acos(Math.min(1, Math.max(-1, cosA)));
  _thighDir.copy(_d).applyAxisAngle(_axis, alpha);
  _knee.copy(rootPos).addScaledVector(_thighDir, a);
  _shinDir.copy(rootPos).addScaledVector(_d, L).sub(_knee).normalize();

  // Upper bone frame: local -Y along the bone, local +Z toward knee (legs) / away from elbow (arms).
  _yA.copy(_thighDir).negate();
  // In the bend plane, perpendicular to the bone, on the hint's side. (Taking the hint's
  // own perpendicular component instead flips the bone's roll 180 degrees whenever the
  // bend carries the bone past the hint.)
  _zA.crossVectors(_axis, _thighDir);
  if (_zA.lengthSq() < 1e-6) _zA.set(0, 0, 1);
  _zA.normalize().multiplyScalar(bendSign);
  _xA.crossVectors(_yA, _zA).normalize();
  _zA.crossVectors(_xA, _yA).normalize();
  _m.makeBasis(_xA, _yA, _zA);
  outUpper.setFromRotationMatrix(_m);
  // Express relative to parent.
  _invParent.copy(parentRot).invert();
  outUpper.premultiply(_invParent);

  // Lower bone: rotation about local X.
  _invParent.copy(parentRot).multiply(outUpper).invert();
  const s = _shinDir.applyQuaternion(_invParent);
  const phi = Math.atan2(-s.z, -s.y);
  outLower.setFromAxisAngle(_xA.set(1, 0, 0), phi);
}

/** Resolves an authored pose spec (spine angles + IK limb targets) into bone rotations. */
export function resolvePose(spec: PoseSpec, out: Pose = makePose()): Pose {
  const r = spec.root ?? [0, STAND_HEIGHT, 0];
  out.root.set(r[0], r[1], r[2]);
  out.blade.set(...(spec.blade ?? DEFAULT_BLADE)).normalize();
  out.slide = spec.slide ?? 0;
  setEuler(out.rot.pelvis, spec.pelvis);
  setEuler(out.rot.abdomen, spec.abdomen);
  setEuler(out.rot.chest, spec.chest);
  setEuler(out.rot.head, spec.head);
  for (const b of ['upperArmL', 'foreArmL', 'upperArmR', 'foreArmR', 'thighL', 'shinL', 'thighR', 'shinR'] as const) {
    setEuler(out.rot[b], spec.rot?.[b]);
  }

  // FK of the spine so limbs know where their sockets are.
  forwardKinematics(out, _tmpRig);

  const arm = (side: Side, t: LimbTarget | undefined) => {
    if (!t) return;
    const upper = side === 'L' ? 'upperArmL' : 'upperArmR';
    const fore = side === 'L' ? 'foreArmL' : 'foreArmR';
    const def = SKELETON[upper];
    const chest = _tmpRig.chest;
    _root.set(def.offset[0], def.offset[1], def.offset[2]).applyQuaternion(chest.rot).add(chest.pos);
    _target.set(t.at[0], t.at[1], t.at[2]);
    // (Weapon poses place the hands deliberately — on the haft, through a swing.)
    if (!spec.blade) keepHandForward(_root, chest.rot, _target);
    const h = t.hint ?? [SIDE_SIGN[side] * 0.5, -1, -0.3];
    _v.set(h[0], h[1], h[2]);
    solveTwoBone(_root, chest.rot, _target, _v, def.length, SKELETON[fore].length + FIST_OFFSET, -1, out.rot[upper], out.rot[fore]);
  };
  const leg = (side: Side, t: LimbTarget | undefined) => {
    if (!t) return;
    const thigh = side === 'L' ? 'thighL' : 'thighR';
    const shin = side === 'L' ? 'shinL' : 'shinR';
    const def = SKELETON[thigh];
    const pel = _tmpRig.pelvis;
    _root.set(def.offset[0], def.offset[1], def.offset[2]).applyQuaternion(pel.rot).add(pel.pos);
    _target.set(t.at[0], t.at[1], t.at[2]);
    const h = t.hint ?? [SIDE_SIGN[side] * 0.25, 0, 1];
    _v.set(h[0], h[1], h[2]);
    solveTwoBone(_root, pel.rot, _target, _v, def.length, SKELETON[shin].length, 1, out.rot[thigh], out.rot[shin]);
  };
  arm('L', spec.handL);
  arm('R', spec.handR);
  leg('L', spec.footL);
  leg('R', spec.footR);
  return out;
}

/**
 * Re-solves both legs of an already-resolved pose so the ankles reach new targets
 * (fighter-local). Used to put walking legs under an attacking upper body.
 */
export function solveLegs(pose: Pose, footL: LimbTarget, footR: LimbTarget): Pose {
  forwardKinematics(pose, _tmpRig);
  const pel = _tmpRig.pelvis;
  for (const [side, t] of [['L', footL], ['R', footR]] as const) {
    const thigh = side === 'L' ? 'thighL' : 'thighR';
    const shin = side === 'L' ? 'shinL' : 'shinR';
    const def = SKELETON[thigh];
    _root.set(def.offset[0], def.offset[1], def.offset[2]).applyQuaternion(pel.rot).add(pel.pos);
    _target.set(t.at[0], t.at[1], t.at[2]);
    const h = t.hint ?? [SIDE_SIGN[side] * 0.25, 0, 1];
    _v.set(h[0], h[1], h[2]);
    solveTwoBone(_root, pel.rot, _target, _v, def.length, SKELETON[shin].length, 1, pose.rot[thigh], pose.rot[shin]);
  }
  return pose;
}


/** Re-solves one arm of an already-resolved pose so the fist reaches `t` (fighter-local). */
export function solveArm(pose: Pose, side: Side, t: LimbTarget): Pose {
  forwardKinematics(pose, _tmpRig);
  const upper = side === 'L' ? 'upperArmL' : 'upperArmR';
  const fore = side === 'L' ? 'foreArmL' : 'foreArmR';
  const def = SKELETON[upper];
  const chest = _tmpRig.chest;
  _root.set(def.offset[0], def.offset[1], def.offset[2]).applyQuaternion(chest.rot).add(chest.pos);
  _target.set(t.at[0], t.at[1], t.at[2]);
  const h = t.hint ?? [SIDE_SIGN[side] * 0.5, -1, -0.3];
  _v.set(h[0], h[1], h[2]);
  solveTwoBone(_root, chest.rot, _target, _v, def.length, SKELETON[fore].length + FIST_OFFSET, -1, pose.rot[upper], pose.rot[fore]);
  return pose;
}

/**
 * A folded arm keeps the hand in front of the shoulder. With the hand straight above
 * (or behind) its own shoulder the elbow has no stable answer and thrashes about with
 * the slightest sway — and no guard is held like that anyway. Fades in only for a
 * folded arm with the hand at or above shoulder height, so reaches overhead and behind
 * (a wind-up) are untouched.
 */
function keepHandForward(shoulder: Vector3, chestRot: Quaternion, target: Vector3) {
  _invChest.copy(chestRot).invert();
  _local.subVectors(target, shoulder).applyQuaternion(_invChest);
  const len = _local.length();
  const folded = Math.min(1, Math.max(0, (0.42 - len) / 0.1));
  const high = Math.min(1, Math.max(0, (_local.y + 0.1) / 0.1));
  const k = folded * high;
  const minZ = 0;
  if (k <= 0 || _local.z >= minZ) return;
  _local.z += (minZ - _local.z) * k * k * (3 - 2 * k);
  target.copy(_local.applyQuaternion(chestRot)).add(shoulder);
}
