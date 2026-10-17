// Entities on screen (docs/M1-DESIGN.md §10.4): one InstancedMesh per (shape prototype, material) — the unit hex prism
// (logs), the unit 8-gon prism (sticks, stakes, branches), each stone hull, flint, grass bundles, dirt piles, coils,
// hides and bones — with a non-uniform scale per instance; matrices interpolated prevPose → pose by alpha; held and
// stowed things drawn where the hand, belt or back that holds them is drawn (WorldViews says where). An entity whose
// shape a rule has changed visibly (a cross-cut notch, a sag, a bend under load) gets a mesh of its own.
//
// Readability (rule 3, SPEC:351-362; never colour alone, SPEC:843):
// - colour and finish by material (RENDER_TUNING.materials): green wood darker, dry wood pale, rotten wood dark and
//   lumpy ("spongy": its shape is irregular too), flint dark and glossy; wet things darker (moisture, M2);
// - a pale cone at every sharp point, sized by its sharpness, its tip exactly at the point (shaped ends are pointed hulls
//   already, §5.4). A snag's broken-branch point has no geometry of its own, so its cone is the stub: never longer than
//   DAMAGE_TUNING.tipRadiusM, so nothing is drawn sticking out further than the sharp-point test reaches (TODO "snag stub
//   geometry (rule 3)");
// - a cross-cut notch at crossCut.axisT, (1 − remaining) of the thickness deep on the fromDir side (RR-15);
// - integrity below integrityCrack darkens and cracks; below integritySag it sags;
// - a load averaging more than strainShowFrac of the entity's capacity bends it (TODO "prop strain readability": a
//   thin prop shows it won't hold; the creak is the audio's).
//
// Stones, flint and piles are drawn from their exact hull points (the sim's own triangulation), so what you see is the
// collider. Rope entities that are tied have no body and are drawn by the rope views, not here.
//
// Also here, shared with the forest and grass views: the instancing helper and the shape geometry builders.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  type Scene,
  TorusGeometry,
  Vector3,
} from 'three';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  DAMAGE_TUNING,
  type Entity,
  type MaterialId,
  principalAxis,
  type Pose3,
  type Quat,
  type Shape,
  triangulate,
  type V3,
} from '@wild/sim';
import { hash2, materialLook, RENDER_TUNING } from './terrainView';

// ---------------------------------------------------------------------------
// Instancing
// ---------------------------------------------------------------------------

/**
 * A growable InstancedMesh refilled every frame: begin(), push() each instance, end(). Frustum culling is off (the
 * instances move every frame; three's instanced bounding sphere is computed once).
 */
export class Instancer {
  mesh: InstancedMesh;
  private n = 0;
  /** Frames since an instance was last drawn. */
  idle = 0;

  constructor(
    private readonly parent: Group,
    readonly geometry: BufferGeometry,
    readonly material: MeshStandardMaterial,
    capacity = 16,
    readonly name = '',
  ) {
    this.mesh = this.make(Math.max(1, capacity));
    parent.add(this.mesh);
  }

  /** Instances drawn this frame. */
  get count(): number {
    return this.n;
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  begin(): void {
    this.n = 0;
  }

  push(m: Matrix4, c: Color): void {
    if (this.n >= this.capacity) this.grow(this.capacity * 2);
    this.mesh.setMatrixAt(this.n, m);
    this.mesh.setColorAt(this.n, c);
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.idle = this.n > 0 ? 0 : this.idle + 1;
  }

  /** The world matrix of instance `i` (as last pushed). */
  matrixAt(i: number, out = new Matrix4()): Matrix4 {
    this.mesh.getMatrixAt(i, out);
    return out;
  }

  /** The colour of instance `i` (as last pushed). */
  colorAt(i: number, out = new Color()): Color {
    this.mesh.getColorAt(i, out);
    return out;
  }

  dispose(disposeGeometry = true): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    if (disposeGeometry) this.geometry.dispose();
    this.material.dispose();
  }

  private make(capacity: number): InstancedMesh {
    const m = new InstancedMesh(this.geometry, this.material, capacity);
    m.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    m.count = 0;
    m.name = this.name;
    return m;
  }

  private grow(capacity: number): void {
    const old = this.mesh;
    const next = this.make(capacity);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    if (old.instanceColor && next.instanceColor) (next.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
    next.castShadow = old.castShadow;
    next.receiveShadow = old.receiveShadow;
    this.parent.remove(old);
    old.dispose();
    this.parent.add(next);
    this.mesh = next;
  }
}

/** A flat-shaded standard material (white: instances and vertex colours carry the colour). */
export function flatMaterial(o: { roughness?: number; metalness?: number; vertexColors?: boolean; color?: string } = {}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: o.color ?? '#ffffff',
    roughness: o.roughness ?? 0.85,
    metalness: o.metalness ?? 0,
    flatShading: true,
    vertexColors: o.vertexColors ?? false,
  });
}

// ---------------------------------------------------------------------------
// Poses and matrices
// ---------------------------------------------------------------------------

const _p = new Vector3();
const _p2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();
const _m2 = new Matrix4();

