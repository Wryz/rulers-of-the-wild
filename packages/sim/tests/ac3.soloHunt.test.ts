// AC-3: the solo hunt (SPEC:900; docs/M1-DESIGN.md §11.3; package P29).
//
// "Solo hunting works: a scripted player lures the giant ape along a path into a weight-triggered spike pit, then pulls a
// rope from at least 15 m away to drop a log on it. The player is never within 10 m when either trap springs."
//
// The scene (entities and verbs only, rule 1):
// - the cached pit (tests/support/scenes.ts buildPit through cachedScene('pit')): 8 × 6 × 2.5 m at (0, 0), 108 stakes
//   on 0.6 m, the verb-built cover of rotten bearers and grass;
// - step 1: a 30 cm × 15 m tree at (0, −9) with a hanging vine anchored 10 m up, 20.2 m long (the generator's longest,
//   §6.7);
// - step 2: the player chops it from its −z side with the stone axe to remaining ≤ 0.14, so it would fall along +z
//   across the pit; it stands on its hinge (no pull);
// - step 3: the player takes the vine's end, splices an 8 m vine coil from his belt to it (27.7 m, §5.8), walks to
//   P = (18, 1) and reels in until 0.3 m of slack is left;
// - step 4: the giant (brain on) starts at (−40, z0) in `patrol` on a two-waypoint route (−40, z0) → (30, z0) through
//   the pit ("along a path", RT-9); the player paces ±1 m at P across the line to the tie, so it sees him moving and
//   chases, telegraphs and charges at him (the lure is being seen, SPEC:468);
// - step 5: the player starts pulling on the first tick the giant is `tripped` ("then pulls a rope").
// The tests script the player (commands) and the creature (its route; in the second `it` its charge), never a trap.
//
// DEVIATION (§11.3 step 1 is silent on the vine's side): the vine hangs on the side facing P (yaw toward P), so its
// slack lies out on the ground toward P, beside the pit, and the player takes its end without stepping on the cover. On
// the fall side (+z) its end would lie on the cover in the middle of the pit.
// DEVIATION (§11.3 step 3 "the starter cache's 8 m coil"): scene 'empty' has no starter cache; the 8 m vine coil is
// factory-spawned next to the player (a spawn of what the Clearing generates), taken and stowed on the belt by verbs.
//
// STATUS (P29, at d5b0f2b): every `it` FAILS, and is left failing (never weakened, §11). The cached pit's spoil ring
// (§4.13: spoil raised up to spoilMaxRiseM 1 m above original, never within spoilSetbackM 1.5 m of dug ground) is a
// flat 1 m ridge with sheer edges all round the pit, the ends included (x −8 … −6 and +6 … +8 on z = 0). The ruler's
// mover blocks any move onto ground steeper than RULER_BODY_TUNING.maxSlopeDeg 40° (§4.7 step 2, rulerBody.ts
// slopeLimit), so the scripted 7 m/s charge stops dead at the ridge's foot (−8.75, 0.48) and never reaches the cover;
// the ruler nav layer (climb 1.0 m, slope 40°) paths round the pit, so the brain-on chase detours by its −z side, never
// charges across it, and blunders into the notched tree there (felling it itself, and the player's tie with it). A
// player can't clear a way with M1's verbs: digging the ridge away throws a new 1 m ridge of spoil ≥ 1.5 m further out
// (P29 lab: a 3.6 × 4 m cut through the −x end, 780 strikes, raised a new sheer ridge at x −12 … −10.5). In the lab,
// with the slope limits raised (mover 85°, nav 85°, climb 1.3 m), the brain-on lure works (it charges at P from
// (−9, 0 … 1.3) across the pit), but it trips 'ledge' stepping off the ridge's inner edge at x −7.5, before any cover
// load break (the cover breaks 1-2 s later as it falls in), and the trunk, felled 0.3 s after the pull, never hits it.
// See the P29 report.
//
// Gates and pins (§11): every assertion below is a GATE (the criterion's meaning). No PIN is frozen yet: §11.3's
// lab-first step could not measure a completed hunt (STATUS above); the numbers to pin (stake and trunk wound HP, the
// trunk's arrival after the trip) are printed by the `console.info` lines `AC-3 …` once it completes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { rulerDown, rulerHp } from '../src/sim/ruler';
import type { RulerMind } from '../src/world/creatures/rulerMind';
import type { Owner, WorldEvent, WoundRecord } from '../src/world/types';
import { cachedScene, type Harness, loadHarness, SCENE_BUILD_TIMEOUT_MS, type XZ } from './support/worldHarness';

