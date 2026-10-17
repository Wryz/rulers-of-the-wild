// The partial loader and the migration ladder (docs/M1-DESIGN.md §1.5.11, §8.3): loadWorld regenerates from the seed,
// applies terrain and cover edits, restores entities, joints, rulers, counters, RNG states and fighters' core state.
//
// STUB (P05; P13 fills it): final exported signatures; both throw (loadWorld rejects) until P13.
import type { World } from '../world/world';
import type { SaveV1 } from './schema';

/**
 * applyTuning (default false): restore the save's tuningOverrides into the process-wide registry (RR-17).
 */
export async function loadWorld(bytes: Uint8Array, opts?: { nav?: 'full' | 'off'; applyTuning?: boolean }): Promise<World> {
  return notImplemented('loadWorld', bytes, opts);
}

/** The version ladder; v1 is the identity. */
export function migrate(rec: unknown): SaveV1 {
  return notImplemented('migrate', rec);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`save/load.ts: ${name} is not implemented yet (P13; called with ${args.length} arguments)`);
}
