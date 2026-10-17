// Shape functions: volume, collider descriptors, triangulation for nav input, fracture, cross-cut, taperEnd
// (docs/M1-DESIGN.md §2.2). The Shape and SharpPoint types live in world/types.ts.
//
// Everything here is pure geometry in a shape's local frame, except colliderDesc, which builds a Rapier descriptor
// and so needs `physicsReady()` to have run (no Rapier call happens at module top level).
//
// Conventions:
// - A `cylinder` is a regular N-gon prism, r = circumradius, axis local +Y, vertex k at angle (k + ½)·2π/N from +X
//   toward +Z (so an 8-gon has a flat face toward ±X and ±Z, as the C labs built it). `cylinderPoints` gives the exact
//   collider vertices, so the client can draw the same prism.
// - A shape's long axis (`principalAxis`) is a local coordinate axis: +Y for cylinders, capsules and balls; for boxes
//   and hulls the axis of the largest extent (ties: Y, then X, then Z). `axisT` (crossCut, Entity.crossCut) is the
//   signed coordinate along that axis in the local frame, m, between its `min` and `max`.
// - A piece returned by fracture or crossCut is `{ shape, offset }`: the piece's own local origin sits at `offset` in
//   the parent's local frame, with the parent's rotation. Prism and box cuts stay prisms and boxes centred on their
//   origin; hull pieces are centred on their own centre of mass.
// - Balls and capsules (M2+ and tests, §2.2) are cut, fractured, tapered and triangulated through a polygonal stand-in
//   whose volume is matched exactly to the round shape's, so mass is conserved.
import RAPIER from '@dimforge/rapier3d-compat';
import type { Rng } from '../sim/math';
import type { Material, Pose3, Shape, V3 } from './types';

/**
 * Relative geometric tolerance: a point within GEOM_EPS × (the point set's extent) of a hull face counts as on it.
 * Not a starting value: floating-point slack (the same 1e-9 as materials' PROPERTY_EPS).
 */
export const GEOM_EPS = 1e-9;

/**
 * Segments around the polygonal stand-in for a ball or capsule. Not a starting value: the resolution of an
 * approximation whose volume is matched exactly. TODO(P05): move to PHYSICS_TUNING if M2's round props need tuning.
 */
const ROUND_SEGMENTS = 16;

const TAU = 2 * Math.PI;

type P3 = [number, number, number];
type Face = { a: number; b: number; c: number; n: P3; d: number };
interface Hull {
  /** Hull vertices only, in the order of the input points they came from. */
  pts: P3[];
  /** Outward triangles: (b − a) × (c − a) points out of the hull. */
  faces: [number, number, number][];
}

/** A shape's long axis in its local frame and the shape's extent along and across it. */
export interface ShapeAxis {
  axis: 'x' | 'y' | 'z';
  /** Unit vector of `axis`. */
  dir: V3;
  /** Extent along the axis, m: axisT runs from min to max. */
  min: number;
  max: number;
  /** Largest half-extent across the axis, m (a cylinder's circumradius). */
  crossHalf: number;
}

export interface ShapePiece {
  shape: Shape;
  /** The piece's local origin in the parent's local frame (the parent's rotation is kept). */
  offset: V3;
}

// ---------------------------------------------------------------------------
// Volume and mass
// ---------------------------------------------------------------------------

/** m³, exact for every kind (prism: (N/2)·r²·sin(2π/N)·2·halfHeight; hull: the convex hull of its points). */
export function shapeVolume(s: Shape): number {
  switch (s.kind) {
    case 'ball':
      return ballVolume(s.r);
    case 'box':
      return 2 * s.hx * 2 * s.hy * 2 * s.hz;
    case 'capsule':
      return Math.PI * s.r * s.r * 2 * s.halfHeight + ballVolume(s.r);
    case 'cylinder':
      return prismArea(s.r, s.sides) * 2 * s.halfHeight;
    case 'hull': {
      const h = convexHull(flatToP3(s.points));
      return h ? hullMassProps(h).volume : 0;
    }
  }
}

