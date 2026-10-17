// The giant ape's mind (docs/M1-DESIGN.md §6.4, §6.6; package P20): rest, patrol, investigate, chase, the telegraphed,
// committed straight-line charge (8°/s turn), recover, down (and the climb out of a pit), flee on a severe wound,
// severe-wound effects, deflection adoption, the `charge` script and chargeLineClear.
//
// The mind drives the body only through `f.drive` ({ heading, speed, accel, climb }) and `f.posture`; RulerMover
// (world/rulerBody.ts, §4.7) resolves the move (shoves, blocks, deflections, trips, ledges, the climb's limits) and the
// mind reads only the results: `ruler.deflectedHeading`, the body tripped or in a pit, its own speed when blocked.
//
// The generic fields of CreatureMind mean, for the giant:
// - `heading`: the heading it drives along (rad, the fighter yaw convention), turned toward what it wants at the state's
//   turn rate; in a charge the committed heading (§6.4), turned toward the player at ≤ turn.charge; in `down`, the
//   heading toward the nearest rim point it climbs out at;
// - `restUntil`: rest → when the rest ends; recover → when it stands again (braking time from its speed + recoverS);
// - `cooldownUntil`: the charge cooldown's end (a tick; the dev panel reads it);
// - `fleeUntil`: the end of the flee a severe wound started (a knock-down inside it flees on once up);
// - `mark`: investigate → when the sniff began (−1 while walking to lkp); charge → since when it has been slower than
//   blockedSpeed (−1 not); down → when the climb out of the pit began (−1 not yet); a charge script's phase tick;
// - `routeIdx`: patrol → the waypoint being walked to, counted along the loop (route[routeIdx % n]; past n: the lair);
//   a charge script's phase;
// - `charge`: the telegraph's and the charge's record (the committed heading, where it began, how far it has gone, a
//   close charge or not);
// - `home`: the lair (the spawner sets it; a giant made elsewhere rests where it was made).
// The route is the spawn data's (§6.7), or one set by hand (setRoute: a test, AC-3's two waypoints), saved as
// MindRecV1.route.
//
// TODO "jaw weakens bite attacks": weakJaw only quiets the roar in M1 (§12.4; NoiseBus.roar applies weakJawRoarMul).
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { ANKLE_HEIGHT, SKELETON } from '../../body/skeleton';
import type { MindRecV1 } from '../../save/schema';
import type { Fighter } from '../../sim/fighter';
import { angleDelta, approachAngle, DT } from '../../sim/math';
import { SPECIES_BODY } from '../../sim/species';
import type { Walkable } from '../collision';
import { RULER_BODY_TUNING, rulerKneeM } from '../rulerBody';
import type { Drive, SevereEffect, V3, WoundRecord } from '../types';
import type { World } from '../world';
import { CREATURE_TUNING } from './defs';
import { bodyDown, CreatureMind, type GroundXZ, type MindScript, type MindState } from './mind';
import { bearingDeg, hasSevereEffect, UNKNOWN_STIMULUS } from './perception';

const DEG = Math.PI / 180;
const flatDist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
/** rad, the fighter yaw convention: the heading from `a` toward `b`. */
const bearingTo = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.atan2(b.x - a.x, b.z - a.z);
const copy3 = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** A charge script's phases (MindScript 'charge', §6.6), kept in `routeIdx`. */
const SCRIPT_TELEGRAPH = 0;
const SCRIPT_GRACE = 1;
const SCRIPT_CHARGE = 2;
const SCRIPT_DONE = 3;

/**
 * m: a body's standing pelvis height at `scale` (the hip joint over straight legs, and the pelvis above it: 5.34 m at
 * 5.5), from the skeleton.
 */
export function rulerPelvisHeightM(scale: number): number {
  const thigh = SKELETON.thighL;
  return (thigh.length + SKELETON.shinL.length + ANKLE_HEIGHT - thigh.offset[1]) * scale;
}

/**
 * §6.4 "chargeLineClear(from, to)": nothing the giant can't see over stands on the line from `from` (its feet) to `to`
 * (the player's): a ball of radius probeRadiusM cast at probeHeightFrac × the pelvis height (≈ 2.9 m at 5.5, above the
 * 2.75 m knee) along the line meets neither the terrain nor an entity of at least probeMinMassKg that is fixed or
 * anchored (joined to an anchor included: EntityStore.isAnchored); and the terrain sampled every bankSampleM along it
 * (its end included) never rises more than bankMaxRiseM above `from`. So standing trunks stop a charge before it
 * starts, and shin-height logs and covered pits don't: the giant sees over them (SPEC:776, 781-782). The nav raycast is
 * not used (§12.3 R15). Like every query it sees colliders as of the last physics step. `scale`: the charging body's
 * (an addition to §6.4's signature; the giant ape's by default).
 */
