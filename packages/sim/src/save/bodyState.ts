// The AC-7 body bytes (docs/M1-DESIGN.md §8.2): the raw f32 bits of every Rapier body's translation, rotation, linvel
// and angvel in owner order, the rope sensors' poses, then the f64 bits of every fighter's core state and rig, then
// combat.rng.state.
//
// STUB (P05; P13 fills it): final exported signature; throws until P13.
import type { World } from '../world/world';

export function bodyStateBytes(w: World): Uint8Array {
  throw new Error(`save/bodyState.ts: bodyStateBytes is not implemented yet (P13; world tick ${w.tick})`);
}
