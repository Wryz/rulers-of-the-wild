// The entity factories (docs/M1-DESIGN.md §6.7; package P07): the shape, mass, material, facets and pose of every kind of
// thing generation, test scenes and dev spawns make: trees (a 30 cm × 15 m one is 738 kg above the cut) with their
// hanging vines, saplings, rope coils, sticks (pointed or not), logs (by radius or by mass, anchored, snags), stones and
// flint, boxes, grass bundles and the starter axe's parts; then one of every kind spawned on the ground at rest,
// deterministically, and a generated scene that saves nothing until touched.
//
// The joint store is P10's (a stub that throws until then): the hanging vine's `joints.rope` and the axe's `joints.lash`
// calls are checked against a stand-in that records them (P10 tests the rope and the lashing themselves).
//
// Scene numbers (sizes, masses, positions) are test constants, never tuning (§9).
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetTuning, setTuningValue, TUNING, tuningLeaves } from '../src/tuning/registry';
import { CLEARING_TUNING } from '../src/world/clearing';
import {
  FACTORY_TUNING,
  grassBox,
  groundRestY,
  hangVine,
  logPrism,
  LYING_ALONG_X,
  prismRForMass,
  prismRForRoundDiam,
  ropeCoilShape,
  spawnBox,
  spawnGrass,
  spawnLog,
  spawnRopeCoil,
  spawnSapling,
  spawnStarterAxe,
  spawnStick,
  spawnStone,
  spawnTree,
  stickPrism,
  stoneHull,
  trunkPrism,
} from '../src/world/factory';
import { FELL_TUNING } from '../src/world/felling';
import { MATERIALS } from '../src/world/materials';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import { cylinderPoints, flatPrism, principalAxis, shapeVolume, taperEnd, triangulate } from '../src/world/shapes';
import type { Anchor, Entity, MaterialId, Pose3, Quat, Shape, V3 } from '../src/world/types';
import { TOOL_TUNING, VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

/** Rapier worlds and a few hundred ticks: explicit time limits (§11's convention), generous for a loaded machine. */
vi.setConfig({ testTimeout: 60_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 7, scene: 'empty', nav: 'off', player: false, size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('FACTORY_TUNING');
  resetTuning('PHYSICS_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

/** Area of a regular N-gon of circumradius r. */
const ngonArea = (r: number, sides: number): number => (sides / 2) * r * r * Math.sin((2 * Math.PI) / sides);

function rotate(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return { x: v.x + q.w * tx + (q.y * tz - q.z * ty), y: v.y + q.w * ty + (q.z * tx - q.x * tz), z: v.z + q.w * tz + (q.x * ty - q.y * tx) };
}
const conj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const toWorld = (pose: Pose3, v: V3): V3 => {
  const r = rotate(pose.q, v);
  return { x: pose.p.x + r.x, y: pose.p.y + r.y, z: pose.p.z + r.z };
};
const toLocal = (pose: Pose3, v: V3): V3 => rotate(conj(pose.q), { x: v.x - pose.p.x, y: v.y - pose.p.y, z: v.z - pose.p.z });
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const axisAngle = (ax: V3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(angle / 2) };
};
const mulQuat = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

/** A shape's corners in its local frame (prisms, boxes, hulls). */
function corners(s: Shape): V3[] {
  const flat = s.kind === 'cylinder' ? cylinderPoints(s) : s.kind === 'hull' ? [...s.points] : s.kind === 'box' ? boxCorners(s) : [];
  const out: V3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
  return out;
}
function boxCorners(s: { hx: number; hy: number; hz: number }): number[] {
  const out: number[] = [];
  for (const x of [-s.hx, s.hx]) for (const y of [-s.hy, s.hy]) for (const z of [-s.hz, s.hz]) out.push(x, y, z);
  return out;
}
/** The lowest world y of an entity's shape at its pose. */
const lowestY = (e: Entity): number => Math.min(...corners(e.shape).map((c) => toWorld(e.pose, c).y));
/** Extents of a flat xyz point list per axis. */
function extents(points: readonly number[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], points[i]);
    hi[i % 3] = Math.max(hi[i % 3], points[i]);
  }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

interface RopeCall {
  a: Anchor;
  b: Anchor;
  lengthM: number;
  rope: { entity: number; lengthM: number };
  credit: string[];
}
interface LashCall {
  a: Anchor;
  b: Anchor;
  rope: { entity: number; lengthM: number };
  credit: string[];
}

/**
 * A stand-in for P10's joint store: records the factory's `rope` and `lash` calls and hands out joint ids from the
 * world's counter. `tie`: also make the rope entity `tied` and the jointed entities touched, as the real store may.
 */
function standInJoints(w: World, o: { tie?: boolean } = {}): { ropes: RopeCall[]; lashes: LashCall[] } {
  const ropes: RopeCall[] = [];
  const lashes: LashCall[] = [];
  const asP10Might = (rope: number, ends: Anchor[]): void => {
    if (!o.tie) return;
    w.entities.setState(ent(w, rope), 'tied');
    for (const a of ends) if (a.entity !== null) ent(w, a.entity).touched = true;
  };
  vi.spyOn(w.joints, 'rope').mockImplementation((a, b, lengthM, rope, credit) => {
    ropes.push({ a, b, lengthM, rope, credit });
    asP10Might(rope.entity, [a, b]);
    return w.ids.joint.take();
  });
  vi.spyOn(w.joints, 'lash').mockImplementation((a, b, rope, credit) => {
    lashes.push({ a, b, rope, credit });
    asP10Might(rope.entity, [a, b]);
    return w.ids.joint.take();
  });
  return { ropes, lashes };
}

// ---------------------------------------------------------------------------
// The tuning table and the pure shapes
// ---------------------------------------------------------------------------

describe('FACTORY_TUNING', () => {
  it('is registered with a unit and a source on every leaf, holding its starting values', () => {
    const entry = TUNING.find((e) => e.name === 'FACTORY_TUNING');
    expect(entry?.folder).toBe('World › factory');
    for (const leaf of tuningLeaves(entry!)) {
      expect(leaf.meta.unit, leaf.key).not.toBe('');
      expect(leaf.meta.source, leaf.key).not.toBe('');
    }
    expect(FACTORY_TUNING).toMatchObject({
      materials: { tree: 'greenWood', sapling: 'greenWood', stick: 'dryWood', log: 'dryWood', stone: 'stone', grass: 'leaves' },
      ropeRadiusM: 0.01,
      snagElevationDeg: 45,
      starterAxe: { handleLengthM: 0.55, handleRoundDiamM: 0.04, handleMaterial: 'greenWood', headKg: 0.6, headMaterial: 'flint', edgeSharpness: 0.9, lashMaterial: 'vine' },
    });
    expect(FACTORY_TUNING.stoneProtos).toHaveLength(4);
    // The axe head's prototype is one of them.
    const headProto = tuningLeaves(entry!).find((l) => l.key === 'starterAxe.headProto');
    expect(headProto?.meta).toMatchObject({ min: 0, max: FACTORY_TUNING.stoneProtos.length - 1, step: 1 });
  });

  it('has four compact stone prototypes, longest along x, resting on a flat bottom face', () => {
    for (let k = 0; k < FACTORY_TUNING.stoneProtos.length; k++) {
      const s = stoneHull(1, k, 'stone');
      const [ex, ey, ez] = extents(s.points);
      expect(principalAxis(s).axis, `proto ${k}`).toBe('x');
      expect(ex / Math.max(ey, ez), `proto ${k} aspect`).toBeLessThan(TOOL_TUNING.compactMaxAspect);
      // A face at the bottom: at least three corners at the lowest y.
      const ys = corners(s).map((c) => c.y);
      const low = Math.min(...ys);
      expect(ys.filter((y) => Math.abs(y - low) < 1e-12).length, `proto ${k} bottom face`).toBeGreaterThanOrEqual(3);
      // Centrally symmetric: every corner's mirror image is a corner.
      for (const c of corners(s)) expect(corners(s).some((d) => dist(d, { x: -c.x, y: -c.y, z: -c.z }) < 1e-12)).toBe(true);
    }
  });
});

describe('shapes', () => {
  it('trunks, sticks and coils are PHYSICS_TUNING.cylinderFacets-gon prisms, logs logFacets-gon, read live', () => {
    expect(trunkPrism(0.3, 15)).toEqual({ kind: 'cylinder', halfHeight: 7.5, r: 0.15, sides: 8 });
    expect(stickPrism(1.4, 0.05)).toEqual({ kind: 'cylinder', halfHeight: 0.7, r: 0.05, sides: 8 });
    expect(logPrism(4, 0.2)).toEqual({ kind: 'cylinder', halfHeight: 2, r: 0.2, sides: 6 });
    expect(ropeCoilShape(10).sides).toBe(8);
    setTuningValue('PHYSICS_TUNING', 'logFacets', 7);
    setTuningValue('PHYSICS_TUNING', 'cylinderFacets', 10);
    expect(logPrism(4, 0.2).sides).toBe(7);
    expect(stickPrism(1, 0.02).sides).toBe(10);
    expect(trunkPrism(0.3, 10).sides).toBe(10);
  });

  it('prismRForMass and prismRForRoundDiam give the prism of that mass and of a round section', () => {
    const r = prismRForMass(300, 4.4, MATERIALS.dryWood.density, 6);
    expect(MATERIALS.dryWood.density * ngonArea(r, 6) * 4.4).toBeCloseTo(300, 9);
    const r8 = prismRForRoundDiam(0.04, 8);
    expect(ngonArea(r8, 8)).toBeCloseTo(Math.PI * 0.02 * 0.02, 12);
    expect(r8).toBeGreaterThan(0.02);
  });

  it('a coil holds its rope: π·ropeRadiusM²·length of volume, a flat disc (a 20 m vine coil is 3.77 kg, §5.1)', () => {
    const s = ropeCoilShape(20);
    expect(shapeVolume(s)).toBeCloseTo(Math.PI * 0.01 * 0.01 * 20, 12);
    expect(s.halfHeight / s.r).toBeCloseTo(FACTORY_TUNING.coilAspect, 12);
    expect(MATERIALS.vine.density * shapeVolume(s)).toBeCloseTo(3.77, 2);
    // The six Clearing coils, 10-20 m: 1.9-3.8 kg (§6.7).
    expect(MATERIALS.vine.density * shapeVolume(ropeCoilShape(10))).toBeCloseTo(1.885, 3);
    setTuningValue('FACTORY_TUNING', 'ropeRadiusM', 0.02);
    expect(MATERIALS.vine.density * shapeVolume(ropeCoilShape(20))).toBeCloseTo(4 * 3.7699, 3);
  });

  it('a stone is its prototype scaled uniformly to the mass; a grass bundle a flat box of its mass', () => {
    for (let k = 0; k < 4; k++) {
      const a = stoneHull(2, k, 'stone');
      const b = stoneHull(16, k, 'stone');
      expect(MATERIALS.stone.density * shapeVolume(a)).toBeCloseTo(2, 9);
      expect(MATERIALS.stone.density * shapeVolume(b)).toBeCloseTo(16, 9);
      // Uniform: every coordinate doubles from 2 kg to 16 kg.
      a.points.forEach((c, i) => expect(b.points[i]).toBeCloseTo(2 * c, 12));
    }
    expect(MATERIALS.flint.density * shapeVolume(stoneHull(0.6, 0, 'flint'))).toBeCloseTo(0.6, 9);
    expect(() => stoneHull(1, 4, 'stone')).toThrow(/prototype/);
    expect(() => stoneHull(0, 0, 'stone')).toThrow(/positive/);

    const g = grassBox(2, 'leaves');
    expect(MATERIALS.leaves.density * shapeVolume(g)).toBeCloseTo(2, 9);
    expect(2 * g.hy).toBeCloseTo(FACTORY_TUNING.grassThicknessM, 12);
    expect(g.hx / g.hz).toBeCloseTo(FACTORY_TUNING.grassAspect, 12);
    const sized = grassBox(1, 'leaves', [1, 0.1, 0.5]);
    expect(MATERIALS.leaves.density * shapeVolume(sized)).toBeCloseTo(1, 9);
    expect(sized.hx / sized.hy).toBeCloseTo(10, 9);
    expect(sized.hx / sized.hz).toBeCloseTo(2, 9);
  });
});

// ---------------------------------------------------------------------------
// Trees, saplings and hanging vines
// ---------------------------------------------------------------------------

describe('trees and saplings', () => {
  it('a 30 cm × 15 m tree is a fixed green 8-gon trunk, 738 kg above the cut', async () => {
    const w = await make();
    const { tree, vine } = spawnTree(w, { at: { x: 3, z: -4 }, diameter: 0.3, height: 15 });
    expect(vine).toBeNull();
    const e = ent(w, tree);
    expect(e.shape).toEqual({ kind: 'cylinder', halfHeight: 7.5, r: 0.15, sides: PHYSICS_TUNING.cylinderFacets });
    expect(e.material).toBe('greenWood');
    expect(e.state).toBe('fixed');
    expect(e.body?.isFixed()).toBe(true);
    expect(e.look).toBe('tree');
    expect(e.plant).toEqual({ diameter: 0.3, height: 15, phase: 'standing', cut: null, stump: null, fall: null });
    expect(e.pose.p).toEqual({ x: 3, y: 7.5, z: -4 });
    expect(e.pose.q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(e.credit).toEqual([]);
    expect(e.generated).toBe(false);
    // Mass = density × volume of the whole trunk; above the FELL_TUNING.cutHeightM cut, 738 kg (§11.2(d)).
    expect(e.mass).toBeCloseTo(800 * ngonArea(0.15, 8) * 15, 9);
    const above = (e.mass * (15 - FELL_TUNING.cutHeightM)) / 15;
    expect(above).toBeCloseTo(MATERIALS.greenWood.density * shapeVolume(trunkPrism(0.3, 15 - FELL_TUNING.cutHeightM)), 9);
    console.info(`30 cm × 15 m tree: ${e.mass.toFixed(1)} kg, ${above.toFixed(1)} kg above the cut`);
    expect(Math.abs(above - 738)).toBeLessThan(0.5);
  });

  it('on a slope the trunk stands on the lowest ground under its footprint', async () => {
    const w = await make();
    w.terrain.generate((x, z) => 0.4 * x + 0.1 * z);
    const { tree } = spawnTree(w, { at: { x: 2, z: 1 }, diameter: 0.5, height: 12 });
    const e = ent(w, tree);
    const base = e.pose.p.y - 6;
    const ring = corners(e.shape).filter((c) => c.y < 0);
    const under = ring.map((c) => w.terrain.heightAt(2 + c.x, 1 + c.z));
    expect(Math.min(...under)).toBeCloseTo(base, 5);
    for (const h of under) expect(h).toBeGreaterThanOrEqual(base - 1e-5);
    expect(w.terrain.heightAt(2, 1)).toBeGreaterThan(base);
  });

  it('a sapling is a rooted green 8-gon too', async () => {
    const w = await make();
    const id = spawnSapling(w, { at: { x: -1, z: 2 }, diameter: 0.06, height: 3 });
    const e = ent(w, id);
    expect(e.look).toBe('sapling');
    expect(e.material).toBe('greenWood');
    expect(e.state).toBe('fixed');
    expect(e.shape).toEqual({ kind: 'cylinder', halfHeight: 1.5, r: 0.03, sides: 8 });
    expect(e.plant?.phase).toBe('standing');
    expect(e.plant?.diameter).toBe(0.06);
    expect(e.mass).toBeCloseTo(800 * ngonArea(0.03, 8) * 3, 9);
    expect(e.pose.p.y).toBeCloseTo(1.5, 6);
  });

  it('refuses a tree or a vine it can\'t make', async () => {
    const w = await make();
    expect(() => spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0, height: 10 })).toThrow(/positive/);
    expect(() => spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 10, vine: { anchorH: 11, lengthM: 15, yaw: 0 } })).toThrow(/anchored 11 m up a 10 m tree/);
    expect(() => spawnSapling(w, { at: { x: Number.NaN, z: 0 }, diameter: 0.05, height: 3 })).toThrow(/finite/);
    expect(w.entities.all()).toHaveLength(0);
  });
});

