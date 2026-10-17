// Joints and ropes (docs/M1-DESIGN.md §1.5.7, §2.4, §4.9): lash, hinge, rope, bend; held ends with the haul model;
// rope sensors re-posed before every step; the non-negative least-squares tension fit, strands and snaps; tripwire loads.
//
// STUB (P05; P10 fills it): final exported signatures and JOINT_TUNING with its §9 values. The store is empty: the
// pipeline's calls (applyHeldEnds, poseSensors, postStep) and the readers work on no joints; every mutator throws.
import type { JointRecV1 } from '../save/schema';
import { defineTuning } from '../tuning/registry';
import type { Anchor, JointRecord, V3 } from './types';
import type { World } from './world';

export const JOINT_TUNING = defineTuning(
  'JOINT_TUNING',
  'Materials & joints › ropes',
  {
    tripwireWindowS: 0.1,
    ropeBreakSteps: 3,
    tautEps: 0.001,
    lashLeverM: 0.1,
    ropeSensorR: 0.02,
    strandMergeM: 0.05,
    nnlsMaxGroups: 8,
    bendK: 400000,
    bendDamping: 40000,
    bendMinSpringiness: 0.3,
    burnSpeedMps: 0.05,
  },
  {
    tripwireWindowS: { unit: 's', source: 'SPEC:259' },
    ropeBreakSteps: { unit: 'steps', source: 'SPEC:261' },
    tautEps: { unit: 'm', source: 'NEW: MAP rapier §5' },
    lashLeverM: { unit: 'm', source: 'D-18 (vine 600 J, sinew 1,800 J)' },
    ropeSensorR: { unit: 'm', source: 'NEW' },
    strandMergeM: { unit: 'm', source: 'NEW: SPEC:266 strands' },
    nnlsMaxGroups: { unit: 'strand groups per body', source: 'NEW: C F5' },
    bendK: { unit: 'N·m/rad per m² of diameter', source: 'NEW (6 cm green sapling: 864 N·m/rad)' },
    bendDamping: { unit: 'N·m·s/rad per m²', source: 'NEW' },
    bendMinSpringiness: { unit: '—', source: 'NEW: springy predicate' },
    burnSpeedMps: { unit: 'm/s', source: 'SPEC:261 (M2)' },
  },
);

/** What the client draws of a rope (§1.5.7). */
export interface RopeView {
  joint: number;
  a: V3;
  b: V3;
  lengthM: number;
  taut: boolean;
  /** max(T) / (strength × strands). */
  strain: number;
}

export class JointStore {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  get(_id: number): JointRecord | undefined {
    return undefined;
  }

  /** Id order. */
  all(): readonly JointRecord[] {
    return [];
  }

  /** A fixed joint. */
  lash(a: Anchor, b: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): number {
    return notImplemented('lash', a, b, rope, credit);
  }

  hinge(a: Anchor, b: Anchor, axis: V3, limits: [number, number] | null, rope: { entity: number; lengthM: number }, credit: string[]): number {
    return notImplemented('hinge', a, b, axis, limits, rope, credit);
  }

  rope(a: Anchor, b: Anchor, lengthM: number, rope: { entity: number; lengthM: number }, credit: string[]): number {
    return notImplemented('rope', a, b, lengthM, rope, credit);
  }

  bend(sapling: number, top: Anchor, hold: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): { bend: number; hold: number } {
    return notImplemented('bend', sapling, top, hold, rope, credit);
  }

  remove(id: number, why: 'cut' | 'untie' | 'snap' | 'release'): void {
    notImplemented('remove', id, why);
  }

  holdEnd(joint: number, end: 'a' | 'b', fighterId: number): void {
    notImplemented('holdEnd', joint, end, fighterId);
  }

  /** The end becomes loose. */
  dropEnd(joint: number, at: V3): void {
    notImplemented('dropEnd', joint, at);
  }

  /** The held end's pull this tick (verbs set it every tick); the haul model, §4.9. */
  setPull(joint: number, forceN: number): void {
    notImplemented('setPull', joint, forceN);
  }

  /** Reel in a slack rope. */
  shorten(joint: number, dl: number): void {
    notImplemented('shorten', joint, dl);
  }

  /** The held end becomes tied to `to` at the current distance (tie, §5.8). */
  tieHeldEnd(joint: number, to: Anchor): void {
    notImplemented('tieHeldEnd', joint, to);
  }

  /** Phase 4d: held and loose-end ropes (the haul model): impulses, moments on notched trees, loads on anchors. */
  applyHeldEnds(_w: World): void {}

  /** Phase 4e: every rope sensor re-posed from its anchors' current poses (RF-13). */
  poseSensors(): void {}

  /** Phase 10: the tension fit for taut ropes, the 3-step max against strength × strands, snaps; bends spring back. */
  postStep(_w: World): void {}

  /** Client: anchors (world), length, tension over strength, slack. */
  view(): readonly RopeView[] {
    return [];
  }

  /** Id order, tension rings and pullN included. */
  toRecord(): JointRecV1[] {
    return [];
  }

  restoreRecord(r: JointRecV1[]): void {
    if (r.length > 0) notImplemented('restoreRecord', r);
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/joints.ts: JointStore.${name} is not implemented yet (P10; called with ${args.length} arguments)`);
}
