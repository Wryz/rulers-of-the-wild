// The canonical save, version 1 (docs/M1-DESIGN.md §8.3), and the record type of every system that writes into it.
//
// Each system writes its own records (toRecord) and reads them back (restoreRecord); save/serialize.ts assembles them
// into SaveV1 in the key order below, save/canonical.ts writes the text, save/load.ts checks and loads it. The types
// the design leaves to their system's package are filled in here by that package (the verb state stays open because
// P14's own record extends it): every system's toRecord()/restoreRecord() returns and takes these types, so the save is
// assembled through stable signatures.
//
// Additions to §8.3's SaveV1 (each a deviation recorded in the package's report):
// - `options`: the WorldOptions the world was built with (scene, terrain, size, player, sparringApe), without which a
//   load can't regenerate the same base (a test scene is 'empty', the client's is the Clearing);
// - `prevBlade`: CombatSim's swept blades of the last tick (MAP gap-7 §3.1; P02-fix saves it);
// - `impulses`: the entity store's queued impulses (contact reactions of phase 9 are applied in the next tick's phase
//   4d, so the queue is not empty at the end of a tick);
// - `BodiesRecV1.kcc` is nullable: a ruler has no character controller (§4.7).
import type { BoneName } from '../body/skeleton';
import type { AIDirectorRecord, BrawlerAIRecord } from '../sim/ai';
import type { DropRecord, ProjectileRecord } from '../sim/combat';
import type { Command } from '../sim/commands';
import type { FighterRecord } from '../sim/fighter';
import type { MindScript, MindState } from '../world/creatures/mind';
import type {
  Anchor,
  EntityState,
  ImpactCause,
  JointKind,
  MaterialId,
  Owner,
  PlantState,
  Pose3,
  Quat,
  RulerState,
  Shape,
  SharpPoint,
  V3,
} from '../world/types';

export const SAVE_FORMAT_VERSION = 1;

/** The save's `format` tag. */
export const SAVE_FORMAT = 'rotw-world';

/** Every saved field of an entity (§2.3; SPEC:729), poses and velocities as the f32 values Rapier returned. */
export interface EntityRecV1 {
  id: number;
  material: MaterialId;
  shape: Shape;
  mass: number;
  state: EntityState;
  pose: Pose3;
  vel: { lin: V3; ang: V3 };
  integrity: number;
  moisture: number;
  temperature: number;
  burning: boolean;
  sharpPoints: SharpPoint[];
  joints: number[];
  age: number;
  credit: string[];
  look: string;
  plant: PlantState | null;
  anchor: { depthM: number; capacityN: number } | null;
  rope: { lengthM: number } | null;
  crossCut: { axisT: number; remaining: number; fromDir: V3 } | null;
  thrown: { by: number; tick: number } | null;
  loadHist: number[];
  restTicks: number;
  generated: boolean;
  touched: boolean;
  grace: { from: Owner; minUntil: number; maxUntil: number } | null;
  releasedBy: { fighter: number; apartTicks: number } | null;
}

/**
 * A joint record (§2.4), tension rings and the held end's pull included. The save holds every joint of the store, the
 * ones generation made included (a joint has no generated/touched flag): JointStore.restoreRecord replaces the whole
 * store with the saved joints (see save/load.ts), so a generated joint that still exists comes back from its record and
 * one that was cut or untied stays gone.
 */
export interface JointRecV1 {
  id: number;
  kind: JointKind;
  a: Anchor;
  b: Anchor;
  rope: { entity: number; lengthM: number } | null;
  breakEnergyJ: number;
  axis: V3 | null;
  limits: [number, number] | null;
  motor: { restAngle: number; stiffness: number; damping: number } | null;
  holdsBend: number | null;
  tension: [number, number, number];
  pullN: number;
  credit: string[];
}

/**
 * A fighter's saved state: every field marked Save in MAP gap-7 §3.4-3.5 plus §8.3's world fields, written by P04's
 * Fighter.toRecord (sim/fighter.ts's FighterRecord, in its key order).
 */
export type FighterRecV1 = FighterRecord;

/** The inner BrawlerAI's 20 history fields (MAP gap-7 §3.3; P04's BrawlerAI.toRecord). */
export type BrawlerRecV1 = BrawlerAIRecord;

/** A weapon lying around (CombatSim.drops; P02-fix's DropRecord). */
export type DropRecV1 = DropRecord;

/** A weapon in flight (CombatSim.projectiles; P02-fix's ProjectileRecord). */
export type ProjRecV1 = ProjectileRecord;

/** The AI director's turn-taking clock (P04's AIDirector.toRecord). */
export type DirectorRecV1 = AIDirectorRecord;

/** A character controller (§4.2; P08's CharacterControllers.toRecord), crouch included. */
export interface KccRecV1 {
  /** The capsule body's pose (f32, as Rapier holds it). */
  pose: Pose3;
  vy: number;
  grounded: boolean;
  crouched: boolean;
  /** Off while the fighter is down (the slab has it). */
  enabled: boolean;
  /** The capsule's half height now (crouched or standing). */
  halfHeight: number;
  /** A pending teleport's feet point (the next resolve places the capsule there and skips the sweep), or null. */
  teleport: V3 | null;
  /** The pushes it queued at `pushTick` (entity, unit horizontal direction): the next sweep reads whether each yielded. */
  pushes: { entity: number; x: number; z: number }[];
  pushTick: number;
}

