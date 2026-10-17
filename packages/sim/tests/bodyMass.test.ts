// The humanoid body's bone masses as a live tuning table (docs/M1-DESIGN.md §1.2 body/mass.ts, §2.7, §9
// BODY_MASS_TUNING; RR-2): the same numbers as DungeonStyle's constants by default, read at use time, and the
// default read-outs left to tests and tools.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BODY_MASS_TUNING,
  BONE_MASS,
  BONE_MASS_SHARE,
  BONE_ZONE,
  boneMassShares,
  HUMANOID_MASS,
  humanoidMass,
  ZONE_MASS_SHARE,
  zoneMassShares,
} from '../src/body/mass';
import { BONES } from '../src/body/skeleton';
import { createPlayer } from '../src/sim/roster';
import { boneMass } from '../src/sim/rules';
import { getTuningValue, resetTuning, setTuningValue, TUNING, tuningLeaves, tuningOverrides, tuningSnapshot } from '../src/tuning/registry';

afterEach(() => resetTuning('BODY_MASS_TUNING'));

/** Every .ts file under packages/sim/src, as [path relative to src, text] (Node's fs, reached dynamically). */
async function simSources(): Promise<[string, string][]> {
  const fsModule = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsModule)) as {
    readdirSync(path: unknown, o: { recursive: true }): string[];
    readFileSync(path: unknown, enc: 'utf8'): string;
  };
  const Url = (globalThis as unknown as { URL: new (url: string, base?: unknown) => unknown }).URL;
  const src = new Url('../src/', (import.meta as unknown as { url: string }).url);
  return fs
    .readdirSync(src, { recursive: true })
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => [f.replace(/\\/g, '/'), fs.readFileSync(new Url(f, src), 'utf8')]);
}

