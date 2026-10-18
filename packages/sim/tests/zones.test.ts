// Hit zones of standing players and apes (docs/M1-DESIGN.md §4.8, §4.3, §1.5.8; package P08): one kinematic body with 12
// bone sensors per fighter, posed from the rig in phase 4b; the pose history the damage rule reads (carryV = the
// previous tick's rig delta) and its reset at every jump (RF-1): 0 right after a teleport and a hand-back; disabled
// while down; the save's history record.
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BONES, type BoneName } from '../src/body/skeleton';
import { moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { DT, Rng } from '../src/sim/math';
import { DAMAGE_TUNING } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { collisionGroups } from '../src/world/groups';
import { ownerKey, physicsReady } from '../src/world/physics';
import type { V3 } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { boneZoneShape } from '../src/world/zones';

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  vi.restoreAllMocks();
});

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

const key = (f: Fighter, b: BoneName): string => ownerKey({ kind: 'fighter', id: f.id, part: 'zone', bone: b });

/** Every zone collider of a fighter, BONES order, found through the physics world's owner map. */
function zoneColliders(w: World, f: Fighter): Map<BoneName, RAPIER.Collider> {
  const out = new Map<BoneName, RAPIER.Collider>();
  w.physics.rapier.forEachCollider((c) => {
    const o = w.physics.ownerOf(c.handle);
    if (o?.kind === 'fighter' && o.id === f.id && o.part === 'zone' && o.bone) out.set(o.bone, c);
  });
  return out;
}

/** Where the rig says a bone's zone is: the bone's joint, moved by the shape's offset in the bone frame. */
function rigZone(f: Fighter, b: BoneName): { p: Vector3; q: Quaternion } {
  const x = f.rig[b];
  const off = boneZoneShape(b, f.scale).off;
  const p = new Vector3(off.x, off.y, off.z).applyQuaternion(x.rot).add(x.pos);
  return { p, q: x.rot.clone() };
}

/** Each zone's world position as Rapier holds it now, BONES order. */
function zoneSnapshot(w: World, f: Fighter): V3[] {
  return BONES.map((b) => w.zones.zonePose(f, b)!.p);
}

/** Collects each tick's phase-5 carryV of every zone of `f` (read in phase 9, where the damage rule reads it). */
function carryLog(w: World, f: Fighter): (V3 | null)[][] {
  const log: (V3 | null)[][] = [];
  w.contacts.process = () => {
    log.push(BONES.map((b) => w.physics.pre(key(f, b))?.carryV ?? null));
  };
  return log;
}

