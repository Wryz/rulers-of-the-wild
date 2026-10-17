// The contact pipeline (docs/M1-DESIGN.md §4.3, §3 phase 9; package P09): the A lab's sensor normals and event timing
// as tests, the AC-6 measured tick, one impact per episode and no score for a bounce (RF-12), the history-reset grace
// (RF-1), self-motion and the attacking limb (RF-3), momentum only through the solver for solid pairs and standing
// rulers (RF-4), released and thrown entities (RF-3, D-31), and the system's save record.
//
// No ruler exists before P11: the ruler cases build a stand-in ruler (a Fighter with `ruler` set and its own Rapier
// colliders registered as owner part 'ruler'), and sim/ruler.ts's rule functions are stubbed here (P11 fills and
// tests them).
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoneName } from '../src/body/skeleton';
import { MOVE_SPRINT, moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { freeDv, IMPACT_TUNING } from '../src/sim/impact';
import { DT, Rng } from '../src/sim/math';
import * as ruler from '../src/sim/ruler';
import { DAMAGE_TUNING } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { restoreTuning, tuningSnapshot } from '../src/tuning/registry';
import { castContact, type TripwireSink } from '../src/world/contacts';
import { dot } from '../src/world/damage';
import { spawnLog, spawnStick } from '../src/world/factory';
import { COLLIDES_WITH, collisionGroups, G, GROUP, solverGroups } from '../src/world/groups';
import { type ContactPair, ownerKey, PhysicsWorld, physicsReady } from '../src/world/physics';
import type { Owner, RulerState, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

vi.mock('../src/sim/ruler', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/ruler')>();
  return {
    ...m,
    rulerTick: vi.fn(),
    rulerDamage: vi.fn(() => null),
    classifyRulerZone: vi.fn(() => 'leg'),
    rulerToughness: vi.fn(() => 4000),
    rulerVolumes: vi.fn(() => []),
    rulerHit: vi.fn(),
  };
});

type ImpactEv = Extract<WorldEvent, { type: 'impact' }>;

const snapshot = tuningSnapshot();
const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
});
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  restoreTuning(snapshot);
  vi.mocked(ruler.rulerDamage).mockClear();
});

async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', size: 50, ...o });
  live.push(w);
  return w;
}

function addApe(w: World, x: number, z: number, yaw = 0): Fighter {
  const ids = w.ids.fighter;
  const { fighter: f } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  f.scale = SPECIES_BODY.ape.scale;
  f.species = 'ape';
  f.massKg = SPECIES_BODY.ape.massKg;
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  f.yaw = yaw;
  w.addFighter(f, null);
  w.teleport(f, x, z, yaw);
  return f;
}

function rulerState(): RulerState {
  return {
    maxHp: SPECIES_BODY.giantApe.maxHp,
    unhealed: 0,
    wounds: [],
    pinned: false,
    pinnedKg: 0,
    unpinTicks: 0,
    stuck: false,
    burning: false,
    inPit: false,
    downWound: null,
    downCause: null,
    lastWorldTrip: null,
    deflectedHeading: null,
    pendingTrip: null,
  };
}

/** A stand-in giant (P11 builds the real one): far off for CombatSim, its bones are colliders the test places. */
function addFakeRuler(w: World): Fighter {
  const ids = w.ids.fighter;
  const { fighter: g } = createEnemy('bruiser', new Rng(4), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  g.scale = SPECIES_BODY.giantApe.scale;
  g.massKg = SPECIES_BODY.giantApe.massKg;
  g.species = 'giantApe';
  g.ruler = rulerState();
  g.pos.set(20, 0, 20);
  w.addFighter(g, null);
  return g;
}

function rulerCollider(w: World, g: Fighter, bone: BoneName, body: RAPIER.RigidBody, desc: RAPIER.ColliderDesc): RAPIER.Collider {
  const c = w.physics.rapier.createCollider(desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
  w.physics.register(c, { kind: 'fighter', id: g.id, part: 'ruler', bone });
  return c;
}

const sensorDesc = (d: RAPIER.ColliderDesc) => d.setSensor(true).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL).setCollisionGroups(collisionGroups('RULER_ZONE')).setSolverGroups(solverGroups('RULER_ZONE'));

/** Steps the world, collecting every world event. */
function run(w: World, ticks: number, before?: (t: number) => boolean | void): WorldEvent[] {
  const all: WorldEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    if (before?.(t) === true) break;
    w.step();
    all.push(...w.events);
  }
  return all;
}

const impactsOn = (ev: readonly WorldEvent[], f: Fighter): ImpactEv[] => ev.filter((e): e is ImpactEv => e.type === 'impact' && e.defender === f);
const ent = (id: number): Owner => ({ kind: 'entity', id });
const zoneOf = (f: Fighter): Owner => ({ kind: 'fighter', id: f.id, part: 'zone' });
/** An entity's collider that no character controller meets (the controller walks through it; the zones still do). */
function noChar(w: World, id: number): void {
  w.entities.get(id)!.collider!.setCollisionGroups(G(GROUP.ENTITY, COLLIDES_WITH.ENTITY & ~GROUP.CHAR));
}
const speed = (v: V3 | null | undefined) => (v ? Math.hypot(v.x, v.y, v.z) : 0);

// ---------------------------------------------------------------------------
// The A lab's measurements, as tests
// ---------------------------------------------------------------------------

describe('sensor normals: the cast between the start-of-previous-step poses (A lab normals.mjs (1), departure X4)', () => {
  it('gives the outward normal and v_n = |v_rel| in all four of the lab’s cases', () => {
    const I = { x: 0, y: 0, z: 0, w: 1 };
    for (const [label, stoneV, zoneV, y0, want] of [
      ['head-on', 12, -2, 0.1, 14],
      ['oblique', 12, -2, 0.25, 14],
      ['fast 30', 30, 0, 0, 30],
      ['zone sweeping into a still stone', 0, -9, 0, 9],
    ] as const) {
      const w = new RAPIER.World({ x: 0, y: 0, z: 0 });
      w.timestep = DT;
      const eq = new RAPIER.EventQueue(true);
      const zb = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(1, 0, 0));
      const zc = w.createCollider(
        RAPIER.ColliderDesc.cuboid(0.5, 0.3, 0.4).setSensor(true).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        zb,
      );
      const sb = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-1, y0, 0).setLinvel(stoneV, 0, 0));
      const sc = w.createCollider(RAPIER.ColliderDesc.ball(0.05).setMass(0.5).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), sb);
      let zx = 1;
      let prevZx = 1;
      const hist: { zone: V3; stone: V3; vZone: V3; vStone: V3 }[] = [];
      let done = false;
      for (let t = 1; t < 200 && !done; t++) {
        const zp = zc.translation();
        const sp = sc.translation();
        const sv = sb.linvel();
        hist.push({ zone: { x: zp.x, y: zp.y, z: zp.z }, stone: { x: sp.x, y: sp.y, z: sp.z }, vZone: { x: (zx - prevZx) / DT, y: 0, z: 0 }, vStone: { x: sv.x, y: sv.y, z: sv.z } });
        prevZx = zx;
        zx += zoneV * DT;
        zb.setNextKinematicTranslation({ x: zx, y: 0, z: 0 });
        w.step(eq);
        let started = false;
        eq.drainCollisionEvents((_a, _b, s) => {
          if (s) started = true;
        });
        if (!started) continue;
        const now = hist[hist.length - 1];
        const prev = hist[hist.length - 2];
        const hit = castContact(zc.shape, { p: prev.zone, q: I }, now.vZone, sc.shape, { p: prev.stone, q: I }, now.vStone);
        expect(hit, label).not.toBeNull();
        expect(hit!.n.x, label).toBeCloseTo(-1, 3);
        expect(Math.abs(hit!.n.y) + Math.abs(hit!.n.z), label).toBeLessThan(1e-3);
        // Closing speed (v_zone − v_stone)·n, n out of the zone.
        const vn = dot({ x: now.vZone.x - now.vStone.x, y: now.vZone.y - now.vStone.y, z: now.vZone.z - now.vStone.z }, hit!.n);
        expect(vn, label).toBeCloseTo(want, 2);
        // The point lies on the zone's face (x = its centre − 0.5 at the time of impact).
        expect(hit!.point.x, label).toBeCloseTo(prev.zone.x + now.vZone.x * hit!.toi - 0.5, 3);
        done = true;
      }
      expect(done, label).toBe(true);
      eq.free();
      w.free();
    }
  });
});

