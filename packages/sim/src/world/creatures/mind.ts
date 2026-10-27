// Creature minds (docs/M1-DESIGN.md §1.5.10, §6.1, §6.5, §6.6): CreatureMind implements CombatSim's Brain for one
// creature (senses in phase 2, decisions, path requests; moveInput or drive and posture in phase 3), test scripts that
// drive a creature (never a trap), the pause, and MindRegistry, which runs them in fighter-id order.
//
// - Phase 2 (MindRegistry.sense, fighter order = id order): a mind runs fully when its creature is within aiNearM of a
//   player (every mind does in a world without players), otherwise when (tick + id) % aiFarPeriodTicks === 0 with
//   Δt = 1 s (SPEC:698, 789). Running is: sight; then the script's path upkeep (a scripted creature), or `decide` (the
//   species' transitions and path requests); then the path's upkeep (tile versions, the stuck window). Path requests
//   are then served, at most navQueriesPerTick a tick, in (requestTick, fighter id) order.
// - Phase 3 (`think`, CombatSim's brain site, every tick for every mind): nothing (moveInput zeroed, drive stopped)
//   while the body is down (knockdown, getup, ko, tripped) or the mind is paused; a script if one runs; else the
//   species' `act`. A paused mind also pauses idle life (`idlePaused`, §12.2 I16).
// - Scripts (§6.6; `mind.script`): route, hold and tug here (the giant's charge is RulerMind's). While one runs, senses
//   update but transitions are suspended; setting `script` restarts its progress (routeIdx, mark) and drops the path.
//   A finished script stays (the creature stands) until it is replaced or cleared.
// - Generic memory and timers (§6.8): `hurt` (what last hurt it, SPEC:757), `home`/`homeIdx`, `routeIdx`, `restUntil`,
//   `cooldownUntil` (the giant's charge cooldown; the dev panel reads it), `fleeUntil`, `heading`, `charge`, `resume`
//   (the state before `down`), `mark` (a tick the current state measures from). Each species gives them their meaning
//   (apeMind.ts, rulerMind.ts); toRecord/restoreRecord save them all, so P20 builds on this base unchanged.
// - Mind randomness uses the world's 'mind:<fighter id>' stream (§8.1); nothing here reads wall time.
import type { BrawlerRecV1, MindRecV1 } from '../../save/schema';
import type { AIConfig, AIDirector, Brain } from '../../sim/ai';
import type { Drop } from '../../sim/combat';
import { MOVE_CROUCH } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { DT, type Rng } from '../../sim/math';
import { MOVE_TUNING } from '../../sim/rules';
import type { Walkable } from '../collision';
import type { NavLayer } from '../nav';
import type { ImpactCause, PostureId, V3, WoundRecord } from '../types';
import { inTakeReach } from '../verbs/hands';
import { chestPoint } from '../verbs/targets';
import { VERB_TUNING } from '../verbs/tuning';
import type { World } from '../world';
import { WORLD_TUNING } from '../worldTuning';
import { CREATURE_TUNING } from './defs';
import { PathFollower } from './pathFollow';
import { Senses } from './perception';

export type MindState =
  | 'idle'
  | 'patrol'
  | 'investigate'
  | 'chase'
  | 'fight'
  | 'flee'
  | 'return'
  | 'rest'
  | 'telegraph'
  | 'charge'
  | 'recover'
  | 'down'
  | 'dead';

/**
 * Every MindState, as a domain the compiler checks complete (a state added to the union and not here fails the
 * typecheck); the save's loader checks a saved `state` and `resume` against it (save/load.ts).
 */
export const MIND_STATE_DOMAIN: Readonly<Record<MindState, true>> = {
  idle: true,
  patrol: true,
  investigate: true,
  chase: true,
  fight: true,
  flee: true,
  return: true,
  rest: true,
  telegraph: true,
  charge: true,
  recover: true,
  down: true,
  dead: true,
};

