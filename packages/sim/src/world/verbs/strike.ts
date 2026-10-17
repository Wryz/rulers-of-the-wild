// Strikes on the world (docs/M1-DESIGN.md §5.2, §5.10): WorldPort.strike (an unmatched swing meets a tree, rope,
// entity or the ground: chop, cross-cut, sever, push, dig or clang), projectile world hits and landings.
//
// STUB (P05; P15 fills it): until P15 a swing that hits no fighter meets nothing, and a weapon in flight flies and lands
// as in DungeonStyle.
import type { Vector3 } from 'three';
import type { Fighter } from '../../sim/fighter';
import type { Projectile } from '../../sim/projectiles';
import type { WeaponDef } from '../../sim/weapons';
import type { ProjectileWorldHit, WorldStrike } from '../types';
import type { World } from '../world';

/** WorldPort.strike: the swing's blade samples this tick (and last tick) against the world; null when it meets nothing. */
export function worldStrike(
  _w: World,
  _a: Fighter,
  _prev: readonly Vector3[] | null,
  _pts: readonly Vector3[],
  _offs: readonly number[],
  _weapon: WeaponDef | null,
): WorldStrike | null {
  return null;
}

/** WorldPort.projectile: one flight segment cast against entities and terrain. */
export function projectileHit(_w: World, _p: Projectile, _from: Vector3, _to: Vector3): ProjectileWorldHit | null {
  return null;
}

/** WorldPort.onProjectileLanded: true when it became an entity again (no DS drop). */
export function projectileLanded(_w: World, _p: Projectile): boolean {
  return false;
}
