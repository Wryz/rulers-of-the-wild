// Ropes on screen (docs/M1-DESIGN.md §10.4): per world.joints.view() entry a 6-sided tube between its anchors; slack
// ropes sag, taut ones straighten and thin, strain over RENDER_TUNING.ropeFrayFrac frays and reddens (SPEC:357-358).
//
// STUB (P31; P32 fills it): the final exported name. Until P32 no rope is drawn.
import type { Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';

export class RopeViews {
  constructor(_scene: Scene) {}

  sync(_world: World, _alpha: number, _cam: Vector3): void {}

  dispose(): void {}
}
