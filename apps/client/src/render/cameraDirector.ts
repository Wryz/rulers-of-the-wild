// The camera director (docs/M1-DESIGN.md §10.6): the follow camera out of fights, DungeonStyle's fight camera
// (render/cameraRig.ts) while locked on, a blend between them, and kill cams (render/cinematics.ts) over both. The
// movement basis of `move` commands is the active camera's ground forward/right. Also the CinematicsPort adapter.
//
// - Fight: the player's target is alive and within FOLLOW_TUNING.fightRangeM (centre to centre, DS's 9 m).
// - Blend: FOLLOW_TUNING.blendS with a smoothstep on position, rotation (slerp) and fov; slowed when the two cameras are
//   far apart (blendMaxSpeed), so the view never jumps. Entering, the fight camera starts on the side of the fight
//   nearer the follow camera; leaving, the follow camera starts from the fight camera's yaw and pitch. A change of mind
//   mid-blend just turns the blend round.
// - Shake, the zoom punch and the slow-motion zoom are applied here, to the camera the frame is seen through, so a
//   jolt shakes the follow camera as well as the fight camera.
// - Presentation only (rule 6): it reads the world (terrain heights, fighters, events) and never writes it. Time effects
//   are the loop's (rule 8): it runs on real seconds and only shows what the loop does.
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { type Fighter, humanoidMass, type World } from '@wild/sim';
import type { CameraPort, CinematicsPort, SimEvent } from '../game/ports';
import { applyShake, CAMERA_TUNING, type CameraRig, type GroundFn, setLens } from './cameraRig';
import type { Cinematics, Shot } from './cinematics';
import { focusCutout } from './cutout';
import { basisOf, FOLLOW_TUNING, type FollowCam, type FollowWorld, type LookInput } from './followCam';
import { RENDER_TUNING } from './terrainView';

/** DS Cinematics behind CinematicsPort. */
export class CinematicsAdapter implements CinematicsPort {
  constructor(readonly inner: Cinematics) {}

  get camera(): PerspectiveCamera {
    return this.inner.camera;
  }

  get active(): boolean {
    return this.inner.active;
  }

  get timeScale(): number {
    return this.inner.timeScale;
  }

  /** The ground a cut stands on (the cut's floor clamp: ground(x, z) + CAMERA_TUNING.cutFloorM). */
  get ground(): (x: number, z: number) => number {
    return this.inner.ground;
  }

  play(shot: Shot): boolean {
    return this.inner.play(shot);
  }

  update(dt: number): void {
    this.inner.update(dt);
  }

  setGround(ground: (x: number, z: number) => number): void {
    this.inner.ground = ground;
  }

  setBlocked(blocked: (a: Vector3, b: Vector3) => boolean): void {
    this.inner.blocked = blocked;
  }

  resize(aspect: number): void {
    this.inner.resize(aspect);
  }
}

/** What the director reads of the world (World satisfies it). */
export type CameraWorld = FollowWorld;

const NO_LOOK: LookInput = Object.freeze({ dx: 0, dy: 0 });
const FLAT: GroundFn = () => 0;

