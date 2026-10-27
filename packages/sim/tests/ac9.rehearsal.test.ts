// AC-9 rehearsal (non-gating; docs/M1-DESIGN.md §11.9, §4.15, RT-12; package P39).
//
// A headless stand-in for SPEC:906's playtest ("an environmental kill on an ape within 10 minutes"), run before P38's
// human playtest. World: `scene 'clearing'` (seed S, nav 'full'), the ape of home A with its brain on. A scripted
// player, driven by commands only, works in three phases, each a step with a tick budget and a human-readable reason
// when it fails:
// 1. approach: walks to the starter cache, takes the stone axe (a `take` verb), and walks toward home A until the ape
//    notices him (what he can see: the ape coming at him, or the ape within arm's reach);
// 2. brawl: DungeonStyle's moves with the stone axe (Q slash, E chop) and kicks until the ape is at ≤ 20 HP (its HP
//    bar, which the HUD shows while locked on, §10.8);
// 3. finish: with the world, never a blow: an ordered list of finishing options (FINISHES), the first that applies
//    tried until it lands or gives up:
//    a. `snag`: knock the ape into home A's snag (sharpness 0.45, §6.7) with a push kick, the ape between him and the
//       snag;
//    b. `log`: if the ape keeps fleeing, carry a 40 kg rotten log (the damp grove's, §6.7) to it and drop it on it when
//       it is down.
// It must reach `ko { environmental: true }` (combat event) within 36,000 ticks (10 min).
//
// Quest-bot principles (docs/work/warded-advice.md "P39", from WardedMMO's tools/sim-cli quest bot):
// - commands only (move, button, verb), decided from what a player could see: positions, the ape's HP bar, his own HP
//   and stamina, who is down; the mind's state is logged in the trace, never read by a decision;
// - deterministic per seed (no clock, no Math.random: every choice is a function of the world's state and the tick);
// - the player never dies on purpose; no dev command tops HP up (devOps has none: respawnPlayer is a respawn), so falls
//   (knockdowns), deaths and respawns are counted; after a respawn he starts over from the approach;
// - a stuck test once a second while walking somewhere (< 1 m moved: stuck += 60 ticks); over 120 a sidestep of 3 m at
//   the angle (tick·0.618 mod 2π) for up to a second; over 240 a replan (the phase picks another way);
// - a trace once a second (distance, both HPs, postures, states).
//
// Rule 1: the script moves only the player (and the ape's own mind moves the ape); it never places harm or decides an
// outcome. No staging, no fixture op: the Clearing as generated, the player's commands, the sim.
//
// Not part of `npm test` (vitest.config.ts excludes `*.rehearsal.test.ts` unless ROTW_REHEARSAL=1): run it with
// `npm run test:rehearsal`. ROTW_AC9_SEEDS=1,2 picks the seeds; ROTW_AC9_TRACE=1 prints every run's trace (the
// summary always prints). A run that misses the 36,000 ticks fails the test (it is the rehearsal's verdict), and its
// risk and lever proposal go to docs/work/ledger.md (§11.9: the owner decides levers; the test never pulls one).
// ROTW_AC9_PROBE_ZONE=1 is a probe for that proposal, off by default: the run starts with a logged `meta 'dev'
// setTuning` of §4.15 lever 1 (SPECIES_BODY.ape.massShareMode 'zone'), so its effect can be measured, not adopted.
//
// The world's other creatures (homes B and C's apes, the giant) have their minds paused by `meta 'dev' pauseMinds`
// commands at the first tick: §11.9's "the ape of home A with its brain on".
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CombatEvent } from '../src/sim/combat';
import { type Button, type Fighter } from '../src/sim/fighter';
import { moveCommand, MOVE_SPRINT, type Command, type VerbCommand } from '../src/sim/commands';
import type { Entity, Quat, V3 } from '../src/world/types';
import { type Harness, makeHarness, type XZ } from './support/worldHarness';
import { yieldToVitest } from './support/yieldToVitest';

vi.setConfig({ testTimeout: 7_200_000 });

// ---------------------------------------------------------------------------
// The scripted player's habits: test constants (no rule reads them; they only decide what he does), never tuning.
// ---------------------------------------------------------------------------

