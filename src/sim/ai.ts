import { Vector3 } from 'three';
import type { Walkable } from '../world/collision';
import type { Drop } from './combat';
import type { Fighter } from './fighter';
import type { Rng } from './math';
import { ENEMY_MIN_STARTUP } from './fighter';
import { heft, type WeaponId, weaponPlan } from './weapons';

export interface AIConfig {
  /** Scales attack frequency. 1 = baseline. */
  aggression: number;
  /** Chance to block a player attack when free. */
  blockChance: number;
  /** Chance to follow a straight with a haymaker. */
  stringChance: number;
  /** Training dummy: never attacks or blocks. */
  passive: boolean;
}

export const DEFAULT_AI: AIConfig = { aggression: 1, blockChance: 0.3, stringChance: 0.35, passive: false };

/**
 * A fighter's own technique, saved for the moment it's made for: a distance band (m,
 * scaled with the fighter's size, measured to the target's surface), a situation, and
 * how keen they are on it.
 */
export interface Special {
  move: string;
  min: number;
  max: number;
  /** Chance per frame while it's on (× aggression). */
  rate: number;
  /** Frames before trying it again. */
  cooldown: number;
  /**
   * 'crowded' — too close; 'afterHit' — just took one; 'targetAttacking' — something's
   * on its way in; 'targetWhiffed' — they're stuck recovering from a miss;
   * 'targetEntered' — they just stepped into reach; 'armed'/'unarmed'; 'hasAmmo'.
   */
  when?: 'crowded' | 'afterHit' | 'targetAttacking' | 'targetWhiffed' | 'targetEntered' | 'armed' | 'unarmed' | 'hasAmmo';
  /** Only with one of these in hand. */
  weapons?: WeaponId[];
}

/**
 * How a fighter carries a fight: 'pressure' walks you down; 'patient' waits just out of
 * reach for you to commit, then answers; 'skirmish' darts in and straight back out;
 * 'berserk' keeps coming, angrier the more it's hurt, and fights its way out of a crowd;
 * 'sloppy' backs off flinching after every hit it takes.
 */
export type Temper = 'pressure' | 'patient' | 'skirmish' | 'berserk' | 'sloppy';

/** What an enemy archetype throws and how it manages distance. */
export interface AIPlan {
  /** Attack ids with selection weights. */
  moves: [string, number][];
  /** Preferred fighting distance (m). */
  range: number;
  /** Starts attacks when closer than this (m). */
  attackRange: number;
  /** Closer than this a weapon's striking part can't land (armed plans only). */
  crowded?: number;
  /** Quick attack used to punish a whiffed / blocked player move. */
  punish: string;
  /** Follow-ups: after `from`, cancel into `next` (chance scaled by stringChance). */
  chains: Record<string, string>;
  temper?: Temper;
  specials?: Special[];
  /** What it counters with when there's no time for anything slower (default: a jab). */
  counters?: string[];
  /** How this fighter uses particular weapons (first match wins; no `weapons` = any). */
  armed?: { weapons?: WeaponId[]; moves: [string, number][]; punish?: string }[];
}

export const BRAWLER_PLAN: AIPlan = {
  moves: [
    ['straight', 30],
    ['hook', 25],
    ['body', 25],
    ['sweep', 18],
  ],
  range: 1.05,
  attackRange: 1.25,
  punish: 'straight',
  chains: { straight: 'hookChain' },
};

/**
 * Shared between enemies: only one may start an attack within a short window, so a
 * group takes turns instead of swinging all at once (fair, and readable).
 */
export class AIDirector {
  frame = 0;
  private lastAttack = -999;
  gap = 38;

  canAttack() {
    return this.frame - this.lastAttack >= this.gap;
  }

  claim() {
    this.lastAttack = this.frame;
  }
}

/** A strike of theirs still on its way in (wind-up or active), not yet spent. */
function incoming(t: Fighter): boolean {
  return t.state === 'attack' && !!t.move && !t.move.noHit && t.stateFrame <= t.move.startup + t.move.active;
}

