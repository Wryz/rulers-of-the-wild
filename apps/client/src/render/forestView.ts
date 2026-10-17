// Trees on screen (docs/M1-DESIGN.md §10.4): standing trunks as one InstancedMesh (the unit 8-gon prism, exactly the
// collider), their crowns as another (three faceted blobs), saplings as two more (stem and leaves); all through
// applyCutout (the trunks and crowns between the camera and the player dissolve, render/cutout.ts).
//
// A tree that leaves `standing` gets a mesh of its own:
// - notched (still rooted): the notch wedge cut into the trunk on the cut side at the cut height, (1 − remaining) of
//   its diameter deep (rule 3: you can see how far through it is); each `chop` shudders it chopShudderDeg for
//   chopShudderS (and sheds a few leaves); below creakBelowRemaining it trembles (it creaks before it goes, SPEC:581);
// - falling or felled (the trunk above the cut, P10): the upper half of the notch at its foot, and its crown drawn
//   collapsed against the trunk, within the trunk radius + fallenCrownPadM over its top third, so no crown is seen
//   passing through a body the sim doesn't hit. TODO "canopy collision (rule 3)": trees have no canopy collider in M1
//   (§2.5, RR-15); a standing crown overlaps nothing a creature can reach.
// - its stump shows the lower half of the notch and a pale cut top.
// A felled trunk keeps its crown while this view remembers it was a tree (P10 sets `plant` null once it rests: from
// then on it is an ordinary log for the rules; the look is presentation only). Cross-cut notches (§5.3) show on it too.
import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  type Scene,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type Entity, FELL_TUNING, type Shape, type V3 } from '@wild/sim';
import type { SimEvent } from '../game/ports';
import { applyCutout } from './cutout';
import { crossCutNotch, flatMaterial, Instancer, lerpPoseMatrix, type Notch, notchedPrism, unitPrism } from './entityViews';
import { hash2, RENDER_TUNING } from './terrainView';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** The crown's blobs in its unit frame (centre and radius; the first on top), jittered per vertex for a natural look. */
const BLOBS: readonly [number, number, number, number][] = [
  [0, 0, 0, 1],
  [0.6, -0.42, 0.28, 0.72],
  [-0.52, -0.38, -0.34, 0.68],
];

/** A crown: three faceted blobs, lighter on top (vertex colours), radius ≈ 1 about its origin. */
export function crownGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  BLOBS.forEach(([x, y, z, r], b) => {
    const g = new IcosahedronGeometry(r, 1).toNonIndexed();
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = 1 + 0.12 * (hash2(b * 997 + Math.round(pos.getX(i) * 50), Math.round(pos.getY(i) * 50) * 31 + Math.round(pos.getZ(i) * 50)) - 0.5);
      pos.setXYZ(i, x + pos.getX(i) * k, y + pos.getY(i) * k, z + pos.getZ(i) * k);
    }
    parts.push(g);
  });
  const g = mergeGeometries(parts) ?? new IcosahedronGeometry(1, 1);
  for (const p of parts) p.dispose();
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = 0.72 + 0.4 * Math.min(1, Math.max(0, (pos.getY(i) + 1.1) / 2.1));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * A falling or felled tree's crown (trunk frame, axis +y, half-height hh, circumradius r): the crown's blobs pressed
 * against the trunk, every vertex within r + fallenCrownPadM of the axis and inside the top third (rule 3, RR-15).
 */
