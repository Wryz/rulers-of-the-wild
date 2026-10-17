// PhysicsWorld (docs/M1-DESIGN.md §1.5.6, §3 phases 5-8, §4.3; package P05): the memoised init, owners and their
// order, the pre-step store with one tick of history and its reset, the post-step snapshot, the sorted drain (removed
// colliders included) and determinism of two identical worlds.
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DT } from '../src/sim/math';
import { collisionGroups, G, GROUP, solverGroups } from '../src/world/groups';
import {
  compareOwners,
  isPhysicsReady,
  ownerKey,
  PhysicsWorld,
  physicsInitCount,
  physicsReady,
} from '../src/world/physics';
import { WorldQueries } from '../src/world/queries';
import { Terrain } from '../src/world/terrain';
import type { Owner, Pose3, QueryFilter, Shape } from '../src/world/types';
import { WORLD_TUNING } from '../src/world/worldTuning';
import type { Fighter } from '../src/sim/fighter';

const worlds: PhysicsWorld[] = [];
function makeWorld(): PhysicsWorld {
  const p = new PhysicsWorld();
  worlds.push(p);
  return p;
}

afterEach(() => {
  for (const p of worlds.splice(0)) p.free();
});

beforeAll(async () => {
  await physicsReady();
});

const entity = (id: number): Owner => ({ kind: 'entity', id });

/** A fixed ground slab (an "entity" owner) and a 1 m box falling onto it from `dropH`. */
function groundAndBox(p: PhysicsWorld, dropH: number): { ground: RAPIER.Collider; box: RAPIER.Collider; body: RAPIER.RigidBody } {
  const groundBody = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const ground = p.rapier.createCollider(
    RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setCollisionGroups(collisionGroups('ENTITY')).setSolverGroups(solverGroups('ENTITY')),
    groundBody,
  );
  p.register(ground, entity(1));
  const body = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, dropH, 0));
  const box = p.rapier.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
      .setDensity(100)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(collisionGroups('ENTITY'))
      .setSolverGroups(solverGroups('ENTITY')),
    body,
  );
  p.register(box, entity(2));
  return { ground, box, body };
}

describe('physicsReady', () => {
  it('initialises Rapier and recast once per process and returns the same promise', async () => {
    const a = physicsReady();
    const b = physicsReady();
    expect(a).toBe(b);
    await a;
    expect(isPhysicsReady()).toBe(true);
    expect(physicsInitCount()).toBe(1);
  });

  it('builds the Rapier world with the live gravity and the fixed step', () => {
    const p = makeWorld();
    expect(p.rapier.gravity.y).toBeCloseTo(WORLD_TUNING.gravityY, 6);
    expect(p.rapier.timestep).toBe(Math.fround(DT));
  });
});

describe('groups (§2.11)', () => {
  it('packs membership over filter and keeps every solver membership to its own bit', () => {
    expect(G(0x002, 0x0ff)).toBe(0x000200ff);
    for (const g of Object.keys(GROUP) as (keyof typeof GROUP)[]) {
      expect(collisionGroups(g) >>> 16, g).toBe(GROUP[g]);
      expect(solverGroups(g) >>> 16, g).toBe(GROUP[g]);
    }
    // Interaction is symmetric: each side's membership is in the other's filter.
    const meets = (a: number, b: number) => ((a >>> 16) & b & 0xffff) !== 0 && ((b >>> 16) & a & 0xffff) !== 0;
    for (const a of Object.keys(GROUP) as (keyof typeof GROUP)[]) {
      for (const b of Object.keys(GROUP) as (keyof typeof GROUP)[]) {
        expect(meets(collisionGroups(a), collisionGroups(b)), `${a}-${b}`).toBe(meets(collisionGroups(b), collisionGroups(a)));
      }
    }
    // A falling log passes through the capsule (solver), but zones and capsules still meet entities (collision).
    expect(meets(solverGroups('ENTITY'), solverGroups('CHAR'))).toBe(false);
    expect(meets(collisionGroups('ENTITY'), collisionGroups('CHAR'))).toBe(true);
    expect(meets(collisionGroups('ZONE'), collisionGroups('ZONE'))).toBe(false);
    expect(meets(collisionGroups('RULER_ZONE'), collisionGroups('TERRAIN'))).toBe(false);
  });
});

