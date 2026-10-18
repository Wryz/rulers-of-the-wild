// The acceptance-test harness (docs/M1-DESIGN.md §11.0; package P23): every call the AC files use produces the commands
// and effects it promises; the scenes assemble from entities and verbs only (a read of scenes.ts) and come out as §11
// describes them; staging is refused once a creature script runs; the dig planner digs a 3 × 2 × 1.5 m pit (and a
// 2 × 1 × 1 m scaling check) within its tick and strike caps; the scene cache reuses a file for an unchanged hash and
// rebuilds it for a changed one.
//
// Scene numbers are test constants (§9), never tuning. Every world is disposed (RF-24).
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toCm } from '../src/sim/commands';
import { WEAPONS } from '../src/sim/weapons';
import { Terrain } from '../src/world/terrain';
import type { WorldEvent } from '../src/world/types';
import { isDirtPile } from '../src/world/verbs/dig';
import { ensureScene, readScene, sceneHash, SCENE_DIR, wantedScenes } from './support/globalSetup';
import { buildHauledLog, buildLeaningLog, buildNotchedTree, buildStakedLog, buildStakedWall, lyingAlong, PROBE_SCENE } from './support/scenes';
import { BACK_SLOT, cachedScene, DIG_PLAN, type Harness, loadHarness, makeHarness } from './support/worldHarness';

vi.setConfig({ testTimeout: 600_000 });

const live: Harness[] = [];
async function make(seed = 11, size = 40): Promise<Harness> {
  const h = await makeHarness({ seed, size });
  live.push(h);
  return h;
}

afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const of = <T extends WorldEvent['type']>(evs: readonly WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  evs.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);

// ---------------------------------------------------------------------------
// Stepping, entities, staging
// ---------------------------------------------------------------------------

describe('the world and its clock', () => {
  it('makeHarness: scene empty, nav off, the player p1, CombatSim dev checks on; ticks copies, until finds or throws', async () => {
    const h = await make();
    expect(h.w.options.scene).toBe('empty');
    expect(h.w.nav).toBeNull();
    expect(h.w.combat.devChecks).toBe(true);
    expect(h.p.playerId).toBe('p1');
    const t0 = h.w.tick;
    const seen: number[] = [];
    const r = h.ticks(5, (_, t) => seen.push(t));
    expect(h.w.tick).toBe(t0 + 5);
    expect(seen).toEqual([t0 + 1, t0 + 2, t0 + 3, t0 + 4, t0 + 5]);
    expect(r.world).not.toBe(h.w.events);
    expect(r.combat).not.toBe(h.w.combat.events);
    expect(h.until(() => h.w.tick >= t0 + 8, 10, 'tick 8')).toBe(t0 + 8);
    expect(() => h.until(() => false, 3, 'never')).toThrow('never not reached in 3');
    expect(h.w.tick).toBe(t0 + 11);
  });

  it('the factory calls make what they say, credited to no one (RT-19); keepAwake is logged', async () => {
    const h = await make();
    const log = h.log({ length: 2, r: 0.1, mass: 20, p: { x: 3, y: 0.1, z: 0 } });
    const stick = h.stick({ length: 1.4, r: 0.05, p: { x: -3, y: 0.06, z: 0 }, sharp: { end: 1, s: 0.6 } });
    const coil = h.coil({ material: 'vine', lengthM: 6, at: { x: 0, y: 0, z: 4 } });
    const grass = h.grass({ p: { x: 0, y: 0.05, z: -4 }, mass: 2 });
    const t = h.tree({ at: { x: 6, z: 6 }, diameter: 0.3, height: 15, vine: { anchorH: 10, lengthM: 12, yaw: 0 } });
    const box = h.box({ p: { x: -6, y: 0.5, z: -6 }, size: [1, 1, 1], material: 'dryWood', state: 'fixed', look: 'post' });
    h.ticks(2);
    expect(h.ent(log).mass).toBeCloseTo(20, 6);
    expect(h.ent(stick).sharpPoints[0].sharpness).toBeCloseTo(0.6, 9);
    expect(h.ent(coil).rope?.lengthM).toBe(6);
    expect(h.ent(grass).mass).toBeCloseTo(2, 6);
    expect(h.ent(t.tree).plant?.phase).toBe('standing');
    expect(h.w.joints.get(t.vine!.joint)?.rope?.entity).toBe(t.vine!.rope);
    expect(h.ent(box).state).toBe('fixed');
    for (const id of [log, stick, coil, grass, t.tree, box]) {
      expect(h.ent(id).credit).toEqual([]);
      expect(h.ent(id).generated).toBe(false);
    }
    h.keepAwake(log);
    h.ticks(240);
    expect(h.ent(log).body!.isSleeping()).toBe(false);
    expect(h.fixtures.map((f) => f.op)).toEqual(['keepAwake']);
  });

  it('stage holds an entity fixed at a pose, unstage frees it (it falls); both logged; refused once a creature script starts', async () => {
    const h = await make();
    const log = h.log({ length: 4, r: 0.23, mass: 300, p: { x: 4, y: 0.25, z: 0 } });
    h.stage(log, { p: { x: 0, y: 1.0, z: 3 }, q: lyingAlong(0) });
    h.ticks(120);
    expect(h.ent(log).state).toBe('fixed');
    expect(h.ent(log).pose.p.y).toBeCloseTo(1.0, 6);
    h.unstage(log);
    expect(h.ent(log).state).toBe('free');
    h.ticks(120);
    expect(h.ent(log).pose.p.y).toBeLessThan(0.3);
    expect(h.fixtures.map((f) => f.op)).toEqual(['stage', 'unstage']);
    expect(() => h.unstage(log)).toThrow(/not a staged entity/);
    // A creature script starts: staging is refused from then on (§11.0).
    const ape = h.creature('ape', { x: -6, z: 0 }, 0, { brain: 'off' });
    h.stage(log); // brain off is a hold, not a test script: still allowed
    h.unstage(log);
    h.script(ape, { kind: 'hold' });
    expect(() => h.stage(log)).toThrow(/refused, a creature script has started/);
  });
});

