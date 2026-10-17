// Throw (docs/M1-DESIGN.md §5.11): objects ≤ 2 kg fly as DS projectiles, heavier ones leave the hands as Rapier bodies;
// every throw is capped at 400 J (launchSpeed); releasedBy on throw. The world calls only `throwRelease`.
//
// STUB (P05; P17 fills it): until P17 every throw is DungeonStyle's projectile.
import type { Fighter } from '../../sim/fighter';
import type { MoveDef } from '../../sim/moves';
import type { World } from '../world';

/** WorldPort.throwRelease: true when a big object was launched as a Rapier body (no DS projectile). */
export function throwRelease(_w: World, _f: Fighter, _m: MoveDef): boolean {
  return false;
}