export function collapsedCrownGeometry(crown: BufferGeometry, r: number, hh: number): BufferGeometry {
  const g = crown.clone();
  const pos = g.getAttribute('position');
  let radial = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    radial = Math.max(radial, Math.hypot(pos.getX(i), pos.getZ(i)));
    lo = Math.min(lo, pos.getY(i));
    hi = Math.max(hi, pos.getY(i));
  }
  const R = r + RENDER_TUNING.fallenCrownPadM;
  const third = (2 * hh) / 3;
  const kr = R / Math.max(1e-9, radial);
  const ky = third / Math.max(1e-9, hi - lo);
  for (let i = 0; i < pos.count; i++) {
    // (Squeezed a hair inside the bound so float32 rounding never puts a vertex past it.)
    pos.setXYZ(i, pos.getX(i) * kr * 0.999, hh - third + (pos.getY(i) - lo) * ky * 0.999, pos.getZ(i) * kr * 0.999);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// What the forest draws
// ---------------------------------------------------------------------------

/** A tree as this view remembers it (presentation memory: P10 clears `plant` once a felled trunk rests). */
interface TreeMemory {
  sapling: boolean;
  /** The notch's side in the trunk's own frame (x, z), and how far through it was. */
  notch: { fx: number; fz: number; remaining: number } | null;
  diameter: number;
  height: number;
  /** The rooted trunk's rotation (the standing frame fromDir is turned into). */
  q0: { x: number; y: number; z: number; w: number };
}

/** A tree, sapling or stump with a mesh of its own. */
export interface TreeView {
  group: Group;
  trunk: Mesh;
  crown: Mesh | null;
  key: string;
  /** The crown is drawn collapsed (falling or felled). */
  collapsed: boolean;
  /** The trunk's notches as drawn (trunk frame). */
  notches: Notch[];
}

/** What the forest needs each frame. */
export interface ForestFrame {
  alpha: number;
  /** Game seconds since the last frame (the shudder, the creak and the leaves stop in a pause or a hit-pause). */
  dt: number;
  ground(x: number, z: number): number;
}

const isSaplingLook = (e: Entity) => e.look === 'sapling';
const isTreeLook = (e: Entity) => e.look === 'tree' || e.look === 'sapling';
const prism = (s: Shape): s is Extract<Shape, { kind: 'cylinder' }> => s.kind === 'cylinder';

const _m = new Matrix4();
const _m2 = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);

export class ForestView {
  readonly group = new Group();
  readonly crown: BufferGeometry;
  /** Standing trunks (the unit prism of each side count), crowns, sapling stems and leaves. */
  private readonly trunks = new Map<number, Instancer>();
  readonly canopies: Instancer;
  private readonly stems = new Map<number, Instancer>();
  readonly saplingTops: Instancer;
  readonly leaves: LeafFall;
  private readonly own = new Map<number, TreeView>();
  private readonly memory = new Map<number, TreeMemory>();
  /** stump id → the tree it was cut from. */
  private readonly stumpOf = new Map<number, number>();
  private readonly shudders = new Map<number, number>();
  private readonly drawn = new Map<number, Matrix4>();
  private time = 0;

  constructor(scene: Scene) {
    this.group.name = 'forest';
    scene.add(this.group);
    this.crown = crownGeometry();
    this.canopies = new Instancer(this.group, this.crown, cut(flatMaterial({ vertexColors: true, roughness: 0.9 })), 64, 'crowns');
    this.saplingTops = new Instancer(this.group, this.crown, cut(flatMaterial({ vertexColors: true, roughness: 0.9 })), 32, 'sapling leaves');
    this.leaves = new LeafFall(this.group);
  }

  /** The standing trunks of `sides`-gon prisms (tests). */
  trunkInstancer(sides = 8): Instancer | null {
    return this.trunks.get(sides) ?? null;
  }

  /** The sapling stems of `sides`-gon prisms (tests). */
  stemInstancer(sides = 8): Instancer | null {
    return this.stems.get(sides) ?? null;
  }

  /** A tree's own mesh (notched, falling, felled, a stump), or null when it is instanced or not a tree. */
  viewOf(id: number): TreeView | null {
    return this.own.get(id) ?? null;
  }

  /** The tree's drawn world matrix (no scale) this frame. */
  matrixOf(id: number): Matrix4 | null {
    return this.drawn.get(id) ?? null;
  }

  /** Does the forest draw `e` (trees, saplings, their stumps and felled trunks)? Entity views skip what it draws. */
  owns(e: Entity): boolean {
    if (e.plant) return true;
    if (e.look === 'stump' || this.stumpOf.has(e.id)) return true;
    if (!isTreeLook(e)) return false;
    // Rooted wood with no plant left is a stump; a free trunk the view saw as a tree is a felled tree.
    return e.state === 'fixed' || e.state === 'anchored' || this.memory.has(e.id);
  }

