import { describe, expect, it } from 'vitest';
import { CombatSim } from '../src/sim/combat';
import { ENEMY_MOVES, PLAYER_MOVES } from '../src/sim/moves';
import { createBrawler, createPlayer } from '../src/sim/roster';

/** Farthest starting distance (5 cm steps) at which the move connects with an idle target. */
function measureReach(side: 'player' | 'enemy', id: string): number {
  let best = 0;
  for (let d = 0.7; d <= 5; d += 0.05) {
    const sim = new CombatSim(1);
    const p = createPlayer();
    const { fighter: e, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
    p.autoDefense = false;
    p.pos.set(0, 0, 0);
    p.yaw = Math.PI / 2;
    e.pos.set(d, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(p);
    sim.add(e, ai);
    sim.step();
    const [a, t] = side === 'player' ? [p, e] : [e, p];
    const m = a.moves[id];
    a.startMove(m, false, m.aims?.[0].id ?? 'primary');
    let hit = false;
    for (let i = 0; i < 70 && !hit; i++) for (const ev of sim.step()) if (ev.type === 'hit' && ev.defender === t) hit = true;
    if (hit) best = d;
  }
  return best;
}

// AI spacing and auto-defense threat checks rely on `reach`; keep it honest with the animation.
describe('declared reach matches animated geometry', () => {
  for (const [side, table] of [['player', PLAYER_MOVES], ['enemy', ENEMY_MOVES]] as const) {
    // (A throw's reach is the throw; an evasive flip doesn't strike at all.)
    for (const m of Object.values(table).filter((x) => !x.noHit)) {
      it(`${side} ${m.id}`, () => {
        const measured = measureReach(side, m.id);
        expect(Math.abs(measured - m.reach), `${m.id}: measured ${measured.toFixed(2)} m, declared ${m.reach} m`).toBeLessThanOrEqual(0.12);
      });
    }
  }
});
