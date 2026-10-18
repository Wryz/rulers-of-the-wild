// Place (docs/M1-DESIGN.md §5.7, SPEC:238, 410): set what the hands carry or wield down lying, upright or sloped; a
// point-up stake (or anything with `drive: 1`) set upright or sloped on soft ground is driven stakeAnchorDepthM in and
// anchored (D-19); support, reach and clearance checks; releasedBy on place (§4.3). `planPlace` is the whole rule, shared
// by the verb (at the command, when it starts and when it lands, RF-15) and the client's ghost (§10.7).
//
// Rule 1: nothing here knows a stake, a prop or a cover. A placed thing is posed from the command and its own geometry
// (the end with the sharpest point up, else the heavier end down, D-49), rests where the casts say it rests, and is
// anchored only by the properties of the ground under its lower end (soft: hardness ≤ softGroundMaxHardness).
//
// The pose (`pitch` 0..64 in 1/256 turn above horizontal in the vertical plane of `yaw`; `at` the centre of the held
// object's long axis, whole cm): the axis points at `yaw` and up at `pitch`, toward the end that goes up; the held entity's
// thinnest local axis across the long one faces down (a prism lies on a flat face, as LYING_ALONG_X lays it). Then:
// - Reach: the placed shape's nearest point within placeReachM horizontally and placeReachVertM vertically of the
//   player's body (feet to chest), at the commanded pose.
// - The lift (every downward ray and cast below starts this high above the commanded pose, so a client estimate that
//   sinks the object a little into its support still finds it): supportProbeUpM (§5.7's "from 0.5 m above"), but never
//   higher than the room over the commanded pose, so nothing is found on top of an overhang the object is put under
//   (rule 3: a stick set under a log goes under it, as its ghost shows). The room is a cast of the shape straight up,
//   entities only (the terrain is a heightfield: none of it is over anything). An entity the commanded pose already
//   overlaps is a support it sinks into when the least-penetration direction lifts it out (Rapier's normal of the struck
//   collider there points up) and is looked past; one it overlaps from beneath or beside leaves no room. The casts down
//   look past what they start in when it is over or beside them (the clearance test at the resting pose decides whether
//   it is in the way: an object put up into a beam with ground under it is set down under the beam, one already on the
//   ground is 'blocked'), and stop at what they start in when it is under them ('blocked': sunk deeper than the lift).
// - Lying: the shape is cast straight down from the lift by up to the lift + placeSupportM and set where the cast stops,
//   placeDropM above it: it rests on whatever is under it, both ends of a branch across a trench included.
//   INTERPRETATION (§5.7 step 2 "lying: from both ends"): one cast of the whole shape instead of a ray from each end, so
//   a wide bundle laid across sparse bearers rests on them (rays from its two ends would pass between the bearers); a
//   shape with nothing under it within reach is refused 'noSupport'.
// - Upright: a downward ray from supportProbeUpM above the lower end (within its own length plus the room over it)
//   finds the support within placeSupportM below the lower end ('noSupport' otherwise). Driven: the lower end goes
//   stakeAnchorDepthM under that support; else the shape is set where a downward cast from the lift stops, placeDropM
//   above it (on the support, or on whatever else is under its base first).
// - Sloped: the lower end's support as upright (a ray under its underside corner, from the lift); then the part of the
//   held object beyond its centre of mass along its axis (shrunk by placeShrinkM) is cast straight down from its own lift
//   by up to the lift + placeSupportM, terrain included: it must meet a support there (the top of a prop, a rock, a log,
//   a pit's rim or a bank), else 'noSupport'; only that part is cast, so the ground under or beside the lower end is
//   never taken for it, and a support nearer the lower end than the centre of mass (which would see-saw it off) is never
//   found. The object then rests on its lower end and that support: its lower-end underside corner is pinned placeDropM
//   above the lower support and the pitch is the one whose underside plane passes placeDropM above the support point
//   (the command's quantised pitch is the client's estimate; the sim's is exact); that pose must keep the support beyond
//   the centre of mass and pass through no ground ('blocked'). INTERPRETATIONS: §5.7 casts "the shape … from the
//   commanded pose by up to 0.6 m"; here the part beyond the centre of mass is cast, from the lift. The centre-of-mass
//   condition is added by rule 3 (a lean that would see-saw off is not offered as resting). A sloped placement that is
//   driven (an angled stake) needs no second support: it is anchored.
// - Clearance: every member, shrunk by placeShrinkM, overlaps no entity (other than its supports) and no fighter's
//   damage colliders, the placer's own excepted (his hands are at it), and no fighter's capsule, the placer's included
//   (a log through his own body is refused 'blocked'). Terrain is not tested (a driven end is in it; a lying or upright
//   object is set where a cast that meets the terrain stops, and a sloped one is tested for it above).
//
// The work action (§5.7 step 5): placeFramesLying (24) frames, or placeFramesDriven (60) when driven, pose `workLow`;
// the player turns to and steps in toward the placed shape's nearest point; the object is set down at actFrac of the
// action, where every check runs again (RF-15) and the plan is made afresh from the world as it is then.
import type { TrackKey } from '../../body/animator';
import { getPose } from '../../body/poses';
import { COMMAND_STEPS, type VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { defineTuning } from '../../tuning/registry';
import { propertyAtLeast } from '../materials';
import { cylinderPoints, GEOM_EPS, principalAxis, rapierHullOk } from '../shapes';
import type { Entity, Owner, Pose3, Quat, RefuseReason, Shape, V3 } from '../types';
import type { World } from '../world';
import { letGo } from './hands';
import { chestPoint, cmdPoint, registerVerb, verbEvent, type VerbHandler, type WorkSpec } from './targets';
import { heldMembers, heldShape, type HeldShape, isSoftGroundEntity, isSoftTerrain, verbGeom } from './tools';
import { TOOL_TUNING, VERB_TUNING } from './tuning';

/**
 * Place's own starting values. DEVIATION (P17): §13.0 adds no tuning table after P05, but VERB_TUNING is P14's file and
 * §9.1 has no row for these two values, which §5.7 gives only in prose (the 0.5 m) or not at all; CLAUDE.md puts every
 * starting value in a live tuning table, so they live here (as P06's ENTITY_TUNING and P07's FACTORY_TUNING do) until
 * a follow-up moves them into VERB_TUNING.
 */
export const PLACE_TUNING = defineTuning(
  'PLACE_TUNING',
  'Verbs › place',
  {
    supportProbeUpM: 0.5,
    actFrac: 0.75,
  },
  {
    supportProbeUpM: {
      unit: 'm',
      source: 'NEW: §5.7 step 2 ("a downward ray from 0.5 m above the lower end"); the place casts start this high too, or as high as the room over the commanded pose allows',
      min: 0,
    },
    actFrac: { unit: '× the work action', source: 'NEW: §5.7 step 5 (the object is set down at the end of the push down, then the body rises)', min: 0, max: 1 },
  },
);

/** How the object is set down (§5.7: pitch 0 lying, 64 upright, anything between sloped). */
export type PlaceMode = 'lying' | 'upright' | 'sloped';

/** What a valid place command does, as planned from the world now. */
export interface PlacePlan {
  mode: PlaceMode;
  /** The held entity's pose once set down (its members keep their place relative to it). */
  pose: Pose3;
  /** The long axis's tilt above horizontal, rad: the command's, except sloped (the pitch that rests on both supports). */
  pitch: number;
  /** Driven stakeAnchorDepthM into soft ground and anchored (D-19). */
  driven: boolean;
  /** The member driven in and anchored (the longest one, whose axis is the held object's), or null. */
  stake: number | null;
  /** What it rests on (the lower end's support first; sloped: then the second support, possibly the terrain twice). */
  supports: Owner[];
  /** The placed shape's point nearest the player at the commanded pose: the work action turns and steps in toward it. */
  faceAt: V3;
}

export type PlaceVerdict = { ok: true; plan: PlacePlan } | { ok: false; reason: RefuseReason };

// ---------------------------------------------------------------------------
// Geometry (records only)
// ---------------------------------------------------------------------------

const { add, sub, scale, dot, cross, len, unit, rotate, conj, mulQuat, quatFromBasis, perpendicular, pointToWorld, compose, relative } = verbGeom;
const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
const DOWN: Readonly<V3> = Object.freeze({ x: 0, y: -1, z: 0 });
const IDENTITY: Readonly<Pose3> = Object.freeze({ p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } });
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const lift = (p: Pose3, dy: number): Pose3 => ({ p: { x: p.p.x, y: p.p.y + dy, z: p.p.z }, q: { ...p.q } });
/**
 * m: the gap the lift keeps under whatever is over the commanded pose, so a cast down from it doesn't start touching that.
 * A numerical device of the casts (Rapier's single-precision times of impact), not a starting value: any few-ulp margin
 * works, and a millimetre is below anything a player sees.
 */
