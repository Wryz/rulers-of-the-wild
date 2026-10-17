// The loader and the migration ladder (docs/M1-DESIGN.md §1.5.11, §8.3).
//
// readSave: bytes → UTF-8 text → canonical JSON (save/canonical.ts decodes '$inf', '$-inf', '$nan' and '$$' strings)
// → migrate, which climbs the version ladder (v1 is the identity) and checks every field of the record: a broken or
// hand-edited save fails with a `save record:` error naming the field before any world is built. The records owned by
// other systems are checked here for their kinds and shapes, and again by their owners' readers where those check
// (P04's fighter, brain and animation readers, P02-fix's CombatSim reader); weapons stored by value (a tool the world
// made) are checked here, as P04 and P02-fix leave to the save (§8.3).
//
// loadWorld rebuilds the world (M1 scope, §8.3) in this order:
// 1. tuning: with `applyTuning`, the sim tables are reset to their defaults and the save's overrides set on top, first
//    (they shape generation); without it the registry is left alone (RR-17). The client's tables are never touched. All
//    or nothing: a failure anywhere puts the registry back;
// 2. a World built from the save's seed and options: generation regenerates every untouched generated entity and joint;
//    the fighters construction made (the player, the spawner's creatures) and any non-generated entity are removed
//    again, since the save replaces them;
// 3. terrain edits and the dug mask, then cover edits, over the generated ground;
// 4. entities (EntityStore.restoreRecord: `removed` generated ids dropped, saved records rebuilt in id order), then
//    joints (JointStore.restoreRecord). The joint rule (a joint has no generated/touched flag): the save holds every
//    joint of the store, and restoreRecord REPLACES the store with them — the joints generation just made are dropped
//    (without releasing anything: no entity is removed, no event pushed) and every saved joint is rebuilt with its id,
//    in id order. So a generated vine that still hangs comes back once, from its record, and a cut one stays gone;
// 5. fighters, in the saved step order, each made by the factory that made it (the player by createPlayer, a creature
//    by createCreature) with its saved id, and added to the world (which makes its bodies); then CombatSim's own state
//    (P02-fix: tick, its Rng, serials, drops, projectiles, swept blades, pending commands), every fighter's record
//    (P04's Fighter.restoreRecord: rig rebuilt by forward kinematics), the director, the fighters' Rng states, the
//    rulers' RulerState, the minds and their Rng states, the verb state, the spawner (MAP gap-7 §3.6-3.7: construct,
//    add, then restore, so construction's draws and add()'s updatePose are overwritten);
//    TODO(P13, M3, SPEC:917): in world mode phases 13a/13b move f.pos after updatePose, so a downed fighter's tick-end
//    rig is not the forward kinematics of its saved pose and pos; an exact restore of a downed fighter's rig saves the
//    rig or rebuilds it at the pre-13a position (P04's note on Fighter.restoreRecord);
// 6. bodies: controllers, slabs and ruler bodies from their records; the standing zones' pose history is reset (the
//    physics world's pre-step store is not restorable: every owner's next store reads carryV 0, as after a teleport);
//    contacts (ContactSystem.restoreRecord replaces its runtime maps, graces included) and the saved graces re-opened;
//    felling, deaths and corpses; the queued impulses;
// 7. the world RNG streams and the id counters; the navmesh rebuilt over the loaded ground and its dirty queue
//    restored;
// 8. every collider the load made put into the scene queries by a zero-length Rapier step that moves nothing (so the
//    first tick's queries before its phase-7 step see the world the save saw: refreshQueries), its starts handed to the
//    contact pipeline so the restored episodes keep their counts; the events construction pushed cleared.
// Rapier's body order after a load differs from the saving world's (restored bodies are made after the generated ones
// kept), so a loaded world matches the saved one within SPEC:730's 1 cm and 1° at rest, not bit for bit; two loads of
// one save are bit-identical to each other.
import type RAPIER from '@dimforge/rapier3d-compat';
import { BONES, type BoneName } from '../body/skeleton';
import type { ButtonCommand, Command, CommandButton, DevOp, MetaCommand, MoveCommand, TuningEdit, VerbCommand, VerbId } from '../sim/commands';
import { type Fighter, IdCounter } from '../sim/fighter';
import { createPlayer } from '../sim/roster';
import type { WeaponDef } from '../sim/weapons';
import { WEAPONS } from '../sim/weapons';
import { resetTuning, restoreTuning, setTuningValue, TUNING, tuningSnapshot } from '../tuning/registry';
import { MATERIALS } from '../world/materials';
import { physicsReady } from '../world/physics';
import { MIND_STATE_DOMAIN, type MindScript } from '../world/creatures/mind';
import type { VerbStateRecord } from '../world/verbs/index';
import type {
  CauseFeature,
  CauseKind,
  EntityState,
  ImpactCause,
  JointKind,
  Owner,
  PlantState,
  Pose3,
  PostureId,
  Quat,
  RulerState,
  RulerZoneId,
  SevereEffect,
  Shape,
  TripWhy,
  V3,
  WoundRecord,
} from '../world/types';
import { World } from '../world/world';
import { parseCanonicalJson } from './canonical';
import {
  type BodiesRecV1,
  type EntityRecV1,
  type JointRecV1,
  type KccRecV1,
  type MindRecV1,
  type RulerBodyRecV1,
  SAVE_FORMAT,
  SAVE_FORMAT_VERSION,
  SAVE_V1_KEYS,
  type SaveV1,
  type SlabRecV1,
  type TuningOverrideV1,
} from './schema';
import {
  BUTTON_KEYS,
  BUTTON_REQUIRED,
  DEV_KEYS,
  DEV_REQUIRED,
  isClientTuning,
  META_KEYS,
  META_REQUIRED,
  MOVE_KEYS,
  MOVE_REQUIRED,
  TUNING_EDIT_KEYS,
  VERB_KEYS,
  VERB_REQUIRED,
} from './serialize';

export interface LoadOptions {
  /** 'off' builds no navmesh (physics-only tests). Default 'full'. */
  nav?: 'full' | 'off';
  /**
   * Default false: restore the save's tuningOverrides into the process-wide registry (RR-17): every sim table is reset
   * to its defaults and the save's overrides are set on top, so the sim runs with the saving world's tuning (a live
   * dev-panel tweak to a sim table is dropped; the client's own tables are left alone). The registry is per process and
   * the client holds one live world; tests that load with applyTuning restore a snapshot afterwards.
   */
  applyTuning?: boolean;
}

/**
 * Builds the world a save describes (see the top of this file). applyTuning (default false): restore the save's
 * tuning into the process-wide registry (RR-17, LoadOptions). The loaded world's scene queries see every body it was
 * saved with from its first tick (step 8).
 */
export async function loadWorld(bytes: Uint8Array, opts?: LoadOptions): Promise<World> {
  const save = readSave(bytes);
  await physicsReady();
  // (Synchronous from here: no other code runs between the tuning edits and the build.)
  const before = opts?.applyTuning ? tuningSnapshot() : null;
  let w: World | null = null;
  try {
    if (opts?.applyTuning) applyTuningOverrides(save.tuningOverrides);
    const o = save.options;
    w = new World({ seed: save.seed, scene: o.scene, terrain: o.terrain, size: o.size, nav: opts?.nav ?? 'full', player: o.player, sparringApe: o.sparringApe });
    restoreWorld(w, save);
    return w;
  } catch (e) {
    w?.dispose();
    if (before !== null) restoreTuning(before);
    throw e;
  }
}

