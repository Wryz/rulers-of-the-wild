// The terrain (docs/M1-DESIGN.md §2.6, §4.13; package P05): exact heights against Rapier's own heightfield, the cone
// dig and its 3 m floor, the spoil kernel and search with the ever-dug mask and setback (RT-2), the kernel-only pit's
// strike count, seams, and the save's edits round trip.
import { yieldToVitest } from './support/yieldToVitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/math';
import { PhysicsWorld, physicsReady } from '../src/world/physics';
import { WorldQueries } from '../src/world/queries';
import { Terrain, TERRAIN_TUNING } from '../src/world/terrain';

/** A bumpy generated terrain: several metres of relief and slopes that change within a few cells. */
const bumpy = (x: number, z: number): number => 3 * Math.sin(x / 7) * Math.cos(z / 5) + 0.6 * Math.sin(1.3 * x + 0.7 * z) + 0.002 * x * z;

/**
 * Spoil left to place below which a dig's loop stops: raise is exact up to the float32 rounding of the heights it
 * writes (≈ 1e-7 m per vertex), so a request of a few nm³ can't move any vertex.
 */
const SPOIL_EPS_M3 = 1e-8;

/** Removed volume of one full cone strike centred on a vertex of the 0.25 m grid (§4.13: 0.0391 m³). */
function coneVolumeAtVertex(): number {
  const { digRadiusM: r, digDepthM: d, spacing: s } = TERRAIN_TUNING;
  let sum = 0;
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const dist = Math.hypot(i * s, j * s);
      if (dist < r) sum += d * (1 - dist / r);
    }
  }
  return sum * s * s;
}

/** Every world vertex as (gi, gj, x, z), or only those within `win` m (a square) of (cx, cz). */
function vertices(t: Terrain, win?: { cx: number; cz: number; r: number }): [number, number, number, number][] {
  const n = t.tilesX * t.cells + 1;
  const lo = (c: number) => (win ? Math.max(0, Math.floor((c - win.r - t.minX) / t.spacing)) : 0);
  const hi = (c: number) => (win ? Math.min(n - 1, Math.ceil((c + win.r - t.minX) / t.spacing)) : n - 1);
  const out: [number, number, number, number][] = [];
  for (let gj = lo(win?.cz ?? 0); gj <= hi(win?.cz ?? 0); gj++) {
    for (let gi = lo(win?.cx ?? 0); gi <= hi(win?.cx ?? 0); gi++) out.push([gi, gj, t.minX + gi * t.spacing, t.minZ + gj * t.spacing]);
  }
  return out;
}

/** Collects the failures of a per-vertex check (one expect instead of hundreds of thousands). */
function bad(list: [number, number, number, number][], ok: (gi: number, gj: number, x: number, z: number) => boolean): string[] {
  const out: string[] = [];
  for (const [gi, gj, x, z] of list) if (!ok(gi, gj, x, z)) out.push(`${x}, ${z}`);
  return out.slice(0, 10);
}

/**
 * The steepest heightfield triangle (°) within a square of half-width r around (cx, cz) that has no ever-dug vertex
 * (each cell's two triangles, split along (r+1, c)–(r, c+1) as Rapier's heightfield and normalAt are).
 */
function maxSlopeDeg(t: Terrain, win: { cx: number; cz: number; r: number }): number {
  const a = t.vertexIndex(win.cx - win.r, win.cz - win.r);
  const b = t.vertexIndex(win.cx + win.r, win.cz + win.r);
  const s = t.spacing;
  let most = 0;
  for (let gj = a.gj; gj < b.gj; gj++) {
    for (let gi = a.gi; gi < b.gi; gi++) {
      const h00 = t.vertexHeightAt(gi, gj);
      const h01 = t.vertexHeightAt(gi + 1, gj);
      const h10 = t.vertexHeightAt(gi, gj + 1);
      const h11 = t.vertexHeightAt(gi + 1, gj + 1);
      const d00 = t.isDugVertex(gi, gj);
      const d01 = t.isDugVertex(gi + 1, gj);
      const d10 = t.isDugVertex(gi, gj + 1);
      const d11 = t.isDugVertex(gi + 1, gj + 1);
      if (!d00 && !d01 && !d10) most = Math.max(most, Math.atan(Math.hypot(h01 - h00, h10 - h00) / s));
      if (!d11 && !d01 && !d10) most = Math.max(most, Math.atan(Math.hypot(h11 - h10, h11 - h01) / s));
    }
  }
  return (most * 180) / Math.PI;
}

