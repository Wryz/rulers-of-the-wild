// The terrain (docs/M1-DESIGN.md §2.6, §4.13): one logical chunk of square heightfield tiles, each one fixed Rapier
// heightfield collider, plus the exact height queries every "y = 0" site of DungeonStyle now reads, the dig kernel
// (`lower`), the spoil kernel (`raise`) and the spoil search.
//
// Layout (MAP rapier §2): the terrain is centred on the origin, `tilesX × tilesZ` tiles of `tileSize` m, each `cells`
// cells of `spacing` m a side, so (cells + 1)² heights per tile. Heights are column-major, `r + c·(cells + 1)`, rows along
// z and columns along x; tile `t = tz·tilesX + tx`. A vertex on a tile edge is stored in every tile that has it and every
// write goes to all copies, so seams match exactly. `heightAt` uses the heightfield's own triangle split (the diagonal
// (r+1, c)–(r, c+1)), so it matches a Rapier ray within 1.45e-5 m.
//
// `original` keeps the generated heights (the 3 m dig floor, the spoil rule, the nav extrusion rule); `dug` marks every
// vertex `lower` has ever left more than `spoilUndugTolM` below its original height (never cleared, so ground dug and
// refilled still counts, RT-2); `version[t]` bumps on every edit of tile t (client mesh, nav). An edit calls
// `collider.setShape(new Heightfield(…))` on the tile at once (it keeps the handle). Like every collider change, queries
// find the new shape at once only where they meet the tile's old bounding box (a downward ray through the old surface);
// below it (a horizontal ray into a fresh pit's wall, an overlap at its floor) they find it after the next step.
// heightAt, normalAt and supportAt read the heights, so they are exact at once.
import RAPIER from '@dimforge/rapier3d-compat';
import { defineTuning } from '../tuning/registry';
import { collisionGroups, solverGroups } from './groups';
import { MATERIAL_IDS, MATERIALS } from './materials';
import type { PhysicsWorld } from './physics';
import type { GroundQuery, MaterialId, V3 } from './types';

export const TERRAIN_TUNING = defineTuning(
  'TERRAIN_TUNING',
  'World › terrain',
  {
    tileSize: 25,
    spacing: 0.25,
    terrainChunkSize: 64,
    material: 'dirt' as MaterialId,
    digDepthM: 0.15,
    digRadiusM: 0.5,
    maxDigDepthM: 3,
    digKernel: 'cone' as 'cone',
    softGroundMaxHardness: 0.5,
    pileMergeR: 1.5,
    pileCapKg: 150,
    maxPilesNear: 12,
    pilesNearR: 10,
    spoilMinGapM: 0.5,
    spoilSearchMaxM: 15,
    spoilMaxRiseM: 1,
    spoilUndugTolM: 0.05,
    spoilSetbackM: 1.5,
  },
  {
    tileSize: { unit: 'm', source: 'NEW: D-7 (8 × 8 tiles = one 200 m chunk); read when a world is built' },
    spacing: { unit: 'm', source: 'NEW: D-7, MAP rapier §2 (a 0.5 m dig needs ≤ 0.25 m); read when a world is built' },
    terrainChunkSize: { unit: 'm', source: 'SPEC:97 (M3 generator)' },
    material: { unit: '—', source: 'NEW: D-22 (friction 0.7, soft)', options: MATERIAL_IDS },
    digDepthM: { unit: 'm per strike (peak)', source: 'SPEC:241, 883' },
    digRadiusM: { unit: 'm', source: 'SPEC:241, 883 (also the radius of the spoil cone)' },
    maxDigDepthM: { unit: 'm below original', source: 'SPEC:97' },
    digKernel: { unit: '—', source: 'D-40', options: ['cone'] },
    softGroundMaxHardness: { unit: 'hardness', source: 'NEW: D-19' },
    pileMergeR: { unit: 'm', source: 'NEW' },
    pileCapKg: { unit: 'kg', source: 'D-40 (the drag limit)' },
    maxPilesNear: { unit: 'piles', source: 'NEW: SPEC:803 body budget (§4.13)' },
    pilesNearR: { unit: 'm', source: 'NEW' },
    spoilMinGapM: { unit: 'm beyond the dig radius', source: 'NEW' },
    spoilSearchMaxM: { unit: 'm', source: 'NEW' },
    spoilMaxRiseM: { unit: 'm above original', source: 'NEW' },
    spoilUndugTolM: { unit: 'm', source: 'NEW: a vertex lowered more than this is ever dug' },
    spoilSetbackM: {
      unit: 'm',
      source: 'NEW: spoil never lands within this of dug ground (RT-2; 3,573 strikes, rim 0-0.23 m [RT lab: spoil_setback.out])',
    },
  },
);

