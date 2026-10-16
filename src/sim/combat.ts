import { Vector3 } from 'three';
import { type BoneName, bonePoint, fistPoint, footPoint, SKELETON } from '../body/skeleton';
import type { PoseName } from '../body/poses';
import { AIDirector, BrawlerAI, MAX_HEFT } from './ai';
import { type Button, type Fighter } from './fighter';
import { RectWalkable, type Walkable } from '../world/collision';
import { bodyCapsules, overlap as capsuleOverlap, segDist as segDistance, strikingLimbs } from './bodyShapes';
import { angleDelta, approachAngle, DT, Rng } from './math';
import { aimBallistic, centreOfMass, integrate, type Projectile, projectileDir, projectilePoints, pointVelocity, substeps } from './projectiles';
import { DEFENSES, type DefenseKind, type Height, type MoveDef, moveLength, spinProgress } from './moves';
import { chooseDefense, moveContext, selectPlayerMove } from './select';
import { PERFECT_TIMING_FRAMES, type PerkId } from './perks';
import { bladePoints, GORE, heft, LIMB_TOUGHNESS, limbBones, sampleOffsets, SEVER_AT, selectWeaponMove, WEAPON_MOVES, type WeaponDef, type Wound } from './weapons';

/** A weapon lying on the arena floor. */
export interface Drop {
  id: number;
  weapon: WeaponDef;
  pos: Vector3;
  yaw: number;
  /** Where it left a hand (world, with height), if it was let go of rather than placed. */
  from?: Vector3;
}

export type HurtZone = 'head' | 'chest' | 'abdomen' | 'legs';

export type CombatEvent =
  | { type: 'attackStart'; f: Fighter; move: MoveDef }
  | { type: 'swing'; f: Fighter; move: MoveDef }
  | {
      type: 'hit';
      attacker: Fighter;
      defender: Fighter;
      move: MoveDef;
      point: Vector3;
      dir: Vector3;
      zone: HurtZone;
      damage: number;
      counter: boolean;
      armored: boolean;
      knockdown: boolean;
      ko: boolean;
      combo: number;
      /** Body part struck. */
      bone: BoneName;
      /** Weapon used (null for fists and feet). */
      weapon: WeaponDef | null;
      /** How hard it drove the body (mass ratio × what was behind it), see pushScale. */
      push: number;
      /** Struck by a weapon in flight rather than one in the hand. */
      thrown: boolean;
      /** A new cut, if the weapon has an edge. */
      wound: Wound | null;
      /** A limb (or the head) cut off. */
      sever: BoneName | null;
      /** A blow nobody survives: the skull split by an edge, or caved in. */
      fatal: Fatal | null;
      /** A piece torn away (an ear, scalp, a chunk of flesh). */
      tear: Tear | null;
    }
  | { type: 'block'; attacker: Fighter; defender: Fighter; move: MoveDef; point: Vector3; dir: Vector3; guardBreak: boolean; wound: Wound | null; parry: boolean; perfect?: boolean }
  | { type: 'pickup'; f: Fighter; drop: Drop }
  | { type: 'drop'; drop: Drop }
  | { type: 'bleedout'; f: Fighter }
  | { type: 'bump'; attacker: Fighter; defender: Fighter; point: Vector3 }
  /** A strike hit a prop (pillar, crate, table...) instead of a person. */
  | { type: 'clang'; f: Fighter; point: Vector3; metal: boolean }
  | { type: 'dodge'; attacker: Fighter; defender: Fighter; move: MoveDef; kind: DefenseKind | 'airborne'; point: Vector3; perfect?: boolean }
  | { type: 'defend'; f: Fighter; kind: DefenseKind }
  | { type: 'getup'; f: Fighter }
  /** A skill kicked in (Second Wind, Last Stand…). */
  | { type: 'perk'; f: Fighter; perk: PerkId; point: Vector3 }
  /** A weapon thrown (or let fly from the belt). */
  | { type: 'throw'; f: Fighter; projectile: Projectile }
  /** A weapon in flight hit something that isn't a person: the floor, a wall, a prop. */
  | { type: 'thud'; projectile: Projectile; point: Vector3; speed: number; wall: boolean };

export type Fatal = 'split' | 'cleft' | 'crush';
export type TearPiece = 'earL' | 'earR' | 'scalp' | 'cheek' | 'flesh';
export interface Tear {
  piece: TearPiece;
  bone: BoneName;
  /** Where it came from, in the bone's frame (authored scale). */
  local: [number, number, number];
  point: Vector3;
  /** How it flies off. */
  vel: Vector3;
  size: number;
}
/** Strikes that come straight down when the swing itself wasn't tracked. */
const DOWNWARD = new Set(['chop', 'overhead', 'menCut', 'flipSlash']);
/** Centre of the head's hit sphere along the bone. */
const HEAD_CENTRE = 0.13;
const _hc = new Vector3();

interface Contact {
  attacker: Fighter;
  defender: Fighter;
  /** The strike as it was when it connected (the attacker may be hit back first). */
  move: MoveDef;
  height: Height;
  point: Vector3;
  zone: HurtZone;
  bone: BoneName;
  /** Share of the swing's power behind the weapon at contact (1 for fists/feet). */
  power?: number;
  /** Caught with the handle / haft rather than the striking part. */
  haft?: boolean;
  /** Which way the striking part was travelling (world, unit), when known. */
  swing?: Vector3;
}

/** Below this much swing power a weapon just thuds against the body. */
const MIN_POWER = 0.45;

/** Hit points lost per second per unit of bleeding. */
export const BLEED_DPS = 1.1;

/** Lock-on tuning (rates in radians per frame). */
/** How much nearer (m) another opponent must be before the lock switches to it. */
const TARGET_SWITCH_MARGIN = 0.4;

export const FACING = {
  idleRate: 0.07,
  walkRate: 0.09,
  defendRate: 0.08,
  aimAssist: 0.07,
  /** Max lean of the body into a strafe (radians). */
  strafeLead: 0.35,
  /** Offsets smaller than this are tolerated while standing still. */
  idleDeadzone: 0.14,
  /** Closer than this, the fighter squares up to its target (soft lock-on)... */
  lockRange: 2.7,
  /** ...and stays locked until further than this (no flip-flopping at the edge). */
  unlockRange: 3.2,
  /** Turn rate while walking freely (rad/frame). */
  freeTurnRate: 0.11,
};

const _want = new Vector3();
const MIN_SEPARATION = 0.66;
/** Collision radius of a standing fighter against walls. */
export const BODY_RADIUS = 0.3;
const LUNGE_STOP = 0.74;
/**
 * How hard a blow shoves the one it lands on, relative to a like-for-like exchange:
 * momentum in (the attacker's strength — body size squared — and, for a weapon, its
 * mass and how fast it was moving) over the mass it has to move (size cubed). A hook
 * barely rocks a giant back; a giant's hook sends you flying; a sledgehammer moves
 * people a machete doesn't.
 */
export function pushScale(a: Fighter, d: Fighter, weapon: WeaponDef | null, power = 1): number {
  const bodies = Math.pow((a.scale * a.scale) / (d.scale * d.scale * d.scale), 0.7);
  // A bare fist is the baseline; anything in the hand only adds mass behind the blow.
  const tool = weapon ? 1 + 0.15 * weapon.mass * Math.max(0.3, Math.min(1, power)) : 1;
  return Math.max(0.15, Math.min(3, bodies * tool));
}

/**
 * How likely a fighter is to read a strike in time and react to it. Fresh, facing one
 * man and his first punch, most are seen coming; tired, rattled by the last one, the
 * second and third of a string, a quick jab, or a second man swinging at the same time,
 * more and more get through.
 */
export function readChance(f: Fighter, o: Fighter, opponents: Fighter[]): number {
  let p = readiness(f);
  const m = o.move!;
  // Throwing the same strike again and again: they see it coming.
  p *= 1 + 0.15 * Math.min(4, o.repeatCount);
  p *= Math.max(0.8, Math.min(1.1, 0.75 + m.startup * 0.02));
  // A big weapon wound up overhead is the most obvious thing in the world — and the
  // one blow nobody can afford to take.
  if (m.weapon && m.weight === 'heavy') p *= DOWNWARD.has(m.id) ? 1.4 : 1.2;
  for (const x of opponents) if (x !== o && x.state === 'attack' && !x.hitThisAttack) p *= 0.55;
  return Math.max(0.12, Math.min(0.95, p));
}

/** How sharp a fighter is right now: fresh and settled, or tired, rattled, already reacting. */
function readiness(f: Fighter): number {
  let p = 0.82 * f.readSkill;
  p *= 0.5 + 0.5 * f.stamina;
  if (f.framesSinceHit < 40) p *= 0.6;
  if (f.framesSinceDefend < 24) p *= 0.75;
  return p;
}

/** Something to block with: at least one forearm left. */
const canGuard = (f: Fighter) => !(f.isSevered('foreArmL') && f.isSevered('foreArmR'));
/** Frames after the guard is up during which meeting a strike parries it. */
export const PARRY_WINDOW = 4;
/** How close to landing (frames) a strike is when Q / E meets it instead of attacking. */
export const PARRY_READ = 12;
/** A slide thrown with the strike at most this many frames from landing: a perfect dodge. */
export const PERFECT_DODGE = 10;
/** Frames into a stagger before the guard can come back up. */
const COVER_AFTER = 8;
/** How far ahead of a strike landing (in multiples of the defence's startup) people react. */
const REACT_LEAD = 2.5;
const _strike = new Vector3();
const _up = new Vector3(0, 1, 0);
const _probe = new Vector3();
const _v = new Vector3();
const _e = new Vector3();
const _c = new Vector3();

/**
 * Fixed-step (60 Hz) combat simulation. Deterministic and renderer-free: it owns
 * gameplay truth (who hit whom), while the ragdoll only makes it look physical.
 */
/**
 * What a button would throw right now, and whether it can be thrown this instant (free,
 * in a chain's cancel window, or straight out of a successful defence).
 */
export function buttonMove(f: Fighter, button: Button): { move: MoveDef | null; ready: boolean; counter: boolean; chain: boolean } {
  const ctx = moveContext(f);
  const d = f.defense;
  const allowed =
    f.free ||
    (f.state === 'attack' && ctx.chainFrom !== null) ||
    (f.state === 'defend' && d !== null && (d.success || d.phase === 'recovery'));
  let id: string | null | undefined;
  if (f.weapon) {
    id = selectWeaponMove(button, f.weapon, ctx.counter, ctx.chainFrom);
    // Kicks out of a weapon combo.
    if (id === undefined && ctx.chainFrom && WEAPON_MOVES[ctx.chainFrom]) id = button === 'lkick' ? 'frontKick' : 'lowKick';
  }
  if (id === undefined) id = selectPlayerMove(button, ctx);
  let move = (id ? f.moveDef(id) : undefined) ?? null;
  let ready = allowed && !!move && f.canUse(move);
  // No follow-up from this button in the middle of a chain: it's its usual move, once
  // the chain's done.
  if (!move && ctx.chainFrom) {
    const free = { ...ctx, chainFrom: null };
    const base = (f.weapon ? selectWeaponMove(button, f.weapon, null, null) : undefined) ?? selectPlayerMove(button, free);
    move = (base ? f.moveDef(base) : undefined) ?? null;
    ready = false;
  }
  if (ready && f.state === 'attack' && ctx.chainFrom && !f.move!.cancel!.into.includes(move!.id)) ready = false;
  return { move, ready, counter: ctx.counter !== null, chain: f.state === 'attack' && ctx.chainFrom !== null };
}

