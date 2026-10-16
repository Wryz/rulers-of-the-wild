/** Player preferences (separate from progress saves). */
export interface Prefs {
  blood: boolean;
  /** Game-style readability cues (hit flashes, telegraph rings, glowing limbs, popups). */
  cues: boolean;
  /** Tactical tips mid-fight: what to do right now (dodge, punish, counter, go low). */
  tips: boolean;
  /** Record every battle for the battle log. */
  record: boolean;
}

const KEY = 'brawler.prefs.v1';
export const DEFAULT_PREFS: Prefs = { blood: true, cues: false, tips: true, record: true };

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
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
