import type { PerkId } from './perks';
import { Quaternion, Vector3 } from 'three';
import { Animator, type TrackKey } from '../body/animator';
import { Footwork, type FootworkStyle } from '../body/footwork';
import { IdleBehavior, type IdleStyle } from '../body/idle';
import { makeProfile, type MotionMods, type MotionProfile, smoothProfile, targetProfile, type Zone, ZONE_RANGES } from '../body/motion';
import { getPose, GUARD, POSE_SPECS, type PoseName } from '../body/poses';
import {
  forwardKinematics,
  blendPose,
  copyPose,
  makePose,
  makeRig,
  type PoseSpec,
  resolvePose,
  type Rig,
  type BoneName,
  DEFAULT_BLADE,
  FIST_OFFSET,
  SKELETON,
  slerpDir,
  solveArm,
  solveLegs,
} from '../body/skeleton';
import { bladeFrame, gripSlide, heft, sampleOffsets, SECOND_HAND, WEAPON_MOVES, type WeaponDef, weaponTempo, type Wound } from './weapons';
import { bodyCapsules, type Capsule, closestOnSegment } from './bodyShapes';

export interface FighterStyle {
  footwork: FootworkStyle;
  idle: IdleStyle;
}

/** Light on the feet: quick low steps, bouncy rhythm, frequent feints. */
export const OUTFIGHTER_STYLE: FighterStyle = {
  footwork: { stanceWidth: 1, stepFrames: 9, stepHeight: 0.045 },
  idle: {
    bounceHz: 1.9,
    bounceAmp: 0.03,
    swayAmp: 0.055,
    feintEvery: [1.1, 2.4],
    feintWeights: { jab: 4, shoulder: 3, level: 2, step: 2 },
    shuffleEvery: [0.6, 1.4],
    pawEvery: [0.7, 1.6],
    shoulderRoll: 0,
  },
};
import { angleDelta, clamp, type Ease, Rng } from './math';
import { type Aim, DEFENSES, type DefenseDef, type DefenseKind, type Height, markerFrame, type MoveDef } from './moves';

export type FighterState =
  | 'idle'
  | 'walk'
  | 'attack'
  | 'defend'
  | 'hitstun'
  | 'blockstun'
  | 'guardbreak'
  | 'knockdown'
  | 'getup'
  | 'ko'
  | 'celebrate'
  /** Bending down for a weapon on the floor (committed, and open to being hit). */
  | 'pickup';

/** Attack inputs: left/right punch, left/right kick. */
export type Button = 'lpunch' | 'rpunch' | 'lkick' | 'rkick';
export const BUTTONS: Button[] = ['lpunch', 'rpunch', 'lkick', 'rkick'];
export type Team = 'player' | 'enemy';

export interface FighterStats {
  maxHp: number;
  maxGuard: number;
  maxPoise: number;
  damageMul: number;
  /** Fraction of incoming damage ignored. */
  defense: number;
  /** Fraction of incoming poise damage ignored. */
  staggerResist: number;
  /** Added to strike radius / reach (fist cuffs). */
  reach: number;
  knockbackMul: number;
  walkSpeed: number;
}

export const DEFAULT_STATS: FighterStats = {
  maxHp: 100,
  maxGuard: 100,
  maxPoise: 100,
  damageMul: 1,
  defense: 0,
  staggerResist: 0,
  reach: 0,
  knockbackMul: 1,
  walkSpeed: 2.6,
};

export interface ActiveDefense {
  def: DefenseDef;
  /** Attack instance this defense is answering. */
  threatSerial: number;
  phase: 'startup' | 'active' | 'recovery';
  /** The attack actually reached us and was evaded / blocked. */
  success: boolean;
  side: 1 | -1;
}

export interface Counter {
  kind: DefenseKind;
  frames: number;
}

export const GETUP_FRAMES = 40;
export const KNOCKDOWN_FRAMES = 70;

let nextId = 1;

export class Fighter {
  readonly id = nextId++;
  readonly pos = new Vector3();
  /** Knockback / slide velocity on the ground plane (m/s). */
  readonly vel = new Vector3();
  /** Desired walk direction in world space (length 0..1). Set by input or AI. */
  readonly moveInput = new Vector3();
  /** Actual footwork velocity (m/s): walking, or momentum carried into a move. */
  readonly walkVel = new Vector3();
  yaw = 0;
  /** Uniform size (giant bosses ~1.7, imps ~0.75). Poses are authored at 1. */
  scale = 1;

  hp: number;
  guard: number;
  poise: number;

  state: FighterState = 'idle';
  stateFrame = 0;
  stunFrames = 0;

  move: MoveDef | null = null;
  /**
   * Set when a strike connects: it stops at the body (no passing through) and the
   * attack ends here — after the weapon is held / wrenched free, or the limb rebounds.
   */
  attackEnd = 0;
  /** The weapon is stuck in the opponent until this state frame. */
  stuckUntil = 0;
  private readonly impactPose = makePose();
  private readonly retractPose = makePose();
  private readonly reactPose = makePose();
  /** Head / chest pitch toward the opponent's face (smoothed; + = looking down). */
  private lookPitch = 0;
  /** Lean into a turn while running (smoothed roll; + = leaning right). */
  private bank = 0;
  private breathPhase = 0;
  /** Neck turn keeping the eyes on the opponent (smoothed). */
  private headTrack = 0;
  private turnRate = 0;
  attackSerial = 0;
  hitThisAttack = false;
  /** The attack was a counter (thrown from a counter window). */
  isCounterAttack = false;
  /** The counter window came from a perfect dodge (and this strike is that counter). */
  perfectCounter = false;
  isPerfectCounter = false;
  /** Target chosen for the current attack, and the height class it lands at. */
  aim: Aim | null = null;
  strikeHeight: Height = 'high';

  defense: ActiveDefense | null = null;
  counter: Counter | null = null;
  lastDefendedSerial = -1;
  defenseCooldown: Record<DefenseKind, number> = { block: 0, duck: 0, weave: 0, slide: 0 };
  /** Skills (from the shop) and the once-a-round ones already spent this round. */
  perks = new Set<PerkId>();
  perksUsed = new Set<PerkId>();
  /** Getting your breath back faster than normal (training, supplies). */
  staminaRegenMul = 1;
  /** Extra damage with a weapon in hand (supplies). */
  weaponDamageMul = 1;
  /** The current defence was yours (Q / E met a strike), not the automatic guard. */
  defenseManual = false;
  /** The strike your parry / dodge was timed perfectly to (-1: none). */
  perfectSerial = -1;
  /** The strike your last parry / dodge got you out of the way of (it was reaching you). */
  dodgedSerial = -1;
  weaveSide: 1 | -1 = 1;

  buffer: { button: Button; frames: number } | null = null;
  target: Fighter | null = null;
  combo = 0;
  framesSinceBlock = 999;
  framesSinceHit = 999;
  framesSinceLanded = 999;
  framesSinceDefend = 999;
  /** The last strike this fighter failed to read (automatic defense doesn't retry it). */
  misreadSerial = -1;
  /** Squared up to a target (soft lock-on, with hysteresis; maintained by the sim). */
  lockedOn = false;
  /** Health never drops below this (sparring partners can't be knocked out). */
  minHp = 0;
  /** Gas in the tank: 1 fresh, 0 exhausted. Strikes, defending, running and body shots
   * drain it; easing off brings it back. */
  stamina = 1;
  /** Frames left on a request to pick up / drop a weapon. */
  pickupRequest = 0;
  /** Throwing weapons carried on the belt (kunai), apart from whatever's in hand. */
  ammo: { weapon: WeaponDef; count: number } | null = null;
  /** In the air: the horizontal step per frame, fixed at take-off. */
  readonly airStep = new Vector3();
  /** Weapon in hand (null = fists). */
  weapon: WeaponDef | null = null;
  /** Lasting cuts (each keeps bleeding a little). */
  readonly wounds: Wound[] = [];
  /** Bones cut off (with everything below them). */
  readonly severed = new Set<BoneName>();
  /** Pieces torn away (an ear, scalp...): each only comes off once. */
  readonly torn = new Set<string>();
  /** Cleaving damage taken per limb (enough of it and the limb comes off). */
  readonly limbDamage: Partial<Record<BoneName, number>> = {};
  hitReaction: PoseName = 'hitHigh';

