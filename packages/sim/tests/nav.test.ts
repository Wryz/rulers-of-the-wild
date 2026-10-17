// Navigation (docs/M1-DESIGN.md §1.5.9, §4.1, §7; package P12): two tiled recast navmeshes (human r 0.4 m, ruler
// r 1.65 m), the dirty-tile queue rebuilt a fixed number of tiles per tick, position-only paths, the per-tile walk and
// blocker bitmaps NavWalkable reads, and determinism.
//
// Scenes are built from entities created directly through the entity store (trunks as fixed 8-gon prisms, logs as
// 6-gon prisms, walls and covers as boxes); P07's factory is not used. Scene numbers (gap widths, pit sizes, query
// counts, thresholds) are test constants, never tuning (§9).
import { Raw } from 'recast-navigation';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Rng } from '../src/sim/math';
import { resetTuning } from '../src/tuning/registry';
import { NAV_LAYERS, NAV_TUNING, type NavLayer, type NavPath, NavSystem, NavWalkable } from '../src/world/nav';
import { navBakeEntity } from '../src/world/navInput';
import { physicsReady } from '../src/world/physics';
import type { Entity, MaterialId, Quat, V3 } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

/** Builds of the 100 m and 200 m scenes take seconds on a loaded machine (§11's convention: explicit timeouts). */
vi.setConfig({ testTimeout: 600_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'full', player: false, size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('NAV_TUNING');
  resetTuning('PHYSICS_TUNING');
});

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

const ID_Q: Quat = { x: 0, y: 0, z: 0, w: 1 };
/**
 * A prism's axis (+Y) turned onto the x or z axis (−90° about z; then +90° about y for z), so a 6- or 8-gon prism, whose
 * vertex k sits at (k + ½)·2π/N, lies on one of its flat faces.
 */
const ALONG_X: Quat = { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 };
const ALONG_Z: Quat = { x: -0.5, y: 0.5, z: -0.5, w: 0.5 };

/** Quaternion product a·b (b applied first). */
function mulQ(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

const nav = (w: World): NavSystem => w.nav!;
const at = (w: World, x: number, z: number): V3 => ({ x, y: w.terrain.heightAt(x, z), z });

/** Rolling hills (the MAP recast lab's), flat within `flatR` of every listed site. */
function hills(w: World, flat: { x: number; z: number; r: number }[]): void {
  w.terrain.generate((x, z) => {
    const h = 3 * Math.sin(x / 23) * Math.cos(z / 17) + 1.5 * Math.sin(x / 7 + z / 11);
    let k = 1;
    for (const f of flat) {
      const d = Math.max(Math.abs(x - f.x), Math.abs(z - f.z));
      const t = Math.min(1, Math.max(0, (d - f.r) / 10));
      k = Math.min(k, t * t * (3 - 2 * t));
    }
    return h * k;
  });
}

/** The lowest terrain height within `r` of (x, z) (a trunk's bottom sinks below it). */
function lowest(w: World, x: number, z: number, r: number): number {
  let h = Infinity;
  for (let dz = -r; dz <= r + 1e-9; dz += r / 4) for (let dx = -r; dx <= r + 1e-9; dx += r / 4) h = Math.min(h, w.terrain.heightAt(x + dx, z + dz));
  return h;
}

/** A standing trunk: a fixed 8-gon prism `across` m between opposite flat faces, its bottom 0.3 m into the ground. */
function trunk(w: World, x: number, z: number, across: number, height = 8): Entity {
  const r = across / 2 / Math.cos(Math.PI / 8);
  const y0 = lowest(w, x, z, r) - 0.3;
  return w.entities.create({
    material: 'greenWood',
    shape: { kind: 'cylinder', halfHeight: height / 2, r, sides: 8 },
    p: { x, y: y0 + height / 2, z },
    state: 'fixed',
    look: 'tree',
    plant: { diameter: across, height },
  });
}

/** A fixed or free box (walls, covers, blocks). */
function box(w: World, c: V3, h: [number, number, number], o: { state?: 'free' | 'fixed'; material?: MaterialId; q?: Quat } = {}): Entity {
  return w.entities.create({
    material: o.material ?? 'stone',
    shape: { kind: 'box', hx: h[0], hy: h[1], hz: h[2] },
    p: c,
    q: o.q ?? ID_Q,
    state: o.state ?? 'fixed',
    look: 'box',
  });
}

/** A log: a 6-gon prism of circumradius r lying on a flat face, centred at (x, z) on the terrain. */
function log(w: World, x: number, z: number, o: { length: number; r: number; along: 'x' | 'z'; state?: 'free' | 'fixed' | 'anchored'; material?: MaterialId }): Entity {
  const apothem = o.r * Math.cos(Math.PI / 6);
  return w.entities.create({
    material: o.material ?? 'greenWood',
    shape: { kind: 'cylinder', halfHeight: o.length / 2, r: o.r, sides: 6 },
    // A 6-gon's vertex k sits at (k + ½)·60°, so lying along x or z it rests on a flat face at the apothem.
    p: { x, y: w.terrain.heightAt(x, z) + apothem + 0.005, z },
    q: o.along === 'x' ? ALONG_X : ALONG_Z,
    state: o.state ?? 'free',
    look: 'log',
  });
}

/** Digs a rectangular pit by cone strikes on a 0.25 m grid until it is `depth` deep (the kernel's 3 m floor caps it). */
function digPit(w: World, cx: number, cz: number, hx: number, hz: number, depth: number): void {
  const mul = depth / 0.15;
  for (let z = cz - hz; z <= cz + hz + 1e-9; z += 0.25) for (let x = cx - hx; x <= cx + hx + 1e-9; x += 0.25) w.terrain.lower(x, z, mul);
}

/**
 * Lets the worker's event loop run (Vitest's RPC replies arrive as messages: a worker that computes for a minute
 * without yielding on a loaded machine times its own RPC out). Long tests call it between batches.
 */
const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Steps the world until `done` holds (or throws after `max` ticks). */
function stepUntil(w: World, done: () => boolean, max: number, what: string): number {
  for (let k = 0; k < max; k++) {
    if (done()) return k;
    w.step();
  }
  if (done()) return max;
  throw new Error(`stepUntil: ${what} not reached in ${max} ticks`);
}

/** Steps until the scan has nothing new and the dirty queue is empty. */
function drain(w: World, max = 600): void {
  w.step();
  stepUntil(w, () => nav(w).dirtyQueue().length === 0, max, 'an empty dirty queue');
}

function versions(w: World, layer: NavLayer): number[] {
  const n = nav(w).grid(layer);
  return Array.from({ length: n.tilesX * n.tilesZ }, (_, t) => nav(w).tileVersion(layer, t));
}

function changedTiles(before: number[], after: number[]): number[] {
  return after.map((v, t) => (v !== before[t] ? t : -1)).filter((t) => t >= 0);
}

function pathLength(p: readonly V3[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
  return s;
}

/** Points every 5 cm along a path's polyline (ground plane). */
function along(p: readonly V3[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 1; i < p.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z) / 0.05));
    for (let k = 0; k <= n; k++) out.push({ x: p[i - 1].x + ((p[i].x - p[i - 1].x) * k) / n, z: p[i - 1].z + ((p[i].z - p[i - 1].z) * k) / n });
  }
  return out;
}

