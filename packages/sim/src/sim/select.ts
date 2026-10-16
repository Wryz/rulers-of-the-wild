import type { Button, Fighter } from './fighter';
import {
  DEFENSES,
  type DefenseKind,
  FLYING_KICK_MAX,
  FLYING_KICK_MIN,
  GAZELLE_RANGE,
  type MoveDef,
  PUNCH_RANGE,
  SLIDE_RANGE_MAX,
  SLIDE_RANGE_MIN,
} from './moves';

export interface MoveContext {
  /** Distance to the target, or Infinity when there is none. */
  dist: number;
  /** Open counter window after a successful defense. */
  counter: DefenseKind | null;
  /** Current move id when inside its cancel window. */
  chainFrom: string | null;
}

/** Counter move per button after each kind of successful defense. */
const COUNTERS: Record<Button, Record<DefenseKind, string>> = {
  lpunch: { duck: 'counterHook', weave: 'counterHook', slide: 'gazelle', block: 'jab' },
  rpunch: { duck: 'uppercut', weave: 'counterCross', slide: 'counterCross', block: 'counterCross' },
  lkick: { duck: 'frontKick', weave: 'frontKick', slide: 'slideKick', block: 'frontKick' },
  rkick: { duck: 'lowKick', weave: 'lowKick', slide: 'slideKick', block: 'lowKick' },
};

/** Follow-ups per button from the move currently in its cancel window. */
const CHAINS: Record<Button, Record<string, string>> = {
  lpunch: { jab: 'jab', cross: 'hook', counterCross: 'hook' },
  rpunch: { jab: 'cross', hook: 'cross', counterHook: 'cross' },
  lkick: { jab: 'frontKick', cross: 'frontKick', counterCross: 'frontKick' },
  rkick: { jab: 'lowKick', cross: 'lowKick', counterCross: 'lowKick', hook: 'lowKick', counterHook: 'lowKick' },
};

/**
 * Four buttons (left/right punch, left/right kick), many moves: the specific technique
 * depends on the situation. Returns null when the input can't do anything right now.
 */
export function selectPlayerMove(button: Button, ctx: MoveContext): string | null {
  if (ctx.counter) return COUNTERS[button][ctx.counter];
  if (ctx.chainFrom) return CHAINS[button][ctx.chainFrom] ?? null;
  const d = ctx.dist;
  switch (button) {
    case 'lpunch':
      return d > PUNCH_RANGE && d <= GAZELLE_RANGE ? 'gazelle' : 'jab';
    case 'rpunch':
      return 'cross';
    case 'lkick':
      return d >= FLYING_KICK_MIN && d <= FLYING_KICK_MAX ? 'flyingKick' : 'frontKick';
    case 'rkick':
      return d >= SLIDE_RANGE_MIN && d <= SLIDE_RANGE_MAX ? 'slideKick' : 'lowKick';
  }
}

export function moveContext(f: Fighter): MoveContext {
  const t = f.target && f.target.alive ? f.target : null;
  return {
    dist: t ? f.distanceTo(t) : Infinity,
    counter: f.counter && f.counter.frames > 0 ? f.counter.kind : null,
    chainFrom: f.inCancelWindow() ? f.move!.id : null,
  };
}

/**
 * Picks the automatic defensive reaction for an incoming attack based on its height,
 * shape and how many frames are left before it lands. Returns null when nothing fits
 * (too late, or the only option is on cooldown) — the hit will land.
 */
export function chooseDefense(f: Fighter, move: MoveDef, framesToActive: number, height = move.height): DefenseKind | null {
  let prefs: DefenseKind[];
  if (height === 'low') prefs = ['slide'];
  else if (!move.blockable) prefs = ['slide'];
  else if (height === 'mid') prefs = f.guard < 25 ? ['slide', 'block'] : ['block', 'slide'];
  else if (move.kind === 'hook' || move.kind === 'uppercut') prefs = ['duck', 'weave', 'block'];
  else prefs = ['weave', 'duck', 'block'];

  for (const kind of prefs) {
    const def = DEFENSES[kind];
    if (f.defenseCooldown[kind] > 0) continue;
    // Can we get into position before the strike lands? (one frame of grace)
    if (def.startup > Math.max(framesToActive, 0) + 1) continue;
    return kind;
  }
  return null;
}