/**
 * A big committed swing coming that walks through anything light: armoured when a strike
 * thrown now would land, or a heavy weapon wound up for a heavy blow. You don't jab into
 * an axe on its way down.
 */
function wadingIn(t: Fighter, landsIn: number): boolean {
  if (!incoming(t)) return false;
  const m = t.move!;
  const at = t.stateFrame + landsIn;
  if (m.armor && at >= m.armor[0] && at < m.armor[1]) return true;
  return !!m.weapon && m.weight === 'heavy' && !!t.weapon && t.weapon.mass >= 1.5;
}

/** How long (frames) a patient fighter waits for you to come to them before going to you. */
const PATIENCE = 150;

/** The heaviest a weapon can be (for its body) and still be worth fighting with. */
export const MAX_HEFT = 4.6;

/** Simple brawler: keeps punching range, throws telegraphed attacks, sometimes blocks. */
const _probe = new Vector3();

export class BrawlerAI {
  private cooldown = 40;
  private strafe = 0;
  private strafeTimer = 0;
  /** Going round something: which way (+1 left / -1 right), and for how much longer. */
  private detourSide: 1 | -1 = 1;
  private detourFrames = 0;
  private walkable: Walkable | null = null;
  private chain: string | null = null;
  private decidedSerial = -1;
  private willBlock = false;
  private punishDelay = -1;
  /** Weapons on the floor (shared with the sim). */
  drops: Drop[] = [];
  private armed: { key: string; plan: AIPlan } | null = null;
  /** Frames spent too close for the weapon, and how long backing out has got nowhere. */
  private crowdedFor = 0;
  /** Which way to circle off when backing up toward a wall, and for how long. */
  private circleSide: 1 | -1 = 1;
  private circleFrames = 0;
  /** Out of breath: backing off until it comes back. */
  private winded = false;
  /** Frames until each special can be tried again. */
  private readonly specialCool: Record<string, number> = {};
  private sinceOwnAttack = 999;
  /** Frames a patient fighter has been waiting with nothing thrown either way. */
  private waited = 0;
  private retreatFor = 0;
  private prevDist = Infinity;
  private pinned = 0;
  private readonly lastPos = new Vector3();

  constructor(
    public cfg: AIConfig,
    private readonly rng: Rng,
    public plan: AIPlan = BRAWLER_PLAN,
    public director: AIDirector | null = null,
  ) {}

