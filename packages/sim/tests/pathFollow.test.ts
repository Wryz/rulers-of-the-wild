// Path following (docs/M1-DESIGN.md §6.5, §7; package P19): the request queue (at most navQueriesPerTick a tick, in
// (requestTick, fighter id) order, a waiting mind following its old path), goals snapped to the navmesh (none: a
// failure), re-paths when the goal moves more than repathMoveM, on schedule, when a tile the path crosses is rebuilt and
// when stuck, partial paths followed to their end and counted as failures, maxPathFailures making a goal unreachable,
// the straight line without a navmesh, and the follower's record.
//
// Scene numbers (positions, sizes) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { CREATURE_TUNING } from '../src/world/creatures/defs';
import { createCreature } from '../src/world/creatures/factory';
import type { CreatureMind } from '../src/world/creatures/mind';
import { PathFollower } from '../src/world/creatures/pathFollow';
import { spawnBox } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { V3 } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

vi.setConfig({ testTimeout: 600_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 3, scene: 'empty', nav: 'full', size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
  vi.restoreAllMocks();
});

const A = CREATURE_TUNING.ape;
const S = CREATURE_TUNING.shared;
const at = (w: World, x: number, z: number): V3 => ({ x, y: w.terrain.heightAt(x, z), z });
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

function steps(w: World, n: number): void {
  for (let k = 0; k < n; k++) w.step();
}

/** An ape whose own mind is paused (so nothing but the test moves it or asks for paths), and its mind. */
function stillApe(w: World, x: number, z: number): { f: Fighter; mind: CreatureMind } {
  const f = createCreature(w, 'ape', { x, z }, 0);
  const mind = w.minds.get(f)!;
  mind.paused = true;
  return { f, mind };
}

describe('the request queue (§6.5)', () => {
  it('serves at most navQueriesPerTick a tick, in (requestTick, fighter id) order', async () => {
    const w = await make({ player: false });
    const apes = [-15, -9, -3, 3, 9, 15].map((x) => createCreature(w, 'ape', { x, z: -10 }, 0));
    const minds = apes.map((f) => w.minds.get(f)!);
    const served: { tick: number; id: number }[] = [];
    const serve = PathFollower.prototype.serve;
    vi.spyOn(PathFollower.prototype, 'serve').mockImplementation(function (this: PathFollower, ww: World, self: Fighter) {
      served.push({ tick: ww.tick, id: self.id });
      serve.call(this, ww, self);
    });
    // Every ape asks on tick 1 (a route on the navmesh).
    for (const [k, m] of minds.entries()) m.script = { kind: 'route', points: [{ x: -15 + 6 * k, z: 10 }], useNav: true };
    steps(w, 1);
    const ids = apes.map((f) => f.id);
    expect(served.filter((s) => s.tick === 1).map((s) => s.id)).toEqual(ids.slice(0, S.navQueriesPerTick));
    expect(minds.slice(S.navQueriesPerTick).every((m) => m.path.pending && m.path.points.length === 0)).toBe(true);
    // The first ape asks again on tick 2: the two still waiting from tick 1 go first, then it.
    minds[0].script = { kind: 'route', points: [{ x: -15, z: 5 }], useNav: true };
    steps(w, 1);
    expect(served.filter((s) => s.tick === 2).map((s) => s.id)).toEqual([ids[4], ids[5], ids[0]]);
    expect(minds.every((m) => !m.path.pending && m.path.points.length > 0)).toBe(true);
    // The count is live tuning.
    setTuningValue('CREATURE_TUNING', 'shared.navQueriesPerTick', 1);
    for (const [k, m] of minds.entries()) m.script = { kind: 'route', points: [{ x: -15 + 6 * k, z: 0 }], useNav: true };
    steps(w, 3);
    expect(served.filter((s) => s.tick >= 3).map((s) => s.id)).toEqual(ids.slice(0, 3));
  });

  it('a mind waiting for its path keeps following the old one', async () => {
    const w = await make({ player: false });
    const { f, mind } = stillApe(w, 0, -10);
    mind.paused = false;
    mind.script = { kind: 'route', points: [{ x: 0, z: 10 }], useNav: true };
    steps(w, 5);
    const old = mind.path.points.map((q) => ({ ...q }));
    expect(old.length).toBeGreaterThan(0);
    setTuningValue('CREATURE_TUNING', 'shared.navQueriesPerTick', 0);
    // A new goal 5 m off: asked for, never served; it walks on along the old path meanwhile.
    mind.path.request(w, f, at(w, 5, 10));
    const z0 = f.pos.z;
    steps(w, 60);
    expect(mind.path.pending).toBe(true);
    expect(mind.path.points).toEqual(old);
    expect(f.pos.z - z0).toBeGreaterThan(1);
    expect(Math.abs(f.pos.x)).toBeLessThan(0.05);
  });
});

