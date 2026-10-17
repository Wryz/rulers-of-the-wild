// The compass (docs/M1-DESIGN.md §10.8): a 180° strip at the top centre with N/E/S/W, a ping for the spawn point, and a
// ping where the player last saw the giant (inside the frustum, within VERB_UI_TUNING.compassSeeRangeM, a clear terrain
// line), fading after compassPingS.
//
// STUB (P31; P36 fills it): the final exported name. Until P36 there is no compass.
import type { Camera } from 'three';
import type { Fighter, World } from '@wild/sim';

export class Compass {
  constructor(_root: HTMLElement) {}

  update(_world: World, _player: Fighter | null, _camera: Camera, _dt: number): void {}

  dispose(): void {}
}