  /** Reads strikes coming in and reacts on its own (the player; enemies, by their skill). */
  autoDefense: boolean;
  /** How well this fighter reads strikes coming in (1 = the player's own reactions). */
  readSkill = 1;
  /** Same strike as last time, again and again: how many in a row (predictable). */
  repeatCount = 0;
  /** The last strike this fighter started. */
  lastMoveId = '';
  /** Frames since this fighter last started an attack. */
  sinceMoveStart = 999;
  /** How much was left in the tank when the current strike was thrown. */
  swingStamina = 1;
  /** The current strike landed on a guard. */
  wasBlocked = false;
  stats: FighterStats;

  readonly anim = new Animator();
  /** Final animated target pose (what hit detection and the ragdoll follow). */
  readonly pose = makePose();
  /** World-space joint transforms of `pose`. */
  readonly rig: Rig = makeRig();
  /** 0 = planted, 1 = stepping at full walk speed. Smoothed. */
  private moveBlend = 0;
  private readonly locoPose = makePose();
  private readonly layered = makePose();
  private breath = 0;
  readonly footwork: Footwork;
  readonly idle: IdleBehavior;
  /** Live, context-blended movement profile (see body/motion.ts). */
  readonly motion: MotionProfile = makeProfile();
  private readonly motionTarget: MotionProfile = makeProfile();
  /** Human-readable snapshot of the current motion context (debug panel). */
  readonly motionInfo = { zone: '', context: '', speed: 0, stride: 0, bounce: 0, guard: 0 };
  private readonly rng: Rng;

  constructor(
    readonly team: Team,
    public name: string,
    readonly moves: Record<string, MoveDef>,
    stats: Partial<FighterStats> = {},
    style: FighterStyle = OUTFIGHTER_STYLE,
  ) {
    this.stats = { ...DEFAULT_STATS, ...stats };
    this.rng = new Rng(this.id * 7919 + 13);
    this.anim.source = this.pose;
    this.footwork = new Footwork({ ...style.footwork });
    this.idle = new IdleBehavior({ ...style.idle }, this.rng);
    this.hp = this.stats.maxHp;
    this.guard = this.stats.maxGuard;
    this.poise = this.stats.maxPoise;
    this.autoDefense = team === 'player';
    this.anim.procedural(1);
  }

  get alive() {
    return this.state !== 'ko';
  }

  /** Can act freely (walk / start an attack / start a defense). */
  get free() {
    return this.state === 'idle' || this.state === 'walk';
  }

  get forward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Frames remaining until the current attack becomes active (negative once active). */
  get framesToActive(): number {
    return this.move ? this.move.startup - this.stateFrame : Infinity;
  }

  /** Off the ground in a jump or a flip. */
  isAirborne(): boolean {
    const a = this.state === 'attack' ? this.move?.air : undefined;
    return !!a && this.stateFrame >= a.from && this.stateFrame < a.to;
  }

  /** How high the jump has carried the body (m): a ballistic arc set by the flight time. */
  airHeight(): number {
    if (!this.isAirborne()) return 0;
    const a = this.move!.air!;
    const t = (a.to - a.from) / 60;
    const u = (this.stateFrame - a.from) / (a.to - a.from);
    return ((GRAVITY * t * t) / 2) * u * (1 - u);
  }

  inActiveFrames(): boolean {
    if (this.state !== 'attack' || !this.move || this.attackEnd || this.move.noHit) return false;
    const f = this.stateFrame;
    return f >= this.move.startup && f < this.move.startup + this.move.active;
  }

  /**
   * A weapon is solid for the whole forward swing — from leaving the chamber until
   * the follow-through runs out — not only in its "active" frames.
   */
  inWeaponContact(): boolean {
    const m = this.move;
    if (this.state !== 'attack' || !m?.weapon || !this.weapon || this.attackEnd || m.noHit) return false;
    const f = this.stateFrame;
    return f >= Math.floor(m.startup * 0.5) && f <= m.startup + m.active + Math.floor(m.recovery * 0.25);
  }

  /** How much of the swing's power is behind the weapon at this point of the arc (0..1). */
  swingPower(): number {
    const m = this.move;
    if (!m) return 0;
    const f = this.stateFrame;
    const from = Math.floor(m.startup * 0.5);
    if (f < m.startup) return 0.25 + 0.75 * ((f - from) / Math.max(1, m.startup - from)) ** 1.5;
    if (f < m.startup + m.active) return 1;
    return Math.max(0.15, 1 - (f - m.startup - m.active) / Math.max(1, m.recovery * 0.25));
  }

  /**
   * The strike met the body: it stops right there. 'stick' — an edge bites in and is
   * held, then wrenched free; 'rebound' — fists, feet and blunt weapons bounce off.
   */
  impact(mode: 'stick' | 'rebound', hold: number, retract: number) {
    if (this.state !== 'attack') return;
    const sf = this.stateFrame;
    copyPose(this.pose, this.impactPose);
    this.stuckUntil = mode === 'stick' ? sf + hold : 0;
    this.attackEnd = sf + hold + retract;
    const back = getPose(this.weapon ? (this.weapon.style === 'oneHand' ? 'wGuard1' : 'wGuard2') : 'guard');
    const keys: Parameters<typeof this.anim.play>[0] = [
      { f: sf, pose: this.impactPose },
      { f: sf + hold, pose: this.impactPose },
    ];
    if (this.weapon) {
      // A weapon is brought back up and over, not dragged back through the body.
      blendPose(this.impactPose, back, 0.5, this.retractPose);
      this.retractPose.blade.y += 0.25;
      this.retractPose.blade.normalize();
      keys.push({ f: sf + hold + Math.round(retract / 2), pose: this.retractPose, ease: 'inOut' });
    }
    keys.push({ f: this.attackEnd, pose: back, ease: mode === 'stick' ? 'in' : 'out' });
    this.anim.play(keys);
  }

  inCancelWindow(): boolean {
    const m = this.move;
    if (this.state !== 'attack' || !m?.cancel) return false;
    // A punch that landed on a guard can't be rolled straight into the next: it has to
    // come all the way back first.
    if (this.state === 'attack' && this.wasBlocked) return false;
    if (this.stateFrame < this.stuckUntil) return false;
    return this.stateFrame >= m.cancel.from && this.stateFrame <= m.cancel.to && (!this.attackEnd || this.stateFrame < this.attackEnd);
  }

  /** A move by id: own moves, plus weapon techniques while armed. */
  moveDef(id: string): MoveDef | undefined {
    // Armed, the weapon's technique wins a name clash ('sweep' is a weapon swing, not
    // the leg sweep).
    return (this.weapon && !this.isSevered('foreArmR') ? WEAPON_MOVES[id] : undefined) ?? this.moves[id];
  }

  /** Is this bone (or a bone above it) cut off? */
  isSevered(bone: BoneName): boolean {
    if (this.severed.has(bone)) return true;
    if (bone === 'foreArmL') return this.severed.has('upperArmL');
    if (bone === 'foreArmR') return this.severed.has('upperArmR');
    if (bone === 'shinL') return this.severed.has('thighL');
    if (bone === 'shinR') return this.severed.has('thighR');
    return false;
  }

