// Hands, belt and back (docs/M1-DESIGN.md §5.1, §2.12): take, drop, stow, draw, carry, drag, forced release, credit.
// The world calls `weaponDropped` (WorldPort.onWeaponDropped); the VerbSystem (index.ts) calls the rest; the other verb
// modules use `letGo` (place, throw), `refreshHands` (shape) and the hand points.
//
// - Wielded and carried objects (every member of the held object, tools.ts) are `held`: their bodies are disabled and
//   their record poses follow the hand frame each tick (phase 4b, syncHands). A wielded tool's grip sits in the right
//   fist along the blade direction of the pose, its head's point or edge leading; a carried load sits in front of the
//   chest across the body, or on the shoulder along it when it is longer than twoHandCarryLenM.
// - A dragged object stays dynamic: the grip is the end of its long axis nearer the chest; phase 4d pulls it by
//   dragImpulse and the mover's tether keeps the player within tetherM of it (§5.1, [B lab: drag.ts]).
// - A held rope end is the joint store's (holdEnd, dropEnd); the tether keeps the hand within the rope's free length.
// - Letting go (drop, KO, knockdown, place, throw): the members come back at the hand pose (or the pose asked for) with
//   the fighter's walkVel + vel, and are `released` (no contact with that fighter is scored until apart 2 ticks, RF-3).
// - Credit (SPEC:186, 473): taking, dragging and letting go move an entity, so each appends the player's id.
import { Vector3 } from 'three';
import type { TrackKey } from '../../body/animator';
import { getPose, type PoseName } from '../../body/poses';
import type { Fighter } from '../../sim/fighter';
import { DT } from '../../sim/math';
import { bladeFrame, WEAPONS } from '../../sim/weapons';
import { propertyAtMost } from '../materials';
import { GEOM_EPS, principalAxis } from '../shapes';
import type { Entity, Inventory, Pose3, PostureId, V3 } from '../types';
import type { World } from '../world';
import { WORLD_TUNING } from '../worldTuning';
import { anchorPoint, backSlot, chestPoint, handPoint, registerVerb, ropeJoints, verbEvent, type VerbHandler, type WorkSpec } from './targets';
import { heldMembers, heldShape, isElongated, isRooted, isRopeEntity, synthWeapon, takeMode, toolClass, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

type Hands = NonNullable<Inventory['hands']>;

const { add, sub, scale, dot, cross, len, unit, rotate, conj, mulQuat, quatFromBasis, perpendicular } = verbGeom;
const zero = (): V3 => ({ x: 0, y: 0, z: 0 });
const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
const finite = (p: V3): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Postures the hands set (and clear when they change); a mind's postures are left alone. */
const HAND_POSTURES: ReadonlySet<PostureId> = new Set<PostureId>(['carryFront', 'carryShoulder', 'dragBack', 'haulRope']);

// ---------------------------------------------------------------------------
// Credit
// ---------------------------------------------------------------------------

/** Appends the fighter's player id to the entity's credit (sorted, de-duplicated; SPEC:186, 473). Creatures add none. */
export function creditEntity(e: Entity, f: Fighter): void {
  const id = f.playerId;
  if (!id || e.credit.includes(id)) return;
  e.credit = [...e.credit, id].sort();
  e.touched = true;
}

// ---------------------------------------------------------------------------
// What the hands hold: derived fields, poses, letting go
// ---------------------------------------------------------------------------

/**
 * Derives what follows from the hands (§1.5.3 `load`, §5.2 `Fighter.weapon`): a wielded tool's WeaponDef (synthWeapon,
 * so a reshaped or re-lashed tool is re-read; one no longer a tool becomes a carried load), the load's mass and mode
 * for the carry curve, two-handedness, the grip, and the carry and drag postures. Call it whenever the hands or the
 * held object change.
 */
export function refreshHands(w: World, f: Fighter): void {
  const inv = f.inventory;
  if (!inv) return;
  const setPosture = (id: PostureId | null): void => {
    if (id) f.posture = { id, weight: 1 };
    else if (f.posture && HAND_POSTURES.has(f.posture.id)) f.posture = null;
  };
  const h = inv.hands;
  const e = h ? w.entities.get(h.entity) : undefined;
  if (!h || !e) {
    inv.hands = null;
    f.weapon = null;
    f.load = null;
    setPosture(null);
    return;
  }
  switch (h.mode) {
    case 'wield': {
      const cls = toolClass(w, e.id);
      if (cls) {
        f.weapon = synthWeapon(w, e.id, cls);
        f.load = null;
        h.twoHanded = f.weapon.style === 'twoHand';
        h.grip = heldShape(w, e.id).grip;
        setPosture(null);
        return;
      }
      // No longer a tool (a member came off, it was reshaped): carried.
      h.mode = 'carry';
      refreshHands(w, f);
      return;
    }
    case 'carry': {
      const hs = heldShape(w, e.id);
      const long = hs.lengthM > VERB_TUNING.twoHandCarryLenM;
      f.weapon = null;
      f.load = { massKg: hs.massKg, mode: 'carry' };
      h.twoHanded = long || hs.massKg > VERB_TUNING.twoHandCarryKg;
      h.grip = hs.grip;
      setPosture(long ? 'carryShoulder' : 'carryFront');
      return;
    }
    case 'drag':
      f.weapon = null;
      f.load = { massKg: heldShape(w, e.id).massKg, mode: 'drag' };
      h.twoHanded = true;
      setPosture('dragBack');
      return;
    case 'ropeEnd':
      f.weapon = null;
      f.load = { massKg: e.mass, mode: 'rope' };
      h.twoHanded = false;
      // Hauling (posture haulRope) is the pull verb's to set and clear.
      if (f.posture?.id !== 'haulRope') setPosture(null);
      return;
  }
}

/**
 * Where the held entity is while wielded or carried (§2.12): a tool's grip in the right fist, its axis along the pose's
 * blade direction and its head's point or edge leading (toward the fighter's front); a load's centre in front of the
 * chest across the body, or on the right shoulder along the facing when it is longer than twoHandCarryLenM.
 */
export function heldPose(w: World, f: Fighter, h: Hands): Pose3 | null {
  const e = w.entities.get(h.entity);
  if (!e) return null;
  const hs = heldShape(w, e.id);
  const t = VERB_TUNING;
  const s = f.scale;
  const fwd: V3 = { x: Math.sin(f.yaw), y: 0, z: Math.cos(f.yaw) };
  // Fighter-local +x, the lead (left) side (weapons.ts bladeFrame's convention).
  const left: V3 = { x: Math.cos(f.yaw), y: 0, z: -Math.sin(f.yaw) };
  const pos: V3 = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
  let yW: V3;
  let zW: V3;
  let at: V3;
  let anchor: V3;
  if (h.mode === 'wield') {
    const grip = new Vector3();
    const dir = new Vector3();
    bladeFrame(f, grip, dir);
    yW = unit({ x: dir.x, y: dir.y, z: dir.z }, fwd);
    const ahead = sub(fwd, scale(yW, dot(fwd, yW)));
    zW = len(ahead) > GEOM_EPS ? unit(ahead) : perpendicular(yW);
    at = { x: grip.x, y: grip.y, z: grip.z };
    anchor = hs.grip;
  } else {
    const long = hs.lengthM > t.twoHandCarryLenM;
    zW = { ...UP };
    if (long) {
      yW = fwd;
      at = add(add(pos, scale(UP, t.carryShoulderUpM * s)), scale(left, -t.carryShoulderSideM * s));
    } else {
      yW = left;
      at = add(add(pos, scale(UP, t.carryFrontUpM * s)), scale(fwd, t.carryFrontFwdM * s));
    }
    anchor = hs.centre;
  }
  const xW = cross(yW, zW);
  // The object's own frame: y along its axis (grip → head), z toward its head's point or edge, x = y × z.
  const yL = hs.axis;
  const toward = hs.head ? sub(hs.head.dir, scale(yL, dot(hs.head.dir, yL))) : zero();
  const zL = len(toward) > GEOM_EPS ? unit(toward) : perpendicular(yL);
  const xL = cross(yL, zL);
  const q = mulQuat(quatFromBasis(xW, yW, zW), conj(quatFromBasis(xL, yL, zL)));
  const p = sub(at, rotate(q, anchor));
  return finite(p) ? { p, q } : null;
}

/**
 * Phase 4b, one fighter: the held entity and its members follow the hand (record poses only: their bodies are
 * disabled). Hands whose entity is gone, or no longer in the state the hands left it in (broken, removed, taken over by
 * another system), are emptied.
 */
export function syncHands(w: World, f: Fighter): void {
  const inv = f.inventory;
  const h = inv?.hands;
  if (!inv || !h) return;
  const e = w.entities.get(h.entity);
  const lost = (): void => {
    inv.hands = null;
    refreshHands(w, f);
  };
  if (!e) return lost();
  switch (h.mode) {
    case 'drag':
      // Still gripped whatever happens to it (a dragged log that gets staked stays in the hands, its pull spent on a
      // fixed body); only its disappearance (broken, cut, removed) empties the hands.
      return;
    case 'ropeEnd':
      if (h.joint === null || !w.joints.get(h.joint)) lost();
      return;
    case 'wield':
    case 'carry': {
      if (e.state !== 'held') return lost();
      const pose = heldPose(w, f, h);
      if (!pose) return;
      const base = e.pose;
      for (const id of heldMembers(w, e.id)) {
        const m = w.entities.get(id)!;
        if (m.state !== 'held') continue;
        m.pose = m === e ? pose : verbGeom.compose(pose, verbGeom.relative(base, m.pose));
      }
    }
  }
}

/** What letting go of the held object does with it (place and throw pass a pose, a state or velocities). */
export interface LetGo {
  /** The members' state: 'free' (a dynamic body, awake; default) or 'projectile' (no body: a DS projectile, §5.11). */
  state?: 'free' | 'projectile';
  /** The held entity's new pose; its members keep their place relative to it. Default: where the hand holds it. */
  pose?: Pose3;
  /** Default: the fighter's walkVel + vel (§5.1). */
  lin?: V3;
  /** Default: zero. */
  ang?: V3;
}

/**
 * Empties the hands (§5.1 drop; forced release; place and throw): a wielded or carried object's members get their pose,
 * velocity and state, are released by the fighter and credited; a dragged object is let go where it lies; a held rope
 * end becomes loose at the hand (joints.dropEnd). Returns the entities let go of, in id order.
 */
export function letGo(w: World, f: Fighter, o: LetGo = {}): number[] {
  const inv = f.inventory;
  const h = inv?.hands;
  if (!inv || !h) return [];
  const e = w.entities.get(h.entity);
  inv.hands = null;
  let out: number[] = [];
  if (e) {
    switch (h.mode) {
      case 'wield':
      case 'carry': {
        const members = heldMembers(w, e.id);
        const base = e.pose;
        const rels = members.map((id) => verbGeom.relative(base, w.entities.get(id)!.pose));
        const lin = o.lin ?? { x: f.walkVel.x + f.vel.x, y: f.walkVel.y + f.vel.y, z: f.walkVel.z + f.vel.z };
        const ang = o.ang ?? zero();
        members.forEach((id, i) => {
          const m = w.entities.get(id)!;
          if (o.pose) m.pose = verbGeom.compose(o.pose, rels[i]);
          m.vel = { lin: { ...lin }, ang: { ...ang } };
          if (m.state === 'held') w.entities.setState(m, o.state ?? 'free');
          w.entities.release(m, f.id);
          creditEntity(m, f);
        });
        out = members;
        break;
      }
      case 'drag':
        creditEntity(e, f);
        out = [e.id];
        break;
      case 'ropeEnd':
        if (h.joint !== null && w.joints.get(h.joint)) w.joints.dropEnd(h.joint, handPoint(f));
        out = [e.id];
        break;
    }
  }
  refreshHands(w, f);
  return out;
}

/** The end of an entity's long axis nearer the fighter's chest, in the entity's frame (§5.1: the drag grip). */
export function dragGrip(w: World, f: Fighter, entity: number): V3 {
  const e = w.entities.get(entity)!;
  const ax = principalAxis(e.shape);
  const lo = scale(ax.dir, ax.min);
  const hi = scale(ax.dir, ax.max);
  const c = chestPoint(f);
  const dLo = len(sub(verbGeom.pointToWorld(e.pose, lo), c));
  const dHi = len(sub(verbGeom.pointToWorld(e.pose, hi), c));
  return dHi < dLo ? hi : lo;
}

/** Puts the free object `entity` into the hands at once, held as `take` would hold it (no work action). */
function hold(w: World, f: Fighter, entity: number, mode: 'wield' | 'carry' | 'drag'): void {
  const inv = f.inventory!;
  const members = heldMembers(w, entity);
  if (mode === 'drag') {
    inv.hands = { entity, mode, grip: dragGrip(w, f, entity), twoHanded: true, joint: null };
    for (const id of members) creditEntity(w.entities.get(id)!, f);
    return;
  }
  for (const id of members) {
    const m = w.entities.get(id)!;
    w.entities.setState(m, 'held');
    creditEntity(m, f);
  }
  inv.hands = { entity, mode, grip: heldShape(w, entity).grip, twoHanded: false, joint: null };
}

/**
 * Into the hands at once, no work action (the dev panel's give-tool, tests): the free object `entity` is wielded,
 * carried or dragged as `take` would (§5.1); whatever the hands held is let go of first. False when it can't be taken.
 */
export function putInHands(w: World, f: Fighter, entity: number): boolean {
  const e = w.entities.get(entity);
  if (!f.inventory || !e || e.state !== 'free' || isRooted(e) || w.entities.isAnchored(e)) return false;
  const plan = takeMode(w, entity, f.scale);
  if (!plan) return false;
  if (f.inventory.hands) letGo(w, f, {});
  hold(w, f, entity, plan.mode);
  refreshHands(w, f);
  return true;
}

// ---------------------------------------------------------------------------
// Drag forces and the tether (§5.1)
// ---------------------------------------------------------------------------

/**
 * The impulse a hand dragging `entity` by `grip` (entity frame) gives it this tick, at the grip's world point (§5.1,
 * [B lab: drag.ts]): horizontally a PD toward a point dragHandOffsetM behind the hand, damped against half the walk
 * velocity, capped at `capN`; vertically a lift toward liftHandM above the feet, capped at dragLiftFrac of the held
 * object's weight. Null when the entity has no awake-able dynamic body.
 */
export function dragImpulse(w: World, f: Fighter, entity: number, grip: V3, capN: number): { j: V3; at: V3 } | null {
  const e = w.entities.get(entity);
  const b = e?.body;
  if (!e || !b || !b.isEnabled() || !b.isDynamic()) return null;
  const t = VERB_TUNING;
  const s = f.scale;
  const g = verbGeom.pointToWorld(e.pose, grip);
  const c = b.worldCom();
  const gv = add(e.vel.lin, cross(e.vel.ang, sub(g, { x: c.x, y: c.y, z: c.z })));
  const hand: V3 = { x: f.pos.x, y: f.pos.y + t.liftHandM * s, z: f.pos.z };
  let ux = hand.x - g.x;
  let uz = hand.z - g.z;
  const d = Math.hypot(ux, uz);
  if (d > GEOM_EPS) {
    ux /= d;
    uz /= d;
  } else {
    ux = Math.sin(f.yaw);
    uz = Math.cos(f.yaw);
  }
  const tx = hand.x - ux * t.dragHandOffsetM * s;
  const tz = hand.z - uz * t.dragHandOffsetM * s;
  let fx = t.dragKp * (tx - g.x) - t.dragKd * (gv.x - f.walkVel.x / 2);
  let fz = t.dragKp * (tz - g.z) - t.dragKd * (gv.z - f.walkVel.z / 2);
  const fh = Math.hypot(fx, fz);
  if (fh > capN) {
    fx *= capN / fh;
    fz *= capN / fh;
  }
  const weight = heldShape(w, entity).massKg * -WORLD_TUNING.gravityY;
  const fy = Math.max(0, Math.min(t.dragLiftFrac * weight, t.liftKp * (hand.y - g.y) - t.liftKd * gv.y));
  return { j: { x: fx * DT, y: fy * DT, z: fz * DT }, at: g };
}

/** Moves a proposal (in place) so it is at most `maxH` horizontally from `to`. */
export function tetherTo(proposal: Vector3, to: V3, maxH: number): void {
  const dx = proposal.x - to.x;
  const dz = proposal.z - to.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxH) return;
  const k = Math.max(0, maxH) / d;
  proposal.x = to.x + dx * k;
  proposal.z = to.z + dz * k;
}