/** One stored height that differs from its generated value (a terrain edit, for the save). */
export interface TerrainEdit {
  tile: number;
  vertex: number;
  dh: number;
}

export class Terrain implements GroundQuery {
  /** m, a tile's side (TERRAIN_TUNING.tileSize when the world was built). */
  readonly tileSize: number;
  /** m between vertices (tileSize / cells). */
  readonly spacing: number;
  readonly tilesX: number;
  readonly tilesZ: number;
  /** Cells per tile side (heights per tile: (cells + 1)²). */
  readonly cells: number;
  /** World x and z of the terrain's min corner (the terrain is centred on the origin). */
  readonly minX: number;
  readonly minZ: number;
  /** Generated heights per tile. */
  readonly original: Float32Array[];
  /** Current heights per tile (column-major r + c·(cells + 1), rows along z). */
  readonly heights: Float32Array[];
  /** Per tile vertex: 1 once `lower` has ever left it more than spoilUndugTolM below original (never cleared). */
  readonly dug: Uint8Array[];
  /** Per tile, bumped on every edit. */
  readonly version: Uint32Array;

  private readonly physics: PhysicsWorld | null;
  private readonly colliders: (RAPIER.Collider | null)[];
  /** Vertices per world row and column. */
  private readonly vx: number;
  private readonly vz: number;
  /** Per world vertex (gj·vx + gi): how many ever-dug vertices lie within `nearDugSetback` of it. */
  private nearDug: Uint16Array;
  private nearDugSetback: number;

  /**
   * `physics` null builds the heights alone (no colliders): kernel tests and tools that need no Rapier. `size` (m) is
   * rounded to whole tiles (at least one).
   */
  constructor(physics: PhysicsWorld | null, size: number) {
    const T = TERRAIN_TUNING;
    this.tileSize = T.tileSize;
    this.cells = Math.max(1, Math.round(T.tileSize / T.spacing));
    this.spacing = this.tileSize / this.cells;
    this.tilesX = Math.max(1, Math.round(size / this.tileSize));
    this.tilesZ = this.tilesX;
    this.minX = -(this.tilesX * this.tileSize) / 2;
    this.minZ = -(this.tilesZ * this.tileSize) / 2;
    this.vx = this.tilesX * this.cells + 1;
    this.vz = this.tilesZ * this.cells + 1;
    const n = (this.cells + 1) * (this.cells + 1);
    const tiles = this.tilesX * this.tilesZ;
    this.original = Array.from({ length: tiles }, () => new Float32Array(n));
    this.heights = Array.from({ length: tiles }, () => new Float32Array(n));
    this.dug = Array.from({ length: tiles }, () => new Uint8Array(n));
    this.version = new Uint32Array(tiles);
    this.nearDug = new Uint16Array(this.vx * this.vz);
    this.nearDugSetback = T.spoilSetbackM;
    this.physics = physics;
    this.colliders = [];
    for (let t = 0; t < tiles; t++) this.colliders.push(physics ? this.makeCollider(physics, t) : null);
  }

