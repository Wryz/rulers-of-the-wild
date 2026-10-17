// The Clearing on screen (docs/M1-DESIGN.md §10.4, package P32): the terrain is exactly the sim's heights at the near
// level of detail, the trees are instanced (60 trunks), a tree that leaves `standing` gets its own mesh with its notch
// (1 − remaining deep) and, falling or felled, a crown inside the trunk radius + fallenCrownPadM; cross-cut notches,
// sharp points, cracks, sags and bends show on entities; one rope view per joint, thinning and fraying with strain;
// grass follows the cover; the sun's shadow is snapped to texels; held and stowed things ride the drawn body; the apes
// and the giant look like themselves and a ruler's wounds show where they are; gore off draws no blood; and the draw
// calls of a Clearing-sized scene are logged against §10.4's budget. Rule 3 throughout: every state a rule reads is
// drawn.
//
// Real worlds (Rapier in Node) built from P07's factories stand in for the Clearing (P21) and for the felling, cutting
// and holding P10, P14 and P15 will do: where a test needs such a state it sets the entity's or fighter's fields the
// way the design says those packages will (§2.3-§2.5, §2.12). Scene numbers are test constants, never tuning.
import { type BufferGeometry, Color, Matrix4, Mesh, type MeshStandardMaterial, Quaternion, Scene, Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createPlayer,
  createWorld,
  cylinderPoints,
  DAMAGE_TUNING,
  type Entity,
  FELL_TUNING,
  type Fighter,
  type JointRecord,
  physicsReady,
  type RopeView,
  type RulerState,
  spawnGrass,
  spawnLog,
  spawnRopeCoil,
  spawnSapling,
  spawnStick,
  spawnStone,
  spawnTree,
  Terrain,
  trunkPrism,
  type World,
  type WorldOptions,
  type WoundRecord,
} from '@wild/sim';
import type { BodyPose, ViewFrame } from '../src/game/ports';
import { entityColour, EntityViews, notchDepthAt, protoOf, unitPrism } from '../src/render/entityViews';
import { FighterView } from '../src/render/fighterView';
import { crownRadius } from '../src/render/forestView';
import { GrassView, tuftsFor } from '../src/render/grassView';
import { APE_PALETTE, GIANT_APE_PALETTE, lookForSpecies } from '../src/render/looks';
import { ropePoints, RopeViews } from '../src/render/ropeView';
import { shadowTexelM, Sky, snapToTexels, sunDirection } from '../src/render/sky';
import { RENDER_TUNING, surfaceVertexCount, TerrainView, tileGeometry, tileSpacing } from '../src/render/terrainView';
import { drawCallCount, FighterViewAdapter, scarKindOf, WorldViews } from '../src/render/worldViews';

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
});

function frame(over: Partial<ViewFrame> = {}): ViewFrame {
  return { realDt: 1 / 60, gameDt: 1 / 60, poseOf: () => null, gore: 'full', cues: false, ...over };
}

const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

/** A bumpy terrain with no physics (heights only). */
function bumpy(size = 50): Terrain {
  const t = new Terrain(null, size);
  t.generate((x, z) => 3 * Math.sin(x / 7) + 2 * Math.cos(z / 5) + 0.3 * Math.sin(1.3 * x + z));
  return t;
}

const NO_COVER = { at: () => 0 };

/** The geometry's vertex `i`, through `m`. */
function vertex(g: BufferGeometry, i: number, m?: Matrix4): Vector3 {
  const p = g.getAttribute('position');
  const v = new Vector3(p.getX(i), p.getY(i), p.getZ(i));
  return m ? v.applyMatrix4(m) : v;
}

/** The reference colour nearest `c`, by name. */
function nearest(c: Color, refs: Record<string, string>): string {
  let best = '';
  let d = Infinity;
  for (const [k, hex] of Object.entries(refs)) {
    const r = new Color(hex);
    const dd = (r.r - c.r) ** 2 + (r.g - c.g) ** 2 + (r.b - c.b) ** 2;
    if (dd < d) {
      d = dd;
      best = k;
    }
  }
  return best;
}

const luminance = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

