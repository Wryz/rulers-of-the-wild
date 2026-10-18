// The spawner (docs/M1-DESIGN.md §6.6, §6.7, §6.8; package P22): one ape per home and the giant at its lair when the
// world is made, ape respawns away from the player, and the sparring ape of `?mode=training` (WorldOptions.sparringApe,
// D-50, which replaces DungeonStyle's training ring).
//
// - init (World's constructor, after the player): one ape per ClearingSpawnData.apeHomes entry, in home order, standing
//   at its home facing its loop's first waypoint, its mind's home that home (CreatureMind.setHome(home, i), so
//   ApeMind patrols that home's loop); then the giant at the lair facing its route's first waypoint, its mind's home
//   the lair (its route is the spawn data's, RulerMind.route); then the sparring ape when asked. Ids in that order, after
//   the player's. No spawn data (scene 'empty') makes no home apes and no giant. A home or a lair off the terrain (a
//   world smaller than the Clearing) gets no creature, as generation keeps only what lands on its terrain; its slot
//   stays empty for the world's life.
// - update (phase 15, after the deaths): a home ape that is out (KO'd) or gone is due again respawnS later, counted
//   from the tick the spawner saw it out (the KO's own tick: a KO in phase 3 or 9 is seen in phase 15 of that tick); at
//   that tick a new ape is made at its home when no player is within respawnMinPlayerDistM of the home, else the
//   respawn is tried again respawnRetryS later. Its corpse is Deaths' (corpse timer and distance gate, §4.14), never
//   the spawner's. The giant never respawns (the dev op spawnGiant makes another).
// - The sparring ape (§6.6): sparringDistM in front of the player, facing it, straight into `fight` with full awareness
//   of the player (ApeMind.engage: awareness cap 1.5, a shout). sparringRespawnS after its KO its body is removed and a
//   new one is made in front of the player the same way (DungeonStyle's training cadence: clearEnemies, then spawn).
//   INTERPRETATION (§6.6 "In scene 'empty' it spawns nothing"): that is the spawn data's creatures; an empty scene built
//   with `sparringApe: true` asked for the sparring ape and gets it (no world is built that way but a test's).
// - Ids, never reused (§8.1): a respawn is a new fighter with a fresh id from the world's counter.
//
// The record (SpawnerRecV1, §6.8): per home, its living ape (null while it waits to respawn, or for a home that has
// none) and the tick it is due (−1 none); the sparring ape (its body, alive or out awaiting the respawn that removes
// it; null without one) and the tick it is due (−1 none). Everything else init sets up is in the minds' records (home,
// homeIdx, the giant's lair and route, the sparring ape's awareness and state), so restoreRecord puts back exactly the
// slots, against the world's regenerated spawn data.
import type { SpawnerRecV1 } from '../../save/schema';
import type { Fighter } from '../../sim/fighter';
import { DT } from '../../sim/math';
import type { ClearingSpawnData } from '../clearing';
import type { World } from '../world';
import { WORLD_TUNING } from '../worldTuning';
import { ApeMind } from './apeMind';
import { CREATURE_TUNING } from './defs';
import type { GroundXZ } from './mind';

/** No respawn due (a respawnTick), or no slot fighter. */
const NONE = -1;

/** One spawn slot: its fighter and the tick a respawn is due (−1 none). */
interface Slot {
  fighter: number | null;
  respawnTick: number;
}

const copySlot = (s: Slot): Slot => ({ fighter: s.fighter, respawnTick: s.respawnTick });

/** rad, the fighter yaw convention (sin yaw along x, cos yaw along z): the heading from `a` toward `b`. */
const bearingTo = (a: GroundXZ, b: GroundXZ): number => Math.atan2(b.x - a.x, b.z - a.z);

/** Whole ticks in `s` seconds. */
const ticksIn = (s: number): number => Math.round(s / DT);

/** The fighter with id `id` in the sim, if it is still there. */
function fighterById(w: World, id: number): Fighter | undefined {
  return w.combat.fighters.find((f) => f.id === id);
}

/** (x, z) lies on the world's terrain (its tiles' extent, edges included). */
export function onTerrain(w: World, p: GroundXZ): boolean {
  const t = w.terrain;
  return p.x >= t.minX && p.x <= t.minX + t.tilesX * t.tileSize && p.z >= t.minZ && p.z <= t.minZ + t.tilesZ * t.tileSize;
}

/** Whether any player stands within `r` of `p` (horizontal distance; a respawn needs every player farther away). */
function playerWithin(w: World, p: GroundXZ, r: number): boolean {
  for (const f of w.players.values()) if (Math.hypot(f.pos.x - p.x, f.pos.z - p.z) <= r) return true;
  return false;
}

/**
 * The giant ape (createCreature) standing at the spawn data's lair, facing its route's first waypoint (the lair
 * approach; the spawn without a route), its mind's home the lair (§6.4 `rest`, `flee`); its patrol route is the spawn
 * data's (RulerMind.route). Null without spawn data, a lair, or a lair on the terrain. The spawner's, and the dev op
 * spawnGiant's with no point given.
 */
export function spawnGiantAtLair(w: World, data: ClearingSpawnData | null): Fighter | null {
  const lair = data?.lair;
  if (!data || !lair || !onTerrain(w, lair)) return null;
  const toward = data.route[0] ?? { x: WORLD_TUNING.spawnX, z: WORLD_TUNING.spawnZ };
  const f = w.spawnCreature('giantApe', lair, bearingTo(lair, toward));
  w.minds.get(f)?.setHome(lair);
  return f;
}

