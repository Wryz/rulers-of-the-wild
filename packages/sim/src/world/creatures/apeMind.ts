// The ape's mind (docs/M1-DESIGN.md §6.3): idle, patrol, investigate, chase, fight (an inner DungeonStyle BrawlerAI with
// the Bruiser plan), flee and return, on the human nav layer; `down` while its body is down, `dead` once it is out.
//
// The generic fields of CreatureMind mean, for the ape:
// - `restUntil`: idle → when idling ends (→ patrol; drawn from idleS on the first idle decision); return → when the
//   gloat ends (no walking before);
// - `cooldownUntil`: idle → when the next wander point is picked (idleWanderS);
// - `fleeUntil`: −1 while this fight (from leaving home to coming back to idle) hasn't rolled to flee; then the tick the
//   flee ends, or the tick of a roll that kept it fighting ("flee once per fight");
// - `mark`: investigate → when the look-around began (−1 while walking to lkp); fight → since when the target has been
//   beyond fightExitM (−1 within);
// - `heading`: the facing the look-around sways about (± lookAroundDeg);
// - `routeIdx`: the patrol loop's waypoint.
// Arrivals at a goal (lkp, home, a loop waypoint) count within investigateArriveM (§6.3 investigate's "on arrival
// (≤ 1.5 m)"; home and the loop's waypoints use it too), or when a complete path has been followed to its end.
// An ape made without a spawn-data home (a dev spawn, the sparring ape) has no patrol loop: it grazes around its home.
// Randomness: the mind's own stream (idle and wander times, wander points, the flee roll and time); the inner BrawlerAI
// keeps sharing CombatSim.rng exactly as DungeonStyle does (§6.1).
import type { BrawlerRecV1 } from '../../save/schema';
import { type AIConfig, BrawlerAI, DEFAULT_AI } from '../../sim/ai';
import { ARCHETYPES } from '../../sim/enemies';
import type { Fighter } from '../../sim/fighter';
import { DT } from '../../sim/math';
import type { Walkable } from '../collision';
import type { V3 } from '../types';
import type { World } from '../world';
import { CREATURE_TUNING } from './defs';
import { bodyDown, CreatureMind, type GroundXZ, type MindState } from './mind';

const DEG = Math.PI / 180;
const flatDist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

export class ApeMind extends CreatureMind {
  /**
   * The fight (§6.3): DungeonStyle's BrawlerAI unchanged, with `{ ...DEFAULT_AI, blockChance, aggression, stringChance }`
   * and Bruiser's plan (its shoulder charge included) at range planRange × scale, attackRange planAttackRange × scale;
   * it shares CombatSim's rng and this mind's director (CombatSim's AIDirector, so apes take turns); its drops stay
   * empty (apes don't seek weapons).
   */
  readonly inner: BrawlerAI;

  constructor(w: World, self: Fighter) {
    const A = CREATURE_TUNING.ape;
    const cfg: AIConfig = { ...DEFAULT_AI, blockChance: A.blockChance, aggression: A.aggression, stringChance: A.stringChance };
    super(w, self, cfg, 'human');
    const plan = ARCHETYPES[A.plan].plan;
    this.inner = new BrawlerAI(cfg, w.combat.rng, { ...plan, range: A.planRange * self.scale, attackRange: A.planAttackRange * self.scale }, null);
  }

  /** Straight into a fight with `target` (the sparring ape, §6.6): fully aware of it, as if it had just been seen. */
  engage(w: World, target: Fighter): void {
    this.senses.awareness.set(target.id, CREATURE_TUNING.shared.awarenessCap);
    this.senses.lkp = { x: target.pos.x, y: target.pos.y, z: target.pos.z };
    this.senses.lkpTick = w.tick;
    this.senses.lastSeenTick = w.tick;
    this.self.target = target;
    this.enter(w, 'fight');
  }

  /** The patrol loop: the spawn data's home loop (§6.7), or none for an ape made without one. */
  loop(w: World): readonly GroundXZ[] {
    return w.spawnData?.apeHomes[this.homeIdx]?.loop ?? [];
  }

  // -------------------------------------------------------------------------
  // Phase 2
  // -------------------------------------------------------------------------

