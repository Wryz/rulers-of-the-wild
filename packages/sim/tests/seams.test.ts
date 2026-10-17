// CombatSim's legacy-identical seams and the fighter's M1 fields (docs/M1-DESIGN.md §1.5.2-1.5.4, §3 phase 1a and 3,
// §4.1, §4.4; work package P02a). With every seam at its default, CombatSim is DungeonStyle's (tests/legacyReplay);
// these tests show what each seam does when a world sets it.
import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackKey } from '../src/body/animator';
import { getPose } from '../src/body/poses';
import { ANKLE_HEIGHT, BONES, bonePoint, forwardKinematics, makeRig, SKELETON } from '../src/body/skeleton';
import { BrawlerAI, type Brain } from '../src/sim/ai';
import { blowDamage, type CombatEvent, CombatSim, FLAT_GROUND, type HurtZone } from '../src/sim/combat';
import { type Command, MOVE_CROUCH, MOVE_SPRINT, moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import { Fighter, GETUP_FRAMES, IdCounter, LEGACY_IDS } from '../src/sim/fighter';
import { DT, Rng, seedFor } from '../src/sim/math';
import { ENEMY_MOVES, PLAYER_MOVES, type MoveDef } from '../src/sim/moves';
import type { Projectile } from '../src/sim/projectiles';
import { createBrawler, createPlayer } from '../src/sim/roster';
import {
  DAMAGE_TUNING,
  hpFromEnergy,
  impactEnergy,
  launchSpeed,
  MOVE_TUNING,
  reducedMass,
  zoneToughness,
} from '../src/sim/rules';
import { WEAPON_MOVES, WEAPONS } from '../src/sim/weapons';
import { resetTuning, setTuningValue, TUNING, tuningLeaves } from '../src/tuning/registry';
import type { BoneName } from '../src/body/skeleton';
import type { Finish, FighterMover, GroundQuery, Work, WorldPort } from '../src/world/types';

afterEach(() => {
  resetTuning('DAMAGE_TUNING');
  resetTuning('MOVE_TUNING');
});

/**
 * A player and a passive brawler `dist` apart, facing each other, numbered from `ids` (a fresh counter by default,
 * so two duels are alike down to the fighters' own rng streams).
 */
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

/** CombatSim.hit, private, called the way the tests of DungeonStyle call it (positionally). */
function hit(sim: CombatSim, a: Fighter, d: Fighter, m: MoveDef, zone: HurtZone, bone: BoneName) {
  const call = sim as unknown as { hit(...args: unknown[]): void };
  call.hit(a, d, m, d.rig[bone].pos.clone(), new Vector3(1, 0, 0), zone, bone);
}

/** A world port that only answers knockouts (the rest are P02b's readers). */
function port(onKO: WorldPort['onKO']): WorldPort {
  return {
    strike: () => null,
    tryVerb: () => {},
    completeWork: () => {},
    throwRelease: () => false,
    projectile: () => null,
    onProjectileLanded: () => false,
    onKO,
    onWeaponDropped: () => false,
    rulerHit: () => {},
  };
}

describe('world-owned fighter ids', () => {
  it('number two worlds\' fighters 1..n alike in one process, without touching the legacy counter', () => {
    const legacy = LEGACY_IDS.next;
    const make = () => {
      const ids = new IdCounter();
      const p = createPlayer({ ids, rngSeed: seedFor(77, 'fighter', ids.next) });
      const { fighter: e } = createEnemy('brawler', new Rng(1), {}, {}, { ids, rngSeed: seedFor(77, 'fighter', ids.next) });
      const b = createBrawler(new Rng(1), {}, { ids }).fighter;
      return { ids, fighters: [p, e, b] };
    };
    const w1 = make();
    const w2 = make();
    expect(w1.fighters.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(w2.fighters.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(w1.ids.next).toBe(4);
    expect(LEGACY_IDS.next).toBe(legacy);
    // A world seed gives the fighter's own stream; without one it is DungeonStyle's id * 7919 + 13.
    // (Making a fighter draws twice from its stream: the idle life's start phases, MAP gap-7 §3.7.)
    const rngOf = (f: Fighter) => (f as unknown as { rng: Rng }).rng;
    const made = (seed: number) => {
      const r = new Rng(seed);
      r.range(0, 10);
      r.range(0, Math.PI);
      return r.state;
    };
    expect(rngOf(w1.fighters[0]).state).toBe(made(seedFor(77, 'fighter', 1)));
    expect(rngOf(w1.fighters[1]).state).toBe(made(seedFor(77, 'fighter', 2)));
    expect(rngOf(w1.fighters[2]).state).toBe(made(3 * 7919 + 13));
    expect(rngOf(w2.fighters[1]).state).toBe(rngOf(w1.fighters[1]).state);
    // The legacy counter still numbers fighters made without a world.
    const f = createPlayer();
    expect(f.id).toBe(legacy);
    expect(LEGACY_IDS.next).toBe(legacy + 1);
  });

  it('give two worlds built alike the same 600-tick fight', () => {
    const run = () => {
      const ids = new IdCounter();
      const sim = new CombatSim(seedFor(5, 'combat'));
      const p = createPlayer({ ids, rngSeed: seedFor(5, 'fighter', ids.next) });
      const { fighter: e, ai } = createEnemy('kicker', sim.rng, {}, {}, { ids, rngSeed: seedFor(5, 'fighter', ids.next) });
      p.pos.set(0, 0, 0);
      e.pos.set(1.4, 0, 0.3);
      sim.add(p);
      sim.add(e, ai);
      const trace: number[] = [];
      for (let t = 0; t < 600; t++) {
        if (t % 9 === 0) sim.commands.push({ tick: sim.frame + 1, player: p.id, kind: 'button', button: t % 2 ? 'lpunch' : 'rkick' });
        sim.step();
        trace.push(p.pos.x, p.pos.z, p.hp, e.pos.x, e.pos.z, e.hp, sim.rng.state);
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

describe('the tick split: beginTick and stepBody', () => {
  it('step() is beginTick() then stepBody()', () => {
    const a = duel();
    const b = duel();
    for (let t = 0; t < 240; t++) {
      if (t % 13 === 0) {
        for (const s of [a, b]) s.sim.commands.push({ tick: s.sim.frame + 1, player: s.player.id, kind: 'button', button: 'rpunch' });
      }
      const ea = a.sim.step();
      b.sim.beginTick();
      const eb = b.sim.stepBody();
      expect(eb.map((e) => e.type)).toEqual(ea.map((e) => e.type));
    }
    expect(b.sim.frame).toBe(a.sim.frame);
    expect(b.enemy.hp).toBe(a.enemy.hp);
    expect(b.player.pos.toArray()).toEqual(a.player.pos.toArray());
  });

  it('applies move and button commands in queue order and hands back verb and meta commands in queue order', () => {
    const { sim, player } = duel();
    const next = sim.frame + 1;
    const verb: Command = { tick: next, player: player.id, kind: 'verb', verb: 'focus', target: 0, at: [100, 0, 0] };
    const meta: Command = { tick: next, player: player.id, kind: 'meta', meta: 'save' };
    const verb2: Command = { tick: next, player: 99, kind: 'verb', verb: 'take', target: 4 };
    sim.commands.push(verb);
    sim.commands.push(moveCommand(next, player.id, 0, 1, MOVE_SPRINT | MOVE_CROUCH));
    sim.commands.push(meta);
    sim.commands.push({ tick: next, player: player.id, kind: 'button', button: 'lpunch' });
    sim.commands.push(verb2);
    sim.events.push({ type: 'getup', f: player });
    const rest = sim.beginTick();
    expect(rest).toEqual([verb, meta, verb2]);
    expect(sim.frame).toBe(next);
    expect(sim.events).toEqual([]);
    expect(sim.director.frame).toBe(next);
    expect(player.moveInput.z).toBeCloseTo(1, 9);
    expect(player.moveFlags).toBe(MOVE_SPRINT | MOVE_CROUCH);
    expect(player.buffer?.button).toBe('lpunch');
    // A move without flags clears them.
    sim.stepBody();
    sim.commands.push(moveCommand(sim.frame + 1, player.id, 1, 0));
    sim.beginTick();
    expect(player.moveFlags).toBe(0);
  });

  it('maps a command to its player number through playerFighter when a world sets it (else by fighter id)', () => {
    const { sim, player, enemy } = duel(1, new CombatSim(3), new IdCounter(5));
    expect(player.id).toBe(5);
    sim.commands.push(moveCommand(sim.frame + 1, 1, 0, 1));
    sim.step();
    expect(player.moveInput.length()).toBe(0);
    sim.playerFighter = (n) => (n === 1 ? player : undefined);
    sim.commands.push(moveCommand(sim.frame + 1, 1, 0, 1));
    sim.commands.push(moveCommand(sim.frame + 1, enemy.id, 1, 0));
    sim.step();
    expect(player.moveInput.z).toBeCloseTo(1, 9);
    expect(enemy.moveInput.x).toBe(0);
  });

  it("buffers a 'jump' press for jumpBufferFrames ticks of the mover's attention", () => {
    const { sim, player } = duel();
    const seen: number[] = [];
    sim.mover = { resolve: (f) => void (f === player && seen.push(f.jumpRequest)) };
    sim.commands.push({ tick: sim.frame + 1, player: player.id, kind: 'button', button: 'jump' });
    sim.beginTick();
    expect(player.jumpRequest).toBe(MOVE_TUNING.jumpBufferFrames);
    sim.stepBody();
    for (let i = 0; i < 8; i++) sim.step();
    expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0, 0, 0]);
    expect(player.jumpRequest).toBe(0);
    // A KO'd fighter's presses are dropped, as DungeonStyle drops them.
    player.enterKO();
    sim.commands.push({ tick: sim.frame + 1, player: player.id, kind: 'button', button: 'jump' });
    sim.beginTick();
    expect(player.jumpRequest).toBe(0);
  });
});

describe('the seams', () => {
  it('physicsOwnsDowned is the one flag: DungeonStyle\'s externalKnockdown is gone (MAP gap-7 §3.1, RF-8)', () => {
    const sim = new CombatSim();
    expect(sim.physicsOwnsDowned).toBe(false);
    // Neither an own field nor an accessor on the prototype: a write to it would be a new, ignored property.
    expect('externalKnockdown' in sim).toBe(false);
  });

  it('defaults to DungeonStyle: no mover, no world, flat ground, the fighter-id reading of commands', () => {
    const sim = new CombatSim();
    expect(sim.mover).toBeNull();
    expect(sim.world).toBeNull();
    expect(sim.playerFighter).toBeNull();
    expect(sim.ground).toBe(FLAT_GROUND);
    expect(FLAT_GROUND.heightAt(12, -3)).toBe(0);
    expect(FLAT_GROUND.supportAt).toBeUndefined();
    const { sim: s2, player } = duel();
    expect(player.ground).toBeNull();
    // sim.ais holds Brains, whose cfg the DS tests tune (styles.test.ts, size.test.ts).
    const brain: Brain | undefined = s2.ais.values().next().value;
    expect(brain).toBeInstanceOf(BrawlerAI);
    expect(brain!.cfg.passive).toBe(true);
    expect(brain!.ownsTarget).toBe(false);
  });

  it('leaves a brain that owns its target alone (no retargeting); DS brains are locked onto the nearest', () => {
    const run = (ownsTarget: boolean) => {
      const sim = new CombatSim(3);
      const ids = new IdCounter();
      const near = createPlayer({ ids });
      const far = createPlayer({ ids });
      const { fighter: e, ai } = createBrawler(sim.rng, { passive: true }, { ids });
      const brain: Brain = { cfg: ai.cfg, director: null, drops: [], ownsTarget, think: () => {} };
      near.pos.set(1, 0, 0);
      far.pos.set(-5, 0, 0);
      sim.add(near);
      sim.add(far);
      sim.add(e, brain);
      e.target = far;
      for (let i = 0; i < 30; i++) sim.step();
      return { e, near, far };
    };
    const own = run(true);
    expect(own.e.target).toBe(own.far);
    const ds = run(false);
    expect(ds.e.target).toBe(ds.near);
  });

  it('lets the mover resolve each standing fighter once per tick, in order, y included; downed bodies are left alone', () => {
    const { sim, player, enemy } = duel();
    const calls: [number, number, number][] = [];
    const mover: FighterMover = {
      resolve: (f, r, pad) => {
        calls.push([f.id, r, pad]);
        f.pos.y = 1.25;
      },
    };
    sim.mover = mover;
    enemy.scale = 1.5;
    sim.step();
    expect(calls).toEqual([
      [player.id, 0.3, 0.14],
      [enemy.id, 0.3 * 1.5, 0.14 * 1.5],
    ]);
    expect(player.pos.y).toBe(1.25);
    calls.length = 0;
    enemy.enterKnockdown();
    player.setState('tripped');
    player.pos.y = 0.4;
    sim.step();
    expect(calls).toEqual([]);
    expect(player.pos.y).toBe(0.4);
  });

  it('puts fighters, their feet and dropped weapons on the ground a world gives, without a mover', () => {
    const { sim, player, enemy } = duel(1.6);
    const ground: GroundQuery = { heightAt: (x) => 0.2 + 0.05 * x };
    sim.ground = ground;
    expect(player.ground).toBe(ground);
    expect(enemy.ground).toBe(ground);
    sim.commands.push(moveCommand(sim.frame + 1, player.id, 0, 1));
    let planted = 0;
    for (let i = 0; i < 40; i++) {
      sim.step();
      for (const f of [player, enemy]) {
        expect(f.pos.y).toBeCloseTo(ground.heightAt(f.pos.x, f.pos.z), 12);
        for (const foot of [f.footwork.L, f.footwork.R]) {
          if (foot.stepping) continue;
          expect(foot.pos.y).toBeCloseTo(ground.heightAt(foot.pos.x, foot.pos.z), 12);
          planted++;
        }
      }
    }
    expect(planted).toBeGreaterThan(40);
    const drop = sim.addDrop(WEAPONS.machete, 3, 1);
    expect(drop.pos.y).toBeCloseTo(0.35, 12);
    // A fighter added later gets it too; flat ground again clears it.
    const late = createPlayer();
    sim.add(late);
    expect(late.ground).toBe(ground);
    sim.ground = FLAT_GROUND;
    expect(late.ground).toBeNull();
    sim.step();
    expect(late.pos.y).toBe(0);
  });

  it('plants feet on what supports them (supportAt) before the terrain', () => {
    const { sim, player } = duel(2);
    sim.ground = { heightAt: () => 0, supportAt: (x) => (x < 0.05 ? 0.3 : 0) };
    sim.commands.push(moveCommand(sim.frame + 1, player.id, 0, 1));
    const seen = { onSupport: 0, onTerrain: 0 };
    for (let i = 0; i < 30; i++) {
      sim.step();
      for (const foot of [player.footwork.L, player.footwork.R]) {
        if (foot.stepping) continue;
        expect(foot.pos.y).toBe(foot.pos.x < 0.05 ? 0.3 : 0);
        seen[foot.pos.x < 0.05 ? 'onSupport' : 'onTerrain']++;
      }
    }
    expect(seen.onSupport).toBeGreaterThan(0);
    expect(seen.onTerrain).toBeGreaterThan(0);
  });

  it('lands every step on the ground where the foot comes down, walking up a grade (re-planted as it re-aims)', () => {
    const sim = new CombatSim(1);
    sim.walkable = { resolve: () => {}, isWalkable: () => true };
    const ground: GroundQuery = { heightAt: (_x, z) => 0.1 * z };
    sim.ground = ground;
    const f = new Fighter('player', 'Walker', PLAYER_MOVES, { walkSpeed: 2.6 }, undefined, { ids: new IdCounter() });
    sim.add(f);
    let landings = 0;
    const was = { L: false, R: false };
    for (let i = 0; i < 240; i++) {
      sim.commands.push(moveCommand(sim.frame + 1, f.id, 0, 1));
      sim.step();
      for (const foot of [f.footwork.L, f.footwork.R]) {
        // A foot that has just come down (its stride re-aimed every tick as the body walks on).
        if (was[foot.side] && !foot.stepping) {
          expect(foot.pos.y, `tick ${i}`).toBeCloseTo(ground.heightAt(foot.pos.x, foot.pos.z), 12);
          landings++;
        }
        was[foot.side] = foot.stepping;
      }
    }
    expect(f.pos.z).toBeGreaterThan(3);
    expect(landings).toBeGreaterThan(10);
  });

  it('reaches each planted foot with the leg on gentle slopes: the rig\'s ankles sit as they do on flat ground', () => {
    /** Each tick, each foot of both fighters: the rig's ankle (the shin's end) above the foot's planted point. */
    const ankles = (ground: GroundQuery | null) => {
      const sim = new CombatSim(3);
      if (ground) sim.ground = ground;
      const { player, enemy } = duel(1.6, sim);
      const out: number[] = [];
      let still = 0;
      const at = new Vector3();
      for (let i = 0; i < 120; i++) {
        sim.step();
        for (const f of [player, enemy]) {
          for (const foot of [f.footwork.L, f.footwork.R]) {
            const shin = foot.side === 'L' ? 'shinL' : 'shinR';
            out.push(bonePoint(f.rig, shin, SKELETON[shin].length, at).y - foot.pos.y);
            if (!foot.stepping) still++;
          }
        }
      }
      return { out, still };
    };
    const flat = ankles(null);
    expect(flat.still).toBeGreaterThan(100);
    // (On flat ground a planted ankle is ANKLE_HEIGHT up, give or take the toes and the guard's bent knees.)
    expect(Math.min(...flat.out)).toBeGreaterThan(ANKLE_HEIGHT - 0.05);
    for (const ground of [{ heightAt: (x: number) => 0.05 * x }, { heightAt: (_x: number, z: number) => 0.2 - 0.05 * z }]) {
      const slope = ankles(ground);
      // The feet stand where they would on flat ground (only y differs), and each leg reaches its foot as it would.
      expect(slope.out.length).toBe(flat.out.length);
      for (let i = 0; i < flat.out.length; i++) expect(Math.abs(slope.out[i] - flat.out[i])).toBeLessThan(1e-9);
    }
  });
});

describe('strikes on raised ground (§4.1; MAP tests §7.5 C2)', () => {
  /** Whether `id` lands from `dist` on a passive brawler, everyone standing on ground at `h`. */
  /** The first hit `id` lands from `dist` on a passive brawler, everyone standing on ground at `h` (null: none). */
  function lands(id: string, dist: number, h: number, weapon: keyof typeof WEAPONS | null): { frame: number; damage: number; bone: BoneName } | null {
    const sim = new CombatSim(1);
    if (h !== 0) sim.ground = { heightAt: () => h };
    const { player: p, enemy: e } = duel(dist, sim);
    p.autoDefense = false;
    if (weapon) p.weapon = WEAPONS[weapon];
    sim.step();
    expect(p.pos.y).toBe(h);
    expect(e.pos.y).toBe(h);
    const m = weapon ? p.moveDef(id)! : p.moves[id];
    p.startMove(m, false, m.aims?.[0].id ?? 'primary');
    let first: { frame: number; damage: number; bone: BoneName } | null = null;
    for (let i = 0; i < 80 && !first; i++) for (const ev of hitsOn(sim.step(), e)) first ??= { frame: i, damage: ev.damage, bone: ev.bone };
    // Feet stay on the raised ground.
    for (const foot of [p.footwork.L, p.footwork.R]) expect(foot.pos.y).toBe(h);
    return first;
  }

  it('every unarmed move lands (or misses) exactly as on flat ground, with the same damage', () => {
    let landed = 0;
    const moves = Object.values(PLAYER_MOVES).filter((m) => !m.noHit && !m.throw);
    for (const m of moves) {
      const dist = Math.min(4, Math.max(0.75, m.reach * 0.85));
      const flat = lands(m.id, dist, 0, null);
      const raised = lands(m.id, dist, 0.5, null);
      expect(raised !== null, `${m.id} at ${dist.toFixed(2)} m`).toBe(flat !== null);
      if (flat && raised) {
        landed++;
        expect(raised.frame, m.id).toBe(flat.frame);
        expect(raised.bone, m.id).toBe(flat.bone);
        expect(raised.damage, m.id).toBeCloseTo(flat.damage, 6);
      }
    }
    expect(landed).toBeGreaterThanOrEqual(Math.ceil(moves.length * 0.8));
  });

  it('weapon strikes are fitted to the target above the attacker\'s own feet and land the same', () => {
    for (const [w, ids] of [
      ['axe', ['sweep', 'overhead', 'sweepBack']],
      ['machete', ['slash', 'chop']],
      ['gladius', ['thrust']],
    ] as const) {
      for (const id of ids) {
        const flat = lands(id, 1.5, 0, w);
        const raised = lands(id, 1.5, 0.5, w);
        expect(flat, `${w} ${id}`).not.toBeNull();
        expect(raised, `${w} ${id}`).not.toBeNull();
        // The same part of the body, at the same moment of the swing, as hard. (Measured against the same fighters'
        // rng streams: the strike's natural scatter comes from them.)
        expect(raised!.bone, `${w} ${id}`).toBe(flat!.bone);
        expect(raised!.frame, `${w} ${id}`).toBe(flat!.frame);
        expect(raised!.damage, `${w} ${id}`).toBeCloseTo(flat!.damage, 6);
      }
    }
  });

  it('a thrown weapon lands on the raised floor, not below it', () => {
    const sim = new CombatSim(2);
    sim.ground = { heightAt: () => 0.5 };
    const p = createPlayer();
    p.weapon = WEAPONS.axe;
    sim.add(p);
    sim.step();
    p.startMove(p.moveDef('throwHeavy')!);
    let low = Infinity;
    const drops: number[] = [];
    for (let i = 0; i < 400; i++) {
      for (const ev of sim.step()) if (ev.type === 'drop') drops.push(ev.drop.pos.y);
      for (const q of sim.projectiles) low = Math.min(low, q.pos.y);
    }
    expect(drops).toEqual([0.5]);
    expect(low).toBeGreaterThan(0.5);
  });

  it('defends against a thrown weapon coming in low over the raised floor, not one that will be under it', () => {
    /** Whether the player, on ground 0.5, reacts to an axe thrown at it that will be at height `y` when it arrives. */
    const reacts = (y: number) => {
      const sim = new CombatSim(4);
      sim.ground = { heightAt: () => 0.5 };
      const { player, enemy } = duel(3, sim);
      sim.step();
      expect(player.pos.y).toBe(0.5);
      // (Sharp enough to read anything in time: the roll always comes up.)
      player.readSkill = 10;
      // 1.5 m out at 10 m/s: 0.15 s (9 frames) away, falling 4.9 × 0.15² m on the way.
      const tc = 0.15;
      const p: Projectile = {
        id: 1, serial: -1001, weapon: WEAPONS.axe, owner: enemy, scale: 1, pos: new Vector3(1.5, y + 4.9 * tc * tc, 0),
        vel: new Vector3(-10, 0, 0), axis: new Vector3(0, 0, 1), omega: 0, angle: 0, dir0: new Vector3(1, 0, 0), com: 0.4,
        live: true, age: 3,
      };
      sim.projectiles.push(p);
      (sim as unknown as { defendProjectiles(f: Fighter): void }).defendProjectiles(player);
      return sim.events.some((e) => e.type === 'defend' && e.f === player);
    };
    // Low over the floor: legs out of the way.
    expect(reacts(0.7)).toBe(true);
    // Under the floor there: it lands before it gets to them.
    expect(reacts(0.3)).toBe(false);
  });
});

describe('knockouts: koFighter', () => {
  it('is the only way into ko, once: one ko event, the world asked once, a second call does nothing', () => {
    const { sim, player, enemy } = duel();
    const asked: [Fighter, Finish][] = [];
    sim.world = port((d, finish) => {
      asked.push([d, finish]);
      return { environmental: true, credit: ['p1'] };
    });
    const finish: Finish = { by: 'impact', killer: null, cause: null, point: { x: 1, y: 2, z: 3 } };
    sim.koFighter(enemy, finish);
    expect(enemy.state).toBe('ko');
    expect(enemy.alive).toBe(false);
    const first = kos(sim.events);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ victim: enemy, by: 'impact', killer: null, cause: null, environmental: true, credit: ['p1'] });
    expect(first[0].point.toArray()).toEqual([1, 2, 3]);
    expect(asked).toEqual([[enemy, finish]]);
    // The world and the event each hold their own copy of the point (a caller may pass a live vector).
    expect(asked[0][1].point).not.toBe(finish.point);
    expect(asked[0][1].point).not.toBe(first[0].point);
    enemy.stateFrame = 30;
    sim.koFighter(enemy, { ...finish, by: 'strike' });
    expect(kos(sim.events)).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(enemy.stateFrame).toBe(30);
    expect(player.alive).toBe(true);
  });

  it('reports a strike KO by its killer and cause, after which hit() reports the hit as before', () => {
    const { sim, player, enemy } = duel();
    player.playerId = 'p1';
    enemy.hp = 1;
    hit(sim, player, enemy, PLAYER_MOVES.cross, 'head', 'head');
    const types = sim.events.map((e) => e.type);
    expect(types).toEqual(['ko', 'hit']);
    const ko = kos(sim.events)[0];
    expect(ko).toMatchObject({ victim: enemy, by: 'strike', killer: player, environmental: false, credit: [] });
    expect(ko.cause).toEqual({ kind: 'creature', entityId: null, fighterId: player.id, credit: ['p1'], held: false, feature: 'creature' });
    expect(hitsOn(sim.events, enemy)[0].ko).toBe(true);
    expect(enemy.state).toBe('ko');
  });

  it('reports a bleed-out as by bleed, before the weapon drops and the bleedout event', () => {
    const { sim, enemy } = duel();
    const at: Vector3[] = [];
    sim.world = port((_d, finish) => {
      at.push(finish.point as Vector3);
      return { environmental: false, credit: [] };
    });
    enemy.weapon = WEAPONS.machete;
    enemy.hp = 0.001;
    enemy.wounds.push({ bone: 'chest', local: [0, 0.1, 0.1], angle: 0, length: 0.1, bleed: 1, floor: 0.5 });
    const ev = sim.step();
    expect(ev.map((e) => e.type).filter((t) => t === 'ko' || t === 'drop' || t === 'bleedout')).toEqual(['ko', 'drop', 'bleedout']);
    const ko = kos(ev)[0];
    expect(ko).toMatchObject({ victim: enemy, by: 'bleed', killer: null, cause: null, environmental: false, credit: [] });
    // At the pelvis, as copies: the body keeps moving after it, the recorded points don't.
    expect(at).toHaveLength(1);
    expect(at[0].toArray()).toEqual(enemy.rig.pelvis.pos.toArray());
    expect(at[0]).not.toBe(enemy.rig.pelvis.pos);
    expect(ko.point).not.toBe(enemy.rig.pelvis.pos);
    const kept = ko.point.toArray();
    for (let i = 0; i < 30; i++) sim.step();
    expect(enemy.rig.pelvis.pos.toArray()).not.toEqual(kept);
    expect(ko.point.toArray()).toEqual(kept);
    expect(at[0].toArray()).toEqual(kept);
  });

  it('reports a thrown weapon\'s KO as thrown', () => {
    const { sim, player, enemy } = duel(4);
    player.weapon = WEAPONS.axe;
    enemy.hp = 1;
    player.startMove(player.moveDef('throwHeavy')!);
    const all: CombatEvent[] = [];
    for (let i = 0; i < 120; i++) all.push(...sim.step());
    const ko = kos(all);
    expect(ko).toHaveLength(1);
    expect(ko[0]).toMatchObject({ victim: enemy, by: 'thrown', killer: player });
    expect(ko[0].cause?.held).toBe(true);
  });
});

describe('melee through the rule: blowDamage and the toughness line (§4.4)', () => {
  it('blowDamage is hit()\'s damage, bit for bit, and with T = 0 hit() deals exactly it', () => {
    // Blows whose damage doesn't survive the rule's round trip through joules: (x · 18) / 18 !== x. With T = 0 the
    // toughness line must be skipped, not applied, or these come out different.
    let roundTripChanges = 0;
    for (const [zone, bone] of [
      ['head', 'head'],
      ['chest', 'chest'],
      ['legs', 'thighL'],
    ] as const) {
      for (const m of [PLAYER_MOVES.jab, PLAYER_MOVES.cross, WEAPON_MOVES.overhead]) {
        for (const [swing, counter] of [
          [0.7, m === PLAYER_MOVES.cross],
          [0.9, true],
          [0.9, false],
        ] as const) {
          const { sim, player, enemy } = duel();
          if (m.weapon) player.weapon = WEAPONS.axe;
          player.swingStamina = swing;
          player.isCounterAttack = counter;
          enemy.stats.defense = 0.2;
          enemy.hp = enemy.minHp = 50;
          expect(zoneToughness(enemy, zone)).toBe(0);
          const want = blowDamage(player, enemy, m, 1, false, null);
          if (!Object.is(hpFromEnergy(want * DAMAGE_TUNING.meleeJPerDmg, 0), want)) roundTripChanges++;
          hit(sim, player, enemy, m, zone, bone);
          const ev = hitsOn(sim.events, enemy)[0];
          expect(Object.is(ev.damage, want), `${m.id} on ${bone}`).toBe(true);
          expect(ev.energy).toBeUndefined();
          expect(ev.toughness).toBeUndefined();
        }
      }
    }
    expect(roundTripChanges).toBeGreaterThan(0);
  });

  it('blowDamage without a defender takes no defence off', () => {
    const { player, enemy } = duel();
    enemy.stats.defense = 0.5;
    const m = PLAYER_MOVES.cross;
    expect(blowDamage(player, null, m, 1, false, null)).toBeCloseTo(m.damage * player.stats.damageMul * (0.5 + 0.5 * player.swingStamina), 12);
    expect(blowDamage(player, enemy, m, 1, false, null)).toBeCloseTo(blowDamage(player, null, m, 1, false, null) * 0.5, 12);
  });

  it('a zone with toughness takes max(0, E − T)/K, E = dmg × meleeJPerDmg; hide plus armour per zone', () => {
    const { sim, player, enemy } = duel();
    enemy.toughnessJ = 20;
    enemy.armour = { chest: 40 };
    expect(zoneToughness(enemy, 'head')).toBe(20);
    expect(zoneToughness(enemy, 'chest')).toBe(60);
    const m = PLAYER_MOVES.cross;
    const dmg = blowDamage(player, enemy, m, 1, false, null);
    const hp0 = enemy.hp;
    hit(sim, player, enemy, m, 'chest', 'chest');
    const ev = hitsOn(sim.events, enemy)[0];
    expect(ev.energy).toBe(dmg * DAMAGE_TUNING.meleeJPerDmg);
    expect(ev.toughness).toBe(60);
    expect(ev.damage).toBe(Math.max(0, dmg * 18 - 60) / 18);
    expect(ev.damage).toBeGreaterThan(0);
    expect(enemy.hp).toBe(hp0 - ev.damage);
  });

  it('a blow that can\'t beat the toughness does no damage and knocks nobody out', () => {
    const { sim, player, enemy } = duel();
    enemy.toughnessJ = 100_000;
    enemy.hp = 0.5;
    hit(sim, player, enemy, PLAYER_MOVES.cross, 'head', 'head');
    const ev = hitsOn(sim.events, enemy)[0];
    expect(ev.damage).toBe(0);
    expect(ev.ko).toBe(false);
    expect(enemy.hp).toBe(0.5);
    expect(kos(sim.events)).toEqual([]);
  });
});

describe('lastKnock at the DS knockback sites (§4.4)', () => {
  it('a landed blow records who knocked them and when', () => {
    const { sim, player, enemy } = duel();
    player.playerId = 'p1';
    sim.step();
    hit(sim, player, enemy, PLAYER_MOVES.jab, 'head', 'head');
    expect(enemy.lastKnock).toEqual({
      tick: sim.frame,
      by: player.id,
      cause: { kind: 'creature', entityId: null, fighterId: player.id, credit: ['p1'], held: false, feature: 'creature' },
    });
    expect(player.lastKnock).toBeNull();
  });

  it('a blocked blow that drives the guard back records it; a parry records it on the attacker', () => {
    const { sim, player, enemy } = duel();
    const block = (sim as unknown as { block(...args: unknown[]): void }).block.bind(sim);
    block(player, enemy, PLAYER_MOVES.cross, new Vector3(0.5, 1.4, 0), new Vector3(1, 0, 0));
    expect(enemy.state).toBe('blockstun');
    expect(enemy.lastKnock?.by).toBe(player.id);
    // A parry: the guard came up as it arrived.
    const s2 = duel();
    s2.enemy.startDefense('block', 1);
    (s2.sim as unknown as { block(...args: unknown[]): void }).block(s2.player, s2.enemy, PLAYER_MOVES.jab, new Vector3(0.5, 1.4, 0), new Vector3(1, 0, 0));
    expect(s2.player.lastKnock?.by).toBe(s2.enemy.id);
  });

  it('a teep jammed in close still shoves them, and records it', () => {
    // Thrown from too close, the shin or knee arrives before the foot (resolveJams): a narrow band of distances.
    let jammed = 0;
    for (let cm = 40; cm <= 70; cm++) {
      const { sim, player, enemy } = duel(cm / 100);
      player.autoDefense = false;
      sim.step();
      player.startMove(ENEMY_MOVES.teep);
      for (let i = 0; i < 40; i++) {
        const ev = sim.step();
        if (hitsOn(ev, enemy).length) break;
        if (!ev.some((e) => e.type === 'bump' && e.attacker === player)) continue;
        jammed++;
        expect(enemy.lastKnock, `${cm} cm`).toEqual({
          tick: sim.frame,
          by: player.id,
          cause: { kind: 'creature', entityId: null, fighterId: player.id, credit: [], held: false, feature: 'creature' },
        });
        expect(player.lastKnock).toBeNull();
        break;
      }
    }
    expect(jammed).toBeGreaterThan(0);
  });

  it('a weapon swung with too little behind it bumps them, and that counts too', () => {
    const { sim, player, enemy } = duel();
    player.weapon = WEAPONS.bat;
    const m = player.moveDef('sweep')!;
    (sim as unknown as { applyStrike(c: unknown): void }).applyStrike({
      attacker: player, defender: enemy, move: m, height: 'mid', point: new Vector3(0.6, 1.2, 0), zone: 'chest', bone: 'chest', power: 0.2,
    });
    expect(enemy.lastKnock).toMatchObject({ by: player.id, cause: { held: true } });
  });
});

describe('the fighter\'s M1 fields', () => {
  it('default to DungeonStyle: no species, toughness or armour, humanoid mass, empty hands, nothing buffered', () => {
    const f = createPlayer();
    expect(f.mass).toBeCloseTo(73.3, 12);
    expect(f.massKg).toBeNull();
    expect(Object.keys(f.boneShare).sort()).toEqual([...BONES].sort());
    expect([f.toughnessJ, f.moveFlags, f.jumpRequest]).toEqual([0, 0, 0]);
    expect(f.armour).toEqual({});
    for (const v of [f.species, f.playerId, f.lastKnock, f.ruler, f.ground, f.inventory, f.load, f.drive, f.posture, f.work, f.verbRequest, f.verbAim, f.throwAim]) {
      expect(v).toBeNull();
    }
    expect(f.idlePaused).toBe(false);
  });

  it('enterGetup keeps DungeonStyle\'s 40-frame rise by default and takes a longer one with its own track', () => {
    const { sim, enemy } = duel();
    enemy.enterGetup();
    expect(enemy.state).toBe('getup');
    expect(enemy.stunFrames).toBe(GETUP_FRAMES);
    let frames = 0;
    while (enemy.state === 'getup' && frames < 200) {
      sim.step();
      frames++;
    }
    expect(frames).toBe(GETUP_FRAMES);
    const keys: TrackKey[] = [
      { f: 52, pose: getPose('kneel'), ease: 'inOut' },
      { f: 94, pose: getPose('guard'), ease: 'inOut' },
    ];
    enemy.poise = 3;
    enemy.enterGetup(94, keys);
    expect(enemy.stunFrames).toBe(94);
    expect(enemy.poise).toBe(enemy.stats.maxPoise);
    frames = 0;
    while (enemy.state === 'getup' && frames < 200) {
      sim.step();
      frames++;
    }
    expect(frames).toBe(94);
  });

  it('startWork commits the fighter for the work\'s frames (state pickup), then frees it', () => {
    const { sim, player } = duel(3);
    const work: Work = { kind: 'lash', frames: 30, actAt: 20, faceAt: { x: 1, y: 0, z: 0 }, keys: [{ f: 15, pose: getPose('kneel') }] };
    player.pickupRequest = 5;
    player.startWork(work);
    expect(player.state).toBe('pickup');
    expect(player.stunFrames).toBe(30);
    expect(player.work).toBe(work);
    expect(player.pickupTarget).toBeNull();
    expect(player.pickupRequest).toBe(0);
    expect(player.free).toBe(false);
    let frames = 0;
    while (player.state === 'pickup' && frames < 100) {
      sim.step();
      frames++;
    }
    expect(frames).toBe(30);
    expect(player.work).toBeNull();
  });

  it("'tripped': only forward kinematics poses the rig; the sim counts frames and neither walks nor shoves it", () => {
    const { sim, player, enemy } = duel(0.4);
    for (let i = 0; i < 5; i++) sim.step();
    sim.physicsOwnsDowned = true;
    enemy.setState('tripped');
    enemy.pose.root.set(0.1, 0.3, -0.2);
    enemy.pose.rot.chest.set(0.2, 0, 0, 0.98).normalize();
    const pose = JSON.stringify(enemy.pose);
    enemy.vel.set(2, 0, 0);
    const at = enemy.pos.clone();
    const pAt = player.pos.clone();
    for (let i = 0; i < 10; i++) sim.step();
    expect(enemy.state).toBe('tripped');
    expect(enemy.stateFrame).toBe(10);
    expect(JSON.stringify(enemy.pose)).toBe(pose);
    expect(enemy.pos.toArray()).toEqual(at.toArray());
    // 0.4 m apart: two standing fighters would have been pushed apart by now.
    expect(player.pos.distanceTo(pAt)).toBeLessThan(1e-9);
    const want = makeRig();
    forwardKinematics(enemy.pose, want, enemy.pos, enemy.yaw, enemy.scale);
    for (const b of BONES) {
      expect(enemy.rig[b].pos.toArray()).toEqual(want[b].pos.toArray());
      expect(enemy.rig[b].rot.toArray()).toEqual(want[b].rot.toArray());
    }
    expect(enemy.alive).toBe(true);
  });

  it("'tripped': melee still finds the body (no skip list names it), as it doesn't a knocked-down one", () => {
    /** Whether a cross thrown at the enemy, frozen in `state`, lands. */
    const lands = (state: 'tripped' | 'knockdown') => {
      const { sim, player, enemy } = duel(0.9);
      player.autoDefense = false;
      for (let i = 0; i < 5; i++) sim.step();
      sim.physicsOwnsDowned = true;
      enemy.setState(state);
      enemy.stunFrames = 1000;
      player.startMove(PLAYER_MOVES.cross);
      const all: CombatEvent[] = [];
      for (let i = 0; i < 40; i++) all.push(...sim.step());
      return hitsOn(all, enemy).length;
    };
    expect(lands('tripped')).toBe(1);
    expect(lands('knockdown')).toBe(0);
  });

  it('idlePaused freezes idle life (no weight shift, look-around, feint or breathing); unpaused it moves', () => {
    const rigOf = (f: Fighter) => BONES.flatMap((b) => [...f.rig[b].pos.toArray(), ...f.rig[b].rot.toArray()]);
    const drift = (paused: boolean) => {
      const { sim, player, enemy } = duel(1.6);
      for (let i = 0; i < 90; i++) sim.step();
      player.idlePaused = paused;
      enemy.idlePaused = paused;
      for (let i = 0; i < 60; i++) sim.step();
      const a = [...rigOf(player), ...rigOf(enemy)];
      for (let i = 0; i < 90; i++) sim.step();
      const b = [...rigOf(player), ...rigOf(enemy)];
      return Math.max(...a.map((x, i) => Math.abs(x - b[i])));
    };
    expect(drift(true)).toBeLessThan(1e-4);
    expect(drift(false)).toBeGreaterThan(1e-3);
  });

  it('a limp drags the bad leg low and hurries the good one through (FootworkStyle.limp)', () => {
    const steps = (limp: boolean) => {
      const sim = new CombatSim(1);
      sim.walkable = { resolve: () => {}, isWalkable: () => true };
      const f = new Fighter('player', 'Walker', PLAYER_MOVES, { walkSpeed: 2.6 });
      if (limp) f.footwork.style.limp = { side: 'R', amount: 1 };
      sim.add(f);
      const out = { L: { dur: [] as number[], height: [] as number[] }, R: { dur: [] as number[], height: [] as number[] } };
      for (let i = 0; i < 360; i++) {
        sim.commands.push(moveCommand(sim.frame + 1, f.id, 0, 1));
        sim.step();
        // (After the first second: getting going takes a few standing steps.)
        for (const foot of [f.footwork.L, f.footwork.R]) {
          if (i >= 60 && foot.stepping && foot.t === 0) {
            out[foot.side].dur.push(foot.dur);
            out[foot.side].height.push(foot.height);
          }
        }
      }
      return out;
    };
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const sound = steps(false);
    const lame = steps(true);
    expect(lame.R.height.length).toBeGreaterThan(4);
    expect(lame.L.dur.length).toBeGreaterThan(4);
    expect(mean(lame.R.height) / mean(sound.R.height)).toBeCloseTo(MOVE_TUNING.limpStepHeightMul, 1);
    expect(mean(lame.L.dur) / mean(sound.L.dur)).toBeCloseTo(1 - MOVE_TUNING.limpStanceMul, 1);
    // The good leg isn't dragged; the bad leg's own swing isn't hurried.
    expect(mean(lame.L.height)).toBeCloseTo(mean(sound.L.height), 2);
    expect(mean(lame.R.dur)).toBeCloseTo(mean(sound.R.dur), 0);
    // However hurried, the good leg's swing takes at least limpMinStepFrames.
    const floor = Math.ceil(mean(lame.L.dur)) + 2;
    expect(Math.min(...sound.L.dur)).toBeGreaterThanOrEqual(floor);
    setTuningValue('MOVE_TUNING', 'limpMinStepFrames', floor);
    expect(Math.min(...steps(true).L.dur)).toBe(floor);
  });
});

describe('sim/rules.ts', () => {
  it('registers DAMAGE_TUNING and MOVE_TUNING with the §9 values, a unit and a source on every key', () => {
    expect(DAMAGE_TUNING).toEqual({
      kS: 3, K: 18, meleeJPerDmg: 18, throwCapJ: 400, leadingCos: 0.7, bladeSharpness: 0.8, tipRadiusM: 0.15, impactCooldownTicks: 6,
      minImpactJ: 5, hardLandingBluntOnly: true, zoneGraceTicks: 2,
    });
    expect(MOVE_TUNING).toMatchObject({
      sprintMul: 1.4, sprintStaminaPerS: 0.15, sprintMinStamina: 0.1, crouchSpeedMul: 0.5, jumpStamina: 0.05,
      jumpBufferFrames: 6, carrySpeedPerKg: 0.01, carrySpeedMin: 0.6, carryRegenPerKg: 0.015, carryRegenMin: 0.4,
      carryNoSprintKg: 20, dragSpeedMul: 0.75, pullWalkMul: 0.2,
      // (Not in §9: the limp gait's, §6.4.)
      limpStanceMul: 0.4, limpStepHeightMul: 0.5, limpMinStepFrames: 4,
    });
    for (const [name, folder] of [
      ['DAMAGE_TUNING', 'Damage rule'],
      ['MOVE_TUNING', 'Bodies › movement'],
    ]) {
      const e = TUNING.find((t) => t.name === name)!;
      expect(e.folder).toBe(folder);
      for (const l of tuningLeaves(e)) {
        expect(l.meta.unit.length).toBeGreaterThan(0);
        expect(l.meta.source.length).toBeGreaterThan(0);
      }
    }
  });

  it('computes the rule: E = ½ m_eff v_n² (1 + kS s), HP = max(0, E − T)/K (the §4.3 calibration)', () => {
    // A 300 kg log dropped 4 m (8.86 m/s) on the giant's chest bone (2,865 kg): m_eff 271.6 kg, 10,656 J, 370 HP.
    const mEff = reducedMass(300, 2865);
    expect(mEff).toBeCloseTo(271.6, 1);
    const E = impactEnergy(mEff, 8.86, 0);
    expect(E / 10656).toBeCloseTo(1, 2);
    expect(hpFromEnergy(E, 4000) / 370).toBeCloseTo(1, 2);
    // Sharpness multiplies: s = 0.6 → × 2.8.
    expect(impactEnergy(10, 2, 0.6)).toBeCloseTo(0.5 * 10 * 4 * 2.8, 12);
    expect(hpFromEnergy(100, 200)).toBe(0);
    expect(hpFromEnergy(54, 0)).toBe(3);
  });

  it('reducedMass treats a static side as immovable', () => {
    expect(reducedMass(2, 2)).toBe(1);
    expect(reducedMass(Infinity, 5)).toBe(5);
    expect(reducedMass(5, Infinity)).toBe(5);
    expect(reducedMass(Infinity, Infinity)).toBe(Infinity);
  });

  it('caps a throw at 400 J of kinetic energy (SPEC:285)', () => {
    expect(launchSpeed(2, 20)).toBe(20);
    expect(launchSpeed(1, 20)).toBe(20);
    expect(launchSpeed(40, 15)).toBeCloseTo(Math.sqrt(20), 12);
    expect(0.5 * 40 * launchSpeed(40, 15) ** 2).toBeCloseTo(400, 9);
    expect(DT).toBe(1 / 60);
  });
});
