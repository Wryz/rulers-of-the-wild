// P10, felling (docs/M1-DESIGN.md §2.5, §4.12): chops and the notch, the hinge capacity against the fall-direction
// moment, the fall on a runtime hinge at the uncut edge away from the cut side, the stump, the joints that move with
// the trunk, the tear at 75°, felled.
//
// - The §4.12 numbers [I verified: fell.mjs]: a 30 cm × 15 m green tree, 738 kg above the cut, back-moment 1,086 N·m,
//   M_cap 15,904 N·m at half, 3,435 at 0.3, 1,018 at 0.2.
// - A 30 cm tree holds through 14 stone-axe chops and falls at the 15th, away from the chopper's side (at any angle, not
//   in the 8-gon's 45° steps), on the fall line within 1° while it falls and where it first meets the ground.
// - DESIGN CONFLICT (P09's m_eff, reported): §13.1 asks that the 30 cm × 15 m trunk *lands* within 1° of the fall line;
//   the contact rule scores its landing with the whole trunk's mass (E ≈ 133 kJ against E_b ≈ 29.5 kJ), so it shatters
//   into 4 pieces where it lands. Every green trunk 8 m or taller shatters (0.3 × 8 m: 36.7 kJ vs 15.3 kJ); 6 m and
//   shorter land whole. The whole-trunk landing is kept as an expected failure until the design decides; a 20 cm × 6 m
//   tree is felled whole on the fall line.
// - Pulls fell it at the §4.12 thresholds: 500 N through a rope tied 10 m up, from 15.6 m out on the fall line, at
//   remaining 0.28 yes and 0.30 no; the 1,200 N yank at 0.40 yes and 0.50 no.
// - A falling trunk takes its vine along; a rope below the cut goes to the stump.
// - The hinge tears at hingeTearDeg; a torn trunk at rest, clear of its stump, is felled (plant null, an ordinary log).
//
// Scene numbers (sizes, masses, positions, ticks) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetTuning } from '../src/tuning/registry';
import { spawnLog, spawnRopeCoil, spawnTree } from '../src/world/factory';
import { chopDepth, FELL_TUNING } from '../src/world/felling';
import { physicsReady } from '../src/world/physics';
import type { Entity, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 202, scene: 'empty', nav: 'off', size: 75, player: false, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

function ent(w: World, id: number): Entity {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
}

function run(w: World, n: number, each?: () => void): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = 0; i < n; i++) {
    each?.();
    w.step();
    out.push(...w.events);
  }
  return out;
}

/** The trunk's axis (local +y) in the world. */
function axisOf(e: Entity): V3 {
  const q = e.pose.q;
  return { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) };
}

const tiltDeg = (e: Entity): number => (Math.acos(Math.max(-1, Math.min(1, axisOf(e).y))) * 180) / Math.PI;

/** Degrees between the trunk axis's horizontal heading and `dir`'s. */
function offLineDeg(e: Entity, dir: V3): number {
  const a = axisOf(e);
  const d = Math.atan2(a.z, a.x) - Math.atan2(dir.z, dir.x);
  return (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) * 180) / Math.PI;
}

const tree30 = (w: World, at = { x: 0, z: 0 }): number => spawnTree(w, { at, diameter: 0.3, height: 15 }).tree;

