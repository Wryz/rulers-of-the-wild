// Place (docs/M1-DESIGN.md §5.7; package P17), headless, through commands only: a point-up stake driven into dirt and
// anchored (D-19), free on a boulder; a blunt stick set upright free unless `drive: 1`; lying things on a flat face, a
// branch across a 2 m trench resting on its ends; the AC-2(a) lean (§11.2(a): a 40 kg, 5 m log placed sloped onto a
// free 2.4 m prop rests on its lower end and the prop's top at 32.9° and stays set 120 s awake); the refusals (no second
// support, overlap, reach, hands); the work action, its step-in and its re-validation at actAt (RF-15); releasedBy and
// credit; the noise of a driven stake.
//
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMAND_STEPS, toCm, type VerbCommand } from '../src/sim/commands';
import { resetTuning } from '../src/tuning/registry';
import { prismRForMass, spawnBox, spawnLog, spawnStick, spawnStone, spawnTree } from '../src/world/factory';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import type { Entity, V3, WorldEvent } from '../src/world/types';
import { axisPitch, PLACE_TUNING, planPlace, shrinkShape } from '../src/world/verbs/place';
import { verbGeom } from '../src/world/verbs/tools';
import { TOOL_TUNING, VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';
import { shapeVolume } from '../src/world/shapes';

vi.setConfig({ testTimeout: 180_000 });

const live: World[] = [];
async function make(seed = 41): Promise<World> {
  const w = await createWorld({ seed, scene: 'empty', nav: 'off', size: 60 });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('VERB_TUNING');
  resetTuning('PLACE_TUNING');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type VerbEvent = Extract<WorldEvent, { type: 'verb' }>;

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind' | 'target'> & { target?: number }): VerbCommand {
  const c = { tick: w.tick + 1, player: 1, kind: 'verb', target: 0, ...v } as VerbCommand;
  w.commands.push(c);
  return c;
}

/** n ticks; the world events, copied. */
function run(w: World, n: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < n; t++) out.push(...w.step().world);
  return out;
}

/** Steps until the player is free with nothing buffered (at least one tick); the world events, copied. */
function untilFree(w: World, max = 600): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < max; t++) {
    out.push(...w.step().world);
    const p = w.player!;
    if (p.free && !p.verbRequest) return out;
  }
  throw new Error(`the player was not free within ${max} ticks`);
}

const verbs = (evs: WorldEvent[], name?: VerbCommand['verb']): VerbEvent[] =>
  evs.filter((e): e is VerbEvent => e.type === 'verb' && (!name || e.verb === name));

const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

const deg = (r: number): number => (r * 180) / Math.PI;

/** The world height of an entity's lowest point (its shape's vertices; prisms and hulls are exact). */
function lowestY(e: Entity): number {
  let y = Infinity;
  const pts: number[] = [];
  if (e.shape.kind === 'cylinder') {
    const s = e.shape;
    for (const hy of [-s.halfHeight, s.halfHeight]) for (let k = 0; k < s.sides; k++) {
      const a = ((k + 0.5) * 2 * Math.PI) / s.sides;
      pts.push(s.r * Math.cos(a), hy, s.r * Math.sin(a));
    }
  } else if (e.shape.kind === 'hull') pts.push(...e.shape.points);
  else if (e.shape.kind === 'box') {
    const s = e.shape;
    for (const x of [-s.hx, s.hx]) for (const yy of [-s.hy, s.hy]) for (const z of [-s.hz, s.hz]) pts.push(x, yy, z);
  }
  for (let i = 0; i + 2 < pts.length; i += 3) y = Math.min(y, verbGeom.pointToWorld(e.pose, { x: pts[i], y: pts[i + 1], z: pts[i + 2] }).y);
  return y;
}

/** The world direction of an entity's long (local +y for prisms) axis. */
const axisY = (e: Entity): V3 => verbGeom.dirToWorld(e.pose, { x: 0, y: 1, z: 0 });