describe('terrain', () => {
  it('draws every vertex exactly at the sim height (within 1e-5 m) at every level of detail', () => {
    const t = bumpy();
    for (const spacing of [RENDER_TUNING.nearSpacing, RENDER_TUNING.farSpacing, RENDER_TUNING.terrain.distantSpacing]) {
      for (let tile = 0; tile < t.tileCount; tile++) {
        const g = tileGeometry(t, tile, spacing);
        const n = surfaceVertexCount(g);
        expect(n).toBeGreaterThan(4);
        let worst = 0;
        for (let i = 0; i < n; i++) {
          const v = vertex(g, i);
          worst = Math.max(worst, Math.abs(v.y - t.heightAt(v.x, v.z)));
        }
        expect(worst, `tile ${tile} at ${spacing} m`).toBeLessThanOrEqual(1e-5);
        g.dispose();
      }
    }
  });

  it('splits the near tiles into triangles as the sim does: any point inside one is at heightAt', () => {
    const t = bumpy();
    const g = tileGeometry(t, 0, RENDER_TUNING.nearSpacing);
    const index = g.getIndex()!;
    const n = surfaceVertexCount(g);
    let checked = 0;
    let worst = 0;
    for (let k = 0; k < index.count; k += 3 * 97) {
      const [a, b, c] = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
      if (a >= n || b >= n || c >= n) continue; // a skirt
      const A = vertex(g, a);
      const B = vertex(g, b);
      const C = vertex(g, c);
      for (const [u, v] of [
        [0.2, 0.3],
        [0.6, 0.1],
        [0.33, 0.33],
      ]) {
        const p = A.clone().multiplyScalar(1 - u - v).addScaledVector(B, u).addScaledVector(C, v);
        worst = Math.max(worst, Math.abs(p.y - t.heightAt(p.x, p.z)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(1e-5);
  });

  it('colours the ground by what it is: grass, pale dense dry grass, dug dirt, steep rock', () => {
    const T = RENDER_TUNING.terrain;
    const t = new Terrain(null, 50);
    // Flat on x < 10; a 50° wall beyond x = 15.
    t.generate((x) => (x > 15 ? (x - 15) * Math.tan((50 * Math.PI) / 180) : 0));
    t.lower(-10, -10, 4);
    const cover = { at: (x: number, _z: number) => (x > 0 && x < 10 ? 0.9 : 0.2) };
    const tiles = [0, 1, 2, 3].map((i) => tileGeometry(t, i, RENDER_TUNING.nearSpacing, cover.at));
    const refs = { grass: T.grass, dry: T.grassDry, dirt: T.dirt, rock: T.rock };
    const at = (x: number, z: number): string => {
      for (const g of tiles) {
        const col = g.getAttribute('color');
        const n = surfaceVertexCount(g);
        for (let i = 0; i < n; i++) {
          const v = vertex(g, i);
          if (Math.abs(v.x - x) < 1e-6 && Math.abs(v.z - z) < 1e-6) return nearest(new Color(col.getX(i), col.getY(i), col.getZ(i)), refs);
        }
      }
      throw new Error(`no vertex at ${x}, ${z}`);
    };
    expect(at(-10, -10)).toBe('dirt');
    expect(at(-20, -20)).toBe('grass');
    expect(at(5, -20)).toBe('dry');
    expect(at(-5, -20)).toBe('grass');
    // Tile 0 spans x, z ∈ [−25, 0]: the wall is in tile 1.
    const g1 = tileGeometry(t, 1, RENDER_TUNING.nearSpacing, cover.at);
    const col1 = g1.getAttribute('color');
    const n1 = surfaceVertexCount(g1);
    let rock = 0;
    for (let i = 0; i < n1; i++) {
      const v = vertex(g1, i);
      if (v.x > 16 && nearest(new Color(col1.getX(i), col1.getY(i), col1.getZ(i)), refs) === 'rock') rock++;
    }
    expect(rock).toBeGreaterThan(100);
  });

  it('draws tiles near the camera at nearSpacing and far ones at farSpacing, with hysteresis', () => {
    const T = RENDER_TUNING;
    expect(tileSpacing(0, null)).toBe(T.nearSpacing);
    expect(tileSpacing(T.nearTileM + 1, null)).toBe(T.farSpacing);
    // Near stays near until it is lodHysteresisM past the boundary; far stays far until lodHysteresisM inside it.
    expect(tileSpacing(T.nearTileM + T.lodHysteresisM - 0.1, T.nearSpacing)).toBe(T.nearSpacing);
    expect(tileSpacing(T.nearTileM + T.lodHysteresisM + 0.1, T.nearSpacing)).toBe(T.farSpacing);
    expect(tileSpacing(T.nearTileM - T.lodHysteresisM + 0.1, T.farSpacing)).toBe(T.farSpacing);
    expect(tileSpacing(T.nearTileM - T.lodHysteresisM - 0.1, T.farSpacing)).toBe(T.nearSpacing);

    const t = new Terrain(null, 200);
    const scene = new Scene();
    const view = new TerrainView(scene, { terrain: t, cover: NO_COVER });
    view.sync({ terrain: t, cover: NO_COVER }, new Vector3(0, 0, 0));
    const count = (s: number) => [...Array(t.tileCount).keys()].filter((i) => view.tileSpacingOf(i) === s).length;
    // From the centre: the 4 × 4 tiles within 40 m near; the 16 more within distantTileM (70 m) far; the rest distant.
    expect(count(T.nearSpacing)).toBe(16);
    expect(count(T.farSpacing)).toBe(16);
    expect(count(T.terrain.distantSpacing)).toBe(32);
    expect(view.tileSpacingOf(0)).toBe(T.terrain.distantSpacing);
    // The distant level has hysteresis too.
    expect(tileSpacing(T.terrain.distantTileM + T.lodHysteresisM - 0.1, T.farSpacing)).toBe(T.farSpacing);
    expect(tileSpacing(T.terrain.distantTileM + T.lodHysteresisM + 0.1, T.farSpacing)).toBe(T.terrain.distantSpacing);
    expect(tileSpacing(T.terrain.distantTileM - T.lodHysteresisM + 0.1, T.terrain.distantSpacing)).toBe(T.terrain.distantSpacing);
    expect(tileSpacing(T.terrain.distantTileM - T.lodHysteresisM - 0.1, T.terrain.distantSpacing)).toBe(T.farSpacing);
    expect(tileSpacing(1, T.terrain.distantSpacing)).toBe(T.nearSpacing);
    view.dispose();
  });

  it('rebuilds a tile when the sim edits it (a dig), with the new heights', () => {
    const t = new Terrain(null, 50);
    const scene = new Scene();
    const src = { terrain: t, cover: NO_COVER };
    const view = new TerrainView(scene, src);
    const before = view.tileMesh(0)!;
    view.sync(src, new Vector3(0, 0, 0));
    expect(view.tileMesh(0)).toBe(before);
    t.lower(-12.5, -12.5, 2);
    view.sync(src, new Vector3(0, 0, 0));
    const after = view.tileMesh(0)!;
    expect(after).not.toBe(before);
    let lowest = Infinity;
    for (let i = 0; i < surfaceVertexCount(after.geometry); i++) lowest = Math.min(lowest, vertex(after.geometry, i).y);
    expect(lowest).toBeCloseTo(t.heightAt(-12.5, -12.5), 6);
    expect(lowest).toBeLessThan(-0.1);
    view.dispose();
  });
});

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Spawns `n` trees on a grid, 6 m apart, from (−x0, −z0). */
function forest(w: World, n: number, d = 0.3, h = 12): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(spawnTree(w, { at: { x: -45 + (i % 10) * 9, z: -45 + Math.floor(i / 10) * 9 }, diameter: d + (i % 3) * 0.1, height: h + (i % 4) }).tree);
  return ids;
}

describe('trees', () => {
  it('draws 60 standing trunks as one instanced mesh of the collider prism, with 60 crowns; saplings apart', async () => {
    const w = await make({ size: 100 });
    const trees = forest(w, 60);
    for (let i = 0; i < 20; i++) spawnSapling(w, { at: { x: -40 + i * 4, z: 46 }, diameter: 0.06, height: 3 });
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    const trunks = views.forest.trunkInstancer(8)!;
    expect(trunks.count).toBe(60);
    expect(views.forest.canopies.count).toBe(60);
    expect(views.forest.stemInstancer(8)!.count).toBe(20);
    expect(views.forest.saplingTops.count).toBe(20);
    // Instance k (id order) maps the unit prism exactly onto tree k's collider.
    const e = ent(w, trees[7]);
    const s = e.shape as { kind: 'cylinder'; r: number; halfHeight: number; sides: number };
    const m = trunks.matrixAt(7);
    const unit = cylinderPoints({ r: 1, halfHeight: 1, sides: 8 });
    const real = cylinderPoints(s);
    for (let k = 0; k < unit.length; k += 3) {
      const p = new Vector3(unit[k], unit[k + 1], unit[k + 2]).applyMatrix4(m);
      expect(p.x).toBeCloseTo(real[k] + e.pose.p.x, 4);
      expect(p.y).toBeCloseTo(real[k + 1] + e.pose.p.y, 4);
      expect(p.z).toBeCloseTo(real[k + 2] + e.pose.p.z, 4);
    }
    // Every forest material goes through the cutout (the trunks between the camera and the player dissolve).
    expect(trunks.material.customProgramCacheKey()).toBe('cutout-v2');
    expect(views.forest.canopies.material.customProgramCacheKey()).toBe('cutout-v2');
    // The trees aren't drawn twice.
    expect(views.entities.instancerList().reduce((n, i) => n + i.count, 0)).toBe(0);
    views.dispose();
  });

  it('gives a notched tree its own mesh: the notch at the cut height, (1 − remaining) × diameter deep on the cut side', async () => {
    const w = await make();
    const id = spawnTree(w, { at: { x: 2, z: 3 }, diameter: 0.3, height: 12 }).tree;
    const e = ent(w, id);
    // As P10's felling leaves it after 8 chops from +x (§2.5).
    e.plant!.phase = 'notched';
    e.plant!.cut = { fromDir: { x: 1, y: 0, z: 0 }, remaining: 0.6, chops: 8, depthSumM: 0.12 };
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    expect(views.forest.trunkInstancer(8)?.count ?? 0).toBe(0);
    const v = views.forest.viewOf(id)!;
    expect(v).not.toBeNull();
    expect(v.collapsed).toBe(false);
    const s = e.shape as { r: number; halfHeight: number; sides: number };
    const cutY = -s.halfHeight + FELL_TUNING.cutHeightM;
    expect(notchDepthAt(v.trunk.geometry, cutY, 1, 0, s.r, s.sides)).toBeCloseTo((1 - 0.6) * 0.3, 6);
    // Nothing cut on the far side, nor away from the cut height.
    expect(notchDepthAt(v.trunk.geometry, cutY, -1, 0, s.r, s.sides)).toBeCloseTo(0, 6);
    expect(notchDepthAt(v.trunk.geometry, s.halfHeight, 1, 0, s.r, s.sides)).toBeCloseTo(0, 6);
    // Fresh-cut wood is pale in the notch (rule 3).
    const col = v.trunk.geometry.getAttribute('color');
    let pale = 0;
    for (let i = 0; i < col.count; i++) if (nearest(new Color(col.getX(i), col.getY(i), col.getZ(i)), { cut: RENDER_TUNING.forest.cutWood, bark: RENDER_TUNING.forest.bark }) === 'cut') pale++;
    expect(pale).toBeGreaterThan(4);
    views.dispose();
  });

  it('shudders a tree on each chop for chopShudderS, then it stands still again', async () => {
    const w = await make();
    const id = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 12 }).tree;
    const e = ent(w, id);
    e.plant!.phase = 'notched';
    e.plant!.cut = { fromDir: { x: 0, y: 0, z: 1 }, remaining: 0.9, chops: 2, depthSumM: 0.03 };
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    const v = views.forest.viewOf(id)!;
    const still = v.group.matrix.clone();
    views.handle({ type: 'chop', tree: id, point: { x: 0, y: 1, z: 0.15 }, remaining: 0.9 }, w);
    let moved = 0;
    const S = RENDER_TUNING.chopShudderS;
    const dt = 1 / 120;
    for (let t = 0; t < S; t += dt) {
      views.sync(w, 0, new Vector3(0, 2, 0), frame({ gameDt: dt }));
      const top = new Vector3(0, 6, 0).applyMatrix4(v.group.matrix);
      const at = new Vector3(0, 6, 0).applyMatrix4(still);
      moved = Math.max(moved, top.distanceTo(at));
    }
    // 0.6° at the top of a 12 m trunk is about 13 cm (and the base stays put).
    expect(moved).toBeGreaterThan(0.02);
    expect(moved).toBeLessThan(12 * Math.tan(((RENDER_TUNING.chopShudderDeg + 0.01) * Math.PI) / 180) + 1e-6);
    // The leaves it shed are falling.
    expect(views.forest.leaves.count).toBeGreaterThan(0);
    views.sync(w, 0, new Vector3(0, 2, 0), frame({ gameDt: dt }));
    expect(v.group.matrix.equals(still)).toBe(true);
    views.dispose();
  });

  it('draws a falling and a felled trunk with its notch at its foot and its crown inside r + fallenCrownPadM over its top third', async () => {
    const w = await make();
    const d = 0.3;
    const h = 14;
    const id = spawnTree(w, { at: { x: 0, z: 0 }, diameter: d, height: h }).tree;
    const e = ent(w, id);
    e.plant!.phase = 'notched';
    e.plant!.cut = { fromDir: { x: 0, y: 0, z: 1 }, remaining: 0.3, chops: 11, depthSumM: 0.21 };
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    // P10's fall (§2.5): the trunk keeps its id, shrinks to the part above the cut, and becomes dynamic.
    const above = h - FELL_TUNING.cutHeightM;
    w.entities.reshape(e, trunkPrism(d, above), { x: 0, y: FELL_TUNING.cutHeightM / 2, z: 0 });
    w.entities.setState(e, 'free');
    e.plant!.phase = 'falling';
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    const check = () => {
      const v = views.forest.viewOf(id)!;
      expect(v.collapsed).toBe(true);
      const s = e.shape as { r: number; halfHeight: number; sides: number };
      expect(notchDepthAt(v.trunk.geometry, -s.halfHeight, 0, 1, s.r, s.sides)).toBeCloseTo((1 - 0.3) * d, 6);
      const crown = v.crown!;
      crown.updateMatrix();
      const pad = RENDER_TUNING.fallenCrownPadM;
      const L = 2 * s.halfHeight;
      const pos = crown.geometry.getAttribute('position');
      let maxR = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const p = vertex(crown.geometry, i, crown.matrix);
        maxR = Math.max(maxR, Math.hypot(p.x, p.z));
        lo = Math.min(lo, p.y);
        hi = Math.max(hi, p.y);
      }
      expect(maxR).toBeLessThanOrEqual(s.r + pad);
      expect(maxR).toBeGreaterThan(s.r);
      expect(lo).toBeGreaterThanOrEqual(s.halfHeight - L / 3 - 1e-9);
      expect(hi).toBeLessThanOrEqual(s.halfHeight + 1e-9);
    };
    check();
    // Felled and at rest: P10 clears `plant`; it is an ordinary log to the rules, still the felled tree on screen.
    e.plant = null;
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    expect(views.forest.owns(e)).toBe(true);
    check();
    views.dispose();
  });

  it("shows the lower half of the notch on the tree's stump, with a pale cut top", async () => {
    const w = await make();
    const id = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.4, height: 12 }).tree;
    const e = ent(w, id);
    e.plant!.phase = 'falling';
    e.plant!.cut = { fromDir: { x: -1, y: 0, z: 0 }, remaining: 0.25, chops: 15, depthSumM: 0.3 };
    const stump = w.entities.create({ material: 'greenWood', shape: trunkPrism(0.4, FELL_TUNING.cutHeightM), p: { x: 0, y: FELL_TUNING.cutHeightM / 2, z: 0 }, state: 'fixed', look: 'stump' });
    e.plant!.stump = stump.id;
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 2, 0), frame());
    const v = views.forest.viewOf(stump.id)!;
    expect(v.crown).toBeNull();
    const s = stump.shape as { r: number; halfHeight: number; sides: number };
    expect(notchDepthAt(v.trunk.geometry, s.halfHeight, -1, 0, s.r, s.sides)).toBeCloseTo(0.75 * 0.4, 6);
    expect(views.entities.slotOf(stump.id)).toBeNull();
    views.dispose();
  });
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** EntityViews over a world's entities with nothing held, nothing skipped and no loads. */
function syncEntities(views: EntityViews, w: World, over: Partial<Parameters<EntityViews['sync']>[1]> = {}): void {
  views.sync(w.entities.all(), { alpha: 1, skip: () => false, placed: () => null, blood: () => 0, capacity: () => null, ...over });
}

