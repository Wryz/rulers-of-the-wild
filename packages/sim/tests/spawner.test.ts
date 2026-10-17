// The spawner (docs/M1-DESIGN.md §6.6, §6.7, §6.8; package P22): the Clearing populates itself when it is made (an ape
// at each home, the giant at its lair); a home ape respawns at its home respawnS after its KO, only with no player
// within respawnMinPlayerDistM of the home, else tried again every respawnRetryS; the giant never respawns; the
// sparring ape of `?mode=training` (WorldOptions.sparringApe, D-50) starts in `fight` sparringDistM in front of the
// player, fights headless, and comes back sparringRespawnS after its KO; the spawner's record round-trips through a
// save → load → save with an ape respawn pending, and the loaded world respawns it on the same tick as the original.
//
// The respawn scenes are flat `scene 'empty'` worlds (cheap to step for 300 s) given spawn data of their own through
// Spawner.init; the Clearing scenes are the real generated Clearing. Scene numbers (positions, seeds) are test
// constants, never tuning (§9); expected values come from the tuning tables.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorld } from '../src/save/load';
import { serializeWorld } from '../src/save/serialize';
import type { CombatEvent } from '../src/sim/combat';
import type { DevOp, MetaCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { DT } from '../src/sim/math';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import type { ClearingSpawnData } from '../src/world/clearing';
import { ApeMind } from '../src/world/creatures/apeMind';
import { CREATURE_TUNING } from '../src/world/creatures/defs';
import { RulerMind } from '../src/world/creatures/rulerMind';
import { physicsReady } from '../src/world/physics';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

/** Rapier worlds stepped for minutes of sim time: explicit time limits (§11's convention). */
vi.setConfig({ testTimeout: 600_000 });

/** AC-7's seed (§11.7). */
const S = 20261017;
const A = CREATURE_TUNING.ape;
const secs = (s: number): number => Math.round(s / DT);
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }): number => Math.atan2(to.x - from.x, to.z - from.z);
const angleOff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: S, scene: 'empty', nav: 'off', ...o });
  live.push(w);
  return w;
}
const track = (w: World): World => {
  live.push(w);
  return w;
};

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

/** A dev command for the next tick, from player 1. */
function dev(w: World, op: DevOp, args: number[] = []): void {
  const c: MetaCommand = { tick: w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op, args } };
  w.commands.push(c);
}

/** Steps `n` ticks; the combat events of every tick. */
function run(w: World, n: number): CombatEvent[] {
  const out: CombatEvent[] = [];
  for (let i = 0; i < n; i++) out.push(...w.step().combat);
  return out;
}

/** Steps until tick `t` has run. */
function runTo(w: World, t: number): void {
  while (w.tick < t) w.step();
}

const byId = (w: World, id: number | null): Fighter | undefined => (id === null ? undefined : w.combat.fighters.find((f) => f.id === id));
const apes = (w: World): Fighter[] => w.combat.fighters.filter((f) => f.species === 'ape');
const giants = (w: World): Fighter[] => w.combat.fighters.filter((f) => f.species === 'giantApe');

/** Spawn data for an empty scene: one home `home` (no loop) and, with `lair`, the giant's lair (no route). */
function spawnData(home: { x: number; z: number } | null, lair: { x: number; z: number } | null = null): ClearingSpawnData {
  return { playerYaw: 0, apeHomes: home ? [{ home, loop: [] }] : [], lair, route: [], hardFallbacks: 0 };
}

// ---------------------------------------------------------------------------
// The Clearing populates itself
// ---------------------------------------------------------------------------