describe('goals, re-paths and failures (§6.5)', () => {
  it('a goal is snapped to the navmesh; no polygon near it is a failure and leaves no path', async () => {
    const w = await make({ player: false });
    const { f } = stillApe(w, 0, 0);
    const pf = new PathFollower('human');
    pf.goTo(w, f, { x: 6, y: 0.9, z: 4 });
    expect(pf.pending).toBe(true);
    expect(pf.requestTick).toBe(w.tick);
    pf.serve(w, f);
    expect(pf.pending).toBe(false);
    expect(pf.complete).toBe(true);
    const end = pf.points[pf.points.length - 1];
    expect(flat(end, { x: 6, z: 4 })).toBeLessThan(0.05);
    expect(end.y).toBeCloseTo(w.nav!.nearest('human', { x: 6, y: 0, z: 4 })!.y, 6);
    expect(pf.tiles.length).toBeGreaterThan(0);
    expect(pf.versions).toEqual(pf.tiles.map((t) => w.nav!.tileVersion('human', t)));
    expect(pf.failures).toBe(0);
    // Far outside the navmesh: no polygon within the half-extents.
    pf.request(w, f, { x: 400, y: 0, z: 400 });
    pf.serve(w, f);
    expect(pf.points).toEqual([]);
    expect(pf.failures).toBe(1);
    expect(pf.unreachable).toBe(false);
  });

  it('asks again when the goal moves more than repathMoveM, on schedule (repathTicks), and when there is no path', async () => {
    const w = await make({ player: false });
    const { f } = stillApe(w, 0, 0);
    const pf = new PathFollower('human');
    const g = at(w, 10, 0);
    pf.goTo(w, f, g);
    pf.serve(w, f);
    const asked = pf.requestTick;
    pf.goTo(w, f, { ...g, z: A.repathMoveM - 0.01 });
    expect(pf.pending).toBe(false);
    pf.goTo(w, f, { ...g, z: A.repathMoveM + 0.01 });
    expect(pf.pending).toBe(true);
    // While a request waits, its goal follows the latest.
    pf.goTo(w, f, at(w, 10, 4));
    expect(pf.goal).toEqual(at(w, 10, 4));
    pf.serve(w, f);
    // On schedule: not before repathTicks after the last request, then yes.
    steps(w, A.repathTicks - 1);
    pf.goTo(w, f, at(w, 10, 4), A.repathTicks);
    expect(pf.pending).toBe(false);
    steps(w, 1);
    pf.goTo(w, f, at(w, 10, 4), A.repathTicks);
    expect(pf.pending).toBe(true);
    expect(pf.requestTick).toBe(asked + A.repathTicks);
    pf.serve(w, f);
    // No path (a failed request): asked again at once.
    pf.request(w, f, { x: 400, y: 0, z: 400 });
    pf.serve(w, f);
    expect(pf.points).toEqual([]);
    pf.goTo(w, f, { x: 400, y: 0, z: 400 });
    expect(pf.pending).toBe(true);
  });

  it('asks again when a tile the path crosses is rebuilt (checked when asked to), not otherwise', async () => {
    const w = await make({ player: false });
    const { f } = stillApe(w, 0, -15);
    const pf = new PathFollower('human');
    pf.goTo(w, f, at(w, 0, 15));
    pf.serve(w, f);
    pf.upkeep(w, f, true);
    expect(pf.pending).toBe(false);
    // A wall across the way, rebuilt.
    spawnBox(w, { p: { x: 0, y: 0.75, z: 0 }, size: [8, 1.5, 0.4], material: 'stone', state: 'fixed', look: 'wall' });
    steps(w, 20);
    expect(pf.tiles.some((t, k) => w.nav!.tileVersion('human', t) !== pf.versions[k])).toBe(true);
    pf.upkeep(w, f, false);
    expect(pf.pending).toBe(false);
    pf.upkeep(w, f, true);
    expect(pf.pending).toBe(true);
    pf.serve(w, f);
    expect(pf.complete).toBe(true);
    expect(Math.max(...pf.points.map((q) => Math.abs(q.x)))).toBeGreaterThan(4);
  });

  it('a partial path is followed to its end, then counts as a failure; maxPathFailures in a row make the goal unreachable', async () => {
    const w = await make({ player: false });
    // A 2 m high platform: its top is navmesh, but no step leads up.
    spawnBox(w, { p: { x: 0, y: 1, z: 8 }, size: [6, 2, 6], material: 'stone', state: 'fixed', look: 'platform' });
    steps(w, 20);
    const { f } = stillApe(w, 0, -8);
    const pf = new PathFollower('human');
    const goal = { x: 0, y: 2, z: 8 };
    pf.goTo(w, f, goal);
    pf.serve(w, f);
    expect(pf.complete).toBe(false);
    expect(pf.points.length).toBeGreaterThan(0);
    /** Walks the path corner by corner (teleports standing in for the walk): the corners passed before its end. */
    const follow = (): number => {
      let n = 0;
      const before = pf.failures;
      for (let c = pf.corner(f); c; c = pf.corner(f)) {
        expect(pf.failures).toBe(before); // nothing counts before the end
        w.teleport(f, c.x, c.z);
        if (++n > 20) throw new Error('a path of more than 20 corners');
      }
      return n;
    };
    // Not a failure until its end is reached.
    expect(pf.corner(f)).not.toBeNull();
    expect(pf.failures).toBe(0);
    expect(follow()).toBeGreaterThan(0);
    expect(pf.failures).toBe(1);
    expect(pf.points).toEqual([]);
    // Asked again from there: partial again, followed to its end again.
    for (let k = 2; k <= S.maxPathFailures; k++) {
      pf.goTo(w, f, goal);
      expect(pf.pending).toBe(true);
      pf.serve(w, f);
      expect(pf.complete).toBe(false);
      follow();
      expect(pf.failures).toBe(k);
    }
    expect(pf.unreachable).toBe(true);
    pf.clear();
    expect(pf.unreachable).toBe(false);
    expect(pf.goal).toBeNull();
  });

  it('the end of a complete path is done and clears the failures', async () => {
    const w = await make({ player: false });
    const { f } = stillApe(w, 0, 0);
    const pf = new PathFollower('human');
    pf.request(w, f, { x: 400, y: 0, z: 400 });
    pf.serve(w, f);
    expect(pf.failures).toBe(1);
    pf.goTo(w, f, at(w, 4, 3));
    pf.serve(w, f);
    expect(pf.done).toBe(false);
    w.teleport(f, 4, 3);
    expect(pf.corner(f)).toBeNull();
    expect(pf.done).toBe(true);
    expect(pf.failures).toBe(0);
    // Done stays done: no new request for the same goal.
    pf.goTo(w, f, at(w, 4, 3));
    expect(pf.pending).toBe(false);
  });

  it('without a navmesh a path is the straight line to the goal, complete, crossing no tiles', async () => {
    const w = await make({ player: false, nav: 'off' });
    const { f } = stillApe(w, 0, 0);
    const pf = new PathFollower('human');
    pf.goTo(w, f, at(w, 7, -2));
    pf.serve(w, f);
    expect(pf.points).toEqual([at(w, 7, -2)]);
    expect(pf.complete).toBe(true);
    expect(pf.tiles).toEqual([]);
    expect(pf.corner(f)).toEqual(at(w, 7, -2));
  });
});