export function chargeLineClear(w: World, from: V3, to: V3, scale: number = SPECIES_BODY.giantApe.scale): boolean {
  const G = CREATURE_TUNING.giant;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (G.bankSampleM > 0 && d > 0) {
    const n = Math.ceil(d / G.bankSampleM);
    for (let k = 1; k <= n; k++) {
      const t = Math.min(1, (k * G.bankSampleM) / d);
      if (w.terrain.heightAt(from.x + dx * t, from.z + dz * t) - from.y > G.bankMaxRiseM) return false;
    }
  }
  const h = G.probeHeightFrac * rulerPelvisHeightM(scale);
  const hit = w.physics.rapier.castShape(
    { x: from.x, y: from.y + h, z: from.z },
    IDENTITY,
    { x: dx, y: to.y - from.y, z: dz },
    new RAPIER.Ball(G.probeRadiusM),
    0,
    1,
    // A ball that starts inside something (the giant leaning on a trunk) is not stopped by it while it moves out.
    false,
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    undefined,
    undefined,
    (c) => {
      const o = w.physics.ownerOf(c.handle);
      if (!o) return false;
      if (o.kind === 'terrain') return true;
      if (o.kind !== 'entity') return false;
      const e = w.entities.get(o.id);
      return !!e && e.mass >= G.probeMinMassKg && w.entities.isAnchored(e);
    },
  );
  return !hit;
}

/**
 * rad: the heading from a ruler standing in a pit toward the nearest rim point (§6.4 `down`): the nearest terrain
 * vertex (searched ring by ring on the terrain's own grid, nearest first) that is out of the pit (within
 * pitOutDepthFrac × knee height of the original ground, as in-pit ends, §4.7) and no more than climbMaxM above the pit
 * floor it stands on (the climb can reach it, §4.7 step 3); the lowest of equally near ones. null when there is none.
 */
export function rimHeading(w: World, f: Fighter): number | null {
  const t = w.terrain;
  const T = RULER_BODY_TUNING;
  const s = t.spacing;
  const x0 = f.pos.x;
  const z0 = f.pos.z;
  const floor = f.pos.y;
  const outDepth = T.pitOutDepthFrac * rulerKneeM(f);
  const maxX = t.minX + t.tilesX * t.tileSize;
  const maxZ = t.minZ + t.tilesZ * t.tileSize;
  const rings = Math.ceil(Math.max(maxX - t.minX, maxZ - t.minZ) / s);
  let best: { d2: number; h: number; i: number; j: number } | null = null;
  const consider = (i: number, j: number): void => {
    const x = x0 + i * s;
    const z = z0 + j * s;
    if (x < t.minX || x > maxX || z < t.minZ || z > maxZ) return;
    const h = t.heightAt(x, z);
    if (t.originalHeightAt(x, z) - h > outDepth || h - floor > T.climbMaxM) return;
    const d2 = i * i + j * j;
    if (!best || d2 < best.d2 || (d2 === best.d2 && h < best.h)) best = { d2, h, i, j };
  };
  for (let k = 1; k <= rings; k++) {
    // The ring's nearest points are k away: once that is farther than the best found, nothing nearer is left.
    if (best && k * k > (best as { d2: number }).d2) break;
    for (let i = -k; i <= k; i++) {
      consider(i, -k);
      consider(i, k);
    }
    for (let j = -k + 1; j <= k - 1; j++) {
      consider(-k, j);
      consider(k, j);
    }
  }
  const b = best as { i: number; j: number } | null;
  return b ? Math.atan2(b.i, b.j) : null;
}

export class RulerMind extends CreatureMind {
  /** A patrol route set by hand (setRoute), or null: the spawn data's (§6.7). Saved as MindRecV1.route. */
  routeOverride: GroundXZ[] | null = null;

  // (No `heading` field here: CreatureMind's constructor starts it at the fighter's yaw.)

  /**
   * The patrol route from now on (route[0] the lair approach, §6.7), or null for the spawn data's; with `lair`, the lair
   * (its home) too. Patrol starts over from the route's first waypoint the next time it patrols.
   */
  setRoute(route: readonly GroundXZ[] | null, lair?: GroundXZ): void {
    this.routeOverride = route ? route.map((p) => ({ x: p.x, z: p.z })) : null;
    if (lair) this.setHome(lair, this.homeIdx);
  }

  /** The patrol loop: the route set by hand, or the spawn data's (none without spawn data). */
  route(w: World): readonly GroundXZ[] {
    return this.routeOverride ?? w.spawnData?.route ?? [];
  }

  /** The lair: its home (the spawner sets it to the spawn data's lair). */
  get lair(): GroundXZ {
    return this.home;
  }

  // -------------------------------------------------------------------------
  // Phase 2
  // -------------------------------------------------------------------------

