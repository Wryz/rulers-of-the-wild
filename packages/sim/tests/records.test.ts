// P04, the record accessors (docs/M1-DESIGN.md §13.1, §8.3; MAP gap-7 §3.2-3.7): Fighter, BrawlerAI, AIDirector,
// Animator, Footwork and IdleBehavior each write their state as plain data with a fixed key order (toRecord) and put it
// back (restoreRecord).
//
// - record → canonical text → restore → record is identical, for fighters mid-attack, mid-step, knocked down (and in
//   the other states a fight reaches), and for every world field of a fighter; so is a perturbed record (every number
//   nudged, every boolean flipped and not, every side and closed-set field moved, every empty field filled, a limp
//   forced) restored into a twin made from the base style, and the original record restored into that used twin, so a
//   field restoreRecord forgets to set or to clear fails whatever a fresh fighter's defaults are;
// - each record's key set is the checked list of MAP gap-7's Save inventory (plus §8.3's world fields and the
//   additions named below), and every other field of a live object is listed with the reason it isn't saved, so a new
//   field fails here until someone decides; every nested record's keys are its type's fields, listed with
//   `satisfies Keys<T>` so a field added to the type fails to compile until listed;
// - a field of the wrong kind (a state outside its set, a boolean as a number, an unknown bone …) is refused;
// - Infinity (BrawlerAI.prevDist's start), NaN and −0 survive the save's number conventions;
// - the definition of done: a legacy fight saved and restored mid-way, in this process, continues bit-identically
//   (every fighter's record, Rng and rig, every AI, the sim's Rng, director, drops and projectiles, and the events,
//   compared every tick).
//
// P13's canonical writer doesn't exist yet: `canon` below applies §8.3's number rules (finite → String(v), −0 → -0,
// ±Infinity and NaN → "$inf", "$-inf", "$nan") the same way, and refuses anything that isn't plain data.
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { TrackKey } from '../src/body/animator';
import type { FootworkStyle } from '../src/body/footwork';
import type { IdleBehavior } from '../src/body/idle';
import { getPose, POSE_SPECS } from '../src/body/poses';
import { BONES, type Pose } from '../src/body/skeleton';
import { AIDirector, BRAWLER_PLAN, BrawlerAI, type BrawlerAIRecord, DEFAULT_AI } from '../src/sim/ai';
import { type CombatEvent, CombatSim } from '../src/sim/combat';
import { type Command, moveCommand } from '../src/sim/commands';
import { createEnemy, type EnemyKind } from '../src/sim/enemies';
import { type ActiveDefense, BUTTONS, type Counter, Fighter, type FighterOpts, type FighterRecord, IdCounter } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { DEFENSES, ENEMY_MOVES, PLAYER_MOVES } from '../src/sim/moves';
import type { Projectile } from '../src/sim/projectiles';
import { BRAWLER_STYLE, createPlayer } from '../src/sim/roster';
import { type WeaponDef, type WeaponId, WEAPONS, type Wound } from '../src/sim/weapons';
import { ArenaWalkable, type Walkable } from '../src/world/collision';
import type { Drive, ImpactCause, Inventory, KnockRecord, Posture, Work } from '../src/world/types';

// ---------------------------------------------------------------------------
// The save's number conventions (§8.3), and plain data only
// ---------------------------------------------------------------------------

/** Canonical JSON text of a record, keys in their record order; throws on anything but plain data. */
function canon(v: unknown, path = 'record'): string {
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return '-0';
    if (Number.isFinite(v)) return String(v);
    return v > 0 ? '"$inf"' : v < 0 ? '"$-inf"' : '"$nan"';
  }
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x, i) => canon(x, `${path}[${i}]`)).join(',')}]`;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return `{${Object.keys(v)
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k], `${path}.${k}`)}`)
      .join(',')}}`;
  }
  throw new Error(`${path} is not plain data (${typeof v}${v && typeof v === 'object' ? ` ${v.constructor?.name}` : ''})`);
}

/** A record as a load reads it back: through the canonical text. */
const reread = <T>(rec: T): T => JSON.parse(canon(rec)) as T;

/** Every −0 in a record, by path. */
function negativeZeros(v: unknown, path = '', out: string[] = []): string[] {
  if (typeof v === 'number' && Object.is(v, -0)) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => negativeZeros(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) negativeZeros((v as Record<string, unknown>)[k], `${path}.${k}`, out);
  return out;
}

// ---------------------------------------------------------------------------
// Legacy fights (the scenarios of tests/legacyReplay.test.ts), buildable twice: once to play, once to restore into
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  seed: number;
  driver: number;
  walkable?: () => Walkable;
  drops?: [WeaponId, number, number][];
  /** Every this many ticks the player throws the weapon in hand at an opponent 2.5-7 m away (0: never). */
  throwEvery?: number;
  /** Adds the fighters in creation order, the i-th with its id from opts(i); returns the command-driven player. */
  fighters(sim: CombatSim, opts: (i: number) => FighterOpts): Fighter | null;
  /** Changes applied to every copy of the fight before the tick (`fighters` by creation index). */
  script?: (fighters: readonly Fighter[], tick: number) => void;
  /** Ticks after which a copy is restored from the saved records, and how long each copy is followed. */
  saveAt: number[];
  follow: number;
}

function enemy(sim: CombatSim, kind: EnemyKind, x: number, z: number, opts: FighterOpts, weapon?: WeaponId): Fighter {
  const { fighter, ai } = createEnemy(kind, sim.rng, {}, {}, opts);
  fighter.pos.set(x, 0, z);
  fighter.yaw = Math.atan2(-x, -z);
  if (weapon) fighter.weapon = WEAPONS[weapon];
  sim.add(fighter, ai);
  return fighter;
}

function player(sim: CombatSim, opts: FighterOpts, z: number, weapon: WeaponId | null, damageMul: number): Fighter {
  const p = createPlayer(opts);
  if (weapon) p.weapon = WEAPONS[weapon];
  p.stats.damageMul = damageMul;
  p.stats.maxHp = p.hp = 900;
  p.pos.set(0, 0, z);
  sim.add(p);
  return p;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'an axe against three fighters (cuts, severing, kunai, blocks, dodges)',
    seed: 101,
    driver: 9001,
    fighters: (sim, o) => {
      const p = player(sim, o(0), 0, 'axe', 1.5);
      enemy(sim, 'brawler', 2.2, 0.4, o(1));
      enemy(sim, 'samurai', -2.4, 1.2, o(2));
      enemy(sim, 'ninja', 0.6, -3.2, o(3));
      return p;
    },
    // 0: before the first tick (every AI's prevDist still Infinity); 640: through a knockout at 854.
    saveAt: [0, 137, 640],
    follow: 300,
  },
  {
    name: 'bare hands among props, weapons on the floor (pickups, a boss)',
    seed: 202,
    driver: 9002,
    walkable: () =>
      new ArenaWalkable({ kind: 'rect', hx: 8, hz: 6 }, [
        { kind: 'circle', x: 0, z: 2, r: 0.5 },
        { kind: 'circle', x: 1.6, z: 0.2, r: 0.3 },
        { kind: 'box', x: -3, z: -2, hx: 0.6, hz: 0.6, h: 1.1 },
        { kind: 'box', x: 0.4, z: -2.2, hx: 0.25, hz: 0.6, h: 2 },
      ]),
    drops: [
      ['machete', 1, -1],
      ['sledgehammer', -1.2, 0.6],
    ],
    fighters: (sim, o) => {
      const p = player(sim, o(0), -0.5, null, 2.2);
      enemy(sim, 'knifeFighter', 3, -1, o(1));
      enemy(sim, 'kicker', -3.5, 2.5, o(2));
      enemy(sim, 'minotaur', 4, 3, o(3));
      return p;
    },
    // 70: the knife fighter is going down for the machete (the drop is re-linked by id); 905: mid-fight.
    saveAt: [70, 905],
    follow: 300,
  },
  {
    name: 'AI against AI, with idle life paused for a while (the held breath)',
    seed: 303,
    driver: 9003,
    fighters: (sim, o) => {
      const f = new Fighter('player', 'Ally', ENEMY_MOVES, { maxHp: 120, walkSpeed: 2.3, staggerResist: 0.1 }, BRAWLER_STYLE, o(0));
      f.weapon = WEAPONS.katana;
      f.autoDefense = true;
      sim.add(f, new BrawlerAI({ ...DEFAULT_AI, aggression: 1.3 }, sim.rng, BRAWLER_PLAN));
      enemy(sim, 'berserker', 2.5, 0.5, o(1));
      enemy(sim, 'imp', -2, -1.5, o(2));
      return null;
    },
    // A creature's mind pausing idle life (AC-5's "AI paused"), as a dev op would.
    script: (fs, tick) => {
      if (tick === 300) fs[1].idlePaused = true;
      if (tick === 520) fs[1].idlePaused = false;
    },
    saveAt: [350],
    follow: 300,
  },
  {
    name: 'throwing round props in a ring (the axe, bottles, cleavers, kunai in flight)',
    seed: 404,
    driver: 9004,
    walkable: () =>
      new ArenaWalkable({ kind: 'circle', r: 9 }, [
        { kind: 'circle', x: 2, z: 0, r: 0.45 },
        { kind: 'box', x: -2, z: 2.5, hx: 1, hz: 0.4, h: 0.9 },
      ]),
    drops: [
      ['bottle', 3, -2],
      ['pan', -3, -1],
      ['pipe', 0, 3],
      ['fireaxe', -1, -4.5],
    ],
    throwEvery: 200,
    fighters: (sim, o) => {
      const p = player(sim, o(0), -3, 'axe', 1.5);
      enemy(sim, 'brawler', 4, 2, o(1), 'bottle');
      enemy(sim, 'brawler', -4, 3, o(2), 'cleaver');
      enemy(sim, 'ninja', 0, 6, o(3));
      return p;
    },
    // 135: two brawlers going down for weapons, three things in flight; 601: just after the player's throw.
    saveAt: [135, 601],
    follow: 300,
  },
];