describe('owners', () => {
  it('keys owners and orders them terrain < entity < fighter < rope, then by id, part and bone', () => {
    const list: Owner[] = [
      { kind: 'rope', joint: 2 },
      { kind: 'fighter', id: 3, part: 'zone', bone: 'shinL' },
      { kind: 'fighter', id: 3, part: 'kcc' },
      { kind: 'entity', id: 10 },
      { kind: 'fighter', id: 3, part: 'zone', bone: 'head' },
      { kind: 'entity', id: 9 },
      { kind: 'terrain' },
      { kind: 'fighter', id: 1, part: 'ruler', bone: 'chest' },
      { kind: 'fighter', id: 3, part: 'zone' },
    ];
    expect([...list].sort(compareOwners).map(ownerKey)).toEqual([
      'terrain',
      'entity:9',
      'entity:10',
      'fighter:1:ruler:chest',
      'fighter:3:kcc',
      'fighter:3:zone',
      'fighter:3:zone:head',
      'fighter:3:zone:shinL',
      'rope:2',
    ]);
  });

  it('maps handles to owners and keeps a removed collider’s owner until the next drain', () => {
    const p = makeWorld();
    const { box } = groundAndBox(p, 3);
    const h = box.handle;
    expect(p.ownerOf(h)).toEqual(entity(2));
    expect(p.keyOf(h)).toBe('entity:2');
    p.unregister(box);
    expect(p.ownerOf(h)).toEqual(entity(2));
    p.drain();
    expect(p.ownerOf(h)).toBeNull();
    expect(p.ownerOf(12345)).toBeNull();
  });
});