/** Rapier, a navmesh and minutes of ticks per run (§11: 120 s and up for anything with Rapier). */
vi.setConfig({ testTimeout: 900_000 });

// ---------------------------------------------------------------------------
// The recipe (§11.3; recipe constants, never tuning)
// ---------------------------------------------------------------------------

const PIT = { centre: { x: 0, z: 0 }, lengthX: 8, widthZ: 6 } as const;
const TREE = { at: { x: 0, z: -9 }, diameter: 0.3, height: 15, remaining: 0.14, vine: { anchorH: 10, lengthM: 20.2 } } as const;
/** The 8 m coil spliced to the vine (§5.8: 20.2 + 8 − 0.5 = 27.7 m). */
const COIL = { lengthM: 8, at: { x: -3, z: -13 } } as const;
/** Where the player waits at the end of the pull rope, and the slack he leaves. */
const P: XZ = { x: 18, z: 1 };
const SLACK_M = 0.3;
const PACE_HALF_M = 1;
/** The giant's start and the far end of its patrol route. */
const START_X = -40;
const ROUTE_END_X = 30;
/** Ticks budgets: the lure (from the giant's spawn to its trip), the pull (from the first pulling tick to the fall). */
const LURE_MAX_TICKS = 60 * 90;
const PULL_MAX_TICKS = 60 * 15;
/** After the fall: the trunk's landing and the wounds it makes. */
const AFTER_FELL_TICKS = 60 * 6;

/** The criterion's distances (SPEC:900). */
const MIN_SPRING_DIST_M = 10;
const MIN_PULL_DIST_M = 15;
/** SPEC:502: a wound is a hit above 2 % of the ruler's 12,000 HP. */
const WOUND_MIN_HP = 240;

// ---------------------------------------------------------------------------
// Scene helpers (observation only)
// ---------------------------------------------------------------------------

const flat = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);

interface Scene {
  tree: number;
  joint: number;
  /** The cover: the bearers and grass bundles lying over the pit (and, as they break, their pieces). */
  cover: Set<number>;
  stakes: Set<number>;
}

/** The pit's cover and stakes in the loaded scene: rotten bearers and grass over the footprint; the anchored points in it. */
function pitParts(h: Harness): { cover: Set<number>; stakes: Set<number> } {
  const cover = new Set<number>();
  const stakes = new Set<number>();
  for (const e of h.w.entities.all()) {
    const { x, z } = e.pose.p;
    const over = Math.abs(x - PIT.centre.x) <= PIT.lengthX / 2 + 0.5 && Math.abs(z - PIT.centre.z) <= PIT.widthZ / 2 + 1.5;
    if (!over) continue;
    if (e.material === 'rottenWood' || e.look === 'grass') cover.add(e.id);
    else if (e.state === 'anchored' && e.sharpPoints.length > 0) stakes.add(e.id);
  }
  return { cover, stakes };
}

/** The horizontal distance from (x, z) to the nearest terrain vertex dug below its original height (the pit's footprint). */
function distToDug(h: Harness, from: XZ): number {
  const t = h.w.terrain;
  const sp = t.spacing;
  let best = Infinity;
  for (let x = PIT.centre.x - PIT.lengthX; x <= PIT.centre.x + PIT.lengthX; x += sp) {
    for (let z = PIT.centre.z - PIT.widthZ; z <= PIT.centre.z + PIT.widthZ; z += sp) {
      if (t.heightAt(x, z) < t.originalHeightAt(x, z) - 0.05) best = Math.min(best, flat(from, { x, z }));
    }
  }
  return best;
}

const giantOwners = (g: Fighter): Owner[] => (['kcc', 'zone', 'slab', 'ruler'] as const).map((part) => ({ kind: 'fighter', id: g.id, part }));
const entityOwners = (ids: Iterable<number>): Owner[] => [...ids].map((id) => ({ kind: 'entity', id }));

