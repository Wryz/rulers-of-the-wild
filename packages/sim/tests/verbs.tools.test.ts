// Tools from properties (docs/M1-DESIGN.md §5.0, §5.2; package P14): the held object (an entity plus what is lashed to
// it), its tool class from mass, length, aspect and sharp points alone (rule 1: no recipe), the WeaponDef synthesised
// from it with the head's sharpness in its numbers (RR-13), the starter axe's fresh chop (339 J, so 15 chops fell a
// 30 cm trunk, SPEC:882), and the §5.0 predicates.
//
// The joint store is P10's (a stub until then): lashings are made through a stand-in that keeps real JointRecords and
// lists them on their entities, which is all the held object reads.
//
// Scene numbers (lengths, masses, positions) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DAMAGE_TUNING } from '../src/sim/rules';
import { WEAPON_MOVES } from '../src/sim/weapons';
import { resetTuning } from '../src/tuning/registry';
import { prismRForMass, spawnRopeCoil, spawnStarterAxe, spawnStick, spawnStone, spawnTree, stoneHull } from '../src/world/factory';
import { FELL_TUNING } from '../src/world/felling';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import { principalAxis } from '../src/world/shapes';
import type { Anchor, JointRecord, V3 } from '../src/world/types';
import {
  canCut,
  canShape,
  classifyHeld,
  entityAspect,
  freshChopEnergy,
  heldMembers,
  heldShape,
  isRooted,
  synthWeapon,
  toolClass,
  toolDigs,
  toolEdge,
  verbGeom,
} from '../src/world/verbs/tools';
import { TOOL_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 60_000 });

const live: World[] = [];
async function make(): Promise<World> {
  const w = await createWorld({ seed: 11, scene: 'empty', nav: 'off', player: false, size: 50 });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('TOOL_TUNING');
  resetTuning('VERB_TUNING');
  vi.restoreAllMocks();
});

/** A stand-in for P10's joint store: real JointRecords for `lash` and `rope`, listed on their entities (sorted). */
function standInJoints(w: World): Map<number, JointRecord> {
  const recs = new Map<number, JointRecord>();
  const make = (kind: JointRecord['kind'], a: Anchor, b: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): number => {
    const id = w.ids.joint.take();
    recs.set(id, { id, kind, a, b, rope, breakEnergyJ: Infinity, axis: null, limits: null, motor: null, holdsBend: null, tension: [0, 0, 0], pullN: 0, credit });
    for (const end of [a, b]) {
      const e = end.entity === null ? undefined : w.entities.get(end.entity);
      if (e) e.joints = [...e.joints, id].sort((x, y) => x - y);
    }
    return id;
  };
  vi.spyOn(w.joints, 'get').mockImplementation((id) => recs.get(id));
  vi.spyOn(w.joints, 'all').mockImplementation(() => [...recs.values()].sort((x, y) => x.id - y.id));
  vi.spyOn(w.joints, 'lash').mockImplementation((a, b, rope, credit) => make('lash', a, b, rope, credit));
  vi.spyOn(w.joints, 'rope').mockImplementation((a, b, _len, rope, credit) => make('rope', a, b, rope, credit));
  return recs;
}

const ID_Q = { x: 0, y: 0, z: 0, w: 1 };

/**
 * A knapped flint: a factory stone hull of flint (prototype 1, the longest: a 0.6 kg one is 0.14 m, over
 * TOOL_TUNING.toolMinLenM) with an edge at the end of its long axis, pointing out along it (§5.4).
 */