  /** Can this move still be thrown with the limbs left? */
  canUse(m: MoveDef): boolean {
    const bone: BoneName = m.limb === 'handL' ? 'foreArmL' : m.limb === 'handR' ? 'foreArmR' : m.limb === 'footL' ? 'shinL' : 'shinR';
    return !this.isSevered(bone);
  }

  distanceTo(o: Fighter): number {
    return Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
  }

  press(button: Button, frames = 12) {
    this.buffer = { button, frames };
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  setState(s: FighterState) {
    this.state = s;
    this.stateFrame = 0;
    if (s !== 'attack') {
      this.move = null;
      this.attackEnd = 0;
      this.stuckUntil = 0;
    }
    if (s !== 'defend') this.defense = null;
    if (s !== 'pickup') this.pickupTarget = null;
  }

  /** The weapon being reached for, and when the hands close on it. */
  pickupTarget: { pos: Vector3; weapon: WeaponDef; grabAt: number } | null = null;

  /**
   * Go down for a weapon: squat and bend over it (both hands for a two-hander), take
   * hold at the bottom, and come back up with the weight. `frames` grows with how heavy
   * it is for this body.
   */
  startPickup(target: { pos: Vector3; weapon: WeaponDef }, frames: number) {
    this.setState('pickup');
    this.pickupRequest = 0;
    this.stunFrames = frames;
    const grabAt = Math.round(frames * 0.5);
    this.pickupTarget = { pos: target.pos, weapon: target.weapon, grabAt };
    this.idle.interrupt();
    const two = target.weapon.style === 'twoHand';
    const low = getPose(two ? 'pickupLow2' : 'pickupLow1');
    const up = getPose(two ? 'wGuard2' : 'wGuard1');
    this.anim.play([
      { f: grabAt, pose: low, ease: 'inOut' },
      { f: grabAt + 3, pose: low },
      // Heavier things come up slower: most of the effort is in the first half.
      { f: frames, pose: up, ease: 'inOut' },
    ]);
  }

  /** @param aimId force a specific aim (tests, scripted moves); otherwise one is picked. */
  startMove(move: MoveDef, isCounter = false, aimId?: string) {
    // Timing fits the body and the tool: big bodies move their limbs slower (like a
    // longer pendulum), small ones quicker; heavy weapons take longer to bring round.
    // Tired arms are slow arms.
    let tempo = Math.sqrt(this.scale) * (move.weapon && this.weapon ? weaponTempo(this.weapon, this.scale) : 1) * (1 + (1 - this.stamina) * 0.6) * (this.perks.has('quickHands') ? 0.9 : 1);
    // An opponent's strike always gives you a fair look at it: never less than a
    // quarter-second of wind-up (anything quicker is slowed — recovery and all).
    if (this.team === 'enemy') tempo = Math.max(tempo, ENEMY_MIN_STARTUP / move.startup);
    // Gassed, a punch is an arm with nothing behind it.
    this.swingStamina = this.stamina;
    // Swinging a heavy weapon costs the breath it looks like it costs.
    const lift = move.weapon && this.weapon ? 0.8 + 0.15 * heft(this.weapon, this.scale) : 1;
    const cost = (move.weight === 'light' ? 0.035 : move.weight === 'medium' ? 0.055 : 0.085) * lift * (isCounter ? 0.8 : 1);
    this.stamina = Math.max(0, this.stamina - cost);
    // The same thing over and over is easy to see coming.
    this.repeatCount = move.id === this.lastMoveId && this.sinceMoveStart < 100 ? this.repeatCount + 1 : 0;
    this.lastMoveId = move.id;
    this.sinceMoveStart = 0;
    this.wasBlocked = false;
    move = timed(move, tempo);
    this.setState('attack');
    this.move = move;
    this.attackEnd = 0;
    this.stuckUntil = 0;
    this.attackSerial++;
    this.hitThisAttack = false;
    this.isCounterAttack = isCounter;
    this.isPerfectCounter = isCounter && this.perfectCounter;
    this.perfectCounter = false;
    this.counter = null;
    this.buffer = null;
    this.idle.interrupt();
    this.aim = this.pickAim(move, aimId);
    this.strikeHeight = this.aim?.height ?? move.height;
    // Natural scatter: no two strikes land on exactly the same spot.
    const jitter: [number, number, number] = aimId ? [0, 0, 0] : [this.rng.range(-0.04, 0.04), this.rng.range(-0.035, 0.035), 0];
    // Fit the strike to the opponent in front of us: up for a giant, down for a small one.
    // (Not a spin, a flip or a throw: there the body's turn or the flight does the aiming.)
    const free = !!move.spin || !!move.air?.flip || !!move.throw;
    // (A spin is still pitched at the height of whoever it's for: a giant brings its
    // spinning axe down to a man's chest rather than sweeping over his head.)
    const dy = free && !move.spin ? 0 : Math.max(-0.75, Math.min(0.45, this.heightGap(move, this.aim)));
    this.swingJitter = jitter;
    this.swingDy = dy;
    const keys = moveKeys(move, this.aim, jitter, dy, free ? Infinity : this.reachFit(move), free ? null : this.weaponFit(move, this.aim));
    // Re-aiming later keeps the same shape of swing (same keys), only pointed anew.
    this.swingViaMid = keys.length > move.keys.length;
    this.anim.play(keys);
  }

  private swingJitter: [number, number, number] = [0, 0, 0];
  private swingViaMid = false;
  private swingDy = 0;

  /**
   * Re-aim a weapon swing that's still coming round at where the target actually is
   * now — they moved, or bodies stopped us short of where the step-in would have taken
   * us — so it's still the head of the axe, not the haft, that arrives.
   */
  refitSwing() {
    const m = this.move;
    if (this.state !== 'attack' || !m?.weapon || this.attackEnd || this.stateFrame >= m.startup || m.spin || m.air?.flip || m.throw) return;
    const l = m.lunge;
    const left = l ? Math.max(0, Math.min(1, (l.to - this.stateFrame) / Math.max(1, l.to - l.from))) : 0;
    const fit = this.weaponFit(m, this.aim, left);
    if (fit) this.anim.retarget(moveKeys(m, this.aim, this.swingJitter, this.swingDy, Infinity, fit, this.swingViaMid));
  }

  private pickAim(move: MoveDef, aimId?: string): Aim | null {
    const aims = move.aims;
    if (!aims?.length) return null;
    if (aimId) return aims.find((a) => a.id === aimId) ?? aims[0];
    // Against a covered-up opponent, go around the guard: favour body / leg targets.
    const t = this.target;
    const covering = !!t && (t.state === 'blockstun' || (t.state === 'defend' && t.defense?.def.kind === 'block'));
    // Go for what you can reach: a giant's head is out of reach, a small one's legs
    // are awkward to get down to.
    return this.rng.pickWeighted(
      aims.map((a) => {
        const miss = Math.max(0, Math.abs(this.heightGap(move, a)) - 0.3);
        return [a, a.weight * (covering && (a.height === 'mid' || a.height === 'low') ? 3 : 1) * Math.exp(-miss * 5)];
      }),
    );
  }

  /**
   * Where a weapon strike should land (fighter-local, unscaled, after the lunge): the
   * aimed part of the target, at the front of their body.
   */
  private weaponFit(move: MoveDef, aim: Aim | null, lungeLeft = 1): WeaponFit | null {
    const t = this.target;
    const w = this.weapon;
    if (!t || !t.alive || !w || !move.weapon) return null;
    const lunge = (move.lunge?.distance ?? 0) * this.scale * lungeLeft;
    const stop = (0.74 * (this.scale + t.scale)) / 2;
    const ahead = Math.max(stop, this.distanceTo(t) - lunge) - 0.1 * t.scale;
    // Side offset of the target relative to our facing.
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const ox = t.pos.x - this.pos.x;
    const oz = t.pos.z - this.pos.z;
    const side = (ox * fz - oz * fx) / Math.max(0.01, Math.hypot(ox, oz));
    const h = targetHeight(t, aim?.height ?? move.height) + (aim?.edgeDy ?? 0) * t.scale;
    return {
      target: [side * ahead * 0.5 / this.scale, h / this.scale, ahead / this.scale],
      strikeAt: Math.max(w.strikeFrom + 0.06, w.length - (w.edge === 'blade' && w.style === 'twoHand' ? 0.14 : 0.08)),
    };
  }

  /**
   * How far forward (fighter-local, unscaled) the striking fist / foot should reach to
   * land on the target's body rather than through it, allowing for the lunge.
   */
  private reachFit(move: MoveDef): number {
    const t = this.target;
    if (!t || !t.alive || move.weapon) return Infinity;
    const lunge = (move.lunge?.distance ?? 0) * this.scale;
    const stop = (0.74 * (this.scale + t.scale)) / 2;
    const dist = Math.max(stop, this.distanceTo(t) - lunge);
    // To the front of their body, plus a little: punches land into the target.
    return (dist - 0.13 * t.scale) / this.scale + 0.06;
  }

  /**
   * Whether an unarmed strike can get to what it goes for on the current target: a small
   * creature's jab can't get up to a giant's head (nor its body shot to his belly), but a
   * kick can always find a shin.
   */
  canReach(move: MoveDef): boolean {
    if (move.weapon) return true;
    const aims: (Aim | null)[] = move.aims?.length ? move.aims : [null];
    return aims.some((a) => {
      if ((a?.height ?? move.height) === 'low') return true;
      const g = this.heightGap(move, a);
      return g <= 0.5 && g >= -0.8;
    });
  }

  /**
   * How much higher (+) or lower (-) the target's part is than this strike was authored
   * to hit, in our own (unscaled) metres. Small differences are left to the pose.
   */
  private heightGap(move: MoveDef, aim: Aim | null): number {
    const t = this.target;
    if (!t || !t.alive) return 0;
    const h = aim?.height ?? move.height;
    const gap = targetHeight(t, h) / this.scale - AUTHORED_HEIGHT[h];
    return Math.abs(gap) < 0.1 ? 0 : gap - Math.sign(gap) * 0.1;
  }

  /** @param slipSide for a weave: +1 slips to our left, -1 to our right (default: alternate). */
  /** @param arriveIn frames until the strike lands: the move is timed to be there by then. */
  startDefense(kind: DefenseKind, threatSerial: number, slipSide?: 1 | -1, arriveIn?: number) {
    const def = DEFENSES[kind];
    this.setState('defend');
    if (kind === 'weave') this.weaveSide = slipSide ?? (this.weaveSide === 1 ? -1 : 1);
    this.defense = { def, threatSerial, phase: 'startup', success: false, side: this.weaveSide };
    this.defenseManual = false;
    this.lastDefendedSerial = threatSerial;
    this.stamina = Math.max(0, this.stamina - 0.015);
    this.defenseCooldown[kind] = def.cooldown;
    this.idle.interrupt();
    const f = Math.max(def.startup, Math.min(Math.round(def.startup * 2.5), arriveIn ?? def.startup + 3));
    this.anim.play([{ f, pose: getPose(defensePose(kind, this.weaveSide)), ease: 'out' }]);
  }

  enterDefenseRecovery() {
    if (!this.defense) return;
    this.defense.phase = 'recovery';
    this.stateFrame = 0;
    this.anim.play([{ f: this.defense.def.recovery, pose: getPose('guard'), ease: 'inOut' }]);
  }

  /**
   * Rocked by a blow. `intensity` 0..1 sizes the reaction: a jab barely moves the head,
   * a full power shot snaps it all the way.
   */
  enterHitstun(frames: number, reaction: PoseName, intensity = 1) {
    this.setState('hitstun');
    this.stunFrames = frames;
    this.hitReaction = reaction;
    const home = getPose(this.weapon ? (this.weapon.style === 'oneHand' ? 'wGuard1' : 'wGuard2') : 'guard');
    const k = Math.max(0.2, Math.min(1, intensity));
    const peak = k >= 0.99 ? getPose(reaction) : blendPose(home, getPose(reaction), k, this.reactPose);
    // The head goes with the blow at once (the ragdoll takes the impulse); the rest of
    // the body follows over ~70-100 ms, not in two frames.
    const at = Math.min(Math.max(2, Math.floor(frames * 0.3)), k > 0.7 ? 4 : 5);
    this.anim.play([
      { f: at, pose: peak, ease: 'linear' },
      { f: Math.max(at + 1, Math.floor(frames * (0.35 + 0.2 * k))), pose: peak },
      { f: frames, pose: home, ease: 'inOut' },
    ]);
  }

  enterBlockstun(frames: number) {
    this.setState('blockstun');
    this.stunFrames = frames;
    this.anim.play([
      { f: 2, pose: getPose('block'), ease: 'out' },
      { f: Math.max(3, frames - 3), pose: getPose('block') },
      { f: frames + 4, pose: getPose('guard'), ease: 'inOut' },
    ]);
  }

  enterGuardBreak(frames: number) {
    this.setState('guardbreak');
    this.stunFrames = frames;
    this.anim.play([
      { f: 4, pose: getPose('guardBreak'), ease: 'out' },
      { f: Math.floor(frames * 0.7), pose: getPose('guardBreak') },
      { f: frames, pose: getPose('guard'), ease: 'inOut' },
    ]);
  }

  enterKnockdown() {
    this.setState('knockdown');
    this.stunFrames = KNOCKDOWN_FRAMES;
    this.anim.play([{ f: 6, pose: getPose('limp'), ease: 'out' }]);
  }

  enterGetup() {
    this.setState('getup');
    this.stunFrames = GETUP_FRAMES;
    this.poise = this.stats.maxPoise;
    this.anim.play([
      { f: 1, pose: getPose('kneel') },
      { f: Math.floor(GETUP_FRAMES * 0.55), pose: getPose('kneel') },
      { f: GETUP_FRAMES, pose: getPose('guard'), ease: 'inOut' },
    ]);
  }

  enterKO() {
    this.setState('ko');
    this.anim.play([{ f: 6, pose: getPose('limp'), ease: 'out' }]);
  }

  /** Arms up: the fight is won. */
  celebrate(frames = 150) {
    this.setState('celebrate');
    this.stunFrames = frames;
    const up = this.liftsWithBothHands() ? 'victory2' : 'victory';
    this.anim.play([
      { f: 14, pose: getPose(up), ease: 'out' },
      { f: frames - 24, pose: getPose(up) },
      { f: frames, pose: getPose(this.weapon ? (this.weapon.style === 'oneHand' ? 'wGuard1' : 'wGuard2') : 'guard'), ease: 'inOut' },
    ]);
  }

  /**
   * A heavy two-handed tool (axe, sledgehammer, club) goes up level overhead in both
   * hands, the lead hand slid up the handle. Anything lighter — a sword, a bat — is
   * raised in the one hand, the other fist up beside it: gripped with both, the second
   * hand would end up right in front of the face.
   */
  private liftsWithBothHands(): boolean {
    const w = this.weapon;
    return !!w && w.style === 'twoHand' && w.choke > 0 && w.mass >= 2 && !this.isSevered('foreArmL');
  }

  enterLocomotion(fade = 6) {
    this.setState('idle');
    this.anim.procedural(fade);
  }

  // ---------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------

  /**
   * Updates the animated target pose and its world-space FK.
   * `speed`/`localDir*` describe the actual footwork velocity; `turnRate` (rad/frame)
   * is used to keep stepping while pivoting.
   */
  updatePose(speed: number, localDirX: number, localDirZ: number, turnRate = 0) {
    this.breath += 1 / 60;
    this.turnRate = turnRate;
    const speedFrac = clamp(speed / Math.max(0.1, this.stats.walkSpeed), 0, 1);
    const want = clamp((speed + Math.abs(turnRate) * 20) / Math.max(0.1, this.stats.walkSpeed * 0.6), 0, 1);
    this.moveBlend += (want - this.moveBlend) * 0.25;

    const t = this.target && this.target.alive ? this.target : null;
    const dist = t ? this.distanceTo(t) : Infinity;
    this.updateMotion(t, dist);
    const engaged = dist < 3.2;
    const still = this.state === 'idle' && speed < 0.25;
    this.idle.tick(engaged, still);

    const handStrike = this.state === 'attack' && this.move?.layer === 'upper';
    // Rocked, blocking, slipping: the upper body reacts, but the feet stay where they're
    // planted (and step to recover) rather than gliding to the pose's stance.
    // (A slide is the exception: the feet do slide.)
    const legsUnder =
      this.state === 'hitstun' || this.state === 'blockstun' || this.state === 'guardbreak' || this.state === 'pickup' || (this.state === 'defend' && this.defense?.def.kind !== 'slide');
    const driven = this.anim.isProcedural || (handStrike && this.moveBlend > 0.25) || legsUnder;
    const [offX, offZ] = this.anim.isProcedural ? this.idle.stanceOffset() : [0, 0];
    if (driven) this.footwork.update(this, offX, offZ, localDirX, localDirZ, speedFrac);

    let proc;
    if (this.anim.isProcedural) proc = this.locomotionPose(localDirX, localDirZ, offX, offZ);
    this.anim.update(this.stateFrame, proc);
    copyPose(this.anim.out, this.pose);

    // Hand strikes thrown on the move: keep the legs stepping under the punching torso.
    if ((handStrike && driven) || legsUnder) {
      const L = this.layered;
      copyPose(this.anim.out, L);
      if (handStrike) {
        const [wx, wz] = this.footwork.weightShift(this, 0, 0);
        L.root.x = this.anim.out.root.x + wx * 0.5;
        L.root.z = this.anim.out.root.z + wz * 0.5;
      }
      solveLegs(L, { at: this.footwork.localTarget('L', this, 0), hint: KNEE_HINT.L }, { at: this.footwork.localTarget('R', this, 0), hint: KNEE_HINT.R });
      if (legsUnder) copyPose(L, this.pose);
      else blendPose(this.anim.out, L, this.moveBlend, this.pose);
    }
    this.applyAir();
    if (this.weapon && !this.isSevered('foreArmR')) {
      forwardKinematics(this.pose, this.rig, this.pos, this.yaw, this.scale);
      this.keepWeaponClear();
      if (this.weapon.style === 'twoHand' && !this.isSevered('foreArmL')) this.gripWithBothHands();
    }
    forwardKinematics(this.pose, this.rig, this.pos, this.yaw, this.scale);
    // Authored-leg animations (kicks, defense, reactions): feet are wherever the pose put them.
    if (!driven) this.footwork.syncToRig(this.rig);
  }

  /**
   * In the air the whole body is lifted on its ballistic arc and turns about its centre
   * of mass at a steady rate (the spin it left the ground with): the pose only tucks
   * and extends the limbs.
   */
  private applyAir() {
    if (!this.isAirborne()) return;
    const a = this.move!.air!;
    const P = this.pose;
    P.root.y += this.airHeight() / this.scale;
    if (!a.flip) return;
    const u = (this.stateFrame - a.from) / (a.to - a.from);
    _flipQ.setFromAxisAngle(_xAxis, a.flip * u);
    // The centre of mass: a hand's width above the hip joints.
    _com.set(0, 0.12, 0).applyQuaternion(P.rot.pelvis).add(P.root);
    P.root.sub(_com).applyQuaternion(_flipQ).add(_com);
    P.rot.pelvis.premultiply(_flipQ);
    P.blade.applyQuaternion(_flipQ);
  }

  /** Chest rising and falling: slow and shallow when fresh, fast and heaving when gassed. */
  private breathing(): number {
    const e = 1 - this.stamina;
    this.breathPhase += (2.2 + 4.5 * e) / 60;
    return Math.sin(this.breathPhase) * (0.01 + 0.045 * e * e);
  }

  /**
   * A weapon can't pass through a body: if it would go through our own torso or head
   * (or through the opponent when we're not swinging at them), the wrist turns it clear.
   */
  private keepWeaponClear() {
    // The forward swing follows its own (fitted) path: deflecting it mid-stroke is what
    // turns a chop into a sideways flail.
    // A swing that was dodged (decided, not stopped on anything) rides over / past the
    // body that got out of its way rather than through it.
    const dodged = this.state === 'attack' && this.hitThisAttack && !this.attackEnd;
    if (this.inWeaponContact() && !dodged) return;
    const w = this.weapon!;
    const t = this.target;
    const swinging = this.inWeaponContact() || (this.state === 'attack' && this.stateFrame < this.stuckUntil) || !!this.attackEnd;
    // An overhead brings the weapon right past the wielder's own head: in a swing only
    // the trunk is in the way.
    const solids: Capsule[] = bodyCapsules(this).torso.filter((c) => !swinging || c.bone !== 'head');
    if (t && t.alive && (dodged || !swinging)) {
      const b = bodyCapsules(t);
      solids.push(...b.torso, ...b.limbs);
    }
    const offs = sampleOffsets(w);
    for (let iter = 0; iter < 10; iter++) {
      bladeFrame(this, _grip, _dir);
      let worst = 0;
      let at = 1;
      _push.set(0, 0, 0);
      for (const off of offs) {
        if (off < 0.14) continue;
        _p.copy(_grip).addScaledVector(_dir, off * this.scale);
        for (const c of solids) {
          closestOnSegment(_p, c.a, c.b, _q);
          const pen = c.r + (w.radius + 0.01) * this.scale - _p.distanceTo(_q);
          if (pen > worst) {
            worst = pen;
            at = off * this.scale;
            _push.subVectors(_p, _q);
          }
        }
      }
      if (worst < 0.008) return;
      if (_push.lengthSq() < 1e-8) _push.set(0, 1, 0);
      _push.normalize();
      // Swing the blade out along the push, enough to clear at that point.
      _dir.addScaledVector(_push, Math.min(1.2, (worst / at) * 1.3)).normalize();
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      this.pose.blade.set(_dir.x * c - _dir.z * s, _dir.y, _dir.x * s + _dir.z * c).normalize();
    }
  }

  /** Two-handed grip: the lead hand holds the haft just below the rear hand. */
  private gripWithBothHands() {
    // Both hands stay on the haft whatever the body is doing — kicking, rocked by a
    // blow — until it's knocked flat.
    if (this.state === 'knockdown' || this.state === 'ko' || this.state === 'getup') return;
    if (this.state === 'celebrate' && !this.liftsWithBothHands()) return;
    forwardKinematics(this.pose, _localRig);
    const w = this.weapon!;
    bladeFrame({ rig: _localRig, pose: this.pose, yaw: 0, scale: 1 }, _grip, _dir);
    // The rear hand holds the end of the handle. On a heavy tool the lead hand rides up
    // toward the head to hold and lift the weight, and slides back down to the rear
    // hand as the swing comes through (leverage at impact); on a sword the hands stay a
    // hand's width apart. Either way it moves along the handle to wherever the left arm
    // can reach (a turned shoulder, an overhead wind-up) instead of hanging in mid-air.
    const sh = _localRig.upperArmL.pos;
    const reach = SKELETON.upperArmL.length + SKELETON.foreArmL.length + FIST_OFFSET - 0.02;
    // Points of the haft the hand can reach form a stretch around the point nearest the
    // shoulder; take the one in it nearest the usual grip (moves smoothly, never jumps).
    _q.subVectors(sh, _grip);
    const tc = _q.dot(_dir);
    const room = reach * reach - (_q.lengthSq() - tc * tc);
    const half = room > 0 ? Math.sqrt(room) : 0;
    const want = w.choke > 0 ? Math.max(0.11, gripSlide(this.pose.slide, w)) : -SECOND_HAND;
    // Stay on the handle: above the rear hand and short of the head.
    const lo = w.choke > 0 ? 0.1 : -0.38;
    const hi = w.choke > 0 ? Math.max(0.12, w.strikeFrom - 0.06) : 0.3;
    const best = Math.max(lo, Math.min(hi, Math.max(tc - half, Math.min(tc + half, want))));
    _p.copy(_grip).addScaledVector(_dir, best);
    solveArm(this.pose, 'L', { at: [_p.x, _p.y, _p.z], hint: [0.5, -1, -0.2] });
  }

  /** Re-evaluates the fight context and eases the movement profile toward it. */
  private updateMotion(t: Fighter | null, dist: number) {
    const threat =
      !!t && t.state === 'attack' && !!t.move && t.stateFrame < t.move.startup + t.move.active && dist <= t.move.reach + 0.5;
    const { weights, mods } = targetProfile(
      {
        // Locked on: fighting footwork whatever the range. Not locked on: you just walk
        // (or run) like a person, however close someone is.
        dist: this.lockedOn ? Math.min(dist, ZONE_RANGES.outside) : Math.max(dist, ZONE_RANGES.outsideBlend),
        hpFrac: this.hp / this.stats.maxHp,
        guardFrac: this.guard / this.stats.maxGuard,
        framesSinceHit: this.framesSinceHit,
        stamina: this.stamina,
        threat,
        opponentDown: !!this.target && (this.target.state === 'knockdown' || this.target.state === 'getup'),
        pressing: !!t && (t.hp / t.stats.maxHp < 0.4 || t.state === 'hitstun' || this.framesSinceLanded < 60),
      },
      this.motionTarget,
    );
    // Threats are reacted to quickly; everything else drifts in over ~a second.
    smoothProfile(this.motion, this.motionTarget, threat ? 0.25 : 0.06);
    const M = this.motion;
    Object.assign(this.footwork.mods, { stance: M.stance, stepFrames: M.stepFrames, stepHeight: M.stepHeight, stride: M.stride, gait: M.gait });
    Object.assign(this.idle.mods, { bounce: M.bounce, bounceHz: M.bounceHz, sway: M.sway, head: M.head, feints: M.feints, paws: M.paws });

    const info = this.motionInfo;
    info.zone = (Object.entries(weights) as [Zone, number][])
      .filter(([, w]) => w > 0.05)
      .sort((a, b) => b[1] - a[1])
      .map(([z, w]) => `${z} ${Math.round(w * 100)}%`)
      .join(' / ');
    info.context = (Object.entries(mods) as [MotionMods, number][])
      .filter(([, v]) => v > 0.05)
      .map(([k, v]) => (v > 0.95 ? k : `${k} ${Math.round(v * 100)}%`))
      .join(', ') || 'neutral';
    info.speed = +M.speed.toFixed(2);
    info.stride = +M.stride.toFixed(2);
    info.bounce = +M.bounce.toFixed(2);
    info.guard = +M.guardY.toFixed(3);
  }

  private locomotionPose(dx: number, dz: number, offX: number, offZ: number) {
    // Eyes on the opponent's face: chin up to a giant, down to something small.
    const t = this.target && this.target.alive && this.lockedOn ? this.target : null;
    let want = 0;
    if (t) {
      const up = t.rig.head.pos.y - this.rig.head.pos.y;
      want = Math.max(-0.55, Math.min(0.5, -Math.atan2(up, Math.max(0.4, this.distanceTo(t))) * 0.9));
    }
    this.lookPitch += (want - this.lookPitch) * 0.1;
    // Runners lean into a turn (turning left: lean left), like a cyclist.
    const lean = Math.max(-0.28, Math.min(0.28, -this.turnRate * 7)) * this.footwork.run * this.motion.gait;
    this.bank += (lean - this.bank) * 0.15;
    const m = this.moveBlend;
    const M = this.motion;
    // 0 = fighting stance, 1 = walking like a person (square hips, arm swing, hands down).
    const g = M.gait;
    const f = 1 - g;
    const raise = this.idle.toeRaise() * (1 - m) * f;
    const [wx, wz] = this.footwork.weightShift(this, offX, offZ);
    // Lean into forward/lateral travel; when retreating keep the head over the lead knee
    // (never lean away from the opponent) and bring the hands up a touch.
    const fwd = Math.max(0, dz);
    const back = Math.max(0, -dz) * f;
    const footL = this.footwork.localTarget('L', this, raise);
    const footR = this.footwork.localTarget('R', this, raise);
    // Walking arm swing: each hand swings with the opposite foot.
    const swing = Math.max(-0.35, Math.min(0.35, footR[2] - footL[2])) * g * (this.weapon?.style === 'twoHand' ? 0.25 : 1);
    // Running: elbows locked near 90°, arms pumping hard from the shoulder.
    const run = this.footwork.run * g;
    // Hands on a two-handed haft can't pump (or swing): the shoulders stay square to it.
    const twoHand = this.weapon?.style === 'twoHand' ? 0.25 : 1;
    const pump = Math.max(-1, Math.min(1, (footR[2] - footL[2]) / 0.55)) * twoHand;
    const G = this.weapon ? POSE_SPECS[this.weapon.style === 'oneHand' ? 'wGuard1' : 'wGuard2'] : GUARD;
    // Holding a heavy weapon up is work: it sags a little even fresh, and a lot as the
    // arms tire — hands lower, the head of it drooping toward hanging.
    const load = Math.min(1, heft(this.weapon, this.scale) / 4);
    const droop = load * (0.25 + 0.75 * (1 - this.stamina));
    const guardL = guardHand(G.handL!, M.guardY + back * 0.02 * m - 0.12 * droop, M.guardZ - 0.04 * droop);
    const guardR = guardHand(G.handR!, M.guardY + back * 0.02 * m - 0.12 * droop, M.guardZ * 0.6 - 0.04 * droop);
    const gb = G.blade ?? DEFAULT_BLADE;
    const sag = droop * 0.55;
    let guardBlade: V3 = [gb[0] * (1 - sag) + 0.15 * sag, gb[1] * (1 - sag) - 0.35 * sag, gb[2] * (1 - sag) + 0.9 * sag];
    // Someone inside the length of a long weapon: it's held up out of their way, not
    // levelled into their chest.
    if (this.weapon && this.target?.alive) {
      const room = this.distanceTo(this.target) - 0.3 * this.target.scale;
      const close = Math.max(0, Math.min(1, (this.weapon.length * this.scale + 0.35 - room) / 0.35));
      if (close > 0) guardBlade = [guardBlade[0] * (1 - close), guardBlade[1] * (1 - close) + 0.95 * close, guardBlade[2] * (1 - close) + 0.3 * close];
    }
    const lerp3 = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const runHand = (side: 1 | -1): V3 => {
      const th = 0.32 + 0.68 * pump * side;
      return [side * (0.2 - 0.07 * Math.max(0, pump * side)), 1.4 - 0.39 * Math.cos(th), 0.17 + 0.39 * Math.sin(th)];
    };
    let relaxedL = lerp3([0.21, 0.94 + Math.max(0, swing) * 0.15, 0.03 + swing * 0.55], runHand(1), run);
    let relaxedR = lerp3([-0.21, 0.94 + Math.max(0, -swing) * 0.15, 0.03 - swing * 0.55], runHand(-1), run);
    // A two-handed weapon is carried across the body (the off hand stays on the haft).
    if (this.weapon?.style === 'twoHand') {
      relaxedR = [-0.2, 1.12, 0.18];
      relaxedL = [-0.05, 1.05, 0.2];
    }
    const hintL = lerp3([0.2, -0.25, -1], [0.3, -0.35, -1], run);
    const hintR = lerp3([-0.2, -0.25, -1], [-0.3, -0.35, -1], run);
    // Running bob: lowest as the body passes over the planted foot, highest in flight.
    let compress = 0;
    for (const [foot, at] of [[this.footwork.L, footL], [this.footwork.R, footR]] as const) {
      if (!foot.stepping) compress = Math.max(compress, 1 - Math.min(1, Math.abs(at[2] - 0.03) / 0.35));
    }
    const bob = run * (0.022 - 0.05 * compress);
    const mix = (a: V3, b: V3): V3 => [a[0] * f + b[0] * g, a[1] * f + b[1] * g, a[2] * f + b[2] * g];
    const kneeR = mix(KNEE_HINT.R, [-0.15, 0, 1]);
    // The head stays level and pointed where the eyes need to be — the neck soaks up the
    // hips' and shoulders' swing (as it does when people walk and run) and turns the
    // face toward the opponent when the body isn't square to them.
    const pelvisYaw = -0.3 * f + swing * 0.25 * (1 - run) + pump * 0.16 * run;
    const chestYaw = -0.1 * f - swing * 0.45 * (1 - run) - pump * 0.3 * run;
    let track = 0;
    if (t) track = Math.max(-0.6, Math.min(0.6, angleDelta(this.yaw, Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z)))) * 0.85;
    this.headTrack += (track - this.headTrack) * 0.15;
    const spec: PoseSpec = {
      ...GUARD,
      // Hips ride over the support foot; walking stands a little taller.
      root: [wx * 0.6 + dx * 0.03 * m, 0.86 + M.crouch + 0.03 * g - 0.012 * m - 0.04 * run + bob, 0.01 + wz * 0.6 + fwd * 0.03 * m],
      // Bladed stance → square hips when walking; the chest counter-rotates with the arm swing.
      pelvis: [0, pelvisYaw, 0],
      // Running leans the whole body into the stride.
      // (Carrying something heavy in front, the body leans back against it.)
      abdomen: [(0.1 + M.lean) * f + 0.04 * g + 0.13 * run + fwd * 0.05 * m + back * 0.03 * m - (this.weapon?.style === 'twoHand' ? 0.06 * load * g + 0.03 * load * f : 0), 0, -dx * 0.05 * m * f + this.bank],
      chest: [0.08 * f + 0.02 * g + 0.04 * run + this.lookPitch * 0.25 + this.breathing(), chestYaw, 0],
      head: [-0.04 * f - 0.15 * run + this.lookPitch, -(pelvisYaw + chestYaw) + this.headTrack, 0],
      handL: { at: mix(guardL.at, relaxedL), hint: mix(guardL.hint ?? [0.35, -1, 0], hintL) },
      handR: { at: mix(guardR.at, relaxedR), hint: mix(guardR.hint ?? [-0.35, -1, 0], hintR) },
      footL: { at: footL, hint: KNEE_HINT.L },
      footR: { at: footR, hint: kneeR },
      // Weapon: on guard in a fight; walking or running, a one-hander hangs point-down
      // and forward at the side, a two-hander is carried across the body.
      blade: this.weapon ? mix(guardBlade, this.weapon.style === 'oneHand' ? [0.05, -0.55, 0.83] : (G.blade ?? DEFAULT_BLADE)) : undefined,
      // A heavy two-hander is carried with the lead hand right up by the head.
      slide: (G.slide ?? 0) * f + 1 * g,
    };
    this.idle.apply(spec, (1 - m * 0.7) * f);
    return resolvePose(spec, this.locoPose);
  }
}

