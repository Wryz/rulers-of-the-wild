// Cached test scenes (docs/M1-DESIGN.md §11.0, RF-11, RT-23; package P23). A Vitest `globalSetup` of the sim project
// (root vitest.config.ts): before any worker starts, it builds each scene a test file asks for by name
// (`cachedScene('pit')`) once, on a fresh world, through the harness and scenes.ts (entities and verbs only), and
// writes its save bytes to packages/sim/.cache/scenes/<key>-<hash>.json (gitignored; CI caches the directory). The
// hash is sha256(tuningSnapshot() + SAVE_FORMAT_VERSION + the text of packages/sim/src/** and tests/support/*.ts), so
// any change to the sim, its tuning or the recipes rebuilds the scene, and an unchanged tree reuses the file. Test files
// in different workers read the bytes with cachedScene(key) (worldHarness.ts) and load them with loadHarness.
//
// - A scene is built only when some test file names it (`cachedScene('<key>')` in packages/sim/tests/**/*.test.ts),
//   or when ROTW_SCENES lists it (comma-separated): `npm test` before the AC files exist builds nothing.
// - A scene whose build throws doesn't stop the run: the error is written next to where the scene would be
//   (<key>-<hash>.error.txt) and cachedScene(key) throws it, so only the tests that need the scene fail.
// - The hash is computed here, in the main process, and handed to the workers as ROTW_SCENE_HASH (a worker's
//   tuning may have been edited by an earlier test in it; the build's never is).
//
// Determinism: the scene is a pure function of the code and its tuning (rule 7), so a cached file is the scene any run
// of this tree would build.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../src/index';
import { SAVE_FORMAT_VERSION } from '../../src/save/schema';
import { tuningSnapshot } from '../../src/tuning/registry';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/sim */
export const SIM_ROOT = resolve(HERE, '../..');
export const SCENE_DIR = join(SIM_ROOT, '.cache', 'scenes');
const TESTS = join(SIM_ROOT, 'tests');

/** Every scene globalSetup can build, by key. Builders are loaded lazily (scenes.ts imports the harness, which imports this file). */
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
 * sha256(tuningSnapshot() + SAVE_FORMAT_VERSION + the source texts), hex. `extra` is mixed in last (the harness test
 * uses it to make a hash that differs from the tree's).
 */
export function sceneHash(extra = ''): string {
  const h = createHash('sha256');
  h.update(tuningSnapshot());
  h.update(`\nformat ${SAVE_FORMAT_VERSION}\n`);
  for (const f of hashedFiles()) {
    h.update(relative(SIM_ROOT, f).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  h.update(extra);
  return h.digest('hex');
}

/** The hash the workers use: globalSetup's (ROTW_SCENE_HASH), or the tree's now when no globalSetup ran. */
export function currentSceneHash(): string {
  return process.env.ROTW_SCENE_HASH ?? sceneHash();
}

export function scenePath(dir: string, key: string, hash: string): string {
  return join(dir, `${key}-${hash.slice(0, 16)}.json`);
}

function errorPath(dir: string, key: string, hash: string): string {
  return join(dir, `${key}-${hash.slice(0, 16)}.error.txt`);
}

/**
 * The scene file for (key, hash) in `dir`: reused when it exists (built: false), else `build()` is run, its bytes
 * written (atomically) and every other `<key>-*` file in `dir` removed (built: true).
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
    if (p !== path && name.startsWith(`${key}-`)) rmSync(p, { force: true });
  }
  return { path, built: true };
}

/** The scene's save bytes for the tree's hash (see the top of this file); throws when it wasn't built or its build failed. */
export function readScene(dir: string, key: string, hash: string): Uint8Array {
  const path = scenePath(dir, key, hash);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const err = errorPath(dir, key, hash);
  if (existsSync(err)) throw new Error(`cachedScene('${key}'): its build failed in globalSetup:\n${readFileSync(err, 'utf8')}`);
  throw new Error(
    `cachedScene('${key}'): no scene for hash ${hash.slice(0, 16)} in ${dir}. tests/support/globalSetup.ts builds it when a test file names it; run the tests through the root vitest.config.ts (npm test, npx vitest run …).`,
  );
}

/** The keys some test file asks for (`cachedScene('key')`), and those ROTW_SCENES lists. */
export function wantedScenes(): string[] {
  const keys = new Set<string>();
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) {
        if (p !== HERE) walk(p);
      } else if (d.name.endsWith('.test.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/cachedScene\(\s*['"]([a-zA-Z0-9]+)['"]\s*\)/g)) keys.add(m[1]);
      }
    }
  };
  walk(TESTS);
  for (const k of (process.env.ROTW_SCENES ?? '').split(',')) if (k.trim()) keys.add(k.trim());
  return [...keys].sort();
}

/** Vitest globalSetup (the sim project's, root vitest.config.ts). */
export default async function setup(): Promise<void> {
  const hash = sceneHash();
  process.env.ROTW_SCENE_HASH = hash;
  for (const key of wantedScenes()) {
    const build = SCENES[key];
    if (!build) {
      console.error(`[scenes] a test asks for cachedScene('${key}'), which no builder makes (tests/support/globalSetup.ts SCENES)`);
      continue;
    }
    const err = errorPath(SCENE_DIR, key, hash);
    rmSync(err, { force: true });
    try {
      const r = await ensureScene(SCENE_DIR, key, hash, build);
      console.info(`[scenes] ${key}: ${r.built ? 'built' : 'reused'} (${relative(SIM_ROOT, r.path)})`);
    } catch (e) {
      mkdirSync(SCENE_DIR, { recursive: true });
      const text = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      // Only this tree's error is kept (older ones name other hashes).
      for (const name of readdirSync(SCENE_DIR)) if (name.startsWith(`${key}-`) && name.endsWith('.error.txt')) rmSync(join(SCENE_DIR, name), { force: true });
      writeFileSync(err, text);
      console.error(`[scenes] ${key}: the build failed (the tests that need it will fail): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
