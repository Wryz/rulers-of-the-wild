// The world's named random streams (docs/M1-DESIGN.md §8.1). Each is `new Rng(seedFor(worldSeed, name, id))`, so
// generation, combat, fracture and every creature draw from their own stream and a change to one never shifts another:
//
// - `combat`: CombatSim.rng (BrawlerAIs share it, as DungeonStyle does). CombatSim builds it from
//   `seedOf('combat')`; the world attaches it here so the save reads every state in one place.
// - `world`: fracture, spawn jitter.
// - `gen`: the Clearing's generation, consumed at creation only (not saved: a load regenerates from the seed).
// - `fighter:<id>`: each Fighter's own Rng, through FighterOpts.rngSeed (id = ids.fighter.next at construction).
// - `mind:<id>`: each creature mind's Rng.
import { Rng, seedFor } from '../sim/math';

export class WorldRngs {
  readonly worldSeed: number;
  readonly world: Rng;
  readonly gen: Rng;
  private combatRng: Rng | null = null;
  private readonly minds = new Map<number, Rng>();

  constructor(worldSeed: number) {
    this.worldSeed = worldSeed >>> 0;
    this.world = new Rng(this.seedOf('world'));
    this.gen = new Rng(this.seedOf('gen'));
  }

  /** The seed of a named stream (seedFor of the world seed). */
  seedOf(stream: string, id = 0): number {
    return seedFor(this.worldSeed, stream, id);
  }

  /** FighterOpts.rngSeed for the fighter that will take id `id`. */
  fighterSeed(id: number): number {
    return this.seedOf('fighter', id);
  }

  /** CombatSim's Rng (attached by the world right after it builds the CombatSim). */
  get combat(): Rng {
    if (!this.combatRng) throw new Error('WorldRngs: the combat stream is attached by the World');
    return this.combatRng;
  }

  attachCombat(rng: Rng): void {
    this.combatRng = rng;
  }

  /** The mind stream of fighter `id` (one Rng per id, made on first use). */
  mind(id: number): Rng {
    let r = this.minds.get(id);
    if (!r) {
      r = new Rng(this.seedOf('mind', id));
      this.minds.set(id, r);
    }
    return r;
  }

  /** The states the save keeps of the world-level streams (fighters' and minds' states are saved with their owners). */
  toRecord(): { combat: number; world: number } {
    return { combat: this.combat.state, world: this.world.state };
  }

  restoreRecord(r: { combat: number; world: number }): void {
    this.combat.state = r.combat;
    this.world.state = r.world;
  }
}
