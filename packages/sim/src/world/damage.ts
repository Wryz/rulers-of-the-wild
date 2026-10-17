// Pure rule functions for world contacts (docs/M1-DESIGN.md §1.5.5, §4.3): the hard landing, the sharpness leading
// test and the self-motion split. m_eff and the energy itself come from sim/rules.ts (reducedMass, impactEnergy).
//
// STUB (P05; P09 fills it): final exported signatures; every function throws until P09.
import type { Pose3, SharpPoint, V3 } from './types';

/** ½ m v_safe² (SPEC:284, D-4). */
export function hardLandingJ(boneKg: number, vSafe: number): number {
  return notImplemented('hardLandingJ', boneKg, vSafe);
}

/** The largest sharpness of a point leading into the contact (§4.3, SPEC:281); 0 when none leads. */
export function leadingSharpness(points: readonly SharpPoint[], pose: Pose3, contact: V3, vRelIntoPoint: V3): number {
  return notImplemented('leadingSharpness', points, pose, contact, vRelIntoPoint);
}

/** max(0, vSelf·n) ≥ max(0, −vOther·n): the creature's own motion drives the contact (§4.3, RF-3). */
export function selfMotion(vSelf: V3, vOther: V3, nOutOfSelf: V3): boolean {
  return notImplemented('selfMotion', vSelf, vOther, nOutOfSelf);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/damage.ts: ${name} is not implemented yet (P09; called with ${args.length} arguments)`);
}
