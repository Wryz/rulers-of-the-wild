// Every data type shared across the world's files (docs/M1-DESIGN.md §1.3, §2, §1.5.2). Types only: nothing here
// runs, so any module can import it without pulling in Rapier, recast or another system.
//
// Records hold plain numbers (V3, Quat, Pose3); Three's Vector3 satisfies V3. Rapier handles appear only in the
// runtime-only fields of Entity and are never saved.
//
// `@dimforge/rapier3d-compat` is imported for its types alone (erased at build time); P05 adds the exact pin to
// packages/sim/package.json (§1.1). Until then the workspace's hoisted copy (the client's dependency) resolves it.
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Vector3 } from 'three';
import type { TrackKey } from '../body/animator';
import type { BoneName } from '../body/skeleton';
import type { HurtZone } from '../sim/combat';
import type { VerbCommand, VerbId } from '../sim/commands';
import type { Fighter } from '../sim/fighter';
import type { MoveDef, Weight } from '../sim/moves';
import type { Projectile } from '../sim/projectiles';
import type { WeaponDef } from '../sim/weapons';

// ---------------------------------------------------------------------------
// Geometry records
// ---------------------------------------------------------------------------

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Pose3 {
  p: V3;
  q: Quat;
}

// ---------------------------------------------------------------------------
// Materials (§2.1; the table and its predicates live in world/materials.ts)
// ---------------------------------------------------------------------------

/** The 16 materials of SPEC:206-223. Rules never read an id, only a material's properties (rule 1, AC-1). */
export type MaterialId =
  | 'greenWood'
  | 'dryWood'
  | 'rottenWood'
  | 'leaves'
  | 'vine'
  | 'sinew'
  | 'hide'
  | 'bone'
  | 'rulerBone'
  | 'stone'
  | 'flint'
  | 'dirt'
  | 'snow'
  | 'ice'
  | 'resin'
  | 'fat';

// A type alias rather than the design's `interface` (same members): an object type alias is indexable, so the
// registry's FieldsOf<MATERIALS> asks for a FieldMeta per property and the panel gets one binding per property.
export type Material = {
  /** kg/m³. */
  density: number;
  /** 0..1. */
  hardness: number;
  /** 0..1. */
  maxSharpness: number;
  /** 0..1 (M2). */
  flammability: number;
  /** Solids break at J per kg of their mass; rope-like materials hold kN per strand; null = n/a (resin, fat). */
  strength: { solidJPerKg: number } | { ropeKN: number } | null;
  /** 0..1. */
  springiness: number;
  /** 0..1 → Rapier friction, combine rule Average. */
  friction: number;
  /** J this material adds to a zone it covers when worn (SPEC:417, 885): hide 20, bone 40, every other row 0. */
  armourJ: number;
  /** M2; 0 in M1. */
  wetMassPerMoisture: number;
};

// ---------------------------------------------------------------------------
// Shapes and sharp points (§2.2; the functions live in world/shapes.ts)
// ---------------------------------------------------------------------------

export type Shape =
  | { kind: 'ball'; r: number }
  | { kind: 'box'; hx: number; hy: number; hz: number }
  /** Axis local +Y. */
  | { kind: 'capsule'; halfHeight: number; r: number }
  /** A regular N-gon prism, r = circumradius, axis local +Y (logs, sticks, stakes, trunks). */
  | { kind: 'cylinder'; halfHeight: number; r: number; sides: number }
  /** Local xyz triples (stones, boulders, tapered points). */
  | { kind: 'hull'; points: readonly number[] };

export interface SharpPoint {
  /** Entity-local tip. */
  local: V3;
  /** Unit, entity-local, pointing out of the tip. */
  dir: V3;
  /** 0..1, ≤ material.maxSharpness (SPEC:183, 198). */
  sharpness: number;
}

// ---------------------------------------------------------------------------
// Entities (§2.3), trees (§2.5), joints and ropes (§2.4)
// ---------------------------------------------------------------------------

export type EntityState = 'free' | 'anchored' | 'fixed' | 'held' | 'stowed' | 'tied' | 'projectile' | 'frozen';