describe('event timing (A lab timing.mjs): what the phase-5 store holds at the event step', () => {
  const zoneOwner: Owner = { kind: 'fighter', id: 1, part: 'zone', bone: 'head' };

  it('a kinematic zone starts when its start-of-step pose overlaps; carryV is the previous tick’s delta (a: 6 m/s; c: 48, not 96)', () => {
    for (const [label, steps, eventTick, startX, carry] of [
      ['constant 0.1 m/tick', Array(20).fill(0.1) as number[], 11, 1.0, 6],
      ['accelerating', [0.05, 0.1, 0.2, 0.4, 0.8, 1.6], 6, 1.55, 48],
    ] as const) {
      const ph = new PhysicsWorld();
      const box = ph.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(1.5, 0, 0));
      ph.register(
        ph.rapier.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), box),
        { kind: 'entity', id: 1 },
      );
      const kb = ph.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0, 0));
      ph.register(
        ph.rapier.createCollider(RAPIER.ColliderDesc.ball(0.1).setSensor(true).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), kb),
        zoneOwner,
      );
      let x = 0;
      let at = -1;
      for (let t = 1; t <= steps.length; t++) {
        x += steps[t - 1];
        kb.setNextKinematicTranslation({ x, y: 0, z: 0 }); // phase 4b
        ph.storePreStep(); // phase 5
        ph.step(); // phase 7
        ph.snapshotPostStep();
        const pairs = ph.drain(); // phase 8
        if (!pairs.some((p) => p.started)) continue;
        at = t;
        const s = ph.pre(ownerKey(zoneOwner))!;
        expect(s.p.x, label).toBeCloseTo(startX, 5);
        expect(s.carryV.x, label).toBeCloseTo(carry, 3);
        break;
      }
      expect(at, label).toBe(eventTick);
      ph.free();
    }
  });

  it('a falling body starts on the step whose start pose touches; its stored pre-step velocity is the arrival speed (b)', () => {
    const ph = new PhysicsWorld();
    ph.register(ph.rapier.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.5, 5).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)), { kind: 'entity', id: 1 });
    const b = ph.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
    ph.register(ph.rapier.createCollider(RAPIER.ColliderDesc.ball(0.1).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), b), { kind: 'entity', id: 2 });
    let found = false;
    for (let t = 1; t < 200 && !found; t++) {
      ph.storePreStep();
      ph.step();
      ph.snapshotPostStep();
      if (!ph.drain().some((p) => p.started)) continue;
      found = true;
      const s = ph.pre('entity:2')!;
      expect(s.p.y).toBeLessThanOrEqual(0.6);
      expect(s.v.y).toBeCloseTo(-5.232, 2);
      expect(Math.abs(s.v.y / -Math.sqrt(2 * 9.81 * 1.4) - 1)).toBeLessThan(0.005);
      expect(Math.abs(ph.post('entity:2')!.v.y)).toBeLessThan(0.05);
    }
    expect(found).toBe(true);
    ph.free();
  });
});

describe('solid pairs read the contact manifolds (A lab normals.mjs (2))', () => {
  it('a box landing on bumpy terrain: the terrain normal, a point on the ground, the arrival velocity, a land event', async () => {
    const w = await make({ seed: 2, player: false });
    w.terrain.generate((x, z) => 0.2 * Math.sin(0.9 * x) + 0.15 * Math.cos(1.3 * z));
    const id = w.addEntity({ material: 'stone', shape: { kind: 'box', hx: 0.3, hy: 0.1, hz: 0.2 }, p: { x: 3.3, y: 3, z: 2.2 }, lin: { x: 1, y: 0, z: 0 }, look: 'box' });
    let seen: { n: V3; point: V3; vb: V3 } | null = null;
    const orig = w.contacts.process.bind(w.contacts);
    w.contacts.process = (ww, pairs) => {
      const p = pairs.find((q: ContactPair) => q.started && q.a.kind === 'terrain' && q.b.kind === 'entity' && q.b.id === id);
      if (p && !seen) seen = w.contacts.geometryOf(p);
      orig(ww, pairs);
    };
    const ev: WorldEvent[] = [];
    for (let t = 0; t < 120 && !seen; t++) {
      w.step();
      ev.push(...w.events);
    }
    expect(seen).not.toBeNull();
    const g = seen as unknown as { n: V3; point: V3; vb: V3 };
    const tn = w.terrain.normalAt(g.point.x, g.point.z, { x: 0, y: 0, z: 0 });
    expect(dot(g.n, tn)).toBeGreaterThan(0.98);
    expect(Math.abs(g.point.y - w.terrain.heightAt(g.point.x, g.point.z))).toBeLessThan(0.05);
    expect(g.vb.y).toBeLessThan(-5);
    const land = ev.find((e): e is Extract<WorldEvent, { type: 'land' }> => e.type === 'land' && e.entity === id);
    expect(land).toBeDefined();
    expect(land!.mass).toBeCloseTo(w.entities.get(id)!.mass, 9);
    expect(land!.energy).toBeGreaterThan(IMPACT_TUNING.landMinJ);
  });
});

describe("an entity's integrity at its effective mass at the contact point (DAMAGE_TUNING.integrityPointMass)", () => {
  /** The energy of a 300 kg × 4.4 m log's first landing on flat terrain, dropped from 2 m tilted `deg` about z. */
  async function firstLanding(deg: number, pointMass: boolean): Promise<number> {
    DAMAGE_TUNING.integrityPointMass = pointMass;
    const w = await make({ seed: 2, player: false });
    const a = (deg * Math.PI) / 180;
    // Local +y (the axis) along world x, then tilted about z: the +x end down by `deg`.
    const q = { x: 0, y: 0, z: Math.sin((-Math.PI / 2 - a) / 2), w: Math.cos((-Math.PI / 2 - a) / 2) };
    const id = spawnLog(w, { p: { x: 0, y: 2 + 2.2 * Math.sin(a), z: 0 }, q, length: 4.4, mass: 300 });
    for (let t = 0; t < 120; t++) {
      w.step();
      const land = w.events.find((e): e is Extract<WorldEvent, { type: 'land' }> => e.type === 'land' && e.entity === id);
      if (land) return land.energy;
    }
    throw new Error('the log never landed');
  }

  it('a log landing flat scores its whole mass; landing on its end, about a third (the rod end met at 30°: m/3.25); the lever off, the whole mass', async () => {
    const flatOn = await firstLanding(0, true);
    const flatOff = await firstLanding(0, false);
    const endOn = await firstLanding(30, true);
    const endOff = await firstLanding(30, false);
    // Same drop, same physics up to the first contact: only m_eff differs. The log lies across the seams of four 25 m
    // terrain tiles (x = 0, z = 0): one contact for all of them, at the middle of its length (groundHit).
    expect(flatOff).toBeGreaterThan(1000);
    expect(flatOn / flatOff).toBeGreaterThan(0.95);
    expect(flatOn / flatOff).toBeLessThanOrEqual(1 + 1e-9);
    // The end 2.2 m from the centre of mass, 1.91 m of it across the ground's normal: 1/(1 + 1.91² × 12 / 4.4²) ≈ 0.31.
    expect(endOn / endOff).toBeGreaterThan(0.25);
    expect(endOn / endOff).toBeLessThan(0.4);
  });
});

