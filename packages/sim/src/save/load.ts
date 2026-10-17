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
// 1. tuning: with `applyTuning`, the save's overrides go into the process-wide registry first (they shape generation);
//    without it the registry is left alone (RR-17). All or nothing: a failure anywhere puts the registry back;
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
//    restored; the events construction pushed cleared.
// Rapier's body order after a load differs from the saving world's (restored bodies are made after the generated ones
// kept), so a loaded world matches the saved one within SPEC:730's 1 cm and 1° at rest, not bit for bit; two loads of
// one save are bit-identical to each other.
import { BONES, type BoneName } from '../body/skeleton';
import type { Command, DevOp, MetaCommand, MoveCommand, VerbCommand, VerbId } from '../sim/commands';
import { type Fighter, IdCounter } from '../sim/fighter';
import { createPlayer } from '../sim/roster';
import type { WeaponDef } from '../sim/weapons';
import { WEAPONS } from '../sim/weapons';
import { restoreTuning, setTuningValue, TUNING, tuningSnapshot } from '../tuning/registry';
import { MATERIALS } from '../world/materials';
import { physicsReady } from '../world/physics';
import type {
  CauseFeature,
  CauseKind,
  EntityState,
  ImpactCause,
  JointKind,
  Owner,
  PlantState,
  Pose3,
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
  SAVE_FORMAT,
  SAVE_FORMAT_VERSION,
  SAVE_V1_KEYS,
  type SaveV1,
  type SlabRecV1,
  type TuningOverrideV1,
} from './schema';
import { isClientTuning } from './serialize';

export interface LoadOptions {
  /** 'off' builds no navmesh (physics-only tests). Default 'full'. */
  nav?: 'full' | 'off';
  /**
   * Default false: restore the save's tuningOverrides into the process-wide registry (RR-17). The registry is per
   * process and the client holds one live world; tests that load with applyTuning restore a snapshot afterwards.
   */
  applyTuning?: boolean;
}

/**
 * Builds the world a save describes (see the top of this file). applyTuning (default false): restore the save's
 * tuningOverrides into the process-wide registry (RR-17).
 */
