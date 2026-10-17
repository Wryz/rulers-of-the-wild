import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import * as sim from '../src/index';
import { Rng } from '../src/sim/math';
import { MATERIALS } from '../src/world/materials';
import {
  colliderDesc,
  shapeContains,
  crossCut,
  cylinderPoints,
  fracture,
  principalAxis,
  type ShapePiece,
  shapeMass,
  shapeVolume,
  taperEnd,
  triangulate,
} from '../src/world/shapes';
import type { Pose3, Shape, V3 } from '../src/world/types';

// docs/M1-DESIGN.md §2.2: volumes, mass = density × volume, collider descriptors, nav triangulation, fracture,
// cross-cut and the Shape verb's taper.

const IDENTITY: Pose3 = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } };
const flat = (pts: number[][]) => pts.flat();

/** A 1.4 m × 5 cm stake: an 8-gon prism of circumradius 5 cm (§5.4). */
const STAKE: Shape = { kind: 'cylinder', halfHeight: 0.7, r: 0.05, sides: 8 };
/** A 4 m hex log, 15 cm circumradius (PHYSICS_TUNING.logFacets 6). */
const LOG: Shape = { kind: 'cylinder', halfHeight: 2, r: 0.15, sides: 6 };
/** A lumpy stone hull, deliberately off-centre. */
const STONE: Shape = {
  kind: 'hull',
  points: flat([
    [0.31, 0.12, 0.05],
    [-0.22, 0.15, 0.1],
    [0.05, 0.28, -0.12],
    [-0.1, -0.05, 0.27],
    [0.18, -0.1, -0.22],
    [-0.27, -0.08, -0.15],
    [0.02, -0.14, 0.03],
    [0.12, 0.2, 0.2],
    [-0.05, 0.02, -0.3],
  ]),
};
const KINDS: Shape[] = [
  { kind: 'ball', r: 0.2 },
  { kind: 'box', hx: 0.3, hy: 0.1, hz: 0.6 },
  { kind: 'capsule', halfHeight: 0.5, r: 0.12 },
  STAKE,
  LOG,
  STONE,
];

/** The volume a closed outward-wound triangle mesh encloses (divergence theorem). */
function meshVolume(m: { positions: Float32Array; indices: Uint32Array }): number {
  let v = 0;
  const p = (i: number): [number, number, number] => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [p(m.indices[t]), p(m.indices[t + 1]), p(m.indices[t + 2])];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

const pieceVolume = (ps: readonly ShapePiece[]) => ps.reduce((s, p) => s + shapeVolume(p.shape), 0);

/** Every point of a piece, moved into the parent's frame. */
function piecePoints(p: ShapePiece): V3[] {
  const s = p.shape;
  const local =
    s.kind === 'hull'
      ? s.points
      : s.kind === 'cylinder'
        ? cylinderPoints(s)
        : s.kind === 'box'
          ? flat([-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x * s.hx, y * s.hy, z * s.hz]))))
          : [];
  const out: V3[] = [];
  for (let i = 0; i < local.length; i += 3) out.push({ x: local[i] + p.offset.x, y: local[i + 1] + p.offset.y, z: local[i + 2] + p.offset.z });
  return out;
}

