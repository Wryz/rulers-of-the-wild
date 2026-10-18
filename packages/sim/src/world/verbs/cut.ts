// Cut (docs/M1-DESIGN.md §5.3): chops on standing trees (by the tool's fresh chop energy, fromDir from the chopper),
// cross-cuts of free wood across its axis, severing ropes; aimed committed swings through the strike seam.
//
// Cutting happens only when a blade meets something (strike.ts, the strike seam of §5.2): a qualifying strike (the
// head, swing power ≥ VERB_TUNING.minStrikePower, an edge that can cut the target) on
// - a rooted tree: `chopTree` deepens its notch by the chop depth (§5.2: chopDepthM × clamp(freshChopEnergy / refChopJ,
//   chopScaleMin, chopScaleMax), so a stone axe takes 15 chops on a 30 cm trunk, fresh or tired); the notch's side is
//   the horizontal from the trunk's axis to the chopper's root at the first chop (RT-22), and felling (P10) does the
//   rest in phase 13c;
// - a free elongated entity: `crossCutStrike` advances its cut across the axis by the same depth; through, the entity is
//   replaced by its two halves;
// - a rope's sensor: `severRope` removes the joint (`joint cut`) and splits the rope at the struck point.
// The `cut` verb (the radial's Cut, §5.3) is the tool's committed swing with the focus on the target (`aimedSwing`): the
// same strike path, so nothing is cut unless the blade meets it. Headless tests issue `{ verb: 'cut', target }` and get
// exactly the in-play behaviour.
//
// TODO "lengthwise split": "split a log" is a cross-cut in M1 (X13).
import type { Fighter } from '../../sim/fighter';
import { angleDelta } from '../../sim/math';
import { defineTuning } from '../../tuning/registry';
import { chopDepth } from '../felling';
import { ropeCoilShape } from '../factory';
import { JOINT_TUNING } from '../joints';
import { crossCut, GEOM_EPS, principalAxis, shapeContains, type ShapePiece } from '../shapes';
import type { Anchor, Entity, RefuseReason, SharpPoint, V3 } from '../types';
import type { World } from '../world';
import { creditEntity } from './hands';
import { registerVerb, verbEvent, type VerbHandler, type WorkSpec } from './targets';
import { canCut, freshChopEnergy, heldMembers, toolEdge, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

/**
 * The strike seam's and the aimed swing's own starting values (read by strike.ts, which imports this module; they live
 * here so cut.ts's aimed swing reads them without an import cycle). DEVIATION (P15): §13.0 adds no tuning table after
 * P05, but P05 registered none for these files and §9.1 has no row for these values (§5.2's table gives the reaction
 * frames inline: `stick`, w.bite, 12 and `rebound`, 2, 10, DS's clang); CLAUDE.md puts every starting value in a live
 * tuning table, so they live here (as P06's ENTITY_TUNING and P07's FACTORY_TUNING do).
 */
export const STRIKE_TUNING = defineTuning(
  'STRIKE_TUNING',
  'Verbs › strike',
  {
    stickRetract: 12,
    reboundHold: 2,
    reboundRetract: 10,
    unarmedLimbBones: 2,
    aimTurnTolDeg: 3,
  },
  {
    stickRetract: { unit: 'ticks', source: '§5.2 strike table (a chop, cut or dig sticks: `stick`, w.bite, 12)', min: 0, step: 1 },
    reboundHold: { unit: 'ticks', source: "§5.2 strike table (a push or clang rebounds: `rebound`, 2, 10; DS's clang)", min: 0, step: 1 },
    reboundRetract: { unit: 'ticks', source: "§5.2 strike table (a push or clang rebounds: `rebound`, 2, 10; DS's clang)", min: 0, step: 1 },
    unarmedLimbBones: {
      unit: 'bones of the striking limb, from its end',
      source:
        'NEW (P15 review, orchestrator decision; departs from §5.2\'s "strikeMassKg 6" for unarmed blows): the striker mass of an unarmed push is the striking limb\'s (boneMass): 2 = shin + thigh for a kick (13.5 kg at scale 1: J ≈ 41 N·s at 108 J, §5.2\'s 40 N·s), forearm + upper arm for a punch; 1 = the shin or the forearm alone',
      min: 1,
      max: 2,
      step: 1,
    },
    aimTurnTolDeg: {
      unit: '°',
      source: "NEW (P15 review): the radial's Cut and Dig turn at VERB_TUNING.faceTurnRate (§5.0) until the turn left is under this, then swing",
      min: 0,
      max: 180,
    },
  },
);

const { add, sub, scale, dot, cross, len, unit, rotate, pointToLocal } = verbGeom;
const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
const v3 = (p: { x: number; y: number; z: number }): V3 => ({ x: p.x, y: p.y, z: p.z });

/** The fighter's credit id as a list (creatures add none; SPEC:186, 473). */
function creditOf(f: Fighter): string[] {
  return f.playerId ? [f.playerId] : [];
}

/** Sorted, de-duplicated credit (SPEC:186, 473). */
function mergeCredit(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The depth one qualifying stroke of the held object `tool` cuts (§5.2, the chop depth rule), m. */
export function strokeDepthM(w: World, tool: number): number {
  return chopDepth(freshChopEnergy(w, tool));
}

// ---------------------------------------------------------------------------
// Chop a rooted tree (§2.5, §5.2)
// ---------------------------------------------------------------------------

/**
 * The horizontal unit from a trunk's axis to `p` (the chopper's root), RT-22: the notch's side, not the struck facet's
 * normal (which would snap the fall direction to the 8-gon's 45° steps). Falls back on `fallback` (horizontal) when `p`
 * is on the axis.
 */
export function sideOfAxis(e: Entity, p: V3, fallback: V3): V3 {
  const ax = principalAxis(e.shape);
  const d = unit(rotate(e.pose.q, ax.dir), UP);
  const r = sub(p, e.pose.p);
  const off = sub(r, scale(d, dot(r, d)));
  const h = Math.hypot(off.x, off.z);
  if (h > GEOM_EPS) return { x: off.x / h, y: 0, z: off.z / h };
  const fh = Math.hypot(fallback.x, fallback.z);
  return fh > GEOM_EPS ? { x: fallback.x / fh, y: 0, z: fallback.z / fh } : { x: 1, y: 0, z: 0 };
}

/**
 * A qualifying strike on a rooted tree (§5.2): felling.chop with fromDir from the trunk's axis to the chopper's root and
 * the tool's chop depth; a `chop` event at the struck point; a `cut` verb event (the stroke landed). Returns the notch's
 * remaining fraction.
 */
export function chopTree(w: World, f: Fighter, tree: number, point: V3, tool: number): number {
  const e = w.entities.get(tree)!;
  const back = { x: -Math.sin(f.yaw), y: 0, z: -Math.cos(f.yaw) };
  const fromDir = sideOfAxis(e, v3(f.pos), back);
  const r = w.felling.chop(tree, fromDir, strokeDepthM(w, tool), creditOf(f));
  w.events.push({ type: 'chop', tree, point: v3(point), remaining: r.remaining });
  verbEvent(w, f, 'cut', true, undefined, tree);
  return r.remaining;
}

// ---------------------------------------------------------------------------
// Cross-cut a free entity (§5.3)
// ---------------------------------------------------------------------------

/**
 * A qualifying strike on a free elongated entity (§5.3): its cut across the axis (`Entity.crossCut`: axisT along its
 * principal axis, `remaining` the fraction of its thickness, 2 × the shape's cross half-extent, still uncut, `fromDir`
 * the entity-local unit across the axis toward the side the blade went in) advances by the tool's chop depth; a strike
 * more than VERB_TUNING.crossCutRestartM from the stored axisT starts a new cut there. Through, the entity is replaced
 * by its two halves (splitAcross). A `crossCut` event (pieces null until through) and a `cut` verb event. Returns the
 * pieces' ids, or null while the cut goes on.
 */
export function crossCutStrike(w: World, f: Fighter, entity: number, point: V3, tool: number): number[] | null {
  const e = w.entities.get(entity)!;
  const ax = principalAxis(e.shape);
  const local = pointToLocal(e.pose, point);
  const t = Math.min(ax.max, Math.max(ax.min, dot(local, ax.dir)));
  const thickness = 2 * ax.crossHalf;
  let cc = e.crossCut;
  if (!cc || Math.abs(t - cc.axisT) > VERB_TUNING.crossCutRestartM) {
    // Across the axis toward the struck point (entity-local; the client draws the notch on that side, RR-15).
    const across = (q: V3): V3 => sub(q, scale(ax.dir, dot(q, ax.dir)));
    const fallback = unit(across(pointToLocal(e.pose, v3(f.pos))), verbGeom.perpendicular(ax.dir));
    cc = { axisT: t, remaining: 1, fromDir: unit(across(local), fallback) };
  }
  const depth = strokeDepthM(w, tool);
  cc = { axisT: cc.axisT, remaining: Math.max(0, cc.remaining - (thickness > 0 ? depth / thickness : 1)), fromDir: { ...cc.fromDir } };
  e.crossCut = cc;
  e.touched = true;
  creditEntity(e, f);
  let pieces: number[] | null = null;
  if (cc.remaining <= GEOM_EPS) pieces = splitAcross(w, e, cc.axisT, creditOf(f));
  w.events.push({ type: 'crossCut', entity, pieces: pieces ? [...pieces] : null });
  verbEvent(w, f, 'cut', true, undefined, entity);
  return pieces;
}

/**
 * The entity replaced by the two halves of `crossCut(shape, axisT)` (§5.3): ids in order (the min end first); material,
 * moisture, temperature, burning, age, look, integrity and credit (with the cutter's) inherited; each sharp point kept by
 * the piece holding it (else the nearest); velocities from the parent's body (v + ω × (c − com)); joints moved to the
 * piece holding their anchor (JointStore.transferAnchors). The parent is removed.
 */
function splitAcross(w: World, e: Entity, axisT: number, credit: readonly string[]): number[] {
  const pieces = crossCut(e.shape, axisT);
  const b = e.body;
  const live = !!b && b.isEnabled();
  const dyn = live && b.isDynamic();
  const pose = live ? { p: v3(b.translation()), q: { x: b.rotation().x, y: b.rotation().y, z: b.rotation().z, w: b.rotation().w } } : { p: { ...e.pose.p }, q: { ...e.pose.q } };
  const v = dyn ? v3(b.linvel()) : { ...e.vel.lin };
  const omega = dyn ? v3(b.angvel()) : { ...e.vel.ang };
  const com = dyn ? v3(b.worldCom()) : { ...pose.p };
  const ax = principalAxis(e.shape);
  const span = ax.max - ax.min + 2 * ax.crossHalf;
  const owner = e.sharpPoints.map((s) => pieceOf(pieces, s.local, span));
  const ids: number[] = [];
  const made: Entity[] = [];
  pieces.forEach((pc, i) => {
    const c = add(pose.p, rotate(pose.q, pc.offset));
    const sharpPoints: SharpPoint[] = [];
    e.sharpPoints.forEach((s, k) => {
      if (owner[k] === i) sharpPoints.push({ local: sub(s.local, pc.offset), dir: { ...s.dir }, sharpness: s.sharpness });
    });
    const piece = w.entities.create({
      material: e.material,
      shape: pc.shape,
      p: c,
      q: pose.q,
      lin: add(v, cross(omega, sub(c, com))),
      ang: omega,
      state: 'free',
      sharpPoints,
      look: e.look,
      credit: mergeCredit(e.credit, credit),
      integrity: e.integrity,
    });
    piece.moisture = e.moisture;
    piece.temperature = e.temperature;
    piece.burning = e.burning;
    piece.age = e.age;
    ids.push(piece.id);
    made.push(piece);
  });
  w.joints.transferAnchors(
    e.id,
    pieces.map((pc, i) => ({ entity: made[i].id, offset: pc.offset, shape: pc.shape })),
  );
  w.entities.remove(e.id);
  return ids;
}

/** The piece a parent-local point belongs to: the first whose shape holds it, else the one whose centre is nearest. */
function pieceOf(pieces: readonly ShapePiece[], local: V3, span: number): number {
  const tol = GEOM_EPS * span;
  for (let i = 0; i < pieces.length; i++) if (shapeContains(pieces[i].shape, sub(local, pieces[i].offset), tol)) return i;
  let best = 0;
  let bestD = Infinity;
  pieces.forEach((pc, i) => {
    const d = len(sub(local, pc.offset));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Sever a rope (§5.3)
// ---------------------------------------------------------------------------

/**
 * Where a rope piece's loose end lies (§5.3: "each end loose"): hanging from its attached end `a` straight down by its
 * length while that stays above the ground, else on the ground, the rest of its length laid out toward the cut point
 * (as a hanging vine's slack lies, factory hangVine). Rule 3: the piece hangs where it is drawn.
 */
function hangingEnd(w: World, a: V3, lengthM: number, toward: V3): V3 {
  const ground = w.terrain.heightAt(a.x, a.z);
  const drop = a.y - ground;
  if (lengthM < drop) return { x: a.x, y: a.y - lengthM, z: a.z };
  const out = lengthM - Math.max(0, drop);
  const h = Math.hypot(toward.x - a.x, toward.z - a.z);
  const dx = h > GEOM_EPS ? (toward.x - a.x) / h : 0;
  const dz = h > GEOM_EPS ? (toward.z - a.z) / h : 0;
  const x = a.x + out * dx;
  const z = a.z + out * dz;
  return { x, y: w.terrain.heightAt(x, z), z };
}

/** A coil spec of a rope-like material lying on the ground at (x, z) (as JointStore lays a rope that comes free). */
function coilAt(w: World, from: Entity, lengthM: number, at: V3, credit: readonly string[]): Entity {
  const shape = ropeCoilShape(lengthM);
  return w.entities.create({
    material: from.material,
    shape,
    p: { x: at.x, y: w.terrain.heightAt(at.x, at.z) + shape.halfHeight, z: at.z },
    rope: { lengthM },
    look: from.look,
    credit: mergeCredit(from.credit, credit),
  });
}

/**
 * A qualifying strike on a rope's sensor (§5.3: a tied rope, a lashing, a hanging vine): the joint is removed
 * (`joints.remove(id, 'cut')`, which pushes the `joint cut` event and releases what it held: a bent sapling springs
 * back); the rope splits at the struck point into two pieces of proportional length (by where the point lies between
 * the anchors), each keeping the anchor it was tied to with its other end loose (hangingEnd); a piece whose only end
 * was loose falls as a coil on the ground under the cut. The rope entity stays the piece on the first attached end (a
 * severed hanging vine's top keeps its id); the other piece is a new rope entity. A held end stays in its holder's hand
 * on its piece. The cutter's credit joins the pieces and their joints. Returns the rope entities of the pieces.
 */
export function severRope(w: World, f: Fighter, joint: number, point: V3): number[] {
  const j = w.joints.get(joint);
  if (!j?.rope) return [];
  const R = w.entities.get(j.rope.entity);
  const ends = w.joints.endPoints(j);
  if (!R || !ends) return [];
  const ab = sub(ends.b, ends.a);
  const L2 = dot(ab, ab);
  const t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(point, ends.a), ab) / L2)) : 0.5;
  const P = add(ends.a, scale(ab, t));
  const shared = w.joints.all().some((o) => o.id !== j.id && o.rope?.entity === R.id);
  const total = shared ? j.rope.lengthM : (R.rope?.lengthM ?? j.rope.lengthM);
  const lens = { a: total * t, b: total * (1 - t) };
  const credit = mergeCredit(j.credit, creditOf(f));
  const minLen = JOINT_TUNING.tautEps;
  const out: number[] = [];
  let reuse = !shared;
  // Tied pieces first, made before the cut joint goes, so the rope entity reused for one stays tied (never a coil).
  const tied: { end: 'a' | 'b'; anchor: Anchor; rope: number; joint: number }[] = [];
  for (const end of ['a', 'b'] as const) {
    const an = j[end];
    const lengthM = lens[end];
    if (an.loose || !(lengthM >= minLen)) continue;
    const at = end === 'a' ? ends.a : ends.b;
    let ropeId: number;
    if (reuse) {
      reuse = false;
      ropeId = R.id;
      R.rope = { lengthM };
      w.entities.reshape(R, ropeCoilShape(lengthM));
      R.credit = mergeCredit(R.credit, creditOf(f));
    } else ropeId = coilAt(w, R, lengthM, P, creditOf(f)).id;
    const loose: Anchor = { entity: null, local: hangingEnd(w, at, lengthM, P), loose: true };
    const anchor: Anchor = { entity: an.entity, local: { ...an.local } };
    if (an.fighter !== undefined) anchor.fighter = an.fighter;
    const nj = w.joints.rope(anchor, loose, lengthM, { entity: ropeId, lengthM }, credit);
    tied.push({ end, anchor, rope: ropeId, joint: nj });
    out.push(ropeId);
  }
  if (shared && R.rope) R.rope = { lengthM: Math.max(minLen, R.rope.lengthM - total) };
  w.joints.remove(j.id, 'cut');
  // The piece whose only end was loose falls as a coil under the cut (the rope entity itself, when no tied piece took it).
  for (const end of ['a', 'b'] as const) {
    const lengthM = lens[end];
    if (!j[end].loose || !(lengthM >= minLen)) continue;
    if (reuse && w.entities.get(R.id)) {
      reuse = false;
      R.rope = { lengthM };
      R.credit = mergeCredit(R.credit, creditOf(f));
      w.entities.reshape(R, ropeCoilShape(lengthM));
      const shape = R.shape as ReturnType<typeof ropeCoilShape>;
      w.entities.setPose(R, { p: { x: P.x, y: w.terrain.heightAt(P.x, P.z) + shape.halfHeight, z: P.z }, q: { x: 0, y: 0, z: 0, w: 1 } });
      out.push(R.id);
    } else out.push(coilAt(w, R, lengthM, P, creditOf(f)).id);
  }
  // A held end stays in its holder's hand, on its piece.
  for (const p of tied) {
    if (p.anchor.fighter === undefined) continue;
    const holder = w.combat.fighters.find((x) => x.id === p.anchor.fighter);
    const hands = holder?.inventory?.hands;
    if (!holder || !hands || hands.mode !== 'ropeEnd' || hands.joint !== joint) continue;
    hands.entity = p.rope;
    hands.joint = p.joint;
    w.verbs.refreshHands(holder);
  }
  verbEvent(w, f, 'cut', true, undefined, R.id);
  return out;
}

// ---------------------------------------------------------------------------
// The aimed committed swing (the radial's Cut and Dig, §5.3, §5.10)
// ---------------------------------------------------------------------------

/**
 * The turn before an aimed swing (§5.0: a work action "turns toward faceAt by VERB_TUNING.faceTurnRate of the remaining
 * angle per tick"): a work action that only turns the fighter (its faceAt along the aim, nearer than standOffM, so
 * CombatSim's faceWork steps no closer: a chop needs its stand-off) until the turn left is under
 * STRIKE_TUNING.aimTurnTolDeg, landing at actAt with the swing. null when the fighter already faces the aim (or can't
 * turn: faceTurnRate 0), so the swing starts now. The aim is the fighter's verbAim (set by setFocus).
 */
export function aimTurn(f: Fighter): WorkSpec | null {
  const aim = f.verbAim;
  if (!aim) return null;
  const dx = aim.x - f.pos.x;
  const dz = aim.z - f.pos.z;
  const d = Math.hypot(dx, dz);
  if (!(d > GEOM_EPS)) return null;
  const left = Math.abs(angleDelta(f.yaw, Math.atan2(dx, dz)));
  const tol = (Math.max(0, STRIKE_TUNING.aimTurnTolDeg) * Math.PI) / 180;
  const rate = VERB_TUNING.faceTurnRate;
  if (left <= tol || !(rate > 0)) return null;
  // faceWork turns on frames 1 .. actAt − 1: n turns leave left × (1 − rate)^n.
  const turns = rate >= 1 || !(tol > 0) ? 1 : Math.max(1, Math.ceil(Math.log(tol / left) / Math.log(1 - rate)));
  const reach = 0.5 * VERB_TUNING.standOffM * f.scale;
  const k = Math.min(d, reach) / d;
  return { frames: turns + 1, actAt: turns + 1, faceAt: { x: f.pos.x + dx * k, y: f.pos.y, z: f.pos.z + dz * k }, keys: [] };
}

/**
 * The wielded tool's committed swing (E: its class's heavy technique, §5.2) as a pressed E starts it (DS
 * tryBufferedAttack: startMove, `attackStart`), from a work action's landing too (the fighter is then in 'pickup', not
 * free). The strike seam decides the outcome. Returns null when the swing started, else why it couldn't.
 */
export function committedSwing(w: World, f: Fighter): RefuseReason | null {
  const weapon = f.weapon;
  const move = weapon ? f.moveDef(weapon.heavy) : undefined;
  if (!move || !f.canUse(move) || f.load?.mode === 'carry') return 'cantAct';
  f.startMove(move, false);
  w.combat.events.push({ type: 'attackStart', f, move });
  return null;
}

/**
 * The radial's aimed swing (§5.3, §5.10) begins: the focus is set on the target as the client's highlight sets it
 * (VerbSystem.setFocus: verbAim follows it, so the swing goes at it, §5.2), then the fighter turns to it at
 * faceTurnRate (aimTurn's work action, whose landing swings) or, already facing it, swings now. Returns the turn's
 * work action, or null (the swing started, or `refused` says why not).
 */
export function aimedSwing(w: World, f: Fighter, target: number, at: V3 | null, verb: 'cut' | 'dig'): WorkSpec | null {
  w.verbs.setFocus(f, target, at);
  const turn = aimTurn(f);
  if (turn) return turn;
  const r = committedSwing(w, f);
  if (r) verbEvent(w, f, verb, false, r, target);
  return null;
}

/** The entity the fighter wields (its hands' entity in 'wield' mode), or null. */
export function wieldedEntity(f: Fighter): number | null {
  const h = f.inventory?.hands;
  return h && h.mode === 'wield' ? h.entity : null;
}

/**
 * cut (§5.0, §5.3): `{ verb: 'cut', target }`. Needs an edge that can cut the target (§5.0's "can cut X": the wielded
 * object's edge, `edgeHardness − X.hardness ≥ cutHardnessMargin`); refused `noEdge` without one, `tooHard` when it can't
 * cut that material. Acting is the aimed committed swing at the target (aimedSwing: a turn at faceTurnRate, then the
 * swing): the stroke's effect is the strike seam's, and its `cut` verb event is pushed where it lands.
 */
const cutVerb: VerbHandler = {
  verb: 'cut',
  target: 'entity',
  validate(w, f, cmd) {
    const tool = wieldedEntity(f);
    if (tool === null || !toolEdge(w, tool)) return 'noEdge';
    if (heldMembers(w, tool).includes(cmd.target)) return 'noTarget';
    const e = w.entities.get(cmd.target);
    if (!e) return 'noTarget';
    return canCut(w, tool, e.id) ? null : 'tooHard';
  },
  start(w, f, cmd) {
    return aimedSwing(w, f, cmd.target, null, 'cut');
  },
  land(w, f, cmd) {
    const r = committedSwing(w, f);
    if (r) verbEvent(w, f, 'cut', false, r, cmd.target);
  },
};

registerVerb(cutVerb);
