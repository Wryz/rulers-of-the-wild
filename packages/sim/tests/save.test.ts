// P13, the save (docs/M1-DESIGN.md §8, §1.5.11, §13.1): saveRecord / serializeWorld, bodyStateBytes (AC-7's body bytes),
// loadWorld and migrate.
//
// - The save: SaveV1's keys in order; the options, tick, counters, RNG streams and per-fighter lists; the client's
//   tuning tables left out; commands rewritten in their type's key order; `meta 'save'` writes at the end of its tick;
//   a brain that isn't a creature mind, or a RulerState field the writer doesn't know, is refused.
// - Determinism (an AC-7 preview): two worlds from one seed fed one command log give byte-identical saves and
//   bit-identical body bytes every 60 ticks, run one after the other (after an unrelated world) and interleaved.
// - Completeness (RR-19): every runtime field of every world system is saved (with its place in the save) or listed
//   with the reason it isn't, and every key of the save has a source. A system that adds a field fails here until the
//   field is placed in the inventory below (and, if it is state, in its record).
// - save → load → save is byte-identical for the M1 loader's scope (entities, joints, terrain with the dug mask, rulers)
//   and for everything else the loader restores exactly (fighters, CombatSim's state, counters, streams, commands,
//   impulses …); the loaded world continues: pending commands land at their ticks, two loads of one save stay
//   bit-identical to each other.
// - A world at rest, saved and loaded, matches the original within 1 cm and 1° over 10 s (an M3 preview, SPEC:730).
// - Tuning: loadWorld leaves the registry alone unless applyTuning; a failed load puts it back.
// - The v1 fixture (tests/fixtures/save-v1.json) loads, so M3's migrations have a v1 to start from. To rewrite it after a
//   deliberate format change (bump formatVersion and add a migration instead once saves exist in the wild):
//     ROTW_WRITE_SAVE_FIXTURE=1 npx vitest run packages/sim/tests/save.test.ts
// - Broken saves are refused with a `save record:` error naming the field, before a world is built.
//
// Scene numbers (sizes, masses, positions, ticks) are test constants, never tuning (§9).
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BONES } from '../src/body/skeleton';
import { canonicalJson, parseCanonicalJson } from '../src/save/canonical';
import { bodyStateBytes } from '../src/save/bodyState';
import { loadWorld, migrate, readSave } from '../src/save/load';
import { SAVE_V1_KEYS, type SaveV1 } from '../src/save/schema';
import { commandRecord, saveRecord, serializeWorld } from '../src/save/serialize';
import { type Command, moveCommand, setTuningCommand, type VerbCommand } from '../src/sim/commands';
import { IdCounter, LEGACY_IDS } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { createBrawler } from '../src/sim/roster';
import { defineTuning, getTuningValue, resetTuning, setTuningValue, tuningSnapshot } from '../src/tuning/registry';
import { spawnBox, spawnGrass, spawnLog, spawnRopeCoil, spawnStick, spawnStone } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Quat, RulerState, V3 } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

