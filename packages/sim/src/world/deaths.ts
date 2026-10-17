// Parts, death and respawn (docs/M1-DESIGN.md §1.5.8, §4.14): parts dropped at a creature's KO (doubled when the kill
// is environmental), corpse timers, the player's death and respawn at the spawn.
//
// STUB (P05; P09 fills it): final exported signatures. Until P09 a KO drops nothing and nobody respawns.
import type { Fighter } from '../sim/fighter';
import type { Finish } from './types';
import type { World } from './world';

export class Deaths {
  /** At the KO site (WorldPort.onKO), after the environmental classification. */
  onKO(_w: World, _d: Fighter, _finish: Finish): void {}

  /** Phase 15: parts, corpse timers, player respawn at tick + respawnDelayS × 60. */
  update(_w: World): void {}

  /** (fighter, respawnTick), by fighter id. */
  deathsRecord(): { fighter: number; respawnTick: number }[] {
    return [];
  }

  /** (fighter, removeTick), by fighter id. */
  corpsesRecord(): { fighter: number; removeTick: number }[] {
    return [];
  }

  restoreRecord(deaths: { fighter: number; respawnTick: number }[], corpses: { fighter: number; removeTick: number }[]): void {
    if (deaths.length > 0 || corpses.length > 0) throw new Error('world/deaths.ts: Deaths.restoreRecord is not implemented yet (P09)');
  }
}
