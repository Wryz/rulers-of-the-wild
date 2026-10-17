// Ground cover (docs/M1-DESIGN.md §6.7): a grid of 2 m cells (0..255 → 0..1) read by perception ("crouching in
// undergrowth hides", SPEC:754) and the grass renderer; digging clears a cell; edits are saved.
//
// STUB (P05; P21 fills it): final exported signatures. Until P21 there is no cover anywhere (at() is 0) and set() throws.

export class GroundCover {
  /** Cover 0..1 at (x, z). */
  at(_x: number, _z: number): number {
    return 0;
  }

  set(x: number, z: number, v: number): void {
    throw new Error(`world/cover.ts: GroundCover.set is not implemented yet (P21; ${x}, ${z} → ${v})`);
  }

  /** (cell, value) edits against the generated cover, sorted (the save's `cover`). */
  edits(): [number, number][] {
    return [];
  }

  /** Applies saved edits over the generated cover (the loader). */
  applyEdits(edits: readonly (readonly [number, number])[]): void {
    if (edits.length > 0) throw new Error('world/cover.ts: GroundCover.applyEdits is not implemented yet (P21)');
  }
}
