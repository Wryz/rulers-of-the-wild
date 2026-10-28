// Client-side targeting (docs/M1-DESIGN.md §10.7, SPEC:406): candidates are the entities drawn whose surface (the box
// bounding their shape at their pose) is within VERB_TUNING.targetRadiusM of the player's chest, plus the tied ropes
// drawn (segments between their anchors); the best is the smallest angle between the aim ray (the camera's centre
// ray; the player's facing in the fight camera) and the direction to its nearest point, inside
// VERB_UI_TUNING.targetConeDeg (fightTargetConeDeg in the fight camera). Tab / Shift+Tab / D-pad ←→ cycle the
// candidates in score order (the cycled one is kept while the set is unchanged). No entity, and the ray meets the
// terrain within reach → a ground target (dig, place). Excluded: what the player holds, carries or wears.
//
// The client computes this from what it draws (records only, never a Rapier handle); the sim re-validates every
// command. The verb UI passes `accept` (the sim's own focus check, validateVerb) so a target the sim would refuse is
// never offered.
import { Vector3 } from 'three';
import { type Entity, type Fighter, ownedBy, type Shape, VERB_TUNING, type World, WORLD_TUNING } from '@wild/sim';
import { type TargetRef, VERB_UI_TUNING } from './verbInput';

/** The ray the player aims along: the camera's centre ray (follow camera) or the player's facing (fight camera). */
export interface AimRay {
  origin: Vector3;
  /** Unit. */
  dir: Vector3;
  /** True in the fight camera (the wider cone). */
  fight: boolean;
}

/** One candidate: what it is, how far off the ray it lies (rad), and its key (`e:<id>`). */
export interface Candidate {
  ref: TargetRef;
  angle: number;
  id: number;
  key: string;
}

/** The states of an entity that is drawn where it lies (held, stowed, flying and tied ones are drawn elsewhere). */
const LYING: ReadonlySet<Entity['state']> = new Set(['free', 'anchored', 'fixed']);
const DEG = Math.PI / 180;

/** The local box bounding a shape (half-extents and centre; prisms, capsules and balls about the origin). */
export function shapeBox(s: Shape): { min: Vector3; max: Vector3 } {
  switch (s.kind) {
    case 'ball':
      return { min: new Vector3(-s.r, -s.r, -s.r), max: new Vector3(s.r, s.r, s.r) };
    case 'box':
      return { min: new Vector3(-s.hx, -s.hy, -s.hz), max: new Vector3(s.hx, s.hy, s.hz) };
    case 'capsule':
      return { min: new Vector3(-s.r, -s.halfHeight - s.r, -s.r), max: new Vector3(s.r, s.halfHeight + s.r, s.r) };
    case 'cylinder':
      return { min: new Vector3(-s.r, -s.halfHeight, -s.r), max: new Vector3(s.r, s.halfHeight, s.r) };
    case 'hull': {
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i + 2 < s.points.length; i += 3) {
        min.min(_v.set(s.points[i], s.points[i + 1], s.points[i + 2]));
        max.max(_v);
      }
      return min.x <= max.x ? { min, max } : { min: new Vector3(), max: new Vector3() };
    }
  }
}

const _v = new Vector3();

/** v rotated by the quaternion (x, y, z, w), in place. */
function rotate(v: Vector3, q: { x: number; y: number; z: number; w: number }): Vector3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v.set(v.x + q.w * tx + (q.y * tz - q.z * ty), v.y + q.w * ty + (q.z * tx - q.x * tz), v.z + q.w * tz + (q.x * ty - q.y * tx));
}

/** An entity's bounding box at its pose: world point → local, local → world, and the clamp into the box. */
class Obb {
  private readonly box: { min: Vector3; max: Vector3 };
  private readonly p: Vector3;
  private readonly q: { x: number; y: number; z: number; w: number };
  private readonly qi: { x: number; y: number; z: number; w: number };

  constructor(e: Entity) {
    this.box = shapeBox(e.shape);
    this.p = new Vector3(e.pose.p.x, e.pose.p.y, e.pose.p.z);
    this.q = { ...e.pose.q };
    this.qi = { x: -e.pose.q.x, y: -e.pose.q.y, z: -e.pose.q.z, w: e.pose.q.w };
  }

  /** The box's point nearest the world point `w` (world). */
  nearest(w: Vector3, out = new Vector3()): Vector3 {
    rotate(out.copy(w).sub(this.p), this.qi).clamp(this.box.min, this.box.max);
    return rotate(out, this.q).add(this.p);
  }
}

/** The point of a convex set (`nearest`: its closest-point map) nearest the ray, by alternating projection. */
function nearestToRay(nearest: (w: Vector3, out: Vector3) => Vector3, ray: AimRay, out: Vector3): Vector3 {
  const q = new Vector3();
  nearest(ray.origin, out);
  for (let i = 0; i < 12; i++) {
    const t = Math.max(0, q.copy(out).sub(ray.origin).dot(ray.dir));
    q.copy(ray.origin).addScaledVector(ray.dir, t);
    nearest(q, out);
  }
  return out;
}

/** The point of segment a-b nearest `w`. */
function onSegment(a: Vector3, b: Vector3, w: Vector3, out: Vector3): Vector3 {
  const ab = _v.copy(b).sub(a);
  const l2 = ab.lengthSq();
  const t = l2 > 0 ? Math.max(0, Math.min(1, out.copy(w).sub(a).dot(ab) / l2)) : 0;
  return out.copy(a).addScaledVector(ab, t);
}

