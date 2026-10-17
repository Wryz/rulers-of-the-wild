// Navmesh input geometry (docs/M1-DESIGN.md §7): per tile, the terrain triangles of the tile's grown rect with the
// heightfield's own diagonal split, and every fixed, anchored or resting entity overlapping it (triangulated from its
// shape, in id order), with the ruler layer's blocker extrusion; plus every entity's footprint, which marks the inside of
// a solid as unwalkable and which the human layer's blocker bitmap rasterises (§4.1, RF-23).
//
// The module is pure geometry over sim state: nav.ts (its only caller) decides which entities are input (the baked
// set, see NavSystem) and passes every parameter in, so nothing here reads a tuning table or recast.
//
// Winding: Recast's triangle normal is (v1 − v0) × (v2 − v0) and a triangle is walkable when that normal points up
// within the slope limit (MAP recast §3.1). shapes.ts's `triangulate` winds every face that way already ((b − a) × (c − a)
// points out of the shape), and the terrain patch below winds its two triangles per cell the same way.
import { triangulate } from './shapes';
import type { Terrain } from './terrain';
import type { Entity, Pose3, Shape, V3 } from './types';
import type { World } from './world';

/** An axis-aligned box in world space. */
export interface NavAabb {
  min: V3;
  max: V3;
}

/** A rectangle on the ground plane (world x and z), bounds inclusive. */
export interface NavRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Triangle soup for Recast: xyz triples and triangle vertex indices. */
export interface NavGeometry {
  positions: Float32Array;
  indices: Int32Array;
}

/**
 * One entity as the navmesh sees it: the record the nav system baked when the entity last entered or changed in its
 * input set (NavSystem's "baked set"). Tiles are always built from these records, never from live entities, so a tile
 * rebuilt for any reason sees the same entities a fresh build would (docs/M1-DESIGN.md §7, determinism).
 */
export interface NavEntityInput {
  readonly id: number;
  /** The entity's shape object when baked (a reshape or cross-cut replaces the object, so identity tells a change). */
  readonly shape: Shape;
  readonly pose: Pose3;
  /** The entity's state was fixed or anchored when baked (a felling tree leaves the set at once, §7). */
  readonly anchored: boolean;
  /** Fixed, anchored (isAnchored: lashed to an anchored entity counts) or at least blockerMinKg. */
  readonly blocker: boolean;
  /** A blocker whose top rises above the original ground + the giant's ankle: extruded on the ruler layer. */
  readonly extrude: boolean;
  readonly aabb: NavAabb;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** The convex hull of the shape on the ground plane, counter-clockwise (x, z) pairs. */
  readonly footprint: Float64Array;
}

/** How an entity stands toward the navmesh input rule of §7. */
export type NavPresence =
  /** fixed or anchored, with its (fixed) body: always input */
  | 'static'
  /** free, its body enabled and resting (restTicks ≥ the rest threshold) or asleep: input */
  | 'resting'
  /** free and moving: not input yet; its baked record (if any) stays until it comes to rest (§7) */
  | 'moving'
  /** no enabled body (held, stowed, tied, projectile, frozen): not input */
  | 'gone';

/** §7: "every fixed, anchored or resting (restTicks ≥ 30 or asleep) entity"; moving bodies are never input. */
export function navPresence(e: Entity, restTicks: number): NavPresence {
  const b = e.body;
  if (!b || !b.isEnabled()) return 'gone';
  if (e.state === 'fixed' || e.state === 'anchored') return 'static';
  if (e.state !== 'free') return 'gone';
  return e.restTicks >= restTicks || b.isSleeping() ? 'resting' : 'moving';
}

/** Fixed, anchored (or lashed to an anchored entity, §2.3), or at least `blockerMinKg` (SPEC:781, 880). */
export function isNavBlocker(w: World, e: Entity, blockerMinKg: number): boolean {
  return w.entities.isAnchored(e) || e.mass >= blockerMinKg;
}

/**
 * Bakes an entity's navmesh record: its triangles at its current pose, its AABB, its class and its footprint. A blocker is extruded on the ruler layer when its top rises more than `extrudeAboveAnkleM` above the
 * original ground under it (§7): "under it" is the lowest generated height at the AABB's centre and four corners, so a
 * log lying across a slope is judged from its low side (where the giant would meet it), and stakes inside a dug pit,
 * whose tops stay below the original ground, are never extruded (the cover over them stays walkable).
 */
