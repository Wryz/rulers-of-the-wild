// The world serialiser (docs/M1-DESIGN.md §1.5.11, §8.3): saveRecord assembles SaveV1 from every system's toRecord()
// in id order; serializeWorld is the UTF-8 of its canonical JSON (World.step phase 19 calls it when a save is due).
//
// Every system writes its own records (entities, joints, fighters, minds, verbs, the spawner, the bodies, contacts,
// felling, deaths, navigation's dirty queue, CombatSim's own state); this file assembles them in SaveV1's key order and
// writes the few records it owns itself with explicit writers in a fixed key order:
// - commands (the pending queue, a fighter's buffered or working verb command, the command of a continuous verb that is
//   on in the verb state): a command's key order is whatever its maker gave it, so it is rewritten in its type's
//   declared order, keeping only its type's fields (the key lists are checked against the command types when compiled,
//   so a field added to a type can't be left out; load.ts reads the same lists);
// - a ruler's RulerState, its wounds and their causes (`rulers`);
// - the tuning overrides (sim tables only: a table whose folder is "Client …" belongs to the client's presentation and
//   game loop, rules 6 and 8, and is never saved);
// - the counters, the RNG states, the options, the queued impulses (those whose entity still exists: phase 4d drops the
//   others).
//
// A fighter driven by a brain that isn't a creature mind (a DungeonStyle BrawlerAI added by hand) is refused: a world
// makes players and creatures only, and the save holds a brain only as a mind (§6.8; minds[].inner for the ape's).
// TODO(M3): a save of a test world with DungeonStyle enemies, if one is ever needed.
//
// Saved at the end of a tick (phase 19 or between steps), when nothing is pending but what the save holds: the
// command queue, the queued impulses, the dirty nav tiles (MAP gap-7 §3.8).
import type { ButtonCommand, Command, MetaCommand, MoveCommand, TuningEdit, VerbCommand } from '../sim/commands';
import type { Fighter } from '../sim/fighter';
import { TUNING, type TuningEntry, tuningOverrides } from '../tuning/registry';
import type { ImpactCause, RulerState, V3, WoundRecord } from '../world/types';
import type { VerbStateRecord } from '../world/verbs/index';
import type { World } from '../world/world';
import { canonicalJson } from './canonical';
import {
  type BodiesRecV1,
  type FighterRecV1,
  type ImpulseRecV1,
  type KccRecV1,
  type RulerBodyRecV1,
  SAVE_FORMAT,
  SAVE_FORMAT_VERSION,
  type SaveV1,
  type SlabRecV1,
  type TuningOverrideV1,
  type VerbStateRecV1,
} from './schema';