/** kg: density × volume (SPEC:196). Entity.mass mirrors it; Rapier gets the density through colliderDesc. */
export function shapeMass(s: Shape, m: Material): number {
  return m.density * shapeVolume(s);
}

// ---------------------------------------------------------------------------
// Rapier
// ---------------------------------------------------------------------------

/**
 * The collider descriptor for a shape of a material: density (so the body's mass is density × volume) and friction
 * (combine rule Average, MAP rapier §6). A cylinder is the convex hull of its prism (logs and sticks rest, §2.2).
 * Collision groups, events and CCD are the entity store's (P06). Needs `physicsReady()`.
 */
export function colliderDesc(s: Shape, m: Material): RAPIER.ColliderDesc {
  let d: RAPIER.ColliderDesc | null;
  switch (s.kind) {
    case 'ball':
      d = RAPIER.ColliderDesc.ball(s.r);
      break;
    case 'box':
      d = RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
      break;
    case 'capsule':
      d = RAPIER.ColliderDesc.capsule(s.halfHeight, s.r);
      break;
    case 'cylinder':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(cylinderPoints(s)));
      break;
    case 'hull':
      d = RAPIER.ColliderDesc.convexHull(new Float32Array(s.points));
      break;
  }
  if (!d) throw new Error(`colliderDesc: Rapier could not build a convex hull for a ${s.kind}`);
  return d.setDensity(m.density).setFriction(m.friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average);
}

