// Tools from properties (docs/M1-DESIGN.md §1.5.10, §5.0, §5.2): a held object's geometry (the entity in the hands plus
// everything lash-joined to it), its tool class, the WeaponDef synthesised from it, its fresh chop energy, and the
// property predicates every verb asks.
//
// Rule 1 and AC-1: nothing here knows a tool. A class is read from mass, length, aspect and sharp points; materials are
// read only through their properties (hardness, maxSharpness, springiness, strength), never by id. That is how a
// knapped flint lashed across a stick's end becomes an axe (SPEC:247) with no recipe.
//
// The held object (§5.0): the entity in the hands plus every entity joined to it by a `lash` joint, at most
// VERB_TUNING.heldJoinDepth joints away. The rope a lashing is made of (JointRecord.rope) is the joint's material, not
// one of its anchors, so it is no member and its mass is not counted: the starter axe is its handle and its flint,
// 1.153 kg, the B lab's axe on which FELL_TUNING.refChopJ (339 J) was measured, so its fresh chop stays 339 J and a
// 30 cm trunk takes 15 chops (SPEC:882). With the 1 m vine lashing (0.188 kg) it would chop 0.0208 m deep.
//
// Frames: a HeldShape is given in the held (main) entity's local frame. Its axis is the longest member's principal
// axis; the head is the end carrying the object's best point or edge, the grip the other end.
import { createPlayer } from '../../sim/roster';
import { blowDamage } from '../../sim/combat';
import { IdCounter } from '../../sim/fighter';
import { DAMAGE_TUNING } from '../../sim/rules';
import { WEAPON_MOVES, WEAPONS, type WeaponDef } from '../../sim/weapons';
import { JOINT_TUNING } from '../joints';
import { isRopeLike, isSoftGround, isSpringy, MATERIALS, PROPERTY_EPS, propertyAtLeast, propertyAtMost, propertyMarginAtLeast } from '../materials';
import { cylinderPoints, GEOM_EPS, principalAxis } from '../shapes';
import { TERRAIN_TUNING } from '../terrain';
import type { Entity, Pose3, Quat, Shape, SharpPoint, V3 } from '../types';
import type { World } from '../world';
import { TOOL_TUNING, VERB_TUNING } from './tuning';

export type ToolClass = 'stick' | 'sharpStick' | 'spear' | 'stoneAxe' | 'longAxe' | 'cudgel' | 'stone' | 'flintBlade';

/** A sharp point of a held object in the held entity's frame, with what it is to the object (§5.0's predicates). */
export interface HeldFeature extends SharpPoint {
  /** The member it belongs to. */
  entity: number;
  /** Its member's material hardness (what it can cut, whether it digs). */
  hardness: number;
  /** A point at an end, or an edge (at an end of an elongated object; anywhere on a compact one). */
  kind: 'point' | 'edge';
  /** The end of the axis it is at: +1, −1, or 0 (a compact object's edge). */
  end: 1 | -1 | 0;
}

/**
 * A held object's geometry (§5.0): its members (the entity in the hands plus every lash-joined entity, depth ≤ 3), their
 * summed mass, the longest member's principal axis, the grip at the end opposite the head, and the union of sharp points
 * in that frame.
 */
export interface HeldShape {
  /** Id order; the held entity included. */
  members: number[];
  massKg: number;
  /** The longest member's principal length, m. */
  lengthM: number;
  /** Unit, in the held entity's frame, from the grip toward the head. */
  axis: V3;
  grip: V3;
  sharpPoints: SharpPoint[];
  /** The middle of the longest member's axis, held entity's frame. */
  centre: V3;
  /** The centre of mass (members' origins weighted by mass), held entity's frame. */
  com: V3;
  /** The farthest any member's surface lies from the axis line, m (the striking part's radius). */
  crossHalfM: number;
  /** The longest member's length ÷ its largest cross dimension (§5.0 elongated / compact). */
  aspect: number;
  /** The point or edge at the head, if the object has one (§5.0). */
  head: HeldFeature | null;
}