export interface PlantState {
  /** m: circum-diameter of the prism at the cut height, and height. */
  diameter: number;
  height: number;
  phase: 'standing' | 'notched' | 'bent' | 'falling' | 'felled';
  /**
   * fromDir: unit horizontal from the trunk toward the side chops come from (the first chopper's root), kept for the
   * tree's life; remaining = 1 − depthSumM / diameter.
   */
  cut: { fromDir: V3; remaining: number; chops: number; depthSumM: number } | null;
  /** The stump entity's id once felled. */
  stump: number | null;
  /** World hinge point H and axis while falling. */
  fall: { hinge: V3; axis: V3; torn: boolean } | null;
}

export interface Entity {
  /** World counter, never reused. */
  readonly id: number;
  material: MaterialId;
  shape: Shape;
  /** Density × volume (× wet factor in M2). */
  mass: number;
  /** fixed: rooted trees, stumps, scaffolding; anchored: stakes driven into soft ground. */
  state: EntityState;
  /** Authoritative record; mirrors the body after every step (f32 values). */
  pose: Pose3;
  vel: { lin: V3; ang: V3 };
  /** 0..1. */
  integrity: number;
  /** M2 rules; the fields exist now (rule 10, SPEC:178-181). */
  moisture: number;
  temperature: number;
  burning: boolean;
  sharpPoints: SharpPoint[];
  /** JointRecord ids, sorted. */
  joints: number[];
  /** Seconds of play (advances while active). */
  age: number;
  /** Player ids, sorted, de-duplicated (SPEC:186, 473). */
  credit: string[];
  /** Presentation hint ('tree', 'log', 'stone'…); no rule reads it. */
  look: string;
  /** Trees and saplings while rooted. */
  plant: PlantState | null;
  /** Stakes driven into soft ground (D-19). */
  anchor: { depthM: number; capacityN: number } | null;
  /** Rope-like entities: total length. */
  rope: { lengthM: number } | null;
  /** Cut progress on a free entity (§5.3). */
  crossCut: { axisT: number; remaining: number; fromDir: V3 } | null;
  /** The damage cause stays `held` until first contact or rest (D-31). */
  thrown: { by: number; tick: number } | null;
  /** Last 12 ticks of computed load, N (§4.11). */
  loadHist: Float32Array;
  /** Consecutive ticks below PHYSICS_TUNING.restSpeed. */
  restTicks: number;
  /** Made by generateClearing (the save stores it only if touched). */
  generated: boolean;
  /** Moved > 1 cm or 1°, or any field changed since generation (§8.3). */
  touched: boolean;
  /**
   * A fresh piece ignores its breaker (and every fighter, §2.11) until it no longer overlaps the breaker, at least
   * 10 ticks (§4.10); saved.
   */
  grace: { from: Owner; minUntil: number; maxUntil: number } | null;
  /** Dropped, thrown or placed: contacts with that fighter's bodies are not scored until apart 2 ticks (§4.3); saved. */
  releasedBy: { fighter: number; apartTicks: number } | null;
  // Runtime only, never saved:
  /** null while stowed, tied, projectile or frozen; disabled (not null) while held. */
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  /** Client interpolation. */
  prevPose: Pose3;
}

export interface EntitySpec {
  material: MaterialId;
  shape: Shape;
  p: V3;
  q?: Quat;
  lin?: V3;
  ang?: V3;
  state?: 'free' | 'anchored' | 'fixed';
  sharpPoints?: SharpPoint[];
  look: string;
  plant?: { diameter: number; height: number };
  rope?: { lengthM: number };
  credit?: string[];
  integrity?: number;
  anchorDepthM?: number;
  generated?: boolean;
}

export type JointKind = 'lash' | 'hinge' | 'rope' | 'bend';

/**
 * One end of a joint. entity null with no fighter and not loose = a world point; `fighter` = a held free end
 * (Pull); `loose` = an end lying free.
 */
export interface Anchor {
  entity: number | null;
  local: V3;
  fighter?: number;
  loose?: true;
}