describe('the hinge (§4.12)', () => {
  it('a 30 cm × 15 m green tree: 738 kg above the cut, back-moment 1,086 N·m, M_cap 15,904 / 3,435 / 1,018 N·m at 0.5 / 0.3 / 0.2', async () => {
    const w = await make();
    const t = tree30(w);
    expect(w.felling.hingeCapacity(t)).toBe(0);
    w.felling.chop(t, { x: -1, y: 0, z: 0 }, 0.15, []);
    expect(w.felling.backMoment(t)).toBeCloseTo(1086, -1);
    const cap = (remaining: number): number => {
      ent(w, t).plant!.cut!.remaining = remaining;
      return w.felling.hingeCapacity(t);
    };
    expect(Math.abs(cap(0.5) - 15904) / 15904).toBeLessThan(0.002);
    expect(Math.abs(cap(0.3) - 3435) / 3435).toBeLessThan(0.002);
    expect(Math.abs(cap(0.2) - 1018) / 1018).toBeLessThan(0.002);
    // The hinge: on the trunk's surface at the cut height on the fall side, the axis horizontal ⟂ the fall.
    ent(w, t).plant!.cut!.remaining = 0.5;
    const h = w.felling.hingeOf(t)!;
    expect(h.fallDir).toEqual({ x: 1, y: 0, z: -0 });
    expect(h.point.x).toBeCloseTo(0.15, 9);
    expect(h.point.y - (ent(w, t).pose.p.y - 7.5)).toBeCloseTo(FELL_TUNING.cutHeightM, 6);
    expect(h.axis.y).toBe(0);
    expect(Math.abs(h.axis.z)).toBeCloseTo(1, 9);
  });

  it('chop depth: chopDepthM × clamp(fresh J / refChopJ, 0.5, 2.5) (the stone axe: 2 cm, SPEC:882)', () => {
    expect(chopDepth(339)).toBeCloseTo(0.02, 12);
    expect(chopDepth(100)).toBeCloseTo(0.01, 12);
    expect(chopDepth(5000)).toBeCloseTo(0.05, 12);
  });
});