/** A dry stick of length × r (8-gon), lying along x on the ground at (x, z), optionally pointed at its +y end. */
function stick(w: World, length: number, r: number, x: number, z: number, sharp?: number): number {
  return spawnStick(w, { p: { x, y: r + 0.01, z }, length, r, sharp: sharp === undefined ? undefined : { end: 1, s: sharp } });
}

/** Puts the entity straight into the player's hands (no take), then steps once so the hands' pose is set. */
function hold(w: World, id: number): void {
  expect(w.verbs.putInHands(w.player!, id)).toBe(true);
  w.step();
}

/** A place command for something whose long-axis centre goes at `at`. */
function place(w: World, at: V3, yawSteps: number, pitchSteps: number, drive?: 0 | 1): VerbCommand {
  return verb(w, drive === undefined ? { verb: 'place', at: toCm(at), yaw: yawSteps, pitch: pitchSteps } : { verb: 'place', at: toCm(at), yaw: yawSteps, pitch: pitchSteps, drive });
}

const refusal = (w: World, cmd: VerbCommand) => {
  const r = planPlace(w, w.player!, cmd);
  return r.ok ? null : r.reason;
};

// ---------------------------------------------------------------------------
// Stakes and the drive decision (§5.7 step 4, D-19)
// ---------------------------------------------------------------------------