/**
 * Scripts drive creatures in tests (§6.6); while one runs, senses update but transitions are suspended.
 * `route.crouch` is an addition (P19): AC-2(a) routes the ape crouched under the deadfall log (§11.2(a) step 4).
 */
export type MindScript =
  | { kind: 'route'; points: { x: number; z: number }[]; speed?: number; gait?: number; useNav?: boolean; crouch?: boolean }
  | { kind: 'charge'; heading: number; speed: number; telegraph?: boolean }
  | { kind: 'tug'; entity: number; dirYaw: number; ticks: number }
  | { kind: 'hold'; posture?: PostureId };

/** A read-only view for the client's awareness markers (rule 3; never an input). */
export interface MindView {
  state: MindState;
  awareness: number;
  /** '?' investigating, '!' chasing or fighting. */
  marker: '' | '?' | '!';
}

/** A point on the ground plane. */
export interface GroundXZ {
  x: number;
  z: number;
}

/** A committed charge (the giant's, §6.4; saved as MindRecV1.charge). */
export interface ChargeRecord {
  heading: number;
  start: V3;
  travelled: number;
  close: boolean;
}

const copy3 = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });
const flatDist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** The body is down: knocked down, getting up, out, or tripped (a mind writes nothing then, §6.1). */
export function bodyDown(f: Fighter): boolean {
  return f.state === 'knockdown' || f.state === 'getup' || f.state === 'ko' || f.state === 'tripped';
}

/** A copy of a script with its keys in a fixed order and absent options left out (the save writes it). */
export function copyMindScript(s: MindScript): MindScript {
  switch (s.kind) {
    case 'route': {
      const o: Extract<MindScript, { kind: 'route' }> = { kind: 'route', points: s.points.map((p) => ({ x: p.x, z: p.z })) };
      if (s.speed !== undefined) o.speed = s.speed;
      if (s.gait !== undefined) o.gait = s.gait;
      if (s.useNav !== undefined) o.useNav = s.useNav;
      if (s.crouch !== undefined) o.crouch = s.crouch;
      return o;
    }
    case 'charge': {
      const o: Extract<MindScript, { kind: 'charge' }> = { kind: 'charge', heading: s.heading, speed: s.speed };
      if (s.telegraph !== undefined) o.telegraph = s.telegraph;
      return o;
    }
    case 'tug':
      return { kind: 'tug', entity: s.entity, dirYaw: s.dirYaw, ticks: s.ticks };
    case 'hold':
      return s.posture !== undefined ? { kind: 'hold', posture: s.posture } : { kind: 'hold' };
  }
}

export abstract class CreatureMind implements Brain {
  readonly cfg: AIConfig;
  director: AIDirector | null = null;
  drops: Drop[] = [];
  readonly ownsTarget = true;
  state: MindState = 'idle';
  /** The tick the current state was entered (kept through `down`, which resumes the state). */
  stateTick: number;
  /** The state to go back to once a creature knocked down is up (§6.3 `down`); null otherwise. */
  resume: MindState | null = null;
  /** A tick the current state measures from (each species gives it its meaning); −1 unset. */
  mark = -1;
  /** AC-5's "AI paused": no drive or input, idle life paused (§6.6). */
  paused = false;
  readonly senses = new Senses();
  readonly path: PathFollower;
  /** The world's 'mind:<fighter id>' stream. */
  readonly rng: Rng;
  readonly self: Fighter;
  readonly world: World;
  /** What last hurt it: when and where (memory, SPEC:757). */
  hurt: { tick: number; point: V3 } | null = null;
  /** Home: the spawner's home point, or where the creature was made. */
  home: GroundXZ;
  /** The spawn data's home it came from (ClearingSpawnData.apeHomes for an ape), −1 none. */
  homeIdx = -1;
  /** The waypoint being walked to (a patrol loop, a scripted route) or a script's phase. */
  routeIdx = 0;
  restUntil = -1;
  /** The giant's charge cooldown end (a tick; the dev panel reads it); an ape's next wander pick. */
  cooldownUntil = -1;
  fleeUntil = -1;
  /** rad, the fighter yaw convention: a committed heading (the giant), a look-around's centre (the ape). */
  heading: number;
  charge: ChargeRecord | null = null;
  private current: MindScript | null = null;