export class CombatSim {
  readonly fighters: Fighter[] = [];
  readonly events: CombatEvent[] = [];
  readonly ais = new Map<Fighter, BrawlerAI>();
  /** Turn-taking between enemies (only one starts an attack per window). */
  readonly director = new AIDirector();
  /** Weapons lying around. */
  readonly drops: Drop[] = [];
  private dropSerial = 0;
  private readonly prevBlade = new Map<Fighter, Vector3[]>();
  /** Weapons in the air. */
  readonly projectiles: Projectile[] = [];
  private projSerial = 0;
  frame = 0;
  /** Where fighters can stand (the arena floor minus its props). */
  walkable: Walkable = new RectWalkable(-7.5, 7.5, -4.5, 4.5);
  readonly rng: Rng;
  /** When set, knocked-down fighters' positions are driven externally (ragdoll). */
  externalKnockdown = false;
  private readonly speeds = new Map<Fighter, { speed: number; lx: number; lz: number; turn: number }>();

  constructor(seed = 7) {
    this.rng = new Rng(seed);
  }

  add(f: Fighter, ai?: BrawlerAI) {
    this.fighters.push(f);
    if (ai) {
      ai.director ??= this.director;
      ai.drops = this.drops;
      this.ais.set(f, ai);
    }
    f.updatePose(0, 0, 0);
  }

  remove(f: Fighter) {
    const i = this.fighters.indexOf(f);
    if (i >= 0) this.fighters.splice(i, 1);
    this.ais.delete(f);
    for (const o of this.fighters) if (o.target === f) o.target = null;
  }

  opponents(f: Fighter): Fighter[] {
    return this.fighters.filter((o) => o.team !== f.team);
  }

  step(): CombatEvent[] {
    this.events.length = 0;
    this.frame++;
    this.director.frame = this.frame;
    const fs = this.fighters;

    for (const f of fs) this.retarget(f);
    for (const f of fs) this.tickTimers(f);
    for (const f of fs) this.advance(f);
    for (const f of fs) this.ais.get(f)?.think(f, f.target, this.walkable);
    for (const f of fs) this.manualDefense(f);
    for (const f of fs) this.autoDefend(f);
    for (const f of fs) this.tryBufferedAttack(f);
    for (const f of fs) this.tryPickup(f);
    for (const f of fs) this.bleed(f);
    for (const f of fs) this.locomote(f);
    this.separate();
    for (const f of fs) {
      const s = this.speeds.get(f) ?? { speed: 0, lx: 0, lz: 0, turn: 0 };
      f.updatePose(s.speed, s.lx, s.lz, s.turn);
    }
    this.resolveHits();
    this.stepProjectiles();
    return this.events;
  }

  // ---------------------------------------------------------------------------

  /**
   * Lock onto the nearest opponent (measured to the edge of big bodies). A committed
   * strike keeps its target, and a new one has to be clearly nearer before the lock
   * switches, so two enemies at similar range don't make it flip back and forth.
   */
  private retarget(f: Fighter) {
    const cur = f.target && f.target.alive ? f.target : null;
    if (cur && f.state === 'attack') return;
    const reach = (o: Fighter) => f.distanceTo(o) - (o.scale - 1) * 0.35;
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const o of this.opponents(f)) {
      if (!o.alive) continue;
      const d = reach(o);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (cur && best !== cur && reach(cur) - bestD < TARGET_SWITCH_MARGIN) best = cur;
    f.target = best;
  }

  private tickTimers(f: Fighter) {
    if (f.counter && --f.counter.frames <= 0) f.counter = null;
    if (!f.counter) f.perfectCounter = false;
    // Stamina: running burns it; easing off brings it back (slower when hurt).
    if (f.alive) {
      const run = f.footwork.run * f.motion.gait;
      const resting = f.free ? (run > 0.3 ? -0.035 * run : 0.085) : f.state === 'attack' ? 0 : 0.03;
      const hurt = 0.5 + 0.5 * (f.hp / f.stats.maxHp);
      // Holding a heavy weapon up is work in itself: you get your breath back slower.
      const burden = 1 - Math.min(0.5, 0.06 * heft(f.weapon, f.scale));
      f.stamina = Math.max(0, Math.min(1, f.stamina + (resting > 0 ? resting * hurt * burden * f.staminaRegenMul : resting) * DT));
    }
    for (const k of Object.keys(f.defenseCooldown) as DefenseKind[]) {
      if (f.defenseCooldown[k] > 0) f.defenseCooldown[k]--;
    }
    f.framesSinceBlock++;
    f.framesSinceHit++;
    f.framesSinceLanded++;
    f.framesSinceDefend++;
    f.sinceMoveStart++;
    if (f.framesSinceBlock > 60 && f.guard < f.stats.maxGuard) f.guard = Math.min(f.stats.maxGuard, f.guard + 0.35);
    if (f.framesSinceHit > 50 && f.poise < f.stats.maxPoise) f.poise = Math.min(f.stats.maxPoise, f.poise + 0.8);
    if (f.target && f.target.state !== 'hitstun' && f.target.state !== 'guardbreak' && f.target.state !== 'knockdown') {
      f.combo = 0;
    }
  }

  private advance(f: Fighter) {
    f.stateFrame++;
    switch (f.state) {
      case 'attack': {
        const m = f.move!;
        if (f.stateFrame === m.startup) this.events.push({ type: 'swing', f, move: m });
        if (m.air) this.advanceAir(f, m);
        if (m.spin && !f.attackEnd && f.stateFrame >= m.spin.from && f.stateFrame < m.spin.to) {
          // Wound up from the feet, carried by its own momentum, braked by the feet again.
          f.yaw += Math.PI * 2 * m.spin.turns * (spinProgress(m.spin, f.stateFrame + 1) - spinProgress(m.spin, f.stateFrame));
        }
        if (m.throw && f.stateFrame === m.throw.release) this.release(f, m);
        if (m.lunge && !m.air && !f.attackEnd && f.stateFrame >= m.lunge.from && f.stateFrame < m.lunge.to) {
          let step = (m.lunge.distance * f.scale) / (m.lunge.to - m.lunge.from);
          const t = f.target && f.target.alive ? f.target : null;
          if (t) step = Math.min(step, Math.max(0, f.distanceTo(t) - (LUNGE_STOP * (f.scale + t.scale)) / 2));
          // A long weapon needs room: step in only as far as puts its head on them — and
          // if they've come inside it, give ground while winding up, so it's still the
          // head that lands and not the haft. (Your footwork; opponents keep their own
          // spacing, see the AI's plan.)
          if (t && f.team === 'player' && f.weapon && m.weapon && f.weapon.strikeFrom >= 0.45) {
            const want = (0.85 + f.weapon.strikeFrom) * f.scale + 0.15 * (t.scale - 1);
            const left = Math.max(1, m.lunge.to - f.stateFrame);
            const back = (0.45 * f.scale) / (m.lunge.to - m.lunge.from);
            step = Math.max(-back, Math.min(step, (f.distanceTo(t) - want) / left));
            // (Not back toward a wall or a prop: with no room, it's the haft.)
            if (step < 0) {
              const r = 1.1 * f.scale;
              const bx = f.pos.x - f.forward.x * r;
              const bz = f.pos.z - f.forward.z * r;
              if (!this.walkable.isWalkable(bx, bz) || this.walkable.solidAt?.(_probe.set(bx, 1, bz), 0.35)) step = 0;
            }
          }
          f.pos.addScaledVector(f.forward, step);
        }
        f.refitSwing();
        // A heavy swing that meets nothing keeps going: its weight drags the body on a
        // step and takes longer to haul back under control.
        const over = m.weapon && !f.attackEnd ? Math.max(0, heft(f.weapon, f.scale) - 1.2) : 0;
        const past = f.stateFrame - (m.startup + m.active);
        if (over > 0 && past > 0 && past <= 10 && !f.hitThisAttack) f.pos.addScaledVector(f.forward, 0.012 * over * f.scale);
        if (f.stateFrame >= (f.attackEnd || moveLength(m) + Math.round((f.hitThisAttack ? 0 : 4) * over))) f.enterLocomotion(5);
        break;
      }
      case 'defend': {
        const d = f.defense!;
        if (d.def.retreat) {
          const frames = d.def.startup + 8;
          if (f.stateFrame <= frames && d.phase !== 'recovery') f.pos.addScaledVector(f.forward, (-d.def.retreat * f.scale) / frames);
        }
        if (d.phase === 'startup' && f.stateFrame >= d.def.startup) d.phase = 'active';
        if (d.phase === 'active' || d.phase === 'startup') {
          if (this.threatOver(f)) {
            // Only a strike that was actually coming counts as dodged (not one that hit a
            // pillar on the way, or was stopped by getting hit).
            // (A dodge you threw at a strike that was reaching you counts, even if your step
            // back took you clean out of its range.)
            if (!d.success && (this.threatReachedUs(f) || (d.threatSerial >= 0 && d.threatSerial === f.dodgedSerial))) this.markDodge(f, null);
            f.enterDefenseRecovery();
          }
        } else if (d.phase === 'recovery' && f.stateFrame >= d.def.recovery) {
          f.enterLocomotion(4);
        }
        break;
      }
      case 'hitstun':
      case 'blockstun':
      case 'guardbreak':
        if (f.stateFrame >= f.stunFrames) f.enterLocomotion(4);
        break;
      case 'knockdown':
        if (f.stateFrame >= f.stunFrames) {
          f.enterGetup();
          this.events.push({ type: 'getup', f });
        }
        break;
      case 'pickup':
        this.advancePickup(f);
        break;
      case 'getup':
      case 'celebrate':
        if (f.stateFrame >= f.stunFrames) f.enterLocomotion(4);
        break;
      default:
        break;
    }
  }

  /** The attack a defense was answering has finished its active frames (or stopped). */
  private threatReachedUs(f: Fighter): boolean {
    const serial = f.defense!.threatSerial;
    const o = this.opponents(f).find((x) => x.id * 100000 + x.attackSerial === serial);
    if (!o || o.state !== 'attack' || !o.move || o.attackEnd || o.move.noHit) return false;
    return f.distanceTo(o) <= (o.move.reach + o.stats.reach) * o.scale + 0.3;
  }

  private threatOver(f: Fighter): boolean {
    const serial = f.defense!.threatSerial;
    if (serial < 0) {
      // A weapon in flight: over once it's down, spent, or gone past.
      const p = this.projectiles.find((x) => x.serial === serial);
      return !p || !p.live || p.vel.x * (f.pos.x - p.pos.x) + p.vel.z * (f.pos.z - p.pos.z) < 0;
    }
    for (const o of this.opponents(f)) {
      if (o.id * 100000 + o.attackSerial !== serial) continue;
      if (o.state !== 'attack' || !o.move) return true;
      return o.stateFrame >= o.move.startup + o.move.active;
    }
    return true;
  }

  /**
   * The strike coming at `f` that a press of Q / E would meet instead of throwing one:
   * on its way in, aimed at them, in range, and close enough to landing to be read.
   */
  threatFor(f: Fighter): Fighter | null {
    let threat: Fighter | null = null;
    for (const o of this.opponents(f)) {
      if (o.state !== 'attack' || !o.move || o.hitThisAttack || o.move.noHit || o.attackEnd) continue;
      const fta = o.framesToActive;
      if (fta > PARRY_READ || fta < -o.move.active + 1) continue;
      if (f.distanceTo(o) > (o.move.reach + o.stats.reach) * o.scale + 0.6) continue;
      if (!threat || fta < threat.framesToActive) threat = o;
    }
    return threat;
  }

  /** A once-a-round skill: whether it's there to use now (and if so, spends it). */
  private oncePerRound(f: Fighter, perk: PerkId): boolean {
    if (!f.perks.has(perk) || f.perksUsed.has(perk)) return false;
    f.perksUsed.add(perk);
    return true;
  }