function flint(w: World, p: V3, massKg: number, sharpness: number): number {
  const shape = stoneHull(massKg, 1, 'flint');
  const ax = principalAxis(shape);
  return w.entities.create({
    material: 'flint',
    shape,
    p,
    q: ID_Q,
    sharpPoints: [{ local: { x: ax.max, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, sharpness }],
    look: 'flint',
  }).id;
}

/** A dry stick along +x (the factory's lying rotation) with a flint lashed to its +x end, its long axis along the stick. */
function flintSpear(w: World, length: number, r: number): { stick: number; head: number } {
  const stick = spawnStick(w, { p: { x: 0, y: 0.3, z: 0 }, length, r });
  const head = flint(w, { x: length / 2 + 0.02, y: 0.3, z: 0 }, 0.2, 1);
  const coil = spawnRopeCoil(w, { at: { x: 0, y: 0, z: 2 }, material: 'vine', lengthM: 1 });
  w.joints.lash({ entity: stick, local: { x: 0, y: length / 2, z: 0 } }, { entity: head, local: { x: -0.02, y: 0, z: 0 } }, { entity: coil, lengthM: 1 }, []);
  return { stick, head };
}

/** A dry stick of `length` sharpened at +y (§5.4's taper), whose mass is `massKg` within a gram. */
function woodSpear(w: World, length: number, massKg: number, s: number): number {
  let r = prismRForMass(massKg, length, 550, PHYSICS_TUNING.cylinderFacets);
  for (let i = 0; i < 6; i++) {
    const id = spawnStick(w, { p: { x: 0, y: 0.3, z: 5 }, length, r, sharp: { end: 1, s } });
    const m = w.entities.get(id)!.mass;
    if (Math.abs(m - massKg) < 1e-3) return id;
    w.removeEntity(id);
    r *= Math.sqrt(massKg / m);
  }
  throw new Error('woodSpear: no radius for that mass');
}

describe('tool classes from properties (§5.2)', () => {
  it('a sharpened 1.5 m stick is a sharpStick that digs, its light technique the thrust and its committed one the overhead (RR-9)', async () => {
    const w = await make();
    const id = spawnStick(w, { p: { x: 0, y: 0.3, z: 0 }, length: 1.5, r: 0.025, sharp: { end: 1, s: 0.6 } });
    expect(toolClass(w, id)).toBe('sharpStick');
    expect(toolDigs(w, id)).toBe(true);
    const wpn = synthWeapon(w, id, 'sharpStick');
    expect(wpn.light).toBe('thrust');
    expect(wpn.heavy).toBe('overhead');
    expect(wpn.edge).toBe('blade');
    expect(wpn.style).toBe('twoHand');
    // The head is the point (at the +y end, leading out of it), the grip the other end.
    const h = heldShape(w, id);
    expect(h.head?.kind).toBe('point');
    expect(h.axis.y).toBeCloseTo(1, 12);
    expect(h.grip.y).toBeCloseTo(-0.75, 12);
    // The same stick blunt is a stick: no point, no digging, no thrust.
    const blunt = spawnStick(w, { p: { x: 0, y: 0.3, z: 2 }, length: 1.5, r: 0.025 });
    expect(toolClass(w, blunt)).toBe('stick');
    expect(toolDigs(w, blunt)).toBe(false);
    expect(synthWeapon(w, blunt, 'stick').light).toBe('sweep');
  });

  it('a flint lashed across a stick’s end is a stoneAxe; along a 1.8 m stick, a spear; a knapped flint alone, a flintBlade', async () => {
    const w = await make();
    standInJoints(w);
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 0 });
    expect(heldMembers(w, axe.stick)).toEqual([axe.stick, axe.head]);
    expect(toolClass(w, axe.stick)).toBe('stoneAxe');
    // The same held object seen from its other member.
    expect(toolClass(w, axe.head)).toBe('stoneAxe');
    expect(toolEdge(w, axe.stick)?.hardness).toBe(0.95);
    expect(toolDigs(w, axe.stick)).toBe(false);

    const spear = flintSpear(w, 1.8, 0.02);
    expect(heldShape(w, spear.stick).head?.kind).toBe('point');
    expect(toolClass(w, spear.stick)).toBe('spear');
    expect(toolDigs(w, spear.stick)).toBe(false);
    expect(synthWeapon(w, spear.stick, 'spear').light).toBe('thrust');
    expect(synthWeapon(w, spear.stick, 'spear').heavy).toBe('thrust');

    const blade = flint(w, { x: 3, y: 0.3, z: 3 }, 0.6, 1);
    expect(toolClass(w, blade)).toBe('flintBlade');
    // An unknapped flint nodule is a throwing stone.
    const nodule = spawnStone(w, { p: { x: 4, y: 0.3, z: 3 }, mass: 0.6, proto: 1, material: 'flint' });
    expect(toolClass(w, nodule)).toBe('stone');
  });

  it('a long handle with an edge at its end is a longAxe, and it digs', async () => {
    const w = await make();
    standInJoints(w);
    const stick = spawnStick(w, { p: { x: 0, y: 0.3, z: 0 }, length: 1.3, r: 0.025, material: 'greenWood' });
    const head = w.entities.create({
      material: 'flint',
      shape: stoneHull(0.6, 0, 'flint'),
      p: { x: 0.68, y: 0.3, z: 0 },
      // The flint's long axis across the handle (world z): its edge points across, not along.
      q: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
      sharpPoints: [{ local: { x: principalAxis(stoneHull(0.6, 0, 'flint')).max, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, sharpness: 0.9 }],
      look: 'flint',
    }).id;
    w.joints.lash({ entity: stick, local: { x: 0, y: 0.65, z: 0 } }, { entity: head, local: { x: 0, y: 0, z: 0 } }, { entity: 0, lengthM: 1 }, []);
    expect(heldShape(w, stick).head?.kind).toBe('edge');
    expect(toolClass(w, stick)).toBe('longAxe');
    expect(toolDigs(w, stick)).toBe(true);
  });

  it('a 3 kg stone is a stone, a heavier one and a 7 kg branch are no tools, and neither is a rope coil', async () => {
    const w = await make();
    const stone = spawnStone(w, { p: { x: 0, y: 0.3, z: 0 }, mass: 3 });
    expect(toolClass(w, stone)).toBe('stone');
    const big = spawnStone(w, { p: { x: 2, y: 0.3, z: 0 }, mass: 3.5 });
    expect(toolClass(w, big)).toBeNull();
    const branch = spawnStick(w, { p: { x: 0, y: 0.3, z: 3 }, length: 2, r: prismRForMass(7, 2, 550, PHYSICS_TUNING.cylinderFacets) });
    expect(w.entities.get(branch)!.mass).toBeCloseTo(7, 9);
    expect(toolClass(w, branch)).toBeNull();
    const club = spawnStick(w, { p: { x: 0, y: 0.3, z: 6 }, length: 1, r: prismRForMass(2, 1, 550, PHYSICS_TUNING.cylinderFacets) });
    expect(toolClass(w, club)).toBe('cudgel');
    const coil = spawnRopeCoil(w, { at: { x: 5, y: 0, z: 5 }, material: 'vine', lengthM: 20 });
    expect(toolClass(w, coil)).toBeNull();
    // A trunk is no tool either (too heavy, too long).
    const tree = spawnTree(w, { at: { x: -5, z: -5 }, diameter: 0.3, height: 15 }).tree;
    expect(toolClass(w, tree)).toBeNull();
    expect(isRooted(w.entities.get(tree)!)).toBe(true);
  });

  it('reads properties only: the class and the weapon are unchanged when only `look` changes (rule 1, AC-1)', async () => {
    const w = await make();
    standInJoints(w);
    const ids = [
      spawnStick(w, { p: { x: 0, y: 0.3, z: 0 }, length: 1.5, r: 0.025, sharp: { end: 1, s: 0.6 } }),
      spawnStarterAxe(w, { x: 3, y: 0, z: 0 }).stick,
      flintSpear(w, 1.8, 0.02).stick,
      flint(w, { x: 0, y: 0.3, z: 6 }, 0.6, 1),
      spawnStone(w, { p: { x: 3, y: 0.3, z: 6 }, mass: 2 }),
    ];
    for (const id of ids) {
      const cls = toolClass(w, id)!;
      const before = synthWeapon(w, id, cls);
      for (const m of heldMembers(w, id)) w.entities.get(m)!.look = 'anything at all';
      expect(toolClass(w, id)).toBe(cls);
      expect(synthWeapon(w, id, cls)).toEqual(before);
    }
  });

  it('classifies a held object by its geometry alone (classifyHeld on hand-made shapes)', () => {
    const base = {
      members: [1],
      axis: { x: 0, y: 1, z: 0 },
      grip: { x: 0, y: -0.5, z: 0 },
      sharpPoints: [],
      centre: { x: 0, y: 0, z: 0 },
      com: { x: 0, y: 0, z: 0 },
      crossHalfM: 0.03,
      head: null,
    };
    const edge = { local: { x: 0, y: 0.5, z: 0 }, dir: { x: 0, y: 0, z: 1 }, sharpness: 0.9, entity: 1, hardness: 0.95, kind: 'edge' as const, end: 1 as const };
    const point = { ...edge, dir: { x: 0, y: 1, z: 0 }, kind: 'point' as const };
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 1.0, aspect: 20, head: edge })).toBe('stoneAxe');
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 1.1, aspect: 20, head: edge })).toBe('longAxe');
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 1.59, aspect: 20, head: point })).toBe('sharpStick');
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 1.6, aspect: 20, head: point })).toBe('spear');
    expect(classifyHeld({ ...base, massKg: 1.49, lengthM: 1, aspect: 20 })).toBe('stick');
    expect(classifyHeld({ ...base, massKg: 1.5, lengthM: 1, aspect: 20 })).toBe('cudgel');
    expect(classifyHeld({ ...base, massKg: 6, lengthM: 1, aspect: 20 })).toBe('cudgel');
    expect(classifyHeld({ ...base, massKg: 6.01, lengthM: 1, aspect: 20 })).toBeNull();
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 2.61, aspect: 20 })).toBeNull();
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 0.11, aspect: 1 })).toBeNull();
    // Neither elongated nor compact: no tool.
    expect(classifyHeld({ ...base, massKg: 1, lengthM: 0.4, aspect: 3 })).toBeNull();
    expect(classifyHeld({ ...base, massKg: 0.3, lengthM: 0.15, aspect: 1.5, head: { ...edge, end: 0 } })).toBe('flintBlade');
    expect(classifyHeld({ ...base, massKg: 3, lengthM: 0.2, aspect: 1.5 })).toBe('stone');
    expect(classifyHeld({ ...base, massKg: 3.01, lengthM: 0.2, aspect: 1.5 })).toBeNull();
  });
});