  constructor(w: World, self: Fighter, cfg: AIConfig, layer: NavLayer) {
    this.world = w;
    this.self = self;
    this.cfg = cfg;
    this.path = new PathFollower(layer);
    this.rng = w.rngs.mind(self.id);
    this.stateTick = w.tick;
    this.home = { x: self.pos.x, z: self.pos.z };
    this.heading = self.yaw;
  }

  /** The species the record names. */
  get kind(): 'ape' | 'giantApe' {
    return this.self.ruler || this.self.species === 'giantApe' ? 'giantApe' : 'ape';
  }

  /** The script running, or null. Setting one restarts its progress and drops the path (a tug lets go). */
  get script(): MindScript | null {
    return this.current;
  }

  set script(s: MindScript | null) {
    const was = this.current;
    this.current = s ? copyMindScript(s) : null;
    this.routeIdx = 0;
    this.mark = -1;
    this.path.clear();
    if (was?.kind === 'tug') this.world.verbs.tug(this.self, null);
  }

  /** The home this creature returns to (and the spawn data's home index, −1 none). */
  setHome(home: GroundXZ, homeIdx = -1): void {
    this.home = { x: home.x, z: home.z };
    this.homeIdx = homeIdx;
  }

  /** The alive opponent it is most aware of (ties: the lower id), or null. (Moved here from ApeMind by P20.) */
  huntTarget(w: World): Fighter | null {
    let best: Fighter | null = null;
    let most = 0;
    for (const f of w.combat.fighters) {
      if (f === this.self || f.team === this.self.team || !f.alive) continue;
      const a = this.senses.of(f.id);
      if (a > most) {
        most = a;
        best = f;
      }
    }
    return best;
  }

  /**
   * Phase 2: sight (Δt = `dt`: DT near the player, aiFarPeriodTicks × DT far away), then the script's path or the
   * decision, then the path's upkeep (tile versions every repathCheckTicks near the player, every sensed tick far away;
   * the stuck window). A paused mind only senses.
   */
  sense(w: World, dt: number = DT): void {
    const self = this.self;
    this.senses.sight(w, self, dt);
    if (this.paused) return;
    if (this.current) this.planScript(w, this.current);
    else this.decide(w);
    const period = Math.max(1, Math.round(CREATURE_TUNING.shared.repathCheckTicks));
    this.path.upkeep(w, self, dt > DT || (w.tick + self.id) % period === 0);
  }

  /** The species' transitions and path requests (phase 2, sensed ticks only). */
  abstract decide(w: World): void;

  /** Phase 3 (CombatSim's brain site): moveInput and target, or drive and posture. */
  think(self: Fighter, _target: Fighter | null, wk: Walkable | null): void {
    self.idlePaused = this.paused;
    if (this.paused || !self.alive || bodyDown(self)) {
      this.halt(self);
      return;
    }
    if (this.current) {
      this.runScript(self, this.current);
      return;
    }
    this.act(self, wk);
  }

  /** The species' behaviour in its state (phase 3, body up, no script); stands by default. */
  protected act(self: Fighter, _wk: Walkable | null): void {
    this.halt(self);
  }

  /** A wound on this ruler (phase 17b, after the bus's roar). The giant's (P20); nothing by default. */
  onWound(_w: WoundRecord): void {}

  /** A hit or an impact on this creature (phase 17b; the bus has already raised its senses): remembered. */
  onHurt(_cause: ImpactCause | null, _attacker: Fighter | null, at: V3): void {
    this.hurt = { tick: this.world.tick, point: copy3(at) };
  }

  /**
   * Into `state` now: stateTick, `mark` reset, `resume` cleared, then the species' onEnter. (`down` is entered with
   * goDown and left with getUp, which keep the state's own stateTick and timers.)
   */
  enter(w: World, state: MindState): void {
    const from = this.state;
    this.state = state;
    this.stateTick = w.tick;
    this.resume = null;
    this.mark = -1;
    this.onEnter(w, state, from);
  }

