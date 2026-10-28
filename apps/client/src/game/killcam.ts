// The kill cam (docs/M1-DESIGN.md §10.3, SPEC:583-588, rule 8): one function receives every moment. KillCam.onMoment is
// the only way a kill cam starts in the client: it picks the shot for the moment's kind (KILLCAM_TUNING) and hands it to
// the cut callback main.ts gives it (Cinematics.play, whose slow motion the game loop applies: time effects live in the
// loop, never in the sim). A moment that gets no cut (its kind's cooldown, a bigger cut running, or a bigger moment of
// the same tick replacing it at once) is still marked as a saved moment, so every trigger gives a kill cam or a mark
// (SPEC:933, RR-14). Multiplayer later turns onMoment's body into a replay request (SPEC:744): a shared world can't slow.
//
// The six moments (game/moments.ts builds them from the sim's events):
//   envKill        an environmental kill (the M1 gate, SPEC:869): DS's finishing shot, low and from the side
//   worldWound     the world wounds a ruler (a trap hit, SPEC:585): the wound, close and from below
//   rulerDeath     a ruler dies: its chest, wide and long
//   playerByRuler  a ruler flings or kills the player (rule 9, "worth clipping"): wide, following the flying body
//   playerDeath    the player's other deaths: DS's death cam, from above
//   skullSplit     a skull split, cleft or crushed: DS's skull cut, close and almost frozen
import { Quaternion, Vector3 } from 'three';
import { BONES, type BoneName, defineTuning, DT, type Fighter } from '@wild/sim';
import type { Shot } from '../render/cinematics';
import type { KillCamPort } from './ports';

export type MomentKind = 'envKill' | 'worldWound' | 'rulerDeath' | 'playerByRuler' | 'playerDeath' | 'skullSplit';

export interface Moment {
  kind: MomentKind;
  tick: number;
  /** The victim, the wounded ruler, or the flung player. */
  subject: Fighter;
  /** Impact point and direction (world). */
  point: Vector3;
  dir: Vector3;
  /** The log, stake, trunk… (the shot's side; the journal later). */
  causeEntity: number | null;
  /** 0..1 (the hit's HP fraction, or 1 for a death). */
  severity: number;
}

/**
 * The shot parameters every moment kind shares, named as §9.1 names them (`orbit` in rad: Cinematics turns the shot by
 * it per second, Shot.orbit).
 */
const shotFields = (what: string) => ({
  orbit: { unit: 'rad (per s of the shot)', source: `§9.1 KILLCAM_TUNING ${what}`, min: -1, max: 1, step: 0.01 },
  fov: { unit: '°', source: `§9.1 KILLCAM_TUNING ${what}`, min: 20, max: 90, step: 1 },
  durationS: { unit: 's (real)', source: `§9.1 KILLCAM_TUNING ${what}`, min: 0.2, max: 10, step: 0.1 },
  slow: { unit: '× time', source: `§9.1 KILLCAM_TUNING ${what}`, min: 0.02, max: 1, step: 0.01 },
  priority: { unit: '—', source: `§9.1 KILLCAM_TUNING ${what} (Cinematics' ladder: death 5, skull 4.5, finisher 4)`, min: 0, max: 10, step: 0.5 },
});

/** How far a shot's side leans over the shoulder of whoever is at the line's start (sideAcross's `toward`). */
const towardField = (source: string) => ({ unit: '× (over the cause\'s shoulder; negative: over the subject\'s)', source, min: -1, max: 1, step: 0.05 });

/**
 * §9.1's keys (dist, height, orbit, fov, durationS, slow, priority; worldWound's dolly), and these additions, so no shot
 * value is a bare constant (CLAUDE.md):
 * - envKill's `distScale`: its distance is a formula, 3.8 × max(1, 0.75·scale), which one number can't hold; its
 *   `toward` (0.1, §10.3's "across(cause point, victim, 0.1)").
 * - worldWound's and rulerDeath's dist and height are per unit of the subject's scale (§9.1: "3.3·scale", "4·scale").
 * - rulerDeath's `toward` (NEW: §10.3 gives no side; straight across the line from the cause).
 * - `playerDeath` and `skullSplit`: DS's death cam and skull cut (game.ts onKO and skullBlow), which §10.3 keeps as
 *   moments but §9.1 lists no row for. DEVIATION (P36): rows added here, source DS, rather than kept as code constants.
 * - `causeBackM` (NEW): a moment carries the impact point and direction, not the attacker; the shot's "cause point" is
 *   this far back along the blow from the impact point (DS used the attacker's position, about that far away).
 * - `focusFloor` (DS pelvisOf): a body the shot follows is framed no lower than the ground + this × its scale.
 */
