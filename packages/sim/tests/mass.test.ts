import { describe, expect, it } from 'vitest';
import { BONE_MASS, BONE_MASS_SHARE, BONE_ZONE, HUMANOID_MASS, ZONE_MASS_SHARE } from '../src/body/mass';
import { BONES } from '../src/body/skeleton';
import { bodySpheres } from '../src/sim/combat';
import { createPlayer } from '../src/sim/roster';

describe('body mass', () => {
  it('weighs 73.3 kg in all, every bone accounted for', () => {
    expect(Object.keys(BONE_MASS).sort()).toEqual([...BONES].sort());
    expect(HUMANOID_MASS).toBeCloseTo(73.3, 10);
  });

  it('bone shares sum to 1', () => {
    expect(BONES.reduce((s, b) => s + BONE_MASS_SHARE[b], 0)).toBeCloseTo(1, 12);
    expect(BONE_MASS_SHARE.chest).toBeCloseTo(15 / 73.3, 12);
  });

  it('zone shares: head 7.5%, chest with arms 31.1%, abdomen with pelvis 24.6%, legs 36.8%', () => {
    const pct = (x: number) => Math.round(x * 1000) / 10;
    expect(pct(ZONE_MASS_SHARE.head)).toBe(7.5);
    expect(pct(ZONE_MASS_SHARE.chest)).toBe(31.1);
    expect(pct(ZONE_MASS_SHARE.abdomen)).toBe(24.6);
    expect(pct(ZONE_MASS_SHARE.legs)).toBe(36.8);
    // Exactly the bones in each zone.
    expect(ZONE_MASS_SHARE.head).toBeCloseTo(5.5 / 73.3, 12);
    expect(ZONE_MASS_SHARE.chest).toBeCloseTo((15 + 2 * (2.2 + 1.7)) / 73.3, 12);
    expect(ZONE_MASS_SHARE.abdomen).toBeCloseTo((8 + 10) / 73.3, 12);
    expect(ZONE_MASS_SHARE.legs).toBeCloseTo(2 * (9 + 4.5) / 73.3, 12);
    expect(ZONE_MASS_SHARE.head + ZONE_MASS_SHARE.chest + ZONE_MASS_SHARE.abdomen + ZONE_MASS_SHARE.legs).toBeCloseTo(1, 12);
  });

  it('bones fall in the zones the hit spheres put them in', () => {
    const spheres = bodySpheres(createPlayer());
    expect(new Set(spheres.map((s) => s.bone))).toEqual(new Set(BONES));
    for (const s of spheres) expect(BONE_ZONE[s.bone!]).toBe(s.zone);
  });
});