describe('entities', () => {
  it('instances entities by shape prototype and material, each scaled onto its shape', async () => {
    const w = await make();
    const logs = [spawnLog(w, { p: { x: 0, y: 0.3, z: 0 }, length: 3, r: 0.15 }), spawnLog(w, { p: { x: 0, y: 0.3, z: 2 }, length: 4, r: 0.2 })];
    const sticks = [spawnStick(w, { p: { x: 3, y: 0.1, z: 0 }, length: 1.2, r: 0.03 }), spawnStick(w, { p: { x: 3, y: 0.1, z: 1 }, length: 2, r: 0.05, material: 'greenWood' })];
    const stones = [0, 1, 2, 3].map((proto) => spawnStone(w, { p: { x: -3, y: 0.5, z: proto * 2 }, mass: 2 + proto, proto: proto as 0 | 1 | 2 | 3 }));
    const flint = spawnStone(w, { p: { x: -6, y: 0.3, z: 0 }, mass: 0.6, material: 'flint' });
    const bigStone = spawnStone(w, { p: { x: -9, y: 1, z: 0 }, mass: 40, proto: 0 });
    const grass = spawnGrass(w, { p: { x: 6, y: 0.1, z: 0 }, mass: 2 });
    const coil = spawnRopeCoil(w, { at: { x: 6, y: 0, z: 3 }, material: 'vine', lengthM: 12 });
    const scene = new Scene();
    const views = new EntityViews(scene);
    syncEntities(views, w);
    // Logs share the hex prism; sticks the 8-gon prism, one instancer per material.
    expect(views.slotOf(logs[0])!.inst).toBe(views.slotOf(logs[1])!.inst);
    expect(views.slotOf(sticks[0])!.inst).not.toBe(views.slotOf(sticks[1])!.inst);
    expect(views.slotOf(sticks[0])!.inst.geometry).toBe(views.slotOf(sticks[1])!.inst.geometry);
    // A stone of the same shape at another mass shares its geometry, scaled.
    expect(views.slotOf(bigStone)!.inst).toBe(views.slotOf(stones[0])!.inst);
    expect(views.slotOf(flint)!.inst).not.toBe(views.slotOf(stones[0])!.inst);
    for (const id of [grass, coil]) expect(views.slotOf(id)).not.toBeNull();
    // Every stone is drawn from its exact hull points: each vertex lands on one of the collider's points.
    for (const id of [...stones, flint, bigStone]) {
      const e = ent(w, id);
      const slot = views.slotOf(id)!;
      const m = slot.inst.matrixAt(slot.index);
      const pts = (e.shape as { points: readonly number[] }).points;
      const q = new Quaternion(e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w);
      const world: Vector3[] = [];
      for (let k = 0; k < pts.length; k += 3) world.push(new Vector3(pts[k], pts[k + 1], pts[k + 2]).applyQuaternion(q).add(new Vector3(e.pose.p.x, e.pose.p.y, e.pose.p.z)));
      const g = slot.inst.geometry;
      for (let i = 0; i < g.getAttribute('position').count; i++) {
        const p = vertex(g, i, m);
        const d = Math.min(...world.map((x) => x.distanceTo(p)));
        expect(d).toBeLessThan(1e-4);
      }
    }
    views.dispose();
  });

  it('puts a pale cone at every sharp point, tip on the point, sized by sharpness and never past tipRadiusM', async () => {
    const w = await make();
    const stake = spawnStick(w, { p: { x: 0, y: 0.1, z: 0 }, length: 1.4, r: 0.05, sharp: { end: 1, s: 0.6 } });
    const blunt = spawnStick(w, { p: { x: 0, y: 0.1, z: 1 }, length: 1.4, r: 0.05, sharp: { end: -1, s: 0.1 } });
    const snag = spawnLog(w, { p: { x: 3, y: 0.3, z: 0 }, length: 3, r: 0.15, snags: 3 });
    const scene = new Scene();
    const views = new EntityViews(scene);
    syncEntities(views, w);
    expect(views.sharp.count).toBe(5);
    const tips = [stake, blunt, snag].flatMap((id) => {
      const e = ent(w, id);
      const q = new Quaternion(e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w);
      return e.sharpPoints.map((sp) => ({ at: new Vector3(sp.local.x, sp.local.y, sp.local.z).applyQuaternion(q).add(new Vector3(e.pose.p.x, e.pose.p.y, e.pose.p.z)), s: sp.sharpness }));
    });
    const lens: number[] = [];
    const reach = DAMAGE_TUNING.tipRadiusM;
    for (let i = 0; i < views.sharp.count; i++) {
      const m = views.sharp.matrixAt(i);
      // The cone's tip is its origin; its base centre 1 unit down its axis.
      const tip = new Vector3(0, 0, 0).applyMatrix4(m);
      const base = new Vector3(0, -1, 0).applyMatrix4(m);
      const len = tip.distanceTo(base);
      lens.push(len);
      if (i < 2) {
        // A shaped end (a hull): the tip exactly on the point, the cone inside the shape, no longer than tipRadiusM.
        expect(tips.some((t) => t.at.distanceTo(tip) < 1e-5)).toBe(true);
        expect(len).toBeLessThanOrEqual(reach + 1e-9);
      } else {
        // A snag's stub (no geometry of its own): out of the surface by snagStubOutM along the point's direction, never
        // further from the point than tipRadiusM (what the sharp-point test scores).
        const d = Math.min(...tips.map((t) => t.at.distanceTo(tip)));
        expect(d).toBeCloseTo(Math.min(reach, RENDER_TUNING.entities.snagStubOutM), 5);
        expect(d).toBeLessThanOrEqual(reach + 1e-9);
      }
    }
    // Sharper points have bigger cones (the stake at 0.6 over the blunted end at 0.1).
    expect(lens[0]).toBeGreaterThan(lens[1]);
    views.dispose();
  });

  it('shows a cross-cut log its notch: at axisT, (1 − remaining) of its thickness deep on the fromDir side', async () => {
    const w = await make();
    const id = spawnLog(w, { p: { x: 0, y: 0.3, z: 0 }, length: 3, r: 0.15 });
    const e = ent(w, id);
    // As P15's cut leaves it after strikes from the log's own +z side (§5.3; fromDir in its frame).
    e.crossCut = { axisT: 0.4, remaining: 0.25, fromDir: { x: 0, y: 0, z: 1 } };
    const scene = new Scene();
    const views = new EntityViews(scene);
    syncEntities(views, w);
    expect(views.slotOf(id)).toBeNull();
    const mesh = views.ownMesh(id)!;
    expect(notchDepthAt(mesh.geometry, 0.4, 0, 1, 0.15, 6)).toBeCloseTo(0.75 * 0.3, 6);
    expect(notchDepthAt(mesh.geometry, 1.2, 0, 1, 0.15, 6)).toBeCloseTo(0, 6);
    // Drawn where the log is.
    const p = new Vector3().setFromMatrixPosition(mesh.matrix);
    expect(p.distanceTo(new Vector3(e.pose.p.x, e.pose.p.y, e.pose.p.z))).toBeLessThan(1e-5);
    // Cut through: back to the shared prism.
    e.crossCut = null;
    syncEntities(views, w);
    expect(views.slotOf(id)).not.toBeNull();
    expect(views.ownMesh(id)).toBeNull();
    views.dispose();
  });

  it('darkens and cracks an entity below integrityCrack, sags it below integritySag', async () => {
    const T = RENDER_TUNING;
    const w = await make();
    const id = spawnLog(w, { p: { x: 0, y: 0.3, z: 0 }, length: 3, r: 0.12 });
    const e = ent(w, id);
    const scene = new Scene();
    const views = new EntityViews(scene);
    syncEntities(views, w);
    const sound = views.slotOf(id)!.inst.colorAt(views.slotOf(id)!.index);
    expect(views.cracks.count).toBe(0);
    e.integrity = (T.integrityCrack + T.integritySag) / 2;
    syncEntities(views, w);
    const weak = views.slotOf(id)!.inst.colorAt(views.slotOf(id)!.index);
    expect(luminance(weak)).toBeLessThan(luminance(sound) * 0.9);
    expect(views.cracks.count).toBe(1);
    e.integrity = T.integritySag / 2;
    syncEntities(views, w);
    expect(views.cracks.count).toBe(3);
    const mesh = views.ownMesh(id)!;
    // It lies along x: the middle sags down (local −x is world down for LYING_ALONG_X), the ends don't.
    const sag = Math.min(T.entities.sagMaxM, T.entities.sagFrac * 3);
    const pos = mesh.geometry.getAttribute('position');
    let mid = 0;
    for (let i = 0; i < pos.count; i++) {
      const v = vertex(mesh.geometry, i, mesh.matrix);
      if (Math.abs(v.x - e.pose.p.x) < 0.05) mid = Math.max(mid, e.pose.p.y + 0.12 - v.y);
    }
    expect(mid).toBeGreaterThan(sag * 0.9);
    views.dispose();
  });

  it('bends an entity whose load averages more than strainShowFrac of its capacity (a prop that won’t hold)', async () => {
    const T = RENDER_TUNING;
    const w = await make();
    const id = spawnStick(w, { p: { x: 0, y: 0.7, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 1.4, r: 0.04 });
    const e = ent(w, id);
    const scene = new Scene();
    const views = new EntityViews(scene);
    e.loadHist.fill(50);
    syncEntities(views, w, { capacity: () => 100 });
    expect(views.ownMesh(id)).toBeNull();
    e.loadHist.fill(95);
    syncEntities(views, w, { capacity: () => 100 });
    const mesh = views.ownMesh(id)!;
    expect(mesh).not.toBeNull();
    // Upright: it buckles sideways at the middle by up to strainBendFrac × its length.
    let side = 0;
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) side = Math.max(side, Math.hypot(pos.getX(i), pos.getZ(i)));
    const k = (0.95 - T.strainShowFrac) / (1 - T.strainShowFrac);
    expect(side).toBeGreaterThan(0.04 + 0.8 * k * T.entities.strainBendFrac * 1.4);
    views.dispose();
  });

  it('tells materials apart by more than colour: dry wood paler than green, rotten dark and lumpy, flint glossy', async () => {
    const w = await make();
    const ids = (['dryWood', 'greenWood', 'rottenWood'] as const).map((m, i) => spawnLog(w, { p: { x: 0, y: 0.3, z: i * 2 }, length: 2, r: 0.12, material: m }));
    const flint = spawnStone(w, { p: { x: 4, y: 0.3, z: 0 }, mass: 0.6, material: 'flint' });
    const stone = spawnStone(w, { p: { x: 4, y: 0.3, z: 2 }, mass: 0.6 });
    const [dry, green, rot] = ids.map((id) => luminance(entityColour(ent(w, id))));
    expect(dry).toBeGreaterThan(green);
    expect(green).toBeGreaterThan(rot);
    expect(protoOf(ent(w, ids[2])).key).not.toBe(protoOf(ent(w, ids[0])).key);
    const scene = new Scene();
    const views = new EntityViews(scene);
    syncEntities(views, w);
    expect(views.slotOf(flint)!.inst.material.roughness).toBeLessThan(views.slotOf(stone)!.inst.material.roughness);
    // The rotten prism is lumpy: its middle ring isn't the unit prism's radius.
    const g = views.slotOf(ids[2])!.inst.geometry;
    const radii = new Set<string>();
    for (let i = 0; i < g.getAttribute('position').count; i++) {
      const v = vertex(g, i);
      if (Math.abs(v.y) < 0.6) radii.add(Math.hypot(v.x, v.z).toFixed(3));
    }
    expect(radii.size).toBeGreaterThan(3);
    views.dispose();
  });

  it('interpolates a moving entity between its last two ticks by alpha', async () => {
    const w = await make();
    const id = spawnStick(w, { p: { x: 0, y: 2, z: 0 }, length: 1, r: 0.03 });
    const e = ent(w, id);
    e.prevPose = { p: { x: 0, y: 2, z: 0 }, q: { ...e.pose.q } };
    e.pose = { p: { x: 1, y: 1, z: 0 }, q: { ...e.pose.q } };
    const scene = new Scene();
    const views = new EntityViews(scene);
    syncEntities(views, w, { alpha: 0.25 });
    const p = new Vector3().setFromMatrixPosition(views.matrixOf(id)!);
    expect(p.x).toBeCloseTo(0.25, 6);
    expect(p.y).toBeCloseTo(1.75, 6);
    views.dispose();
  });
});

