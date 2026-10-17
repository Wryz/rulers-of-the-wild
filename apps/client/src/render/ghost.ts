// The placement ghost (docs/M1-DESIGN.md §10.7, §5.7): a translucent copy of what is carried at the aim point within
// reach, rotated by the wheel, lying / upright / sloped (leaning from its lower end onto the highest support under its
// upper half), green when the client's estimate fits, red otherwise.
//
// STUB (P31; P35 fills it): the final exported name. Until P35 there is no place mode.
import type { Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';

export type PlaceOrientation = 'lying' | 'upright' | 'sloped';

export class Ghost {
  constructor(_scene: Scene) {}

  /** Shows the ghost of `entity` at `at` (null hides it); returns whether the client's estimate says it fits. */
  show(_world: World, _entity: number | null, _at: Vector3 | null, _yawDeg: number, _orientation: PlaceOrientation): boolean {
    return false;
  }

  dispose(): void {}
}