/** A downed slab (§4.5; P08's DownedBodies.toRecord). */
export interface SlabRecV1 {
  enabled: boolean;
  pose: Pose3;
  lin: V3;
  ang: V3;
  /** Ticks the settle has held. */
  hold: number;
  handedBack: boolean;
  /** A world impact's Δv queued for the next phase 4a, or null. */
  dv: V3 | null;
  /**
   * The dynamic bodies the active slab isn't clear of (core-fix, world/downed.ts: the step leaves their pairs with it
   * out; the list only shrinks after the launch): entities and fighters (another's slab, a tripped ruler's body) by id,
   * each increasing without repeats; both empty while the slab is off. DEVIATION (§8.3 lists no such field): it is state,
   * not derivable from the poses.
   */
  notClearOf: { entities: number[]; fighters: number[] };
}

/**
 * The ruler's body (§4.7, RR-19; P11's RulerBodies.toRecord, world/rulerBody.ts, in this key order): body type, pose,
 * velocities, the frozen trip pose, the colliders' pose history, sleep, and the mover's memory.
 */
export interface RulerBodyRecV1 {
  /** Tripped or a corpse: a dynamic body with solid colliders (else kinematic with sensors). */
  dynamic: boolean;
  /** The body's pose as Rapier holds it (f32). */
  pose: Pose3;
  /** The body's velocities while dynamic; 0 standing (Rapier derives a kinematic body's from its next pose). */
  lin: V3;
  ang: V3;
  /** While dynamic: each bone's frame relative to the body (the pose frozen at the trip), BONES order; [] standing. */
  local: { bone: BoneName; p: V3; q: Quat }[];
  /** The colliders' centres at the last two posings, 3 numbers a bone in BONES order, the last then the one before; [] none. */
  history: number[];
  sleeping: boolean;
  /** The next phase 4c puts the body at its pose at once and fills the history with it. */
  jump: boolean;
  /** The root's height when its climb out of a pit began, or null. */
  climbFloor: number | null;
  /** The obstacle it last deflected along, and when. */
  deflect: { entity: number; tick: number } | null;
  /** Entities that held up its root or a foot lately, by entity id: the tick last seen and their credit. */
  supports: { entity: number; tick: number; credit: string[] }[];
  /** The last support that vanished under it (a load break), and its cause. */
  coverBreak: { tick: number; cause: ImpactCause } | null;
}

/** One fighter's bodies (every fighter of the sim, by fighter id). */
export interface BodiesRecV1 {
  fighter: number;
  /**
   * §8.3 writes `kcc: KccRecV1`; null here because a ruler has no character controller (§4.7: its body is the
   * RulerBodies one, saved in `ruler`). Players and apes always have one.
   */
  kcc: KccRecV1 | null;
  /** ZoneBodies.historyRecord: per bone, the last stored pose and the one before it (P08). */
  zonesHistory: number[];
  slab: SlabRecV1 | null;
  ruler: RulerBodyRecV1 | null;
}

/**
 * A fighter's verb state: its fields are P14's VerbStateRecord (world/verbs/index.ts: the focus, a continuous verb that
 * is on, a creature's tug), which extends this open record; save/load.ts checks every one of them.
 */
export interface VerbStateRecV1 {
  fighter: number;
  [field: string]: unknown;
}

/** One (creature, other owner) touching count of ContactSystem (§4.3, RR-19). */
export interface ContactRecV1 {
  /**
   * The group's subject, a signed id (§8.3 leaves its form open; §4.3 counts an entity's integrity episodes too): > 0 a
   * fighter (the lower id when both sides are fighters), < 0 an entity's id negated (a group with no fighter), never 0.
   */
  creature: number;
  /** The other side: 'terrain', 'entity:<id>', 'fighter:<id>' or 'rope:<joint>'. */
  owner: string;
  touching: number;
  episodeStart: number;
  cooldownUntil: number;
}

/**
 * A creature mind (§6.8; CreatureMind.toRecord, world/creatures/mind.ts, in this key order). Additions to §6.8 (P19,
 * each so a load continues exactly as the saving world would have):
 * - `resume`: the state a creature knocked down goes back to once it is up (§6.3 `down`: "→ the previous state");
 * - `mark`: a tick the current state measures from (the ape: when its look-around began, since when its fight's target
 *   has been out of reach), −1 when unset;
 * - `stimulus`: the senses' decision window (the awareness the strongest stimulus since the last decision added,
 *   Infinity after a hurt; perception.ts);
 * - `home`: the home point (the spawner's home, or where a creature made without one was made); `homeIdx` names the
 *   spawn data's home it came from (−1 none);
 * - `path.complete`: whether the path reaches its goal (a partial path's end counts as a failure, §6.5).
 */