/** Σ (height − original) × cell area over the world vertices (each counted once) within `r` m of (cx, cz). */
function netVolume(t: Terrain, cx: number, cz: number, r: number): number {
  let v = 0;
  for (const [gi, gj] of vertices(t, { cx, cz, r })) v += t.vertexHeightAt(gi, gj) - t.vertexOriginalAt(gi, gj);
  return v * t.spacing * t.spacing;
}

describe('terrain heights against Rapier', () => {
  let physics: PhysicsWorld;
  let terrain: Terrain;
  let queries: WorldQueries;

  beforeAll(async () => {
    await physicsReady();
    physics = new PhysicsWorld();
    terrain = new Terrain(physics, 200);
    terrain.generate(bumpy);
    physics.primeQueries();
    queries = new WorldQueries(physics, { mass: () => 0, collider: () => null });
  });

  afterAll(() => physics.free());

  it('lays out 8 × 8 tiles of 25 m at 0.25 m (101² heights each), centred on the origin', () => {
    expect([terrain.tilesX, terrain.tilesZ, terrain.cells, terrain.spacing, terrain.minX, terrain.minZ]).toEqual([8, 8, 100, 0.25, -100, -100]);
    expect(terrain.heights).toHaveLength(64);
    for (const h of terrain.heights) expect(h.length).toBe(101 * 101);
  });

  it('heightAt matches a downward castRay within 2e-5 m at 5,000 points (seams included)', () => {
    const rng = new Rng(12345);
    let worst = 0;
    for (let k = 0; k < 5000; k++) {
      // Every fifth point sits on a tile seam (x or z a multiple of 25 m).
      let x = rng.range(-99.9, 99.9);
      let z = rng.range(-99.9, 99.9);
      if (k % 5 === 0) x = -100 + 25 * Math.round(rng.range(1, 7));
      if (k % 10 === 0) z = -100 + 25 * Math.round(rng.range(1, 7));
      const hit = queries.castRay({ x, y: 40, z }, { x: 0, y: -1, z: 0 }, 80, { terrain: true });
      expect(hit, `ray at ${x}, ${z}`).not.toBeNull();
      expect(hit!.owner).toEqual({ kind: 'terrain' });
      worst = Math.max(worst, Math.abs(hit!.point.y - terrain.heightAt(x, z)));
    }
    console.info(`terrain: worst |heightAt − castRay| over 5,000 points = ${worst.toExponential(3)} m`);
    expect(worst).toBeLessThan(2e-5);
  });

  it('normalAt is the upward unit normal of the triangle under the point (matches the ray normal)', () => {
    const rng = new Rng(7);
    const n = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 500; k++) {
      // Stay off the cell diagonals and edges, where two triangles meet.
      const x = -90 + 0.25 * Math.floor(rng.range(0, 720)) + 0.06;
      const z = -90 + 0.25 * Math.floor(rng.range(0, 720)) + 0.05;
      const hit = queries.castRay({ x, y: 40, z }, { x: 0, y: -1, z: 0 }, 80, {})!;
      terrain.normalAt(x, z, n);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      expect(n.y).toBeGreaterThan(0);
      expect(n.x).toBeCloseTo(hit.normal.x, 4);
      expect(n.y).toBeCloseTo(hit.normal.y, 4);
      expect(n.z).toBeCloseTo(hit.normal.z, 4);
    }
  });

  it('edits reach the collider at once (setShape) through its old bounds, and bump the tile version', () => {
    const before = terrain.version[terrain.tileCount - 1];
    const x = 90;
    const z = 90;
    terrain.lower(x, z, 1);
    expect(terrain.version[terrain.tileCount - 1]).toBe(before + 1);
    // A downward ray meets the tile's old bounding box, so it already tests the new shape.
    const hit = queries.castRay({ x, y: 40, z }, { x: 0, y: -1, z: 0 }, 80, {})!;
    expect(Math.abs(hit.point.y - terrain.heightAt(x, z))).toBeLessThan(2e-5);
  });

  it('below the old bounds (a pit dug in flat ground), queries find the edit after the next step', () => {
    const p = new PhysicsWorld();
    try {
      const t = new Terrain(p, 50);
      p.primeQueries();
      const q = new WorldQueries(p, { mass: () => 0, collider: () => null });
      for (let k = 0; k < 20; k++) for (let x = -1; x <= 1; x += 0.25) for (let z = -1; z <= 1; z += 0.25) t.lower(x + 5, z + 5, 1);
      expect(t.heightAt(5, 5)).toBe(-TERRAIN_TUNING.maxDigDepthM);
      // Exact at once: the heights are the terrain's own.
      expect(t.supportAt(5, 5)).toBe(-TERRAIN_TUNING.maxDigDepthM);
      p.step();
      p.drain();
      const wall = q.castRay({ x: 2, y: -1.5, z: 5 }, { x: 1, y: 0, z: 0 }, 10, { terrain: true });
      expect(wall?.owner).toEqual({ kind: 'terrain' });
      expect(wall!.point.x).toBeGreaterThan(3);
      expect(wall!.point.x).toBeLessThan(5);
      expect(q.overlaps({ kind: 'ball', r: 0.3 }, { p: { x: 5, y: t.heightAt(5, 5) + 0.1, z: 5 }, q: { x: 0, y: 0, z: 0, w: 1 } }, {})).toEqual([{ kind: 'terrain' }]);
    } finally {
      p.free();
    }
  });
});