  /** The number of tiles. */
  get tileCount(): number {
    return this.tilesX * this.tilesZ;
  }

  /** World x, z of tile t's centre. */
  tileCentre(t: number): { x: number; z: number } {
    const tx = t % this.tilesX;
    const tz = (t - tx) / this.tilesX;
    return { x: this.minX + (tx + 0.5) * this.tileSize, z: this.minZ + (tz + 0.5) * this.tileSize };
  }

  // -------------------------------------------------------------------------
  // Generation and loading
  // -------------------------------------------------------------------------

  /**
   * Sets the generated heights from `h(x, z)` at every vertex (both `original` and the current heights, as float32),
   * clears the dug mask, and refreshes every tile. Used by generation (generateClearing) before any edit. `h` must be a
   * pure function of (x, z): it is read tile by tile, each tile's copy of a seam vertex at the same world (x, z) (from
   * its global vertex index, minX + gi·spacing), so the copies match exactly.
   */
  generate(h: (x: number, z: number) => number): void {
    const n = this.cells;
    const n1 = n + 1;
    const sp = this.spacing;
    for (let tz = 0; tz < this.tilesZ; tz++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const t = tz * this.tilesX + tx;
        const O = this.original[t];
        const H = this.heights[t];
        for (let c = 0; c <= n; c++) {
          const x = this.minX + (tx * n + c) * sp;
          const col = c * n1;
          for (let r = 0; r <= n; r++) {
            const v = Math.fround(h(x, this.minZ + (tz * n + r) * sp));
            O[col + r] = v;
            H[col + r] = v;
          }
        }
      }
    }
    for (const d of this.dug) d.fill(0);
    this.nearDug.fill(0);
    this.nearDugSetback = TERRAIN_TUNING.spoilSetbackM;
    this.refresh(this.allTiles());
  }

  /** Every stored height that differs from its generated value, sorted (tile, vertex): the save's terrain edits. */
  edits(): TerrainEdit[] {
    const out: TerrainEdit[] = [];
    for (let t = 0; t < this.heights.length; t++) {
      const H = this.heights[t];
      const O = this.original[t];
      for (let i = 0; i < H.length; i++) if (H[i] !== O[i]) out.push({ tile: t, vertex: i, dh: H[i] - O[i] });
    }
    return out;
  }

  /** Every ever-dug vertex as (tile, vertex), sorted: the save's dug mask. */
  dugVertices(): [number, number][] {
    const out: [number, number][] = [];
    for (let t = 0; t < this.dug.length; t++) {
      const D = this.dug[t];
      for (let i = 0; i < D.length; i++) if (D[i]) out.push([t, i]);
    }
    return out;
  }

  /**
   * Applies saved edits and the dug mask over the generated heights (the loader, after generation): every height is
   * `original + dh` exactly (dh is the f64 difference of two float32 values), every listed vertex is ever-dug.
   */
  applyEdits(edits: readonly TerrainEdit[], dug: readonly (readonly [number, number])[]): void {
    const touched = new Set<number>();
    for (const e of edits) {
      this.heights[e.tile][e.vertex] = Math.fround(this.original[e.tile][e.vertex] + e.dh);
      touched.add(e.tile);
    }
    for (const [t, i] of dug) this.dug[t][i] = 1;
    this.rebuildNearDug();
    this.refresh([...touched].sort((a, b) => a - b));
  }

  // -------------------------------------------------------------------------
  // Queries (GroundQuery)
  // -------------------------------------------------------------------------

  /** Terrain height under (x, z), exact on the heightfield's triangles; the edge height beyond the terrain. */
  heightAt(x: number, z: number): number {
    return this.sample(this.heights, x, z);
  }

  /** The generated height under (x, z). */
  originalHeightAt(x: number, z: number): number {
    return this.sample(this.original, x, z);
  }

  /** The upward unit normal of the terrain triangle under (x, z), written to `out`. */
  normalAt(x: number, z: number, out: V3): V3 {
    const c = this.cellAt(x, z);
    const H = this.heights[c.t];
    const n1 = this.cells + 1;
    const s = this.spacing;
    const h00 = H[c.r + c.c * n1];
    const h10 = H[c.r + 1 + c.c * n1];
    const h01 = H[c.r + (c.c + 1) * n1];
    const h11 = H[c.r + 1 + (c.c + 1) * n1];
    // Slopes along x (u) and z (v) of the triangle that holds the point.
    const lower = c.u + c.v <= 1;
    const dx = (lower ? h01 - h00 : h11 - h10) / s;
    const dz = (lower ? h10 - h00 : h11 - h01) / s;
    const len = Math.hypot(dx, 1, dz);
    out.x = -dx / len;
    out.y = 1 / len;
    out.z = -dz / len;
    return out;
  }

  /** Terrain only: the terrain height (World.supportAt adds the fixed, anchored and resting entities, §4.7). */
  supportAt(x: number, z: number, _fromY?: number): number {
    return this.heightAt(x, z);
  }

  // -------------------------------------------------------------------------
  // Dig and spoil (§4.13)
  // -------------------------------------------------------------------------

  /**
   * One dig: every vertex within digRadiusM of (x, z) drops by digDepthM × depthMul × (1 − dist/r) (the cone kernel,
   * D-40), clamped to original − maxDigDepthM. Returns the removed volume (Σ Δh × spacing²) and the tiles changed.
   */
  lower(x: number, z: number, depthMul: number): { volumeM3: number; tiles: number[] } {
    const T = TERRAIN_TUNING;
    const r = T.digRadiusM;
    const peak = T.digDepthM * depthMul;
    const touched = new Set<number>();
    let volume = 0;
    if (peak > 0 && r > 0) {
      const cellArea = this.spacing * this.spacing;
      this.forVerticesWithin(x, z, r, (gi, gj, d) => {
        const h = this.vertexHeight(this.heights, gi, gj);
        const o = this.vertexHeight(this.original, gi, gj);
        const target = Math.fround(Math.max(h - peak * (1 - d / r), o - T.maxDigDepthM));
        if (!(target < h)) return;
        volume += (h - target) * cellArea;
        this.setVertex(gi, gj, target, touched);
        if (o - target > T.spoilUndugTolM) this.markDug(gi, gj);
      });
    }
    const tiles = [...touched].sort((a, b) => a - b);
    this.refresh(tiles);
    return { volumeM3: volume, tiles };
  }

  /**
   * Adds `volumeM3` of spoil around (x, z) as a mound (an inverted cone of radius digRadiusM, Δh = k·(1 − dist/r)) of
   * exactly that volume, each vertex capped at original + spoilMaxRiseM: the cone is filled level by level, so capped
   * vertices pass their share to the others. Never touches an ever-dug vertex or one within spoilSetbackM of one.
   * Returns the volume actually placed (less than asked only when every eligible vertex is at its cap; the caller
   * takes the remainder to the next spoil point) and the tiles changed.
   */
  raise(x: number, z: number, volumeM3: number): { tiles: number[]; raisedM3: number } {
    const T = TERRAIN_TUNING;
    const r = T.digRadiusM;
    const cellArea = this.spacing * this.spacing;
    const touched = new Set<number>();
    if (!(volumeM3 > 0) || !(r > 0)) return { tiles: [], raisedM3: 0 };
    this.syncNearDug();
    // Eligible vertices in a fixed order (rows of z, then x), with their cone weight and headroom.
    const cand: { gi: number; gj: number; w: number; cap: number; h: number }[] = [];
    this.forVerticesWithin(x, z, r, (gi, gj, d) => {
      if (this.nearDug[gj * this.vx + gi] > 0) return;
      const h = this.vertexHeight(this.heights, gi, gj);
      const top = this.spoilCap(gi, gj);
      if (h >= top) return;
      cand.push({ gi, gj, w: 1 - d / r, cap: top - h, h });
    });
    if (cand.length === 0) return { tiles: [], raisedM3: 0 };
    // Find k with Σ min(k·w, cap) = volume / cellArea (vertices saturate in order of cap / w).
    const order = cand.map((_, i) => i).sort((a, b) => cand[a].cap / cand[a].w - cand[b].cap / cand[b].w || a - b);
    let remaining = volumeM3 / cellArea;
    let wsum = 0;
    for (const c of cand) wsum += c.w;
    let k = Infinity;
    for (const i of order) {
      const c = cand[i];
      const need = remaining / wsum;
      if (need <= c.cap / c.w) {
        k = need;
        break;
      }
      remaining -= c.cap;
      wsum -= c.w;
    }
    let raised = 0;
    for (const c of cand) {
      const target = Math.fround(c.h + Math.min(k * c.w, c.cap));
      if (!(target > c.h)) continue;
      raised += (target - c.h) * cellArea;
      this.setVertex(c.gi, c.gj, target, touched);
    }
    const tiles = [...touched].sort((a, b) => a - b);
    this.refresh(tiles);
    return { tiles, raisedM3: raised };
  }

  /**
   * The spoil point for a dig at (x, z) (§4.13): the first vertex, searching rings `spacing` apart outward from
   * digRadiusM + spoilMinGapM to spoilSearchMaxM, each ring in a fixed angular order from +x toward +z, that has no
   * ever-dug vertex within spoilSetbackM and lies below original + spoilMaxRiseM. null when none is found.
   */
  findSpoilPoint(x: number, z: number): { x: number; z: number } | null {
    const T = TERRAIN_TUNING;
    this.syncNearDug();
    const r0 = T.digRadiusM + T.spoilMinGapM;
    const rings = Math.floor((T.spoilSearchMaxM - r0) / this.spacing + 1e-9);
    for (let k = 0; k <= rings; k++) {
      const r = r0 + k * this.spacing;
      const n = Math.max(1, Math.ceil((2 * Math.PI * r) / this.spacing));
      for (let a = 0; a < n; a++) {
        const th = (2 * Math.PI * a) / n;
        const gi = Math.round((x + r * Math.cos(th) - this.minX) / this.spacing);
        const gj = Math.round((z + r * Math.sin(th) - this.minZ) / this.spacing);
        if (gi < 0 || gj < 0 || gi >= this.vx || gj >= this.vz) continue;
        if (this.nearDug[gj * this.vx + gi] > 0) continue;
        const h = this.vertexHeight(this.heights, gi, gj);
        if (h >= this.spoilCap(gi, gj)) continue;
        return { x: this.minX + gi * this.spacing, z: this.minZ + gj * this.spacing };
      }
    }
    return null;
  }

  /**
   * The highest height spoil may raise world vertex (gi, gj) to: original + spoilMaxRiseM as a float32 (the heights'
   * own precision, so a vertex raised to its cap reads exactly as at its cap).
   */
  spoilCap(gi: number, gj: number): number {
    return Math.fround(this.vertexHeight(this.original, gi, gj) + TERRAIN_TUNING.spoilMaxRiseM);
  }

  /** Whether a world vertex (by world indices) is ever-dug. */
  isDugVertex(gi: number, gj: number): boolean {
    const { t, i } = this.canonical(gi, gj);
    return this.dug[t][i] === 1;
  }

  /** Whether any ever-dug vertex lies within spoilSetbackM of world vertex (gi, gj) (the vertex itself included). */
  isNearDug(gi: number, gj: number): boolean {
    this.syncNearDug();
    return this.nearDug[gj * this.vx + gi] > 0;
  }

  /** World vertex indices (gi along x, gj along z) of the vertex nearest (x, z), clamped to the terrain. */
  vertexIndex(x: number, z: number): { gi: number; gj: number } {
    const gi = Math.min(this.vx - 1, Math.max(0, Math.round((x - this.minX) / this.spacing)));
    const gj = Math.min(this.vz - 1, Math.max(0, Math.round((z - this.minZ) / this.spacing)));
    return { gi, gj };
  }

  /** The stored height of world vertex (gi, gj). */
  vertexHeightAt(gi: number, gj: number): number {
    return this.vertexHeight(this.heights, gi, gj);
  }

  /** The generated height of world vertex (gi, gj). */
  vertexOriginalAt(gi: number, gj: number): number {
    return this.vertexHeight(this.original, gi, gj);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private makeCollider(physics: PhysicsWorld, t: number): RAPIER.Collider {
    const centre = this.tileCentre(t);
    const desc = RAPIER.ColliderDesc.heightfield(this.cells, this.cells, this.heights[t], this.scale(), RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
      .setTranslation(centre.x, 0, centre.z)
      .setFriction(MATERIALS[TERRAIN_TUNING.material].friction)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
      .setCollisionGroups(collisionGroups('TERRAIN'))
      .setSolverGroups(solverGroups('TERRAIN'));
    const c = physics.rapier.createCollider(desc);
    physics.register(c, { kind: 'terrain' });
    return c;
  }

  private scale(): { x: number; y: number; z: number } {
    return { x: this.tileSize, y: 1, z: this.tileSize };
  }

  /** Rebuilds the listed tiles' colliders (setShape keeps each handle) and bumps their versions. */
  private refresh(tiles: readonly number[]): void {
    for (const t of tiles) {
      this.version[t]++;
      const c = this.colliders[t];
      if (c && this.physics && !this.physics.isFreed) {
        c.setShape(new RAPIER.Heightfield(this.cells, this.cells, this.heights[t], this.scale(), RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES));
      }
    }
  }

  private allTiles(): number[] {
    return Array.from({ length: this.tileCount }, (_, t) => t);
  }

  /** The cell and triangle coordinates under (x, z), clamped to the terrain. */
  private cellAt(x: number, z: number): { t: number; r: number; c: number; u: number; v: number } {
    const gx = (x - this.minX) / this.spacing;
    const gz = (z - this.minZ) / this.spacing;
    const ci = Math.min(this.vx - 2, Math.max(0, Math.floor(gx)));
    const cj = Math.min(this.vz - 2, Math.max(0, Math.floor(gz)));
    const u = Math.min(1, Math.max(0, gx - ci));
    const v = Math.min(1, Math.max(0, gz - cj));
    const tx = Math.min(this.tilesX - 1, Math.floor(ci / this.cells));
    const tz = Math.min(this.tilesZ - 1, Math.floor(cj / this.cells));
    return { t: tz * this.tilesX + tx, c: ci - tx * this.cells, r: cj - tz * this.cells, u, v };
  }

  private sample(arrays: readonly Float32Array[], x: number, z: number): number {
    const c = this.cellAt(x, z);
    const H = arrays[c.t];
    const n1 = this.cells + 1;
    const h00 = H[c.r + c.c * n1];
    const h10 = H[c.r + 1 + c.c * n1];
    const h01 = H[c.r + (c.c + 1) * n1];
    const h11 = H[c.r + 1 + (c.c + 1) * n1];
    const { u, v } = c;
    return u + v <= 1 ? h00 + u * (h01 - h00) + v * (h10 - h00) : h11 + (1 - u) * (h10 - h11) + (1 - v) * (h01 - h11);
  }

  /** The tile and index that hold world vertex (gi, gj) (the lowest tile on a seam). */
  private canonical(gi: number, gj: number): { t: number; i: number } {
    const tx = Math.min(this.tilesX - 1, Math.floor(gi / this.cells));
    const tz = Math.min(this.tilesZ - 1, Math.floor(gj / this.cells));
    const c = gi - tx * this.cells;
    const r = gj - tz * this.cells;
    return { t: tz * this.tilesX + tx, i: r + c * (this.cells + 1) };
  }

  private vertexHeight(arrays: readonly Float32Array[], gi: number, gj: number): number {
    const { t, i } = this.canonical(gi, gj);
    return arrays[t][i];
  }

  /** Calls fn for every stored copy of world vertex (gi, gj): one tile inside, two on an edge, four on a corner. */
  private forEachCopy(gi: number, gj: number, fn: (t: number, i: number) => void): void {
    const n = this.cells;
    const xs: [number, number][] = [];
    const zs: [number, number][] = [];
    const tx = Math.floor(gi / n);
    if (gi % n === 0 && tx > 0) xs.push([tx - 1, n]);
    if (tx < this.tilesX) xs.push([tx, gi - tx * n]);
    const tz = Math.floor(gj / n);
    if (gj % n === 0 && tz > 0) zs.push([tz - 1, n]);
    if (tz < this.tilesZ) zs.push([tz, gj - tz * n]);
    for (const [z, r] of zs) for (const [x, c] of xs) fn(z * this.tilesX + x, r + c * (n + 1));
  }

  private setVertex(gi: number, gj: number, h: number, touched: Set<number>): void {
    this.forEachCopy(gi, gj, (t, i) => {
      this.heights[t][i] = h;
      touched.add(t);
    });
  }

  private markDug(gi: number, gj: number): void {
    if (this.isDugVertex(gi, gj)) return;
    // (Synced before the mark: a rebuild after it would count this vertex twice.)
    this.syncNearDug();
    this.forEachCopy(gi, gj, (t, i) => {
      this.dug[t][i] = 1;
    });
    this.addNearDug(gi, gj, 1);
  }

  /** Vertices within `r` (strictly) of (x, z), rows of z then x, with their distance. */
  private forVerticesWithin(x: number, z: number, r: number, fn: (gi: number, gj: number, d: number) => void): void {
    const s = this.spacing;
    const gi0 = Math.max(0, Math.ceil((x - r - this.minX) / s));
    const gi1 = Math.min(this.vx - 1, Math.floor((x + r - this.minX) / s));
    const gj0 = Math.max(0, Math.ceil((z - r - this.minZ) / s));
    const gj1 = Math.min(this.vz - 1, Math.floor((z + r - this.minZ) / s));
    for (let gj = gj0; gj <= gj1; gj++) {
      for (let gi = gi0; gi <= gi1; gi++) {
        const d = Math.hypot(this.minX + gi * s - x, this.minZ + gj * s - z);
        if (d < r) fn(gi, gj, d);
      }
    }
  }

  /** Adds `delta` to the near-dug count of every vertex within spoilSetbackM (inclusive) of (gi, gj). */
  private addNearDug(gi: number, gj: number, delta: number): void {
    const s = this.spacing;
    const R = this.nearDugSetback;
    const k = Math.ceil(R / s);
    for (let b = Math.max(0, gj - k); b <= Math.min(this.vz - 1, gj + k); b++) {
      for (let a = Math.max(0, gi - k); a <= Math.min(this.vx - 1, gi + k); a++) {
        if (Math.hypot((a - gi) * s, (b - gj) * s) <= R + 1e-9) this.nearDug[b * this.vx + a] += delta;
      }
    }
  }

  /** The near-dug field is derived from the dug mask at the live setback: rebuilt if the setback was retuned. */
  private syncNearDug(): void {
    if (this.nearDugSetback !== TERRAIN_TUNING.spoilSetbackM) this.rebuildNearDug();
  }

  private rebuildNearDug(): void {
    this.nearDug.fill(0);
    this.nearDugSetback = TERRAIN_TUNING.spoilSetbackM;
    for (let gj = 0; gj < this.vz; gj++) for (let gi = 0; gi < this.vx; gi++) if (this.isDugVertex(gi, gj)) this.addNearDug(gi, gj, 1);
  }
}
