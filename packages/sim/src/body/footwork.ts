import { Vector3 } from 'three';
import { MOVE_TUNING } from '../sim/rules';
import { getTuningValue } from '../tuning/registry';
import type { GroundQuery, V3 } from '../world/types';
import { boolFromRecord, enumFromRecord, numFromRecord, readV3, v3Record } from './animator';
import { ANKLE_HEIGHT, bonePoint, type Rig, SKELETON, type Side, STAND_HEIGHT } from './skeleton';

export interface FootworkStyle {
  /** Scales the stance (distance between the feet). */
  stanceWidth: number;
  /** Frames per step at a standstill; steps get quicker at speed. */
  stepFrames: number;
  /** Peak foot lift (m). Boxers glide low. */
  stepHeight: number;
  /**
   * A limp (a severe leg wound, docs/M1-DESIGN.md §6.4), `amount` 0..1: the bad leg bears the weight for less time
   * (the good leg swings through quicker: its swing, the bad leg's time alone on the ground, × (1 −
   * MOVE_TUNING.limpStanceMul × amount)) and is dragged low (its step height × MOVE_TUNING.limpStepHeightMul at a
   * full limp, eased in with the amount).
   */
  limp?: { side: Side; amount: number };
}

export interface Foot {
  side: Side;
  /** Planted ankle position on the ground (world; y is the ground's height there, 0 on a flat floor). */
  readonly pos: Vector3;
  readonly from: Vector3;
  readonly to: Vector3;
  stepping: boolean;
  /** Step progress 0..1. */
  t: number;
  dur: number;
  height: number;
  /** Walking/running: seconds of travel the landing spot leads the stance home. */
  lead: number;
  /** A walking/running gait step (timed by the cadence, not by how far off it is). */
  gait: boolean;
}

interface Body {
  pos: Vector3;
  yaw: number;
  walkVel: Vector3;
  /** Body scale: local (authored) space × scale = world metres. */
  scale?: number;
  /** The ground the feet plant on (terrain, or what rests on it); absent or null: a flat floor at y = 0. */
  ground?: GroundQuery | null;
}

/** Height of the ground a foot plants on at (x, z): what supports it below the body, else the terrain, else 0. */
function groundY(body: Body, x: number, z: number): number {
  return body.ground?.supportAt?.(x, z, body.pos.y) ?? body.ground?.heightAt(x, z) ?? 0;
}

/** Puts a foot target on the ground under it (only on uneven ground: a flat floor already has y = 0). */
function plant(v: Vector3, body: Body): Vector3 {
  if (body.ground) v.y = groundY(body, v.x, v.z);
  return v;
}

/** Fighter-local stance home for each ankle (orthodox: left foot leads). */
const BASE_HOME: Record<Side, [number, number]> = { L: [0.13, 0.27], R: [-0.15, -0.24] };
/** Normal walking: feet side by side under the hips. */
const WALK_HOME: Record<Side, [number, number]> = { L: [0.1, 0.01], R: [-0.1, -0.01] };

const MOVING_THRESHOLD = 0.045;
const IDLE_THRESHOLD = 0.07;
/** Beyond this the foot steps regardless of footwork order (e.g. after being shoved). */
const FORCE_THRESHOLD = 0.45;
/** Beyond this the foot just snaps (teleports, respawns). */
const SNAP_THRESHOLD = 0.9;
/** Seconds the stance home leads the body while moving. */
const STEP_LEAD = 0.05;

const _home = new Vector3();
const _v = new Vector3();
const _hip = new Vector3();
/** A ground offset under a foot smaller than this (m, fighter-local) is level ground: f32 heights, no lowering. */
const LEVEL_EPS = 1e-6;

/**
 * A CHARACTER_TUNING value (world/characters.ts), read through the registry by name when a foot is below the body's
 * ground (a world's slope): the body module imports no world module.
 */
function hipTuning(key: 'maxHipDropM' | 'hipDropSpeedMps'): number {
  const v = getTuningValue('CHARACTER_TUNING', key);
  if (typeof v !== 'number') throw new Error(`CHARACTER_TUNING.${key} is not a number`);
  return v;
}