export interface JointRecord {
  readonly id: number;
  kind: JointKind;
  a: Anchor;
  b: Anchor;
  /** The rope entity it is made of, and the free length now. */
  rope: { entity: number; lengthM: number } | null;
  /** lash/hinge: D-18; rope/bend: Infinity (ropes break on tension). */
  breakEnergyJ: number;
  /** hinge/bend, in a's frame, rad. */
  axis: V3 | null;
  limits: [number, number] | null;
  /** bend (SPEC:258). */
  motor: { restAngle: number; stiffness: number; damping: number } | null;
  /** On a rope joint: the bend joint it keeps bent. */
  holdsBend: number | null;
  /** N per strand, last 3 steps (SPEC:261); saved. */
  tension: [number, number, number];
  /** Code pull on a held end this tick (0 = none). */
  pullN: number;
  credit: string[];
}

// ---------------------------------------------------------------------------
// Fighters: hands, locomotion, posture, work (§2.12, §1.5.3, §5.0, §6.1)
// ---------------------------------------------------------------------------

export interface Inventory {
  hands: { entity: number; mode: 'wield' | 'carry' | 'drag' | 'ropeEnd'; grip: V3; twoHanded: boolean; joint: number | null } | null;
  /** Small items (SPEC:385). */
  belt: [number | null, number | null, number | null];
  /** One tool or bundle (SPEC:386). */
  back: number | null;
}

/** Locomotion written by a mind instead of moveInput: the giant, and scripted charges (§6.1, §6.4). */
export interface Drive {
  /** rad, the fighter yaw convention (atan2(x, z): 0 faces +z, π/2 faces +x). */
  heading: number;
  /** m/s, the horizontal speed to reach. */
  speed: number;
  /** m/s², toward `speed`. */
  accel: number;
  /** Climbing out of a pit (§4.7 step 3); set only while ruler.inPit and the giant is up. */
  climb: boolean;
}

/** Every M1 pose a fighter can hold over its animation (docs/M1-DESIGN.md §1.2 body/poses.ts, P14). */
export type PostureId =
  | 'crouch'
  | 'carryFront'
  | 'carryShoulder'
  | 'dragBack'
  | 'haulRope'
  | 'workLow'
  | 'workKnap'
  | 'digScoop'
  | 'aimThrow'
  | 'headLow'
  | 'sniff'
  | 'climbOut';

/** An upper-body pose blended over the animation. */
export interface Posture {
  id: PostureId;
  /** 0..1 blend weight (a mind ramps it, e.g. the telegraph's headLow). */
  weight: number;
}

/**
 * A committed work action (§5.0): state 'pickup', stunFrames = frames; the fighter turns toward `faceAt`, plays
 * `keys`, and the verb's effect lands at stateFrame === actAt through world.completeWork (which re-validates).
 */
export interface Work {
  kind: VerbId;
  frames: number;
  actAt: number;
  faceAt: V3;
  keys: TrackKey[];
  /** The command whose effect lands at actAt, when the verb system keeps it on the fighter. */
  cmd?: VerbCommand;
}

// ---------------------------------------------------------------------------
// Creatures (§2.7), ruler zones and state (§2.8), wounds (§2.9)
// ---------------------------------------------------------------------------

// TODO open question SPEC:981 (fauna): M1 has one family (apes); the default is a mixed lost world.
export type SpeciesId = 'human' | 'ape' | 'giantApe';

/** Named ruler zones; the last four are unlisted surfaces, armoured (D-8). */
export type RulerZoneId =
  | 'skull'
  | 'eyes'
  | 'mouth'
  | 'back'
  | 'shoulders'
  | 'flanks'
  | 'belly'
  | 'knees'
  | 'elbows'
  | 'chest'
  | 'arm'
  | 'leg'
  | 'pelvis';

/** Why a ruler trips (§4.7). */
export type TripWhy = 'obstacle' | 'cover' | 'ledge' | 'impact';

/** Burns are M2. */
export type SevereEffect = 'limp' | 'blindL' | 'blindR' | 'weakJaw' | 'winded';

