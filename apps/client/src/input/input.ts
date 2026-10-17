// Input (docs/M1-DESIGN.md §5.14, §10.7): keyboard (rebindable), mouse (pointer lock, buttons, wheel), gamepad (the
// Standard mapping) and touch, collapsed into one frame of intent per rendered frame. It decides nothing about verbs:
// input/verbInput.ts turns a frame into commands, and the verb modes consume clicks and pad buttons before they become
// strikes. What this file does decide is the camera's look (InputFrame.look), from the verb UI's mode as of the last
// frame (`ui`): no look while the radial is open, no zoom while placing (the wheel rotates the ghost), the stick turns
// the placement rather than the camera, and the aim camera while throw-aiming.
import { type Button, BUTTONS } from '@wild/sim';
import { DEV } from '../dev';
import { type Action, type Bindings, loadBindings, PAD, saveBindings, UNBOUND } from './bindings';
import { type UiMode, VERB_UI_TUNING } from './verbInput';

/** The camera's input this frame (CameraPort.update's `look`; render/followCam.ts LookInput). */
export interface LookFrame {
  /** Pointer-locked mouse movement this frame (px; +x right, +y down). */
  dx: number;
  dy: number;
  /** The right stick held this frame (−1..1, dead zone applied; +y down). */
  stickX: number;
  stickY: number;
  /** Wheel notches this frame (+ out). */
  zoom: number;
  /** The throw aim is held: the over-the-shoulder aim camera. */
  aim: boolean;
}

/** The first connected gamepad this frame (Standard mapping), or nothing. */
export interface PadFrame {
  /** Buttons held, by index. */
  held: readonly boolean[];
  /** Buttons that went down / up this frame, by index. */
  pressed: number[];
  released: number[];
  /** Left stick (dead zone applied; +y down, as the pad reports it). */
  lx: number;
  ly: number;
  /** Right stick (dead zone applied; +y down). */
  rx: number;
  ry: number;
}

/**
 * One rendered frame of input. The first five fields are DungeonStyle's; the rest are §10.7's and optional, so a frame
 * built with only DS's fields (the loop's and the panel's tests) still is one: absent means nothing pressed, held or
 * moved (fullFrame fills them in). Input.poll always fills every field.
 */
export interface InputFrame {
  /** Screen-space movement: x right, y up (−1..1). */
  moveX: number;
  moveY: number;
  /** Strike presses from the keyboard and touch (the mouse's are in `clicks`, the pad's in `pad`: the verb UI decides). */
  presses: Button[];
  /** Take / drop pressed this frame (the keyboard's; the pad's RS click is in `pad`). */
  pickup: boolean;
  /** Menu / debug keys pressed this frame (KeyboardEvent.code). */
  keys: string[];
  /** Every bound action whose key went down this frame, in order. */
  pressed?: Action[];
  /** Bound actions whose key is down. */
  held?: ReadonlySet<Action>;
  /** Bound actions whose key went up this frame (V, X and C release their modes). */
  released?: Action[];
  /** Target cycling this frame: +1 per Tab, −1 per Shift+Tab. */
  cycle?: number;
  /** Escape while a verb mode is open: it cancels the mode instead of opening the menu. */
  cancel?: boolean;
  /** Raw mouse movement this frame (px, locked or not: the radial's virtual cursor) and the buttons held. */
  mouse?: { dx: number; dy: number; left: boolean; right: boolean };
  /** Mouse button edges this frame; the verb modes consume them before they become punches. */
  clicks?: { button: 0 | 2; down: boolean }[];
  /** Wheel notches this frame (+ toward you: zoom out). */
  wheel?: number;
  /** The camera's look (pointer-locked mouse + right stick + wheel zoom + aim), filtered by the verb UI's mode. */
  look?: LookFrame;
  pad?: PadFrame | null;
}

/** A frame with every field present. */
export type FullInputFrame = Required<InputFrame>;

const NO_HELD: ReadonlySet<Action> = new Set();

/** The frame with its absent §10.7 fields filled in (nothing pressed, held or moved). */
export function fullFrame(f: InputFrame): FullInputFrame {
  return {
    moveX: f.moveX,
    moveY: f.moveY,
    presses: f.presses,
    pickup: f.pickup,
    keys: f.keys,
    pressed: f.pressed ?? [],
    held: f.held ?? NO_HELD,
    released: f.released ?? [],
    cycle: f.cycle ?? 0,
    cancel: f.cancel ?? false,
    mouse: f.mouse ?? { dx: 0, dy: 0, left: false, right: false },
    clicks: f.clicks ?? [],
    wheel: f.wheel ?? 0,
    look: f.look ?? { dx: 0, dy: 0, stickX: 0, stickY: 0, zoom: 0, aim: false },
    pad: f.pad ?? null,
  };
}

