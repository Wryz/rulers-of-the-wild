// AC-5: trip, settle, get up (SPEC:902; docs/M1-DESIGN.md §11.5, package P26).
//
// "A test charges the 14-ton ruler at 6 m/s into a staked 300 kg log at shin height: it trips and gets up after 4
// seconds. With its AI paused once it's up, it stays stable: no NaN, no body part faster than 30 m/s, and every body
// below 0.05 m/s within 10 seconds of the impact."
//
// The scene (rule 1: entities and verbs only, P23's buildStakedLog): a 300 kg dry hex log (4.4 m, circumradius 0.23 m)
// across the path, its centre 1.0 m up (inside the 0.39-2.75 m shin band), lashed with vine to two stakes the player
// placed driven point-up at its ends; staged while the player works (D-25) and unstaged once lashed, so anchored by its
// lashings (a blocker, §2.3). The player is then moved 30 m off (a logged standAt) and paused (no input, idle life
// paused, RF-16, RT-18). Only the creature is scripted: the giant, brain off, `charge`s +x at 6 m/s from x = −20,
// telegraph skipped; at its `rise` event it is paused (mind paused and idle paused: §12's reading of "its AI paused
// once it's up"). P22's pauseMinds pauses only the minds that exist, so every pause here is per fighter, after spawns.
//
// What happens: the charge script shows the knuckle charge (posture headLow, P20), whose forearms reach the log
// ≈ 1.3 m before the shins. Their strike snaps both 600 J lashings; the strike trips the giant 'obstacle' first
// (RulerBodies.legStrike, which, from P26, takes a knuckle-charging forearm for a leg: see strikingLeg in contacts.ts),
// so the trip is decided by a limb striking an anchored blocker across the path (§4.7 steps 4-6; SPEC:782, 344), not
// by the log surviving. The freed log and anything the strike broke must come to rest too.
//
// The body set ("every body", "body part", §11.5, §12): every Rapier body that isn't fixed. A dynamic body's parts are
// its colliders at their point velocity v + ω × r (the tripped ruler included); a kinematic body's (the paused player's
// KCC and zone bodies, the standing or rising ruler) is each collider's displacement over the tick / DT (for the ruler,
// its rig delta / DT, what RulerBodies.partSpeeds reports).
//
// Interpretations (§12 and here): "gets up after 4 s" = the rise starts at +4.00 s after the trip; "the impact" = the
// first tick the giant touches the log (the strike; the trip switches the body the next tick), and "within 10 s" is
// held from there, with every body still kept to +11 s; "it stays stable … no body part faster than 30 m/s" is held
// from the impact on (the stability of the trip, the settle and the rise; the existing P11 test reads it the same
// way), while "no NaN" is held at every tick from the spawn. The run before the impact is logged (the knuckle charge's
// ramp-in moves the forearms at ≈ 33 m/s: reported, see the report of P26).
//
// Variants (§11.5): the lashed log (SPEC's "staked"; the gate), an anchored log and the log as two 150 kg anchored
// halves end to end (factory logs spawned in state 'anchored', spawnLog's driven state: no verb lifts them, D-25). The
// lab's capsule-log variant (failed at +10.83 s) has no factory shape in M1 (logs are hex prisms), so it is not run.
//
// GATE / PIN marks as §11 asks. Every world is disposed (RF-24).
import { afterAll, describe, expect, it } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { DT } from '../src/sim/math';
import { rulerHp } from '../src/sim/ruler';
import { RULER_BODY_TUNING } from '../src/world/rulerBody';
import type { WorldEvent } from '../src/world/types';
import { buildStakedLog, lyingAlong } from './support/scenes';
import { type Harness, makeHarness } from './support/worldHarness';