  think(self: Fighter, target: Fighter | null, walkable: Walkable | null = null) {
    this.walkable = walkable;
    self.moveInput.set(0, 0, 0);
    if (!self.alive) return;
    if (!target || !target.alive || this.cfg.passive) return;

    const raw = self.distanceTo(target);
    // Ranges are for someone your own size; a bigger body's surface is further out from
    // its centre (and a giant can't be stood as close to), a smaller one's nearer.
    const dist = raw - Math.max(-0.15, (target.scale - 1) * 0.5);
    const plan = this.planFor(self);
    const temper = plan.temper ?? 'pressure';
    this.sinceOwnAttack = self.state === 'attack' ? 0 : this.sinceOwnAttack + 1;
    for (const k in this.specialCool) this.specialCool[k]--;
    const entered = dist < plan.attackRange && this.prevDist >= plan.attackRange;
    this.prevDist = dist;

    // Attack strings: cancel straight -> haymaker.
    if (self.state === 'attack' && this.chain && self.inCancelWindow()) {
      const next = self.moveDef(this.chain);
      this.chain = null;
      if (next && self.canUse(next) && dist < plan.attackRange + 0.35 * self.scale) self.startMove(next);
      return;
    }

    // Decide once per player attack whether to block it.
    if (target.state === 'attack' && target.attackSerial !== this.decidedSerial) {
      this.decidedSerial = target.attackSerial;
      this.willBlock = this.rng.chance(this.cfg.blockChance * (self.framesSinceHit < 40 ? 1.6 : 1));
    }
    // (A fighter with reactions of its own reads strikes itself; see autoDefend.)
    if (
      !self.autoDefense &&
      this.willBlock &&
      self.free &&
      target.state === 'attack' &&
      target.move &&
      target.framesToActive <= 4 &&
      target.framesToActive >= 0 &&
      raw <= target.move.reach + 0.4 &&
      // Only what a guard can stop, with arms to stop it.
      target.move.blockable &&
      (target.strikeHeight === 'high' || target.strikeHeight === 'mid') &&
      !(self.isSevered('foreArmL') && self.isSevered('foreArmR'))
    ) {
      self.startDefense('block', target.id * 100000 + target.attackSerial);
      this.willBlock = false;
      this.punishDelay = 0;
      return;
    }
    // Got out of the way of one (or took it on the guard): straight back with a counter
    // while they're still recovering.
    const d = self.defense;
    const canCounter = self.free || (self.state === 'defend' && !!d && (d.success || d.phase === 'recovery'));
    if (self.counter && canCounter && dist < plan.attackRange + 0.3 * self.scale) {
      // The quickest thing it has: a counter has to land before they've recovered.
      const m = this.quickest(self, plan);
      if (m) {
        self.startMove(m, true);
        this.director?.claim();
        this.cooldown = this.rng.range(40, 80);
        return;
      }
    }
    if (!self.free) return;

    // Their own techniques, when the moment is right for one.
    if (this.trySpecial(self, target, plan, dist, entered)) return;

    // Unarmed with a weapon lying nearby: go and grab it (unless already toe to toe).
    if (this.seekWeapon(self, raw, target)) return;

    // Punish a whiffed / blocked player move.
    if (this.punishDelay >= 0) {
      this.punishDelay++;
      if (this.punishDelay > 2) {
        this.punishDelay = -1;
        if (dist < plan.attackRange + 0.1 && this.rng.chance(0.85)) {
          this.start(self, plan.punish);
          return;
        }
      }
    }

    // Spacing.
    const dx = target.pos.x - self.pos.x;
    const dz = target.pos.z - self.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    const downed = target.state === 'knockdown' || target.state === 'getup';
    // Gassed: give ground and get the breath back before going again.
    if (self.stamina < 0.2) this.winded = true;
    else if (self.stamina > 0.45) this.winded = false;
    let want = downed ? 1.7 : plan.range + (this.winded ? 0.7 * self.scale : 0);
    if (!downed) {
      // Waiting just outside reach for them to commit.
      // (But not for ever: against someone who won't come to them, they lose patience
      // after a couple of seconds and take it to them.)
      if (self.state === 'attack' || target.state === 'attack') this.waited = 0;
      else this.waited++;
      if (temper === 'patient' && this.waited < PATIENCE && !(target.state === 'attack' && target.stateFrame > (target.move?.startup ?? 0))) want = Math.max(want, plan.attackRange + 0.15 * self.scale);
      // In and straight back out again.
      // (Further, with knives left to throw.) Out until there, or until they've closed in
      // on you anyway.
      if (temper === 'skirmish') {
        const out = plan.range + (self.ammo && self.ammo.count > 0 ? 2.2 : 1.3) * self.scale;
        if (this.sinceOwnAttack === 1) this.retreatFor = 110;
        if (this.retreatFor > 0) {
          this.retreatFor = dist >= out - 0.2 ? 0 : this.retreatFor - 1;
          want = out;
        }
      }
      // Rattled: backing off from the one that just landed.
      if (temper === 'sloppy' && self.framesSinceHit < 45) want = plan.range + 0.9 * self.scale;
    }
    let mx = 0;
    let mz = 0;
    if (dist > want + 0.1) {
      mx += fx;
      mz += fz;
    } else if (dist < want - 0.25) {
      this.giveGround(self, fx, fz, this.retreatFor > 0 ? 1 : 0.8);
      mx = self.moveInput.x;
      mz = self.moveInput.z;
    }
    // Circling: in range, a fighter doesn't stand in front of you — it works round you,
    // changing direction, the better ones more; and it steps off the line of someone
    // throwing the same thing again and again.
    const close = dist < plan.attackRange + 0.8 * self.scale;
    const spamming = target.repeatCount >= 2 && target.state === 'attack';
    if (--this.strafeTimer <= 0 || (spamming && this.strafe === 0)) {
      const still = close ? 1 : 3;
      this.strafe = this.rng.pickWeighted<number>([
        [0, spamming ? 0 : still],
        [1, 1 + self.readSkill],
        [-1, 1 + self.readSkill],
      ]);
      this.strafeTimer = Math.floor(this.rng.range(30, 80));
    }
    const circle = close ? 0.4 + 0.35 * self.readSkill : 0.35;
    mx += -fz * this.strafe * circle;
    mz += fx * this.strafe * circle;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    // (Getting out to range, a skirmisher goes at full speed rather than easing back.)
    self.moveInput.set(mx, 0, mz).multiplyScalar(this.retreatFor > 0 ? 1 : 0.75);
    this.steer(self);

    if (downed) return;

    // Punish a player stuck in recovery.
    if (target.state === 'attack' && target.move && target.stateFrame > target.move.startup + target.move.active + 2) {
      if (dist < plan.attackRange + 0.05 && this.rng.chance(0.12 * this.cfg.aggression)) {
        this.start(self, plan.punish);
        return;
      }
    }

    // Tired fighters throw less; a patient one hardly throws first at all, and a berserker
    // gets wilder the more it's hurt.
    const keen = temper === 'patient' ? 0.5 : temper === 'berserk' ? 1 + Math.max(0, 0.6 - self.hp / self.stats.maxHp) : 1;
    this.cooldown -= this.cfg.aggression * keen * (0.45 + 0.55 * self.stamina);
    // With a weapon, crowded is bad: only the haft can land. Make room first — back out
    // to where the head reaches (going round whatever's behind), or push them off with a
    // teep. Pinned there (a wall, a corner, someone who keeps following), stop backing
    // and fight from where you are: a shove, or a short swing that lands with the haft.
    const crowded = !!self.weapon && dist < (plan.crowded ?? 0);
    this.crowdedFor = crowded ? this.crowdedFor + 1 : 0;
    if (crowded) {
      const moved = Math.hypot(self.pos.x - this.lastPos.x, self.pos.z - this.lastPos.z);
      this.pinned = moved < 0.004 * self.scale ? this.pinned + 1 : Math.max(0, this.pinned - 2);
      this.lastPos.copy(self.pos);
      const cornered = this.pinned > 12 || this.crowdedFor > 75;
      if (!cornered) {
        this.giveGround(self, fx, fz, 0.85);
        this.steer(self);
      }
      if (this.cooldown > 0 || (this.director && !this.director.canAttack())) return;
      if (this.winded && !cornered) return;
      const teep = self.moves.teep;
      const canTeep = !!teep && self.canUse(teep);
      // (A berserker shoves its way out far sooner than it backs off.)
      const shove = (cornered ? 0.08 : 0.02) * (temper === 'berserk' ? 2.5 : 1);
      if (this.rng.chance(shove * this.cfg.aggression)) {
        if (canTeep && (!cornered || this.rng.chance(0.5))) {
          self.startMove(teep);
          this.director?.claim();
          this.cooldown = this.rng.range(50, 90);
        } else if (cornered) {
          this.start(self, plan.punish);
        }
      }
      return;
    }
    this.pinned = 0;
    this.lastPos.copy(self.pos);
    // Getting out, not trading. And not winding up into a strike already on its way in:
    // cover up, take it on the guard, and answer when it's spent.
    if (this.winded || this.retreatFor > 0) return;
    if (incoming(target)) {
      // ...unless there's a gap: a quick shot that lands before theirs does.
      const q = this.quickest(self, plan);
      const startup = q ? Math.max(self.team === 'enemy' ? ENEMY_MIN_STARTUP : 0, q.startup * Math.sqrt(self.scale)) : Infinity;
      if (q && startup < target.framesToActive - 1 && !wadingIn(target, Math.ceil(startup)) && dist < plan.attackRange && this.rng.chance(0.6 * this.cfg.aggression)) {
        self.startMove(q);
        this.director?.claim();
        this.cooldown = this.rng.range(30, 60);
      }
      return;
    }
    if (this.cooldown <= 0 && dist < plan.attackRange && (!this.director || this.director.canAttack())) {
      this.start(self, this.rng.pickWeighted<string>(this.choices(self, target, plan, dist)));
    }
  }

