// The kill cam (docs/M1-DESIGN.md §10.3, SPEC:583-588, rule 8): one function receives every moment. A moment that gets
// no cut (a cooldown, a bigger cut running) is still marked as a saved moment, so every trigger gives a kill cam or a
// mark (SPEC:933, RR-14). Multiplayer later turns onMoment's body into a replay request (SPEC:744).
//
// STUB (P31; P36 fills it): the final exported names, KILLCAM_TUNING with its §9 values, and DungeonStyle's three kill
// shots that exist today: the player's death cam, the skull cut and the finishing shot (envKill). The per-kind
// cooldown, worldWound, rulerDeath and playerByRuler arrive with P36 (until then those moments are only marked).
import { Vector3 } from 'three';
import { defineTuning, type Fighter } from '@wild/sim';
import type { Shot } from '../render/cinematics';
import type { KillCamPort } from './ports';

export type MomentKind = 'envKill' | 'worldWound' | 'rulerDeath' | 'playerByRuler' | 'playerDeath' | 'skullSplit';

export interface Moment {
  kind: MomentKind;
  tick: number;
  /** The victim, the wounded ruler, or the flung player. */
  subject: Fighter;
  /** Impact point and direction (world). */
  point: Vector3;
  dir: Vector3;
  /** The log, stake, trunk… (the shot's side; the journal later). */
  causeEntity: number | null;
  /** 0..1 (the hit's HP fraction, or 1 for a death). */
  severity: number;
}

/** The shot parameters of one moment kind (§10.3's table; distances and heights in m, before the scale terms). */
const shotFields = (what: string) => ({
  orbit: { unit: 'rad/s', source: `§10.3 ${what}`, min: -1, max: 1, step: 0.01 },
  fov: { unit: '°', source: `§10.3 ${what}`, min: 20, max: 90, step: 1 },
  durationS: { unit: 's', source: `§10.3 ${what}`, min: 0.2, max: 10, step: 0.1 },
  slow: { unit: '× time', source: `§10.3 ${what}`, min: 0.02, max: 1, step: 0.01 },
  priority: { unit: '—', source: `§10.3 ${what} (Cinematics' ladder: death 5, skull 4.5, finisher 4)`, min: 0, max: 10, step: 0.5 },
});

export const KILLCAM_TUNING = defineTuning(
  'KILLCAM_TUNING',
  'Client › kill cam',
  {
    cooldownS: 4,
    /** DS's finishing shot: distance distM × max(1, distScaleMul·scale). */
    envKill: { distM: 3.8, distScaleMul: 0.75, heightM: 0.55, orbit: 0.3, fov: 38, durationS: 2.2, slow: 0.18, priority: 4 },
    /** DS boss-intro framing: distance and height × scale. */
    worldWound: { distPerScaleM: 3.3, heightPerScaleM: -0.15, orbit: -0.12, dolly: -0.35, fov: 42, durationS: 2.4, slow: 0.25, priority: 4.5 },
    rulerDeath: { distPerScaleM: 4, heightPerScaleM: 0.3, orbit: 0.1, fov: 40, durationS: 4.0, slow: 0.2, priority: 6 },
    playerByRuler: { distM: 7, heightM: 2.5, orbit: 0.2, fov: 44, durationS: 2.6, slow: 0.3, priority: 5.5 },
  },
  {
    cooldownS: { unit: 's per moment kind', source: 'NEW (§10.3)', min: 0, max: 30, step: 0.5 },
    envKill: {
      distM: { unit: 'm', source: 'DS (game.ts finishing shot)', min: 1, max: 20, step: 0.1 },
      distScaleMul: { unit: '× scale', source: 'DS (game.ts finishing shot)', min: 0, max: 2, step: 0.05 },
      heightM: { unit: 'm', source: 'DS (game.ts finishing shot)', min: -3, max: 10, step: 0.05 },
      ...shotFields('envKill (DS finishing shot)'),
    },
    worldWound: {
      distPerScaleM: { unit: 'm × scale', source: 'NEW (DS boss-intro framing, MAP client §3.3)', min: 0.5, max: 10, step: 0.1 },
      heightPerScaleM: { unit: 'm × scale', source: 'NEW (DS boss-intro framing)', min: -2, max: 2, step: 0.05 },
      dolly: { unit: 'm/s', source: 'NEW (DS boss-intro framing)', min: -2, max: 2, step: 0.05 },
      ...shotFields('worldWound'),
    },
    rulerDeath: {
      distPerScaleM: { unit: 'm × scale', source: 'NEW', min: 0.5, max: 10, step: 0.1 },
      heightPerScaleM: { unit: 'm × scale', source: 'NEW', min: -2, max: 2, step: 0.05 },
      ...shotFields('rulerDeath'),
    },
    playerByRuler: {
      distM: { unit: 'm', source: 'NEW (rule 9)', min: 1, max: 30, step: 0.1 },
      heightM: { unit: 'm', source: 'NEW (rule 9)', min: -3, max: 15, step: 0.1 },
      ...shotFields('playerByRuler'),
    },
  },
);

