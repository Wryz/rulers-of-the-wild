// Scene queries for verbs, perception, movers and the client (docs/M1-DESIGN.md §1.5.6). They answer in owners and
// plain numbers and never expose a Rapier handle. Like every Rapier query they see colliders as of the last physics
// step (MAP rapier finding 7): a body created or moved this tick is found after the next step.
//
// QueryFilter defaults (a field left out): terrain true, entities 'all', no minimum mass, ropes false, fighters 'none'.
// - entities 'static': entities whose body is fixed (rooted trees, stumps, scaffolding, anchored stakes).
// - minEntityMassKg: the entity record's mass (density × volume), so a fixed trunk has its real mass.
// - fighters 'zones': a fighter's damage colliders (standing zones, slabs, the ruler's bones); 'kcc': its capsules.
// - ropes: rope sensor capsules.
import RAPIER from '@dimforge/rapier3d-compat';
import type { Fighter } from '../sim/fighter';
import { compareOwners, ownerKey, type PhysicsWorld } from './physics';
import { cylinderPoints, rapierHullOk, roundCylinderR } from './shapes';
import type { Hit, Owner, Pose3, QueryFilter, Shape, V3 } from './types';
import { WORLD_TUNING } from './worldTuning';

/** What queries need from the entity store (the world passes its EntityStore's records). */
export interface QueryEntities {
  /** kg, the entity record's mass; 0 when unknown. */
  mass(id: number): number;
  /** The entity's collider, or null (no body, or no such entity). */
  collider(id: number): RAPIER.Collider | null;
}

/** The terrain as queries need it (the world passes its Terrain): its heights, normals and extent. */
export interface QueryGround {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: V3): V3;
  readonly minX: number;
  readonly minZ: number;
  readonly tilesX: number;
  readonly tilesZ: number;
  readonly tileSize: number;
}

/**
 * m: how much nearer than Rapier's terrain hit (or the end of the ray, when Rapier found none) the analytic terrain
 * height must be for castRay to take it (SIM-fix3). Not a starting value: float32 slack between the heightfield
 * collider and Terrain.heightAt, which is exact on the same triangles in float64.
 */
const VERTICAL_RAY_SLACK_M = 1e-4;

/**
 * A Rapier query shape for a Shape (a cylinder is the convex hull of its prism, as its collider is), and where it sits
 * in the shape's local frame (the origin, except a fallback box's centre).
 *
 * SIM-fix3: a prism or hull whose points Rapier can't make a hull of (rapierHullOk: a needle or a sliver, such as the
 * cut piece of a thin stick place.ts casts) made every query with it throw "expected instance of p". Such a prism is
 * queried as Rapier's round cylinder of the same volume (roundCylinderR, as colliderDesc builds it), and such a hull as the box of its
 * points' local bounds, which holds it: a query with a shape Rapier can't build never throws.
 */
export function queryShape(s: Shape): { shape: RAPIER.Shape; offset: V3 } {
  const at0 = { x: 0, y: 0, z: 0 };
  switch (s.kind) {
    case 'ball':
      return { shape: new RAPIER.Ball(s.r), offset: at0 };
    case 'box':
      return { shape: new RAPIER.Cuboid(s.hx, s.hy, s.hz), offset: at0 };
    case 'capsule':
      return { shape: new RAPIER.Capsule(s.halfHeight, s.r), offset: at0 };
    case 'cylinder':
      return rapierHullOk(s)
        ? { shape: new RAPIER.ConvexPolyhedron(new Float32Array(cylinderPoints(s)), null), offset: at0 }
        : { shape: new RAPIER.Cylinder(s.halfHeight, roundCylinderR(s)), offset: at0 };
    case 'hull': {
      if (rapierHullOk(s)) return { shape: new RAPIER.ConvexPolyhedron(new Float32Array(s.points), null), offset: at0 };
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 2 < s.points.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const c = s.points[i + k];
          if (!Number.isFinite(c)) continue;
          lo[k] = Math.min(lo[k], c);
          hi[k] = Math.max(hi[k], c);
        }
      }
      if (!(lo[0] <= hi[0] && lo[1] <= hi[1] && lo[2] <= hi[2])) return { shape: new RAPIER.Ball(0), offset: at0 };
      const half = (k: number): number => (hi[k] - lo[k]) / 2;
      return { shape: new RAPIER.Cuboid(half(0), half(1), half(2)), offset: { x: lo[0] + half(0), y: lo[1] + half(1), z: lo[2] + half(2) } };
    }
  }
}