  /** A chop: the tree shudders and sheds a few leaves. */
  handle(e: SimEvent): void {
    if (e.type !== 'chop') return;
    this.shudders.set(e.tree, 0);
    const m = this.drawn.get(e.tree);
    const mem = this.memory.get(e.tree);
    if (!m || !mem) return;
    // From the crown: the trunk top in the world.
    _p.set(0, mem.height / 2, 0).applyMatrix4(m);
    const R = crownRadius(mem.height, mem.sapling);
    this.leaves.spawn(_p, R, Math.round(RENDER_TUNING.forest.leavesPerChop * (mem.sapling ? 0.4 : 1)));
  }

  sync(entities: readonly Entity[], f: ForestFrame): void {
    this.time += f.dt;
    for (const i of this.trunks.values()) i.begin();
    for (const i of this.stems.values()) i.begin();
    this.canopies.begin();
    this.saplingTops.begin();
    const seen = new Set<number>();
    for (const e of entities) {
      if (!this.owns(e)) continue;
      seen.add(e.id);
      if (e.plant) this.remember(e);
      let M = this.drawn.get(e.id);
      if (!M) {
        M = new Matrix4();
        this.drawn.set(e.id, M);
      }
      lerpPoseMatrix(e.prevPose, e.pose, f.alpha, M);
      const standing = e.plant !== null && e.plant.phase === 'standing' && e.state === 'fixed';
      if (standing && prism(e.shape)) {
        this.dropOwn(e.id);
        this.instance(e, M);
        continue;
      }
      this.drawOwn(e, M);
    }
    for (const i of this.trunks.values()) i.end();
    for (const i of this.stems.values()) i.end();
    this.canopies.end();
    this.saplingTops.end();
    for (const id of [...this.own.keys()]) if (!seen.has(id)) this.dropOwn(id);
    for (const id of [...this.drawn.keys()]) if (!seen.has(id)) this.drawn.delete(id);
    for (const [id, t] of this.shudders) {
      const next = t + f.dt;
      if (next > RENDER_TUNING.chopShudderS || !seen.has(id)) this.shudders.delete(id);
      else this.shudders.set(id, next);
    }
    // Forget a tree once neither it nor its stump is left.
    const stumpsSeen = new Set<number>();
    for (const [stump, tree] of this.stumpOf) {
      if (seen.has(stump)) stumpsSeen.add(tree);
      else if (!seen.has(tree)) this.stumpOf.delete(stump);
    }
    for (const id of [...this.memory.keys()]) if (!seen.has(id) && !stumpsSeen.has(id)) this.memory.delete(id);
    this.leaves.update(f.dt, f.ground);
  }

  dispose(): void {
    for (const id of [...this.own.keys()]) this.dropOwn(id);
    for (const i of this.trunks.values()) i.dispose();
    for (const i of this.stems.values()) i.dispose();
    this.canopies.dispose(false);
    this.saplingTops.dispose(false);
    this.crown.dispose();
    this.leaves.dispose();
    this.group.removeFromParent();
  }

  // -------------------------------------------------------------------------

  private remember(e: Entity): void {
    const p = e.plant!;
    let m = this.memory.get(e.id);
    if (!m) {
      m = { sapling: isSaplingLook(e), notch: null, diameter: p.diameter, height: p.height, q0: { ...e.pose.q } };
      this.memory.set(e.id, m);
    }
    if (p.phase === 'standing' || p.phase === 'notched') m.q0 = { ...e.pose.q };
    if (p.cut) {
      // fromDir is world horizontal at the first chop: turned into the rooted trunk's frame, which the trunk keeps as
      // it falls.
      const inv = { x: -m.q0.x, y: -m.q0.y, z: -m.q0.z, w: m.q0.w };
      const l = rotate(inv, p.cut.fromDir);
      const n = Math.hypot(l.x, l.z) || 1;
      m.notch = { fx: l.x / n, fz: l.z / n, remaining: p.cut.remaining };
    }
    if (p.stump !== null) this.stumpOf.set(p.stump, e.id);
  }

