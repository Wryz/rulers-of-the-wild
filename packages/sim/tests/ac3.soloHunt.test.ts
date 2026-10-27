// AC-3: the solo hunt (SPEC:900; docs/M1-DESIGN.md §11.3; package P29).
//
// "Solo hunting works: a scripted player lures the giant ape along a path into a weight-triggered spike pit, then pulls a
// rope from at least 15 m away to drop a log on it. The player is never within 10 m when either trap springs."
//
// The scene (entities and verbs only, rule 1):
// - the cached pit (tests/support/scenes.ts buildPit through cachedScene('pit')): 8 × 6 × 2.5 m at (0, 0), 108 stakes
//   on 0.6 m, the verb-built cover of rotten bearers and grass;
// - step 1: a 30 cm × 15 m tree with a hanging vine anchored 10 m up, 20.2 m long (the generator's longest, §6.7), at
//   (1.5, 8.5) on the pit's +z side (DEVIATION below);
// - step 2: the player chops it from its +z side with the stone axe to remaining ≤ 0.14, so it would fall along −z
//   across the pit; it stands on its hinge (no pull);
// - step 3: the player takes the vine's end, splices an 8 m vine coil from his belt to it (27.7 m, §5.8), walks to
//   P = (18, 1) and reels in until 0.3 m of slack is left;
// - step 4: the giant (brain on) starts at (−40, z0) in `patrol` on a two-waypoint route (−40, z0) → (30, z0) through
//   the pit ("along a path", RT-9); the player paces ±1 m at P across the line to the tie, so it sees him moving and
//   chases, telegraphs and charges at him (the lure is being seen, SPEC:468);
// - step 5: the player starts pulling on the first tick the giant is `tripped` ("then pulls a rope").
// The tests script the player (commands) and the creature (its route; in the second `it` its charge), never a trap.
//
// DEVIATION (§11.3 step 1 "(0, −9)", recipe; P29 lab, docs/work/ledger.md "P29"): the tree stands at (1.5, 8.5) and
// falls along −z. Why the trunk missed or barely hurt at (0, −9) and nearby:
// - the cached pit's dirt piles (12 of ≈ 118 kg, dragged out of the long sides, §11.0 pileSides 'z') lie round
//   (0, −9) at z −9.7 … −5.9: the chop stand is 0.75 m from one; it rolled onto the player (74 + 233 HP), he dropped
//   the axe and chopTo failed (noEdge). The +z side is clear of piles for x 1 … 6.
// - SIM-fix4's berm (1 m, flanks ≤ 34°) rings the pit at |z| ≈ 6-8: a tree standing outside it with its hinge low
//   ((2.5, 10): ground +0.15 m) meets the berm's crest 1.85 m out at 15° above horizontal, and the trunk arrived at
//   the giant with 3.7 of its 8.6 m/s (7.5 kJ, 197 HP: no wound). At z 8.5 the tree stands on the berm's outer flank
//   (ground ≈ +0.6 m), so the trunk clears the crest and comes down nearly flat across the pit, resting on both berms
//   at ≈ 1.1 m above the original ground.
// - so the trunk reaches only what of the fallen giant stands above ≈ 1.1 m: it falls head first into the pit with
//   its pelvis and legs up on the −x end (pelvis centre at x 0.6 … 1.5, 0.7 … 1.2 m up, 3 s after the trip; chest and
//   head below the ground). At x 2.5 the trunk met its sinking back at 7-12 kJ (191-428 HP) or missed it; at x 1.0 it
//   missed one run; at x 1.5 it hits the back or shoulders in all four runs (see the ledger for the sweep).
// - The fall takes ≈ 3.5 s from the trip (the pull 0.23-0.33 s, then the 15 m trunk from tipAngVel), before the
//   giant's get-up at +4.0 s.
// DEVIATION (§11.3 step 1 is silent on the vine's side): the vine hangs on the side facing P (yaw toward P), so its
// slack lies out on the ground toward P, beside the pit, and the player takes its end without stepping on the cover.
// DEVIATION (§11.3 step 3 "the starter cache's 8 m coil"): scene 'empty' has no starter cache; the 8 m vine coil is
// factory-spawned next to the player (a spawn of what the Clearing generates), taken and stowed on the belt by verbs.
//
// Gates and pins (§11): every assertion below is a GATE (the criterion's meaning). No PIN is frozen: the lab-first
// numbers (stake and trunk wound HP, distances, the trunk's arrival after the trip) are printed by the `console.info`
// lines `AC-3 …` and recorded in docs/work/ledger.md ("P29").
//
// Vitest: the long loops yield to the worker's event loop (yieldToVitest) so its RPC is answered (a synchronous
// stretch over 60 s fails a full run with "Timeout calling onTaskUpdate").
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { rulerDown, rulerHp } from '../src/sim/ruler';
import type { RulerMind } from '../src/world/creatures/rulerMind';
import type { Owner, WorldEvent, WoundRecord } from '../src/world/types';
import { cachedScene, type Harness, loadHarness, SCENE_BUILD_TIMEOUT_MS, type XZ } from './support/worldHarness';
import { YIELD_TICKS, yieldToVitest } from './support/yieldToVitest';

/** Rapier, a navmesh and minutes of ticks per run (§11: 120 s and up for anything with Rapier). */
vi.setConfig({ testTimeout: 900_000 });

// ---------------------------------------------------------------------------
// The recipe (§11.3; recipe constants, never tuning)
// ---------------------------------------------------------------------------