describe('hanging vines', () => {
  it('the swinging-log scene\'s vine: anchored 8 m up the inner side, its end lying loose, a rope joint of vine (§11.2(c))', async () => {
    const w = await make();
    const joints = standInJoints(w);
    const out = spawnTree(w, { at: { x: 0, z: 2.6 }, diameter: 0.4, height: 14, vine: { anchorH: 8, lengthM: 9, yaw: Math.PI } });
    expect(out.vine).not.toBeNull();
    const { tree, vine } = out as { tree: number; vine: { rope: number; joint: number } };
    expect(vine.rope).toBe(tree + 1);
    expect(joints.ropes).toHaveLength(1);
    const call = joints.ropes[0];
    expect(vine.joint).toBe(w.ids.joint.next - 1);

    // a: on the trunk, at the circumradius on the yaw side, 8 m up: (0, 8, 2.4).
    expect(call.a.entity).toBe(tree);
    expect(call.a.loose).toBeUndefined();
    const anchorW = toWorld(ent(w, tree).pose, call.a.local);
    expect(anchorW.x).toBeCloseTo(0, 6);
    expect(anchorW.y).toBeCloseTo(8, 5);
    expect(anchorW.z).toBeCloseTo(2.4, 6);
    // b: loose, lying on the ground, the length beyond the anchor height laid out along the yaw (measured from the tree's
    // record pose, float32: 2.6 is 2.5999999 there).
    expect(call.b).toEqual({ entity: null, local: { x: expect.closeTo(0, 9), y: 0, z: expect.closeTo(1.4, 6) }, loose: true });
    expect(call.lengthM).toBe(9);
    expect(call.rope).toEqual({ entity: vine.rope, lengthM: 9 });
    expect(call.credit).toEqual([]);

    // The rope entity: 9 m of vine rope, tied (no body).
    const rope = ent(w, vine.rope);
    expect(rope.material).toBe('vine');
    expect(rope.rope).toEqual({ lengthM: 9 });
    expect(rope.mass).toBeCloseTo(MATERIALS.vine.density * Math.PI * 0.01 * 0.01 * 9, 9);
    expect(rope.state).toBe('tied');
    expect(rope.body).toBeNull();
    expect(rope.look).toBe('coil');
  });

  it('the felled-tree scene\'s 18.2 m vine 10 m up lies 8.2 m out; one shorter than its anchor hangs free', async () => {
    const w = await make();
    const joints = standInJoints(w);
    const yaw = Math.atan2(1, -1); // toward (+x, −z)
    spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 15, vine: { anchorH: 10, lengthM: 18.2, yaw } });
    const end = joints.ropes[0].b.local;
    const anchor = { x: 0.15 * Math.sin(yaw), z: 0.15 * Math.cos(yaw) };
    expect(Math.hypot(end.x - anchor.x, end.z - anchor.z)).toBeCloseTo(8.2, 9);
    expect(Math.atan2(end.x - anchor.x, end.z - anchor.z)).toBeCloseTo(yaw, 9);
    expect(end.y).toBe(0);

    spawnTree(w, { at: { x: 5, z: 5 }, diameter: 0.3, height: 15, vine: { anchorH: 10, lengthM: 6, yaw: 0 } });
    const hang = joints.ropes[1].b.local;
    expect(hang.x).toBeCloseTo(5, 9);
    expect(hang.y).toBeCloseTo(4, 9);
    expect(hang.z).toBeCloseTo(5.15, 9);
  });

  it('a generated tree and its vine leave the factory generated and untouched, whatever the joint store marks', async () => {
    for (const tie of [false, true]) {
      const w = await make();
      standInJoints(w, { tie });
      const { tree, vine } = spawnTree(w, { at: { x: 1, z: 1 }, diameter: 0.3, height: 12, vine: { anchorH: 9, lengthM: 15, yaw: 1 }, generated: true });
      for (const id of [tree, vine!.rope]) {
        expect(ent(w, id).generated, `tie ${tie}`).toBe(true);
        expect(ent(w, id).touched, `tie ${tie}`).toBe(false);
      }
      expect(ent(w, vine!.rope).state).toBe('tied');
      // Nothing generated and untouched is saved (§8.3).
      expect(w.entities.toRecord()).toEqual([]);
    }
  });

  it('hangVine hangs vines on trees spawned earlier, so generation can make every tree first (§6.7 id order)', async () => {
    const w = await make();
    const joints = standInJoints(w, { tie: true });
    const g = { generated: true };
    const t1 = spawnTree(w, { at: { x: 0, z: 2.6 }, diameter: 0.4, height: 14, ...g }).tree;
    const t2 = spawnTree(w, { at: { x: 0, z: -2.6 }, diameter: 0.4, height: 14, ...g }).tree;
    const sapling = spawnSapling(w, { at: { x: 6, z: 0 }, diameter: 0.06, height: 3, ...g });
    const v1 = hangVine(w, t1, { anchorH: 8, lengthM: 9, yaw: Math.PI }, g);
    const v2 = hangVine(w, t2, { anchorH: 8, lengthM: 9, yaw: 0 }, g);
    expect([t1, t2, sapling, v1.rope, v2.rope]).toEqual([1, 2, 3, 4, 5]);
    expect([v1.joint, v2.joint]).toEqual([1, 2]);
    for (const [call, side] of [[joints.ropes[0], 1], [joints.ropes[1], -1]] as const) {
      const anchorW = toWorld(ent(w, call.a.entity!).pose, call.a.local);
      expect(anchorW.y).toBeCloseTo(8, 5);
      expect(anchorW.z).toBeCloseTo(2.4 * side, 6);
      expect(call.b.local.z).toBeCloseTo(1.4 * side, 6); // from the tree's float32 pose
      expect(call.b.loose).toBe(true);
    }
    // Generated: the trees stay untouched though the joint store marked them, the ropes are tied and untouched.
    for (const id of [t1, t2, v1.rope, v2.rope]) expect(ent(w, id).touched).toBe(false);
    expect(ent(w, v1.rope).state).toBe('tied');
    expect(w.entities.toRecord()).toEqual([]);

    // Not generated (a dev spawn): the joint store's marks stand.
    const t3 = spawnTree(w, { at: { x: -6, z: 0 }, diameter: 0.3, height: 12 }).tree;
    hangVine(w, t3, { anchorH: 6, lengthM: 10, yaw: 2 });
    expect(ent(w, t3).touched).toBe(true);

    expect(() => hangVine(w, 999, { anchorH: 5, lengthM: 8, yaw: 0 })).toThrow(/no rooted tree 999/);
    const stick = spawnStick(w, { p: { x: 8, y: 0.05, z: 8 }, length: 1, r: 0.03 });
    expect(() => hangVine(w, stick, { anchorH: 0.5, lengthM: 2, yaw: 0 })).toThrow(/no rooted tree/);
    expect(() => hangVine(w, t1, { anchorH: 20, lengthM: 25, yaw: 0 })).toThrow(/anchored 20 m up a 14 m tree/);
    expect(() => hangVine(w, t1, { anchorH: 5, lengthM: -1, yaw: 0 })).toThrow(/positive/);
  });

  it('spawnTree\'s vine is hangVine\'s', async () => {
    const calls: RopeCall[][] = [];
    for (const split of [false, true]) {
      const w = await make();
      const joints = standInJoints(w);
      const vine = { anchorH: 10, lengthM: 18.2, yaw: 0.7 };
      if (split) hangVine(w, spawnTree(w, { at: { x: 1, z: 2 }, diameter: 0.3, height: 15 }).tree, vine);
      else spawnTree(w, { at: { x: 1, z: 2 }, diameter: 0.3, height: 15, vine });
      calls.push(joints.ropes);
    }
    expect(calls[1]).toEqual(calls[0]);
  });

  it('calls the joint store, which is P10\'s', async () => {
    const w = await make();
    const rope = vi.spyOn(w.joints, 'rope');
    try {
      spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 12, vine: { anchorH: 9, lengthM: 15, yaw: 0 } });
    } catch {
      // The P05 stub throws until P10 implements rope().
    }
    expect(rope).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Coils, sticks, logs