const LIFT_GAP_M = 1e-3;
/**
 * The upward component a struck collider's normal needs, at a cast that starts in it, for it to count as under the shape
 * (a support the commanded pose sinks into). A numerical device: Rapier's normals are single precision, so a sideways
 * normal can carry ±1e-7 of y.
 */
const SUPPORT_NORMAL_MIN_Y = 1e-6;
/** m: a cut piece thinner than this across the cut is no solid a cast can use (a vertex grazing the plane). Numerical. */
const PIECE_MIN_M = 1e-3;

/** The vertices bounding a shape in its local frame (a round shape: its extreme points along each axis). */
function shapeVertices(s: Shape): V3[] {
  const out: V3[] = [];
  const flat = (a: readonly number[]): void => {
    for (let i = 0; i + 2 < a.length; i += 3) out.push(v(a[i], a[i + 1], a[i + 2]));
  };
  switch (s.kind) {
    case 'cylinder':
      flat(cylinderPoints(s));
      break;
    case 'hull':
      flat(s.points);
      break;
    case 'box':
      for (const x of [-s.hx, s.hx]) for (const y of [-s.hy, s.hy]) for (const z of [-s.hz, s.hz]) out.push(v(x, y, z));
      break;
    case 'ball':
      for (const d of [v(1, 0, 0), v(-1, 0, 0), v(0, 1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1)]) out.push(scale(d, s.r));
      break;
    case 'capsule':
      out.push(v(0, s.halfHeight + s.r, 0), v(0, -s.halfHeight - s.r, 0));
      for (const y of [-s.halfHeight, s.halfHeight]) for (const d of [v(1, 0, 0), v(-1, 0, 0), v(0, 0, 1), v(0, 0, -1)]) out.push(add(v(0, y, 0), scale(d, s.r)));
      break;
  }
  return out;
}