describe('dig: the cone kernel (§4.13)', () => {
  it('a full strike on a vertex removes 0.0391 m³ (58.7 kg of dirt)', () => {
    const t = new Terrain(null, 200);
    const r = t.lower(0, 0, 1);
    expect(r.volumeM3).toBeCloseTo(coneVolumeAtVertex(), 6);
    expect(r.volumeM3).toBeCloseTo(0.0391, 4);
    expect(r.volumeM3 * 1500).toBeCloseTo(58.7, 1);
    expect(netVolume(t, 0, 0, 2)).toBeCloseTo(-r.volumeM3, 9);
    // (0, 0) is the corner of four tiles: every one changed.
    expect(r.tiles).toEqual([27, 28, 35, 36]);
    expect(t.heightAt(0, 0)).toBeCloseTo(-0.15, 6);
  });

  it('depthMul scales it, and the floor is original − 3 m whatever the strikes', () => {
    const t = new Terrain(null, 200);
    expect(t.lower(10, 10, 0.25).volumeM3).toBeCloseTo(coneVolumeAtVertex() * 0.25, 6);
    for (let k = 0; k < 60; k++) t.lower(10, 10, 1);
    expect(t.heightAt(10, 10)).toBe(-TERRAIN_TUNING.maxDigDepthM);
    expect(bad(vertices(t, { cx: 10, cz: 10, r: 2 }), (gi, gj) => t.vertexHeightAt(gi, gj) >= t.vertexOriginalAt(gi, gj) - 3)).toEqual([]);
    // Once at the floor a strike there removes nothing.
    const t2 = new Terrain(null, 200);
    for (let k = 0; k < 20; k++) t2.lower(-20, 5, 1);
    const centre = t2.vertexIndex(-20, 5);
    expect(t2.vertexHeightAt(centre.gi, centre.gj)).toBe(-3);
  });

  it('marks a vertex ever-dug once it is more than 0.05 m below original, and never clears it', () => {
    const t = new Terrain(null, 200);
    t.lower(0, 0, 0.3); // peak 0.045 m: nothing is dug yet
    expect(t.dugVertices()).toEqual([]);
    t.lower(0, 0, 1);
    const centre = t.vertexIndex(0, 0);
    expect(t.isDugVertex(centre.gi, centre.gj)).toBe(true);
    // Refill it with spoil from elsewhere: still dug, so spoil never lands there again.
    t.raise(0, 0, 1);
    expect(t.isDugVertex(centre.gi, centre.gj)).toBe(true);
    expect(t.heightAt(0, 0)).toBeLessThan(0);
  });
});