  /** The fastest strike this fighter can throw right now (for countering). */
  private quickest(self: Fighter, plan: AIPlan) {
    let best: import('./moves').MoveDef | null = null;
    // Armed, it answers with the weapon (which outreaches a fist anyway).
    const armed = !!self.weapon;
    for (const id of [plan.punish, ...plan.moves.map(([m]) => m), ...(this.plan.counters ?? ['rookieJab']), 'teep', 'kLowKick']) {
      const m = self.moveDef(id);
      if (!m || m.noHit || m.air || m.throw || m.spin || !self.canUse(m) || !self.canReach(m)) continue;
      if (best && armed && best.weapon && !m.weapon) continue;
      if (!best || (armed && m.weapon && !best.weapon) || m.startup < best.startup) best = m;
    }
    return best;
  }

  private trySpecial(self: Fighter, target: Fighter, plan: AIPlan, dist: number, entered: boolean): boolean {
    if (!plan.specials || this.winded) return false;
    if (target.state === 'knockdown' || target.state === 'getup' || target.state === 'ko') return false;
    for (const sp of plan.specials) {
      if ((this.specialCool[sp.move] ?? 0) > 0) continue;
      if (dist < sp.min * self.scale || dist > sp.max * self.scale) continue;
      if (sp.weapons && (!self.weapon || !sp.weapons.includes(self.weapon.id))) continue;
      const m = self.moveDef(sp.move);
      if (!m || !self.canUse(m) || !self.canReach(m)) continue;
      if (m.throw && (m.throw.ammo ? !self.ammo || self.ammo.count <= 0 : !self.weapon)) continue;
      const tm = target.state === 'attack' ? target.move : null;
      switch (sp.when) {
        case 'crowded':
          if (dist > Math.max(plan.crowded ?? 0, 0.85 * self.scale)) continue;
          break;
        case 'afterHit':
          if (self.framesSinceHit > 30) continue;
          break;
        case 'targetAttacking':
          if (!tm || tm.noHit || target.framesToActive < 3 || target.framesToActive > 14) continue;
          break;
        case 'targetWhiffed':
          if (!tm || target.stateFrame <= tm.startup + tm.active) continue;
          break;
        case 'targetEntered':
          if (!entered) continue;
          break;
        case 'armed':
          if (!self.weapon) continue;
          break;
        case 'unarmed':
          if (self.weapon) continue;
          break;
        case 'hasAmmo':
          if (!self.ammo || self.ammo.count <= 0) continue;
          break;
      }
      // Evasions and counters go when they're needed; anything else waits its turn.
      // (Throwing from range isn't crowding in on anyone's turn.)
      if (!(sp.when === 'targetAttacking' || sp.when === 'afterHit') && incoming(target) && !m.armor) continue;
      // (Nor does a counter go into an armoured or heavy-weapon swing: it gets walked through.)
      if (wadingIn(target, m.startup) && m.weight !== 'heavy' && !m.air && !m.throw) continue;
      const urgent = sp.when === 'targetAttacking' || sp.when === 'afterHit' || sp.when === 'targetWhiffed' || sp.when === 'targetEntered' || !!m.throw;
      if (!urgent && this.director && !this.director.canAttack()) continue;
      if (!this.rng.chance(sp.rate * this.cfg.aggression)) continue;
      this.specialCool[sp.move] = sp.cooldown;
      this.start(self, sp.move);
      return true;
    }
    return false;
  }