// ---------------------------------------------------------------------------

describe('rope coils', () => {
  it('a 20 m vine coil weighs 3.77 kg and lies flat on its support', async () => {
    const w = await make();
    const id = spawnRopeCoil(w, { at: { x: 1, y: 0, z: 2 }, material: 'vine', lengthM: 20 });
    const e = ent(w, id);
    expect(e.material).toBe('vine');
    expect(e.rope).toEqual({ lengthM: 20 });
    expect(e.look).toBe('coil');
    expect(e.state).toBe('free');
    expect(e.shape).toEqual(ropeCoilShape(20));
    expect(e.mass).toBeCloseTo(3.77, 2);
    expect(e.pose.q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(lowestY(e)).toBeCloseTo(0, 6);
    const sinew = ent(w, spawnRopeCoil(w, { at: { x: 3, y: 0, z: 2 }, material: 'sinew', lengthM: 10 }));
    expect(sinew.mass).toBeCloseTo(MATERIALS.sinew.density * Math.PI * 1e-4 * 10, 9);
    expect(() => spawnRopeCoil(w, { at: { x: 0, y: 0, z: 0 }, material: 'dryWood' as 'vine', lengthM: 5 })).toThrow(/rope-like/);
    expect(() => spawnRopeCoil(w, { at: { x: 0, y: 0, z: 0 }, material: 'vine', lengthM: 0 })).toThrow(/positive/);
  });

  /**
   * 30 drops of `make` from 0.2-1 m over terrain `h`, stepped 6 s: how many end below the ground (their lowest vertex
   * more than 5 cm under it) and the worst depth (m).
   */
  async function drops(h: (x: number, z: number) => number, make1: (w: World, x: number, y: number, z: number, i: number) => number) {
    const w = await make({ size: 50 });
    w.terrain.generate(h);
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const x = -18 + (i % 6) * 7 + 0.37 * (i % 5);
      const z = -18 + Math.floor(i / 6) * 8 + 0.29 * (i % 7);
      ids.push(make1(w, x, w.terrain.heightAt(x, z) + 0.2 + (0.8 * (i % 4)) / 3, z, i));
    }
    for (let t = 0; t < 360; t++) w.step();
    let sunk = 0;
    let worst = -Infinity;
    for (const id of ids) {
      const e = ent(w, id);
      const depth = w.entities.depthBelowGround(e.shape, e.pose);
      worst = Math.max(worst, depth);
      if (depth > 0.05) sunk++;
    }
    return { sunk, worst };
  }
  const SLOPE2 = (x: number): number => 0.02 * x;
  const ROUGH = (x: number, z: number): number => 0.6 * Math.sin(0.31 * x) * Math.cos(0.23 * z) + 0.25 * Math.sin(1.7 * x + 0.4) + 0.2 * Math.cos(1.3 * z);

  it("a coil is a flat prism, so its collider is Rapier's cylinder of its volume (shapes.ts colliderDesc): its body weighs what its record does", async () => {
    const w = await make();
    const e = ent(w, spawnRopeCoil(w, { at: { x: 1, y: 0, z: 2 }, material: 'vine', lengthM: 20 }));
    expect(flatPrism(e.shape as Extract<Shape, { kind: 'cylinder' }>)).toBe(true);
    expect(e.collider!.shape.type).toBe(RAPIER.ShapeType.Cylinder);
    expect(e.body!.mass()).toBeCloseTo(e.mass, 4);
    // A stick, a log and a trunk lie on their sides: hulls of their prisms.
    expect(flatPrism(stickPrism(2.4, 0.07))).toBe(false);
    expect(flatPrism(logPrism(4.4, 0.23))).toBe(false);
    expect(flatPrism(trunkPrism(0.3, 15))).toBe(false);
    const stick = ent(w, spawnStick(w, { p: { x: 4, y: 0.1, z: 2 }, length: 2.4, r: 0.07 }));
    expect(stick.collider!.shape.type).toBe(RAPIER.ShapeType.ConvexPolyhedron);
  });

  it.each([
    ['a 2 % slope', SLOPE2],
    ['rough terrain', ROUGH],
  ] as const)('30 vine coils dropped on %s all come to rest on it (none sinks through the heightfield)', async (_, h) => {
    const r = await drops(h, (w, x, y, z, i) => spawnRopeCoil(w, { at: { x, y, z }, material: 'vine', lengthM: 8 + 2 * (i % 7) }));
    expect(r.sunk).toBe(0);
    expect(r.worst).toBeLessThan(0.02);
  });

  it('30 flat 8-gon discs (cross-cut rounds) dropped tumbling on a 2 % slope and on flat ground come to rest on it', async () => {
    for (const h of [SLOPE2, () => 0]) {
      const r = await drops(h, (w, x, y, z, i) => {
        const a = 0.7 * i;
        const q = { x: Math.sin(a) * Math.sin(0.4 * i), y: 0, z: Math.cos(a) * Math.sin(0.4 * i), w: Math.cos(0.4 * i) };
        return w.entities.create({ material: 'dryWood', shape: { kind: 'cylinder', halfHeight: 0.08, r: 0.33, sides: 8 }, p: { x, y: y + 0.3, z }, q, look: 'round' }).id;
      });
      expect(r.sunk).toBe(0);
      expect(r.worst).toBeLessThan(0.02);
    }
  });
});