/** A cylinder's exact prism vertices, local xyz triples: the ring at −halfHeight, then the ring at +halfHeight. */
export function cylinderPoints(s: { halfHeight: number; r: number; sides: number }): number[] {
  const out: number[] = [];
  for (const y of [-s.halfHeight, s.halfHeight]) {
    for (let k = 0; k < s.sides; k++) {
      const a = ((k + 0.5) * TAU) / s.sides;
      out.push(s.r * Math.cos(a), y, s.r * Math.sin(a));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Axes and containment
// ---------------------------------------------------------------------------

/** The shape's long axis (see the conventions at the top of this file). */
export function principalAxis(s: Shape): ShapeAxis {
  switch (s.kind) {
    case 'ball':
      return axisOf(1, -s.r, s.r, s.r);
    case 'capsule':
      return axisOf(1, -s.halfHeight - s.r, s.halfHeight + s.r, s.r);
    case 'cylinder':
      return axisOf(1, -s.halfHeight, s.halfHeight, s.r);
    case 'box':
      return longestOf([-s.hx, -s.hy, -s.hz], [s.hx, s.hy, s.hz]);
    case 'hull': {
      const pts = flatToP3(s.points);
      if (pts.length === 0) return axisOf(1, 0, 0, 0);
      const { lo, hi } = bounds(pts);
      return longestOf(lo, hi);
    }
  }
}

/** Whether a local point is inside the shape, or within `tol` m of it (sharp points: which piece keeps one). */
export function shapeContains(s: Shape, p: V3, tol = 0): boolean {
  switch (s.kind) {
    case 'ball':
      return Math.hypot(p.x, p.y, p.z) <= s.r + tol;
    case 'box':
      return Math.abs(p.x) <= s.hx + tol && Math.abs(p.y) <= s.hy + tol && Math.abs(p.z) <= s.hz + tol;
    case 'capsule': {
      const y = Math.max(-s.halfHeight, Math.min(s.halfHeight, p.y));
      return Math.hypot(p.x, p.y - y, p.z) <= s.r + tol;
    }
    case 'cylinder': {
      if (Math.abs(p.y) > s.halfHeight + tol) return false;
      // Face k's outward normal is at angle k·2π/N; the inradius is r·cos(π/N).
      const inR = s.r * Math.cos(Math.PI / s.sides);
      for (let k = 0; k < s.sides; k++) {
        const a = (k * TAU) / s.sides;
        if (p.x * Math.cos(a) + p.z * Math.sin(a) > inR + tol) return false;
      }
      return true;
    }
    case 'hull': {
      const h = convexHull(flatToP3(s.points));
      if (!h) return false;
      const q: P3 = [p.x, p.y, p.z];
      return h.faces.every((f) => {
        const pl = planeOf(h.pts[f[0]], h.pts[f[1]], h.pts[f[2]]);
        return dot(pl.n, q) - pl.d <= tol;
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Triangulation (nav input)
// ---------------------------------------------------------------------------

/**
 * The shape's surface as triangles in world space (posed by `pose`), outward-wound: (v1 − v0) × (v2 − v0) points out
 * of the shape, so an upward face has a positive y normal (recast's walkable test).
 */
export function triangulate(s: Shape, pose: Pose3): { positions: Float32Array; indices: Uint32Array } {
  const { pts, faces } = localMesh(s);
  const positions = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    const w = transform(pose, p);
    positions[i * 3] = w[0];
    positions[i * 3 + 1] = w[1];
    positions[i * 3 + 2] = w[2];
  });
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => indices.set(f, i * 3));
  return { positions, indices };
}

function localMesh(s: Shape): Hull {
  if (s.kind === 'box') {
    const pts = boxPoints(s);
    // Corner index = (x+ ? 1 : 0) + (y+ ? 2 : 0) + (z+ ? 4 : 0).
    const quads: [number, number, number, number][] = [
      [1, 3, 7, 5], // +x
      [0, 4, 6, 2], // −x
      [2, 6, 7, 3], // +y
      [0, 1, 5, 4], // −y
      [4, 5, 7, 6], // +z
      [0, 2, 3, 1], // −z
    ];
    return { pts, faces: quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]] as [number, number, number][]) };
  }
  if (s.kind === 'cylinder') {
    const pts = flatToP3(cylinderPoints(s));
    const n = s.sides;
    const faces: [number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      // Bottom ring 0..n−1, top ring n..2n−1; side quad (k, k1, n+k1, n+k), outward.
      faces.push([k, n + k1, k1], [k, n + k, n + k1]);
    }
    for (let k = 1; k + 1 < n; k++) {
      faces.push([n, n + k + 1, n + k]); // top cap, normal +y
      faces.push([0, k, k + 1]); // bottom cap, normal −y
    }
    return { pts, faces };
  }
  return convexHull(hullPoints(s)) ?? { pts: [], faces: [] };
}

// ---------------------------------------------------------------------------
// Fracture, cross-cut, taper
// ---------------------------------------------------------------------------

/**
 * Impact breaks (§4.10): `n` pieces, every one convex, their volumes summing to the shape's. Elongated kinds
 * (cylinder, box, capsule) split along their long axis into n wedges about it (splinters); balls and hulls split by n
 * half-planes about a random axis through the centre of mass. The wedges' angles (and a hull's axis) come from `rng`
 * (the world stream): one draw for an elongated kind, three for a ball or hull. Pieces in wedge order.
 */
export function fracture(s: Shape, n: 2 | 3 | 4, rng: Rng): ShapePiece[] {
  const h = convexHull(hullPoints(s));
  if (!h) return [{ shape: s, offset: v3(0, 0, 0) }];
  let axis: P3;
  let centre: P3;
  if (s.kind === 'cylinder' || s.kind === 'box' || s.kind === 'capsule') {
    axis = toP3(principalAxis(s).dir);
    centre = [0, 0, 0];
  } else {
    const z = 2 * rng.next() - 1;
    const phi = TAU * rng.next();
    const rho = Math.sqrt(Math.max(0, 1 - z * z));
    axis = [rho * Math.cos(phi), rho * Math.sin(phi), z];
    centre = hullMassProps(h).centroid;
  }
  const theta0 = TAU * rng.next();
  const [b1, b2] = basisAbout(axis);
  // m(θ): the normal of the half-plane at angle θ about the axis, pointing toward increasing angle.
  const m = (t: number): P3 => add(scale(b1, -Math.sin(t)), scale(b2, Math.cos(t)));
  const pieces: ShapePiece[] = [];
  for (let k = 0; k < n; k++) {
    const ta = theta0 + (k * TAU) / n;
    const tb = theta0 + ((k + 1) * TAU) / n;
    const ma = m(ta);
    const mb = scale(m(tb), -1);
    let piece = clipHull(h, ma, dot(ma, centre));
    if (piece) piece = clipHull(piece, mb, dot(mb, centre));
    if (piece) pieces.push(centredPiece(piece));
  }
  return pieces;
}

/**
 * Cut across the long axis at `axisT` (§5.3 Cut, and the load break's snap at the load point, §4.10): [the part below
 * axisT, the part above], volumes summing to the shape's. A prism gives two shorter prisms, a box two boxes, anything
 * else two hulls. `axisT` is clamped inside the shape's extent; callers keep it away from the very ends.
 */
export function crossCut(s: Shape, axisT: number): [ShapePiece, ShapePiece] {
  const ax = principalAxis(s);
  const span = ax.max - ax.min;
  const t = Math.min(ax.max - span * GEOM_EPS, Math.max(ax.min + span * GEOM_EPS, axisT));
  const lo = (t - ax.min) / 2;
  const hi = (ax.max - t) / 2;
  const at = (c: number): V3 => v3(ax.axis === 'x' ? c : 0, ax.axis === 'y' ? c : 0, ax.axis === 'z' ? c : 0);
  if (s.kind === 'cylinder') {
    return [
      { shape: { kind: 'cylinder', halfHeight: lo, r: s.r, sides: s.sides }, offset: at(ax.min + lo) },
      { shape: { kind: 'cylinder', halfHeight: hi, r: s.r, sides: s.sides }, offset: at(t + hi) },
    ];
  }
  if (s.kind === 'box') {
    const sized = (half: number): Shape => ({
      kind: 'box',
      hx: ax.axis === 'x' ? half : s.hx,
      hy: ax.axis === 'y' ? half : s.hy,
      hz: ax.axis === 'z' ? half : s.hz,
    });
    return [
      { shape: sized(lo), offset: at(ax.min + lo) },
      { shape: sized(hi), offset: at(t + hi) },
    ];
  }
  const h = convexHull(hullPoints(s));
  const dir = toP3(ax.dir);
  return [cutPiece(h, scale(dir, -1), -t, at(ax.min + lo)), cutPiece(h, dir, t, at(t + hi))];
}

/**
 * The Shape verb's point (§5.4, RF-18): the end ring at `end` of the long axis pulled to a tip on the axis over
 * `taperM` (clamped to the shape's length). Returns a hull in the same local frame, so a SharpPoint at the old end's
 * centre is at the tip. On a 1.4 m × 5 cm 8-gon dry-wood stake, a 0.25 m taper removes ⅔ of that length's wood
 * (0.65 kg of 5.44 kg).
 */
export function taperEnd(s: Shape, end: 1 | -1, taperM: number): Shape {
  const ax = principalAxis(s);
  const len = ax.max - ax.min;
  const t = Math.min(len, Math.max(0, taperM));
  const h = convexHull(hullPoints(s));
  if (!h || t <= len * GEOM_EPS) return s;
  const dir = toP3(ax.dir);
  const tipAt = end > 0 ? ax.max : ax.min;
  const cutAt = tipAt - end * t;
  // Keep the side away from the tapered end: end·(dir·p) ≤ end·cutAt.
  const keepN = scale(dir, -end);
  const { kept, section } = clipPoints(h, keepN, -end * cutAt);
  // On the axis. A prism's (box's, capsule's, ball's) axis runs through its origin, so the tip is the centre of its end.
  // A hull's runs through its section's centre (a coordinate within floating-point noise of 0 is 0: a prism-derived hull
  // is symmetric about its origin), and the tip is where that line leaves the hull, so sharpening never adds wood.
  let tip: P3 = scale(dir, tipAt);
  if (s.kind === 'hull') {
    const c = sectionCentroid(section, dir).map((x) => (Math.abs(x) <= GEOM_EPS * len ? 0 : x)) as P3;
    const toward = scale(dir, end);
    tip = add(c, scale(toward, rayExit(h, c, toward)));
  }
  const out = convexHull([...kept, tip]);
  return out ? { kind: 'hull', points: out.pts.flat() } : s;
}

// ---------------------------------------------------------------------------
// Internals: shapes as point sets
// ---------------------------------------------------------------------------

function ballVolume(r: number): number {
  return (4 / 3) * Math.PI * r * r * r;
}

/** Area of a regular N-gon of circumradius r. */
function prismArea(r: number, sides: number): number {
  return (sides / 2) * r * r * Math.sin(TAU / sides);
}

function boxPoints(s: { hx: number; hy: number; hz: number }): P3[] {
  const out: P3[] = [];
  for (let i = 0; i < 8; i++) out.push([i & 1 ? s.hx : -s.hx, i & 2 ? s.hy : -s.hy, i & 4 ? s.hz : -s.hz]);
  return out;
}

/** The convex point set whose hull is the shape (round shapes: a stand-in with exactly the shape's volume). */
function hullPoints(s: Shape): P3[] {
  switch (s.kind) {
    case 'box':
      return boxPoints(s);
    case 'cylinder':
      return flatToP3(cylinderPoints(s));
    case 'hull':
      return flatToP3(s.points);
    case 'ball':
      return roundPoints(0, s.r, shapeVolume(s), true);
    case 'capsule':
      return roundPoints(s.halfHeight, s.r, shapeVolume(s), false);
  }
}

/**
 * Rings of ROUND_SEGMENTS points over two hemispherical caps of radius r, ±halfHeight apart, plus the poles; then
 * scaled so the hull's volume is `volume` exactly (a ball uniformly, a capsule across its axis only, keeping its length).
 */
function roundPoints(halfHeight: number, r: number, volume: number, uniform: boolean): P3[] {
  const quarter = ROUND_SEGMENTS / 4;
  const pts: P3[] = [];
  for (const side of [-1, 1]) {
    for (let j = 0; j < quarter; j++) {
      if (halfHeight === 0 && side < 0 && j === 0) continue; // a ball's equator once
      const lat = (j * Math.PI) / 2 / quarter;
      const ringR = r * Math.cos(lat);
      const y = side * (halfHeight + r * Math.sin(lat));
      for (let k = 0; k < ROUND_SEGMENTS; k++) {
        const a = ((k + 0.5) * TAU) / ROUND_SEGMENTS;
        pts.push([ringR * Math.cos(a), y, ringR * Math.sin(a)]);
      }
    }
    pts.push([0, side * (halfHeight + r), 0]);
  }
  const h = convexHull(pts);
  if (!h) return pts;
  const ratio = volume / hullMassProps(h).volume;
  const k = uniform ? Math.cbrt(ratio) : Math.sqrt(ratio);
  return pts.map(([x, y, z]) => [x * k, uniform ? y * k : y, z * k]);
}

function axisOf(i: 0 | 1 | 2, min: number, max: number, crossHalf: number): ShapeAxis {
  const names = ['x', 'y', 'z'] as const;
  return { axis: names[i], dir: v3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0), min, max, crossHalf };
}

/** The axis of the largest extent (ties: Y, then X, then Z). */
function longestOf(lo: readonly number[], hi: readonly number[]): ShapeAxis {
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  let best: 0 | 1 | 2 = 1;
  for (const i of [0, 2] as const) if (ext[i] > ext[best]) best = i;
  const others = ([0, 1, 2] as const).filter((i) => i !== best);
  return axisOf(best, lo[best], hi[best], Math.max(...others.map((i) => ext[i] / 2)));
}

function bounds(pts: readonly P3[]): { lo: P3; hi: P3 } {
  const lo: P3 = [Infinity, Infinity, Infinity];
  const hi: P3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]);
      hi[i] = Math.max(hi[i], p[i]);
    }
  }
  return { lo, hi };
}

