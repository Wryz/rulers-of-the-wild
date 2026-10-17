// Load capacity and covers (docs/M1-DESIGN.md §1.5.7, §4.11): foot loads of standing fighters and resting weights,
// passed down through coverings in equal shares, a 0.2 s average against capacity, load breaks (phase 11).
//
// STUB (P05; P10 fills it): final exported signatures and LOAD_TUNING with its §9 values; nothing is loaded until P10.
import { defineTuning } from '../tuning/registry';
import type { Entity } from './types';
import type { World } from './world';

export const LOAD_TUNING = defineTuning(
  'LOAD_TUNING',
  'Materials & joints › loads',
  {
    loadWindowS: 0.2,
    maxSpreadDepth: 4,
    supportNormalY: 0.5,
    footDiscH: 0.06,
    spanGapM: 0.1,
  },
  {
    loadWindowS: { unit: 's', source: 'SPEC:345' },
    maxSpreadDepth: { unit: 'levels', source: 'NEW: D-39' },
    supportNormalY: { unit: 'cos', source: 'NEW' },
    footDiscH: { unit: 'm', source: 'NEW: D-39' },
    spanGapM: { unit: 'm', source: 'NEW: an entity is load-tested only where nothing supports it within this below the load point (I-1)' },
  },
);

export class Loads {
  /** Phase 11. */
  update(_w: World): void {}

  /** Break energy ÷ loadLeverM, N (SPEC:345, 884). */
  capacityN(e: Entity): number {
    throw new Error(`world/loads.ts: Loads.capacityN is not implemented yet (P10; entity ${e.id})`);
  }
}
