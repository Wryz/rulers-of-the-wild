// Developer operations (docs/M1-DESIGN.md §1.3, §1.5.3, §3 phase 1c, §10.10; RF-19, RR-17; package P22): every
// `meta 'dev'` command is applied here in phase 1c of its tick, so the command log replays dev actions exactly (rule 7):
// a dev op changes the world at its own tick, before the minds (phase 2) and CombatSim (phase 3) of that tick run.
//
// The encoding of `dev.args` (all integers, like every command field but a setTuning value; points in whole cm, like
// verb commands; "the command's player" is the fighter of `cmd.player`, World.players):
//
// | op            | args                         | effect                                                                 |
// |---------------|------------------------------|------------------------------------------------------------------------|
// | spawnApe      | [xCm, zCm]                   | an ape (createCreature) standing at (x, z), facing the command's player |
// | spawnGiant    | [] or [xCm, zCm]             | the giant ape at the spawn data's lair (Spawner's spawnGiantAtLair), or |
// |               |                              | standing at (x, z) facing the command's player                         |
// | giveTool      | [tool]                       | GIVE_TOOLS[tool] made by the factory at the player's feet and put in its |
// |               |                              | hands (VerbSystem.putInHands, whatever they held let go of first)       |
// | teleport      | [xCm, zCm] or [xCm, zCm, id] | the command's player (or fighter `id`) moved to (x, z) by World.teleport |
// |               |                              | (pose history reset and a contact grace, §4.3; a downed body's slab)    |
// | pauseMinds    | [on] or [on, id]             | every creature mind (or fighter `id`'s) paused (on 1) or resumed (on 0) |
// | killCreature  | [id]                         | creature `id` knocked out (CombatSim.koFighter): parts, its corpse and  |
// |               |                              | its respawn follow as for any KO                                       |
// | respawnPlayer | []                           | the command's player revived and moved to the spawn, as Deaths does it  |
// | setTuning     | [] and `tuning`              | registry.setTuningValue(table, key, value)                             |
//
// A malformed command (an unknown op, the wrong number of arguments, a non-integer, an unknown tool, setTuning without
// its edit, a bad tuning key) throws, naming the tick and the op: the dev panel never sends one, and a command log
// that holds one is broken. A well-formed op that has nothing to act on this tick (no such fighter any more, no
// player, no lair, a target that isn't a creature, a player who is down for giveTool) does nothing, the same in every
// run: what was there when the button was pressed may have changed by the tick the command lands.
//
// DEVIATION (§13.0 "A tuning table is never added after P05; new keys go into the owning module's table"): giveTool's
// spear and vine lengths are starting values no table holds (§5.2's 1.9 m spear, §10.10's 12 m vine), and P05's stub of
// this module registered no table, so they live in DEV_OPS_TUNING here (CLAUDE.md: every starting value in a live
// tuning table). The stone axe and the digging stick are made exactly as the starter cache makes them
// (FACTORY_TUNING.starterAxe, CLEARING_TUNING.diggingStick).
// INTERPRETATION (§10.10 "kill the target"): a dev kill knocks the creature out through koFighter, CombatSim's only way
// into 'ko', with no killer and no cause (credit nobody, never environmental), and leaves its HP alone: HP is written
// only by the damage rule's sites (rule 2, tests/damageRule.test.ts), and a dev kill is not damage.
import type { MetaCommand } from '../sim/commands';
import type { Fighter } from '../sim/fighter';
import { PHYSICS_TUNING } from './physics';
import { defineTuning, setTuningValue } from '../tuning/registry';
import { CLEARING_TUNING } from './clearing';
import { spawnGiantAtLair } from './creatures/spawner';
import { revive } from './deaths';
import { groundRestY, LYING_ALONG_X, prismRForRoundDiam, ropeCoilShape, spawnRopeCoil, spawnStarterAxe, spawnStick, stickPrism } from './factory';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

/** giveTool's starting values (§5.2, §10.10). */
export const DEV_OPS_TUNING = defineTuning(
  'DEV_OPS_TUNING',
  'World › dev ops',
  {
    spear: { lengthM: 1.9, roundDiamM: 0.05, sharpness: 0.6 },
    vineM: 12,
  },
  {
    spear: {
      lengthM: { unit: 'm', source: "NEW: §5.2's measured spear (1.9 m; a point at an end and ≥ 1.6 m is a spear)", min: 1.6, max: 2.6, step: 0.05 },
      roundDiamM: { unit: 'm', source: "NEW: the digging stick's 5 cm (§6.7), as the 8-gon of that round section", min: 0.02, max: 0.1, step: 0.005 },
      sharpness: { unit: '—', source: 'NEW: a wood point (TOOL_TUNING.refSharpness of the point classes, §5.2)', min: 0.1, max: 1, step: 0.05 },
    },
    vineM: { unit: 'm', source: '§10.10 ("give a tool (stone axe, digging stick, spear, 12 m vine)")', min: 1, max: 30, step: 0.5 },
  },
);

/** giveTool's first argument indexes this list (the dev panel's "Give" buttons, §10.10). */
export const GIVE_TOOLS = ['stoneAxe', 'diggingStick', 'spear', 'vine'] as const;
export type GiveTool = (typeof GIVE_TOOLS)[number];