  /** Whether a strike can be parried (met with the guard), or only got out of the way of. */
  static parryable(f: Fighter, o: Fighter): boolean {
    const m = o.move!;
    return m.blockable && m.weight !== 'heavy' && o.strikeHeight !== 'low' && canGuard(f);
  }

  /**
   * Q / E pressed with a strike about to land: the press meets it instead. A punch or a
   * kick gets parried — the guard comes up into it and, timed to the last instant, it's
   * knocked aside and you're straight in on the counter; a big swing (or one at the legs)
   * you can't stop, so you slide back out of it. Pressed early, it's only a block (or a
   * step back), with nothing on the end of it — so mashing defends, but only timing pays.
   */
  private manualDefense(f: Fighter) {
    const b = f.buffer;
    if (!b || (b.button !== 'lpunch' && b.button !== 'rpunch') || f.team !== 'player' || f.counter || !f.alive) return;
    // (Taking over from the automatic guard if it's only just started.)
    const able = f.free || f.state === 'blockstun' || (f.state === 'defend' && (f.defense!.phase === 'recovery' || f.defense!.success || !f.defenseManual));
    if (!able) return;
    const t = this.threatFor(f);
    if (!t) return;
    const serial = t.id * 100000 + t.attackSerial;
    if (f.state === 'defend' && f.defenseManual && f.defense!.threatSerial === serial) return;
    const kind: DefenseKind = CombatSim.parryable(f, t) ? 'block' : 'slide';
    const def = DEFENSES[kind];
    const fta = t.framesToActive;
    f.buffer = null;
    f.defenseCooldown[kind] = 0;
    f.startDefense(kind, serial, undefined, Math.max(def.startup, fta));
    f.defenseManual = true;
    f.framesSinceDefend = 0;
    // Timed to it: met in the last instant before it lands (but still in time).
    const window = kind === 'block' ? def.startup + parryWindow(f) : PERFECT_DODGE;
    f.perfectSerial = fta <= window && fta >= def.startup - 1 ? serial : -1;
    f.dodgedSerial = f.distanceTo(t) <= (t.move!.reach + t.stats.reach) * t.scale + 0.3 ? serial : -1;
    this.events.push({ type: 'defend', f, kind });
  }