// ---------------------------------------------------------------------------
// Logs on players: the AC-6 measured tick, episodes, bounces
// ---------------------------------------------------------------------------

/** Per tick, around phase 9: the log's phase-5 and phase-8 velocities and the impact scored on `f` by it. */
function watchLog(w: World, id: number, f: Fighter): { tick: number; pre: V3 | null; post: V3 | null; hit: ImpactEv | null }[] {
  const rows: { tick: number; pre: V3 | null; post: V3 | null; hit: ImpactEv | null }[] = [];
  const key = `entity:${id}`;
  const orig = w.contacts.process.bind(w.contacts);
  w.contacts.process = (ww, pairs) => {
    const pre = w.physics.pre(key)?.v ?? null;
    const post = w.physics.post(key)?.v ?? null;
    const n = w.events.length;
    orig(ww, pairs);
    const hit = impactsOn(w.events.slice(n), f).find((e) => e.cause.entityId === id) ?? null;
    rows.push({ tick: w.tick, pre: pre && { ...pre }, post: post && { ...post }, hit });
  };
  return rows;
}

describe('a log on a standing player', () => {
  it('300 kg arriving at the lab’s 6.2 m/s: keeps ≥ 80 % of its speed over the measured tick (AC-6, D-23), hurts, rests on the terrain', async () => {
    // The AC-6 recipe drops the log's centre from 4 m; the lab's player zone topped out at 1.81 m and the log met it at
    // 6.21 m/s (Δv 4.99 m/s, the hitstun branch). The real rig's head ball tops out at 1.72 m, so from 4 m the log
    // arrives at 6.38 m/s and presses the player (Δv 5.09 ≥ launchDv): see the next two tests (the second, AC-6 part 2
    // at 4 m, waits on a P08-fix to DownedBodies.launch). Here the centre starts at 3.75 m, so it meets the head at the
    // lab's 5.9-6.1 m/s whatever the tick phase, in the lab's branch.
    const w = await make({ seed: 3 });
    const p = w.player!;
    run(w, 10);
    const id = spawnLog(w, { p: { x: p.pos.x, y: 3.75, z: p.pos.z }, length: 3, mass: 300 });
    expect(w.entities.get(id)!.mass).toBeCloseTo(300, 6);
    const rows = watchLog(w, id, p);
    run(w, 80, () => rows.length > 1 && rows[rows.length - 2].hit !== null);
    const i = rows.findIndex((r) => r.hit);
    expect(i).toBeGreaterThan(0);
    const before = speed(rows[i].pre);
    const after = speed(rows[i + 1].post);
    expect(before).toBeGreaterThan(5.5);
    expect(before).toBeLessThan(6.22);
    expect(rows[i + 1].post!.y).toBeLessThan(0); // still falling
    expect(after).toBeGreaterThanOrEqual(0.8 * before);
    const hit = rows[i].hit!;
    expect(hit.damage).toBeGreaterThan(0);
    expect(hit.cause).toMatchObject({ kind: 'entity', entityId: id, held: false });
    // The branch by name (RF-27): all of Δv is downward and under launchDv: hitstun, neither launched nor pressed.
    expect(hit.launched).toBe(freeDv(hit.dv) >= IMPACT_TUNING.launchDv);
    expect(hit.launched).toBe(false);
    expect(hit.dv.y).toBeGreaterThan(-IMPACT_TUNING.launchDv);
    expect(hit.knockdown).toBe(false);
    expect(p.state).toBe('hitstun');
    // It falls on through and rests on the terrain, not on the capsule; no second impact (one episode).
    const ev = run(w, 300);
    const e = w.entities.get(id)!;
    expect(e.pose.p.y).toBeLessThan(0.5);
    expect(speed(e.vel.lin)).toBeLessThan(0.1);
    expect(impactsOn(ev, p).filter((x) => x.cause.entityId === id)).toHaveLength(0);
  });

  it('300 kg from 4 m presses the player (Δv ≥ launchDv down): knockdown, no launch, the reaction −M·Δv and the slab’s Δv queued', async () => {
    const w = await make({ seed: 3 });
    const p = w.player!;
    run(w, 10);
    const id = spawnLog(w, { p: { x: p.pos.x, y: 4, z: p.pos.z }, length: 3, mass: 300 });
    const queue = vi.spyOn(w.entities, 'queueImpulse');
    const slab = vi.spyOn(w.downed, 'queueDv');
    const rows = watchLog(w, id, p);
    run(w, 80, () => rows.length > 0 && rows[rows.length - 1].hit !== null);
    const hit = rows[rows.length - 1].hit!;
    expect(hit).not.toBeNull();
    expect(hit.dv.y).toBeLessThanOrEqual(-IMPACT_TUNING.launchDv);
    expect(hit).toMatchObject({ knockdown: true, launched: false });
    expect(p.state).toBe('knockdown');
    const r = queue.mock.calls.find((c) => c[0] === id)!;
    expect(r[1].y).toBeCloseTo(-p.mass * hit.dv.y, 6);
    expect(slab).toHaveBeenCalledWith(p, hit.dv);
  });

  // TODO(P08-fix, reported): AC-6 part 2 at the design's 4 m. The press puts the player down, and in the next phase 4a
  // DownedBodies.launch enables the slab upright where the player stood, inside the falling log; Rapier's depenetration
  // throws the 300 kg log up (+4.95 m/s at N + 1, measured) and it lands on the lying slab before it rolls off. Expected
  // to fail until the slab is never enabled overlapping a dynamic body (start it lying when the queued Δv is a press, or
  // a collision grace without ENTITY until clear); then `it.fails` fails and this becomes a plain `it` (P27's gate).
  it.fails('AC-6 part 2 from 4 m in the press branch: the log keeps ≥ 80 % of its speed over the measured tick and rests on the terrain', async () => {
    const w = await make({ seed: 3 });
    const p = w.player!;
    run(w, 10);
    const id = spawnLog(w, { p: { x: p.pos.x, y: 4, z: p.pos.z }, length: 3, mass: 300 });
    const rows = watchLog(w, id, p);
    run(w, 80, () => rows.length > 1 && rows[rows.length - 2].hit !== null);
    const i = rows.findIndex((r) => r.hit);
    const before = speed(rows[i].pre);
    const after = speed(rows[i + 1].post);
    expect(rows[i].hit!.damage).toBeGreaterThan(0);
    expect(rows[i + 1].post!.y).toBeLessThan(0); // still falling
    expect(after).toBeGreaterThanOrEqual(0.8 * before);
    // It lands on the terrain, never on the body: no rest above 0.5 m on the way.
    let highest = -Infinity;
    for (let t = 0; t < 300; t++) {
      w.step();
      const e = w.entities.get(id)!;
      if (speed(e.vel.lin) < 0.1) highest = Math.max(highest, e.pose.p.y);
    }
    expect(highest).toBeLessThan(0.5);
  });

  it('a log falling through a standing body scores one impact for the whole episode (RF-12)', async () => {
    const w = await make({ seed: 4 });
    const p = w.player!;
    run(w, 10);
    const id = spawnLog(w, { p: { x: p.pos.x + 0.05, y: 3.2, z: p.pos.z }, length: 2, mass: 40 });
    const before = { ...w.contacts.unscored };
    const ev = run(w, 120);
    const hits = impactsOn(ev, p).filter((e) => e.cause.entityId === id);
    expect(hits).toHaveLength(1);
    expect(hits[0].damage).toBeGreaterThan(0);
    expect(hits[0].knockdown).toBe(false);
    // The rest of the body met it inside the same episode.
    expect(w.contacts.unscored.continuing).toBeGreaterThan(before.continuing);
    expect(w.entities.get(id)!.pose.p.y).toBeLessThan(0.5);
  });

  it('a re-contact within impactCooldownTicks of the episode’s end is a bounce and scores nothing; a later one scores (RF-12)', async () => {
    const w = await make({ seed: 5 });
    WORLD_TUNING.gravityY = 0;
    const p = w.player!;
    run(w, 5);
    const id = w.addEntity({ material: 'dryWood', shape: { kind: 'box', hx: 0.15, hy: 0.15, hz: 0.15 }, p: { x: 0, y: 1.35, z: 1.4 }, look: 'box' });
    const e = w.entities.get(id)!;
    const touching = () => w.contacts.touching(ent(id), zoneOf(p));
    const scored: number[] = [];
    let phase: 'in' | 'out' | 'back' | 'away' | 'again' | 'done' = 'in';
    let endTick = -1;
    let backTick = -1;
    let awayFor = 0;
    let bounces0 = 0;
    for (let t = 0; t < 400 && phase !== 'done'; t++) {
      const vz = phase === 'out' || phase === 'away' ? 4 : -4;
      e.body!.setLinvel({ x: 0, y: 0, z: vz }, true);
      w.step();
      const hits = impactsOn(w.events, p).filter((x) => x.cause.entityId === id);
      if (hits.length) scored.push(w.tick);
      const n = touching();
      if (phase === 'in' && hits.length) phase = 'out';
      else if (phase === 'out' && n === 0) {
        endTick = w.tick;
        bounces0 = w.contacts.unscored.bounce;
        phase = 'back';
      } else if (phase === 'back' && n > 0) {
        backTick = w.tick;
        phase = 'away';
      } else if (phase === 'away' && n === 0 && ++awayFor > 25) phase = 'again';
      else if (phase === 'again' && n > 0) phase = 'done';
    }
    expect(phase).toBe('done');
    expect(backTick - endTick).toBeLessThanOrEqual(DAMAGE_TUNING.impactCooldownTicks);
    expect(w.contacts.unscored.bounce).toBeGreaterThan(bounces0);
    expect(scored.length).toBe(2);
    expect(scored[0]).toBeLessThan(endTick);
    expect(scored).not.toContain(backTick);
    expect(scored[1]).toBe(w.tick);
  });
});