interface Hold {
  button: number;
  strafe: number;
  strafeFor: number;
}

/** The scripted player of the legacy fights, decided on one copy (`sim`) and applied to every copy. */
function decide(sc: Scenario, sim: CombatSim, p: Fighter, r: Rng, hold: Hold, next: number): { cmds: Command[]; throwNow: boolean } {
  let best: Fighter | null = null;
  let bestD = Infinity;
  for (const o of sim.fighters) {
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
    const toward = bestD > 1.6 ? 1 : bestD < 0.9 ? -0.6 : 0.1;
    x = (dx / d) * toward + (-dz / d) * hold.strafe * 0.6;
    z = (dz / d) * toward + (dx / d) * hold.strafe * 0.6;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
  }
  const throwNow = !!sc.throwEvery && next % sc.throwEvery === 0 && p.free && !!p.weapon && bestD > 2.5 && bestD < 7;
  const cmds: Command[] = [moveCommand(next, p.id, x, z)];
  if (--hold.button <= 0) {
    hold.button = Math.round(bestD < 2.2 ? r.range(4, 14) : r.range(10, 40));
    const roll = r.next();
    if (roll < 0.06) cmds.push({ tick: next, player: p.id, kind: 'button', button: 'pickup' });
    else cmds.push({ tick: next, player: p.id, kind: 'button', button: BUTTONS[Math.floor(r.next() * BUTTONS.length)] });
  }
  return { cmds, throwNow };
}

const brawlerOf = (sim: CombatSim, f: Fighter): BrawlerAI | null => {
  const b = sim.ais.get(f);
  return b instanceof BrawlerAI ? b : null;
};

/** CombatSim's private state (its records are P13's; this test copies the live objects). */
type SimInternals = { dropSerial: number; projSerial: number; prevBlade: Map<Fighter, Vector3[]> };
const internals = (sim: CombatSim) => sim as unknown as SimInternals;

const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });

/** Every bit of state a legacy fight carries from one tick to the next, as canonical text. */
function stateText(sim: CombatSim): string {
  const s = internals(sim);
  return canon({
    frame: sim.frame,
    rng: sim.rng.state,
    director: sim.director.toRecord(),
    dropSerial: s.dropSerial,
    projSerial: s.projSerial,
    fighters: sim.fighters.map((f) => ({
      record: f.toRecord(sim.drops),
      rng: f.rngState,
      rig: BONES.map((b) => {
        const j = f.rig[b];
        return [j.pos.x, j.pos.y, j.pos.z, j.rot.x, j.rot.y, j.rot.z, j.rot.w, j.s];
      }),
      ai: brawlerOf(sim, f)?.toRecord() ?? null,
      prevBlade: s.prevBlade.get(f)?.map(v3) ?? null,
    })),
    drops: sim.drops.map((d) => ({ id: d.id, weapon: d.weapon.id, pos: v3(d.pos), yaw: d.yaw, from: d.from ? v3(d.from) : null })),
    projectiles: sim.projectiles.map((p) => ({
      id: p.id,
      serial: p.serial,
      weapon: p.weapon.id,
      owner: p.owner.id,
      scale: p.scale,
      pos: v3(p.pos),
      vel: v3(p.vel),
      axis: v3(p.axis),
      omega: p.omega,
      angle: p.angle,
      dir0: v3(p.dir0),
      com: p.com,
      live: p.live,
      age: p.age,
      passed: p.passed ? [...p.passed].map((f) => f.id) : null,
    })),
    pending: sim.commands.toRecord(),
  });
}

/** An event as exact JSON: fighters by id, vectors as arrays, moves, weapons and projectiles by id. */
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
    if (key === 'projectile' && value && typeof value === 'object') {
      const p = value as { id: number; serial: number };
      return `P${p.id}|${p.serial}`;
    }
    return value;
  });
}

/** A copy of the fight: its sim and its command-driven player. */
interface Copy {
  sim: CombatSim;
  player: Fighter | null;
  /** The last tick it is followed to. */
  until: number;
}

function build(sc: Scenario): Copy {
  const sim = new CombatSim(sc.seed);
  if (sc.walkable) sim.walkable = sc.walkable();
  const ids = new IdCounter();
  const p = sc.fighters(sim, () => ({ ids }));
  for (const [w, x, z] of sc.drops ?? []) sim.addDrop(WEAPONS[w], x, z);
  return { sim, player: p, until: Infinity };
}

/**
 * A fresh copy of the fight made from `a`'s records, the way a loader will (MAP gap-7 §3.6-3.7): the same fighters
 * made again with their saved ids and added to a new sim (add() runs one updatePose, overwritten by the restore), then
 * every record put back through its canonical text, every fighter's Rng state set, the target and the weapon being
 * reached for re-linked by id.
 */
function restore(sc: Scenario, a: CombatSim, follow: number): Copy {
  const saved = reread({
    frame: a.frame,
    rng: a.rng.state,
    director: a.director.toRecord(),
    fighters: a.fighters.map((f) => f.toRecord(a.drops)),
    fighterRng: a.fighters.map((f) => f.rngState),
    ais: a.fighters.map((f) => brawlerOf(a, f)?.toRecord() ?? null),
    pending: a.commands.toRecord(),
  });
  const b = new CombatSim(sc.seed);
  if (sc.walkable) b.walkable = sc.walkable();
  const player = sc.fighters(b, (i) => ({ ids: new IdCounter(saved.fighters[i].id) }));
  expect(b.fighters.map((f) => f.id)).toEqual(saved.fighters.map((r) => r.id));
  b.frame = saved.frame;
  b.rng.state = saved.rng;
  b.director.restoreRecord(saved.director);
  // CombatSim's own state (drops, projectiles, serials, the swept blades): P13's records; copied here.
  const sa = internals(a);
  const sb = internals(b);
  const byId = (id: number) => b.fighters.find((f) => f.id === id)!;
  for (const d of a.drops) b.drops.push({ id: d.id, weapon: d.weapon, pos: d.pos.clone(), yaw: d.yaw, from: d.from?.clone() });
  for (const p of a.projectiles) {
    const q: Projectile = { ...p, owner: byId(p.owner.id), pos: p.pos.clone(), vel: p.vel.clone(), axis: p.axis.clone(), dir0: p.dir0.clone() };
    if (p.passed) q.passed = new Set([...p.passed].map((f) => byId(f.id)));
    b.projectiles.push(q);
  }
  sb.dropSerial = sa.dropSerial;
  sb.projSerial = sa.projSerial;
  for (const [f, pts] of sa.prevBlade) sb.prevBlade.set(byId(f.id), pts.map((v) => v.clone()));
  b.fighters.forEach((f, i) => {
    f.restoreRecord(saved.fighters[i], { fighters: b.fighters, drops: b.drops });
    f.rngState = saved.fighterRng[i];
    const ai = brawlerOf(b, f);
    expect(!!ai).toBe(saved.ais[i] !== null);
    if (ai) ai.restoreRecord(saved.ais[i]!);
  });
  b.commands.restoreRecord(saved.pending);
  return { sim: b, player, until: a.frame + follow };
}