// ---------------------------------------------------------------------------
// The scripted player
// ---------------------------------------------------------------------------

describe('the scripted player (commands only)', () => {
  it('give: the dev giveTool command puts the tool in the hands (or on the back); axe2h writes WEAPONS.axe (logged)', async () => {
    const h = await make();
    const axe = h.give('stoneAxe');
    expect(h.p.inventory!.hands).toMatchObject({ entity: axe, mode: 'wield' });
    expect(h.p.weapon?.id).toBe('stoneAxe');
    // giveTool lets go of what the hands hold first (devOps.ts): the axe comes down; the stick goes on the back.
    const stick = h.give('diggingStick', 'back');
    expect(h.p.inventory!.back).toBe(stick);
    expect(h.ent(stick).state).toBe('stowed');
    expect(h.p.inventory!.hands).toBeNull();
    expect(h.ent(axe).state).toBe('free');
    const spear = h.give('spear');
    expect(h.p.weapon?.id).toBe('spear');
    expect(spear).not.toBe(axe);
    h.give('axe2h');
    expect(h.p.inventory!.hands).toBeNull();
    expect(h.p.weapon).toBe(WEAPONS.axe);
    expect(h.fixtures.filter((f) => f.op === 'give').map((f) => f.what)).toEqual([`stoneAxe → ${axe}`, `diggingStick → ${stick}`, `spear → ${spear}`, 'axe2h (WEAPONS.axe written to the player)']);
  });

  it('standAt moves the player there facing yaw (logged); walk gets there by move commands, or reports a wall', async () => {
    const h = await make();
    h.standAt({ x: 5, z: -3 }, Math.PI / 2);
    expect(flat(h.p.pos, { x: 5, z: -3 })).toBeLessThan(1e-6);
    expect(h.p.yaw).toBeCloseTo(Math.PI / 2, 9);
    expect(h.fixtures.map((f) => f.op)).toEqual(['standAt']);
    const pushed = vi.spyOn(h.w.commands, 'push');
    expect(h.walk({ x: 1, z: 2 })).toBe(true);
    expect(flat(h.p.pos, { x: 1, z: 2 })).toBeLessThanOrEqual(0.12 + 0.05);
    expect(pushed.mock.calls.every(([c]) => c.kind === 'move' && c.player === 1)).toBe(true);
    expect(pushed.mock.calls.length).toBeGreaterThan(30);
    // A fixed wall across the way: tryOnly returns false, otherwise it throws.
    h.box({ p: { x: 1, y: 1, z: 4 }, size: [6, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'wall' });
    h.ticks(1);
    expect(h.walk({ x: 1, z: 6 }, { tryOnly: true })).toBe(false);
    expect(() => h.walk({ x: 1, z: 6 })).toThrow(/harness.walk to \(1.00, 6.00\): stuck/);
  });

  it('verb sends one verb command and waits it out; must throws the refusal; carryTo and dragTo move a load by take, walk and drop', async () => {
    const h = await make();
    const light = h.log({ length: 1.5, r: 0.1, mass: 20, p: { x: 4, y: 0.12, z: 0 } });
    const heavy = h.log({ length: 2, r: 0.2, mass: 110, p: { x: -4, y: 0.25, z: 0 } });
    const post = h.box({ p: { x: 0, y: 1, z: 1.5 }, size: [0.4, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    h.ticks(10);
    const pushed = vi.spyOn(h.w.commands, 'push');
    const refused = h.verb({ verb: 'take', target: post });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('immovable');
    expect(pushed.mock.calls.map(([c]) => c.kind)).toEqual(['verb']);
    expect(() => h.must({ verb: 'take', target: post }, 'take the post')).toThrow('harness: take the post refused (immovable)');
    h.carryTo(light, { x: 2, z: -3 });
    expect(h.p.inventory!.hands).toMatchObject({ entity: light, mode: 'carry' });
    expect(flat(h.p.pos, { x: 2, z: -3 })).toBeLessThan(0.2);
    const placed = h.verb({ verb: 'place', target: 0, at: toCm({ x: 2, y: 0.1, z: -4.2 }), yaw: 64, pitch: 0 });
    expect(placed.ok).toBe(true);
    expect(of(placed.events, 'verb')).toEqual([expect.objectContaining({ verb: 'place', ok: true, entity: light })]);
    h.ticks(30);
    expect(flat(h.ent(light).pose.p, { x: 2, z: -4.2 })).toBeLessThan(0.1);
    expect(h.ent(light).credit).toEqual(['p1']);
    // Dragged: 110 kg is past the carry limit.
    expect(h.dragTo(heavy, { x: -4, z: -5 })).toBe(true);
    expect(h.p.inventory!.hands).toBeNull();
    expect(flat(h.ent(heavy).pose.p, { x: -4, z: -5 })).toBeLessThan(0.6);
    expect(h.ent(heavy).credit).toEqual(['p1']);
  });

  it('strikeAt focuses the target and plays n presses: two E presses with the stone axe chop a focused tree twice', async () => {
    const h = await make();
    const { tree } = h.tree({ at: { x: 0, z: 0 }, diameter: 0.3, height: 15 });
    h.ticks(2);
    h.standAt({ x: -(0.15 + 1.3), z: 0 }, Math.PI / 2);
    h.give('stoneAxe');
    const r = h.strikeAt(tree, 'rpunch', 2);
    expect(of(r.world, 'chop').filter((c) => c.tree === tree)).toHaveLength(2);
    expect(h.w.verbs.focusOf(h.p)).toEqual({ target: tree, at: null });
    expect(h.ent(tree).plant!.cut!.chops).toBe(2);
    expect(h.ent(tree).plant!.cut!.depthSumM).toBeCloseTo(2 * 0.02, 3);
  });

  it('chopTo chops from the side he stands on until remaining ≤ the value (12 stone-axe chops to 0.2 on a 30 cm trunk)', async () => {
    const h = await make();
    const { tree } = h.tree({ at: { x: 0, z: 0 }, diameter: 0.3, height: 15 });
    h.ticks(2);
    h.standAt({ x: 0, z: -3 });
    h.give('stoneAxe');
    const r = h.chopTo(tree, 0.2);
    const cut = h.ent(tree).plant!.cut!;
    expect(cut.remaining).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(r.chops).toBe(12);
    expect(cut.fromDir.z).toBeLessThan(-0.99);
    expect(h.ent(tree).plant!.phase).toBe('notched');
  });

  it('reelIn pulls a slack rope in until the slack left is the asked one, then lets go; pull hauls for n ticks then stops', async () => {
    const h = await make();
    const post = h.box({ p: { x: 0, y: 1, z: 2 }, size: [0.4, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    const coil = h.coil({ material: 'vine', lengthM: 10, at: { x: 1, y: 0, z: 0 } });
    h.ticks(2);
    h.carryTo(coil, { x: 0, z: 0.9 });
    h.must({ verb: 'tie', target: post, at: toCm({ x: 0, y: 1.0, z: 1.8 }) }, 'tie the coil to the post');
    const j = h.w.joints.all().find((x) => x.rope?.entity === coil)!;
    expect(h.p.inventory!.hands).toMatchObject({ mode: 'ropeEnd', joint: j.id });
    h.walk({ x: 0, z: -4 });
    const left = h.reelIn(j.id, 0.5);
    expect(left).toBeLessThanOrEqual(0.5);
    expect(left).toBeGreaterThan(0.3);
    expect(h.w.verbs.continuousOf(h.p)).toBeNull();
    // pull: on for 60 ticks (the last slack reeled in, then the yank on the post), then off.
    const slack = (): number => {
      const jj = h.w.joints.get(j.id)!;
      const e = h.w.joints.endPoints(jj)!;
      return jj.rope!.lengthM - Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y, e.a.z - e.b.z);
    };
    const r = h.pull(60);
    expect(of(r.world, 'verb').filter((v) => v.verb === 'pull' && !v.ok)).toEqual([]);
    expect(slack()).toBeLessThan(0.05);
    expect(Math.max(...h.w.joints.get(j.id)!.tension)).toBeGreaterThan(0);
    h.ticks(2);
    expect(h.w.joints.get(j.id)!.pullN).toBe(0);
    expect(h.w.verbs.continuousOf(h.p)).toBeNull();
  });

  it('pace walks back and forth ±halfM along the line until the tick, then stops; pull or pause ends it early', async () => {
    const h = await make();
    h.standAt({ x: 0, z: 0 });
    const until = h.w.tick + 900;
    h.pace({ x: 0, z: 0 }, { x: 1, z: 0 }, 1, until);
    let lo = Infinity;
    let hi = -Infinity;
    let wide = 0;
    h.ticks(900, () => {
      lo = Math.min(lo, h.p.pos.x);
      hi = Math.max(hi, h.p.pos.x);
      wide = Math.max(wide, Math.abs(h.p.pos.z));
    });
    expect(lo).toBeLessThan(-0.8);
    expect(hi).toBeGreaterThan(0.8);
    expect(lo).toBeGreaterThan(-1.3);
    expect(hi).toBeLessThan(1.3);
    expect(wide).toBeLessThan(0.15);
    h.ticks(60);
    const x = h.p.pos.x;
    h.ticks(60);
    expect(Math.abs(h.p.pos.x - x)).toBeLessThan(1e-6);
    // pause(player) ends a pace at once and pauses idle life.
    h.pace({ x: 0, z: 0 }, { x: 0, z: 1 }, 1, h.w.tick + 900);
    h.ticks(30);
    h.pause(h.p);
    h.ticks(30);
    const z = h.p.pos.z;
    h.ticks(60);
    expect(Math.abs(h.p.pos.z - z)).toBeLessThan(1e-6);
    expect(h.p.idlePaused).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Creatures and observation
// ---------------------------------------------------------------------------

describe('creatures and observation', () => {
  it('creature (brain off: a hold), script, patrol, pause; impacts, wounds, tripwires, nearestDistH', async () => {
    const h = await make(12, 60);
    const ape = h.creature('ape', { x: 6, z: 0 }, 0, { brain: 'off' });
    expect(h.mind(ape).script).toEqual({ kind: 'hold' });
    h.script(ape, { kind: 'route', points: [{ x: 6, z: 5 }] });
    h.until(() => flat(ape.pos, { x: 6, z: 5 }) < 0.6, 900, 'the ape at its route point');
    const giant = h.creature('giantApe', { x: -15, z: 0 }, Math.PI / 2);
    expect(h.mind(giant).script).toBeNull();
    h.patrol(giant, [
      { x: -15, z: 0 },
      { x: -15, z: 20 },
    ]);
    expect(h.mind(giant).state).toBe('patrol');
    expect(h.wounds(giant)).toEqual([]);
    h.pause(giant);
    expect(h.mind(giant).paused).toBe(true);
    expect(giant.idlePaused).toBe(true);
    // A 40 kg log dropped on the held ape: the impact is its, credited to no one (spawned).
    h.script(ape, { kind: 'hold' });
    h.ticks(30);
    const log = h.log({ length: 2, r: 0.1, mass: 40, p: { x: ape.pos.x, y: 3.2, z: ape.pos.z }, q: lyingAlong(Math.PI / 2) });
    h.until(() => h.impacts(ape).length > 0, 240, 'the log on the ape');
    expect(h.impacts(ape).every((i) => i.defender === ape)).toBe(true);
    expect(h.impacts(ape)[0].cause).toMatchObject({ kind: 'entity', entityId: log, credit: [] });
    expect(h.impacts(giant)).toEqual([]);
    // nearestDistH: a 1 m box 3 m off → 2.5 m to its face; the giant's body colliders; nothing → Infinity.
    const box = h.box({ p: { x: 0, y: 0.5, z: -10 }, size: [1, 1, 1], material: 'stone', state: 'fixed', look: 'block' });
    h.ticks(1);
    expect(h.nearestDistH({ x: 0, z: -13 }, [{ kind: 'entity', id: box }])).toBeCloseTo(2.5, 3);
    expect(h.nearestDistH({ x: 0.2, z: -10 }, [{ kind: 'entity', id: box }])).toBe(0);
    const dg = h.nearestDistH({ x: -15, z: 30 }, [{ kind: 'fighter', id: giant.id, part: 'ruler' }]);
    expect(dg).toBeGreaterThan(20);
    expect(dg).toBeLessThan(30);
    expect(h.nearestDistH({ x: 0, z: 0 }, [{ kind: 'entity', id: 9999 }])).toBe(Infinity);
    // A rope tied taut across a gap at shin height, walked into: a tripwire.
    const a = h.box({ p: { x: 10, y: 0.5, z: -6 }, size: [0.3, 1, 0.3], material: 'dryWood', state: 'fixed', look: 'post' });
    const b = h.box({ p: { x: 14, y: 0.5, z: -6 }, size: [0.3, 1, 0.3], material: 'dryWood', state: 'fixed', look: 'post' });
    const coil = h.coil({ material: 'vine', lengthM: 6, at: { x: 12, y: 0, z: -4 } });
    h.ticks(2);
    h.carryTo(coil, { x: 10.9, z: -6 });
    h.must({ verb: 'tie', target: a, at: toCm({ x: 10.15, y: 0.3, z: -6 }) });
    h.walk({ x: 13.1, z: -6 });
    h.must({ verb: 'tie', target: b, at: toCm({ x: 13.85, y: 0.3, z: -6 }) });
    expect(h.tripwires()).toEqual([]);
    h.walk({ x: 12, z: -4.5 });
    h.walk({ x: 12, z: -7.5 }, { tryOnly: true });
    expect(h.tripwires().length).toBeGreaterThan(0);
    expect(h.tripwires()[0].by).toMatchObject({ kind: 'fighter', id: h.p.id });
  });

  it('saveBytes and loadHarness: the same world back; bodyStateBytes are the same for two runs of the same commands', async () => {
    const run = async (): Promise<Harness> => {
      const h = await make(21, 30);
      const s = h.stick({ length: 1.4, r: 0.05, p: { x: 2, y: 0.06, z: 0.1 }, sharp: { end: 1, s: 0.6 } });
      h.ticks(1);
      h.carryTo(s, { x: 0.1, z: 1.5 });
      // (Off the terrain's vertex lines: a place ray straight down a heightfield vertex misses it, see the report.)
      h.must({ verb: 'place', target: 0, at: toCm({ x: 0.13, y: 0.7, z: 2.53 }), yaw: 0, pitch: 64 });
      h.ticks(30);
      return h;
    };
    const a = await run();
    const b = await run();
    expect(a.bodyStateBytes()).toEqual(b.bodyStateBytes());
    const bytes = a.saveBytes();
    expect(bytes).toEqual(b.saveBytes());
    const l = await loadHarness(bytes);
    live.push(l);
    expect(l.w.tick).toBe(a.w.tick);
    expect(l.w.nav).toBeNull();
    expect(l.w.combat.devChecks).toBe(true);
    expect(l.w.entities.all().map((e) => [e.id, e.state])).toEqual(a.w.entities.all().map((e) => [e.id, e.state]));
    expect(l.p.playerId).toBe('p1');
  });
});

// ---------------------------------------------------------------------------
// The dig planner (§11.0, RF-11, RT-2)
// ---------------------------------------------------------------------------

/** The RT lab's no-spoil kernel (as verbs.dig.test runs it): the strike count the planner's caps scale. */
function kernelStrikes(o: { lengthX: number; widthZ: number; depth: number }): number {
  const t = new Terrain(null, 30);
  const pts: [number, number][] = [];
  const x0 = -o.lengthX / 2 + 0.25;
  const z0 = -o.widthZ / 2 + 0.25;
  for (let i = 0; x0 + 0.3 * i <= -x0 + 1e-9; i++) for (let j = 0; z0 + 0.3 * j <= -z0 + 1e-9; j++) pts.push([x0 + 0.3 * i, z0 + 0.3 * j]);
  let strikes = 0;
  for (let pass = 0; pass < 2000; pass++) {
    let any = false;
    for (const [x, z] of pts) {
      const v = t.vertexIndex(x, z);
      if (t.vertexHeightAt(v.gi, v.gj) <= -o.depth + 0.02) continue;
      any = true;
      strikes++;
      t.lower(x, z, 1);
    }
    if (!any) break;
  }
  return strikes;
}

describe('the dig planner (§11.0)', () => {
  // (A 2 × 1 m pit is no planner test: no spot inside a 1 m wide hole is 1 m from its middle, so its floor can't be
  // struck from the floor; P15's verbs.dig.test checks the dirt policy on small pits at the kernel level.)
  for (const pit of [{ lengthX: 3, widthZ: 2, depth: 1.5 }]) {
    it(`digs a ${pit.lengthX} × ${pit.widthZ} × ${pit.depth} m pit with the digging stick within its tick and strike caps`, async () => {
      const h = await make(31, 40);
      h.standAt({ x: -pit.lengthX / 2 - 2, z: 0 });
      h.give('diggingStick');
      const kernel = kernelStrikes(pit);
      // GATES, in §11.0's form (360,000 = 1.2 × 3,185 strikes × 88 ticks + 24,000 for walking): 1.2 × the no-spoil
      // kernel's strikes, and 88 ticks a strike plus 24,000.
      const maxStrikes = Math.ceil(PLANNER_CAP.strikesPerKernel * kernel);
      const maxTicks = Math.ceil(PLANNER_CAP.ticksPerStrike * maxStrikes + PLANNER_CAP.walkTicks);
      const r = h.digPit({ centre: { x: 0, z: 0 }, ...pit, maxTicks, maxStrikes });
      console.info(`dig ${pit.lengthX}×${pit.widthZ}×${pit.depth}: ${JSON.stringify(r)}; kernel ${kernel}, caps ${maxStrikes} strikes / ${maxTicks} ticks`);
      expect(r.strikes).toBeLessThanOrEqual(maxStrikes);
      expect(r.ticks).toBeLessThanOrEqual(maxTicks);
      // Dug: every strike centre's vertex at the floor (the kernel's criterion; DIG_PLAN.edgeTolM within edgeM of the
      // edge, a given-up edge centre anything), the player out on the rim, the stick in hand, no dirt pile on the pit.
      const t = h.w.terrain;
      const gaveUp = (x: number, z: number): boolean => r.abandoned.some((a) => Math.abs(a.x - x) < 1e-6 && Math.abs(a.z - z) < 1e-6);
      for (const a of r.abandoned) expect(Math.min(pit.lengthX / 2 - Math.abs(a.x), pit.widthZ / 2 - Math.abs(a.z))).toBeLessThanOrEqual(DIG_PLAN.edgeM + 1e-9);
      for (let i = 0; -pit.lengthX / 2 + 0.25 + 0.3 * i <= pit.lengthX / 2 - 0.25 + 1e-9; i++) {
        for (let j = 0; -pit.widthZ / 2 + 0.25 + 0.3 * j <= pit.widthZ / 2 - 0.25 + 1e-9; j++) {
          const x = -pit.lengthX / 2 + 0.25 + 0.3 * i;
          const z = -pit.widthZ / 2 + 0.25 + 0.3 * j;
          if (gaveUp(x, z)) continue;
          const edge = Math.min(pit.lengthX / 2 - Math.abs(x), pit.widthZ / 2 - Math.abs(z)) <= DIG_PLAN.edgeM;
          const v = t.vertexIndex(x, z);
          expect(t.vertexHeightAt(v.gi, v.gj), `(${x.toFixed(2)}, ${z.toFixed(2)})`).toBeLessThanOrEqual(-pit.depth + (edge ? DIG_PLAN.edgeTolM : DIG_PLAN.floorTolM) + 1e-6);
        }
      }
      expect(t.heightAt(h.p.pos.x, h.p.pos.z)).toBeGreaterThan(-0.4);
      expect(h.p.weapon?.id).toBe('sharpStick');
      const onPit = h.w.entities.all().filter((e) => isDirtPile(e) && Math.abs(e.pose.p.x) < pit.lengthX / 2 && Math.abs(e.pose.p.z) < pit.widthZ / 2);
      expect(onPit).toEqual([]);
    });
  }
});

/** The planner's caps for the small pits (the form of §11.0's 1.2 × 3,185 strikes and 360,000 ticks). */
const PLANNER_CAP = { strikesPerKernel: 1.2, ticksPerStrike: 88, walkTicks: 24_000 } as const;

// ---------------------------------------------------------------------------
// The scenes (§11.0): entities and verbs only
// ---------------------------------------------------------------------------

describe('the scenes', () => {
  it('scenes.ts calls no entity or joint mutator, no teleport and no creature spawn: only the factory, verbs and the harness', () => {
    const src = readFileSync(fileURLToPath(new URL('./support/scenes.ts', import.meta.url)), 'utf8');
    // Code only: comments removed.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const reads = new Set(['get', 'all', 'view', 'endPoints', 'anchorPoint', 'isAnchored', 'heightAt', 'originalHeightAt']);
    const calls = [...code.matchAll(/\.(entities|joints)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(calls.filter((c) => !reads.has(c.split('.')[1]))).toEqual([]);
    for (const banned of [/\.teleport\(/, /spawnCreature\(/, /\.setPose\(/, /\.setState\(/, /queueImpulse\(/, /from '\.\.\/\.\.\/src\/world\/factory'/, /\.commands\.push\(/]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
    // Rule 1 (AC-1's spirit): no trap in a name or a string.
    expect(code).not.toMatch(/trap/i);
  });

  it('buildStakedLog: a 300 kg log 1.0 m up lashed to two driven stakes the player placed; anchored (a blocker) once unstaged', async () => {
    const h = await make(41, 40);
    const r = buildStakedLog(h, { centre: { x: 0, y: 1.0, z: 0 }, yaw: 0, massKg: 300, lengthM: 4.4 });
    h.ticks(120);
    const log = h.ent(r.log);
    expect(log.mass).toBeCloseTo(300, 3);
    expect(log.state).toBe('free');
    expect(h.w.entities.isAnchored(log)).toBe(true);
    expect(log.pose.p.y).toBeCloseTo(1.0, 2);
    for (const s of r.stakes) {
      expect(h.ent(s).state).toBe('anchored');
      expect(h.ent(s).credit).toEqual(['p1']);
    }
    const lashes = h.w.joints.all().filter((j) => j.kind === 'lash' && [j.a.entity, j.b.entity].includes(r.log));
    expect(lashes).toHaveLength(2);
    for (const j of lashes) expect(j.credit).toEqual(['p1']);
    expect(h.fixtures.filter((f) => f.op === 'stage' || f.op === 'unstage')).toHaveLength(2);
  });

  it('buildStakedWall: two stacked 16 m logs, 1.0 m high, lashed to stakes at both ends; anchored once unstaged', async () => {
    const h = await make(42, 50);
    const ids = buildStakedWall(h, { start: { x: -8, z: 0 }, dir: { x: 1, z: 0 }, lengthM: 16, height: 1.0 });
    h.ticks(120);
    const [lower, upper, ...stakes] = ids;
    for (const id of [lower, upper]) {
      expect(h.ent(id).state).toBe('free');
      expect(h.w.entities.isAnchored(h.ent(id))).toBe(true);
    }
    expect(h.ent(lower).pose.p.y).toBeCloseTo(0.25, 2);
    expect(h.ent(upper).pose.p.y).toBeCloseTo(0.75, 2);
    expect(stakes.map((s) => h.ent(s).state)).toEqual(['anchored', 'anchored']);
    expect(h.w.joints.all().filter((j) => j.kind === 'lash')).toHaveLength(4);
  });

  it('buildNotchedTree: chopped to remaining from the given side, its vine hanging on the fall side; it stands notched', async () => {
    const h = await make(43, 60);
    const r = buildNotchedTree(h, { at: { x: 0, z: 0 }, fromSide: { x: -1, z: 0 }, remaining: 0.2, vine: { anchorH: 10, lengthM: 18.2 } });
    h.ticks(120);
    const plant = h.ent(r.tree).plant!;
    expect(plant.phase).toBe('notched');
    expect(plant.cut!.remaining).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(plant.cut!.chops).toBe(12);
    expect(plant.cut!.fromDir.x).toBeLessThan(-0.99);
    const j = h.w.joints.get(r.vineJoint)!;
    const ends = h.w.joints.endPoints(j)!;
    // The loose end lies out along the fall line (+x).
    expect(Math.max(ends.a.x, ends.b.x)).toBeGreaterThan(7);
  });

  it('buildLeaningLog: a free prop placed upright, a 40 kg log placed sloped onto it (32.9°), bait lashed to the prop by a 0.65 m rope', async () => {
    const h = await make(44, 40);
    const r = buildLeaningLog(h, { at: { x: 0, z: 0 }, yaw: Math.PI / 2 });
    h.ticks(120);
    const prop = h.ent(r.prop);
    const log = h.ent(r.log);
    expect(prop.state).toBe('free');
    // Upright: its axis (local y) vertical, either end up (a blunt stick of even thickness).
    expect(Math.abs(1 - 2 * (prop.pose.q.x ** 2 + prop.pose.q.z ** 2))).toBeGreaterThan(0.9998);
    expect(log.state).toBe('free');
    expect(log.mass).toBeCloseTo(40, 3);
    const axis = { x: 2 * (log.pose.q.x * log.pose.q.y - log.pose.q.w * log.pose.q.z), y: 1 - 2 * (log.pose.q.x ** 2 + log.pose.q.z ** 2) };
    const pitch = (Math.atan2(Math.abs(axis.y), Math.abs(axis.x)) * 180) / Math.PI;
    expect(Math.abs(pitch - 32.9)).toBeLessThan(1);
    const rope = h.w.joints.all().find((j) => j.kind === 'rope' && [j.a.entity, j.b.entity].includes(r.bait));
    expect(rope?.rope?.lengthM).toBeCloseTo(0.65, 1);
    for (const id of [r.prop, r.log, r.bait]) expect(h.ent(id).credit).toEqual(['p1']);
    expect(h.fixtures.filter((f) => f.op !== 'standAt')).toEqual([]);
  });

  it('buildHauledLog: the 30 kg log hung on two vines, hauled back and tied to a driven stake; the axe on the back', async () => {
    const h = await make(45, 50);
    const r = buildHauledLog(h, { at: { x: 0, z: 0 } });
    h.ticks(180);
    const log = h.ent(r.log);
    const tie = h.w.joints.get(r.tie)!;
    expect([tie.a.entity, tie.b.entity]).toEqual([r.log, r.stake]);
    expect(h.ent(r.stake).state).toBe('anchored');
    // Hauled back: its centre well behind the vines' anchors (x 0) and up off the ground.
    expect(log.pose.p.x).toBeLessThan(-2);
    expect(log.pose.p.y).toBeGreaterThan(1);
    const vines = h.w.joints.all().filter((j) => j.kind === 'rope' && j.id !== r.tie && [j.a.entity, j.b.entity].includes(r.log));
    expect(vines).toHaveLength(2);
    expect(of(h.history.world, 'joint').filter((e) => e.what === 'snap')).toEqual([]);
    expect(h.tripwires()).toEqual([]);
    expect(h.p.inventory!.back).not.toBeNull();
    expect(h.ent(h.p.inventory!.back!).look).toBe('stick');
    expect(h.p.inventory!.hands).toBeNull();
    void BACK_SLOT;
  });
});

// ---------------------------------------------------------------------------
// The scene cache (globalSetup.ts)
// ---------------------------------------------------------------------------

describe('the scene cache (§11.0)', () => {
  it('ensureScene reuses the file for the same hash and rebuilds it (removing the old one) for a changed hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rotw-scenes-'));
    try {
      let builds = 0;
      const build = async (): Promise<Uint8Array> => new Uint8Array([++builds]);
      const h1 = sceneHash();
      const h2 = sceneHash('a changed tree');
      expect(h2).not.toBe(h1);
      expect(sceneHash()).toBe(h1); // the hash is a function of the tree
      const a = await ensureScene(dir, 'probe', h1, build);
      expect(a.built).toBe(true);
      const mtime = statSync(a.path).mtimeMs;
      const b = await ensureScene(dir, 'probe', h1, build);
      expect(b).toEqual({ path: a.path, built: false });
      expect(builds).toBe(1);
      expect(statSync(a.path).mtimeMs).toBe(mtime);
      expect([...readScene(dir, 'probe', h1)]).toEqual([1]);
      const c = await ensureScene(dir, 'probe', h2, build);
      expect(c.built).toBe(true);
      expect(c.path).not.toBe(a.path);
      expect(builds).toBe(2);
      expect([...readScene(dir, 'probe', h2)]).toEqual([2]);
      expect(() => readScene(dir, 'probe', h1)).toThrow(/no scene for hash/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("globalSetup builds what the test files name: cachedScene('probe') is the probe scene, loaded by loadHarness", async () => {
    expect(wantedScenes()).toContain('probe');
    expect(SCENE_DIR).toMatch(/packages[\\/]sim[\\/]\.cache[\\/]scenes$/);
    const h = await loadHarness(cachedScene('probe'));
    live.push(h);
    const stakes = h.w.entities.all().filter((e) => e.state === 'anchored');
    expect(stakes).toHaveLength(PROBE_SCENE.stakes.length);
    // Where the scene put them (scenes.ts nudges a point 13 mm off the terrain's vertex lines).
    for (const s of PROBE_SCENE.stakes) expect(Math.min(...stakes.map((e) => flat(e.pose.p, s)))).toBeLessThan(0.03);
    for (const s of stakes) expect(s.credit).toEqual(['p1']);
    const log = h.w.entities.all().find((e) => e.look === 'log')!;
    expect(flat(log.pose.p, PROBE_SCENE.log)).toBeLessThan(0.1);
  });

  // The AC-2(b)/AC-3 pit (§11.2(b)): built by globalSetup only when a test file names it or ROTW_SCENES lists it (about
  // a quarter of an hour), so this check runs with ROTW_SCENES=pit.
  const PIT = ['p', 'i', 't'].join('');
  it.runIf((process.env.ROTW_SCENES ?? '').split(',').includes(PIT))('the cached pit: 8 × 6 × 2.5 m, 108 driven stakes credited p1, bearers across it and grass on them', async () => {
    const h = await loadHarness(cachedScene(PIT));
    live.push(h);
    const t = h.w.terrain;
    expect(t.heightAt(0, 0)).toBeLessThan(-2.5 + 0.03);
    const stakes = h.w.entities.all().filter((e) => e.state === 'anchored');
    expect(stakes).toHaveLength(108);
    for (const s of stakes) {
      expect(s.credit).toEqual(['p1']);
      expect(s.sharpPoints[0].sharpness).toBeCloseTo(0.6, 6);
      expect(Math.abs(s.pose.p.x)).toBeLessThan(4);
      expect(Math.abs(s.pose.p.z)).toBeLessThan(3);
    }
    const bearers = h.w.entities.all().filter((e) => e.material === 'rottenWood');
    expect(bearers).toHaveLength(20);
    for (const b of bearers) expect(b.pose.p.y).toBeGreaterThan(-0.3);
    const grassOn = h.w.entities.all().filter((e) => e.look === 'grass' && Math.abs(e.pose.p.x) < 4 && Math.abs(e.pose.p.z) < 3.2);
    expect(grassOn.length).toBeGreaterThanOrEqual(20);
    for (const g of grassOn) expect(g.credit).toEqual(['p1']);
  });
});