// Keyed by the move itself: different moves can share an id (the player's hook and an
// enemy's haymaker are both 'hook').
const _timed = new WeakMap<MoveDef, Map<string, MoveDef>>();

/** The least wind-up (frames) an opponent's strike gets: enough to see it and react. */
export const ENEMY_MIN_STARTUP = 15;

/** A move with its frame data stretched (>1 slower) — cached per move and tempo. */
export function timed(m: MoveDef, tempo: number): MoveDef {
  if (Math.abs(tempo - 1) < 0.03) return m;
  const key = tempo.toFixed(2);
  let byTempo = _timed.get(m);
  if (!byTempo) _timed.set(m, (byTempo = new Map()));
  let t = byTempo.get(key);
  if (!t) {
    const f = (n: number) => Math.round(n * tempo);
    t = {
      ...m,
      startup: Math.max(3, f(m.startup)),
      active: Math.max(2, f(m.active)),
      recovery: Math.max(4, f(m.recovery)),
      lunge: m.lunge && { ...m.lunge, from: f(m.lunge.from), to: Math.max(f(m.lunge.from) + 1, f(m.lunge.to)) },
      air: m.air && { ...m.air, from: f(m.air.from), to: Math.max(f(m.air.from) + 2, f(m.air.to)) },
      spin: m.spin && { ...m.spin, from: f(m.spin.from), to: Math.max(f(m.spin.from) + 2, f(m.spin.to)), hold: m.spin.hold && [f(m.spin.hold[0]), f(m.spin.hold[1])] },
      throw: m.throw && { ...m.throw, release: f(m.throw.release) },
      armor: m.armor && [f(m.armor[0]), f(m.armor[1])],
      evades: m.evades && { ...m.evades, from: f(m.evades.from), to: f(m.evades.to) },
      cancel: m.cancel && { ...m.cancel, from: f(m.cancel.from), to: f(m.cancel.to) },
    };
    byTempo.set(key, t);
  }
  return t;
}

