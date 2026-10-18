// Parts, death and respawn (docs/M1-DESIGN.md §1.5.8, §3 phase 15, §4.14): parts dropped at a creature's KO (doubled
// when the kill is environmental, SPEC:415, D-30), corpse timers, the player's death and respawn at the spawn.
//
// - onKO runs at the KO site (CombatSim.koFighter → World.onKO, in phase 3 or 9, or a bleed-out): it only notes the KO
//   with its classification (sim/impact.ts isEnvironmental). Everything that creates or moves bodies happens in phase 15
//   (update), in fighter-id order, so a KO inside hit() never meets a half-updated fighter (gore, limbs, the weapon drop
//   come after the KO site) and nothing is pending at the end of a tick (the save at phase 19 holds no pending KO).
// - A creature drops SPECIES_BODY[species].parts around its hip: count × envKillPartsMul when environmental, the i-th
//   of n at angle 2πi/n on a ring of partsRingR × scale, partsDropH above the ground, in list order, credited with the
//   KO's credit; a `parts` event. Its corpse (its slab) stays until corpseDespawnS has passed and no player is within
//   corpseDespawnMinDistM, then the fighter is removed (RR-11). A ruler's corpse (its compound body) stays for the
//   world's life in M1.
// - A player's KO is a death: a `death` event with respawnTick = tick + respawnDelayS; at that tick the player is
//   revived (HP, poise, guard and stamina full; DungeonStyle's severed and torn pieces, limb damage and cuts cleared;
//   state idle) and teleported to the spawn (D-33), and a `respawn` event follows. The slab hands back to the controller
//   and the zones in the next phase 4a (world/downed.ts); belt and back stay (SPEC:422), the hands dropped at the KO
//   (the verbs' onDown). Built things stay: they are entities.
//
// TODO "carcass entity": an ape's corpse is its slab until removed; converting a body into a carcass entity you can
// carry or use as bait is M4 work, with smell and bait (SPEC:171, 384; departure X21).
import { SPECIES_BODY } from '../sim/species';
import type { Fighter } from '../sim/fighter';
import { IMPACT_TUNING, isEnvironmental } from '../sim/impact';
import { DT } from '../sim/math';
import type { Finish, Quat } from './types';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

/** A KO noted at its site, handled in phase 15. */
interface PendingKO {
  f: Fighter;
  environmental: boolean;
  credit: string[];
}

/** A cylinder part lies along its ring's tangent (its axis is local +Y); boxes keep their faces level. */
const LIE_FLAT_TILT = Math.PI / 2;

export class Deaths {
  readonly world: World;
  private pending: PendingKO[] = [];
  /** Player fighter id → the tick it respawns. */
  private readonly respawns = new Map<number, number>();
  /** Creature fighter id → the tick its corpse may be removed (once no player is near). */
  private readonly corpses = new Map<number, number>();

  constructor(world: World) {
    this.world = world;
  }

  /** At the KO site (WorldPort.onKO), after the environmental classification: noted for phase 15. */
  onKO(w: World, d: Fighter, finish: Finish): void {
    if (this.pending.some((p) => p.f === d)) return;
    const r = isEnvironmental(d, finish, w.tick);
    this.pending.push({ f: d, environmental: r.environmental, credit: r.credit });
  }

  /** Phase 15: this tick's KOs (parts, corpse timers, deaths), then due respawns and corpse removals, in fighter-id order. */
  update(w: World): void {
    const tick = w.tick;
    const kos = this.pending.sort((a, b) => a.f.id - b.f.id);
    this.pending = [];
    for (const k of kos) {
      const f = k.f;
      if (!w.combat.fighters.includes(f)) continue;
      if (f.playerId !== null) {
        const respawnTick = tick + Math.round(WORLD_TUNING.respawnDelayS / DT);
        this.respawns.set(f.id, respawnTick);
        w.events.push({ type: 'death', f, respawnTick });
        continue;
      }
      this.dropParts(w, f, k.environmental, k.credit);
      if (!f.ruler) this.corpses.set(f.id, tick + Math.round(WORLD_TUNING.corpseDespawnS / DT));
    }

    for (const f of [...w.combat.fighters]) {
      const at = this.respawns.get(f.id);
      if (at !== undefined) {
        // Revived some other way (a dev respawn) or not KO'd any more: the death is over.
        if (f.state !== 'ko') this.respawns.delete(f.id);
        else if (tick >= at) {
          this.respawns.delete(f.id);
          this.respawn(w, f);
        }
      }
      const until = this.corpses.get(f.id);
      if (until !== undefined) {
        if (f.state !== 'ko') this.corpses.delete(f.id);
        else if (tick >= until && !playerNear(w, f)) {
          this.corpses.delete(f.id);
          w.removeFighter(f);
        }
      }
    }
    // Fighters that left the sim some other way (the spawner, a dev kill) take their timers with them.
    for (const id of [...this.respawns.keys()]) if (!w.combat.fighters.some((f) => f.id === id)) this.respawns.delete(id);
    for (const id of [...this.corpses.keys()]) if (!w.combat.fighters.some((f) => f.id === id)) this.corpses.delete(id);
  }