// ---------------------------------------------------------------------------
// Held and stowed things, fighters
// ---------------------------------------------------------------------------

/** A body pose that is the rig's, with the right forearm moved and turned (a ragdoll lagging the rig). */
function laggingPose(f: Fighter, off: Vector3, turn: Quaternion): BodyPose {
  const cur = {} as Record<string, { p: Vector3; q: Quaternion }>;
  for (const [b, x] of Object.entries(f.rig)) {
    const r = x as { pos: Vector3; rot: Quaternion };
    cur[b] = { p: r.pos.clone(), q: r.rot.clone() };
  }
  cur.foreArmR.p.add(off);
  cur.foreArmR.q.premultiply(turn);
  return { prev: cur, cur } as unknown as BodyPose;
}

describe('held and stowed things', () => {
  it('draws a tool in hand at the drawn forearm, and stowed things at the drawn belt and back', async () => {
    const w = await make({ player: true });
    const f = w.player!;
    w.step();
    const stick = spawnStick(w, { p: { x: 0, y: 1, z: 0 }, length: 0.9, r: 0.025 });
    const stone = spawnStone(w, { p: { x: 1, y: 0.3, z: 0 }, mass: 1 });
    const spear = spawnStick(w, { p: { x: 2, y: 0.1, z: 0 }, length: 1.9, r: 0.03, sharp: { end: 1, s: 0.6 } });
    // As P14's take, stow and phase 4b leave them (§2.12): the stick in hand, its record pose the sim's hand frame.
    const se = ent(w, stick);
    w.entities.setState(se, 'held');
    w.entities.setState(ent(w, stone), 'stowed');
    w.entities.setState(ent(w, spear), 'stowed');
    const rig = f.rig.foreArmR;
    const grip = new Matrix4().compose(new Vector3(0, -0.3, 0.05), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1.2), new Vector3(1, 1, 1));
    const rigM = new Matrix4().compose(rig.pos, rig.rot, new Vector3(1, 1, 1));
    const record = rigM.clone().multiply(grip);
    const rp = new Vector3();
    const rq = new Quaternion();
    record.decompose(rp, rq, new Vector3());
    se.pose = { p: { x: rp.x, y: rp.y, z: rp.z }, q: { x: rq.x, y: rq.y, z: rq.z, w: rq.w } };
    se.prevPose = se.pose;
    f.inventory = { hands: { entity: stick, mode: 'wield', grip: { x: 0, y: -0.4, z: 0 }, twoHanded: false, joint: null }, belt: [stone, null, null], back: spear };
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    const off = new Vector3(0.1, -0.05, 0.08);
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
    views.sync(w, 0, new Vector3(0, 2, -4), frame({ poseOf: () => laggingPose(f, off, turn) }));
    const v = views.fighterView(f)!;
    expect(v.held).toBe(stick);
    // In hand: the record's grip on the sim's forearm, carried onto the drawn forearm.
    const fa = v.view.bones.foreArmR;
    const drawnM = new Matrix4().compose(fa.position, fa.quaternion, new Vector3(1, 1, 1));
    const expected = drawnM.multiply(grip);
    const got = views.entities.matrixOf(stick)!;
    for (let i = 0; i < 16; i++) expect(got.elements[i]).toBeCloseTo(expected.elements[i], 5);
    // On the belt and the back: by the drawn pelvis and chest.
    const at = (id: number) => new Vector3().setFromMatrixPosition(views.entities.matrixOf(id)!);
    expect(at(stone).distanceTo(v.view.bones.pelvis.position)).toBeLessThan(0.45);
    expect(at(spear).distanceTo(v.view.bones.chest.position)).toBeLessThan(0.6);
    // The tool's tip as drawn is where blood drips from.
    const tip = v.weaponTip(f);
    expect(tip).not.toBeNull();
    // A bloodied tool shows it (gore on), and not with gore off.
    v.view.weaponBlood = 0.8;
    views.sync(w, 0, new Vector3(0, 2, -4), frame());
    const slot = views.entities.slotOf(stick)!;
    const bloody = slot.inst.colorAt(slot.index);
    views.sync(w, 0, new Vector3(0, 2, -4), frame({ gore: 'off' }));
    const clean = views.entities.slotOf(stick)!.inst.colorAt(views.entities.slotOf(stick)!.index);
    expect(bloody.r / Math.max(1e-6, bloody.g)).toBeGreaterThan(clean.r / Math.max(1e-6, clean.g) * 1.2);
    views.dispose();
  });
});

