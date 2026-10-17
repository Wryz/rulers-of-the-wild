// Awareness markers (docs/M1-DESIGN.md §10.8): `?` and `!` over creatures within VERB_UI_TUNING.markerRangeM, from
// world.minds.view(f) (read-only).
//
// STUB (P31; P36 fills it): the final exported name. Until P36 no marker is shown.
import type { Camera } from 'three';
import type { Fighter, World } from '@wild/sim';

export class AwarenessMarkers {
  constructor(_root: HTMLElement) {}

  update(_world: World, _player: Fighter | null, _camera: Camera): void {}

  dispose(): void {}
}
