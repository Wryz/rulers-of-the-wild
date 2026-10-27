// Hands, belt and back, and the verb system's machinery (docs/M1-DESIGN.md §5.0, §5.1, §5.2 focus, §5.13; package
// P14), headless, through commands only: take (wield, carry, drag, a rope end; the walk-in and the hands' reach at
// actAt; two-handed tools and a severed left forearm), drop (in any state), stow, draw; the 40 / 150 kg limits; the drag
// lab as a test ([B lab: drag.ts]: 150 kg at ≥ 1.5 m/s with 600 N, 300 kg < 0.05 m/s); belt and back
// limits; forced releases on knockdown and KO; a hit cancelling a work action; re-validation at start and at actAt
// (RF-15); credit; the focus and verbAim; the radial's options; the system's save record.
//
// The joint store is P10's (a stub until then): the rope-end test uses a stand-in that keeps real JointRecords.
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fistPoint } from '../src/body/skeleton';
import { moveCommand, toCm, type VerbCommand } from '../src/sim/commands';
import { Fighter } from '../src/sim/fighter';
import { PLAYER_MOVES } from '../src/sim/moves';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { groundRestY, logPrism, LYING_ALONG_X, prismRForMass, spawnBox, spawnLog, spawnRopeCoil, spawnStarterAxe, spawnStick, spawnStone, spawnTree } from '../src/world/factory';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import type { Anchor, JointRecord, RefuseReason, V3, WorldEvent } from '../src/world/types';
import { type VerbStateRecord } from '../src/world/verbs/index';
import { chestPoint, validateVerb, type VerbHandler, verbsFor, withVerbHandler } from '../src/world/verbs/targets';
import { heldMembers, verbGeom } from '../src/world/verbs/tools';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
async function make(seed = 21): Promise<World> {
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
  resetTuning('TOOL_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type VerbEvent = Extract<WorldEvent, { type: 'verb' }>;

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): VerbCommand {
  const c = { tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand;
  w.commands.push(c);
  return c;
}

/** n ticks; the world events, copied. */
function run(w: World, n: number, each?: (t: number) => void): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < n; t++) {
    each?.(t);
    out.push(...w.step().world);
  }
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

const ent = (w: World, id: number) => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

/** A dry 6-gon log of `massKg`, `length` m along x, resting on the terrain centred at (x, z). */
function log(w: World, massKg: number, length: number, x: number, z: number): number {
  const shape = logPrism(length, prismRForMass(massKg, length, 550, PHYSICS_TUNING.logFacets));
  return spawnLog(w, { p: { x, y: groundRestY(w, x, z, shape, LYING_ALONG_X), z }, length, mass: massKg });
}

/** A dry 8-gon stick along x resting on the terrain at (x, z). */
function stick(w: World, length: number, r: number, x: number, z: number, sharp?: { end: 1 | -1; s: number }): number {
  return spawnStick(w, { p: { x, y: r + 0.01, z }, length, r, sharp });
}

/** A stand-in for P10's joint store: real JointRecords for lash, rope, holdEnd and dropEnd, listed on their entities. */
function standInJoints(w: World): Map<number, JointRecord> {
  const recs = new Map<number, JointRecord>();
  const make = (kind: JointRecord['kind'], a: Anchor, b: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): number => {
    const id = w.ids.joint.take();
    recs.set(id, { id, kind, a, b, rope, breakEnergyJ: Infinity, axis: null, limits: null, motor: null, holdsBend: null, tension: [0, 0, 0], pullN: 0, credit });
    for (const end of [a, b]) {
      const e = end.entity === null ? undefined : w.entities.get(end.entity);
      if (e) e.joints = [...e.joints, id].sort((x, y) => x - y);
    }
    return id;
  };
  vi.spyOn(w.joints, 'get').mockImplementation((id) => recs.get(id));
  vi.spyOn(w.joints, 'all').mockImplementation(() => [...recs.values()].sort((x, y) => x.id - y.id));
  vi.spyOn(w.joints, 'lash').mockImplementation((a, b, rope, credit) => make('lash', a, b, rope, credit));
  vi.spyOn(w.joints, 'rope').mockImplementation((a, b, _len, rope, credit) => make('rope', a, b, rope, credit));
  vi.spyOn(w.joints, 'holdEnd').mockImplementation((j, end, fighter) => {
    const r = recs.get(j)!;
    r[end] = { entity: null, local: { ...r[end].local }, fighter };
  });
  vi.spyOn(w.joints, 'dropEnd').mockImplementation((j, at) => {
    const r = recs.get(j)!;
    const end = r.a.fighter !== undefined ? 'a' : 'b';
    r[end] = { entity: null, local: { x: at.x, y: at.y, z: at.z }, loose: true };
  });
  return recs;
}

const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------------------
// Take and the mass limits
// ---------------------------------------------------------------------------

describe('take (§5.1): wield, carry, drag, or refused', () => {
  it('40 kg is carried, 41 kg dragged, 151 kg refused tooHeavy', async () => {
    for (const [m, want] of [
      [40, 'carry'],
      [41, 'drag'],
      [151, null],
    ] as const) {
      const w = await make();
      const p = w.player!;
      const id = log(w, m, m > 100 ? 3.6 : 2.2, 0, 1.2);
      w.step();
      verb(w, { verb: 'take', target: id });
      const evs = untilFree(w);
      const e = ent(w, id);
      if (want === null) {
        expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'tooHeavy' })]);
        expect(p.inventory!.hands).toBeNull();
        expect(e.state).toBe('free');
        continue;
      }
      expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
      expect(p.inventory!.hands?.mode).toBe(want);
      expect(p.load?.mode).toBe(want);
      expect(p.load?.massKg).toBeCloseTo(m, 6);
      expect(p.weapon).toBeNull();
      expect(e.state).toBe(want === 'carry' ? 'held' : 'free');
      expect(p.posture?.id).toBe(want === 'carry' ? 'carryShoulder' : 'dragBack');
    }
  });

  it('a take is a work action of 18 + 0.8·m frames whose hands close half-way, turning and stepping in to it', async () => {
    const w = await make();
    const p = w.player!;
    const id = log(w, 20, 2.2, 0, 1.4);
    w.step();
    verb(w, { verb: 'take', target: id });
    let start = -1;
    let landed = -1;
    let end = -1;
    for (let t = 0; t < 200 && end < 0; t++) {
      const r = w.step();
      if (start < 0 && p.state === 'pickup') start = w.tick;
      if (landed < 0 && verbs(r.world, 'take').some((e) => e.ok)) landed = w.tick;
      if (start >= 0 && p.free) end = w.tick;
    }
    const frames = Math.round(VERB_TUNING.takeFramesBase + VERB_TUNING.takeFramesPerKg * 20);
    expect(end - start).toBe(frames);
    expect(landed - start).toBe(Math.round(frames * VERB_TUNING.takeGrabFrac));
    // It stepped in toward the log's near face.
    expect(p.pos.z).toBeGreaterThan(0.2);
  });

  it('a rooted tree, a fixed box and a driven stake are immovable, what is in the hands is taken already; out of range is refused before it starts', async () => {
    const w = await make();
    const p = w.player!;
    const tree = spawnTree(w, { at: { x: 0, z: 1.2 }, diameter: 0.3, height: 10 }).tree;
    const box = spawnBox(w, { p: { x: -1, y: 0.5, z: 0.8 }, size: [0.5, 1, 0.5], material: 'dryWood', state: 'fixed', look: 'box' });
    const stake = spawnLog(w, { p: { x: 1, y: 0.4, z: 0.8 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1, r: 0.05, state: 'anchored' });
    const near = stick(w, 1, 0.02, 0.4, 0.6);
    const far = stick(w, 1, 0.02, 0, 6);
    w.step();
    const take = (target: number) => validateVerb(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'take', target });
    expect(take(tree)).toEqual({ ok: false, reason: 'immovable' });
    expect(take(box)).toEqual({ ok: false, reason: 'immovable' });
    expect(take(stake)).toEqual({ ok: false, reason: 'immovable' });
    expect(take(near)).toEqual({ ok: true });
    verb(w, { verb: 'take', target: near });
    untilFree(w);
    expect(take(near)).toEqual({ ok: false, reason: 'handsFull' });
    verb(w, { verb: 'drop', target: 0 });
    untilFree(w);
    expect(validateVerb(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'take', target: far })).toEqual({ ok: false, reason: 'outOfRange' });
    expect(validateVerb(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'take', target: 9999 })).toEqual({ ok: false, reason: 'noTarget' });
    // A verb whose module hasn't registered yet (P15-P17) is refused, never thrown.
    const lash = validateVerb(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'lash', target: tree, second: far });
    expect(lash.ok).toBe(false);
    verb(w, { verb: 'take', target: far });
    const evs = untilFree(w);
    expect(verbs(evs)).toEqual([expect.objectContaining({ verb: 'take', ok: false, reason: 'outOfRange' })]);
    expect(p.state).not.toBe('pickup');
  });

  it('a far take walks in to standOffM before the hands close, which they do only within the hands’ reach (§5.0, rule 3)', async () => {
    // A 1 m stick lying across the way at 1.6, 2.0 and 2.2 m: in range (2.5 m from the chest), out of the bend's own
    // step-in. The player walks to it, then bends: the hands close within takeReachM of the feet.
    for (const z of [1.6, 2.0, 2.2]) {
      const w = await make();
      const p = w.player!;
      const id = stick(w, 1, 0.02, 0, z);
      w.step();
      const z0 = p.pos.z;
      verb(w, { verb: 'take', target: id });
      let start = -1;
      let landed = -1;
      let gap = Infinity;
      for (let t = 0; t < 200 && landed < 0; t++) {
        const r = w.step();
        if (start < 0 && p.state === 'pickup') start = w.tick;
        if (verbs(r.world, 'take').length) {
          expect(verbs(r.world, 'take'), `z ${z}`).toEqual([expect.objectContaining({ ok: true, entity: id })]);
          landed = w.tick;
          gap = z - 0.02 - p.pos.z;
        }
      }
      untilFree(w);
      expect(p.inventory!.hands?.entity, `z ${z}`).toBe(id);
      // It walked in, and the hands closed in their reach (DS's 0.85 m grab reach), near the stand-off.
      expect(p.pos.z - z0, `z ${z}`).toBeGreaterThan(z - 0.02 - z0 - VERB_TUNING.takeReachM);
      expect(gap, `z ${z}`).toBeLessThanOrEqual(VERB_TUNING.takeReachM);
      expect(gap, `z ${z}`).toBeLessThanOrEqual(VERB_TUNING.standOffM + 0.05);
      // The walk came before the bend: the hands closed later than a near take's would.
      const base = Math.round(VERB_TUNING.takeFramesBase + VERB_TUNING.takeFramesPerKg * ent(w, id).mass);
      expect(landed - start, `z ${z}`).toBeGreaterThan(Math.round(base * VERB_TUNING.takeGrabFrac));
    }
  });

  it('a take whose target is still out of the hands’ reach at actAt is refused outOfReach with no effect', async () => {
    // Moved during the work action from 1.2 m to 2.1 m ahead: still in range (2.5 m from the chest), out of reach.
    const w = await make();
    const p = w.player!;
    const id = stick(w, 1, 0.02, 0, 1.2);
    w.step();
    verb(w, { verb: 'take', target: id });
    run(w, 4);
    expect(p.work?.kind).toBe('take');
    const e = ent(w, id);
    w.entities.setPose(e, { p: { x: 0, y: e.pose.p.y, z: 2.1 }, q: e.pose.q });
    const evs = untilFree(w);
    expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfReach' })]);
    expect(p.inventory!.hands).toBeNull();
    expect(p.weapon).toBeNull();
    expect(e.state).toBe('free');
    expect(e.credit).toEqual([]);
    expect(e.releasedBy).toBeFalsy();

    // Above the reach of a standing player's hands (a stick laid across two fixed 2.6 m posts in front, either side of
    // the way): refused the same way. The posts stand clear of the bend on purpose: under a block, the take's step-in
    // and bend swing the head into the block's face at ~6.2 m/s, past a human's 6 m/s v_safe, and that self-motion
    // contact is a real hit (§4.3, SPEC:284) whose hitstun cancels the take before actAt with no event (§4.4, §5.0).
    const w2 = await make(23);
    const p2 = w2.player!;
    for (const x of [-0.7, 0.7]) spawnBox(w2, { p: { x, y: 1.3, z: 1.0 }, size: [0.2, 2.6, 0.3], material: 'dryWood', state: 'fixed', look: 'box' });
    const high = spawnStick(w2, { p: { x: 0, y: 2.63, z: 1.0 }, length: 1.8, r: 0.02 });
    run(w2, 10);
    expect(ent(w2, high).pose.p.y).toBeGreaterThan(2.5);
    expect(validateVerb(w2, p2, { tick: 0, player: 1, kind: 'verb', verb: 'take', target: high })).toEqual({ ok: true });
    verb(w2, { verb: 'take', target: high });
    const evs2 = untilFree(w2);
    expect(verbs(evs2, 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfReach' })]);
    // Nothing touched the player on the way in, and it was the height that refused it: where the player stood at actAt
    // (it doesn't step after), the stick was within the feet's reach but above the hands'.
    expect(evs2.filter((e) => e.type === 'impact' && e.defender === p2)).toEqual([]);
    expect(p2.hp).toBe(100);
    const reachedFor = w2.queries.projectPoint(high, chestPoint(p2)).point;
    expect(hdist(p2.pos, reachedFor)).toBeLessThanOrEqual(VERB_TUNING.takeReachM);
    expect(reachedFor.y - chestPoint(p2).y).toBeGreaterThan(VERB_TUNING.handReachM);
    expect(p2.inventory!.hands).toBeNull();
    expect(ent(w2, high).state).toBe('free');
    expect(ent(w2, high).credit).toEqual([]);
  });

  it('a two-handed tool can’t be wielded or drawn with the left forearm severed (DS tryPickup); a one-handed one can', async () => {
    const w = await make();
    const p = w.player!;
    const twoHand = stick(w, 1, 0.02, -0.4, 1.0);
    const oneHand = spawnStone(w, { p: { x: 0.4, y: 0.15, z: 1.0 }, mass: 1 });
    w.step();
    const take = (target: number) => validateVerb(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'take', target });
    expect(take(twoHand)).toEqual({ ok: true });
    // On the back while both arms are on; then the left forearm goes.
    verb(w, { verb: 'take', target: twoHand });
    untilFree(w);
    expect(p.weapon?.style).toBe('twoHand');
    verb(w, { verb: 'stow', target: 0, slot: 3 });
    untilFree(w);
    expect(p.inventory!.back).toBe(twoHand);
    p.severed.add('foreArmL');
    verb(w, { verb: 'draw', target: 0, slot: 3 });
    expect(verbs(untilFree(w), 'draw')).toEqual([expect.objectContaining({ ok: false, reason: 'cantAct' })]);
    expect(p.inventory!.back).toBe(twoHand);
    expect(p.inventory!.hands).toBeNull();
    // A stick on the ground: refused; a stone (one-handed): wielded.
    const loose = stick(w, 1, 0.02, 0, 1.4);
    w.step();
    expect(take(loose)).toEqual({ ok: false, reason: 'cantAct' });
    expect(take(oneHand)).toEqual({ ok: true });
    verb(w, { verb: 'take', target: oneHand });
    untilFree(w);
    expect(p.weapon?.id).toBe('stone');
    expect(p.weapon?.style).toBe('oneHand');
  });
});