const AC9 = {
  /** SPEC:906: 10 minutes. */
  maxTicks: 36_000,
  /** Phase budgets (ticks), each from the phase's start; the whole run is capped by maxTicks. */
  budget: { approach: 60 * 120, brawl: 60 * 360, finish: 36_000 },
  /** The default seeds (5-10, warded-advice "P39"). */
  seeds: [1, 2, 3, 4, 5, 6, 7, 8],
  /** The ape has noticed him: within this distance, or closing on him this fast (m/s, over half a second). */
  noticeM: 4.5,
  noticeClosingMps: 1.2,
  noticeWithinM: 30,
  /**
   * The brawl ends at this HP (§11.9). The axe's cuts bleed for good (DS wounds keep a bleeding floor, combat.ts
   * bleed()), and a bleed-out is no environmental kill, so he cuts only while the ape is above axeUntilHp, then stows
   * the axe on his back and goes on with fists and feet; below gentleHp only the jab (the lightest blow, ≈ 2 HP), so
   * the brawl stops close under 20 and the finish's flying kick (≈ 12 HP) leaves the most for the world to take.
   */
  stopHp: 20,
  axeUntilHp: 87,
  gentleHp: 26,
  /** Strikes start within this (centre to centre, m); he closes in beyond it. Jabs: within jabM (select.ts PUNCH_RANGE 1.3). */
  strikeM: 1.6,
  jabM: 1.2,
  /** A strike is pressed only with this much stamina (0..1). */
  minStamina: 0.2,
  /** The brawl's patterns: armed E (chop), Q (slash), push kick; unarmed jab, cross, push kick; gentle: jabs. */
  axe: ['rpunch', 'lpunch', 'lkick'] as Button[],
  fists: ['lpunch', 'rpunch', 'lkick'] as Button[],
  gentle: ['lpunch'] as Button[],
  /** He never walks into the ape: a goal behind it is skirted at this distance (m). */
  skirtM: 1.3,
  /** Stuck test (once a second): less than stuckMoveM moved adds 60; sidestep over sidestepAt, replan over replanAt. */
  stuckMoveM: 1.0,
  sidestepAt: 120,
  replanAt: 240,
  sidestepM: 3,
  /**
   * Snag finish (m across the snag's axis, on a side): the approach waits for the ape standM out in front of a point on
   * the side with more points; the finish crosses to waitM out on the side away from the ape, and flying-kicks it when
   * it stands in apeBandM between him and the snag, he is kickM away (the flying kick's 1.8-4.1 m, select.ts), the kick
   * at least squareMin across the axis, it is within alignM of a point along the axis, and it has more than kickMinHp
   * (the kick takes ≈ 12 HP itself). kickWaitTicks: he watches the kick play out; fleeM: the ape this far off has run
   * (route b).
   */
  snag: {
    standM: 2.5,
    waitM: 3.2,
    apeBandM: [0.3, 2.4] as const,
    kickM: [1.9, 3.8] as const,
    squareMin: 0.7,
    alignM: 0.9,
    kickMinHp: 13,
    kickWaitTicks: 60,
    fleeM: 12,
  },
  /**
   * Log finish: a loose log of at most maxKg (the carry limit, VERB_TUNING.carryMaxKg 40) taken from within takeM,
   * carried to followM off the ape, dropped when the ape is down within dropReachM (the load rides ≈ 0.4 m ahead of
   * him, VERB_TUNING.carryFrontFwdM), or standing with dropAnyHp or less. DEVIATION (§11.9 "when it is down"; a bot
   * habit, not a rule): the ape is down only after a knockdown blow, for under 2 s, and a carried load allows no blow
   * (§5.1), so he also drops it on a standing ape whose bar is nearly empty (the log's glancing hit did 0.2-0.5 HP).
   */
  log: { maxKg: 40, takeM: 1.0, followM: 2.0, dropReachM: 0.9, dropAnyHp: 2 },
} as const;

/** The finishing options, in the order they are tried (§11.9's two routes). */
const FINISHES = ['snag', 'log'] as const;
type Finish = (typeof FINISHES)[number];

const TRACE = process.env.ROTW_AC9_TRACE === '1';
const SEEDS: number[] = process.env.ROTW_AC9_SEEDS ? process.env.ROTW_AC9_SEEDS.split(',').map((s) => Number(s.trim())) : [...AC9.seeds];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const flat = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);
const xz = (p: { x: number; z: number }): XZ => ({ x: p.x, z: p.z });

function rotate(q: Quat, v: V3): V3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return { x: v.x + w * tx + (y * tz - z * ty), y: v.y + w * ty + (z * tx - x * tz), z: v.z + w * tz + (x * ty - y * tx) };
}

/** The snag as a player sees it: its axis on the ground, its length, its points (which side each faces). */
interface SnagView {
  c: XZ;
  /** Unit along the axis (horizontal). */
  a: XZ;
  /** Unit across it (a rotated a quarter turn). */
  n: XZ;
  halfM: number;
  points: { t: number; side: 1 | -1; p: V3 }[];
}

function snagView(e: Entity): SnagView {
  const ax = rotate(e.pose.q, { x: 0, y: 1, z: 0 });
  const h = Math.hypot(ax.x, ax.z) || 1;
  const a = { x: ax.x / h, z: ax.z / h };
  const n = { x: -a.z, z: a.x };
  const c = xz(e.pose.p);
  const half = e.shape.kind === 'cylinder' || e.shape.kind === 'capsule' ? e.shape.halfHeight : 1.5;
  const points = e.sharpPoints.map((sp) => {
    const p = rotate(e.pose.q, sp.local);
    const d = rotate(e.pose.q, sp.dir);
    const world = { x: e.pose.p.x + p.x, y: e.pose.p.y + p.y, z: e.pose.p.z + p.z };
    const s = d.x * n.x + d.z * n.z;
    return { t: (world.x - c.x) * a.x + (world.z - c.z) * a.z, side: (s >= 0 ? 1 : -1) as 1 | -1, p: world };
  });
  return { c, a, n, halfM: half, points };
}

