// Bindings, the gamepad table, prefs and the raw input (docs/M1-DESIGN.md §5.14, §10.7; package P35): the default
// keys have no duplicates and no reserved or developer key; a saved binding that takes a new action's key leaves that
// action unbound rather than sharing it; the pad table maps as §5.14; DEFAULT_PREFS keeps the cues off and the gore
// full; the input routes keys, Escape, Tab, the mouse, the wheel and the pad, and filters the camera's look by the
// verb UI's mode.
import { describe, expect, it } from 'vitest';
import { BUTTONS } from '@wild/sim';
import {
  type Action,
  ACTIONS,
  DEFAULT_BINDINGS,
  DEV_KEYS,
  isBindable,
  keyLabel,
  PAD,
  PAD_BINDINGS,
  PAD_MODE,
  rebind,
  RESERVED_KEYS,
  resolveBindings,
  UNBOUND,
} from '../src/input/bindings';
import { deadZone, type FullInputFrame, fullFrame, Input, type InputEnv, isTextField, readPad, wheelNotches } from '../src/input/input';
import type { UiMode } from '../src/input/verbInput';
import { VERB_UI_TUNING } from '../src/input/verbInput';
import { DEFAULT_PREFS, migratePrefs } from '../src/game/prefs';

describe('default bindings (§5.14)', () => {
  it('bind every action to its own key, none reserved and none a developer key', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual([...ids].sort());
    const codes = ids.map((a) => DEFAULT_BINDINGS[a]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) {
      expect(c).not.toBe(UNBOUND);
      expect(RESERVED_KEYS.has(c), c).toBe(false);
      expect(DEV_KEYS.has(c), c).toBe(false);
      expect(isBindable(c, true), c).toBe(true);
    }
    // The arrows always move (input.ts), so no action takes one.
    for (const c of codes) expect(c.startsWith('Arrow'), c).toBe(false);
  });

  it('are §5.14’s keys', () => {
    expect(DEFAULT_BINDINGS).toEqual({
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
      crouch: 'ControlLeft',
      belt1: 'Digit1',
      belt2: 'Digit2',
      belt3: 'Digit3',
      back: 'Digit4',
    });
    expect(keyLabel(DEFAULT_BINDINGS.crouch)).toBe('L-Ctrl');
    expect(keyLabel(UNBOUND)).toBe('—');
  });

  it('reserved keys and, in developer mode, developer keys cannot be bound', () => {
    for (const k of RESERVED_KEYS) expect(isBindable(k, false)).toBe(false);
    for (const k of DEV_KEYS) {
      expect(isBindable(k, true)).toBe(false);
      expect(isBindable(k, false)).toBe(true);
    }
    expect(isBindable(UNBOUND, false)).toBe(false);
  });

  it('a saved key wins: an action whose new default it took is left unbound, never sharing a key', () => {
    // A player who moved Take to V before V opened the verbs.
    const b = resolveBindings({ pickup: 'KeyV' });
    expect(b.pickup).toBe('KeyV');
    expect(b.verb).toBe(UNBOUND);
    const bound = Object.values(b).filter((c) => c !== UNBOUND);
    expect(new Set(bound).size).toBe(bound.length);
    // A saved reserved key, a non-string and an unknown action are ignored.
    const c = resolveBindings({ lpunch: 'Escape', rpunch: 42, nonsense: 'KeyZ' });
    expect(c.lpunch).toBe('KeyQ');
    expect(c.rpunch).toBe('KeyE');
    expect(Object.keys(c).sort()).toEqual(Object.keys(DEFAULT_BINDINGS).sort());
    // Two saved actions on one key: the first keeps it.
    const d = resolveBindings({ up: 'KeyZ', down: 'KeyZ' });
    expect(d.up).toBe('KeyZ');
    expect(d.down).toBe('KeyS');
  });

  it('rebinding a used key swaps it with the action that had it', () => {
    const b = rebind(DEFAULT_BINDINGS, 'verb', 'KeyG');
    expect(b.verb).toBe('KeyG');
    expect(b.pickup).toBe('KeyV');
  });
});