/** What a run of a scenario saw: the states each restored copy was checked in, and the first divergence, if any. */
interface FollowResult {
  checked: number;
  saves: number;
  divergence: string | null;
  /** The fighter states seen while a restored copy was followed. */
  states: Set<string>;
  /** At the save ticks: weapons being reached for (in a drop still lying there), things in flight, AIs with no target yet. */
  saved: { pickups: number; inFlight: number; prevDistInfinite: number };
}

/**
 * Plays the fight; at every save tick a copy is restored from the records and followed in lockstep, with the same
 * player input and script, every tick compared with the original (state and events).
 */
function follow(sc: Scenario): FollowResult {
  const a = build(sc);
  const driver = new Rng(sc.driver);
  const hold: Hold = { button: 10, strafe: 0, strafeFor: 0 };
  const copies: Copy[] = [];
  const out: FollowResult = { checked: 0, saves: 0, divergence: null, states: new Set(), saved: { pickups: 0, inFlight: 0, prevDistInfinite: 0 } };
  const last = Math.max(...sc.saveAt) + sc.follow;
  const check = (c: Copy, what: string, want: string, events?: string) => {
    if (out.divergence) return;
    const got = stateText(c.sim);
    if (got !== want) out.divergence = `${sc.name}: ${what}: the restored copy's state differs at tick ${a.sim.frame}\n${firstDiff(got, want)}`;
    else if (events !== undefined) {
      const ge = c.sim.events.map(eventText).join('\n');
      if (ge !== events) out.divergence = `${sc.name}: ${what}: the restored copy's events differ at tick ${a.sim.frame}\n${firstDiff(ge, events)}`;
    }
    out.checked++;
  };
  for (let t = 0; t <= last && !out.divergence; t++) {
    if (sc.saveAt.includes(a.sim.frame)) {
      for (const f of a.sim.fighters) {
        if (f.toRecord(a.sim.drops).pickupTarget?.drop) out.saved.pickups++;
        if (brawlerOf(a.sim, f)?.toRecord().prevDist === Infinity) out.saved.prevDistInfinite++;
      }
      out.saved.inFlight += a.sim.projectiles.length;
      const c = restore(sc, a.sim, sc.follow);
      check(c, `just restored at ${a.sim.frame}`, stateText(a.sim));
      copies.push(c);
      out.saves++;
    }
    const live = [a, ...copies.filter((c) => c.sim.frame < c.until)];
    const next = a.sim.frame + 1;
    sc.script?.(a.sim.fighters, next);
    for (const c of live.slice(1)) sc.script?.(c.sim.fighters, next);
    if (a.player) {
      const { cmds, throwNow } = decide(sc, a.sim, a.player, driver, hold, next);
      for (const c of live) {
        if (throwNow) {
          const m = c.player!.moveDef('throwHeavy');
          if (m) c.player!.startMove(m);
        }
        for (const cmd of cmds) c.sim.commands.push({ ...cmd });
      }
    }
    for (const c of live) c.sim.step();
    if (live.length === 1) continue;
    const want = stateText(a.sim);
    const events = a.sim.events.map(eventText).join('\n');
    for (const f of a.sim.fighters) out.states.add(f.state);
    for (const c of live.slice(1)) check(c, `restored at ${c.until - sc.follow}`, want, events);
  }
  return out;
}

function firstDiff(got: string, want: string): string {
  let i = 0;
  while (i < got.length && got[i] === want[i]) i++;
  return `  got:  …${got.slice(Math.max(0, i - 160), i + 120)}\n  want: …${want.slice(Math.max(0, i - 160), i + 120)}`;
}

// ---------------------------------------------------------------------------
// The checked lists (MAP gap-7 §3.2-3.5, docs/M1-DESIGN.md §8.3)
// ---------------------------------------------------------------------------

/** FighterRecord's keys, in order. */
const FIGHTER_KEYS = [
  // MAP gap-7 §3.4, Save (position and motion, vitals, state machine, attack, defence, input and timers, other, injuries,
  // skill and stats, swing aim) and Save as references (move, aim, defense, counter, target, pickupTarget, moves).
  'id',
  'moves',
  'pos',
  'vel',
  'moveInput',
  'walkVel',
  'yaw',
  'scale',
  'hp',
  'guard',
  'poise',
  'state',
  'stateFrame',
  'stunFrames',
  'move',
  'attackEnd',
  'stuckUntil',
  'attackSerial',
  'hitThisAttack',
  'isCounterAttack',
  'perfectCounter',
  'isPerfectCounter',
  'aim',
  'strikeHeight',
  'defense',
  'counter',
  'lastDefendedSerial',
  'defenseCooldown',
  'defenseManual',
  'perfectSerial',
  'dodgedSerial',
  'weaveSide',
  'buffer',
  'target',
  'combo',
  'framesSinceBlock',
  'framesSinceHit',
  'framesSinceLanded',
  'framesSinceDefend',
  'misreadSerial',
  'lockedOn',
  'minHp',
  'stamina',
  'pickupRequest',
  'pickupTarget',
  'ammo',
  'airStep',
  'weapon',
  'wounds',
  'severed',
  'torn',
  'limbDamage',
  'hitReaction',
  'autoDefense',
  'readSkill',
  'repeatCount',
  'lastMoveId',
  'sinceMoveStart',
  'swingStamina',
  'wasBlocked',
  'stats',
  'swingJitter',
  'swingViaMid',
  'swingDy',
  // MAP gap-7 §3.5: body and animation (animator, footwork, idle, motion profile, private smoothing, pose).
  'anim',
  'footwork',
  'idle',
  'motion',
  'lookPitch',
  'bank',
  'breathPhase',
  // P02a's TODO(P04): the breath held while idle life is paused (fighter.ts).
  'heldBreath',
  'headTrack',
  'moveBlend',
  'pose',
  // docs/M1-DESIGN.md §8.3: the world fields.
  'massKg',
  // P02a: the body's mass and bone shares are fixed when a fighter is made ("saved with the fighter (P04)").
  'baseMassKg',
  'boneShare',
  'toughnessJ',
  'species',
  'playerId',
  'lastKnock',
  'armour',
  'inventory',
  // P04: derived by the verb system only when the hands change, so it is state between changes.
  'load',
  'drive',
  'posture',
  // core-fix: the posture as the body shows it (ramped toward `posture`, so it never jumps the pose).
  'postureShown',
  'work',
  'verbRequest',
  'verbAim',
  'throwAim',
  'moveFlags',
  'jumpRequest',
  'idlePaused',
];

/** A live Fighter's other fields, and why each isn't in its record. */
const FIGHTER_NOT_SAVED: Record<string, string> = {
  team: 'given at construction: the loader makes the fighter with it',
  name: 'given at construction',
  impactPose: 'rewritten before each reuse; animation keys hold poses by value (gap-7 §3.5)',
  retractPose: 'as impactPose',
  reactPose: 'as impactPose',
  turnRate: 'set at the top of every updatePose before it is read (gap-7 §3.4)',
  breath: 'written, never read (gap-7 §3.4)',
  rig: 'rebuilt by forward kinematics of the pose (gap-7 §3.5)',
  locoPose: 'scratch (gap-7 §3.5)',
  layered: 'scratch (gap-7 §3.5)',
  motionTarget: 'rewritten by targetProfile every tick (gap-7 §3.5)',
  motionInfo: 'a debug read-out (gap-7 §3.4)',
  rng: "the save's rng table, through rngState (§8.3)",
  ruler: "the save's rulers (§8.3)",
  ground: 'the world, set again when the fighter joins a sim',
  reachAt: "written by the world's controller in every phase 3 before updatePose reads it (core-fix: a dragged grip)",
  faceAt: "P28: cleared at the start of every stepBody, written by a mind's think and read by updateFacing in that tick",
};

