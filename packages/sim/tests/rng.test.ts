// The sim's Rng after the M1 change (docs/M1-DESIGN.md §1.2 sim/math.ts, P02a): a uint32 state that saves and
// restores exactly, output-identical to DungeonStyle's generator; and seedFor, the world's stream seeds (§8.1).
import { describe, expect, it } from 'vitest';
import { Rng, seedFor } from '../src/sim/math';

/** DungeonStyle's generator as it was (the counter never wrapped). */
class DsRng {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

describe('Rng', () => {
  it('draws exactly what the old generator drew, 10⁶ draws from each of four seeds', () => {
    for (const seed of [1, 7, 7919 * 3 + 13, 0xdeadbeef]) {
      const a = new Rng(seed);
      const b = new DsRng(seed);
      let same = true;
      for (let i = 0; i < 1_000_000; i++) {
        if (a.next() !== b.next()) {
          same = false;
          break;
        }
      }
      expect(same, `seed ${seed}`).toBe(true);
    }
  });

  it('keeps the seed rules: 0 and non-integers seed like before', () => {
    for (const seed of [0, -1, 2 ** 32 + 5, 3.7]) {
      const a = new Rng(seed);
      const b = new DsRng(seed);
      for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
    }
  });

  it('exposes its state as a uint32 that round-trips: a restored stream continues the same sequence', () => {
    const a = new Rng(12345);
    for (let i = 0; i < 4321; i++) a.next();
    const s = a.state;
    expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
    const b = new Rng(99);
    b.state = s;
    expect(b.state).toBe(s);
    for (let i = 0; i < 1000; i++) expect(b.next()).toBe(a.next());
    // The range helpers draw from the same stream.
    const c = new Rng(1);
    c.state = a.state;
    expect(c.range(2, 5)).toBe(a.range(2, 5));
    expect(c.chance(0.5)).toBe(a.chance(0.5));
  });

  it('keeps a state of 0 if the wrap lands on it (no reseeding to 1)', () => {
    const r = new Rng(1);
    r.state = 0;
    expect(r.state).toBe(0);
    const ref = new Rng(1);
    ref.state = 0;
    expect(r.next()).toBe(ref.next());
    // The state after one draw from 0 is the increment itself.
    expect(r.state).toBe(0x6d2b79f5);
  });

  it('stays a uint32 however long it runs (the old counter left 2³² after three draws)', () => {
    const r = new Rng(5);
    for (let i = 0; i < 10; i++) {
      r.next();
      expect(r.state).toBeLessThan(2 ** 32);
      expect(r.state).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('seedFor', () => {
  /** The §8.1 formula, written out independently. */
  function reference(worldSeed: number, stream: string, id = 0): number {
    let h = 2166136261;
    for (let i = 0; i < stream.length; i++) h = Number((BigInt((h ^ stream.charCodeAt(i)) >>> 0) * 16777619n) % 4294967296n);
    h = Number((BigInt((h ^ worldSeed) >>> 0) * 0x9e3779b1n) % 4294967296n);
    h = Number((BigInt((h ^ id) >>> 0) * 0x85ebca6bn) % 4294967296n);
    h = (h ^ (h >>> 16)) >>> 0;
    return h || 1;
  }

  it('follows §8.1: FNV-1a of the stream, mixed with the world seed and the id', () => {
    for (const [seed, stream, id] of [
      [1, 'combat', 0],
      [42, 'fighter', 1],
      [42, 'fighter', 2],
      [0xffffffff, 'mind', 17],
      [123456789, 'gen', 0],
      [7, 'world', 0],
    ] as const) {
      expect(seedFor(seed, stream, id)).toBe(reference(seed, stream, id));
    }
  });

  it('is a non-zero uint32, the same every time, and differs between streams, ids and worlds', () => {
    const seen = new Set<number>();
    for (const world of [1, 2, 3]) {
      for (const stream of ['combat', 'world', 'gen', 'fighter', 'mind']) {
        for (let id = 0; id < 5; id++) {
          const s = seedFor(world, stream, id);
          expect(s).toBe(seedFor(world, stream, id));
          expect(Number.isInteger(s) && s > 0 && s < 2 ** 32).toBe(true);
          seen.add(s);
        }
      }
    }
    expect(seen.size).toBe(3 * 5 * 5);
    expect(seedFor(9, 'combat')).toBe(seedFor(9, 'combat', 0));
  });
});
