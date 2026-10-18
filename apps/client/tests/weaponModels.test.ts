import { Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { TOOL_WEAPON_IDS, WEAPON_MOVES, WEAPONS, type WeaponDef, type WeaponId } from '@wild/sim';
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

  it('a weapon with no model of its own (a primitive tool, drawn from its entity in play) still gets one, as long as it is', () => {
    // M1's primitive WeaponIds (P14, §5.2) are synthesised from held entities; buildWeapon's fallback keeps every def
    // drawable (the legacy views, a thrown tool's DS projectile view).
    for (const edge of ['blade', 'blunt'] as const) {
      const def: WeaponDef = { ...WEAPONS.bat, id: 'aToolWithNoModel' as WeaponId, edge, length: 1.6, strikeFrom: 1.3 };
      const g = buildWeapon(def);
      expect(g.children.length).toBeGreaterThan(1);
      let top = -Infinity;
      g.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        o.geometry.computeBoundingBox();
        top = Math.max(top, o.position.y + (o.geometry.boundingBox?.max.y ?? 0));
      });
      expect(top).toBeGreaterThan(1.4);
      expect(top).toBeLessThan(1.7);
    }
  });

  it('every primitive tool (TOOL_WEAPON_IDS) has a model too, so WEAPONS can enumerate them (C-fix, the P32-fix note)', () => {
    // In play a tool is drawn from its entity; this model is for anything that asks buildWeapon for one by its def.
    // TODO(sim, P14 follow-up): weapons.ts can now drop the non-enumerable loop over TOOL_WEAPON_IDS (and the
    // verbs.tools.test.ts line that pins it): the client draws every one of them.
    for (const id of TOOL_WEAPON_IDS) {
      const g = buildWeapon(WEAPONS[id]);
      let meshes = 0;
      g.traverse((o) => {
        if (o instanceof Mesh) meshes++;
      });
      expect(meshes, id).toBeGreaterThan(0);
      expect(WEAPON_MOVES[WEAPONS[id].light], `${id} light`).toBeDefined();
    }
  });
});
