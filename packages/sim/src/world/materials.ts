// MATERIALS (the 16 rows of SPEC:206-223) and the property predicates, the only way rules ask about materials
// (docs/M1-DESIGN.md §2.1). The Material and MaterialId types live in world/types.ts.
//
// Rules read properties only (SPEC:192): a material id is a key into this table and nothing else, so a new material
// is a new row, never new rule code (rule 1, AC-1). The armour rule is one more property (`armourJ`, departure X19).
//
// Thresholds owned by other systems' tables (TERRAIN_TUNING.softGroundMaxHardness, JOINT_TUNING.bendMinSpringiness,
// JOINT_TUNING.lashLeverM, BREAK_TUNING.loadLeverM) are passed in by the caller, which reads its table at use time:
// this module stays a leaf that any system can import without a cycle.
import { defineTuning, type FieldMeta, type FieldsOf } from '../tuning/registry';
import type { Material, MaterialId } from './types';

/**
 * Comparisons of property values allow this much (§2.1): `0.7 − 0.5` is `0.19999999999999996` in JS, so a 0.2 margin
 * test reads `≥ 0.2 − 1e-9`. Not a starting value: floating-point slack.
 */
export const PROPERTY_EPS = 1e-9;

/** Newtons per kilonewton (a rope's strength is tabled in kN, SPEC:200). */
const N_PER_KN = 1000;

/** Every material id in the spec's table order (SPEC:208-223): the order to iterate materials in. */
export const MATERIAL_IDS: readonly MaterialId[] = [
  'greenWood',
  'dryWood',
  'rottenWood',
  'leaves',
  'vine',
  'sinew',
  'hide',
  'bone',
  'rulerBone',
  'stone',
  'flint',
  'dirt',
  'snow',
  'ice',
  'resin',
  'fat',
];

// The spec row each material's starting values come from.
const ROW_SOURCE: Record<MaterialId, string> = {
  greenWood: 'SPEC:208',
  dryWood: 'SPEC:209',
  rottenWood: 'SPEC:210',
  leaves: 'SPEC:211',
  vine: 'SPEC:212',
  sinew: 'SPEC:213',
  hide: 'SPEC:214',
  bone: 'SPEC:215',
  rulerBone: 'SPEC:216',
  stone: 'SPEC:217',
  flint: 'SPEC:218',
  dirt: 'SPEC:219',
  snow: 'SPEC:220',
  ice: 'SPEC:221',
  resin: 'SPEC:222',
  fat: 'SPEC:223',
};

const ARMOUR_SOURCE: Record<MaterialId, string> = {
  ...(Object.fromEntries(MATERIAL_IDS.map((id) => [id, 'NEW: no spec value (RR-3)'])) as Record<MaterialId, string>),
  hide: 'SPEC:885, 417 (RR-3)',
  bone: 'SPEC:885, 417 (RR-3)',
  rulerBone: 'NEW: no spec value; TODO "ruler-bone armour value" (RR-3)',
};

const UNIT = { unit: '0-1', min: 0, max: 1 };

function materialFields(id: MaterialId): FieldsOf<Material> {
  const src = ROW_SOURCE[id];
  const meta = (m: Omit<FieldMeta, 'source'>, source = src): FieldMeta => ({ ...m, source });
  return {
    density: meta({ unit: 'kg/m³', min: 0 }),
    hardness: meta(UNIT),
    maxSharpness: meta(UNIT),
    flammability: meta(UNIT),
    strength: meta({ unit: 'J/kg (solid) or kN per strand (rope); null = n/a' }),
    springiness: meta(UNIT),
    friction: meta(UNIT),
    armourJ: meta({ unit: 'J added to a covered zone', min: 0 }, ARMOUR_SOURCE[id]),
    wetMassPerMoisture: meta({ unit: 'kg/kg per unit moisture', min: 0 }, 'NEW: M2 rule, 0 in M1 (SPEC:180, 324)'),
  };
}

/**
 * The 16 materials (SPEC:206-223), the armour column of SPEC:885 (hide 20 J, bone 40 J; every other row 0) and the
 * M2 wet-mass column (0). A live table (folder "Materials"): rules read it at use time; an entity's mass is computed
 * from its density when the entity is created.
 */
