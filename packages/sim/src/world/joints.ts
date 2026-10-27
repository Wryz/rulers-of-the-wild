// Joints and ropes (docs/M1-DESIGN.md §1.5.7, §2.4, §4.9): lash, hinge, rope, bend; held ends with the haul model;
// rope sensors re-posed before every step; the non-negative least-squares tension fit, strands and snaps; tripwire loads.
//
// Records and Rapier (§2.4):
// - lash → a fixed joint, contacts off between the pair; hinge → a revolute (limits set on the joint after creation),
//   contacts off; rope → a rope joint while both ends are bodies or world points; bend → a revolute at the sapling's
//   base with a ForceBased position motor toward its rest angle, held bent by a rope joint whose `holdsBend` names it.
//   No Rapier joint while an end is held (a fighter's hand: the haul model's code forces) or loose.
// - The Rapier joint is runtime state: it is made from the record and the bodies' current poses, and made again
//   whenever an end's body changes (stowed and drawn, rebuilt by a load, reshaped by felling), so a lashed axe stays
//   lashed through stow → draw → drop. A lash or hinge holds the bodies where they are when it is made (Anchor has no
//   rotation: the fixed frames come from the two current poses, and b's anchor is a's anchor point seen from b).
// - A world-point end (entity null, not loose, not held) is a hidden fixed body at that point (no collider, never
//   saved). DEVIATION (§2.4 writes "no Rapier joint when an end is … a world point on a fixed entity (code forces)"):
//   no code force is specified for it, so a Rapier joint to a fixed point is the rule's closest working form (rule 3);
//   an entity anchor on a fixed entity (a tree, a stump) is a body and always gets the Rapier joint.
// - A rope has no body (SPEC:265): its rope entity is `tied` (no body) while a joint is made of it, and the joint owns
//   one parentless sensor capsule (ROPE group) between its anchors, re-posed in phase 4e. When no joint uses the rope
//   entity any more (removed, both ends loose) it becomes a coil again (`free`, ropeCoilShape of its length) lying on
//   the ground under where the rope was.
//
// Each tick: 4d `applyHeldEnds` (the haul model: reel-in, haul impulses, moments on notched trees, anchors pulled
// loose; a pull not set again spent; cinching ties held or reeled; loose ends dragged within reach of the end they hang
// from), 4e `poseSensors` (Rapier joints re-made where a body changed, sensors posed), 9d `tripwire` (from the contact
// pipeline), 10 `postStep` (the tension fit, the 3-step rings, snaps, released bends settling back to standing,
// cinching ties that stopped tied).
//
// Order: every loop runs in joint id order; entity joint lists are kept sorted. Rapier handles never leave the runtime
// map and are never saved.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { fistPoint } from '../body/skeleton';
import type { JointRecV1 } from '../save/schema';
import type { Fighter } from '../sim/fighter';
import { DT } from '../sim/math';
import { defineTuning } from '../tuning/registry';
import { knockLoose } from './breaking';
import type { TripwireSink } from './contacts';
import { ropeCoilShape } from './factory';
import { collisionGroups, solverGroups } from './groups';
import { lashBreakEnergyJ, MATERIALS, ropeStrengthN } from './materials';
import { ownerKey, PHYSICS_TUNING } from './physics';
import { GEOM_EPS, principalAxis, shapeContains } from './shapes';
import type { Anchor, Entity, JointKind, JointRecord, Owner, Pose3, Quat, Shape, V3 } from './types';
import { VERB_TUNING } from './verbs/tuning';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

export const JOINT_TUNING = defineTuning(
  'JOINT_TUNING',
  'Materials & joints › ropes',
  {
    tripwireWindowS: 0.1,
    ropeBreakSteps: 3,
    tautEps: 0.001,
    lashLeverM: 0.1,
    ropeSensorR: 0.02,
    strandMergeM: 0.05,
    nnlsMaxGroups: 8,
    bendK: 400000,
    bendDamping: 40000,
    bendMinSpringiness: 0.3,
    burnSpeedMps: 0.05,
    bendHoldRopeM: 0.3,
    bendSettleDeg: 5,
    tieStillMps: 0.05,
    nnlsIterPerGroup: 3,
    nnlsIterBase: 10,
    tripwireEndSpeedMul: 1,
  },
  {
    tripwireWindowS: { unit: 's', source: 'SPEC:259' },
    ropeBreakSteps: { unit: 'steps', source: 'SPEC:261', min: 1, max: 3, step: 1 },
    tautEps: { unit: 'm', source: 'NEW: MAP rapier §5' },
    lashLeverM: { unit: 'm', source: 'D-18 (vine 600 J, sinew 1,800 J)' },
    ropeSensorR: { unit: 'm', source: 'NEW' },
    strandMergeM: { unit: 'm', source: 'NEW: SPEC:266 strands' },
    nnlsMaxGroups: { unit: 'strand groups per body', source: 'NEW: C F5' },
    bendK: { unit: 'N·m/rad per m² of diameter', source: 'NEW (6 cm green sapling: 864 N·m/rad)' },
    bendDamping: { unit: 'N·m·s/rad per m²', source: 'NEW' },
    bendMinSpringiness: { unit: '—', source: 'NEW: springy predicate' },
    burnSpeedMps: { unit: 'm/s', source: 'SPEC:261 (M2)' },
    bendHoldRopeM: { unit: 'm', source: 'NEW: §5.9 ("held by a 0.3 m rope joint from its top to the anchor")' },
    bendSettleDeg: {
      unit: '°',
      source: 'NEW: a released sapling that comes to rest within this of upright is rooted again (standing, fixed), so it can be bent again',
    },
    tieStillMps: {
      unit: 'm/s along the rope',
      source:
        'NEW: a held end tied off while its load still runs along the rope faster than this cinches when the load stops (the haul keeps acting through the hitch); a rigid rope made around a moving load catches it in one step (P10 review: a 30 kg log at 2 m/s snapped its vine tie)',
    },
    nnlsIterPerGroup: { unit: 'iterations per strand group', source: '§4.9 (Lawson-Hanson, at most 3·n + 10 iterations)', min: 1, step: 1 },
    nnlsIterBase: { unit: 'iterations', source: '§4.9 (Lawson-Hanson, at most 3·n + 10 iterations)', min: 0, step: 1 },
    tripwireEndSpeedMul: {
      unit: "× the crosser's speed across the rope",
      source:
        "NEW: orchestrator decision (P10's tripwire risk): each end's share of the crossing momentum is at most m_end × |v·n̂| × this, so no end leaves faster than the crosser crosses (§4.9's uncapped half of p sent a 2.3 kg stake off at ≈ 85 m/s)",
      min: 0,
    },
  },
);

/** What the client draws of a rope (§1.5.7). */
export interface RopeView {
  joint: number;
  a: V3;
  b: V3;
  lengthM: number;
  taut: boolean;
  /** max(T) / (strength × strands): the per-strand tension ring's maximum over one strand's strength. */
  strain: number;
}

/** A joint's runtime state (never saved; rebuilt from the record). */
interface JointRuntime {
  /** The Rapier joint, or null (an end held, loose or without a body). */
  joint: RAPIER.ImpulseJoint | null;
  /** The bodies the Rapier joint was made between (it is made again when either end's body changes). */
  bodyA: RAPIER.RigidBody | null;
  bodyB: RAPIER.RigidBody | null;
  /** The rope length the Rapier rope joint was made with. */
  madeLength: number;
  /** The hidden fixed body standing for a world-point end, and the point it was made at. */
  ground: RAPIER.RigidBody | null;
  groundAt: V3 | null;
  /** The rope sensor (joints made of a rope). */
  sensor: RAPIER.Collider | null;
  /** Make the Rapier joint again at the next sync (an anchor moved). */
  stale: boolean;
  /**
   * setPull was called since the last phase 4d read it: a held end's pullN is this tick's pull only when fresh (a pull
   * nobody set again is spent in 4d). Never saved: it only says whether a call came between two 4d's, which a load
   * can't fall between.
   */
  pullFresh: boolean;
  /** A cinching tie hauled its load this tick (4d → phase 10 of one tick; never across a save). */
  cinchHauled: boolean;
}

/** A joint end as the tension fit and the tripwire see it. */
interface EndInfo {
  /** A body for the Rapier joint (an entity's, or the hidden ground body), or null. */
  body: RAPIER.RigidBody | null;
  /** The body's pose (an entity's record pose; the ground body's point). */
  pose: Pose3;
  /** The anchor in that body's frame. */
  local: V3;
}

/** The strand group a taut rope joint belongs to (§2.4: same two anchor points, each within strandMergeM). */
interface StrandGroup {
  joints: JointRecord[];
  /** The group's representative (its lowest id). */
  rep: JointRecord;
}

export class JointStore implements TripwireSink {
  readonly world: World;

  private readonly byId = new Map<number, JointRecord>();
  /** Every joint in id order. */
  private readonly sorted: JointRecord[] = [];
  /** all()'s answer, rebuilt after a change. */
  private snapshot: readonly JointRecord[] | null = null;
  private readonly rt = new Map<number, JointRuntime>();
  /** (tick, strand group × crosser) pairs whose tripwire load was taken this tick: two strands' sensors are one crossing. */
  private tripped: { tick: number; keys: Set<string> } = { tick: -1, keys: new Set() };

  constructor(world: World) {
    this.world = world;
  }

  get(id: number): JointRecord | undefined {
    return this.byId.get(id);
  }

  /** Id order. */
  all(): readonly JointRecord[] {
    this.snapshot ??= Object.freeze(this.sorted.slice());
    return this.snapshot;
  }

  // -------------------------------------------------------------------------
  // Making joints
  // -------------------------------------------------------------------------

  /** A fixed joint (contacts off between the pair); breaks on an impact above the lashing's energy (D-18). */
  lash(a: Anchor, b: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): number {
    this.checkEnds('lash', a, b);
    return this.make('lash', a, b, rope, credit, { breakEnergyJ: this.lashEnergy(rope.entity) });
  }