/** A save's bytes as a checked SaveV1 (UTF-8, canonical JSON, migrated to the current version). Builds nothing. */
export function readSave(bytes: Uint8Array): SaveV1 {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('loadWorld: the save is not UTF-8 text');
  }
  let data: unknown;
  try {
    data = parseCanonicalJson(text);
  } catch (e) {
    throw new Error(`loadWorld: the save is not canonical JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return migrate(data);
}

/**
 * The version ladder (each step takes a record of version n to n + 1; v1 is the identity, the first rung), then the
 * current version's check. Takes decoded data (parseCanonicalJson's, so non-finite numbers are numbers) and returns a
 * fresh, checked SaveV1; throws `save record:` errors naming the field.
 */
export function migrate(rec: unknown): SaveV1 {
  const o = obj(rec, 'save');
  if (o.format !== SAVE_FORMAT) throw new Error(`save record: format is ${short(o.format)}, not '${SAVE_FORMAT}' (not a world save)`);
  const first = o.formatVersion;
  if (typeof first !== 'number' || !Number.isInteger(first) || first < 1) throw new Error(`save record: formatVersion is ${short(first)}, not a save version`);
  if (first > SAVE_FORMAT_VERSION) throw new Error(`save record: formatVersion ${first} is newer than this build reads (${SAVE_FORMAT_VERSION})`);
  let r: Obj = o;
  for (let v = first; v < SAVE_FORMAT_VERSION; v++) {
    const step = LADDER[v];
    if (!step) throw new Error(`loadWorld: no migration from save version ${v}`);
    r = step(r);
    if (r.formatVersion !== v + 1) throw new Error(`loadWorld: the migration from save version ${v} gave version ${short(r.formatVersion)}`);
  }
  return checkSaveV1(r);
}

/** LADDER[n] takes a version-n record to version n + 1 (none yet: v1 is the only version). */
const LADDER: Readonly<Partial<Record<number, (r: Obj) => Obj>>> = {};

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * The saving world's sim tuning, exactly: every sim table back to its registered defaults (a live dev-panel tweak this
 * process holds is not the save's), then the save's overrides (its differences from those defaults) on top. The client's
 * tables are left as they are: they are the game loop's and the presentation's, never saved (rules 6 and 8). A client
 * table, or a table this process doesn't register (a client table in a sim-only process: saves hold none, but the
 * client's own tables are not the save's to set), is skipped; an unknown key or a value of the wrong kind in a sim table
 * throws, and loadWorld puts the whole registry back as it was.
 */
function applyTuningOverrides(list: readonly TuningOverrideV1[]): void {
  for (const e of TUNING) if (!isClientTuning(e)) resetTuning(e.name);
  for (const t of list) {
    const e = TUNING.find((x) => x.name === t.table);
    if (!e || isClientTuning(e)) continue;
    setTuningValue(t.table, t.key, t.value);
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function restoreWorld(w: World, s: SaveV1): void {
  // 2. What construction made that the save replaces.
  for (const f of [...w.combat.fighters].sort(byId)) w.removeFighter(f);
  for (const e of w.entities.all()) if (!e.generated) w.removeEntity(e.id);

  // 3. The ground.
  checkTerrainEdits(w, s);
  w.terrain.applyEdits(s.terrain, s.dug);
  w.cover.applyEdits(s.cover);

  // 4. Entities and joints.
  w.entities.restoreRecord(s.entities, s.removed);
  w.joints.restoreRecord(s.joints);

  // 5. Fighters and what drives them.
  const made = s.fighters.map((r) => makeFighter(w, r));
  w.combat.restoreRecord({
    frame: s.tick,
    rng: s.rng.combat,
    dropSerial: s.counters.dropSerial,
    projSerial: s.counters.projSerial,
    drops: s.drops,
    projectiles: s.projectiles,
    prevBlade: s.prevBlade,
    pending: s.pending,
  });
  const ctx = { fighters: w.combat.fighters, drops: w.combat.drops };
  s.fighters.forEach((r, i) => made[i].restoreRecord(r, ctx));
  w.combat.director.restoreRecord(s.director);
  for (const [id, st] of s.rng.fighters) fighterById(w, id, 'rng.fighters').rngState = st;
  for (const f of w.combat.fighters) f.ruler = null;
  for (const [id, r] of s.rulers) fighterById(w, id, 'rulers').ruler = r;
  restoreMinds(w, s.minds);
  for (const [id, st] of s.rng.minds) w.rngs.mind(id).state = st;
  w.verbs.restoreRecord(s.verbs);
  w.spawner.restoreRecord(s.spawner);

  // 6. Bodies, contacts, felling, deaths, impulses.
  const kcc: { fighter: number; kcc: KccRecV1 }[] = [];
  const slabs: { fighter: number; slab: SlabRecV1 }[] = [];
  const rulers: { fighter: number; ruler: NonNullable<BodiesRecV1['ruler']> }[] = [];
  for (const b of s.bodies) {
    fighterById(w, b.fighter, 'bodies');
    if (b.kcc) kcc.push({ fighter: b.fighter, kcc: b.kcc });
    if (b.slab) slabs.push({ fighter: b.fighter, slab: b.slab });
    if (b.ruler) rulers.push({ fighter: b.fighter, ruler: b.ruler });
  }
  w.kcc.restoreRecord(kcc);
  w.downed.restoreRecord(slabs);
  w.rulers.restoreRecord(rulers);
  // The standing zones have no record of their own: they are off exactly while the slab is active, and until the
  // phase 4a after the slab was handed back (world/downed.ts), so that is where a load leaves them.
  // TODO(P08-fix): ZoneBodies could save its `enabled` itself (or DownedBodies.restoreRecord set it).
  for (const { fighter, slab } of slabs) if (slab.enabled || slab.handedBack) w.zones.setEnabled(fighterById(w, fighter, 'bodies'), false);
  for (const f of [...w.combat.fighters].sort(byId)) if (!f.ruler) w.zones.resetHistory(f);
  w.contacts.restoreRecord(s.contacts);
  for (const [id, until] of s.contactGrace) w.contacts.grace(id, until);
  w.felling.restoreRecord(s.felling);
  w.deaths.restoreRecord(s.deaths, s.corpses);
  s.impulses.forEach((q, i) => {
    if (!w.entities.get(q.entity)) throw new Error(`save record: impulses[${i}] names entity ${q.entity}, which isn't in the loaded world`);
    w.entities.queueImpulse(q.entity, q.j, q.at);
  });

  // 7. Streams, counters, the navmesh; 8. the scene queries, events.
  w.rngs.restoreRecord({ combat: s.rng.combat, world: s.rng.world });
  w.ids.fighter.next = s.counters.fighter;
  w.ids.entity.next = s.counters.entity;
  w.ids.joint.next = s.counters.joint;
  w.ids.wound.next = s.counters.wound;
  if (w.nav) {
    w.nav.build(w);
    w.nav.restoreDirty(s.navDirty);
  }
  refreshQueries(w);
  w.events.length = 0;
}

/** A Rapier body's pose and velocities, and whether it sleeps (what refreshQueries must leave as it was). */
function bodyState(b: RAPIER.RigidBody): number[] {
  const t = b.translation();
  const q = b.rotation();
  const v = b.linvel();
  const a = b.angvel();
  return [t.x, t.y, t.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, a.x, a.y, a.z, b.isSleeping() ? 1 : 0];
}

/**
 * 8. Every collider the load made (restored entities, fighters' bodies, regenerated ones) into the scene queries,
 * without moving anything. A new collider is invisible to queries until a Rapier step (MAP rapier finding 7; World's
 * constructor primes the terrain the same way), and the first tick after a load queries before its phase-7 step: dev
 * ops and teleports (phase 1c), minds' perception rays (2), the movers' supportAt (3). The saved world had every one of
 * these colliders in its broad phase, so without this a load would change those outcomes (a giant standing on a
 * restored pit cover would read the pit floor). So: one Rapier step of zero length. Its events never reach phase 9 as
 * new contacts (pairs already touching at the save start no new contact on the first tick, as in the saved world): its
 * starts go to ContactSystem.restoredStarts, which counts them toward the restored episodes only, so the counts the save
 * holds carry on (the first step raises them no more). A zero-length step moves no body and changes no velocity
 * (measured: bit for bit, with resting stacks, sliding bodies, kinematic capsules and motorised, rope, spring and fixed
 * joints); that is checked here, so a Rapier that did otherwise fails the load loudly instead of changing the world
 * quietly.
 * TODO(P05-fix): PhysicsWorld.refreshQueries(), primeQueries' general form, so physics.ts owns the Rapier step; the
 * loader then calls it.
 */
function refreshQueries(w: World): void {
  const rapier = w.physics.rapier;
  const before = new Map<number, number[]>();
  rapier.bodies.forEach((b) => {
    before.set(b.handle, bodyState(b));
  });
  const dt = rapier.timestep;
  rapier.timestep = 0;
  try {
    rapier.step(w.physics.events);
  } finally {
    rapier.timestep = dt;
  }
  const pairs = w.physics.drain();
  rapier.bodies.forEach((b) => {
    const was = before.get(b.handle);
    const now = bodyState(b);
    if (!was || !was.every((x, i) => Object.is(x, now[i]))) {
      throw new Error(`loadWorld: the zero-length step that refreshes the scene queries changed Rapier body ${b.handle}`);
    }
  });
  // Its starts are the rebuilt narrow phase re-raising every pair that still overlaps: the contact pipeline rebuilds
  // the restored episodes' counts from them in the first phase 9 (the first step raises them no more).
  w.contacts.restoredStarts(pairs);
}

/**
 * Makes a saved fighter with its saved id the way the world made it, and adds it to the world (bodies included): a
 * player (playerId 'p<n>') by createPlayer, a creature by createCreature. A world makes no other fighter.
 */
function makeFighter(w: World, r: SaveV1['fighters'][number]): Fighter {
  if (r.playerId !== null) {
    const n = playerNumberOf(r.playerId, r.id);
    if (w.players.has(n)) throw new Error(`save record: fighters: two fighters are player ${r.playerId}`);
    const f = createPlayer({ ids: new IdCounter(r.id), rngSeed: w.rngs.fighterSeed(r.id) });
    f.playerId = r.playerId;
    f.species = r.species;
    // (Where and how big its bodies are made; the record puts back the rest.)
    f.scale = r.scale;
    f.pos.set(r.pos.x, r.pos.y, r.pos.z);
    f.yaw = r.yaw;
    w.players.set(n, f);
    if (n === 1) w.player = f;
    w.addFighter(f, null);
    return f;
  }
  if (r.species === 'ape' || r.species === 'giantApe') {
    const ids = w.ids.fighter;
    ids.next = r.id;
    const f = w.spawnCreature(r.species, { x: r.pos.x, z: r.pos.z }, r.yaw);
    if (f.id !== r.id) throw new Error(`loadWorld: creature ${r.id} was made with id ${f.id}`);
    return f;
  }
  throw new Error(`save record: fighters: fighter ${r.id} is neither a player nor a creature (species ${short(r.species)}); a world makes no other fighter`);
}

/** 'p<n>' → n (playerIdOf's inverse). */
function playerNumberOf(playerId: string, fighter: number): number {
  const m = /^p([1-9][0-9]*)$/.exec(playerId);
  if (!m) throw new Error(`save record: fighter ${fighter}'s playerId is ${short(playerId)}, not 'p<number>'`);
  return Number(m[1]);
}

function fighterById(w: World, id: number, field: string): Fighter {
  const f = w.combat.fighters.find((x) => x.id === id);
  if (!f) throw new Error(`save record: ${field} names fighter ${id}, who isn't among the fighters`);
  return f;
}

/**
 * The minds' records: MindRegistry.restoreRecord puts each onto the mind of the fighter it names (its state, script,
 * awareness, memory, path and inner BrawlerAI), after a check that every one names a fighter of this world.
 */
function restoreMinds(w: World, minds: readonly MindRecV1[]): void {
  for (const m of minds) fighterById(w, m.fighter, 'minds');
  w.minds.restoreRecord(minds);
}

function checkTerrainEdits(w: World, s: SaveV1): void {
  const t = w.terrain;
  const n = (t.cells + 1) * (t.cells + 1);
  const at = (tile: number, vertex: number, field: string) => {
    if (tile >= t.tileCount) throw new Error(`save record: ${field}: tile ${tile} is not a tile of this world (${t.tileCount} tiles)`);
    if (vertex >= n) throw new Error(`save record: ${field}: vertex ${vertex} is not a vertex of a tile (${n} a tile)`);
  };
  s.terrain.forEach((e, i) => at(e.tile, e.vertex, `terrain[${i}]`));
  s.dug.forEach(([tile, vertex], i) => at(tile, vertex, `dug[${i}]`));
}

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

