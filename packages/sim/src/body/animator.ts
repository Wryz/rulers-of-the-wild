import { type Ease, ease, smoothstep } from '../sim/math';
import { blendPose, copyPose, makePose, type Pose } from './skeleton';

export interface TrackKey {
  f: number;
  pose: Pose;
  ease?: Ease;
}

/**
 * Plays keyframed pose tracks. The pose held when a track starts becomes an implicit
 * key at frame 0, so every transition blends from wherever the body actually was.
 */
export class Animator {
  readonly out = makePose();
  private readonly snapshot = makePose();
  private keys: TrackKey[] = [];
  private mode: 'track' | 'procedural' = 'procedural';
  private fadeLen = 6;
  private procT = 0;
  /**
   * The pose actually shown (after layers on top of the animation: legs stepping under
   * a punch, the second hand on the haft, a blade kept clear). New tracks start from it,
   * so nothing jumps on their first frame.
   */
  source: Pose | null = null;

  play(keys: TrackKey[]) {
    copyPose(this.source ?? this.out, this.snapshot);
    this.keys = keys;
    this.mode = 'track';
  }

  /** Swap the running track's keys (same timing) without restarting it: re-aiming. */
  retarget(keys: TrackKey[]) {
    if (this.mode === 'track') this.keys = keys;
  }

  /** Switch to a procedurally generated pose, cross-fading over `fadeLen` frames. */
  procedural(fadeLen = 6) {
    copyPose(this.source ?? this.out, this.snapshot);
    this.mode = 'procedural';
    this.fadeLen = Math.max(1, fadeLen);
    this.procT = 0;
  }

  get isProcedural() {
    return this.mode === 'procedural';
  }

  update(t: number, proceduralPose?: Pose): Pose {
    if (this.mode === 'procedural') {
      this.procT++;
      if (proceduralPose) blendPose(this.snapshot, proceduralPose, smoothstep(this.procT / this.fadeLen), this.out);
      return this.out;
    }
    let prevF = 0;
    let prevPose = this.snapshot;
    for (const k of this.keys) {
      if (t < k.f) {
        const span = k.f - prevF;
        const u = span <= 0 ? 1 : (t - prevF) / span;
        return blendPose(prevPose, k.pose, ease(k.ease ?? 'inOut', u), this.out);
      }
      prevF = k.f;
      prevPose = k.pose;
    }
    return copyPose(prevPose, this.out);
  }
}