  decide(w: World): void {
    const self = this.self;
    const G = CREATURE_TUNING.giant;
    const tick = w.tick;
    if (!self.alive) {
      if (this.state !== 'dead') this.enter(w, 'dead');
      return;
    }
    if (this.state === 'dead') this.enter(w, 'rest');
    // Down (§6.4): tripped (and rising), or in a pit; up, still in the pit, it climbs out toward the nearest rim point,
    // roaring as it starts (RR-1).
    if (bodyDown(self) || self.ruler?.inPit) {
      if (this.state !== 'down') this.enter(w, 'down');
      if (!bodyDown(self) && this.mark < 0) {
        this.mark = tick;
        this.heading = rimHeading(w, self) ?? this.heading;
        w.noise.roar(self);
      }
      return;
    }
    if (this.state === 'down') {
      // Up and out of the pit: recover (§6.4), or flee on when a severe wound's flee was cut short (INTERPRETATION:
      // "any severe wound → flee"; a trip on the wounding tick must not cancel it).
      return this.enter(w, tick < this.fleeUntil ? 'flee' : 'recover');
    }
    const target = this.huntTarget(w);
    const hunting = target !== null && this.senses.of(target.id) >= G.chaseAt && this.senses.seenWithin(tick);
    switch (this.state) {
      case 'rest': {
        if (hunting) return this.enter(w, 'chase');
        if (this.noticed()) return this.enter(w, 'investigate');
        if (tick >= this.restUntil) return this.enter(w, 'patrol');
        return;
      }
      case 'patrol': {
        if (hunting) return this.enter(w, 'chase');
        if (this.noticed()) return this.enter(w, 'investigate');
        const route = this.route(w);
        const n = route.length;
        for (;;) {
          const toLair = n === 0 || this.routeIdx > n;
          const goal = this.ground(toLair ? this.lair : route[this.routeIdx % n]);
          if (!(this.path.done || this.path.unreachable || flatDist(self.pos, goal) <= G.arriveM)) {
            this.path.goTo(w, self, goal);
            return;
          }
          if (toLair) return this.enter(w, 'rest');
          this.routeIdx++;
          this.path.clear();
        }
      }
      case 'investigate': {
        if (hunting) return this.enter(w, 'chase');
        const lkp = this.senses.lkp;
        if (this.mark >= 0) {
          // Sniffing; a new stimulus somewhere else sends it to see.
          const elsewhere = lkp !== null && this.senses.lkpTick > this.mark && flatDist(lkp, self.pos) > G.investigateStopM;
          if (!elsewhere) {
            if (tick - this.mark >= Math.round(G.sniffS / DT)) this.enter(w, 'patrol');
            return;
          }
          this.mark = -1;
          this.path.clear();
        }
        if (!lkp || this.path.unreachable) return this.enter(w, 'patrol');
        const goal = this.path.goal;
        const arrived = flatDist(lkp, self.pos) <= G.investigateStopM || (this.path.done && goal !== null && flatDist(goal, lkp) <= G.repathMoveM);
        if (arrived) {
          this.mark = tick;
          this.path.clear();
          return;
        }
        // (The ground under it: a sound's point may be high up, a falling trunk's centre, where no navmesh is.)
        this.path.goTo(w, self, this.ground(lkp));
        return;
      }
      case 'chase': {
        if (!target) return this.enter(w, this.senses.lkp ? 'investigate' : 'patrol');
        self.target = target;
        if (!this.senses.seenWithin(tick, G.chaseMemoryS) || this.path.unreachable) return this.enter(w, 'investigate');
        const close = this.chargeReady(w, target);
        if (close !== null) {
          this.enter(w, 'telegraph');
          this.charge = { heading: bearingTo(self.pos, target.pos), start: copy3(self.pos), travelled: 0, close };
          return;
        }
        // Seen: where it is; unseen: where it was last known to be (a mind doesn't cheat).
        const seen = this.senses.seenWithin(tick);
        this.path.goTo(w, self, seen || !this.senses.lkp ? target.pos : this.ground(this.senses.lkp), G.repathTicks);
        return;
      }
      case 'telegraph': {
        if (tick - this.stateTick < this.telegraphTicks(this.charge?.close ?? false)) return;
        // Commit: the bearing to the player's position at this instant (§6.4), a leg's width aside (legAim).
        const t = self.target && self.target.alive ? self.target : target;
        const heading = t ? legAim(self, self.yaw, t.pos) : this.heading;
        const close = this.charge?.close ?? false;
        this.enter(w, 'charge');
        this.heading = heading;
        this.charge = { heading, start: copy3(self.pos), travelled: 0, close };
        return;
      }
      case 'charge': {
        const c = this.charge;
        if (!c) return this.enter(w, 'recover');
        c.travelled = flatDist(c.start, self.pos);
        if (c.travelled >= (c.close ? G.closeChargeDistM : G.chargeMaxDistM)) return this.enter(w, 'recover');
        const t = self.target;
        if (t && t.alive) {
          const ahead = Math.sin(this.heading) * (t.pos.x - self.pos.x) + Math.cos(this.heading) * (t.pos.z - self.pos.z);
          if (ahead < -G.passEndM) return this.enter(w, 'recover');
        }
        if (this.blocked(tick, this.stateTick)) return this.enter(w, 'recover');
        return;
      }
      case 'recover': {
        if (tick < this.restUntil) return;
        if (hunting) return this.enter(w, 'chase');
        return this.enter(w, this.senses.lkp ? 'investigate' : 'patrol');
      }
      case 'flee': {
        // Ignoring the player (§6.4) until the flee is over; then it rests where it is (the lair, if it got there).
        if (tick >= this.fleeUntil) return this.enter(w, 'rest');
        const lair = this.ground(this.lair);
        if (flatDist(self.pos, lair) > G.arriveM && !this.path.unreachable) this.path.goTo(w, self, lair);
        return;
      }
      default:
        // Not a giant's state (the ape's idle, a fresh mind): it settles at rest.
        this.enter(w, 'rest');
        return;
    }
  }