describe('chops and the fall (§2.5)', () => {
  it('a 30 cm tree holds through 14 chops and falls at the 15th away from the chopper, on the fall line within 1°', async () => {
    const w = await make();
    const t = tree30(w);
    run(w, 5);
    const events: WorldEvent[] = [];
    for (let c = 1; c <= 15; c++) {
      const r = w.felling.chop(t, { x: -3, y: 0.4, z: 0 }, 0.02, ['p1']);
      expect(r.fell).toBe(c === 15);
      events.push(...run(w, 10));
      expect(ent(w, t).plant!.phase).toBe(c < 15 ? 'notched' : 'falling');
      if (c < 15) expect(ent(w, t).state).toBe('fixed');
    }
    const tree = ent(w, t);
    const p = tree.plant!;
    expect(p.cut).toEqual({ fromDir: { x: -1, y: 0, z: 0 }, remaining: 0, chops: 15, depthSumM: expect.closeTo(0.3, 12) });
    expect(tree.credit).toEqual(['p1']);
    expect(events.filter((e) => e.type === 'fell')).toEqual([{ type: 'fell', tree: t, dir: { x: 1, y: 0, z: -0 } }]);
    // The stump: fixed, the tree's diameter, cutHeightM tall, the tree's credit; the trunk keeps its id and plant.height.
    const stump = ent(w, p.stump!);
    expect(stump).toMatchObject({ state: 'fixed', look: 'stump', credit: ['p1'] });
    expect(stump.shape).toMatchObject({ kind: 'cylinder', halfHeight: expect.closeTo(FELL_TUNING.cutHeightM / 2, 9), r: 0.15 });
    expect(tree.shape).toMatchObject({ kind: 'cylinder', halfHeight: expect.closeTo((15 - FELL_TUNING.cutHeightM) / 2, 9) });
    expect(p.height).toBe(15);
    expect(p.fall!.hinge.x).toBeCloseTo(0.15, 6);
    expect(tree.body!.isDynamic()).toBe(true);
    expect(tree.body!.isCcdEnabled()).toBe(true);
    // It falls along +x, never off the line by more than 1°, and meets the ground on it: the trunk where it lands, or,
    // when the landing breaks it (see the expected failure below), every piece it breaks into in that tick (each keeps
    // the trunk's rotation, §4.10).
    let worst = 0;
    let landing: Entity[] | null = null;
    for (let i = 0; i < 600 && !landing; i++) {
      const ev = run(w, 1);
      const e = w.entities.get(t);
      const broke = ev.find((x): x is Extract<WorldEvent, { type: 'break' }> => x.type === 'break' && x.entity === t);
      if (broke) landing = broke.pieces.map((id) => ent(w, id));
      else if (e && ev.some((x) => x.type === 'land' && x.entity === t)) landing = [e];
      else if (e && tiltDeg(e) > 5) worst = Math.max(worst, offLineDeg(e, { x: 1, y: 0, z: 0 }));
    }
    expect(landing).not.toBeNull();
    expect(worst).toBeLessThan(1);
    for (const e of landing!) expect(offLineDeg(e, { x: 1, y: 0, z: 0 })).toBeLessThan(1);
  });

  // DESIGN CONFLICT (P09 m_eff for entity vs terrain = the whole mass, §4.3): expected to fail until the design decides
  // (the effective mass at the contact point, 1/(1/m + (r×n)ᵀI⁻¹(r×n)), ≈ m/4 at the tip, would score ≈ 37 kJ and take
  // ≈ 0.25 of its integrity). When it passes, `it.fails` fails: make it an ordinary `it`.
  it.fails('a 30 cm × 15 m tree felled by 15 chops lands whole, within 1° of the fall line, and is felled (§13.1)', async () => {
    const w = await make();
    const t = tree30(w);
    run(w, 5);
    for (let c = 1; c <= 15; c++) w.felling.chop(t, { x: -3, y: 0.4, z: 0 }, 0.02, ['p1']);
    let felled = false;
    for (let i = 0; i < 900 && !felled; i++) {
      w.step();
      felled = w.entities.get(t)?.plant === null;
    }
    expect(felled).toBe(true);
    const e = ent(w, t);
    expect(e.integrity).toBeGreaterThan(0);
    expect(offLineDeg(e, { x: 1, y: 0, z: 0 })).toBeLessThan(1);
  });

  it('a 20 cm × 6 m tree felled by chops lands whole, at rest within 1° of the fall line, and is felled', async () => {
    const w = await make();
    const t = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.2, height: 6 }).tree;
    run(w, 5);
    w.felling.chop(t, { x: 0, y: 0, z: 2 }, 0.2, ['p1']);
    let felled = -1;
    const ev = run(w, 900, () => {
      if (felled < 0 && w.entities.get(t)?.plant === null) felled = w.tick;
    });
    expect(ev.filter((x) => x.type === 'break' && x.entity === t)).toEqual([]);
    expect(felled).toBeGreaterThan(0);
    const e = ent(w, t);
    expect(e.state).toBe('free');
    expect(e.integrity).toBeGreaterThan(0);
    expect(tiltDeg(e)).toBeGreaterThan(80);
    // Away from the chopper's side (+z): along −z.
    expect(offLineDeg(e, { x: 0, y: 0, z: -1 })).toBeLessThan(1);
  });

  it('the fall follows the chopper’s side at any angle (fromDir is the chopper’s horizontal direction, not a facet’s)', async () => {
    const w = await make();
    const t = tree30(w);
    run(w, 3);
    const a = (200 * Math.PI) / 180;
    const from = { x: Math.cos(a), y: 0, z: Math.sin(a) };
    w.felling.chop(t, { x: from.x * 2, y: 1, z: from.z * 2 }, 0.3, []);
    const ev = run(w, 120);
    const fell = ev.find((e) => e.type === 'fell') as Extract<WorldEvent, { type: 'fell' }>;
    expect(fell.dir.x).toBeCloseTo(-from.x, 9);
    expect(fell.dir.z).toBeCloseTo(-from.z, 9);
    const e = ent(w, t);
    expect(tiltDeg(e)).toBeGreaterThan(10);
    expect(offLineDeg(e, fell.dir)).toBeLessThan(1);
  });

  it('a moment above the hinge’s capacity (net of the back-moment) fells a notched tree; a standing or felled tree ignores moments', async () => {
    const w = await make();
    const t = tree30(w);
    const u = tree30(w, { x: 6, z: 0 });
    run(w, 3);
    w.felling.addMoment(u, 1e9);
    w.felling.chop(t, { x: -1, y: 0, z: 0 }, 0.15, []);
    const cap = w.felling.hingeCapacity(t);
    const back = w.felling.backMoment(t);
    w.felling.addMoment(t, cap + back - 50);
    run(w, 1);
    expect(ent(w, t).plant!.phase).toBe('notched');
    // Moments last one tick: the next tick's must beat the hinge on its own.
    run(w, 1);
    w.felling.addMoment(t, (cap + back) / 2);
    w.felling.addMoment(t, (cap + back) / 2 + 1);
    run(w, 1);
    expect(ent(w, t).plant!.phase).toBe('falling');
    expect(ent(w, u).plant!.phase).toBe('standing');
    expect(ent(w, u).state).toBe('fixed');
  });
});