// ---------------------------------------------------------------------------
// Internals: convex hulls
// ---------------------------------------------------------------------------

/**
 * The convex hull of a point set (incremental, in input order, so the result is deterministic): its corners only, in
 * input order. Points within GEOM_EPS × extent of the hull, and points on a hull face or edge, are dropped. null when
 * the points span no volume.
 */
function convexHull(input: readonly P3[]): Hull | null {
  const first = incrementalHull(input);
  if (!first) return null;
  // A point added before the corners around it can stay on as a vertex in the middle of a flat face or a straight
  // edge. A true corner has three independent face normals around it; keep only those and build again.
  const normals = new Map<number, P3[]>();
  for (const f of first) for (const v of [f.a, f.b, f.c]) (normals.get(v) ?? normals.set(v, []).get(v)!).push(f.n);
  const corners = [...normals.keys()].filter((v) => isCorner(normals.get(v)!)).sort((a, b) => a - b);
  const faces = corners.length === normals.size ? first : incrementalHull(corners.map((v) => input[v]));
  if (!faces) return null;
  const pts = corners.length === normals.size ? input : corners.map((v) => input[v]);
  // Keep only the vertices the faces use, in input order.
  const used = [...new Set(faces.flatMap((f) => [f.a, f.b, f.c]))].sort((a, b) => a - b);
  const remap = new Map(used.map((v, j) => [v, j]));
  return {
    pts: used.map((v) => [...pts[v]] as P3),
    faces: faces.map((f) => [remap.get(f.a)!, remap.get(f.b)!, remap.get(f.c)!]),
  };
}