describe('shapeVolume', () => {
  it('is exact for every kind', () => {
    expect(shapeVolume({ kind: 'ball', r: 0.2 })).toBeCloseTo((4 / 3) * Math.PI * 0.008, 15);
    expect(shapeVolume({ kind: 'box', hx: 0.3, hy: 0.1, hz: 0.6 })).toBeCloseTo(0.6 * 0.2 * 1.2, 15);
    expect(shapeVolume({ kind: 'capsule', halfHeight: 0.5, r: 0.12 })).toBeCloseTo(Math.PI * 0.0144 * 1 + (4 / 3) * Math.PI * 0.12 ** 3, 15);
    const cube = flat([0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z]))));
    expect(shapeVolume({ kind: 'hull', points: cube })).toBeCloseTo(1, 12);
    // Interior, duplicate, edge and face points change nothing.
    const busy = [...cube, 0.5, 0.5, 0.5, 1, 1, 1, 0.5, 0, 0, 0.5, 0.5, 1, 0.2, 0.7, 0.1];
    expect(shapeVolume({ kind: 'hull', points: busy })).toBeCloseTo(1, 12);
    expect(shapeVolume({ kind: 'hull', points: flat([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]) })).toBeCloseTo(1 / 6, 14);
    // Fewer than four points, or all in a plane, hold no volume.
    expect(shapeVolume({ kind: 'hull', points: flat([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]]) })).toBe(0);
    expect(shapeVolume({ kind: 'hull', points: [] })).toBe(0);
  });

  it('gives a prism (N/2)·r²·sin(2π/N)·2·halfHeight, the volume of its own mesh, tending to the cylinder', () => {
    const prism = (n: number): Shape => ({ kind: 'cylinder', halfHeight: 0.7, r: 0.05, sides: n });
    for (const n of [3, 6, 8, 12]) {
      const expected = (n / 2) * 0.05 ** 2 * Math.sin((2 * Math.PI) / n) * 1.4;
      expect(shapeVolume(prism(n)), `${n}-gon`).toBeCloseTo(expected, 15);
      expect(meshVolume(triangulate(prism(n), IDENTITY)) / expected, `${n}-gon mesh`).toBeCloseTo(1, 6);
      expect(shapeVolume({ kind: 'hull', points: cylinderPoints(prism(n) as Extract<Shape, { kind: 'cylinder' }>) }) / expected).toBeCloseTo(1, 12);
    }
    expect(shapeVolume(STAKE)).toBeCloseTo(4 * 0.0025 * Math.SQRT1_2 * 1.4, 15); // 9.9 L
    expect(shapeVolume(prism(512)) / (Math.PI * 0.0025 * 1.4)).toBeCloseTo(1, 4);
  });

  it('makes mass = density × volume per shape kind (SPEC:196)', () => {
    expect(shapeMass(STAKE, MATERIALS.dryWood)).toBeCloseTo(550 * shapeVolume(STAKE), 12);
    expect(shapeMass(STAKE, MATERIALS.dryWood)).toBeCloseTo(5.4447, 4);
    expect(shapeMass({ kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 }, MATERIALS.greenWood)).toBeCloseTo(800, 9); // MAP rapier §8
  });
});

describe('colliderDesc', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('gives Rapier bodies the mass density × volume, the material friction and the Average combine rule', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    for (const s of [...KINDS, taperEnd(STAKE, 1, 0.25), ...fracture(LOG, 3, new Rng(7)).map((p) => p.shape)]) {
      for (const id of ['dryWood', 'stone', 'leaves'] as const) {
        const m = MATERIALS[id];
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
        const c = world.createCollider(colliderDesc(s, m), body);
        expect(body.mass() / shapeMass(s, m), `${s.kind} ${id}`).toBeCloseTo(1, 5);
        expect(c.friction()).toBeCloseTo(m.friction, 6);
        expect(c.frictionCombineRule()).toBe(RAPIER.CoefficientCombineRule.Average);
      }
    }
    // A cylinder is the convex hull of its prism, not Rapier's round cylinder (§2.2: prisms rest, round logs roll).
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
    const c = world.createCollider(colliderDesc(LOG, MATERIALS.dryWood), body);
    expect(c.shape.type).toBe(RAPIER.ShapeType.ConvexPolyhedron);
    world.free();
  });
});

describe('principalAxis and shapeContains', () => {
  it('find the long axis: +Y for prisms and capsules, the largest extent for boxes and hulls', () => {
    expect(principalAxis(STAKE)).toEqual({ axis: 'y', dir: { x: 0, y: 1, z: 0 }, min: -0.7, max: 0.7, crossHalf: 0.05 });
    expect(principalAxis({ kind: 'capsule', halfHeight: 0.5, r: 0.12 })).toMatchObject({ axis: 'y', min: -0.62, max: 0.62 });
    expect(principalAxis({ kind: 'box', hx: 0.3, hy: 0.1, hz: 0.6 })).toMatchObject({ axis: 'z', min: -0.6, max: 0.6, crossHalf: 0.3 });
    expect(principalAxis({ kind: 'box', hx: 0.5, hy: 0.5, hz: 0.2 }).axis).toBe('y'); // ties prefer Y
    expect(principalAxis(taperEnd(STAKE, 1, 0.25))).toMatchObject({ axis: 'y', min: -0.7, max: 0.7 });
  });

  it('tell inside from outside for every kind', () => {
    const out = { x: 0, y: 0.75, z: 0 };
    for (const s of KINDS) {
      expect(shapeContains(s, { x: 0, y: 0, z: 0 }) || s === STONE, s.kind).toBe(true);
      expect(shapeContains(s, { x: 0.7, y: 0.7, z: 0.7 }), s.kind).toBe(false);
    }
    expect(shapeContains(STONE, { x: 0.02, y: 0.05, z: 0 })).toBe(true);
    expect(shapeContains(STAKE, out)).toBe(false);
    expect(shapeContains(STAKE, out, 0.06)).toBe(true);
    expect(shapeContains(STAKE, { x: 0.0461, y: 0, z: 0 })).toBe(true); // the 8-gon's inradius is 4.62 cm
    expect(shapeContains(STAKE, { x: 0.047, y: 0, z: 0 })).toBe(false); // a flat face toward +X (C labs' prism)
    const toward = (deg: number, r: number) => ({ x: r * Math.cos((deg * Math.PI) / 180), y: 0, z: r * Math.sin((deg * Math.PI) / 180) });
    expect(shapeContains(STAKE, toward(22.5, 0.049))).toBe(true); // a vertex at 22.5° (r 5 cm)
    expect(shapeContains(STAKE, toward(45, 0.049))).toBe(false); // a face at 45°
  });
});