function makeFoot(side: Side): Foot {
  return { side, pos: new Vector3(), from: new Vector3(), to: new Vector3(), stepping: false, t: 0, dur: 1, height: 0, lead: 0, gait: false };
}

/** World point → fighter-local (authored, unscaled) coordinates; y is measured from the body's feet (pos.y). */
export function toLocal(world: Vector3, body: Body, out: Vector3): Vector3 {
  const k = 1 / (body.scale ?? 1);
  const dx = world.x - body.pos.x;
  const dz = world.z - body.pos.z;
  const c = Math.cos(body.yaw);
  const s = Math.sin(body.yaw);
  // Inverse of the yaw rotation used by forwardKinematics.
  return out.set((dx * c - dz * s) * k, (world.y - body.pos.y) * k, (dx * s + dz * c) * k);
}

/** Fighter-local (authored) ground point → world, on the ground there. */
export function toWorld(lx: number, lz: number, body: Body, out: Vector3): Vector3 {
  const k = body.scale ?? 1;
  const c = Math.cos(body.yaw);
  const s = Math.sin(body.yaw);
  const x = body.pos.x + (lx * c + lz * s) * k;
  const z = body.pos.z + (-lx * s + lz * c) * k;
  return out.set(x, groundY(body, x, z), z);
}

/**
 * Procedural boxing footwork. Feet stay planted in the world and take discrete steps
 * toward stance "homes" that travel with the body:
 * - moving forward the lead foot steps first, backward the rear foot, sideways the foot
 *   on that side — the other foot follows (step-and-drag), so the feet never cross;
 * - turning on the spot becomes pivot steps;
 * - the hips shift over the planted foot during each step (weight transfer).
 */
export class Footwork {
  readonly L = makeFoot('L');
  readonly R = makeFoot('R');
  /** Total steps taken (useful for tests / debugging). */
  steps = 0;
  /** Feet that touched down since the game last read this (footstep sounds). */
  readonly landed: Side[] = [];
  firstStepper: Side | null = null;
  private lastStepper: Side | null = null;
  /** Live multipliers from the contextual motion profile. */
  readonly mods = { stance: 1, stepFrames: 1, stepHeight: 1, stride: 1, gait: 0 };
  /** Smoothed hip offset toward the supporting foot (fighter-local x/z). */
  private readonly shift = { x: 0, z: 0, primed: false };
  private readonly shiftTarget = { x: 0, z: 0 };
  /** 0 = walking, 1 = full run (only meaningful while the walking gait is on). */
  run = 0;
  /** Walking/running cycle phase (0..1): the left foot lifts at 0, the right at 0.5. */
  private phase = 0;
  private wasGait = false;
  private initialized = false;
  /** Last frame's gait swing length / landing lead (a step in flight adapts to them). */
  private gaitDur = 30;
  private gaitLead = 0;
  /**
   * m, fighter-local (unscaled): how far the hips are lowered for a downhill foot (updateHipDrop; core-fix). 0 on level
   * ground, and always outside a world. Saved.
   */
  hipDrop = 0;

  constructor(public style: FootworkStyle) {}

  foot(side: Side) {
    return side === 'L' ? this.L : this.R;
  }

  /** Home position (fighter-local x/z) for a foot given an extra stance offset. */
  homeLocal(side: Side, offX: number, offZ: number): [number, number] {
    const w = this.style.stanceWidth * this.mods.stance;
    const g = this.mods.gait;
    const [bx, bz] = BASE_HOME[side];
    const [wx, wz] = WALK_HOME[side];
    return [(bx * w) * (1 - g) + wx * g + offX, (bz * w) * (1 - g) + wz * g + offZ];
  }

  /** Plant both feet where the current pose has them (after authored-leg animations), on `body`'s ground. */
  syncToRig(rig: Rig, body?: Body) {
    for (const f of [this.L, this.R]) {
      const shin = f.side === 'L' ? 'shinL' : 'shinR';
      bonePoint(rig, shin, SKELETON[shin].length, _v);
      f.pos.set(_v.x, body ? groundY(body, _v.x, _v.z) : 0, _v.z);
      f.stepping = false;
    }
    this.initialized = true;
  }

