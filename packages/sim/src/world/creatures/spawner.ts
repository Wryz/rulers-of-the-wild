// The spawner (docs/M1-DESIGN.md §6.6): one ape per home and the giant at its lair at creation, ape respawns away from
// the player, the sparring ape of `?mode=training` (WorldOptions.sparringApe, D-50).
//
// STUB (P05; P22 fills it): final exported signatures. Until P22 nothing spawns (the sparring ape included).
import type { SpawnerRecV1 } from '../../save/schema';
import type { ClearingSpawnData } from '../clearing';
import type { World } from '../world';

export class Spawner {
  /** At creation: ape homes, the giant's lair and route, the sparring ape (`scene 'empty'` spawns nothing). */
  init(_w: World, _data: ClearingSpawnData | null): void {}

  /** Phase 15: ape respawns, the sparring ape. */
  update(_w: World): void {}

  toRecord(): SpawnerRecV1 {
    return { homes: [], sparring: { fighter: null, respawnTick: -1 } };
  }

  restoreRecord(r: SpawnerRecV1): void {
    if (r.homes.length > 0 || r.sparring.fighter !== null) throw new Error('world/creatures/spawner.ts: Spawner.restoreRecord is not implemented yet (P22)');
  }
}