/** Applies one `meta 'dev'` command now (phase 1c). Throws on a malformed one (see the table above). */
export function applyDevOp(w: World, cmd: MetaCommand): void {
  const dev = cmd.dev;
  if (cmd.meta !== 'dev' || !dev) throw new Error(`applyDevOp: tick ${cmd.tick}: not a dev command`);
  const args = dev.args;
  const bad = (why: string): Error => new Error(`applyDevOp: tick ${cmd.tick}: ${dev.op} ${JSON.stringify(args)}: ${why}`);
  const arity = (...counts: number[]): void => {
    if (!counts.includes(args.length)) throw bad(`takes ${counts.join(' or ')} arguments`);
    for (const a of args) if (!Number.isInteger(a)) throw bad('every argument is an integer');
  };
  const at = (): { x: number; z: number } => ({ x: args[0] / CM, z: args[1] / CM });
  const player = w.players.get(cmd.player) ?? null;
  const fighter = (id: number): Fighter | null => w.combat.fighters.find((f) => f.id === id) ?? null;

  switch (dev.op) {
    case 'setTuning': {
      const t = dev.tuning;
      if (!t) throw bad('setTuning without a tuning edit');
      setTuningValue(t.table, t.key, t.value);
      return;
    }
    case 'spawnApe': {
      arity(2);
      const p = at();
      w.spawnCreature('ape', p, facing(p, player));
      return;
    }
    case 'spawnGiant': {
      arity(0, 2);
      if (args.length === 0) spawnGiantAtLair(w, w.spawner.data);
      else {
        const p = at();
        w.spawnCreature('giantApe', p, facing(p, player));
      }
      return;
    }
    case 'giveTool': {
      arity(1);
      const tool = GIVE_TOOLS[args[0]];
      if (tool === undefined) throw bad(`no tool ${args[0]} (0..${GIVE_TOOLS.length - 1}: ${GIVE_TOOLS.join(', ')})`);
      if (!player?.inventory || isDown(player)) return;
      w.verbs.putInHands(player, makeTool(w, tool, player.pos.x, player.pos.z));
      return;
    }
    case 'teleport': {
      arity(2, 3);
      const f = args.length === 3 ? fighter(args[2]) : player;
      if (!f) return;
      const p = at();
      w.teleport(f, p.x, p.z);
      return;
    }
    case 'pauseMinds': {
      arity(1, 2);
      if (args[0] !== 0 && args[0] !== 1) throw bad('on is 1 (pause) or 0 (resume)');
      const on = args[0] === 1;
      if (args.length === 2) {
        const f = fighter(args[1]);
        const m = f ? w.minds.get(f) : null;
        if (m) m.paused = on;
        return;
      }
      for (const m of w.minds.all()) m.paused = on;
      return;
    }
    case 'killCreature': {
      arity(1);
      const f = fighter(args[0]);
      if (!f || f.playerId !== null || !f.alive) return;
      w.combat.koFighter(f, { by: 'impact', killer: null, cause: null, point: { x: f.pos.x, y: f.pos.y, z: f.pos.z } });
      return;
    }
    case 'respawnPlayer': {
      arity(0);
      if (!player) return;
      // As Deaths' respawn (§4.14): revived, at the spawn (D-33); a slab hands back to the controller in phase 4a.
      // Deaths drops a pending death of a fighter that isn't out any more.
      revive(player);
      w.teleport(player, WORLD_TUNING.spawnX, WORLD_TUNING.spawnZ);
      w.events.push({ type: 'respawn', f: player, at: { x: player.pos.x, y: player.pos.y, z: player.pos.z } });
      return;
    }
    default:
      throw bad('unknown dev op');
  }
}

/** Whole cm per m (command points are in whole cm, §1.5.3). */
const CM = 100;

/** The yaw at `p` that faces `toward` (the fighter yaw convention: sin yaw along x, cos yaw along z); 0 with none. */
function facing(p: { x: number; z: number }, toward: Fighter | null): number {
  return toward ? Math.atan2(toward.pos.x - p.x, toward.pos.z - p.z) : 0;
}

/** Down on the ground (knocked down, out, tripped, getting up): hands take nothing. */
function isDown(f: Fighter): boolean {
  return f.state === 'knockdown' || f.state === 'ko' || f.state === 'tripped' || f.state === 'getup';
}

/**
 * The tool, made by the factory as the world makes it, lying on the terrain at (x, z); returns the entity the hands
 * take (the axe's handle, which carries its lashed head). Credit: none until a hand takes it (verbs credit the taker).
 */
function makeTool(w: World, tool: GiveTool, x: number, z: number): number {
  const ground = w.terrain.heightAt(x, z);
  switch (tool) {
    case 'stoneAxe':
      return spawnStarterAxe(w, { x, y: ground, z }).stick;
    case 'diggingStick': {
      const D = CLEARING_TUNING.diggingStick;
      return pointedStick(w, x, z, D.lengthM, D.diamM, D.sharpness);
    }
    case 'spear': {
      const S = DEV_OPS_TUNING.spear;
      return pointedStick(w, x, z, S.lengthM, S.roundDiamM, S.sharpness);
    }
    case 'vine': {
      const lengthM = DEV_OPS_TUNING.vineM;
      const coil = ropeCoilShape(lengthM);
      const y = groundRestY(w, x, z, coil);
      return spawnRopeCoil(w, { at: { x, y: y - coil.halfHeight, z }, material: 'vine', lengthM });
    }
  }
}

/** A dry stick of round section `roundDiamM` (as its 8-gon), pointed at one end, lying along x on the terrain. */
function pointedStick(w: World, x: number, z: number, lengthM: number, roundDiamM: number, sharpness: number): number {
  const r = prismRForRoundDiam(roundDiamM, PHYSICS_TUNING.cylinderFacets);
  const y = groundRestY(w, x, z, stickPrism(lengthM, r), LYING_ALONG_X);
  return spawnStick(w, { p: { x, y, z }, length: lengthM, r, sharp: { end: 1, s: sharpness } });
}
