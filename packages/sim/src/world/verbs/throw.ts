// Throw (docs/M1-DESIGN.md §5.11, SPEC:244, 285, 409): `{ verb: 'throw', aim: [yaw, pitch], charge }` while carrying or
// wielding ≤ carryMaxKg × scale², not dragging, not holding a rope end. The verb plays a throw move (the spear's
// throwSpear, point first; else throwOne one-handed, throwHeavy two-handed) with `f.throwAim` set; at the move's release
// frame CombatSim calls WorldPort.throwRelease (here), and the object leaves the hands:
// - a tool of ≤ projectileMaxKg (2 kg) as DungeonStyle's projectile (§5.11, SPEC:632): its members go to state
//   'projectile' (no body) and CombatSim's release() launches f.weapon along the aim at launchSpeed(m, techSpeed) ×
//   speedFrac with DS's scatter; `thrownEntityOf` and `landThrown` turn the projectile back into the same entity (P15's
//   WorldPort.onProjectileLanded calls landThrown once: CombatSim calls it after a world hit and after a landing);
// - anything else as a Rapier body: re-enabled at the hand pose with linvel = aim·v + walkVel and an end-over-end spin of
//   throwSpinRadS.
// Either way every member is released by the thrower (releasedBy, §4.3: P09 advances apartTicks), credited, and marked
// `thrown = { by, tick }` (D-31: the damage cause stays `held` until its first contact or rest; the entity store keeps
// CCD on while it is set, and P09's phase 9e clears it). The speed is v = launchSpeed(m, techSpeed) × (throwMinFrac +
// (1 − throwMinFrac) × charge/255) (SPEC:285: never more than 400 J), techSpeed smallThrowSpeed (20 m/s) for ≤
// projectileMaxKg, heavyThrowSpeed (12 m/s) above: a 40 kg log leaves at 4.47 m/s. The aim is a direction, never a
// target (an ape 30 m away can't pull the throw).
//
// A `verb` event (ok) is emitted when the object leaves the hands (the noise bus hears it land, `land` events).
// The projectile ↔ entity link is derived from saved state only: the entity is in state 'projectile' with `thrown.by`
// the projectile's owner and `thrown.tick` its release tick (= the tick − its age + 1, since stepProjectiles ages a
// projectile in the tick it is released), so a save mid-flight resumes it.
import { Vector3 } from 'three';
import { AIM_STEPS, aimVector, COMMAND_STEPS, type VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import type { MoveDef } from '../../sim/moves';
import { projectileDir, projectileGrip, type Projectile } from '../../sim/projectiles';
import { launchSpeed } from '../../sim/rules';
import { WEAPON_MOVES } from '../../sim/weapons';
import { propertyAtMost } from '../materials';
import type { Pose3, Quat, RefuseReason, V3 } from '../types';
import type { World } from '../world';
import { letGo } from './hands';
import { registerVerb, verbEvent, type VerbHandler } from './targets';
import { heldMembers, heldShape, toolClass, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

const { add, scale, cross, dot, len, unit, rotate, mulQuat, compose, relative, dirToWorld } = verbGeom;
const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
const v3 = (p: { x: number; y: number; z: number }): V3 => ({ x: p.x, y: p.y, z: p.z });

/** The throw moves (WEAPON_MOVES ids): the spear's, one-handed, two-handed. */
export type ThrowMoveId = 'throwSpear' | 'throwOne' | 'throwHeavy';

/** What a valid throw command does. */
export interface ThrowPlan {
  /** Unit aim direction (the command's, decoded). */
  dir: V3;
  massKg: number;
  /** smallThrowSpeed for ≤ projectileMaxKg, heavyThrowSpeed above (m/s). */
  techSpeed: number;
  /** throwMinFrac + (1 − throwMinFrac) × charge/255. */
  speedFrac: number;
  /** launchSpeed(m, techSpeed) × speedFrac, m/s. */
  speed: number;
  /** A DS projectile (a tool ≤ projectileMaxKg) or a Rapier body. */
  path: 'projectile' | 'body';
  move: ThrowMoveId;
}

export type ThrowVerdict = { ok: true; plan: ThrowPlan } | { ok: false; reason: RefuseReason };

/** A charge (0..255; absent: full) as the fraction of launchSpeed a throw leaves at (throwMinFrac → 1). */
export function throwSpeedFrac(charge: number | undefined): number {
  const max = COMMAND_STEPS - 1;
  const c = charge === undefined ? max : Math.max(0, Math.min(max, charge));
  const t = VERB_TUNING;
  return t.throwMinFrac + (1 - t.throwMinFrac) * (c / max);
}

/** The technique speed for an object of `massKg` (§5.11, D-29): smallThrowSpeed up to projectileMaxKg, else heavyThrowSpeed. */
export function throwTechSpeed(massKg: number): number {
  const t = VERB_TUNING;
  return propertyAtMost(massKg, t.projectileMaxKg) ? t.smallThrowSpeed : t.heavyThrowSpeed;
}

/** The speed an object of `massKg` leaves the hand at for a charge (the client's arc uses the same, §10.7). */
export function throwLaunchSpeed(massKg: number, charge: number | undefined): number {
  return launchSpeed(massKg, throwTechSpeed(massKg)) * throwSpeedFrac(charge);
}

/**
 * The whole of §5.11's preconditions for a `throw` command, from the world as it is now: something carried or wielded
 * of ≤ carryMaxKg × scale² (not a dragged load, not a rope end) and a well-formed aim. Pure: changes nothing.
 */
export function planThrow(w: World, f: Fighter, cmd: VerbCommand): ThrowVerdict {
  const inv = f.inventory;
  if (!inv) return { ok: false, reason: 'cantAct' };
  const h = inv.hands;
  if (!h) return { ok: false, reason: 'handsEmpty' };
  if (h.mode === 'drag') return { ok: false, reason: 'dragging' };
  if (h.mode === 'ropeEnd') return { ok: false, reason: 'ropeEnd' };
  const e = w.entities.get(h.entity);
  if (!e || e.state !== 'held') return { ok: false, reason: 'handsEmpty' };
  const aim = cmd.aim;
  if (!aim || aim.length !== 2 || !Number.isInteger(aim[0]) || !Number.isInteger(aim[1]) || Math.abs(aim[1]) > AIM_STEPS / 4) return { ok: false, reason: 'noTarget' };
  if (cmd.charge !== undefined && !Number.isInteger(cmd.charge)) return { ok: false, reason: 'noTarget' };
  const hs = heldShape(w, e.id);
  const m = hs.massKg;
  if (!propertyAtMost(m, VERB_TUNING.carryMaxKg * f.scale * f.scale)) return { ok: false, reason: 'tooHeavy' };
  const d = aimVector(aim, new Vector3());
  const techSpeed = throwTechSpeed(m);
  const speedFrac = throwSpeedFrac(cmd.charge);
  const cls = h.mode === 'wield' ? toolClass(w, e.id) : null;
  const path = cls !== null && propertyAtMost(m, VERB_TUNING.projectileMaxKg) ? 'projectile' : 'body';
  const move: ThrowMoveId = cls === 'spear' ? 'throwSpear' : h.twoHanded ? 'throwHeavy' : 'throwOne';
  return { ok: true, plan: { dir: v3(d), massKg: m, techSpeed, speedFrac, speed: launchSpeed(m, techSpeed) * speedFrac, path, move } };
}

const throwVerb: VerbHandler = {
  verb: 'throw',
  target: 'none',
  validate(w, f, cmd) {
    const r = planThrow(w, f, cmd);
    return r.ok ? null : r.reason;
  },
  /** The throw move starts, facing the aim; the object leaves the hands at its release frame (throwRelease). */
  start(w, f, cmd) {
    const r = planThrow(w, f, cmd);
    if (!r.ok) return null;
    const p = r.plan;
    f.throwAim = { dir: new Vector3(p.dir.x, p.dir.y, p.dir.z), speedFrac: p.speedFrac, techSpeed: p.techSpeed };
    if (Math.hypot(p.dir.x, p.dir.z) > 1e-9) f.yaw = Math.atan2(p.dir.x, p.dir.z);
    f.startMove(WEAPON_MOVES[p.move]);
    return null;
  },
};

registerVerb(throwVerb);

/**
 * WorldPort.throwRelease (CombatSim.release, at the throw move's release frame, before it reads f.throwAim's speed): the
 * held object leaves the hands. A tool of ≤ projectileMaxKg becomes a DS projectile: its members go to state
 * 'projectile' and f.weapon is left for release() to launch (false). Anything else is launched as a Rapier body here
 * (true: no DS projectile). Not aimed by the throw verb, or nothing carried or wielded: false (DS's own path).
 */
export function throwRelease(w: World, f: Fighter, _m: MoveDef): boolean {
  const aim = f.throwAim;
  const h = f.inventory?.hands;
  if (!aim || !h || (h.mode !== 'wield' && h.mode !== 'carry')) return false;
  const e = w.entities.get(h.entity);
  if (!e || e.state !== 'held') return false;
  const hs = heldShape(w, e.id);
  const dir = unit(v3(aim.dir), { x: Math.sin(f.yaw), y: 0, z: Math.cos(f.yaw) });
  const speed = launchSpeed(hs.massKg, aim.techSpeed) * aim.speedFrac;
  const tick = w.tick;
  const weapon = f.weapon;
  const projectile = h.mode === 'wield' && weapon !== null && toolClass(w, e.id) !== null && propertyAtMost(hs.massKg, VERB_TUNING.projectileMaxKg);
  if (projectile) {
    const members = letGo(w, f, { state: 'projectile', lin: scale(dir, speed) });
    for (const id of members) w.entities.get(id)!.thrown = { by: f.id, tick };
    // release() launches the weapon in the hand; letting go cleared it.
    f.weapon = weapon;
    verbEvent(w, f, 'throw', true, undefined, e.id);
    return false;
  }
  // End over end, the far end coming over the top (DS's spin axis: up × the flat aim).
  const flat = Math.hypot(dir.x, dir.z) > 1e-9 ? unit({ x: dir.x, y: 0, z: dir.z }) : { x: Math.sin(f.yaw), y: 0, z: Math.cos(f.yaw) };
  const spin = scale(unit(cross(UP, flat)), VERB_TUNING.throwSpinRadS);
  const lin = add(scale(dir, speed), v3(f.walkVel));
  const members = letGo(w, f, { lin, ang: spin });
  for (const id of members) w.entities.get(id)!.thrown = { by: f.id, tick };
  verbEvent(w, f, 'throw', true, undefined, e.id);
  return true;
}

// ---------------------------------------------------------------------------
// Projectiles back to entities (P15's WorldPort.onProjectileLanded calls landThrown)
// ---------------------------------------------------------------------------

/**
 * The entity a DS projectile carries (§5.11): in state 'projectile', thrown by the projectile's owner at exactly its
 * release tick (the tick − its age + 1: stepProjectiles ages it before it can land, and both are saved); the lowest id of
 * a lashed object's members. Null for a projectile the throw verb didn't make (none in world mode), or one already
 * landed: never another of the thrower's objects in flight, so a second landThrown for the same projectile is a no-op.
 * P15's WorldPort.onProjectileLanded calls landThrown once (CombatSim calls it after a world hit and after a landing).
 */
export function thrownEntityOf(w: World, p: Projectile): number | null {
  const released = w.tick - p.age + 1;
  for (const e of w.entities.all()) {
    if (e.state === 'projectile' && e.thrown && e.thrown.by === p.owner.id && e.thrown.tick === released) return e.id;
  }
  return null;
}

/** The rotation taking unit `a` onto unit `b` (the shortest arc; half a turn about a perpendicular when opposite). */
function rotationBetween(a: V3, b: V3): Quat {
  const c = dot(a, b);
  if (c < -1 + 1e-12) {
    const axis = verbGeom.perpendicular(a);
    return { x: axis.x, y: axis.y, z: axis.z, w: 0 };
  }
  const x = cross(a, b);
  const q = { x: x.x, y: x.y, z: x.z, w: 1 + c };
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/**
 * The pose the entity a projectile carries has in flight now (§5.11): its long axis along the projectile's grip-to-tip
 * direction (the shortest turn from the way it left the hand), its grip at the projectile's grip.
 */
export function thrownPose(w: World, p: Projectile, entity: number): Pose3 | null {
  const e = w.entities.get(entity);
  if (!e) return null;
  const hs = heldShape(w, entity);
  const dir = projectileDir(p, new Vector3());
  const grip = projectileGrip(p, new Vector3());
  const a0 = unit(dirToWorld(e.pose, hs.axis));
  const q = mulQuat(rotationBetween(a0, unit(v3(dir))), e.pose.q);
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  const qn = { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
  const at = rotate(qn, hs.grip);
  return { p: { x: grip.x - at.x, y: grip.y - at.y, z: grip.z - at.z }, q: qn };
}

/**
 * The projectile becomes its entity again (§5.11: "its body is re-created at the projectile pose with its velocity, so
 * the contact pipeline scores what it hits"): every member back to 'free' at the projectile's pose, with its velocity
 * and spin; `thrown` stays (D-31: `held` until first contact). Returns the entity, or null when the projectile carries
 * none (then CombatSim's DS drop is the fallback), as it does when called again for a projectile already landed. The
 * caller is P15's onProjectileLanded, which CombatSim calls once, after a world hit or a landing.
 */
export function landThrown(w: World, p: Projectile): number | null {
  const id = thrownEntityOf(w, p);
  if (id === null) return null;
  const pose = thrownPose(w, p, id);
  if (!pose || !(len(pose.p) < Infinity)) return null;
  const e = w.entities.get(id)!;
  const base = e.pose;
  const ang = scale(v3(p.axis), p.omega);
  const lin = v3(p.vel);
  for (const mid of heldMembers(w, id)) {
    const m = w.entities.get(mid)!;
    if (m.state !== 'projectile') continue;
    m.pose = compose(pose, relative(base, m.pose));
    m.vel = { lin: { ...lin }, ang: { ...ang } };
    w.entities.setState(m, 'free');
  }
  return id;
}