  decide(w: World): void {
    const self = this.self;
    const A = CREATURE_TUNING.ape;
    const tick = w.tick;
    if (!self.alive) {
      if (this.state !== 'dead') this.enter(w, 'dead');
      return;
    }
    if (this.state === 'dead') this.enter(w, 'idle');
    if (bodyDown(self)) {
      this.goDown();
      return;
    }
    if (this.state === 'down') this.getUp();
    const target = this.huntTarget(w);
    const hunting = target !== null && this.senses.of(target.id) >= A.chaseAt && this.senses.seenWithin(tick);
    switch (this.state) {
      case 'idle': {
        if (hunting) return this.enter(w, 'chase');
        if (this.noticed()) return this.enter(w, 'investigate');
        if (this.restUntil < 0) this.restUntil = tick + this.ticksIn(A.idleS);
        if (tick >= this.restUntil) return this.enter(w, 'patrol');
        if (tick >= this.cooldownUntil) {
          const a = this.rng.range(0, 2 * Math.PI);
          const r = A.homeRadiusM * Math.sqrt(this.rng.next());
          this.path.clear();
          this.path.goTo(w, self, this.ground({ x: this.home.x + r * Math.sin(a), z: this.home.z + r * Math.cos(a) }));
          this.cooldownUntil = tick + this.ticksIn(A.idleWanderS);
        }
        return;
      }
      case 'patrol': {
        if (hunting) return this.enter(w, 'chase');
        if (this.noticed()) return this.enter(w, 'investigate');
        const loop = this.loop(w);
        while (this.routeIdx < loop.length) {
          const wp = this.ground(loop[this.routeIdx]);
          if (!(this.path.done || this.path.unreachable || flatDist(self.pos, wp) <= A.investigateArriveM)) {
            this.path.goTo(w, self, wp);
            return;
          }
          this.routeIdx++;
          this.path.clear();
        }
        return this.enter(w, 'idle');
      }
      case 'investigate': {
        if (hunting) return this.enter(w, 'chase');
        const lkp = this.senses.lkp;
        if (this.mark >= 0) {
          // Looking around; a new stimulus somewhere else sends it to see.
          const elsewhere = lkp !== null && this.senses.lkpTick > this.mark && flatDist(lkp, self.pos) > A.investigateArriveM;
          if (!elsewhere) {
            if (tick - this.mark >= Math.round(A.lookAroundS / DT)) this.enter(w, 'return');
            return;
          }
          this.mark = -1;
          this.path.clear();
        }
        if (!lkp || this.path.unreachable) return this.enter(w, 'return');
        const goal = this.path.goal;
        // (The path's goal is lkp's when it was asked for: within repathMoveM of it, or the follower would have asked again.)
        const arrived = flatDist(lkp, self.pos) <= A.investigateArriveM || (this.path.done && goal !== null && flatDist(goal, lkp) <= A.repathMoveM);
        if (arrived) {
          this.mark = tick;
          this.heading = self.yaw;
          this.path.clear();
          return;
        }
        this.path.goTo(w, self, lkp);
        return;
      }
      case 'chase': {
        if (!target) return this.enter(w, 'return');
        self.target = target;
        const seen = this.senses.seenWithin(tick);
        if (seen && self.distanceTo(target) <= A.fightEnterM) return this.enter(w, 'fight');
        if (!this.senses.seenWithin(tick, A.chaseMemoryS)) return this.enter(w, 'investigate');
        if (this.path.unreachable) return this.enter(w, 'return');
        // Seen: where it is; unseen: where it was last known to be (lkp; a mind doesn't cheat).
        const goal: V3 = seen || !this.senses.lkp ? target.pos : this.senses.lkp;
        this.path.goTo(w, self, goal, A.repathTicks);
        return;
      }
      case 'fight': {
        const t = self.target;
        if (!t || !t.alive) {
          if (!t) return this.enter(w, 'return');
          if (!self.free) return; // the swing it's in first
          const gloat = Math.round(A.gloatS / DT);
          self.celebrate(gloat);
          this.enter(w, 'return');
          this.restUntil = tick + gloat;
          return;
        }
        if (self.distanceTo(t) > A.fightExitM) {
          if (this.mark < 0) this.mark = tick;
          else if (tick - this.mark >= A.fightExitTicks) return this.enter(w, 'chase');
        } else this.mark = -1;
        if (this.fleeUntil === -1 && self.hp <= A.fleeHpFrac * self.stats.maxHp) {
          if (this.rng.chance(A.fleeChance)) return this.enter(w, 'flee');
          this.fleeUntil = tick;
        }
        return;
      }
      case 'flee': {
        if (tick >= this.fleeUntil || this.path.unreachable) {
          // Awareness halved (§6.3: × fleeAwarenessMul).
          for (const [id, a] of this.senses.awareness) this.senses.awareness.set(id, a * A.fleeAwarenessMul);
          return this.enter(w, 'return');
        }
        if (this.path.goal) this.path.goTo(w, self, this.path.goal);
        return;
      }
      case 'return': {
        if (hunting) return this.enter(w, 'chase');
        if (tick < this.restUntil) return; // gloating
        const home = this.ground(this.home);
        if (flatDist(self.pos, home) <= A.investigateArriveM || this.path.done || this.path.unreachable) return this.enter(w, 'idle');
        this.path.goTo(w, self, home);
        return;
      }
      default:
        // Not an ape's state (rest, telegraph, charge, recover): it settles down.
        this.enter(w, 'idle');
        return;
    }
  }

