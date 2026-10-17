// Lash, tie, splice and untie (docs/M1-DESIGN.md §5.8, SPEC:239, 251-266): fixed lashings and taut ropes from a coil,
// tying a coil or a held (hauled) end, splicing two ropes into one, untying back to a coil. Also the rope and reach
// helpers the other rope and shape verbs share (bend.ts, pull.ts, shape.ts).
//
// Rule 1: nothing here knows a tripwire, a snare or a tool. A lashing is a fixed joint between two entities, a rope a
// rope joint; a tripwire is a rope tied across a path, a pull rope a coil tied to something and walked out, an axe a
// flint lashed across a stick's end. Every effect is a joint the joint store (P10) makes and the physics then works.
//
// Rope (§5.8: "Rope comes from a rope-like entity in the hands or the first belt slot holding one"): a coil carried in
// the hands, else the first belt slot holding one. A lashing takes VERB_TUNING.lashRopeUseM off it, a rope the anchor
// distance plus ROPE_TUNING.knotAllowanceM; the piece is a new rope entity (the coil keeps its id, its length and mass
// shrink); with less than ROPE_TUNING.coilMinM left the whole coil goes into the piece ("used up").
//
// The verbs (§5.8; work actions lash 90, tie 60, splice 60, untie 60 frames, pose workLow; the effect lands at the end
// of the action, re-validated, RF-15):
// - lash { target, second, at, at2 }: two entities, neither rope-like nor stowed; the anchors are the surface points
//   nearest `at` and `at2`. Snap assist first (see snapOnto): a light head aimed at a stick's end is moved flush onto it,
//   and the anchors become that end's centre and the head's point nearest it. Anchors within lashTouchM → a fixed lashing
//   (joints.lash); otherwise a taut rope joint of the anchor distance (joints.rope). One side may be what the hands hold
//   (a flint lashed onto the stick in hand, rule 3): only a light head, snapped onto the held side's end away from the
//   hand, and it then joins the held object (planLash's DEVIATION).
// - tie { target, at }: with a coil, a rope joint from the target anchor to the hand (the end held, length = the
//   coil's), paid out as the player walks (the tether); with a rope end in hand, joints.tieHeldEnd at the distance of
//   the tick the tie lands (a hauled end keeps its haul through the work action: pull.ts goes on setting it, §4.9).
// - splice: lash or tie where both sides are rope-like: one rope a + b − spliceLossM long, of the weaker material,
//   credit merged; a joint of it with a held or loose end pays the added rope out at that end (§11.3: a vine extended
//   past 15 m).
// - untie { target: rope }: the rope's joint with an anchor in reach is removed (joints.remove pushes the `joint`
//   event); the rope, a coil again, goes into empty hands.
//
// Reach (§5.0, rule 3): every anchor point must be within handReachM of the chest point after the step-in. DEVIATION
// (§5.0: "within handReachM (1.3 m) of the chest point"): the chest point is lowered toward an anchor below it as far as
// a squat (ROPE_TUNING.squatChestM), since a work action is done crouched (pose workLow); read literally, a stick on the
// ground 0.6 m in front of the feet is 1.34 m from the standing chest and could never be lashed (P14 met the same
// problem for take and measured from the feet instead). The highest anchor stays 2.5 m up. Before the work action
// starts (the command, tryVerb) reach is judged from where the step-in will leave the feet (standOffM from the work's
// faceAt), at actAt from where they are.
import type { TrackKey } from '../../body/animator';
import { getPose, type PoseName } from '../../body/poses';
import type { VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { defineTuning } from '../../tuning/registry';
import { ropeCoilShape } from '../factory';
import { MATERIALS, propertyAtMost, ropeStrengthN } from '../materials';
import { cylinderPoints, GEOM_EPS, principalAxis } from '../shapes';
import type { Anchor, Entity, JointRecord, Pose3, RefuseReason, Shape, V3 } from '../types';
import type { World } from '../world';
import { WORLD_TUNING } from '../worldTuning';
import { creditEntity, putInHands, refreshHands } from './hands';
import { shrinkShape } from './place';
import { anchorPoint, chestPoint, cmdPoint, handPoint, ownedBy, registerVerb, ropeJoints, ropeNearest, verbEvent, type VerbHandler, type VerbStage, type WorkSpec } from './targets';
import { heldMembers, isElongated, isRooted, isRopeEntity, toolClass, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

/**
 * The rope and shape verbs' own starting values. DEVIATION (P16): §13.0 adds no tuning table after P05, but VERB_TUNING
 * is P14's file and §9.1 has no row for these values, which §5.8 gives only in prose (the two 0.5 m) or not at all (the
 * squat); CLAUDE.md puts every starting value in a live tuning table, so they live here (as P17's PLACE_TUNING does)
 * until a follow-up moves them into VERB_TUNING.
 */
export const ROPE_TUNING = defineTuning(
  'ROPE_TUNING',
  'Verbs › rope and shape',
  {
    knotAllowanceM: 0.5,
    coilMinM: 0.5,
    squatChestM: 0.6,
    shapeDoneMargin: 0.01,
    workPoseFrac: 0.5,
    snapEndMinY: -0.5,
  },
  {
    knotAllowanceM: { unit: 'm', source: 'NEW: §5.8 (a rope takes "distance + 0.5 m" off the coil: the rope its knots use)', min: 0 },
    coilMinM: { unit: 'm', source: 'NEW: §5.8 ("< 0.5 m left: used up": a coil with less left goes into the piece whole)', min: 0 },
    squatChestM: {
      unit: 'm × scale above the feet',
      source: 'NEW: §5.0 Reach: the chest point of a player working low (a deep squat, pose workLow), so a ground anchor 1.2 m out is in reach',
      min: 0,
    },
    shapeDoneMargin: {
      unit: 'sharpness',
      source: "NEW: §5.0 shape precondition (\"target maxSharpness > current + 0.01\"): an end this near its material's max is done",
      min: 0,
    },
    workPoseFrac: {
      unit: '× the work action',
      source: "NEW: the rope and shape verbs' work actions are in their pose (workLow, workKnap, haulRope) by this fraction of their frames (as P14's takeGrabFrac)",
      min: 0,
      max: 1,
    },
    snapEndMinY: {
      unit: 'y of the end’s outward axis (−1 straight down)',
      source: "NEW: P16 review: lash's snap assist never moves a head onto an end pointing further down than this (a standing prop's foot)",
      min: -1,
      max: 1,
    },
  },
);

const { add, sub, scale, dot, len, unit, rotate, pointToWorld, pointToLocal } = verbGeom;
const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const dist = (a: V3, b: V3): number => len(sub(a, b));
const copy3 = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });

