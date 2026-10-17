// The ruler in CombatSim: melee volumes, the zone classifier, RulerState (damage, wounds, recovery, finishing, down)
// and rulerHit (docs/M1-DESIGN.md §1.5.5, §2.8, §4.6).
//
// PLACEHOLDER (P01, RF-8): the exports below have their final signatures and the tables are registered with their
// §9 values, so combat.ts (P02b) can import rulerVolumes and RULER_TUNING.lockScale before P11 exists. Every function
// throws until P11 fills this file; none is reached unless a ruler exists.
//
// Imports from combat.ts and fighter.ts are type-only: combat.ts imports this module at runtime.
import type { Vector3 } from 'three';
import type { BoneName } from '../body/skeleton';
import { defineTuning } from '../tuning/registry';
import type { ImpactCause, RulerState, RulerZoneId, WoundRecord } from '../world/types';
import type { CombatSim, HurtSphere, HurtZone } from './combat';
import type { Fighter } from './fighter';
import type { MoveDef } from './moves';
import type { WeaponDef } from './weapons';

export const RULER_TUNING = defineTuning(
  'RULER_TUNING',
  'Ruler',
  {
    recoveryHpPerS: 30,
    woundFrac: 0.02,
    severeFrac: 0.15,
    woundHealHpPerHour: 50,
    severePenaltyFrac: 0.05,
    pinnedKg: 1000,
    unpinnedKg: 900,
    unpinTicks: 15,
    pinnedNormalY: 0.5,
    lockScale: 2,
    retargetBiasCapM: 0.35,
    separateSkipSpeed: 1.0,
  },
  {
    recoveryHpPerS: { unit: 'HP/s', source: 'SPEC:504, 877' },
    woundFrac: { unit: '× max HP (240 HP)', source: 'SPEC:502' },
    severeFrac: { unit: '× max HP (1,800 HP)', source: 'SPEC:503' },
    woundHealHpPerHour: { unit: 'HP per hour of play', source: 'SPEC:506, 877' },
    severePenaltyFrac: { unit: '× max HP per severe wound', source: 'SPEC:506' },
    pinnedKg: { unit: 'kg', source: 'SPEC:878' },
    unpinnedKg: { unit: 'kg', source: 'NEW: hysteresis' },
    unpinTicks: { unit: 'ticks', source: 'NEW: hysteresis' },
    pinnedNormalY: { unit: 'cos', source: 'D-38' },
    lockScale: { unit: '×', source: 'NEW: MAP gap-0 §6.6 (lock-on range for rulers)' },
    retargetBiasCapM: { unit: 'm', source: 'NEW: MAP gap-0 §6.6' },
    separateSkipSpeed: {
      unit: 'm/s',
      source: "NEW: above this closing speed separate() doesn't push a pair with a standing ruler; the contact scores instead (RF-5)",
    },
  },
);

export const RULER_ZONE_TUNING = defineTuning(
  'RULER_ZONE_TUNING',
  'Ruler › zones',
  {
    softJ: 600,
    armourJ: 4000,
    defaultJ: 4000,
    kneeR: 0.09,
    elbowR: 0.07,
    eyeNzMin: 0.6,
    eyeNyMin: -0.05,
    eyeNyMax: 0.35,
    eyeNxMax: 0.55,
    mouthNzMin: 0.6,
    mouthNyMin: -0.6,
    mouthNyMax: -0.05,
    mouthNxMax: 0.4,
    shouldersNy: 0.6,
    backNz: -0.4,
    flanksNx: 0.6,
    bellyNz: 0.5,
    bellyNxMax: 0.6,
  },
  {
    softJ: { unit: 'J', source: 'SPEC:875 (eyes, mouth, belly, knees, elbows)' },
    armourJ: { unit: 'J', source: 'SPEC:875 (skull, back, shoulders, flanks)' },
    defaultJ: { unit: 'J', source: 'D-8 (unlisted surfaces)' },
    kneeR: { unit: 'm × scale', source: 'NEW: MAP gap-0 §5, gap-6' },
    elbowR: { unit: 'm × scale', source: 'NEW: MAP gap-0 §5' },
    eyeNzMin: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    eyeNyMin: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    eyeNyMax: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    eyeNxMax: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    mouthNzMin: { unit: 'normal component', source: 'NEW' },
    mouthNyMin: { unit: 'normal component', source: 'NEW' },
    mouthNyMax: { unit: 'normal component', source: 'NEW' },
    mouthNxMax: { unit: 'normal component', source: 'NEW' },
    shouldersNy: { unit: 'normal component', source: 'NEW' },
    backNz: { unit: 'normal component', source: 'NEW' },
    flanksNx: { unit: 'normal component', source: 'NEW' },
    bellyNz: { unit: 'normal component', source: 'NEW' },
    bellyNxMax: { unit: 'normal component', source: 'NEW' },
  },
);