describe('upright: stakes driven into soft ground, free otherwise (§5.7 step 4, D-19)', () => {
  it('a point-up stake on dirt is driven 0.3 m and anchored: fixed, 1,200 N, static for m_eff; the bus hears it', async () => {
    const w = await make();
    const p = w.player!;
    const id = stick(w, 1.4, 0.05, 2, 2, 0.6);
    w.step();
    hold(w, id);
    expect(p.weapon?.id).toBe('sharpStick');
    place(w, { x: 0, y: 0.7, z: 1.2 }, 0, 64);
    let start = -1;
    let landed = -1;
    let end = -1;
    let released: Entity['releasedBy'] = null;
    const evs: WorldEvent[] = [];
    for (let t = 0; t < 200 && end < 0; t++) {
      const r = w.step();
      evs.push(...r.world);
      if (start < 0 && p.state === 'pickup') start = w.tick;
      if (landed < 0 && verbs(r.world, 'place').length) {
        landed = w.tick;
        released = ent(w, id).releasedBy ? { ...ent(w, id).releasedBy! } : null;
      }
      if (start >= 0 && p.free) end = w.tick;
    }
    // The driven work action: placeFramesDriven, the stake set down at actFrac of it.
    const frames = VERB_TUNING.placeFramesDriven;
    expect(end - start).toBe(frames);
    expect(landed - start).toBe(Math.round(frames * PLACE_TUNING.actFrac));
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
    const e = ent(w, id);
    expect(e.state).toBe('anchored');
    expect(e.anchor).toEqual({ depthM: VERB_TUNING.stakeAnchorDepthM, capacityN: VERB_TUNING.stakeAnchorDepthM * VERB_TUNING.anchorHoldNPerM });
    expect(e.anchor!.capacityN).toBeCloseTo(1200, 9);
    expect(e.body!.isFixed()).toBe(true);
    expect(w.entities.isAnchored(e)).toBe(true);
    // Upright, point up, its lower end 0.3 m into the ground where it was put.
    expect(axisY(e).y).toBeGreaterThan(0.9999);
    expect(verbGeom.dirToWorld(e.pose, e.sharpPoints[0].dir).y).toBeGreaterThan(0.9999);
    expect(lowestY(e)).toBeCloseTo(-VERB_TUNING.stakeAnchorDepthM, 3);
    expect(e.pose.p.x).toBeCloseTo(0, 3);
    expect(e.pose.p.z).toBeCloseTo(1.2, 3);
    // Out of the hands: released by the player (§4.3; P09 ends the release once they have been apart 2 ticks) and
    // credited (SPEC:186).
    expect(p.inventory!.hands).toBeNull();
    expect(p.weapon).toBeNull();
    expect(released?.fighter).toBe(p.id);
    expect(e.credit).toEqual(['p1']);
    // The noise bus makes stakeDriven of it (P18).
    expect(evs.some((x) => x.type === 'noise' && x.kind === 'stakeDriven')).toBe(true);
    // It stays where it was driven.
    run(w, 120);
    expect(ent(w, id).state).toBe('anchored');
    expect(lowestY(ent(w, id))).toBeCloseTo(-VERB_TUNING.stakeAnchorDepthM, 3);
  });

  it('the same stake set upright on a boulder is placed free (stone is no soft ground), placeDropM above its top', async () => {
    const w = await make();
    const p = w.player!;
    const boulder = spawnStone(w, { p: { x: 0, y: 0.5, z: 1.4 }, mass: 400 });
    const id = stick(w, 1.4, 0.05, 2, 2, 0.6);
    run(w, 90);
    const top = w.queries.castRay({ x: 0, y: 3, z: 1.4 }, { x: 0, y: -1, z: 0 }, 5, { terrain: false, entities: 'all' });
    expect(top?.owner).toEqual({ kind: 'entity', id: boulder });
    const topY = top!.point.y;
    hold(w, id);
    place(w, { x: 0, y: topY + 0.7, z: 1.4 }, 0, 64);
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
    const e = ent(w, id);
    expect(e.state).toBe('free');
    expect(e.anchor).toBeNull();
    expect(e.body!.isDynamic()).toBe(true);
    expect(w.entities.isAnchored(e)).toBe(false);
    expect(evs.some((x) => x.type === 'noise' && x.kind === 'stakeDriven')).toBe(false);
    // Point up, set down on the boulder (it settles the last couple of cm under gravity within the action's rise).
    expect(verbGeom.dirToWorld(e.pose, e.sharpPoints[0].dir).y).toBeGreaterThan(0.99);
    expect(lowestY(e)).toBeGreaterThan(topY - 0.02);
    expect(lowestY(e)).toBeLessThan(topY + VERB_TUNING.placeDropM + 0.005);
  });

  it('a blunt stick set upright stays free (drive absent) and is driven with drive: 1; drive: 0 never drives a point', async () => {
    const cases: { sharp?: number; drive?: 0 | 1; want: 'free' | 'anchored' }[] = [
      { want: 'free' },
      { drive: 1, want: 'anchored' },
      { sharp: 0.6, drive: 0, want: 'free' },
    ];
    for (const c of cases) {
      const w = await make();
      const id = stick(w, 1.4, 0.05, 2, 2, c.sharp);
      w.step();
      hold(w, id);
      place(w, { x: 0, y: 0.7, z: 1.2 }, 0, 64, c.drive);
      const evs = untilFree(w);
      const label = JSON.stringify(c);
      expect(verbs(evs, 'place'), label).toEqual([expect.objectContaining({ ok: true, entity: id })]);
      const e = ent(w, id);
      expect(e.state, label).toBe(c.want);
      expect(Math.abs(axisY(e).y), label).toBeGreaterThan(0.999);
      if (c.want === 'anchored') expect(lowestY(e), label).toBeCloseTo(-VERB_TUNING.stakeAnchorDepthM, 3);
      // Free: set placeDropM up and come to rest on the ground, a prop that a kick or a yank can take out.
      else expect(lowestY(e), label).toBeGreaterThan(-0.01);
    }
  });
});

// ---------------------------------------------------------------------------
// Lying (§5.7 step 2: "lying: from both ends, so a branch spanning a pit rests on its ends")
// ---------------------------------------------------------------------------

