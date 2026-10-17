// Senses (docs/M1-DESIGN.md §6.2; SPEC:752-757): sight (a cone and a range per species, longer for a moving target,
// shorter for a crouched one and shorter still for one crouched in ground cover, occluded by terrain and heavy
// entities), hearing (noises from the bus, phase 17b), being hurt, awareness per target, the last known position of the
// strongest stimulus, and when a target was last seen.
//
// - Awareness is kept per target fighter id: a sighting raises the seen target's; a noise raises its maker's when the
//   maker is someone this creature could hunt (a fighter of another team), and UNKNOWN_STIMULUS's otherwise (a falling
//   tree, a snapped rope, a thrown stone landing, a teammate's shout: "something is out there"). A mind investigates on
//   level() (the highest of them) and chases a target on of(target) and seenWithin() (§6.2 Thresholds; P19, P20).
// - "The strongest stimulus since the last decision" (§6.2 Hearing): a decision follows every sight() call (phase 2:
//   sight, then decide), so sight() opens a new window. Within it a stimulus's strength is the awareness it added: a
//   sighting sets lkp to the target and its gain; a heard noise moves lkp only when it adds more than the strongest
//   stimulus so far; being hurt always moves it.
// - Nothing here draws randomness or reads wall time; targets are taken in combat.fighters order (id order).
import type { MindRecV1 } from '../../save/schema';
import { MOVE_CROUCH } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { DT } from '../../sim/math';
import type { SevereEffect, V3 } from '../types';
import type { World } from '../world';
import { CREATURE_TUNING } from './defs';
import type { Noise } from './noise';

/** The awareness key of a stimulus no target can be blamed for (fighter ids start at 1, so 0 is never a fighter). */
export const UNKNOWN_STIMULUS = 0;

const DEG = Math.PI / 180;

/** The per-species sense values a creature uses (CREATURE_TUNING.ape or .giant, read live). */
export interface SenseValues {
  sightConeDeg: number;
  sightRangeM: number;
  sightRangeStillM: number;
  hearingMul: number;
  seenRate: number;
  heardGain: number;
  decayPerS: number;
}

/** The giant's senses for a ruler or a giant ape, the ape's for every other creature. */
export function senseValues(f: Fighter): SenseValues {
  return f.ruler || f.species === 'giantApe' ? CREATURE_TUNING.giant : CREATURE_TUNING.ape;
}

/** A severe wound with this effect, healed or not: wounds on rulers persist (rule 9, §2.9). */
export function hasSevereEffect(f: Fighter, effect: SevereEffect): boolean {
  return f.ruler?.wounds.some((w) => w.severe && w.effect === effect) ?? false;
}

/** Crouched for the senses: crouch held (MOVE_CROUCH), or the capsule crouched (a stooped work posture, §4.2). */
export function looksCrouched(w: World, f: Fighter): boolean {
  return (f.moveFlags & MOVE_CROUCH) !== 0 || w.kcc.crouched(f);
}

/** m/s: how fast a fighter moves (footwork plus knockback or slide). */
function speedOf(f: Fighter): number {
  return Math.hypot(f.walkVel.x + f.vel.x, f.walkVel.y + f.vel.y, f.walkVel.z + f.vel.z);
}

/**
 * Degrees from `self`'s facing to the horizontal direction (dx, dz), signed: + toward its left (fighter-local +X,
 * DungeonStyle's convention: CombatSim.locomote), − toward its right. 0 straight ahead or straight above.
 */
export function bearingDeg(self: Fighter, dx: number, dz: number): number {
  const fx = Math.sin(self.yaw);
  const fz = Math.cos(self.yaw);
  const ahead = dx * fx + dz * fz;
  const left = dx * fz - dz * fx;
  return Math.atan2(left, ahead) / DEG;
}

/**
 * A ray from `from` reaches `to`: nothing between them but what isn't an occluder (fighters, sensors, ropes, entities
 * under occluderMinKg), or the first occluder lies within sightRayTolM of `to` (a target leaning on a trunk is seen).
 * Like every query it sees colliders as of the last physics step.
 */
export function lineOfSight(w: World, from: V3, to: V3): boolean {
  const S = CREATURE_TUNING.shared;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= S.sightRayTolM) return true;
  const hit = w.queries.castRay(from, { x: dx, y: dy, z: dz }, dist, { terrain: true, entities: 'all', minEntityMassKg: S.occluderMinKg });
  return !hit || hit.toi >= dist - S.sightRayTolM;
}

