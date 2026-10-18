// Key bindings and the gamepad table (docs/M1-DESIGN.md §5.14, D-47). Every keyboard action is rebindable (Settings
// lists ACTIONS); the gamepad uses the Standard mapping and is not rebindable: PAD_BINDINGS is what each button does out
// of the verb modes, and the verb UI (input/verbInput.ts) gives a few buttons their mode meanings (PAD_MODE).
import type { Button } from '@wild/sim';

export type Action =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | Button
  | 'pickup'
  | 'verb'
  | 'throw'
  | 'place'
  | 'target'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'belt1'
  | 'belt2'
  | 'belt3'
  | 'back';

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'up', label: 'Move forward' },
  { id: 'down', label: 'Move back' },
  { id: 'left', label: 'Move left' },
  { id: 'right', label: 'Move right' },
  { id: 'lpunch', label: 'Left punch (parry as a strike lands; hauls a rope end)' },
  { id: 'rpunch', label: 'Right punch (parry as a strike lands; confirms a second target)' },
  { id: 'lkick', label: 'Left kick' },
  { id: 'rkick', label: 'Right kick' },
  { id: 'pickup', label: 'Take / drop' },
  { id: 'verb', label: 'Verbs (hold, point, release)' },
  { id: 'throw', label: 'Throw (hold to aim, release to throw)' },
  { id: 'place', label: 'Place (hold to preview, click to set)' },
  { id: 'target', label: 'Next target (with Shift: previous)' },
  { id: 'jump', label: 'Jump' },
  { id: 'sprint', label: 'Sprint (hold; while placing: drive or not)' },
  { id: 'crouch', label: 'Crouch' },
  { id: 'belt1', label: 'Belt slot 1 (draw, or stow what you hold)' },
  { id: 'belt2', label: 'Belt slot 2' },
  { id: 'belt3', label: 'Belt slot 3' },
  { id: 'back', label: 'Back slot' },
];

/** One rebindable key per action (KeyboardEvent.code; UNBOUND for none). Arrow keys always move too. */
export type Bindings = Record<Action, string>;

/** An action with no key (a saved binding took its key, see loadBindings). */
export const UNBOUND = '';

export const DEFAULT_BINDINGS: Bindings = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  lpunch: 'KeyQ',
  rpunch: 'KeyE',
  lkick: 'KeyR',
  rkick: 'KeyF',
  pickup: 'KeyG',
  verb: 'KeyV',
  throw: 'KeyX',
  place: 'KeyC',
  target: 'Tab',
  jump: 'Space',
  sprint: 'ShiftLeft',
  // Ctrl+W closes the tab and a page can't stop it, so crouch is a toggle by default ("hold to crouch" is a setting);
  // input.ts asks before the page unloads while in play, and locks the keyboard in fullscreen (§5.14).
  crouch: 'ControlLeft',
  belt1: 'Digit1',
  belt2: 'Digit2',
  belt3: 'Digit3',
  back: 'Digit4',
};

/** Keys reserved for the menu, mute and the battle log; they can't be bound to actions. */
export const RESERVED_KEYS = new Set(['Escape', 'KeyM', 'KeyB']);

/** Developer keys (developer mode only: the tuning panel, pause, frame step, time scale, hitboxes, rebuild). */
export const DEV_KEYS = new Set(['KeyL', 'KeyP', 'Period', 'KeyT', 'KeyH', 'Backspace']);

/** Can `code` be bound to an action? Never a reserved key; in developer mode never a developer key either. */
export function isBindable(code: string, dev: boolean): boolean {
  return code !== UNBOUND && !RESERVED_KEYS.has(code) && !(dev && DEV_KEYS.has(code));
}

const STORAGE_KEY = 'brawler.bindings.v1';

/**
 * The saved bindings over the defaults. A saved key wins: an action whose default another action's saved key now
 * uses (a player who moved Take to V before V opened the verbs) is left unbound rather than sharing it, and a saved
 * reserved key is ignored (MAP client §2.4).
 */
