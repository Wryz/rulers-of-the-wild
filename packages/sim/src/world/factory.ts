// Entity-spec factories shared by generation, test scenes and dev spawns (docs/M1-DESIGN.md §6.7): trees with their
// hanging vines, saplings, rope coils, sticks (8-gon prisms), logs (6-gon prisms), stones and flint (hulls), boxes,
// grass bundles, the starter axe. Each factory makes ordinary entities through the entity store (rule 1: a factory
// knows trees, sticks, stones and rope, never what a player might build from them).
//
// Conventions:
// - `p` is the body origin (a prism's or box's centre, a stone's centre of mass); `at: V3` is the point the object rests
//   on (a coil and the axe are set down on a horizontal support at at.y); `at: XZ` roots a tree or sapling in the
//   terrain there. `groundRestY` gives the origin height at which a shape rests on the terrain.
// - `r` is a prism's circumradius (§2.2) and a tree's `diameter` its circum-diameter (§2.5): a 30 cm × 15 m green trunk
//   is 738 kg above the 0.5 m cut. §6.7's quoted masses of branches and logs were computed for round sections:
//   `prismRForRoundDiam` gives the prism with a round stick's cross-section, and `spawnLog` takes a mass instead of r.
// - Sticks and logs lie along world +x with a flat face down unless a rotation is given (`LYING_ALONG_X`); boxes,
//   grass, coils and stones keep the identity (a stone rests on a face, a coil lies flat). A rotation is the entity's
//   own (EntitySpec.q: the prism's axis is local +y).
// - Masses are always density × volume (SPEC:196): the store computes them from the shape.
// - `generated: true` marks what generateClearing makes (the save stores it only once touched, §8.3). The factory's own
//   creation steps (a joint added, a rope tied) are part of generation, so a generated entity leaves the factory
//   untouched.
// - Spawned things carry no credit (§11.0 RT-19: an entity only spawned has `credit: []`).
// - Rope entities have no body once tied (SPEC:265). A rope is made as a coil (`ropeCoilShape`, exported so the joint
//   store can coil a rope whose ends are both loose the same way, §2.4), handed to the joint store, and then tied.
//
// The joint store is P10's: `spawnTree` with a vine calls `joints.rope` and `spawnStarterAxe` calls `joints.lash`, which
// throw until P10 lands (the factory's side of both is tested with a stand-in joint store).
//
// Imports: CLEARING_TUNING (the snags' sharpness) comes from clearing.ts, which will import these factories (P21). The
// cycle is safe because neither module reads the other at load time; keep it that way.
//
// No randomness here: generation draws every choice from its own stream and passes the result in.
import { defineTuning } from '../tuning/registry';
import { CLEARING_TUNING } from './clearing';
import { isRopeLike, MATERIAL_IDS, MATERIALS } from './materials';
import { PHYSICS_TUNING } from './physics';
import { cylinderPoints, principalAxis, shapeVolume, taperEnd } from './shapes';
import type { Anchor, Entity, EntitySpec, Material, MaterialId, Quat, Shape, SharpPoint, V3 } from './types';
import { TOOL_TUNING, VERB_TUNING } from './verbs/tuning';
import type { World } from './world';

/** A point on the ground plane. */
export interface XZ {
  x: number;
  z: number;
}

/** What every factory also takes. */
export interface SpawnFlags {
  /** Made by generateClearing (EntitySpec.generated): saved only once touched (§8.3). Default false. */
  generated?: boolean;
}

/**
 * The factory's starting values. DEVIATION (P07): §13.0 adds no tuning table after P05, but P05 registered none for this
 * file and §9.1 has no row for these values, which the design gives only in prose (§6.7) or not at all; CLAUDE.md puts
 * every starting value in a live tuning table, so they live here (as P06's ENTITY_TUNING does).
 */
