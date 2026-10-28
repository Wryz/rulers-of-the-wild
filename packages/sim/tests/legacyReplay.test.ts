// The legacy-fight replay (docs/M1-DESIGN.md §13.1 P02a): five recorded DungeonStyle fights, driven by tick-tagged
// commands and the DS brawler AI, replay to the fighter-state hashes and the event stream recorded at the integration
// commit before any seam landed (tests/fixtures/legacy-fight.json), plus exactly one `ko` event per knockout.
//
// The default scenario (no FighterOpts) uses only behaviour that existed when the fixture was recorded at the
// integration commit (ca53ce7). To re-record (only ever at a commit whose legacy behaviour is the reference):
//   ROTW_RECORD_LEGACY=1 npx vitest run packages/sim/tests/legacyReplay.test.ts
// (The sim's tsconfig has no Node types: the fixture is a JSON import, and recording reaches node:fs dynamically.)
//
// Clotting (the owner's decision after P39: BLEED_TUNING, combat.ts bleedTick) postdates the recording: DungeonStyle's
// cuts never closed. The fights replay with clotting off (BLEED_TUNING.clotSmallS = Infinity: a cut's seep stays its
// floor, DS's rule bit for bit), and a wound's new `clot` key is left out of the event text.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import recorded from './fixtures/legacy-fight.json';
import { BONES } from '../src/body/skeleton';
import { BRAWLER_PLAN, BrawlerAI, DEFAULT_AI } from '../src/sim/ai';
import { type CombatEvent, CombatSim } from '../src/sim/combat';
import { type Command, moveCommand } from '../src/sim/commands';
import { createEnemy, type EnemyKind } from '../src/sim/enemies';
import { BUTTONS, Fighter, type FighterOpts, IdCounter, LEGACY_IDS } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { ENEMY_MOVES } from '../src/sim/moves';
import { BRAWLER_STYLE, createPlayer } from '../src/sim/roster';
import { WEAPONS } from '../src/sim/weapons';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { ArenaWalkable } from '../src/world/collision';

const CHECK_EVERY = 30;

export interface LegacyCheckpoint {
  scenario: number;
  tick: number;
  /** Hash of every fighter's state, the sim's rng, drops and projectiles after this tick. */
  state: string;
  /** Hash of every event (`ko` events left out) since the previous checkpoint. */
  events: string;
}

export interface LegacyRecord {
  /** Fighter ids per scenario, in creation order (they seed the fighters' rngs and the threat serials). */
  ids: number[][];
  checkpoints: LegacyCheckpoint[];
  /** [scenario, tick, fighter id] of every fighter that entered 'ko', in order. */
  kos: [number, number, number][];
  /** Event counts by type (`ko` left out), for a readable diff. */
  counts: Record<string, number>;
}

/** What a run produced beyond the record: every `ko` event as [scenario, tick, victim id]. */
export interface LegacyRun extends LegacyRecord {
  koEvents: [number, number, number][];
}

// ---------------------------------------------------------------------------
// Hashing (two independent 32-bit FNV-style hashes over the exact float64 bits)
// ---------------------------------------------------------------------------

class Hasher {
  private a = 0x811c9dc5;
  private b = 0x01000193;
  private readonly f64 = new Float64Array(1);
  private readonly u8 = new Uint8Array(this.f64.buffer);

  num(v: number) {
    this.f64[0] = v;
    for (let i = 0; i < 8; i++) this.byte(this.u8[i]);
  }

  str(s: string) {
    this.num(s.length);
    for (let i = 0; i < s.length; i++) this.num(s.charCodeAt(i));
  }

  bool(v: boolean) {
    this.byte(v ? 1 : 2);
  }

