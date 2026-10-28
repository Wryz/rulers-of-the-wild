// P38: KNOWN BUG, documented (rule 3): long thin bodies lying on the Clearing's uneven heightfield never fall asleep.
// Their contacts there jitter (they hop 2-6 mm and rock 0.5-3 rad/s about the long axis, or seesaw on a bump), and
// Rapier sleeps a body only below fixed speeds (0.4 m/s, 0.5 rad/s, not scaled by size), so 31 of 61 generated
// branches and logs on seed 1 rock and creep for ever (up to 11 cm in 30 s), and cost ≈ 3 ms of Rapier per tick.
// A position-based settle rule fixed it (both `it.fails` below passed with it) but broke AC-2(b) and AC-3, even
// narrowed to loose bodies resting on the terrain alone, so it was reverted (docs/work/ledger.md, P38). These stay
// `it.fails` until a fix keeps every gate green; flip them then.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetTuning } from '../src/tuning/registry';
import { physicsReady } from '../src/world/physics';
import type { Entity, V3 } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';
import { yieldToVitest } from './support/yieldToVitest';

vi.setConfig({ testTimeout: 300_000 });

/** Test constants (never tuning): the settling time allowed, and how long and how still they must then stay. */
const SETTLE_TICKS = 600;
const STAY_TICKS = 3600;
const STAY_MAX_MOVE_M = 0.001;

const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
});
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('PHYSICS_TUNING');
});

/** The generated branches and logs lying free on the ground (long prisms). */
const lying = (w: World): Entity[] => w.entities.dynamic().filter((e) => e.generated && e.shape.kind === 'cylinder' && (e.look === 'stick' || e.look === 'log'));

async function run(w: World, ticks: number): Promise<void> {
  for (let t = 0; t < ticks; t++) {
    w.step();
    if (t % 200 === 199) await yieldToVitest();
  }
}

describe('KNOWN BUG (P38): branches and logs on the terrain should fall asleep and stay put', () => {
  for (const seed of [1, 7]) {
    it.fails(`seed ${seed}: every generated branch and log is asleep within 10 s and moves < 1 mm over the next 60 s`, async () => {
      const w = await createWorld({ seed, scene: 'clearing', nav: 'off' });
      live.push(w);
      const bodies = lying(w);
      expect(bodies.length).toBeGreaterThan(40);
      await run(w, SETTLE_TICKS);
      expect(bodies.filter((e) => !e.body!.isSleeping()).map((e) => e.id)).toEqual([]);
      const at = new Map<number, V3>(bodies.map((e) => [e.id, { ...e.pose.p }]));
      await run(w, STAY_TICKS);
      const moved = bodies
        .map((e) => ({ id: e.id, m: Math.hypot(e.pose.p.x - at.get(e.id)!.x, e.pose.p.y - at.get(e.id)!.y, e.pose.p.z - at.get(e.id)!.z) }))
        .filter((x) => !(x.m < STAY_MAX_MOVE_M));
      expect(moved).toEqual([]);
    });
  }
});