const _localRig = makeRig();
const _flipQ = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);
const _com = new Vector3();
/** m/s². */
export const GRAVITY = 9.81;
const _grip = new Vector3();
const _dir = new Vector3();
const _push = new Vector3();
const _p = new Vector3();
const _q = new Vector3();

const guardHand = (h: { at: [number, number, number]; hint?: [number, number, number] }, dy: number, dz: number) => ({
  at: [h.at[0], h.at[1] + dy, h.at[2] + dz] as [number, number, number],
  hint: h.hint,
});

/** Knees track over the toes: lead foot points slightly in, rear foot turned out. */
export const KNEE_HINT: Record<'L' | 'R', [number, number, number]> = {
  L: [0.15, 0, 1],
  R: [-0.55, 0, 0.85],
};

export function defensePose(kind: DefenseKind, side: 1 | -1): PoseName {
  switch (kind) {
    case 'block':
      return 'block';
    case 'duck':
      return 'duck';
    case 'weave':
      return side === 1 ? 'weaveL' : 'weaveR';
    case 'slide':
      return 'slide';
  }
}

type V3 = [number, number, number];
const addV = (a: V3 | undefined, b: V3 | undefined): V3 | undefined =>
  b ? [(a?.[0] ?? 0) + b[0], (a?.[1] ?? 0) + b[1], (a?.[2] ?? 0) + b[2]] : a;