describe('the gamepad table (§5.14, D-47)', () => {
  it('maps every Standard button once, as §5.14 says', () => {
    expect(PAD_BINDINGS).toEqual({
      0: 'jump', // A
      1: 'crouch', // B (a toggle)
      2: 'lpunch', // X
      3: 'rpunch', // Y
      4: 'verb', // LB: hold the radial
      5: 'throw', // RB: hold to aim
      6: 'lkick', // LT
      7: 'rkick', // RT
      8: 'beltCycle', // Back
      9: 'menu', // Start
      10: 'sprint', // LS click
      11: 'pickup', // RS click
      12: 'stow', // D-pad up
      13: 'place', // D-pad down
      14: 'targetPrev', // D-pad left
      15: 'targetNext', // D-pad right
    });
    const meanings = Object.values(PAD_BINDINGS);
    expect(new Set(meanings).size).toBe(meanings.length);
    // The strikes stay on X/Y and LT/RT; LB/RB and A/B no longer duplicate them.
    for (const b of BUTTONS) expect(meanings.filter((m) => m === b)).toHaveLength(1);
    expect(PAD_BINDINGS[PAD.lb]).not.toMatch(/punch|kick/);
    expect(PAD_BINDINGS[PAD.rb]).not.toMatch(/punch|kick/);
    expect(PAD_BINDINGS[PAD.a]).not.toMatch(/punch|kick/);
    expect(PAD_BINDINGS[PAD.b]).not.toMatch(/punch|kick/);
    // In the modes: A confirms / sets, B cancels, X toggles a placement's drive.
    expect(PAD_MODE).toEqual({ confirm: PAD.a, cancel: PAD.b, drive: PAD.x });
  });

  it('reads a pad: edges against the last frame, both sticks with the dead zone on their length', () => {
    const prev: boolean[] = [];
    const btn = (down: number[]) => Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) }));
    const a = readPad({ axes: [0.1, 0.1, 0.5, -0.6], buttons: btn([PAD.lb, PAD.a]) }, prev);
    expect(a.pressed).toEqual([PAD.a, PAD.lb]);
    expect(a.released).toEqual([]);
    expect([a.lx, a.ly]).toEqual([0, 0]);
    expect([a.rx, a.ry]).toEqual([0.5, -0.6]);
    const b = readPad({ axes: [0.7, 0, 0, 0], buttons: btn([PAD.lb]) }, prev);
    expect(b.pressed).toEqual([]);
    expect(b.released).toEqual([PAD.a]);
    expect(b.held[PAD.lb]).toBe(true);
    expect(b.lx).toBe(0.7);
    expect(deadZone(0.1, 0.1, VERB_UI_TUNING.padStickDead)).toEqual([0, 0]);
  });
});

describe('prefs', () => {
  it('keep the cues off and the gore full by default (realism.test.ts; rule 12)', () => {
    expect(DEFAULT_PREFS.cues).toBe(false);
    expect(DEFAULT_PREFS.gore).toBe('full');
    expect(DEFAULT_PREFS.blood).toBe(true);
    expect(DEFAULT_PREFS.holdToCrouch).toBe(false);
  });

  it('a save from before the gore level keeps its blood toggle as one', () => {
    expect(migratePrefs({ blood: false }).gore).toBe('off');
    expect(migratePrefs({ blood: true }).gore).toBe('full');
    expect(migratePrefs({ gore: 'stylised', blood: false })).toMatchObject({ gore: 'stylised', blood: true });
    expect(migratePrefs({ gore: 'gory' }).gore).toBe('full');
    expect(migratePrefs({ holdToCrouch: true, cues: 'yes' })).toMatchObject({ holdToCrouch: true, cues: false });
  });
});

// ---------------------------------------------------------------------------
// The raw input, through a fake page
// ---------------------------------------------------------------------------

type Handler = (e: never) => void;

