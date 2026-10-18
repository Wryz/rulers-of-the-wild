// Place (docs/M1-DESIGN.md §5.7; package P17), headless, through commands only: a point-up stake driven into dirt and
// anchored (D-19), free on a boulder; a blunt stick set upright free unless `drive: 1`; which end goes up (D-49: the
// point's within headZoneM, else the heavier end down); upright and lying under an overhang (the casts never start above
// it); lying things on a flat face, a branch across a 2 m trench resting on its ends; the AC-2(a) lean (§11.2(a): a
// 40 kg, 5 m log placed sloped onto a free 2.4 m prop rests on its lower end and the prop's top at 32.9° and stays set
// 120 s awake), a lean from a pit's floor onto its rim (terrain under both), a stake driven sloped; the refusals (no
// second support, overlap, reach, hands); the work action, its step-in and its re-validation at actAt (RF-15);
// releasedBy and credit; the noise of a driven stake.
//
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMAND_STEPS, toCm, type VerbCommand } from '../src/sim/commands';
import { resetTuning } from '../src/tuning/registry';
import { prismRForMass, spawnBox, spawnGrass, spawnLog, spawnStick, spawnStone, spawnTree } from '../src/world/factory';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import type { Anchor, Entity, JointRecord, V3, WorldEvent } from '../src/world/types';
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
  vi.restoreAllMocks();
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
// Which end goes up (D-49): the sharpest point's end (within headZoneM of it), else the heavier end down
// ---------------------------------------------------------------------------

/** A stand-in for P10's joint store (a stub until then): real lash JointRecords, listed on their entities (sorted). */
function standInLashes(w: World): void {
  const recs = new Map<number, JointRecord>();
  vi.spyOn(w.joints, 'get').mockImplementation((id) => recs.get(id));
  vi.spyOn(w.joints, 'all').mockImplementation(() => [...recs.values()].sort((x, y) => x.id - y.id));
  vi.spyOn(w.joints, 'lash').mockImplementation((a: Anchor, b: Anchor, rope, credit) => {
    const id = w.ids.joint.take();
    recs.set(id, { id, kind: 'lash', a, b, rope, breakEnergyJ: Infinity, axis: null, limits: null, motor: null, holdsBend: null, tension: [0, 0, 0], pullN: 0, credit });
    for (const end of [a, b]) {
      const e = end.entity === null ? undefined : w.entities.get(end.entity);
      if (e) e.joints = [...e.joints, id].sort((x, y) => x - y);
    }
    return id;
  });
}

describe('which end goes up (D-49)', () => {
  it('no sharp point: the heavier end goes down; a stick with a stone lashed to either end stands on its stone end', async () => {
    for (const end of [1, -1] as const) {
      const w = await make();
      const p = w.player!;
      standInLashes(w);
      // A 1.2 m stick along x (its local +y at world +x), a blunt 1.5 kg stone lashed just past its `end` end.
      const L = 1.2;
      const id = stick(w, L, 0.03, 2, 2);
      const stone = spawnStone(w, { p: { x: 2 + end * (L / 2 + 0.08), y: 0.12, z: 2 }, mass: 1.5 });
      w.joints.lash({ entity: id, local: { x: 0, y: (end * L) / 2, z: 0 } }, { entity: stone, local: { x: 0, y: 0, z: 0 } }, { entity: 0, lengthM: 1 }, []);
      expect(ent(w, id).sharpPoints).toEqual([]);
      expect(ent(w, stone).sharpPoints).toEqual([]);
      w.step();
      hold(w, id);
      expect(ent(w, stone).state).toBe('held');
      const rel = verbGeom.relative(ent(w, id).pose, ent(w, stone).pose);
      const plan = planPlace(w, p, place(w, { x: 0, y: 0.9, z: 1.2 }, 0, 64, 0));
      const label = `stone at the ${end > 0 ? '+' : '−'} end`;
      expect(plan.ok, label).toBe(true);
      if (!plan.ok) continue;
      // The stone's end is down: the stick's local `end` axis points down, the stone under the stick's centre.
      expect(verbGeom.dirToWorld(plan.plan.pose, { x: 0, y: end, z: 0 }).y, label).toBeLessThan(-0.999);
      expect(verbGeom.compose(plan.plan.pose, rel).p.y, label).toBeLessThan(plan.plan.pose.p.y - L / 2 + 0.01);
      // Blunt: set down free (no drive by default), whatever is lowest on the ground.
      expect(plan.plan.driven, label).toBe(false);
      expect(plan.plan.supports, label).toEqual([{ kind: 'terrain' }]);
    }
  });

  it('a sharp point within headZoneM of an end puts that end up (and drives it); one further in is no point at an end', async () => {
    const L = 1.4;
    for (const inset of [TOOL_TUNING.headZoneM - 0.1, TOOL_TUNING.headZoneM + 0.1]) {
      const w = await make();
      const p = w.player!;
      const id = stick(w, L, 0.04, 2, 2);
      // A point inset from the +y end, leading out of it (as Shape leaves one, but not at the very end).
      ent(w, id).sharpPoints = [{ local: { x: 0, y: L / 2 - inset, z: 0 }, dir: { x: 0, y: 1, z: 0 }, sharpness: 0.6 }];
      w.step();
      hold(w, id);
      const plan = planPlace(w, p, place(w, { x: 0, y: L / 2, z: 1.2 }, 0, 64));
      const within = inset <= TOOL_TUNING.headZoneM;
      const label = `inset ${inset.toFixed(2)} m`;
      expect(plan.ok, label).toBe(true);
      if (!plan.ok) continue;
      // Within: the point's end up, a point-up stake driven into the dirt by default. Beyond: the stick is uniform, so
      // its tie-break end (local −y) goes up and nothing is driven.
      expect(verbGeom.dirToWorld(plan.plan.pose, { x: 0, y: 1, z: 0 }).y, label).toBeCloseTo(within ? 1 : -1, 6);
      expect(plan.plan.driven, label).toBe(within);
    }
  });
});