export class Spawner {
  readonly world: World;
  /** The spawn data init was given (the world's; null in an empty scene). Not saved: regenerated from the seed. */
  data: ClearingSpawnData | null = null;
  /** One slot per ClearingSpawnData.apeHomes entry, in home order. */
  private homes: Slot[] = [];
  private sparring: Slot = { fighter: null, respawnTick: NONE };

  constructor(world: World) {
    this.world = world;
  }

  /** At creation: ape homes, the giant at its lair, the sparring ape (no spawn data: no homes and no giant). */
  init(w: World, data: ClearingSpawnData | null): void {
    this.data = data;
    this.homes = [];
    this.sparring = { fighter: null, respawnTick: NONE };
    if (data) {
      for (let i = 0; i < data.apeHomes.length; i++) {
        const slot: Slot = { fighter: null, respawnTick: NONE };
        this.homes.push(slot);
        if (onTerrain(w, data.apeHomes[i].home)) slot.fighter = this.spawnHomeApe(w, i).id;
      }
      spawnGiantAtLair(w, data);
    }
    if (w.options.sparringApe) this.spawnSparring(w);
  }

  /** Phase 15 (after Deaths): home apes out or gone become due, due ones respawn away from players; the sparring ape. */
  update(w: World): void {
    const A = CREATURE_TUNING.ape;
    const tick = w.tick;
    for (let i = 0; i < this.homes.length; i++) {
      const s = this.homes[i];
      if (s.fighter !== null) {
        if (fighterById(w, s.fighter)?.alive) continue;
        s.fighter = null;
        s.respawnTick = tick + ticksIn(A.respawnS);
        continue;
      }
      if (s.respawnTick < 0 || tick < s.respawnTick) continue;
      if (playerWithin(w, this.homeOf(i), A.respawnMinPlayerDistM)) s.respawnTick = tick + ticksIn(A.respawnRetryS);
      else {
        s.fighter = this.spawnHomeApe(w, i).id;
        s.respawnTick = NONE;
      }
    }

    const sp = this.sparring;
    if (sp.fighter === null) return;
    if (sp.respawnTick < 0) {
      if (!fighterById(w, sp.fighter)?.alive) sp.respawnTick = tick + ticksIn(A.sparringRespawnS);
      return;
    }
    if (tick < sp.respawnTick || !w.player) return;
    const old = fighterById(w, sp.fighter);
    if (old) w.removeFighter(old);
    this.spawnSparring(w);
  }

  /** The home slots and the sparring ape (read-outs and tests; copies). */
  slots(): { homes: { fighter: number | null; respawnTick: number }[]; sparring: { fighter: number | null; respawnTick: number } } {
    return { homes: this.homes.map(copySlot), sparring: copySlot(this.sparring) };
  }

  toRecord(): SpawnerRecV1 {
    return { homes: this.homes.map(copySlot), sparring: copySlot(this.sparring) };
  }

  /**
   * The loader's (save/load.ts, after the fighters and minds are back): the slots, against the world's regenerated
   * spawn data (a world built for a load skips init). A home's living ape and a sparring ape that isn't awaiting its
   * respawn must be apes in the loaded world; the sparring ape's body awaiting the respawn may be gone already.
   */
  restoreRecord(r: SpawnerRecV1): void {
    const w = this.world;
    const data = w.spawnData;
    const n = data?.apeHomes.length ?? 0;
    if (r.homes.length !== n) throw new Error(`save record: spawner.homes has ${r.homes.length} slots, and the world's spawn data ${n} ape homes`);
    const ape = (id: number, p: string): void => {
      const f = fighterById(w, id);
      if (!f) throw new Error(`save record: ${p} names fighter ${id}, which isn't in the loaded world`);
      if (f.species !== 'ape' || !(w.minds.get(f) instanceof ApeMind)) throw new Error(`save record: ${p} names fighter ${id}, which isn't an ape`);
    };
    r.homes.forEach((s, i) => {
      if (s.fighter !== null) ape(s.fighter, `spawner.homes[${i}].fighter`);
    });
    if (r.sparring.fighter !== null && r.sparring.respawnTick < 0) ape(r.sparring.fighter, 'spawner.sparring.fighter');
    this.data = data;
    this.homes = r.homes.map(copySlot);
    this.sparring = copySlot(r.sparring);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private homeOf(i: number): GroundXZ {
    return this.data!.apeHomes[i].home;
  }

  /** An ape at home `i`, facing its loop's first waypoint (the spawn without one), its mind's home that home. */
  private spawnHomeApe(w: World, i: number): Fighter {
    const h = this.data!.apeHomes[i];
    const toward = h.loop[0] ?? { x: WORLD_TUNING.spawnX, z: WORLD_TUNING.spawnZ };
    const f = w.spawnCreature('ape', h.home, bearingTo(h.home, toward));
    w.minds.get(f)?.setHome(h.home, i);
    return f;
  }

  /** The sparring ape sparringDistM in front of the player, facing it, fighting it; none without a player. */
  private spawnSparring(w: World): Fighter | null {
    const p = w.player;
    if (!p) return null;
    const d = CREATURE_TUNING.ape.sparringDistM;
    const at = { x: p.pos.x + Math.sin(p.yaw) * d, z: p.pos.z + Math.cos(p.yaw) * d };
    const f = w.spawnCreature('ape', at, bearingTo(at, p.pos));
    const mind = w.minds.get(f);
    if (mind instanceof ApeMind) mind.engage(w, p);
    this.sparring = { fighter: f.id, respawnTick: NONE };
    return f;
  }
}