/**
 * The shape made `m` smaller all round (the clearance test's and the sloped cast's placeShrinkM): a prism, box, ball or
 * capsule loses m from every half-extent; a hull's vertices move m toward its centroid. Never below a millimetre.
 *
 * SIM-fix3: m is clamped to placeShrinkMaxFrac of the shape's smallest half-extent (a cylinder's r, a box's least
 * half-side, a hull's least half-extent about its centroid), so a thin thing keeps its proportions instead of becoming a
 * needle: an r 0.02 m × 8 m bearer shrunk the full 0.02 m was an r 1 mm prism Rapier can't build as a hull ("expected
 * instance of p" from every query with it). Should the shrunk prism or hull still be one Rapier rejects (rapierHullOk),
 * the shape comes back unshrunk: its own collider is that hull, so Rapier builds it.
 */
export function shrinkShape(s: Shape, m: number): Shape {
  const min = 1e-3;
  const room = (smallest: number): number => Math.max(0, Math.min(m, VERB_TUNING.placeShrinkMaxFrac * smallest));
  const less = (x: number, k: number): number => Math.max(min, x - k);
  let out: Shape;
  switch (s.kind) {
    case 'cylinder': {
      const k = room(Math.min(s.r, s.halfHeight));
      out = { kind: 'cylinder', halfHeight: less(s.halfHeight, k), r: less(s.r, k), sides: s.sides };
      break;
    }
    case 'box': {
      const k = room(Math.min(s.hx, s.hy, s.hz));
      return { kind: 'box', hx: less(s.hx, k), hy: less(s.hy, k), hz: less(s.hz, k) };
    }
    case 'ball':
      return { kind: 'ball', r: less(s.r, room(s.r)) };
    case 'capsule': {
      const k = room(s.r);
      return { kind: 'capsule', halfHeight: Math.max(0, s.halfHeight - k), r: less(s.r, k) };
    }
    case 'hull': {
      const pts = shapeVertices(s);
      const c = scale(pts.reduce((a, p) => add(a, p), v(0, 0, 0)), 1 / Math.max(1, pts.length));
      let lo = v(Infinity, Infinity, Infinity);
      let hi = v(-Infinity, -Infinity, -Infinity);
      for (const p of pts) {
        lo = v(Math.min(lo.x, p.x), Math.min(lo.y, p.y), Math.min(lo.z, p.z));
        hi = v(Math.max(hi.x, p.x), Math.max(hi.y, p.y), Math.max(hi.z, p.z));
      }
      // The least half-extent of the local axis-aligned bounds. A hull thin along a diagonal (a sliver lying across
      // the axes) has fat bounds, so this overestimates its thin side and the clamp may let it shrink too far; the
      // rapierHullOk fallback below still catches a result Rapier can't build. Every M1 hull is a prism's or a
      // fracture's, built along its local axes.
      const k = pts.length ? room(Math.min(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) / 2) : 0;
      const flat: number[] = [];
      for (const p of pts) {
        const d = sub(p, c);
        const l = len(d);
        const f = l > GEOM_EPS ? Math.max(min / l, 1 - k / l) : 1;
        const q = add(c, scale(d, f));
        flat.push(q.x, q.y, q.z);
      }
      out = { kind: 'hull', points: flat };
      break;
    }
  }
  return rapierHullOk(out) ? out : s;
}

/** The point of segment a-b nearest p. */
function nearestOnSegment(a: V3, b: V3, p: V3): V3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, t));
}

// ---------------------------------------------------------------------------
// The held object as Place sees it
// ---------------------------------------------------------------------------