/**
 * The ground direction for a cut that looks across the line a → b, on the side the gameplay camera at `cam` is already
 * on (so left and right stay where they were), pulled `toward` over a's shoulder (DS game.ts across).
 */
export function sideAcross(cam: Vector3, a: Vector3, b: Vector3, toward = 0.25): Vector3 {
  const l = new Vector3(b.x - a.x, 0, b.z - a.z);
  if (l.lengthSq() < 1e-6) l.set(1, 0, 0);
  l.normalize();
  const side = new Vector3(l.z, 0, -l.x);
  if (side.x * (cam.x - (a.x + b.x) / 2) + side.z * (cam.z - (a.z + b.z) / 2) < 0) side.negate();
  return side.addScaledVector(l, -toward).normalize();
}

/** What a kill cam needs from the views: a body to follow, the ground, and the side the gameplay camera is on. */
export interface KillCamViews {
  /** Follows the body as drawn (its ragdoll pelvis). */
  pelvisOf(f: Fighter): () => Vector3;
  ground(x: number, z: number): number;
  /** The ground direction across the line a → b on the side the gameplay camera is already on, `toward` over a's shoulder. */
  across(a: Vector3, b: Vector3, toward?: number): Vector3;
}

export class KillCam implements KillCamPort {
  /** Saved moments (the recorder's moment list; the M5 clip button, SPEC:933). */
  readonly marks: Moment[] = [];

  constructor(
    private readonly cut: (s: Shot) => boolean,
    private readonly views: KillCamViews,
  ) {}

  /** Every kill cam goes through here. False when suppressed: the moment is still marked. */
  onMoment(m: Moment): boolean {
    const shot = this.shotFor(m);
    const played = shot !== null && this.cut(shot);
    if (!played) this.mark(m);
    return played;
  }

  mark(m: Moment): void {
    this.marks.push(m);
  }

  private shotFor(m: Moment): Shot | null {
    const f = m.subject;
    // Where the blow came from: back along its direction from the impact point.
    const from = m.point.clone().addScaledVector(m.dir, -1);
    switch (m.kind) {
      case 'playerDeath':
        // DS's death cam (game.ts death cut): your fall, seen from above. DS code values, §10.3.
        return { focus: this.views.pelvisOf(f), side: this.views.across(from, f.pos, -0.2), distance: 3.0, height: 1.7, orbit: 0.16, dolly: -0.2, fov: 40, duration: 3.2, slow: 0.22, priority: 5 };
      case 'skullSplit': {
        // DS's skull cut: close and almost frozen, over the shoulder of whoever did it. DS code values, §10.3.
        const at = m.point.clone();
        return { focus: () => at, side: this.views.across(from, f.pos, 0.45), distance: 1.9 * Math.max(1, f.scale * 0.8), height: 0.25, orbit: 0.4, dolly: -0.2, fov: 36, duration: 2.1, slow: 0.1, priority: 4.5 };
      }
      case 'envKill': {
        // DS's finishing shot: low and from the side, following the victim down.
        const T = KILLCAM_TUNING.envKill;
        return {
          focus: this.views.pelvisOf(f),
          side: this.views.across(from, f.pos, 0.1),
          distance: T.distM * Math.max(1, T.distScaleMul * f.scale),
          height: T.heightM,
          orbit: T.orbit,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
      default:
        // TODO(P36): worldWound, rulerDeath and playerByRuler shots, and the per-kind cooldown (KILLCAM_TUNING).
        return null;
    }
  }
}
