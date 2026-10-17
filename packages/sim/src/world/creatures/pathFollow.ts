// Path following (docs/M1-DESIGN.md §6.5): requests queued and served in (requestTick, fighterId) order, waypoints as
// positions with the versions of the tiles they cross, re-paths on goal moves, tile changes, schedule and stuck.
//
// STUB (P05; P19 fills it): the exported class with its state and final method signatures; the methods throw until P19.
import type { Fighter } from '../../sim/fighter';
import type { NavLayer } from '../nav';
import type { V3 } from '../types';
import type { World } from '../world';

export class PathFollower {
  readonly layer: NavLayer;
  points: V3[] = [];
  i = 0;
  goal: V3 | null = null;
  tiles: number[] = [];
  versions: number[] = [];
  requestTick = -1;
  pending = false;

  constructor(layer: NavLayer) {
    this.layer = layer;
  }

  /** Queue a path request to `goal` (served in phase 2, at most navQueriesPerTick per tick). */
  request(w: World, self: Fighter, goal: V3): void {
    notImplemented('request', w, self, goal);
  }

  /** The current corner to steer at, or null when there is no path or it is finished. */
  corner(w: World, self: Fighter): V3 | null {
    return notImplemented('corner', w, self);
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/creatures/pathFollow.ts: PathFollower.${name} is not implemented yet (P19; called with ${args.length} arguments)`);
}