  private autoDefend(f: Fighter) {
    // (A sparring dummy — an AI told to stand there — doesn't react either.)
    if (!f.autoDefense || !f.alive || this.ais.get(f)?.cfg.passive) return;
    // Rocked by one, you can still get the guard up for the next once the first jolt has
    // passed — covering up, not slipping (that takes balance you haven't got back yet).
    const covering = f.state === 'hitstun' && f.stateFrame >= COVER_AFTER;
    const canReact =
      f.free ||
      covering ||
      f.state === 'blockstun' ||
      (f.state === 'defend' && (f.defense!.phase === 'recovery' || f.defense!.success));
    if (!canReact) return;

    for (const o of this.opponents(f)) {
      if (o.state !== 'attack' || !o.move || o.hitThisAttack || o.move.noHit) continue;
      const serial = o.id * 100000 + o.attackSerial;
      if (serial === f.lastDefendedSerial) continue;
      const fta = o.framesToActive;
      if (fta < -o.move.active) continue;
      if (f.distanceTo(o) > (o.move.reach + o.stats.reach) * o.scale + 0.45) continue;
      let kind = chooseDefense(f, o.move, fta, o.strikeHeight);
      if (covering) kind = o.move.blockable && o.strikeHeight !== 'low' && canGuard(f) && DEFENSES.block.startup <= Math.max(fta, 0) + 1 ? 'block' : null;
      if (!kind) continue;
      // People read a strike and start moving a beat before it lands (~150-200 ms for a
      // slip), rather than snapping out of the way in the last 60 ms.
      const def = DEFENSES[kind];
      if (fta <= Math.round(def.startup * REACT_LEAD) + 1) {
        // Nobody reads everything: one look at it, and a miss is a miss.
        if (serial === f.misreadSerial) continue;
        // (Under a flurry, keeping the hands up is the easy part, rattled or not.)
        const chance = covering ? 0.45 + 0.4 * f.readSkill : readChance(f, o, this.opponents(f));
        if (!this.rng.chance(chance)) {
          f.misreadSerial = serial;
          continue;
        }
        // Slip away from the line the arm (or leg) is coming in on.
        const shoulder = o.rig[o.move.limb === 'handL' ? 'upperArmL' : o.move.limb === 'handR' ? 'upperArmR' : o.move.limb === 'footL' ? 'thighL' : 'thighR'].pos;
        const dx = shoulder.x - f.pos.x;
        const dz = shoulder.z - f.pos.z;
        const localX = dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw);
        f.startDefense(kind, serial, localX > 0 ? -1 : 1, Math.max(def.startup, fta));
        f.framesSinceDefend = 0;
        this.events.push({ type: 'defend', f, kind });
        return;
      }
    }
    this.defendProjectiles(f);
  }

  /**
   * Something thrown at you: seen coming (a big axe more readily than a little knife),
   * you duck or slip what's coming at your head, block what's coming at the body, and
   * get your legs out of the way of anything low.
   */
  private defendProjectiles(f: Fighter) {
    for (const p of this.projectiles) {
      if (!p.live || p.owner.team === f.team) continue;
      if (p.serial === f.lastDefendedSerial || p.serial === f.misreadSerial) continue;
      _c.set(f.pos.x, f.rig.chest.pos.y, f.pos.z);
      const rel = _v.subVectors(_c, p.pos);
      const v2 = p.vel.lengthSq();
      if (v2 < 1) continue;
      const tc = rel.dot(p.vel) / v2;
      if (tc <= 0 || tc > 0.7) continue;
      const y = p.pos.y + p.vel.y * tc - 4.9 * tc * tc;
      const miss = Math.hypot(p.pos.x + p.vel.x * tc - _c.x, p.pos.z + p.vel.z * tc - _c.z);
      if (miss > 0.5 * f.scale || y < 0 || y > f.rig.head.pos.y + 0.3 * f.scale) continue;
      const fta = Math.round(tc * 60);
      const height: Height = y > f.rig.head.pos.y - 0.14 * f.scale ? 'high' : y > f.rig.abdomen.pos.y - 0.12 * f.scale ? 'mid' : 'low';
      const kind = chooseDefense(f, { blockable: true, kind: 'straight', height } as MoveDef, fta, height);
      if (!kind) continue;
      const def = DEFENSES[kind];
      if (fta > Math.round(def.startup * REACT_LEAD) + 1) continue;
      const chance = readiness(f) * (p.weapon.mass > 1.5 ? 0.95 : 0.6);
      if (!this.rng.chance(chance)) {
        f.misreadSerial = p.serial;
        continue;
      }
      const side = (p.vel.x * Math.cos(f.yaw) - p.vel.z * Math.sin(f.yaw)) > 0 ? 1 : -1;
      f.startDefense(kind, p.serial, side, Math.max(def.startup, fta));
      f.framesSinceDefend = 0;
      this.events.push({ type: 'defend', f, kind });
      return;
    }
  }

  private tryBufferedAttack(f: Fighter) {
    const b = f.buffer;
    if (!b) return;
    if (b.frames-- <= 0 || !f.alive) {
      f.buffer = null;
      return;
    }
    const pick = buttonMove(f, b.button);
    if (!pick.move || !pick.ready) return;
    const move = pick.move;
    f.startMove(move, pick.counter);
    this.events.push({ type: 'attackStart', f, move });
  }

  private locomote(f: Fighter) {
    const lockT = f.target && f.target.alive ? f.target : null;
    const lockD = lockT ? f.distanceTo(lockT) : Infinity;
    // Squaring up to a giant happens further out.
    const big = lockT ? Math.max(f.scale, lockT.scale) : 1;
    f.lockedOn = lockD < (f.lockedOn ? FACING.unlockRange : FACING.lockRange) * big;
    const external = this.externalKnockdown && (f.state === 'knockdown' || f.state === 'ko');
    if (!external) {
      f.pos.x += f.vel.x * DT;
      f.pos.z += f.vel.z * DT;
    }
    const friction = f.state === 'knockdown' || f.state === 'ko' ? 0.93 : 0.86;
    f.vel.multiplyScalar(friction);

    // Footwork. Free fighters walk; hand strikes can keep stepping at reduced speed;
    // everything else keeps (and bleeds off) the momentum it had going in.
    const handStrike = f.state === 'attack' && f.move?.layer === 'upper';
    if (f.free || handStrike) {
      const mi = f.moveInput;
      const raw = Math.hypot(mi.x, mi.z);
      const len = Math.min(1, raw);
      _want.set(0, 0, 0);
      if (len > 0.1) {
        const fwd = f.forward;
        const dot = (mi.x * fwd.x + mi.z * fwd.z) / raw;
        // Speed comes from the contextual motion profile (stance footwork in range,
        // full walking stride far away, slower when hurt...).
        const locked = f.lockedOn;
        // Locked on: backpedalling is slower. Free walking: turn first, then go.
        const turnFirst = locked ? 1 : Math.max(0.3, (1 + dot) / 2);
        const sp =
          f.stats.walkSpeed * len * f.motion.speed * (locked && dot < -0.3 ? 0.72 : 1) * turnFirst * (handStrike ? 0.6 : 1) *
          // Lugging something heavy slows you down.
          (1 - Math.min(0.25, 0.035 * heft(f.weapon, f.scale)));
        _want.set(mi.x / raw, 0, mi.z / raw).multiplyScalar(sp);
      }
      // Accelerate rather than snap, so starts/stops have weight — more of it the more
      // there is to move: a giant takes a while to get going and to pull up; a small
      // creature darts; a heavy weapon in your hands adds to it.
      const inertia = Math.pow(f.scale * f.scale * f.scale, 0.35) * (1 + 0.03 * heft(f.weapon, f.scale));
      f.walkVel.lerp(_want, (_want.lengthSq() > f.walkVel.lengthSq() ? 0.22 : 0.3) / inertia);
      if (f.free) f.state = f.walkVel.lengthSq() > 0.04 || len > 0.1 ? 'walk' : 'idle';
    } else if (f.state === 'attack' || f.state === 'defend') {
      f.walkVel.multiplyScalar(0.88);
    } else {
      f.walkVel.multiplyScalar(0.6);
    }
    if (!external && f.walkVel.lengthSq() > 1e-6) {
      f.pos.x += f.walkVel.x * DT;
      f.pos.z += f.walkVel.z * DT;
    }

    const speed = Math.hypot(f.walkVel.x, f.walkVel.z);
    let lx = 0;
    let lz = 0;
    if (speed > 0.01) {
      // Footwork direction in fighter-local space (+X = fighter's left).
      const c = Math.cos(f.yaw);
      const s = Math.sin(f.yaw);
      const wx = f.walkVel.x / speed;
      const wz = f.walkVel.z / speed;
      lx = wx * c - wz * s;
      lz = wx * s + wz * c;
    }

    const before = f.yaw;
    this.updateFacing(f);
    this.speeds.set(f, { speed, lx, lz, turn: angleDelta(before, f.yaw) });
  }

  /**
   * Soft lock-on: fighters turn toward their target, but not instantly. Strafing leads
   * the body into the strafe, small offsets are left alone, and committed moves only get
   * a little aim assist early in their wind-up — so angles and positioning matter.
   */
  private updateFacing(f: Fighter) {
    // Spinning or in the air, nothing turns you but the momentum you already have.
    const m = f.state === 'attack' ? f.move : null;
    if (m && ((m.spin && f.stateFrame >= m.spin.from) || (m.air && f.stateFrame >= m.air.from))) return;
    const t = f.target && f.target.alive ? f.target : null;
    const mi = f.moveInput;
    const moving = Math.hypot(mi.x, mi.z) > 0.1;
    let rate = 0;
    if (f.free) rate = moving ? FACING.walkRate : FACING.idleRate;
    else if (f.state === 'defend' || f.state === 'blockstun') rate = FACING.defendRate;
    else if (f.state === 'attack' && f.move && f.stateFrame < f.move.startup * 0.7) rate = FACING.aimAssist;
    else if (f.state === 'getup') rate = 0.06;
    if (rate <= 0) return;

    let desired: number | null = null;
    let deadzone = 0;
    if (t && f.lockedOn) {
      const toT = Math.atan2(t.pos.x - f.pos.x, t.pos.z - f.pos.z);
      desired = toT;
      if (moving && f.free) {
        // Strafing: lead with the body, keep the head and guard roughly on target.
        const rel = angleDelta(toT, Math.atan2(mi.x, mi.z));
        desired = toT + Math.sin(rel) * FACING.strafeLead;
      } else if (f.free) {
        deadzone = FACING.idleDeadzone;
      }
    } else if (moving) {
      // Not in a fight: turn to face where you're going and walk there.
      desired = Math.atan2(mi.x, mi.z);
      if (f.free) rate = FACING.freeTurnRate;
    }
    if (desired === null) return;
    const d = angleDelta(f.yaw, desired);
    if (Math.abs(d) <= deadzone) return;
    // Walking, a sharp turn slows while the legs are crossed over the planted feet, so
    // the steps keep up (people turn step by step, not by spinning on crossed legs).
    if (f.free && f.motion.gait > 0.5 && f.footwork.legsCrossed(f)) rate = Math.min(rate, 0.04);
    f.yaw = approachAngle(f.yaw, desired - Math.sign(d) * deadzone, rate);
  }

  private separate() {
    const fs = this.fighters;
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const a = fs[i];
        const b = fs[j];
        if (!a.alive || !b.alive || a.state === 'knockdown' || b.state === 'knockdown') continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const minSep = (MIN_SEPARATION * (a.scale + b.scale)) / 2;
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        // Bodies are solid: torsos, arms, gloves and legs can't sink into each other
        // (the limb throwing a strike is left to the strike, which stops on contact).
        let push = Math.max(0, minSep - d) / 2;
        push = Math.max(push, this.bodyOverlap(a, b) * 0.5);
        if (push > 0) {
          // The bigger body gives way less.
          const wa = (b.scale * b.scale) / (a.scale * a.scale + b.scale * b.scale);
          a.pos.x -= nx * push * 2 * wa;
          a.pos.z -= nz * push * 2 * wa;
          b.pos.x += nx * push * 2 * (1 - wa);
          b.pos.z += nz * push * 2 * (1 - wa);
        }
      }
    }
    for (const f of fs) {
      // Feet and knees reach past the hips: keep them out of furniture too.
      if (f.state !== 'knockdown' && f.state !== 'ko') this.walkable.resolve(f.pos, BODY_RADIUS * f.scale, 0.14 * f.scale);
      f.pos.y = 0;
    }
  }

  /**
   * A strike stops on whatever it runs into first. If the striking arm or leg is
   * driving into the opponent's body, guard or weapon (rather than landing cleanly
   * with the fist / foot), it's caught: by the guard (a block), smothered by the body,
   * or stopped by a weapon in the way — and a blade held up cuts the arm that hits it.
   */
  private resolveJams(landed: Set<Fighter>) {
    for (const a of this.fighters) {
      // (A strike that was slipped or ducked carries on — and slides off the shoulder.)
      if (a.state !== 'attack' || !a.move || a.attackEnd || a.move.noHit || landed.has(a)) continue;
      const m = a.move;
      const dodged = a.hitThisAttack;
      const kick = m.limb === 'footL' || m.limb === 'footR';
      // Only once the strike is on its way out: a punch loading up isn't driving into
      // anything yet. A kick's knee comes up and forward first, so a kick thrown from too
      // close gets jammed on the way.
      if (a.stateFrame < m.startup * (kick ? 0.2 : 1)) continue;
      // The fist / foot itself is the strike — the hit test handles it. Here it's the
      // forearm, upper arm, shin or thigh arriving first (thrown from too close).
      // Once it's been slipped, though, the fist is just an arm going past — and it can't
      // go through the head it missed.
      const tip = m.limb === 'handL' ? 'fistL' : m.limb === 'handR' ? 'fistR' : null;
      const mine = bodyCapsules(a).limbs.filter((c) => strikingLimbs(m.limb).includes(c.bone));
      for (const d of this.opponents(a)) {
        if (!d.alive || d.state === 'knockdown' || d.state === 'getup') continue;
        const theirs = bodyCapsules(d);
        let worst = 0;
        let hitGuard = false;
        let at: Vector3 | null = null;
        for (const x of mine) {
          if (x.bone === tip && !dodged) continue;
          for (const y of [...theirs.torso, ...theirs.limbs]) {
            const v = capsuleOverlap(x, y);
            if (v > worst) {
              worst = v;
              hitGuard = y.bone === 'foreArmL' || y.bone === 'foreArmR' || y.bone === 'fistL' || y.bone === 'fistR' || y.bone === 'upperArmL' || y.bone === 'upperArmR';
              at = y.b.clone().lerp(x.b, 0.5);
            }
          }
        }
        // Their weapon, held up in the way.
        let blade = 0;
        if (d.weapon && !d.isSevered('foreArmR')) {
          for (const p of bladePoints(d, d.weapon)) {
            for (const x of mine) {
              const v = x.r + d.weapon.radius * d.scale - segDistance(p, p, x.a, x.b);
              if (v > blade) blade = v;
              if (v > worst) {
                worst = v;
                at = p.clone();
                hitGuard = true;
              }
            }
          }
        }
        if (worst < 0.03 * Math.max(1, a.scale) || !at) continue;
        const dir = new Vector3(d.pos.x - a.pos.x, 0, d.pos.z - a.pos.z).normalize();
        if (!dodged && hitGuard && (d.state === 'blockstun' || (d.state === 'defend' && d.defense?.def.kind === 'block'))) {
          // The guard caught it.
          a.hitThisAttack = true;
          this.block(a, d, m, at, dir);
        } else if (kick && !dodged && m.id === 'teep') {
          // A push kick that lands with the shin / knee still shoves: that's its job.
          a.hitThisAttack = true;
          a.impact('rebound', 2, 10);
          const mass = (a.scale * a.scale) / (d.scale * d.scale);
          d.vel.addScaledVector(dir, Math.min(2.5, 1.6 * mass));
          a.vel.addScaledVector(dir, -Math.min(2.5, 1.6 / mass));
          this.events.push({ type: 'bump', attacker: a, defender: d, point: at });
        } else {
          a.hitThisAttack = true;
          a.impact('rebound', 1, 8);
          this.events.push({ type: 'bump', attacker: a, defender: d, point: at });
        }
        // Punching into a held blade: it cuts the arm.
        if (blade > 0.03 && d.weapon?.edge === 'blade' && !m.weapon) {
          const arm = m.limb === 'handL' ? 'foreArmL' : m.limb === 'handR' ? 'foreArmR' : m.limb === 'footL' ? 'shinL' : 'shinR';
          this.addWound(a, arm, at, 6 * d.weapon.damageMul, d.weapon.cut);
          a.hp = Math.max(a.minHp, a.hp - 4 * d.weapon.damageMul);
        }
        break;
      }
    }
  }

  /**
   * A punch or kick whose fist / foot is already on the opponent's head or body in the
   * last frames of its wind-up (they stepped onto it) lands there and then.
   */
  private landsEarly(a: Fighter): boolean {
    const m = a.move;
    if (a.state !== 'attack' || !m || m.weapon || m.noHit || a.attackEnd || a.stateFrame >= m.startup || a.stateFrame < m.startup * 0.7) return false;
    const tip = m.limb === 'handL' ? 'fistL' : m.limb === 'handR' ? 'fistR' : m.limb === 'footL' ? 'shinL' : 'shinR';
    const mine = bodyCapsules(a).limbs.filter((c) => c.bone === tip);
    for (const d of this.opponents(a)) {
      // (Someone already reacting gets their defence in if it's in place; if not, it's
      // arrived before they got out of the way.)
      if (!d.alive || d.state === 'knockdown' || d.state === 'getup') continue;
      for (const x of mine) for (const y of bodyCapsules(d).torso) if (capsuleOverlap(x, y) > 0.02) return true;
    }
    return false;
  }

  /**
   * How deep two fighters' bodies overlap (sim pose), ignoring limbs mid-strike. Gloves
   * and forearms touching guard-on-guard is normal at close range (and how a jab gets
   * parried), so only the trunk, head, upper arms and legs are solid to the other body.
   */
  private bodyOverlap(a: Fighter, b: Fighter): number {
    const skip = (f: Fighter): Parameters<typeof bodyCapsules>[1] => [
      'fistL', 'fistR', 'foreArmL', 'foreArmR',
      ...(f.state === 'attack' && f.move && !f.move.weapon ? strikingLimbs(f.move.limb) : []),
    ];
    const A = bodyCapsules(a, skip(a));
    const B = bodyCapsules(b, skip(b));
    let worst = 0;
    for (const x of [...A.torso, ...A.limbs]) for (const y of [...B.torso, ...B.limbs]) worst = Math.max(worst, capsuleOverlap(x, y));
    return worst;
  }

  // ---------------------------------------------------------------------------
  // Hits
  // ---------------------------------------------------------------------------

  private resolveHits() {
    const contacts: Contact[] = [];
    for (const a of this.fighters) {
      if (a.hitThisAttack) continue;
      const swinging = a.inWeaponContact();
      if (!swinging && !a.inActiveFrames() && !this.landsEarly(a)) continue;
      const m = a.move!;
      if (swinging && a.weapon) {
        // The whole weapon is solid for the whole swing: along it, and between this
        // frame's and last frame's position so a fast swing can't skip through someone.
        const w = a.weapon;
        const pts = bladePoints(a, w);
        const offs = sampleOffsets(w);
        const prev = this.prevBlade.get(a);
        const samples = [...pts];
        const at = [...offs];
        if (prev && prev.length === pts.length) {
          for (let i = 0; i < pts.length; i++) {
            samples.push(pts[i].clone().lerp(prev[i], 0.5));
            at.push(offs[i]);
          }
        }
        const r = (w.radius + a.stats.reach) * a.scale;
        for (const d of this.opponents(a)) {
          if (!d.alive || d.state === 'knockdown' || d.state === 'getup') continue;
          const c = overlapBody(samples, r, d, at);
          if (c) {
            const i = c.index % pts.length;
            const swing = prev && prev.length === pts.length ? pts[i].clone().sub(prev[i]) : null;
            contacts.push({
              attacker: a, defender: d, move: m, height: a.strikeHeight, point: c.point, zone: c.zone, bone: c.bone,
              power: a.swingPower(), haft: at[c.index] < w.strikeFrom - 0.02,
              swing: swing && swing.lengthSq() > 1e-8 ? swing.normalize() : undefined,
            });
            break;
          }
        }
        continue;
      }
      strikePoint(a, m, _strike);
      for (const d of this.opponents(a)) {
        if (!d.alive || d.state === 'knockdown' || d.state === 'getup') continue;
        const c = overlap(_strike, (m.radius + a.stats.reach) * a.scale, d, a.strikeHeight);
        if (c) {
          contacts.push({ attacker: a, defender: d, move: m, height: a.strikeHeight, ...c });
          break;
        }
      }
    }
    // Fists, feet and weapons that hit a pillar, a crate or a table stop there.
    for (const a of this.fighters) {
      if (a.hitThisAttack || contacts.some((c) => c.attacker === a)) continue;
      const swinging = a.inWeaponContact();
      if (!swinging && !a.inActiveFrames()) continue;
      const solidAt = this.walkable.solidAt?.bind(this.walkable);
      if (!solidAt) break;
      const pts = swinging && a.weapon ? bladePoints(a, a.weapon).slice(-3) : [strikePoint(a, a.move!, new Vector3())];
      for (const p of pts) {
        const o = solidAt(p);
        if (!o) continue;
        a.hitThisAttack = true;
        a.impact('rebound', 2, 10);
        this.events.push({ type: 'clang', f: a, point: p.clone(), metal: (o.h ?? 2.5) > 3 });
        break;
      }
    }
    this.resolveJams(new Set(contacts.map((c) => c.attacker)));
    for (const f of this.fighters) {
      if (f.weapon && f.inWeaponContact()) this.prevBlade.set(f, bladePoints(f, f.weapon));
      else this.prevBlade.delete(f);
    }
    // Apply after detection so simultaneous strikes trade.
    for (const c of contacts) c.attacker.hitThisAttack = true;
    for (const c of contacts) this.applyStrike(c);
  }

  private applyStrike({ attacker: a, defender: d, move: m, height, point, zone, bone, power = 1, haft = false, swing }: Contact) {
    // Two contacts in one frame: the first may already have dropped them, or cut off the
    // arm the second was coming from.
    if (!d.alive || d.state === 'knockdown' || d.state === 'ko' || !a.canUse(m)) return;
    const dir = new Vector3(d.pos.x - a.pos.x, 0, d.pos.z - a.pos.z);
    if (dir.lengthSq() < 1e-6) dir.copy(a.forward);
    dir.normalize();

    if (d.state === 'defend' && d.defense) {
      const def = d.defense.def;
      // (One you threw yourself, on Q / E, is set almost at once — you saw it coming.)
      const inPosition = d.defense.phase !== 'startup' || d.stateFrame >= def.startup - 1 || (d.defenseManual && d.stateFrame >= 1);
      if (inPosition && def.evades.includes(height)) {
        this.markDodge(d, a, point);
        return;
      }
      if (inPosition && m.blockable && def.blocks.includes(height) && canGuard(d)) {
        this.block(a, d, m, point, dir);
        return;
      }
    }
    if (d.state === 'attack' && d.move?.evades) {
      const e = d.move.evades;
      if (d.stateFrame >= e.from && d.stateFrame < e.to && e.heights.includes(height)) {
        this.events.push({ type: 'dodge', attacker: a, defender: d, move: m, kind: 'airborne', point });
        return;
      }
    }
    if (d.state === 'blockstun' && m.blockable && height !== 'low' && canGuard(d)) {
      this.block(a, d, m, point, dir);
      return;
    }
    // Not enough behind it (still accelerating, or the follow-through is spent): the
    // weapon just thuds against the body and stops.
    if (m.weapon && power < MIN_POWER) {
      a.impact('rebound', 2, 10);
      d.vel.addScaledVector(dir, 0.4);
      this.events.push({ type: 'bump', attacker: a, defender: d, point: point.clone() });
      return;
    }
    this.hit(a, d, m, point, dir, zone, bone, power, haft, null, swing);
  }

  private markDodge(d: Fighter, a: Fighter | null, point?: Vector3) {
    const def = d.defense!;
    def.success = true;
    // Your own dodge, timed to the strike: a perfect dodge.
    const perfect = def.threatSerial >= 0 && def.threatSerial === d.perfectSerial;
    d.perfectSerial = -1;
    d.counter = { kind: def.def.kind, frames: counterFrames(d, def.def.counterWindow + (perfect ? 24 : 0)) };
    if (perfect) d.perfectCounter = true;
    const attacker = a ?? this.opponents(d).find((o) => o.id * 100000 + o.attackSerial === def.threatSerial) ?? null;
    if (!attacker || !attacker.move) return;
    const p = point ?? bonePoint(d.rig, 'head', 0.12, new Vector3());
    this.events.push({ type: 'dodge', attacker, defender: d, move: attacker.move, kind: def.def.kind, point: p.clone(), perfect });
  }

  private block(a: Fighter, d: Fighter, m: MoveDef, point: Vector3, dir: Vector3, thrown: WeaponDef | null = null) {
    if (!thrown) a.wasBlocked = true;
    // A heavy weapon smashes through a guard: it costs far more of it, and some of the
    // blow gets through the arms anyway.
    const weight = heavyBlow(m, thrown ?? a.weapon, false);
    d.guard -= m.guardDamage * (1 + 0.6 * weight);
    if (weight > 0) d.hp = Math.max(d.minHp, Math.max(1, d.hp - m.damage * (thrown ?? a.weapon)!.damageMul * 0.18 * weight * (1 - d.stats.defense)));
    d.framesSinceBlock = 0;
    // Taking a heavy weapon (or a giant's fist) on the guard drives you back.
    const kb = thrown ? m.knockback : m.knockback * a.stats.knockbackMul * pushScale(a, d, m.weapon ? a.weapon : null);
    let guardBreak = false;
    // A parry: the guard came up just as it arrived, meeting it rather than absorbing
    // it — the attacker is knocked off balance, the defender's hardly checked.
    const parry = !thrown && m.weight !== 'heavy' && d.state === 'defend' && d.defense?.def.kind === 'block' && d.stateFrame <= DEFENSES.block.startup + parryWindow(d);
    // Your own parry, timed to it: a perfect parry — and a counter that goes in hard.
    const perfect = parry && d.perfectSerial >= 0 && d.perfectSerial === a.id * 100000 + a.attackSerial;
    if (perfect) {
      d.perfectCounter = true;
      d.perfectSerial = -1;
    }
    if (parry) {
      d.guard += m.guardDamage * 0.75;
      d.enterBlockstun(4);
      d.counter = { kind: 'block', frames: counterFrames(d, DEFENSES.block.counterWindow + 10 + (perfect ? 20 : 0)) };
    } else if (d.guard <= 0) {
      guardBreak = true;
      d.guard = d.stats.maxGuard * 0.5;
      d.enterGuardBreak(48);
      d.vel.addScaledVector(dir, kb * 0.9);
    } else {
      // (A jab on the gloves barely stops you; a big shot on them does.)
      d.enterBlockstun(Math.round(m.blockstun * (m.weight === 'light' ? 0.6 : 1)));
      d.vel.addScaledVector(dir, kb * 0.6);
      if (d.autoDefense) d.counter = { kind: 'block', frames: counterFrames(d, DEFENSES.block.counterWindow + m.blockstun) };
    }
    // Blocking an edge with your arms still costs you: a cut on the forearm.
    let wound: Wound | null = null;
    const w = m.weapon ? (thrown ?? a.weapon) : null;
    if (w && w.cut > 0) {
      const side = d.rig.foreArmL.pos.distanceToSquared(point) < d.rig.foreArmR.pos.distanceToSquared(point) ? 'foreArmL' : 'foreArmR';
      if (!d.isSevered(side)) {
        d.hp = Math.max(d.minHp, Math.max(1, d.hp - m.damage * w.damageMul * 0.15));
        wound = this.addWound(d, side, point, m.damage * w.damageMul * 0.4, w.cut);
      }
    }
    this.events.push({ type: 'block', attacker: a, defender: d, move: m, point: point.clone(), dir: dir.clone(), guardBreak, wound, parry, perfect });
    // Stopped by the guard: a blade bites into the forearm, anything else bounces off.
    if (thrown) return;
    if (parry) {
      a.enterHitstun(16, 'stagger', 0.7);
      a.vel.addScaledVector(dir, -0.6);
      return;
    }
    if (wound) a.impact('stick', 6, 11);
    else a.impact('rebound', 2, m.weapon ? 11 : 8);
  }

  private hit(a: Fighter, d: Fighter, m: MoveDef, point: Vector3, dir: Vector3, zone: HurtZone, bone: BoneName, power = 1, haft = false, thrown: WeaponDef | null = null, swing?: Vector3) {
    // (A thrown weapon is no longer in the thrower's hand.)
    const held = thrown ?? a.weapon;
    // Caught on the haft: a blunt knock, not a cut.
    const w = m.weapon && !haft ? held : null;
    const caughtInStartup = d.state === 'attack' && !!d.move && d.stateFrame < d.move.startup;
    const counter = caughtInStartup || (!thrown && a.isCounterAttack);
    const armor = d.state === 'attack' && d.move?.armor;
    // A big, hard man walks through a jab: it doesn't stop what he's throwing.
    const tough = d.state === 'attack' && !!d.move && !d.move.noHit && d.stats.staggerResist >= 0.4;
    const armored = m.weight === 'light' && ((!!armor && d.stateFrame >= armor[0] && d.stateFrame < armor[1]) || tough);

    // A tired arm hits softer (nothing behind it).
    const behind = thrown ? 1 : 0.5 + 0.5 * a.swingStamina;
    // A heavy weapon's whole weight behind a committed swing hits like nothing else, and
    // armour stops less of it — the reward for getting a slow swing to land.
    const weight = heavyBlow(m, held, haft);
    const defense = d.stats.defense * (1 - 0.5 * weight);
    // (Off a perfect dodge, the counter goes in all the harder.)
    let dmg = m.damage * a.stats.damageMul * (counter ? (!thrown && a.isPerfectCounter ? 1.6 : 1.25) : 1) * (1 - defense) * behind;
    if (armored) dmg *= 0.5;
    if (w) dmg *= w.damageMul;
    if (weight > 0) dmg *= (1 + 0.7 * weight) * (a.perks.has('heavyHands') ? 1 + 0.3 * weight : 1);
    if (w) dmg *= a.weaponDamageMul;
    // Skills.
    if (counter && a.perks.has('counterMaster')) dmg *= 1.2;
    if (a.perks.has('adrenaline') && a.hp < 0.3 * a.stats.maxHp) dmg *= 1.2;
    if (a.perks.has('executioner') && d.hp < 0.3 * d.stats.maxHp) dmg *= 1.3;
    // (How much of the swing is behind it matters more the heavier it is: caught early
    // it's a shove, caught at full speed it's devastating.)
    if (m.weapon) dmg *= Math.min(1, power) ** (1 + weight) * (haft ? 0.45 : 1);
    d.hp = Math.max(d.minHp, d.hp - dmg);
    // Last Stand: the blow that would have put you away leaves you on your feet, just.
    if (d.hp <= 0 && d.minHp <= 0 && this.oncePerRound(d, 'lastStand')) {
      d.hp = 1;
      this.events.push({ type: 'perk', f: d, perk: 'lastStand', point: point.clone() });
    }
    // Bloodlust: every hit you land feeds you.
    if (a.alive && a.perks.has('bloodlust')) a.hp = Math.min(a.stats.maxHp, a.hp + 0.03 * a.stats.maxHp);
    // Body shots empty the tank.
    d.stamina = Math.max(0, d.stamina - (zone === 'abdomen' ? 0.09 : zone === 'chest' ? 0.04 : 0.02) * Math.min(2, dmg / 8));
    d.framesSinceHit = 0;
    a.framesSinceLanded = 0;
    const comboing = d.state === 'hitstun' || d.state === 'guardbreak';
    a.combo = comboing ? a.combo + 1 : 1;
    d.poise -= behind * m.poiseDamage * (1 - d.stats.staggerResist) * (counter ? 1.3 : 1) * (w?.edge === 'blunt' ? 1.35 : 1) * (m.weapon ? Math.min(1, power) * (haft ? 0.5 : 1) : 1);
    d.buffer = null;
    d.counter = null;

    // The haft carries the weapon's mass too, just less of the swing's speed.
    // (A thrown weapon's push is already its own momentum against the body's mass.)
    const push = thrown ? 1 : pushScale(a, d, m.weapon ? held : null, power * (haft ? 0.6 : 1));
    const kb = thrown ? m.knockback : m.knockback * a.stats.knockbackMul * push;
    let ko = false;
    let knockdown = false;
    if (d.hp <= 0) {
      d.hp = 0;
      ko = true;
      d.enterKO();
      d.vel.addScaledVector(dir, kb + 1.5);
    } else if (armored) {
      d.vel.addScaledVector(dir, 0.3);
    } else if ((m.knockdown && !haft && power > 0.8) || d.poise <= 0 || d.isAirborne()) {
      // (Hit in mid-air there's no ground to take it on: down you go.)
      knockdown = true;
      d.enterKnockdown();
      d.vel.addScaledVector(dir, kb);
    } else {
      // How far it rocks them: the force of the blow, and who is hitting whom.
      const rock = (0.25 + dmg / 12) * Math.max(0.5, Math.min(1.5, a.scale / d.scale)) * (counter ? 1.15 : 1);
      d.enterHitstun(Math.round(m.hitstun * (counter ? 1.2 : 1)), reactionFor(m, zone, thrown ? undefined : a.aim?.id), rock);
      d.vel.addScaledVector(dir, kb);
    }
    // Where on the skull, and which way the weapon was travelling: chopped straight down
    // onto the crown it splits the head (or caves it in) — nobody gets up from that.
    // Only a cut across the neck takes the head off.
    const head = bone === 'head' && w && !haft ? this.headStrike(a, d, m, w, point, swing, power, !!thrown) : null;
    let fatal: Fatal | null = null;
    if (head?.fatal && d.minHp <= 0) {
      fatal = head.fatal;
      d.hp = 0;
      // Wells up out of the top of the head.
      d.wounds.push({ bone: 'head', local: [0, 0.29, 0.01], angle: 0, length: 0.12, bleed: 1, floor: 0.4 });
      if (!ko) {
        ko = true;
        knockdown = false;
        d.enterKO();
        d.vel.addScaledVector(dir, 0.6);
      }
    }
    // Edges cut (and keep bleeding); heavy edges can take a limb off.
    const wound = w && w.cut > 0 && !d.isSevered(bone) ? this.addWound(d, bone, point, dmg, w.cut) : null;
    let sever: BoneName | null = null;
    const at = SEVER_AT[bone];
    if (w && at && canSever(w, at) && d.minHp <= 0 && !d.isSevered(at) && !fatal && (at !== 'head' || head?.neck)) {
      const dealt = (d.limbDamage[at] ?? 0) + dmg * w.cleave * (m.weight === 'heavy' ? 1.3 : 1);
      d.limbDamage[at] = dealt;
      // Your own limbs only come off with the blow that finishes you.
      const allowed = d.team !== 'player' || ko;
      const tough = (LIMB_TOUGHNESS[at] ?? 30) * d.scale ** 1.5;
      if (allowed && (dealt >= tough || (ko && w.cleave >= 0.45 && this.rng.chance(0.65)))) sever = at;
    }
    if (sever) {
      this.sever(d, sever);
      // Losing the head or a leg ends the fight.
      if (!ko && (sever === 'head' || sever.startsWith('thigh') || sever.startsWith('shin'))) {
        d.hp = 0;
        ko = true;
        knockdown = false;
        d.enterKO();
        d.vel.addScaledVector(dir, 1);
      }
    }
    // A glancing edge takes a piece with it: an ear, a flap of scalp, a chunk of flesh.
    let tear: Tear | null = null;
    if (w && GORE[w.id].tear && !sever && !fatal && !d.isSevered(bone)) {
      const bite = dmg * w.cut * (0.6 + 0.4 * w.cleave);
      const piece = bone === 'head' ? (head?.piece ?? null) : 'flesh';
      const odds = head?.glancing ? 0.85 : Math.min(0.5, (bite - 8) / 24);
      if (piece && !d.torn.has(piece === 'flesh' ? '' : piece) && odds > 0 && this.rng.chance(odds)) {
        tear = this.tearOff(d, bone, piece, point, dir, bite);
      }
    }
    if (ko) this.dropWeapon(d);
    // Second Wind: knocked low, something comes back.
    if (!ko && d.alive && d.hp < 0.25 * d.stats.maxHp && this.oncePerRound(d, 'secondWind')) {
      d.hp = Math.min(d.stats.maxHp, d.hp + 0.35 * d.stats.maxHp);
      d.stamina = Math.min(1, d.stamina + 0.4);
      this.events.push({ type: 'perk', f: d, perk: 'secondWind', point: point.clone() });
    }
    // The strike stops at the body — unless it cleaved clean through, or the blow
    // carried them off their feet. Edges bite in and have to be wrenched free; fists,
    // feet and blunt weapons rebound.
    if (!sever && !thrown) {
      if (w && w.cut > 0) {
        const hold = Math.round(w.bite * (m.kind === 'hook' ? 0.6 : 1) * (ko ? 0.6 : 1));
        a.impact('stick', Math.max(4, hold), m.weight === 'heavy' ? 16 : 12);
        // The blade holds them: they don't fly off it.
        d.vel.multiplyScalar(0.4);
      } else if (!knockdown && !ko) {
        a.impact('rebound', m.weapon ? 3 : 2, m.weapon ? 11 : m.limb.startsWith('foot') ? 10 : 8);
      }
    }
    this.events.push({
      type: 'hit',
      attacker: a,
      defender: d,
      move: m,
      point: point.clone(),
      dir: dir.clone(),
      zone,
      damage: dmg,
      counter,
      armored,
      knockdown,
      ko,
      combo: a.combo,
      bone,
      weapon: w,
      push,
      thrown: !!thrown,
      wound,
      sever,
      fatal,
      tear,
    });
  }

  /**
   * Reads a weapon arriving at the head: from above or across, down the middle or off
   * to one side, and what that does. `n` is where on the skull it met (unit, head frame,
   * from the centre), `v` the way it was travelling.
   */
  private headStrike(a: Fighter, d: Fighter, m: MoveDef, w: WeaponDef, point: Vector3, swing: Vector3 | undefined, power: number, thrown: boolean) {
    const inv = d.rig.head.rot.clone().invert();
    const centre = bonePoint(d.rig, 'head', HEAD_CENTRE, _hc);
    // Where the edge passes the skull: the nearest point on the cutting part of the
    // weapon to the middle of the head (a fast swing is already deep in by the time it's
    // caught, so where it first touched says less than the line it's cutting along).
    const near = thrown ? point.clone() : nearestOnEdge(a, w, centre);
    const o = near.sub(centre).applyQuaternion(inv).divideScalar(d.scale);
    // (Not tracked this frame: go by the strike itself.)
    const v = swing ? swing.clone() : DOWNWARD.has(m.id) ? new Vector3(0, -1, 0) : new Vector3(d.pos.x - point.x, 0, d.pos.z - point.z);
    if (v.lengthSq() < 1e-8) v.set(0, -1, 0);
    v.normalize().applyQuaternion(inv);
    const down = -v.y;
    // Landing on the crown, anywhere across the top of the skull: whatever this weapon can
    // do to a skull (see GORE). Off the edge of it, a blade shears down the side of the
    // head and takes the ear.
    const middle = Math.abs(o.x) < 0.11;
    const full = power >= 0.75;
    let fatal: Fatal | null = null;
    // (Coming in at the jaw or below, it's into the neck, not the crown; caught right on
    // top of the skull, it needn't be coming straight down to go in.)
    const onCrown = (down > 0.6 && o.y > -0.03) || (down > 0.3 && o.y > 0.1);
    const gore = GORE[w.id];
    if (onCrown && middle && full) fatal = gore.crown;
    const glancing = !fatal && gore.tear && down > 0.4 && !middle;
    const side = o.x > 0 ? 'earL' : 'earR';
    const piece: TearPiece = (glancing || Math.abs(o.x) > 0.09) && !d.torn.has(side) ? side : o.y > 0.08 ? 'scalp' : 'cheek';
    // Across the neck (at the jaw or below), level enough to go through it rather than
    // into the skull.
    const neck = Math.abs(down) < 0.65 && o.y < -0.02;
    return { fatal, glancing, piece, neck };
  }

  /** A piece comes away (an ear, scalp, a chunk of muscle): it flies off, a raw gouge is left. */
  private tearOff(d: Fighter, bone: BoneName, piece: TearPiece, point: Vector3, dir: Vector3, bite: number): Tear {
    if (piece !== 'flesh') d.torn.add(piece);
    const x = d.rig[bone];
    const local = point.clone().sub(x.pos).applyQuaternion(x.rot.clone().invert()).divideScalar(d.scale);
    const size = (piece === 'scalp' ? 0.09 : piece === 'cheek' ? 0.06 : piece === 'flesh' ? Math.min(0.1, 0.04 + bite * 0.002) : 0.05) * d.scale;
    const fly = dir.clone().multiplyScalar(this.rng.range(1.5, 3)).add(new Vector3(this.rng.range(-0.6, 0.6), this.rng.range(1.2, 2.4), this.rng.range(-0.6, 0.6)));
    return { piece, bone, local: [local.x, local.y, local.z], point: point.clone(), vel: fly, size };
  }

  // ---------------------------------------------------------------------------
  // Weapons, wounds, dismemberment
  // ---------------------------------------------------------------------------

  /** Opens a lasting cut where the blow landed. */
  private addWound(d: Fighter, bone: BoneName, point: Vector3, dmg: number, cut: number): Wound {
    const x = d.rig[bone];
    const local = point.clone().sub(x.pos).applyQuaternion(x.rot.clone().invert()).divideScalar(d.scale);
    const bleed = Math.min(1, Math.max(0.15, cut * dmg * 0.06));
    const wound: Wound = {
      bone,
      local: [local.x, local.y, local.z],
      angle: this.rng.range(-0.9, 0.9),
      length: Math.min(0.2, 0.05 + dmg * 0.006) * (0.7 + cut * 0.4),
      bleed,
      floor: bleed * 0.25,
    };
    d.wounds.push(wound);
    if (d.wounds.length > 16) d.wounds.splice(d.wounds.findIndex((w) => !w.stump), 1);
    return wound;
  }

  /** Cuts a limb off at `bone` (the ragdoll lets it go; the stump bleeds hard). */
  private sever(d: Fighter, bone: BoneName) {
    for (const b of limbBones(bone)) d.severed.add(b);
    const parent: BoneName =
      bone === 'head' ? 'chest' : bone === 'foreArmL' ? 'upperArmL' : bone === 'foreArmR' ? 'upperArmR' : bone === 'shinL' ? 'thighL' : bone === 'shinR' ? 'thighR' : bone.startsWith('thigh') ? 'pelvis' : 'chest';
    // The joint, in the parent's frame (authored scale).
    const o = SKELETON[bone].offset;
    const stump: Wound = { bone: parent, local: [o[0], o[1], o[2]], angle: 0, length: 0, bleed: 1, floor: 0.3, stump: bone };
    d.wounds.push(stump);
    for (const w of d.wounds) if (limbBones(bone).includes(w.bone)) w.bleed = w.floor = 0;
    // No right hand: the weapon falls. No left hand: a two-hander can't be held either.
    if (bone === 'foreArmR' || bone === 'upperArmR' || (d.weapon?.style === 'twoHand' && (bone === 'foreArmL' || bone === 'upperArmL'))) this.dropWeapon(d);
  }

  /** Bleeding: every open cut drains a little health; enough of it and they go down. */
  private bleed(f: Fighter) {
    if (!f.wounds.length) return;
    let rate = 0;
    for (const w of f.wounds) {
      w.bleed = Math.max(w.floor, w.bleed * 0.9993);
      rate += w.bleed;
    }
    if (!f.alive || rate <= 0) return;
    if (f.perks.has('thickBlood')) rate *= 0.4;
    f.hp = Math.max(f.minHp, f.hp - rate * BLEED_DPS * DT);
    if (f.hp <= 0) {
      f.hp = 0;
      f.enterKO();
      this.dropWeapon(f);
      this.events.push({ type: 'bleedout', f });
    }
  }

  /** Puts a weapon on the floor. */
  addDrop(weapon: WeaponDef, x: number, z: number, yaw = 0, from?: Vector3): Drop {
    const p = new Vector3(x, 0, z);
    this.walkable.resolve(p, 0.25);
    const drop: Drop = { id: ++this.dropSerial, weapon, pos: p, yaw, from: from?.clone() };
    this.drops.push(drop);
    this.events.push({ type: 'drop', drop });
    return drop;
  }

  /** Lets go of the weapon in hand (it lands by the rear hand). */
  dropWeapon(f: Fighter) {
    if (!f.weapon) return;
    const at = fistPoint(f.rig, 'R', new Vector3());
    const w = f.weapon;
    f.weapon = null;
    // It falls from the hand: a little forward of where it was let go.
    this.addDrop(w, at.x + f.forward.x * 0.15, at.z + f.forward.z * 0.15, f.yaw + 1.2, at);
  }

  /**
   * Leaving the ground: the horizontal speed is set now and can't change until landing
   * (aimed to come down just short of the target, never past it). Already moving
   * through the air: carry on along it.
   */
  private advanceAir(f: Fighter, m: MoveDef) {
    const a = m.air!;
    if (f.stateFrame === a.from) {
      let d = (m.lunge?.distance ?? 0) * f.scale;
      const t = f.target && f.target.alive ? f.target : null;
      if (t && d > 0) d = Math.min(d, Math.max(0, f.distanceTo(t) - (LUNGE_STOP * (f.scale + t.scale)) / 2));
      f.airStep.copy(f.forward).multiplyScalar(d / (a.to - a.from));
    }
    if (f.stateFrame >= a.from && f.stateFrame < a.to) {
      // Flying into someone, you stop against them: bodies don't pass through each other.
      const t = f.target && f.target.alive ? f.target : null;
      if (t && f.airStep.dot(_v.set(t.pos.x - f.pos.x, 0, t.pos.z - f.pos.z)) > 0) {
        const room = f.distanceTo(t) - (LUNGE_STOP * (f.scale + t.scale)) / 2;
        if (room <= 0) f.airStep.set(0, 0, 0);
        else if (f.airStep.length() > room) f.airStep.setLength(room);
      }
      f.pos.add(f.airStep);
    }
  }

  /**
   * Letting the weapon go. A practised thrower aims for the chest on the flatter arc
   * (leading a moving target a little), and judges the spin so the edge comes round to
   * the front at the distance thrown — if the target is still there when it arrives.
   * Tired arms throw wilder.
   */
  private release(f: Fighter, m: MoveDef) {
    const spec = m.throw!;
    let w: WeaponDef | null;
    if (spec.ammo) {
      if (!f.ammo || f.ammo.count <= 0) return;
      w = f.ammo.weapon;
      f.ammo.count--;
    } else {
      w = f.weapon;
      if (!w || f.isSevered('foreArmR')) return;
      f.weapon = null;
    }
    const hand = fistPoint(f.rig, m.limb === 'handL' ? 'L' : 'R', new Vector3());
    const t = f.target && f.target.alive ? f.target : null;
    const aim = t ? t.rig.chest.pos.clone() : hand.clone().addScaledVector(f.forward, 6);
    const flat0 = new Vector3(aim.x - hand.x, 0, aim.z - hand.z);
    if (flat0.lengthSq() < 1e-6) flat0.copy(f.forward);
    flat0.normalize();
    // A spinning throw leaves the hand with the haft upright (its mass up above the
    // grip); a knife leaves pointing where it's going.
    const spins = spec.spin > 0;
    const dir0 = spins ? _up.clone() : flat0.clone();
    const com = centreOfMass(w);
    const pos = hand.clone().addScaledVector(dir0, com * f.scale);
    // Longer arms whip faster.
    const speed = spec.speed * Math.sqrt(f.scale);
    let shot = aimBallistic(pos, aim, speed);
    if (t && shot) {
      aim.addScaledVector(t.vel, shot.time * 0.5);
      shot = aimBallistic(pos, aim, speed) ?? shot;
    }
    const vel = shot?.vel ?? flat0.clone().multiplyScalar(speed * 0.9).setY(speed * 0.3);
    const wild = 0.02 + 0.04 * (1 - f.stamina);
    vel.applyAxisAngle(_up, this.rng.range(-wild, wild));
    vel.y += this.rng.range(-wild, wild) * speed;
    const flat = new Vector3(vel.x, 0, vel.z).normalize();
    // End over end, the head coming over the top.
    const axis = new Vector3().crossVectors(_up, flat).normalize();
    let omega = 0;
    if (spins) {
      // Whole turns plus a little more, so it arrives with the head just past the top,
      // leading — edge first, the handle trailing.
      const time = shot?.time ?? 0.5;
      const turns = Math.max(1, Math.round(spec.spin * time));
      omega = (Math.PI * 2 * turns + 0.45) / Math.max(0.15, time);
    }
    if (!spins) dir0.copy(vel).normalize();
    const p: Projectile = { id: ++this.projSerial, serial: -1000 - this.projSerial, weapon: w, owner: f, scale: f.scale, pos, vel, axis, omega, angle: 0, dir0, com, live: true, age: 0 };
    this.projectiles.push(p);
    this.events.push({ type: 'throw', f, projectile: p });
  }

  /**
   * Weapons in flight: gravity and spin, in sub-steps so nothing fast skips through a
   * body. What it meets first stops it — a person (cut by the edge or the point only if
   * that's what's leading at the moment it arrives; otherwise a knock from the haft or
   * the back of the head), a guard, a wall, the floor. Once it's down it's a weapon on
   * the floor like any other, for whoever gets to it.
   */
  private stepProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age++;
      const n = substeps(p);
      let landed = false;
      for (let k = 0; k < n && !landed; k++) {
        integrate(p, DT / n);
        const { points, at } = projectilePoints(p);
        if (p.live) {
          for (const d of this.opponents(p.owner)) {
            if (!d.alive || d.state === 'knockdown' || d.state === 'ko' || d.state === 'getup' || p.passed?.has(d)) continue;
            const c = overlapBody(points, p.weapon.radius * p.scale, d, at);
            if (c) {
              this.projectileStrike(p, d, c, at[c.index], points[c.index]);
              break;
            }
          }
        }
        // Walls and props.
        const w = this.walkable;
        _probe.copy(p.pos);
        if (!w.isWalkable(p.pos.x, p.pos.z) || w.solidAt?.(_probe, 0.05)) {
          const speed = p.vel.length();
          if (p.live || speed > 2) this.events.push({ type: 'thud', projectile: p, point: p.pos.clone(), speed, wall: true });
          p.live = false;
          // It rebounds off, losing most of its speed.
          p.vel.set(-p.vel.x * 0.2, Math.min(p.vel.y, 0), -p.vel.z * 0.2);
          p.pos.addScaledVector(p.vel, DT / n);
          w.resolve(p.pos, 0.1);
          p.omega *= 0.4;
        }
        // The floor.
        let low = Infinity;
        for (const q of points) low = Math.min(low, q.y);
        if (low <= 0.01 && p.vel.y < 0) {
          const speed = p.vel.length();
          if (speed > 3 && p.age < 600) {
            this.events.push({ type: 'thud', projectile: p, point: p.pos.clone(), speed, wall: false });
            p.live = false;
            p.pos.y += -low + 0.01;
            p.vel.set(p.vel.x * 0.45, -p.vel.y * 0.25, p.vel.z * 0.45);
            p.omega *= 0.4;
          } else {
            landed = true;
          }
        }
      }
      if (landed || p.age > 900) {
        this.projectiles.splice(i, 1);
        const dir = projectileDir(p);
        if (p.vel.length() > 0.5 && p.age <= 900) this.events.push({ type: 'thud', projectile: p, point: p.pos.clone(), speed: p.vel.length(), wall: false });
        this.addDrop(p.weapon, p.pos.x, p.pos.z, Math.atan2(dir.x, dir.z));
      }
    }
  }

  /** A weapon in flight arriving at a person. */
  private projectileStrike(p: Projectile, d: Fighter, c: { point: Vector3; zone: HurtZone; bone: BoneName }, along: number, part: Vector3) {
    const w = p.weapon;
    // How fast the part of the weapon that arrived was moving (flight plus spin).
    const vp = pointVelocity(p, part, new Vector3());
    const speed = vp.length();
    const dir = new Vector3(vp.x, 0, vp.z);
    if (dir.lengthSq() < 1e-6) dir.set(p.vel.x, 0, p.vel.z);
    dir.normalize();
    const head = along >= w.strikeFrom - 0.02;
    // What's leading: for a spinning weapon, the edge (on the side the head turns
    // toward); for one flying straight, the point.
    let leading: boolean;
    if (p.omega === 0) leading = along > w.length * 0.6 && projectileDir(p).dot(_v.copy(vp).normalize()) > 0.7;
    else {
      const edge = _e.crossVectors(p.axis, projectileDir(p)).normalize();
      leading = edge.dot(_v.copy(vp).normalize()) > 0.35;
    }
    const cuts = w.edge === 'blade' ? head && leading : head;
    const mass = w.mass * p.scale ** 3;
    // Kinetic energy does the damage; momentum against the body's mass does the pushing.
    // (Damage is reckoned at a man's size, as it is for blows struck in the hand — a
    // giant's own strength is in its stats.)
    const v1 = speed / Math.sqrt(p.scale);
    const dmg = (0.5 * w.mass * v1 * v1) / 18;
    const height: Height = c.zone === 'head' ? 'high' : c.zone === 'legs' ? 'low' : 'mid';
    const m: MoveDef = {
      id: 'thrown', name: 'Thrown ' + w.name, startup: 1, active: 1, recovery: 1,
      limb: 'handR', height, kind: 'straight', weight: dmg > 12 ? 'heavy' : dmg > 5 ? 'medium' : 'light',
      damage: dmg, guardDamage: dmg * 1.6, poiseDamage: dmg * 3.2, hitstun: Math.round(12 + dmg * 0.9), blockstun: Math.round(8 + dmg * 0.5),
      // All its momentum goes into the body (it doesn't fly on through): Δv = p / (M + m).
      knockback: (mass * speed) / (75 * d.scale ** 3 + mass), impulse: Math.min(60, mass * speed * 0.25), lift: 0.05,
      hitstop: Math.round(4 + Math.min(8, dmg / 3)), shake: Math.min(0.5, 0.08 + dmg / 50), radius: 0, reach: 0,
      blockable: true, weapon: true, keys: [],
    };
    if (d.state === 'defend' && d.defense) {
      const def = d.defense.def;
      // Slipped, ducked or slid out of its way: it flies on past.
      const inPosition = d.defense.phase !== 'startup' || d.stateFrame >= def.startup - 1;
      if (inPosition && def.evades.includes(height)) {
        (p.passed ??= new Set()).add(d);
        this.markDodge(d, null, c.point);
        return;
      }
    }
    p.live = false;
    // Bounces back off whatever it hit, tumbling.
    p.vel.multiplyScalar(-0.18);
    p.omega *= 0.3;
    if (d.state === 'defend' && d.defense) {
      const def = d.defense.def;
      const facing = d.forward.dot(dir) < -0.3;
      if (def.blocks.includes(height) && facing && canGuard(d)) {
        this.block(p.owner, d, m, c.point, dir, w);
        return;
      }
    }
    if (d.state === 'blockstun' && height !== 'low' && canGuard(d) && d.forward.dot(dir) < -0.3) {
      this.block(p.owner, d, m, c.point, dir, w);
      return;
    }
    this.hit(p.owner, d, m, c.point, dir, c.zone, c.bone, 1, !cuts, w, p.vel.clone().normalize());
  }

  /** Grab (or swap for) the nearest weapon in reach; with none in reach, drop yours. */
  private tryPickup(f: Fighter) {
    if (f.pickupRequest <= 0) return;
    // Already going down for one: a second press doesn't queue another grab (or a drop).
    if (f.state === 'pickup') {
      f.pickupRequest = 0;
      return;
    }
    f.pickupRequest--;
    if (!f.free || !f.alive || f.isSevered('foreArmR')) return;
    f.pickupRequest = 0;
    let best: Drop | null = null;
    let bestD = 1.15 * f.scale;
    let twoHandOnly = false;
    for (const d of this.drops) {
      const dist = Math.hypot(d.pos.x - f.pos.x, d.pos.z - f.pos.z);
      if (dist >= bestD) continue;
      // (The AI doesn't go for what it can't swing.)
      if (f.team !== 'player' && heft(d.weapon, f.scale) > MAX_HEFT) continue;
      // Two-handed weapons need both hands.
      if (d.weapon.style === 'twoHand' && f.isSevered('foreArmL')) {
        twoHandOnly = true;
        continue;
      }
      bestD = dist;
      best = d;
    }
    if (!best) {
      if (f.team === 'player' && !twoHandOnly) this.dropWeapon(f);
      return;
    }
    // Going down for it takes time — more the heavier it is for you.
    f.startPickup(best, Math.round(18 + 7 * heft(best.weapon, f.scale)));
  }

  /** Bending down for a weapon: step in to it, turn to it, close the hands, rise. */
  private advancePickup(f: Fighter) {
    const t = f.pickupTarget;
    if (t) {
      const dx = t.pos.x - f.pos.x;
      const dz = t.pos.z - f.pos.z;
      const d = Math.hypot(dx, dz);
      if (f.stateFrame < t.grabAt) {
        // Face it, and step in if it's beyond arm's reach of a squat.
        f.yaw = approachAngle(f.yaw, Math.atan2(dx, dz), 0.12);
        const near = 0.45 * f.scale;
        if (d > near) {
          const k = Math.min(0.045 * f.scale, d - near) / d;
          f.pos.x += dx * k;
          f.pos.z += dz * k;
        }
      }
      if (f.stateFrame === t.grabAt) {
        const drop = this.drops.find((x) => x.pos === t.pos && x.weapon === t.weapon);
        // Still in reach of the hands, and still with the hands it needs.
        const reach = d < 0.85 * f.scale;
        const hands = !f.isSevered('foreArmR') && !(t.weapon.style === 'twoHand' && f.isSevered('foreArmL'));
        if (drop && reach && hands) {
          this.drops.splice(this.drops.indexOf(drop), 1);
          const old = f.weapon;
          f.weapon = drop.weapon;
          this.events.push({ type: 'pickup', f, drop });
          if (old) this.addDrop(old, drop.pos.x, drop.pos.z, drop.yaw + 0.8, fistPoint(f.rig, 'R', new Vector3()));
        }
      }
    }
    if (f.stateFrame >= f.stunFrames) f.enterLocomotion(6);
  }
}