export const FACTORY_TUNING = defineTuning(
  'FACTORY_TUNING',
  'World › factory',
  {
    /** The material each kind of thing is made of when the caller doesn't say. */
    materials: {
      tree: 'greenWood' as MaterialId,
      sapling: 'greenWood' as MaterialId,
      stick: 'dryWood' as MaterialId,
      log: 'dryWood' as MaterialId,
      stone: 'stone' as MaterialId,
      grass: 'leaves' as MaterialId,
    },
    ropeRadiusM: 0.01,
    coilAspect: 0.25,
    grassThicknessM: 0.08,
    grassAspect: 1.5,
    snagElevationDeg: 45,
    /**
     * Four stone prototypes, each half of a centrally symmetric point set (local xyz triples; the other half is the
     * mirror image −v), so every hull's centre of mass is its origin. Each has its longest extent along x, a flat face at
     * its bottom (it rests on it unrotated) and an aspect under TOOL_TUNING.compactMaxAspect (2.2): 1.33, 1.53, 1.19, 1.71.
     * A stone is a prototype scaled uniformly to its mass.
     */
    stoneProtos: [
      [0.5, 0.5, 0.3, -0.3, 0.5, 0.45, -0.55, 0.5, -0.2, 0.2, 0.5, -0.4, 1.0, 0, 0, 0.6, 0.1, 0.65, -0.2, -0.05, 0.75, 0.65, -0.1, -0.55],
      [0.75, 0.32, 0.25, 0.05, 0.32, 0.55, -0.7, 0.32, 0.15, -0.1, 0.32, -0.45, 1.1, 0, 0, 0.5, 0.05, -0.65, -0.35, -0.05, 0.72, 0.8, 0.1, 0.45],
      [0.4, 0.62, 0.3, -0.45, 0.62, 0.35, 0.05, 0.62, -0.5, 0.95, 0, 0, 0.35, -0.1, 0.8, -0.55, 0.12, 0.7, 0.6, 0.15, -0.65],
      [0.7, 0.45, 0.05, 0.0, 0.45, 0.5, -0.45, 0.45, -0.25, 1.2, 0, 0, 0.4, 0.05, 0.7, -0.3, 0.12, 0.62, 0.55, -0.1, -0.6],
    ],
    /** §6.7's starter cache axe: a green stick 0.55 m × 4 cm and a 0.6 kg flint with a 0.9 edge, lashed across its end. */
    starterAxe: {
      handleLengthM: 0.55,
      handleRoundDiamM: 0.04,
      handleMaterial: 'greenWood' as MaterialId,
      headKg: 0.6,
      headMaterial: 'flint' as MaterialId,
      headProto: 0,
      edgeSharpness: 0.9,
      lashMaterial: 'vine' as MaterialId,
    },
  },
  {
    materials: {
      tree: { unit: 'material', source: 'NEW: §6.7 (trees: green wood)', options: MATERIAL_IDS },
      sapling: { unit: 'material', source: 'NEW: §6.7 (saplings: green wood)', options: MATERIAL_IDS },
      stick: { unit: 'material', source: 'NEW: §6.7 (dry branches, stakes)', options: MATERIAL_IDS },
      log: { unit: 'material', source: 'NEW: §6.7 (dry logs)', options: MATERIAL_IDS },
      stone: { unit: 'material', source: 'NEW: §6.7 (stones and boulders)', options: MATERIAL_IDS },
      grass: { unit: 'material', source: 'NEW: §6.7 (grass bundles: leaves and dry grass)', options: MATERIAL_IDS },
    },
    ropeRadiusM: { unit: 'm', source: 'NEW: §6.7 ("vine rope (r 0.01 m)"; a 20 m vine coil is 3.77 kg, §5.1)', min: 0 },
    coilAspect: { unit: 'half-height ÷ radius', source: 'NEW: a coil lies as a flat disc (a 20 m vine: 33 cm across, 8 cm thick)', min: 0 },
    grassThicknessM: { unit: 'm', source: 'NEW: §6.7 ("1-3 kg flat boxes")', min: 0 },
    grassAspect: { unit: 'length ÷ width', source: 'NEW: §6.7 ("1-3 kg flat boxes")', min: 1 },
    snagElevationDeg: { unit: '°', source: 'NEW: §6.7 (broken-branch points "up and out at 45°")', min: 0, max: 90 },
    stoneProtos: { unit: 'local xyz triples (half of a symmetric hull; scaled to the mass)', source: 'NEW: §6.7 ("hulls from 4 prototypes, scaled"), D-22' },
    starterAxe: {
      handleLengthM: { unit: 'm', source: 'NEW: §6.7 starter cache (green stick 0.55 m × 4 cm)', min: 0 },
      handleRoundDiamM: {
        unit: 'm (diameter of a round stick of the same cross-section)',
        source: "NEW: §6.7 (× 4 cm); the B lab's 1.15 kg axe, on which FELL_TUNING.refChopJ (339 J) was measured [B lab: tools.ts]",
        min: 0,
      },
      handleMaterial: { unit: 'material', source: 'NEW: §6.7 (a green stick)', options: MATERIAL_IDS },
      headKg: { unit: 'kg', source: 'NEW: §6.7 (a 0.6 kg flint)', min: 0 },
      headMaterial: { unit: 'material', source: 'NEW: §6.7 (flint)', options: MATERIAL_IDS },
      headProto: { unit: 'stone prototype', source: 'NEW', min: 0, step: 1 },
      edgeSharpness: { unit: 'sharpness', source: 'NEW: §6.7 (a 0.9 edge), §5.2 (TOOL_TUNING.refSharpness)', min: 0, max: 1 },
      lashMaterial: { unit: 'material', source: 'NEW: §6.7 (lashed across; a lashing uses VERB_TUNING.lashRopeUseM of rope)', options: MATERIAL_IDS },
    },
  },
);

