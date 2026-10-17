// Entities on screen (docs/M1-DESIGN.md §10.4): one InstancedMesh per (look, shape prototype), matrices interpolated
// prevPose → pose by alpha; held and stowed items at the hand, belt and back; colour by material; sharp points; cross-cut
// notches; integrity cracks and sag; a strained prop bends and creaks (rule 3).
//
// STUB (P31; P32 fills it): the final exported name. Until P32 no entity is drawn.
import type { Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';

export class EntityViews {
  constructor(_scene: Scene) {}

  sync(_world: World, _alpha: number, _cam: Vector3): void {}

  dispose(): void {}
}