describe('pulled down (§4.12)', () => {
  /**
   * A 30 cm tree cut from −x to `remaining`, a rope tied on its axis 10 m up, held by the player 15.6 m out along the
   * fall line (+x), who pulls with `forceN` for `ticks`. Returns the tick the tree began to fall, or −1.
   */
  async function pullAt(remaining: number, forceN: number, ticks: number): Promise<number> {
    const w = await make({ player: true });
    const t = tree30(w);
    const p = w.player!;
    w.teleport(p, 15.6, 0, -Math.PI / 2);
    run(w, 20);
    w.felling.chop(t, { x: -1, y: 0, z: 0 }, (1 - remaining) * 0.3, []);
    const tie = { entity: t, local: { x: 0, y: 10 - 7.5, z: 0 } };
    const hand = w.joints.anchorPoint({ entity: null, local: { x: 0, y: 0, z: 0 }, fighter: p.id })!;
    const top = w.joints.anchorPoint(tie)!;
    const L = Math.hypot(top.x - hand.x, top.y - hand.y, top.z - hand.z);
    expect(L).toBeGreaterThan(17.5);
    expect(L).toBeLessThan(18.2);
    const coil = spawnRopeCoil(w, { at: { x: 20, y: 0, z: 20 }, material: 'vine', lengthM: 20 });
    const j = w.joints.rope(tie, { entity: null, local: hand }, L, { entity: coil, lengthM: L }, []);
    w.joints.holdEnd(j, 'b', p.id);
    for (let i = 0; i < ticks; i++) {
      w.joints.setPull(j, forceN);
      w.step();
      if (ent(w, t).plant!.phase === 'falling') return i;
    }
    return -1;
  }

  it('500 N on the fall line fells it at remaining 0.28, not at 0.30 (4,089 N·m vs M_cap + 1,086)', async () => {
    expect(await pullAt(0.3, 500, 60)).toBe(-1);
    const at = await pullAt(0.28, 500, 60);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(2);
  });

  it('the 1,200 N yank fells it at remaining 0.40, not at 0.50 (9,813 N·m)', async () => {
    expect(await pullAt(0.5, 1200, 9)).toBe(-1);
    const at = await pullAt(0.4, 1200, 9);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThanOrEqual(2);
  });
});

