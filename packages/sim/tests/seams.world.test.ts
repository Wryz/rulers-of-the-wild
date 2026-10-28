// CombatSim's world-mode readers (docs/M1-DESIGN.md §1.2, §1.5.2-1.5.3, §3 phase 1a and 3, §4.1, §4.4, §4.6, §5.0-5.12;
// work package P02b), driven through a fake WorldPort. With every seam at its default CombatSim is DungeonStyle's
// (tests/legacyReplay); these tests show what each reader does when a world is set.
import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { bonePoint, type BoneName } from '../src/body/skeleton';
import { blowDamage, type CombatEvent, CombatSim, FACING, type HurtZone } from '../src/sim/combat';
import { type Command, COMMAND_STEPS, MOVE_CROUCH, MOVE_SPRINT, moveCommand } from '../src/sim/commands';
import { armourFrom, Fighter, IdCounter } from '../src/sim/fighter';
import { angleDelta, DT } from '../src/sim/math';
import { ENEMY_MOVES, PLAYER_MOVES, type MoveDef } from '../src/sim/moves';
import type { Projectile } from '../src/sim/projectiles';
import { createBrawler, createPlayer } from '../src/sim/roster';
import { RULER_TUNING } from '../src/sim/ruler';
import { boneMass, DAMAGE_TUNING, hpFromEnergy, impactEnergy, launchSpeed, MOVE_TUNING, reducedMass, zoneToughness } from '../src/sim/rules';
import { sampleOffsets, WEAPON_MOVES, WEAPONS, type WeaponDef } from '../src/sim/weapons';
import { defineTuning, resetTuning, setTuningValue, TUNING } from '../src/tuning/registry';
import type { Walkable } from '../src/world/collision';
import { MATERIAL_IDS, MATERIALS } from '../src/world/materials';
import type { ProjectileWorldHit, RulerState, Work, WorldPort, WorldStrike } from '../src/world/types';

// The verb system (P14, world/verbs/tuning.ts) registers VERB_TUNING; until a world module is imported here, these
// tests stand in for it with the §9 values of the two keys the work reader reads.
if (!TUNING.some((e) => e.name === 'VERB_TUNING')) {
  defineTuning(
    'VERB_TUNING',
    'Verbs',
    { faceTurnRate: 0.12, standOffM: 0.6, workStepM: 0.045 },
    {
      faceTurnRate: { unit: 'fraction of the remaining angle per tick', source: 'test stand-in for P14 (§9)' },
      standOffM: { unit: 'm', source: 'test stand-in for P14 (§9)' },
      workStepM: { unit: 'm × scale per tick', source: 'test stand-in for P14 (DS PICKUP_STEP)' },
    },
  );
}

afterEach(() => {
  resetTuning('MATERIALS');
  resetTuning('MOVE_TUNING');
  resetTuning('RULER_TUNING');
  resetTuning('DAMAGE_TUNING');
  resetTuning('VERB_TUNING');
});

/** Open ground: nothing to bump into, nowhere unwalkable. */
const OPEN: Walkable = { resolve: () => {}, isWalkable: () => true };

type Calls = { [K in keyof WorldPort]: Parameters<WorldPort[K]>[] };