  private instance(e: Entity, M: Matrix4): void {
    const s = e.shape as Extract<Shape, { kind: 'cylinder' }>;
    const F = RENDER_TUNING.forest;
    const sapling = isSaplingLook(e);
    const map = sapling ? this.stems : this.trunks;
    let inst = map.get(s.sides);
    if (!inst) {
      inst = new Instancer(this.group, unitPrism(s.sides), cut(flatMaterial({ roughness: 0.95 })), sapling ? 32 : 64, sapling ? 'sapling stems' : 'trunks');
      map.set(s.sides, inst);
    }
    const v = 1 + F.variation * (hash2(e.id, 53) * 2 - 1);
    _c.set(sapling ? F.saplingStem : F.bark).multiplyScalar(v);
    _m.copy(M).multiply(_m2.makeScale(s.r, s.halfHeight, s.r));
    inst.push(_m, _c);
    // The crown sits over the trunk top, turned by the tree's id so no two look alike.
    const h = e.plant?.height ?? 2 * s.halfHeight;
    const R = crownRadius(h, sapling);
    _q.setFromAxisAngle(_up, hash2(e.id, 7) * Math.PI * 2);
    _m2.compose(_p.set(0, s.halfHeight - RENDER_TUNING.forest.crownSinkFrac * R, 0), _q, _s.set(R, R * (0.9 + 0.2 * hash2(e.id, 9)), R));
    _m.copy(M).multiply(_m2);
    _c.set(sapling ? F.saplingLeaves : F.canopy).multiplyScalar(1 + F.variation * (hash2(e.id, 61) * 2 - 1));
    (sapling ? this.saplingTops : this.canopies).push(_m, _c);
  }

  private drawOwn(e: Entity, M: Matrix4): void {
    const s = e.shape;
    if (!prism(s)) return;
    const mem = this.memory.get(e.id) ?? null;
    const p = e.plant;
    const stumpTree = this.stumpOf.get(e.id);
    const stump = !p && (e.look === 'stump' || stumpTree !== undefined || e.state === 'fixed' || e.state === 'anchored');
    const falling = !stump && (!p || p.phase === 'falling' || p.phase === 'felled');
    const sapling = mem?.sapling ?? isSaplingLook(e);
    const notches: Notch[] = [];
    const cutH = FELL_TUNING.cutHeightM;
    if (stump) {
      // The lower half of the notch of the tree it was cut from, at its top.
      const tm = stumpTree !== undefined ? this.memory.get(stumpTree) : undefined;
      if (tm?.notch) notches.push(treeNotch(tm.notch, tm.diameter, s.halfHeight));
    } else if (mem?.notch) {
      // Rooted: the notch at the cut height over the base; the trunk above the cut (falling, felled): at its foot.
      const full = p ? Math.abs(2 * s.halfHeight - p.height) < 1e-3 : false;
      notches.push(treeNotch(mem.notch, mem.diameter, full ? -s.halfHeight + cutH : -s.halfHeight));
    }
    if (e.crossCut) {
      const n = crossCutNotch(s.r, e.crossCut);
      if (n) notches.push(n);
    }
    const F = RENDER_TUNING.forest;
    const key = `${s.r},${s.halfHeight},${s.sides}|${stump ? 'stump' : falling ? 'down' : 'up'}|${notches.map((n) => `${n.fx.toFixed(3)},${n.fz.toFixed(3)},${n.depth.toFixed(4)},${n.y.toFixed(3)}`).join(';')}|${F.bark}${F.cutWood}${F.canopy}${RENDER_TUNING.fallenCrownPadM}`;
    let v = this.own.get(e.id);
    if (!v || v.key !== key) {
      this.dropOwn(e.id);
      v = this.build(e, s, notches, { stump, falling, sapling, key, height: p?.height ?? mem?.height ?? 2 * s.halfHeight });
      this.own.set(e.id, v);
    }
    // The shudder of a chop and the creak of a tree about to go, tilting the trunk about its foot toward its fall.
    let angle = 0;
    const T = RENDER_TUNING;
    const t = this.shudders.get(e.id);
    if (t !== undefined && t < T.chopShudderS && !falling) {
      const u = t / Math.max(1e-6, T.chopShudderS);
      angle += ((T.chopShudderDeg * Math.PI) / 180) * Math.sin(u * Math.PI * 4) * (1 - u);
    }
    const rem = mem?.notch?.remaining ?? 1;
    if (p && p.phase === 'notched' && rem < T.creakBelowRemaining) {
      const k = 1 - rem / Math.max(1e-6, T.creakBelowRemaining);
      angle += ((F.creakDeg * Math.PI) / 180) * k * Math.sin(this.time * F.creakHz * Math.PI * 2) * (0.6 + 0.4 * Math.sin(this.time * 1.7 + e.id));
    }
    v.group.matrix.copy(M);
    if (angle !== 0 && mem?.notch) {
      // Toward the fall (away from the cut side), about the trunk's foot.
      const fall = _p.set(-mem.notch.fx, 0, -mem.notch.fz);
      _axis.crossVectors(_up, fall).normalize();
      _q.setFromAxisAngle(_axis, angle);
      _m.makeTranslation(0, -s.halfHeight, 0).multiply(_m2.makeRotationFromQuaternion(_q)).multiply(new Matrix4().makeTranslation(0, s.halfHeight, 0));
      v.group.matrix.multiply(_m);
    }
    v.group.matrixWorldNeedsUpdate = true;
  }