describe('fighters', () => {
  it('dresses the ape in dark fur with a snout and the giant darker with a silver back, at their scales', async () => {
    expect(lookForSpecies('ape', false).palette).toBe(APE_PALETTE);
    expect(lookForSpecies('giantApe', false).palette).toBe(GIANT_APE_PALETTE);
    expect(lookForSpecies(null, true).palette).not.toBe(APE_PALETTE);
    expect(APE_PALETTE.addons?.snout).toBe(true);
    expect(luminance(new Color(GIANT_APE_PALETTE.shirt))).toBeLessThan(luminance(new Color(APE_PALETTE.shirt)));
    const meshes = (v: FighterView) => {
      let n = 0;
      v.root.traverse((o) => {
        if (o instanceof Mesh) n++;
      });
      return n;
    };
    // The silver back and the brow are extra blocks.
    expect(meshes(new FighterView(GIANT_APE_PALETTE))).toBeGreaterThan(meshes(new FighterView(APE_PALETTE)));

    const w = await make({ player: true });
    const giant = createPlayer({ ids: w.ids.fighter });
    giant.species = 'giantApe';
    giant.scale = 5.5;
    giant.playerId = null;
    w.addFighter(giant, null);
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 2, -4), frame());
    const gv = views.fighterView(giant)!;
    expect(gv.view.palette).toBe(GIANT_APE_PALETTE);
    expect(gv.view.bones.chest.scale.x).toBeCloseTo(5.5, 9);
    expect(views.fighterView(w.player!)!.view.bones.chest.scale.x).toBeCloseTo(1, 9);
    views.dispose();
  });

  it("draws a ruler's wounds where they are: a gash until it heals, then a scar; a severe eye wound takes the eye", () => {
    const f = createPlayer();
    const view = new FighterView(GIANT_APE_PALETTE);
    const v = new FighterViewAdapter(view);
    const wound = (id: number, o: Partial<WoundRecord>): WoundRecord =>
      ({
        id,
        zone: 'knees',
        bone: 'shinL',
        local: { x: 0.07, y: -0.05, z: 0.05 },
        severe: false,
        effect: null,
        hp: 300,
        remaining: 300,
        cause: { kind: 'entity', entityId: 1, fighterId: null, credit: [], held: false, feature: 'sharpPoint' },
        tick: 1,
        credit: [],
        ...o,
      }) as WoundRecord;
    const knee = wound(1, {});
    (f as { ruler: RulerState | null }).ruler = { wounds: [knee] } as unknown as RulerState;
    const w = { entities: { get: () => undefined } } as unknown as World;
    v.frame(f, frame(), w);
    expect(v.scarCount).toBe(1);
    expect(scarKindOf(knee)).toBe('gash');
    expect(view.markCount).toBe(1);
    // Healed: the gash becomes a scar (the mark is replaced, not added to).
    knee.remaining = 0;
    v.frame(f, frame(), w);
    expect(scarKindOf(knee)).toBe('scar');
    expect(view.markCount).toBe(1);
    // A severe eye wound: the eye on that side goes.
    const eyes: Mesh[] = [];
    view.bones.head.traverse((o) => {
      if (o instanceof Mesh && Math.abs(o.position.z - 0.135) < 1e-6 && Math.abs(o.position.y - 0.18) < 1e-6) eyes.push(o);
    });
    expect(eyes.length).toBe(2);
    const eye = wound(2, { zone: 'eyes', bone: 'head', local: { x: 0.06, y: 0.18, z: 0.13 }, severe: true, effect: 'blindL' });
    (f as { ruler: RulerState | null }).ruler = { wounds: [knee, eye] } as unknown as RulerState;
    v.frame(f, frame(), w);
    expect(scarKindOf(eye)).toBe('eye');
    expect(eyes.filter((e) => !e.visible).map((e) => Math.sign(e.position.x))).toEqual([1]);
    expect(view.markCount).toBe(2);
  });

  it('draws no blood with gore off: no bloodied tools or fists, wounds as dark marks', () => {
    const view = new FighterView(APE_PALETTE);
    view.gore = 'off';
    view.bloodyWeapon(0.5);
    expect(view.weaponBlood).toBe(0);
    const mark = view.scar('chest', [0, 0.1, 0.13], 'gash');
    const reds: number[] = [];
    mark.traverse((o) => {
      if (o instanceof Mesh) {
        const c = (o.material as MeshStandardMaterial).color;
        reds.push(c.r - Math.max(c.g, c.b));
      }
    });
    expect(Math.max(...reds)).toBeLessThan(0.1);
    const full = new FighterView(APE_PALETTE);
    const red = full.scar('chest', [0, 0.1, 0.13], 'gash');
    let anyRed = false;
    red.traverse((o) => {
      if (o instanceof Mesh) {
        const c = (o.material as MeshStandardMaterial).color;
        if (c.r - Math.max(c.g, c.b) > 0.2) anyRed = true;
      }
    });
    expect(anyRed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ropes
// ---------------------------------------------------------------------------

function rope(joint: number, a: [number, number, number], b: [number, number, number], lengthM: number, taut: boolean, strain: number): RopeView {
  return { joint, a: { x: a[0], y: a[1], z: a[2] }, b: { x: b[0], y: b[1], z: b[2] }, lengthM, taut, strain };
}

describe('ropes', () => {
  it('draws one tube per joint: slack ones sag above the ground, taut ones straight and thinner, strained ones fray and redden', () => {
    const T = RENDER_TUNING;
    const list: RopeView[] = [
      rope(1, [0, 3, 0], [4, 3, 0], 6, false, 0),
      rope(2, [0, 3, 2], [4, 3, 2], 4, true, 0.5),
      rope(3, [0, 3, 4], [4, 3, 4], 4, true, 0.95),
    ];
    const joints = new Map<number, JointRecord>();
    for (const r of list) joints.set(r.joint, { id: r.joint, kind: 'rope', a: { entity: null, local: r.a }, b: { entity: null, local: r.b }, rope: null } as unknown as JointRecord);
    const src = { joints: { view: () => list, get: (id: number) => joints.get(id) }, entities: { get: () => undefined }, terrain: { heightAt: () => 0 } };
    const scene = new Scene();
    const views = new RopeViews(scene);
    views.sync(src, { matrixOf: () => null, handOf: () => null });
    expect(views.views.size).toBe(3);
    const slack = views.views.get(1)!;
    const taut = views.views.get(2)!;
    const strained = views.views.get(3)!;
    // Slack: sags below its chord, never below the ground.
    const mid = slack.points[Math.floor(slack.points.length / 2)];
    expect(mid.y).toBeLessThan(3 - 0.5);
    for (const p of slack.points) expect(p.y).toBeGreaterThanOrEqual(slack.radius - 1e-9);
    // Taut: straight, and thinner the more it is strained.
    for (const p of taut.points) expect(p.y).toBeCloseTo(3, 9);
    expect(taut.radius).toBeLessThan(slack.radius);
    expect(taut.radius).toBeCloseTo(slack.radius * (1 - T.ropeThinMax * 0.5), 9);
    expect(strained.radius).toBeLessThan(taut.radius);
    const c = (r: { mesh: Mesh }) => (r.mesh.material as MeshStandardMaterial).color;
    expect(c(strained).r - c(strained).g).toBeGreaterThan(c(taut).r - c(taut).g + 0.05);
    // One joint gone: its tube goes.
    list.pop();
    views.sync(src, { matrixOf: () => null, handOf: () => null });
    expect(views.views.size).toBe(2);
    views.dispose();
  });

  it('lays a long vine from its anchor to the ground and along it to its loose end', () => {
    const ground = { heightAt: () => 0 };
    const pts = ropePoints(new Vector3(0, 9, 0), new Vector3(8, 0, 0), 17, false, 8, 0.016, ground);
    expect(pts[0].y).toBe(9);
    expect(pts[pts.length - 1].x).toBe(8);
    for (const p of pts) expect(p.y).toBeGreaterThanOrEqual(0);
    // Most of its slack lies on the ground.
    expect(pts.filter((p) => p.y < 0.02).length).toBeGreaterThan(3);
  });

  it('draws an end tied to an entity where the entity is drawn, and a held end at the drawn fist', () => {
    const list: RopeView[] = [rope(7, [0, 1, 0], [3, 1, 0], 3, true, 0.1)];
    const rec = { id: 7, kind: 'rope', a: { entity: 42, local: { x: 0, y: 0.5, z: 0 } }, b: { entity: null, local: { x: 0, y: 0, z: 0 }, fighter: 1 }, rope: null } as unknown as JointRecord;
    const src = { joints: { view: () => list, get: () => rec }, entities: { get: () => undefined }, terrain: { heightAt: () => 0 } };
    const scene = new Scene();
    const views = new RopeViews(scene);
    const drawn = new Matrix4().makeTranslation(0.2, 1, 0.1);
    const fist = new Vector3(3.1, 1.2, -0.1);
    views.sync(src, { matrixOf: (id) => (id === 42 ? drawn : null), handOf: (id) => (id === 1 ? fist : null) });
    const pts = views.views.get(7)!.points;
    expect(pts[0].distanceTo(new Vector3(0.2, 1.5, 0.1))).toBeLessThan(1e-9);
    expect(pts[pts.length - 1].distanceTo(fist)).toBeLessThan(1e-9);
    views.dispose();
  });
});

// ---------------------------------------------------------------------------
// Grass, sky
// ---------------------------------------------------------------------------

describe('grass', () => {
  it('lays at most grassPerCell tufts per cell within grassRadiusM, none on dug ground, pale where the cover is dense', () => {
    const T = RENDER_TUNING;
    const t = new Terrain(null, 100);
    t.lower(6, 6, 6);
    t.lower(6.4, 6, 6);
    const cover = { at: (x: number, _z: number) => (x > 0 ? 0.95 : 0.3) };
    const scene = new Scene();
    const grass = new GrassView(scene);
    grass.sync({ terrain: t, cover }, { x: 0, z: 0 });
    const n = grass.tufts.count;
    expect(tuftsFor(1)).toBe(T.grassPerCell);
    expect(tuftsFor(0)).toBe(0);
    const cells = Math.PI * (T.grassRadiusM + 3) ** 2 / 4;
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThanOrEqual(cells * T.grassPerCell);
    let lightRight = 0;
    let lightLeft = 0;
    let left = 0;
    let right = 0;
    for (let i = 0; i < n; i++) {
      const p = new Vector3().setFromMatrixPosition(grass.tufts.matrixAt(i));
      expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(T.grassRadiusM + 1.5);
      // Bare where it was dug.
      expect(Math.abs(t.heightAt(p.x, p.z) - t.originalHeightAt(p.x, p.z))).toBeLessThanOrEqual(T.terrain.dugM + 0.03);
      const c = luminance(grass.tufts.colorAt(i));
      if (p.x > 1) {
        lightRight += c;
        right++;
      } else if (p.x < -1) {
        lightLeft += c;
        left++;
      }
    }
    expect(lightRight / right).toBeGreaterThan((lightLeft / left) * 1.15);
    // Denser cover, more tufts.
    expect(right).toBeGreaterThan(left * 1.5);
    grass.dispose();
  });
});

describe('sky', () => {
  it("puts the sun's shadow over the player, ±shadowExtentM to shadowFarM, snapped to whole texels; fog fogNear-fogFar", () => {
    const T = RENDER_TUNING;
    const scene = new Scene();
    const sky = new Sky(scene);
    const a = new Vector3(10.37, 2.1, -4.82);
    sky.sync(null, a);
    const cam = sky.sun.shadow.camera;
    expect(cam.right).toBe(T.shadowExtentM);
    expect(cam.left).toBe(-T.shadowExtentM);
    expect(cam.far).toBe(T.shadowFarM);
    expect(sky.fog.near).toBe(T.fogNear);
    expect(sky.fog.far).toBe(T.fogFar);
    const target = sky.sun.target.position.clone();
    expect(target.distanceTo(a)).toBeLessThan(shadowTexelM());
    // The sun stands along sunDirection from it.
    const d = sky.sun.position.clone().sub(target).normalize();
    expect(d.distanceTo(sunDirection())).toBeLessThan(1e-9);
    // A step smaller than a texel across the light leaves the shadow camera where it was.
    const s1 = snapToTexels(new Vector3(0, 0, 0));
    const s2 = snapToTexels(new Vector3(shadowTexelM() * 0.2, 0, 0));
    expect(s1.distanceTo(s2)).toBeLessThan(shadowTexelM() * 0.5);
    sky.dispose();
  });
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe('draw calls', () => {
  it('logs the draw calls of a Clearing-sized scene and keeps them within the budget (§10.4, SPEC < 300)', async () => {
    const w = await make({ size: 200, player: true });
    forest(w, 60);
    for (let i = 0; i < 20; i++) spawnSapling(w, { at: { x: -30 + i * 3, z: 60 }, diameter: 0.06, height: 3 });
    for (let i = 0; i < 40; i++) spawnStone(w, { p: { x: -60 + (i % 10) * 2, y: 1, z: 70 + Math.floor(i / 10) * 2 }, mass: 0.5 + (i % 7) * 3, proto: (i % 4) as 0 | 1 | 2 | 3 });
    for (let i = 0; i < 10; i++) spawnStone(w, { p: { x: 30 + i * 2, y: 1, z: 70 }, mass: 0.5, material: 'flint', proto: (i % 4) as 0 | 1 | 2 | 3 });
    for (let i = 0; i < 40; i++) spawnStick(w, { p: { x: -60 + (i % 10) * 3, y: 0.2, z: -70 + Math.floor(i / 10) * 2 }, length: 0.8 + (i % 5) * 0.5, r: 0.03 + (i % 3) * 0.01 });
    for (let i = 0; i < 5; i++) spawnLog(w, { p: { x: 30, y: 0.5, z: -70 + i * 3 }, length: 4, r: 0.18 });
    for (let i = 0; i < 20; i++) spawnStick(w, { p: { x: 50, y: 0.2, z: -70 + i * 1.5 }, length: 2.5, r: 0.03, material: 'rottenWood' });
    for (let i = 0; i < 30; i++) spawnGrass(w, { p: { x: -80 + i * 2, y: 0.2, z: 85 }, mass: 2 });
    for (let i = 0; i < 4; i++) spawnLog(w, { p: { x: 60, y: 0.5, z: 40 + i * 4 }, length: 3, mass: 100, snags: 3 });
    for (let i = 0; i < 6; i++) spawnRopeCoil(w, { at: { x: 70, y: 0, z: 60 + i * 2 }, material: 'vine', lengthM: 10 + 2 * i });
    const scene = new Scene();
    const views = new WorldViews(scene, w);
    views.sync(w, 0, new Vector3(0, 3, -4), frame());
    const calls = drawCallCount(scene);
    console.info(`[P32] draw calls for a Clearing-sized scene (${w.entities.all().length} entities, 1 fighter), before shadows: ${calls}`);
    expect(calls).toBeGreaterThan(64);
    expect(calls).toBeLessThan(300);
    views.dispose();
  });
});

describe('unit prisms', () => {
  it('match the sim collider ring (the factory trunk and the view trunk share one shape)', () => {
    const g = unitPrism(8);
    const ring = cylinderPoints({ r: 1, halfHeight: 1, sides: 8 });
    const pos = g.getAttribute('position');
    for (let k = 0; k < ring.length; k += 3) {
      let found = false;
      for (let i = 0; i < pos.count; i++) if (Math.hypot(pos.getX(i) - ring[k], pos.getY(i) - ring[k + 1], pos.getZ(i) - ring[k + 2]) < 1e-6) found = true;
      expect(found).toBe(true);
    }
    expect(crownRadius(12, false)).toBeGreaterThan(crownRadius(3, true));
  });
});