class FakePage implements InputEnv {
  readonly handlers = new Map<string, Handler[]>();
  readonly win = {
    addEventListener: (type: string, fn: Handler) => {
      const list = this.handlers.get(type) ?? [];
      list.push(fn);
      this.handlers.set(type, list);
    },
  };
  pad: { axes: number[]; buttons: { pressed: boolean }[] } | null = null;
  pads() {
    return [this.pad];
  }
  readonly pointerLock = null;
  readonly touch = false;
  fire(type: string, e: Record<string, unknown>): { prevented: boolean } {
    const out = { prevented: false };
    const ev = { repeat: false, shiftKey: false, target: null, preventDefault: () => (out.prevented = true), ...e };
    for (const fn of this.handlers.get(type) ?? []) (fn as (e: unknown) => void)(ev);
    return out;
  }
  key(code: string, down = true, extra: Record<string, unknown> = {}) {
    return this.fire(down ? 'keydown' : 'keyup', { code, ...extra });
  }
}

function makeInput(mode: UiMode | null = null): { page: FakePage; input: Input; ui: { mode: UiMode } } {
  const page = new FakePage();
  const input = new Input(null, page);
  const ui = { mode: mode ?? 'idle' };
  if (mode !== null) input.ui = ui;
  return { page, input, ui };
}