  /**
   * Advance one frame. `offX/offZ` shift the stance (idle repositioning, step feints).
   * `lx/lz` is the local direction of travel, `speedFrac` 0..1 of walk speed.
   */
  update(body: Body, offX: number, offZ: number, lx: number, lz: number, speedFrac: number) {
    if (!this.initialized) {
      for (const f of [this.L, this.R]) {
        const [hx, hz] = this.homeLocal(f.side, offX, offZ);
        toWorld(hx, hz, body, f.pos);
      }
      this.initialized = true;
    }

    // Ease the hips toward the supporting foot (weight moves, it doesn't teleport).
    this.shift.x += (this.shiftTarget.x - this.shift.x) * 0.3;
    this.shift.z += (this.shiftTarget.z - this.shift.z) * 0.3;
    const moving = speedFrac > 0.08;
    const sc = body.scale ?? 1;
    const speed = Math.hypot(body.walkVel.x, body.walkVel.z) / sc;
    const dur = Math.max(5, Math.round(this.style.stepFrames * this.mods.stepFrames - 3.5 * speedFrac));
    const errors = { L: 0, R: 0 };
    const homes = { L: new Vector3(), R: new Vector3() };
    for (const f of [this.L, this.R]) {
      const [hx, hz] = this.homeLocal(f.side, offX, offZ);
      toWorld(hx, hz, body, _home);
      // Homes lead the body a little when moving, so feet land ahead and stay planted.
      plant(_home.addScaledVector(body.walkVel, STEP_LEAD), body);
      homes[f.side].copy(_home);
      errors[f.side] = Math.hypot(_home.x - f.pos.x, _home.z - f.pos.z);
      errors[f.side] /= sc;
      // A foot already on its way only snaps after a real teleport (respawn, shove).
      if (errors[f.side] > (f.stepping ? SNAP_THRESHOLD * 2.2 : SNAP_THRESHOLD * (this.mods.gait > 0.5 ? 1.5 : 1))) {
        f.pos.copy(_home);
        f.stepping = false;
        errors[f.side] = 0;
      }
    }

    // A planted foot stays on whatever is under it now: ground a world set after the feet were placed, a log that
    // rolled away, a dug hole (a flat floor: nothing to do, as in DungeonStyle).
    for (const f of [this.L, this.R]) if (!f.stepping) plant(f.pos, body);

    // Progress active steps, re-aiming at the moving home (the body keeps turning/moving).
    for (const f of [this.L, this.R]) {
      if (!f.stepping) continue;
      // Speeding up from a standstill: a stride lifted at walking pace quickens with the
      // cadence instead of aiming ever further ahead at the new speed (a lurch).
      if (f.gait && this.wasGait) {
        f.dur = Math.max(4, Math.min(f.dur, this.gaitDur));
        f.lead = Math.min(f.lead, this.gaitLead);
      }
      f.t = Math.min(1, f.t + 1 / f.dur);
      f.to.copy(homes[f.side]).addScaledVector(body.walkVel, ((1 - f.t) * f.dur) / 60 + f.lead);
      // Never further from the stance home than a leg can reach.
      const hx = f.to.x - homes[f.side].x;
      const hz = f.to.z - homes[f.side].z;
      const hl = Math.hypot(hx, hz);
      const maxReach = 0.62 * (body.scale ?? 1);
      if (hl > maxReach) {
        f.to.x = homes[f.side].x + (hx / hl) * maxReach;
        f.to.z = homes[f.side].z + (hz / hl) * maxReach;
      }
      plant(f.to, body);
      const u = f.t * f.t * (3 - 2 * f.t);
      f.pos.lerpVectors(f.from, f.to, u);
      // The swinging foot goes round the planted one, not through it (turning, stepping
      // across, reversing).
      const other = this.foot(f.side === 'L' ? 'R' : 'L');
      if (!other.stepping && f.t < 1) {
        const gap = 0.2 * (body.scale ?? 1);
        let ox = f.pos.x - other.pos.x;
        let oz = f.pos.z - other.pos.z;
        let ol = Math.hypot(ox, oz);
        if (ol < gap) {
          if (ol < 1e-4) {
            // Dead on top: go round on the foot's own side.
            const c = Math.cos(body.yaw);
            const sn = Math.sin(body.yaw);
            const side = f.side === 'L' ? 1 : -1;
            ox = c * side;
            oz = -sn * side;
            ol = 1;
          }
          f.pos.x = other.pos.x + (ox / ol) * gap;
          f.pos.z = other.pos.z + (oz / ol) * gap;
        }
      }
      if (f.t >= 1) {
        f.stepping = false;
        f.pos.copy(f.to);
        errors[f.side] = 0;
        if (this.landed.length < 4) this.landed.push(f.side);
      }
    }

    const walking = this.mods.gait > 0.5;
    const gaitOn = walking && moving;
    // Walking / running: stride length and cadence follow speed like a person's do —
    // longer steps and a quicker rhythm, and at a run the swing outlasts the stance so
    // both feet leave the ground (flight phase).
    const run = gaitOn ? Math.min(1, Math.max(0, (speed - 2.2) / 1.4)) : 0;
    this.run += (run - this.run) * 0.15;
    const stepLen = 0.35 + 0.17 * speed;
    const period = Math.max(0.3, (2 * stepLen) / Math.max(0.6, speed));
    // Each foot is planted for at most ~0.6 m of travel (what the leg can reach).
    const stanceSec = Math.min(period * (0.58 - 0.22 * run), 0.62 / Math.max(0.6, speed));
    const swingSec = period - stanceSec;
    const walkDur = Math.max(6, Math.round(swingSec * 60));
    const walkLead = Math.max(0, stanceSec / 2 - STEP_LEAD);
    this.gaitDur = walkDur;
    this.gaitLead = walkLead;
    // Crossing guard: if the feet are lining up (fast turns), force a corrective step.
    const lL = toLocal(this.L.pos, body, new Vector3());
    const lR = toLocal(this.R.pos, body, new Vector3());
    let crossed: Side | null = null;
    if (lL.x - lR.x < (walking ? 0.06 : 0.12)) {
      const worse: Side = errors.L >= errors.R ? 'L' : 'R';
      errors[worse] = Math.max(errors[worse], FORCE_THRESHOLD + 0.01);
      crossed = worse;
    }

    // Who should step first?
    let leader: Side;
    if (speed > 0.05) {
      // Step-and-drag: the foot on the side of travel goes first.
      leader = Math.abs(lz) >= Math.abs(lx) ? (lz >= 0 ? 'L' : 'R') : lx >= 0 ? 'L' : 'R';
    } else {
      // Turning on the spot: pivot on the lead foot, swing the rear foot.
      leader = errors.R > IDLE_THRESHOLD || errors.L <= IDLE_THRESHOLD ? 'R' : 'L';
    }
    const follower: Side = leader === 'L' ? 'R' : 'L';
    // Stride grows with speed: longer planted phases instead of frantic stepping.
    // Retreating: shorter, gliding steps (never reach back with a long stride).
    const retreat = moving && lz < -0.4 && !walking;
    const stride = this.mods.stride * (retreat ? 0.75 : 1);
    const thr = ((moving ? MOVING_THRESHOLD : IDLE_THRESHOLD) + speed * 0.06) * stride;

    if (gaitOn) {
      this.updateGait(body, homes, errors, walkDur, walkLead, run, period, stanceSec, crossed);
      this.wasGait = true;
      return;
    }
    this.wasGait = false;

    const tryStep = (side: Side) => {
      const f = this.foot(side);
      const other = this.foot(side === 'L' ? 'R' : 'L');
      if (f.stepping) return false;
      const forced = errors[side] > FORCE_THRESHOLD;
      if (errors[side] <= thr) return false;
      if (other.stepping && other.t < (walking ? 0.85 : 0.75) && !forced) return false;
      f.from.copy(f.pos);
      f.t = 0;
      f.lead = 0;
      f.gait = false;
      f.dur = forced ? Math.max(4, dur - 2) : dur;
      f.height = this.style.stepHeight * this.mods.stepHeight * (retreat ? 0.6 : 1) * (0.6 + 0.6 * speedFrac) * Math.min(1, errors[side] / (0.15 * stride));
      this.applyLimp(f);
      // Aim where the home will be when the foot lands.
      plant(f.to.copy(homes[side]).addScaledVector(body.walkVel, f.dur / 60), body);
      f.stepping = true;
      if (this.steps === 0) this.firstStepper = side;
      this.steps++;
      this.lastStepper = side;
      return true;
    };

    // Moving: if the trailing foot wants to go but the leading foot hasn't moved yet,
    // the leading foot takes a (small) step first — never lead with the wrong foot.
    if (!walking && moving && this.lastStepper !== leader && errors[follower] > thr && errors[leader] > 0.02 && errors[leader] <= thr) {
      errors[leader] = thr + 0.001;
    }
    if (!tryStep(leader)) {
      // The follower drags in after the leader has moved (once it has mostly landed),
      // or on its own only if it is badly out of place.
      const lead = this.foot(leader);
      const due = this.lastStepper === leader && (!lead.stepping || lead.t > 0.75);
      if (due || errors[follower] > Math.max(thr * 1.8, 0.12) || errors[follower] > FORCE_THRESHOLD) tryStep(follower);
    }
  }