// ---------------------------------------------------------------------------
// Geometry helpers (records only; never a Rapier handle)
// ---------------------------------------------------------------------------

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a: V3, k: number): V3 => v(a.x * k, a.y * k, a.z * k);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
function unit(a: V3, fallback: V3 = v(0, 1, 0)): V3 {
  const l = len(a);
  return l > GEOM_EPS ? scale(a, 1 / l) : { ...fallback };
}
function rotate(q: Quat, p: V3): V3 {
  const tx = 2 * (q.y * p.z - q.z * p.y);
  const ty = 2 * (q.z * p.x - q.x * p.z);
  const tz = 2 * (q.x * p.y - q.y * p.x);
  return v(p.x + q.w * tx + (q.y * tz - q.z * ty), p.y + q.w * ty + (q.z * tx - q.x * tz), p.z + q.w * tz + (q.x * ty - q.y * tx));
}
const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function normQuat(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return l > 0 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : { x: 0, y: 0, z: 0, w: 1 };
}
/**
 * The rotation whose matrix has columns x, y, z (an orthonormal right-handed basis). Shepperd's method: r = √(1 + the
 * largest of the trace and the diagonal terms' combinations) is twice the largest component; the rest are the
 * off-diagonal sums and differences ÷ 2r.
 */
function quatFromBasis(x: V3, y: V3, z: V3): Quat {
  const m00 = x.x, m10 = x.y, m20 = x.z;
  const m01 = y.x, m11 = y.y, m21 = y.z;
  const m02 = z.x, m12 = z.y, m22 = z.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const r = Math.sqrt(1 + tr);
    const f = 0.5 / r;
    q = { w: 0.5 * r, x: (m21 - m12) * f, y: (m02 - m20) * f, z: (m10 - m01) * f };
  } else if (m00 > m11 && m00 > m22) {
    const r = Math.sqrt(1 + m00 - m11 - m22);
    const f = 0.5 / r;
    q = { w: (m21 - m12) * f, x: 0.5 * r, y: (m01 + m10) * f, z: (m02 + m20) * f };
  } else if (m11 > m22) {
    const r = Math.sqrt(1 + m11 - m00 - m22);
    const f = 0.5 / r;
    q = { w: (m02 - m20) * f, x: (m01 + m10) * f, y: 0.5 * r, z: (m12 + m21) * f };
  } else {
    const r = Math.sqrt(1 + m22 - m00 - m11);
    const f = 0.5 / r;
    q = { w: (m10 - m01) * f, x: (m02 + m20) * f, y: (m12 + m21) * f, z: 0.5 * r };
  }
  return normQuat(q);
}
/** A unit vector perpendicular to unit `a`, chosen deterministically (from the coordinate axis least along it). */
function perpendicular(a: V3): V3 {
  const ax = Math.abs(a.x), ay = Math.abs(a.y), az = Math.abs(a.z);
  const pick = ax <= ay && ax <= az ? v(1, 0, 0) : ay <= az ? v(0, 1, 0) : v(0, 0, 1);
  return unit(sub(pick, scale(a, dot(pick, a))));
}

/**
 * Small pose and vector helpers the verb modules share (records only). `compose(a, b)` is the pose b expressed in a's
 * frame put into the world (a ∘ b); `relative(a, b)` is b in a's frame (a⁻¹ ∘ b).
 */
export const verbGeom = {
  add,
  sub,
  scale,
  dot,
  cross,
  len,
  unit,
  rotate,
  conj,
  mulQuat,
  quatFromBasis,
  perpendicular,
  pointToWorld: (pose: Pose3, local: V3): V3 => add(pose.p, rotate(pose.q, local)),
  pointToLocal: (pose: Pose3, world: V3): V3 => rotate(conj(pose.q), sub(world, pose.p)),
  dirToWorld: (pose: Pose3, local: V3): V3 => rotate(pose.q, local),
  dirToLocal: (pose: Pose3, world: V3): V3 => rotate(conj(pose.q), world),
  compose: (a: Pose3, b: Pose3): Pose3 => ({ p: add(a.p, rotate(a.q, b.p)), q: normQuat(mulQuat(a.q, b.q)) }),
  relative: (a: Pose3, b: Pose3): Pose3 => ({ p: rotate(conj(a.q), sub(b.p, a.p)), q: normQuat(mulQuat(conj(a.q), b.q)) }),
};

