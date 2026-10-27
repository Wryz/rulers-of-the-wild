// The lost-support trip rule (P28; docs/M1-DESIGN.md §4.7 steps 7-8, the WardedMMO session's advice in
// docs/work/warded-advice.md): a ruler's support set (the entities that held its root or carried a share of a planted
// foot's load lately) and the source of each break. A support lost to the ruler's own weight or legs makes the drop that
// follows a 'cover' trip; one lost to a blow does not; precedence support > ledge > obstacle.
import { afterEach, describe, expect, it } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { RULER_BODY_TUNING, supportLoss } from '../src/world/rulerBody';
import type { ImpactCause, Owner } from '../src/world/types';
import { type Harness, makeHarness } from './support/worldHarness';
import { lyingAlong } from './support/scenes';

const live: Harness[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.w.dispose();
});

describe('supportLoss: which breaks of a support are lost to the ruler', () => {
  const shin: Owner = { kind: 'fighter', id: 7, part: 'ruler', bone: 'shinL' };
  // P28 review: a load break counts only as this ruler's (or with no loader named); another's load break does not.
  it('its own load break, its own leg\'s impact, or an unknown break counts; a blow or another\'s load break does not', () => {
    expect(supportLoss(7, { energy: 0, by: shin })).toBe(true);
    expect(supportLoss(7, { energy: 0, by: null })).toBe(true);
    expect(supportLoss(7, { energy: 0, by: { kind: 'entity', id: 3 } })).toBe(false);
    expect(supportLoss(7, { energy: 0, by: { kind: 'fighter', id: 8, part: 'ruler', bone: 'shinL' } })).toBe(false);
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

/** The support record RulerBodies keeps for `giant` and entity `id` (private; read for the test only). */
function supportOf(h: Harness, giant: Fighter, id: number): { tick: number; at?: { x: number; y: number; z: number }; restTick?: number; loadTick?: number } | undefined {
  const rb = (h.w.rulers as unknown as { byId: Map<number, { supports: Map<number, { tick: number; restTick?: number; loadTick?: number }> }> }).byId.get(giant.id);
  return rb?.supports.get(id);
}

describe('P28 review: only a support that bore the ruler is lost from under it', () => {
  it('an obstacle trip next to sticks its shin breaks stays the obstacle\'s, credited to the player who built it', async () => {
    const { h, giant, logs } = await standOnTwoBearers();
    // Dry sticks lying on the ground by its feet, outside the bearers (debris: none carries the giant).
    const sticks = [-1.2, 1.2].map((x) => h.stick({ length: 1.2, r: 0.03, p: { x, y: 0.04, z: 0.4 }, q: lyingAlong(0) }));
    h.ticks(30);
    // As a sole that only touched them (a ground cast) would note them: in its support set, never bearing its load.
    const rb = (h.w.rulers as unknown as { byId: Map<number, { supports: Map<number, object> }> }).byId.get(giant.id)!;
    for (const id of sticks) rb.supports.set(id, { tick: h.w.tick, credit: [], at: { ...h.ent(id).pose.p }, restTick: h.w.tick });
    for (const id of sticks) expect(supportOf(h, giant, id)?.loadTick).toBeUndefined();
    expect(supportOf(h, giant, logs[0])?.loadTick).toBeDefined();
    for (const id of sticks) {
      const e = h.ent(id);
      h.w.breaking.hit(e, 1e7, { ...e.pose.p }, { kind: 'fighter', id: giant.id, part: 'ruler', bone: 'shinL' });
    }
    h.ticks(1);
    for (const id of sticks) expect(h.w.entities.get(id)).toBeUndefined();
    const obstacle: ImpactCause = { kind: 'entity', entityId: logs[1], fighterId: null, credit: ['p1'], held: false, feature: 'fall' };
    h.w.rulers.requestTrip(giant, 'obstacle', obstacle);
    expect(giant.ruler!.pendingTrip?.why).toBe('obstacle');
    expect(giant.ruler!.pendingTrip?.cause?.credit).toEqual(['p1']);
  }, 120_000);

  it('a bearer sliding out from under it: its hold expires and it is lost once 0.25 m from where it was first noted', async () => {
    const { h, giant, logs } = await standOnTwoBearers();
    const id = logs[0];
    const s0 = supportOf(h, giant, id)!;
    expect(s0.loadTick).toBeDefined();
    const at0 = { ...s0.at! };
    const v = 0.3; // m/s: faster than groundMaxSpeedMps, so never ground on its own while it slides
    expect(v).toBeGreaterThan(RULER_BODY_TUNING.groundMaxSpeedMps);
    let expiredAt = -1;
    let lostAt = -1;
    for (let t = 0; t < 120 && lostAt < 0; t++) {
      h.ent(id).body!.setLinvel({ x: -v, y: 0, z: 0 }, true);
      h.step();
      const s = supportOf(h, giant, id);
      if (s && s.at) expect(s.at).toEqual(at0); // kept from the first notice, not refreshed
      if (expiredAt < 0 && !h.w.rulers.holdsUp(id)) expiredAt = t;
      if (!s) lostAt = t;
    }
    // The hold lapses at most coverHoldTicks after it last rested on its own (here it already had: the giant's hold keeps
    // it jostled); then it is lost, displaced 0.25 m from where it was first noted (≈ 0.8 s at 0.3 m/s).
    expect(expiredAt).toBeGreaterThanOrEqual(0);
    expect(expiredAt).toBeLessThanOrEqual(RULER_BODY_TUNING.coverHoldTicks + 2);
    expect(lostAt).toBeGreaterThan(0);
    expect(lostAt).toBeLessThan(80);
    // A ledge trip asked now is that support's trip.
    expect(giant.ruler!.pendingTrip).toBeNull();
    h.w.rulers.requestTrip(giant, 'ledge', null);
    expect(giant.ruler!.pendingTrip?.why).toBe('cover');
    expect(giant.ruler!.pendingTrip?.cause?.entityId).toBe(id);
  }, 120_000);
});
