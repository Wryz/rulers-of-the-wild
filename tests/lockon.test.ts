import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { loadSave } from '../src/game/economy';
import { CombatSim, FACING } from '../src/sim/combat';
import { createBrawler, createPlayer } from '../src/sim/roster';
import { RectWalkable } from '../src/world/collision';

function setup(...enemyAt: [number, number][]) {
  const sim = new CombatSim(5);
  sim.walkable = new RectWalkable(-50, 50, -50, 50);
  const player = createPlayer();
  player.yaw = Math.PI / 2;
  sim.add(player);
  const enemies = enemyAt.map(([x, z]) => {
    const { fighter, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
    fighter.pos.set(x, 0, z);
    fighter.yaw = -Math.PI / 2;
    sim.add(fighter, ai);
    return fighter;
  });
  return { sim, player, enemies };
}

describe('lock-on', () => {
  it('locks onto the nearest opponent and switches when another is clearly nearer', () => {
    const { sim, player, enemies } = setup([3, 0], [-2, 0]);
    sim.step();
    expect(player.target).toBe(enemies[1]);
    // Barely nearer: keep the current lock.
    enemies[0].pos.set(1.8, 0, 0);
    sim.step();
    expect(player.target).toBe(enemies[1]);
    // Clearly nearer: switch.
    enemies[0].pos.set(1.2, 0, 0);
    sim.step();
    expect(player.target).toBe(enemies[0]);
  });

  it('does not flip the lock on and off around the lock range', () => {
    const { sim, player, enemies } = setup([FACING.lockRange - 0.2, 0]);
    sim.step();
    expect(player.lockedOn).toBe(true);
    enemies[0].pos.x = (FACING.lockRange + FACING.unlockRange) / 2;
    sim.step();
    expect(player.lockedOn).toBe(true);
    enemies[0].pos.x = FACING.unlockRange + 0.3;
    sim.step();
    expect(player.lockedOn).toBe(false);
  });

  it('circle-strafing at any range is smooth (no popping or foot snaps)', () => {
    for (const dist of [1.6, 2.5, 3.4, 4.3]) {
      const { sim, player: p, enemies } = setup([dist, 0]);
      const e = enemies[0];
      for (let i = 0; i < 60; i++) sim.step();
      const prev: Record<string, Vector3> = {};
      let maxJump = 0;
      for (let i = 0; i < 240; i++) {
        const dx = e.pos.x - p.pos.x;
        const dz = e.pos.z - p.pos.z;
        const l = Math.hypot(dx, dz);
        p.moveInput.set(-dz / l, 0, dx / l);
        sim.step();
        // Running gait never kicks in while squared up.
        if (p.lockedOn) expect(p.motion.gait).toBeLessThan(0.5);
        for (const b of ['pelvis', 'chest', 'head'] as const) {
          const cur = p.rig[b].pos.clone().sub(p.pos);
          if (prev[b]) maxJump = Math.max(maxJump, cur.distanceTo(prev[b]));
          prev[b] = cur;
        }
      }
      expect(maxJump).toBeLessThan(0.07);
    }
  });
});

describe('sparring', () => {
  it('a fighter with a health floor cannot be knocked out', () => {
    const { sim, player, enemies } = setup([1, 0]);
    const e = enemies[0];
    e.minHp = 20;
    e.hp = 21;
    for (let i = 0; i < 30; i++) sim.step();
    for (let k = 0; k < 20; k++) {
      player.press(k % 2 ? 'rkick' : 'rpunch');
      for (let i = 0; i < 40; i++) sim.step();
    }
    expect(e.alive).toBe(true);
    // Hits landed (down to the floor) but never past it.
    expect(e.hp).toBe(20);
  });

  it('carries coins and gear over from the old save', () => {
    const store = {
      getItem: (k: string) =>
        k === 'brawler.save.v1' ? JSON.stringify({ coins: 77, gear: { helmet: 2 }, loop: 3, tutorialDone: true }) : null,
    };
    const s = loadSave(store);
    expect(s.coins).toBe(77);
    expect(s.gear.helmet).toBe(2);
    expect(s.bestRound).toBe(0);
  });
});
