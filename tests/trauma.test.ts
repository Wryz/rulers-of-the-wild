import { describe, expect, it } from 'vitest';
import { Trauma } from '../src/game/trauma';
import { Rng } from '../src/sim/math';
import { PLAYER_MOVES as P } from '../src/sim/moves';

describe('trauma and bleeding', () => {
  it("fresh fighters don't bleed; jaw shots build up faster and bleed from the mouth", () => {
    const a = new Trauma();
    expect(a.onHit('head', P.jab, 4, false)).toEqual([]);
    const hooks = new Trauma();
    const jabs = new Trauma();
    let hookBleeds = 0;
    let jabBleeds = 0;
    for (let i = 0; i < 3; i++) {
      hookBleeds += hooks.onHit('head', P.hook, 10, false).length;
      jabBleeds += jabs.onHit('head', P.cross, 7, false).length;
    }
    expect(hooks.head).toBeGreaterThan(jabs.head);
    expect(hookBleeds).toBeGreaterThan(jabBleeds);
    expect(hooks.onHit('head', P.hook, 10, false).some((b) => b.source === 'mouth')).toBe(true);
    expect(jabs.onHit('head', P.cross, 7, false).every((b) => b.source !== 'mouth')).toBe(true);
  });

  it('body kicks make a beaten fighter cough blood', () => {
    const t = new Trauma();
    const first = t.onHit('abdomen', P.frontKick, 6, false);
    expect(first).toEqual([]);
    let coughs = 0;
    for (let i = 0; i < 4; i++) coughs += t.onHit('abdomen', P.frontKick, 6, false).filter((b) => b.style === 'cough').length;
    expect(coughs).toBeGreaterThan(0);
    // Light punches to the body don't.
    const p = new Trauma();
    for (let i = 0; i < 10; i++) expect(p.onHit('chest', P.jab, 4, false).filter((b) => b.style === 'cough')).toEqual([]);
  });

  it('only heavily hurt fighters drip, cut and bruise', () => {
    const rng = new Rng(1);
    const t = new Trauma();
    let drips = 0;
    for (let i = 0; i < 600; i++) if (t.drip(1 / 60, rng)) drips++;
    expect(drips).toBe(0);
    expect(t.cut).toBe(false);
    for (let i = 0; i < 4; i++) t.onHit('head', P.hook, 10, false);
    for (let i = 0; i < 600; i++) if (t.drip(1 / 60, rng)) drips++;
    expect(drips).toBeGreaterThan(2);
    expect(t.cut).toBe(true);
    expect(t.bruise).toBeGreaterThan(0.5);
  });
});
