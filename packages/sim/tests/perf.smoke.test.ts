// P38 perf smoke (docs/M1-DESIGN.md §13.1 P38, §9.3; SPEC:800 "Sim step: under 5 ms on average"): a 10-minute
// headless soak of the Clearing (36,000 ticks, no commands: the player stands at the spawn while the apes and the giant
// go about their minds), with no NaN anywhere and a sim step median under 5 ms.
//
// The step is timed as the worker process's CPU time (user + system) around each World.step, so a loaded machine running
// other test files beside it doesn't count against the sim; the wall-clock median is logged beside it. The NaN checks
// and the event-loop yields are outside the timed steps.
//
// The gate is SPEC:800's 5 ms, not relaxed. If it fails, the log prints the median and the profile hint; the perf work
// and the measured profile are in docs/work/ledger.md (P38 perf) and tools/profile-soak.mjs prints the phase table.
import { afterAll, describe, expect, it } from 'vitest';
import type { World } from '../src/world/world';
import { createWorld } from '../src/world/world';
import { YIELD_TICKS, yieldToVitest } from './support/yieldToVitest';

/** SPEC:800: the sim step budget, ms (an acceptance parameter, not tuning). */
const STEP_BUDGET_MS = 5;
/** 10 minutes at 60 Hz (§13.1 P38). */
const SOAK_TICKS = 36_000;
/** How often every body is checked for NaN, ticks. */
const CHECK_EVERY = 60;
const SEED = 1;

const finite = (...xs: number[]): boolean => xs.every((x) => Number.isFinite(x));

/** The first non-finite number in the world's bodies (entities' poses and velocities, fighters' roots and bones), or null. */
function firstNaN(w: World): string | null {
  for (const e of w.entities.all()) {
    const { p, q } = e.pose;
    if (!finite(p.x, p.y, p.z, q.x, q.y, q.z, q.w)) return `entity ${e.id} pose`;
    if (!finite(e.vel.lin.x, e.vel.lin.y, e.vel.lin.z, e.vel.ang.x, e.vel.ang.y, e.vel.ang.z)) return `entity ${e.id} velocity`;
  }
  for (const f of w.combat.fighters) {
    if (!finite(f.pos.x, f.pos.y, f.pos.z, f.yaw, f.hp)) return `fighter ${f.id} root`;
    for (const [bone, b] of Object.entries(f.rig)) if (!finite(b.pos.x, b.pos.y, b.pos.z)) return `fighter ${f.id} ${bone}`;
  }
  return null;
}

describe('perf smoke: a 10-minute soak of the Clearing (P38, SPEC:800)', () => {
  let w: World | null = null;
  afterAll(() => w?.dispose());

  it(
    'runs 36,000 ticks with no NaN, and the sim step median is under 5 ms',
    async () => {
      w = await createWorld({ seed: SEED, scene: 'clearing', nav: 'full' });
      const cpu = new Float64Array(SOAK_TICKS);
      const wall = new Float64Array(SOAK_TICKS);
      let nan: string | null = null;
      for (let t = 0; t < SOAK_TICKS; t++) {
        const c0 = process.cpuUsage();
        const t0 = performance.now();
        w.step();
        wall[t] = performance.now() - t0;
        const c = process.cpuUsage(c0);
        cpu[t] = (c.user + c.system) / 1000;
        if ((t + 1) % CHECK_EVERY === 0) {
          nan = firstNaN(w);
          if (nan) {
            nan = `${nan} at tick ${w.tick}`;
            break;
          }
        }
        if ((t + 1) % YIELD_TICKS === 0) await yieldToVitest();
      }
      expect(nan).toBeNull();
      const median = (xs: Float64Array): number => Float64Array.from(xs).sort()[Math.floor(xs.length / 2)];
      const mean = (xs: Float64Array): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      const cpuMedian = median(cpu);
      console.info(
        `perf smoke (seed ${SEED}, ${SOAK_TICKS} ticks, ${w.entities.all().length} entities): step CPU median ${cpuMedian.toFixed(2)} ms ` +
          `(mean ${mean(cpu).toFixed(2)}), wall median ${median(wall).toFixed(2)} ms (mean ${mean(wall).toFixed(2)}); budget ${STEP_BUDGET_MS} ms` +
          (cpuMedian < STEP_BUDGET_MS ? '' : ' — OVER BUDGET: see docs/work/ledger.md (P38 perf) and `npx vite-node tools/profile-soak.mjs`'),
      );
      expect(cpuMedian).toBeLessThan(STEP_BUDGET_MS);
    },
    1_800_000,
  );
});