// ---------------------------------------------------------------------------
// Drag (§5.1, [B lab: drag.ts])
// ---------------------------------------------------------------------------

describe('drag (§5.1): the B lab as a test', () => {
  /**
   * Takes a `massKg` 3.6 m dry log by its +x end and walks +x for 6 s: the log's mean speed over seconds 1-6.
   * P28 fifth pass (C F3 departure: the drag is an in-solver force): the run starts at (−18, −6), inside one terrain
   * tile, not at the origin. From there the log crossed the heightfield tiles' seam at x = 0 lying along the seam at
   * z = 0, and with the pull in the solver it stuck on the next tile's first edge (600 N, 0 m/s; the pre-step impulse
   * hopped it). The tiles' seam is a sim issue of its own (docs/work/ledger.md).
   */
  async function drag(massKg: number): Promise<{ speed: number; maxGap: number; moved: number }> {
    const w = await make(31);
    const p = w.player!;
    const X0 = -18;
    const Z0 = -6;
    w.teleport(p, X0, Z0, -Math.PI / 2);
    const L = 3.6;
    const id = log(w, massKg, L, X0 - 0.8 - L / 2, Z0);
    w.step();
    verb(w, { verb: 'take', target: id });
    untilFree(w);
    expect(p.inventory!.hands?.mode).toBe('drag');
    const x0 = ent(w, id).pose.p.x;
    let x1 = 0;
    let maxGap = 0;
    run(w, 360, (t) => {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      if (t === 60) x1 = ent(w, id).pose.p.x;
      const h = p.inventory!.hands!;
      const g = verbGeom.pointToWorld(ent(w, id).pose, h.grip);
      if (t > 0) maxGap = Math.max(maxGap, hdist(p.pos, g));
    });
    const x2 = ent(w, id).pose.p.x;
    return { speed: (x2 - x1) / 5, maxGap, moved: x2 - x0 };
  }

  it('150 kg follows at ≥ 1.5 m/s with the 600 N pull and a half-weight lift, the player tethered within 1.6 m', async () => {
    const r = await drag(150);
    console.info(`drag 150 kg: ${r.speed.toFixed(2)} m/s, moved ${r.moved.toFixed(2)} m, max gap ${r.maxGap.toFixed(3)} m`);
    expect(r.speed).toBeGreaterThanOrEqual(1.5);
    expect(r.maxGap).toBeLessThanOrEqual(VERB_TUNING.tetherM + 0.05);
  });

  it('300 kg (the limit raised for the test) hardly moves: the 600 N pull is a felt limit (< 0.05 m/s)', async () => {
    setTuningValue('VERB_TUNING', 'dragMaxKg', 300);
    const r = await drag(300);
    console.info(`drag 300 kg: ${r.speed.toFixed(3)} m/s, moved ${r.moved.toFixed(3)} m, max gap ${r.maxGap.toFixed(3)} m`);
    expect(Math.abs(r.speed)).toBeLessThan(0.05);
    expect(r.maxGap).toBeLessThanOrEqual(VERB_TUNING.tetherM + 0.05);
  });
});

