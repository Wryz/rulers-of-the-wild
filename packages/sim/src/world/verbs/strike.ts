// Strikes on the world (docs/M1-DESIGN.md §5.2, §5.10): WorldPort.strike (an unmatched swing meets a tree, rope,
// entity or the ground: chop, cross-cut, sever, push, dig or clang), projectile world hits and landings.
//
// The strike seam (§5.2): CombatSim's resolveHits offers the world every active swing that found no body this tick.
// - Armed: every blade sample is swept from last tick's point to this tick's as a ball of the weapon's radius against
//   the terrain, every entity but the striker's own held object, and every rope sensor but the lashings of that object;
//   the smallest time of impact wins (a 30 cm trunk the point test misses is caught, MAP gap-5 §3). Ties go to the
//   sample nearer the head (the head leads a swing). Samples below strikeFrom − haftMarginM are the haft.
// - Unarmed (fists, feet): a ball of (move radius + reach) × scale swept from last tick's strike point to this tick's
//   (CombatSim keeps it from the wind-up's last frame, as it keeps a blade's), against entities only (INTERPRETATION:
//   a foot near the ground would otherwise clang on every kick; a fist through a hanging vine meets nothing).
// What it met decides the effect (the table of §5.2), with E = blowDamage(a, null, m, power, haft, null) ×
// meleeJPerDmg and power = a.swingPower(); a qualifying stroke is the head, power ≥ VERB_TUNING.minStrikePower and a
// tool that can do it:
// - a rooted tree, an edge that cuts its wood → chop (cut.ts); a free elongated entity, likewise → cross-cut (cut.ts);
// - a rope sensor, an edge that cuts the rope → sever (cut.ts);
// - the terrain, a tool that digs → dig (dig.ts);
// - otherwise a free dynamic entity (not anchored) with E > 0 → push: an impulse J = √(2·E·reducedMass(m_e, m_striker))
//   along the swing (unarmed: the facing), queued for this tick's phase 4d (m_striker: strikerMassKg, the limb's mass
//   for an unarmed blow, strikeMassKg × scale³ for an armed one), and the entity's integrity by the impact rule
//   (Breaking.hit, as phase 9c scores a contact); the striker's credit joins it (a kicked-out prop);
// - anything else (fixed, anchored, a blunt or weak blow on a rope, a non-digging tool in the ground) → clang.
// Cuts and digs stick (the edge bites in, w.bite frames); pushes and clangs rebound. One world contact per swing:
// CombatSim marks the swing spent whatever is returned.
//
// Projectiles (§5.11): the flight segment of each weapon sample is swept against entities and terrain (toi = the
// fraction of the segment); CombatSim stops the weapon there and calls onProjectileLanded, which turns it back into the
// same entity (throw.ts landThrown) so the contact pipeline scores what it hits.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { blowDamage } from '../../sim/combat';
import type { BoneName } from '../../body/skeleton';
import type { Fighter } from '../../sim/fighter';
import type { MoveDef } from '../../sim/moves';
import { projectilePoints, type Projectile } from '../../sim/projectiles';
import { boneMass, DAMAGE_TUNING, reducedMass } from '../../sim/rules';
import type { WeaponDef } from '../../sim/weapons';
import type { Owner, ProjectileWorldHit, V3, WorldStrike } from '../types';
import type { World } from '../world';
import { chopTree, crossCutStrike, severRope, STRIKE_TUNING } from './cut';
import { digAt } from './dig';
import { creditEntity } from './hands';
import { verbEvent } from './targets';
import { landThrown } from './throw';
import { canCut, heldMembers, isElongated, isRooted, isRopeEntity, toolDigs, verbGeom } from './tools';
import { TOOL_TUNING, VERB_TUNING } from './tuning';

const { sub, scale, len } = verbGeom;
const v3 = (p: { x: number; y: number; z: number }): V3 => ({ x: p.x, y: p.y, z: p.z });
const IDQ = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/** What a swing met first. */
interface Met {
  owner: Owner;
  point: V3;
  normal: V3;
  /** The sample's offset along the weapon (m, authored), or null unarmed. */
  offset: number | null;
  /** Unit direction the striking part was moving (world). */
  dir: V3;
}