describe('lying (§5.7)', () => {
  it('lies on a flat face placeDropM above the ground, along its yaw, where its centre was put', async () => {
    const w = await make();
    const p = w.player!;
    const L = 2.0;
    const r = prismRForMass(12, L, 550, PHYSICS_TUNING.logFacets);
    const id = spawnLog(w, { p: { x: 3, y: r + 0.01, z: 3 }, length: L, mass: 12 });
    w.step();
    hold(w, id);
    // Yaw 32/256 = 45°: along (sin 45°, 0, cos 45°).
    const at = { x: 0.3, y: 0.2, z: 1.4 };
    const cmd = place(w, at, 32, 0);
    const plan = planPlace(w, p, cmd);
    expect(plan.ok).toBe(true);
    let landedAt: { y: number } | null = null;
    let start = -1;
    for (let t = 0; t < 100 && !landedAt; t++) {
      const r2 = w.step();
      if (start < 0 && p.state === 'pickup') start = w.tick;
      if (verbs(r2.world, 'place').length) {
        expect(verbs(r2.world, 'place')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
        expect(w.tick - start).toBe(Math.round(VERB_TUNING.placeFramesLying * PLACE_TUNING.actFrac));
        landedAt = { y: lowestY(ent(w, id)) };
      }
    }
    expect(landedAt).not.toBeNull();
    untilFree(w);
    run(w, 60);
    const e = ent(w, id);
    expect(e.state).toBe('free');
    const ax = axisY(e);
    expect(Math.abs(ax.y)).toBeLessThan(1e-3);
    expect(Math.abs(Math.abs(ax.x) - Math.SQRT1_2)).toBeLessThan(1e-3);
    expect(Math.abs(Math.abs(ax.z) - Math.SQRT1_2)).toBeLessThan(1e-3);
    // A flat face down (local +x, the 6-gon's face normal, points down), resting on the ground.
    expect(verbGeom.dirToWorld(e.pose, { x: 1, y: 0, z: 0 }).y).toBeLessThan(-0.999);
    expect(lowestY(e)).toBeGreaterThan(-0.005);
    expect(lowestY(e)).toBeLessThan(0.005);
    expect(Math.hypot(e.pose.p.x - at.x, e.pose.p.z - at.z)).toBeLessThan(0.01);
    expect(e.restTicks).toBeGreaterThan(0);
  });

  it('a branch across a 2 m trench rests on its ends', async () => {
    const w = await make();
    const p = w.player!;
    // A trench along x, 2 m wide at the top (z 1.0 to 3.0), dug to the 3 m floor in the middle.
    for (let x = -2; x <= 2 + 1e-9; x += 0.25) for (let z = 1.5; z <= 2.5 + 1e-9; z += 0.25) w.terrain.lower(x, z, 20);
    expect(w.terrain.heightAt(0, 2)).toBeLessThan(-2.5);
    expect(w.terrain.heightAt(0, 0.95)).toBeCloseTo(0, 6);
    expect(w.terrain.heightAt(0, 3.05)).toBeCloseTo(0, 6);
    const branch = stick(w, 3, 0.04, 3, -1);
    w.step();
    hold(w, branch);
    // Across the trench along z, its centre over the middle: nothing under it for 2.5 m, the ground under both ends.
    const cmd = place(w, { x: 0, y: 0.1, z: 2 }, 0, 0);
    expect(planPlace(w, p, cmd)).toEqual(expect.objectContaining({ ok: true }));
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: true, entity: branch })]);
    run(w, 120);
    const e = ent(w, branch);
    expect(e.state).toBe('free');
    // Still across it, on its ends, level.
    expect(lowestY(e)).toBeGreaterThan(-0.01);
    expect(lowestY(e)).toBeLessThan(0.01);
    expect(e.pose.p.z).toBeCloseTo(2, 2);
    expect(Math.abs(axisY(e).y)).toBeLessThan(1e-3);
    // Laid along x it would have nothing under it within reach: refused.
    const short = stick(w, 1.2, 0.03, 3, -2);
    w.step();
    w.verbs.letGo(p);
    run(w, 30);
    hold(w, short);
    expect(refusal(w, verb(w, { verb: 'place', at: toCm({ x: 1.0, y: 0.1, z: 2 }), yaw: 64, pitch: 0 }))).toBe('noSupport');
  });
});

// ---------------------------------------------------------------------------
// Sloped: the AC-2(a) lean (§11.2(a))
// ---------------------------------------------------------------------------

/**
 * The AC-2(a) lean: a dry stick r 0.07 m × 2.4 m (a free prop, placed upright with drive 0) at x = propX, then a dry hex
 * log 5 m, 40 kg placed sloped along +x with its lower end's underside corner at the origin. The command carries the
 * quantised pitch nearest `pitchDeg` (the client's estimate); the sim rests it on both supports.
 */
