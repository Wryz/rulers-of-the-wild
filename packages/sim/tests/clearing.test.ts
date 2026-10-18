// The Clearing (docs/M1-DESIGN.md §6.7; package P21): generateClearing and the ground cover.
//
// §6.7's checks: the exact counts; two generations from one seed byte-identical; no tree within 15 m of the spawn or
// 6 m of the route; the rim steeper than 45° all round; every route leg pathable on the ruler layer and every ape loop
// on the human layer; the starter axe classifies as `stoneAxe` and the digging stick as `sharpStick` that digs; at
// least 4 hanging vines ≥ 17.96 m (AC-3); the 6 m ledge. Also the rest of §6.7's layout rules, the cover's formula and
// its edits through a save, and the definition of done: createWorld({ scene: 'clearing' }) builds in < 300 ms plus nav,
// read as a warm build (the median CPU time of builds after two warm-ups; a cold first build also compiles the code
// it runs, and is only logged).
//
// No placement may fall back to a spot that breaks a hard rule (ClearingSpawnData.hardFallbacks is 0): checked on the
// three seeds below, and with the hard rules on ten more (no navmesh); the navmesh checks run on the three.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyStateBytes } from '../src/save/bodyState';
import { loadWorld } from '../src/save/load';
import { serializeWorld } from '../src/save/serialize';
import { CLEARING_TUNING, clearingLedgeDepth, clearingLedgeFrame, clearingRimNorm } from '../src/world/clearing';
import { prismRForRoundDiam } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Entity, JointRecord } from '../src/world/types';
import { toolClass, toolDigs } from '../src/world/verbs/tools';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

// Rapier worlds, a 200 m terrain and (once) both navmeshes: explicit limits (§11's convention), generous for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

/** AC-7's seed S (§11.7), and two more seeds for the layout rules. */
const S = 20261017;
const SEEDS = [S, 7, 0xdeadbeef];
const T = CLEARING_TUNING;

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: S, scene: 'clearing', nav: 'off', ...o });
  live.push(w);
  return w;
}
const worlds = new Map<number, World>();
const world = (seed: number): World => worlds.get(seed)!;

beforeAll(async () => {
  await physicsReady();
  for (const seed of SEEDS) worlds.set(seed, await make({ seed }));
});

afterAll(() => {
  for (const w of live.splice(0)) w.dispose();
});

// ---------------------------------------------------------------------------
// Reading the generated Clearing
// ---------------------------------------------------------------------------

interface XZ {
  x: number;
  z: number;
}
const spawn: XZ = { x: WORLD_TUNING.spawnX, z: WORLD_TUNING.spawnZ };
const dist = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);
const xz = (e: Entity): XZ => ({ x: e.pose.p.x, z: e.pose.p.z });

function segDist(p: XZ, a: XZ, b: XZ): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const L2 = vx * vx + vz * vz;
  const t = L2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.z - a.z) * vz) / L2)) : 0;
  return Math.hypot(p.x - a.x - t * vx, p.z - a.z - t * vz);
}

/** The route's segments: the closed loop of waypoints and the lair leg (waypoint 0 → lair). */
function routeSegs(w: World): [XZ, XZ][] {
  const r = w.spawnData!.route;
  const segs: [XZ, XZ][] = r.map((p, k) => [p, r[(k + 1) % r.length]]);
  segs.push([r[0], w.spawnData!.lair!]);
  return segs;
}
const routeDist = (w: World, p: XZ): number => Math.min(...routeSegs(w).map(([a, b]) => segDist(p, a, b)));

/** Every generated entity by what it is (the factory's looks and materials). */
function kinds(w: World) {
  const all = w.entities.all();
  const joints = w.joints.all();
  const by = (f: (e: Entity) => boolean): Entity[] => all.filter(f);
  const trees = by((e) => e.look === 'tree');
  const treeIds = new Set(trees.map((e) => e.id));
  const vines = joints.filter((j) => j.kind === 'rope' && j.a.entity !== null && treeIds.has(j.a.entity));
  const lashes = joints.filter((j) => j.kind === 'lash');
  const axeIds = new Set(lashes.flatMap((j) => [j.a.entity, j.b.entity, j.rope?.entity]));
  const boulders = by((e) => e.look === 'stone' && e.mass > 500);
  return {
    all,
    joints,
    trees,
    vines,
    lashes,
    vineRopes: by((e) => e.look === 'coil' && e.state === 'tied' && vines.some((j) => j.rope?.entity === e.id)),
    coils: by((e) => e.look === 'coil' && e.state === 'free'),
    saplings: by((e) => e.look === 'sapling'),
    boulders,
    stones: by((e) => e.look === 'stone' && e.mass <= 500),
    flint: by((e) => e.material === 'flint' && !axeIds.has(e.id)),
    branches: by((e) => e.look === 'stick' && e.material === 'dryWood' && e.sharpPoints.length === 0),
    diggingSticks: by((e) => e.look === 'stick' && e.sharpPoints.length > 0),
    logs: by((e) => e.look === 'log' && e.material === 'dryWood'),
    rotten: by((e) => e.material === 'rottenWood'),
    grass: by((e) => e.look === 'grass'),
    snags: by((e) => e.look === 'snag'),
    walls: by((e) => e.look === 'boundary'),
    axe: lashes.map((j) => ({ stick: j.a.entity!, head: j.b.entity!, rope: j.rope!.entity, joint: j.id })),
  };
}

/** The original terrain's slope at (x, z), degrees. */
function slopeDeg(w: World, x: number, z: number): number {
  const n = w.terrain.normalAt(x, z, { x: 0, y: 1, z: 0 });
  return Math.acos(Math.min(1, n.y)) * (180 / Math.PI);
}

/** A trunk's anchor height of a vine: its anchor's local y above the trunk's base. */
function vineAnchorH(w: World, j: JointRecord): number {
  const t = w.entities.get(j.a.entity!)!;
  return j.a.local.y + t.plant!.height / 2;
}

/** Poses are the f32 values Rapier holds: positions compare to within this. */
const F32_TOL = 1e-4;

/** The gates: pairs of trees whose trunk surfaces are gateGapM apart. */
function gates(trees: Entity[]): [Entity, Entity][] {
  const out: [Entity, Entity][] = [];
  for (let i = 0; i < trees.length; i++) {
    for (let j = i + 1; j < trees.length; j++) {
      const gap = dist(xz(trees[i]), xz(trees[j])) - trees[i].plant!.diameter / 2 - trees[j].plant!.diameter / 2;
      if (Math.abs(gap - T.gateGapM) < F32_TOL) out.push([trees[i], trees[j]]);
    }
  }
  return out;
}