const ANIMATOR_KEYS = ['snapshot', 'keys', 'mode', 'fadeLen', 'procT'];
const ANIMATOR_NOT_SAVED: Record<string, string> = { out: 'rewritten by every update before it is read', source: "the fighter's pose, linked at construction" };

// (hipDrop: core-fix, the hips lowered for a downhill foot.)
const FOOTWORK_KEYS = ['L', 'R', 'steps', 'firstStepper', 'lastStepper', 'shift', 'shiftTarget', 'run', 'phase', 'wasGait', 'initialized', 'gaitDur', 'gaitLead', 'limp', 'hipDrop'];
const FOOT_KEYS = ['pos', 'from', 'to', 'stepping', 't', 'dur', 'height', 'lead', 'gait'];
const FOOTWORK_NOT_SAVED: Record<string, string> = {
  style: 'given at construction (its `limp`, set by wounds at run time, is the record\'s `limp`)',
  mods: "copied from the fighter's motion profile by every updatePose before it is read (gap-7 §3.5)",
  landed: 'output the client drains (gap-7 §3.5)',
};

const IDLE_KEYS = ['feint', 'paw', 't', 'bouncePhase', 'engagedBlend', 'feintTimer', 'shuffleTimer', 'pawTimer', 'off', 'offTarget', 'feints', 'shuffles', 'mods'];
const IDLE_NOT_SAVED: Record<string, string> = {
  style: 'given at construction',
  rng: "the fighter's Rng (restored with it, gap-7 §6)",
  paused: "set from the fighter's idlePaused before every tick",
};

/** MAP gap-7 §3.3: the 20 history fields. */
const BRAWLER_KEYS = [
  'cooldown',
  'strafe',
  'strafeTimer',
  'detourSide',
  'detourFrames',
  'chain',
  'decidedSerial',
  'willBlock',
  'punishDelay',
  'crowdedFor',
  'circleSide',
  'circleFrames',
  'winded',
  'specialCool',
  'sinceOwnAttack',
  'waited',
  'retreatFor',
  'prevDist',
  'pinned',
  'lastPos',
];
const BRAWLER_NOT_SAVED: Record<string, string> = {
  ownsTarget: 'a constant',
  cfg: 'a setting its maker gives it (gap-7 §3.3)',
  plan: 'a setting its maker gives it (gap-7 §3.3)',
  rng: "the sim's Rng, shared, never copied (gap-7 §3.3)",
  director: 'linked by CombatSim.add (gap-7 §3.3)',
  drops: 'linked by CombatSim.add (gap-7 §3.3)',
  walkable: 'set at the top of every think (gap-7 §3.3)',
  armed: 'a cache rebuilt from the weapon (gap-7 §3.3)',
};

const DIRECTOR_KEYS = ['lastAttack'];
const DIRECTOR_NOT_SAVED: Record<string, string> = { frame: "set from the sim's frame every tick (gap-7 §3.2)", gap: 'a setting' };

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Every own field of a live object is in its record or in the not-saved list, and nothing is in both. */
function expectAccountedFor(obj: object, saved: string[], notSaved: Record<string, string>, extraSaved: string[] = []) {
  const recordFields = saved.filter((k) => !extraSaved.includes(k));
  for (const k of Object.keys(notSaved)) expect(recordFields).not.toContain(k);
  expect(sorted(Object.keys(obj))).toEqual(sorted([...recordFields, ...Object.keys(notSaved)]));
}

// ---------------------------------------------------------------------------
// Round trips: plain, perturbed, filled, and into a fighter already used
// ---------------------------------------------------------------------------

/** A fresh fighter like `f` (same id, side, move table), made from its base style: the run-time limp left out. */
function twin(f: Fighter): Fighter {
  const footwork = { ...f.footwork.style };
  delete footwork.limp;
  return new Fighter(f.team, f.name, f.moves, {}, { footwork, idle: { ...f.idle.style } }, { ids: new IdCounter(f.id) });
}

type Rec = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(canon(v)) as T;

/**
 * A fighter with every nullable field set, every collection filled and every flag off its default: the world fields,
 * a synthesised tool, a limp, a defence, a counter, a buffered press, a weapon being reached for, a feint and a paw,
 * a stuck weapon, a scale ≠ 1, and idle life paused mid-breath (the held breath).
 */
function maximalFighter() {
  const sim = new CombatSim(5);
  const ids = new IdCounter(3);
  const f = createPlayer({ ids });
  sim.add(f);
  const { fighter: e, ai } = createEnemy('brawler', sim.rng, {}, {}, { ids });
  e.pos.set(0, 0, 1.4);
  sim.add(e, ai);
  for (let i = 0; i < 40; i++) f.updatePose(0, 0, 0);
  f.idlePaused = true;
  for (let i = 0; i < 5; i++) f.updatePose(0, 0, 0);
  f.startWork({
    kind: 'lash',
    frames: 90,
    actAt: 60,
    faceAt: { x: 1, y: 0, z: 2 },
    keys: [
      { f: 10, pose: getPose('kneel'), ease: 'out' },
      { f: 90, pose: getPose('guard') },
    ],
    cmd: { tick: 5, player: 1, kind: 'verb', verb: 'lash', target: 3, second: 4, at: [1, 2, 3], at2: [4, 5, 6] },
  });
  f.stateFrame = 12;
  f.species = 'ape';
  f.playerId = 'p1';
  f.massKg = 66;
  f.toughnessJ = 20;
  f.armour = { head: 20, chest: 40 };
  f.lastKnock = { tick: 12, cause: { kind: 'entity', entityId: 7, fighterId: null, credit: ['p1'], held: false, feature: 'falling' }, by: 4 };
  f.inventory = { hands: { entity: 3, mode: 'wield', grip: { x: 0.1, y: 0.2, z: -0 }, twoHanded: true, joint: null }, belt: [4, null, 9], back: 11 };
  f.load = { massKg: 40, mode: 'drag' };
  f.drive = { heading: 1.2, speed: 7, accel: 5, climb: true };
  f.posture = { id: 'headLow', weight: 0.4 };
  f.verbRequest = { cmd: { tick: 5, player: 1, kind: 'verb', verb: 'take', target: 3, at: [1, 2, 3] }, frames: 12 };
  f.verbAim = new Vector3(1, 1, 3);
  f.throwAim = { dir: new Vector3(0, 0.6, 0.8), speedFrac: 0.5, techSpeed: 14 };
  f.moveFlags = 3;
  f.jumpRequest = 4;
  f.footwork.style.limp = { side: 'L', amount: 0.6 };
  const tool: WeaponDef = { ...WEAPONS.machete, length: 0.47, mass: 1.15, sharpness: 0.9 };
  f.weapon = tool;
  f.ammo = { weapon: WEAPONS.kunai, count: 3 };
  f.limbDamage.foreArmL = 12.5;
  f.limbDamage.thighR = 3;
  f.torn.add('earL');
  f.severed.add('foreArmL');
  f.wounds.push({ bone: 'upperArmL', local: [0, -0.28, 0], angle: 0.5, length: 0.1, bleed: 0.8, floor: 0.2, clot: 0.25, stump: 'foreArmL' });
  f.wounds.push({ bone: 'chest', local: [0.05, 0.1, 0.12], angle: -0.3, length: 0.08, bleed: 0.4, floor: 0.1, clot: 0.6 });
  // What a fight sets (state 'pickup' cleared these as startWork began).
  const drop = sim.addDrop(WEAPONS.bat, 1, 1);
  f.pickupTarget = { pos: drop.pos, weapon: drop.weapon, grabAt: 9 };
  f.defense = { def: DEFENSES.weave, threatSerial: 100004, phase: 'active', success: true, side: -1 };
  f.counter = { kind: 'duck', frames: 9 };
  f.buffer = { button: 'lkick', frames: 7 };
  f.target = e;
  f.idle.feint = { kind: 'level', t: 3, dur: 20 };
  (f.idle as unknown as { paw: { t: number; dur: number } }).paw = { t: 2, dur: 14 };
  f.scale = 1.2;
  f.minHp = 1;
  f.attackEnd = 30;
  f.stuckUntil = 24;
  f.perfectCounter = true;
  f.isPerfectCounter = true;
  f.perfectSerial = 77;
  f.wasBlocked = true;
  f.pickupRequest = 5;
  f.updatePose(0, 0, 0);
  return { sim, f, e, tool, drop };
}

