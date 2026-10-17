// The noise bus (docs/M1-DESIGN.md §6.2, §3 phase 17b): collect turns the tick's combat and world events, and every
// moving fighter's footsteps, into noises; fold adds them to every mind's awareness and calls onHurt/onWound; the bus is
// empty at the end of the tick (so a save never holds pending noise).
//
// STUB (P05; P18 fills it): final exported signatures. Until P18 nothing is heard.
import type { CombatEvent } from '../../sim/combat';
import type { NoiseKind, V3, WorldEvent } from '../types';
import type { World } from '../world';
import type { MindRegistry } from './mind';

/** A sound a creature may hear: just audible at `radius` × the listener's hearingMul. */
export interface Noise {
  at: V3;
  radius: number;
  kind: NoiseKind;
  /** The fighter that made it (it doesn't hear itself), or null. */
  source: number | null;
}

export class NoiseBus {
  emit(_n: Noise): void {}

  /** Phase 17b: noises from this tick's events and footsteps. */
  collect(_w: World, _ce: readonly CombatEvent[], _we: readonly WorldEvent[]): void {}

  /** Phase 17b: awareness, onHurt and onWound, in event order; empties the bus. */
  fold(_m: MindRegistry): void {}
}