describe('the pre-step store (phase 5)', () => {
  it('stores an awake dynamic body as it arrives at the step, with last tick’s pose as prev', () => {
    const p = makeWorld();
    const { body } = groundAndBox(p, 5);
    p.storePreStep();
    p.step();
    p.drain();
    const v0 = body.linvel().y;
    const y0 = body.translation().y;
    p.storePreStep();
    const s1 = p.pre('entity:2')!;
    expect(s1.v.y).toBe(v0);
    expect(s1.p.y).toBe(y0);
    expect(s1.carryV).toEqual(s1.v);
    expect(s1.com.y).toBeCloseTo(y0, 6);
    p.step();
    // After the step the body is faster; the store still holds the arrival speed.
    expect(body.linvel().y).toBeLessThan(v0);
    expect(p.pre('entity:2')!.v.y).toBe(v0);
    p.storePreStep();
    expect(p.pre('entity:2')!.prevP.y).toBe(y0);
    // Fixed bodies are never stored.
    expect(p.pre('entity:1')).toBeNull();
  });

  it('gives a kinematic sensor zone the previous tick’s delta as its carry velocity, and 0 after resetHistory', () => {
    const p = makeWorld();
    const kin = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    const zone = p.rapier.createCollider(
      RAPIER.ColliderDesc.ball(0.2)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ZONE')),
      kin,
    );
    p.register(zone, { kind: 'fighter', id: 4, part: 'zone', bone: 'shinL' });
    const key = 'fighter:4:zone:shinL';
    const xs = [0, 0.05, 0.15, 0.3, 0.5, 0.75];
    const carry: number[] = [];
    for (let t = 1; t < xs.length; t++) {
      kin.setNextKinematicTranslation({ x: xs[t], y: 1, z: 0 });
      p.storePreStep();
      carry.push(p.pre(key)!.carryV.x);
      p.step();
      p.drain();
    }
    // The store at tick t sees the start-of-step pose x[t−1] and last tick's x[t−2]: carry = (x[t−1] − x[t−2]) / DT.
    expect(carry[0]).toBe(0);
    for (let t = 2; t < xs.length; t++) expect(carry[t - 1]).toBeCloseTo((xs[t - 1] - xs[t - 2]) / DT, 3);
    // A teleport: reset, and the jump is not a speed.
    kin.setNextKinematicTranslation({ x: 40, y: 1, z: 0 });
    p.storePreStep();
    p.step();
    p.drain();
    p.resetHistory(key);
    p.storePreStep();
    expect(p.pre(key)!.p.x).toBeCloseTo(40, 5);
    expect(p.pre(key)!.carryV).toEqual({ x: 0, y: 0, z: 0 });
  });

  /** A kinematic body with one sensor zone (fighter 4's shin) at x = 0, and a fixed 2 m stake (entity 1) at x = 40. */
  function zoneAndStake(p: PhysicsWorld): { kin: RAPIER.RigidBody; zone: RAPIER.Collider; key: string } {
    const sb = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(40, 1, 0));
    p.register(p.rapier.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 1, 0.1).setCollisionGroups(collisionGroups('ENTITY')), sb), entity(1));
    const kin = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    const zone = p.rapier.createCollider(
      RAPIER.ColliderDesc.ball(0.2)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ZONE')),
      kin,
    );
    p.register(zone, { kind: 'fighter', id: 4, part: 'zone', bone: 'shinL' });
    return { kin, zone, key: 'fighter:4:zone:shinL' };
  }

  it('a reset asked when a kinematic zone jumps between steps reads 0 at both stores around the jump (RF-1)', () => {
    const p = makeWorld();
    const { kin, key } = zoneAndStake(p);
    // Phase-4b targets: walking +0.02 m a tick, teleported onto the stake between ticks 3 and 4, walking on from there.
    const targets = [0.02, 0.04, 0.06, 40, 40.02, 40.04, 40.06];
    const carry: number[] = [];
    const starts: number[] = [];
    for (let t = 1; t <= targets.length; t++) {
      if (t === 4) p.resetHistory(key); // at the teleport, before the tick that poses the new place
      kin.setNextKinematicTranslation({ x: targets[t - 1], y: 1, z: 0 });
      p.storePreStep();
      carry.push(p.pre(key)!.carryV.x);
      p.step();
      for (const q of p.drain()) if (q.started && ownerKey(q.b) === key && ownerKey(q.a) === 'entity:1') starts.push(t);
    }
    // The store at tick t sees the pose set at t − 1: the 40 m jump shows at tick 5, and its pair starts there.
    expect(starts).toEqual([5]);
    expect(carry[0]).toBe(0);
    expect(carry[1]).toBeCloseTo(0.02 / DT, 3);
    expect(carry[2]).toBeCloseTo(0.02 / DT, 3);
    expect(carry[3]).toBe(0); // still the old pose (held)
    expect(carry[4]).toBe(0); // the new pose: never 2,400 m/s
    expect(carry[5]).toBeCloseTo(0.02 / DT, 2); // the history goes on from the new pose
    expect(carry[6]).toBeCloseTo(0.02 / DT, 2);
  });

  it('a reset on a parentless sensor zeroes only the store that shows the jump (setTranslation is immediate)', () => {
    const p = makeWorld();
    const rope = p.rapier.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.02).setSensor(true).setTranslation(0, 1, 0).setCollisionGroups(collisionGroups('ROPE')));
    p.register(rope, { kind: 'rope', joint: 9 });
    const targets = [0.02, 0.04, 0.06, 40, 40.02, 40.04];
    const carry: number[] = [];
    for (let t = 1; t <= targets.length; t++) {
      if (t === 4) p.resetHistory('rope:9');
      rope.setTranslation({ x: targets[t - 1], y: 1, z: 0 });
      p.storePreStep();
      carry.push(p.pre('rope:9')!.carryV.x);
      p.step();
      p.drain();
    }
    expect(carry[0]).toBe(0);
    expect(carry[2]).toBeCloseTo(0.02 / DT, 3);
    expect(carry[3]).toBe(0);
    expect(carry[4]).toBeCloseTo(0.02 / DT, 2);
    expect(carry[5]).toBeCloseTo(0.02 / DT, 2);
  });

  it('a reset whose pose never changes holds for two stores at most; a key not stored keeps it until it is', () => {
    const p = makeWorld();
    const { kin, zone, key } = zoneAndStake(p);
    const carryAfter = (target: number): number => {
      kin.setNextKinematicTranslation({ x: target, y: 1, z: 0 });
      p.storePreStep();
      const c = p.pre(key)?.carryV.x ?? NaN;
      p.step();
      p.drain();
      return c;
    };
    carryAfter(0);
    carryAfter(0);
    p.resetHistory(key); // a teleport onto the spot it already stands on
    expect(carryAfter(0)).toBe(0);
    expect(carryAfter(0.02)).toBe(0);
    expect(carryAfter(0.04)).toBeCloseTo(0.02 / DT, 3); // the walk is read again
    // Disabled (a downed fighter's zones), the key is not stored while the body is carried 10 m; the reset asked at the
    // disable waits for the stores after the enable, so the 10 m is never read as a speed.
    zone.setEnabled(false);
    p.resetHistory(key);
    expect(Number.isNaN(carryAfter(10))).toBe(true);
    expect(Number.isNaN(carryAfter(10.02))).toBe(true);
    zone.setEnabled(true);
    const after = [10.04, 10.06, 10.08, 10.1].map(carryAfter);
    expect(after[0]).toBe(0);
    for (const c of after) expect(Math.abs(c)).toBeLessThan(0.02 / DT + 0.01);
    expect(after[3]).toBeCloseTo(0.02 / DT, 2);
  });

  it('does not store a sleeping body', () => {
    const p = makeWorld();
    const { body } = groundAndBox(p, 0.5);
    body.sleep();
    p.storePreStep();
    expect(p.pre('entity:2')).toBeNull();
  });
});