export interface WoundRecord {
  /** World wound counter. */
  readonly id: number;
  zone: RulerZoneId;
  bone: BoneName;
  /** Where on the bone (the visible scar, SPEC:845). */
  local: V3;
  severe: boolean;
  effect: SevereEffect | null;
  /** Damage recorded in it (opening hit + finishing damage). */
  hp: number;
  /** Not yet healed. */
  remaining: number;
  /** Recorded with its cause (SPEC:502); cause.feature feeds adaptation (M4). */
  cause: ImpactCause;
  tick: number;
  credit: string[];
}

/**
 * A ruler's state. "Down" (rulerDown) and "held" (rulerHeld) are functions of these fields, never separate flags
 * (SPEC:504). The giant's committed heading is mind state (RulerMind.heading), not body state.
 */
export interface RulerState {
  maxHp: number;
  /** Damage that made no wound (recovers RULER_TUNING.recoveryHpPerS when allowed). */
  unhealed: number;
  /** In creation order. */
  wounds: WoundRecord[];
  /** D-38 with hysteresis (§4.7). */
  pinned: boolean;
  pinnedKg: number;
  unpinTicks: number;
  /** M2; always false in M1. */
  stuck: boolean;
  burning: boolean;
  /** Both planted feet more than pitDownDepthFrac × knee height below the original terrain (§4.7). */
  inPit: boolean;
  /** The wound finishing damage goes to: the wound that tripped, pitted or pinned it (§4.6). */
  downWound: number | null;
  /** What put it down (the trip's or the pin's cause), for D-37's "opened with the cause". */
  downCause: ImpactCause | null;
  /** The last trip caused by the world; a terrain wound within envKillWindowS of it is byWorld (§4.6). */
  lastWorldTrip: { tick: number; cause: ImpactCause | null } | null;
  /** Set by RulerMover on a deflection, consumed by the mind (§6.4). */
  deflectedHeading: number | null;
  pendingTrip: { why: TripWhy; tick: number; cause: ImpactCause | null } | null;
}

// ---------------------------------------------------------------------------
// Impacts and knockouts (§2.10)
// ---------------------------------------------------------------------------

export type CauseKind = 'entity' | 'terrain' | 'creature' | 'bleed';

/** What adaptation will remember (SPEC:785). */
export type CauseFeature = 'sharpPoint' | 'falling' | 'swinging' | 'rolling' | 'cover' | 'rope' | 'fall' | 'creature';

export interface ImpactCause {
  kind: CauseKind;
  entityId: number | null;
  fighterId: number | null;
  /** Entity credit or [playerId]; [] = nobody (SPEC:186, 473). */
  credit: readonly string[];
  /** In a fighter's hands, or thrown and not yet at first contact or rest (D-31). */
  held: boolean;
  feature: CauseFeature;
}

/** A world hit on a fighter, scored by the contact pipeline and applied by applyImpact (sim/impact.ts). */
export interface Impact {
  target: Fighter;
  bone: BoneName;
  zone: HurtZone;
  rulerZone: RulerZoneId | null;
  point: V3;
  /** Out of the target. */
  normal: V3;
  mEff: number;
  vn: number;
  sharpness: number;
  /** J after the hard-landing subtraction. */
  energy: number;
  /** J: zone toughness + armour. */
  toughness: number;
  /** 3-D momentum transfer to the target; zero for static impactors and terrain. */
  dv: V3;
  /** kg; Infinity for static. */
  impactorMass: number;
  cause: ImpactCause;
}

export interface ImpactResult {
  damage: number;
  knockdown: boolean;
  launched: boolean;
  ko: boolean;
  reaction: V3;
  wound: WoundRecord | null;
}

export interface KnockRecord {
  tick: number;
  cause: ImpactCause;
  /** The knocker's fighter id. */
  by: number | null;
}

export interface Finish {
  by: 'strike' | 'thrown' | 'impact' | 'bleed' | 'fatal' | 'sever';
  killer: Fighter | null;
  cause: ImpactCause | null;
  point: V3;
}

// ---------------------------------------------------------------------------
// CombatSim seams (§1.5.2): how CombatSim reaches the world without importing it
// ---------------------------------------------------------------------------

export interface GroundQuery {
  /** Terrain only. */
  heightAt(x: number, z: number): number;
  /** Terrain or a fixed/anchored/resting entity below fromY + 0.5. */
  supportAt?(x: number, z: number, fromY: number): number;
}