/** The maximal fighter's record, the donor `fill` takes a value from wherever a record has none. */
const DONOR: Rec = (() => {
  const { sim, f } = maximalFighter();
  const r = clone(f.toRecord(sim.drops)) as unknown as Rec;
  // Not linked to the donor's sim: the weapon being reached for lies in no drop of another fight.
  (r.pickupTarget as Rec).drop = null;
  return r;
})();

/** Top-level fields `fill` leaves alone: references into the fighter's own tables and fight. */
const FILL_SKIP = new Set(['moves', 'move', 'aim', 'target']);

/** A copy of a record with every null or empty field (and the nested footwork, idle and animator ones) filled from DONOR. */
function fill(r: FighterRecord): FighterRecord {
  const out = clone(r) as unknown as Rec;
  const take = (o: Rec, d: Rec, k: string) => {
    const v = o[k];
    if (v === null || (Array.isArray(v) && v.length === 0)) o[k] = clone(d[k]);
  };
  for (const k of Object.keys(out)) if (!FILL_SKIP.has(k)) take(out, DONOR, k);
  for (const k of ['limp', 'firstStepper', 'lastStepper']) take(out.footwork as Rec, DONOR.footwork as Rec, k);
  for (const k of ['feint', 'paw']) take(out.idle as Rec, DONOR.idle as Rec, k);
  take(out.anim as Rec, DONOR.anim as Rec, 'keys');
  return out as unknown as FighterRecord;
}

/** Every value a field of a closed set can take, by path (array elements as `[]`): `perturb` moves each to the next. */
const NEXT: Record<string, readonly (string | null)[]> = {
  state: ['idle', 'walk', 'attack', 'defend', 'hitstun', 'blockstun', 'guardbreak', 'knockdown', 'getup', 'ko', 'celebrate', 'pickup', 'tripped'],
  strikeHeight: ['high', 'mid', 'low'],
  hitReaction: Object.keys(POSE_SPECS),
  'defense.kind': ['block', 'duck', 'weave', 'slide'],
  'defense.phase': ['startup', 'active', 'recovery'],
  'counter.kind': ['block', 'duck', 'weave', 'slide'],
  'buffer.button': ['lpunch', 'rpunch', 'lkick', 'rkick'],
  'anim.mode': ['track', 'procedural'],
  'anim.keys[].ease': [null, 'linear', 'in', 'out', 'inOut', 'snap'],
  'work.keys[].ease': [null, 'linear', 'in', 'out', 'inOut', 'snap'],
  'work.kind': ['focus', 'take', 'drop', 'stow', 'draw', 'place', 'throw', 'lash', 'tie', 'untie', 'bend', 'shape', 'cut', 'dig', 'pull'],
  'footwork.firstStepper': ['L', 'R', null],
  'footwork.lastStepper': ['L', 'R', null],
  'footwork.limp.side': ['L', 'R'],
  'idle.feint.kind': ['jab', 'shoulder', 'level', 'step'],
  species: ['human', 'ape', 'giantApe'],
  'lastKnock.cause.kind': ['entity', 'terrain', 'creature', 'bleed'],
  'lastKnock.cause.feature': ['sharpPoint', 'falling', 'swinging', 'rolling', 'cover', 'rope', 'fall', 'creature'],
  'inventory.hands.mode': ['wield', 'carry', 'drag', 'ropeEnd'],
  'load.mode': ['carry', 'drag', 'rope'],
  'posture.id': ['crouch', 'carryFront', 'carryShoulder', 'dragBack', 'haulRope', 'workLow', 'workKnap', 'digScoop', 'aimThrow', 'headLow', 'sniff', 'climbOut'],
};
/** Free strings: `perturb` appends to them. */
const APPEND = new Set(['lastMoveId', 'playerId', 'torn[]', 'lastKnock.cause.credit[]', 'chain']);
/** Sides (±1): `perturb` turns them over. */
const SIGNS = new Set(['weaveSide', 'defense.side', 'detourSide', 'circleSide']);
/** Fields `perturb` leaves alone: ids that are looked up, and references into the fighter's own tables. */
const KEEP = new Set(['id', 'target', 'pickupTarget.drop', 'moves', 'move', 'aim', 'verbRequest.cmd', 'work.cmd', 'weapon.id', 'ammo.weapon.id', 'pickupTarget.weapon.id']);

/**
 * A copy of a record with every number nudged (each by a different amount), every boolean flipped (when `flip`), every
 * side turned over, every closed-set field moved to its next value and every free string changed: restored into a
 * fresh twin it leaves no field at the twin's default, so a field restoreRecord forgets shows.
 */
function perturb<T>(rec: T, flip: boolean): T {
  let c = 0;
  const walk = (v: unknown, path: string, parent: Rec | null): unknown => {
    if (KEEP.has(path)) return v;
    // A weapon being reached for in a drop is re-linked to that drop: its pos and weapon come from the drop.
    if ((path === 'pickupTarget.pos' || path === 'pickupTarget.weapon') && parent?.drop !== null) return v;
    if (path in NEXT) {
      const vals = NEXT[path];
      const i = vals.indexOf(v as string | null);
      if (i < 0) throw new Error(`perturb: ${path} = ${JSON.stringify(v)} is not in its set`);
      return vals[(i + 1) % vals.length];
    }
    if (APPEND.has(path)) return v === null ? 'perturbed' : `${v as string}~`;
    if (SIGNS.has(path)) return -(v as number);
    if (typeof v === 'number') return Number.isFinite(v) ? v + 0.25 + (c++ % 97) / 1000 : v;
    if (typeof v === 'boolean') return flip ? !v : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, `${path}[]`, null));
    if (v && typeof v === 'object') {
      const o: Rec = {};
      for (const k of Object.keys(v)) o[k] = walk((v as Rec)[k], path ? `${path}.${k}` : k, v as Rec);
      return o;
    }
    return v;
  };
  return walk(clone(rec), '', null) as T;
}

/**
 * The round trips of one fighter's record (each through the canonical text):
 * - into a fresh twin: the same text, and the rig rebuilt bit for bit;
 * - the record filled from DONOR and perturbed (booleans flipped, and once more unflipped), into a fresh twin: the
 *   perturbed text back, so every field is restored whatever the twin's defaults;
 * - then the original record into that used twin (filled, perturbed, limping): the original text back, so restoring
 *   clears what a record doesn't hold (nulls, empty collections, no limp).
 */
function expectRoundTrip(f: Fighter, sim: CombatSim) {
  const rec = f.toRecord(sim.drops);
  const text = canon(rec);
  const ctx = { fighters: sim.fighters, drops: sim.drops };
  const g = twin(f);
  g.restoreRecord(JSON.parse(text) as FighterRecord, ctx);
  g.rngState = f.rngState;
  expect(canon(g.toRecord(sim.drops))).toBe(text);
  for (const b of BONES) {
    expect(g.rig[b].pos.toArray()).toEqual(f.rig[b].pos.toArray());
    expect(g.rig[b].rot.toArray()).toEqual(f.rig[b].rot.toArray());
  }
  for (const flip of [true, false]) {
    const p = perturb(fill(rec), flip);
    const used = twin(f);
    used.restoreRecord(clone(p), ctx);
    expect(canon(used.toRecord(sim.drops))).toBe(canon(p));
    // (Idle life reads its pause from the fighter's: kept in step at once, not only at the next tick.)
    expect(used.idle.paused).toBe(p.idlePaused);
    used.restoreRecord(JSON.parse(text) as FighterRecord, ctx);
    expect(canon(used.toRecord(sim.drops))).toBe(text);
    expect(used.idle.paused).toBe(rec.idlePaused);
  }
}