  /** What's worth throwing from here, at this target. */
  private choices(self: Fighter, target: Fighter, plan: AIPlan, dist: number): [string, number][] {
    const ok = (id: string) => {
      const d = self.moveDef(id);
      if (!d) return false;
      // A leg sweep needs room to swing the leg through: not from chest to chest.
      if (d.kind === 'sweep' && !d.weapon && dist < 0.95 * self.scale) return false;
      // Only what can get to the part it's aimed at (a giant's head is out of reach).
      return self.canReach(d);
    };
    // Mix it up: the same strike again straight away is the one they'll see coming.
    const out = plan.moves.filter(([id]) => ok(id)).map(([id, w]): [string, number] => [id, id === self.lastMoveId ? w * 0.25 : w]);
    // Against something much bigger, go for the legs.
    if (target.scale > self.scale * 1.5) for (const k of ['kLowKick', 'lowKick']) if (ok(k) && !out.some(([id]) => id === k)) out.push([k, 30]);
    return out.length ? out : plan.moves;
  }

  /** The base plan, or how this fighter uses the weapon in its hands. */
  private planFor(self: Fighter): AIPlan {
    if (!self.weapon) return this.plan;
    const key = `${self.weapon.id}:${self.scale}`;
    if (this.armed?.key !== key) {
      const p = weaponPlan(self.weapon);
      // This fighter's own way with this kind of weapon (a samurai with a katana...).
      const id = self.weapon.id;
      const own = this.plan.armed?.find((a) => !a.weapons || a.weapons.includes(id));
      const moves = own?.moves.filter(([m]) => !!self.moveDef(m)) ?? [];
      this.armed = {
        key,
        plan: {
          ...p,
          moves: moves.length ? moves : p.moves,
          punish: own?.punish ?? p.punish,
          range: p.range * self.scale,
          attackRange: p.attackRange * self.scale,
          crowded: (p.crowded ?? 0) * self.scale,
          temper: this.plan.temper,
          specials: this.plan.specials,
        },
      };
    }
    return this.armed.plan;
  }