const smoothstep = (s: number) => s * s * (3 - 2 * s);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class CameraDirector implements CameraPort {
  /** The gameplay camera: the follow and fight cameras blended, shaken. Kill cams override it (`camera`). */
  readonly view: PerspectiveCamera;
  private world: CameraWorld | null = null;
  private player: Fighter | null = null;
  private lock: Fighter | null = null;
  private ground: GroundFn = FLAT;
  /** Blend progress, 0 (follow) → 1 (fight); the weight is smoothstep(fight). */
  private fight = 0;
  private wantFight = false;
  /** The fight camera's pose as of its last update (held still while blending out of a fight). */
  private readonly rigPos = new Vector3();
  private readonly rigQuat = new Quaternion();
  private rigFov: number = CAMERA_TUNING.fov;
  private trauma = 0;
  private punchAmount = 0;
  private zoom = 1;
  private t = 0;
  private ready = false;

  constructor(
    /** DS's fight camera. */
    readonly rig: CameraRig,
    readonly cine: CinematicsAdapter,
    /** The follow camera out of fights. */
    readonly follow: FollowCam,
  ) {
    this.view = new PerspectiveCamera(CAMERA_TUNING.fov, rig.camera.aspect, 0.1, RENDER_TUNING.cameraFar);
  }

  /** Kill cams override both framings. */
  get camera(): PerspectiveCamera {
    return this.cine.active ? this.cine.camera : this.view;
  }

  /** How far into the fight framing the view is (0 follow … 1 fight; the smoothstep weight). */
  get fightWeight(): number {
    return smoothstep(this.fight);
  }

  /** The shake still to come (0..1; DS trauma). */
  get shakeTrauma(): number {
    return this.trauma;
  }

  update(dt: number, world: CameraWorld, player: Fighter | null, lockTarget: Fighter | null, look: LookInput): void {
    this.t += dt;
    this.world = world;
    this.player = player;
    const ground: GroundFn = (x, z) => world.terrain.heightAt(x, z);
    this.ground = ground;
    this.rig.ground = ground;
    const T = FOLLOW_TUNING;
    this.lock = player && lockTarget && lockTarget.alive && player.distanceTo(lockTarget) < T.fightRangeM ? lockTarget : null;
    if (!player) return;
    const want = this.lock !== null;
    if (!this.ready) {
      // The first frame: straight into whichever framing applies.
      this.ready = true;
      this.follow.snapBehind(player);
      this.fight = want ? 1 : 0;
      this.wantFight = want;
      if (want) this.rig.snap(player, this.lock, player.yaw);
    }

    // Starting a blend from one framing at rest: line the other camera up with it first.
    if (want && !this.wantFight && this.fight === 0) this.rig.snap(player, this.lock, this.follow.yaw);
    if (!want && this.wantFight && this.fight === 1) this.follow.matchView(this.rigQuat);
    this.wantFight = want;

    // The follow camera always runs (it is where the blend out of a fight lands); look input turns it except in a fight
    // (DS's fight camera has no free look). The fight camera runs while there is a fight, else holds its last pose.
    this.follow.update(dt, world, player, this.fight >= 1 ? NO_LOOK : look);
    if (this.lock) {
      this.rig.update(dt, player, this.lock);
      this.rigPos.copy(this.rig.camera.position);
      this.rigQuat.copy(this.rig.camera.quaternion);
      this.rigFov = this.rig.camera.fov;
    }

    // The blend: blendS, but no faster than blendMaxSpeed between cameras far apart (smoothstep's slope is ≤ 1.5).
    const fc = this.follow.camera;
    const gap = fc.position.distanceTo(this.rigPos);
    const rate = Math.min(T.blendS > 0 ? 1 / T.blendS : Infinity, gap > 1e-6 ? T.blendMaxSpeed / (1.5 * gap) : Infinity);
    this.fight = Math.min(1, Math.max(0, this.fight + (want ? 1 : -1) * (Number.isFinite(rate) ? rate * dt : 1)));
    const w = smoothstep(this.fight);

    const v = this.view;
    v.position.copy(fc.position).lerp(this.rigPos, w);
    v.quaternion.copy(fc.quaternion).slerp(this.rigQuat, w);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.punchAmount = Math.max(0, this.punchAmount - dt * 4);
    const fov = fc.fov + (this.rigFov - fc.fov) * w;
    setLens(v, (fov * (1 - this.punchAmount * 0.05)) / this.zoom);
    applyShake(v, this.trauma, this.t);
    // Above the terrain wherever the blend or the shake puts it (each camera's own floor, blended).
    const clear = T.clearance + (CAMERA_TUNING.groundClearanceM - T.clearance) * w;
    v.position.y = Math.max(v.position.y, ground(v.position.x, v.position.z) + clear);
    v.updateMatrixWorld();

    // (main.ts's kill cams pick their side from rig.camera's position — the gameplay camera's side — so the rig's
    // camera shows where the gameplay camera is; the rig re-aims its own camera from its own state on every update.)
    this.rig.camera.position.copy(v.position);
    this.rig.camera.quaternion.copy(v.quaternion);
  }

  /** The ground forward/right of the gameplay camera: the follow camera's heading, the fight camera's, or between. */
  moveBasis(): { forward: Vector3; right: Vector3 } {
    const f = this.follow.yaw;
    const w = smoothstep(this.fight);
    return basisOf(w > 0 ? f + wrap(this.rig.heading - f) * w : f);
  }

  shake(trauma: number): void {
    this.trauma = Math.min(1, this.trauma + trauma * CAMERA_TUNING.shakeMul);
  }

  punch(amount: number): void {
    this.punchAmount = Math.max(this.punchAmount, amount);
  }

  /** DS: the view tightens while slow motion runs. */
  setSlowMotion(on: boolean): void {
    this.zoom = on ? CAMERA_TUNING.slowmoZoom : 1;
  }

  /**
   * The camera's own reactions to the sim's events. A heavy landing is felt (SPEC:581; DS bodyLanding): something over
   * landMinHumans human masses shakes the camera by landShakePerHuman per human mass × how hard it came down (its speed
   * from the event's energy, full at landHardSpeed), at most landShakeMax, fading to nothing landRangePerScaleM × its
   * size (∛ human masses) from the player.
   *
   * TODO(P37, P11): the giant's footfalls (0.05·(scale − 1)·near within 6·scale m, SPEC:849; FEEL_TUNING.giantShake*,
   * §10.9's `giantStep`). Not done here: FEEL_TUNING is P37's table and isn't on this branch, and the sim has no
   * per-step footfall source yet (DS read and cleared f.footwork.landed from the client, a write rule 6 forbids, so in
   * world mode it fills once and stays full). Needs a footfall event (or a cleared-by-the-sim landed list) from the sim.
   */
  handle(e: SimEvent, _world: World): void {
    if (e.type !== 'land') return;
    const T = CAMERA_TUNING;
    const human = humanoidMass();
    if (!(e.mass > 0) || !(human > 0)) return;
    const units = e.mass / human;
    if (!(units > T.landMinHumans)) return;
    const speed = Math.sqrt((2 * Math.max(0, e.energy)) / e.mass);
    const hard = T.landHardSpeed > 0 ? Math.min(1, speed / T.landHardSpeed) : 1;
    const from = this.player?.pos ?? this.view.position;
    const d = Math.hypot(e.point.x - from.x, e.point.y - from.y, e.point.z - from.z);
    const range = T.landRangePerScaleM * Math.cbrt(units);
    const near = range > 0 ? Math.max(0, 1 - d / range) : 0;
    if (near > 0) this.shake(Math.min(T.landShakeMax, T.landShakePerHuman * units * hard) * near);
  }

  /** Behind `f` at once (a respawn): the follow camera, no blend, no shake left over. */
  snapBehind(f: Fighter): void {
    this.follow.snapBehind(f);
    this.rig.snap(f);
    this.fight = 0;
    this.wantFight = false;
    this.trauma = 0;
  }

  /** A see-through ellipse around the player (and the fight), CAMERA_TUNING.cutoutHeightM over the ground (§10.6). */
  cutoutFocus(p: Vector3): void {
    const t = this.lock;
    const w = t ? smoothstep(this.fight) : 0;
    const at = { x: p.x, z: p.z };
    let spread = 0;
    if (t) {
      // (DS: the midpoint of the fight, and wider for the gap and a giant.)
      at.x += (t.pos.x - p.x) * 0.5 * w;
      at.z += (t.pos.z - p.z) * 0.5 * w;
      spread = (Math.hypot(t.pos.x - p.x, t.pos.z - p.z) + (t.scale - 1) * 2.2) * w;
    }
    const cam = this.camera;
    cam.updateMatrixWorld();
    focusCutout(cam, at, this.world ? this.ground : FLAT, spread);
  }

  resize(width: number, height: number): void {
    this.rig.resize(width, height);
    for (const c of [this.follow.camera, this.view]) {
      c.aspect = width / height;
      c.updateProjectionMatrix();
    }
  }
}