describe('the trunk’s joints, the tear, felled (§2.5)', () => {
  it('a falling trunk takes its vine along (in its new frame) and a rope tied below the cut goes to the stump', async () => {
    const w = await make();
    const { tree: t, vine } = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 15, vine: { anchorH: 10, lengthM: 18.2, yaw: Math.PI / 2 } });
    const stake = spawnLog(w, { p: { x: 0, y: 0.2, z: -3 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.04, state: 'anchored' });
    const coil = spawnRopeCoil(w, { at: { x: 20, y: 0, z: 20 }, material: 'vine', lengthM: 5 });
    const low = { entity: t, local: { x: 0, y: 0.2 - 7.5, z: -0.14 } };
    const lowAt = w.joints.anchorPoint(low)!;
    const stakeTop = { entity: stake, local: { x: 0, y: 0.5, z: 0 } };
    const L = Math.hypot(lowAt.x, lowAt.y - 0.7, lowAt.z + 3);
    const lowRope = w.joints.rope(low, stakeTop, L, { entity: coil, lengthM: L }, []);
    run(w, 3);
    const vineAt = w.joints.anchorPoint(w.joints.get(vine!.joint)!.a)!;
    w.felling.chop(t, { x: -1, y: 0, z: 0 }, 0.3, []);
    w.step();
    const stump = ent(w, t).plant!.stump!;
    const vj = w.joints.get(vine!.joint)!;
    expect(vj.a.entity).toBe(t);
    // The same point of the world at the cut, now in the shorter trunk's frame.
    const now = w.joints.anchorPoint(vj.a)!;
    expect(Math.hypot(now.x - vineAt.x, now.y - vineAt.y, now.z - vineAt.z)).toBeLessThan(0.02);
    expect(w.joints.get(lowRope)!.a.entity).toBe(stump);
    expect(ent(w, stump).joints).toEqual([lowRope]);
    expect(ent(w, t).joints).toEqual([vine!.joint]);
    const lowNow = w.joints.anchorPoint(w.joints.get(lowRope)!.a)!;
    expect(Math.hypot(lowNow.x - lowAt.x, lowNow.y - lowAt.y, lowNow.z - lowAt.z)).toBeLessThan(1e-6);
  });

  it('the hinge tears past hingeTearDeg; a torn trunk at rest and clear of its stump is felled: plant null, an ordinary free log', async () => {
    const w = await make();
    // A short, slender tree, so it lands without breaking (a 15 m trunk's tip lands at ≈ 20 m/s, see
    // breaking.test.ts) and still tips over: a short thick trunk given tipAngVel stands back up on its hinge.
    const t = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.08, height: 2.5 }).tree;
    run(w, 3);
    const joints0 = w.physics.rapier.impulseJoints.len();
    w.felling.chop(t, { x: 0, y: 0, z: -1 }, 0.08, ['p1']);
    let torn = -1;
    let felled = -1;
    for (let i = 0; i < 900 && felled < 0; i++) {
      w.step();
      const e = ent(w, t);
      if (torn < 0 && e.plant?.fall?.torn) {
        torn = i;
        expect(tiltDeg(e)).toBeGreaterThan(FELL_TUNING.hingeTearDeg);
        expect(tiltDeg(e)).toBeLessThan(FELL_TUNING.hingeLimitDeg + 5);
      }
      if (e.plant === null) felled = i;
    }
    expect(torn).toBeGreaterThan(0);
    expect(felled).toBeGreaterThan(torn);
    const e = ent(w, t);
    expect(e.state).toBe('free');
    expect(e.integrity).toBeGreaterThan(0);
    expect(tiltDeg(e)).toBeGreaterThan(80);
    expect(offLineDeg(e, { x: 0, y: 0, z: 1 })).toBeLessThan(2);
    // The runtime joint to the stump is gone with the plant.
    expect(w.physics.rapier.impulseJoints.len()).toBe(joints0);
    expect(w.felling.toRecord()).toEqual([]);
  });

  it('save records: notched and falling trees by id; a record that names no such tree is refused', async () => {
    const w = await make();
    const a = tree30(w);
    const b = tree30(w, { x: 8, z: 0 });
    tree30(w, { x: -8, z: 0 });
    run(w, 3);
    w.felling.chop(a, { x: -1, y: 0, z: 0 }, 0.06, []);
    w.felling.chop(b, { x: 0, y: 0, z: 1 }, 0.3, []);
    run(w, 30);
    const rec = w.felling.toRecord();
    expect(rec.map((r) => [r.tree, r.phase])).toEqual([
      [a, 'notched'],
      [b, 'falling'],
    ]);
    expect(rec[0].fall).toBeNull();
    expect(rec[1].fall).toEqual(ent(w, b).plant!.fall);
    expect(() => w.felling.restoreRecord([{ tree: a, phase: 'falling', fall: rec[1].fall }])).toThrow(/felling\[0\] names tree/);
    w.felling.restoreRecord(rec);
    // The falling trunk's joint to its stump is made again (one revolute for one falling tree).
    expect(w.physics.rapier.impulseJoints.len()).toBe(1);
  });
});
