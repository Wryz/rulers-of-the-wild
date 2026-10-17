import type { Vector3 } from 'three';
import type { Button } from './fighter';

/**
 * Player input reaches the sim only as tick-tagged commands (docs/SPEC.md, Technical
 * architecture → Commands). The game loop turns each frame's input into commands for the
 * next tick; the sim applies every command due at the start of that tick. Networking
 * later only changes where the commands come from.
 *
 * Every field is an integer (except a `setTuning` value), so a command log is exact JSON
 * and a replay of it reproduces the run (docs/M1-DESIGN.md §1.5.3).
 *
 * `player` is the player number (1 for the local player, whose credit id is 'p1'); a
 * World maps it to that player's fighter (World.players). A legacy `CombatSim` without a
 * world keeps M0's reading: the id of the fighter the command drives.
 */

/** Move directions are sent as 1/256ths of a full turn, speeds as 1/256ths of full speed. */
export const COMMAND_STEPS = 256;

/** `move.flags` bits. */
export const MOVE_SPRINT = 1;
export const MOVE_CROUCH = 2;

/** Throw aim (`verb.aim`) is sent in 1/4096ths of a turn (0.088°: 3 cm of lateral error at 20 m). */
export const AIM_STEPS = 4096;

/** World points (`verb.at`, `verb.at2`) are sent in whole centimetres. */
export const CM_PER_M = 100;

// TODO(P02a): add 'jump' here (docs/M1-DESIGN.md §1.5.3: `CommandButton = Button | 'pickup' | 'jump'`) in the same
// change that makes combat.ts handle it (button 'jump' sets jumpRequest = MOVE_TUNING.jumpBufferFrames, §3 phase 1a).
// HEAD's applyCommands (combat.ts) passes every button but 'pickup' to Fighter.press(Button), so the union can't
// carry 'jump' until that handler exists without breaking the typecheck.
export type CommandButton = Button | 'pickup';

/** Every verb a `verb` command can carry. Strikes, cutting by swing and strike-digging stay `button` commands. */
export type VerbId =
  | 'focus'
  | 'take'
  | 'drop'
  | 'stow'
  | 'draw'
  | 'place'
  | 'throw'
  | 'lash'
  | 'tie'
  | 'untie'
  | 'bend'
  | 'shape'
  | 'cut'
  | 'dig'
  | 'pull';

/** Walk direction on the ground plane: `dir` in 1/256ths of a turn from +z toward +x, `speed` in 1/256ths. */
export interface MoveCommand {
  tick: number;
  player: number;
  kind: 'move';
  dir: number;
  speed: number;
  /** MOVE_SPRINT | MOVE_CROUCH; absent = 0. */
  flags?: number;
}

/** A punch, kick (or a parry: a punch as a strike lands), or pick up / drop. */
export interface ButtonCommand {
  tick: number;
  player: number;
  kind: 'button';
  button: CommandButton;
}

/** One verb (docs/M1-DESIGN.md §5.0). The sim validates every field; the client is never trusted. */
export interface VerbCommand {
  tick: number;
  player: number;
  kind: 'verb';
  verb: VerbId;
  /** Entity id; 0 = none / the ground (with `at`). */
  target: number;
  /** The second entity (lash, bend). */
  second?: number;
  /** World point in whole cm: the anchor on `target`, the place position, the dig, shape or focus point. */
  at?: [number, number, number];
  /** World point in whole cm: the anchor on `second`. */
  at2?: [number, number, number];
  /** 0..255 (1/256 turn). */
  yaw?: number;
  /** 0..255: 0 lying, 64 upright, 32 angled (place). */
  pitch?: number;
  /** Throw yaw and pitch in 1/AIM_STEPS turn. */
  aim?: [number, number];
  /** 0..255: throw strength; continuous verbs (pull, shape, hand-dig): > 0 on, 0 off. */
  charge?: number;
  /** stow/draw: 0..2 belt, 3 back. */
  slot?: number;
  /** place: absent = drive iff the object has a sharp point at its top end; 1 = drive; 0 = never. */
  drive?: number;
}

/** Developer operations (docs/M1-DESIGN.md §1.3 world/devOps.ts), applied in phase 1c of their tick. */
export type DevOp =
  | 'spawnApe'
  | 'spawnGiant'
  | 'giveTool'
  | 'teleport'
  | 'pauseMinds'
  | 'killCreature'
  | 'respawnPlayer'
  | 'setTuning';

/** A live tuning edit carried by `meta 'dev' setTuning`; `key` is a dotted path for nested tables ('ape.vSafe'). */
export interface TuningEdit {
  table: string;
  key: string;
  value: number | boolean | string;
}

export interface MetaCommand {
  tick: number;
  player: number;
  kind: 'meta';
  /**
   * 'save' asks the world to write a save at the end of the tick; 'dev' is applied in phase 1c through
   * world/devOps.ts (setTuning through registry.setTuningValue, so live tuning is in the command log and a replay
   * reproduces it). 'pause' and 'timeAway' belong to the client and to M3.
   */
  meta: 'pause' | 'save' | 'timeAway' | 'dev';
  // TODO open question SPEC:982 (world alive while closed?): default no — the hidden tab pauses, time away only
  // reaches traplines (M3).
  /** 'timeAway': whole seconds the game was closed (wall-clock time enters the sim only this way). */
  seconds?: number;
  dev?: { op: DevOp; args: number[]; tuning?: TuningEdit };
}

export type Command = MoveCommand | ButtonCommand | VerbCommand | MetaCommand;

