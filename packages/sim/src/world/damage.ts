// Pure rule functions for world contacts (docs/M1-DESIGN.md §1.5.5, §4.3): m_eff by pair kind, the sharpness leading
// test, the hard landing, the self-motion split, the energy a contact delivers to each side and the world-impact Δv.
// The energy itself and the reduced mass come from sim/rules.ts (impactEnergy, reducedMass), the one damage rule
// (rule 2, SPEC:275) every hit in the game goes through.
//
// Nothing here reads Rapier, the world or a fighter: the contact pipeline (world/contacts.ts) gathers the numbers and
// these functions turn them into the rule's answer, so each line of §4.3 is testable on its own.
import { DAMAGE_TUNING, impactEnergy, reducedMass } from '../sim/rules';
import type { Pose3, SharpPoint, V3 } from './types';

/** ½ m v_safe² (SPEC:284, D-4): the energy of a safe landing, taken off a blunt hard landing before the rule. */
export function hardLandingJ(boneKg: number, vSafe: number): number {
  return 0.5 * boneKg * vSafe * vSafe;
}

/**
 * The largest sharpness of a point leading into the contact (§4.3, SPEC:281); 0 when none leads. A sharp point (tip t,
 * outward dir d, both entity-local in `pose`'s frame) leads when the contact point is within DAMAGE_TUNING.tipRadiusM
 * of t and the other side comes at the tip: `vRelIntoPoint` is the other side's velocity relative to the point's body,
 * and −v̂_rel · d ≥ DAMAGE_TUNING.leadingCos (DS's `dir·v̂ > 0.7` in projectileStrike). A contact with no relative
 * motion has no leading point.
 */
export function leadingSharpness(points: readonly SharpPoint[], pose: Pose3, contact: V3, vRelIntoPoint: V3): number {
  if (points.length === 0) return 0;
  const speed = len(vRelIntoPoint);
  if (!(speed > 0)) return 0;
  const r = DAMAGE_TUNING.tipRadiusM;
  const cosMin = DAMAGE_TUNING.leadingCos;
  let s = 0;
  for (const pt of points) {
    const tip = add(pose.p, rotate(pose.q, pt.local));
    if (dist(tip, contact) > r) continue;
    const d = rotate(pose.q, pt.dir);
    const dl = len(d);
    if (!(dl > 0)) continue;
    // (The 1e-9 epsilon of §2.1: a velocity straight down a 45° snag's axis must read exactly at the threshold.)
    const into = -dot(vRelIntoPoint, d) / (speed * dl);
    if (into >= cosMin - 1e-9 && pt.sharpness > s) s = pt.sharpness;
  }
  return s;
}

/**
 * max(0, vSelf·n) ≥ max(0, −vOther·n) (§4.3, RF-3): the creature's own motion drives the contact (it ran, fell or was
 * carried into something), as opposed to the other side bringing the speed (a log falling on it). `n` points out of
 * the creature. Two bodies at rest are self-motion (and deliver nothing).
 */
export function selfMotion(vSelf: V3, vOther: V3, nOutOfSelf: V3): boolean {
  return Math.max(0, dot(vSelf, nOutOfSelf)) >= Math.max(0, -dot(vOther, nOutOfSelf));
}

/**
 * One side of a contact, for m_eff (§4.3's table):
 * - a creature collider (a standing zone, a slab, a ruler bone): the struck bone's mass, and the whole body's (the
 *   `unbackedTargetMassRatio` lever, §4.4);
 * - an entity: its mass, or static when it is fixed or anchored (isAnchored: a staked log is static whatever its mass);
 * - the terrain: static.
 */
export type MeffSide =
  | { kind: 'creature'; boneKg: number; bodyKg: number }
  | { kind: 'entity'; massKg: number; static: boolean }
  | { kind: 'terrain' };

/** kg a side brings to the reduced mass: a bone, an entity, or Infinity for a static side. */
export function sideMass(s: MeffSide): number {
  switch (s.kind) {
    case 'creature':
      return s.boneKg;
    case 'entity':
      return s.static ? Infinity : s.massKg;
    case 'terrain':
      return Infinity;
  }
}

