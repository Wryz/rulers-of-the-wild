// Senses (docs/M1-DESIGN.md §6.2): sight (cone, range, crouch and cover, occlusion by terrain and heavy entities),
// hearing, awareness per target, the last known position and memory.
//
// STUB (P05; P18 fills it): the exported class with its state and final method signatures; the methods throw until P18.
import type { Fighter } from '../../sim/fighter';
import type { V3 } from '../types';
import type { World } from '../world';
import type { Noise } from './noise';

export class Senses {
  /** Target fighter id → awareness 0..awarenessCap. */
  readonly awareness = new Map<number, number>();
  /** Last known position of the strongest stimulus. */
  lkp: V3 | null = null;
  lkpTick = -1;
  lastSeenTick = -1;

  /** One sensed tick (Δt = DT near the player, 1 s far away): sight of every target, then decay. */
  sight(w: World, self: Fighter, dt: number): void {
    notImplemented('sight', w, self, dt);
  }

  /** A noise this creature hears (phase 17b). */
  hear(n: Noise, self: Fighter): void {
    notImplemented('hear', n, self);
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/creatures/perception.ts: Senses.${name} is not implemented yet (P18; called with ${args.length} arguments)`);
}