/** The angle (rad) between the ray and the direction from its origin to `p` (0 for a point at the origin). */
function angleOff(ray: AimRay, p: Vector3): number {
  const d = _v.copy(p).sub(ray.origin);
  const l = d.length();
  if (!(l > 1e-9)) return 0;
  return Math.acos(Math.max(-1, Math.min(1, d.dot(ray.dir) / l)));
}

/** The player's chest point (§5.0: pos + chestHeightM × scale up), from which reach is measured. */
export function chestOf(f: Fighter, out = new Vector3()): Vector3 {
  return out.set(f.pos.x, f.pos.y + WORLD_TUNING.chestHeightM * f.scale, f.pos.z);
}

/**
 * Where the ray first meets the terrain within `maxM` (stepped then bisected on heightAt), or null: a ray starting
 * under the ground meets it at once.
 */
export function rayTerrain(world: Pick<World, 'terrain'>, ray: { origin: Vector3; dir: Vector3 }, maxM: number, stepM = VERB_UI_TUNING.aimTerrainStepM): Vector3 | null {
  const h = (t: number) => {
    const x = ray.origin.x + ray.dir.x * t;
    const z = ray.origin.z + ray.dir.z * t;
    return ray.origin.y + ray.dir.y * t - world.terrain.heightAt(x, z);
  };
  if (h(0) <= 0) return ray.origin.clone();
  let lo = 0;
  for (let t = stepM; t <= maxM + 1e-9; t += stepM) {
    if (h(t) <= 0) {
      let hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (h(mid) > 0) lo = mid;
        else hi = mid;
      }
      return ray.origin.clone().addScaledVector(ray.dir, hi);
    }
    lo = t;
  }
  return null;
}

export class Targeting {
  /** This frame's candidates in score order (the accepted ones). */
  candidates: readonly Candidate[] = [];
  private current_: TargetRef | null = null;
  /** The candidate cycled to (its key), kept while the set is unchanged. */
  private cycled: string | null = null;
  private setKey = '';

  /** The target picked this frame (null: nothing in reach). */
  get current(): TargetRef | null {
    return this.current_;
  }

  /**
   * The best target this frame (null: nothing in reach). `accept` (default: everything) is the sim's check of a focus
   * on the target: a candidate it refuses is left out.
   */
  pick(world: World, player: Fighter, ray: AimRay, accept: (ref: TargetRef) => boolean = () => true): TargetRef | null {
    const chest = chestOf(player);
    const reach = VERB_TUNING.targetRadiusM;
    const cone = (ray.fight ? VERB_UI_TUNING.fightTargetConeDeg : VERB_UI_TUNING.targetConeDeg) * DEG;
    const out: Candidate[] = [];
    const near = new Vector3();
    for (const e of world.entities.all()) {
      if (!LYING.has(e.state) || ownedBy(world, player, e.id)) continue;
      const box = new Obb(e);
      if (box.nearest(chest, near).distanceTo(chest) > reach) continue;
      const at = nearestToRay((w, o) => box.nearest(w, o), ray, new Vector3());
      const angle = angleOff(ray, at);
      if (angle <= cone) out.push({ ref: { kind: 'entity', id: e.id, at }, angle, id: e.id, key: `e:${e.id}` });
    }
    // Tied ropes, drawn as segments between their anchors (one candidate per rope entity: its nearest segment).
    const ropes = new Map<number, Candidate>();
    const a = new Vector3();
    const b = new Vector3();
    for (const v of world.joints.view()) {
      const rope = world.joints.get(v.joint)?.rope?.entity;
      if (!rope || ownedBy(world, player, rope)) continue;
      a.set(v.a.x, v.a.y, v.a.z);
      b.set(v.b.x, v.b.y, v.b.z);
      if (onSegment(a, b, chest, near).distanceTo(chest) > reach) continue;
      const at = nearestToRay((w, o) => onSegment(a, b, w, o), ray, new Vector3());
      const angle = angleOff(ray, at);
      const prev = ropes.get(rope);
      if (angle <= cone && (!prev || angle < prev.angle)) ropes.set(rope, { ref: { kind: 'entity', id: rope, at }, angle, id: rope, key: `e:${rope}` });
    }
    for (const c of ropes.values()) if (!out.some((o) => o.id === c.id)) out.push(c);
    out.sort((x, y) => x.angle - y.angle || x.id - y.id);
    const accepted = out.filter((c) => accept(c.ref));
    this.candidates = accepted;

    const setKey = accepted
      .map((c) => c.id)
      .sort((x, y) => x - y)
      .join(',');
    if (setKey !== this.setKey) this.cycled = null;
    this.setKey = setKey;
    if (accepted.length > 0) {
      const kept = this.cycled === null ? undefined : accepted.find((c) => c.key === this.cycled);
      if (!kept) this.cycled = null;
      this.current_ = (kept ?? accepted[0]).ref;
      return this.current_;
    }

    // The ground, where the ray meets the terrain within reach of the chest.
    this.cycled = null;
    const span = ray.origin.distanceTo(chest) + reach;
    const hit = rayTerrain(world, ray, span);
    if (hit && hit.distanceTo(chest) <= reach) {
      const ref: TargetRef = { kind: 'ground', at: hit };
      if (accept(ref)) {
        this.current_ = ref;
        return ref;
      }
    }
    this.current_ = null;
    return null;
  }

  /** Tab / Shift+Tab: the next or previous candidate in score order (kept while the set is unchanged). */
  cycle(step: number): TargetRef | null {
    const c = this.candidates;
    if (c.length === 0 || step === 0) return this.current_;
    const at = this.cycled === null ? 0 : Math.max(0, c.findIndex((x) => x.key === this.cycled));
    const n = c.length;
    const next = c[(((at + step) % n) + n) % n];
    this.cycled = next.key;
    this.current_ = next.ref;
    return next.ref;
  }
}