async function lean(propX: number | null, pitchDeg: number): Promise<{ w: World; prop: number | null; log: number; cmd: VerbCommand }> {
  const w = await make(43);
  const p = w.player!;
  let prop: number | null = null;
  if (propX !== null) {
    prop = stick(w, 2.4, 0.07, 5, -3);
    w.step();
    w.teleport(p, propX, -1.2, 0);
    w.step();
    hold(w, prop);
    place(w, { x: propX, y: 1.2, z: 0 }, 0, 64, 0);
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: true, entity: prop })]);
    run(w, 60);
    expect(ent(w, prop).state).toBe('free');
  }
  const L = 5;
  const r = prismRForMass(40, L, 550, PHYSICS_TUNING.logFacets);
  const log = spawnLog(w, { p: { x: 2, y: r + 0.01, z: -3 }, length: L, mass: 40 });
  w.step();
  w.teleport(p, 2.0, -1.2, 0);
  w.step();
  hold(w, log);
  expect(p.inventory!.hands?.mode).toBe('carry');
  const steps = Math.round((pitchDeg / 360) * COMMAND_STEPS);
  const th = (steps / COMMAND_STEPS) * 2 * Math.PI;
  // The command's centre: the lower-end underside corner K at (0, 0.02, 0), the 6-gon's flat face down.
  const rho = r * Math.cos(Math.PI / 6);
  const down = { x: Math.sin(th), y: -Math.cos(th), z: 0 };
  const along = { x: Math.cos(th), y: Math.sin(th), z: 0 };
  const lowEnd = { x: -rho * down.x, y: 0.02 - rho * down.y, z: 0 };
  const centre = { x: lowEnd.x + (along.x * L) / 2, y: lowEnd.y + (along.y * L) / 2, z: 0 };
  const cmd = place(w, centre, 64, steps);
  return { w, prop, log, cmd };
}

