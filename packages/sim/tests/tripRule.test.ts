// The lost-support trip rule (P28; docs/M1-DESIGN.md §4.7 steps 7-8, the WardedMMO session's advice in
// docs/work/warded-advice.md): a ruler's support set (the entities that held its root or carried a share of a planted
// foot's load lately) and the source of each break. A support lost to the ruler's own weight or legs makes the drop that
// follows a 'cover' trip; one lost to a blow does not; precedence support > ledge > obstacle.
import { afterEach, describe, expect, it } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { RULER_BODY_TUNING, supportLoss } from '../src/world/rulerBody';
import type { Owner } from '../src/world/types';
import { type Harness, makeHarness } from './support/worldHarness';
import { lyingAlong } from './support/scenes';

const live: Harness[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

describe('supportLoss: which breaks of a support are lost to the ruler', () => {
  const shin: Owner = { kind: 'fighter', id: 7, part: 'ruler', bone: 'shinL' };
  it('a load break (anyone\'s), its own leg\'s impact, or an unknown break counts; a blow does not', () => {
    expect(supportLoss(7, { energy: 0, by: shin })).toBe(true);
    expect(supportLoss(7, { energy: 0, by: { kind: 'entity', id: 3 } })).toBe(true);
    expect(supportLoss(7, { energy: 120, by: shin })).toBe(true);
    expect(supportLoss(7, { energy: 120, by: { kind: 'fighter', id: 7, part: 'ruler', bone: 'thighR' } })).toBe(true);
    expect(supportLoss(7, null)).toBe(true);
    expect(supportLoss(7, { energy: 120, by: null })).toBe(true);
    expect(supportLoss(7, { energy: 120, by: { kind: 'fighter', id: 7, part: 'ruler', bone: 'foreArmR' } })).toBe(false);
    expect(supportLoss(7, { energy: 120, by: { kind: 'fighter', id: 1, part: 'zone' } })).toBe(false);
    expect(supportLoss(7, { energy: 120, by: { kind: 'entity', id: 9 } })).toBe(false);
  });
});

/**
 * A giant (brain off) standing with its feet across two heavy green logs lying side by side under it (each 0.3 m to one
 * side of its root, flat face down: ground, below its ankle, and strong enough for its weight); then one of them breaks
 * as asked, and a 'ledge' trip is asked the tick after: what the rule makes of it.
 */
async function standOnTwoBearers(): Promise<{ h: Harness; giant: Fighter; logs: number[] }> {
  const h = await makeHarness({ seed: 31, size: 40 });
  live.push(h);
  const giant = h.creature('giantApe', { x: 0, z: 0 }, Math.PI / 2, { brain: 'off' });
  h.script(giant, { kind: 'hold' });
  h.ticks(30);
  const logs = [-0.3, 0.3].map((x) => h.log({ mass: 900, length: 3, r: 0.2, material: 'greenWood', p: { x, y: 0.19, z: 0 }, q: lyingAlong(0) }));
  h.ticks(90);
  return { h, giant, logs };
}

function tripAfter(h: Harness, giant: Fighter, breakIt: () => void): string | undefined {
  breakIt();
  h.ticks(1);
  h.w.rulers.requestTrip(giant, 'ledge', null);
  return giant.ruler!.pendingTrip?.why;
}

describe('the lost-support rule on a ruler standing on two bearers', () => {
  it('one broken by its foot (its shin\'s impact): support (cover)', async () => {
    const { h, giant, logs } = await standOnTwoBearers();
    const e = h.ent(logs[0]);
    const why = tripAfter(h, giant, () => h.w.breaking.hit(e, 1e7, { ...e.pose.p }, { kind: 'fighter', id: giant.id, part: 'ruler', bone: 'shinL' }));
    expect(h.w.entities.get(logs[0])).toBeUndefined();
    expect(why).toBe('cover');
    expect(giant.ruler!.pendingTrip!.cause?.entityId).toBe(logs[0]);
  }, 120_000);

  it('one broken by sustained load (a load break): support (cover)', async () => {
    const { h, giant, logs } = await standOnTwoBearers();
    const e = h.ent(logs[1]);
    const why = tripAfter(h, giant, () => h.w.breaking.loadBreak(e, { ...e.pose.p }, { kind: 'fighter', id: giant.id, part: 'ruler', bone: 'shinR' }));
    expect(h.w.entities.get(logs[1])).toBeUndefined();
    expect(why).toBe('cover');
  }, 120_000);

  it('one broken from the side by a player\'s axe: not support (a ledge)', async () => {
    const { h, giant, logs } = await standOnTwoBearers();
    const e = h.ent(logs[0]);
    const why = tripAfter(h, giant, () => h.w.breaking.hit(e, 1e7, { ...e.pose.p }, { kind: 'fighter', id: h.p.id, part: 'zone' }));
    expect(h.w.entities.get(logs[0])).toBeUndefined();
    expect(why).toBe('ledge');
  }, 120_000);

  it('precedence: a support loss beats a ledge beats an obstacle, asked in one tick', async () => {
    const { h, giant } = await standOnTwoBearers();
    h.w.rulers.requestTrip(giant, 'obstacle', null);
    h.w.rulers.requestTrip(giant, 'ledge', null);
    expect(giant.ruler!.pendingTrip!.why).toBe('ledge');
    h.w.rulers.requestTrip(giant, 'obstacle', null);
    expect(giant.ruler!.pendingTrip!.why).toBe('ledge');
    h.w.rulers.requestTrip(giant, 'cover', null);
    expect(giant.ruler!.pendingTrip!.why).toBe('cover');
    expect(RULER_BODY_TUNING.supportMinShare).toBeGreaterThan(0);
  }, 120_000);
});