  /**
   * A revolute joint about `axis` (a's frame), limits in rad about it from the pose the pair is in now (null: free);
   * contacts off between the pair. Rapier reads a revolute's angle between frames it builds from each body's local axis
   * alone, so two bodies turned about the axis relative to each other start at a non-zero angle: the record keeps the
   * limits in Rapier's reference (the angle now added, revoluteAngle), so they hold the same way through every remake
   * of the Rapier joint and a load. A range that would cross ±π is moved a turn when it fits, else clamped to ±π.
   */
  hinge(a: Anchor, b: Anchor, axis: V3, limits: [number, number] | null, rope: { entity: number; lengthM: number }, credit: string[]): number {
    this.checkEnds('hinge', a, b);
    const n = norm(axis);
    if (!(n > 0) || !Number.isFinite(n)) throw new Error('JointStore.hinge: the axis must be a non-zero vector');
    const ax = scale(axis, 1 / n);
    let lim: [number, number] | null = null;
    if (limits) {
      const qa = this.anchorRotation(a);
      const qb = this.anchorRotation(b);
      const at = revoluteAngle(qa, ax, qb, rotate(conj(qb), rotate(qa, ax)));
      lim = wrapLimits(limits[0] + at, limits[1] + at);
    }
    return this.make('hinge', a, b, rope, credit, { breakEnergyJ: this.lashEnergy(rope.entity), axis: ax, limits: lim });
  }

  /** A rope of free length `lengthM` (a Rapier rope joint while both ends are bodies or world points). */
  rope(a: Anchor, b: Anchor, lengthM: number, rope: { entity: number; lengthM: number }, credit: string[]): number {
    this.checkEnds('rope', a, b);
    if (!(lengthM > 0) || !Number.isFinite(lengthM)) throw new Error(`JointStore.rope: a rope length must be positive, not ${lengthM}`);
    return this.make('rope', a, b, { entity: rope.entity, lengthM }, credit, {});
  }

  /**
   * Bend (§5.9): the rooted sapling becomes a dynamic body hinged at its base (a `bend` joint with a motor toward its
   * rest angle, upright), posed bent toward `hold`'s point as far as it reaches (its top `bendHoldRopeM` from the
   * point) and as far as VERB_TUNING.bendMaxForceN at its top allows (k θ / L ≤ that force), `plant.phase 'bent'`, and
   * held there by a rope joint from `top` (on the sapling) to `hold` whose `holdsBend` names the bend joint. Ids: the
   * bend joint, then the holding rope.
   */
  bend(sapling: number, top: Anchor, hold: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): { bend: number; hold: number } {
    const w = this.world;
    const s = w.entities.get(sapling);
    if (!s || !s.plant || s.state !== 'fixed') throw new Error(`JointStore.bend: entity ${sapling} is not a rooted sapling`);
    if (top.entity !== sapling || top.fighter !== undefined || top.loose) throw new Error('JointStore.bend: the top anchor must be on the sapling');
    this.checkEnds('bend', top, hold);
    const holdAt = this.anchorPoint(hold);
    if (!holdAt) throw new Error('JointStore.bend: the hold anchor has no point');
    const T = JOINT_TUNING;
    const bp = bendAngle(s, top.local, holdAt);
    if (!bp) throw new Error('JointStore.bend: the hold point is straight above or below the sapling');
    const { theta, pivot, axis, stiffness: k, damping } = bp;
    // Posed bent: rotated about the pivot, then dynamic.
    const rot = axisAngle(axis, theta);
    const p = add(pivot, rotate(rot, sub(s.pose.p, pivot)));
    const q = qmul(rot, s.pose.q);
    w.entities.unanchor(s);
    w.entities.setPose(s, { p, q });
    s.plant.phase = 'bent';
    s.touched = true;
    const pivotLocal = toLocal({ p, q }, pivot);
    const bendId = this.make(
      'bend',
      { entity: sapling, local: pivotLocal },
      { entity: null, local: copy3(pivot) },
      null,
      credit,
      { axis: rotate(conj(q), axis), motor: { restAngle: 0, stiffness: k, damping } },
    );
    const topNow = transform({ p, q }, top.local);
    const len = Math.max(T.bendHoldRopeM, dist(topNow, holdAt));
    const holdId = this.make('rope', copyAnchor(top), copyAnchor(hold), { entity: rope.entity, lengthM: len }, credit, { holdsBend: bendId });
    return { bend: bendId, hold: holdId };
  }

  // -------------------------------------------------------------------------
  // Changing joints
  // -------------------------------------------------------------------------

  /**
   * Removes the joint and its Rapier joint and sensor; the entities at its ends and its rope entity lose it from their
   * joint lists. Pushes a `joint` event (`why`, at the middle of its anchors); a bend whose holding rope this was is
   * released (its own `release` event) and springs back; a removed bend frees its holding rope. A rope entity no other
   * joint uses becomes a coil. An unknown id does nothing (callable re-entrantly from EntityStore.remove).
   */
  remove(id: number, why: 'cut' | 'untie' | 'snap' | 'release'): void {
    const j = this.byId.get(id);
    if (!j) return;
    const point = this.midpoint(j);
    this.forget(j);
    this.world.events.push({ type: 'joint', joint: id, what: why, point });
    this.afterRemoved(j, point);
  }

  /** The end a fighter's hand now holds (Pull): no Rapier joint while held; the haul model moves it (§4.9). */
  holdEnd(joint: number, end: 'a' | 'b', fighterId: number): void {
    const j = this.need(joint, 'holdEnd');
    const old = j[end];
    const at = this.anchorPoint(old) ?? copy3(old.local);
    this.setEnd(j, end, { entity: null, local: at, fighter: fighterId });
    j.pullN = 0;
    this.runtime(j).pullFresh = false;
    // A hand holds no bend (a held end has no Rapier joint): the bend it kept is released.
    this.releaseBend(j);
  }

  /** The held end becomes loose at `at` (letting go of a rope end, §5.1). Nothing when no end is held. */
  dropEnd(joint: number, at: V3): void {
    const j = this.byId.get(joint);
    if (!j) return;
    const end = heldEndOf(j);
    if (end) this.loosen(joint, end, at);
  }

  /**
   * `end` becomes loose at the world point `at` (`joint loose` event): a dropped end, or the end on an entity that broke
   * (§4.10). With both ends loose the joint is gone and its rope a coil.
   */
  loosen(joint: number, end: 'a' | 'b', at: V3): void {
    const j = this.byId.get(joint);
    if (!j) return;
    this.setEnd(j, end, { entity: null, local: copy3(at), loose: true });
    j.pullN = 0;
    const point = this.midpoint(j);
    this.world.events.push({ type: 'joint', joint, what: 'loose', point });
    // A rope with a loose end holds no bend: the sapling springs back (and roots again once still, settleBends).
    this.releaseBend(j);
    if (j.a.loose && j.b.loose) {
      this.forget(j);
      this.afterRemoved(j, point);
    }
  }

  /**
   * The held end's pull this tick (verbs set it every tick, in 4d before applyHeldEnds); the haul model, §4.9. Ignored on
   * a joint with no held end. DEVIATION (§4.9 "spent at the end of phase 10"): the pull stays in the record until the
   * next 4d, which spends it unless it was set again, so a tie landing in phase 3 (§5.8) still sees the haul force of
   * the tick before and keeps it while the tie cinches (tieHeldEnd).
   */
  setPull(joint: number, forceN: number): void {
    const j = this.byId.get(joint);
    if (!j || heldEndOf(j) === null) return;
    j.pullN = Math.max(0, Number.isFinite(forceN) ? forceN : 0);
    this.runtime(j).pullFresh = true;
  }

  /** Reel in a slack rope by `dl`, never shorter than the distance between its ends. */
  shorten(joint: number, dl: number): void {
    const j = this.byId.get(joint);
    if (!j?.rope || !(dl > 0)) return;
    const d = this.endDistance(j);
    j.rope.lengthM = Math.max(d ?? 0, j.rope.lengthM - dl);
    this.markStale(j);
  }

  /**
   * Pay `dl` more rope into the joint's free length (a splice knotted on at a held or loose end, §5.8). Only rope is
   * added: the rope entity's own length is its caller's. The Rapier rope, if any, is made again at the next sync.
   */
  lengthen(joint: number, dl: number): void {
    const j = this.byId.get(joint);
    if (!j?.rope || !(dl > 0)) return;
    j.rope.lengthM += dl;
    this.markStale(j);
  }

  /**
   * The held end becomes tied to `to` at the current distance (tie, §5.8, §4.9); tying ends the pull.
   *
   * DEVIATION (P10 review finding 3; needs design approval): a rigid Rapier rope made around a load that still runs
   * along it catches the load in one step, and the fit reads that catch (a 30 kg log tied while running out at 2 m/s
   * snapped its vine tie on the first step; one tied while coming in came back to the tie's length at its speed). So a
   * tie made while the end was hauled (pullN > 0, the last 4d's pull, setPull), to something static, whose load moves
   * along the rope faster than tieStillMps, **cinches** (pullN stays in the record and marks it; no Rapier joint):
   * - while the load runs out, the hauler's pull keeps holding it through the hitch (the haul model from the tie point);
   * - while it comes in, the slack is taken in as it comes, with no pull (hauling it on from a tie point level with it
   *   drew it up until its hanging vines lined up with the tie, which no rope holds);
   * - it ends in the phase 10 where the load stops along the rope (its speed along the rope changes sign within the
   *   tick, or falls to tieStillMps), or the rope runs out; the rope is then tied at that distance (settleCinch).
   * A tie to a load at rest, to a dynamic target, or with no haul on, is tied at once, as §4.9 writes.
   */
  tieHeldEnd(joint: number, to: Anchor): void {
    const j = this.need(joint, 'tieHeldEnd');
    const end = heldEndOf(j);
    if (!end) throw new Error(`JointStore.tieHeldEnd: joint ${joint} has no held end`);
    if (to.loose || to.fighter !== undefined) throw new Error('JointStore.tieHeldEnd: a rope is tied to an entity or a world point');
    this.checkAnchor('tieHeldEnd', to);
    const other = end === 'a' ? j.b : j.a;
    const pTo = this.anchorPoint(to);
    const pOther = this.anchorPoint(other);
    // The haul force the hand had: this tick's when set before the tie, else the one the last 4d applied (setPull).
    const pull = j.pullN;
    this.setEnd(j, end, copyAnchor(to));
    if (j.rope && pTo && pOther) j.rope.lengthM = Math.max(dist(pTo, pOther), JOINT_TUNING.tautEps);
    j.pullN = pull;
    this.runtime(j).pullFresh = false;
    const c = pull > 0 ? this.cinchOf(j, false) : null;
    if (!c || !(Math.abs(this.speedAlong(c.e, c.at, c.u, 'now')) > JOINT_TUNING.tieStillMps)) j.pullN = 0;
    this.markStale(j);
  }