describe('Input', () => {
  it('turns bound keys into presses, holds and releases; strikes into presses; G into pickup', () => {
    const { page, input } = makeInput();
    page.key('KeyQ');
    page.key('KeyV');
    page.key('KeyG');
    let f = input.poll();
    expect(f.presses).toEqual(['lpunch']);
    expect(f.pressed).toEqual(['lpunch', 'verb', 'pickup']);
    expect(f.pickup).toBe(true);
    expect([...f.held].sort()).toEqual(['lpunch', 'pickup', 'verb']);
    page.key('KeyV', false);
    f = input.poll();
    expect(f.pressed).toEqual([]);
    expect(f.released).toEqual(['verb']);
    expect(f.held.has('verb')).toBe(false);
    expect(f.held.has('lpunch')).toBe(true);
    // A held key's repeats press nothing.
    page.key('KeyQ', true, { repeat: true });
    expect(input.poll().presses).toEqual([]);
  });

  it('leaves keys typed into a text field to the field', () => {
    const { page, input } = makeInput();
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      const r = page.key('Enter', true, { target: { tagName } });
      expect(r.prevented, tagName).toBe(false);
      page.key('KeyW', true, { target: { tagName } });
    }
    page.key('KeyE', true, { target: { tagName: 'DIV', isContentEditable: true } });
    const f = input.poll();
    expect(f.keys).toEqual([]);
    expect(f.pressed).toEqual([]);
    expect(isTextField({ tagName: 'CANVAS' })).toBe(false);
    expect(isTextField(null)).toBe(false);
  });

  it('Escape opens the menu when idle, and backs out of a verb mode instead while one is open', () => {
    const { page, input, ui } = makeInput('idle');
    page.key('Escape');
    let f = input.poll();
    expect(f.keys).toEqual(['Escape']);
    expect(f.cancel).toBe(false);
    ui.mode = 'second';
    page.key('Escape');
    f = input.poll();
    expect(f.keys).toEqual([]);
    expect(f.cancel).toBe(true);
    expect(input.poll().cancel).toBe(false);
  });

  it('Tab cycles forward, Shift+Tab back (and both are kept from the browser)', () => {
    const { page, input } = makeInput();
    expect(page.key('Tab').prevented).toBe(true);
    page.key('Tab', false);
    page.key('Tab', true, { shiftKey: true });
    page.key('Tab', false);
    page.key('Tab');
    expect(input.poll().cycle).toBe(1);
  });

  it('reports mouse buttons as clicks and holds (never as punches: the verb UI decides), and the wheel in notches', () => {
    const { page, input } = makeInput();
    page.fire('mousemove', { movementX: 5, movementY: -3 });
    // A release with no press seen is nothing.
    page.fire('mouseup', { button: 0 });
    let f = input.poll();
    // No pointer lock: the cursor moved (the radial's) but the camera doesn't turn.
    expect(f.mouse).toEqual({ dx: 5, dy: -3, left: false, right: false });
    expect(f.look.dx).toBe(0);
    expect(f.clicks).toEqual([]);
    expect(f.presses).toEqual([]);
    page.fire('mousedown', { button: 0 });
    page.fire('mousedown', { button: 2 });
    page.fire('mousedown', { button: 1 });
    f = input.poll();
    expect(f.clicks).toEqual([
      { button: 0, down: true },
      { button: 2, down: true },
    ]);
    expect(f.mouse).toMatchObject({ left: true, right: true });
    expect(f.presses).toEqual([]);
    page.fire('mouseup', { button: 2 });
    f = input.poll();
    expect(f.clicks).toEqual([{ button: 2, down: false }]);
    expect(f.mouse).toMatchObject({ left: true, right: false });
    expect(wheelNotches(100, 0)).toBe(1);
    expect(wheelNotches(-3, 1)).toBe(-1);
    expect(wheelNotches(-0.4, 2)).toBe(-1);
    expect(wheelNotches(Number.NaN, 0)).toBe(0);
    // Blur lets go of everything held, marked as the blur's (the verb UI cancels a mode rather than act on it).
    expect(f.lost).toBe(false);
    page.key('ShiftLeft');
    page.fire('mousedown', { button: 2 });
    page.fire('blur', {});
    f = input.poll();
    expect(f.released).toEqual(['sprint']);
    expect(f.held.size).toBe(0);
    expect(f.clicks).toEqual([
      { button: 2, down: true },
      { button: 0, down: false },
      { button: 2, down: false },
    ]);
    expect(f.lost).toBe(true);
    expect(input.poll().lost).toBe(false);
    expect(fullFrame({ moveX: 0, moveY: 0, presses: [], pickup: false, keys: [] }).lost).toBe(false);
  });

  it('fills the camera’s look by the verb UI’s mode: frozen in the radial, no zoom and no stick look while placing, aim while throw-aiming', () => {
    const { page, input, ui } = makeInput('idle');
    page.pad = { axes: [0, 0, 0.8, 0.4], buttons: [] };
    const wheel = () => expect(page.fire('wheel', { deltaY: 100, deltaMode: 0 }).prevented).toBe(true);
    wheel();
    let f = input.poll();
    expect(f.look).toEqual({ dx: 0, dy: 0, stickX: 0.8, stickY: 0.4, zoom: 1, aim: false });
    expect(f.wheel).toBe(1);
    ui.mode = 'radial';
    wheel();
    f = input.poll();
    expect([f.look.stickX, f.look.zoom]).toEqual([0, 0]);
    expect(f.pad?.rx).toBe(0.8);
    ui.mode = 'place';
    wheel();
    f = input.poll();
    // The wheel turns the ghost: the verb UI still gets it.
    expect([f.look.stickX, f.look.zoom, f.wheel]).toEqual([0, 0, 1]);
    ui.mode = 'throwAim';
    f = input.poll();
    expect(f.look).toMatchObject({ stickX: 0.8, aim: true });
    // Without a verb UI, X held is the aim.
    const bare = makeInput(null);
    bare.page.key('KeyX');
    expect(bare.input.poll().look.aim).toBe(true);
  });

  it('walks with the pad’s left stick and opens the menu with Start; every other pad button is the verb UI’s', () => {
    const { page, input } = makeInput();
    const btn = (down: number[]) => Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) }));
    page.pad = { axes: [0.6, -0.8, 0, 0], buttons: btn([PAD.start, PAD.x]) };
    const f = input.poll();
    expect(f.moveX).toBeCloseTo(0.6);
    expect(f.moveY).toBeCloseTo(0.8);
    expect(f.keys).toEqual(['Escape']);
    // X is a punch only once the verb UI says so (it may be the drive toggle).
    expect(f.presses).toEqual([]);
    expect(f.pad?.pressed).toEqual([PAD.x, PAD.start]);
  });

  it('a frame with only DungeonStyle’s fields is a whole frame with nothing else pressed (fullFrame)', () => {
    const f: FullInputFrame = fullFrame({ moveX: 1, moveY: 0, presses: ['lkick'], pickup: false, keys: [] });
    expect(f).toMatchObject({ pressed: [], released: [], cycle: 0, cancel: false, clicks: [], wheel: 0, pad: null });
    expect(f.held.size).toBe(0);
    const a: Action = 'verb';
    expect(f.held.has(a)).toBe(false);
  });
});
