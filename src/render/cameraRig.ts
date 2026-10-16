import { PerspectiveCamera, Vector3 } from 'three';

export const CAMERA_TUNING = {
  /** Vertical field of view (degrees). */
  fov: 52,
  /** How far back from the fight the camera sits beyond what it takes to fit both in (m). */
  distance: 3.4,
  /** Camera height (m, for someone your size): high enough to look down over your shoulder at them. */
  rise: 2.35,
  /**
   * How far round to the side of the line between the fighters the camera sits (rad):
   * behind you and off to one side, so you never stand between it and your opponent.
   */
  sideAngle: 0.6,
  /** Out of a fight (no one near): off to the right of behind you a little. */
  shoulder: 0.7,
  /**
   * How briskly the camera swings round after the player turns (rad/s of a critically
   * damped spring): it lags, picks up speed, and eases in as it catches up.
   */
  turnRate: 3.2,
  /** How tightly it follows the player's position (1/s): close, not rigid. */
  follow: 7,
  shakeMul: 1,
  /** 0.5 frames the midpoint between the fighters, 0 frames the player. */
  focusMix: 0.55,
};

/** What the camera follows. */
export interface Followed {
  pos: Vector3;
  yaw: number;
  scale: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Fight camera: a three-quarter view from behind you and off to one side of the line
 * between you and your opponent, high enough to look down over your shoulder — so both of
 * you are always in shot and they're never hidden behind you. It pulls back as you
 * separate (and for a giant), swings round on a spring as you circle, and switches sides
 * rather than backing into a wall. Out of a fight it sits behind you. Trauma-based shake
 * on top.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  private yaw = 0;
  private yawVel = 0;
  /** Which side of the line between the fighters the camera works from (+1 / -1). */
  private side: 1 | -1 = 1;
  private sideSwitchCool = 0;
  /** How far back the camera currently is (eased, so it doesn't pump with every step). */
  private dist = 0;
  private squeeze = 0;
  private squeezeEased = 0;
  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  private trauma = 0;
  private punch = 0;
  private t = 0;
  private ready = false;
  zoom = 1;
  /** Is this ground point inside the arena? (The camera stays in the room.) */
  inside: ((x: number, z: number) => boolean) | null = null;

  constructor() {
    this.camera = new PerspectiveCamera(CAMERA_TUNING.fov, 16 / 9, 0.1, 300);
  }

