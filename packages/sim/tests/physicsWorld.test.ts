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
import type { Owner } from '../src/world/types';
import { WORLD_TUNING } from '../src/world/worldTuning';

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
