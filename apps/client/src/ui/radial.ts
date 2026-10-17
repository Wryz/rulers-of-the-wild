// The verb radial (docs/M1-DESIGN.md §10.7, §5.13): hold V (or LB) for up to 8 sectors from verbsFor(world, player,
// target) (read-only), disabled ones greyed with their reason ("too heavy (210 kg)", "needs an edge") so the player
// learns the rule; a virtual cursor with a VERB_UI_TUNING.radialDeadPx dead zone (the mouse moves it; the right stick
// points it); releasing on a sector executes it (input/verbInput.ts does). The sectors run clockwise from the top.
//
// The cursor and sector arithmetic is plain code (tests run it without a page); the DOM is built only with a root.
import type { RefuseReason, VerbId } from '@wild/sim';
import { VERB_UI_TUNING } from '../input/verbInput';

/** One sector: a verb, and why it can't be done now (greyed) or null. */
export interface RadialOption {
  verb: VerbId;
  label: string;
  disabled: string | null;
  /** stow: the slot it stows into (0..2 belt, 3 back). */
  slot?: number;
  /** lash, bend: a second target is chosen next. */
  needsSecond?: boolean;
}

/** The most sectors the radial shows (§10.7). */
export const RADIAL_MAX = 8;

/**
 * The sector under a cursor at (x, y) px from the centre (+y down) among `n` sectors laid clockwise from the top, each
 * centred on its direction; null inside the dead zone or with no sectors.
 */
export function sectorAt(x: number, y: number, n: number, deadPx: number): number | null {
  if (n <= 0 || !(Math.hypot(x, y) > deadPx)) return null;
  // Angle clockwise from straight up.
  const a = Math.atan2(x, -y);
  const turn = (a < 0 ? a + 2 * Math.PI : a) / (2 * Math.PI);
  return Math.floor(turn * n + 0.5) % n;
}

