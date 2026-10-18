// DungeonStyle's fight camera (docs/M1-DESIGN.md §10.6, SPEC:35, 637): the three-quarter view used while the player is
// locked onto a creature; render/cameraDirector.ts blends it with the follow camera. Changed for the Clearing (P34):
// - heights are relative to the ground (`ground(x, z)`, the director hands it the terrain): the camera's height over the
//   ground under the fight's focus, each fighter's chest over its own feet (`pos.y`, which the sim's movers keep on the
//   ground; 0 on DS's flat floor, so the DS framing is unchanged there);
// - the arena containment (`inside`, the side switch and the wall squeeze) is gone: the camera stays at least
//   CAMERA_TUNING.groundClearanceM above the terrain, and trunks between it and the fight dissolve (render/cutout.ts);
// - far plane RENDER_TUNING.cameraFar (600 m); CAMERA_TUNING is a registered live table;
// - shake, the zoom punch and the slow-motion zoom moved to the director (render/cameraDirector.ts), which applies them
//   to whichever camera the frame is seen through, so the rig no longer has its own.
import { PerspectiveCamera, Vector3 } from 'three';
import { defineTuning } from '@wild/sim';
import { RENDER_TUNING } from './terrainView';

export const CAMERA_TUNING = defineTuning(
  'CAMERA_TUNING',
  'Client › camera',
  {
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
    /** The fight camera stays this far above the terrain under it (m): replaces DS's arena containment. */
    groundClearanceM: 0.3,
    // Not §9.1 rows (P34 DEVIATIONS): the DS values the changed and new camera code reads. (The framing arithmetic
    // inside CameraRig.place — gap × 0.85, a giant's 2.2 m and 1.4 m per scale, chest heights — stays as DS wrote it.)
    /** How fast the shake dies away (trauma per second; DS cameraRig). */
    traumaDecay: 1.6,
    /** The shake's reach at full trauma: across the screen (m) and in roll (rad) (DS cameraRig). */
    shakeAmpM: 0.12,
    shakeRollRad: 0.025,
    /** How fast a zoom punch dies away (per second), and how much it narrows the view per unit (DS cameraRig). */
    punchDecay: 4,
    punchFov: 0.05,
    /** A camera cut never goes lower than this over the ground under it (m; DS cinematics.ts floor, over y = 0). */
    cutFloorM: 0.15,
    /** The view tightens by this while slow motion runs (fov divisor; DS game.ts camRig.zoom). */
    slowmoZoom: 1.12,
    /** The see-through ellipse is centred this high over the ground under the player (m; DS cutFocus.y = 1). */
    cutoutHeightM: 1,
    /** The ellipse's half-height (NDC), and how it widens with the fight's spread (DS game.ts updateCutout call). */
    cutoutRadius: 0.3,
    cutoutSpreadPerM: 0.06,
    cutoutSpreadMax: 0.25,
    /** A big opponent counts as this much more spread per unit of scale over 1 (m; DS game.ts updateCutout call). */
    cutoutSpreadPerScale: 2.2,
    /** A big body or a heavy thing landing shakes the camera (DS bodyLanding, now from the sim's `land` event). */
    landShakePerHuman: 0.08,
    landShakeMax: 0.6,
    /** Only something heavier than this many humans is felt (DS: a body over 1.5 "mass", scale³). */
    landMinHumans: 1.5,
    /** The landing speed at which it is felt fully (m/s; DS: hard = fall speed / 5). */
    landHardSpeed: 5,
    /** Felt within this many metres per unit of size (∛ humans): a human-sized body 6 m, a 300 kg log 9.5 m. */
    landRangePerScaleM: 6,
  },
  {
    fov: { unit: '°', source: 'DS (cameraRig.ts:3)', min: 30, max: 90, step: 1 },
    distance: { unit: 'm', source: 'DS (cameraRig.ts:3)', min: 1.5, max: 8, step: 0.05 },
    rise: { unit: 'm', source: 'DS (cameraRig.ts:3)', min: 0.5, max: 5, step: 0.05 },
    sideAngle: { unit: 'rad', source: 'DS (cameraRig.ts:3)', min: 0, max: 1.4, step: 0.02, label: 'side angle' },
    shoulder: { unit: 'm', source: 'DS (cameraRig.ts:3)', min: -1, max: 1, step: 0.05 },
    turnRate: { unit: 'rad/s (spring)', source: 'DS', min: 0.5, max: 10, step: 0.1, label: 'turn spring' },
    follow: { unit: '1/s', source: 'DS', min: 0.5, max: 30, step: 0.5 },
    shakeMul: { unit: '×', source: 'DS', min: 0, max: 3, step: 0.05, label: 'shake ×' },
    focusMix: { unit: 'fraction', source: 'DS', min: 0, max: 1, step: 0.01, label: 'focus mix' },
    groundClearanceM: { unit: 'm', source: 'NEW: replaces arena containment (§10.6)', min: 0, max: 2, step: 0.05, label: 'ground clearance' },
    traumaDecay: { unit: 'trauma/s', source: 'DS (cameraRig.ts update: 1.6/s)', min: 0.1, max: 10, step: 0.1, label: 'shake decay' },
    shakeAmpM: { unit: 'm', source: 'DS (cameraRig.ts update: ±0.12 m)', min: 0, max: 1, step: 0.01, label: 'shake reach' },
    shakeRollRad: { unit: 'rad', source: 'DS (cameraRig.ts update: ±0.025 rad)', min: 0, max: 0.2, step: 0.005, label: 'shake roll' },
    punchDecay: { unit: '1/s', source: 'DS (cameraRig.ts update: 4/s)', min: 0.1, max: 20, step: 0.1, label: 'punch decay' },
    punchFov: { unit: 'fov fraction per punch', source: 'DS (cameraRig.ts update: fov × (1 − 0.05·punch))', min: 0, max: 0.3, step: 0.005, label: 'punch narrows' },
    cutFloorM: { unit: 'm', source: 'DS (cinematics.ts place: 0.15 over y = 0); §10.6', min: 0, max: 2, step: 0.05, label: 'cut floor' },
    slowmoZoom: { unit: '× (fov divisor)', source: 'DS (game.ts: camRig.zoom = 1.12 in slow motion)', min: 1, max: 2, step: 0.01, label: 'slow-mo zoom' },
    cutoutHeightM: { unit: 'm', source: 'DS (game.ts cutFocus.y = 1), over the ground (§10.6)', min: 0, max: 3, step: 0.05, label: 'cutout height' },
    cutoutRadius: { unit: 'NDC', source: 'DS (game.ts updateCutout: 0.3)', min: 0.05, max: 1, step: 0.01, label: 'cutout radius' },
    cutoutSpreadPerM: { unit: 'NDC per m', source: 'DS (game.ts updateCutout: spread × 0.06)', min: 0, max: 0.5, step: 0.005, label: 'cutout per m' },
    cutoutSpreadMax: { unit: 'NDC', source: 'DS (game.ts updateCutout: ≤ 0.25)', min: 0, max: 1, step: 0.01, label: 'cutout spread max' },
    cutoutSpreadPerScale: { unit: 'm per scale over 1', source: 'DS (game.ts updateCutout: (scale − 1) × 2.2)', min: 0, max: 10, step: 0.1, label: 'cutout per scale' },
    landShakePerHuman: { unit: 'trauma per human mass', source: 'DS (game.ts bodyLanding: 0.08·mass·hard)', min: 0, max: 1, step: 0.01, label: 'landing shake' },
    landShakeMax: { unit: 'trauma', source: 'DS (game.ts bodyLanding: ≤ 0.6)', min: 0, max: 1, step: 0.05, label: 'landing shake max' },
    landMinHumans: { unit: 'human masses', source: 'DS (game.ts bodyLanding: mass > 1.5)', min: 0, max: 20, step: 0.1, label: 'landing felt over' },
    landHardSpeed: { unit: 'm/s', source: 'DS (game.ts bodyLanding: fall speed / 5)', min: 0.5, max: 30, step: 0.5, label: 'landing full at' },
    landRangePerScaleM: { unit: 'm per ∛(human masses)', source: 'NEW: DS giant footfalls are felt within 6 m × scale', min: 0, max: 30, step: 0.5, label: 'landing felt within' },
  },
);