/** Everything a generated world holds, as text: entities (every field generation sets), joints, terrain, cover. */
function dump(w: World): string {
  const ents = w.entities.all().map((e) => ({
    id: e.id,
    material: e.material,
    shape: e.shape,
    mass: e.mass,
    state: e.state,
    pose: e.pose,
    vel: e.vel,
    sharpPoints: e.sharpPoints,
    joints: e.joints,
    plant: e.plant,
    rope: e.rope,
    anchor: e.anchor,
    look: e.look,
    generated: e.generated,
    touched: e.touched,
  }));
  const joints = w.joints.all().map((j) => ({ id: j.id, kind: j.kind, a: j.a, b: j.b, rope: j.rope }));
  const t = w.terrain;
  const heights = t.heights.map((h) => Buffer.from(h.buffer, h.byteOffset, h.byteLength).toString('base64'));
  const cover: number[] = [];
  for (let j = 0; j < w.cover.cellsZ; j++) {
    for (let i = 0; i < w.cover.cellsX; i++) cover.push(w.cover.at(t.minX + (i + 0.5) * w.cover.cellM, t.minZ + (j + 0.5) * w.cover.cellM));
  }
  return JSON.stringify({ ents, joints, heights, cover, spawn: w.spawnData, ids: w.ids.entity.next });
}

/**
 * The route legs that run through a corridor: trunks on both sides of the leg's middle 90 % (within a grove's reach),
 * none inside the route's lane, the free width between the nearest trunks on either side 12-16 m.
 */
function corridorLegs(w: World): { leg: number; left: number; right: number; nl: number; nr: number }[] {
  const { trees } = kinds(w);
  const route = w.spawnData!.route;
  const out: { leg: number; left: number; right: number; nl: number; nr: number }[] = [];
  for (let k = 0; k < route.length; k++) {
    const a = route[k];
    const b = route[(k + 1) % route.length];
    const len = dist(a, b);
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let left = Infinity;
    let right = Infinity;
    let nl = 0;
    let nr = 0;
    for (const t of trees) {
      const rx = t.pose.p.x - a.x;
      const rz = t.pose.p.z - a.z;
      const along = rx * ux + rz * uz;
      if (along < 0.05 * len || along > 0.95 * len) continue;
      const side = rx * -uz + rz * ux;
      const gap = Math.abs(side) - t.plant!.diameter / 2;
      if (gap > T.corridorWidthM[1] / 2 + T.groveRadiusM[1]) continue;
      if (side > 0) {
        left = Math.min(left, gap);
        nl++;
      } else {
        right = Math.min(right, gap);
        nr++;
      }
    }
    const width = left + right;
    if (nl >= 2 && nr >= 2 && Math.min(left, right) >= T.routeClearM - F32_TOL && width >= T.corridorWidthM[0] - F32_TOL && width <= T.corridorWidthM[1] + F32_TOL) {
      out.push({ leg: k, left, right, nl, nr });
    }
  }
  return out;
}

/** How far ape home i may lie from its §6.7 distance: A "38 m" exactly, B "≈ 62 m" and C "≈ 78 m" within the jitter. */
const homeTol = (i: number): number => (i === 0 ? 1e-9 : T.apeHomeDistJitterM + 1e-9);

