import type { Vector3 } from 'three';
import type { Button } from './fighter';

/**
 * Player input reaches the sim only as tick-tagged commands (docs/SPEC.md, Technical
 * architecture → Commands). The game loop turns each frame's input into commands for the
 * next tick; the sim applies every command due at the start of that tick. Networking
 * later only changes where the commands come from.
 */

/** Move directions are sent as 1/256ths of a full turn, speeds as 1/256ths of full speed. */
export const COMMAND_STEPS = 256;

export type CommandButton = Button | 'pickup';

export type Command =
  /** Walk direction on the ground plane: `dir` in 1/256ths of a turn from +z toward +x, `speed` in 1/256ths. */
  | { tick: number; player: number; kind: 'move'; dir: number; speed: number }
  /** A punch, kick (or a parry: a punch as a strike lands), or pick up / drop. */
  | { tick: number; player: number; kind: 'button'; button: CommandButton };

/** A move command for a world-space walk vector (x, z), length 0..1. */
export function moveCommand(tick: number, player: number, x: number, z: number): Command {
  const len = Math.hypot(x, z);
  const speed = Math.round(len * COMMAND_STEPS);
  if (speed === 0) return { tick, player, kind: 'move', dir: 0, speed: 0 };
  const turn = Math.atan2(x, z) / (Math.PI * 2);
  const dir = ((Math.round(turn * COMMAND_STEPS) % COMMAND_STEPS) + COMMAND_STEPS) % COMMAND_STEPS;
  return { tick, player, kind: 'move', dir, speed };
}

/** Decodes a move command into a walk vector (y = 0). */
export function moveVector(c: { dir: number; speed: number }, out: Vector3): Vector3 {
  if (c.speed === 0) return out.set(0, 0, 0);
  const a = (c.dir / COMMAND_STEPS) * Math.PI * 2;
  const s = c.speed / COMMAND_STEPS;
  return out.set(Math.sin(a) * s, 0, Math.cos(a) * s);
}

/** Commands waiting for their tick, kept in the order they were queued. */
export class CommandQueue {
  private pending: Command[] = [];

  push(c: Command) {
    // Only the last walk direction for a tick matters, so a newer one replaces it (keeps
    // the queue small while the loop isn't stepping: paused, or frozen in a hit-pause).
    if (c.kind === 'move') {
      const i = this.pending.findIndex((o) => o.kind === 'move' && o.tick === c.tick && o.player === c.player);
      if (i >= 0) {
        this.pending[i] = c;
        return;
      }
    }
    this.pending.push(c);
  }

  /** Removes and returns every command due at or before `tick`, in queued order. */
  take(tick: number): Command[] {
    if (this.pending.length === 0) return [];
    const due: Command[] = [];
    const later: Command[] = [];
    for (const c of this.pending) (c.tick <= tick ? due : later).push(c);
    this.pending = later;
    return due;
  }

  get length() {
    return this.pending.length;
  }

  clear() {
    this.pending.length = 0;
  }
}