/** What the camera follows. `pos.y` is the feet (0 on DS's flat floor; the sim's movers keep it on the ground). */
export interface Followed {
  pos: Vector3;
  yaw: number;
  scale: number;
}

/** Ground height (m) at a point: the terrain (DS: the floor at 0). */
export type GroundFn = (x: number, z: number) => number;

const FLAT: GroundFn = () => 0;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Keeps the camera's projection in step with the live tables (fov, far plane): reprojects only on a change. */
export function setLens(cam: PerspectiveCamera, fov: number): void {
  const far = RENDER_TUNING.cameraFar;
  if (cam.fov !== fov || cam.far !== far) {
    cam.fov = fov;
    cam.far = far;
    cam.updateProjectionMatrix();
  }
}

/**
 * Fight camera: a three-quarter view from behind you and off to one side of the line
 * between you and your opponent, high enough to look down over your shoulder — so both of
 * you are always in shot and they're never hidden behind you. It pulls back as you
 * separate (and for a giant) and swings round on a spring as you circle. Out of a fight
 * it sits behind you. (Its shake and zoom punch are the director's now.)
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  private yaw = 0;
  private yawVel = 0;
  /** Which side of the line between the fighters the camera works from (+1 / -1). */
  private side: 1 | -1 = 1;
  /** How far back the camera currently is (eased, so it doesn't pump with every step). */
  private dist = 0;
  /** Where the camera is (eased toward where it should be). */
  private readonly spot = new Vector3();
  private readonly look = new Vector3();
  private ready = false;
  /** The ground under a point (the director sets the terrain's; DS's flat floor by default). */
  ground: GroundFn = FLAT;

  constructor() {
    this.camera = new PerspectiveCamera(CAMERA_TUNING.fov, 16 / 9, 0.1, RENDER_TUNING.cameraFar);
  }

  /** Ground-plane forward/right of the view, for camera-relative movement input. */
  get groundForward() {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
  get groundRight() {
    // (A fighter's +X is their left: screen right is the other way.)
    return new Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  /** The heading the camera looks along (rad, from +z toward +x: the move convention). */
  get heading(): number {
    return this.yaw;
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Jump straight to behind `f` (a new round, a respawn), or into the fight with `target`. `nearYaw` (P34): work from
   * the side of the fight whose heading is nearer this one (the camera the director is blending from), so the blend
   * into the fight doesn't swing across the line between the fighters.
   */
  snap(f: Followed, target: Followed | null = null, nearYaw: number | null = null) {
    if (target && nearYaw !== null) {
      const toThem = Math.atan2(target.pos.x - f.pos.x, target.pos.z - f.pos.z);
      const a = Math.abs(wrap(toThem - CAMERA_TUNING.sideAngle - nearYaw));
      const b = Math.abs(wrap(toThem + CAMERA_TUNING.sideAngle - nearYaw));
      this.side = a <= b ? 1 : -1;
    }
    this.yaw = this.headingFor(f, target);
    this.yawVel = 0;
    this.dist = 0;
    this.place(f, target, 1);
    this.ready = true;
    this.aim();
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
    if (!this.ready) this.snap(f, target);
    // Swing round to the heading: a critically damped spring, so a turn starts slowly,
    // carries, and settles without overshooting.
    const w = CAMERA_TUNING.turnRate;
    const diff = wrap(this.headingFor(f, target) - this.yaw);
    this.yawVel += (w * w * diff - 2 * w * this.yawVel) * dt;
    this.yaw = wrap(this.yaw + this.yawVel * dt);
    this.place(f, target, 1 - Math.exp(-dt * CAMERA_TUNING.follow));
    this.aim();
  }

  /** The camera at the rig's position, looking at its look point, with its lens. */
  private aim() {
    const cam = this.camera;
    cam.position.copy(this.spot);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    setLens(cam, CAMERA_TUNING.fov);
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
      // (Over the ground under the fight, not over y = 0.)
      _want.set(mx - fx * this.dist, this.ground(mx, mz) + height, mz - fz * this.dist);
    } else {
      this.dist = 0;
      const dist = T.distance * s;
      const height = (T.rise - 0.2) * s;
      _want.set(f.pos.x - fx * dist - fz * T.shoulder, f.pos.y + height, f.pos.z - fz * dist + fx * T.shoulder);
    }
    // Never into the hillside: at least groundClearanceM over the terrain where it stands (DS kept it in the arena).
    _want.y = Math.max(_want.y, this.ground(_want.x, _want.z) + T.groundClearanceM);
    this.spot.lerp(_want, k);
    this.spot.y = Math.max(this.spot.y, this.ground(this.spot.x, this.spot.z) + T.groundClearanceM);
    // Look past the player at the fight (or ahead of them, out of one): chests over their own feet.
    if (target) {
      // Between you, at chest height — a little nearer them.
      _aim.set(target.pos.x, target.pos.y + 1.15 * target.scale, target.pos.z);
      _lookWant.set(f.pos.x, f.pos.y + 1.0 * s, f.pos.z).lerp(_aim, T.focusMix);
    } else {
      _lookWant.set(f.pos.x + fx * 2.2 * s, f.pos.y + 1.15 * s, f.pos.z + fz * 2.2 * s);
    }
    if (k >= 1) this.look.copy(_lookWant);
    else this.look.lerp(_lookWant, Math.min(1, k * 1.4));
  }
}

const _want = new Vector3();
const _aim = new Vector3();
const _lookWant = new Vector3();
