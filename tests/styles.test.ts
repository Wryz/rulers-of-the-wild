import { describe, expect, it } from 'vitest';
import { CombatSim } from '../src/sim/combat';
import { ARCHETYPES, createEnemy, type EnemyKind } from '../src/sim/enemies';
import { GRAVITY } from '../src/sim/fighter';
import type { Fighter } from '../src/sim/fighter';
import { ENEMY_MOVES } from '../src/sim/moves';
import { createPlayer } from '../src/sim/roster';
import { WEAPON_MOVES, type WeaponId, WEAPONS } from '../src/sim/weapons';
import { RectWalkable } from '../src/world/collision';

/** The player facing a still (passive, defenceless) brawler `gap` metres away. */
function stage(gap: number, weapon: WeaponId | null = null) {
  const sim = new CombatSim(3);
  sim.walkable = new RectWalkable(-20, 20, -20, 20);
  const p = createPlayer();
  p.autoDefense = false;
  p.minHp = 1;
  p.yaw = Math.PI / 2;
  p.weapon = weapon ? WEAPONS[weapon] : null;
  const { fighter: e, ai } = createEnemy('brawler', sim.rng);
  ai.cfg.passive = true;
  e.autoDefense = false;
  e.minHp = 1;
  e.pos.set(gap, 0, 0);
  e.yaw = -Math.PI / 2;
  sim.add(p);
  sim.add(e, ai);
  for (let i = 0; i < 30; i++) {
    p.pos.set(0, 0, 0);
    e.pos.set(gap, 0, 0);
    sim.step();
  }
  return { sim, p, e };
}

describe('jumps and flips obey gravity', () => {
  it('a back flip rises exactly as high as its time in the air allows, turns over, and lands upright behind', () => {
    const { sim, p } = stage(3);
    p.startMove(ENEMY_MOVES.backflip);
    const air = p.move!.air!;
    const t = (air.to - air.from) / 60;
    let apex = 0;
    let inverted = false;
    for (let i = 0; i < 70; i++) {
      sim.step();
      apex = Math.max(apex, p.airHeight());
      // Upside down at the top: the head below the hips.
      if (p.rig.head.pos.y < p.rig.pelvis.pos.y) inverted = true;
    }
    expect(apex).toBeCloseTo((GRAVITY * t * t) / 8, 2);
    expect(inverted).toBe(true);
    expect(p.pos.x).toBeLessThan(-1.2);
    expect(p.state).not.toBe('attack');
    expect(p.rig.head.pos.y).toBeGreaterThan(p.rig.pelvis.pos.y + 0.4);
  });

  it("can't steer in the air: the horizontal speed set at take-off doesn't change", () => {
    const { sim, p } = stage(4);
    p.startMove(ENEMY_MOVES.frontFlipKick);
    const air = p.move!.air!;
    const xs: number[] = [];
    for (let i = 1; i <= air.to; i++) {
      sim.step();
      if (i > air.from + 1 && i < air.to - 1) xs.push(p.pos.x);
    }
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 4);
  });

  it('hit in mid-air, there is no ground to take it on: down you go', () => {
    const { sim, p, e } = stage(1.0);
    // A jump on the spot (a superman punch's hop) into a jab.
    e.startMove(ENEMY_MOVES.superman);
    const air = e.move!.air!;
    for (let i = 0; i < air.from + 1; i++) sim.step();
    p.startMove(p.moves.jab, false, 'head');
    let down = false;
    let airborneWhenHit = false;
    for (let i = 0; i < 20; i++) {
      for (const ev of sim.step()) {
        if (ev.type === 'hit' && ev.defender === e) {
          down = ev.knockdown;
          airborneWhenHit = e.move?.air ? e.stateFrame < air.to : true;
        }
      }
    }
    expect(airborneWhenHit).toBe(true);
    expect(down).toBe(true);
  });
});

describe('spins', () => {
  it('a spinning back kick turns the back, lands mid-turn, and a spinning cleave goes all the way round', () => {
    const { sim, p, e } = stage(1.1);
    p.startMove(ENEMY_MOVES.spinBackKick);
    let hit = false;
    for (let i = 0; i < 50; i++) for (const ev of sim.step()) if (ev.type === 'hit' && ev.defender === e) hit = true;
    expect(hit).toBe(true);

    const s2 = stage(6, 'axe');
    const yaw0 = s2.p.yaw;
    s2.p.startMove(WEAPON_MOVES.spinCleave);
    const L = s2.p.move!.startup + s2.p.move!.active + s2.p.move!.recovery;
    for (let i = 0; i < L; i++) s2.sim.step();
    expect(s2.p.yaw - yaw0).toBeCloseTo(Math.PI * 2, 1);
  });
});

describe("a giant's spin", () => {
  it("comes down to a man's chest rather than sweeping over his head", () => {
    const sim = new CombatSim(2);
    sim.walkable = new RectWalkable(-20, 20, -20, 20);
    const p = createPlayer();
    p.autoDefense = false;
    p.minHp = 1;
    p.yaw = Math.PI / 2;
    const { fighter: m, ai } = createEnemy('minotaur', sim.rng);
    ai.cfg.passive = true;
    m.pos.set(2.2, 0, 0);
    m.yaw = -Math.PI / 2;
    sim.add(p);
    sim.add(m, ai);
    for (let i = 0; i < 20; i++) sim.step();
    m.startMove(WEAPON_MOVES.spinCleave);
    let edge = false;
    for (let i = 0; i < 90; i++) for (const ev of sim.step()) if (ev.type === 'hit' && ev.attacker === m && ev.weapon) edge = true;
    expect(edge).toBe(true);
  });
});