// ---------------------------------------------------------------------------
// The check of a v1 record (every field; a fresh SaveV1 in SAVE_V1_KEYS order)
// ---------------------------------------------------------------------------

type Obj = Readonly<Record<string, unknown>>;

function checkSaveV1(o: Obj): SaveV1 {
  exactKeys(o, SAVE_V1_KEYS, 'save');
  const s: SaveV1 = {
    format: SAVE_FORMAT,
    formatVersion: 1,
    seed: u32(o.seed, 'seed'),
    options: options(o.options, 'options'),
    tick: nat(o.tick, 'tick'),
    tuningOverrides: arr(o.tuningOverrides, 'tuningOverrides').map((x, i) => tuningOverride(x, `tuningOverrides[${i}]`)),
    counters: counters(o.counters, 'counters'),
    rng: rngs(o.rng, 'rng'),
    director: director(o.director, 'director'),
    pending: arr(o.pending, 'pending').map((x, i) => command(x, `pending[${i}]`)),
    terrain: arr(o.terrain, 'terrain').map((x, i) => terrainEdit(x, `terrain[${i}]`)),
    dug: arr(o.dug, 'dug').map((x, i) => pair(x, `dug[${i}]`, nat, nat)),
    cover: arr(o.cover, 'cover').map((x, i) => pair(x, `cover[${i}]`, nat, fin)),
    entities: arr(o.entities, 'entities').map((x, i) => entity(x, `entities[${i}]`)),
    removed: arr(o.removed, 'removed').map((x, i) => nat(x, `removed[${i}]`)),
    impulses: arr(o.impulses, 'impulses').map((x, i) => impulse(x, `impulses[${i}]`)),
    joints: arr(o.joints, 'joints').map((x, i) => joint(x, `joints[${i}]`)),
    fighters: arr(o.fighters, 'fighters').map((x, i) => fighter(x, `fighters[${i}]`)),
    minds: arr(o.minds, 'minds').map((x, i) => mind(x, `minds[${i}]`)),
    verbs: arr(o.verbs, 'verbs').map((x, i) => verbState(x, `verbs[${i}]`)),
    spawner: spawner(o.spawner, 'spawner'),
    drops: arr(o.drops, 'drops').map((x, i) => drop(x, `drops[${i}]`)),
    projectiles: arr(o.projectiles, 'projectiles').map((x, i) => projectile(x, `projectiles[${i}]`)),
    prevBlade: arr(o.prevBlade, 'prevBlade').map((x, i) => pair(x, `prevBlade[${i}]`, nat, (v, p) => arr(v, p).map((q, j) => v3(q, `${p}[${j}]`)))),
    bodies: arr(o.bodies, 'bodies').map((x, i) => bodies(x, `bodies[${i}]`)),
    rulers: arr(o.rulers, 'rulers').map((x, i) => pair(x, `rulers[${i}]`, nat, rulerState)),
    contacts: arr(o.contacts, 'contacts').map((x, i) => contact(x, `contacts[${i}]`)),
    contactGrace: arr(o.contactGrace, 'contactGrace').map((x, i) => pair(x, `contactGrace[${i}]`, nat, int)),
    felling: arr(o.felling, 'felling').map((x, i) => felling(x, `felling[${i}]`)),
    deaths: arr(o.deaths, 'deaths').map((x, i) => {
      const r = exactKeys(obj(x, `deaths[${i}]`), ['fighter', 'respawnTick'], `deaths[${i}]`);
      return { fighter: nat(r.fighter, `deaths[${i}].fighter`), respawnTick: int(r.respawnTick, `deaths[${i}].respawnTick`) };
    }),
    corpses: arr(o.corpses, 'corpses').map((x, i) => {
      const r = exactKeys(obj(x, `corpses[${i}]`), ['fighter', 'removeTick'], `corpses[${i}]`);
      return { fighter: nat(r.fighter, `corpses[${i}].fighter`), removeTick: int(r.removeTick, `corpses[${i}].removeTick`) };
    }),
    navDirty: arr(o.navDirty, 'navDirty').map((x, i) => {
      const t = arr(x, `navDirty[${i}]`);
      if (t.length !== 3) fail(`navDirty[${i}]`, x, '[layer, ty, tx]');
      return [oneOfNum(t[0], [0, 1], `navDirty[${i}][0]`), nat(t[1], `navDirty[${i}][1]`), nat(t[2], `navDirty[${i}][2]`)] as [number, number, number];
    }),
  };
  crossCheck(s);
  return s;
}

/** Ids against counters, and the per-fighter lists against the fighters. */
function crossCheck(s: SaveV1): void {
  const ids = new Set<number>();
  for (const f of s.fighters) {
    if (ids.has(f.id)) throw new Error(`save record: fighters: fighter ${f.id} is listed twice`);
    ids.add(f.id);
    if (f.id >= s.counters.fighter) throw new Error(`save record: fighter ${f.id} is not below counters.fighter (${s.counters.fighter})`);
  }
  const known = (id: number, field: string) => {
    if (!ids.has(id)) throw new Error(`save record: ${field} names fighter ${id}, who isn't among the fighters`);
  };
  s.rng.fighters.forEach(([id], i) => known(id, `rng.fighters[${i}]`));
  s.rng.minds.forEach(([id], i) => known(id, `rng.minds[${i}]`));
  s.bodies.forEach((b, i) => known(b.fighter, `bodies[${i}]`));
  s.rulers.forEach(([id], i) => known(id, `rulers[${i}]`));
  s.minds.forEach((m, i) => known(m.fighter, `minds[${i}]`));
  // The verb state (verbState()): one record per fighter in the save, by id; the entities it names below the counter
  // (a focus or tug may outlive its entity until the next phase 1b, so it needn't be in the save, but an id the world
  // hasn't given yet would latch onto the next entity made).
  (s.verbs as VerbStateRecord[]).forEach((r, i) => {
    known(r.fighter, `verbs[${i}]`);
    if (i > 0 && !(r.fighter > s.verbs[i - 1].fighter)) throw new Error(`save record: verbs are not in increasing fighter order at verbs[${i}]`);
    for (const [id, field] of [
      [r.focus?.target ?? 0, 'focus.target'],
      [r.tug?.entity ?? 0, 'tug.entity'],
    ] as const) {
      if (id >= s.counters.entity) throw new Error(`save record: verbs[${i}].${field} names entity ${id}, which is not below counters.entity (${s.counters.entity})`);
    }
  });
  for (const e of s.entities) if (e.id >= s.counters.entity) throw new Error(`save record: entity ${e.id} is not below counters.entity (${s.counters.entity})`);
  for (const id of s.removed) if (id >= s.counters.entity) throw new Error(`save record: removed entity ${id} is not below counters.entity (${s.counters.entity})`);
  for (const j of s.joints) if (j.id >= s.counters.joint) throw new Error(`save record: joint ${j.id} is not below counters.joint (${s.counters.joint})`);
  // An impulse names an entity the load will have: a saved record, or a generated one the seed regenerates (not
  // removed). Whether a regenerated id exists is known only once generation has run (restoreWorld checks it there).
  const removed = new Set(s.removed);
  s.impulses.forEach((q, i) => {
    if (q.entity >= s.counters.entity) throw new Error(`save record: impulses[${i}] names entity ${q.entity}, which is not below counters.entity (${s.counters.entity})`);
    if (removed.has(q.entity)) throw new Error(`save record: impulses[${i}] names entity ${q.entity}, which the save lists as removed`);
  });
  for (let i = 1; i < s.entities.length; i++) {
    if (!(s.entities[i].id > s.entities[i - 1].id)) throw new Error(`save record: entities are not in increasing id order at entities[${i}]`);
  }
  for (let i = 1; i < s.joints.length; i++) {
    if (!(s.joints[i].id > s.joints[i - 1].id)) throw new Error(`save record: joints are not in increasing id order at joints[${i}]`);
  }
  // Contacts (contact()): each id below its counter (a group outlives its fighter or entity until its cooldown ends, and
  // a grace its fighter until it runs out, so neither has to be in the save), one record per group in ContactSystem's
  // form (a fighter is the subject whenever the group has one, the lower of two fighters or two entities), sorted.
  const counted = (kind: 'fighter' | 'entity' | 'joint', id: number, field: string) => {
    const counter = s.counters[kind];
    if (!Number.isSafeInteger(id) || id >= counter) throw new Error(`save record: ${field} names ${kind} ${id}, which is not below counters.${kind} (${counter})`);
  };
  s.contacts.forEach((c, i) => {
    const p = `contacts[${i}]`;
    const subject = c.creature > 0 ? 'fighter' : 'entity';
    const id = Math.abs(c.creature);
    counted(subject, id, `${p}.creature`);
    const m = CONTACT_OWNER.exec(c.owner);
    if (m?.[1]) {
      const other = Number(m[2]);
      counted(m[1] === 'rope' ? 'joint' : (m[1] as 'fighter' | 'entity'), other, `${p}.owner`);
      if (m[1] === subject ? other <= id : m[1] === 'fighter') {
        throw new Error(`save record: ${p} is ${subject} ${id} against ${c.owner}, not ContactSystem's form (the fighter, or the lower id, is the subject)`);
      }
    }
    const q = s.contacts[i - 1];
    if (q && !(q.creature < c.creature || (q.creature === c.creature && q.owner < c.owner))) {
      throw new Error(`save record: contacts are not sorted by (creature, owner) without repeats at ${p}`);
    }
  });
  // A ruler body's mover memory (rulerBody()): the entities it names below the counter (a support or a deflecting
  // obstacle outlives its entity, a vanished cover is the point, but an id the world hasn't given yet would latch onto the
  // next entity made).
  s.bodies.forEach((b, i) => {
    const r = b.ruler;
    if (!r) return;
    const p = `bodies[${i}].ruler`;
    if (r.deflect) counted('entity', r.deflect.entity, `${p}.deflect.entity`);
    r.supports.forEach((x, k) => counted('entity', x.entity, `${p}.supports[${k}].entity`));
    if (r.coverBreak?.cause.entityId != null) counted('entity', r.coverBreak.cause.entityId, `${p}.coverBreak.cause.entityId`);
  });
  s.contactGrace.forEach(([id], i) => {
    counted('fighter', id, `contactGrace[${i}]`);
    if (i > 0 && !(id > s.contactGrace[i - 1][0])) throw new Error(`save record: contactGrace is not in increasing fighter order at contactGrace[${i}]`);
  });
}