describe('triangulate', () => {
  it('gives a closed outward mesh of the shape, posed in the world', () => {
    for (const s of KINDS) {
      const m = triangulate(s, IDENTITY);
      expect(m.indices.length % 3).toBe(0);
      expect(meshVolume(m) / shapeVolume(s), s.kind).toBeCloseTo(1, 6);
      for (const i of m.indices) expect(i).toBeLessThan(m.positions.length / 3);
    }
    // A box turned a quarter turn about Z and lifted: x and y extents swap, the volume stays.
    const half = Math.SQRT1_2;
    const box: Shape = { kind: 'box', hx: 0.3, hy: 0.1, hz: 0.6 };
    const m = triangulate(box, { p: { x: 10, y: 2, z: -5 }, q: { x: 0, y: 0, z: half, w: half } });
    const xs = [...m.positions].filter((_, i) => i % 3 === 0);
    const ys = [...m.positions].filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBeCloseTo(9.9, 5);
    expect(Math.max(...xs)).toBeCloseTo(10.1, 5);
    expect(Math.min(...ys)).toBeCloseTo(1.7, 5);
    expect(Math.max(...ys)).toBeCloseTo(2.3, 5);
    expect(meshVolume(m) / shapeVolume(box)).toBeCloseTo(1, 5);
  });

  it('winds an upward face so recast reads it as walkable: (v1 − v0) × (v2 − v0) has a positive y', () => {
    const m = triangulate({ kind: 'box', hx: 1, hy: 0.2, hz: 1 }, IDENTITY);
    let up = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const p = (k: number) => [0, 1, 2].map((j) => m.positions[m.indices[t + k] * 3 + j]);
      const [a, b, c] = [p(0), p(1), p(2)];
      if (a[1] > 0.19 && b[1] > 0.19 && c[1] > 0.19) {
        const e1 = [b[0] - a[0], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[2] - a[2]];
        expect(e1[1] * e2[0] - e1[0] * e2[1]).toBeGreaterThan(0); // the y of the cross product
        up++;
      }
    }
    expect(up).toBe(2);
  });
});

describe('fracture', () => {
  it('conserves volume within 1 % for every kind and 2-4 pieces, every piece inside its parent', () => {
    for (const s of KINDS) {
      for (const n of [2, 3, 4] as const) {
        const pieces = fracture(s, n, new Rng(1234 + n));
        expect(pieces, `${s.kind} ×${n}`).toHaveLength(n);
        expect(pieceVolume(pieces) / shapeVolume(s), `${s.kind} ×${n}`).toBeCloseTo(1, 2);
        for (const p of pieces) {
          expect(shapeVolume(p.shape), `${s.kind} ×${n}`).toBeGreaterThan(0);
          if (s.kind !== 'ball' && s.kind !== 'capsule') {
            for (const q of piecePoints(p)) expect(shapeContains(s, q, 1e-9), `${s.kind} ×${n}`).toBe(true);
          }
        }
      }
    }
  });

  it('splits a prism along its long axis into full-length splinters, centred on their centre of mass', () => {
    const pieces = fracture(LOG, 4, new Rng(99));
    for (const p of pieces) {
      expect(p.shape.kind).toBe('hull');
      const ax = principalAxis(p.shape);
      expect(ax.axis).toBe('y');
      expect(ax.max - ax.min).toBeCloseTo(4, 9);
      // Centred: re-cutting the piece's own volume about its origin is balanced.
      const [lo, hi] = crossCut(p.shape, 0);
      expect(shapeVolume(lo.shape)).toBeCloseTo(shapeVolume(hi.shape), 9);
    }
    expect(pieceVolume(pieces) / shapeVolume(LOG)).toBeCloseTo(1, 9);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    for (const s of [LOG, STONE]) {
      expect(fracture(s, 3, new Rng(5))).toEqual(fracture(s, 3, new Rng(5)));
      expect(fracture(s, 3, new Rng(5))).not.toEqual(fracture(s, 3, new Rng(6)));
    }
    const a = new Rng(42);
    fracture(LOG, 2, a);
    const b = new Rng(42);
    b.next();
    expect(a.next()).toBe(b.next()); // one draw for an elongated kind
    const c = new Rng(42);
    fracture(STONE, 2, c);
    const d = new Rng(42);
    d.next();
    d.next();
    d.next();
    expect(c.next()).toBe(d.next()); // three for a hull (its axis, then the angle)
  });
});

