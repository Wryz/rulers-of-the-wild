// The world serialiser (docs/M1-DESIGN.md §1.5.11, §8.3): saveRecord assembles SaveV1 from every system's toRecord()
// in id order; serializeWorld is the UTF-8 of its canonical JSON (World.step phase 19 calls it when a save is due).
//
// Every system writes its own records (entities, joints, fighters, minds, verbs, the spawner, the bodies, contacts,
// felling, deaths, navigation's dirty queue, CombatSim's own state); this file assembles them in SaveV1's key order and
// writes the few records it owns itself with explicit writers in a fixed key order:
// - commands (the pending queue, and a fighter's buffered or working verb command): a command's key order is whatever
//   its maker gave it, so it is rewritten in its type's declared order, keeping only its type's fields;
// - a ruler's RulerState, its wounds and their causes (`rulers`);
// - the tuning overrides (sim tables only: a table whose folder is "Client …" is the client's, rule 8, never saved);
// - the counters, the RNG states, the options, the queued impulses.
//
// Saved at the end of a tick (phase 19 or between steps), when nothing is pending but what the save holds: the
// command queue, the queued impulses, the dirty nav tiles (MAP gap-7 §3.8).
import type { Command, MetaCommand, MoveCommand, VerbCommand } from '../sim/commands';
import type { Fighter } from '../sim/fighter';
import { TUNING, type TuningEntry, tuningOverrides } from '../tuning/registry';
import type { ImpactCause, RulerState, V3, WoundRecord } from '../world/types';
import type { World } from '../world/world';
import { canonicalJson } from './canonical';
import {
  type BodiesRecV1,
  type FighterRecV1,
  type KccRecV1,
  type RulerBodyRecV1,
  SAVE_FORMAT,
  SAVE_FORMAT_VERSION,
  type SaveV1,
  type SlabRecV1,
  type TuningOverrideV1,
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
    impulses: w.entities.pendingImpulses().map((q) => ({ entity: q.id, j: v3(q.j), at: q.at ? v3(q.at) : null })),
    joints: w.joints.toRecord(),
    fighters: fighters.map((f) => fighterRecord(w, f)),
    minds: w.minds.toRecord(),
    verbs: w.verbs.toRecord(),
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
 * they are presentation and time effects (rule 8), and a save is the sim's state.
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

/** A command rewritten in its type's key order with only its type's fields (absent optional fields stay absent). */
export function commandRecord(c: Command): Command {
  switch (c.kind) {
    case 'move': {
      const out: MoveCommand = { tick: c.tick, player: c.player, kind: 'move', dir: c.dir, speed: c.speed };
      if (c.flags !== undefined) out.flags = c.flags;
      return out;
    }
    case 'button':
      return { tick: c.tick, player: c.player, kind: 'button', button: c.button };
    case 'verb':
      return verbCommandRecord(c);
    case 'meta':
      return metaCommandRecord(c);
  }
}

export function verbCommandRecord(c: VerbCommand): VerbCommand {
  const out: VerbCommand = { tick: c.tick, player: c.player, kind: 'verb', verb: c.verb, target: c.target };
  if (c.second !== undefined) out.second = c.second;
  if (c.at !== undefined) out.at = [c.at[0], c.at[1], c.at[2]];
  if (c.at2 !== undefined) out.at2 = [c.at2[0], c.at2[1], c.at2[2]];
  if (c.yaw !== undefined) out.yaw = c.yaw;
  if (c.pitch !== undefined) out.pitch = c.pitch;
  if (c.aim !== undefined) out.aim = [c.aim[0], c.aim[1]];
  if (c.charge !== undefined) out.charge = c.charge;
  if (c.slot !== undefined) out.slot = c.slot;
  if (c.drive !== undefined) out.drive = c.drive;
  return out;
}

function metaCommandRecord(c: MetaCommand): MetaCommand {
  const out: MetaCommand = { tick: c.tick, player: c.player, kind: 'meta', meta: c.meta };
  if (c.seconds !== undefined) out.seconds = c.seconds;
  if (c.dev !== undefined) {
    const d = c.dev;
    out.dev = { op: d.op, args: [...d.args] };
    if (d.tuning !== undefined) out.dev.tuning = { table: d.tuning.table, key: d.tuning.key, value: d.tuning.value };
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