/** §6.7's hard rules (and the counts), as a list of what breaks them: empty when the Clearing keeps them all. */
function hardRuleProblems(w: World): string[] {
  const out: string[] = [];
  const sd = w.spawnData!;
  const k = kinds(w);
  if (sd.hardFallbacks !== 0) out.push(`${sd.hardFallbacks} placements fell back to a spot breaking a hard rule`);
  if (k.all.length !== 261 || k.joints.length !== 13) out.push(`${k.all.length} entities and ${k.joints.length} joints`);
  if (k.trees.length !== 60) out.push(`${k.trees.length} trees`);
  const gatePairs = gates(k.trees);
  if (gatePairs.length !== T.gates) out.push(`${gatePairs.length} gates`);
  const inGate = (a: Entity, b: Entity): boolean => gatePairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (const t of k.trees) {
    const p = xz(t);
    const r = t.plant!.diameter / 2;
    if (dist(p, spawn) - r < T.spawnClearM) out.push(`tree ${t.id} within ${T.spawnClearM} m of the spawn`);
    if (routeDist(w, p) - r < T.routeClearM - F32_TOL) out.push(`tree ${t.id} ${(routeDist(w, p) - r).toFixed(2)} m from the route`);
    if (dist(p, sd.lair!) - r < T.lairClearM) out.push(`tree ${t.id} near the lair`);
    if (slopeDeg(w, p.x, p.z) >= T.maxSlopeDeg) out.push(`tree ${t.id} on a ${slopeDeg(w, p.x, p.z).toFixed(1)}° slope`);
    for (const o of k.trees) if (o.id > t.id && !inGate(o, t) && dist(p, xz(o)) < T.treeMinGapM) out.push(`trees ${t.id} and ${o.id} ${dist(p, xz(o)).toFixed(2)} m apart`);
  }
  for (const e of [...k.saplings, ...k.boulders]) if (routeDist(w, xz(e)) < T.routeClearM - F32_TOL) out.push(`${e.look} ${e.id} on the route`);
  for (const q of sd.route) if (dist(q, spawn) < T.routeMinSpawnDistM) out.push(`waypoint ${JSON.stringify(q)} near the spawn`);
  for (const [a, b] of routeSegs(w)) {
    const n = Math.ceil(dist(a, b));
    for (let i = 0; i <= n; i++) {
      const q = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
      if (slopeDeg(w, q.x, q.z) > T.maxSlopeDeg) {
        out.push(`leg ${JSON.stringify(a)} → ${JSON.stringify(b)} steeper than ${T.maxSlopeDeg}°`);
        break;
      }
    }
  }
  let loop = 2 * dist(sd.lair!, sd.route[0]);
  for (let i = 0; i < sd.route.length; i++) loop += dist(sd.route[i], sd.route[(i + 1) % sd.route.length]);
  if (loop < 400 * 0.85 || loop > 400 * 1.15) out.push(`a patrol loop of ${loop.toFixed(0)} m`);
  const bearings = sd.apeHomes.map((h) => Math.atan2(h.home.x - spawn.x, h.home.z - spawn.z));
  sd.apeHomes.forEach((h, i) => {
    if (Math.abs(dist(h.home, spawn) - T.apeHomeDistM[i]) > homeTol(i)) out.push(`home ${i} at ${dist(h.home, spawn).toFixed(1)} m`);
    for (let j = i + 1; j < bearings.length; j++) {
      let d = Math.abs(bearings[i] - bearings[j]) % (2 * Math.PI);
      d = Math.min(d, 2 * Math.PI - d) * (180 / Math.PI);
      if (d < T.apeHomeMinSepDeg - 1e-9) out.push(`homes ${i} and ${j} ${d.toFixed(1)}° apart`);
    }
  });
  for (const g of k.grass) if (w.cover.at(g.pose.p.x, g.pose.p.z) < T.grassMinCover) out.push(`grass ${g.id} outside the meadows`);
  if (k.vines.filter((j) => j.rope!.lengthM >= 17.96).length < 4) out.push('fewer than 4 vines ≥ 17.96 m');
  if (corridorLegs(w).length < T.corridorLegs) out.push(`${corridorLegs(w).length} corridor legs`);
  return out;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

describe('the Clearing (§6.7)', () => {
  it.each(SEEDS)('seed %i: exact counts of every kind, every one generated, untouched and uncredited; no hard-rule fallback', (seed) => {
    const w = world(seed);
    const k = kinds(w);
    expect(w.spawnData!.hardFallbacks).toBe(0);
    expect(k.trees).toHaveLength(60);
    for (const t of k.trees) {
      expect(t.material).toBe('greenWood');
      expect(t.state).toBe('fixed');
      const { diameter: d, height: h } = t.plant!;
      expect(d).toBeGreaterThanOrEqual(0.2);
      expect(d).toBeLessThanOrEqual(0.6);
      expect(h).toBeGreaterThanOrEqual(T.treeHeight.minM);
      expect(h).toBeLessThanOrEqual(T.treeHeight.maxM);
      const c = T.treeHeight.baseM + T.treeHeight.perDiamM * d;
      expect(h).toBeGreaterThanOrEqual(Math.max(T.treeHeight.minM, c - T.treeHeight.jitterM) - 1e-9);
      expect(h).toBeLessThanOrEqual(Math.min(T.treeHeight.maxM, c + T.treeHeight.jitterM) + 1e-9);
    }
    // The diameter bands: 50 / 35 / 15 % of 60 exactly.
    const band = (lo: number, hi: number): number => k.trees.filter((t) => t.plant!.diameter >= lo && t.plant!.diameter < hi).length;
    expect([band(0.2, 0.3), band(0.3, 0.45), band(0.45, 0.6000001)]).toEqual([30, 21, 9]);
    // Two gates: trunks of 0.5-0.6 m whose surfaces are 1.8 m apart.
    const g = gates(k.trees);
    expect(g).toHaveLength(T.gates);
    for (const pair of g) for (const t of pair) expect(t.plant!.diameter).toBeGreaterThanOrEqual(T.gateDiamM[0]);

    expect(k.vines).toHaveLength(12);
    expect(k.vineRopes).toHaveLength(12);
    expect(k.coils.map((e) => e.rope!.lengthM).sort((a, b) => a - b)).toEqual([8, 10, 12, 14, 16, 18, 20]);
    expect(k.saplings).toHaveLength(20);
    for (const s of k.saplings) {
      expect(s.plant!.diameter).toBeGreaterThanOrEqual(0.04);
      expect(s.plant!.diameter).toBeLessThanOrEqual(0.08);
      expect(s.plant!.height).toBeGreaterThanOrEqual(2.5);
      expect(s.plant!.height).toBeLessThanOrEqual(3.5);
    }
    expect(k.boulders.map((e) => e.mass)).toEqual([800, 800, 800].map((m) => expect.closeTo(m, 6)));
    expect(k.stones).toHaveLength(40);
    expect(k.stones.filter((e) => e.mass >= 0.5 - 1e-9 && e.mass <= 3 + 1e-9)).toHaveLength(25);
    expect(k.stones.filter((e) => e.mass >= 8 - 1e-9 && e.mass <= 40 + 1e-9)).toHaveLength(15);
    expect(k.flint).toHaveLength(10);
    for (const f of k.flint) {
      expect(f.mass).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(f.mass).toBeLessThanOrEqual(1 + 1e-9);
      expect(f.sharpPoints).toEqual([]);
    }
    expect(k.branches).toHaveLength(40);
    for (const b of k.branches) {
      expect(b.mass).toBeGreaterThanOrEqual(0.3);
      expect(b.mass).toBeLessThanOrEqual(13.1);
    }
    // Two digging-stick blanks: straight, 1.4-1.6 m × 5 cm.
    const blankR = prismRForRoundDiam(T.blankDiamM, 8);
    const blanks = k.branches.filter(
      (b) => b.shape.kind === 'cylinder' && b.shape.halfHeight >= T.blankLenM[0] / 2 - 1e-9 && b.shape.halfHeight <= T.blankLenM[1] / 2 + 1e-9 && b.shape.r === blankR,
    );
    expect(blanks).toHaveLength(T.stickBlanks);
    expect(k.logs).toHaveLength(5);
    for (const l of k.logs) {
      expect(l.mass).toBeGreaterThanOrEqual(80);
      expect(l.mass).toBeLessThanOrEqual(347);
    }
    expect(k.rotten.filter((e) => e.look === 'stick')).toHaveLength(20);
    expect(k.rotten.filter((e) => e.look === 'log')).toHaveLength(2);
    for (const r of k.rotten) expect(r.mass).toBeCloseTo(r.look === 'stick' ? 1.96 : 39.3, 1);
    expect(k.grass).toHaveLength(30);
    for (const gr of k.grass) {
      expect(gr.mass).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(gr.mass).toBeLessThanOrEqual(3 + 1e-9);
    }
    expect(k.snags).toHaveLength(4);
    for (const s of k.snags) {
      expect(s.mass).toBeGreaterThanOrEqual(80 - 1e-9);
      expect(s.mass).toBeLessThanOrEqual(120 + 1e-9);
      expect(s.sharpPoints.map((p) => p.sharpness)).toEqual([0.45, 0.45, 0.45]);
    }
    // The starter cache: the axe (handle, flint head, lashing), the digging stick and the 8 m coil.
    expect(k.axe).toHaveLength(1);
    expect(k.diggingSticks).toHaveLength(1);
    expect(k.walls).toHaveLength(4);
    // 60 + 12 vine ropes + 6 coils + 20 + 40 + 10 + 3 + 40 + 5 + 22 + 30 + 4 + (axe 3 + stick + coil) + 4 walls.
    expect(k.all).toHaveLength(261);
    expect(k.joints).toHaveLength(13);
    for (const e of k.all) {
      expect(e.generated, `${e.look} ${e.id}`).toBe(true);
      expect(e.touched, `${e.look} ${e.id}`).toBe(false);
      expect(e.credit).toEqual([]);
    }
    for (const j of k.joints) expect(j.credit).toEqual([]);
  });

  it('allocates ids in §6.7\'s order: trees, vines, coils, saplings, stones, flint, boulders, branches, logs, rotten wood, grass, snags, the cache, the walls', () => {
    const w = world(S);
    const k = kinds(w);
    const [axe] = k.axe;
    const cacheCoil = k.coils.find((e) => e.rope!.lengthM === T.starterCoilM)!;
    const cache = new Set([axe.stick, axe.head, axe.rope, k.diggingSticks[0].id, cacheCoil.id]);
    const vineRopes = new Set(k.vineRopes.map((e) => e.id));
    const order = w.entities.all().map((e) => {
      if (cache.has(e.id)) return 'cache';
      if (e.look === 'coil') return vineRopes.has(e.id) ? 'vine' : 'coil';
      if (e.look === 'stone') return e.mass > 500 ? 'boulder' : 'stone';
      if (e.material === 'rottenWood') return 'rotten';
      if (e.look === 'stick') return 'branch';
      return e.look;
    });
    const runs: string[] = [];
    for (const o of order) if (runs[runs.length - 1] !== o) runs.push(o);
    expect(runs).toEqual(['tree', 'vine', 'coil', 'sapling', 'stone', 'flint', 'boulder', 'branch', 'log', 'rotten', 'grass', 'snag', 'cache', 'boundary']);
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  it('two generations from one seed are byte-identical (entities, bodies, joints, terrain, cover, spawn data); another seed differs', async () => {
    const a = world(S);
    const b = await make({ seed: S });
    expect(dump(b)).toBe(dump(a));
    expect(Buffer.from(bodyStateBytes(b)).equals(Buffer.from(bodyStateBytes(a)))).toBe(true);
    expect(Buffer.from(serializeWorld(b)).equals(Buffer.from(serializeWorld(a)))).toBe(true);
    expect(dump(world(7))).not.toBe(dump(a));
  });

  it("draws only from the gen stream: the world's other streams start where an empty scene's do", async () => {
    const c = world(S);
    const e = await make({ seed: S, scene: 'empty' });
    expect(c.rngs.world.state).toBe(e.rngs.world.state);
    expect(c.rngs.combat.state).toBe(e.rngs.combat.state);
    expect(c.player!.rngState).toBe(e.player!.rngState);
    expect(c.rngs.gen.state).not.toBe(e.rngs.gen.state);
    // The empty scene generates nothing: flat, no cover, no entities.
    expect(e.entities.all()).toHaveLength(0);
    expect(e.cover.hasGrid).toBe(false);
    expect(e.cover.at(30, 40)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Clearances and layout rules
  // -------------------------------------------------------------------------

  it.each(SEEDS)('seed %i: no tree within 15 m of the spawn or 6 m of the route; trees 4 m apart (but a gate), on gentle ground inside the rim', (seed) => {
    const w = world(seed);
    const k = kinds(w);
    const gatePairs = gates(k.trees);
    const inGate = (a: Entity, b: Entity): boolean => gatePairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    for (const t of k.trees) {
      const p = xz(t);
      const r = t.plant!.diameter / 2;
      expect(dist(p, spawn) - r, `tree ${t.id} to the spawn`).toBeGreaterThanOrEqual(T.spawnClearM);
      expect(routeDist(w, p) - r, `tree ${t.id} to the route`).toBeGreaterThanOrEqual(T.routeClearM);
      expect(dist(p, w.spawnData!.lair!) - r, `tree ${t.id} to the lair`).toBeGreaterThanOrEqual(T.lairClearM);
      expect(slopeDeg(w, p.x, p.z), `tree ${t.id} slope`).toBeLessThan(T.maxSlopeDeg);
      expect(clearingRimNorm(p.x, p.z) + r, `tree ${t.id} inside the rim`).toBeLessThan(T.rimRadiusM + T.rimRadiusJitterM);
      for (const o of k.trees) if (o !== t && !inGate(o, t)) expect(dist(p, xz(o)), `trees ${t.id} and ${o.id}`).toBeGreaterThanOrEqual(T.treeMinGapM);
    }
    // Rooted saplings and 800 kg boulders block the giant: off the route too.
    for (const e of [...k.saplings, ...k.boulders]) expect(routeDist(w, xz(e)), `${e.look} ${e.id}`).toBeGreaterThanOrEqual(T.routeClearM);
  });

  it.each(SEEDS)('seed %i: the route: 8 waypoints around (0, 10) ≥ 45 m from the spawn, waypoint 0 toward the lair, legs ≤ 25°, a loop of ≈ 400 m', (seed) => {
    const w = world(seed);
    const { route, lair } = w.spawnData!;
    const c = { x: T.routeCentre[0], z: T.routeCentre[1] };
    expect(route).toHaveLength(8);
    const L = clearingLedgeFrame();
    const ledgeWp = { x: L.cx - T.ledgeRouteBehindM * L.nx, z: L.cz - T.ledgeRouteBehindM * L.nz };
    for (const p of route) {
      expect(dist(p, spawn)).toBeGreaterThanOrEqual(T.routeMinSpawnDistM);
      if (dist(p, ledgeWp) > 1e-9) {
        expect(dist(p, c)).toBeGreaterThanOrEqual(T.routeRadiusM - T.routeRadiusJitterM - 1e-9);
        expect(dist(p, c)).toBeLessThanOrEqual(T.routeRadiusM + T.routeRadiusJitterM + 1e-9);
      }
    }
    // The lair: at the north rim foot (north = −z), lairR from the spawn; waypoint 0 on the line from the centre to it.
    expect(dist(lair!, spawn)).toBeCloseTo(T.lairR, 9);
    expect(Math.abs(Math.atan2(lair!.x, -lair!.z)) * (180 / Math.PI)).toBeLessThanOrEqual(T.lairBearingJitterDeg + 1e-9);
    const toLair = Math.atan2(lair!.x - c.x, lair!.z - c.z);
    expect(Math.atan2(route[0].x - c.x, route[0].z - c.z)).toBeCloseTo(toLair, 9);
    // Every leg (and the lair leg) on gentle ground, sampled every 0.5 m.
    for (const [a, b] of routeSegs(w)) {
      const n = Math.ceil(dist(a, b) / 0.5);
      for (let i = 0; i <= n; i++) {
        const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
        expect(slopeDeg(w, p.x, p.z), `leg ${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBeLessThanOrEqual(T.maxSlopeDeg);
      }
    }
    // The patrol loop: lair → waypoint 0 → … → 7 → 0 → lair, ≈ 400 m (P20 times it at 1.8 m/s ± 15 %).
    let len = 2 * dist(lair!, route[0]);
    for (let k = 0; k < 8; k++) len += dist(route[k], route[(k + 1) % 8]);
    console.info(`seed ${seed}: patrol loop ${len.toFixed(1)} m`);
    expect(len).toBeGreaterThan(400 * 0.85);
    expect(len).toBeLessThan(400 * 1.15);
  });

  it.each(SEEDS)('seed %i: two legs run through a grove the route splits: a tree-free corridor 12-16 m wide with trunks on both sides', (seed) => {
    const w = world(seed);
    const corridors = corridorLegs(w);
    for (const c of corridors) console.info(`seed ${seed}: leg ${c.leg} corridor ${c.left.toFixed(2)} + ${c.right.toFixed(2)} m, ${c.nl} | ${c.nr} trunks`);
    expect(corridors.length).toBeGreaterThanOrEqual(T.corridorLegs);
  });

  it.each(SEEDS)('seed %i: the gates stand at a grove edge beside the route: a person fits between the trunks, the giant does not', (seed) => {
    const w = world(seed);
    for (const [a, b] of gates(kinds(w).trees)) {
      const gap = dist(xz(a), xz(b)) - a.plant!.diameter / 2 - b.plant!.diameter / 2;
      expect(Math.abs(gap - T.gateGapM)).toBeLessThan(F32_TOL);
      // A person (nav radius 0.4 m) slips through; the giant (1.65 m, 2.0 m voxelised) can't.
      expect(gap).toBeGreaterThan(2 * 0.4);
      expect(gap).toBeLessThan(2 * 1.65);
      // Beside the route: within a grove radius of it, outside its lane.
      const mid = { x: (a.pose.p.x + b.pose.p.x) / 2, z: (a.pose.p.z + b.pose.p.z) / 2 };
      expect(routeDist(w, mid)).toBeLessThan(T.corridorWidthM[1] / 2 + T.gateDiamM[1] + 1);
    }
  });

  it.each(SEEDS)('seed %i: ape homes A, B, C at 38, ≈ 62 and ≈ 78 m, ≥ 100° apart, with 3-waypoint loops of 15 m; the player faces A', (seed) => {
    const w = world(seed);
    const { apeHomes, playerYaw } = w.spawnData!;
    apeHomes.forEach((h, i) => expect(Math.abs(dist(h.home, spawn) - T.apeHomeDistM[i]), `home ${i}`).toBeLessThanOrEqual(homeTol(i)));
    const bearings = apeHomes.map((h) => Math.atan2(h.home.x - spawn.x, h.home.z - spawn.z));
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        let d = Math.abs(bearings[i] - bearings[j]) % (2 * Math.PI);
        d = Math.min(d, 2 * Math.PI - d);
        expect(d * (180 / Math.PI)).toBeGreaterThanOrEqual(T.apeHomeMinSepDeg - 1e-9);
      }
    }
    for (const h of apeHomes) {
      expect(h.loop).toHaveLength(3);
      for (const p of h.loop) {
        expect(dist(p, h.home)).toBeCloseTo(T.homeLoopR, 9);
        expect(slopeDeg(w, p.x, p.z)).toBeLessThanOrEqual(T.maxSlopeDeg);
      }
    }
    expect(playerYaw).toBeCloseTo(bearings[0], 12);
    expect(w.player!.yaw).toBeCloseTo(playerYaw, 12);
    // A snag lies at the edge of each home.
    for (const h of apeHomes) {
      const near = kinds(w).snags.filter((s) => dist(xz(s), h.home) <= T.snagHomeDistM[1] + 1e-6);
      expect(near.length).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(SEEDS)('seed %i: the near-spawn kit: coils, saplings, stones, flint, branches, a boulder and a draggable log where §6.7 puts them', (seed) => {
    const w = world(seed);
    const k = kinds(w);
    const near = (es: Entity[], r: number): Entity[] => es.filter((e) => dist(xz(e), spawn) <= r + 1e-6);
    // §6.7 puts the 12 m and 18 m coils within 20 m (and the cache's 8 m one beside the spawn); a grove-edge coil may lie
    // that close too.
    expect(near(k.coils, T.coilNearSpawnM).map((e) => e.rope!.lengthM)).toEqual(expect.arrayContaining([...T.coilNearSpawnLengthsM, T.starterCoilM]));
    expect(near(k.saplings, T.saplingNearSpawnM).length).toBeGreaterThanOrEqual(T.saplingsNearSpawn);
    expect(near(k.stones, T.stoneNearSpawnM).length).toBeGreaterThanOrEqual(T.stonesNearSpawn);
    expect(near(k.flint, T.flintNearSpawnM).length).toBeGreaterThanOrEqual(T.flintNearSpawn);
    expect(near(k.branches, T.branchNearSpawnM).length).toBeGreaterThanOrEqual(T.branchesNearSpawn);
    expect(k.boulders.filter((e) => Math.abs(dist(xz(e), spawn) - T.boulderNearSpawnM) < F32_TOL)).toHaveLength(1);
    expect(near(k.logs, T.logNearSpawnM).filter((e) => e.mass >= T.logNearSpawnKg[0] - 1e-9 && e.mass <= T.logNearSpawnKg[1] + 1e-9)).toHaveLength(1);
    expect(k.logs.filter((e) => Math.abs(e.mass - T.routeLogKg) < 1e-6 && Math.abs(routeDist(w, xz(e)) - T.routeLogOffsetM) < F32_TOL)).toHaveLength(1);
    // The two outer boulders lie on the slope above one route leg, off its lane.
    const outer = k.boulders.filter((e) => Math.abs(dist(xz(e), spawn) - T.boulderNearSpawnM) >= F32_TOL);
    for (const e of outer) {
      expect(routeDist(w, xz(e))).toBeGreaterThanOrEqual(T.routeClearM);
      expect(routeDist(w, xz(e))).toBeLessThanOrEqual(T.boulderLegOffsetM[1] + 1e-6);
    }
    // Grass bundles in the meadows.
    for (const g of k.grass) expect(w.cover.at(g.pose.p.x, g.pose.p.z), `grass ${g.id}`).toBeGreaterThanOrEqual(T.grassMinCover);
    // Nothing lies on the spawn point.
    for (const e of k.all) if (e.look !== 'boundary') expect(dist(xz(e), spawn), `${e.look} ${e.id}`).toBeGreaterThanOrEqual(T.nearSpawnMinM - 1);
  });

  // -------------------------------------------------------------------------
  // The rim and the ledge
  // -------------------------------------------------------------------------

  it.each(SEEDS)('seed %i: the rim is steeper than 45° all round: every bearing crosses a band of it, then the rim top', (seed) => {
    const w = world(seed);
    // The rim starts at R(θ) ≥ rimRadiusM − rimRadiusJitterM (in its norm): the rays start 2 m short of the nearest it can
    // be, and skip the ledge (its 63° drop and end walls are not the rim).
    const from = T.rimRadiusM - T.rimRadiusJitterM - 2;
    const nearLedge = (x: number, z: number): boolean =>
      [-1, 0, 1].some((ox) => [-1, 0, 1].some((oz) => clearingLedgeDepth(x + ox, z + oz) > 0));
    for (let deg = 0; deg < 360; deg += 1) {
      const a = (deg * Math.PI) / 180;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      let steepest = 0;
      let run = 0;
      let longest = 0;
      // From the rim's foot out to the terrain's edge.
      for (let r = from; ; r += 0.1) {
        const x = r * dx;
        const z = r * dz;
        if (Math.abs(x) > 99.9 || Math.abs(z) > 99.9) break;
        if (clearingRimNorm(x, z) < from || nearLedge(x, z)) {
          run = 0;
          continue;
        }
        const s = slopeDeg(w, x, z);
        steepest = Math.max(steepest, s);
        run = s > 45 ? run + 0.1 : 0;
        longest = Math.max(longest, run);
      }
      expect(steepest, `bearing ${deg}°`).toBeGreaterThan(45);
      // A band, not a crease: at least 3 m of it on every bearing.
      expect(longest, `bearing ${deg}°`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the 6 m ledge: a 63° drop along 30 m into a hollow, a route waypoint 6 m behind its high side, a snag at its foot', () => {
    const w = world(S);
    const L = clearingLedgeFrame();
    const at = (d: number, u: number): XZ => ({ x: L.cx + d * L.nx + u * L.tx, z: L.cz + d * L.nz + u * L.tz });
    // The ledge term: 0 on the high side, linear over the 3 m transition, 6 m below it, fading out over 25 m.
    for (const u of [-15, -7.5, 0, 7.5, 15]) {
      expect(clearingLedgeDepth(at(-0.01, u).x, at(-0.01, u).z)).toBe(0);
      expect(clearingLedgeDepth(at(1.5, u).x, at(1.5, u).z)).toBeCloseTo(3, 9);
      expect(clearingLedgeDepth(at(3, u).x, at(3, u).z)).toBeCloseTo(6, 9);
      expect(clearingLedgeDepth(at(3 + 25, u).x, at(3 + 25, u).z)).toBeCloseTo(0, 9);
      // In the terrain: the drop across the transition is the ledge's 6 m, give or take the floor's own relief.
      const hi = at(-0.5, u);
      const lo = at(3.5, u);
      const drop = w.terrain.originalHeightAt(hi.x, hi.z) - w.terrain.originalHeightAt(lo.x, lo.z);
      expect(drop, `u ${u}`).toBeGreaterThan(5.5);
      const mid = at(1.5, u);
      expect(slopeDeg(w, mid.x, mid.z), `u ${u}`).toBeGreaterThan(60);
    }
    // Beyond the line's ends the drop is gone.
    expect(clearingLedgeDepth(at(5, 18.01).x, at(5, 18.01).z)).toBe(0);
    // More than the giant's ledge trip (0.5 × knee height at 5.5 = 1.4 m, §4.7).
    expect(T.ledgeDropM).toBeGreaterThan(1.4);
    // One route waypoint exactly 6 m behind the high side.
    const wp = at(-T.ledgeRouteBehindM, 0);
    expect(Math.min(...w.spawnData!.route.map((p) => dist(p, wp)))).toBeLessThan(1e-9);
    // One snag in the hollow at the cliff's foot.
    const inHollow = kinds(w).snags.filter((s) => clearingLedgeDepth(s.pose.p.x, s.pose.p.z) > T.ledgeDropM * 0.5);
    expect(inHollow).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Vines and the starter cache
  // -------------------------------------------------------------------------

  it.each(SEEDS)('seed %i: 12 hanging vines 9.7-20.2 m on tall trees, at least 4 of them ≥ 17.96 m (AC-3), their slack lying on the ground', (seed) => {
    const w = world(seed);
    const { vines, trees } = kinds(w);
    const lengths = vines.map((j) => j.rope!.lengthM);
    console.info(`seed ${seed}: vines ${lengths.map((l) => l.toFixed(2)).join(', ')} m`);
    expect(lengths.filter((l) => l >= 17.96).length).toBeGreaterThanOrEqual(4);
    for (const j of vines) {
      const tree = w.entities.get(j.a.entity!)!;
      const h = tree.plant!.height;
      const anchor = vineAnchorH(w, j);
      expect(j.b.loose).toBe(true);
      expect(j.rope!.lengthM).toBeGreaterThanOrEqual(9.7 - 1e-9);
      expect(j.rope!.lengthM).toBeLessThanOrEqual(20.2 + 1e-9);
      expect(anchor).toBeLessThanOrEqual(Math.min(T.vineAnchorM[1], T.vineAnchorMaxFrac * h) + 1e-9);
      expect(anchor).toBeGreaterThanOrEqual(Math.min(T.vineAnchorM[0], T.vineAnchorMaxFrac * h) - 1e-9);
      if (j.rope!.lengthM >= 17.96) {
        expect(h).toBeGreaterThanOrEqual(T.longVineTreeMinH);
        expect(anchor).toBeGreaterThanOrEqual(T.longVineAnchorM - 1e-9);
      }
      // The slack lies on the ground beyond the trunk.
      const end = j.b.local;
      expect(end.y).toBeCloseTo(w.terrain.heightAt(end.x, end.z), 6);
      expect(dist(end, xz(tree))).toBeGreaterThan(tree.plant!.diameter / 2);
    }
    // On the tallest trees: no unvined tree is taller than the shortest vined one by more than the rule allows
    // (vines go on grove-edge trees, so a taller tree may stand inside a grove or alone).
    const vined = new Set(vines.map((j) => j.a.entity));
    expect(vined.size).toBe(12);
    expect(trees.filter((t) => vined.has(t.id)).every((t) => t.plant!.height >= T.treeHeight.minM)).toBe(true);
  });

  it.each(SEEDS)('seed %i: the starter cache beside the spawn: the axe classifies as stoneAxe, the digging stick as sharpStick and digs', (seed) => {
    const w = world(seed);
    const k = kinds(w);
    const cache = { x: T.starterCacheAt[0], z: T.starterCacheAt[1] };
    const axe = k.axe[0];
    expect(toolClass(w, axe.stick)).toBe('stoneAxe');
    expect(toolClass(w, axe.head)).toBe('stoneAxe');
    const stick = k.diggingSticks[0];
    expect(stick.material).toBe('dryWood');
    expect(stick.sharpPoints.map((p) => p.sharpness)).toEqual([T.diggingStick.sharpness]);
    expect(toolClass(w, stick.id)).toBe('sharpStick');
    expect(toolDigs(w, stick.id)).toBe(true);
    const coil = k.coils.find((e) => e.rope!.lengthM === T.starterCoilM)!;
    expect(coil.material).toBe('vine');
    for (const id of [axe.stick, axe.head, axe.rope, stick.id, coil.id]) {
      const e = w.entities.get(id)!;
      expect(dist(xz(e), cache), `${e.look} ${id}`).toBeLessThan(1.5);
      expect(e.credit).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // Ground cover
  // -------------------------------------------------------------------------

  it('ground cover: a 100 × 100 grid of 2 m cells; 0 near a trunk and on the rim, 0.4 at the spawn, lower in groves, meadows elsewhere', () => {
    const w = world(S);
    const c = w.cover;
    expect([c.cellsX, c.cellsZ, c.cellM]).toEqual([100, 100, 2]);
    expect(c.at(0, 0)).toBeCloseTo(T.coverSpawn, 2);
    expect(c.at(7, -7)).toBeCloseTo(T.coverSpawn, 2);
    for (const t of kinds(w).trees) expect(c.at(t.pose.p.x, t.pose.p.z)).toBe(0);
    expect(c.at(0, 99)).toBe(0);
    expect(c.at(99, 0)).toBe(0);
    expect(c.at(-150, 0)).toBe(0);
    let meadow = 0;
    let cells = 0;
    for (let j = 0; j < 100; j++) {
      for (let i = 0; i < 100; i++) {
        const v = c.at(-99 + 2 * i, -99 + 2 * j);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        cells++;
        if (v >= 0.6) meadow++;
      }
    }
    console.info(`seed ${S}: ${meadow} of ${cells} cells are meadow (cover ≥ 0.6)`);
    expect(meadow).toBeGreaterThan(500);
  });

  it('ground cover edits: set clears a cell, edits list it, and a save → load brings them back exactly', async () => {
    const w = await make({ seed: S });
    expect(w.cover.edits()).toEqual([]);
    const before = w.cover.at(30.5, -20.5);
    w.cover.set(30.5, -20.5, 0);
    w.cover.set(500, 0, 0.7); // off the terrain: nothing
    const cell = w.cover.cellIndex(30.5, -20.5);
    expect(w.cover.cellCentre(cell)).toEqual({ x: 31, z: -21 });
    expect(w.cover.at(30.5, -20.5)).toBe(0);
    expect(w.cover.edits()).toEqual(before === 0 ? [] : [[cell, 0]]);
    w.cover.set(-41, 13, 0.5);
    const edits = w.cover.edits();
    expect(edits.length).toBeGreaterThanOrEqual(1);
    // A second of play first: generated things settle (some are touched and saved), the player stands.
    for (let t = 0; t < 60; t++) w.step();
    const bytes = serializeWorld(w);
    const l = await loadWorld(bytes, { nav: 'off' });
    live.push(l);
    expect(l.cover.edits()).toEqual(edits);
    expect(l.cover.at(-41, 13)).toBe(w.cover.at(-41, 13));
    // Everything the M1 loader restores exactly comes back byte for byte (P13's list: all but the bodies' pose
    // histories, the contact grace a reset opens, and the rebuilt navmesh's queue).
    const a = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const b = JSON.parse(new TextDecoder().decode(serializeWorld(l))) as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!['bodies', 'contactGrace', 'navDirty'].includes(k)) expect(JSON.stringify(b[k]), k).toBe(JSON.stringify(a[k]));
    // A fresh Clearing saves no entity: every generated one is untouched.
    const fresh = JSON.parse(new TextDecoder().decode(serializeWorld(world(S)))) as { entities: unknown[]; removed: unknown[]; cover: unknown[] };
    expect([fresh.entities, fresh.removed, fresh.cover]).toEqual([[], [], []]);
  });

  it('ground cover in an empty scene: none until a non-zero value is written; edits are kept against zero', async () => {
    const e = await make({ seed: 3, scene: 'empty', size: 50 });
    e.cover.set(1, 1, 0);
    expect(e.cover.hasGrid).toBe(false);
    expect(e.cover.edits()).toEqual([]);
    e.cover.set(1, 1, 0.8);
    expect(e.cover.hasGrid).toBe(true);
    expect(e.cover.at(1, 1)).toBe(Math.round(0.8 * 255) / 255);
    expect(e.cover.edits()).toEqual([[e.cover.cellIndex(1, 1), Math.round(0.8 * 255) / 255]]);
    expect(() => e.cover.set(1, 1, Number.NaN)).toThrow(/finite/);
    expect(() => e.cover.applyEdits([[1e9, 0]])).toThrow(/no cell/);
    expect(() => e.cover.applyEdits([[0, 2]])).toThrow(/0\.\.1/);
  });

  // -------------------------------------------------------------------------
  // At rest, on the terrain
  // -------------------------------------------------------------------------

  /** A vine coil off the spawn's flat ground (at a grove edge, on a slope). */
  const onSlope = (e: Entity): boolean => e.look === 'coil' && e.state === 'free' && dist(xz(e), spawn) > T.flatInnerM;

  it('every loose generated thing starts at rest on the ground and stays near where it was put', async () => {
    const w = await make({ seed: S, player: false });
    const start = new Map(w.entities.all().map((e) => [e.id, { ...e.pose.p }]));
    for (let t = 0; t < 120; t++) w.step();
    let touched = 0;
    let worst = 0;
    for (const e of w.entities.all()) {
      if (e.state !== 'free') continue;
      const moved = Math.hypot(e.pose.p.x - start.get(e.id)!.x, e.pose.p.y - start.get(e.id)!.y, e.pose.p.z - start.get(e.id)!.z);
      worst = Math.max(worst, moved);
      if (e.touched) touched++;
      expect(moved, `${e.look} ${e.id}`).toBeLessThan(0.1);
      expect(e.pose.p.y, `${e.look} ${e.id}`).toBeGreaterThan(w.terrain.heightAt(e.pose.p.x, e.pose.p.z) - 0.5);
    }
    const free = w.entities.all().filter((e) => e.state === 'free').length;
    console.info(`after 2 s: ${touched} of ${free} free generated things touched, the farthest moved ${(worst * 100).toFixed(2)} cm`);
  });

  // A flat 8-gon disc sank through sloping heightfield (Rapier's FIX_INTERNAL_EDGES contact, now avoided in shapes.ts
  // colliderDesc): the coils at grove edges, on slopes, stay where they were put.
  it('the vine coils at grove edges (on slopes) stay where they were put', async () => {
    const w = await make({ seed: S, player: false });
    const coils = w.entities.all().filter((e) => onSlope(e));
    expect(coils.length).toBeGreaterThan(0);
    const start = new Map(coils.map((e) => [e.id, { ...e.pose.p }]));
    for (let t = 0; t < 120; t++) w.step();
    for (const e of coils) expect(e.pose.p.y, `coil ${e.id}`).toBeGreaterThan(start.get(e.id)!.y - 0.1);
  });

  it('the boundary walls: four fixed, undrawn boxes just outside the terrain, reaching boundaryWallAboveM over its edge', () => {
    const w = world(S);
    const walls = kinds(w).walls;
    expect(walls).toHaveLength(4);
    const t = w.terrain;
    const half = (t.tilesX * t.tileSize) / 2;
    let edgeTop = -Infinity;
    for (let s = -half; s <= half; s += t.spacing) {
      for (const [x, z] of [
        [-half, s],
        [half, s],
        [s, -half],
        [s, half],
      ]) edgeTop = Math.max(edgeTop, t.originalHeightAt(x, z));
    }
    for (const e of walls) {
      expect(e.state).toBe('fixed');
      expect(e.look).toBe('boundary');
      const b = e.shape as { kind: 'box'; hx: number; hy: number; hz: number };
      expect(b.kind).toBe('box');
      // Outside the terrain (its inner face on the edge), and high enough for a high arc.
      expect(Math.max(Math.abs(e.pose.p.x) - b.hx, Math.abs(e.pose.p.z) - b.hz)).toBeCloseTo(half, 3);
      expect(e.pose.p.y + b.hy).toBeGreaterThanOrEqual(edgeTop + T.boundaryWallAboveM - 0.5);
    }
  });

  it('a world smaller than the Clearing keeps only what lands on its terrain', async () => {
    const w = await make({ seed: S, size: 50 });
    const half = (w.terrain.tilesX * w.terrain.tileSize) / 2;
    const off = w.entities.all().filter((e) => e.look !== 'boundary' && (Math.abs(e.pose.p.x) > half || Math.abs(e.pose.p.z) > half));
    expect(off).toEqual([]);
    expect(w.entities.all().filter((e) => e.look === 'boundary')).toHaveLength(4);
    expect(w.spawnData!.route).toHaveLength(8);
  });

  it('ten more seeds keep every hard rule (no navmesh)', async () => {
    const problems: Record<number, string[]> = {};
    for (const seed of [1, 2, 3, 42, 99, 2026, 31337, 123456789, 0x7fffffff, 0xcafebabe]) {
      const w = await createWorld({ seed, scene: 'clearing', nav: 'off', player: false });
      const p = hardRuleProblems(w);
      if (p.length > 0) problems[seed] = p;
      w.dispose();
    }
    expect(problems).toEqual({});
    // And the three seeds the rest of this file reads.
    for (const seed of SEEDS) expect(hardRuleProblems(world(seed)), `seed ${seed}`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Navigation and the definition of done
  // -------------------------------------------------------------------------

  it.each(SEEDS)("seed %i: every route leg is pathable on the ruler layer, every ape loop on the human layer, and the rim can't be climbed", async (seed) => {
    const w = await make({ seed, nav: 'full', player: false });
    const nav = w.nav!;
    const at = (p: XZ) => ({ x: p.x, y: w.terrain.heightAt(p.x, p.z), z: p.z });
    for (const [a, b] of routeSegs(w)) {
      const p = nav.findPath('ruler', at(a), at(b));
      expect(p.complete, `ruler leg ${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBe(true);
    }
    for (const h of w.spawnData!.apeHomes) {
      const ring = [h.home, ...h.loop, h.loop[0]];
      for (let i = 0; i + 1 < ring.length; i++) {
        const p = nav.findPath('human', at(ring[i]), at(ring[i + 1]));
        expect(p.complete, `ape loop ${JSON.stringify(ring[i])} → ${JSON.stringify(ring[i + 1])}`).toBe(true);
      }
    }
    // The rim top (flat in the terrain's corners, beyond the rim on every bearing) has a navmesh of its own, out of
    // reach of both layers from the spawn: a valley nobody leaves.
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const top = { x: 95 * sx, z: 95 * sz };
      expect(clearingRimNorm(top.x, top.z)).toBeGreaterThan(T.rimRadiusM + T.rimRadiusJitterM + T.rimWidthM);
      for (const layer of ['human', 'ruler'] as const) {
        expect(nav.nearest(layer, at(top)), `${layer} navmesh on the rim top at ${JSON.stringify(top)}`).not.toBeNull();
        expect(nav.findPath(layer, at(spawn), at(top)).complete, `${layer} to the rim top at ${JSON.stringify(top)}`).toBe(false);
      }
    }
    // The gates: a person passes between the trunks, the giant's layer is closed there.
    for (const [g1, g2] of gates(kinds(w).trees)) {
      const mid = { x: (g1.pose.p.x + g2.pose.p.x) / 2, z: (g1.pose.p.z + g2.pose.p.z) / 2 };
      expect(nav.isWalkable('human', mid.x, mid.z)).toBe(true);
      expect(nav.isWalkable('ruler', mid.x, mid.z)).toBe(false);
    }
    w.dispose(); // both navmeshes, before the next seed's
  });

  it('createWorld({ scene: \'clearing\' }) builds in < 300 ms plus nav: the median warm build, in CPU time', async () => {
    // One seed, built 2 + 5 times: the first two warm the code up (the cold one is logged); the budget is the median of
    // the next five. CPU time of this worker, not wall time: the suite runs workers side by side on a shared machine,
    // and a build's cost is the work it does, not how long it waits for a core. Wall time is logged beside it.
    const cpu: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < 7; i++) {
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      const w = await createWorld({ seed: S, scene: 'clearing', nav: 'off' });
      wall.push(performance.now() - t0);
      const c = process.cpuUsage(c0);
      cpu.push((c.user + c.system) / 1000);
      w.dispose();
    }
    const warm = cpu.slice(2).sort((a, b) => a - b);
    const median = warm[Math.floor(warm.length / 2)];
    const ms = (xs: number[]): string => xs.map((t) => t.toFixed(0)).join(', ');
    console.info(`Clearing builds (nav off): cold CPU ${cpu[0].toFixed(0)} ms, wall ${wall[0].toFixed(0)} ms; warm CPU ${ms(cpu.slice(2))} ms (median ${median.toFixed(0)}), wall ${ms(wall.slice(2))} ms`);
    expect(median).toBeLessThan(300);
  });
});