  /** A stimulus since this state began has raised its awareness to investigateAt (§6.2 Thresholds). */
  private noticed(): boolean {
    const s = this.senses;
    return s.lkp !== null && s.lkpTick >= this.stateTick && s.level() >= CREATURE_TUNING.ape.investigateAt;
  }

  /** Ticks in a [min, max] seconds range, drawn from the mind's stream. */
  private ticksIn(range: readonly number[]): number {
    return Math.round(this.rng.range(range[0], range[1]) / DT);
  }

  protected onEnter(w: World, state: MindState, _from: MindState): void {
    const self = this.self;
    this.path.clear();
    switch (state) {
      case 'idle':
        self.target = null;
        this.restUntil = -1;
        this.cooldownUntil = -1;
        this.fleeUntil = -1;
        return;
      case 'patrol':
        self.target = null;
        this.routeIdx = 0;
        return;
      case 'investigate':
      case 'return':
        self.target = null;
        this.restUntil = -1;
        return;
      case 'chase':
        self.target = this.huntTarget(w);
        return;
      case 'fight':
        self.target ??= this.huntTarget(w);
        w.noise.shout(self);
        return;
      case 'flee': {
        const from = self.target?.pos ?? this.senses.lkp ?? self.pos;
        self.target = null;
        this.fleeUntil = w.tick + this.ticksIn(CREATURE_TUNING.ape.fleeS);
        this.path.goTo(w, self, this.fleePoint(from));
        return;
      }
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

  /** fleeDistM from `from` (the player) toward home (away from the player when home is where it stands). */
  private fleePoint(from: V3): V3 {
    const self = this.self;
    let dx = this.home.x - from.x;
    let dz = this.home.z - from.z;
    let d = Math.hypot(dx, dz);
    if (d < 1e-9) {
      dx = self.pos.x - from.x;
      dz = self.pos.z - from.z;
      d = Math.hypot(dx, dz);
    }
    if (d < 1e-9) {
      dx = -Math.sin(self.yaw);
      dz = -Math.cos(self.yaw);
      d = 1;
    }
    const k = CREATURE_TUNING.ape.fleeDistM / d;
    return this.ground({ x: from.x + dx * k, z: from.z + dz * k });
  }

  // -------------------------------------------------------------------------
  // Phase 3
  // -------------------------------------------------------------------------

  protected act(self: Fighter, wk: Walkable | null): void {
    const g = CREATURE_TUNING.ape.gait;
    self.posture = null; // (the look-around sets sniff below; a fight has none)
    switch (this.state) {
      case 'idle':
        this.steer(self, g.wander);
        return;
      case 'patrol':
        this.steer(self, g.patrol);
        return;
      case 'investigate':
        if (this.mark >= 0) this.lookAround(self);
        else this.steer(self, g.investigate);
        return;
      case 'chase':
        this.steer(self, g.chase);
        return;
      case 'fight':
        this.fight(self, wk);
        return;
      case 'flee':
        this.steer(self, g.flee);
        return;
      case 'return':
        if (this.world.tick < this.restUntil) this.stand(self);
        else this.steer(self, g.return);
        return;
      default:
        this.stand(self);
        return;
    }
  }

  /**
   * BrawlerAI as DungeonStyle runs it (spacing, tempers, specials, the director's turns), through NavWalkable's local
   * steering. When another creature started an attack this tick (a punish or counter skips the director), this one
   * waits a tick: two apes never start attacks on the same frame.
   */
  private fight(self: Fighter, wk: Walkable | null): void {
    const w = this.world;
    self.moveFlags = 0;
    if (w.minds.attackTaken(self, w.tick)) return;
    this.inner.director = this.director;
    this.inner.think(self, self.target, wk);
    if (self.state === 'attack' && self.sinceMoveStart === 0) w.minds.noteAttack(self, w.tick);
  }

  /** Standing at lkp: posture sniff, the head and body swaying ± lookAroundDeg about `heading` over lookAroundS. */
  private lookAround(self: Fighter): void {
    const A = CREATURE_TUNING.ape;
    this.stand(self);
    self.posture = { id: 'sniff', weight: 1 };
    const t = (this.world.tick - this.mark) * DT;
    self.yaw = this.heading + A.lookAroundDeg * DEG * Math.sin((2 * Math.PI * t) / Math.max(A.lookAroundS, DT));
  }

  // -------------------------------------------------------------------------
  // Save record
  // -------------------------------------------------------------------------

  innerRecord(): BrawlerRecV1 | null {
    return this.inner.toRecord();
  }

  protected restoreInner(inner: BrawlerRecV1 | null): void {
    if (!inner) throw new Error(`ApeMind.restoreRecord: fighter ${this.self.id}'s record has no inner BrawlerAI`);
    this.inner.restoreRecord(inner);
  }
}
