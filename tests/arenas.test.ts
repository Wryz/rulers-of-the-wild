import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { THEMES } from '../src/arena/themes';
import { buildWeapon } from '../src/render/weaponView';
import { WEAPON_MOVES, WEAPONS } from '../src/sim/weapons';
import { ArenaWalkable } from '../src/world/collision';

describe('arenas', () => {
  for (const t of Object.values(THEMES)) {
    it(`${t.name}: everyone and every weapon starts on open floor`, () => {
      const w = new ArenaWalkable(t.shape, t.obstacles);
      for (const [x, z] of [t.playerSpawn, ...t.enemySpawns, ...t.weaponSpots]) {
        const p = new Vector3(x, 0, z);
        w.resolve(p, 0.3);
        // Already clear: resolving doesn't have to move it.
        expect(Math.hypot(p.x - x, p.z - z), `${t.id} (${x}, ${z})`).toBeLessThan(0.02);
      }
      expect(t.weapons.length).toBeGreaterThan(0);
      expect(t.weaponSpots.length).toBeGreaterThanOrEqual(t.weapons.length);
    });
  }

  it('every weapon has a model and a full set of techniques', () => {
    for (const w of Object.values(WEAPONS)) {
      expect(buildWeapon(w).children.length, w.id).toBeGreaterThan(0);
      expect(WEAPON_MOVES[w.light], `${w.id} light`).toBeDefined();
      expect(WEAPON_MOVES[w.heavy], `${w.id} heavy`).toBeDefined();
      for (const next of Object.values(w.chain)) expect(WEAPON_MOVES[next], `${w.id} chain`).toBeDefined();
    }
  });
});
