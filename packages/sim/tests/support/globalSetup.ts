// Cached test scenes (docs/M1-DESIGN.md §11.0, RF-11, RT-23; package P23). A scene (the AC-2(b)/AC-3 pit) is built
// once, on a fresh world, through the harness and scenes.ts (entities and verbs only), and its save bytes are written
// to packages/sim/.cache/scenes/<key>-<hash>.json (gitignored; CI caches the directory). The hash is
// sha256(tuningSnapshot() + SAVE_FORMAT_VERSION + the sim's dependency versions (package-lock: Rapier, recast, three)
// + the text of packages/sim/src/** and tests/support/*.ts), so any change to the sim, its tuning, its physics engine
// or the recipes rebuilds the scene, and an unchanged tree reuses the file.
//
// - Lazily: a scene is built the first time a test calls `await cachedScene('<key>')` (worldHarness.ts; call it in a
//   `beforeAll` with SCENE_BUILD_TIMEOUT_MS) and its file for this hash is missing. A run that selects no test needing
//   it never waits for it (the pit is ≈ 12.5 min, RT-23 in docs/work/ledger.md).
// - Once per hash across workers: the builder holds `<file>.lock` (an exclusive create holding its pid); the other
//   workers wait for the file. A lock whose process is gone is stale and taken over.
// - A build that throws writes `<key>-<hash>.error.txt`, tagged with this run: the other tests of the run that need
//   the scene fail at once with its text; the next run tries again.
// - This file is also the sim project's Vitest globalSetup (root vitest.config.ts). It only computes the hash, the
//   tuning it was computed from and the run's tag in the main process and hands them to the workers by `provide`
//   (a worker's tuning may have been edited by an earlier test in it; the build runs on the provided tuning). With
//   ROTW_SCENES=pit,… it also builds those scenes before the workers start (CI's warm-up).
//
// Determinism: the scene is a pure function of the code, its tuning and its engine (rule 7), so a cached file is the
// scene any run of this tree would build.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import '../../src/index';
import { SAVE_FORMAT_VERSION } from '../../src/save/schema';
import { restoreTuning, tuningSnapshot } from '../../src/tuning/registry';