describe('the post-step snapshot and the drain (phase 8)', () => {
  it('snapshots velocities exactly as the step left them', () => {
    const p = makeWorld();
    const { body } = groundAndBox(p, 4);
    for (let i = 0; i < 20; i++) {
      p.storePreStep();
      p.step();
      p.snapshotPostStep();
      const post = p.post('entity:2')!;
      expect(post.v).toEqual({ ...body.linvel() });
      expect(post.w).toEqual({ ...body.angvel() });
      body.applyImpulse({ x: 1, y: 0, z: 0 }, true); // a code impulse after the snapshot doesn't change it
      expect(p.post('entity:2')!.v).toEqual(post.v);
      p.drain();
    }
    expect(p.post('entity:1')).toBeNull();
  });

  it('turns collision events into owner pairs, lower owner first, sorted, and reports a removed collider’s stop', () => {
    const p = makeWorld();
    const { box, body } = groundAndBox(p, 0.6);
    // A sensor rope across the box's fall line, owned by joint 7, and a second box (entity 3) beside it.
    const rope = p.rapier.createCollider(
      RAPIER.ColliderDesc.capsule(2, 0.02)
        .setSensor(true)
        .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
        .setTranslation(0, 0.6, 0)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ROPE')),
    );
    p.register(rope, { kind: 'rope', joint: 7 });
    const b3 = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(3, 0.6, 0));
    const box3 = p.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(collisionGroups('ENTITY')).setSolverGroups(solverGroups('ENTITY')),
      b3,
    );
    p.register(box3, entity(3));
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      p.storePreStep();
      p.step();
      const pairs = p.drain();
      for (let k = 0; k < pairs.length; k++) {
        const q = pairs[k];
        expect(compareOwners(q.a, q.b)).toBeLessThanOrEqual(0);
        if (k > 0) {
          const o = pairs[k - 1];
          expect(compareOwners(o.a, q.a) || compareOwners(o.b, q.b)).toBeLessThanOrEqual(0);
        }
        expect(q.sensor).toBe(q.b.kind === 'rope');
        seen.push(`${ownerKey(q.a)}|${ownerKey(q.b)}|${q.started ? 'start' : 'stop'}`);
      }
    }
    expect(seen).toContain('entity:1|entity:2|start');
    expect(seen).toContain('entity:1|entity:3|start');
    expect(seen).toContain('entity:2|rope:7|start');
    // Remove the resting box: its stop arrives after the next step, with its owner and no collider.
    p.unregister(box);
    p.rapier.removeRigidBody(body);
    p.storePreStep();
    p.step();
    const stops = p.drain().filter((q) => !q.started);
    const stop = stops.find((q) => ownerKey(q.b) === 'entity:2' || ownerKey(q.a) === 'entity:2');
    expect(stop).toBeDefined();
    expect(stop!.a).toEqual(entity(1));
    expect(stop!.cb).toBeNull();
    expect(stop!.ca).not.toBeNull();
  });

  it('counts contact-force events for the dev cross-check only', () => {
    const p = makeWorld();
    const { box } = groundAndBox(p, 0.6);
    box.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    box.setContactForceEventThreshold(1);
    let forces = 0;
    for (let i = 0; i < 30; i++) {
      p.storePreStep();
      p.step();
      p.drain();
      forces += p.forceEventCount;
    }
    expect(forces).toBeGreaterThan(0);
  });
});