/** The direction of sector `i` of `n` (unit, screen: +y down). */
export function sectorDir(i: number, n: number): { x: number; y: number } {
  const a = (i / n) * 2 * Math.PI;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/** The words for a refusal (§5.13: the player learns the rule), with the target's mass where it says why. */
export function reasonText(reason: RefuseReason, massKg?: number): string {
  const kg = massKg !== undefined && Number.isFinite(massKg) ? ` (${Math.round(massKg)} kg)` : '';
  switch (reason) {
    case 'noTarget':
      return 'nothing to act on';
    case 'outOfRange':
      return 'too far';
    case 'outOfReach':
      return 'out of reach';
    case 'badAnchor':
      return 'no hold there';
    case 'cantAct':
      return "can't now";
    case 'busy':
      return 'busy';
    case 'immovable':
      return "won't move";
    case 'tooHeavy':
      return `too heavy${kg}`;
    case 'tooLong':
      return 'too long';
    case 'handsFull':
      return 'hands full';
    case 'handsEmpty':
      return 'hands empty';
    case 'slotFull':
      return 'slot full';
    case 'slotEmpty':
      return 'slot empty';
    case 'notATool':
      return 'only a tool or a bundle';
    case 'dragging':
      return 'dragging';
    case 'ropeEnd':
      return 'holding a rope end';
    case 'noEdge':
      return 'needs an edge';
    case 'tooHard':
      return 'too hard for it';
    case 'fullySharp':
      return 'already sharp';
    case 'ropeLike':
      return "rope can't be shaped";
    case 'noRope':
      return 'needs rope';
    case 'ropeTooShort':
      return 'rope too short';
    case 'notTied':
      return 'not tied';
    case 'noRopeEnd':
      return 'no free end in reach';
    case 'notRooted':
      return 'not rooted';
    case 'notSpringy':
      return 'not springy';
    case 'tooThick':
      return 'too thick';
    case 'tooStiff':
      return 'too stiff';
    case 'noSupport':
      return 'nothing to rest on';
    case 'blocked':
      return 'something in the way';
    case 'noDigTool':
      return 'needs a digging tool or empty hands';
  }
}

const STYLE_ID = 'rotw-radial-style';
const CSS = `
.rotw-radial { position: fixed; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; z-index: 30; display: none; }
.rotw-radial.show { display: block; }
.rotw-radial .ring { position: absolute; border-radius: 50%; border: 2px solid rgba(255,255,255,0.18);
  background: radial-gradient(rgba(10,14,12,0.55), rgba(10,14,12,0.25)); transform: translate(-50%, -50%); }
.rotw-radial .opt { position: absolute; transform: translate(-50%, -50%); min-width: 84px; padding: 6px 10px; border-radius: 8px;
  font: 600 14px/1.2 system-ui, sans-serif; color: #f3efe2; text-align: center; background: rgba(20,26,22,0.78);
  border: 1px solid rgba(255,255,255,0.15); }
.rotw-radial .opt small { display: block; font-weight: 400; font-size: 11px; color: #c8b98a; }
.rotw-radial .opt.off { color: rgba(243,239,226,0.45); }
.rotw-radial .opt.sel { background: rgba(214,170,74,0.9); color: #1b1408; border-color: #ffe7a6; }
.rotw-radial .opt.sel.off { background: rgba(120,110,90,0.8); color: #2a2418; }
.rotw-radial .opt.sel small { color: #3a2a0c; }
.rotw-radial .cursor { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: #ffe7a6; }
.rotw-radial .empty { position: absolute; transform: translate(-50%, -50%); font: 500 14px system-ui, sans-serif; color: #f3efe2;
  background: rgba(20,26,22,0.78); padding: 6px 10px; border-radius: 8px; white-space: nowrap; }`;

export class Radial {
  private open_ = false;
  private options: RadialOption[] = [];
  private cx = 0;
  private cy = 0;
  private readonly el: HTMLDivElement | null = null;
  private readonly cursorEl: HTMLDivElement | null = null;
  private optionEls: HTMLDivElement[] = [];

  constructor(root: HTMLElement | null) {
    if (!root || typeof document === 'undefined') return;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.el = document.createElement('div');
    this.el.className = 'rotw-radial';
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'cursor';
    root.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** The options shown (at most RADIAL_MAX). */
  get shown(): readonly RadialOption[] {
    return this.options;
  }

  /** The virtual cursor (px from the centre, +y down). */
  get cursor(): { x: number; y: number } {
    return { x: this.cx, y: this.cy };
  }

  /** The option under the cursor (null inside the dead zone). */
  get selected(): RadialOption | null {
    const i = sectorAt(this.cx, this.cy, this.options.length, VERB_UI_TUNING.radialDeadPx);
    return i === null ? null : this.options[i];
  }

  open(options: readonly RadialOption[]): void {
    this.options = options.slice(0, RADIAL_MAX);
    this.open_ = true;
    this.cx = 0;
    this.cy = 0;
    this.build();
    this.draw();
  }

  /** The mouse moved by (dx, dy) px; returns the sector under the cursor (null inside the dead zone). */
  point(dx: number, dy: number): RadialOption | null {
    if (!this.open_) return null;
    this.cx += dx;
    this.cy += dy;
    // The cursor stays on the ring: past it, moving on only turns it.
    const max = VERB_UI_TUNING.radialRadiusPx;
    const l = Math.hypot(this.cx, this.cy);
    if (l > max) {
      this.cx *= max / l;
      this.cy *= max / l;
    }
    this.draw();
    return this.selected;
  }

  /** The right stick points the cursor: deflected past radialStickMin it points at a sector, else the centre. */
  stick(x: number, y: number): RadialOption | null {
    if (!this.open_) return null;
    const l = Math.hypot(x, y);
    const r = VERB_UI_TUNING.radialRadiusPx;
    if (l > VERB_UI_TUNING.radialStickMin) {
      this.cx = (x / l) * r;
      this.cy = (y / l) * r;
    } else {
      this.cx = 0;
      this.cy = 0;
    }
    this.draw();
    return this.selected;
  }

  close(): void {
    this.open_ = false;
    this.el?.classList.remove('show');
  }

  private build(): void {
    const el = this.el;
    if (!el) return;
    el.innerHTML = '';
    const r = VERB_UI_TUNING.radialRadiusPx;
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.width = ring.style.height = `${2 * (r + 26)}px`;
    el.appendChild(ring);
    this.optionEls = [];
    if (this.options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing to do here';
      el.appendChild(empty);
    }
    this.options.forEach((o, i) => {
      const d = sectorDir(i, this.options.length);
      const div = document.createElement('div');
      div.className = `opt${o.disabled ? ' off' : ''}`;
      div.style.left = `${d.x * r}px`;
      div.style.top = `${d.y * r}px`;
      div.textContent = o.label;
      if (o.disabled) {
        const small = document.createElement('small');
        small.textContent = o.disabled;
        div.appendChild(small);
      }
      el.appendChild(div);
      this.optionEls.push(div);
    });
    if (this.cursorEl) el.appendChild(this.cursorEl);
    el.classList.add('show');
  }

  private draw(): void {
    if (!this.el) return;
    const sel = sectorAt(this.cx, this.cy, this.options.length, VERB_UI_TUNING.radialDeadPx);
    this.optionEls.forEach((div, i) => div.classList.toggle('sel', i === sel));
    if (this.cursorEl) {
      this.cursorEl.style.left = `${this.cx}px`;
      this.cursorEl.style.top = `${this.cy}px`;
    }
  }
}