  /**
   * An entity was cut or reshaped into pieces whose origins sit at `offset` in its old frame, with its rotation (a
   * felled trunk and its stump, §2.5; a cross-cut, §5.3): every joint end on `from` moves to the piece whose shape holds
   * its anchor (else the nearest piece), its local point re-expressed in that piece's frame. The Rapier joints are made
   * again at the next sync.
   */
  transferAnchors(from: number, pieces: readonly { entity: number; offset: V3; shape: Shape }[]): void {
    if (pieces.length === 0) return;
    for (const j of this.sorted) {
      for (const end of ['a', 'b'] as const) {
        const an = j[end];
        if (an.entity !== from || an.fighter !== undefined || an.loose) continue;
        let best = pieces[0];
        let bestD = Infinity;
        for (const pc of pieces) {
          const l = sub(an.local, pc.offset);
          const ax = principalAxis(pc.shape);
          if (shapeContains(pc.shape, l, GEOM_EPS * (ax.max - ax.min + 2 * ax.crossHalf))) {
            best = pc;
            break;
          }
          const dd = norm(l);
          if (dd < bestD) {
            bestD = dd;
            best = pc;
          }
        }
        this.setEnd(j, end, { entity: best.entity, local: sub(an.local, best.offset) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /**
   * Phase 4d, after the verbs' code forces (which set this tick's pulls): held ends by the haul model (§4.9) and loose
   * ends kept within the rope's reach of the end they hang from.
   *
   * The haul model, while the held end is pulled (pullN > 0): when the hand-to-anchor distance is below the free length
   * by more than tautEps the free length shortens toward it by at most pullHandSpeedMps × DT (reeling in hand over hand);
   * when the distance is within haulTautM of the free length the hand hauls with pullN × clamp((pullHandSpeedMps −
   * v_a) / haulRampMps, 0, 1) along the rope: an impulse on a dynamic body (queued, applied later in this 4d), a moment
   * on a notched tree (felling.addMoment), or pullN tested against an anchored stake's capacity (pulled loose if
   * exceeded); the free length then becomes the current distance (it never grows while held). Not pulling, the hand
   * only holds: the rope pays out to its free length (the tether keeps the hand within it). A pull not set again since
   * the last 4d is spent here (setPull). A tie still cinching (tieHeldEnd) is hauled the same way from its tie point.
   */
  applyHeldEnds(w: World): void {
    const fighters = fighterMap(w);
    for (const j of [...this.sorted]) {
      if (j.kind !== 'rope' || !j.rope || !this.byId.has(j.id)) continue;
      const heldEnd = heldEndOf(j);
      if (heldEnd) {
        // A pull nobody set again since the last 4d is spent (setPull).
        const rt = this.runtime(j);
        if (!rt.pullFresh) j.pullN = 0;
        rt.pullFresh = false;
        const f = fighters.get(j[heldEnd].fighter!);
        if (!f) {
          // Its holder is gone: the end lies where it was.
          this.loosen(j.id, heldEnd, copy3(j[heldEnd].local));
          continue;
        }
        const other = heldEnd === 'a' ? j.b : j.a;
        if (other.loose || other.fighter !== undefined || !(j.pullN > 0)) continue;
        this.reelAndHaul(j, other, handOf(f));
        continue;
      }
      if (j.pullN > 0) {
        // A tie still cinching (tieHeldEnd): a load running out is held by the haul through the hitch (the tie point
        // standing in for the hand); a load coming in has its slack taken in as it comes, with no pull.
        const c = this.cinchOf(j, false);
        if (!c) {
          j.pullN = 0;
          this.markStale(j);
          continue;
        }
        if (this.speedAlong(c.e, c.at, c.u, 'now') < 0) {
          this.haul(j, j[c.load], c.at, c.u);
          this.runtime(j).cinchHauled = true;
        } else if (c.D < j.rope.lengthM) j.rope.lengthM = Math.max(c.D, JOINT_TUNING.tautEps);
        continue;
      }
      // A loose end hangs from the other end: dragged along when that end moves farther than the rope reaches.
      for (const [loose, held] of [
        ['a', 'b'],
        ['b', 'a'],
      ] as const) {
        if (!j[loose].loose || j[held].loose) continue;
        const P = this.anchorPoint(j[held]);
        if (!P) continue;
        const Q = j[loose].local;
        const D = dist(P, Q);
        if (D > j.rope.lengthM && D > 0) j[loose] = { entity: null, local: add(P, scale(sub(Q, P), j.rope.lengthM / D)), loose: true };
      }
    }
  }

  /**
   * Phase 4e: every Rapier joint made again where an end's body changed, and every rope sensor re-posed from its
   * anchors' current poses (the step then refreshes the broad phase, so a sensor moved 1 m is found at its new pose,
   * RF-13).
   */
  poseSensors(): void {
    for (const j of this.sorted) {
      const rt = this.runtime(j);
      this.syncRapier(j, rt);
      if (rt.sensor) this.poseSensor(j, rt.sensor);
    }
  }

  /**
   * Phase 9d (the contact pipeline's TripwireSink, §4.9): a new episode between rope sensor `joint` and `by` (a
   * creature's collider or a dynamic entity). A rope whose both ends are attached (not loose, not held) takes the
   * crosser's momentum across it, p = M·|v·n̂| (n̂ the horizontal unit ⟂ the rope; M the whole creature's mass and v its
   * root velocity, not the touching limb's, RT-5; an entity's mass and stored velocity), as load = p / tripwireWindowS.
   * Above the strand group's strength (ropeKN × 1000 per strand) every strand snaps; otherwise each end takes half of p
   * along the rope toward the crossing point, capped at m_end × |v·n̂| × tripwireEndSpeedMul: a dynamic end body as an
   * impulse queued for the next phase 4d (RF-2), an anchored end whose capacity the load beats pulled loose with its
   * share, a fixed one into the ground. A `tripwire` event says what happened, and where: the crossing point on the rope.
   * Exempt: the rope's own end entities, ropes the crosser holds, and a crosser working on the rope or an entity at its
   * ends (its work target in 'pickup', its tug, or its focus while in 'attack').
   * DEVIATION (orchestrator decision on P10's reported risk; replaces §4.9's "every dynamic end body gets an equal share
   * of impulse `p` along the rope toward the crossing point"): uncapped, an ape at 4 m/s puts 195 N·s on a 2.3 kg stake
   * it pulls loose, which leaves at ≈ 85 m/s and shatters; a rope can't throw its end faster than the body crossing it
   * moves across it, so each end's share is at most its mass × the crosser's speed across the rope.
   */
  tripwire(w: World, joint: number, by: Owner): void {
    const j = this.byId.get(joint);
    if (!j || j.kind !== 'rope' || !j.rope) return;
    if (isFree(j.a) || isFree(j.b)) return;
    // P28: an end held through its entity (in someone's hands, or a creature's tug) is held too (§4.9 "not held").
    if (endEntityHeld(w, j)) return;
    const ends = this.endPoints(j);
    if (!ends) return;
    let M: number;
    let v: V3;
    let at: V3;
    let crosser: string;
    if (by.kind === 'fighter') {
      const f = w.combat.fighters.find((x) => x.id === by.id);
      if (!f || this.exempt(w, f, j)) return;
      M = f.mass;
      v = this.rootVelocity(w, f, by);
      at = { x: f.pos.x, y: f.pos.y, z: f.pos.z };
      crosser = `fighter:${f.id}`;
    } else if (by.kind === 'entity') {
      const e = w.entities.get(by.id);
      if (!e || by.id === j.rope.entity || j.a.entity === by.id || j.b.entity === by.id) return;
      M = e.mass;
      const pre = w.physics.pre(ownerKey(by));
      v = pre ? copy3(pre.v) : copy3(e.vel.lin);
      at = copy3(e.pose.p);
      crosser = `entity:${e.id}`;
    } else return;
    const strands = this.strandsOf(j, ends);
    const key = `${strands[0].id}|${crosser}`;
    if (this.tripped.tick !== w.tick) this.tripped = { tick: w.tick, keys: new Set() };
    if (this.tripped.keys.has(key)) return;
    this.tripped.keys.add(key);

    const d = sub(ends.b, ends.a);
    const h = Math.hypot(d.x, d.z);
    const p = M * (h > 0 ? Math.abs((v.x * -d.z + v.z * d.x) / h) : Math.hypot(v.x, v.z));
    // No momentum across the rope (a body standing in it, a limb reaching into it): nothing crosses it.
    if (!(p > 0)) return;
    const load = p / JOINT_TUNING.tripwireWindowS;
    let strength = 0;
    for (const s of strands) strength += this.strengthOf(s);
    const loosed: number[] = [];
    let snapped = false;
    // The crossing point: the rope's point nearest the crosser (the event's point; the shares pull toward it).
    const c = nearestOnSegment(ends.a, ends.b, at);
    if (load > strength) {
      snapped = true;
      for (const s of strands) this.remove(s.id, 'snap');
    } else {
      // The crosser's speed across the rope (p = M·|v·n̂|): no end is sent off faster than this × tripwireEndSpeedMul.
      const across = p / M;
      for (const [an, P, Q] of [
        [j.a, ends.a, ends.b],
        [j.b, ends.b, ends.a],
      ] as const) {
        if (an.entity === null) continue;
        const e = w.entities.get(an.entity);
        if (!e) continue;
        let toward = sub(c, P);
        if (!(norm(toward) > 0)) toward = sub(Q, P);
        const share = scale(normalize(toward), Math.min(p / 2, e.mass * across * JOINT_TUNING.tripwireEndSpeedMul));
        const dynamic = !!e.body && e.body.isEnabled() && e.body.isDynamic() && !w.entities.isAnchored(e);
        if (dynamic) w.entities.queueImpulse(e.id, share, P);
        else if (e.state === 'anchored' && e.anchor && e.anchor.capacityN < load) {
          // Pulled loose (and lifted out of the ground): its share lands where its anchor point now is.
          const lift = knockLoose(w, e);
          loosed.push(e.id);
          w.entities.queueImpulse(e.id, share, { x: P.x, y: P.y + lift, z: P.z });
        }
      }
    }
    w.events.push({ type: 'tripwire', joint, by: copyOwner(by), loadN: load, snapped, loosed, point: copy3(c) });
  }

  /**
   * Phase 10 (§4.9): the tension of every taut rope from a per-body non-negative least-squares fit over that body's taut
   * strand groups, `Σ t_k û_k = m(a − g)` and `Σ t_k (r_k × û_k)/L = (I_w α + ω × I_w ω)/L`, with a and α from the
   * phase-5 store and the phase-8 snapshot (an asleep body: at rest); a rope between two dynamic bodies takes the larger
   * of its two ends' estimates, a held end max(pullN, fitted); per strand t / strands, pushed into each joint's ring; a
   * group whose strand's ring maximum (over ropeBreakSteps) beats that strand's strength loses its weakest strand (one
   * per group per tick). Then released bends settle, and cinching ties whose load stopped are tied (a held end keeps
   * its pull until the next 4d).
   * TODO "rope tension with contacts": a roped body that also rests on something has its support unexplained by the
   * ropes, so its tension reads low.
   */
  postStep(w: World): void {
    const T = JOINT_TUNING;
    const ends = new Map<number, { a: V3; b: V3 } | null>();
    for (const j of this.sorted) ends.set(j.id, this.endPoints(j));
    const taut: JointRecord[] = [];
    for (const j of this.sorted) {
      if (j.kind !== 'rope' || !j.rope || j.a.loose || j.b.loose) continue;
      const e = ends.get(j.id);
      if (e && dist(e.a, e.b) >= j.rope.lengthM - T.tautEps) taut.push(j);
    }
    const groups = this.groupStrands(taut, ends);
    const est = groups.map(() => 0);
    // The bodies with taut groups on them, by entity id.
    const onBody = new Map<number, number[]>();
    groups.forEach((g, gi) => {
      for (const side of ['a', 'b'] as const) {
        const an = g.rep[side];
        if (an.entity === null || an.fighter !== undefined || an.loose) continue;
        const other = side === 'a' ? g.rep.b : g.rep.a;
        if (other.entity === an.entity && other.fighter === undefined && !other.loose) continue;
        let l = onBody.get(an.entity);
        if (!l) onBody.set(an.entity, (l = []));
        l.push(gi);
      }
    });
    for (const id of [...onBody.keys()].sort((x, y) => x - y)) {
      const e = w.entities.get(id);
      const b = e?.body;
      if (!e || !b || !b.isEnabled() || !b.isDynamic()) continue;
      const list = onBody.get(id)!.slice(0, Math.max(1, Math.round(T.nnlsMaxGroups)));
      const t = this.fit(w, e, b, list.map((gi) => groups[gi]), ends);
      list.forEach((gi, k) => {
        if (t[k] > est[gi]) est[gi] = t[k];
      });
    }
    const groupOf = new Map<number, number>();
    groups.forEach((g, gi) => {
      for (const j of g.joints) groupOf.set(j.id, gi);
    });
    for (const j of this.sorted) {
      if (j.kind !== 'rope') continue;
      const gi = groupOf.get(j.id);
      let t = gi === undefined ? 0 : est[gi] / groups[gi].joints.length;
      // A held end, or a cinching tie that hauled this tick: the hand's pull is on the rope (max(pullN, fitted)).
      const rt = this.rt.get(j.id);
      if (heldEndOf(j) !== null || (j.pullN > 0 && rt?.cinchHauled)) t = Math.max(t, j.pullN);
      if (rt) rt.cinchHauled = false;
      if (!Number.isFinite(t) || t < 0) t = 0;
      j.tension = [j.tension[1], j.tension[2], t];
    }
    // Snaps: one strand per group per tick, the weakest first; a rope in no taut group is its own group.
    const checked = new Set<number>();
    const sets: JointRecord[][] = groups.map((g) => g.joints);
    for (const j of this.sorted) if (j.kind === 'rope' && !groupOf.has(j.id)) sets.push([j]);
    for (const set of sets) {
      if (set.some((j) => checked.has(j.id))) continue;
      for (const j of set) checked.add(j.id);
      if (!set.some((j) => ringMax(j) > this.strengthOf(j))) continue;
      let weakest = set[0];
      for (const j of set) {
        const s = this.strengthOf(j);
        const sw = this.strengthOf(weakest);
        if (s < sw || (s === sw && j.id < weakest.id)) weakest = j;
      }
      if (this.byId.has(weakest.id)) this.remove(weakest.id, 'snap');
    }
    this.settleBends(w);
    // A held end's pull stays until the next 4d (setPull); a cinching tie ends once its load stops.
    for (const j of [...this.sorted]) if (j.pullN > 0 && heldEndOf(j) === null && this.byId.has(j.id)) this.settleCinch(j);
  }

  /** Client: anchors (world), length, tension over strength, slack. Joints made of a rope, in id order. */
  view(): readonly RopeView[] {
    const out: RopeView[] = [];
    for (const j of this.sorted) {
      if (!j.rope) continue;
      const e = this.endPoints(j);
      if (!e) continue;
      const strength = this.strengthOf(j);
      const taut = j.kind !== 'rope' || (!j.a.loose && !j.b.loose && dist(e.a, e.b) >= j.rope.lengthM - JOINT_TUNING.tautEps);
      out.push({ joint: j.id, a: e.a, b: e.b, lengthM: j.rope.lengthM, taut, strain: strength > 0 && Number.isFinite(strength) ? ringMax(j) / strength : 0 });
    }
    return out;
  }

  /** The world points of a joint's two ends (an entity anchor through its pose, a held end at the hand), or null. */
  endPoints(j: JointRecord): { a: V3; b: V3 } | null {
    const a = this.anchorPoint(j.a);
    const b = this.anchorPoint(j.b);
    return a && b ? { a, b } : null;
  }

  /** The rotation of the body a joint end is on (identity for a world point, a loose end or a hand). */
  private anchorRotation(a: Anchor): Quat {
    const e = a.entity !== null && a.fighter === undefined && !a.loose ? this.world.entities.get(a.entity) : undefined;
    return e ? copy3q(e.pose.q) : { x: 0, y: 0, z: 0, w: 1 };
  }

  /** A joint end's world point: an entity's local point, a world or loose point, or the hand holding it; null if gone. */
  anchorPoint(a: Anchor): V3 | null {
    if (a.fighter !== undefined) {
      const f = this.world.combat.fighters.find((x) => x.id === a.fighter);
      return f ? handOf(f) : null;
    }
    if (a.loose || a.entity === null) return copy3(a.local);
    const e = this.world.entities.get(a.entity);
    return e ? transform(e.pose, a.local) : null;
  }

  // -------------------------------------------------------------------------
  // Save records (§8.3)
  // -------------------------------------------------------------------------

  /** Id order, tension rings and pullN included. */
  toRecord(): JointRecV1[] {
    return this.sorted.map(recordOf);
  }

  /**
   * The loader's step after the entities (§8.3): REPLACES the store. The joints generation just made are dropped
   * without releasing anything (their Rapier joints and rope sensors go; no entity changes, no event), then every saved
   * joint is rebuilt with its saved id, in id order: its rope sensor posed, its Rapier joint made from the restored
   * bodies' poses. Entity joint lists come from the entities' own records (or generation, for untouched ones).
   */
  restoreRecord(r: JointRecV1[]): void {
    for (let i = 1; i < r.length; i++) {
      if (!(r[i].id > r[i - 1].id)) throw new Error('JointStore.restoreRecord: records must be in strictly increasing id order');
    }
    for (const j of this.sorted) this.dropRuntime(j.id);
    this.byId.clear();
    this.sorted.length = 0;
    this.snapshot = null;
    this.tripped = { tick: -1, keys: new Set() };
    r.forEach((rec, i) => {
      for (const an of [rec.a, rec.b]) {
        if (an.entity !== null && !this.world.entities.get(an.entity)) throw new Error(`save record: joints[${i}] names entity ${an.entity}, which isn't in the loaded world`);
      }
      if (rec.rope && !this.world.entities.get(rec.rope.entity)) throw new Error(`save record: joints[${i}] is made of entity ${rec.rope.entity}, which isn't in the loaded world`);
      if (rec.holdsBend !== null && !r.some((x) => x.id === rec.holdsBend)) throw new Error(`save record: joints[${i}] holds bend ${rec.holdsBend}, which isn't among the joints`);
      const j = fromRecord(rec);
      this.byId.set(j.id, j);
      this.sorted.push(j);
    });
    this.poseSensors();
  }

  // -------------------------------------------------------------------------
  // Internals: records and entity lists
  // -------------------------------------------------------------------------

  private make(
    kind: JointKind,
    a: Anchor,
    b: Anchor,
    rope: { entity: number; lengthM: number } | null,
    credit: readonly string[],
    o: {
      breakEnergyJ?: number;
      axis?: V3;
      limits?: [number, number] | null;
      motor?: { restAngle: number; stiffness: number; damping: number };
      holdsBend?: number;
    },
  ): number {
    const w = this.world;
    if (rope) {
      const re = w.entities.get(rope.entity);
      if (!re) throw new Error(`JointStore.${kind}: no rope entity ${rope.entity}`);
    }
    const id = w.ids.joint.take();
    const j: JointRecord = {
      id,
      kind,
      a: copyAnchor(a),
      b: copyAnchor(b),
      rope: rope ? { entity: rope.entity, lengthM: rope.lengthM } : null,
      breakEnergyJ: o.breakEnergyJ ?? Infinity,
      axis: o.axis ? copy3(o.axis) : null,
      limits: o.limits ?? null,
      motor: o.motor ? { ...o.motor } : null,
      holdsBend: o.holdsBend ?? null,
      tension: [0, 0, 0],
      pullN: 0,
      credit: normCredit(credit),
    };
    this.byId.set(id, j);
    this.sorted.push(j);
    this.snapshot = null;
    for (const an of [j.a, j.b]) if (an.entity !== null) this.link(an.entity, id);
    if (rope) {
      this.link(rope.entity, id);
      const re = w.entities.get(rope.entity)!;
      if (re.state !== 'tied') w.entities.setState(re, 'tied');
    }
    const rt = this.runtime(j);
    this.syncRapier(j, rt);
    if (rt.sensor) this.poseSensor(j, rt.sensor);
    return id;
  }

  /** Drops the record (runtime, maps, entity lists), with no event and no coil. */
  private forget(j: JointRecord): void {
    this.dropRuntime(j.id);
    this.byId.delete(j.id);
    const i = this.sorted.indexOf(j);
    if (i >= 0) this.sorted.splice(i, 1);
    this.snapshot = null;
    for (const an of [j.a, j.b]) if (an.entity !== null) this.unlinkIfUnused(an.entity, j);
    if (j.rope) this.unlinkIfUnused(j.rope.entity, j);
  }

  /**
   * A holding rope that lost an end (loose, or taken in hand): the bend it kept is released (`release` event at the
   * rope's middle, as when the rope is cut), so its motor springs the sapling back and settleBends can root it again.
   */
  private releaseBend(j: JointRecord): void {
    if (j.holdsBend === null) return;
    const bend = j.holdsBend;
    j.holdsBend = null;
    if (this.byId.has(bend)) this.world.events.push({ type: 'joint', joint: bend, what: 'release', point: this.midpoint(j) });
  }

  /** After a joint is gone: a held bend released, a bend's holding rope freed, the rope coiled once unused. */
  private afterRemoved(j: JointRecord, point: V3): void {
    if (j.holdsBend !== null && this.byId.has(j.holdsBend)) {
      this.world.events.push({ type: 'joint', joint: j.holdsBend, what: 'release', point });
    }
    if (j.kind === 'bend') for (const o of this.sorted) if (o.holdsBend === j.id) o.holdsBend = null;
    if (j.rope) this.coilIfUnused(j.rope.entity, point);
  }

  /** A rope entity no joint is made of any more lies as a coil on the ground under `at`. */
  private coilIfUnused(ropeId: number, at: V3): void {
    const w = this.world;
    const e = w.entities.get(ropeId);
    if (!e || e.state !== 'tied') return;
    for (const j of this.sorted) if (j.rope?.entity === ropeId) return;
    const shape = ropeCoilShape(e.rope?.lengthM ?? 1);
    e.shape = shape;
    e.pose = { p: { x: at.x, y: w.terrain.heightAt(at.x, at.z) + shape.halfHeight, z: at.z }, q: { x: 0, y: 0, z: 0, w: 1 } };
    e.vel = { lin: { x: 0, y: 0, z: 0 }, ang: { x: 0, y: 0, z: 0 } };
    w.entities.setState(e, 'free');
  }

  /** Replaces one end of a joint, keeping the entities' joint lists and the Rapier joint in step. */
  private setEnd(j: JointRecord, end: 'a' | 'b', an: Anchor): void {
    const old = j[end];
    j[end] = an;
    if (old.entity !== null && old.entity !== an.entity) this.unlinkIfUnused(old.entity, j);
    if (an.entity !== null) this.link(an.entity, j.id);
    this.markStale(j);
  }

  private link(entity: number, joint: number): void {
    const e = this.world.entities.get(entity);
    if (!e || e.joints.includes(joint)) return;
    e.joints = [...e.joints, joint].sort((x, y) => x - y);
    e.touched = true;
  }

  /** Takes `j` off the entity's list unless the entity still is one of its ends or its rope. */
  private unlinkIfUnused(entity: number, j: JointRecord): void {
    const e = this.world.entities.get(entity);
    if (!e || !e.joints.includes(j.id)) return;
    if (this.byId.get(j.id) === j && (j.a.entity === entity || j.b.entity === entity || j.rope?.entity === entity)) return;
    e.joints = e.joints.filter((x) => x !== j.id);
    e.touched = true;
  }

  private need(id: number, what: string): JointRecord {
    const j = this.byId.get(id);
    if (!j) throw new Error(`JointStore.${what}: no joint ${id}`);
    return j;
  }

  private checkEnds(what: string, a: Anchor, b: Anchor): void {
    this.checkAnchor(what, a);
    this.checkAnchor(what, b);
  }

  private checkAnchor(what: string, a: Anchor): void {
    if (!finite3(a.local)) throw new Error(`JointStore.${what}: a non-finite anchor point`);
    if (a.entity !== null && !this.world.entities.get(a.entity)) throw new Error(`JointStore.${what}: no entity ${a.entity}`);
  }

  /** D-18: ropeKN × 1000 × strands × lashLeverM of the rope it is made of (one strand). */
  private lashEnergy(ropeEntity: number): number {
    const e = this.world.entities.get(ropeEntity);
    if (!e) throw new Error(`JointStore: no rope entity ${ropeEntity}`);
    return lashBreakEnergyJ(MATERIALS[e.material], 1, JOINT_TUNING.lashLeverM);
  }

  /** One strand's strength, N (the rope entity's material); Infinity for a joint made of no rope. */
  private strengthOf(j: JointRecord): number {
    if (!j.rope) return Infinity;
    const e = this.world.entities.get(j.rope.entity);
    return e ? ropeStrengthN(MATERIALS[e.material]) : Infinity;
  }

  private midpoint(j: JointRecord): V3 {
    const pa = this.anchorPoint(j.a) ?? copy3(j.a.local);
    const pb = this.anchorPoint(j.b) ?? copy3(j.b.local);
    return scale(add(pa, pb), 0.5);
  }

  private endDistance(j: JointRecord): number | null {
    const e = this.endPoints(j);
    return e ? dist(e.a, e.b) : null;
  }

  private markStale(j: JointRecord): void {
    const rt = this.rt.get(j.id);
    if (rt) rt.stale = true;
  }

  // -------------------------------------------------------------------------
  // Internals: Rapier joints and sensors
  // -------------------------------------------------------------------------

  private runtime(j: JointRecord): JointRuntime {
    let rt = this.rt.get(j.id);
    if (!rt) {
      rt = { joint: null, bodyA: null, bodyB: null, madeLength: 0, ground: null, groundAt: null, sensor: null, stale: false, pullFresh: false, cinchHauled: false };
      this.rt.set(j.id, rt);
      if (j.rope) rt.sensor = this.makeSensor(j);
    }
    return rt;
  }

  private dropRuntime(id: number): void {
    const rt = this.rt.get(id);
    if (!rt) return;
    const phys = this.world.physics;
    this.dropRapier(rt);
    if (rt.ground) phys.rapier.removeRigidBody(rt.ground);
    rt.ground = null;
    if (rt.sensor) {
      phys.unregister(rt.sensor);
      phys.rapier.removeCollider(rt.sensor, false);
      rt.sensor = null;
    }
    this.rt.delete(id);
  }

  private dropRapier(rt: JointRuntime): void {
    if (rt.joint && rt.joint.isValid()) this.world.physics.rapier.removeImpulseJoint(rt.joint, true);
    rt.joint = null;
    rt.bodyA = null;
    rt.bodyB = null;
  }

  /** Whether the joint wants a Rapier joint now (§2.4), and between which ends. */
  private wantsRapier(j: JointRecord): boolean {
    if (isFree(j.a) || isFree(j.b)) return false;
    // A tie still cinching: the haul holds its load, not a rigid rope (tieHeldEnd).
    if (j.kind === 'rope' && j.pullN > 0) return false;
    if (j.a.entity === null && j.b.entity === null) return false;
    return true;
  }

  /** An end's body and pose, or null when it has none (stowed, tied, gone). */
  private endInfo(rt: JointRuntime, an: Anchor): EndInfo | null {
    if (an.entity === null) {
      const at = an.local;
      if (!rt.ground || !rt.groundAt || !same3(rt.groundAt, at)) {
        if (rt.ground) this.world.physics.rapier.removeRigidBody(rt.ground);
        rt.ground = this.world.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
        rt.groundAt = copy3(at);
        rt.stale = true;
      }
      return { body: rt.ground, pose: { p: copy3(at), q: { x: 0, y: 0, z: 0, w: 1 } }, local: { x: 0, y: 0, z: 0 } };
    }
    const e = this.world.entities.get(an.entity);
    if (!e || !e.body) return null;
    return { body: e.body, pose: e.pose, local: an.local };
  }

  /** Makes the Rapier joint again when it should exist and its bodies (or length, or anchors) changed; drops it otherwise. */
  private syncRapier(j: JointRecord, rt: JointRuntime): void {
    if (!this.wantsRapier(j)) {
      this.dropRapier(rt);
      if (rt.ground) {
        this.world.physics.rapier.removeRigidBody(rt.ground);
        rt.ground = null;
        rt.groundAt = null;
      }
      rt.stale = false;
      return;
    }
    const A = this.endInfo(rt, j.a);
    const B = this.endInfo(rt, j.b);
    if (!A || !B || !A.body || !B.body || A.body === B.body) {
      this.dropRapier(rt);
      rt.stale = false;
      return;
    }
    const length = j.rope?.lengthM ?? 0;
    if (rt.joint && rt.joint.isValid() && !rt.stale && rt.bodyA === A.body && rt.bodyB === B.body && (j.kind !== 'rope' || rt.madeLength === length)) return;
    this.dropRapier(rt);
    rt.stale = false;
    const rapier = this.world.physics.rapier;
    let data: RAPIER.JointData;
    switch (j.kind) {
      case 'lash': {
        const aw = transform(A.pose, A.local);
        data = RAPIER.JointData.fixed(A.local, conj(A.pose.q), toLocal(B.pose, aw), conj(B.pose.q));
        break;
      }
      case 'hinge': {
        const aw = transform(A.pose, A.local);
        const axis = j.axis ?? { x: 1, y: 0, z: 0 };
        data = RAPIER.JointData.revoluteWithAxes(A.local, toLocal(B.pose, aw), axis, rotate(conj(B.pose.q), rotate(A.pose.q, axis)));
        break;
      }
      case 'rope':
        data = RAPIER.JointData.rope(length, A.local, B.local);
        break;
      case 'bend': {
        const axis = j.axis ?? { x: 1, y: 0, z: 0 };
        data = RAPIER.JointData.revoluteWithAxes(A.local, B.local, axis, rotate(conj(B.pose.q), rotate(A.pose.q, axis)));
        break;
      }
    }
    const joint = rapier.createImpulseJoint(data, A.body, B.body, true);
    if (j.kind === 'lash' || j.kind === 'hinge') joint.setContactsEnabled(false);
    if (j.kind === 'hinge' && j.limits) (joint as RAPIER.RevoluteImpulseJoint).setLimits(j.limits[0], j.limits[1]);
    if (j.kind === 'bend' && j.motor) {
      const r = joint as RAPIER.RevoluteImpulseJoint;
      r.configureMotorModel(RAPIER.MotorModel.ForceBased);
      r.configureMotorPosition(j.motor.restAngle, j.motor.stiffness, j.motor.damping);
    }
    rt.joint = joint;
    rt.bodyA = A.body;
    rt.bodyB = B.body;
    rt.madeLength = length;
  }

  /** A parentless sensor capsule (ROPE group) for a joint made of a rope; posed by poseSensor. */
  private makeSensor(j: JointRecord): RAPIER.Collider {
    const phys = this.world.physics;
    const c = phys.rapier.createCollider(
      RAPIER.ColliderDesc.capsule(GEOM_EPS, JOINT_TUNING.ropeSensorR)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ROPE'))
        .setSolverGroups(solverGroups('ROPE')),
    );
    const owner: Owner = { kind: 'rope', joint: j.id };
    phys.register(c, owner);
    phys.resetHistory(ownerKey(owner));
    return c;
  }

  /** The sensor between the anchors' current world points (a capsule along local +Y). */
  private poseSensor(j: JointRecord, c: RAPIER.Collider): void {
    const e = this.endPoints(j);
    if (!e) return;
    const d = sub(e.b, e.a);
    const l = norm(d);
    c.setTranslation(scale(add(e.a, e.b), 0.5));
    c.setRotation(l > 0 ? arcFromY(scale(d, 1 / l)) : { x: 0, y: 0, z: 0, w: 1 });
    c.setHalfHeight(Math.max(GEOM_EPS, l / 2));
  }

  // -------------------------------------------------------------------------
  // Internals: the haul model, tripwires, the fit, bends
  // -------------------------------------------------------------------------

  /**
   * The haul model's tick for a rope pulled from `hand` (a held end's hand, or a cinching tie's point): the slack reeled
   * in (at most pullHandSpeedMps × DT), then, once within haulTautM of the free length, the haul on `other`; the free
   * length never grows.
   */
  private reelAndHaul(j: JointRecord, other: Anchor, hand: V3): void {
    const A = this.anchorPoint(other);
    if (!A || !j.rope) return;
    const D = dist(hand, A);
    // Reeling in, then (the same tick) hauling once the slack is in (I-2: a haul skipped on reel-in ticks creeps).
    const r = reelIn(D, j.rope.lengthM);
    j.rope.lengthM = r.lengthM;
    const L = r.lengthM;
    if (!r.taut) return;
    const u = scale(sub(hand, A), 1 / D);
    this.haul(j, other, A, u);
    j.rope.lengthM = Math.min(L, D);
  }

  /**
   * A tie that can cinch (tieHeldEnd): a rope with both ends attached, one on a static anchor (a world point, or an
   * entity whose body isn't dynamic) and the other on an enabled dynamic body: that load end, its body, its world point,
   * the tie point, u (unit from the load point toward the tie point) and their distance. `live`: the load's point from
   * its body's pose now (phase 10, after the step), not the record's. null otherwise.
   */
  private cinchOf(j: JointRecord, live: boolean): { load: 'a' | 'b'; e: Entity; at: V3; target: V3; u: V3; D: number } | null {
    if (j.kind !== 'rope' || !j.rope || isFree(j.a) || isFree(j.b)) return null;
    const sa = this.endKind(j.a);
    const sb = this.endKind(j.b);
    const load = sa === 'static' && sb === 'dynamic' ? 'b' : sb === 'static' && sa === 'dynamic' ? 'a' : null;
    if (!load) return null;
    const an = j[load];
    const e = this.world.entities.get(an.entity!)!;
    const b = e.body!;
    const at = live ? transform({ p: copy3(b.translation()), q: copy3q(b.rotation()) }, an.local) : this.anchorPoint(an);
    const target = this.anchorPoint(load === 'a' ? j.b : j.a);
    if (!at || !target) return null;
    const D = dist(at, target);
    if (!(D > 0)) return null;
    return { load, e, at, target, u: scale(sub(target, at), 1 / D), D };
  }

  /** An attached end's kind for a cinch: 'static' (a world point, a body that isn't dynamic), 'dynamic', or null (no body). */
  private endKind(an: Anchor): 'static' | 'dynamic' | null {
    if (an.entity === null) return 'static';
    const e = this.world.entities.get(an.entity);
    const b = e?.body;
    if (!e || !b || !b.isEnabled()) return null;
    return b.isDynamic() && !this.world.entities.isAnchored(e) ? 'dynamic' : 'static';
  }

  /**
   * The speed of entity e's point `at` along u (m/s, + toward the tie point): 'now' from its body, 'post' from the
   * phase-8 snapshot, 'pre' from the phase-5 store (after this tick's 4d impulses), 'mirror' from its record (the
   * velocity the last tick ended with, before this tick's 4d). NaN when that state isn't stored (an asleep body).
   */
  private speedAlong(e: Entity, at: V3, u: V3, src: 'now' | 'post' | 'pre' | 'mirror'): number {
    const b = e.body;
    if (!b) return Number.NaN;
    const key = ownerKey({ kind: 'entity', id: e.id });
    const pre = this.world.physics.pre(key);
    let v: V3;
    let om: V3;
    let com: V3;
    if (src === 'now') {
      v = copy3(b.linvel());
      om = copy3(b.angvel());
      com = copy3(b.worldCom());
    } else if (src === 'post') {
      const post = this.world.physics.post(key);
      if (!post) return Number.NaN;
      v = post.v;
      om = post.w;
      com = copy3(b.worldCom());
    } else if (src === 'pre') {
      if (!pre) return Number.NaN;
      v = pre.v;
      om = pre.w;
      com = pre.com;
    } else {
      v = e.vel.lin;
      om = e.vel.ang;
      com = pre ? pre.com : copy3(b.worldCom());
    }
    return dot(add(v, cross(om, sub(at, com))), u);
  }

  /**
   * Phase 10, a cinching tie (tieHeldEnd): done when its load stopped along the rope this tick (the speed along it
   * changed sign since the tick began, or is at most tieStillMps), or the rope ran out; it is then tied at the distance
   * the step left (its Rapier rope made in the next 4e, between bodies that haven't moved since).
   */
  private settleCinch(j: JointRecord): void {
    const c = this.cinchOf(j, true);
    if (!c || !j.rope) {
      j.pullN = 0;
      this.markStale(j);
      return;
    }
    const v2 = this.speedAlong(c.e, c.at, c.u, 'post');
    const v1 = this.speedAlong(c.e, c.at, c.u, 'pre');
    const v0 = this.speedAlong(c.e, c.at, c.u, 'mirror');
    const turned = (x: number): boolean => Number.isFinite(x) && x * v2 <= 0;
    const full = this.world.entities.get(j.rope.entity)?.rope?.lengthM ?? Infinity;
    const stopped = !(Math.abs(v2) > JOINT_TUNING.tieStillMps) || turned(v0) || turned(v1);
    if (!stopped && c.D < full) return;
    j.rope.lengthM = Math.max(Math.min(c.D, full), JOINT_TUNING.tautEps);
    j.pullN = 0;
    this.markStale(j);
  }

  /** One tick's haul on the attached end `other` at A along u (unit, toward the hand). */
  private haul(j: JointRecord, other: Anchor, A: V3, u: V3): void {
    const w = this.world;
    const V = VERB_TUNING;
    if (other.entity === null) return;
    const e = w.entities.get(other.entity);
    if (!e) return;
    const b = e.body;
    if (b && b.isEnabled() && b.isDynamic() && !w.entities.isAnchored(e)) {
      const lv = b.linvel();
      const av = b.angvel();
      const com = b.worldCom();
      const va = dot(add(copy3(lv), cross(copy3(av), sub(A, copy3(com)))), u);
      const F = j.pullN * clamp01((V.pullHandSpeedMps - va) / V.haulRampMps);
      // P28: a hauled rope's pull is a sustained force (EntityStore.queueForce).
      if (F > 0) w.entities.queueForce(e.id, scale(u, F), A);
      return;
    }
    if (e.plant?.phase === 'notched') {
      const hinge = w.felling.hingeOf(e.id);
      if (hinge) w.felling.addMoment(e.id, dot(cross(sub(A, hinge.point), scale(u, j.pullN)), hinge.axis));
      return;
    }
    if (e.state === 'anchored' && e.anchor && j.pullN > e.anchor.capacityN) {
      const lift = knockLoose(w, e);
      w.entities.queueImpulse(e.id, scale(u, j.pullN * DT), { x: A.x, y: A.y + lift, z: A.z });
    }
  }

  /** Whether a crossing fighter is exempt from this rope's tripwire (RT-5). */
  private exempt(w: World, f: Fighter, j: JointRecord): boolean {
    if (j.a.fighter === f.id || j.b.fighter === f.id) return true;
    const h = f.inventory?.hands;
    if (h && (h.joint === j.id || h.entity === j.rope?.entity)) return true;
    const target = w.verbs.workTarget(f) ?? (f.state === 'attack' ? w.verbs.focusedEntity(f) : null);
    if (target === null) return false;
    return target === j.rope?.entity || target === j.a.entity || target === j.b.entity;
  }

  /** A crossing creature's root velocity: standing, f.vel + f.walkVel; a slab or a tripped ruler, its body's (phase 5). */
  private rootVelocity(w: World, f: Fighter, by: Extract<Owner, { kind: 'fighter' }>): V3 {
    if (by.part === 'slab' || (by.part === 'ruler' && f.state === 'tripped')) {
      const pre = w.physics.pre(ownerKey(by));
      if (pre) return copy3(pre.v);
    }
    return { x: f.vel.x + f.walkVel.x, y: f.vel.y + f.walkVel.y, z: f.vel.z + f.walkVel.z };
  }

  /** The rope joints sharing `j`'s two anchor points (its strands), `j` first if alone, in id order. */
  private strandsOf(j: JointRecord, ends: { a: V3; b: V3 }): JointRecord[] {
    const out: JointRecord[] = [];
    for (const o of this.sorted) {
      if (o.kind !== 'rope' || !o.rope) continue;
      if (o === j) {
        out.push(o);
        continue;
      }
      const e = this.endPoints(o);
      if (e && sameEnds(j, ends, o, e)) out.push(o);
    }
    return out;
  }

  /** Union of taut rope joints with the same two anchor points; groups in order of their lowest id. */
  private groupStrands(taut: readonly JointRecord[], ends: ReadonlyMap<number, { a: V3; b: V3 } | null>): StrandGroup[] {
    const parent = taut.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let i = 0; i < taut.length; i++) {
      for (let k = i + 1; k < taut.length; k++) {
        if (sameEnds(taut[i], ends.get(taut[i].id)!, taut[k], ends.get(taut[k].id)!)) {
          const ri = find(i);
          const rk = find(k);
          if (ri !== rk) parent[Math.max(ri, rk)] = Math.min(ri, rk);
        }
      }
    }
    const byRoot = new Map<number, JointRecord[]>();
    taut.forEach((j, i) => {
      const r = find(i);
      let l = byRoot.get(r);
      if (!l) byRoot.set(r, (l = []));
      l.push(j);
    });
    return [...byRoot.keys()].sort((x, y) => x - y).map((r) => ({ joints: byRoot.get(r)!, rep: byRoot.get(r)![0] }));
  }

  /** The tension fit on one dynamic body (§4.9): one non-negative unknown per strand group, N. */
  private fit(w: World, e: Entity, b: RAPIER.RigidBody, groups: readonly StrandGroup[], ends: ReadonlyMap<number, { a: V3; b: V3 } | null>): number[] {
    const key = ownerKey({ kind: 'entity', id: e.id });
    const pre = w.physics.pre(key);
    const post = w.physics.post(key);
    const zero = { x: 0, y: 0, z: 0 };
    const acc = pre && post ? scale(sub(post.v, pre.v), 1 / DT) : zero;
    const alpha = pre && post ? scale(sub(post.w, pre.w), 1 / DT) : zero;
    const omega = post ? copy3(post.w) : zero;
    const m = b.mass();
    const com = copy3(b.worldCom());
    const q = copy3q(b.rotation());
    const frame = qmul(q, copy3q(b.principalInertiaLocalFrame()));
    const I = copy3(b.principalInertia());
    const Iw = (v: V3): V3 => {
      const l = rotate(conj(frame), v);
      return rotate(frame, { x: I.x * l.x, y: I.y * l.y, z: I.z * l.z });
    };
    const ax = principalAxis(e.shape);
    const L = Math.max((ax.max - ax.min) / 2, ax.crossHalf) || 1;
    const g = { x: 0, y: WORLD_TUNING.gravityY, z: 0 };
    const F = scale(sub(acc, g), m);
    const tau = scale(add(Iw(alpha), cross(omega, Iw(omega))), 1 / L);
    const cols: number[][] = [];
    for (const gr of groups) {
      const pts = ends.get(gr.rep.id)!;
      const onA = gr.rep.a.entity === e.id && gr.rep.a.fighter === undefined;
      const pB = onA ? pts.a : pts.b;
      const pO = onA ? pts.b : pts.a;
      const u = normalize(sub(pO, pB));
      const t = scale(cross(sub(pB, com), u), 1 / L);
      cols.push([u.x, u.y, u.z, t.x, t.y, t.z]);
    }
    const x = nnls(cols, [F.x, F.y, F.z, tau.x, tau.y, tau.z], Math.round(JOINT_TUNING.nnlsIterPerGroup * cols.length + JOINT_TUNING.nnlsIterBase));
    return x.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  }

  /**
   * Released bends: a bend joint no rope holds lets its motor spring the sapling back; once the sapling rests within
   * bendSettleDeg of upright it is rooted again (the joint dropped, upright, fixed, `plant.phase 'standing'`).
   */
  private settleBends(w: World): void {
    for (const j of [...this.sorted]) {
      if (j.kind !== 'bend' || j.a.entity === null) continue;
      if (this.sorted.some((o) => o.holdsBend === j.id)) continue;
      const s = w.entities.get(j.a.entity);
      const b = s?.body;
      if (!s || !b || !s.plant || s.plant.phase !== 'bent') continue;
      const ax = principalAxis(s.shape);
      const upNow = rotate(copy3q(b.rotation()), ax.dir);
      const tilt = Math.acos(Math.max(-1, Math.min(1, dot(upNow, UP))));
      if (tilt > (JOINT_TUNING.bendSettleDeg * Math.PI) / 180) continue;
      // Still for this tick (its motor holds a fraction of a degree of tremble, so the rest count never fills).
      const speed = b.isSleeping() ? 0 : norm(copy3(b.linvel())) + norm(copy3(b.angvel())) * (ax.max - ax.min);
      if (!(speed < PHYSICS_TUNING.restSpeed)) continue;
      // Upright about its pivot again: the joint's anchor on the sapling back over the pivot point.
      const pivot = j.b.local;
      const upright = { x: 0, y: 0, z: 0, w: 1 };
      const p = sub(pivot, rotate(upright, j.a.local));
      this.forget(j);
      w.entities.setPose(s, { p, q: upright });
      w.entities.setState(s, 'fixed');
      s.plant.phase = 'standing';
      s.touched = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Rapier's revolute reference
// ---------------------------------------------------------------------------

/**
 * The frame Rapier builds for a revolute's local axis (`set_local_axis1/2`): the shortest rotation taking +x to it
 * (nalgebra's rotation_between_axis), a half turn about y when it points along −x.
 */
function axisFrame(axis: V3): Quat {
  const n = normalize(axis);
  // x × n = (0, −n.z, n.y)
  const s = Math.hypot(n.z, n.y);
  if (s > GEOM_EPS) return axisAngle({ x: 0, y: -n.z / s, z: n.y / s }, Math.acos(Math.max(-1, Math.min(1, n.x))));
  return n.x < 0 ? { x: 0, y: 1, z: 0, w: 0 } : { x: 0, y: 0, z: 0, w: 1 };
}

/**
 * The angle Rapier's revolute (JointData.revoluteWithAxes) reads between bodies at rotations qa and qb with the joint's
 * local axes axisA and axisB: twice the x part of (qa·Fa)⁻¹(qb·Fb) taken with w ≥ 0, as its limit test reads it; rad.
 */
export function revoluteAngle(qa: Quat, axisA: V3, qb: Quat, axisB: V3): number {
  const r = qmul(conj(qmul(qa, axisFrame(axisA))), qmul(qb, axisFrame(axisB)));
  const sx = r.w < 0 ? -r.x : r.x;
  return 2 * Math.asin(Math.max(-1, Math.min(1, sx)));
}

/** Limits in (−π, π]: moved a whole turn when the range crosses ±π and fits on the other side, else clamped. */
function wrapLimits(lo: number, hi: number): [number, number] {
  const turn = 2 * Math.PI;
  let a = lo;
  let b = hi;
  while (b > Math.PI && a - turn >= -Math.PI) {
    a -= turn;
    b -= turn;
  }
  while (a < -Math.PI && b + turn <= Math.PI) {
    a += turn;
    b += turn;
  }
  return [Math.max(-Math.PI, a), Math.min(Math.PI, b)];
}

// ---------------------------------------------------------------------------
// The haul model's reel-in (§4.9)
// ---------------------------------------------------------------------------

/**
 * One tick of the haul model's reel-in, pure (§4.9): a hand `handDist` m from the far anchor and a free length `lengthM`.
 * The free length after it (shortened toward the hand's distance by at most pullHandSpeedMps × DT when the rope is
 * slack by more than tautEps; it never grows), and whether the hand hauls this tick (the hand within haulTautM of that
 * free length). JointStore's haul and the Pull verb's yank count (verbs/pull.ts) both ask it, so they agree.
 */
export function reelIn(handDist: number, lengthM: number): { lengthM: number; taut: boolean } {
  const V = VERB_TUNING;
  const L = handDist < lengthM - JOINT_TUNING.tautEps ? Math.max(handDist, lengthM - V.pullHandSpeedMps * DT) : lengthM;
  return { lengthM: L, taut: handDist > 0 && !(handDist < L - V.haulTautM) };
}

// ---------------------------------------------------------------------------
// The bend angle (§5.9)
// ---------------------------------------------------------------------------

/** How a rooted sapling bends toward a hold point (bendAngle): the angle and what it is made of. */
export interface BendPose {
  /** The angle it is bent to, rad: the smallest of reachTheta, forceTheta and 90°, never below 0. */
  theta: number;
  /** The angle that brings its top nearest the hold point (its top's arc meets the line from the pivot to it), rad. */
  reachTheta: number;
  /** The angle at which the rope at its top holds VERB_TUNING.bendMaxForceN (k θ / L), rad. */
  forceTheta: number;
  /** Whether theta is the force's limit (§5.9: "bends only as far as 500 N allows", refused `tooStiff` under 20°). */
  forceLimited: boolean;
  /** The pivot (world): the edge of its base on the side it bends toward. */
  pivot: V3;
  /** The bend axis (world, horizontal, unit): a positive rotation about it tips the top toward the hold point. */
  axis: V3;
  /** The bend motor's stiffness k = bendK × springiness × d² (N·m/rad) and damping (N·m·s/rad). */
  stiffness: number;
  damping: number;
}

/**
 * The bend a rooted sapling takes toward the world point `holdAt`, its top at `topLocal` (its own frame): the angle
 * that brings the top nearest the hold point, capped by the force the rope may hold at its top (VERB_TUNING.bendMaxForceN
 * = k θ / L, L the sapling's length) and by 90°. Pure (reads the entity and the tuning): JointStore.bend poses the sapling
 * with it, and the Bend verb (§5.9, P16) asks it first, to refuse `tooStiff` under its minimum angle. null when the
 * hold point is straight above or below the base.
 */
export function bendAngle(sapling: Entity, topLocal: V3, holdAt: V3): BendPose | null {
  const d = sapling.plant?.diameter ?? 0;
  const mat = MATERIALS[sapling.material];
  const k = JOINT_TUNING.bendK * mat.springiness * d * d;
  const damping = JOINT_TUNING.bendDamping * d * d;
  const ax = principalAxis(sapling.shape);
  const length = ax.max - ax.min;
  // The base pivot: the edge of the base on the side it bends toward, so the base rolls up off the ground rather than
  // into it.
  const base = transform(sapling.pose, scale(ax.dir, ax.min));
  const toward = { x: holdAt.x - base.x, y: 0, z: holdAt.z - base.z };
  const th = norm(toward);
  if (!(th > 0) || !Number.isFinite(th)) return null;
  const dir = scale(toward, 1 / th);
  const pivot = add(base, scale(dir, d / 2));
  const axis = normalize(cross(UP, dir));
  const r0 = sub(transform(sapling.pose, topLocal), pivot);
  const toHold = sub(holdAt, pivot);
  const aTop = Math.atan2(dot(cross(UP, r0), axis), dot(r0, UP));
  const aHold = Math.atan2(dot(cross(UP, toHold), axis), dot(toHold, UP));
  const reachTheta = aHold - aTop;
  const forceTheta = k > 0 ? (VERB_TUNING.bendMaxForceN * length) / k : Math.PI / 2;
  const theta = Math.max(0, Math.min(reachTheta, forceTheta, Math.PI / 2));
  return { theta, reachTheta, forceTheta, forceLimited: forceTheta < reachTheta && forceTheta < Math.PI / 2, pivot, axis, stiffness: k, damping };
}

// ---------------------------------------------------------------------------
// The non-negative least squares (Lawson-Hanson)
// ---------------------------------------------------------------------------

/**
 * min ‖A x − b‖ subject to x ≥ 0, A given by its columns (each of b's length), at most `maxIter` iterations (§4.9:
 * 3·n + 10, JOINT_TUNING.nnlsIterPerGroup and nnlsIterBase). Deterministic: ties go to the lowest column. Columns that are parallel share through the normal equations'
 * slight regularisation.
 */
export function nnls(cols: readonly (readonly number[])[], b: readonly number[], maxIter: number): number[] {
  const n = cols.length;
  const m = b.length;
  const x = new Array<number>(n).fill(0);
  if (n === 0) return x;
  const P = new Array<boolean>(n).fill(false);
  let scaleA = 0;
  for (const c of cols) for (const v of c) scaleA = Math.max(scaleA, Math.abs(v));
  let scaleB = 0;
  for (const v of b) scaleB = Math.max(scaleB, Math.abs(v));
  const tol = GEOM_EPS * Math.max(scaleA, GEOM_EPS) * Math.max(scaleB, GEOM_EPS) * m;
  const residual = (): number[] => {
    const r = b.slice();
    for (let k = 0; k < n; k++) if (x[k] !== 0) for (let i = 0; i < m; i++) r[i] -= cols[k][i] * x[k];
    return r;
  };
  let iter = 0;
  for (;;) {
    const r = residual();
    let jBest = -1;
    let wBest = tol;
    for (let k = 0; k < n; k++) {
      if (P[k]) continue;
      let wk = 0;
      for (let i = 0; i < m; i++) wk += cols[k][i] * r[i];
      if (wk > wBest) {
        wBest = wk;
        jBest = k;
      }
    }
    if (jBest < 0 || iter >= maxIter) break;
    P[jBest] = true;
    for (;;) {
      iter++;
      const z = leastSquares(cols, b, P);
      let ok = true;
      for (let k = 0; k < n; k++) if (P[k] && !(z[k] > 0)) ok = false;
      if (ok) {
        for (let k = 0; k < n; k++) x[k] = z[k];
        break;
      }
      let a = Infinity;
      for (let k = 0; k < n; k++) {
        if (!P[k] || z[k] > 0) continue;
        const den = x[k] - z[k];
        const ak = den > 0 ? x[k] / den : 0;
        if (ak < a) a = ak;
      }
      if (!Number.isFinite(a)) a = 0;
      for (let k = 0; k < n; k++) x[k] += a * (z[k] - x[k]);
      for (let k = 0; k < n; k++) {
        if (P[k] && !(x[k] > tol)) {
          P[k] = false;
          x[k] = 0;
        }
      }
      if (iter >= maxIter) break;
    }
    if (iter >= maxIter) break;
  }
  return x;
}

/** Least squares on the columns in P (zeros elsewhere), by the normal equations, slightly regularised, pivoted. */
function leastSquares(cols: readonly (readonly number[])[], b: readonly number[], P: readonly boolean[]): number[] {
  const idx: number[] = [];
  for (let k = 0; k < cols.length; k++) if (P[k]) idx.push(k);
  const p = idx.length;
  const M: number[][] = [];
  let trace = 0;
  for (let r = 0; r < p; r++) {
    const row: number[] = [];
    for (let c = 0; c < p; c++) {
      let s = 0;
      for (let i = 0; i < b.length; i++) s += cols[idx[r]][i] * cols[idx[c]][i];
      row.push(s);
    }
    let y = 0;
    for (let i = 0; i < b.length; i++) y += cols[idx[r]][i] * b[i];
    row.push(y);
    trace += row[r];
    M.push(row);
  }
  const lambda = (GEOM_EPS * trace) / Math.max(1, p);
  for (let r = 0; r < p; r++) M[r][r] += lambda;
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    if (!(Math.abs(d) > 0)) continue;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k];
    }
  }
  const z = new Array<number>(cols.length).fill(0);
  for (let r = 0; r < p; r++) z[idx[r]] = M[r][r] !== 0 ? M[r][p] / M[r][r] : 0;
  return z;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });

const isFree = (a: Anchor): boolean => a.fighter !== undefined || a.loose === true;

/**
 * P28 fix (§4.9: a tripwire is a rope whose both ends are attached, "not loose, not held"): whether an end entity of `j`
 * is held: in a fighter's hands (held or dragged) or hauled by a creature's tug. Before, only a rope end gripped itself
 * (an anchor on a fighter) counted, so the deadfall's bait, lashed to the prop and in the tugging ape's grip, made its
 * lash a tripwire the falling log crossed; a rope whose end is in someone's grip is pulled along, it trips nothing.
 */
function endEntityHeld(w: World, j: JointRecord): boolean {
  const a = j.a.entity;
  const b = j.b.entity;
  for (const f of w.combat.fighters) {
    const h = f.inventory?.hands?.entity ?? null;
    const t = w.verbs.tugTarget(f);
    for (const e of [h, t]) if (e !== null && (e === a || e === b)) return true;
  }
  return false;
}

/** The end a fighter's hand holds, or null. */
function heldEndOf(j: JointRecord): 'a' | 'b' | null {
  return j.a.fighter !== undefined ? 'a' : j.b.fighter !== undefined ? 'b' : null;
}

/** The largest of the last ropeBreakSteps tensions (SPEC:261). */
function ringMax(j: JointRecord): number {
  const n = Math.max(1, Math.min(j.tension.length, Math.round(JOINT_TUNING.ropeBreakSteps)));
  let m = 0;
  for (let i = j.tension.length - n; i < j.tension.length; i++) m = Math.max(m, j.tension[i]);
  return m;
}

/** Two joints join the same two points (each within strandMergeM), the same entities (or hands) at either end. */
function sameEnds(j: JointRecord, je: { a: V3; b: V3 }, o: JointRecord, oe: { a: V3; b: V3 }): boolean {
  const m = JOINT_TUNING.strandMergeM;
  const straight = endKey(j.a) === endKey(o.a) && endKey(j.b) === endKey(o.b) && dist(je.a, oe.a) <= m && dist(je.b, oe.b) <= m;
  const crossed = endKey(j.a) === endKey(o.b) && endKey(j.b) === endKey(o.a) && dist(je.a, oe.b) <= m && dist(je.b, oe.a) <= m;
  return straight || crossed;
}

function endKey(a: Anchor): string {
  if (a.fighter !== undefined) return `f${a.fighter}`;
  if (a.loose) return 'loose';
  return a.entity === null ? 'world' : `e${a.entity}`;
}

function fighterMap(w: World): Map<number, Fighter> {
  const m = new Map<number, Fighter>();
  for (const f of w.combat.fighters) m.set(f.id, f);
  return m;
}

const _hand = new Vector3();

/** The right hand (the rear fist, where a tool or a rope end is gripped), world (as verbs/targets.ts handPoint). */
function handOf(f: Fighter): V3 {
  const p = fistPoint(f.rig, 'R', _hand);
  return { x: p.x, y: p.y, z: p.z };
}

function nearestOnSegment(a: V3, b: V3, p: V3): V3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, t));
}