  private build(
    e: Entity,
    s: Extract<Shape, { kind: 'cylinder' }>,
    notches: Notch[],
    o: { stump: boolean; falling: boolean; sapling: boolean; key: string; height: number },
  ): TreeView {
    const F = RENDER_TUNING.forest;
    const v = 1 + F.variation * (hash2(e.id, 53) * 2 - 1);
    const side = new Color(o.sapling ? F.saplingStem : F.bark).multiplyScalar(v);
    const cutC = new Color(F.cutWood);
    const g = notchedPrism(s.r, s.halfHeight, s.sides, notches, { side, cut: cutC, topCut: o.stump, bottomCut: o.falling });
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.name = `tree ${e.id}`;
    const trunk = new Mesh(g, cut(flatMaterial({ vertexColors: true, roughness: 0.95 })));
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);
    let crown: Mesh | null = null;
    if (!o.stump) {
      const leafC = new Color(o.sapling ? F.saplingLeaves : F.canopy).multiplyScalar(1 + F.variation * (hash2(e.id, 61) * 2 - 1));
      const mat = cut(flatMaterial({ vertexColors: true, roughness: 0.9, color: `#${leafC.getHexString()}` }));
      if (o.falling) {
        crown = new Mesh(collapsedCrownGeometry(this.crown, s.r, s.halfHeight), mat);
      } else {
        crown = new Mesh(this.crown, mat);
        const R = crownRadius(o.height, o.sapling);
        crown.position.set(0, s.halfHeight - F.crownSinkFrac * R, 0);
        crown.quaternion.setFromAxisAngle(_up, hash2(e.id, 7) * Math.PI * 2);
        crown.scale.set(R, R * (0.9 + 0.2 * hash2(e.id, 9)), R);
      }
      crown.castShadow = true;
      crown.receiveShadow = true;
      group.add(crown);
    }
    this.group.add(group);
    return { group, trunk, crown, key: o.key, collapsed: o.falling && !o.stump, notches };
  }

  private dropOwn(id: number): void {
    const v = this.own.get(id);
    if (!v) return;
    v.group.removeFromParent();
    v.trunk.geometry.dispose();
    (v.trunk.material as MeshStandardMaterial).dispose();
    if (v.crown) {
      if (v.crown.geometry !== this.crown) v.crown.geometry.dispose();
      (v.crown.material as MeshStandardMaterial).dispose();
    }
    this.own.delete(id);
  }
}