const along = (s: SnagView, p: XZ): number => (p.x - s.c.x) * s.a.x + (p.z - s.c.z) * s.a.z;
const across = (s: SnagView, p: XZ): number => (p.x - s.c.x) * s.n.x + (p.z - s.c.z) * s.n.z;
const snagPoint = (s: SnagView, t: number, off: number): XZ => ({ x: s.c.x + s.a.x * t + s.n.x * off, z: s.c.z + s.a.z * t + s.n.z * off });

// ---------------------------------------------------------------------------
// The run's record (warded-advice: StepRun, QuestRun)
// ---------------------------------------------------------------------------

type Phase = 'approach' | 'brawl' | 'finish';

interface StepRun {
  index: number;
  kind: Phase;
  text: string;
  ticks: number;
  ok: boolean;
  reason?: string;
}

interface RehearsalRun {
  seed: number;
  ok: boolean;
  /** Ticks from the world's first tick to the environmental KO (or to the end). */
  ticks: number;
  route: Finish | null;
  /** The finishing cause: the KO's cause kind, entity look and feature, and the struck bone. */
  cause: string | null;
  falls: number;
  deaths: number;
  respawns: number;
  steps: StepRun[];
  /** Every finishing option tried, in order, with what came of it. */
  finishes: { option: Finish; tick: number; outcome: string }[];
  /** Commands sent before the run (the dev ops pausing the other creatures).*/
  setup: string[];
  reason?: string;
  trace: string[];
  hits: string[];
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

class Bot {
  readonly h: Harness;
  readonly seed: number;
  readonly run: RehearsalRun;
  /** The ape of home A (the spawner's first home slot). */
  readonly ape: Fighter;
  /** Home A, and its snag (the snag nearest it). */
  readonly home: XZ;
  readonly snagId: number;
  phase: Phase = 'approach';
  phaseStart = 0;
  /** Sub-state of the current phase. */
  sub = '';
  /** The finishing option being tried (index into FINISHES). */
  finishIdx = 0;
  finishStart = 0;
  kicks = 0;
  private done = false;
  private koEvent: Extract<CombatEvent, { type: 'ko' }> | null = null;
  private seenCombat = 0;
  private seenWorld = 0;
  private patternIdx = 0;
  private wasDown = false;
  // stuck test
  private moving = false;
  private lastPos: XZ = { x: 0, z: 0 };
  private stuck = 0;
  private sidestepUntil = -1;
  private sidestepTo: XZ | null = null;
  replans = 0;
  // noticing
  private distHist: number[] = [];

  constructor(h: Harness, seed: number) {
    this.h = h;
    this.seed = seed;
    const w = h.w;
    const slot = w.spawner.slots().homes[0];
    const ape = w.combat.fighters.find((f) => f.id === slot.fighter);
    if (!ape) throw new Error(`seed ${seed}: home A has no ape`);
    this.ape = ape;
    this.home = { ...w.spawnData!.apeHomes[0].home };
    let best = Infinity;
    let snag = 0;
    for (const e of w.entities.all()) {
      if (e.look !== 'snag') continue;
      const d = flat(e.pose.p, this.home);
      if (d < best) {
        best = d;
        snag = e.id;
      }
    }
    if (!snag) throw new Error(`seed ${seed}: no snag`);
    this.snagId = snag;
    this.run = { seed, ok: false, ticks: 0, route: null, cause: null, falls: 0, deaths: 0, respawns: 0, steps: [], finishes: [], setup: [], trace: [], hits: [] };
    this.lastPos = xz(h.p.pos);
  }

  get w() {
    return this.h.w;
  }
  get p(): Fighter {
    return this.h.p;
  }
  get tick(): number {
    return this.w.tick;
  }

  // -- commands --------------------------------------------------------------

  private push(c: Command): void {
    this.w.commands.push(c);
  }