describe('crossCut', () => {
  it('conserves volume within 1 % for every kind, the lower part first', () => {
    for (const s of KINDS) {
      const ax = principalAxis(s);
      for (const f of [0.1, 0.5, 0.83]) {
        const t = ax.min + f * (ax.max - ax.min);
        const [lo, hi] = crossCut(s, t);
        expect(pieceVolume([lo, hi]) / shapeVolume(s), `${s.kind} at ${f}`).toBeCloseTo(1, 2);
        const along = (p: ShapePiece) => p.offset.x * ax.dir.x + p.offset.y * ax.dir.y + p.offset.z * ax.dir.z;
        expect(along(lo), s.kind).toBeLessThan(t);
        expect(along(hi), s.kind).toBeGreaterThan(t);
      }
    }
  });

  it('cuts a prism into two prisms, a box into two boxes, exactly', () => {
    const [lo, hi] = crossCut(LOG, 0.5);
    expect(lo).toEqual({ shape: { kind: 'cylinder', halfHeight: 1.25, r: 0.15, sides: 6 }, offset: { x: 0, y: -0.75, z: 0 } });
    expect(hi).toEqual({ shape: { kind: 'cylinder', halfHeight: 0.75, r: 0.15, sides: 6 }, offset: { x: 0, y: 1.25, z: 0 } });
    const [a, b] = crossCut({ kind: 'box', hx: 0.3, hy: 0.1, hz: 0.6 }, -0.2);
    const near = (v: number) => expect.closeTo(v, 12);
    expect(a).toEqual({ shape: { kind: 'box', hx: 0.3, hy: 0.1, hz: near(0.2) }, offset: { x: 0, y: 0, z: near(-0.4) } });
    expect(b).toEqual({ shape: { kind: 'box', hx: 0.3, hy: 0.1, hz: near(0.4) }, offset: { x: 0, y: 0, z: near(0.2) } });
    // Clamped inside the shape: a cut past the end still gives two pieces of the whole volume.
    const [c, d] = crossCut(LOG, 9);
    expect(pieceVolume([c, d]) / shapeVolume(LOG)).toBeCloseTo(1, 9);
  });

  it('snaps a pointed stake across its axis, the point staying with the upper piece', () => {
    const pointed = taperEnd(STAKE, 1, 0.25);
    const [lo, hi] = crossCut(pointed, 0.3);
    expect(pieceVolume([lo, hi]) / shapeVolume(pointed)).toBeCloseTo(1, 9);
    const tip = { x: 0 - hi.offset.x, y: 0.7 - hi.offset.y, z: 0 - hi.offset.z };
    expect(shapeContains(hi.shape, tip, 1e-9)).toBe(true);
    expect(shapeContains(lo.shape, { x: 0 - lo.offset.x, y: 0.7 - lo.offset.y, z: 0 - lo.offset.z }, 1e-9)).toBe(false);
  });
});