export interface FighterMover {
  /**
   * f.pos holds this tick's proposal (locomote + separate's push). Resolve it in place, y included. Called once per
   * standing fighter per tick, in combat.fighters order, at the separate() site.
   */
  resolve(f: Fighter, radius: number, propPad: number): void;
}

export interface WorldStrike {
  point: Vector3;
  normal: Vector3;
  owner: Owner;
  effect: 'chop' | 'crossCut' | 'sever' | 'dig' | 'push' | 'clang';
  reaction: { mode: 'stick' | 'rebound'; hold: number; retract: number };
}

export interface ProjectileWorldHit {
  point: Vector3;
  normal: Vector3;
  owner: Owner;
  toi: number;
}

/** Implemented by World; null in legacy CombatSim. */
export interface WorldPort {
  strike(a: Fighter, prev: readonly Vector3[] | null, pts: readonly Vector3[], offs: readonly number[], w: WeaponDef | null): WorldStrike | null;
  /** After tryPickup, every tick (§5.0). */
  tryVerb(f: Fighter): void;
  /** advancePickup at stateFrame === work.actAt. */
  completeWork(f: Fighter): void;
  /** true: a big object launched as a Rapier body (no DS projectile). */
  throwRelease(f: Fighter, m: MoveDef): boolean;
  projectile(p: Projectile, from: Vector3, to: Vector3): ProjectileWorldHit | null;
  /** true: it became an entity again (no DS drop). */
  onProjectileLanded(p: Projectile): boolean;
  /** Classification (sim/impact.ts) + parts/death. */
  onKO(d: Fighter, finish: Finish): { environmental: boolean; credit: string[] };
  /** true: handled as an entity (no DS drop). */
  onWeaponDropped(f: Fighter): boolean;
  /** §4.6. */
  rulerHit(
    a: Fighter,
    d: Fighter,
    m: MoveDef,
    point: Vector3,
    dir: Vector3,
    zone: HurtZone,
    bone: BoneName,
    power: number,
    haft: boolean,
    thrown: WeaponDef | null,
    ruleDamageHp: number | null,
  ): void;
}

// ---------------------------------------------------------------------------
// Owners, queries (§1.5.6)
// ---------------------------------------------------------------------------

/** What a collider belongs to. Verbs, perception and the client read owners, never Rapier handles. */
export type Owner =
  | { kind: 'terrain' }
  | { kind: 'entity'; id: number }
  | { kind: 'fighter'; id: number; part: 'kcc' | 'zone' | 'slab' | 'ruler'; bone?: BoneName }
  | { kind: 'rope'; joint: number };

export interface QueryFilter {
  terrain?: boolean;
  entities?: 'all' | 'static' | 'none';
  minEntityMassKg?: number;
  ropes?: boolean;
  fighters?: 'none' | 'zones' | 'kcc';
  exclude?: { entities?: number[]; fighters?: number[] };
}

export interface Hit {
  owner: Owner;
  toi: number;
  point: V3;
  /** Outward normal of the struck collider at point. */
  normal: V3;
}

// ---------------------------------------------------------------------------
// Events to the client (§2.13)
// ---------------------------------------------------------------------------

/**
 * Why a verb was refused (validateVerb, world/verbs/targets.ts). The client turns a reason and the target's data into
 * text ("too heavy (210 kg)", "needs an edge").
 */
export type RefuseReason =
  // the command itself
  | 'noTarget' // the target (or second) doesn't exist, or is a fighter
  | 'outOfRange' // beyond targetRadiusM of the chest point, measured to the collider surface
  | 'outOfReach' // an anchor point beyond handReachM after stepping in
  | 'badAnchor' // an anchor point not within 0.3 m of its entity's surface
  | 'cantAct' // not alive, or the right forearm severed
  | 'busy' // the buffer lapsed before the fighter was free
  // hands, belt and back
  | 'immovable' // fixed, anchored, rooted or tied
  | 'tooHeavy'
  | 'tooLong'
  | 'handsFull'
  | 'handsEmpty'
  | 'slotFull'
  | 'slotEmpty'
  | 'notATool' // the back slot takes a tool or a bundle of elongated things
  | 'dragging'
  | 'ropeEnd'
  // cutting and shaping
  | 'noEdge'
  | 'tooHard'
  | 'fullySharp'
  | 'ropeLike'
  // rope
  | 'noRope'
  | 'ropeTooShort'
  | 'notTied'
  | 'noRopeEnd'
  // bend
  | 'notRooted'
  | 'notSpringy'
  | 'tooThick'
  | 'tooStiff'
  // place and dig
  | 'noSupport'
  | 'blocked'
  | 'noDigTool';

