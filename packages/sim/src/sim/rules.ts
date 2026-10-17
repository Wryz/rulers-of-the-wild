// Rules shared by CombatSim and the world (docs/M1-DESIGN.md §1.5.4): the one damage rule's energy and HP (rule 2,
// SPEC:275-285), the throw cap, zone toughness, bone masses for m_eff, and their tuning tables. They live here so
// combat.ts can use them without importing a world module.
//
// Imports of fighter.ts and combat.ts are type-only: both import this module at runtime.
import type { BoneName } from '../body/skeleton';
import { BONE_ZONE, zoneMassShares } from '../body/mass';
import { defineTuning } from '../tuning/registry';
import type { HurtZone } from './combat';
import type { Fighter } from './fighter';

/** The damage rule (folder "Damage rule", §9). */
export const DAMAGE_TUNING = defineTuning(
  'DAMAGE_TUNING',
  'Damage rule',
  {
    kS: 3,
    K: 18,
    meleeJPerDmg: 18,
    throwCapJ: 400,
    leadingCos: 0.7,
    tipRadiusM: 0.15,
    impactCooldownTicks: 6,
    minImpactJ: 5,
    hardLandingBluntOnly: true,
    zoneGraceTicks: 2,
  },
  {
    kS: { unit: '—', source: 'SPEC:281' },
    K: { unit: 'J/HP', source: 'SPEC:283', min: 1 },
    meleeJPerDmg: { unit: 'J per DS damage point', source: 'SPEC:283', min: 0 },
    throwCapJ: { unit: 'J', source: 'SPEC:285, 886', min: 0 },
    leadingCos: { unit: 'cos', source: 'DS (projectileStrike leading test)', min: -1, max: 1 },
    tipRadiusM: { unit: 'm', source: 'NEW: a sharp point counts only near its tip', min: 0 },
    impactCooldownTicks: { unit: 'ticks', source: 'NEW: bounce suppression per pair', min: 0, step: 1 },
    minImpactJ: { unit: 'J', source: 'NEW: ignore brushes (with |Δv| < flinchDv)', min: 0 },
    hardLandingBluntOnly: { unit: '—', source: 'D-4' },
    zoneGraceTicks: {
      unit: 'ticks',
      source: 'NEW: contacts starting this soon after a pose jump are never scored (RF-1)',
      min: 0,
      step: 1,
    },
  },
);

/** Movement of bodies: sprint, crouch, jump, carrying and dragging (folder "Bodies › movement", §9, §5.5). */
export const MOVE_TUNING = defineTuning(
  'MOVE_TUNING',
  'Bodies › movement',
  {
    sprintMul: 1.4,
    sprintStaminaPerS: 0.15,
    sprintMinStamina: 0.1,
    crouchSpeedMul: 0.5,
    jumpStamina: 0.05,
    jumpBufferFrames: 6,
    carrySpeedPerKg: 0.01,
    carrySpeedMin: 0.6,
    carryRegenPerKg: 0.015,
    carryRegenMin: 0.4,
    carryNoSprintKg: 20,
    dragSpeedMul: 0.75,
    pullWalkMul: 0.2,
    limpStanceMul: 0.4,
    limpStepHeightMul: 0.5,
  },
  {
    sprintMul: { unit: '× speed', source: 'NEW: DS run 3.77 → sprint 5.28 m/s (SPEC:370)', min: 1 },
    sprintStaminaPerS: { unit: 'stamina/s', source: 'NEW: 6.7 s from full', min: 0 },
    sprintMinStamina: { unit: 'stamina', source: 'NEW', min: 0, max: 1 },
    crouchSpeedMul: { unit: '× speed', source: 'NEW', min: 0, max: 1 },
    jumpStamina: { unit: 'stamina', source: 'NEW', min: 0, max: 1 },
    jumpBufferFrames: { unit: 'ticks', source: 'NEW: D-28 jump press buffer (RR-7)', min: 0, step: 1 },
    carrySpeedPerKg: { unit: '1/kg', source: 'NEW: SPEC:387 "carrying slows you"', min: 0 },
    carrySpeedMin: { unit: '× speed', source: 'NEW (40 kg → 0.6)', min: 0, max: 1 },
    carryRegenPerKg: { unit: '1/kg', source: 'NEW: SPEC:387 "costs stamina"', min: 0 },
    carryRegenMin: { unit: '× regen', source: 'NEW', min: 0, max: 1 },
    carryNoSprintKg: { unit: 'kg', source: 'NEW', min: 0 },
    dragSpeedMul: { unit: '× walk', source: 'NEW', min: 0, max: 1 },
    pullWalkMul: { unit: '× walk', source: 'NEW: braced while pulling', min: 0, max: 1 },
    // Not in §9: the optional limp gait of §6.4 (FootworkStyle.limp, P02a) gives these two factors in prose only.
    limpStanceMul: {
      unit: '× amount',
      source: "NEW: §6.4 limp row: the bad leg's stance time × (1 − this × amount)",
      min: 0,
      max: 1,
    },
    limpStepHeightMul: { unit: '× step height', source: "NEW: §6.4 limp row: the bad leg's step height ×", min: 0, max: 1 },
  },
);

/** HP from an impact energy E against toughness T (rule 2, SPEC:283): max(0, E − T) / K. */
export function hpFromEnergy(E: number, T: number): number {
  return Math.max(0, E - T) / DAMAGE_TUNING.K;
}

/** The speed a throw leaves the hand at (SPEC:285): the technique's speed, capped at throwCapJ of kinetic energy. */
export function launchSpeed(massKg: number, techSpeed: number): number {
  return Math.min(techSpeed, Math.sqrt((2 * DAMAGE_TUNING.throwCapJ) / massKg));
}

/**
 * The energy a blow on this zone must beat before it does damage (J): the species' hide plus whatever worn items
 * add there (`Fighter.armour`, derived from the worn items' materials' armourJ, RR-3).
 */
export function zoneToughness(d: Fighter, zone: HurtZone): number {
  return d.toughnessJ + (d.armour[zone] ?? 0);
}

/**
 * The struck bone's mass (kg), the target's side of m_eff (§4.3, orchestrator decision 2): d.mass × its share.
 * `mode` is the species' `SPECIES_BODY[species].massShareMode` (sim/species.ts); with 'zone' the bone counts with
 * its whole HurtZone (the SPEC:876 shares, a playtest lever). The caller passes it: this module can't read species
 * data without importing the world's species table into combat.ts's dependencies.
 */
export function boneMass(d: Fighter, bone: BoneName, mode: 'bone' | 'zone' = 'bone'): number {
  return mode === 'zone' ? d.mass * zoneMassShares()[BONE_ZONE[bone]] : d.mass * d.boneShare[bone];
}

/** m1·m2/(m1 + m2); a static side (Infinity) leaves the other mass, and two static sides are static. */
export function reducedMass(m1: number, m2: number): number {
  if (m1 === Infinity) return m2;
  if (m2 === Infinity) return m1;
  return (m1 * m2) / (m1 + m2);
}

/** The one damage rule's energy (SPEC:275): ½ m_eff v_n² (1 + kS·s). */
export function impactEnergy(mEff: number, vn: number, s: number): number {
  return 0.5 * mEff * vn * vn * (1 + DAMAGE_TUNING.kS * s);
}