function normCredit(c: readonly string[]): string[] {
  return [...new Set(c)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function copyAnchor(a: Anchor): Anchor {
  const out: Anchor = { entity: a.entity, local: copy3(a.local) };
  if (a.fighter !== undefined) out.fighter = a.fighter;
  if (a.loose) out.loose = true;
  return out;
}

function copyOwner(o: Owner): Owner {
  switch (o.kind) {
    case 'terrain':
      return { kind: 'terrain' };
    case 'entity':
      return { kind: 'entity', id: o.id };
    case 'rope':
      return { kind: 'rope', joint: o.joint };
    case 'fighter':
      return o.bone === undefined ? { kind: 'fighter', id: o.id, part: o.part } : { kind: 'fighter', id: o.id, part: o.part, bone: o.bone };
  }
}

function recordOf(j: JointRecord): JointRecV1 {
  return {
    id: j.id,
    kind: j.kind,
    a: copyAnchor(j.a),
    b: copyAnchor(j.b),
    rope: j.rope ? { entity: j.rope.entity, lengthM: j.rope.lengthM } : null,
    breakEnergyJ: j.breakEnergyJ,
    axis: j.axis ? copy3(j.axis) : null,
    limits: j.limits ? [j.limits[0], j.limits[1]] : null,
    motor: j.motor ? { restAngle: j.motor.restAngle, stiffness: j.motor.stiffness, damping: j.motor.damping } : null,
    holdsBend: j.holdsBend,
    tension: [j.tension[0], j.tension[1], j.tension[2]],
    pullN: j.pullN,
    credit: [...j.credit],
  };
}

function fromRecord(r: JointRecV1): JointRecord {
  return {
    id: r.id,
    kind: r.kind,
    a: copyAnchor(r.a),
    b: copyAnchor(r.b),
    rope: r.rope ? { entity: r.rope.entity, lengthM: r.rope.lengthM } : null,
    breakEnergyJ: r.breakEnergyJ,
    axis: r.axis ? copy3(r.axis) : null,
    limits: r.limits ? [r.limits[0], r.limits[1]] : null,
    motor: r.motor ? { restAngle: r.motor.restAngle, stiffness: r.motor.stiffness, damping: r.motor.damping } : null,
    holdsBend: r.holdsBend,
    tension: [r.tension[0], r.tension[1], r.tension[2]],
    pullN: r.pullN,
    credit: [...r.credit],
  };
}

// Vectors and quaternions (plain records).

function copy3(v: { x: number; y: number; z: number }): V3 {
  return { x: v.x, y: v.y, z: v.z };
}

function copy3q(q: { x: number; y: number; z: number; w: number }): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function finite3(v: V3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function same3(a: V3, b: V3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function add(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: V3, k: number): V3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function norm(a: V3): number {
  return Math.hypot(a.x, a.y, a.z);
}

function dist(a: V3, b: V3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function normalize(a: V3): V3 {
  const n = norm(a);
  return n > 0 ? scale(a, 1 / n) : { x: 0, y: 0, z: 0 };
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function conj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function qmul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** v rotated by the unit quaternion q. */
function rotate(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function transform(p: Pose3, local: V3): V3 {
  return add(p.p, rotate(p.q, local));
}

function toLocal(p: Pose3, world: V3): V3 {
  return rotate(conj(p.q), sub(world, p.p));
}

function axisAngle(axis: V3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

/** The shortest rotation taking +Y to the unit vector d. */
function arcFromY(d: V3): Quat {
  const c = d.y;
  if (c < -1 + GEOM_EPS) return { x: 1, y: 0, z: 0, w: 0 };
  // (Y × d, 1 + Y·d), normalised.
  const x = d.z;
  const z = -d.x;
  const w = 1 + c;
  const n = Math.hypot(x, z, w);
  return { x: x / n, y: 0, z: z / n, w: w / n };
}
