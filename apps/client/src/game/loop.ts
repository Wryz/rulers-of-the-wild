// The game loop (docs/M1-DESIGN.md §10.2): input → commands, the fixed-step accumulator, and every time effect of
// single-player — hit-pause, slow motion, the cinematic time scale, pause and the hidden-tab pause — in this one place
// (rule 8). A time effect only changes how many sim steps run in a frame (0-6); the sim never reads timeScale, slowmo,
// hitstop or the cinematic scale, so a shared world (which can't slow down) turns them into replays later.
//
// The same structure as DungeonStyle's frame/fixedStep (game.ts:620-780), minus the ragdoll → sim write-back, the
// wall-clock seeds and the training ring (§10.11).
import { type Command, type DevOp, DT, defineTuning, type StepResult, type TuningEdit, type World } from '@wild/sim';
import type { InputFrame } from '../input/input';
import { LOCAL_PLAYER } from '../input/verbInput';
import { GAME_TUNING } from './game';
import type { CinematicsPort, LoopPort, VerbInputPort } from './ports';

export const LOOP_TUNING = defineTuning(
  'LOOP_TUNING',
  'Client › loop',
  {
    maxStepsPerFrame: 6,
    slowmoScale: 0.25,
    parrySlowmoS: 0.35,
    dismemberSlowmoS: 0.6,
    playerKoSlowmoS: 1.5,
    treeFallHitstop: 4,
    treeFallHitstopRangeM: 25,
    // Not §9.1 rows: DungeonStyle values the loop keeps (game.ts start, TIME_SCALES), so none is a bare constant.
    maxFrameS: 0.1,
    devTimeScales: [1, 0.5, 0.25, 0.1],
  },
  {
    maxStepsPerFrame: { unit: 'steps', source: 'DS (game.ts frame)', min: 1, max: 12, step: 1, label: 'max steps / frame' },
    slowmoScale: { unit: '×', source: 'DS', min: 0.05, max: 1, step: 0.05, label: 'slow-motion scale' },
    parrySlowmoS: { unit: 's', source: 'DS (MAP game-loop §4): perfect parry and perfect dodge', min: 0, max: 3, step: 0.05, label: 'parry slow-mo' },
    dismemberSlowmoS: { unit: 's', source: 'DS (MAP game-loop §4): dismember and skull blow', min: 0, max: 3, step: 0.05, label: 'dismember slow-mo' },
    playerKoSlowmoS: { unit: 's', source: 'DS (MAP game-loop §4)', min: 0, max: 5, step: 0.05, label: 'player KO slow-mo' },
    treeFallHitstop: { unit: 'frames', source: 'NEW (§10.2): a felled tree landing near the camera', min: 0, max: 20, step: 1, label: 'tree fall hit-pause' },
    treeFallHitstopRangeM: { unit: 'm', source: 'NEW (§10.2)', min: 0, max: 200, step: 1, label: 'tree fall range' },
    maxFrameS: { unit: 's', source: 'DS (game.ts start: a frame counts at most 0.1 s)', min: 0.02, max: 0.5, step: 0.01, label: 'max frame' },
    devTimeScales: { unit: '×', source: 'DS (game.ts TIME_SCALES: what the dev T key cycles through)' },
  },
);

/** The world as the loop sees it: its tick, one step, and the command queue. */
export interface LoopWorld {
  readonly tick: number;
  step(): StepResult;
  readonly commands: { push(c: Command): void };
}

/** The input as the loop sees it: one frame of intent per rendered frame. */
export interface LoopInput {
  poll(): InputFrame;
}

/** The presenter as the loop sees it (game/game.ts's Game). */
export interface LoopGame<W extends LoopWorld = World> {
  readonly verbInput: VerbInputPort;
  readonly presentation: { step(world: W): void };
  /** A menu is open (settings, battle log): the loop pauses. */
  readonly menuOpen: boolean;
  /** Once per rendered frame, first: the frame's input (camera look) and the loop (the recording's clock). */
  beginFrame(inp: InputFrame, loop: LoopPort): void;
  /** A menu or developer key this frame (Escape, M, B, L, H, Backspace; the loop keeps P, `.` and T). */
  metaKey(code: string): void;
  /** One stepped tick's events: may raise hitstop or slowmo, and starts kill cams through KillCam.onMoment. */
  present(r: StepResult, loop: LoopPort): void;
  /** A swallowed step (hit-pause): the visuals hold. */
  freezeFrame(): void;
  render(realDt: number, gameDt: number, alpha: number): void;
  onSave(bytes: Uint8Array): void;
}

/** What slow motion is for (LOOP_TUNING's durations). */
export type SlowKind = Parameters<LoopPort['slowMotion']>[0];

export class GameLoop<W extends LoopWorld = World> implements LoopPort {
  /** Sim steps to swallow (hit-pause). */
  hitstop = 0;
  /** Real seconds left at LOOP_TUNING.slowmoScale. */
  slowmo = 0;
  /** Sim seconds owed (real time × the time scale), stepped in whole DT. */
  private accum = 0;
  private stepOnce = false;
  private hidden = false;
  private running = false;
  private visibility: (() => void) | null = null;

  constructor(
    readonly world: W,
    readonly game: LoopGame<W>,
    readonly input: LoopInput,
    readonly cine: Pick<CinematicsPort, 'active' | 'timeScale' | 'update'>,
  ) {}

  /** Paused: dev P, a menu, or a hidden tab (SPEC:108: the world doesn't run while you're away). */
  get paused(): boolean {
    return GAME_TUNING.paused || this.hidden || this.game.menuOpen;
  }

  /** Input isn't turned into commands while paused or in a menu (DS). */
  get blocked(): boolean {
    return this.paused;
  }

