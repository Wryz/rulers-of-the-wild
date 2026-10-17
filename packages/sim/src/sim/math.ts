export const DT = 1 / 60;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const saturate = (v: number) => clamp(v, 0, 1);
export const smoothstep = (t: number) => {
  t = saturate(t);
  return t * t * (3 - 2 * t);
};

export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'snap';

export function ease(kind: Ease, t: number): number {
  t = saturate(t);
  switch (kind) {
    case 'linear':
      return t;
    // Quadratic rather than cubic: a cubic crams most of a short segment into its first
    // or last frame, which drove fists and feet to 30-40 m/s for a frame (real punches
    // peak around 7-12 m/s, kicks 12-17).
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    case 'inOut':
      return smoothstep(t);
    case 'snap':
      // Fast start, used for strikes: most of the travel happens early.
      return 1 - Math.pow(1 - t, 3);
  }
}

/** Shortest signed difference between two angles. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function approachAngle(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  return from + clamp(d, -maxStep, maxStep);
}

/**
 * Small deterministic PRNG so the sim (and tests) are reproducible (mulberry32).
 *
 * The state is a uint32 that wraps (docs/M1-DESIGN.md §1.2): every use of it below goes through a 32-bit integer
 * conversion, so wrapping gives the same outputs as DungeonStyle's unwrapped counter for as long as that counter
 * stayed exact (4,917,759 draws), and the state saves and restores as one exact number.
 */
export class Rng {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  /** The whole generator state (uint32): restoring it continues the same sequence. */
  get state(): number {
    return this.s;
  }
  set state(v: number) {
    this.s = v >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pickWeighted<T>(items: [T, number][]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1][0];
  }
}

/**
 * The seed of one named random stream of a world (docs/M1-DESIGN.md §8.1): FNV-1a of the stream name (its UTF-16
 * code units), mixed with the world seed and an id ('fighter' and 'mind' streams are per fighter id). Never 0.
 * Generation, combat and every creature draw from their own stream, so a change to one never shifts another.
 */
export function seedFor(worldSeed: number, stream: string, id = 0): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < stream.length; i++) h = Math.imul(h ^ stream.charCodeAt(i), 0x01000193) >>> 0;
  h = Math.imul(h ^ worldSeed, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ id, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h || 1;
}
