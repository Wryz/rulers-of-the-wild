import { Quaternion, Vector3 } from 'three';
import {
  Animator,
  type AnimatorRecord,
  boolFromRecord,
  enumFromRecord,
  numFromRecord,
  poseFromRecord,
  type PoseRecord,
  poseToRecord,
  readV3,
  signFromRecord,
  strFromRecord,
  type TrackKey,
  trackKeyFromRecord,
  type TrackKeyRecord,
  trackKeyToRecord,
  v3Record,
} from '../body/animator';
import { Footwork, type FootworkRecord, type FootworkStyle } from '../body/footwork';
import { IdleBehavior, type IdleRecord, type IdleStyle } from '../body/idle';
import { makeProfile, type MotionMods, type MotionProfile, smoothProfile, targetProfile, type Zone, ZONE_RANGES } from '../body/motion';
import { getPose, GUARD, POSE_SPECS, type PoseName } from '../body/poses';
import {
  BONES,
  bonePoint,
  forwardKinematics,
  blendPose,
  copyPose,
  makePose,
  makeRig,
  type Pose,
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
import { boneMassShares, humanoidMass } from '../body/mass';
import type {
  CauseFeature,
  CauseKind,
  Drive,
  GroundQuery,
  ImpactCause,
  Inventory,
  KnockRecord,
  MaterialId,
  Posture,
  PostureId,
  RulerState,
  SpeciesId,
  V3 as WorldV3,
  Work,
} from '../world/types';
import { bladeFrame, gripSlide, heft, sampleOffsets, SECOND_HAND, WEAPON_MOVES, WEAPONS, type WeaponDef, type WeaponId, weaponTempo, type Wound } from './weapons';
import { bodyCapsules, type Capsule, closestOnSegment } from './bodyShapes';
import type { Drop, HurtZone } from './combat';
import { cloneCommand, type VerbCommand, type VerbId } from './commands';
import { getTuningValue } from '../tuning/registry';

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
import { angleDelta, clamp, DT, type Ease, Rng } from './math';
import { type Aim, DEFENSES, type DefenseDef, type DefenseKind, ENEMY_MOVES, type Height, markerFrame, type MoveDef, PLAYER_MOVES } from './moves';

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
  /**
   * Bending down for a weapon on the floor (committed, and open to being hit), or any committed work action
   * (`Fighter.work`: tying, shaping, digging by hand, docs/M1-DESIGN.md §5.0).
   */
  | 'pickup'
  /**
   * A ruler knocked off its feet: its body is a dynamic physics body (world/rulerBody.ts) that owns the rig;
   * CombatSim only counts `stateFrame` and runs forward kinematics (§4.7). Never entered in legacy CombatSim.
   */
  | 'tripped';

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

/**
 * A worn item as the armour rule reads it (docs/M1-DESIGN.md §4.4, SPEC:417, 885): what it is made of and the zones
 * it covers. Wearing is not an M1 verb; this is the data path the verb that adds it will fill.
 */
export interface WornItem {
  material: MaterialId;
  zones: readonly HurtZone[];
}

/**
 * `Fighter.armour` from what is worn (§4.4, RR-3): per zone, the sum of the covering items' materials' `armourJ`. It
 * reads a property, never a material's id (SPEC:192), so a new armour material is a new row of the table, not new code.
 * `materials` is MATERIALS (world/materials.ts), passed in so the fighter doesn't import a world module; derive again
 * whenever the worn items or the table change.
 */
export function armourFrom(
  worn: readonly WornItem[],
  materials: Readonly<Record<MaterialId, { readonly armourJ: number }>>,
): Partial<Record<HurtZone, number>> {
  const out: Partial<Record<HurtZone, number>> = {};
  for (const item of worn) {
    const j = materials[item.material].armourJ;
    for (const z of item.zones) out[z] = (out[z] ?? 0) + j;
  }
  return out;
}

/**
 * Where fighter ids come from (docs/M1-DESIGN.md §1.5.3, §8.1). A world owns one and passes it to every fighter it
 * makes, so two worlds in one process number their fighters alike; ids are never reused.
 */
export class IdCounter {
  constructor(public next = 1) {}
  take(): number {
    return this.next++;
  }
}

/**
 * The process-wide counter DungeonStyle had (a module-level `nextId`), for fighters made without a world: the legacy
 * tests keep their numbering through it. World code never touches it.
 */
export const LEGACY_IDS = new IdCounter(1);

export interface FighterOpts {
  /** Default LEGACY_IDS. */
  ids?: IdCounter;
  /** The fighter's own Rng seed; default `id * 7919 + 13` (DungeonStyle's). A world passes seedFor(seed, 'fighter', id). */
  rngSeed?: number;
}

export class Fighter {
  readonly id: number;
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

  // ---------------------------------------------------------------------------
  // M1 (docs/M1-DESIGN.md §1.5.3). Every default reproduces DungeonStyle; the world sets the rest.
  // ---------------------------------------------------------------------------

  /** Body mass (kg); null: the humanoid body (`baseMassKg`) × scale³. */
  massKg: number | null = null;
  /**
   * The humanoid body's mass at scale 1 (kg), from BODY_MASS_TUNING when the fighter is made, with `boneShare`: both
   * are per-entity state fixed at creation (§1.5.11), so a live edit of the table reaches new fighters only and an
   * existing one keeps bone masses that add up (its mass × its shares). Saved with the fighter (P04).
   */
  baseMassKg = humanoidMass();
  /** Each bone's share of `mass` (m_eff of a struck bone, §4.3), from BODY_MASS_TUNING when the fighter is made. */
  boneShare: Readonly<Record<BoneName, number>> = boneMassShares();
  /** The species' hide (J), the toughness every zone has (0 for humans and apes; rulers use their zones). */
  toughnessJ = 0;
  species: SpeciesId | null = null;
  /** The player id credit goes to ('p1' for the local player); null for creatures. */
  playerId: string | null = null;
  /** The last time something knocked this fighter about, and by whom (environmental kills, §4.4). */
  lastKnock: KnockRecord | null = null;
  /** J added per zone by worn items (Σ of their materials' armourJ), derived when the worn items change (armourFrom, RR-3). */
  armour: Partial<Record<HurtZone, number>> = {};
  ruler: RulerState | null = null;
  /** The ground under this fighter (footwork plants the feet on it); set by CombatSim when not flat. */
  ground: GroundQuery | null = null;
  /** Hands, belt and back (players only). */
  inventory: Inventory | null = null;
  /** What the hands are hauling, derived by the verb system when the hands change. */
  load: { massKg: number; mode: 'carry' | 'drag' | 'rope' } | null = null;
  /** Locomotion written by a mind instead of moveInput (the giant, scripted charges). */
  drive: Drive | null = null;
  /**
   * An upper-body pose blended over the animation (§1.5.3): world mode's locomotion shows it by its weight (see
   * postureShown), its spine, hip height and hands over the walking legs.
   */
  posture: Posture | null = null;
  /**
   * The posture as the body shows it (world mode: a fighter on a world's ground): `posture` ramped in, or the last one
   * ramped out first, by 1/CHARACTER_TUNING.postureRampFrames of full weight a tick, so a posture set or cleared at once
   * (the hands' carry and drag, a mind's sniff) never jumps the pose: a jump moves the head up to 0.2 m in one tick, a
   * 12 m/s self-motion contact (§4.3). Saved (FighterRecord.postureShown). DEVIATION (§1.5.3 and §8.3's FighterRecV1
   * list no such field): the ramp has to survive a load.
   */
  private postureShown: Posture | null = null;
  /**
   * A world point the near hand reaches for over the posture, as far as the arm allows: the grip of a dragged load.
   * Written by the world in every phase 3 before updatePose (CharacterControllers.resolve); null without one. Not
   * saved: written before it is read. DEVIATION (§1.5.3 lists no such field): the sim's fighter sees no entity.
   */
  reachAt: WorldV3 | null = null;
  /** A committed work action (state 'pickup'); see startWork. */
  work: Work | null = null;
  /** A buffered verb, re-tried until it starts or its frames run out (§5.0). */
  verbRequest: { cmd: VerbCommand; frames: number } | null = null;
  /** A focused world point: strikes aim at it when not locked on. */
  verbAim: Vector3 | null = null;
  /** A throw's aim: release() launches at launchSpeed(m, techSpeed) × speedFrac along dir. */
  throwAim: { dir: Vector3; speedFrac: number; techSpeed: number } | null = null;
  /** MOVE_SPRINT | MOVE_CROUCH, from the last move command. */
  moveFlags = 0;
  /**
   * Ticks left on a buffered jump press (MOVE_TUNING.jumpBufferFrames). CombatSim owns the countdown (one tick off
   * after each mover call, in separate()); the character controller only reads it and zeroes it when it jumps.
   */
  jumpRequest = 0;
  /** Idle life paused: no weight shift, look-around, feint or breathing (AC-5's "AI paused", §12.2 I16). */
  idlePaused = false;

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
    opts: FighterOpts = {},
  ) {
    this.id = (opts.ids ?? LEGACY_IDS).take();
    this.stats = { ...DEFAULT_STATS, ...stats };
    this.rng = new Rng(opts.rngSeed ?? this.id * 7919 + 13);
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

  /** Body mass (kg): `massKg`, or the humanoid body as it was when this fighter was made × scale³. */
  get mass(): number {
    return this.massKg ?? this.baseMassKg * this.scale ** 3;
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
    if (s !== 'pickup') {
      this.pickupTarget = null;
      this.work = null;
    }
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
    // (A weapon pickup is no work action: setState keeps `work` within 'pickup'.)
    this.work = null;
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

  /**
   * A committed work action (docs/M1-DESIGN.md §5.0): state 'pickup' for `w.frames` frames, playing `w.keys`; the
   * verb's effect lands at stateFrame === w.actAt through the world (CombatSim.advancePickup), which re-validates it.
   */
  startWork(w: Work) {
    this.setState('pickup');
    this.pickupTarget = null;
    this.pickupRequest = 0;
    this.stunFrames = w.frames;
    this.work = w;
    this.idle.interrupt();
    if (w.keys.length) this.anim.play(w.keys);
  }

  /** @param aimId force a specific aim (tests, scripted moves); otherwise one is picked. */
  startMove(move: MoveDef, isCounter = false, aimId?: string) {
    // Timing fits the body and the tool: big bodies move their limbs slower (like a
    // longer pendulum), small ones quicker; heavy weapons take longer to bring round.
    // Tired arms are slow arms.
    let tempo = Math.sqrt(this.scale) * (move.weapon && this.weapon ? weaponTempo(this.weapon, this.scale) : 1) * (1 + (1 - this.stamina) * 0.6);
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
    const focus = this.focusPoint();
    if (focus && w && move.weapon) return this.pointFit(focus, move, w, lungeLeft);
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
    // The target's height above our own feet (docs/M1-DESIGN.md §4.1): on terrain the feet aren't at y = 0.
    const h = targetHeight(t, aim?.height ?? move.height) + (aim?.edgeDy ?? 0) * t.scale - this.pos.y;
    return {
      target: [side * ahead * 0.5 / this.scale, h / this.scale, ahead / this.scale],
      strikeAt: strikeAtOf(w),
    };
  }

  /**
   * The focused world point a strike aims at (docs/M1-DESIGN.md §5.2, P02b): `verbAim` while it is set and this
   * fighter isn't locked on to a creature (a committed swing at a focused tree goes at the trunk, not at an ape 20 m
   * away). null: strikes aim at the target, as in DungeonStyle.
   */
  private focusPoint(): Vector3 | null {
    return this.verbAim && !this.lockedOn ? this.verbAim : null;
  }

  /**
   * weaponFit for a focused point (§5.2): the weapon's striking part goes to the point itself, measured from our own
   * feet (§4.1). A point is not a body: the lunge stops short of it only by our own half of DungeonStyle's stop
   * distance (0.74 × the two sizes / 2, with a size of 0 for the point), and there is no front of a body to pull back
   * to (DS's 0.1 × target scale).
   */
  private pointFit(at: Vector3, move: MoveDef, w: WeaponDef, lungeLeft: number): WeaponFit {
    const lunge = (move.lunge?.distance ?? 0) * this.scale * lungeLeft;
    const ox = at.x - this.pos.x;
    const oz = at.z - this.pos.z;
    const dist = Math.hypot(ox, oz);
    const ahead = Math.max((0.74 * this.scale) / 2, dist - lunge);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const side = (ox * fz - oz * fx) / Math.max(0.01, dist);
    const h = at.y - this.pos.y;
    return {
      target: [side * ahead * 0.5 / this.scale, h / this.scale, ahead / this.scale],
      strikeAt: strikeAtOf(w),
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
    // (A focused point counts as what it goes for: heightGap measures to it, §5.2.)
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
    const h = aim?.height ?? move.height;
    // A focused point (§5.2) is what the strike goes for, when there is one; else the target's part.
    const focus = this.focusPoint();
    let y: number;
    if (focus) y = focus.y;
    else {
      const t = this.target;
      if (!t || !t.alive) return 0;
      y = targetHeight(t, h);
    }
    // Measured from our own feet (§4.1), so strikes fit the same on raised ground.
    const gap = (y - this.pos.y) / this.scale - AUTHORED_HEIGHT[h];
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

  /**
   * Getting up. `frames` and `keys` default to DungeonStyle's 40-frame kneel-and-rise; the giant rises over 94
   * frames on its own track (§4.7: a 1-frame kneel key would sweep its zones at 398.8 m/s).
   */
  enterGetup(frames = GETUP_FRAMES, keys?: TrackKey[]) {
    this.setState('getup');
    this.stunFrames = frames;
    this.poise = this.stats.maxPoise;
    this.anim.play(
      keys ?? [
        { f: 1, pose: getPose('kneel') },
        { f: Math.floor(frames * 0.55), pose: getPose('kneel') },
        { f: frames, pose: getPose('guard'), ease: 'inOut' },
      ],
    );
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

  /**
   * The cross-fade (frames, at least DS's 6) that takes the body from the pose it shows now back to its stance with the
   * head moving at no more than CHARACTER_TUNING.workHeadSpeedMps (world mode, core-fix): the end of a work action whose
   * bend the head limit held back (limitWorkBend) rose from it in 6 frames at up to 5.6 m/s. The animator's fade is a
   * smoothstep, whose peak speed is 1.5 × its mean; the way is the head's to DS's guard × workRiseMargin (the walking
   * stance stands a little above and behind the guard).
   */
  workFadeFrames(): number {
    const half = SKELETON.head.length / 2;
    forwardKinematics(this.pose, _limRig);
    const from = bonePoint(_limRig, 'head', half, _limFrom);
    forwardKinematics(getPose('guard'), _limRig);
    const d = bonePoint(_limRig, 'head', half, _limTo).distanceTo(from);
    const perTick = (characterTuning('workHeadSpeedMps') * DT) / this.scale;
    return perTick > 0 ? Math.max(6, Math.ceil((1.5 * characterTuning('workRiseMargin') * d) / perTick)) : 6;
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
    // Tripped: the ruler's physics body poses the rig (world/rulerBody.ts writes `pose` from it after each step);
    // here only forward kinematics runs, which reproduces that rig (§4.7). No animation, footwork or idle life.
    if (this.state === 'tripped') {
      forwardKinematics(this.pose, this.rig, this.pos, this.yaw, this.scale);
      return;
    }
    this.breath += 1 / 60;
    this.turnRate = turnRate;
    // World mode (a fighter on a world's ground): the posture ramps toward what is asked (rampPosture).
    const world = this.ground !== null;
    if (world) this.rampPosture();
    const speedFrac = clamp(speed / Math.max(0.1, this.stats.walkSpeed), 0, 1);
    const want = clamp((speed + Math.abs(turnRate) * 20) / Math.max(0.1, this.stats.walkSpeed * 0.6), 0, 1);
    this.moveBlend += (want - this.moveBlend) * 0.25;

    const t = this.target && this.target.alive ? this.target : null;
    const dist = t ? this.distanceTo(t) : Infinity;
    this.updateMotion(t, dist);
    const engaged = dist < 3.2;
    const still = this.state === 'idle' && speed < 0.25;
    this.idle.paused = this.idlePaused;
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
    // On a world's slope the hips go down for a downhill foot (Footwork.updateHipDrop; 0 on level ground).
    if (world) this.footwork.updateHipDrop(this);

    let proc;
    if (this.anim.isProcedural) proc = this.locomotionPose(localDirX, localDirZ, offX, offZ);
    this.anim.update(this.stateFrame, proc);
    // A work action's bend never swings the head faster than workHeadSpeedMps (world mode, core-fix).
    if (world && this.work) this.limitWorkBend(this.anim.out);
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
      // On a slope the hips go down for a downhill foot the leg wouldn't reach (Footwork.hipDrop; 0 on level ground).
      L.root.y -= this.footwork.hipDrop;
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
    if (!driven) this.footwork.syncToRig(this.rig, this);
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

  /**
   * The shown posture one tick on (world mode): toward `posture` at 1/postureRampFrames of full weight a tick; a
   * different posture shown now is ramped out to nothing first, then the asked one in. Fresh objects (`posture` is the
   * setters' to replace).
   */
  private rampPosture(): void {
    const want = this.posture && this.posture.weight > 0 ? this.posture : null;
    const shown = this.postureShown;
    if (!want && !shown) return;
    const step = 1 / Math.max(1, characterTuning('postureRampFrames'));
    if (shown && shown.id !== want?.id) {
      const w = shown.weight - step;
      this.postureShown = w > 0 ? { id: shown.id, weight: w } : null;
      return;
    }
    const cur = shown?.weight ?? 0;
    const to = want!.weight;
    this.postureShown = { id: want!.id, weight: to > cur ? Math.min(to, cur + step) : Math.max(to, cur - step) };
  }

  /**
   * The shown posture over a locomotion pose spec (§1.5.3), by its weight k: the spine's angles and the hands' targets
   * toward the posture's, the hips raised or lowered (and shifted) by the posture's root against the guard's, the feet
   * left to the footwork (so the legs keep walking under it). With a reach point (a dragged grip), the hand on its side
   * reaches for it by k: the arm's IK stops at full stretch, so it gets as near as the arm allows.
   */
  private applyPosture(spec: PoseSpec): void {
    const shown = this.postureShown;
    if (!shown || !(shown.weight > 0)) return;
    const k = Math.min(1, shown.weight);
    const P: PoseSpec = POSE_SPECS[shown.id];
    const mix = (a: V3, b: V3): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const r = spec.root ?? [0, GUARD.root![1], 0];
    const pr = P.root ?? GUARD.root!;
    const gr = GUARD.root!;
    spec.root = [r[0] + (pr[0] - gr[0]) * k, r[1] + (pr[1] - gr[1]) * k, r[2] + (pr[2] - gr[2]) * k];
    for (const b of ['pelvis', 'abdomen', 'chest', 'head'] as const) spec[b] = mix(spec[b] ?? [0, 0, 0], P[b] ?? [0, 0, 0]);
    for (const h of ['handL', 'handR'] as const) {
      const a = spec[h];
      const t = P[h];
      if (!a || !t) continue;
      const side = h === 'handL' ? 1 : -1;
      const hint: V3 = [side * 0.35, -1, 0];
      spec[h] = { at: mix(a.at, t.at), hint: mix(a.hint ?? hint, t.hint ?? hint) };
    }
    const reach = this.reachAt;
    if (reach) {
      // Fighter-local, unscaled: (reach − pos) turned by −yaw, ÷ scale (+x is the left).
      const dx = reach.x - this.pos.x;
      const dz = reach.z - this.pos.z;
      const c = Math.cos(this.yaw);
      const sn = Math.sin(this.yaw);
      const local: V3 = [(dx * c - dz * sn) / this.scale, (reach.y - this.pos.y) / this.scale, (dx * sn + dz * c) / this.scale];
      const h = local[0] >= 0 ? 'handL' : 'handR';
      const a = spec[h];
      if (a) spec[h] = { at: mix(a.at, local), hint: a.hint };
    }
  }

  /**
   * A work action's bend at no more than CHARACTER_TUNING.workHeadSpeedMps at the head (world mode, core-fix): when the
   * track would move the head (the middle of its bone, relative to the feet) further than that in one tick from the pose
   * shown last tick, the pose goes only that far toward it. DungeonStyle's pickup squat, which a take plays over its
   * first half (9 frames for a stick), swung the head 0.53 m at up to 4.7 m/s, plus the step-in's 2.7 m/s: a 6.2 m/s
   * self-motion hit on a block in front, past a human's 6 m/s v_safe, whose hitstun cancelled the take. The pose catches
   * up within the track's hold. DEVIATION (§5.0 plays a work action's pose track as the verb gives it): the verb's
   * timing (its actAt) is unchanged, but the pose now trails the take's track, so the object reaches the hands a few
   * frames before they reach it (a stick taken from the ground is in the hands at actAt while they are still on the way
   * down). The cap holds only while workHeadSpeedMps + VERB_TUNING.workStepM / DT stays under a human's v_safe (tested
   * in tests/posture.test.ts).
   */
  private limitWorkBend(target: Pose): void {
    const max = (characterTuning('workHeadSpeedMps') * DT) / this.scale;
    const half = SKELETON.head.length / 2;
    forwardKinematics(this.pose, _limRig);
    const from = bonePoint(_limRig, 'head', half, _limFrom);
    forwardKinematics(target, _limRig);
    let d = bonePoint(_limRig, 'head', half, _limTo).distanceTo(from);
    if (!(d > max)) return;
    let u = max / d;
    for (let i = 0; i < 3; i++) {
      blendPose(this.pose, target, u, _limPose);
      forwardKinematics(_limPose, _limRig);
      d = bonePoint(_limRig, 'head', half, _limTo).distanceTo(from);
      if (d <= max * 1.001) break;
      u *= max / d;
    }
    copyPose(_limPose, target);
  }

  /** Chest rising and falling: slow and shallow when fresh, fast and heaving when gassed. */
  private breathing(): number {
    // Paused idle life holds the breath where it is: the chest doesn't move, even as the wind comes back.
    if (this.idlePaused) return this.heldBreath;
    const e = 1 - this.stamina;
    this.breathPhase += (2.2 + 4.5 * e) / 60;
    return (this.heldBreath = Math.sin(this.breathPhase) * (0.01 + 0.045 * e * e));
  }
  /**
   * The chest's last breathing offset (held while idle life is paused). Fighter state like `breathPhase`: a save
   * made during a pause has to carry it, or the chest jumps on the first tick after loading.
   * (Saved by toRecord, with breathPhase; IdleBehavior's clocks, timers and offsets by its own record.)
   */
  private heldBreath = 0;

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
    // (Paused idle life keeps the amplitudes it had too, so nothing it adds changes.)
    if (!this.idlePaused) Object.assign(this.idle.mods, { bounce: M.bounce, bounceHz: M.bounceHz, sway: M.sway, head: M.head, feints: M.feints, paws: M.paws });

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
    this.applyPosture(spec);
    // On a slope the hips go down for a downhill foot the leg wouldn't reach (Footwork.hipDrop; 0 on level ground).
    const drop = this.footwork.hipDrop;
    if (drop > 0 && spec.root) spec.root = [spec.root[0], spec.root[1] - drop, spec.root[2]];
    return resolvePose(spec, this.locoPose);
  }

  // ---------------------------------------------------------------------------
  // Save record (docs/M1-DESIGN.md §8.3 FighterRecV1, P04; MAP gap-7 §3.4-3.7)
  // ---------------------------------------------------------------------------

  /**
   * The fighter's own Rng state (uint32). The save keeps every fighter's stream in its `rng.fighters` table (§8.3),
   * apart from this record. IdleBehavior draws from the same Rng object, so setting it here restores both (MAP gap-7
   * §6: the two must stay one stream).
   */
  get rngState(): number {
    return this.rng.state;
  }
  set rngState(v: number) {
    this.rng.state = v;
  }

  /**
   * Everything this fighter needs to resume exactly (MAP gap-7 §3.4-3.5's Save lists, and §8.3's world fields), as
   * plain data with a fixed key order (FighterRecord). References are kept by what they point at: the move as its
   * table, id and tempo bucket (`timed` is pure), the aim by its move and id, the defence by its kind, the target by
   * fighter id, weapons by id (by value only for a weapon that isn't a WEAPONS entry, a tool the world made, §5.2), the
   * weapon being reached for by the id of the drop it lies in (`drops`: the sim's, CombatSim.drops). Animation keys and
   * poses are by value.
   *
   * Not here: the Rng state (`rngState`, saved in the save's rng table), `ruler` (the save's `rulers`), `ground` (the
   * world's, set again when the fighter joins a sim), `rig` (forward kinematics of the saved pose rebuild it), and
   * per-tick scratch rewritten before it is read (`turnRate`, `breath`, `motionTarget`, `motionInfo`, `locoPose`,
   * `layered`, the impact, retract and react poses, the footwork's mods).
   */
  toRecord(drops: readonly Drop[]): FighterRecord {
    const pt = this.pickupTarget;
    const d = this.defense;
    const dc = this.defenseCooldown;
    const k = this.lastKnock;
    const w = this.work;
    return {
      id: this.id,
      moves: movesKey(this.moves),
      pos: v3Record(this.pos),
      vel: v3Record(this.vel),
      moveInput: v3Record(this.moveInput),
      walkVel: v3Record(this.walkVel),
      yaw: this.yaw,
      scale: this.scale,
      hp: this.hp,
      guard: this.guard,
      poise: this.poise,
      state: this.state,
      stateFrame: this.stateFrame,
      stunFrames: this.stunFrames,
      move: this.moveRecord(),
      attackEnd: this.attackEnd,
      stuckUntil: this.stuckUntil,
      attackSerial: this.attackSerial,
      hitThisAttack: this.hitThisAttack,
      isCounterAttack: this.isCounterAttack,
      perfectCounter: this.perfectCounter,
      isPerfectCounter: this.isPerfectCounter,
      aim: this.aimRecord(),
      strikeHeight: this.strikeHeight,
      defense: d ? { kind: d.def.kind, threatSerial: d.threatSerial, phase: d.phase, success: d.success, side: d.side } : null,
      counter: this.counter ? { kind: this.counter.kind, frames: this.counter.frames } : null,
      lastDefendedSerial: this.lastDefendedSerial,
      defenseCooldown: { block: dc.block, duck: dc.duck, weave: dc.weave, slide: dc.slide },
      defenseManual: this.defenseManual,
      perfectSerial: this.perfectSerial,
      dodgedSerial: this.dodgedSerial,
      weaveSide: this.weaveSide,
      buffer: this.buffer ? { button: this.buffer.button, frames: this.buffer.frames } : null,
      target: this.target ? this.target.id : null,
      combo: this.combo,
      framesSinceBlock: this.framesSinceBlock,
      framesSinceHit: this.framesSinceHit,
      framesSinceLanded: this.framesSinceLanded,
      framesSinceDefend: this.framesSinceDefend,
      misreadSerial: this.misreadSerial,
      lockedOn: this.lockedOn,
      minHp: this.minHp,
      stamina: this.stamina,
      pickupRequest: this.pickupRequest,
      pickupTarget: pt
        ? { drop: drops.find((x) => x.pos === pt.pos)?.id ?? null, pos: v3Record(pt.pos), weapon: weaponRecord(pt.weapon), grabAt: pt.grabAt }
        : null,
      ammo: this.ammo ? { weapon: weaponRecord(this.ammo.weapon), count: this.ammo.count } : null,
      airStep: v3Record(this.airStep),
      weapon: this.weapon ? weaponRecord(this.weapon) : null,
      wounds: this.wounds.map(woundRecord),
      severed: [...this.severed],
      torn: [...this.torn],
      limbDamage: entriesRecord(this.limbDamage),
      hitReaction: this.hitReaction,
      autoDefense: this.autoDefense,
      readSkill: this.readSkill,
      repeatCount: this.repeatCount,
      lastMoveId: this.lastMoveId,
      sinceMoveStart: this.sinceMoveStart,
      swingStamina: this.swingStamina,
      wasBlocked: this.wasBlocked,
      stats: fieldsRecord(this.stats, DEFAULT_STATS),
      swingJitter: [this.swingJitter[0], this.swingJitter[1], this.swingJitter[2]],
      swingViaMid: this.swingViaMid,
      swingDy: this.swingDy,
      anim: this.anim.toRecord(),
      footwork: this.footwork.toRecord(),
      idle: this.idle.toRecord(),
      motion: fieldsRecord(this.motion, this.motion),
      lookPitch: this.lookPitch,
      bank: this.bank,
      breathPhase: this.breathPhase,
      heldBreath: this.heldBreath,
      headTrack: this.headTrack,
      moveBlend: this.moveBlend,
      pose: poseToRecord(this.pose),
      massKg: this.massKg,
      baseMassKg: this.baseMassKg,
      boneShare: entriesRecord(this.boneShare),
      toughnessJ: this.toughnessJ,
      species: this.species,
      playerId: this.playerId,
      lastKnock: k ? { tick: k.tick, cause: causeRecord(k.cause), by: k.by } : null,
      armour: entriesRecord(this.armour),
      inventory: inventoryRecord(this.inventory),
      load: this.load ? { massKg: this.load.massKg, mode: this.load.mode } : null,
      drive: this.drive ? { heading: this.drive.heading, speed: this.drive.speed, accel: this.drive.accel, climb: this.drive.climb } : null,
      posture: this.posture ? { id: this.posture.id, weight: this.posture.weight } : null,
      postureShown: this.postureShown ? { id: this.postureShown.id, weight: this.postureShown.weight } : null,
      work: w
        ? { kind: w.kind, frames: w.frames, actAt: w.actAt, faceAt: v3Record(w.faceAt), keys: w.keys.map(trackKeyToRecord), cmd: w.cmd ? cloneCommand(w.cmd) : null }
        : null,
      verbRequest: this.verbRequest ? { cmd: cloneCommand(this.verbRequest.cmd), frames: this.verbRequest.frames } : null,
      verbAim: this.verbAim ? v3Record(this.verbAim) : null,
      throwAim: this.throwAim ? { dir: v3Record(this.throwAim.dir), speedFrac: this.throwAim.speedFrac, techSpeed: this.throwAim.techSpeed } : null,
      moveFlags: this.moveFlags,
      jumpRequest: this.jumpRequest,
      idlePaused: this.idlePaused,
    };
  }

  /**
   * Puts back a toRecord() state into this fighter, which must have been made the way the saved one was (same id,
   * same move table, same style), as a loader makes it (MAP gap-7 §3.6-3.7):
   * - construct it (that draws its idle clocks from its Rng: overwritten here) and add it to its sim first, since
   *   CombatSim.add runs one updatePose that would advance the restored state; then restore;
   * - set `rngState` too (the save keeps it apart from this record);
   * - `ctx.fighters` holds every fighter of the sim (the target is found by id), `ctx.drops` the sim's drops (the weapon
   *   being reached for is re-linked to the drop it lies in; if that drop is gone, a detached copy fails the pickup
   *   just as the original would have).
   * `rig` is rebuilt by forward kinematics of the restored pose: exactly the tick-end rig of a legacy fight (MAP gap-7
   * §3.5). TODO(P13, M3 save-load-save gate, SPEC:917): in world mode phase 13a (downed.postStep) and 13b
   * (rulers.postStep) move f.pos after updatePose, so a downed player's or ape's tick-end rig is not FK at the saved
   * pos; an exact world-mode restore must save the rig or rebuild it at the pre-13a position.
   */
  restoreRecord(r: FighterRecord, ctx: FighterRestoreContext) {
    if (r.id !== this.id) throw new Error(`Fighter.restoreRecord: a record of fighter ${r.id} given to fighter ${this.id}`);
    const moves = movesKey(this.moves);
    if (r.moves !== moves) throw new Error(`Fighter.restoreRecord: fighter ${this.id} was saved with the ${r.moves ?? 'custom'} moves, made with the ${moves ?? 'custom'} moves`);
    // Every field goes through a checking reader (body/animator.ts): a broken save fails at the field it breaks.
    const n = numFromRecord;
    const b = boolFromRecord;
    readV3(r.pos, this.pos, 'pos');
    readV3(r.vel, this.vel, 'vel');
    readV3(r.moveInput, this.moveInput, 'moveInput');
    readV3(r.walkVel, this.walkVel, 'walkVel');
    this.yaw = n(r.yaw, 'yaw');
    this.scale = n(r.scale, 'scale');
    this.hp = n(r.hp, 'hp');
    this.guard = n(r.guard, 'guard');
    this.poise = n(r.poise, 'poise');
    this.state = enumFromRecord(r.state, FIGHTER_STATES, 'state');
    this.stateFrame = n(r.stateFrame, 'stateFrame');
    this.stunFrames = n(r.stunFrames, 'stunFrames');
    this.move = this.moveFromRecord(r.move);
    this.attackEnd = n(r.attackEnd, 'attackEnd');
    this.stuckUntil = n(r.stuckUntil, 'stuckUntil');
    this.attackSerial = n(r.attackSerial, 'attackSerial');
    this.hitThisAttack = b(r.hitThisAttack, 'hitThisAttack');
    this.isCounterAttack = b(r.isCounterAttack, 'isCounterAttack');
    this.perfectCounter = b(r.perfectCounter, 'perfectCounter');
    this.isPerfectCounter = b(r.isPerfectCounter, 'isPerfectCounter');
    this.aim = this.aimFromRecord(r.aim);
    this.strikeHeight = enumFromRecord(r.strikeHeight, HEIGHTS, 'strikeHeight');
    const d = r.defense;
    this.defense = d
      ? {
          def: DEFENSES[enumFromRecord(d.kind, DEFENSES, 'defense.kind')],
          threatSerial: n(d.threatSerial, 'defense.threatSerial'),
          phase: enumFromRecord(d.phase, DEFENSE_PHASES, 'defense.phase'),
          success: b(d.success, 'defense.success'),
          side: signFromRecord(d.side, 'defense.side'),
        }
      : null;
    this.counter = r.counter ? { kind: enumFromRecord(r.counter.kind, DEFENSES, 'counter.kind'), frames: n(r.counter.frames, 'counter.frames') } : null;
    this.lastDefendedSerial = n(r.lastDefendedSerial, 'lastDefendedSerial');
    for (const kind of Object.keys(this.defenseCooldown) as DefenseKind[]) this.defenseCooldown[kind] = n(r.defenseCooldown[kind], `defenseCooldown.${kind}`);
    this.defenseManual = b(r.defenseManual, 'defenseManual');
    this.perfectSerial = n(r.perfectSerial, 'perfectSerial');
    this.dodgedSerial = n(r.dodgedSerial, 'dodgedSerial');
    this.weaveSide = signFromRecord(r.weaveSide, 'weaveSide');
    this.buffer = r.buffer ? { button: enumFromRecord(r.buffer.button, BUTTON_SET, 'buffer.button'), frames: n(r.buffer.frames, 'buffer.frames') } : null;
    this.target = r.target === null ? null : fighterById(ctx.fighters, n(r.target, 'target'), this.id);
    this.combo = n(r.combo, 'combo');
    this.framesSinceBlock = n(r.framesSinceBlock, 'framesSinceBlock');
    this.framesSinceHit = n(r.framesSinceHit, 'framesSinceHit');
    this.framesSinceLanded = n(r.framesSinceLanded, 'framesSinceLanded');
    this.framesSinceDefend = n(r.framesSinceDefend, 'framesSinceDefend');
    this.misreadSerial = n(r.misreadSerial, 'misreadSerial');
    this.lockedOn = b(r.lockedOn, 'lockedOn');
    this.minHp = n(r.minHp, 'minHp');
    this.stamina = n(r.stamina, 'stamina');
    this.pickupRequest = n(r.pickupRequest, 'pickupRequest');
    const pt = r.pickupTarget;
    if (pt) {
      // The drop it lies in, when that is still there: the pickup finds it by its pos and weapon objects.
      const drop = pt.drop === null ? undefined : ctx.drops.find((x) => x.id === pt.drop);
      this.pickupTarget = {
        pos: drop ? drop.pos : readV3(pt.pos, new Vector3(), 'pickupTarget.pos'),
        weapon: drop ? drop.weapon : weaponFromRecord(pt.weapon, 'pickupTarget.weapon'),
        grabAt: n(pt.grabAt, 'pickupTarget.grabAt'),
      };
    } else this.pickupTarget = null;
    this.ammo = r.ammo ? { weapon: weaponFromRecord(r.ammo.weapon, 'ammo.weapon'), count: n(r.ammo.count, 'ammo.count') } : null;
    readV3(r.airStep, this.airStep, 'airStep');
    this.weapon = r.weapon ? weaponFromRecord(r.weapon, 'weapon') : null;
    this.wounds.length = 0;
    for (const wr of r.wounds) this.wounds.push(woundFromRecord(wr));
    this.severed.clear();
    for (const bone of r.severed) this.severed.add(enumFromRecord(bone, SKELETON, 'severed'));
    this.torn.clear();
    for (const t of r.torn) this.torn.add(strFromRecord(t, 'torn'));
    for (const bone of Object.keys(this.limbDamage) as BoneName[]) delete this.limbDamage[bone];
    for (const [bone, v] of r.limbDamage) this.limbDamage[enumFromRecord(bone, SKELETON, 'limbDamage')] = n(v, `limbDamage.${bone}`);
    this.hitReaction = enumFromRecord(r.hitReaction, POSE_SPECS, 'hitReaction');
    this.autoDefense = b(r.autoDefense, 'autoDefense');
    this.readSkill = n(r.readSkill, 'readSkill');
    this.repeatCount = n(r.repeatCount, 'repeatCount');
    this.lastMoveId = strFromRecord(r.lastMoveId, 'lastMoveId');
    this.sinceMoveStart = n(r.sinceMoveStart, 'sinceMoveStart');
    this.swingStamina = n(r.swingStamina, 'swingStamina');
    this.wasBlocked = b(r.wasBlocked, 'wasBlocked');
    for (const key of Object.keys(DEFAULT_STATS) as (keyof FighterStats)[]) this.stats[key] = n(r.stats[key], `stats.${key}`);
    this.swingJitter = [n(r.swingJitter[0], 'swingJitter[0]'), n(r.swingJitter[1], 'swingJitter[1]'), n(r.swingJitter[2], 'swingJitter[2]')];
    this.swingViaMid = b(r.swingViaMid, 'swingViaMid');
    this.swingDy = n(r.swingDy, 'swingDy');
    this.anim.restoreRecord(r.anim);
    this.footwork.restoreRecord(r.footwork);
    this.idle.restoreRecord(r.idle);
    for (const key of Object.keys(this.motion) as (keyof MotionProfile)[]) this.motion[key] = n(r.motion[key], `motion.${key}`);
    this.lookPitch = n(r.lookPitch, 'lookPitch');
    this.bank = n(r.bank, 'bank');
    this.breathPhase = n(r.breathPhase, 'breathPhase');
    this.heldBreath = n(r.heldBreath, 'heldBreath');
    this.headTrack = n(r.headTrack, 'headTrack');
    this.moveBlend = n(r.moveBlend, 'moveBlend');
    poseFromRecord(r.pose, this.pose);
    this.massKg = nullableNum(r.massKg, 'massKg');
    this.baseMassKg = n(r.baseMassKg, 'baseMassKg');
    const share = {} as Record<BoneName, number>;
    for (const [bone, v] of r.boneShare) share[enumFromRecord(bone, SKELETON, 'boneShare')] = n(v, `boneShare.${bone}`);
    if (Object.keys(share).length !== BONES.length) throw new Error(`Fighter.restoreRecord: fighter ${this.id}'s boneShare has ${Object.keys(share).length} bones, not ${BONES.length}`);
    this.boneShare = share;
    this.toughnessJ = n(r.toughnessJ, 'toughnessJ');
    this.species = r.species === null ? null : enumFromRecord(r.species, SPECIES, 'species');
    this.playerId = r.playerId === null ? null : strFromRecord(r.playerId, 'playerId');
    const k = r.lastKnock;
    this.lastKnock = k ? { tick: n(k.tick, 'lastKnock.tick'), cause: causeFromRecord(k.cause), by: nullableNum(k.by, 'lastKnock.by') } : null;
    const armour: Partial<Record<HurtZone, number>> = {};
    for (const [z, v] of r.armour) armour[enumFromRecord(z, HURT_ZONES, 'armour')] = n(v, `armour.${z}`);
    this.armour = armour;
    this.inventory = inventoryFromRecord(r.inventory);
    this.load = r.load ? { massKg: n(r.load.massKg, 'load.massKg'), mode: enumFromRecord(r.load.mode, LOAD_MODES, 'load.mode') } : null;
    const dr = r.drive;
    this.drive = dr ? { heading: n(dr.heading, 'drive.heading'), speed: n(dr.speed, 'drive.speed'), accel: n(dr.accel, 'drive.accel'), climb: b(dr.climb, 'drive.climb') } : null;
    this.posture = r.posture ? { id: enumFromRecord(r.posture.id, POSTURES, 'posture.id'), weight: n(r.posture.weight, 'posture.weight') } : null;
    this.postureShown = r.postureShown
      ? { id: enumFromRecord(r.postureShown.id, POSTURES, 'postureShown.id'), weight: n(r.postureShown.weight, 'postureShown.weight') }
      : null;
    this.work = r.work ? workFromRecord(r.work) : null;
    // (A command is checked by the verb system when it is used, as every command is: §5.0.)
    this.verbRequest = r.verbRequest ? { cmd: cloneCommand(r.verbRequest.cmd), frames: n(r.verbRequest.frames, 'verbRequest.frames') } : null;
    this.verbAim = r.verbAim ? readV3(r.verbAim, new Vector3(), 'verbAim') : null;
    const ta = r.throwAim;
    this.throwAim = ta ? { dir: readV3(ta.dir, new Vector3(), 'throwAim.dir'), speedFrac: n(ta.speedFrac, 'throwAim.speedFrac'), techSpeed: n(ta.techSpeed, 'throwAim.techSpeed') } : null;
    this.moveFlags = n(r.moveFlags, 'moveFlags');
    this.jumpRequest = n(r.jumpRequest, 'jumpRequest');
    this.idlePaused = b(r.idlePaused, 'idlePaused');
    // Set from idlePaused before every tick anyway; kept in step so the restored fighter reads the same at once.
    this.idle.paused = this.idlePaused;
    forwardKinematics(this.pose, this.rig, this.pos, this.yaw, this.scale);
  }

  /** The move in progress as its table, key and tempo bucket (timed() is pure: the key rebuilds the same frame data). */
  private moveRecord(): MoveRefRecord | null {
    const m = this.move;
    if (!m) return null;
    const tables = moveTables(this);
    // Under its own id first (every table today keys a move by its id), then anywhere in the tables.
    for (const [source, table] of tables) {
      const base = own(table, m.id);
      const tempoKey = base ? timedKeyOf(base, m) : undefined;
      if (tempoKey !== undefined) return { source, id: m.id, tempoKey };
    }
    for (const [source, table] of tables) {
      for (const id of Object.keys(table)) {
        const tempoKey = timedKeyOf(table[id], m);
        if (tempoKey !== undefined) return { source, id, tempoKey };
      }
    }
    throw new Error(`Fighter.toRecord: fighter ${this.id}'s move ${m.id} is in neither its move table nor WEAPON_MOVES`);
  }

  private moveFromRecord(r: MoveRefRecord | null): MoveDef | null {
    if (!r) return null;
    const source = enumFromRecord(r.source, MOVE_SOURCES, 'move.source');
    const base = own(source === 'weapon' ? WEAPON_MOVES : this.moves, strFromRecord(r.id, 'move.id'));
    if (!base) throw new Error(`Fighter.restoreRecord: fighter ${this.id} has no ${r.source} move ${r.id}`);
    if (r.tempoKey === null) return base;
    strFromRecord(r.tempoKey, 'move.tempoKey');
    const m = timed(base, Number(r.tempoKey));
    if (timedKeyOf(base, m) !== r.tempoKey) throw new Error(`Fighter.restoreRecord: move ${r.id} at tempo ${r.tempoKey} doesn't rebuild`);
    return m;
  }

  /** The aim (an object of some move's `aims`, shared by its timed copies) as that move and the aim's id. */
  private aimRecord(): AimRecord | null {
    const a = this.aim;
    if (!a) return null;
    for (const [source, table] of moveTables(this)) {
      for (const move of Object.keys(table)) {
        const aims = table[move].aims;
        if (aims && aims.includes(a) && aims.find((x) => x.id === a.id) === a) return { source, move, id: a.id };
      }
    }
    throw new Error(`Fighter.toRecord: fighter ${this.id}'s aim ${a.id} is in no move of its tables`);
  }

  private aimFromRecord(r: AimRecord | null): Aim | null {
    if (!r) return null;
    const table = enumFromRecord(r.source, MOVE_SOURCES, 'aim.source') === 'weapon' ? WEAPON_MOVES : this.moves;
    const a = own(table, strFromRecord(r.move, 'aim.move'))?.aims?.find((x) => x.id === r.id);
    if (!a) throw new Error(`Fighter.restoreRecord: fighter ${this.id} has no aim ${r.id} on its ${r.source} move ${r.move}`);
    return a;
  }
}

// Keyed by the move itself: different moves can share an id (the player's hook and an
// enemy's haymaker are both 'hook').
const _timed = new WeakMap<MoveDef, Map<string, MoveDef>>();

/** The least wind-up (frames) an opponent's strike gets: enough to see it and react. */
export const ENEMY_MIN_STARTUP = 15;

/**
 * A move with its frame data stretched (>1 slower) — cached per move and tempo, to the
 * hundredth. The frames come from that rounded tempo, so what the cache holds depends
 * only on its key, never on which caller's tempo filled it first (rule 7).
 */
export function timed(m: MoveDef, tempo: number): MoveDef {
  if (Math.abs(tempo - 1) < 0.03) return m;
  const key = tempo.toFixed(2);
  let byTempo = _timed.get(m);
  if (!byTempo) _timed.set(m, (byTempo = new Map()));
  let t = byTempo.get(key);
  if (!t) {
    const k = Number(key);
    const f = (n: number) => Math.round(n * k);
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
const _limRig = makeRig();
const _limPose = makePose();
const _limFrom = new Vector3();
const _limTo = new Vector3();
const _flipQ = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);
const _com = new Vector3();
/** m/s². */
export const GRAVITY = 9.81;

/**
 * A CHARACTER_TUNING value (world/characters.ts, P08), read through the registry by name at use time: the body's
 * posture ramp and work-bend limit are world mode's (a fighter on a world's ground), and the sim imports no world module.
 */
function characterTuning(key: 'postureRampFrames' | 'workHeadSpeedMps' | 'workRiseMargin'): number {
  const v = getTuningValue('CHARACTER_TUNING', key);
  if (typeof v !== 'number') throw new Error(`CHARACTER_TUNING.${key} is not a number`);
  return v;
}
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

/** The distance along a weapon of the part a fitted swing lands with (just short of the tip; a two-handed blade's further in). */
function strikeAtOf(w: WeaponDef): number {
  return Math.max(w.strikeFrom + 0.06, w.length - (w.edge === 'blade' && w.style === 'twoHand' ? 0.14 : 0.08));
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

// ---------------------------------------------------------------------------
// Fighter records (docs/M1-DESIGN.md §8.3 FighterRecV1, P04; MAP gap-7 §3.4-3.7)
// ---------------------------------------------------------------------------

/**
 * The move in progress by reference (§8.3): its table ('own': the fighter's moves; 'weapon': WEAPON_MOVES), its key
 * there, and the tempo bucket of its timed copy (`tempo.toFixed(2)`; null: the table's own object, untimed).
 */
export type MoveRefRecord = { source: 'own' | 'weapon'; id: string; tempoKey: string | null };

/** The aim of the current (or last) strike: a move whose `aims` hold it, and its id there. */
export type AimRecord = { source: 'own' | 'weapon'; move: string; id: string };

/**
 * A weapon: its id, and its definition by value when the fighter's weapon isn't the shared WEAPONS[id] object (a tool
 * the world synthesised from an entity, §5.2); null: the WEAPONS entry itself, whose identity the sim relies on.
 */
export type WeaponRecord = { id: WeaponId; def: WeaponDef | null };

/**
 * What Fighter.restoreRecord re-links against: every fighter of the sim, and its drops (required: without them a
 * weapon being reached for would be detached from the drop it lies in, and the pickup would fail after a load).
 */
export type FighterRestoreContext = { fighters: readonly Fighter[]; drops: readonly Drop[] };

/**
 * A fighter's saved state (Fighter.toRecord; the save's FighterRecV1, §8.3), in this key order. Vectors are V3, sets
 * and maps are arrays in their live (insertion) order, poses and animation keys are by value.
 */
export type FighterRecord = {
  id: number;
  /** The move table the fighter was made with: PLAYER_MOVES, ENEMY_MOVES, or null for another table. */
  moves: 'player' | 'enemy' | null;
  pos: WorldV3;
  vel: WorldV3;
  moveInput: WorldV3;
  walkVel: WorldV3;
  yaw: number;
  scale: number;
  hp: number;
  guard: number;
  poise: number;
  state: FighterState;
  stateFrame: number;
  stunFrames: number;
  move: MoveRefRecord | null;
  attackEnd: number;
  stuckUntil: number;
  attackSerial: number;
  hitThisAttack: boolean;
  isCounterAttack: boolean;
  perfectCounter: boolean;
  isPerfectCounter: boolean;
  aim: AimRecord | null;
  strikeHeight: Height;
  /** `def` is DEFENSES[kind]. */
  defense: { kind: DefenseKind; threatSerial: number; phase: ActiveDefense['phase']; success: boolean; side: 1 | -1 } | null;
  counter: { kind: DefenseKind; frames: number } | null;
  lastDefendedSerial: number;
  defenseCooldown: Record<DefenseKind, number>;
  defenseManual: boolean;
  perfectSerial: number;
  dodgedSerial: number;
  weaveSide: 1 | -1;
  buffer: { button: Button; frames: number } | null;
  /** Fighter id. */
  target: number | null;
  combo: number;
  framesSinceBlock: number;
  framesSinceHit: number;
  framesSinceLanded: number;
  framesSinceDefend: number;
  misreadSerial: number;
  lockedOn: boolean;
  minHp: number;
  stamina: number;
  pickupRequest: number;
  /** `drop`: the id of the drop whose pos it is (null: none any more). */
  pickupTarget: { drop: number | null; pos: WorldV3; weapon: WeaponRecord; grabAt: number } | null;
  ammo: { weapon: WeaponRecord; count: number } | null;
  airStep: WorldV3;
  weapon: WeaponRecord | null;
  wounds: { bone: BoneName; local: [number, number, number]; angle: number; length: number; bleed: number; floor: number; stump: BoneName | null }[];
  severed: BoneName[];
  torn: string[];
  limbDamage: [BoneName, number][];
  hitReaction: PoseName;
  autoDefense: boolean;
  readSkill: number;
  repeatCount: number;
  lastMoveId: string;
  sinceMoveStart: number;
  swingStamina: number;
  wasBlocked: boolean;
  /** In DEFAULT_STATS' key order. */
  stats: FighterStats;
  swingJitter: [number, number, number];
  swingViaMid: boolean;
  swingDy: number;
  anim: AnimatorRecord;
  footwork: FootworkRecord;
  idle: IdleRecord;
  motion: MotionProfile;
  lookPitch: number;
  bank: number;
  breathPhase: number;
  heldBreath: number;
  headTrack: number;
  moveBlend: number;
  pose: PoseRecord;
  // The world fields (§1.5.3, §8.3).
  massKg: number | null;
  baseMassKg: number;
  /** In the key order of boneMassShares() (BONES order). */
  boneShare: [BoneName, number][];
  toughnessJ: number;
  species: SpeciesId | null;
  playerId: string | null;
  lastKnock: { tick: number; cause: ImpactCause; by: number | null } | null;
  armour: [HurtZone, number][];
  inventory: Inventory | null;
  load: { massKg: number; mode: 'carry' | 'drag' | 'rope' } | null;
  drive: Drive | null;
  posture: Posture | null;
  /** The posture as shown (ramped toward `posture`, §1.5.3). */
  postureShown: Posture | null;
  work: { kind: Work['kind']; frames: number; actAt: number; faceAt: WorldV3; keys: TrackKeyRecord[]; cmd: VerbCommand | null } | null;
  verbRequest: { cmd: VerbCommand; frames: number } | null;
  verbAim: WorldV3 | null;
  throwAim: { dir: WorldV3; speedFrac: number; techSpeed: number } | null;
  moveFlags: number;
  jumpRequest: number;
  idlePaused: boolean;
};

function movesKey(m: Readonly<Record<string, MoveDef>>): 'player' | 'enemy' | null {
  return m === PLAYER_MOVES ? 'player' : m === ENEMY_MOVES ? 'enemy' : null;
}

/** The tables a fighter's moves come from (as moveDef reads them: weapon techniques, then its own). */
function moveTables(f: Fighter): readonly (readonly ['weapon' | 'own', Readonly<Record<string, MoveDef>>])[] {
  return [
    ['weapon', WEAPON_MOVES],
    ['own', f.moves],
  ];
}

/** An own property of a table (a move or weapon id never reaches the prototype). */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** null: `m` is `base` itself; a key: `m` is base's timed copy in that tempo bucket; undefined: neither. */
function timedKeyOf(base: MoveDef, m: MoveDef): string | null | undefined {
  if (m === base) return null;
  const byTempo = _timed.get(base);
  if (byTempo) for (const [key, t] of byTempo) if (t === m) return key;
  return undefined;
}

function fighterById(fighters: readonly Fighter[], id: number, of: number): Fighter {
  const f = fighters.find((o) => o.id === id);
  if (!f) throw new Error(`Fighter.restoreRecord: fighter ${of}'s target ${id} is not among the sim's fighters`);
  return f;
}

/**
 * A deep copy of plain data (numbers, strings, booleans, arrays, plain objects) in its key order; undefined fields are
 * left out. (CombatSim's records use it too.)
 */
export function clonePlain<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clonePlain(x)) as T;
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = clonePlain(x);
    }
    return o as T;
  }
  return v;
}

/** A weapon as a record: null `def` for the shared WEAPONS entry, else its definition by value (the one shape in a save). */
export function weaponRecord(w: WeaponDef): WeaponRecord {
  return { id: w.id, def: own(WEAPONS, w.id) === w ? null : clonePlain(w) };
}

/**
 * A weapon record read back: a WEAPONS entry by id, or a synthesised tool's definition by value, whose id must be the
 * record's (fighters' and CombatSim's records alike). Anything else (not an object, an unknown id, a definition of
 * another id) is a broken record and throws a `save record:` error naming `field`. The definition by value is copied as
 * it is: its fields are the WeaponDef type's, checked by P13's schema validation of the save (docs/M1-DESIGN.md §8.3).
 */
export function weaponFromRecord(v: unknown, field: string): WeaponDef {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw brokenRecord(field, v, 'an object');
  const r = v as Readonly<Record<string, unknown>>;
  const id = strFromRecord(r.id, `${field}.id`);
  if (r.def !== null) {
    const def = r.def;
    if (def === null || typeof def !== 'object' || Array.isArray(def)) throw brokenRecord(`${field}.def`, def, 'an object');
    const did = (def as Readonly<Record<string, unknown>>).id;
    if (did !== id) throw brokenRecord(`${field}.def.id`, did, `the record's weapon id ${JSON.stringify(id)}`);
    return clonePlain(def) as unknown as WeaponDef;
  }
  const w = own(WEAPONS, id);
  if (!w) throw new Error(`save record: ${field} is weapon ${JSON.stringify(id)}, which doesn't exist`);
  return w;
}

function brokenRecord(field: string, v: unknown, what: string): Error {
  return new Error(`save record: ${field} is ${v === undefined ? 'missing' : JSON.stringify(v)}, not ${what}`);
}

function woundRecord(w: Wound): FighterRecord['wounds'][number] {
  return { bone: w.bone, local: [w.local[0], w.local[1], w.local[2]], angle: w.angle, length: w.length, bleed: w.bleed, floor: w.floor, stump: w.stump ?? null };
}

function woundFromRecord(r: FighterRecord['wounds'][number]): Wound {
  const n = numFromRecord;
  const w: Wound = {
    bone: enumFromRecord(r.bone, SKELETON, 'wound.bone'),
    local: [n(r.local[0], 'wound.local[0]'), n(r.local[1], 'wound.local[1]'), n(r.local[2], 'wound.local[2]')],
    angle: n(r.angle, 'wound.angle'),
    length: n(r.length, 'wound.length'),
    bleed: n(r.bleed, 'wound.bleed'),
    floor: n(r.floor, 'wound.floor'),
  };
  if (r.stump !== null) w.stump = enumFromRecord(r.stump, SKELETON, 'wound.stump');
  return w;
}

/** A partial map of numbers as [key, value] pairs in its key order. */
function entriesRecord<K extends string>(o: Readonly<Partial<Record<K, number>>>): [K, number][] {
  const out: [K, number][] = [];
  for (const k of Object.keys(o) as K[]) {
    const v = o[k];
    if (v !== undefined) out.push([k, v]);
  }
  return out;
}

/** A copy of a flat record in the key order of `order` (a table of defaults, or the object itself). */
function fieldsRecord<T extends object>(o: T, order: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(order)) out[k] = (o as Record<string, unknown>)[k];
  return out as T;
}

/** A plain V3 read back from a record (for fields that hold a V3, not a Vector3 the fighter owns). */
function plainV3(r: WorldV3, field: string): WorldV3 {
  return { x: numFromRecord(r.x, `${field}.x`), y: numFromRecord(r.y, `${field}.y`), z: numFromRecord(r.z, `${field}.z`) };
}

function nullableNum(v: number | null, field: string): number | null {
  return v === null ? null : numFromRecord(v, field);
}

function causeRecord(c: ImpactCause): ImpactCause {
  return { kind: c.kind, entityId: c.entityId, fighterId: c.fighterId, credit: [...c.credit], held: c.held, feature: c.feature };
}

function causeFromRecord(c: ImpactCause): ImpactCause {
  return {
    kind: enumFromRecord(c.kind, CAUSE_KINDS, 'cause.kind'),
    entityId: nullableNum(c.entityId, 'cause.entityId'),
    fighterId: nullableNum(c.fighterId, 'cause.fighterId'),
    credit: c.credit.map((x) => strFromRecord(x, 'cause.credit')),
    held: boolFromRecord(c.held, 'cause.held'),
    feature: enumFromRecord(c.feature, CAUSE_FEATURES, 'cause.feature'),
  };
}

function inventoryRecord(inv: Inventory | null): Inventory | null {
  if (!inv) return null;
  const h = inv.hands;
  return {
    hands: h ? { entity: h.entity, mode: h.mode, grip: v3Record(h.grip), twoHanded: h.twoHanded, joint: h.joint } : null,
    belt: [inv.belt[0], inv.belt[1], inv.belt[2]],
    back: inv.back,
  };
}

function inventoryFromRecord(r: Inventory | null): Inventory | null {
  if (!r) return null;
  const h = r.hands;
  return {
    hands: h
      ? {
          entity: numFromRecord(h.entity, 'hands.entity'),
          mode: enumFromRecord(h.mode, HAND_MODES, 'hands.mode'),
          grip: plainV3(h.grip, 'hands.grip'),
          twoHanded: boolFromRecord(h.twoHanded, 'hands.twoHanded'),
          joint: nullableNum(h.joint, 'hands.joint'),
        }
      : null,
    belt: [nullableNum(r.belt[0], 'belt[0]'), nullableNum(r.belt[1], 'belt[1]'), nullableNum(r.belt[2], 'belt[2]')],
    back: nullableNum(r.back, 'back'),
  };
}

function workFromRecord(r: NonNullable<FighterRecord['work']>): Work {
  const n = numFromRecord;
  const w: Work = {
    kind: enumFromRecord(r.kind, VERBS, 'work.kind'),
    frames: n(r.frames, 'work.frames'),
    actAt: n(r.actAt, 'work.actAt'),
    faceAt: plainV3(r.faceAt, 'work.faceAt'),
    keys: r.keys.map(trackKeyFromRecord),
  };
  if (r.cmd) w.cmd = cloneCommand(r.cmd);
  return w;
}

// The closed sets the record readers check (typed Record<Union, true>: the compiler keeps each complete as its union
// grows). Bones, poses, defences and weapons are checked against their own tables (SKELETON, POSE_SPECS, DEFENSES,
// WEAPONS).
const FIGHTER_STATES: Record<FighterState, true> = {
  idle: true,
  walk: true,
  attack: true,
  defend: true,
  hitstun: true,
  blockstun: true,
  guardbreak: true,
  knockdown: true,
  getup: true,
  ko: true,
  celebrate: true,
  pickup: true,
  tripped: true,
};
const HEIGHTS: Record<Height, true> = { high: true, mid: true, low: true };
const DEFENSE_PHASES: Record<ActiveDefense['phase'], true> = { startup: true, active: true, recovery: true };
const BUTTON_SET: Record<Button, true> = { lpunch: true, rpunch: true, lkick: true, rkick: true };
const MOVE_SOURCES: Record<MoveRefRecord['source'], true> = { own: true, weapon: true };
const HURT_ZONES: Record<HurtZone, true> = { head: true, chest: true, abdomen: true, legs: true };
const SPECIES: Record<SpeciesId, true> = { human: true, ape: true, giantApe: true };
const LOAD_MODES: Record<NonNullable<Fighter['load']>['mode'], true> = { carry: true, drag: true, rope: true };
const HAND_MODES: Record<NonNullable<Inventory['hands']>['mode'], true> = { wield: true, carry: true, drag: true, ropeEnd: true };
const POSTURES: Record<PostureId, true> = {
  crouch: true,
  carryFront: true,
  carryShoulder: true,
  dragBack: true,
  haulRope: true,
  workLow: true,
  workKnap: true,
  digScoop: true,
  aimThrow: true,
  headLow: true,
  sniff: true,
  climbOut: true,
};
const VERBS: Record<VerbId, true> = {
  focus: true,
  take: true,
  drop: true,
  stow: true,
  draw: true,
  place: true,
  throw: true,
  lash: true,
  tie: true,
  untie: true,
  bend: true,
  shape: true,
  cut: true,
  dig: true,
  pull: true,
};
const CAUSE_KINDS: Record<CauseKind, true> = { entity: true, terrain: true, creature: true, bleed: true };
const CAUSE_FEATURES: Record<CauseFeature, true> = {
  sharpPoint: true,
  falling: true,
  swinging: true,
  rolling: true,
  cover: true,
  rope: true,
  fall: true,
  creature: true,
};
