// The world calls sim/impact.ts directly (core-fix; P09 filled it): a hard landing scores through applyImpact itself
// (world/characters.ts, no try/catch around it any more) and World.onKO classifies through isEnvironmental itself
// (world/world.ts, no classifyKO fallback). P01's placeholders threw 'not implemented yet' errors that the old wrappers
// swallowed; such an error now reaches the caller like any other.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MOVE_SPRINT, moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import * as impact from '../src/sim/impact';
import { Rng } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { physicsReady } from '../src/world/physics';
import type { CombatEvent } from '../src/sim/combat';
import { createWorld, type World } from '../src/world/world';

vi.mock('../src/sim/impact', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/impact')>();
  return { ...m, applyImpact: vi.fn(m.applyImpact), isEnvironmental: vi.fn(m.isEnvironmental) };
});

const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
});
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  vi.mocked(impact.applyImpact).mockClear();
  vi.mocked(impact.isEnvironmental).mockClear();
});

async function make(): Promise<World> {
  const w = await createWorld({ seed: 31, scene: 'empty', nav: 'off', size: 50 });
  live.push(w);
  return w;
}

describe('the world calls sim/impact.ts without a fallback (core-fix, TODO(P09) folded)', () => {
  it('a hard landing goes to applyImpact itself: its answer stands and its errors are not swallowed', async () => {
    const w = await make();
    w.addEntity({ material: 'dryWood', shape: { kind: 'box', hx: 1, hy: 2.5, hz: 1 }, p: { x: 0, y: 2.5, z: 0 }, state: 'fixed', look: 'box' });
    w.step();
    const p = w.player!;
    w.teleport(p, 0.5, 0, Math.PI / 2);
    w.step();
    const placeholder = new Error('sim/impact.ts: applyImpact is not implemented yet');
    vi.mocked(impact.applyImpact).mockImplementation(() => {
      throw placeholder;
    });
    let thrown: unknown = null;
    for (let t = 0; t < 200 && thrown === null; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0, MOVE_SPRINT));
      try {
        w.step();
      } catch (e) {
        thrown = e;
      }
    }
    // The landing called it, with the world's CombatSim and the player's shin, and the error reached step()'s caller.
    expect(thrown).toBe(placeholder);
    const [sim, i] = vi.mocked(impact.applyImpact).mock.calls.at(-1)!;
    expect(sim).toBe(w.combat);
    expect(i.target).toBe(p);
    expect(i.bone).toBe('shinL');
    expect(i.cause.feature).toBe('fall');
  });

  it('World.onKO answers with isEnvironmental, and its errors are not swallowed', async () => {
    const w = await make();
    const ids = w.ids.fighter;
    const mk = () => {
      const { fighter: f } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
      f.scale = SPECIES_BODY.ape.scale;
      f.species = 'ape';
      f.massKg = SPECIES_BODY.ape.massKg;
      f.pos.set(4, 0, 4);
      w.addFighter(f, null);
      return f;
    };
    const a = mk();
    const p = w.player!;
    const finish = {
      by: 'strike' as const,
      killer: p,
      cause: { kind: 'creature' as const, entityId: null, fighterId: p.id, credit: ['p1'], held: true, feature: 'creature' as const },
      point: { x: 4, y: 1, z: 4 },
    };
    vi.mocked(impact.isEnvironmental).mockReturnValueOnce({ environmental: true, credit: ['p9'] });
    w.combat.koFighter(a, finish);
    const ko = w.combat.events.find((e): e is Extract<CombatEvent, { type: 'ko' }> => e.type === 'ko' && e.victim === a)!;
    expect(ko).toMatchObject({ environmental: true, credit: ['p9'] });
    expect(vi.mocked(impact.isEnvironmental)).toHaveBeenCalledWith(a, finish, w.tick);

    const b = mk();
    const placeholder = new Error('sim/impact.ts: isEnvironmental is not implemented yet');
    vi.mocked(impact.isEnvironmental).mockImplementationOnce(() => {
      throw placeholder;
    });
    expect(() => w.combat.koFighter(b, finish)).toThrow(placeholder);
  });
});