/** Whether face normals meeting at a vertex span all three dimensions (the vertex is a corner of the hull). */
function isCorner(ns: readonly P3[]): boolean {
  const a = ns[0];
  const b = ns.find((n) => norm(cross(a, n)) > GEOM_EPS);
  if (!b) return false;
  const ab = cross(a, b);
  return ns.some((n) => Math.abs(dot(ab, n)) > GEOM_EPS);
}

/** The incremental hull's outward faces, indexing `input`; null when the points span no volume. */
function incrementalHull(input: readonly P3[]): Face[] | null {
  const n = input.length;
  if (n < 4) return null;
  const { lo, hi } = bounds(input);
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const size = Math.max(...ext);
  if (!(size > 0) || !Number.isFinite(size)) return null;
  const eps = GEOM_EPS * size;

  // Initial tetrahedron: the extremes along the widest axis, the point farthest from their line, then the point
  // farthest from that plane (first index wins ties).
  const ax = ext.indexOf(size);
  let i0 = 0;
  let i1 = 0;
  for (let i = 1; i < n; i++) {
    if (input[i][ax] < input[i0][ax]) i0 = i;
    if (input[i][ax] > input[i1][ax]) i1 = i;
  }
  const line = sub(input[i1], input[i0]);
  let i2 = -1;
  let best = eps * size;
  for (let i = 0; i < n; i++) {
    const d = norm(cross(line, sub(input[i], input[i0])));
    if (d > best) {
      best = d;
      i2 = i;
    }
  }
  if (i2 < 0) return null;
  const base = planeOf(input[i0], input[i1], input[i2]);
  let i3 = -1;
  best = eps;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(dot(base.n, input[i]) - base.d);
    if (d > best) {
      best = d;
      i3 = i;
    }
  }
  if (i3 < 0) return null;

  const inside = scale(add(add(input[i0], input[i1]), add(input[i2], input[i3])), 1 / 4);
  const make = (a: number, b: number, c: number): Face => {
    const pl = planeOf(input[a], input[b], input[c]);
    return { a, b, c, n: pl.n, d: pl.d };
  };
  const outward = (a: number, b: number, c: number): Face => {
    const f = make(a, b, c);
    return dot(f.n, inside) - f.d > 0 ? make(a, c, b) : f;
  };
  let faces: Face[] = [outward(i0, i1, i2), outward(i0, i1, i3), outward(i0, i2, i3), outward(i1, i2, i3)];

  const seed = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < n; i++) {
    if (seed.has(i)) continue;
    const p = input[i];
    const visible = faces.filter((f) => dot(f.n, p) - f.d > eps);
    if (visible.length === 0) continue;
    const key = (a: number, b: number) => a * n + b;
    const edges = new Set<number>();
    for (const f of visible) for (const [a, b] of faceEdges(f)) edges.add(key(a, b));
    const horizon: [number, number][] = [];
    for (const f of visible) for (const [a, b] of faceEdges(f)) if (!edges.has(key(b, a))) horizon.push([a, b]);
    const gone = new Set(visible);
    faces = faces.filter((f) => !gone.has(f));
    for (const [a, b] of horizon) faces.push(make(a, b, i));
  }

  return faces;
}