describe('spoil: raise and the spoil search (§4.13, RT-2)', () => {
  it('raise conserves volume exactly while under the cap', () => {
    const t = new Terrain(null, 200);
    for (const v of [0.0391, 0.0098, 0.2]) {
      const before = netVolume(t, 30, -30, 3);
      const r = t.raise(30, -30, v);
      expect(r.raisedM3).toBeCloseTo(v, 6);
      expect(netVolume(t, 30, -30, 3) - before).toBeCloseTo(r.raisedM3, 9);
    }
    expect(t.heightAt(30, -30)).toBeGreaterThan(0);
  });

  // UPDATED (SIM-fix4): this test asserted §4.13's old shape, a mound filled flat to the cap over the 9 vertices of the
  // 0.5 m kernel with sheer sides (5 m³ asked, 0.56 m³ placed). Spoil now settles at its angle of repose: the same cap,
  // but a flat-topped pyramid whose faces lie at spoilReposeDeg, spreading up to spoilSlideM from the pour.
  it('caps every vertex at original + 1 m, settles its flanks at the repose angle, and reports what it could not place', () => {
    const t = new Terrain(null, 200);
    const r = t.raise(-40, 20, 100);
    const slide = TERRAIN_TUNING.spoilSlideM;
    const near = vertices(t, { cx: -40, cz: 20, r: slide + 2 });
    const d = t.spoilStepM();
    // Capped: nothing above original + 1 m; the top (the pour point and the vertices around it) at the cap.
    expect(bad(near, (gi, gj) => t.vertexHeightAt(gi, gj) <= Math.fround(1) + 1e-9)).toEqual([]);
    expect(t.heightAt(-40, 20)).toBeCloseTo(1, 5);
    expect(t.heightAt(-40 + 1, 20 - 1)).toBeCloseTo(1, 5);
    // Settled: no x- or z-neighbours differ by more than d, so no triangle is steeper than the repose angle.
    expect(bad(near, (gi, gj) => Math.abs(t.vertexHeightAt(gi + 1, gj) - t.vertexHeightAt(gi, gj)) <= d + 1e-6 && Math.abs(t.vertexHeightAt(gi, gj + 1) - t.vertexHeightAt(gi, gj)) <= d + 1e-6)).toEqual([]);
    expect(maxSlopeDeg(t, { cx: -40, cz: 20, r: slide + 2 })).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + 0.01);
    // Nothing beyond spoilSlideM (grid steps along x plus z) of the pour.
    expect(bad(near, (gi, gj, x, z) => Math.abs(x + 40) + Math.abs(z - 20) <= slide + 1e-9 || t.vertexHeightAt(gi, gj) === 0)).toEqual([]);
    // Exact volume, and less than asked: the window is full.
    expect(netVolume(t, -40, 20, slide + 2)).toBeCloseTo(r.raisedM3, 9);
    expect(r.raisedM3).toBeGreaterThan(5);
    expect(r.raisedM3).toBeLessThan(100);
    // A full mound takes nothing more.
    expect(t.raise(-40, 20, 1).raisedM3).toBe(0);
  });

  it('a small pour is a pyramid at the repose angle, its volume exact (SIM-fix4)', () => {
    const t = new Terrain(null, 200);
    const r = t.raise(10, 10, 0.0391);
    expect(r.raisedM3).toBeCloseTo(0.0391, 6);
    expect(maxSlopeDeg(t, { cx: 10, cz: 10, r: 3 })).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + 0.01);
    // Its apex: Σ over the pyramid's vertices of (H − d·m) = V / s², 4m vertices at m steps.
    expect(t.heightAt(10, 10)).toBeGreaterThan(0.2);
    expect(t.heightAt(10, 10)).toBeLessThan(TERRAIN_TUNING.spoilMaxRiseM);
  });

  it('never raises an ever-dug vertex or one within 1.5 m of one', () => {
    const t = new Terrain(null, 200);
    for (let k = 0; k < 4; k++) t.lower(0, 0, 1);
    for (let k = 0; k < 4; k++) t.lower(1, 0, 1);
    const near = vertices(t, { cx: 0.5, cz: 0, r: 5 });
    const dug = near.filter(([gi, gj]) => t.isDugVertex(gi, gj)).map(([, , x, z]) => [x, z]);
    expect(dug.length).toBeGreaterThan(0);
    // Mounds right beside the hole: the near part of each kernel is refused, the far part may rise.
    let placed = 0;
    for (const [x, z] of [[2.25, 0], [2.75, 0.5], [-1.5, 0], [0.5, 1.75]]) placed += t.raise(x, z, 0.5).raisedM3;
    expect(placed).toBeGreaterThan(0);
    const nearDug = (x: number, z: number) => dug.some(([dx, dz]) => Math.hypot(dx - x, dz - z) <= TERRAIN_TUNING.spoilSetbackM + 1e-9);
    expect(bad(near, (gi, gj, x, z) => !nearDug(x, z) || t.vertexHeightAt(gi, gj) <= t.vertexOriginalAt(gi, gj))).toEqual([]);
    // A kernel wholly inside the setback places nothing.
    expect(t.raise(0.5, 0, 0.1).raisedM3).toBe(0);
  });

  it('findSpoilPoint never returns a point within 1.5 m of dug ground, nor a vertex at its cap', () => {
    const t = new Terrain(null, 200);
    // A 3 × 2 m trench with spoil piled by the search itself.
    for (let pass = 0; pass < 3; pass++) {
      for (let x = -1.5; x <= 1.5; x += 0.3) {
        for (let z = -1; z <= 1; z += 0.3) {
          let rest = t.lower(x, z, 1).volumeM3;
          for (let g = 0; rest > SPOIL_EPS_M3 && g < 50; g++) {
            const s = t.findSpoilPoint(x, z);
            expect(s).not.toBeNull();
            const sv = t.vertexIndex(s!.x, s!.z);
            expect(t.isNearDug(sv.gi, sv.gj)).toBe(false);
            expect(t.vertexHeightAt(sv.gi, sv.gj)).toBeLessThan(t.vertexOriginalAt(sv.gi, sv.gj) + TERRAIN_TUNING.spoilMaxRiseM);
            rest -= t.raise(s!.x, s!.z, rest).raisedM3;
          }
          expect(rest).toBeLessThan(SPOIL_EPS_M3);
        }
      }
    }
    const dug = vertices(t, { cx: 0, cz: 0, r: 4 })
      .filter(([gi, gj]) => t.isDugVertex(gi, gj))
      .map(([, , x, z]) => [x, z]);
    for (const [x, z] of [[0, 0], [1.5, 1], [-1.5, -1], [0, 1]]) {
      const s = t.findSpoilPoint(x, z)!;
      const nearest = Math.min(...dug.map(([dx, dz]) => Math.hypot(dx - s.x, dz - s.z)));
      expect(nearest).toBeGreaterThan(TERRAIN_TUNING.spoilSetbackM);
      expect(Math.hypot(s.x - x, s.z - z)).toBeGreaterThanOrEqual(TERRAIN_TUNING.digRadiusM + TERRAIN_TUNING.spoilMinGapM - t.spacing);
    }
    // Volume is conserved overall (to float32 height rounding): what was dug went into the berm.
    expect(Math.abs(netVolume(t, 0, 0, 16))).toBeLessThan(1e-5);
  });

  it('finds nothing when every ring is at its cap or beside dug ground', () => {
    const t = new Terrain(null, 200);
    const save = TERRAIN_TUNING.spoilSearchMaxM;
    try {
      TERRAIN_TUNING.spoilSearchMaxM = 1.25;
      t.lower(0, 0, 1); // every vertex of rings 1.0 and 1.25 is within 1.5 m of the dug centre
      expect(t.findSpoilPoint(0, 0)).toBeNull();
    } finally {
      TERRAIN_TUNING.spoilSearchMaxM = save;
    }
  });

  it('digs the 8 × 6 × 2.5 m pit with kernel and spoil alone within 1.2 × 3,185 = 3,822 strikes (RT-2)', () => {
    // The RT lab's planner (design/lab-reviewer-tests/spoil_setback.mjs): strike centres on a 0.3 m grid over the
    // footprint, struck in passes while the nearest vertex is above −2.48 m; each strike's volume goes to the spoil
    // point (raised there, the rest to the next point). PIN 3,573 strikes [RT lab: spoil_setback.out]; GATE ≤ 3,822.
    const t = new Terrain(null, 200);
    const pts: [number, number][] = [];
    for (let i = 0; -3.75 + 0.3 * i <= 3.75 + 1e-9; i++) for (let j = 0; -2.75 + 0.3 * j <= 2.75 + 1e-9; j++) pts.push([-3.75 + 0.3 * i, -2.75 + 0.3 * j]);
    let strikes = 0;
    let dug = 0;
    let unplaced = 0;
    let pass = 0;
    for (; pass < 2000; pass++) {
      let any = false;
      for (const [x, z] of pts) {
        const v = t.vertexIndex(x, z);
        if (t.vertexHeightAt(v.gi, v.gj) <= -2.48) continue;
        any = true;
        strikes++;
        let rest = t.lower(x, z, 1).volumeM3;
        dug += rest;
        for (let g = 0; rest > SPOIL_EPS_M3 && g < 100; g++) {
          const s = t.findSpoilPoint(x, z);
          if (!s) break;
          rest -= t.raise(s.x, s.z, rest).raisedM3;
        }
        unplaced += Math.max(0, rest);
      }
      if (!any) break;
    }
    console.info(`terrain: kernel-only 8 × 6 × 2.5 m pit: ${strikes} strikes in ${pass} passes, ${dug.toFixed(1)} m³ dug, ${unplaced.toExponential(2)} m³ unplaced`);
    expect(pass).toBeLessThan(2000); // GATE: it finishes
    expect(strikes).toBeLessThanOrEqual(3822); // GATE (RT-2)
    expect(unplaced).toBeLessThan(1e-4); // float32 height rounding only (a few grams of dirt)
    expect(Math.abs(netVolume(t, 0, 0, 22))).toBeLessThan(1e-4);
    // Every planned centre's vertex is at depth (the planner's own test).
    const atDepth = ([x, z]: [number, number]) => {
      const v = t.vertexIndex(x, z);
      return t.vertexHeightAt(v.gi, v.gj) <= -2.48;
    };
    expect(pts.filter((p) => !atDepth(p))).toEqual([]);
    // The rim where a cover's branch ends rest (0.5-1.25 m beyond the long sides): spoil raised there before the pit's
    // edge reached it (the lab's "rimUnderBranchEndsM", 0.00-0.23 m at a 1.5 m setback). Logged, not gated.
    let rimMax = -Infinity;
    for (let x = -4; x <= 4 + 1e-9; x += t.spacing) for (const z of [3.25, 3.5, 3.75, 4, -3.25, -3.5, -3.75, -4]) rimMax = Math.max(rimMax, t.heightAt(x, z));
    console.info(`terrain: rim under the cover's branch ends rises at most ${rimMax.toFixed(2)} m`);
    // GATE (SIM-fix4): the spoil settles at its angle of repose. No triangle outside the dug ground is steeper than
    // spoilReposeDeg; the setback ring round the pit holds no spoil (no lip at the rim); and the berm rises from the ring
    // no faster than the repose slope, so no step at the pit's edge comes near the giant's 1.0 m (RULER_BODY_TUNING).
    const slope = maxSlopeDeg(t, { cx: 0, cz: 0, r: 22 });
    let lip = -Infinity;
    let peak = -Infinity;
    for (const [gi, gj] of vertices(t, { cx: 0, cz: 0, r: 22 })) {
      const rise = t.vertexHeightAt(gi, gj) - t.vertexOriginalAt(gi, gj);
      peak = Math.max(peak, rise);
      if (t.isNearDug(gi, gj) && !t.isDugVertex(gi, gj)) lip = Math.max(lip, rise);
    }
    console.info(`terrain: berm ${peak.toFixed(2)} m high, steepest spoil triangle ${slope.toFixed(2)}°, the setback ring at most ${lip.toFixed(3)} m above original`);
    expect(slope).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + 0.01);
    expect(lip).toBeLessThanOrEqual(1e-6);
    expect(peak).toBeGreaterThan(0.5); // the dirt is a berm round the pit, not spread to nothing
  });
});