function options(v: unknown, p: string): SaveV1['options'] {
  const o = exactKeys(obj(v, p), ['scene', 'terrain', 'size', 'player', 'sparringApe'], p);
  const size = fin(o.size, `${p}.size`);
  if (!(size > 0)) fail(`${p}.size`, o.size, 'a positive size');
  return {
    scene: oneOf(o.scene, { clearing: true, empty: true }, `${p}.scene`),
    terrain: oneOf(o.terrain, { generated: true, flat: true }, `${p}.terrain`),
    size,
    player: bool(o.player, `${p}.player`),
    sparringApe: bool(o.sparringApe, `${p}.sparringApe`),
  };
}

function tuningOverride(v: unknown, p: string): TuningOverrideV1 {
  const o = exactKeys(obj(v, p), ['table', 'key', 'value'], p);
  return { table: str(o.table, `${p}.table`), key: str(o.key, `${p}.key`), value: tuningValue(o.value, `${p}.value`) };
}

/** A tuning value: a number (Infinity allowed: a reach can be unlimited), a boolean or a string. */
function tuningValue(v: unknown, p: string): number | boolean | string {
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return fail(p, v, 'a number, a boolean or a string');
}

function counters(v: unknown, p: string): SaveV1['counters'] {
  const o = exactKeys(obj(v, p), ['fighter', 'entity', 'joint', 'wound', 'dropSerial', 'projSerial'], p);
  return {
    fighter: pos(o.fighter, `${p}.fighter`),
    entity: pos(o.entity, `${p}.entity`),
    joint: pos(o.joint, `${p}.joint`),
    wound: pos(o.wound, `${p}.wound`),
    dropSerial: nat(o.dropSerial, `${p}.dropSerial`),
    projSerial: nat(o.projSerial, `${p}.projSerial`),
  };
}

function rngs(v: unknown, p: string): SaveV1['rng'] {
  const o = exactKeys(obj(v, p), ['combat', 'world', 'fighters', 'minds'], p);
  return {
    combat: u32(o.combat, `${p}.combat`),
    world: u32(o.world, `${p}.world`),
    fighters: arr(o.fighters, `${p}.fighters`).map((x, i) => pair(x, `${p}.fighters[${i}]`, nat, u32)),
    minds: arr(o.minds, `${p}.minds`).map((x, i) => pair(x, `${p}.minds[${i}]`, nat, u32)),
  };
}

function director(v: unknown, p: string): SaveV1['director'] {
  const o = exactKeys(obj(v, p), ['lastAttack'], p);
  return { lastAttack: int(o.lastAttack, `${p}.lastAttack`) };
}

function terrainEdit(v: unknown, p: string): SaveV1['terrain'][number] {
  const o = exactKeys(obj(v, p), ['tile', 'vertex', 'dh'], p);
  return { tile: nat(o.tile, `${p}.tile`), vertex: nat(o.vertex, `${p}.vertex`), dh: fin(o.dh, `${p}.dh`) };
}

function impulse(v: unknown, p: string): SaveV1['impulses'][number] {
  const o = exactKeys(obj(v, p), ['entity', 'j', 'at'], p);
  return { entity: nat(o.entity, `${p}.entity`), j: v3(o.j, `${p}.j`), at: nullable(o.at, `${p}.at`, v3) };
}

// Commands ------------------------------------------------------------------