describe('sloped (§5.7 step 2, §11.2(a))', () => {
  it('a 40 kg, 5 m log placed sloped onto a free 2.4 m prop rests on its lower end and the prop’s top at 32.9° and stays set 120 s awake', async () => {
    // The prop's near top edge 3.71 m from the lower end: 2.4 m up over 3.71 m is 32.9°, the prop's top 4.4 m along.
    const inradius = 0.07 * Math.cos(Math.PI / 8);
    const { w, prop, log, cmd } = await lean(3.71 + inradius, 32.9);
    const p = w.player!;
    const pe = ent(w, prop!);
    // The prop's real top and near edge (it settled from placeDropM).
    const propTop = w.queries.castRay({ x: pe.pose.p.x, y: 4, z: 0 }, { x: 0, y: -1, z: 0 }, 4, { terrain: false, entities: 'all' })!.point.y;
    expect(propTop).toBeCloseTo(2.4, 2);
    const plan = planPlace(w, p, cmd);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.mode).toBe('sloped');
    expect(plan.plan.supports).toEqual([{ kind: 'terrain' }, { kind: 'entity', id: prop }]);
    // The pitch is the support's, not the command's 23/256 turn (32.34°).
    const expected = Math.atan2(propTop, pe.pose.p.x - inradius);
    expect(Math.abs(deg(plan.plan.pitch - expected))).toBeLessThan(0.3);
    expect(Math.abs(deg(plan.plan.pitch) - 32.9)).toBeLessThan(0.3);
    let released: Entity['releasedBy'] = null;
    const evs: WorldEvent[] = [];
    for (let t = 0; t < 200 && !(p.free && !p.verbRequest && evs.length > 0); t++) {
      const r = w.step();
      evs.push(...r.world);
      if (verbs(r.world, 'place').length) released = ent(w, log).releasedBy ? { ...ent(w, log).releasedBy! } : null;
    }
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: true, entity: log })]);
    const le = ent(w, log);
    expect(le.state).toBe('free');
    expect(released?.fighter).toBe(p.id);
    expect(le.credit).toEqual(['p1']);
    run(w, 30);
    // On its lower end (on the ground) and the prop's top, 4.4 m along.
    const pitch0 = axisPitch(le);
    expect(Math.abs(deg(pitch0) - 32.9)).toBeLessThan(0.5);
    expect(lowestY(le)).toBeGreaterThan(-0.01);
    expect(lowestY(le)).toBeLessThan(0.01);
    // Set 120 s awake (RT-4): the log keeps its angle and the prop stands (tilt < 1°).
    w.entities.keepAwake(log, true);
    w.entities.keepAwake(prop!, true);
    let maxTilt = 0;
    let maxSwing = 0;
    for (let s = 0; s < 120; s++) {
      run(w, 60);
      maxTilt = Math.max(maxTilt, 90 - deg(axisPitch(pe)));
      maxSwing = Math.max(maxSwing, Math.abs(deg(axisPitch(le) - pitch0)));
    }
    console.info(`lean: pitch ${deg(pitch0).toFixed(2)}°, prop tilt ≤ ${maxTilt.toFixed(3)}°, log angle change ≤ ${maxSwing.toFixed(3)}° over 120 s`);
    expect(maxTilt).toBeLessThan(1);
    expect(maxSwing).toBeLessThan(1);
    expect(pe.state).toBe('free');
    expect(le.body!.isSleeping()).toBe(false);
  });

  it('a sloped placement with nothing under its upper half is refused noSupport, and nothing leaves the hands', async () => {
    const { w, log, cmd } = await lean(null, 32.9);
    const p = w.player!;
    expect(refusal(w, cmd)).toBe('noSupport');
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: false, reason: 'noSupport' })]);
    expect(p.inventory!.hands?.entity).toBe(log);
    expect(ent(w, log).state).toBe('held');
  });

  it('a second support nearer the lower end than the centre of mass would see-saw it off: refused noSupport', async () => {
    // A fixed 0.9 m block 1.3 m along: under the lower half of the 5 m log.
    const { w, cmd } = await lean(null, 32.9);
    spawnBox(w, { p: { x: 1.3, y: 0.45, z: 0 }, size: [0.3, 0.9, 0.3], material: 'dryWood', state: 'fixed', look: 'box' });
    w.step();
    const c2 = { ...cmd, pitch: Math.round((34 / 360) * COMMAND_STEPS) };
    expect(refusal(w, c2)).toBe('noSupport');
  });
});

// ---------------------------------------------------------------------------
// Refusals, the work action, re-validation
// ---------------------------------------------------------------------------

