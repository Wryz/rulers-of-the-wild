import type { Button } from '../sim/fighter';

export type Action = 'up' | 'down' | 'left' | 'right' | Button | 'pickup';

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'up', label: 'Move up' },
  { id: 'down', label: 'Move down' },
  { id: 'left', label: 'Move left' },
  { id: 'right', label: 'Move right' },
  { id: 'lpunch', label: 'Left punch (parry as a strike lands)' },
  { id: 'rpunch', label: 'Right punch (parry as a strike lands)' },
  { id: 'lkick', label: 'Left kick' },
  { id: 'rkick', label: 'Right kick' },
  { id: 'pickup', label: 'Pick up / drop weapon' },
];

/** One rebindable key per action (KeyboardEvent.code). Arrow keys always move too. */
export type Bindings = Record<Action, string>;

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
};

/** Keys reserved for the menu, mute and the battle log; they can't be bound to actions. */
export const RESERVED_KEYS = new Set(['Escape', 'KeyM', 'KeyB']);

const STORAGE_KEY = 'brawler.bindings.v1';

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Bindings>;
      const out = { ...DEFAULT_BINDINGS };
      for (const a of ACTIONS) if (typeof parsed[a.id] === 'string') out[a.id] = parsed[a.id]!;
      return out;
    }
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
