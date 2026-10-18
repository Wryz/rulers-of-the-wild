// P13, the save (docs/M1-DESIGN.md §8, §1.5.11, §13.1): saveRecord / serializeWorld, bodyStateBytes (AC-7's body bytes),
// loadWorld and migrate.
//
// - The save: SaveV1's keys in order; the options, tick, counters, RNG streams and per-fighter lists (the player's
//   controller, zone history and slab by their fields); the client's tuning tables left out; commands rewritten in their
//   type's key order, every field of every kind written and read back; `meta 'save'` writes at the end of its tick; a
//   brain that isn't a creature mind, or a RulerState field the writer doesn't know, is refused.
// - Determinism (an AC-7 preview): two worlds from one seed fed one command log give byte-identical saves and
//   bit-identical body bytes every 60 ticks, run one after the other (after an unrelated world) and interleaved.
// - Completeness (RR-19): every runtime field of every world system is saved (with its place in the save) or listed
//   with the reason it isn't; every inventory entry is matched against a live object (whole, or the fields it lists) or
//   is descriptive; every place a `saved:` verdict names (record sub-fields and list elements included) is in a
//   populated save; every key of the save has a source. A system that adds a field fails here until the field is placed
//   in the inventory below (and, if it is state, in its record).
// - save → load → save is byte-identical for the M1 loader's scope (entities, joints, terrain with the dug mask, rulers)
//   and for everything else the loader restores exactly (fighters, CombatSim's state, counters, streams, commands,
//   impulses, contact episodes, a fighter's verb state with its command in canonical key order …); the loaded world
//   continues: pending commands land at their ticks, two loads of one save stay bit-identical to each other; a
//   knocked-down player loads down (slab moving, controller and zones off) and gets up as the original does; an
//   impulse queued for an entity removed since is left out (phase 4d drops it), so the save loads; the scene queries
//   see every restored body before the first step (supportAt, rays, a teleport onto a box); the navmesh is rebuilt over
//   the loaded ground with its dirty queue.
// - A world at rest, saved and loaded, matches the original within 1 cm and 1° over 10 s (an M3 preview, SPEC:730), and
//   the contact episodes it restores carry on as the original's.
// - Tuning: loadWorld leaves the registry alone unless applyTuning; with it, the sim tables are the saving world's (a
//   stray sim value goes back to its default, the client's tables are untouched); a failed load puts it back.
// - The v1 fixture (tests/fixtures/save-v1.json) loads, so M3's migrations have a v1 to start from. To rewrite it after a
//   deliberate format change (bump formatVersion and add a migration instead once saves exist in the wild):
//     ROTW_WRITE_SAVE_FIXTURE=1 npx vitest run packages/sim/tests/save.test.ts
// - Broken saves are refused with a `save record:` error naming the field, before a world is built (an impulse on an
//   entity the loaded world wouldn't have, once generation has run). Contacts are read with ContactSystem's signed
//   subject (a fighter id, or an entity id negated) and checked against the counters, in their form and order; a
//   fighter's verb state is checked field by field.
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
import { createEnemy } from '../src/sim/enemies';
import { type Fighter, IdCounter, LEGACY_IDS } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { createBrawler } from '../src/sim/roster';
import { newRulerState } from '../src/sim/ruler';
import { SPECIES_BODY } from '../src/sim/species';
import { defineTuning, getTuningValue, resetTuning, setTuningValue, tuningSnapshot } from '../src/tuning/registry';
import { ApeMind } from '../src/world/creatures/apeMind';
import { createCreature } from '../src/world/creatures/factory';
import type { CreatureMind } from '../src/world/creatures/mind';
import { RulerMind } from '../src/world/creatures/rulerMind';
import { spawnBox, spawnGrass, spawnLog, spawnRopeCoil, spawnSapling, spawnStick, spawnStone, spawnTree } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Quat, RulerState, V3 } from '../src/world/types';
import { NavSystem } from '../src/world/nav';
import { createWorld, World, type WorldOptions } from '../src/world/world';
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
  // Ground cover written in the empty scene: it gets a grid, and the save a cover edit.
  w.cover.set(6, -6, 0.6);
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

/**
 * A giant ape with its ruler body (the way world/creatures/factory.ts makes one, without a mind: P19's), standing at
 * (x, z): scale 5.5, 14 t, a fresh RulerState.
 */
