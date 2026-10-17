// The camera director (docs/M1-DESIGN.md §10.6): the follow camera out of fights, DungeonStyle's fight camera
// (render/cameraRig.ts) while locked on, a 0.45 s blend between them, and kill cams (render/cinematics.ts) over both.
// The movement basis of `move` commands is the active camera's ground forward/right. Also the CinematicsPort adapter.
//
// STUB (P31; P34 fills it): DungeonStyle's behaviour behind the ports: the CameraRig frames the fight while the player's
// target is alive and within FOLLOW_TUNING.fightRangeM, and sits behind the player otherwise; Cinematics plays the cuts;
// the cutout keeps the player in sight. P34: the follow camera, the blend, ground-relative heights, the terrain floor
// and line of sight of cuts, far planes.
import type { PerspectiveCamera, Vector3 } from 'three';
import type { Fighter, World } from '@wild/sim';
import type { CameraPort, CinematicsPort, SimEvent } from '../game/ports';
import type { CameraRig } from './cameraRig';
import type { Cinematics, Shot } from './cinematics';
import { updateCutout } from './cutout';
import { FOLLOW_TUNING, type FollowCam } from './followCam';

/** DS Cinematics behind CinematicsPort. */
export class CinematicsAdapter implements CinematicsPort {
  /** TODO(P34): the cut's floor clamp at ground(x, z) + 0.15 (DS: 0.15 over y = 0). */
  ground: (x: number, z: number) => number = () => 0;

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

  play(shot: Shot): boolean {
    return this.inner.play(shot);
  }

  update(dt: number): void {
    this.inner.update(dt);
  }

  setGround(ground: (x: number, z: number) => number): void {
    this.ground = ground;
  }

  setBlocked(blocked: (a: Vector3, b: Vector3) => boolean): void {
    this.inner.blocked = blocked;
  }

  resize(aspect: number): void {
    this.inner.resize(aspect);
  }
}

export class CameraDirector implements CameraPort {
  private world: World | null = null;
  private lock: Fighter | null = null;

  constructor(
    /** DS's fight camera (and, until P34, the camera out of fights too). */
    readonly rig: CameraRig,
    readonly cine: CinematicsAdapter,
    /** TODO(P34): the follow camera out of fights, blended with the rig over FOLLOW_TUNING.blendS. */
    readonly follow: FollowCam | null = null,
  ) {}

  /** Kill cams override both framings. */
  get camera(): PerspectiveCamera {
    return this.cine.active ? this.cine.camera : this.rig.camera;
  }

  update(dt: number, world: World, player: Fighter | null, lockTarget: Fighter | null, _look: { dx: number; dy: number }): void {
    this.world = world;
    this.lock = player && lockTarget && lockTarget.alive && player.distanceTo(lockTarget) < FOLLOW_TUNING.fightRangeM ? lockTarget : null;
    if (player) this.rig.update(dt, player, this.lock);
  }

  moveBasis(): { forward: Vector3; right: Vector3 } {
    return { forward: this.rig.groundForward, right: this.rig.groundRight };
  }

  shake(trauma: number): void {
    this.rig.addTrauma(trauma);
  }

  punch(amount: number): void {
    this.rig.zoomPunch(amount);
  }

  /** DS: the fight camera tightens (×1.12) while slow motion runs. */
  setSlowMotion(on: boolean): void {
    this.rig.zoom = on ? 1.12 : 1;
  }

  /**
   * TODO(P34): landings felt ∝ mass and distance (SPEC:581; DS bodyLanding: trauma min(0.6, 0.08·mass·hard) for a body
   * over 1.5 "mass"; DS jump landings 0.08·scale for a fighter over 1.3 scale), and the giant's footfalls
   * (FEEL_TUNING.giantShake*, 0.05·(scale − 1)·near within 6·scale m, SPEC:849). The `land` event carries the point,
   * mass and energy; footfalls need a per-step source (DS read f.footwork.landed, see feel/sfxPort.ts).
   */
  handle(_e: SimEvent, _world: World): void {}

  snapBehind(f: Fighter): void {
    this.rig.snap(f);
  }

  /** DS: a see-through ellipse around the player (and the fight), at ground + 1 m (§10.6). */
  cutoutFocus(p: Vector3): void {
    const focus = p.clone();
    const t = this.lock;
    if (t) focus.lerp(t.pos, 0.5);
    focus.y = (this.world?.terrain.heightAt(focus.x, focus.z) ?? 0) + 1;
    const spread = t ? Math.hypot(t.pos.x - p.x, t.pos.z - p.z) + (t.scale - 1) * 2.2 : 0;
    const cam = this.camera;
    updateCutout(cam, focus, 0.3 + Math.min(0.25, spread * 0.06), cam.aspect);
  }

  resize(width: number, height: number): void {
    this.rig.resize(width, height);
  }
}
