import { describe, expect, it } from 'vitest';
import { WEAPON_MOVES, WEAPONS } from '@wild/sim';
import { buildWeapon } from '../src/render/weaponView';

// Carried over from the retired tests/arenas.test.ts (the training ring retires, SPEC:863, D-50): its weapon check is
// about the weapons, not the arenas, and still holds.
describe('weapons', () => {
  it('every weapon has a model and a full set of techniques', () => {
    for (const w of Object.values(WEAPONS)) {
      expect(buildWeapon(w).children.length, w.id).toBeGreaterThan(0);
      expect(WEAPON_MOVES[w.light], `${w.id} light`).toBeDefined();
      expect(WEAPON_MOVES[w.heavy], `${w.id} heavy`).toBeDefined();
      for (const next of Object.values(w.chain)) expect(WEAPON_MOVES[next], `${w.id} chain`).toBeDefined();
    }
  });
});