describe('BODY_MASS_TUNING', () => {
  it('is registered under "Creatures › bodies" with a unit and a source on every bone, and zoneShare read-only', () => {
    const e = TUNING.find((t) => t.name === 'BODY_MASS_TUNING')!;
    expect(e).toBeDefined();
    expect(e.folder).toBe('Creatures › bodies');
    const leaves = tuningLeaves(e);
    expect(leaves.map((l) => l.key)).toEqual([...BONES.map((b) => `boneKg.${b}`), 'zoneShare.head', 'zoneShare.chest', 'zoneShare.abdomen', 'zoneShare.legs']);
    for (const l of leaves) {
      expect(l.meta.unit.length).toBeGreaterThan(0);
      expect(l.meta.source.length).toBeGreaterThan(0);
      expect(l.readOnly).toBe(l.key.startsWith('zoneShare.'));
    }
    // The read-out is neither editable nor saved.
    expect(() => setTuningValue('BODY_MASS_TUNING', 'zoneShare.head', 0.5)).toThrow(/read-out/);
    expect(tuningSnapshot()).not.toMatch(/zoneShare/);
  });

  it('holds the §9 bone masses: 73.3 kg in all', () => {
    expect(BODY_MASS_TUNING.boneKg).toEqual({
      pelvis: 10,
      abdomen: 8,
      chest: 15,
      head: 5.5,
      upperArmL: 2.2,
      foreArmL: 1.7,
      upperArmR: 2.2,
      foreArmR: 1.7,
      thighL: 9,
      shinL: 4.5,
      thighR: 9,
      shinR: 4.5,
    });
    expect(humanoidMass()).toBeCloseTo(73.3, 12);
  });

  it('is the very object BONE_MASS is (what the client ragdoll reads)', () => {
    expect(BONE_MASS).toBe(BODY_MASS_TUNING.boneKg);
    setTuningValue('BODY_MASS_TUNING', 'boneKg.head', 6);
    expect(BONE_MASS.head).toBe(6);
  });

  it('computes, by default, exactly DungeonStyle\'s shares and totals, bit for bit', () => {
    expect(Object.is(humanoidMass(), HUMANOID_MASS)).toBe(true);
    const shares = boneMassShares();
    for (const b of BONES) expect(Object.is(shares[b], BONE_MASS_SHARE[b]), b).toBe(true);
    const zones = zoneMassShares();
    for (const z of ['head', 'chest', 'abdomen', 'legs'] as const) expect(Object.is(zones[z], ZONE_MASS_SHARE[z]), z).toBe(true);
    // The read-out is the same computation.
    expect(BODY_MASS_TUNING.zoneShare).toEqual(zones);
    // DungeonStyle's formulas, written out.
    const total = BONES.reduce((s, b) => s + BONE_MASS[b], 0);
    for (const b of BONES) expect(Object.is(shares[b], BONE_MASS[b] / total)).toBe(true);
  });

  it('is read at use time: a live edit reaches the shares, the zone read-out and new fighters, not the frozen read-outs', () => {
    const before = BONE_MASS_SHARE.head;
    setTuningValue('BODY_MASS_TUNING', 'boneKg.head', 11);
    expect(tuningOverrides()).toEqual([{ table: 'BODY_MASS_TUNING', key: 'boneKg.head', value: 11 }]);
    expect(humanoidMass()).toBeCloseTo(78.8, 12);
    expect(boneMassShares().head).toBeCloseTo(11 / 78.8, 12);
    expect(BODY_MASS_TUNING.zoneShare.head).toBeCloseTo(11 / 78.8, 12);
    expect(getTuningValue('BODY_MASS_TUNING', 'zoneShare.head')).toBeCloseTo(11 / 78.8, 12);
    expect(BONE_MASS_SHARE.head).toBe(before);
    expect(HUMANOID_MASS).toBeCloseTo(73.3, 12);
    const f = createPlayer();
    expect(f.mass).toBeCloseTo(78.8, 12);
    expect(f.boneShare.head).toBeCloseTo(11 / 78.8, 12);
    expect(boneMass(f, 'head')).toBeCloseTo(11, 12);
  });

  it('gives a fighter its bone masses: the struck bone by default, its whole zone in zone mode', () => {
    const f = createPlayer();
    expect(f.mass).toBeCloseTo(73.3, 12);
    expect(boneMass(f, 'chest')).toBeCloseTo(15, 12);
    expect(boneMass(f, 'shinL')).toBeCloseTo(4.5, 12);
    expect(boneMass(f, 'chest', 'zone')).toBeCloseTo(15 + 2 * (2.2 + 1.7), 12);
    expect(boneMass(f, 'foreArmR', 'zone')).toBeCloseTo(15 + 2 * (2.2 + 1.7), 12);
    expect(boneMass(f, 'pelvis', 'zone')).toBeCloseTo(18, 12);
    for (const b of BONES) expect(BONE_ZONE[b]).toBeDefined();
    // Mass grows with size cubed (SPEC:660): an ape at 1.1 is 97.56 kg (§2.7), its chest bone 19.97 kg.
    f.scale = 1.1;
    expect(f.mass).toBeCloseTo(97.5623, 3);
    expect(boneMass(f, 'chest')).toBeCloseTo(19.97, 2);
    // A body with a set mass (the giant: 14 t) splits it by the same shares.
    f.massKg = 14000;
    expect(boneMass(f, 'chest')).toBeCloseTo(2865, 0);
    expect(boneMass(f, 'shinR')).toBeCloseTo(859, 0);
  });

  it('leaves the default read-outs to tests and tools: no sim source reads them (RR-2)', async () => {
    const offenders: string[] = [];
    const sources = await simSources();
    expect(sources.map(([f]) => f)).toEqual(expect.arrayContaining(['body/mass.ts', 'sim/combat.ts', 'sim/fighter.ts', 'sim/rules.ts']));
    for (const [file, text] of sources) {
      if (file === 'body/mass.ts') continue;
      text.split('\n').forEach((line, i) => {
        if (/\b(HUMANOID_MASS|BONE_MASS_SHARE|ZONE_MASS_SHARE)\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
