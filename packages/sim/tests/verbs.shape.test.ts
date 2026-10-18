// Shape and knap (docs/M1-DESIGN.md §5.4; package P16), headless, through commands: strokes until the end is at its
// material's max sharpness (a dry stick 0.6 in 6 strokes, then it stops), the first stroke tapering the end to a pointed
// hull (0.25 m on a 5 cm stake, 0.65 kg of wood) with the SharpPoint at its tip (RF-18); the design's leading test on the
// C lab's stake-and-shin contact geometry gives the lab's sharpness; a stone knaps flint to 1.0 in 7 strokes (a flint
// blade by its properties alone) and wood can't knap it; a 300 kg log sharpened where it lies; rotten wood useless by its
// own max sharpness; the refusals, `charge: 0` and moving stop the strokes; the noise bus hears each stroke.
//
// Scene numbers (masses, lengths, positions, tick counts, the lab's approach speeds) are test constants, never tuning (§9).
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveCommand, toCm, type VerbCommand } from '../src/sim/commands';
import { DAMAGE_TUNING } from '../src/sim/rules';
import { resetTuning } from '../src/tuning/registry';
import { NOISE_TUNING } from '../src/world/creatures/defs';
import { leadingSharpness } from '../src/world/damage';
import { spawnLog, spawnRopeCoil, spawnStick, spawnStone, spawnTree } from '../src/world/factory';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import { principalAxis, shapeVolume } from '../src/world/shapes';
import type { Entity, Quat, V3, WorldEvent } from '../src/world/types';
import { nearestEnd } from '../src/world/verbs/shape';
import { toolClass, verbGeom } from '../src/world/verbs/tools';
import { TOOL_TUNING, VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 180_000 });

const live: World[] = [];
async function make(seed = 71): Promise<World> {
  const w = await createWorld({ seed, scene: 'empty', nav: 'off', size: 60 });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('VERB_TUNING');
  resetTuning('ROPE_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type VerbEvent = Extract<WorldEvent, { type: 'verb' }>;

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): VerbCommand {
  const c = { tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand;
  w.commands.push(c);
  return c;
}

/** n ticks (calling `each` before every step); the world events, copied. */
function run(w: World, n: number, each?: (t: number) => void): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < n; t++) {
    each?.(t);
    out.push(...w.step().world);
  }
  return out;
}

/** Steps until the shaping is over (the continuous verb off, the player free); the world events, copied. */
function untilDone(w: World, max = 1500): WorldEvent[] {
  const out: WorldEvent[] = [];
  const p = w.player!;
  for (let t = 0; t < max; t++) {
    out.push(...w.step().world);
    if (t > 0 && p.free && !p.verbRequest && w.verbs.continuousOf(p) === null) return out;
  }
  throw new Error(`the shaping did not end within ${max} ticks`);
}

const strokes = (evs: WorldEvent[]): VerbEvent[] => evs.filter((e): e is VerbEvent => e.type === 'verb' && e.verb === 'shape');
const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

const UPRIGHT: Quat = { x: 0, y: 0, z: 0, w: 1 };

/** Into the player's hands at once (wielded, carried). */
function hold(w: World, id: number): void {
  expect(w.verbs.putInHands(w.player!, id)).toBe(true);
}

/** A 1 kg stone to shape with, out of the way, in the hands. */
function holdStone(w: World): number {
  const id = spawnStone(w, { p: { x: 20, y: 0.2, z: 20 }, mass: 1 });
  hold(w, id);
  return id;
}

/** A dry stick r × length lying along x on the ground at (x, z). */
function stick(w: World, length: number, r: number, x: number, z: number, material?: 'dryWood' | 'rottenWood'): number {
  return spawnStick(w, { p: { x, y: r + 0.005, z }, length, r, material });
}

/** The world point of an entity's +y end centre (a stick's +x end lying, its top upright). */
const plusEnd = (e: Entity): V3 => verbGeom.pointToWorld(e.pose, { x: 0, y: principalAxis(e.shape).max, z: 0 });

