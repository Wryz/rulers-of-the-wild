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
import { cylinderPoints } from './shapes';
import type { Hit, Owner, Pose3, QueryFilter, Shape, V3 } from './types';
import { WORLD_TUNING } from './worldTuning';

/** What queries need from the entity store (the world passes its EntityStore's records). */
export interface QueryEntities {
  /** kg, the entity record's mass; 0 when unknown. */
  mass(id: number): number;
  /** The entity's collider, or null (no body, or no such entity). */
  collider(id: number): RAPIER.Collider | null;
}

/** A Rapier query shape for a Shape (a cylinder is the convex hull of its prism, as its collider is). */
export function queryShape(s: Shape): RAPIER.Shape {
  switch (s.kind) {
    case 'ball':
      return new RAPIER.Ball(s.r);
    case 'box':
      return new RAPIER.Cuboid(s.hx, s.hy, s.hz);
    case 'capsule':
      return new RAPIER.Capsule(s.halfHeight, s.r);
    case 'cylinder':
      return new RAPIER.ConvexPolyhedron(new Float32Array(cylinderPoints(s)), null);
    case 'hull':
      return new RAPIER.ConvexPolyhedron(new Float32Array(s.points), null);
  }
}

const v3 = (v: { x: number; y: number; z: number }): V3 => ({ x: v.x, y: v.y, z: v.z });

export class WorldQueries {
  constructor(
    private readonly physics: PhysicsWorld,
    private readonly entities: QueryEntities,
  ) {}

  /** The first collider along the ray from `from` along `dir` (normalised here) within `maxToi` m; toi in m. */
  castRay(from: V3, dir: V3, maxToi: number, f: QueryFilter): Hit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 0)) return null;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    const hit = this.physics.rapier.castRayAndGetNormal(new RAPIER.Ray(v3(from), d), maxToi, true, this.flags(f), undefined, undefined, undefined, this.predicate(f));
    if (!hit) return null;
    const owner = this.physics.ownerOf(hit.collider.handle);
    if (!owner) return null;
    const t = hit.timeOfImpact;
    return { owner, toi: t, point: { x: from.x + d.x * t, y: from.y + d.y * t, z: from.z + d.z * t }, normal: v3(hit.normal) };
  }

  /**
   * The first collider a shape at `from` meets moving with velocity `vel` within time `maxToi` (toi in the units of
   * `vel`: seconds for m/s). point and normal are the struck collider's (world space).
   */
  castShape(shape: Shape, from: Pose3, vel: V3, maxToi: number, f: QueryFilter): Hit | null {
    const hit = this.physics.rapier.castShape(v3(from.p), from.q, v3(vel), queryShape(shape), 0, maxToi, true, this.flags(f), undefined, undefined, undefined, this.predicate(f));
    if (!hit) return null;
    const owner = this.physics.ownerOf(hit.collider.handle);
    if (!owner) return null;
    return { owner, toi: hit.time_of_impact, point: v3(hit.witness1), normal: v3(hit.normal1) };
  }

  /** Every owner whose colliders overlap the shape at `at`, once each, sorted in owner order. */
  overlaps(shape: Shape, at: Pose3, f: QueryFilter): Owner[] {
    const found = new Map<string, Owner>();
    this.physics.rapier.intersectionsWithShape(
      v3(at.p),
      at.q,
      queryShape(shape),
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
