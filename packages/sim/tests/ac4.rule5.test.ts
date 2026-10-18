// AC-4: rule 5 (SPEC:901; docs/M1-DESIGN.md §11.4, package P25).
//
// "Rule 5 holds: a scripted player hitting the free ruler's soft zones for 10 minutes with the two-handed axe's
// committed swing, as fast as the move allows and with every hit counted as a perfect counter, leaves it at full
// health; the same attacks while it's pinned add to its wound."
//
// The free half (§11.4): scene 'empty', flat, nav off. The giant (brain off and paused: no drive, idle life paused, a
// frozen stance), scale 5.5, 14 t, 12,000 HP, defense 0, with its knee spheres (§2.8). The player gets DungeonStyle's
// two-handed axe (WEAPONS.axe, give('axe2h')); its committed swing is `overhead`, the heavy button ('rpunch').
// - Placement: one deterministic search (scoutSpot) for a spot where the overhead's first touch is a knee sphere at full
//   power (the active frames, frame 26 at full stamina). The search swings in a copy of the world (loadHarness of the
//   save), so the run itself starts with a fresh player and an untouched ruler. A spot counts only if the player stands
//   still there (≤ 2 cm, on the ground) and so do its four neighbours 2 cm off, so the drift tolerance can't move it off.
//   In the run the player is put back there (a logged standAt, as a fixture move) whenever it is more than 2 cm off it
//   and free or on a swing's first frame (the overhead's own lunge carries it 0.35 m every swing): keepOnSpot.
// - "Every hit counted as a perfect counter" can't be said with a command: before every step the fixture opens a
//   2-frame counter window and sets perfectCounter (CombatSim.tickTimers clears perfectCounter without an open window,
//   so the window is needed; the press then picks the weapon's heavy move as a counter, MAP gap-6 §3e). p.stamina is
//   never touched (except in the documented negative control).
// - Two `it`s with the same gates (RT-13): mash (the literal "as fast as the move allows": 'rpunch' every tick) and
//   best-paced (press only when free with full stamina: the worst case for rule 5). 36,000 ticks, then 120 quiet.
//
// The pinned half: the giant is tripped by the AC-5 recipe (a 300 kg log lashed to two stakes the player drove, charged
// at 6 m/s), paused at the trip. Two 1,000 kg hex logs are spawned across it (perpendicular to its chest → pelvis line)
// 2 m above its top, when every collider of the ruler is below 0.05 m/s or at +2.5 s after the trip, whichever comes
// first. Their impact opens a wound and they pin it; W = ruler.downWound read when the axe hits begin. Then 20 s of the
// mashed overhead on a soft zone in reach of the lying body (the placement search re-run on the tripped rig).
//
// DEVIATION (§11.4 "across it", recorded in the ledger): the logs are centred over the lying body's highest volume and
// 1.4 m apart along it. §11.4 doesn't say where along the body; the lab's giant lay on its back, but since P20's knuckle
// charge it falls curled on its side (AC-5 saw the same change), and logs dropped over its chest and pelvis roll off its
// torso (pinned at +3.2 s, unpinned at +3.8-4.1 s, so it rises; measured in P25's scan), while logs over its highest
// part (the folded right arm and leg) stay on it across a 1.5 m wide region (P25's scan: 2 logs, 6 or 8 m, 0.8 or 1.4 m
// apart). The gates don't move.
//
// GATE / PIN marks as §11 asks. Every world is disposed (RF-24). Long loops yield to the event loop (Vitest's RPC).
import { afterAll, describe, expect, it } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { DT } from '../src/sim/math';
import { RULER_TUNING, RULER_ZONE_TUNING, type RulerVolume, rulerHp, rulerVolumes } from '../src/sim/ruler';
import { WEAPONS } from '../src/sim/weapons';
import type { WorldEvent } from '../src/world/types';
import { buildStakedLog, lyingAlong } from './support/scenes';
import { type Harness, loadHarness, makeHarness, type XZ } from './support/worldHarness';