/**
 * The hands' tether on the mover's proposal (§5.1, §5.12): dragging, the player stays within tetherM of the grip, so
 * he walks at the speed the load allows; holding a rope end, the hand stays within the rope's free length of its other
 * end.
 */
export function tetherHands(w: World, f: Fighter, proposal: Vector3): void {
  const h = f.inventory?.hands;
  if (!h) return;
  if (h.mode === 'drag') {
    const e = w.entities.get(h.entity);
    if (e) tetherTo(proposal, verbGeom.pointToWorld(e.pose, h.grip), VERB_TUNING.tetherM * f.scale);
    return;
  }
  if (h.mode !== 'ropeEnd' || h.joint === null) return;
  const j = w.joints.get(h.joint);
  if (!j?.rope) return;
  const other = j.a.fighter === f.id ? j.b : j.b.fighter === f.id ? j.a : null;
  if (!other || other.fighter !== undefined) return;
  const a = anchorPoint(w, other);
  if (!a) return;
  const L = j.rope.lengthM;
  const dy = proposal.y + WORLD_TUNING.chestHeightM * f.scale - a.y;
  tetherTo(proposal, a, Math.sqrt(Math.max(0, L * L - dy * dy)));
}

// ---------------------------------------------------------------------------
// Rope ends (§5.1: "a rope's loose end or a hanging vine's end → ropeEnd")
// ---------------------------------------------------------------------------