function faceEdges(f: Face): [number, number][] {
  return [
    [f.a, f.b],
    [f.b, f.c],
    [f.c, f.a],
  ];
}

/** Volume and centre of mass of a closed outward-wound hull (tetrahedra from the vertex mean). */
function hullMassProps(h: Hull): { volume: number; centroid: P3 } {
  const o = scale(h.pts.reduce((s, p) => add(s, p), [0, 0, 0] as P3), 1 / h.pts.length);
  let volume = 0;
  let c: P3 = [0, 0, 0];
  for (const [a, b, d] of h.faces) {
    const pa = sub(h.pts[a], o);
    const pb = sub(h.pts[b], o);
    const pc = sub(h.pts[d], o);
    const v = dot(pa, cross(pb, pc)) / 6;
    volume += v;
    c = add(c, scale(add(add(pa, pb), pc), v / 4));
  }
  return { volume, centroid: volume > 0 ? add(o, scale(c, 1 / volume)) : o };
}

/**
 * The part of a hull with n·p ≥ d: its vertices on that side, and the points where its edges cross the plane
 * (`section` also holds vertices lying on the plane).
 */
function clipPoints(h: Hull, n: P3, d: number): { kept: P3[]; section: P3[] } {
  const size = Math.max(...extent(h.pts));
  const eps = GEOM_EPS * size;
  const side = h.pts.map((p) => dot(n, p) - d);
  const kept: P3[] = [];
  const section: P3[] = [];
  h.pts.forEach((p, i) => {
    if (side[i] >= -eps) kept.push(p);
    if (Math.abs(side[i]) <= eps) section.push(p);
  });
  for (const f of h.faces) {
    for (const [a, b] of [
      [f[0], f[1]],
      [f[1], f[2]],
      [f[2], f[0]],
    ]) {
      if (a > b) continue; // each edge once (its other face holds it as b→a)
      const sa = side[a];
      const sb = side[b];
      if ((sa > eps && sb < -eps) || (sa < -eps && sb > eps)) {
        const q = add(h.pts[a], scale(sub(h.pts[b], h.pts[a]), sa / (sa - sb)));
        kept.push(q);
        section.push(q);
      }
    }
  }
  return { kept, section };
}