/** The pose as a matrix (no scale). */
export function poseMatrix(pose: Pose3, out = new Matrix4()): Matrix4 {
  return out.compose(_p.set(pose.p.x, pose.p.y, pose.p.z), _q.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w), _s.set(1, 1, 1));
}

/** `a` → `b` at `t` (position lerp, rotation slerp) as a matrix (no scale): an entity drawn between its last two ticks. */
export function lerpPoseMatrix(a: Pose3, b: Pose3, t: number, out = new Matrix4()): Matrix4 {
  _p.set(a.p.x, a.p.y, a.p.z).lerp(_p2.set(b.p.x, b.p.y, b.p.z), t);
  _q.set(a.q.x, a.q.y, a.q.z, a.q.w).slerp(_q2.set(b.q.x, b.q.y, b.q.z, b.q.w), t);
  return out.compose(_p, _q, _s.set(1, 1, 1));
}

/** v rotated by q (plain numbers). */
export function rotateV(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const IDENTITY_POSE: Pose3 = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } };

/** The shape's surface exactly as the sim triangulates it (outward-wound, local frame). */
export function shapeGeometry(s: Shape): BufferGeometry {
  if (s.kind === 'ball' || s.kind === 'capsule') return roundGeometry(s);
  const { positions, indices } = triangulate(s, IDENTITY_POSE);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Balls and capsules (M2+ and tests): faceted, like everything else. */
function roundGeometry(s: Extract<Shape, { kind: 'ball' | 'capsule' }>): BufferGeometry {
  // (Built from a convex hull of points on the surface, through the sim's triangulation, so it is outward-wound.)
  const pts: number[] = [];
  const rings = 6;
  const seg = 10;
  const h = s.kind === 'capsule' ? s.halfHeight : 0;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI - Math.PI / 2;
    const y = Math.sin(phi) * s.r + (phi < 0 ? -h : phi > 0 ? h : 0);
    const rr = Math.cos(phi) * s.r;
    for (let j = 0; j < (rr > 1e-9 ? seg : 1); j++) {
      const a = (j / seg) * Math.PI * 2;
      pts.push(rr * Math.cos(a), y, rr * Math.sin(a));
      if (phi === 0 && h > 0) pts.push(rr * Math.cos(a), -h, rr * Math.sin(a), rr * Math.cos(a), h, rr * Math.sin(a));
    }
  }
  return shapeGeometry({ kind: 'hull', points: pts });
}

/** The unit N-gon prism (circumradius 1, half-height 1, axis +y), as the sim builds a cylinder's collider. */
export function unitPrism(sides: number): BufferGeometry {
  return shapeGeometry({ kind: 'cylinder', r: 1, halfHeight: 1, sides });
}

/** A notch cut into a prism (local frame, axis +y). */
export interface Notch {
  /** Unit horizontal direction (local x, z) from the axis toward the side it is cut from. */
  fx: number;
  fz: number;
  /** m deep at its deepest line, measured in from the cross-section's extent along (fx, fz). */
  depth: number;
  /** Local y of its deepest line. */
  y: number;
  /** m along the axis from the deepest line to where each face meets the surface. */
  halfOpen: number;
}

export interface PrismLook {
  /** The outside (bark, skin). */
  side: Color;
  /** Fresh-cut wood: notch faces, a cut end. */
  cut: Color;
  /** The ends are cut wood (a stump's top, a felled trunk's foot). */
  topCut?: boolean;
  bottomCut?: boolean;
}

/**
 * An N-gon prism (circumradius r, half-height hh, axis +y; its ring as the sim's cylinderPoints) with `notches` cut
 * into it, each a V whose faces run from the surface at y ± halfOpen down to its deepest line `depth` in: every vertex
 * on the cut side of a notch's plane at its height is moved straight in (along −(fx, fz)) onto it, and coloured as cut
 * wood. Each polygon side is split into `sub` pieces and each notch face into `segments` rows so the V reads. Extra
 * `rings` (local y values) give a bend something to bend.
 */