function addGiant(w: World, x: number, z: number): Fighter {
  const ids = w.ids.fighter;
  const { fighter: g } = createEnemy('bruiser', new Rng(4), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  g.scale = SPECIES_BODY.giantApe.scale;
  g.massKg = SPECIES_BODY.giantApe.massKg;
  g.species = 'giantApe';
  g.ruler = newRulerState(SPECIES_BODY.giantApe.maxHp);
  g.pos.set(x, w.terrain.heightAt(x, z), z);
  w.addFighter(g, null);
  w.teleport(g, x, z);
  return g;
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
    // The player's bodies: its controller's capsule where Rapier holds it, standing; its zones' pose history (per bone,
    // the last stored pose and the one before it, 7 numbers each); its slab parked and off; no ruler body.
    expect(s.bodies.map((b) => [b.fighter, b.ruler])).toEqual([[1, null]]);
    const kcc = s.bodies[0].kcc!;
    expect(Object.keys(kcc)).toEqual(['pose', 'vy', 'grounded', 'crouched', 'enabled', 'halfHeight', 'teleport', 'pushes', 'pushTick']);
    expect(kcc.pose).toEqual(w.kcc.capsulePose(w.player!));
    expect([kcc.grounded, kcc.crouched, kcc.enabled, kcc.teleport]).toEqual([true, false, true, null]);
    expect(kcc.halfHeight).toBeGreaterThan(0);
    const hist = s.bodies[0].zonesHistory;
    expect(hist.length).toBe(BONES.length * 2 * 7);
    for (let i = 0; i < hist.length; i += 7) expect(Math.hypot(hist[i + 3], hist[i + 4], hist[i + 5], hist[i + 6]), `quaternion at ${i + 3}`).toBeCloseTo(1, 5);
    const slab = s.bodies[0].slab!;
    expect(Object.keys(slab)).toEqual(['enabled', 'pose', 'lin', 'ang', 'hold', 'handedBack', 'dv', 'notClearOf']);
    expect([slab.enabled, slab.hold, slab.handedBack, slab.dv, slab.notClearOf]).toEqual([false, 0, false, null, { entities: [], fighters: [] }]);
    expect(s.rulers).toEqual([]);
    // The empty scene has no creature homes and no sparring ape.
    expect(s.spawner.homes).toEqual([]);
    expect(Object.keys(s.spawner.sparring)).toEqual(['fighter', 'respawnTick']);
    expect(s.spawner.sparring.fighter).toBeNull();
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

  it('writes and reads back every field of every command kind (the key lists are checked against the types)', async () => {
    const w = await make();
    const t = w.tick + 50;
    const all: Command[] = [
      { tick: t, player: 1, kind: 'move', dir: 5, speed: 64, flags: 3 },
      { tick: t, player: 1, kind: 'button', button: 'pickup' },
      { tick: t, player: 1, kind: 'verb', verb: 'lash', target: 3, second: 4, at: [1, -2, 3], at2: [-4, 5, -6], yaw: 7, pitch: 64, aim: [9, -10], charge: 200, slot: 2, drive: 1 },
      { tick: t, player: 1, kind: 'meta', meta: 'timeAway', seconds: 30 },
      { tick: t, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'setTuning', args: [1.5, -2], tuning: { table: 'WORLD_TUNING', key: 'aiNearM', value: Infinity } } },
    ];
    for (const c of all) w.commands.push(c);
    const read = readSave(serializeWorld(w)).pending;
    expect(read).toEqual(all);
    for (let i = 0; i < all.length; i++) expect(Object.keys(read[i]), `pending[${i}]`).toEqual(Object.keys(all[i]));
    const dev = (read[4] as Extract<Command, { kind: 'meta' }>).dev!;
    expect([Object.keys(dev), Object.keys(dev.tuning!)]).toEqual([
      ['op', 'args', 'tuning'],
      ['table', 'key', 'value'],
    ]);
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
 * listed here; one that is state is saved by its system's record and listed with its place, a path into the save
 * (`bodies[].kcc.pushes`: `[]` steps into every element of a list) that the test resolves against a populated save.
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
    pairFilters: 'not saved: code (the pair filters systems register when the world is built)',
    hooks: "not saved: code (Rapier's contact-pair hook, calling the pair filters)",
  },
  WorldQueries: { physics: 'not saved: a link', entities: 'not saved: links to the entity store', ground: 'not saved: a link to the terrain (SIM-fix3)' },
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
    spoilLimit: 'not saved: derived from the heights and the dug mask (rebuilt on load, equal to the live field)',
    spoilKey: 'not saved: the tuning the spoil limit was built for',
  },
  GroundCover: {
    world: 'not saved: a link',
    grid: "saved: cover (edits against the generated cover; the grid's size and generated values regenerate from the seed)",
  },
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
  JointStore: {
    world: 'not saved: a link',
    byId: 'saved: joints (every joint, generation\'s included: restoreRecord replaces the store)',
    sorted: 'saved: joints (id order)',
    snapshot: 'not saved: a cache of sorted',
    rt: 'not saved: per-joint runtime (the Rapier joint, a world-point end\'s hidden fixed body, the rope sensor), made again from joints by restoreRecord',
    tripped: 'not saved: the strand groups whose tripwire load phase 9d took this tick (a crossing is counted once per tick)',
  },
  Breaking: {
    world: 'not saved: a link',
    pending: 'not saved: breaks found in phases 9c and 11 for phase 12 of the same tick, which empties it; empty at a tick end',
  },
  Loads: { world: 'not saved: a link' },
  Felling: {
    world: 'not saved: a link',
    moments: 'not saved: moments added in phases 4d and 9c for phase 13c of the same tick, which empties it; empty at a tick end',
    falls: "saved: felling (a falling trunk's phase and hinge; its runtime joint to the stump is made again from it and entities[].plant)",
  },
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
    enabled: 'not saved: off exactly while the slab is active or just handed back; DownedBodies.restoreRecord sets it from bodies[].slab',
    jump: 'not saved: a load resets the pose history, which sets it',
  },
  DownedBodies: {
    world: 'not saved: a link',
    byId: 'saved: bodies (each Slab as bodies[].slab)',
    ghosts: 'not saved: the active slabs with bodies they are not clear of, an index of Slab.clearOf (set again with it)',
  },
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
    clearOf: 'saved: bodies[].slab.notClearOf (by entity and fighter id; it only shrinks after the launch, so it is state)',
  },
  RulerBodies: {
    world: 'not saved: a link',
    mover: 'not saved: code (RulerMover)',
    byId: 'saved: bodies (each RulerBody as bodies[].ruler)',
    shoves: 'not saved: shoves the mover queued in phase 3, applied in phase 4d of the same tick (empty at a tick end)',
  },
  RulerBody: {
    f: 'not saved: the fighter (a link)',
    body: 'not saved: the ruler body, rebuilt (its pose and velocities are in bodies[].ruler)',
    cols: 'not saved: the bone colliders, rebuilt (posed from the rig standing, from the frozen pose in bodies[].ruler when dynamic)',
    offs: 'not saved: derived from the scale',
    keys: 'not saved: owner keys',
    dynamic: 'saved: bodies[].ruler (its dynamic flag)',
    local: 'saved: bodies[].ruler (its local frozen pose)',
    hist: 'saved: bodies[].ruler (its history)',
    jump: 'saved: bodies[].ruler (its jump flag)',
    last: "not saved: the root after the last resolve, the fighter's position at a tick end (a load sets it from the fighter's record)",
    climbFloor: 'saved: bodies[].ruler (its climbFloor)',
    deflect: 'saved: bodies[].ruler (its deflect)',
    supports: 'saved: bodies[].ruler (its supports)',
    coverBreak: 'saved: bodies[].ruler (its coverBreak)',
    move: "not saved: the root's velocity as this tick's phase 3 resolved it, with that tick, read by legStrike in phase 9 of the same tick (another tick's reads as still, so a load needs none)",
  },
  ContactSystem: {
    world: 'not saved: a link',
    episodes:
      'saved: contacts (one record per group: contacts[].creature, the subject, a fighter id or an entity id negated; contacts[].owner; contacts[].touching, contacts[].episodeStart, contacts[].cooldownUntil)',
    graceUntil: 'saved: contactGrace',
    resync: 'not saved: the restored groups still touching, from a load to its first phase 9 (null at every tick end); a load sets it again from contacts[].touching',
    restarts: "not saved: the load's own narrow-phase starts, held from a load to its first phase 9 (null at every tick end); a load makes them again",
    loadStarts: "not saved: the load's narrow-phase starts of contacts the save didn't hold, held from a load to its first phase 9 (null at every tick end); a load makes them again",
    scored: 'not saved: a dev read-out (impacts scored so far), never read by the sim',
    unscored: 'not saved: dev read-outs (pairs and episodes left unscored, by reason), never read by the sim',
  },
  Deaths: {
    world: 'not saved: a link',
    pending: 'not saved: KOs noted where they happen (phases 1c, 3, 9) for phase 15 of the same tick, which empties it; empty at a tick end',
    respawns: "saved: deaths (a dead player's fighter id → its respawn tick)",
    corpses: "saved: corpses (a creature's fighter id → the tick its corpse may go)",
  },
  VerbSystem: {
    world: 'not saved: a link',
    byFighter: "saved: verbs (by fighter id: the focus, a continuous verb that is on, a creature's tug; a removed fighter's state is dropped)",
  },
  MindRegistry: {
    world: 'not saved: a link',
    minds: 'saved: minds (by fighter id) and rng.minds',
    attackTick: "not saved: the tick a creature last started an attack, read in phase 3 of that same tick (two never start one on one tick)",
    attacker: 'not saved: who started it, read with attackTick in phase 3 of that same tick',
  },
  /** A creature's mind (an ape's: CreatureMind's fields and the inner BrawlerAI). */
  ApeMind: {
    cfg: 'not saved: the AI config its maker gives it (CREATURE_TUNING when the ape is made)',
    director: "not saved: CombatSim's AIDirector (a link; its state is saved as director)",
    drops: "not saved: CombatSim's drops (a link; saved as drops)",
    ownsTarget: 'not saved: a constant (the mind picks its target)',
    state: 'saved: minds[].state',
    stateTick: 'saved: minds[].stateTick',
    resume: 'saved: minds[].resume',
    mark: 'saved: minds[].mark',
    paused: 'saved: minds[].paused',
    senses: 'system: Senses',
    path: 'system: PathFollower',
    rng: "saved: minds[].rng and rng.minds (the world's mind stream)",
    self: 'not saved: its fighter (a link; minds[].fighter names it)',
    world: 'not saved: a link',
    hurt: 'saved: minds[].hurt',
    home: 'saved: minds[].home',
    homeIdx: 'saved: minds[].homeIdx',
    routeIdx: 'saved: minds[].routeIdx',
    restUntil: 'saved: minds[].restUntil',
    cooldownUntil: 'saved: minds[].cooldownUntil',
    fleeUntil: 'saved: minds[].fleeUntil',
    heading: 'saved: minds[].heading',
    charge: 'saved: minds[].charge',
    current: 'saved: minds[].script',
    inner: "saved: minds[].inner (the inner BrawlerAI's history fields; its cfg and plan are the maker's, its rng CombatSim's)",
  },
  /** The giant ape's mind (P20): CreatureMind's fields, no inner AI, and the route set by hand. */
  RulerMind: {
    cfg: 'not saved: the AI config its maker gives it (passive: rulers never block)',
    director: "not saved: CombatSim's AIDirector (a link; its state is saved as director)",
    drops: "not saved: CombatSim's drops (a link; saved as drops)",
    ownsTarget: 'not saved: a constant (the mind picks its target)',
    state: 'saved: minds[].state',
    stateTick: 'saved: minds[].stateTick',
    resume: 'saved: minds[].resume',
    mark: 'saved: minds[].mark',
    paused: 'saved: minds[].paused',
    senses: 'system: Senses',
    path: 'system: PathFollower',
    rng: "saved: minds[].rng and rng.minds (the world's mind stream)",
    self: 'not saved: its fighter (a link; minds[].fighter names it)',
    world: 'not saved: a link',
    hurt: 'saved: minds[].hurt',
    home: 'saved: minds[].home (the lair)',
    homeIdx: 'saved: minds[].homeIdx',
    routeIdx: 'saved: minds[].routeIdx',
    restUntil: 'saved: minds[].restUntil',
    cooldownUntil: 'saved: minds[].cooldownUntil (the charge cooldown)',
    fleeUntil: 'saved: minds[].fleeUntil',
    heading: 'saved: minds[].heading (the committed charge heading, the climb heading)',
    charge: 'saved: minds[].charge',
    current: 'saved: minds[].script',
    routeOverride: "saved: minds[].route (a giant's record only: null when it follows the spawn data's route)",
    climb: "saved: minds[].climb (a giant's record only: null with no climb out of a pit under way)",
  },
  Senses: {
    awareness: 'saved: minds[].awareness',
    lkp: 'saved: minds[].lkp',
    lkpTick: 'saved: minds[].lkpTick',
    lastSeenTick: 'saved: minds[].lastSeenTick',
    stimulus: 'saved: minds[].stimulus',
  },
  PathFollower: {
    layer: "not saved: the species' nav layer, given when the mind is made",
    points: 'saved: minds[].path.points',
    i: 'saved: minds[].path.i',
    goal: 'saved: minds[].path.goal',
    complete: 'saved: minds[].path.complete',
    tiles: 'saved: minds[].path.tiles',
    versions: 'saved: minds[].path.versions (a load rebuilds the navmesh with versions from 1: the mind re-paths once, TODO(M3))',
    requestTick: 'saved: minds[].path.requestTick',
    pending: 'saved: minds[].path.pending',
    stuck: 'saved: minds[].stuck',
  },
  NoiseBus: {
    world: 'not saved: a link',
    queue: "not saved: noises, hurts and wounds waiting for phase 17b's fold, which empties it (minds emit in phase 2); empty at a tick end (§8.3)",
  },
  Spawner: {
    world: 'not saved: a link',
    data: "not saved: the world's spawn data (generation's output), regenerated from the seed",
    homes: 'saved: spawner.homes (each home slot: its living ape, the tick its respawn is due)',
    sparring: 'saved: spawner.sparring (the sparring ape, the tick its respawn is due)',
  },
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
 * Inventory entries matched against only part of a live object: the fields listed must be on it, and the object's
 * other fields are inventoried elsewhere (a fighter's by P04's records.test.ts, through its record).
 */