/** Every distance the criterion bounds, from the player's root, now. */
interface Distances {
  tick: number;
  player: XZ;
  cover: number;
  pit: number;
  giant: number;
  trunk: number;
  /** The tie (the vine's anchor on the trunk), horizontally. */
  tie: number;
}

function distances(h: Harness, s: Scene, g: Fighter): Distances {
  const at = { x: h.p.pos.x, z: h.p.pos.z };
  const plant = h.w.entities.get(s.tree)?.plant;
  const trunkIds = [s.tree, ...(plant?.stump ? [plant.stump] : [])].filter((id) => h.w.entities.get(id));
  const j = h.w.joints.get(s.joint);
  const pts = j ? h.w.joints.endPoints(j) : null;
  return {
    tick: h.w.tick,
    player: at,
    cover: h.nearestDistH(at, entityOwners([...s.cover].filter((id) => h.w.entities.get(id)))),
    pit: distToDug(h, at),
    giant: h.nearestDistH(at, giantOwners(g)),
    trunk: h.nearestDistH(at, entityOwners(trunkIds)),
    tie: pts ? flat(at, pts.a) : NaN,
  };
}

const fmt = (d: Distances): string =>
  `tick ${d.tick} player (${d.player.x.toFixed(2)}, ${d.player.z.toFixed(2)}): cover ${d.cover.toFixed(2)} m, pit ${d.pit.toFixed(2)} m, giant ${d.giant.toFixed(2)} m, trunk/stump ${d.trunk.toFixed(2)} m, tie ${d.tie.toFixed(2)} m`;

/** What happened to the rope, the tree and the player so far (for a failure's message). */
function story(h: Harness, s: Scene, g: Fighter): string {
  const ev = h.history.world.filter(
    (e) =>
      (e.type === 'joint' && e.joint === s.joint) ||
      (e.type === 'fell' && e.tree === s.tree) ||
      (e.type === 'tripwire' && e.joint === s.joint) ||
      (e.type === 'impact' && e.defender === h.p) ||
      (e.type === 'trip' && e.f === g) ||
      (e.type === 'launch' && e.f === h.p),
  );
  // The ground the giant crosses toward the pit (the dig's spoil ring, §4.13): metres above the original surface every
  // 0.5 m along its row from x −14 to the pit's end.
  const t = h.w.terrain;
  const row: string[] = [];
  for (let x = -14; x <= PIT.centre.x - PIT.lengthX / 2; x += 0.5) row.push((t.heightAt(x, g.pos.z) - t.originalHeightAt(x, g.pos.z)).toFixed(1));
  return `giant ${g.state} at (${g.pos.x.toFixed(2)}, ${g.pos.y.toFixed(2)}, ${g.pos.z.toFixed(2)}), the ground along z ${g.pos.z.toFixed(1)} from x −14 to −4 (m above original): ${row.join(' ')}; hands ${JSON.stringify(h.p.inventory?.hands ?? null)}, player ${h.p.state} at (${h.p.pos.x.toFixed(2)}, ${h.p.pos.z.toFixed(2)}); events: ${ev
    .map((e) => (e.type === 'impact' ? `impact on player ${e.damage.toFixed(1)} HP by ${e.cause.kind} ${e.cause.entityId ?? e.cause.fighterId}` : e.type === 'tripwire' ? `tripwire by ${JSON.stringify(e.by)} ${e.loadN.toFixed(0)} N snapped ${e.snapped}` : e.type === 'joint' ? `joint ${e.what}` : e.type === 'trip' ? `trip ${e.why}` : e.type))
    .join(', ')}`;
}

// ---------------------------------------------------------------------------
// Steps 1-3: the tree, the chop, the rope (verbs only)
// ---------------------------------------------------------------------------