declare module 'vitest' {
  export interface ProvidedContext {
    /** globalSetup's scene hash (sceneHash()). */
    sceneHash: string;
    /** The tuning snapshot it was computed from: a lazy build runs on it. */
    sceneTuning: string;
    /** This run's tag (the main process's pid): an error file of another run is retried. */
    sceneRun: string;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/sim */
export const SIM_ROOT = resolve(HERE, '../..');
export const SCENE_DIR = join(SIM_ROOT, '.cache', 'scenes');
const REPO_ROOT = resolve(SIM_ROOT, '../..');

/** The timeout for a `beforeAll` that awaits cachedScene: a cold pit build (≈ 12.5 min measured, RT-23) with room. */
export const SCENE_BUILD_TIMEOUT_MS = 1_800_000;
/** How often a worker waiting for another's build looks for the file. */
const POLL_MS = 1_000;

/** Every scene cachedScene can build, by key. Builders are loaded lazily (scenes.ts imports the harness, which imports this file). */
export const SCENES: Record<string, () => Promise<Uint8Array>> = {
  /** AC-2(b) and AC-3: the 8 × 6 × 2.5 m pit, 108 stakes on 0.6 m, the verb-built cover (§11.2(b), §11.3). */
  pit: async () => (await import('./scenes')).pitScene(),
  /** The harness test's own small scene (two driven stakes and a placed log): proves the cache without the pit's minutes. */
  probe: async () => (await import('./scenes')).probeScene(),
};

/** Every file the hash reads: packages/sim/src/** and tests/support/*.ts, by path, sorted. */
function hashedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(join(SIM_ROOT, 'src'));
  for (const name of readdirSync(HERE)) if (name.endsWith('.ts')) out.push(join(HERE, name));
  return out.sort();
}

/**
 * The sim's dependencies as installed (package-lock.json's entry for each of packages/sim/package.json's
 * dependencies: `name@version integrity`, sorted). A new Rapier changes every contact, so it rebuilds the scenes.
 */
export function dependencyFingerprint(): string {
  const deps = Object.keys((JSON.parse(readFileSync(join(SIM_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}).sort();
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: string; integrity?: string }> };
  return deps
    .map((d) => {
      const e = lock.packages?.[`node_modules/${d}`] ?? lock.packages?.[`packages/sim/node_modules/${d}`];
      return `${d}@${e?.version ?? '?'} ${e?.integrity ?? ''}`;
    })
    .join('\n');
}

/**
 * sha256(tuning + SAVE_FORMAT_VERSION + dependencyFingerprint() + the source texts), hex. `tuning` defaults to the
 * live tuningSnapshot(); `extra` is mixed in last (the harness test uses it to make a hash that differs from the tree's).
 */
export function sceneHash(extra = '', tuning = tuningSnapshot()): string {
  const h = createHash('sha256');
  h.update(tuning);
  h.update(`\nformat ${SAVE_FORMAT_VERSION}\n`);
  h.update(dependencyFingerprint());
  h.update('\0');
  for (const f of hashedFiles()) {
    h.update(relative(SIM_ROOT, f).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  h.update(extra);
  return h.digest('hex');
}

/**
 * What globalSetup provided (hash, the tuning it hashed, the run's tag), or this worker's own when it didn't run.
 * (vitest is imported here, in a worker, only: the main process loading this file as globalSetup must not.)
 */
export async function sceneContext(): Promise<{ hash: string; tuning: string; run: string }> {
  let hash: string | undefined;
  let tuning: string | undefined;
  let run: string | undefined;
  try {
    const { inject } = await import('vitest');
    hash = inject('sceneHash');
    tuning = inject('sceneTuning');
    run = inject('sceneRun');
  } catch {
    // Not in a Vitest worker (or no globalSetup): computed here.
  }
  if (hash && tuning && run) return { hash, tuning, run };
  const t = tuningSnapshot();
  return { hash: sceneHash('', t), tuning: t, run: `local ${process.pid}` };
}

/** The hash the workers use: globalSetup's, or the tree's now when no globalSetup ran. */
export async function currentSceneHash(): Promise<string> {
  return (await sceneContext()).hash;
}

export function scenePath(dir: string, key: string, hash: string): string {
  return join(dir, `${key}-${hash.slice(0, 16)}.json`);
}

function errorPath(dir: string, key: string, hash: string): string {
  return join(dir, `${key}-${hash.slice(0, 16)}.error.txt`);
}

/**
 * The scene file for (key, hash) in `dir`: reused when it exists (built: false), else `build()` is run, its bytes
 * written (atomically) and every other `<key>-*` file in `dir` removed, its own lock aside (built: true). No locking:
 * see sceneOnce.
 */
export async function ensureScene(dir: string, key: string, hash: string, build: () => Promise<Uint8Array>): Promise<{ path: string; built: boolean }> {
  if (!/^[a-zA-Z0-9]+$/.test(key)) throw new Error(`ensureScene: a scene key is letters and digits, not '${key}'`);
  const path = scenePath(dir, key, hash);
  if (existsSync(path)) return { path, built: false };
  const bytes = await build();
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p !== path && p !== `${path}.lock` && name.startsWith(`${key}-`)) rmSync(p, { force: true });
  }
  return { path, built: true };
}

/** Is the lock's holder gone (its pid no longer a process)? */
function staleLock(lock: string): boolean {
  let pid = NaN;
  try {
    pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
  } catch {
    return false; // being written or just removed: look again
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The scene's bytes for (key, hash), built at most once across processes: the file if it exists; else, holding
 * `<file>.lock`, `build()` (ensureScene); else (another process holds the lock) waits for it. A build that throws
 * leaves an error file tagged `run`: a call with the same run throws its text without building; another run's error
 * is cleared and the build tried again.
 */
export async function sceneOnce(dir: string, key: string, hash: string, run: string, build: () => Promise<Uint8Array>, o?: { pollMs?: number }): Promise<{ bytes: Uint8Array; built: boolean }> {
  const path = scenePath(dir, key, hash);
  const lock = `${path}.lock`;
  const err = errorPath(dir, key, hash);
  mkdirSync(dir, { recursive: true });
  for (;;) {
    if (existsSync(path)) return { bytes: new Uint8Array(readFileSync(path)), built: false };
    if (existsSync(err)) {
      const text = readFileSync(err, 'utf8');
      const nl = text.indexOf('\n');
      if (text.slice(0, nl) === `run ${run}`) throw new Error(`cachedScene('${key}'): its build failed earlier in this run:\n${text.slice(nl + 1)}`);
    }
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (staleLock(lock)) rmSync(lock, { force: true });
      else await sleep(o?.pollMs ?? POLL_MS);
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      if (existsSync(path)) continue; // finished between our look and our lock
      rmSync(err, { force: true });
      try {
        const r = await ensureScene(dir, key, hash, build);
        return { bytes: new Uint8Array(readFileSync(r.path)), built: r.built };
      } catch (e) {
        const text = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
        // Only this tree's error is kept (older ones name other hashes).
        for (const name of readdirSync(dir)) if (name.startsWith(`${key}-`) && name.endsWith('.error.txt')) rmSync(join(dir, name), { force: true });
        writeFileSync(err, `run ${run}\n${text}`);
        throw e;
      }
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

/** The scene's save bytes for the tree's hash in `dir` (no build); throws when it isn't there. */
export function readScene(dir: string, key: string, hash: string): Uint8Array {
  const path = scenePath(dir, key, hash);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  throw new Error(`readScene('${key}'): no scene for hash ${hash.slice(0, 16)} in ${dir}`);
}

/** Runs `f` on the tuning `snapshot`, then puts this process's tuning back. */
async function withTuning<T>(snapshot: string, f: () => Promise<T>): Promise<T> {
  const mine = tuningSnapshot();
  if (mine === snapshot) return f();
  restoreTuning(snapshot);
  try {
    return await f();
  } finally {
    restoreTuning(mine);
  }
}

const memo = new Map<string, Promise<Uint8Array>>();

/** cachedScene's work (worldHarness.ts): the bytes of `key` for this run's hash, built here if no one has. */
export function sceneBytes(key: string): Promise<Uint8Array> {
  let p = memo.get(key);
  if (!p) {
    p = (async () => {
      const build = SCENES[key];
      if (!build) throw new Error(`cachedScene('${key}'): no builder makes it (tests/support/globalSetup.ts SCENES)`);
      const ctx = await sceneContext();
      const r = await sceneOnce(SCENE_DIR, key, ctx.hash, ctx.run, () => withTuning(ctx.tuning, build));
      console.info(`[scenes] ${key}: ${r.built ? 'built' : 'reused'} (${relative(SIM_ROOT, scenePath(SCENE_DIR, key, ctx.hash))})`);
      return r.bytes;
    })();
    memo.set(key, p);
  }
  return p;
}

/** Vitest globalSetup (the sim project's, root vitest.config.ts). */
export default async function setup(project: TestProject): Promise<void> {
  const tuning = tuningSnapshot();
  const hash = sceneHash('', tuning);
  const run = String(process.pid);
  project.provide('sceneHash', hash);
  project.provide('sceneTuning', tuning);
  project.provide('sceneRun', run);
  // CI's warm-up: the scenes ROTW_SCENES lists, built before the workers start (the same lock and error file).
  for (const key of (process.env.ROTW_SCENES ?? '').split(',').map((k) => k.trim()).filter(Boolean)) {
    const build = SCENES[key];
    if (!build) {
      console.error(`[scenes] ROTW_SCENES names '${key}', which no builder makes (tests/support/globalSetup.ts SCENES)`);
      continue;
    }
    try {
      const r = await sceneOnce(SCENE_DIR, key, hash, run, build);
      console.info(`[scenes] ${key}: ${r.built ? 'built' : 'reused'} (${relative(SIM_ROOT, scenePath(SCENE_DIR, key, hash))})`);
    } catch (e) {
      console.error(`[scenes] ${key}: the build failed (the tests that need it will fail): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
