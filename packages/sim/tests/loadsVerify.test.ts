// P38 (review): the loads memos (world/loads.ts) under verify mode, so the guard runs in every suite and not only on
// request: Loads.verify recomputes every memoised answer (supports, centre of mass, span tests) from Rapier and throws
// on any difference. Two scenes: the Clearing with its creatures (resting bodies, feet, a navmesh-free world), and a
// covering chain on spanning branches that a dropped stone breaks (coverings, spans, load breaks, entities removed).
// Each also checks the memos were really used (memoHits), so the check can't pass on an empty cache.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnBox, spawnGrass, spawnLog, spawnStone } from '../src/world/factory';
import { Loads } from '../src/world/loads';
import { physicsReady } from '../src/world/physics';
import type { WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';
import { yieldToVitest } from './support/yieldToVitest';

vi.setConfig({ testTimeout: 300_000 });

const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
  Loads.verify = true;
});
afterAll(() => {
  Loads.verify = false;
  for (const w of live.splice(0)) w.dispose();
});

async function run(w: World, ticks: number, on?: (e: readonly WorldEvent[]) => void): Promise<void> {
  for (let t = 0; t < ticks; t++) {
    w.step();
    on?.(w.events);
    if (t % 200 === 199) await yieldToVitest();
  }
}

describe('the loads memos agree with Rapier (P38, verify mode)', () => {
  it('the Clearing (seed 1, creatures on), 1,200 ticks', async () => {
    const w = await createWorld({ seed: 1, scene: 'clearing', nav: 'off' });
    live.push(w);
    await run(w, 1200);
    expect(w.loads.memoHits).toBeGreaterThan(1000);
  });

  it('a grass mat on rotten branches spanning a gap, broken by a dropped stone', async () => {
    const w = await createWorld({ seed: 3, scene: 'empty', nav: 'off', size: 50, player: false });
    live.push(w);
    // Two fixed posts 1.2 m apart; five rotten branches across them; a grass mat over the branches.
    for (const x of [-0.9, 0.9]) spawnBox(w, { p: { x, y: 0.5, z: 0 }, size: [0.6, 1, 2], material: 'stone', state: 'fixed', look: 'post' });
    const across = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    for (const z of [-0.6, -0.3, 0, 0.3, 0.6]) spawnLog(w, { p: { x: 0, y: 1.05, z }, q: across, length: 2.4, r: 0.025, material: 'rottenWood' });
    spawnGrass(w, { p: { x: 0, y: 1.2, z: 0 }, mass: 2, size: [1.6, 0.05, 1.6] });
    await run(w, 600);
    const settled = w.loads.memoHits;
    expect(settled).toBeGreaterThan(0);
    spawnStone(w, { p: { x: 0, y: 2.2, z: 0 }, mass: 40 });
    let breaks = 0;
    await run(w, 600, (ev) => {
      for (const e of ev) if (e.type === 'break') breaks++;
    });
    expect(breaks).toBeGreaterThan(0);
    expect(w.loads.memoHits).toBeGreaterThan(settled);
  });
});