/** A path as exact text (every coordinate at full precision). */
const pathText = (p: NavPath): string => JSON.stringify([p.complete, p.points.map((q) => [q.x, q.y, q.z])]);

/** The recast query of a layer (tests reproduce recast's own traps through it). */
function rawQuery(n: NavSystem, layer: NavLayer) {
  return (n as unknown as { layers: { query: { computePath(a: V3, b: V3, o: { halfExtents: V3 }): { success: boolean; path: V3[] } } }[] }).layers[NAV_LAYERS.indexOf(layer)].query;
}

/** The poly ref recast returns for the polygon nearest `p` (0: none), as the binding hands it back. */
function rawNearestRef(n: NavSystem, layer: NavLayer, p: V3): number {
  const q = (n as unknown as { layers: { query: { findNearestPoly(p: V3, o: { halfExtents: V3 }): { nearestRef: number } } }[] }).layers[NAV_LAYERS.indexOf(layer)].query;
  return q.findNearestPoly(p, { halfExtents: { x: 1, y: 2, z: 1 } }).nearestRef;
}

/** A fence along z = 0 across the whole world with one opening `gap` m wide between two 1 m trunks at x = 0. */
function gate(w: World, gap: number): void {
  const across = 1;
  const cx = gap / 2 + across / 2;
  trunk(w, -cx, 0, across);
  trunk(w, cx, 0, across);
  const half = w.options.size / 2 + 2;
  const len = (half - cx) / 2;
  box(w, { x: -cx - len, y: 1.5, z: 0 }, [len, 1.5, 0.3]);
  box(w, { x: cx + len, y: 1.5, z: 0 }, [len, 1.5, 0.3]);
}

// ---------------------------------------------------------------------------
// The two layers
// ---------------------------------------------------------------------------