/** Which side of the defender a strike arrives from: +1 their right, -1 their left. */
function arrivesFrom(m: MoveDef): number {
  if (m.weapon) return m.id === 'backslash' || m.id === 'sweepBack' ? 1 : m.id === 'slash' || m.id === 'sweep' ? -1 : 0;
  // Facing each other, the attacker's left side is the defender's right.
  return m.limb === 'handL' || m.limb === 'footL' ? 1 : -1;
}

/**
 * How the body reacts to where and how it was hit, like it does in real fights: a
 * straight snaps the head back, a hook whips it round away from the blow, an uppercut
 * throws the chin up, a body shot folds you, a liver shot caves in the right side.
 */
function reactionFor(m: MoveDef, zone: HurtZone, aimId?: string): PoseName {
  if (zone === 'legs') return 'hitLow';
  if (aimId === 'liver') return 'hitLiver';
  if (zone === 'abdomen' || (zone === 'chest' && m.height === 'mid')) return 'hitBody';
  if (zone === 'head') {
    if (m.kind === 'uppercut') return 'hitUpper';
    const side = arrivesFrom(m);
    if ((m.kind === 'hook' || m.kind === 'kick') && side !== 0) return side > 0 ? 'hitHookL' : 'hitHookR';
  }
  return m.weight === 'heavy' ? 'stagger' : 'hitHigh';
}