export function navBakeEntity(w: World, e: Entity, o: { blockerMinKg: number; extrudeAboveAnkleM: number }): NavEntityInput {
  const tri = triangulate(e.shape, e.pose);
  const aabb = navAabbOf(tri.positions);
  const blocker = isNavBlocker(w, e, o.blockerMinKg);
  let extrude = false;
  if (blocker && tri.positions.length > 0) {
    const t = w.terrain;
    const cx = (aabb.min.x + aabb.max.x) / 2;
    const cz = (aabb.min.z + aabb.max.z) / 2;
    const ground = Math.min(
      t.originalHeightAt(cx, cz),
      t.originalHeightAt(aabb.min.x, aabb.min.z),
      t.originalHeightAt(aabb.max.x, aabb.min.z),
      t.originalHeightAt(aabb.min.x, aabb.max.z),
      t.originalHeightAt(aabb.max.x, aabb.max.z),
    );
    extrude = aabb.max.y > ground + o.extrudeAboveAnkleM;
  }
  return {
    id: e.id,
    shape: e.shape,
    pose: { p: { ...e.pose.p }, q: { ...e.pose.q } },
    anchored: e.state === 'fixed' || e.state === 'anchored',
    blocker,
    extrude,
    aabb,
    positions: tri.positions,
    indices: tri.indices,
    footprint: navConvexHullXZ(tri.positions),
  };
}

/** The xz overlap test every tile uses (inclusive bounds). */
export function navOverlapsXZ(a: NavAabb, r: NavRect): boolean {
  return a.max.x >= r.x0 && a.min.x <= r.x1 && a.max.z >= r.z0 && a.min.z <= r.z1;
}

/**
 * One tile's input: the terrain patch covering `rect` (the tile's rect grown by Recast's border) and the entities
 * given (already filtered to those overlapping it, in id order). `extrudeM` non-null (the ruler layer) replaces every
 * extruded blocker by its footprint extruded from the AABB's bottom up `extrudeM` (§7; see navExtrusion).
 */
export function navTileGeometry(t: Terrain, rect: NavRect, ents: readonly NavEntityInput[], extrudeM: number | null): NavGeometry {
  const parts: { positions: ArrayLike<number>; indices: ArrayLike<number> }[] = [navTerrainPatch(t, rect)];
  for (const e of ents) parts.push(extrudeM !== null && e.extrude ? navExtrusion(e, extrudeM) : e);
  return merge(parts);
}

/**
 * The terrain triangles covering `rect` (clamped to the terrain), two per heightfield cell split along the diagonal
 * (r + 1, c)–(r, c + 1) as the heightfield is (§2.6), wound up for Recast. Vertex positions are the terrain's own
 * (x = minX + gi·spacing, the stored float32 height), so every tile that shares a vertex sees the same one.
 */
export function navTerrainPatch(t: Terrain, rect: NavRect): NavGeometry {
  const s = t.spacing;
  const vx = t.tilesX * t.cells + 1;
  const vz = t.tilesZ * t.cells + 1;
  const gi0 = Math.max(0, Math.floor((rect.x0 - t.minX) / s));
  const gi1 = Math.min(vx - 1, Math.ceil((rect.x1 - t.minX) / s));
  const gj0 = Math.max(0, Math.floor((rect.z0 - t.minZ) / s));
  const gj1 = Math.min(vz - 1, Math.ceil((rect.z1 - t.minZ) / s));
  if (gi1 <= gi0 || gj1 <= gj0) return { positions: new Float32Array(0), indices: new Int32Array(0) };
  const nx = gi1 - gi0 + 1;
  const nz = gj1 - gj0 + 1;
  const positions = new Float32Array(nx * nz * 3);
  let p = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      positions[p++] = t.minX + (gi0 + i) * s;
      positions[p++] = t.vertexHeightAt(gi0 + i, gj0 + j);
      positions[p++] = t.minZ + (gj0 + j) * s;
    }
  }
  const indices = new Int32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      // a = (gi, gj), b = +x, c = +z, d = both; diagonal b–c (the heightfield's split), normals up.
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[q++] = a;
      indices[q++] = c;
      indices[q++] = b;
      indices[q++] = b;
      indices[q++] = c;
      indices[q++] = d;
    }
  }
  return { positions, indices };
}

/**
 * The ruler layer's extruded blocker: the entity's footprint (its convex hull on the ground plane) as a closed prism from
 * its AABB's bottom up `heightM`. §7 says "a box from its AABB bottom": for a log lying along x or z the two are the
 * same, but the AABB of a log lying diagonally is a square up to 0.7 × its length on a side, which would wall off far
 * more ground than the log covers; the footprint keeps the extrusion to the log. A degenerate footprint (fewer than
 * three points) falls back to the AABB box.
 */