  /** The species' entry actions (timers, paths, shouts). */
  protected onEnter(_w: World, _state: MindState, _from: MindState): void {}

  /** Into `down` (the body knocked down), remembering the state to resume. */
  protected goDown(): void {
    if (this.state === 'down') return;
    this.resume = this.state;
    this.state = 'down';
  }

  /** Out of `down`, back to the state it interrupted (its stateTick and timers as they were). */
  protected getUp(): void {
    this.state = this.resume ?? 'idle';
    this.resume = null;
  }

  // -------------------------------------------------------------------------
  // Scripts (§6.6)
  // -------------------------------------------------------------------------

  /** Phase 2 for a script: a navigated route keeps its path to the next point (a new one per point, routeScript). */
  protected planScript(w: World, s: MindScript): void {
    if (s.kind !== 'route' || !s.useNav) return;
    const p = s.points[this.routeIdx];
    if (p) this.path.goTo(w, this.self, this.ground(p));
  }

  /** Phase 3 for a script. */
  protected runScript(self: Fighter, s: MindScript): void {
    switch (s.kind) {
      case 'route':
        this.routeScript(self, s);
        return;
      case 'hold':
        this.stand(self);
        self.posture = s.posture ? { id: s.posture, weight: 1 } : null;
        return;
      case 'tug':
        this.tugScript(self, s);
        return;
      case 'charge':
        this.chargeScript(self, s);
        return;
    }
  }

  /**
   * Walk the points in order (straight lines, or the navmesh's path with useNav): a point is reached within the
   * species' arriveM, as a path corner is (§6.5), or, with useNav, at the end of a complete path to it (its goal snapped
   * onto the navmesh, as the species' own arrivals count it). Each point gets a path of its own: reaching one drops the
   * path, so the next phase 2 asks for the next point's however near it is (goTo alone would take two points within
   * repathMoveM for one goal and never ask). Gait `gait`, or the gait that walks at `speed`, or the patrol gait.
   */
  protected routeScript(self: Fighter, s: Extract<MindScript, { kind: 'route' }>): void {
    const crouch = s.crouch === true;
    self.posture = null;
    const arrive = this.path.layer === 'ruler' ? CREATURE_TUNING.giant.arriveM : CREATURE_TUNING.ape.arriveM;
    const from = this.routeIdx;
    while (this.routeIdx < s.points.length && flatDist(self.pos, s.points[this.routeIdx]) <= arrive) this.routeIdx++;
    if (s.useNav && this.routeIdx === from && this.routeIdx < s.points.length && this.path.done) this.routeIdx++;
    if (this.routeIdx !== from) this.path.clear();
    if (this.routeIdx >= s.points.length) {
      this.stand(self, crouch);
      return;
    }
    const gait = s.gait ?? (s.speed !== undefined ? this.gaitFor(self, s.speed, crouch) : CREATURE_TUNING.ape.gait.patrol);
    if (s.useNav) {
      this.steer(self, gait, crouch);
      return;
    }
    const p = s.points[this.routeIdx];
    this.walk(self, p.x - self.pos.x, p.z - self.pos.z, gait, crouch);
  }