/** A crown's radius for a tree `height` m tall. */
export function crownRadius(height: number, sapling: boolean): number {
  const F = RENDER_TUNING.forest;
  return sapling ? F.saplingCrownPerH * height : Math.max(F.crownMinM, F.crownRadiusPerH * height);
}

/** A felling notch (§2.5): (1 − remaining) × diameter deep from the cut side, its deepest line at local y. */
export function treeNotch(n: { fx: number; fz: number; remaining: number }, diameter: number, y: number): Notch {
  const F = RENDER_TUNING.forest;
  const depth = Math.max(0, 1 - n.remaining) * diameter;
  return { fx: n.fx, fz: n.fz, depth, y, halfOpen: Math.max(F.notchMinHalfOpenM, F.notchOpenPerDepth * depth) };
}

function cut<T extends MeshStandardMaterial>(m: T): T {
  return applyCutout(m);
}

function rotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}

// ---------------------------------------------------------------------------
// Leaves shed by a chop (presentation only: Math.random never reaches the sim, rule 7)
// ---------------------------------------------------------------------------

interface Leaf {
  at: [number, number, number];
  v: [number, number, number];
  spin: number;
  turn: number;
  age: number;
  life: number;
  landed: boolean;
}

export class LeafFall {
  readonly inst: Instancer;
  private readonly list: Leaf[] = [];
  private static readonly MAX = 400;

  constructor(parent: Group) {
    const g = new PlaneGeometry(0.14, 0.09);
    this.inst = new Instancer(parent, g, flatMaterial({ roughness: 0.9 }), 64, 'leaves');
    this.inst.material.side = DoubleSide;
    this.inst.mesh.castShadow = false;
  }

  get count(): number {
    return this.list.length;
  }

  /** `n` leaves from inside a crown of radius `r` centred at `at`. */
  spawn(at: Vector3, r: number, n: number): void {
    const F = RENDER_TUNING.forest;
    for (let i = 0; i < n && this.list.length < LeafFall.MAX; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r * 0.8;
      this.list.push({
        at: [at.x + Math.cos(a) * d, at.y - Math.random() * r * 0.6, at.z + Math.sin(a) * d],
        v: [(Math.random() - 0.5) * F.leafDriftMps, -F.leafFallMps * (0.6 + 0.4 * Math.random()), (Math.random() - 0.5) * F.leafDriftMps],
        spin: (Math.random() - 0.5) * 8,
        turn: Math.random() * Math.PI * 2,
        age: 0,
        life: F.leafLifeS * (0.7 + 0.3 * Math.random()),
        landed: false,
      });
    }
  }

  update(dt: number, ground: (x: number, z: number) => number): void {
    const col = new Color(RENDER_TUNING.forest.canopy);
    this.inst.begin();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const l = this.list[i];
      l.age += dt;
      if (l.age > l.life) {
        this.list.splice(i, 1);
        continue;
      }
      if (!l.landed) {
        // Fluttering down: the drift swings as it turns.
        l.turn += l.spin * dt;
        l.at[0] += (l.v[0] + Math.sin(l.turn) * 0.3) * dt;
        l.at[1] += l.v[1] * dt;
        l.at[2] += (l.v[2] + Math.cos(l.turn) * 0.3) * dt;
        const g = ground(l.at[0], l.at[2]) + 0.01;
        if (l.at[1] <= g) {
          l.at[1] = g;
          l.landed = true;
        }
      }
    }
    for (const l of this.list) {
      // Tumbling about a tilted axis while it falls; flat on the ground once down.
      if (l.landed) _q.setFromAxisAngle(_axis.set(1, 0, 0), -Math.PI / 2);
      else _q.setFromAxisAngle(_axis.set(Math.sin(l.turn), 0.3, Math.cos(l.turn)).normalize(), l.turn);
      _m.compose(_p.set(l.at[0], l.at[1], l.at[2]), _q, _s.set(1, 1, 1));
      this.inst.push(_m, col);
    }
    this.inst.end();
  }

  dispose(): void {
    this.inst.dispose();
  }
}