export const KILLCAM_TUNING = defineTuning(
  'KILLCAM_TUNING',
  'Client › kill cam',
  {
    cooldownS: 4,
    causeBackM: 1,
    focusFloor: 0.35,
    envKill: { dist: 3.8, distScale: 0.75, height: 0.55, orbit: 0.3, fov: 38, durationS: 2.2, slow: 0.18, priority: 4, toward: 0.1 },
    worldWound: { dist: 3.3, height: -0.15, orbit: -0.12, dolly: -0.35, fov: 42, durationS: 2.4, slow: 0.25, priority: 4.5 },
    rulerDeath: { dist: 4, height: 0.3, orbit: 0.1, fov: 40, durationS: 4.0, slow: 0.2, priority: 6, toward: 0 },
    playerByRuler: { dist: 7, height: 2.5, orbit: 0.2, fov: 44, durationS: 2.6, slow: 0.3, priority: 5.5 },
    playerDeath: { dist: 3.0, height: 1.7, orbit: 0.16, dolly: -0.2, fov: 40, durationS: 3.2, slow: 0.22, priority: 5, toward: -0.2 },
    skullSplit: { dist: 1.9, distScale: 0.8, height: 0.25, orbit: 0.4, dolly: -0.2, fov: 36, durationS: 2.1, slow: 0.1, priority: 4.5, toward: 0.45 },
  },
  {
    cooldownS: { unit: 's of sim time per moment kind', source: 'NEW (§10.3: one cut per kind per 4 s)', min: 0, max: 30, step: 0.5, label: 'cooldown per kind' },
    causeBackM: { unit: 'm', source: 'NEW (P36): the cause point, back along the blow from the impact', min: 0.1, max: 5, step: 0.1 },
    focusFloor: { unit: 'm × scale over the ground', source: 'DS (game.ts pelvisOf: 0.35 × scale), §10.3', min: 0, max: 2, step: 0.05 },
    envKill: {
      dist: { unit: 'm (× max(1, distScale·scale))', source: 'DS (game.ts finishing shot)', min: 1, max: 20, step: 0.1 },
      distScale: { unit: '× scale', source: 'DS (game.ts finishing shot): the 0.75 of 3.8 × max(1, 0.75·scale)', min: 0, max: 2, step: 0.05 },
      height: { unit: 'm', source: 'DS (game.ts finishing shot)', min: -3, max: 10, step: 0.05 },
      ...shotFields('envKill (DS finishing shot)'),
      toward: towardField('DS (game.ts finishing shot), §10.3: across(cause point, victim, 0.1)'),
    },
    worldWound: {
      dist: { unit: 'm × scale', source: 'NEW (DS boss-intro framing, MAP client §3.3)', min: 0.5, max: 10, step: 0.1 },
      height: { unit: 'm × scale', source: 'NEW (DS boss-intro framing)', min: -2, max: 2, step: 0.05 },
      dolly: { unit: 'm/s', source: 'NEW (DS boss-intro framing)', min: -2, max: 2, step: 0.05 },
      ...shotFields('worldWound'),
    },
    rulerDeath: {
      dist: { unit: 'm × scale', source: 'NEW', min: 0.5, max: 10, step: 0.1 },
      height: { unit: 'm × scale', source: 'NEW', min: -2, max: 2, step: 0.05 },
      ...shotFields('rulerDeath'),
      toward: towardField('NEW (P36): §10.3 gives no side for this shot'),
    },
    playerByRuler: {
      dist: { unit: 'm', source: 'NEW (rule 9)', min: 1, max: 30, step: 0.1 },
      height: { unit: 'm', source: 'NEW (rule 9)', min: -3, max: 15, step: 0.1 },
      ...shotFields('playerByRuler'),
    },
    playerDeath: {
      dist: { unit: 'm', source: 'DS (game.ts onKO, the death cam)', min: 0.5, max: 20, step: 0.1 },
      height: { unit: 'm', source: 'DS (game.ts onKO, the death cam)', min: -3, max: 10, step: 0.05 },
      dolly: { unit: 'm/s', source: 'DS (game.ts onKO, the death cam)', min: -2, max: 2, step: 0.05 },
      ...shotFields('playerDeath (DS death cam; DEVIATION: no §9.1 row)'),
      toward: towardField('DS (game.ts onKO: across(by, f, −0.2))'),
    },
    skullSplit: {
      dist: { unit: 'm (× max(1, distScale·scale))', source: 'DS (game.ts skullBlow)', min: 0.5, max: 10, step: 0.1 },
      distScale: { unit: '× scale', source: 'DS (game.ts skullBlow): the 0.8 of 1.9 × max(1, 0.8·scale)', min: 0, max: 2, step: 0.05 },
      height: { unit: 'm', source: 'DS (game.ts skullBlow)', min: -3, max: 5, step: 0.05 },
      dolly: { unit: 'm/s', source: 'DS (game.ts skullBlow)', min: -2, max: 2, step: 0.05 },
      ...shotFields('skullSplit (DS skull cut; DEVIATION: no §9.1 row)'),
      toward: towardField('DS (game.ts skullBlow: across(by, f, 0.45))'),
    },
  },
);

