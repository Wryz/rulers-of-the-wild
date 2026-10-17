// Client-side targeting (docs/M1-DESIGN.md §10.7, SPEC:406): candidates are entity views whose surface is within reach of
// the player's chest, plus rope views; the best is the smallest angle to the camera's centre ray inside
// VERB_UI_TUNING.targetConeDeg (fightTargetConeDeg in the fight camera); Tab / Shift+Tab / D-pad cycle them; no entity
// and terrain within reach → a ground target. Computed from what is drawn; the sim re-validates every command.
//
// STUB (P31; P35 fills it): the final exported names. Until P35 nothing is ever targeted.
import type { Vector3 } from 'three';
import type { Fighter, World } from '@wild/sim';
import type { TargetRef } from './verbInput';

/** The ray the player aims along: the camera's centre ray (follow camera) or the player's facing (fight camera). */
export interface AimRay {
  origin: Vector3;
  dir: Vector3;
  /** True in the fight camera (the wider cone). */
  fight: boolean;
}

export class Targeting {
  /** The best target this frame (null: nothing in reach). */
  pick(_world: World, _player: Fighter, _ray: AimRay): TargetRef | null {
    return null;
  }

  /** Tab / Shift+Tab: the next or previous candidate in score order. */
  cycle(_step: 1 | -1): TargetRef | null {
    return null;
  }
}
