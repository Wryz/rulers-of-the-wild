// The contact pipeline (docs/M1-DESIGN.md §1.5.8, §4.3; phase 9): new contacts from the sorted pairs, owners, the
// per-(creature, owner) touching counts and episodes, the cooldown and grace windows, normals, v_n, self-motion, m_eff,
// sharpness and hard landings, then dispatch to applyImpact, breaking, felling and the tripwires.
//
// STUB (P05; P09 fills it): final exported signatures. Until P09 no contact is scored and no state is kept.
import type { ContactRecV1 } from '../save/schema';
import type { ContactPair } from './physics';
import type { World } from './world';

export class ContactSystem {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Phase 9: the drained pairs, in their sorted order. */
  process(_w: World, _pairs: readonly ContactPair[]): void {}

  /** Pairs of that fighter starting before untilTick count as touching but are never scored (§4.3, RF-1). */
  grace(_fighterId: number, _untilTick: number): void {}

  /** The touching counts, episode starts and cooldown ends, sorted (creature, owner key) (RR-19). */
  toRecord(): ContactRecV1[] {
    return [];
  }

  restoreRecord(r: ContactRecV1[]): void {
    if (r.length > 0) throw new Error('world/contacts.ts: ContactSystem.restoreRecord is not implemented yet (P09)');
  }

  /** (fighter, untilTick), sorted: the open contact graces (§8.3 `contactGrace`). */
  graceRecord(): [number, number][] {
    return [];
  }
}