describe('the synthesised weapon (§5.2)', () => {
  it('a flint-tipped spear hits 1.43× as hard as a dry-wood point of the same mass (the head’s material in damageMul, RR-13)', async () => {
    const w = await make();
    standInJoints(w);
    const flinted = flintSpear(w, 1.8, 0.02).stick;
    const mass = heldShape(w, flinted).massKg;
    const wooden = woodSpear(w, 1.8, mass, 0.6);
    expect(heldShape(w, wooden).massKg).toBeCloseTo(mass, 2);
    expect(toolClass(w, wooden)).toBe('spear');
    const a = synthWeapon(w, flinted, 'spear');
    const b = synthWeapon(w, wooden, 'spear');
    expect(a.sharpness).toBe(1);
    expect(b.sharpness).toBe(0.6);
    // (1 + kS·1.0) / (1 + kS·0.6) with kS 3: 4 / 2.8.
    const k = DAMAGE_TUNING.kS;
    expect(a.damageMul / b.damageMul).toBeCloseTo((1 + k) / (1 + 0.6 * k), 12);
    expect(a.damageMul / b.damageMul).toBeCloseTo(1.43, 2);
    // The wood point is the class's reference sharpness: the template's numbers exactly.
    expect(b.damageMul).toBeCloseTo(TOOL_TUNING.spear.damageMul, 12);
    expect(b.cut).toBeCloseTo(TOOL_TUNING.spear.cut, 12);
    expect(b.bite).toBeCloseTo(TOOL_TUNING.spear.bite, 12);
    expect(a.cut).toBe(1);
    expect(a.bite).toBeCloseTo((TOOL_TUNING.spear.bite * 1) / 0.6, 12);
    // Everything else is the same object's.
    expect(a.mass).toBeCloseTo(b.mass, 2);
    expect(a.length).toBeCloseTo(b.length, 12);
  });

  it('the starter axe: 0.47 m, 1.153 kg (the lashing’s rope is no member), its edge 0.9, and a fresh chop of 339 J (SPEC:882)', async () => {
    const w = await make();
    standInJoints(w);
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 0 });
    const h = heldShape(w, axe.stick);
    expect(h.members).toEqual([axe.stick, axe.head]);
    expect(h.massKg).toBeCloseTo(1.153, 3);
    expect(h.lengthM).toBeCloseTo(0.55, 12);
    // The head (the flint's edge) is past the handle's +y end; the grip is the other end.
    expect(h.axis.y).toBeCloseTo(1, 9);
    expect(h.grip.y).toBeCloseTo(-0.275, 9);
    const wpn = synthWeapon(w, axe.stick, 'stoneAxe');
    const t = TOOL_TUNING;
    expect(wpn.id).toBe('stoneAxe');
    expect(wpn.length).toBeCloseTo(0.55 - t.lengthTrimM, 12);
    expect(wpn.strikeFrom).toBeCloseTo(wpn.length * (1 - t.edgeHeadFrac), 12);
    expect(wpn.mass).toBeCloseTo(h.massKg, 12);
    expect(wpn.sharpness).toBe(0.9);
    expect(wpn.edge).toBe('blade');
    expect(wpn.damageMul).toBeCloseTo(t.stoneAxe.damageMul, 12);
    expect(wpn.cut).toBeCloseTo(t.stoneAxe.cut, 12);
    expect(wpn.bite).toBeCloseTo(t.stoneAxe.bite, 12);
    expect([wpn.cleave, wpn.tempo, wpn.choke]).toEqual([t.stoneAxe.cleave, t.stoneAxe.tempo, t.stoneAxe.choke]);
    expect(wpn.radius).toBeGreaterThanOrEqual(t.radiusMinM);
    expect(wpn.radius).toBeLessThanOrEqual(t.radiusMaxM);
    expect([wpn.light, wpn.heavy]).toEqual(['slash', 'chop']);

    const E = freshChopEnergy(w, axe.stick);
    console.info(`starter axe fresh chop: ${E.toFixed(2)} J`);
    // 12 (chop) × 1.2 × (1 + 0.7 × 1.153/2.6) × 18 J.
    const heavy = Math.min(1, h.massKg / 2.6);
    expect(E).toBeCloseTo(WEAPON_MOVES.chop.damage * 1.2 * (1 + 0.7 * heavy) * DAMAGE_TUNING.meleeJPerDmg, 9);
    expect(Math.abs(E - FELL_TUNING.refChopJ)).toBeLessThan(1);
    // Each chop is 0.0200 m (§5.2's depth rule), so a 30 cm trunk takes 15.
    const depth = FELL_TUNING.chopDepthM * Math.min(FELL_TUNING.chopScaleMax, Math.max(FELL_TUNING.chopScaleMin, E / FELL_TUNING.refChopJ));
    expect(depth.toFixed(4)).toBe('0.0200');
    expect(Math.ceil(0.3 / depth - 1e-9)).toBe(15);
    // No tool, no chop.
    expect(freshChopEnergy(w, spawnStone(w, { p: { x: 5, y: 0.3, z: 5 }, mass: 20 }))).toBe(0);
  });

  it('a blunt class keeps its template’s proportions and the class’s numbers unscaled', async () => {
    const w = await make();
    const id = spawnStick(w, { p: { x: 0, y: 0.3, z: 0 }, length: 1, r: prismRForMass(2, 1, 550, PHYSICS_TUNING.cylinderFacets) });
    const wpn = synthWeapon(w, id, 'cudgel');
    expect(wpn.edge).toBe('blunt');
    expect(wpn.sharpness).toBe(0);
    expect(wpn.damageMul).toBe(TOOL_TUNING.cudgel.damageMul);
    expect(wpn.strikeFrom / wpn.length).toBeCloseTo(0.3 / 0.88, 12);
    expect(wpn.mass).toBeCloseTo(2, 9);
  });
});