describe('generate', () => {
  beforeAll(async () => {
    await physicsReady();
  });

  /**
   * The heights generate() wrote before its tile-by-tile loop (SIM-fix2): every world vertex (gi, gj) read once, in
   * rows of z then x, at (minX + gi·spacing, minZ + gj·spacing), as float32, into every tile that holds it (the old
   * forEachCopy). Returns [original, heights] per tile.
   */
  function reference(t: Terrain, h: (x: number, z: number) => number): Float32Array[][] {
    const n = t.cells;
    const tiles = t.tilesX * t.tilesZ;
    const O = Array.from({ length: tiles }, () => new Float32Array((n + 1) * (n + 1)));
    const H = Array.from({ length: tiles }, () => new Float32Array((n + 1) * (n + 1)));
    const vx = t.tilesX * n + 1;
    const vz = t.tilesZ * n + 1;
    for (let gj = 0; gj < vz; gj++) {
      for (let gi = 0; gi < vx; gi++) {
        const v = Math.fround(h(t.minX + gi * t.spacing, t.minZ + gj * t.spacing));
        const xs: [number, number][] = [];
        const zs: [number, number][] = [];
        const tx = Math.floor(gi / n);
        if (gi % n === 0 && tx > 0) xs.push([tx - 1, n]);
        if (tx < t.tilesX) xs.push([tx, gi - tx * n]);
        const tz = Math.floor(gj / n);
        if (gj % n === 0 && tz > 0) zs.push([tz - 1, n]);
        if (tz < t.tilesZ) zs.push([tz, gj - tz * n]);
        for (const [z, r] of zs) {
          for (const [x, c] of xs) {
            O[z * t.tilesX + x][r + c * (n + 1)] = v;
            H[z * t.tilesX + x][r + c * (n + 1)] = v;
          }
        }
      }
    }
    return [O, H];
  }

  /** A seeded height function: a sum of 6 sines with random wave vectors, phases and amplitudes. */
  function seeded(seed: number): (x: number, z: number) => number {
    const rng = new Rng(seed);
    const waves = Array.from({ length: 6 }, () => ({ kx: rng.range(-2, 2), kz: rng.range(-2, 2), ph: rng.range(0, 6.3), a: rng.range(0.01, 3) }));
    return (x, z) => waves.reduce((s, q) => s + q.a * Math.sin(q.kx * x + q.kz * z + q.ph), 0);
  }

  /** The first byte where two float32 arrays differ, or -1 (byte for byte: −0 against 0 and NaN payloads count). */
  function firstDiff(a: Float32Array, b: Float32Array): number {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return Math.min(x.length, y.length);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i;
    return -1;
  }

  it('fills the 200 m Clearing terrain (64 tiles of 101²) in ≤ 20 ms of its own time (warmed, best of 5; the per-vertex version took 66 ms)', async () => {
    const p = new PhysicsWorld();
    try {
      const t = new Terrain(p, 200);
      expect(t.tileCount).toBe(64);
      const flat = (): number => 0;
      // Exclude cold JIT/allocation setup, then keep the existing 20 ms budget for a complete generate call.
      // Independent samples with an I/O turn avoid measuring a backlog of Vitest RPC work as terrain cost.
      for (let k = 0; k < 3; k++) t.generate(flat);
      let best = Infinity;
      for (let k = 0; k < 5; k++) {
        await yieldToVitest();
        const a = performance.now();
        t.generate(flat);
        best = Math.min(best, performance.now() - a);
      }
      console.info(`terrain: generate(h ≡ 0) over 64 tiles, best of 5: ${best.toFixed(1)} ms`);
      expect(best).toBeLessThanOrEqual(20);
    } finally {
      p.free();
    }
  });

  it('writes byte for byte the heights the per-vertex version wrote, for seeded and awkward height functions', () => {
    const fns: [string, (x: number, z: number) => number][] = [
      ...[1, 2, 3, 20261017].map((s): [string, (x: number, z: number) => number] => [`seed ${s}`, seeded(s)]),
      ['bumpy', bumpy],
      ['exact bits', (x, z) => x * z * 1e-3 + 1 / 3 + x / 7],
      ['steps', (x, z) => (Math.floor(x * 1.3) % 2 === 0 ? 0.5 : -0.25) + Math.floor(z / 3.7)],
      ['large', (x, z) => 1e4 + x * 123.456 - z * z * 0.789],
    ];
    for (const size of [200, 75]) {
      for (const [name, h] of fns) {
        const t = new Terrain(null, size);
        t.generate(h);
        const [O, H] = reference(t, h);
        expect(t.original.length).toBe(O.length);
        for (let k = 0; k < O.length; k++) {
          expect(firstDiff(t.original[k], O[k]), `${name}, ${size} m, tile ${k} original`).toBe(-1);
          expect(firstDiff(t.heights[k], H[k]), `${name}, ${size} m, tile ${k} heights`).toBe(-1);
        }
      }
    }
  });
});