/** The loose end of a tied rope nearest the chest within targetRadiusM: its joint, which end, where it lies. */
export function ropeEndInReach(w: World, f: Fighter, rope: number): { joint: number; end: 'a' | 'b'; point: V3 } | null {
  const c = chestPoint(f);
  let best: { joint: number; end: 'a' | 'b'; point: V3 } | null = null;
  let bestD = Infinity;
  for (const j of ropeJoints(w, rope)) {
    for (const end of ['a', 'b'] as const) {
      const a = j[end];
      if (!a.loose) continue;
      const p = { x: a.local.x, y: a.local.y, z: a.local.z };
      const d = len(sub(p, c));
      if (d <= VERB_TUNING.targetRadiusM && d < bestD) {
        best = { joint: j.id, end, point: p };
        bestD = d;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

/** Is a held object of this mode held in both hands? */
function twoHandedFor(w: World, entity: number, mode: 'wield' | 'carry' | 'drag'): boolean {
  if (mode === 'drag') return true;
  if (mode === 'wield') {
    const cls = toolClass(w, entity);
    return !!cls && WEAPONS[cls].style === 'twoHand';
  }
  const hs = heldShape(w, entity);
  return hs.lengthM > VERB_TUNING.twoHandCarryLenM || hs.massKg > VERB_TUNING.twoHandCarryKg;
}

/** The pose the body rises into once it has hold of something. */
function holdPose(w: World, entity: number, mode: 'wield' | 'carry' | 'drag' | null, two: boolean): PoseName {
  if (mode === 'wield') return two ? 'wGuard2' : 'wGuard1';
  if (mode === 'carry') return heldShape(w, entity).lengthM > VERB_TUNING.twoHandCarryLenM ? 'carryShoulder' : 'carryFront';
  if (mode === 'drag') return 'dragBack';
  return 'guard';
}

/** A short action that lands at once (stow, draw) or has already landed (drop): the body settles back to its guard. */
function quickWork(f: Fighter, frames: number, actAt: number): WorkSpec {
  const keys: TrackKey[] = [{ f: frames, pose: getPose('guard'), ease: 'inOut' }];
  return { frames, actAt, faceAt: { x: f.pos.x, y: f.pos.y, z: f.pos.z }, keys };
}

/** A slot number a stow or draw command may name: a belt slot in use, or the back. */
function validSlot(f: Fighter, slot: number | undefined): slot is number {
  if (slot === undefined || !Number.isInteger(slot)) return false;
  return slot === backSlot(f) || (slot >= 0 && slot < Math.min(VERB_TUNING.beltSlots, backSlot(f)));
}

/** take (§5.1): wield a tool, carry ≤ 40 kg × scale², drag ≤ 150 kg × scale², or take a rope's loose end. */
const take: VerbHandler = {
  verb: 'take',
  target: 'entity',
  validate(w, f, cmd) {
    const inv = f.inventory;
    if (!inv) return 'cantAct';
    const e = w.entities.get(cmd.target)!;
    if (isRopeEntity(e) && e.state === 'tied') return ropeEndInReach(w, f, e.id) ? null : 'noRopeEnd';
    if (inv.hands && heldMembers(w, inv.hands.entity).includes(e.id)) return 'handsFull';
    if (e.state !== 'free' || isRooted(e) || w.entities.isAnchored(e)) return 'immovable';
    for (const id of heldMembers(w, e.id)) {
      const m = w.entities.get(id)!;
      if (m.state !== 'free' || isRooted(m)) return 'immovable';
    }
    return takeMode(w, e.id, f.scale) ? null : 'tooHeavy';
  },
  start(w, f, cmd) {
    const t = VERB_TUNING;
    const e = w.entities.get(cmd.target)!;
    const end = isRopeEntity(e) && e.state === 'tied' ? ropeEndInReach(w, f, e.id) : null;
    const plan = end ? null : takeMode(w, e.id, f.scale);
    const mass = plan ? plan.massKg : e.mass;
    const frames = Math.max(1, Math.round(t.takeFramesBase + t.takeFramesPerKg * mass));
    const actAt = Math.max(1, Math.min(frames, Math.round(frames * t.takeGrabFrac)));
    const faceAt = end ? end.point : w.queries.projectPoint(e.id, chestPoint(f)).point;
    const two = plan ? twoHandedFor(w, e.id, plan.mode) : false;
    const low = getPose(two ? 'pickupLow2' : 'pickupLow1');
    const keys: TrackKey[] = [
      { f: actAt, pose: low, ease: 'inOut' },
      { f: Math.min(frames, actAt + t.takeHoldFrames), pose: low },
      { f: frames, pose: getPose(holdPose(w, e.id, plan?.mode ?? null, two)), ease: 'inOut' },
    ];
    return { frames, actAt, faceAt, keys };
  },
  land(w, f, cmd) {
    const inv = f.inventory!;
    const e = w.entities.get(cmd.target)!;
    const end = isRopeEntity(e) && e.state === 'tied' ? ropeEndInReach(w, f, e.id) : null;
    const plan = end ? null : takeMode(w, e.id, f.scale);
    // What the hands hold goes first: a tool is swapped, landing where the new thing lay (DS tryPickup, combat.ts),
    // dropped from above it by its own size; a load (or a tool, for a rope end) is let go of at the hand.
    const old = inv.hands;
    if (old && old.mode === 'wield' && plan) {
      const oldE = w.entities.get(old.entity);
      if (oldE) {
        const hs = heldShape(w, oldE.id);
        const lift = len(hs.centre) + hs.lengthM / 2 + hs.crossHalfM;
        letGo(w, f, { pose: { p: { x: e.pose.p.x, y: e.pose.p.y + lift, z: e.pose.p.z }, q: { ...oldE.pose.q } }, lin: zero() });
      } else letGo(w, f, {});
    } else if (old) letGo(w, f, {});
    if (end) {
      w.joints.holdEnd(end.joint, end.end, f.id);
      inv.hands = { entity: e.id, mode: 'ropeEnd', grip: zero(), twoHanded: false, joint: end.joint };
      creditEntity(e, f);
    } else if (plan) hold(w, f, e.id, plan.mode);
    refreshHands(w, f);
    verbEvent(w, f, 'take', true, undefined, e.id);
  },
};

/** drop (§5.1): let go of what the hands hold, at the hand; any state (a 12-frame action when free). */
const drop: VerbHandler = {
  verb: 'drop',
  target: 'none',
  anyState: true,
  validate(_w, f) {
    if (!f.inventory) return 'cantAct';
    return f.inventory.hands ? null : 'handsEmpty';
  },
  start(w, f) {
    const id = f.inventory!.hands!.entity;
    letGo(w, f, {});
    verbEvent(w, f, 'drop', true, undefined, id);
    // Already landed: actAt 0 never comes round (stateFrame starts at 1 in the action).
    return quickWork(f, VERB_TUNING.dropFrames, 0);
  },
};

/** stow (§5.1): to a belt slot (≤ beltMaxKg and ≤ beltMaxLenM, or a coil ≤ beltMaxKg) or the back (a tool or a bundle). */
const stow: VerbHandler = {
  verb: 'stow',
  target: 'none',
  validate(w, f, cmd) {
    const inv = f.inventory;
    if (!inv) return 'cantAct';
    const h = inv.hands;
    if (!h) return 'handsEmpty';
    if (h.mode === 'drag') return 'dragging';
    if (h.mode === 'ropeEnd') return 'ropeEnd';
    const slot = cmd.slot;
    if (!validSlot(f, slot)) return 'noTarget';
    const hs = heldShape(w, h.entity);
    const t = VERB_TUNING;
    if (slot === backSlot(f)) {
      if (inv.back !== null) return 'slotFull';
      const tool = toolClass(w, h.entity) !== null;
      const bundle = hs.members.every((id) => isElongated(w.entities.get(id)!));
      if (!tool && !bundle) return 'notATool';
      return propertyAtMost(hs.massKg, t.backMaxKg) ? null : 'tooHeavy';
    }
    if (inv.belt[slot] !== null) return 'slotFull';
    if (!propertyAtMost(hs.massKg, t.beltMaxKg)) return 'tooHeavy';
    const coil = isRopeEntity(w.entities.get(h.entity)!);
    return coil || propertyAtMost(hs.lengthM, t.beltMaxLenM) ? null : 'tooLong';
  },
  start(_w, f) {
    return quickWork(f, VERB_TUNING.stowFrames, 1);
  },
  land(w, f, cmd) {
    const inv = f.inventory!;
    const h = inv.hands!;
    for (const id of heldMembers(w, h.entity)) w.entities.setState(w.entities.get(id)!, 'stowed');
    if (cmd.slot === backSlot(f)) inv.back = h.entity;
    else inv.belt[cmd.slot!] = h.entity;
    inv.hands = null;
    refreshHands(w, f);
    verbEvent(w, f, 'stow', true, undefined, h.entity);
  },
};

/** draw (§5.1): from a slot into empty hands, wielded if it is a tool, else carried. */
const draw: VerbHandler = {
  verb: 'draw',
  target: 'none',
  validate(w, f, cmd) {
    const inv = f.inventory;
    if (!inv) return 'cantAct';
    if (inv.hands) return 'handsFull';
    const slot = cmd.slot;
    if (!validSlot(f, slot)) return 'noTarget';
    const id = slot === backSlot(f) ? inv.back : inv.belt[slot];
    if (id === null) return 'slotEmpty';
    const e = w.entities.get(id);
    return e && e.state === 'stowed' ? null : 'slotEmpty';
  },
  start(_w, f) {
    return quickWork(f, VERB_TUNING.drawFrames, 1);
  },
  land(w, f, cmd) {
    const inv = f.inventory!;
    const back = cmd.slot === backSlot(f);
    const id = (back ? inv.back : inv.belt[cmd.slot!])!;
    if (back) inv.back = null;
    else inv.belt[cmd.slot!] = null;
    for (const m of heldMembers(w, id)) w.entities.setState(w.entities.get(m)!, 'held');
    const mode = toolClass(w, id) ? 'wield' : 'carry';
    inv.hands = { entity: id, mode, grip: heldShape(w, id).grip, twoHanded: false, joint: null };
    refreshHands(w, f);
    verbEvent(w, f, 'draw', true, undefined, id);
  },
};

registerVerb(take);
registerVerb(drop);
registerVerb(stow);
registerVerb(draw);

// ---------------------------------------------------------------------------
// The world's calls
// ---------------------------------------------------------------------------

/**
 * WorldPort.onWeaponDropped (DS dropWeapon: a KO, a severed arm, the pickup button with nothing to pick up): a wielded
 * tool is an entity, let go of at the hand. True when it was (no DS drop); false when the hands wield nothing.
 */
export function weaponDropped(w: World, f: Fighter): boolean {
  if (f.inventory?.hands?.mode !== 'wield') return false;
  letGo(w, f, {});
  return true;
}

/**
 * Phase 4a (§5.1 forced release): a fighter down (knocked down, KO'd, tripped) lets go at once of a carried load, a
 * dragged one and a rope end; a wielded tool only on KO (DS dropWeapon).
 */
export function forcedRelease(w: World, f: Fighter): void {
  const h = f.inventory?.hands;
  if (!h) return;
  if (h.mode === 'wield' && f.state !== 'ko') return;
  letGo(w, f, {});
}