/** The entity the fighter's hands hold (any mode), or null. */
function handsEntity(f: Fighter): number | null {
  return f.inventory?.hands?.entity ?? null;
}

/** The fighter's facing, horizontal. */
function facing(f: Fighter): V3 {
  return { x: Math.sin(f.yaw), y: 0, z: Math.cos(f.yaw) };
}

/**
 * A ball of radius r swept from `from` by `vel` (toi in fractions of vel, ≤ 1), against what `keep` admits (sensors
 * included, so rope sensors can be met). The struck collider's point and outward normal, world.
 */
function sweep(w: World, from: V3, vel: V3, r: number, keep: (o: Owner) => boolean): { owner: Owner; toi: number; point: V3; normal: V3 } | null {
  const phys = w.physics;
  const hit = phys.rapier.castShape(from, IDQ, vel, new RAPIER.Ball(r), 0, 1, true, undefined, undefined, undefined, undefined, (c) => {
    const o = phys.ownerOf(c.handle);
    return !!o && keep(o);
  });
  if (!hit) return null;
  const owner = phys.ownerOf(hit.collider.handle);
  if (!owner) return null;
  return { owner, toi: hit.time_of_impact, point: v3(hit.witness1), normal: v3(hit.normal1) };
}

/**
 * What a striker's blade may meet (§5.2): the terrain, any entity outside its own held object, and any rope sensor but
 * those of joints within that object (its lashings) or held in its own hand; never a fighter.
 */
function bladeFilter(w: World, f: Fighter, own: readonly number[]): (o: Owner) => boolean {
  return (o) => {
    switch (o.kind) {
      case 'terrain':
        return true;
      case 'entity':
        return !own.includes(o.id);
      case 'rope': {
        const j = w.joints.get(o.joint);
        if (!j) return false;
        if (j.a.fighter === f.id || j.b.fighter === f.id) return false;
        const inOwn = (e: number | null) => e !== null && own.includes(e);
        return !(inOwn(j.a.entity) && inOwn(j.b.entity)) && !(j.rope && own.includes(j.rope.entity));
      }
      case 'fighter':
        return false;
    }
  };
}

/** The first thing the armed swing's samples meet between last tick and this one (smallest toi; ties: nearer the head). */
function sweepBlade(w: World, f: Fighter, prev: readonly Vector3[] | null, pts: readonly Vector3[], offs: readonly number[], weapon: WeaponDef, own: readonly number[]): Met | null {
  const r = weapon.radius * f.scale;
  const keep = bladeFilter(w, f, own);
  let best: { toi: number; i: number; owner: Owner; point: V3; normal: V3; dir: V3 } | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const to = v3(pts[i]);
    const from = prev ? v3(prev[i]) : to;
    const vel = sub(to, from);
    const hit = sweep(w, from, vel, r, keep);
    if (!hit) continue;
    if (best && !(hit.toi < best.toi)) continue;
    const moved = len(vel);
    best = { toi: hit.toi, i, owner: hit.owner, point: hit.point, normal: hit.normal, dir: moved > 1e-9 ? scale(vel, 1 / moved) : facing(f) };
  }
  return best ? { owner: best.owner, point: best.point, normal: best.normal, offset: offs[best.i] ?? null, dir: best.dir } : null;
}

/** What an unarmed strike may meet: entities outside the striker's own held object (no terrain, no rope). */
function limbFilter(own: readonly number[]): (o: Owner) => boolean {
  return (o) => o.kind === 'entity' && !own.includes(o.id);
}

/**
 * The entity an unarmed strike meets: its ball ((move radius + reach) × scale) swept from last tick's strike point to
 * this tick's, as a blade's samples are (CombatSim keeps the fist's or foot's point from the last frame of the wind-up),
 * so a foot can't pass through a prop between two ticks; without a last point, the ball where it is. Pushed along the
 * facing (§5.2).
 */