const PARTIAL: Record<string, (w: World) => object> = { Fighter: (w) => w.player! };
/** Inventory entries with no runtime object of their own: the process-wide registry and the save's own tags. */
const DESCRIPTIVE = ['Registry', 'Save'];

/**
 * `saved:` places that a populated test scene can't reach, because a list it steps into is empty there. Each says why;
 * every other place a `saved:` verdict names is checked against a populated save.
 */
const UNREACHED: Record<string, string> = {};

/**
 * `saved:` places that only some records of a list have (P20): checked against the records that must have them, in a
 * populated save that has at least one; the other records must not have them.
 */
const KIND_ONLY: Record<string, { why: string; has: (s: SaveV1) => { yes: unknown[]; no: unknown[] } }> = {
  'minds[].route': {
    why: "only a giant's mind has a patrol route of its own (RulerMind); an ape's record has no such field",
    has: (s) => ({ yes: s.minds.filter((m) => m.kind === 'giantApe'), no: s.minds.filter((m) => m.kind !== 'giantApe') }),
  },
  'minds[].climb': {
    why: "only a giant's mind climbs out of a pit (RulerMind); an ape's record has no such field",
    has: (s) => ({ yes: s.minds.filter((m) => m.kind === 'giantApe'), no: s.minds.filter((m) => m.kind !== 'giantApe') }),
  },
};

/** The populated scenes' creature: an ape 8 m off the player, a mind with a path, its inner BrawlerAI and its senses. */
function addApe(w: World): CreatureMind {
  const f = createCreature(w, 'ape', { x: 8, z: -8 }, 0);
  return w.minds.get(f)!;
}

/** A save path: a save key, then `.field` steps; `name[]` steps into every element of a list. */
const SAVE_PATH = /[A-Za-z]+(?:\[\])?(?:\.[A-Za-z]+(?:\[\])?)*/g;

/** Every place in the save a `saved:` verdict names (each path in it whose first step is a save key). */
function savedPaths(verdict: string): string[] {
  if (!verdict.startsWith('saved: ')) return [];
  return [...verdict.slice('saved: '.length).matchAll(SAVE_PATH)].map((m) => m[0]).filter((p) => (SAVE_V1_KEYS as readonly string[]).includes(p.split(/[.[]/)[0]));
}

/** The first step of `path` that isn't in `v` (a list stepped into must have elements), or null when all are. */
function missingStep(v: unknown, path: string): string | null {
  let here: unknown[] = [v];
  let at = '';
  for (const step of path.split('.')) {
    const list = step.endsWith('[]');
    const key = list ? step.slice(0, -2) : step;
    at = at ? `${at}.${step}` : step;
    const next: unknown[] = [];
    for (const o of here) {
      if (o === null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, key)) return at;
      const x = (o as Record<string, unknown>)[key];
      if (!list) next.push(x);
      else if (Array.isArray(x) && x.length > 0) next.push(...x);
      else return `${at} (no element)`;
    }
    here = next;
  }
  return null;
}

/**
 * Save keys whose runtime source arrives with a later package: the system is a stub that holds nothing yet, and its
 * record (an empty list) is already in the save. Each leaves this list when its package adds the state to the
 * inventory above. (Empty since P22 placed the Spawner's slots.)
 */
const AWAITING: Record<string, string> = {};

