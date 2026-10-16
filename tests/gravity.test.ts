import { describe, expect, it } from 'vitest';
import { fistPoint } from '../src/body/skeleton';
import { CombatSim } from '../src/sim/combat';
import { createEnemy, type EnemyKind } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { createPlayer } from '../src/sim/roster';
import { type WeaponId, WEAPONS } from '../src/sim/weapons';
import { RectWalkable } from '../src/world/collision';
import { Vector3 } from 'three';

/** Attacker on the left, defender on the right, `gap` apart; returns both and the sim. */
function pair(attacker: () => Fighter, defender: () => Fighter, gap: number) {
  const sim = new CombatSim(5);
  sim.walkable = new RectWalkable(-50, 50, -50, 50);
  const a = attacker();
  const d = defender();
  // Two fighters on the same side don't fight each other.
  if (a.team === d.team) (d as { team: string }).team = a.team === 'player' ? 'enemy' : 'player';
  a.autoDefense = false;
  d.autoDefense = false;
  a.minHp = 1;
  d.minHp = 1;
  a.pos.set(0, 0, 0);
  a.yaw = Math.PI / 2;
  d.pos.set(gap, 0, 0);
  d.yaw = -Math.PI / 2;
  sim.add(a);
  sim.add(d);
  for (let i = 0; i < 30; i++) {
    a.pos.set(0, 0, 0);
    d.pos.set(gap, 0, 0);
    sim.step();
  }
  return { sim, a, d };
}

const enemy = (k: EnemyKind) => () => createEnemy(k, new CombatSim(1).rng).fighter;

/** How far a straight right hand drives someone back. */
function shove(defKind: EnemyKind | 'player', gapMul = 1) {
  const def = defKind === 'player' ? () => createPlayer() : enemy(defKind);
  const { sim, a, d } = pair(() => createPlayer(), def, 1.15 * gapMul);
  const x0 = d.pos.x;
  a.startMove(a.moves.cross, false, 'body');
  let hit = false;
  for (let i = 0; i < 50; i++) for (const e of sim.step()) if (e.type === 'hit' && e.defender === d) hit = true;
  expect(hit).toBe(true);
  return d.pos.x - x0;
}

describe('bodies have mass', () => {
  it('the same punch drives a small creature back further than a man, and a giant hardly at all', () => {
    const imp = shove('imp');
    const man = shove('player');
    const giant = shove('minotaur');
    expect(imp).toBeGreaterThan(man * 1.3);
    expect(giant).toBeLessThan(man * 0.6);
  });

  it("a giant's punch moves you further than yours moves it", () => {
    const { sim, a: giant, d: you } = pair(enemy('champion'), () => createPlayer(), 1.5);
    const x0 = you.pos.x;
    giant.startMove(giant.moves.body);
    let hit = false;
    for (let i = 0; i < 60; i++) for (const e of sim.step()) if (e.type === 'hit' && e.defender === you) hit = true;
    expect(hit).toBe(true);
    const yours = shove('champion');
    expect(you.pos.x - x0).toBeGreaterThan(yours * 2);
  });

  it('blocking a sledgehammer drives you back further than the same swing with a bat', () => {
    const push = (w: WeaponId) => {
      const { sim, a, d } = pair(
        () => {
          const p = createPlayer();
          p.weapon = WEAPONS[w];
          return p;
        },
        () => createPlayer(),
        1.9,
      );
      d.startDefense('block', a.id * 100000 + a.attackSerial + 1);
      a.startMove(a.moveDef('sweep')!, false, 'head');
      const x0 = d.pos.x;
      let blocked = false;
      for (let i = 0; i < 60; i++) {
        if (d.state === 'defend' && d.defense && d.stateFrame > 40) d.startDefense('block', a.id * 100000 + a.attackSerial);
        for (const e of sim.step()) if (e.type === 'block' && e.defender === d) blocked = true;
      }
      return blocked ? d.pos.x - x0 : -1;
    };
    const bat = push('bat');
    const sledge = push('sledgehammer');
    expect(bat).toBeGreaterThan(0);
    expect(sledge).toBeGreaterThan(bat * 1.3);
  });

  it('a giant takes longer to get going than you, a small creature less', () => {
    const accel = (who: () => Fighter) => {
      const sim = new CombatSim(2);
      sim.walkable = new RectWalkable(-50, 50, -50, 50);
      const f = who();
      f.yaw = Math.PI / 2;
      sim.add(f);
      for (let i = 0; i < 20; i++) sim.step();
      let top = 0;
      const speeds: number[] = [];
      for (let i = 0; i < 90; i++) {
        f.moveInput.set(1, 0, 0);
        sim.step();
        const s = Math.hypot(f.walkVel.x, f.walkVel.z);
        speeds.push(s);
        top = Math.max(top, s);
      }
      return speeds.findIndex((s) => s >= top * 0.8);
    };
    const you = accel(() => createPlayer());
    expect(accel(enemy('minotaur'))).toBeGreaterThan(you);
    expect(accel(enemy('imp'))).toBeLessThanOrEqual(you);
  });
});

describe('weight in the hands', () => {
  const guardHeight = (w: WeaponId, stamina: number) => {
    const sim = new CombatSim(3);
    const p = createPlayer();
    p.weapon = WEAPONS[w];
    p.yaw = Math.PI / 2;
    const { fighter: e, ai } = createEnemy('brawler', sim.rng);
    ai.cfg.passive = true;
    e.pos.set(2.4, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(p);
    sim.add(e, ai);
    for (let i = 0; i < 40; i++) {
      p.stamina = stamina;
      sim.step();
    }
    return fistPoint(p.rig, 'R', new Vector3()).y;
  };

  it('a heavy weapon held up sags as the arms tire; a light one hardly does', () => {
    const sledgeDrop = guardHeight('sledgehammer', 1) - guardHeight('sledgehammer', 0.05);
    const macheteDrop = guardHeight('machete', 1) - guardHeight('machete', 0.05);
    expect(sledgeDrop).toBeGreaterThan(0.06);
    expect(sledgeDrop).toBeGreaterThan(macheteDrop + 0.04);
  });

  it('a weapon let go of falls from the hand (it remembers how high it was)', () => {
    const { sim, a } = pair(
      () => {
        const p = createPlayer();
        p.weapon = WEAPONS.axe;
        return p;
      },
      () => createPlayer(),
      3,
    );
    sim.dropWeapon(a);
    const d = sim.drops[sim.drops.length - 1];
    expect(d.from).toBeTruthy();
    expect(d.from!.y).toBeGreaterThan(0.6);
    expect(d.pos.y).toBe(0);
  });
});