describe('property predicates (§5.0)', () => {
  it('a flint edge cuts wood, bone, hide and rope but not stone; a stone knaps flint and wood can’t', async () => {
    const w = await make();
    standInJoints(w);
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 0 }).stick;
    const dry = spawnStick(w, { p: { x: 0, y: 0.3, z: 3 }, length: 1, r: 0.02 });
    const rock = spawnStone(w, { p: { x: 3, y: 0.3, z: 3 }, mass: 2 });
    const vine = spawnRopeCoil(w, { at: { x: 5, y: 0, z: 0 }, material: 'vine', lengthM: 2 });
    const bone = spawnStick(w, { p: { x: 0, y: 0.3, z: 6 }, length: 0.5, r: 0.02, material: 'bone' });
    const hide = spawnStick(w, { p: { x: 3, y: 0.3, z: 6 }, length: 0.5, r: 0.02, material: 'hide' });
    const nodule = spawnStone(w, { p: { x: -3, y: 0.3, z: 0 }, mass: 0.4, material: 'flint' });
    expect(canCut(w, axe, dry)).toBe(true);
    expect(canCut(w, axe, bone)).toBe(true);
    expect(canCut(w, axe, hide)).toBe(true);
    expect(canCut(w, axe, vine)).toBe(true);
    expect(canCut(w, axe, rock)).toBe(false);
    // No edge, no cut.
    expect(canCut(w, dry, vine)).toBe(false);
    expect(canShape(w, rock, nodule)).toBe(true);
    expect(canShape(w, dry, nodule)).toBe(false);
    expect(canShape(w, axe, dry)).toBe(true);
  });

  it('elongated and compact by aspect', async () => {
    const w = await make();
    const stick = w.entities.get(spawnStick(w, { p: { x: 0, y: 0.3, z: 0 }, length: 1, r: 0.02 }))!;
    const stone = w.entities.get(spawnStone(w, { p: { x: 2, y: 0.3, z: 0 }, mass: 1 }))!;
    expect(entityAspect(stick)).toBeGreaterThanOrEqual(TOOL_TUNING.minAspect);
    expect(entityAspect(stone)).toBeLessThan(TOOL_TUNING.compactMaxAspect);
  });

  it('heldShape is in the held entity’s frame: the same axe seen from the flint points its axis at the edge', async () => {
    const w = await make();
    standInJoints(w);
    const axe = spawnStarterAxe(w, { x: 0, y: 0, z: 0 });
    const fromStick = heldShape(w, axe.stick);
    const fromHead = heldShape(w, axe.head);
    const stick = w.entities.get(axe.stick)!;
    const head = w.entities.get(axe.head)!;
    const g1 = verbGeom.pointToWorld(stick.pose, fromStick.grip);
    const g2 = verbGeom.pointToWorld(head.pose, fromHead.grip);
    expect(verbGeom.len(verbGeom.sub(g1, g2))).toBeLessThan(1e-6);
    const a1 = verbGeom.dirToWorld(stick.pose, fromStick.axis);
    const a2 = verbGeom.dirToWorld(head.pose, fromHead.axis);
    expect(verbGeom.dot(a1, a2)).toBeCloseTo(1, 6);
    expect(fromStick.massKg).toBeCloseTo(fromHead.massKg, 12);
  });
});