/** The vertices that bound a shape in its local frame (a round shape: the extreme points along each axis). */
function shapePoints(s: Shape): V3[] {
  const out: V3[] = [];
  const flat = (a: readonly number[]) => {
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

// ---------------------------------------------------------------------------
// The held object
// ---------------------------------------------------------------------------

/**
 * The held object an entity belongs to (§5.0): the entity plus every entity joined to it by a `lash` joint, at most
 * VERB_TUNING.heldJoinDepth joints away, in id order. Rope joints, hinges, bends, held and loose ends and world points
 * join nothing; the rope a lashing is made of is not one of its anchors, so it is no member.
 */
export function heldMembers(w: World, entity: number): number[] {
  if (!w.entities.get(entity)) return [];
  const seen = new Set<number>([entity]);
  let frontier = [entity];
  for (let depth = 0; depth < VERB_TUNING.heldJoinDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      const e = w.entities.get(id);
      if (!e) continue;
      for (const jid of e.joints) {
        const j = w.joints.get(jid);
        if (!j || j.kind !== 'lash') continue;
        for (const end of [j.a, j.b]) {
          if (end.fighter !== undefined || end.loose || end.entity === null) continue;
          if (seen.has(end.entity) || !w.entities.get(end.entity)) continue;
          seen.add(end.entity);
          next.push(end.entity);
        }
      }
    }
    frontier = next.sort((a, b) => a - b);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The geometry of the held object `entity` belongs to, in `entity`'s frame (§5.0). Throws on an unknown entity. */
export function heldShape(w: World, entity: number): HeldShape {
  const main = w.entities.get(entity);
  if (!main) throw new Error(`heldShape: no entity ${entity}`);
  const members = heldMembers(w, entity).map((id) => w.entities.get(id)!);
  const rel = (e: Entity): Pose3 => (e === main ? { p: v(0, 0, 0), q: { x: 0, y: 0, z: 0, w: 1 } } : verbGeom.relative(main.pose, e.pose));

  // The longest member (ties: the lowest id).
  let longest = members[0];
  let ax = principalAxis(longest.shape);
  for (const e of members) {
    const a = principalAxis(e.shape);
    if (a.max - a.min > ax.max - ax.min + GEOM_EPS) {
      longest = e;
      ax = a;
    }
  }
  const lp = rel(longest);
  const axis = unit(rotate(lp.q, ax.dir));
  const centre = verbGeom.pointToWorld(lp, scale(ax.dir, (ax.min + ax.max) / 2));
  const L = ax.max - ax.min;
  const aspect = ax.crossHalf > 0 ? L / (2 * ax.crossHalf) : Infinity;

  let massKg = 0;
  let com = v(0, 0, 0);
  let crossHalfM = 0;
  const feats: Omit<HeldFeature, 'kind' | 'end'>[] = [];
  for (const e of members) {
    const rp = rel(e);
    massKg += e.mass;
    com = add(com, scale(rp.p, e.mass));
    for (const p of shapePoints(e.shape)) {
      const d = sub(verbGeom.pointToWorld(rp, p), centre);
      crossHalfM = Math.max(crossHalfM, len(sub(d, scale(axis, dot(d, axis)))));
    }
    const hardness = MATERIALS[e.material].hardness;
    for (const sp of e.sharpPoints) {
      feats.push({ local: verbGeom.pointToWorld(rp, sp.local), dir: unit(rotate(rp.q, sp.dir)), sharpness: sp.sharpness, entity: e.id, hardness });
    }
  }
  com = massKg > 0 ? scale(com, 1 / massKg) : { ...centre };

  // Points and edges (§5.0's predicate table).
  const t = TOOL_TUNING;
  const compact = aspect < t.compactMaxAspect;
  const classified: HeldFeature[] = [];
  for (const f of feats) {
    const along = dot(sub(f.local, centre), axis);
    const nearHi = along >= L / 2 - t.headZoneM && along <= L / 2 + t.headZoneM;
    const nearLo = along <= -L / 2 + t.headZoneM && along >= -L / 2 - t.headZoneM;
    const end: 1 | -1 | 0 = nearHi && nearLo ? (along >= 0 ? 1 : -1) : nearHi ? 1 : nearLo ? -1 : 0;
    const c = dot(f.dir, axis);
    if (compact) {
      // "anywhere on a compact object" (§5.0): a knapped flint's edge runs along its own long axis (§5.4).
      if (propertyAtLeast(f.sharpness, t.edgeMinSharpness)) classified.push({ ...f, kind: 'edge', end: 0 });
      continue;
    }
    if (end === 0) continue;
    // A point leads out of its end; an edge lies across the axis.
    if (c * end >= t.pointAxisCos && propertyAtLeast(f.sharpness, t.pointMinSharpness)) classified.push({ ...f, kind: 'point', end });
    else if (Math.abs(c) < t.edgeAxisCos && propertyAtLeast(f.sharpness, t.edgeMinSharpness)) classified.push({ ...f, kind: 'edge', end });
  }
  // The head: the sharpest feature; ties: an edge before a point, the + end before the − end, then member order.
  let head: HeldFeature | null = null;
  for (const f of classified) {
    if (!head) {
      head = f;
      continue;
    }
    if (f.sharpness > head.sharpness + PROPERTY_EPS) head = f;
    else if (Math.abs(f.sharpness - head.sharpness) <= PROPERTY_EPS) {
      if (f.kind === 'edge' && head.kind === 'point') head = f;
      else if (f.kind === head.kind && f.end > head.end) head = f;
    }
  }

  // Which end is the head: the head feature's; a compact edge's side; otherwise the heavier end (a club is held by its
  // light end), the + end on a tie.
  let side: 1 | -1;
  if (head && head.end !== 0) side = head.end;
  else if (head) side = dot(sub(head.local, centre), axis) < 0 ? -1 : 1;
  else side = dot(sub(com, centre), axis) < -GEOM_EPS ? -1 : 1;
  const axisOut = scale(axis, side);
  const grip = sub(centre, scale(axisOut, L / 2));

  return {
    members: members.map((e) => e.id),
    massKg,
    lengthM: L,
    axis: axisOut,
    grip,
    sharpPoints: feats.map((f) => ({ local: f.local, dir: f.dir, sharpness: f.sharpness })),
    centre,
    com,
    crossHalfM,
    aspect,
    head,
  };
}

// ---------------------------------------------------------------------------
// Tool classes and the synthesised weapon (§5.2)
// ---------------------------------------------------------------------------

/** The tool class of a held object's geometry (§5.2's property rules), or null when it is no tool. */
export function classifyHeld(h: HeldShape): ToolClass | null {
  const t = TOOL_TUNING;
  if (!propertyAtMost(h.massKg, t.toolMaxKg)) return null;
  if (h.lengthM < t.toolMinLenM || h.lengthM > t.toolMaxLenM) return null;
  if (propertyAtLeast(h.aspect, t.minAspect)) {
    if (h.head?.kind === 'edge') return h.lengthM < t.twoHandMinLenM ? 'stoneAxe' : 'longAxe';
    if (h.head?.kind === 'point') return h.lengthM < t.spearMinLenM ? 'sharpStick' : 'spear';
    return h.massKg < t.cudgelMinKg ? 'stick' : 'cudgel';
  }
  if (h.aspect < t.compactMaxAspect) {
    if (h.head) return 'flintBlade';
    if (propertyAtMost(h.massKg, t.stoneMaxKg)) return 'stone';
  }
  return null;
}

/** The tool class of the held object `entity` belongs to (§5.2), or null: no such entity, a rope, or no tool. */
export function toolClass(w: World, entity: number): ToolClass | null {
  const e = w.entities.get(entity);
  if (!e || isRopeLike(MATERIALS[e.material])) return null;
  return classifyHeld(heldShape(w, entity));
}

/** The classes whose head is a point; the classes whose head is an edge (§5.2). */
const POINT_CLASSES: ReadonlySet<ToolClass> = new Set<ToolClass>(['sharpStick', 'spear']);
const EDGE_CLASSES: ReadonlySet<ToolClass> = new Set<ToolClass>(['stoneAxe', 'longAxe', 'flintBlade']);

/**
 * The WeaponDef of a held object as tool class `cls` (§5.2): the class's DS template with the object's length (less
 * lengthTrimM), strike point, radius, mass and head sharpness, and TOOL_TUNING's numbers scaled by the head's sharpness
 * against the class's reference (rule 4: the head's material enters the numbers, RR-13). A new object every call: never
 * key anything on its identity (P04).
 */
export function synthWeapon(w: World, entity: number, cls: ToolClass): WeaponDef {
  const h = heldShape(w, entity);
  const t = TOOL_TUNING;
  const tmpl = WEAPONS[cls];
  const row = t[cls];
  const point = POINT_CLASSES.has(cls);
  const edge = EDGE_CLASSES.has(cls);
  const sharp = point || edge;
  const length = Math.max(t.toolMinLenM, h.lengthM - t.lengthTrimM);
  const strikeFrom = sharp ? Math.max(0, length - (point ? t.pointHeadM : t.edgeHeadFrac * length)) : (length * tmpl.strikeFrom) / tmpl.length;
  const sRef = sharp ? t.refSharpness[cls as keyof typeof t.refSharpness] : 0;
  const s = sharp ? (h.head?.sharpness ?? sRef) : 0;
  const kS = DAMAGE_TUNING.kS;
  const ratio = sRef > 0 ? s / sRef : 1;
  return {
    ...tmpl,
    chain: { ...tmpl.chain },
    length,
    strikeFrom,
    radius: Math.min(t.radiusMaxM, Math.max(t.radiusMinM, h.crossHalfM)),
    mass: h.massKg,
    sharpness: s,
    edge: sharp ? 'blade' : 'blunt',
    damageMul: (row.damageMul * (1 + kS * s)) / (1 + kS * sRef),
    cut: Math.min(1, row.cut * ratio),
    cleave: row.cleave,
    bite: row.bite * ratio,
    tempo: row.tempo,
    choke: row.choke,
  };
}

/**
 * The held object's committed-swing energy (its class's heavy technique) at full stamina and power 1, as a fresh human
 * swings it: DS `hit()`'s perk-free damage (blowDamage) × DAMAGE_TUNING.meleeJPerDmg, J (§5.2, §5.3). 0 for no tool.
 * The chop depth scales by it (FELL_TUNING.refChopJ, 339 J for the starter axe), so a tired player chops slower, never
 * shallower.
 */
export function freshChopEnergy(w: World, entity: number): number {
  const cls = toolClass(w, entity);
  if (!cls) return 0;
  const weapon = synthWeapon(w, entity, cls);
  const move = WEAPON_MOVES[weapon.heavy];
  if (!move) return 0;
  // A fresh human arm: a fighter of its own (own id counter, fixed seed), so no shared counter or stream is touched.
  const arm = createPlayer({ ids: new IdCounter(1), rngSeed: 1 });
  arm.weapon = weapon;
  arm.swingStamina = 1;
  return blowDamage(arm, null, move, 1, false, null) * DAMAGE_TUNING.meleeJPerDmg;
}

// ---------------------------------------------------------------------------
// Property predicates (§5.0; comparisons allow materials' PROPERTY_EPS)
// ---------------------------------------------------------------------------

/** Rope-like: its strength is a tension per strand (vine, sinew). */
export function isRopeEntity(e: Entity): boolean {
  return isRopeLike(MATERIALS[e.material]);
}

/** Springy (bend): springiness ≥ JOINT_TUNING.bendMinSpringiness. */
export function isSpringyEntity(e: Entity): boolean {
  return isSpringy(MATERIALS[e.material], JOINT_TUNING.bendMinSpringiness);
}

/** Rooted: a tree or sapling still standing (or notched) in the ground. */
export function isRooted(e: Entity): boolean {
  return e.plant !== null && (e.plant.phase === 'standing' || e.plant.phase === 'notched');
}

/** Soft ground at a terrain point (stakes drive into it, D-19): the terrain material's hardness ≤ softGroundMaxHardness. */
export function isSoftTerrain(): boolean {
  return isSoftGround(MATERIALS[TERRAIN_TUNING.material], TERRAIN_TUNING.softGroundMaxHardness);
}

/** Soft ground as an entity (a dirt pile): its material's hardness ≤ softGroundMaxHardness. */
export function isSoftGroundEntity(e: Entity): boolean {
  return isSoftGround(MATERIALS[e.material], TERRAIN_TUNING.softGroundMaxHardness);
}

/** One entity's principal length ÷ its largest cross dimension. */
export function entityAspect(e: Entity): number {
  const ax = principalAxis(e.shape);
  return ax.crossHalf > 0 ? (ax.max - ax.min) / (2 * ax.crossHalf) : Infinity;
}

/** Elongated: aspect ≥ TOOL_TUNING.minAspect (5). */
export function isElongated(e: Entity): boolean {
  return propertyAtLeast(entityAspect(e), TOOL_TUNING.minAspect);
}

/** Compact: aspect < TOOL_TUNING.compactMaxAspect (2.2). */
export function isCompact(e: Entity): boolean {
  return entityAspect(e) < TOOL_TUNING.compactMaxAspect;
}

/** The held object's edge (§5.0): its head when that is an edge; null otherwise. */
export function toolEdge(w: World, tool: number): HeldFeature | null {
  if (!w.entities.get(tool)) return null;
  const head = heldShape(w, tool).head;
  return head?.kind === 'edge' ? head : null;
}

/** Can cut X (§5.0): the tool has an edge whose hardness exceeds X's material by VERB_TUNING.cutHardnessMargin. */
export function canCut(w: World, tool: number, target: number): boolean {
  const edge = toolEdge(w, tool);
  const x = w.entities.get(target);
  if (!edge || !x) return false;
  return propertyMarginAtLeast(edge.hardness, MATERIALS[x.material].hardness, VERB_TUNING.cutHardnessMargin);
}

/** A held object's hardness: its hardest member's (what does the shaping, §5.0). */
export function toolHardness(w: World, tool: number): number {
  let h = 0;
  for (const id of heldMembers(w, tool)) h = Math.max(h, MATERIALS[w.entities.get(id)!.material].hardness);
  return h;
}

/** Can shape X (§5.0): the tool's (or held stone's) hardness ≥ X's hardness − VERB_TUNING.shapeHardnessMargin. */
export function canShape(w: World, tool: number, target: number): boolean {
  const x = w.entities.get(target);
  if (!x || !w.entities.get(tool)) return false;
  return propertyMarginAtLeast(toolHardness(w, tool), MATERIALS[x.material].hardness, -VERB_TUNING.shapeHardnessMargin);
}

/**
 * Digs (§5.0): a two-handed tool (its class's DS template is two-handed) whose head is a point or an edge of hardness
 * ≥ TOOL_TUNING.digMinHardness: a sharpened stick and a long axe dig; a spear, a stone axe or a blunt stick don't.
 */
export function toolDigs(w: World, tool: number): boolean {
  const cls = toolClass(w, tool);
  if (!cls || WEAPONS[cls].style !== 'twoHand') return false;
  const head = heldShape(w, tool).head;
  return !!head && propertyAtLeast(head.hardness, TOOL_TUNING.digMinHardness);
}

/**
 * How `take` would hold the object (§5.1): a tool is wielded; else up to carryMaxKg × scale² is carried and up to
 * dragMaxKg × scale² dragged; heavier: null (too heavy). `massKg` is the held object's.
 */
export function takeMode(w: World, entity: number, scaleOf: number): { mode: 'wield' | 'carry' | 'drag'; massKg: number } | null {
  if (!w.entities.get(entity)) return null;
  const h = heldShape(w, entity);
  const s2 = scaleOf * scaleOf;
  if (toolClass(w, entity)) return { mode: 'wield', massKg: h.massKg };
  if (propertyAtMost(h.massKg, VERB_TUNING.carryMaxKg * s2)) return { mode: 'carry', massKg: h.massKg };
  if (propertyAtMost(h.massKg, VERB_TUNING.dragMaxKg * s2)) return { mode: 'drag', massKg: h.massKg };
  return null;
}