/**
 * The ground direction for a cut that looks across the line a → b, on the side the gameplay camera at `cam` is already
 * on (so left and right stay where they were), pulled `toward` over a's shoulder (DS game.ts across).
 */
export function sideAcross(cam: Vector3, a: Vector3, b: Vector3, toward: number): Vector3 {
  const l = new Vector3(b.x - a.x, 0, b.z - a.z);
  if (l.lengthSq() < 1e-6) l.set(1, 0, 0);
  l.normalize();
  const side = new Vector3(l.z, 0, -l.x);
  if (side.x * (cam.x - (a.x + b.x) / 2) + side.z * (cam.z - (a.z + b.z) / 2) < 0) side.negate();
  return side.addScaledVector(l, -toward).normalize();
}

/** What a kill cam needs from the views: a body to follow, the ground, and where the frame is seen from. */
export interface KillCamViews {
  /** Follows the body as drawn (its ragdoll pelvis). */
  pelvisOf(f: Fighter): () => Vector3;
  ground(x: number, z: number): number;
  /**
   * Where the frame is seen from right now: the camera director's view (the follow or fight camera, or the cut that is
   * running), so a new cut keeps left and right where the player already sees them. Preferred over `across`.
   */
  viewPos?: () => Vector3;
  /**
   * @deprecated P31's wiring (main.ts passes sideAcross around the DS fight rig's camera, which the follow camera
   * doesn't move). Used only when `viewPos` is absent. TODO(C-fix): main.ts passes `viewPos: () => cams.camera.position`.
   */
  across?(a: Vector3, b: Vector3, toward?: number): Vector3;
}

const ORIGIN = new Vector3();

export class KillCam implements KillCamPort {
  /** Saved moments (the recorder's moment list; the M5 clip button, SPEC:933), oldest first. */
  readonly marks: Moment[] = [];
  /** Called on every mark (main.ts may hand it to the session recording). */
  onMark: ((m: Moment) => void) | null = null;
  /** The tick of each kind's last cut (its cooldown runs in sim time from there). */
  private readonly lastCut = new Map<MomentKind, number>();
  /** The moment whose cut is starting (a shot it replaces at once is marked: it was never seen). */
  private starting: Moment | null = null;

  constructor(
    private readonly cut: (s: Shot) => boolean,
    private readonly views: KillCamViews,
  ) {}

  /**
   * Every kill cam goes through here. True when the moment's cut is playing; false when it was suppressed (its kind
   * cut less than cooldownS of sim time ago, or a bigger cut is running), and then the moment is marked instead.
   */
  onMoment(m: Moment): boolean {
    if (this.coolingDown(m)) {
      this.mark(m);
      return false;
    }
    const shot = this.shotFor(m);
    const caller = shot.onEnd;
    shot.onEnd = () => {
      caller?.();
      this.ended(m);
    };
    this.starting = m;
    let played = false;
    try {
      played = this.cut(shot);
    } finally {
      this.starting = null;
    }
    if (played) this.lastCut.set(m.kind, m.tick);
    else this.mark(m);
    return played;
  }

  mark(m: Moment): void {
    this.marks.push(m);
    this.onMark?.(m);
  }

