// Character controllers (docs/M1-DESIGN.md §4.2, §1.5.8; package P08): the KCC capsule resolving CombatSim's proposal
// (f.pos = the capsule's f32 pose), the 500 N push through the entity queue (AC-6 part 1: an 800 kg hull doesn't move,
// a 40 kg log slides, and the collision count), slopes, DungeonStyle's spacing between a player and an ape, jump,
// fall and landing, crouch with headroom, teleport, the held entity left out, records.
//
// Scene numbers (masses, sizes, speeds) are test constants, never tuning (§9), so a tuning change can't move a margin
// silently.
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MOVE_CROUCH, moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { DT, Rng } from '../src/sim/math';
import { boneMass, DAMAGE_TUNING, impactEnergy, MOVE_TUNING } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { CHARACTER_TUNING, landingImpact, safeLandingSpeed } from '../src/world/characters';
import { kccQueryGroups } from '../src/world/groups';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import { shapeVolume } from '../src/world/shapes';
import type { ImpactCause, MaterialId, Quat, Shape, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

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
  resetTuning('CHARACTER_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const LYING_Z: Quat = { x: Math.sin(Math.PI / 4), y: 0, z: 0, w: Math.cos(Math.PI / 4) }; // local +Y along world z

/** An ape (the bruiser's body and moves at the ape's scale and mass, §6.3), no brain: tests drive its moveInput. */
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

function entity(w: World, material: MaterialId, shape: Shape, p: V3, state: 'free' | 'fixed' | 'anchored' = 'free', q?: Quat): number {
  return w.addEntity({ material, shape, p, q, state, look: 'test' });
}

/** A circumradius that gives an N-gon prism of `length` the mass `kg` in `material`. */
function prismR(kg: number, material: MaterialId, length: number, sides: number): number {
  const area = kg / MATERIALS[material].density / length;
  return Math.sqrt(area / ((sides / 2) * Math.sin((2 * Math.PI) / sides)));
}

/** An icosahedron's vertices at circumradius r (a stone hull). */
function icosahedron(r: number): number[] {
  const phi = (1 + Math.sqrt(5)) / 2;
  const k = r / Math.hypot(1, phi);
  const v = [
    [0, 1, phi], [0, 1, -phi], [0, -1, phi], [0, -1, -phi],
    [1, phi, 0], [1, -phi, 0], [-1, phi, 0], [-1, -phi, 0],
    [phi, 0, 1], [phi, 0, -1], [-phi, 0, 1], [-phi, 0, -1],
  ];
  return v.flatMap((p) => p.map((c) => c * k));
}

/** Player 1 moves (x, z) of full stick (flags MOVE_*) on the next tick. */
function move(w: World, x: number, z: number, flags = 0): void {
  w.commands.push(moveCommand(w.tick + 1, 1, x, z, flags));
}

const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------------------

describe('the controller resolves the proposal (§4.2)', () => {
  it('builds one capsule per player and ape: 1.8 × scale tall, CHAR groups, solving only against the terrain', async () => {
    const w = await make();
    const p = w.player!;
    const ape = addApe(w, 3, 0);
    expect(w.kcc.heightOf(p)).toBeCloseTo(1.8, 6);
    expect(w.kcc.heightOf(ape)).toBeCloseTo(1.98, 6);
    expect(w.kcc.footOffsetOf(p)).toBeCloseTo(0.3 + 0.6 + 0.02, 6);
    expect(w.kcc.grounded(p)).toBe(true);
    expect(w.kcc.crouched(p)).toBe(false);
    expect(w.kcc.isEnabled(p)).toBe(true);
    // The capsule is found by a fighters: 'kcc' query once a step has run, owned by the fighter.
    w.step();
    const hit = w.queries.castRay({ x: 0, y: 1, z: -3 }, { x: 0, y: 0, z: 1 }, 6, { terrain: false, entities: 'none', fighters: 'kcc' });
    expect(hit?.owner).toEqual({ kind: 'fighter', id: p.id, part: 'kcc' });
    expect(hit!.point.z).toBeCloseTo(-0.3, 4);
  });

  it('f.pos is the capsule’s f32 pose after every resolve, walking on bumpy terrain', async () => {
    const w = await make({ seed: 2 });
    w.terrain.generate((x, z) => 0.25 * Math.sin(x * 1.3) + 0.2 * Math.cos(z * 0.9) + 0.1 * Math.sin((x + z) * 2.1));
    const p = w.player!;
    w.teleport(p, 0, 0);
    let checked = 0;
    for (let t = 0; t < 240; t++) {
      move(w, 1, 0.6 * Math.sin(t / 30));
      w.step();
      const c = w.kcc.capsulePose(p)!;
      expect(p.pos.x).toBe(c.p.x);
      expect(p.pos.z).toBe(c.p.z);
      expect(p.pos.y).toBe(c.p.y - w.kcc.footOffsetOf(p));
      expect(Math.fround(c.p.x)).toBe(c.p.x);
      checked++;
      // The feet are on the ground: within the capsule's rounding of the slope and the controller's offset.
      expect(Math.abs(p.pos.y - w.terrain.heightAt(p.pos.x, p.pos.z))).toBeLessThan(0.1);
      expect(w.kcc.grounded(p)).toBe(true);
    }
    expect(checked).toBe(240);
    expect(Math.hypot(p.pos.x, p.pos.z)).toBeGreaterThan(2);
  });

  for (const [label, dir] of [
    ['uphill', { x: 1, z: 0 }],
    ['downhill', { x: -1, z: 0 }],
    ['across', { x: 0, z: 1 }],
  ] as const) {
    it(`stays grounded walking and running ${label} on a 25° slope`, async () => {
      const w = await make({ seed: 4 });
      const k = Math.tan(25 * DEG);
      w.terrain.generate((x) => k * x);
      const p = w.player!;
      w.teleport(p, 0, 0);
      w.step();
      let air = 0;
      for (let t = 0; t < 180; t++) {
        // Walking for a second, then running.
        const s = t < 60 ? 0.5 : 1;
        move(w, dir.x * s, dir.z * s);
        w.step();
        if (!w.kcc.grounded(p)) air++;
        expect(Math.abs(p.pos.y - w.terrain.heightAt(p.pos.x, p.pos.z))).toBeLessThan(0.12);
      }
      expect(air).toBe(0);
      expect(hdist(p.pos, { x: 0, y: 0, z: 0 })).toBeGreaterThan(2);
    });
  }

  it('keeps DungeonStyle’s spacing between a player and an ape: centre distance minSep = 0.66 × (1 + 1.1)/2 = 0.693 m', async () => {
    const w = await make({ seed: 5 });
    const p = w.player!;
    w.teleport(p, -1, 0, Math.PI / 2);
    const ape = addApe(w, 1.2, 0, -Math.PI / 2);
    let minD = Infinity;
    const held: number[] = [];
    for (let t = 0; t < 150; t++) {
      move(w, 1, 0);
      ape.moveInput.set(-1, 0, 0);
      w.step();
      minD = Math.min(minD, hdist(p.pos, ape.pos));
      if (t >= 120) held.push(hdist(p.pos, ape.pos));
    }
    // Head-on, walking into each other: separate() holds them at minSep (or further while limbs overlap: its
    // bodyOverlap term), and the controllers never cut it (characters are out of each other's sweeps, MAP gap-1 §4.1).
    expect(hdist(p.pos, ape.pos)).toBeCloseTo(0.693, 3);
    for (const d of held) expect(d).toBeGreaterThanOrEqual(0.693 - 5e-4);
    expect(minD).toBeGreaterThan(0.69);
    // Both are still pressing in: neither capsule stopped the other at capsule contact (0.63 m apart).
    expect(w.kcc.collidedEntities(p)).toEqual([]);
  });

  it('teleports skip the sweep: the capsule is put at the feet point given, at rest', async () => {
    const w = await make({ seed: 6 });
    const p = w.player!;
    // A fixed wall between here and there: a sweep would stop at it.
    entity(w, 'stone', { kind: 'box', hx: 0.2, hy: 1, hz: 3 }, { x: 2, y: 1, z: 0 }, 'fixed');
    w.step();
    w.teleport(p, 5, 0);
    expect(w.kcc.teleportPending(p)).toBe(true);
    w.step();
    expect(w.kcc.teleportPending(p)).toBe(false);
    expect(p.pos.x).toBe(5);
    expect(p.pos.z).toBe(0);
    expect(w.kcc.capsulePose(p)!.p.x).toBe(5);
    expect(w.kcc.verticalSpeed(p)).toBe(0);
    for (let t = 0; t < 10; t++) w.step();
    expect(p.pos.x).toBe(5);
    expect(Math.abs(p.pos.y)).toBeLessThan(1e-3);
  });

  it('standing still, the controller never shoves the fighter sideways (a body it overlaps reaches it through zones and knockback)', async () => {
    const w = await make({ seed: 7 });
    const p = w.player!;
    entity(w, 'stone', { kind: 'box', hx: 0.1, hy: 1, hz: 0.1 }, { x: 4, y: 1, z: 0 }, 'fixed');
    w.step();
    w.teleport(p, 4, 0);
    for (let t = 0; t < 20; t++) w.step();
    expect(p.pos.x).toBe(4);
    expect(p.pos.z).toBe(0);
    // Moving, the sweep resolves the overlap and the fighter walks out of the stake.
    for (let t = 0; t < 60; t++) {
      move(w, 0, 1);
      w.step();
    }
    expect(p.pos.z).toBeGreaterThan(0.5);
    expect(w.kcc.collidedEntities(p)).toEqual([]);
  });

  it('steps over a fixed log and a log too heavy to push (D-28), but pushes one it can shove', async () => {
    const over = async (mass: number, state: 'free' | 'fixed'): Promise<{ crossed: boolean; moved: number; maxY: number }> => {
      const w = await make({ seed: 8 });
      const r = prismR(mass, 'dryWood', 2.2, 6);
      const id = entity(w, 'dryWood', { kind: 'cylinder', halfHeight: 1.1, r, sides: 6 }, { x: 0, y: r + 0.02, z: 0 }, state, LYING_Z);
      const p = w.player!;
      w.teleport(p, -1.5, 0, Math.PI / 2);
      for (let t = 0; t < 60; t++) w.step();
      const start = { ...w.entities.get(id)!.pose.p };
      let maxY = 0;
      for (let t = 0; t < 150; t++) {
        move(w, 0.5, 0);
        w.step();
        maxY = Math.max(maxY, p.pos.y);
      }
      return { crossed: p.pos.x > 0.6, moved: hdist(w.entities.get(id)!.pose.p, start), maxY };
    };
    // 120 kg of dry wood: 0.6 × 120 kg × 9.81 = 706 N of friction against a 500 N push; 0.34 m high, under the 0.4 m
    // step. Stepped over: the pushes while the feet are on its face roll the hex log over one face at most (≈ 0.29 m),
    // never slide it along.
    const heavy = await over(120, 'free');
    expect(heavy.crossed).toBe(true);
    expect(heavy.moved).toBeLessThan(0.4);
    expect(heavy.maxY).toBeGreaterThan(0.25);
    const fixed = await over(120, 'fixed');
    expect(fixed.crossed).toBe(true);
    expect(fixed.moved).toBe(0);
    // 40 kg: 235 N of friction; pushed along, never climbed.
    const light = await over(40, 'free');
    expect(light.moved).toBeGreaterThan(0.5);
    expect(light.maxY).toBeLessThan(0.05);
  });
});

describe('the player push (SPEC:374, 881; AC-6 part 1)', () => {
  /** The player walks (or runs) into the obstacle for 3 s: how far it moved and on how many ticks it was met and pushed. */
  async function walkInto(build: (w: World) => number, speed: number): Promise<{ moved: number; met: number; pushed: number; mass: number }> {
    const w = await make({ seed: 11 });
    const id = build(w);
    const p = w.player!;
    w.teleport(p, -1.2, 0, Math.PI / 2);
    for (let t = 0; t < 60; t++) w.step(); // the obstacle settles
    const start = { ...w.entities.get(id)!.pose.p };
    let met = 0;
    let pushed = 0;
    for (let t = 0; t < 180; t++) {
      move(w, speed, 0);
      w.step();
      const touched = w.kcc.collidedEntities(p).includes(id);
      const pushedNow = w.kcc.pushedEntities(p).includes(id);
      if (touched) met++;
      if (pushedNow) pushed++;
      // Every computed collision with it queued a push (RT-15): "didn't move" isn't "never touched".
      expect(pushedNow).toBe(touched);
    }
    const e = w.entities.get(id)!;
    return { moved: hdist(e.pose.p, start), met, pushed, mass: e.mass };
  }

  const boulder = (w: World): number => {
    const r1 = shapeVolume({ kind: 'hull', points: icosahedron(1) });
    const r = Math.cbrt(800 / MATERIALS.stone.density / r1);
    return entity(w, 'stone', { kind: 'hull', points: icosahedron(r) }, { x: 0, y: r + 0.02, z: 0 });
  };
  const log = (w: World): number => {
    const r = prismR(40, 'dryWood', 2.2, 6);
    return entity(w, 'dryWood', { kind: 'cylinder', halfHeight: 1.1, r, sides: 6 }, { x: 0, y: r + 0.02, z: 0 }, 'free', LYING_Z);
  };

  for (const [label, speed] of [
    ['walking', 0.5],
    ['running', 1],
  ] as const) {
    it(`${label}, an 800 kg stone hull moves < 0.01 m in 3 s, met and pushed on ≥ 120 of the 180 ticks`, async () => {
      const r = await walkInto(boulder, speed);
      expect(r.mass).toBeCloseTo(800, 6);
      expect(r.moved).toBeLessThan(0.01);
      expect(r.met).toBeGreaterThanOrEqual(120);
      expect(r.pushed).toBe(r.met);
    });

    it(`${label}, a 40 kg dry hex log slides > 1 m in 3 s`, async () => {
      const r = await walkInto(log, speed);
      expect(r.mass).toBeCloseTo(40, 6);
      expect(r.moved).toBeGreaterThan(1);
    });
  }

  it('queues pushN × DT along the horizontal −normal1 into the entity queue, once per entity per tick, applied in phase 4d', async () => {
    const w = await make({ seed: 12 });
    const r = prismR(40, 'dryWood', 2.2, 6);
    const id = entity(w, 'dryWood', { kind: 'cylinder', halfHeight: 1.1, r, sides: 6 }, { x: 0, y: r + 0.02, z: 0 }, 'free', LYING_Z);
    const p = w.player!;
    w.teleport(p, -0.6, 0, Math.PI / 2);
    for (let t = 0; t < 30; t++) w.step();
    const queued: { id: number; j: V3; at: V3 | null }[] = [];
    const orig = w.entities.queueImpulse.bind(w.entities);
    vi.spyOn(w.entities, 'queueImpulse').mockImplementation((eid, j, at) => {
      queued.push({ id: eid, j: { ...j }, at });
      orig(eid, j, at);
    });
    let pushes = 0;
    for (let t = 0; t < 20; t++) {
      queued.length = 0;
      move(w, 1, 0);
      w.step();
      const mine = queued.filter((q) => q.id === id);
      expect(mine.length).toBe(w.kcc.pushedEntities(p).includes(id) ? 1 : 0);
      for (const q of mine) {
        pushes++;
        expect(q.at).toBeNull();
        expect(q.j.y).toBe(0);
        expect(Math.hypot(q.j.x, q.j.z)).toBeCloseTo(CHARACTER_TUNING.pushN * DT, 9);
        expect(q.j.x).toBeGreaterThan(0); // away from the player
      }
    }
    expect(pushes).toBeGreaterThan(5);
  });

  it('never pushes an anchored or fixed entity, and a fighter standing still pushes nothing', async () => {
    const w = await make({ seed: 13 });
    const stake = entity(w, 'greenWood', { kind: 'cylinder', halfHeight: 0.5, r: 0.05, sides: 8 }, { x: 0, y: 0.5, z: 0 }, 'anchored');
    const p = w.player!;
    w.teleport(p, -0.6, 0, Math.PI / 2);
    w.step();
    let met = 0;
    for (let t = 0; t < 60; t++) {
      move(w, 1, 0);
      w.step();
      if (w.kcc.collidedEntities(p).includes(stake)) met++;
      expect(w.kcc.pushedEntities(p)).toEqual([]);
    }
    expect(met).toBeGreaterThan(10);
    // A free log against a fighter standing still: met by the sweep, never pushed.
    const w2 = await make({ seed: 14 });
    const r = prismR(40, 'dryWood', 2.2, 6);
    const id = entity(w2, 'dryWood', { kind: 'cylinder', halfHeight: 1.1, r, sides: 6 }, { x: 0, y: r + 0.02, z: 0 }, 'free', LYING_Z);
    const p2 = w2.player!;
    w2.teleport(p2, -0.38, 0, Math.PI / 2);
    for (let t = 0; t < 60; t++) {
      w2.step();
      expect(w2.kcc.pushedEntities(p2)).toEqual([]);
    }
    expect(w2.entities.get(id)!.restTicks).toBeGreaterThan(0);
  });

  it('leaves the entity in the fighter’s hands out of its sweeps (a dragged load never blocks its dragger)', async () => {
    const w = await make({ seed: 15 });
    const wall = entity(w, 'stone', { kind: 'box', hx: 0.1, hy: 1, hz: 2 }, { x: 0, y: 1, z: 0 }, 'fixed');
    const p = w.player!;
    w.teleport(p, -1, 0, Math.PI / 2);
    w.step();
    p.inventory!.hands = { entity: wall, mode: 'drag', grip: { x: 0, y: 0, z: 0 }, twoHanded: true, joint: null };
    for (let t = 0; t < 90; t++) {
      move(w, 1, 0);
      w.step();
      expect(w.kcc.collidedEntities(p)).not.toContain(wall);
    }
    expect(p.pos.x).toBeGreaterThan(0.5);
  });
});

describe('jump, fall and landing (§4.2, §5.5)', () => {
  it('a jump press is taken on the ground: ≈ 0.9 m up, the stamina spent, and a `land` event on touchdown', async () => {
    const w = await make({ seed: 21 });
    const p = w.player!;
    w.step();
    const stamina = p.stamina;
    w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'jump' });
    let top = 0;
    let airTicks = 0;
    const lands: Extract<WorldEvent, { type: 'land' }>[] = [];
    let spent = 0;
    for (let t = 0; t < 90; t++) {
      const r = w.step();
      if (t === 0) spent = stamina - p.stamina;
      top = Math.max(top, p.pos.y);
      if (!w.kcc.grounded(p)) airTicks++;
      for (const e of r.world) if (e.type === 'land') lands.push({ ...e });
    }
    const v = CHARACTER_TUNING.jumpSpeed;
    // v²/2g = 0.899 m, less the first tick's half step of gravity.
    expect(top).toBeCloseTo((v * v) / (2 * 9.81), 1);
    expect(airTicks).toBeGreaterThan(40);
    expect(airTicks).toBeLessThan(60);
    // The jump's stamina, less one tick of regeneration at most.
    expect(spent).toBeGreaterThan(MOVE_TUNING.jumpStamina - 0.01);
    expect(spent).toBeLessThanOrEqual(MOVE_TUNING.jumpStamina + 1e-12);
    expect(lands).toHaveLength(1);
    expect(lands[0].f).toBe(p);
    expect(lands[0].entity).toBeNull();
    expect(lands[0].energy).toBe(0); // under v_safe: no hard landing
    expect(lands[0].mass).toBe(p.mass);
    expect(p.jumpRequest).toBe(0);
    expect(w.kcc.grounded(p)).toBe(true);
    expect(Math.abs(p.pos.y)).toBeLessThan(1e-3);
  });

  it('no jump out of breath, crouched, busy or in the air; the press is buffered jumpBufferFrames ticks', async () => {
    const w = await make({ seed: 22 });
    const p = w.player!;
    const jump = () => w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'jump' });
    w.step();
    p.stamina = MOVE_TUNING.jumpStamina / 2;
    jump();
    for (let t = 0; t < 10; t++) w.step();
    expect(p.pos.y).toBeLessThan(1e-3);
    expect(p.jumpRequest).toBe(0); // expired
    p.stamina = 1;
    move(w, 0, 0, MOVE_CROUCH);
    for (let t = 0; t < 5; t++) w.step();
    expect(w.kcc.crouched(p)).toBe(true);
    jump();
    for (let t = 0; t < 10; t++) w.step();
    expect(p.pos.y).toBeLessThan(1e-3);
    move(w, 0, 0);
    for (let t = 0; t < 5; t++) w.step();
    expect(w.kcc.crouched(p)).toBe(false);
    // Busy (in hitstun): not taken; the press waits while it lasts.
    p.enterHitstun(3, 'hitHigh', 0);
    jump();
    w.step();
    expect(p.pos.y).toBeLessThan(1e-3);
    for (let t = 0; t < 6; t++) w.step();
    expect(p.pos.y).toBeGreaterThan(0.1); // free again within the buffer: it jumps
    // In the air, a second press does nothing.
    const vy = w.kcc.verticalSpeed(p);
    jump();
    w.step();
    expect(w.kcc.verticalSpeed(p)).toBeLessThan(vy);
  });

  it('a jump under a low ceiling stops at it and falls back at once', async () => {
    const w = await make({ seed: 25 });
    // A fixed slab 2.1 m up: the 1.8 m capsule (+ 0.02 m skin) has 0.28 m of room.
    entity(w, 'stone', { kind: 'box', hx: 2, hy: 0.1, hz: 2 }, { x: 0, y: 2.2, z: 0 }, 'fixed');
    w.step();
    const p = w.player!;
    w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'jump' });
    let top = 0;
    let air = 0;
    for (let t = 0; t < 60; t++) {
      w.step();
      top = Math.max(top, p.pos.y);
      if (!w.kcc.grounded(p)) air++;
    }
    expect(top).toBeGreaterThan(0.1);
    expect(top).toBeLessThan(2.1 - 1.8);
    // Far shorter than the free jump's ≈ 50 ticks in the air.
    expect(air).toBeLessThan(25);
    expect(w.kcc.grounded(p)).toBe(true);
  });

  it('walking off a 5 m scaffold: a fall, a `land` event on it with the rule’s energy, and a knockdown over 9 m/s', async () => {
    const w = await make({ seed: 23 });
    entity(w, 'dryWood', { kind: 'box', hx: 1, hy: 2.5, hz: 1 }, { x: 0, y: 2.5, z: 0 }, 'fixed');
    w.step();
    const p = w.player!;
    w.teleport(p, 0.5, 0, Math.PI / 2);
    w.step();
    expect(p.pos.y).toBeCloseTo(5, 3);
    let land: Extract<WorldEvent, { type: 'land' }> | null = null;
    let vMax = 0;
    let launched = false;
    for (let t = 0; t < 200 && !launched; t++) {
      move(w, 1, 0);
      const r = w.step();
      vMax = Math.max(vMax, -w.kcc.verticalSpeed(p));
      for (const e of r.world) {
        if (e.type === 'land') land = { ...e };
        if (e.type === 'launch' && e.f === p) launched = true;
      }
    }
    expect(land).not.toBeNull();
    expect(land!.entity).toBeNull(); // the terrain beside the scaffold
    // ≈ √(2·9.81·5) = 9.9 m/s: the shin's ½·m·v² less the safe landing's ½·m·v_safe².
    expect(vMax).toBeGreaterThan(CHARACTER_TUNING.landingKnockdownSpeed);
    expect(land!.energy).toBeGreaterThan(0);
    expect(launched).toBe(true);
    expect(w.downed.active(p)).toBe(true);
    expect(w.kcc.isEnabled(p)).toBe(false);
  });

  it('landingImpact: the shin by the rule, s = 0, less ½·m·v_safe²; nothing under v_safe', async () => {
    const w = await make({ seed: 24 });
    const p = w.player!;
    const terrain: ImpactCause = { kind: 'terrain', entityId: null, fighterId: null, credit: [], held: false, feature: 'fall' };
    const point = { x: 1, y: 0, z: 2 };
    const mb = boneMass(p, 'shinL');
    expect(safeLandingSpeed(p)).toBe(SPECIES_BODY.human.vSafe);
    const i = landingImpact(p, 10, terrain, point, Infinity)!;
    expect(i.bone).toBe('shinL');
    expect(i.zone).toBe('legs');
    expect(i.mEff).toBe(mb);
    expect(i.vn).toBe(10);
    expect(i.sharpness).toBe(0);
    expect(i.energy).toBeCloseTo(impactEnergy(mb, 10, 0) - impactEnergy(mb, 6, 0), 9);
    expect(i.energy).toBeCloseTo(0.5 * mb * (100 - 36), 9);
    expect(i.dv).toEqual({ x: 0, y: 0, z: 0 });
    expect(i.normal).toEqual({ x: 0, y: -1, z: 0 });
    expect(i.impactorMass).toBe(Infinity);
    expect(i.cause).toBe(terrain);
    expect(i.point).toEqual(point);
    expect(landingImpact(p, 6, terrain, point, Infinity)).toBeNull();
    // Just above v_safe the energy is under minImpactJ: never scored.
    const v = Math.sqrt(36 + (2 * DAMAGE_TUNING.minImpactJ) / mb) - 1e-6;
    expect(landingImpact(p, v, terrain, point, Infinity)).toBeNull();
    // An ape lands safely faster: v_safe = 6·√1.1.
    const ape = addApe(w, 3, 0);
    expect(safeLandingSpeed(ape)).toBe(SPECIES_BODY.ape.vSafe);
  });
});

