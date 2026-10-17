// World impacts on fighters: applyImpact (HP, Δv, knockdown, launch, press, hitstun, reaction, lastKnock) and the
// environmental-kill classification with its credit (docs/M1-DESIGN.md §1.5.5, §4.4).
//
// PLACEHOLDER (P01, RF-8): the exports below have their final signatures and IMPACT_TUNING is registered with its §9
// values. Both functions throw until P09 fills this file (TODOs for P09 at the matching lines of applyImpact, §12.4:
// "impact gore"; "rule 11 (multiplayer): damage from an entity credited to another player knocks down, never kills").
//
// Imports from combat.ts and fighter.ts are type-only: combat.ts may import this module at runtime.
import { defineTuning } from '../tuning/registry';
import type { Finish, Impact, ImpactResult } from '../world/types';
import type { CombatSim } from './combat';
import type { Fighter } from './fighter';

export const IMPACT_TUNING = defineTuning(
  'IMPACT_TUNING',
  'Damage rule › world impacts',
  {
    poisePerHp: 3.2,
    bluntPoiseMul: 1.35,
    weightMediumHp: 5,
    weightHeavyHp: 12,
    hitstunBase: 12,
    hitstunPerHp: 0.9,
    launchDv: 5,
    flinchDv: 0.5,
    envKillWindowS: 2,
    envKillPartsMul: 2,
    // TODO "ruler blows (SPEC:417)": rule 9 and SPEC:417 against SPEC:278 (RR-6, departure X20). Both levers stay off
    // by default so the calibrated numbers stand until a playtest asks (§4.4).
    creatureRestitution: 0,
    unbackedTargetMassRatio: Infinity,
    partsRingR: 0.6,
    partsDropH: 0.3,
  },
  {
    poisePerHp: { unit: 'poise/HP', source: 'DS (hit poise damage)' },
    bluntPoiseMul: { unit: '×', source: 'DS' },
    weightMediumHp: { unit: 'HP', source: 'DS (projectileStrike weight)' },
    weightHeavyHp: { unit: 'HP', source: 'DS' },
    hitstunBase: { unit: 'frames', source: 'DS (projectileStrike)' },
    hitstunPerHp: { unit: 'frames/HP', source: 'DS' },
    launchDv: { unit: 'm/s', source: 'NEW: above every DS knockback (max 4.6), MAP gap-2 §8' },
    flinchDv: { unit: 'm/s', source: 'NEW: MAP gap-2 §8' },
    envKillWindowS: { unit: 's', source: 'SPEC:415' },
    envKillPartsMul: { unit: '× parts', source: 'SPEC:415 ("pay double parts"), D-30' },
    creatureRestitution: {
      unit: '—',
      source: 'NEW: off-by-default rule-9 lever, Δv × (1 + e) creature on creature (RR-6, §4.4)',
    },
    unbackedTargetMassRatio: { unit: '×', source: 'NEW: off-by-default SPEC:417 lever, Infinity = off (RR-6, §4.4)' },
    partsRingR: { unit: 'm × scale', source: 'NEW: where parts appear (RR-7)' },
    partsDropH: { unit: 'm', source: 'NEW: where parts appear (RR-7)' },
  },
);

/** §4.4: the world hit `i` on `i.target`, through the one damage rule. */
export function applyImpact(sim: CombatSim, i: Impact): ImpactResult {
  return notImplemented('applyImpact', sim, i);
}

/** §4.4 "Environmental kills": whether a KO counts as the world's, and who gets the credit. */
export function isEnvironmental(d: Fighter, finish: Finish, tick: number): { environmental: boolean; credit: string[] } {
  return notImplemented('isEnvironmental', d, finish, tick);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`sim/impact.ts: ${name} is not implemented yet (P09; called with ${args.length} arguments)`);
}
