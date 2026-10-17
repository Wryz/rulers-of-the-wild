// Character controllers for the player and apes (docs/M1-DESIGN.md §1.5.8, §4.2): a kinematic capsule and a Rapier
// KinematicCharacterController per fighter, the 500 N push queue, jump, fall and landing, teleport, the verbs' tether
// hook and the crouch height with headroom. The FighterMover CombatSim calls at the separate() site (phase 3).
//
// STUB (P05; P08 fills it): final exported signatures and CHARACTER_TUNING with its §9 values. Until P08 there are no
// capsules: `resolve` leaves CombatSim's proposal as it is (y included), the phase calls do nothing, and every fighter
// reads as grounded and standing.
import type { KccRecV1 } from '../save/schema';
import type { Fighter } from '../sim/fighter';
import { defineTuning } from '../tuning/registry';
import type { FighterMover } from './types';
import type { World } from './world';

export const CHARACTER_TUNING = defineTuning(
  'CHARACTER_TUNING',
  'Bodies › controllers',
  {
    pushN: 500,
    capsuleR: 0.3,
    capsuleHalfH: 0.6,
    kccOffset: 0.02,
    snapToGround: 0.3,
    autostepMaxH: 0.4,
    autostepMinW: 0.2,
    autostepDynamic: true,
    maxSlopeClimbDeg: 45,
    minSlopeSlideDeg: 30,
    jumpSpeed: 4.2,
    landingKnockdownSpeed: 9,
    crouchHeightFrac: 0.7,
  },
  {
    pushN: { unit: 'N', source: 'SPEC:374, 881' },
    capsuleR: { unit: 'm × scale', source: 'DS (BODY_RADIUS)' },
    capsuleHalfH: { unit: 'm × scale', source: 'NEW: 1.8 m tall' },
    kccOffset: { unit: 'm × scale', source: 'NEW: MAP rapier §3' },
    snapToGround: { unit: 'm × scale', source: 'NEW: MAP rapier §3' },
    autostepMaxH: { unit: 'm × scale', source: 'NEW: D-28 (climb = autostep)' },
    autostepMinW: { unit: 'm × scale', source: 'NEW' },
    autostepDynamic: { unit: '—', source: 'NEW' },
    maxSlopeClimbDeg: { unit: '°', source: 'NEW: MAP rapier §3' },
    minSlopeSlideDeg: { unit: '°', source: 'NEW: MAP rapier §3' },
    jumpSpeed: { unit: 'm/s × √scale', source: 'NEW: D-28 (≈ 0.9 m jump)' },
    landingKnockdownSpeed: { unit: 'm/s', source: 'NEW' },
    crouchHeightFrac: { unit: '× capsule height', source: 'NEW: a crouched ape is 1.39 m, so it fits under a deadfall log (RT-4)' },
  },
);

export class CharacterControllers implements FighterMover {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  create(_f: Fighter): void {}

  remove(_f: Fighter): void {}

  /** f.pos holds this tick's proposal; resolve it in place, y included (§4.2). */
  resolve(_f: Fighter, _radius: number, _propPad: number): void {}

  setEnabled(_f: Fighter, _on: boolean): void {}

  /** The next resolve places the capsule here and skips the sweep (MAP gap-1 §3.6). */
  teleport(_f: Fighter, _x: number, _y: number, _z: number): void {}

  /** Phase 4d: the queued ≤ 500 N pushes, in entity id order. */
  applyPushes(): void {}

  grounded(_f: Fighter): boolean {
    return true;
  }

  /** Capsule at crouchHeightFrac (§4.2). */
  crouched(_f: Fighter): boolean {
    return false;
  }

  /** By fighter id. */
  toRecord(): { fighter: number; kcc: KccRecV1 }[] {
    return [];
  }

  restoreRecord(r: { fighter: number; kcc: KccRecV1 }[]): void {
    if (r.length > 0) throw new Error('world/characters.ts: CharacterControllers.restoreRecord is not implemented yet (P08)');
  }
}