// ---------------------------------------------------------------------------
// Shapes (records only)
// ---------------------------------------------------------------------------

/** The vertices bounding a shape in its local frame (a round shape: its extreme points along each axis). */
export function shapeVerts(s: Shape): V3[] {
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

/** The centre of an entity's end (`end` +1: the max end of its principal axis, −1 the min end), its local frame. */
export function endCentre(s: Shape, end: 1 | -1): V3 {
  const ax = principalAxis(s);
  return scale(ax.dir, end > 0 ? ax.max : ax.min);
}

// ---------------------------------------------------------------------------
// Reach (§5.0; see the DEVIATION at the top)
// ---------------------------------------------------------------------------

/** The point a working player reaches `p` from: his chest, lowered toward a point below it as far as a squat. */
export function workChest(f: Fighter, feet: V3, p: V3): V3 {
  const s = f.scale;
  const lo = feet.y + ROPE_TUNING.squatChestM * s;
  const hi = feet.y + WORLD_TUNING.chestHeightM * s;
  return v(feet.x, Math.max(lo, Math.min(hi, p.y)), feet.z);
}

/** Where a work action's step-in leaves the feet (CombatSim's faceWork): toward faceAt until standOffM from it. */
export function feetAfterStepIn(f: Fighter, faceAt: V3): V3 {
  const dx = faceAt.x - f.pos.x;
  const dz = faceAt.z - f.pos.z;
  const d = Math.hypot(dx, dz);
  const near = VERB_TUNING.standOffM * f.scale;
  if (!(d > near)) return v(f.pos.x, f.pos.y, f.pos.z);
  const k = (d - near) / d;
  return v(f.pos.x + dx * k, f.pos.y, f.pos.z + dz * k);
}

/**
 * Are all `points` within the hands' reach (§5.0)? At actAt ('land') from where the player stands; before (the command,
 * the start, the radial's probe) from where the work action's step-in toward `faceAt` will leave him.
 */
export function inWorkReach(f: Fighter, points: readonly V3[], faceAt: V3, stage: VerbStage): boolean {
  const feet = stage === 'land' ? v(f.pos.x, f.pos.y, f.pos.z) : feetAfterStepIn(f, faceAt);
  const r = VERB_TUNING.handReachM * f.scale;
  return points.every((p) => dist(p, workChest(f, feet, p)) <= r);
}

// ---------------------------------------------------------------------------
// Rope: where it comes from, splitting a piece off a coil
// ---------------------------------------------------------------------------

/** A coil the fighter can take rope from: in the hands (carried), or in a belt slot. */
export interface RopeSource {
  entity: number;
  from: 'hands' | 'belt';
  /** The belt slot (from 'belt'); −1 from the hands. */
  slot: number;
}

/** A rope-like entity's length (its `rope` record), m. */
export function ropeLength(e: Entity): number {
  return e.rope?.lengthM ?? 0;
}

/** §5.8: a coil in the hands, else the first belt slot holding one; null without. */
export function ropeSource(w: World, f: Fighter): RopeSource | null {
  const inv = f.inventory;
  if (!inv) return null;
  const h = inv.hands;
  if (h && (h.mode === 'carry' || h.mode === 'wield')) {
    const e = w.entities.get(h.entity);
    if (e && isRopeEntity(e) && e.rope && e.joints.length === 0) return { entity: e.id, from: 'hands', slot: -1 };
  }
  const n = Math.min(inv.belt.length, VERB_TUNING.beltSlots);
  for (let i = 0; i < n; i++) {
    const id = inv.belt[i];
    const e = id === null ? undefined : w.entities.get(id);
    if (e && e.state === 'stowed' && isRopeEntity(e) && e.rope) return { entity: e.id, from: 'belt', slot: i };
  }
  return null;
}

/** The coil leaves the hands or its belt slot (it is about to be tied, merged or removed). */
function detachSource(w: World, f: Fighter, src: RopeSource): void {
  const inv = f.inventory;
  if (!inv) return;
  if (src.from === 'hands' && inv.hands?.entity === src.entity) {
    inv.hands = null;
    refreshHands(w, f);
  } else if (src.from === 'belt' && inv.belt[src.slot] === src.entity) inv.belt[src.slot] = null;
}

/** The piece a coil gives for `need` m of rope: the whole coil when less than coilMinM would be left. */
function pieceLength(total: number, need: number): number {
  return total - need < ROPE_TUNING.coilMinM - GEOM_EPS ? total : need;
}

/**
 * Splits `need` m of rope off the coil (§5.8): a new rope entity of that length (the coil's material, its credit and
 * the player's) at `at` (the joint store ties it at once: no body), the coil's length and mass shrinking; or, with less
 * than coilMinM left, the coil itself, out of the hands or belt. Returns the piece's id.
 */
export function takeRope(w: World, f: Fighter, src: RopeSource, need: number, at: V3): number {
  const coil = w.entities.get(src.entity)!;
  const total = ropeLength(coil);
  if (pieceLength(total, need) === total) {
    detachSource(w, f, src);
    creditEntity(coil, f);
    return coil.id;
  }
  const left = total - need;
  coil.rope = { lengthM: left };
  w.entities.reshape(coil, ropeCoilShape(left));
  creditEntity(coil, f);
  const piece = w.entities.create({ material: coil.material, shape: ropeCoilShape(need), p: copy3(at), rope: { lengthM: need }, look: coil.look, credit: [...coil.credit] });
  creditEntity(piece, f);
  if (src.from === 'hands') refreshHands(w, f);
  return piece.id;
}

/** The credit a joint the fighter makes carries (SPEC:186): his player id; a creature's joints carry none. */
export function makerCredit(f: Fighter): string[] {
  return f.playerId ? [f.playerId] : [];
}

/**
 * The entity's surface point nearest `p` (a tied rope: its point nearest `p`): the shape at the entity's record pose. A
 * held entity's collider lies where its body was disabled, so `p` is carried into the collider's frame, projected there
 * and carried back. Without a collider (stowed), `p` itself.
 */
export function surfacePoint(w: World, e: Entity, p: V3): V3 {
  if (e.state === 'tied' && isRopeEntity(e)) return ropeNearest(w, e.id, p)?.point ?? copy3(p);
  const c = e.collider;
  if (!c) return copy3(p);
  const t = c.translation();
  const r = c.rotation();
  const cp: Pose3 = { p: { x: t.x, y: t.y, z: t.z }, q: { x: r.x, y: r.y, z: r.z, w: r.w } };
  const proj = w.queries.projectPoint(e.id, pointToWorld(cp, pointToLocal(e.pose, p)));
  if (!Number.isFinite(proj.dist)) return copy3(p);
  return pointToWorld(e.pose, pointToLocal(cp, proj.point));
}

// ---------------------------------------------------------------------------
// Work actions
// ---------------------------------------------------------------------------

/**
 * A work action whose effect lands at its end (§5.0): the body is in `pose` by workPoseFrac of it and holds it to the
 * end.
 */
export function workSpec(frames: number, faceAt: V3, pose: PoseName): WorkSpec {
  const n = Math.max(1, Math.round(frames));
  const low = getPose(pose);
  const keys: TrackKey[] = [
    { f: Math.max(1, Math.min(n, Math.round(n * ROPE_TUNING.workPoseFrac))), pose: low, ease: 'inOut' },
    { f: n, pose: low },
  ];
  return { frames: n, actAt: n, faceAt: copy3(faceAt), keys };
}

// ---------------------------------------------------------------------------
// Splice (§5.8: lash or tie where both sides are rope-like)
// ---------------------------------------------------------------------------

interface SplicePlan {
  /** The rope that stays (a tied one, else the one in the hands, else the first named), and the one merged into it. */
  keep: Entity;
  gone: Entity;
  /** Where the player works (the rope he doesn't hold). */
  faceAt: V3;
}

/** A rope's point to reach for: the command's point, else its point nearest the chest. */
function ropePoint(w: World, f: Fighter, e: Entity, at: readonly [number, number, number] | undefined): V3 {
  if (at) return surfacePoint(w, e, cmdPoint(at));
  if (e.state === 'tied') return ropeNearest(w, e.id, chestPoint(f))?.point ?? copy3(e.pose.p);
  return e.collider ? w.queries.projectPoint(e.id, chestPoint(f)).point : copy3(e.pose.p);
}

/**
 * Splicing ropes x and y (x named first): refused when they are one rope, both tied (two ropes in use can't be knotted
 * into one), either shorter than the knot (spliceLossM), or out of reach.
 */
function planSplice(
  w: World,
  f: Fighter,
  x: Entity,
  y: Entity,
  xAt: readonly [number, number, number] | undefined,
  yAt: readonly [number, number, number] | undefined,
  stage: VerbStage,
): SplicePlan | RefuseReason {
  if (x.id === y.id) return 'badAnchor';
  const tx = x.state === 'tied';
  const ty = y.state === 'tied';
  if (tx && ty) return 'badAnchor';
  const loss = VERB_TUNING.spliceLossM;
  if (ropeLength(x) < loss - GEOM_EPS || ropeLength(y) < loss - GEOM_EPS) return 'ropeTooShort';
  if (ropeLength(x) + ropeLength(y) - loss < ROPE_TUNING.coilMinM - GEOM_EPS) return 'ropeTooShort';
  const inHands = f.inventory?.hands?.entity;
  const keep = tx ? x : ty ? y : inHands === y.id ? y : x;
  const gone = keep === x ? y : x;
  // Reach: every rope the player doesn't hold or wear.
  const pts: V3[] = [];
  if (!ownedBy(w, f, x.id) && inHands !== x.id) pts.push(ropePoint(w, f, x, xAt));
  if (!ownedBy(w, f, y.id) && inHands !== y.id) pts.push(ropePoint(w, f, y, yAt));
  const faceAt = pts[0] ?? chestPoint(f);
  if (!inWorkReach(f, pts, faceAt, stage)) return 'outOfReach';
  return { keep, gone, faceAt };
}

/**
 * One rope of `keep` and `gone` (§5.8): a + b − spliceLossM long, the weaker material (strength = the weaker), credit
 * merged and the player's; `gone` leaves the hands or belt and the world. A joint of `keep` with a held or loose end pays
 * the added rope out at that end (its free length grows, JointStore.lengthen); a rope tied at both ends keeps its free
 * length (the added rope hangs at the knot).
 */
function doSplice(w: World, f: Fighter, keep: Entity, gone: Entity): void {
  const added = ropeLength(gone) - VERB_TUNING.spliceLossM;
  const total = ropeLength(keep) + added;
  if (ropeStrengthN(MATERIALS[gone.material]) < ropeStrengthN(MATERIALS[keep.material])) keep.material = gone.material;
  keep.rope = { lengthM: total };
  keep.credit = [...new Set([...keep.credit, ...gone.credit])].sort();
  creditEntity(keep, f);
  const inv = f.inventory;
  if (inv) {
    if (inv.hands?.entity === gone.id) inv.hands = null;
    for (let i = 0; i < inv.belt.length; i++) if (inv.belt[i] === gone.id) inv.belt[i] = null;
    if (inv.back === gone.id) inv.back = null;
  }
  w.entities.remove(gone.id);
  w.entities.reshape(keep, ropeCoilShape(total));
  for (const j of ropeJoints(w, keep.id)) {
    if (j.rope && (j.a.loose || j.b.loose || j.a.fighter !== undefined || j.b.fighter !== undefined)) {
      w.joints.lengthen(j.id, added);
      break;
    }
  }
  refreshHands(w, f);
}

// ---------------------------------------------------------------------------
// Lash (§5.8)
// ---------------------------------------------------------------------------

/** Snap assist (§5.8): the small entity moved flush to its partner's end, and the lashing's anchors after the move. */
interface Snap {
  /** The entity moved, and its new pose (its orientation kept). */
  moved: number;
  pose: Pose3;
  /** The anchors, in the order (target, second). */
  a: Anchor;
  b: Anchor;
}

type LashPlan =
  | { kind: 'splice'; splice: SplicePlan }
  | {
      kind: 'lash' | 'rope';
      a: Anchor;
      b: Anchor;
      snap: Snap | null;
      d: number;
      need: number;
      src: RopeSource;
      faceAt: V3;
      mid: V3;
      /** The side that is (part of) what the hands hold, which the other side joins: none, or the target or second. */
      held: 'a' | 'b' | null;
    };

/**
 * Snap assist for small S and elongated P (§5.8): S ≤ lashSnapMaxKg, free and dynamic, not itself elongated and not
 * already joined to anything, within lashSnapM of P's end centre E (its surface; the nearer end, never an end pointing
 * down further than snapEndMinY: a standing prop's foot). S is moved, keeping its orientation, so its nearest face along
 * P's axis lies on the end plane and it is centred across the axis (flint across a stick's end: an axe head; along it: a
 * spear point). The anchors are E and S's point nearest E. The caller asks only when the two aimed points are within
 * lashSnapM of each other (the player aimed at the end).
 *
 * INTERPRETATIONS (§5.8 "an entity ≤ lashSnapMaxKg within lashSnapM of an end of an elongated partner is moved flush to
 * that end"): S is a head, not itself elongated, so two light sticks lashed crosswise near their ends make a frame, never
 * a stick end to end; "flush" centres S across a lying partner's axis but keeps its height (a flint lying by a stick on
 * the ground stays on the ground beside its end, as the starter axe's does) and centres it fully on an upright one; a
 * move that would put S (shrunk by placeShrinkM) into the terrain or any other entity is no snap.
 *
 * `inHand` (P is what the hands hold, planLash): S goes onto that end of P whatever the distance and the end's direction
 * (the player brings the head to the stick in his hands), flush and centred fully across the axis, with the same room
 * test.
 */
function snapOnto(w: World, S: Entity, P: Entity, inHand?: 1 | -1): { pose: Pose3; onP: Anchor; onS: Anchor } | null {
  const t = VERB_TUNING;
  if (!(S.mass <= t.lashSnapMaxKg + GEOM_EPS) || S.state !== 'free' || !S.body?.isEnabled() || !S.body.isDynamic() || w.entities.isAnchored(S)) return null;
  if (!S.collider || S.joints.length > 0 || !isElongated(P) || isElongated(S)) return null;
  let best: { E: V3; n: V3; end: 1 | -1; d: number } | null = null;
  const ax = principalAxis(P.shape);
  for (const end of [1, -1] as const) {
    if (inHand !== undefined && end !== inHand) continue;
    const n = unit(rotate(P.pose.q, scale(ax.dir, end)));
    const E = pointToWorld(P.pose, endCentre(P.shape, end));
    if (inHand !== undefined) {
      // P in the hands: the player brings S to its end himself, wherever S lies in reach and however the end points.
      best = { E, n, end, d: 0 };
      continue;
    }
    if (n.y < ROPE_TUNING.snapEndMinY) continue;
    const d = len(sub(surfacePoint(w, S, E), E));
    if (d <= t.lashSnapM && (!best || d < best.d)) best = { E, n, end, d };
  }
  if (!best) return null;
  const { E, n } = best;
  const verts = shapeVerts(S.shape).map((p) => pointToWorld(S.pose, p));
  let nearest = Infinity;
  for (const p of verts) nearest = Math.min(nearest, dot(sub(p, E), n));
  // Across the axis: S's offset from the axis line, less the part of it that is "up" seen across the axis, weighted by
  // how far the axis lies from vertical (sin²): a lying partner's head keeps its height, an upright one's is centred.
  const off = sub(S.pose.p, E);
  const lateral = sub(off, scale(n, dot(off, n)));
  const upAcross = sub(UP, scale(n, n.y));
  // (In the hands nothing holds the head's height: centred fully.)
  const across = inHand !== undefined ? lateral : sub(lateral, scale(upAcross, dot(lateral, upAcross)));
  const delta = sub(scale(n, -nearest), across);
  const pose: Pose3 = { p: add(S.pose.p, delta), q: { ...S.pose.q } };
  // Room for it there (as place.ts's clearance): nothing but S itself, the ground included.
  const room = w.queries.overlaps(shrinkShape(S.shape, t.placeShrinkM), pose, { terrain: true, entities: 'all', fighters: 'none', exclude: { entities: [S.id] } });
  if (room.length > 0) return null;
  // S's point nearest E after the move: its point nearest E − Δ now (S only translates), moved by Δ.
  const q = surfacePoint(w, S, sub(E, delta));
  return {
    pose,
    onP: { entity: P.id, local: endCentre(P.shape, best.end) },
    onS: { entity: S.id, local: pointToLocal(S.pose, q) },
  };
}

/** The entities of what the hands hold (wielded or carried, every lash-joined member); none otherwise. */
function inTheHands(w: World, f: Fighter): number[] {
  const h = f.inventory?.hands;
  return h && (h.mode === 'wield' || h.mode === 'carry') ? heldMembers(w, h.entity) : [];
}

/**
 * Lashed to what the hands hold, the other side joins the held object (§5.0): it must be free to come up into the hands
 * (not fixed, anchored, rooted or tied) and the whole no heavier than the hands carry.
 */
function joinsTheHands(w: World, f: Fighter, other: Entity, held: readonly number[]): RefuseReason | null {
  const members = heldMembers(w, other.id);
  let mass = 0;
  for (const id of new Set([...held, ...members])) mass += w.entities.get(id)!.mass;
  for (const id of members) {
    const m = w.entities.get(id)!;
    if (m.state !== 'free' || isRooted(m) || w.entities.isAnchored(m)) return 'immovable';
  }
  return propertyAtMost(mass, VERB_TUNING.carryMaxKg * f.scale * f.scale) ? null : 'tooHeavy';
}

/**
 * The lash a command makes, as planned from the world now (shared by the checks and the effect, RF-15); null: the radial's
 * probe (no second target yet) found nothing against it.
 *
 * DEVIATION (P16 review, rule 3; §5.8 doesn't forbid it): one side may be what the hands hold (a flint lashed onto the
 * stick in hand), and the other side joins the held object (joinsTheHands). It is lashed only, never roped (a rope's
 * Rapier joint to a held body would hang from where that body was picked up), and only a light head the snap assist can
 * move (the free side ≤ lashSnapMaxKg, not elongated) onto the held side's end away from the hand; anything else is
 * refused 'handsFull'. Why not by aim, as on the ground: the held object follows the hand, and the work action's pose
 * (workLow) carries it 0.7 m down and forward between the command and the land, so a plan made from the aimed points at
 * the command could never be the plan at the land (RF-15); the head's placement relative to the held end is the same at
 * both.
 */
function planLash(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): LashPlan | RefuseReason | null {
  if (!f.inventory) return 'cantAct';
  const A = w.entities.get(cmd.target)!;
  const probe = stage === 'probe' && cmd.second === undefined;
  const B = cmd.second === undefined ? undefined : w.entities.get(cmd.second);
  if (!probe && !B) return 'noTarget';
  if (B && B.id === A.id) return 'noTarget';
  const ropeA = isRopeEntity(A);
  if (B && ropeA && isRopeEntity(B)) {
    const s = planSplice(w, f, A, B, cmd.at, cmd.at2, stage);
    return typeof s === 'string' ? s : { kind: 'splice', splice: s };
  }
  const hands = inTheHands(w, f);
  // Stowed, or the rope itself: not to be lashed.
  const stowed = (e: Entity): boolean => ownedBy(w, f, e.id) && !hands.includes(e.id);
  if (probe) {
    // A rope offers a splice with any rope the player has; anything else a lashing with a long enough coil.
    if (ropeA) return ropeSource(w, f) || heldRopeEnd(w, f) ? null : 'noRope';
    if (stowed(A)) return 'handsFull';
    const src = ropeSource(w, f);
    if (!src) return 'noRope';
    return ropeLength(w.entities.get(src.entity)!) < VERB_TUNING.lashRopeUseM - GEOM_EPS ? 'ropeTooShort' : null;
  }
  if (ropeA || isRopeEntity(B!)) return 'ropeLike';
  const aHeld = hands.includes(A.id);
  const bHeld = hands.includes(B!.id);
  if ((aHeld && bHeld) || stowed(A) || stowed(B!)) return 'handsFull';
  if (!cmd.at || !cmd.at2) return 'badAnchor';
  const src = ropeSource(w, f);
  if (!src) return 'noRope';
  // The anchors: the aimed points projected onto the two surfaces (§5.0: an anchor is on its entity).
  const pa = surfacePoint(w, A, cmdPoint(cmd.at));
  const pb = surfacePoint(w, B!, cmdPoint(cmd.at2));
  const faceAt = scale(add(pa, pb), 0.5);
  if (!inWorkReach(f, [pa, pb], faceAt, stage)) return 'outOfReach';
  // Snap assist, when the player aimed the two points together: the second onto the target first, else the target onto
  // the second.
  let snap: Snap | null = null;
  if (!aHeld && !bHeld && dist(cmdPoint(cmd.at), cmdPoint(cmd.at2)) <= VERB_TUNING.lashSnapM + GEOM_EPS) {
    const sb = snapOnto(w, B!, A);
    if (sb) snap = { moved: B!.id, pose: sb.pose, a: sb.onP, b: sb.onS };
    else {
      const sa = snapOnto(w, A, B!);
      if (sa) snap = { moved: A.id, pose: sa.pose, a: sa.onS, b: sa.onP };
    }
  }
  const held = aHeld ? 'a' : bHeld ? 'b' : null;
  if (held) {
    // A head lashed onto what the hands hold: snapped onto the held side's end away from the hand (see the DEVIATION).
    const P = held === 'a' ? A : B!;
    const O = held === 'a' ? B! : A;
    const ax = principalAxis(P.shape);
    const hand = handPoint(f);
    const far = (end: 1 | -1): number => dist(pointToWorld(P.pose, endCentre(P.shape, end)), hand);
    const s = isElongated(P) ? snapOnto(w, O, P, far(1) >= far(-1) || ax.max === ax.min ? 1 : -1) : null;
    if (!s) return 'handsFull';
    snap = held === 'a' ? { moved: O.id, pose: s.pose, a: s.onP, b: s.onS } : { moved: O.id, pose: s.pose, a: s.onS, b: s.onP };
  }
  const a = snap ? snap.a : { entity: A.id, local: pointToLocal(A.pose, pa) };
  const b = snap ? snap.b : { entity: B!.id, local: pointToLocal(B!.pose, pb) };
  const poseOf = (e: Entity): Pose3 => (snap && snap.moved === e.id ? snap.pose : e.pose);
  const wa = pointToWorld(poseOf(A), a.local);
  const wb = pointToWorld(poseOf(B!), b.local);
  const d = dist(wa, wb);
  const touching = d <= VERB_TUNING.lashTouchM + GEOM_EPS;
  if (held) {
    if (!touching) return 'handsFull';
    const r = joinsTheHands(w, f, held === 'a' ? B! : A, hands);
    if (r) return r;
  }
  const need = touching ? VERB_TUNING.lashRopeUseM : Math.max(VERB_TUNING.lashRopeUseM, d + ROPE_TUNING.knotAllowanceM);
  if (ropeLength(w.entities.get(src.entity)!) < need - GEOM_EPS) return 'ropeTooShort';
  return { kind: touching ? 'lash' : 'rope', a, b, snap, d, need, src, faceAt, mid: scale(add(wa, wb), 0.5), held };
}

const lash: VerbHandler = {
  verb: 'lash',
  target: 'entity',
  second: true,
  validate(w, f, cmd, stage) {
    const r = planLash(w, f, cmd, stage);
    return typeof r === 'string' ? r : null;
  },
  start(w, f, cmd) {
    const r = planLash(w, f, cmd, 'start');
    if (r === null || typeof r === 'string') return null;
    if (r.kind === 'splice') return workSpec(VERB_TUNING.spliceFrames, r.splice.faceAt, 'workLow');
    return workSpec(VERB_TUNING.lashFrames, r.faceAt, 'workLow');
  },
  land(w, f, cmd) {
    const r = planLash(w, f, cmd, 'land');
    if (r === null || typeof r === 'string') {
      verbEvent(w, f, 'lash', false, r ?? 'noTarget', cmd.target);
      return;
    }
    if (r.kind === 'splice') {
      doSplice(w, f, r.splice.keep, r.splice.gone);
      verbEvent(w, f, 'lash', true, undefined, r.splice.keep.id);
      return;
    }
    const A = w.entities.get(cmd.target)!;
    const B = w.entities.get(cmd.second!)!;
    if (r.snap) w.entities.setPose(w.entities.get(r.snap.moved)!, r.snap.pose);
    const piece = takeRope(w, f, r.src, r.need, r.mid);
    const credit = makerCredit(f);
    if (r.kind === 'lash') w.joints.lash(r.a, r.b, { entity: piece, lengthM: ropeLength(w.entities.get(piece)!) }, credit);
    else w.joints.rope(r.a, r.b, r.d, { entity: piece, lengthM: r.d }, credit);
    creditEntity(A, f);
    creditEntity(B, f);
    if (r.held) intoTheHands(w, f);
    verbEvent(w, f, 'lash', true, undefined, A.id);
  },
};

/**
 * What the hands hold grew by a lashing (planLash's held side): every member comes up into the hands ('held', its body
 * off, following the hand), and the hands wield it if it is now a tool (a flint lashed onto a stick: an axe), else carry
 * it.
 */
function intoTheHands(w: World, f: Fighter): void {
  const h = f.inventory?.hands;
  if (!h || (h.mode !== 'wield' && h.mode !== 'carry')) return;
  for (const id of heldMembers(w, h.entity)) {
    const m = w.entities.get(id)!;
    if (m.state !== 'held') w.entities.setState(m, 'held');
    creditEntity(m, f);
  }
  h.mode = toolClass(w, h.entity) ? 'wield' : 'carry';
  refreshHands(w, f);
}

// ---------------------------------------------------------------------------
// Tie (§5.8)
// ---------------------------------------------------------------------------

type TiePlan =
  | { kind: 'splice'; splice: SplicePlan }
  | { kind: 'coil'; src: RopeSource; anchor: Anchor; at: V3 }
  | { kind: 'end'; joint: JointRecord; anchor: Anchor; at: V3 };

/** The rope end a fighter's hands hold, and its joint; null when they hold none. */
export function heldRopeEnd(w: World, f: Fighter): { joint: JointRecord; end: 'a' | 'b'; rope: Entity } | null {
  const h = f.inventory?.hands;
  if (h?.mode !== 'ropeEnd' || h.joint === null) return null;
  const j = w.joints.get(h.joint);
  const rope = w.entities.get(h.entity);
  if (!j || !rope) return null;
  const end = j.a.fighter === f.id ? 'a' : j.b.fighter === f.id ? 'b' : null;
  return end ? { joint: j, end, rope } : null;
}

/** The tie a command makes, as planned from the world now; null: the radial's probe (no anchor) found nothing against it. */
function planTie(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): TiePlan | RefuseReason | null {
  const inv = f.inventory;
  if (!inv) return 'cantAct';
  const T = w.entities.get(cmd.target)!;
  const held = heldRopeEnd(w, f);
  if (inv.hands?.mode === 'ropeEnd' && !held) return 'noRopeEnd';
  const src = held ? null : ropeSource(w, f);
  if (!held && !src) return 'noRope';
  // Tying a coil puts its end in the hand: the hands hold it already, or are free for it.
  if (src && src.from === 'belt' && inv.hands) return 'handsFull';
  const mine = held ? held.rope : w.entities.get(src!.entity)!;
  if (isRopeEntity(T)) {
    const s = planSplice(w, f, mine, T, undefined, cmd.at, stage);
    return typeof s === 'string' ? s : { kind: 'splice', splice: s };
  }
  if (ownedBy(w, f, T.id)) return 'handsFull';
  if (!cmd.at) return stage === 'probe' ? null : 'badAnchor';
  // The anchor: the aimed point projected onto the target's surface (§5.0).
  const at = surfacePoint(w, T, cmdPoint(cmd.at));
  if (!inWorkReach(f, [at], at, stage)) return 'outOfReach';
  const anchor: Anchor = { entity: T.id, local: pointToLocal(T.pose, at) };
  if (held) {
    // Tied at the distance the tie lands at (§4.9): the rope must reach from its other end to the anchor.
    const other = held.end === 'a' ? held.joint.b : held.joint.a;
    const po = anchorPoint(w, other);
    if (po && dist(po, at) > ropeLength(held.rope) + GEOM_EPS) return 'ropeTooShort';
    return { kind: 'end', joint: held.joint, anchor, at };
  }
  if (stage === 'land' && dist(handPoint(f), at) > ropeLength(mine) + GEOM_EPS) return 'ropeTooShort';
  return { kind: 'coil', src: src!, anchor, at };
}

const tie: VerbHandler = {
  verb: 'tie',
  target: 'entity',
  validate(w, f, cmd, stage) {
    const r = planTie(w, f, cmd, stage);
    return typeof r === 'string' ? r : null;
  },
  start(w, f, cmd) {
    const r = planTie(w, f, cmd, 'start');
    if (r === null || typeof r === 'string') return null;
    if (r.kind === 'splice') return workSpec(VERB_TUNING.spliceFrames, r.splice.faceAt, 'workLow');
    return workSpec(VERB_TUNING.tieFrames, r.at, 'workLow');
  },
  land(w, f, cmd) {
    const r = planTie(w, f, cmd, 'land');
    if (r === null || typeof r === 'string') {
      verbEvent(w, f, 'tie', false, r ?? 'badAnchor', cmd.target);
      return;
    }
    const inv = f.inventory!;
    const T = w.entities.get(cmd.target)!;
    if (r.kind === 'splice') {
      doSplice(w, f, r.splice.keep, r.splice.gone);
      verbEvent(w, f, 'tie', true, undefined, r.splice.keep.id);
      return;
    }
    if (r.kind === 'end') {
      // The haul (pull.ts set it in the last phase 4d) holds through the tie; tying ends the pull.
      const j = r.joint;
      w.joints.tieHeldEnd(j.id, r.anchor);
      j.credit = [...new Set([...j.credit, ...makerCredit(f)])].sort();
      const rope = j.rope ? w.entities.get(j.rope.entity) : undefined;
      if (rope) creditEntity(rope, f);
      inv.hands = null;
      refreshHands(w, f);
      if (w.verbs.continuousOf(f)?.verb === 'pull') w.verbs.stopContinuous(f);
    } else {
      // The coil: a rope from the anchor to the hand, the end held, as long as the coil (paid out as he walks).
      const coil = w.entities.get(r.src.entity)!;
      detachSource(w, f, r.src);
      const L = ropeLength(coil);
      const hand = handPoint(f);
      const j = w.joints.rope(r.anchor, { entity: null, local: hand, fighter: f.id }, L, { entity: coil.id, lengthM: L }, makerCredit(f));
      creditEntity(coil, f);
      inv.hands = { entity: coil.id, mode: 'ropeEnd', grip: v(0, 0, 0), twoHanded: false, joint: j };
      refreshHands(w, f);
    }
    creditEntity(T, f);
    verbEvent(w, f, 'tie', true, undefined, T.id);
  },
};

// ---------------------------------------------------------------------------
// Untie (§5.8)
// ---------------------------------------------------------------------------

/** The joint of a rope to untie: its anchor (an entity's or a world point; not loose, not in a hand) nearest the chest. */
function planUntie(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): { joint: number; at: V3 } | RefuseReason {
  const R = w.entities.get(cmd.target)!;
  if (!isRopeEntity(R) || R.state !== 'tied') return 'notTied';
  const joints = ropeJoints(w, R.id);
  if (joints.length === 0) return 'notTied';
  const chest = chestPoint(f);
  let best: { joint: number; at: V3; d: number } | null = null;
  let owned = false;
  for (const j of joints) {
    for (const an of [j.a, j.b]) {
      if (an.loose || an.fighter !== undefined) continue;
      const p = anchorPoint(w, an);
      if (!p || !inWorkReach(f, [p], p, stage)) continue;
      if (an.entity !== null && ownedBy(w, f, an.entity)) {
        owned = true;
        continue;
      }
      const d = dist(p, chest);
      if (!best || d < best.d) best = { joint: j.id, at: p, d };
    }
  }
  if (!best) return owned ? 'handsFull' : 'outOfReach';
  return { joint: best.joint, at: best.at };
}

const untie: VerbHandler = {
  verb: 'untie',
  target: 'entity',
  validate(w, f, cmd, stage) {
    const r = planUntie(w, f, cmd, stage);
    return typeof r === 'string' ? r : null;
  },
  start(w, f, cmd) {
    const r = planUntie(w, f, cmd, 'start');
    return typeof r === 'string' ? null : workSpec(VERB_TUNING.untieFrames, r.at, 'workLow');
  },
  land(w, f, cmd) {
    const r = planUntie(w, f, cmd, 'land');
    if (typeof r === 'string') {
      verbEvent(w, f, 'untie', false, r, cmd.target);
      return;
    }
    const inv = f.inventory;
    if (inv?.hands?.mode === 'ropeEnd' && inv.hands.joint === r.joint) {
      inv.hands = null;
      refreshHands(w, f);
      if (w.verbs.continuousOf(f)?.verb === 'pull') w.verbs.stopContinuous(f);
    }
    // The joint store pushes the `joint … 'untie'` event and coils the rope once no joint is made of it.
    w.joints.remove(r.joint, 'untie');
    const rope = w.entities.get(cmd.target);
    if (rope) {
      creditEntity(rope, f);
      if (rope.state === 'free' && inv && !inv.hands) putInHands(w, f, rope.id);
    }
    verbEvent(w, f, 'untie', true, undefined, cmd.target);
  },
};

registerVerb(lash);
registerVerb(tie);
registerVerb(untie);
