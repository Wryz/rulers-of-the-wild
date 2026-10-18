// AC-6: push, pass-through, deflection (SPEC:903; docs/M1-DESIGN.md §11.6, package P27).
//
// "A walking player can't shove an 800 kg boulder but can slide a 40 kg log; a log falling onto the player doesn't
// stop dead as if it hit a wall; a charging ruler is deflected by a staked log wall."
//
// Rule 1: the scenes are factory entities (the factory world generation uses, §6.7) and, for the wall, P23's
// buildStakedWall (entities and verbs). Only the player (move commands) and the giant (a `charge` script) are scripted.
// Terrain: the empty scene's dirt (friction 0.7) [C lab: e6_kcc].
//
// 1. The player walks 3 s (move commands) into an 800 kg stone hull and, in a fresh world, into a 40 kg dry hex log
//    (2.2 m), at walk (half input) and run (full input: DS's run, 3.77 m/s). The boulder comes from the factory's
//    spawnStone: the harness has no stone call (DEVIATION from §11.0's "uses only the harness": the stone is the same
//    factory entity generation scatters; §11.6's "icosahedral hull r 0.47 m" is the design's lab shape, the factory's
//    is prototype 0 scaled to 800 kg, its radius logged).
// 2. A 300 kg hex log dropped with its centre 4 m up onto the standing player (the masses test constants: the player's
//    SPECIES_BODY.human 73.3 kg, the log 300 kg; P09's log, 3 m long, as contacts.test). The measured tick (RT-16): N =
//    the tick whose phase 9 scores the first episode between the log and the player's zones; before = the log's phase-5
//    stored velocity at N; after = its phase-8 snapshot at N + 1. Control in the same `it`: with the capsule and the log
//    solving against each other (the solver groups including each other), the log stops dead on the player.
// 3. buildStakedWall: a 16 m wall of two stacked anchored (lashed) hex logs, 1.0 m high; the giant charges at 6 m/s from
//    15 m before the wall. At 20°: it slides along the wall and leaves past its end. At 45°: it trips 'obstacle'.
//
// GATE / PIN marks as §11 asks. Every world is disposed (RF-24).
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { BODY_RADIUS } from '../src/sim/combat';
import { moveCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { freeDv, IMPACT_TUNING } from '../src/sim/impact';
import { DT } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { spawnStone } from '../src/world/factory';
import { G, GROUP } from '../src/world/groups';
import { RULER_BODY_TUNING } from '../src/world/rulerBody';
import type { V3, WorldEvent } from '../src/world/types';
import { buildStakedWall } from './support/scenes';
import { type Harness, makeHarness } from './support/worldHarness';

const live: Harness[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});
/** A macrotask turn, so long synchronous stepping never starves Vitest's worker RPC (ledger: onTaskUpdate timeouts). */
const yieldToVitest = (): Promise<void> => new Promise((r) => setImmediate(r));
async function make(seed: number, size: number): Promise<Harness> {
  await yieldToVitest();
  const h = await makeHarness({ seed, size });
  live.push(h);
  return h;
}

const DEG = Math.PI / 180;
const speedOf = (v: V3 | null | undefined): number => (v ? Math.hypot(v.x, v.y, v.z) : 0);
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** §11.6's recipe constants (test constants, never tuning). */
const AC6 = {
  pushS: 3,
  /** Move input: walk (half) and run (full, DS's 3.77 m/s). */
  gaits: { walk: 0.5, run: 1 } as const,
  boulderKg: 800,
  lightLog: { massKg: 40, lengthM: 2.2 },
  /** The player starts this far from the obstacle's near surface. */
  startGapM: 0.5,
  dropLog: { massKg: 300, lengthM: 3, centreY: 4 },
  playerKg: 73.3,
  wall: { start: { x: -8, z: 0 }, dir: { x: 1, z: 0 }, lengthM: 16 as const, height: 1.0 as const },
  charge: { mps: 6, fromM: 15, meetX: -4 },
} as const;