describe('sticks', () => {
  it('an 8-gon prism of dry wood lying along x with a flat face down', async () => {
    const w = await make();
    const shape = stickPrism(2.4, 0.07);
    const id = spawnStick(w, { p: { x: 0, y: groundRestY(w, 0, 0, shape, LYING_ALONG_X), z: 0 }, length: 2.4, r: 0.07 });
    const e = ent(w, id);
    expect(e.shape).toEqual(shape);
    expect(e.material).toBe('dryWood');
    expect(e.look).toBe('stick');
    expect(e.state).toBe('free');
    expect(e.sharpPoints).toEqual([]);
    expect(e.mass).toBeCloseTo(550 * ngonArea(0.07, 8) * 2.4, 9);
    // Local +y (the axis) along world +x; a face (two corners per ring) on the ground.
    const ax = rotate(e.pose.q, { x: 0, y: 1, z: 0 });
    expect(ax.x).toBeCloseTo(1, 6);
    expect(e.pose.p.y).toBeCloseTo(0.07 * Math.cos(Math.PI / 8), 6);
    const ys = corners(e.shape).map((c) => toWorld(e.pose, c).y);
    expect(ys.filter((y) => Math.abs(y) < 1e-6)).toHaveLength(4);

    const upright = axisAngle({ x: 1, y: 0, z: 0 }, 0);
    const u = ent(w, spawnStick(w, { p: { x: 2, y: 0.7, z: 0 }, q: upright, length: 1.4, r: 0.05, material: 'greenWood' }));
    expect(u.material).toBe('greenWood');
    expect(rotate(u.pose.q, { x: 0, y: 1, z: 0 }).y).toBeCloseTo(1, 6);
  });

  it('a pointed stake is the Shape verb\'s taper with a SharpPoint at the tip (1.4 m × r 0.05 m: 5.44 → 4.79 kg)', async () => {
    const w = await make();
    const id = spawnStick(w, { p: { x: 0, y: 1, z: 0 }, length: 1.4, r: 0.05, sharp: { end: 1, s: 0.6 } });
    const e = ent(w, id);
    expect(e.shape).toEqual(taperEnd(stickPrism(1.4, 0.05), 1, TOOL_TUNING.pointTaperRadii * 0.05));
    expect(e.shape.kind).toBe('hull');
    expect(e.sharpPoints).toEqual([{ local: { x: 0, y: 0.7, z: 0 }, dir: { x: 0, y: 1, z: 0 }, sharpness: 0.6 }]);
    // The tip is a corner of the hull: the point is geometry too (RF-18).
    expect(corners(e.shape).some((c) => dist(c, { x: 0, y: 0.7, z: 0 }) < 1e-9)).toBe(true);
    const blunt = 550 * ngonArea(0.05, 8) * 1.4;
    expect(blunt).toBeCloseTo(5.44, 2);
    console.info(`pointed stake: ${blunt.toFixed(3)} → ${e.mass.toFixed(3)} kg`);
    expect(blunt - e.mass).toBeCloseTo(0.65, 2);

    const down = ent(w, spawnStick(w, { p: { x: 2, y: 1, z: 0 }, length: 1.5, r: 0.025, sharp: { end: -1, s: 0.5 } }));
    expect(down.sharpPoints[0]).toEqual({ local: { x: 0, y: -0.75, z: 0 }, dir: { x: 0, y: -1, z: 0 }, sharpness: 0.5 });
  });

  it('caps a point at the material\'s maxSharpness and refuses a meaningless one', async () => {
    const w = await make();
    const rotten = ent(w, spawnStick(w, { p: { x: 0, y: 1, z: 0 }, length: 1, r: 0.03, material: 'rottenWood', sharp: { end: 1, s: 0.5 } }));
    expect(rotten.sharpPoints[0].sharpness).toBe(MATERIALS.rottenWood.maxSharpness);
    expect(() => spawnStick(w, { p: { x: 0, y: 1, z: 0 }, length: 1, r: 0.03, sharp: { end: 1, s: 0 } })).toThrow(/positive/);
    expect(() => spawnStick(w, { p: { x: 0, y: 1, z: 0 }, length: 1, r: 0.03, sharp: { end: 0 as 1, s: 0.3 } })).toThrow(/1 or -1/);
    expect(() => spawnStick(w, { p: { x: 0, y: 1, z: 0 }, length: -1, r: 0.03 })).toThrow(/positive/);
  });
});

