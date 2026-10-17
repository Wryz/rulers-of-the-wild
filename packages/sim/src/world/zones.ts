// Hit zones of standing players and apes (docs/M1-DESIGN.md §1.5.8, §4.8, §4.3): a kinematic body and 12 bone sensor
// colliders per fighter, posed from the rig in phase 4b, with the pose history the damage rule reads and its reset.
//
// STUB (P05; P08 fills it): final exported signatures. Until P08 no fighter has zone bodies and every call does nothing.
import type { Fighter } from '../sim/fighter';
import type { World } from './world';

export class ZoneBodies {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  create(_f: Fighter): void {}

  remove(_f: Fighter): void {}

  setEnabled(_f: Fighter, _on: boolean): void {}

  /** Phase 4b: standing and rising players/apes posed from the rig; the pose history pushed. */
  pose(_w: World): void {}

  /** N−1 and N−2 := the current pose (carryV 0) + zone grace (§4.3, RF-1). */
  resetHistory(_f: Fighter): void {}

  /** The zone pose history of a fighter, for the save (§8.3 `bodies.zonesHistory`). */
  historyRecord(_f: Fighter): number[] {
    return [];
  }
}
