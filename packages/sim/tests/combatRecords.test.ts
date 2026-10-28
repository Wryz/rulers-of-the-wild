// P02-fix, CombatSim's own save record (docs/M1-DESIGN.md §8.3, §13.0; MAP gap-7 §3.1, §6): toRecord()/restoreRecord()
// for what CombatSim carries from one tick into the next and nobody else saves: the tick, its Rng, the drop and
// projectile serials, the weapons lying around and in flight, last tick's swept blades and the pending commands.
//
// - A legacy fight saved mid-way through CombatSim.toRecord, with weapons lying around, weapons in flight and blades
//   swept, continues bit-identically in a fresh CombatSim restored from the record's canonical text: every tick, the
//   sim's own state (read from its internals, never through toRecord), every fighter's and brain's state and the
//   events equal the uninterrupted fight's. The fighters' own state comes from a twin of the fight that ran the same
//   ticks (their records are P04's, tested in records.test.ts; this test keeps CombatSim's record apart from them): its
//   fighters and brains are moved into the fresh sim as they are and re-linked to the fresh sim's shared Rng, drops
//   and director (and a weapon being reached for to its drop, by id, as P04's Fighter.restoreRecord does), so
//   everything CombatSim itself owns comes from the record alone.
// - A record with any one field left out (the value a fresh sim has in its place) is caught by that comparison.
// - Every own field of a CombatSim is in the record, saved by its owner, or named with the reason it isn't.
// - A field missing or of the wrong kind throws a `save record:` error naming it, before the sim is changed.
// - record → canonical text → restore → record is identical, −0, ±Infinity and NaN included.
// - DAMAGE_TUNING.bladeSharpness is the thrown rule's s for a DungeonStyle blade, read live.
//
// P13's canonical writer doesn't exist yet: `canon` below applies §8.3's number rules (finite → String(v), −0 → -0,
// ±Infinity and NaN → "$inf", "$-inf", "$nan"), as P04's tests do, and refuses anything that isn't plain data.
import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { bonePoint, BONES } from '../src/body/skeleton';
import { type AIDirector, BrawlerAI } from '../src/sim/ai';
import { type CombatEvent, type CombatSimRecord, CombatSim, type Drop, type HurtZone } from '../src/sim/combat';
import { type Command, moveCommand, setTuningCommand } from '../src/sim/commands';
import { createEnemy, type EnemyKind } from '../src/sim/enemies';
import { BUTTONS, Fighter, IdCounter } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import type { Projectile } from '../src/sim/projectiles';
import { createBrawler, createPlayer } from '../src/sim/roster';
import { DAMAGE_TUNING } from '../src/sim/rules';
import { type WeaponDef, type WeaponId, WEAPONS } from '../src/sim/weapons';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { ArenaWalkable, type Walkable } from '../src/world/collision';
import type { WorldPort } from '../src/world/types';

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

// ---------------------------------------------------------------------------
// What a tick carries, read from the live objects (never through toRecord, so a field toRecord or restoreRecord
// left out shows up here)
// ---------------------------------------------------------------------------

/** CombatSim's private state. */
type SimInternals = {
  dropSerial: number;
  projSerial: number;
  prevBlade: Map<Fighter, Vector3[]>;
};
const internals = (sim: CombatSim) => sim as unknown as SimInternals;

/** AIDirector's private turn-taking clock (AIDirector.toRecord is P04's). */
type DirectorInternals = { lastAttack: number };

/** What a BrawlerAI shares with its sim (its Rng is a private constructor property). */
type BrainLinks = { rng: Rng; drops: Drop[]; director: AIDirector | null };

const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });

/** A weapon as its id, and whether it is the shared WEAPONS object (identity the sim relies on). */
const weaponText = (w: WeaponDef) => `${w.id}${(WEAPONS as Record<string, WeaponDef>)[w.id] === w ? '' : `*${canon({ ...w })}`}`;