function rigTheTree(h: Harness): Scene {
  const { cover, stakes } = pitParts(h);
  const toP = Math.atan2(P.x - TREE.at.x, P.z - TREE.at.z);
  // Off the −z rim, clear of where the trunk will stand.
  h.walk({ x: -2, z: -12 });
  // Step 1.
  const t = h.tree({ at: TREE.at, diameter: TREE.diameter, height: TREE.height, vine: { anchorH: TREE.vine.anchorH, lengthM: TREE.vine.lengthM, yaw: toP } });
  if (!t.vine) throw new Error('AC-3: the tree has no vine');
  const coil = h.coil({ material: 'vine', lengthM: COIL.lengthM, at: { x: COIL.at.x, y: h.w.terrain.heightAt(COIL.at.x, COIL.at.z), z: COIL.at.z } });
  h.ticks(2);
  h.approach(coil);
  h.must({ verb: 'take', target: coil }, 'take the 8 m coil');
  h.must({ verb: 'stow', target: 0, slot: 0 }, 'the coil to the belt');
  // Step 2: chopped from the −z side (it falls away from the cut, along +z).
  h.give('stoneAxe');
  h.walk({ x: TREE.at.x, z: TREE.at.z - TREE.diameter / 2 - 1.3 });
  const chop = h.chopTo(t.tree, TREE.remaining);
  h.ticks(120);
  const plant = h.ent(t.tree).plant!;
  console.info(`AC-3 chop: ${chop.chops} chops (${chop.swings} swings), remaining ${plant.cut?.remaining.toFixed(3)}, fromDir (${plant.cut?.fromDir.x.toFixed(3)}, ${plant.cut?.fromDir.z.toFixed(3)}), ${plant.phase} 2 s on`);
  // Step 3: the vine end, the splice, the walk to P, the reel-in.
  // (The back holds the digging stick the pit was dug with: the axe is put down.)
  h.must({ verb: 'drop', target: 0 }, 'put the axe down');
  h.approach(t.vine.rope);
  h.must({ verb: 'take', target: t.vine.rope }, 'take the vine end');
  h.must({ verb: 'tie', target: h.p.inventory!.belt[0]! }, 'splice the coil to the vine');
  h.walk(P);
  const slack = h.reelIn(t.vine.joint, SLACK_M);
  const rope = h.w.joints.get(t.vine.joint)!.rope!;
  console.info(`AC-3 rope: ${rope.lengthM.toFixed(2)} m spliced, ${slack.toFixed(3)} m slack left at (${h.p.pos.x.toFixed(2)}, ${h.p.pos.z.toFixed(2)}), the tree ${h.ent(t.tree).plant!.phase}, tick ${h.w.tick}`);
  return { tree: t.tree, joint: t.vine.joint, cover, stakes };
}

// ---------------------------------------------------------------------------
// Steps 4-5: the lure and the pull
// ---------------------------------------------------------------------------

interface HuntResult {
  trip: Extract<WorldEvent, { type: 'trip' }>;
  tripTick: number;
  /** The first break of a cover entity: the pit springs. */
  pitSpring: Distances;
  coverBreak: Extract<WorldEvent, { type: 'break' }>;
  pullStart: Distances;
  fellSpring: Distances;
  fell: Extract<WorldEvent, { type: 'fell' }>;
  aliveAfterPit: boolean;
  stakeWounds: WoundRecord[];
  trunkWounds: WoundRecord[];
  states: string[];
}

