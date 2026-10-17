// Dev ops (docs/M1-DESIGN.md §1.5.3, §3 phase 1c, §10.10; RF-19, RR-17; package P22): every `meta 'dev'` op is a
// tick-tagged command applied in phase 1c of its tick. Each case runs twice from one seed: run A builds the command
// log from its world and records what the op changed; run B (tuning reset first) replays that log. In both runs the op
// has not acted at tick t − 1 and has at tick t, the two runs read the same at both ticks, and their saves a few ticks
// later are byte-identical. setTuning reaches the world through the log alone (run B starts from the defaults).
//
// Scenes are flat `scene 'empty'` worlds (nav off); positions, ticks and seeds are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializeWorld } from '../src/save/serialize';
import type { Command, DevOp, MetaCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { getTuningValue, resetTuning } from '../src/tuning/registry';
import type { ClearingSpawnData } from '../src/world/clearing';
import { ApeMind } from '../src/world/creatures/apeMind';
import { RulerMind } from '../src/world/creatures/rulerMind';
import { DEV_OPS_TUNING, GIVE_TOOLS } from '../src/world/devOps';
import { physicsReady } from '../src/world/physics';
import { toolClass } from '../src/world/verbs/tools';
import { createWorld, type World } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

vi.setConfig({ testTimeout: 120_000 });

/** AC-7's seed (§11.7). */
const S = 20261017;
/** The tick every op is tagged for. */
const T = 12;
/** Ticks run after it before the saves are compared. */
const AFTER = 6;

const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
});
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }): number => Math.atan2(to.x - from.x, to.z - from.z);
const angleOff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const byId = (w: World, id: number): Fighter | undefined => w.combat.fighters.find((f) => f.id === id);
const apes = (w: World): Fighter[] => w.combat.fighters.filter((f) => f.species === 'ape');
const giants = (w: World): Fighter[] => w.combat.fighters.filter((f) => f.species === 'giantApe');
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function devCmd(op: DevOp, args: number[], tuning?: NonNullable<MetaCommand['dev']>['tuning']): MetaCommand {
  return { tick: T, player: 1, kind: 'meta', meta: 'dev', dev: tuning ? { op, args, tuning } : { op, args } };
}

/** Spawn data with one home (no loop) and, given, a lair: set as the spawner's without spawning anything. */
function spawnData(home: { x: number; z: number } | null, lair: { x: number; z: number } | null): ClearingSpawnData {
  return { playerYaw: 0, apeHomes: home ? [{ home, loop: [] }] : [], lair, route: [], hardFallbacks: 0 };
}

interface Case<P> {
  /** Deterministic world setup at tick 0 (the same in both runs; nothing random, nothing wall-clock). */
  setup?: (w: World) => void;
  /** The commands of the log, built from run A's world after its setup (ids are the same in the replay). */
  log: (w: World) => Command[];
  /** What the op changes, as plain data. */
  probe: (w: World) => P;
  /** Checks run A's tick-t world against the tick t − 1 probe. */
  check: (w: World, before: P, after: P) => void;
}

interface Run<P> {
  before: P;
  after: P;
  save: Uint8Array;
  log: Command[];
}

async function runOnce<P>(c: Case<P>, given: Command[] | null): Promise<Run<P>> {
  const w = await createWorld({ seed: S, scene: 'empty', nav: 'off' });
  live.push(w);
  c.setup?.(w);
  const log = given ?? c.log(w);
  for (const cmd of log) w.commands.push(structuredClone(cmd));
  while (w.tick < T - 1) w.step();
  const before = structuredClone(c.probe(w));
  w.step();
  expect(w.tick).toBe(T);
  const after = structuredClone(c.probe(w));
  expect(after, 'the op changed the world at its own tick').not.toEqual(before);
  c.check(w, before, after);
  for (let i = 0; i < AFTER; i++) w.step();
  return { before, after, save: serializeWorld(w), log };
}

/** Run A, then run B replaying A's command log from the tuning defaults: the op lands at tick t in both, alike. */
async function replayed<P>(c: Case<P>): Promise<{ a: Run<P>; b: Run<P> }> {
  const a = await runOnce(c, null);
  resetTuning();
  const b = await runOnce(c, structuredClone(a.log));
  expect(b.before).toEqual(a.before);
  expect(b.after).toEqual(a.after);
  expect(Buffer.from(b.save).equals(Buffer.from(a.save)), 'the replay saves the same bytes').toBe(true);
  return { a, b };
}

const pos = (f: Fighter) => ({ id: f.id, x: r3(f.pos.x), z: r3(f.pos.z), alive: f.alive, state: f.state });

