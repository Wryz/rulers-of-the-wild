// Downed and launched bodies (docs/M1-DESIGN.md §1.5.8, §4.5): a sim-side dynamic rounded slab per player/ape, enabled
// while it is down; launch, follow, settle, the stand-spot search and the hand-back to the controller. The client's
// ragdoll follows it (rule 6).
//
// STUB (P05; P08 fills it): final exported signatures and DOWNED_TUNING with its §9 values. Until P08 there are no slabs
// and every call does nothing.
import type { SlabRecV1 } from '../save/schema';
import type { Fighter } from '../sim/fighter';
import { defineTuning } from '../tuning/registry';
import type { Quat, V3 } from './types';
import type { World } from './world';

export const DOWNED_TUNING = defineTuning(
  'DOWNED_TUNING',
  'Bodies › downed',
  {
    halfWidth: 0.2,
    halfLength: 0.865,
    halfThick: 0.06,
    border: 0.04,
    friction: 0.9,
    restitution: 0.05,
    linDamp: 0.05,
    angDamp: 0.6,
    toppleRadS: 2.5,
    liftBase: 1.2,
    liftPerLift: 3,
    minPush: 0.8,
    settleSpeed: 0.5,
    settleMaxHold: 300,
    standRings: [0.35, 0.7, 1.05],
    standDirs: 8,
    maxStandSlopeDeg: 45,
    boneBands: [0.5, 0.94, 1.09, 1.29, 1.55],
  },
  {
    halfWidth: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    halfLength: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    halfThick: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    border: { unit: 'm × scale', source: 'NEW: MAP gap-4 §8' },
    friction: { unit: '—', source: 'NEW: MAP gap-4' },
    restitution: { unit: '—', source: 'NEW: MAP gap-4' },
    linDamp: { unit: '1/s', source: 'NEW: MAP gap-4' },
    angDamp: { unit: '1/s', source: 'NEW: MAP gap-4' },
    toppleRadS: { unit: 'rad/s ÷ √scale', source: 'NEW: MAP gap-4' },
    liftBase: { unit: 'm/s', source: 'DS (game.ts launch)' },
    liftPerLift: { unit: 'm/s per lift', source: 'DS (game.ts launch)' },
    minPush: { unit: 'm/s', source: 'NEW: MAP gap-4' },
    settleSpeed: { unit: 'm/s', source: 'NEW' },
    settleMaxHold: { unit: 'frames', source: 'NEW' },
    standRings: { unit: 'm', source: 'NEW: MAP gap-4 §6' },
    standDirs: { unit: 'directions', source: 'NEW' },
    maxStandSlopeDeg: { unit: '°', source: 'NEW' },
    boneBands: { unit: 'm along the slab × scale (shin/thigh/pelvis/abdomen/chest/head)', source: 'NEW: from the skeleton' },
  },
);

export class DownedBodies {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  create(_f: Fighter): void {}

  remove(_f: Fighter): void {}

  /** Phase 4a: fighters that went down this tick (or have a pending launch from phase 9) get their slab. */
  syncDown(_w: World): void {}

  /** Phase 13a: f.pos from the slab; settle; the stand-spot search and hand-back. */
  postStep(_w: World): void {}

  /** A world impact's Δv for a downed or launched fighter (applied in the next phase 4a). */
  queueDv(_f: Fighter, _dv: V3): void {}

  /** Read-only (client ragdoll). */
  pose(_fighterId: number): { p: V3; q: Quat } | null {
    return null;
  }

  /** By fighter id. */
  toRecord(): { fighter: number; slab: SlabRecV1 }[] {
    return [];
  }

  restoreRecord(r: { fighter: number; slab: SlabRecV1 }[]): void {
    if (r.length > 0) throw new Error('world/downed.ts: DownedBodies.restoreRecord is not implemented yet (P08)');
  }
}
