// The follow camera (docs/M1-DESIGN.md §10.6, SPEC:35): the open-world camera out of fights. It owns yaw and pitch (mouse
// under pointer lock, right stick, wheel zoom), looks at the player's chest from behind and to the right, keeps its boom
// above the terrain, pulls back and tilts up for a nearby giant, and has an aim mode for throws.
//
// STUB (P31; P34 fills it): the final exported names and FOLLOW_TUNING with its §9 values. Until P34 the camera
// director uses DungeonStyle's CameraRig for both framings (behind the player out of a fight).
import { PerspectiveCamera, Vector3 } from 'three';
import { defineTuning, type Fighter, type World } from '@wild/sim';
import { CAMERA_TUNING } from './cameraRig';
import { RENDER_TUNING } from './terrainView';

export const FOLLOW_TUNING = defineTuning(
  'FOLLOW_TUNING',
  'Client › follow camera',
  {
    distance: 4.2,
    minDistance: 2.2,
    maxDistance: 7.5,
    zoomStep: 0.4,
    lookHeight: 1.55,
    shoulder: 0.55,
    clearance: 0.35,
    pitchDeg: 14,
    minPitchDeg: -25,
    maxPitchDeg: 65,
    mouseSens: 0.0022,
    stickSens: 2.6,
    follow: 9,
    boomSamples: 8,
    rulerPullbackPerScale: 0.8,
    rulerRangeM: 35,
    rulerPitchDeg: 8,
    blendS: 0.45,
    aimDistance: 2.4,
    aimShoulder: 0.75,
    aimFovMul: 0.85,
    fightRangeM: 9,
  },
  {
    distance: { unit: 'm', source: 'NEW (§10.6)', min: 1, max: 15, step: 0.1 },
    minDistance: { unit: 'm', source: 'NEW (§10.6)', min: 0.5, max: 10, step: 0.1 },
    maxDistance: { unit: 'm', source: 'NEW (§10.6)', min: 1, max: 30, step: 0.1 },
    zoomStep: { unit: 'm', source: 'NEW (§10.6)', min: 0.05, max: 2, step: 0.05 },
    lookHeight: { unit: 'm × scale', source: 'NEW (§10.6)', min: 0, max: 3, step: 0.05 },
    shoulder: { unit: 'm', source: 'NEW (§10.6)', min: -2, max: 2, step: 0.05 },
    clearance: { unit: 'm', source: 'NEW (§10.6)', min: 0, max: 2, step: 0.05 },
    pitchDeg: { unit: '°', source: 'NEW (§10.6)', min: -45, max: 85, step: 1 },
    minPitchDeg: { unit: '°', source: 'NEW (§10.6)', min: -89, max: 0, step: 1 },
    maxPitchDeg: { unit: '°', source: 'NEW (§10.6)', min: 0, max: 89, step: 1 },
    mouseSens: { unit: 'rad/px', source: 'NEW (§10.6)', min: 0.0002, max: 0.01, step: 0.0001 },
    stickSens: { unit: 'rad/s', source: 'NEW (§10.6)', min: 0.1, max: 10, step: 0.1 },
    follow: { unit: '1/s', source: 'NEW (§10.6)', min: 0.5, max: 30, step: 0.5 },
    boomSamples: { unit: 'samples', source: 'NEW (§10.6)', min: 1, max: 32, step: 1 },
    rulerPullbackPerScale: { unit: 'm per scale', source: 'NEW: MAP client §4', min: 0, max: 3, step: 0.05 },
    rulerRangeM: { unit: 'm', source: 'NEW: MAP client §4', min: 0, max: 120, step: 1 },
    rulerPitchDeg: { unit: '°', source: 'NEW: MAP client §4', min: 0, max: 45, step: 1 },
    blendS: { unit: 's', source: 'NEW (§10.6)', min: 0, max: 3, step: 0.05 },
    aimDistance: { unit: 'm', source: 'NEW (§10.6)', min: 0.5, max: 10, step: 0.1 },
    aimShoulder: { unit: 'm', source: 'NEW (§10.6)', min: -2, max: 2, step: 0.05 },
    aimFovMul: { unit: '×', source: 'NEW (§10.6)', min: 0.3, max: 1.5, step: 0.01 },
    fightRangeM: { unit: 'm', source: 'DS (lock-on camera range)', min: 1, max: 40, step: 0.5 },
  },
);

export class FollowCam {
  readonly camera = new PerspectiveCamera(CAMERA_TUNING.fov, 16 / 9, 0.1, RENDER_TUNING.cameraFar);
  /** rad, from +z toward +x (the move convention). */
  yaw = 0;
  /** rad, positive looking down. */
  pitch = (FOLLOW_TUNING.pitchDeg * Math.PI) / 180;

  /** TODO(P34): mouse/stick look, wheel zoom, terrain boom, giant pull-back, aim mode. */
  update(_dt: number, _world: World, _player: Fighter | null, _look: { dx: number; dy: number }): void {}

  /** The ground forward/right of this camera (move commands are relative to it). */
  moveBasis(): { forward: Vector3; right: Vector3 } {
    return { forward: new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), right: new Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw)) };
  }

  /** Behind `f` at once (a respawn). */
  snapBehind(f: Fighter): void {
    this.yaw = f.yaw;
  }
}