function sweepUnarmed(w: World, f: Fighter, prev: readonly Vector3[] | null, at: V3, own: readonly number[]): Met | null {
  const m = f.move!;
  const r = (m.radius + f.stats.reach) * f.scale;
  const from = prev && prev.length === 1 ? v3(prev[0]) : at;
  const hit = sweep(w, from, sub(at, from), r, limbFilter(own));
  if (!hit) return null;
  return { owner: hit.owner, point: hit.point, normal: hit.normal, offset: null, dir: facing(f) };
}

/** The bones of a striking limb from its end inward (the foot is part of the shin, the hand of the forearm). */
const LIMB_CHAIN: Readonly<Record<MoveDef['limb'], readonly BoneName[]>> = {
  footL: ['shinL', 'thighL'],
  footR: ['shinR', 'thighR'],
  handL: ['foreArmL', 'upperArmL'],
  handR: ['foreArmR', 'upperArmR'],
};

/**
 * The striker's mass behind a push (§5.2's J = √(2·E·reducedMass(m_e, m_striker))). DEPARTURE (P15 review, orchestrator
 * decision; §5.2: "J = √(2·E·reducedMass(m_e, strikeMassKg 6))"): an unarmed blow has its limb behind it, the mass of
 * STRIKE_TUNING.unarmedLimbBones bones of the striking limb's chain (boneMass: shin + thigh, 13.5 kg, for a human kick,
 * so DS's 108 J kick gives ≈ 41 N·s, §5.2's 40 N·s; rule 2 and rule 3); an armed one keeps strikeMassKg, × the
 * striker's scale³ (a giant's swat is not a man's).
 */
export function strikerMassKg(f: Fighter, m: MoveDef, armed: boolean): number {
  if (armed) return VERB_TUNING.strikeMassKg * f.scale * f.scale * f.scale;
  const n = Math.max(1, Math.min(LIMB_CHAIN[m.limb].length, Math.round(STRIKE_TUNING.unarmedLimbBones)));
  return LIMB_CHAIN[m.limb].slice(0, n).reduce((sum, b) => sum + boneMass(f, b), 0);
}

/** The fighter's reaction: an edge that bit in sticks for w.bite frames; anything else rebounds (§5.2). */
function stick(weapon: WeaponDef | null): WorldStrike['reaction'] {
  return { mode: 'stick', hold: Math.max(0, Math.round(weapon?.bite ?? 0)), retract: STRIKE_TUNING.stickRetract };
}
function rebound(): WorldStrike['reaction'] {
  return { mode: 'rebound', hold: STRIKE_TUNING.reboundHold, retract: STRIKE_TUNING.reboundRetract };
}