/** Assembles the whole world's save record (SaveV1, in its key order). */
export function saveRecord(w: World): SaveV1 {
  if (w.isDisposed) throw new Error('saveRecord: the world was disposed');
  const sim = w.combat;
  const c = sim.toRecord();
  const fighters = sim.fighters;
  const byId = [...fighters].sort((a, b) => a.id - b.id);
  for (const f of byId) {
    const brain = sim.ais.get(f);
    // A world's fighters are players (no brain) and creatures (a creature mind, which saves its inner BrawlerAI).
    if (brain && w.minds.get(f) !== brain) {
      throw new Error(`saveRecord: fighter ${f.id} is driven by a brain that isn't a creature mind; the save holds only minds (§6.8)`);
    }
  }
  const kcc = byFighter(w.kcc.toRecord().map((r): [number, KccRecV1] => [r.fighter, r.kcc]));
  const slabs = byFighter(w.downed.toRecord().map((r): [number, SlabRecV1] => [r.fighter, r.slab]));
  const rulerBodies = byFighter(w.rulers.toRecord().map((r): [number, RulerBodyRecV1] => [r.fighter, r.ruler]));
  const o = w.options;
  return {
    format: SAVE_FORMAT,
    formatVersion: SAVE_FORMAT_VERSION,
    seed: w.seed,
    options: { scene: o.scene, terrain: o.terrain, size: o.size, player: o.player, sparringApe: o.sparringApe },
    tick: w.tick,
    tuningOverrides: savedTuningOverrides(),
    counters: {
      fighter: w.ids.fighter.next,
      entity: w.ids.entity.next,
      joint: w.ids.joint.next,
      wound: w.ids.wound.next,
      dropSerial: c.dropSerial,
      projSerial: c.projSerial,
    },
    rng: {
      combat: c.rng,
      world: w.rngs.world.state,
      fighters: byId.map((f): [number, number] => [f.id, f.rngState]),
      minds: byId.flatMap((f): [number, number][] => {
        const m = w.minds.get(f);
        return m ? [[f.id, m.rng.state]] : [];
      }),
    },
    director: sim.director.toRecord(),
    pending: c.pending.map(commandRecord),
    terrain: w.terrain.edits().map((e) => ({ tile: e.tile, vertex: e.vertex, dh: e.dh })),
    dug: w.terrain.dugVertices(),
    cover: w.cover.edits().map(([cell, v]): [number, number] => [cell, v]),
    entities: w.entities.toRecord(),
    removed: w.entities.removedGenerated(),
    impulses: savedImpulses(w),
    joints: w.joints.toRecord(),
    fighters: fighters.map((f) => fighterRecord(w, f)),
    minds: w.minds.toRecord(),
    verbs: w.verbs.toRecord().map(verbStateRecord),
    spawner: w.spawner.toRecord(),
    drops: c.drops,
    projectiles: c.projectiles,
    prevBlade: c.prevBlade,
    bodies: byId.map(
      (f): BodiesRecV1 => ({
        fighter: f.id,
        kcc: kcc.get(f.id) ?? null,
        zonesHistory: w.zones.historyRecord(f),
        slab: slabs.get(f.id) ?? null,
        ruler: rulerBodies.get(f.id) ?? null,
      }),
    ),
    rulers: byId.flatMap((f): [number, RulerState][] => (f.ruler ? [[f.id, rulerRecord(f.ruler, `fighter ${f.id}'s ruler`)]] : [])),
    contacts: w.contacts.toRecord(),
    contactGrace: w.contacts.graceRecord(),
    felling: w.felling.toRecord(),
    deaths: w.deaths.deathsRecord(),
    corpses: w.deaths.corpsesRecord(),
    navDirty: w.nav ? w.nav.dirtyQueue() : [],
  };
}

/**
 * The queued impulses whose entity is still in the world, in queue order. The store keeps an impulse queued for an
 * entity removed after it was queued (a contact reaction of phase 9 on an entity that phase 10 then breaks, a strike's
 * push followed by a cut), and phase 4d drops it; so does the save, which changes nothing the world will do, and a load
 * never has to queue an impulse on an entity it doesn't have.
 */
function savedImpulses(w: World): ImpulseRecV1[] {
  return w.entities
    .pendingImpulses()
    .filter((q) => w.entities.get(q.id) !== undefined)
    .map((q) => ({ entity: q.id, j: v3(q.j), at: q.at ? v3(q.at) : null }));
}