  private byte(x: number) {
    this.a = Math.imul(this.a ^ x, 0x01000193) >>> 0;
    this.b = Math.imul((this.b ^ x) + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }

  digest(): string {
    return this.a.toString(16).padStart(8, '0') + this.b.toString(16).padStart(8, '0');
  }
}

const rngState = (r: unknown): number => (r as { s: number }).s >>> 0;

function hashState(sim: CombatSim): string {
  const h = new Hasher();
  h.num(sim.frame);
  h.num(rngState(sim.rng));
  for (const f of sim.fighters) {
    h.num(f.id);
    h.str(f.state);
    for (const n of [f.stateFrame, f.stunFrames, f.yaw, f.scale, f.hp, f.guard, f.poise, f.stamina, f.attackSerial, f.combo, f.attackEnd, f.stuckUntil, f.pickupRequest, f.repeatCount, f.swingStamina, f.misreadSerial, f.lastDefendedSerial, f.perfectSerial, f.dodgedSerial]) h.num(n);
    for (const v of [f.pos, f.vel, f.walkVel, f.moveInput, f.airStep]) {
      h.num(v.x);
      h.num(v.y);
      h.num(v.z);
    }
    for (const b of [f.hitThisAttack, f.isCounterAttack, f.perfectCounter, f.isPerfectCounter, f.lockedOn, f.wasBlocked, f.defenseManual]) h.bool(b);
    h.str(f.move ? `${f.move.id}|${f.move.startup}|${f.move.active}|${f.move.recovery}` : '-');
    h.str(f.weapon?.id ?? '-');
    h.num(f.ammo?.count ?? -1);
    h.num(f.target?.id ?? -1);
    h.str(f.buffer ? `${f.buffer.button}|${f.buffer.frames}` : '-');
    h.str(f.counter ? `${f.counter.kind}|${f.counter.frames}` : '-');
    h.str(f.defense ? `${f.defense.def.kind}|${f.defense.phase}|${f.defense.success}|${f.defense.threatSerial}|${f.defense.side}` : '-');
    h.str(f.aim?.id ?? '-');
    h.str(f.strikeHeight);
    h.num(f.wounds.length);
    for (const w of f.wounds) {
      h.str(w.bone);
      for (const n of [...w.local, w.angle, w.length, w.bleed, w.floor]) h.num(n);
      h.str(w.stump ?? '-');
    }
    h.str([...f.severed].sort().join(','));
    h.str([...f.torn].sort().join(','));
    for (const b of BONES) {
      const j = f.rig[b];
      h.num(j.pos.x);
      h.num(j.pos.y);
      h.num(j.pos.z);
      h.num(j.rot.x);
      h.num(j.rot.y);
      h.num(j.rot.z);
      h.num(j.rot.w);
    }
    for (const foot of [f.footwork.L, f.footwork.R]) {
      h.num(foot.pos.x);
      h.num(foot.pos.y);
      h.num(foot.pos.z);
      h.bool(foot.stepping);
    }
    h.num(rngState((f as unknown as { rng: unknown }).rng));
  }
  for (const d of sim.drops) {
    h.num(d.id);
    h.str(d.weapon.id);
    h.num(d.pos.x);
    h.num(d.pos.y);
    h.num(d.pos.z);
    h.num(d.yaw);
  }
  for (const p of sim.projectiles) {
    h.num(p.id);
    for (const n of [p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.angle, p.omega, p.age]) h.num(n);
    h.bool(p.live);
  }
  return h.digest();
}

/** An event as exact JSON: fighters by id, vectors as arrays, moves and weapons by id. */
function eventText(e: CombatEvent): string {
  return JSON.stringify(e, function (key, value: unknown) {
    if (value instanceof Fighter) return `F${value.id}`;
    if (value && typeof value === 'object' && (value as { isVector3?: boolean }).isVector3) {
      const v = value as { x: number; y: number; z: number };
      return [v.x, v.y, v.z];
    }
    if (key === 'move' && value && typeof value === 'object') {
      const m = value as { id: string; startup: number; active: number; recovery: number };
      return `${m.id}|${m.startup}|${m.active}|${m.recovery}`;
    }
    if (key === 'weapon' && value && typeof value === 'object') return (value as { id: string }).id;
    // A wound's `clot` (clotting, after P39) postdates the recording: left out of the text. What clotting does shows in
    // the state hash (a wound's bleed, the fighter's HP), which is compared as recorded.
    if (key === 'clot' && this && typeof this === 'object' && 'floor' in this) return undefined;
    if (key === 'projectile' && value && typeof value === 'object') {
      const p = value as { id: number; serial: number };
      return `P${p.id}|${p.serial}`;
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// The fights
// ---------------------------------------------------------------------------

interface Scenario {
  sim: CombatSim;
  /** The command-driven player (none: an AI-only fight). */
  player: Fighter | null;
  driver: Rng;
  ticks: number;
  /** Every this many ticks the player throws the weapon in hand at an opponent 2.5-7 m away (0: never). */
  throwEvery?: number;
}

function enemy(sim: CombatSim, kind: EnemyKind, x: number, z: number, opts?: FighterOpts): Fighter {
  const { fighter, ai } = createEnemy(kind, sim.rng, {}, {}, opts);
  fighter.pos.set(x, 0, z);
  fighter.yaw = Math.atan2(-x, -z);
  sim.add(fighter, ai);
  return fighter;
}

/** An armed brawler on the player's team, run by the DS AI. */
function ally(sim: CombatSim, x: number, z: number, opts?: FighterOpts): Fighter {
  const f = new Fighter('player', 'Ally', ENEMY_MOVES, { maxHp: 120, walkSpeed: 2.3, staggerResist: 0.1 }, BRAWLER_STYLE, opts);
  f.weapon = WEAPONS.katana;
  f.autoDefense = true;
  f.pos.set(x, 0, z);
  f.yaw = Math.atan2(-x, -z);
  sim.add(f, new BrawlerAI({ ...DEFAULT_AI, aggression: 1.3 }, sim.rng, BRAWLER_PLAN));
  return f;
}

/** The fights; `opts` (none when recorded) gives every fighter an id counter, as a world would. */
function scenarios(opts?: FighterOpts): (() => Scenario)[] {
  return [
    // 1: an axe against three different fighters (cuts, severing, kunai throws, blocks, dodges).
    () => {
      const sim = new CombatSim(101);
      const player = createPlayer(opts);
      player.weapon = WEAPONS.axe;
      player.stats.damageMul = 1.5;
      player.stats.maxHp = player.hp = 900;
      player.pos.set(0, 0, 0);
      sim.add(player);
      enemy(sim, 'brawler', 2.2, 0.4, opts);
      enemy(sim, 'samurai', -2.4, 1.2, opts);
      enemy(sim, 'ninja', 0.6, -3.2, opts);
      return { sim, player, driver: new Rng(9001), ticks: 2400 };
    },
    // 2: bare hands in an arena with props and weapons on the floor (pickups, clangs, wall thuds, a boss).
    () => {
      const sim = new CombatSim(202);
      sim.walkable = new ArenaWalkable({ kind: 'rect', hx: 8, hz: 6 }, [
        { kind: 'circle', x: 0, z: 2, r: 0.5 },
        { kind: 'circle', x: 1.6, z: 0.2, r: 0.3 },
        { kind: 'box', x: -3, z: -2, hx: 0.6, hz: 0.6, h: 1.1 },
        { kind: 'box', x: 0.4, z: -2.2, hx: 0.25, hz: 0.6, h: 2 },
      ]);
      const player = createPlayer(opts);
      player.stats.damageMul = 2.2;
      player.stats.maxHp = player.hp = 900;
      player.pos.set(0, 0, -0.5);
      sim.add(player);
      sim.addDrop(WEAPONS.machete, 1, -1);
      sim.addDrop(WEAPONS.sledgehammer, -1.2, 0.6);
      enemy(sim, 'knifeFighter', 3, -1, opts);
      enemy(sim, 'kicker', -3.5, 2.5, opts);
      enemy(sim, 'minotaur', 4, 3, opts);
      return { sim, player, driver: new Rng(9002), ticks: 2400 };
    },
    // 3: AI against AI (an armed ally against a berserker and an imp), no commands.
    () => {
      const sim = new CombatSim(303);
      ally(sim, 0, 0, opts);
      enemy(sim, 'berserker', 2.5, 0.5, opts);
      enemy(sim, 'imp', -2, -1.5, opts);
      return { sim, player: null, driver: new Rng(9003), ticks: 2400 };
    },
    // 4: throwing (the player's axe, brawlers' bottles and cleavers, kunai) round props in a ring.
    () => {
      const sim = new CombatSim(404);
      sim.walkable = new ArenaWalkable({ kind: 'circle', r: 9 }, [
        { kind: 'circle', x: 2, z: 0, r: 0.45 },
        { kind: 'box', x: -2, z: 2.5, hx: 1, hz: 0.4, h: 0.9 },
      ]);
      const player = createPlayer(opts);
      player.weapon = WEAPONS.axe;
      player.stats.maxHp = player.hp = 900;
      player.stats.damageMul = 1.5;
      player.pos.set(0, 0, -3);
      sim.add(player);
      sim.addDrop(WEAPONS.bottle, 3, -2);
      sim.addDrop(WEAPONS.pan, -3, -1);
      sim.addDrop(WEAPONS.pipe, 0, 3);
      sim.addDrop(WEAPONS.fireaxe, -1, -4.5);
      enemy(sim, 'brawler', 4, 2, opts).weapon = WEAPONS.bottle;
      enemy(sim, 'brawler', -4, 3, opts).weapon = WEAPONS.cleaver;
      enemy(sim, 'ninja', 0, 6, opts);
      return { sim, player, driver: new Rng(9004), ticks: 2400, throwEvery: 200 };
    },
    // 5: swinging a pipe at a post with nobody about (clangs).
    () => {
      const sim = new CombatSim(505);
      sim.walkable = new ArenaWalkable({ kind: 'rect', hx: 4, hz: 4 }, [{ kind: 'box', x: 0, z: 1.05, hx: 0.5, hz: 0.25, h: 2.5 }]);
      const player = createPlayer(opts);
      player.weapon = WEAPONS.pipe;
      player.pos.set(0, 0, 0);
      sim.add(player);
      return { sim, player, driver: new Rng(9005), ticks: 600 };
    },
  ];
}

/** The scripted player: walks at the nearest opponent (strafing a little), presses buttons, sometimes picks up. */
function drive(s: Scenario, next: number, hold: { button: number; strafe: number; strafeFor: number }) {
  const p = s.player;
  if (!p) return;
  const r = s.driver;
  let best: Fighter | null = null;
  let bestD = Infinity;
  for (const o of s.sim.fighters) {
    if (o.team === p.team || !o.alive) continue;
    const d = p.distanceTo(o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  if (--hold.strafeFor <= 0) {
    hold.strafe = r.range(-1, 1);
    hold.strafeFor = Math.round(r.range(20, 90));
  }
  let x = 0;
  let z = 0;
  if (best) {
    const dx = best.pos.x - p.pos.x;
    const dz = best.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // Close in to fighting range, then circle.
    const toward = bestD > 1.6 ? 1 : bestD < 0.9 ? -0.6 : 0.1;
    x = (dx / d) * toward + (-dz / d) * hold.strafe * 0.6;
    z = (dz / d) * toward + (dx / d) * hold.strafe * 0.6;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
  }
  if (s.throwEvery && next % s.throwEvery === 0 && p.free && p.weapon && bestD > 2.5 && bestD < 7) {
    const m = p.moveDef('throwHeavy');
    if (m) p.startMove(m);
  }
  const cmds: Command[] = [moveCommand(next, p.id, x, z)];
  if (--hold.button <= 0) {
    hold.button = Math.round(bestD < 2.2 ? r.range(4, 14) : r.range(10, 40));
    const roll = r.next();
    if (roll < 0.06) cmds.push({ tick: next, player: p.id, kind: 'button', button: 'pickup' });
    else cmds.push({ tick: next, player: p.id, kind: 'button', button: BUTTONS[Math.floor(r.next() * BUTTONS.length)] });
  }
  for (const c of cmds) s.sim.commands.push(c);
}

/** Runs the fights from fresh fighters (ids from wherever the counter stands). */
export function runLegacyFights(make: (() => Scenario)[] = scenarios()): LegacyRun {
  const out: LegacyRun = { ids: [], checkpoints: [], kos: [], counts: {}, koEvents: [] };
  make.forEach((build, si) => {
    const s = build();
    out.ids.push(s.sim.fighters.map((f) => f.id));
    const hold = { button: 10, strafe: 0, strafeFor: 0 };
    let events = new Hasher();
    const prev = new Map<Fighter, string>();
    for (const f of s.sim.fighters) prev.set(f, f.state);
    for (let t = 0; t < s.ticks; t++) {
      drive(s, s.sim.frame + 1, hold);
      const evs = s.sim.step();
      for (const e of evs) {
        if ((e as { type: string }).type === 'ko') {
          out.koEvents.push([si, s.sim.frame, (e as unknown as { victim: Fighter }).victim.id]);
          continue;
        }
        out.counts[e.type] = (out.counts[e.type] ?? 0) + 1;
        events.str(eventText(e));
      }
      for (const f of s.sim.fighters) {
        if (f.state === 'ko' && prev.get(f) !== 'ko') out.kos.push([si, s.sim.frame, f.id]);
        prev.set(f, f.state);
      }
      if (s.sim.frame % CHECK_EVERY === 0 || t === s.ticks - 1) {
        out.checkpoints.push({ scenario: si, tick: s.sim.frame, state: hashState(s.sim), events: events.digest() });
        events = new Hasher();
      }
    }
  });
  return out;
}

function record(r: LegacyRun): LegacyRecord {
  return { ids: r.ids, checkpoints: r.checkpoints, kos: r.kos, counts: Object.fromEntries(Object.entries(r.counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

/** The first checkpoint where a run leaves the recording, for a readable failure. */
function firstDivergence(got: LegacyCheckpoint[], want: LegacyCheckpoint[]): string | null {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const g = got[i];
    const w = want[i];
    if (!g || !w || g.scenario !== w.scenario || g.tick !== w.tick || g.state !== w.state || g.events !== w.events) {
      return `checkpoint ${i}: got ${JSON.stringify(g)}, recorded ${JSON.stringify(w)}`;
    }
  }
  return null;
}

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const recording = env.ROTW_RECORD_LEGACY === '1';

/** Writes the fixture (recording only). */
async function writeFixture(text: string) {
  const fsModule = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsModule)) as { writeFileSync(path: unknown, text: string): void };
  const Url = (globalThis as unknown as { URL: new (url: string, base: string) => unknown }).URL;
  fs.writeFileSync(new Url('./fixtures/legacy-fight.json', (import.meta as unknown as { url: string }).url), text);
}

describe('the recorded legacy fights', () => {
  // DungeonStyle's bleeding: cuts never clot (see the header).
  beforeAll(() => setTuningValue('BLEED_TUNING', 'clotSmallS', Infinity));
  afterAll(() => resetTuning('BLEED_TUNING'));

  it.runIf(recording)(
    'records the fixture',
    async () => {
      const r = runLegacyFights();
      await writeFixture(JSON.stringify(record(r), null, 1) + '\n');
    },
    60_000,
  );

  const want = recorded as unknown as LegacyRecord;
  const matches = (got: LegacyRun) => {
    expect(got.ids).toEqual(want.ids);
    expect(firstDivergence(got.checkpoints, want.checkpoints)).toBeNull();
    expect(got.counts).toEqual(want.counts);
    expect(got.kos).toEqual(want.kos);
    // Exactly one `ko` event per knockout, on the tick it happened, naming who went down.
    expect(got.koEvents).toEqual(want.kos);
  };

  it.skipIf(recording)(
    'replay bit-identically: same fighter-state hashes, same events, same knockouts',
    () => {
      // The fixture's fighters were numbered from 1 in a fresh module: this test makes the file's first fighters,
      // from the legacy counter.
      expect(LEGACY_IDS.next).toBe(1);
      matches(runLegacyFights());
    },
    60_000,
  );

  it.skipIf(recording)(
    'replay the same with world-owned id counters, twice in one process, leaving the legacy counter alone',
    () => {
      const before = LEGACY_IDS.next;
      matches(runLegacyFights(scenarios({ ids: new IdCounter() })));
      matches(runLegacyFights(scenarios({ ids: new IdCounter(1) })));
      expect(LEGACY_IDS.next).toBe(before);
    },
    60_000,
  );
});