const live: Harness[] = [];
afterAll(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

const EAST = Math.PI / 2;
/** A macrotask turn, so long synchronous stepping never starves Vitest's worker RPC (ledger: onTaskUpdate timeouts). */
const yieldToVitest = (): Promise<void> => new Promise((r) => setImmediate(r));
/** §11.5's recipe constants (test constants, never tuning). */
const AC5 = {
  seed: 26,
  size: 80,
  log: { centre: { x: 0, y: 1.0, z: 0 }, yaw: 0, massKg: 300 as const, lengthM: 4.4 as const, r: 0.23 },
  giantFrom: { x: -20, z: 0 },
  chargeMps: 6,
  playerAway: { x: 0, z: 30 },
  /** SPEC:902's limits. */
  maxPartMps: 30,
  stillMps: 0.05,
  stillWithinS: 10,
  getUpAfterS: 4,
  /** Every body kept still this long past the 10 s mark. */
  holdS: 1,
  /** No impact within this long of the charge's start: the scene failed. */
  maxRunS: 20,
} as const;

/** §11.5's pins [C lab: e5_trip]. */
const PINS = { trippedMps: 13.0, risingMps: 8.4, logFlungMps: 15.4, riseEndS: 5.57, stillFromS: 5.58 } as const;

/** Every body part's speed after each step, and the first non-finite number read. */
class BodySampler {
  private prev = new Map<number, { body: number; x: number; y: number; z: number }>();
  /** This tick: the fastest part overall, the giant's fastest, and the fastest non-stake entity's. */
  fastest = 0;
  fastestWhat = '';
  ruler = 0;
  logs = 0;
  nan = '';

  constructor(
    private readonly h: Harness,
    private readonly g: Fighter,
    private readonly stakes: ReadonlySet<number>,
  ) {}

  sample(): void {
    const phys = this.h.w.physics;
    const next = new Map<number, { body: number; x: number; y: number; z: number }>();
    this.fastest = 0;
    this.ruler = 0;
    this.logs = 0;
    phys.rapier.forEachRigidBody((b) => {
      if (b.isFixed()) return;
      const v = b.linvel();
      const om = b.angvel();
      const com = b.worldCom();
      const t0 = b.translation();
      const q = b.rotation();
      for (const n of [v.x, v.y, v.z, om.x, om.y, om.z, t0.x, t0.y, t0.z, q.x, q.y, q.z, q.w]) {
        if (!Number.isFinite(n) && !this.nan) this.nan = `body ${b.handle} at tick ${this.h.w.tick}`;
      }
      for (let i = 0; i < b.numColliders(); i++) {
        const c = b.collider(i);
        const t = c.translation();
        next.set(c.handle, { body: b.handle, x: t.x, y: t.y, z: t.z });
        let s: number;
        if (b.isDynamic()) {
          const rx = t.x - com.x;
          const ry = t.y - com.y;
          const rz = t.z - com.z;
          s = Math.hypot(v.x + om.y * rz - om.z * ry, v.y + om.z * rx - om.x * rz, v.z + om.x * ry - om.y * rx);
        } else {
          const p = this.prev.get(c.handle);
          s = p && p.body === b.handle ? Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z) / DT : 0;
        }
        if (!Number.isFinite(s)) {
          if (!this.nan) this.nan = `collider ${c.handle} speed at tick ${this.h.w.tick}`;
          continue;
        }
        const o = phys.ownerOf(c.handle);
        if (o?.kind === 'fighter' && o.id === this.g.id && o.part === 'ruler') this.ruler = Math.max(this.ruler, s);
        if (o?.kind === 'entity' && !this.stakes.has(o.id)) this.logs = Math.max(this.logs, s);
        if (s > this.fastest) {
          this.fastest = s;
          this.fastestWhat = o ? JSON.stringify(o) : `collider ${c.handle}`;
        }
      }
    });
    this.prev = next;
  }
}

/** Any non-finite number in a fighter's state (position, yaw, walk velocity, rig, the ruler's HP). */
function fighterNaN(f: Fighter): boolean {
  const nums = [f.pos.x, f.pos.y, f.pos.z, f.yaw, f.walkVel.x, f.walkVel.y, f.walkVel.z];
  for (const b of Object.values(f.rig)) nums.push(b.pos.x, b.pos.y, b.pos.z, b.rot.x, b.rot.y, b.rot.z, b.rot.w);
  if (f.ruler) nums.push(rulerHp(f.ruler));
  return nums.some((n) => !Number.isFinite(n));
}

