// The giant ape's mind (docs/M1-DESIGN.md §6.4): patrol, investigate, chase, the telegraphed, committed straight-line
// charge (8°/s turn), recover, down (and the climb out of a pit), severe-wound effects, deflection adoption.
//
// STUB (P05; P20 fills it): final exported signatures; decide() and chargeLineClear throw until P20.
// TODO "jaw weakens bite attacks": weakJaw only quiets the roar in M1 (§12.4).
import type { V3 } from '../types';
import type { World } from '../world';
import { CreatureMind } from './mind';

export class RulerMind extends CreatureMind {
  /** The committed heading (rad, the fighter yaw convention); saved in MindRecV1. */
  heading = 0;

  decide(w: World): void {
    throw new Error(`world/creatures/rulerMind.ts: RulerMind.decide is not implemented yet (P20; world tick ${w.tick})`);
  }
}

/** A ball of radius probeRadiusM cast at probeHeightFrac × the pelvis height from `from` to `to` meets no blocker (§6.4). */
export function chargeLineClear(w: World, from: V3, to: V3): boolean {
  throw new Error(`world/creatures/rulerMind.ts: chargeLineClear is not implemented yet (P20; tick ${w.tick}, ${from.x},${from.z} → ${to.x},${to.z})`);
}