const PIT = { centre: { x: 0, z: 0 }, lengthX: 8, widthZ: 6 } as const;
/**
 * The tree (§11.3 step 1's 30 cm × 15 m, its vine 10 m up, 20.2 m long), on the +z side, falling along −z (fallZ)
 * across the pit; `walkTo`: the player's way there from the scene's start, round the pit's +x end. DEVIATION (§11.3
 * step 1 "(0, −9)", recipe, not a gate): see the file's header.
 */
const TREE = {
  at: { x: 1.5, z: 8.5 },
  fallZ: -1,
  walkTo: [
    { x: 11, z: -10 },
    { x: 12.5, z: 0 },
    { x: 11, z: 11 },
    { x: -0.5, z: 11.5 },
  ],
  diameter: 0.3,
  height: 15,
  remaining: 0.14,
  vine: { anchorH: 10, lengthM: 20.2 },
} as const;
/** The 8 m coil spliced to the vine (§5.8: 20.2 + 8 − 0.5 = 27.7 m), behind the tree. */
const COIL = { lengthM: 8, at: { x: -1.5, z: 12.5 } } as const;
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

async function rigTheTree(h: Harness): Promise<Scene> {
  const { cover, stakes } = pitParts(h);
  const toP = Math.atan2(P.x - TREE.at.x, P.z - TREE.at.z);
  // From the scene's start on the −z rim (0, −10), round the pit's +x end to the tree's side, beyond the berm.
  for (const q of TREE.walkTo) h.walk(q);
  await yieldToVitest();
  // Step 1.
  const t = h.tree({ at: TREE.at, diameter: TREE.diameter, height: TREE.height, vine: { anchorH: TREE.vine.anchorH, lengthM: TREE.vine.lengthM, yaw: toP } });
  if (!t.vine) throw new Error('AC-3: the tree has no vine');
  const coil = h.coil({ material: 'vine', lengthM: COIL.lengthM, at: { x: COIL.at.x, y: h.w.terrain.heightAt(COIL.at.x, COIL.at.z), z: COIL.at.z } });
  h.ticks(2);
  h.approach(coil);
  h.must({ verb: 'take', target: coil }, 'take the 8 m coil');
  h.must({ verb: 'stow', target: 0, slot: 0 }, 'the coil to the belt');
  await yieldToVitest();
  // Step 2: chopped from its far side from the pit (it falls away from the cut, along −z, across the pit).
  h.give('stoneAxe');
  h.walk({ x: TREE.at.x, z: TREE.at.z + TREE.fallZ * -(TREE.diameter / 2 + 1.3) });
  const chop = h.chopTo(t.tree, TREE.remaining);
  h.ticks(120);
  await yieldToVitest();
  const plant = h.ent(t.tree).plant!;
  console.info(`AC-3 chop: ${chop.chops} chops (${chop.swings} swings), remaining ${plant.cut?.remaining.toFixed(3)}, fromDir (${plant.cut?.fromDir.x.toFixed(3)}, ${plant.cut?.fromDir.z.toFixed(3)}), ${plant.phase} 2 s on`);
  // Step 3: the vine end, the splice, the walk to P, the reel-in.
  // (The back holds the digging stick the pit was dug with: the axe is put down.)
  h.must({ verb: 'drop', target: 0 }, 'put the axe down');
  h.approach(t.vine.rope);
  h.must({ verb: 'take', target: t.vine.rope }, 'take the vine end');
  h.must({ verb: 'tie', target: h.p.inventory!.belt[0]! }, 'splice the coil to the vine');
  const spliced = h.w.joints.get(t.vine.joint)!.rope!.lengthM;
  await yieldToVitest();
  h.walk(P);
  await yieldToVitest();
  const slack = h.reelIn(t.vine.joint, SLACK_M);
  const rope = h.w.joints.get(t.vine.joint)!.rope!;
  console.info(`AC-3 rope: ${spliced.toFixed(2)} m spliced, ${rope.lengthM.toFixed(2)} m out after the reel-in, ${slack.toFixed(3)} m slack left at (${h.p.pos.x.toFixed(2)}, ${h.p.pos.z.toFixed(2)}), the tree ${h.ent(t.tree).plant!.phase}, tick ${h.w.tick}`);
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
async function hunt(h: Harness, s: Scene, g: Fighter, what: string): Promise<HuntResult> {
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
    if (t % YIELD_TICKS === YIELD_TICKS - 1) await yieldToVitest();
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
    if (t % YIELD_TICKS === YIELD_TICKS - 1) await yieldToVitest();
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
  for (let t = 0; t < AFTER_FELL_TICKS; t++) {
    if (t % YIELD_TICKS === YIELD_TICKS - 1) await yieldToVitest();
    const r = h.step();
    watch(r);
    note();
  }
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
    const s = await rigTheTree(h);
    const g = h.creature('giantApe', { x: START_X, z: z0 }, Math.PI / 2);
    h.patrol(g, [
      { x: START_X, z: z0 },
      { x: ROUTE_END_X, z: z0 },
    ]);
    const r = await hunt(h, s, g, `brain on, z0 ${z0}`);
    gate(r, s);
  });

  it('brain off: the same physics with a scripted 7 m/s charge from (−30, 0) at P (tells a mind failure from a physics one)', async () => {
    h = await loadHarness(scene, { nav: 'full' });
    const s = await rigTheTree(h);
    const from = { x: -30, z: 0 };
    const heading = Math.atan2(P.x - from.x, P.z - from.z);
    const g = h.creature('giantApe', from, heading, { brain: 'off' });
    h.script(g, { kind: 'charge', heading, speed: 7 });
    const r = await hunt(h, s, g, 'brain off, scripted charge');
    gate(r, s);
  });
});