/**
 * m_eff of a contact as `self` sees it (§4.3, SPEC:278, orchestrator decision 2):
 *
 * | Pair | m_eff |
 * |---|---|
 * | creature (zone, slab, ruler bone) vs dynamic entity | reducedMass(mb, me) |
 * | creature vs fixed/anchored entity or terrain | mb |
 * | creature vs another creature's zone or slab | reducedMass(mb, mb_other) |
 * | entity vs entity | reducedMass(m1, m2); a fixed/anchored side → the other's mass |
 * | entity vs terrain | the entity's mass |
 *
 * which is reducedMass of the two sides' masses with a static side as Infinity. `unbackedRatio`
 * (IMPACT_TUNING.unbackedTargetMassRatio, Infinity = off, §4.4, RR-6): when the other side is a creature bone that
 * outweighs the whole of `self`'s body by that ratio, `self`'s side is its whole body (a 73.3 kg player can't be
 * "backed" by the rest of a body against a 2,865 kg bone).
 * TODO "crush rule": a zone backed by terrain or a fixed body counts as static for the impactor (m_eff = the
 * impactor's mass), the §4.15 lever for AC-9; not built in M1.
 */
export function contactMeff(self: MeffSide, other: MeffSide, unbackedRatio: number): number {
  let mSelf = sideMass(self);
  if (self.kind === 'creature' && other.kind === 'creature' && Number.isFinite(unbackedRatio) && other.boneKg >= unbackedRatio * self.bodyKg) {
    mSelf = self.bodyKg;
  }
  return reducedMass(mSelf, sideMass(other));
}

/**
 * The energy a contact delivers (§4.3): `full` = ½ m_eff v_n² (1 + kS·s), what an entity's integrity takes and what a
 * creature takes when the other side brought the speed or a sharp point leads; `creature` = full less the safe landing
 * ½·m_bone·v_safe² when DAMAGE_TUNING.hardLandingBluntOnly holds, the contact is blunt (s = 0), the target is a
 * creature and the other side is static (terrain, fixed or anchored) or the creature's own motion drove it
 * (SPEC:284, D-4, RF-3). Never negative.
 */
export function contactEnergy(o: {
  mEff: number;
  vn: number;
  s: number;
  boneKg: number;
  vSafe: number;
  staticOther: boolean;
  selfMotion: boolean;
}): { full: number; creature: number } {
  const full = impactEnergy(o.mEff, o.vn, o.s);
  let creature = full;
  if (DAMAGE_TUNING.hardLandingBluntOnly && o.s === 0 && (o.staticOther || o.selfMotion)) {
    creature = Math.max(0, full - hardLandingJ(o.boneKg, o.vSafe));
  }
  return { full, creature };
}

/**
 * The world-impact Δv of a target of mass M (§4.4): (1 + e·[impactor is a creature]) · m_imp · v_rel / (M + m_imp),
 * in 3-D, v_rel = the impactor's velocity relative to the target (e = IMPACT_TUNING.creatureRestitution, an
 * off-by-default rule-9 lever). Zero for a static impactor (m_imp Infinity): the terrain, a fixed or anchored entity.
 */
export function impactDv(mImp: number, vRel: V3, M: number, creatureImpactor: boolean, restitution: number): V3 {
  if (!Number.isFinite(mImp) || !(mImp > 0)) return { x: 0, y: 0, z: 0 };
  const k = ((1 + (creatureImpactor ? restitution : 0)) * mImp) / (M + mImp);
  return { x: k * vRel.x, y: k * vRel.y, z: k * vRel.z };
}

// ---------------------------------------------------------------------------
// Small vector helpers (plain V3 records)
// ---------------------------------------------------------------------------

export function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function len(a: V3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function add(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function dist(a: V3, b: V3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** v rotated by the unit quaternion q. */
export function rotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
