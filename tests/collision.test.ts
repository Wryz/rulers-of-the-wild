import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { THEMES, type ThemeId } from '../src/arena/themes';
import { slerpDir } from '../src/body/skeleton';
import { BrawlerAI, DEFAULT_AI } from '../src/sim/ai';
import { type CombatEvent, CombatSim } from '../src/sim/combat';
import { createEnemy, type EnemyKind } from '../src/sim/enemies';
import { Rng } from '../src/sim/math';
import { createPlayer } from '../src/sim/roster';
import { bladePoints, sampleOffsets, WEAPON_MOVES, type WeaponId, WEAPONS, weaponPlan } from '../src/sim/weapons';
import { ArenaWalkable, RectWalkable } from '../src/world/collision';
import { bodyCapsules, overlap, segDist } from './support/bodyShapes';

/** Two AIs fight it out; counts frames where bodies, limbs or weapons pass through things. */
function fight(theme: ThemeId, kind: EnemyKind, pw: WeaponId | null, ew: WeaponId | null, frames = 1500) {
  const t = THEMES[theme];
  const sim = new CombatSim(17);
  const walk = new ArenaWalkable(t.shape, t.obstacles);
  sim.walkable = walk;
  const p = createPlayer();
  p.weapon = pw ? WEAPONS[pw] : null;
  const pai = new BrawlerAI({ ...DEFAULT_AI, aggression: 1.4, blockChance: 0.2 }, new Rng(5));
  if (p.weapon) pai.plan = weaponPlan(p.weapon);
  const { fighter: e, ai } = createEnemy(kind, sim.rng);
  if (ew) e.weapon = WEAPONS[ew];
  p.pos.set(t.playerSpawn[0], 0, t.playerSpawn[1]);
  e.pos.set(t.enemySpawns[0][0], 0, t.enemySpawns[0][1]);
  p.minHp = 1;
  e.minHp = 1;
  sim.add(p, pai);
  sim.add(e, ai);
  const m = { torso: 0, limb: 0, limbMax: 0, wOwn: 0, wOpp: 0, env: 0, hits: 0 };
  for (let i = 0; i < frames; i++) {
    for (const ev of sim.step()) if (ev.type === 'hit') m.hits++;
    if (i < 30) continue;
    const A = bodyCapsules(p);
    const B = bodyCapsules(e);
    let tp = 0;
    for (const x of A.torso) for (const y of B.torso) tp = Math.max(tp, overlap(x, y));
    if (tp > 0.02) m.torso++;
    let lp = 0;
    for (const [f, me, other, o] of [[p, A, B, e], [e, B, A, p]] as const) {
      // A strike that has just stopped on the body / guard is in contact, not through.
      if (f.attackEnd || o.attackEnd) continue;
      for (const x of me.limbs) for (const y of [...other.torso, ...other.limbs]) lp = Math.max(lp, overlap(x, y));
    }
    if (lp > 0.04) m.limb++;
    m.limbMax = Math.max(m.limbMax, lp);
    for (const [f, me, other] of [[p, A, B], [e, B, A]] as const) {
      if (!f.weapon) continue;
      const offs = sampleOffsets(f.weapon);
      let own = 0;
      let opp = 0;
      bladePoints(f, f.weapon).forEach((q, k) => {
        if (offs[k] < 0.2) return;
        for (const c of me.torso) own = Math.max(own, c.r + 0.02 - segDist(q, q, c.a, c.b));
        if (!f.attackEnd) for (const c of [...other.torso, ...other.limbs]) opp = Math.max(opp, c.r + f.weapon!.radius * f.scale - segDist(q, q, c.a, c.b));
        if (walk.solidAt(q)) m.env++;
      });
      if (own > 0.02) m.wOwn++;
      if (opp > 0.04) m.wOpp++;
    }
    for (const me of [A, B]) for (const c of [...me.limbs, ...me.torso]) if (walk.solidAt(c.b)) m.env++;
  }
  return m;
}

