// The acceptance-test harness (docs/M1-DESIGN.md §11.0, package P23): one World, stepped tick by tick, with
// - entities made through the factory world generation uses (§6.7): logs, sticks, coils, grass, trees with their hanging
//   vines, scaffold boxes;
// - the scripted player, driven through commands only (move, button, verb, and `meta 'dev'` gives): walking, carrying,
//   dragging, striking, chopping, digging a pit (the dig planner), pulling and reeling in a rope, pacing;
// - creatures made by createCreature and driven by their mind's test scripts (§6.6: route, charge, tug, hold), never by
//   anything that arranges harm (rule 1, orchestrator decision 8);
// - a few logged fixture operations a test scene may need and no verb provides (D-25: no M1 verb lifts 300 kg): `stage`
//   (hold an entity fixed at a pose while the player builds around it), `unstage`, `standAt` (a teleport, classified
//   by the terrain on its way: up a wall over 45°, down a drop, or neither), `keepAwake`, give('axe2h') (DungeonStyle's
//   two-handed axe, which no entity makes), and `pause` of the player. Each is recorded in `fixtures`, so a test can
//   print what was not done by the rules;
// - the staging fence (rule 1, orchestrator decision 8): once any creature is in the world, `stage` and `unstage`
//   refuse and every factory spawn is logged (`spawn`), so no fixture can be a trap's trigger;
// - observation: every event since the harness was made (`history`), impacts, tripwires, wounds, horizontal distances to
//   colliders, the body-state bytes and the save.
//
// Determinism (rule 7): nothing here reads a clock or Math.random; every choice the harness makes (stand spots, strike
// order, pacing turns) is a pure function of the world's state, so two runs of the same test are bit-identical.
//
// Rule 1: a helper moves the player or a creature; it never places harm. Scenes (scenes.ts) are built only from the
// factory and `verb`, which the harness test checks by reading scenes.ts.
import { yieldToVitest } from './yieldToVitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { bodyStateBytes } from '../../src/save/bodyState';
import { loadWorld } from '../../src/save/load';
import { serializeWorld } from '../../src/save/serialize';
import type { CombatEvent } from '../../src/sim/combat';
import { type ButtonCommand, type Command, type MetaCommand, MOVE_CROUCH, moveCommand, toCm, type VerbCommand } from '../../src/sim/commands';
import type { Button, Fighter } from '../../src/sim/fighter';
import { WEAPONS } from '../../src/sim/weapons';
import type { CreatureMind, GroundXZ, MindScript } from '../../src/world/creatures/mind';
import type { RulerMind } from '../../src/world/creatures/rulerMind';
import { GIVE_TOOLS } from '../../src/world/devOps';
import { spawnBox, spawnGrass, spawnLog, spawnRopeCoil, spawnStick, spawnTree, type XZ } from '../../src/world/factory';
import { CHARACTER_TUNING } from '../../src/world/characters';
import { physicsReady } from '../../src/world/physics';
import type { Terrain } from '../../src/world/terrain';
import type { Entity, MaterialId, Owner, Pose3, Quat, V3, WorldEvent, WoundRecord } from '../../src/world/types';
import { isDirtPile } from '../../src/world/verbs/dig';
import { chestPoint, targetDistance } from '../../src/world/verbs/targets';
import { VERB_TUNING } from '../../src/world/verbs/tuning';
import { createWorld, type StepResult, type World, type WorldOptions } from '../../src/world/world';
import { sceneBytes } from './globalSetup';
export { SCENE_BUILD_TIMEOUT_MS } from './globalSetup';

export type { XZ } from '../../src/world/factory';

/** A verb command as the harness takes it: the payload only (tick, player and kind are the harness's). */
export type VerbPayload = Omit<VerbCommand, 'tick' | 'player' | 'kind'>;

/** What became of a verb the harness sent: refused (with the first refusal's reason) or not, and the events meanwhile. */
export interface VerbOutcome {
  ok: boolean;
  reason: string | null;
  /** Every world event of the ticks the verb took (copies of the arrays; the events themselves). */
  events: WorldEvent[];
}

/** A fixture operation: something a test scene did that no command did (§11.0 "logged fixture ops"). */
export interface FixtureOp {
  tick: number;
  op: 'stage' | 'unstage' | 'standAt' | 'keepAwake' | 'give' | 'pause' | 'creature' | 'script' | 'patrol' | 'spawn';
  what: string;
  /** A standAt's kind of way (standAtWhy): up a wall, down a drop, or neither (a walk could have done it). */
  why?: StandAtWhy;
}

/**
 * Why a standAt was a teleport and not a walk, from the terrain on the straight line (§11.0: "a wall steeper than the
 * KCC's 45°"): `wall` a climb steeper than that (wallOnPath), `drop` a descent as steep and deeper than an autostep
 * (into a pit: he'd fall), `other` neither (a walk could have done it: a body or a load in the way, or the recipe's
 * choice).
 */
export type StandAtWhy = 'wall' | 'drop' | 'other';

export type GiveTool = 'stoneAxe' | 'diggingStick' | 'spear' | 'axe2h';

export interface Harness {
  w: World;
  /** The player (player number 1, 'p1'). */
  readonly p: Fighter;
  /** Every event since the harness was made (copies of each tick's arrays). */
  readonly history: { combat: CombatEvent[]; world: WorldEvent[] };
  /** The fixture operations so far, in order. */
  readonly fixtures: readonly FixtureOp[];
  /** One tick (the pace driver, if any, sends its move first); the arrays are copies. */
  step(): StepResult;
  ticks(n: number, each?: (r: StepResult, t: number) => void): { combat: CombatEvent[]; world: WorldEvent[] };
  until(pred: () => boolean, maxTicks: number, what: string): number;
  // entities, through the factory world generation uses (§6.7)
  log(o: LogSpec): number;
  stick(o: { length: number; r: number; p: V3; q?: Quat; material?: MaterialId; sharp?: { end: 1 | -1; s: number } }): number;
  coil(o: { material: 'vine' | 'sinew'; lengthM: number; at: V3 }): number;
  grass(o: { p: V3; mass: number }): number;
  tree(o: { at: XZ; diameter: number; height: number; vine?: { anchorH: number; lengthM: number; yaw: number } }): {
    tree: number;
    vine: { rope: number; joint: number } | null;
  };
  box(o: { p: V3; size: [number, number, number]; material: MaterialId; state: 'free' | 'fixed'; look: string }): number;
  keepAwake(entity: number, on?: boolean): void;
  // staging
  stage(entity: number, pose?: Pose3): void;
  unstage(entity: number): void;
  // the scripted player
  give(tool: GiveTool, into?: 'hands' | 'back'): number;
  standAt(p: V3 | XZ, yaw?: number): void;
  /** The standAts so far by why (FixtureOp.why). */
  standAts(): Record<StandAtWhy, number>;
  verb(v: VerbPayload, o?: { maxTicks?: number }): VerbOutcome;
  /** A verb that must succeed (throws with the reason otherwise). */
  must(v: VerbPayload, what?: string): VerbOutcome;
  walk(to: XZ, o?: WalkOptions): boolean;
  approach(entity: number, o?: { within?: number }): void;
  carryTo(entity: number, to: XZ): void;
  dragTo(entity: number, to: XZ, o?: { tolM?: number; tryOnly?: boolean }): boolean;
  strikeAt(target: number | V3, button: Button, n: number): { combat: CombatEvent[]; world: WorldEvent[] };
  digPit(o: DigPitOptions): DigPitResult;
  /** The same planner, yielding between strikes to keep Vitest RPC responsive. */
  digPitAsync(o: DigPitOptions): Promise<DigPitResult>;
  chopTo(tree: number, remaining: number): { chops: number; swings: number };
  pull(onTicks: number): { combat: CombatEvent[]; world: WorldEvent[] };
  reelIn(joint: number, leaveSlackM: number, o?: { maxTicks?: number }): number;
  pace(at: XZ, along: XZ, halfM: number, untilTick: number, o?: { speed?: number }): void;
  // creatures
  creature(kind: 'ape' | 'giantApe', at: XZ, yaw: number, opts?: { brain?: 'off' | 'on' }): Fighter;
  mind(f: Fighter): CreatureMind;
  script(f: Fighter, s: MindScript): void;
  patrol(f: Fighter, route: readonly XZ[]): void;
  pause(f: Fighter): void;
  // observation
  impacts(on?: Fighter): Extract<WorldEvent, { type: 'impact' }>[];
  tripwires(): Extract<WorldEvent, { type: 'tripwire' }>[];
  wounds(f: Fighter): WoundRecord[];
  nearestDistH(from: XZ, owners: Owner[]): number;
  ent(id: number): Entity;
  bodyStateBytes(): Uint8Array;
  saveBytes(): Uint8Array;
}