export function resolveBindings(saved: Partial<Record<string, unknown>>): Bindings {
  const out = { ...DEFAULT_BINDINGS };
  const used = new Map<string, Action>();
  const explicit = new Set<Action>();
  for (const a of ACTIONS) {
    const code = saved[a.id];
    if (typeof code !== 'string' || (code !== UNBOUND && (RESERVED_KEYS.has(code) || used.has(code)))) continue;
    out[a.id] = code;
    explicit.add(a.id);
    if (code !== UNBOUND) used.set(code, a.id);
  }
  for (const a of ACTIONS) {
    if (explicit.has(a.id)) continue;
    const code = DEFAULT_BINDINGS[a.id];
    if (used.has(code)) out[a.id] = UNBOUND;
    else used.set(code, a.id);
  }
  return out;
}

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return resolveBindings(JSON.parse(raw) as Partial<Record<string, unknown>>);
  } catch {
    // Storage unavailable (private mode etc.) — fall back to defaults.
  }
  return { ...DEFAULT_BINDINGS };
}

export function saveBindings(b: Bindings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    // Not persisted; bindings still apply for this session.
  }
}

/** Assigns `code` to `action`; if another action used it, that action takes the old key. */
export function rebind(b: Bindings, action: Action, code: string): Bindings {
  const next = { ...b };
  const prev = next[action];
  for (const a of ACTIONS) if (a.id !== action && next[a.id] === code) next[a.id] = prev;
  next[action] = code;
  return next;
}

export function keyLabel(code: string): string {
  if (code === UNBOUND) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const named: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt',
    AltRight: 'R-Alt',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    CapsLock: 'Caps',
  };
  return named[code] ?? code;
}

// ---------------------------------------------------------------------------
// Gamepad (Standard mapping; §5.14's table)
// ---------------------------------------------------------------------------

/** Standard-mapping button indices. */
export const PAD = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  back: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

/** What a pad button does out of the verb modes. */
export type PadMeaning =
  | Button
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'pickup'
  | 'verb'
  | 'throw'
  | 'place'
  | 'targetNext'
  | 'targetPrev'
  | 'beltCycle'
  | 'stow'
  | 'menu';

/**
 * §5.14, each button once. Changes from DungeonStyle's pad: LB/RB no longer duplicate the punches (they hold the
 * radial and the throw), A/B no longer duplicate the kicks (jump, crouch); X/Y punch and LT/RT kick are unchanged; RS
 * click still takes; Back moves from pick-up to the belt. Holding a rope end, X and Y haul on it (§5.12).
 */
export const PAD_BINDINGS: Readonly<Record<number, PadMeaning>> = {
  [PAD.a]: 'jump',
  [PAD.b]: 'crouch', // a toggle
  [PAD.x]: 'lpunch',
  [PAD.y]: 'rpunch',
  [PAD.lb]: 'verb', // hold: the radial, the right stick picks a sector, release
  [PAD.rb]: 'throw', // hold: aim with the right stick, release
  [PAD.lt]: 'lkick',
  [PAD.rt]: 'rkick',
  [PAD.back]: 'beltCycle', // the belt into empty hands, one slot after another (or what you hold onto it)
  [PAD.start]: 'menu',
  [PAD.ls]: 'sprint', // a toggle that ends when you stop
  [PAD.rs]: 'pickup', // take / drop
  [PAD.up]: 'stow',
  [PAD.down]: 'place', // toggles the placement preview
  [PAD.left]: 'targetPrev',
  [PAD.right]: 'targetNext',
};

/**
 * The buttons the verb modes give their own meaning (§5.14): A confirms a second target or sets a placement, B cancels
 * any mode, X toggles a placement's drive; the right stick rotates the placement (X, padRotateDegS) and cycles lying /
 * upright / sloped (Y), aims a throw, and picks a radial sector.
 */
export const PAD_MODE = {
  confirm: PAD.a,
  cancel: PAD.b,
  drive: PAD.x,
} as const;
