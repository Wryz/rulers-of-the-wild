import { describe, expect, it } from 'vitest';
import { CombatSim, type CombatEvent } from '../src/sim/combat';
import { createBrawler, createPlayer } from '../src/sim/roster';

function setup(dist = 1.0) {
  const sim = new CombatSim(11);
  const player = createPlayer();
  const { fighter: enemy, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
  player.pos.set(0, 0, 0);
  player.yaw = Math.PI / 2;
  enemy.pos.set(dist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  sim.step();
  return { sim, player, enemy };
}

describe('strike targeting', () => {
  it('spreads throws across targets and lands body shots on the body', () => {
    const { sim, player, enemy } = setup(1.0);
    const aims = new Set<string>();
    const zones = new Set<string>();
    for (let i = 0; i < 30; i++) {
      enemy.hp = enemy.stats.maxHp;
      enemy.enterLocomotion(1);
      enemy.pos.set(1.0, 0, 0);
      player.pos.set(0, 0, 0);
      player.enterLocomotion(1);
      player.startMove(player.moves.cross);
      aims.add(player.aim!.id);
      for (let f = 0; f < 30; f++) {
        for (const e of sim.step()) {
          if (e.type === 'hit' && e.attacker === player) zones.add(`${player.strikeHeight}:${(e as Extract<CombatEvent, { type: 'hit' }>).zone}`);
        }
      }
    }
    expect(aims).toEqual(new Set(['head', 'body']));
    expect([...zones].some((z) => z.startsWith('high:head'))).toBe(true);
    expect([...zones].some((z) => z.startsWith('mid:'))).toBe(true);
  });

  it('auto-defense blocks a body hook instead of ducking', () => {
    const { sim, player, enemy } = setup(1.05);
    enemy.startMove(enemy.moves.hook, false, 'body');
    const kinds: string[] = [];
    for (let f = 0; f < 40; f++) for (const e of sim.step()) if (e.type === 'defend' && e.f === player) kinds.push(e.kind);
    expect(kinds[0]).toBe('block');
  });

  it('goes to the body more often against a covering opponent', () => {
    const count = (covering: boolean) => {
      const { player, enemy } = setup(1.0);
      let body = 0;
      for (let i = 0; i < 200; i++) {
        if (covering) enemy.enterBlockstun(30);
        else enemy.enterLocomotion(1);
        player.startMove(player.moves.jab);
        if (player.strikeHeight === 'mid') body++;
      }
      return body;
    };
    expect(count(true)).toBeGreaterThan(count(false) * 1.5);
  });
});