  /**
   * The cut for a moment (KILLCAM_TUNING): focus, side, framing, duration, slow motion and priority. Public so tests and
   * a future replay request (SPEC:744) read the same shot.
   */
  shotFor(m: Moment): Shot {
    const f = m.subject;
    const K = KILLCAM_TUNING;
    // Where the blow came from: back along its direction from the impact point.
    const from = m.point.clone().addScaledVector(m.dir, -K.causeBackM);
    const at = f.pos.clone();
    switch (m.kind) {
      case 'envKill': {
        // DS's finishing shot: low and from the side, following the victim down.
        const T = K.envKill;
        return {
          focus: this.floored(this.views.pelvisOf(f), f),
          side: this.side(from, at, T.toward),
          distance: T.dist * Math.max(1, T.distScale * f.scale),
          height: T.height,
          orbit: T.orbit,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
      case 'worldWound': {
        // The wound, seen from outside the body where it opened, a little from below (DS boss-intro framing).
        const T = K.worldWound;
        return {
          focus: onBody(f, m.point),
          side: outward(f, m.point) ?? this.side(from, at, 0),
          distance: T.dist * f.scale,
          height: T.height * f.scale,
          orbit: T.orbit,
          dolly: T.dolly,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
      case 'rulerDeath': {
        // Its chest, wide and long: the hunt's end.
        const T = K.rulerDeath;
        return {
          focus: this.floored(boneFocus(f, 'chest'), f),
          side: this.side(from, at, T.toward),
          distance: T.dist * f.scale,
          height: T.height * f.scale,
          orbit: T.orbit,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
      case 'playerByRuler': {
        // Wide, following the flying body, from the side of its flight (⟂ the launch): rule 9's clip.
        const T = K.playerByRuler;
        return {
          focus: this.floored(this.views.pelvisOf(f), f),
          side: this.side(at.clone().sub(flat(m.dir)), at, 0),
          distance: T.dist,
          height: T.height,
          orbit: T.orbit,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
      case 'playerDeath': {
        // DS's death cam: your fall, seen from above.
        const T = K.playerDeath;
        return {
          focus: this.floored(this.views.pelvisOf(f), f),
          side: this.side(from, at, T.toward),
          distance: T.dist,
          height: T.height,
          orbit: T.orbit,
          dolly: T.dolly,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
      case 'skullSplit': {
        // DS's skull cut: close and almost frozen, over the shoulder of whoever did it.
        const T = K.skullSplit;
        const point = m.point.clone();
        return {
          focus: () => point,
          side: this.side(from, at, T.toward),
          distance: T.dist * Math.max(1, T.distScale * f.scale),
          height: T.height,
          orbit: T.orbit,
          dolly: T.dolly,
          fov: T.fov,
          duration: T.durationS,
          slow: T.slow,
          priority: T.priority,
        };
      }
    }
  }

  /** The moment's kind cut less than cooldownS of sim time ago (a tick that went backwards, a load, resets it). */
  private coolingDown(m: Moment): boolean {
    const last = this.lastCut.get(m.kind);
    if (last === undefined || m.tick < last) return false;
    return (m.tick - last) * DT < KILLCAM_TUNING.cooldownS;
  }

  /**
   * A shot of `m` ended. When a moment of the same tick replaced it as it started (Cinematics.play ends the shot it
   * replaces), it was never seen: it's marked, and its kind's cooldown doesn't count it.
   */
  private ended(m: Moment): void {
    const s = this.starting;
    if (!s || s === m || s.tick !== m.tick) return;
    if (this.lastCut.get(m.kind) === m.tick) this.lastCut.delete(m.kind);
    this.mark(m);
  }

  /** The side across the line a → b, on the side the frame is seen from now (the deprecated `across` without viewPos). */
  private side(a: Vector3, b: Vector3, toward: number): Vector3 {
    if (this.views.viewPos) return sideAcross(this.views.viewPos(), a, b, toward);
    if (this.views.across) return this.views.across(a, b, toward);
    return sideAcross(ORIGIN, a, b, toward);
  }

  /** A focus no lower than the ground + focusFloor × scale (§10.3: "floored at ground + 0.35·scale"). */
  private floored(focus: () => Vector3, f: Fighter): () => Vector3 {
    return () => {
      const p = focus();
      p.y = Math.max(p.y, this.views.ground(p.x, p.z) + KILLCAM_TUNING.focusFloor * f.scale);
      return p;
    };
  }
}

/** The horizontal part of `v` (zero when it has none). */
function flat(v: Vector3): Vector3 {
  return new Vector3(v.x, 0, v.z);
}

/** A bone's joint as the sim poses it, followed (a new vector each read). */
function boneFocus(f: Fighter, bone: BoneName): () => Vector3 {
  return () => f.rig[bone].pos.clone();
}

/**
 * `point` held on the body: on the bone whose joint is nearest it, in that bone's frame, so the focus moves with the
 * body (a tripped giant falling) the way the sim poses it.
 */
function onBody(f: Fighter, point: Vector3): () => Vector3 {
  let best: BoneName = BONES[0];
  let bestD = Infinity;
  for (const b of BONES) {
    const d = f.rig[b].pos.distanceToSquared(point);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  const x = f.rig[best];
  const local = point.clone().sub(x.pos).applyQuaternion(new Quaternion().copy(x.rot).invert());
  return () => local.clone().applyQuaternion(x.rot).add(x.pos);
}

/** The ground direction out of the body through `point` (from the pelvis), or null when the point is right over it. */
function outward(f: Fighter, point: Vector3): Vector3 | null {
  const c = f.rig.pelvis.pos;
  const d = new Vector3(point.x - c.x, 0, point.z - c.z);
  if (d.lengthSq() < 1e-6) return null;
  return d.normalize();
}