  /** A stimulus since this state began has raised its awareness to investigateAt (§6.2 Thresholds). */
  private noticed(): boolean {
    const s = this.senses;
    return s.lkp !== null && s.lkpTick >= this.stateTick && s.level() >= CREATURE_TUNING.giant.investigateAt;
  }

  /**
   * §6.4 "Charge conditions": in chase (the caller's); the target seen this tick; the cooldown over; either chargeMinM ≤
   * d ≤ chargeMaxM within chargeBearingDeg, or d < closeChargeM within closeBearingDeg (the close charge); and the line
   * clear (chargeLineClear). Returns whether it is a close charge, or null when it can't charge.
   */
  private chargeReady(w: World, target: Fighter): boolean | null {
    const G = CREATURE_TUNING.giant;
    const self = this.self;
    if (this.senses.lastSeenTick !== w.tick || w.tick < this.cooldownUntil) return null;
    const dx = target.pos.x - self.pos.x;
    const dz = target.pos.z - self.pos.z;
    const d = Math.hypot(dx, dz);
    const beta = Math.abs(bearingDeg(self, dx, dz));
    const far = d >= G.chargeMinM && d <= G.chargeMaxM && beta <= G.chargeBearingDeg;
    const close = d < G.closeChargeM && beta <= G.closeBearingDeg;
    if (!far && !close) return null;
    if (!chargeLineClear(w, self.pos, target.pos, self.scale)) return null;
    return !far;
  }

  /** Ticks of telegraph: telegraphS (closeTelegraphS for a close charge), × limpTelegraphMul with a limp. */
  private telegraphTicks(close: boolean): number {
    const G = CREATURE_TUNING.giant;
    return Math.round(((close ? G.closeTelegraphS : G.telegraphS) * (this.has('limp') ? G.limpTelegraphMul : 1)) / DT);
  }

  /**
   * §6.4 charge → recover "when blocked": slower than blockedSpeed for blockedTicks ticks in a row, counted only after
   * the first blockedGraceS since `start` (the acceleration from the telegraph's walk). `mark` is where the slow run began.
   */
  private blocked(tick: number, start: number): boolean {
    const G = CREATURE_TUNING.giant;
    if (tick - start < Math.round(G.blockedGraceS / DT)) {
      this.mark = -1;
      return false;
    }
    const self = this.self;
    if (Math.hypot(self.walkVel.x, self.walkVel.z) >= G.blockedSpeed) {
      this.mark = -1;
      return false;
    }
    if (this.mark < 0) this.mark = tick;
    return tick - this.mark + 1 >= G.blockedTicks;
  }

  /** A severe wound with this effect (wounds on rulers persist, §2.9). */
  private has(effect: SevereEffect): boolean {
    return hasSevereEffect(this.self, effect);
  }

  /** × limpSpeedMul with a limp (every speed but the charge's, §6.4). */
  private speedMul(): number {
    return this.has('limp') ? CREATURE_TUNING.giant.limpSpeedMul : 1;
  }

  /** °/s × limpTurnMul with a limp. */
  private turn(rateDegS: number): number {
    return rateDegS * (this.has('limp') ? CREATURE_TUNING.giant.limpTurnMul : 1);
  }

  /** °: the approach offset that keeps a sound on the good eye's side (§6.4 investigate; + turns left). */
  private blindOffsetDeg(): number {
    const G = CREATURE_TUNING.giant;
    const l = this.has('blindL');
    const r = this.has('blindR');
    if (l === r) return 0;
    // Blind on the left: the sound kept on its right, so it heads left of it (bearings + toward the left, perception.ts).
    return l ? G.blindApproachDeg : -G.blindApproachDeg;
  }