/** The pose of a query shape whose shape sits at `offset` in the frame `at`. */
function shiftedPose(at: Pose3, offset: V3): Pose3 {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return at;
  const { x, y, z, w } = at.q;
  // q · offset · q⁻¹
  const tx = 2 * (y * offset.z - z * offset.y);
  const ty = 2 * (z * offset.x - x * offset.z);
  const tz = 2 * (x * offset.y - y * offset.x);
  const r = { x: offset.x + w * tx + (y * tz - z * ty), y: offset.y + w * ty + (z * tx - x * tz), z: offset.z + w * tz + (x * ty - y * tx) };
  return { p: { x: at.p.x + r.x, y: at.p.y + r.y, z: at.p.z + r.z }, q: at.q };
}

const v3 = (v: { x: number; y: number; z: number }): V3 => ({ x: v.x, y: v.y, z: v.z });
const DOWN: Readonly<V3> = Object.freeze({ x: 0, y: -1, z: 0 });
/**
 * s: how far `overlaps` casts a shape to learn whether it already penetrates the terrain (a numerical device of the
 * query, not a starting value: any positive time works, and a cast that starts penetrating reports toi 0).
 */
const PENETRATION_PROBE_TOI = 1e-9;

export class WorldQueries {
  constructor(
    private readonly physics: PhysicsWorld,
    private readonly entities: QueryEntities,
    private readonly ground: QueryGround | null = null,
  ) {}