/** A WorldPort that records every call (in order) and answers as a World would unless told otherwise. */
function fakeWorld(over: Partial<WorldPort> = {}) {
  const base: WorldPort = {
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
  const impl: WorldPort = { ...base, ...over };
  const calls = Object.fromEntries(Object.keys(base).map((k) => [k, []])) as unknown as Calls;
  const order: string[] = [];
  const port = {} as Record<keyof WorldPort, (...args: unknown[]) => unknown>;
  for (const k of Object.keys(base) as (keyof WorldPort)[]) {
    port[k] = (...args: unknown[]) => {
      (calls[k] as unknown[][]).push(args);
      order.push(k);
      return (impl[k] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { port: port as unknown as WorldPort, calls, order };
}

const rulerState = (): RulerState => ({
  maxHp: 12000, unhealed: 0, wounds: [], pinned: false, pinnedKg: 0, unpinTicks: 0, stuck: false, burning: false,
  inPit: false, downWound: null, downCause: null, lastWorldTrip: null, deflectedHeading: null, pendingTrip: null,
});

/** A giant ape's Fighter as §6.4 makes it (scale 5.5, 14 t, a RulerState), standing at `x, z` facing `yaw`. */
function giant(ids: IdCounter, x = 0, z = 0, yaw = 0): Fighter {
  const f = new Fighter('enemy', 'Giant', ENEMY_MOVES, { maxHp: 12000, walkSpeed: 1.9 }, undefined, { ids });
  f.scale = 5.5;
  f.massKg = 14000;
  f.species = 'giantApe';
  f.ruler = rulerState();
  f.autoDefense = false;
  f.pos.set(x, 0, z);
  f.yaw = yaw;
  return f;
}

/** A player and a passive brawler `dist` apart along x, facing each other. */
function duel(dist = 1.0, sim = new CombatSim(3), ids = new IdCounter()) {
  const player = createPlayer({ ids });
  const { fighter: enemy, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 }, { ids });
  player.pos.set(0, 0, 0);
  player.yaw = Math.PI / 2;
  enemy.pos.set(dist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  return { sim, player, enemy };
}

const hitsOn = (ev: CombatEvent[], d: Fighter) => ev.filter((e): e is Extract<CombatEvent, { type: 'hit' }> => e.type === 'hit' && e.defender === d);
const kos = (ev: CombatEvent[]) => ev.filter((e): e is Extract<CombatEvent, { type: 'ko' }> => e.type === 'ko');

/** CombatSim's private methods, called the way DungeonStyle's tests call them. */
interface Private {
  hit(a: Fighter, d: Fighter, m: MoveDef, point: Vector3, dir: Vector3, zone: HurtZone, bone: BoneName, power?: number, haft?: boolean, thrown?: WeaponDef | null, swing?: Vector3): void;
  applyStrike(c: unknown): void;
  separate(): void;
  gaitMul(f: Fighter): number;
  projectileStrike(p: Projectile, d: Fighter, c: { point: Vector3; zone: HurtZone; bone: BoneName }, along: number, part: Vector3): void;
}
const priv = (sim: CombatSim) => sim as unknown as Private;

/** Fighter's private fitting, read for the tests. */
interface FighterPrivate {
  weaponFit(move: MoveDef, aim: null): { target: [number, number, number]; strikeAt: number } | null;
  heightGap(move: MoveDef, aim: null): number;
}
const fit = (f: Fighter) => f as unknown as FighterPrivate;

function projectile(owner: Fighter, weapon: WeaponDef, pos: Vector3, vel: Vector3): Projectile {
  return {
    id: 1, serial: -1001, weapon, owner, scale: 1, pos, vel, axis: new Vector3(0, 0, 1), omega: 0, angle: 0,
    dir0: vel.clone().normalize(), com: weapon.length * 0.45, live: true, age: 0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

describe('drive: a mind walks the body (§6.1, §6.4)', () => {
  it('reaches its speed at its acceleration, along its heading, whatever moveInput says', () => {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    const g = giant(new IdCounter());
    sim.add(g);
    g.moveInput.set(1, 0, 0);
    g.drive = { heading: 0, speed: 7, accel: 5, climb: false };
    const speeds: number[] = [];
    for (let i = 0; i < 100; i++) {
      sim.step();
      speeds.push(Math.hypot(g.walkVel.x, g.walkVel.z));
      expect(Math.abs(g.walkVel.x)).toBeLessThan(1e-12);
    }
    // accel · DT a tick, from rest: 7 m/s after 7 / 5 s = 84 ticks, and no faster after.
    for (let i = 0; i < speeds.length; i++) expect(speeds[i], `tick ${i}`).toBeCloseTo(Math.min(7, 5 * DT * (i + 1)), 9);
    expect(speeds[83]).toBeCloseTo(7, 9);
    expect(g.state).toBe('walk');
    // Braking is the same rule.
    g.drive = { heading: 0, speed: 0, accel: 4, climb: false };
    sim.step();
    expect(Math.hypot(g.walkVel.x, g.walkVel.z)).toBeCloseTo(7 - 4 * DT, 9);
  });

  it('turns the body to its heading at FACING.freeTurnRate, over a target it is locked on to', () => {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    const ids = new IdCounter();
    const g = giant(ids, 0, 0, 0);
    // A player 3 m off its right: well inside a ruler's lock range (lockScale 2 → 5.4 m), so it is locked on.
    const p = createPlayer({ ids });
    p.pos.set(3, 0, 0);
    sim.add(g);
    sim.add(p);
    const heading = -Math.PI / 2;
    g.drive = { heading, speed: 0, accel: 5, climb: false };
    const steps: number[] = [];
    for (let i = 0; i < 60; i++) {
      const before = g.yaw;
      sim.step();
      steps.push(Math.abs(angleDelta(before, g.yaw)));
    }
    expect(g.lockedOn).toBe(true);
    expect(Math.max(...steps)).toBeLessThanOrEqual(FACING.freeTurnRate + 1e-12);
    expect(steps[0]).toBeCloseTo(FACING.freeTurnRate, 12);
    expect(angleDelta(g.yaw, heading)).toBeCloseTo(0, 9);
  });
});

describe('rulers in lock-on and retargeting (§4.6)', () => {
  /** Whether the player squares up to a giant `d` m away, with the giant counted as a ruler or not. */
  function locks(d: number, ruler: boolean) {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    const ids = new IdCounter();
    const p = createPlayer({ ids });
    const g = giant(ids, d, 0, -Math.PI / 2);
    if (!ruler) g.ruler = null;
    sim.add(p);
    sim.add(g);
    sim.step();
    return p.lockedOn;
  }

  it("counts a ruler as no bigger than lockScale, read live (DungeonStyle would square up from 14.85 m)", () => {
    expect(locks(8, false)).toBe(true);
    expect(locks(8, true)).toBe(false);
    expect(locks(5, true)).toBe(true);
    setTuningValue('RULER_TUNING', 'lockScale', 5.5);
    expect(locks(8, true)).toBe(true);
  });

  it("caps the retarget bias toward a big opponent at retargetBiasCapM for a ruler", () => {
    /** Who the player turns to first: a giant 6 m off or a brawler `b` m off. */
    const pick = (b: number, ruler: boolean) => {
      const sim = new CombatSim(1);
      sim.walkable = OPEN;
      const ids = new IdCounter();
      const p = createPlayer({ ids });
      const g = giant(ids, 6, 0, -Math.PI / 2);
      if (!ruler) g.ruler = null;
      const { fighter: e, ai } = createBrawler(sim.rng, { passive: true }, { ids });
      e.pos.set(0, 0, b);
      sim.add(p);
      sim.add(g);
      sim.add(e, ai);
      sim.step();
      return p.target === g ? 'giant' : 'brawler';
    };
    // 6 − 0.35 = 5.65 m for the ruler against the brawler's own distance; uncapped it is 6 − 1.575 = 4.425 m.
    expect(pick(5.5, true)).toBe('brawler');
    expect(pick(5.8, true)).toBe('giant');
    expect(pick(5.5, false)).toBe('giant');
    expect(RULER_TUNING.retargetBiasCapM).toBe(0.35);
  });
});

describe("separate() and a ruler bearing down (§4.4, RF-5)", () => {
  /** How far separate() moves a player overlapping a giant whose own speed toward him is `v` (his own: `pv`). */
  function pushed(v: number, world: boolean, pv = 0) {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    if (world) sim.world = fakeWorld().port;
    const ids = new IdCounter();
    const g = giant(ids, 0, 0, 0);
    const p = createPlayer({ ids });
    // 2.0 m apart: inside 0.66 × (1 + 5.5) / 2 = 2.145 m.
    p.pos.set(0, 0, 2);
    p.yaw = Math.PI;
    sim.add(g);
    sim.add(p);
    g.walkVel.set(0, 0, v);
    p.walkVel.set(0, 0, -pv);
    const at = p.pos.clone();
    priv(sim).separate();
    return p.pos.distanceTo(at);
  }

  it("doesn't push a player away from a ruler closing at 2 m/s, and does at 0.5 m/s", () => {
    expect(pushed(2, true)).toBe(0);
    expect(pushed(0.5, true)).toBeGreaterThan(0.05);
    // Legacy CombatSim pushes whatever the speed.
    expect(pushed(2, false)).toBeGreaterThan(0.05);
    // The threshold is live tuning.
    setTuningValue('RULER_TUNING', 'separateSkipSpeed', 2.5);
    expect(pushed(2, true)).toBeGreaterThan(0.05);
  });

  it('still pushes a player who walks into a standing ruler out of its body (the ruler\'s own speed counts)', () => {
    expect(pushed(0, true, 2)).toBeGreaterThan(0.05);
  });

  it('a driven giant walks into a player standing in its path without shoving him (the contact scores instead)', () => {
    const run = (world: boolean) => {
      const sim = new CombatSim(1);
      sim.walkable = OPEN;
      if (world) sim.world = fakeWorld().port;
      const ids = new IdCounter();
      const g = giant(ids, 0, 0, 0);
      const p = createPlayer({ ids });
      p.pos.set(0, 0, 3);
      p.yaw = Math.PI;
      sim.add(g);
      sim.add(p);
      g.drive = { heading: 0, speed: 2, accel: 100, climb: false };
      const at = p.pos.clone();
      // 60 ticks at 2 m/s: 2 m, more than the 0.855 m to first overlap.
      for (let i = 0; i < 60; i++) sim.step();
      return { moved: Math.hypot(p.pos.x - at.x, p.pos.z - at.z), gap: p.pos.z - g.pos.z };
    };
    const world = run(true);
    expect(world.moved).toBe(0);
    // It walked right into him.
    expect(world.gap).toBeLessThan(2.145);
    expect(run(false).moved).toBeGreaterThan(0.5);
  });
});

describe('projectiles in world mode (§4.1, §4.4, RF-6)', () => {
  /** An unowned flight (nobody to hit) 3 m up along +x, over ground that is unwalkable beyond x = 2. */
  function flight(world: ReturnType<typeof fakeWorld> | null) {
    const sim = new CombatSim(1);
    sim.walkable = { resolve: () => {}, isWalkable: (x) => x < 2 };
    if (world) sim.world = world.port;
    const thrower = createPlayer();
    thrower.pos.set(-5, 0, 0);
    sim.add(thrower);
    const p = projectile(thrower, WEAPONS.kunai, new Vector3(0, 3, 0), new Vector3(10, 0, 0));
    sim.projectiles.push(p);
    const events: CombatEvent[] = [];
    for (let i = 0; i < 30 && sim.projectiles.includes(p); i++) events.push(...sim.step());
    return { sim, p, events };
  }

  it('a projectile 3 m up over a non-walkable cell keeps flying in world mode and hits a wall in legacy mode', () => {
    const legacy = flight(null);
    const walls = legacy.events.filter((e) => e.type === 'thud' && e.wall);
    expect(walls).toHaveLength(1);
    expect((walls[0] as Extract<CombatEvent, { type: 'thud' }>).point.x).toBeGreaterThanOrEqual(2);
    expect(legacy.p.live).toBe(false);
    expect(legacy.p.vel.x).toBeLessThan(0);

    const w = fakeWorld();
    const world = flight(w);
    expect(world.events.filter((e) => e.type === 'thud')).toEqual([]);
    expect(world.p.live).toBe(true);
    expect(world.p.pos.x).toBeCloseTo(5, 6);
    expect(world.p.pos.y).toBeGreaterThan(1.5);
    // The world was asked about every sub-step of the flight, segment after segment.
    const segs = w.calls.projectile;
    expect(segs.length).toBeGreaterThanOrEqual(30);
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i][0]).toBe(world.p);
      if (i > 0) expect(segs[i][1].toArray()).toEqual(segs[i - 1][2].toArray());
    }
    expect(segs[0][1].toArray()).toEqual([0, 3, 0]);
  });

  it('stops where the world says the segment met something, and hands the weapon back still moving (no DS drop)', () => {
    const landed: { x: number; vx: number }[] = [];
    const w = fakeWorld({
      projectile: (_p, from, to): ProjectileWorldHit | null =>
        to.x < 3 ? null : { point: new Vector3(3, to.y, 0), normal: new Vector3(-1, 0, 0), owner: { kind: 'entity', id: 7 }, toi: (3 - from.x) / (to.x - from.x) },
      onProjectileLanded: (p) => {
        landed.push({ x: p.pos.x, vx: p.vel.x });
        return true;
      },
    });
    const { sim, p, events } = flight(w);
    expect(sim.projectiles).toEqual([]);
    expect(landed).toHaveLength(1);
    expect(landed[0].x).toBeCloseTo(3, 9);
    expect(landed[0].vx).toBeCloseTo(10, 9);
    expect(p.live).toBe(false);
    const thuds = events.filter((e): e is Extract<CombatEvent, { type: 'thud' }> => e.type === 'thud');
    expect(thuds).toHaveLength(1);
    expect(thuds[0]).toMatchObject({ wall: true, projectile: p });
    expect(thuds[0].point.x).toBe(3);
    expect(events.some((e) => e.type === 'drop')).toBe(false);
    expect(sim.drops).toEqual([]);
  });

  it('a weapon that lands is the world\'s; with devChecks, one the world turns down asserts instead of dropping', () => {
    // Down onto the floor: onProjectileLanded takes it.
    const down = (port: ReturnType<typeof fakeWorld>, devChecks: boolean) => {
      const sim = new CombatSim(1);
      sim.walkable = OPEN;
      sim.world = port.port;
      sim.devChecks = devChecks;
      const thrower = createPlayer();
      thrower.pos.set(-5, 0, 0);
      sim.add(thrower);
      sim.projectiles.push(projectile(thrower, WEAPONS.kunai, new Vector3(0, 0.3, 0), new Vector3(0, -2, 0)));
      const events: CombatEvent[] = [];
      for (let i = 0; i < 30; i++) events.push(...sim.step());
      return { sim, events };
    };
    const taken = fakeWorld();
    const a = down(taken, true);
    expect(taken.calls.onProjectileLanded).toHaveLength(1);
    expect(a.sim.drops).toEqual([]);
    expect(a.sim.projectiles).toEqual([]);
    // The world turned it down: a DS drop, as before, unless devChecks are on.
    expect(down(fakeWorld({ onProjectileLanded: () => false }), false).sim.drops).toHaveLength(1);
    expect(() => down(fakeWorld({ onProjectileLanded: () => false }), true)).toThrow(/addDrop/);
  });

  it('a thrown weapon hits a fighter by the rule: m_eff from the struck bone, its sharpness when it leads', () => {
    const strike = (world: boolean, toughnessJ = 0) => {
      const { sim, player, enemy } = duel(3);
      if (world) sim.world = fakeWorld().port;
      enemy.toughnessJ = toughnessJ;
      const at = bonePoint(enemy.rig, 'chest', 0.16, new Vector3());
      const w = WEAPONS.kunai;
      const p = projectile(player, w, at.clone().add(new Vector3(-0.2, 0, 0)), new Vector3(10, 0, 0));
      priv(sim).projectileStrike(p, enemy, { point: at, zone: 'chest', bone: 'chest' }, w.length, at);
      return hitsOn(sim.events, enemy)[0];
    };
    const w = WEAPONS.kunai;
    expect(w.sharpness).toBeUndefined();
    const legacy = strike(false);
    // DungeonStyle: ½ m v² / 18 with the weapon's own mass, × its damageMul, no sharpness.
    expect(legacy.damage).toBeCloseTo(((0.5 * w.mass * 100) / 18) * w.damageMul, 9);
    expect(legacy.energy).toBeUndefined();

    const { enemy } = duel();
    const E = impactEnergy(reducedMass(w.mass, boneMass(enemy, 'chest')), 10, 0.8);
    const world = strike(true);
    expect(world.energy).toBeCloseTo(E, 9);
    expect(world.toughness).toBe(0);
    expect(world.damage).toBeCloseTo(hpFromEnergy(E, 0), 9);
    // A point leading at 10 m/s into a 15 kg chest: (1 + 3 × 0.8) × the blunt energy, against m_eff ≈ 0.197 kg.
    expect(world.damage).toBeGreaterThan(legacy.damage);
    const hide = strike(true, 20);
    expect(hide.toughness).toBe(20);
    expect(hide.damage).toBeCloseTo(hpFromEnergy(E, 20), 9);
    // DS's leading test reads DAMAGE_TUNING.leadingCos: nothing leads at a cosine above 1, so s = 0.
    setTuningValue('DAMAGE_TUNING', 'leadingCos', 1.5);
    const blunt = strike(true);
    expect(blunt.energy).toBeCloseTo(impactEnergy(reducedMass(w.mass, boneMass(enemy, 'chest')), 10, 0), 9);
  });
});

describe('the ruler branch (§4.6)', () => {
  function versus() {
    const ids = new IdCounter();
    const sim = new CombatSim(3);
    sim.walkable = OPEN;
    const w = fakeWorld();
    sim.world = w.port;
    const player = createPlayer({ ids });
    player.pos.set(0, 0, -2);
    const g = giant(ids, 0, 0, Math.PI);
    sim.add(player);
    sim.add(g);
    return { sim, w, player, g };
  }

  it('hands every blow on a ruler to world.rulerHit, and nothing of DS\'s hit happens to it', () => {
    const { sim, w, player, g } = versus();
    const point = g.rig.shinL.pos.clone();
    const dir = new Vector3(0, 0, 1);
    const before = { hp: g.hp, poise: g.poise, stamina: g.stamina, state: g.state };
    priv(sim).hit(player, g, PLAYER_MOVES.cross, point, dir, 'legs', 'shinL');
    expect(w.calls.rulerHit).toHaveLength(1);
    const [a, d, m, pt, dr, zone, bone, power, haft, thrown, rule] = w.calls.rulerHit[0];
    expect([a, d, m, pt, dr, zone, bone, power, haft, thrown, rule]).toEqual([player, g, PLAYER_MOVES.cross, point, dir, 'legs', 'shinL', 1, false, null, null]);
    expect({ hp: g.hp, poise: g.poise, stamina: g.stamina, state: g.state }).toEqual(before);
    expect(g.vel.length()).toBe(0);
    expect(g.lastKnock).toBeNull();
    expect(g.wounds).toEqual([]);
    expect(sim.events).toEqual([]);
  });

  it('never blocks, and a weak swing goes to the rule too (no DS bump, no shove)', () => {
    const { sim, w, player, g } = versus();
    player.weapon = WEAPONS.axe;
    g.setState('blockstun');
    const m = player.moveDef('sweep')!;
    priv(sim).applyStrike({ attacker: player, defender: g, move: m, height: 'mid', point: g.rig.chest.pos.clone(), zone: 'chest', bone: 'chest', power: 0.2 });
    expect(w.calls.rulerHit).toHaveLength(1);
    expect(w.calls.rulerHit[0][7]).toBe(0.2);
    expect(sim.events.filter((e) => e.type === 'block' || e.type === 'bump')).toEqual([]);
    expect(g.vel.length()).toBe(0);
    expect(g.lastKnock).toBeNull();
    // A fighter that isn't a ruler gets DS's bump from the same swing.
    const s2 = duel(1);
    s2.player.weapon = WEAPONS.axe;
    priv(s2.sim).applyStrike({ attacker: s2.player, defender: s2.enemy, move: m, height: 'mid', point: s2.enemy.rig.chest.pos.clone(), zone: 'chest', bone: 'chest', power: 0.2 });
    expect(s2.sim.events.map((e) => e.type)).toEqual(['bump']);
  });

  it('passes a thrown weapon\'s rule energy on as E / K (the ruler applies its zone\'s toughness itself)', () => {
    const { sim, w, player, g } = versus();
    const at = g.rig.shinL.pos.clone();
    const wpn = WEAPONS.kunai;
    const p = projectile(player, wpn, at.clone().add(new Vector3(0, 0, -0.2)), new Vector3(0, 0, 12));
    priv(sim).projectileStrike(p, g, { point: at, zone: 'legs', bone: 'shinL' }, wpn.length, at);
    expect(w.calls.rulerHit).toHaveLength(1);
    const args = w.calls.rulerHit[0];
    expect(args[9]).toBe(wpn);
    const E = impactEnergy(reducedMass(wpn.mass, boneMass(g, 'shinL')), 12, 0.8);
    expect(args[10]).toBeCloseTo(E / DAMAGE_TUNING.K, 9);
    expect(g.hp).toBe(12000);
  });

  it('a ruler doesn\'t bleed DungeonStyle\'s way', () => {
    const { sim, g } = versus();
    g.wounds.push({ bone: 'chest', local: [0, 0.1, 0.1], angle: 0, length: 0.1, bleed: 1, floor: 1, clot: 0 });
    for (let i = 0; i < 60; i++) sim.step();
    expect(g.hp).toBe(12000);
  });
});

describe("DungeonStyle's instant kills go through the rule (RR-12)", () => {
  /** An axe brought straight down on the crown with energy E against T on the head. */
  function crown(T: number, E: number) {
    const { sim, player, enemy } = duel(1);
    enemy.armour = { head: T };
    const m = WEAPON_MOVES.overhead;
    const axe = WEAPONS.axe;
    player.stats.damageMul = E / DAMAGE_TUNING.meleeJPerDmg / blowDamage(player, enemy, m, 1, false, axe);
    const centre = bonePoint(enemy.rig, 'head', 0.13, new Vector3());
    const top = centre.clone().add(new Vector3(0, 0.15, 0).applyQuaternion(enemy.rig.head.rot));
    const down = new Vector3(0, -1, 0).applyQuaternion(enemy.rig.head.rot);
    priv(sim).hit(player, enemy, m, top, new Vector3(1, 0, 0), 'head', 'head', 1, false, axe, down);
    return { ev: hitsOn(sim.events, enemy)[0], ko: kos(sim.events), enemy };
  }

  it('with T = 40 J a 30 J blow can\'t split a skull; 30 J against 20 J does, as it always did against 0', () => {
    const blocked = crown(40, 30);
    expect(blocked.ev.fatal).toBeNull();
    expect(blocked.ev.damage).toBe(0);
    expect(blocked.ev.energy).toBeCloseTo(30, 9);
    expect(blocked.ev.toughness).toBe(40);
    expect(blocked.ko).toEqual([]);
    expect(blocked.enemy.alive).toBe(true);
    for (const T of [20, 0]) {
      const split = crown(T, 30);
      expect(split.ev.fatal, `T = ${T}`).toBe('split');
      expect(split.ko.map((k) => k.by), `T = ${T}`).toEqual(['fatal']);
    }
  });

  it('a blow that does no damage can\'t take a limb off, however cut up it already is', () => {
    const sever = (T: number) => {
      const { sim, player, enemy } = duel(1);
      player.weapon = WEAPONS.axe;
      enemy.armour = { chest: T };
      enemy.limbDamage.foreArmL = 1000;
      const m = WEAPON_MOVES.overhead;
      player.stats.damageMul = 30 / DAMAGE_TUNING.meleeJPerDmg / blowDamage(player, enemy, m, 1, false, null);
      priv(sim).hit(player, enemy, m, enemy.rig.foreArmL.pos.clone(), new Vector3(1, 0, 0), 'chest', 'foreArmL');
      return hitsOn(sim.events, enemy)[0].sever;
    };
    expect(sever(40)).toBeNull();
    expect(sever(20)).toBe('foreArmL');
    expect(sever(0)).toBe('foreArmL');
  });
});

describe('armour by material property (§4.4, RR-3)', () => {
  it("a worn item adds its material's armourJ to the zones it covers; changing only the material changes zoneToughness", () => {
    const { sim, player, enemy } = duel(1);
    const worn = [
      { material: 'hide', zones: ['chest', 'abdomen'] },
      { material: 'bone', zones: ['chest'] },
      { material: 'leaves', zones: ['head'] },
    ] as const;
    enemy.armour = armourFrom(worn, MATERIALS);
    expect(zoneToughness(enemy, 'chest')).toBe(60);
    expect(zoneToughness(enemy, 'abdomen')).toBe(20);
    expect(zoneToughness(enemy, 'head')).toBe(0);
    expect(zoneToughness(enemy, 'legs')).toBe(0);
    // A tougher hide, the same items: more armour, and a blow on the chest meets it.
    setTuningValue('MATERIALS', 'hide.armourJ', 35);
    enemy.armour = armourFrom(worn, MATERIALS);
    expect(zoneToughness(enemy, 'chest')).toBe(75);
    priv(sim).hit(player, enemy, PLAYER_MOVES.cross, enemy.rig.chest.pos.clone(), new Vector3(1, 0, 0), 'chest', 'chest');
    expect(hitsOn(sim.events, enemy)[0].toughness).toBe(75);
  });

  it('no armour code names a material', () => {
    const src = armourFrom.toString();
    for (const id of MATERIAL_IDS) expect(src, id).not.toMatch(new RegExp(`['"\`]${id}['"\`]`));
  });
});

describe('the hands: carrying, dragging, a rope end (§5.1, §5.12)', () => {
  it('a carried log blocks strikes: presses are spent, nothing is thrown', () => {
    const { sim, player } = duel(1.2);
    player.load = { massKg: 30, mode: 'carry' };
    const all: CombatEvent[] = [];
    for (const button of ['rpunch', 'lkick'] as const) {
      sim.commands.push({ tick: sim.frame + 1, player: player.id, kind: 'button', button });
      for (let i = 0; i < 20; i++) all.push(...sim.step());
    }
    expect(all.filter((e) => e.type === 'attackStart' && e.f === player)).toEqual([]);
    expect(player.buffer).toBeNull();
    // Hands empty again, the same press throws.
    player.load = null;
    sim.commands.push({ tick: sim.frame + 1, player: player.id, kind: 'button', button: 'rpunch' });
    sim.step();
    expect(player.state).toBe('attack');
  });

  it('no automatic defence while carrying or dragging; a rope end or a tool leaves it on', () => {
    /** How many of 12 jabs, each a fresh duel, the player defends with `load` in the hands. */
    const defends = (load: Fighter['load']) => {
      let n = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const { sim, player, enemy } = duel(1.1, new CombatSim(seed));
        player.readSkill = 10;
        player.load = load;
        enemy.startMove(ENEMY_MOVES.straight);
        for (let i = 0; i < 30; i++) if (sim.step().some((e) => e.type === 'defend' && e.f === player)) n++;
      }
      return n;
    };
    expect(defends(null)).toBeGreaterThan(6);
    expect(defends({ massKg: 3.8, mode: 'rope' })).toBeGreaterThan(6);
    expect(defends({ massKg: 30, mode: 'carry' })).toBe(0);
    expect(defends({ massKg: 120, mode: 'drag' })).toBe(0);
  });

  it('with a rope end in hand, a punch becomes a pull (on) in queue order; a kick still kicks', () => {
    const { sim, player } = duel(3);
    player.load = { massKg: 3.77, mode: 'rope' };
    const next = sim.frame + 1;
    const focus: Command = { tick: next, player: player.id, kind: 'verb', verb: 'focus', target: 4, at: [100, 50, 0] };
    sim.commands.push(focus);
    sim.commands.push({ tick: next, player: player.id, kind: 'button', button: 'lpunch' });
    sim.commands.push({ tick: next, player: player.id, kind: 'button', button: 'rkick' });
    sim.commands.push({ tick: next, player: player.id, kind: 'button', button: 'rpunch' });
    const pull: Command = { tick: next, player: player.id, kind: 'verb', verb: 'pull', target: 0, charge: COMMAND_STEPS - 1 };
    expect(sim.beginTick()).toEqual([focus, pull, pull]);
    expect(player.buffer?.button).toBe('rkick');
  });

  it('a load slows the walk (carry curve, drag × dragSpeedMul, braced hauling × pullWalkMul) and the regen', () => {
    const { sim, player } = duel(4);
    const mul = () => priv(sim).gaitMul(player);
    expect(mul()).toBe(1);
    player.load = { massKg: 30, mode: 'carry' };
    expect(mul()).toBeCloseTo(0.7, 12);
    player.load = { massKg: 80, mode: 'carry' };
    expect(mul()).toBe(MOVE_TUNING.carrySpeedMin);
    player.load = { massKg: 120, mode: 'drag' };
    expect(mul()).toBe(MOVE_TUNING.dragSpeedMul);
    player.load = { massKg: 3.77, mode: 'rope' };
    expect(mul()).toBeCloseTo(1 - 0.0377, 12);
    player.posture = { id: 'haulRope', weight: 1 };
    expect(mul()).toBeCloseTo((1 - 0.0377) * MOVE_TUNING.pullWalkMul, 12);
    // Regen: standing at rest, 0.085/s × hurt 1 × burden 1, × max(0.4, 1 − 0.015 × m).
    const regen = (load: Fighter['load']) => {
      const s = duel(4);
      s.player.load = load;
      s.player.stamina = 0.5;
      s.sim.step();
      return (s.player.stamina - 0.5) / DT;
    };
    expect(regen(null)).toBeCloseTo(0.085, 9);
    expect(regen({ massKg: 30, mode: 'carry' })).toBeCloseTo(0.085 * 0.55, 9);
    expect(regen({ massKg: 120, mode: 'drag' })).toBeCloseTo(0.085 * MOVE_TUNING.carryRegenMin, 9);
  });
});

describe('moveFlags: sprint and crouch (§5.5)', () => {
  /** A lone player walking forward with `flags` for `ticks` ticks. */
  function walk(flags: number, ticks: number, setup?: (f: Fighter) => void) {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    const f = createPlayer();
    setup?.(f);
    sim.add(f);
    const stamina: number[] = [];
    const mul: number[] = [];
    for (let i = 0; i < ticks; i++) {
      sim.commands.push(moveCommand(sim.frame + 1, f.id, 0, 1, flags));
      sim.step();
      stamina.push(f.stamina);
      mul.push(priv(sim).gaitMul(f));
    }
    return { f, stamina, mul, speed: Math.hypot(f.walkVel.x, f.walkVel.z) };
  }

  it('sprinting is × sprintMul, drains sprintStaminaPerS with no regen, and stops at sprintMinStamina', () => {
    const run = walk(MOVE_SPRINT, 480);
    const plain = walk(0, 120);
    // Faster than walking (the gait at a sprint is × sprintMul on the same profile).
    expect(run.mul[0]).toBe(MOVE_TUNING.sprintMul);
    expect(walk(MOVE_SPRINT, 120).speed).toBeGreaterThan(plain.speed * 1.2);
    // From full: −0.15/60 a tick, exactly, while it lasts.
    let s = 1;
    for (let i = 0; i < 300 && run.mul[i] === MOVE_TUNING.sprintMul; i++) {
      s = Math.max(0, s - MOVE_TUNING.sprintStaminaPerS * DT);
      expect(run.stamina[i], `tick ${i}`).toBe(s);
    }
    // 6 s from 1.0 to 0.1, then no more sprinting.
    const last = run.mul.lastIndexOf(MOVE_TUNING.sprintMul);
    expect(last).toBeGreaterThan(350);
    expect(last).toBeLessThan(365);
    expect(run.mul[last + 1]).toBe(1);
    expect(run.stamina[last]).toBeLessThanOrEqual(MOVE_TUNING.sprintMinStamina + 1e-9);
  });

  it('crouching is × crouchSpeedMul and wins over a sprint held with it; a heavy load allows no sprint', () => {
    const crouch = walk(MOVE_CROUCH, 60);
    expect(crouch.mul[59]).toBe(MOVE_TUNING.crouchSpeedMul);
    const both = walk(MOVE_SPRINT | MOVE_CROUCH, 60);
    expect(both.mul[59]).toBe(MOVE_TUNING.crouchSpeedMul);
    expect(both.stamina[59]).toBe(1);
    const loaded = walk(MOVE_SPRINT, 60, (f) => (f.load = { massKg: 25, mode: 'carry' }));
    expect(loaded.mul[59]).toBeCloseTo(0.75, 12);
    const light = walk(MOVE_SPRINT, 60, (f) => (f.load = { massKg: 15, mode: 'carry' }));
    expect(light.mul[59]).toBeCloseTo(0.85 * MOVE_TUNING.sprintMul, 12);
  });
});

describe('work actions (§5.0)', () => {
  function working(faceAt: { x: number; y: number; z: number }, world = fakeWorld()) {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    sim.world = world.port;
    const f = createPlayer();
    sim.add(f);
    const work: Work = { kind: 'lash', frames: 30, actAt: 20, faceAt, keys: [] };
    f.startWork(work);
    return { sim, f, work, world };
  }

  it('turns toward faceAt by faceTurnRate of what is left, steps in to standOffM, and lands at actAt through the world', () => {
    const { sim, f, world } = working({ x: 1.2, y: 0, z: 0 });
    let yaw = f.yaw;
    const want = Math.PI / 2;
    for (let i = 1; i <= 30; i++) {
      sim.step();
      if (i < 20) {
        yaw += angleDelta(yaw, want) * 0.12;
        expect(f.yaw, `frame ${i}`).toBeCloseTo(yaw, 12);
      }
      expect(world.calls.completeWork.length, `frame ${i}`).toBe(i >= 20 ? 1 : 0);
    }
    expect(world.calls.completeWork[0][0]).toBe(f);
    // In to 0.6 m of it, at DS's pickup pace, and no further.
    expect(f.pos.x).toBeCloseTo(0.6, 12);
    expect(f.state).toBe('idle');
    expect(f.work).toBeNull();
    // The stand-off is live tuning.
    setTuningValue('VERB_TUNING', 'standOffM', 0.9);
    const again = working({ x: 1.2, y: 0, z: 0 });
    for (let i = 0; i < 30; i++) again.sim.step();
    expect(again.f.pos.x).toBeCloseTo(0.3, 12);
  });

  it('steps in VERB_TUNING.workStepM × scale a tick (live tuning, not a bare constant: core-fix)', () => {
    setTuningValue('VERB_TUNING', 'workStepM', 0.02);
    const { sim, f } = working({ x: 1.2, y: 0, z: 0 });
    sim.step();
    const x1 = f.pos.x;
    sim.step();
    expect(f.pos.x - x1).toBeCloseTo(0.02, 12);
    f.scale = 1.5;
    const x2 = f.pos.x;
    sim.step();
    expect(f.pos.x - x2).toBeCloseTo(0.03, 12);
  });

  it('leaves the fighter to the world when completeWork ends the action or starts another', () => {
    const next: Work = { kind: 'tie', frames: 10, actAt: 5, faceAt: { x: 0, y: 0, z: 1 }, keys: [] };
    const chained = working({ x: 0, y: 0, z: 1 }, fakeWorld({ completeWork: (f) => (f.work?.kind === 'lash' ? f.startWork(next) : undefined) }));
    for (let i = 0; i < 20; i++) chained.sim.step();
    expect(chained.f.state).toBe('pickup');
    expect(chained.f.work).toBe(next);
    expect(chained.f.stateFrame).toBe(0);
    expect(chained.world.calls.completeWork).toHaveLength(1);
    for (let i = 0; i < 5; i++) chained.sim.step();
    expect(chained.world.calls.completeWork).toHaveLength(2);
    expect(chained.f.state).toBe('pickup');
    for (let i = 0; i < 5; i++) chained.sim.step();
    expect(chained.f.state).toBe('idle');

    const ended = working({ x: 0, y: 0, z: 1 }, fakeWorld({ completeWork: (f) => f.enterLocomotion(4) }));
    for (let i = 0; i < 20; i++) ended.sim.step();
    expect(ended.f.state).not.toBe('pickup');
    expect(ended.world.calls.completeWork).toHaveLength(1);
  });

  it('without a world a work action only runs its frames (no turning, stepping or completeWork)', () => {
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    const f = createPlayer();
    sim.add(f);
    f.startWork({ kind: 'lash', frames: 30, actAt: 20, faceAt: { x: 1.2, y: 0, z: 0 }, keys: [] });
    for (let i = 0; i < 30; i++) sim.step();
    expect(f.yaw).toBe(0);
    expect(f.pos.x).toBe(0);
    expect(f.state).toBe('idle');
  });
});

describe('throws (§5.11)', () => {
  /** The player throws `w` with `aim`; returns the projectile launched (if any) and the world's calls. */
  function throwIt(w: WeaponDef, aim: Fighter['throwAim'], world = fakeWorld()) {
    const { sim, player } = duel(6);
    sim.walkable = OPEN;
    sim.world = world.port;
    player.weapon = w;
    player.throwAim = aim;
    const m = WEAPON_MOVES.throwOne;
    player.startMove(m);
    let thrown: Projectile | null = null;
    for (let i = 0; i < 60 && !thrown; i++) for (const e of sim.step()) if (e.type === 'throw') thrown = e.projectile;
    return { thrown, player, world, m };
  }

  it('an aimed throw leaves along the aim at launchSpeed(m, techSpeed) × speedFrac, never at the target', () => {
    const dir = new Vector3(-1, 0.3, 0.5).normalize();
    for (const [w, techSpeed] of [
      [WEAPONS.kunai, 20],
      [WEAPONS.axe, 20],
    ] as const) {
      const { thrown, player } = throwIt(w, { dir: dir.clone(), speedFrac: 0.75, techSpeed });
      expect(thrown, w.id).not.toBeNull();
      const speed = launchSpeed(w.mass, techSpeed) * 0.75;
      // DS scatter turns it about the vertical (a horizontal speed it keeps exactly) and nudges it up or down.
      expect(Math.hypot(thrown!.vel.x, thrown!.vel.z), w.id).toBeCloseTo(speed * Math.hypot(dir.x, dir.z), 9);
      expect(Math.abs(thrown!.vel.y - dir.y * speed), w.id).toBeLessThanOrEqual(0.06 * speed);
      const off = angleDelta(Math.atan2(dir.x, dir.z), Math.atan2(thrown!.vel.x, thrown!.vel.z));
      expect(Math.abs(off), w.id).toBeLessThanOrEqual(0.06);
      // (Away from the brawler, who is 6 m off along +x.)
      expect(thrown!.vel.x, w.id).toBeLessThan(0);
      expect(player.throwAim).toBeNull();
    }
    // The 400 J cap: a 2.6 kg axe can't leave at 20 m/s.
    expect(launchSpeed(WEAPONS.axe.mass, 20)).toBeLessThan(20);
  });

  it('a throw the world launches as a body makes no projectile (and spends the aim)', () => {
    const world = fakeWorld({ throwRelease: () => true });
    const { thrown, player, m } = throwIt(WEAPONS.kunai, { dir: new Vector3(0, 0, 1), speedFrac: 1, techSpeed: 20 }, world);
    expect(thrown).toBeNull();
    expect(world.calls.throwRelease).toHaveLength(1);
    expect(world.calls.throwRelease[0][0]).toBe(player);
    expect(world.calls.throwRelease[0][1].id).toBe(m.id);
    expect(player.throwAim).toBeNull();
  });
});

describe('the strike seam: swings that meet no body (§5.2)', () => {
  it('offers an armed swing\'s blade, last tick\'s and this tick\'s, to the world; what it meets stops the swing', () => {
    const answer: WorldStrike = {
      point: new Vector3(0, 1, 1), normal: new Vector3(0, 0, -1), owner: { kind: 'entity', id: 3 }, effect: 'chop',
      reaction: { mode: 'stick', hold: 18, retract: 12 },
    };
    let n = 0;
    const world = fakeWorld({ strike: () => (++n === 3 ? answer : null) });
    const sim = new CombatSim(1);
    sim.world = world.port;
    // In world mode the arena's props are never consulted.
    sim.walkable = { resolve: () => {}, isWalkable: () => true, solidAt: () => { throw new Error('solidAt in world mode'); } };
    const f = createPlayer();
    f.weapon = WEAPONS.axe;
    sim.add(f);
    f.startMove(f.moveDef('overhead')!);
    const events: CombatEvent[] = [];
    for (let i = 0; i < 80 && world.calls.strike.length < 3; i++) events.push(...sim.step());
    // The world's reaction, applied on the spot: the edge bites in and is held, then wrenched free.
    expect(f.stuckUntil).toBe(f.stateFrame + 18);
    expect(f.attackEnd).toBe(f.stateFrame + 18 + 12);
    for (let i = 0; i < 80; i++) events.push(...sim.step());
    const calls = world.calls.strike;
    expect(calls).toHaveLength(3);
    const offs = sampleOffsets(WEAPONS.axe);
    for (const [i, [a, prev, pts, o, w]] of calls.entries()) {
      expect(a).toBe(f);
      expect(w).toBe(WEAPONS.axe);
      expect(o).toEqual(offs);
      expect(pts).toHaveLength(offs.length);
      if (i === 0) expect(prev).toBeNull();
      else expect(prev!.map((v) => v.toArray())).toEqual(calls[i - 1][2].map((v) => v.toArray()));
    }
    expect(events.filter((e) => e.type === 'clang')).toEqual([]);
  });

  it('offers a fist to the world unarmed; a clang is DungeonStyle\'s event', () => {
    const answer: WorldStrike = {
      point: new Vector3(0, 1.5, 0.6), normal: new Vector3(0, 0, -1), owner: { kind: 'entity', id: 9 }, effect: 'clang',
      reaction: { mode: 'rebound', hold: 2, retract: 10 },
    };
    const world = fakeWorld({ strike: () => answer });
    const sim = new CombatSim(1);
    sim.walkable = OPEN;
    sim.world = world.port;
    const f = createPlayer();
    sim.add(f);
    f.startMove(PLAYER_MOVES.cross);
    const events: CombatEvent[] = [];
    for (let i = 0; i < 40; i++) events.push(...sim.step());
    expect(world.calls.strike).toHaveLength(1);
    const [, prev, pts, offs, w] = world.calls.strike[0];
    expect([prev, offs, w]).toEqual([null, [0], null]);
    expect(pts).toHaveLength(1);
    const clangs = events.filter((e): e is Extract<CombatEvent, { type: 'clang' }> => e.type === 'clang');
    expect(clangs).toHaveLength(1);
    expect(clangs[0]).toMatchObject({ f, metal: false });
    expect(clangs[0].point.toArray()).toEqual([0, 1.5, 0.6]);
  });
});

describe('the other world calls', () => {
  it('tryVerb: every fighter, every tick, in order, after the presses and before bleeding', () => {
    const world = fakeWorld();
    const { sim, player, enemy } = duel(2);
    sim.world = world.port;
    for (let i = 0; i < 5; i++) sim.step();
    expect(world.calls.tryVerb.map(([f]) => f)).toEqual(Array.from({ length: 5 }, () => [player, enemy]).flat());
  });

  it('a weapon let go of in world mode is the world\'s (no DS drop); one the world turns down asserts with devChecks', () => {
    const world = fakeWorld();
    const { sim, player } = duel(2);
    sim.world = world.port;
    player.weapon = WEAPONS.machete;
    sim.dropWeapon(player);
    expect(world.calls.onWeaponDropped).toEqual([[player]]);
    expect(player.weapon).toBeNull();
    expect(sim.drops).toEqual([]);
    expect(sim.events.some((e) => e.type === 'drop')).toBe(false);
    const s2 = duel(2);
    s2.sim.world = fakeWorld({ onWeaponDropped: () => false }).port;
    s2.player.weapon = WEAPONS.machete;
    s2.sim.dropWeapon(s2.player);
    expect(s2.sim.drops).toHaveLength(1);
    s2.sim.devChecks = true;
    s2.player.weapon = WEAPONS.machete;
    expect(() => s2.sim.dropWeapon(s2.player)).toThrow(/addDrop/);
    // devChecks only assert in world mode.
    const legacy = duel(2);
    legacy.sim.devChecks = true;
    legacy.player.weapon = WEAPONS.machete;
    legacy.sim.dropWeapon(legacy.player);
    expect(legacy.sim.drops).toHaveLength(1);
  });
});

describe('verbAim: strikes at a focused point (§5.2)', () => {
  /** A player with an axe, a brawler `dist` m off along +x, and a focus 1.5 m ahead (+z) at `y`. */
  function focused(dist: number, y: number) {
    const { sim, player, enemy } = duel(dist);
    player.weapon = WEAPONS.axe;
    player.yaw = 0;
    sim.step();
    player.verbAim = new Vector3(0, y, 1.5);
    return { sim, player, enemy };
  }

  it('fits a swing to the focused point when not locked on, from the fighter\'s own feet', () => {
    const { player } = focused(6, 1.0);
    expect(player.lockedOn).toBe(false);
    const m = player.moveDef('overhead')!;
    const got = fit(player).weaponFit(m, null)!;
    const lunge = m.lunge?.distance ?? 0;
    const ahead = Math.max(0.37, 1.5 - lunge);
    expect(got.target[0]).toBeCloseTo(0, 12);
    expect(got.target[1]).toBeCloseTo(1.0, 12);
    expect(got.target[2]).toBeCloseTo(ahead, 12);
    // On raised ground the point is measured from the feet.
    player.pos.y = 0.4;
    expect(fit(player).weaponFit(m, null)!.target[1]).toBeCloseTo(0.6, 12);
    // Height gaps (what aims, canReach and the swing's lift read) are to the point.
    player.pos.y = 0;
    const gap = (h: number) => (Math.abs(h) < 0.1 ? 0 : h - Math.sign(h) * 0.1);
    expect(fit(player).heightGap(m, null)).toBeCloseTo(gap(1.0 - { high: 1.55, mid: 1.11, low: 0.54 }[m.height]), 12);
    // A focus 3 m up is out of a jab's reach; at chest height it isn't.
    player.verbAim = new Vector3(0, 3, 1.5);
    expect(player.canReach(PLAYER_MOVES.jab)).toBe(false);
    player.verbAim = new Vector3(0, 1.5, 1.5);
    expect(player.canReach(PLAYER_MOVES.jab)).toBe(true);
  });

  it('locked on to a creature, the swing goes at the creature as in DungeonStyle', () => {
    const { player } = focused(1.5, 1.0);
    expect(player.lockedOn).toBe(true);
    const m = player.moveDef('overhead')!;
    const withFocus = fit(player).weaponFit(m, null);
    const gapWith = fit(player).heightGap(m, null);
    player.verbAim = null;
    expect(fit(player).weaponFit(m, null)).toEqual(withFocus);
    expect(fit(player).heightGap(m, null)).toBe(gapWith);
  });
});