// ---------------------------------------------------------------------------
// Part 1: the player's push
// ---------------------------------------------------------------------------

interface PushRun {
  moved: number;
  collided: number;
  pushedOnCollided: number;
  ticks: number;
}

/**
 * The player stands `startGapM` west of the entity's near side, facing it, and is given move commands east at `mag`
 * of full input for 3 s. Counts the ticks the KCC's sweep reported a computed collision with it and, of those, the
 * ticks it queued a push on it.
 */
function pushFor(h: Harness, id: number, halfWidthX: number, mag: number): PushRun {
  const e0 = { ...h.ent(id).pose.p };
  h.standAt({ x: e0.x - halfWidthX - BODY_RADIUS - AC6.startGapM, z: e0.z }, Math.PI / 2);
  h.ticks(30);
  const p = h.p;
  const n = Math.round(AC6.pushS / DT);
  let collided = 0;
  let pushedOnCollided = 0;
  for (let t = 0; t < n; t++) {
    h.w.commands.push(moveCommand(h.w.tick + 1, 1, mag, 0));
    h.step();
    if (h.w.kcc.collidedEntities(p).includes(id)) {
      collided++;
      if (h.w.kcc.pushedEntities(p).includes(id)) pushedOnCollided++;
    }
  }
  h.w.commands.push(moveCommand(h.w.tick + 1, 1, 0, 0));
  h.ticks(60);
  const e1 = h.w.entities.get(id)!.pose.p;
  return { moved: flat(e1, e0), collided, pushedOnCollided, ticks: n };
}