describe('taperEnd', () => {
  it('turns a 1.4 m × 5 cm stake’s end into a point on the axis, removing 0.65 kg (12 %) of dry wood', () => {
    const pointed = taperEnd(STAKE, 1, 0.25);
    expect(pointed.kind).toBe('hull');
    const before = shapeMass(STAKE, MATERIALS.dryWood);
    const after = shapeMass(pointed, MATERIALS.dryWood);
    expect(before - after).toBeCloseTo(0.65, 2);
    expect((before - after) / before).toBeCloseTo(0.12, 2);
    // Exactly ⅔ of the tapered length's prism is gone (a pyramid keeps ⅓).
    const area = 4 * 0.05 ** 2 * Math.SQRT1_2;
    expect(shapeVolume(STAKE) - shapeVolume(pointed)).toBeCloseTo((2 / 3) * area * 0.25, 12);
    const pts = (pointed as Extract<Shape, { kind: 'hull' }>).points;
    const ys = pts.filter((_, i) => i % 3 === 1);
    const top = ys.indexOf(Math.max(...ys));
    expect([pts[top * 3], pts[top * 3 + 1], pts[top * 3 + 2]]).toEqual([0, 0.7, 0]); // the tip, on the axis
    expect(ys.filter((y) => y > 0.45 + 1e-9)).toHaveLength(1);
    expect(ys.filter((y) => Math.abs(y + 0.7) < 1e-12)).toHaveLength(8); // the other end untouched
    expect(ys.filter((y) => Math.abs(y - 0.45) < 1e-12)).toHaveLength(8); // the ring where the taper starts
  });

  it('tapers either end, keeps the frame, and sharpens the second end of a pointed stake', () => {
    const down = taperEnd(STAKE, -1, 0.25);
    expect(shapeVolume(down)).toBeCloseTo(shapeVolume(taperEnd(STAKE, 1, 0.25)), 12);
    expect(shapeContains(down, { x: 0, y: -0.7, z: 0 }, 1e-9)).toBe(true);
    expect(shapeContains(down, { x: 0.03, y: -0.69, z: 0 })).toBe(false);
    const both = taperEnd(taperEnd(STAKE, 1, 0.25), -1, 0.25);
    expect(shapeVolume(STAKE) - shapeVolume(both)).toBeCloseTo(2 * (2 / 3) * 4 * 0.05 ** 2 * Math.SQRT1_2 * 0.25, 12);
    expect(shapeContains(both, { x: 0, y: 0.7, z: 0 }, 1e-9)).toBe(true);
    expect(shapeContains(both, { x: 0, y: -0.7, z: 0 }, 1e-9)).toBe(true);
    // A taper longer than the stake makes it one long pyramid; a zero taper changes nothing.
    expect(shapeVolume(taperEnd(STAKE, 1, 5))).toBeCloseTo(shapeVolume(STAKE) / 3, 12);
    expect(taperEnd(STAKE, 1, 0)).toBe(STAKE);
  });
});

describe('convex hulls of arbitrary point clouds', () => {
  it('enclose every point, match their own mesh, and split without losing volume', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = new Rng(seed);
      const n = 5 + Math.floor(rng.next() * 40);
      const pts: number[] = [];
      for (let i = 0; i < n * 3; i++) pts.push(rng.range(-0.4, 0.4) * (i % 3 === 1 ? 2.5 : 1));
      const s: Shape = { kind: 'hull', points: pts };
      const v = shapeVolume(s);
      expect(v, `seed ${seed}`).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        expect(shapeContains(s, { x: pts[i * 3], y: pts[i * 3 + 1], z: pts[i * 3 + 2] }, 1e-9), `seed ${seed} point ${i}`).toBe(true);
      }
      expect(meshVolume(triangulate(s, IDENTITY)) / v, `seed ${seed}`).toBeCloseTo(1, 6); // f32 positions
      expect(pieceVolume(fracture(s, (2 + (seed % 3)) as 2 | 3 | 4, rng)) / v, `seed ${seed}`).toBeCloseTo(1, 9);
      const ax = principalAxis(s);
      expect(pieceVolume(crossCut(s, ax.min + 0.37 * (ax.max - ax.min))) / v, `seed ${seed}`).toBeCloseTo(1, 9);
      for (const end of [1, -1] as const) {
        // Sharpening only removes material: every corner of the tapered hull lies in the original.
        const t = taperEnd(s, end, 0.2) as Extract<Shape, { kind: 'hull' }>;
        expect(shapeVolume(t), `seed ${seed}`).toBeLessThan(v);
        for (let i = 0; i < t.points.length; i += 3) {
          expect(shapeContains(s, { x: t.points[i], y: t.points[i + 1], z: t.points[i + 2] }, 1e-9), `seed ${seed}`).toBe(true);
        }
      }
    }
  });
});

describe('index', () => {
  it('exports the shape functions', () => {
    expect(sim.shapeVolume).toBe(shapeVolume);
    expect(sim.colliderDesc).toBe(colliderDesc);
    expect(sim.triangulate).toBe(triangulate);
    expect(sim.fracture).toBe(fracture);
    expect(sim.crossCut).toBe(crossCut);
    expect(sim.taperEnd).toBe(taperEnd);
  });
});
