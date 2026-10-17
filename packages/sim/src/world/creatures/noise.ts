// The noise bus (docs/M1-DESIGN.md §6.2, §3 phase 17b): collect turns the tick's combat and world events, and every
// moving fighter's footsteps, into noises; fold adds them to every mind's awareness and calls onHurt/onWound; the bus is
// empty at the end of the tick (so a save never holds pending noise).
//
// - Noises, hurts and wounds are queued in event order (CombatSim's events, then the world's, then footsteps) and folded
//   in that order; each noise reaches every creature with a mind, in fighter order, through Senses.hear. A mind may
//   emit while it is folded (a shout from onHurt): the noise is folded in the same pass.
// - Every noise also goes to the client as a `noise` world event (a presentation hint: audio voices the roars and
//   shouts, the dev view draws hearing rings). Hints for noises made from events are pushed in phase 17b, after the
//   events they come from; a mind's own emit pushes its hint at once.
// - Sources (§6.2's table): strikes (hit, block, clang) and work (shape strokes, stakes driven) are their maker's own
//   noise, × crouchNoiseMul when the maker is crouched; footsteps by gait (crouch, walk, run, sprint at
//   NOISE_TUNING.runMinSpeed / sprintMinSpeed × √scale) × scale, one per foot set down this tick (footwork.landed) while
//   moving faster than CREATURE_TUNING.shared.movingMinSpeed; landings and fallen trees by mass; a thrown weapon's thud
//   and a released entity's landing at least throwLand. A thrown or dropped thing's landing, a chop, a dig, a break or
//   a snap names no source: a creature hears where, not who.
// - Voices: an ape shouts on each hit it takes (here) and on entering a fight (its mind: shout()); the giant roars on a
//   wound and on getting up (here), and at its telegraph and the start of a climb out of a pit (its mind: roar()),
//   × weakJawRoarMul with a weak jaw. Minds call shout() and roar() rather than building the noise.
import type { CombatEvent } from '../../sim/combat';
import type { Fighter } from '../../sim/fighter';
import type { ImpactCause, NoiseKind, V3, WorldEvent, WoundRecord } from '../types';
import type { World } from '../world';
import { CREATURE_TUNING, NOISE_TUNING } from './defs';
import type { MindRegistry } from './mind';
import { hasSevereEffect, looksCrouched } from './perception';

/** A sound a creature may hear: just audible at `radius` × the listener's hearingMul. */
export interface Noise {
  at: V3;
  radius: number;
  kind: NoiseKind;
  /** The fighter that made it (it doesn't hear itself), or null. */
  source: number | null;
}

/** What the bus holds between collect (or a mind's emit) and fold, in event order. */
type Pending =
  | { kind: 'noise'; noise: Noise }
  | { kind: 'hurt'; defender: Fighter; cause: ImpactCause | null; attacker: Fighter | null; at: V3 }
  | { kind: 'wound'; ruler: Fighter; wound: WoundRecord };

const v3 = (p: { x: number; y: number; z: number }): V3 => ({ x: p.x, y: p.y, z: p.z });