const COMMAND_BUTTONS: Record<CommandButton, true> = { lpunch: true, rpunch: true, lkick: true, rkick: true, pickup: true, jump: true };
const VERB_IDS: Record<VerbId, true> = {
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
const DEV_OPS: Record<DevOp, true> = {
  spawnApe: true,
  spawnGiant: true,
  giveTool: true,
  teleport: true,
  pauseMinds: true,
  killCreature: true,
  respawnPlayer: true,
  setTuning: true,
};
const METAS: Record<MetaCommand['meta'], true> = { pause: true, save: true, timeAway: true, dev: true };

/** A reader for every field of T: a field added to T is a type error here until it is read. */
type FieldReaders<T> = { readonly [K in keyof T]-?: (v: unknown, p: string) => Exclude<T[K], undefined> };

/**
 * A record of T read field by field in `keys` order (save/serialize.ts's key lists, checked against T when compiled):
 * every `required` key there, the others there or absent, nothing else.
 */
function fields<T>(o: Obj, p: string, keys: readonly (keyof T & string)[], required: readonly (keyof T & string)[], read: FieldReaders<T>): T {
  exactKeys(o, required, p, keys.filter((k) => !required.includes(k)));
  const out: Partial<T> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = read[k](o[k], `${p}.${k}`);
  return out as T;
}

/** The string literal `k` itself. */
const lit =
  <K extends string>(k: K) =>
  (v: unknown, p: string): K =>
    v === k ? k : fail(p, v, `'${k}'`);

const wholes =
  (n: number, what: string) =>
  (v: unknown, p: string): number[] => {
    const a = arr(v, p);
    if (a.length !== n) fail(p, v, what);
    return a.map((x, i) => int(x, `${p}[${i}]`));
  };
const triple = wholes(3, 'three whole numbers') as (v: unknown, p: string) => [number, number, number];

const MOVE_READ: FieldReaders<MoveCommand> = { tick: nat, player: nat, kind: lit('move'), dir: int, speed: int, flags: nat };
const BUTTON_READ: FieldReaders<ButtonCommand> = { tick: nat, player: nat, kind: lit('button'), button: (v, p) => oneOf(v, COMMAND_BUTTONS, p) };
const VERB_READ: FieldReaders<VerbCommand> = {
  tick: nat,
  player: nat,
  kind: lit('verb'),
  verb: (v, p) => oneOf(v, VERB_IDS, p),
  target: nat,
  second: nat,
  at: triple,
  at2: triple,
  yaw: int,
  pitch: int,
  aim: wholes(2, '[yaw, pitch]') as (v: unknown, p: string) => [number, number],
  charge: int,
  slot: int,
  drive: int,
};
const TUNING_EDIT_READ: FieldReaders<TuningEdit> = { table: str, key: str, value: tuningValue };
const DEV_READ: FieldReaders<NonNullable<MetaCommand['dev']>> = {
  op: (v, p) => oneOf(v, DEV_OPS, p),
  args: (v, p) => arr(v, p).map((x, i) => fin(x, `${p}[${i}]`)),
  tuning: (v, p) => fields<TuningEdit>(obj(v, p), p, TUNING_EDIT_KEYS, TUNING_EDIT_KEYS, TUNING_EDIT_READ),
};
const META_READ: FieldReaders<MetaCommand> = {
  tick: nat,
  player: nat,
  kind: lit('meta'),
  meta: (v, p) => oneOf(v, METAS, p),
  seconds: nat,
  dev: (v, p) => fields<NonNullable<MetaCommand['dev']>>(obj(v, p), p, DEV_KEYS, DEV_REQUIRED, DEV_READ),
};

/** A command, every field checked (integers everywhere but a setTuning value), in its type's key order. */
function command(v: unknown, p: string): Command {
  const o = obj(v, p);
  switch (oneOf(o.kind, { move: true, button: true, verb: true, meta: true }, `${p}.kind`)) {
    case 'move':
      return fields<MoveCommand>(o, p, MOVE_KEYS, MOVE_REQUIRED, MOVE_READ);
    case 'button':
      return fields<ButtonCommand>(o, p, BUTTON_KEYS, BUTTON_REQUIRED, BUTTON_READ);
    case 'verb':
      return fields<VerbCommand>(o, p, VERB_KEYS, VERB_REQUIRED, VERB_READ);
    case 'meta':
      return fields<MetaCommand>(o, p, META_KEYS, META_REQUIRED, META_READ);
  }
}

// Entities and joints ---------------------------------------------------------

const ENTITY_STATES: Record<EntityState, true> = { free: true, anchored: true, fixed: true, held: true, stowed: true, tied: true, projectile: true, frozen: true };
const PLANT_PHASES: Record<PlantState['phase'], true> = { standing: true, notched: true, bent: true, falling: true, felled: true };
const ENTITY_KEYS: readonly (keyof EntityRecV1)[] = [
  'id',
  'material',
  'shape',
  'mass',
  'state',
  'pose',
  'vel',
  'integrity',
  'moisture',
  'temperature',
  'burning',
  'sharpPoints',
  'joints',
  'age',
  'credit',
  'look',
  'plant',
  'anchor',
  'rope',
  'crossCut',
  'thrown',
  'loadHist',
  'restTicks',
  'generated',
  'touched',
  'grace',
  'releasedBy',
];

function entity(v: unknown, p: string): EntityRecV1 {
  const o = exactKeys(obj(v, p), ENTITY_KEYS, p);
  const material = str(o.material, `${p}.material`);
  if (!Object.prototype.hasOwnProperty.call(MATERIALS, material)) fail(`${p}.material`, material, 'a material');
  const vel = exactKeys(obj(o.vel, `${p}.vel`), ['lin', 'ang'], `${p}.vel`);
  return {
    id: nat(o.id, `${p}.id`),
    material: material as EntityRecV1['material'],
    shape: shape(o.shape, `${p}.shape`),
    mass: fin(o.mass, `${p}.mass`),
    state: oneOf(o.state, ENTITY_STATES, `${p}.state`),
    pose: pose3(o.pose, `${p}.pose`),
    vel: { lin: v3(vel.lin, `${p}.vel.lin`), ang: v3(vel.ang, `${p}.vel.ang`) },
    integrity: fin(o.integrity, `${p}.integrity`),
    moisture: fin(o.moisture, `${p}.moisture`),
    temperature: fin(o.temperature, `${p}.temperature`),
    burning: bool(o.burning, `${p}.burning`),
    sharpPoints: arr(o.sharpPoints, `${p}.sharpPoints`).map((x, i) => {
      const q = `${p}.sharpPoints[${i}]`;
      const s = exactKeys(obj(x, q), ['local', 'dir', 'sharpness'], q);
      return { local: v3(s.local, `${q}.local`), dir: v3(s.dir, `${q}.dir`), sharpness: fin(s.sharpness, `${q}.sharpness`) };
    }),
    joints: arr(o.joints, `${p}.joints`).map((x, i) => nat(x, `${p}.joints[${i}]`)),
    age: fin(o.age, `${p}.age`),
    credit: strs(o.credit, `${p}.credit`),
    look: str(o.look, `${p}.look`),
    plant: nullable(o.plant, `${p}.plant`, plant),
    anchor: nullable(o.anchor, `${p}.anchor`, (x, q) => {
      const a = exactKeys(obj(x, q), ['depthM', 'capacityN'], q);
      return { depthM: fin(a.depthM, `${q}.depthM`), capacityN: fin(a.capacityN, `${q}.capacityN`) };
    }),
    rope: nullable(o.rope, `${p}.rope`, (x, q) => ({ lengthM: fin(exactKeys(obj(x, q), ['lengthM'], q).lengthM, `${q}.lengthM`) })),
    crossCut: nullable(o.crossCut, `${p}.crossCut`, (x, q) => {
      const c = exactKeys(obj(x, q), ['axisT', 'remaining', 'fromDir'], q);
      return { axisT: fin(c.axisT, `${q}.axisT`), remaining: fin(c.remaining, `${q}.remaining`), fromDir: v3(c.fromDir, `${q}.fromDir`) };
    }),
    thrown: nullable(o.thrown, `${p}.thrown`, (x, q) => {
      const t = exactKeys(obj(x, q), ['by', 'tick'], q);
      return { by: nat(t.by, `${q}.by`), tick: int(t.tick, `${q}.tick`) };
    }),
    loadHist: arr(o.loadHist, `${p}.loadHist`).map((x, i) => fin(x, `${p}.loadHist[${i}]`)),
    restTicks: nat(o.restTicks, `${p}.restTicks`),
    generated: bool(o.generated, `${p}.generated`),
    touched: bool(o.touched, `${p}.touched`),
    grace: nullable(o.grace, `${p}.grace`, (x, q) => {
      const g = exactKeys(obj(x, q), ['from', 'minUntil', 'maxUntil'], q);
      return { from: owner(g.from, `${q}.from`), minUntil: int(g.minUntil, `${q}.minUntil`), maxUntil: int(g.maxUntil, `${q}.maxUntil`) };
    }),
    releasedBy: nullable(o.releasedBy, `${p}.releasedBy`, (x, q) => {
      const r = exactKeys(obj(x, q), ['fighter', 'apartTicks'], q);
      return { fighter: nat(r.fighter, `${q}.fighter`), apartTicks: nat(r.apartTicks, `${q}.apartTicks`) };
    }),
  };
}

function shape(v: unknown, p: string): Shape {
  const o = obj(v, p);
  const kind = oneOf(o.kind, { ball: true, box: true, capsule: true, cylinder: true, hull: true }, `${p}.kind`);
  const pos = (k: string) => {
    const x = fin(o[k], `${p}.${k}`);
    if (!(x > 0)) fail(`${p}.${k}`, x, 'a positive size');
    return x;
  };
  switch (kind) {
    case 'ball':
      exactKeys(o, ['kind', 'r'], p);
      return { kind, r: pos('r') };
    case 'box':
      exactKeys(o, ['kind', 'hx', 'hy', 'hz'], p);
      return { kind, hx: pos('hx'), hy: pos('hy'), hz: pos('hz') };
    case 'capsule':
      exactKeys(o, ['kind', 'halfHeight', 'r'], p);
      return { kind, halfHeight: pos('halfHeight'), r: pos('r') };
    case 'cylinder': {
      exactKeys(o, ['kind', 'halfHeight', 'r', 'sides'], p);
      const sides = nat(o.sides, `${p}.sides`);
      if (sides < 3) fail(`${p}.sides`, sides, 'at least 3 sides');
      return { kind, halfHeight: pos('halfHeight'), r: pos('r'), sides };
    }
    case 'hull': {
      exactKeys(o, ['kind', 'points'], p);
      const points = arr(o.points, `${p}.points`).map((x, i) => fin(x, `${p}.points[${i}]`));
      if (points.length < 12 || points.length % 3 !== 0) fail(`${p}.points`, `${points.length} numbers`, 'at least four xyz points');
      return { kind, points };
    }
  }
}

function plant(v: unknown, p: string): PlantState {
  const o = exactKeys(obj(v, p), ['diameter', 'height', 'phase', 'cut', 'stump', 'fall'], p);
  return {
    diameter: fin(o.diameter, `${p}.diameter`),
    height: fin(o.height, `${p}.height`),
    phase: oneOf(o.phase, PLANT_PHASES, `${p}.phase`),
    cut: nullable(o.cut, `${p}.cut`, (x, q) => {
      const c = exactKeys(obj(x, q), ['fromDir', 'remaining', 'chops', 'depthSumM'], q);
      return { fromDir: v3(c.fromDir, `${q}.fromDir`), remaining: fin(c.remaining, `${q}.remaining`), chops: nat(c.chops, `${q}.chops`), depthSumM: fin(c.depthSumM, `${q}.depthSumM`) };
    }),
    stump: nullable(o.stump, `${p}.stump`, nat),
    fall: nullable(o.fall, `${p}.fall`, fall),
  };
}

function fall(v: unknown, p: string): NonNullable<PlantState['fall']> {
  const o = exactKeys(obj(v, p), ['hinge', 'axis', 'torn'], p);
  return { hinge: v3(o.hinge, `${p}.hinge`), axis: v3(o.axis, `${p}.axis`), torn: bool(o.torn, `${p}.torn`) };
}

const BONE_SET: Record<BoneName, true> = Object.fromEntries(BONES.map((b) => [b, true])) as Record<BoneName, true>;

function owner(v: unknown, p: string): Owner {
  const o = obj(v, p);
  const kind = oneOf(o.kind, { terrain: true, entity: true, fighter: true, rope: true }, `${p}.kind`);
  switch (kind) {
    case 'terrain':
      exactKeys(o, ['kind'], p);
      return { kind };
    case 'entity':
      exactKeys(o, ['kind', 'id'], p);
      return { kind, id: nat(o.id, `${p}.id`) };
    case 'rope':
      exactKeys(o, ['kind', 'joint'], p);
      return { kind, joint: nat(o.joint, `${p}.joint`) };
    case 'fighter': {
      exactKeys(o, ['kind', 'id', 'part'], p, ['bone']);
      const r: { kind: 'fighter'; id: number; part: 'kcc' | 'zone' | 'slab' | 'ruler'; bone?: BoneName } = {
        kind,
        id: nat(o.id, `${p}.id`),
        part: oneOf(o.part, { kcc: true, zone: true, slab: true, ruler: true }, `${p}.part`),
      };
      if (o.bone !== undefined) r.bone = oneOf(o.bone, BONE_SET, `${p}.bone`);
      return r;
    }
  }
}

const JOINT_KINDS: Record<JointKind, true> = { lash: true, hinge: true, rope: true, bend: true };
const JOINT_KEYS: readonly (keyof JointRecV1)[] = ['id', 'kind', 'a', 'b', 'rope', 'breakEnergyJ', 'axis', 'limits', 'motor', 'holdsBend', 'tension', 'pullN', 'credit'];

function joint(v: unknown, p: string): JointRecV1 {
  const o = exactKeys(obj(v, p), JOINT_KEYS, p);
  const tension = arr(o.tension, `${p}.tension`);
  if (tension.length !== 3) fail(`${p}.tension`, o.tension, 'three tensions');
  const breakEnergyJ = num(o.breakEnergyJ, `${p}.breakEnergyJ`);
  if (Number.isNaN(breakEnergyJ)) fail(`${p}.breakEnergyJ`, breakEnergyJ, 'an energy (Infinity for a rope)');
  return {
    id: nat(o.id, `${p}.id`),
    kind: oneOf(o.kind, JOINT_KINDS, `${p}.kind`),
    a: anchor(o.a, `${p}.a`),
    b: anchor(o.b, `${p}.b`),
    rope: nullable(o.rope, `${p}.rope`, (x, q) => {
      const r = exactKeys(obj(x, q), ['entity', 'lengthM'], q);
      return { entity: nat(r.entity, `${q}.entity`), lengthM: fin(r.lengthM, `${q}.lengthM`) };
    }),
    breakEnergyJ,
    axis: nullable(o.axis, `${p}.axis`, v3),
    limits: nullable(o.limits, `${p}.limits`, (x, q) => pair(x, q, fin, fin)),
    motor: nullable(o.motor, `${p}.motor`, (x, q) => {
      const m = exactKeys(obj(x, q), ['restAngle', 'stiffness', 'damping'], q);
      return { restAngle: fin(m.restAngle, `${q}.restAngle`), stiffness: fin(m.stiffness, `${q}.stiffness`), damping: fin(m.damping, `${q}.damping`) };
    }),
    holdsBend: nullable(o.holdsBend, `${p}.holdsBend`, nat),
    tension: [fin(tension[0], `${p}.tension[0]`), fin(tension[1], `${p}.tension[1]`), fin(tension[2], `${p}.tension[2]`)],
    pullN: fin(o.pullN, `${p}.pullN`),
    credit: strs(o.credit, `${p}.credit`),
  };
}

function anchor(v: unknown, p: string): JointRecV1['a'] {
  const o = exactKeys(obj(v, p), ['entity', 'local'], p, ['fighter', 'loose']);
  const a: JointRecV1['a'] = { entity: nullable(o.entity, `${p}.entity`, nat), local: v3(o.local, `${p}.local`) };
  if (o.fighter !== undefined) a.fighter = nat(o.fighter, `${p}.fighter`);
  if (o.loose !== undefined) {
    if (o.loose !== true) fail(`${p}.loose`, o.loose, 'true (or absent)');
    a.loose = true;
  }
  return a;
}

// Fighters, combat, minds, verbs, the spawner --------------------------------------------

let fighterKeys: readonly string[] | null = null;

/**
 * The keys of a fighter record as this build writes them (P04's FighterRecord), read off a fresh fighter's record once
 * (made with its own id counter, so the process-wide legacy counter is untouched).
 */
function fighterRecordKeys(): readonly string[] {
  fighterKeys ??= Object.keys(createPlayer({ ids: new IdCounter(1), rngSeed: 1 }).toRecord([]));
  return fighterKeys;
}

/** Fighter record fields P04's reader walks as arrays or objects (so a wrong kind fails here, by name). */
const FIGHTER_ARRAYS = ['wounds', 'severed', 'torn', 'limbDamage', 'boneShare', 'armour', 'swingJitter'] as const;
const FIGHTER_OBJECTS = ['defenseCooldown', 'stats', 'anim', 'footwork', 'idle', 'motion', 'pose'] as const;

/**
 * A fighter record: exactly the fields this build writes; its identity fields are checked here (the loader makes the
 * fighter from them), its lists and nested records for their kind, and every weapon it holds by value; every value is
 * then read by P04's Fighter.restoreRecord through a checking reader. Returned as it is (restoreRecord copies).
 */
function fighter(v: unknown, p: string): SaveV1['fighters'][number] {
  const o = exactKeys(obj(v, p), fighterRecordKeys(), p);
  for (const k of FIGHTER_ARRAYS) arr(o[k], `${p}.${k}`);
  for (const k of FIGHTER_OBJECTS) obj(o[k], `${p}.${k}`);
  nat(o.id, `${p}.id`);
  nullable(o.playerId, `${p}.playerId`, str);
  nullable(o.species, `${p}.species`, (x, q) => oneOf(x, { human: true, ape: true, giantApe: true }, q));
  fin(o.scale, `${p}.scale`);
  fin(o.yaw, `${p}.yaw`);
  v3(o.pos, `${p}.pos`);
  if (o.weapon !== null) weaponRecord(o.weapon, `${p}.weapon`);
  if (o.ammo !== null) weaponRecord(obj(o.ammo, `${p}.ammo`).weapon, `${p}.ammo.weapon`);
  if (o.pickupTarget !== null) weaponRecord(obj(o.pickupTarget, `${p}.pickupTarget`).weapon, `${p}.pickupTarget.weapon`);
  return o as unknown as SaveV1['fighters'][number];
}

/** A drop (CombatSim.restoreRecord checks its fields); its weapon by value is checked here. */
function drop(v: unknown, p: string): SaveV1['drops'][number] {
  const o = obj(v, p);
  weaponRecord(o.weapon, `${p}.weapon`);
  return o as unknown as SaveV1['drops'][number];
}

/** A projectile (CombatSim.restoreRecord checks its fields); its weapon by value is checked here. */
function projectile(v: unknown, p: string): SaveV1['projectiles'][number] {
  const o = obj(v, p);
  weaponRecord(o.weapon, `${p}.weapon`);
  return o as unknown as SaveV1['projectiles'][number];
}

const WEAPON_STYLES = { oneHand: true, twoHand: true } as const;
const WEAPON_EDGES = { blade: true, blunt: true } as const;
const WEAPON_NUMBERS = ['length', 'strikeFrom', 'radius', 'damageMul', 'cut', 'cleave', 'bite', 'tempo', 'mass', 'choke'] as const satisfies readonly (keyof WeaponDef)[];
const WEAPON_KEYS = ['id', 'name', 'style', 'edge', ...WEAPON_NUMBERS, 'light', 'heavy', 'chain'] as const satisfies readonly (keyof WeaponDef)[];

/**
 * A weapon record `{ id, def }`: `def` null names a WEAPONS entry by id; a definition by value (a tool the world made,
 * §5.2) has every WeaponDef field of its kind, and its id is a weapon id.
 */
function weaponRecord(v: unknown, p: string): void {
  const o = exactKeys(obj(v, p), ['id', 'def'], p);
  const id = str(o.id, `${p}.id`);
  if (!Object.prototype.hasOwnProperty.call(WEAPONS, id)) fail(`${p}.id`, id, 'a weapon id');
  if (o.def === null) return;
  const q = `${p}.def`;
  const d = exactKeys(obj(o.def, q), WEAPON_KEYS, q, ['sharpness']);
  if (d.id !== id) fail(`${q}.id`, d.id, `the record's weapon id ${short(id)}`);
  str(d.name, `${q}.name`);
  oneOf(d.style, WEAPON_STYLES, `${q}.style`);
  oneOf(d.edge, WEAPON_EDGES, `${q}.edge`);
  for (const k of WEAPON_NUMBERS) fin(d[k], `${q}.${k}`);
  if (d.sharpness !== undefined) fin(d.sharpness, `${q}.sharpness`);
  str(d.light, `${q}.light`);
  str(d.heavy, `${q}.heavy`);
  const chain = obj(d.chain, `${q}.chain`);
  for (const k of Object.keys(chain)) str(chain[k], `${q}.chain.${k}`);
}

const MIND_KEYS: readonly (keyof MindRecV1)[] = [
  'fighter',
  'kind',
  'state',
  'stateTick',
  'resume',
  'mark',
  'paused',
  'script',
  'awareness',
  'lkp',
  'lkpTick',
  'lastSeenTick',
  'stimulus',
  'hurt',
  'home',
  'homeIdx',
  'routeIdx',
  'restUntil',
  'cooldownUntil',
  'fleeUntil',
  'heading',
  'charge',
  'path',
  'stuck',
  'rng',
  'inner',
];

/** Every PostureId (world/types.ts), for a `hold` script. */
const SCRIPT_POSTURES: Readonly<Record<PostureId, true>> = {
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

/**
 * A mind record (§6.8; CreatureMind.toRecord), every field checked: its keys, the states, the script by kind, the
 * senses (`stimulus` may be Infinity: the window after a hurt), the memory, the timers, a charge, the path (one version
 * per tile, the corner within the points) and the stuck window. The inner BrawlerAI's fields are read by
 * BrawlerAI.restoreRecord itself (P04's readers).
 */
function mind(v: unknown, p: string): MindRecV1 {
  const o = exactKeys(obj(v, p), MIND_KEYS, p, ['route']);
  nat(o.fighter, `${p}.fighter`);
  const kind = oneOf(o.kind, { ape: true, giantApe: true }, `${p}.kind`);
  // The giant's hand-set route (P20, RulerMind): on every giant's record (null: the spawn data's), never on an ape's.
  if (kind === 'giantApe') {
    nullable(o.route, `${p}.route`, (x, q) =>
      arr(x, q).forEach((pt, k) => {
        const r = `${q}[${k}]`;
        const xz = exactKeys(obj(pt, r), ['x', 'z'], r);
        fin(xz.x, `${r}.x`);
        fin(xz.z, `${r}.z`);
      }),
    );
  } else if (o.route !== undefined) fail(`${p}.route`, o.route, "absent (only a giant's mind has a route)");
  oneOf(o.state, MIND_STATE_DOMAIN, `${p}.state`);
  nullable(o.resume, `${p}.resume`, (x, q) => oneOf(x, MIND_STATE_DOMAIN, q));
  bool(o.paused, `${p}.paused`);
  u32(o.rng, `${p}.rng`);
  for (const k of ['stateTick', 'mark', 'lkpTick', 'lastSeenTick', 'homeIdx', 'routeIdx', 'restUntil', 'cooldownUntil', 'fleeUntil'] as const) int(o[k], `${p}.${k}`);
  fin(o.heading, `${p}.heading`);
  num(o.stimulus, `${p}.stimulus`);
  arr(o.awareness, `${p}.awareness`).forEach((x, i) => pair(x, `${p}.awareness[${i}]`, nat, fin));
  nullable(o.lkp, `${p}.lkp`, v3);
  nullable(o.script, `${p}.script`, mindScript);
  nullable(o.hurt, `${p}.hurt`, (x, q) => {
    const h = exactKeys(obj(x, q), ['tick', 'point'], q);
    int(h.tick, `${q}.tick`);
    return v3(h.point, `${q}.point`);
  });
  const home = exactKeys(obj(o.home, `${p}.home`), ['x', 'z'], `${p}.home`);
  fin(home.x, `${p}.home.x`);
  fin(home.z, `${p}.home.z`);
  nullable(o.charge, `${p}.charge`, (x, q) => {
    const c = exactKeys(obj(x, q), ['heading', 'start', 'travelled', 'close'], q);
    fin(c.heading, `${q}.heading`);
    v3(c.start, `${q}.start`);
    fin(c.travelled, `${q}.travelled`);
    return bool(c.close, `${q}.close`);
  });
  nullable(o.path, `${p}.path`, (x, q) => {
    const pa = exactKeys(obj(x, q), ['points', 'i', 'goal', 'complete', 'tiles', 'versions', 'requestTick', 'pending'], q);
    const points = arr(pa.points, `${q}.points`).map((pt, k) => v3(pt, `${q}.points[${k}]`));
    const i = nat(pa.i, `${q}.i`);
    if (i > points.length) fail(`${q}.i`, i, `a corner of its ${points.length} points (or their end)`);
    v3(pa.goal, `${q}.goal`);
    bool(pa.complete, `${q}.complete`);
    const tiles = arr(pa.tiles, `${q}.tiles`).map((t, k) => nat(t, `${q}.tiles[${k}]`));
    const versions = arr(pa.versions, `${q}.versions`).map((t, k) => u32(t, `${q}.versions[${k}]`));
    if (tiles.length !== versions.length) fail(`${q}.versions`, versions, `one version per tile (${tiles.length})`);
    int(pa.requestTick, `${q}.requestTick`);
    return bool(pa.pending, `${q}.pending`);
  });
  const st = exactKeys(obj(o.stuck, `${p}.stuck`), ['pos', 'tick', 'count'], `${p}.stuck`);
  v3(st.pos, `${p}.stuck.pos`);
  int(st.tick, `${p}.stuck.tick`);
  nat(st.count, `${p}.stuck.count`);
  nullable(o.inner, `${p}.inner`, obj);
  return o as unknown as MindRecV1;
}

/** A mind's script (§6.6), by kind, with its optional fields. */
function mindScript(v: unknown, p: string): MindScript {
  const o = obj(v, p);
  switch (oneOf(o.kind, { route: true, charge: true, tug: true, hold: true }, `${p}.kind`)) {
    case 'route':
      exactKeys(o, ['kind', 'points'], p, ['speed', 'gait', 'useNav', 'crouch']);
      arr(o.points, `${p}.points`).forEach((x, i) => {
        const q = `${p}.points[${i}]`;
        const pt = exactKeys(obj(x, q), ['x', 'z'], q);
        fin(pt.x, `${q}.x`);
        fin(pt.z, `${q}.z`);
      });
      if (o.speed !== undefined) fin(o.speed, `${p}.speed`);
      if (o.gait !== undefined) fin(o.gait, `${p}.gait`);
      if (o.useNav !== undefined) bool(o.useNav, `${p}.useNav`);
      if (o.crouch !== undefined) bool(o.crouch, `${p}.crouch`);
      break;
    case 'charge':
      exactKeys(o, ['kind', 'heading', 'speed'], p, ['telegraph']);
      fin(o.heading, `${p}.heading`);
      fin(o.speed, `${p}.speed`);
      if (o.telegraph !== undefined) bool(o.telegraph, `${p}.telegraph`);
      break;
    case 'tug':
      exactKeys(o, ['kind', 'entity', 'dirYaw', 'ticks'], p);
      nat(o.entity, `${p}.entity`);
      fin(o.dirYaw, `${p}.dirYaw`);
      nat(o.ticks, `${p}.ticks`);
      break;
    case 'hold':
      exactKeys(o, ['kind'], p, ['posture']);
      if (o.posture !== undefined) oneOf(o.posture, SCRIPT_POSTURES, `${p}.posture`);
      break;
  }
  return o as unknown as MindScript;
}

/**
 * A fighter's verb state (P14's VerbSystem.toRecord, world/verbs/index.ts), every field checked: the focus (an entity,
 * or 0 for the ground, and a point), a continuous verb that is on (its command read as any verb command, in its type's
 * key order; the handler's numbers as [key, value] pairs sorted by key) and a creature's tug. The fighter, the record
 * order and the entity ids are checked in crossCheck.
 */
function verbState(v: unknown, p: string): VerbStateRecord {
  const o = exactKeys(obj(v, p), ['fighter', 'focus', 'cont', 'tug'], p);
  return {
    fighter: nat(o.fighter, `${p}.fighter`),
    focus: nullable(o.focus, `${p}.focus`, (x, q) => {
      const f = exactKeys(obj(x, q), ['target', 'at'], q);
      return { target: nat(f.target, `${q}.target`), at: nullable(f.at, `${q}.at`, v3) };
    }),
    cont: nullable(o.cont, `${p}.cont`, (x, q) => {
      const c = exactKeys(obj(x, q), ['verb', 'cmd', 'ticks', 'data'], q);
      const verb = oneOf(c.verb, VERB_IDS, `${q}.verb`);
      const cmd = fields<VerbCommand>(obj(c.cmd, `${q}.cmd`), `${q}.cmd`, VERB_KEYS, VERB_REQUIRED, VERB_READ);
      if (cmd.verb !== verb) fail(`${q}.cmd.verb`, cmd.verb, `the continuous verb ${short(verb)}`);
      const data = arr(c.data, `${q}.data`).map((d, i) => pair(d, `${q}.data[${i}]`, str, num));
      data.forEach(([k], i) => {
        if (i > 0 && !(k > data[i - 1][0])) fail(`${q}.data[${i}][0]`, k, 'a key after the one before it (sorted, no repeats)');
      });
      return { verb, cmd, ticks: nat(c.ticks, `${q}.ticks`), data };
    }),
    tug: nullable(o.tug, `${p}.tug`, (x, q) => {
      const t = exactKeys(obj(x, q), ['entity', 'grip'], q);
      return { entity: nat(t.entity, `${q}.entity`), grip: v3(t.grip, `${q}.grip`) };
    }),
  };
}

function spawner(v: unknown, p: string): SaveV1['spawner'] {
  const o = exactKeys(obj(v, p), ['homes', 'sparring'], p);
  const slot = (x: unknown, q: string) => {
    const s = exactKeys(obj(x, q), ['fighter', 'respawnTick'], q);
    return { fighter: nullable(s.fighter, `${q}.fighter`, nat), respawnTick: int(s.respawnTick, `${q}.respawnTick`) };
  };
  return { homes: arr(o.homes, `${p}.homes`).map((x, i) => slot(x, `${p}.homes[${i}]`)), sparring: slot(o.sparring, `${p}.sparring`) };
}

// Bodies, rulers, contacts, felling -------------------------------------------

function bodies(v: unknown, p: string): BodiesRecV1 {
  const o = exactKeys(obj(v, p), ['fighter', 'kcc', 'zonesHistory', 'slab', 'ruler'], p);
  return {
    fighter: nat(o.fighter, `${p}.fighter`),
    kcc: nullable(o.kcc, `${p}.kcc`, (x, q) => {
      const k = exactKeys(obj(x, q), ['pose', 'vy', 'grounded', 'crouched', 'enabled', 'halfHeight', 'teleport', 'pushes', 'pushTick'], q);
      return {
        pose: pose3(k.pose, `${q}.pose`),
        vy: fin(k.vy, `${q}.vy`),
        grounded: bool(k.grounded, `${q}.grounded`),
        crouched: bool(k.crouched, `${q}.crouched`),
        enabled: bool(k.enabled, `${q}.enabled`),
        halfHeight: fin(k.halfHeight, `${q}.halfHeight`),
        teleport: nullable(k.teleport, `${q}.teleport`, v3),
        pushes: arr(k.pushes, `${q}.pushes`).map((x, i) => {
          const at = `${q}.pushes[${i}]`;
          const d = exactKeys(obj(x, at), ['entity', 'x', 'z'], at);
          return { entity: nat(d.entity, `${at}.entity`), x: fin(d.x, `${at}.x`), z: fin(d.z, `${at}.z`) };
        }),
        pushTick: int(k.pushTick, `${q}.pushTick`),
      };
    }),
    zonesHistory: arr(o.zonesHistory, `${p}.zonesHistory`).map((x, i) => fin(x, `${p}.zonesHistory[${i}]`)),
    slab: nullable(o.slab, `${p}.slab`, (x, q) => {
      const s = exactKeys(obj(x, q), ['enabled', 'pose', 'lin', 'ang', 'hold', 'handedBack', 'dv'], q);
      return {
        enabled: bool(s.enabled, `${q}.enabled`),
        pose: pose3(s.pose, `${q}.pose`),
        lin: v3(s.lin, `${q}.lin`),
        ang: v3(s.ang, `${q}.ang`),
        hold: nat(s.hold, `${q}.hold`),
        handedBack: bool(s.handedBack, `${q}.handedBack`),
        dv: nullable(s.dv, `${q}.dv`, v3),
      };
    }),
    ruler: nullable(o.ruler, `${p}.ruler`, rulerBody),
  };
}

/**
 * A ruler's body (P11's RulerBodies.toRecord, world/rulerBody.ts), every field checked: the frozen pose is the 12 bones
 * in BONES order while dynamic and empty standing, the history 0 or 6 numbers a bone, the supports in increasing entity
 * order. The entity ids it names are checked against the counter in crossCheck.
 */
function rulerBody(v: unknown, p: string): RulerBodyRecV1 {
  const o = exactKeys(
    obj(v, p),
    ['dynamic', 'pose', 'lin', 'ang', 'local', 'history', 'sleeping', 'jump', 'climbFloor', 'deflect', 'supports', 'coverBreak'],
    p,
  );
  const dynamic = bool(o.dynamic, `${p}.dynamic`);
  const local = arr(o.local, `${p}.local`).map((x, i) => {
    const q = `${p}.local[${i}]`;
    const l = exactKeys(obj(x, q), ['bone', 'p', 'q'], q);
    if (l.bone !== BONES[i]) fail(`${q}.bone`, l.bone, `the bone ${BONES[i] ?? 'none'} (BONES order)`);
    return { bone: BONES[i], p: v3(l.p, `${q}.p`), q: quat(l.q, `${q}.q`) };
  });
  if (local.length !== (dynamic ? BONES.length : 0)) fail(`${p}.local`, local.length, `${dynamic ? BONES.length : 0} bones (dynamic ${dynamic})`);
  const history = arr(o.history, `${p}.history`).map((x, i) => fin(x, `${p}.history[${i}]`));
  if (history.length !== 0 && history.length !== 6 * BONES.length) fail(`${p}.history`, history.length, `0 or ${6 * BONES.length} numbers`);
  const supports = arr(o.supports, `${p}.supports`).map((x, i) => {
    const q = `${p}.supports[${i}]`;
    const s = exactKeys(obj(x, q), ['entity', 'tick', 'credit'], q);
    return { entity: pos(s.entity, `${q}.entity`), tick: int(s.tick, `${q}.tick`), credit: strs(s.credit, `${q}.credit`) };
  });
  supports.forEach((s, i) => {
    if (i > 0 && !(s.entity > supports[i - 1].entity)) fail(`${p}.supports[${i}].entity`, s.entity, 'an entity after the one before it (increasing, no repeats)');
  });
  return {
    dynamic,
    pose: pose3(o.pose, `${p}.pose`),
    lin: v3(o.lin, `${p}.lin`),
    ang: v3(o.ang, `${p}.ang`),
    local,
    history,
    sleeping: bool(o.sleeping, `${p}.sleeping`),
    jump: bool(o.jump, `${p}.jump`),
    climbFloor: nullable(o.climbFloor, `${p}.climbFloor`, fin),
    deflect: nullable(o.deflect, `${p}.deflect`, (x, q) => {
      const d = exactKeys(obj(x, q), ['entity', 'tick'], q);
      return { entity: pos(d.entity, `${q}.entity`), tick: int(d.tick, `${q}.tick`) };
    }),
    supports,
    coverBreak: nullable(o.coverBreak, `${p}.coverBreak`, (x, q) => {
      const c = exactKeys(obj(x, q), ['tick', 'cause'], q);
      return { tick: int(c.tick, `${q}.tick`), cause: cause(c.cause, `${q}.cause`) };
    }),
  };
}

const RULER_ZONES: Record<RulerZoneId, true> = {
  skull: true,
  eyes: true,
  mouth: true,
  back: true,
  shoulders: true,
  flanks: true,
  belly: true,
  knees: true,
  elbows: true,
  chest: true,
  arm: true,
  leg: true,
  pelvis: true,
};
const SEVERE_EFFECTS: Record<SevereEffect, true> = { limp: true, blindL: true, blindR: true, weakJaw: true, winded: true };
const TRIP_WHYS: Record<TripWhy, true> = { obstacle: true, cover: true, ledge: true, impact: true };
const CAUSE_KINDS: Record<CauseKind, true> = { entity: true, terrain: true, creature: true, bleed: true };
const CAUSE_FEATURES: Record<CauseFeature, true> = { sharpPoint: true, falling: true, swinging: true, rolling: true, cover: true, rope: true, fall: true, creature: true };

/** A RulerState (§2.8), in its type's key order (as save/serialize.ts's rulerRecord writes it). */
function rulerState(v: unknown, p: string): RulerState {
  const o = exactKeys(
    obj(v, p),
    ['maxHp', 'unhealed', 'wounds', 'pinned', 'pinnedKg', 'unpinTicks', 'stuck', 'burning', 'inPit', 'downWound', 'downCause', 'lastWorldTrip', 'deflectedHeading', 'pendingTrip'],
    p,
  );
  return {
    maxHp: fin(o.maxHp, `${p}.maxHp`),
    unhealed: fin(o.unhealed, `${p}.unhealed`),
    wounds: arr(o.wounds, `${p}.wounds`).map((x, i) => wound(x, `${p}.wounds[${i}]`)),
    pinned: bool(o.pinned, `${p}.pinned`),
    pinnedKg: fin(o.pinnedKg, `${p}.pinnedKg`),
    unpinTicks: nat(o.unpinTicks, `${p}.unpinTicks`),
    stuck: bool(o.stuck, `${p}.stuck`),
    burning: bool(o.burning, `${p}.burning`),
    inPit: bool(o.inPit, `${p}.inPit`),
    downWound: nullable(o.downWound, `${p}.downWound`, nat),
    downCause: nullable(o.downCause, `${p}.downCause`, cause),
    lastWorldTrip: nullable(o.lastWorldTrip, `${p}.lastWorldTrip`, (x, q) => {
      const t = exactKeys(obj(x, q), ['tick', 'cause'], q);
      return { tick: int(t.tick, `${q}.tick`), cause: nullable(t.cause, `${q}.cause`, cause) };
    }),
    deflectedHeading: nullable(o.deflectedHeading, `${p}.deflectedHeading`, fin),
    pendingTrip: nullable(o.pendingTrip, `${p}.pendingTrip`, (x, q) => {
      const t = exactKeys(obj(x, q), ['why', 'tick', 'cause'], q);
      return { why: oneOf(t.why, TRIP_WHYS, `${q}.why`), tick: int(t.tick, `${q}.tick`), cause: nullable(t.cause, `${q}.cause`, cause) };
    }),
  };
}

function wound(v: unknown, p: string): WoundRecord {
  const o = exactKeys(obj(v, p), ['id', 'zone', 'bone', 'local', 'severe', 'effect', 'hp', 'remaining', 'cause', 'tick', 'credit'], p);
  return {
    id: nat(o.id, `${p}.id`),
    zone: oneOf(o.zone, RULER_ZONES, `${p}.zone`),
    bone: oneOf(o.bone, BONE_SET, `${p}.bone`),
    local: v3(o.local, `${p}.local`),
    severe: bool(o.severe, `${p}.severe`),
    effect: nullable(o.effect, `${p}.effect`, (x, q) => oneOf(x, SEVERE_EFFECTS, q)),
    hp: fin(o.hp, `${p}.hp`),
    remaining: fin(o.remaining, `${p}.remaining`),
    cause: cause(o.cause, `${p}.cause`),
    tick: int(o.tick, `${p}.tick`),
    credit: strs(o.credit, `${p}.credit`),
  };
}

function cause(v: unknown, p: string): ImpactCause {
  const o = exactKeys(obj(v, p), ['kind', 'entityId', 'fighterId', 'credit', 'held', 'feature'], p);
  return {
    kind: oneOf(o.kind, CAUSE_KINDS, `${p}.kind`),
    entityId: nullable(o.entityId, `${p}.entityId`, nat),
    fighterId: nullable(o.fighterId, `${p}.fighterId`, nat),
    credit: strs(o.credit, `${p}.credit`),
    held: bool(o.held, `${p}.held`),
    feature: oneOf(o.feature, CAUSE_FEATURES, `${p}.feature`),
  };
}

/** A contact group's other owner, as ContactSystem keys it. */
const CONTACT_OWNER = /^(?:terrain|(entity|fighter|rope):([1-9][0-9]*))$/;

/**
 * One ContactSystem group (§8.3 `contacts`, RR-19). §8.3 types `creature` as a number, and §4.3 applies the episode rule
 * to an entity's integrity too, per (entity, other owner), without saying how that subject is written. P09's
 * ContactSystem.toRecord writes a signed subject id: > 0 a fighter (the lower id when both sides are fighters), < 0 an
 * entity's id negated (a group with no fighter in it), never 0 (ids start at 1). The ids are checked against their
 * counters, and the record's form and order, in crossCheck.
 */
function contact(v: unknown, p: string): SaveV1['contacts'][number] {
  const o = exactKeys(obj(v, p), ['creature', 'owner', 'touching', 'episodeStart', 'cooldownUntil'], p);
  const creature = int(o.creature, `${p}.creature`);
  if (creature === 0) fail(`${p}.creature`, creature, 'a fighter id (> 0) or a negated entity id (< 0)');
  const owner = str(o.owner, `${p}.owner`);
  if (!CONTACT_OWNER.test(owner)) fail(`${p}.owner`, owner, "'terrain', 'entity:<id>', 'fighter:<id>' or 'rope:<joint>'");
  return {
    creature,
    owner,
    touching: nat(o.touching, `${p}.touching`),
    episodeStart: int(o.episodeStart, `${p}.episodeStart`),
    cooldownUntil: int(o.cooldownUntil, `${p}.cooldownUntil`),
  };
}

function felling(v: unknown, p: string): SaveV1['felling'][number] {
  const o = exactKeys(obj(v, p), ['tree', 'phase', 'fall'], p);
  return { tree: nat(o.tree, `${p}.tree`), phase: oneOf(o.phase, PLANT_PHASES, `${p}.phase`), fall: nullable(o.fall, `${p}.fall`, fall) };
}

// ---------------------------------------------------------------------------
// Readers (the `save record:` errors of body/animator.ts's readers, by path)
// ---------------------------------------------------------------------------

function short(v: unknown): string {
  if (v === undefined) return 'missing';
  let t: string;
  try {
    t = typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v);
  } catch {
    t = String(v);
  }
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

function fail(path: string, v: unknown, what: string): never {
  throw new Error(`save record: ${path} is ${short(v)}, not ${what}`);
}

function obj(v: unknown, p: string): Obj {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  return fail(p, v, 'an object');
}

function arr(v: unknown, p: string): readonly unknown[] {
  if (Array.isArray(v)) return v;
  return fail(p, v, 'an array');
}

/** Every key of `required` present, nothing outside `required` and `optional`. */
function exactKeys(o: Obj, required: readonly string[], p: string, optional: readonly string[] = []): Obj {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(`${p}.${k}`, undefined, 'there');
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) throw new Error(`save record: ${p} has a field this version doesn't have: ${k}`);
  }
  return o;
}