  /**
   * Walking and running run on a clock rather than on error thresholds, so the rhythm is
   * steady: each foot lifts once per cycle, half a cycle apart, swings for `dur` frames
   * and lands `lead` seconds of travel ahead of its home — under the hips mid-stance.
   */
  private updateGait(body: Body, homes: Record<Side, Vector3>, errors: Record<Side, number>, dur: number, lead: number, run: number, period: number, stanceSec: number, crossedLegs: Side | null = null) {
    const sc = body.scale ?? 1;
    const speed = Math.hypot(body.walkVel.x, body.walkVel.z) / sc;
    if (!this.wasGait) {
      // Starting off: the foot furthest from its home goes first, right away.
      const first: Side = errors.L >= errors.R ? 'L' : 'R';
      this.phase = first === 'L' ? 0.999 : 0.499;
    }
    const prev = this.phase;
    this.phase = (this.phase + 1 / (period * 60)) % 1;
    const crossed = (at: number) => (at === 0 ? this.phase < prev : prev < at && this.phase >= at);
    const lift = (side: Side) => {
      const f = this.foot(side);
      if (f.stepping) return;
      f.from.copy(f.pos);
      f.t = 0;
      f.dur = dur;
      f.lead = lead;
      f.gait = true;
      f.height = (0.045 + 0.02 * speed + 0.07 * run) * Math.min(1.4, this.mods.stepHeight);
      this.applyLimp(f);
      plant(f.to.copy(homes[side]).addScaledVector(body.walkVel, f.dur / 60 + lead), body);
      f.stepping = true;
      if (this.steps === 0) this.firstStepper = side;
      this.steps++;
      this.lastStepper = side;
    };
    if (crossed(0)) lift('L');
    if (crossed(0.5)) lift('R');
    // Speeding up, turning or shoved: a planted foot that has fallen too far behind (or
    // out to the side) goes now, and the rhythm re-syncs to it.
    const vx = body.walkVel.x / (speed * sc || 1);
    const vz = body.walkVel.z / (speed * sc || 1);
    const limit = (speed * (stanceSec / 2 + STEP_LEAD)) * 1.12 + 0.03;
    for (const side of ['L', 'R'] as const) {
      const f = this.foot(side);
      const other = this.foot(side === 'L' ? 'R' : 'L');
      if (f.stepping || (other.stepping && other.t < 0.45 && errors[side] < 0.55)) continue;
      const dx = (f.pos.x - homes[side].x) / sc;
      const dz = (f.pos.z - homes[side].z) / sc;
      const behind = -(dx * vx + dz * vz);
      const aside = Math.abs(dx * vz - dz * vx);
      // Turning over planted feet has crossed the legs: step out of it now.
      const wayOff = errors[side] > FORCE_THRESHOLD + 0.3 || side === crossedLegs;
      if (side === this.lastStepper && !wayOff) continue;
      if (behind > limit || aside > 0.3 || wayOff) {
        lift(side);
        this.phase = side === 'L' ? 0 : 0.5;
      }
    }
  }