  /**
   * The tug (§6.6, §5.12): walk crouched to the entity until its nearest point is within take reach, grip it (the drag
   * code at creature strength, VerbSystem.tug, from the next phase 4d), stooped (workLow), back off along dirYaw at
   * creatureHandSpeedMps for `ticks`, let go. routeIdx is the phase (0 approach, 1 hauling, 2 done), `mark` the grip's
   * tick. The KCC keeps the capsule crouched for the whole script (§4.2); a knockdown lets go and the haul re-grips.
   */
  protected tugScript(self: Fighter, s: Extract<MindScript, { kind: 'tug' }>): void {
    const w = this.world;
    const e = w.entities.get(s.entity);
    if (this.routeIdx < 2 && !e) {
      if (this.routeIdx === 1) w.verbs.tug(self, null);
      this.routeIdx = 2;
    }
    if (this.routeIdx === 0 && e) {
      // Its surface point nearest the chest (an entity without a collider: its position).
      const at = e.collider ? w.queries.projectPoint(s.entity, chestPoint(self)).point : e.pose.p;
      if (!inTakeReach(self, at)) {
        self.posture = null;
        this.walk(self, at.x - self.pos.x, at.z - self.pos.z, CREATURE_TUNING.ape.gait.investigate, true);
        return;
      }
      w.verbs.tug(self, s.entity);
      this.routeIdx = 1;
      this.mark = w.tick;
    }
    if (this.routeIdx === 1) {
      if (w.tick - this.mark < s.ticks) {
        if (w.verbs.workTarget(self) !== s.entity) w.verbs.tug(self, s.entity);
        self.posture = { id: 'workLow', weight: 1 };
        // P28 fix: it backs off along dirYaw facing what it hauls (before, it turned its back on it and walked away
        // forward, stooped head first); the face point lasts this tick (Fighter.faceAt).
        self.faceAt = { x: e!.pose.p.x, z: e!.pose.p.z };
        // P28: it backs off only as fast as the load comes (at most the hand speed): a load that holds is leaned on with
        // the arms drawn in (VerbSystem's tug), feet planted; before, it walked back at the hand speed regardless and
        // under the deadfall's log before the prop gave.
        const ux = Math.sin(s.dirYaw);
        const uz = Math.cos(s.dirYaw);
        const comes = e!.vel.lin.x * ux + e!.vel.lin.z * uz;
        const speed = Math.min(VERB_TUNING.creatureHandSpeedMps, Math.max(0, comes));
        this.walk(self, ux, uz, this.gaitFor(self, speed, true), true);
        return;
      }
      w.verbs.tug(self, null);
      this.routeIdx = 2;
    }
    self.posture = null;
    this.stand(self, true);
  }

  /** The giant's scripted charge (RulerMind, P20); a creature without one stands. */
  protected chargeScript(self: Fighter, _s: Extract<MindScript, { kind: 'charge' }>): void {
    this.halt(self);
  }

  /** A scripted route or tug has reached its end (the creature stands until the script is replaced). */
  get scriptDone(): boolean {
    const s = this.current;
    if (!s) return false;
    if (s.kind === 'route') return this.routeIdx >= s.points.length;
    if (s.kind === 'tug') return this.routeIdx >= 2;
    return false;
  }

  // -------------------------------------------------------------------------
  // Output helpers (the ape's moveInput; RulerMind overrides them with its drive)
  // -------------------------------------------------------------------------

  /** Walk along (dx, dz) at `gait` (moveInput, 0..1), crouched or not. */
  protected walk(self: Fighter, dx: number, dz: number, gait: number, crouch = false): void {
    const d = Math.hypot(dx, dz);
    if (d > 1e-9) self.moveInput.set((dx / d) * gait, 0, (dz / d) * gait);
    else self.moveInput.set(0, 0, 0);
    self.moveFlags = crouch ? MOVE_CROUCH : 0;
  }

  /** No input and no drive (the flags left as they are: a paused stance stays as it was). */
  protected halt(self: Fighter): void {
    self.moveInput.set(0, 0, 0);
    if (self.drive) {
      self.drive.speed = 0;
      self.drive.climb = false;
    }
  }

  /** Stand still, crouched or not. */
  protected stand(self: Fighter, crouch = false): void {
    this.halt(self);
    self.moveFlags = crouch ? MOVE_CROUCH : 0;
  }

  /** Follow the path at `gait`: true while there is a corner to steer at, else stands. */
  protected steer(self: Fighter, gait: number, crouch = false): boolean {
    const c = this.path.corner(self);
    if (!c) {
      this.stand(self, crouch);
      return false;
    }
    this.walk(self, c.x - self.pos.x, c.z - self.pos.z, gait, crouch);
    return true;
  }

