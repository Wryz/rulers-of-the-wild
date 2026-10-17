// The follow camera (docs/M1-DESIGN.md §10.6, SPEC:35): the open-world camera out of fights. It owns yaw and pitch
// (mouse under pointer lock, right stick, wheel zoom), looks at the player's chest from behind and to the right, keeps its
// boom above the terrain, pulls back and tilts up for a nearby giant, and has an aim mode for throws.
//
// Presentation only (rule 6): it reads the world (terrain heights, where the fighters are) and writes nothing in it; its
// yaw is the basis the verb UI turns the stick into a `move` command with (CameraPort.moveBasis), never a fighter's yaw.
// Time (rule 8): it runs on real seconds, so it stays live through a hit-pause or slow motion.
import { Frustum, Matrix4, PerspectiveCamera, type Quaternion, Vector3 } from 'three';
import { defineTuning, type Fighter } from '@wild/sim';
import { CAMERA_TUNING, type Followed, type GroundFn, setLens } from './cameraRig';
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
    // Not a §9.1 row (P34 DEVIATIONS): a blend between cameras far apart (the giant's fight framing is ~16 m back) is
    // slowed so the view never moves faster than this, whatever blendS says (P34's test: no jump > 0.5 m a frame).
    blendMaxSpeed: 18,
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
    blendMaxSpeed: { unit: 'm/s', source: 'NEW (P34): caps the follow ↔ fight blend', min: 1, max: 100, step: 1, label: 'blend max speed' },
  },
);

/**
 * One rendered frame of camera input (the CameraPort's `look`, which game.ts passes on from InputFrame.look as it is).
 * `dx`/`dy`: pointer-locked mouse movement this frame (px; +x right, +y down). The rest is optional, for P35 to fill:
 * `stickX`/`stickY` the right stick's deflection held this frame (−1..1; +y down), `zoom` wheel notches this frame
 * (+ out), `aim` the throw aim held (X).
 */
export interface LookInput {
  dx: number;
  dy: number;
  stickX?: number;
  stickY?: number;
  zoom?: number;
  aim?: boolean;
}

/** What the follow camera reads of the world (World satisfies it): the terrain's heights and the fighters. */
export interface FollowWorld {
  readonly terrain: { heightAt(x: number, z: number): number };
  readonly combat: { readonly fighters: readonly Fighter[] };
}

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * A boom from the player's chest: `yaw` turns it round (rad, from +z toward +x, the move convention), `pitch` tilts it
 * (rad, positive looking down). The view looks along yaw and pitch exactly, through a point `shoulder` m to the right of
 * the chest, so the player stands a little left of centre and the stick's forward is the view's forward.
 */
export class FollowCam {
  readonly camera = new PerspectiveCamera(CAMERA_TUNING.fov, 16 / 9, 0.1, RENDER_TUNING.cameraFar);
  /** rad, from +z toward +x (the move convention). */
  yaw = 0;
  /** rad, positive looking down. */
  pitch = FOLLOW_TUNING.pitchDeg * DEG;
  /** The boom length the wheel asks for (m, within minDistance..maxDistance). */
  distance = FOLLOW_TUNING.distance;

  /** The chest point the boom turns about (eased toward the player). */
  private readonly pivot = new Vector3();
  /** The point the view looks at: the pivot moved `shoulder` to the right. */
  private readonly lookAt = new Vector3();
  // Eased toward their targets (so zoom, aim and the giant's pull-back never pop):
  private dist = FOLLOW_TUNING.distance;
  private shoulder = FOLLOW_TUNING.shoulder;
  private fovMul = 1;
  private rulerPull = 0;
  private rulerTilt = 0;
  /** How far the camera is raised over the boom so the boom clears the terrain (m; rises at once, settles eased). */
  private lift = 0;
  private snapNext = true;
  /** Rulers that have been on screen since they came within FOLLOW_TUNING.rulerRangeM. */
  private readonly seen = new Set<Fighter>();

