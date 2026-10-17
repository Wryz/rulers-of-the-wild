// Ropes on screen (docs/M1-DESIGN.md §10.4): one 6-sided tube per world.joints.view() entry, between its anchors as
// drawn (an end tied to an entity follows that entity as drawn; an end in a hand is at the drawn hand). A slack rope
// sags as a parabola as long as it is (ropes.segments segments) and never through the ground, so a vine's loose end
// lies on it; a taut rope is straight and thinner, radius × (1 − ropeThinMax · strain); above ropeFrayFrac of its
// strength it frays: fuzzy (jittered) and reddish (SPEC:357-358, rule 3; the creak is the audio's).
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  type MeshStandardMaterial,
  type Matrix4,
  Vector3,
  type Scene,
} from 'three';
import { type Entity, FACTORY_TUNING, type JointRecord, type RopeView } from '@wild/sim';
import { flatMaterial } from './entityViews';
import { materialLook, RENDER_TUNING } from './terrainView';

/** What the rope views read from the world. */
export interface RopeSource {
  joints: { view(): readonly RopeView[]; get(id: number): JointRecord | undefined };
  entities: { get(id: number): Entity | undefined };
  terrain: { heightAt(x: number, z: number): number };
}

/** Where things are drawn this frame (WorldViews): entities as drawn, and the fist of a fighter holding an end. */
export interface RopeFrame {
  matrixOf(entity: number): Matrix4 | null;
  handOf(fighter: number): Vector3 | null;
}

const SIDES = 6;

/** One rope's tube. */
export interface RopeMesh {
  mesh: Mesh;
  /** The joint it draws. */
  joint: number;
  /** As last drawn: the radius (m), the strain, the colour and the points along it (world). */
  radius: number;
  strain: number;
  points: Vector3[];
}

const _a = new Vector3();
const _b = new Vector3();
const _t = new Vector3();
const _n = new Vector3();
const _bn = new Vector3();
const _c = new Color();
const _fray = new Color();

export class RopeViews {
  readonly group = new Group();
  private readonly ropes = new Map<number, RopeMesh>();

  constructor(scene: Scene) {
    this.group.name = 'ropes';
    scene.add(this.group);
  }

  /** The drawn ropes by joint id (tests). */
  get views(): ReadonlyMap<number, RopeMesh> {
    return this.ropes;
  }

  sync(world: RopeSource, f: RopeFrame): void {
    const T = RENDER_TUNING;
    const R = T.ropes;
    const seen = new Set<number>();
    for (const rv of world.joints.view()) {
      seen.add(rv.joint);
      const j = world.joints.get(rv.joint);
      // The ends as drawn.
      endPoint(rv.a, j?.a, f, _a);
      endPoint(rv.b, j?.b, f, _b);
      const strain = Math.max(0, rv.strain);
      const base = FACTORY_TUNING.ropeRadiusM * R.radiusMul;
      const radius = rv.taut ? base * Math.max(0.05, 1 - T.ropeThinMax * Math.min(1, strain)) : base;
      const segs = Math.max(1, Math.round(R.segments));
      const pts = ropePoints(_a, _b, rv.lengthM, rv.taut, segs, radius, world.terrain);
      // Fraying: the tube's surface jittered, more the nearer it is to breaking.
      const fray = strain > T.ropeFrayFrac ? Math.min(1, (strain - T.ropeFrayFrac) / Math.max(1e-6, 1 - T.ropeFrayFrac)) : 0;
      let v = this.ropes.get(rv.joint);
      if (!v || v.points.length !== pts.length) {
        if (v) this.drop(v);
        v = { mesh: new Mesh(tubeGeometry(segs), flatMaterial({ roughness: 0.9 })), joint: rv.joint, radius, strain, points: pts };
        v.mesh.castShadow = true;
        v.mesh.frustumCulled = false;
        v.mesh.name = `rope ${rv.joint}`;
        this.group.add(v.mesh);
        this.ropes.set(rv.joint, v);
      }
      v.radius = radius;
      v.strain = strain;
      v.points = pts;
      writeTube(v.mesh.geometry, pts, radius, fray * R.frayJitterFrac);
      const rope = j?.rope ? world.entities.get(j.rope.entity) : undefined;
      _c.set(materialLook(rope?.material ?? 'vine').color);
      if (fray > 0) _c.lerp(_fray.set(R.frayColor), 0.25 + 0.6 * fray);
      (v.mesh.material as MeshStandardMaterial).color.copy(_c);
    }
    for (const [id, v] of this.ropes) {
      if (seen.has(id)) continue;
      this.drop(v);
      this.ropes.delete(id);
    }
  }