/** Key poses for one throw of a move; active-phase poses are re-aimed at the chosen target. */
/**
 * Keyframes for a strike, fitted to this throw: its aim, a little natural scatter, and
 * `dy` — how much higher (+) or lower (-) the target is than the move was authored for
 * (fighter-local metres). The striking limb (and weapon) follow the target up or down;
 * the body rises and looks up at a big opponent, or bends the knees, leans in and looks
 * down at a small one.
 */
/** Where the weapon should land: target point (fighter-local, unscaled) and the
 * distance along the weapon of the part that should hit it. */
export interface WeaponFit {
  target: V3;
  strikeAt: number;
}

/** Rear shoulder (fighter-local) and how far the rear fist reaches from it. */
const REAR_SHOULDER: V3 = [-0.2, 1.43, 0.12];
const ARM_REACH = 0.58;

/** @param viaMid weapon swings: force (true) or forbid (false) the mid-arc key; default decides. */
export function moveKeys(m: MoveDef, aim: Aim | null = null, jitter: V3 = [0, 0, 0], dy = 0, reachZ = Infinity, wfit: WeaponFit | null = null, viaMid?: boolean): TrackKey[] {
  const keys = buildKeys(m, aim, jitter, dy, reachZ, wfit);
  if (!wfit || !m.weapon || viaMid === false) return keys;
  // Re-aiming the strike mustn't make it turn the other way round: an overhead goes up
  // and over the top even when it's aimed down at a short opponent, rather than the
  // head swinging forward under the hands (through the wielder's own head). If the
  // shortest turn to the new aim runs against the authored swing, pass through the
  // middle of the authored arc on the way.
  const ci = m.keys.findIndex((k) => k.at[0] === 'a' && k.at[1] === 0);
  if (ci < 1) return keys;
  const from = getPose(m.keys[ci - 1].pose).blade;
  const authored = getPose(m.keys[ci].pose).blade;
  const fitted = keys[ci].pose.blade;
  const turnAuthored = _ta.crossVectors(from, authored);
  const turnFitted = _tb.crossVectors(from, fitted);
  if (viaMid !== true && turnAuthored.dot(turnFitted) >= 0 && from.dot(fitted) > -0.95) return keys;
  const a = keys[ci - 1];
  const b = keys[ci];
  const mid = blendPose(a.pose, b.pose, 0.5, makePose());
  slerpDir(from, authored, 0.5, mid.blade);
  keys.splice(ci, 0, { f: Math.round((a.f + b.f) / 2), pose: mid, ease: 'linear' });
  return keys;
}

