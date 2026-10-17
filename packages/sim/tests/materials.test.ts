import { afterEach, describe, expect, it } from 'vitest';
import * as sim from '../src/index';
import { resetTuning, setTuningValue, TUNING, tuningLeaves } from '../src/tuning/registry';
import {
  atLeast,
  atMost,
  breakEnergyJ,
  isRopeLike,
  isSoftGround,
  isSolid,
  isSpringy,
  lashBreakEnergyJ,
  loadCapacityN,
  marginAtLeast,
  MATERIAL_IDS,
  MATERIALS,
  PROPERTY_EPS,
  ropeStrengthN,
} from '../src/world/materials';
import type { Material, MaterialId } from '../src/world/types';

// docs/M1-DESIGN.md §2.1, §9.1 (MATERIALS): the 16 rows of SPEC:206-223 exactly, the armour column of SPEC:885, and
// the property predicates rules use instead of material ids.

// The sim workspace has no Node types (tsconfig `types: []`), so Node's modules are imported untyped.
const { readFileSync } = (await import('node:fs' as string)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import('node:url' as string)) as { fileURLToPath(url: string): string };
const here = fileURLToPath((import.meta as { url?: string }).url!);
const SPEC: string[] = readFileSync(here.replace(/packages[\\/]sim[\\/]tests[\\/][^\\/]+$/, 'docs/SPEC.md'), 'utf8').split('\n');

const SPEC_NAME: Record<string, MaterialId> = {
  'Green wood': 'greenWood',
  'Dry wood': 'dryWood',
  'Rotten wood': 'rottenWood',
  'Leaves and dry grass': 'leaves',
  'Vine rope': 'vine',
  'Sinew rope': 'sinew',
  Hide: 'hide',
  Bone: 'bone',
  'Ruler bone': 'rulerBone',
  Stone: 'stone',
  Flint: 'flint',
  Dirt: 'dirt',
  'Snow (slab)': 'snow',
  Ice: 'ice',
  'Resin and sap': 'resin',
  'Fat and oil': 'fat',
};

/** The spec's starting-values table, parsed: one row per material with its 1-based line number. */
function specRows(): { id: MaterialId; line: number; cells: string[] }[] {
  const header = SPEC.findIndex((l) => l.startsWith('| Material | Density (kg/m³) |'));
  expect(header).toBeGreaterThan(0);
  const rows: { id: MaterialId; line: number; cells: string[] }[] = [];
  for (let i = header + 2; SPEC[i].startsWith('|'); i++) {
    const cells = SPEC[i].split('|').slice(1, -1).map((c) => c.trim());
    rows.push({ id: SPEC_NAME[cells[0]], line: i + 1, cells });
  }
  return rows;
}

function strengthOf(cell: string): Material['strength'] {
  if (cell === 'n/a') return null;
  const m = /^([\d.]+) (J\/kg|kN)$/.exec(cell);
  expect(m, cell).not.toBeNull();
  return m![2] === 'kN' ? { ropeKN: Number(m![1]) } : { solidJPerKg: Number(m![1]) };
}

afterEach(() => resetTuning());

describe('MATERIALS', () => {
  it('holds the 16 rows of SPEC:206-223 exactly, in the spec order, with each row cited by its line', () => {
    const rows = specRows();
    expect(rows.map((r) => r.id)).toEqual([...MATERIAL_IDS]);
    expect(rows[0].line).toBe(208);
    expect(rows[rows.length - 1].line).toBe(223);
    expect(Object.keys(MATERIALS)).toEqual([...MATERIAL_IDS]);
    const entry = TUNING.find((e) => e.name === 'MATERIALS')!;
    const fields = entry.fields as Record<MaterialId, Record<string, { source: string }>>;
    for (const { id, line, cells } of rows) {
      const m = MATERIALS[id];
      const [, density, hardness, maxSharpness, flammability, strength, springiness, friction] = cells;
      expect(m.density, id).toBe(Number(density));
      expect(m.hardness, id).toBe(Number(hardness));
      expect(m.maxSharpness, id).toBe(Number(maxSharpness));
      expect(m.flammability, id).toBe(Number(flammability));
      expect(m.strength, id).toEqual(strengthOf(strength));
      expect(m.springiness, id).toBe(Number(springiness));
      expect(m.friction, id).toBe(Number(friction));
      for (const k of ['density', 'hardness', 'maxSharpness', 'flammability', 'strength', 'springiness', 'friction']) {
        expect(fields[id][k].source, `${id}.${k}`).toBe(`SPEC:${line}`);
      }
    }
  });

  it('gives hide 20 J and bone 40 J of armour (SPEC:885), every other row 0, and no wet mass in M1', () => {
    const line = SPEC.find((l) => l.startsWith('| Armour |'))!;
    const m = /Hide adds (\d+) J to the zones it covers, bone (\d+) J/.exec(line)!;
    expect(MATERIALS.hide.armourJ).toBe(Number(m[1]));
    expect(MATERIALS.bone.armourJ).toBe(Number(m[2]));
    expect([MATERIALS.hide.armourJ, MATERIALS.bone.armourJ]).toEqual([20, 40]);
    for (const id of MATERIAL_IDS) {
      if (id !== 'hide' && id !== 'bone') expect(MATERIALS[id].armourJ, id).toBe(0);
      expect(MATERIALS[id].wetMassPerMoisture, id).toBe(0);
    }
    const fields = TUNING.find((e) => e.name === 'MATERIALS')!.fields as Record<MaterialId, Record<string, { source: string }>>;
    expect(fields.rulerBone.armourJ.source).toContain('TODO "ruler-bone armour value"');
  });

  it('is a registered live table: folder "Materials", every leaf with a unit and a source, exported from the index', () => {
    const entry = TUNING.find((e) => e.name === 'MATERIALS')!;
    expect(entry.folder).toBe('Materials');
    expect(entry.table).toBe(MATERIALS);
    expect(sim.MATERIALS).toBe(MATERIALS);
    const leaves = tuningLeaves(entry);
    expect(leaves).toHaveLength(16 * 9);
    for (const l of leaves) {
      expect(l.meta.unit.length, l.key).toBeGreaterThan(0);
      expect(l.meta.source.length, l.key).toBeGreaterThan(0);
      expect(l.readOnly).toBe(false);
    }
    setTuningValue('MATERIALS', 'vine.strength.ropeKN', 7);
    expect(ropeStrengthN(MATERIALS.vine)).toBe(7000);
    setTuningValue('MATERIALS', 'rottenWood.density', 450);
    expect(MATERIALS.rottenWood.density).toBe(450);
  });
});

