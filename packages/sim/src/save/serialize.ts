// The world serialiser (docs/M1-DESIGN.md §1.5.11, §8.3): saveRecord assembles SaveV1 from every system's toRecord()
// in id order; serializeWorld is the UTF-8 of its canonical JSON (World.step phase 19 calls it when a save is due).
//
// STUB (P05; P13 fills it): final exported signatures; both throw until P13.
import type { World } from '../world/world';
import type { SaveV1 } from './schema';

export function saveRecord(w: World): SaveV1 {
  return notImplemented('saveRecord', w);
}

/** UTF-8 of canonicalJson(saveRecord(w)). */
export function serializeWorld(w: World): Uint8Array {
  return notImplemented('serializeWorld', w);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`save/serialize.ts: ${name} is not implemented yet (P13; called with ${args.length} arguments)`);
}
