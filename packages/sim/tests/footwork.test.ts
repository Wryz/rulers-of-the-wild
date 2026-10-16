import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { toLocal } from '../src/body/footwork';
import { CombatSim } from '../src/sim/combat';
import { createBrawler, createPlayer } from '../src/sim/roster';

function setup(dist = 2.5, passiveEnemy = true) {
  const sim = new CombatSim(9);
  const player = createPlayer();
  const { fighter: enemy, ai } = createBrawler(sim.rng, { passive: passiveEnemy, blockChance: 0 });
  player.pos.set(0, 0, 0);
  player.yaw = Math.PI / 2;
  enemy.pos.set(dist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  for (let i = 0; i < 30; i++) sim.step(); // settle into stance
  return { sim, player, enemy };
}

describe('footwork', () => {
  it('planted feet never slide', () => {
    const { sim, player } = setup(5);
    const prev = { L: new Vector3(), R: new Vector3() };
    let checked = 0;
    for (let i = 0; i < 120; i++) {
      player.moveInput.set(Math.sin(i / 20), 0, Math.cos(i / 25)).multiplyScalar(0.9);
      for (const s of ['L', 'R'] as const) prev[s].copy(player.footwork.foot(s).pos);
      const wasStepping = { L: player.footwork.L.stepping, R: player.footwork.R.stepping };
      sim.step();
      for (const s of ['L', 'R'] as const) {
        const f = player.footwork.foot(s);
        if (!wasStepping[s] && !f.stepping) {
          expect(f.pos.distanceTo(prev[s])).toBeLessThan(1e-9);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  const firstStep = (dir: [number, number]) => {
    // Inside lock range: boxing footwork (out of range the fighter just walks).
    const { sim, player } = setup(2.2);
    player.footwork.steps = 0;
    player.footwork.firstStepper = null;
    // Player faces +X: forward = +X, the fighter's left (+X local) = world -Z.
    for (let i = 0; i < 20; i++) {
      player.moveInput.set(dir[0], 0, dir[1]);
      sim.step();
    }
    return player.footwork.firstStepper;
  };

  it('leads with the front foot going forward and the rear foot going back', () => {
    expect(firstStep([1, 0])).toBe('L');
    expect(firstStep([-1, 0])).toBe('R');
  });

  it('steps with the near-side foot first going sideways', () => {
    expect(firstStep([0, -1])).toBe('L');
    expect(firstStep([0, 1])).toBe('R');
  });

  it('never crosses the feet', () => {
    const { sim, player } = setup(2.2, false);
    const l = new Vector3();
    const r = new Vector3();
    for (let i = 0; i < 600; i++) {
      player.moveInput.set(Math.sin(i / 17), 0, Math.cos(i / 13));
      sim.step();
      if (player.state !== 'idle' && player.state !== 'walk') continue;
      toLocal(player.footwork.L.pos, player, l);
      toLocal(player.footwork.R.pos, player, r);
      expect(l.x - r.x).toBeGreaterThan(0);
    }
  });

  it('stays active while idle in range: shuffles, feints and keeps moving', () => {
    const { sim, player } = setup(1.6);
    const roots: number[] = [];
    for (let i = 0; i < 60 * 6; i++) {
      sim.step();
      roots.push(player.pose.root.y);
    }
    expect(player.idle.feints).toBeGreaterThanOrEqual(1);
    expect(player.idle.shuffles).toBeGreaterThanOrEqual(2);
    expect(player.footwork.steps).toBeGreaterThan(0);
    expect(Math.max(...roots) - Math.min(...roots)).toBeGreaterThan(0.02);
  });
});