describe('material predicates', () => {
  it('tell rope from solid by the kind of strength, not by name', () => {
    expect(MATERIAL_IDS.filter((id) => isRopeLike(MATERIALS[id]))).toEqual(['vine', 'sinew']);
    expect(MATERIAL_IDS.filter((id) => !isSolid(MATERIALS[id]))).toEqual(['vine', 'sinew', 'resin', 'fat']);
    // A material that isn't in the table works through the same rules (SPEC:192: a new material, no new code).
    const hempLike: Material = { ...MATERIALS.vine, strength: { ropeKN: 9 } };
    expect(isRopeLike(hempLike)).toBe(true);
    expect(ropeStrengthN(hempLike)).toBe(9000);
  });

  it('compute break energy, load capacity, rope and lashing strength (SPEC:344-345, D-18)', () => {
    expect(breakEnergyJ(MATERIALS.rottenWood, 2)).toBe(10);
    expect(loadCapacityN(MATERIALS.rottenWood, 2, 0.1)).toBeCloseTo(100, 9); // SPEC:345: a rotten 2 kg branch holds 100 N
    expect(loadCapacityN(MATERIALS.rottenWood, 4, 0.1)).toBeCloseTo(200, 9);
    expect(breakEnergyJ(MATERIALS.dryWood, 5.44)).toBeCloseTo(163.2, 9);
    expect(ropeStrengthN(MATERIALS.vine)).toBe(6000);
    expect(ropeStrengthN(MATERIALS.sinew)).toBe(18000);
    expect(ropeStrengthN(MATERIALS.dryWood)).toBe(0);
    expect(lashBreakEnergyJ(MATERIALS.vine, 1, 0.1)).toBeCloseTo(600, 9);
    expect(lashBreakEnergyJ(MATERIALS.sinew, 1, 0.1)).toBeCloseTo(1800, 9);
    expect(lashBreakEnergyJ(MATERIALS.vine, 2, 0.1)).toBeCloseTo(1200, 9); // strands add up (SPEC:266)
    // Ropes break on tension and resin/fat have no strength: no impact break energy.
    expect(breakEnergyJ(MATERIALS.vine, 3)).toBe(Infinity);
    expect(breakEnergyJ(MATERIALS.resin, 3)).toBe(Infinity);
    expect(loadCapacityN(MATERIALS.fat, 3, 0.1)).toBe(Infinity);
  });

  it('find soft ground and springy materials against the caller’s threshold', () => {
    const soft = MATERIAL_IDS.filter((id) => isSoftGround(MATERIALS[id], 0.5));
    expect(soft).toContain('dirt'); // D-22: every terrain tile is soft ground for stakes
    expect(soft).toContain('greenWood'); // 0.5 ≤ 0.5
    expect(soft).not.toContain('stone');
    expect(soft).not.toContain('ice');
    const springy = MATERIAL_IDS.filter((id) => isSpringy(MATERIALS[id], 0.3));
    expect(springy).toEqual(['greenWood']); // only green wood bends (0.6 ≥ 0.3)
  });

  it('compare property values with the 1e-9 epsilon: 0.7 − 0.5 ≥ 0.2 passes', () => {
    expect(PROPERTY_EPS).toBe(1e-9);
    expect(0.7 - 0.5 >= 0.2).toBe(false); // the floating-point trap the epsilon exists for
    expect(marginAtLeast(0.7, 0.5, 0.2)).toBe(true);
    expect(marginAtLeast(MATERIALS.bone.hardness, MATERIALS.dryWood.hardness, 0.2)).toBe(true);
    expect(marginAtLeast(MATERIALS.flint.hardness, MATERIALS.stone.hardness, 0.2)).toBe(false); // flint doesn't cut stone
    expect(marginAtLeast(0.69, 0.5, 0.2)).toBe(false);
    expect(atLeast(0.3 - 1e-12, 0.3)).toBe(true);
    expect(atLeast(0.3 - 1e-6, 0.3)).toBe(false);
    expect(atMost(0.5 + 1e-12, 0.5)).toBe(true);
    expect(atMost(0.5 + 1e-6, 0.5)).toBe(false);
    expect(isSoftGround({ ...MATERIALS.dirt, hardness: 0.1 + 0.2 + 0.2 }, 0.5)).toBe(true); // 0.5000000000000001
  });
});
