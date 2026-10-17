// The verb system (docs/M1-DESIGN.md §1.5.10, §5.0): command validation in phase 1b, the 12-frame buffer, tryVerb and
// completeWork (through WorldPort), continuous verbs, held entities following the hands, the code forces of dragging,
// pulling and creature tugs, the drag tether, forced releases when a fighter goes down.
//
// STUB (P05; P14 fills it): final exported signatures. Until P14 verb commands are dropped and every phase call does
// nothing.
import type { VerbStateRecV1 } from '../../save/schema';
import type { VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import type { Vector3 } from 'three';
import type { World } from '../world';

export class VerbSystem {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Phase 1b: validate (§5.0), apply 'focus' now, buffer the rest as f.verbRequest. */
  applyCommands(_cmds: readonly VerbCommand[]): void {}

  /** WorldPort, phase 3 (after tryPickup): re-validates and may start a work action. */
  tryVerb(_f: Fighter): void {}

  /** WorldPort, phase 3 (advancePickup at stateFrame === work.actAt): re-validates and lands the effect. */
  completeWork(_f: Fighter): void {}

  /** Called by CharacterControllers.resolve before the sweep: the drag grip and a held rope end limit the proposal. */
  tether(_f: Fighter, _proposal: Vector3): void {}

  /** Phase 4a: forced releases (carry, drag, rope end; the wielded tool only on KO). */
  onDown(_w: World): void {}

  /** Phase 4b: held entities' record poses follow the hand. */
  syncHeld(_w: World): void {}

  /** Phase 4d: drag, pull (joints.setPull), creature tug. */
  codeForces(_w: World): void {}

  /** By fighter id. */
  toRecord(): VerbStateRecV1[] {
    return [];
  }

  restoreRecord(r: VerbStateRecV1[]): void {
    if (r.length > 0) throw new Error('world/verbs/index.ts: VerbSystem.restoreRecord is not implemented yet (P14)');
  }
}
