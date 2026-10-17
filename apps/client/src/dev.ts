/**
 * Developer mode: the tuning panel (L), debug keys (hitboxes, slow motion, pause, frame step, rebuild), `?mode=training`
 * and `window.game`. On in local development, or with `?dev` in the URL; never shown to players otherwise.
 */
export const DEV = import.meta.env.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev'));

/** What the page's URL asks the world to be built with (docs/M1-DESIGN.md §1.4 main.ts, D-50). */
export interface BootParams {
  /** uint32: `?seed=N`, else a fresh random one. */
  seed: number;
  /** `?mode=training` in developer mode: a sparring ape in front of the player (D-50). */
  sparringApe: boolean;
}

/**
 * Reads `?seed=N` (any integer, taken as uint32) and `?mode=training` (developer mode only, as in DungeonStyle).
 * Without a usable seed the world gets `randomU32()`: wall-clock entropy enters only here, as the seed (rule 7).
 */
export function bootParams(search: string, dev: boolean, randomU32: () => number): BootParams {
  const q = new URLSearchParams(search);
  const raw = q.get('seed');
  const n = raw !== null && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN;
  const seed = Number.isSafeInteger(n) ? n >>> 0 : randomU32() >>> 0;
  return { seed, sparringApe: dev && q.get('mode') === 'training' };
}

/** A random uint32 from the browser's crypto (the seed of a world built without `?seed`). */
export function cryptoSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** The URL query that rebuilds this world: same seed, same mode (dev Backspace, the panel's "Restart"). */
export function rebuildSearch(search: string, seed: number): string {
  const q = new URLSearchParams(search);
  q.set('seed', String(seed >>> 0));
  return `?${q.toString()}`;
}
