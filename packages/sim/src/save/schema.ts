// The canonical save, version 1 (docs/M1-DESIGN.md §8.3), and the record type of every system that writes into it.
//
// STUB (P05; P13 owns this file): the record types below are the shapes §8.3, §6.8 and §2 give; the ones the design
// leaves to their system's package (fighters, the bodies, verbs, drops, projectiles) are open records until that package
// fills them in here with P13. Every system stub's toRecord()/restoreRecord() already returns and takes these types, so
// P13 assembles the save through stable signatures.
import type { BoneName } from '../body/skeleton';
import type { Command } from '../sim/commands';
import type { MindScript, MindState } from '../world/creatures/mind';
import type {
  Anchor,
  EntityState,
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

/** A joint record (§2.4), tension rings and the held end's pull included. */
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
 * A fighter's saved state: every field marked Save in MAP gap-7 §3.4-3.5 (P04's toRecord()) plus the world fields
 * (playerId, species, massKg, toughnessJ, lastKnock, armour, inventory, drive, posture, work, verbRequest, verbAim,
 * throwAim, moveFlags, jumpRequest, idlePaused). TODO(P13, P04): the full field list.
 */
export interface FighterRecV1 {
  id: number;
  [field: string]: unknown;
}

/** The inner BrawlerAI's 20 history fields (MAP gap-7 §3.3; P04's toRecord()). TODO(P13, P04): the field list. */
export interface BrawlerRecV1 {
  [field: string]: unknown;
}

/** A character controller (§4.2), crouch included. TODO(P08): its exact fields. */
export interface KccRecV1 {
  pose: Pose3;
  vy: number;
  grounded: boolean;
  crouched: boolean;
  [field: string]: unknown;
}

/** A downed slab (§4.5). TODO(P08): its exact fields. */
export interface SlabRecV1 {
  enabled: boolean;
  pose: Pose3;
  lin: V3;
  ang: V3;
  [field: string]: unknown;
}

/**
 * The ruler's body (§4.7): body type, pose, velocities, the frozen trip pose (12 × pos + quat) and the zone pose history
 * (RR-19). TODO(P11): its exact fields.
 */
export interface RulerBodyRecV1 {
  dynamic: boolean;
  pose: Pose3;
  lin: V3;
  ang: V3;
  local: { bone: BoneName; p: V3; q: Quat }[];
  history: number[];
  [field: string]: unknown;
}

/** One fighter's bodies. */
export interface BodiesRecV1 {
  fighter: number;
  kcc: KccRecV1 | null;
  zonesHistory: number[];
  slab: SlabRecV1 | null;
  ruler: RulerBodyRecV1 | null;
}

/** A weapon lying on the ground (CombatSim.drops). TODO(P13): its exact fields. */
export interface DropRecV1 {
  id: number;
  [field: string]: unknown;
}

/** A weapon in flight (CombatSim.projectiles). TODO(P13): its exact fields. */
export interface ProjRecV1 {
  id: number;
  [field: string]: unknown;
}

/** A fighter's verb state (buffer, held ends, continuous verbs). TODO(P14): its exact fields. */
export interface VerbStateRecV1 {
  fighter: number;
  [field: string]: unknown;
}

/** One (creature, other owner) touching count of ContactSystem (§4.3, RR-19). */
export interface ContactRecV1 {
  creature: number;
  owner: string;
  touching: number;
  episodeStart: number;
  cooldownUntil: number;
}

/** A creature mind (§6.8). */
export interface MindRecV1 {
  fighter: number;
  kind: 'ape' | 'giantApe';
  state: MindState;
  stateTick: number;
  paused: boolean;
  script: MindScript | null;
  awareness: [number, number][];
  lkp: V3 | null;
  lkpTick: number;
  lastSeenTick: number;
  hurt: { tick: number; point: V3 } | null;
  homeIdx: number;
  routeIdx: number;
  restUntil: number;
  cooldownUntil: number;
  fleeUntil: number;
  heading: number;
  charge: { heading: number; start: V3; travelled: number; close: boolean } | null;
  path: { points: V3[]; i: number; goal: V3; tiles: number[]; versions: number[]; requestTick: number; pending: boolean } | null;
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

/** The whole world (§8.3). Writers emit keys in this order (canonical.ts). */
export interface SaveV1 {
  format: 'rotw-world';
  formatVersion: 1;
  seed: number;
  tick: number;
  tuningOverrides: { table: string; key: string; value: number | boolean | string }[];
  counters: { fighter: number; entity: number; joint: number; wound: number; dropSerial: number; projSerial: number };
  rng: { combat: number; world: number; fighters: [number, number][]; minds: [number, number][] };
  director: { lastAttack: number };
  pending: Command[];
  terrain: { tile: number; vertex: number; dh: number }[];
  dug: [number, number][];
  cover: [number, number][];
  entities: EntityRecV1[];
  removed: number[];
  joints: JointRecV1[];
  fighters: FighterRecV1[];
  minds: MindRecV1[];
  verbs: VerbStateRecV1[];
  spawner: SpawnerRecV1;
  drops: DropRecV1[];
  projectiles: ProjRecV1[];
  bodies: BodiesRecV1[];
  rulers: [number, RulerState][];
  contacts: ContactRecV1[];
  contactGrace: [number, number][];
  felling: FellingRecV1[];
  deaths: { fighter: number; respawnTick: number }[];
  corpses: { fighter: number; removeTick: number }[];
  navDirty: [number, number, number][];
}