export interface LogSpec {
  mass?: number;
  length: number;
  r: number;
  material?: MaterialId;
  p: V3;
  q?: Quat;
  state?: 'free' | 'anchored' | 'fixed';
}

export interface WalkOptions {
  /** 0..1 of full move input (1 = DS run). Default 1. */
  speed?: number;
  crouch?: boolean;
  /** Arrival distance, m. Default 0.12. */
  tolM?: number;
  /** Return false instead of throwing when the walk can't get there. */
  tryOnly?: boolean;
  /**
   * Give up after this many ticks without 5 cm of progress. Default WALK_STUCK_TICKS (3 s): long enough that a walk
   * only fails where the way is really shut (a wall over the controller's 45°, a body in the way), not at a stumble.
   */
  stuckTicks?: number;
}

export interface DigPitOptions {
  centre: XZ;
  lengthX: number;
  widthZ: number;
  depth: number;
  /** Gate: throws when the pit isn't finished within this many ticks. */
  maxTicks: number;
  /** Gate: throws past this many strikes (default: none). */
  maxStrikes?: number;
  /**
   * The sides dirt piles on the footprint are dragged out of: 'z' (the long sides of a pit along x, keeping its ends
   * clear for a charge along x), 'x', or 'any' (the nearest side; default).
   */
  pileSides?: 'x' | 'z' | 'any';
}

export interface DigPitResult {
  strikes: number;
  ticks: number;
  /** Strikes that dug (a `dig` event of this player's swing). */
  digs: number;
  /** Logged standAt moves the planner made, in all (= the sum of standAtWhy). */
  standAts: number;
  /**
   * Why: `wall` a stand spot up a terrain wall over the controller's 45° (wallOnPath, §11.0's case), `stuck` a walk
   * that failed anyway (WALK_STUCK_TICKS without progress), `piles` onto the rim to drag a pile out, `exit` out of the
   * finished pit.
   */
  standAtWhy: { wall: number; stuck: number; piles: number; exit: number };
  /** Dirt piles dragged out of the footprint. */
  pilesMoved: number;
  /** Edge strike centres given up (DIG_PLAN.giveUpFails failed strikes in a row): the pit's corners stay shallower there. */
  abandoned: XZ[];
  /** Digs by how far from their strike centre they landed: 0.1 m bins, the last ≥ 0.5 m. */
  misses: number[];
  /** The strike count when each layer was done. */
  layerStrikes: number[];
  /** Where the ticks went: walking to stand spots, swinging (the aimed turn and the swing), clearing piles. */
  tickSplit: { walk: number; swing: number; piles: number };
}

// ---------------------------------------------------------------------------
// The harness's own numbers. Test constants (geometry of the scripted player's habits), not tuning (§9): no rule reads
// them; they only decide where the scripted player stands and how it walks.
// ---------------------------------------------------------------------------

/**
 * The dig planner's habits (§11.0, RF-11, ledger P15). Measured with the real swing (P23): the digging stick's aimed
 * committed swing lands where it is aimed, 0.85-1.75 m ahead; aimed 1.0 m ahead it reaches ground 0.75 m below the
 * feet, aimed 1.6 m ahead only 0.42 m (§5.2's "0.534 m below, 1.56 m ahead" is the unaimed overhead's lowest point);
 * the deeper it reaches, the further right of its aim it comes down, and in a narrow hole it clangs on the walls. So
 * the planner seeds the footprint with a sparse lattice of strikes (the spoil then goes outside it, §4.13), then digs
 * 0.5 m layers in kernel-like passes (each centre once a pass, so the floor goes down evenly), standing about level
 * with each strike, 1.0 m (or 1.4 m) from it, with any wall on the swing's left. It walks between stand spots, and
 * takes a logged standAt where the way is up a wall over 45° (wallOnPath) or a walk fails anyway. The measured strikes
 * and ticks are printed by the tests (`dig …`, `buildPit: dig …`) and kept in docs/work/ledger.md (P23), not here: a
 * number in this file would change the scene hash.
 */
export const DIG_PLAN = {
  /** [ahead, below the feet] (m): where the aimed swing lands, and how deep its head gets there. */
  reaches: [
    [1.0, 0.7],
    [1.4, 0.45],
  ] as readonly (readonly [number, number])[],
  /** What standing for the longer reach costs in a stand spot's score (m). */
  longReachCostM: 1.5,
  /** The stand spot's ground at most this far below the strike point. */
  belowStrikeMaxM: 0.25,
  /** The stand spot's ground must be this much lower than the head's deepest reach demands. */
  reachMarginM: 0.05,
  layerM: 0.5,
  gridM: 0.3,
  /** Grid inset from the footprint's edge (the RT lab's planner and verbs.dig.test's kernel: 0.25 m). */
  insetM: 0.25,
  /**
   * A strike centre is struck while any vertex within this radius of it is above the layer's floor + floorTolM; 0: the
   * vertex nearest it (the RT lab's kernel, the 3,185-strike basis of the 3,822 gate). DEVIATION (§11.0 "any vertex
   * within 0.25 m"): that reading digs the footprint's edges down vertically, about twice the strikes (P23 measured a
   * 3 × 2 × 1.5 m pit: 524 strikes against the kernel's 250), so it could never meet the gate measured with the kernel.
   */
  vertexRadiusM: 0,
  floorTolM: 0.02,
  /** Strike centres this near the footprint's edge count as dug within edgeTolM of the floor (see tolOf). */
  edgeM: 0.5,
  edgeTolM: 0.35,
  /**
   * An edge centre struck this many times in a row in a layer without being lowered is given up. DEVIATION (§11.0):
   * in a corner, with walls on two sides, every overhead clangs on a wall (P23 measured 40 passes without a dig at an
   * 8 × 6 m pit's corner centre 1.3 m down); the kernel strikes it exactly, a man can't.
   */
  giveUpFails: 12,
  /** Stand spots stay this far inside the footprint once the pit is deeper than the first layer. */
  standInsetM: 0.25,
  /** How close the player gets to a stand spot before striking. */
  standTolM: 0.2,
  /** Below the original ground by more than this, the player is in the pit (he leaves it by a logged standAt). */
  stepM: 0.4,
  /** Directions tried for a stand spot. */
  directions: 32,
  /** A strike that lands more than aimTolM from its centre (or digs nothing) marks its stand direction bad for that centre and layer. */
  aimTolM: 0.3,
  /**
   * Where the swing's head passes, in the player's frame ([forward, right] m from the stand spot): ground there higher
   * than the strike centre + clearM costs penaltyPerM per metre in the stand spot's score (P23 measured the aimed swing
   * landing up to 0.5 m right of and 0.3 m beyond its aim once it reaches 0.75 m below the feet).
   */
  swingSamples: [
    [0.5, 0.3],
    [0.8, 0.4],
    [1.1, 0.5],
    [1.3, 0.6],
    [1.0, 0.8],
    [1.3, 0.0],
  ] as readonly (readonly [number, number])[],
  clearM: 0.3,
  penaltyPerM: 20,
  /** How many times a layer may forget its bad directions before the planner gives up. */
  maxResets: 3,
  /** A dirt pile within this margin of the footprint (0: on it) is dragged out, pileOutM beyond the footprint's nearest side. */
  pileMarginM: 2.0,
  pileOutM: 4.5,
  /** The seed strikes' lattice spacing (m): every footprint point within ~1 m of a dug vertex. */
  seedM: 1.8,
  /** This many passes in a row that lower nothing fail the planner. */
  maxIdlePasses: 40,
  /** Aim shift toward the footprint's middle per failed strike at a centre, and its cap (m). */
  aimShiftM: 0.08,
  aimShiftMaxM: 0.3,
  aimShiftEdgeM: 0.6,
  /** Bad stand directions are forgotten every this many passes (the ground has changed since). */
  forgetPasses: 3,
} as const;

/** walk's default stuckTicks (3 s at 60 Hz). */
export const WALK_STUCK_TICKS = 180;

/**
 * The steepest climb on the terrain from `a` to `b` (extended by the capsule's radius: its edge meets a wall before its
 * centre does): the largest rise ÷ run over any stretch of the line that rises more than WALL_MIN_RISE_M, as a slope
 * angle in degrees (0 when nothing rises that much). Sampled every 0.05 m.
 */
export function steepestClimbDeg(t: Terrain, a: XZ, b: XZ): number {
  const d0 = flat(a, b);
  if (d0 < 1e-6) return 0;
  const d = d0 + CHARACTER_TUNING.capsuleR;
  const n = Math.max(1, Math.ceil(d / 0.05));
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) {
    const f = (i / n) * (d / d0);
    ys.push(t.heightAt(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f));
  }
  let worst = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= n; j++) {
      const rise = ys[j] - ys[i];
      if (rise > WALL_MIN_RISE_M) worst = Math.max(worst, (Math.atan2(rise, ((j - i) / n) * d) * 180) / Math.PI);
    }
  }
  return worst;
}