describe('refusals (§5.7 steps 1-3, §5.0)', () => {
  it('an overlapping place is refused blocked: through a standing trunk, through the player’s own body', async () => {
    const w = await make();
    const p = w.player!;
    spawnTree(w, { at: { x: 0, z: 1.6 }, diameter: 0.3, height: 8 });
    const id = stick(w, 2, 0.03, 3, 3);
    w.step();
    hold(w, id);
    // Lying across the trunk.
    const through = place(w, { x: 0, y: 0.05, z: 1.6 }, 64, 0);
    expect(refusal(w, through)).toBe('blocked');
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: false, reason: 'blocked' })]);
    expect(p.inventory!.hands?.entity).toBe(id);
    // Lying across the player's own feet.
    expect(refusal(w, place(w, { x: p.pos.x, y: 0.05, z: p.pos.z }, 64, 0))).toBe('blocked');
    untilFree(w);
    // Upright inside the trunk.
    expect(refusal(w, place(w, { x: 0, y: 1, z: 1.6 }, 0, 64))).toBe('blocked');
    untilFree(w);
    // Beside it, clear: placed.
    place(w, { x: 0, y: 0.05, z: 0.9 }, 64, 0);
    expect(verbs(untilFree(w), 'place')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
  });

  it('out of reach, empty hands, a dragged load and a malformed command are refused with no effect', async () => {
    const w = await make();
    const p = w.player!;
    const id = stick(w, 1, 0.03, 0.5, 1.0);
    const heavy = spawnLog(w, { p: { x: -1, y: 0.2, z: 1.2 }, length: 3, mass: 120 });
    w.step();
    const cmdAt = (at: V3, yaw = 0, pitch = 0) => ({ tick: 0, player: 1, kind: 'verb', verb: 'place', target: 0, at: toCm(at), yaw, pitch }) as VerbCommand;
    expect(refusal(w, cmdAt({ x: 0, y: 0.1, z: 1 }))).toBe('handsEmpty');
    hold(w, id);
    // Beyond placeReachM horizontally, beyond placeReachVertM vertically.
    expect(refusal(w, cmdAt({ x: 0, y: 0.1, z: 3.6 }))).toBe('outOfReach');
    expect(refusal(w, cmdAt({ x: 0, y: 3.4, z: 1 }))).toBe('outOfReach');
    // A pitch beyond upright, no point.
    expect(refusal(w, { ...cmdAt({ x: 0, y: 0.1, z: 1 }), pitch: 65 })).toBe('noTarget');
    const noAt = cmdAt({ x: 0, y: 0.1, z: 1 });
    delete noAt.at;
    expect(refusal(w, noAt)).toBe('noTarget');
    expect(refusal(w, cmdAt({ x: 0, y: 0.1, z: 1 }))).toBeNull();
    // In the air with nothing under it within reach: refused.
    expect(refusal(w, cmdAt({ x: 0, y: 1.4, z: 1 }))).toBe('noSupport');
    verb(w, { verb: 'place', at: toCm({ x: 0, y: 0.1, z: 3.6 }), yaw: 0, pitch: 0 });
    expect(verbs(untilFree(w), 'place')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfReach' })]);
    expect(p.inventory!.hands?.entity).toBe(id);
    expect(ent(w, id).state).toBe('held');
    // Dragging.
    w.verbs.letGo(p);
    run(w, 30);
    expect(w.verbs.putInHands(p, heavy)).toBe(true);
    expect(p.inventory!.hands?.mode).toBe('drag');
    expect(refusal(w, cmdAt({ x: 0, y: 0.1, z: 1 }))).toBe('dragging');
  });
});

describe('the work action (§5.7 step 5, §5.0)', () => {
  it('the player turns to and steps in toward the placed shape; something put in the way before actAt refuses it there, with no effect', async () => {
    const w = await make();
    const p = w.player!;
    const id = stick(w, 1.2, 0.03, 3, 3);
    w.step();
    hold(w, id);
    w.teleport(p, 0, 0, Math.PI / 2);
    w.step();
    // 2 m ahead along +z (the player faces +x): it turns toward it and steps in.
    place(w, { x: 0, y: 0.1, z: 2.0 }, 64, 0);
    run(w, 4);
    expect(p.work?.kind).toBe('place');
    // A crate dropped where it goes, before the stick is set down.
    spawnBox(w, { p: { x: 0, y: 0.3, z: 2.0 }, size: [0.5, 0.6, 0.5], material: 'dryWood', state: 'fixed', look: 'box' });
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: false, reason: 'blocked' })]);
    expect(p.inventory!.hands?.entity).toBe(id);
    expect(ent(w, id).state).toBe('held');
    expect(ent(w, id).releasedBy).toBeNull();
    // It stepped toward it and turned to face it.
    expect(p.pos.z).toBeGreaterThan(0.3);
    expect(Math.abs(Math.sin(p.yaw))).toBeLessThan(0.5);
  });

  it('shrinkShape takes placeShrinkM off every half-extent (and a hull toward its centroid)', () => {
    const s = 0.02;
    expect(shrinkShape({ kind: 'cylinder', halfHeight: 1, r: 0.1, sides: 8 }, s)).toEqual({ kind: 'cylinder', halfHeight: 0.98, r: 0.08, sides: 8 });
    expect(shrinkShape({ kind: 'box', hx: 0.5, hy: 0.25, hz: 0.1 }, s)).toEqual({ kind: 'box', hx: 0.48, hy: 0.23, hz: 0.08 });
    const hull = { kind: 'hull' as const, points: [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1] };
    expect(shapeVolume(shrinkShape(hull, s))).toBeLessThan(shapeVolume(hull));
    expect(TOOL_TUNING.headZoneM).toBeGreaterThan(0);
  });
});