describe('every dev op is a command applied at its tick, in both runs of a replay (§1.5.3, RF-19)', () => {
  it('spawnApe [xCm, zCm]: an ape standing at (x, z), facing the player', async () => {
    const at = { x: 6, z: -4 };
    await replayed({
      log: () => [devCmd('spawnApe', [at.x * 100, at.z * 100])],
      probe: (w) => apes(w).map(pos),
      check: (w, before, after) => {
        expect(before).toEqual([]);
        expect(after).toHaveLength(1);
        const [a] = apes(w);
        expect(flat(a.pos, at)).toBeLessThan(0.01);
        // Made facing the player in phase 1c; its mind (phase 2 of the same tick) may already have turned it a little.
        expect(angleOff(a.yaw, yawTo(at, w.player!.pos))).toBeLessThan(0.25);
        expect(w.minds.get(a)).toBeInstanceOf(ApeMind);
      },
    });
  });

  it("spawnGiant []: the giant at the spawn data's lair, homed there; [xCm, zCm]: at that point", async () => {
    const lair = { x: 0, z: -40 };
    await replayed({
      setup: (w) => {
        w.spawner.data = spawnData(null, lair);
      },
      log: () => [devCmd('spawnGiant', [])],
      probe: (w) => giants(w).map(pos),
      check: (w, before) => {
        expect(before).toEqual([]);
        const [g] = giants(w);
        expect(flat(g.pos, lair)).toBeLessThan(0.01);
        expect(g.ruler).not.toBeNull();
        expect((w.minds.get(g) as RulerMind).lair).toEqual(lair);
      },
    });
    const at = { x: 20, z: 15 };
    await replayed({
      log: () => [devCmd('spawnGiant', [at.x * 100, at.z * 100])],
      probe: (w) => giants(w).map(pos),
      check: (w, before) => {
        expect(before).toEqual([]);
        const [g] = giants(w);
        expect(flat(g.pos, at)).toBeLessThan(0.01);
        expect(angleOff(g.yaw, yawTo(at, w.player!.pos))).toBeLessThan(1e-9);
      },
    });
  });

  it('giveTool [i]: a real entity made by the factory, put in the hands (each of GIVE_TOOLS)', async () => {
    const classes: Record<(typeof GIVE_TOOLS)[number], string | null> = { stoneAxe: 'stoneAxe', diggingStick: 'sharpStick', spear: 'spear', vine: null };
    for (let i = 0; i < GIVE_TOOLS.length; i++) {
      const tool = GIVE_TOOLS[i];
      await replayed({
        log: () => [devCmd('giveTool', [i])],
        probe: (w) => ({ hands: w.player!.inventory!.hands?.entity ?? null, entities: w.entities.all().length }),
        check: (w, before, after) => {
          expect(before.hands, tool).toBeNull();
          expect(after.hands, tool).not.toBeNull();
          expect(after.entities, tool).toBeGreaterThan(before.entities);
          const e = w.entities.get(after.hands!)!;
          expect(e, tool).toBeDefined();
          expect(toolClass(w, e.id), tool).toBe(classes[tool]);
          if (tool === 'vine') expect(e.material).toBe('vine');
        },
      });
    }
    expect(DEV_OPS_TUNING.vineM).toBeGreaterThan(0);
  });

  it('teleport [xCm, zCm]: the player moved, its pose history reset (no sweep from the old place) and a contact grace', async () => {
    const at = { x: -15, z: 22 };
    await replayed({
      log: () => [devCmd('teleport', [at.x * 100, at.z * 100])],
      probe: (w) => ({ ...pos(w.player!), grace: w.contacts.inGrace(w.player!.id, w.tick + 1) }),
      check: (w, before) => {
        const p = w.player!;
        expect(flat(before, at)).toBeGreaterThan(20);
        expect(flat(p.pos, at)).toBeLessThan(0.01);
        expect(w.contacts.inGrace(p.id, w.tick + 1)).toBe(true);
        // The pose history is reset (§4.3, RF-1): at the stores around the jump every zone's previous pose is its
        // current one (carryV 0), so the damage rule never reads the jump as a sweep from the old place.
        const still = (): void => {
          const h = w.zones.historyRecord(p);
          expect(h.length).toBeGreaterThan(0);
          for (let i = 0; i < h.length; i += 14) expect(h.slice(i + 7, i + 10), `zone ${i / 14}`).toEqual(h.slice(i, i + 3));
        };
        still();
        w.step();
        still();
        const h = w.zones.historyRecord(p);
        for (let i = 0; i < h.length; i += 14) expect(flat({ x: h[i], z: h[i + 2] }, at), `zone ${i / 14} at the new place`).toBeLessThan(2);
      },
    });
  });

  it('teleport [xCm, zCm, id]: another fighter moved', async () => {
    const at = { x: 9, z: 9 };
    let ape = 0;
    await replayed({
      setup: (w) => {
        ape = w.spawnCreature('ape', { x: 30, z: 0 }, 0).id;
      },
      log: () => [devCmd('teleport', [at.x * 100, at.z * 100, ape])],
      probe: (w) => pos(byId(w, ape)!),
      check: (w) => {
        expect(flat(byId(w, ape)!.pos, at)).toBeLessThan(0.01);
        expect(flat(w.player!.pos, { x: WORLD_TUNING.spawnX, z: WORLD_TUNING.spawnZ })).toBeLessThan(0.5);
      },
    });
  });

  it('pauseMinds [1] / [0] / [1, id]: every creature mind paused, then resumed; or one', async () => {
    let ids: number[] = [];
    const setup = (w: World): void => {
      ids = [w.spawnCreature('ape', { x: 20, z: 0 }, 0).id, w.spawnCreature('ape', { x: -20, z: 0 }, 0).id];
    };
    const paused = (w: World): boolean[] => ids.map((id) => w.minds.get(byId(w, id)!)!.paused);
    await replayed({
      setup,
      log: () => [devCmd('pauseMinds', [1])],
      probe: paused,
      check: (_w, before, after) => {
        expect(before).toEqual([false, false]);
        expect(after).toEqual([true, true]);
      },
    });
    await replayed({
      setup,
      log: () => [{ ...devCmd('pauseMinds', [1]), tick: 2 }, devCmd('pauseMinds', [0])],
      probe: paused,
      check: (_w, before, after) => {
        expect(before).toEqual([true, true]);
        expect(after).toEqual([false, false]);
      },
    });
    await replayed({
      setup,
      log: () => [devCmd('pauseMinds', [1, ids[1]])],
      probe: paused,
      check: (_w, _before, after) => expect(after).toEqual([false, true]),
    });
  });

  it('killCreature [id]: the creature knocked out (no killer); the player is not a creature', async () => {
    let ape = 0;
    await replayed({
      setup: (w) => {
        ape = w.spawnCreature('ape', { x: 25, z: 0 }, 0).id;
      },
      log: (w) => [devCmd('killCreature', [ape]), devCmd('killCreature', [w.player!.id])],
      probe: (w) => ({ ape: pos(byId(w, ape)!), player: w.player!.alive }),
      check: (w, before, after) => {
        expect(before.ape.alive).toBe(true);
        expect(after.ape.alive).toBe(false);
        expect(byId(w, ape)!.state).toBe('ko');
        expect(after.player).toBe(true);
      },
    });
  });

  it('respawnPlayer []: the player revived at the spawn, a respawn event, as Deaths does it', async () => {
    let events: string[] = [];
    await replayed({
      setup: (w) => {
        const p = w.player!;
        w.teleport(p, 18, -7);
        w.combat.koFighter(p, { by: 'impact', killer: null, cause: null, point: { x: p.pos.x, y: p.pos.y, z: p.pos.z } });
      },
      log: () => [devCmd('respawnPlayer', [])],
      probe: (w) => ({ ...pos(w.player!), hp: w.player!.hp }),
      check: (w, before, after) => {
        expect(before.alive).toBe(false);
        expect(after.alive).toBe(true);
        expect(after.hp).toBe(w.player!.stats.maxHp);
        expect(flat(w.player!.pos, { x: WORLD_TUNING.spawnX, z: WORLD_TUNING.spawnZ })).toBeLessThan(0.01);
        events = w.events.map((e) => e.type);
        expect(events).toContain('respawn');
      },
    });
  });

  it('setTuning: the edit is in the command log, and the replay (from the defaults) applies it at the same tick', async () => {
    const table = 'CREATURE_TUNING';
    const key = 'ape.respawnS';
    const def = getTuningValue(table, key);
    const { a, b } = await replayed({
      log: () => [devCmd('setTuning', [], { table, key, value: 42 })],
      probe: () => getTuningValue(table, key),
      check: (_w, before, after) => {
        expect(before).toBe(def);
        expect(after).toBe(42);
      },
    });
    expect(a.log).toEqual([devCmd('setTuning', [], { table, key, value: 42 })]);
    expect(b.before).toBe(def);
    expect(b.after).toBe(42);
    // The save carries the edit too (it is world state, §8.3).
    expect(new TextDecoder().decode(b.save)).toContain('ape.respawnS');
  });
});