describe('the Clearing populates itself (§6.6, §6.7)', () => {
  it('an ape at each home (its mind homed there, patrolling its loop), the giant at its lair on its route, ids after the player', async () => {
    const w = await make({ scene: 'clearing' });
    const data = w.spawnData!;
    expect(data.apeHomes).toHaveLength(3);
    const list = apes(w);
    expect(list).toHaveLength(data.apeHomes.length);
    list.forEach((f, i) => {
      const h = data.apeHomes[i];
      expect(f.id, `home ${i}`).toBe(2 + i);
      expect(flat(f.pos, h.home), `home ${i}`).toBeLessThan(0.01);
      expect(angleOff(f.yaw, yawTo(h.home, h.loop[0])), `home ${i} faces its loop`).toBeLessThan(1e-9);
      const mind = w.minds.get(f) as ApeMind;
      expect(mind).toBeInstanceOf(ApeMind);
      expect([mind.homeIdx, mind.home]).toEqual([i, { x: h.home.x, z: h.home.z }]);
      expect(mind.loop(w)).toBe(h.loop);
      expect(mind.state).toBe('idle');
    });
    const [g] = giants(w);
    expect(giants(w)).toHaveLength(1);
    expect(g.id).toBe(2 + data.apeHomes.length);
    expect(g.ruler).not.toBeNull();
    expect(flat(g.pos, data.lair!)).toBeLessThan(0.01);
    expect(angleOff(g.yaw, yawTo(data.lair!, data.route[0]))).toBeLessThan(1e-9);
    const rm = w.minds.get(g) as RulerMind;
    expect(rm).toBeInstanceOf(RulerMind);
    expect(rm.lair).toEqual({ x: data.lair!.x, z: data.lair!.z });
    expect(rm.route(w)).toBe(data.route);
    // The player is fighter 1; no sparring ape unless asked.
    expect(w.combat.fighters.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    expect(w.player!.id).toBe(1);
    expect(w.spawner.slots()).toEqual({
      homes: list.map((f) => ({ fighter: f.id, respawnTick: -1 })),
      sparring: { fighter: null, respawnTick: -1 },
    });
    // Two worlds from one seed are made alike, creatures included.
    const again = await make({ scene: 'clearing' });
    expect(Buffer.from(serializeWorld(again)).equals(Buffer.from(serializeWorld(w)))).toBe(true);
  });

  it('an empty scene has no creatures; a world smaller than the Clearing gets none whose home or lair is off its terrain', async () => {
    const e = await make();
    expect(e.combat.fighters.map((f) => f.id)).toEqual([1]);
    expect(e.spawner.slots()).toEqual({ homes: [], sparring: { fighter: null, respawnTick: -1 } });
    const small = await make({ scene: 'clearing', size: 50 });
    const half = (small.terrain.tilesX * small.terrain.tileSize) / 2;
    const homes = small.spawnData!.apeHomes;
    expect(homes.every((h) => Math.max(Math.abs(h.home.x), Math.abs(h.home.z)) > half)).toBe(true);
    expect(small.combat.fighters.map((f) => f.id)).toEqual([1]);
    expect(small.spawner.slots().homes).toEqual(homes.map(() => ({ fighter: null, respawnTick: -1 })));
    // An empty slot never respawns.
    run(small, 5);
    expect(small.spawner.slots().homes).toEqual(homes.map(() => ({ fighter: null, respawnTick: -1 })));
  });
});

// ---------------------------------------------------------------------------
// Respawns
// ---------------------------------------------------------------------------

describe('respawn (§6.6)', () => {
  it('a home ape respawns at its home respawnS (300 s) after its KO with no player within 40 m; its corpse is Deaths\'', async () => {
    const w = await make();
    const home = { x: 50, z: 0 };
    w.spawner.init(w, spawnData(home));
    const [a1] = apes(w);
    expect(flat(a1.pos, home)).toBeLessThan(0.01);
    expect(flat(w.player!.pos, home)).toBeGreaterThan(A.respawnMinPlayerDistM);
    run(w, 30);
    dev(w, 'killCreature', [a1.id]);
    run(w, 1);
    const ko = w.tick;
    expect(a1.alive).toBe(false);
    const due = ko + secs(A.respawnS);
    expect(secs(A.respawnS)).toBe(18000);
    expect(w.spawner.slots().homes).toEqual([{ fighter: null, respawnTick: due }]);
    runTo(w, due - 1);
    expect(apes(w).filter((f) => f.alive)).toEqual([]);
    // The corpse went its own way (Deaths: corpseDespawnS, no player near) long before.
    expect(byId(w, a1.id)).toBeUndefined();
    run(w, 1);
    const [a2] = apes(w);
    expect(a2.alive).toBe(true);
    expect(a2.id).toBeGreaterThan(a1.id);
    expect(flat(a2.pos, home)).toBeLessThan(0.01);
    const mind = w.minds.get(a2) as ApeMind;
    expect([mind.homeIdx, mind.home, mind.state]).toEqual([0, home, 'idle']);
    expect(w.spawner.slots().homes).toEqual([{ fighter: a2.id, respawnTick: -1 }]);
  });

  it('with a player within 40 m of the home the respawn waits, tried again every respawnRetryS (10 s)', async () => {
    const w = await make();
    const home = { x: 50, z: 0 };
    w.spawner.init(w, spawnData(home));
    const [a1] = apes(w);
    dev(w, 'pauseMinds', [1]);
    dev(w, 'killCreature', [a1.id]);
    run(w, 1);
    const due = w.tick + secs(A.respawnS);
    // The player stands 35 m from the home when it is due (and well before).
    dev(w, 'teleport', [1500, 0]);
    runTo(w, due);
    expect(flat(w.player!.pos, home)).toBeLessThanOrEqual(A.respawnMinPlayerDistM);
    expect(apes(w).filter((f) => f.alive)).toEqual([]);
    const retry = due + secs(A.respawnRetryS);
    expect(w.spawner.slots().homes).toEqual([{ fighter: null, respawnTick: retry }]);
    // Still there at the retry: again 10 s later.
    runTo(w, retry);
    expect(apes(w).filter((f) => f.alive)).toEqual([]);
    expect(w.spawner.slots().homes).toEqual([{ fighter: null, respawnTick: retry + secs(A.respawnRetryS) }]);
    // Gone (41 m away) by the next retry: the ape is back at that tick, not before.
    dev(w, 'teleport', [900, 0]);
    runTo(w, retry + secs(A.respawnRetryS) - 1);
    expect(apes(w).filter((f) => f.alive)).toEqual([]);
    run(w, 1);
    const back = apes(w).filter((f) => f.alive);
    expect(back).toHaveLength(1);
    expect(flat(back[0].pos, home)).toBeLessThan(0.01);
  });

  it('the giant never respawns: its corpse stays and no other giant comes, however long', async () => {
    const w = await make();
    const lair = { x: 0, z: -60 };
    w.spawner.init(w, spawnData(null, lair));
    const [g] = giants(w);
    expect(flat(g.pos, lair)).toBeLessThan(0.01);
    expect((w.minds.get(g) as RulerMind).lair).toEqual(lair);
    run(w, 30);
    dev(w, 'killCreature', [g.id]);
    run(w, 1);
    expect(g.alive).toBe(false);
    runTo(w, w.tick + secs(A.respawnS) + secs(A.respawnRetryS) + 60);
    expect(giants(w)).toEqual([g]);
    expect(w.combat.fighters.map((f) => f.id)).toEqual([1, g.id]);
  });
});

// ---------------------------------------------------------------------------
// The sparring ape (?mode=training)
// ---------------------------------------------------------------------------

describe('the sparring ape (?mode=training, D-50)', () => {
  it('starts in `fight` sparringDistM in front of the player, facing it, fully aware of it, and fights headless', async () => {
    const w = await make({ scene: 'clearing', sparringApe: true });
    const p = w.player!;
    const sp = w.spawner.slots().sparring;
    const f = byId(w, sp.fighter)!;
    expect(f.species).toBe('ape');
    // After the Clearing's own creatures: the last fighter.
    expect(f.id).toBe(w.combat.fighters[w.combat.fighters.length - 1].id);
    const ahead = { x: p.pos.x + Math.sin(p.yaw) * A.sparringDistM, z: p.pos.z + Math.cos(p.yaw) * A.sparringDistM };
    expect(flat(f.pos, ahead)).toBeLessThan(0.01);
    expect(flat(f.pos, p.pos)).toBeCloseTo(A.sparringDistM, 2);
    expect(angleOff(f.yaw, yawTo(f.pos, p.pos))).toBeLessThan(1e-9);
    const mind = w.minds.get(f) as ApeMind;
    expect(mind.state).toBe('fight');
    expect(mind.senses.of(p.id)).toBe(CREATURE_TUNING.shared.awarenessCap);
    expect(f.target).toBe(p);
    // Headless: it stays in the fight and swings at the player, and its blows land on him (or on his guard).
    let swings = 0;
    const evs: CombatEvent[] = [];
    for (let t = 0; t < secs(10); t++) {
      evs.push(...w.step().combat);
      if (f.state === 'attack' && f.sinceMoveStart === 0) swings++;
    }
    expect(mind.state).toBe('fight');
    expect(swings).toBeGreaterThan(1);
    expect(evs.some((e) => (e.type === 'hit' || e.type === 'block' || e.type === 'dodge') && e.attacker === f && e.defender === p)).toBe(true);
  });

  it('comes back sparringRespawnS (3.2 s) after its KO: the old body goes, a new one fights in front of the player', async () => {
    const w = await make({ scene: 'clearing', sparringApe: true });
    const p = w.player!;
    const first = byId(w, w.spawner.slots().sparring.fighter)!;
    // The player turned and moved since: the new one comes in front of where the player is now.
    dev(w, 'teleport', [300, -200]);
    dev(w, 'killCreature', [first.id]);
    run(w, 1);
    const ko = w.tick;
    expect(first.alive).toBe(false);
    const due = ko + secs(A.sparringRespawnS);
    expect(w.spawner.slots().sparring).toEqual({ fighter: first.id, respawnTick: due });
    runTo(w, due - 1);
    expect(byId(w, first.id)).toBe(first);
    run(w, 1);
    expect(byId(w, first.id)).toBeUndefined();
    const sp = w.spawner.slots().sparring;
    const next = byId(w, sp.fighter)!;
    expect(sp.respawnTick).toBe(-1);
    expect(next.id).toBeGreaterThan(first.id);
    expect(next.alive).toBe(true);
    const ahead = { x: p.pos.x + Math.sin(p.yaw) * A.sparringDistM, z: p.pos.z + Math.cos(p.yaw) * A.sparringDistM };
    expect(flat(next.pos, ahead)).toBeLessThan(0.05);
    expect((w.minds.get(next) as ApeMind).state).toBe('fight');
    expect(next.target).toBe(p);
    // The home apes are the spawner's own business: untouched.
    expect(w.spawner.slots().homes.every((h) => h.fighter !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe("the spawner's record (§6.8)", () => {
  it('save → load → save is byte-identical with ape respawns pending, and the loaded world respawns them on the same ticks', async () => {
    // A short respawn (the 300 s are the empty scene's test above): the full Clearing steps at several ms a tick.
    setTuningValue('CREATURE_TUNING', 'ape.respawnS', 2);
    const w = await make({ scene: 'clearing', sparringApe: true });
    // Home B (≈ 62 m out: home A, 38 m from the spawn, waits while the player stands there).
    const homeIdx = 1;
    const home = w.spawnData!.apeHomes[homeIdx].home;
    expect(flat(w.player!.pos, home)).toBeGreaterThan(A.respawnMinPlayerDistM);
    const homeApe = apes(w)[homeIdx];
    const sparring = byId(w, w.spawner.slots().sparring.fighter)!;
    run(w, 20);
    dev(w, 'killCreature', [homeApe.id]);
    dev(w, 'killCreature', [sparring.id]);
    run(w, 10);
    const slots = w.spawner.slots();
    const homeDue = slots.homes[homeIdx].respawnTick;
    expect(slots.homes[homeIdx]).toEqual({ fighter: null, respawnTick: w.tick - 9 + secs(2) });
    expect(slots.sparring).toEqual({ fighter: sparring.id, respawnTick: w.tick - 9 + secs(A.sparringRespawnS) });
    const bytes = serializeWorld(w);
    const l = track(await loadWorld(bytes, { nav: 'off' }));
    expect(l.spawner.toRecord()).toEqual(w.spawner.toRecord());
    expect(l.spawner.data).toBe(l.spawnData);
    const a = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const b = JSON.parse(new TextDecoder().decode(serializeWorld(l))) as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!['bodies', 'contactGrace', 'navDirty'].includes(k)) expect(JSON.stringify(b[k]), k).toBe(JSON.stringify(a[k]));
    // Both bring the home ape back at its home on its tick (and the sparring ape at its own), as the same new fighters.
    for (const x of [w, l]) {
      runTo(x, homeDue - 1);
      expect(x.spawner.slots().homes[homeIdx].fighter).toBeNull();
      run(x, 1);
    }
    expect(l.spawner.toRecord()).toEqual(w.spawner.toRecord());
    for (const x of [w, l]) {
      const back = byId(x, x.spawner.slots().homes[homeIdx].fighter)!;
      expect(back.alive).toBe(true);
      expect(flat(back.pos, home)).toBeLessThan(0.01);
      expect((x.minds.get(back) as ApeMind).homeIdx).toBe(homeIdx);
      runTo(x, slots.sparring.respawnTick);
      expect(byId(x, sparring.id)).toBeUndefined();
      expect(byId(x, x.spawner.slots().sparring.fighter)?.alive).toBe(true);
    }
    expect(l.spawner.toRecord()).toEqual(w.spawner.toRecord());
    expect(w.combat.fighters.map((f) => f.id)).toEqual(l.combat.fighters.map((f) => f.id));
  });

  it('a record that names no ape, or the wrong number of homes, is refused', async () => {
    const w = await make({ scene: 'clearing' });
    const r = w.spawner.toRecord();
    expect(() => w.spawner.restoreRecord({ ...r, homes: r.homes.slice(1) })).toThrow(/save record: spawner\.homes has 2 slots/);
    expect(() => w.spawner.restoreRecord({ ...r, homes: r.homes.map((h, i) => (i === 1 ? { fighter: 999, respawnTick: -1 } : h)) })).toThrow(
      /spawner\.homes\[1\]\.fighter names fighter 999/,
    );
    const giant = giants(w)[0].id;
    expect(() => w.spawner.restoreRecord({ ...r, sparring: { fighter: giant, respawnTick: -1 } })).toThrow(/isn't an ape/);
    // The sparring ape's body awaiting its respawn may be gone already.
    w.spawner.restoreRecord({ ...r, sparring: { fighter: 999, respawnTick: 50 } });
    expect(w.spawner.toRecord().sparring).toEqual({ fighter: 999, respawnTick: 50 });
  });
});
