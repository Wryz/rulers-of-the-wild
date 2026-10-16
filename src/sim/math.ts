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

/** Small deterministic PRNG so the sim (and tests) are reproducible. */
export class Rng {
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