describe('stuck (§6.5)', () => {
  it('walking into a wall the path ignores: a failure and a re-path every stuckTicks without stuckMinM of progress; unreachable after maxPathFailures', async () => {
    // No navmesh: the path is the straight line, through the wall.
    const w = await make({ player: false, nav: 'off' });
    spawnBox(w, { p: { x: 0, y: 1, z: 0 }, size: [8, 2, 0.5], material: 'stone', state: 'fixed', look: 'wall' });
    steps(w, 5);
    const f = createCreature(w, 'ape', { x: 0, z: -3 }, 0);
    const mind = w.minds.get(f)!;
    mind.script = { kind: 'route', points: [{ x: 0, z: 6 }], useNav: true };
    const fails: number[] = [];
    let last = 0;
    for (let k = 0; k < A.stuckTicks * (S.maxPathFailures + 3) && !mind.path.unreachable; k++) {
      w.step();
      if (mind.path.failures !== last) {
        last = mind.path.failures;
        fails.push(w.tick);
      }
    }
    expect(mind.path.unreachable).toBe(true);
    expect(fails.length).toBe(S.maxPathFailures);
    for (let k = 1; k < fails.length; k++) expect(fails[k] - fails[k - 1]).toBe(A.stuckTicks);
    expect(f.pos.z).toBeLessThan(0);
  });

  it('progress clears the failures; standing still (not asking) never counts', async () => {
    const w = await make({ player: false, nav: 'off' });
    const f = createCreature(w, 'ape', { x: 0, z: -15 }, 0);
    const mind = w.minds.get(f)!;
    mind.script = { kind: 'route', points: [{ x: 0, z: 15 }], useNav: true };
    steps(w, 2);
    mind.path.stuck.count = 2;
    steps(w, A.stuckTicks + 2);
    expect(mind.path.failures).toBe(0);
    // Standing: a hold script asks for nothing.
    mind.script = { kind: 'hold' };
    mind.path.goTo(w, f, at(w, 0, 15));
    steps(w, 3);
    const window = mind.path.stuck.tick;
    steps(w, A.stuckTicks * 2);
    expect(mind.path.failures).toBe(0);
    expect(mind.path.stuck.tick).toBeGreaterThan(window);
    expect(mind.path.stuck.tick).toBe(w.tick);
  });
});

