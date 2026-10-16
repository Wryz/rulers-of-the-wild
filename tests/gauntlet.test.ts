import { describe, expect, it } from 'vitest';
import { ARENA_ORDER, roundSpec } from '../src/game/gauntlet';
import { ARCHETYPES, BOSSES } from '../src/sim/enemies';
import { Rng } from '../src/sim/math';

const totalHp = (round: number) =>
  roundSpec(round, new Rng(round)).spawns.reduce((n, s) => n + (ARCHETYPES[s.kind].stats.maxHp ?? 70) * (s.hpMul ?? 1), 0);

describe('gauntlet rounds', () => {
  it('changes arena every round and visits every arena', () => {
    const seen = new Set<string>();
    for (let r = 1; r <= 12; r++) {
      const t = roundSpec(r, new Rng(1)).theme;
      if (r > 1) expect(t).not.toBe(roundSpec(r - 1, new Rng(1)).theme);
      seen.add(t);
    }
    for (const a of ARENA_ORDER) expect(seen.has(a)).toBe(true);
    expect(seen.has('colosseum')).toBe(true);
  });

  it('one opponent at a time, getting tougher every round', () => {
    for (let r = 1; r <= 20; r++) expect(roundSpec(r, new Rng(r)).spawns).toHaveLength(1);
    expect(totalHp(9)).toBeGreaterThan(totalHp(1) * 1.8);
    expect(roundSpec(12, new Rng(1)).spawns[0].dmgMul!).toBeGreaterThan(roundSpec(1, new Rng(1)).spawns[0].dmgMul!);
  });

  it('every fourth round is a giant boss in the colosseum', () => {
    for (const r of [4, 8, 12]) {
      const s = roundSpec(r, new Rng(1));
      expect(s.boss && BOSSES.includes(s.boss)).toBe(true);
      expect(s.theme).toBe('colosseum');
      expect(ARCHETYPES[s.boss!].scale).toBeGreaterThan(1.5);
    }
    expect(roundSpec(3, new Rng(1)).boss).toBeNull();
  });

  it('brings in mythical creatures later on', () => {
    const early = new Set<string>();
    const late = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      for (let r = 1; r <= 3; r++) roundSpec(r, new Rng(seed)).spawns.forEach((s) => early.add(s.kind));
      for (let r = 9; r <= 11; r++) roundSpec(r, new Rng(seed)).spawns.forEach((s) => late.add(s.kind));
    }
    expect(early.has('demon') || early.has('imp')).toBe(false);
    expect(late.has('demon') && late.has('imp')).toBe(true);
  });

  it('opponents gear up as the rounds go on: more pieces, better tiers, more of them armed', () => {
    const kit = (from: number, to: number) => {
      let pieces = 0;
      let tiers = 0;
      let armed = 0;
      for (let r = from; r <= to; r++) {
        for (let k = 0; k < 10; k++) {
          const s = roundSpec(r, new Rng(r * 100 + k)).spawns[0];
          const t = Object.values(s.gear) as number[];
          pieces += t.length;
          tiers += t.reduce((a, b) => a + b, 0);
          if (s.weapon) armed++;
        }
      }
      return { pieces, tiers, armed };
    };
    expect(kit(1, 2).pieces).toBe(0);
    const mid = kit(5, 7);
    const late = kit(12, 14);
    expect(late.pieces).toBeGreaterThan(mid.pieces);
    expect(late.tiers / late.pieces).toBeGreaterThan(mid.tiers / mid.pieces);
    expect(late.armed).toBeGreaterThan(0);
    expect(Math.max(...(Object.values(roundSpec(20, new Rng(1)).spawns[0].gear) as number[]))).toBeLessThanOrEqual(6);
  });
});