/** UTF-8 of canonicalJson(saveRecord(w)). */
export function serializeWorld(w: World): Uint8Array {
  return new TextEncoder().encode(canonicalJson(saveRecord(w)));
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** A client table (its panel folder is "Client" or "Client › …"): the game loop's, the camera's, never the sim's. */
export function isClientTuning(e: Pick<TuningEntry, 'folder'>): boolean {
  return e.folder === 'Client' || e.folder.startsWith('Client ');
}

/**
 * The tuning values that differ from their registered defaults, sorted (table, key), the client's tables left out:
 * they are presentation and the game loop's time effects (rules 6 and 8), and a save is the sim's state.
 */
export function savedTuningOverrides(): TuningOverrideV1[] {
  const client = new Set(TUNING.filter(isClientTuning).map((e) => e.name));
  return tuningOverrides()
    .filter((o) => !client.has(o.table))
    .map((o) => ({ table: o.table, key: o.key, value: o.value }));
}

// ---------------------------------------------------------------------------
// Commands, in their type's declared key order
// ---------------------------------------------------------------------------

/** The keys of T that a list of T's keys leaves out. */
type MissingKeys<T, K extends readonly PropertyKey[]> = Exclude<keyof T, K[number]>;

/**
 * Every key of T, in T's declared order, checked when compiled: a key T has and the list lacks is a type error naming it
 * (`missingKey`). So a field added to a command type can't compile without being written to the save (an optional field
 * left out of a hand-written literal would compile and be dropped silently), and the loader reads the same lists.
 */
export function keysOf<T>() {
  return <const K extends readonly (keyof T)[]>(keys: K & ([MissingKeys<T, K>] extends [never] ? unknown : { missingKey: MissingKeys<T, K> })): K => keys;
}

/** T's required (non-optional) keys. */
type RequiredKeys<T> = { [P in keyof T]-?: Record<never, never> extends Pick<T, P> ? never : P }[keyof T];
/** The required keys of T that a list leaves out. */
type MissingRequired<T, K extends readonly PropertyKey[]> = Exclude<RequiredKeys<T>, K[number]>;

/** The keys a record of T must have (exactly T's required ones), checked when compiled in the same way. */
export function requiredKeysOf<T>() {
  return <const K extends readonly RequiredKeys<T>[]>(keys: K & ([MissingRequired<T, K>] extends [never] ? unknown : { missingKey: MissingRequired<T, K> })): K => keys;
}

type DevRecord = NonNullable<MetaCommand['dev']>;

export const MOVE_KEYS = keysOf<MoveCommand>()(['tick', 'player', 'kind', 'dir', 'speed', 'flags']);
export const MOVE_REQUIRED = requiredKeysOf<MoveCommand>()(['tick', 'player', 'kind', 'dir', 'speed']);
export const BUTTON_KEYS = keysOf<ButtonCommand>()(['tick', 'player', 'kind', 'button']);
export const BUTTON_REQUIRED = requiredKeysOf<ButtonCommand>()(['tick', 'player', 'kind', 'button']);
export const VERB_KEYS = keysOf<VerbCommand>()(['tick', 'player', 'kind', 'verb', 'target', 'second', 'at', 'at2', 'yaw', 'pitch', 'aim', 'charge', 'slot', 'drive']);
export const VERB_REQUIRED = requiredKeysOf<VerbCommand>()(['tick', 'player', 'kind', 'verb', 'target']);
export const META_KEYS = keysOf<MetaCommand>()(['tick', 'player', 'kind', 'meta', 'seconds', 'dev']);
export const META_REQUIRED = requiredKeysOf<MetaCommand>()(['tick', 'player', 'kind', 'meta']);
export const DEV_KEYS = keysOf<DevRecord>()(['op', 'args', 'tuning']);
export const DEV_REQUIRED = requiredKeysOf<DevRecord>()(['op', 'args']);
export const TUNING_EDIT_KEYS = keysOf<TuningEdit>()(['table', 'key', 'value']);

/**
 * The fields of `c` named in `keys`, in that order; an absent (undefined) one stays absent, a field outside the list (not
 * in the type: the lists are checked against it) is left out, and a flat array (a point, an aim, dev args) is copied.
 */
function ordered<T extends object>(c: T, keys: readonly (keyof T)[]): T {
  const out: Partial<T> = {};
  for (const k of keys) {
    const v = c[k];
    if (v !== undefined) out[k] = (Array.isArray(v) ? [...v] : v) as T[keyof T];
  }
  return out as T;
}

/** A command rewritten in its type's key order with only its type's fields (absent optional fields stay absent). */
export function commandRecord(c: Command): Command {
  switch (c.kind) {
    case 'move':
      return ordered(c, MOVE_KEYS);
    case 'button':
      return ordered(c, BUTTON_KEYS);
    case 'verb':
      return verbCommandRecord(c);
    case 'meta':
      return metaCommandRecord(c);
  }
}

export function verbCommandRecord(c: VerbCommand): VerbCommand {
  return ordered(c, VERB_KEYS);
}

function metaCommandRecord(c: MetaCommand): MetaCommand {
  const out = ordered(c, META_KEYS);
  if (c.dev !== undefined) {
    const dev = ordered(c.dev, DEV_KEYS);
    if (c.dev.tuning !== undefined) dev.tuning = ordered(c.dev.tuning, TUNING_EDIT_KEYS);
    out.dev = dev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fighters
// ---------------------------------------------------------------------------

/** P04's record, with the verb commands it holds in their canonical key order. */
function fighterRecord(w: World, f: Fighter): FighterRecV1 {
  const r = f.toRecord(w.combat.drops);
  if (r.work?.cmd) r.work.cmd = verbCommandRecord(r.work.cmd);
  if (r.verbRequest) r.verbRequest.cmd = verbCommandRecord(r.verbRequest.cmd);
  return r;
}

/** P14's record (toRecord's own copy), with a continuous verb's command in its canonical key order, as a fighter's. */
function verbStateRecord(r: VerbStateRecV1): VerbStateRecV1 {
  const rec = r as VerbStateRecord;
  if (rec.cont) rec.cont.cmd = verbCommandRecord(rec.cont.cmd);
  return rec;
}

// ---------------------------------------------------------------------------
// Rulers: RulerState, its wounds and their causes, in their types' key order
// ---------------------------------------------------------------------------

const RULER_KEYS = [
  'maxHp',
  'unhealed',
  'wounds',
  'pinned',
  'pinnedKg',
  'unpinTicks',
  'stuck',
  'burning',
  'inPit',
  'downWound',
  'downCause',
  'lastWorldTrip',
  'deflectedHeading',
  'pendingTrip',
] as const satisfies readonly (keyof RulerState)[];
const WOUND_KEYS = ['id', 'zone', 'bone', 'local', 'severe', 'effect', 'hp', 'remaining', 'cause', 'tick', 'credit'] as const satisfies readonly (keyof WoundRecord)[];
const CAUSE_KEYS = ['kind', 'entityId', 'fighterId', 'credit', 'held', 'feature'] as const satisfies readonly (keyof ImpactCause)[];

/**
 * A copy of a RulerState in its type's key order. The literals below are typed, so a field added to the type fails to
 * compile here until it is written; a field on a live object that the type doesn't have throws (it would be lost).
 */
export function rulerRecord(r: RulerState, at: string): RulerState {
  onlyKeys(r, RULER_KEYS, at);
  return {
    maxHp: r.maxHp,
    unhealed: r.unhealed,
    wounds: r.wounds.map((x, i) => woundRecord(x, `${at}.wounds[${i}]`)),
    pinned: r.pinned,
    pinnedKg: r.pinnedKg,
    unpinTicks: r.unpinTicks,
    stuck: r.stuck,
    burning: r.burning,
    inPit: r.inPit,
    downWound: r.downWound,
    downCause: r.downCause ? causeRecord(r.downCause, `${at}.downCause`) : null,
    lastWorldTrip: r.lastWorldTrip
      ? { tick: r.lastWorldTrip.tick, cause: r.lastWorldTrip.cause ? causeRecord(r.lastWorldTrip.cause, `${at}.lastWorldTrip.cause`) : null }
      : null,
    deflectedHeading: r.deflectedHeading,
    pendingTrip: r.pendingTrip
      ? { why: r.pendingTrip.why, tick: r.pendingTrip.tick, cause: r.pendingTrip.cause ? causeRecord(r.pendingTrip.cause, `${at}.pendingTrip.cause`) : null }
      : null,
  };
}

function woundRecord(x: WoundRecord, at: string): WoundRecord {
  onlyKeys(x, WOUND_KEYS, at);
  return {
    id: x.id,
    zone: x.zone,
    bone: x.bone,
    local: v3(x.local),
    severe: x.severe,
    effect: x.effect,
    hp: x.hp,
    remaining: x.remaining,
    cause: causeRecord(x.cause, `${at}.cause`),
    tick: x.tick,
    credit: [...x.credit],
  };
}

function causeRecord(c: ImpactCause, at: string): ImpactCause {
  onlyKeys(c, CAUSE_KEYS, at);
  return { kind: c.kind, entityId: c.entityId, fighterId: c.fighterId, credit: [...c.credit], held: c.held, feature: c.feature };
}

function onlyKeys(o: object, keys: readonly string[], at: string): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) throw new Error(`saveRecord: ${at} has a field the save doesn't write: ${k} (add it to save/serialize.ts and save/load.ts)`);
  }
}

// ---------------------------------------------------------------------------

function v3(v: Readonly<V3>): V3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** A per-fighter list (by fighter id) as a map; a fighter listed twice is a writer bug. */
function byFighter<T>(pairs: [number, T][]): Map<number, T> {
  const m = new Map<number, T>();
  for (const [id, r] of pairs) {
    if (m.has(id)) throw new Error(`saveRecord: fighter ${id} has two records of one body kind`);
    m.set(id, r);
  }
  return m;
}