describe('the record (§6.8)', () => {
  it('round-trips as copies (null with no goal); refuses a corner past the end or tiles without versions', async () => {
    const w = await make({ player: false });
    const { f } = stillApe(w, 0, 0);
    const pf = new PathFollower('human');
    expect(pf.toRecord()).toBeNull();
    pf.goTo(w, f, at(w, 8, 8));
    pf.serve(w, f);
    pf.corner(f);
    pf.stuck.count = 2;
    const rec = pf.toRecord()!;
    const st = pf.stuckRecord();
    expect(Object.keys(rec)).toEqual(['points', 'i', 'goal', 'complete', 'tiles', 'versions', 'requestTick', 'pending']);
    expect(Object.keys(st)).toEqual(['pos', 'tick', 'count']);
    const back = new PathFollower('human');
    back.restoreRecord(JSON.parse(JSON.stringify(rec)), JSON.parse(JSON.stringify(st)));
    expect(back.toRecord()).toEqual(rec);
    expect(back.stuckRecord()).toEqual(st);
    rec.points[0].x = 99;
    rec.tiles.push(5);
    expect(back.toRecord()!.points[0].x).not.toBe(99);
    expect(back.tiles.length).toBe(pf.tiles.length);
    // A follower with no goal: null, and the stuck window still kept.
    const none = new PathFollower('human');
    none.restoreRecord(null, st);
    expect(none.toRecord()).toBeNull();
    expect(none.stuckRecord()).toEqual(st);
    expect(() => none.restoreRecord({ ...pf.toRecord()!, i: pf.points.length + 1 }, st)).toThrow(/corner/);
    expect(() => none.restoreRecord({ ...pf.toRecord()!, versions: [] }, st)).toThrow(/tiles and versions/);
  });
});