/** Lying along world +x with a flat face down (a quarter turn about −z: local +y → +x, local +x → −y). */
export const LYING_ALONG_X: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 });

// ---------------------------------------------------------------------------
// Shapes (pure; generation and the joint store use them too)
// ---------------------------------------------------------------------------

/** A standing trunk: an 8-gon prism (PHYSICS_TUNING.cylinderFacets) of circum-diameter `diameter`, `height` long. */
export function trunkPrism(diameter: number, height: number): Extract<Shape, { kind: 'cylinder' }> {
  positive('trunk diameter', diameter);
  positive('trunk height', height);
  return { kind: 'cylinder', halfHeight: height / 2, r: diameter / 2, sides: PHYSICS_TUNING.cylinderFacets };
}

/** A stick, stake or branch: an 8-gon prism (PHYSICS_TUNING.cylinderFacets) of circumradius r. */
export function stickPrism(length: number, r: number): Extract<Shape, { kind: 'cylinder' }> {
  positive('stick length', length);
  positive('stick radius', r);
  return { kind: 'cylinder', halfHeight: length / 2, r, sides: PHYSICS_TUNING.cylinderFacets };
}

/** A log: a 6-gon prism (PHYSICS_TUNING.logFacets) of circumradius r. */
export function logPrism(length: number, r: number): Extract<Shape, { kind: 'cylinder' }> {
  positive('log length', length);
  positive('log radius', r);
  return { kind: 'cylinder', halfHeight: length / 2, r, sides: PHYSICS_TUNING.logFacets };
}

/** The circumradius of an N-gon prism with the cross-section of a round stick of diameter `roundDiam`. */
export function prismRForRoundDiam(roundDiam: number, sides: number): number {
  positive('round diameter', roundDiam);
  return (roundDiam / 2) * Math.sqrt(Math.PI / ngonAreaFactor(sides));
}

/** The circumradius of an N-gon prism `length` long that weighs `massKg` in a material of `density`. */
export function prismRForMass(massKg: number, length: number, density: number, sides: number): number {
  positive('mass', massKg);
  positive('length', length);
  positive('density', density);
  return Math.sqrt(massKg / density / length / ngonAreaFactor(sides));
}

/**
 * A rope of `lengthM` coiled: a flat disc prism (PHYSICS_TUNING.cylinderFacets sides, half-height = coilAspect × its
 * radius) holding the rope's volume, π·ropeRadiusM²·lengthM, so its mass is the rope's (a 20 m vine coil 3.77 kg).
 */
export function ropeCoilShape(lengthM: number): Extract<Shape, { kind: 'cylinder' }> {
  positive('rope length', lengthM);
  const t = FACTORY_TUNING;
  positive('FACTORY_TUNING.ropeRadiusM', t.ropeRadiusM);
  positive('FACTORY_TUNING.coilAspect', t.coilAspect);
  const sides = PHYSICS_TUNING.cylinderFacets;
  const volume = Math.PI * t.ropeRadiusM * t.ropeRadiusM * lengthM;
  // volume = area(r) · 2 · aspect · r = ngonAreaFactor · r² · 2 · aspect · r
  const r = Math.cbrt(volume / (ngonAreaFactor(sides) * 2 * t.coilAspect));
  return { kind: 'cylinder', halfHeight: t.coilAspect * r, r, sides };
}