// ---------------------------------------------------------------------------
// Under an overhang (§5.7 step 4's free prop under a log; rule 3: it goes where its ghost shows)
// ---------------------------------------------------------------------------

describe('under an overhang: the casts start no higher than the room over the commanded pose (rule 3)', () => {
  /** A fixed dry-wood beam across x over (0, z), its underside at `bottom`. */
  const beam = (w: World, z: number, bottom: number): number =>
    spawnBox(w, { p: { x: 0, y: bottom + 0.05, z }, size: [1.2, 0.1, 0.4], material: 'dryWood', state: 'fixed', look: 'box' });

  it('a blunt 0.8 m stick set upright (drive 0) with 0.1-0.45 m of room under a beam stands on the ground under it', async () => {
    for (const room of [0.1, 0.3, 0.45]) {
      const w = await make();
      const p = w.player!;
      const z = 1.2;
      const b = beam(w, z, 0.8 + room);
      const id = stick(w, 0.8, 0.03, 2, 2);
      w.step();
      hold(w, id);
      const label = `room ${room} m`;
      const plan = planPlace(w, p, place(w, { x: 0, y: 0.4, z }, 0, 64, 0));
      expect(plan, label).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'upright', driven: false, supports: [{ kind: 'terrain' }] }) });
      if (!plan.ok) continue;
      // Where it was put, placeDropM up: not on the beam.
      expect(plan.plan.pose.p.y, label).toBeCloseTo(0.4 + VERB_TUNING.placeDropM, 3);
      const evs = untilFree(w);
      expect(verbs(evs, 'place'), label).toEqual([expect.objectContaining({ ok: true, entity: id })]);
      run(w, 30);
      const e = ent(w, id);
      expect(e.state, label).toBe('free');
      expect(Math.abs(axisY(e).y), label).toBeGreaterThan(0.999);
      expect(lowestY(e), label).toBeGreaterThan(-0.005);
      expect(lowestY(e), label).toBeLessThan(0.005);
      // Its top under the beam's underside.
      const under = w.queries.castRay({ x: 0, y: 0.5, z }, { x: 0, y: 1, z: 0 }, 2, { terrain: false, entities: 'all', exclude: { entities: [id] } });
      expect(under?.owner, label).toEqual({ kind: 'entity', id: b });
      expect(e.pose.p.y + 0.4, label).toBeLessThan(under!.point.y);
    }
  });

  it('a stick laid on the ground with 0.1-0.45 m of room under a beam lies on the ground where it was put', async () => {
    const r = 0.03;
    const inradius = r * Math.cos(Math.PI / 8);
    for (const room of [0.1, 0.3, 0.45]) {
      const w = await make();
      const p = w.player!;
      const z = 1.2;
      beam(w, z, 0.06 + r + room);
      const id = stick(w, 1.0, r, 2, 2);
      w.step();
      hold(w, id);
      const label = `room ${room} m`;
      const plan = planPlace(w, p, place(w, { x: 0, y: 0.06, z }, 64, 0));
      expect(plan, label).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'lying', supports: [{ kind: 'terrain' }] }) });
      if (!plan.ok) continue;
      // On a flat face on the ground, placeDropM up (the commanded centre was 0.06 m up): not on the beam.
      expect(plan.plan.pose.p.y, label).toBeCloseTo(inradius + VERB_TUNING.placeDropM, 3);
      expect(verbs(untilFree(w), 'place'), label).toEqual([expect.objectContaining({ ok: true, entity: id })]);
      run(w, 30);
      expect(lowestY(ent(w, id)), label).toBeGreaterThan(-0.005);
      expect(lowestY(ent(w, id)), label).toBeLessThan(0.005);
    }
  });

  it('put up into a beam it is never lifted through onto it: on the ground it is blocked, above the ground it is set down under it; put on the beam it rests there', async () => {
    const w = await make();
    const p = w.player!;
    const r = 0.03;
    const inradius = r * Math.cos(Math.PI / 8);
    const high = beam(w, 1.2, 0.75);
    const low = beam(w, -1.2, 0.25);
    const id = stick(w, 0.8, r, 2, 2);
    w.step();
    hold(w, id);
    // Upright on the ground with its top 0.05 m into the high beam's underside: in the way.
    expect(refusal(w, place(w, { x: 0, y: 0.4, z: 1.2 }, 0, 64, 0))).toBe('blocked');
    // Lying through the low beam's lower half (0.25-0.31 m up): set down where a cast down stops, on the ground under it.
    const under = planPlace(w, p, place(w, { x: 0, y: 0.28, z: -1.2 }, 64, 0));
    expect(under).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'lying', supports: [{ kind: 'terrain' }] }) });
    if (under.ok) expect(under.plan.pose.p.y).toBeCloseTo(inradius + VERB_TUNING.placeDropM, 3);
    // Lying on the high beam's top (0.85 m up): it rests on the beam.
    const on = planPlace(w, p, place(w, { x: 0, y: 0.9, z: 1.2 }, 64, 0));
    expect(on).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'lying', supports: [{ kind: 'entity', id: high }] }) });
    if (on.ok) expect(on.plan.pose.p.y).toBeCloseTo(0.85 + inradius + VERB_TUNING.placeDropM, 3);
    void low;
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

  it('a cover: bearers laid across a trench 0.4 m apart, and a grass bundle laid on two of them rests on them', async () => {
    // AC-2(b)'s cover in small: rotten-wood bearers (r 0.02 m) across a 2 m trench, a 2 kg grass bundle (0.61 m long)
    // laid between two bearers with its ends past them, so that rays from its two ends would pass between them.
    const w = await make();
    const p = w.player!;
    for (let x = -2; x <= 2 + 1e-9; x += 0.25) for (let z = 1.5; z <= 2.5 + 1e-9; z += 0.25) w.terrain.lower(x, z, 20);
    const bearers = [0, 1, 2].map((i) => spawnStick(w, { p: { x: 3 + i * 0.3, y: 0.03, z: -1 }, length: 3, r: 0.02, material: 'rottenWood' }));
    const grass = spawnGrass(w, { p: { x: -3, y: 0.05, z: -1 }, mass: 2 });
    w.step();
    [-0.4, 0, 0.4].forEach((x, i) => {
      hold(w, bearers[i]);
      place(w, { x, y: 0.03, z: 2 }, 0, 0);
      expect(verbs(untilFree(w), 'place'), `bearer ${i}`).toEqual([expect.objectContaining({ ok: true, entity: bearers[i] })]);
    });
    run(w, 30);
    const top = Math.max(...bearers.map((id) => ent(w, id).pose.p.y)) + 0.02;
    const g = ent(w, grass);
    expect(g.shape.kind).toBe('box');
    if (g.shape.kind === 'box') expect(2 * g.shape.hx).toBeGreaterThan(0.6);
    hold(w, grass);
    place(w, { x: 0.2, y: top + 0.05, z: 2 }, 64, 0);
    expect(verbs(untilFree(w), 'place')).toEqual([expect.objectContaining({ ok: true, entity: grass })]);
    run(w, 120);
    // On the bearers, flat, not fallen through.
    expect(lowestY(g)).toBeGreaterThan(top - 0.01);
    expect(lowestY(g)).toBeLessThan(top + 0.01);
    expect(Math.abs(verbGeom.dirToWorld(g.pose, { x: 0, y: 1, z: 0 }).y)).toBeGreaterThan(0.999);
    for (const id of bearers) expect(ent(w, id).pose.p.z).toBeCloseTo(2, 2);
    expect(p.inventory!.hands).toBeNull();
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

  it('the terrain is a support under the body: a log leaned from a pit’s floor onto its rim rests on both (§5.0, rule 3)', async () => {
    for (const x0 of [-2.5, -2, -1.5]) {
      const w = await make(43);
      const p = w.player!;
      // A pit 3 m deep: its floor from x −3.25 to −0.25 (z −0.75 to 0.75), its rim at x = 0.
      for (let x = -3; x <= -0.5 + 1e-9; x += 0.25) for (let z = -0.5; z <= 0.5 + 1e-9; z += 0.25) w.terrain.lower(x, z, 20);
      expect(w.terrain.heightAt(-1, 0)).toBeCloseTo(-3, 6);
      expect(w.terrain.heightAt(0, 0)).toBeCloseTo(0, 6);
      const L = 5;
      const r = prismRForMass(40, L, 550, PHYSICS_TUNING.logFacets);
      const log = spawnLog(w, { p: { x: 3, y: r + 0.01, z: 3 }, length: L, mass: 40 });
      w.step();
      w.teleport(p, 1.4, 0, -Math.PI / 2);
      w.step();
      hold(w, log);
      // The client's estimate: the lower end's underside corner on the floor at x0, the underside through the rim's edge.
      const want = Math.atan2(3, -x0);
      const steps = Math.round((want / (2 * Math.PI)) * COMMAND_STEPS);
      const th = (steps / COMMAND_STEPS) * 2 * Math.PI;
      const rho = r * Math.cos(Math.PI / 6);
      const lowEnd = { x: x0 - rho * Math.sin(th), y: -3 + 0.02 + rho * Math.cos(th), z: 0 };
      const centre = { x: lowEnd.x + (Math.cos(th) * L) / 2, y: lowEnd.y + (Math.sin(th) * L) / 2, z: 0 };
      const label = `lower end at x ${x0}`;
      const plan = planPlace(w, p, place(w, centre, 64, steps));
      expect(plan, label).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'sloped', driven: false, supports: [{ kind: 'terrain' }, { kind: 'terrain' }] }) });
      if (!plan.ok) continue;
      expect(Math.abs(deg(plan.plan.pitch - want)), label).toBeLessThan(0.5);
      const evs = untilFree(w);
      expect(verbs(evs, 'place'), label).toEqual([expect.objectContaining({ ok: true, entity: log })]);
      run(w, 120);
      // It stays leaned: on the floor and the rim, at the angle it was set at.
      const e = ent(w, log);
      expect(e.state, label).toBe('free');
      expect(Math.abs(deg(axisPitch(e) - plan.plan.pitch)), label).toBeLessThan(1);
      expect(lowestY(e), label).toBeGreaterThan(-3.01);
      expect(lowestY(e), label).toBeLessThan(-2.97);
    }
  });

  it('a point-up stake placed sloped on dirt is driven along its axis and anchored, with no second support', async () => {
    const w = await make();
    const p = w.player!;
    const L = 1.4;
    const id = stick(w, L, 0.05, 2, 2, 0.6);
    w.step();
    hold(w, id);
    // 45° up toward +z, its lower end's centre on the ground at (0, 0, 1).
    const th = Math.PI / 4;
    const centre = { x: 0, y: (Math.sin(th) * L) / 2, z: 1 + (Math.cos(th) * L) / 2 };
    const plan = planPlace(w, p, place(w, centre, 0, 32));
    expect(plan).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'sloped', driven: true, stake: id, supports: [{ kind: 'terrain' }] }) });
    const evs = untilFree(w);
    expect(verbs(evs, 'place')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
    const e = ent(w, id);
    expect(e.state).toBe('anchored');
    expect(w.entities.isAnchored(e)).toBe(true);
    // At the commanded 45°, the point up, the lower end stakeAnchorDepthM along the axis past where the axis meets the ground.
    expect(deg(axisPitch(e))).toBeCloseTo(45, 4);
    expect(verbGeom.dirToWorld(e.pose, e.sharpPoints[0].dir).y).toBeCloseTo(Math.SQRT1_2, 6);
    const lower = verbGeom.pointToWorld(e.pose, { x: 0, y: -L / 2, z: 0 });
    const depth = VERB_TUNING.stakeAnchorDepthM;
    expect(lower.y).toBeCloseTo(-depth * Math.sin(th), 3);
    expect(lower.z).toBeCloseTo(1 - depth * Math.cos(th), 3);
    expect(lower.x).toBeCloseTo(0, 3);
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
    // Along z at x = 0 the stick passes through the 120 kg log (along x, to x = 0.5, its top 0.29 m up): put there, it
    // is in the way (not lifted onto the log: rule 3); put on the log's top, it rests across it; put clear of it, on the
    // ground.
    const logTop = w.queries.castRay({ x: 0, y: 3, z: 1.2 }, { x: 0, y: -1, z: 0 }, 5, { terrain: false, entities: 'all' });
    expect(logTop?.owner).toEqual({ kind: 'entity', id: heavy });
    expect(refusal(w, cmdAt({ x: 0, y: 0.1, z: 1 }))).toBe('blocked');
    const across = planPlace(w, p, cmdAt({ x: 0, y: logTop!.point.y + 0.06, z: 1 }));
    expect(across).toEqual({ ok: true, plan: expect.objectContaining({ mode: 'lying', supports: [{ kind: 'entity', id: heavy }] }) });
    expect(refusal(w, cmdAt({ x: 0.9, y: 0.1, z: 1 }))).toBeNull();
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
  });
});