  /**
   * A limp shapes a step as it starts: the bad leg is dragged low, the good one swings through quicker so the body
   * spends less time on the bad one (FootworkStyle.limp).
   */
  private applyLimp(f: Foot) {
    const limp = this.style.limp;
    if (!limp || !(limp.amount > 0)) return;
    const a = Math.min(1, limp.amount);
    if (f.side === limp.side) f.height *= 1 - (1 - MOVE_TUNING.limpStepHeightMul) * a;
    else f.dur = Math.max(MOVE_TUNING.limpMinStepFrames, Math.round(f.dur * (1 - MOVE_TUNING.limpStanceMul * a)));
  }

  /** Are the feet on the wrong sides of each other (relative to where the body faces)? */
  legsCrossed(body: Body): boolean {
    const l = toLocal(this.L.pos, body, _v).x;
    const r = toLocal(this.R.pos, body, _v).x;
    return l - r < 0.04;
  }

  /**
   * Ankle IK target in fighter-local space, including step lift and an extra raise (toes), and the height of the
   * ground under the foot above the body's own feet (0 on a flat floor). On a slope a foot planted further downhill than
   * the leg reaches from the hips is reached by lowering the hips (hipDrop; core-fix): walking a 0.3 grade an ankle
   * missed its planted height by up to 0.108 m with the hips at the body's own ground height.
   */
  localTarget(side: Side, body: Body, raise: number): [number, number, number] {
    const f = this.foot(side);
    toLocal(f.pos, body, _v);
    const lift = f.stepping ? Math.sin(Math.PI * f.t) * f.height : 0;
    return [_v.x, ANKLE_HEIGHT + lift + raise + _v.y, _v.z];
  }

