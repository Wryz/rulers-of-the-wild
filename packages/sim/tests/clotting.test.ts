// Clotting (owner's decision after P39: bleeds slowly close; BLEED_TUNING in sim/rules.ts, bleedTick in sim/combat.ts):
// a cut's seep tapers to zero over its clot time (clotSmallS × (seep / clotRefSeep) ^ clotSizeExp, counted in ticks)
// and then it stops bleeding; the cut stays on the body and the HP it took stays lost.
// - a small cut (DS's smallest: rate 0.15, seep 0.0375) stops within clotSmallS (180 s);
// - a large cut (DS's largest: rate 1, seep 0.25) is still bleeding then, bleeds far longer (20 min) and takes more HP;
// - rule 9: a ruler's wound (a RulerState record; rulers never bleed, §4.6 step 5) persists past the time the largest
//   cut takes to clot: its HP, place, zone, severity and effect, the ruler's lost HP and effective maximum;
// - a world save mid-clot keeps each cut's `clot`, and the loaded world bleeds and clots exactly as the original.
//
// Scene numbers (wound sizes, ticks, HP) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bleedTick, CombatSim, woundClotS } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import { type Fighter, IdCounter } from '../src/sim/fighter';
import { DT, Rng } from '../src/sim/math';
import { createPlayer } from '../src/sim/roster';
import { newRulerState, rulerDamage, type RulerDamageWorld, rulerEffectiveMax, rulerHp, rulerTick } from '../src/sim/ruler';
import { BLEED_TUNING } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import type { Wound } from '../src/sim/weapons';
import { resetTuning } from '../src/tuning/registry';
import { physicsReady } from '../src/world/physics';
import { loadWorld } from '../src/save/load';
import { serializeWorld } from '../src/save/serialize';
import type { ImpactCause, WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 120_000 });

const SMALL = { rate: 0.15, seep: 0.0375 };
const LARGE = { rate: 1, seep: 0.25 };
const cut = (c: { rate: number; seep: number }, bone: Wound['bone'] = 'chest'): Wound => ({
  bone,
  local: [0.05, 0.1, 0.12],
  angle: 0.3,
  length: 0.1,
  bleed: c.rate,
  floor: c.seep,
  clot: 0,
});

/** A player alone in a legacy CombatSim (nothing else harms it). */
function alone(): { sim: CombatSim; f: Fighter } {
  const sim = new CombatSim(5);
  const f = createPlayer({ ids: new IdCounter(1), rngSeed: 3 });
  sim.add(f);
  return { sim, f };
}

const ticks = (s: number): number => Math.ceil(s / DT);

afterEach(() => resetTuning());

describe('clotting: the starting values', () => {
  it('are in the live BLEED_TUNING table: 180 s for the smallest cut, growing with the seep (20 min for the largest)', () => {
    expect(BLEED_TUNING).toEqual({ clotSmallS: 180, clotRefSeep: 0.0375, clotSizeExp: 1 });
    expect(woundClotS(cut(SMALL))).toBeCloseTo(180, 9);
    expect(woundClotS(cut(LARGE))).toBeCloseTo(1200, 9);
  });
});

describe('a small cut', () => {
  it('stops bleeding within its clot time (180 s); the cut stays, and the HP it took stays lost', () => {
    const { sim, f } = alone();
    const w = cut(SMALL);
    f.wounds.push(w);
    let stopped = -1;
    for (let t = 1; t <= ticks(180) + 1; t++) {
      sim.step();
      if (stopped < 0 && w.bleed === 0) stopped = t;
    }
    expect(stopped).toBeGreaterThan(ticks(170));
    expect(stopped).toBeLessThanOrEqual(ticks(180) + 1);
    expect(w.clot).toBe(1);
    const lost = 100 - f.hp;
    // The opening gush (≈ 2.9 HP) and the tapering seep (½ × 0.0375 × 1.1 HP/s × 180 s ≈ 3.7 HP).
    expect(lost).toBeGreaterThan(5);
    expect(lost).toBeLessThan(8);
    for (let t = 0; t < 600; t++) sim.step();
    expect(f.hp).toBe(100 - lost);
    expect(f.wounds).toEqual([w]);
  });
});

describe('a large cut', () => {
  it('bleeds much longer than a small one (20 min), and takes far more HP', () => {
    const big = cut(LARGE);
    const small = cut(SMALL);
    let bigLost = 0;
    let smallLost = 0;
    let bigStopped = -1;
    let smallStopped = -1;
    for (let t = 1; t <= ticks(1200) + 1; t++) {
      const rb = bleedTick(big);
      const rs = bleedTick(small);
      bigLost += rb * 1.1 * DT;
      smallLost += rs * 1.1 * DT;
      if (bigStopped < 0 && rb === 0) bigStopped = t;
      if (smallStopped < 0 && rs === 0) smallStopped = t;
      // When the small cut has clotted, the large one is still bleeding at most of its seep.
      if (t === smallStopped) expect(big.bleed).toBeGreaterThan(0.8 * LARGE.seep);
    }
    expect(smallStopped).toBeGreaterThan(0);
    expect(bigStopped).toBeGreaterThan(ticks(1190));
    expect(bigStopped).toBeLessThanOrEqual(ticks(1200) + 1);
    expect(bigStopped / smallStopped).toBeGreaterThan(6);
    // Gush ≈ (1 − 0.25) × 23.8 s × 1.1 ≈ 20 HP, seep ½ × 0.25 × 1.1 × 1,200 s = 165 HP.
    expect(bigLost).toBeGreaterThan(170);
    expect(bigLost).toBeGreaterThan(20 * smallLost);
  });

  it('a stump (seep 0.3) bleeds 24 min, and a cut on a limb that comes off stops at once', () => {
    const stump: Wound = { ...cut(LARGE), floor: 0.3, stump: 'foreArmL' };
    expect(woundClotS(stump)).toBeCloseTo(1440, 9);
    const gone = cut(LARGE, 'foreArmL');
    gone.bleed = gone.floor = 0;
    expect(bleedTick(gone)).toBe(0);
    expect(gone.clot).toBe(1);
  });
});