/** The verb UI as the input sees it (input/verbInput.ts's VerbInput). */
export interface UiModeSource {
  readonly mode: UiMode;
}

/** What `readPad` reads of a Gamepad. */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
}

/** The page as the input sees it (the browser's by default; tests pass fakes). */
export interface InputEnv {
  /** Where keyboard, mouse movement, button release and blur events come from (window). */
  readonly win: { addEventListener(type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): void };
  /** The connected gamepads. */
  pads(): readonly (GamepadLike | null)[];
  /** Pointer lock on the canvas (null: none, as in tests). */
  readonly pointerLock: { locked(): boolean; request(): void; exit(): void } | null;
  /** Build the touch controls (a touch screen). */
  readonly touch: boolean;
}

const META_KEYS = new Set(['Escape', 'KeyM', 'KeyB', 'Enter', 'NumpadEnter', ...(DEV ? ['KeyL', 'KeyP', 'Period', 'KeyT', 'KeyH', 'Backspace'] : [])]);
const ARROWS: Partial<Record<string, Action>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** A keyboard event typed into a text field is the field's, not the game's (Enter's preventDefault breaks fields). */
export function isTextField(t: unknown): boolean {
  const el = t as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el !== 'object') return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** A wheel event's movement as notches (+ toward you): pixels per notch and lines per notch from VERB_UI_TUNING. */
export function wheelNotches(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === DOM_DELTA_PAGE) return Math.sign(deltaY);
  if (deltaMode === DOM_DELTA_LINE) return deltaY / VERB_UI_TUNING.wheelLinesPerNotch;
  return deltaY / VERB_UI_TUNING.wheelPxPerNotch;
}

/** A stick's (x, y) with the dead zone applied to its length: (0, 0) inside it, as reported outside it (DS). */
export function deadZone(x: number, y: number, dead: number): [number, number] {
  return Math.hypot(x, y) > dead ? [x, y] : [0, 0];
}

/** One frame of a gamepad against the buttons held last frame (`prev`, updated in place). */
export function readPad(gp: GamepadLike, prev: boolean[]): PadFrame {
  const dead = VERB_UI_TUNING.padStickDead;
  const held: boolean[] = [];
  const pressed: number[] = [];
  const released: number[] = [];
  const n = Math.max(gp.buttons.length, prev.length);
  for (let i = 0; i < n; i++) {
    const down = !!gp.buttons[i]?.pressed;
    held[i] = down;
    if (down && !prev[i]) pressed.push(i);
    else if (!down && prev[i]) released.push(i);
    prev[i] = down;
  }
  const [lx, ly] = deadZone(gp.axes[0] ?? 0, gp.axes[1] ?? 0, dead);
  const [rx, ry] = deadZone(gp.axes[2] ?? 0, gp.axes[3] ?? 0, dead);
  return { held, pressed, released, lx, ly, rx, ry };
}

/** The browser's page. */
function browserEnv(target: HTMLElement): InputEnv {
  const canLock = typeof target.requestPointerLock === 'function';
  return {
    win: window as unknown as InputEnv['win'],
    pads: () => navigator.getGamepads?.() ?? [],
    pointerLock: canLock
      ? {
          locked: () => document.pointerLockElement === target,
          request: () => {
            // (Some browsers return a promise that rejects when the request is refused: nothing to do then.)
            const r = target.requestPointerLock() as unknown;
            if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
          },
          exit: () => document.exitPointerLock?.(),
        }
      : null,
    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  };
}

/** Keyboard (rebindable) + mouse + gamepad + touch, collapsed into one frame of intent. */
export class Input {
  private readonly held = new Set<Action>();
  private presses: Button[] = [];
  private pressed: Action[] = [];
  private released: Action[] = [];
  private pickup = false;
  private cycle = 0;
  private cancel = false;
  private keys: string[] = [];
  private clicks: { button: 0 | 2; down: boolean }[] = [];
  private mouseDx = 0;
  private mouseDy = 0;
  private lookDx = 0;
  private lookDy = 0;
  private wheel = 0;
  private mouseLeft = false;
  private mouseRight = false;
  private gpPrev: boolean[] = [];
  private touchMove = { x: 0, y: 0 };
  private codeToAction = new Map<string, Action>();
  private readonly env: InputEnv;
  bindings: Bindings;
  /** While set, the next key press goes here instead of the game (rebinding). */
  capture: ((code: string) => void) | null = null;
  onAnyInput: (() => void) | null = null;
  /**
   * The verb UI (main.ts sets it to the VerbInput): its mode decides what the camera's look gets and whether Escape
   * cancels a mode or opens the menu. Without it the look is the raw input and Escape is always the menu.
   */
  ui: UiModeSource | null = null;