/** The sharp point at an entity's + end of its long axis (local +y for a prism, +x for a stone), or undefined. */
const pointAt = (e: Entity) => {
  const ax = principalAxis(e.shape);
  return e.sharpPoints.find((sp) => verbGeom.dot(sp.local, ax.dir) > 0 && verbGeom.dot(sp.dir, ax.dir) > 0.9);
};

// ---------------------------------------------------------------------------
// Shape (§5.4)
// ---------------------------------------------------------------------------

describe('shape (§5.4): strokes to the material’s max sharpness, the end tapered to a point', () => {
  it('a dry 1.4 m × 5 cm stick reaches 0.6 in 6 strokes and stops; its end a pointed hull (0.25 m taper) with the SharpPoint at the tip', async () => {
    const w = await make();
    const p = w.player!;
    holdStone(w);
    expect(p.weapon?.id).toBe('stone');
    const s = stick(w, 1.4, 0.05, 0, 1.2);
    run(w, 2);
    const e0 = ent(w, s);
    const m0 = e0.mass;
    expect(e0.shape.kind).toBe('cylinder');
    verb(w, { verb: 'shape', target: s, at: toCm(plusEnd(e0)), charge: 1 });
    // The first stroke: the end pulled to a tip over pointTaperRadii × r, a SharpPoint of 0.1 at it.
    let first: WorldEvent[] = [];
    for (let t = 0; t < 200 && strokes(first).length === 0; t++) first = first.concat(w.step().world);
    expect(strokes(first)).toEqual([expect.objectContaining({ ok: true, entity: s })]);
    const e = ent(w, s);
    if (e.shape.kind !== 'hull') throw new Error(`a ${e.shape.kind}, not a pointed hull`);
    const pts = e.shape.points;
    const verts: V3[] = [];
    for (let i = 0; i < pts.length; i += 3) verts.push({ x: pts[i], y: pts[i + 1], z: pts[i + 2] });
    // One tip vertex on the axis at the old end; the full 8-gon ring 0.25 m back from it; the other end untouched.
    const top = verts.filter((v) => v.y > 0.7 - 1e-6);
    expect(top).toHaveLength(1);
    expect(Math.hypot(top[0].x, top[0].z)).toBeLessThan(1e-6);
    const taper = TOOL_TUNING.pointTaperRadii * 0.05;
    expect(taper).toBeCloseTo(0.25, 9);
    const ring = verts.filter((v) => Math.abs(v.y - (0.7 - taper)) < 1e-6);
    expect(ring).toHaveLength(8);
    for (const v of ring) expect(Math.hypot(v.x, v.z)).toBeCloseTo(0.05, 6);
    expect(verts.filter((v) => Math.abs(v.y + 0.7) < 1e-6)).toHaveLength(8);
    // Mass is density × the new volume: 0.65 kg of a 5.44 kg stake gone (12 %).
    expect(m0).toBeCloseTo(5.44, 2);
    expect(m0 - e.mass).toBeCloseTo(0.648, 2);
    expect(e.mass).toBeCloseTo(MATERIALS.dryWood.density * shapeVolume(e.shape), 6);
    expect(e.sharpPoints).toHaveLength(1);
    expect(e.sharpPoints[0]).toEqual({ local: top[0], dir: { x: 0, y: 1, z: 0 }, sharpness: VERB_TUNING.shapeStep });
    expect(e.credit).toContain('p1');
    // On to dry wood's 0.6, six strokes in all, then it stops by itself.
    const rest = untilDone(w);
    expect(strokes(rest)).toHaveLength(5);
    expect(strokes(rest).every((x) => x.ok)).toBe(true);
    expect(ent(w, s).sharpPoints).toHaveLength(1);
    expect(ent(w, s).sharpPoints[0].sharpness).toBeCloseTo(MATERIALS.dryWood.maxSharpness, 9);
    expect(ent(w, s).shape).toEqual(e.shape);
    expect(strokes(run(w, 120))).toEqual([]);
    // A sharpened stick: a point at an end.
    w.verbs.letGo(p);
    expect(toolClass(w, s)).toBe('sharpStick');
  });

  it('the design’s leading test (tip 0.15 m, cos 0.7) on the C lab’s stake-and-shin geometry gives the lab’s sharpness (RF-18)', async () => {
    const w = await make();
    holdStone(w);
    // A 1.5 m stake shaped to dry wood's 0.6, then driven upright point-up (as the lab's: a pointed 8-gon hull, r 0.05).
    const s = stick(w, 1.5, 0.05, 0, 1.2);
    run(w, 2);
    verb(w, { verb: 'shape', target: s, at: toCm(plusEnd(ent(w, s))), charge: 1 });
    untilDone(w);
    const e = ent(w, s);
    expect(e.sharpPoints[0].sharpness).toBeCloseTo(0.6, 9);
    w.entities.setPose(e, { p: { x: 5, y: 0.75 - 0.4, z: 5 }, q: UPRIGHT });
    w.entities.anchor(e, 0.4);
    run(w, 1);
    const tip = verbGeom.pointToWorld(e.pose, e.sharpPoints[0].local);
    expect(tip.y).toBeCloseTo(1.1, 6);
    // The giant's shin (scale 5.5: a capsule r 0.47 m) coming down on the stake at the lab's approach speeds (v_n 2.28-3.98
    // m/s, falling with its forward speed), lying across the stake, its axis up to 0.2 m to the side of the tip.
    const shin = new RAPIER.Capsule(0.22 * 5.5, 0.085 * 5.5);
    const across = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    let n = 0;
    for (const side of [0, 0.1, 0.2]) {
      for (const [vx, vy] of [
        [0, 2.28],
        [1.5, 3.0],
        [2.0, 3.98],
      ]) {
        const c = { x: tip.x + side, y: tip.y + Math.sqrt(Math.max(0, shin.radius ** 2 - side * side)) + 0.002, z: tip.z };
        const hit = e.collider!.contactShape(shin, c, across, 0.05);
        expect(hit).not.toBeNull();
        const point = { x: hit!.point1.x, y: hit!.point1.y, z: hit!.point1.z };
        const v = { x: vx, y: -vy, z: 0 };
        // The lab's own test: contact within 0.25 m of the tip, the body moving onto it within 60° (e2_pit.ts).
        const lab = Math.hypot(point.x - tip.x, point.y - tip.y, point.z - tip.z) < 0.25 && vy / Math.hypot(vx, vy) > 0.5 ? MATERIALS.dryWood.maxSharpness : 0;
        expect(lab).toBe(0.6);
        expect(leadingSharpness(e.sharpPoints, e.pose, point, v), `side ${side}, v (${vx}, ${-vy})`).toBeCloseTo(lab, 9);
        n++;
      }
    }
    expect(n).toBe(9);
    expect(DAMAGE_TUNING.tipRadiusM).toBe(0.15);
    expect(DAMAGE_TUNING.leadingCos).toBe(0.7);
    // The other side of the rule: a shin swept into the stake's side 0.6 m below the tip, or one rising off it, gets no
    // point.
    const low = e.collider!.contactShape(shin, { x: tip.x + shin.radius + 0.05 + 0.002, y: tip.y - 0.6, z: tip.z }, UPRIGHT, 0.05);
    expect(low).not.toBeNull();
    expect(leadingSharpness(e.sharpPoints, e.pose, low!.point1, { x: -3, y: 0, z: 0 })).toBe(0);
    expect(leadingSharpness(e.sharpPoints, e.pose, tip, { x: 0, y: 2, z: 0 })).toBe(0);
  });

  it('a stone knaps flint to 1.0 in 7 strokes (an edge along its long axis: a flint blade); wood can’t knap it', async () => {
    const w = await make();
    const p = w.player!;
    const flint = spawnStone(w, { p: { x: 0, y: 0.1, z: 1.0 }, mass: 2, material: 'flint' });
    const wood = spawnStick(w, { p: { x: 20, y: 0.03, z: 22 }, length: 0.8, r: 0.02 });
    hold(w, wood);
    run(w, 30);
    expect(toolClass(w, flint)).toBe('stone');
    const at = toCm(verbGeom.pointToWorld(ent(w, flint).pose, { x: principalAxis(ent(w, flint).shape).max, y: 0, z: 0 }));
    // Wood (hardness 0.5) can't shape flint (0.95): it needs ≥ 0.85.
    verb(w, { verb: 'shape', target: flint, at, charge: 1 });
    expect(strokes(run(w, 1))).toEqual([expect.objectContaining({ ok: false, reason: 'tooHard' })]);
    w.verbs.letGo(p);
    holdStone(w);
    verb(w, { verb: 'shape', target: flint, at, charge: 1 });
    const ev = untilDone(w);
    expect(strokes(ev)).toHaveLength(7);
    const e = ent(w, flint);
    expect(e.shape.kind).toBe('hull');
    expect(e.sharpPoints).toHaveLength(1);
    const sp = e.sharpPoints[0];
    expect(sp.sharpness).toBe(MATERIALS.flint.maxSharpness);
    expect(sp.dir).toEqual({ x: 1, y: 0, z: 0 });
    expect(sp.local.x).toBeCloseTo(principalAxis(e.shape).max, 9);
    // Compact, so not tapered: the nodule keeps its mass. By its properties alone it is now a blade.
    expect(e.mass).toBeCloseTo(2, 6);
    expect(toolClass(w, flint)).toBe('flintBlade');
  });

  it('a 300 kg log is sharpened where it lies (SPEC:234); rotten wood stops at 0.1 and is no point', async () => {
    const w = await make();
    holdStone(w);
    const log = spawnLog(w, { p: { x: 0, y: 0.25, z: 1.8 }, length: 4, mass: 300 });
    run(w, 30);
    const L = ent(w, log);
    // On, and off again before the first stroke lands: that stroke (a committed work action) lands, and no other.
    verb(w, { verb: 'shape', target: log, at: toCm(plusEnd(L)), charge: 1 });
    run(w, 5);
    verb(w, { verb: 'shape', target: log, charge: 0 });
    const ev = run(w, 200);
    expect(strokes(ev)).toEqual([expect.objectContaining({ ok: true, entity: log })]);
    expect(ent(w, log).state).toBe('free');
    expect(pointAt(ent(w, log))?.sharpness).toBe(VERB_TUNING.shapeStep);
    expect(ent(w, log).shape.kind).toBe('hull');
    // Rotten wood: one stroke to its 0.1, then fully sharp; held, it is still a blunt stick (a point needs 0.3).
    const rotten = stick(w, 1.0, 0.03, 1.2, 0.9, 'rottenWood');
    run(w, 2);
    verb(w, { verb: 'shape', target: rotten, at: toCm(plusEnd(ent(w, rotten))), charge: 1 });
    expect(strokes(untilDone(w))).toHaveLength(1);
    expect(pointAt(ent(w, rotten))?.sharpness).toBe(MATERIALS.rottenWood.maxSharpness);
    verb(w, { verb: 'shape', target: rotten, at: toCm(plusEnd(ent(w, rotten))), charge: 1 });
    expect(strokes(run(w, 1))).toEqual([expect.objectContaining({ ok: false, reason: 'fullySharp' })]);
    w.verbs.letGo(w.player!);
    expect(toolClass(w, rotten)).toBe('stick');
  });

  it('`charge: 0` or moving stops the strokes; each stroke is heard (10 m); the end nearest `at` is the one shaped', async () => {
    const w = await make();
    const p = w.player!;
    holdStone(w);
    const s = stick(w, 1.4, 0.03, 0, 1.2);
    run(w, 2);
    const minus = verbGeom.pointToWorld(ent(w, s).pose, { x: 0, y: -0.7, z: 0 });
    expect(nearestEnd(ent(w, s), minus)).toBe(-1);
    verb(w, { verb: 'shape', target: s, at: toCm(minus), charge: 1 });
    // Two strokes, then the player walks off: the stroke under way lands (a work action is committed), and no more.
    let ev: WorldEvent[] = [];
    for (let t = 0; t < 400 && strokes(ev).length < 2; t++) ev = ev.concat(w.step().world);
    expect(strokes(ev)).toHaveLength(2);
    // Each stroke is heard where it was made: the noise bus turns its `verb` event into a 10 m `shape` noise.
    const heard = ev.filter((x): x is Extract<WorldEvent, { type: 'noise' }> => x.type === 'noise' && x.kind === 'shape');
    expect(heard).toHaveLength(2);
    for (const n of heard) expect(n.radius).toBe(NOISE_TUNING.shape);
    const walked = run(w, 90, () => w.commands.push(moveCommand(w.tick + 1, 1, 1, 0)));
    expect(strokes(walked).length).toBeLessThanOrEqual(1);
    expect(w.verbs.continuousOf(p)).toBeNull();
    expect(strokes(run(w, 90, () => w.commands.push(moveCommand(w.tick + 1, 1, 1, 0))))).toEqual([]);
    const done = 2 + strokes(walked).length;
    // The − end was shaped, and only it.
    const e = ent(w, s);
    expect(e.sharpPoints).toHaveLength(1);
    expect(e.sharpPoints[0].local.y).toBeLessThan(0);
    expect(e.sharpPoints[0].sharpness).toBeCloseTo(done * VERB_TUNING.shapeStep, 9);
    // On again, then `charge: 0`: the stroke under way lands, no more start.
    run(w, 30, () => w.commands.push(moveCommand(w.tick + 1, 1, 0, 0)));
    w.teleport(p, 0, 0.3, 0);
    run(w, 2);
    verb(w, { verb: 'shape', target: s, at: toCm(minus), charge: 1 });
    run(w, 5);
    verb(w, { verb: 'shape', target: s, charge: 0 });
    expect(strokes(run(w, 200)).length).toBeLessThanOrEqual(1);
    expect(w.verbs.continuousOf(p)).toBeNull();
  });

  it('refusals: a rope, empty hands, something the hands hold, a rooted tree, a tool too soft', async () => {
    const w = await make();
    const p = w.player!;
    const coil = spawnRopeCoil(w, { at: { x: 0, y: 0, z: 1.0 }, material: 'vine', lengthM: 5 });
    const s = stick(w, 1.0, 0.03, 0.8, 1.0);
    const { tree } = spawnTree(w, { at: { x: -1.2, z: 1.0 }, diameter: 0.3, height: 8 });
    const bone = spawnStone(w, { p: { x: 1.0, y: 0.1, z: 0.4 }, mass: 1, material: 'bone' });
    run(w, 2);
    const refused = (target: number, at: V3): string | undefined => {
      verb(w, { verb: 'shape', target, at: toCm(at), charge: 1 });
      const r = strokes(run(w, 1));
      expect(r).toHaveLength(1);
      expect(r[0].ok).toBe(false);
      return r[0].reason;
    };
    expect(refused(s, plusEnd(ent(w, s)))).toBe('handsEmpty');
    holdStone(w);
    expect(refused(coil, ent(w, coil).pose.p)).toBe('ropeLike');
    expect(refused(tree, { x: -1.05, y: 1.0, z: 1.0 })).toBe('immovable');
    w.verbs.letGo(p);
    hold(w, s);
    run(w, 1);
    expect(refused(s, plusEnd(ent(w, s)))).toBe('handsFull');
    // A wooden stick (0.5) shapes bone (0.7)? It needs ≥ 0.6: no.
    expect(refused(bone, ent(w, bone).pose.p)).toBe('tooHard');
    expect(ent(w, bone).sharpPoints).toEqual([]);
  });
});