/** A finite point (an event built without one, as some tests build theirs, makes no noise rather than stop the tick). */
function isPoint(p: { x: number; y: number; z: number } | null | undefined): p is V3 {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/** m: how far a thing of `massKg` landing is heard: clamp(heavyLandBase + heavyLandPerKg × m, base, heavyLandMax). */
export function heavyLandRadius(massKg: number): number {
  const T = NOISE_TUNING;
  return Math.min(T.heavyLandMax, Math.max(T.heavyLandBase, T.heavyLandBase + T.heavyLandPerKg * massKg));
}

/**
 * m: how far `f`'s footstep is heard now: stepCrouch crouched; else stepSprint at or above sprintMinSpeed × √scale,
 * stepRun at or above runMinSpeed × √scale, stepWalk below; × scale (big bodies, §6.2).
 */
export function footstepRadius(w: World, f: Fighter): number {
  const T = NOISE_TUNING;
  let r: number;
  if (looksCrouched(w, f)) r = T.stepCrouch;
  else {
    const speed = Math.hypot(f.walkVel.x, f.walkVel.z);
    const k = Math.sqrt(f.scale);
    r = speed >= T.sprintMinSpeed * k ? T.stepSprint : speed >= T.runMinSpeed * k ? T.stepRun : T.stepWalk;
  }
  return r * f.scale;
}

/** m: the giant's roar (giantRoar, × weakJawRoarMul with a weak jaw). */
export function roarRadius(f: Fighter): number {
  return NOISE_TUNING.giantRoar * (hasSevereEffect(f, 'weakJaw') ? CREATURE_TUNING.giant.weakJawRoarMul : 1);
}

export class NoiseBus {
  readonly world: World;
  private readonly queue: Pending[] = [];

  constructor(world: World) {
    this.world = world;
  }

  /** Items waiting for fold (noises, hurts, wounds); 0 at the end of every tick. */
  get pending(): number {
    return this.queue.length;
  }

  /** Queue a noise for this tick's fold and send its hint to the client (a noise without a finite point is dropped). */
  emit(n: Noise): void {
    if (!isPoint(n.at) || !Number.isFinite(n.radius)) return;
    const noise: Noise = { at: v3(n.at), radius: n.radius, kind: n.kind, source: n.source };
    this.queue.push({ kind: 'noise', noise });
    this.world.events.push({ type: 'noise', at: v3(noise.at), radius: noise.radius, kind: noise.kind });
  }

  /** An ape's fight shout from its head (apeShout). */
  shout(f: Fighter): void {
    this.emit({ at: f.rig.head.pos, radius: NOISE_TUNING.apeShout, kind: 'shout', source: f.id });
  }

  /** The giant's roar from its head (roarRadius). */
  roar(f: Fighter): void {
    this.emit({ at: f.rig.head.pos, radius: roarRadius(f), kind: 'roar', source: f.id });
  }

  /**
   * Phase 17b: noises from this tick's events and footsteps, and the hurts and wounds fold hands to minds, in event
   * order. `we` is the world's event list: the hints pushed here are not read back.
   */
  collect(w: World, ce: readonly CombatEvent[], we: readonly WorldEvent[]): void {
    const T = NOISE_TUNING;
    const byId = fighterIndex(w);
    const own = (f: Fighter, radius: number): number => radius * (looksCrouched(w, f) ? T.crouchNoiseMul : 1);
    for (const e of ce) {
      switch (e.type) {
        case 'hit':
          this.emit({ at: e.point, radius: own(e.attacker, T.hit), kind: 'hit', source: e.attacker.id });
          this.hurtBy(e.defender, null, e.attacker, e.point);
          break;
        case 'block':
          this.emit({ at: e.point, radius: own(e.attacker, T.block), kind: 'block', source: e.attacker.id });
          break;
        case 'clang':
          this.emit({ at: e.point, radius: own(e.f, T.clang), kind: 'clang', source: e.f.id });
          break;
        case 'thud':
          this.emit({ at: e.point, radius: T.throwLand, kind: 'throwLand', source: null });
          break;
        default:
          break;
      }
    }
    for (let i = 0, n = we.length; i < n; i++) {
      const e = we[i];
      switch (e.type) {
        case 'impact': {
          const fid = e.cause?.fighterId ?? null;
          this.hurtBy(e.defender, e.cause ?? null, fid !== null ? (byId.get(fid) ?? null) : null, e.point, e.damage > 0 || e.knockdown);
          break;
        }
        case 'wound':
          this.queue.push({ kind: 'wound', ruler: e.ruler, wound: e.wound });
          if (e.ruler.alive) this.roar(e.ruler);
          break;
        case 'rise':
          if (e.f.ruler && e.f.alive) this.roar(e.f);
          break;
        case 'chop':
          this.emit({ at: e.point, radius: T.chop, kind: 'chop', source: null });
          break;
        case 'dig':
          this.emit({ at: e.point, radius: T.dig, kind: 'dig', source: null });
          break;
        case 'break':
          this.emit({ at: e.point, radius: T.breakNoise, kind: 'break', source: null });
          break;
        case 'joint': {
          if (e.what !== 'snap') break;
          const at = jointPoint(w, byId, e.joint);
          if (at) this.emit({ at, radius: T.ropeSnap, kind: 'ropeSnap', source: null });
          break;
        }
        case 'land':
          this.landed(w, e);
          break;
        case 'fell': {
          const tree = w.entities.get(e.tree);
          if (tree) this.emit({ at: tree.pose.p, radius: heavyLandRadius(tree.mass), kind: 'heavyLand', source: null });
          break;
        }
        case 'verb': {
          if (!e.ok) break;
          const target = e.entity !== undefined ? w.entities.get(e.entity) : undefined;
          if (e.verb === 'shape') {
            this.emit({ at: target ? target.pose.p : e.f.pos, radius: own(e.f, T.shape), kind: 'shape', source: e.f.id });
          } else if (e.verb === 'place' && target?.state === 'anchored') {
            this.emit({ at: target.pose.p, radius: own(e.f, T.stakeDriven), kind: 'stakeDriven', source: e.f.id });
          }
          break;
        }
        default:
          break;
      }
    }
    // Footsteps: the feet set down this tick (footwork.landed is emptied by the mover before the footwork runs; the
    // downed slab empties it too). TODO(P11): RulerMover.resolve must empty it the same way, or a ruler's last steps
    // would be heard again every tick.
    const minSpeed = CREATURE_TUNING.shared.movingMinSpeed;
    for (const f of w.combat.fighters) {
      if (!f.alive || f.state === 'knockdown' || f.state === 'tripped' || f.footwork.landed.length === 0) continue;
      if (!(Math.hypot(f.walkVel.x, f.walkVel.z) > minSpeed)) continue;
      const radius = footstepRadius(w, f);
      for (let k = 0; k < f.footwork.landed.length; k++) this.emit({ at: f.pos, radius, kind: 'step', source: f.id });
    }
  }

  /**
   * Phase 17b: in queue order, each noise to every creature with a mind (fighter order), each hurt to its creature's
   * senses and then its mind's onHurt, each wound to its mind's onWound. The bus is empty afterwards, whatever happens.
   */
  fold(m: MindRegistry): void {
    const w = this.world;
    const tick = w.tick;
    const fighters = w.combat.fighters;
    const byId = fighterIndex(w);
    try {
      for (let i = 0; i < this.queue.length; i++) {
        const p = this.queue[i];
        switch (p.kind) {
          case 'noise': {
            const source = p.noise.source !== null ? (byId.get(p.noise.source) ?? null) : null;
            for (const f of fighters) m.get(f)?.senses.hear(p.noise, f, tick, source);
            break;
          }
          case 'hurt': {
            const mind = m.get(p.defender);
            if (!mind || !p.defender.alive) break;
            mind.senses.hurt(p.defender, p.attacker, p.at, tick);
            mind.onHurt(p.cause, p.attacker, p.at);
            break;
          }
          case 'wound': {
            const mind = m.get(p.ruler);
            if (mind && p.ruler.alive) mind.onWound(p.wound);
            break;
          }
        }
      }
    } finally {
      this.queue.length = 0;
    }
  }

  /**
   * A hit or impact on `d`: the hurt for fold (at its point, or the defender's position without one), and an ape's
   * shout when it is still standing to shout.
   */
  private hurtBy(d: Fighter, cause: ImpactCause | null, attacker: Fighter | null, at: V3 | undefined, felt = true): void {
    this.queue.push({ kind: 'hurt', defender: d, cause, attacker: attacker === d ? null : attacker, at: v3(isPoint(at) ? at : d.pos) });
    if (felt && d.alive && d.species === 'ape') this.shout(d);
  }

  /** A `land` event: a fighter coming down (its own noise, by its mass), or an entity (thrown or dropped: ≥ throwLand). */
  private landed(w: World, e: Extract<WorldEvent, { type: 'land' }>): void {
    const T = NOISE_TUNING;
    const radius = heavyLandRadius(e.mass);
    if (e.f) {
      this.emit({ at: e.point, radius, kind: 'heavyLand', source: e.f.id });
      return;
    }
    const ent = e.entity !== null ? w.entities.get(e.entity) : undefined;
    if (ent && (ent.thrown || ent.releasedBy)) this.emit({ at: e.point, radius: Math.max(T.throwLand, radius), kind: 'throwLand', source: null });
    else this.emit({ at: e.point, radius, kind: 'heavyLand', source: null });
  }
}

/** The world's fighters by id. */
function fighterIndex(w: World): Map<number, Fighter> {
  const m = new Map<number, Fighter>();
  for (const f of w.combat.fighters) m.set(f.id, f);
  return m;
}

/**
 * Where a rope or joint is: the middle of its two anchors' world points (an entity anchor through the entity's pose, a
 * held end at its holder, a loose end or a world point as given). null once the record is gone.
 * TODO(P10): the `joint` event names no point; a snap is heard only while JointStore.get still returns the record in
 * phase 17b.
 */
function jointPoint(w: World, byId: ReadonlyMap<number, Fighter>, id: number): V3 | null {
  const j = w.joints.get(id);
  if (!j) return null;
  const pts: V3[] = [];
  for (const a of [j.a, j.b]) {
    if (a.fighter !== undefined) {
      const f = byId.get(a.fighter);
      if (f) pts.push(v3(f.pos));
    } else if (a.entity !== null) {
      const e = w.entities.get(a.entity);
      if (e) pts.push(rotateAdd(e.pose.q, a.local, e.pose.p));
    } else pts.push(v3(a.local));
  }
  if (pts.length === 0) return null;
  const s = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  return { x: s.x / pts.length, y: s.y / pts.length, z: s.z / pts.length };
}

/** p + q·v (a unit quaternion rotating v). */
function rotateAdd(q: { x: number; y: number; z: number; w: number }, v: V3, p: V3): V3 {
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: p.x + v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: p.y + v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: p.z + v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