export const MATERIALS: Record<MaterialId, Material> = defineTuning<Record<MaterialId, Material>>(
  'MATERIALS',
  'Materials',
  {
    greenWood: {
      density: 800, hardness: 0.5, maxSharpness: 0.5, flammability: 0.2, strength: { solidJPerKg: 40 },
      springiness: 0.6, friction: 0.6, armourJ: 0, wetMassPerMoisture: 0,
    },
    dryWood: {
      density: 550, hardness: 0.5, maxSharpness: 0.6, flammability: 0.8, strength: { solidJPerKg: 30 },
      springiness: 0.2, friction: 0.6, armourJ: 0, wetMassPerMoisture: 0,
    },
    rottenWood: {
      density: 400, hardness: 0.1, maxSharpness: 0.1, flammability: 0.5, strength: { solidJPerKg: 5 },
      springiness: 0, friction: 0.6, armourJ: 0, wetMassPerMoisture: 0,
    },
    leaves: {
      density: 100, hardness: 0, maxSharpness: 0, flammability: 1, strength: { solidJPerKg: 1 },
      springiness: 0, friction: 0.4, armourJ: 0, wetMassPerMoisture: 0,
    },
    vine: {
      density: 600, hardness: 0.1, maxSharpness: 0, flammability: 0.5, strength: { ropeKN: 6 },
      springiness: 0.1, friction: 0.7, armourJ: 0, wetMassPerMoisture: 0,
    },
    sinew: {
      density: 1100, hardness: 0.2, maxSharpness: 0, flammability: 0.3, strength: { ropeKN: 18 },
      springiness: 0.2, friction: 0.7, armourJ: 0, wetMassPerMoisture: 0,
    },
    hide: {
      density: 1100, hardness: 0.3, maxSharpness: 0, flammability: 0.3, strength: { solidJPerKg: 20 },
      springiness: 0.1, friction: 0.6, armourJ: 20, wetMassPerMoisture: 0,
    },
    bone: {
      density: 1900, hardness: 0.7, maxSharpness: 0.8, flammability: 0.1, strength: { solidJPerKg: 60 },
      springiness: 0.1, friction: 0.5, armourJ: 40, wetMassPerMoisture: 0,
    },
    // TODO "ruler-bone armour value": the spec gives none (SPEC:885 names hide and bone only); 0 until it does.
    rulerBone: {
      density: 2100, hardness: 0.9, maxSharpness: 0.9, flammability: 0, strength: { solidJPerKg: 200 },
      springiness: 0.1, friction: 0.5, armourJ: 0, wetMassPerMoisture: 0,
    },
    stone: {
      density: 2600, hardness: 0.9, maxSharpness: 0.2, flammability: 0, strength: { solidJPerKg: 150 },
      springiness: 0, friction: 0.7, armourJ: 0, wetMassPerMoisture: 0,
    },
    flint: {
      density: 2600, hardness: 0.95, maxSharpness: 1, flammability: 0, strength: { solidJPerKg: 40 },
      springiness: 0, friction: 0.6, armourJ: 0, wetMassPerMoisture: 0,
    },
    dirt: {
      density: 1500, hardness: 0.2, maxSharpness: 0, flammability: 0, strength: { solidJPerKg: 5 },
      springiness: 0, friction: 0.7, armourJ: 0, wetMassPerMoisture: 0,
    },
    snow: {
      density: 300, hardness: 0.1, maxSharpness: 0, flammability: 0, strength: { solidJPerKg: 2 },
      springiness: 0, friction: 0.3, armourJ: 0, wetMassPerMoisture: 0,
    },
    ice: {
      density: 900, hardness: 0.6, maxSharpness: 0.3, flammability: 0, strength: { solidJPerKg: 20 },
      springiness: 0, friction: 0.05, armourJ: 0, wetMassPerMoisture: 0,
    },
    resin: {
      density: 1000, hardness: 0, maxSharpness: 0, flammability: 1, strength: null,
      springiness: 0, friction: 0.3, armourJ: 0, wetMassPerMoisture: 0,
    },
    fat: {
      density: 900, hardness: 0, maxSharpness: 0, flammability: 0.9, strength: null,
      springiness: 0, friction: 0.1, armourJ: 0, wetMassPerMoisture: 0,
    },
  },
  Object.fromEntries(MATERIAL_IDS.map((id) => [id, materialFields(id)])) as FieldsOf<Record<MaterialId, Material>>,
);

