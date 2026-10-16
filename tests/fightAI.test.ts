import { describe, expect, it } from 'vitest';
import { BRAWLER_PLAN, BrawlerAI, DEFAULT_AI } from '../src/sim/ai';
import { CombatSim, pushScale, readChance } from '../src/sim/combat';
import { createEnemy, type EnemyKind } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { createPlayer } from '../src/sim/roster';
import { type WeaponId, WEAPONS } from '../src/sim/weapons';
import { RectWalkable } from '../src/world/collision';

/** A player (idle, or driven by an aggressive AI) against one enemy, in a 12 m square. */
function bout(kind: EnemyKind, seed: number, o: { weapon?: WeaponId; playerAI?: boolean } = {}) {
  const sim = new CombatSim(seed);
  sim.walkable = new RectWalkable(-6, 6, -6, 6);
  const p = createPlayer();
  p.minHp = 1;
  p.pos.set(-1, 0, 0);
  p.yaw = Math.PI / 2;
  sim.add(p, o.playerAI ? new BrawlerAI({ ...DEFAULT_AI, aggression: 1.4 }, sim.rng, BRAWLER_PLAN) : undefined);
  const { fighter: e, ai } = createEnemy(kind, sim.rng);
  e.pos.set(1, 0, 0);
  e.yaw = -Math.PI / 2;
  if (o.weapon) e.weapon = WEAPONS[o.weapon];
  sim.add(e, ai);
  return { sim, p, e, ai };
}

/** Keep both on their feet (and their health off the floor) for a long bout. */
const topUp = (...fs: Fighter[]) => {
  for (const f of fs) if (f.hp < f.stats.maxHp * 0.3) f.hp = f.stats.maxHp;
};

describe('automatic defense is a read, not a guarantee', () => {
  it('standing there, you see most of them coming — not all', () => {
    let hits = 0;
    let saved = 0;
    for (let seed = 1; seed <= 2; seed++) {
      const { sim, p, e } = bout('brawler', seed);
      for (let i = 0; i < 1800; i++) {
        topUp(p, e);
        for (const ev of sim.step()) {
          if (ev.type === 'hit' && ev.defender === p) hits++;
          if ((ev.type === 'block' || ev.type === 'dodge') && ev.defender === p) saved++;
        }
      }
    }
    expect(hits).toBeGreaterThan(3);
    expect(saved).toBeGreaterThan(hits * 1.5);
  });

  it('tired, rattled, or with two men swinging, fewer strikes are read', () => {
    const sim = new CombatSim(1);
    const p = createPlayer();
    const a = createEnemy('brawler', sim.rng).fighter;
    const b = createEnemy('brawler', sim.rng).fighter;
    a.startMove(a.moves.straight);
    const fresh = readChance(p, a, [a]);
    p.stamina = 0.2;
    const tired = readChance(p, a, [a]);
    p.stamina = 1;
    p.framesSinceHit = 5;
    const rattled = readChance(p, a, [a]);
    p.framesSinceHit = 999;
    b.startMove(b.moves.hook);
    const crowd = readChance(p, a, [a, b]);
    expect(fresh).toBeGreaterThan(0.7);
    for (const worse of [tired, rattled, crowd]) expect(worse).toBeLessThan(fresh * 0.75);
  });
});

describe('armed enemies', () => {
  it("don't back themselves into the wall and stay pinned there", () => {
    for (const w of ['axe', 'sledgehammer'] as const) {
      const { sim, p, e } = bout('brawler', 2, { weapon: w, playerAI: true });
      let wall = 0;
      for (let i = 0; i < 3600; i++) {
        topUp(p, e);
        sim.step();
        if (Math.abs(e.pos.x) > 5.3 || Math.abs(e.pos.z) > 5.3) wall++;
      }
      expect(wall).toBeLessThan(3600 * 0.15);
    }
  });

  it('keep the head of the weapon at range, not the handle: crowded only when it truly is', () => {
    const { sim, e, ai } = bout('brawler', 1, { weapon: 'axe' });
    sim.step();
    const plan = (ai as unknown as { planFor(f: Fighter): { range: number; crowded?: number } }).planFor(e);
    // Where the axe head (the last ~30 cm of a 98 cm axe) meets a body.
    expect(plan.range).toBeGreaterThan(1.3);
    expect(plan.range).toBeLessThan(1.6);
    expect(plan.crowded!).toBeLessThan(plan.range - 0.2);
  });
});

