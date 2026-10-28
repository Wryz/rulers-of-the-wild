// P38: the settle rule (world/entities.ts EntityStore.settle; PHYSICS_TUNING.settleDriftM, settleSwingM, settleS).
// Long thin bodies lying on the Clearing's uneven heightfield used to rock and creep for ever (31 of 61 branches and
// logs on seed 1, up to 11 cm in 30 s: rule 3): Rapier's speed thresholds never saw through its contact jitter. With
// the rule they fall asleep within 10 s and stay put for a minute; without it (settleSwingM 0) they don't.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
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

describe('the settle rule (P38): branches and logs on the terrain fall asleep and stay put', () => {
  for (const seed of [1, 7]) {
    it(`seed ${seed}: every generated branch and log is asleep within 10 s and moves < 1 mm over the next 60 s`, async () => {
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

  it('control: without the rule (settleSwingM 0) many of them never sleep and keep creeping (seed 1)', async () => {
    setTuningValue('PHYSICS_TUNING', 'settleSwingM', 0);
    const w = await createWorld({ seed: 1, scene: 'clearing', nav: 'off' });
    live.push(w);
    const bodies = lying(w);
    await run(w, SETTLE_TICKS);
    const awake = bodies.filter((e) => !e.body!.isSleeping());
    expect(awake.length).toBeGreaterThanOrEqual(10);
    const at = new Map<number, V3>(awake.map((e) => [e.id, { ...e.pose.p }]));
    await run(w, STAY_TICKS);
    const creep = Math.max(...awake.map((e) => Math.hypot(e.pose.p.x - at.get(e.id)!.x, e.pose.p.z - at.get(e.id)!.z)));
    expect(creep).toBeGreaterThan(0.01);
  });
});