  constructor(target: HTMLElement | null, env?: InputEnv) {
    if (!env && !target) throw new Error('Input: a canvas or an environment is needed');
    this.env = env ?? browserEnv(target!);
    this.bindings = loadBindings();
    this.rebuildMap();
    const win = this.env.win;
    win.addEventListener('keydown', (e: KeyboardEvent) => this.keyDown(e));
    win.addEventListener('keyup', (e: KeyboardEvent) => this.keyUp(e));
    win.addEventListener('blur', () => this.clearHeld());
    win.addEventListener('mousemove', (e: MouseEvent) => this.mouseMove(e));
    win.addEventListener('mouseup', (e: MouseEvent) => this.mouseButton(e.button, false));
    // The canvas's own events (a test's page has no canvas: they come from its window then).
    const surface = target ?? win;
    surface.addEventListener('mousedown', (e: MouseEvent) => this.mouseDown(e));
    surface.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault());
    surface.addEventListener('wheel', (e: WheelEvent) => this.wheelMoved(e), { passive: false });
    if (target) {
      if (!DEV) {
        // Crouch is Ctrl: Ctrl+W closes the tab and a page can't stop it, so the page asks first (§5.14). (Not in
        // developer mode, whose rebuild reloads the page.)
        window.addEventListener('beforeunload', (e) => {
          e.preventDefault();
          e.returnValue = '';
        });
      }
      // In fullscreen the keyboard can be locked, so Ctrl+W reaches the game (§5.14).
      document.addEventListener('fullscreenchange', () => {
        const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
        if (document.fullscreenElement) kb?.lock?.().catch(() => {});
        else kb?.unlock?.();
      });
    }
    if (target && this.env.touch) this.buildTouch();
  }

  setBindings(b: Bindings) {
    this.bindings = b;
    saveBindings(b);
    this.rebuildMap();
    this.held.clear();
  }

  /** Releases the pointer (a menu opens). */
  releasePointer(): void {
    if (this.env.pointerLock?.locked()) this.env.pointerLock.exit();
  }

  private rebuildMap() {
    this.codeToAction.clear();
    for (const [action, code] of Object.entries(this.bindings) as [Action, string][]) if (code !== UNBOUND) this.codeToAction.set(code, action);
  }

  private get mode(): UiMode {
    return this.ui?.mode ?? 'idle';
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private keyDown(e: KeyboardEvent): void {
    if (this.capture) {
      e.preventDefault();
      const cb = this.capture;
      this.capture = null;
      cb(e.code);
      return;
    }
    if (isTextField(e.target)) return;
    if (e.repeat) {
      // Holding Tab mustn't move the browser's focus either.
      if (this.codeToAction.has(e.code) || ARROWS[e.code]) e.preventDefault();
      return;
    }
    this.onAnyInput?.();
    const action = this.codeToAction.get(e.code) ?? ARROWS[e.code];
    if (action) {
      this.held.add(action);
      this.pressed.push(action);
      if ((BUTTONS as string[]).includes(action)) this.presses.push(action as Button);
      if (action === 'pickup') this.pickup = true;
      if (action === 'target') this.cycle += e.shiftKey ? -1 : 1;
      e.preventDefault();
    } else if (e.code === 'Escape' && this.mode !== 'idle') {
      // Escape backs out of a verb mode (radial, second target, aim, placement) before it opens the menu.
      this.cancel = true;
      e.preventDefault();
    } else if (META_KEYS.has(e.code)) {
      this.keys.push(e.code);
      e.preventDefault();
    }
  }

  private keyUp(e: KeyboardEvent): void {
    const action = this.codeToAction.get(e.code) ?? ARROWS[e.code];
    if (action && this.held.delete(action)) this.released.push(action);
  }

  private clearHeld(): void {
    for (const a of this.held) this.released.push(a);
    this.held.clear();
    if (this.mouseLeft) this.clicks.push({ button: 0, down: false });
    if (this.mouseRight) this.clicks.push({ button: 2, down: false });
    this.mouseLeft = false;
    this.mouseRight = false;
  }

  private mouseMove(e: MouseEvent): void {
    const dx = e.movementX ?? 0;
    const dy = e.movementY ?? 0;
    this.mouseDx += dx;
    this.mouseDy += dy;
    // The camera turns only under pointer lock (moving the cursor over the page mustn't spin it).
    if (this.env.pointerLock?.locked()) {
      this.lookDx += dx;
      this.lookDy += dy;
    }
  }

  private mouseDown(e: MouseEvent): void {
    this.onAnyInput?.();
    const lock = this.env.pointerLock;
    if (lock && !lock.locked()) {
      // The click that captures the pointer is only that (§5.14: click to lock, Esc releases).
      lock.request();
      return;
    }
    this.mouseButton(e.button, true);
  }

  private mouseButton(button: number, down: boolean): void {
    if (button !== 0 && button !== 2) return;
    const was = button === 0 ? this.mouseLeft : this.mouseRight;
    if (was === down) return;
    if (button === 0) this.mouseLeft = down;
    else this.mouseRight = down;
    this.clicks.push({ button, down });
  }

  private wheelMoved(e: WheelEvent): void {
    e.preventDefault();
    this.wheel += wheelNotches(e.deltaY, e.deltaMode);
  }

  private buildTouch() {
    const wrap = document.createElement('div');
    wrap.className = 'touch';
    wrap.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <div class="tbtns">
        <button data-b="lpunch">L PUNCH</button><button data-b="rpunch">R PUNCH</button>
        <button data-b="lkick">L KICK</button><button data-b="rkick">R KICK</button>
      </div>`;
    document.body.appendChild(wrap);
    document.body.classList.add('has-touch');
    const stick = wrap.querySelector<HTMLDivElement>('.stick')!;
    const knob = wrap.querySelector<HTMLDivElement>('.knob')!;
    let id: number | null = null;
    const update = (t: Touch) => {
      const r = stick.getBoundingClientRect();
      let x = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let y = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const l = Math.hypot(x, y);
      if (l > 1) {
        x /= l;
        y /= l;
      }
      this.touchMove = { x, y: -y };
      knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
    };
    stick.addEventListener('touchstart', (e) => {
      this.onAnyInput?.();
      const t = e.changedTouches[0];
      id = t.identifier;
      update(t);
      e.preventDefault();
    });
    stick.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) if (t.identifier === id) update(t);
      e.preventDefault();
    });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === id) {
          id = null;
          this.touchMove = { x: 0, y: 0 };
          knob.style.transform = '';
        }
      }
    };
    stick.addEventListener('touchend', end);
    stick.addEventListener('touchcancel', end);
    for (const b of Array.from(wrap.querySelectorAll<HTMLButtonElement>('button'))) {
      b.addEventListener('touchstart', (e) => {
        this.onAnyInput?.();
        this.presses.push(b.dataset.b as Button);
        b.classList.add('down');
        e.preventDefault();
      });
      b.addEventListener('touchend', () => b.classList.remove('down'));
    }
  }

  // ---------------------------------------------------------------------------
  // The frame
  // ---------------------------------------------------------------------------

  poll(): FullInputFrame {
    let x = 0;
    let y = 0;
    const h = this.held;
    if (h.has('left')) x -= 1;
    if (h.has('right')) x += 1;
    if (h.has('up')) y += 1;
    if (h.has('down')) y -= 1;
    x += this.touchMove.x;
    y += this.touchMove.y;

    let pad: PadFrame | null = null;
    for (const gp of this.env.pads()) {
      if (!gp) continue;
      pad = readPad(gp, this.gpPrev);
      // The left stick walks (DS: its dead zone on the stick's length, y inverted).
      x += pad.lx;
      y -= pad.ly;
      if (pad.pressed.length > 0) this.onAnyInput?.();
      // Start opens the menu (DS); every other button is the verb UI's.
      if (pad.pressed.includes(PAD.start)) this.keys.push('Escape');
      break;
    }
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }

    // The camera's look, from the verb UI's mode: frozen while the radial is open; the stick turns the placement, not
    // the camera, while placing; the wheel zooms unless a mode uses it; the aim camera while throw-aiming.
    const mode = this.mode;
    const radial = mode === 'radial';
    const stickLook = !radial && mode !== 'place';
    const look: LookFrame = {
      dx: radial ? 0 : this.lookDx,
      dy: radial ? 0 : this.lookDy,
      stickX: stickLook && pad ? pad.rx : 0,
      stickY: stickLook && pad ? pad.ry : 0,
      zoom: radial || mode === 'place' ? 0 : this.wheel,
      aim: this.ui ? mode === 'throwAim' : this.held.has('throw'),
    };

    const frame: FullInputFrame = {
      moveX: x,
      moveY: y,
      presses: this.presses,
      pickup: this.pickup,
      keys: this.keys,
      pressed: this.pressed,
      held: new Set(this.held),
      released: this.released,
      cycle: this.cycle,
      cancel: this.cancel,
      mouse: { dx: this.mouseDx, dy: this.mouseDy, left: this.mouseLeft, right: this.mouseRight },
      clicks: this.clicks,
      wheel: this.wheel,
      look,
      pad,
    };
    this.presses = [];
    this.pressed = [];
    this.released = [];
    this.pickup = false;
    this.keys = [];
    this.clicks = [];
    this.cycle = 0;
    this.cancel = false;
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.lookDx = 0;
    this.lookDy = 0;
    this.wheel = 0;
    return frame;
  }
}
