// The target highlight (docs/M1-DESIGN.md §10.7): an emissive back-face shell (VERB_UI_TUNING.highlightScale) on the
// focused target, a second colour for the first target of a two-target verb, and a world-anchored prompt
// ("G take · V verbs", "too heavy (300 kg)").
//
// STUB (P31; P35 fills it): the final exported name. Until P35 nothing is highlighted.
import type { Camera, Scene } from 'three';
import type { World } from '@wild/sim';
import type { TargetRef } from '../input/verbInput';

export class Highlight {
  constructor(_scene: Scene) {}

  /** Outlines `target` (and `first`, the first target of a two-target verb); null clears. */
  show(_world: World, _target: TargetRef | null, _first: TargetRef | null, _camera: Camera): void {}

  dispose(): void {}
}