/** A rise smaller than this is a step the controller's snap and autostep take whatever its slope (m). */
export const WALL_MIN_RISE_M = 0.1;

/**
 * Is there a wall on the way from `a` to `b` (§11.0: "a wall steeper than the KCC's 45°")? A climb steeper than
 * CHARACTER_TUNING.maxSlopeClimbDeg (steepestClimbDeg). Going down is never a wall (he drops). Terrain only: piles
 * and bodies are walk's to find.
 */
export function wallOnPath(t: Terrain, a: XZ, b: XZ): boolean {
  return steepestClimbDeg(t, a, b) > CHARACTER_TUNING.maxSlopeClimbDeg;
}

/** Where the stone axe's head meets a 30 cm trunk (ledger P15 → P23): ~1.2-1.4 m off its surface. */
export const CHOP_STAND_M = [1.3, 1.2, 1.4, 1.1, 1.5] as const;

const GIVE_INDEX: Record<Exclude<GiveTool, 'axe2h'>, number> = {
  stoneAxe: GIVE_TOOLS.indexOf('stoneAxe'),
  diggingStick: GIVE_TOOLS.indexOf('diggingStick'),
  spear: GIVE_TOOLS.indexOf('spear'),
};

/** Back slot (stow / draw `slot`, §5.1). */
export const BACK_SLOT = 3;

const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** A world harness for tests. `scene 'empty'` and nav 'off' unless asked; devChecks on (ledger P31/P23). */
export async function makeHarness(o: Partial<WorldOptions> & { seed: number }): Promise<Harness> {
  await physicsReady();
  const w = await createWorld({ scene: 'empty', nav: 'off', ...o });
  return new WorldHarness(w);
}

/** A harness around a world loaded from save bytes (nav 'off' unless asked). */
export async function loadHarness(bytes: Uint8Array, o?: { nav?: 'full' | 'off' }): Promise<Harness> {
  const w = await loadWorld(bytes, { nav: o?.nav ?? 'off' });
  return new WorldHarness(w);
}


/**
 * A cached scene (globalSetup.ts): the save bytes of `key` for this tree's hash, built on the first call that finds
 * no file (once across workers, under a lock; the pit takes minutes, so await it in a `beforeAll` with
 * SCENE_BUILD_TIMEOUT_MS). Throws the build's error when it failed in this run.
 */
export function cachedScene(key: string): Promise<Uint8Array> {
  return sceneBytes(key);
}

class WorldHarness implements Harness {
  readonly w: World;
  readonly history: { combat: CombatEvent[]; world: WorldEvent[] } = { combat: [], world: [] };
  readonly fixtures: FixtureOp[] = [];
  /** The pace driver: sends a move before each step while it runs. */
  private driver: (() => void) | null = null;

  constructor(w: World) {
    this.w = w;
    // CombatSim's dev cross-check (ledger P31/P23): a DS drop in world mode throws instead of passing silently.
    w.combat.devChecks = true;
  }

  get p(): Fighter {
    const f = this.w.player;
    if (!f) throw new Error('harness: the world has no player');
    return f;
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  step(): StepResult {
    this.driver?.();
    const r = this.w.step();
    const out: StepResult = { combat: r.combat.slice(), world: r.world.slice(), save: r.save };
    for (const e of out.combat) this.history.combat.push(e);
    for (const e of out.world) this.history.world.push(e);
    return out;
  }

  ticks(n: number, each?: (r: StepResult, t: number) => void): { combat: CombatEvent[]; world: WorldEvent[] } {
    const out = { combat: [] as CombatEvent[], world: [] as WorldEvent[] };
    for (let i = 0; i < n; i++) {
      const r = this.step();
      out.combat.push(...r.combat);
      out.world.push(...r.world);
      each?.(r, this.w.tick);
    }
    return out;
  }

  until(pred: () => boolean, maxTicks: number, what: string): number {
    if (pred()) return this.w.tick;
    for (let i = 0; i < maxTicks; i++) {
      this.step();
      if (pred()) return this.w.tick;
    }
    throw new Error(`${what} not reached in ${maxTicks}`);
  }

  private push(c: Command): void {
    this.w.commands.push(c);
  }

  private fixture(op: FixtureOp['op'], what: string): void {
    this.fixtures.push({ tick: this.w.tick, op, what });
  }

  /**
   * The staging fence (§11.0, rule 1, orchestrator decision 8): once any creature is in the world (brain on or off,
   * scripted or not), the scene is live. A fixture can then no longer move, pin or free anything (`stage`/`unstage`
   * refuse), so no fixture can become a trap's trigger; and every factory spawn from then on is logged in `fixtures`.
   */
  private live(): boolean {
    const player = this.w.player;
    return this.w.combat.fighters.some((f) => f !== player);
  }

  private spawned(id: number, what: string): number {
    if (this.live()) this.fixture('spawn', `${what} ${id}`);
    return id;
  }

  // -------------------------------------------------------------------------
  // Entities (the factory, §6.7). Never `generated`: a harness entity is saved like anything a player made.
  // -------------------------------------------------------------------------

  log(o: LogSpec): number {
    return this.spawned(spawnLog(this.w, { p: o.p, q: o.q, length: o.length, r: o.r, mass: o.mass, material: o.material, state: o.state }), 'log');
  }

  stick(o: { length: number; r: number; p: V3; q?: Quat; material?: MaterialId; sharp?: { end: 1 | -1; s: number } }): number {
    return this.spawned(spawnStick(this.w, { p: o.p, q: o.q, length: o.length, r: o.r, material: o.material, sharp: o.sharp }), 'stick');
  }

  coil(o: { material: 'vine' | 'sinew'; lengthM: number; at: V3 }): number {
    return this.spawned(spawnRopeCoil(this.w, { at: o.at, material: o.material, lengthM: o.lengthM }), 'coil');
  }

  grass(o: { p: V3; mass: number }): number {
    return this.spawned(spawnGrass(this.w, { p: o.p, mass: o.mass }), 'grass');
  }

  tree(o: { at: XZ; diameter: number; height: number; vine?: { anchorH: number; lengthM: number; yaw: number } }): {
    tree: number;
    vine: { rope: number; joint: number } | null;
  } {
    const t = spawnTree(this.w, { at: o.at, diameter: o.diameter, height: o.height, vine: o.vine });
    this.spawned(t.tree, `tree${t.vine ? ` (vine ${t.vine.rope})` : ''}`);
    return t;
  }

  box(o: { p: V3; size: [number, number, number]; material: MaterialId; state: 'free' | 'fixed'; look: string }): number {
    return this.spawned(spawnBox(this.w, { p: o.p, size: o.size, material: o.material, state: o.state, look: o.look }), 'box');
  }

  keepAwake(entity: number, on = true): void {
    this.w.entities.keepAwake(entity, on);
    this.fixture('keepAwake', `${entity} ${on ? 'on' : 'off'}`);
  }

  ent(id: number): Entity {
    const e = this.w.entities.get(id);
    if (!e) throw new Error(`harness: no entity ${id}`);
    return e;
  }

  // -------------------------------------------------------------------------
  // Staging (D-25): fixture ops, before a scene's trigger: refused once any creature exists (`live`).
  // -------------------------------------------------------------------------

  stage(entity: number, pose?: Pose3): void {
    if (this.live()) throw new Error(`harness.stage(${entity}): refused, a creature is in the world (§11.0: staging comes before the trigger)`);
    const e = this.ent(entity);
    if (e.state !== 'free' && e.state !== 'fixed') throw new Error(`harness.stage(${entity}): a ${e.state} entity can't be staged`);
    if (pose) this.w.entities.setPose(e, pose);
    this.w.entities.setState(e, 'fixed');
    this.fixture('stage', `${entity}${pose ? ` at (${pose.p.x.toFixed(2)}, ${pose.p.y.toFixed(2)}, ${pose.p.z.toFixed(2)})` : ''}`);
  }

  unstage(entity: number): void {
    if (this.live()) throw new Error(`harness.unstage(${entity}): refused, a creature is in the world (§11.0: staging comes before the trigger)`);
    const e = this.ent(entity);
    if (e.state !== 'fixed' || e.plant) throw new Error(`harness.unstage(${entity}): not a staged entity (${e.state})`);
    this.w.entities.setState(e, 'free');
    e.body?.wakeUp();
    this.fixture('unstage', `${entity}`);
  }

  // -------------------------------------------------------------------------
  // The scripted player: commands only
  // -------------------------------------------------------------------------

  /**
   * `meta 'dev' giveTool` (the tool made by the factory at the player's feet, into its hands), then into the back slot
   * with a `stow` verb when asked. Returns the entity the hands took (the axe's handle). 'axe2h' is DungeonStyle's
   * two-handed axe (AC-4, WEAPONS.axe): no entity makes it and no dev op gives it, so it is a logged fixture write of
   * the player's weapon (returns 0).
   */
  give(tool: GiveTool, into: 'hands' | 'back' = 'hands'): number {
    const p = this.p;
    if (tool === 'axe2h') {
      // DEVIATION (§11.4 "through give('axe2h')"): devOps' giveTool has no DS weapon; see the report (P22-fix).
      // TODO(P23 → SIM-fix3): a `meta 'dev' giveTool` command once devOps gives the DS axe (the coordinator's item 8).
      if (into !== 'hands') throw new Error("harness.give('axe2h'): a DS weapon has no entity to stow");
      if (p.inventory?.hands) this.verb({ verb: 'drop', target: 0 });
      p.weapon = WEAPONS.axe;
      this.fixture('give', 'axe2h (WEAPONS.axe written to the player)');
      return 0;
    }
    const cmd: MetaCommand = { tick: this.w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'giveTool', args: [GIVE_INDEX[tool]] } };
    this.push(cmd);
    this.step();
    const h = p.inventory?.hands;
    if (!h) throw new Error(`harness.give('${tool}'): nothing in the hands (is the player down?)`);
    const id = h.entity;
    this.fixture('give', `${tool} → ${id}`);
    if (into === 'back') {
      const r = this.verb({ verb: 'stow', target: 0, slot: BACK_SLOT });
      if (!r.ok) throw new Error(`harness.give('${tool}', 'back'): stow refused ${r.reason}`);
    }
    return id;
  }