describe('the zone bodies (§4.8)', () => {
  it('build 12 bone sensors per player and ape: ZONE groups, ALL collision types, collision events, on one kinematic body', async () => {
    const w = await make();
    const p = w.player!;
    const ape = addApe(w, 3, 0);
    for (const f of [p, ape]) {
      const cols = zoneColliders(w, f);
      expect([...cols.keys()].sort()).toEqual([...BONES].sort());
      const bodies = new Set<number>();
      for (const c of cols.values()) {
        expect(c.isSensor()).toBe(true);
        expect(c.collisionGroups()).toBe(collisionGroups('ZONE'));
        expect(c.activeCollisionTypes()).toBe(RAPIER.ActiveCollisionTypes.ALL);
        expect(c.activeEvents() & RAPIER.ActiveEvents.COLLISION_EVENTS).toBe(RAPIER.ActiveEvents.COLLISION_EVENTS);
        const b = c.parent()!;
        expect(b.isKinematic()).toBe(true);
        bodies.add(b.handle);
      }
      expect(bodies.size).toBe(1);
      expect(w.zones.enabled(f)).toBe(true);
    }
    // Shapes: DS ragdoll bones × scale.
    expect(boneZoneShape('head', 1)).toEqual({ kind: 'ball', r: 0.11, off: { x: 0, y: 0.15, z: 0 } });
    expect(boneZoneShape('chest', 1.1)).toMatchObject({ kind: 'box', hx: 0.17 * 1.1, hy: 0.13 * 1.1, hz: 0.1 * 1.1 });
    const shin = boneZoneShape('shinL', 1);
    expect(shin.kind).toBe('capsule');
    expect(shin).toMatchObject({ r: 0.055, halfHeight: 0.43 / 2 - 0.055 * 0.5, off: { x: 0, y: -0.43 / 2, z: 0 } });
  });

  it('pose each zone where the rig puts its bone, every tick (phase 4b)', async () => {
    const w = await make({ seed: 2 });
    w.terrain.generate((x, z) => 0.2 * Math.sin(x) + 0.15 * Math.cos(z * 1.3));
    const p = w.player!;
    w.teleport(p, 0, 0);
    for (let t = 0; t < 90; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0.4 * Math.sin(t / 20)));
      // A punch now and then, so the arms move against the pelvis.
      if (t % 30 === 10) w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'rpunch' });
      w.step();
      if (t < 2) continue;
      for (const b of BONES) {
        const z = w.zones.zonePose(p, b)!;
        const r = rigZone(p, b);
        expect(Math.hypot(z.p.x - r.p.x, z.p.y - r.p.y, z.p.z - r.p.z)).toBeLessThan(1e-5);
        expect(Math.abs(z.q.x * r.q.x + z.q.y * r.q.y + z.q.z * r.q.z + z.q.w * r.q.w)).toBeGreaterThan(1 - 1e-6);
      }
    }
  });

  it('carryV is the previous tick’s delta of each zone (pose_{N−1} − pose_{N−2}) / DT', async () => {
    const w = await make({ seed: 3 });
    const p = w.player!;
    const carry = carryLog(w, p);
    const poses: V3[][] = [];
    let compared = 0;
    for (let t = 0; t < 80; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      if (t === 40) w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'lkick' });
      w.step();
      poses.push(zoneSnapshot(w, p)); // pose after step t = the pose set in tick t's phase 4b
      if (t < 4) continue;
      // Tick t's store holds the pose of step t − 1 and the one before it.
      for (let i = 0; i < BONES.length; i++) {
        const cv = carry[t][i]!;
        const a = poses[t - 1][i];
        const b = poses[t - 2][i];
        expect(cv.x).toBeCloseTo((a.x - b.x) / DT, 6);
        expect(cv.y).toBeCloseTo((a.y - b.y) / DT, 6);
        expect(cv.z).toBeCloseTo((a.z - b.z) / DT, 6);
        compared++;
      }
    }
    expect(compared).toBe(76 * 12);
    // Walking (before the kick), the zones really move (≈ walking speed on the pelvis).
    const pel = carry[35][BONES.indexOf('pelvis')]!;
    expect(Math.hypot(pel.x, pel.z)).toBeGreaterThan(1);
  });

  it('a teleport never reads as a speed: carryV 0 at the two stores around the jump, then the walk again (RF-1)', async () => {
    const w = await make({ seed: 4 });
    const p = w.player!;
    const carry = carryLog(w, p);
    const graces: [number, number][] = [];
    const grace = w.contacts.grace.bind(w.contacts);
    w.contacts.grace = (id, until) => {
      graces.push([id, until]);
      grace(id, until);
    };
    const T = 30;
    for (let t = 1; t <= 40; t++) {
      if (t === T) w.teleport(p, 15, -10); // between steps T − 1 and T: tick T poses the new place
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
    }
    const at = (tick: number) => carry[tick - 1];
    const speed = (tick: number) => Math.max(...at(tick).map((v) => Math.hypot(v!.x, v!.y, v!.z)));
    expect(speed(T - 1)).toBeGreaterThan(1);
    expect(speed(T)).toBe(0);
    expect(speed(T + 1)).toBe(0);
    expect(speed(T + 3)).toBeGreaterThan(0.5);
    expect(speed(T + 3)).toBeLessThan(20);
    // The zones' reset opened the contact grace (and World.teleport its own).
    expect(graces.length).toBeGreaterThanOrEqual(1);
    for (const [id, until] of graces) {
      expect(id).toBe(p.id);
      expect(until).toBeGreaterThanOrEqual(T + DAMAGE_TUNING.zoneGraceTicks);
    }
  });

  it('are off while the fighter is down and come back after the hand-back with carryV 0 at the first two stores (RF-1)', async () => {
    const w = await make({ seed: 5 });
    const p = w.player!;
    const carry = carryLog(w, p);
    for (let t = 0; t < 20; t++) w.step();
    p.vel.set(3, 0, 0);
    p.enterKnockdown();
    let downAt = -1;
    let backAt = -1;
    for (let t = 0; t < 400 && backAt < 0; t++) {
      w.step();
      if (downAt < 0 && w.downed.active(p)) downAt = w.tick;
      if (downAt > 0 && w.tick > downAt) {
        if (w.zones.enabled(p)) backAt = w.tick;
        else for (const b of BONES) expect(w.physics.pre(key(p, b))).toBeNull(); // disabled: not stored
      }
    }
    expect(downAt).toBeGreaterThan(0);
    expect(backAt).toBeGreaterThan(downAt + 60);
    expect(p.state).toBe('getup');
    for (let t = 0; t < 5; t++) w.step();
    // backAt's store and the next one: the jump from the knockdown spot to the stand spot reads as no speed.
    const at = (tick: number) => carry[tick - 1];
    for (const v of at(backAt)) expect(v === null || (v.x === 0 && v.y === 0 && v.z === 0)).toBe(true);
    for (const v of at(backAt + 1)) expect(v).toEqual({ x: 0, y: 0, z: 0 });
    // Afterwards the getup's motion is read as usual (finite, a body's speeds).
    for (const v of at(backAt + 3)) expect(Math.hypot(v!.x, v!.y, v!.z)).toBeLessThan(10);
  });

  it('a severed bone has no zone; remove() takes every zone out of the world', async () => {
    const w = await make({ seed: 6 });
    const ape = addApe(w, 2, 0);
    w.step();
    ape.severed.add('upperArmL'); // the forearm goes with it
    const cols = zoneColliders(w, ape);
    w.step();
    w.step();
    expect(cols.get('upperArmL')!.isEnabled()).toBe(false);
    expect(cols.get('foreArmL')!.isEnabled()).toBe(false);
    expect(w.physics.pre(key(ape, 'foreArmL'))).toBeNull();
    expect(w.physics.pre(key(ape, 'chest'))).not.toBeNull();
    expect(cols.get('foreArmR')!.isEnabled()).toBe(true);
    const handles = [...cols.values()].map((c) => c.handle);
    w.removeFighter(ape);
    w.step();
    for (const h of handles) expect(w.physics.rapier.getCollider(h)).toBeNull();
    expect(w.zones.zonePose(ape, 'chest')).toBeNull();
  });

  it('historyRecord: per bone the stored pose and the one before it, 14 numbers a bone', async () => {
    const w = await make({ seed: 7 });
    const p = w.player!;
    for (let t = 0; t < 10; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
      w.step();
    }
    const h = w.zones.historyRecord(p);
    expect(h).toHaveLength(12 * 14);
    BONES.forEach((b, i) => {
      const s = w.physics.pre(key(p, b))!;
      expect(h.slice(i * 14, i * 14 + 14)).toEqual([s.p.x, s.p.y, s.p.z, s.q.x, s.q.y, s.q.z, s.q.w, s.prevP.x, s.prevP.y, s.prevP.z, s.prevQ.x, s.prevQ.y, s.prevQ.z, s.prevQ.w]);
    });
    expect(w.zones.historyRecord({ id: 999 } as Fighter)).toEqual([]);
  });
});