export function strikePoint(f: Fighter, m: MoveDef, out: Vector3): Vector3 {
  switch (m.limb) {
    case 'handL':
      return fistPoint(f.rig, 'L', out);
    case 'handR':
      return fistPoint(f.rig, 'R', out);
    case 'footL':
      return footPoint(f.rig, 'L', out);
    case 'footR':
      return footPoint(f.rig, 'R', out);
  }
}

export interface HurtSphere {
  zone: HurtZone;
  center: Vector3;
  r: number;
  bone?: BoneName;
}

export function hurtSpheres(d: Fighter, height: Height): HurtSphere[] {
  const spheres = hurtSpheresUnscaled(d, height).filter((h) => !h.bone || !d.isSevered(h.bone));
  if (d.scale !== 1) for (const h of spheres) h.r *= d.scale;
  return spheres;
}

function hurtSpheresUnscaled(d: Fighter, height: Height): HurtSphere[] {
  const rig = d.rig;
  if (height === 'high') {
    return [
      { zone: 'head', bone: 'head', center: bonePoint(rig, 'head', 0.13, new Vector3()), r: 0.16 },
      { zone: 'chest', bone: 'chest', center: bonePoint(rig, 'chest', 0.2, new Vector3()), r: 0.17 },
    ];
  }
  if (height === 'mid') {
    return [
      { zone: 'chest', bone: 'chest', center: bonePoint(rig, 'chest', 0.12, new Vector3()), r: 0.2 },
      { zone: 'abdomen', bone: 'abdomen', center: bonePoint(rig, 'abdomen', 0.1, new Vector3()), r: 0.19 },
    ];
  }
  return [
    { zone: 'legs', bone: 'shinL', center: bonePoint(rig, 'shinL', 0.22, new Vector3()), r: 0.11 },
    { zone: 'legs', bone: 'shinR', center: bonePoint(rig, 'shinR', 0.22, new Vector3()), r: 0.11 },
    { zone: 'legs', bone: 'thighL', center: bonePoint(rig, 'thighL', 0.25, new Vector3()), r: 0.12 },
    { zone: 'legs', bone: 'thighR', center: bonePoint(rig, 'thighR', 0.25, new Vector3()), r: 0.12 },
  ];
}