  private seekWeapon(self: Fighter, dist: number, target: Fighter): boolean {
    if (self.weapon || !this.drops.length || self.isSevered('foreArmR')) return false;
    let best: Drop | null = null;
    let bd = 4.5 * self.scale;
    for (const d of this.drops) {
      if (d.weapon.style === 'twoHand' && self.isSevered('foreArmL')) continue;
      // Too much for this body to fight with (a sledgehammer for an imp).
      if (heft(d.weapon, self.scale) > MAX_HEFT) continue;
      const dd = Math.hypot(d.pos.x - self.pos.x, d.pos.z - self.pos.z);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    if (!best || (dist < 1.3 * self.scale && bd > 0.8 * self.scale)) return false;
    if (bd < 0.7 * self.scale) {
      // Bending down takes a while: only with the foe out of reach, down, or busy.
      const busy = target.state === 'knockdown' || target.state === 'getup' || target.state === 'ko' || (target.state === 'attack' && !!target.move && target.stateFrame > target.move.startup + target.move.active);
      if (dist < 2 * Math.max(1, target.scale) && !busy) return false;
      self.pickupRequest = 6;
      return true;
    }
    const dx = best.pos.x - self.pos.x;
    const dz = best.pos.z - self.pos.z;
    self.moveInput.set(dx / bd, 0, dz / bd);
    this.steer(self);
    return true;
  }

  /**
   * Walk round props rather than into them: look a stride ahead along where we want to
   * go; if a crate, car or shelf is there, fan out to one side until the way is clear,
   * and keep to that side until we're past it (no dithering at the corner).
   */
  /**
   * Back away from someone (facing them along fx, fz) — straight back while there's room
   * behind, circling off to the more open side as a wall or a corner comes up behind,
   * rather than backing into it and getting pinned there.
   */
  private giveGround(self: Fighter, fx: number, fz: number, speed: number) {
    const behind = this.room(self, -fx, -fz);
    if (behind >= 3) {
      self.moveInput.set(-fx * speed, 0, -fz * speed);
      return;
    }
    if (this.circleFrames-- <= 0) {
      this.circleSide = this.room(self, -fz, fx) >= this.room(self, fz, -fx) ? 1 : -1;
      this.circleFrames = 50;
    }
    const s = this.circleSide;
    const back = behind / 3;
    const x = -fx * back * 0.6 - fz * s;
    const z = -fz * back * 0.6 + fx * s;
    const l = Math.hypot(x, z) || 1;
    self.moveInput.set((x / l) * speed, 0, (z / l) * speed);
  }

  /** Open floor in a direction: how many of three probes out to ~2 m are clear (0-3). */
  private room(self: Fighter, x: number, z: number): number {
    const w = this.walkable;
    if (!w) return 3;
    let n = 0;
    for (const d of [0.7, 1.4, 2.1]) {
      const px = self.pos.x + x * d * self.scale;
      const pz = self.pos.z + z * d * self.scale;
      _probe.set(px, 0.3, pz);
      if (!w.isWalkable(px, pz) || w.solidAt?.(_probe, 0.3 * self.scale)) break;
      n++;
    }
    return n;
  }

  private steer(self: Fighter) {
    const w = this.walkable;
    const mi = self.moveInput;
    const mag = Math.hypot(mi.x, mi.z);
    if (!w || mag < 0.05) return;
    const ux = mi.x / mag;
    const uz = mi.z / mag;
    const clear = (x: number, z: number) => {
      for (const d of [0.45, 0.9]) {
        const px = self.pos.x + x * d * self.scale;
        const pz = self.pos.z + z * d * self.scale;
        if (!w.isWalkable(px, pz)) return false;
        _probe.set(px, 0.3, pz);
        if (w.solidAt?.(_probe, 0.3 * self.scale)) return false;
      }
      return true;
    };
    if (this.detourFrames > 0) this.detourFrames--;
    if (clear(ux, uz)) return;
    for (const side of [this.detourSide, -this.detourSide] as (1 | -1)[]) {
      for (const deg of [30, 55, 80, 105, 130]) {
        const a = (deg * Math.PI) / 180 * side;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const x = ux * c - uz * sn;
        const z = ux * sn + uz * c;
        if (clear(x, z)) {
          this.detourSide = side;
          this.detourFrames = 45;
          mi.set(x * mag, 0, z * mag);
          return;
        }
      }
      // Committed to a side: only try the other one once the commitment runs out.
      if (this.detourFrames > 0) break;
    }
  }

  private start(self: Fighter, id: string) {
    let m = self.moveDef(id);
    if (!m || !self.canUse(m) || !self.canReach(m)) {
      // That arm (or leg) is gone, or it can't get up to where it's aimed: throw
      // something that works — from the plan, or failing that, a kick.
      const plan = this.planFor(self);
      const ok = (mid: string) => {
        const d = self.moveDef(mid);
        return !!d && self.canUse(d) && self.canReach(d);
      };
      // Whatever's left of the plan, and the kicks: a man with no arms kicks, he doesn't
      // only try to sweep.
      const usable: [string, number][] = plan.moves.filter(([mid]) => mid !== id && ok(mid));
      for (const k of ['teep', 'kLowKick', 'frontKick', 'lowKick']) if (ok(k) && !usable.some(([u]) => u === k)) usable.push([k, 20]);
      const pick = usable.length ? this.rng.pickWeighted<string>(usable) : undefined;
      m = pick ? self.moveDef(pick) : undefined;
      if (!m || !self.canUse(m)) {
        this.cooldown = this.rng.range(30, 60);
        return;
      }
      id = pick!;
    }
    self.startMove(m);
    this.director?.claim();
    const next = this.planFor(self).chains[id];
    this.chain = next && this.rng.chance(this.cfg.stringChance) ? next : null;
    this.cooldown = this.rng.range(30, 70);
  }
}
