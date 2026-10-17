import { type Ease, ease, smoothstep } from '../sim/math';
import type { Quat, V3 } from '../world/types';
import { BONES, blendPose, copyPose, makePose, type Pose } from './skeleton';

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

  // ---------------------------------------------------------------------------
  // Save record (docs/M1-DESIGN.md §8.3, P04; MAP gap-7 §3.5)
  // ---------------------------------------------------------------------------

  /**
   * The animator's state: the snapshot a track blends from, the keys **by value** (they may point at the fighter's
   * impact, retract and react poses, which are rewritten before each reuse, so their aliasing need not survive), the
   * mode, the cross-fade length and its clock. `source` is the fighter's pose (re-linked at construction) and `out` is
   * rewritten by every update before it is read, so neither is saved.
   */
  toRecord(): AnimatorRecord {
    return {
      snapshot: poseToRecord(this.snapshot),
      keys: this.keys.map(trackKeyToRecord),
      mode: this.mode,
      fadeLen: this.fadeLen,
      procT: this.procT,
    };
  }

  /** Puts back a toRecord() state (keys become fresh poses). */
  restoreRecord(r: AnimatorRecord) {
    poseFromRecord(r.snapshot, this.snapshot);
    this.keys = r.keys.map(trackKeyFromRecord);
    this.mode = enumFromRecord(r.mode, ANIM_MODES, 'anim.mode');
    this.fadeLen = numFromRecord(r.fadeLen, 'anim.fadeLen');
    this.procT = numFromRecord(r.procT, 'anim.procT');
  }
}

// ---------------------------------------------------------------------------
// Records of the body (docs/M1-DESIGN.md §8.3, P04). Records are plain data written with a fixed key order: numbers as
// they are (−0 kept), vectors as V3, quaternions as Quat, poses by value. P13's canonical writer turns a non-finite
// number into '$inf', '$-inf' or '$nan'; numFromRecord is its reader. Every field is read back through a checking
// reader (numFromRecord, boolFromRecord, strFromRecord, enumFromRecord, signFromRecord), shared by every record reader
// of the body and the fighter (footwork.ts, idle.ts, sim/fighter.ts, sim/ai.ts), so a broken or hand-edited save
// fails at the field it breaks instead of loading a wrong value.
// ---------------------------------------------------------------------------

/** A pose by value (55 numbers): the pelvis root, each bone's local rotation in BONES order, the blade direction, the grip slide. */
export type PoseRecord = { root: V3; rot: Quat[]; blade: V3; slide: number };

/** A track key by value; `ease` null when the key has none (the animator's default, 'inOut'). */
export type TrackKeyRecord = { f: number; pose: PoseRecord; ease: Ease | null };

/** Animator's saved state (Animator.toRecord). */
export type AnimatorRecord = {
  snapshot: PoseRecord;
  keys: TrackKeyRecord[];
  mode: 'track' | 'procedural';
  fadeLen: number;
  procT: number;
};

/**
 * One number read back from a record: a number as it is (−0 included), or the string the canonical writer gives a
 * non-finite number ('$inf', '$-inf', '$nan'; docs/M1-DESIGN.md §8.3). Anything else is a broken record and throws, so
 * a JSON null (what JSON.stringify makes of Infinity) is never read as a number (MAP gap-7 §6: `null >= x` is false
 * where `Infinity >= x` is true).
 */
export function numFromRecord(v: unknown, field: string): number {
  if (typeof v === 'number') return v;
  if (v === '$inf') return Infinity;
  if (v === '$-inf') return -Infinity;
  if (v === '$nan') return NaN;
  throw notA(field, v, 'a number');
}

/** A boolean read back from a record; anything else throws. */
export function boolFromRecord(v: unknown, field: string): boolean {
  if (typeof v === 'boolean') return v;
  throw notA(field, v, 'a boolean');
}

/** A string read back from a record; anything else throws. */
export function strFromRecord(v: unknown, field: string): string {
  if (typeof v === 'string') return v;
  throw notA(field, v, 'a string');
}

/**
 * One member of a closed set of strings read back from a record. `domain` is keyed by every member (typed
 * `Record<Union, …>`, so the compiler keeps it complete when the union grows); anything else throws.
 */
export function enumFromRecord<K extends string>(v: unknown, domain: Readonly<Record<K, unknown>>, field: string): K {
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(domain, v)) return v as K;
  throw notA(field, v, `one of ${Object.keys(domain).join(', ')}`);
}

/** A side as ±1 (weave, detour, circling) read back from a record; anything else throws. */
export function signFromRecord(v: unknown, field: string): 1 | -1 {
  if (v === 1 || v === -1) return v;
  throw notA(field, v, '1 or -1');
}

function notA(field: string, v: unknown, what: string): Error {
  return new Error(`save record: ${field} is ${v === undefined ? 'missing' : JSON.stringify(v)}, not ${what}`);
}

const ANIM_MODES: Record<AnimatorRecord['mode'], true> = { track: true, procedural: true };
const EASES: Record<Ease, true> = { linear: true, in: true, out: true, inOut: true, snap: true };

/** A vector as a record (any { x, y, z }: Three's Vector3 or a V3). */
export function v3Record(v: Readonly<V3>): V3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Reads a V3 record into `out` (a Vector3 the owner keeps, so its identity survives). */
export function readV3<T extends { set(x: number, y: number, z: number): unknown }>(r: V3, out: T, field: string): T {
  out.set(numFromRecord(r.x, `${field}.x`), numFromRecord(r.y, `${field}.y`), numFromRecord(r.z, `${field}.z`));
  return out;
}

export function poseToRecord(p: Pose): PoseRecord {
  return {
    root: v3Record(p.root),
    rot: BONES.map((b) => {
      const q = p.rot[b];
      return { x: q.x, y: q.y, z: q.z, w: q.w };
    }),
    blade: v3Record(p.blade),
    slide: p.slide,
  };
}

/** Reads a pose record into `out` (default a new pose). */
export function poseFromRecord(r: PoseRecord, out: Pose = makePose()): Pose {
  if (r.rot.length !== BONES.length) throw new Error(`save record: a pose has ${r.rot.length} bone rotations, not ${BONES.length}`);
  readV3(r.root, out.root, 'pose.root');
  BONES.forEach((b, i) => {
    const q = r.rot[i];
    out.rot[b].set(numFromRecord(q.x, `pose.${b}.x`), numFromRecord(q.y, `pose.${b}.y`), numFromRecord(q.z, `pose.${b}.z`), numFromRecord(q.w, `pose.${b}.w`));
  });
  readV3(r.blade, out.blade, 'pose.blade');
  out.slide = numFromRecord(r.slide, 'pose.slide');
  return out;
}

export function trackKeyToRecord(k: TrackKey): TrackKeyRecord {
  return { f: k.f, pose: poseToRecord(k.pose), ease: k.ease ?? null };
}

/** A track key with a fresh pose; a null `ease` stays absent, as the key it was made from. */
export function trackKeyFromRecord(r: TrackKeyRecord): TrackKey {
  const k: TrackKey = { f: numFromRecord(r.f, 'key.f'), pose: poseFromRecord(r.pose) };
  if (r.ease !== null) k.ease = enumFromRecord(r.ease, EASES, 'key.ease');
  return k;
}