/** A stone or flint nodule: stone prototype `proto` scaled uniformly to `massKg` of `material` (density × volume). */
export function stoneHull(massKg: number, proto: number, material: MaterialId): Extract<Shape, { kind: 'hull' }> {
  positive('stone mass', massKg);
  const protos = FACTORY_TUNING.stoneProtos;
  if (!Number.isInteger(proto) || proto < 0 || proto >= protos.length) throw new Error(`factory: no stone prototype ${proto} (0..${protos.length - 1})`);
  const half = protos[proto];
  const points: number[] = [...half];
  for (const v of half) points.push(-v);
  const unit: Shape = { kind: 'hull', points };
  const v0 = shapeVolume(unit);
  if (!(v0 > 0)) throw new Error(`factory: stone prototype ${proto} spans no volume`);
  const k = Math.cbrt(massKg / densityOf(material) / v0);
  return { kind: 'hull', points: points.map((c) => c * k) };
}

/**
 * A grass bundle: a flat box of `massKg` of `material`. Without `size`, grassThicknessM thick with a grassAspect
 * footprint (long along x); with `size` (full extents, m), that box scaled uniformly to the mass.
 */
export function grassBox(massKg: number, material: MaterialId, size?: readonly [number, number, number]): Extract<Shape, { kind: 'box' }> {
  positive('grass mass', massKg);
  const volume = massKg / densityOf(material);
  if (size) {
    for (const s of size) positive('grass size', s);
    const k = Math.cbrt(volume / (size[0] * size[1] * size[2]));
    return { kind: 'box', hx: (size[0] * k) / 2, hy: (size[1] * k) / 2, hz: (size[2] * k) / 2 };
  }
  const t = FACTORY_TUNING;
  positive('FACTORY_TUNING.grassThicknessM', t.grassThicknessM);
  positive('FACTORY_TUNING.grassAspect', t.grassAspect);
  const width = Math.sqrt(volume / t.grassThicknessM / t.grassAspect);
  return { kind: 'box', hx: (t.grassAspect * width) / 2, hy: t.grassThicknessM / 2, hz: width / 2 };
}

/**
 * The origin height at which `shape`, rotated by `q`, rests on the terrain around (x, z): every corner of the shape is
 * on or above the terrain under it (and one is on it). Exact corners for prisms, boxes and hulls; balls and capsules by
 * their axis-extreme points.
 */