type Variant = 'lashed' | 'anchored' | 'halves';

interface Run {
  variant: Variant;
  trip: Extract<WorldEvent, { type: 'trip' }> | null;
  /** Ticks: the first touch (the impact), the trip, the rise, the get-up's end, the last tick any part moved ≥ 0.05. */
  impact: number;
  tripTick: number;
  rise: number;
  up: number;
  lastMoving: number;
  end: number;
  rootAtTrip: number;
  /** Fastest part from the impact on; and before it (logged only). */
  maxPart: number;
  maxPartWhat: string;
  maxBefore: number;
  maxBeforeWhat: string;
  /** The giant's parts while tripped and while rising; the log (and its pieces) from the impact on. */
  maxTripped: number;
  maxRising: number;
  maxLog: number;
  nan: string;
  snapped: number;
  lashes: number;
  logBroke: boolean;
  finalState: string;
  hpLost: number;
}

/** Builds the variant's obstacle, charges the giant into it, and measures to +11 s after the impact. */
async function runAC5(variant: Variant): Promise<Run> {
  await yieldToVitest();
  const h = await makeHarness({ seed: AC5.seed, size: AC5.size });
  live.push(h);
  const L = AC5.log;
  let logs: number[];
  let stakes: number[] = [];
  if (variant === 'lashed') {
    const r = buildStakedLog(h, { centre: L.centre, yaw: L.yaw, massKg: L.massKg, lengthM: L.lengthM });
    logs = [r.log];
    stakes = r.stakes;
    // Precondition: unstaged, anchored by its lashings (a blocker), at its pose.
    expect(h.ent(r.log).state).toBe('free');
    expect(h.w.entities.isAnchored(h.ent(r.log))).toBe(true);
    expect(h.ent(r.log).pose.p.y).toBeCloseTo(L.centre.y, 2);
  } else if (variant === 'anchored') {
    logs = [h.log({ mass: L.massKg, length: L.lengthM, r: L.r, p: L.centre, q: lyingAlong(L.yaw), state: 'anchored' })];
  } else {
    const half = L.lengthM / 2;
    logs = [-1, 1].map((s) =>
      h.log({ mass: L.massKg / 2, length: half, r: L.r, p: { x: L.centre.x, y: L.centre.y, z: L.centre.z + s * (half / 2 + 0.005) }, q: lyingAlong(L.yaw), state: 'anchored' }),
    );
  }
  const lashes = h.w.joints.all().filter((j) => j.kind === 'lash' && logs.some((id) => j.a.entity === id || j.b.entity === id)).map((j) => j.id);
  if (variant === 'lashed') expect(lashes).toHaveLength(2);
  for (const id of logs) expect(h.w.entities.isAnchored(h.ent(id))).toBe(true);
  // The player 30 m off, paused.
  h.standAt(AC5.playerAway);
  h.pause(h.p);
  h.ticks(30);
  await yieldToVitest();

  const g = h.creature('giantApe', AC5.giantFrom, EAST, { brain: 'off' });
  // The 14-ton ruler.
  expect(g.massKg).toBe(14_000);
  const hp0 = g.ruler ? rulerHp(g.ruler) : 0;
  const s = new BodySampler(h, g, new Set(stakes));
  const touching = (): boolean => logs.some((id) => h.w.entities.get(id) && h.w.contacts.touching({ kind: 'fighter', id: g.id, part: 'ruler' }, { kind: 'entity', id }) > 0);
  const run: Run = {
    variant,
    trip: null,
    impact: -1,
    tripTick: -1,
    rise: -1,
    up: -1,
    lastMoving: -1,
    end: -1,
    rootAtTrip: 0,
    maxPart: 0,
    maxPartWhat: '',
    maxBefore: 0,
    maxBeforeWhat: '',
    maxTripped: 0,
    maxRising: 0,
    maxLog: 0,
    nan: '',
    snapped: 0,
    lashes: lashes.length,
    logBroke: false,
    finalState: '',
    hpLost: 0,
  };
  h.ticks(2);
  h.script(g, { kind: 'charge', heading: EAST, speed: AC5.chargeMps });
  const maxTicks = Math.round(AC5.maxRunS / DT);
  for (let t = 0; t < maxTicks || run.impact > 0; t++) {
    if (t % 300 === 299) await yieldToVitest();
    const root = Math.hypot(g.walkVel.x, g.walkVel.z);
    const r = h.step();
    for (const e of r.world) {
      if (e.type === 'trip' && e.f === g && !run.trip) {
        run.trip = e;
        run.tripTick = h.w.tick;
        run.rootAtTrip = root;
      }
      if (e.type === 'rise' && e.f === g && run.rise < 0) {
        run.rise = h.w.tick;
        // "With its AI paused once it's up" (§11.5: at the rise event).
        h.pause(g);
      }
      if (e.type === 'joint' && e.what === 'snap' && lashes.includes(e.joint)) run.snapped++;
      if (e.type === 'break' && logs.includes(e.entity)) run.logBroke = true;
    }
    if (run.impact < 0 && touching()) run.impact = h.w.tick;
    if (run.rise > 0 && run.up < 0 && g.state !== 'getup') run.up = h.w.tick;
    s.sample();
    if (!run.nan) run.nan = s.nan;
    for (const f of h.w.combat.fighters) if (!run.nan && fighterNaN(f)) run.nan = `fighter ${f.id} at tick ${h.w.tick}`;
    if (run.impact < 0) {
      if (s.fastest > run.maxBefore) {
        run.maxBefore = s.fastest;
        run.maxBeforeWhat = `${s.fastestWhat} at tick ${h.w.tick} (${g.state})`;
      }
      continue;
    }
    if (s.fastest > run.maxPart) {
      run.maxPart = s.fastest;
      run.maxPartWhat = `${s.fastestWhat} at +${((h.w.tick - run.impact) * DT).toFixed(2)} s (${g.state})`;
    }
    if (s.fastest >= AC5.stillMps) run.lastMoving = h.w.tick;
    if (g.state === 'tripped') run.maxTripped = Math.max(run.maxTripped, s.ruler);
    if (g.state === 'getup') run.maxRising = Math.max(run.maxRising, s.ruler);
    run.maxLog = Math.max(run.maxLog, s.logs);
    if (h.w.tick >= run.impact + Math.round((AC5.stillWithinS + AC5.holdS) / DT)) break;
  }
  run.end = h.w.tick;
  run.finalState = g.state;
  run.hpLost = g.ruler ? hp0 - rulerHp(g.ruler) : 0;
  const at = (tick: number): string => (tick < 0 ? 'never' : `+${((tick - run.impact) * DT).toFixed(2)} s`);
  console.info(
    `[AC-5 ${variant}] impact at tick ${run.impact}; trip ${run.trip?.why ?? 'none'} ${at(run.tripTick)} (root ${run.rootAtTrip.toFixed(2)} m/s); ` +
      `rise ${at(run.rise)} (trip +${((run.rise - run.tripTick) * DT).toFixed(2)} s); up ${at(run.up)}; last part ≥ ${AC5.stillMps} m/s ${at(run.lastMoving)}; ` +
      `fastest part ${run.maxPart.toFixed(2)} m/s (${run.maxPartWhat}); giant tripped ≤ ${run.maxTripped.toFixed(2)}, rising ≤ ${run.maxRising.toFixed(2)} m/s; ` +
      `log ≤ ${run.maxLog.toFixed(2)} m/s; before the impact ≤ ${run.maxBefore.toFixed(2)} m/s (${run.maxBeforeWhat}); ` +
      `lashings snapped ${run.snapped}/${run.lashes}; log broke ${run.logBroke}; HP lost ${run.hpLost.toFixed(1)}; final ${run.finalState}; NaN ${run.nan || 'none'}`,
  );
  return run;
}