  /**
   * The hips' drop one tick on (world ground; core-fix: rule 3, a planted foot neither floats nor sinks on a slope):
   * toward hipDropTarget at no more than CHARACTER_TUNING.hipDropSpeedMps (× scale), so the hips never jump (the zones
   * ride on them). The poses lower their root by `hipDrop` (sim/fighter.ts). Read once a tick, after `update`.
   */
  updateHipDrop(body: Body): void {
    const target = this.hipDropTarget(body);
    if (target === 0 && this.hipDrop === 0) return;
    const step = (hipTuning('hipDropSpeedMps') * (1 / 60)) / (body.scale ?? 1);
    this.hipDrop = target > this.hipDrop ? Math.min(target, this.hipDrop + step) : Math.max(target, this.hipDrop - step);
  }

  /**
   * How far (fighter-local, unscaled) a standing body's hips (DS's stance: the root STAND_HEIGHT up, square) must go
   * down so that each foot the ground puts below the body's own feet reaches its planted ankle target: per downhill foot,
   * the drop that brings it within the leg's reach from its hip, less the drop the same foot would need on level ground
   * (the stance's and the stepping arc's own, which DungeonStyle's poses keep), so on level ground it is exactly 0. The
   * deeper foot's wins (the uphill leg just bends more), at most CHARACTER_TUNING.maxHipDropM. A foot whose ground is
   * further below the body's than that is no slope (a foot planted in a hole for a tick, the pit under a cover a
   * teleport stood the body on): it is left to the leg's reach, never chased with the whole body.
   */
  private hipDropTarget(body: Body): number {
    let drop = 0;
    let max = -1;
    for (const side of ['L', 'R'] as const) {
      const g = toLocal(this.foot(side).pos, body, _v).y;
      if (!(g < -LEVEL_EPS)) continue;
      if (max < 0) max = hipTuning('maxHipDropM');
      if (g < -max) continue;
      const [tx, ty, tz] = this.localTarget(side, body, 0);
      const thigh = SKELETON[side === 'L' ? 'thighL' : 'thighR'];
      const shin = SKELETON[side === 'L' ? 'shinL' : 'shinR'];
      _hip.set(thigh.offset[0], STAND_HEIGHT + thigh.offset[1], thigh.offset[2]);
      // Just inside the IK's full stretch (skeleton.ts solveTwoBone: a + b − 0.001).
      const reach = thigh.length + shin.length - 0.002;
      const horiz = Math.hypot(tx - _hip.x, tz - _hip.z);
      const need = (y: number): number => {
        const below = _hip.y - y;
        return horiz >= reach ? Math.max(0, below) : Math.max(0, below - Math.sqrt(reach * reach - horiz * horiz));
      };
      drop = Math.max(drop, need(ty) - need(ty - g));
    }
    return drop > 0 ? Math.min(drop, max) : 0;
  }

