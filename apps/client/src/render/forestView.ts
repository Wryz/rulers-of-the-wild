// Trees on screen (docs/M1-DESIGN.md §10.4): instanced trunks (unit 8-gon prisms, like the collider) and canopies,
// saplings; a tree leaving `standing` gets its own mesh with the notch wedge cut to 1 − remaining on the cut side; a chop
// shudders it; a falling or felled crown is drawn collapsed (rule 3, RR-15); all through applyCutout.
//
// STUB (P31; P32 fills it): the final exported name. Until P32 (and P21's Clearing) no tree is drawn.
import type { Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';

export class ForestView {
  constructor(_scene: Scene) {}

  sync(_world: World, _alpha: number, _cam: Vector3): void {}

  dispose(): void {}
}