/** GATES (§11.5): the criterion, for any variant. */
function gates(r: Run): void {
  // GATE: a trip 'obstacle', on the strike, at a root speed above tripSpeed (the charge's 6 m/s).
  expect(r.trip, 'no trip').not.toBeNull();
  expect(r.trip!.why).toBe('obstacle');
  expect(r.tripTick - r.impact).toBeLessThanOrEqual(1);
  expect(r.rootAtTrip).toBeGreaterThan(RULER_BODY_TUNING.tripSpeed);
  expect(r.rootAtTrip).toBeCloseTo(AC5.chargeMps, 1);
  // GATE: the rise starts at +4.00 s after the trip, and it gets up.
  expect((r.rise - r.tripTick) * DT).toBeCloseTo(AC5.getUpAfterS, 6);
  expect(r.up).toBeGreaterThan(r.rise);
  expect(r.finalState).not.toBe('tripped');
  expect(r.finalState).not.toBe('getup');
  // GATE: no NaN in any body or fighter field at any tick.
  expect(r.nan).toBe('');
  // GATE: no body part faster than 30 m/s.
  expect(r.maxPart).toBeLessThan(AC5.maxPartMps);
  // GATE: every body below 0.05 m/s within 10 s of the impact, and still at +11 s.
  expect(r.lastMoving, 'still moving at the end of the run').toBeLessThan(r.end);
  expect((r.lastMoving - r.impact) * DT).toBeLessThan(AC5.stillWithinS);
}

