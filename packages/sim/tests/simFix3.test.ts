// SIM-fix3: regressions the test-harness package P23 found. Each describe is one bug: it failed before its fix.
// 1. shrinkShape made a needle hull of a thin bearer (r 0.02 m × 8 m) that Rapier can't build ("expected instance of p").
// 2. Breaking.split made pieces of no volume (a cut at an end), and EntityStore.create threw inside World.step.
// 3. A ray straight down exactly through a heightfield vertex missed the terrain: Place said 'noSupport'.
// 4. giveTool couldn't give every starter-cache tool (the cache's 8 m vine coil was missing).
// 5. The dev teleport took no yaw.
//
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { toCm, type MetaCommand, type VerbCommand } from '../src/sim/commands';
import { CLEARING_TUNING } from '../src/world/clearing';
import { GIVE_TOOLS } from '../src/world/devOps';
import { heldMembers } from '../src/world/verbs/tools';
import { resetTuning } from '../src/tuning/registry';
import { BREAK_TUNING, isRapierError, settlePieces } from '../src/world/breaking';
import { spawnLog, spawnStarterAxe, spawnStick } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import { colliderDesc, crossCut, cylinderPoints, principalAxis, rapierHullOk, roundCylinderR, shapeVolume } from '../src/world/shapes';
import { queryShape } from '../src/world/queries';
import { breakEnergyJ, MATERIALS } from '../src/world/materials';
import type { Shape, V3 } from '../src/world/types';
import { planPlace, shrinkShape } from '../src/world/verbs/place';
import { verbGeom } from '../src/world/verbs/tools';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 180_000 });

const live: World[] = [];
async function make(seed = 41, scene: 'empty' | 'clearing' = 'empty'): Promise<World> {
  const w = await createWorld({ seed, scene, nav: 'off', size: 60 });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
  vi.restoreAllMocks();
});

const scaleV = (v: V3, k: number): V3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });

function run(w: World, n: number): void {
  for (let t = 0; t < n; t++) w.step();
}

function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind' | 'target'> & { target?: number }): VerbCommand {
  return { tick: w.tick + 1, player: 1, kind: 'verb', target: 0, ...v } as VerbCommand;
}

/** Whether Rapier can build the shape as a query shape (a cylinder or a hull is a convex hull of its points). */
function rapierBuilds(s: Shape): boolean {
  const pts = s.kind === 'cylinder' ? cylinderPoints(s) : s.kind === 'hull' ? s.points : null;
  if (!pts) return true;
  const raw = new RAPIER.ConvexPolyhedron(new Float32Array(pts), null).intoRaw();
  const ok = !!raw;
  raw?.free();
  return ok;
}

// ---------------------------------------------------------------------------
// 1. shrinkShape never makes a hull Rapier can't build
// ---------------------------------------------------------------------------