describe('malformed dev commands are refused at their tick (§1.5.3)', () => {
  const bad: [DevOp, number[]][] = [
    ['spawnApe', [100]],
    ['spawnApe', [100.5, 0]],
    ['giveTool', [GIVE_TOOLS.length]],
    ['teleport', []],
    ['pauseMinds', [2]],
    ['killCreature', []],
    ['respawnPlayer', [1]],
    ['setTuning', []],
  ];
  for (const [op, args] of bad) {
    it(`${op} ${JSON.stringify(args)} throws, naming the tick and the op`, async () => {
      const w = await createWorld({ seed: S, scene: 'empty', nav: 'off' });
      live.push(w);
      w.commands.push({ tick: 1, player: 1, kind: 'meta', meta: 'dev', dev: { op, args } });
      expect(() => w.step()).toThrow(new RegExp(`tick 1: ${op}`));
    });
  }
  it('an op with nothing to act on does nothing (a fighter that is gone, a creature that is out)', async () => {
    const w = await createWorld({ seed: S, scene: 'empty', nav: 'off' });
    live.push(w);
    for (const c of [devCmd('killCreature', [999]), devCmd('teleport', [100, 100, 999]), devCmd('pauseMinds', [1, 999]), devCmd('spawnGiant', [])]) {
      w.commands.push({ ...c, tick: 1 });
    }
    w.step();
    expect(w.combat.fighters.map((f) => f.id)).toEqual([1]);
  });
});