function num(v: unknown, p: string): number {
  if (typeof v === 'number') return v;
  return fail(p, v, 'a number');
}

function fin(v: unknown, p: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return fail(p, v, 'a finite number');
}

function int(v: unknown, p: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  return fail(p, v, 'a whole number');
}

function nat(v: unknown, p: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  return fail(p, v, 'a whole number ≥ 0');
}

function pos(v: unknown, p: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return v;
  return fail(p, v, 'a whole number ≥ 1');
}

function u32(v: unknown, p: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff) return v;
  return fail(p, v, 'a uint32');
}

function bool(v: unknown, p: string): boolean {
  if (typeof v === 'boolean') return v;
  return fail(p, v, 'a boolean');
}

function str(v: unknown, p: string): string {
  if (typeof v === 'string') return v;
  return fail(p, v, 'a string');
}

function strs(v: unknown, p: string): string[] {
  return arr(v, p).map((x, i) => str(x, `${p}[${i}]`));
}

function oneOf<K extends string>(v: unknown, domain: Readonly<Record<K, unknown>>, p: string): K {
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(domain, v)) return v as K;
  return fail(p, v, `one of ${Object.keys(domain).join(', ')}`);
}

function oneOfNum(v: unknown, domain: readonly number[], p: string): number {
  if (typeof v === 'number' && domain.includes(v)) return v;
  return fail(p, v, `one of ${domain.join(', ')}`);
}