/** The held object's members, its geometry and the frame Place poses it by (all in the held entity's frame). */
interface Held {
  main: Entity;
  /** Every member and its pose in the main entity's frame (id order). */
  members: { e: Entity; rel: Pose3 }[];
  hs: HeldShape;
  /** Unit, along the long axis, toward the end that goes up (D-49: the sharpest point's end, else the lighter end). */
  up: V3;
  /** Unit, across the axis: the side that faces down (the main entity's thinnest local axis across the long one). */
  down: V3;
  /** A point at the up end (§5.0's predicate): a point-up stake, driven by default (SPEC:238). */
  pointUp: boolean;
  /** Every member's vertices. */
  verts: V3[];
  /** The ends of the long axis: the one that goes down and the one that goes up. */
  lowEnd: V3;
  highEnd: V3;
  /** The lower end's underside corner (sloped: it is pinned on the lower support), and the underside plane's offset. */
  corner: V3;
  /** The member whose axis is the held object's (the longest; ties the lowest id): the one driven in. */
  longest: number;
}

function heldOf(w: World, main: Entity): Held {
  const hs = heldShape(w, main.id);
  const members = heldMembers(w, main.id).map((id) => {
    const e = w.entities.get(id)!;
    return { e, rel: e === main ? IDENTITY : relative(main.pose, e.pose) };
  });
  const verts: V3[] = [];
  for (const m of members) for (const p of shapeVertices(m.e.shape)) verts.push(pointToWorld(m.rel, p));

  // Which end goes up (D-49): the end with the sharpest point (a point or an edge within headZoneM of it), else the
  // heavier end down. heldShape's axis already points at the heavier end of an object with no head (§5.0).
  const t = TOOL_TUNING;
  const L = hs.lengthM;
  let best: { end: 1 | -1; s: number } | null = null;
  for (const sp of hs.sharpPoints) {
    const along = dot(sub(sp.local, hs.centre), hs.axis);
    const nearHi = Math.abs(along - L / 2) <= t.headZoneM;
    const nearLo = Math.abs(along + L / 2) <= t.headZoneM;
    if (!nearHi && !nearLo) continue;
    const end: 1 | -1 = nearHi && nearLo ? (along >= 0 ? 1 : -1) : nearHi ? 1 : -1;
    if (!best || sp.sharpness > best.s || (sp.sharpness === best.s && end > best.end)) best = { end, s: sp.sharpness };
  }
  const up = scale(hs.axis, best ? best.end : -1);
  let pointUp = false;
  for (const sp of hs.sharpPoints) {
    const along = dot(sub(sp.local, hs.centre), up);
    if (Math.abs(along - L / 2) > t.headZoneM) continue;
    if (dot(sp.dir, up) >= t.pointAxisCos && propertyAtLeast(sp.sharpness, t.pointMinSharpness)) pointUp = true;
  }

  // The side that faces down: the main entity's local axis least along `up`, thinnest first (a prism's x: a flat face
  // of a 6- or 8-gon, as LYING_ALONG_X lays it), made square to `up`.
  const own = shapeVertices(main.shape);
  const ext = [0, 0, 0];
  for (const p of own) {
    ext[0] = Math.max(ext[0], Math.abs(p.x));
    ext[1] = Math.max(ext[1], Math.abs(p.y));
    ext[2] = Math.max(ext[2], Math.abs(p.z));
  }
  const axes = [v(1, 0, 0), v(0, 1, 0), v(0, 0, 1)];
  let pick = -1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dot(axes[k], up)) > 0.9) continue;
    if (pick < 0 || ext[k] < ext[pick] - GEOM_EPS) pick = k;
  }
  const raw = pick >= 0 ? axes[pick] : perpendicular(up);
  const sq = sub(raw, scale(up, dot(raw, up)));
  const down = len(sq) > GEOM_EPS ? unit(sq) : perpendicular(up);

  const lowEnd = sub(hs.centre, scale(up, L / 2));
  const highEnd = add(hs.centre, scale(up, L / 2));
  // The underside corner at the lower end: of the vertices on the underside plane (furthest along `down`), the one
  // nearest the lower end.
  let rho = -Infinity;
  for (const p of verts) rho = Math.max(rho, dot(p, down));
  const tol = 1e-6 + 1e-9 * Math.max(1, L);
  let corner = verts[0];
  let cornerAlong = Infinity;
  for (const p of verts) {
    if (dot(p, down) < rho - tol) continue;
    const a = dot(p, up);
    if (a < cornerAlong) {
      cornerAlong = a;
      corner = p;
    }
  }

  // The longest member, chosen as heldShape chooses it.
  let longest = members[0].e;
  let longestLen = principalAxis(longest.shape);
  for (const m of members) {
    const a = principalAxis(m.e.shape);
    if (a.max - a.min > longestLen.max - longestLen.min + GEOM_EPS) {
      longest = m.e;
      longestLen = a;
    }
  }
  return { main, members, hs, up, down, pointUp, verts, lowEnd, highEnd, corner, longest: longest.id };
}

