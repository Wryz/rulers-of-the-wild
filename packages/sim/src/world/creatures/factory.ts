// Creatures (docs/M1-DESIGN.md §6.3, §6.4): createCreature builds the ape (scale 1.1, 97.56 kg) or the giant ape
// (scale 5.5, 14 t, a RulerState) with world-owned ids and RNG streams, its mind, and adds it to the world.
//
// STUB (P05; P19 fills it): the final exported signature; throws until P19.
import type { Fighter } from '../../sim/fighter';
import type { World } from '../world';

export function createCreature(w: World, kind: 'ape' | 'giantApe', at: { x: number; z: number }, yaw: number): Fighter {
  throw new Error(`world/creatures/factory.ts: createCreature is not implemented yet (P19; ${kind} at ${at.x}, ${at.z}, yaw ${yaw}, tick ${w.tick})`);
}