describe('a ruler (rule 9)', () => {
  it("keeps its wound after the time the largest cut takes to stop: the record, the HP lost, the weak point", () => {
    // A legacy CombatSim with a standing giant ape and, beside it, a player with DS's largest cut.
    const sim = new CombatSim(11);
    const { fighter: g } = createEnemy('bruiser', new Rng(4), {}, {}, { ids: new IdCounter(20) });
    g.scale = SPECIES_BODY.giantApe.scale;
    g.massKg = SPECIES_BODY.giantApe.massKg;
    g.species = 'giantApe';
    g.ruler = newRulerState(SPECIES_BODY.giantApe.maxHp);
    g.autoDefense = false;
    g.stats.defense = 0;
    sim.add(g);
    const p = createPlayer({ ids: new IdCounter(1), rngSeed: 3 });
    p.pos.set(30, 0, 0);
    sim.add(p);
    const pCut = cut(LARGE);
    p.wounds.push(pCut);
    const w: RulerDamageWorld & { events: WorldEvent[] } = { ids: { wound: new IdCounter(1) }, combat: sim, events: [] };
    const stake: ImpactCause = { kind: 'entity', entityId: 7, fighterId: null, credit: ['p1'], held: false, feature: 'sharpPoint' };
    const r = g.ruler;
    // A severe wound on the left shin (> 1,800 HP): a limp, 5 % off the effective maximum.
    const opened = rulerDamage(w, g, 2000, 'leg', 'shinL', stake, g.rig.shinL.pos.clone())!;
    expect(opened).not.toBeNull();
    expect(opened.severe).toBe(true);
    const before = structuredClone(opened);
    const effMax = rulerEffectiveMax(r);
    const hpBefore = rulerHp(r);
    const fighterHp = g.hp;
    const n = ticks(1200) + 60;
    for (let t = 0; t < n; t++) {
      sim.step();
      rulerTick(g, DT);
    }
    // The player's cut has stopped bleeding; the ruler never bled (§4.6 step 5) and its wound is all still there.
    expect(pCut.bleed).toBe(0);
    expect(g.hp).toBe(fighterHp);
    expect(r.wounds).toHaveLength(1);
    const now = r.wounds[0];
    expect(now).toBe(opened);
    const { remaining, ...rest } = now;
    const { remaining: was, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(now.effect).toBe('limp');
    // Only SPEC:506's slow healing touches it: 50 HP per hour of play.
    const healed = (50 / 3600) * n * DT;
    expect(was - remaining).toBeCloseTo(healed, 6);
    expect(rulerEffectiveMax(r)).toBe(effMax);
    expect(rulerHp(r)).toBeCloseTo(hpBefore + healed, 6);
  });
});

describe('save and load mid-clot', () => {
  const live: World[] = [];
  beforeAll(async () => {
    await physicsReady();
  });
  afterEach(() => {
    for (const x of live.splice(0)) x.dispose();
  });

  it("keeps each cut's clot, and the loaded world bleeds and clots tick for tick as the original", async () => {
    const w = await createWorld({ seed: 20261028, scene: 'empty', nav: 'off', size: 50 });
    live.push(w);
    const f = w.player!;
    f.wounds.push(cut(SMALL), cut({ rate: 0.5, seep: 0.125 }, 'thighR'));
    for (let t = 0; t < ticks(60); t++) w.step();
    const mid = f.wounds.map((x) => x.clot);
    expect(mid[0]).toBeGreaterThan(0.3);
    expect(mid[0]).toBeLessThan(0.4);
    expect(mid[1]).toBeGreaterThan(0.09);
    expect(mid[1]).toBeLessThan(0.11);
    const l = await loadWorld(serializeWorld(w), { nav: 'off' });
    live.push(l);
    const g = l.player!;
    expect(g.wounds).toEqual(f.wounds);
    expect(g.hp).toBe(f.hp);
    for (let t = 0; t < ticks(150); t++) {
      w.step();
      l.step();
      if (t % 600 === 0) {
        expect(g.wounds).toEqual(f.wounds);
        expect(g.hp).toBe(f.hp);
      }
    }
    expect(f.wounds[0].clot).toBe(1);
    expect(f.wounds[0].bleed).toBe(0);
    expect(f.wounds[1].clot).toBeLessThan(1);
    expect(g.wounds).toEqual(f.wounds);
    expect(g.hp).toBe(f.hp);
  });
});