export function notchedPrism(
  r: number,
  hh: number,
  sides: number,
  notches: readonly Notch[],
  look: PrismLook,
  o: { sub?: number; segments?: number; rings?: readonly number[]; lump?: { frac: number; seed: number } } = {},
): BufferGeometry {
  const sub = Math.max(1, Math.round(o.sub ?? (notches.length > 0 ? 4 : 1)));
  const seg = Math.max(1, Math.round(o.segments ?? RENDER_TUNING.forest.notchSegments));
  // The ring: the sim's cylinderPoints (angles (k + ½)·2π/N), each side split into `sub`.
  const base: [number, number][] = [];
  for (let k = 0; k < sides; k++) {
    const a0 = ((k + 0.5) * Math.PI * 2) / sides;
    const a1 = ((k + 1.5) * Math.PI * 2) / sides;
    for (let j = 0; j < sub; j++) {
      const t = j / sub;
      base.push([r * ((1 - t) * Math.cos(a0) + t * Math.cos(a1)), r * ((1 - t) * Math.sin(a0) + t * Math.sin(a1))]);
    }
  }
  const m = base.length;
  // Rows: the ends, each notch's face rows, and any extra rings, inside [−hh, hh].
  const ys = new Set<number>([-hh, hh]);
  const add = (y: number) => {
    if (y >= -hh - 1e-9 && y <= hh + 1e-9) ys.add(Math.min(hh, Math.max(-hh, y)));
  };
  for (const n of notches) for (let i = -seg; i <= seg; i++) add(n.y + (n.halfOpen * i) / seg);
  for (const y of o.rings ?? []) add(y);
  const rows = [...ys].sort((a, b) => a - b).filter((y, i, a) => i === 0 || y - a[i - 1] > 1e-7);
  const extents = notches.map((n) => Math.max(...base.map(([x, z]) => x * n.fx + z * n.fz)));

  const pos: number[] = [];
  const col: number[] = [];
  const cutAt: boolean[][] = [];
  const ring: [number, number][][] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const y = rows[ri];
    const pts: [number, number][] = [];
    const cut: boolean[] = [];
    for (let j = 0; j < m; j++) {
      let [x, z] = base[j];
      if (o.lump && o.lump.frac > 0 && ri > 0 && ri < rows.length - 1) {
        const k = 1 + o.lump.frac * (hash2(o.lump.seed + ri * 131, j) * 2 - 1);
        x *= k;
        z *= k;
      }
      let c = false;
      notches.forEach((n, ni) => {
        const dd = n.depth * Math.max(0, 1 - Math.abs(y - n.y) / Math.max(1e-9, n.halfOpen));
        if (dd <= 0) return;
        const s0 = extents[ni] - dd;
        const s = x * n.fx + z * n.fz;
        if (s > s0 + 1e-9) {
          x -= (s - s0) * n.fx;
          z -= (s - s0) * n.fz;
          c = true;
        }
      });
      pts.push([x, z]);
      cut.push(c);
    }
    ring.push(pts);
    cutAt.push(cut);
  }
  const index: number[] = [];
  const vert = (x: number, y: number, z: number, c: Color): number => {
    pos.push(x, y, z);
    col.push(c.r, c.g, c.b);
    return pos.length / 3 - 1;
  };
  // Sides: a vertex per (row, j), coloured cut or not.
  const sideIdx: number[][] = rows.map((y, ri) => ring[ri].map(([x, z], j) => vert(x, y, z, cutAt[ri][j] ? look.cut : look.side)));
  for (let ri = 0; ri + 1 < rows.length; ri++) {
    for (let j = 0; j < m; j++) {
      const j1 = (j + 1) % m;
      const A = sideIdx[ri][j];
      const B = sideIdx[ri][j1];
      const C = sideIdx[ri + 1][j];
      const D = sideIdx[ri + 1][j1];
      index.push(A, C, B, B, C, D);
    }
  }
  // Caps: their own vertices, fanned from the centroid. A cap the notch reached is cut wood.
  const cap = (ri: number, up: boolean, cutEnd: boolean | undefined) => {
    const y = rows[ri];
    const reached = cutAt[ri].some(Boolean);
    const c = cutEnd || reached ? look.cut : look.side;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of ring[ri]) {
      cx += x;
      cz += z;
    }
    const centre = vert(cx / m, y, cz / m, c);
    const ids = ring[ri].map(([x, z]) => vert(x, y, z, c));
    for (let j = 0; j < m; j++) {
      const a = ids[j];
      const b = ids[(j + 1) % m];
      if (up) index.push(centre, b, a);
      else index.push(centre, a, b);
    }
  };
  cap(0, false, look.bottomCut);
  cap(rows.length - 1, true, look.topCut);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.userData.rows = rows;
  return g;
}

/**
 * How deep a notch of `g` (a notchedPrism) is at local y: how far in from the uncut cross-section's extent along
 * (fx, fz) the drawn cross-section at that height reaches, measured from the vertices (what the eye reads; tests).
 */
export function notchDepthAt(g: BufferGeometry, y: number, fx: number, fz: number, r: number, sides: number): number {
  const pos = g.getAttribute('position');
  let e = -Infinity;
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) * Math.PI * 2) / sides;
    e = Math.max(e, r * (Math.cos(a) * fx + Math.sin(a) * fz));
  }
  let hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getY(i) - y) > 1e-6) continue;
    hi = Math.max(hi, pos.getX(i) * fx + pos.getZ(i) * fz);
  }
  return Number.isFinite(hi) ? e - hi : 0;
}

/** A rope coil: a flat ring (axis +y) filling the unit disc, half-height 1 (scaled to the coil's prism). */
function coilGeometry(): BufferGeometry {
  const g = new TorusGeometry(0.64, 0.34, 5, 12);
  g.rotateX(Math.PI / 2);
  g.scale(1, 1 / 0.34, 1);
  return g;
}

/** A grass bundle: straws lying along x filling the unit box. */
function bundleGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const z = -0.8 + (1.6 * i) / (n - 1);
    const y = -0.45 + 0.9 * hash2(i, 7);
    const b = new BoxGeometry(2 * (0.85 + 0.15 * hash2(i, 3)), 0.55, 0.42);
    b.rotateY((hash2(i, 11) - 0.5) * 0.3);
    b.translate((hash2(i, 5) - 0.5) * 0.15, y * 0.8, z);
    parts.push(b.toNonIndexed());
    b.dispose();
  }
  const g = mergeGeometries(parts) ?? new BoxGeometry(2, 2, 2);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

