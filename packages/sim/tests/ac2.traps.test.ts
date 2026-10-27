// AC-2: four traps from entities and verbs (SPEC Milestone 1, SPEC:899; docs/M1-DESIGN.md §11.2; package P28).
//
// "Headless test scenes built only from entities and verbs show a deadfall, a spike pit, a swinging log and a felled
// tree each wounding or killing a creature. Tests may script a creature's route and actions (walking a path, pulling
// bait), never the trap."
//
// Rule 1: nothing here is a trap type. Every scene is the harness's factory entities and the scripted player's verbs
// (scenes.ts, P23, where the recipe is shared; the few steps written here use only `h.verb`/`h.must`, walks and the
// factory), plus the harness's logged fixtures where §11.0 allows them: `standAt`, `keepAwake`, and for the ruler-scale
// logs no M1 verb lifts (D-25) `stage`/`unstage` before any creature exists (the staging fence refuses them after).
// Creatures are scripted (`route`, `tug`, `hold`, `charge`, §6.6); nothing here moves, pins, frees or breaks anything
// that does the harm. Tuning is touched only by the negative controls (a weaker tug), and put back.
//
// "Wounding" (§11.2): for an ape, an `impact` event whose cause is an entity of the scene, not held, with damage > 0;
// for the giant, a WoundRecord (> 240 HP) with that cause. v_n is measured here (the event carries no v_n): the struck
// entity's velocity at the contact point, from the tick before the impact, along the impact normal (out of the
// target). Each assertion is marked GATE (the criterion's meaning; never moves) or PIN (a measured number with its
// source and tolerance), §11 RT-21. Every number printed with `console.info` is a measurement.
//
// Lab-first step (§11.2, RT-21), run with the real pipeline in this package (P28's lab runs, reported in the P28 report):
// the pins below that differ from §11.2's are the lab's numbers, each with its own note.

import { prismRForRoundDiam } from '../src/world/factory';
import { PHYSICS_TUNING } from '../src/world/physics';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toCm } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { getTuningValue, setTuningValue } from '../src/tuning/registry';
import { RULER_BODY_TUNING } from '../src/world/rulerBody';
import type { Quat, V3, WorldEvent } from '../src/world/types';
import { buildHauledLog, buildLeaningLog, buildNotchedTree, LEAN_P28, lyingAlong } from './support/scenes';
import { BACK_SLOT, cachedScene, type Harness, loadHarness, makeHarness, SCENE_BUILD_TIMEOUT_MS, type XZ } from './support/worldHarness';

/** §11: anything with Rapier gets 120 s. */
const RAPIER_IT_MS = 120_000;
/** The pit runs and the 120 s holds take longer than one ordinary `it`. */
const LONG_IT_MS = 600_000;

const live: Harness[] = [];
async function make(seed: number, size: number): Promise<Harness> {
  const h = await makeHarness({ seed, size });
  live.push(h);
  return h;
}
async function load(bytes: Uint8Array): Promise<Harness> {
  const h = await loadHarness(bytes);
  live.push(h);
  return h;
}
afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

// ---------------------------------------------------------------------------
// Small helpers (observation and geometry only)
// ---------------------------------------------------------------------------

type Impact = Extract<WorldEvent, { type: 'impact' }>;
const of = <T extends WorldEvent['type']>(evs: readonly WorldEvent[], type: T): Extract<WorldEvent, { type: T }>[] =>
  evs.filter((e): e is Extract<WorldEvent, { type: T }> => e.type === type);
const deg = (r: number): number => (r * 180) / Math.PI;
const flat = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);

function mulQ(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
function rotQ(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}
/** A turn of `a` rad about world z. */
const aboutZ = (a: number): Quat => ({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) });
/** An entity's long axis (local y) in the world. */
const axisOf = (h: Harness, id: number): V3 => rotQ(h.ent(id).pose.q, { x: 0, y: 1, z: 0 });
/** Tilt of a prism's long axis from vertical, degrees. */
const tiltDeg = (h: Harness, id: number): number => deg(Math.acos(Math.min(1, Math.abs(axisOf(h, id).y))));

/**
 * The velocity of every watched entity at the start of each tick (the previous tick's end), so an impact scored in a
 * tick can be given its approach speed v_n: (v + ω × (point − com))·(−normal), the normal pointing out of the target.
 */
function watchVelocities(h: Harness, ids: readonly number[]): (i: Impact) => number {
  const before = new Map<number, Map<number, { v: V3; w: V3; c: V3 }>>();
  const step = h.step.bind(h);
  h.step = () => {
    const tick = h.w.tick + 1;
    const m = new Map<number, { v: V3; w: V3; c: V3 }>();
    for (const id of ids) {
      const e = h.w.entities.get(id);
      if (!e) continue;
      const c = e.body?.isEnabled() ? e.body.worldCom() : e.pose.p;
      m.set(id, { v: { ...e.vel.lin }, w: { ...e.vel.ang }, c: { x: c.x, y: c.y, z: c.z } });
    }
    before.set(tick, m);
    before.delete(tick - 600);
    return step();
  };
  return (i: Impact): number => {
    const s = i.cause.entityId === null ? undefined : before.get(i.tick)?.get(i.cause.entityId);
    if (!s) return Number.NaN;
    const r = { x: i.point.x - s.c.x, y: i.point.y - s.c.y, z: i.point.z - s.c.z };
    const vp = { x: s.v.x + (s.w.y * r.z - s.w.z * r.y), y: s.v.y + (s.w.z * r.x - s.w.x * r.z), z: s.v.z + (s.w.x * r.y - s.w.y * r.x) };
    return -(vp.x * i.normal.x + vp.y * i.normal.y + vp.z * i.normal.z);
  };
}

/** The least distance between any collider of the fighter (its controller capsule included) and the entity's (m; < 0 overlapping). */
function clearance(h: Harness, f: Fighter, entity: number): number {
  const phys = h.w.physics;
  const ec = h.ent(entity).collider;
  if (!ec) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  phys.rapier.forEachCollider((c) => {
    const o = phys.ownerOf(c.handle);
    if (!o || o.kind !== 'fighter' || o.id !== f.id) return;
    if (c.isEnabled && !c.isEnabled()) return;
    const ct = c.contactCollider(ec, 5);
    if (ct && ct.distance < best) best = ct.distance;
  });
  return best;
}

/** Walk there, or (the way is shut: a berm, a pile, a pit wall) a logged standAt (as scenes.ts's goTo). */
function goTo(h: Harness, q: XZ, yaw?: number): void {
  if (!h.walk(q, { tolM: 0.15, tryOnly: true }) || flat(h.p.pos, q) > 0.3) h.standAt(q, yaw);
}

/** Walk up to the entity and take it (a logged standAt beside it when it is out of reach, as scenes.ts's take). */
function take(h: Harness, id: number, what: string): void {
  h.approach(id);
  const r = h.verb({ verb: 'take', target: id });
  if (r.ok) return;
  if (r.reason !== 'outOfReach' && r.reason !== 'outOfRange') throw new Error(`${what} refused (${r.reason})`);
  const e = h.ent(id).pose.p;
  const p = h.p.pos;
  const d = Math.max(1e-6, flat(p, e));
  h.standAt({ x: e.x + ((p.x - e.x) / d) * 0.8, z: e.z + ((p.z - e.z) / d) * 0.8 });
  h.ticks(2);
  h.must({ verb: 'take', target: id }, what);
}

/** Temporarily sets a live tuning value (a negative control), restoring it after `f`. */
function withTuning<T>(table: string, key: string, value: number, f: () => T): T {
  const was = getTuningValue(table, key);
  setTuningValue(table, key, value);
  try {
    return f();
  } finally {
    setTuningValue(table, key, was as number);
  }
}

/** The creature tug's force (VERB_TUNING.pullForceN × creaturePullMul × scale², §5.12) set to `n` newtons for `f`. */
function withTugN<T>(scale: number, n: number, f: () => T): T {
  const pullN = getTuningValue('VERB_TUNING', 'pullForceN') as number;
  return withTuning('VERB_TUNING', 'creaturePullMul', n / (pullN * scale * scale), f);
}