/** A melee volume of a ruler: one of DS's 12 bodySpheres, or a knee or elbow sphere (§2.8). */
export interface RulerVolume extends HurtSphere {
  joint: 'knee' | 'elbow' | null;
}

/** 12 DS bodySpheres (combat.ts bodySpheres) + 2 knee + 2 elbow spheres. */
export function rulerVolumes(f: Fighter): RulerVolume[] {
  return notImplemented('rulerVolumes', f);
}

/** `normalOut`: the outward normal in the bone frame (§2.8). */
export function classifyRulerZone(f: Fighter, bone: BoneName, point: Vector3, normalOut: Vector3): RulerZoneId {
  return notImplemented('classifyRulerZone', f, bone, point, normalOut);
}

export function rulerToughness(z: RulerZoneId): number {
  return notImplemented('rulerToughness', z);
}

export function newRulerState(maxHp: number): RulerState {
  return notImplemented('newRulerState', maxHp);
}

/** maxHp × (1 − severePenaltyFrac × severe count). */
export function rulerEffectiveMax(r: RulerState): number {
  return notImplemented('rulerEffectiveMax', r);
}

/** effectiveMax − unhealed − Σ wound.remaining. */
export function rulerHp(r: RulerState): number {
  return notImplemented('rulerHp', r);
}

/** f.state === 'tripped' || f.ruler.inPit (SPEC:504). */
export function rulerDown(f: Fighter): boolean {
  return notImplemented('rulerDown', f);
}

/** rulerDown || stuck || pinned: no recovery; finishing. */
export function rulerHeld(f: Fighter): boolean {
  return notImplemented('rulerHeld', f);
}

/**
 * §4.6. `w` is the world (World satisfies it); typed by the members used, since world/world.ts doesn't exist yet.
 * TODO(P11): `w: { ids: WorldIds; combat: CombatSim }` once world.ts exists (P05).
 */
export function rulerDamage(
  w: { ids: { wound: { take(): number } }; combat: CombatSim },
  f: Fighter,
  hp: number,
  zone: RulerZoneId,
  bone: BoneName,
  cause: ImpactCause,
  point: Vector3,
): WoundRecord | null {
  return notImplemented('rulerDamage', w, f, hp, zone, bone, cause, point);
}

/** Recovery and healing (§4.6). */
export function rulerTick(f: Fighter, dt: number): void {
  notImplemented('rulerTick', f, dt);
}

/**
 * The ruler branch of hit() (§4.6), called through WorldPort.rulerHit. TODO(P11): `w: World` once world.ts exists
 * (P05); `unknown` until then so World's call site compiles both before and after.
 */
export function rulerHit(
  sim: CombatSim,
  w: unknown,
  a: Fighter,
  d: Fighter,
  m: MoveDef,
  point: Vector3,
  dir: Vector3,
  zone: HurtZone,
  bone: BoneName,
  power: number,
  haft: boolean,
  thrown: WeaponDef | null,
  ruleDamageHp: number | null,
): void {
  notImplemented('rulerHit', sim, w, a, d, m, point, dir, zone, bone, power, haft, thrown, ruleDamageHp);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`sim/ruler.ts: ${name} is not implemented yet (P11; called with ${args.length} arguments)`);
}