// ---------------------------------------------------------------------------
// Wield, drop, swap, stow, draw
// ---------------------------------------------------------------------------

describe('wield and drop (§5.1, §5.2)', () => {
  it('the starter axe is wielded: its WeaponDef, both members held and following the fist; dropped, it leaves with walkVel + vel', async () => {
    const w = await make();
    const p = w.player!;
    standInJoints(w);
    const axe = spawnStarterAxe(w, { x: 0, y: w.terrain.heightAt(0, 1), z: 1 });
    w.step();
    verb(w, { verb: 'take', target: axe.stick });
    untilFree(w);
    const h = p.inventory!.hands!;
    expect(h.mode).toBe('wield');
    expect(h.entity).toBe(axe.stick);
    expect(heldMembers(w, h.entity)).toEqual([axe.stick, axe.head]);
    expect(p.weapon?.id).toBe('stoneAxe');
    expect(p.weapon?.mass).toBeCloseTo(1.153, 3);
    expect(p.load).toBeNull();
    expect(h.twoHanded).toBe(false);
    for (const id of [axe.stick, axe.head]) {
      expect(ent(w, id).state).toBe('held');
      expect(ent(w, id).credit).toEqual(['p1']);
    }
    // The grip sits in the right fist (phase 4b, after this tick's pose).
    run(w, 3);
    const fist = fistPoint(p.rig, 'R', new Vector3());
    const grip = verbGeom.pointToWorld(ent(w, axe.stick).pose, h.grip);
    expect(verbGeom.len(verbGeom.sub(grip, fist))).toBeLessThan(1e-6);
    // The flint keeps its place on the handle.
    const rel0 = verbGeom.relative(ent(w, axe.stick).pose, ent(w, axe.head).pose);
    run(w, 10, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, 1)));
    const rel1 = verbGeom.relative(ent(w, axe.stick).pose, ent(w, axe.head).pose);
    expect(verbGeom.len(verbGeom.sub(rel0.p, rel1.p))).toBeLessThan(1e-9);

    // Dropped while walking: the same velocity, released by the player.
    w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
    verb(w, { verb: 'drop', target: 0 });
    let v: V3 | null = null;
    const evs = run(w, 1, () => undefined);
    const stickE = ent(w, axe.stick);
    expect(verbs(evs, 'drop')).toEqual([expect.objectContaining({ ok: true, entity: axe.stick })]);
    expect(p.inventory!.hands).toBeNull();
    expect(p.weapon).toBeNull();
    expect(stickE.state).toBe('free');
    expect(ent(w, axe.head).state).toBe('free');
    expect(stickE.releasedBy).toEqual({ fighter: p.id, apartTicks: expect.any(Number) });
    v = stickE.vel.lin;
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(0.5);
    // A drop while free is a short committed action.
    expect(p.state).toBe('pickup');
  });

  it('drop works in any state: during hitstun the hands empty on the next tick, with no work action while not free', async () => {
    for (const what of ['wield', 'carry'] as const) {
      const w = await make();
      const p = w.player!;
      const id = what === 'wield' ? stick(w, 1, 0.02, 0, 1.2) : log(w, 20, 2.2, 0, 1.2);
      w.step();
      verb(w, { verb: 'take', target: id });
      untilFree(w);
      expect(p.inventory!.hands?.mode).toBe(what);
      p.enterHitstun(30, 'hitHigh');
      expect(p.free).toBe(false);
      verb(w, { verb: 'drop', target: 0 });
      const evs = run(w, 1);
      expect(verbs(evs, 'drop'), what).toEqual([expect.objectContaining({ ok: true, entity: id })]);
      expect(p.inventory!.hands, what).toBeNull();
      expect(p.weapon).toBeNull();
      expect(p.load).toBeNull();
      expect(ent(w, id).state, what).toBe('free');
      expect(ent(w, id).releasedBy?.fighter, what).toBe(p.id);
      expect(p.verbRequest).toBeNull();
      // Still in hitstun: no drop action started, then or once the hitstun is over.
      expect(p.state).toBe('hitstun');
      expect(p.work).toBeNull();
      const states = new Set<string>();
      for (let t = 0; t < 40; t++) {
        w.step();
        states.add(p.state);
      }
      expect([...states], what).not.toContain('pickup');
    }
  });

  it('taking with a tool in hand swaps it: the old tool comes down where the new one lay', async () => {
    const w = await make();
    const p = w.player!;
    const a = stick(w, 1.0, 0.02, -0.6, 1.2);
    const b = stick(w, 1.2, 0.02, 0.6, 1.2, { end: 1, s: 0.5 });
    w.step();
    verb(w, { verb: 'take', target: a });
    untilFree(w);
    expect(p.weapon?.id).toBe('stick');
    const bAt = { ...ent(w, b).pose.p };
    verb(w, { verb: 'take', target: b });
    untilFree(w);
    expect(p.inventory!.hands?.entity).toBe(b);
    expect(p.weapon?.id).toBe('sharpStick');
    expect(ent(w, a).state).toBe('free');
    expect(hdist(ent(w, a).pose.p, bAt)).toBeLessThan(0.3);
  });

  it('stow and draw: the belt takes ≤ 4 kg and ≤ 0.6 m (or a coil ≤ 4 kg), the back a tool or a bundle ≤ 40 kg', async () => {
    const w = await make();
    const p = w.player!;
    const inv = p.inventory!;
    const short = stick(w, 0.5, 0.02, -0.5, 1.0);
    const long = stick(w, 0.9, 0.02, 0.5, 1.0);
    const rock = spawnStone(w, { p: { x: -0.4, y: 0.2, z: 1.6 }, mass: 5 });
    const coil = spawnRopeCoil(w, { at: { x: 0.6, y: 0, z: 1.8 }, material: 'vine', lengthM: 20 });
    w.step();
    const stow = (slot: number) => {
      verb(w, { verb: 'stow', target: 0, slot });
      return verbs(untilFree(w), 'stow');
    };
    const take = (id: number) => {
      verb(w, { verb: 'take', target: id });
      untilFree(w);
      expect(inv.hands?.entity).toBe(id);
    };
    // Nothing in the hands.
    expect(stow(0)).toEqual([expect.objectContaining({ ok: false, reason: 'handsEmpty' })]);
    take(short);
    expect(stow(0)).toEqual([expect.objectContaining({ ok: true, entity: short })]);
    expect(inv.belt[0]).toBe(short);
    expect(inv.hands).toBeNull();
    expect(ent(w, short).state).toBe('stowed');
    expect(ent(w, short).body).toBeNull();
    expect(p.weapon).toBeNull();
    take(long);
    expect(stow(1)).toEqual([expect.objectContaining({ ok: false, reason: 'tooLong' })]);
    expect(stow(0)).toEqual([expect.objectContaining({ ok: false, reason: 'slotFull' })]);
    expect(stow(3)).toEqual([expect.objectContaining({ ok: true, entity: long })]);
    expect(inv.back).toBe(long);
    take(rock);
    expect(stow(1)).toEqual([expect.objectContaining({ ok: false, reason: 'tooHeavy' })]);
    expect(stow(3)).toEqual([expect.objectContaining({ ok: false, reason: 'slotFull' })]);
    // Draw needs empty hands.
    verb(w, { verb: 'draw', target: 0, slot: 0 });
    expect(verbs(untilFree(w), 'draw')).toEqual([expect.objectContaining({ ok: false, reason: 'handsFull' })]);
    verb(w, { verb: 'drop', target: 0 });
    untilFree(w);
    take(coil);
    expect(ent(w, coil).mass).toBeLessThanOrEqual(VERB_TUNING.beltMaxKg);
    expect(stow(1)).toEqual([expect.objectContaining({ ok: true, entity: coil })]);
    expect(inv.belt).toEqual([short, coil, null]);
    // Draw from the back: a tool, wielded again.
    verb(w, { verb: 'draw', target: 0, slot: 3 });
    expect(verbs(untilFree(w), 'draw')).toEqual([expect.objectContaining({ ok: true, entity: long })]);
    expect(inv.back).toBeNull();
    expect(inv.hands?.mode).toBe('wield');
    expect(ent(w, long).state).toBe('held');
    expect(p.weapon?.id).toBe('stick');
    verb(w, { verb: 'draw', target: 0, slot: 2 });
    expect(verbs(untilFree(w), 'draw')).toEqual([expect.objectContaining({ ok: false, reason: 'handsFull' })]);
    verb(w, { verb: 'drop', target: 0 });
    untilFree(w);
    verb(w, { verb: 'draw', target: 0, slot: 2 });
    expect(verbs(untilFree(w), 'draw')).toEqual([expect.objectContaining({ ok: false, reason: 'slotEmpty' })]);
  });

  it('the back refuses what is neither a tool nor a bundle of elongated things', async () => {
    const w = await make();
    const p = w.player!;
    const rock = spawnStone(w, { p: { x: 0, y: 0.2, z: 1.2 }, mass: 5 });
    w.step();
    verb(w, { verb: 'take', target: rock });
    untilFree(w);
    expect(p.inventory!.hands?.mode).toBe('carry');
    verb(w, { verb: 'stow', target: 0, slot: 3 });
    expect(verbs(untilFree(w), 'stow')).toEqual([expect.objectContaining({ ok: false, reason: 'notATool' })]);
  });

  it('what the hands hold or the belt keeps going away (broken, removed) empties the hands or the slot', async () => {
    const w = await make();
    const p = w.player!;
    const inv = p.inventory!;
    const a = stick(w, 0.5, 0.02, -0.4, 1);
    const b = stick(w, 1, 0.02, 0.4, 1);
    w.step();
    verb(w, { verb: 'take', target: a });
    untilFree(w);
    verb(w, { verb: 'stow', target: 0, slot: 0 });
    untilFree(w);
    verb(w, { verb: 'take', target: b });
    untilFree(w);
    expect(p.weapon?.id).toBe('stick');
    w.removeEntity(a);
    w.removeEntity(b);
    w.step();
    expect(inv.belt[0]).toBeNull();
    expect(inv.hands).toBeNull();
    expect(p.weapon).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Forced releases, hits, re-validation (§5.0, §5.1, RF-15)
// ---------------------------------------------------------------------------

describe('going down, being hit, and targets that change (§5.0, §5.1)', () => {
  it('a knockdown releases a carried log at once; a wielded tool stays through a knockdown and drops on a KO', async () => {
    const w = await make();
    const p = w.player!;
    const id = log(w, 20, 2.2, 0, 1.2);
    w.step();
    verb(w, { verb: 'take', target: id });
    untilFree(w);
    expect(p.inventory!.hands?.mode).toBe('carry');
    p.enterKnockdown();
    w.step();
    expect(p.inventory!.hands).toBeNull();
    expect(p.load).toBeNull();
    expect(ent(w, id).state).toBe('free');
    expect(ent(w, id).releasedBy?.fighter).toBe(p.id);

    const w2 = await make(22);
    const p2 = w2.player!;
    const tool = stick(w2, 1, 0.02, 0, 1.2);
    w2.step();
    verb(w2, { verb: 'take', target: tool });
    untilFree(w2);
    expect(p2.weapon?.id).toBe('stick');
    p2.enterKnockdown();
    w2.step();
    expect(p2.inventory!.hands?.entity).toBe(tool);
    expect(p2.weapon?.id).toBe('stick');
    w2.combat.koFighter(p2, { by: 'bleed', killer: null, cause: null, point: p2.pos.clone() });
    w2.step();
    expect(p2.inventory!.hands).toBeNull();
    expect(p2.weapon).toBeNull();
    expect(ent(w2, tool).state).toBe('free');
  });

  it("DS dropWeapon (a KO by a blow, a severed arm) lets go of the wielded entity instead of a DS drop", async () => {
    const w = await make();
    const p = w.player!;
    const tool = stick(w, 1, 0.02, 0, 1.2);
    w.step();
    verb(w, { verb: 'take', target: tool });
    untilFree(w);
    w.combat.dropWeapon(p);
    expect(p.weapon).toBeNull();
    expect(p.inventory!.hands).toBeNull();
    expect(ent(w, tool).state).toBe('free');
    expect(w.combat.drops).toEqual([]);
  });

  it('a hit cancels a work action with no effect: hitstun or a knockdown before actAt, and the hands never close', async () => {
    for (const blow of ['hitstun', 'knockdown'] as const) {
      const w = await make();
      const p = w.player!;
      const id = log(w, 30, 2.2, 0, 0.6);
      w.step();
      verb(w, { verb: 'take', target: id });
      run(w, 6);
      expect(p.state).toBe('pickup');
      expect(p.work?.kind).toBe('take');
      expect(p.stateFrame).toBeLessThan(p.work!.actAt);
      // What DS's hit() does to the one it lands on (combat.ts hit: enterHitstun, or enterKnockdown for a heavy blow).
      if (blow === 'hitstun') p.enterHitstun(20, 'hitHigh');
      else p.enterKnockdown();
      expect(p.work).toBeNull();
      const evs = run(w, 120);
      expect(verbs(evs, 'take')).toEqual([]);
      expect(p.inventory!.hands).toBeNull();
      expect(p.load).toBeNull();
      expect(ent(w, id).state).toBe('free');
      expect(ent(w, id).credit).toEqual([]);
    }
  });

  it('a real blow lands on a player who is busy taking (the action leaves them open): no automatic defence in a work action', async () => {
    const w = await make();
    const p = w.player!;
    // A fighter of the other team in front, a stick at the player's feet beside it.
    const id = stick(w, 1, 0.02, 0.5, 0.4);
    const foe = new Fighter('enemy', 'Foe', PLAYER_MOVES, {}, undefined, { ids: w.ids.fighter, rngSeed: 5 });
    w.addFighter(foe, null);
    w.teleport(foe, 0, 1.3, Math.PI);
    w.step();
    verb(w, { verb: 'take', target: id });
    w.step();
    expect(p.state).toBe('pickup');
    let landed = false;
    let defended = false;
    let before = '';
    for (let t = 0; t < 120 && !landed; t++) {
      if (foe.free) foe.press('rpunch');
      before = p.state;
      const r = w.step();
      if (r.combat.some((e) => e.type === 'hit' && e.defender === p)) landed = true;
      if (r.combat.some((e) => e.type === 'defend' && e.f === p)) defended = true;
    }
    expect(defended).toBe(false);
    expect(landed).toBe(true);
    // It landed while the player was still in the work action, which it ended.
    expect(before).toBe('pickup');
    expect(p.work).toBeNull();
  });

  it('a target that goes away while the verb waits in the buffer is refused when it would start (RF-15)', async () => {
    const w = await make();
    const p = w.player!;
    const id = stick(w, 1, 0.02, 0, 1.2);
    w.step();
    p.enterHitstun(8, 'hitHigh');
    verb(w, { verb: 'take', target: id });
    const evs = run(w, 3);
    expect(p.verbRequest?.cmd.verb).toBe('take');
    w.removeEntity(id);
    evs.push(...untilFree(w));
    expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'noTarget' })]);
    expect(p.inventory!.hands).toBeNull();
    expect(p.state).not.toBe('pickup');
  });

  it('a verb that waits too long is dropped busy', async () => {
    const w = await make();
    const p = w.player!;
    const id = stick(w, 1, 0.02, 0, 1.2);
    w.step();
    p.enterHitstun(40, 'hitHigh');
    verb(w, { verb: 'take', target: id });
    const evs = run(w, VERB_TUNING.bufferFrames + 2);
    expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'busy' })]);
    expect(p.verbRequest).toBeNull();
  });

  it('a target that leaves reach during the work action is refused at actAt with no effect (RF-15)', async () => {
    const w = await make();
    const p = w.player!;
    const id = log(w, 30, 2.2, 0, 1.2);
    w.step();
    verb(w, { verb: 'take', target: id });
    run(w, 4);
    expect(p.work?.kind).toBe('take');
    const e = ent(w, id);
    w.entities.setPose(e, { p: { x: 0, y: e.pose.p.y, z: 6 }, q: e.pose.q });
    const evs = untilFree(w);
    expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfRange' })]);
    expect(p.inventory!.hands).toBeNull();
    expect(ent(w, id).state).toBe('free');
    expect(ent(w, id).credit).toEqual([]);
  });

  it('credit: taking and letting go append the player id once (SPEC:186, 473)', async () => {
    const w = await make();
    const id = log(w, 10, 2.2, 0, 1.2);
    w.step();
    expect(ent(w, id).credit).toEqual([]);
    verb(w, { verb: 'take', target: id });
    untilFree(w);
    expect(ent(w, id).credit).toEqual(['p1']);
    verb(w, { verb: 'drop', target: 0 });
    untilFree(w);
    expect(ent(w, id).credit).toEqual(['p1']);
  });
});