export function groundRestY(w: World, x: number, z: number, shape: Shape, q: Quat = IDENTITY): number {
  let y = -Infinity;
  for (const c of corners(shape)) {
    const v = rotate(q, c);
    y = Math.max(y, w.terrain.heightAt(x + v.x, z + v.z) - v.y);
  }
  return y;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * A rooted tree: a fixed 8-gon trunk of green wood (FACTORY_TUNING.materials.tree) from the lowest ground under its
 * footprint up `height`, `plant` standing (§2.5). With `vine`: a hanging vine (§6.7) anchored `anchorH` up the trunk
 * on its `yaw` side (direction (sin yaw, 0, cos yaw), at the trunk's circumradius), `lengthM` long, its other end loose:
 * it hangs to the ground and its slack lies out along `yaw` (or it hangs free when shorter than anchorH). The vine is a
 * `rope` joint (`world.joints.rope`, P10) from the trunk to the loose end, made of a vine rope entity, tied (no body).
 * Ids: the tree, then the rope entity; then the joint.
 */
export function spawnTree(
  w: World,
  o: { at: XZ; diameter: number; height: number; vine?: { anchorH: number; lengthM: number; yaw: number } } & SpawnFlags,
): { tree: number; vine: { rope: number; joint: number } | null } {
  if (o.vine) {
    positive('vine anchor height', o.vine.anchorH);
    positive('vine length', o.vine.lengthM);
    finite('vine yaw', o.vine.yaw);
    if (o.vine.anchorH > o.height) throw new Error(`factory: a vine anchored ${o.vine.anchorH} m up a ${o.height} m tree`);
  }
  const { e: tree, base } = rooted(w, o, FACTORY_TUNING.materials.tree, 'tree');
  if (!o.vine) return { tree: tree.id, vine: null };

  const { anchorH, lengthM, yaw } = o.vine;
  const r = o.diameter / 2;
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const local: V3 = { x: r * dx, y: anchorH - o.height / 2, z: r * dz };
  const anchor: V3 = { x: o.at.x + local.x, y: base + anchorH, z: o.at.z + local.z };
  let end: V3;
  if (lengthM >= anchorH) {
    const out = lengthM - anchorH;
    const ex = anchor.x + out * dx;
    const ez = anchor.z + out * dz;
    end = { x: ex, y: w.terrain.heightAt(ex, ez), z: ez };
  } else end = { x: anchor.x, y: anchor.y - lengthM, z: anchor.z };

  const rope = w.entities.create(coilSpec('vine', lengthM, end, o.generated));
  const a: Anchor = { entity: tree.id, local };
  const b: Anchor = { entity: null, local: end, loose: true };
  const joint = w.joints.rope(a, b, lengthM, { entity: rope.id, lengthM }, []);
  tieRope(w, rope.id);
  settleGenerated(w, [tree.id, rope.id], o.generated);
  return { tree: tree.id, vine: { rope: rope.id, joint } };
}

/** A rooted sapling: a fixed 8-gon of green wood (FACTORY_TUNING.materials.sapling), `plant` standing (§5.9 bends it). */
export function spawnSapling(w: World, o: { at: XZ; diameter: number; height: number } & SpawnFlags): number {
  return rooted(w, o, FACTORY_TUNING.materials.sapling, 'sapling').e.id;
}

/** A coil of vine or sinew rope `lengthM` long (ropeCoilShape), lying flat on a support at `at`. */
export function spawnRopeCoil(w: World, o: { at: V3; material: 'vine' | 'sinew'; lengthM: number } & SpawnFlags): number {
  return w.entities.create(coilSpec(o.material, o.lengthM, o.at, o.generated)).id;
}

/**
 * An 8-gon prism (stickPrism) of dry wood unless `material` says otherwise, lying along x unless `q` is given. With
 * `sharp`, that end is pointed as the Shape verb points it (§5.4, RF-18): tapered to a tip on the axis over
 * TOOL_TUNING.pointTaperRadii × r, with a SharpPoint at the tip pointing out along the axis, its sharpness capped at
 * the material's maxSharpness (SPEC:198).
 */
export function spawnStick(
  w: World,
  o: { p: V3; q?: Quat; length: number; r: number; material?: MaterialId; sharp?: { end: 1 | -1; s: number } } & SpawnFlags,
): number {
  const material = o.material ?? FACTORY_TUNING.materials.stick;
  let shape: Shape = stickPrism(o.length, o.r);
  const sharpPoints: SharpPoint[] = [];
  if (o.sharp) {
    const { end, s } = o.sharp;
    if (end !== 1 && end !== -1) throw new Error(`factory: a stick's sharp end is 1 or -1, not ${String(end)}`);
    positive('sharpness', s);
    shape = taperEnd(shape, end, TOOL_TUNING.pointTaperRadii * o.r);
    sharpPoints.push({
      local: { x: 0, y: (end * o.length) / 2, z: 0 },
      dir: { x: 0, y: end, z: 0 },
      sharpness: Math.min(s, materialOf(material).maxSharpness),
    });
  }
  return create(w, { material, shape, p: o.p, q: o.q ?? LYING_ALONG_X, sharpPoints, look: 'stick' }, o.generated).id;
}

/**
 * A 6-gon prism (logPrism) of dry wood unless `material` says otherwise, lying along x unless `q` is given. Give its
 * circumradius `r` or its `mass` (then r follows from density × volume; with both, the mass wins). `state` 'anchored'
 * drives it as a stake is driven (VERB_TUNING.stakeAnchorDepthM). `snags` broken-branch points (§6.7: sharpness
 * CLEARING_TUNING.snagSharpness, capped at the material's maxSharpness) sit on its surface at evenly spaced points
 * along it, alternating sides, pointing up (world up at the spawn rotation) and out at snagElevationDeg.
 */
export function spawnLog(
  w: World,
  o: {
    p: V3;
    q?: Quat;
    length: number;
    r?: number;
    mass?: number;
    material?: MaterialId;
    state?: 'free' | 'anchored' | 'fixed';
    snags?: number;
  } & SpawnFlags,
): number {
  const material = o.material ?? FACTORY_TUNING.materials.log;
  const sides = PHYSICS_TUNING.logFacets;
  let r: number;
  if (o.mass !== undefined) r = prismRForMass(o.mass, o.length, densityOf(material), sides);
  else if (o.r !== undefined) r = o.r;
  else throw new Error('factory: a log needs a radius r or a mass');
  const shape = logPrism(o.length, r);
  const q = o.q ?? LYING_ALONG_X;
  const n = o.snags ?? 0;
  if (!Number.isInteger(n) || n < 0) throw new Error(`factory: a log's snags is a whole number ≥ 0, not ${n}`);
  const sharpness = Math.min(CLEARING_TUNING.snagSharpness, materialOf(material).maxSharpness);
  const sharpPoints = snagPoints(q, o.length, r, n, sharpness);
  return create(w, { material, shape, p: o.p, q, state: o.state ?? 'free', sharpPoints, look: n > 0 ? 'snag' : 'log' }, o.generated).id;
}

/** A stone (or flint, or any material) hull: stone prototype `proto` (default 0) scaled to `mass`, unrotated. */
export function spawnStone(w: World, o: { p: V3; mass: number; proto?: 0 | 1 | 2 | 3; material?: MaterialId } & SpawnFlags): number {
  const material = o.material ?? FACTORY_TUNING.materials.stone;
  const shape = stoneHull(o.mass, o.proto ?? 0, material);
  return create(w, { material, shape, p: o.p, look: material }, o.generated).id;
}

/** A box of full extents `size` (scaffolding, a hide bait…). */
export function spawnBox(
  w: World,
  o: { p: V3; q?: Quat; size: [number, number, number]; material: MaterialId; state?: 'free' | 'fixed'; look: string } & SpawnFlags,
): number {
  for (const s of o.size) positive('box size', s);
  const shape: Shape = { kind: 'box', hx: o.size[0] / 2, hy: o.size[1] / 2, hz: o.size[2] / 2 };
  return create(w, { material: o.material, shape, p: o.p, q: o.q, state: o.state ?? 'free', look: o.look }, o.generated).id;
}

/** A grass bundle: a flat box of leaves and dry grass (grassBox) weighing `mass`. */
export function spawnGrass(w: World, o: { p: V3; mass: number; size?: [number, number, number] } & SpawnFlags): number {
  const material = FACTORY_TUNING.materials.grass;
  return create(w, { material, shape: grassBox(o.mass, material, o.size), p: o.p, look: 'grass' }, o.generated).id;
}

/**
 * The starter cache's stone axe (§6.7, FACTORY_TUNING.starterAxe): a green-wood handle (an 8-gon with a round 4 cm
 * stick's cross-section) and a 0.6 kg flint with a 0.9 edge lashed across its end with VERB_TUNING.lashRopeUseM of
 * vine, as a player makes one (SPEC:247: flint across a stick's end is an axe head, §5.8; no recipe). The flint sits
 * on the handle's end, its long axis across the handle and its thin axis vertical, its underside flush with the
 * handle's, its edge at the far end of its long axis pointing out across the handle (so the held object classifies as
 * `stoneAxe`, §5.2). Both lie on a support at `at` along x, the handle centred over it. Ids: handle, flint, lashing
 * rope; then the `lash` joint (P10).
 */
export function spawnStarterAxe(w: World, at: V3, o: SpawnFlags = {}): { stick: number; head: number; joint: number } {
  const t = FACTORY_TUNING.starterAxe;
  const handle = stickPrism(t.handleLengthM, prismRForRoundDiam(t.handleRoundDiamM, PHYSICS_TUNING.cylinderFacets));
  const head = stoneHull(t.headKg, t.headProto, t.headMaterial);
  const ax = principalAxis(head);
  if (ax.axis !== 'x') throw new Error(`factory: the axe head's prototype ${t.headProto} must be longest along x`);
  // The head's frame in the handle's: head x (its long axis) → handle z (across), head y (thin) → handle x, head z →
  // handle y (along the handle). A third of a turn about −(1, 1, 1).
  const headRot: Quat = { x: -0.5, y: -0.5, z: -0.5, w: 0.5 };
  const headHalfY = maxAbs(head.points, 1);
  const headHalfZ = maxAbs(head.points, 2);
  const tipY = t.handleLengthM / 2;
  // On the handle's end, its +x side flush with the handle's +x face (the face down when lying), so both rest on the
  // ground where they are put.
  const handleFaceX = Math.max(...corners(handle).map((c) => c.x));
  const headAt: V3 = { x: handleFaceX - headHalfY, y: tipY + headHalfZ, z: 0 };

  const q = LYING_ALONG_X;
  const qHead = mulQuat(q, headRot);
  const off = rotate(q, headAt);
  const lift = Math.max(lowestBelow(handle, q), lowestBelow(head, qHead) - off.y);
  const p: V3 = { x: at.x, y: at.y + lift, z: at.z };
  const edge: SharpPoint = {
    local: { x: ax.max, y: 0, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    sharpness: Math.min(t.edgeSharpness, materialOf(t.headMaterial).maxSharpness),
  };

  const stick = create(w, { material: t.handleMaterial, shape: handle, p, q, look: 'stick' }, o.generated);
  const flint = create(
    w,
    { material: t.headMaterial, shape: head, p: { x: p.x + off.x, y: p.y + off.y, z: p.z + off.z }, q: qHead, sharpPoints: [edge], look: t.headMaterial },
    o.generated,
  );
  const lashM = VERB_TUNING.lashRopeUseM;
  const rope = w.entities.create(coilSpec(t.lashMaterial, lashM, at, o.generated));
  // The two anchors are the same point: the centre of the handle's end, where the flint sits (handle (−x, −y, 0) from
  // the flint's centre is the flint's (0, −x, −y)).
  const a: Anchor = { entity: stick.id, local: { x: 0, y: tipY, z: 0 } };
  const b: Anchor = { entity: flint.id, local: { x: 0, y: -headAt.x, z: -headHalfZ } };
  const joint = w.joints.lash(a, b, { entity: rope.id, lengthM: lashM }, []);
  tieRope(w, rope.id);
  settleGenerated(w, [stick.id, flint.id, rope.id], o.generated);
  return { stick: stick.id, head: flint.id, joint };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/** The entity, through the store (which pushes its `spawn` event). */
function create(w: World, spec: Omit<EntitySpec, 'generated'>, generated: boolean | undefined): Entity {
  return w.entities.create({ ...spec, generated: generated ?? false });
}

/**
 * A fixed, rooted 8-gon trunk at `at`: its base is the lowest terrain under its centre and corners (on a slope it is
 * sunk on the uphill side rather than floating on the downhill one), `height` long, `plant` standing.
 */
function rooted(w: World, o: { at: XZ; diameter: number; height: number } & SpawnFlags, material: MaterialId, look: string): { e: Entity; base: number } {
  finite('x', o.at.x);
  finite('z', o.at.z);
  const shape = trunkPrism(o.diameter, o.height);
  const ring = cylinderPoints(shape);
  let base = w.terrain.heightAt(o.at.x, o.at.z);
  for (let k = 0; k < shape.sides; k++) base = Math.min(base, w.terrain.heightAt(o.at.x + ring[3 * k], o.at.z + ring[3 * k + 2]));
  const e = create(
    w,
    { material, shape, p: { x: o.at.x, y: base + o.height / 2, z: o.at.z }, state: 'fixed', plant: { diameter: o.diameter, height: o.height }, look },
    o.generated,
  );
  return { e, base };
}

/** A rope coil's spec: `material` must be rope-like; it lies flat on a support at `at`. */
function coilSpec(material: MaterialId, lengthM: number, at: V3, generated: boolean | undefined): EntitySpec {
  if (!isRopeLike(materialOf(material))) throw new Error(`factory: ${material} is not rope-like`);
  finite('x', at.x);
  finite('y', at.y);
  finite('z', at.z);
  const shape = ropeCoilShape(lengthM);
  return { material, shape, p: { x: at.x, y: at.y + shape.halfHeight, z: at.z }, rope: { lengthM }, look: 'coil', generated: generated ?? false };
}

/**
 * A rope entity a joint is now made of has no body (SPEC:265): it is `tied`. The joint store (P10) may already have
 * made it so; otherwise the factory does.
 */
function tieRope(w: World, id: number): void {
  const e = w.entities.get(id);
  if (e && e.state !== 'tied') w.entities.setState(e, 'tied');
}

/** Generated entities leave the factory untouched: adding a joint or tying a rope here is part of generating them. */
function settleGenerated(w: World, ids: readonly number[], generated: boolean | undefined): void {
  if (!generated) return;
  for (const id of ids) {
    const e = w.entities.get(id);
    if (e) e.touched = false;
  }
}

/**
 * `n` broken-branch points along a prism (axis local +y, circumradius r) lying at rotation q: at axial positions
 * length × ((k + 1)/(n + 1) − ½), on the circumscribed surface, pointing out (alternately to either side of the axis)
 * and up (world up seen in the prism's frame, across the axis) at snagElevationDeg.
 */
function snagPoints(q: Quat, length: number, r: number, n: number, sharpness: number): SharpPoint[] {
  if (n === 0) return [];
  const upL = rotate(conj(unitQuat(q)), { x: 0, y: 1, z: 0 });
  // World up across the axis; an upright prism has none, and its local +x stands in.
  let ux = upL.x;
  let uz = upL.z;
  const un = Math.hypot(ux, uz);
  if (un < 1e-9) {
    ux = 1;
    uz = 0;
  } else {
    ux /= un;
    uz /= un;
  }
  // Out to the side: axis × up.
  const sx = uz;
  const sz = -ux;
  const el = (FACTORY_TUNING.snagElevationDeg * Math.PI) / 180;
  const out: SharpPoint[] = [];
  for (let k = 0; k < n; k++) {
    const side = k % 2 === 0 ? 1 : -1;
    const dx = Math.cos(el) * side * sx + Math.sin(el) * ux;
    const dz = Math.cos(el) * side * sz + Math.sin(el) * uz;
    const y = length * ((k + 1) / (n + 1) - 0.5);
    out.push({ local: { x: r * dx, y, z: r * dz }, dir: { x: dx, y: 0, z: dz }, sharpness });
  }
  return out;
}

/** The corners of a shape in its local frame (balls and capsules: the axis-extreme points of each cap). */
function corners(s: Shape): V3[] {
  const out: V3[] = [];
  const triples = (pts: readonly number[]): void => {
    for (let i = 0; i + 2 < pts.length; i += 3) out.push({ x: pts[i], y: pts[i + 1], z: pts[i + 2] });
  };
  switch (s.kind) {
    case 'box':
      for (const x of [-s.hx, s.hx]) for (const y of [-s.hy, s.hy]) for (const z of [-s.hz, s.hz]) out.push({ x, y, z });
      break;
    case 'cylinder':
      triples(cylinderPoints(s));
      break;
    case 'hull':
      triples(s.points);
      break;
    case 'ball':
    case 'capsule': {
      const h = s.kind === 'capsule' ? s.halfHeight : 0;
      for (const cy of [-h, h]) {
        for (const d of [-s.r, s.r]) out.push({ x: d, y: cy, z: 0 }, { x: 0, y: cy + d, z: 0 }, { x: 0, y: cy, z: d });
      }
      break;
    }
  }
  return out;
}

/** How far the shape, rotated by q, reaches below its origin. */
function lowestBelow(s: Shape, q: Quat): number {
  let lo = Infinity;
  for (const c of corners(s)) lo = Math.min(lo, rotate(q, c).y);
  return -lo;
}

/** The largest |coordinate `axis`| over a flat xyz point list. */
function maxAbs(points: readonly number[], axis: 0 | 1 | 2): number {
  let m = 0;
  for (let i = axis; i < points.length; i += 3) m = Math.max(m, Math.abs(points[i]));
  return m;
}

/** Area of a regular N-gon of circumradius 1. */
function ngonAreaFactor(sides: number): number {
  if (!Number.isInteger(sides) || sides < 3) throw new Error(`factory: a prism needs 3 or more sides, not ${sides}`);
  return (sides / 2) * Math.sin((2 * Math.PI) / sides);
}

function materialOf(id: MaterialId): Material {
  const m = MATERIALS[id];
  if (!m) throw new Error(`factory: unknown material ${String(id)}`);
  return m;
}

function densityOf(id: MaterialId): number {
  const d = materialOf(id).density;
  positive(`${id} density`, d);
  return d;
}

function positive(what: string, v: number): void {
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`factory: ${what} must be a positive number, not ${v}`);
}

function finite(what: string, v: number): void {
  if (!Number.isFinite(v)) throw new Error(`factory: ${what} must be a finite number, not ${v}`);
}

/** v rotated by the unit quaternion q. */
function rotate(q: Quat, v: V3): V3 {
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function conj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** q scaled to unit length (the store normalises an entity's rotation the same way). */
function unitQuat(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error('factory: a rotation must be a non-zero, finite quaternion');
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** a ⊗ b: rotate by b, then by a. */
function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
