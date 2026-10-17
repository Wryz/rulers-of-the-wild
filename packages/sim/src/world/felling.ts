// Felling (docs/M1-DESIGN.md §1.5.7, §2.5, §4.12): chops, the hinge capacity against the fall-direction moment, the
// fall on a hinge at the uncut edge, the hinge tear, felled (phase 13c).
//
// STUB (P05; P10 fills it): final exported signatures and FELL_TUNING with its §9 values; no tree falls until P10.
// TODO "canopy collision (rule 3)": trees have no canopy collider in M1 (§2.5, X22); the trunk shape on fall is P10's.
import type { FellingRecV1 } from '../save/schema';
import { defineTuning } from '../tuning/registry';
import type { V3 } from './types';
import type { World } from './world';

export const FELL_TUNING = defineTuning(
  'FELL_TUNING',
  'Materials & joints › felling',
  {
    chopDepthM: 0.02,
    refChopJ: 339,
    chopScaleMin: 0.5,
    chopScaleMax: 2.5,
    fellAtRemaining: 0,
    hingeK: 1500,
    hingeRad: 0.1,
    cutHeightM: 0.5,
    tipAngVel: 0.15,
    hingeTearDeg: 75,
    hingeLimitDeg: 80,
  },
  {
    chopDepthM: { unit: 'm per stone-axe chop', source: 'SPEC:882' },
    refChopJ: { unit: 'J', source: "NEW: the stone axe's fresh chop [B lab: tools.ts]" },
    chopScaleMin: { unit: '×', source: 'NEW' },
    chopScaleMax: { unit: '×', source: 'NEW' },
    fellAtRemaining: { unit: 'fraction of diameter', source: "D-44 (0 keeps SPEC:882's 15 chops for 30 cm)" },
    hingeK: { unit: '—', source: 'NEW: calibrated in §4.12' },
    hingeRad: { unit: 'rad', source: 'NEW: impact → moment' },
    cutHeightM: { unit: 'm', source: 'NEW' },
    tipAngVel: { unit: 'rad/s', source: 'NEW' },
    hingeTearDeg: { unit: '°', source: 'NEW: C F10' },
    hingeLimitDeg: { unit: '°', source: 'NEW' },
  },
);

export class Felling {
  /** One chop on a tree from `fromDir` (§4.12). */
  chop(tree: number, fromDir: V3, depthM: number, credit: string[]): { remaining: number; fell: boolean } {
    return notImplemented('chop', tree, fromDir, depthM, credit);
  }

  /** Fall-direction moment this tick (pulls, pushes, impacts), N·m. */
  addMoment(tree: number, moment: number): void {
    notImplemented('addMoment', tree, moment);
  }

  /** Phase 13c. */
  update(_w: World): void {}

  /** Trees that are notched, falling or felled, by id. */
  toRecord(): FellingRecV1[] {
    return [];
  }

  restoreRecord(r: FellingRecV1[]): void {
    if (r.length > 0) notImplemented('restoreRecord', r);
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/felling.ts: Felling.${name} is not implemented yet (P10; called with ${args.length} arguments)`);
}