  /** (fighter, respawnTick), by fighter id. */
  deathsRecord(): { fighter: number; respawnTick: number }[] {
    return [...this.respawns].map(([fighter, respawnTick]) => ({ fighter, respawnTick })).sort((a, b) => a.fighter - b.fighter);
  }

  /** (fighter, removeTick), by fighter id. */
  corpsesRecord(): { fighter: number; removeTick: number }[] {
    return [...this.corpses].map(([fighter, removeTick]) => ({ fighter, removeTick })).sort((a, b) => a.fighter - b.fighter);
  }

  restoreRecord(deaths: { fighter: number; respawnTick: number }[], corpses: { fighter: number; removeTick: number }[]): void {
    this.pending = [];
    this.respawns.clear();
    this.corpses.clear();
    for (const d of deaths) this.respawns.set(d.fighter, d.respawnTick);
    for (const c of corpses) this.corpses.set(c.fighter, c.removeTick);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The species' parts around the hip (§4.14, D-30), credited with the KO's credit; a `parts` event. */
  private dropParts(w: World, f: Fighter, environmental: boolean, credit: string[]): void {
    const parts = f.species ? SPECIES_BODY[f.species].parts : [];
    const mul = environmental ? Math.round(IMPACT_TUNING.envKillPartsMul) : 1;
    const list: (typeof parts)[number][] = [];
    for (const p of parts) for (let i = 0; i < p.count * mul; i++) list.push(p);
    if (list.length === 0) return;
    const hip = w.downed.hip(f.id) ?? f.rig.pelvis.pos;
    const n = list.length;
    const r = IMPACT_TUNING.partsRingR * f.scale;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const x = hip.x + r * Math.cos(a);
      const z = hip.z + r * Math.sin(a);
      const ground = w.supportAt(x, z, hip.y);
      const part = list[i];
      const q = part.shape.kind === 'cylinder' || part.shape.kind === 'capsule' ? lyingAlong(a) : yawOnly(a);
      const e = w.entities.create(
        { material: part.material, shape: part.shape, p: { x, y: ground + IMPACT_TUNING.partsDropH, z }, q, look: part.material },
        credit,
      );
      ids.push(e.id);
    }
    w.events.push({ type: 'parts', victim: f.id, entities: ids, environmental });
  }

  /** The player back on its feet at the spawn (§4.14, D-33). */
  private respawn(w: World, f: Fighter): void {
    revive(f);
    w.teleport(f, WORLD_TUNING.spawnX, WORLD_TUNING.spawnZ);
    w.events.push({ type: 'respawn', f, at: { x: f.pos.x, y: f.pos.y, z: f.pos.z } });
  }
}

/**
 * A fighter back to full health (the respawn, §4.14): HP, poise, guard and stamina full; DungeonStyle's severed and
 * torn pieces, limb damage and cuts cleared; nothing buffered; at rest, idle.
 */
export function revive(f: Fighter): void {
  f.hp = f.stats.maxHp;
  f.poise = f.stats.maxPoise;
  f.guard = f.stats.maxGuard;
  f.stamina = 1;
  f.severed.clear();
  f.torn.clear();
  f.wounds.length = 0;
  for (const k of Object.keys(f.limbDamage) as (keyof typeof f.limbDamage)[]) delete f.limbDamage[k];
  f.lastKnock = null;
  f.buffer = null;
  f.counter = null;
  f.vel.set(0, 0, 0);
  f.walkVel.set(0, 0, 0);
  f.enterLocomotion();
}

/** Whether any player stands within corpseDespawnMinDistM of the corpse (horizontal distance). */
function playerNear(w: World, corpse: Fighter): boolean {
  const r = WORLD_TUNING.corpseDespawnMinDistM;
  for (const p of w.players.values()) {
    if (p === corpse) continue;
    if (Math.hypot(p.pos.x - corpse.pos.x, p.pos.z - corpse.pos.z) <= r) return true;
  }
  return false;
}

/** A rotation about +Y by the ring angle. */
function yawOnly(a: number): Quat {
  return { x: 0, y: Math.sin(-a / 2), z: 0, w: Math.cos(-a / 2) };
}

/** A prism lying flat (its +Y axis turned horizontal) along the ring's tangent at angle `a`. */
function lyingAlong(a: number): Quat {
  // Tilt +Y onto +X (about −Z), then turn about +Y so +X points along the tangent (−sin a, 0, cos a).
  const tilt = { x: 0, y: 0, z: -Math.sin(LIE_FLAT_TILT / 2), w: Math.cos(LIE_FLAT_TILT / 2) };
  const yaw = yawOnly(a + Math.PI / 2);
  return {
    x: yaw.w * tilt.x + yaw.x * tilt.w + yaw.y * tilt.z - yaw.z * tilt.y,
    y: yaw.w * tilt.y - yaw.x * tilt.z + yaw.y * tilt.w + yaw.z * tilt.x,
    z: yaw.w * tilt.z + yaw.x * tilt.y - yaw.y * tilt.x + yaw.z * tilt.w,
    w: yaw.w * tilt.w - yaw.x * tilt.x - yaw.y * tilt.y - yaw.z * tilt.z,
  };
}
