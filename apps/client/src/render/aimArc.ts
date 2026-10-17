// The throw arc (docs/M1-DESIGN.md §10.7): VERB_UI_TUNING.arcPoints points of the sim's own throw (v = launchSpeed(m,
// techSpeed) × charge, g 9.81) and a landing ring.
//
// STUB (P31; P35 fills it): the final exported name. Until P35 there is no throw aim.
import type { Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';

export class AimArc {
  constructor(_scene: Scene) {}

  /** Draws the arc from `from` along `dir` at `speed` m/s (null hides it). */
  show(_world: World, _from: Vector3 | null, _dir: Vector3 | null, _speed: number): void {}

  dispose(): void {}
}