/** WorldPort.strike: the swing's blade samples this tick (and last tick) against the world; null when it meets nothing. */
export function worldStrike(
  w: World,
  a: Fighter,
  prev: readonly Vector3[] | null,
  pts: readonly Vector3[],
  offs: readonly number[],
  weapon: WeaponDef | null,
): WorldStrike | null {
  const m = a.move;
  if (!m || pts.length === 0) return null;
  const heldId = handsEntity(a);
  const own = heldId !== null ? heldMembers(w, heldId) : [];
  const met = weapon ? sweepBlade(w, a, prev, pts, offs, weapon, own) : sweepUnarmed(w, a, prev, v3(pts[0]), own);
  if (!met) return null;

  const T = VERB_TUNING;
  const power = a.swingPower();
  const haft = weapon !== null && met.offset !== null && met.offset < weapon.strikeFrom - TOOL_TUNING.haftMarginM;
  const E = blowDamage(a, null, m, power, haft, null) * DAMAGE_TUNING.meleeJPerDmg;
  // The wielded object is the tool (cutting and digging need a real one: an entity the hands wield).
  const tool = weapon && a.inventory?.hands?.mode === 'wield' ? heldId : null;
  const qualifies = tool !== null && !haft && power >= T.minStrikePower;
  const point = new Vector3(met.point.x, met.point.y, met.point.z);
  const normal = new Vector3(met.normal.x, met.normal.y, met.normal.z);
  const result = (effect: WorldStrike['effect'], reaction: WorldStrike['reaction']): WorldStrike => ({ point, normal, owner: met.owner, effect, reaction });

  switch (met.owner.kind) {
    case 'terrain':
      if (qualifies && toolDigs(w, tool)) {
        digAt(w, met.point.x, met.point.z, 1, a);
        verbEvent(w, a, 'dig', true);
        return result('dig', stick(weapon));
      }
      return result('clang', rebound());
    case 'rope': {
      const j = w.joints.get(met.owner.joint);
      const rope = j?.rope ? w.entities.get(j.rope.entity) : undefined;
      if (qualifies && rope && canCut(w, tool, rope.id)) {
        severRope(w, a, met.owner.joint, met.point);
        return result('sever', stick(weapon));
      }
      return result('clang', rebound());
    }
    case 'entity': {
      const e = w.entities.get(met.owner.id);
      if (!e) return result('clang', rebound());
      if (isRooted(e)) {
        if (qualifies && canCut(w, tool, e.id)) {
          chopTree(w, a, e.id, met.point, tool);
          return result('chop', stick(weapon));
        }
        return result('clang', rebound());
      }
      const b = e.body;
      const free = e.state === 'free' && !!b && b.isEnabled() && b.isDynamic() && !w.entities.isAnchored(e);
      if (!free) return result('clang', rebound());
      if (qualifies && e.plant === null && !isRopeEntity(e) && isElongated(e) && canCut(w, tool, e.id)) {
        crossCutStrike(w, a, e.id, met.point, tool);
        return result('crossCut', stick(weapon));
      }
      if (!(E > 0)) return result('clang', rebound());
      // The push (§5.2, "kick out a prop", SPEC:432): J = √(2·E·μ) along the swing, applied in this tick's phase 4d.
      const J = Math.sqrt(2 * E * reducedMass(e.mass, strikerMassKg(a, m, weapon !== null)));
      w.entities.queueImpulse(e.id, scale(met.dir, J), met.point);
      // TODO "giant blows on cover pieces": a ruler's blow on a free entity is scored here with its own E, so a swat at a
      // pit cover's branch or grass bundle can break it by impact; AC-2(b) wants "a break of a cover entity from foot
      // load" (§4.11, loads.ts). The scale³ striker mass keeps the push a giant's; whether a ruler's strike should score
      // integrity on cover entities at all is for P20/P28 to settle.
      w.breaking.hit(e, E, met.point, { kind: 'fighter', id: a.id, part: 'zone' });
      if (w.entities.get(e.id) === e) creditEntity(e, a);
      return result('push', rebound());
    }
    case 'fighter':
      return null;
  }
}

/** What a thrown weapon may meet in flight (§5.11): the terrain and entities; never a rope, never a fighter (DS's). */
function flightFilter(o: Owner): boolean {
  return o.kind === 'terrain' || o.kind === 'entity';
}

/**
 * WorldPort.projectile: one flight segment (from → to, the weapon's centre) cast against entities and terrain: every
 * weapon sample swept by the segment as a ball of the weapon's radius (a spear's point meets a trunk before its
 * centre does); the smallest toi wins, as a fraction of the segment.
 */
export function projectileHit(w: World, p: Projectile, from: Vector3, to: Vector3): ProjectileWorldHit | null {
  const vel = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const r = p.weapon.radius * p.scale;
  const { points } = projectilePoints(p);
  let best: { owner: Owner; toi: number; point: V3; normal: V3 } | null = null;
  for (const q of points) {
    // The sample where it was at the segment's start (the weapon's pose now, moved back along the segment).
    const start = { x: q.x - vel.x, y: q.y - vel.y, z: q.z - vel.z };
    const hit = sweep(w, start, vel, r, flightFilter);
    if (hit && (!best || hit.toi < best.toi)) best = hit;
  }
  if (!best) return null;
  return { point: new Vector3(best.point.x, best.point.y, best.point.z), normal: new Vector3(best.normal.x, best.normal.y, best.normal.z), owner: best.owner, toi: best.toi };
}

/**
 * WorldPort.onProjectileLanded: true when it became an entity again (no DS drop). CombatSim calls it once per landing,
 * after a world hit (projectileHit) and after a landing on the ground, so landThrown runs here and only here.
 */
export function projectileLanded(w: World, p: Projectile): boolean {
  return landThrown(w, p) !== null;
}