describe('logs', () => {
  it('a 6-gon prism by radius: the deadfall\'s 5 m × r 0.075 m dry log is 40 kg (§11.2(a))', async () => {
    const w = await make();
    const e = ent(w, spawnLog(w, { p: { x: 0, y: 1, z: 0 }, length: 5, r: 0.075 }));
    expect(e.shape).toEqual({ kind: 'cylinder', halfHeight: 2.5, r: 0.075, sides: PHYSICS_TUNING.logFacets });
    expect(e.material).toBe('dryWood');
    expect(e.look).toBe('log');
    expect(e.state).toBe('free');
    expect(e.mass).toBeCloseTo(550 * ngonArea(0.075, 6) * 5, 9);
    expect(Math.abs(e.mass - 40)).toBeLessThan(0.5);
    expect(rotate(e.pose.q, { x: 0, y: 1, z: 0 }).x).toBeCloseTo(1, 6);
  });

  it('by mass: exactly that mass, the mass winning over a radius; one of the two is needed', async () => {
    const w = await make();
    const a = ent(w, spawnLog(w, { p: { x: 0, y: 1, z: 0 }, length: 4.4, mass: 300 }));
    expect(a.mass).toBeCloseTo(300, 9);
    expect(a.shape).toEqual(logPrism(4.4, prismRForMass(300, 4.4, 550, 6)));
    const b = ent(w, spawnLog(w, { p: { x: 0, y: 2, z: 3 }, length: 6, r: 0.17, mass: 170 }));
    expect(b.mass).toBeCloseTo(170, 9);
    const rotten = ent(w, spawnLog(w, { p: { x: 0, y: 1, z: 6 }, length: 2, mass: 40, material: 'rottenWood' }));
    expect(rotten.material).toBe('rottenWood');
    expect(rotten.mass).toBeCloseTo(40, 9);
    expect(() => spawnLog(w, { p: { x: 0, y: 1, z: 0 }, length: 2 })).toThrow(/radius r or a mass/);
    expect(() => spawnLog(w, { p: { x: 0, y: 1, z: 0 }, length: 2, mass: 0 })).toThrow(/positive/);
  });

  it('anchored and fixed logs', async () => {
    const w = await make();
    const a = ent(w, spawnLog(w, { p: { x: 0, y: 0.2, z: 0 }, length: 1.4, r: 0.05, state: 'anchored' }));
    expect(a.state).toBe('anchored');
    expect(a.anchor).toEqual({ depthM: VERB_TUNING.stakeAnchorDepthM, capacityN: 1200 });
    expect(a.body?.isFixed()).toBe(true);
    const f = ent(w, spawnLog(w, { p: { x: 2, y: 0.2, z: 0 }, length: 2, r: 0.1, state: 'fixed' }));
    expect(f.state).toBe('fixed');
    expect(f.anchor).toBeNull();
  });

  it('a snag: broken-branch points up and out at 45° on alternating sides, along its length (§6.7)', async () => {
    const w = await make();
    // Lying along world z this time (a quarter turn about y after the default lying rotation).
    const q = mulQuat(axisAngle({ x: 0, y: 1, z: 0 }, -Math.PI / 2), LYING_ALONG_X);
    const id = spawnLog(w, { p: { x: 0, y: 0.25, z: 0 }, q, length: 4, mass: 100, snags: 3 });
    const e = ent(w, id);
    expect(e.look).toBe('snag');
    expect(e.sharpPoints).toHaveLength(3);
    const axisW = rotate(e.pose.q, { x: 0, y: 1, z: 0 });
    expect(Math.abs(axisW.z)).toBeCloseTo(1, 5);
    const r = (e.shape as { r: number }).r;
    const sides: number[] = [];
    e.sharpPoints.forEach((sp, k) => {
      expect(sp.sharpness).toBe(CLEARING_TUNING.snagSharpness);
      const d = rotate(e.pose.q, sp.dir);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
      expect(d.y).toBeCloseTo(Math.sin(Math.PI / 4), 5); // up at 45°
      expect(dot(d, axisW)).toBeCloseTo(0, 5); // out, across the log
      sides.push(Math.sign(d.x));
      expect(sp.local.y).toBeCloseTo(4 * ((k + 1) / 4 - 0.5), 9);
      expect(Math.hypot(sp.local.x, sp.local.z)).toBeCloseTo(r, 9);
    });
    expect(sides).toEqual([sides[0], -sides[0], sides[0]]);
    // A rotten snag's points are only as sharp as rotten wood gets; no snags is a plain log.
    const rotten = ent(w, spawnLog(w, { p: { x: 3, y: 0.25, z: 0 }, length: 2, r: 0.12, material: 'rottenWood', snags: 2 }));
    expect(rotten.sharpPoints.map((s) => s.sharpness)).toEqual([0.1, 0.1]);
    expect(() => spawnLog(w, { p: { x: 0, y: 1, z: 0 }, length: 2, r: 0.1, snags: 1.5 })).toThrow(/whole number/);
  });
});

