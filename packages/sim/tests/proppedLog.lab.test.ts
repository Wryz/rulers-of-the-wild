// P28 lab (not an acceptance test): the propped log of §11.2(a)'s staged recipe (scenes.ts buildProppedLog) under a force
// pushed straight onto the bait, not through any creature: where the in-solver forces put the prop's hold (the C F3
// departure, docs/work/ledger.md P28 fifth pass), and a logged sweep of the neighbourhood of the AC-2(a) geometries.
import { afterEach, describe, expect, it } from 'vitest';
import { buildProppedLog, PROPPED_AS_DESIGNED, PROPPED_P28, type ProppedGeometry } from './support/scenes';
import { type Harness, makeHarness } from './support/worldHarness';

const LONG_IT_MS = 600_000;
const live: Harness[] = [];
async function make(seed: number, size: number): Promise<Harness> {
  const h = await makeHarness({ seed, size });
  live.push(h);
  return h;
}
afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

describe('the propped log under a sustained force on its bait (P28 lab)', () => {
/**
 * P28 (C F3 departure: sustained code forces are in-solver forces, EntityStore.queueForce): the staged prop's hold
 * under a force on the bait toward the ape, applied in full from the first tick (a step, the C lab's method) at the
 * bait's centre: the tick of the spring (the log's centre 5 cm down) within 360 ticks, or -1.
 */
function springUnder(h: Harness, r: { log: number; bait: number }, forceN: number): number {
  h.ticks(60);
  const y0 = h.ent(r.log).pose.p.y;
  for (let t = 0; t < 360; t++) {
    if (t < 120) h.w.entities.queueForce(r.bait, { x: -forceN, y: 0, z: 0 }, { ...h.ent(r.bait).pose.p });
    h.step();
    if (h.ent(r.log).pose.p.y < y0 - 0.05) return t;
  }
  return -1;
}

it('the prop holds a sustained 700 N on its bait and gives at 762 N (199 kg log); the design\'s 248 kg one holds 850 N (the C lab)', async () => {
  const at = async (g: ProppedGeometry, n: number): Promise<{ kg: number; spring: number }> => {
    const h = await make(48, 40);
    const r = buildProppedLog(h, g);
    return { kg: h.ent(r.log).mass, spring: springUnder(h, r, n) };
  };
  const g199 = { ...PROPPED_P28, logR: 0.15 };
  const runs = { hold700: await at(g199, 700), give762: await at(g199, 762), design850: await at(PROPPED_AS_DESIGNED, 850), design908: await at(PROPPED_AS_DESIGNED, 908) };
  console.info(`propped log, sustained force on the bait: ${Object.entries(runs).map(([k, v]) => `${k} (${v.kg.toFixed(0)} kg) spring ${v.spring}`).join('; ')}`);
  // PIN (P28 fifth pass, the C lab's thresholds; under C F3's pre-step impulses this prop sprang from ≈ 500 N):
  // holds 700 N 2 s; springs at 762 N (60 ticks); the design's log holds 850 N, springs at 908 N (57 ticks).
  expect(runs.hold700.spring).toBe(-1);
  expect(runs.give762.spring).toBeGreaterThan(0);
  expect(runs.design850.spring).toBe(-1);
  expect(runs.design908.spring).toBeGreaterThan(0);
}, LONG_IT_MS);

});