  /**
   * A move command toward `to` (a sidestep's point while one is on). With `skirt`, a way that passes within skirtM of
   * the ape is bent round it (he never walks into it: a body walked into is a creature impact, §4.3).
   */
  private moveToward(to: XZ, o: { speed?: number; sprint?: boolean; skirt?: boolean } = {}): void {
    const p = this.p;
    let goal = to;
    if (this.sidestepTo && this.tick < this.sidestepUntil) goal = this.sidestepTo;
    else if (o.skirt && this.ape.alive) {
      const a = this.ape.pos;
      const dx = goal.x - p.pos.x;
      const dz = goal.z - p.pos.z;
      const L = Math.hypot(dx, dz);
      if (L > 1e-6) {
        const ux = dx / L;
        const uz = dz / L;
        const ahead = (a.x - p.pos.x) * ux + (a.z - p.pos.z) * uz;
        const side = (a.x - p.pos.x) * -uz + (a.z - p.pos.z) * ux;
        if (ahead > 0 && ahead < L && Math.abs(side) < AC9.skirtM) {
          // round the side it is not on (a fixed side when dead ahead: deterministic)
          const s = side >= 0 ? -1 : 1;
          goal = { x: a.x + -uz * s * AC9.skirtM * 1.2, z: a.z + ux * s * AC9.skirtM * 1.2 };
        }
      }
    }
    const d = flat(p.pos, goal);
    this.moving = true;
    if (d < 0.05) return this.halt();
    const mag = (o.speed ?? 1) * Math.min(1, Math.max(0.3, d / 0.6));
    this.push(moveCommand(this.tick + 1, 1, ((goal.x - p.pos.x) / d) * mag, ((goal.z - p.pos.z) / d) * mag, o.sprint ? MOVE_SPRINT : 0));
  }

  private halt(): void {
    this.push(moveCommand(this.tick + 1, 1, 0, 0));
  }

  private press(b: Button): boolean {
    const p = this.p;
    if (!p.free || p.stamina < AC9.minStamina) return false;
    this.push({ tick: this.tick + 1, player: 1, kind: 'button', button: b });
    return true;
  }