describe('crouch with headroom (§4.2, RT-4)', () => {
  it('a crouched ape (1.39 m) walks under a log 1.5 m up, can’t stand up under it, and stands once clear; standing it can’t pass', async () => {
    const w = await make({ seed: 31, player: false });
    // A fixed log across the path, its underside 1.5 m up.
    entity(w, 'greenWood', { kind: 'box', hx: 0.12, hy: 0.12, hz: 3 }, { x: 0, y: 1.62, z: 0 }, 'fixed');
    const ape = addApe(w, -2, 0, Math.PI / 2);
    w.step();
    // Standing: blocked at the log.
    for (let t = 0; t < 150; t++) {
      ape.moveInput.set(1, 0, 0);
      w.step();
    }
    expect(w.kcc.crouched(ape)).toBe(false);
    expect(ape.pos.x).toBeLessThan(-0.3);
    // Crouched: 0.7 of 1.98 m, under the log and through.
    ape.moveFlags = MOVE_CROUCH;
    w.step();
    expect(w.kcc.crouched(ape)).toBe(true);
    expect(w.kcc.heightOf(ape)).toBeCloseTo(0.7 * 1.98, 6);
    expect(w.kcc.heightOf(ape)).toBeCloseTo(1.39, 2);
    const feet = ape.pos.y;
    w.step();
    // The feet stay where they were when the capsule shrank.
    expect(Math.abs(ape.pos.y - feet)).toBeLessThan(1e-3);
    for (let t = 0; t < 600 && ape.pos.x < 0; t++) {
      ape.moveInput.set(1, 0, 0);
      w.step();
    }
    expect(ape.pos.x).toBeGreaterThanOrEqual(0);
    expect(ape.pos.x).toBeLessThan(0.3);
    // Under it, letting go of crouch: it stays crouched (no headroom).
    ape.moveFlags = 0;
    ape.moveInput.set(0, 0, 0);
    for (let t = 0; t < 30; t++) {
      w.step();
      expect(w.kcc.crouched(ape)).toBe(true);
    }
    // Out from under it, it stands up at once.
    let stood = -1;
    for (let t = 0; t < 600 && stood < 0; t++) {
      ape.moveInput.set(1, 0, 0);
      w.step();
      if (!w.kcc.crouched(ape)) stood = t;
    }
    expect(stood).toBeGreaterThanOrEqual(0);
    expect(ape.pos.x).toBeGreaterThan(0.12 + 0.33);
    expect(w.kcc.heightOf(ape)).toBeCloseTo(1.98, 6);
    // Nothing overhead now: the standing capsule overlaps nothing.
    w.step();
    const c = w.kcc.capsulePose(ape)!;
    const over = w.physics.rapier.intersectionWithShape(c.p, c.q, new RAPIER.Capsule(0.66, 0.33), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, kccQueryGroups());
    expect(over === null || w.physics.ownerOf(over.handle)?.kind === 'terrain').toBe(true);
  });

  it('a stooped work posture and a tug script crouch the capsule too', async () => {
    const w = await make({ seed: 32 });
    const p = w.player!;
    w.step();
    p.posture = { id: 'workLow', weight: 1 };
    w.step();
    expect(w.kcc.crouched(p)).toBe(true);
    p.posture = { id: 'carryFront', weight: 1 };
    w.step();
    expect(w.kcc.crouched(p)).toBe(false);
    p.posture = { id: 'digScoop', weight: 0 };
    w.step();
    expect(w.kcc.crouched(p)).toBe(false);
  });
});