const _ta = new Vector3();
const _tb = new Vector3();

function buildKeys(m: MoveDef, aim: Aim | null, jitter: V3, dy: number, reachZ: number, wfit: WeaponFit | null): TrackKey[] {
  const scatter = jitter[0] !== 0 || jitter[1] !== 0 || jitter[2] !== 0;
  return m.keys.map((k) => {
    let pose = getPose(k.pose);
    const active = k.at[0] === 'a';
    // The wind-up already heads for the new line; the recovery goes home as authored.
    const share = active ? 1 : k.at[0] === 's' ? 0.5 : 0;
    const authored = (POSE_SPECS[k.pose] as PoseSpec)[m.limb]?.at;
    const short = k.at[0] !== 'r' && !!authored && authored[2] > reachZ;
    // Weapon contact: point the weapon's striking part at the target.
    const contact = !!wfit && m.weapon && k.at[0] === 'a' && k.at[1] === 0;
    if (wfit && m.weapon) dy = 0;
    const fit = (dy !== 0 && share > 0) || short || contact;
    if ((active && (aim?.offset || aim?.add || scatter)) || fit) {
      const spec: PoseSpec = { ...POSE_SPECS[k.pose] };
      const limb = spec[m.limb];
      const lift: V3 = [0, dy * share, 0];
      if (limb) {
        const at = addV(addV(addV(limb.at, active ? aim?.offset : undefined), active ? jitter : undefined), lift)!;
        // Shorten the strike to the distance actually in front of us.
        if (at[2] > reachZ) at[2] = Math.max(0.22, reachZ);
        spec[m.limb] = { at, hint: limb.hint };
      }
      if (active) {
        for (const part of ['root', 'pelvis', 'abdomen', 'chest', 'head'] as const) {
          const d = aim?.add?.[part];
          if (d) spec[part] = addV(spec[part], d);
        }
      }
      if (contact && wfit && limb) {
        const T = wfit.target;
        const P = spec[m.limb]!.at;
        // Line from the authored hands to the target; slide the hands along it so the
        // striking part (not the haft) is what arrives — within the arm's reach.
        let dx = T[0] - P[0];
        let dyy = T[1] - P[1];
        let dz = T[2] - P[2];
        let len = Math.hypot(dx, dyy, dz) || 1;
        let hand: V3 = [T[0] - (dx / len) * wfit.strikeAt, T[1] - (dyy / len) * wfit.strikeAt, T[2] - (dz / len) * wfit.strikeAt];
        // Keep the hands out in front of the body and within reach of the shoulder.
        hand[2] = Math.max(0.2, hand[2]);
        const S = REAR_SHOULDER;
        const sx = hand[0] - S[0];
        const sy = hand[1] - S[1];
        const sz = hand[2] - S[2];
        const sl = Math.hypot(sx, sy, sz);
        if (sl > ARM_REACH) hand = [S[0] + (sx / sl) * ARM_REACH, S[1] + (sy / sl) * ARM_REACH, S[2] + (sz / sl) * ARM_REACH];
        dx = T[0] - hand[0];
        dyy = T[1] - hand[1];
        dz = T[2] - hand[2];
        len = Math.hypot(dx, dyy, dz) || 1;
        spec[m.limb] = { at: hand, hint: spec[m.limb]!.hint };
        spec.blade = [dx / len, dyy / len, dz / len];
        // Body follows the aim: fold in to strike low, open up to strike high.
        const low = Math.max(-0.6, Math.min(0.4, T[1] - 1.45));
        if (low < 0) {
          spec.root = addV(spec.root, [0, Math.max(-0.18, low * 0.3), 0]);
          spec.abdomen = addV(spec.abdomen, [Math.min(0.35, -low * 0.45), 0, 0]);
        } else spec.chest = addV(spec.chest, [-low * 0.3, 0, 0]);
        spec.head = addV(spec.head, [-low * 0.5, 0, 0]);
      }
      if (dy !== 0 && share > 0) {
        const u = dy * share;
        if (u < 0) {
          // Lower target: sink the hips, fold forward at the waist, eyes down.
          spec.root = addV(spec.root, [0, Math.max(-0.22, u * 0.4), 0.02]);
          spec.abdomen = addV(spec.abdomen, [Math.min(0.45, -u * 0.55), 0, 0]);
          spec.head = addV(spec.head, [Math.min(0.5, -u * 0.6), 0, 0]);
        } else {
          // Taller target: rise onto the balls of the feet, open the chest, look up.
          spec.root = addV(spec.root, [0, Math.min(0.06, u * 0.15), 0]);
          spec.chest = addV(spec.chest, [-Math.min(0.25, u * 0.35), 0, 0]);
          spec.head = addV(spec.head, [-Math.min(0.6, u * 0.9), 0, 0]);
        }
        if (spec.blade) {
          const b = spec.blade;
          spec.blade = [b[0], b[1] + u * 0.9, b[2]];
        }
      }
      pose = resolvePose(spec);
    }
    return { f: Math.round(markerFrame(m, k.at)), pose, ease: k.ease as Ease | undefined };
  });
}

/** Where a strike of each height lands on an opponent the move was authored for (local m). */
const AUTHORED_HEIGHT: Record<Height, number> = { high: 1.55, mid: 1.11, low: 0.54 };

/** World height of the part a strike of this height would land on. */
function targetHeight(t: Fighter, h: Height): number {
  const r = t.rig;
  if (h === 'high') return r.head.pos.y + 0.13 * t.scale;
  if (h === 'mid') return (r.chest.pos.y + r.abdomen.pos.y) / 2 + 0.06 * t.scale;
  return (r.thighL.pos.y + r.thighR.pos.y) / 2 - 0.25 * t.scale;
}