  private verb(v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): void {
    this.push({ tick: this.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand);
  }

  // -- the loop -------------------------------------------------------------

  /** One tick: decide, step, observe. Returns false once the run is over. */
  stepOnce(): boolean {
    this.moving = false;
    this.decide();
    this.h.step();
    this.observe();
    return !this.done;
  }

  private enter(phase: Phase, sub = ''): void {
    this.phase = phase;
    this.phaseStart = this.tick;
    this.sub = sub;
    this.stuck = 0;
    this.sidestepTo = null;
  }

  /** Closes the current phase's step (ok or with its reason) and moves to `next`. */
  private close(ok: boolean, text: string, next: Phase | null, reason?: string): void {
    const s: StepRun = { index: this.run.steps.length, kind: this.phase, text, ticks: this.tick - this.phaseStart, ok };
    if (reason) s.reason = reason;
    this.run.steps.push(s);
    if (next) this.enter(next, next === 'approach' ? 'axe' : '');
  }

  private finishRun(ok: boolean, reason?: string): void {
    this.done = true;
    this.run.ok = ok;
    this.run.ticks = this.tick;
    if (reason) this.run.reason = reason;
  }

  /** What the run is waiting for, read from the events and the stuck test after each tick. */
  private observe(): void {
    const h = this.h;
    const w = this.w;
    const p = this.p;
    const ape = this.ape;
    for (; this.seenCombat < h.history.combat.length; this.seenCombat++) {
      const e = h.history.combat[this.seenCombat];
      if (e.type === 'ko' && e.victim === ape && !this.koEvent) this.koEvent = e;
      if (e.type === 'ko' && e.victim === p) this.run.deaths++;
      if (e.type === 'hit' && (e.defender === ape || e.defender === p)) {
        this.run.hits.push(`t${w.tick} ${e.attacker === p ? 'p→ape' : 'ape→p'} ${e.move.id} ${e.damage.toFixed(1)} HP ${e.bone}${e.knockdown ? ' knockdown' : ''}`);
      }
      if ((e.type === 'block' || e.type === 'dodge') && e.attacker === p && e.defender === ape && this.phase === 'finish') {
        this.run.hits.push(`t${w.tick} p→ape ${e.move.id} ${e.type === 'block' ? 'blocked' : `dodged (${e.kind})`}`);
      }
    }
    for (; this.seenWorld < h.history.world.length; this.seenWorld++) {
      const e = h.history.world[this.seenWorld];
      if (e.type === 'respawn' && e.f === p) {
        this.run.respawns++;
        if (this.phase !== 'approach') this.close(false, `${this.phase} cut short`, 'approach', `the player died at t${w.tick} and respawned`);
        else this.enter('approach', 'axe');
      }
      if (e.type === 'impact' && e.defender === ape && e.damage > 0) {
        this.run.hits.push(
          `t${w.tick} world→ape ${e.cause.kind}${e.cause.entityId ? ` ${w.entities.get(e.cause.entityId)?.look ?? e.cause.entityId}` : ''}${e.cause.fighterId ? ` fighter ${e.cause.fighterId}` : ''} ${e.cause.feature} ${e.damage.toFixed(1)} HP ${e.bone} E ${e.energy.toFixed(0)} J ape ${ape.state}${e.knockdown ? ' knockdown' : ''}`,
        );
      }
    }
    const down = p.state === 'knockdown' || p.state === 'tripped' || p.state === 'ko';
    if (down && !this.wasDown) this.run.falls++;
    this.wasDown = down;

    if (this.koEvent) {
      const k = this.koEvent;
      const c = k.cause;
      const look = c?.entityId ? (w.entities.get(c.entityId)?.look ?? `entity ${c.entityId}`) : null;
      this.run.cause = `${k.by}${c ? ` ${c.kind}${look ? ` ${look}` : ''} ${c.feature}` : ''}`;
      if (k.environmental) {
        // The route that landed is what hit it (the snag, or a log), whichever option he was trying then.
        const option = this.phase === 'finish' ? FINISHES[this.finishIdx] : this.phase;
        this.run.route = look === 'snag' ? 'snag' : look === 'log' ? 'log' : null;
        this.close(true, `${look ?? c?.kind ?? 'the world'} (trying ${option})`, null);
        this.run.finishes.push({ option: FINISHES[this.finishIdx], tick: w.tick, outcome: `environmental KO by ${look ?? c?.kind ?? '?'} while trying ${option}` });
        this.finishRun(true);
      } else {
        this.close(false, this.phase, null, `the ape was knocked out, not by the world (${this.run.cause}) at t${w.tick}`);
        this.finishRun(false, `non-environmental KO: ${this.run.cause}`);
      }
      return;
    }

    // The stuck test, once a second while walking somewhere.
    if (w.tick % 60 === 0) {
      if (this.moving && p.alive) {
        if (flat(p.pos, this.lastPos) < AC9.stuckMoveM) this.stuck += 60;
        else this.stuck = 0;
        if (this.stuck > AC9.replanAt) {
          this.stuck = 0;
          this.replans++;
          this.sidestepTo = null;
        } else if (this.stuck > AC9.sidestepAt) {
          const ang = (w.tick * 0.618) % (2 * Math.PI);
          this.sidestepTo = { x: p.pos.x + Math.sin(ang) * AC9.sidestepM, z: p.pos.z + Math.cos(ang) * AC9.sidestepM };
          this.sidestepUntil = w.tick + 60;
        }
      } else this.stuck = 0;
      this.lastPos = xz(p.pos);
      this.traceLine();
    }

    if (w.tick >= AC9.maxTicks) {
      this.close(false, this.phase, null, `out of time: ${AC9.maxTicks} ticks (${this.sub})`);
      this.finishRun(false, `no environmental KO within ${AC9.maxTicks} ticks (phase ${this.phase}, ${this.sub}; ape ${this.ape.hp.toFixed(1)} HP)`);
    }
  }

  private traceLine(): void {
    const p = this.p;
    const a = this.ape;
    const e = this.w.entities.get(this.snagId);
    const s = e ? snagView(e) : null;
    const rel = s ? ` | snag t/s p ${along(s, p.pos).toFixed(1)}/${across(s, p.pos).toFixed(1)} ape ${along(s, a.pos).toFixed(1)}/${across(s, a.pos).toFixed(1)}` : ' | snag gone';
    // (the mind's state is observation for the reader of the trace; no decision reads it)
    const mind = this.w.minds.get(a)?.state ?? '-';
    this.run.trace.push(
      `t${this.tick} ${this.phase}/${this.sub} d ${flat(p.pos, a.pos).toFixed(1)} | p ${p.hp.toFixed(0)} HP st ${p.stamina.toFixed(2)} ${p.state}${p.inventory?.hands ? ` ${p.inventory.hands.mode}` : ''} (${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)}) | ape ${a.hp.toFixed(1)} HP ${a.state} ${mind} (${a.pos.x.toFixed(1)}, ${a.pos.z.toFixed(1)})${rel}${this.stuck ? ` stuck ${this.stuck}` : ''}`,
    );
  }

  // -- decisions -------------------------------------------------------------

  private decide(): void {
    const p = this.p;
    if (!p.alive) return; // out: waiting for the respawn (Deaths, §4.14)
    const budget = AC9.budget[this.phase];
    if (this.tick - this.phaseStart > budget) {
      const next: Phase | null = this.phase === 'approach' ? 'approach' : this.phase === 'brawl' ? 'brawl' : null;
      this.close(false, this.phase, next, `${this.phase} over its budget of ${budget} ticks (${this.sub})`);
      if (!next) this.finishRun(false, `finish over its budget`);
      return;
    }
    switch (this.phase) {
      case 'approach':
        return this.approach();
      case 'brawl':
        return this.brawl();
      case 'finish':
        return this.finish();
    }
  }

  /** The axe in the hands, then toward home A until the ape notices him. */
  private approach(): void {
    const p = this.p;
    const w = this.w;
    const hands = p.inventory?.hands;
    if (this.sub === 'axe') {
      if (hands?.mode === 'wield') {
        this.sub = 'seek';
        return;
      }
      const axe = this.starterAxe();
      if (axe === null) {
        this.sub = 'seek'; // nothing to take (taken and lost): bare hands
        return;
      }
      const at = w.entities.get(axe)!.pose.p;
      if (flat(p.pos, at) > 1.0) return this.moveToward(at);
      this.halt();
      if (p.free && !p.verbRequest) this.verb({ verb: 'take', target: axe });
      return;
    }
    // seek: toward home A, to the snag at its edge (where he means to finish it), until the ape comes at him
    const d = flat(p.pos, this.ape.pos);
    this.distHist.push(d);
    if (this.distHist.length > 30) this.distHist.shift();
    const closing = this.distHist.length === 30 ? (this.distHist[0] - d) / 0.5 : 0;
    if (this.ape.alive && (d <= AC9.noticeM || (d <= AC9.noticeWithinM && closing >= AC9.noticeClosingMps))) {
      this.close(true, `noticed at ${d.toFixed(1)} m (closing ${closing.toFixed(1)} m/s)`, 'brawl');
      return;
    }
    const e = w.entities.get(this.snagId);
    const goal = e ? this.snagSpot(snagView(e), AC9.snag.standM) : this.home;
    if (flat(p.pos, goal) > 0.4) this.moveToward(goal);
    else this.halt();
  }

  /** A spot on the snag's points' side (σ, chosen once: the side with more points) in front of a point, `off` out. */
  private snagSpot(s: SnagView, off: number): XZ {
    if (this.sigma === 0) {
      const plus = s.points.filter((q) => q.side === 1).length;
      const minus = s.points.length - plus;
      this.sigma = plus > minus ? 1 : minus > plus ? -1 : across(s, this.p.pos) >= 0 ? 1 : -1;
      this.pickPoint(s);
    }
    return snagPoint(s, this.targetT, this.sigma * off);
  }

  /** The starter cache's axe as the player sees it: the green stick lashed to a flint nearest (2.5, 3). */
  private starterAxe(): number | null {
    const w = this.w;
    let best: number | null = null;
    let bd = Infinity;
    for (const e of w.entities.all()) {
      if (e.look !== 'stick' || e.material !== 'greenWood' || e.joints.length === 0) continue;
      const d = flat(e.pose.p, { x: 2.5, z: 3 });
      if (d < bd && d < 8) {
        bd = d;
        best = e.id;
      }
    }
    return best;
  }

  private brawl(): void {
    const p = this.p;
    const a = this.ape;
    if (a.hp <= AC9.stopHp) {
      this.close(true, `ape at ${a.hp.toFixed(1)} HP`, 'finish');
      this.finishStart = this.tick;
      return;
    }
    const d = flat(p.pos, a.pos);
    const armed = p.inventory?.hands?.mode === 'wield';
    if (armed && a.hp <= AC9.axeUntilHp) {
      // enough cuts (they bleed for good): the axe goes on his back, a step away from the ape first
      this.sub = 'stow';
      if (d < 2.5) return this.moveToward({ x: p.pos.x + (p.pos.x - a.pos.x), z: p.pos.z + (p.pos.z - a.pos.z) });
      this.halt();
      if (p.free && !p.verbRequest) this.verb({ verb: 'stow', target: 0, slot: 3 });
      return;
    }
    const gentle = !armed && a.hp <= AC9.gentleHp;
    // (gentle: jabs only, from within jab range: further out the same button throws the Gazelle punch, select.ts)
    const reach = gentle ? AC9.jabM : AC9.strikeM;
    this.sub = d > reach ? 'close' : gentle ? 'jab' : 'strike';
    if (d > reach) return this.moveToward(a.pos);
    this.halt();
    const pat = armed ? AC9.axe : gentle ? AC9.gentle : AC9.fists;
    if (this.press(pat[this.patternIdx % pat.length])) this.patternIdx++;
  }

  private finish(): void {
    const opt = FINISHES[this.finishIdx];
    if (opt === 'snag') return this.finishSnag();
    return this.finishLog();
  }

  /** The current option gave up (`outcome`): on to the next one, if any (the last one keeps trying to the end). */
  private nextFinish(outcome: string): void {
    this.run.finishes.push({ option: FINISHES[this.finishIdx], tick: this.tick, outcome });
    if (this.finishIdx + 1 < FINISHES.length) {
      this.finishIdx++;
      this.finishStart = this.tick;
      this.sub = '';
    }
  }

  /** The snag's points' side (σ), chosen once: the side with more points (ties: his side). */
  private sigma: 1 | -1 | 0 = 0;
  /** The point he means to knock it onto (its t along the axis). */
  private targetT = 0;
  private afterKick = -1;

  /**
   * Route a, the snag (§11.9 "knock it toward home A's snag"). The snag's three points alternate sides, so whichever
   * side the ape stands on has one. The ape in a fight keeps coming at him and trails him when he walks away, so he
   * walks away from it over the snag (`cross`: to waitM out on the far side, at a point there): it follows him over and
   * stops between him and the snag. Then (`kick`), with it standing in apeBandM in front of a point (alignM along
   * the axis) and him kickM out behind it on that line (squareMin across the axis), he flying-kicks it: a knockdown, so
   * its body falls back onto the points. Too close for the flying kick, he steps back out (`step`); in line but off the
   * points, he goes along to the point (`along`). The flying kick itself takes ≈ 12 HP (measured), so he kicks only
   * while the ape has more than kickMinHp (or the blow, not the world, would be the kill). He gives it up when the ape
   * runs off (fleeM: route b), the snag is gone, or the ape is too weak for the kick.
   */
  private finishSnag(): void {
    const p = this.p;
    const a = this.ape;
    const S = AC9.snag;
    const e = this.w.entities.get(this.snagId);
    if (!e || e.sharpPoints.length === 0) return this.nextFinish('the snag is gone (broken)');
    const s = snagView(e);
    const d = flat(p.pos, a.pos);
    if (this.tick < this.afterKick) return this.halt();
    if (!p.free && p.state === 'attack') return this.halt();
    if (a.hp <= S.kickMinHp && a.free) return this.nextFinish(`the ape at ${a.hp.toFixed(1)} HP, too weak for the flying kick (≈ 12 HP)`);
    if (d > S.fleeM && a.alive) {
      // it ran off (§6.3 flee): it comes back to its home, at whose edge the snag lies; he waits for it there
      this.sub = 'fled';
      const goal = this.snagSpot(s, S.standM);
      if (flat(p.pos, goal) > 0.4) return this.moveToward(goal);
      return this.halt();
    }
    // the side the ape stands on (X), and both across the axis on that side
    const X: 1 | -1 = across(s, a.pos) >= 0 ? 1 : -1;
    const sa = across(s, a.pos) * X;
    const sp = across(s, p.pos) * X;
    const ta = along(s, a.pos);
    const tp = along(s, p.pos);
    const near = (side: 1 | -1, t: number): number | null => {
      let best: number | null = null;
      for (const q of s.points) if (q.side === side && (best === null || Math.abs(q.t - t) < Math.abs(best - t))) best = q.t;
      return best;
    };
    const tX = near(X, ta);
    const onPoint = tX !== null && Math.abs(tX - ta) <= S.alignM;
    const square = d > 0 && (sp - sa) / d >= S.squareMin;
    const between = a.alive && sa >= S.apeBandM[0] && sa <= S.apeBandM[1] && sp > sa && square;
    if (between && onPoint && d >= S.kickM[0] && d <= S.kickM[1]) {
      this.halt();
      if (this.press('lkick')) {
        this.kicks++;
        this.sub = 'kick';
        this.afterKick = this.tick + S.kickWaitTicks;
      }
      return;
    }
    if (between && onPoint) {
      // too close for the flying kick: a step back out along the line
      this.sub = 'step';
      return this.moveToward({ x: p.pos.x + s.n.x * X, z: p.pos.z + s.n.z * X });
    }
    if (between && tX !== null) {
      // in line, off the points: along to the point, out where he is
      this.sub = 'along';
      return this.moveToward(snagPoint(s, tX, X * Math.max(sp, S.waitM)), { skirt: true });
    }
    // cross: away from it over the snag to the far side, at that side's point nearest him
    this.sub = 'cross';
    const tFar = near(-X as 1 | -1, tp) ?? 0;
    const goal = snagPoint(s, tFar, -X * S.waitM);
    if (flat(p.pos, goal) > 0.3) return this.moveToward(goal, { skirt: true });
    this.halt();
  }


  /** The point on the σ side nearest the ape along the axis. */
  private pickPoint(s: SnagView): void {
    const ta = along(s, this.ape.pos);
    let best: number | null = null;
    for (const q of s.points) if (q.side === this.sigma && (best === null || Math.abs(q.t - ta) < Math.abs(best - ta))) best = q.t;
    this.targetT = best ?? 0;
  }

  /**
   * Route b, the log (§11.9 "if the ape flees, drop a carried 40 kg log on it when it is down"): he fetches the nearest
   * loose log he can carry (≤ VERB_TUNING.carryMaxKg: the damp grove's 40 kg rotten logs, §6.7), carries it to the ape,
   * keeps a step off it, and when it is down within reach drops the log on it (a dropped log is nobody's: its hit is
   * the world's, §4.4). A carried load allows no strike (§5.1), so nothing else knocks it down.
   */
  private finishLog(): void {
    const p = this.p;
    const a = this.ape;
    const L = AC9.log;
    const w = this.w;
    const hands = p.inventory?.hands;
    const carrying = hands?.mode === 'carry';
    if (!carrying) {
      if (hands && p.free && !p.verbRequest) {
        this.verb({ verb: 'drop', target: 0 }); // whatever else is in the hands
        return;
      }
      const log = this.carryLog();
      if (log === null) {
        this.sub = 'no log';
        return this.halt();
      }
      this.sub = 'fetch';
      const at = w.entities.get(log)!.pose.p;
      if (flat(p.pos, at) > L.takeM) return this.moveToward(at, { skirt: true });
      this.halt();
      if (p.free && !p.verbRequest) this.verb({ verb: 'take', target: log });
      return;
    }
    const d = flat(p.pos, a.pos);
    const down = a.state === 'knockdown' || a.state === 'tripped' || a.hp <= L.dropAnyHp;
    if (down && d <= L.dropReachM) {
      this.sub = 'drop';
      this.halt();
      if (p.free && !p.verbRequest) this.verb({ verb: 'drop', target: 0 });
      return;
    }
    if (down) {
      this.sub = 'to drop';
      return this.moveToward(a.pos);
    }
    this.sub = 'carry';
    if (d > L.followM) return this.moveToward(a.pos, { skirt: true });
    this.halt();
  }

  /** The nearest loose log he can carry (what he sees: a log, light enough), by distance from him. */
  private carryLog(): number | null {
    const p = this.p;
    let best: number | null = null;
    let bd = Infinity;
    for (const e of this.w.entities.all()) {
      if (e.look !== 'log' || e.state !== 'free' || e.mass > AC9.log.maxKg) continue;
      const d = flat(e.pose.p, p.pos);
      if (d < bd) {
        bd = d;
        best = e.id;
      }
    }
    return best;
  }
}

async function rehearse(seed: number): Promise<RehearsalRun> {
  const h = await makeHarness({ seed, scene: 'clearing', nav: 'full' });
  live.push(h);
  const bot = new Bot(h, seed);
  // §11.9: the ape of home A with its brain on; every other creature's mind paused by the dev op (a command, logged
  // like any other), so the run measures the player against that ape (P39 runs of seed 2: the giant, brain on, walked
  // into the brawl and knocked the ape out with its body: a creature KO, not the world's).
  for (const f of h.w.combat.fighters) {
    if (f === bot.ape || f === h.p) continue;
    h.w.commands.push({ tick: h.w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'pauseMinds', args: [1, f.id] } });
    bot.run.setup.push(`pauseMinds ${f.id} (${f.species})`);
  }
  if (process.env.ROTW_AC9_PROBE_ZONE === '1') h.w.commands.push({ tick: h.w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'setTuning', args: [], tuning: { table: 'SPECIES_BODY', key: 'ape.massShareMode', value: 'zone' } } });
  bot.phaseStart = h.w.tick;
  bot.sub = 'axe';
  let n = 0;
  while (bot.stepOnce()) if (++n % 600 === 0) await yieldToVitest();
  return bot.run;
}

