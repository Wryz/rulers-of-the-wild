import type { HurtZone } from '../sim/combat';
import { defineTuning } from '../tuning/registry';
import { type BoneName, BONES } from './skeleton';

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

/** Each hit zone's share of a body whose bones weigh `kg` (computed the way DungeonStyle's constants were). */
function zoneSharesOf(kg: Readonly<Record<BoneName, number>>): Record<HurtZone, number> {
  const total = BONES.reduce((sum, b) => sum + kg[b], 0);
  const z: Record<HurtZone, number> = { head: 0, chest: 0, abdomen: 0, legs: 0 };
  for (const b of BONES) z[BONE_ZONE[b]] += kg[b];
  return { head: z.head / total, chest: z.chest / total, abdomen: z.abdomen / total, legs: z.legs / total };
}

const boneKgMeta = (b: string) => ({
  unit: 'kg at scale 1',
  source: `SPEC:876 (DS MASS, ragdoll.ts: ${b}); orchestrator decision 2 (RR-2)`,
  min: 0.1,
  step: 0.1,
});
const zoneShareMeta = (z: string, pct: string) => ({
  unit: 'fraction',
  source: `SPEC:876 (${z} ${pct}; a read-out of boneKg, decision 2)`,
});

/**
 * The humanoid body's mass, bone by bone (docs/M1-DESIGN.md §2.7, §9 BODY_MASS_TUNING): the live table the damage
 * rule's m_eff (a struck bone's mass, orchestrator decision 2), every fighter's mass and the client's ragdoll read.
 * `zoneShare` is a read-out (the HurtZone totals of SPEC:876, used only by `massShareMode: 'zone'`): derived from
 * `boneKg`, shown in the dev panel, never edited or saved.
 */
export const BODY_MASS_TUNING = defineTuning(
  'BODY_MASS_TUNING',
  'Creatures › bodies',
  {
    boneKg: {
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
    } as Record<BoneName, number>,
    get zoneShare(): Record<HurtZone, number> {
      return zoneSharesOf(this.boneKg);
    },
  },
  {
    boneKg: Object.fromEntries(BONES.map((b) => [b, boneKgMeta(b)])) as Record<BoneName, ReturnType<typeof boneKgMeta>>,
    zoneShare: {
      head: zoneShareMeta('head', '7.5 %'),
      chest: zoneShareMeta('chest with arms', '31.1 %'),
      abdomen: zoneShareMeta('abdomen with pelvis', '24.6 %'),
      legs: zoneShareMeta('legs', '36.8 %'),
    },
  },
);

/**
 * How heavy each bone of the humanoid body is at scale 1 (kg): DungeonStyle's ragdoll
 * table, kept here so the sim (the damage rule needs a bone's mass) and the client's
 * ragdoll read the same numbers. The ragdoll scales them by `scale^2.5`. It is the live
 * table `BODY_MASS_TUNING.boneKg` itself (the same object), so a tuning edit reaches both.
 */
export const BONE_MASS: Readonly<Record<BoneName, number>> = BODY_MASS_TUNING.boneKg;

/** The whole humanoid body at scale 1 (73.3 kg by default), from the live table. */
export function humanoidMass(): number {
  return BONES.reduce((sum, b) => sum + BODY_MASS_TUNING.boneKg[b], 0);
}

/** Each bone's share of the body's mass (they sum to 1), from the live table. */
export function boneMassShares(): Record<BoneName, number> {
  const kg = BODY_MASS_TUNING.boneKg;
  const total = humanoidMass();
  return Object.fromEntries(BONES.map((b) => [b, kg[b] / total])) as Record<BoneName, number>;
}

/**
 * Each hit zone's share of the body's mass, from the bones in it (live table): head 7.5%,
 * chest with the arms 31.1%, abdomen with the pelvis 24.6%, legs 36.8% by default.
 */
export function zoneMassShares(): Record<HurtZone, number> {
  return zoneSharesOf(BODY_MASS_TUNING.boneKg);
}

// Read-outs of the DEFAULT table, frozen at load, kept for tests and tools (tests/mass.test.ts). No sim code reads
// them: the sim reads the live table through the functions above (tests/bodyMass.test.ts checks it, RR-2).

/** The whole humanoid body at scale 1 (73.3 kg), as registered. */
export const HUMANOID_MASS = humanoidMass();

/** Each bone's share of the default body's mass (they sum to 1). */
export const BONE_MASS_SHARE: Readonly<Record<BoneName, number>> = Object.freeze(boneMassShares());

/**
 * Each hit zone's share of the default body's mass: head 7.5%, chest with the arms 31.1%,
 * abdomen with the pelvis 24.6%, legs 36.8%.
 */
export const ZONE_MASS_SHARE: Readonly<Record<HurtZone, number>> = Object.freeze(zoneMassShares());