describe('bug 1: shrinkShape on a thin bearer', () => {
  const bearer: Shape = { kind: 'cylinder', halfHeight: 4, r: 0.02, sides: 8 };

  it('the r 0.02 m × 8 m bearer shrunk by placeShrinkM is still a hull Rapier can build, and no larger than it', () => {
    expect(rapierBuilds(bearer)).toBe(true);
    const s = shrinkShape(bearer, VERB_TUNING.placeShrinkM);
    expect(rapierBuilds(s)).toBe(true);
    expect(rapierHullOk(s)).toBe(true);
    expect(s.kind).toBe('cylinder');
    if (s.kind !== 'cylinder') return;
    expect(s.r).toBeGreaterThan(0);
    expect(s.r).toBeLessThanOrEqual(bearer.r);
    expect(s.halfHeight).toBeLessThanOrEqual(bearer.halfHeight);
  });

  it('the shrink stays below placeShrinkMaxFrac of the smallest dimension, for every kind', () => {
    const f = VERB_TUNING.placeShrinkMaxFrac;
    const m = 0.5; // far more than any of these shapes can lose
    const c = shrinkShape({ kind: 'cylinder', halfHeight: 1, r: 0.04, sides: 8 }, m);
    expect(c).toEqual({ kind: 'cylinder', halfHeight: 1 - 0.04 * f, r: 0.04 - 0.04 * f, sides: 8 });
    const b = shrinkShape({ kind: 'box', hx: 0.5, hy: 0.25, hz: 0.1 }, m);
    expect(b).toEqual({ kind: 'box', hx: 0.5 - 0.1 * f, hy: 0.25 - 0.1 * f, hz: 0.1 - 0.1 * f });
    expect(shrinkShape({ kind: 'ball', r: 0.1 }, m)).toEqual({ kind: 'ball', r: 0.1 - 0.1 * f });
  });

  it('a needle hull is never shrunk into one Rapier rejects: the unshrunk shape comes back', () => {
    // A hull bearer as thin as Rapier still builds (r 0.004 × 8 m prism points).
    const pts = cylinderPoints({ halfHeight: 4, r: 0.004, sides: 8 });
    const hull: Shape = { kind: 'hull', points: pts };
    expect(rapierBuilds(hull)).toBe(true);
    const s = shrinkShape(hull, VERB_TUNING.placeShrinkM);
    expect(rapierBuilds(s)).toBe(true);
  });

  it('placing the thin bearer (lying, sloped, upright) plans without throwing', async () => {
    const w = await make();
    const id = spawnStick(w, { p: { x: 1.5, y: 0.05, z: 0 }, length: 8, r: 0.02 });
    w.step();
    expect(w.verbs.putInHands(w.player!, id)).toBe(true);
    w.step();
    const at: V3 = { x: 0, y: 0.05, z: 1.5 };
    for (const [yaw, pitch] of [
      [0, 0],
      [64, 0],
      [0, 20],
      [0, 64],
    ] as const) {
      expect(() => planPlace(w, w.player!, verb(w, { verb: 'place', at: toCm({ ...at, y: pitch === 64 ? 4 : at.y }), yaw, pitch }))).not.toThrow();
    }
  });

  it('every other way a degenerate hull reaches Rapier is guarded: queries fall back, colliderDesc says what failed', async () => {
    const w = await make();
    const needle: Shape = { kind: 'cylinder', halfHeight: 4, r: 0.001, sides: 8 };
    const sliver: Shape = { kind: 'hull', points: cylinderPoints(needle) };
    expect(rapierBuilds(needle)).toBe(false);
    expect(rapierHullOk(sliver)).toBe(false);
    const stick = spawnStick(w, { p: { x: 0, y: 0.05, z: 3 }, length: 2, r: 0.04 });
    w.step();
    const pose = { p: { x: 0, y: 0.05, z: 3 }, q: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } };
    for (const s of [needle, sliver]) {
      // Lying across the stick (the stick lies along x, this along world x too, offset onto it): it overlaps it.
      expect(() => w.queries.overlaps(s, pose, { terrain: true, entities: 'all' })).not.toThrow();
      expect(w.queries.overlaps(s, pose, { terrain: false, entities: 'all' })).toContainEqual({ kind: 'entity', id: stick });
      expect(() => w.queries.castShape(s, { ...pose, p: { x: 0, y: 1, z: 3 } }, { x: 0, y: -1, z: 0 }, 2, { terrain: true, entities: 'all' })).not.toThrow();
      expect(w.queries.castShape(s, { ...pose, p: { x: 0, y: 1, z: 3 } }, { x: 0, y: -1, z: 0 }, 2, { terrain: true, entities: 'all' })?.owner).toEqual({ kind: 'entity', id: stick });
    }
    // Every round stand-in for the needle has its volume: the query's (and the client mirror's) radius is colliderDesc's.
    const qs = queryShape(needle);
    expect(qs.shape).toBeInstanceOf(RAPIER.Cylinder);
    const round = qs.shape as RAPIER.Cylinder;
    expect(round.radius).toBeCloseTo(roundCylinderR(needle as { r: number; sides: number }), 12);
    expect(Math.PI * round.radius ** 2 * 2 * round.halfHeight).toBeCloseTo(shapeVolume(needle), 12);
    // rapierHullOk is asked once per shape object (cached), with the same answer.
    expect(rapierHullOk(needle)).toBe(rapierHullOk(needle));
    expect(() => colliderDesc(sliver, MATERIALS.dryWood)).toThrow(/could not build a convex hull/);
    // A needle prism collides as Rapier's round cylinder: it can be an entity.
    expect(() => colliderDesc(needle, MATERIALS.dryWood)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. A ray cast straight down exactly at a heightfield vertex finds the terrain
// ---------------------------------------------------------------------------

describe('bug 3: the place ray at an exact heightfield vertex', () => {
  /** Every terrain vertex within the box, as world (x, z). */
  function vertices(w: World, x0: number, x1: number, z0: number, z1: number): { x: number; z: number }[] {
    const T = w.terrain;
    const out: { x: number; z: number }[] = [];
    for (let i = Math.ceil((x0 - T.minX) / T.spacing); T.minX + i * T.spacing <= x1; i++) {
      for (let j = Math.ceil((z0 - T.minZ) / T.spacing); T.minZ + j * T.spacing <= z1; j++) out.push({ x: T.minX + i * T.spacing, z: T.minZ + j * T.spacing });
    }
    return out;
  }

  for (const terrain of ['flat', 'generated'] as const) {
    it(`castRay straight down hits the ${terrain} terrain at every vertex, at heightAt`, async () => {
      const w = await createWorld({ seed: 41, scene: 'empty', terrain, nav: 'off', size: 60 });
      live.push(w);
      w.step();
      let n = 0;
      const e = -w.terrain.minX - w.terrain.spacing;
      for (const p of vertices(w, -e, e, -e, e)) {
        const h = w.terrain.heightAt(p.x, p.z);
        const hit = w.queries.castRay({ x: p.x, y: h + 1, z: p.z }, { x: 0, y: -1, z: 0 }, 2, { terrain: true, entities: 'none' });
        expect(hit?.owner, `vertex ${p.x}, ${p.z}`).toEqual({ kind: 'terrain' });
        expect(hit!.point.y).toBeCloseTo(h, 4);
        expect(hit!.normal.y).toBeGreaterThan(0);
        n++;
      }
      expect(n).toBeGreaterThan(30_000);
    });
  }

  it("an upright stick set down with its foot exactly on a vertex Rapier's own ray misses is not refused noSupport", async () => {
    const w = await createWorld({ seed: 41, scene: 'empty', terrain: 'generated', nav: 'off', size: 60 });
    live.push(w);
    w.step();
    // The vertices near the middle where Rapier's straight-down ray finds no terrain (the bug: ~10 % of them).
    const misses = vertices(w, -8, 8, -8, 8).filter((v) => {
      const h = w.terrain.heightAt(v.x, v.z);
      return !w.physics.rapier.castRay(new RAPIER.Ray({ x: v.x, y: h + 1, z: v.z }, { x: 0, y: -1, z: 0 }), 2, true);
    });
    expect(misses.length).toBeGreaterThan(0);
    const p = w.player!;
    const id = spawnStick(w, { p: { x: p.pos.x, y: 0.5, z: p.pos.z + 1 }, length: 1.2, r: 0.04 });
    run(w, 30);
    expect(w.verbs.putInHands(p, id)).toBe(true);
    for (const v of misses.slice(0, 6)) {
      // The player 1 m short of it along -x (the stick comes with the hands).
      w.teleport(p, v.x - 1, v.z);
      run(w, 2);
      const h = w.terrain.heightAt(v.x, v.z);
      const plan = planPlace(w, p, verb(w, { verb: 'place', at: toCm({ x: v.x, y: h + 0.6, z: v.z }), yaw: 0, pitch: 64, drive: 0 }));
      expect(plan.ok ? 'ok' : plan.reason, `vertex ${v.x}, ${v.z}`).not.toBe('noSupport');
      expect(plan.ok ? 'ok' : plan.reason, `vertex ${v.x}, ${v.z}`).toBe('ok');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. giveTool gives every starter tool the Clearing has, made as the cache makes it
// ---------------------------------------------------------------------------

describe('bug 4: giveTool and the starter cache', () => {
  type Made = { material: string; shape: Shape; sharp: number[]; rope: number | null; members: number; lashes: number };
  /** An entity and what is lashed to it, as plain data (the members in id order). */
  function made(w: World, id: number): Made[] {
    const ids = heldMembers(w, id);
    return ids.map((m) => {
      const e = w.entities.get(m)!;
      return {
        material: e.material,
        shape: e.shape,
        sharp: e.sharpPoints.map((s) => s.sharpness),
        rope: e.rope?.lengthM ?? null,
        members: ids.length,
        lashes: e.joints.filter((j) => w.joints.get(j)?.kind === 'lash').length,
      };
    });
  }
  const dev = (w: World, i: number): MetaCommand => ({ tick: w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'giveTool', args: [i] } });

  it('each starter-cache tool (the lashed stone axe, the digging stick, the 8 m vine coil) can be given, alike', async () => {
    const w = await make(41, 'clearing');
    const c = { x: CLEARING_TUNING.starterCacheAt[0], z: CLEARING_TUNING.starterCacheAt[1] };
    const near = w.entities.all().filter((e) => e.generated && Math.hypot(e.pose.p.x - c.x, e.pose.p.z - c.z) < 2);
    const axe = near.find((e) => e.look === 'stick' && e.joints.length > 0)!;
    const stick = near.find((e) => e.look === 'stick' && e.joints.length === 0 && e.sharpPoints.length > 0)!;
    const coil = near.find((e) => e.material === 'vine' && e.joints.length === 0)!;
    expect(axe && stick && coil).toBeTruthy();
    const cache: Record<string, Made[]> = { stoneAxe: made(w, axe.id), diggingStick: made(w, stick.id), starterVine: made(w, coil.id) };
    // The axe is the handle and the flint head, lashed: two members.
    expect(cache.stoneAxe.length).toBe(2);
    expect(cache.starterVine[0].rope).toBe(CLEARING_TUNING.starterCoilM);
    for (const [tool, want] of Object.entries(cache)) {
      const i = (GIVE_TOOLS as readonly string[]).indexOf(tool);
      expect(i, `${tool} is one of GIVE_TOOLS`).toBeGreaterThanOrEqual(0);
      w.commands.push(dev(w, i));
      run(w, 3);
      const h = w.player!.inventory!.hands;
      expect(h, tool).not.toBeNull();
      expect(made(w, h!.entity), tool).toEqual(want);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The dev teleport takes an optional yaw; the older encodings are unchanged
// ---------------------------------------------------------------------------

describe('bug 5: teleport with a yaw', () => {
  const tele = (w: World, args: number[]): MetaCommand => ({ tick: w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'teleport', args } });
  const angleOff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

  it('[xCm, zCm, 0, yaw] moves the command player and turns it to yaw (1/256 turns); [x, z] and [x, z, id] keep the yaw', async () => {
    const w = await make();
    const p = w.player!;
    run(w, 3);
    // The old encodings: moved, the yaw left alone.
    const yaw0 = p.yaw;
    w.commands.push(tele(w, [500, -300]));
    w.step();
    expect(Math.hypot(p.pos.x - 5, p.pos.z + 3)).toBeLessThan(0.01);
    expect(angleOff(p.yaw, yaw0)).toBeLessThan(1e-9);
    w.commands.push(tele(w, [-200, 400, p.id]));
    w.step();
    expect(Math.hypot(p.pos.x + 2, p.pos.z - 4)).toBeLessThan(0.01);
    expect(angleOff(p.yaw, yaw0)).toBeLessThan(1e-9);
    // With a yaw: a quarter turn (64 steps) is π/2; 0 is the command's player.
    for (const [steps, want] of [
      [64, Math.PI / 2],
      [128, Math.PI],
      [-64, -Math.PI / 2],
      [256 + 32, Math.PI / 4],
    ] as const) {
      w.commands.push(tele(w, [100, 100, 0, steps]));
      w.step();
      expect(Math.hypot(p.pos.x - 1, p.pos.z - 1)).toBeLessThan(0.01);
      expect(angleOff(p.yaw, want), `${steps} steps`).toBeLessThan(0.05);
    }
    // ... and an explicit id.
    w.commands.push(tele(w, [0, 200, p.id, 192]));
    w.step();
    expect(angleOff(p.yaw, -Math.PI / 2)).toBeLessThan(0.05);
    // The 3-argument form is unchanged: id 0 is no fighter there, so nothing moves.
    const at0 = { ...p.pos };
    w.commands.push(tele(w, [700, 700, 0]));
    w.step();
    expect(Math.hypot(p.pos.x - at0.x, p.pos.z - at0.z)).toBeLessThan(0.01);
    // No such fighter: nothing happens; a negative id is malformed.
    const at = { ...p.pos };
    w.commands.push(tele(w, [900, 900, 999, 0]));
    w.step();
    expect(Math.hypot(p.pos.x - at.x, p.pos.z - at.z)).toBeLessThan(0.01);
    w.commands.push(tele(w, [900, 900, -1, 0]));
    expect(() => w.step()).toThrow(/fighter id/);
  });
});

// ---------------------------------------------------------------------------
// 2. Breaking.split never makes a piece without volume, and never throws out of World.step
// ---------------------------------------------------------------------------

describe('bug 2: Breaking.split and zero-volume pieces', () => {
  const breakOf = (w: World, id: number) => {
    const b = w.events.find((x) => x.type === 'break' && x.entity === id);
    return b && b.type === 'break' ? b : null;
  };
  const massOf = (w: World, ids: readonly number[]): number => ids.reduce((a, pid) => a + w.entities.get(pid)!.mass, 0);

  it('a load break at the very tip of a sharpened stick (a hull) steps without throwing; mass is conserved', async () => {
    const w = await make(202);
    const id = spawnStick(w, { p: { x: 0, y: 0.06, z: 3 }, length: 1.4, r: 0.05, sharp: { end: 1, s: 0.6 } });
    w.step();
    const e = w.entities.get(id)!;
    expect(e.shape.kind).toBe('hull');
    const mass = e.mass;
    // At the tip (its sharp point): the cut there leaves a sliver of ~1e-27 m³ whose hull Rapier can't build.
    w.breaking.loadBreak(e, verbGeom.pointToWorld(e.pose, e.sharpPoints[0].local), null);
    expect(() => w.step()).not.toThrow();
    const brk = breakOf(w, id);
    expect(brk).not.toBeNull();
    expect(brk!.pieces.length).toBeGreaterThanOrEqual(1);
    for (const pid of brk!.pieces) expect(shapeVolume(w.entities.get(pid)!.shape)).toBeGreaterThanOrEqual(BREAK_TUNING.pieceMinVolumeM3);
    expect(massOf(w, brk!.pieces)).toBeCloseTo(mass, 6);
  });

  it('breaking the pieces again at their ends (slivers of slivers: pieces of no volume) never throws; mass is conserved', async () => {
    const w = await make(202);
    const id = spawnStick(w, { p: { x: 0, y: 0.06, z: 3 }, length: 1.4, r: 0.05, sharp: { end: 1, s: 0.6 } });
    w.step();
    const mass = w.entities.get(id)!.mass;
    let ids = [id];
    for (let round = 0; round < 4; round++) {
      for (const pid of ids) {
        const e = w.entities.get(pid)!;
        const ax = principalAxis(e.shape);
        // Both ends of its long axis, in turn: the far end first.
        const end = round % 2 === 0 ? ax.max : ax.min;
        w.breaking.loadBreak(e, verbGeom.pointToWorld(e.pose, scaleV(ax.dir, end)), null);
      }
      expect(() => w.step()).not.toThrow();
      ids = ids.flatMap((pid) => breakOf(w, pid)?.pieces ?? (w.entities.get(pid) ? [pid] : []));
      expect(massOf(w, ids)).toBeCloseTo(mass, 6);
    }
    for (const pid of ids) expect(shapeVolume(w.entities.get(pid)!.shape)).toBeGreaterThanOrEqual(BREAK_TUNING.pieceMinVolumeM3);
  });

  it('settlePieces: a piece of no volume and one Rapier refuses are merged; the volumes sum to the parent', () => {
    const parent: Shape = { kind: 'cylinder', halfHeight: 0.7, r: 0.05, sides: 8 };
    const V = shapeVolume(parent);
    const [a, b] = crossCut(parent, 0.2);
    const flat: Shape = { kind: 'hull', points: [0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0.1, 0, 0.1] };
    const needle: Shape = { kind: 'hull', points: cylinderPoints({ halfHeight: 4, r: 0.001, sides: 8 }) };
    expect(shapeVolume(flat)).toBe(0);
    expect(rapierHullOk(needle)).toBe(false);
    const out = settlePieces(parent, [a, { shape: flat, offset: { x: 0, y: 0.7, z: 0 } }, b, { shape: needle, offset: { x: 0, y: -0.7, z: 0 } }]);
    expect(out.length).toBe(2);
    for (const pc of out) {
      expect(rapierHullOk(pc.shape)).toBe(true);
      expect(shapeVolume(pc.shape)).toBeGreaterThanOrEqual(BREAK_TUNING.pieceMinVolumeM3);
    }
    // The volumes (so the masses) sum to the parent's, whatever the cut pieces summed to.
    expect(out.reduce((s, pc) => s + shapeVolume(pc.shape), 0)).toBeCloseTo(V, 12);
    // Nothing usable: the parent whole.
    expect(settlePieces(parent, [{ shape: flat, offset: { x: 0, y: 0, z: 0 } }])).toEqual([{ shape: parent, offset: { x: 0, y: 0, z: 0 } }]);
  });

  it('a piece under pieceMinVolumeM3 is merged into its neighbour: one piece, the whole mass', async () => {
    const w = await make(202);
    const id = spawnLog(w, { p: { x: 0, y: 0.3, z: 3 }, length: 3, r: 0.15 });
    w.step();
    const e = w.entities.get(id)!;
    const mass = e.mass;
    BREAK_TUNING.pieceMinVolumeM3 = 1e-3;
    // 1 mm from the end: the end piece holds ≈ 6e-5 m³, far under the minimum.
    w.breaking.loadBreak(e, { x: e.pose.p.x + 1.5 - 0.001, y: e.pose.p.y, z: e.pose.p.z }, null);
    expect(() => w.step()).not.toThrow();
    const brk = breakOf(w, id);
    expect(brk!.pieces.length).toBe(1);
    expect(massOf(w, brk!.pieces)).toBeCloseTo(mass, 6);
  });

  /** The stone axe (handle lashed to the flint head): the handle, its lash joint, and the store's create made to fail. */
  async function axeWithFailingCreate(fail: () => Error): Promise<{ w: World; stick: number; joint: number }> {
    const w = await make(202);
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 3 });
    run(w, 5);
    const create = w.entities.create.bind(w.entities);
    let calls = 0;
    vi.spyOn(w.entities, 'create').mockImplementation((spec, credit) => {
      if (++calls === 2) throw fail();
      return create(spec, credit);
    });
    return { w, stick: axe.stick, joint: axe.joint };
  }

  it('a piece Rapier fails to make is no exception out of World.step: the parent is kept as it was, and breakFailed says so', async () => {
    const { w, stick, joint } = await axeWithFailingCreate(() => new Error('expected instance of p'));
    const e = w.entities.get(stick)!;
    const shape = e.shape;
    const before = w.entities.all().map((x) => x.id);
    w.breaking.hit(e, 5 * breakEnergyJ(MATERIALS[e.material], e.mass), e.pose.p, null);
    expect(() => w.step()).not.toThrow();
    vi.restoreAllMocks();
    // The same entity, whole, its lashing still on; no stray piece, and no break, spawn or remove event for it.
    expect(w.entities.get(stick)).toBe(e);
    expect(e.shape).toBe(shape);
    expect(e.integrity).toBe(1);
    expect(w.joints.get(joint)).toBeDefined();
    expect(e.joints).toContain(joint);
    expect(w.entities.all().map((x) => x.id)).toEqual(before);
    expect(breakOf(w, stick)).toBeNull();
    expect(w.events.some((x) => x.type === 'spawn' || x.type === 'remove')).toBe(false);
    expect(w.events).toContainEqual({ type: 'breakFailed', entity: stick, stage: 'pieces', kept: true, error: 'expected instance of p' });
    expect(() => run(w, 30)).not.toThrow();
  });

  it('any other error in a break is a bug: it is rethrown, never swallowed', async () => {
    const { w, stick } = await axeWithFailingCreate(() => new TypeError('a bug'));
    const e = w.entities.get(stick)!;
    w.breaking.hit(e, 5 * breakEnergyJ(MATERIALS[e.material], e.mass), e.pose.p, null);
    expect(() => w.step()).toThrow('a bug');
    expect(isRapierError(new TypeError('a bug'))).toBe(false);
    expect(isRapierError(new Error('expected instance of RawShape'))).toBe(true);
  });

  it('a split that succeeds keeps the event order it always had: joint events, remove, the spawns, break', async () => {
    const w = await make(202);
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 3 });
    run(w, 5);
    const e = w.entities.get(axe.stick)!;
    w.breaking.hit(e, 5 * breakEnergyJ(MATERIALS[e.material], e.mass), e.pose.p, null);
    w.step();
    const brk = breakOf(w, axe.stick)!;
    const kinds = w.events.filter((x) => (x.type === 'joint' && x.joint === axe.joint) || (x.type === 'remove' && x.entity === axe.stick) || (x.type === 'spawn' && brk.pieces.includes(x.entity)) || x === brk).map((x) => x.type);
    expect(kinds).toEqual(['joint', 'remove', ...brk.pieces.map(() => 'spawn'), 'break']);
  });
});