  /** The tab was hidden or shown (visibilitychange). Coming back starts from now: no backlog of steps. */
  setHidden(hidden: boolean): void {
    if (this.hidden && !hidden) this.accum = 0;
    this.hidden = hidden;
  }

  /** One rendered frame of `realDt` real seconds. */
  frame(realDt: number): void {
    const inp = this.input.poll();
    for (const k of inp.keys) this.metaKey(k);
    this.game.beginFrame(inp, this);
    // Input reaches the sim only as commands for its next tick (applied as that tick starts).
    if (!this.blocked) for (const c of this.game.verbInput.commands(inp, this.world.tick + 1)) this.world.commands.push(c);

    const paused = this.paused;
    // Timers in real time (stopped while paused).
    if (!paused) this.tickTimers(realDt);
    let scale = GAME_TUNING.timeScale * (this.cine.active ? this.cine.timeScale : this.slowmo > 0 ? LOOP_TUNING.slowmoScale : 1);
    if (paused) scale = 0;
    if (this.stepOnce) {
      this.stepOnce = false;
      this.fixedStep();
    }
    // (A camera cut is already the slow-motion beat: no hit-pause frozen on top of it.)
    if (this.cine.active && this.hitstop > 0) this.hitstop = 0;
    this.accum += realDt * scale;
    const max = LOOP_TUNING.maxStepsPerFrame;
    let steps = 0;
    while (this.accum >= DT && steps < max) {
      this.fixedStep();
      this.accum -= DT;
      steps++;
    }
    // A frame that fell this far behind drops the backlog rather than spiralling.
    if (steps >= max) this.accum = 0;
    const frozen = this.hitstop > 0 || scale === 0;
    this.game.render(realDt, frozen ? 0 : realDt * scale, frozen ? 1 : this.accum / DT);
  }

  /** Raises slow motion for `kind` (never shortens one already running). */
  slowMotion(kind: SlowKind): void {
    const T = LOOP_TUNING;
    const s = kind === 'parry' ? T.parrySlowmoS : kind === 'dismember' ? T.dismemberSlowmoS : T.playerKoSlowmoS;
    this.slowmo = Math.max(this.slowmo, s);
  }

  /** A felled tree landed `distanceM` from the camera: a short hit-pause when it's close (§10.2). */
  treeLanded(distanceM: number): void {
    if (distanceM <= LOOP_TUNING.treeFallHitstopRangeM) this.hitstop = Math.max(this.hitstop, LOOP_TUNING.treeFallHitstop);
  }

  /** Dev: one step on the next frame, even while paused (DS requestStep). */
  requestStep(): void {
    this.stepOnce = true;
  }

  /** Dev: run `n` steps now, ignoring pause and time scale (DS advance; headless checks). */
  advance(n: number): void {
    for (let i = 0; i < n; i++) this.fixedStep();
  }

  /** Dev: a `meta 'dev'` command for the next tick (applied in its phase 1c, so the command log replays it, RR-17). */
  dev(op: DevOp, args: number[], tuning?: TuningEdit): void {
    const dev: { op: DevOp; args: number[]; tuning?: TuningEdit } = { op, args: [...args] };
    if (tuning) dev.tuning = { ...tuning };
    this.world.commands.push({ tick: this.world.tick + 1, player: LOCAL_PLAYER, kind: 'meta', meta: 'dev', dev });
  }

  /** A `meta 'save'` for the next tick; the bytes come back through Game.onSave at the end of that tick. */
  save(): void {
    this.world.commands.push({ tick: this.world.tick + 1, player: LOCAL_PLAYER, kind: 'meta', meta: 'save' });
  }

  /** Starts the requestAnimationFrame loop (and the hidden-tab pause). */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (typeof document !== 'undefined' && !this.visibility) {
      const onChange = () => this.setHidden(document.hidden);
      document.addEventListener('visibilitychange', onChange);
      this.visibility = () => document.removeEventListener('visibilitychange', onChange);
      onChange();
    }
    let last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(LOOP_TUNING.maxFrameS, Math.max(0, (now - last) / 1000));
      last = now;
      this.frame(dt);
    };
    requestAnimationFrame(loop);
  }

  /** Stops the loop (a rebuild disposes the world after this). */
  stop(): void {
    this.running = false;
    this.visibility?.();
    this.visibility = null;
  }

  /** The time keys are the loop's (rule 8); every other menu or developer key goes to the presenter. */
  private metaKey(code: string): void {
    switch (code) {
      case 'KeyP':
        GAME_TUNING.paused = !GAME_TUNING.paused;
        return;
      case 'Period':
        GAME_TUNING.paused = true;
        this.stepOnce = true;
        return;
      case 'KeyT': {
        const scales = LOOP_TUNING.devTimeScales;
        const i = scales.indexOf(GAME_TUNING.timeScale);
        GAME_TUNING.timeScale = scales[(i + 1) % scales.length];
        return;
      }
      default:
        this.game.metaKey(code);
    }
  }

  /** Real-time timers, stopped while paused: slow motion runs down, a cut plays on. */
  private tickTimers(dt: number): void {
    if (this.slowmo > 0) this.slowmo = Math.max(0, this.slowmo - dt);
    this.cine.update(dt);
  }

  private fixedStep(): void {
    // Hit-pause: the step is swallowed and the sim doesn't run (DS).
    if (this.hitstop > 0) {
      this.hitstop--;
      this.game.freezeFrame();
      return;
    }
    const r = this.world.step();
    this.game.present(r, this); // may raise hitstop or slowmo, and start a kill cam through KillCam.onMoment
    this.game.presentation.step(this.world); // ragdolls follow the sim; the presentation Rapier world steps
    if (r.save) this.game.onSave(r.save);
  }
}