/** A lumpy copy of a geometry ("spongy" rotten wood): every vertex pushed in or out from the axis by up to `frac`. */
function lumpy(g: BufferGeometry, frac: number, seed: number): BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const k = 1 + frac * (hash2(seed + Math.round(pos.getY(i) * 97), i) * 2 - 1);
    pos.setXYZ(i, x * k, pos.getY(i), z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Prototypes: which shared geometry an entity is drawn with, and its instance scale
// ---------------------------------------------------------------------------

export interface Proto {
  /** Shared-geometry key. */
  key: string;
  /** The instance scale that maps the unit geometry onto the entity's shape. */
  sx: number;
  sy: number;
  sz: number;
  make(): BufferGeometry;
}

/** The hull scaled so its largest coordinate is 1, and that scale (stones of one prototype share a geometry). */
function normalHull(points: readonly number[]): { pts: number[]; k: number } {
  let k = 0;
  for (const v of points) k = Math.max(k, Math.abs(v));
  if (!(k > 0)) k = 1;
  return { pts: points.map((v) => v / k), k };
}

const rotten = (e: Entity) => e.material === 'rottenWood';

/** protoOf's answers by shape object (a shape is replaced, never edited, when it changes), then look and material. */
const PROTOS = new WeakMap<Shape, Map<string, Proto>>();

/** The shared geometry an entity is drawn with and the scale that fits it to the entity's shape. */
export function protoOf(e: Entity): Proto {
  const k = `${e.look}|${rotten(e) ? 'rot' : ''}`;
  let byLook = PROTOS.get(e.shape);
  if (!byLook) {
    byLook = new Map();
    PROTOS.set(e.shape, byLook);
  }
  let p = byLook.get(k);
  if (!p) {
    p = makeProto(e);
    byLook.set(k, p);
  }
  return p;
}

function makeProto(e: Entity): Proto {
  const s = e.shape;
  const rot = rotten(e) ? ':rot' : '';
  switch (s.kind) {
    case 'cylinder':
      if (e.look === 'coil') return { key: 'coil', sx: s.r, sy: s.halfHeight, sz: s.r, make: coilGeometry };
      return {
        key: `prism:${s.sides}${rot}`,
        sx: s.r,
        sy: s.halfHeight,
        sz: s.r,
        make: () =>
          rot
            ? notchedPrism(1, 1, s.sides, [], { side: WHITE, cut: WHITE }, { rings: [-0.5, 0, 0.5], lump: { frac: RENDER_TUNING.entities.rotLumpFrac, seed: s.sides } })
            : unitPrism(s.sides),
      };
    case 'box':
      if (e.look === 'grass') return { key: 'bundle', sx: s.hx, sy: s.hy, sz: s.hz, make: bundleGeometry };
      return { key: `box${rot}`, sx: s.hx, sy: s.hy, sz: s.hz, make: () => shapeGeometry({ kind: 'box', hx: 1, hy: 1, hz: 1 }) };
    case 'ball':
      return { key: 'ball', sx: s.r, sy: s.r, sz: s.r, make: () => shapeGeometry({ kind: 'ball', r: 1 }) };
    case 'capsule': {
      const a = +(s.halfHeight / s.r).toFixed(3);
      return { key: `capsule:${a}`, sx: s.r, sy: s.r, sz: s.r, make: () => shapeGeometry({ kind: 'capsule', r: 1, halfHeight: a }) };
    }
    case 'hull': {
      const { pts, k } = normalHull(s.points);
      const key = `hull:${pts.map((v) => v.toFixed(4)).join(',')}${rot}`;
      return {
        key,
        sx: k,
        sy: k,
        sz: k,
        make: () => {
          const g = shapeGeometry({ kind: 'hull', points: pts });
          return rot ? lumpy(g.toNonIndexed(), RENDER_TUNING.entities.rotLumpFrac * 0.5, 17) : g;
        },
      };
    }
  }
}

const WHITE = new Color(1, 1, 1);

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const _blood = new Color();

/**
 * An entity's colour: its material's look, a little variation by id, darker when wet (moisture, M2) and when its
 * integrity is below integrityCrack (rule 3), then `blood` (0..1) of blood over it (a bloodied tool, rule 12).
 */
export function entityColour(e: Entity, blood = 0, out = new Color()): Color {
  const E = RENDER_TUNING.entities;
  out.set(materialLook(e.material).color);
  out.multiplyScalar(1 + E.variation * (hash2(e.id, 977) * 2 - 1));
  out.multiplyScalar(1 - E.wetDarken * Math.min(1, Math.max(0, e.moisture)));
  if (e.integrity < RENDER_TUNING.integrityCrack) out.multiplyScalar(E.crackDarken);
  if (blood > 0) out.lerp(_blood.set(E.bloodColor), Math.min(0.92, blood * 1.1));
  return out;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** What EntityViews needs to know each frame beyond the entities. */
export interface EntityFrame {
  /** prevPose → pose interpolation (0..1). */
  alpha: number;
  /** Entities another view draws (the forest: trees, saplings, stumps). */
  skip(e: Entity): boolean;
  /** Where a held or stowed entity is drawn (world, no scale), or null to draw it at its record pose. */
  placed(e: Entity): Matrix4 | null;
  /** Blood on a held tool (0..1; 0 when gore is off). */
  blood(e: Entity): number;
  /** The entity's load capacity (N), or null when the sim can't say. */
  capacity(e: Entity): number | null;
}

/** An entity with a mesh of its own (its shape is drawn changed: a notch, a sag, a bend). */
interface OwnView {
  mesh: Mesh;
  key: string;
}

/** An entity drawn as an instance: which instancer and which slot (this frame). */
interface Slot {
  inst: Instancer;
  index: number;
}

const _col = new Color();
const _sharp = new Color();
const _crack = new Color();
const _up = new Vector3(0, 1, 0);
const _dir = new Vector3();
const _local = new Vector3();
const _q3 = new Quaternion();

export class EntityViews {
  readonly group = new Group();
  /** (proto key | material) → its instancer. */
  private readonly instancers = new Map<string, Instancer>();
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly own = new Map<number, OwnView>();
  /** Every drawn entity's world matrix (no scale) this frame. */
  private readonly drawn = new Map<number, Matrix4>();
  private readonly slots = new Map<number, Slot>();
  readonly sharp: Instancer;
  readonly cracks: Instancer;

  constructor(scene: Scene) {
    this.group.name = 'entities';
    scene.add(this.group);
    const cone = new ConeGeometry(1, 1, 6);
    // Tip at the origin, the cone along −y (it points along +y).
    cone.translate(0, -0.5, 0);
    this.sharp = new Instancer(this.group, cone, flatMaterial({ roughness: 0.7 }), 32, 'sharp points');
    this.sharp.mesh.castShadow = false;
    this.cracks = new Instancer(this.group, new BoxGeometry(1, 1, 1), flatMaterial({ roughness: 1 }), 16, 'cracks');
    this.cracks.mesh.castShadow = false;
  }

  /** The entity's drawn world matrix (no scale) this frame, or null when it isn't drawn here. */
  matrixOf(id: number): Matrix4 | null {
    return this.drawn.get(id) ?? null;
  }

  /** The entity's own mesh, when its shape is drawn changed (tests, the dev panel). */
  ownMesh(id: number): Mesh | null {
    return this.own.get(id)?.mesh ?? null;
  }

  /** The instancer and slot an entity was drawn in this frame (tests). */
  slotOf(id: number): Slot | null {
    return this.slots.get(id) ?? null;
  }

  /** Every instancer (tests, draw-call counts). */
  instancerList(): Instancer[] {
    return [...this.instancers.values()];
  }

  sync(entities: readonly Entity[], f: EntityFrame): void {
    for (const i of this.instancers.values()) i.begin();
    this.sharp.begin();
    this.cracks.begin();
    this.slots.clear();
    const seen = new Set<number>();
    for (const e of entities) {
      if (e.state === 'tied' || f.skip(e)) continue;
      seen.add(e.id);
      let M = this.drawn.get(e.id);
      if (!M) {
        M = new Matrix4();
        this.drawn.set(e.id, M);
      }
      const placed = f.placed(e);
      if (placed) M.copy(placed);
      else lerpPoseMatrix(e.prevPose, e.pose, f.alpha, M);
      // (In twentieths: blood dries a little every frame, and an entity with a mesh of its own is rebuilt on a colour
      // change.)
      const blood = Math.round(f.blood(e) * 20) / 20;
      entityColour(e, blood, _col);
      const bend = this.bendOf(e, f.capacity(e));
      if (bend || e.crossCut) this.drawOwn(e, M, bend);
      else this.drawInstance(e, M);
      this.drawSharp(e, M);
      this.drawCracks(e, M);
    }
    for (const i of this.instancers.values()) i.end();
    this.sharp.end();
    this.cracks.end();
    for (const id of [...this.own.keys()]) if (!seen.has(id)) this.dropOwn(id);
    for (const id of this.drawn.keys()) if (!seen.has(id)) this.drawn.delete(id);
    // An instancer nothing has used for a minute goes (a fractured piece's one-off hull), and its geometry with the
    // last instancer that shares it (one per material).
    for (const [k, i] of [...this.instancers]) {
      if (i.idle < 3600) continue;
      i.dispose(false);
      this.instancers.delete(k);
      const proto = k.slice(0, k.lastIndexOf('|'));
      if ([...this.instancers.keys()].some((o) => o.slice(0, o.lastIndexOf('|')) === proto)) continue;
      this.geometries.get(proto)?.dispose();
      this.geometries.delete(proto);
    }
  }

  dispose(): void {
    for (const i of this.instancers.values()) i.dispose(false);
    this.instancers.clear();
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    for (const v of this.own.values()) {
      v.mesh.geometry.dispose();
      (v.mesh.material as MeshStandardMaterial).dispose();
    }
    this.own.clear();
    this.sharp.dispose();
    this.cracks.dispose();
    this.group.removeFromParent();
  }

  // -------------------------------------------------------------------------

  private instancer(key: string, material: MaterialId, make: () => BufferGeometry): Instancer {
    const k = `${key}|${material}`;
    let i = this.instancers.get(k);
    if (!i) {
      let g = this.geometries.get(key);
      if (!g) {
        g = make();
        this.geometries.set(key, g);
      }
      i = new Instancer(this.group, g, flatMaterial({ roughness: materialLook(material).roughness }), 8, k);
      this.instancers.set(k, i);
    }
    // The finish follows the live table.
    i.material.roughness = materialLook(material).roughness;
    return i;
  }

  private drawInstance(e: Entity, M: Matrix4): void {
    const p = protoOf(e);
    const inst = this.instancer(p.key, e.material, p.make);
    _m.copy(M).multiply(_m2.makeScale(p.sx, p.sy, p.sz));
    this.slots.set(e.id, { inst, index: inst.count });
    inst.push(_m, _col);
    this.dropOwn(e.id);
  }

  private dropOwn(id: number): void {
    const v = this.own.get(id);
    if (!v) return;
    v.mesh.removeFromParent();
    v.mesh.geometry.dispose();
    (v.mesh.material as MeshStandardMaterial).dispose();
    this.own.delete(id);
  }

  /**
   * How far the entity is drawn bent (m at its middle, along `dir` in its local frame), or null: a sag below
   * integritySag (SPEC:362), or a bend while its load averages more than strainShowFrac of its capacity (§10.4).
   */
  private bendOf(e: Entity, capacity: number | null): { m: number; dir: V3; key: string } | null {
    const T = RENDER_TUNING;
    if (e.integrity >= T.integritySag && capacity === null) return null;
    const ax = principalAxis(e.shape);
    const len = ax.max - ax.min;
    let amount = 0;
    if (e.integrity < T.integritySag) amount = Math.min(T.entities.sagMaxM, T.entities.sagFrac * len);
    if (capacity !== null && capacity > 0 && e.loadHist.length > 0) {
      let sum = 0;
      for (const v of e.loadHist) sum += v;
      const ratio = sum / e.loadHist.length / capacity;
      if (ratio > T.strainShowFrac) {
        const k = Math.min(1, (ratio - T.strainShowFrac) / Math.max(1e-6, 1 - T.strainShowFrac));
        amount = Math.max(amount, k * T.entities.strainBendFrac * len);
      }
    }
    if (amount <= 1e-4) return null;
    // Toward world down as the entity lies now, across its axis; a standing prop (axis near vertical) buckles sideways.
    const axis = new Vector3(ax.dir.x, ax.dir.y, ax.dir.z);
    _q3.set(e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w).invert();
    const down = new Vector3(0, -1, 0).applyQuaternion(_q3);
    down.addScaledVector(axis, -down.dot(axis));
    // (An axis is a coordinate axis of the shape: any other coordinate axis is across it.)
    if (down.lengthSq() < 0.1) {
      if (axis.x !== 0) down.set(0, 0, 1);
      else down.set(1, 0, 0);
    }
    down.normalize();
    const q = (v: number) => Math.round(v * 4) / 4;
    return { m: amount, dir: { x: down.x, y: down.y, z: down.z }, key: `${amount.toFixed(3)}:${q(down.x)},${q(down.y)},${q(down.z)}` };
  }

  private drawOwn(e: Entity, M: Matrix4, bend: { m: number; dir: V3; key: string } | null): void {
    const cc = e.crossCut;
    const key = `${shapeKey(e.shape)}|${cc ? `${cc.axisT.toFixed(3)}:${cc.remaining.toFixed(3)}:${cc.fromDir.x.toFixed(2)},${cc.fromDir.y.toFixed(2)},${cc.fromDir.z.toFixed(2)}` : '-'}|${bend?.key ?? '-'}|${_col.getHexString()}`;
    let v = this.own.get(e.id);
    if (!v || v.key !== key) {
      this.dropOwn(e.id);
      const mesh = new Mesh(ownGeometry(e, bend, _col), flatMaterial({ vertexColors: true, roughness: materialLook(e.material).roughness }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `entity ${e.id}`;
      this.group.add(mesh);
      v = { mesh, key };
      this.own.set(e.id, v);
    }
    v.mesh.matrix.copy(M);
    v.mesh.matrixWorldNeedsUpdate = true;
  }

  private drawSharp(e: Entity, M: Matrix4): void {
    if (e.sharpPoints.length === 0) return;
    const E = RENDER_TUNING.entities;
    _sharp.set(E.sharpColor);
    for (const sp of e.sharpPoints) {
      const c = sharpCone(e.shape, sp);
      if (!c) continue;
      _q.setFromUnitVectors(_up, _dir.set(sp.dir.x, sp.dir.y, sp.dir.z).normalize());
      _m.compose(_local.set(c.tip.x, c.tip.y, c.tip.z), _q, _s.set(c.radius, c.length, c.radius));
      _m2.copy(M).multiply(_m);
      this.sharp.push(_m2, _sharp);
    }
  }

  private drawCracks(e: Entity, M: Matrix4): void {
    const T = RENDER_TUNING;
    if (e.integrity >= T.integrityCrack) return;
    const ax = principalAxis(e.shape);
    const len = ax.max - ax.min;
    const n = e.integrity < T.integritySag ? 3 : 1;
    _crack.set(T.entities.crackColor);
    // Along the long axis, on the surface (cross radius ax.crossHalf), at evenly turned sides.
    const axis = new Vector3(ax.dir.x, ax.dir.y, ax.dir.z).normalize();
    _q.setFromUnitVectors(_up, axis);
    for (let i = 0; i < n; i++) {
      const turn = (i / n) * Math.PI * 2 + hash2(e.id, 31) * Math.PI;
      const side = new Vector3(Math.cos(turn), 0, Math.sin(turn)).applyQuaternion(_q);
      const along = (hash2(e.id, 41 + i) - 0.5) * 0.3 * len;
      _local.copy(axis).multiplyScalar((ax.min + ax.max) / 2 + along).addScaledVector(side, ax.crossHalf * 0.98);
      _q2.copy(_q).multiply(new Quaternion().setFromAxisAngle(_up, turn));
      _m.compose(_local, _q2, _s.set(T.entities.crackWidthM, len * (0.45 - 0.08 * i), T.entities.crackWidthM * 0.6));
      _m2.copy(M).multiply(_m);
      this.cracks.push(_m2, _crack);
    }
  }
}

/**
 * The pale cone drawn at a sharp point (entity frame): its tip, length and base radius, sized by sharpness. Where the
 * shape has the point (a hull: a shaped end, a knapped edge) the tip is exactly the sharp point and the cone lies
 * inside the shape. A point on a prism or a box (a snag's broken-branch stub, which has no geometry of its own) is drawn
 * as a short stub standing out of the surface by entities.snagStubOutM, never more than DAMAGE_TUNING.tipRadiusM: the
 * sharp-point test scores any contact within that of the point, so nothing drawn reaches past what it scores (TODO
 * "snag stub geometry (rule 3)").
 */
export function sharpCone(shape: Shape, sp: { local: V3; dir: V3; sharpness: number }): { tip: V3; length: number; radius: number } | null {
  const E = RENDER_TUNING.entities;
  const d = Math.hypot(sp.dir.x, sp.dir.y, sp.dir.z);
  if (!(d > 1e-9)) return null;
  const s = Math.min(1, Math.max(0, sp.sharpness));
  const reach = DAMAGE_TUNING.tipRadiusM;
  if (shape.kind === 'hull') {
    return { tip: { ...sp.local }, length: Math.min(reach, E.sharpConeLenM * (0.35 + 0.65 * s)), radius: E.sharpConeRadiusM * (0.45 + 0.55 * s) };
  }
  const out = Math.min(reach, E.snagStubOutM);
  const k = out / d;
  return {
    tip: { x: sp.local.x + sp.dir.x * k, y: sp.local.y + sp.dir.y * k, z: sp.local.z + sp.dir.z * k },
    // (Its base just under the surface, so the stub is thick where it leaves the wood, a broken branch's knob.)
    length: out + E.snagStubRadiusM,
    radius: E.snagStubRadiusM * (0.6 + 0.4 * s),
  };
}

/** A key that changes whenever the shape does. */
function shapeKey(s: Shape): string {
  switch (s.kind) {
    case 'ball':
      return `ball:${s.r}`;
    case 'box':
      return `box:${s.hx},${s.hy},${s.hz}`;
    case 'capsule':
      return `capsule:${s.halfHeight},${s.r}`;
    case 'cylinder':
      return `cyl:${s.halfHeight},${s.r},${s.sides}`;
    case 'hull':
      return `hull:${s.points.join(',')}`;
  }
}

/**
 * The geometry of an entity drawn changed (local frame, actual size, coloured `colour` outside and fresh-cut wood in
 * the cut; the mesh is rebuilt when the colour changes): a cylinder with its cross-cut notch
 * (§5.3: (1 − remaining) of its thickness deep on the fromDir side, at axisT; fromDir read in the entity's own frame),
 * any other shape with a pale wedge marking the cut; then bent by `bend` (m at the middle, along a local direction).
 */
function ownGeometry(e: Entity, bend: { m: number; dir: V3 } | null, colour: Color): BufferGeometry {
  const s = e.shape;
  const F = RENDER_TUNING.forest;
  const side = colour.clone();
  const cutC = new Color(F.cutWood);
  const cc = e.crossCut;
  let g: BufferGeometry;
  if (s.kind === 'cylinder') {
    const notches: Notch[] = [];
    if (cc) {
      const n = crossCutNotch(s.r, cc);
      if (n) notches.push(n);
    }
    const rings = bend ? [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75].map((t) => t * s.halfHeight) : [];
    g = notchedPrism(s.r, s.halfHeight, s.sides, notches, { side, cut: cutC }, { rings });
  } else {
    g = shapeGeometry(s).toNonIndexed();
    paint(g, side);
    if (cc) {
      const ax = principalAxis(s);
      const depth = Math.max(0, 1 - cc.remaining) * 2 * ax.crossHalf;
      const wedge = new BoxGeometry(0.03, Math.max(0.01, depth), ax.crossHalf * 1.6).toNonIndexed();
      const along = new Vector3(ax.dir.x, ax.dir.y, ax.dir.z);
      const from = new Vector3(cc.fromDir.x, cc.fromDir.y, cc.fromDir.z);
      from.addScaledVector(along, -from.dot(along));
      if (from.lengthSq() < 1e-9) from.set(along.y, along.z, along.x);
      from.normalize();
      const rot = new Matrix4().makeBasis(along, from, new Vector3().crossVectors(along, from));
      wedge.applyMatrix4(rot);
      wedge.translate(along.x * cc.axisT + from.x * (ax.crossHalf - depth / 2), along.y * cc.axisT + from.y * (ax.crossHalf - depth / 2), along.z * cc.axisT + from.z * (ax.crossHalf - depth / 2));
      paint(wedge, cutC);
      const merged = mergeGeometries([g, wedge]);
      g.dispose();
      wedge.dispose();
      g = merged ?? shapeGeometry(s);
    }
  }
  if (bend) g = bent(g, s, bend);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** The notch a cross-cut makes in a prism (axis local y), or null when nothing has been cut yet. */
export function crossCutNotch(r: number, cc: { axisT: number; remaining: number; fromDir: V3 }): Notch | null {
  const depth = Math.max(0, 1 - cc.remaining) * 2 * r;
  if (depth <= 0) return null;
  let fx = cc.fromDir.x;
  let fz = cc.fromDir.z;
  const l = Math.hypot(fx, fz);
  if (l < 1e-9) {
    fx = 1;
    fz = 0;
  } else {
    fx /= l;
    fz /= l;
  }
  const F = RENDER_TUNING.forest;
  return { fx, fz, depth, y: cc.axisT, halfOpen: Math.max(F.notchMinHalfOpenM, F.notchOpenPerDepth * depth) };
}

function paint(g: BufferGeometry, c: Color): void {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
}

/** The geometry bent: each vertex moved along `dir` by m × (1 − a²), a ∈ [−1, 1] along the shape's long axis. */
function bent(g0: BufferGeometry, s: Shape, bend: { m: number; dir: V3 }): BufferGeometry {
  const ax = principalAxis(s);
  const len = ax.max - ax.min;
  let g = g0.index ? g0.toNonIndexed() : g0;
  if (g !== g0) g0.dispose();
  // Enough vertices along the axis to bend (a stone hull or a box has only its corners).
  const tess = new TessellateModifier(Math.max(0.02, len / 8), 4).modify(g);
  g.dispose();
  g = tess;
  const pos = g.getAttribute('position');
  const mid = (ax.min + ax.max) / 2;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i) * ax.dir.x + pos.getY(i) * ax.dir.y + pos.getZ(i) * ax.dir.z;
    const a = Math.max(-1, Math.min(1, (t - mid) / Math.max(1e-6, len / 2)));
    const k = bend.m * (1 - a * a);
    pos.setXYZ(i, pos.getX(i) + bend.dir.x * k, pos.getY(i) + bend.dir.y * k, pos.getZ(i) + bend.dir.z * k);
  }
  pos.needsUpdate = true;
  return g;
}

// ---------------------------------------------------------------------------
// Held and stowed things
// ---------------------------------------------------------------------------

/** Where a stowed thing rides (RENDER_TUNING.carry): belt slots 0-2 at the hips, 3 across the back. */
export type CarrySlot = 0 | 1 | 2 | 3;

/**
 * The world matrix (no scale) a stowed entity is drawn at: its long axis hanging down at the hip (belt slots 0 left,
 * 1 right, 2 behind) from the drawn pelvis, or slung diagonally across the back of the drawn chest (slot 3), clear of
 * the body by its own thickness. `bone` is the drawn bone's world matrix; `scale` the body's.
 */
export function stowedMatrix(e: Entity, slot: CarrySlot, bone: Matrix4, scale: number, out = new Matrix4()): Matrix4 {
  const C = RENDER_TUNING.carry;
  const ax = principalAxis(e.shape);
  const axis = new Vector3(ax.dir.x, ax.dir.y, ax.dir.z).normalize();
  const centre = (ax.min + ax.max) / 2;
  let at: Vector3;
  let dir: Vector3;
  if (slot === 3) {
    at = new Vector3(0, 0.12, -(C.backOutM + ax.crossHalf)).multiplyScalar(scale);
    const t = (C.backTiltDeg * Math.PI) / 180;
    dir = new Vector3(Math.sin(t), Math.cos(t), 0);
  } else {
    const side = slot === 0 ? 1 : slot === 1 ? -1 : 0;
    at = new Vector3(side * (C.beltOutM + ax.crossHalf), -C.beltDownM, side === 0 ? -(C.beltOutM + ax.crossHalf) : 0).multiplyScalar(scale);
    dir = new Vector3(0, -1, 0);
  }
  const q = new Quaternion().setFromUnitVectors(axis, dir);
  // The entity's centre along its axis sits at `at`.
  const off = axis.clone().multiplyScalar(-centre).applyQuaternion(q);
  return out.multiplyMatrices(bone, new Matrix4().compose(at.add(off), q, new Vector3(1, 1, 1)));
}