/**
 * How well `self` sees `target` now, 0 (unseen) to 1 (§6.2 Sight 1-5): eye = self's head; d = eye to the target's
 * chest; within the cone (and not on a blind eye's side beyond blindDeadDeg); within R (sightRangeM moving faster than
 * movingMinSpeed, else sightRangeStillM; × crouchSightMul crouched, × coverSightMul instead crouched in cover ≥
 * coverMin); either the chest or the head in line of sight; v = √(1 − d/R), × peripheralMul in the outer peripheralDeg
 * of the cone. Reads the rigs as the last updatePose left them.
 */
export function visibilityOf(w: World, self: Fighter, target: Fighter): number {
  const t = senseValues(self);
  const S = CREATURE_TUNING.shared;
  const eye = self.rig.head.pos;
  const chest = target.rig.chest.pos;
  const dx = chest.x - eye.x;
  const dz = chest.z - eye.z;
  const d = Math.hypot(dx, chest.y - eye.y, dz);
  const beta = bearingDeg(self, dx, dz);
  const half = t.sightConeDeg / 2;
  if (Math.abs(beta) > half) return 0;
  if (self.ruler) {
    const dead = CREATURE_TUNING.giant.blindDeadDeg;
    if (beta > dead && hasSevereEffect(self, 'blindL')) return 0;
    if (beta < -dead && hasSevereEffect(self, 'blindR')) return 0;
  }
  let R = speedOf(target) > S.movingMinSpeed ? t.sightRangeM : t.sightRangeStillM;
  if (looksCrouched(w, target)) R *= w.cover.at(target.pos.x, target.pos.z) >= S.coverMin ? S.coverSightMul : S.crouchSightMul;
  if (!(d < R)) return 0;
  if (!lineOfSight(w, eye, chest) && !lineOfSight(w, eye, target.rig.head.pos)) return 0;
  let v = Math.sqrt(1 - d / R);
  if (Math.abs(beta) > half - S.peripheralDeg) v *= S.peripheralMul;
  return v;
}

/** The part of a mind's save record (§6.8) that is the senses'. */
export type SensesRecord = Pick<MindRecV1, 'awareness' | 'lkp' | 'lkpTick' | 'lastSeenTick'>;

export class Senses {
  /** Target fighter id (or UNKNOWN_STIMULUS) → awareness 0..awarenessCap, in insertion order; 0 is dropped. */
  readonly awareness = new Map<number, number>();
  /** Last known position of the strongest stimulus. */
  lkp: V3 | null = null;
  lkpTick = -1;
  lastSeenTick = -1;
  /**
   * The awareness the strongest stimulus since the last decision added (Infinity after a hurt); reset by sight().
   * TODO(P13/P19): not in MindRecV1, so a load mid-window (a creature sensed once a second, saved between its sensed
   * ticks) restarts the window at 0: the first noise heard after the load then moves lkp even if weaker than one heard
   * before the save. Exact only once MindRecV1 carries it (M3's save, load, continue gate).
   */
  stimulus = 0;

  /** Awareness of one target (or UNKNOWN_STIMULUS). */
  of(id: number): number {
    return this.awareness.get(id) ?? 0;
  }

  /** The highest awareness of anything: what investigateAt is compared against, and the client's marker reads. */
  level(): number {
    let m = 0;
    for (const a of this.awareness.values()) if (a > m) m = a;
    return m;
  }

  /** A target was seen within `seconds` (default seenWithinS) of `tick`. */
  seenWithin(tick: number, seconds: number = CREATURE_TUNING.shared.seenWithinS): boolean {
    return this.lastSeenTick >= 0 && (tick - this.lastSeenTick) * DT <= seconds + 1e-9;
  }

