// Hands, belt and back (docs/M1-DESIGN.md §5.1, §2.12): take, drop, stow, draw, carry, drag, forced release, credit.
// Its own API is internal to the verb package (index.ts calls it); the world calls only `weaponDropped`.
//
// STUB (P05; P14 fills it): until P14 a weapon a fighter lets go of is DungeonStyle's drop.
import type { Fighter } from '../../sim/fighter';
import type { World } from '../world';

/** WorldPort.onWeaponDropped: true when the dropped weapon was an entity and became one again (no DS drop). */
export function weaponDropped(_w: World, _f: Fighter): boolean {
  return false;
}
