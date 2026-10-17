import { describe, expect, it } from 'vitest';
import { timed } from '../src/sim/fighter';
import { ENEMY_MOVES } from '../src/sim/moves';

describe('timed moves', () => {
  it('stretch by the tempo rounded to the cache key, whichever tempo asks first (rule 7)', () => {
    const m = ENEMY_MOVES.hookChain; // lunge from frame 6
    // 1.084 and 1.076 share the key '1.08'. Stretched by 1.084 itself, frame 6 would round
    // to 7 (6.504); by the key's 1.08 it is 6 (6.48), and so for every caller.
    const first = timed(m, 1.084);
    expect(first.lunge!.from).toBe(Math.round(6 * 1.08));
    expect(first.startup).toBe(Math.round(m.startup * 1.08));
    expect(first.recovery).toBe(Math.round(m.recovery * 1.08));
    expect(timed(m, 1.076)).toBe(first);
    // Close enough to 1, a move isn't stretched at all.
    expect(timed(m, 1.02)).toBe(m);
  });
});