describe('thrown weapons', () => {
  it('fly on a ballistic arc, arrive edge first at the distance thrown, and end up on the floor', () => {
    const { sim, p, e } = stage(6, 'axe');
    p.startMove(WEAPON_MOVES.throwHeavy);
    const ys: number[] = [];
    let edge = false;
    let thrown = false;
    let pushed = 0;
    for (let i = 0; i < 160; i++) {
      for (const ev of sim.step()) {
        if (ev.type === 'throw') thrown = true;
        if (ev.type === 'hit' && ev.defender === e && ev.thrown) {
          edge = !!ev.weapon;
          pushed = Math.hypot(e.vel.x, e.vel.z);
        }
      }
      const pr = sim.projectiles[0];
      if (pr?.live) ys.push(pr.pos.y);
    }
    expect(thrown).toBe(true);
    expect(p.weapon).toBeNull();
    // Gravity: the second difference of height is −g·dt² every frame.
    const acc = ys.slice(2).map((y, i) => (y - 2 * ys[i + 1] + ys[i]) * 3600);
    for (const a of acc.slice(1, -1)) expect(a).toBeCloseTo(-GRAVITY, 0);
    expect(edge).toBe(true);
    // All the axe's momentum went into the body, and no more: p / (M + m).
    expect(pushed).toBeGreaterThan(0.1);
    expect(pushed).toBeLessThan((2.6 * 16) / (75 + 2.6));
    expect(sim.projectiles.length).toBe(0);
    expect(sim.drops.some((d) => d.weapon.id === 'axe')).toBe(true);
  });

  it("knives come off the belt one at a time — none left, none thrown", () => {
    const { sim, p } = stage(6);
    p.ammo = { weapon: WEAPONS.kunai, count: 2 };
    const throws = () => {
      p.startMove(ENEMY_MOVES.kunaiThrow);
      let n = 0;
      for (let i = 0; i < 40; i++) for (const ev of sim.step()) if (ev.type === 'throw') n++;
      return n;
    };
    expect(throws() + throws() + throws()).toBe(2);
    expect(p.ammo.count).toBe(0);
  });

  it('a big axe flying at you is usually seen in time and got out of the way of — not always', () => {
    let read = 0;
    let hit = 0;
    for (let k = 0; k < 10; k++) {
      const { sim, p, e } = stage(6, 'axe');
      // Alert (not a dummy), with your reactions, but not about to attack.
      const ai = sim.ais.get(e)!;
      ai.cfg.passive = false;
      ai.cfg.aggression = 0;
      e.autoDefense = true;
      e.readSkill = 1;
      p.startMove(WEAPON_MOVES.throwHeavy);
      for (let i = 0; i < 120; i++) {
        for (const ev of sim.step()) {
          if (ev.type === 'defend' && ev.f === e) read++;
          if (ev.type === 'hit' && ev.defender === e) hit++;
        }
      }
    }
    expect(read).toBeGreaterThanOrEqual(5);
    expect(hit).toBeLessThan(read);
  });
});

describe('every opponent has a style of its own', () => {
  const kinds = Object.keys(ARCHETYPES) as EnemyKind[];
  const repertoire = (k: EnemyKind) => {
    const pl = ARCHETYPES[k].plan;
    return new Set([...pl.moves.map(([m]) => m), ...(pl.armed ?? []).flatMap((a) => a.moves.map(([m]) => m)), ...(pl.specials ?? []).map((s) => s.move)]);
  };

  it('no two fight with the same set of techniques, and each has techniques beyond the basics', () => {
    const sets = kinds.map((k) => [...repertoire(k)].sort().join(','));
    expect(new Set(sets).size).toBe(kinds.length);
    for (const k of kinds) expect(ARCHETYPES[k].plan.specials?.length ?? 0, k).toBeGreaterThan(0);
    for (const k of kinds) for (const m of repertoire(k)) expect(ENEMY_MOVES[m] ?? WEAPON_MOVES[m], `${k}: ${m}`).toBeDefined();
  });

  const watch = (kind: EnemyKind, frames: number, gap: number, setup?: (e: Fighter) => void) => {
    const sim = new CombatSim(5);
    sim.walkable = new RectWalkable(-10, 10, -10, 10);
    const p = createPlayer();
    p.minHp = 1;
    p.yaw = Math.PI / 2;
    sim.add(p);
    const { fighter: e, ai } = createEnemy(kind, sim.rng);
    e.pos.set(gap, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(e, ai);
    setup?.(e);
    const used = new Set<string>();
    for (let i = 0; i < frames; i++) {
      if (p.hp < 30) p.hp = p.stats.maxHp;
      for (const ev of sim.step()) if (ev.type === 'swing' && ev.f === e) used.add(ev.move.id);
    }
    return used;
  };

  it('a ninja throws knives from range; a samurai cuts with the katana; the minotaur spins its axe', () => {
    expect(watch('ninja', 900, 6).has('kunaiThrow')).toBe(true);
    const samurai = watch('samurai', 1800, 3);
    expect(['kesa', 'iai', 'tsuki', 'menCut'].some((m) => samurai.has(m))).toBe(true);
    expect(watch('minotaur', 2400, 3).has('spinCleave')).toBe(true);
  });
});
