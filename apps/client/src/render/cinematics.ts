import { PerspectiveCamera, Vector3 } from 'three';

/**
 * A camera cut: where to look, where the camera sits relative to that (spherical, in
 * the shot's own frame), how it moves, how long it lasts and how slow time runs.
 */
export interface Shot {
  /** What the camera looks at (world), re-read every frame so it can follow. */
  focus: () => Vector3;
  /** Ground direction the camera sits in, from the focus (normalised on use). */
  side: Vector3;
  distance: number;
  /** Camera height above the focus (m; negative = looking up). */
  height: number;
  /** Orbit speed around the focus (rad/s, real time). */
  orbit?: number;
  /** Change in distance per second (negative = push in). */
  dolly?: number;
  fov?: number;
  /** Real seconds. */
  duration: number;
  /** Time scale while the shot runs. */
  slow: number;
  /** Higher interrupts lower. */
  priority: number;
  /** Called when the shot ends (or is cut short by a bigger one). */
  onEnd?: () => void;
}

/**
 * Cinematic cuts: a perspective camera that takes over for emphasised moments (a
 * limb coming off, the finishing blow, a death, a win, a boss walking in) with slow
 * motion and letterbox bars, then hands back to the gameplay camera.
 */
export class Cinematics {
  readonly camera = new PerspectiveCamera(38, 16 / 9, 0.05, 200);
  private shot: Shot | null = null;
  private t = 0;
  private readonly look = new Vector3();
  private readonly side = new Vector3();
  /** Cooldown so frequent small moments don't keep cutting away. */
  private quiet = 0;
  onChange: ((active: boolean) => void) | null = null;
  /** Is the line from a camera spot to what it looks at obstructed? (Set by the game.) */
  blocked: ((cam: Vector3, look: Vector3) => boolean) | null = null;

  get active() {
    return this.shot !== null;
  }

  get timeScale() {
    if (!this.shot) return 1;
    // Ease back to full speed over the last quarter of a shot.
    const u = this.t / this.shot.duration;
    const back = Math.max(0, (u - 0.75) / 0.25);
    return this.shot.slow + (1 - this.shot.slow) * back * back;
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Cut to a shot. Minor shots (priority <= 1) respect a cooldown. */
  play(shot: Shot): boolean {
    if (this.shot && this.shot.priority > shot.priority) return false;
    if (shot.priority <= 1 && this.quiet > 0) return false;
    const prev = this.shot;
    this.shot = shot;
    this.t = 0;
    this.side.copy(shot.side).setY(0);
    if (this.side.lengthSq() < 1e-6) this.side.set(0, 0, 1);
    this.side.normalize();
    this.look.copy(shot.focus());
    this.clearAngle(shot);
    prev?.onEnd?.();
    if (!prev) this.onChange?.(true);
    this.place(0);
    return true;
  }

  /**
   * Swing the shot round to an angle whose whole orbit keeps a clear view (nearest the
   * one asked for), so it never films through a pillar or from inside the scenery.
   */
  private clearAngle(s: Shot) {
    if (!this.blocked) return;
    const base = this.side.clone();
    const spot = new Vector3();
    const dir = new Vector3();
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7]) {
      let clear = true;
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const t = s.duration * u;
        dir.copy(base).applyAxisAngle(_up, k * 0.4 + (s.orbit ?? 0) * t);
        const d = Math.max(0.6, s.distance + (s.dolly ?? 0) * t);
        spot.copy(this.look).addScaledVector(dir, d);
        spot.y = Math.max(0.15, this.look.y + s.height);
        if (this.blocked(spot, this.look)) {
          clear = false;
          break;
        }
      }
      if (clear) {
        this.side.copy(base).applyAxisAngle(_up, k * 0.4);
        return;
      }
    }
  }

  stop() {
    const s = this.shot;
    if (!s) return;
    this.shot = null;
    this.quiet = 6;
    s.onEnd?.();
    this.onChange?.(false);
  }

  /** Advance (real seconds). */
  update(dt: number) {
    this.quiet = Math.max(0, this.quiet - dt);
    const s = this.shot;
    if (!s) return;
    this.t += dt;
    if (this.t >= s.duration) {
      this.stop();
      return;
    }
    if (s.orbit) this.side.applyAxisAngle(_up, s.orbit * dt);
    this.place(dt);
  }

  private place(dt: number) {
    const s = this.shot!;
    // Follow the subject softly, like a camera operator.
    const f = s.focus();
    this.look.lerp(f, dt === 0 ? 1 : 1 - Math.exp(-dt * 8));
    const d = Math.max(0.6, s.distance + (s.dolly ?? 0) * this.t);
    const cam = this.camera;
    cam.position.copy(this.look).addScaledVector(this.side, d);
    cam.position.y = Math.max(0.15, this.look.y + s.height);
    cam.fov = s.fov ?? 38;
    cam.updateProjectionMatrix();
    cam.lookAt(this.look);
  }
}

const _up = new Vector3(0, 1, 0);
