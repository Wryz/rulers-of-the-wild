// Breaking (docs/M1-DESIGN.md §1.5.7, §4.10): integrity loss from impacts, load breaks across the axis, pieces in id
// order, piece grace until clear of the breaker (phase 12).
//
// STUB (P05; P10 fills it): final exported signatures and BREAK_TUNING with its §9 values; nothing breaks until P10.
import { defineTuning } from '../tuning/registry';
import type { Entity, Owner, V3 } from './types';
import type { World } from './world';

export const BREAK_TUNING = defineTuning(
  'BREAK_TUNING',
  'Materials & joints › breaking',
  {
    integrityPerExcess: 1,
    piecesMin: 2,
    piecesMax: 4,
    loadLeverM: 0.1,
    pieceGraceTicks: 10,
    pieceGraceMaxTicks: 600,
  },
  {
    integrityPerExcess: { unit: '—', source: 'D-17' },
    piecesMin: { unit: 'pieces', source: 'SPEC:344' },
    piecesMax: { unit: 'pieces', source: 'SPEC:344' },
    loadLeverM: { unit: 'm', source: 'SPEC:345, 884' },
    pieceGraceTicks: { unit: 'ticks', source: 'NEW: C §7 item 7 (the minimum; the grace lasts until the piece is clear)' },
    pieceGraceMaxTicks: { unit: 'ticks', source: 'NEW: a piece still inside its breaker after 10 s is crushed (RF-7)' },
  },
);

export class Breaking {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** An impact of energy E on e (phase 9c): integrity loss above its break energy. */
  hit(e: Entity, E: number, point: V3, breaker: Owner | null): void {
    notImplemented('hit', e, E, point, breaker);
  }

  /** A load break: split across the axis at `at` (§4.10). */
  loadBreak(e: Entity, at: V3, breaker: Owner | null): void {
    notImplemented('loadBreak', e, at, breaker);
  }

  /** Phase 12: entities at integrity 0 split into pieces; piece grace. */
  update(_w: World): void {}
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/breaking.ts: Breaking.${name} is not implemented yet (P10; called with ${args.length} arguments)`);
}