export async function loadWorld(bytes: Uint8Array, opts?: { nav?: 'full' | 'off'; applyTuning?: boolean }): Promise<World> {
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
 * The save's overrides into the registry, over whatever this process holds now (the registry is not reset to its
 * defaults first: the overrides are the saving build's differences from its defaults). A client table, or a table this
 * process doesn't register (a client table in a sim-only process: saves hold none, but the client's own tables are not
 * the save's to set), is skipped; an unknown key or a value of the wrong kind in a sim table throws.
 */
function applyTuningOverrides(list: readonly TuningOverrideV1[]): void {
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
  for (const f of [...w.combat.fighters].sort(byId)) if (!f.ruler) w.zones.resetHistory(f);
  w.contacts.restoreRecord(s.contacts);
  for (const [id, until] of s.contactGrace) w.contacts.grace(id, until);
  w.felling.restoreRecord(s.felling);
  w.deaths.restoreRecord(s.deaths, s.corpses);
  for (const q of s.impulses) w.entities.queueImpulse(q.entity, q.j, q.at);

  // 7. Streams, counters, the navmesh, events.
  w.rngs.restoreRecord({ combat: s.rng.combat, world: s.rng.world });
  w.ids.fighter.next = s.counters.fighter;
  w.ids.entity.next = s.counters.entity;
  w.ids.joint.next = s.counters.joint;
  w.ids.wound.next = s.counters.wound;
  if (w.nav) {
    w.nav.build(w);
    w.nav.restoreDirty(s.navDirty);
  }
  w.events.length = 0;
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
 * The minds' records. TODO(P19): MindRegistry.restoreRecord(r: MindRecV1[]) (by fighter id: each mind's state, script,
 * awareness, memory, path and inner BrawlerAI) is P19's; until it exists a save with a mind can't be loaded.
 */
function restoreMinds(w: World, minds: readonly MindRecV1[]): void {
  if (minds.length === 0) return;
  const reg = w.minds as unknown as { restoreRecord?: (r: MindRecV1[]) => void };
  if (typeof reg.restoreRecord !== 'function') throw new Error('loadWorld: the save has creature minds, and MindRegistry.restoreRecord is not implemented yet (P19)');
  for (const m of minds) fighterById(w, m.fighter, 'minds');
  reg.restoreRecord([...minds]);
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
  for (const e of s.entities) if (e.id >= s.counters.entity) throw new Error(`save record: entity ${e.id} is not below counters.entity (${s.counters.entity})`);
  for (const id of s.removed) if (id >= s.counters.entity) throw new Error(`save record: removed entity ${id} is not below counters.entity (${s.counters.entity})`);
  for (const j of s.joints) if (j.id >= s.counters.joint) throw new Error(`save record: joint ${j.id} is not below counters.joint (${s.counters.joint})`);
  for (let i = 1; i < s.entities.length; i++) {
    if (!(s.entities[i].id > s.entities[i - 1].id)) throw new Error(`save record: entities are not in increasing id order at entities[${i}]`);
  }
  for (let i = 1; i < s.joints.length; i++) {
    if (!(s.joints[i].id > s.joints[i - 1].id)) throw new Error(`save record: joints are not in increasing id order at joints[${i}]`);
  }
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
  const value = o.value;
  if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') fail(`${p}.value`, value, 'a number, a boolean or a string');
  return { table: str(o.table, `${p}.table`), key: str(o.key, `${p}.key`), value };
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

const COMMAND_BUTTONS = { lpunch: true, rpunch: true, lkick: true, rkick: true, pickup: true, jump: true } as const;
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
const METAS = { pause: true, save: true, timeAway: true, dev: true } as const;

/** A command, every field checked (integers everywhere but a setTuning value), in its type's key order. */
function command(v: unknown, p: string): Command {
  const o = obj(v, p);
  const tick = nat(o.tick, `${p}.tick`);
  const player = nat(o.player, `${p}.player`);
  const kind = oneOf(o.kind, { move: true, button: true, verb: true, meta: true }, `${p}.kind`);
  switch (kind) {
    case 'move': {
      exactKeys(o, ['tick', 'player', 'kind', 'dir', 'speed'], p, ['flags']);
      const c: MoveCommand = { tick, player, kind, dir: int(o.dir, `${p}.dir`), speed: int(o.speed, `${p}.speed`) };
      if (o.flags !== undefined) c.flags = nat(o.flags, `${p}.flags`);
      return c;
    }
    case 'button':
      exactKeys(o, ['tick', 'player', 'kind', 'button'], p);
      return { tick, player, kind, button: oneOf(o.button, COMMAND_BUTTONS, `${p}.button`) };
    case 'verb':
      return verbCommand(o, p);
    case 'meta': {
      exactKeys(o, ['tick', 'player', 'kind', 'meta'], p, ['seconds', 'dev']);
      const c: MetaCommand = { tick, player, kind, meta: oneOf(o.meta, METAS, `${p}.meta`) };
      if (o.seconds !== undefined) c.seconds = nat(o.seconds, `${p}.seconds`);
      if (o.dev !== undefined) {
        const d = exactKeys(obj(o.dev, `${p}.dev`), ['op', 'args'], `${p}.dev`, ['tuning']);
        c.dev = { op: oneOf(d.op, DEV_OPS, `${p}.dev.op`), args: arr(d.args, `${p}.dev.args`).map((x, i) => fin(x, `${p}.dev.args[${i}]`)) };
        if (d.tuning !== undefined) {
          const t = tuningOverride(d.tuning, `${p}.dev.tuning`);
          c.dev.tuning = { table: t.table, key: t.key, value: t.value };
        }
      }
      return c;
    }
  }
}

function verbCommand(o: Obj, p: string): VerbCommand {
  exactKeys(o, ['tick', 'player', 'kind', 'verb', 'target'], p, ['second', 'at', 'at2', 'yaw', 'pitch', 'aim', 'charge', 'slot', 'drive']);
  if (o.kind !== 'verb') fail(`${p}.kind`, o.kind, "'verb'");
  const c: VerbCommand = {
    tick: nat(o.tick, `${p}.tick`),
    player: nat(o.player, `${p}.player`),
    kind: 'verb',
    verb: oneOf(o.verb, VERB_IDS, `${p}.verb`),
    target: nat(o.target, `${p}.target`),
  };
  const triple = (x: unknown, q: string): [number, number, number] => {
    const a = arr(x, q);
    if (a.length !== 3) fail(q, x, 'three whole numbers');
    return [int(a[0], `${q}[0]`), int(a[1], `${q}[1]`), int(a[2], `${q}[2]`)];
  };
  if (o.second !== undefined) c.second = nat(o.second, `${p}.second`);
  if (o.at !== undefined) c.at = triple(o.at, `${p}.at`);
  if (o.at2 !== undefined) c.at2 = triple(o.at2, `${p}.at2`);
  if (o.yaw !== undefined) c.yaw = int(o.yaw, `${p}.yaw`);
  if (o.pitch !== undefined) c.pitch = int(o.pitch, `${p}.pitch`);
  if (o.aim !== undefined) {
    const a = arr(o.aim, `${p}.aim`);
    if (a.length !== 2) fail(`${p}.aim`, o.aim, '[yaw, pitch]');
    c.aim = [int(a[0], `${p}.aim[0]`), int(a[1], `${p}.aim[1]`)];
  }
  if (o.charge !== undefined) c.charge = int(o.charge, `${p}.charge`);
  if (o.slot !== undefined) c.slot = int(o.slot, `${p}.slot`);
  if (o.drive !== undefined) c.drive = int(o.drive, `${p}.drive`);
  return c;
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

/**
 * A fighter record: its identity fields are checked here (the loader makes the fighter from them) and every weapon it
 * holds by value; every other field is checked by P04's Fighter.restoreRecord, which reads each through a checking
 * reader. Returned as it is (a copy is made by restoreRecord).
 */
function fighter(v: unknown, p: string): SaveV1['fighters'][number] {
  const o = obj(v, p);
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
  'paused',
  'script',
  'awareness',
  'lkp',
  'lkpTick',
  'lastSeenTick',
  'hurt',
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

/** A mind record: its keys and kinds (§6.8); P19's restoreRecord reads its fields. */
function mind(v: unknown, p: string): MindRecV1 {
  const o = exactKeys(obj(v, p), MIND_KEYS, p);
  nat(o.fighter, `${p}.fighter`);
  oneOf(o.kind, { ape: true, giantApe: true }, `${p}.kind`);
  str(o.state, `${p}.state`);
  bool(o.paused, `${p}.paused`);
  u32(o.rng, `${p}.rng`);
  for (const k of ['stateTick', 'lkpTick', 'lastSeenTick', 'homeIdx', 'routeIdx', 'restUntil', 'cooldownUntil', 'fleeUntil'] as const) int(o[k], `${p}.${k}`);
  num(o.heading, `${p}.heading`);
  arr(o.awareness, `${p}.awareness`).forEach((x, i) => pair(x, `${p}.awareness[${i}]`, nat, fin));
  nullable(o.lkp, `${p}.lkp`, v3);
  nullable(o.script, `${p}.script`, obj);
  nullable(o.hurt, `${p}.hurt`, obj);
  nullable(o.charge, `${p}.charge`, obj);
  nullable(o.path, `${p}.path`, obj);
  obj(o.stuck, `${p}.stuck`);
  nullable(o.inner, `${p}.inner`, obj);
  return o as unknown as MindRecV1;
}

/** A fighter's verb state (P14's record; its fields are P14's to check). */
function verbState(v: unknown, p: string): SaveV1['verbs'][number] {
  const o = obj(v, p);
  nat(o.fighter, `${p}.fighter`);
  return o as SaveV1['verbs'][number];
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
      const k = exactKeys(obj(x, q), ['pose', 'vy', 'grounded', 'crouched', 'enabled', 'halfHeight', 'teleport'], q);
      return {
        pose: pose3(k.pose, `${q}.pose`),
        vy: fin(k.vy, `${q}.vy`),
        grounded: bool(k.grounded, `${q}.grounded`),
        crouched: bool(k.crouched, `${q}.crouched`),
        enabled: bool(k.enabled, `${q}.enabled`),
        halfHeight: fin(k.halfHeight, `${q}.halfHeight`),
        teleport: nullable(k.teleport, `${q}.teleport`, v3),
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
    // TODO(P11): RulerBodyRecV1's exact fields; P11's RulerBodies.restoreRecord reads them.
    ruler: nullable(o.ruler, `${p}.ruler`, (x, q) => obj(x, q) as NonNullable<BodiesRecV1['ruler']>),
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

function contact(v: unknown, p: string): SaveV1['contacts'][number] {
  const o = exactKeys(obj(v, p), ['creature', 'owner', 'touching', 'episodeStart', 'cooldownUntil'], p);
  return {
    creature: nat(o.creature, `${p}.creature`),
    owner: str(o.owner, `${p}.owner`),
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