const live: Harness[] = [];
afterAll(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

const EAST = Math.PI / 2;
/** A macrotask turn, so long synchronous stepping never starves Vitest's worker RPC. */
const yieldToVitest = (): Promise<void> => new Promise((r) => setImmediate(r));

/** §11.4's recipe constants (test constants, never tuning). */
const AC4 = {
  seed: 25,
  size: 60,
  giantAt: { x: 0, z: 0 },
  giantYaw: EAST,
  /** 10 minutes, then 2 s of quiet. */
  runTicks: 36_000,
  quietTicks: 120,
  /** The fixture's counter window (frames): ≥ 2, or tickTimers closes it before the press reads it. */
  counterFrames: 2,
  /** The player is put back on its spot when free and further off it than this. */
  driftM: 0.02,
  /** The spot must be on the ground: the player's feet within this of the terrain. */
  groundTolM: 0.05,
  /** "Full stamina" for the best-paced presses. */
  fullStamina: 0.999,
  /** The search: distances out from the target volume's centre (horizontal, away from the ruler's root), and sideways. */
  scout: { dFrom: 0.6, dTo: 3.0, dStep: 0.1, lat: [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3], neighbourM: 0.02 },
  /** The pinned half (the AC-5 trip, then the logs). */
  pin: {
    seed: 25,
    size: 80,
    log: { centre: { x: 0, y: 1.0, z: 0 }, yaw: 0, massKg: 300 as const, lengthM: 4.4 as const },
    giantFrom: { x: -20, z: 0 },
    chargeMps: 6,
    playerAway: { x: 0, z: 30 },
    pinLogKg: 1000,
    pinLogLengthM: 6,
    pinLogGapM: 1.4,
    dropM: 2,
    stillMps: 0.05,
    spawnByS: 2.5,
    pinnedByS: 4.0,
    /** The search and the attacks start once the logs have settled this long after the trip. */
    attackFromS: 6.0,
    attackS: 20,
    maxTripS: 20,
  },
} as const;

/** §11.4's pins [MAP gap-6 §3c-3d; RT lab: numbers.out]. */
const PINS = {
  hitsMash: 472,
  hitsPaced: 277,
  hitsTol: 0.05,
  maxUnhealed: 40.65 + 0.01,
  hpPerSMash: 2.89,
  hpPerSPaced: 18.91,
  hpPerSTol: 0.05,
  /** The first fresh perfect counter on a 600 J zone; a spent swing. */
  freshHp: 40.65,
  freshTol: 0.41,
  spentHp: 3.66,
  spentTol: 0.1,
  /** Negative control: stamina held at 1, mashed. */
  controlHp: 5642,
  controlTol: 0.05,
} as const;

interface HitRec {
  tick: number;
  zone: string;
  frame: number;
  E: number;
  T: number;
  hp: number;
}

const fmt = (n: number, d = 2): string => n.toFixed(d);

/**
 * "Every hit counted as a perfect counter" (§11.4): before every step, a counter window and perfectCounter, so the
 * next press starts the weapon's heavy move as a perfect counter (Fighter.startMove reads both and clears them).
 */
function perfectCounter(p: Fighter): void {
  p.counter = { kind: 'block', frames: AC4.counterFrames };
  p.perfectCounter = true;
}

function pressHeavy(h: Harness): void {
  h.w.commands.push({ tick: h.w.tick + 1, player: 1, kind: 'button', button: 'rpunch' });
}

const flatDist = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The placement fixture (§11.4: "re-placed with standAt whenever it drifts > 2 cm"): a logged standAt back onto the
 * spot when the player is more than driftM off it and either free or on the first frame of a swing (before the
 * overhead's lunge, frames 6-21). Mashed, the player is never free between two steps (the buffered press starts the
 * next swing on the tick the last one ends), so the first frame is where a mashed swing is put back; a swing is never
 * moved once under way, so each one is the move as DS plays it from the spot, lunge and all.
 */
function keepOnSpot(h: Harness, at: XZ, yaw: number): void {
  const p = h.p;
  if ((p.free || (p.state === 'attack' && p.stateFrame === 0)) && flatDist(p.pos, at) > AC4.driftM) h.standAt(at, yaw);
}

/** The yaw that faces `to` from `from` (DS: forward = (sin yaw, cos yaw)). */
const yawTo = (from: XZ, to: XZ): number => Math.atan2(to.x - from.x, to.z - from.z);

interface Spot {
  at: XZ;
  yaw: number;
  /** The volume searched around and what the first touch met there. */
  target: string;
  first: HitRec;
  trials: number;
}

interface Trial {
  ok: boolean;
  why: string;
  first: HitRec | null;
}

/**
 * One swing from `at` in the scout world: stand there facing the ruler's root (what the lock-on turns to), wait until
 * free with full stamina, then one perfect-counter overhead. ok: the player stood still on the ground there and the
 * swing's first contact was a hit at full power (the move's active frames) on a zone `accept` takes.
 */
function trial(s: Harness, g: Fighter, at: XZ, accept: (h: HitRec) => boolean): Trial {
  const p = s.p;
  const yaw = yawTo(at, g.pos);
  s.standAt(at, yaw);
  s.step();
  for (let t = 0; t < 900 && !(p.free && p.stamina >= AC4.fullStamina); t++) s.step();
  if (!p.free) return { ok: false, why: 'not free', first: null };
  if (flatDist(p.pos, at) > AC4.driftM) return { ok: false, why: `drift ${fmt(flatDist(p.pos, at), 3)}`, first: null };
  if (Math.abs(p.pos.y - s.w.terrain.heightAt(p.pos.x, p.pos.z)) > AC4.groundTolM) return { ok: false, why: 'off the ground', first: null };
  pressHeavy(s);
  let first: HitRec | null = null;
  let bumpFirst = false;
  let started = false;
  let full = false;
  for (let t = 0; t < 300; t++) {
    keepOnSpot(s, at, yaw);
    perfectCounter(p);
    const r = s.step();
    if (!p.free) started = true;
    for (const e of r.combat) {
      if (first || bumpFirst) continue;
      if (e.type === 'bump' && e.attacker === p) bumpFirst = true;
      if (e.type === 'hit' && e.attacker === p && e.defender === g) {
        const m = p.move;
        full = !!m && p.stateFrame >= m.startup && p.stateFrame < m.startup + m.active;
        first = { tick: s.w.tick, zone: e.rulerZone ?? '?', frame: p.stateFrame, E: e.energy ?? 0, T: e.toughness ?? 0, hp: e.damage };
      }
    }
    if (started && p.free) break;
  }
  if (!first) return { ok: false, why: 'miss', first: null };
  if (!full) return { ok: false, why: `not full power (frame ${first.frame})`, first };
  if (!accept(first)) return { ok: false, why: `zone ${first.zone}`, first };
  return { ok: true, why: '', first };
}

/**
 * The placement search (§11.4): in `s`, a copy of the world the run is in (its save loaded, or the same scene built
 * again: the sim is deterministic), disposed here; for each target volume in order, spots out
 * from the volume's centre on the side away from the ruler's root (d ascending), then sideways (lat order); the first
 * spot whose trial passes and whose four neighbours (±2 cm along and across) pass too. Deterministic: a pure function of
 * the world's state.
 */
async function scoutSpot(s: Harness, g: Fighter, targets: RulerVolume[], accept: (x: HitRec) => boolean): Promise<Spot> {
  if (!live.includes(s)) live.push(s);
  try {
    const sg = s.w.combat.fighters.find((f) => f.id === g.id);
    if (!sg) throw new Error('scout: the ruler is not in the copy');
    if (s.p.weapon !== WEAPONS.axe) throw new Error('scout: the copy lost the axe');
    const S = AC4.scout;
    let trials = 0;
    const misses: string[] = [];
    for (const v of targets) {
      const c = { x: v.center.x, z: v.center.z };
      const away = flatDist(c, g.pos);
      const u = away > 1e-6 ? { x: (c.x - g.pos.x) / away, z: (c.z - g.pos.z) / away } : { x: 1, z: 0 };
      const side = { x: -u.z, z: u.x };
      const label = `${v.bone}${v.joint ? ` ${v.joint}` : ''}`;
      for (let d = S.dFrom; d <= S.dTo + 1e-9; d += S.dStep) {
        for (const lat of S.lat) {
          await yieldToVitest();
          const at = { x: c.x + u.x * d + side.x * lat, z: c.z + u.z * d + side.z * lat };
          trials++;
          const t0 = trial(s, sg, at, accept);
          if (!t0.ok) {
            if (t0.first) misses.push(`${label} d ${fmt(d)} lat ${lat}: ${t0.why}`);
            continue;
          }
          const n = S.neighbourM;
          const around = [
            { x: at.x + u.x * n, z: at.z + u.z * n },
            { x: at.x - u.x * n, z: at.z - u.z * n },
            { x: at.x + side.x * n, z: at.z + side.z * n },
            { x: at.x - side.x * n, z: at.z - side.z * n },
          ];
          let all = true;
          for (const q of around) {
            trials++;
            const tn = trial(s, sg, q, accept);
            if (!tn.ok) {
              all = false;
              misses.push(`${label} d ${fmt(d)} lat ${lat}: neighbour ${tn.why}`);
              break;
            }
          }
          if (!all) continue;
          return { at, yaw: yawTo(at, g.pos), target: `${label} d ${fmt(d)} lat ${lat}`, first: t0.first!, trials };
        }
      }
    }
    throw new Error(`scout: no spot after ${trials} trials (${misses.slice(0, 12).join('; ')})`);
  } finally {
    s.w.dispose();
    live.splice(live.indexOf(s), 1);
  }
}

// ---------------------------------------------------------------------------
// The free half
// ---------------------------------------------------------------------------

type Mode = 'mash' | 'paced' | 'control';

interface FreeRun {
  mode: Mode;
  spot: Spot;
  hits: HitRec[];
  bumps: number;
  kneeHits: number;
  woundEvents: number;
  wounds: number;
  hpEnd: number;
  hpMin: number;
  hpMinTick: number;
  maxUnhealed: number;
  /** rulerHp each minute (and at the end of the quiet). */
  hpByMinute: number[];
  standAts: number;
  grossHpPerS: number;
  /** The rate over the second five minutes (stamina long since settled: a mashed swing spent, a paced one fresh). */
  steadyHpPerS: number;
  stateEnd: string;
}

/** The free scene: the giant spawned, brain off, paused; the axe in the player's hands. */
async function freeScene(): Promise<{ h: Harness; g: Fighter }> {
  const h = await makeHarness({ seed: AC4.seed, size: AC4.size });
  live.push(h);
  const g = h.creature('giantApe', AC4.giantAt, AC4.giantYaw, { brain: 'off' });
  h.pause(g);
  h.give('axe2h');
  h.ticks(60);
  return { h, g };
}

const kneesOnly = (x: HitRec): boolean => x.zone === 'knees';

let freeSpot: Promise<Spot> | null = null;
/** The placement search on the free giant: once (every free run builds the same world, so it finds the same spot). */
function freeSpotOf(h: Harness, g: Fighter): Promise<Spot> {
  return (freeSpot ??= loadHarness(h.saveBytes()).then((copy) =>
    scoutSpot(
      copy,
      g,
      rulerVolumes(g).filter((v) => v.joint === 'knee'),
      kneesOnly,
    ),
  ));
}

async function runFree(mode: Mode): Promise<FreeRun> {
  await yieldToVitest();
  const { h, g } = await freeScene();
  const p = h.p;
  const r = g.ruler!;
  // Preconditions: the 14 t, 12,000 HP ruler at scale 5.5, defense 0; the DS axe; nothing yet done to it.
  expect(g.massKg).toBe(14_000);
  expect(g.scale).toBe(5.5);
  expect(r.maxHp).toBe(12_000);
  expect(g.stats.defense).toBe(0);
  expect(p.weapon).toBe(WEAPONS.axe);
  expect(rulerHp(r)).toBe(12_000);
  const spot = await freeSpotOf(h, g);
  const run: FreeRun = {
    mode,
    spot,
    hits: [],
    bumps: 0,
    kneeHits: 0,
    woundEvents: 0,
    wounds: 0,
    hpEnd: 0,
    hpMin: Infinity,
    hpMinTick: -1,
    maxUnhealed: 0,
    hpByMinute: [],
    standAts: 0,
    grossHpPerS: 0,
    steadyHpPerS: 0,
    stateEnd: '',
  };
  const standAts0 = h.fixtures.filter((f) => f.op === 'standAt').length;
  h.standAt(spot.at, spot.yaw);
  h.step();
  const start = h.w.tick;
  const total = AC4.runTicks + AC4.quietTicks;
  for (let t = 0; t < total; t++) {
    if (t % 300 === 299) await yieldToVitest();
    const attacking = t < AC4.runTicks;
    keepOnSpot(h, spot.at, spot.yaw);
    perfectCounter(p);
    // The negative control (§11.4, RR-24): stamina held at 1, the only place this file writes it.
    if (mode === 'control') p.stamina = 1;
    if (attacking && (mode !== 'paced' || (p.free && p.stamina >= AC4.fullStamina))) pressHeavy(h);
    const res = h.step();
    for (const e of res.combat) {
      if (e.type === 'hit' && e.attacker === p && e.defender === g) {
        run.hits.push({ tick: h.w.tick - start, zone: e.rulerZone ?? '?', frame: p.stateFrame, E: e.energy ?? 0, T: e.toughness ?? 0, hp: e.damage });
        if (e.rulerZone === 'knees') run.kneeHits++;
      }
      if (e.type === 'bump' && e.attacker === p) run.bumps++;
    }
    for (const e of res.world) if (e.type === 'wound' && e.ruler === g) run.woundEvents++;
    const hp = rulerHp(r);
    if (hp < run.hpMin) {
      run.hpMin = hp;
      run.hpMinTick = h.w.tick - start;
    }
    run.maxUnhealed = Math.max(run.maxUnhealed, r.unhealed);
    if ((t + 1) % 3600 === 0) run.hpByMinute.push(hp);
  }
  run.hpEnd = rulerHp(r);
  run.hpByMinute.push(run.hpEnd);
  run.wounds = r.wounds.length;
  run.standAts = h.fixtures.filter((f) => f.op === 'standAt').length - standAts0;
  run.grossHpPerS = run.hits.reduce((a, x) => a + x.hp, 0) / (AC4.runTicks * DT);
  const half = AC4.runTicks / 2;
  run.steadyHpPerS = run.hits.filter((x) => x.tick > half && x.tick <= AC4.runTicks).reduce((a, x) => a + x.hp, 0) / (half * DT);
  run.stateEnd = g.state;
  const zones = new Map<string, number>();
  for (const x of run.hits) zones.set(x.zone, (zones.get(x.zone) ?? 0) + 1);
  console.info(
    `[AC-4 free ${mode}] spot (${fmt(spot.at.x, 3)}, ${fmt(spot.at.z, 3)}) yaw ${fmt(spot.yaw, 3)} (${spot.target}; first touch ${spot.first.zone} frame ${spot.first.frame} ` +
      `E ${fmt(spot.first.E, 1)} J on ${spot.first.T} J, ${fmt(spot.first.hp)} HP; ${spot.trials} trials); ` +
      `hits ${run.hits.length} (knees ${run.kneeHits}; by zone ${[...zones].map(([z, n]) => `${z} ${n}`).join(', ')}), bumps ${run.bumps}; ` +
      `gross ${fmt(run.grossHpPerS)} HP/s (minutes 5-10: ${fmt(run.steadyHpPerS)} HP/s) vs recovery ${RULER_TUNING.recoveryHpPerS} HP/s; max unhealed ${fmt(run.maxUnhealed, 4)}; ` +
      `HP min ${fmt(run.hpMin, 4)} at +${fmt(run.hpMinTick * DT)} s; HP each minute ${run.hpByMinute.map((x) => fmt(x, 1)).join(' ')}; ` +
      `end ${run.hpEnd} (${run.stateEnd}); wounds ${run.wounds} (events ${run.woundEvents}); standAts ${run.standAts}`,
  );
  // Every hit's zone, frame, E and HP (§11.4): tick:zone:frame:E:HP.
  for (let i = 0; i < run.hits.length; i += 40) {
    console.info(
      `[AC-4 free ${mode}] hits ${i + 1}-${Math.min(run.hits.length, i + 40)}: ` +
        run.hits.slice(i, i + 40).map((x) => `${x.tick}:${x.zone}:${x.frame}:${fmt(x.E, 1)}:${fmt(x.hp, 3)}`).join(' '),
    );
  }
  return run;
}

/** GATES (§11.4, free ruler, D-5). */
function freeGates(r: FreeRun): void {
  // GATE: the soft zone is struck, often: ≥ 200 knee hits.
  expect(r.kneeHits).toBeGreaterThanOrEqual(200);
  // GATE: no wound.
  expect(r.woundEvents).toBe(0);
  expect(r.wounds).toBe(0);
  // GATE: full health at the end, exactly.
  expect(r.hpEnd).toBe(12_000);
}

describe('AC-4: rule 5 on the free ruler (§11.4)', () => {
  it('mash ("as fast as the move allows"): 10 min of perfect-counter overheads on a knee leave it at full health, no wound', async () => {
    const r = await runFree('mash');
    freeGates(r);
    // PIN [MAP gap-6 §3c-3d; RT lab: numbers.out]: the largest unhealed is one fresh perfect counter (40.65 HP).
    expect(r.maxUnhealed).toBeLessThanOrEqual(PINS.maxUnhealed);
    // PIN: 472 hits, 2.89 HP/s (±5 %). INTERPRETATION: 2.89 HP/s is the spent mash's rate (3.66 HP every 76 ticks), so
    // it is read over minutes 5-10; over all 10 minutes the first ~13 swings, before stamina is spent, lift it to
    // ≈ 3.25 HP/s (logged).
    expect(Math.abs(r.hits.length / PINS.hitsMash - 1)).toBeLessThanOrEqual(PINS.hitsTol);
    expect(Math.abs(r.steadyHpPerS / PINS.hpPerSMash - 1)).toBeLessThanOrEqual(PINS.hpPerSTol);
  }, 900_000);

  it('best-paced (press only when free with full stamina, the worst case): full health at the end, no wound', async () => {
    const r = await runFree('paced');
    freeGates(r);
    // PIN: max unhealed 40.65 HP; 277 hits, 18.91 HP/s (±5 %), under 30 HP/s recovery.
    expect(r.maxUnhealed).toBeLessThanOrEqual(PINS.maxUnhealed);
    expect(Math.abs(r.hits.length / PINS.hitsPaced - 1)).toBeLessThanOrEqual(PINS.hitsTol);
    expect(Math.abs(r.grossHpPerS / PINS.hpPerSPaced - 1)).toBeLessThanOrEqual(PINS.hpPerSTol);
    expect(r.grossHpPerS).toBeLessThan(RULER_TUNING.recoveryHpPerS);
  }, 900_000);

  // The documented negative control (§11.4, RR-24): with stamina held at 1 (a fresh swing every time, which no player
  // can do), the same mash wears the free ruler down. SPEC:303's margin rests on DungeonStyle's stamina (§9.3).
  it('negative control: stamina held at 1, the mash leaves the ruler well short of full health (≈ 5,642 HP)', async () => {
    const r = await runFree('control');
    // GATE (of the control): the criterion would fail without stamina pacing.
    expect(r.hpEnd).toBeLessThan(12_000);
    expect(r.woundEvents).toBe(0);
    // PIN: 5,642 HP left (±5 %).
    expect(Math.abs(r.hpEnd / PINS.controlHp - 1)).toBeLessThanOrEqual(PINS.controlTol);
  }, 900_000);
});

// ---------------------------------------------------------------------------
// The pinned half
// ---------------------------------------------------------------------------

interface PinRun {
  tripTick: number;
  tripWhy: string;
  tripWounds: number;
  spawnS: number;
  spawnStill: boolean;
  logs: number[];
  pinnedOnS: number;
  pinnedOffS: number;
  trippedAt4: boolean;
  W: { id: number; zone: string; bone: string; hp0: number; hp1: number; cause: string } | null;
  spot: Spot;
  axeHits: HitRec[];
  impacts: { tick: number; hp: number; zone: string }[];
  /** Damage events in the window that opened no wound: their HP summed in event order. */
  finishingSum: number;
  openedInWindow: number;
  bigEvents: number;
  pinnedThroughout: boolean;
  trippedThroughout: boolean;
  unhealedFell: string;
  unhealed0: number;
  unhealed1: number;
  hp0: number;
  hp1: number;
}

let pinRun: Promise<PinRun> | null = null;

interface PinScene {
  h: Harness;
  g: Fighter;
  trip: Extract<WorldEvent, { type: 'trip' }>;
  tripTick: number;
  spawnTick: number;
  spawnStill: boolean;
  pinnedOn: number;
  pinnedOff: number;
  trippedAt4: boolean;
  logs: number[];
}

/** The AC-5 trip, then the pinning logs, stepped to attackFromS after the trip. Deterministic (built twice: run, scout). */
async function pinnedScene(): Promise<PinScene> {
  await yieldToVitest();
  const P = AC4.pin;
  const h = await makeHarness({ seed: P.seed, size: P.size });
  live.push(h);
  // The AC-5 recipe (P23's buildStakedLog), the player 30 m off with the axe.
  buildStakedLog(h, { centre: P.log.centre, yaw: P.log.yaw, massKg: P.log.massKg, lengthM: P.log.lengthM });
  h.give('axe2h');
  h.standAt(P.playerAway);
  h.ticks(30);
  await yieldToVitest();
  const g = h.creature('giantApe', P.giantFrom, EAST, { brain: 'off' });
  h.ticks(2);
  h.script(g, { kind: 'charge', heading: EAST, speed: P.chargeMps });
  let trip: Extract<WorldEvent, { type: 'trip' }> | null = null;
  let tripTick = -1;
  let spawnTick = -1;
  let spawnStill = false;
  let pinnedOn = -1;
  let pinnedOff = -1;
  let trippedAt4 = false;
  const logs: number[] = [];
  const maxTicks = Math.round(P.maxTripS / DT);
  const owner = { kind: 'fighter' as const, id: g.id, part: 'ruler' as const };
  /** Every collider of the ruler below stillMps (point velocity of its dynamic body). */
  const rulerStill = (): boolean => {
    let still = true;
    h.w.physics.rapier.forEachRigidBody((b) => {
      if (!b.isDynamic()) return;
      const v = b.linvel();
      const om = b.angvel();
      const com = b.worldCom();
      for (let i = 0; i < b.numColliders(); i++) {
        const c = b.collider(i);
        const o = h.w.physics.ownerOf(c.handle);
        if (!(o?.kind === 'fighter' && o.id === owner.id)) continue;
        const t = c.translation();
        const rx = t.x - com.x;
        const ry = t.y - com.y;
        const rz = t.z - com.z;
        if (Math.hypot(v.x + om.y * rz - om.z * ry, v.y + om.z * rx - om.x * rz, v.z + om.x * ry - om.y * rx) >= P.stillMps) still = false;
      }
    });
    return still;
  };
  for (let t = 0; t < maxTicks; t++) {
    if (t % 300 === 299) await yieldToVitest();
    const res = h.step();
    for (const e of res.world) {
      if (e.type === 'trip' && e.f === g && !trip) {
        trip = e;
        tripTick = h.w.tick;
        // Its AI paused from the trip on: nothing but the body moves it.
        h.pause(g);
      }
      if (e.type === 'pinned' && e.f === g) {
        if (e.on && pinnedOn < 0) pinnedOn = h.w.tick;
        if (!e.on && pinnedOff < 0) pinnedOff = h.w.tick;
      }
    }
    if (tripTick < 0) continue;
    const since = h.w.tick - tripTick;
    if (spawnTick < 0 && since >= 1) {
      const still = rulerStill();
      if (still || since * DT >= P.spawnByS - 1e-9) {
        spawnTick = h.w.tick;
        spawnStill = still;
        // Across the lying body (perpendicular to its chest → pelvis line), centred over its highest volume, 1.4 m
        // apart along the body, 2 m above its top (see DEVIATION in the header).
        let top = -Infinity;
        let topAt: XZ = { x: g.pos.x, z: g.pos.z };
        for (const v of rulerVolumes(g)) {
          if (v.center.y + v.r > top) {
            top = v.center.y + v.r;
            topAt = { x: v.center.x, z: v.center.z };
          }
        }
        const a = g.rig.chest.pos;
        const b = g.rig.pelvis.pos;
        const along = Math.atan2(a.x - b.x, a.z - b.z);
        const u = { x: Math.sin(along), z: Math.cos(along) };
        const q = lyingAlong(along + Math.PI / 2);
        for (const s of [-1, 1]) {
          logs.push(
            h.log({
              mass: P.pinLogKg,
              length: P.pinLogLengthM,
              r: 0.4,
              p: { x: topAt.x + (s * u.x * P.pinLogGapM) / 2, y: top + P.dropM, z: topAt.z + (s * u.z * P.pinLogGapM) / 2 },
              q,
            }),
          );
        }
      }
    }
    if (since === Math.round(P.pinnedByS / DT) + 1) trippedAt4 = g.state === 'tripped';
    if (since >= Math.round(P.attackFromS / DT)) break;
  }
  if (!trip) throw new Error('AC-4 pinned: the giant never tripped');
  return { h, g, trip, tripTick, spawnTick, spawnStill, pinnedOn, pinnedOff, trippedAt4, logs };
}

async function runPinned(): Promise<PinRun> {
  const P = AC4.pin;
  const { h, g, trip, tripTick, spawnTick, spawnStill, pinnedOn, pinnedOff, trippedAt4, logs } = await pinnedScene();
  const r = g.ruler!;
  const p = h.p;
  const tS = (tick: number): number => (tick < 0 ? NaN : (tick - tripTick) * DT);
  const tripWounds = h.history.world.filter((e) => e.type === 'wound' && e.ruler === g && e.wound.tick <= tripTick).length;

  // The placement search on the tripped, pinned rig: soft volumes in reach (knees, elbows, the head for its eyes).
  const soft = (x: HitRec): boolean => x.T === RULER_ZONE_TUNING.softJ;
  const targets = rulerVolumes(g).filter((v) => v.joint !== null || v.bone === 'head');
  // Why the copy isn't a loaded save (reported): the pinned ruler's body and the logs on it sleep, and an entity's sleep
  // isn't in its save record, so a load wakes the logs against a sleeping ruler and PhysicsWorld.refreshQueries throws.
  const asleep: string[] = [];
  h.w.physics.rapier.forEachRigidBody((b) => {
    const o = b.numColliders() ? h.w.physics.ownerOf(b.collider(0).handle) : null;
    if ((o?.kind === 'fighter' && o.id === g.id) || (o?.kind === 'entity' && logs.includes(o.id))) asleep.push(`${o.kind === 'entity' ? `log ${o.id}` : 'ruler'} ${b.isSleeping() ? 'asleep' : 'awake'}`);
  });
  console.info(`[AC-4 pinned] at +${fmt(AC4.pin.attackFromS)} s: ${asleep.join(', ')}`);
  // The copy: the same scene built again (a save of the pinned ruler doesn't load: see the report of P25).
  const copy = await pinnedScene();
  if (copy.h.w.tick !== h.w.tick || copy.g.rig.chest.pos.distanceTo(g.rig.chest.pos) !== 0) throw new Error('AC-4 pinned: the rebuilt scene differs');
  const spot = await scoutSpot(copy.h, copy.g, targets, soft);

  // The attacks: W read when they begin.
  h.standAt(spot.at, spot.yaw);
  h.step();
  const W = r.downWound === null ? null : (r.wounds.find((x) => x.id === r.downWound) ?? null);
  const run: PinRun = {
    tripTick,
    tripWhy: trip.why,
    tripWounds,
    spawnS: tS(spawnTick),
    spawnStill,
    logs,
    pinnedOnS: tS(pinnedOn),
    pinnedOffS: tS(pinnedOff),
    trippedAt4,
    W: W ? { id: W.id, zone: W.zone, bone: W.bone, hp0: W.hp, hp1: W.hp, cause: JSON.stringify(W.cause) } : null,
    spot,
    axeHits: [],
    impacts: [],
    finishingSum: 0,
    openedInWindow: 0,
    bigEvents: 0,
    pinnedThroughout: true,
    trippedThroughout: true,
    unhealedFell: '',
    unhealed0: r.unhealed,
    unhealed1: r.unhealed,
    hp0: rulerHp(r),
    hp1: 0,
  };
  const woundAt = RULER_TUNING.woundFrac * r.maxHp;
  const start = h.w.tick;
  const n = Math.round(P.attackS / DT);
  let prevUnhealed = r.unhealed;
  let prevPinned = r.pinned;
  for (let t = 0; t < n; t++) {
    if (t % 300 === 299) await yieldToVitest();
    keepOnSpot(h, spot.at, spot.yaw);
    perfectCounter(p);
    pressHeavy(h);
    const res = h.step();
    const damage = (hp: number): void => {
      if (!(hp > 0)) return;
      if (hp > woundAt) run.bigEvents++;
      else run.finishingSum += hp;
    };
    for (const e of res.combat) {
      if (e.type === 'hit' && e.defender === g) {
        if (e.attacker === p) run.axeHits.push({ tick: h.w.tick - start, zone: e.rulerZone ?? '?', frame: p.stateFrame, E: e.energy ?? 0, T: e.toughness ?? 0, hp: e.damage });
        damage(e.damage);
      }
    }
    for (const e of res.world) {
      if (e.type === 'impact' && e.defender === g) {
        run.impacts.push({ tick: h.w.tick - start, hp: e.damage, zone: e.rulerZone ?? '?' });
        damage(e.damage);
      }
      if (e.type === 'wound' && e.ruler === g) run.openedInWindow++;
    }
    if (!r.pinned) run.pinnedThroughout = false;
    if (g.state !== 'tripped') run.trippedThroughout = false;
    if (prevPinned && r.pinned && r.unhealed < prevUnhealed && !run.unhealedFell) run.unhealedFell = `${fmt(prevUnhealed, 4)} → ${fmt(r.unhealed, 4)} at +${fmt((h.w.tick - start) * DT)} s`;
    prevUnhealed = r.unhealed;
    prevPinned = r.pinned;
  }
  if (run.W) run.W.hp1 = r.wounds.find((x) => x.id === run.W!.id)?.hp ?? NaN;
  run.unhealed1 = r.unhealed;
  run.hp1 = rulerHp(r);
  const axeHp = run.axeHits.reduce((a, x) => a + x.hp, 0);
  console.info(
    `[AC-4 pinned] trip ${run.tripWhy} at tick ${tripTick} (wounds by then ${tripWounds}); logs ${logs.join(', ')} spawned at +${fmt(run.spawnS)} s ` +
      `(${run.spawnStill ? 'every collider still' : 'the +2.5 s mark'}); pinned on +${fmt(run.pinnedOnS)} s, off ${Number.isNaN(run.pinnedOffS) ? 'never' : `+${fmt(run.pinnedOffS)} s`}; ` +
      `tripped past +4 s ${run.trippedAt4}; W ${run.W ? `${run.W.id} (${run.W.zone} on ${run.W.bone}, ${fmt(run.W.hp0, 2)} → ${fmt(run.W.hp1, 4)} HP; cause ${run.W.cause})` : 'none'}; ` +
      `spot (${fmt(spot.at.x, 3)}, ${fmt(spot.at.z, 3)}) yaw ${fmt(spot.yaw, 3)} (${spot.target}; first touch ${spot.first.zone} frame ${spot.first.frame} E ${fmt(spot.first.E, 1)} J, ${spot.trials} trials); ` +
      `axe hits ${run.axeHits.length} (${fmt(axeHp, 4)} HP; soft ${run.axeHits.filter((x) => x.T === RULER_ZONE_TUNING.softJ).length}); impacts ${run.impacts.length} (${fmt(run.impacts.reduce((a, x) => a + x.hp, 0), 4)} HP); ` +
      `finishing sum ${fmt(run.finishingSum, 6)} HP; wound-sized events ${run.bigEvents}; wounds opened ${run.openedInWindow}; pinned throughout ${run.pinnedThroughout}; ` +
      `tripped throughout ${run.trippedThroughout}; unhealed ${fmt(run.unhealed0, 4)} → ${fmt(run.unhealed1, 4)}${run.unhealedFell ? ` (fell: ${run.unhealedFell})` : ''}; HP ${fmt(run.hp0, 2)} → ${fmt(run.hp1, 2)}`,
  );
  console.info(`[AC-4 pinned] axe hits (tick:zone:frame:E:HP): ${run.axeHits.map((x) => `${x.tick}:${x.zone}:${x.frame}:${fmt(x.E, 1)}:${fmt(x.hp, 3)}`).join(' ')}`);
  return run;
}

describe('AC-4: the same attacks while the ruler is pinned add to its wound (§11.4)', () => {
  const pinned = (): Promise<PinRun> => (pinRun ??= runPinned());

  it('tripped by the AC-5 recipe, pinned by two 1,000 kg logs before +4 s; it stays down', async () => {
    const r = await pinned();
    // The trip (the AC-5 recipe) opens no wound.
    expect(r.tripWhy).toBe('obstacle');
    expect(r.tripWounds).toBe(0);
    // GATE: pinned turns on before +4.0 s, and the ruler is still tripped past +4 s.
    expect(r.pinnedOnS).toBeGreaterThan(0);
    expect(r.pinnedOnS).toBeLessThan(AC4.pin.pinnedByS);
    expect(r.trippedAt4).toBe(true);
    // GATE: the logs' impact opened a wound, and it is the down wound when the axe hits begin.
    expect(r.W).not.toBeNull();
  }, 900_000);

  it('20 s of mashed perfect-counter overheads on a soft zone of the pinned ruler: every HP goes into its wound', async () => {
    const r = await pinned();
    expect(r.W).not.toBeNull();
    // GATE ("while it's pinned"): pinned and down for the whole 20 s.
    expect(r.pinnedThroughout).toBe(true);
    expect(r.trippedThroughout).toBe(true);
    // GATE: at least one axe hit with HP > 0.
    expect(r.axeHits.some((x) => x.hp > 0)).toBe(true);
    // GATE: W grew by exactly the sum of HP of every damage event on the ruler in the 20 s that opened no wound.
    expect(r.openedInWindow).toBe(r.bigEvents);
    expect(r.W!.hp1 - r.W!.hp0).toBeCloseTo(r.finishingSum, 6);
    expect(r.W!.hp1).toBeGreaterThan(r.W!.hp0);
    // GATE: unhealed never fell while pinned (nothing recovers).
    expect(r.unhealedFell).toBe('');
    // PINS [MAP gap-6; RT lab: numbers.out]: the first fresh perfect counter on a 600 J zone is 40.65 HP, then 3.66 HP a
    // hit once stamina is spent; armoured surfaces (and any blow that doesn't beat its zone) add 0.
    const soft = r.axeHits.filter((x) => x.T === RULER_ZONE_TUNING.softJ);
    expect(soft.length).toBeGreaterThan(0);
    expect(Math.abs(soft[0].hp - PINS.freshHp)).toBeLessThanOrEqual(PINS.freshTol);
    expect(Math.abs(soft[soft.length - 1].hp - PINS.spentHp)).toBeLessThanOrEqual(PINS.spentTol);
    for (const x of r.axeHits) if (x.E <= x.T) expect(x.hp).toBe(0);
  }, 900_000);
});
