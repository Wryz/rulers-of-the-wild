// The verb radial (docs/M1-DESIGN.md §10.7): hold V for up to 8 sectors from verbsFor(world, player, target) (read-only),
// disabled ones greyed with their reason, a virtual cursor with a VERB_UI_TUNING.radialDeadPx dead zone; releasing on
// a sector executes it.
//
// STUB (P31; P35 fills it): the final exported names. Until P35 the radial never opens.
import type { VerbId } from '@wild/sim';

/** One sector: a verb, and why it can't be done now (greyed) or null. */
export interface RadialOption {
  verb: VerbId;
  label: string;
  disabled: string | null;
}

export class Radial {
  readonly isOpen = false;

  constructor(_root: HTMLElement) {}

  open(_options: readonly RadialOption[]): void {}

  /** The cursor moved by (dx, dy) px; returns the sector under it (null inside the dead zone). */
  point(_dx: number, _dy: number): RadialOption | null {
    return null;
  }

  close(): void {}
}
