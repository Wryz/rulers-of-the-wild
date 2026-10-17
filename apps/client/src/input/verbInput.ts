// The verb UI's input side (docs/M1-DESIGN.md §10.7, §5.14): turns one input frame into this frame's commands. The only
// producer of player commands in the client (rule 6: input reaches the sim only as tick-tagged commands, §10.11).
//
// STUB (P31; P35 fills it): the final exported names, VERB_UI_TUNING with its §9 values, and DungeonStyle's move/button
// command code moved out of game.ts (a camera-relative `move` every frame, a `button` per press, `pickup`). The radial,
// the two-target step, throw aim, place, focus and pull arrive with P35.
import type { Vector3 } from 'three';
import { type Command, defineTuning, moveCommand } from '@wild/sim';
import type { VerbInputPort } from '../game/ports';
import type { InputFrame } from './input';

/** The local player's number: its commands carry `player: 1`, which the world maps to fighter 'p1' (§1.5.3). */
export const LOCAL_PLAYER = 1;

export const VERB_UI_TUNING = defineTuning(
  'VERB_UI_TUNING',
  'Client › verb UI',
  {
    targetConeDeg: 28,
    fightTargetConeDeg: 50,
    radialDeadPx: 28,
    secondTimeoutS: 10,
    wheelStepDeg: 15,
    padRotateDegS: 90,
    arcPoints: 48,
    highlightScale: 1.04,
    markerRangeM: 60,
    compassPingS: 30,
    compassSeeRangeM: 120,
  },
  {
    targetConeDeg: { unit: '°', source: 'NEW (§10.7)', min: 5, max: 90, step: 1, label: 'target cone' },
    fightTargetConeDeg: { unit: '°', source: 'NEW (§10.7)', min: 5, max: 120, step: 1, label: 'target cone (fight)' },
    radialDeadPx: { unit: 'px', source: 'NEW: D-48', min: 0, max: 100, step: 1, label: 'radial dead zone' },
    secondTimeoutS: { unit: 's', source: 'NEW: D-48', min: 1, max: 60, step: 0.5, label: 'second target timeout' },
    wheelStepDeg: { unit: '°', source: 'NEW: D-48', min: 1, max: 90, step: 1, label: 'wheel step' },
    padRotateDegS: { unit: '°/s', source: 'NEW: D-48', min: 10, max: 360, step: 5, label: 'pad rotate' },
    arcPoints: { unit: 'points', source: 'NEW (§10.7)', min: 8, max: 128, step: 1, label: 'throw arc points' },
    highlightScale: { unit: '×', source: 'NEW (§10.7)', min: 1, max: 1.2, step: 0.005, label: 'highlight shell' },
    markerRangeM: { unit: 'm', source: 'NEW (§10.8)', min: 5, max: 200, step: 1, label: 'marker range' },
    compassPingS: { unit: 's', source: 'NEW (§10.8)', min: 1, max: 120, step: 1, label: 'compass ping' },
    compassSeeRangeM: { unit: 'm', source: 'NEW (§10.8)', min: 10, max: 300, step: 1, label: 'compass sight range' },
  },
);

/** What the verb UI is doing (§10.7). */
export type UiMode = 'idle' | 'radial' | 'second' | 'throwAim' | 'place';

/** A highlighted target: an entity (with the aimed point on it) or a point on the ground. */
export type TargetRef = { kind: 'entity'; id: number; at: Vector3 } | { kind: 'ground'; at: Vector3 };

/** The ground forward/right of the camera the player steers by (CameraPort.moveBasis). */
export type MoveBasis = () => { forward: Vector3; right: Vector3 };

export class VerbInput implements VerbInputPort {
  mode: UiMode = 'idle';
  target: TargetRef | null = null;
  /** The first target during the second-target step. */
  first: TargetRef | null = null;

  constructor(
    private readonly basis: MoveBasis,
    readonly player = LOCAL_PLAYER,
  ) {}

  /** Turns one input frame into this frame's commands for `tick`; the only producer of commands in the client. */
  commands(inp: InputFrame, tick: number): Command[] {
    const { forward: fwd, right } = this.basis();
    const player = this.player;
    // Screen-space stick → a world walk vector on the camera's ground plane (DS game.ts frame).
    const out: Command[] = [moveCommand(tick, player, right.x * inp.moveX + fwd.x * inp.moveY, right.z * inp.moveX + fwd.z * inp.moveY)];
    for (const b of inp.presses) out.push({ tick, player, kind: 'button', button: b });
    if (inp.pickup) out.push({ tick, player, kind: 'button', button: 'pickup' });
    return out;
  }
}