  /** Ground-plane forward/right of the view, for camera-relative movement input. */
  get groundForward() {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  get groundRight() {
    // (A fighter's +X is their left: screen right is the other way.)
    return new Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addTrauma(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount * CAMERA_TUNING.shakeMul);
  }

  zoomPunch(amount: number) {
    this.punch = Math.max(this.punch, amount);
  }

  /** Jump straight to behind `f` (a new round, a respawn). */
  snap(f: Followed, target: Followed | null = null) {
    this.yaw = this.headingFor(f, target);
    this.yawVel = 0;
    this.dist = 0;
    this.place(f, target, 1);
    this.ready = true;
  }

  /**
   * Which way the camera looks: in a fight, along the line from you to them, swung round
   * to one side, so both of you are in shot and they're never hidden behind you. Out of
   * one, the way you're facing.
   */
  private headingFor(f: Followed, target: Followed | null): number {
    if (!target) return f.yaw;
    const toThem = Math.atan2(target.pos.x - f.pos.x, target.pos.z - f.pos.z);
    return toThem - this.side * CAMERA_TUNING.sideAngle;
  }

  update(dt: number, f: Followed, target: Followed | null) {
    this.t += dt;
    if (!this.ready) this.snap(f, target);
    this.sideSwitchCool = Math.max(0, this.sideSwitchCool - dt);
    // Backed into a wall on this side: work from the other side instead.
    if (target && this.inside && this.sideSwitchCool <= 0 && this.blocked(f, target, this.side) && !this.blocked(f, target, -this.side as 1 | -1)) {
      this.side = -this.side as 1 | -1;
      this.sideSwitchCool = 1.5;
    }
    // Swing round to the heading: a critically damped spring, so a turn starts slowly,
    // carries, and settles without overshooting.
    const w = CAMERA_TUNING.turnRate;
    const diff = wrap(this.headingFor(f, target) - this.yaw);
    this.yawVel += (w * w * diff - 2 * w * this.yawVel) * dt;
    this.yaw = wrap(this.yaw + this.yawVel * dt);
    this.place(f, target, 1 - Math.exp(-dt * CAMERA_TUNING.follow));

    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.punch = Math.max(0, this.punch - dt * 4);
    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    // Shake in screen space.
    const s = this.trauma * this.trauma;
    if (s > 0) {
      const n = (fq: number, o: number) => Math.sin(this.t * fq + o) * 0.6 + Math.sin(this.t * fq * 2.3 + o * 1.7) * 0.4;
      cam.updateMatrixWorld();
      const right = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      cam.position.addScaledVector(right, n(47, 0) * s * 0.12).addScaledVector(up, n(53, 2) * s * 0.12);
      cam.rotateZ(n(31, 5) * s * 0.025);
    }
    // (Squeezed in by a wall, see a little wider.)
    this.squeezeEased += (this.squeeze - this.squeezeEased) * Math.min(1, dt * 4);
    const fov = (CAMERA_TUNING.fov * (1 + this.squeezeEased * 0.25) * (1 - this.punch * 0.05)) / this.zoom;
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Would the camera, working from `side`, end up outside the arena? */
  private blocked(f: Followed, target: Followed, side: 1 | -1): boolean {
    const yaw = Math.atan2(target.pos.x - f.pos.x, target.pos.z - f.pos.z) - side * CAMERA_TUNING.sideAngle;
    const d = this.dist || CAMERA_TUNING.distance;
    const mx = f.pos.x + (target.pos.x - f.pos.x) * CAMERA_TUNING.focusMix;
    const mz = f.pos.z + (target.pos.z - f.pos.z) * CAMERA_TUNING.focusMix;
    return !this.inside!(mx - Math.sin(yaw) * d * 0.8, mz - Math.cos(yaw) * d * 0.8);
  }

  /** Move toward where the camera should be (k = 1: there at once). */
  private place(f: Followed, target: Followed | null, k: number) {
    const T = CAMERA_TUNING;
    const s = f.scale;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    if (target) {
      // Both fighters in shot: back far enough to fit the gap between them (and a giant
      // all the way up), looking down at the space between you.
      const big = Math.max(0, target.scale - 1);
      const gap = Math.hypot(target.pos.x - f.pos.x, target.pos.z - f.pos.z);
      const want = T.distance * s + gap * 0.85 + big * 2.2;
      this.dist = this.dist ? this.dist + (want - this.dist) * Math.min(1, k * 0.6) : want;
      const mx = f.pos.x + (target.pos.x - f.pos.x) * T.focusMix;
      const mz = f.pos.z + (target.pos.z - f.pos.z) * T.focusMix;
      const height = T.rise * s + gap * 0.25 + big * 1.4;
      _want.set(mx - fx * this.dist, height, mz - fz * this.dist);
    } else {
      this.dist = 0;
      const dist = T.distance * s;
      const height = (T.rise - 0.2) * s;
      _want.set(f.pos.x - fx * dist - fz * T.shoulder, height, f.pos.z - fz * dist + fx * T.shoulder);
    }
    const fp = target ? _mid.set(f.pos.x + (target.pos.x - f.pos.x) * T.focusMix, 0, f.pos.z + (target.pos.z - f.pos.z) * T.focusMix) : f.pos;
    // Backed up against a wall: come in closer (and look down a little more steeply)
    // rather than ending up on the other side of it.
    this.squeeze = 0;
    if (this.inside) {
      let u = 1;
      // (Never so close the player drops out of the picture: past that, the wall behind
      // is dissolved instead — see the cutout.)
      while (u > 0.5 && !this.inside(fp.x + (_want.x - fp.x) * u, fp.z + (_want.z - fp.z) * u)) u -= 0.05;
      _want.x = fp.x + (_want.x - fp.x) * u;
      _want.z = fp.z + (_want.z - fp.z) * u;
      // (Brought in close by a wall: go up instead, looking down on the two of you.)
      _want.y += (1 - u) * 3.2 * s;
      this.squeeze = 1 - u;
    }
    this.pos.lerp(_want, k);
    // Look past the player at the fight (or ahead of them, out of one).
    if (target) {
      // Between you, at chest height — a little nearer them.
      _aim.set(target.pos.x, 1.15 * target.scale, target.pos.z);
      _lookWant.set(f.pos.x, 1.0 * s, f.pos.z).lerp(_aim, T.focusMix);
    } else {
      _lookWant.set(f.pos.x + fx * 2.2 * s, 1.15 * s, f.pos.z + fz * 2.2 * s);
    }
    if (k >= 1) this.look.copy(_lookWant);
    else this.look.lerp(_lookWant, Math.min(1, k * 1.4));
  }
}

const _want = new Vector3();
const _mid = new Vector3();
const _aim = new Vector3();
const _lookWant = new Vector3();
