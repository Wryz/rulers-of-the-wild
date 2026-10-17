import { afterEach, describe, expect, it } from 'vitest';
import { BONE_MASS, BONE_ZONE } from '../src/body/mass';
import { BONES, type BoneName } from '../src/body/skeleton';
import * as sim from '../src/index';
import type { HurtZone } from '../src/sim/combat';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning, setTuningValue, TUNING, tuningLeaves } from '../src/tuning/registry';
import { MATERIALS } from '../src/world/materials';
import { shapeMass } from '../src/world/shapes';
import type { SpeciesId } from '../src/world/types';

// docs/M1-DESIGN.md §2.7 and §9.1 (SPECIES_BODY): body data per species, and the bone masses those bodies give.

const SPECIES: SpeciesId[] = ['human', 'ape', 'giantApe'];
const HUMANOID_KG = BONES.reduce((s, b) => s + BONE_MASS[b], 0);

/** The bone masses of §2.7 (kg), as the design tabled them (rounded). */
const TABLED_BONE_KG: Record<SpeciesId, Record<string, number>> = {
  human: { pelvis: 10, abdomen: 8, chest: 15, head: 5.5, upperArm: 2.2, foreArm: 1.7, thigh: 9, shin: 4.5 },
  ape: { pelvis: 13.31, abdomen: 10.65, chest: 19.97, head: 7.32, upperArm: 2.93, foreArm: 2.26, thigh: 11.98, shin: 5.99 },
  giantApe: { pelvis: 1910, abdomen: 1528, chest: 2865, head: 1050, upperArm: 420, foreArm: 325, thigh: 1719, shin: 859 },
};

/** A bone's mass in a species body: mass × the bone's share of the humanoid table (§4.3, BODY_MASS_TUNING.boneKg). */
const boneKg = (s: SpeciesId, b: BoneName) => (SPECIES_BODY[s].massKg * BONE_MASS[b]) / HUMANOID_KG;

afterEach(() => resetTuning());

describe('SPECIES_BODY', () => {
  it('holds the §9 starting values', () => {
    expect(SPECIES_BODY).toEqual({
      human: { scale: 1, massKg: 73.3, maxHp: 100, toughnessJ: 0, vSafe: 6, footRadiusM: 0.12, massShareMode: 'bone', defense: 0, parts: [] },
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
          { material: 'hide', count: 1, shape: expect.objectContaining({ kind: 'box' }) },
          { material: 'bone', count: 2, shape: expect.objectContaining({ kind: 'cylinder', sides: 8 }) },
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
          { material: 'hide', count: 4, shape: expect.objectContaining({ kind: 'box' }) },
          { material: 'rulerBone', count: 6, shape: expect.objectContaining({ kind: 'cylinder', sides: 8 }) },
        ],
      },
    });
  });

  it('derives its masses and landing speeds as the spec says', () => {
    expect(SPECIES_BODY.human.massKg).toBeCloseTo(HUMANOID_KG, 9); // SPEC:876: Σ BONE_MASS = 73.3 kg
    expect(SPECIES_BODY.ape.massKg).toBeCloseTo(HUMANOID_KG * 1.1 ** 3, 2); // SPEC:660: mass with size³
    for (const s of SPECIES) expect(SPECIES_BODY[s].vSafe, s).toBeCloseTo(6 * Math.sqrt(SPECIES_BODY[s].scale), 2); // D-4
    expect(SPECIES_BODY.giantApe.footRadiusM * SPECIES_BODY.giantApe.scale).toBeCloseTo(0.66, 9); // D-39
  });

  it('gives the bone masses of §2.7 through the humanoid bone table', () => {
    for (const s of SPECIES) {
      for (const b of BONES) {
        const key = b.replace(/[LR]$/, '');
        expect(boneKg(s, b) / TABLED_BONE_KG[s][key], `${s}.${b}`).toBeCloseTo(1, 2);
      }
      const total = BONES.reduce((sum, b) => sum + boneKg(s, b), 0);
      expect(total, s).toBeCloseTo(SPECIES_BODY[s].massKg, 6);
    }
    // The giant's HurtZone totals (SPEC:876 shares × 14 t): head 1,050, chest+arms 4,355, abdomen+pelvis 3,438, legs 5,157.
    const zoneKg: Record<HurtZone, number> = { head: 0, chest: 0, abdomen: 0, legs: 0 };
    for (const b of BONES) zoneKg[BONE_ZONE[b]] += boneKg('giantApe', b);
    expect(Math.round(zoneKg.head)).toBe(1050);
    expect(Math.round(zoneKg.chest)).toBe(4355);
    expect(Math.round(zoneKg.abdomen)).toBe(3438);
    expect(Math.round(zoneKg.legs)).toBe(5157);
  });

  it('drops parts of the tabled masses (D-30): ape hide 2 kg and bones 0.5 kg; giant hides 20 kg and ruler bones 5 kg', () => {
    const kg = (s: SpeciesId) => SPECIES_BODY[s].parts.map((p) => [p.material, p.count, shapeMass(p.shape, MATERIALS[p.material])]);
    const close = (v: number) => expect.closeTo(v, 2);
    expect(kg('human')).toEqual([]);
    expect(kg('ape')).toEqual([
      ['hide', 1, close(2)],
      ['bone', 2, close(0.5)],
    ]);
    expect(kg('giantApe')).toEqual([
      ['hide', 4, close(20)],
      ['rulerBone', 6, close(5)],
    ]);
  });

  it('is a registered live table with its options and the open-question TODOs', () => {
    const entry = TUNING.find((e) => e.name === 'SPECIES_BODY')!;
    expect(entry.folder).toBe('Creatures › bodies');
    expect(entry.table).toBe(SPECIES_BODY);
    expect(sim.SPECIES_BODY).toBe(SPECIES_BODY);
    const leaves = tuningLeaves(entry);
    expect(leaves).toHaveLength(3 * 9);
    for (const l of leaves) {
      expect(l.meta.unit.length, l.key).toBeGreaterThan(0);
      expect(l.meta.source.length, l.key).toBeGreaterThan(0);
    }
    expect(leaves.find((l) => l.key === 'giantApe.maxHp')!.meta.source).toContain('open question SPEC:983');
    setTuningValue('SPECIES_BODY', 'ape.massShareMode', 'zone'); // the playtest lever (§4.15), no code
    expect(SPECIES_BODY.ape.massShareMode).toBe('zone');
    expect(() => setTuningValue('SPECIES_BODY', 'ape.massShareMode', 'hull')).toThrow(/one of/);
    setTuningValue('SPECIES_BODY', 'giantApe.parts.1.count', 3);
    expect(SPECIES_BODY.giantApe.parts[1].count).toBe(3);
  });
});
