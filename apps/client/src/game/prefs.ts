import type { GoreLevel } from './ports';

/** Player preferences (separate from progress saves). */
export interface Prefs {
  /**
   * Rule 12: the gore level every gore-bearing visual reads (game.ts goreOf, the one place M1 reads it). Settings' blood
   * row sets it to 'full' or 'off'; the three-level setting itself is M5's (docs/M1-DESIGN.md §10.4, RR-22).
   */
  gore: GoreLevel;
  /** @deprecated DungeonStyle's blood toggle, kept in step with `gore` (gore !== 'off') for saved prefs and readers. */
  blood: boolean;
  /** Game-style readability cues (hit flashes, the cues callouts, longer hit-pauses). (DS's fight tips went with its
   * tips HUD, C-fix: a saved `tips` is ignored.) */
  cues: boolean;
  /** Record every battle for the battle log. */
  record: boolean;
  /** Crouch while the crouch key is held, instead of toggling it (§5.14: a toggle by default, Ctrl+W closes the tab). */
  holdToCrouch: boolean;
}

const KEY = 'brawler.prefs.v1';
export const DEFAULT_PREFS: Prefs = { gore: 'full', blood: true, cues: false, record: true, holdToCrouch: false };

const GORE_LEVELS: readonly GoreLevel[] = ['off', 'stylised', 'full'];

/** Saved prefs over the defaults; a save from before `gore` existed keeps its blood toggle as the gore level. */
export function migratePrefs(saved: Partial<Record<keyof Prefs | 'tips', unknown>>): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  for (const k of ['cues', 'record', 'holdToCrouch', 'blood'] as const) if (typeof saved[k] === 'boolean') out[k] = saved[k] as boolean;
  const gore = saved.gore;
  if (typeof gore === 'string' && (GORE_LEVELS as readonly string[]).includes(gore)) out.gore = gore as GoreLevel;
  else if (saved.blood === false) out.gore = 'off';
  out.blood = out.gore !== 'off';
  return out;
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migratePrefs(JSON.parse(raw) as Partial<Record<keyof Prefs, unknown>>);
  } catch {
    // Unavailable storage: defaults.
  }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Not persisted.
  }
}
