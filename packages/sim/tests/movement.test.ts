import { describe, expect, it } from 'vitest';
import { CombatSim, FACING } from '../src/sim/combat';
import { angleDelta } from '../src/sim/math';
import { createBrawler, createPlayer } from '../src/sim/roster';

function setup(dist = 2) {
  const sim = new CombatSim(5);
  const player = createPlayer();
  const { fighter: enemy, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
  player.pos.set(0, 0, 0);
  player.yaw = Math.PI / 2;
  enemy.pos.set(dist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  return { sim, player, enemy };
}

const offTarget = (p: ReturnType<typeof setup>['player'], e: ReturnType<typeof setup>['enemy']) =>
  angleDelta(p.yaw, Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z));

describe('soft lock-on', () => {
  it('leads into a strafe instead of staring straight at the target', () => {
    const { sim, player, enemy } = setup(2);
    player.moveInput.set(0, 0, 1);
    let maxOff = 0;
    for (let i = 0; i < 40; i++) {
      sim.step();
      maxOff = Math.max(maxOff, Math.abs(offTarget(player, enemy)));
    }
    expect(maxOff).toBeGreaterThan(0.15);
    expect(maxOff).toBeLessThan(FACING.strafeLead + 0.25);
  });

  it('turns toward the target gradually, not instantly', () => {
    const { sim, player, enemy } = setup(2);
    player.yaw = Math.PI / 2 + 1.4;
    sim.step();
    expect(Math.abs(offTarget(player, enemy))).toBeGreaterThan(1.2);
    for (let i = 0; i < 60; i++) sim.step();
    expect(Math.abs(offTarget(player, enemy))).toBeLessThanOrEqual(FACING.idleDeadzone + 0.01);
  });

  it('tolerates a small offset while standing still', () => {
    const { sim, player, enemy } = setup(2);
    player.yaw = Math.PI / 2 + 0.1;
    for (let i = 0; i < 30; i++) sim.step();
    expect(Math.abs(offTarget(player, enemy))).toBeCloseTo(0.1, 2);
  });
});

describe('attacking on the move', () => {
  it('keeps stepping through a jab and walks the legs under the punch', () => {
    const still = setup(1.6);
    const moving = setup(1.6);
    // Get the moving fighter up to walking speed, sideways.
    for (let i = 0; i < 25; i++) {
      moving.player.moveInput.set(0, 0, 1);
      moving.sim.step();
      still.sim.step();
    }
    for (const s of [still, moving]) s.player.startMove(s.player.moves.jab, false, 'head');
    const z0 = moving.player.pos.z;
    let legDiff = 0;
    let armDiff = 0;
    for (let i = 0; i < 6; i++) {
      moving.player.moveInput.set(0, 0, 1);
      moving.sim.step();
      still.sim.step();
      legDiff = Math.max(legDiff, moving.player.pose.rot.thighL.angleTo(still.player.pose.rot.thighL));
      // From the active frames on, the punching arm must match the planted version.
      if (moving.player.stateFrame >= moving.player.moves.jab.startup)
        armDiff = Math.max(armDiff, moving.player.pose.rot.foreArmL.angleTo(still.player.pose.rot.foreArmL));
    }
    expect(moving.player.state).toBe('attack');
    expect(moving.player.pos.z - z0).toBeGreaterThan(0.05);
    expect(legDiff).toBeGreaterThan(0.1);
    expect(armDiff).toBeLessThan(0.05);
  });

  it('carries momentum into a kick', () => {
    const still = setup(4);
    const running = setup(4);
    for (let i = 0; i < 30; i++) {
      running.player.moveInput.set(1, 0, 0);
      running.sim.step();
    }
    running.player.moveInput.set(0, 0, 0);
    const x0s = still.player.pos.x;
    const x0r = running.player.pos.x;
    still.player.startMove(still.player.moves.frontKick);
    running.player.startMove(running.player.moves.frontKick);
    for (let i = 0; i < 20; i++) {
      still.sim.step();
      running.sim.step();
    }
    expect(running.player.pos.x - x0r).toBeGreaterThan(still.player.pos.x - x0s + 0.15);
  });
});
