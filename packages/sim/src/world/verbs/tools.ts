// Tools from properties (docs/M1-DESIGN.md §1.5.10, §5.0, §5.2): a held object's geometry (the entity in the hands plus
// everything lash-joined to it), its tool class, the WeaponDef synthesised from it, its fresh chop energy, and the
// property predicates every verb asks.
//
// STUB (P05; P14 fills it): final exported signatures; every function throws until P14.
import type { WeaponDef } from '../../sim/weapons';
import type { SharpPoint, V3 } from '../types';
import type { World } from '../world';

export type ToolClass = 'stick' | 'sharpStick' | 'spear' | 'stoneAxe' | 'longAxe' | 'cudgel' | 'stone' | 'flintBlade';

/**
 * A held object's geometry (§5.0): its members (the entity in the hands plus every lash-joined entity, depth ≤ 3), their
 * summed mass, the longest member's principal axis, the grip at the end opposite the head, and the union of sharp points
 * in that frame.
 */
export interface HeldShape {
  members: number[];
  massKg: number;
  lengthM: number;
  /** Unit, in the held entity's frame, from the grip toward the head. */
  axis: V3;
  grip: V3;
  sharpPoints: SharpPoint[];
}

export function heldShape(w: World, entity: number): HeldShape {
  return notImplemented('heldShape', w, entity);
}

export function toolClass(w: World, entity: number): ToolClass | null {
  return notImplemented('toolClass', w, entity);
}

export function synthWeapon(w: World, entity: number, cls: ToolClass): WeaponDef {
  return notImplemented('synthWeapon', w, entity, cls);
}

/** The tool's committed-swing energy at full stamina and power 1, J (§5.3). */
export function freshChopEnergy(w: World, entity: number): number {
  return notImplemented('freshChopEnergy', w, entity);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/verbs/tools.ts: ${name} is not implemented yet (P14; called with ${args.length} arguments)`);
}
