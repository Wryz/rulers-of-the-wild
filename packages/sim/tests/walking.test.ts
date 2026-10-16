import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { toLocal } from '../src/body/footwork';
import { bonePoint } from '../src/body/skeleton';
import { CombatSim } from '../src/sim/combat';
import { angleDelta } from '../src/sim/math';
import { createBrawler, createPlayer } from '../src/sim/roster';
import { RectWalkable } from '../src/world/collision';

function setup(enemyDist: number) {
  const sim = new CombatSim(13);
  const player = createPlayer();
  const { fighter: enemy, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
  player.pos.set(0, 0, 0);
  player.yaw = Math.PI / 2;
  enemy.pos.set(enemyDist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  for (let i = 0; i < 90; i++) sim.step();
  return { sim, player, enemy };
}

describe('walking outside a fight', () => {
  it('turns to face where it walks, even straight backwards', () => {
    const { sim, player } = setup(30);
    for (let i = 0; i < 60; i++) {
      player.moveInput.set(-1, 0, 0);
      sim.step();
    }
    expect(Math.abs(angleDelta(player.yaw, -Math.PI / 2))).toBeLessThan(0.2);
    for (let i = 0; i < 60; i++) {
      player.moveInput.set(0, 0, 1);
      sim.step();
    }
    expect(Math.abs(angleDelta(player.yaw, 0))).toBeLessThan(0.2);
  });

  it('alternates feet and lets them pass each other', () => {
    const { sim, player } = setup(30);
    const order: string[] = [];
    const was = { L: false, R: false };
    let passes = 0;
    let prevAhead: string | null = null;
    const l = new Vector3();
    const r = new Vector3();
    for (let i = 0; i < 150; i++) {
      player.moveInput.set(0, 0, -1);
      sim.step();
      for (const s of ['L', 'R'] as const) {
        const f = player.footwork.foot(s);
        if (f.stepping && !was[s]) order.push(s);
        was[s] = f.stepping;
      }
      toLocal(player.footwork.L.pos, player, l);
      toLocal(player.footwork.R.pos, player, r);
      const ahead = l.z > r.z ? 'L' : 'R';
      if (prevAhead && ahead !== prevAhead) passes++;
      prevAhead = ahead;
    }
    const steady = order.slice(2);
    expect(steady.length).toBeGreaterThan(6);
    for (let k = 1; k < steady.length; k++) expect(steady[k]).not.toBe(steady[k - 1]);
    expect(passes).toBeGreaterThan(4);
  });

  it('runs with long strides, a steady rhythm and pumping arms', () => {
    const { sim, player } = setup(30);
    sim.walkable = new RectWalkable(-500, 500, -500, 500);
    const starts: number[] = [];
    const travel: number[] = [];
    const was = { L: false, R: false };
    const from = { L: new Vector3(), R: new Vector3() };
    const hand = new Vector3();
    let speed = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 240; i++) {
      player.moveInput.set(0, 0, -1);
      sim.step();
      if (i < 80) continue;
      speed += Math.hypot(player.walkVel.x, player.walkVel.z) / 160;
      for (const s of ['L', 'R'] as const) {
        const f = player.footwork.foot(s);
        if (f.stepping && !was[s]) {
          starts.push(i);
          from[s].copy(f.pos);
        }
        if (!f.stepping && was[s]) travel.push(f.pos.distanceTo(from[s]));
        was[s] = f.stepping;
      }
      const z = toLocal(bonePoint(player.rig, 'foreArmL', 0.26, hand), player, hand).z;
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    const gaps = starts.slice(1).map((s, k) => s - starts[k]);
    const cadence = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const stride = travel.reduce((a, b) => a + b, 0) / travel.length;
    expect(speed).toBeGreaterThan(3.5);
    // ~3.5 steps a second, each ~1 m (a foot travels two steps per swing).
    expect(cadence).toBeGreaterThan(13);
    expect(cadence).toBeLessThan(20);
    expect(stride).toBeGreaterThan(1.6);
    expect(hi - lo).toBeGreaterThan(0.35);
  });

  it('still squares up to an opponent in range while backing away', () => {
    const { sim, player, enemy } = setup(2.2);
    for (let i = 0; i < 40; i++) {
      player.moveInput.set(-1, 0, 0);
      sim.step();
    }
    const toEnemy = Math.atan2(enemy.pos.x - player.pos.x, enemy.pos.z - player.pos.z);
    expect(Math.abs(angleDelta(player.yaw, toEnemy))).toBeLessThan(0.3);
  });
});