/** CombatSim's own state (what the record holds), from its fields. */
function simOwn(sim: CombatSim) {
  const s = internals(sim);
  return {
    frame: sim.frame,
    rng: sim.rng.state,
    dropSerial: s.dropSerial,
    projSerial: s.projSerial,
    drops: sim.drops.map((d) => ({ id: d.id, weapon: weaponText(d.weapon), pos: v3(d.pos), yaw: d.yaw, from: d.from ? v3(d.from) : null })),
    projectiles: sim.projectiles.map((p) => ({
      id: p.id,
      serial: p.serial,
      weapon: weaponText(p.weapon),
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
    // (A lookup table: its content, by fighter id, whatever order it was filled in.)
    prevBlade: [...s.prevBlade].map(([f, pts]) => [f.id, pts.map(v3)] as const).sort((a, b) => a[0] - b[0]),
    pending: sim.commands.toRecord(),
  };
}

/** A fighter's state: the legacy replay's fields, plus who and what it is reaching for, and its brain's. */
function fighterState(sim: CombatSim, f: Fighter) {
  const pt = f.pickupTarget;
  const brain = sim.ais.get(f);
  return {
    id: f.id,
    state: f.state,
    nums: [f.stateFrame, f.stunFrames, f.yaw, f.scale, f.hp, f.guard, f.poise, f.stamina, f.attackSerial, f.combo, f.attackEnd, f.stuckUntil, f.pickupRequest, f.repeatCount, f.swingStamina, f.misreadSerial, f.lastDefendedSerial, f.perfectSerial, f.dodgedSerial],
    vecs: [f.pos, f.vel, f.walkVel, f.moveInput, f.airStep].map(v3),
    flags: [f.hitThisAttack, f.isCounterAttack, f.perfectCounter, f.isPerfectCounter, f.lockedOn, f.wasBlocked, f.defenseManual],
    move: f.move ? `${f.move.id}|${f.move.startup}|${f.move.active}|${f.move.recovery}` : null,
    weapon: f.weapon ? weaponText(f.weapon) : null,
    ammo: f.ammo ? [weaponText(f.ammo.weapon), f.ammo.count] : null,
    target: f.target?.id ?? null,
    // The drop it is reaching for: found by identity, as advancePickup finds it.
    pickup: pt ? { drop: sim.drops.find((d) => d.pos === pt.pos && d.weapon === pt.weapon)?.id ?? null, pos: v3(pt.pos), weapon: weaponText(pt.weapon), grabAt: pt.grabAt } : null,
    buffer: f.buffer ? `${f.buffer.button}|${f.buffer.frames}` : null,
    counter: f.counter ? `${f.counter.kind}|${f.counter.frames}` : null,
    defense: f.defense ? `${f.defense.def.kind}|${f.defense.phase}|${f.defense.success}|${f.defense.threatSerial}|${f.defense.side}` : null,
    aim: f.aim?.id ?? null,
    strikeHeight: f.strikeHeight,
    wounds: f.wounds.map((w) => [w.bone, ...w.local, w.angle, w.length, w.bleed, w.floor, w.clot, w.stump ?? null]),
    severed: [...f.severed],
    torn: [...f.torn],
    rig: BONES.map((b) => {
      const j = f.rig[b];
      return [j.pos.x, j.pos.y, j.pos.z, j.rot.x, j.rot.y, j.rot.z, j.rot.w];
    }),
    feet: [f.footwork.L, f.footwork.R].map((foot) => [foot.pos.x, foot.pos.y, foot.pos.z, foot.stepping]),
    rng: (f as unknown as { rng: Rng }).rng.state,
    brain: brain instanceof BrawlerAI ? brainState(brain) : brain ? 'other' : null,
  };
}

/** A BrawlerAI's own history (everything but what it shares with the sim, its settings and its derived plan). */
function brainState(ai: BrawlerAI): Record<string, unknown> {
  const skip = new Set(['rng', 'drops', 'director', 'walkable', 'armed', 'cfg', 'plan']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ai)) {
    if (skip.has(k)) continue;
    out[k] = v instanceof Vector3 ? v3(v) : v && typeof v === 'object' ? { ...v } : v;
  }
  return out;
}

/** Every bit of state a legacy fight carries from one tick to the next, as canonical text. */
function stateText(sim: CombatSim): string {
  return canon({
    sim: simOwn(sim),
    director: { frame: sim.director.frame, lastAttack: (sim.director as unknown as DirectorInternals).lastAttack },
    fighters: sim.fighters.map((f) => fighterState(sim, f)),
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
    if (key === 'weapon' && value && typeof value === 'object') return weaponText(value as WeaponDef);
    if (key === 'projectile' && value && typeof value === 'object') {
      const p = value as { id: number; serial: number };
      return `P${p.id}|${p.serial}`;
    }
    return value;
  });
}

// ---------------------------------------------------------------------------
// Legacy fights (tests/legacyReplay.test.ts's scenarios 2 and 4), buildable as many times as needed
// ---------------------------------------------------------------------------

/** What a save point holds of what the record covers. */
interface Features {
  drops: number;
  inFlight: number;
  /** Weapons in flight that someone has already got out of the way of. */
  passed: number;
  /** Swept blades (prevBlade entries). */
  blades: number;
  /** Fighters reaching for a weapon that still lies there. */
  pickups: number;
  pending: number;
}

function features(sim: CombatSim): Features {
  return {
    drops: sim.drops.length,
    inFlight: sim.projectiles.length,
    passed: sim.projectiles.filter((p) => p.passed && p.passed.size > 0).length,
    blades: internals(sim).prevBlade.size,
    pickups: sim.fighters.filter((f) => f.pickupTarget && sim.drops.some((d) => d.pos === f.pickupTarget!.pos)).length,
    pending: sim.commands.length,
  };
}

interface Scenario {
  name: string;
  seed: number;
  driver: number;
  walkable?: () => Walkable;
  drops?: [WeaponId, number, number][];
  /** Every this many ticks the player throws the weapon in hand at an opponent 2.5-7 m away (0: never). */
  throwEvery?: number;
  /** Adds the fighters (ids from `ids`); returns the command-driven player. */
  fighters(sim: CombatSim, ids: IdCounter): Fighter | null;
  /** Changes made to every copy of the fight, the same way, before tick `next`. */
  script?: (sim: CombatSim, next: number) => void;
  /** Where a save is taken: the first ticks (at least `gap` apart, up to `saves` of them) whose state has these. */
  saveWhen(x: Features): boolean;
  /** What the scenario's save points must hold between them (each feature > 0 at one save point at least). */
  covers: (keyof Features)[];
  saves: number;
  gap: number;
  /** Ticks to look for save points in, and how long each restored copy is followed. */
  ticks: number;
  follow: number;
}

function enemy(sim: CombatSim, kind: EnemyKind, x: number, z: number, ids: IdCounter, weapon?: WeaponId): Fighter {
  const { fighter, ai } = createEnemy(kind, sim.rng, {}, {}, { ids });
  fighter.pos.set(x, 0, z);
  fighter.yaw = Math.atan2(-x, -z);
  if (weapon) fighter.weapon = WEAPONS[weapon];
  sim.add(fighter, ai);
  return fighter;
}

function player(sim: CombatSim, ids: IdCounter, z: number, weapon: WeaponId | null, damageMul: number): Fighter {
  const p = createPlayer({ ids });
  if (weapon) p.weapon = WEAPONS[weapon];
  p.stats.damageMul = damageMul;
  p.stats.maxHp = p.hp = 900;
  p.pos.set(0, 0, z);
  sim.add(p);
  return p;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'an axe against three fighters, weapons on the floor (cuts, kunai, blocks, dodges)',
    seed: 101,
    driver: 9001,
    drops: [
      ['machete', 1.5, -2],
      ['bat', -2, -2.5],
    ],
    fighters: (sim, ids) => {
      const p = player(sim, ids, 0, 'axe', 1.5);
      enemy(sim, 'brawler', 2.2, 0.4, ids);
      enemy(sim, 'samurai', -2.4, 1.2, ids);
      enemy(sim, 'ninja', 0.6, -3.2, ids);
      return p;
    },
    // Weapons lying around, in flight and swung, all at once.
    saveWhen: (x) => x.drops > 0 && x.inFlight > 0 && x.blades > 0,
    covers: ['drops', 'inFlight', 'blades', 'pending'],
    saves: 3,
    gap: 60,
    ticks: 2400,
    follow: 240,
  },
  {
    // (No fight above gets a weapon in flight past someone at a tick boundary: a defence that evades it usually takes
    // the body out of its path, so it never touches them. Here a kunai is put at a weaving fighter's head.)
    name: 'a kunai past a fighter weaving under it, flying on to land (no commands)',
    seed: 606,
    driver: 9006,
    drops: [['bat', -2, 2]],
    fighters: (sim, ids) => {
      const p = createPlayer({ ids });
      p.autoDefense = false;
      p.pos.set(0, 0, 0);
      sim.add(p);
      const { fighter: e, ai } = createBrawler(sim.rng, { passive: true }, { ids });
      e.pos.set(0, 0, 3);
      e.yaw = Math.PI;
      sim.add(e, ai);
      return null;
    },
    script: (sim, next) => {
      const [p, e] = sim.fighters;
      if (next === 30) p.startDefense('weave', -1900, 1, 20);
      if (next === 36) {
        // Thrown by `e`, its point a hand's breadth from `p`'s face, flying at it at 9 m/s.
        const w = WEAPONS.kunai;
        const head = bonePoint(p.rig, 'head', 0.13, new Vector3());
        const vel = new Vector3(0, 0, -9);
        sim.projectiles.push({
          id: 900, serial: -1900, weapon: w, owner: e, scale: 1, pos: head.add(new Vector3(0, 0, 0.2)), vel,
          axis: new Vector3(1, 0, 0), omega: 0, angle: 0, dir0: new Vector3(0, 0, -1), com: w.length * 0.45, live: true, age: 0,
        });
      }
    },
    saveWhen: (x) => x.passed > 0,
    covers: ['drops', 'inFlight', 'passed'],
    saves: 1,
    gap: 0,
    ticks: 120,
    follow: 120,
  },
  {
    name: 'throwing round props (the axe, bottles, cleavers, kunai; weapons on the floor)',
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
    fighters: (sim, ids) => {
      const p = player(sim, ids, -3, 'axe', 1.5);
      enemy(sim, 'brawler', 4, 2, ids, 'bottle');
      enemy(sim, 'brawler', -4, 3, ids, 'cleaver');
      enemy(sim, 'ninja', 0, 6, ids);
      return p;
    },
    // A weapon in flight while someone goes down for one lying on the floor (its drop re-linked by id).
    saveWhen: (x) => x.drops > 0 && x.inFlight > 0 && x.pickups > 0,
    covers: ['drops', 'inFlight', 'pickups', 'pending'],
    saves: 1,
    gap: 0,
    ticks: 2400,
    follow: 240,
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
    fighters: (sim, ids) => {
      const p = player(sim, ids, -0.5, null, 2.2);
      enemy(sim, 'knifeFighter', 3, -1, ids);
      enemy(sim, 'kicker', -3.5, 2.5, ids);
      enemy(sim, 'minotaur', 4, 3, ids);
      return p;
    },
    // Someone reaching for a weapon on the floor (its drop re-linked by id), or a blade swung beside dropped ones.
    saveWhen: (x) => x.drops > 0 && (x.pickups > 0 || x.blades > 0),
    covers: ['drops', 'pickups', 'blades', 'pending'],
    saves: 2,
    gap: 120,
    ticks: 2400,
    follow: 240,
  },
];

interface Hold {
  button: number;
  strafe: number;
  strafeFor: number;
}

/** The scripted player of the legacy fights, decided on the original and applied to every copy. */
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

/** A copy of the fight: its sim and its command-driven player. */
interface Copy {
  sim: CombatSim;
  player: Fighter | null;
}

function build(sc: Scenario): Copy {
  const sim = new CombatSim(sc.seed);
  if (sc.walkable) sim.walkable = sc.walkable();
  const ids = new IdCounter();
  const p = sc.fighters(sim, ids);
  for (const [w, x, z] of sc.drops ?? []) sim.addDrop(WEAPONS[w], x, z);
  return { sim, player: p };
}

/** Gives every live copy the same input for the next tick (decided on the original, `copies[0]`). */
function feed(sc: Scenario, copies: Copy[], driver: Rng, hold: Hold) {
  const a = copies[0];
  const next = a.sim.frame + 1;
  for (const c of copies) sc.script?.(c.sim, next);
  if (!a.player) return;
  const { cmds, throwNow } = decide(sc, a.sim, a.player, driver, hold, next);
  for (const c of copies) {
    if (throwNow) {
      const m = c.player!.moveDef('throwHeavy');
      if (m) c.player!.startMove(m);
    }
    for (const cmd of cmds) c.sim.commands.push({ ...cmd });
  }
}

/**
 * A fresh CombatSim made from `a`'s record, with the fighters of `twin` (a copy of the fight that has run the same
 * ticks, so its fighters are `a`'s to the bit): its fighters pushed as they are (not through add(), which runs a pose
 * update, MAP gap-7 §3.6), its brains re-linked to the fresh sim's Rng, drops and director (the director's lastAttack
 * copied: AIDirector's record is P04's), then CombatSim.restoreRecord from the record's canonical text, then a weapon
 * being reached for re-linked to its restored drop by id (P04's Fighter.restoreRecord does that). Nothing of the
 * twin's CombatSim reaches the fresh one.
 */
function restoreInto(sc: Scenario, rec: CombatSimRecord, twin: Copy): Copy {
  const text = canon(rec);
  const b = twin.sim;
  const c = new CombatSim(sc.seed);
  if (sc.walkable) c.walkable = sc.walkable();
  for (const f of b.fighters) {
    c.fighters.push(f);
    const brain = b.ais.get(f);
    if (!brain) continue;
    c.ais.set(f, brain);
    const links = brain as unknown as BrainLinks;
    expect(links.rng).toBe(b.rng);
    links.rng = c.rng;
    links.drops = c.drops;
    links.director = c.director;
  }
  (c.director as unknown as DirectorInternals).lastAttack = (b.director as unknown as DirectorInternals).lastAttack;
  c.restoreRecord(JSON.parse(text) as CombatSimRecord);
  for (const f of c.fighters) {
    const pt = f.pickupTarget;
    if (!pt) continue;
    const old = b.drops.find((d) => d.pos === pt.pos && d.weapon === pt.weapon);
    // (Gone already: the grab finds nothing, in either fight.)
    if (!old) continue;
    const d = c.drops.find((x) => x.id === old.id)!;
    f.pickupTarget = { pos: d.pos, weapon: d.weapon, grabAt: pt.grabAt };
  }
  return { sim: c, player: twin.player };
}

interface Followed {
  copy: Copy;
  savedAt: number;
  until: number;
}

interface RunResult {
  saves: { tick: number; features: Features }[];
  /** Ticks a restored copy was compared with the original. */
  checked: number;
  divergence: string | null;
}

/**
 * Plays the fight with `sc.saves` twins alongside. At each save point the record of the original is taken (after the
 * next tick's commands are queued, as the client queues them before stepping), a twin is turned into a restored copy,
 * and that copy is followed in lockstep for `sc.follow` ticks, compared with the original every tick: state and events.
 */
function run(sc: Scenario): RunResult {
  const a = build(sc);
  const twins = Array.from({ length: sc.saves }, () => build(sc));
  const followed: Followed[] = [];
  const driver = new Rng(sc.driver);
  const hold: Hold = { button: 10, strafe: 0, strafeFor: 0 };
  const out: RunResult = { saves: [], checked: 0, divergence: null };
  let lastSave = -Infinity;
  const fail = (what: string, got: string, want: string) => {
    out.divergence ??= `${sc.name}: ${what} at tick ${a.sim.frame}\n${firstDiff(got, want)}`;
  };
  for (let t = 0; !out.divergence; t++) {
    // Still looking for save points (the twins are stepped only while one may still be needed).
    const searching = twins.length > 0 && t < sc.ticks;
    const following = followed.filter((x) => a.sim.frame < x.until).map((x) => x.copy);
    if (!searching && following.length === 0) break;
    feed(sc, [a, ...(searching ? twins : []), ...following], driver, hold);
    if (searching && a.sim.frame >= lastSave + sc.gap && sc.saveWhen(features(a.sim))) {
      const twin = twins.shift()!;
      const want = stateText(a.sim);
      // (The twin is the original to the bit: the fighters it gives are the original's.)
      const tw = stateText(twin.sim);
      if (tw !== want) fail('the twin', tw, want);
      const copy = restoreInto(sc, a.sim.toRecord(), twin);
      const got = stateText(copy.sim);
      if (got !== want) fail('the restored copy, just restored', got, want);
      followed.push({ copy, savedAt: a.sim.frame, until: a.sim.frame + sc.follow });
      following.push(copy);
      out.saves.push({ tick: a.sim.frame, features: features(a.sim) });
      lastSave = a.sim.frame;
    }
    for (const c of [a, ...(searching ? twins : []), ...following]) c.sim.step();
    if (following.length === 0) continue;
    const want = stateText(a.sim);
    const events = a.sim.events.map(eventText).join('\n');
    for (const x of followed) {
      if (x.copy.sim.frame !== a.sim.frame) continue;
      const got = stateText(x.copy.sim);
      if (got !== want) fail(`the copy restored at ${x.savedAt}: state`, got, want);
      const ge = x.copy.sim.events.map(eventText).join('\n');
      if (ge !== events) fail(`the copy restored at ${x.savedAt}: events`, ge, events);
      out.checked++;
    }
  }
  return out;
}

/** Plays the original alone to its first save point (next tick's commands queued), and returns it. */
function playToSave(sc: Scenario): Copy {
  const a = build(sc);
  const driver = new Rng(sc.driver);
  const hold: Hold = { button: 10, strafe: 0, strafeFor: 0 };
  for (let t = 0; t < sc.ticks; t++) {
    feed(sc, [a], driver, hold);
    if (sc.saveWhen(features(a.sim))) return a;
    a.sim.step();
  }
  throw new Error(`${sc.name}: no save point in ${sc.ticks} ticks`);
}

function firstDiff(got: string, want: string): string {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  return `  got:  …${got.slice(Math.max(0, i - 120), i + 120)}…\n  want: …${want.slice(Math.max(0, i - 120), i + 120)}…`;
}

// ---------------------------------------------------------------------------

describe('CombatSim.toRecord / restoreRecord: a legacy fight saved mid-way continues bit-identically', () => {
  for (const sc of SCENARIOS) {
    it(
      sc.name,
      () => {
        const r = run(sc);
        expect(r.divergence).toBeNull();
        // Every save point was found and followed for its whole length.
        expect(r.saves).toHaveLength(sc.saves);
        expect(r.checked).toBe(sc.saves * sc.follow);
        // Its save points held what the scenario is there to cover.
        for (const k of sc.covers) expect(r.saves.some((s) => s.features[k] > 0), k).toBe(true);
      },
      120_000,
    );
  }

  it('the scenarios between them cover everything the record covers', () => {
    // Weapons lying around and in flight, in flight past someone, blades swept, a weapon being reached for in a drop
    // still lying there (re-linked by drop id), and the next tick's commands queued. (Each scenario's own test checks
    // that its save points held its `covers`, so this one stands alone: it runs no fight.)
    const covered = new Set(SCENARIOS.flatMap((sc) => sc.covers));
    expect([...covered].sort()).toEqual(Object.keys(features(new CombatSim())).sort());
  });

  it(
    'a record with any one field left out (a fresh sim\'s value in its place) is caught by that comparison',
    () => {
      const sc = SCENARIOS[0];
      const a = playToSave(sc).sim;
      const want = canon(simOwn(a));
      const rec = a.toRecord();
      const fresh = new CombatSim(sc.seed).toRecord();
      /** A fresh sim with the original's fighters (never stepped), restored from `r`: its own state as the check reads it. */
      const restored = (r: CombatSimRecord) => {
        const c = new CombatSim(sc.seed);
        c.fighters.push(...a.fighters);
        c.restoreRecord(reread(r));
        return canon(simOwn(c));
      };
      expect(restored(rec)).toBe(want);
      for (const k of Object.keys(fresh) as (keyof CombatSimRecord)[]) {
        // The save point exercises every field: each differs from a fresh sim's.
        expect(canon(rec[k]), k).not.toBe(canon(fresh[k]));
        expect(restored({ ...rec, [k]: fresh[k] }), k).not.toBe(want);
      }
    },
    120_000,
  );
});

describe('the record', () => {
  /**
   * Two fighters in a sim with weapons lying around and in flight, swept blades and queued commands; `special`: with −0,
   * ±Infinity and NaN planted in them (data only: a weapon spinning infinitely fast never finishes its sub-steps, so
   * such a sim is never stepped).
   */
  function scene(special = true) {
    const ids = new IdCounter();
    const sim = new CombatSim(5);
    sim.walkable = { resolve: () => {}, isWalkable: () => true };
    const p = createPlayer({ ids });
    const { fighter: e, ai } = createBrawler(sim.rng, {}, { ids });
    p.pos.set(0, 0, 0);
    e.pos.set(1.5, 0, 0);
    sim.add(p);
    sim.add(e, ai);
    for (let i = 0; i < 3; i++) sim.step();
    // A tool the world made (§5.2): a WeaponDef that isn't the WEAPONS entry, saved by value.
    const tool: WeaponDef = { ...WEAPONS.club, name: 'Stone club', mass: 3.1, sharpness: 0.25, chain: { ...WEAPONS.club.chain } };
    sim.addDrop(WEAPONS.machete, 1, -1);
    const placed = sim.addDrop(tool, -2, 0.5, 0.3, new Vector3(-0, 1.2, 0.5));
    placed.pos.x = -0;
    placed.yaw = -0;
    const flying = (owner: Fighter, weapon: WeaponDef, id: number): Projectile => ({
      id, serial: -1000 - id, weapon, owner, scale: 1, pos: new Vector3(0.5, 1.4, -0), vel: new Vector3(6, 1, 0),
      axis: new Vector3(0, 0, 1), omega: 0, angle: 0, dir0: new Vector3(1, 0, 0), com: 0.2, live: true, age: 4,
    });
    const k = flying(p, WEAPONS.kunai, 1);
    if (special) {
      k.angle = Infinity;
      k.omega = -Infinity;
      k.com = NaN;
    }
    k.passed = new Set([e]);
    const thrown = flying(e, tool, 2);
    thrown.live = false;
    sim.projectiles.push(k, thrown);
    const s = internals(sim);
    s.projSerial = 2;
    s.prevBlade.set(e, [new Vector3(-0, 1, 2), special ? new Vector3(Infinity, -Infinity, NaN) : new Vector3(0.4, 1.1, 0.2)]);
    s.prevBlade.set(p, [new Vector3(0.1, 0.2, 0.3)]);
    sim.commands.push(moveCommand(sim.frame + 1, p.id, 0.3, -0.7));
    sim.commands.push({ tick: sim.frame + 1, player: p.id, kind: 'button', button: 'lpunch' });
    sim.commands.push(setTuningCommand(sim.frame + 2, 1, 'DAMAGE_TUNING', 'kS', 2.5));
    return { sim, p, e, ai, tool };
  }

  it('round-trips through canonical text: record → text → restore → record is identical, −0, ±Infinity and NaN included', () => {
    const { sim, p, e, tool } = scene();
    const text = canon(sim.toRecord());
    for (const s of ['-0', '"$inf"', '"$-inf"', '"$nan"']) expect(text).toContain(s);
    // Into a fresh sim with the same fighters: the same record back, the same text.
    const c = new CombatSim(99);
    c.fighters.push(p, e);
    c.restoreRecord(JSON.parse(text) as CombatSimRecord);
    expect(canon(c.toRecord())).toBe(text);
    // The values themselves, the special ones included.
    expect(Object.is(c.drops[1].pos.x, -0)).toBe(true);
    expect(Object.is(c.drops[1].yaw, -0)).toBe(true);
    expect(Object.is(c.drops[1].from!.x, -0)).toBe(true);
    expect(c.projectiles[0].angle).toBe(Infinity);
    expect(c.projectiles[0].omega).toBe(-Infinity);
    expect(c.projectiles[0].com).toBeNaN();
    expect(Object.is(c.projectiles[0].pos.z, -0)).toBe(true);
    const blade = internals(c).prevBlade.get(e)!;
    expect(Object.is(blade[0].x, -0)).toBe(true);
    expect([blade[1].x, blade[1].y]).toEqual([Infinity, -Infinity]);
    expect(blade[1].z).toBeNaN();
    // Shared weapons stay the WEAPONS objects; a tool comes back by value, as a new object.
    expect(c.drops[0].weapon).toBe(WEAPONS.machete);
    expect(c.drops[1].weapon).not.toBe(tool);
    expect(c.drops[1].weapon).toEqual(tool);
    expect(c.projectiles[1].weapon).toEqual(tool);
    // Fighters re-linked by id; the set of those it went past kept.
    expect(c.projectiles[0].owner).toBe(p);
    expect([...c.projectiles[0].passed!]).toEqual([e]);
    expect(c.projectiles[1].passed).toBeUndefined();
    expect(internals(c).prevBlade.get(p)!.map(v3)).toEqual([{ x: 0.1, y: 0.2, z: 0.3 }]);
    // The record's keys, in their fixed order.
    expect(Object.keys(sim.toRecord())).toEqual(['frame', 'rng', 'dropSerial', 'projSerial', 'drops', 'projectiles', 'prevBlade', 'pending']);
  });

  it('restores in place: the arrays, the Rng and the queue the brains and the client hold stay the same objects', () => {
    const { sim, ai } = scene(false);
    const rec = reread(sim.toRecord());
    const c = scene(false);
    const drops = c.sim.drops;
    const projectiles = c.sim.projectiles;
    const rng = c.sim.rng;
    const commands = c.sim.commands;
    c.sim.step();
    c.sim.restoreRecord(rec);
    expect(c.sim.drops).toBe(drops);
    expect(c.sim.projectiles).toBe(projectiles);
    expect(c.sim.rng).toBe(rng);
    expect(c.sim.commands).toBe(commands);
    // A brain sees the restored state through what it shares with the sim.
    expect(c.ai.drops).toBe(c.sim.drops);
    expect((c.ai as unknown as BrainLinks).rng.state).toBe(rec.rng);
    expect(c.sim.events).toEqual([]);
    expect(c.sim.director.frame).toBe(rec.frame);
    // (Same fighters by id, other objects: the same record.)
    expect(canon(c.sim.toRecord())).toBe(canon(rec));
    expect(ai).not.toBe(c.ai);
  });

  it('refuses a record naming a fighter the sim doesn\'t have, and a JSON null where a number belongs', () => {
    const { sim, p } = scene();
    const rec = reread(sim.toRecord());
    expect(() => new CombatSim(1).restoreRecord(rec, [p])).toThrow(/fighter 2/);
    const broken = reread(sim.toRecord());
    (broken.drops[0] as unknown as { yaw: unknown }).yaw = null;
    const c = new CombatSim(1);
    c.fighters.push(...sim.fighters);
    expect(() => c.restoreRecord(broken)).toThrow(/yaw is null, not a number/);
  });

  it('refuses a field missing or of the wrong kind with a save record error naming it, and leaves the sim as it was', () => {
    const { sim } = scene(false);
    type Rec = Record<string, unknown> & { drops: Record<string, unknown>[]; projectiles: Record<string, unknown>[]; prevBlade: unknown[] };
    const breaks: [string, (r: Rec) => void, RegExp][] = [
      ['live not a boolean', (r) => (r.projectiles[0].live = 1), /projectiles\[0\]\.live is 1, not a boolean/],
      ['passed missing', (r) => delete r.projectiles[0].passed, /projectiles\[0\]\.passed is missing, not an array/],
      ['passed not an array', (r) => (r.projectiles[0].passed = 2), /projectiles\[0\]\.passed is 2, not an array/],
      ['weapon missing', (r) => delete r.drops[0].weapon, /drops\[0\]\.weapon is missing, not an object/],
      ['weapon id not a string', (r) => ((r.drops[0].weapon as Record<string, unknown>).id = 7), /drops\[0\]\.weapon\.id is 7, not a string/],
      ['weapon def missing', (r) => delete (r.projectiles[1].weapon as Record<string, unknown>).def, /projectiles\[1\]\.weapon\.def is missing, not an object/],
      ['an unknown weapon', (r) => ((r.drops[0].weapon as Record<string, unknown>).id = 'toString'), /drops\[0\]\.weapon is weapon "toString", which doesn't exist/],
      ['a vector missing', (r) => delete r.projectiles[0].vel, /projectiles\[0\]\.vel is missing, not an object/],
      ['a vector component missing', (r) => delete (r.drops[1].pos as Record<string, unknown>).z, /drops\[1\]\.pos\.z is missing, not a number/],
      ['drops not an array', (r) => (r.drops = null as unknown as Rec['drops']), /drops is null, not an array/],
      ['prevBlade missing', (r) => delete (r as Partial<Rec>).prevBlade, /prevBlade is missing, not an array/],
      ['a blade entry not a pair', (r) => (r.prevBlade[0] = [2]), /prevBlade\[0\] is \[2\], not \[fighter id, points\]/],
      ['blade points not an array', (r) => ((r.prevBlade[0] as unknown[])[1] = {}), /prevBlade\[0\]\[1\] is \{\}, not an array/],
      ['pending missing', (r) => delete r.pending, /pending is missing, not an array/],
      ['a pending command not an object', (r) => ((r.pending as unknown[])[1] = 'jump'), /pending\[1\] is "jump", not an object/],
      ['frame not a number', (r) => Object.assign(r, { frame: 'soon' }), /frame is "soon", not a number/],
    ];
    for (const [what, brk, msg] of breaks) {
      const c = scene(false).sim;
      const before = canon(c.toRecord());
      const r = reread(sim.toRecord()) as unknown as Rec;
      brk(r);
      expect(() => c.restoreRecord(r as unknown as CombatSimRecord), what).toThrow(msg);
      expect(() => c.restoreRecord(r as unknown as CombatSimRecord), what).toThrow(/^save record: /);
      // Nothing was changed: the restore read the whole record before it touched the sim.
      expect(canon(c.toRecord()), what).toBe(before);
    }
    expect(() => new CombatSim(1).restoreRecord(null as unknown as CombatSimRecord)).toThrow(/^save record: combat is null, not an object/);
  });

  it('names every own field of a CombatSim: in the record, saved by its owner, or not saved and why', () => {
    const IN_RECORD: Record<string, keyof CombatSimRecord> = {
      frame: 'frame',
      rng: 'rng',
      dropSerial: 'dropSerial',
      projSerial: 'projSerial',
      drops: 'drops',
      projectiles: 'projectiles',
      prevBlade: 'prevBlade',
      commands: 'pending',
    };
    const BY_OWNER: Record<string, string> = {
      fighters: 'Fighter.toRecord (P04), in this order: the step order',
      ais: 'BrawlerAI.toRecord (P04) and the creature minds (§6.8), by fighter id',
      director: 'AIDirector.toRecord (P04): lastAttack; its frame is this tick',
    };
    const NOT_SAVED: Record<string, string> = {
      events: 'cleared at the start of every tick',
      speeds: 'written by locomote for every fighter before it is read, every tick',
      sprinters: 'decided by tickTimers for every fighter before it is read, every tick',
      walkable: 'set by whoever builds the sim (the arena; the world in M1)',
      groundQuery: 'set by the world',
      mover: 'set by the world',
      world: 'set by the world',
      physicsOwnsDowned: 'set by the world',
      playerFighter: 'set by the world',
      devChecks: 'a developer setting',
    };
    const named = [...Object.keys(IN_RECORD), ...Object.keys(BY_OWNER), ...Object.keys(NOT_SAVED)];
    expect(Object.keys(new CombatSim()).sort()).toEqual(named.sort());
    expect(Object.values(IN_RECORD).sort()).toEqual(Object.keys(new CombatSim().toRecord()).sort());
  });

  it('remove() takes the fighter\'s swept blade with it, so the record never holds a fighter the sim doesn\'t have', () => {
    const { sim, e } = scene();
    expect(internals(sim).prevBlade.has(e)).toBe(true);
    sim.remove(e);
    expect(internals(sim).prevBlade.has(e)).toBe(false);
    expect(sim.toRecord().prevBlade.map(([id]) => id)).toEqual([sim.fighters[0].id]);
  });
});

// ---------------------------------------------------------------------------

describe('DAMAGE_TUNING.bladeSharpness', () => {
  afterEach(() => resetTuning('DAMAGE_TUNING'));

  /** A WorldPort answering as a World would, for a thrown blow's rule path (world mode). */
  const world: WorldPort = {
    strike: () => null,
    tryVerb: () => {},
    completeWork: () => {},
    throwRelease: () => false,
    projectile: () => null,
    onProjectileLanded: () => true,
    onKO: () => ({ environmental: false, credit: [] }),
    onWeaponDropped: () => true,
    rulerHit: () => {},
  };

  type ThrownHit = (p: Projectile, d: Fighter, c: { point: Vector3; zone: HurtZone; bone: 'chest' }, along: number, part: Vector3) => void;

  /** The energy of a weapon flying point first at 10 m/s into a standing brawler's chest, in world mode. */
  function energy(w: WeaponDef): number {
    const ids = new IdCounter();
    const sim = new CombatSim(3);
    sim.walkable = { resolve: () => {}, isWalkable: () => true };
    sim.world = world;
    const thrower = createPlayer({ ids });
    const { fighter: d, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 }, { ids });
    thrower.pos.set(-3, 0, 0);
    d.pos.set(0, 0, 0);
    sim.add(thrower);
    sim.add(d, ai);
    const at = bonePoint(d.rig, 'chest', 0.16, new Vector3());
    const vel = new Vector3(10, 0, 0);
    const p: Projectile = {
      id: 1, serial: -1001, weapon: w, owner: thrower, scale: 1, pos: at.clone().add(new Vector3(-0.2, 0, 0)), vel,
      axis: new Vector3(0, 0, 1), omega: 0, angle: 0, dir0: vel.clone().normalize(), com: w.length * 0.45, live: true, age: 0,
    };
    (sim as unknown as { projectileStrike: ThrownHit }).projectileStrike(p, d, { point: at, zone: 'chest', bone: 'chest' }, w.length, at);
    const hit = sim.events.find((e): e is Extract<CombatEvent, { type: 'hit' }> => e.type === 'hit');
    return hit!.energy!;
  }

  it('is the thrown rule\'s s for a DungeonStyle blade, read live; a blunt weapon ignores it', () => {
    expect(DAMAGE_TUNING.bladeSharpness).toBe(0.8);
    expect(WEAPONS.kunai.edge).toBe('blade');
    expect(WEAPONS.kunai.sharpness).toBeUndefined();
    const at08 = energy(WEAPONS.kunai);
    setTuningValue('DAMAGE_TUNING', 'bladeSharpness', 0.5);
    const at05 = energy(WEAPONS.kunai);
    setTuningValue('DAMAGE_TUNING', 'bladeSharpness', 0);
    const at0 = energy(WEAPONS.kunai);
    // E = ½ m_eff v² (1 + kS s): the same blow, only s changed.
    expect(at08 / at0).toBeCloseTo(1 + DAMAGE_TUNING.kS * 0.8, 9);
    expect(at05 / at0).toBeCloseTo(1 + DAMAGE_TUNING.kS * 0.5, 9);
    // A blunt weapon's s is 0 whatever bladeSharpness is.
    const pan = energy(WEAPONS.pan);
    setTuningValue('DAMAGE_TUNING', 'bladeSharpness', 1);
    expect(energy(WEAPONS.pan)).toBe(pan);
    // A weapon's own sharpness wins over the default.
    const own = energy({ ...WEAPONS.kunai, sharpness: 0.5 });
    expect(own / at0).toBeCloseTo(1 + DAMAGE_TUNING.kS * 0.5, 9);
  });
});
