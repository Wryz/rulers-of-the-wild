import type { HurtZone } from '../sim/combat';
import { type BoneName, BONES } from './skeleton';

/**
 * How heavy each bone of the humanoid body is at scale 1 (kg): DungeonStyle's ragdoll
 * table, kept here so the sim (the damage rule needs a zone's mass) and the client's
 * ragdoll read the same numbers. The ragdoll scales them by `scale^2.5`.
 */
export const BONE_MASS: Readonly<Record<BoneName, number>> = {
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

/**
 * The hit zone each bone counts as, grouped as `bodySpheres` groups them: there are no
 * arm zones (arms count as chest), and the pelvis counts as abdomen.
 */
export const BONE_ZONE: Readonly<Record<BoneName, HurtZone>> = {
  pelvis: 'abdomen',
  abdomen: 'abdomen',
  chest: 'chest',
  head: 'head',
  upperArmL: 'chest',
  foreArmL: 'chest',
  upperArmR: 'chest',
  foreArmR: 'chest',
  thighL: 'legs',
  shinL: 'legs',
  thighR: 'legs',
  shinR: 'legs',
};

/** The whole humanoid body at scale 1 (73.3 kg). */
export const HUMANOID_MASS = BONES.reduce((sum, b) => sum + BONE_MASS[b], 0);

/** Each bone's share of the body's mass (they sum to 1). */
export const BONE_MASS_SHARE: Readonly<Record<BoneName, number>> = Object.fromEntries(
  BONES.map((b) => [b, BONE_MASS[b] / HUMANOID_MASS]),
) as Record<BoneName, number>;

/**
 * Each hit zone's share of the body's mass, from the bones in it: head 7.5%, chest with
 * the arms 31.1%, abdomen with the pelvis 24.6%, legs 36.8%.
 */
export const ZONE_MASS_SHARE: Readonly<Record<HurtZone, number>> = (() => {
  const kg: Record<HurtZone, number> = { head: 0, chest: 0, abdomen: 0, legs: 0 };
  for (const b of BONES) kg[BONE_ZONE[b]] += BONE_MASS[b];
  return { head: kg.head / HUMANOID_MASS, chest: kg.chest / HUMANOID_MASS, abdomen: kg.abdomen / HUMANOID_MASS, legs: kg.legs / HUMANOID_MASS };
})();
