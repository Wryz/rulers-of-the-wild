// The body's posture and work bends in world mode (docs/M1-DESIGN.md §1.5.3, §5.0, §5.1; core-fix): updatePose blends
// the shown posture over the walking animation (the spine, the hips' height and the hands; the feet stay the
// footwork's), ramped so it never jumps; the carry's hands are on the log; the drag's near hand reaches back for the grip
// as far as the arm allows; a work action's bend swings the head no faster than CHARACTER_TUNING.workHeadSpeedMps, so a
// take under a block is refused for reach, not cut short by a self-motion hit.
//
// Scene numbers (masses, sizes, positions) are test constants, never tuning (§9).
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bonePoint, fistPoint, FIST_OFFSET, forwardKinematics, makeRig, type Rig, SKELETON } from '../src/body/skeleton';
import { moveCommand, type VerbCommand } from '../src/sim/commands';
import type { Fighter } from '../src/sim/fighter';
import { DT } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { CHARACTER_TUNING } from '../src/world/characters';
import { groundRestY, logPrism, LYING_ALONG_X, prismRForMass, spawnBox, spawnLog, spawnStick } from '../src/world/factory';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import type { Entity, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 120_000 });

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
  resetTuning('CHARACTER_TUNING');
});

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): void {
  w.commands.push({ tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand);
}

/** Steps until the player is free with nothing buffered; the world events, copied. */
function untilFree(w: World, each?: () => void, max = 600): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < max; t++) {
    out.push(...w.step().world);
    each?.();
    const p = w.player!;
    if (p.free && !p.verbRequest) return out;
  }
  throw new Error(`the player was not free within ${max} ticks`);
}

/** A dry 6-gon log of `massKg`, `length` m along x, resting on the terrain centred at (x, z). */
function log(w: World, massKg: number, length: number, x: number, z: number): number {
  const shape = logPrism(length, prismRForMass(massKg, length, 550, PHYSICS_TUNING.logFacets));
  return spawnLog(w, { p: { x, y: groundRestY(w, x, z, shape, LYING_ALONG_X), z }, length, mass: massKg });
}

/** v rotated by unit quaternion q. */
function rotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}

/** How far `p` is from the surface of a log (a prism about its local y, as a round bar of its circumradius). */
function fromLogSurface(e: Entity, p: Vector3): number {
  if (e.shape.kind !== 'cylinder') throw new Error('a log is a prism');
  const axis = rotate(e.pose.q, { x: 0, y: 1, z: 0 });
  const d = { x: p.x - e.pose.p.x, y: p.y - e.pose.p.y, z: p.z - e.pose.p.z };
  const along = Math.max(-e.shape.halfHeight, Math.min(e.shape.halfHeight, d.x * axis.x + d.y * axis.y + d.z * axis.z));
  const off = Math.hypot(d.x - axis.x * along, d.y - axis.y * along, d.z - axis.z * along);
  return Math.max(0, off - e.shape.r);
}

/** The middle of the head's bone relative to the feet (fighter-local, × scale): what limitWorkBend holds back. */
const _rig: Rig = makeRig();
function headLocal(f: Fighter): Vector3 {
  forwardKinematics(f.pose, _rig, undefined, 0, f.scale);
  return bonePoint(_rig, 'head', SKELETON.head.length / 2, new Vector3());
}

const shown = (f: Fighter) => f.toRecord([]).postureShown;