  /**
   * The first collider along the ray from `from` along `dir` (normalised here) within `maxToi` m; toi in m.
   *
   * SIM-fix3: Rapier 0.21's ray against a heightfield misses when cast straight down exactly through a vertex (about 1
   * vertex in 10 of the Clearing's 0.25 m grid), so Place found no support there ('noSupport'). A straight-down ray
   * that may hit the terrain also takes the terrain's own height under it (Terrain.heightAt, exact on the same
   * triangles) when that is nearer than what Rapier returned.
   */
  castRay(from: V3, dir: V3, maxToi: number, f: QueryFilter): Hit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 0)) return null;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const raw = this.physics.rapier.castRayAndGetNormal(new RAPIER.Ray(v3(from), d), maxToi, true, this.flags(f), undefined, undefined, undefined, this.predicate(f));
    const owner = raw ? this.physics.ownerOf(raw.collider.handle) : null;
    let hit: Hit | null = null;
    if (raw && owner) {
      const t = raw.timeOfImpact;
      hit = { owner, toi: t, point: { x: from.x + d.x * t, y: from.y + d.y * t, z: from.z + d.z * t }, normal: v3(raw.normal) };
    }
    const ground = this.groundStraightDown(from, d, maxToi, f);
    if (ground && (!hit || ground.toi < hit.toi - VERTICAL_RAY_SLACK_M)) return ground;
    return hit;
  }

  /** The terrain under a straight-down ray from `from`, from the terrain's heights: null for any other ray, off it. */
  private groundStraightDown(from: V3, d: V3, maxToi: number, f: QueryFilter): Hit | null {
    const g = this.ground;
    if (!g || !(f.terrain ?? true) || d.x !== 0 || d.z !== 0 || !(d.y < 0)) return null;
    // On the heightfield only (its edges included): beyond it there is no terrain collider to hit.
    if (!(from.x >= g.minX && from.x <= g.minX + g.tilesX * g.tileSize && from.z >= g.minZ && from.z <= g.minZ + g.tilesZ * g.tileSize)) return null;
    const h = g.heightAt(from.x, from.z);
    const toi = from.y - h;
    // A ray that starts under the ground, or ends above it, is Rapier's to answer.
    if (!(toi >= 0) || !(toi <= maxToi)) return null;
    const n = g.normalAt(from.x, from.z, { x: 0, y: 1, z: 0 });
    return { owner: { kind: 'terrain' }, toi, point: { x: from.x, y: h, z: from.z }, normal: { x: n.x, y: n.y, z: n.z } };
  }

  /**
   * The first collider a shape at `from` meets moving with velocity `vel` within time `maxToi` (toi in the units of
   * `vel`: seconds for m/s). point and normal are the struck collider's (world space).
   */
  castShape(shape: Shape, from: Pose3, vel: V3, maxToi: number, f: QueryFilter): Hit | null {
    const qs = queryShape(shape);
    const at = shiftedPose(from, qs.offset);
    const hit = this.physics.rapier.castShape(v3(at.p), at.q, v3(vel), qs.shape, 0, maxToi, true, this.flags(f), undefined, undefined, undefined, this.predicate(f));
    if (!hit) return null;
    const owner = this.physics.ownerOf(hit.collider.handle);
    if (!owner) return null;
    return { owner, toi: hit.time_of_impact, point: v3(hit.witness1), normal: v3(hit.normal1) };
  }

  /** Every owner whose colliders overlap the shape at `at`, once each, sorted in owner order. */
  overlaps(shape: Shape, at0: Pose3, f: QueryFilter): Owner[] {
    const found = new Map<string, Owner>();
    const qs = queryShape(shape);
    const rs = qs.shape;
    const pose = shiftedPose(at0, qs.offset);
    this.physics.rapier.intersectionsWithShape(
      v3(pose.p),
      pose.q,
      rs,
      (c) => {
        const o = this.physics.ownerOf(c.handle);
        if (o) found.set(ownerKey(o), o);
        return true;
      },
      this.flags(f),
      undefined,
      undefined,
      undefined,
      this.predicate(f),
    );
    // Rapier's intersection test never reports a heightfield against any shape but a ball (it returns no pair), so the
    // terrain is tested with a cast that starts where the shape is: one that starts penetrating stops at toi 0.
    if ((f.terrain ?? true) && !found.has('terrain') && shape.kind !== 'ball') {
      const hit = this.physics.rapier.castShape(v3(pose.p), pose.q, DOWN, rs, 0, PENETRATION_PROBE_TOI, true, undefined, undefined, undefined, undefined, (c) => this.physics.ownerOf(c.handle)?.kind === 'terrain');
      if (hit && hit.time_of_impact === 0) found.set('terrain', { kind: 'terrain' });
    }
    return [...found.values()].sort(compareOwners);
  }

  /**
   * The point of an entity's collider surface nearest `p`, its distance from `p`, and whether `p` is inside. No body
   * (or no such entity): `p` itself at distance Infinity.
   */
  projectPoint(entity: number, p: V3): { point: V3; dist: number; inside: boolean } {
    const c = this.entities.collider(entity);
    const proj = c ? c.projectPoint(v3(p), false) : null;
    if (!proj) return { point: v3(p), dist: Infinity, inside: false };
    const q = v3(proj.point);
    return { point: q, dist: Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z), inside: proj.isInside };
  }

  /** Distance from a fighter's chest point (pos + chestHeightM × scale up) to an entity's collider; 0 inside it. */
  surfaceDistance(f: Fighter, entity: number): number {
    const c = this.entities.collider(entity);
    if (!c) return Infinity;
    const chest = { x: f.pos.x, y: f.pos.y + WORLD_TUNING.chestHeightM * f.scale, z: f.pos.z };
    const proj = c.projectPoint(chest, true);
    if (!proj) return Infinity;
    return proj.isInside ? 0 : Math.hypot(proj.point.x - chest.x, proj.point.y - chest.y, proj.point.z - chest.z);
  }

  /** Sensors (zones, ropes) are skipped unless the filter asks for ropes or fighters' zones. */
  private flags(f: QueryFilter): RAPIER.QueryFilterFlags | undefined {
    return f.ropes || f.fighters === 'zones' ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  }

  private predicate(f: QueryFilter): (c: RAPIER.Collider) => boolean {
    return (c) => {
      const o = this.physics.ownerOf(c.handle);
      if (!o) return false;
      switch (o.kind) {
        case 'terrain':
          return f.terrain ?? true;
        case 'entity': {
          const mode = f.entities ?? 'all';
          if (mode === 'none') return false;
          if (f.exclude?.entities?.includes(o.id)) return false;
          if (mode === 'static' && !(c.parent()?.isFixed() ?? true)) return false;
          if (f.minEntityMassKg !== undefined && !(this.entities.mass(o.id) >= f.minEntityMassKg)) return false;
          return true;
        }
        case 'fighter': {
          const mode = f.fighters ?? 'none';
          if (mode === 'none') return false;
          if (f.exclude?.fighters?.includes(o.id)) return false;
          return mode === 'kcc' ? o.part === 'kcc' : o.part !== 'kcc';
        }
        case 'rope':
          return f.ropes ?? false;
      }
    };
  }
}