  /**
   * A logged fixture move (World.teleport between ticks: pose history reset and a contact grace, §4.3): the player at
   * (x, z) on the highest support there, facing `yaw` if given, its `why` (StandAtWhy) from the terrain on the straight
   * line. (The dev op `teleport` carries no yaw, so the harness calls World.teleport itself and records it.)
   */
  standAt(at: V3 | XZ, yaw?: number): void {
    const p = this.p;
    const t = this.w.terrain;
    const from = { x: p.pos.x, z: p.pos.z };
    const why: StandAtWhy = wallOnPath(t, from, at)
      ? 'wall'
      : steepestClimbDeg(t, at, from) > CHARACTER_TUNING.maxSlopeClimbDeg && t.heightAt(at.x, at.z) < t.heightAt(from.x, from.z) - CHARACTER_TUNING.autostepMaxH
        ? 'drop'
        : 'other';
    // TODO(P23 → SIM-fix3): a `meta 'dev' teleport` command once it carries a yaw (the coordinator's item 8).
    this.w.teleport(p, at.x, at.z, yaw);
    this.fixtures.push({ tick: this.w.tick, op: 'standAt', what: `(${at.x.toFixed(2)}, ${at.z.toFixed(2)})${yaw === undefined ? '' : ` yaw ${yaw.toFixed(3)}`} ${why}`, why });
  }

  standAts(): Record<StandAtWhy, number> {
    const n: Record<StandAtWhy, number> = { wall: 0, drop: 0, other: 0 };
    for (const f of this.fixtures) if (f.op === 'standAt' && f.why) n[f.why]++;
    return n;
  }