describe('AC-5: the 14 t ruler charging a staked 300 kg log at shin height (§11.5)', () => {
  let lashed: Run | null = null;
  const lashedRun = async (): Promise<Run> => (lashed ??= await runAC5('lashed'));

  it('the lashed log (buildStakedLog): trips at 6 m/s, rises at +4.00 s; paused once up: no NaN, no part over 30 m/s, every body under 0.05 m/s within 10 s', async () => {
    const r = await lashedRun();
    gates(r);
    // The lashings go (each 600 J): the trip does not depend on the log surviving (legStrike).
    expect(r.snapped).toBe(2);
  }, 600_000);

  it('PINS [C lab: e5_trip] that hold: the giant ≤ 13.0 m/s tripped, the log ≤ 15.4 m/s, the rise ends at +5.57 s (94 frames)', async () => {
    const r = await lashedRun();
    expect(r.maxTripped).toBeLessThanOrEqual(PINS.trippedMps);
    expect(r.maxLog).toBeLessThanOrEqual(PINS.logFlungMps);
    // The get-up's end, within a tick of the lab's (getupFrames of RULER_BODY_TUNING after the rise).
    expect(Math.abs((r.up - r.tripTick) * DT - PINS.riseEndS)).toBeLessThanOrEqual(2 * DT + 1e-9);
  }, 600_000);

  // KNOWN DIVERGENCE (P26, reported): measured 11.87 m/s rising (the head, +4.4 s after the trip) and every body still
  // only from +6.25 s after the impact (the left forearm sweeps at up to 18.2 m/s for 0.65 s after the get-up ends, with
  // per-tick jumps). The lab measured the upright giant before P20's knuckle charge (it gets up from a different lying
  // pose now). The pins stay at the lab's values (§11: a first run doesn't rewrite pins); this turns red when they hold
  // again, and then becomes a plain `it`.
  it.fails('PINS [C lab: e5_trip] that do not hold now: the giant ≤ 8.4 m/s rising; every body < 0.05 m/s from +5.58 s', async () => {
    const r = await lashedRun();
    expect(r.maxRising).toBeLessThanOrEqual(PINS.risingMps);
    expect((r.lastMoving - r.impact) * DT).toBeLessThan(PINS.stillFromS);
  }, 600_000);

  it.each(['anchored', 'halves'] as const)('variant: the %s log, the same gates', async (v) => {
    gates(await runAC5(v));
  }, 600_000);
});