function nullable<T>(v: unknown, p: string, read: (v: unknown, p: string) => T): T | null {
  return v === null ? null : read(v, p);
}

function pair<A, B>(v: unknown, p: string, a: (v: unknown, p: string) => A, b: (v: unknown, p: string) => B): [A, B] {
  const t = arr(v, p);
  if (t.length !== 2) fail(p, v, 'a pair');
  return [a(t[0], `${p}[0]`), b(t[1], `${p}[1]`)];
}

function v3(v: unknown, p: string): V3 {
  const o = exactKeys(obj(v, p), ['x', 'y', 'z'], p);
  return { x: fin(o.x, `${p}.x`), y: fin(o.y, `${p}.y`), z: fin(o.z, `${p}.z`) };
}

function quat(v: unknown, p: string): Quat {
  const o = exactKeys(obj(v, p), ['x', 'y', 'z', 'w'], p);
  return { x: fin(o.x, `${p}.x`), y: fin(o.y, `${p}.y`), z: fin(o.z, `${p}.z`), w: fin(o.w, `${p}.w`) };
}

function pose3(v: unknown, p: string): Pose3 {
  const o = exactKeys(obj(v, p), ['p', 'q'], p);
  return { p: v3(o.p, `${p}.p`), q: quat(o.q, `${p}.q`) };
}