  /** The move input that walks at `speed` m/s (walk speed × the live motion profile, × crouchSpeedMul crouched). */
  protected gaitFor(self: Fighter, speed: number, crouch: boolean): number {
    const k = self.stats.walkSpeed * Math.max(self.motion.speed, 1e-9) * (crouch ? MOVE_TUNING.crouchSpeedMul : 1);
    return Math.min(1, Math.max(0, speed / k));
  }

  /** (x, z) on the terrain. */
  protected ground(p: GroundXZ): V3 {
    return { x: p.x, y: this.world.terrain.heightAt(p.x, p.z), z: p.z };
  }

  // -------------------------------------------------------------------------
  // Save record (§6.8)
  // -------------------------------------------------------------------------

  toRecord(): MindRecV1 {
    const s = this.senses.toRecord();
    return {
      fighter: this.self.id,
      kind: this.kind,
      state: this.state,
      stateTick: this.stateTick,
      resume: this.resume,
      mark: this.mark,
      paused: this.paused,
      script: this.current ? copyMindScript(this.current) : null,
      awareness: s.awareness,
      lkp: s.lkp,
      lkpTick: s.lkpTick,
      lastSeenTick: s.lastSeenTick,
      stimulus: this.senses.stimulus,
      hurt: this.hurt ? { tick: this.hurt.tick, point: copy3(this.hurt.point) } : null,
      home: { x: this.home.x, z: this.home.z },
      homeIdx: this.homeIdx,
      routeIdx: this.routeIdx,
      restUntil: this.restUntil,
      cooldownUntil: this.cooldownUntil,
      fleeUntil: this.fleeUntil,
      heading: this.heading,
      charge: this.charge ? { heading: this.charge.heading, start: copy3(this.charge.start), travelled: this.charge.travelled, close: this.charge.close } : null,
      path: this.path.toRecord(),
      stuck: this.path.stuckRecord(),
      rng: this.rng.state,
      inner: this.innerRecord(),
    };
  }

  /** Puts back a toRecord() state (the loader's, by fighter id): every field, the senses, the path, the rng, the inner AI. */
  restoreRecord(r: MindRecV1): void {
    if (r.fighter !== this.self.id) throw new Error(`CreatureMind.restoreRecord: the record is fighter ${r.fighter}'s, this mind fighter ${this.self.id}'s`);
    if (r.kind !== this.kind) throw new Error(`CreatureMind.restoreRecord: fighter ${r.fighter}'s record is a ${r.kind}'s mind, this is a ${this.kind}'s`);
    this.state = r.state;
    this.stateTick = r.stateTick;
    this.resume = r.resume;
    this.mark = r.mark;
    this.paused = r.paused;
    this.current = r.script ? copyMindScript(r.script) : null;
    this.senses.restoreRecord(r);
    this.senses.stimulus = r.stimulus;
    this.hurt = r.hurt ? { tick: r.hurt.tick, point: copy3(r.hurt.point) } : null;
    this.home = { x: r.home.x, z: r.home.z };
    this.homeIdx = r.homeIdx;
    this.routeIdx = r.routeIdx;
    this.restUntil = r.restUntil;
    this.cooldownUntil = r.cooldownUntil;
    this.fleeUntil = r.fleeUntil;
    this.heading = r.heading;
    this.charge = r.charge ? { heading: r.charge.heading, start: copy3(r.charge.start), travelled: r.charge.travelled, close: r.charge.close } : null;
    this.path.restoreRecord(r.path, r.stuck);
    this.rng.state = r.rng;
    this.restoreInner(r.inner);
  }

  /** The inner BrawlerAI's record (apes), or null. */
  innerRecord(): BrawlerRecV1 | null {
    return null;
  }

  /** Puts back innerRecord(); a mind without an inner AI takes only null. */
  protected restoreInner(inner: BrawlerRecV1 | null): void {
    if (inner !== null) throw new Error(`CreatureMind.restoreRecord: fighter ${this.self.id}'s mind has no inner AI, and the record has one`);
  }
}