function noNaN(h: Harness, fighters: readonly Fighter[]): boolean {
  for (const f of fighters) if (![f.pos.x, f.pos.y, f.pos.z].every(Number.isFinite)) return false;
  for (const e of h.w.entities.all()) {
    const p = e.pose.p;
    const v = e.vel.lin;
    if (![p.x, p.y, p.z, v.x, v.y, v.z].every(Number.isFinite)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// (a) Deadfall: the ape at the bait
// ---------------------------------------------------------------------------

/**
 * The deadfall's ape run: an ape (brain off) walks a crouched route in under the log from the side to `stand`, waits,
 * then either tugs the bait for 120 ticks along `act.tugYaw` (§6.6 `tug`) or walks on, crouched, to `act.walkTo` (a
 * `route`). Measures the spring (the log's centre 5 cm below where it was set), the ape's clearance to the log until
 * then (every collider of it, its controller capsule included), and the log's impacts on it.
 */
function apeAtBait(h: Harness, o: { log: number; bait: number; stand: XZ; act: { tugYaw: number } | { walkTo: XZ }; vnOf: (i: Impact) => number }) {
  const ape = h.creature('ape', { x: o.stand.x, z: o.stand.z - 3.5 }, 0, { brain: 'off' });
  h.ticks(10);
  // The ape's arrival radius (CREATURE_TUNING.ape.arriveM 0.6) ends the route that far short of its last point.
  h.script(ape, { kind: 'route', points: [{ x: o.stand.x, z: o.stand.z - 1.5 }, { x: o.stand.x, z: o.stand.z + 0.56 }], crouch: true });
  let fit = Number.POSITIVE_INFINITY;
  h.until(() => {
    fit = Math.min(fit, clearance(h, ape, o.log));
    return h.mind(ape).scriptDone;
  }, 900, 'the ape under the log');
  h.ticks(20);
  fit = Math.min(fit, clearance(h, ape, o.log));
  const y0 = h.ent(o.log).pose.p.y;
  if ('tugYaw' in o.act) h.script(ape, { kind: 'tug', entity: o.bait, dirYaw: o.act.tugYaw, ticks: 120 });
  else h.script(ape, { kind: 'route', points: [o.act.walkTo], crouch: true });
  const actTick = h.w.tick;
  let spring = -1;
  h.ticks(360, (_, t) => {
    if (spring < 0 && h.ent(o.log).pose.p.y < y0 - 0.05) spring = t;
    if (spring < 0) fit = Math.min(fit, clearance(h, ape, o.log));
  });
  // The tug's grip tick (`mark`); a route has none: its start.
  const grip = 'tugYaw' in o.act ? h.mind(ape).mark : actTick;
  const hits = h.impacts(ape).filter((i) => i.cause.entityId === o.log);
  return { ape, fit, grip, actTick, spring, hits, vn: hits.map(o.vnOf) };
}

function report(tag: string, r: ReturnType<typeof apeAtBait>): void {
  console.info(
    `${tag}: clearance before the spring ${r.fit.toFixed(3)} m; grip at +${r.grip - r.actTick} ticks, spring ${r.spring < 0 ? 'none' : `${((r.spring - r.grip) / 60).toFixed(2)} s after it`}; ` +
      `log hits ${r.hits.map((i, k) => `${i.bone} v_n ${r.vn[k].toFixed(2)} m/s ${i.energy.toFixed(1)} J ${i.damage.toFixed(2)} HP${i.knockdown ? ' knockdown' : ''}`).join('; ') || 'none'}`,
  );
}

/** The 120 s hold (RT-4): the log and the prop kept awake for 7,200 ticks; the prop's largest tilt from vertical. */
function holdTilt(h: Harness, r: { prop: number; log: number }): number {
  h.keepAwake(r.log);
  h.keepAwake(r.prop);
  let tilt = 0;
  h.ticks(7200, (_, t) => {
    if (t % 30 === 0) tilt = Math.max(tilt, tiltDeg(h, r.prop));
  });
  return tilt;
}

/**
 * §11.2(a)'s staged deadfall geometry: a stick r 0.07 m `propLengthM` long placed upright at x = propX, a dry hex log
 * `logLengthM` long (circumradius 0.17 m) from the ground at x = 0 onto its top (25°).
 * DEPARTURE (P28, §11.2(a) staged steps 1-2 "2.38 m … x = 5.07 … 6.0 m"): the bait-tug runs use a 2.47 m stick at
 * x 5.3 and a 6.2 m log (25° still): the underside over the ape 0.8 m in from the bait stands 0.1 m higher, so the log,
 * once sprung, falls far enough to arrive at v_n ≥ 2 m/s (1.83-1.89 m/s on the design's). The walked run keeps the
 * design's (STAGED_AS_DESIGNED).
 */
const STAGED_DEADFALL = { propX: 5.3, propLengthM: 2.47, logLengthM: 6.2 };
const STAGED_AS_DESIGNED = { propX: 5.07, propLengthM: 2.38, logLengthM: 6 };

describe('AC-2(a): a deadfall wounds the ape that disturbs it', () => {
  /** §11.2(a): the log rises along +x (yaw π/2) from its lower end at the origin: "toward its own body" is −x. */
  const TOWARD_BODY = -Math.PI / 2;

  /*
   * §11.2(a)'s own recipes (the bait tug), with their gates as written; the scenes are raised a little (LEAN_P28,
   * STAGED_DEADFALL: departures recorded there and in docs/work/ledger.md).
   * P28's sim fixes behind them: the crouch shows its posture and low postures cross-fade (the body never rises through
   * standing height); the tugging ape backs off facing the bait, holding it where it gripped it, and its arms draw the
   * grip in at the hand speed (VERB_TUNING.tugHoldMinM), so the pull reaches 907.5 N in ≈ 0.2 s, not only once the ape has
   * walked 0.3 m back; a creature's tugged entity is never scored against it (the 1 kg bait, yanked against the ape's own
   * chest at 46 J, broke).
   * The staged 700 N control still springs the prop (0.48 s, P28 lab: from ≈ 500 N, 600 N in 0.18 s; the C lab's 762 N):
   * every code force here is a pre-step impulse (C F3), and Rapier resolves an impulse in the first of its substeps, where
   * the contacts can only give a substep's share of friction: a load below the static threshold creeps (a box pushed at
   * 0.3 μN creeps 6.7 mm in 3 s; pushed with an in-solver force it doesn't move, and this prop then holds 850 N, the
   * verb-only prop 200 N and gives at 266 N in 1.17 s, the C lab's numbers). Neither friction combining (Average →
   * Max) nor solver iterations (4 → 16, single-substep) change it. The fix (an in-solver force, reset every step) is
   * what C F3 and the sim purity test forbid: left failing, for the owner's decision (see the ledger).
   */
  it('verb-only gate (§11.2(a) as written): the 40 kg log leaned on a free prop holds 120 s awake, springs when the ape tugs the bait toward itself, and hits it', async () => {
    const h = await make(44, 40);
    const r = buildLeaningLog(h, { at: { x: 0, z: 0 }, yaw: Math.PI / 2, lean: LEAN_P28 });
    const vnOf = watchVelocities(h, [r.log]);
    h.walk({ x: -4, z: -6 });
    const tilt = holdTilt(h, r);
    console.info(`deadfall gate: prop tilt over 120 s awake ≤ ${tilt.toFixed(3)}°`);
    // GATE: the log stays set 120 s awake (keepAwake, RT-4): the prop's tilt < 1°.
    expect(tilt).toBeLessThan(1);
    const b = h.ent(r.bait).pose.p;
    // Step 4: the ape routed crouched to 0.45 m behind the bait; a tug toward its own body.
    const res = apeAtBait(h, { log: r.log, bait: r.bait, stand: { x: b.x - 0.45, z: b.z }, act: { tugYaw: TOWARD_BODY }, vnOf });
    report('deadfall gate', res);
    // GATE: springs within 1.0 s of the tug's grip.
    expect(res.spring).toBeGreaterThan(0);
    expect((res.spring - res.grip) / 60).toBeLessThanOrEqual(1.0);
    // GATE: an impact on the ape from the log, not held, v_n ≥ 1 m/s, damage > 0, credited to the player.
    const hit = res.hits.find((i, k) => !i.cause.held && i.damage > 0 && res.vn[k] >= 1);
    expect(hit, 'a log hit with v_n ≥ 1 m/s and damage > 0').toBeDefined();
    expect(hit!.cause.credit).toContain('p1');
    // GATE: no tripwire event (RT-5): the bait's rope is the ape's work target.
    expect(h.tripwires()).toEqual([]);
    // GATE: the ape fits (no collider of it, the controller capsule included, touches the log before the spring).
    expect(res.fit).toBeGreaterThan(0);
  }, LONG_IT_MS);

  it('verb-only negative control: a 200 N tug does not spring it', async () => {
    const h = await make(44, 40);
    const r = buildLeaningLog(h, { at: { x: 0, z: 0 }, yaw: Math.PI / 2, lean: LEAN_P28 });
    const vnOf = watchVelocities(h, [r.log]);
    h.walk({ x: -4, z: -6 });
    h.ticks(60);
    const b = h.ent(r.bait).pose.p;
    const res = withTugN(1.1, 200, () => apeAtBait(h, { log: r.log, bait: r.bait, stand: { x: b.x - 0.45, z: b.z }, act: { tugYaw: TOWARD_BODY }, vnOf }));
    report('deadfall gate, 200 N control', res);
    // GATE: no spring, no hit.
    expect(res.spring).toBe(-1);
    expect(res.hits.filter((i) => i.damage > 0)).toEqual([]);
  }, RAPIER_IT_MS);

  /*
   * The deadfall that works from the rules (P28 lab: 9 of 9 placements 0.2-0.6 m inward of the bait and ±0.1 m aside
   * scored a head hit of 0.7-2.8 HP, the spring 0.6-1.1 s after the ape set off): the ape walks its route crouched under
   * the log toward the prop and blunders into the bait and the prop's foot; the prop is knocked out and the log drops on
   * it. Only the creature's route is scripted (SPEC: "walking a path"); the arrangement is §11.2(a)'s, built by
   * buildLeaningLog. (Crossing the bait's lash is a tripwire crossing here, not a work target: logged, not gated.)
   */
  it('verb-only: the same deadfall springs on an ape that walks its route under the log into the prop, and hits it', async () => {
    const h = await make(44, 40);
    const r = buildLeaningLog(h, { at: { x: 0, z: 0 }, yaw: Math.PI / 2 });
    const vnOf = watchVelocities(h, [r.log]);
    h.walk({ x: -4, z: -6 });
    const tilt = holdTilt(h, r);
    expect(tilt).toBeLessThan(1);
    const b = h.ent(r.bait).pose.p;
    const res = apeAtBait(h, { log: r.log, bait: r.bait, stand: { x: b.x - 0.4, z: b.z }, act: { walkTo: { x: b.x + 1.2, z: b.z } }, vnOf });
    report('deadfall walked', res);
    console.info(`deadfall walked: tripwire events ${h.tripwires().length} (LOGGED)`);
    // GATE: the ape fits under the log until it springs; it springs; a hit from the log, not held, v_n ≥ 1 m/s,
    // damage > 0, credited to the player (who built it).
    expect(res.fit).toBeGreaterThan(0);
    expect(res.spring).toBeGreaterThan(0);
    const hit = res.hits.find((i, k) => !i.cause.held && i.damage > 0 && res.vn[k] >= 1);
    expect(hit, 'a log hit with v_n ≥ 1 m/s and damage > 0').toBeDefined();
    expect(hit!.cause.credit).toContain('p1');
    // PIN (P28 lab: 0.7-2.8 HP on the head, 12-50 J): 0.5-4 HP.
    expect(hit!.damage).toBeGreaterThan(0.5);
    expect(hit!.damage).toBeLessThan(4);
  }, LONG_IT_MS);

  /**
   * §11.2(a)'s staged scene: a dry stick r 0.07 × 2.38 m carried and placed upright, not driven, at x 5.07; a dry hex
   * log 6.0 m, circumradius 0.17 m spawned free at its pose (D-25), its lower end on the ground at x 0 and its
   * underside on the stick's top (25°); a 1 kg hide bait placed 0.55 m inward of the stick and lashed to it (a 0.65 m
   * vine). DEVIATION (§11.2(a) "≈ 170 kg"): the factory's dry wood makes that log 248 kg; the recipe's dimensions are
   * kept (they set the underside's height over the ape).
   */
  function buildStagedDeadfall(h: Harness, STAGED: typeof STAGED_DEADFALL = STAGED_DEADFALL): { prop: number; log: number; bait: number } {
    const PROP = { x: STAGED.propX, z: 0.013, lengthM: STAGED.propLengthM, r: 0.07 };
    const g = h.w.terrain.heightAt(PROP.x, PROP.z);
    const prop = h.stick({ length: PROP.lengthM, r: PROP.r, p: { x: 5, y: g + PROP.r + 0.03, z: 3 }, q: lyingAlong(Math.PI / 2) });
    h.ticks(20);
    take(h, prop, 'take the prop');
    goTo(h, { x: PROP.x, z: -1.2 });
    h.must({ verb: 'place', target: 0, at: toCm({ x: PROP.x, y: g + PROP.lengthM / 2, z: PROP.z }), yaw: 0, pitch: 64, drive: 0 }, 'place the prop upright');
    h.ticks(60);
    const sp = h.ent(prop).pose.p;
    const top = sp.y + PROP.lengthM / 2 - g;
    // The log: its underside on the line from (0, ground) to the prop's top; a flat face down.
    const th = Math.atan2(top, sp.x);
    const ri = 0.17 * Math.cos(Math.PI / 6);
    const c = { x: -ri * Math.sin(th) + (STAGED.logLengthM / 2) * Math.cos(th), y: g + ri * Math.cos(th) + (STAGED.logLengthM / 2) * Math.sin(th) + 0.01 };
    goTo(h, { x: 3, z: -4 });
    const log = h.log({ length: STAGED.logLengthM, r: 0.17, p: { x: c.x, y: c.y, z: 0 }, q: mulQ(aboutZ(th), lyingAlong(Math.PI / 2)) });
    h.ticks(120);
    // The bait, placed lying 0.55 m inward of the prop, lashed to the prop's side facing it by a 0.65 m vine.
    const bx = sp.x - 0.55;
    const bait = h.box({ p: { x: bx, y: g + 0.03, z: -2.5 }, size: [0.25, 0.04, 1 / 1100 / (0.25 * 0.04)], material: 'hide', state: 'free', look: 'hide' });
    h.ticks(10);
    take(h, bait, 'take the bait');
    goTo(h, { x: bx, z: -1.0 });
    h.must({ verb: 'place', target: 0, at: toCm({ x: bx, y: g + 0.04, z: PROP.z }), yaw: 64, pitch: 0 }, 'place the bait');
    h.ticks(20);
    const coil = h.coil({ material: 'vine', lengthM: 3, at: { x: 2, y: g, z: -2 } });
    h.ticks(5);
    take(h, coil, 'take the vine coil');
    h.must({ verb: 'stow', target: 0, slot: 0 }, 'the coil to the belt');
    goTo(h, { x: bx + 0.2, z: -0.9 });
    const bp = h.ent(bait).pose.p;
    const btop = { x: bp.x, y: bp.y + 0.02, z: bp.z };
    const face = { x: sp.x - PROP.r * Math.cos(Math.PI / 8), z: sp.z };
    const dh = flat(face, btop);
    h.must({ verb: 'lash', target: bait, second: prop, at: toCm(btop), at2: toCm({ x: face.x, y: btop.y + Math.sqrt(0.65 * 0.65 - dh * dh), z: face.z }) }, 'lash the bait to the prop');
    h.ticks(30);
    goTo(h, { x: -3, z: -6 });
    return { prop, log, bait };
  }

  function stagedHold(h: Harness, r: { prop: number; log: number; bait: number }): void {
    // The log was only spawned (D-25): its credit is [] (RT-19); the prop and the bait were placed by the player.
    expect(h.ent(r.log).credit).toEqual([]);
    expect(h.ent(r.prop).credit).toEqual(['p1']);
    expect(h.ent(r.bait).credit).toEqual(['p1']);
    const tilt = holdTilt(h, r);
    console.info(`deadfall staged: ${h.ent(r.log).mass.toFixed(1)} kg log; prop tilt over 120 s awake ≤ ${tilt.toFixed(3)}°`);
    // GATE: set 120 s awake, tilt < 1°.
    expect(tilt).toBeLessThan(1);
  }

  it('staged physics (§11.2(a) as written): the 6 m log on a 2.38 m stick holds 120 s awake, springs when the ape tugs the bait toward itself, and hits it at v_n ≥ 2 m/s', async () => {
    const h = await make(48, 40);
    const r = buildStagedDeadfall(h);
    const vnOf = watchVelocities(h, [r.log]);
    stagedHold(h, r);
    const z0 = h.ent(r.log).pose.p.z;
    const b = h.ent(r.bait).pose.p;
    // Step 4: routed crouched to 0.8 m inward of the bait, then a tug toward its own body.
    const res = apeAtBait(h, { log: r.log, bait: r.bait, stand: { x: b.x - 0.8, z: b.z }, act: { tugYaw: TOWARD_BODY }, vnOf });
    report('deadfall staged', res);
    h.ticks(240);
    const zEnd = h.ent(r.log).pose.p.z;
    console.info(`deadfall staged: the log came to rest ${Math.abs(zEnd - z0).toFixed(3)} m from its vertical plane`);
    console.info(`deadfall staged: tripwires ${JSON.stringify(h.tripwires().map((t) => ({ by: t.by, loadN: t.loadN, snapped: t.snapped, point: t.point })))}; grip tick ${res.grip}, now ${h.w.tick}`);
    // GATE: springs within 1.0 s of the grip.
    expect(res.spring).toBeGreaterThan(0);
    expect((res.spring - res.grip) / 60).toBeLessThanOrEqual(1.0);
    // GATE: an impact on the ape from the log, not held, v_n ≥ 2 m/s, damage > 0.
    const k = res.hits.findIndex((i, j) => !i.cause.held && i.damage > 0 && res.vn[j] >= 2);
    expect(k, 'a log hit with v_n ≥ 2 m/s and damage > 0').toBeGreaterThanOrEqual(0);
    // GATE: no tripwire event; the log lands within 0.35 m of its own vertical plane; the ape fitted.
    expect(h.tripwires()).toEqual([]);
    expect(Math.abs(zEnd - z0)).toBeLessThan(0.35);
    expect(res.fit).toBeGreaterThan(0);
  }, LONG_IT_MS);

  it('staged negative control: a 700 N tug does not spring it', async () => {
    const h = await make(48, 40);
    const r = buildStagedDeadfall(h);
    const vnOf = watchVelocities(h, [r.log]);
    h.ticks(60);
    const b = h.ent(r.bait).pose.p;
    const res = withTugN(1.1, 700, () => apeAtBait(h, { log: r.log, bait: r.bait, stand: { x: b.x - 0.8, z: b.z }, act: { tugYaw: TOWARD_BODY }, vnOf }));
    report('deadfall staged, 700 N control', res);
    // GATE: no spring, no hit.
    expect(res.spring).toBe(-1);
    expect(res.hits.filter((i) => i.damage > 0)).toEqual([]);
  }, RAPIER_IT_MS);

  it('staged physics: the 6 m log springs on an ape that walks its route under it into the prop, and hits it at v_n ≥ 2 m/s', async () => {
    const h = await make(48, 40);
    const r = buildStagedDeadfall(h, STAGED_AS_DESIGNED);
    const vnOf = watchVelocities(h, [r.log]);
    stagedHold(h, r);
    const z0 = h.ent(r.log).pose.p.z;
    const b = h.ent(r.bait).pose.p;
    const res = apeAtBait(h, { log: r.log, bait: r.bait, stand: { x: b.x - 0.4, z: b.z }, act: { walkTo: { x: b.x + 1.2, z: b.z } }, vnOf });
    report('deadfall staged, walked', res);
    h.ticks(240);
    const zEnd = h.ent(r.log).pose.p.z;
    console.info(`deadfall staged, walked: the log came to rest ${Math.abs(zEnd - z0).toFixed(3)} m from its vertical plane; tripwire events ${h.tripwires().length} (LOGGED)`);
    // GATE: the ape fits until the spring; it springs; a hit from the log, not held, v_n ≥ 2 m/s, damage > 0.
    expect(res.fit).toBeGreaterThan(0);
    expect(res.spring).toBeGreaterThan(0);
    const k = res.hits.findIndex((i, j) => !i.cause.held && i.damage > 0 && res.vn[j] >= 2);
    expect(k, 'a log hit with v_n ≥ 2 m/s and damage > 0').toBeGreaterThanOrEqual(0);
    // GATE: the log lands within 0.35 m of its own vertical plane.
    expect(Math.abs(zEnd - z0)).toBeLessThan(0.35);
  }, LONG_IT_MS);
});

// ---------------------------------------------------------------------------
// (b) Spike pit: the giant ape, weight-triggered
// ---------------------------------------------------------------------------

/*
 * AC-2(b). P28's first run found the pit unreachable (the spoil's berm, fixed by SIM-fix4); its second and third found
 * the cover tripped `ledge`, the stakes broken without impacts and the bridge tripped on. Fourth pass (P28's fixes,
 * docs/work/ledger.md): a ruler's support set and the lost-support trip rule (a support lost to its own weight or legs
 * is a `cover` trip; precedence cover > ledge > obstacle); the mover shoves only what its straight part from the ankle
 * to the hip meets (the round foot of the old capsule shoved the bearers lying at the pit's end at 4 m/s before the
 * giant stood on them); a fallen ruler is a weight on what it lies on (the 4 kg bearers held a tripped giant up), and
 * load-tests it; a stake its weight or a blow breaks is recorded as an impact on it first (SPEC:344); light load-broken
 * debris crumbles (BREAK_TUNING.loadBreakMinKg: grass-bundle pieces load-broke themselves ≈ 200 a tick); the slope
 * limit reads only ground it walks on (a bridge's logs, not the pit wall under them). The cover's bearers each span their
 * own line of the hole and stop short of the spoil (scenes.ts), and so do the bridge's logs (bridgeLogs).
 */
/**
 * The bridge control's logs over the pit as dug (see its DEPARTURE): along z, ≤ 1 m apart from the undug ground beyond
 * one end of the hole to the other, each 0.5 m onto the undug rim beyond its own line's dug width, stopping short of the
 * spoil (ground no higher than its original there). `spawn` makes one (length, r, pose); returns them in x order.
 */
/** §11.2(b)'s bridge log section: "r 0.18 m" round (651 kg at 8 m of green wood) as the factory's 6-gon log of the same area. */
const BRIDGE_LOG_R = prismRForRoundDiam(0.36, PHYSICS_TUNING.logFacets);

function bridgeLogs(h: Harness, spawn: (o: { length: number; r: number; p: V3; q: Quat }) => number): number[] {
  const t = h.w.terrain;
  const dug = (x: number, z: number): boolean => t.heightAt(x, z) < t.originalHeightAt(x, z) - 0.05;
  const raised = (x: number, z: number): boolean => t.heightAt(x, z) > t.originalHeightAt(x, z) + 0.05;
  let xMin = 0;
  let xMax = 0;
  for (let z = -5; z <= 5; z += 0.25) for (let x = -6; x <= 6; x += 0.05) if (dug(x, z)) [xMin, xMax] = [Math.min(xMin, x), Math.max(xMax, x)];
  const n = Math.ceil((xMax - xMin) / 1.0) + 1;
  const logs: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = xMin + ((xMax - xMin) * i) / (n - 1) + 0.013;
    // Its line's dug half-width (over the strip it covers), then 0.5 m onto the rim, short of the berm.
    let w = 0;
    for (const dx of [-0.2, 0, 0.2]) for (let z = 0; z <= 5; z += 0.05) if (dug(x + dx, z) || dug(x + dx, -z)) w = Math.max(w, z);
    let hz = w + 0.5;
    for (let z = w; z <= w + 0.5 + 1e-9; z += 0.05) {
      if (raised(x, z) || raised(x, -z)) {
        hz = Math.max(w + 0.25, z - 0.1);
        break;
      }
    }
    let rim = -Infinity;
    for (const z of [w + 0.05, (w + hz) / 2, hz]) rim = Math.max(rim, t.heightAt(x, z), t.heightAt(x, -z));
    logs.push(spawn({ length: 2 * hz, r: BRIDGE_LOG_R, p: { x, y: rim + BRIDGE_LOG_R + 0.02, z: 0 }, q: lyingAlong(0) }));
  }
  return logs;
}

describe('AC-2(b): a covered spike pit wounds the giant that steps on its cover', () => {
  let pit: Uint8Array;
  beforeAll(async () => {
    pit = await cachedScene('pit');
  }, SCENE_BUILD_TIMEOUT_MS);

  /** The cached pit's parts, from the loaded world: 108 driven stakes, the rotten bearers, the grass laid on them. */
  function parts(h: Harness): { stakes: Set<number>; bearers: number[]; grass: number[] } {
    const all = [...h.w.entities.all()];
    const stakes = new Set(all.filter((e) => e.state === 'anchored' && e.sharpPoints.length > 0).map((e) => e.id));
    const bearers = all.filter((e) => e.material === 'rottenWood').map((e) => e.id);
    const grass = all.filter((e) => e.look === 'grass' && Math.abs(e.pose.p.x) < 4.8 && Math.abs(e.pose.p.z) < 4.8).map((e) => e.id);
    return { stakes, bearers, grass };
  }

  it('the cached pit: 108 stakes and the cover; the cover holds its own weight 60 s awake', async () => {
    const h = await load(pit);
    const { stakes, bearers, grass } = parts(h);
    console.info(`pit: ${stakes.size} stakes, ${bearers.length} bearers, ${grass.length} grass bundles on them`);
    expect(stakes.size).toBe(108);
    // 20 bearers over the planned 8 m; furnishPit's coverDugRim spans the hole as dug, so at least that many.
    expect(bearers.length).toBeGreaterThanOrEqual(20);
    const cover = [...bearers, ...grass];
    const y0 = new Map(cover.map((id) => [id, h.ent(id).pose.p.y]));
    for (const id of cover) h.keepAwake(id);
    const ev = h.ticks(3600);
    let sink = 0;
    for (const id of cover) {
      const e = h.w.entities.get(id);
      if (e) sink = Math.max(sink, y0.get(id)! - e.pose.p.y);
    }
    console.info(`pit cover 60 s awake: breaks ${of(ev.world, 'break').length}, deepest sink ${(sink * 100).toFixed(1)} cm`);
    // GATE: no break, nothing sinks more than 5 cm.
    expect(of(ev.world, 'break')).toEqual([]);
    expect(sink).toBeLessThanOrEqual(0.05);
  }, LONG_IT_MS);

  const RUNS = [3, 4.5, 6].flatMap((speed) => [-1, 0, 1].map((dz) => ({ speed, dz })));

  /**
   * The steepest rise on the giant's charge line z = `dz` from x −30 to the pit's end (x −4.5), sampled every 0.25 m
   * (the terrain's spacing), in degrees, and where. The ruler's mover refuses a rise steeper than maxSlopeDeg (§4.7).
   */
  function steepestOnLine(h: Harness, dz: number): { deg: number; x: number } {
    let worst = { deg: 0, x: Number.NaN };
    for (let x = -30; x < -4.5; x += 0.25) {
      const rise = h.w.terrain.heightAt(x + 0.25, dz) - h.w.terrain.heightAt(x, dz);
      const d = deg(Math.atan2(rise, 0.25));
      if (d > worst.deg) worst = { deg: d, x };
    }
    return worst;
  }

  /** Every entity a broken entity's pieces became (recursively), live now. */
  function descendants(h: Harness, roots: readonly number[]): number[] {
    const out = new Set<number>();
    const breaks = of(h.history.world, 'break');
    const kids = new Map<number, number[]>(breaks.map((b) => [b.entity, b.pieces]));
    const visit = (id: number): void => {
      const k = kids.get(id);
      if (!k) {
        if (h.w.entities.get(id)) out.add(id);
        return;
      }
      for (const c of k) visit(c);
    };
    for (const r of roots) visit(r);
    return [...out];
  }

  /** Does the entity rest on both long rims (one end beyond each, both up at rim level)? */
  function spansPit(h: Harness, id: number): boolean {
    const e = h.ent(id);
    if (e.shape.kind !== 'cylinder') return false;
    const half = (e.shape as { halfLength?: number; length?: number }).halfLength ?? ((e.shape as { length?: number }).length ?? 0) / 2;
    const a = axisOf(h, id);
    const ends = [1, -1].map((s) => ({ x: e.pose.p.x + a.x * half * s, y: e.pose.p.y + a.y * half * s, z: e.pose.p.z + a.z * half * s }));
    const rim = (q: V3): boolean => Math.abs(q.z) > 3 && q.y > h.w.terrain.heightAt(q.x, q.z) - 0.3;
    return ends[0].z * ends[1].z < 0 && rim(ends[0]) && rim(ends[1]);
  }

  it.each(RUNS)('the giant charges across it at $speed m/s, $dz m off its centre line: a load break, a cover trip, a stake wound', async ({ speed, dz }) => {
    const h = await load(pit);
    const { stakes, bearers, grass } = parts(h);
    const cover = new Set([...bearers, ...grass]);
    const giant = h.creature('giantApe', { x: -30, z: dz }, Math.PI / 2, { brain: 'off' });
    h.script(giant, { kind: 'charge', heading: Math.PI / 2, speed });
    let firstBreak = -1;
    let bridged = 0;
    let nan = false;
    let reached = -Infinity;
    const maxTicks = Math.round((30 / speed + 12) * 60);
    h.ticks(maxTicks, (_, t) => {
      reached = Math.max(reached, giant.pos.x);
      if (firstBreak < 0) {
        const b = of(h.history.world, 'break').find((e) => cover.has(e.entity));
        if (b) firstBreak = t;
      } else if (t - firstBreak === 30) {
        bridged = descendants(h, [...cover].filter((id) => of(h.history.world, 'break').some((b) => b.entity === id))).filter((id) => spansPit(h, id)).length;
      }
      if (!nan && !noNaN(h, [giant])) nan = true;
    });
    const evs = h.history.world;
    const idx = (e: WorldEvent): number => evs.indexOf(e);
    const coverBreaks = of(evs, 'break').filter((b) => cover.has(b.entity));
    const loadBreaks = coverBreaks.filter((b) => b.energy === 0);
    const trips = of(evs, 'trip').filter((e) => e.f === giant);
    const wounds = h.wounds(giant).filter((w) => w.cause.entityId !== null && stakes.has(w.cause.entityId));
    const pitDamage = h.wounds(giant).reduce((s, w) => s + w.hp, 0) + of(evs, 'impact').filter((i) => i.defender === giant && i.cause.entityId !== null && stakes.has(i.cause.entityId) && !i.wound).reduce((s, i) => s + i.damage, 0);
    const stakeBreaks = of(evs, 'break').filter((b) => stakes.has(b.entity));
    const firstImpact = (stake: number): number => evs.findIndex((e) => e.type === 'impact' && e.defender === giant && e.cause.entityId === stake);
    console.info(
      `pit run ${speed} m/s, ${dz} m: cover breaks ${coverBreaks.length} (load ${loadBreaks.length}), trips ${trips.map((t) => t.why).join(',') || 'none'}, ` +
        `stake wounds ${wounds.length} (${wounds.map((w) => `${w.zone} ${w.hp.toFixed(0)} HP`).join(', ')}), pit damage ${pitDamage.toFixed(0)} HP, ` +
        `stakes broken ${stakeBreaks.length}, broken cover still bridging 0.5 s on ${bridged}, alive ${giant.alive} (LOGGED); ` +
        `furthest x ${reached.toFixed(2)}; the steepest rise on its line ${steepestOnLine(h, dz).deg.toFixed(0)}° at x ${steepestOnLine(h, dz).x.toFixed(2)}`,
    );
    // The charge reaches the cover (x −4.5 is the pit's end): what every gate below needs.
    expect(reached, 'the giant reaches the pit').toBeGreaterThan(-4.5);
    // GATE: a load break of a cover entity before the trip, and the trip is the cover's (RT-1).
    expect(loadBreaks.length).toBeGreaterThan(0);
    expect(trips.length).toBeGreaterThan(0);
    expect(trips[0].why).toBe('cover');
    expect(idx(loadBreaks[0])).toBeLessThan(idx(trips[0]));
    // GATE: ≥ 1 wound from a stake, credited to the player.
    expect(wounds.length).toBeGreaterThan(0);
    expect(wounds.some((w) => w.credit.includes('p1') || w.cause.credit.includes('p1'))).toBe(true);
    // GATE: 0.5 s after the first cover break no piece of a broken cover entity rests on both rims (RT-7).
    expect(bridged).toBe(0);
    // GATE: every stake that broke had its impact before its break (SPEC:344).
    for (const b of stakeBreaks) {
      const i = firstImpact(b.entity);
      expect(i, `stake ${b.entity}'s impact`).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(idx(b));
    }
    // GATE: no NaN.
    expect(nan).toBe(false);
    // PIN (§11.2(b): 385-3,084 HP per run, I-rev ac3_density.out): the pit's damage in that band.
    expect(pitDamage).toBeGreaterThan(385 * 0.5);
  }, LONG_IT_MS);

  it('negative control: the same pit bridged by 651 kg green logs (cover carried off): the giant crosses at 6 m/s, nothing breaks, no trip, never in the pit', async () => {
    const h = await load(pit);
    const { bearers } = parts(h);
    // The giant can only cross what it can reach: the charge line must be no steeper than its mover climbs (§4.7). On
    // the cached pit before SIM-fix4 it wasn't (the spoil berm, above), and the test stopped here.
    const steep = steepestOnLine(h, 0);
    console.info(`bridge: the steepest rise on the charge line is ${steep.deg.toFixed(0)}° at x ${steep.x.toFixed(2)} (the mover climbs ≤ ${RULER_BODY_TUNING.maxSlopeDeg}°)`);
    expect(steep.deg, 'the charge line is climbable').toBeLessThanOrEqual(RULER_BODY_TUNING.maxSlopeDeg);
    // The player carries every bearer off by verbs (the grass on them falls into the pit), from the −z rim lane beyond
    // their ends (on a rotten bearer his weight would break it, §4.11), round the pit's +x end to the south-east (as
    // buildPit brought them).
    const halfL = Math.max(...bearers.map((id) => (h.ent(id).shape as { halfHeight: number }).halfHeight));
    const laneZ = -(halfL + 0.6);
    const southEast = { x: 6, z: laneZ };
    for (const [k, id] of bearers.entries()) {
      goTo(h, southEast);
      const e = h.ent(id).pose.p;
      goTo(h, { x: e.x, z: laneZ });
      take(h, id, `take bearer ${id}`);
      goTo(h, southEast);
      goTo(h, { x: 8, z: laneZ - 5 - 0.6 * k });
      // (Carrying a 10.5 m pole round the pit's corner, he may stumble and let it go: it lies where it fell.)
      if (h.p.inventory?.hands?.entity === id) h.must({ verb: 'drop', target: 0 }, `put bearer ${id} down`);
    }
    const left = bearers.filter((id) => h.w.entities.get(id) && Math.abs(h.ent(id).pose.p.x) < 5 && Math.abs(h.ent(id).pose.p.z) < 5);
    console.info(`bridge: bearers still over the pit after carrying them off: ${left.length}`);
    goTo(h, { x: 0, z: -12 });
    h.ticks(300);
    // The bridge (D-25: 651 kg logs no verb moves), spawned at their pose. DEPARTURE (§11.2(b) "8 green logs r 0.18 m ×
    // 8 m (651 kg)"): the design's mass, 651 kg each, over the hole as dug (P28: ≈ ±4.45 m by up to ±4.25 m, not the
    // planned 8 × 6), as many as keep them ≤ 1 m apart from undug ground at one end to the other (the giant's 1.06 m
    // sole bridges a gap that wide), each as long as its own line across the hole needs to bear 0.5 m on the undug rim
    // beyond it, short of the spoil's berm: a log as long as the widest point (9.5 m) lay with its ends up on the berm's
    // flanks, its top 0.34-0.56 m above the rim (the giant's ankle is 0.39 m) where the giant stepped onto it, and tripped.
    const logs = bridgeLogs(h, (o) => h.log({ material: 'greenWood', ...o }));
    h.ticks(240);
    const lr = (h.ent(logs[0]).shape as { r: number }).r;
    console.info(`bridge: ${logs.length} logs of ${h.ent(logs[0]).mass.toFixed(0)} kg, ${logs.map((l) => (2 * (h.ent(l).shape as { halfHeight: number }).halfHeight).toFixed(2)).join(', ')} m, r ${lr.toFixed(3)}; tops at ${logs.map((l) => (h.ent(l).pose.p.y + lr).toFixed(2)).join(', ')} m`);
    const from = h.history.world.length;
    const giant = h.creature('giantApe', { x: -30, z: 0 }, Math.PI / 2, { brain: 'off' });
    h.script(giant, { kind: 'charge', heading: Math.PI / 2, speed: 6 });
    h.ticks(Math.round((60 / 6 + 4) * 60));
    const evs = h.history.world.slice(from);
    console.info(`bridge run: giant at x ${giant.pos.x.toFixed(1)}; breaks ${of(evs, 'break').length}, trips ${of(evs, 'trip').length}, pit on ${of(evs, 'pit').filter((e) => e.on).length}`);
    // The giant got across.
    expect(giant.pos.x).toBeGreaterThan(5);
    // GATE: no break, no trip, `pit` never on.
    expect(of(evs, 'break')).toEqual([]);
    expect(of(evs, 'trip')).toEqual([]);
    expect(of(evs, 'pit').filter((e) => e.on)).toEqual([]);
  }, LONG_IT_MS);
});

// ---------------------------------------------------------------------------
// (c) Swinging log: the ape
// ---------------------------------------------------------------------------

describe('AC-2(c): a swinging log wounds the ape at the bottom of its arc', () => {
  it('verb-only gate: the 30 kg log hauled back on its vines and tied off holds; cut loose, it passes the bottom at ≥ 4 m/s and hits the ape', async () => {
    const h = await make(45, 50);
    const r = buildHauledLog(h, { at: { x: 0, z: 0 } });
    // The hauled end is tied off from here on (the recipe's own 'loose' events, its rope ends let go of, come before).
    const tiedFrom = h.history.world.length;
    const vnOf = watchVelocities(h, [r.log]);
    const tieRope = h.w.joints.get(r.tie)!.rope!.entity;
    const ape = h.creature('ape', { x: 0.25, z: 0 }, -Math.PI / 2, { brain: 'off' });
    h.ticks(120);
    // GATE: while tied nothing snaps or pulls loose; no tripwire event; the stake stays anchored.
    expect(of(h.history.world.slice(tiedFrom), 'joint').filter((e) => e.what === 'snap' || e.what === 'loose')).toEqual([]);
    expect(h.tripwires()).toEqual([]);
    expect(h.ent(r.stake).state).toBe('anchored');
    expect(h.w.joints.get(r.tie)).toBeDefined();
    const held = h.ent(r.log).pose.p;
    console.info(`swing gate: tied off at (${held.x.toFixed(2)}, ${held.y.toFixed(2)}), tie ${h.w.joints.get(r.tie)!.rope!.lengthM.toFixed(2)} m`);
    // The player draws the stone axe and cuts the tie, standing beside it (focused on the rope sensor's nearest point).
    h.must({ verb: 'draw', target: 0, slot: BACK_SLOT }, 'draw the stone axe');
    const tie = h.w.joints.get(r.tie)!;
    const ends = h.w.joints.endPoints(tie)!;
    goTo(h, { x: (ends.a.x + ends.b.x) / 2, z: (ends.a.z + ends.b.z) / 2 + 1.2 });
    const from = h.history.world.length;
    h.must({ verb: 'cut', target: tieRope }, 'cut the tie');
    let bottomV = 0;
    h.ticks(240, () => {
      const e = h.ent(r.log);
      if (Math.abs(e.pose.p.x) < 0.3) bottomV = Math.max(bottomV, Math.hypot(e.vel.lin.x, e.vel.lin.y, e.vel.lin.z));
    });
    const evs = h.history.world.slice(from);
    const cut = of(evs, 'joint').find((e) => e.joint === r.tie);
    const hits = h.impacts(ape).filter((i) => i.cause.entityId === r.log);
    console.info(`swing gate: the tie went '${cut?.what}'; the log passes the bottom at ${bottomV.toFixed(2)} m/s; hits ${hits.map((i) => `${i.bone} v_n ${vnOf(i).toFixed(2)} m/s ${i.damage.toFixed(2)} HP`).join('; ') || 'none'}`);
    expect(cut?.what).toBe('cut');
    // GATE: past the bottom at ≥ 4 m/s; an impact on the ape from the log, damage > 0, credited to the player.
    expect(bottomV).toBeGreaterThanOrEqual(4);
    const hit = hits.find((i) => !i.cause.held && i.damage > 0);
    expect(hit).toBeDefined();
    expect(hit!.cause.credit).toContain('p1');
    // PIN (§11.2(c): 5.26 m/s, shin hit v_n 4.94 m/s, 3.4 HP; P28 lab: 4.66 m/s peak, the thigh 3.0 HP): 4-6 m/s, 1-6 HP.
    expect(bottomV).toBeLessThan(6);
    expect(hit!.damage).toBeGreaterThan(1);
    expect(hit!.damage).toBeLessThan(6);
  }, RAPIER_IT_MS);

  it('staged physics: the 300 kg log held 60° back by a 0.58 m tie holds; cut from the scaffold, it hits the ape at v_n ≥ 5 m/s', async () => {
    const h = await make(47, 50);
    h.give('stoneAxe', 'back');
    // 1: the two trees and their vines (as the gate's).
    const vines: number[] = [];
    for (const s of [1, -1]) vines.push(h.tree({ at: { x: 0, z: 2.6 * s }, diameter: 0.4, height: 14, vine: { anchorH: 8, lengthM: 9, yaw: s > 0 ? Math.PI : 0 } }).vine!.rope);
    // 2: the 300 kg dry hex log along z, staged at the pulled-back pose: 60° back, centre (−5.59, 4.78, 0), its top face
    // toward the anchors.
    const C = { x: -5.59, y: 4.78, z: 0 };
    const q = mulQ(aboutZ((-60 * Math.PI) / 180), lyingAlong(0));
    // (The factory sizes a log from its mass when given one; r is then unused.)
    const log = h.log({ mass: 300, length: 4, r: 0.23, p: { x: 6, y: 0.4, z: 8 }, q: lyingAlong(0) });
    h.ticks(10);
    const R = (h.ent(log).shape as { r: number }).r;
    h.stage(log, { p: C, q });
    // 3: the scaffold (x −6.2 … −5.85, z −2.0 … 3.5, top 2.65 m) and the tie post (0.4 × 6 × 0.4 m at x −6.6).
    h.box({ p: { x: -6.025, y: 2.65 / 2, z: 0.75 }, size: [0.35, 2.65, 5.5], material: 'dryWood', state: 'fixed', look: 'scaffold' });
    const post = h.box({ p: { x: -6.6, y: 3, z: 0 }, size: [0.4, 6, 0.4], material: 'dryWood', state: 'fixed', look: 'post' });
    h.ticks(5);
    // 4: each vine end tied to the log's top face at local ±1.6 m from the scaffold; a vine coil tied from the log's
    // back edge to the post (a horizontal 0.58 m tie at 4.78 m); then the log unstaged.
    const ri = R * Math.cos(Math.PI / 6);
    for (const [k, s] of [1, -1].entries()) {
      take(h, vines[k], 'take a vine end');
      const tp = rotQ(q, { x: ri, y: 1.6 * s, z: 0 });
      const at = { x: C.x + tp.x, y: C.y + tp.y, z: C.z + tp.z };
      h.standAt({ x: -6.0, z: at.z }, Math.PI / 2);
      h.ticks(5);
      h.must({ verb: 'tie', target: log, at: toCm(at) }, 'tie a vine to the log');
    }
    const coil = h.coil({ material: 'vine', lengthM: 3, at: { x: -4, y: 0, z: -3 } });
    h.ticks(5);
    take(h, coil, 'take the tie coil');
    h.standAt({ x: -6.0, z: 0 }, -Math.PI / 2);
    h.ticks(5);
    h.must({ verb: 'tie', target: log, at: toCm({ x: C.x - R + 0.01, y: C.y, z: 0 }) }, 'tie the coil to the log');
    h.must({ verb: 'tie', target: post, at: toCm({ x: -6.4, y: C.y, z: 0 }) }, 'tie the coil to the post');
    const vineJoints = h.w.joints.all().filter((j) => j.kind === 'rope' && j.rope!.entity !== coil && [j.a.entity, j.b.entity].includes(log));
    const tie = h.w.joints.all().find((j) => j.rope?.entity === coil)!;
    expect(vineJoints).toHaveLength(2);
    h.unstage(log);
    const vnOf = watchVelocities(h, [log]);
    let peakRope = 0;
    let peakTie = 0;
    const tension = (): void => {
      for (const j of vineJoints) peakRope = Math.max(peakRope, ...(h.w.joints.get(j.id)?.tension ?? [0]));
      peakTie = Math.max(peakTie, ...(h.w.joints.get(tie.id)?.tension ?? [0]));
    };
    h.ticks(60, tension);
    // 5: the ape holds at the arc's bottom; the player draws the axe and cuts the tie from the scaffold.
    const ape = h.creature('ape', { x: 0.25, z: 0 }, -Math.PI / 2, { brain: 'off' });
    h.ticks(60, tension);
    console.info(`swing staged: vines ${vineJoints.map((j) => j.rope!.lengthM.toFixed(2)).join(', ')} m, tie ${tie.rope!.lengthM.toFixed(2)} m; held peaks: per vine ${(peakRope / 1000).toFixed(2)} kN, tie ${(peakTie / 1000).toFixed(2)} kN`);
    // GATE: while held no rope snaps; no tripwire.
    expect(of(h.history.world, 'joint').filter((e) => e.what === 'snap')).toEqual([]);
    expect(h.tripwires()).toEqual([]);
    // PIN (§11.2(c), C lab e3_swing: per rope ≤ 2.94 kN ± 3 %; tie 5.09 kN).
    expect(peakRope).toBeLessThan(2940 * 1.03);
    h.must({ verb: 'draw', target: 0, slot: BACK_SLOT }, 'draw the stone axe');
    // The cut is made from the scaffold's back edge, 1 m along it from the tie (P28 lab: from right under the tie the
    // arc meets the log's back edge first and the push snaps the tie; from here it meets the rope).
    h.standAt({ x: -6.15, z: 1.0 }, Math.PI);
    h.ticks(5);
    const from = h.history.world.length;
    h.must({ verb: 'cut', target: coil }, 'cut the tie');
    const cutAt = of(h.history.world.slice(from), 'joint').find((e) => e.joint === tie.id);
    let peakV = 0;
    h.ticks(240, () => {
      const e = h.ent(log);
      peakV = Math.max(peakV, Math.hypot(e.vel.lin.x, e.vel.lin.y, e.vel.lin.z));
    });
    goTo(h, { x: -6.15, z: 3.0 });
    h.ticks(120);
    const hits = h.impacts(ape).filter((i) => i.cause.entityId === log);
    const onPlayer = h.impacts(h.p).filter((i) => i.cause.entityId === log);
    console.info(
      `swing staged: the tie went '${cutAt?.what}'; the log peaks at ${peakV.toFixed(2)} m/s; hits ${hits.map((i) => `${i.bone} v_n ${vnOf(i).toFixed(2)} m/s dv ${Math.hypot(i.dv.x, i.dv.y, i.dv.z).toFixed(2)} m/s ${i.damage.toFixed(1)} HP${i.launched ? ' launched' : ''}`).join('; ') || 'none'}; the log on the player: ${onPlayer.length}`,
    );
    // GATE: the tie is cut (the timing starts there); an impact on the ape from the log with v_n ≥ 5 m/s, damage > 0.
    expect(cutAt?.what).toBe('cut');
    const k = hits.findIndex((i) => !i.cause.held && i.damage > 0 && vnOf(i) >= 5);
    expect(k, 'a log hit with v_n ≥ 5 m/s and damage > 0').toBeGreaterThanOrEqual(0);
    // RT-19: the log was spawned and staged, but the player tied it (a verb touched it), so the scored cause carries 'p1'.
    expect(hits[k].cause.credit).toContain('p1');
    // PIN (§11.2(c): the log reaches 7.95 m/s ± 3 %; 32.9 HP on the chest, launched; C lab e3_swing, rev.out §2).
    expect(peakV).toBeGreaterThan(7.95 * 0.97);
    expect(peakV).toBeLessThan(7.95 * 1.03);
    expect(hits[k].damage).toBeGreaterThan(25);
    expect(hits[k].damage).toBeLessThan(40);
  }, RAPIER_IT_MS);
});

// ---------------------------------------------------------------------------
// (d) Felled tree: an ape at 12 m, the giant at 8 m
// ---------------------------------------------------------------------------

describe('AC-2(d): a tree felled by a pull on its vine hits the creature on its fall line', () => {
  /** buildNotchedTree (chopped from −x to 0.2: it falls toward +x), then the player takes the vine end out to P. */
  function notched(h: Harness): { tree: number; rope: number } {
    const r = buildNotchedTree(h, { at: { x: 0, z: 0 }, fromSide: { x: -1, z: 0 }, remaining: 0.2, vine: { anchorH: 10, lengthM: 18.2 } });
    // GATE: the tree stays fixed (notched) for 120 ticks with no pull.
    h.ticks(120);
    expect(h.ent(r.tree).state).toBe('fixed');
    expect(h.ent(r.tree).plant?.phase).toBe('notched');
    const rope = h.w.joints.get(r.vineJoint)!.rope!.entity;
    take(h, rope, 'take the vine end');
    // P: 15.6 m from the trunk, 45° off the fall line.
    h.walk({ x: 15.6 * Math.SQRT1_2, z: 15.6 * Math.SQRT1_2 });
    expect(h.p.inventory?.hands?.mode).toBe('ropeEnd');
    return { tree: r.tree, rope };
  }

  it('the ape 12 m out on the fall line: the hinge breaks to the pull, the trunk lands on the line and hits it at v_n ≥ 10 m/s', async () => {
    const h = await make(46, 60);
    const { tree, rope } = notched(h);
    const ape = h.creature('ape', { x: 12, z: 0 }, -Math.PI / 2, { brain: 'off' });
    const vnOf = watchVelocities(h, [tree]);
    h.ticks(60);
    // The hinge breaks on the first pulling tick: the `fell` event's tick against the first tick the vine is taut and so
    // carries the hand's pull to the tree (P28 lab: the vine hangs with ≈ 0.36 m of slack from P, which the haul takes
    // in at the hand's speed first; the joint's tension reads the hand's pullN meanwhile, so slack is what is measured).
    const vine = h.w.joints.all().find((j) => j.rope?.entity === rope)!.id;
    const slack = (): number => {
      const j = h.w.joints.get(vine);
      const pts = j ? h.w.joints.endPoints(j) : null;
      return j?.rope && pts ? j.rope.lengthM - Math.hypot(pts.a.x - pts.b.x, pts.a.y - pts.b.y, pts.a.z - pts.b.z) : Number.NaN;
    };
    const slack0 = slack();
    let fellAt = -1;
    let tautAt = -1;
    const pullAt = h.w.tick + 1;
    const watch = (s: { world: WorldEvent[] }, t: number): void => {
      if (tautAt < 0 && slack() <= 1e-3) tautAt = t;
      if (fellAt < 0 && of(s.world, 'fell').some((e) => e.tree === tree)) fellAt = t;
    };
    const on = h.verb({ verb: 'pull', target: 0, charge: 255 });
    expect(on.ok).toBe(true);
    watch({ world: on.events }, pullAt);
    h.ticks(119, watch);
    h.verb({ verb: 'pull', target: 0, charge: 0 });
    h.ticks(600);
    const a = axisOf(h, tree);
    const off = deg(Math.acos(Math.abs(a.x) / Math.hypot(a.x, a.z)));
    const hits = h.impacts(ape).filter((i) => i.cause.entityId === tree);
    const vn = hits.map(vnOf);
    console.info(
      `felled tree, ape: slack ${slack0.toFixed(3)} m at the pull; the vine taut ${tautAt - pullAt} ticks after the pull went on, fell ${fellAt < 0 ? 'never' : `${fellAt - pullAt} ticks after it`}, lies ${off.toFixed(2)}° off the fall line; ` +
        `hits ${hits.map((i, k) => `${i.bone} v_n ${vn[k].toFixed(2)} m/s ${i.damage.toFixed(1)} HP${i.ko ? ' KO' : ''}`).join('; ') || 'none'} (LOGGED: HP and KO)`,
    );
    const kos = h.history.combat.filter((e) => (e as { type?: string }).type === 'ko');
    if (kos.length) console.info(`felled tree, ape: KO events ${JSON.stringify(kos.map((e) => ({ environmental: (e as { environmental?: boolean }).environmental })))}`);
    // GATE: the hinge breaks on the first pulling tick (net 1,794 N·m > 1,018): the tick the vine first carries the pull.
    expect(tautAt).toBeGreaterThanOrEqual(pullAt);
    expect(fellAt).toBeGreaterThanOrEqual(tautAt);
    expect(fellAt - tautAt).toBeLessThanOrEqual(1);
    // GATE: the trunk lands within 5° of the fall line.
    expect(off).toBeLessThan(5);
    // GATE: an impact on the ape from the trunk with v_n ≥ 10 m/s and damage > 0 (RT-3), credited to the player.
    const k = hits.findIndex((i, j) => !i.cause.held && i.damage > 0 && vn[j] >= 10);
    expect(k, 'a trunk hit with v_n ≥ 10 m/s and damage > 0').toBeGreaterThanOrEqual(0);
    expect(hits[k].cause.credit).toContain('p1');
    // PIN (§11.2(d), C lab e4_fell: within 1° of the fall line).
    expect(off).toBeLessThan(1);
  }, RAPIER_IT_MS);

  it('the giant 8 m out on the fall line, standing: the trunk wounds it (> 240 HP)', async () => {
    const h = await make(46, 60);
    const { tree } = notched(h);
    const giant = h.creature('giantApe', { x: 8, z: 0 }, -Math.PI / 2, { brain: 'off' });
    h.ticks(60);
    h.pull(120);
    h.ticks(600);
    const wounds = h.wounds(giant).filter((w) => w.cause.entityId === tree);
    console.info(`felled tree, giant: wounds ${wounds.map((w) => `${w.zone}/${w.bone} ${w.hp.toFixed(0)} HP`).join(', ') || 'none'}`);
    // GATE: a wound (> 240 HP, SPEC:502) from the trunk, credited to the player.
    expect(wounds.length).toBeGreaterThan(0);
    expect(wounds[0].hp).toBeGreaterThan(240);
    expect(wounds[0].credit.includes('p1') || wounds[0].cause.credit.includes('p1')).toBe(true);
    // PIN (§11.2(d): 534-721 HP on the head or chest, C lab e4_fell; P28 lab: 501 HP on the head): 450-800 HP.
    expect(wounds[0].hp).toBeGreaterThan(450);
    expect(wounds[0].hp).toBeLessThan(800);
  }, RAPIER_IT_MS);
});

afterAll(() => {
  for (const h of live.splice(0)) h.w.dispose();
});