  /** Index of the route waypoint nearest the giant (the first of equally near ones), 0 without a route. */
  private nearestWaypoint(w: World): number {
    const route = this.route(w);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < route.length; i++) {
      const d = flatDist(route[i], this.self.pos);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  protected onEnter(w: World, state: MindState, from: MindState): void {
    const self = this.self;
    const G = CREATURE_TUNING.giant;
    const tick = w.tick;
    this.path.clear();
    self.posture = null;
    // The charge cooldown runs from the charge's end, however it ends (§6.4 recover), × windedCooldownMul winded.
    if (from === 'charge' && state !== 'charge') {
      this.cooldownUntil = tick + Math.round((G.chargeCooldownS * (this.has('winded') ? G.windedCooldownMul : 1)) / DT);
    }
    if (state !== 'telegraph' && state !== 'charge') this.charge = null;
    switch (state) {
      case 'rest':
        self.target = null;
        this.restUntil = tick + (from === 'flee' ? Math.round(G.lairRestS / DT) : this.ticksIn(G.restS));
        return;
      case 'patrol':
        self.target = null;
        // From the lair the whole loop from its first waypoint; else on from the nearest one (§6.4 investigate).
        this.routeIdx = from === 'rest' ? 0 : this.nearestWaypoint(w);
        return;
      case 'investigate':
        self.target = null;
        return;
      case 'chase':
      case 'telegraph':
        self.target = this.huntTarget(w) ?? self.target;
        if (state === 'telegraph') w.noise.roar(self);
        return;
      case 'recover': {
        // Brakes at `brake` from the speed it has, then stands recoverS.
        const v = Math.hypot(self.walkVel.x, self.walkVel.z);
        this.restUntil = tick + Math.ceil(v / Math.max(G.brake, 1e-9) / DT) + Math.round(G.recoverS / DT);
        return;
      }
      case 'flee':
        self.target = null;
        if (this.fleeUntil <= tick) this.fleeUntil = tick + Math.round(G.fleeSevereS / DT);
        return;
      case 'dead':
        // A dead creature senses nothing (its awareness wouldn't decay); one brought back starts afresh.
        self.target = null;
        this.senses.awareness.clear();
        this.senses.lkp = null;
        return;
      default:
        return;
    }
  }

  /** Ticks in a [min, max] seconds range, drawn from the mind's stream. */
  private ticksIn(range: readonly number[]): number {
    return Math.round(this.rng.range(range[0], range[1]) / DT);
  }

  // -------------------------------------------------------------------------
  // Wounds (§6.4 "Wounds and severe effects")
  // -------------------------------------------------------------------------

  /**
   * A wound (phase 17b, after the bus's roar): awareness of what wounded it (the attacker when a fighter of another team
   * did it, else "something") at least woundAwareness; lkp the wound's point; a severe wound sends it to its lair for
   * fleeSevereS (a knock-down meanwhile flees on once up).
   * INTERPRETATION (§6.4 "lkp = the wound's point"): for a fighter's own blow the bus has just set lkp to the attacker
   * (being hurt, §6.2), which says where the threat is better than a point on its own body; that stays.
   */
  onWound(wd: WoundRecord): void {
    const w = this.world;
    const self = this.self;
    const G = CREATURE_TUNING.giant;
    if (!self.alive) return;
    const by = wd.cause.fighterId;
    const attacker = by === null ? null : (w.combat.fighters.find((f) => f.id === by) ?? null);
    const key = attacker && attacker !== self && attacker.team !== self.team ? attacker.id : UNKNOWN_STIMULUS;
    const level = Math.min(CREATURE_TUNING.shared.awarenessCap, G.woundAwareness);
    if (this.senses.of(key) < level) this.senses.awareness.set(key, level);
    if (!attacker || attacker === self) {
      this.senses.lkp = woundPoint(self, wd);
      this.senses.lkpTick = w.tick;
      this.senses.stimulus = Infinity;
    }
    if (wd.severe) {
      this.fleeUntil = w.tick + Math.round(G.fleeSevereS / DT);
      if (!bodyDown(self) && !self.ruler?.inPit) this.enter(w, 'flee');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3
  // -------------------------------------------------------------------------

  /**
   * A deflection the mover reported (§4.7 step 6.1) is adopted by a charge (act, chargeScript); anything else consumes
   * it unread, so a stale one never turns a later charge.
   */
  think(self: Fighter, target: Fighter | null, wk: Walkable | null): void {
    const r = self.ruler;
    if (r && r.deflectedHeading !== null && !this.charging()) r.deflectedHeading = null;
    super.think(self, target, wk);
  }

  /** In a charge: the brain's, or a charge script's charge phases. */
  private charging(): boolean {
    const s = this.script;
    if (s) return s.kind === 'charge' && (this.routeIdx === SCRIPT_GRACE || this.routeIdx === SCRIPT_CHARGE);
    return this.state === 'charge';
  }

  protected act(self: Fighter, _wk: Walkable | null): void {
    const G = CREATURE_TUNING.giant;
    const w = this.world;
    const tick = w.tick;
    const k = this.speedMul();
    self.posture = null;
    switch (this.state) {
      case 'patrol':
        this.follow(self, G.speed.patrol * k, this.turn(G.turn.patrol), G.accel.patrol);
        return;
      case 'investigate': {
        const off = this.blindOffsetDeg() * DEG;
        if (this.mark < 0) {
          this.follow(self, G.speed.investigate * k, this.turn(G.turn.patrol), G.accel.patrol, off);
          return;
        }
        // Sniffing: stopped, head down, the body swept ±sniffDeg about the sound (a triangle wave over sniffS: out to
        // one side, across to the other, back), with the good eye toward it.
        this.halt(self);
        self.posture = { id: 'sniff', weight: 1 };
        const lkp = this.senses.lkp;
        const centre = (lkp ? bearingTo(self.pos, lkp) : this.heading) + off;
        const period = Math.max(G.sniffS, DT);
        const u = (((tick - this.mark) * DT) / period) % 1;
        const tri = u < 0.25 ? 4 * u : u < 0.75 ? 2 - 4 * u : 4 * u - 4;
        const rate = (4 * G.sniffDeg) / period;
        this.driveAt(self, centre + tri * G.sniffDeg * DEG, rate, 0, G.brake);
        return;
      }
      case 'chase': {
        const t = self.target;
        const speed = G.speed.chase * k * (this.has('winded') ? G.windedChaseMul : 1);
        const seen = this.senses.seenWithin(tick);
        // While a path is asked for, a seen player is run at straight.
        this.follow(self, speed, this.turn(G.turn.chase), G.accel.chase, 0, seen && t ? t.pos : null);
        return;
      }
      case 'telegraph': {
        const t = self.target;
        const want = t && t.alive ? bearingTo(self.pos, t.pos) : null;
        this.driveAt(self, want, this.turn(G.turn.telegraph), G.speed.telegraph * k, G.accel.telegraph);
        self.posture = { id: 'headLow', weight: Math.min(1, (tick - this.stateTick + 1) / Math.max(1, this.telegraphTicks(this.charge?.close ?? false))) };
        return;
      }
      case 'charge': {
        this.adoptDeflection(self);
        const t = self.target;
        // Toward the player's current bearing (where it sees him, else where it last saw him) at ≤ turn.charge, a leg's
        // width aside (legAim).
        const at = t && t.alive ? (this.senses.seenWithin(tick) ? t.pos : this.senses.lkp) : null;
        this.driveAt(self, at ? legAim(self, this.heading, at) : null, this.turn(G.turn.charge), G.speed.charge * (this.has('limp') ? G.limpChargeMul : 1), G.accel.charge);
        if (this.charge) this.charge.heading = this.heading;
        self.posture = { id: 'headLow', weight: 1 };
        return;
      }
      case 'down': {
        // Up in a pit: climbing out toward the rim point (§4.7 step 3: the mover slows and limits it), climb set
        // while it is in the pit (§6.4).
        if (!self.ruler?.inPit) {
          this.halt(self);
          return;
        }
        const d = this.driveOf(self);
        d.heading = this.heading;
        d.speed = RULER_BODY_TUNING.climbWalkMps;
        d.accel = G.accel.patrol;
        d.climb = true;
        self.moveInput.set(0, 0, 0);
        self.posture = { id: 'climbOut', weight: 1 };
        return;
      }
      case 'flee': {
        const lair = this.lair;
        if (flatDist(self.pos, lair) <= G.arriveM) {
          this.halt(self);
          return;
        }
        this.follow(self, G.speed.flee * k, this.turn(G.turn.chase), G.accel.chase);
        return;
      }
      default:
        // rest (idle life at the lair), recover (braking, then standing), dead.
        this.halt(self);
        return;
    }
  }

  /** The heading becomes a deflection's (the wall's direction), which is cleared (§6.4 charge). */
  private adoptDeflection(self: Fighter): void {
    const r = self.ruler;
    if (!r || r.deflectedHeading === null) return;
    this.heading = r.deflectedHeading;
    r.deflectedHeading = null;
  }

  /** The fighter's drive (made, standing along its yaw, if it has none). */
  private driveOf(self: Fighter): Drive {
    if (!self.drive) self.drive = { heading: self.yaw, speed: 0, accel: CREATURE_TUNING.giant.brake, climb: false };
    return self.drive;
  }

  /**
   * Drive: `heading` turned toward `want` (rad; null keeps it) at ≤ `rateDegS`, at `speed` reached at `accel`; no
   * climb, no move input.
   */
  private driveAt(self: Fighter, want: number | null, rateDegS: number, speed: number, accel: number): void {
    if (want !== null) this.heading = approachAngle(this.heading, want, rateDegS * DEG * DT);
    const d = this.driveOf(self);
    d.heading = this.heading;
    d.speed = speed;
    d.accel = accel;
    d.climb = false;
    self.moveInput.set(0, 0, 0);
    self.moveFlags = 0;
  }

  /**
   * Follows the path (§6.5): the heading turns toward its corner at ≤ `rateDegS` (+ `offset` rad: the blind eye's
   * approach), and the speed slows to max(cornerMinFrac, cos Δ) × `speed` while Δ, the heading's error, is large
   * ("slows into corners"). Without a corner it heads for `fallback` when given, else brakes and stands. True while it
   * moves.
   */
  private follow(self: Fighter, speed: number, rateDegS: number, accel: number, offset = 0, fallback: V3 | null = null): boolean {
    const G = CREATURE_TUNING.giant;
    const c = this.path.corner(self) ?? fallback;
    if (!c) {
      this.halt(self);
      return false;
    }
    const want = bearingTo(self.pos, c) + offset;
    this.heading = approachAngle(this.heading, want, rateDegS * DEG * DT);
    const err = Math.abs(angleDelta(this.heading, want));
    this.driveAt(self, null, rateDegS, speed * Math.max(G.cornerMinFrac, Math.cos(err)), accel);
    return true;
  }

  // -------------------------------------------------------------------------
  // The CreatureMind output helpers, through the drive
  // -------------------------------------------------------------------------

  /** No input; the drive stops (braking at `brake`), no climb. */
  protected halt(self: Fighter): void {
    self.moveInput.set(0, 0, 0);
    const d = this.driveOf(self);
    d.speed = 0;
    d.accel = CREATURE_TUNING.giant.brake;
    d.climb = false;
  }

  /** Stands (the giant never crouches). */
  protected stand(self: Fighter, _crouch = false): void {
    this.halt(self);
    self.moveFlags = 0;
  }

  /** Walks along (dx, dz) at `gait` × its walk speed (gaitFor's inverse), turning at once, at the chase accel. */
  protected walk(self: Fighter, dx: number, dz: number, gait: number, _crouch = false): void {
    const k = self.stats.walkSpeed * Math.max(self.motion.speed, 1e-9);
    if (!(Math.hypot(dx, dz) > 1e-9)) {
      this.stand(self);
      return;
    }
    this.heading = Math.atan2(dx, dz);
    this.driveAt(self, null, 0, Math.max(0, gait) * k, CREATURE_TUNING.giant.accel.chase);
  }

  /** Follows the path at `gait` × its walk speed (a navigated route script), at the chase turn and accel. */
  protected steer(self: Fighter, gait: number, _crouch = false): boolean {
    const G = CREATURE_TUNING.giant;
    const k = self.stats.walkSpeed * Math.max(self.motion.speed, 1e-9);
    return this.follow(self, Math.max(0, gait) * k, G.turn.chase, G.accel.chase);
  }

  /** The gait that walks at `speed` (unclamped: the drive takes any speed). */
  protected gaitFor(self: Fighter, speed: number, _crouch: boolean): number {
    return Math.max(0, speed) / (self.stats.walkSpeed * Math.max(self.motion.speed, 1e-9));
  }

  // -------------------------------------------------------------------------
  // Scripts (§6.6)
  // -------------------------------------------------------------------------

  /** A route script walks at the patrol speed unless it names a speed or a gait. */
  protected routeScript(self: Fighter, s: Extract<MindScript, { kind: 'route' }>): void {
    if (s.speed === undefined && s.gait === undefined) super.routeScript(self, { ...s, speed: CREATURE_TUNING.giant.speed.patrol });
    else super.routeScript(self, s);
  }

  /** Phase 2 for a script: a charge ends when the body goes down (a trip); a route keeps its path. */
  protected planScript(w: World, s: MindScript): void {
    if (s.kind === 'charge') {
      if (bodyDown(this.self) && this.routeIdx < SCRIPT_DONE) this.endScriptCharge();
      return;
    }
    super.planScript(w, s);
  }

  /**
   * The `charge` script (§6.6): the giant's charge state along `heading` at `speed`, straight (the brain's homing on
   * the player is its own), the telegraph first only when asked (telegraphS, posture headLow, the roar); deflections
   * adopted as in play; it ends, braking to a stand, after chargeMaxDistM, when blocked, or on a trip. `routeIdx` is the
   * phase, `mark` the phase's tick (the telegraph's start, the charge's start for the blocked grace) or the slow run's.
   */
  protected chargeScript(self: Fighter, s: Extract<MindScript, { kind: 'charge' }>): void {
    const G = CREATURE_TUNING.giant;
    const w = this.world;
    const tick = w.tick;
    if (this.routeIdx === SCRIPT_TELEGRAPH) {
      if (s.telegraph) {
        if (this.mark < 0) {
          this.mark = tick;
          w.noise.roar(self);
        }
        const n = this.telegraphTicks(false);
        if (tick - this.mark < n) {
          this.driveAt(self, s.heading, this.turn(G.turn.telegraph), G.speed.telegraph * this.speedMul(), G.accel.telegraph);
          self.posture = { id: 'headLow', weight: Math.min(1, (tick - this.mark + 1) / Math.max(1, n)) };
          return;
        }
      }
      this.heading = s.heading;
      this.charge = { heading: s.heading, start: copy3(self.pos), travelled: 0, close: false };
      this.routeIdx = SCRIPT_GRACE;
      this.mark = tick;
    }
    if (this.routeIdx === SCRIPT_GRACE || this.routeIdx === SCRIPT_CHARGE) {
      this.adoptDeflection(self);
      const c = this.charge;
      if (c) {
        c.travelled = flatDist(c.start, self.pos);
        c.heading = this.heading;
      }
      let done = !c || c.travelled >= G.chargeMaxDistM;
      if (!done && this.routeIdx === SCRIPT_GRACE && tick - this.mark >= Math.round(G.blockedGraceS / DT)) {
        this.routeIdx = SCRIPT_CHARGE;
        this.mark = -1;
      }
      if (!done && this.routeIdx === SCRIPT_CHARGE) done = this.blocked(tick, -Infinity);
      if (!done) {
        this.driveAt(self, null, 0, s.speed, G.accel.charge);
        self.posture = { id: 'headLow', weight: 1 };
        return;
      }
      this.endScriptCharge();
    }
    this.halt(self);
  }

  /** The charge script is over: it brakes and stands (scriptDone). */
  private endScriptCharge(): void {
    this.routeIdx = SCRIPT_DONE;
    this.mark = -1;
    this.charge = null;
    this.self.posture = null;
  }

  get scriptDone(): boolean {
    const s = this.script;
    if (s?.kind === 'charge') return this.routeIdx >= SCRIPT_DONE;
    return super.scriptDone;
  }

  // -------------------------------------------------------------------------
  // Save record (§6.8)
  // -------------------------------------------------------------------------

  /** CreatureMind's record with the giant's own field: `route`, the route set by hand (null: the spawn data's). */
  toRecord(): MindRecV1 {
    const r = super.toRecord();
    r.route = this.routeOverride ? this.routeOverride.map((p) => ({ x: p.x, z: p.z })) : null;
    return r;
  }

  restoreRecord(r: MindRecV1): void {
    super.restoreRecord(r);
    if (r.route === undefined) throw new Error(`RulerMind.restoreRecord: fighter ${r.fighter}'s record has no route (a giant's record always has one)`);
    this.routeOverride = r.route ? r.route.map((p) => ({ x: p.x, z: p.z })) : null;
  }
}

/**
 * rad: the heading that runs one of the giant's legs, not the gap between them, through `at` (the player): the bearing
 * to it turned aside by asin(a / d), a = how far its feet stand out from its root (the mean of the two, from the
 * footwork), so that `at` lies on the line of the leg on its side of the heading `h` (the left leg when dead ahead).
 * DEVIATION (§6.4 "commits RulerMind.heading = the bearing to the player's position"; "turns toward the player's
 * current bearing"): the B lab's dodge table models the giant as a 1.95 m disc, but its real body meets a 1.8 m
 * player only with its shins (its knee is 2.75 m up), which stand ±0.8 m out with a 0.8 m gap between them: aimed at
 * its centre, the charge straddles a standing player and never touches him (measured: no contact at 7 m/s, the
 * player then pushed 2 m aside by separate() once the root has passed). Aimed with a leg, it hits him (rule 9, §4.4
 * RF-5: the charge is a contact). A few degrees at charge range (3° at 15 m).
 */
function legAim(f: Fighter, h: number, at: { x: number; z: number }): number {
  const dx = at.x - f.pos.x;
  const dz = at.z - f.pos.z;
  const d = Math.hypot(dx, dz);
  const b = Math.atan2(dx, dz);
  if (!(d > 0)) return b;
  const c = Math.cos(h);
  const s = Math.sin(h);
  let a = 0;
  for (const side of ['L', 'R'] as const) {
    const p = f.footwork.foot(side).pos;
    a += Math.abs((p.x - f.pos.x) * c - (p.z - f.pos.z) * s) / 2;
  }
  const left = dx * c - dz * s;
  return b - (left >= 0 ? 1 : -1) * Math.asin(Math.min(1, a / d));
}

/** The world point of a wound (its bone's frame at the rig's pose; WoundRecord.local is in bone units, × scale). */
function woundPoint(f: Fighter, wd: WoundRecord): V3 {
  const x = f.rig[wd.bone];
  const p = new Vector3(wd.local.x, wd.local.y, wd.local.z).multiplyScalar(f.scale).applyQuaternion(x.rot).add(x.pos);
  return { x: p.x, y: p.y, z: p.z };
}
