// Ground cover on screen (docs/M1-DESIGN.md §10.4): one InstancedMesh of crossed-quad tufts from the cover grid within
// RENDER_TUNING.grassRadiusM, at most grassPerCell per cell; dry grass pale, dug cells bare.
//
// STUB (P31; P32 fills it): the final exported name. Until P32 no grass is drawn.
import type { Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';

export class GrassView {
  constructor(_scene: Scene) {}

  sync(_world: World, _cam: Vector3): void {}

  dispose(): void {}
}
