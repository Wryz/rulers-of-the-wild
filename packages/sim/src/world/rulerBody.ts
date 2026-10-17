// The ruler's hybrid body (docs/M1-DESIGN.md §1.5.8, §4.7): one Rapier body for life, kinematic with 12 sensor bone
// colliders standing and dynamic with solid colliders when tripped; RulerMover (support, slope and step limits, climb,
// shove, block, deflect, trip, ledge, cover), the trip switch, the tripped rig, in-pit, pinned and the get-up.
//
// STUB (P05; P11 fills it): final exported signatures and RULER_BODY_TUNING with its §9 values. Until P11 no ruler
// exists (creatures are created by P19); every call does nothing and the mover leaves the proposal as it is.
import type { RulerBodyRecV1 } from '../save/schema';
import type { Fighter } from '../sim/fighter';
import { defineTuning } from '../tuning/registry';
import type { FighterMover, ImpactCause, TripWhy } from './types';
import type { World } from './world';

export const RULER_BODY_TUNING = defineTuning(
  'RULER_BODY_TUNING',
  'Ruler › body',
  {
    tripSpeed: 4,
    getupAfterS: 4,
    shoveLimitKg: 500,
    deflectMaxDeg: 30,
    impactTripMinKg: 500,
    sweepSkinM: 0.05,
    ledgeTripDropFrac: 0.5,
    getupFrames: 94,
    getupKneelFrame: 52,
    trippedLinDamp: 0.1,
    trippedAngDamp: 1,
    trippedExtraIters: 4,
    tripPose: 'freeze' as 'freeze',
    friction: 0.9,
    restitution: 0.05,
    stepUpMaxM: 1.0,
    maxSlopeDeg: 40,
    climbRateMps: 0.4,
    climbWalkMps: 0.5,
    climbMaxM: 4.5,
    pitDownDepthFrac: 0.5,
    coverTripWindowTicks: 30,
  },
  {
    tripSpeed: { unit: 'm/s (root horizontal)', source: 'SPEC:782, 879; D-10' },
    getupAfterS: { unit: 's', source: 'SPEC:782, 879' },
    shoveLimitKg: { unit: 'kg', source: 'SPEC:781, 880' },
    deflectMaxDeg: { unit: '°', source: 'SPEC:781' },
    impactTripMinKg: { unit: 'kg', source: 'SPEC:879 (blocking class)' },
    sweepSkinM: { unit: 'm', source: 'NEW' },
    ledgeTripDropFrac: { unit: '× knee height (1.4 m)', source: 'NEW: D-9 (e)' },
    getupFrames: { unit: 'frames', source: 'NEW: 40·√5.5, MAP gap-3 §2.3' },
    getupKneelFrame: { unit: 'frame', source: 'NEW: DS 0.55 of the track' },
    trippedLinDamp: { unit: '1/s', source: 'NEW: orchestrator decision 5, MAP gap-3' },
    trippedAngDamp: { unit: '1/s', source: 'NEW: orchestrator decision 5' },
    trippedExtraIters: { unit: 'iterations', source: 'NEW: MAP gap-3' },
    tripPose: { unit: '—', source: 'NEW: MAP gap-3', options: ['freeze'] },
    friction: { unit: '—', source: 'NEW' },
    restitution: { unit: '—', source: 'NEW' },
    stepUpMaxM: { unit: 'm per tick', source: "NEW: the ruler nav layer's climb (RR-1, RF-14)" },
    maxSlopeDeg: { unit: '°', source: "NEW: the ruler nav layer's slope (RR-1)" },
    climbRateMps: { unit: 'm/s', source: 'NEW: climbing out of a pit (3 m max dig + 1 m berm < 4.5 m) (RR-1)' },
    climbWalkMps: { unit: 'm/s', source: 'NEW: climbing out of a pit (RR-1)' },
    climbMaxM: { unit: 'm', source: 'NEW: climbing out of a pit (3 m max dig + 1 m berm < 4.5 m) (RR-1)' },
    pitDownDepthFrac: { unit: '× knee height (1.4 m)', source: 'NEW: "in a pit" (SPEC:504), the ledge threshold (RR-1)' },
    coverTripWindowTicks: { unit: 'ticks', source: "NEW: a ledge trip this soon after a cover load break is a 'cover' trip (RT-1)" },
  },
);

export class RulerBodies {
  readonly world: World;
  /** RulerMover: CombatSim's mover for a standing ruler (§4.7). */
  readonly mover: FighterMover = { resolve: () => {} };

  constructor(world: World) {
    this.world = world;
  }

  create(_f: Fighter): void {}

  remove(_f: Fighter): void {}

  /** Switched in the next phase 4c. */
  requestTrip(_f: Fighter, _why: TripWhy, _cause: ImpactCause | null): void {}

  /** Phase 4c: pending trips → the trip switch; standing and rising rulers' zones posed. */
  preStep(_w: World): void {}

  /** Phase 4d: queued shoves. */
  applyShoves(): void {}

  /** Phase 13b: tripped rig, in-pit, pinned, get-up. */
  postStep(_w: World): void {}

  /** As ZoneBodies.resetHistory (RF-1). */
  resetHistory(_f: Fighter): void {}

  /** By fighter id. */
  toRecord(): { fighter: number; ruler: RulerBodyRecV1 }[] {
    return [];
  }

  restoreRecord(r: { fighter: number; ruler: RulerBodyRecV1 }[]): void {
    if (r.length > 0) throw new Error('world/rulerBody.ts: RulerBodies.restoreRecord is not implemented yet (P11)');
  }
}