const live: Harness[] = [];
afterEach(() => {
  for (const h of live.splice(0)) if (!h.w.isDisposed) h.w.dispose();
});

describe('AC-9 rehearsal (non-gating, §11.9)', () => {
  it(`a scripted player reaches an environmental ape KO within ${AC9.maxTicks} ticks (seeds ${SEEDS.join(', ')})`, async () => {
    const runs: RehearsalRun[] = [];
    for (const seed of SEEDS) {
      const r = await rehearse(seed);
      runs.push(r);
      const steps = r.steps.map((s) => `  ${s.index} ${s.kind} ${s.ok ? 'ok' : 'FAIL'} ${s.ticks} ticks: ${s.text}${s.reason ? ` (${s.reason})` : ''}`).join('\n');
      const fin = r.finishes.map((f) => `${f.option}@t${f.tick}: ${f.outcome}`).join('; ');
      console.info(
        `AC-9 seed ${seed}: ${r.ok ? 'ok' : 'FAIL'} ticks ${r.ticks} route ${r.route ?? '-'} cause ${r.cause ?? '-'} falls ${r.falls} deaths ${r.deaths} respawns ${r.respawns}${r.reason ? ` | ${r.reason}` : ''}\n${steps}\n  finishes: ${fin || '-'}\n  hits:\n    ${r.hits.join('\n    ')}`,
      );
      if (TRACE || !r.ok) console.info(`AC-9 seed ${seed} trace:\n  ${r.trace.join('\n  ')}`);
    }
    const ok = runs.filter((r) => r.ok);
    const ticks = ok.map((r) => r.ticks).sort((a, b) => a - b);
    console.info(
      `AC-9 summary: ${ok.length}/${runs.length} seeds reached ko { environmental: true } within ${AC9.maxTicks} ticks; ticks ${ticks.length ? `min ${ticks[0]} median ${ticks[Math.floor(ticks.length / 2)]} max ${ticks[ticks.length - 1]}` : '-'}\n` +
        runs.map((r) => `  seed ${r.seed}: ${r.ok ? 'ok' : 'FAIL'} ticks ${r.ticks} route ${r.route ?? '-'} cause ${r.cause ?? '-'} falls ${r.falls} deaths ${r.deaths}`).join('\n'),
    );
    for (const r of runs) expect(r.ok, `seed ${r.seed}: ${r.reason ?? ''}`).toBe(true);
  });
});