describe('a work action’s bend (core-fix: §5.0, §4.3 self-motion)', () => {
  it('a take of a stick on a 2.6 m block in front ends outOfReach, with no impact on the player', async () => {
    const w = await make(23);
    const p = w.player!;
    spawnBox(w, { p: { x: 0, y: 1.3, z: 1.0 }, size: [1.2, 2.6, 0.5], material: 'dryWood', state: 'fixed', look: 'box' });
    const high = spawnStick(w, { p: { x: 0, y: 2.63, z: 1.0 }, length: 1, r: 0.02 });
    for (let t = 0; t < 10; t++) w.step();
    expect(w.entities.get(high)!.pose.p.y).toBeGreaterThan(2.5);
    verb(w, { verb: 'take', target: high });
    let worked = false;
    const evs = untilFree(w, () => {
      if (p.work?.kind === 'take') worked = true;
    });
    expect(worked).toBe(true);
    expect(evs.filter((e) => e.type === 'verb' && e.verb === 'take')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfReach' })]);
    expect(evs.filter((e) => e.type === 'impact' && e.defender === p)).toEqual([]);
    expect(p.hp).toBe(p.stats.maxHp);
    expect(p.inventory!.hands).toBeNull();
  });

  it('a take of a stick on the ground bends and rises with the head at no more than workHeadSpeedMps (relative to the feet), and takes it', async () => {
    const w = await make();
    const p = w.player!;
    const stick = spawnStick(w, { p: { x: 0, y: 0.03, z: 0.9 }, length: 1, r: 0.02 });
    for (let t = 0; t < 10; t++) w.step();
    verb(w, { verb: 'take', target: stick });
    let prev = headLocal(p);
    let fastest = 0;
    let low = Infinity;
    const evs = untilFree(w, () => {
      const h = headLocal(p);
      fastest = Math.max(fastest, h.distanceTo(prev) / DT);
      low = Math.min(low, h.y);
      prev = h;
    });
    // (Into the locomotion cross-fade after it too: a few frames more.)
    for (let t = 0; t < 12; t++) {
      w.step();
      const h = headLocal(p);
      fastest = Math.max(fastest, h.distanceTo(prev) / DT);
      prev = h;
    }
    expect(evs.filter((e) => e.type === 'verb' && e.verb === 'take')).toEqual([expect.objectContaining({ ok: true, entity: stick })]);
    expect(p.inventory!.hands?.entity).toBe(stick);
    // It did bend (the head went down by more than 0.3 m), never faster than the limit (DS's squat: up to 4.7 m/s).
    expect(low).toBeLessThan(1.25);
    expect(fastest).toBeLessThanOrEqual(CHARACTER_TUNING.workHeadSpeedMps * 1.05);
  });

  it("the bend's cap and the step-in together stay under a human's v_safe, with a margin: a work action never hits its own block", () => {
    // The self-hit (6.2 m/s on the 2.6 m block) was the bend's 4.7 m/s plus the step-in's: the head meets what is in
    // front at up to their sum. 3 + 0.045 / DT = 5.7 m/s against 6 m/s.
    const head = CHARACTER_TUNING.workHeadSpeedMps + VERB_TUNING.workStepM / DT;
    expect(head).toBeLessThanOrEqual(0.96 * SPECIES_BODY.human.vSafe);
  });
});

describe('the posture over the animation (core-fix: §1.5.3)', () => {
  it('ramps in over postureRampFrames when set at once, and out again: no jump of the head', async () => {
    // A twin world without the posture is the body as it would stand (idle life and all) at every tick.
    const w = await make();
    const twin = await make();
    const p = w.player!;
    const q = twin.player!;
    const both = () => {
      w.step();
      twin.step();
    };
    for (let t = 0; t < 30; t++) both();
    const ramp = CHARACTER_TUNING.postureRampFrames;
    expect(headLocal(p).distanceTo(headLocal(q))).toBe(0);
    p.posture = { id: 'sniff', weight: 1 };
    let prev = headLocal(p);
    let biggest = 0;
    for (let t = 1; t <= ramp + 5; t++) {
      both();
      if (t <= ramp) expect(shown(p)!.weight).toBeCloseTo(t / ramp, 9);
      const h = headLocal(p);
      biggest = Math.max(biggest, h.distanceTo(prev));
      prev = h;
    }
    expect(shown(p)).toEqual({ id: 'sniff', weight: 1 });
    // The head went where the sniff puts it (out and down), a little at a time.
    expect(headLocal(p).distanceTo(headLocal(q))).toBeGreaterThan(0.1);
    expect(biggest / DT).toBeLessThan(2);
    // Another posture: the shown one ramps out first, then the new one in.
    p.posture = { id: 'carryFront', weight: 1 };
    both();
    expect(shown(p)).toEqual({ id: 'sniff', weight: 1 - 1 / ramp });
    for (let t = 0; t < ramp; t++) both();
    expect(shown(p)?.id).toBe('carryFront');
    // None: out again, back to the twin's stance.
    p.posture = null;
    for (let t = 0; t < 3 * ramp; t++) both();
    expect(shown(p)).toBeNull();
    expect(headLocal(p).distanceTo(headLocal(q))).toBeLessThan(0.01);
  });

  it('carrying a 40 kg log on the shoulder, standing or walking, both hands are on the log (within 0.15 m of it)', async () => {
    const w = await make();
    const p = w.player!;
    const id = log(w, 40, 2.2, 0, 1.2);
    w.step();
    verb(w, { verb: 'take', target: id });
    untilFree(w);
    expect(p.inventory!.hands?.mode).toBe('carry');
    expect(p.posture?.id).toBe('carryShoulder');
    const fists = () => [fistPoint(p.rig, 'L', new Vector3()), fistPoint(p.rig, 'R', new Vector3())];
    for (let t = 0; t < CHARACTER_TUNING.postureRampFrames + 10; t++) w.step();
    const e = w.entities.get(id)!;
    for (const fist of fists()) {
      expect(fromLogSurface(e, fist)).toBeLessThanOrEqual(0.15);
      // (Not hanging at the hips under it: the log sits 1.55 m up.)
      expect(fist.y - p.pos.y).toBeGreaterThan(1.3);
    }
    for (let t = 0; t < 90; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
      w.step();
      if (t % 15 !== 14) continue;
      for (const fist of fists()) expect(fromLogSurface(w.entities.get(id)!, fist), `walking, tick ${t}`).toBeLessThanOrEqual(0.15);
    }
  });

  it('carrying a short 25 kg log in front, standing or walking, both hands are on the log (within 0.15 m of it)', async () => {
    const w = await make();
    const p = w.player!;
    const id = log(w, 25, 1.2, 0, 1.0);
    w.step();
    verb(w, { verb: 'take', target: id });
    untilFree(w);
    expect(p.inventory!.hands?.mode).toBe('carry');
    expect(p.inventory!.hands?.twoHanded).toBe(true);
    expect(p.posture?.id).toBe('carryFront');
    const fists = () => [fistPoint(p.rig, 'L', new Vector3()), fistPoint(p.rig, 'R', new Vector3())];
    for (let t = 0; t < CHARACTER_TUNING.postureRampFrames + 10; t++) w.step();
    for (const fist of fists()) expect(fromLogSurface(w.entities.get(id)!, fist)).toBeLessThanOrEqual(0.15);
    for (let t = 0; t < 90; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 0, 1));
      w.step();
      if (t % 15 !== 14) continue;
      for (const fist of fists()) expect(fromLogSurface(w.entities.get(id)!, fist), `walking, tick ${t}`).toBeLessThanOrEqual(0.15);
    }
  });

  it('dragging, the near hand reaches back for the grip as far as the arm allows', async () => {
    const w = await make(31);
    const p = w.player!;
    w.teleport(p, 0, 0, -Math.PI / 2);
    const L = 3.6;
    const id = log(w, 80, L, -0.8 - L / 2, 0);
    w.step();
    verb(w, { verb: 'take', target: id });
    untilFree(w);
    expect(p.inventory!.hands?.mode).toBe('drag');
    expect(p.posture?.id).toBe('dragBack');
    const arm = (SKELETON.upperArmL.length + SKELETON.foreArmL.length + FIST_OFFSET) * p.scale;
    let checked = 0;
    for (let t = 0; t < 180; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
      if (t < 60 || t % 10 !== 0) continue;
      const g = p.reachAt!;
      expect(g).not.toBeNull();
      // The hand on the grip's side, and its shoulder.
      const toGrip = { x: g.x - p.pos.x, z: g.z - p.pos.z };
      const leftSide = toGrip.x * Math.cos(p.yaw) - toGrip.z * Math.sin(p.yaw) >= 0;
      const fist = fistPoint(p.rig, leftSide ? 'L' : 'R', new Vector3());
      const shoulder = p.rig[leftSide ? 'upperArmL' : 'upperArmR'].pos;
      const grip = new Vector3(g.x, g.y, g.z);
      const short = Math.max(0, shoulder.distanceTo(grip) - arm);
      expect(fist.distanceTo(grip), `tick ${t}`).toBeLessThanOrEqual(short + 0.1);
      // Behind the body, toward the log trailing after it.
      const back = (fist.x - p.pos.x) * Math.sin(p.yaw) + (fist.z - p.pos.z) * Math.cos(p.yaw);
      expect(back, `tick ${t}`).toBeLessThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('the shown posture is saved with the fighter and read back', async () => {
    const w = await make();
    const p = w.player!;
    w.step();
    p.posture = { id: 'headLow', weight: 0.5 };
    for (let t = 0; t < 3; t++) w.step();
    const rec = p.toRecord(w.combat.drops);
    expect(rec.postureShown).toEqual({ id: 'headLow', weight: 3 / CHARACTER_TUNING.postureRampFrames });
    p.posture = null;
    for (let t = 0; t < 40; t++) w.step();
    expect(shown(p)).toBeNull();
    p.restoreRecord(JSON.parse(JSON.stringify(rec)), { fighters: w.combat.fighters, drops: w.combat.drops });
    expect(shown(p)).toEqual(rec.postureShown);
  });
});