/** Runs the hunt from the giant's spawn: `lure` drives it (brain on: patrol; brain off: a scripted charge). */
function hunt(h: Harness, s: Scene, g: Fighter, what: string): HuntResult {
  const m = h.mind(g) as RulerMind;
  const along = { x: -(TREE.at.z - P.z), z: TREE.at.x - P.x }; // across the line from P to the tie
  h.pace(P, along, PACE_HALF_M, h.w.tick + LURE_MAX_TICKS + 60);
  const states: string[] = [];
  let last = '';
  const note = (): void => {
    const st = `${m.state}/${g.state}`;
    if (st === last) return;
    last = st;
    states.push(`${h.w.tick} ${st} (${g.pos.x.toFixed(1)}, ${g.pos.z.toFixed(1)})`);
  };
  let pitSpring: Distances | null = null;
  let coverBreak: Extract<WorldEvent, { type: 'break' }> | null = null;
  let trip: Extract<WorldEvent, { type: 'trip' }> | null = null;
  let tripTick = -1;
  const watch = (r: { world: WorldEvent[] }): void => {
    for (const e of r.world) {
      if (e.type === 'break' && s.cover.has(e.entity)) {
        for (const q of e.pieces) s.cover.add(q);
        if (!coverBreak) {
          coverBreak = e;
          pitSpring = distances(h, s, g);
        }
      }
      if (e.type === 'trip' && e.f === g && !trip) {
        trip = e;
        tripTick = h.w.tick;
      }
    }
  };
  // Step 4: the lure, until the giant is tripped.
  for (let t = 0; g.state !== 'tripped'; t++) {
    if (t >= LURE_MAX_TICKS) throw new Error(`${what}: the giant did not trip in ${LURE_MAX_TICKS} ticks; its states: ${states.join(', ')}; ${story(h, s, g)}`);
    watch(h.step());
    note();
  }
  // Step 5: on the first tick it is tripped, the player stops pacing and pulls (one command tick: a zero move and the
  // pull on). (reelIn with no slack limit only ends the pace; the pull is the verb command below.)
  h.reelIn(s.joint, Number.POSITIVE_INFINITY);
  h.w.commands.push(moveCommand(h.w.tick + 1, 1, 0, 0));
  const on = h.verb({ verb: 'pull', target: 0, charge: 255 });
  if (!on.ok) throw new Error(`${what}: the pull was refused (${on.reason}); ${story(h, s, g)}; states ${states.join(', ')}`);
  watch({ world: on.events });
  note();
  const pullStart = distances(h, s, g);
  let fell: Extract<WorldEvent, { type: 'fell' }> | null = null;
  let fellSpring: Distances | null = null;
  let aliveAfterPit = g.alive;
  for (const e of on.events) if (e.type === 'fell' && e.tree === s.tree) fell = e;
  if (fell) fellSpring = pullStart;
  for (let t = 0; !fell; t++) {
    if (t >= PULL_MAX_TICKS) throw new Error(`${what}: the tree did not fall in ${PULL_MAX_TICKS} ticks of pulling`);
    const r = h.step();
    watch(r);
    note();
    for (const e of r.world) {
      if (e.type === 'fell' && e.tree === s.tree) {
        fell = e;
        fellSpring = distances(h, s, g);
        aliveAfterPit = g.alive;
      }
    }
  }
  h.verb({ verb: 'pull', target: 0, charge: 0 });
  const fellTick = h.w.tick;
  h.ticks(AFTER_FELL_TICKS, (r) => {
    watch(r);
    note();
  });
  const ws = h.wounds(g);
  const stakeWounds = ws.filter((wd) => wd.cause.kind === 'entity' && wd.cause.entityId !== null && s.stakes.has(wd.cause.entityId));
  const trunkWounds = ws.filter((wd) => wd.cause.kind === 'entity' && wd.cause.entityId === s.tree);
  // The giant's state where the trunk met it.
  const trunkHit = h.history.world.find((e) => e.type === 'impact' && e.defender === g && e.cause.entityId === s.tree && e.tick >= fellTick - 1);
  const tripT = trip as Extract<WorldEvent, { type: 'trip' }> | null;
  console.info(
    `AC-3 ${what}: states ${states.join(' → ')}\n` +
      `  trip tick ${tripTick} why ${tripT?.why} cause ${JSON.stringify(tripT?.cause ?? null)}\n` +
      `  pit springs (first cover break, entity ${coverBreak ? (coverBreak as { entity: number }).entity : '?'}): ${pitSpring ? fmt(pitSpring) : 'never'}\n` +
      `  pull starts: ${fmt(pullStart)}\n` +
      `  the tree falls ${(fellTick - pullStart.tick) / 60} s after the pull starts: ${fellSpring ? fmt(fellSpring) : 'never'}\n` +
      `  trunk on the giant: ${trunkHit && trunkHit.type === 'impact' ? `tick ${trunkHit.tick} (${((trunkHit.tick - tripTick) / 60).toFixed(2)} s after the trip) ${trunkHit.rulerZone ?? trunkHit.zone} ${trunkHit.energy.toFixed(0)} J ${trunkHit.damage.toFixed(0)} HP; giant ${g.state}, inPit ${g.ruler?.inPit}, down ${rulerDown(g)}` : 'no impact'}\n` +
      `  wounds: ${ws.map((wd) => `${wd.zone} ${wd.hp.toFixed(0)} HP${wd.severe ? ` severe ${wd.effect}` : ''} by ${wd.cause.kind} ${wd.cause.entityId} [${wd.cause.credit.join(',')}]`).join('; ')}\n` +
      `  stake wounds ${stakeWounds.length} (${stakeWounds.reduce((a, wd) => a + wd.hp, 0).toFixed(0)} HP), trunk wounds ${trunkWounds.length} (${trunkWounds.reduce((a, wd) => a + wd.hp, 0).toFixed(0)} HP); giant alive ${g.alive}, HP ${g.ruler ? rulerHp(g.ruler).toFixed(0) : '?'}\n` +
      `  fixtures after the giant: ${h.fixtures.filter((f) => f.op === 'spawn' || f.op === 'stage' || f.op === 'unstage').map((f) => `${f.op} ${f.what}`).join(', ') || 'none'}`,
  );
  if (!pitSpring || !coverBreak || !trip || !fellSpring || !fell) throw new Error(`${what}: a spring is missing`);
  return { trip, tripTick, pitSpring, coverBreak, pullStart, fellSpring, fell, aliveAfterPit, stakeWounds, trunkWounds, states };
}

