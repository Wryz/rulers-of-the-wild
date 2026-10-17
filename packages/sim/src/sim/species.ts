// SPECIES_BODY: body data per species (docs/M1-DESIGN.md §2.7, §9.1). The SpeciesId type lives in world/types.ts.
//
// TODO open question SPEC:981 (fauna): M1 has one family on the humanoid rig (human, ape, giant ape); the default is
// a mixed lost world, so SpeciesId will grow with rows here, never with code that reads an id.
//
// Bone masses are not here: m_eff reads the struck bone's mass, `mass × boneShare[bone]` (§4.3), from the live
// BODY_MASS_TUNING.boneKg (body/mass.ts), so a species sets its total mass and the humanoid table shares it out.
import { defineTuning, type FieldsOf } from '../tuning/registry';
import type { MaterialId, Shape, SpeciesId } from '../world/types';

/** What a creature drops at death (D-30): `count` entities of `material` with `shape` (× envKillPartsMul if environmental). */
export type SpeciesPart = { material: MaterialId; count: number; shape: Shape };

// A type alias rather than the design's `interface` (same members): an object type alias is indexable, so the
// registry's FieldsOf asks for a FieldMeta per field (as world/types.ts does for Material).
export type SpeciesBody = {
  /** × the humanoid rig. */
  scale: number;
  /** kg, the whole body (bones share it out by BODY_MASS_TUNING.boneKg). */
  massKg: number;
  maxHp: number;
  /** J, hide toughness (0 human, 0 ape); a ruler's toughness is per zone (RULER_ZONE_TUNING, §2.8), not this. */
  toughnessJ: number;
  /** m/s, the safe landing speed: 6·√scale (SPEC:284, D-4). */
  vSafe: number;
  /** m at scale 1 (× scale): the load footprint of one foot (D-39). */
  footRadiusM: number;
  /** m_eff source: the struck bone (orchestrator decision 2), or its HurtZone total (a playtest lever, §4.3, §4.15). */
  massShareMode: 'bone' | 'zone';
  /** DS fractional armour, off (D-13). */
  defense: 0;
  /** Dropped at death, ×2 if environmental (D-30). Shapes are sized so mass = density × volume gives the tabled kg. */
  parts: SpeciesPart[];
};

const FOOT = { unit: 'm × scale', source: 'NEW: D-39 footprint', min: 0 };
const BONE_MODE = { unit: '—', options: ['bone', 'zone'] as const };
const DEFENSE = { unit: 'fraction', source: 'D-13' };

const fields: FieldsOf<Record<SpeciesId, SpeciesBody>> = {
  human: {
    scale: { unit: '×', source: 'SPEC:368' },
    massKg: { unit: 'kg', source: 'SPEC:876 (Σ BONE_MASS)' },
    maxHp: { unit: 'HP', source: 'SPEC:368' },
    toughnessJ: { unit: 'J', source: 'SPEC:288' },
    vSafe: { unit: 'm/s', source: 'SPEC:284' },
    footRadiusM: FOOT,
    massShareMode: { ...BONE_MODE, source: 'orchestrator decision 2 (D-2)' },
    defense: DEFENSE,
    parts: { unit: 'entities', source: 'NEW: a player drops nothing (D-30)' },
  },
  ape: {
    scale: { unit: '×', source: 'SPEC:873' },
    massKg: { unit: 'kg', source: 'NEW: 73.3 × 1.1³ (SPEC:660 "mass with size³")' },
    maxHp: { unit: 'HP', source: 'SPEC:873' },
    toughnessJ: { unit: 'J', source: 'SPEC:873' },
    vSafe: { unit: 'm/s', source: 'D-4 (6·√1.1)' },
    footRadiusM: { ...FOOT, source: 'NEW: D-39 footprint (chosen here)' },
    massShareMode: { ...BONE_MODE, source: 'orchestrator decision 2; playtest lever (§4.15)' },
    defense: DEFENSE,
    parts: { unit: 'entities', source: 'NEW: D-30 (hide ×1, 2 kg folded box; bone ×2, 0.5 kg 8-gon prisms)' },
  },
  giantApe: {
    scale: { unit: '×', source: 'SPEC:874' },
    massKg: { unit: 'kg', source: 'SPEC:874' },
    // TODO open question SPEC:983 (taming time): ruler HP is the lever.
    maxHp: { unit: 'HP', source: 'SPEC:874 (open question SPEC:983: ruler HP is the taming-time lever)' },
    toughnessJ: { unit: 'J', source: 'SPEC:875: per zone (RULER_ZONE_TUNING); a ruler never reads this hide value' },
    vSafe: { unit: 'm/s', source: 'D-4 (6·√5.5)' },
    footRadiusM: { ...FOOT, source: 'NEW: D-39 footprint (0.66 m at scale 5.5, chosen here)' },
    massShareMode: { ...BONE_MODE, source: 'orchestrator decision 2' },
    defense: DEFENSE,
    parts: { unit: 'entities', source: 'NEW: D-30 (hide ×4, 20 kg folded boxes; rulerBone ×6, 5 kg 8-gon prisms)' },
  },
};

/**
 * Body data per species (§2.7). A live table (folder "Creatures › bodies"): read when a creature is created (scale,
 * mass, HP, toughness) and at use time by the rules (vSafe, footRadiusM, massShareMode, parts).
 */
export const SPECIES_BODY: Record<SpeciesId, SpeciesBody> = defineTuning<Record<SpeciesId, SpeciesBody>>(
  'SPECIES_BODY',
  'Creatures › bodies',
  {
    human: {
      scale: 1,
      massKg: 73.3,
      maxHp: 100,
      toughnessJ: 0,
      vSafe: 6,
      footRadiusM: 0.12,
      massShareMode: 'bone',
      defense: 0,
      parts: [],
    },
    ape: {
      scale: 1.1,
      massKg: 97.56,
      maxHp: 90,
      toughnessJ: 0,
      vSafe: 6.29,
      footRadiusM: 0.12,
      massShareMode: 'bone',
      defense: 0,
      parts: [
        // A folded hide, 30 × 20 × 3 cm: 1,100 kg/m³ × 1.818 L = 2.00 kg.
        { material: 'hide', count: 1, shape: { kind: 'box', hx: 0.15, hy: 0.01515, hz: 0.1 } },
        // A bone, 23 cm long and 4 cm across: 1,900 kg/m³ × 0.263 L = 0.50 kg (elongated: a stake or a point).
        { material: 'bone', count: 2, shape: { kind: 'cylinder', halfHeight: 0.1163, r: 0.02, sides: 8 } },
      ],
    },
    giantApe: {
      scale: 5.5,
      massKg: 14000,
      maxHp: 12000,
      toughnessJ: 0,
      vSafe: 14.07,
      footRadiusM: 0.12,
      massShareMode: 'bone',
      defense: 0,
      parts: [
        // A folded hide, 80 × 60 × 3.8 cm: 1,100 kg/m³ × 18.18 L = 20.0 kg.
        { material: 'hide', count: 4, shape: { kind: 'box', hx: 0.4, hy: 0.01894, hz: 0.3 } },
        // A ruler bone, 53 cm long and 8 cm across: 2,100 kg/m³ × 2.381 L = 5.00 kg (legendary stakes and points).
        { material: 'rulerBone', count: 6, shape: { kind: 'cylinder', halfHeight: 0.2631, r: 0.04, sides: 8 } },
      ],
    },
  },
  fields,
);