describe('seams and the save', () => {
  it('writes tile-edge vertices identically in every tile that has them, through generation and edits', () => {
    const t = new Terrain(null, 100);
    t.generate(bumpy);
    // Dig and raise across the seams at x = 0 and z = 0 (a four-tile corner) and z = 25.
    for (let k = 0; k < 5; k++) {
      t.lower(0, 0, 1);
      t.lower(0.1, 25, 1);
      t.raise(-0.2, 25 + 0.25 * k, 0.05);
    }
    const n = t.cells;
    const n1 = n + 1;
    let compared = 0;
    for (let tz = 0; tz < t.tilesZ; tz++) {
      for (let tx = 0; tx < t.tilesX; tx++) {
        const a = tz * t.tilesX + tx;
        if (tx + 1 < t.tilesX) {
          const b = a + 1;
          for (let r = 0; r <= n; r++) {
            expect(t.heights[a][r + n * n1]).toBe(t.heights[b][r]);
            expect(t.original[a][r + n * n1]).toBe(t.original[b][r]);
            expect(t.dug[a][r + n * n1]).toBe(t.dug[b][r]);
            compared++;
          }
        }
        if (tz + 1 < t.tilesZ) {
          const b = a + t.tilesX;
          for (let c = 0; c <= n; c++) {
            expect(t.heights[a][n + c * n1]).toBe(t.heights[b][c * n1]);
            expect(t.dug[a][n + c * n1]).toBe(t.dug[b][c * n1]);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    // heightAt is continuous across a seam.
    expect(t.heightAt(-1e-9, 12.3)).toBeCloseTo(t.heightAt(1e-9, 12.3), 6);
  });

  it('edits and the dug mask round-trip onto a freshly generated terrain exactly', () => {
    const a = new Terrain(null, 50);
    a.generate(bumpy);
    for (let k = 0; k < 6; k++) a.lower(3 + 0.4 * k, -2, 1);
    a.raise(-8, 8, 0.3);
    const edits = a.edits();
    const dug = a.dugVertices();
    expect(edits.length).toBeGreaterThan(0);
    expect(dug.length).toBeGreaterThan(0);
    for (let i = 1; i < edits.length; i++) {
      const p = edits[i - 1];
      const q = edits[i];
      expect(p.tile < q.tile || (p.tile === q.tile && p.vertex < q.vertex)).toBe(true);
    }
    const b = new Terrain(null, 50);
    b.generate(bumpy);
    b.applyEdits(edits, dug);
    for (let t = 0; t < a.heights.length; t++) {
      expect(Array.from(b.heights[t])).toEqual(Array.from(a.heights[t]));
      expect(Array.from(b.dug[t])).toEqual(Array.from(a.dug[t]));
    }
    expect(b.edits()).toEqual(edits);
    // The spoil rule sees the restored mask.
    expect(b.findSpoilPoint(4, -2)).toEqual(a.findSpoilPoint(4, -2));
  });
});