describe('scene queries (WorldQueries, §1.5.6)', () => {
  const ID: Pose3['q'] = { x: 0, y: 0, z: 0, w: 1 };
  /**
   * Flat terrain (50 m) and, created in reverse owner order so the sort is what orders them: a rope sensor (joint 9) at
   * x 20; fighter 3's kinematic body at (15, 1, 0) with a zone ball (r 0.4) and a KCC capsule at z 3; a 5 kg dynamic box
   * (entity 2, two colliders) at x 10; an 800 kg fixed box (entity 1) at x 5, 1 × 2 × 1 m, standing on the terrain.
   */
  function scene(): { p: PhysicsWorld; q: WorldQueries } {
    const p = makeWorld();
    new Terrain(p, 50);
    p.primeQueries();
    const colliders = new Map<number, RAPIER.Collider>();
    const mass = new Map<number, number>([
      [1, 800],
      [2, 5],
    ]);
    const rope = p.rapier.createCollider(RAPIER.ColliderDesc.capsule(1, 0.02).setSensor(true).setTranslation(20, 1, 0).setCollisionGroups(collisionGroups('ROPE')));
    p.register(rope, { kind: 'rope', joint: 9 });
    const k = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(15, 1, 0));
    p.register(p.rapier.createCollider(RAPIER.ColliderDesc.ball(0.4).setSensor(true).setCollisionGroups(collisionGroups('ZONE')), k), { kind: 'fighter', id: 3, part: 'zone', bone: 'chest' });
    p.register(p.rapier.createCollider(RAPIER.ColliderDesc.capsule(0.6, 0.3).setTranslation(0, 0, 3).setCollisionGroups(collisionGroups('CHAR')), k), { kind: 'fighter', id: 3, part: 'kcc' });
    const b2 = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(10, 1, 0).setGravityScale(0));
    const c2 = p.rapier.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(0, 0.5, 0).setCollisionGroups(collisionGroups('ENTITY')), b2);
    p.register(c2, entity(2));
    p.register(p.rapier.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(0, -0.5, 0).setCollisionGroups(collisionGroups('ENTITY')), b2), entity(2));
    colliders.set(2, c2);
    const b1 = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(5, 1, 0));
    const c1 = p.rapier.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 1, 0.5).setCollisionGroups(collisionGroups('ENTITY')), b1);
    p.register(c1, entity(1));
    colliders.set(1, c1);
    p.step(); // new colliders are found by queries after a step
    p.drain();
    return { p, q: new WorldQueries(p, { mass: (id) => mass.get(id) ?? 0, collider: (id) => colliders.get(id) ?? null }) };
  }

  const key = (o: Owner | undefined): string | undefined => (o ? ownerKey(o) : undefined);

  it('castRay: toi, point and outward normal, and every filter', () => {
    const { q } = scene();
    const along = (f: QueryFilter, z = 0) => q.castRay({ x: 0, y: 1, z }, { x: 2, y: 0, z: 0 }, 30, f);
    const hit = along({})!;
    expect(hit.owner).toEqual(entity(1));
    expect(hit.toi).toBeCloseTo(4.5, 5);
    expect(hit.point.x).toBeCloseTo(4.5, 5);
    expect(hit.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(key(along({ entities: 'static' })?.owner)).toBe('entity:1');
    expect(key(along({ exclude: { entities: [1] } })?.owner)).toBe('entity:2');
    expect(along({ exclude: { entities: [1] }, entities: 'static' })).toBeNull(); // the dynamic box isn't static
    expect(along({ exclude: { entities: [1] }, minEntityMassKg: 100 })).toBeNull(); // 5 kg < 100 kg
    expect(key(along({ minEntityMassKg: 800 })?.owner)).toBe('entity:1');
    expect(along({ entities: 'none' })).toBeNull(); // sensors and fighters are off by default
    expect(key(along({ entities: 'none', fighters: 'zones' })?.owner)).toBe('fighter:3:zone:chest');
    expect(along({ entities: 'none', fighters: 'zones', exclude: { fighters: [3] } })).toBeNull();
    expect(key(along({ entities: 'none', ropes: true })?.owner)).toBe('rope:9');
    expect(key(along({ entities: 'none', fighters: 'kcc' }, 3)?.owner)).toBe('fighter:3:kcc');
    expect(along({ entities: 'none', fighters: 'zones' }, 3)).toBeNull(); // the capsule is not a zone
    // Terrain: on unless the filter turns it off.
    expect(key(q.castRay({ x: 2, y: 5, z: 2 }, { x: 0, y: -1, z: 0 }, 10, {})?.owner)).toBe('terrain');
    expect(q.castRay({ x: 2, y: 5, z: 2 }, { x: 0, y: -1, z: 0 }, 10, { terrain: false })).toBeNull();
    expect(q.castRay({ x: 2, y: 5, z: 2 }, { x: 0, y: 0, z: 0 }, 10, {})).toBeNull(); // no direction
  });

  it('castShape: time of impact in the units of vel, with the struck collider’s world point and outward normal', () => {
    const { q } = scene();
    const ball = { kind: 'ball', r: 0.25 } as const;
    const from: Pose3 = { p: { x: 0, y: 1, z: 0 }, q: ID };
    const hit = q.castShape(ball, from, { x: 10, y: 0, z: 0 }, 2, {})!;
    expect(hit.owner).toEqual(entity(1));
    expect(hit.toi).toBeCloseTo(0.425, 4); // (4.5 − 0.25) m at 10 m/s
    expect(hit.point.x).toBeCloseTo(4.5, 4); // on the box's face, in world space
    expect(hit.point.y).toBeCloseTo(1, 2);
    expect(hit.point.z).toBeCloseTo(0, 2);
    expect(hit.normal.x).toBeCloseTo(-1, 5);
    const past = q.castShape(ball, from, { x: 10, y: 0, z: 0 }, 2, { exclude: { entities: [1] } })!;
    expect(past.owner).toEqual(entity(2));
    expect(past.toi).toBeCloseTo(0.925, 4);
    expect(q.castShape(ball, from, { x: 10, y: 0, z: 0 }, 0.4, {})).toBeNull(); // out of time
  });

  it('overlaps: each owner once (entity 2 has two colliders), in owner order whatever the creation order', () => {
    const { q } = scene();
    const at = (x: number, z = 0, y = 1): Pose3 => ({ p: { x, y, z }, q: ID });
    const wide = { kind: 'box', hx: 10, hy: 2, hz: 1 } as const;
    expect(q.overlaps(wide, at(12), { fighters: 'zones', ropes: true }).map(ownerKey)).toEqual(['terrain', 'entity:1', 'entity:2', 'fighter:3:zone:chest', 'rope:9']);
    expect(q.overlaps(wide, at(12), {}).map(ownerKey)).toEqual(['terrain', 'entity:1', 'entity:2']);
    expect(q.overlaps(wide, at(12), { terrain: false }).map(ownerKey)).toEqual(['entity:1', 'entity:2']);
    expect(q.overlaps(wide, at(12), { terrain: false, entities: 'static' }).map(ownerKey)).toEqual(['entity:1']);
    expect(q.overlaps({ kind: 'box', hx: 4, hy: 1, hz: 1 }, at(15, 3), { terrain: false, fighters: 'kcc' }).map(ownerKey)).toEqual(['fighter:3:kcc']);
    // The terrain, for every shape kind: straddling the ground it overlaps, 0.5 m clear of it it doesn't.
    const shapes: Shape[] = [
      { kind: 'ball', r: 0.3 },
      { kind: 'box', hx: 0.3, hy: 0.3, hz: 0.3 },
      { kind: 'capsule', halfHeight: 0.3, r: 0.3 },
      { kind: 'cylinder', halfHeight: 0.3, r: 0.3, sides: 8 },
      { kind: 'hull', points: [-0.3, -0.3, -0.3, 0.3, -0.3, -0.3, 0, -0.3, 0.3, 0, 0.3, 0] },
    ];
    for (const s of shapes) {
      expect(q.overlaps(s, at(-12, 0, 0.1), {}).map(ownerKey), s.kind).toEqual(['terrain']);
      expect(q.overlaps(s, at(-12, 0, 1.2), {}), s.kind).toEqual([]);
      expect(q.overlaps(s, at(-12, 0, 0.1), { terrain: false }), s.kind).toEqual([]);
    }
  });

  it('projectPoint and surfaceDistance (chest point = pos + chestHeightM × scale up)', () => {
    const { q } = scene();
    expect(q.projectPoint(1, { x: 3, y: 1, z: 0 })).toEqual({ point: { x: 4.5, y: 1, z: 0 }, dist: 1.5, inside: false });
    const inside = q.projectPoint(1, { x: 5, y: 1, z: 0.3 });
    expect(inside.inside).toBe(true);
    expect(inside.dist).toBeCloseTo(0.2, 6);
    expect(q.projectPoint(99, { x: 3, y: 1, z: 0 })).toEqual({ point: { x: 3, y: 1, z: 0 }, dist: Infinity, inside: false });
    const at = (x: number, y: number, scale: number) => ({ pos: { x, y, z: 0 }, scale }) as unknown as Fighter;
    expect(WORLD_TUNING.chestHeightM).toBe(1.2);
    expect(q.surfaceDistance(at(3, 0, 1), 1)).toBeCloseTo(1.5, 6); // chest (3, 1.2, 0)
    expect(q.surfaceDistance(at(3, 0.5, 2), 1)).toBeCloseTo(Math.hypot(1.5, 0.9), 6); // chest 2.9 m, over the 2 m top
    expect(q.surfaceDistance(at(5, 0, 1), 1)).toBe(0); // inside
    expect(q.surfaceDistance(at(3, 0, 1), 99)).toBe(Infinity);
  });
});

