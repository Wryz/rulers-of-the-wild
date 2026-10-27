// P28, DEPARTURE from C F3 ("code forces are impulses, never addForce"): sustained code forces (a drag, a creature's tug,
// a hauled rope's pull, a controller leaning on a light body) go through EntityStore.queueForce, a Rapier force added
// before the step and reset after it; instantaneous hits stay impulses (queueImpulse). This file shows why and that the
// force never outlives its tick (docs/work/ledger.md, P28 fifth pass).
//
// The creep: Rapier spends an impulse given before the step in its first substep, where a contact can hold only that
// substep's share of friction, so a load well under the static threshold, re-applied every tick as an impulse, walks
// the body along. As a force it is integrated in every substep and friction holds it.

import { afterEach, describe, expect, it } from 'vitest';
import { DT } from '../src/sim/math';
import { type Harness, makeHarness } from './support/worldHarness';

const RAPIER_IT_MS = 120_000;

const live: Harness[] = [];
async function make(): Promise<Harness> {
  const h = await makeHarness({ seed: 48, size: 40 });
  live.push(h);
  return h;
}
afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

/** A dry-wood box (0.4 × 0.2 × 0.4 m) settled on the ground and kept awake; μ the wood-on-ground average the C lab used. */
async function settledBox(): Promise<{ h: Harness; box: number; weightN: number; mu: number }> {
  const h = await make();
  const g = h.w.terrain.heightAt(2.013, 2.013);
  const box = h.box({ p: { x: 2.013, y: g + 0.1, z: 2.013 }, size: [0.4, 0.2, 0.4], material: 'dryWood', state: 'free', look: 'box' });
  h.ticks(60);
  h.keepAwake(box);
  return { h, box, weightN: h.ent(box).mass * 9.81, mu: (0.6 + 0.7) / 2 };
}

/** Push the box along +x for 3 s (180 ticks) with `n` newtons, as a force or as the same impulse per tick; metres moved. */
function push(h: Harness, box: number, n: number, as: 'force' | 'impulse'): number {
  const x0 = h.ent(box).pose.p.x;
  for (let t = 0; t < 180; t++) {
    if (as === 'force') h.w.entities.queueForce(box, { x: n, y: 0, z: 0 }, null);
    else h.w.entities.queueImpulse(box, { x: n * DT, y: 0, z: 0 }, null);
    h.step();
  }
  return h.ent(box).pose.p.x - x0;
}

describe('sustained code forces (P28: in-solver, reset every step)', () => {
  it('a box pushed at 0.3 μN as a force does not creep in 3 s; as a per-tick impulse it does (the C F3 creep)', async () => {
    const a = await settledBox();
    const asForce = push(a.h, a.box, 0.3 * a.mu * a.weightN, 'force');
    const b = await settledBox();
    const asImpulse = push(b.h, b.box, 0.3 * b.mu * b.weightN, 'impulse');
    console.info(`0.3 μN (${(0.3 * a.mu * a.weightN).toFixed(0)} N) for 3 s: as a force ${(asForce * 1000).toFixed(3)} mm, as impulses ${(asImpulse * 1000).toFixed(3)} mm`);
    // The fix: ≈ 0 (the C lab: no motion under an in-solver force).
    expect(Math.abs(asForce)).toBeLessThan(0.0005);
    // The control (P28 lab: 6.7 mm): the impulse path creeps, so the check above is not vacuous.
    expect(asImpulse).toBeGreaterThan(0.002);
  }, RAPIER_IT_MS);

  it('above μN the same force slides the box (it is a real force)', async () => {
    const a = await settledBox();
    const moved = push(a.h, a.box, 1.1 * a.mu * a.weightN, 'force');
    console.info(`1.1 μN for 3 s as a force: ${moved.toFixed(3)} m`);
    expect(moved).toBeGreaterThan(0.5);
  }, RAPIER_IT_MS);

  it('a force acts in its own tick only: none is left on the body after the step', async () => {
    const a = await settledBox();
    a.h.w.entities.queueForce(a.box, { x: 50, y: 0, z: 0 }, { x: 2.013, y: a.h.ent(a.box).pose.p.y + 0.1, z: 2.013 });
    a.h.step();
    const b = a.h.ent(a.box).body!;
    const f = b.userForce();
    const tq = b.userTorque();
    expect([f.x, f.y, f.z, tq.x, tq.y, tq.z]).toEqual([0, 0, 0, 0, 0, 0]);
  }, RAPIER_IT_MS);
});