describe('collisions', () => {
  const cases: [ThemeId, EnemyKind, WeaponId | null, WeaponId | null][] = [
    ['ring', 'brawler', null, null],
    ['ring', 'kicker', null, null],
    ['warehouse', 'brawler', 'crowbar', null],
    ['rooftop', 'brawler', 'fireaxe', 'pipe'],
    ['colosseum', 'minotaur', 'gladius', null],
    ['colosseum', 'champion', null, null],
  ];
  for (const [theme, kind, pw, ew] of cases) {
    it(`bodies, limbs and weapons stay solid: ${theme}, ${kind}${pw ? `, ${pw}` : ''}${ew ? ` vs ${ew}` : ''}`, () => {
      const m = fight(theme, kind, pw, ew);
      // They actually fought.
      expect(m.hits).toBeGreaterThan(0);
      // Trunks never sink into each other; props are never walked or swung through.
      // (A few frames of a few centimetres are allowed: a jab punishing a heavy swing's
      // recovery at clinch range leans the trunks into contact.)
      expect(m.torso).toBeLessThanOrEqual(10);
      expect(m.env).toBe(0);
      // Arms and legs only brush in passing (~2% of frames, shallow).
      expect(m.limb).toBeLessThanOrEqual(30);
      expect(m.limbMax).toBeLessThan(0.3);
      // Weapons don't pass through the wielder, and only graze the other fighter.
      expect(m.wOwn).toBeLessThanOrEqual(10);
      expect(m.wOpp).toBeLessThanOrEqual(45);
    }, 30000);
  }

  it('a punch thrown into a pillar stops on it', () => {
    const sim = new CombatSim(3);
    sim.walkable = new ArenaWalkable({ kind: 'circle', r: 8 }, [{ kind: 'circle', x: 0.75, z: 0, r: 0.25, h: 3.5 }]);
    const p = createPlayer();
    p.yaw = Math.PI / 2;
    sim.add(p);
    for (let i = 0; i < 20; i++) sim.step();
    p.pos.set(0, 0, 0);
    p.startMove(p.moves.cross);
    const ev: CombatEvent[] = [];
    for (let i = 0; i < 40; i++) ev.push(...sim.step());
    const clang = ev.find((e) => e.type === 'clang');
    expect(clang).toBeTruthy();
    expect(clang && clang.type === 'clang' && clang.metal).toBe(true);
  });

  it('a blade direction turns at constant length, the long way round over the top on a reversal', () => {
    const out = new Vector3();
    let highest = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      slerpDir(new Vector3(0, 0, -1), new Vector3(0, 0, 1), t, out);
      expect(out.length()).toBeCloseTo(1, 5);
      highest = Math.max(highest, out.y);
    }
    expect(highest).toBeGreaterThan(0.95);
  });

  it("a giant's overhead aimed down at a short opponent still comes up and over the top", () => {
    const sim = new CombatSim(8);
    sim.walkable = new RectWalkable(-50, 50, -50, 50);
    const player = createPlayer();
    player.autoDefense = false;
    const { fighter: enemy, ai } = createEnemy('minotaur', sim.rng);
    ai.cfg.passive = true;
    player.yaw = Math.PI / 2;
    enemy.pos.set(1.6, 0, 0);
    enemy.yaw = -Math.PI / 2;
    sim.add(player);
    sim.add(enemy, ai);
    for (let i = 0; i < 40; i++) sim.step();
    player.pos.set(0, 0, 0);
    enemy.pos.set(1.6, 0, 0);
    enemy.startMove(WEAPON_MOVES.overhead, false, 'head');
    const m = enemy.move!;
    let highest = -1;
    let lowest = 1;
    for (let i = 0; i < m.startup; i++) {
      sim.step();
      // Between the wind-up and the moment of contact.
      if (enemy.stateFrame > m.startup * 0.65 && enemy.stateFrame < m.startup) {
        highest = Math.max(highest, enemy.pose.blade.y);
        lowest = Math.min(lowest, enemy.pose.blade.y);
      }
    }
    // Up past vertical-ish, not swung down under the hands through his own head first.
    expect(highest).toBeGreaterThan(0.6);
  });

  it('celebrating, both arms go up clear of the head and body, whatever is in hand', () => {
    for (const w of [null, ...(Object.keys(WEAPONS) as WeaponId[])]) {
      const sim = new CombatSim(1);
      const p = createPlayer();
      p.weapon = w ? WEAPONS[w] : null;
      sim.add(p);
      for (let i = 0; i < 10; i++) sim.step();
      p.celebrate();
      for (let i = 0; i < 60; i++) sim.step();
      expect(p.state, `${w}`).toBe('celebrate');
      const { torso, limbs } = bodyCapsules(p);
      let worst = 0;
      for (const l of limbs) if (/Arm|fist/.test(l.bone)) for (const t of torso) worst = Math.max(worst, overlap(l, t));
      // (Where the upper arm meets the shoulder they always touch a little.)
      expect(worst, `${w}`).toBeLessThan(0.03);
      for (const side of ['fistL', 'fistR']) expect(limbs.find((l) => l.bone === side)!.a.y, `${w} ${side}`).toBeGreaterThan(1.85);
    }
  });

  it('fighters standing toe to toe are pushed apart by their bodies, not just their centres', () => {
    const sim = new CombatSim(4);
    sim.walkable = new RectWalkable(-20, 20, -20, 20);
    const p = createPlayer();
    const { fighter: e, ai } = createEnemy('champion', sim.rng);
    ai.cfg.passive = true;
    p.yaw = Math.PI / 2;
    e.yaw = -Math.PI / 2;
    e.pos.set(0.7, 0, 0);
    sim.add(p);
    sim.add(e, ai);
    for (let i = 0; i < 60; i++) sim.step();
    const A = bodyCapsules(p);
    const B = bodyCapsules(e);
    let worst = 0;
    for (const x of A.torso) for (const y of B.torso) worst = Math.max(worst, overlap(x, y));
    expect(worst).toBeLessThan(0.02);
  });
});