  /**
   * One sensed tick (Δt = DT near the player, 1 s far away; §6.1): opens a new decision window, then sight of every
   * target (an alive fighter of another team, in combat.fighters order): seen, its awareness += seenRate × v × Δt (cap
   * awarenessCap), lkp = its position, lastSeenTick = now; every awareness not raised by a sighting decays by decayPerS ×
   * Δt (floor 0). A dead creature senses nothing.
   */
  sight(w: World, self: Fighter, dt: number): void {
    this.stimulus = 0;
    if (!self.alive) return;
    const t = senseValues(self);
    const seen = new Set<number>();
    for (const target of w.combat.fighters) {
      if (target === self || target.team === self.team || !target.alive) continue;
      const v = visibilityOf(w, self, target);
      if (!(v > 0)) continue;
      const gain = t.seenRate * v * dt;
      this.raise(target.id, gain);
      seen.add(target.id);
      this.lastSeenTick = w.tick;
      // The window opened above, so a sighting is its first stimulus: the strongest one sets lkp (M1 has one target).
      if (gain > this.stimulus) this.setLkp(target.pos, w.tick, gain);
    }
    const decay = t.decayPerS * dt;
    for (const [id, a] of this.awareness) {
      if (seen.has(id)) continue;
      const next = a - decay;
      if (next > 0) this.awareness.set(id, next);
      else this.awareness.delete(id);
    }
  }

  /**
   * A noise reaches this creature (phase 17b; §6.2 Hearing): `source` is the fighter n.source names, if any. Not its
   * own noise, nor a teammate's footsteps (the steady sounds of its own kind; its shouts, roars and blows still count,
   * so the giant hears an ape fight). Heard when s = 1 − d / (radius × hearingMul) > 0, d from the noise to the
   * creature's position: awareness += heardGain × s (of the source if it is a target, else UNKNOWN_STIMULUS); lkp moves
   * to the noise if that is the strongest stimulus since the last decision. Returns s (0 when not heard).
   */
  hear(n: Noise, self: Fighter, tick: number, source: Fighter | null = null): number {
    if (!self.alive || n.source === self.id) return 0;
    if (n.kind === 'step' && source && source.team === self.team) return 0;
    const t = senseValues(self);
    const d = Math.hypot(n.at.x - self.pos.x, n.at.y - self.pos.y, n.at.z - self.pos.z);
    const s = 1 - d / (n.radius * t.hearingMul);
    if (!(s > 0)) return 0;
    const gain = t.heardGain * s;
    this.raise(source && source.team !== self.team ? source.id : UNKNOWN_STIMULUS, gain);
    if (gain > this.stimulus) this.setLkp(n.at, tick, gain);
    return s;
  }

  /**
   * A hit or an impact on this creature (§6.2 Being hurt; the bus calls it before the mind's onHurt): awareness =
   * max(awareness, hurtByFighter when a fighter did it, else hurtByWorld), of the attacker if it is a target, else
   * UNKNOWN_STIMULUS; lkp = the attacker's position, or the impact point.
   */
  hurt(self: Fighter, attacker: Fighter | null, at: V3, tick: number): void {
    const S = CREATURE_TUNING.shared;
    const by = attacker && attacker !== self ? attacker : null;
    const key = by && by.team !== self.team ? by.id : UNKNOWN_STIMULUS;
    const level = Math.min(S.awarenessCap, by ? S.hurtByFighter : S.hurtByWorld);
    if (level > this.of(key)) this.awareness.set(key, level);
    this.setLkp(by ? by.pos : at, tick, Infinity);
  }

  /** The senses' part of the mind's save record (§6.8): awareness in insertion order, copies throughout. */
  toRecord(): SensesRecord {
    return {
      awareness: [...this.awareness].map(([id, a]) => [id, a] as [number, number]),
      lkp: this.lkp ? { x: this.lkp.x, y: this.lkp.y, z: this.lkp.z } : null,
      lkpTick: this.lkpTick,
      lastSeenTick: this.lastSeenTick,
    };
  }

  /** Restores toRecord()'s fields; the decision window starts empty (see `stimulus`). */
  restoreRecord(r: SensesRecord): void {
    this.awareness.clear();
    for (const [id, a] of r.awareness) this.awareness.set(id, a);
    this.lkp = r.lkp ? { x: r.lkp.x, y: r.lkp.y, z: r.lkp.z } : null;
    this.lkpTick = r.lkpTick;
    this.lastSeenTick = r.lastSeenTick;
    this.stimulus = 0;
  }

  /** awareness += gain, capped at awarenessCap. */
  private raise(id: number, gain: number): void {
    this.awareness.set(id, Math.min(CREATURE_TUNING.shared.awarenessCap, this.of(id) + gain));
  }

  private setLkp(p: V3, tick: number, strength: number): void {
    this.lkp = { x: p.x, y: p.y, z: p.z };
    this.lkpTick = tick;
    this.stimulus = strength;
  }
}