// ---------------------------------------------------------------------------
// Stones, boxes, grass
// ---------------------------------------------------------------------------

describe('stones and flint', () => {
  it('hulls of exactly their mass, compact, unrotated: throwing stones, weights, an 800 kg boulder, flint nodules', async () => {
    const w = await make();
    const cases: { mass: number; proto: 0 | 1 | 2 | 3; material?: MaterialId }[] = [
      { mass: 0.5, proto: 0 },
      { mass: 3, proto: 1 },
      { mass: 40, proto: 2 },
      { mass: 800, proto: 3 },
      { mass: 0.6, proto: 0, material: 'flint' },
      { mass: 1, proto: 2, material: 'flint' },
    ];
    let x = -10;
    for (const c of cases) {
      const id = spawnStone(w, { p: { x: (x += 3), y: 2, z: 0 }, ...c });
      const e = ent(w, id);
      const material = c.material ?? 'stone';
      expect(e.material).toBe(material);
      expect(e.look).toBe(material);
      expect(e.shape).toEqual(stoneHull(c.mass, c.proto, material));
      expect(e.mass).toBeCloseTo(c.mass, 9);
      expect(e.pose.q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
      expect(e.sharpPoints).toEqual([]); // flint: "no edge yet"
      const [ex, ey, ez] = extents((e.shape as Extract<Shape, { kind: 'hull' }>).points);
      expect(ex / Math.max(ey, ez)).toBeLessThan(TOOL_TUNING.compactMaxAspect);
    }
    expect(ent(w, spawnStone(w, { p: { x: 9, y: 2, z: 3 }, mass: 2 })).shape).toEqual(stoneHull(2, 0, 'stone'));
  });
});

describe('boxes and grass', () => {
  it('a box of full extents: free by default, fixed scaffolding when asked', async () => {
    const w = await make();
    const bait = ent(w, spawnBox(w, { p: { x: 0, y: 0.05, z: 0 }, size: [0.2, 0.1, 0.0455], material: 'hide', look: 'bait' }));
    expect(bait.shape).toEqual({ kind: 'box', hx: 0.1, hy: 0.05, hz: 0.02275 });
    expect(bait.state).toBe('free');
    expect(bait.look).toBe('bait');
    expect(bait.mass).toBeCloseTo(1100 * 0.2 * 0.1 * 0.0455, 9);
    const post = ent(w, spawnBox(w, { p: { x: 3, y: 3, z: 0 }, size: [0.4, 6, 0.4], material: 'dryWood', state: 'fixed', look: 'scaffold' }));
    expect(post.state).toBe('fixed');
    expect(post.body?.isFixed()).toBe(true);
    expect(() => spawnBox(w, { p: { x: 0, y: 0, z: 0 }, size: [1, 0, 1], material: 'stone', look: 'x' })).toThrow(/positive/);
  });

  it('a grass bundle: a flat box of leaves and dry grass of its mass', async () => {
    const w = await make();
    const e = ent(w, spawnGrass(w, { p: { x: 0, y: 0.04, z: 0 }, mass: 2 }));
    expect(e.material).toBe('leaves');
    expect(e.look).toBe('grass');
    expect(e.shape).toEqual(grassBox(2, 'leaves'));
    expect(e.mass).toBeCloseTo(2, 9);
    const sized = ent(w, spawnGrass(w, { p: { x: 2, y: 0.1, z: 0 }, mass: 3, size: [1.2, 0.1, 0.8] }));
    expect(sized.mass).toBeCloseTo(3, 9);
    expect(sized.shape).toEqual(grassBox(3, 'leaves', [1.2, 0.1, 0.8]));
  });
});

// ---------------------------------------------------------------------------
// The starter axe
// ---------------------------------------------------------------------------

describe('the starter axe', () => {
  it('a green handle and a 0.6 kg flint with a 0.9 edge across its end, lashed with 1 m of vine (§6.7)', async () => {
    const w = await make();
    const joints = standInJoints(w);
    const out = spawnStarterAxe(w, { x: 2.5, y: 0, z: 3 });
    expect(out.head).toBe(out.stick + 1);
    expect(out.joint).toBe(w.ids.joint.next - 1);
    const stick = ent(w, out.stick);
    const head = ent(w, out.head);

    // The handle: green wood, 0.55 m, an 8-gon with a round 4 cm stick's cross-section.
    expect(stick.material).toBe('greenWood');
    expect(stick.shape).toEqual(stickPrism(0.55, prismRForRoundDiam(0.04, PHYSICS_TUNING.cylinderFacets)));
    expect(stick.mass).toBeCloseTo(800 * Math.PI * 0.02 * 0.02 * 0.55, 9);
    expect(stick.look).toBe('stick');
    // The head: a 0.6 kg flint nodule.
    expect(head.material).toBe('flint');
    expect(head.look).toBe('flint');
    expect(head.mass).toBeCloseTo(0.6, 9);
    expect(head.shape).toEqual(stoneHull(0.6, FACTORY_TUNING.starterAxe.headProto, 'flint'));
    console.info(`starter axe: handle ${stick.mass.toFixed(4)} kg + head ${head.mass.toFixed(4)} kg = ${(stick.mass + head.mass).toFixed(4)} kg`);
    expect(stick.mass + head.mass).toBeCloseTo(1.153, 3); // the B lab's 1.15 kg axe (§5.2)

    // The edge, seen from the handle (§5.2's edge test): within headZoneM of the handle's end, pointing across it.
    expect(head.sharpPoints).toHaveLength(1);
    const edge = head.sharpPoints[0];
    expect(edge.sharpness).toBe(0.9);
    expect(edge.sharpness).toBeGreaterThanOrEqual(TOOL_TUNING.edgeMinSharpness);
    const tipW = toWorld(head.pose, edge.local);
    const dirW = rotate(head.pose.q, edge.dir);
    const tipH = toLocal(stick.pose, tipW);
    const dirH = rotate(conj(stick.pose.q), dirW);
    expect(0.275 - tipH.y).toBeLessThan(TOOL_TUNING.headZoneM);
    expect(tipH.y).toBeGreaterThan(0.275 - TOOL_TUNING.headZoneM);
    expect(Math.abs(dirH.y)).toBeLessThan(1e-6); // |dir·axis| < 0.5 with room to spare
    // The edge is a corner of the flint (the end of its long axis).
    expect(corners(head.shape).some((c) => dist(c, edge.local) < 1e-9)).toBe(true);
    expect(edge.dir).toEqual(principalAxis(head.shape).dir);

    // The lashing: one `lash` joint between the handle's end and the flint, made of 1 m of vine, tied.
    expect(joints.lashes).toHaveLength(1);
    const call = joints.lashes[0];
    expect(call.a.entity).toBe(out.stick);
    expect(call.b.entity).toBe(out.head);
    expect(call.credit).toEqual([]);
    const aW = toWorld(stick.pose, call.a.local);
    const bW = toWorld(head.pose, call.b.local);
    expect(dist(aW, bW)).toBeLessThan(1e-5);
    expect(dist(aW, toWorld(stick.pose, { x: 0, y: 0.275, z: 0 }))).toBeLessThan(1e-9);
    expect(call.rope.lengthM).toBe(VERB_TUNING.lashRopeUseM);
    expect(call.rope.entity).toBe(out.head + 1);
    const rope = ent(w, call.rope.entity);
    expect(rope.material).toBe('vine');
    expect(rope.rope).toEqual({ lengthM: VERB_TUNING.lashRopeUseM });
    expect(rope.state).toBe('tied');
    expect(rope.body).toBeNull();

    // Lying along x on the support at (2.5, 0, 3): the flint's long axis across the handle and level, its thin axis
    // vertical; both parts resting on the support, neither below it.
    expect(rotate(stick.pose.q, { x: 0, y: 1, z: 0 }).x).toBeCloseTo(1, 6);
    expect(stick.pose.p.x).toBeCloseTo(2.5, 6);
    expect(stick.pose.p.z).toBeCloseTo(3, 6);
    expect(Math.abs(rotate(head.pose.q, { x: 1, y: 0, z: 0 }).z)).toBeCloseTo(1, 6);
    expect(Math.abs(rotate(head.pose.q, { x: 0, y: 1, z: 0 }).y)).toBeCloseTo(1, 6);
    expect(lowestY(stick)).toBeCloseTo(0, 6);
    expect(lowestY(head)).toBeCloseTo(0, 6);
    // The flint sits across the handle's end, beyond it along the handle.
    const headInHandle = toLocal(stick.pose, head.pose.p);
    expect(headInHandle.y).toBeGreaterThan(0.275);
    expect(Math.abs(headInHandle.z)).toBeLessThan(1e-6);
  });

  it('generated, every part leaves the factory untouched', async () => {
    const w = await make();
    standInJoints(w, { tie: true });
    const out = spawnStarterAxe(w, { x: 0, y: 0, z: 0 }, { generated: true });
    for (const id of [out.stick, out.head, out.head + 1]) {
      expect(ent(w, id).generated).toBe(true);
      expect(ent(w, id).touched).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Every M1 kind in one scene
// ---------------------------------------------------------------------------

/** One of every kind generation and the test scenes make, each resting on the ground where it is put. */
function buildScene(w: World, generated: boolean): number[] {
  const g = { generated };
  const ids: number[] = [];
  const onGround = (x: number, z: number, s: Shape, q?: Quat): V3 => ({ x, y: groundRestY(w, x, z, s, q), z });
  const t = spawnTree(w, { at: { x: -8, z: -8 }, diameter: 0.4, height: 14, vine: { anchorH: 8, lengthM: 12, yaw: 0.5 }, ...g });
  ids.push(t.tree, t.vine!.rope);
  ids.push(spawnSapling(w, { at: { x: -4, z: -8 }, diameter: 0.06, height: 3, ...g }));
  ids.push(spawnRopeCoil(w, { at: { x: -8, y: 0, z: 0 }, material: 'vine', lengthM: 12, ...g }));
  ids.push(spawnStick(w, { p: onGround(-8, 3, stickPrism(2, 0.03), LYING_ALONG_X), length: 2, r: 0.03, ...g })); // a dry branch
  ids.push(spawnStick(w, { p: onGround(-8, 5, stickPrism(1.5, 0.025), LYING_ALONG_X), length: 1.5, r: 0.025, sharp: { end: 1, s: 0.5 }, ...g })); // a digging stick
  ids.push(spawnStick(w, { p: onGround(-8, 7, stickPrism(2.5, 0.025), LYING_ALONG_X), length: 2.5, r: 0.025, material: 'rottenWood', ...g }));
  const r120 = prismRForMass(120, 4, MATERIALS.dryWood.density, 6);
  ids.push(spawnLog(w, { p: onGround(0, -4, logPrism(4, r120), LYING_ALONG_X), length: 4, mass: 120, ...g }));
  const r100 = prismRForMass(100, 3.5, MATERIALS.dryWood.density, 6);
  ids.push(spawnLog(w, { p: onGround(0, 0, logPrism(3.5, r100), LYING_ALONG_X), length: 3.5, mass: 100, snags: 3, ...g }));
  const r40 = prismRForMass(40, 2, MATERIALS.rottenWood.density, 6);
  ids.push(spawnLog(w, { p: onGround(0, 4, logPrism(2, r40), LYING_ALONG_X), length: 2, mass: 40, material: 'rottenWood', ...g }));
  ids.push(spawnLog(w, { p: { x: 0, y: 0.4, z: 8 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1.4, r: 0.05, state: 'anchored', ...g })); // a stake
  ([[1, 0], [2, 1], [25, 2], [800, 3]] as const).forEach(([mass, proto], k) => {
    ids.push(spawnStone(w, { p: onGround(6, -6 + 4 * k, stoneHull(mass, proto, 'stone')), mass, proto, ...g }));
  });
  ids.push(spawnStone(w, { p: onGround(10, 0, stoneHull(0.6, 1, 'flint')), mass: 0.6, proto: 1, material: 'flint', ...g }));
  ids.push(spawnBox(w, { p: { x: 10, y: 1, z: 6 }, size: [0.4, 2, 0.4], material: 'dryWood', state: 'fixed', look: 'scaffold', ...g }));
  ids.push(spawnGrass(w, { p: onGround(10, -6, grassBox(2, 'leaves')), mass: 2, ...g }));
  const axe = spawnStarterAxe(w, { x: 2.5, y: 0, z: 3 }, g);
  ids.push(axe.stick, axe.head, axe.head + 1);
  return ids;
}

describe('every M1 entity kind', () => {
  it('spawns in id order, one spawn event each, and rests where it is put on the ground', async () => {
    const w = await make();
    standInJoints(w);
    const ids = buildScene(w, false);
    expect(ids).toEqual(ids.map((_, i) => i + 1));
    expect(w.events.filter((e) => e.type === 'spawn').map((e) => (e as { entity: number }).entity)).toEqual(ids);
    expect(w.entities.all().map((e) => e.id)).toEqual(ids);

    const start = new Map(w.entities.all().map((e) => [e.id, { p: { ...e.pose.p }, low: e.body ? lowestY(e) : 0 }]));
    for (const e of w.entities.all()) {
      if (!e.body || e.state !== 'free') continue;
      // Every free thing starts on the ground, nothing below it.
      expect(start.get(e.id)!.low, `${e.look} ${e.id}`).toBeCloseTo(0, 5);
    }
    for (let t = 0; t < 180; t++) w.step();
    for (const e of w.entities.all()) {
      const finite = [e.pose.p.x, e.pose.p.y, e.pose.p.z, e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w].every(Number.isFinite);
      expect(finite, `${e.look} ${e.id}`).toBe(true);
      if (!e.body) continue;
      const moved = dist(e.pose.p, start.get(e.id)!.p);
      console.info(`${e.look} ${e.id}: moved ${(moved * 1000).toFixed(2)} mm in 3 s, rest ticks ${e.restTicks}`);
      expect(moved, `${e.look} ${e.id} moved`).toBeLessThan(0.01);
      expect(e.restTicks, `${e.look} ${e.id} at rest`).toBeGreaterThan(0);
    }
  });

  it('builds bit-identically twice', async () => {
    const records: string[] = [];
    for (let run = 0; run < 2; run++) {
      const w = await make();
      standInJoints(w);
      buildScene(w, false);
      const atSpawn = JSON.stringify(w.entities.toRecord());
      for (let t = 0; t < 120; t++) w.step();
      records.push(atSpawn + JSON.stringify(w.entities.toRecord()));
    }
    expect(records[1]).toBe(records[0]);
  });

  it('generated, saves nothing until something is touched', async () => {
    const w = await make();
    standInJoints(w, { tie: true });
    const ids = buildScene(w, true);
    for (const id of ids) expect(ent(w, id).generated).toBe(true);
    expect(w.entities.toRecord()).toEqual([]);
    // At rest where generated, everything stays untouched.
    for (let t = 0; t < 120; t++) w.step();
    expect(w.entities.toRecord()).toEqual([]);
  });

  it('groundRestY rests a shape on sloping terrain: no point of it below the ground under it, one on it', async () => {
    const w = await make();
    w.terrain.generate((x, z) => 0.3 * x - 0.2 * z);
    const shapes: [Shape, Quat | undefined][] = [
      [logPrism(4, 0.2), LYING_ALONG_X],
      [stoneHull(30, 2, 'stone'), undefined],
      [grassBox(2, 'leaves'), undefined],
      [ropeCoilShape(16), undefined],
    ];
    for (const [s, q] of shapes) {
      const y = groundRestY(w, 3, -2, s, q);
      const pose: Pose3 = { p: { x: 3, y, z: -2 }, q: q ?? { x: 0, y: 0, z: 0, w: 1 } };
      // Corners in float64, and the whole surface sampled every 2 cm (float32 triangles: 1e-5 m).
      const cornerGaps = corners(s).map((c) => {
        const p = toWorld(pose, c);
        return p.y - w.terrain.heightAt(p.x, p.z);
      });
      expect(Math.min(...cornerGaps), s.kind).toBeCloseTo(0, 6);
      expect(minSurfaceGap(w, s, pose, 0.02), s.kind).toBeGreaterThan(-1e-5);
    }
  });

  it('groundRestY rests a long flat underside on a bump between its ends, and what is put there stays put', async () => {
    const w = await make();
    // Two domes, tops at (−5, 0) and (5, 0): a 4 m log's ends sit 0.2 m below the top under its middle, and the top is
    // under the middle of a 2 × 1.5 m box's bottom face, away from every edge.
    const dome = (x: number, z: number, cx: number): number => -0.05 * ((x - cx) * (x - cx) + z * z);
    w.terrain.generate((x, z) => Math.max(dome(x, z, -5), dome(x, z, 5)));
    const log = logPrism(4, 0.2);
    const box: Shape = { kind: 'box', hx: 1, hy: 0.05, hz: 0.75 };
    const yLog = groundRestY(w, -5, 0, log, LYING_ALONG_X);
    const yBox = groundRestY(w, 5, 0, box);
    console.info(`on the domes: log at ${yLog.toFixed(4)} m (its apothem ${(0.2 * Math.cos(Math.PI / 6)).toFixed(4)}), box at ${yBox.toFixed(4)} m`);
    expect(yLog).toBeCloseTo(0.2 * Math.cos(Math.PI / 6), 3);
    expect(yBox).toBeCloseTo(0.05, 3);
    const logPose: Pose3 = { p: { x: -5, y: yLog, z: 0 }, q: LYING_ALONG_X };
    const boxPose: Pose3 = { p: { x: 5, y: yBox, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } };
    for (const [s, pose] of [[log, logPose], [box, boxPose]] as const) {
      const gap = minSurfaceGap(w, s, pose, 0.01);
      expect(gap, s.kind).toBeGreaterThan(-2e-3);
      expect(gap, s.kind).toBeLessThan(2e-3);
    }
    // Generated there, neither pops up nor settles: both still untouched (nothing to save) a second later.
    spawnLog(w, { p: logPose.p, length: 4, r: 0.2, generated: true });
    spawnBox(w, { p: boxPose.p, size: [2, 0.1, 1.5], material: 'dryWood', look: 'plank', generated: true });
    for (let t = 0; t < 60; t++) w.step();
    expect(w.entities.toRecord()).toEqual([]);
  });
});

/** The smallest height of a posed shape's surface above the terrain under it, sampled every `step` m on every triangle. */
function minSurfaceGap(w: World, s: Shape, pose: Pose3, step: number): number {
  const { positions: P, indices } = triangulate(s, pose);
  let gap = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = Math.max(1, Math.ceil(Math.max(Math.hypot(...u), Math.hypot(...v), Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2])) / step));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const x = P[a] + (i / n) * u[0] + (j / n) * v[0];
        const y = P[a + 1] + (i / n) * u[1] + (j / n) * v[1];
        const z = P[a + 2] + (i / n) * u[2] + (j / n) * v[2];
        gap = Math.min(gap, y - w.terrain.heightAt(x, z));
      }
    }
  }
  return gap;
}