/**
 * The held entity's rotation for a long axis at `yaw` and `pitch` (rad): `up` along the axis (cos p·h + sin p·ŷ, h the
 * horizontal unit at yaw, from +z toward +x), `down` square to it in the same vertical plane, pointing down.
 */
function orientation(o: Held, yaw: number, pitch: number): Quat {
  const h = v(Math.sin(yaw), 0, Math.cos(yaw));
  const yW = add(scale(h, Math.cos(pitch)), scale(UP, Math.sin(pitch)));
  const xW = sub(scale(h, Math.sin(pitch)), scale(UP, Math.cos(pitch)));
  const zW = cross(xW, yW);
  const xL = o.down;
  const yL = o.up;
  const zL = cross(xL, yL);
  return mulQuat(quatFromBasis(xW, yW, zW), conj(quatFromBasis(xL, yL, zL)));
}

/** Every member's world pose for the held entity at `pose`. */
const memberPoses = (o: Held, pose: Pose3): { e: Entity; pose: Pose3 }[] => o.members.map((m) => ({ e: m.e, pose: compose(pose, m.rel) }));

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Is the support soft ground (§5.0: terrain or an entity whose material's hardness ≤ softGroundMaxHardness)? */
function softSupport(w: World, o: Owner): boolean {
  if (o.kind === 'terrain') return isSoftTerrain();
  if (o.kind !== 'entity') return false;
  const e = w.entities.get(o.id);
  return !!e && isSoftGroundEntity(e);
}

/**
 * The support under (x, z) below height `fromY` (§5.7 step 2): a downward ray from `up` (≤ supportProbeUpM) above it
 * finds a surface within placeSupportM below it; an entity the ray starts inside is an obstacle and is looked past.
 * Null: none.
 */
function supportBelow(w: World, x: number, z: number, fromY: number, up: number, exclude: readonly number[]): { y: number; owner: Owner } | null {
  const start = fromY + up;
  // A lower end deeper than that under the ground has no support it could be set on.
  if (start < w.terrain.heightAt(x, z)) return null;
  const skip = [...exclude];
  for (;;) {
    const hit = w.queries.castRay(v(x, start, z), DOWN, up + VERB_TUNING.placeSupportM, { terrain: true, entities: 'all', exclude: { entities: skip } });
    if (!hit) return null;
    if (hit.toi <= 0 && hit.owner.kind === 'entity') {
      skip.push(hit.owner.id);
      continue;
    }
    return { y: hit.point.y, owner: hit.owner };
  }
}

/** A convex piece of the held object and its pose in the held entity's frame (a member, or the part of one past a cut). */
interface Part {
  shape: Shape;
  rel: Pose3;
}

/** Every member, shrunk by `shrink`. */
const wholeParts = (o: Held, shrink: number): Part[] => o.members.map((m) => ({ shape: shrink > 0 ? shrinkShape(m.e.shape, shrink) : m.e.shape, rel: m.rel }));

/**
 * The held object (every member shrunk by `shrink`) cut by the plane through `origin` square to `n` (the held entity's
 * frame), the side n points to: a member wholly on it is kept as it is; one the plane crosses becomes the hull of its
 * vertices on that side and of the points where the segments between its vertices on either side cross the plane (a
 * superset of the section's corners, so the hull is the cut piece). A round member is cut as the polytope of its extreme
 * points (no M1 entity is round).
 */
function partsBeyond(o: Held, shrink: number, origin: V3, n: V3): Part[] {
  const out: Part[] = [];
  for (const m of o.members) {
    const shape = shrink > 0 ? shrinkShape(m.e.shape, shrink) : m.e.shape;
    const pts = shapeVertices(shape).map((p) => pointToWorld(m.rel, p));
    const s = pts.map((p) => dot(sub(p, origin), n));
    const far = Math.max(...s);
    if (!(far >= PIECE_MIN_M)) continue;
    if (Math.min(...s) >= 0) {
      out.push({ shape, rel: m.rel });
      continue;
    }
    const cut: V3[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (s[i] < 0) continue;
      cut.push(pts[i]);
      for (let j = 0; j < pts.length; j++) {
        if (s[j] >= 0) continue;
        cut.push(add(pts[i], scale(sub(pts[j], pts[i]), s[i] / (s[i] - s[j]))));
      }
    }
    const c = scale(cut.reduce((a, p) => add(a, p), v(0, 0, 0)), 1 / cut.length);
    const points: number[] = [];
    for (const p of cut) points.push(p.x - c.x, p.y - c.y, p.z - c.z);
    out.push({ shape: { kind: 'hull', points }, rel: { p: c, q: { x: 0, y: 0, z: 0, w: 1 } } });
  }
  return out;
}

/**
 * Casts every part with the held entity at `from` along `dir` by up to `maxToi` m: the first thing met, or null. `toi`
 * 0: a part starts inside something (`normal`: the struck collider's, Rapier's least-penetration direction there).
 */
function castParts(w: World, parts: readonly Part[], from: Pose3, dir: V3, maxToi: number, terrain: boolean, exclude: readonly number[]): { toi: number; point: V3; normal: V3; owner: Owner } | null {
  let best: { toi: number; point: V3; normal: V3; owner: Owner } | null = null;
  for (const part of parts) {
    const hit = w.queries.castShape(part.shape, compose(from, part.rel), dir, maxToi, { terrain, entities: 'all', exclude: { entities: [...exclude] } });
    if (hit && (!best || hit.toi < best.toi)) best = { toi: hit.toi, point: hit.point, normal: hit.normal, owner: hit.owner };
  }
  return best;
}

/**
 * How high the casts start over the commanded pose `pose` (see the header): supportProbeUpM, or the room over it less
 * LIFT_GAP_M. The room is a cast of the parts straight up, entities only; an entity they already overlap is looked past
 * when its normal there points up (a support they sink into), and leaves no room otherwise.
 */
function liftOver(w: World, parts: readonly Part[], pose: Pose3, exclude: readonly number[]): number {
  const probe = PLACE_TUNING.supportProbeUpM;
  const skip = [...exclude];
  for (;;) {
    const hit = castParts(w, parts, pose, UP, probe, false, skip);
    if (!hit) return probe;
    if (hit.toi > 0) return Math.max(0, Math.min(probe, hit.toi - LIFT_GAP_M));
    if (hit.owner.kind === 'entity' && hit.normal.y > SUPPORT_NORMAL_MIN_Y) {
      skip.push(hit.owner.id);
      continue;
    }
    return 0;
  }
}

/**
 * Casts the parts straight down from `start` by up to `maxToi` m, terrain included: the first thing they come down on,
 * 'none', or 'blocked'. Something a part starts in is looked past when it is over or beside it (its normal there doesn't
 * point up; the clearance test at the resting pose decides whether it is in the way), and blocks the place when it is
 * under it (a support the commanded pose sinks into deeper than the lift, or the ground).
 */
function castDown(w: World, parts: readonly Part[], start: Pose3, maxToi: number, exclude: readonly number[]): { toi: number; point: V3; owner: Owner } | 'none' | 'blocked' {
  const skip = [...exclude];
  for (;;) {
    const hit = castParts(w, parts, start, DOWN, maxToi, true, skip);
    if (!hit) return 'none';
    if (hit.toi > 0) return hit;
    if (hit.owner.kind === 'entity' && !(hit.normal.y > SUPPORT_NORMAL_MIN_Y)) {
      skip.push(hit.owner.id);
      continue;
    }
    return 'blocked';
  }
}

/** Clearance (§5.7 step 3): no member, shrunk by placeShrinkM, overlaps an entity or a fighter at `pose`. */
function clearAt(w: World, f: Fighter, o: Held, pose: Pose3, exclude: readonly number[]): boolean {
  const shrink = VERB_TUNING.placeShrinkM;
  for (const m of memberPoses(o, pose)) {
    const shape = shrinkShape(m.e.shape, shrink);
    // Entities and other fighters' bodies (their damage colliders); the placer's hands are at the object.
    if (w.queries.overlaps(shape, m.pose, { terrain: false, entities: 'all', fighters: 'zones', exclude: { entities: [...exclude], fighters: [f.id] } }).length > 0) return false;
    // Every fighter's capsule, the placer's included.
    if (w.queries.overlaps(shape, m.pose, { terrain: false, entities: 'none', fighters: 'kcc' }).length > 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const no = (reason: RefuseReason): PlaceVerdict => ({ ok: false, reason });
const entityIds = (owners: readonly Owner[]): number[] => owners.flatMap((o) => (o.kind === 'entity' ? [o.id] : []));

/**
 * The whole of §5.7 for a `place` command, from the world as it is now (queries see the last physics step): the
 * hands, the command's fields, reach, support, the drive decision, the resting pose and clearance. Pure: changes nothing.
 */
export function planPlace(w: World, f: Fighter, cmd: VerbCommand): PlaceVerdict {
  const inv = f.inventory;
  if (!inv) return no('cantAct');
  const hands = inv.hands;
  if (!hands) return no('handsEmpty');
  if (hands.mode === 'drag') return no('dragging');
  if (hands.mode === 'ropeEnd') return no('ropeEnd');
  const main = w.entities.get(hands.entity);
  if (!main || main.state !== 'held') return no('handsEmpty');
  // The command's own fields (the client is never trusted).
  const quarter = COMMAND_STEPS / 4;
  const yawSteps = cmd.yaw ?? 0;
  const pitchSteps = cmd.pitch ?? 0;
  if (!cmd.at || !Number.isInteger(yawSteps) || !Number.isInteger(pitchSteps) || pitchSteps < 0 || pitchSteps > quarter) return no('noTarget');
  if (cmd.drive !== undefined && cmd.drive !== 0 && cmd.drive !== 1) return no('noTarget');
  const mode: PlaceMode = pitchSteps === 0 ? 'lying' : pitchSteps === quarter ? 'upright' : 'sloped';
  const yaw = (yawSteps / COMMAND_STEPS) * 2 * Math.PI;
  const pitch0 = (pitchSteps / COMMAND_STEPS) * 2 * Math.PI;

  const o = heldOf(w, main);
  const ids = o.members.map((m) => m.e.id);
  const q0 = orientation(o, yaw, pitch0);
  const at = cmdPoint(cmd.at);
  const pose0: Pose3 = { p: sub(at, rotate(q0, o.hs.centre)), q: q0 };

  // 1. Reach: the placed shape's nearest point, horizontally and vertically, from the player's body (feet to chest).
  const s = f.scale;
  const chest = chestPoint(f);
  const lo0 = pointToWorld(pose0, o.lowEnd);
  const hi0 = pointToWorld(pose0, o.highEnd);
  const axisNear = nearestOnSegment(lo0, hi0, chest);
  const r = o.hs.crossHalfM;
  const hd = Math.hypot(axisNear.x - f.pos.x, axisNear.z - f.pos.z);
  const vd = axisNear.y > chest.y ? axisNear.y - chest.y : axisNear.y < f.pos.y ? f.pos.y - axisNear.y : 0;
  if (hd - r > VERB_TUNING.placeReachM * s || vd - r > VERB_TUNING.placeReachVertM * s) return no('outOfReach');
  const toward = v(f.pos.x - axisNear.x, 0, f.pos.z - axisNear.z);
  const faceAt = len(toward) > r ? add(axisNear, scale(unit(toward), r)) : axisNear;

  const drop = VERB_TUNING.placeDropM;
  const probe = PLACE_TUNING.supportProbeUpM;
  const below = VERB_TUNING.placeSupportM;
  const depth = VERB_TUNING.stakeAnchorDepthM;
  const wantsDrive = mode !== 'lying' && (cmd.drive === 1 || (cmd.drive === undefined && o.pointUp)) && o.hs.lengthM > depth;
  // The whole object, and how high its casts start over the commanded pose (never over an overhang).
  const whole = wholeParts(o, 0);
  const up = liftOver(w, whole, pose0, ids);

  /** Set down where a downward cast of the whole shape from the lift stops, placeDropM above it. */
  const restOn = (lower: Owner | null): PlaceVerdict => {
    const start = lift(pose0, up);
    const hit = castDown(w, whole, start, up + below, ids);
    if (hit === 'none') return no('noSupport');
    if (hit === 'blocked') return no('blocked');
    const pose = lift(start, drop - hit.toi);
    const supports = lower ? [lower] : [];
    if (!lower || hit.owner.kind !== lower.kind || (hit.owner.kind === 'entity' && lower.kind === 'entity' && hit.owner.id !== lower.id)) supports.push(hit.owner);
    // Only what it comes down on is spared the clearance test: the lower end's ray, which may start inside the object's
    // own length, can meet the top of something the object passes through.
    if (!clearAt(w, f, o, pose, [...ids, ...entityIds([hit.owner])])) return no('blocked');
    return { ok: true, plan: { mode, pose, pitch: pitch0, driven: false, stake: null, supports, faceAt } };
  };

  /** Driven: the lower end goes stakeAnchorDepthM under the support where the axis meets it, along the axis. */
  const drive = (support: { y: number; owner: Owner }): PlaceVerdict => {
    const d = rotate(q0, o.up);
    const t = (support.y - lo0.y) / d.y;
    const target = sub(add(lo0, scale(d, t)), scale(d, depth));
    const pose: Pose3 = { p: add(pose0.p, sub(target, lo0)), q: q0 };
    if (!clearAt(w, f, o, pose, [...ids, ...entityIds([support.owner])])) return no('blocked');
    return { ok: true, plan: { mode, pose, pitch: pitch0, driven: true, stake: o.longest, supports: [support.owner], faceAt } };
  };

  if (mode === 'lying') return restOn(null);

  if (mode === 'upright') {
    // The ray runs down the object's own axis from at most its length plus the room over it.
    const lower = supportBelow(w, lo0.x, lo0.z, lo0.y, Math.min(probe, o.hs.lengthM + up), ids);
    if (!lower) return no('noSupport');
    if (wantsDrive && softSupport(w, lower.owner)) return drive(lower);
    return restOn(lower.owner);
  }

  // Sloped: the lower end's underside corner on its support.
  const k0 = pointToWorld(pose0, o.corner);
  const lower = supportBelow(w, k0.x, k0.z, k0.y, up, ids);
  if (!lower) return no('noSupport');
  if (wantsDrive && softSupport(w, lower.owner)) {
    const ground = supportBelow(w, lo0.x, lo0.z, lo0.y, up, ids) ?? lower;
    return drive(ground);
  }
  // A second support: the part beyond the centre of mass along the axis (shrunk) cast down from its own lift, terrain
  // included (only that part, so the ground at the lower end is never it).
  const upper = partsBeyond(o, VERB_TUNING.placeShrinkM, o.hs.com, o.up);
  const up2 = liftOver(w, upper, pose0, ids);
  const hit = castDown(w, upper, lift(pose0, up2), up2 + below, ids);
  if (hit === 'none') return no('noSupport');
  if (hit === 'blocked') return no('blocked');
  const h = v(Math.sin(yaw), 0, Math.cos(yaw));
  const kT = v(k0.x, lower.y + drop, k0.z);
  const cT = v(hit.point.x, hit.point.y + drop, hit.point.z);
  const dH = dot(sub(cT, kT), h);
  const dY = cT.y - kT.y;
  if (!(dH > GEOM_EPS) || !(dY > GEOM_EPS)) return no('noSupport');
  const pitch = Math.atan2(dY, dH);
  const q = orientation(o, yaw, pitch);
  const pose: Pose3 = { p: sub(kT, rotate(q, o.corner)), q };
  // The second support must hold it: beyond its centre of mass along the axis from the lower end.
  const d = rotate(q, o.up);
  const com = pointToWorld(pose, o.hs.com);
  if (dot(sub(cT, kT), d) < dot(sub(com, kT), d)) return no('noSupport');
  // Resting on those two, none of it is in the ground between them (a bank that bulges over the line from one to the other).
  const shrunk = wholeParts(o, VERB_TUNING.placeShrinkM);
  for (const part of shrunk) if (w.queries.overlaps(part.shape, compose(pose, part.rel), { terrain: true, entities: 'none' }).length > 0) return no('blocked');
  const supports = [lower.owner, hit.owner];
  if (!clearAt(w, f, o, pose, [...ids, ...entityIds(supports)])) return no('blocked');
  return { ok: true, plan: { mode, pose, pitch, driven: false, stake: null, supports, faceAt } };
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/** The work action's frames and the frame the object is set down at (§5.7 step 5). */
function placeFrames(driven: boolean): { frames: number; actAt: number } {
  const frames = Math.max(1, Math.round(driven ? VERB_TUNING.placeFramesDriven : VERB_TUNING.placeFramesLying));
  return { frames, actAt: Math.max(1, Math.min(frames, Math.round(frames * PLACE_TUNING.actFrac))) };
}

const place: VerbHandler = {
  verb: 'place',
  target: 'none',
  validate(w, f, cmd) {
    const r = planPlace(w, f, cmd);
    return r.ok ? null : r.reason;
  },
  start(w, f, cmd) {
    const r = planPlace(w, f, cmd);
    // checkVerb ran planPlace a moment ago on the same world; a refusal here can't happen, but nothing lands without a plan.
    if (!r.ok) return null;
    const { frames, actAt } = placeFrames(r.plan.driven);
    const low = getPose('workLow');
    const keys: TrackKey[] = [
      { f: actAt, pose: low, ease: 'inOut' },
      { f: frames, pose: getPose('guard'), ease: 'inOut' },
    ];
    const spec: WorkSpec = { frames, actAt, faceAt: r.plan.faceAt, keys };
    return spec;
  },
  land(w, f, cmd) {
    // Re-validated at actAt (completeWork): the plan is made afresh from the world as it is now.
    const r = planPlace(w, f, cmd);
    if (!r.ok) {
      verbEvent(w, f, 'place', false, r.reason);
      return;
    }
    const plan = r.plan;
    const main = f.inventory!.hands!.entity;
    letGo(w, f, { pose: plan.pose, lin: v(0, 0, 0), ang: v(0, 0, 0) });
    let placed = main;
    if (plan.driven && plan.stake !== null) {
      const stake = w.entities.get(plan.stake);
      if (stake) {
        w.entities.anchor(stake, VERB_TUNING.stakeAnchorDepthM);
        placed = stake.id;
      }
    }
    verbEvent(w, f, 'place', true, undefined, placed);
  },
};

registerVerb(place);

/** The tilt above horizontal of an entity's long axis, rad (tests and the dev panel read a placed thing's angle). */
export function axisPitch(e: Entity): number {
  const ax = principalAxis(e.shape);
  const d = rotate(e.pose.q, ax.dir);
  return Math.asin(Math.max(-1, Math.min(1, Math.abs(d.y))));
}