// ---------------------------------------------------------------------------
// History resets and grace (RF-1)
// ---------------------------------------------------------------------------

describe('contact grace after a pose jump (RF-1)', () => {
  /** A fixed, horizontal stake at chest height, its sharp tip at x = tipX pointing −x; the controller walks through it. */
  function stake(w: World, tipX: number, z = 0): number {
    const id = w.addEntity({
      material: 'dryWood',
      shape: { kind: 'box', hx: 0.3, hy: 0.03, hz: 0.03 },
      p: { x: tipX + 0.3, y: 1.4, z },
      state: 'fixed',
      sharpPoints: [{ local: { x: -0.3, y: 0, z: 0 }, dir: { x: -1, y: 0, z: 0 }, sharpness: 0.6 }],
      look: 'stake',
    });
    noChar(w, id);
    return id;
  }

  it('teleported over a stake scores 0 J (recorded as touching); then sprinting into its tip scores as usual', async () => {
    const w = await make({ seed: 6 });
    const p = w.player!;
    // Off the centre line, so the teleport's support probe at z = 0 doesn't stand the player on the stake.
    const id = stake(w, 10, 0.06);
    run(w, 5);
    const g0 = w.contacts.unscored.grace;
    w.teleport(p, 10.15, 0, Math.PI / 2);
    const ev1 = run(w, 10);
    expect(impactsOn(ev1, p)).toHaveLength(0);
    expect(w.contacts.touching(ent(id), zoneOf(p))).toBeGreaterThan(0);
    expect(w.contacts.unscored.grace).toBeGreaterThan(g0);
    w.teleport(p, 6, 0, Math.PI / 2);
    run(w, 5);
    expect(w.contacts.touching(ent(id), zoneOf(p))).toBe(0);
    let hit: ImpactEv | undefined;
    for (let t = 0; t < 150 && !hit; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0, MOVE_SPRINT));
      w.step();
      hit = impactsOn(w.events, p).find((e) => e.cause.entityId === id);
    }
    expect(hit).toBeDefined();
    expect(hit!.damage).toBeGreaterThan(0);
    expect(hit!.cause.feature).toBe('sharpPoint');
    expect(hit!.energy).toBeGreaterThan(50);
  });

  it('zones re-enabled over a stake score 0 J', async () => {
    const w = await make({ seed: 7 });
    const p = w.player!;
    run(w, 5);
    w.zones.setEnabled(p, false);
    const id = stake(w, p.pos.x - 0.15, p.pos.z);
    run(w, 3);
    expect(w.contacts.touching(ent(id), zoneOf(p))).toBe(0);
    const g0 = w.contacts.unscored.grace;
    w.zones.setEnabled(p, true);
    const ev = run(w, 10);
    expect(impactsOn(ev, p)).toHaveLength(0);
    expect(w.contacts.touching(ent(id), zoneOf(p))).toBeGreaterThan(0);
    expect(w.contacts.unscored.grace).toBeGreaterThan(g0);
  });

  it('a body switched to sensors over a stake (the ruler’s get-up) scores 0 J inside its grace, even from a stale history; without the grace the stale jump scores', async () => {
    for (const [reset, grace] of [
      [true, true],
      [false, true],
      [false, false],
    ] as const) {
      const label = `${reset ? 'history reset' : 'stale history'}, ${grace ? 'grace' : 'no grace'}`;
      vi.mocked(ruler.rulerDamage).mockClear();
      const w = await make({ seed: 8, player: false });
      const g = addFakeRuler(w);
      const id = stake(w, 2, 0);
      const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-3, 0.6, 0));
      const col = rulerCollider(
        w,
        g,
        'chest',
        body,
        RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setMass(2865).setCollisionGroups(collisionGroups('RULER_SOLID')).setSolverGroups(solverGroups('RULER_SOLID')),
      );
      g.setState('tripped');
      run(w, 30);
      // The get-up switch: kinematic, sensors, posed over the stake in phase 4 (setNextKinematic, as RulerBodies poses
      // it), history reset and a grace. The pair starts at the step after the one that moved it there; without the
      // reset, that tick's store still holds the tripped pose as the previous one and reads the 5.3 m jump as one tick's
      // motion (≈ 320 m/s, RF-1's stale history), so only the grace stands between the switch and a huge score.
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      col.setSensor(true);
      col.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
      col.setCollisionGroups(collisionGroups('RULER_ZONE'));
      col.setSolverGroups(solverGroups('RULER_ZONE'));
      body.setNextKinematicTranslation({ x: 2.3, y: 1.4, z: 0 });
      if (reset) w.physics.resetHistory(ownerKey({ kind: 'fighter', id: g.id, part: 'ruler', bone: 'chest' }));
      if (grace) w.contacts.grace(g.id, w.tick + 1 + DAMAGE_TUNING.zoneGraceTicks);
      g.setState('idle');
      const g0 = w.contacts.unscored.grace;
      const ev = run(w, 10);
      if (grace) {
        expect(w.contacts.touching(ent(id), { kind: 'fighter', id: g.id, part: 'ruler' }), label).toBeGreaterThan(0);
        expect(impactsOn(ev, g), label).toHaveLength(0);
        expect(ruler.rulerDamage, label).not.toHaveBeenCalled();
        expect(w.contacts.unscored.grace, label).toBeGreaterThan(g0);
      } else {
        // The control: the same switch outside a grace is scored, from the stale jump's speed.
        const hits = impactsOn(ev, g).filter((e) => e.cause.entityId === id);
        expect(hits, label).toHaveLength(1);
        expect(hits[0].energy, label).toBeGreaterThan(1e6);
        expect(ruler.rulerDamage, label).toHaveBeenCalledTimes(1);
        expect(w.contacts.unscored.grace, label).toBe(g0);
        // A million joules on a stake breaks it (§4.10, P10): the stake is gone, so nothing is left touching.
        expect(ev.some((e) => e.type === 'break' && e.entity === id), label).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Self-motion and the attacking limb (RF-3)
// ---------------------------------------------------------------------------

describe('a creature’s own motion (RF-3)', () => {
  it('a player walking into a log gets no damage or flinch', async () => {
    const w = await make({ seed: 9 });
    const p = w.player!;
    const id = spawnLog(w, { p: { x: 3, y: 0.5, z: 0 }, q: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, length: 2.2, r: 0.25 });
    run(w, 90);
    noChar(w, id);
    w.teleport(p, 0, 0, Math.PI / 2);
    run(w, 5);
    let met = 0;
    let fastest = 0;
    const ev: WorldEvent[] = [];
    for (let t = 0; t < 90; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
      ev.push(...w.events);
      if (w.contacts.touching(ent(id), zoneOf(p)) > 0) met++;
      fastest = Math.max(fastest, Math.hypot(p.walkVel.x, p.walkVel.z));
      expect(['hitstun', 'knockdown']).not.toContain(p.state);
    }
    expect(met).toBeGreaterThan(3);
    expect(fastest).toBeGreaterThan(3);
    expect(impactsOn(ev, p)).toHaveLength(0);
    expect(p.hp).toBe(100);
  });

  it('a player knocked onto a sharp snag does take damage; onto the same post without points, none', async () => {
    for (const sharp of [true, false]) {
      const w = await make({ seed: 10 });
      const p = w.player!;
      run(w, 5);
      const points = [];
      for (let y = -0.75; y <= 0.8; y += 0.15) for (let z = -0.2; z <= 0.21; z += 0.1) points.push({ local: { x: -0.1, y, z }, dir: { x: -1, y: 0, z: 0 }, sharpness: 0.45 });
      const id = w.addEntity({
        material: 'dryWood',
        shape: { kind: 'box', hx: 0.1, hy: 1, hz: 0.3 },
        p: { x: 1.0, y: 1, z: 0 },
        state: 'fixed',
        sharpPoints: sharp ? points : [],
        look: 'snag',
      });
      run(w, 2);
      p.vel.set(4, 0, 0);
      p.enterKnockdown();
      const ev = run(w, 90);
      const hits = impactsOn(ev, p).filter((e) => e.cause.entityId === id);
      if (sharp) {
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].damage).toBeGreaterThan(0);
        expect(hits[0].cause.feature).toBe('sharpPoint');
        expect(hits[0].dv).toEqual({ x: 0, y: 0, z: 0 }); // a solid pair: the solver stopped it
        expect(p.hp).toBeLessThan(100);
      } else {
        expect(hits).toHaveLength(0);
        expect(p.hp).toBe(100);
      }
    }
  });

  it('a kicking shin against a ruler zone scores nothing; the same zone meeting the standing player’s shin does', async () => {
    for (const kicking of [true, false]) {
      const w = await make({ seed: 11 });
      const p = w.player!;
      const g = addFakeRuler(w);
      run(w, 5);
      const kick = Object.values(p.moves).find((m) => m.limb === 'footR')!;
      expect(kick).toBeDefined();
      const shin = w.zones.zonePose(p, 'shinR')!.p;
      const start = { x: shin.x - 1, y: shin.y, z: shin.z };
      const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y, start.z));
      rulerCollider(w, g, 'shinL', body, sensorDesc(RAPIER.ColliderDesc.ball(0.06)));
      const limb0 = w.contacts.unscored.limb;
      const ev: WorldEvent[] = [];
      // Homing on the shin from its right side at 0.1 m a tick (6 m/s), wherever the kick's chamber puts it.
      let d = 1;
      let met = false;
      for (let t = 0; t < 40; t++) {
        if (kicking) {
          p.setState('attack');
          p.move = kick;
        }
        if (!met) d = Math.max(0, d - 0.1);
        const s = w.zones.zonePose(p, 'shinR')!.p;
        body.setNextKinematicTranslation({ x: s.x - d, y: s.y, z: s.z });
        w.step();
        ev.push(...w.events);
        if (w.contacts.touching({ kind: 'fighter', id: g.id, part: 'ruler' }, zoneOf(p)) > 0) met = true;
      }
      expect(met).toBe(true);
      if (kicking) {
        expect(ev.filter((e) => e.type === 'impact')).toHaveLength(0);
        expect(w.contacts.unscored.limb).toBeGreaterThan(limb0);
        expect(p.hp).toBe(100);
      } else {
        const hits = impactsOn(ev, p);
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0].cause).toMatchObject({ kind: 'creature', fighterId: g.id });
        expect(hits[0].bone).toBe('shinR');
        expect(Math.hypot(hits[0].dv.x, hits[0].dv.z)).toBeGreaterThan(0);
        // The ruler's side is its own motion: v_safe takes it all, so it scores nothing.
        expect(impactsOn(ev, g)).toHaveLength(0);
      }
      expect(ruler.rulerDamage).not.toHaveBeenCalled();
    }
  });
});