function clipHull(h: Hull, n: P3, d: number): Hull | null {
  return convexHull(clipPoints(h, n, d).kept);
}

/** A hull piece centred on its centre of mass, with that centre as its offset. */
function centredPiece(h: Hull): ShapePiece {
  const c = hullMassProps(h).centroid;
  return { shape: { kind: 'hull', points: h.pts.flatMap((p) => sub(p, c)) }, offset: v3(c[0], c[1], c[2]) };
}

/**
 * The part of a hull with n·p ≥ d as a centred piece. A cut that leaves a sliver too thin to span a volume (an axisT
 * within GEOM_EPS of an end) gives that sliver's flat points, offset to `at`, rather than nothing.
 */
function cutPiece(h: Hull | null, n: P3, d: number, at: V3): ShapePiece {
  const kept = h ? clipPoints(h, n, d).kept : [];
  const piece = convexHull(kept);
  if (piece) return centredPiece(piece);
  const o = toP3(at);
  return { shape: { kind: 'hull', points: kept.flatMap((p) => sub(p, o)) }, offset: at };
}

/** How far a ray from a point inside a hull runs along `dir` before it leaves the hull. */
function rayExit(h: Hull, from: P3, dir: P3): number {
  let t = Infinity;
  for (const [a, b, c] of h.faces) {
    const pl = planeOf(h.pts[a], h.pts[b], h.pts[c]);
    const along = dot(pl.n, dir);
    if (along > GEOM_EPS) t = Math.min(t, (pl.d - dot(pl.n, from)) / along);
  }
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/** The area centroid of a planar convex section (points in the plane ⟂ `axis`); the vertex mean if it has no area. */
function sectionCentroid(section: readonly P3[], axis: P3): P3 {
  const mean = scale(section.reduce((s, p) => add(s, p), [0, 0, 0] as P3), 1 / Math.max(1, section.length));
  if (section.length < 3) return mean;
  const [b1, b2] = basisAbout(axis);
  const q = section.map((p) => [dot(sub(p, mean), b1), dot(sub(p, mean), b2)] as [number, number]);
  const size = Math.max(...q.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
  const ring = hull2d(q);
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const w = x0 * y1 - x1 * y0;
    area += w;
    cx += (x0 + x1) * w;
    cy += (y0 + y1) * w;
  }
  if (!(Math.abs(area) > GEOM_EPS * size * size)) return mean;
  return add(mean, add(scale(b1, cx / (3 * area)), scale(b2, cy / (3 * area))));
}

/** Andrew's monotone chain: the convex ring of 2-D points, counter-clockwise. */
function hull2d(pts: readonly [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ---------------------------------------------------------------------------
// Internals: vectors
// ---------------------------------------------------------------------------

function v3(x: number, y: number, z: number): V3 {
  return { x, y, z };
}
function toP3(v: V3): P3 {
  return [v.x, v.y, v.z];
}
function flatToP3(flat: readonly number[]): P3[] {
  const out: P3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}
function add(a: P3, b: P3): P3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: P3, b: P3): P3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: P3, k: number): P3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function dot(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: P3, b: P3): P3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: P3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function extent(pts: readonly P3[]): number[] {
  const { lo, hi } = bounds(pts);
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}
/** The plane through a, b, c: unit normal along (b − a) × (c − a), and n·a. */
function planeOf(a: P3, b: P3, c: P3): { n: P3; d: number } {
  const c0 = cross(sub(b, a), sub(c, a));
  const l = norm(c0);
  const n: P3 = l > 0 ? scale(c0, 1 / l) : [0, 0, 0];
  return { n, d: dot(n, a) };
}
/** Two unit vectors completing a right-handed frame (b1, b2, axis). */
function basisAbout(axis: P3): [P3, P3] {
  const a = scale(axis, 1 / norm(axis));
  const helper: P3 = Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2]) ? [1, 0, 0] : Math.abs(a[1]) <= Math.abs(a[2]) ? [0, 1, 0] : [0, 0, 1];
  const b1 = cross(a, helper);
  const n1 = scale(b1, 1 / norm(b1));
  return [n1, cross(a, n1)];
}
/** Pose3 applied to a local point: rotate by q, then translate by p. */
function transform(pose: Pose3, v: P3): P3 {
  const { x, y, z, w } = pose.q;
  const q: P3 = [x, y, z];
  const t = scale(cross(q, v), 2);
  const r = add(add(v, scale(t, w)), cross(q, t));
  return [r[0] + pose.p.x, r[1] + pose.p.y, r[2] + pose.p.z];
}