/** Noise sources (§6.2; radii in NOISE_TUNING). The `noise` event is a presentation hint only. */
export type NoiseKind =
  | 'step'
  | 'hit'
  | 'block'
  | 'clang'
  | 'chop'
  | 'dig'
  | 'shape'
  | 'stakeDriven'
  | 'throwLand'
  | 'ropeSnap'
  | 'break'
  | 'heavyLand'
  | 'shout'
  | 'roar';

/** World events, ordered by phase, then by owner id within a phase. CombatEvents of the tick come first. */
export type WorldEvent =
  | {
      type: 'impact';
      tick: number;
      defender: Fighter;
      point: V3;
      normal: V3;
      dir: V3;
      zone: HurtZone;
      bone: BoneName;
      rulerZone: RulerZoneId | null;
      energy: number;
      toughness: number;
      damage: number;
      dv: V3;
      knockdown: boolean;
      launched: boolean;
      ko: boolean;
      corpse: boolean;
      /** Presentation hints. */
      weight: Weight;
      impulse: number;
      lift: number;
      hitstop: number;
      shake: number;
      cause: ImpactCause;
      wound: WoundRecord | null;
    }
  /** byWorld: (cause.kind 'entity' and !cause.held), or (cause.kind 'terrain' within envKillWindowS of ruler.lastWorldTrip). */
  | { type: 'wound'; ruler: Fighter; wound: WoundRecord; byWorld: boolean }
  /** The slab is enabled; the client ragdoll copies it. */
  | { type: 'launch'; f: Fighter; vel: V3; angVel: V3 }
  | { type: 'trip'; f: Fighter; at: V3; why: TripWhy; cause: ImpactCause | null }
  | { type: 'rise'; f: Fighter }
  /** ruler.inPit changed (§4.7). */
  | { type: 'pit'; f: Fighter; on: boolean }
  /** §4.9. */
  | { type: 'tripwire'; joint: number; by: Owner; loadN: number; snapped: boolean; loosed: number[] }
  | { type: 'pinned'; f: Fighter; on: boolean }
  | { type: 'shove'; ruler: Fighter; entity: number }
  | { type: 'deflect'; ruler: Fighter; along: V3 }
  /** Thud, dust, shake ∝ mass (SPEC:581). */
  | { type: 'land'; entity: number | null; f: Fighter | null; point: V3; energy: number; mass: number }
  | { type: 'break'; entity: number; pieces: number[]; point: V3; energy: number }
  /**
   * point: the middle of the joint's anchors when it happened (P10's JointStore always sets it; a snapped joint is gone
   * by phase 17b, so listeners read the point here). Optional only so event literals written before P10 still type.
   */
  | { type: 'joint'; joint: number; what: 'snap' | 'cut' | 'untie' | 'loose' | 'release'; point?: V3 }
  | { type: 'chop'; tree: number; point: V3; remaining: number }
  | { type: 'fell'; tree: number; dir: V3 }
  | { type: 'crossCut'; entity: number; pieces: number[] | null }
  | { type: 'dig'; point: V3; volumeM3: number; pile: number | null }
  | { type: 'spawn'; entity: number }
  | { type: 'remove'; entity: number }
  | { type: 'death'; f: Fighter; respawnTick: number }
  | { type: 'respawn'; f: Fighter; at: V3 }
  | { type: 'parts'; victim: number; entities: number[]; environmental: boolean }
  | { type: 'verb'; f: Fighter; verb: VerbId; ok: boolean; reason?: RefuseReason; entity?: number }
  /** Presentation hint only. */
  | { type: 'noise'; at: V3; radius: number; kind: NoiseKind };
