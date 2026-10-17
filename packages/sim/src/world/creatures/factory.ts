// Creatures (docs/M1-DESIGN.md §6.3, §6.4): createCreature builds the ape (scale 1.1, 97.56 kg) or the giant ape
// (scale 5.5, 14 t, a RulerState) with world-owned ids and RNG streams, its mind, and adds it to the world (its bodies
// made by World.addFighter), standing on what supports it at (x, z) and facing `yaw` (World.teleport).
//
// - The ape (§6.3): `new Fighter('enemy', 'Ape', ENEMY_MOVES, { maxHp, walkSpeed, staggerResist, defense }, Bruiser's
//   style, { ids: world.ids.fighter, rngSeed: seedFor(seed, 'fighter', id) })`, scale, autoDefense, readSkill, massKg,
//   hide toughness and species from SPECIES_BODY.ape and CREATURE_TUNING.ape (read when it is made: per-creature state);
//   an ApeMind. Not an ARCHETYPES entry (styles.test.ts forbids two identical repertoires); the archetype's own HP and
//   walk speed are not taken (D-21).
// - The giant ape (§6.4): scale, 14,000 kg, 12,000 HP and species from SPECIES_BODY.giantApe, `ruler =
//   newRulerState(maxHp)`, team enemy, autoDefense false, no BrawlerAI; a RulerMind with cfg.passive (rulers never
//   block, §6.1) on the ruler layer, and a standing drive along its yaw (the mind turns and speeds it).
// The loader makes a saved creature through here with its saved id (save/load.ts), then restores its records.
import { DEFAULT_AI } from '../../sim/ai';
import { ARCHETYPES } from '../../sim/enemies';
import { Fighter } from '../../sim/fighter';
import { ENEMY_MOVES } from '../../sim/moves';
import { newRulerState } from '../../sim/ruler';
import { SPECIES_BODY } from '../../sim/species';
import type { World } from '../world';
import { ApeMind } from './apeMind';
import { CREATURE_TUNING } from './defs';
import { RulerMind } from './rulerMind';

export function createCreature(w: World, kind: 'ape' | 'giantApe', at: { x: number; z: number }, yaw: number): Fighter {
  const ids = w.ids.fighter;
  const opts = { ids, rngSeed: w.rngs.fighterSeed(ids.next) };
  const bruiser = ARCHETYPES.bruiser;
  let f: Fighter;
  if (kind === 'ape') {
    const S = SPECIES_BODY.ape;
    const A = CREATURE_TUNING.ape;
    f = new Fighter('enemy', 'Ape', ENEMY_MOVES, { maxHp: S.maxHp, walkSpeed: A.walkSpeed, staggerResist: A.staggerResist, defense: S.defense }, bruiser.style, opts);
    f.scale = S.scale;
    f.autoDefense = true;
    f.readSkill = A.readSkill;
    f.massKg = S.massKg;
    f.toughnessJ = S.toughnessJ;
    f.species = 'ape';
  } else {
    const S = SPECIES_BODY.giantApe;
    f = new Fighter('enemy', 'Giant ape', ENEMY_MOVES, { maxHp: S.maxHp, defense: S.defense }, bruiser.style, opts);
    f.scale = S.scale;
    f.autoDefense = false;
    f.massKg = S.massKg;
    f.species = 'giantApe';
    f.ruler = newRulerState(S.maxHp);
    f.drive = { heading: yaw, speed: 0, accel: CREATURE_TUNING.giant.brake, climb: false };
  }
  f.pos.set(at.x, w.terrain.heightAt(at.x, at.z), at.z);
  f.yaw = yaw;
  const mind = kind === 'ape' ? new ApeMind(w, f) : new RulerMind(w, f, { ...DEFAULT_AI, passive: true }, 'ruler');
  w.addFighter(f, mind);
  w.teleport(f, at.x, at.z, yaw);
  // Home is where it stood once standing (the spawner sets its own: CreatureMind.setHome).
  mind.setHome({ x: f.pos.x, z: f.pos.z });
  return f;
}