  /**
   * Queues the verb for the next tick and steps until it has run: refused, or acted with the player free again and no
   * continuous verb on (a repeating shape strokes until its end is sharp). `focus` and `pull` return after one tick
   * (focus is immediate; pull is on until switched off: use pull()/reelIn()).
   */
  verb(v: VerbPayload, o?: { maxTicks?: number }): VerbOutcome {
    const w = this.w;
    const p = this.p;
    const cmd = { tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand;
    this.push(cmd);
    const events: WorldEvent[] = [];
    let reason: string | null = null;
    const max = o?.maxTicks ?? 2400;
    const note = (r: StepResult): void => {
      for (const e of r.world) {
        events.push(e);
        if (reason === null && e.type === 'verb' && e.f === p && e.verb === v.verb && !e.ok) reason = e.reason ?? 'refused';
      }
    };
    note(this.step());
    if (v.verb === 'focus' || v.verb === 'pull') return { ok: reason === null, reason, events };
    // `max` ticks in all (the first above): the check after the last step decides, not the step count.
    for (let t = 1; reason === null && !(p.free && !p.verbRequest && !w.verbs.continuousOf(p)); t++) {
      if (t >= max) throw new Error(
          `harness.verb(${v.verb} ${v.target}): not done in ${max} ticks (state ${p.state}, hands ${p.inventory?.hands ? `${p.inventory.hands.mode} ${p.inventory.hands.entity}` : 'empty'}, continuous ${w.verbs.continuousOf(p)?.verb ?? 'none'})`,
        );
      note(this.step());
    }
    // A refused verb leaves the player as it was; let a work action that is still playing out finish.
    for (let t = 0; t < max && !(p.free && !p.verbRequest); t++) note(this.step());
    return { ok: reason === null, reason, events };
  }

  /** A verb that must succeed (throws with the reason otherwise). */
  must(v: VerbPayload, what = `${v.verb} ${v.target}`): VerbOutcome {
    const r = this.verb(v);
    if (!r.ok) throw new Error(`harness: ${what} refused (${r.reason})`);
    return r;
  }

  /**
   * Move commands every tick toward `to` (eased in over the last 0.6 m) until within tolM, then a zero move. Fails (a
   * throw, or false with tryOnly) when 5 cm of progress takes more than stuckTicks.
   */
  walk(to: XZ, o: WalkOptions = {}): boolean {
    const p = this.p;
    const tol = o.tolM ?? 0.12;
    const speed = o.speed ?? 1;
    const flags = o.crouch ? MOVE_CROUCH : 0;
    const stuck = o.stuckTicks ?? WALK_STUCK_TICKS;
    let best = flat(p.pos, to);
    let since = 0;
    for (;;) {
      const d = flat(p.pos, to);
      if (d <= tol) break;
      if (d < best - 0.05) {
        best = d;
        since = 0;
      } else if (++since > stuck) {
        this.stop(flags);
        if (o.tryOnly) return false;
        throw new Error(`harness.walk to (${to.x.toFixed(2)}, ${to.z.toFixed(2)}): stuck ${d.toFixed(2)} m away at (${p.pos.x.toFixed(2)}, ${p.pos.z.toFixed(2)})`);
      }
      const mag = speed * Math.min(1, Math.max(0.25, d / 0.6));
      this.push(moveCommand(this.w.tick + 1, 1, ((to.x - p.pos.x) / d) * mag, ((to.z - p.pos.z) / d) * mag, flags));
      this.step();
    }
    this.stop(flags);
    return true;
  }

  private stop(flags = 0): void {
    this.push(moveCommand(this.w.tick + 1, 1, 0, 0, flags));
    this.step();
  }

  /**
   * Walks to within `within` (default 1.0 m) of the entity's surface point nearest the player's chest, horizontally
   * (a hanging vine: its loose end); when the walk is blocked, a logged standAt there. Nothing happens when the player
   * is that close already.
   */
  approach(entity: number, o?: { within?: number }): void {
    const within = o?.within ?? 1.0;
    const near = this.nearestPointOf(entity);
    const p = this.p;
    const d = flat(p.pos, near);
    if (d <= within + 0.05) return;
    const k = (d - within) / d;
    const goal = { x: p.pos.x + (near.x - p.pos.x) * k, z: p.pos.z + (near.z - p.pos.z) * k };
    // Something in the way (a pile, a berm, a wall steeper than the controller climbs), or still out of the verbs'
    // range (a thing below a bank): a logged standAt there.
    const walked = this.walk(goal, { tolM: 0.1, tryOnly: true });
    const range = targetDistance(this.w, p, entity);
    if (!walked || (range !== null && range > VERB_TUNING.targetRadiusM - 0.2)) {
      this.standAt(goal);
      this.step();
    }
  }

  /** The entity's surface point nearest the player's chest; a tied rope's loose end (or its nearest point). */
  private nearestPointOf(entity: number): V3 {
    const w = this.w;
    const e = this.ent(entity);
    if (e.body && e.collider && e.body.isEnabled()) return w.queries.projectPoint(entity, chestPoint(this.p)).point;
    for (const j of w.joints.all()) {
      if (j.rope?.entity !== entity) continue;
      const end = j.a.loose ? j.a : j.b.loose ? j.b : null;
      const pts = w.joints.endPoints(j);
      if (end && pts) return end === j.a ? pts.a : pts.b;
      if (pts) return pts.b;
    }
    return e.pose.p;
  }

  /** Approach, take (carry or wield), walk to `to` (place is a separate verb). */
  carryTo(entity: number, to: XZ): void {
    this.approach(entity);
    this.must({ verb: 'take', target: entity });
    const h = this.p.inventory?.hands;
    if (!h || h.entity !== entity || (h.mode !== 'carry' && h.mode !== 'wield')) throw new Error(`harness.carryTo(${entity}): taken as ${h?.mode ?? 'nothing'}`);
    this.walk(to);
  }

  /**
   * Approach, take (drag; a load light enough to carry is carried), walk until the entity's centre is within tolM
   * (default 0.5 m) of `to` horizontally, drop. When 5 cm of progress takes more than 4 s it throws, or with tryOnly
   * drops the load where it is and returns false.
   */
  dragTo(entity: number, to: XZ, o?: { tolM?: number; tryOnly?: boolean }): boolean {
    const tol = o?.tolM ?? 0.5;
    this.approach(entity);
    if (o?.tryOnly) {
      if (!this.verb({ verb: 'take', target: entity }).ok) return false;
    } else this.must({ verb: 'take', target: entity });
    const p = this.p;
    const h = p.inventory?.hands;
    if (!h || h.entity !== entity) throw new Error(`harness.dragTo(${entity}): not in the hands`);
    const e = this.ent(entity);
    const from = { x: e.pose.p.x, z: e.pose.p.z };
    const d0 = flat(from, to);
    if (d0 > tol) {
      // Carried, the load is in the hands: the player walks to `to`. Dragged, it trails up to tetherM behind them: he
      // heads for a point `lead` past `to` on the line from where the load is now, re-aimed every tick (a pursuit, so a
      // load that drifts aside is brought back), and stops when it arrives.
      const lead = h.mode === 'drag' ? Math.max(2.5, flat(p.pos, e.pose.p) + 1.5) : 0;
      let best = Infinity;
      let since = 0;
      for (;;) {
        const de = flat(e.pose.p, to);
        if (de <= tol) break;
        const ux = (to.x - e.pose.p.x) / de;
        const uz = (to.z - e.pose.p.z) / de;
        const goal = h.mode === 'drag' ? { x: to.x + ux * lead, z: to.z + uz * lead } : to;
        const dp = flat(p.pos, goal);
        if (dp <= 0.15 && h.mode !== 'drag') break;
        if (de < best - 0.05) {
          best = de;
          since = 0;
        } else if (++since > 240) {
          if (!o?.tryOnly) {
            throw new Error(
              `harness.dragTo(${entity}): stuck ${de.toFixed(2)} m from (${to.x}, ${to.z}): it is at (${e.pose.p.x.toFixed(2)}, ${e.pose.p.y.toFixed(2)}, ${e.pose.p.z.toFixed(2)}), the player at (${p.pos.x.toFixed(2)}, ${p.pos.z.toFixed(2)}) ${h.mode}`,
            );
          }
          this.stop();
          this.must({ verb: 'drop', target: 0 });
          return false;
        }
        const mag = Math.min(1, Math.max(0.3, dp / 0.6));
        this.push(moveCommand(this.w.tick + 1, 1, ((goal.x - p.pos.x) / Math.max(dp, 1e-6)) * mag, ((goal.z - p.pos.z) / Math.max(dp, 1e-6)) * mag));
        this.step();
      }
      this.stop();
    }
    this.must({ verb: 'drop', target: 0 });
    return true;
  }

  /** Focus on the entity or the ground point, then `n` presses of `button`, each played out until the player is free. */
  strikeAt(target: number | V3, button: Button, n: number): { combat: CombatEvent[]; world: WorldEvent[] } {
    const out = { combat: [] as CombatEvent[], world: [] as WorldEvent[] };
    const focus: VerbPayload = typeof target === 'number' ? { verb: 'focus', target } : { verb: 'focus', target: 0, at: toCm(target) };
    const f = this.verb(focus);
    if (!f.ok) throw new Error(`harness.strikeAt: focus refused (${f.reason})`);
    const p = this.p;
    for (let i = 0; i < n; i++) {
      const c: ButtonCommand = { tick: this.w.tick + 1, player: 1, kind: 'button', button };
      this.push(c);
      let started = false;
      for (let t = 0; t < 600; t++) {
        const r = this.step();
        out.combat.push(...r.combat);
        out.world.push(...r.world);
        if (!p.free) started = true;
        if (started && p.free) break;
        if (!started && t > 30) break; // the press never started an attack (out of stamina, down): move on
      }
    }
    return out;
  }

  /**
   * Stone-axe chops (`cut` verbs, aimed swings at the trunk) until the tree's cut has `remaining` (the fraction of the
   * diameter left, PlantState.cut: 1 − Σdepth ÷ diameter) ≤ the value. The
   * player first stands CHOP_STAND_M[0] off the trunk's surface on the side he is on (fromDir is that side, §2.5); a
   * swing that doesn't chop (the haft met it, ledger P15) moves him to the next distance in CHOP_STAND_M.
   */
  chopTo(tree: number, remaining: number): { chops: number; swings: number } {
    const p = this.p;
    const t = this.ent(tree);
    if (!t.plant) throw new Error(`harness.chopTo(${tree}): not a tree`);
    const c = { x: t.pose.p.x, z: t.pose.p.z };
    const d = flat(p.pos, c);
    if (d < 1e-6) throw new Error('harness.chopTo: the player stands in the trunk');
    const ux = (p.pos.x - c.x) / d;
    const uz = (p.pos.z - c.z) / d;
    const r = t.plant.diameter / 2;
    let chops = 0;
    let swings = 0;
    let at = 0;
    let misses = 0;
    const stand = (): void => {
      const s = r + CHOP_STAND_M[at % CHOP_STAND_M.length];
      if (!this.walk({ x: c.x + ux * s, z: c.z + uz * s }, { tolM: 0.06, speed: 0.4, tryOnly: true })) this.standAt({ x: c.x + ux * s, z: c.z + uz * s });
    };
    stand();
    const left = (): number => this.ent(tree).plant?.cut?.remaining ?? (this.ent(tree).plant ? 1 : 0);
    while (left() > remaining + 1e-9) {
      const plant = this.ent(tree).plant;
      if (!plant || plant.phase === 'falling' || plant.phase === 'felled') break;
      if (swings > 200) throw new Error(`harness.chopTo(${tree}): ${swings} swings, ${chops} chops, remaining ${left().toFixed(3)}`);
      const r1 = this.verb({ verb: 'cut', target: tree });
      swings++;
      const chopped = r1.events.filter((e) => e.type === 'chop' && e.tree === tree).length;
      chops += chopped;
      if (chopped > 0) {
        misses = 0;
        continue;
      }
      if (++misses >= 2) {
        misses = 0;
        at++;
        if (at >= 3 * CHOP_STAND_M.length) throw new Error(`harness.chopTo(${tree}): no stand distance chops (${r1.reason ?? 'clang'})`);
        stand();
      }
    }
    return { chops, swings };
  }

  /** Pull on (charge 255) for `onTicks`, then off (one tick). Ends a pace. */
  pull(onTicks: number): { combat: CombatEvent[]; world: WorldEvent[] } {
    this.driver = null;
    const on = this.verb({ verb: 'pull', target: 0, charge: 255 });
    if (!on.ok) throw new Error(`harness.pull: refused (${on.reason})`);
    const out = this.ticks(Math.max(0, onTicks - 1));
    out.world.unshift(...on.events);
    this.verb({ verb: 'pull', target: 0, charge: 0 });
    return out;
  }

  /**
   * Pull on until the joint's free length is within leaveSlackM of taut (rope length − anchor distance ≤ leaveSlackM),
   * then off. Returns the slack left. Ends a pace.
   */
  reelIn(joint: number, leaveSlackM: number, o?: { maxTicks?: number }): number {
    this.driver = null;
    const w = this.w;
    const slack = (): number => {
      const j = w.joints.get(joint);
      const pts = j ? w.joints.endPoints(j) : null;
      if (!j?.rope || !pts) throw new Error(`harness.reelIn(${joint}): no rope joint`);
      return j.rope.lengthM - Math.hypot(pts.a.x - pts.b.x, pts.a.y - pts.b.y, pts.a.z - pts.b.z);
    };
    if (slack() <= leaveSlackM) return slack();
    const on = this.verb({ verb: 'pull', target: 0, charge: 255 });
    if (!on.ok) throw new Error(`harness.reelIn: pull refused (${on.reason})`);
    this.until(() => slack() <= leaveSlackM, o?.maxTicks ?? 3600, `reelIn(${joint}) to ${leaveSlackM} m of slack`);
    this.verb({ verb: 'pull', target: 0, charge: 0 });
    return slack();
  }

  /**
   * From now until `untilTick`, before every step: walk back and forth ±halfM along `along` (normalised) about `at`, at
   * `speed` (default 0.5, a walk), turning at each end; then a zero move. Runs during ticks()/until() and ends early at
   * pull(), reelIn() or pause(this.p).
   */
  pace(at: XZ, along: XZ, halfM: number, untilTick: number, o?: { speed?: number }): void {
    const len = Math.hypot(along.x, along.z);
    if (!(len > 0)) throw new Error('harness.pace: `along` has no length');
    const ux = along.x / len;
    const uz = along.z / len;
    const speed = o?.speed ?? 0.5;
    let sign = 1;
    this.driver = () => {
      const p = this.p;
      const tick = this.w.tick + 1;
      if (tick > untilTick) {
        this.driver = null;
        this.push(moveCommand(tick, 1, 0, 0));
        return;
      }
      let gx = at.x + ux * halfM * sign;
      let gz = at.z + uz * halfM * sign;
      if (flat(p.pos, { x: gx, z: gz }) < 0.1) {
        sign = -sign;
        gx = at.x + ux * halfM * sign;
        gz = at.z + uz * halfM * sign;
      }
      const d = Math.max(1e-6, flat(p.pos, { x: gx, z: gz }));
      this.push(moveCommand(tick, 1, ((gx - p.pos.x) / d) * speed, ((gz - p.pos.z) / d) * speed));
    };
  }

  // -------------------------------------------------------------------------
  // The dig planner (§11.0, RF-11)
  // -------------------------------------------------------------------------

  digPit(o: DigPitOptions): DigPitResult {
    const planner = digPitPlanner(this, o);
    let next = planner.next();
    while (!next.done) next = planner.next();
    return next.value;
  }

  async digPitAsync(o: DigPitOptions): Promise<DigPitResult> {
    const planner = digPitPlanner(this, o);
    let next = planner.next();
    while (!next.done) {
      await yieldToVitest();
      next = planner.next();
    }
    return next.value;
  }

  // -------------------------------------------------------------------------
  // Creatures (AC-2: "a creature's route and actions")
  // -------------------------------------------------------------------------

  /**
   * createCreature at (x, z) facing `yaw` (a logged fixture: the dev ops face the player). brain 'off' (§11 "brain
   * off"): its mind runs a `hold` script from the start (senses update, no transitions: it stands until a test script
   * replaces it). Default 'on'. From here on the staging fence is up (stage/unstage refuse, spawns are logged).
   */
  creature(kind: 'ape' | 'giantApe', at: XZ, yaw: number, opts?: { brain?: 'off' | 'on' }): Fighter {
    const f = this.w.spawnCreature(kind, at, yaw);
    const brain = opts?.brain ?? 'on';
    if (brain === 'off') this.mind(f).script = { kind: 'hold' };
    this.fixture('creature', `${kind} ${f.id} at (${at.x}, ${at.z}) brain ${brain}`);
    return f;
  }

  mind(f: Fighter): CreatureMind {
    const m = this.w.minds.get(f);
    if (!m) throw new Error(`harness: fighter ${f.id} has no mind`);
    return m;
  }

  /** The creature's test script (§6.6). (Staging is refused from the creature's spawn on.) */
  script(f: Fighter, s: MindScript): void {
    this.mind(f).script = s;
    this.fixture('script', `${f.id} ${s.kind}`);
  }

  /** The giant patrols `route` (RulerMind.setRoute, then `patrol`, ledger P20 → P29): no script, its brain on. */
  patrol(f: Fighter, route: readonly XZ[]): void {
    const m = this.mind(f) as RulerMind;
    if (typeof m.setRoute !== 'function') throw new Error(`harness.patrol: fighter ${f.id} is not the giant`);
    m.script = null;
    m.setRoute(route.map((q): GroundXZ => ({ x: q.x, z: q.z })));
    m.enter(this.w, 'patrol');
    this.fixture('patrol', `${f.id} ${route.map((q) => `(${q.x}, ${q.z})`).join(' → ')}`);
  }

  /**
   * AC-5's "paused": a creature's mind paused (no drive or input, idle life paused, §6.6), at once; the player: no more
   * input from the harness (the pace driver ends, a zero move) and idle life paused (a fixture write of idlePaused,
   * which no command sets).
   */
  pause(f: Fighter): void {
    if (f === this.w.player) {
      this.driver = null;
      this.push(moveCommand(this.w.tick + 1, 1, 0, 0));
      f.idlePaused = true;
      this.fixture('pause', `player ${f.id}`);
      return;
    }
    this.mind(f).paused = true;
    f.idlePaused = true;
    this.fixture('pause', `${f.id}`);
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  impacts(on?: Fighter): Extract<WorldEvent, { type: 'impact' }>[] {
    return this.history.world.filter((e): e is Extract<WorldEvent, { type: 'impact' }> => e.type === 'impact' && (!on || e.defender === on));
  }

  tripwires(): Extract<WorldEvent, { type: 'tripwire' }>[] {
    return this.history.world.filter((e): e is Extract<WorldEvent, { type: 'tripwire' }> => e.type === 'tripwire');
  }

  wounds(f: Fighter): WoundRecord[] {
    return f.ruler ? f.ruler.wounds.slice() : [];
  }

  /**
   * The horizontal distance from (x, z) to the nearest point of every collider those owners have (an entity, a
   * fighter's part or all its parts when `part` matches, a rope's sensor): a vertical line's distance to each collider.
   * 0 when the line passes through one; Infinity when no collider matches.
   */
  nearestDistH(from: XZ, owners: Owner[]): number {
    const phys = this.w.physics;
    const line = new RAPIER.Capsule(1000, 1e-4);
    let best = Infinity;
    phys.rapier.forEachCollider((c) => {
      const o = phys.ownerOf(c.handle);
      if (!o || !owners.some((q) => sameOwner(q, o))) return;
      if (c.isEnabled && !c.isEnabled()) return;
      const hit = c.contactShape(line, { x: from.x, y: c.translation().y, z: from.z }, { x: 0, y: 0, z: 0, w: 1 }, 1e6);
      if (!hit) return;
      best = Math.min(best, Math.max(0, hit.distance));
    });
    return best;
  }

  bodyStateBytes(): Uint8Array {
    return bodyStateBytes(this.w);
  }

  saveBytes(): Uint8Array {
    return serializeWorld(this.w);
  }
}

/** Does `o` (a collider's owner) belong to `q`? A fighter owner without `bone` matches every bone of that part. */
function sameOwner(q: Owner, o: Owner): boolean {
  if (q.kind !== o.kind) return false;
  switch (q.kind) {
    case 'terrain':
      return true;
    case 'entity':
      return o.kind === 'entity' && o.id === q.id;
    case 'rope':
      return o.kind === 'rope' && o.joint === q.joint;
    case 'fighter':
      return o.kind === 'fighter' && o.id === q.id && o.part === q.part && (q.bone === undefined || o.bone === q.bone);
  }
}

// ---------------------------------------------------------------------------
// The dig planner (§11.0, RF-11): seed strikes, then layers of DIG_PLAN.layerM struck in passes over a gridM grid, stand spots a reach
// behind each centre on ground low enough for the stick's head to reach the layer's floor.
// ---------------------------------------------------------------------------


interface Centre {
  x: number;
  z: number;
  /** The world vertices that decide whether it is dug: [gi, gj, original height]. */
  verts: [number, number, number][];
  /** Stand directions that failed to dig this centre lately (nothing dug, or dug far from it). */
  bad: Set<number>;
  /** Strikes at it that failed: each moves its aim aimShiftM further toward the footprint's middle (≤ aimShiftMaxM). */
  misses: number;
  /** Failed strikes in a row in this layer. */
  fails: number;
  /** Given up (an edge centre the swing can't reach any more, see giveUpFails): counted as dug from then on. */
  abandoned: boolean;
}

function* digPitPlanner(h: WorldHarness, o: DigPitOptions): Generator<void, DigPitResult> {
  const w = h.w;
  const t = w.terrain;
  const P = DIG_PLAN;
  const p = h.p;
  const tool = p.inventory?.hands;
  if (!tool || tool.mode !== 'wield') throw new Error('harness.digPit: the player must wield a digging tool');
  const toolId = tool.entity;
  const start = w.tick;
  const stats = { miss: [0, 0, 0, 0, 0, 0], layers: [] as number[], walk: 0, swing: 0, piles: 0 };
  const x0 = o.centre.x - o.lengthX / 2;
  const x1 = o.centre.x + o.lengthX / 2;
  const z0 = o.centre.z - o.widthZ / 2;
  const z1 = o.centre.z + o.widthZ / 2;
  const centres: Centre[] = [];
  for (let i = 0; x0 + P.insetM + P.gridM * i <= x1 - P.insetM + 1e-9; i++) {
    for (let j = 0; z0 + P.insetM + P.gridM * j <= z1 - P.insetM + 1e-9; j++) {
      const c = { x: x0 + P.insetM + P.gridM * i, z: z0 + P.insetM + P.gridM * j };
      const verts: [number, number, number][] = [];
      if (!(P.vertexRadiusM > 0)) {
        const v = t.vertexIndex(c.x, c.z);
        verts.push([v.gi, v.gj, t.vertexOriginalAt(v.gi, v.gj)]);
      } else {
        const a = t.vertexIndex(c.x - P.vertexRadiusM, c.z - P.vertexRadiusM);
        const b = t.vertexIndex(c.x + P.vertexRadiusM, c.z + P.vertexRadiusM);
        for (let gj = a.gj; gj <= b.gj; gj++) {
          for (let gi = a.gi; gi <= b.gi; gi++) {
            if (Math.hypot(t.minX + gi * t.spacing - c.x, t.minZ + gj * t.spacing - c.z) <= P.vertexRadiusM + 1e-9) verts.push([gi, gj, t.vertexOriginalAt(gi, gj)]);
          }
        }
      }
      centres.push({ ...c, verts, bad: new Set(), misses: 0, fails: 0, abandoned: false });
    }
  }
  /** How far the centre's highest vertex is above the layer's floor (m; ≤ floorTolM: done). */
  const excessOf = (c: Centre, floor: number): number => {
    let worst = -Infinity;
    for (const [gi, gj, h0] of c.verts) worst = Math.max(worst, t.vertexHeightAt(gi, gj) - (h0 - floor));
    return worst;
  };
  /** The layer's whole excess: Σ over centres of the part above floorTolM. Progress is any decrease. */
  /**
   * How close to the floor a centre counts as dug: floorTolM, or edgeTolM for a centre within edgeM of the footprint's
   * edge. DEVIATION (§11.0 "the dig planner"): the real swing can't place its last strikes at a centre with a 2.5 m wall
   * just behind it as the RT lab's kernel does (P23 measured the last 2-15 cm at such centres taking passes without
   * progress, the overhead clanging on the wall), so the pit's edges may stop up to edgeTolM short of the floor (its walls are cone-sloped anyway; the floor beside them is dug deeper).
   */
  const isEdge = (c: Centre): boolean => Math.min(c.x - x0, x1 - c.x, c.z - z0, z1 - c.z) <= P.edgeM;
  const tolOf = (c: Centre): number => (c.abandoned ? Infinity : isEdge(c) ? P.edgeTolM : P.floorTolM);
  const totalExcess = (floor: number): number => centres.reduce((s, c) => s + Math.max(0, excessOf(c, floor) - tolOf(c)), 0);
  const inside = (q: XZ, inset: number): boolean => q.x >= x0 + inset && q.x <= x1 - inset && q.z >= z0 + inset && q.z <= z1 - inset;
  let strikes = 0;
  let digs = 0;
  const why = { wall: 0, stuck: 0, piles: 0, exit: 0 };
  let pilesMoved = 0;
  const guard = (): void => {
    if (w.tick - start > o.maxTicks) throw new Error(`harness.digPit: not finished within ${o.maxTicks} ticks (${strikes} strikes)`);
    if (o.maxStrikes !== undefined && strikes > o.maxStrikes) throw new Error(`harness.digPit: more than ${o.maxStrikes} strikes`);
  };
  const goTo = (q: XZ): void => {
    if (flat(p.pos, q) <= P.standTolM) return;
    // Up a wall over 45° (out of a layer onto a higher floor or the rim): a logged standAt, as §11.0 says; anywhere
    // else he walks, and a walk that fails anyway (WALK_STUCK_TICKS without progress) is a standAt counted apart.
    if (wallOnPath(t, p.pos, q)) {
      h.standAt(q);
      why.wall++;
    } else if (!h.walk(q, { tolM: P.standTolM, tryOnly: true })) {
      h.standAt(q);
      why.stuck++;
    }
  };
  const inPit = (): boolean => t.heightAt(p.pos.x, p.pos.z) < t.originalHeightAt(p.pos.x, p.pos.z) - P.stepM;

  /** Piles the player couldn't drag out (left where they lie, and never tried again). */
  const stuck = new Set<number>();
  /** Dirt piles on or near the footprint go pileOutM beyond one of its sides (the tool on the back meanwhile). */
  const clearPiles = (): void => {
    const piles = w.entities
      .all()
      .filter((e) => isDirtPile(e) && !stuck.has(e.id) && inside({ x: e.pose.p.x, z: e.pose.p.z }, -P.pileMarginM))
      .map((e) => e.id);
    if (piles.length === 0) return;
    h.must({ verb: 'stow', target: 0, slot: BACK_SLOT }, 'digPit: stow the digging tool');
    for (const id of piles) {
      const e = w.entities.get(id);
      if (!e) continue;
      const q = { x: e.pose.p.x, z: e.pose.p.z };
      const sides = o.pileSides ?? 'any';
      const out = [
        { side: 'x', d: q.x - x0, to: { x: x0 - P.pileOutM, z: q.z } },
        { side: 'x', d: x1 - q.x, to: { x: x1 + P.pileOutM, z: q.z } },
        { side: 'z', d: q.z - z0, to: { x: q.x, z: z0 - P.pileOutM } },
        { side: 'z', d: z1 - q.z, to: { x: q.x, z: z1 + P.pileOutM } },
      ]
        .filter((s) => sides === 'any' || s.side === sides)
        .sort((a, b) => a.d - b.d)[0].to;
      // Out of a pit deeper than a step, the player is put on the rim beside the pile's way out first.
      if (inPit()) {
        h.standAt({ x: out.x, z: out.z });
        why.piles++;
      }
      if (h.dragTo(id, out, { tolM: 0.6, tryOnly: true })) pilesMoved++;
      else stuck.add(id);
      guard();
    }
    h.must({ verb: 'draw', target: 0, slot: BACK_SLOT }, 'digPit: draw the digging tool');
    if (p.inventory?.hands?.entity !== toolId) throw new Error('harness.digPit: the digging tool is not back in the hands');
  };

  /** Where a strike at `c` is aimed: the centre, moved toward the footprint's middle after strikes there failed. */
  const aimOf = (c: Centre): XZ => {
    // The vertex that decides it (the kernel's criterion), or the centre.
    const v = c.verts.length === 1 ? { x: t.minX + c.verts[0][0] * t.spacing, z: t.minZ + c.verts[0][1] * t.spacing } : { x: c.x, z: c.z };
    // Within aimShiftEdgeM of the footprint's edge: the centre, moved toward the middle as strikes there fail.
    const edge = Math.min(c.x - x0, x1 - c.x, c.z - z0, z1 - c.z);
    if (edge > P.aimShiftEdgeM) return v;
    const m = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
    const d = flat(c, m);
    const k = d > 1e-9 ? Math.min(P.aimShiftMaxM, P.aimShiftM * c.misses, d) / d : 0;
    return { x: c.x + (m.x - c.x) * k, z: c.z + (m.z - c.z) * k };
  };

  /**
   * Where to stand to strike `c`: one of DIG_PLAN.reaches (a distance ahead and how far below the feet the head gets
   * there) from it, in one of DIG_PLAN.directions directions (none that failed this centre lately), on ground the head
   * reaches the centre's surface from (no higher than it + that depth − reachMarginM) and not much below it, inside the
   * footprint by standInsetM once the centre is deeper than a step. The swing's head comes down to the right of its aim,
   * and further, the deeper it has to go (measured, DIG_PLAN): a direction whose right-hand side (and the ground just
   * beyond the strike) rises more than clearM above the centre is penalised by how much, so a strike beside a wall is
   * made with the wall on the left. Least penalty first (each longer reach costs longReachCostM), then the spot nearest
   * the player. With no spot, the limits relax: the ground below the strike, then the inset.
   */
  const standSpot = (centre: Centre): { at: XZ; dir: number; pen: number } | null => {
    const c = { ...aimOf(centre), bad: centre.bad };
    const hc = t.heightAt(c.x, c.z);
    const deep = hc < t.originalHeightAt(c.x, c.z) - P.stepM;
    let best: { at: XZ; dir: number; pen: number } | null = null;
    let bestD = Infinity;
    for (let relax = 0; relax < 3 && !best; relax++) {
      for (let ri = 0; ri < P.reaches.length; ri++) {
        const [ahead, below] = P.reaches[ri];
        const need = hc + below - P.reachMarginM;
        for (let k = 0; k < P.directions; k++) {
          const key = ri * P.directions + k;
          if (c.bad.has(key)) continue;
          const a = (2 * Math.PI * k) / P.directions;
          const f = { x: Math.cos(a), z: Math.sin(a) };
          const s = { x: c.x - ahead * f.x, z: c.z - ahead * f.z };
          if (deep && relax < 2 && !inside(s, P.standInsetM)) continue;
          if (deep && !inside(s, 0)) continue;
          const hs = t.heightAt(s.x, s.z);
          // Not much above the strike (the head can't reach down), not much below it (the haft meets the ground
          // first: P23 measured strikes at ground 0.4 m above the feet clanging, every one).
          if (hs > need || (relax < 1 && hs < hc - P.belowStrikeMaxM)) continue;
          // Right of the facing f, in the fighter convention (f = (sin yaw, cos yaw)): (f.z, −f.x).
          const r = { x: f.z, z: -f.x };
          let pen = 0;
          for (const [fw, rt] of P.swingSamples) {
            const q = { x: s.x + f.x * fw * (ahead / P.reaches[0][0]) + r.x * rt, z: s.z + f.z * fw * (ahead / P.reaches[0][0]) + r.z * rt };
            pen = Math.max(pen, t.heightAt(q.x, q.z) - hc - P.clearM);
          }
          const d = flat(p.pos, s) + pen * P.penaltyPerM + ri * P.longReachCostM;
          if (d < bestD - 1e-9) {
            bestD = d;
            best = { at: s, dir: key, pen };
          }
        }
      }
    }
    return best;
  };

  /** The floor of the layer being dug (the seeds: the first layer's). */
  let floorNow = Math.min(o.depth, P.layerM);
  /** One strike at `c` from its best stand spot (piles cleared first); false when it has no stand spot. */
  const strike = (c: Centre): boolean => {
    const spot = standSpot(c);
    if (!spot) return false;
    guard();
    let t0 = w.tick;
    clearPiles();
    stats.piles += w.tick - t0;
    if (p.inventory?.hands?.entity !== toolId) {
      const te = w.entities.get(toolId);
      throw new Error(`harness.digPit: the digging tool left the hands (${te ? `entity ${te.state}` : 'gone'}; player ${p.state}) after ${strikes} strikes`);
    }
    t0 = w.tick;
    goTo(spot.at);
    stats.walk += w.tick - t0;
    t0 = w.tick;
    // DIGDBG=1 logs every strike that dug nothing or far from its aim (a debugging aid for the planner's habits).
    const dbg = process.env.DIGDBG ? { ce: h.history.combat.length, p0: { x: p.pos.x, y: p.pos.y, z: p.pos.z }, hc: t.heightAt(c.x, c.z) } : null;
    const aim = aimOf(c);
    const before = excessOf(c, floorNow);
    const r = h.verb({ verb: 'dig', target: 0, at: toCm({ x: aim.x, y: t.heightAt(aim.x, aim.z), z: aim.z }), charge: 1 });
    strikes++;
    if (excessOf(c, floorNow) < before - 1e-6) {
      c.misses = Math.max(0, c.misses - 1);
      c.fails = 0;
    } else {
      c.misses++;
      // An edge centre (a corner, mostly: walls on two sides) that no stand spot reaches any more is given up.
      if (++c.fails >= P.giveUpFails && isEdge(c)) c.abandoned = true;
    }
    stats.swing += w.tick - t0;
    const dug = r.events.find((e): e is Extract<WorldEvent, { type: 'dig' }> => e.type === 'dig');
    const miss = dug ? Math.hypot(aim.x - dug.point.x, aim.z - dug.point.z) : -1;
    if (dug) {
      digs++;
      stats.miss[Math.min(stats.miss.length - 1, Math.floor(miss / 0.1))]++;
    }
    if (!dug || miss > P.aimTolM) c.bad.add(spot.dir);
    if (dbg && (!dug || miss > P.aimTolM)) {
      const ce = h.history.combat.slice(dbg.ce).map((e) => e.type).join(',');
      console.info(
        `DBG s${strikes} c(${c.x.toFixed(2)},${c.z.toFixed(2)}) hc ${dbg.hc.toFixed(2)} p0 (${dbg.p0.x.toFixed(2)},${dbg.p0.y.toFixed(2)},${dbg.p0.z.toFixed(2)}) pen ${spot.pen.toFixed(2)} ${dug ? `dig (${dug.point.x.toFixed(2)},${dug.point.y.toFixed(2)},${dug.point.z.toFixed(2)})` : `none [${r.reason}] ${ce}`}`,
      );
    }
    return true;
  };

  // Seeds first: one strike on a sparse lattice (seedM apart) over the footprint. Spoil goes to the nearest point no
  // dug vertex is within spoilSetbackM of (§4.13), so until every part of the footprint is that near something dug,
  // dirt is heaped up inside the pit-to-be and has to be dug twice (P23 measured: berm 0.4-0.7 m high inside a 5 × 4 m
  // footprint). The seeds make the whole footprint "near dug" within a few strikes.
  const nx = Math.max(1, Math.ceil((x1 - x0 - 2 * P.insetM) / P.seedM) + 1);
  const nz = Math.max(1, Math.ceil((z1 - z0 - 2 * P.insetM) / P.seedM) + 1);
  const seeds: Centre[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const q = { x: nx === 1 ? (x0 + x1) / 2 : x0 + P.insetM + ((x1 - x0 - 2 * P.insetM) * i) / (nx - 1), z: nz === 1 ? (z0 + z1) / 2 : z0 + P.insetM + ((z1 - z0 - 2 * P.insetM) * j) / (nz - 1) };
      let best = centres[0];
      for (const c of centres) if (flat(c, q) < flat(best, q) - 1e-9) best = c;
      if (!seeds.includes(best)) seeds.push(best);
    }
  }
  for (const c of serpentine(seeds, false)) {
    strike(c);
    yield;
  }
  stats.layers.push(strikes);

  // Then layers of layerM, each dug in passes as the RT lab's kernel strikes: every centre still above the layer's
  // floor is struck once per pass, in a serpentine order (alternate columns reversed, alternate passes reversed), so the
  // pit goes down evenly and the player stands about level with what he strikes.
  const layers = Math.ceil(o.depth / P.layerM - 1e-9);
  for (let k = 0; k < layers; k++) {
    const floor = Math.min(o.depth, P.layerM * (k + 1));
    floorNow = floor;
    for (const c of centres) c.fails = 0;
    let idle = 0;
    let lastStruck = 1;
    for (let pass = 0; ; pass++) {
      guard();
      // Failed directions are kept while the pass makes no progress (so each retry tries another), and forgotten
      // every forgetPasses passes that did, or once every direction has failed (nothing struck: the ground has moved).
      if ((idle === 0 && pass % P.forgetPasses === 0) || lastStruck === 0) for (const c of centres) c.bad.clear();
      const before = totalExcess(floor);
      if (before <= 0) break;
      let struck = 0;
      for (const c of serpentine(centres, (k + pass) % 2 === 1)) {
        if (excessOf(c, floor) <= tolOf(c)) continue;
        if (strike(c)) struck++;
        yield;
      }
      stats.layers.push(strikes);
      lastStruck = struck;
      const after = totalExcess(floor);
      if (after <= 0) break;
      if (struck > 0 && after < before - 1e-9) idle = 0;
      else if (++idle >= P.maxIdlePasses) {
        const left = centres.filter((c) => excessOf(c, floor) > tolOf(c));
        throw new Error(
          `harness.digPit: stuck after ${strikes} strikes (${P.maxIdlePasses} passes without progress, floor ${floor} m): ${left.length} centres above it (${left
            .slice(0, 4)
            .map((c) => `(${c.x.toFixed(2)}, ${c.z.toFixed(2)}) ${excessOf(c, floor).toFixed(3)} m high${standSpot(c) ? '' : ', no stand spot'}`)
            .join('; ')})`,
        );
      }
    }
  }
  // Out of the finished pit onto its rim (a logged standAt: the walls are steeper than the controller climbs).
  if (inPit()) {
    h.standAt({ x: x0 - 1.0, z: o.centre.z });
    why.exit++;
  }
  h.ticks(2);
  return { strikes, ticks: w.tick - start, digs, standAts: why.wall + why.stuck + why.piles + why.exit, standAtWhy: why, pilesMoved, abandoned: centres.filter((c) => c.abandoned).map((c) => ({ x: c.x, z: c.z })), misses: stats.miss, layerStrikes: stats.layers, tickSplit: { walk: stats.walk, swing: stats.swing, piles: stats.piles } };
}

/** The centres column by column along x, each column along z, alternate columns reversed (and the whole reversed). */
function serpentine(cs: readonly Centre[], reverse: boolean): Centre[] {
  const cols = new Map<number, Centre[]>();
  for (const c of cs) {
    const k = Math.round(c.x * 1000);
    const col = cols.get(k);
    if (col) col.push(c);
    else cols.set(k, [c]);
  }
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const out: Centre[] = [];
  keys.forEach((k, i) => {
    const col = cols.get(k)!.slice().sort((a, b) => a.z - b.z);
    out.push(...(i % 2 === 0 ? col : col.reverse()));
  });
  return reverse ? out.reverse() : out;
}