export function navExtrusion(e: NavEntityInput, heightM: number): { positions: Float32Array; indices: Uint32Array } {
  const fp = e.footprint;
  if (fp.length < 6) return navExtrusionBox(e.aabb, heightM);
  const y0 = e.aabb.min.y;
  const points: number[] = [];
  for (const y of [y0, y0 + heightM]) for (let k = 0; k < fp.length; k += 2) points.push(fp[k], y, fp[k + 1]);
  return triangulate({ kind: 'hull', points }, { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } });
}

/** A closed box over `aabb`'s footprint from its bottom up `heightM`. */
export function navExtrusionBox(aabb: NavAabb, heightM: number): { positions: Float32Array; indices: Uint32Array } {
  const hx = (aabb.max.x - aabb.min.x) / 2;
  const hz = (aabb.max.z - aabb.min.z) / 2;
  const hy = heightM / 2;
  const p = { x: (aabb.min.x + aabb.max.x) / 2, y: aabb.min.y + hy, z: (aabb.min.z + aabb.max.z) / 2 };
  return triangulate({ kind: 'box', hx, hy, hz }, { p, q: { x: 0, y: 0, z: 0, w: 1 } });
}

/** The AABB of xyz triples (an empty list gives an empty box at the origin). */
export function navAabbOf(positions: ArrayLike<number>): NavAabb {
  if (positions.length < 3) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return { min, max };
}

/** Grows a box by `m` on every side of the ground plane (y unchanged). */
export function navGrowXZ(a: NavAabb, m: number): NavAabb {
  return { min: { x: a.min.x - m, y: a.min.y, z: a.min.z - m }, max: { x: a.max.x + m, y: a.max.y, z: a.max.z + m } };
}

/** The union of two boxes. */
export function navUnionAabb(a: NavAabb, b: NavAabb): NavAabb {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  };
}

// ---------------------------------------------------------------------------
// Footprints (solid interiors, the blocker bitmap §4.1)
// ---------------------------------------------------------------------------

/**
 * The convex hull of xyz triples projected on the ground plane, as counter-clockwise (x, z) pairs (Andrew's monotone
 * chain, ties broken by z): a convex shape's footprint. Fewer than three distinct points give the points themselves.
 */
export function navConvexHullXZ(positions: ArrayLike<number>): Float64Array {
  const pts: [number, number][] = [];
  for (let i = 0; i < positions.length; i += 3) pts.push([positions[i], positions[i + 2]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq: [number, number][] = [];
  for (const p of pts) if (uniq.length === 0 || uniq[uniq.length - 1][0] !== p[0] || uniq[uniq.length - 1][1] !== p[1]) uniq.push(p);
  if (uniq.length < 3) return Float64Array.from(uniq.flat());
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return Float64Array.from([...lower, ...upper].flat());
}

/**
 * The distance on the ground plane from (x, z) to a polygon given as (x, z) pairs (0 inside or on it). Works for any
 * simple polygon (even-odd inside test, then the nearest edge); a point or a segment is measured as such.
 */
export function navDistanceToPolygonXZ(poly: ArrayLike<number>, x: number, z: number): number {
  const n = poly.length / 2;
  if (n === 0) return Infinity;
  if (n === 1) return Math.hypot(x - poly[0], z - poly[1]);
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i];
    const zi = poly[2 * i + 1];
    const xj = poly[2 * j];
    const zj = poly[2 * j + 1];
    if (n > 2 && zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const d = segmentDistanceXZ(x, z, xj, zj, xi, zi);
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

/**
 * Whether (x, z) lies within `r` of a polygon given as (x, z) pairs on the ground plane: the same answer as
 * `navDistanceToPolygonXZ(poly, x, z) <= r`, without square roots (the bitmaps ask it for every cell).
 */
export function navWithinPolygonXZ(poly: ArrayLike<number>, x: number, z: number, r: number): boolean {
  const n = poly.length / 2;
  if (n === 0) return false;
  if (n > 2) {
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[2 * i];
      const zi = poly[2 * i + 1];
      const xj = poly[2 * j];
      const zj = poly[2 * j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  const r2 = r * r;
  if (n === 1) return (x - poly[0]) ** 2 + (z - poly[1]) ** 2 <= r2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[2 * j];
    const az = poly[2 * j + 1];
    const dx = poly[2 * i] - ax;
    const dz = poly[2 * i + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 <= r2) return true;
  }
  return false;
}

function segmentDistanceXZ(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Concatenates triangle soups (indices offset; never merges vertices: MAP recast §3.1's merge helper is buggy). */
function merge(parts: readonly { positions: ArrayLike<number>; indices: ArrayLike<number> }[]): NavGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.positions.length;
    ni += p.indices.length;
  }
  const positions = new Float32Array(nv);
  const indices = new Int32Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const base = vo / 3;
    for (let i = 0; i < p.positions.length; i++) positions[vo + i] = p.positions[i];
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + base;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return { positions, indices };
}