  dispose(): void {
    for (const v of this.ropes.values()) this.drop(v);
    this.ropes.clear();
    this.group.removeFromParent();
  }

  private drop(v: RopeMesh): void {
    v.mesh.removeFromParent();
    v.mesh.geometry.dispose();
    (v.mesh.material as MeshStandardMaterial).dispose();
  }
}

/** An end as drawn: an entity's anchor through the entity's drawn matrix, a held end at the hand, else the sim's point. */
function endPoint(sim: { x: number; y: number; z: number }, anchor: JointRecord['a'] | undefined, f: RopeFrame, out: Vector3): Vector3 {
  out.set(sim.x, sim.y, sim.z);
  if (!anchor) return out;
  if (anchor.fighter !== undefined) {
    const h = f.handOf(anchor.fighter);
    if (h) out.copy(h);
    return out;
  }
  if (anchor.entity !== null && !anchor.loose) {
    const m = f.matrixOf(anchor.entity);
    if (m) out.set(anchor.local.x, anchor.local.y, anchor.local.z).applyMatrix4(m);
  }
  return out;
}

/**
 * The rope's centre line from a to b: straight when taut (or when it is no longer than the gap); otherwise a parabola
 * sagging under the chord so its length is about `length` (s ≈ c + 8d²/3c), kept `radius` above the ground (the slack of
 * a hanging vine lies on the ground).
 */
export function ropePoints(
  a: Vector3,
  b: Vector3,
  length: number,
  taut: boolean,
  segments: number,
  radius: number,
  ground: { heightAt(x: number, z: number): number },
): Vector3[] {
  const c = a.distanceTo(b);
  const sag = taut || length <= c ? 0 : c > 1e-4 ? Math.sqrt((3 * c * (length - c)) / 8) : length / 2;
  const pts: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new Vector3().lerpVectors(a, b, t);
    p.y -= 4 * sag * t * (1 - t);
    const g = ground.heightAt(p.x, p.z) + radius;
    if (p.y < g && i > 0 && i < segments) p.y = g;
    pts.push(p);
  }
  return pts;
}

/** A tube of `segments` segments and SIDES sides (positions written each frame by writeTube). */
function tubeGeometry(segments: number): BufferGeometry {
  const rings = segments + 1;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(rings * SIDES * 3), 3));
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    for (let k = 0; k < SIDES; k++) {
      const k1 = (k + 1) % SIDES;
      const a = i * SIDES + k;
      const b = i * SIDES + k1;
      const c = (i + 1) * SIDES + k;
      const d = (i + 1) * SIDES + k1;
      index.push(a, b, c, b, d, c);
    }
  }
  g.setIndex(index);
  return g;
}

/** Rings of SIDES points of `radius` round each point, each pushed out by up to jitter × radius (fraying). */
function writeTube(g: BufferGeometry, pts: Vector3[], radius: number, jitter: number): void {
  const pos = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    _t.subVectors(next, prev);
    if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
    _t.normalize();
    // A frame round the tangent.
    _n.set(0, 1, 0);
    if (Math.abs(_t.y) > 0.9) _n.set(1, 0, 0);
    _bn.crossVectors(_t, _n).normalize();
    _n.crossVectors(_bn, _t).normalize();
    for (let k = 0; k < SIDES; k++) {
      const ang = (k / SIDES) * Math.PI * 2;
      // (Presentation only: Math.random never reaches the sim, rule 7.)
      const r = radius * (1 + (jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0));
      const x = pts[i].x + (_n.x * Math.cos(ang) + _bn.x * Math.sin(ang)) * r;
      const y = pts[i].y + (_n.y * Math.cos(ang) + _bn.y * Math.sin(ang)) * r;
      const z = pts[i].z + (_n.z * Math.cos(ang) + _bn.z * Math.sin(ang)) * r;
      pos.setXYZ(i * SIDES + k, x, y, z);
    }
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
}