/** The same for a BrawlerAI's record (filled with a chain and specials, perturbed, then the original into the used AI). */
function expectAIRoundTrip(rec: BrawlerAIRecord, rng: Rng) {
  const text = canon(rec);
  const fresh = new BrawlerAI({ ...DEFAULT_AI }, rng);
  fresh.restoreRecord(JSON.parse(text) as BrawlerAIRecord);
  expect(canon(fresh.toRecord())).toBe(text);
  const filled: BrawlerAIRecord = {
    ...clone(rec),
    chain: rec.chain ?? 'hookChain',
    specialCool: rec.specialCool.length ? rec.specialCool : [['stomp', 5], ['teep', -2]],
  };
  for (const flip of [true, false]) {
    const p = perturb(filled, flip);
    const used = new BrawlerAI({ ...DEFAULT_AI }, rng);
    used.restoreRecord(clone(p));
    expect(canon(used.toRecord())).toBe(canon(p));
    used.restoreRecord(JSON.parse(text) as BrawlerAIRecord);
    expect(canon(used.toRecord())).toBe(text);
  }
}

/**
 * The time limit of the tests that play a fight (Vitest's default is 5 s): alone they take 0.5-2.5 s, but `npm test`
 * runs every file at once, and on a loaded machine they took up to 12 s.
 */
const SLOW = 60_000;