/** The whole body, limb by limb (what a weapon can catch). */
export function bodySpheres(d: Fighter): HurtSphere[] {
  const rig = d.rig;
  const s = (zone: HurtZone, bone: BoneName, t: number, r: number): HurtSphere => ({ zone, bone, center: bonePoint(rig, bone, t, new Vector3()), r: r * d.scale });
  const out = [
    s('head', 'head', 0.13, 0.15),
    s('chest', 'chest', 0.16, 0.19),
    s('abdomen', 'abdomen', 0.1, 0.17),
    s('abdomen', 'pelvis', 0.02, 0.15),
    s('chest', 'upperArmL', 0.15, 0.075),
    s('chest', 'upperArmR', 0.15, 0.075),
    s('chest', 'foreArmL', 0.14, 0.07),
    s('chest', 'foreArmR', 0.14, 0.07),
    s('legs', 'thighL', 0.22, 0.1),
    s('legs', 'thighR', 0.22, 0.1),
    s('legs', 'shinL', 0.22, 0.085),
    s('legs', 'shinR', 0.22, 0.085),
  ];
  return out.filter((h) => !d.isSevered(h.bone!));
}

/** Deepest contact between any of `points` (radius r) and the defender's body. */
/**
 * Contact between a weapon (sample points; `reach` = distance of each from the grip) and
 * the defender's body. The part furthest out along the weapon that touches wins — in a
 * swing or a thrust the head / point arrives first.
 */
