// What the radial offers and whether a verb command is valid (docs/M1-DESIGN.md §1.5.10, §5.0, §5.13), shared by the
// sim (phase 1b and both re-validations) and the client's radial.
//
// STUB (P05; P14 fills it): final exported signatures; both functions throw until P14.
// TODO "roll verb": no roll verb in M1 (X16); verbsFor offers none (§12.4).
import type { Vector3 } from 'three';
import type { VerbCommand, VerbId } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import type { RefuseReason } from '../types';
import type { World } from '../world';

/** What the player has highlighted: an entity (at a surface point) or the ground. */
export type TargetRef = { kind: 'entity'; id: number; at: Vector3 } | { kind: 'ground'; at: Vector3 };

/** One radial option, in §5.13's fixed order; disabled options carry the reason (the player learns the rule). */
export interface VerbOption {
  verb: VerbId;
  needsSecond: boolean;
  label: string;
  reasonIfDisabled?: RefuseReason;
}

export function verbsFor(w: World, f: Fighter, target: TargetRef): VerbOption[] {
  return notImplemented('verbsFor', w, f, target);
}

export function validateVerb(w: World, f: Fighter, cmd: VerbCommand): { ok: true } | { ok: false; reason: RefuseReason } {
  return notImplemented('validateVerb', w, f, cmd);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/verbs/targets.ts: ${name} is not implemented yet (P14; called with ${args.length} arguments)`);
}