describe('records round-trip', () => {
  it('for fighters mid-attack (timed and untimed, stuck, ended), mid-step, knocked down, sized ≠ 1 and in every other state a fight reaches', () => {
    const want: Record<string, (f: Fighter) => boolean> = {
      'mid-attack, timed move': (f) => f.state === 'attack' && !!f.move && f.moveDef(f.move.id) !== f.move,
      'mid-attack, untimed move': (f) => f.state === 'attack' && !!f.move && f.moveDef(f.move.id) === f.move,
      'mid-attack with an aim': (f) => f.state === 'attack' && !!f.aim,
      'with a weapon stuck in a body': (f) => f.state === 'attack' && f.stuckUntil > f.stateFrame,
      'with an attack that has met a body (attackEnd)': (f) => f.state === 'attack' && f.attackEnd > 0,
      'mid-step': (f) => f.footwork.L.stepping !== f.footwork.R.stepping,
      'walking gait': (f) => f.footwork.L.gait || f.footwork.R.gait,
      'knocked down': (f) => f.state === 'knockdown',
      'getting up': (f) => f.state === 'getup',
      defending: (f) => f.state === 'defend' && !!f.defense,
      'in hitstun': (f) => f.state === 'hitstun',
      'with a counter window': (f) => !!f.counter,
      'with a buffered press': (f) => !!f.buffer,
      'with wounds': (f) => f.wounds.length > 0,
      'going down for a weapon': (f) => f.state === 'pickup' && !!f.pickupTarget,
      'with throwing knives': (f) => !!f.ammo,
      'of a size other than 1': (f) => f.scale !== 1,
      knocked: (f) => f.state === 'ko',
    };
    const found = new Set<string>();
    for (const sc of [SCENARIOS[0], SCENARIOS[1], SCENARIOS[3]]) {
      const c = build(sc);
      const driver = new Rng(sc.driver);
      const hold: Hold = { button: 10, strafe: 0, strafeFor: 0 };
      for (let t = 0; t < 1500 && found.size < Object.keys(want).length; t++) {
        if (c.player) for (const cmd of decide(sc, c.sim, c.player, driver, hold, c.sim.frame + 1).cmds) c.sim.commands.push(cmd);
        c.sim.step();
        for (const f of c.sim.fighters) {
          for (const [what, test] of Object.entries(want)) {
            if (found.has(what) || !test(f)) continue;
            expectRoundTrip(f, c.sim);
            found.add(what);
          }
        }
      }
    }
    expect(sorted(found)).toEqual(sorted(Object.keys(want)));
  }, SLOW);

  it('for fighters squared up and still: feinting, pawing and re-stancing', () => {
    const sim = new CombatSim(9);
    const ids = new IdCounter();
    const p = createPlayer({ ids });
    sim.add(p);
    const { fighter: e, ai } = createEnemy('brawler', sim.rng, {}, { passive: true }, { ids });
    e.pos.set(0, 0, 1.6);
    e.yaw = Math.PI;
    sim.add(e, ai);
    const want = { feint: false, paw: false, shuffle: false };
    for (let t = 0; t < 1200 && !(want.feint && want.paw && want.shuffle); t++) {
      sim.step();
      for (const f of sim.fighters) {
        const idle = f.idle.toRecord();
        const hit = { feint: !!idle.feint, paw: !!idle.paw, shuffle: idle.offTarget[0] !== 0 };
        for (const k of ['feint', 'paw', 'shuffle'] as const) {
          if (want[k] || !hit[k]) continue;
          expectRoundTrip(f, sim);
          want[k] = true;
        }
      }
    }
    expect(want).toEqual({ feint: true, paw: true, shuffle: true });
  }, SLOW);

  it('for every world field of a fighter, a synthesised tool by value, a limp and idle life paused mid-breath', () => {
    const { sim, f, tool, drop } = maximalFighter();
    const rec = f.toRecord(sim.drops);
    expect(Object.keys(rec)).toEqual(FIGHTER_KEYS);
    expect(rec.heldBreath).not.toBe(0);
    expect(rec.weapon).toEqual({ id: 'machete', def: { ...tool } });
    expect(rec.ammo).toEqual({ weapon: { id: 'kunai', def: null }, count: 3 });
    expect(rec.pickupTarget!.drop).toBe(drop.id);
    expectRoundTrip(f, sim);
    const g = twin(f);
    g.restoreRecord(reread(rec), { fighters: sim.fighters, drops: sim.drops });
    // A WEAPONS entry comes back as that very object (the sim compares weapons by identity); a tool by value; the
    // weapon being reached for is the drop's own pos and weapon (the pickup finds the drop by them).
    expect(g.ammo!.weapon).toBe(WEAPONS.kunai);
    expect(g.weapon).not.toBe(tool);
    expect(g.weapon).toEqual(tool);
    expect(g.pickupTarget!.pos).toBe(drop.pos);
    expect(g.pickupTarget!.weapon).toBe(drop.weapon);
    expect(g.target).toBe(f.target);
    expect(g.footwork.style.limp).toEqual({ side: 'L', amount: 0.6 });
    expect(Object.is(g.inventory!.hands!.grip.z, -0)).toBe(true);
    // The animation keys and the work's keys are fresh poses with the same numbers.
    expect(g.work!.keys[0].pose).not.toBe(f.work!.keys[0].pose);
    expect(g.work!.keys[0].pose.root.toArray()).toEqual(f.work!.keys[0].pose.root.toArray());
    // Without the drops the weapon being reached for is detached from its drop (the pickup would fail): never.
    g.restoreRecord(reread(rec), { fighters: sim.fighters, drops: [] });
    expect(g.pickupTarget!.pos).not.toBe(drop.pos);
  });

  it('into a fighter already used: a fresh record clears everything the used one held (a limp, wounds, nulls)', () => {
    const { sim, f } = maximalFighter();
    const fresh = createPlayer({ ids: new IdCounter(f.id) });
    const text = canon(fresh.toRecord([]));
    f.restoreRecord(JSON.parse(text) as FighterRecord, { fighters: sim.fighters, drops: sim.drops });
    expect(canon(f.toRecord(sim.drops))).toBe(text);
    expect(f.footwork.style.limp).toBeUndefined();
    expect([f.wounds.length, f.severed.size, f.torn.size, Object.keys(f.limbDamage).length]).toEqual([0, 0, 0, 0]);
  });

  it('for a BrawlerAI and the director, the specials it is waiting on in their order', () => {
    const sc = SCENARIOS[1];
    const c = build(sc);
    for (let t = 0; t < 900; t++) c.sim.step();
    let n = 0;
    for (const f of c.sim.fighters) {
      const ai = brawlerOf(c.sim, f);
      if (!ai) continue;
      const rec = ai.toRecord();
      expect(Object.keys(rec)).toEqual(BRAWLER_KEYS);
      expectAIRoundTrip(rec, c.sim.rng);
      n++;
    }
    expect(n).toBe(3);
    expectAIRoundTrip(new BrawlerAI({ ...DEFAULT_AI }, new Rng(1)).toRecord(), new Rng(1));
    const d = new AIDirector();
    d.restoreRecord(reread(c.sim.director.toRecord()));
    expect(d.toRecord()).toEqual(c.sim.director.toRecord());
    d.restoreRecord({ lastAttack: 1234.5 });
    expect(d.toRecord()).toEqual({ lastAttack: 1234.5 });
  }, SLOW);

  it('rejects a record of another fighter or another move table, and any field of the wrong kind', () => {
    const sim = new CombatSim(1);
    const f = createPlayer({ ids: new IdCounter(4) });
    sim.add(f);
    const rec = reread(f.toRecord(sim.drops));
    const ctx = { fighters: sim.fighters, drops: sim.drops };
    expect(() => createPlayer({ ids: new IdCounter(5) }).restoreRecord(rec, ctx)).toThrow(/fighter 4/);
    const enemyMoves = new Fighter('enemy', 'E', ENEMY_MOVES, {}, undefined, { ids: new IdCounter(4) });
    expect(() => enemyMoves.restoreRecord(rec, ctx)).toThrow(/moves/);
    const broken: [string, (r: Rec) => void, RegExp][] = [
      ['a state outside the set', (r) => (r.state = 'flying'), /state/],
      ['a boolean as a number', (r) => (r.lockedOn = 1), /lockedOn/],
      ['a side of 0', (r) => (r.weaveSide = 0), /weaveSide/],
      ['an unknown bone', (r) => (r.severed = ['tail']), /severed/],
      ['a pose name that is none', (r) => (r.hitReaction = 'moonwalk'), /hitReaction/],
      ['a missing number', (r) => delete r.stamina, /stamina is missing/],
      ['a null number', (r) => (r.hp = null), /hp/],
      ['an unknown foot', (r) => ((r.footwork as Rec).lastStepper = 'M'), /lastStepper/],
      ['an unknown ease', (r) => ((r.anim as Rec).keys = [{ ...(DONOR.anim as { keys: Rec[] }).keys[0], ease: 'wobble' }]), /ease/],
      ['an unknown animator mode', (r) => ((r.anim as Rec).mode = 'paused'), /mode/],
      ['an unknown feint', (r) => ((r.idle as Rec).feint = { kind: 'wink', t: 0, dur: 3 }), /feint\.kind/],
      ['an unknown posture', (r) => (r.posture = { id: 'dance', weight: 1 }), /posture\.id/],
      ['an unknown verb', (r) => (r.work = { ...(DONOR.work as Rec), kind: 'juggle' }), /work\.kind/],
      ['an unknown cause', (r) => (r.lastKnock = { tick: 1, cause: { ...((DONOR.lastKnock as Rec).cause as Rec), feature: 'magic' }, by: null }), /cause\.feature/],
      ['an unknown weapon', (r) => (r.weapon = { id: 'lightsaber', def: null }), /lightsaber/],
      // One weapon reader for fighters and CombatSim (fighter.ts weaponFromRecord, core-fix): a definition by value of
      // another weapon, or a weapon that is no record, is refused by name.
      ['a definition by value of another weapon', (r) => (r.weapon = { id: 'katana', def: { ...WEAPONS.katana, id: 'kunai' } }), /weapon\.def\.id/],
      ['a weapon that is no record', (r) => (r.ammo = { weapon: 'kunai', count: 3 }), /ammo\.weapon is "kunai", not an object/],
      ['a move from no table', (r) => (r.move = { source: 'pocket', id: 'jab', tempoKey: null }), /move\.source/],
      ['a move its table lacks', (r) => (r.move = { source: 'own', id: 'moonPunch', tempoKey: null }), /moonPunch/],
      ['a tempo bucket as a number', (r) => (r.move = { source: 'own', id: Object.keys(PLAYER_MOVES)[0], tempoKey: 1.1 }), /move\.tempoKey/],
      ['a tempo bucket that rebuilds another', (r) => (r.move = { source: 'own', id: Object.keys(PLAYER_MOVES)[0], tempoKey: '1.1' }), /doesn't rebuild/],
      ['a boneShare short of a bone', (r) => (r.boneShare = (r.boneShare as unknown[]).slice(1)), /boneShare/],
    ];
    for (const [what, breakIt, err] of broken) {
      const r = clone(rec) as unknown as Rec;
      breakIt(r);
      expect(() => twin(f).restoreRecord(r as unknown as FighterRecord, ctx), what).toThrow(err);
    }
    const ai = new BrawlerAI({ ...DEFAULT_AI }, new Rng(1));
    expect(() => ai.restoreRecord({ ...ai.toRecord(), circleSide: 2 as unknown as 1 })).toThrow(/circleSide/);
    expect(() => ai.restoreRecord({ ...ai.toRecord(), winded: 'no' as unknown as boolean })).toThrow(/winded/);
  });
});

describe('the number conventions of the save (§8.3)', () => {
  it("keep a fresh BrawlerAI's Infinity (prevDist) as '$inf', and refuse the null JSON.stringify would write", () => {
    const ai = new BrawlerAI({ ...DEFAULT_AI }, new Rng(1));
    const rec = ai.toRecord();
    expect(rec.prevDist).toBe(Infinity);
    const text = canon(rec);
    expect(text).toContain('"prevDist":"$inf"');
    const back = new BrawlerAI({ ...DEFAULT_AI }, new Rng(1));
    back.restoreRecord(JSON.parse(text));
    expect(back.toRecord().prevDist).toBe(Infinity);
    expect(canon(back.toRecord())).toBe(text);
    expect(() => back.restoreRecord(JSON.parse(JSON.stringify(rec)))).toThrow(/prevDist/);
  });

  it('read -Infinity and NaN back as well', () => {
    const ai = new BrawlerAI({ ...DEFAULT_AI }, new Rng(1));
    const rec = { ...ai.toRecord(), prevDist: -Infinity, cooldown: NaN };
    const back = new BrawlerAI({ ...DEFAULT_AI }, new Rng(1));
    back.restoreRecord(reread(rec));
    expect(back.toRecord().prevDist).toBe(-Infinity);
    expect(back.toRecord().cooldown).toBeNaN();
  });

  it('keep every −0 of a fighter mid-fight (poses and keys carry many)', () => {
    const c = build(SCENARIOS[0]);
    for (let t = 0; t < 300; t++) c.sim.step();
    let zeros = 0;
    for (const f of c.sim.fighters) {
      const rec = f.toRecord(c.sim.drops);
      const paths = negativeZeros(rec);
      zeros += paths.length;
      const g = twin(f);
      g.restoreRecord(reread(rec), { fighters: c.sim.fighters, drops: c.sim.drops });
      expect(negativeZeros(g.toRecord(c.sim.drops))).toEqual(paths);
    }
    expect(zeros).toBeGreaterThan(0);
  }, SLOW);
});

describe("each record's keys are the checked list (MAP gap-7 §3.2-3.5's Save inventory, §8.3's world fields)", () => {
  const c = build(SCENARIOS[0]);
  for (let t = 0; t < 400; t++) c.sim.step();
  const f = c.sim.fighters[1];
  const ai = brawlerOf(c.sim, f)!;

  it('Fighter: the record keys in order, and every other field of a live fighter named with its reason', () => {
    const rec = f.toRecord(c.sim.drops);
    expect(Object.keys(rec)).toEqual(FIGHTER_KEYS);
    expectAccountedFor(f, FIGHTER_KEYS, FIGHTER_NOT_SAVED);
    expect(rec.stats && Object.keys(rec.stats)).toEqual(Object.keys(f.stats));
    expect(Object.keys(rec.motion)).toEqual(Object.keys(f.motion));
    expect(rec.boneShare.map(([b]) => b)).toEqual([...BONES]);
    expect(rec.pose.rot).toHaveLength(BONES.length);
  });

  it('Animator, Footwork (and each foot), IdleBehavior', () => {
    expect(Object.keys(f.anim.toRecord())).toEqual(ANIMATOR_KEYS);
    expectAccountedFor(f.anim, ANIMATOR_KEYS, ANIMATOR_NOT_SAVED);
    const fw = f.footwork.toRecord();
    expect(Object.keys(fw)).toEqual(FOOTWORK_KEYS);
    expectAccountedFor(f.footwork, FOOTWORK_KEYS, FOOTWORK_NOT_SAVED, ['limp']);
    expect(Object.keys(fw.L)).toEqual(FOOT_KEYS);
    expectAccountedFor(f.footwork.L, FOOT_KEYS, { side: 'which foot it is' });
    expect(Object.keys(f.idle.toRecord())).toEqual(IDLE_KEYS);
    expectAccountedFor(f.idle, IDLE_KEYS, IDLE_NOT_SAVED);
  });

  it('BrawlerAI (its 20 history fields) and AIDirector', () => {
    expect(Object.keys(ai.toRecord())).toEqual(BRAWLER_KEYS);
    expect(BRAWLER_KEYS).toHaveLength(20);
    expectAccountedFor(ai, BRAWLER_KEYS, BRAWLER_NOT_SAVED);
    expect(Object.keys(c.sim.director.toRecord())).toEqual(DIRECTOR_KEYS);
    expectAccountedFor(c.sim.director, DIRECTOR_KEYS, DIRECTOR_NOT_SAVED);
  });

  it('every nested record: its keys are its type\'s fields (typed here, so a field added later must be listed), and the live object has no others', () => {
    // `satisfies Keys<T>`: a field added to one of these types (by P08, P09, P11, P14 …) fails to compile here until it
    // is listed, and once listed fails below until the record carries it, instead of being dropped from saves silently.
    type Keys<T> = Record<keyof T, true>;
    const { sim, f, tool } = maximalFighter();
    const rec = f.toRecord(sim.drops);
    const idle = f.idle.toRecord();
    const fw = f.footwork.toRecord();
    const live = f.idle as unknown as { paw: object };
    const shift = f.footwork as unknown as { shift: object; shiftTarget: object };
    const nested: { name: string; live: object | null | undefined; record: object | null | undefined; fields: object; renamed?: Record<string, string>; added?: string[] }[] = [
      { name: 'defense', live: f.defense, record: rec.defense, fields: { def: true, threatSerial: true, phase: true, success: true, side: true } satisfies Keys<ActiveDefense>, renamed: { def: 'kind' } },
      { name: 'counter', live: f.counter, record: rec.counter, fields: { kind: true, frames: true } satisfies Keys<Counter> },
      { name: 'buffer', live: f.buffer, record: rec.buffer, fields: { button: true, frames: true } satisfies Keys<NonNullable<Fighter['buffer']>> },
      { name: 'pickupTarget', live: f.pickupTarget, record: rec.pickupTarget, fields: { pos: true, weapon: true, grabAt: true } satisfies Keys<NonNullable<Fighter['pickupTarget']>>, added: ['drop'] },
      { name: 'ammo', live: f.ammo, record: rec.ammo, fields: { weapon: true, count: true } satisfies Keys<NonNullable<Fighter['ammo']>> },
      { name: 'weapon (by value)', live: tool, record: rec.weapon?.def, fields: Object.fromEntries(Object.keys(tool).map((k) => [k, true])) },
      ...f.wounds.map((w, i) => ({
        name: `wounds[${i}]`,
        live: w,
        record: rec.wounds[i],
        fields: { bone: true, local: true, angle: true, length: true, bleed: true, floor: true, clot: true, stump: true } satisfies Keys<Wound>,
      })),
      { name: 'lastKnock', live: f.lastKnock, record: rec.lastKnock, fields: { tick: true, cause: true, by: true } satisfies Keys<KnockRecord> },
      {
        name: 'lastKnock.cause',
        live: f.lastKnock?.cause,
        record: rec.lastKnock?.cause,
        fields: { kind: true, entityId: true, fighterId: true, credit: true, held: true, feature: true } satisfies Keys<ImpactCause>,
      },
      { name: 'inventory', live: f.inventory, record: rec.inventory, fields: { hands: true, belt: true, back: true } satisfies Keys<Inventory> },
      {
        name: 'inventory.hands',
        live: f.inventory?.hands,
        record: rec.inventory?.hands,
        fields: { entity: true, mode: true, grip: true, twoHanded: true, joint: true } satisfies Keys<NonNullable<Inventory['hands']>>,
      },
      { name: 'load', live: f.load, record: rec.load, fields: { massKg: true, mode: true } satisfies Keys<NonNullable<Fighter['load']>> },
      { name: 'drive', live: f.drive, record: rec.drive, fields: { heading: true, speed: true, accel: true, climb: true } satisfies Keys<Drive> },
      { name: 'posture', live: f.posture, record: rec.posture, fields: { id: true, weight: true } satisfies Keys<Posture> },
      { name: 'work', live: f.work, record: rec.work, fields: { kind: true, frames: true, actAt: true, faceAt: true, keys: true, cmd: true } satisfies Keys<Work> },
      { name: 'work.keys[0]', live: f.work?.keys[0], record: rec.work?.keys[0], fields: { f: true, pose: true, ease: true } satisfies Keys<TrackKey> },
      { name: 'verbRequest', live: f.verbRequest, record: rec.verbRequest, fields: { cmd: true, frames: true } satisfies Keys<NonNullable<Fighter['verbRequest']>> },
      { name: 'throwAim', live: f.throwAim, record: rec.throwAim, fields: { dir: true, speedFrac: true, techSpeed: true } satisfies Keys<NonNullable<Fighter['throwAim']>> },
      { name: 'pose', live: f.pose, record: rec.pose, fields: { root: true, rot: true, blade: true, slide: true } satisfies Keys<Pose> },
      { name: 'idle.feint', live: f.idle.feint, record: idle.feint, fields: { kind: true, t: true, dur: true } satisfies Keys<NonNullable<IdleBehavior['feint']>> },
      { name: 'idle.paw', live: live.paw, record: idle.paw, fields: { t: true, dur: true } },
      {
        name: 'idle.mods',
        live: f.idle.mods,
        record: idle.mods,
        fields: { bounce: true, bounceHz: true, sway: true, head: true, feints: true, paws: true } satisfies Keys<IdleBehavior['mods']>,
      },
      { name: 'footwork.limp', live: f.footwork.style.limp, record: fw.limp, fields: { side: true, amount: true } satisfies Keys<NonNullable<FootworkStyle['limp']>> },
      { name: 'footwork.shift', live: shift.shift, record: fw.shift, fields: { x: true, z: true, primed: true } },
      { name: 'footwork.shiftTarget', live: shift.shiftTarget, record: fw.shiftTarget, fields: { x: true, z: true } },
    ];
    expect(f.wounds.some((w) => w.stump) && f.wounds.some((w) => !w.stump)).toBe(true);
    for (const n of nested) {
      expect(n.live, n.name).toBeTruthy();
      expect(n.record, n.name).toBeTruthy();
      const fields = Object.keys(n.fields);
      expect(sorted(Object.keys(n.record!)), n.name).toEqual(sorted([...fields.map((k) => n.renamed?.[k] ?? k), ...(n.added ?? [])]));
      for (const k of Object.keys(n.live!)) expect(fields, `${n.name}: the live field ${k}`).toContain(k);
    }
  });
});

describe('a legacy fight saved and restored mid-way continues bit-identically (in-process)', () => {
  /** The fighter states the restored copies were followed through, across the fights. */
  const followed = new Set<string>();
  const saved = { pickups: 0, inFlight: 0, prevDistInfinite: 0 };
  for (const sc of SCENARIOS) {
    it(
      sc.name,
      () => {
        const r = follow(sc);
        expect(r.divergence).toBeNull();
        expect(r.saves).toBe(sc.saveAt.length);
        expect(r.checked).toBe(sc.saveAt.length * (sc.follow + 1));
        for (const s of r.states) followed.add(s);
        saved.pickups += r.saved.pickups;
        saved.inFlight += r.saved.inFlight;
        saved.prevDistInfinite += r.saved.prevDistInfinite;
      },
      60_000,
    );
  }

  it('the copies were followed through attacks, defences, hits, knockdowns, get-ups, pickups and knockouts', () => {
    for (const s of ['walk', 'attack', 'defend', 'hitstun', 'knockdown', 'getup', 'pickup', 'ko']) expect(followed).toContain(s);
    // Saved while a weapon was being reached for, with weapons in flight, and with AIs whose prevDist was Infinity.
    expect(saved.pickups).toBeGreaterThan(0);
    expect(saved.inFlight).toBeGreaterThan(0);
    expect(saved.prevDistInfinite).toBeGreaterThan(0);
  });
});