describe('records and footsteps', () => {
  it('toRecord → restoreRecord → toRecord is exact, mid-jump and crouched', async () => {
    const w = await make({ seed: 41 });
    const p = w.player!;
    const ape = addApe(w, 3, 0);
    w.step();
    w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'jump' });
    ape.moveFlags = MOVE_CROUCH;
    for (let t = 0; t < 8; t++) {
      move(w, 1, 0.3);
      w.step();
    }
    expect(w.kcc.grounded(p)).toBe(false);
    expect(w.kcc.crouched(ape)).toBe(true);
    const rec = w.kcc.toRecord();
    expect(rec.map((r) => r.fighter)).toEqual([p.id, ape.id]);
    expect(rec[0].kcc.vy).toBeGreaterThan(0);
    expect(rec[1].kcc.crouched).toBe(true);
    const text = JSON.stringify(rec);
    for (let t = 0; t < 20; t++) {
      move(w, -1, 0);
      w.step();
    }
    ape.moveFlags = 0;
    w.step();
    expect(JSON.stringify(w.kcc.toRecord())).not.toBe(text);
    w.kcc.restoreRecord(JSON.parse(text));
    expect(JSON.stringify(w.kcc.toRecord())).toBe(text);
    expect(() => w.kcc.restoreRecord([{ fighter: 99, kcc: rec[0].kcc }])).toThrow(/no controller/);
  });

  it('footwork.landed holds the feet that touched down this tick only', async () => {
    const w = await make({ seed: 42 });
    const p = w.player!;
    let steps = 0;
    for (let t = 0; t < 120; t++) {
      move(w, 0, 1);
      w.step();
      expect(p.footwork.landed.length).toBeLessThanOrEqual(2);
      steps += p.footwork.landed.length;
    }
    expect(steps).toBeGreaterThan(4);
    move(w, 0, 0);
    for (let t = 0; t < 60; t++) w.step();
    expect(p.footwork.landed.length).toBe(0);
  });

  it('two worlds walk, jump and push bit-identically', async () => {
    const run = async (): Promise<string> => {
      const w = await make({ seed: 43 });
      w.terrain.generate((x, z) => 0.2 * Math.sin(x) * Math.cos(z * 0.7));
      const r = prismR(40, 'dryWood', 2.2, 6);
      entity(w, 'dryWood', { kind: 'cylinder', halfHeight: 1.1, r, sides: 6 }, { x: 1.5, y: r + 0.3, z: 0 }, 'free', LYING_Z);
      const p = w.player!;
      w.teleport(p, 0, 0, Math.PI / 2);
      const out: number[] = [];
      for (let t = 0; t < 240; t++) {
        if (t === 100) w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button: 'jump' });
        move(w, t < 150 ? 1 : -0.5, t % 40 < 20 ? 0.2 : -0.2);
        w.step();
        if (t % 20 === 0) {
          const c = w.kcc.capsulePose(p)!;
          const e = w.entities.all()[0];
          out.push(p.pos.x, p.pos.y, p.pos.z, c.p.y, e.pose.p.x, e.pose.p.z, e.pose.q.w);
        }
      }
      return out.join(',');
    };
    expect(await run()).toBe(await run());
  });
});