describe('determinism and lifetime', () => {
  /** f32 bits of every body's pose and velocities, in creation order. */
  function bodyBytes(p: PhysicsWorld, bodies: RAPIER.RigidBody[]): string {
    const f = new Float32Array(bodies.length * 13);
    bodies.forEach((b, i) => {
      const t = b.translation();
      const r = b.rotation();
      const v = b.linvel();
      const w = b.angvel();
      f.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z], i * 13);
    });
    return Buffer.from(f.buffer).toString('hex') + `@${p.rapier.bodies.len()}`;
  }

  function scene(p: PhysicsWorld): RAPIER.RigidBody[] {
    const ground = p.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    p.register(p.rapier.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0), ground), entity(1));
    const bodies: RAPIER.RigidBody[] = [];
    for (let i = 0; i < 24; i++) {
      const b = p.rapier.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation((i % 5) * 0.37 - 0.8, 1 + i * 0.55, Math.floor(i / 5) * 0.41 - 0.8)
          .setRotation({ x: 0.1 * (i % 3), y: 0, z: 0, w: 1 }),
      );
      const c = p.rapier.createCollider(
        (i % 2 ? RAPIER.ColliderDesc.cuboid(0.3, 0.2, 0.25) : RAPIER.ColliderDesc.ball(0.22)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        b,
      );
      p.register(c, entity(2 + i));
      bodies.push(b);
    }
    return bodies;
  }

  it('two identical worlds stay bit-identical for 600 steps, events included', () => {
    const a = makeWorld();
    const b = makeWorld();
    const ba = scene(a);
    const bb = scene(b);
    for (let t = 1; t <= 600; t++) {
      a.storePreStep();
      b.storePreStep();
      a.step();
      b.step();
      a.snapshotPostStep();
      b.snapshotPostStep();
      const pa = a.drain().map((q) => `${ownerKey(q.a)}|${ownerKey(q.b)}|${q.started}`);
      const pb = b.drain().map((q) => `${ownerKey(q.a)}|${ownerKey(q.b)}|${q.started}`);
      expect(pa).toEqual(pb);
      if (t % 60 === 0) expect(bodyBytes(a, ba)).toBe(bodyBytes(b, bb));
    }
  });

  it('primeQueries is refused once a body exists; free() is idempotent and ends the world', () => {
    const p = makeWorld();
    groundAndBox(p, 1);
    expect(() => p.primeQueries()).toThrow(/only before any rigid body/);
    p.free();
    p.free();
    expect(p.isFreed).toBe(true);
    expect(() => p.step()).toThrow(/after free/);
  });
});