export interface MindRecV1 {
  fighter: number;
  kind: 'ape' | 'giantApe';
  state: MindState;
  stateTick: number;
  resume: MindState | null;
  mark: number;
  paused: boolean;
  script: MindScript | null;
  awareness: [number, number][];
  lkp: V3 | null;
  lkpTick: number;
  lastSeenTick: number;
  stimulus: number;
  hurt: { tick: number; point: V3 } | null;
  home: { x: number; z: number };
  homeIdx: number;
  routeIdx: number;
  restUntil: number;
  cooldownUntil: number;
  fleeUntil: number;
  heading: number;
  charge: { heading: number; start: V3; travelled: number; close: boolean } | null;
  path: { points: V3[]; i: number; goal: V3; complete: boolean; tiles: number[]; versions: number[]; requestTick: number; pending: boolean } | null;
  stuck: { pos: V3; tick: number; count: number };
  rng: number;
  inner: BrawlerRecV1 | null;
}

/** The spawner (§6.6, §6.8). */
export interface SpawnerRecV1 {
  homes: { fighter: number | null; respawnTick: number }[];
  sparring: { fighter: number | null; respawnTick: number };
}

/** A tree's felling state (§2.5). */
export interface FellingRecV1 {
  tree: number;
  phase: PlantState['phase'];
  fall: PlantState['fall'];
}

/** The WorldOptions a world was built with (all but `seed`, which is the save's own, and `nav`, a load option). */
export interface SaveOptionsV1 {
  scene: 'clearing' | 'empty';
  terrain: 'generated' | 'flat';
  /** m, as asked (the terrain rounds it to whole tiles, the same way on load). */
  size: number;
  player: boolean;
  sparringApe: boolean;
}

/** A queued entity impulse (EntityStore.queueImpulse): applied in the next tick's phase 4d, queue order kept. */
export interface ImpulseRecV1 {
  entity: number;
  j: V3;
  at: V3 | null;
}

/** One saved tuning value that differs from its registered default (sim tables only). */
export interface TuningOverrideV1 {
  table: string;
  key: string;
  value: number | boolean | string;
}

/** The whole world (§8.3, plus the additions named at the top of this file). Writers emit keys in this order. */
export interface SaveV1 {
  format: 'rotw-world';
  formatVersion: 1;
  seed: number;
  options: SaveOptionsV1;
  tick: number;
  /** Sorted (table, key); client tables (folder 'Client …') are never saved. */
  tuningOverrides: TuningOverrideV1[];
  counters: { fighter: number; entity: number; joint: number; wound: number; dropSerial: number; projSerial: number };
  /** uint32 states; `fighters` and `minds` as [fighter id, state], by id. */
  rng: { combat: number; world: number; fighters: [number, number][]; minds: [number, number][] };
  director: DirectorRecV1;
  /** CommandQueue order. */
  pending: Command[];
  /** Edits vs generated heights, sorted (tile, vertex). */
  terrain: { tile: number; vertex: number; dh: number }[];
  /** (tile, vertex) of every ever-dug vertex, sorted (§4.13). */
  dug: [number, number][];
  /** (cell, value) edits, sorted. */
  cover: [number, number][];
  /** Id order: every non-generated entity and every touched generated one. */
  entities: EntityRecV1[];
  /** Generated ids no longer present, sorted. */
  removed: number[];
  impulses: ImpulseRecV1[];
  /** Id order, every joint (generation's included). */
  joints: JointRecV1[];
  /** combat.fighters order (the step order). */
  fighters: FighterRecV1[];
  /** By fighter id (§6.8). */
  minds: MindRecV1[];
  /** By fighter id. */
  verbs: VerbStateRecV1[];
  spawner: SpawnerRecV1;
  drops: DropRecV1[];
  projectiles: ProjRecV1[];
  /** [fighter id, blade points at the end of the last tick's hit detection], in combat.fighters order. */
  prevBlade: [number, V3[]][];
  /** Every fighter of the sim, by id. */
  bodies: BodiesRecV1[];
  /** [fighter id, its RulerState], by id. */
  rulers: [number, RulerState][];
  /** ContactSystem's runtime maps, sorted (creature, owner key) (RR-19). */
  contacts: ContactRecV1[];
  /** (fighter, untilTick), sorted. */
  contactGrace: [number, number][];
  /** Trees notched, falling or felled, by id. */
  felling: FellingRecV1[];
  deaths: { fighter: number; respawnTick: number }[];
  corpses: { fighter: number; removeTick: number }[];
  /** (layer, ty, tx). */
  navDirty: [number, number, number][];
}

/** SaveV1's keys in the order the writer emits them. */
export const SAVE_V1_KEYS: readonly (keyof SaveV1)[] = [
  'format',
  'formatVersion',
  'seed',
  'options',
  'tick',
  'tuningOverrides',
  'counters',
  'rng',
  'director',
  'pending',
  'terrain',
  'dug',
  'cover',
  'entities',
  'removed',
  'impulses',
  'joints',
  'fighters',
  'minds',
  'verbs',
  'spawner',
  'drops',
  'projectiles',
  'prevBlade',
  'bodies',
  'rulers',
  'contacts',
  'contactGrace',
  'felling',
  'deaths',
  'corpses',
  'navDirty',
];
