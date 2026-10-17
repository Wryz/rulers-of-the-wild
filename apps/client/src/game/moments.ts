// Moments from a tick's events (docs/M1-DESIGN.md §10.3): an environmental kill, a ruler wounded by the world, a ruler's
// death, the player flung or killed by a ruler, the player's other deaths, a split skull. In event order.
//
// STUB (P31; P36 fills it): the final exported names and the moments DungeonStyle already cut to: the player's death
// (playerDeath), a crown-split (skullSplit) and an environmental KO (envKill, DS's finishing shot). worldWound,
// rulerDeath and playerByRuler arrive with P36.
import { Vector3 } from 'three';
import type { CombatEvent, StepResult } from '@wild/sim';
import type { Moment } from './killcam';
import type { MomentsPort } from './ports';

export class MomentBuilder implements MomentsPort {
  /** `tick()`: the world's tick (the step just presented). */
  constructor(private readonly tick: () => number) {}

  fromStep(r: StepResult): Moment[] {
    const out: Moment[] = [];
    const tick = this.tick();
    for (const e of r.combat) {
      const m = this.fromCombat(e, tick);
      if (m) out.push(m);
    }
    return out;
  }

  private fromCombat(e: CombatEvent, tick: number): Moment | null {
    if (e.type === 'hit' && e.fatal) {
      return { kind: 'skullSplit', tick, subject: e.defender, point: e.point.clone(), dir: e.dir.clone(), causeEntity: null, severity: 1 };
    }
    if (e.type !== 'ko') return null;
    const v = e.victim;
    const point = new Vector3(e.point.x, e.point.y, e.point.z);
    const dir = e.killer ? new Vector3(v.pos.x - e.killer.pos.x, 0, v.pos.z - e.killer.pos.z) : new Vector3();
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
    dir.normalize();
    const causeEntity = e.cause?.entityId ?? null;
    if (e.environmental && !v.ruler) return { kind: 'envKill', tick, subject: v, point, dir, causeEntity, severity: 1 };
    // TODO(P36): playerByRuler (a ruler's launch or kill) takes the camera before the death cam (rule 9).
    if (v.playerId !== null) return { kind: 'playerDeath', tick, subject: v, point, dir, causeEntity, severity: 1 };
    return null;
  }
}