describe('AC-6 part 1: the player push (§11.6.1, §4.2)', () => {
  it.each(Object.entries(AC6.gaits))("can't shove an 800 kg boulder (%s): it moves < 0.01 m though the KCC meets it and pushes on ≥ 120 of 180 ticks", async (gait, mag) => {
    const h = await make(61, 30);
    const id = spawnStone(h.w, { p: { x: 0, y: 1, z: 0 }, mass: AC6.boulderKg });
    h.ticks(120);
    const e = h.ent(id);
    expect(e.mass).toBeCloseTo(AC6.boulderKg, 3);
    expect(e.body!.isDynamic()).toBe(true);
    expect(speedOf(e.vel.lin)).toBeLessThan(0.01);
    const pts = (e.shape as Extract<typeof e.shape, { kind: 'hull' }>).points;
    let rMax = 0;
    let xMax = 0;
    for (let i = 0; i < pts.length; i += 3) {
      rMax = Math.max(rMax, Math.hypot(pts[i], pts[i + 1], pts[i + 2]));
      xMax = Math.max(xMax, Math.abs(pts[i]));
    }
    const r = pushFor(h, id, xMax, mag);
    console.info(`[AC-6.1 boulder ${gait}] hull radius ${rMax.toFixed(3)} m; moved ${r.moved.toFixed(4)} m; KCC collided on ${r.collided}/${r.ticks} ticks, pushed on ${r.pushedOnCollided} of them`);
    // GATE: it doesn't move.
    expect(r.moved).toBeLessThan(0.01);
    // GATE: not "never touched": the KCC met it on ≥ 120 of the 180 ticks and queued a push on each of them (RT-15).
    expect(r.collided).toBeGreaterThanOrEqual(120);
    expect(r.pushedOnCollided).toBe(r.collided);
    // PIN [C lab: e6_kcc]: 0.000 m.
    expect(r.moved).toBeCloseTo(0, 3);
  }, 120_000);

  it.each(Object.entries(AC6.gaits))('slides a 40 kg dry hex log (%s): it moves > 1 m', async (gait, mag) => {
    const h = await make(62, 30);
    // The log lies along z, across the push (east): its side faces the player. (spawnLog: the mass sets r.)
    const q = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    const id = h.log({ mass: AC6.lightLog.massKg, length: AC6.lightLog.lengthM, r: 0.1, q, p: { x: 0, y: 0.3, z: 0 } });
    h.ticks(120);
    const e = h.ent(id);
    expect(e.mass).toBeCloseTo(AC6.lightLog.massKg, 3);
    expect(e.material).toBe('dryWood');
    const rLog = (e.shape as Extract<typeof e.shape, { kind: 'cylinder' }>).r;
    const r = pushFor(h, id, rLog, mag);
    console.info(`[AC-6.1 log ${gait}] r ${rLog.toFixed(3)} m; moved ${r.moved.toFixed(3)} m; KCC collided on ${r.collided}/${r.ticks} ticks, pushed on ${r.pushedOnCollided}`);
    // GATE: it slides.
    expect(r.moved).toBeGreaterThan(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Part 2: a log falling onto the player
// ---------------------------------------------------------------------------

type ImpactEv = Extract<WorldEvent, { type: 'impact' }>;

/** Per tick, around phase 9: the log's phase-5 and phase-8 velocities and the impact scored on `f` by it (P09's watch). */
function watchLog(h: Harness, id: number, f: Fighter): { tick: number; pre: V3 | null; post: V3 | null; hit: ImpactEv | null }[] {
  const w = h.w;
  const rows: { tick: number; pre: V3 | null; post: V3 | null; hit: ImpactEv | null }[] = [];
  const key = `entity:${id}`;
  const orig = w.contacts.process.bind(w.contacts);
  w.contacts.process = (ww, pairs) => {
    const pre = w.physics.pre(key)?.v ?? null;
    const post = w.physics.post(key)?.v ?? null;
    const n = w.events.length;
    orig(ww, pairs);
    const hit = w.events.slice(n).find((e): e is ImpactEv => e.type === 'impact' && e.defender === f && e.cause.entityId === id) ?? null;
    rows.push({ tick: w.tick, pre: pre && { ...pre }, post: post && { ...post }, hit });
  };
  return rows;
}

/** The player's KCC capsule collider. */
function capsuleOf(h: Harness, f: Fighter): RAPIER.Collider {
  let out: RAPIER.Collider | null = null;
  h.w.physics.rapier.forEachCollider((c) => {
    const o = h.w.physics.ownerOf(c.handle);
    if (o?.kind === 'fighter' && o.id === f.id && o.part === 'kcc') out = c;
  });
  if (!out) throw new Error('no capsule');
  return out;
}

async function dropLog(control: boolean) {
  // P09's world (seed 3, 50 m), where the real-rig pins below were measured. The branch depends on the standing
  // player's idle pose at the impact, which the seed sets: on seed 63 the same drop meets the head at the same 6.38 m/s
  // and scores Δv 3.06 m/s down (2.2 HP, hitstun, 93.4 % kept). Reported (§11.8 R8: the margin).
  const h = await make(3, 50);
  const p = h.p;
  h.ticks(10);
  // The masses are test constants (§11.6): a tuning change can't move the margin silently.
  expect(p.mass).toBeCloseTo(AC6.playerKg, 1);
  expect(SPECIES_BODY.human.massKg).toBeCloseTo(AC6.playerKg, 1);
  const id = h.log({ mass: AC6.dropLog.massKg, length: AC6.dropLog.lengthM, r: 0.1, p: { x: p.pos.x, y: AC6.dropLog.centreY, z: p.pos.z } });
  expect(h.ent(id).mass).toBeCloseTo(AC6.dropLog.massKg, 3);
  if (control) {
    // The control (C lab F4): the capsule and the log solve against each other, as a body whose solver membership is
    // "all bits" would. A test write of two colliders' solver groups, never a scene.
    capsuleOf(h, p).setSolverGroups(G(GROUP.CHAR, GROUP.TERRAIN | GROUP.ENTITY));
    const lc = h.ent(id).body!.collider(0);
    lc.setSolverGroups(G(GROUP.ENTITY, 0xffff));
  }
  const rows = watchLog(h, id, p);
  for (let t = 0; t < 120 && !(rows.length > 1 && rows[rows.length - 2].hit); t++) h.step();
  const i = rows.findIndex((r) => r.hit);
  // It falls on: rest height (the lowest height it is still at < 0.1 m/s from then on).
  let restY = -Infinity;
  let restV = Infinity;
  let highestRest = -Infinity;
  for (let t = 0; t < 300; t++) {
    h.step();
    const e = h.ent(id);
    const v = speedOf(e.vel.lin);
    if (v < 0.1) highestRest = Math.max(highestRest, e.pose.p.y);
    restY = e.pose.p.y;
    restV = v;
  }
  return { h, p, id, rows, i, restY, restV, highestRest };
}

describe('AC-6 part 2: a log falling onto the player (§11.6.2)', () => {
  it("300 kg from 4 m doesn't stop dead on the player: ≥ 80 % of its speed kept over the measured tick, rests on the terrain, hurts; control: solving against the capsule, it stops dead", async () => {
    const r = await dropLog(false);
    expect(r.i, 'no impact on the player').toBeGreaterThanOrEqual(0);
    const hit = r.rows[r.i].hit!;
    const before = speedOf(r.rows[r.i].pre);
    const after = speedOf(r.rows[r.i + 1].post);
    const dvFree = freeDv(hit.dv);
    console.info(
      `[AC-6.2] N = tick ${r.rows[r.i].tick}: before ${before.toFixed(3)} m/s, after ${after.toFixed(3)} m/s (${((100 * after) / before).toFixed(1)} %); ` +
        `impact ${hit.damage.toFixed(2)} HP on ${hit.bone ?? '?'}, dv (${hit.dv.x.toFixed(2)}, ${hit.dv.y.toFixed(2)}, ${hit.dv.z.toFixed(2)}) |dv| ${speedOf(hit.dv).toFixed(2)}, dv_free ${dvFree.toFixed(2)}; ` +
        `knockdown ${hit.knockdown}, launched ${hit.launched}; player ${r.p.state}; log rests at y ${r.restY.toFixed(3)} (${r.restV.toFixed(3)} m/s), highest rest ${r.highestRest.toFixed(3)}`,
    );
    // GATE (D-23, binding): after ≥ 80 % of before; still falling.
    expect(r.rows[r.i + 1].post!.y).toBeLessThan(0);
    expect(after).toBeGreaterThanOrEqual(0.8 * before);
    // GATE: it comes to rest on the terrain, not on the capsule (never at rest above 0.5 m on the way).
    expect(r.restV).toBeLessThan(0.1);
    expect(r.restY).toBeLessThan(0.5);
    expect(r.highestRest).toBeLessThan(0.5);
    // GATE: an impact on the player with damage > 0, by the log.
    expect(hit.damage).toBeGreaterThan(0);
    expect(hit.cause).toMatchObject({ kind: 'entity', entityId: r.id, held: false });
    // GATE: the branch matches §4.4 for its dv: launched === (dv_free ≥ launchDv); and by name (RF-27). At 4 m with the
    // real rig (its head ball tops out at 1.72 m, the lab's zone at 1.81 m) the log arrives faster than the lab's
    // 6.21 m/s and Δv is 5.09 m/s straight down (ledger §4.3, P09's contacts.test): ≥ launchDv down is the press, a
    // knockdown, not a launch (all of it into the ground: dv_free 0).
    expect(hit.launched).toBe(dvFree >= IMPACT_TUNING.launchDv);
    expect(hit.launched).toBe(false);
    expect(hit.dv.y).toBeLessThanOrEqual(-IMPACT_TUNING.launchDv);
    expect(hit.knockdown).toBe(true);
    // PINS (re-measured on the real rig by P09, contacts.test 'AC-6 part 2 from 4 m in the press branch'; §11.6's lab
    // rig pins were 6.21 / 5.32 m/s, 85.7 %, Δv 4.99 [C lab: F14; RT lab: numbers.out]): 6.38 m/s, Δv 5.09 down, 85.6 %.
    expect(before).toBeCloseTo(6.38, 1);
    expect(hit.dv.y).toBeCloseTo(-5.09, 1);
    expect(after / before).toBeCloseTo(0.856, 2);

    // Control: solving against the capsule, the log stops dead on the player (C lab F4: 0.00 m/s, resting at y 1.98).
    const c = await dropLog(true);
    const cBefore = c.i >= 0 ? speedOf(c.rows[c.i].pre) : NaN;
    const cAfter = c.i >= 0 && c.rows[c.i + 1] ? speedOf(c.rows[c.i + 1].post) : NaN;
    console.info(`[AC-6.2 control] impact row ${c.i}; before ${cBefore.toFixed(3)}, after ${cAfter.toFixed(3)} m/s; rests at y ${c.restY.toFixed(3)} (${c.restV.toFixed(3)} m/s), highest rest ${c.highestRest.toFixed(3)}`);
    // The control shows the gate is not vacuous: the log stops dead and rests on the player, well above the terrain
    // (lab: y 1.98).
    expect(c.restV).toBeLessThan(0.1);
    expect(c.restY).toBeGreaterThan(1.5);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Part 3: the staked wall deflects a charging ruler
// ---------------------------------------------------------------------------

interface WallRun {
  trip: Extract<WorldEvent, { type: 'trip' }> | null;
  deflects: number;
  closest: number;
  minSpeedAlong: number;
  slideSpeed: number;
  adopted: number;
  slideHeadingDeg: number;
  endX: number;
  minAnchored: boolean;
  snapped: number;
  stopped: boolean;
}

async function chargeWall(deg: number): Promise<{ h: Harness; g: Fighter; r: WallRun; capR: number; wallEnd: number }> {
  const h = await make(64, 80);
  const W = AC6.wall;
  const ids = buildStakedWall(h, { start: W.start, dir: W.dir, lengthM: W.lengthM, height: W.height });
  const [lower, upper] = ids;
  h.ticks(60);
  for (const id of [lower, upper]) expect(h.w.entities.isAnchored(h.ent(id))).toBe(true);
  const lashes = h.w.joints.all().filter((j) => j.kind === 'lash').map((j) => j.id);
  expect(lashes).toHaveLength(4);
  // The player out of the way, paused.
  h.standAt({ x: 0, z: 30 });
  h.pause(h.p);
  h.ticks(30);
  await yieldToVitest();
  // The wall's face toward the giant (−z side): the logs' horizontal extent (a flat-down hex: its circumradius).
  const wallR = (h.ent(lower).shape as Extract<ReturnType<Harness['ent']>['shape'], { kind: 'cylinder' }>).r;
  const capR = BODY_RADIUS * SPECIES_BODY.giantApe.scale;
  const a = deg * DEG;
  const d = { x: Math.cos(a), z: Math.sin(a) };
  // It meets the face at meetX, from 15 m before the wall (along its heading).
  const meet = { x: AC6.charge.meetX, z: -wallR - capR };
  const from = { x: meet.x - AC6.charge.fromM * d.x, z: meet.z - AC6.charge.fromM * d.z };
  const yaw = Math.atan2(d.x, d.z);
  const g = h.creature('giantApe', from, yaw, { brain: 'off' });
  h.ticks(2);
  h.script(g, { kind: 'charge', heading: yaw, speed: AC6.charge.mps });
  const wallEnd = W.start.x + W.lengthM;
  const owners = [lower, upper].map((id) => ({ kind: 'entity' as const, id }));
  const r: WallRun = { trip: null, deflects: 0, closest: Infinity, minSpeedAlong: Infinity, slideSpeed: 0, adopted: 0, slideHeadingDeg: NaN, endX: 0, minAnchored: true, snapped: 0, stopped: false };
  let firstDeflect = -1;
  for (let t = 0; t < Math.round(12 / DT); t++) {
    if (t % 300 === 299) await yieldToVitest();
    const x0 = g.pos.x;
    const z0 = g.pos.z;
    const ev = h.step().world;
    for (const e of ev) {
      if (e.type === 'trip' && e.f === g && !r.trip) r.trip = e;
      if (e.type === 'deflect' && e.ruler === g) {
        r.deflects++;
        if (firstDeflect < 0) firstDeflect = h.w.tick;
      }
      if (e.type === 'joint' && e.what === 'snap' && lashes.includes(e.joint)) r.snapped++;
    }
    for (const id of [lower, upper]) if (!h.w.entities.get(id) || !h.w.entities.isAnchored(h.ent(id))) r.minAnchored = false;
    if (r.trip) break;
    if (g.pos.x > W.start.x && g.pos.x < wallEnd) r.closest = Math.min(r.closest, h.nearestDistH(g.pos, owners) - capR);
    const vx = (g.pos.x - x0) / DT;
    const vz = (g.pos.z - z0) / DT;
    if (firstDeflect > 0 && g.pos.x < wallEnd) {
      r.minSpeedAlong = Math.min(r.minSpeedAlong, Math.hypot(vx, vz));
      // The step the mover deflected: the rest of the step projected on the wall.
      if (h.w.tick === firstDeflect) {
        r.slideSpeed = Math.hypot(vx, vz);
        r.slideHeadingDeg = (Math.atan2(vz, vx) * 180) / Math.PI;
      }
      // Then the charge adopts the wall's heading (§6.4, adoptDeflection) and runs along it at its speed.
      if (h.w.tick === firstDeflect + 30) r.adopted = Math.hypot(vx, vz);
    }
    if (g.pos.x > wallEnd + capR + 1) break;
  }
  r.endX = g.pos.x;
  r.stopped = r.minSpeedAlong < 1;
  console.info(
    `[AC-6.3 ${deg}°] trip ${r.trip?.why ?? 'none'}; deflects ${r.deflects}; closest ${Number.isFinite(r.closest) ? r.closest.toFixed(3) : '-'} m (capsule face to the wall); ` +
      `slide ${r.slideSpeed.toFixed(2)} m/s at ${r.slideHeadingDeg.toFixed(2)}° (+0.5 s: ${r.adopted.toFixed(2)} m/s; min ${Number.isFinite(r.minSpeedAlong) ? r.minSpeedAlong.toFixed(2) : '-'}); ` +
      `end x ${r.endX.toFixed(2)} (wall end ${wallEnd}); lashings snapped ${r.snapped}; wall anchored throughout ${r.minAnchored}; giant ${g.state}`,
  );
  return { h, g, r, capR, wallEnd };
}

describe('AC-6 part 3: a charging ruler and a staked log wall (§11.6.3)', () => {
  it('met 20° off, the charge is deflected: it slides along the wall (no trip, no stop), never into it, and leaves past its end', async () => {
    const { r, capR, wallEnd } = await chargeWall(20);
    // GATE: no trip; deflected; no stop.
    expect(r.trip).toBeNull();
    expect(r.deflects).toBeGreaterThan(0);
    expect(r.stopped).toBe(false);
    // GATE: never closer than its radius + the face distance − 0.05 m (the capsule face never 5 cm into the wall).
    expect(r.closest).toBeGreaterThanOrEqual(-RULER_BODY_TUNING.sweepSkinM);
    // GATE: it leaves past the wall's end.
    expect(r.endX).toBeGreaterThan(wallEnd + capR);
    // The wall stood: a staked wall, still anchored.
    expect(r.minAnchored).toBe(true);
    // PINS [C lab]: 5.64 m/s along the wall (6 cos 20°) on the deflecting step, the heading within 0.2° of it.
    expect(r.slideSpeed).toBeCloseTo(AC6.charge.mps * Math.cos(20 * DEG), 1);
    expect(Math.abs(r.slideHeadingDeg)).toBeLessThan(0.2);
  }, 120_000);

  it("met 45° off (over deflectMaxDeg), it trips 'obstacle' on the wall (its 1.0 m top is inside the shin band)", async () => {
    const { r, g } = await chargeWall(45);
    // GATE: a trip, why 'obstacle' (no "or a stop").
    expect(r.trip).not.toBeNull();
    expect(r.trip!.why).toBe('obstacle');
    expect(g.state).toBe('tripped');
  }, 120_000);
});
