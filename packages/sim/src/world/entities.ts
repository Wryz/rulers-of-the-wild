// The entity store (docs/M1-DESIGN.md §1.5.7, §2.3): entities created and removed in id order with their Rapier bodies,
// anchoring and isAnchored, the impulse queue applied in phase 4d of the next step, the record mirror (phase 18),
// `touched`, released-entity grace.
//
// STUB (P05; P06 fills it): final exported signatures. The store is empty: the pipeline's calls (applyImpulses,
// mirror) and the readers (get, all, toRecord) work on no entities; every mutator throws until P06.
import type { EntityRecV1 } from '../save/schema';
import type { Entity, EntitySpec, EntityState, V3 } from './types';
import type { World } from './world';

export class EntityStore {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  get(_id: number): Entity | undefined {
    return undefined;
  }

  /** Id order. */
  all(): readonly Entity[] {
    return [];
  }

  /** Id from world.ids.entity; the body is created now (visible to queries after the next physics step). */
  create(spec: EntitySpec, credit?: string[]): Entity {
    return notImplemented('create', spec, credit);
  }

  remove(id: number): void {
    notImplemented('remove', id);
  }

  /** Rebuilds or disables the body; marks touched. */
  setState(e: Entity, s: EntityState): void {
    notImplemented('setState', e, s);
  }

  /** Fixed body, anchor capacity (§5.7). */
  anchor(e: Entity, depthM: number): void {
    notImplemented('anchor', e, depthM);
  }

  /** Dynamic, awake. */
  unanchor(e: Entity): void {
    notImplemented('unanchor', e);
  }

  /** Fixed or anchored, or lash/hinge-joined to one (depth ≤ 3). */
  isAnchored(e: Entity): boolean {
    return notImplemented('isAnchored', e);
  }

  /**
   * Applied in phase 4d of the NEXT step in entity id order, by every source: strike pushes, contact reactions and
   * tripwire shares of phase 9 (never addForce, C F3; never inside phase 9-10, RF-2).
   */
  queueImpulse(id: number, j: V3, at: V3 | null): void {
    notImplemented('queueImpulse', id, j, at);
  }

  /** Drop, throw, place: no contact between e and that fighter's bodies is scored until they have been apart 2 ticks. */
  release(e: Entity, byFighter: number): void {
    notImplemented('release', e, byFighter);
  }

  /** Test harness only: wakeUp every tick (RT-4). */
  keepAwake(id: number, on: boolean): void {
    notImplemented('keepAwake', id, on);
  }

  /** Phase 4d (last): the queued impulses, in entity id order. */
  applyImpulses(): void {}

  /** Phase 18: pose, vel and prevPose from the bodies in id order; restTicks; touched. */
  mirror(): void {}

  /** Every non-generated entity and every touched generated one, in id order (§8.3). */
  toRecord(): EntityRecV1[] {
    return [];
  }

  /** Generated ids no longer present, sorted. */
  removedGenerated(): number[] {
    return [];
  }

  restoreRecord(r: EntityRecV1[], removed: number[]): void {
    if (r.length > 0 || removed.length > 0) notImplemented('restoreRecord', r, removed);
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/entities.ts: EntityStore.${name} is not implemented yet (P06; called with ${args.length} arguments)`);
}