describe('stakes hurt and kill through the rule (§13.1 P09 Done)', () => {
  it('an ape knocked off a 2 m scaffold onto a bed of pointed stakes is wounded by their points and killed environmentally', async () => {
    const w = await make({ seed: 17 });
    w.addEntity({ material: 'stone', shape: { kind: 'box', hx: 1, hy: 1, hz: 1 }, p: { x: 0, y: 1, z: 0 }, state: 'fixed', look: 'scaffold' });
    for (let x = 1.1; x < 2.7; x += 0.15) {
      for (let z = -0.45; z < 0.46; z += 0.15) {
        w.addEntity({
          material: 'dryWood',
          shape: { kind: 'cylinder', halfHeight: 0.4, r: 0.03, sides: 8 },
          p: { x, y: 0.4, z },
          state: 'anchored',
          sharpPoints: [{ local: { x: 0, y: 0.4, z: 0 }, dir: { x: 0, y: 1, z: 0 }, sharpness: 0.6 }],
          look: 'stake',
        });
      }
    }
    run(w, 2); // the scaffold is visible to the teleport's support probe after a step
    const a = addApe(w, 0.75, 0, Math.PI / 2);
    run(w, 10);
    expect(a.pos.y).toBeCloseTo(2, 1);
    a.hp = 30;
    a.vel.set(3, 0, 0);
    a.enterKnockdown();
    const ev: WorldEvent[] = [];
    let ko: unknown;
    for (let t = 0; t < 120 && !ko; t++) {
      w.step();
      ev.push(...w.events);
      ko = w.combat.events.find((e) => e.type === 'ko' && e.victim === a);
    }
    const stakeHits = impactsOn(ev, a).filter((e) => e.cause.kind === 'entity' && e.cause.feature === 'sharpPoint');
    expect(stakeHits.length).toBeGreaterThan(0);
    expect(stakeHits.reduce((sum, e) => sum + e.damage, 0)).toBeGreaterThanOrEqual(30);
    expect(ko).toMatchObject({ by: 'impact', environmental: true });
    expect(a.hp).toBe(0);
  });
});