export class MindRegistry {
  readonly world: World;
  private readonly minds = new Map<Fighter, CreatureMind>();
  /**
   * The tick a creature's mind last started an attack (phase 3), and whose: a second creature doesn't start one on
   * the same tick (§6.3: apes take turns through the shared AIDirector, and its punish and counter paths, which skip
   * the director, wait one tick when another creature has just swung).
   */
  attackTick = -1;
  attacker = -1;

  constructor(world: World) {
    this.world = world;
  }

  add(f: Fighter, mind: CreatureMind): void {
    this.minds.set(f, mind);
  }

  remove(f: Fighter): void {
    this.minds.delete(f);
  }

  /**
   * Phase 2, fighter-id order: each mind within aiNearM of a player (or every mind, with no player) senses with Δt =
   * DT; one farther away when (tick + id) % aiFarPeriodTicks === 0, with Δt = aiFarPeriodTicks × DT (§6.1). Then up
   * to navQueriesPerTick waiting path requests are served, in (requestTick, fighter id) order (§6.5).
   */
  sense(w: World): void {
    const T = WORLD_TUNING;
    const players = [...w.players.values()];
    const period = Math.max(1, Math.round(T.aiFarPeriodTicks));
    for (const f of w.combat.fighters) {
      const m = this.minds.get(f);
      if (!m) continue;
      const near = players.length === 0 || players.some((p) => flatDist(p.pos, f.pos) <= T.aiNearM);
      if (near) m.sense(w, DT);
      else if ((w.tick + f.id) % period === 0) m.sense(w, period * DT);
    }
    const queue: CreatureMind[] = [];
    for (const f of w.combat.fighters) {
      const m = this.minds.get(f);
      if (m?.path.pending) queue.push(m);
    }
    queue.sort((a, b) => a.path.requestTick - b.path.requestTick || a.self.id - b.self.id);
    const n = Math.min(queue.length, Math.max(0, Math.floor(CREATURE_TUNING.shared.navQueriesPerTick)));
    for (let k = 0; k < n; k++) queue[k].path.serve(w, queue[k].self);
  }

  get(f: Fighter): CreatureMind | null {
    return this.minds.get(f) ?? null;
  }

  /** Every mind, in fighter order. */
  all(): CreatureMind[] {
    const out: CreatureMind[] = [];
    for (const f of this.world.combat.fighters) {
      const m = this.minds.get(f);
      if (m) out.push(m);
    }
    return out;
  }

  view(f: Fighter): MindView {
    const m = this.minds.get(f);
    if (!m) return { state: 'idle', awareness: 0, marker: '' };
    const s = m.state;
    const marker = s === 'investigate' ? '?' : s === 'chase' || s === 'fight' || s === 'telegraph' || s === 'charge' ? '!' : '';
    return { state: s, awareness: m.senses.level(), marker };
  }

  /** A creature's mind started an attack this tick (phase 3). */
  noteAttack(f: Fighter, tick: number): void {
    this.attackTick = tick;
    this.attacker = f.id;
  }

  /** Another creature's mind started an attack this tick. */
  attackTaken(f: Fighter, tick: number): boolean {
    return this.attackTick === tick && this.attacker !== f.id;
  }

  /** By fighter id. */
  toRecord(): MindRecV1[] {
    return [...this.minds.keys()].sort((a, b) => a.id - b.id).map((f) => this.minds.get(f)!.toRecord());
  }

  /** The loader's (save/load.ts): each record to the mind of the fighter it names (made by createCreature). */
  restoreRecord(r: readonly MindRecV1[]): void {
    for (const rec of r) {
      let mind: CreatureMind | undefined;
      for (const [f, m] of this.minds) if (f.id === rec.fighter) mind = m;
      if (!mind) throw new Error(`MindRegistry.restoreRecord: fighter ${rec.fighter} has no creature mind`);
      mind.restoreRecord(rec);
    }
  }
}