function overlapBody(points: Vector3[], r: number, d: Fighter, reach?: number[]): { point: Vector3; zone: HurtZone; bone: BoneName; index: number } | null {
  let best: { point: Vector3; zone: HurtZone; bone: BoneName; index: number } | null = null;
  let bestKey = -Infinity;
  const spheres = bodySpheres(d);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    for (const s of spheres) {
      const depth = r + s.r - p.distanceTo(s.center);
      if (depth <= 0) continue;
      const key = (reach?.[i] ?? 0) * 100 + depth;
      if (key <= bestKey) continue;
      bestKey = key;
      _c.subVectors(p, s.center);
      if (_c.lengthSq() < 1e-8) _c.set(0, 0, 1);
      best = { point: s.center.clone().addScaledVector(_c.normalize(), s.r), zone: s.zone, bone: s.bone!, index: i };
    }
  }
  return best;
}

function overlap(strike: Vector3, radius: number, d: Fighter, height: Height): { point: Vector3; zone: HurtZone; bone: BoneName } | null {
  for (const s of hurtSpheres(d, height)) {
    const dist = strike.distanceTo(s.center);
    if (dist < radius + s.r) {
      _c.subVectors(strike, s.center);
      if (_c.lengthSq() < 1e-8) _c.set(0, 0, 1);
      const point = s.center.clone().addScaledVector(_c.normalize(), s.r);
      return { point, zone: s.zone, bone: s.bone ?? 'chest' };
    }
  }
  return null;
}

/** Frames after the guard comes up that meeting a strike still parries it. */
function parryWindow(f: Fighter): number {
  return PARRY_WINDOW + (f.perks.has('perfectTiming') ? PERFECT_TIMING_FRAMES : 0);
}

/** A counter window, stretched by Counter Master. */
function counterFrames(f: Fighter, frames: number): number {
  return f.perks.has('counterMaster') ? Math.round(frames * 1.5) : frames;
}

/**
 * How much of a heavy weapon's weight is behind this blow (0..1): a committed (heavy)
 * swing with a battle axe or a sledgehammer is all of it; with a bat, a little; a quick
 * strike, or one caught on the haft, none.
 */
function heavyBlow(m: MoveDef, w: WeaponDef | null, haft: boolean): number {
  if (!m.weapon || !w || haft || m.weight !== 'heavy') return 0;
  return Math.min(1, w.mass / 2.6);
}

/** Whether this weapon can take off the limb (or head) that comes off at `at`. */
function canSever(w: WeaponDef, at: BoneName): boolean {
  const g = GORE[w.id];
  if (at === 'head') return g.decap;
  if (at === 'foreArmL' || at === 'foreArmR') return g.sever !== 'none';
  return g.sever === 'all';
}

/** The point on the cutting part of a held weapon nearest to `p`. */
function nearestOnEdge(a: Fighter, w: WeaponDef, p: Vector3): Vector3 {
  const pts = bladePoints(a, w);
  const offs = sampleOffsets(w);
  const best = new Vector3();
  let bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    if (offs[i + 1] < w.strikeFrom) continue;
    const q = closestOnSegment(pts[i], pts[i + 1], p, _seg);
    const dd = q.distanceToSquared(p);
    if (dd < bestD) {
      bestD = dd;
      best.copy(q);
    }
  }
  return bestD < Infinity ? best : pts[pts.length - 1].clone();
}

function closestOnSegment(a: Vector3, b: Vector3, p: Vector3, out: Vector3): Vector3 {
  const ab = _ab.subVectors(b, a);
  const l2 = ab.lengthSq();
  const t = l2 > 1e-10 ? Math.max(0, Math.min(1, _ap.subVectors(p, a).dot(ab) / l2)) : 0;
  return out.copy(a).addScaledVector(ab, t);
}
const _seg = new Vector3();
const _ab = new Vector3();
const _ap = new Vector3();