  /**
   * One rendered frame (real seconds): look input turns the boom, the pivot follows the player's chest, the boom stays
   * FOLLOW_TUNING.clearance over the terrain. With no player the camera holds still.
   */
  update(dt: number, world: FollowWorld, player: Followed | null, look: LookInput): void {
    const T = FOLLOW_TUNING;
    const ground: GroundFn = (x, z) => world.terrain.heightAt(x, z);
    // Look: the mouse at once, the stick by the second; pitch within its limits.
    const minP = T.minPitchDeg * DEG;
    const maxP = T.maxPitchDeg * DEG;
    this.yaw = wrap(this.yaw - (look.dx * T.mouseSens + (look.stickX ?? 0) * T.stickSens * dt));
    this.pitch = clamp(this.pitch + look.dy * T.mouseSens + (look.stickY ?? 0) * T.stickSens * dt, minP, maxP);
    if (look.zoom) this.distance = clamp(this.distance + look.zoom * T.zoomStep, T.minDistance, T.maxDistance);
    this.distance = clamp(this.distance, T.minDistance, T.maxDistance);
    if (!player) return;

    // The giant: pull back and tilt up while one that has been on screen is near, so its head stays in frame.
    let pull = 0;
    let tilt = 0;
    for (const f of world.combat.fighters) {
      if (!f.ruler || !f.alive) {
        this.seen.delete(f);
        continue;
      }
      const d = Math.hypot(f.pos.x - player.pos.x, f.pos.z - player.pos.z);
      if (d > T.rulerRangeM) {
        this.seen.delete(f);
        continue;
      }
      if (!this.seen.has(f) && this.onScreen(f)) this.seen.add(f);
      if (!this.seen.has(f)) continue;
      const near = T.rulerRangeM > 0 ? 1 - d / T.rulerRangeM : 0;
      pull = Math.max(pull, T.rulerPullbackPerScale * f.scale * near);
      tilt = Math.max(tilt, T.rulerPitchDeg * DEG * near);
    }

    const aim = !!look.aim;
    const k = this.snapNext ? 1 : 1 - Math.exp(-dt * T.follow);
    this.dist += ((aim ? T.aimDistance : this.distance) - this.dist) * k;
    this.shoulder += ((aim ? T.aimShoulder : T.shoulder) - this.shoulder) * k;
    this.fovMul += ((aim ? T.aimFovMul : 1) - this.fovMul) * k;
    this.rulerPull += (pull - this.rulerPull) * k;
    this.rulerTilt += (tilt - this.rulerTilt) * k;
    _target.set(player.pos.x, player.pos.y + T.lookHeight * player.scale, player.pos.z);
    this.pivot.lerp(_target, k);

    // The boom: back along yaw, tilted by pitch (less a giant's tilt), from the shoulder point.
    const pitch = clamp(this.pitch - this.rulerTilt, minP, maxP);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const len = this.dist + this.rulerPull;
    this.lookAt.set(this.pivot.x - fz * this.shoulder, this.pivot.y, this.pivot.z + fx * this.shoulder);
    const cp = Math.cos(pitch);
    _cam.set(this.lookAt.x - fx * cp * len, this.lookAt.y + Math.sin(pitch) * len, this.lookAt.z - fz * cp * len);

    // Tested against the terrain at boomSamples points from the shoulder to the camera: raising the camera's end by h
    // raises the sample at u by h·u, so the lift that clears every sample is the largest (shortfall / u).
    const clear = T.clearance;
    const n = Math.max(1, Math.round(T.boomSamples));
    let need = 0;
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const x = this.lookAt.x + (_cam.x - this.lookAt.x) * u;
      const z = this.lookAt.z + (_cam.z - this.lookAt.z) * u;
      const y = this.lookAt.y + (_cam.y - this.lookAt.y) * u;
      const short = ground(x, z) + clear - y;
      if (short > 0) need = Math.max(need, short / u);
    }
    this.lift = this.snapNext ? need : Math.max(need, this.lift + (need - this.lift) * k);
    _cam.y += this.lift;
    // (The samples include the camera itself, so this only guards a degenerate table: boomSamples 0, a NaN.)
    _cam.y = Math.max(_cam.y, ground(_cam.x, _cam.z) + clear);
    this.snapNext = false;

    const cam = this.camera;
    cam.position.copy(_cam);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.lookAt);
    setLens(cam, CAMERA_TUNING.fov * this.fovMul);
    cam.updateMatrixWorld();
  }

  /** The ground forward/right of this camera (move commands are relative to it). */
  moveBasis(): { forward: Vector3; right: Vector3 } {
    return basisOf(this.yaw);
  }

  /** Behind `f` at once (a respawn): its facing, the default tilt, the pivot on its chest next frame. */
  snapBehind(f: Followed): void {
    this.yaw = wrap(f.yaw);
    this.pitch = FOLLOW_TUNING.pitchDeg * DEG;
    this.snapNext = true;
  }

  /**
   * Turn to look the way a camera with this orientation looks (leaving a fight: the follow camera starts from the fight
   * camera's yaw and pitch, §10.6). The pivot keeps following the player.
   */
  matchView(q: Quaternion): void {
    _dir.set(0, 0, -1).applyQuaternion(q);
    const flat = Math.hypot(_dir.x, _dir.z);
    if (flat > 1e-6) this.yaw = Math.atan2(_dir.x, _dir.z);
    this.pitch = clamp(Math.atan2(-_dir.y, flat), FOLLOW_TUNING.minPitchDeg * DEG, FOLLOW_TUNING.maxPitchDeg * DEG);
  }

  /** Is this fighter's head or hips in the follow camera's view? */
  private onScreen(f: Fighter): boolean {
    const cam = this.camera;
    cam.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    return _frustum.containsPoint(f.rig.head.pos) || _frustum.containsPoint(f.rig.pelvis.pos);
  }
}

/** Ground forward and right for a heading (rad, from +z toward +x); screen right is −x looking along +z. */
export function basisOf(yaw: number): { forward: Vector3; right: Vector3 } {
  return { forward: new Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right: new Vector3(-Math.cos(yaw), 0, Math.sin(yaw)) };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const _target = new Vector3();
const _cam = new Vector3();
const _dir = new Vector3();
const _m = new Matrix4();
const _frustum = new Frustum();