// ---------------------------------------------------------------------------
// Property comparisons (§2.1: every comparison of property values allows PROPERTY_EPS)
// ---------------------------------------------------------------------------

/** value ≥ threshold, allowing PROPERTY_EPS. */
export function propertyAtLeast(value: number, threshold: number): boolean {
  return value >= threshold - PROPERTY_EPS;
}

/** value ≤ threshold, allowing PROPERTY_EPS. */
export function propertyAtMost(value: number, threshold: number): boolean {
  return value <= threshold + PROPERTY_EPS;
}

/**
 * `harder − softer ≥ margin`, allowing PROPERTY_EPS: the shape of every hardness-margin rule (a tool's edge cuts what
 * is at least VERB_TUNING.cutHardnessMargin softer; bone 0.7 cuts dry wood 0.5 at a 0.2 margin).
 */
export function propertyMarginAtLeast(harder: number, softer: number, margin: number): boolean {
  return propertyAtLeast(harder - softer, margin);
}

// ---------------------------------------------------------------------------
// Predicates and derived quantities (§2.1)
// ---------------------------------------------------------------------------

type RopeStrength = { ropeKN: number };
type SolidStrength = { solidJPerKg: number };

/** Rope-like: its strength is a tension in kN per strand (vine, sinew). */
export function isRopeLike(m: Material): m is Material & { strength: RopeStrength } {
  return m.strength !== null && 'ropeKN' in m.strength;
}

/** Solid: its strength is an impact energy per kg (every row but the ropes and the n/a rows). */
export function isSolid(m: Material): m is Material & { strength: SolidStrength } {
  return m.strength !== null && 'solidJPerKg' in m.strength;
}

/** Soft ground (stakes drive into it, D-19): hardness ≤ `maxHardness` (TERRAIN_TUNING.softGroundMaxHardness). */
export function isSoftGround(m: Material, maxHardness: number): boolean {
  return propertyAtMost(m.hardness, maxHardness);
}

/** Springy (the Bend verb): springiness ≥ `minSpringiness` (JOINT_TUNING.bendMinSpringiness). */
export function isSpringy(m: Material, minSpringiness: number): boolean {
  return propertyAtLeast(m.springiness, minSpringiness);
}

/**
 * Break energy E_b = strength (J/kg) × mass (SPEC:344), J. A rope-like or n/a material has no impact break energy
 * (ropes break on tension, §4.9), so it is Infinity.
 */
export function breakEnergyJ(m: Material, massKg: number): number {
  return isSolid(m) ? m.strength.solidJPerKg * massKg : Infinity;
}

/** The tension one strand holds, N (`ropeKN × 1000`); 0 for a material that isn't rope-like. */
export function ropeStrengthN(m: Material): number {
  return isRopeLike(m) ? m.strength.ropeKN * N_PER_KN : 0;
}

/**
 * A lashing's break energy, J: `ropeKN × 1000 × strands × leverM` (D-18; `leverM` = JOINT_TUNING.lashLeverM): one vine
 * strand 600 J, one sinew strand 1,800 J at 0.1 m.
 */
export function lashBreakEnergyJ(rope: Material, strands: number, leverM: number): number {
  return ropeStrengthN(rope) * strands * leverM;
}

/**
 * Load capacity, N: E_b ÷ `leverM` (BREAK_TUNING.loadLeverM, SPEC:345, 884): a rotten 2 kg branch holds 100 N at
 * 0.1 m. Infinity for a material with no break energy.
 */
export function loadCapacityN(m: Material, massKg: number, leverM: number): number {
  return breakEnergyJ(m, massKg) / leverM;
}