// ---------------------------------------------------------------------------
// A rope end (§5.1 ropeEnd, with a stand-in joint store)
// ---------------------------------------------------------------------------

describe('a rope end (§5.1)', () => {
  it('takes a hanging vine’s loose end (joints.holdEnd), carries it as a rope load, and drops it loose at the hand', async () => {
    const w = await make();
    const p = w.player!;
    const recs = standInJoints(w);
    // A vine 2 m up a trunk 1.6 m ahead, 4 m long: 2 m of it lies out along the ground toward the player.
    const { vine } = spawnTree(w, { at: { x: 0, z: 2.6 }, diameter: 0.3, height: 8, vine: { anchorH: 2, lengthM: 4, yaw: Math.PI } });
    w.step();
    const rope = vine!.rope;
    expect(ent(w, rope).state).toBe('tied');
    const opts = verbsFor(w, p, { kind: 'entity', id: rope, at: new Vector3(0, 0.05, 0.6) });
    expect(opts.find((o) => o.label === 'Take end')).toEqual({ verb: 'take', needsSecond: false, label: 'Take end' });
    verb(w, { verb: 'take', target: rope });
    const evs = untilFree(w);
    expect(verbs(evs, 'take')).toEqual([expect.objectContaining({ ok: true, entity: rope })]);
    const h = p.inventory!.hands!;
    expect(h.mode).toBe('ropeEnd');
    expect(h.joint).toBe(vine!.joint);
    expect(recs.get(vine!.joint)!.b.fighter).toBe(p.id);
    expect(p.load).toEqual({ massKg: ent(w, rope).mass, mode: 'rope' });
    // The rope's free length tethers the hand: walking away from the tree stops at the rope's reach.
    run(w, 150, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, -1)));
    const anchor = verbGeom.pointToWorld(ent(w, recs.get(vine!.joint)!.a.entity!).pose, recs.get(vine!.joint)!.a.local);
    const handY = p.pos.y + WORLD_TUNING.chestHeightM;
    expect(Math.hypot(hdist(p.pos, anchor), handY - anchor.y)).toBeLessThanOrEqual(4 + 1e-6);
    verb(w, { verb: 'drop', target: 0 });
    untilFree(w);
    expect(p.inventory!.hands).toBeNull();
    expect(recs.get(vine!.joint)!.b.loose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Focus (§5.2), the radial (§5.13), validation
// ---------------------------------------------------------------------------

describe('focus and verbAim (§5.2)', () => {
  it('a focused trunk sets verbAim on its surface at focusHeightM, follows the player, and clears out of range', async () => {
    const w = await make();
    const p = w.player!;
    const tree = spawnTree(w, { at: { x: 0, z: 1.5 }, diameter: 0.3, height: 10 }).tree;
    w.step();
    verb(w, { verb: 'focus', target: tree, at: toCm({ x: 0, y: 1, z: 1.36 }) });
    w.step();
    expect(w.verbs.focusedEntity(p)).toBe(tree);
    const aim = p.verbAim!;
    expect(aim.y).toBeCloseTo(p.pos.y + VERB_TUNING.focusHeightM, 6);
    // On the trunk's surface, on the player's side.
    expect(aim.z).toBeGreaterThan(1.3);
    expect(aim.z).toBeLessThan(1.5);
    // Out of range: cleared.
    w.teleport(p, 0, -4);
    w.step();
    w.step();
    expect(w.verbs.focusedEntity(p)).toBeNull();
    expect(p.verbAim).toBeNull();
  });

  it('a ground focus aims at the point; target 0 without a point clears it; a far point is refused', async () => {
    const w = await make();
    const p = w.player!;
    w.step();
    verb(w, { verb: 'focus', target: 0, at: [0, 0, 150] });
    w.step();
    expect(p.verbAim?.toArray()).toEqual([0, 0, 1.5]);
    expect(w.verbs.focusOf(p)).toEqual({ target: 0, at: { x: 0, y: 0, z: 1.5 } });
    verb(w, { verb: 'focus', target: 0 });
    w.step();
    expect(p.verbAim).toBeNull();
    verb(w, { verb: 'focus', target: 0, at: [0, 0, 900] });
    const evs = run(w, 1);
    expect(verbs(evs, 'focus')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfRange' })]);
    expect(p.verbAim).toBeNull();
  });
});

describe('the radial (§5.13) and validation (§5.0)', () => {
  it('offers Take (as the mode it would be) for things, Stow and Drop for nothing, with the reason when it can’t', async () => {
    const w = await make();
    const p = w.player!;
    const s = stick(w, 1, 0.02, -0.5, 1.2);
    const heavy = log(w, 300, 3.6, 0.5, 1.6);
    const mid = log(w, 30, 2.2, 0.3, -1.2);
    const tree = spawnTree(w, { at: { x: 1.5, z: 0 }, diameter: 0.3, height: 10 }).tree;
    w.step();
    const at = new Vector3(0, 0, 1.2);
    const take = (id: number) => verbsFor(w, p, { kind: 'entity', id, at }).find((o) => o.verb === 'take');
    expect(take(s)).toEqual({ verb: 'take', needsSecond: false, label: 'Wield' });
    expect(take(mid)).toEqual({ verb: 'take', needsSecond: false, label: 'Carry' });
    expect(take(heavy)).toEqual({ verb: 'take', needsSecond: false, label: 'Take', reasonIfDisabled: 'tooHeavy' });
    expect(take(tree)?.reasonIfDisabled).toBe('immovable');
    // Nothing highlighted, empty hands: nothing to do.
    expect(verbsFor(w, p, null)).toEqual([]);
    verb(w, { verb: 'take', target: s });
    untilFree(w);
    expect(verbsFor(w, p, null)).toEqual([
      { verb: 'stow', needsSecond: false, label: 'Stow on belt', slot: 0, reasonIfDisabled: 'tooLong' },
      { verb: 'stow', needsSecond: false, label: 'Stow on back', slot: 3 },
      { verb: 'drop', needsSecond: false, label: 'Drop' },
    ]);
    // Options come in §5.13's order, each only once its verb is registered (P15-P17 add theirs).
    const order = verbsFor(w, p, { kind: 'entity', id: tree, at }).map((o) => o.verb);
    const rank = ['take', 'lash', 'tie', 'bend', 'untie', 'cut', 'shape'];
    expect([...order].sort((a, b) => rank.indexOf(a) - rank.indexOf(b))).toEqual(order);
  });

  it('lists every verb in §5.13’s fixed order with its own reason, once P15-P17 register (stand-in handlers)', async () => {
    const w = await make();
    const p = w.player!;
    const recs = standInJoints(w);
    // A rooted tree with a vine 2 m up whose loose end lies toward the player.
    const { tree, vine } = spawnTree(w, { at: { x: 0, z: 2.6 }, diameter: 0.3, height: 8, vine: { anchorH: 2, lengthM: 4, yaw: Math.PI } });
    w.step();
    expect(recs.size).toBe(1);
    // Stand-ins that refuse with a reason of their own, so each option shows whose rules it ran.
    const standIn = (verb: VerbHandler['verb'], reason: RefuseReason, second = false): VerbHandler => ({
      verb,
      target: 'entity',
      second,
      validate: () => reason,
      start: () => null,
    });
    const handlers = [
      standIn('lash', 'noRope', true),
      standIn('tie', 'noRope'),
      standIn('bend', 'tooThick', true),
      standIn('untie', 'outOfReach'),
      standIn('cut', 'noEdge'),
      standIn('shape', 'tooHard'),
    ];
    const withAll = <T>(run: () => T): T => handlers.reduceRight<() => T>((inner, h) => () => withVerbHandler(h, inner), run)();
    const at = new Vector3(0, 1, 2.45);
    withAll(() => {
      expect(verbsFor(w, p, { kind: 'entity', id: tree, at })).toEqual([
        { verb: 'take', needsSecond: false, label: 'Take', reasonIfDisabled: 'immovable' },
        { verb: 'lash', needsSecond: true, label: 'Lash', reasonIfDisabled: 'noRope' },
        { verb: 'tie', needsSecond: false, label: 'Tie', reasonIfDisabled: 'noRope' },
        { verb: 'bend', needsSecond: true, label: 'Bend', reasonIfDisabled: 'tooThick' },
        { verb: 'cut', needsSecond: false, label: 'Cut', reasonIfDisabled: 'noEdge' },
        { verb: 'shape', needsSecond: false, label: 'Shape', reasonIfDisabled: 'tooHard' },
      ]);
      // A hanging vine: Untie, then Take end, then Cut; no plain Take, no Bend, no Shape.
      expect(verbsFor(w, p, { kind: 'entity', id: vine!.rope, at: new Vector3(0, 0.05, 0.6) })).toEqual([
        { verb: 'lash', needsSecond: true, label: 'Lash', reasonIfDisabled: 'noRope' },
        { verb: 'tie', needsSecond: false, label: 'Tie', reasonIfDisabled: 'noRope' },
        { verb: 'untie', needsSecond: false, label: 'Untie', reasonIfDisabled: 'outOfReach' },
        { verb: 'take', needsSecond: false, label: 'Take end' },
        { verb: 'cut', needsSecond: false, label: 'Cut', reasonIfDisabled: 'noEdge' },
      ]);
    });
  });

  it('refuses a dead fighter, an unknown target and an anchor off the target’s surface', async () => {
    const w = await make();
    const p = w.player!;
    const s = stick(w, 1, 0.02, 0, 1.2);
    w.step();
    const c = (o: Partial<VerbCommand>): VerbCommand => ({ tick: 0, player: 1, kind: 'verb', verb: 'focus', target: s, ...o });
    expect(validateVerb(w, p, c({ at: toCm(ent(w, s).pose.p) }))).toEqual({ ok: true });
    expect(validateVerb(w, p, c({ at: toCm({ x: 0, y: 1, z: 1.2 }) }))).toEqual({ ok: false, reason: 'badAnchor' });
    expect(validateVerb(w, p, c({ target: 777 }))).toEqual({ ok: false, reason: 'noTarget' });
    w.combat.koFighter(p, { by: 'bleed', killer: null, cause: null, point: p.pos.clone() });
    expect(validateVerb(w, p, c({}))).toEqual({ ok: false, reason: 'cantAct' });
  });
});

describe('determinism (§8.1)', () => {
  it('two worlds given the same commands carry, drop, drag and stow bit-identically', async () => {
    const runOnce = async (): Promise<string> => {
      const w = await make(41);
      const p = w.player!;
      const a = log(w, 30, 2.2, 0, 1.2);
      const b = log(w, 90, 3, 2.5, 0);
      const s = stick(w, 0.5, 0.02, -0.6, 0.9);
      w.step();
      const out: unknown[] = [];
      const snap = () => out.push([w.tick, p.pos.toArray(), p.yaw, ...[a, b, s].map((id) => [ent(w, id).state, ent(w, id).pose, ent(w, id).vel])]);
      verb(w, { verb: 'take', target: a });
      untilFree(w);
      expect(p.inventory!.hands?.mode).toBe('carry');
      run(w, 60, () => w.commands.push(moveCommand(w.tick + 1, 1, 0.3, -1)));
      snap();
      verb(w, { verb: 'drop', target: 0 });
      run(w, 40);
      snap();
      w.teleport(p, 1.2, 0, Math.PI / 2);
      w.step();
      verb(w, { verb: 'take', target: b });
      untilFree(w);
      expect(p.inventory!.hands?.mode).toBe('drag');
      run(w, 90, () => w.commands.push(moveCommand(w.tick + 1, 1, -1, -0.2)));
      snap();
      verb(w, { verb: 'drop', target: 0 });
      untilFree(w);
      expect(p.inventory!.hands).toBeNull();
      w.teleport(p, -0.6, 0.2, Math.PI);
      w.step();
      verb(w, { verb: 'take', target: s });
      untilFree(w);
      expect(p.inventory!.hands?.entity).toBe(s);
      verb(w, { verb: 'stow', target: 0, slot: 0 });
      untilFree(w);
      expect(p.inventory!.belt[0]).toBe(s);
      snap();
      out.push(w.verbs.toRecord(), p.inventory);
      return JSON.stringify(out);
    };
    const one = await runOnce();
    const two = await runOnce();
    expect(two).toBe(one);
  });
});

// ---------------------------------------------------------------------------
// Continuous verbs (§5.0, §5.4, §5.12): the machinery P15 and P16 plug into, on stand-in handlers
// ---------------------------------------------------------------------------

describe('continuous verbs (the shared machinery, on stand-in handlers)', () => {
  it('a repeating verb strokes while on, stops when the player moves, on charge 0, and on a knockdown', async () => {
    const w = await make();
    const p = w.player!;
    w.step();
    let strokes = 0;
    let stops = 0;
    const handler: VerbHandler = {
      verb: 'shape',
      target: 'none',
      continuous: 'repeat',
      validate: () => null,
      start: (_w, f) => ({ frames: 10, actAt: 5, faceAt: { x: f.pos.x, y: f.pos.y, z: f.pos.z }, keys: [] }),
      land: () => {
        strokes++;
      },
      stop: () => {
        stops++;
      },
    };
    withVerbHandler(handler, () => {
      // On: a stroke every 10 frames while free and still.
      verb(w, { verb: 'shape', target: 0, charge: 1 });
      run(w, 45);
      expect(strokes).toBe(4);
      expect(w.verbs.continuousOf(p)?.verb).toBe('shape');
      // Off (charge 0), in any state: the stroke under way finishes, no other starts.
      verb(w, { verb: 'shape', target: 0, charge: 0 });
      run(w, 40);
      expect(strokes).toBeLessThanOrEqual(5);
      expect(w.verbs.continuousOf(p)).toBeNull();
      expect(stops).toBe(1);
      // On again, then the player walks off: it stops at the next restart.
      const before = strokes;
      verb(w, { verb: 'shape', target: 0, charge: 1 });
      run(w, 12);
      run(w, 30, () => w.commands.push(moveCommand(w.tick + 1, 1, 1, 0)));
      expect(w.verbs.continuousOf(p)).toBeNull();
      expect(stops).toBe(2);
      expect(strokes - before).toBeLessThanOrEqual(2);
      // On again, then knocked down: off at once.
      run(w, 10, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, 0)));
      verb(w, { verb: 'shape', target: 0, charge: 1 });
      run(w, 3);
      expect(w.verbs.continuousOf(p)).not.toBeNull();
      p.enterKnockdown();
      w.step();
      expect(w.verbs.continuousOf(p)).toBeNull();
      expect(stops).toBe(3);
    });
  });

  it('a held verb runs every phase 4d while on, counts its ticks, and stops when its hold says so or on charge 0', async () => {
    const w = await make();
    const p = w.player!;
    w.step();
    const seen: number[] = [];
    let stops = 0;
    const handler: VerbHandler = {
      verb: 'pull',
      target: 'none',
      continuous: 'hold',
      validate: () => null,
      start: () => null,
      hold: (_w, _f, s) => {
        seen.push(s.ticks);
        s.data.n = (s.data.n ?? 0) + 1;
        return s.data.n < 5;
      },
      stop: () => {
        stops++;
      },
    };
    withVerbHandler(handler, () => {
      verb(w, { verb: 'pull', target: 0, charge: 255 });
      run(w, 10);
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      expect(w.verbs.continuousOf(p)).toBeNull();
      expect(stops).toBe(1);
      // While walking (a held verb is no work action), then off by charge 0.
      verb(w, { verb: 'pull', target: 0, charge: 255 });
      run(w, 2, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, 1)));
      expect(w.verbs.continuousOf(p)?.ticks).toBe(2);
      expect(p.state).not.toBe('pickup');
      verb(w, { verb: 'pull', target: 0, charge: 0 });
      w.step();
      expect(w.verbs.continuousOf(p)).toBeNull();
      expect(stops).toBe(2);
    });
    // Outside the stand-in, the verb is P16's again (refused until P16 registers it).
    expect(validateVerb(w, p, { tick: 0, player: 1, kind: 'verb', verb: 'pull', target: 0, charge: 255 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The save record (§8.3) and the creature tug (§6.6)
// ---------------------------------------------------------------------------

describe('the verb system’s record', () => {
  it('round-trips focus, a continuous verb and a tug, by fighter id; restores nothing it was not given', async () => {
    const w = await make();
    const p = w.player!;
    const s = stick(w, 1, 0.02, 0, 1.2);
    const bait = log(w, 8, 1.0, 3, 3);
    w.step();
    verb(w, { verb: 'focus', target: s, at: toCm(ent(w, s).pose.p) });
    w.step();
    w.verbs.tug(p, bait);
    const rec = w.verbs.toRecord() as VerbStateRecord[];
    expect(rec).toHaveLength(1);
    expect(rec[0].fighter).toBe(p.id);
    expect(rec[0].focus?.target).toBe(s);
    expect(rec[0].tug?.entity).toBe(bait);
    expect(w.verbs.workTarget(p)).toBe(bait);
    // A continuous verb as P16's pull would leave it (hand-made: no continuous verb is P14's).
    const withCont: VerbStateRecord[] = [
      { ...rec[0], cont: { verb: 'pull', cmd: { tick: 5, player: 1, kind: 'verb', verb: 'pull', target: 0, charge: 255 }, ticks: 7, data: [['yank', 3]] } },
    ];
    const json = JSON.stringify(withCont);
    w.verbs.restoreRecord(JSON.parse(json));
    expect(JSON.stringify(w.verbs.toRecord())).toBe(json);
    expect(w.verbs.continuousOf(p)).toEqual({ verb: 'pull', cmd: withCont[0].cont!.cmd, ticks: 7, data: { yank: 3 } });
    w.verbs.restoreRecord([]);
    expect(w.verbs.toRecord()).toEqual([]);
    expect(() => w.verbs.restoreRecord([{ fighter: 1 }])).toThrow(/no focus/);
    // A removed fighter's state goes with it.
    w.verbs.restoreRecord(JSON.parse(json));
    w.removeFighter(p);
    expect(w.verbs.toRecord()).toEqual([]);
  });

  it('a creature’s tug hauls its bait with the drag code at creature strength', async () => {
    const w = await make();
    const p = w.player!;
    w.teleport(p, 0, 0, Math.PI);
    const bait = log(w, 8, 1.0, 0, 0.9);
    w.step();
    w.verbs.tug(p, bait);
    const z0 = ent(w, bait).pose.p.z;
    run(w, 90, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, -0.4)));
    expect(ent(w, bait).pose.p.z).toBeLessThan(z0 - 0.5);
    w.verbs.tug(p, null);
    expect(w.verbs.workTarget(p)).toBeNull();
  });
});