describe('size', () => {
  it("a small creature doesn't throw at a giant's head; it goes for the legs, and lands", () => {
    const sim = new CombatSim(2);
    sim.walkable = new RectWalkable(-6, 6, -6, 6);
    const g = createEnemy('champion', sim.rng).fighter;
    (g as { team: string }).team = 'player';
    g.autoDefense = false;
    g.minHp = 1;
    g.pos.set(-1, 0, 0);
    g.yaw = Math.PI / 2;
    sim.add(g);
    const { fighter: imp, ai } = createEnemy('imp', sim.rng);
    imp.pos.set(1, 0, 0);
    imp.yaw = -Math.PI / 2;
    sim.add(imp, ai);
    let high = 0;
    let landed = 0;
    for (let i = 0; i < 1800; i++) {
      for (const ev of sim.step()) {
        if (ev.type === 'swing' && ev.f === imp && imp.strikeHeight === 'high') high++;
        if (ev.type === 'hit' && ev.attacker === imp) landed++;
      }
    }
    expect(imp.canReach(imp.moves.rookieJab)).toBe(false);
    expect(high).toBe(0);
    expect(landed).toBeGreaterThan(0);
  });
});

describe('the AI and weapons on the floor', () => {
  const floor = (foeAt: number, kind: EnemyKind = 'brawler', w: WeaponId = 'machete') => {
    const { sim, p, e } = bout(kind, 1);
    p.pos.set(foeAt, 0, 0);
    p.autoDefense = false;
    p.minHp = 1;
    e.pos.set(0, 0, 0);
    sim.addDrop(WEAPONS[w], 0.35 * e.scale, 0.2);
    let bent = false;
    for (let i = 0; i < 90; i++) {
      sim.step();
      if (e.state === 'pickup') bent = true;
    }
    return { bent, e };
  };

  it("doesn't bend down for it with the foe right there; does once there's room", () => {
    expect(floor(1.1).bent).toBe(false);
    expect(floor(4.5).bent).toBe(true);
  });

  it("an imp leaves a sledgehammer where it is (it couldn't fight with it)", () => {
    const { bent, e } = floor(4.5, 'imp', 'sledgehammer');
    expect(bent).toBe(false);
    expect(e.weapon).toBeNull();
  });
});

describe('the AI without arms', () => {
  it('kicks — teeps and low kicks, not only leg sweeps', () => {
    const { sim, p, e } = bout('brawler', 3, { playerAI: true });
    (sim as unknown as { sever(f: Fighter, b: string): void }).sever(e, 'foreArmL');
    (sim as unknown as { sever(f: Fighter, b: string): void }).sever(e, 'foreArmR');
    e.state = 'idle';
    const n: Record<string, number> = {};
    for (let i = 0; i < 3600; i++) {
      topUp(p, e);
      for (const ev of sim.step()) if (ev.type === 'swing' && ev.f === e) n[ev.move.id] = (n[ev.move.id] ?? 0) + 1;
    }
    const total = Object.values(n).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10);
    expect((n.sweep ?? 0) / total).toBeLessThan(0.6);
  });
});

describe('what a blow carries', () => {
  it('anything in the hand hits at least as hard as a bare fist, the heavier the harder', () => {
    const a = createPlayer();
    const d = createPlayer();
    const fist = pushScale(a, d, null);
    expect(pushScale(a, d, WEAPONS.machete)).toBeGreaterThanOrEqual(fist);
    expect(pushScale(a, d, WEAPONS.sledgehammer)).toBeGreaterThan(pushScale(a, d, WEAPONS.machete) * 1.3);
  });
});

describe('parries', () => {
  it('a guard raised just in time knocks the attacker off balance; a guard held early only blocks', () => {
    const run = (lead: number) => {
      const sim = new CombatSim(4);
      sim.walkable = new RectWalkable(-6, 6, -6, 6);
      const p = createPlayer();
      p.autoDefense = false;
      p.pos.set(0, 0, 0);
      p.yaw = Math.PI / 2;
      const { fighter: e, ai } = createEnemy('brawler', sim.rng);
      ai.cfg.passive = true;
      e.pos.set(1.1, 0, 0);
      e.yaw = -Math.PI / 2;
      sim.add(p);
      sim.add(e, ai);
      for (let i = 0; i < 20; i++) sim.step();
      e.startMove(e.moves.straight, false, 'head');
      let parry: boolean | null = null;
      for (let i = 0; i < 60; i++) {
        if (e.state === 'attack' && e.framesToActive === lead && p.free) p.startDefense('block', e.id * 100000 + e.attackSerial);
        for (const ev of sim.step()) if (ev.type === 'block' && ev.defender === p) parry = ev.parry;
      }
      return { parry, staggered: e.state === 'hitstun' || e.stateFrame < 20 };
    };
    expect(run(3).parry).toBe(true);
    expect(run(14).parry).toBe(false);
  });
});