  /**
   * Fighter-local offset of the hips implied by where the weight is: centred between the
   * feet, leaning over the planted foot while the other one is in the air.
   */
  weightShift(body: Body, offX: number, offZ: number): [number, number] {
    const l = toLocal(this.L.pos, body, new Vector3());
    const r = toLocal(this.R.pos, body, new Vector3());
    // Hips lean toward whichever foot is carrying the weight: a foot in mid-swing carries
    // none. Weighting by groundedness stays smooth even when both feet are briefly up.
    const support = (f: Foot) => (f.stepping ? 1.02 - Math.sin(Math.PI * f.t) : 1.02);
    const wl = support(this.L);
    const wr = support(this.R);
    const mx = (l.x + r.x) / 2;
    const mz = (l.z + r.z) / 2;
    const k = 0.45;
    const tx = ((l.x * wl + r.x * wr) / (wl + wr) - mx) * k;
    // Walking/running carries the hips forward at a steady pace instead of rocking.
    const tz = ((l.z * wl + r.z * wr) / (wl + wr) - mz) * k * (1 - 0.85 * this.mods.gait);
    if (!this.shift.primed) Object.assign(this.shift, { x: tx, z: tz, primed: true });
    const cx = mx + this.shift.x;
    const cz = mz + this.shift.z;
    this.shiftTarget.x = tx;
    this.shiftTarget.z = tz;
    const [hlx, hlz] = this.homeLocal('L', offX, offZ);
    const [hrx, hrz] = this.homeLocal('R', offX, offZ);
    // The hips stay over the feet, but never get thrown far off the body's own centre.
    const lim = 0.2;
    return [Math.max(-lim, Math.min(lim, cx - (hlx + hrx) / 2)) + offX, Math.max(-lim, Math.min(lim, cz - (hlz + hrz) / 2)) + offZ];
  }

  // ---------------------------------------------------------------------------
  // Save record (docs/M1-DESIGN.md §8.3, P04; MAP gap-7 §3.5)
  // ---------------------------------------------------------------------------

  /**
   * The feet and the stepping rhythm (MAP gap-7 §3.5's Save list), plus the limp (`style.limp`: wound state the world
   * sets at run time, unlike the rest of the style, which the fighter's maker gives it). Not saved: `mods` (copied
   * from the fighter's motion profile by every updatePose before anything reads them) and `landed` (output the client
   * drains; it never changes an outcome).
   */
  toRecord(): FootworkRecord {
    const limp = this.style.limp;
    return {
      L: footToRecord(this.L),
      R: footToRecord(this.R),
      steps: this.steps,
      firstStepper: this.firstStepper,
      lastStepper: this.lastStepper,
      shift: { x: this.shift.x, z: this.shift.z, primed: this.shift.primed },
      shiftTarget: { x: this.shiftTarget.x, z: this.shiftTarget.z },
      run: this.run,
      phase: this.phase,
      wasGait: this.wasGait,
      initialized: this.initialized,
      gaitDur: this.gaitDur,
      gaitLead: this.gaitLead,
      limp: limp ? { side: limp.side, amount: limp.amount } : null,
      hipDrop: this.hipDrop,
    };
  }

