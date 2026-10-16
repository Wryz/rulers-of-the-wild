import type { HurtZone } from '../sim/combat';
import type { Rng } from '../sim/math';
import type { MoveDef } from '../sim/moves';

export type BleedSource = 'mouth' | 'nose' | 'brow';

export interface Bleed {
  source: BleedSource;
  /** 0..1 how much blood. */
  amount: number;
  /** 'hit': sprays along the blow; 'cough': spills from the mouth, forward and down. */
  style: 'hit' | 'cough';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Accumulated damage per fighter. Fresh fighters don't bleed; once the head has taken
 * enough (jaw shots — hooks and uppercuts — count most), head shots spill blood from the
 * mouth or nose, deep damage opens a cut over the brow and keeps them dripping. Heavy
 * body shots (kicks above all) make a beaten fighter cough blood.
 */
export class Trauma {
  head = 0;
  body = 0;
  private dripIn = 1;

  static HEAD_BLEED = 14;
  static HEAD_CUT = 30;
  static HEAD_DRIP = 20;
  static BODY_COUGH = 22;

  onHit(zone: HurtZone, move: MoveDef, damage: number, counter: boolean): Bleed[] {
    const out: Bleed[] = [];
    const weight = move.weight === 'heavy' ? 1.4 : move.weight === 'medium' ? 1 : 0.6;
    if (zone === 'head') {
      const jaw = move.kind === 'hook' || move.kind === 'uppercut';
      this.head += damage * (jaw ? 1.4 : 1) * (counter ? 1.3 : 1);
      if (this.head > Trauma.HEAD_BLEED) {
        out.push({ source: jaw ? 'mouth' : 'nose', amount: Math.min(1, clamp((this.head - Trauma.HEAD_BLEED) / 25, 0.2, 1) * weight), style: 'hit' });
      }
      if (this.head > Trauma.HEAD_CUT && (jaw || move.weight === 'heavy')) out.push({ source: 'brow', amount: 0.5, style: 'hit' });
    } else if (zone === 'chest' || zone === 'abdomen') {
      const kick = move.limb.startsWith('foot');
      this.body += damage * (kick ? 1.5 : 1) * (move.weight === 'heavy' ? 1.2 : 1);
      if (this.body > Trauma.BODY_COUGH && (kick || move.weight === 'heavy')) {
        out.push({ source: 'mouth', amount: clamp((this.body - Trauma.BODY_COUGH) / 25, 0.2, 0.8), style: 'cough' });
      }
    }
    return out;
  }

  /** Call every frame; returns true when a drop should fall from the mouth / cut. */
  drip(dt: number, rng: Rng): boolean {
    if (this.head < Trauma.HEAD_DRIP) return false;
    this.dripIn -= dt;
    if (this.dripIn > 0) return false;
    this.dripIn = rng.range(0.7, 2) * clamp(40 / this.head, 0.4, 2);
    return true;
  }

  /** 0..1 facial bruising. */
  get bruise() {
    return clamp(this.head / 45, 0, 1);
  }

  get cut() {
    return this.head > Trauma.HEAD_CUT;
  }
}
