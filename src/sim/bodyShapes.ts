import { Vector3 } from 'three';
import { type BoneName, bonePoint, fistPoint, SKELETON } from '../body/skeleton';
import type { Fighter } from './fighter';

/** A capsule: segment a-b with radius r (world). */
export interface Capsule {
  bone: BoneName | 'fistL' | 'fistR';
  a: Vector3;
  b: Vector3;
  r: number;
}

const TORSO: BoneName[] = ['pelvis', 'abdomen', 'chest', 'head'];
const LIMBS: BoneName[] = ['upperArmL', 'foreArmL', 'upperArmR', 'foreArmR', 'thighL', 'shinL', 'thighR', 'shinR'];
/** Visual half-thickness of each block (matches the fighter model). */
const R: Record<BoneName, number> = {
  pelvis: 0.13, abdomen: 0.12, chest: 0.15, head: 0.13,
  upperArmL: 0.06, foreArmL: 0.055, upperArmR: 0.06, foreArmR: 0.055,
  thighL: 0.08, shinL: 0.07, thighR: 0.08, shinR: 0.07,
};

/** The fighter's body as capsules (sim pose), torso and limbs separately; `skip`
 * leaves out limbs (e.g. the one throwing a strike). */
export function bodyCapsules(f: Fighter, skip: (BoneName | 'fistL' | 'fistR')[] = []): { torso: Capsule[]; limbs: Capsule[] } {
  const s = f.scale;
  const cap = (bone: BoneName, from: number, to: number): Capsule => ({
    bone,
    a: bonePoint(f.rig, bone, from, new Vector3()),
    b: bonePoint(f.rig, bone, to, new Vector3()),
    r: R[bone] * s,
  });
  const torso = TORSO.filter((b) => !f.isSevered(b)).map((b) => (b === 'head' ? cap(b, 0.08, 0.24) : cap(b, 0, SKELETON[b].length)));
  const limbs = LIMBS.filter((b) => !f.isSevered(b) && !skip.includes(b)).map((b) => cap(b, 0.03, SKELETON[b].length - 0.03));
  for (const side of ['L', 'R'] as const) {
    if (f.isSevered(side === 'L' ? 'foreArmL' : 'foreArmR') || skip.includes(side === 'L' ? 'fistL' : 'fistR')) continue;
    const p = fistPoint(f.rig, side, new Vector3());
    limbs.push({ bone: side === 'L' ? 'fistL' : 'fistR', a: p, b: p.clone(), r: 0.075 * s });
  }
  return { torso, limbs };
}

const _d1 = new Vector3();
const _d2 = new Vector3();
const _r = new Vector3();
const _c1 = new Vector3();
const _c2 = new Vector3();

/** Closest distance between two segments. */
export function segDist(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _d1.dot(_d1);
  const e = _d2.dot(_d2);
  const f = _d2.dot(_r);
  let s: number;
  let t: number;
  if (a <= 1e-9 && e <= 1e-9) return p1.distanceTo(p2);
  if (a <= 1e-9) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = _d1.dot(_r);
    if (e <= 1e-9) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = _d1.dot(_d2);
      const den = a * e - b * b;
      s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  _c1.copy(p1).addScaledVector(_d1, s);
  _c2.copy(p2).addScaledVector(_d2, t);
  return _c1.distanceTo(_c2);
}

/** How far two capsules overlap (0 when apart). */
export function overlap(x: Capsule, y: Capsule): number {
  return Math.max(0, x.r + y.r - segDist(x.a, x.b, y.a, y.b));
}

/** Closest point on segment a-b to p. */
export function closestOnSegment(p: Vector3, a: Vector3, b: Vector3, out: Vector3): Vector3 {
  _d1.subVectors(b, a);
  const l2 = _d1.lengthSq();
  const t = l2 < 1e-9 ? 0 : Math.min(1, Math.max(0, _r.subVectors(p, a).dot(_d1) / l2));
  return out.copy(a).addScaledVector(_d1, t);
}

/** Limbs a strike is thrown with (left out of body-on-body checks while it lands). */
export function strikingLimbs(limb: 'handL' | 'handR' | 'footL' | 'footR'): (BoneName | 'fistL' | 'fistR')[] {
  switch (limb) {
    case 'handL':
      return ['upperArmL', 'foreArmL', 'fistL'];
    case 'handR':
      return ['upperArmR', 'foreArmR', 'fistR'];
    case 'footL':
      return ['thighL', 'shinL'];
    case 'footR':
      return ['thighR', 'shinR'];
  }
}