  /** Puts back a toRecord() state into these feet (their vectors keep their identity). */
  restoreRecord(r: FootworkRecord) {
    footFromRecord(r.L, this.L, 'footwork.L');
    footFromRecord(r.R, this.R, 'footwork.R');
    this.steps = numFromRecord(r.steps, 'footwork.steps');
    this.firstStepper = r.firstStepper === null ? null : enumFromRecord(r.firstStepper, SIDES, 'footwork.firstStepper');
    this.lastStepper = r.lastStepper === null ? null : enumFromRecord(r.lastStepper, SIDES, 'footwork.lastStepper');
    this.shift.x = numFromRecord(r.shift.x, 'footwork.shift.x');
    this.shift.z = numFromRecord(r.shift.z, 'footwork.shift.z');
    this.shift.primed = boolFromRecord(r.shift.primed, 'footwork.shift.primed');
    this.shiftTarget.x = numFromRecord(r.shiftTarget.x, 'footwork.shiftTarget.x');
    this.shiftTarget.z = numFromRecord(r.shiftTarget.z, 'footwork.shiftTarget.z');
    this.run = numFromRecord(r.run, 'footwork.run');
    this.phase = numFromRecord(r.phase, 'footwork.phase');
    this.wasGait = boolFromRecord(r.wasGait, 'footwork.wasGait');
    this.initialized = boolFromRecord(r.initialized, 'footwork.initialized');
    this.gaitDur = numFromRecord(r.gaitDur, 'footwork.gaitDur');
    this.gaitLead = numFromRecord(r.gaitLead, 'footwork.gaitLead');
    if (r.limp) this.style.limp = { side: enumFromRecord(r.limp.side, SIDES, 'footwork.limp.side'), amount: numFromRecord(r.limp.amount, 'footwork.limp.amount') };
    else delete this.style.limp;
    this.hipDrop = numFromRecord(r.hipDrop, 'footwork.hipDrop');
  }
}

/** One foot's saved state (its `side` is which foot it is). */
export type FootRecord = {
  pos: V3;
  from: V3;
  to: V3;
  stepping: boolean;
  t: number;
  dur: number;
  height: number;
  lead: number;
  gait: boolean;
};

/** Footwork's saved state (Footwork.toRecord). */
export type FootworkRecord = {
  L: FootRecord;
  R: FootRecord;
  steps: number;
  firstStepper: Side | null;
  lastStepper: Side | null;
  shift: { x: number; z: number; primed: boolean };
  shiftTarget: { x: number; z: number };
  run: number;
  phase: number;
  wasGait: boolean;
  initialized: boolean;
  gaitDur: number;
  gaitLead: number;
  limp: { side: Side; amount: number } | null;
  /** The hips' drop for a downhill foot (core-fix). */
  hipDrop: number;
};

function footToRecord(f: Foot): FootRecord {
  return { pos: v3Record(f.pos), from: v3Record(f.from), to: v3Record(f.to), stepping: f.stepping, t: f.t, dur: f.dur, height: f.height, lead: f.lead, gait: f.gait };
}

function footFromRecord(r: FootRecord, f: Foot, field: string) {
  readV3(r.pos, f.pos, `${field}.pos`);
  readV3(r.from, f.from, `${field}.from`);
  readV3(r.to, f.to, `${field}.to`);
  f.stepping = boolFromRecord(r.stepping, `${field}.stepping`);
  f.t = numFromRecord(r.t, `${field}.t`);
  f.dur = numFromRecord(r.dur, `${field}.dur`);
  f.height = numFromRecord(r.height, `${field}.height`);
  f.lead = numFromRecord(r.lead, `${field}.lead`);
  f.gait = boolFromRecord(r.gait, `${field}.gait`);
}

const SIDES: Record<Side, true> = { L: true, R: true };