describe('two layers, two agent sizes (§7, MAP recast §9)', () => {
  it('converts metres to voxels with ceil for radius and height and floor for climb, as the design table says', async () => {
    const w = await make();
    const s = (layer: NavLayer) => (nav(w) as unknown as { layers: { spec: { radiusVox: number; heightVox: number; climbVox: number; tcs: number; extrudeM: number | null } }[] }).layers[NAV_LAYERS.indexOf(layer)].spec;
    expect([s('human').radiusVox, s('human').heightVox, s('human').climbVox, s('human').tcs]).toEqual([2, 9, 2, 6.4]);
    expect([s('ruler').radiusVox, s('ruler').heightVox, s('ruler').climbVox, s('ruler').tcs]).toEqual([4, 40, 4, 16]);
    expect(s('human').extrudeM).toBeNull();
    expect(s('ruler').extrudeM).toBeCloseTo(9.75, 12);
    expect(nav(w).grid('human')).toMatchObject({ tilesX: 8, tilesZ: 8, cellM: 0.2, cellsPerTile: 32 });
    expect(nav(w).grid('ruler')).toMatchObject({ tilesX: 4, tilesZ: 4 });
  });

  it('a 2 m gap between trunks passes a person and blocks the giant', async () => {
    const w = await make();
    gate(w, 2);
    nav(w).build(w);
    const n = nav(w);
    // A person: a ray along the surface goes through, a path through the gap reaches the far side.
    expect(n.raycast('human', at(w, 0, -6), at(w, 0, 6)).clear).toBe(true);
    const ph = n.findPath('human', at(w, 0, -10), at(w, 0, 10));
    expect(ph.complete).toBe(true);
    expect(pathLength(ph.points)).toBeLessThan(20.5);
    for (const q of along(ph.points)) if (Math.abs(q.z) < 0.5) expect(Math.abs(q.x)).toBeLessThan(1);
    expect(n.isWalkable('human', 0, 0)).toBe(true);
    // The giant: the ray stops at the fence, no polygon in the gap, and the path is partial (it never gets across).
    const r = n.raycast('ruler', at(w, 0, -6), at(w, 0, 6));
    expect(r.clear).toBe(false);
    expect(r.t).toBeLessThan(0.5);
    expect(n.isWalkable('ruler', 0, 0)).toBe(false);
    const pr = n.findPath('ruler', at(w, 0, -10), at(w, 0, 10));
    expect(pr.complete).toBe(false);
    for (const q of pr.points) expect(q.z).toBeLessThan(0);
    // A wider gap (6 m: 2 m left after 2 × 2 m of erosion) lets the giant through too: it is the radius that blocks.
    const w5 = await make({ seed: 2 });
    gate(w5, 6);
    nav(w5).build(w5);
    expect(nav(w5).raycast('ruler', at(w5, 0, -6), at(w5, 0, 6)).clear).toBe(true);
    expect(nav(w5).findPath('ruler', at(w5, 0, -10), at(w5, 0, 10)).complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('paths: positions only, nearestRef 0 and partial paths (§7, MAP recast §7.1-7.2)', () => {
  it('reports nearestRef 0 as null and no path, and a partial path (which recast calls a success) as not complete', async () => {
    const w = await make();
    // A 6 × 6 × 5 m block: no polygon within the (2, 4, 2) m half-extents of its centre (its inside is solid, its top
    // out of reach).
    box(w, { x: 10, y: 2.5, z: 10 }, [3, 2.5, 3]);
    // A closed ring of 1 m trunks (0.3 m gaps): polygons inside it, no way in.
    const ring = { x: -10, z: -10, R: 6 };
    const step = 2 * Math.asin(1.3 / (2 * ring.R));
    const count = Math.ceil((2 * Math.PI) / step);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * 2 * Math.PI;
      trunk(w, ring.x + Math.cos(a) * ring.R, ring.z + Math.sin(a) * ring.R, 1);
    }
    nav(w).build(w);
    const n = nav(w);

    expect(n.nearest('human', at(w, 10, 10))).toBeNull();
    expect(n.nearest('human', { x: 0, y: 30, z: 0 })).toBeNull();
    expect(n.findPath('human', at(w, 0, 0), at(w, 10, 10))).toEqual({ points: [], complete: false, tiles: [], versions: [] });
    expect(n.raycast('human', at(w, 10, 10), at(w, 0, 0))).toEqual({ clear: false, t: 0 });
    const open = n.nearest('human', at(w, 0, 0));
    expect(open).not.toBeNull();
    expect(Math.hypot(open!.x, open!.z)).toBeLessThan(1e-3);

    const target = at(w, ring.x, ring.z);
    expect(n.nearest('human', target)).not.toBeNull();
    const p = n.findPath('human', at(w, -10, 10), target);
    expect(p.points.length).toBeGreaterThanOrEqual(2);
    expect(p.complete).toBe(false);
    const last = p.points[p.points.length - 1];
    expect(Math.hypot(last.x - target.x, last.z - target.z)).toBeGreaterThan(4);
    // The trap the check exists for: recast's own computePath calls the same partial path a success.
    const raw = rawQuery(n, 'human').computePath(at(w, -10, 10), target, { halfExtents: { x: 2, y: 4, z: 2 } });
    expect(raw.success).toBe(true);
    expect(raw.path.length).toBeGreaterThanOrEqual(2);
  });

  it('paths on Clearing-like terrain: hills and 60 trunks over 200 m, both layers, on the ground, with their tiles', async () => {
    // Built once (a nav-off world and its own NavSystem): the 200 m build is the slow part.
    const w = await make({ size: 200, nav: 'off' });
    hills(w, []);
    const rng = new Rng(1234);
    const trees: { x: number; z: number }[] = [];
    while (trees.length < 60) {
      const x = rng.range(-90, 90);
      const z = rng.range(-90, 90);
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 4)) continue;
      trees.push({ x, z });
      trunk(w, x, z, rng.range(0.2, 0.6), rng.range(8, 16));
    }
    await yieldToLoop();
    const n = new NavSystem(w);
    n.build(w);
    await yieldToLoop();
    expect(n.buildFailures).toBe(0);
    const q = new Rng(99);
    for (const layer of NAV_LAYERS) {
      let tried = 0;
      let complete = 0;
      while (tried < 200) {
        if (tried % 25 === 0) await yieldToLoop();
        const a = n.nearest(layer, at(w, q.range(-95, 95), q.range(-95, 95)));
        const b = n.nearest(layer, at(w, q.range(-95, 95), q.range(-95, 95)));
        if (!a || !b) continue;
        tried++;
        const p = n.findPath(layer, a, b);
        if (!p.complete) continue;
        complete++;
        expect(Math.hypot(p.points[0].x - a.x, p.points[0].z - a.z)).toBeLessThan(1e-3);
        const end = p.points[p.points.length - 1];
        expect(Math.hypot(end.x - b.x, end.z - b.z)).toBeLessThan(1e-3);
        for (const pt of p.points) {
          expect(Object.keys(pt).sort()).toEqual(['x', 'y', 'z']);
          // Navmesh heights are approximate (MAP recast §7): within a voxel or two of the terrain.
          expect(Math.abs(pt.y - w.terrain.heightAt(pt.x, pt.z))).toBeLessThan(0.75);
        }
        expect(p.tiles.length).toBeGreaterThan(0);
        expect([...p.tiles].sort((x, y) => x - y)).toEqual(p.tiles);
        expect(p.versions).toEqual(p.tiles.map((t) => n.tileVersion(layer, t)));
      }
      // Every pair of snapped points on this open, connected terrain is reachable on the person's layer; the giant's
      // misses only points stranded between close trunks.
      console.log(`Clearing-like terrain, ${layer} layer: ${complete} of ${tried} paths complete`);
      expect(complete).toBeGreaterThanOrEqual(layer === 'human' ? 198 : 180);
    }
    n.dispose();
  });

  it('re-paths after tile changes: a wall across the path bumps the versions of tiles it crosses', async () => {
    const w = await make();
    const n = nav(w);
    const a = at(w, 0, -15);
    const b = at(w, 0, 15);
    const before = n.findPath('human', a, b);
    expect(before.complete).toBe(true);
    expect(pathLength(before.points)).toBeCloseTo(30, 1);
    box(w, { x: 0, y: 1, z: 0 }, [6, 1, 0.3]);
    drain(w);
    const stale = before.tiles.filter((t, i) => n.tileVersion('human', t) !== before.versions[i]);
    expect(stale.length).toBeGreaterThan(0);
    const after = n.findPath('human', a, b);
    expect(after.complete).toBe(true);
    expect(pathLength(after.points)).toBeGreaterThan(31);
    // A tile far from the wall kept its version.
    const far = n.tileAt('human', 20, 20);
    expect(n.tileVersion('human', far)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dirty tiles
// ---------------------------------------------------------------------------

describe('dirty tiles and rebuilds (§7, phase 16)', () => {
  it('rebuilds at most tilesPerTick per layer per tick, in (layer, ty, tx) order; the queue round-trips', async () => {
    const w = await make();
    const n = nav(w);
    n.markDirty({ min: { x: -12, y: 0, z: -12 }, max: { x: 12, y: 1, z: 12 } }, 'test');
    const q0 = n.dirtyQueue();
    expect(q0.length).toBeGreaterThan(10);
    expect([...q0].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])).toEqual(q0);
    const other = await make({ seed: 2 });
    nav(other).restoreDirty(q0);
    expect(nav(other).dirtyQueue()).toEqual(q0);
    expect(() => nav(other).restoreDirty([[0, 99, 0]])).toThrow();

    let q = q0;
    let ticks = 0;
    while (q.length > 0) {
      const vh = versions(w, 'human');
      const vr = versions(w, 'ruler');
      n.rebuildDirty();
      ticks++;
      const next = n.dirtyQueue();
      const human = q.filter((e) => e[0] === 0);
      const ruler = q.filter((e) => e[0] === 1);
      const done = [...human.slice(0, NAV_TUNING.human.tilesPerTick), ...ruler.slice(0, NAV_TUNING.ruler.tilesPerTick)];
      expect(next).toEqual(q.filter((e) => !done.includes(e)));
      const tileOf = (e: [number, number, number], layer: NavLayer) => e[1] * n.grid(layer).tilesX + e[2];
      expect(changedTiles(vh, versions(w, 'human'))).toEqual(done.filter((e) => e[0] === 0).map((e) => tileOf(e, 'human')));
      expect(changedTiles(vr, versions(w, 'ruler'))).toEqual(done.filter((e) => e[0] === 1).map((e) => tileOf(e, 'ruler')));
      q = next;
    }
    expect(ticks).toBe(Math.max(Math.ceil(q0.filter((e) => e[0] === 0).length / 2), q0.filter((e) => e[0] === 1).length));
  });

  it('a tile rebuilt 600 times (its salt past bit 31) stays walkable, stays in its paths and still bumps their versions', async () => {
    // Detour's 32-bit refs hold the tile's salt in their top 10 bits, bumped on every rebuild of the tile: past 511
    // rebuilds bit 31 is set and the binding returns the tile's refs as negative numbers. A pit dug strike by strike
    // re-marks its tile thousands of times, so the slot lookup (isWalkable, findPath's tiles) must read refs as uint32.
    const w = await make();
    const n = nav(w);
    const p = { x: 3, z: 3 };
    const tiles = { human: n.tileAt('human', p.x, p.z), ruler: n.tileAt('ruler', p.x, p.z) };
    const mark = () => n.markDirty({ min: { x: p.x, y: 0, z: p.z }, max: { x: p.x, y: 0, z: p.z } }, 'test');
    mark();
    const grid = (layer: NavLayer) => n.grid(layer).tilesX;
    expect(n.dirtyQueue()).toEqual(
      NAV_LAYERS.map((layer, l) => [l, Math.floor(tiles[layer] / grid(layer)), tiles[layer] % grid(layer)] as [number, number, number]),
    );
    const v0 = NAV_LAYERS.map((layer) => n.tileVersion(layer, tiles[layer]));
    for (let i = 0; i < 600; i++) {
      if (i > 0) mark();
      n.rebuildDirty();
      if (i % 100 === 0) await yieldToLoop();
    }
    expect(NAV_LAYERS.map((layer) => n.tileVersion(layer, tiles[layer]))).toEqual(v0.map((v) => v + 600));
    expect(n.buildFailures).toBe(0);
    const walk = new NavWalkable(w);
    const routes: Record<NavLayer, [V3, V3]> = { human: [at(w, p.x, -10), at(w, p.x, 10)], ruler: [at(w, -20, p.z), at(w, 20, p.z)] };
    for (const layer of NAV_LAYERS) {
      // The case under test: the tile's refs have bit 31 set now.
      expect(rawNearestRef(n, layer, at(w, p.x, p.z)) >>> 0).toBeGreaterThanOrEqual(2 ** 31);
      expect(n.isWalkable(layer, p.x, p.z)).toBe(true);
      const path = n.findPath(layer, ...routes[layer]);
      expect(path.complete).toBe(true);
      expect(path.tiles).toContain(tiles[layer]);
      expect(path.versions[path.tiles.indexOf(tiles[layer])]).toBe(n.tileVersion(layer, tiles[layer]));
      // One more rebuild: the path's version of the tile goes stale (a mind following it re-paths, §6.5).
      mark();
      n.rebuildDirty();
      expect(n.tileVersion(layer, tiles[layer])).not.toBe(path.versions[path.tiles.indexOf(tiles[layer])]);
      expect(n.isWalkable(layer, p.x, p.z)).toBe(true);
      expect(n.findPath(layer, ...routes[layer]).tiles).toContain(tiles[layer]);
    }
    // The walk bitmap of the tile still agrees with the recast query.
    const g = n.grid('human');
    const q = new Rng(21);
    const x0 = g.origX + (tiles.human % g.tilesX) * g.tileM;
    const z0 = g.origZ + Math.floor(tiles.human / g.tilesX) * g.tileM;
    for (let i = 0; i < 100; i++) {
      const x = q.range(x0, x0 + g.tileM);
      const z = q.range(z0, z0 + g.tileM);
      expect(walk.isWalkable(x, z), `(${x}, ${z})`).toBe(n.isWalkable('human', x, z));
    }
  });

  it('the scan marks placing, coming to rest, moving more than 0.25 m, picking up and removing; not a falling body or a nudge', async () => {
    const w = await make();
    const n = nav(w);
    const tile = (x: number, z: number) => n.tileAt('human', x, z);

    // Placing a fixed block: its tile is rebuilt.
    let v = versions(w, 'human');
    const block = box(w, { x: 5, y: 0.5, z: 5 }, [0.5, 0.5, 0.5]);
    drain(w);
    expect(changedTiles(v, versions(w, 'human'))).toContain(tile(5, 5));
    expect(changedTiles(v, versions(w, 'human'))).not.toContain(tile(-20, -20));
    expect(n.bakedIds()).toContain(block.id);

    // A free log dropped from 1 m: not input while it falls, input once at rest.
    const lg = log(w, -5, -5, { length: 3, r: 0.15, along: 'x' });
    w.entities.setPose(lg, { p: { x: -5, y: 1.2, z: -5 }, q: ALONG_X });
    v = versions(w, 'human');
    for (let k = 0; k < 5; k++) w.step();
    expect(n.bakedIds()).not.toContain(lg.id);
    expect(n.dirtyQueue()).toEqual([]);
    stepUntil(w, () => n.bakedIds().includes(lg.id), 600, 'the log at rest');
    drain(w);
    expect(changedTiles(v, versions(w, 'human'))).toContain(tile(-5, -5));

    // A nudge of 10 cm changes nothing; a move of 1 m rebuilds both places.
    v = versions(w, 'human');
    w.entities.setPose(lg, { p: { x: lg.pose.p.x + 0.1, y: lg.pose.p.y, z: lg.pose.p.z }, q: lg.pose.q });
    for (let k = 0; k < 40; k++) w.step();
    expect(changedTiles(v, versions(w, 'human'))).toEqual([]);
    w.entities.setPose(lg, { p: { x: -5, y: lg.pose.p.y, z: 5.5 }, q: lg.pose.q });
    drain(w);
    const moved = changedTiles(v, versions(w, 'human'));
    expect(moved).toContain(tile(-5, -5));
    expect(moved).toContain(tile(-5, 5.5));

    // Picked up (held): its footprint clears at once.
    v = versions(w, 'human');
    w.entities.setState(lg, 'held');
    w.step();
    expect(n.bakedIds()).not.toContain(lg.id);
    drain(w);
    expect(changedTiles(v, versions(w, 'human'))).toContain(tile(-5, 5.5));

    // Removed.
    v = versions(w, 'human');
    w.removeEntity(block.id);
    drain(w);
    expect(changedTiles(v, versions(w, 'human'))).toContain(tile(5, 5));
    expect(n.bakedIds()).not.toContain(block.id);
    expect(n.dirtyReasons.get('entity removed')).toBeGreaterThanOrEqual(2);
  });

  it('the full build bakes free entities placed still (as generation places them), so their settling rebuilds nothing', async () => {
    const w = await make();
    const n = nav(w);
    // Logs and blocks placed at rest on the ground, as the Clearing's generator places its free entities (awake,
    // restTicks 0, zero velocity), then a full build (createWorld builds after generation; loadWorld after loading).
    const still = [
      log(w, -8, -8, { length: 3, r: 0.15, along: 'x' }),
      log(w, 8, -4, { length: 4, r: 0.2, along: 'z' }),
      log(w, -6, 9, { length: 2.5, r: 0.12, along: 'x' }),
      box(w, { x: 10, y: 0.25, z: 10 }, [0.25, 0.25, 0.25], { state: 'free' }),
    ];
    // A log thrown in the same tick is moving: not input until it rests.
    const thrown = w.entities.create({
      material: 'greenWood',
      shape: { kind: 'cylinder', halfHeight: 1, r: 0.1, sides: 6 },
      p: { x: 0, y: 2, z: -12 },
      q: ALONG_X,
      lin: { x: 0, y: 2, z: 0 },
      state: 'free',
      look: 'log',
    });
    for (const e of still) expect(e.restTicks).toBe(0);
    n.build(w);
    expect(n.bakedIds()).toEqual(still.map((e) => e.id));
    const v = { human: versions(w, 'human'), ruler: versions(w, 'ruler') };
    const reasons = new Map(n.dirtyReasons);
    // They settle (within millimetres) and reach restTicks: nothing is marked or rebuilt.
    stepUntil(w, () => still.every((e) => e.restTicks >= 30) && n.bakedIds().includes(thrown.id), 600, 'the entities at rest');
    const settled = n.dirtyReasons.get('entity placed or at rest') ?? 0;
    expect(settled - (reasons.get('entity placed or at rest') ?? 0)).toBe(1);
    drain(w);
    const human = changedTiles(v.human, versions(w, 'human'));
    for (const e of still) expect(human).not.toContain(n.tileAt('human', e.pose.p.x, e.pose.p.z));
    expect(human).toContain(n.tileAt('human', thrown.pose.p.x, thrown.pose.p.z));
    expect(n.dirtyReasons.get('entity moved or changed') ?? 0).toBe(reasons.get('entity moved or changed') ?? 0);
  });

  it('felling a tree: the footprint clears at once, the trunk at rest; rebuilt tiles give the same paths as a fresh build over 1,200 queries', async () => {
    const w = await make({ size: 100 });
    hills(w, [{ x: 0, z: 0, r: 15 }]);
    const rng = new Rng(7);
    let placed = 0;
    while (placed < 20) {
      const x = rng.range(-45, 45);
      const z = rng.range(-45, 45);
      if (Math.max(Math.abs(x), Math.abs(z)) < 18) continue;
      trunk(w, x, z, rng.range(0.25, 0.6), 10);
      placed++;
    }
    const tree = trunk(w, 0, 0, 0.6, 10);
    nav(w).build(w);
    const n = nav(w);
    const through = () => n.findPath('human', at(w, 0, -6), at(w, 0, 6));
    const across = () => n.findPath('human', at(w, 7, -6), at(w, 7, 6));
    const throughBefore = through();
    expect(throughBefore.complete).toBe(true);
    expect(pathLength(throughBefore.points)).toBeGreaterThan(12.05);
    expect(pathLength(across().points)).toBeLessThan(12.05);

    // Fell it: free, lying along +x on the flat ground (as felling.ts leaves a trunk).
    const r = 0.3 / Math.cos(Math.PI / 8);
    w.entities.setState(tree, 'free');
    w.entities.setPose(tree, { p: { x: 7, y: r * Math.cos(Math.PI / 8) + 0.01, z: 0 }, q: ALONG_X });
    w.step();
    expect(n.bakedIds()).not.toContain(tree.id);
    expect(n.dirtyReasons.get('entity unanchored')).toBe(1);
    stepUntil(w, () => n.bakedIds().includes(tree.id), 1200, 'the trunk at rest');
    drain(w);
    stepUntil(w, () => tree.body!.isSleeping(), 1200, 'the trunk asleep');
    drain(w);
    // The standing trunk is gone from the path through it; the lying one blocks the path across it.
    expect(pathLength(through().points)).toBeLessThan(12.05);
    expect(pathLength(across().points)).toBeGreaterThan(12.5);

    await yieldToLoop();
    const fresh = new NavSystem(w);
    fresh.build(w);
    try {
      expect(fresh.bakedIds()).toEqual(n.bakedIds());
      const q = new Rng(4242);
      const pairs: [V3, V3][] = [];
      for (let i = 0; i < 1000; i++) pairs.push([at(w, q.range(-48, 48), q.range(-48, 48)), at(w, q.range(-48, 48), q.range(-48, 48))]);
      for (let i = 0; i < 200; i++) pairs.push([at(w, q.range(-15, 15), q.range(-15, 15)), at(w, q.range(-15, 15), q.range(-15, 15))]);
      for (const layer of NAV_LAYERS) {
        let differ = 0;
        let found = 0;
        for (const [i, [a, b]] of pairs.entries()) {
          if (i % 100 === 0) await yieldToLoop();
          const pi = n.findPath(layer, a, b);
          const pf = fresh.findPath(layer, a, b);
          if (pi.points.length > 0) found++;
          if (pathText(pi) !== pathText(pf)) differ++;
        }
        expect(differ).toBe(0);
        expect(found).toBeGreaterThan(900);
      }
    } finally {
      fresh.dispose();
    }
  });

  it('a dug pit makes a detour on the human layer', async () => {
    const w = await make();
    const n = nav(w);
    const a = at(w, 0, -10);
    const b = at(w, 0, 10);
    const before = n.findPath('human', a, b);
    expect(before.complete).toBe(true);
    expect(before.points.length).toBe(2);
    const vh = versions(w, 'human');
    const vr = versions(w, 'ruler');
    digPit(w, 0, 0, 2, 2, 2.5);
    expect(w.terrain.heightAt(0, 0)).toBeLessThan(-2.4);
    drain(w);
    // Both layers rebuilt the tiles under the dig (terrain edits are found by the scan).
    expect(changedTiles(vh, versions(w, 'human'))).toContain(n.tileAt('human', 0, 0));
    expect(changedTiles(vr, versions(w, 'ruler'))).toContain(n.tileAt('ruler', 0, 0));
    expect(n.dirtyReasons.get('terrain edit')).toBeGreaterThan(0);
    const after = n.findPath('human', a, b);
    expect(after.complete).toBe(true);
    expect(after.points.length).toBeGreaterThan(2);
    expect(pathLength(after.points)).toBeGreaterThan(20.5);
    for (const q of along(after.points)) expect(Math.max(Math.abs(q.x), Math.abs(q.z))).toBeGreaterThan(2.4);
  });

  it('a covered pit stays walkable on the ruler layer while a staked surface log is extruded', async () => {
    const w = await make({ size: 75 });
    const n = nav(w);
    // The pit: 6 × 4 m, 2.5 m deep, nine stakes on its floor, three light slabs across it (resting on the rims).
    const pit = { x: -15, z: 0 };
    digPit(w, pit.x, pit.z, 3, 2, 2.5);
    const stakes: Entity[] = [];
    for (const dx of [-2, 0, 2]) {
      for (const dz of [-1, 0, 1]) {
        const x = pit.x + dx;
        const z = pit.z + dz;
        const g = w.terrain.heightAt(x, z);
        stakes.push(
          w.entities.create({ material: 'greenWood', shape: { kind: 'cylinder', halfHeight: 0.65, r: 0.05, sides: 8 }, p: { x, y: g + 0.35, z }, state: 'anchored', look: 'stake' }),
        );
      }
    }
    const slabs = [-1.8, 0, 1.8].map((dz) => box(w, { x: pit.x, y: 0.06, z: pit.z + dz }, [4, 0.05, 0.89], { state: 'free', material: 'leaves' }));
    // A staked log (fixed) on the surface, and a light free log of about its height the giant can step over.
    const staked = log(w, 10, -12, { length: 12, r: 0.3, along: 'x', state: 'fixed' });
    const light = log(w, 10, 12, { length: 6, r: 0.25, along: 'x', material: 'rottenWood' });
    // A staked log lying diagonally (along (1, 0, 1)): its extrusion follows the log, not its 7 m-square AABB.
    const diag = { x: -12, z: 24 };
    const diagonal = log(w, diag.x, diag.z, { length: 10, r: 0.3, along: 'x', state: 'fixed' });
    w.entities.setPose(diagonal, { p: diagonal.pose.p, q: mulQ({ x: 0, y: Math.sin(-Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) }, ALONG_X) });
    stepUntil(w, () => [...slabs, light].every((e) => n.bakedIds().includes(e.id)), 1200, 'the cover and the light log at rest');
    drain(w);
    // What the navmesh was told: stakes are blockers below the original ground (plain triangles), the cover and the
    // light log are light (plain triangles), the staked log rises above the giant's ankle (extruded).
    const rec = (e: Entity) => navBakeEntity(w, e, { blockerMinKg: NAV_TUNING.blockerMinKg, extrudeAboveAnkleM: NAV_TUNING.extrudeAboveAnkleM });
    for (const s of stakes) expect([rec(s).blocker, rec(s).extrude]).toEqual([true, false]);
    for (const s of slabs) expect([rec(s).blocker, s.mass]).toEqual([false, s.mass]);
    expect(slabs.every((s) => s.mass < NAV_TUNING.blockerMinKg)).toBe(true);
    expect([rec(staked).blocker, rec(staked).extrude]).toEqual([true, true]);
    expect([rec(light).blocker, rec(light).extrude]).toEqual([false, false]);
    expect([rec(diagonal).blocker, rec(diagonal).extrude]).toEqual([true, true]);
    expect(rec(diagonal).aabb.max.x - rec(diagonal).aabb.min.x).toBeGreaterThan(7);

    // The covered pit: walkable on the ruler layer (and the human one), at the cover's height, crossed straight.
    for (const layer of NAV_LAYERS) {
      expect(n.isWalkable(layer, pit.x, pit.z)).toBe(true);
      // (Queried at the cover: under it the human layer also finds the pit floor, an island nobody can reach.)
      const top = n.nearest(layer, { x: pit.x, y: 0.1, z: pit.z });
      expect(top).not.toBeNull();
      expect(top!.y).toBeGreaterThan(-0.5);
      expect(n.raycast(layer, at(w, pit.x, -9), at(w, pit.x, 9)).clear).toBe(true);
      const p = n.findPath(layer, at(w, pit.x, -9), at(w, pit.x, 9));
      expect(p.complete).toBe(true);
      expect(pathLength(p.points)).toBeLessThan(18.2);
    }
    // The staked log: the giant's planner never steps over it (it goes round an end); the light log it steps over.
    expect(n.raycast('ruler', at(w, 10, -18), at(w, 10, -6)).clear).toBe(false);
    const round = n.findPath('ruler', at(w, 10, -18), at(w, 10, -6));
    expect(round.complete).toBe(true);
    expect(pathLength(round.points)).toBeGreaterThan(18);
    expect(n.raycast('ruler', at(w, 10, 6), at(w, 10, 18)).clear).toBe(true);
    expect(pathLength(n.findPath('ruler', at(w, 10, 6), at(w, 10, 18)).points)).toBeLessThan(12.2);
    // The diagonal log blocks the giant across it, while the corners of its AABB, 4.2 m from it, stay open ground.
    expect(n.raycast('ruler', at(w, diag.x + 4, diag.z - 4), at(w, diag.x - 4, diag.z + 4)).clear).toBe(false);
    expect(n.isWalkable('ruler', diag.x + 3, diag.z - 3)).toBe(true);
    expect(n.isWalkable('ruler', diag.x - 3, diag.z + 3)).toBe(true);
    expect(n.isWalkable('ruler', diag.x, diag.z)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bitmaps
// ---------------------------------------------------------------------------

describe('the walk and blocker bitmaps NavWalkable reads (§4.1, RF-23)', () => {
  it('agree with isWalkable queries at 1,000 random points and are rebuilt with their tile', async () => {
    const w = await make();
    hills(w, [{ x: 0, z: 0, r: 5 }]);
    const rng = new Rng(5);
    const trunks: Entity[] = [];
    for (let k = 0; k < 12; k++) trunks.push(trunk(w, rng.range(-20, 20), rng.range(-20, 20), rng.range(0.3, 0.6)));
    box(w, { x: 8, y: 1, z: -8 }, [2, 1, 0.4]);
    nav(w).build(w);
    const n = nav(w);
    const walk = new NavWalkable(w);
    const agree = (x0: number, z0: number, x1: number, z1: number, count: number, seed: number) => {
      const q = new Rng(seed);
      let open = 0;
      for (let i = 0; i < count; i++) {
        const x = q.range(x0, x1);
        const z = q.range(z0, z1);
        const bit = walk.isWalkable(x, z);
        expect(bit, `(${x}, ${z})`).toBe(n.isWalkable('human', x, z));
        if (bit) open++;
      }
      return open;
    };
    const open = agree(-25, -25, 25, 25, 1000, 11);
    expect(open).toBeGreaterThan(500);
    expect(open).toBeLessThan(1000);

    // Inside a trunk: no walk bit, a blocker cell; open ground: walk bit, nothing solid.
    const t0 = trunks[0];
    expect(walk.isWalkable(t0.pose.p.x, t0.pose.p.z)).toBe(false);
    expect(walk.solidAt({ x: t0.pose.p.x, y: 0.3, z: t0.pose.p.z })).not.toBeNull();
    expect(walk.isWalkable(0, 0)).toBe(true);
    expect(walk.solidAt({ x: 0, y: 0.3, z: 0 }, 0.33)).toBeNull();
    const tile = n.tileAt('human', t0.pose.p.x, t0.pose.p.z);
    const before = { walk: Uint8Array.from(n.walkBits(tile)), block: Uint8Array.from(n.blockBits(tile)) };
    expect(before.block.some((b) => b !== 0)).toBe(true);

    // Remove the trunk: the bitmaps change only when its tile is rebuilt, then agree again.
    w.removeEntity(t0.id);
    expect(Uint8Array.from(n.walkBits(tile))).toEqual(before.walk);
    drain(w);
    expect(walk.isWalkable(t0.pose.p.x, t0.pose.p.z)).toBe(true);
    expect(walk.solidAt({ x: t0.pose.p.x, y: 0.3, z: t0.pose.p.z })).toBeNull();
    expect(Uint8Array.from(n.walkBits(tile))).not.toEqual(before.walk);
    const g = n.grid('human');
    const tx = tile % g.tilesX;
    const tz = Math.floor(tile / g.tilesX);
    agree(g.origX + tx * g.tileM, g.origZ + tz * g.tileM, g.origX + (tx + 1) * g.tileM, g.origZ + (tz + 1) * g.tileM, 300, 12);
  });

  it('debugGeometry draws the navmesh for the dev panel: triangles on the ground, none inside a trunk, read-only', async () => {
    const w = await make();
    const t = trunk(w, 5, 5, 1);
    nav(w).build(w);
    const n = nav(w);
    const bytes = n.meshBytes('human');
    for (const layer of NAV_LAYERS) {
      const g = n.debugGeometry(layer);
      expect(g.indices.length).toBeGreaterThan(0);
      expect(g.indices.length % 3).toBe(0);
      expect(Math.max(...g.indices)).toBeLessThan(g.positions.length / 3);
      for (let i = 0; i < g.positions.length; i += 3) expect(Math.abs(g.positions[i + 1] - w.terrain.heightAt(g.positions[i], g.positions[i + 2]))).toBeLessThan(0.5);
      // No triangle's centre lies within the trunk (radius 0.54 m).
      for (let k = 0; k < g.indices.length; k += 3) {
        let cx = 0;
        let cz = 0;
        for (let j = 0; j < 3; j++) {
          cx += g.positions[g.indices[k + j] * 3] / 3;
          cz += g.positions[g.indices[k + j] * 3 + 2] / 3;
        }
        expect(Math.hypot(cx - t.pose.p.x, cz - t.pose.p.z)).toBeGreaterThan(0.5);
      }
    }
    expect(Buffer.from(n.meshBytes('human')).equals(Buffer.from(bytes))).toBe(true);
  });

  it('with nav off, NavWalkable reads open ground and nothing solid (the physics-only worlds)', async () => {
    const w = await make({ nav: 'off' });
    box(w, { x: 0, y: 1, z: 0 }, [1, 1, 1]);
    const walk = new NavWalkable(w);
    expect(walk.isWalkable(0, 0)).toBe(true);
    expect(walk.solidAt({ x: 0, y: 0.3, z: 0 }, 0.3)).toBeNull();
    expect(w.combat.walkable).toBeInstanceOf(NavWalkable);
  });
});

// ---------------------------------------------------------------------------
// Determinism and memory
// ---------------------------------------------------------------------------

describe('determinism (rule 7) and memory', () => {
  async function scene(seed: number): Promise<World> {
    const w = await make({ seed, size: 75 });
    hills(w, [{ x: 0, z: 0, r: 8 }]);
    const rng = new Rng(31);
    for (let k = 0; k < 25; k++) trunk(w, rng.range(-35, 35), rng.range(-35, 35), rng.range(0.25, 0.6));
    log(w, 0, 0, { length: 5, r: 0.3, along: 'z', state: 'fixed' });
    digPit(w, 20, -20, 2, 3, 2);
    nav(w).build(w);
    return w;
  }

  it('two builds of one state are byte-identical, and so are their paths', async () => {
    const a = await scene(3);
    await yieldToLoop();
    const b = await scene(3);
    for (const layer of NAV_LAYERS) {
      await yieldToLoop();
      const ba = nav(a).meshBytes(layer);
      expect(ba.length).toBeGreaterThan(1000);
      expect(Buffer.from(ba).equals(Buffer.from(nav(b).meshBytes(layer)))).toBe(true);
      // Built again in place: the same bytes.
      nav(a).build(a);
      expect(Buffer.from(nav(a).meshBytes(layer)).equals(Buffer.from(ba))).toBe(true);
      const q = new Rng(77);
      for (let i = 0; i < 200; i++) {
        const p = at(a, q.range(-36, 36), q.range(-36, 36));
        const r = at(a, q.range(-36, 36), q.range(-36, 36));
        expect(pathText(nav(a).findPath(layer, p, r))).toBe(pathText(nav(b).findPath(layer, p, r)));
      }
    }
    // The same dig and tick count on both worlds rebuild the same tiles to the same bytes.
    for (const w of [a, b]) {
      await yieldToLoop();
      digPit(w, -20, 20, 1.5, 1.5, 2);
      drain(w);
    }
    expect(nav(a).dirtyReasons).toEqual(nav(b).dirtyReasons);
    for (const layer of NAV_LAYERS) expect(Buffer.from(nav(a).meshBytes(layer)).equals(Buffer.from(nav(b).meshBytes(layer)))).toBe(true);
  });

  /**
   * Bytes of recast's WASM heap in use: the heap's size minus what malloc still hands out in PROBE_BLOCK blocks before
   * the heap has to grow (every block freed again). The heap's size alone can't see a leak: it has megabytes free.
   * Small blocks count the free gaps between live allocations too, so the figure moves by a few hundred bytes at most
   * between calls on an unchanged heap. Each call grows the heap once (its last block).
   */
  function wasmHeapInUse(): number {
    const M = Raw.Module as unknown as { HEAPU8: Uint8Array; _malloc(n: number): number; _free(p: number): void };
    const PROBE_BLOCK = 256;
    const size = M.HEAPU8.length;
    const blocks: number[] = [];
    for (;;) {
      const p = M._malloc(PROBE_BLOCK);
      if (p === 0 || M.HEAPU8.length !== size) {
        if (p !== 0) M._free(p);
        break;
      }
      blocks.push(p);
    }
    // A block's footprint in the heap (the request plus malloc's header): the gap between the last two, both cut from
    // the top of the heap.
    const stride = blocks[blocks.length - 1] - blocks[blocks.length - 2];
    for (const p of blocks) M._free(p);
    expect(stride).toBeGreaterThanOrEqual(PROBE_BLOCK);
    expect(stride).toBeLessThanOrEqual(PROBE_BLOCK + 16);
    return size - blocks.length * stride;
  }

  it('20 create/dispose cycles leave the WASM heap in use where it was (within 1 KB)', async () => {
    const cycle = async () => {
      const w = await createWorld({ seed: 5, scene: 'empty', nav: 'full', player: false, size: 50 });
      const rng = new Rng(3);
      for (let k = 0; k < 8; k++) trunk(w, rng.range(-20, 20), rng.range(-20, 20), 0.5);
      nav(w).build(w);
      nav(w).findPath('human', at(w, -20, -20), at(w, 20, 20));
      nav(w).raycast('ruler', at(w, -20, 0), at(w, 20, 0));
      nav(w).nearest('human', at(w, 3, 3));
      nav(w).isWalkable('ruler', 0, 0);
      nav(w).debugGeometry('human');
      nav(w).markDirty({ min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 1, z: 10 } }, 'test');
      for (let k = 0; k < 5; k++) w.step();
      w.dispose();
      expect(() => nav(w).findPath('human', at(w, 0, 0), at(w, 1, 1))).toThrow();
    };
    // Warm-up: the shared build scratch and the binding's argument buffer reach their sizes.
    for (let i = 0; i < 3; i++) await cycle();
    const before = wasmHeapInUse();
    // Each cycle builds about 175 tiles and 4 navmeshes and their queries. Measured leaks over the 20 cycles: the
    // navmeshes never destroyed 1.67 MB, the create params of every tile 552 KB, the binding's createNavMeshData result
    // (16 bytes a tile) 59 KB, NavMeshQuery's wrapper 4.1 KB; leak-free, a few hundred bytes either way.
    for (let i = 0; i < 20; i++) {
      await yieldToLoop();
      await cycle();
    }
    const after = wasmHeapInUse();
    console.log(`WASM heap in use: ${before} B before 20 cycles, ${after} B after (${after - before} B)`);
    expect(Math.abs(after - before)).toBeLessThan(1024);
  });
});
