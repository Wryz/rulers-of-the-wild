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

// ---------------------------------------------------------------------------
// Developer screenshots (tools/shots/README.md). main.ts reads these only under `import.meta.env.DEV`, which the
// production build replaces with false, so the branch and everything below it are dropped from the player's bundle:
// the save is fetched from the dev server (`/@fs/…`), so there is nothing for them to do in a build anyway.
// ---------------------------------------------------------------------------

/** A point as the shot URL gives it. */
export interface ShotPoint {
  x: number;
  y: number;
  z: number;
}

/** What a developer screenshot URL asks of the boot. */
export interface ShotParams {
  /**
   * `?save=<url>`: a canonical save (packages/sim/src/save) the world is loaded from instead of created; `?save=session`
   * the one the dev panel's "Load world" picked (SESSION_SAVE).
   */
  save: string | null;
  /** `?paused=1`: the loop starts paused (the loop's own pause, GAME_TUNING.paused: rule 8; the sim is not touched). */
  paused: boolean;
  /** `?cam=px,py,pz,tx,ty,tz`: the camera pinned at p, looking at t (client-side only). */
  cam: { pos: ShotPoint; target: ShotPoint } | null;
  /** `?fov=N`: the pinned camera's vertical field of view (degrees); null keeps the game's. */
  fov: number | null;
  /** `?hud=0` hides the HUD. */
  hud: boolean;
}

/**
 * Reads the developer screenshot parameters, or null when the URL has none of them (a normal boot). A malformed `cam`
 * or `fov` throws, so a typo in a shot URL fails loudly instead of framing nothing.
 */
export function shotParams(search: string): ShotParams | null {
  const q = new URLSearchParams(search);
  if (!['save', 'paused', 'cam', 'fov', 'hud'].some((k) => q.has(k))) return null;
  const save = q.get('save');
  let cam: ShotParams['cam'] = null;
  const rawCam = q.get('cam');
  if (rawCam !== null) {
    const n = rawCam.split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
    if (n.length !== 6 || !n.every(Number.isFinite)) throw new Error(`?cam wants six numbers px,py,pz,tx,ty,tz (got "${rawCam}")`);
    cam = { pos: { x: n[0], y: n[1], z: n[2] }, target: { x: n[3], y: n[4], z: n[5] } };
  }
  let fov: number | null = null;
  const rawFov = q.get('fov');
  if (rawFov !== null) {
    fov = Number(rawFov);
    if (!(fov > 1 && fov < 179)) throw new Error(`?fov wants degrees between 1 and 179 (got "${rawFov}")`);
  }
  const off = (v: string | null) => v === '0' || v === 'false' || v === 'off';
  return { save: save !== null && save !== '' ? save : null, paused: q.has('paused') && !off(q.get('paused')), cam, fov, hud: !off(q.get('hud')) };
}

/**
 * `?save=session`: the save the dev panel's "Load world" picked, kept in this tab's sessionStorage under
 * SESSION_SAVE_KEY (a reload, or dev Backspace, loads it again).
 */
export const SESSION_SAVE = 'session';
export const SESSION_SAVE_KEY = 'rotw.dev.loadedSave';

/** What the session-save helpers need of the browser's storage (tests hand in a Map-backed one). */
export interface SaveStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Keeps a picked save for the reload that loads it (the panel's "Load world"; a canonical save is JSON text) and
 * returns the query that boots it. Throws when the storage refuses it (full, or unavailable).
 */
export function stashSave(bytes: Uint8Array, search: string, store: SaveStore = sessionStorage): string {
  store.setItem(SESSION_SAVE_KEY, new TextDecoder().decode(bytes));
  const q = new URLSearchParams(search);
  q.set('save', SESSION_SAVE);
  return `?${q.toString()}`;
}

/** The bytes of a save served by the dev server (`?save=<url>`), or the one the panel kept (`?save=session`). */
export async function fetchSave(url: string, store: SaveStore | null = typeof sessionStorage !== 'undefined' ? sessionStorage : null): Promise<Uint8Array> {
  if (url === SESSION_SAVE) {
    const text = store?.getItem(SESSION_SAVE_KEY) ?? null;
    if (text === null) throw new Error('?save=session: no save was loaded in this tab (use the dev panel\'s "Load world")');
    return new TextEncoder().encode(text);
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`?save: ${url} answered ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Resolves once the page has painted (the boot's loading message shows before createWorld holds the thread). */
export function nextPaint(): Promise<void> {
  return new Promise((done) => {
    if (typeof requestAnimationFrame === 'undefined') {
      done();
      return;
    }
    // (A hidden tab runs no animation frames: the timer lets the boot go on there anyway.)
    const timer = setTimeout(done, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        done();
      }),
    );
  });
}

/** The camera as a pinned shot sees it: three.js's PerspectiveCamera, structurally. */
interface PinnableCamera {
  fov: number;
  position: { set(x: number, y: number, z: number): unknown };
  lookAt(x: number, y: number, z: number): void;
  updateProjectionMatrix(): void;
  updateMatrixWorld(force?: boolean): void;
}

/**
 * Pins the camera a frame is rendered through (`?cam`): after the camera director's own update every frame, the
 * camera is put at the shot's position looking at its target. Presentation only: the director's state, the move basis
 * and the sim are untouched.
 */
export function pinCamera<A extends unknown[]>(cams: { update(...args: A): void; readonly camera: PinnableCamera }, cam: NonNullable<ShotParams['cam']>, fov: number | null): void {
  const update = cams.update.bind(cams);
  cams.update = (...args: A) => {
    update(...args);
    const c = cams.camera;
    c.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
    c.lookAt(cam.target.x, cam.target.y, cam.target.z);
    if (fov !== null && c.fov !== fov) {
      c.fov = fov;
      c.updateProjectionMatrix();
    }
    c.updateMatrixWorld(true);
  };
}