/** A move command for a world-space walk vector (x, z), length 0..1, with optional MOVE_* flags. */
export function moveCommand(tick: number, player: number, x: number, z: number, flags = 0): MoveCommand {
  const len = Math.hypot(x, z);
  const speed = Math.round(len * COMMAND_STEPS);
  let dir = 0;
  if (speed !== 0) {
    const turn = Math.atan2(x, z) / (Math.PI * 2);
    dir = ((Math.round(turn * COMMAND_STEPS) % COMMAND_STEPS) + COMMAND_STEPS) % COMMAND_STEPS;
  }
  const c: MoveCommand = { tick, player, kind: 'move', dir, speed };
  if (flags !== 0) c.flags = flags;
  return c;
}

/** Decodes a move command into a walk vector (y = 0). */
export function moveVector(c: { dir: number; speed: number }, out: Vector3): Vector3 {
  if (c.speed === 0) return out.set(0, 0, 0);
  const a = (c.dir / COMMAND_STEPS) * Math.PI * 2;
  const s = c.speed / COMMAND_STEPS;
  return out.set(Math.sin(a) * s, 0, Math.cos(a) * s);
}

/** A world point (m) as a command's whole-centimetre triple. */
export function toCm(p: { x: number; y: number; z: number }): [number, number, number] {
  return [whole(p.x * CM_PER_M), whole(p.y * CM_PER_M), whole(p.z * CM_PER_M)];
}

/** Rounds to an integer, never −0 (JSON writes −0 as 0, so a −0 field would not round-trip exactly). */
function whole(v: number): number {
  return Math.round(v) + 0;
}

/** A command's whole-centimetre triple as a world point (m). */
export function fromCm(at: readonly [number, number, number], out: Vector3): Vector3 {
  return out.set(at[0] / CM_PER_M, at[1] / CM_PER_M, at[2] / CM_PER_M);
}

/**
 * A throw direction as `verb.aim`: yaw in [0, AIM_STEPS) from +z toward +x (the move convention), pitch in
 * [−AIM_STEPS/4, AIM_STEPS/4], positive up. `dir` need not be unit length; a zero vector aims level along +z.
 */
export function aimOf(dir: { x: number; y: number; z: number }): [number, number] {
  const h = Math.hypot(dir.x, dir.z);
  const yawTurn = h === 0 ? 0 : Math.atan2(dir.x, dir.z) / (Math.PI * 2);
  const pitchTurn = h === 0 && dir.y === 0 ? 0 : Math.atan2(dir.y, h) / (Math.PI * 2);
  const yaw = ((Math.round(yawTurn * AIM_STEPS) % AIM_STEPS) + AIM_STEPS) % AIM_STEPS;
  return [yaw, whole(pitchTurn * AIM_STEPS)];
}

/** Decodes `verb.aim` into a unit direction. */
export function aimVector(aim: readonly [number, number], out: Vector3): Vector3 {
  const yaw = (aim[0] / AIM_STEPS) * Math.PI * 2;
  const pitch = (aim[1] / AIM_STEPS) * Math.PI * 2;
  const h = Math.cos(pitch);
  return out.set(Math.sin(yaw) * h, Math.sin(pitch), Math.cos(yaw) * h);
}

/** The `meta 'dev' setTuning` command the dev panel sends for one live edit. */
export function setTuningCommand(tick: number, player: number, table: string, key: string, value: number | boolean | string): MetaCommand {
  return { tick, player, kind: 'meta', meta: 'dev', dev: { op: 'setTuning', args: [], tuning: { table, key, value } } };
}

/** A deep copy of a command (commands hold only numbers, strings, booleans, arrays and plain objects). */
export function cloneCommand<C extends Command>(c: C): C {
  return cloneData(c);
}

function cloneData<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneData(x)) as T;
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = cloneData((v as Record<string, unknown>)[k]);
    return o as T;
  }
  return v;
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
    // Likewise only the newest focus per tick and player: the client sends one whenever the highlighted target
    // changes. The older one is dropped and the newer one queued where it was pushed, so every command that
    // survives stays in push order (verb and meta commands are applied in queue order).
    if (c.kind === 'verb' && c.verb === 'focus') {
      const i = this.pending.findIndex((o) => o.kind === 'verb' && o.verb === 'focus' && o.tick === c.tick && o.player === c.player);
      if (i >= 0) this.pending.splice(i, 1);
    }
    this.pending.push(c);
  }

  /**
   * Removes and returns every command due at or before `tick`, in queued order. (A command
   * tagged for a tick that has already run is applied on the next one, not dropped; the
   * game loop always tags input for the tick after the last one it ran.)
   */
  take(tick: number): Command[] {
    if (this.pending.length === 0) return [];
    const due: Command[] = [];
    const later: Command[] = [];
    for (const c of this.pending) (c.tick <= tick ? due : later).push(c);
    this.pending = later;
    return due;
  }

  /** Drops a player's pending commands of one kind (a reset that clears their buffered presses). */
  discard(player: number, kind: Command['kind']) {
    this.pending = this.pending.filter((c) => c.player !== player || c.kind !== kind);
  }

  get length() {
    return this.pending.length;
  }

  clear() {
    this.pending.length = 0;
  }

  /** The pending commands in queue order, as copies (the save's `pending`, docs/M1-DESIGN.md §8.3). */
  toRecord(): Command[] {
    return this.pending.map((c) => cloneCommand(c));
  }

  /** Replaces the queue with copies of `r`, kept in the given order (no de-duplication: a record is already deduped). */
  restoreRecord(r: readonly Command[]) {
    this.pending = r.map((c) => cloneCommand(c));
  }
}
