import { DEV } from '../dev';
import { type Button, BUTTONS } from '../sim/fighter';
import { type Action, type Bindings, loadBindings, saveBindings } from './bindings';

export interface InputFrame {
  /** Screen-space movement: x right, y up (−1..1). */
  moveX: number;
  moveY: number;
  presses: Button[];
  /** Pick up / drop weapon pressed this frame. */
  pickup: boolean;

  /** Menu / debug keys pressed this frame (KeyboardEvent.code). */
  keys: string[];
}

const META_KEYS = new Set(['Escape', 'KeyM', 'KeyB', 'Enter', 'NumpadEnter', ...(DEV ? ['KeyL', 'KeyP', 'Period', 'KeyT', 'KeyH', 'Backspace'] : [])]);
const ARROWS: Partial<Record<string, Action>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Keyboard (rebindable) + mouse + gamepad + touch, collapsed into one frame of intent. */
export class Input {
  private readonly held = new Set<Action>();
  private presses: Button[] = [];
  private pickup = false;

  private keys: string[] = [];
  private gpPrev: boolean[] = [];
  private touchMove = { x: 0, y: 0 };
  private codeToAction = new Map<string, Action>();
  bindings: Bindings;
  /** While set, the next key press goes here instead of the game (rebinding). */
  capture: ((code: string) => void) | null = null;
  onAnyInput: (() => void) | null = null;

  constructor(target: HTMLElement) {
    this.bindings = loadBindings();
    this.rebuildMap();
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code);
        return;
      }
      if (e.repeat) return;
      this.onAnyInput?.();
      const action = this.codeToAction.get(e.code) ?? ARROWS[e.code];
      if (action) {
        this.held.add(action);
        if ((BUTTONS as string[]).includes(action)) this.presses.push(action as Button);
        if (action === 'pickup') this.pickup = true;
        e.preventDefault();
      } else if (META_KEYS.has(e.code)) {
        this.keys.push(e.code);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const action = this.codeToAction.get(e.code) ?? ARROWS[e.code];
      if (action) this.held.delete(action);
    });
    window.addEventListener('blur', () => this.held.clear());
    target.addEventListener('mousedown', (e) => {
      this.onAnyInput?.();
      if (e.button === 0) this.presses.push('lpunch');
      else if (e.button === 2) this.presses.push('rpunch');

    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) this.buildTouch();
  }

  setBindings(b: Bindings) {
    this.bindings = b;
    saveBindings(b);
    this.rebuildMap();
    this.held.clear();
  }

  private rebuildMap() {
    this.codeToAction.clear();
    for (const [action, code] of Object.entries(this.bindings) as [Action, string][]) this.codeToAction.set(code, action);
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

  poll(): InputFrame {
    let x = 0;
    let y = 0;
    const h = this.held;
    if (h.has('left')) x -= 1;
    if (h.has('right')) x += 1;
    if (h.has('up')) y += 1;
    if (h.has('down')) y -= 1;
    x += this.touchMove.x;
    y += this.touchMove.y;

    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      if (Math.hypot(ax, ay) > 0.2) {
        x += ax;
        y -= ay;
      }
      // X/LB left punch, Y/RB right punch, A/LT left kick, B/RT right kick.
      const map: [number, Button][] = [
        [2, 'lpunch'], [4, 'lpunch'],
        [3, 'rpunch'], [5, 'rpunch'],
        [0, 'lkick'], [6, 'lkick'],
        [1, 'rkick'], [7, 'rkick'],
      ];
      for (const [i, b] of map) {
        const down = !!gp.buttons[i]?.pressed;
        if (down && !this.gpPrev[i]) {
          this.presses.push(b);
          this.onAnyInput?.();
        }
        this.gpPrev[i] = down;
      }
      if (gp.buttons[9]?.pressed && !this.gpPrev[9]) this.keys.push('Escape');
      // Right stick click / select: pick up or drop a weapon.
      if ((gp.buttons[11]?.pressed && !this.gpPrev[11]) || (gp.buttons[8]?.pressed && !this.gpPrev[8])) this.pickup = true;
      this.gpPrev[11] = !!gp.buttons[11]?.pressed;
      this.gpPrev[8] = !!gp.buttons[8]?.pressed;
      this.gpPrev[9] = !!gp.buttons[9]?.pressed;
      break;
    }
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    const frame = { moveX: x, moveY: y, presses: this.presses, keys: this.keys, pickup: this.pickup };
    this.presses = [];
    this.pickup = false;
    this.keys = [];
    return frame;
  }
}