/** Rapier worlds and a few hundred ticks: explicit time limits (§11's convention), generous for a loaded machine. */
vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
const track = (w: World): World => {
  live.push(w);
  return w;
};
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  return track(await createWorld({ seed: 20261017, scene: 'empty', nav: 'off', size: 50, ...o }));
}
async function load(bytes: Uint8Array, o: { nav?: 'full' | 'off'; applyTuning?: boolean } = {}): Promise<World> {
  return track(await loadWorld(bytes, { nav: 'off', ...o }));
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

// A client table (folder "Client › …"): the save never holds it.
const CLIENT_TEST_TUNING = defineTuning('ZZ_CLIENT_TEST_TUNING', 'Client › save test', { knob: 1 }, { knob: { unit: '—', source: 'test' } });

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const UPRIGHT: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Entities of every body kind, a dug hole with its spoil, resting a while. Returns the ids by name. */
function populate(w: World): Record<string, number> {
  const ids: Record<string, number> = {};
  ids.log = spawnLog(w, { p: { x: 2, y: 0.2, z: 1 }, length: 2, r: 0.1 });
  ids.stone = spawnStone(w, { p: { x: -2, y: 0.3, z: 1 }, mass: 3 });
  ids.crate = spawnBox(w, { p: { x: 0, y: 0.5, z: -3 }, size: [1, 1, 1], material: 'dryWood', state: 'fixed', look: 'crate' });
  ids.stake = spawnLog(w, { p: { x: 3, y: 0.3, z: -2 }, q: UPRIGHT, length: 1, r: 0.04, state: 'anchored' });
  ids.grass = spawnGrass(w, { p: { x: -3, y: 0.2, z: -1 }, mass: 2 });
  ids.coil = spawnRopeCoil(w, { at: { x: 1, y: 0.2, z: 3 }, material: 'vine', lengthM: 5 });
  ids.held = spawnStick(w, { p: { x: -1, y: 0.2, z: -2 }, length: 1, r: 0.02, sharp: { end: 1, s: 0.6 } });
  ids.stowed = spawnStick(w, { p: { x: -1.5, y: 0.2, z: 2 }, length: 0.6, r: 0.015 });
  w.entities.setState(w.entities.get(ids.held)!, 'held');
  w.entities.setState(w.entities.get(ids.stowed)!, 'stowed');
  // A hole and its spoil, away from everything.
  for (let k = 0; k < 6; k++) w.terrain.lower(-6, 6, 1);
  w.terrain.raise(-8, 8, 0.05);
  return ids;
}

/** A command log: move noise for player 1 from its own Rng, a punch now and then. */
function commandsFor(tick: number, rng: Rng): Command[] {
  const out: Command[] = [];
  if (tick % 7 === 1) out.push(moveCommand(tick, 1, rng.range(-1, 1), rng.range(-1, 1)));
  if (tick % 53 === 0) out.push({ tick, player: 1, kind: 'button', button: rng.next() < 0.5 ? 'lpunch' : 'rkick' });
  return out;
}

/** Lets the worker answer Vitest between long stretches of stepping (a loaded machine times its RPC out otherwise). */
const yieldNow = (): Promise<void> => new Promise((res) => setImmediate(res));

/** Steps `n` ticks feeding the command log (pushed for the tick about to run). */
function run(w: World, n: number, rng: Rng): void {
  for (let i = 0; i < n; i++) {
    for (const c of commandsFor(w.tick + 1, rng)) w.commands.push(c);
    w.step();
  }
}

/** A hand-made RulerState with a wound, causes and a pending trip (every nullable field filled). */
function rulerSample(): RulerState {
  const cause = { kind: 'entity' as const, entityId: 4, fighterId: null, credit: ['p1'], held: false, feature: 'sharpPoint' as const };
  return {
    maxHp: 4000,
    unhealed: 12.5,
    wounds: [{ id: 1, zone: 'belly', bone: 'abdomen', local: { x: 0.1, y: -0, z: 0.2 }, severe: true, effect: 'winded', hp: 300, remaining: 280.25, cause, tick: 40, credit: ['p1'] }],
    pinned: true,
    pinnedKg: 320,
    unpinTicks: 3,
    stuck: false,
    burning: false,
    inPit: true,
    downWound: 1,
    downCause: { ...cause, credit: [...cause.credit] },
    lastWorldTrip: { tick: 39, cause: null },
    deflectedHeading: -0.5,
    pendingTrip: { why: 'cover', tick: 41, cause: { kind: 'terrain', entityId: null, fighterId: null, credit: [], held: false, feature: 'fall' } },
  };
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const parsed = (bytes: Uint8Array): Record<string, unknown> => parseCanonicalJson(text(bytes)) as Record<string, unknown>;

/** One section of a save as canonical text (what save → load → save compares). */
function sections(bytes: Uint8Array, keys: readonly string[]): Record<string, string> {
  const s = parsed(bytes);
  return Object.fromEntries(keys.map((k) => [k, canonicalJson(s[k])]));
}

/** A save record edited, back as bytes. */
function edited(bytes: Uint8Array, edit: (s: Record<string, unknown>) => void): Uint8Array {
  const s = parsed(bytes);
  edit(s);
  return bytesOf(canonicalJson(s));
}

/** The first byte where two byte arrays differ, or -1. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

describe('saveRecord', () => {
  it("writes SaveV1's keys in order, with the world's options, tick, counters and streams", async () => {
    const w = await make({ size: 60 });
    const ids = populate(w);
    run(w, 30, new Rng(99));
    const s = saveRecord(w);
    expect(Object.keys(s)).toEqual([...SAVE_V1_KEYS]);
    expect(s.format).toBe('rotw-world');
    expect(s.formatVersion).toBe(1);
    expect(s.seed).toBe(20261017);
    expect(s.options).toEqual({ scene: 'empty', terrain: 'flat', size: 60, player: true, sparringApe: false });
    expect(s.tick).toBe(30);
    expect(s.counters).toEqual({ fighter: 2, entity: ids.stowed + 1, joint: 1, wound: 1, dropSerial: 0, projSerial: 0 });
    expect(s.rng.combat).toBe(w.combat.rng.state);
    expect(s.rng.world).toBe(w.rngs.world.state);
    expect(s.rng.fighters).toEqual([[1, w.player!.rngState]]);
    expect(s.rng.minds).toEqual([]);
    expect(s.director).toEqual({ lastAttack: -999 });
    // Every entity is non-generated here, so every one is saved, in id order; the dug hole and its spoil are edits.
    expect(s.entities.map((e) => e.id)).toEqual(Object.values(ids).sort((a, b) => a - b));
    expect(s.entities.find((e) => e.id === ids.held)!.state).toBe('held');
    expect(s.removed).toEqual([]);
    expect(s.terrain.length).toBeGreaterThan(10);
    expect(s.terrain.some((e) => e.dh < 0) && s.terrain.some((e) => e.dh > 0)).toBe(true);
    expect(s.dug.length).toBeGreaterThan(0);
    expect(s.dug).toEqual([...s.dug].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    expect(s.fighters).toEqual([w.player!.toRecord(w.combat.drops)]);
    expect(s.bodies).toEqual([{ fighter: 1, kcc: s.bodies[0].kcc, zonesHistory: s.bodies[0].zonesHistory, slab: s.bodies[0].slab, ruler: null }]);
    expect(s.rulers).toEqual([]);
    expect(s.spawner).toEqual(w.spawner.toRecord());
    // The text is the canonical JSON of the record, as UTF-8.
    expect(text(serializeWorld(w))).toBe(canonicalJson(s));
  });

  it('keeps the sim tables\' overrides, sorted, and leaves the client\'s out', async () => {
    const w = await make();
    setTuningValue('WORLD_TUNING', 'corpseDespawnS', 90);
    setTuningValue('PHYSICS_TUNING', 'restTicks', 31);
    setTuningValue('WORLD_TUNING', 'aiNearM', Infinity);
    CLIENT_TEST_TUNING.knob = 2;
    expect(saveRecord(w).tuningOverrides).toEqual([
      { table: 'PHYSICS_TUNING', key: 'restTicks', value: 31 },
      { table: 'WORLD_TUNING', key: 'aiNearM', value: Infinity },
      { table: 'WORLD_TUNING', key: 'corpseDespawnS', value: 90 },
    ]);
    expect(text(serializeWorld(w))).toContain('{"table":"WORLD_TUNING","key":"aiNearM","value":"$inf"}');
    resetTuning('ZZ_CLIENT_TEST_TUNING');
  });

  it("writes commands in their type's key order whatever order their maker gave, dropping fields they don't have", () => {
    const messy = { speed: 128, kind: 'move', dir: 3, player: 1, tick: 9, junk: true } as unknown as Command;
    expect(canonicalJson(commandRecord(messy))).toBe('{"tick":9,"player":1,"kind":"move","dir":3,"speed":128}');
    const verb = { drive: 1, at: [1, -2, 3], target: 5, verb: 'place', kind: 'verb', player: 1, tick: 4, yaw: 64, pitch: undefined } as unknown as Command;
    expect(canonicalJson(commandRecord(verb))).toBe('{"tick":4,"player":1,"kind":"verb","verb":"place","target":5,"at":[1,-2,3],"yaw":64,"drive":1}');
    const tune = setTuningCommand(2, 1, 'WORLD_TUNING', 'aiNearM', -Infinity);
    expect(canonicalJson(commandRecord(tune))).toBe('{"tick":2,"player":1,"kind":"meta","meta":"dev","dev":{"op":"setTuning","args":[],"tuning":{"table":"WORLD_TUNING","key":"aiNearM","value":"$-inf"}}}');
  });

  it('writes the pending queue and a fighter\'s buffered verb in canonical order', async () => {
    const w = await make();
    w.commands.push({ speed: 64, dir: 10, kind: 'move', player: 1, tick: w.tick + 3 } as Command);
    const cmd = { target: 0, verb: 'dig', kind: 'verb', player: 1, tick: 1, at: [100, 0, 200] } as VerbCommand;
    w.player!.verbRequest = { cmd, frames: 6 };
    const s = saveRecord(w);
    expect(Object.keys(s.pending[0])).toEqual(['tick', 'player', 'kind', 'dir', 'speed']);
    expect(Object.keys(s.fighters[0].verbRequest!.cmd)).toEqual(['tick', 'player', 'kind', 'verb', 'target', 'at']);
    // The fighter keeps its own command object as it was.
    expect(Object.keys(w.player!.verbRequest.cmd)[0]).toBe('target');
  });

  it("writes `meta 'save'`'s bytes at the end of its tick, the same as serializeWorld then", async () => {
    const w = await make();
    populate(w);
    run(w, 10, new Rng(3));
    w.commands.push({ tick: w.tick + 1, player: 1, kind: 'meta', meta: 'save' });
    const r = w.step();
    expect(r.save).not.toBeNull();
    expect(text(r.save!)).toBe(text(serializeWorld(w)));
    expect(parsed(r.save!).tick).toBe(11);
    expect(w.step().save).toBeNull();
  });

  it('refuses a fighter driven by a brain that is not a creature mind (a world makes none)', async () => {
    const w = await make();
    const { fighter, ai } = createBrawler(w.combat.rng, {}, { ids: w.ids.fighter, rngSeed: 5 });
    w.addFighter(fighter, ai);
    expect(() => serializeWorld(w)).toThrow(/fighter 2 is driven by a brain that isn't a creature mind/);
  });

  it('refuses a RulerState field the writer does not write (it would be lost)', async () => {
    const w = await make();
    w.player!.ruler = { ...rulerSample(), novelty: 1 } as unknown as RulerState;
    expect(() => saveRecord(w)).toThrow("fighter 1's ruler has a field the save doesn't write: novelty");
    w.player!.ruler = null;
  });
});

// ---------------------------------------------------------------------------
// Determinism (an AC-7 preview, §8.2, §11.7)
// ---------------------------------------------------------------------------

describe('determinism', () => {
  /** A scene and a command log: the save and the body bytes every 60 ticks. */
  async function checkpoints(seed: number, ticks: number): Promise<{ save: string; body: Uint8Array }[]> {
    const w = await make({ seed });
    populate(w);
    const out: { save: string; body: Uint8Array }[] = [];
    const rng = new Rng(99);
    for (let i = 0; i < ticks; i++) {
      run(w, 1, rng);
      if (w.tick % 60 === 0) {
        out.push({ save: text(serializeWorld(w)), body: bodyStateBytes(w) });
        await yieldNow();
      }
    }
    w.dispose();
    return out;
  }

  it('two runs of one seed and one command log match every 60 ticks (after an unrelated world)', async () => {
    const legacy = LEGACY_IDS.next;
    await checkpoints(6, 120); // world C: catches module-level leaks a plain "run twice" misses
    const a = await checkpoints(20261017, 600);
    const b = await checkpoints(20261017, 600);
    expect(a.length).toBe(10);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].save === a[i].save, `save at checkpoint ${i}`).toBe(true);
      expect(firstDiff(a[i].body, b[i].body), `body bytes at checkpoint ${i}`).toBe(-1);
    }
    // Something moved between checkpoints (the comparison isn't of a frozen world).
    expect(a[0].save).not.toBe(a[9].save);
    expect(firstDiff(a[0].body, a[9].body)).not.toBe(-1);
    expect(LEGACY_IDS.next).toBe(legacy);
  });

  it('two worlds stepped tick by tick, interleaved, match every 60 ticks', async () => {
    const w1 = await make();
    const w2 = await make();
    populate(w1);
    populate(w2);
    const r1 = new Rng(99);
    const r2 = new Rng(99);
    for (let i = 0; i < 360; i++) {
      run(w1, 1, r1);
      run(w2, 1, r2);
      if (w1.tick % 60 === 0) {
        expect(text(serializeWorld(w1)) === text(serializeWorld(w2))).toBe(true);
        expect(firstDiff(bodyStateBytes(w1), bodyStateBytes(w2))).toBe(-1);
        await yieldNow();
      }
    }
  });

  it('body bytes: every body (tagged by owner), then each fighter, then the sim Rng; another seed differs', async () => {
    const w = await make();
    const ids = populate(w);
    run(w, 5, new Rng(1));
    const b = bodyStateBytes(w);
    const withBody = w.entities.all().filter((e) => e.body).length;
    expect(withBody).toBe(Object.keys(ids).length - 1); // the stowed stick has no body
    const entityBlock = 1 + 4 + 13 * 4;
    // The player's bodies: its controller's capsule, its zone body and its (disabled) slab.
    const partBlock = 1 + 4 + 1 + 13 * 4;
    const fighterBlock = 1 + 4 + 14 * 8 + 12 * 7 * 8;
    expect(b.length).toBe(withBody * entityBlock + 3 * partBlock + fighterBlock + 1 + 8);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(dv.getUint8(0)).toBe(1);
    expect(dv.getUint32(1, true)).toBe(ids.log);
    expect(dv.getFloat64(b.length - 8, true)).toBe(w.combat.rng.state);
    const parts = withBody * entityBlock;
    for (let i = 0; i < 3; i++) {
      const at = parts + i * partBlock;
      expect([dv.getUint8(at), dv.getUint32(at + 1, true), dv.getUint8(at + 5)]).toEqual([2, 1, i]);
    }
    const capsule = w.kcc.capsulePose(w.player!)!;
    expect(dv.getFloat32(parts + 6, true)).toBe(capsule.p.x);
    const f = parts + 3 * partBlock;
    expect([dv.getUint8(f), dv.getUint32(f + 1, true), dv.getFloat64(f + 5, true)]).toEqual([5, 1, w.player!.pos.x]);
    const other = await make({ seed: 7 });
    populate(other);
    run(other, 5, new Rng(1));
    expect(firstDiff(b, bodyStateBytes(other))).not.toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Completeness (RR-19)
// ---------------------------------------------------------------------------

/**
 * Every runtime field of every world system: `saved: <where in the save>`, `system: <inventory entry>` (a field that
 * holds a system inventoried below) or `not saved: <why>`. A system that adds a field fails the test until it is
 * listed here; one that is state is saved by its system's record and listed with its place.
 */
const INVENTORY: Record<string, Record<string, string>> = {
  World: {
    seed: 'saved: seed',
    options: 'saved: options (all but nav, a load option)',
    ids: 'system: ids',
    rngs: 'system: WorldRngs',
    physics: 'system: PhysicsWorld',
    queries: 'system: WorldQueries',
    terrain: 'system: Terrain',
    cover: 'system: GroundCover',
    entities: 'system: EntityStore',
    joints: 'system: JointStore',
    breaking: 'system: Breaking',
    loads: 'system: Loads',
    felling: 'system: Felling',
    combat: 'system: CombatSim',
    kcc: 'system: CharacterControllers',
    zones: 'system: ZoneBodies',
    downed: 'system: DownedBodies',
    rulers: 'system: RulerBodies',
    contacts: 'system: ContactSystem',
    deaths: 'system: Deaths',
    verbs: 'system: VerbSystem',
    minds: 'system: MindRegistry',
    noise: 'system: NoiseBus',
    spawner: 'system: Spawner',
    nav: 'system: NavSystem',
    commands: 'not saved: combat.commands itself (its queue is saved as pending)',
    events: 'not saved: this tick\'s events, cleared at the start of every step',
    player: "not saved: player 1's fighter, found again from the fighters' playerId",
    players: "not saved: player number → fighter, rebuilt from the fighters' playerId",
    mover: 'not saved: code (dispatches to the controllers or the ruler mover)',
    ground: 'not saved: code (terrain heights and supportAt)',
    spawnData: "not saved: generation's output, regenerated from the seed",
    saveDue: 'not saved: set in phase 1c and used in phase 19 of the same tick',
    disposed: 'not saved: false for a live world',
    beforeBodySync: 'not saved: true only inside a step (phases 1-3)',
  },
  ids: {
    fighter: 'saved: counters.fighter',
    entity: 'saved: counters.entity',
    joint: 'saved: counters.joint',
    wound: 'saved: counters.wound',
  },
  WorldRngs: {
    worldSeed: 'saved: seed',
    world: 'saved: rng.world',
    gen: "not saved: generation's stream, used at creation only (a load regenerates)",
    combatRng: 'saved: rng.combat (=== combat.rng)',
    minds: 'saved: rng.minds',
  },
  PhysicsWorld: {
    rapier: 'not saved: the Rapier world, rebuilt from the records (entities, joints, bodies)',
    events: 'not saved: drained every tick (phase 8)',
    forceEventCount: 'not saved: a dev counter of the last drain',
    owners: 'not saved: collider handles → owners, rebuilt with the colliders',
    keys: 'not saved: collider handles → owner keys, rebuilt with the colliders',
    removed: "not saved: colliders removed since the last drain, for their last stopped events (TODO(M3): a load drops them)",
    preStore: 'not saved: one tick of pose history; saved as bodies.zonesHistory and bodies.ruler, reset on an M1 load (M3 restores it)',
    postStore: "not saved: phase 8's velocity snapshot, read in phase 10 of the same tick",
    resets: 'not saved: pending history resets (a load resets every history)',
    gravityY: 'not saved: WORLD_TUNING.gravityY (tuningOverrides)',
    freed: 'not saved: false for a live world',
  },
  WorldQueries: { physics: 'not saved: a link', entities: 'not saved: links to the entity store' },
  Terrain: {
    tileSize: 'not saved: TERRAIN_TUNING when the world was built',
    spacing: 'not saved: derived from the tile size',
    tilesX: 'not saved: options.size',
    tilesZ: 'not saved: options.size',
    cells: 'not saved: TERRAIN_TUNING when the world was built',
    minX: 'not saved: options.size',
    minZ: 'not saved: options.size',
    original: 'not saved: the generated heights, regenerated from the seed',
    heights: 'saved: terrain (edits against the generated heights)',
    dug: 'saved: dug',
    version: 'not saved: an edit counter per tile; a load rebuilds the navmesh (TODO(M3): paths restored with their tile versions)',
    physics: 'not saved: a link',
    colliders: 'not saved: heightfield colliders, rebuilt',
    vx: 'not saved: derived from the size',
    vz: 'not saved: derived from the size',
    nearDug: 'not saved: derived from the dug mask',
    nearDugSetback: 'not saved: TERRAIN_TUNING.spoilSetbackM',
  },
  GroundCover: { world: 'not saved: a link' },
  EntityStore: {
    world: 'not saved: a link',
    byId: 'saved: entities',
    rt: 'not saved: per-entity runtime (EntityRuntime below)',
    sorted: 'saved: entities (id order)',
    snapshot: 'not saved: a cache of sorted',
    removedGen: 'saved: removed',
    queue: 'saved: impulses',
    applied: 'not saved: PHYSICS_TUNING values last applied (tuningOverrides)',
  },
  EntityRuntime: {
    ccd: "not saved: set again in phase 4d from the entity's need",
    keepAwake: 'not saved: a test-harness switch (RT-4), set again by a harness that loads',
    genPose: "not saved: an untouched generated entity's generated pose, regenerated",
    last: 'not saved: the record pose at the last mirror (the pose, at a tick end)',
    shape: "not saved: the entity's shape (saved in its record)",
    reach: 'not saved: derived from the shape',
    minHalf: 'not saved: derived from the shape',
  },
  Entity: {
    ...Object.fromEntries(
      [
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
      ].map((k) => [k, `saved: entities[].${k}`]),
    ),
    body: 'not saved: the Rapier body, rebuilt from the record',
    collider: 'not saved: the Rapier collider, rebuilt from the record',
    prevPose: 'not saved: client interpolation (a load sets it to the pose)',
  },
  JointStore: { world: 'not saved: a link' },
  Breaking: { world: 'not saved: a link' },
  Loads: { world: 'not saved: a link' },
  Felling: { world: 'not saved: a link' },
  CombatSim: {
    fighters: 'saved: fighters (step order)',
    events: 'not saved: cleared at the start of every tick',
    ais: "saved: minds (a world's brains are creature minds; their inner BrawlerAI in minds[].inner)",
    director: 'system: AIDirector',
    drops: 'saved: drops',
    dropSerial: 'saved: counters.dropSerial',
    prevBlade: 'saved: prevBlade',
    projectiles: 'saved: projectiles',
    projSerial: 'saved: counters.projSerial',
    frame: 'saved: tick',
    walkable: 'not saved: set by the world',
    rng: 'saved: rng.combat',
    commands: 'system: CommandQueue',
    speeds: 'not saved: written for every fighter each tick before it is read',
    mover: 'not saved: set by the world',
    groundQuery: 'not saved: set by the world',
    world: 'not saved: set by the world',
    physicsOwnsDowned: 'not saved: set by the world',
    playerFighter: 'not saved: set by the world',
    devChecks: 'not saved: a developer switch',
    sprinters: 'not saved: decided each tick before it is read',
  },
  AIDirector: { frame: 'not saved: set from the tick every step', lastAttack: 'saved: director.lastAttack', gap: 'not saved: a setting' },
  CommandQueue: { pending: 'saved: pending' },
  CharacterControllers: {
    world: 'not saved: a link',
    byId: 'saved: bodies (each Controller as bodies[].kcc)',
    pending: 'not saved: pushes queued in phase 3 and applied in phase 4d of the same tick (empty at a tick end)',
  },
  Controller: {
    f: 'not saved: the fighter (a link)',
    body: 'not saved: the capsule body, rebuilt (its pose is bodies[].kcc.pose)',
    col: 'not saved: the capsule collider, rebuilt',
    cc: "not saved: Rapier's character controller, rebuilt",
    r: 'not saved: CHARACTER_TUNING × scale when made',
    halfH: 'not saved: CHARACTER_TUNING × scale when made',
    halfNow: 'saved: bodies[].kcc.halfHeight',
    crouched: 'saved: bodies[].kcc.crouched',
    enabled: 'saved: bodies[].kcc.enabled',
    vy: 'saved: bodies[].kcc.vy',
    grounded: 'saved: bodies[].kcc.grounded',
    teleport: 'saved: bodies[].kcc.teleport',
    collided: 'not saved: a read-out of the last sweep (tests, AC-6)',
    pushed: 'not saved: a read-out of the last sweep (tests, AC-6)',
    lastPushes: 'saved: bodies[].kcc.pushes',
    pushTick: 'saved: bodies[].kcc.pushTick',
    params: 'not saved: derived from the scale and CHARACTER_TUNING',
  },
  ZoneBodies: { world: 'not saved: a link', byId: 'saved: bodies (each ZoneSet as bodies[].zonesHistory)' },
  ZoneSet: {
    f: 'not saved: the fighter (a link)',
    body: 'not saved: the zone body, rebuilt and posed from the rig in every phase 4b',
    cols: "not saved: the bone sensors, rebuilt (a severed bone's is turned off in phase 4b)",
    offs: 'not saved: derived from the scale',
    keys: 'not saved: owner keys',
    enabled: 'not saved: off exactly while the slab is active or just handed back; the loader sets it from bodies[].slab',
    jump: 'not saved: a load resets the pose history, which sets it',
  },
  DownedBodies: { world: 'not saved: a link', byId: 'saved: bodies (each Slab as bodies[].slab)' },
  Slab: {
    f: 'not saved: the fighter (a link)',
    body: 'not saved: the slab body, rebuilt (bodies[].slab.pose, lin, ang)',
    col: 'not saved: the slab collider, rebuilt',
    halfLen: 'not saved: DOWNED_TUNING × scale when made',
    key: 'not saved: its owner key',
    active: 'saved: bodies[].slab.enabled',
    hold: 'saved: bodies[].slab.hold',
    handedBack: 'saved: bodies[].slab.handedBack',
    dv: 'saved: bodies[].slab.dv',
  },
  RulerBodies: { world: 'not saved: a link', mover: 'not saved: code (RulerMover)' },
  ContactSystem: { world: 'not saved: a link' },
  Deaths: { world: 'not saved: a link' },
  VerbSystem: { world: 'not saved: a link' },
  MindRegistry: { world: 'not saved: a link', minds: 'saved: minds (by fighter id) and rng.minds' },
  NoiseBus: { world: 'not saved: a link (the bus is empty at the end of a tick)' },
  Spawner: { world: 'not saved: a link' },
  NavSystem: {
    world: 'not saved: a link',
    buildFailures: 'not saved: a dev read-out',
    dirtyReasons: 'not saved: a dev read-out',
    layers: 'saved: navDirty (each layer\'s dirty tiles); the navmeshes themselves are rebuilt on load (TODO(M3): tile versions, which paths keep)',
    disposed: 'not saved: false for a live system',
    baked: 'not saved: the static and resting entities, taken afresh by the build on load',
    bakedSorted: 'not saved: a cache of baked',
    seenVersion: 'not saved: the terrain as the navmesh last saw it, taken afresh by the build on load',
    seenHeights: 'not saved: the terrain as the navmesh last saw it, taken afresh by the build on load',
  },
  /** Fighter fields the save keeps outside the fighter's record (P04's records.test.ts inventories the rest). */
  Fighter: { rng: 'saved: rng.fighters', ruler: 'saved: rulers' },
  /** The tuning registry (per process). */
  Registry: { overrides: 'saved: tuningOverrides (sim tables)' },
  /** The save's own tags. */
  Save: { format: 'saved: format', formatVersion: 'saved: formatVersion' },
};

/**
 * Save keys whose runtime source arrives with a later package: the system is a stub that holds nothing yet, and its
 * record (an empty list) is already in the save. Each leaves this list when its package adds the state to the
 * inventory above.
 */
const AWAITING: Record<string, string> = {
  cover: 'GroundCover (P21)',
  joints: 'JointStore (P10)',
  verbs: 'VerbSystem (P14)',
  spawner: 'Spawner (P22)',
  contacts: 'ContactSystem (P09)',
  contactGrace: 'ContactSystem (P09)',
  felling: 'Felling (P10)',
  deaths: 'Deaths (P09)',
  corpses: 'Deaths (P09)',
};

describe('completeness (RR-19)', () => {
  /** Every inventoried object of a populated world, by inventory entry. */
  function systems(w: World, e: number): Record<string, object> {
    const rt = (w.entities as unknown as { rt: Map<number, object> }).rt;
    const byId = (system: object): Map<number, object> => (system as { byId: Map<number, object> }).byId;
    return {
      World: w,
      ids: w.ids,
      WorldRngs: w.rngs,
      PhysicsWorld: w.physics,
      WorldQueries: w.queries,
      Terrain: w.terrain,
      GroundCover: w.cover,
      EntityStore: w.entities,
      EntityRuntime: rt.get(e)!,
      Entity: w.entities.get(e)!,
      JointStore: w.joints,
      Breaking: w.breaking,
      Loads: w.loads,
      Felling: w.felling,
      CombatSim: w.combat,
      AIDirector: w.combat.director,
      CommandQueue: w.commands,
      CharacterControllers: w.kcc,
      Controller: byId(w.kcc).get(1)!,
      ZoneBodies: w.zones,
      ZoneSet: byId(w.zones).get(1)!,
      DownedBodies: w.downed,
      Slab: byId(w.downed).get(1)!,
      RulerBodies: w.rulers,
      ContactSystem: w.contacts,
      Deaths: w.deaths,
      VerbSystem: w.verbs,
      MindRegistry: w.minds,
      NoiseBus: w.noise,
      Spawner: w.spawner,
      ...(w.nav ? { NavSystem: w.nav } : {}),
    };
  }

  it('every runtime field of every world system is saved, a system, or not saved for a reason', async () => {
    const w = await make({ nav: 'full' });
    const ids = populate(w);
    run(w, 20, new Rng(4));
    const sys = systems(w, ids.log);
    const diffs: { entry: string; notInInventory: string[]; notOnObject: string[] }[] = [];
    for (const [name, o] of Object.entries(sys)) {
      const have = Object.keys(o).sort();
      const listed = Object.keys(INVENTORY[name] ?? {}).sort();
      const missing = have.filter((k) => !listed.includes(k));
      const gone = listed.filter((k) => !have.includes(k));
      if (missing.length > 0 || gone.length > 0) diffs.push({ entry: name, notInInventory: missing, notOnObject: gone });
    }
    expect(diffs).toEqual([]);
    // Every `system:` names an entry, every entry is reached, every verdict is one of the three kinds.
    for (const [name, fields] of Object.entries(INVENTORY)) {
      for (const [k, v] of Object.entries(fields)) {
        expect(v, `${name}.${k}`).toMatch(/^(saved|system|not saved): ./);
        const sysName = /^system: (\S+)/.exec(v)?.[1];
        if (sysName) expect(INVENTORY[sysName], `${name}.${k} → ${sysName}`).toBeDefined();
      }
    }
    for (const name of Object.keys(sys)) expect(Object.keys(INVENTORY)).toContain(name);
  });

  it("every key of the save has a source in the inventory (or awaits its system's package), and every `saved:` names a key", async () => {
    const savedKeys = new Set<string>();
    for (const fields of Object.values(INVENTORY)) {
      for (const v of Object.values(fields)) {
        const m = /^saved: ([A-Za-z]+)/.exec(v);
        if (!m) continue;
        expect(SAVE_V1_KEYS as readonly string[], v).toContain(m[1]);
        savedKeys.add(m[1]);
        for (const more of v.matchAll(/\b(?:and|,) ([A-Za-z]+)(?=[\s.,(]|$)/g)) if ((SAVE_V1_KEYS as readonly string[]).includes(more[1])) savedKeys.add(more[1]);
      }
    }
    const sourceless = SAVE_V1_KEYS.filter((k) => !savedKeys.has(k) && !(k in AWAITING));
    expect(sourceless).toEqual([]);
    for (const k of Object.keys(AWAITING)) expect(SAVE_V1_KEYS as readonly string[]).toContain(k);
  });

  it("the save's own records have exactly their fields", async () => {
    const w = await make();
    populate(w);
    run(w, 3, new Rng(8));
    w.entities.queueImpulse(w.entities.all()[0].id, { x: 1, y: 0, z: 0 }, null);
    const s = parsed(serializeWorld(w)) as unknown as SaveV1;
    expect(Object.keys(s.options)).toEqual(['scene', 'terrain', 'size', 'player', 'sparringApe']);
    expect(Object.keys(s.counters)).toEqual(['fighter', 'entity', 'joint', 'wound', 'dropSerial', 'projSerial']);
    expect(Object.keys(s.rng)).toEqual(['combat', 'world', 'fighters', 'minds']);
    expect(Object.keys(s.director)).toEqual(['lastAttack']);
    expect(Object.keys(s.bodies[0])).toEqual(['fighter', 'kcc', 'zonesHistory', 'slab', 'ruler']);
    expect(Object.keys(s.impulses[0])).toEqual(['entity', 'j', 'at']);
    expect(Object.keys(s.terrain[0])).toEqual(['tile', 'vertex', 'dh']);
    expect(Object.keys(s.spawner)).toEqual(['homes', 'sparring']);
  });
});

// ---------------------------------------------------------------------------
// save → load → save
// ---------------------------------------------------------------------------

/** What the M1 loader restores exactly: its scope (§8.3, §13.1) and everything else it puts back as it was. */
const EXACT = [
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
  'rulers',
  'felling',
  'deaths',
  'corpses',
] as const;
// Not compared: `bodies` (the zones' pose history is reset on load, MAP gap-7's exact restore is M3's), `contacts` and
// `contactGrace` (a zone reset opens a grace, §4.3), `navDirty` (the navmesh is rebuilt). The test below lists them, so
// a new key must be placed in one list or the other.
const NOT_EXACT = ['bodies', 'contacts', 'contactGrace', 'navDirty'] as const;

describe('save → load → save', () => {
  it('is byte-identical for entities, joints, terrain with the dug mask and rulers, and for all the loader restores exactly', async () => {
    expect([...EXACT, ...NOT_EXACT].sort()).toEqual([...SAVE_V1_KEYS].sort());
    const w = await make();
    populate(w);
    run(w, 90, new Rng(11));
    // Pending work: a command queued for later (a non-finite setTuning value), an impulse for the next tick, a ruler.
    w.commands.push(setTuningCommand(w.tick + 5, 1, 'WORLD_TUNING', 'aiNearM', Infinity));
    w.commands.push(moveCommand(w.tick + 2, 1, 0.5, -0.5, 1));
    const log = w.entities.all()[0].id;
    w.entities.queueImpulse(log, { x: 0, y: 2, z: 0 }, { x: 2, y: 0.2, z: 1 });
    w.player!.ruler = rulerSample();
    const a = serializeWorld(w);
    const l = await load(a);
    const b = serializeWorld(l);
    const sa = sections(a, SAVE_V1_KEYS);
    const sb = sections(b, SAVE_V1_KEYS);
    for (const k of EXACT) expect(sb[k] === sa[k], `section ${k}`).toBe(true);
    // The M1 scope is not vacuous here.
    const s = parsed(a) as unknown as SaveV1;
    expect(s.entities.length).toBe(8);
    expect(s.terrain.length).toBeGreaterThan(10);
    expect(s.dug.length).toBeGreaterThan(0);
    expect(s.rulers.length).toBe(1);
    expect(s.pending.length).toBe(2);
    expect(s.impulses.length).toBe(1);
    // And a second round trip changes nothing more.
    expect(text(serializeWorld(track(await loadWorld(b, { nav: 'off' })))) === text(b)).toBe(true);
  });

  it('gives the loaded world its fighters, players, tick, entity poses, queue, impulses and streams', async () => {
    const w = await make();
    populate(w);
    run(w, 45, new Rng(12));
    const tick = w.tick;
    w.commands.push(moveCommand(tick + 1, 1, 1, 0));
    const log = w.entities.all()[0].id;
    w.entities.queueImpulse(log, { x: 0, y: 1, z: 0 }, null);
    const l = await load(serializeWorld(w));
    expect(l.tick).toBe(tick);
    expect(l.player).not.toBeNull();
    expect(l.player!.id).toBe(1);
    expect(l.players.get(1)).toBe(l.player);
    expect(l.player!.playerId).toBe('p1');
    expect(l.combat.fighters).toEqual([l.player]);
    expect(l.player!.toRecord(l.combat.drops)).toEqual(w.player!.toRecord(w.combat.drops));
    expect(l.player!.rngState).toBe(w.player!.rngState);
    for (const b of BONES) {
      expect(l.player!.rig[b].pos.toArray()).toEqual(w.player!.rig[b].pos.toArray());
      expect(l.player!.rig[b].rot.toArray()).toEqual(w.player!.rig[b].rot.toArray());
    }
    expect(l.combat.rng.state).toBe(w.combat.rng.state);
    expect(l.rngs.world.state).toBe(w.rngs.world.state);
    expect(l.commands.toRecord()).toEqual(w.commands.toRecord());
    expect(l.entities.pendingImpulses()).toEqual(w.entities.pendingImpulses());
    for (const e of w.entities.all()) {
      const f = l.entities.get(e.id)!;
      expect(f.pose).toEqual(e.pose);
      expect(f.state).toBe(e.state);
      expect(!!f.body).toBe(!!e.body);
      if (e.body) expect(f.body!.isEnabled()).toBe(e.body.isEnabled());
    }
    expect(l.ids.entity.next).toBe(w.ids.entity.next);
    expect(l.ids.fighter.next).toBe(w.ids.fighter.next);
    expect(l.events).toEqual([]);
    expect(l.terrain.heightAt(-6, 6)).toBe(w.terrain.heightAt(-6, 6));
    expect(l.terrain.isDugVertex(l.terrain.vertexIndex(-6, 6).gi, l.terrain.vertexIndex(-6, 6).gj)).toBe(true);
  });

  it("continues: a pending setTuning lands at its tick, and two loads of one save stay bit-identical", async () => {
    const w = await make();
    populate(w);
    run(w, 60, new Rng(13));
    w.commands.push(setTuningCommand(w.tick + 3, 1, 'WORLD_TUNING', 'aiNearM', Infinity));
    const bytes = serializeWorld(w);
    w.dispose();
    resetTuning();
    const l1 = await load(bytes);
    expect(WORLD_TUNING.aiNearM).not.toBe(Infinity);
    l1.step();
    l1.step();
    expect(WORLD_TUNING.aiNearM).not.toBe(Infinity);
    l1.step();
    expect(WORLD_TUNING.aiNearM).toBe(Infinity);
    resetTuning();
    const l2 = await load(bytes);
    const l3 = await load(bytes);
    const r2 = new Rng(14);
    const r3 = new Rng(14);
    for (let i = 0; i < 300; i++) {
      run(l2, 1, r2);
      run(l3, 1, r3);
      if (l2.tick % 60 === 0) {
        expect(firstDiff(bodyStateBytes(l2), bodyStateBytes(l3))).toBe(-1);
        expect(text(serializeWorld(l2)) === text(serializeWorld(l3))).toBe(true);
        await yieldNow();
      }
    }
    expect(l2.tick).toBe(60 + 300);
  });

  it('loads a knocked-down player down: its slab moving, its controller and zones off, and it gets up as the original does', async () => {
    const w = await make();
    populate(w);
    run(w, 20, new Rng(15));
    const p = w.player!;
    // A blow in the next phase 3, as CombatSim's hit() leaves one: knockback in f.vel, the knockdown, its hit event.
    const sim = w.combat;
    const orig = sim.stepBody;
    sim.stepBody = function () {
      sim.stepBody = orig;
      const ev = orig.call(sim);
      p.vel.set(3, 0, 1);
      p.enterKnockdown();
      ev.push({ type: 'hit', attacker: p, defender: p, move: { lift: 1 }, knockdown: true, ko: false } as unknown as (typeof ev)[number]);
      return ev;
    };
    for (let i = 0; i < 8; i++) w.step();
    expect(w.downed.active(p)).toBe(true);
    expect(w.kcc.isEnabled(p)).toBe(false);
    expect(w.zones.enabled(p)).toBe(false);
    const a = serializeWorld(w);
    const l = await load(a);
    const q = l.player!;
    expect(l.downed.active(q)).toBe(true);
    expect(l.kcc.isEnabled(q)).toBe(false);
    expect(l.zones.enabled(q)).toBe(false);
    expect(q.state).toBe('knockdown');
    const sa = parsed(a) as unknown as SaveV1;
    const sb = parsed(serializeWorld(l)) as unknown as SaveV1;
    expect(sa.bodies[0].slab!.enabled).toBe(true);
    expect(canonicalJson(sb.bodies.map((b) => [b.kcc, b.slab]))).toBe(canonicalJson(sa.bodies.map((b) => [b.kcc, b.slab])));
    for (const k of EXACT) expect(canonicalJson(sb[k]) === canonicalJson(sa[k]), `section ${k}`).toBe(true);
    // Both get up (the slab settles, hands back, the zones come back); the loaded one within a few ticks of the other.
    const upAt = async (x: World): Promise<number> => {
      for (let t = 0; t < 900; t++) {
        x.step();
        if (!x.downed.active(x.player!) && x.kcc.isEnabled(x.player!) && x.zones.enabled(x.player!)) return x.tick;
        if (t % 60 === 59) await yieldNow();
      }
      return -1;
    };
    const t1 = await upAt(w);
    const t2 = await upAt(l);
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(0);
    expect(Math.abs(t1 - t2)).toBeLessThanOrEqual(3);
  });

  it('rebuilds the navmesh over the loaded ground and gives it back its dirty tiles', async () => {
    const w = await make({ nav: 'full' });
    populate(w);
    run(w, 5, new Rng(16));
    w.nav!.markDirty({ min: { x: -20, y: 0, z: -20 }, max: { x: 20, y: 1, z: 20 } }, 'save test');
    const queue = w.nav!.dirtyQueue();
    expect(queue.length).toBeGreaterThan(2);
    const a = serializeWorld(w);
    expect((parsed(a) as unknown as SaveV1).navDirty).toEqual(queue);
    const l = await load(a, { nav: 'full' });
    expect(l.nav!.built).toBe(true);
    expect(l.nav!.dirtyQueue()).toEqual(queue);
    // The dug hole is in the rebuilt navmesh as in the original's: the same walkable cells around it.
    for (const [x, z] of [
      [-6, 6],
      [-5.6, 6],
      [-6.5, 6.4],
      [0, 0],
      [2, 1],
    ]) {
      expect(l.nav!.isWalkable('human', x, z), `(${x}, ${z})`).toBe(w.nav!.isWalkable('human', x, z));
    }
    // Loaded without a navmesh, the dirty tiles are moot.
    expect((await load(a, { nav: 'off' })).nav).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A world at rest (M3 preview, SPEC:730)
// ---------------------------------------------------------------------------

/** The angle between two unit quaternions, degrees. */
function angleDeg(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
  return (2 * Math.acos(d) * 180) / Math.PI;
}
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('a world at rest', () => {
  it('saved and loaded, matches the original within 1 cm and 1° over 10 s', async () => {
    const w = await make();
    const ids = populate(w);
    // Logs and stones on the ground, a stack on the crate.
    spawnLog(w, { p: { x: 0, y: 1.2, z: -3 }, length: 1.6, r: 0.08 });
    spawnStone(w, { p: { x: 4, y: 0.4, z: 4 }, mass: 8, proto: 2 });
    spawnLog(w, { p: { x: -4, y: 0.3, z: 4 }, length: 3, mass: 60 });
    for (let i = 0; i < 240; i++) {
      w.step();
      if (i % 60 === 59) await yieldNow();
    }
    const moving = w.entities.all().filter((e) => e.body && e.body.isEnabled() && e.body.isDynamic() && e.restTicks < 30);
    expect(moving.map((e) => e.id)).toEqual([]);
    const l = await load(serializeWorld(w));
    let worstM = 0;
    let worstDeg = 0;
    for (let t = 1; t <= 600; t++) {
      w.step();
      l.step();
      if (t % 60 !== 0) continue;
      await yieldNow();
      for (const e of w.entities.all()) {
        const f = l.entities.get(e.id)!;
        worstM = Math.max(worstM, dist(e.pose.p, f.pose.p));
        worstDeg = Math.max(worstDeg, angleDeg(e.pose.q, f.pose.q));
      }
    }
    expect(worstM).toBeLessThanOrEqual(0.01);
    expect(worstDeg).toBeLessThanOrEqual(1);
    expect(l.entities.all().length).toBe(w.entities.all().length);
    expect(l.entities.get(ids.stake)!.state).toBe('anchored');
  });
});

// ---------------------------------------------------------------------------
// Tuning (RR-17)
// ---------------------------------------------------------------------------

describe('tuning on load', () => {
  async function savedWithOverride(): Promise<Uint8Array> {
    const w = await make();
    setTuningValue('WORLD_TUNING', 'corpseDespawnS', 77);
    setTuningValue('PHYSICS_TUNING', 'restSpeed', 0.06);
    const bytes = serializeWorld(w);
    resetTuning();
    return bytes;
  }

  it('leaves the registry alone unless applyTuning', async () => {
    const bytes = await savedWithOverride();
    const before = tuningSnapshot();
    await load(bytes);
    expect(tuningSnapshot()).toBe(before);
    await load(bytes, { applyTuning: false });
    expect(tuningSnapshot()).toBe(before);
  });

  it('applies the overrides with applyTuning (a client table is never set from a save)', async () => {
    const bytes = await savedWithOverride();
    const withClient = edited(bytes, (s) => {
      (s.tuningOverrides as unknown[]).unshift({ table: 'ZZ_CLIENT_TEST_TUNING', key: 'knob', value: 9 }, { table: 'NO_SUCH_TABLE', key: 'x', value: 1 });
    });
    await load(withClient, { applyTuning: true });
    expect(WORLD_TUNING.corpseDespawnS).toBe(77);
    expect(getTuningValue('PHYSICS_TUNING', 'restSpeed')).toBe(0.06);
    expect(CLIENT_TEST_TUNING.knob).toBe(1);
  });

  it('puts the registry back when the load fails', async () => {
    const bytes = await savedWithOverride();
    const before = tuningSnapshot();
    const bad = edited(bytes, (s) => {
      (s.tuningOverrides as unknown[]).push({ table: 'WORLD_TUNING', key: 'noSuchKey', value: 1 });
    });
    await expect(loadWorld(bad, { nav: 'off', applyTuning: true })).rejects.toThrow(/unknown key noSuchKey/);
    expect(tuningSnapshot()).toBe(before);
    const badLater = edited(bytes, (s) => {
      (s.fighters as Record<string, unknown>[])[0].playerId = null;
    });
    await expect(loadWorld(badLater, { nav: 'off', applyTuning: true })).rejects.toThrow(/neither a player nor a creature/);
    expect(tuningSnapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The v1 fixture
// ---------------------------------------------------------------------------

const FIXTURE = new URL('./fixtures/save-v1.json', import.meta.url);
/**
 * What a load of the fixture must give back as it was: the M1 loader's scope (entities, joints, terrain with the dug
 * mask, rulers) and what it restores from records whose format v1 fixes (P04's fighter, CombatSim's own state, the
 * counters, streams, commands, impulses, tuning). The lists of systems that fill their records in later packages
 * (minds, verbs, the spawner, felling, deaths) are left out: a later build may write an entry for an idle owner that a
 * v1 save from before it never had, without a format change.
 */
const FIXTURE_EXACT = [
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
  'drops',
  'projectiles',
  'prevBlade',
  'rulers',
] as const;
const writingFixture = process.env.ROTW_WRITE_SAVE_FIXTURE === '1';

/** The fixture's world: every entity body kind, a dug hole, a walk, overrides, pending commands and an impulse. */
async function fixtureWorld(): Promise<World> {
  const w = await make({ seed: 1017, size: 25 });
  populate(w);
  run(w, 75, new Rng(1017));
  setTuningValue('WORLD_TUNING', 'corpseDespawnS', 95);
  w.commands.push(moveCommand(w.tick + 1, 1, -0.25, 0.75, 2));
  w.commands.push(setTuningCommand(w.tick + 4, 1, 'WORLD_TUNING', 'corpseDespawnMinDistM', Infinity));
  w.entities.queueImpulse(w.entities.all()[1].id, { x: 0.5, y: 0, z: -0 }, null);
  return w;
}

describe('the v1 fixture', () => {
  it.runIf(writingFixture)('is written from its world', async () => {
    const w = await fixtureWorld();
    writeFileSync(FIXTURE, serializeWorld(w));
  });

  it('loads, and saves again as it was (the loader\'s exact sections)', async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const save = readSave(bytes);
    expect(save.formatVersion).toBe(1);
    expect(save.seed).toBe(1017);
    expect(save.options.size).toBe(25);
    expect(save.entities.length).toBe(8);
    expect(save.pending.length).toBe(2);
    expect(save.impulses.length).toBe(1);
    const l = await load(bytes, { applyTuning: true });
    expect(l.tick).toBe(75);
    expect(WORLD_TUNING.corpseDespawnS).toBe(95);
    const again = sections(serializeWorld(l), FIXTURE_EXACT);
    const want = sections(bytes, FIXTURE_EXACT);
    for (const k of FIXTURE_EXACT) expect(again[k] === want[k], `section ${k}`).toBe(true);
    // The loaded world runs (the pending setTuning lands at its tick).
    for (let i = 0; i < 4; i++) l.step();
    expect(WORLD_TUNING.corpseDespawnMinDistM).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// Broken saves
// ---------------------------------------------------------------------------

describe('broken saves', () => {
  let good: Uint8Array;
  beforeAll(async () => {
    const w = await createWorld({ seed: 5, scene: 'empty', nav: 'off', size: 25 });
    populate(w);
    run(w, 10, new Rng(5));
    w.player!.ruler = rulerSample();
    good = serializeWorld(w);
    w.player!.ruler = null;
    w.dispose();
  });

  const refuse = (edit: (s: Record<string, unknown>) => void, message: string | RegExp) => {
    expect(() => readSave(edited(good, edit))).toThrow(message);
  };

  it('migrate is the identity for v1 (a fresh copy of the record)', () => {
    const raw = parsed(good);
    const m = migrate(raw);
    expect(canonicalJson(m)).toBe(canonicalJson(raw));
    expect(m).not.toBe(raw);
  });

  it('refuses what is not a world save, or a newer version', () => {
    expect(() => readSave(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow('not UTF-8');
    expect(() => readSave(bytesOf('{"format":'))).toThrow('not canonical JSON');
    expect(() => readSave(bytesOf('{"a":"$oops"}'))).toThrow('not canonical JSON');
    refuse((s) => (s.format = 'other'), "format is \"other\", not 'rotw-world'");
    refuse((s) => (s.formatVersion = 2), 'formatVersion 2 is newer than this build reads (1)');
    refuse((s) => (s.formatVersion = 0), 'formatVersion is 0, not a save version');
  });

  it('names the field that is missing, extra or of the wrong kind', () => {
    refuse((s) => delete s.counters, 'save record: save.counters is missing, not there');
    refuse((s) => (s.extra = 1), "save has a field this version doesn't have: extra");
    refuse((s) => (s.tick = -1), 'save record: tick is -1, not a whole number ≥ 0');
    refuse((s) => (s.seed = 2 ** 32), 'seed is 4294967296, not a uint32');
    refuse((s) => ((s.options as Record<string, unknown>).scene = 'forest'), 'options.scene is "forest", not one of clearing, empty');
    refuse((s) => ((s.rng as Record<string, unknown>).combat = 1.5), 'rng.combat is 1.5, not a uint32');
    refuse((s) => ((s.terrain as Record<string, unknown>[])[0].dh = NaN), 'terrain[0].dh is NaN, not a finite number');
    refuse((s) => ((s.entities as Record<string, unknown>[])[0].material = 'gold'), 'entities[0].material is "gold", not a material');
    refuse((s) => ((s.entities as Record<string, unknown>[])[1].shape = { kind: 'ball', r: -1 }), 'entities[1].shape.r is -1, not a positive size');
    refuse((s) => ((s.entities as Record<string, unknown>[])[0].pose = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0 } }), 'entities[0].pose.q.w is missing');
    refuse((s) => (s.pending = [{ tick: 1, player: 1, kind: 'move', dir: 0.5, speed: 1 }]), 'pending[0].dir is 0.5, not a whole number');
    refuse((s) => (s.pending = [{ tick: 1, player: 1, kind: 'verb', verb: 'juggle', target: 0 }]), 'pending[0].verb is "juggle"');
    refuse((s) => ((s.rulers as unknown[][])[0][1] as Record<string, unknown>).inPit = 'yes', 'rulers[0][1].inPit is "yes", not a boolean');
    refuse((s) => ((((s.rulers as unknown[][])[0][1] as Record<string, unknown>).wounds as Record<string, unknown>[])[0].zone = 'tail'), 'rulers[0][1].wounds[0].zone is "tail"');
  });

  it('checks weapons stored by value and ids against the counters and each other', () => {
    refuse((s) => ((s.fighters as Record<string, unknown>[])[0].weapon = { id: 'lightsaber', def: null }), 'fighters[0].weapon.id is "lightsaber", not a weapon id');
    refuse((s) => ((s.fighters as Record<string, unknown>[])[0].weapon = { id: 'bat', def: { id: 'axe' } }), /fighters\[0\]\.weapon\.def\.name is missing/);
    refuse((s) => ((s.counters as Record<string, unknown>).entity = 3), /entity 3 is not below counters.entity \(3\)/);
    refuse((s) => ((s.counters as Record<string, unknown>).fighter = 1), 'fighter 1 is not below counters.fighter (1)');
    refuse((s) => (s.entities as unknown[]).reverse(), 'entities are not in increasing id order at entities[1]');
    refuse((s) => ((s.rng as Record<string, unknown>).fighters = [[9, 1]]), 'rng.fighters[0] names fighter 9');
    refuse((s) => (s.bodies as Record<string, unknown>[]).push({ fighter: 7, kcc: null, zonesHistory: [], slab: null, ruler: null }), 'bodies[1] names fighter 7');
  });

  it('refuses a terrain edit outside the world, before anything is left behind', async () => {
    const bad = edited(good, (s) => ((s.terrain as Record<string, unknown>[])[0].tile = 999));
    await expect(loadWorld(bad, { nav: 'off' })).rejects.toThrow('terrain[0]: tile 999 is not a tile of this world (1 tiles)');
  });

  it('refuses a fighter id that the save names twice, and a player id that is not p<n>', () => {
    refuse((s) => (s.fighters as unknown[]).push((s.fighters as unknown[])[0]), 'fighters: fighter 1 is listed twice');
    const bad = edited(good, (s) => ((s.fighters as Record<string, unknown>[])[0].playerId = 'player-one'));
    return expect(loadWorld(bad, { nav: 'off' })).rejects.toThrow("playerId is \"player-one\", not 'p<number>'");
  });
});

// Ids made by a counter the world doesn't own never reach a save (the legacy counter stays the tests').
it('a world makes its fighters with its own counter', async () => {
  const w = await make();
  expect(w.ids.fighter).toBeInstanceOf(IdCounter);
  expect(w.ids.fighter).not.toBe(LEGACY_IDS);
});