describe('completeness (RR-19)', () => {
  /** Every inventoried object of a populated world, by inventory entry. */
  function systems(w: World, e: number, mind: CreatureMind, giant: number, rulerMind: CreatureMind): Record<string, object> {
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
      RulerBody: byId(w.rulers).get(giant)!,
      ContactSystem: w.contacts,
      Deaths: w.deaths,
      VerbSystem: w.verbs,
      MindRegistry: w.minds,
      ApeMind: mind,
      RulerMind: rulerMind,
      Senses: mind.senses,
      PathFollower: mind.path,
      NoiseBus: w.noise,
      Spawner: w.spawner,
      ...(w.nav ? { NavSystem: w.nav } : {}),
    };
  }

  it('every runtime field of every world system is saved, a system, or not saved for a reason', async () => {
    const w = await make({ nav: 'full' });
    const ids = populate(w);
    const mind = addApe(w);
    // A ruler (P11's RulerBody is reached through it), away from the scene; and the giant ape with its mind (P20).
    const giant = addGiant(w, -15, 15);
    const rulerMind = w.minds.get(createCreature(w, 'giantApe', { x: 15, z: 15 }, 0))!;
    run(w, 20, new Rng(4));
    expect(mind).toBeInstanceOf(ApeMind);
    expect(rulerMind).toBeInstanceOf(RulerMind);
    const sys = systems(w, ids.log, mind, giant.id, rulerMind);
    const diffs: { entry: string; notInInventory: string[]; notOnObject: string[] }[] = [];
    for (const [name, o] of Object.entries(sys)) {
      const have = Object.keys(o).sort();
      const listed = Object.keys(INVENTORY[name] ?? {}).sort();
      const missing = have.filter((k) => !listed.includes(k));
      const gone = listed.filter((k) => !have.includes(k));
      if (missing.length > 0 || gone.length > 0) diffs.push({ entry: name, notInInventory: missing, notOnObject: gone });
    }
    expect(diffs).toEqual([]);
    // Every `system:` names an entry, every verdict is one of the three kinds.
    for (const [name, fields] of Object.entries(INVENTORY)) {
      for (const [k, v] of Object.entries(fields)) {
        expect(v, `${name}.${k}`).toMatch(/^(saved|system|not saved): ./);
        const sysName = /^system: (\S+)/.exec(v)?.[1];
        if (sysName) expect(INVENTORY[sysName], `${name}.${k} → ${sysName}`).toBeDefined();
      }
    }
    // Every system object has an entry, and every entry is reached: matched against a whole object above, against part
    // of one (its listed fields are on it), or descriptive (no runtime object), and nothing is in two of those lists.
    for (const name of Object.keys(sys)) expect(Object.keys(INVENTORY)).toContain(name);
    const reached = [...Object.keys(sys), ...Object.keys(PARTIAL), ...DESCRIPTIVE];
    expect(new Set(reached).size).toBe(reached.length);
    expect(Object.keys(INVENTORY).filter((name) => !reached.includes(name))).toEqual([]);
    for (const [name, of] of Object.entries(PARTIAL)) {
      const o = of(w);
      for (const k of Object.keys(INVENTORY[name])) expect(Object.prototype.hasOwnProperty.call(o, k), `${name}.${k} is on the object`).toBe(true);
    }
  });

  it('every place a `saved:` verdict names is in a populated save (sub-fields of records and list elements included)', async () => {
    const w = await make();
    const ids = populate(w);
    const mind = addApe(w);
    run(w, 20, new Rng(5));
    w.entities.queueImpulse(ids.log, { x: 0, y: 1, z: 0 }, null);
    w.player!.ruler = rulerSample();
    expect(mind.path.goal).not.toBeNull(); // grazing: a path to its first wander point
    const s = parsed(serializeWorld(w));
    const paths = new Set(Object.values(INVENTORY).flatMap((fields) => Object.values(fields).flatMap(savedPaths)));
    // Not vacuous: the record sub-fields and list elements are among them.
    expect([...paths].filter((p) => p.includes('[]')).length).toBeGreaterThan(30);
    const missing: Record<string, string> = {};
    for (const p of [...paths].sort()) {
      if (p in KIND_ONLY) continue;
      const step = missingStep(s, p);
      if (step !== null && !(p in UNREACHED)) missing[p] = step;
    }
    expect(missing).toEqual({});
    // A place only some records have: on every one of them, on none of the others, in a save that has both kinds (the
    // scene's ape and the giant ape with its mind and a route set by hand, P20).
    const w2 = await make();
    addApe(w2);
    (w2.minds.get(createCreature(w2, 'giantApe', { x: -15, z: 15 }, 0)) as RulerMind).setRoute([
      { x: -15, z: 20 },
      { x: 15, z: 20 },
    ]);
    run(w2, 20, new Rng(5));
    const s2 = parsed(serializeWorld(w2)) as unknown as SaveV1;
    for (const [p, k] of Object.entries(KIND_ONLY)) {
      expect(paths.has(p), p).toBe(true);
      const [list, ...rest] = p.split('[].');
      const { yes, no } = k.has(s2);
      expect(no.length, `${p}: another kind's record`).toBeGreaterThan(0);
      expect(yes.length, `${p}: ${k.why}`).toBeGreaterThan(0);
      expect(missingStep({ [list]: yes }, p), p).toBeNull();
      for (const r of no) expect(Object.prototype.hasOwnProperty.call(r, rest.join('.')), `${p} on another record`).toBe(false);
    }
    // An unreached place is one the populated save can't reach, and is still named by a verdict.
    for (const p of Object.keys(UNREACHED)) {
      expect(paths.has(p), p).toBe(true);
      expect(missingStep(s, p), p).toMatch(/\(no element\)$/);
    }
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
  'contacts',
  'felling',
  'deaths',
  'corpses',
] as const;
// Not compared: `bodies` (the zones' pose history is reset on load, MAP gap-7's exact restore is M3's), `contactGrace`
// (a zone reset opens a grace, §4.3), `navDirty` (the navmesh is rebuilt). The test below lists them, so a new key must
// be placed in one list or the other.
const NOT_EXACT = ['bodies', 'contactGrace', 'navDirty'] as const;

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

  it('keeps a creature mind mid-chase (RR-19): its state, senses, path, timers, stream and inner BrawlerAI, byte for byte', async () => {
    const w = await make({ nav: 'full' });
    populate(w);
    // An ape 12 m off the player, facing him, kept from grazing away (staging): it sees him and gives chase.
    const f = createCreature(w, 'ape', { x: 0, z: 12 }, Math.PI);
    const mind = w.minds.get(f) as ApeMind;
    mind.cooldownUntil = 1e9;
    mind.restUntil = 1e9;
    let n = 0;
    while (!(mind.state === 'chase' && mind.path.points.length > 0 && mind.path.i > 0) && n++ < 300) w.step();
    expect(mind.state).toBe('chase');
    // Mid-window after a hurt (stimulus Infinity), with a memory of it.
    mind.senses.stimulus = Infinity;
    mind.hurt = { tick: w.tick, point: { x: 0.5, y: 1, z: 11 } };
    const a = serializeWorld(w);
    const s = parsed(a) as unknown as SaveV1;
    expect(s.minds.length).toBe(1);
    expect(s.minds[0].state).toBe('chase');
    expect(s.minds[0].path).not.toBeNull();
    expect(s.minds[0].inner).not.toBeNull();
    expect(s.rng.minds).toEqual([[f.id, mind.rng.state]]);
    const l = await load(a, { nav: 'full' });
    const b = serializeWorld(l);
    const sa = sections(a, SAVE_V1_KEYS);
    const sb = sections(b, SAVE_V1_KEYS);
    for (const k of EXACT) expect(sb[k] === sa[k], `section ${k}`).toBe(true);
    // The loaded mind is the same mind on the loaded fighter, and it carries on with the chase.
    const lf = l.combat.fighters.find((x) => x.id === f.id)!;
    const lm = l.minds.get(lf) as ApeMind;
    expect(lm).toBeInstanceOf(ApeMind);
    expect(l.combat.ais.get(lf)).toBe(lm);
    expect(lm.senses.stimulus).toBe(Infinity);
    expect(lm.rng.state).toBe(mind.rng.state);
    expect(lf.target).toBe(l.player);
    for (let k = 0; k < 60; k++) l.step();
    expect(['chase', 'fight']).toContain(lm.state);
    expect(lf.distanceTo(l.player!)).toBeLessThan(f.distanceTo(w.player!));
  });

  it('is byte-identical with joints (a hanging log, a lashing, a hanging vine, a bend), loads and felling under way, and gives back the Rapier joints (P10)', async () => {
    const w = await make();
    // A 30 kg log hanging on a vine from a post (a taut rope with a tension ring).
    const post = spawnBox(w, { p: { x: 8, y: 3.2, z: 8 }, size: [0.4, 0.4, 0.4], material: 'dryWood', state: 'fixed', look: 'scaffold' });
    const hung = spawnLog(w, { p: { x: 8, y: 1.5, z: 8 }, length: 1, mass: 30 });
    w.joints.rope({ entity: post, local: { x: 0, y: -0.2, z: 0 } }, { entity: hung, local: { x: 0, y: 0, z: 0 } }, 1.5, { entity: spawnRopeCoil(w, { at: { x: 14, y: 0.2, z: 14 }, material: 'vine', lengthM: 2 }), lengthM: 1.5 }, ['p1']);
    // Two logs lashed together on the ground.
    const la = spawnLog(w, { p: { x: -8, y: 0.2, z: 8 }, length: 2, r: 0.1 });
    const lb = spawnLog(w, { p: { x: -8, y: 0.2, z: 8.4 }, length: 2, r: 0.1 });
    w.joints.lash({ entity: la, local: { x: 0, y: 0, z: 0.2 } }, { entity: lb, local: { x: 0, y: 0, z: -0.2 } }, { entity: spawnRopeCoil(w, { at: { x: 15, y: 0.2, z: 14 }, material: 'sinew', lengthM: 1 }), lengthM: 1 }, []);
    // A tree with a hanging vine (a rope with a loose end), and a sapling bent down to a stake.
    spawnTree(w, { at: { x: -10, z: -8 }, diameter: 0.3, height: 12, vine: { anchorH: 7, lengthM: 10, yaw: 0 } });
    const sap = spawnSapling(w, { at: { x: 8, z: -8 }, diameter: 0.06, height: 3 });
    const stake = spawnLog(w, { p: { x: 10, y: 0.2, z: -8 }, q: UPRIGHT, length: 1, r: 0.04, state: 'anchored' });
    // A rotten branch across two crates: it spans, so its own weight goes into its load history.
    spawnBox(w, { p: { x: -8, y: 0.25, z: -2.6 }, size: [0.4, 0.5, 0.4], material: 'dryWood', state: 'fixed', look: 'crate' });
    spawnBox(w, { p: { x: -8, y: 0.25, z: -1.4 }, size: [0.4, 0.5, 0.4], material: 'dryWood', state: 'fixed', look: 'crate' });
    const branch = spawnStick(w, { p: { x: -8, y: 0.54, z: -2 }, q: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, length: 1.8, r: 0.03, material: 'rottenWood' });
    // Two trees being felled: one notched, one falling.
    const notched = spawnTree(w, { at: { x: 14, z: 0 }, diameter: 0.3, height: 12 }).tree;
    const falling = spawnTree(w, { at: { x: -14, z: 0 }, diameter: 0.3, height: 12 }).tree;
    w.step();
    w.joints.bend(sap, { entity: sap, local: { x: 0, y: 1.5, z: 0 } }, { entity: stake, local: { x: 0, y: 0.5, z: 0 } }, { entity: spawnRopeCoil(w, { at: { x: 16, y: 0.2, z: 14 }, material: 'vine', lengthM: 2 }), lengthM: 2 }, ['p1']);
    w.felling.chop(notched, { x: -1, y: 0, z: 0 }, 0.06, ['p1']);
    w.felling.chop(falling, { x: 0, y: 0, z: 1 }, 0.3, ['p1']);
    run(w, 60, new Rng(13));
    const a = serializeWorld(w);
    const s = parsed(a) as unknown as SaveV1;
    // Not vacuous: five joints (the bend and its hold rope among them), tension rings, a load history, both trees.
    expect(s.joints.map((j) => j.kind).sort()).toEqual(['bend', 'lash', 'rope', 'rope', 'rope']);
    expect(s.joints.some((j) => j.tension.some((t) => t > 0))).toBe(true);
    expect(s.entities.find((e) => e.id === branch)!.loadHist.some((x) => x > 0)).toBe(true);
    expect(s.felling.map((f) => [f.tree, f.phase])).toEqual([
      [notched, 'notched'],
      [falling, 'falling'],
    ]);
    const l = await load(a);
    const b = serializeWorld(l);
    const sa = sections(a, SAVE_V1_KEYS);
    const sb = sections(b, SAVE_V1_KEYS);
    for (const k of EXACT) expect(sb[k] === sa[k], `section ${k}`).toBe(true);
    // The Rapier joints come back with the records: the lashing, the hanging log's rope, the bend, its hold rope and the
    // falling trunk's hinge to its stump (the vine with a loose end has none).
    const n = w.physics.rapier.impulseJoints.len();
    expect(n).toBe(5);
    l.step();
    expect(l.physics.rapier.impulseJoints.len()).toBe(n);
    // Two loads of the save go on alike.
    const l2 = await load(a);
    l2.step();
    for (let i = 0; i < 59; i++) {
      l.step();
      l2.step();
    }
    const c1 = sections(serializeWorld(l), SAVE_V1_KEYS);
    const c2 = sections(serializeWorld(l2), SAVE_V1_KEYS);
    for (const k of ['entities', 'joints', 'felling'] as const) expect(c1[k] === c2[k], `section ${k} after 60 ticks`).toBe(true);
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

  it('leaves out an impulse queued for an entity removed since (phase 4d drops it), so the save loads and saves again as it was', async () => {
    /** A scene, a 2 m/s upward push on the log, the stone removed; `stale`: a contact reaction queued on the stone first. */
    const scene = async (stale: boolean) => {
      const w = await make();
      const ids = populate(w);
      run(w, 10, new Rng(17));
      const push = { j: { x: 0, y: 2 * w.entities.get(ids.log)!.mass, z: 0 }, at: { x: 2, y: 0.2, z: 1 } };
      if (stale) w.entities.queueImpulse(ids.stone, { x: 1, y: 0, z: 0 }, null);
      w.entities.queueImpulse(ids.log, push.j, push.at);
      w.removeEntity(ids.stone);
      return { w, ids, push };
    };
    const { w, ids, push } = await scene(true);
    const twin = (await scene(false)).w;
    expect(w.entities.pendingImpulses().map((q) => q.id)).toEqual([ids.stone, ids.log]);
    const a = serializeWorld(w);
    expect((parsed(a) as unknown as SaveV1).impulses).toEqual([{ entity: ids.log, ...push }]);
    // The stale impulse is nothing the world will act on: the twin without it writes the same bytes and steps the same.
    expect(text(serializeWorld(twin)) === text(a)).toBe(true);
    // The save loads (the loader never queues an impulse on an entity it doesn't have) and saves again as it was.
    const l = await load(a);
    expect(l.entities.pendingImpulses()).toEqual([{ id: ids.log, ...push }]);
    const b = serializeWorld(l);
    const sa = sections(a, SAVE_V1_KEYS);
    const sb = sections(b, SAVE_V1_KEYS);
    for (const k of EXACT) expect(sb[k] === sa[k], `section ${k}`).toBe(true);
    // The next phase 4d drops the stone's impulse in the original and applies the log's push in all three.
    w.step();
    twin.step();
    l.step();
    for (const x of [w, twin, l]) expect(x.entities.pendingImpulses()).toEqual([]);
    expect(firstDiff(bodyStateBytes(w), bodyStateBytes(twin))).toBe(-1);
    expect(text(serializeWorld(w)) === text(serializeWorld(twin))).toBe(true);
    expect(w.entities.get(ids.log)!.vel.lin.y).toBeGreaterThan(1);
    expect(dist(l.entities.get(ids.log)!.vel.lin, w.entities.get(ids.log)!.vel.lin)).toBeLessThan(0.01);
  });

  it("keeps a fighter's verb state (focus, a continuous verb, a tug), writing its command in canonical key order", async () => {
    const w = await make();
    const ids = populate(w);
    run(w, 10, new Rng(19));
    // A continuous verb as P16's pull would leave it (hand-made, as P14's own test does), its command's keys out of order.
    const cmd = { charge: 255, verb: 'pull', kind: 'verb', target: ids.coil, player: 1, tick: 5 } as VerbCommand;
    const grip = { x: 0.5, y: 0, z: 0.1 };
    w.verbs.restoreRecord([{ fighter: 1, focus: { target: ids.log, at: null }, cont: { verb: 'pull', cmd, ticks: 7, data: [['strokes', 2], ['yank', 3]] }, tug: { entity: ids.log, grip } }]);
    const a = serializeWorld(w);
    const rec = (parsed(a) as unknown as SaveV1).verbs;
    expect(rec).toHaveLength(1);
    expect(Object.keys((rec[0].cont as { cmd: object }).cmd)).toEqual(['tick', 'player', 'kind', 'verb', 'target', 'charge']);
    const l = await load(a);
    expect(sections(serializeWorld(l), ['verbs']).verbs).toBe(sections(a, ['verbs']).verbs);
    const p = l.player!;
    expect(l.verbs.focusOf(p)).toEqual({ target: ids.log, at: null });
    expect(l.verbs.continuousOf(p)).toEqual({ verb: 'pull', cmd: { tick: 5, player: 1, kind: 'verb', verb: 'pull', target: ids.coil, charge: 255 }, ticks: 7, data: { strokes: 2, yank: 3 } });
    expect(l.verbs.workTarget(p)).toBe(ids.log);
  });

  it('lets the scene queries see every restored body from the first tick: supportAt, a ray, a teleport onto a box', async () => {
    const w = await make();
    const box = spawnBox(w, { p: { x: 4, y: 1, z: 4 }, size: [2, 2, 2], material: 'dryWood', state: 'fixed', look: 'crate' });
    run(w, 5, new Rng(18));
    const ray = (x: World) => x.queries.castRay({ x: 4, y: 5, z: 4 }, { x: 0, y: -1, z: 0 }, 10, { terrain: true, entities: 'all' });
    const support = w.supportAt(4, 4, 5);
    expect(support).toBeCloseTo(2, 5);
    const hit = ray(w);
    expect(hit?.owner).toEqual({ kind: 'entity', id: box });
    const bytes = serializeWorld(w);
    // Queries right after the load, before any step (the first tick's phases 1c-3 run before its phase-7 step).
    const l = await load(bytes);
    expect(l.supportAt(4, 4, 5)).toBe(support);
    expect(ray(l)).toEqual(hit);
    // A dev op's or a harness's teleport onto the box lands on it, as in the saved world.
    w.teleport(w.player!, 4, 4);
    l.teleport(l.player!, 4, 4);
    expect(w.player!.pos.y).toBeCloseTo(2, 5);
    expect(l.player!.pos.y).toBe(w.player!.pos.y);
    // Nothing moved: the loaded world's entities, controller and slab are where the save put them.
    const again = parsed(serializeWorld(track(await loadWorld(bytes, { nav: 'off' })))) as unknown as SaveV1;
    const saved = parsed(bytes) as unknown as SaveV1;
    expect(canonicalJson(again.entities)).toBe(canonicalJson(saved.entities));
    expect(canonicalJson(again.bodies.map((x) => [x.kcc, x.slab]))).toBe(canonicalJson(saved.bodies.map((x) => [x.kcc, x.slab])));
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

describe('the loader (core-fix)', () => {
  it('builds into a world made for a load: no player, no creatures, no navmesh until it builds one, once', async () => {
    const empty = track(new World({ seed: 7, scene: 'empty', size: 50, nav: 'full', player: true, sparringApe: false, load: true }));
    expect(empty.combat.fighters).toHaveLength(0);
    expect(empty.player).toBeNull();
    expect(empty.nav!.built).toBe(false);
    // The options still say what the saved world was built with (they are saved again as they are).
    expect(empty.options).toMatchObject({ player: true, sparringApe: false, nav: 'full' });
    expect('load' in empty.options).toBe(false);
    const w = await make({ nav: 'full' });
    populate(w);
    run(w, 20, new Rng(5));
    const bytes = serializeWorld(w);
    const build = vi.spyOn(NavSystem.prototype, 'build');
    try {
      const l = await load(bytes, { nav: 'full' });
      expect(build).toHaveBeenCalledTimes(1);
      expect(l.nav!.built).toBe(true);
      expect(l.combat.fighters.map((f) => f.id)).toEqual(w.combat.fighters.map((f) => f.id));
    } finally {
      build.mockRestore();
    }
  });

  it('keeps the saved contact graces and opens the load grace, and nothing else: no grace from making the fighters', async () => {
    const w = await make();
    const g = w.spawnCreature('giantApe', { x: 12, z: 12 }, 0);
    // (AC-5's "AI paused": the giant's mind only senses, so the test needs none of P20's decisions.)
    (w.minds.get(g) as CreatureMind).paused = true;
    run(w, 30, new Rng(6));
    const p = w.player!;
    w.contacts.grace(p.id, w.tick + 40);
    const bytes = serializeWorld(w);
    const s = parsed(bytes) as unknown as SaveV1;
    expect(s.contactGrace).toEqual([[p.id, w.tick + 40]]);
    const l = await load(bytes);
    // The player's saved grace (later than the load's); the giant's teleport while the loader made it (a grace to tick
    // 3) is not the save's and is gone; a ruler's load opens none here (its body's history reset is its own).
    expect(l.contacts.graceRecord()).toEqual([[p.id, w.tick + 40]]);
    expect(l.contacts.graceRecord().some(([id]) => id === g.id)).toBe(false);
    // And a save of the loaded world holds the same graces.
    expect((parsed(serializeWorld(l)) as unknown as SaveV1).contactGrace).toEqual(s.contactGrace);
  });

  it('a contact whose first step is the first step after a load still lands: a log on a lying player, saved on any tick before it', async () => {
    // A 300 kg log dropped 8 m onto a player held lying. The loader's zero-length step raises the start of a contact
    // the saved world's next step would have raised (the log already within reach of the slab at the save); the first
    // real step raises it no more. It is a new contact on that tick, scored as the original scores it.
    const hold = (p: Fighter) => {
      p.stunFrames = p.stateFrame + 1000;
    };
    const stage = async (): Promise<{ w: World; id: number }> => {
      const w = await make({ seed: 7 });
      const p = w.player!;
      for (let t = 0; t < 5; t++) w.step();
      const sim = w.combat;
      const orig = sim.stepBody;
      sim.stepBody = function (this: typeof sim) {
        sim.stepBody = orig;
        const ev = orig.call(sim);
        p.vel.set(0.5, 0, 0);
        p.enterKnockdown();
        ev.push({ type: 'hit', attacker: p, defender: p, move: { lift: 0 }, knockdown: true, ko: false } as never);
        return ev;
      };
      for (let t = 0; t < 120; t++) {
        w.step();
        hold(p);
      }
      const hip = w.downed.hip(p.id)!;
      const id = spawnLog(w, { p: { x: hip.x, y: hip.y + 8, z: hip.z }, length: 3, mass: 300 });
      return { w, id };
    };
    type Hit = { tick: number; damage: number; energy: number };
    const hitsUntil = (w: World, id: number, end: number): Hit[] => {
      const out: Hit[] = [];
      const p = w.player!;
      while (w.tick < end) {
        const r = w.step();
        hold(p);
        for (const e of r.world) if (e.type === 'impact' && e.defender === p && e.cause.kind === 'entity' && e.cause.entityId === id) out.push({ tick: e.tick, damage: e.damage, energy: e.energy });
      }
      return out;
    };
    const a = await stage();
    const want = hitsUntil(a.w, a.id, a.w.tick + 200);
    // (The log lands on the body at T and, after it, once more on its way off.)
    expect(want.length).toBeGreaterThanOrEqual(1);
    expect(want[0].damage).toBeGreaterThan(30);
    const T = want[0].tick;
    // Saved on each of the ticks before the impact's (the contact's first step is T's): the loaded world scores it on
    // the same tick with the same HP (a load is not bit-exact for Rapier's solver state: within 0.1 %). Saved on T
    // itself: it is not scored again.
    for (let s = T - 4; s <= T; s++) {
      const b = await stage();
      expect(hitsUntil(b.w, b.id, s)).toEqual(want.filter((h) => h.tick <= s));
      const l = await load(serializeWorld(b.w));
      const got = hitsUntil(l, b.id, T + 10);
      if (s === T) {
        expect(got, `saved at tick ${s}`).toEqual([]);
        continue;
      }
      expect(got, `saved at tick ${s}`).toHaveLength(1);
      expect(got[0].tick, `saved at tick ${s}`).toBe(T);
      expect(Math.abs(got[0].damage / want[0].damage - 1), `saved at tick ${s}: ${got[0].damage} HP`).toBeLessThan(1e-3);
    }
  });
});

describe('a world at rest', () => {
  it("saved and loaded, matches the original within 1 cm and 1° over 10 s, and its contacts carry on as the original's", async () => {
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
    const saved = serializeWorld(w);
    // The contact episodes it restores (§4.3, RR-19): resting entities (subjects as negated ids) on the terrain and on
    // each other, still touching.
    const restored = (parsed(saved) as unknown as SaveV1).contacts;
    expect(restored.filter((c) => c.creature < 0 && c.touching > 0).length).toBeGreaterThan(3);
    expect(restored.some((c) => c.owner.startsWith('entity:') && c.touching > 0)).toBe(true);
    const contactsOf = (x: World): string => canonicalJson(saveRecord(x).contacts);
    const l = await load(saved);
    let worstM = 0;
    let worstDeg = 0;
    for (let t = 1; t <= 600; t++) {
      w.step();
      l.step();
      // Not ended by the loaded world's first phase 9 (the load's narrow phase re-raised them), never begun again.
      if (t === 1 || t % 60 === 0) expect(contactsOf(l), `contacts after ${t} ticks`).toBe(contactsOf(w));
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

  it("with applyTuning, runs on the saving world's sim tuning: a stray sim value this process holds goes back to its default", async () => {
    const bytes = await savedWithOverride();
    const restTicks = getTuningValue('PHYSICS_TUNING', 'restTicks');
    // A live dev-panel tweak to a sim table the save doesn't override, one to a table it does, and a client tweak.
    setTuningValue('PHYSICS_TUNING', 'restTicks', 77);
    setTuningValue('WORLD_TUNING', 'corpseDespawnS', 5);
    CLIENT_TEST_TUNING.knob = 3;
    const l = await load(bytes, { applyTuning: true });
    expect(getTuningValue('PHYSICS_TUNING', 'restTicks')).toBe(restTicks);
    expect(WORLD_TUNING.corpseDespawnS).toBe(77);
    expect(getTuningValue('PHYSICS_TUNING', 'restSpeed')).toBe(0.06);
    // The sim's tuning is now exactly the saving world's: its overrides and nothing else.
    expect(saveRecord(l).tuningOverrides).toEqual(readSave(bytes).tuningOverrides);
    // The client's own tables are not the save's.
    expect(CLIENT_TEST_TUNING.knob).toBe(3);
  });

  it('puts the registry back when the load fails', async () => {
    const bytes = await savedWithOverride();
    // A stray sim value too: the load resets the sim tables before it fails, and the registry comes back as it was.
    setTuningValue('PHYSICS_TUNING', 'restTicks', 44);
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

  const refuseIn = (bytes: Uint8Array, edit: (s: Record<string, unknown>) => void, message: string | RegExp) => {
    expect(() => readSave(edited(bytes, edit))).toThrow(message);
  };
  const refuse = (edit: (s: Record<string, unknown>) => void, message: string | RegExp) => refuseIn(good, edit, message);

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

  it("checks a fighter record's fields against the ones this build writes, and the kinds of its lists", () => {
    refuse((s) => delete (s.fighters as Record<string, unknown>[])[0].stamina, 'fighters[0].stamina is missing, not there');
    refuse((s) => ((s.fighters as Record<string, unknown>[])[0].mood = 'calm'), "fighters[0] has a field this version doesn't have: mood");
    refuse((s) => ((s.fighters as Record<string, unknown>[])[0].wounds = {}), 'fighters[0].wounds is {}, not an array');
    refuse((s) => ((s.fighters as Record<string, unknown>[])[0].anim = null), 'fighters[0].anim is null, not an object');
    refuse((s) => ((s.fighters as Record<string, unknown>[])[0].species = 'yeti'), 'fighters[0].species is "yeti"');
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

  it('reads contacts with a signed subject (a fighter, or an entity negated), checked against the counters, in their form and order', () => {
    const s0 = parsed(good) as unknown as SaveV1;
    // A body landed on the terrain: an entity subject, as ContactSystem writes it; it reads as it is.
    expect(s0.contacts.some((c) => c.creature < 0)).toBe(true);
    expect(readSave(good).contacts).toEqual(s0.contacts);
    const group = (c: Record<string, unknown>) => ({ creature: -1, owner: 'terrain', touching: 1, episodeStart: 3, cooldownUntil: -1, ...c });
    const one = (c: Record<string, unknown>) => (s: Record<string, unknown>) => {
      s.contacts = [group(c)];
    };
    // Both kinds of subject, each against each kind of owner it can have, in order.
    const all = [group({ owner: 'entity:2' }), group({ owner: 'terrain' }), group({ creature: 1, owner: 'entity:1' }), group({ creature: 1, owner: 'terrain' })];
    expect(readSave(edited(good, (s) => (s.contacts = all))).contacts).toEqual(all);
    refuse(one({ creature: 0 }), 'contacts[0].creature is 0, not a fighter id (> 0) or a negated entity id (< 0)');
    refuse(one({ creature: 1.5 }), 'contacts[0].creature is 1.5, not a whole number');
    refuse(one({ owner: 'tree:1' }), 'contacts[0].owner is "tree:1", not \'terrain\'');
    refuse(one({ creature: -999 }), 'save record: contacts[0].creature names entity 999, which is not below counters.entity');
    refuse(one({ creature: 9 }), 'save record: contacts[0].creature names fighter 9, which is not below counters.fighter');
    refuse(one({ owner: 'rope:4' }), 'save record: contacts[0].owner names joint 4, which is not below counters.joint');
    refuse(one({ owner: 'fighter:1' }), "save record: contacts[0] is entity 1 against fighter:1, not ContactSystem's form");
    refuse(one({ owner: 'entity:1' }), "save record: contacts[0] is entity 1 against entity:1, not ContactSystem's form");
    refuse((s) => (s.contacts = [...all].reverse()), 'save record: contacts are not sorted by (creature, owner) without repeats at contacts[1]');
    refuse((s) => (s.contacts = [group({}), group({ touching: 2 })]), 'save record: contacts are not sorted by (creature, owner) without repeats at contacts[1]');
    refuse((s) => (s.contactGrace = [[999, 40]]), 'save record: contactGrace[0] names fighter 999, which is not below counters.fighter');
    refuse(
      (s) =>
        (s.contactGrace = [
          [1, 40],
          [1, 41],
        ]),
      'save record: contactGrace is not in increasing fighter order at contactGrace[1]',
    );
  });

  it("checks a ruler body field by field (P11's RulerBodies record), and the entities its mover remembers against the counter", async () => {
    const w = await createWorld({ seed: 5, scene: 'empty', nav: 'off', size: 25 });
    addGiant(w, 0, 0);
    run(w, 5, new Rng(5));
    const bytes = serializeWorld(w);
    w.dispose();
    const s0 = parsed(bytes) as unknown as SaveV1;
    const i = s0.bodies.findIndex((b) => b.ruler !== null);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s0.counters.entity).toBe(1);
    const at = `save record: bodies[${i}].ruler`;
    const ruler = (s: Record<string, unknown>): Record<string, unknown> => (s.bodies as Record<string, unknown>[])[i].ruler as Record<string, unknown>;
    const no = (edit: (r: Record<string, unknown>) => void, message: string) => refuseIn(bytes, (s) => edit(ruler(s)), message);
    // As written, every field reads back as it is.
    expect(readSave(bytes).bodies[i].ruler).toEqual(s0.bodies[i].ruler);
    const zero = { x: 0, y: 0, z: 0 };
    const unit = { x: 0, y: 0, z: 0, w: 1 };
    no((r) => (r.dynamic = 1), `${at}.dynamic is 1, not a boolean`);
    no((r) => delete r.coverBreak, `${at}.coverBreak is missing, not there`);
    no((r) => (r.mood = 'calm'), `${at} has a field this version doesn't have: mood`);
    no((r) => (r.pose = { p: zero, q: { x: 0, y: 0, z: 0 } }), `${at}.pose.q.w is missing, not there`);
    no((r) => (r.lin = { x: Infinity, y: 0, z: 0 }), `${at}.lin.x is Infinity, not a finite number`);
    no((r) => (r.history = [1, 2, 3]), `${at}.history is 3, not 0 or ${6 * BONES.length} numbers`);
    no((r) => (r.local = [{ bone: 'pelvis', p: zero, q: unit }]), `${at}.local is 1, not 0 bones (dynamic false)`);
    no((r) => (r.dynamic = true), `${at}.local is 0, not ${BONES.length} bones (dynamic true)`);
    no((r) => (r.local = [{ bone: 'head', p: zero, q: unit }]), `${at}.local[0].bone is "head", not the bone ${BONES[0]} (BONES order)`);
    no((r) => (r.sleeping = null), `${at}.sleeping is null, not a boolean`);
    no((r) => (r.climbFloor = 'low'), `${at}.climbFloor is "low", not a finite number`);
    no((r) => (r.deflect = { entity: 0, tick: 3 }), `${at}.deflect.entity is 0, not a whole number ≥ 1`);
    no((r) => (r.deflect = { entity: 1, tick: 3, by: 2 }), `${at}.deflect has a field this version doesn't have: by`);
    no((r) => (r.supports = [{ entity: 3, tick: 1, credit: [7] }]), `${at}.supports[0].credit[0] is 7, not a string`);
    no(
      (r) => (r.supports = [{ entity: 3, tick: 1, credit: [] }, { entity: 3, tick: 2, credit: [] }]),
      `${at}.supports[1].entity is 3, not an entity after the one before it (increasing, no repeats)`,
    );
    no((r) => (r.coverBreak = { tick: 2, cause: { kind: 'magic', entityId: null, fighterId: null, credit: [], held: false, feature: 'cover' } }), `${at}.coverBreak.cause.kind is "magic"`);
    // The entities it names: below the counter (a support outlives its entity, an unmade id doesn't).
    no((r) => (r.supports = [{ entity: 3, tick: 1, credit: [] }]), `${at}.supports[0].entity names entity 3, which is not below counters.entity (1)`);
    no((r) => (r.deflect = { entity: 1, tick: 3 }), `${at}.deflect.entity names entity 1, which is not below counters.entity (1)`);
    no(
      (r) => (r.coverBreak = { tick: 2, cause: { kind: 'entity', entityId: 4, fighterId: null, credit: [], held: false, feature: 'cover' } }),
      `${at}.coverBreak.cause.entityId names entity 4, which is not below counters.entity (1)`,
    );
  });

  it("checks what a slab is not clear of (core-fix): ids increasing, none while the slab is off, each below its counter", () => {
    const s0 = parsed(good) as unknown as SaveV1;
    const i = s0.bodies.findIndex((b) => b.slab !== null);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(readSave(good).bodies[i].slab!.notClearOf).toEqual({ entities: [], fighters: [] });
    const at = `save record: bodies[${i}].slab.notClearOf`;
    const no = (edit: (r: Record<string, unknown>) => void, message: string | RegExp) =>
      refuse((s) => edit((s.bodies as Record<string, unknown>[])[i].slab as Record<string, unknown>), message);
    const on = (n: { entities: number[]; fighters: number[] }) => (r: Record<string, unknown>) => {
      r.enabled = true;
      r.notClearOf = n;
    };
    no((r) => delete r.notClearOf, `${at} is missing, not there`);
    no((r) => (r.notClearOf = { entities: [] }), `${at}.fighters is missing, not there`);
    no((r) => (r.notClearOf = { entities: [], fighters: [], bodies: [] }), `${at} has a field this version doesn't have: bodies`);
    no((r) => (r.notClearOf = { entities: [1], fighters: [] }), /notClearOf\.entities is .*, not empty \(the slab is off\)/);
    no(on({ entities: [-1], fighters: [] }), `${at}.entities[0] is -1, not a whole number ≥ 0`);
    no(on({ entities: [2, 1], fighters: [] }), `${at}.entities[1] is 1, not an id after the one before it (increasing, no repeats)`);
    no(on({ entities: [], fighters: [3, 3] }), `${at}.fighters[1] is 3, not an id after the one before it (increasing, no repeats)`);
    no(on({ entities: [999], fighters: [] }), `${at}.entities[0] names entity 999, which is not below counters.entity`);
    no(on({ entities: [], fighters: [999] }), `${at}.fighters[0] names fighter 999, which is not below counters.fighter`);
  });

  it("checks a fighter's verb state field by field, and its fighter and entities against the save", () => {
    const rec = (r: Record<string, unknown>) => (s: Record<string, unknown>) => {
      s.verbs = [{ fighter: 1, focus: null, cont: null, tug: null, ...r }];
    };
    const pull = (c: Record<string, unknown> = {}, cmd: Record<string, unknown> = {}) => ({
      verb: 'pull',
      cmd: { tick: 5, player: 1, kind: 'verb', verb: 'pull', target: 0, charge: 255, ...cmd },
      ticks: 7,
      data: [['yank', 3]],
      ...c,
    });
    expect(readSave(edited(good, rec({ focus: { target: 2, at: { x: 1, y: 0, z: 1 } }, cont: pull() }))).verbs).toHaveLength(1);
    refuse((s) => (s.verbs = [{ fighter: 1, focus: null, cont: null }]), 'save record: verbs[0].tug is missing, not there');
    refuse(rec({ mood: 1 }), "save record: verbs[0] has a field this version doesn't have: mood");
    refuse(rec({ focus: { target: -2, at: null } }), 'verbs[0].focus.target is -2, not a whole number ≥ 0');
    refuse(rec({ cont: pull({}, { dir: 1 }) }), "save record: verbs[0].cont.cmd has a field this version doesn't have: dir");
    refuse(rec({ cont: pull({}, { verb: 'cut' }) }), 'save record: verbs[0].cont.cmd.verb is "cut", not the continuous verb "pull"');
    refuse(rec({ cont: pull({ data: [['yank', 3], ['a', 1]] }) }), 'save record: verbs[0].cont.data[1][0] is "a", not a key after the one before it');
    refuse(rec({ fighter: 7 }), "save record: verbs[0] names fighter 7, who isn't among the fighters");
    refuse(rec({ tug: { entity: 999, grip: { x: 0, y: 0, z: 0 } } }), 'save record: verbs[0].tug.entity names entity 999, which is not below counters.entity');
    refuse(
      (s) =>
        (s.verbs = [
          { fighter: 1, focus: null, cont: null, tug: null },
          { fighter: 1, focus: null, cont: null, tug: null },
        ]),
      'save record: verbs are not in increasing fighter order at verbs[1]',
    );
  });

  it('refuses an impulse on an entity the loaded world would not have', async () => {
    const push = { j: { x: 1, y: 0, z: 0 }, at: null };
    refuse((s) => (s.impulses = [{ entity: 999, ...push }]), 'save record: impulses[0] names entity 999, which is not below counters.entity');
    refuse(
      (s) => {
        s.removed = [2];
        s.impulses = [{ entity: 2, ...push }];
      },
      'save record: impulses[0] names entity 2, which the save lists as removed',
    );
    // Below the counter, not removed, yet neither saved nor regenerated (a non-generated entity gone before the save).
    let id = 0;
    const gone = edited(good, (s) => {
      const list = s.entities as { id: number }[];
      id = list[0].id;
      list.splice(0, 1);
      s.impulses = [{ entity: id, ...push }];
    });
    await expect(loadWorld(gone, { nav: 'off' })).rejects.toThrow(`save record: impulses[0] names entity ${id}, which isn't in the loaded world`);
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