/** The criterion's gates on one hunt. */
function gate(r: HuntResult, s: Scene): void {
  // GATE: the pit springs (a cover entity breaks) before the pull, the tree falls after it.
  expect(r.pitSpring.tick).toBeLessThanOrEqual(r.tripTick);
  expect(r.fellSpring.tick).toBeGreaterThanOrEqual(r.pullStart.tick);
  // GATE: the player is never within 10 m of either trap, or of the giant, when it springs; the tie ≥ 15 m away.
  for (const d of [r.pitSpring, r.fellSpring]) {
    expect(d.cover).toBeGreaterThanOrEqual(MIN_SPRING_DIST_M);
    expect(d.pit).toBeGreaterThanOrEqual(MIN_SPRING_DIST_M);
    expect(d.giant).toBeGreaterThanOrEqual(MIN_SPRING_DIST_M);
    expect(d.trunk).toBeGreaterThanOrEqual(MIN_SPRING_DIST_M);
  }
  expect(r.pullStart.tie).toBeGreaterThanOrEqual(MIN_PULL_DIST_M);
  expect(r.fellSpring.tie).toBeGreaterThanOrEqual(MIN_PULL_DIST_M);
  // GATE: the giant is alive after the pit (the second trap has something to fall on).
  expect(r.aliveAfterPit).toBe(true);
  // GATE: both traps wound, credited to the player.
  expect(r.stakeWounds.length).toBeGreaterThan(0);
  expect(r.trunkWounds.length).toBeGreaterThan(0);
  for (const wd of [...r.stakeWounds, ...r.trunkWounds]) {
    expect(wd.hp).toBeGreaterThan(WOUND_MIN_HP);
    expect(wd.cause.credit).toContain('p1');
  }
  void s;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('AC-3: the solo hunt (SPEC:900, §11.3)', () => {
  let scene: Uint8Array;
  let h: Harness | null = null;

  beforeAll(async () => {
    scene = await cachedScene('pit');
  }, SCENE_BUILD_TIMEOUT_MS);

  afterEach(async () => {
    h?.w.dispose();
    h = null;
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each([-1.5, 0, 1.5])('brain on: lured along its patrol route into the pit (z0 %s), then the felled tree pulled onto it from P', async (z0) => {
    h = await loadHarness(scene, { nav: 'full' });
    const s = rigTheTree(h);
    const g = h.creature('giantApe', { x: START_X, z: z0 }, Math.PI / 2);
    h.patrol(g, [
      { x: START_X, z: z0 },
      { x: ROUTE_END_X, z: z0 },
    ]);
    const r = hunt(h, s, g, `brain on, z0 ${z0}`);
    gate(r, s);
  });

  it('brain off: the same physics with a scripted 7 m/s charge from (−30, 0) at P (tells a mind failure from a physics one)', async () => {
    h = await loadHarness(scene, { nav: 'full' });
    const s = rigTheTree(h);
    const from = { x: -30, z: 0 };
    const heading = Math.atan2(P.x - from.x, P.z - from.z);
    const g = h.creature('giantApe', from, heading, { brain: 'off' });
    h.script(g, { kind: 'charge', heading, speed: 7 });
    const r = hunt(h, s, g, 'brain off, scripted charge');
    gate(r, s);
  });
});