describe('the impact trip (§4.7 step 9, SPEC:305)', () => {
  it('a blocking-class body (≥ impactTripMinKg) at > tripSpeed on a standing ruler’s shin requests a trip; lighter or slower ones don’t', async () => {
    for (const [mass, v, trips] of [
      [600, 6, true],
      [300, 6, false],
      [600, 3, false],
    ] as const) {
      const w = await make({ seed: 18, player: false });
      WORLD_TUNING.gravityY = 0;
      const g = addFakeRuler(w);
      const knee = g.rig.shinL.pos.y;
      const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, knee - 0.8, 0));
      rulerCollider(w, g, 'shinL', body, sensorDesc(RAPIER.ColliderDesc.capsule(0.6, 0.25)));
      // A stone block 0.5 × 0.5 m in section, as long as its mass needs (2,600 kg/m³).
      const hx = mass / 2600 / 0.25 / 2;
      const id = w.addEntity({ material: 'stone', shape: { kind: 'box', hx, hy: 0.25, hz: 0.25 }, p: { x: -1.5, y: knee - 0.8, z: 0 }, lin: { x: v, y: 0, z: 0 }, look: 'block' });
      const e = w.entities.get(id)!;
      expect(e.mass).toBeCloseTo(mass, 6);
      const trip = vi.spyOn(w.rulers, 'requestTrip');
      const queue = vi.spyOn(w.entities, 'queueImpulse');
      const ev = run(w, 40, () => {
        e.body!.setLinvel({ x: v, y: 0, z: 0 }, true);
      });
      // The block met the shin and was scored on the ruler; a standing ruler takes no Δv from it (its only momentum
      // exchange is the mover's shove and this trip check, RF-4), so the block gets no reaction either.
      const hits = impactsOn(ev, g).filter((x) => x.cause.entityId === id);
      expect(hits.length, `${mass} kg at ${v} m/s`).toBeGreaterThan(0);
      for (const h of hits) expect(h.dv, `${mass} kg at ${v} m/s`).toEqual({ x: 0, y: 0, z: 0 });
      expect(queue.mock.calls.filter((c) => c[0] === id), `${mass} kg at ${v} m/s`).toHaveLength(0);
      if (trips) {
        expect(trip).toHaveBeenCalledTimes(1);
        expect(trip.mock.calls[0][0]).toBe(g);
        expect(trip.mock.calls[0][1]).toBe('impact');
        expect(trip.mock.calls[0][2]).toMatchObject({ kind: 'entity', entityId: id });
      } else expect(trip, `${mass} kg at ${v} m/s`).not.toHaveBeenCalled();
    }
  });

  it('a static impactor trips too (the "or anchored" of step 9): a sharp anchored stake met by the shin at 6 m/s; the same stake blunt is a brush, left to the mover’s obstacle trip', async () => {
    for (const sharp of [true, false]) {
      const w = await make({ seed: 19, player: false });
      const g = addFakeRuler(w);
      const knee = g.rig.shinL.pos.y;
      const y = knee - 0.8;
      // An anchored horizontal stake, its point at x = 0 aimed at the shin coming from −x.
      const id = w.addEntity({
        material: 'dryWood',
        shape: { kind: 'box', hx: 0.4, hy: 0.04, hz: 0.04 },
        p: { x: 0.4, y, z: 0 },
        state: 'anchored',
        sharpPoints: sharp ? [{ local: { x: -0.4, y: 0, z: 0 }, dir: { x: -1, y: 0, z: 0 }, sharpness: 0.6 }] : [],
        look: 'stake',
      });
      expect(w.entities.isAnchored(w.entities.get(id)!)).toBe(true);
      // The standing ruler's shin walking into it at 0.1 m a tick (6 m/s > tripSpeed): its own motion.
      let x = -1.5;
      const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, 0));
      rulerCollider(w, g, 'shinL', body, sensorDesc(RAPIER.ColliderDesc.ball(0.25)));
      const trip = vi.spyOn(w.rulers, 'requestTrip');
      const brush0 = w.contacts.unscored.brush;
      const ev = run(w, 30, () => {
        x += 0.1;
        body.setNextKinematicTranslation({ x, y, z: 0 });
      });
      const hits = impactsOn(ev, g).filter((e) => e.cause.entityId === id);
      if (sharp) {
        expect(hits).toHaveLength(1);
        expect(hits[0].cause.feature).toBe('sharpPoint');
        expect(hits[0].dv).toEqual({ x: 0, y: 0, z: 0 });
        expect(trip).toHaveBeenCalledTimes(1);
        expect(trip.mock.calls[0][1]).toBe('impact');
        expect(trip.mock.calls[0][2]).toMatchObject({ kind: 'entity', entityId: id });
      } else {
        expect(hits).toHaveLength(0);
        expect(w.contacts.unscored.brush).toBeGreaterThan(brush0);
        expect(trip).not.toHaveBeenCalled();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Momentum through the solver (RF-4)
// ---------------------------------------------------------------------------

describe('momentum (RF-4)', () => {
  it('a tripped ruler and a log exchange momentum only through the solver: no Δv, no queued reaction', async () => {
    const w = await make({ seed: 12, player: false });
    const g = addFakeRuler(w);
    const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.6, 0));
    rulerCollider(w, g, 'chest', body, RAPIER.ColliderDesc.cuboid(1.5, 0.5, 1).setMass(2865).setCollisionGroups(collisionGroups('RULER_SOLID')).setSolverGroups(solverGroups('RULER_SOLID')));
    g.setState('tripped');
    run(w, 20);
    const id = spawnLog(w, { p: { x: 0, y: 4, z: 0 }, length: 2.5, mass: 300 });
    const queue = vi.spyOn(w.entities, 'queueImpulse');
    const dv = vi.spyOn(w.downed, 'queueDv');
    const ev = run(w, 60);
    const hits = impactsOn(ev, g).filter((e) => e.cause.entityId === id);
    expect(hits.length).toBe(1);
    expect(hits[0].dv).toEqual({ x: 0, y: 0, z: 0 });
    expect(hits[0].energy).toBeGreaterThan(1000);
    expect(ruler.rulerDamage).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls.filter((c) => c[0] === id)).toHaveLength(0);
    expect(dv).not.toHaveBeenCalled();
    // The solver stopped the log on the body (it rests on it, well above the ground).
    expect(w.entities.get(id)!.pose.p.y).toBeGreaterThan(1.2);
  });

  it('a standing ruler’s foot on a 66 kg mat gives it no reaction impulse', async () => {
    const w = await make({ seed: 13, player: false });
    const g = addFakeRuler(w);
    const mat = w.addEntity({ material: 'leaves', shape: { kind: 'box', hx: 1, hy: 0.165, hz: 0.5 }, p: { x: 0, y: 0.165, z: 0 }, look: 'mat' });
    expect(w.entities.get(mat)!.mass).toBeCloseTo(66, 6);
    run(w, 30);
    // The shin comes down slowly (0.6 m/s): at 6 m/s it would score ≈ 1.2 kJ on a mat whose E_b is 66 J and break it
    // (§4.10, P10), which isn't what this test is about.
    const body = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.9, 0));
    rulerCollider(w, g, 'shinL', body, sensorDesc(RAPIER.ColliderDesc.cuboid(0.4, 0.3, 0.4)));
    const queue = vi.spyOn(w.entities, 'queueImpulse');
    const dv = vi.spyOn(w.downed, 'queueDv');
    let y = 0.9;
    const ev = run(w, 50, () => {
      y = Math.max(0.5, y - 0.01);
      body.setNextKinematicTranslation({ x: 0, y, z: 0 });
    });
    expect(w.contacts.touching(ent(mat), { kind: 'fighter', id: g.id, part: 'ruler' })).toBeGreaterThan(0);
    expect(queue.mock.calls.filter((c) => c[0] === mat)).toHaveLength(0);
    expect(dv).not.toHaveBeenCalled();
    expect(impactsOn(ev, g)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Released and thrown entities (RF-3, D-31)
// ---------------------------------------------------------------------------

describe('released and thrown entities', () => {
  it('a 40 kg log thrown up from the hands doesn’t hit its thrower on the way out, and does on the way back down', async () => {
    const w = await make({ seed: 14 });
    const p = w.player!;
    run(w, 5);
    const head = w.zones.zonePose(p, 'head')!.p;
    const id = spawnLog(w, { p: { x: head.x, y: head.y - 0.1, z: head.z }, length: 1.6, mass: 40 });
    const e = w.entities.get(id)!;
    e.body!.setLinvel({ x: 0, y: 4.5, z: 0 }, true);
    w.entities.release(e, p.id);
    e.thrown = { by: p.id, tick: w.tick };
    const rel0 = w.contacts.unscored.released;
    let clearedAt = -1;
    let hit: ImpactEv | undefined;
    for (let t = 0; t < 120 && !hit; t++) {
      w.step();
      if (clearedAt < 0 && e.releasedBy === null) clearedAt = w.tick;
      hit = impactsOn(w.events, p).find((x) => x.cause.entityId === id);
    }
    expect(w.contacts.unscored.released).toBeGreaterThan(rel0);
    expect(clearedAt).toBeGreaterThan(0);
    expect(hit).toBeDefined();
    expect(hit!.tick).toBeGreaterThan(clearedAt);
    expect(hit!.damage).toBeGreaterThan(0);
    // It came down on its thrower before touching anything else: still his (held, D-31).
    expect(hit!.cause).toMatchObject({ kind: 'entity', held: true, fighterId: p.id });
    expect(e.thrown).toBeNull();
  });

  it('a thrown spear’s cause is held: its point leads (sharpPoint), it is no longer thrown after the hit, and its kill is not environmental', async () => {
    const w = await make({ seed: 15 });
    const p = w.player!;
    const a = addApe(w, 0, 6, -Math.PI / 2);
    run(w, 5);
    a.hp = 4;
    const chest = w.zones.zonePose(a, 'chest')!.p;
    const id = spawnStick(w, { p: { x: chest.x - 1.6, y: chest.y, z: chest.z }, length: 1.4, r: 0.025, sharp: { end: 1, s: 0.8 } });
    const e = w.entities.get(id)!;
    e.thrown = { by: p.id, tick: w.tick };
    e.body!.setLinvel({ x: 8, y: 0.3, z: 0 }, true);
    let hit: ImpactEv | undefined;
    for (let t = 0; t < 40 && !hit; t++) {
      w.step();
      hit = impactsOn(w.events, a).find((x) => x.cause.entityId === id);
    }
    expect(hit).toBeDefined();
    expect(hit!.cause).toMatchObject({ kind: 'entity', entityId: id, held: true, fighterId: p.id, feature: 'sharpPoint' });
    expect(hit!.energy).toBeGreaterThan(20);
    expect(e.thrown).toBeNull();
    const ko = w.combat.events.find((c) => c.type === 'ko' && c.victim === a);
    expect(ko).toMatchObject({ by: 'impact', environmental: false, killer: p });
  });
});

// ---------------------------------------------------------------------------
// Rope sensors and the tripwire sink (phase 9d, §4.9)
// ---------------------------------------------------------------------------

describe('rope sensors and the tripwire sink (phase 9d)', () => {
  /** A rope sensor (a parentless capsule along x at height y, as JointStore makes them) registered as joint `joint`. */
  function ropeSensor(w: World, joint: number, y: number, z = 0): RAPIER.Collider {
    const c = w.physics.rapier.createCollider(
      RAPIER.ColliderDesc.capsule(1.5, 0.02)
        .setRotation({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 })
        .setTranslation(0, y, z)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ROPE'))
        .setSolverGroups(solverGroups('ROPE')),
    );
    w.physics.register(c, { kind: 'rope', joint });
    return c;
  }

  it('JointStore.tripwire(w, joint, by) once per new episode with a crossing dynamic entity; a bounce inside the cooldown doesn’t call it', async () => {
    const w = await make({ seed: 22, player: false });
    WORLD_TUNING.gravityY = 0;
    ropeSensor(w, 5, 1);
    const calls: [World, number, Owner][] = [];
    const sink = w.joints as unknown as TripwireSink;
    sink.tripwire = (ww, joint, by) => void calls.push([ww, joint, by]);
    const id = spawnLog(w, { p: { x: 0.3, y: 1.6, z: 0 }, q: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, length: 1.2, mass: 20 });
    const e = w.entities.get(id)!;
    const touching = () => w.contacts.touching(ent(id), { kind: 'rope', joint: 5 });
    // Down through the rope, straight back up through it (a bounce), then away and down through it again.
    let phase: 'down' | 'up' | 'away' | 'again' = 'down';
    let leftAt = -1;
    let backAt = -1;
    let crossed = 0;
    let met = false;
    const b0 = w.contacts.unscored.bounce;
    for (let t = 0; t < 200 && crossed < 3; t++) {
      e.body!.setLinvel({ x: 0, y: phase === 'down' || phase === 'again' ? -4 : 4, z: 0 }, true);
      w.step();
      const n = touching();
      if (n > 0) met = true;
      if (phase === 'down' && met && n === 0) {
        phase = 'up';
        leftAt = w.tick;
        crossed++;
      } else if (phase === 'up' && n > 0 && backAt < 0) backAt = w.tick;
      else if (phase === 'up' && backAt > 0 && n === 0 && e.pose.p.y > 1.6) {
        phase = 'away';
        crossed++;
      } else if (phase === 'away' && e.pose.p.y > 2.4) phase = 'again';
      else if (phase === 'again' && e.pose.p.y < 0.6) crossed++;
    }
    expect(crossed).toBe(3);
    expect(backAt).toBeGreaterThan(leftAt);
    expect(backAt - leftAt).toBeLessThanOrEqual(DAMAGE_TUNING.impactCooldownTicks);
    expect(w.contacts.unscored.bounce).toBeGreaterThan(b0);
    expect(calls).toHaveLength(2);
    for (const [ww, joint, by] of calls) {
      expect(ww).toBe(w);
      expect(joint).toBe(5);
      expect(by).toEqual({ kind: 'entity', id });
    }
  });

  it('a creature crossing inside its contact grace doesn’t trip it, outside it does; a joint store without the method fails loudly', async () => {
    const w = await make({ seed: 23 });
    const p = w.player!;
    run(w, 5);
    const calls: Owner[] = [];
    const sink = w.joints as unknown as TripwireSink;
    sink.tripwire = (_w, _joint, by) => void calls.push(by);
    ropeSensor(w, 7, 0.3, 4);
    // Teleported onto the rope: its zones start against it inside the teleport's grace.
    const g0 = w.contacts.unscored.grace;
    w.teleport(p, 0, 4, 0);
    run(w, 5);
    expect(w.contacts.touching(zoneOf(p), { kind: 'rope', joint: 7 })).toBeGreaterThan(0);
    expect(w.contacts.unscored.grace).toBeGreaterThan(g0);
    expect(calls).toHaveLength(0);
    // Away, then walking back across it: a new episode outside the grace.
    w.teleport(p, 0, 1, 0);
    run(w, 20);
    expect(w.contacts.touching(zoneOf(p), { kind: 'rope', joint: 7 })).toBe(0);
    for (let t = 0; t < 90 && calls.length === 0; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
      w.step();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'fighter', id: p.id, part: 'zone' });
    // Without the method the first crossing throws instead of silently never tripping.
    Object.defineProperty(w.joints, 'tripwire', { value: undefined, configurable: true });
    w.teleport(p, 0, 1, 0);
    run(w, 20);
    expect(() => {
      for (let t = 0; t < 90; t++) {
        w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
        w.step();
      }
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// The save record (RR-19)
// ---------------------------------------------------------------------------

describe('ContactSystem records', () => {
  it('round-trip the touching counts, episode marks and graces (sorted, plain JSON); a bad owner key throws', async () => {
    const w = await make({ seed: 16 });
    const p = w.player!;
    const a = addApe(w, 4, 0);
    run(w, 5);
    spawnLog(w, { p: { x: 0, y: 3, z: 0 }, length: 2, mass: 40 });
    spawnLog(w, { p: { x: 4, y: 0.4, z: 2 }, length: 2, mass: 40 });
    run(w, 40);
    w.contacts.grace(a.id, w.tick + 7);
    const rec = w.contacts.toRecord();
    expect(rec.length).toBeGreaterThan(0);
    const sorted = [...rec].sort((x, y) => x.creature - y.creature || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
    expect(rec).toEqual(sorted);
    expect(rec.some((r) => r.creature < 0)).toBe(true); // an entity's own episode (the log on the terrain)
    expect(rec.some((r) => r.creature === p.id)).toBe(true);
    const grace = w.contacts.graceRecord();
    expect(grace).toContainEqual([a.id, w.tick + 7]);
    w.contacts.restoreRecord(JSON.parse(JSON.stringify(rec)));
    w.contacts.restoreGrace(JSON.parse(JSON.stringify(grace)));
    expect(w.contacts.toRecord()).toEqual(rec);
    expect(w.contacts.graceRecord()).toEqual(grace);
    expect(w.contacts.inGrace(a.id, w.tick + 6)).toBe(true);
    expect(w.contacts.inGrace(a.id, w.tick + 7)).toBe(false);
    expect(() => w.contacts.restoreRecord([{ creature: 1, owner: 'nonsense:x', touching: 1, episodeStart: 1, cooldownUntil: -1 }])).toThrow(/bad owner key/);
  });

  it('a world rebuilt from the records (P13’s load) goes on as the saved one: the re-raised starts rebuild the counts, score nothing, and a restored episode still ends and starts again', async () => {
    const opts = { seed: 21, player: false } as const;
    // The saved world: log L1 at rest on the terrain, L2 at rest across it, L3 still falling at the save.
    const a = await make(opts);
    const l1 = spawnLog(a, { p: { x: 0, y: 0.5, z: 0 }, length: 2.4, mass: 60 });
    const l2 = spawnLog(a, { p: { x: 0, y: 1.2, z: 0 }, q: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, length: 2.4, mass: 40 });
    run(a, 120);
    const l3 = spawnLog(a, { p: { x: 5, y: 2.5, z: 0 }, length: 2, mass: 40 });
    run(a, 3);
    const rec = a.contacts.toRecord();
    expect(rec.find((r) => r.creature === -l1 && r.owner === 'terrain')?.touching).toBeGreaterThan(0);
    expect(rec.find((r) => r.creature === -l1 && r.owner === `entity:${l2}`)?.touching).toBeGreaterThan(0);
    expect(rec.find((r) => r.creature === -l3)).toBeUndefined(); // L3 hasn't landed
    // The rebuilt world: fresh Rapier bodies from the entity records (an empty narrow phase), then the contact records.
    const b = await make(opts);
    b.combat.frame = a.tick;
    b.entities.restoreRecord(JSON.parse(JSON.stringify(a.entities.toRecord())), []);
    b.contacts.restoreRecord(JSON.parse(JSON.stringify(rec)));
    expect(b.contacts.toRecord()).toEqual(rec);
    const lands = (w: World) =>
      w.events.filter((e): e is Extract<WorldEvent, { type: 'land' }> => e.type === 'land').map((e) => ({ tick: w.tick, entity: e.entity, energy: e.energy }));
    const counts = (w: World) => w.contacts.toRecord().map((r) => [r.creature, r.owner, r.touching]);
    const onGround = (w: World) => w.contacts.touching(ent(l1), { kind: 'terrain' });
    const evA: { tick: number; entity: number | null; energy: number }[] = [];
    const evB: typeof evA = [];
    const cont0 = b.contacts.unscored.continuing;
    const left = { a: false, b: false };
    let liftTick = -1;
    for (let t = 0; t < 120; t++) {
      // 40 ticks after the load L1 is thrown up off the terrain: its restored episode with the terrain ends, and its
      // landing is a new one, in both worlds.
      if (t === 40) {
        liftTick = a.tick + 1;
        for (const w of [a, b]) w.entities.get(l1)!.body!.setLinvel({ x: 0, y: 4, z: 1.5 }, true);
      }
      a.step();
      b.step();
      evA.push(...lands(a));
      evB.push(...lands(b));
      if (t === 0) {
        expect(b.contacts.unscored.continuing).toBeGreaterThan(cont0); // the re-raised starts, going on
        expect(lands(b)).toHaveLength(0);
      }
      // Until the throw, the counts are the saved world's from the first step on (not the saved count plus every
      // re-raised start), through L3's landing. (After it the two drift apart: a rebuilt world matches the saved one
      // within SPEC:730's 1 cm, not bit for bit.)
      if (t < 40) expect(counts(b), `tick ${b.tick}`).toEqual(counts(a));
      if (t > 40 && onGround(a) === 0) left.a = true;
      if (t > 40 && onGround(b) === 0) left.b = true;
    }
    expect(left).toEqual({ a: true, b: true });
    // L3's first landing (after the load) scores the same in both, and so does L1's new one; nothing re-raised scored.
    const l3A = evA.filter((e) => e.entity === l3);
    const l3B = evB.filter((e) => e.entity === l3);
    expect(l3A).toHaveLength(1);
    expect(l3B.map((e) => e.tick)).toEqual(l3A.map((e) => e.tick));
    expect(l3B[0].energy).toBeCloseTo(l3A[0].energy, 6);
    const l1A = evA.filter((e) => e.entity === l1);
    const l1B = evB.filter((e) => e.entity === l1);
    expect(l1A.length).toBeGreaterThan(0);
    expect(l1A[0].tick).toBeGreaterThan(liftTick);
    expect(l1B[0]?.tick).toBe(l1A[0].tick);
  });
});
