// The contact pipeline (docs/M1-DESIGN.md §1.5.8, §3 phase 9, §4.3): new contacts from the sorted pairs, owners, the
// per-(creature, owner) touching counts and episodes, the cooldown and grace windows, normals, v_n, self-motion, m_eff,
// sharpness and hard landings, then dispatch: creatures to applyImpact (9b), entities to breaking and felling (9c), rope
// sensors to the tripwires (9d), thrown entities and heavy landings (9e).
//
// Episodes (RF-12, RT-16). Every collider of a fighter (standing zones, slab, ruler bones) is one owner, and so are an
// entity, a rope sensor and the whole terrain. Every `started` and `stopped` collider pair updates the touching count
// of its (owner, owner) group; an episode begins when the count goes 0 → 1 and ends when it returns to 0. A group is
// scored once, at its episode's first tick: of the pairs that start in that tick, each side takes its largest energy.
// A new episode within impactCooldownTicks of the last one's end is a bounce and is never scored; different owners
// are different episodes. One group serves both sides of a pair (the count is the same seen from either side), so a
// creature-creature contact is judged from each side with one shared episode; an entity's integrity uses the same rule
// per (entity, other owner). Within one tick the starts are counted before the stops, so a contact sliding from one
// bone to the next is one episode.
//
// Never scored (each a whole collider pair: neither side scores it, but it counts toward the episode): a fighter's
// pairs during its contact grace (RF-1); the zones of the attacking limb chain while a fighter is in 'attack' (RF-3,
// melee is CombatSim's); a fighter's colliders against the entity it holds, drags or tows by rope; an entity just
// released by a fighter against that fighter until they have been apart releaseApartTicks (RF-3); a fresh piece in its
// grace against fighters and its breaker (§4.10). KCC capsules are no damage colliders and are left out entirely; so
// are a fighter's pairs with itself.
//
// Geometry (§4.3, departure X4). Solid pairs: the contact manifolds (normal flipped into "out of the pair's first
// collider", points from the solver contacts or the manifold's local points). Sensor pairs (zones, ruler zones):
// Shape.castShape from the start-of-previous-step poses with the stored velocities over castWindowTicks; when it
// misses because they began overlapped, n = −v̂_rel. Velocities come from the phase-5 store: a body's v + ω × (p − com),
// a kinematic zone's carryV (the previous tick's rig delta, I1); a fixed or sleeping body is still.
//
// m_eff (§4.3's table) for creatures; an entity's own integrity reads the effective masses at the contact point
// (integrityMeff, the orchestrator's decision on P10's design conflict; departure recorded in world/damage.ts), and an
// entity landing on the ground is one contact over every terrain tile it meets in the tick (groundHit).
//
// Every impulse a contact causes (the reaction on a dynamic impactor) is queued on the entity store and applied in
// phase 4d of the next tick (RF-2): nothing here touches a Rapier body.
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { BONE_ZONE } from '../body/mass';
import { type BoneName, SKELETON } from '../body/skeleton';
import type { ContactRecV1 } from '../save/schema';
import type { HurtZone } from '../sim/combat';
import type { Fighter } from '../sim/fighter';
import { applyImpact, IMPACT_TUNING } from '../sim/impact';
import { DT } from '../sim/math';
import type { Limb } from '../sim/moves';
import { classifyRulerZone, rulerToughness } from '../sim/ruler';
import { boneMass, DAMAGE_TUNING, impactEnergy, zoneToughness } from '../sim/rules';
import { safeLandingSpeed } from './characters';
import { BREAK_TUNING } from './breaking';
import { breakEnergyJ, MATERIALS } from './materials';
import { contactEnergy, contactMeff, dot, impactDv, integrityMeff, len, leadingSharpness, type MeffSide, pointMass, rotate, selfMotion, sideMass } from './damage';
import { FELL_TUNING } from './felling';
import { compareOwners, type ContactPair, ownerKey, PHYSICS_TUNING } from './physics';
import { RULER_BODY_TUNING } from './rulerBody';
import type { CauseFeature, Entity, Impact, ImpactCause, Owner, Pose3, Quat, RulerZoneId, V3 } from './types';
import type { World } from './world';

/** Every collider of a fighter is one owner, every terrain tile is one (§4.3). */
type Merged = { kind: 'terrain' } | { kind: 'entity'; id: number } | { kind: 'fighter'; id: number } | { kind: 'rope'; joint: number };

/** One (owner, owner) group's touching count and episode marks (saved, RR-19). */
interface Episode {
  readonly a: Merged;
  readonly b: Merged;
  touching: number;
  /** The tick the current (or last) episode began; −1 none. */
  episodeStart: number;
  /** The last episode's end + impactCooldownTicks: a new episode up to this tick is a bounce; −1 none. */
  cooldownUntil: number;
}

/** Why a started pair or a new episode was not scored (the dev counter of the risk register, §13.4). */
export type UnscoredWhy = 'bounce' | 'grace' | 'limb' | 'held' | 'released' | 'piece' | 'brush' | 'continuing';

/**
 * What phase 9d hands the joint store (P10, §4.9): a new episode (not a bounce, outside the crosser's grace) between
 * rope sensor `joint` and `by`, a creature's collider or a dynamic entity. The tripwire rule (root momentum, the
 * exemptions, the load against the rope's strength, queued shares, the `tripwire` event) is the joint store's:
 * JointStore implements it (§1.5.7 gains the method), and phase 9d calls it plainly.
 */
export interface TripwireSink {
  tripwire(w: World, joint: number, by: Owner): void;
}

/** One side of a collider pair, read once per candidate. */
interface Side {
  readonly owner: Owner;
  readonly kind: 'terrain' | 'entity' | 'creature' | 'rope';
  readonly f: Fighter | null;
  readonly e: Entity | null;
  readonly bone: BoneName | null;
  readonly meff: MeffSide;
  /** Terrain, or a fixed or anchored entity (static for m_eff, D-19). */
  readonly isStatic: boolean;
  /** Velocity of this side's material at the contact point (m/s). */
  readonly v: V3;
  /** The entity's body pose at the contact (for its sharp points); null for others. */
  readonly pose: Pose3 | null;
}

/** A collider pair's contact geometry: the normal out of the pair's first collider (`a`), the point, each side's velocity there. */
interface Geom {
  n: V3;
  point: V3;
  va: V3;
  vb: V3;
  /** The entity bodies' poses at the contact (a's, b's), for sharp points. */
  poseA: Pose3;
  poseB: Pose3;
  /** How many contact points `point` is the mean of (a solid pair's manifold points; 1 otherwise). */
  points: number;
}

/** A collider's motion over the last two steps, from the phase-5 store. */
interface Motion {
  /** The collider's world pose at the start of this step, and at the start of the previous one. */
  pose: Pose3;
  prev: Pose3;
  /** The body's pose at the start of this step and of the previous one (the entity record's frame). */
  body: Pose3;
  bodyPrev: Pose3;
  /** Velocity of a material point (m/s). */
  vAt(p: V3): V3;
  /** Velocity of the collider's origin over the last step (the cast's). */
  vCentre: V3;
}

/** A scored hit on a creature, before applyImpact. */
interface CreatureHit {
  readonly impact: Impact;
  readonly impactor: Side;
  /** The impactor is a dynamic entity whose body takes the reaction. */
  readonly reactionEntity: number | null;
  /**
   * P28: scored only because the entity it met breaks in the same episode (a brush otherwise): its impact is applied and
   * recorded before the break (SPEC:344), but it trips nothing (the impact trip is a blow's, not the creature's own
   * motion's).
   */
  readonly brushBreak?: boolean;
}

/** A scored hit on an entity's integrity. */
interface EntityHit {
  readonly e: Entity;
  readonly energy: number;
  readonly point: V3;
  readonly breaker: Owner;
  /** Unit direction the impactor came at it (for a notched tree's moment). */
  readonly dir: V3 | null;
  /** The other side is the terrain or a static entity (a landing). */
  readonly landing: boolean;
}

/** A new episode, evaluated (no side effects yet). */
interface Fresh {
  readonly ep: Episode;
  readonly pairs: ContactPair[];
  bounce: boolean;
  creature: CreatureHit[];
  entity: EntityHit[];
  /** A creature landing on the terrain (slab, tripped ruler): its full energy, for a `land` event. */
  land: { f: Fighter; energy: number; point: V3 } | null;
  /** The first started pair of a rope episode that may load the tripwire. */
  rope: { joint: number; by: Owner } | null;
  /** A standing ruler's shin meeting an entity (RulerBodies.legStrike, 9b): the first such pair of the episode. */
  leg: { f: Fighter; e: Entity; point: V3; n: V3 } | null;
}

const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });
const LIMB_CHAIN: Readonly<Record<Limb, readonly BoneName[]>> = {
  handL: ['upperArmL', 'foreArmL'],
  handR: ['upperArmR', 'foreArmR'],
  footL: ['thighL', 'shinL'],
  footR: ['thighR', 'shinR'],
};

export class ContactSystem {
  readonly world: World;
  /** Running totals of started pairs and new episodes not scored, by reason (dev panel; never saved). */
  readonly unscored: Record<UnscoredWhy, number> = { bounce: 0, grace: 0, limb: 0, held: 0, released: 0, piece: 0, brush: 0, continuing: 0 };
  /** Running total of scored impacts on creatures (dev panel; never saved). */
  scored = 0;

  private readonly episodes = new Map<string, Episode>();
  /** Fighter id → the tick its contact grace ends (pairs starting before it are never scored). */
  private readonly graceUntil = new Map<number, number>();
  /**
   * The groups restoreRecord brought back touching, until the next process() re-syncs their counts with the rebuilt
   * narrow phase (see restoreRecord). Never saved: a save taken before that process() writes the restored counts, and
   * loading it marks them again.
   */
  private resync: Set<Episode> | null = null;
  /**
   * The starts the load's own narrow phase raised (restoredStarts), for the next process() to rebuild the restored counts
   * from. Never saved, for the same reason as `resync`: a load makes them again.
   */
  private restarts: readonly { a: Owner; b: Owner }[] | null = null;
  /**
   * The other starts of the load's zero-length step (restoredStarts): contacts the saved world didn't have (no group
   * restored touching), whose first step is the first step after the load. The saved world's next step would have raised
   * them; the loaded world's raises them no more (its narrow phase already has them), so the next process() takes them
   * as that step's own starts: new contacts, scored. Never saved: a load makes them again.
   */
  private loadStarts: ContactPair[] | null = null;

  constructor(world: World) {
    this.world = world;
  }

  /** Phase 9: the drained pairs, in their sorted order (§3 9a-9e). */
  process(w: World, pairs: readonly ContactPair[]): void {
    const tick = w.tick;
    for (const [id, until] of [...this.graceUntil]) if (until <= tick) this.graceUntil.delete(id);
    const fighters = new Map<number, Fighter>();
    for (const f of w.combat.fighters) fighters.set(f.id, f);
    const held = heldEntities(w);

    // 9a: counts. Starts first, then stops (a contact sliding from one collider to the next stays one episode).
    const fresh: Fresh[] = [];
    const freshByEp = new Map<Episode, Fresh>();
    const thrownHit = new Set<number>();
    const resync = this.resync;
    this.resync = null;
    const resynced = new Set<Episode>();
    const restarts = this.restarts;
    this.restarts = null;
    // The load's new contacts (loadStarts): this step's own starts, as the saved world's would have raised them.
    if (this.loadStarts) {
      pairs = this.withLoadStarts(w, pairs, this.loadStarts);
      this.loadStarts = null;
    }
    // The load's narrow-phase starts first (restoredStarts): they rebuild the restored episodes' counts, as the first
    // step's own re-raised starts do below. One for no restored episode is a contact the saved world already had (or
    // never counted): dropped, never a new episode.
    if (resync && restarts) {
      for (const p of restarts) {
        const ep = this.episodeOf(p.a, p.b, false);
        if (!ep || !resync.has(ep)) continue;
        if (!resynced.has(ep)) {
          resynced.add(ep);
          ep.touching = 0;
        }
        ep.touching++;
        this.unscored.continuing++;
      }
    }
    for (const p of pairs) {
      if (!p.started) continue;
      const ep = this.episodeOf(p.a, p.b, true);
      if (!ep) continue;
      if (resync?.has(ep)) {
        // The first step after a load: the rebuilt narrow phase re-raises a start for every pair of a restored episode
        // that still overlaps. They rebuild its count (never added to the saved one) and are that episode going on:
        // never a new episode, never scored, never a thrown entity's first contact.
        if (!resynced.has(ep)) {
          resynced.add(ep);
          ep.touching = 0;
        }
        ep.touching++;
        this.unscored.continuing++;
        continue;
      }
      if (ep.touching === 0) {
        ep.episodeStart = tick;
        const fr: Fresh = { ep, pairs: [], bounce: tick <= ep.cooldownUntil, creature: [], entity: [], land: null, rope: null, leg: null };
        fresh.push(fr);
        freshByEp.set(ep, fr);
      } else this.unscored.continuing++;
      ep.touching++;
      freshByEp.get(ep)?.pairs.push(p);
      this.noteThrown(p, thrownHit);
    }
    for (const p of pairs) {
      if (p.started) continue;
      const ep = this.episodeOf(p.a, p.b, false);
      if (!ep || ep.touching === 0) continue;
      ep.touching--;
      if (ep.touching === 0) ep.cooldownUntil = tick + DAMAGE_TUNING.impactCooldownTicks;
    }
    // A restored episode none of whose pairs was re-raised separated in that step: it ends here, as the stop the saved
    // world's next step raised would have ended it.
    if (resync) {
      for (const ep of resync) {
        if (resynced.has(ep) || ep.touching === 0) continue;
        ep.touching = 0;
        ep.cooldownUntil = tick + DAMAGE_TUNING.impactCooldownTicks;
      }
    }

    // Evaluate every new episode (read-only: velocities from the phase-5 store, poses, the rule).
    for (const fr of fresh) {
      if (fr.bounce) {
        this.unscored.bounce++;
        continue;
      }
      this.evaluate(w, fr, fighters, held, tick);
    }

    // 9b: creatures (HP, Δv, knockdown, launch, KO; rulers: wounds), reactions queued for the next 4d, impact trips;
    // then a standing ruler's shin striking an obstacle (§4.7 step 6 for the leg, before 9c can break what it struck).
    for (const fr of fresh) for (const h of fr.creature) this.applyCreatureHit(w, h);
    for (const fr of fresh) if (fr.leg) w.rulers.legStrike(fr.leg.f, fr.leg.e, fr.leg.point, fr.leg.n);
    // 9c: entities (integrity; a notched tree's fall-direction moment), after the creature damage (SPEC:344).
    for (const fr of fresh) for (const h of fr.entity) this.applyEntityHit(w, h);
    // 9d: rope sensors → tripwires (a plain call: a joint store without the method fails loudly, never silently).
    for (const fr of fresh) if (fr.rope) w.joints.tripwire(w, fr.rope.joint, fr.rope.by);
    // 9e: thrown entities stop being held at their first contact or at rest (D-31); `land` events for heavy landings.
    for (const e of w.entities.all()) {
      if (!e.thrown) continue;
      const resting = e.restTicks >= PHYSICS_TUNING.restTicks || (e.body?.isSleeping() ?? false);
      if (resting || thrownHit.has(e.id)) e.thrown = null;
    }
    for (const fr of fresh) {
      for (const h of fr.entity) {
        if (h.landing && h.energy >= IMPACT_TUNING.landMinJ) {
          w.events.push({ type: 'land', entity: h.e.id, f: null, point: { ...h.point }, energy: h.energy, mass: h.e.mass });
        }
      }
      if (fr.land && fr.land.energy >= IMPACT_TUNING.landMinJ) {
        w.events.push({ type: 'land', entity: null, f: fr.land.f, point: { ...fr.land.point }, energy: fr.land.energy, mass: fr.land.f.mass });
      }
    }

    // Released entities: scored against their releaser again once apart releaseApartTicks (RF-3).
    for (const e of w.entities.all()) {
      const r = e.releasedBy;
      if (!r) continue;
      const ep = this.episodes.get(groupKey({ kind: 'entity', id: e.id }, { kind: 'fighter', id: r.fighter }));
      r.apartTicks = ep && ep.touching > 0 ? 0 : r.apartTicks + 1;
      if (r.apartTicks >= IMPACT_TUNING.releaseApartTicks) e.releasedBy = null;
    }

    // Forget groups that touch nothing and whose cooldown has passed.
    for (const [k, ep] of [...this.episodes]) if (ep.touching === 0 && ep.cooldownUntil < tick) this.episodes.delete(k);
  }

  /** Pairs of that fighter starting before untilTick count as touching but are never scored (§4.3, RF-1). The later window wins. */
  grace(fighterId: number, untilTick: number): void {
    const now = this.graceUntil.get(fighterId);
    if (now === undefined || untilTick > now) this.graceUntil.set(fighterId, untilTick);
  }

  /** Whether a pair of the fighter starting at `tick` would be in its contact grace. */
  inGrace(fighterId: number, tick: number): boolean {
    const until = this.graceUntil.get(fighterId);
    return until !== undefined && tick < until;
  }

  /** The touching count of two owners (every collider of a fighter, the whole terrain, one each), 0 when none. */
  touching(a: Owner, b: Owner): number {
    const ma = merged(a);
    const mb = merged(b);
    if (!ma || !mb) return 0;
    return this.episodes.get(groupKey(ma, mb))?.touching ?? 0;
  }

  /**
   * The contact geometry the rule reads for a collider pair drained this tick (tests and the dev panel; valid during
   * phase 9, while the phase-5 store holds this tick's state): the normal out of `p.a`'s collider, the point, and each
   * side's velocity there (m/s).
   */
  geometryOf(p: ContactPair): { n: V3; point: V3; va: V3; vb: V3 } {
    const g = this.geometry(this.world, p);
    return { n: g.n, point: g.point, va: g.va, vb: g.vb };
  }

  /**
   * The touching counts, episode starts and cooldown ends, sorted (creature, owner key) (RR-19). `creature` is the
   * subject: a fighter's id (the lower one when both sides are fighters), or −id for an entity in a group with no fighter
   * (an entity's integrity episode against another entity, the terrain or a rope). `owner` is the other side's key
   * ('terrain', 'entity:<id>', 'fighter:<id>', 'rope:<joint>').
   */
  toRecord(): ContactRecV1[] {
    const out: ContactRecV1[] = [];
    for (const ep of this.episodes.values()) {
      const [subject, other] = subjectOf(ep);
      out.push({ creature: subject, owner: mergedKey(other), touching: ep.touching, episodeStart: ep.episodeStart, cooldownUntil: ep.cooldownUntil });
    }
    return out.sort((x, y) => x.creature - y.creature || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
  }

  /**
   * The load's restore (§8.3), into a world whose Rapier bodies were just built from the save and not stepped yet
   * (P13's loadWorld: createWorld steps no body, every body is made fresh, so the narrow phase is empty). Its first step
   * re-raises a `started` for every collider pair that still overlaps, and nothing else of the saved contacts: so the
   * next process() rebuilds each group restored as touching from the starts re-raised for it (they are the saved
   * episode going on, never a new one, never scored), and ends at that tick, with its cooldown, a restored episode none
   * of whose pairs is re-raised (it separated in that step, where the saved world's next step raised the stop).
   * Episode starts and cooldown ends stand as saved, so a bounce after the load is still a bounce.
   * Contract for P13: restore into the freshly built world, before its first step. A load that primes the narrow phase
   * first (P13's loadWorld steps the rebuilt world by zero time so its scene queries see every body) hands that step's
   * pairs to restoredStarts: its starts are the re-raised ones, and the first step raises them no more (without them the
   * counts of contacts that go on would drop to 0 at the first process()).
   * It replaces every runtime map (core-fix; DEVIATION: §1.5.8 has `restoreRecord(r)`, the graces restored apart): the
   * groups, the contact graces (`grace`, §8.3 `contactGrace`, exactly: a grace the world's construction or the loader's
   * own making of fighters opened goes), the resync and the load's starts (both kinds). A grace the load itself opens
   * (§4.3: every history reset, a load's included) is opened after it.
   */
  restoreRecord(r: ContactRecV1[], grace: readonly (readonly [number, number])[]): void {
    this.episodes.clear();
    this.graceUntil.clear();
    for (const [f, t] of grace) this.graceUntil.set(f, t);
    this.restarts = null;
    this.loadStarts = null;
    const resync = new Set<Episode>();
    for (const rec of r) {
      const subject: Merged = rec.creature > 0 ? { kind: 'fighter', id: rec.creature } : { kind: 'entity', id: -rec.creature };
      const other = parseMergedKey(rec.owner);
      const [a, b] = compareMerged(subject, other) <= 0 ? [subject, other] : [other, subject];
      const ep: Episode = { a, b, touching: rec.touching, episodeStart: rec.episodeStart, cooldownUntil: rec.cooldownUntil };
      this.episodes.set(groupKey(a, b), ep);
      if (ep.touching > 0) resync.add(ep);
    }
    this.resync = resync.size > 0 ? resync : null;
  }

  /**
   * After restoreRecord, the pairs of the load's zero-length step (P13's refreshQueries): its starts are the narrow
   * phase raising every collider pair that overlaps, held for the next process(). Those of a group restored touching are
   * the saved contacts going on, as restoreRecord's resync expects from the first step: they rebuild the restored
   * counts and nothing else. The others (core-fix) are contacts the saved world didn't have yet, whose first step is the
   * first step after the load (the saved world's next step would have raised them; the loaded one's no longer does):
   * that process() takes them as new contacts of its tick (loadStarts), so an impact due then still lands (a log a tick
   * from a lying player's slab at the save used to be lost).
   */
  restoredStarts(pairs: readonly ContactPair[]): void {
    const restarts: { a: Owner; b: Owner }[] = [];
    const fresh: ContactPair[] = [];
    for (const p of pairs) {
      if (!p.started) continue;
      const ep = this.episodeOf(p.a, p.b, false);
      if (ep && this.resync?.has(ep)) restarts.push({ a: p.a, b: p.b });
      // (A pair that is never counted is skipped there as any start is; no group is made here: a save before the first
      // step holds the restored groups only.)
      else fresh.push(p);
    }
    this.restarts = this.resync && restarts.length > 0 ? restarts : null;
    this.loadStarts = fresh.length > 0 ? fresh : null;
  }

  /**
   * The first process() after a load: the step's drained pairs with the load's new contacts (loadStarts) as starts of
   * this step, in the drain's order (sorted by owners; stable). A held start whose collider is gone since, or whose pair
   * this step stopped (a body moved away before it: a dev teleport in phase 1c), is dropped with that stop: the saved
   * world's step, made after the move, would have raised neither.
   */
  private withLoadStarts(w: World, pairs: readonly ContactPair[], starts: readonly ContactPair[]): ContactPair[] {
    const key = (p: ContactPair): string => `${p.ca!.handle}/${p.cb!.handle}`;
    const stopped = new Set<string>();
    for (const p of pairs) if (!p.started && p.ca && p.cb) stopped.add(key(p));
    const live = (c: RAPIER.Collider | null): boolean => c !== null && w.physics.isRegistered(c.handle);
    const keep = starts.filter((p) => live(p.ca) && live(p.cb) && !stopped.has(key(p)));
    const dropped = new Set<string>();
    for (const p of starts) if (p.ca && p.cb && stopped.has(key(p))) dropped.add(key(p));
    const rest = pairs.filter((p) => p.started || !p.ca || !p.cb || !dropped.has(key(p)));
    return [...rest, ...keep].sort((x, y) => compareOwners(x.a, y.a) || compareOwners(x.b, y.b));
  }

  /** (fighter, untilTick), sorted: the open contact graces (§8.3 `contactGrace`). */
  graceRecord(): [number, number][] {
    return [...this.graceUntil].map(([f, t]): [number, number] => [f, t]).sort((x, y) => x[0] - y[0]);
  }

  /** TODO(core-fix): restoreRecord's `grace` does this too (the loader uses that); fold it there once nothing calls it. */
  restoreGrace(r: [number, number][]): void {
    this.graceUntil.clear();
    for (const [f, t] of r) this.graceUntil.set(f, t);
  }

  // -------------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------------

  /** The group of two owners (created when `create`), or null for pairs that are never counted. */
  private episodeOf(a: Owner, b: Owner, create: boolean): Episode | null {
    const ma = merged(a);
    const mb = merged(b);
    if (!ma || !mb) return null;
    if (ma.kind === 'fighter' && mb.kind === 'fighter' && ma.id === mb.id) return null;
    if (ma.kind === 'terrain' && mb.kind === 'terrain') return null;
    const [x, y] = compareMerged(ma, mb) <= 0 ? [ma, mb] : [mb, ma];
    const key = groupKey(x, y);
    let ep = this.episodes.get(key);
    if (!ep && create) {
      ep = { a: x, b: y, touching: 0, episodeStart: -1, cooldownUntil: -1 };
      this.episodes.set(key, ep);
    }
    return ep ?? null;
  }

  /**
   * A started pair of a thrown entity is its first contact (D-31), except against a rope sensor or against its thrower
   * while it is still leaving the hands (`releasedBy`, the pairs its release raises).
   */
  private noteThrown(p: ContactPair, out: Set<number>): void {
    for (const [x, o] of [
      [p.a, p.b],
      [p.b, p.a],
    ] as const) {
      if (x.kind !== 'entity') continue;
      const e = this.world.entities.get(x.id);
      if (!e?.thrown || o.kind === 'rope') continue;
      if (o.kind === 'fighter' && e.releasedBy && o.id === e.releasedBy.fighter) continue;
      out.add(e.id);
    }
  }

  // -------------------------------------------------------------------------
  // Evaluation (9a)
  // -------------------------------------------------------------------------

  /** Scores a new episode: each side's largest energy over the pairs that started it this tick. */
  private evaluate(w: World, fr: Fresh, fighters: ReadonlyMap<number, Fighter>, held: ReadonlyMap<number, Set<number>>, tick: number): void {
    const { a, b } = fr.ep;
    // Rope episodes: the tripwire's (9d), outside the crosser's grace; the crosser a creature or a dynamic entity.
    if (a.kind === 'rope' || b.kind === 'rope') {
      const joint = a.kind === 'rope' ? a.joint : (b as { joint: number }).joint;
      for (const p of fr.pairs) {
        const by = p.a.kind === 'rope' ? p.b : p.a;
        if (by.kind === 'fighter') {
          if (!fighters.has(by.id) || by.part === 'kcc') continue;
          if (this.inGrace(by.id, tick)) {
            this.unscored.grace++;
            continue;
          }
        } else if (by.kind === 'entity') {
          const e = w.entities.get(by.id);
          if (!e?.body || !e.body.isDynamic() || w.entities.isAnchored(e)) continue;
        } else continue;
        fr.rope = { joint, by };
        break;
      }
      return;
    }
    // An entity meeting the ground: one contact over every terrain tile it meets this tick (groundHit).
    if (a.kind === 'terrain' && b.kind === 'entity') {
      const h = this.groundHit(w, fr.pairs, fighters, held, tick);
      if (h && h.energy >= DAMAGE_TUNING.minImpactJ) fr.entity.push(h);
      return;
    }

    type Best = { E: number; dv: number; hit: CreatureHit };
    // Per side of the group (0: its first owner, 1: its second): the best creature hit and the best entity hit.
    const best: [Best | null, Best | null] = [null, null];
    const ent: [EntityHit | null, EntityHit | null] = [null, null];
    const acc: { land: Fresh['land'] } = { land: null };
    for (const p of fr.pairs) {
      if (!p.ca || !p.cb) continue;
      const why = this.excluded(p, fighters, held, tick);
      if (why) {
        this.unscored[why]++;
        continue;
      }
      const g = this.geometry(w, p);
      const sa = this.side(w, p.a, fighters, g.point, g.n, g.va, g.poseA);
      const sb = this.side(w, p.b, fighters, g.point, g.n, g.vb, g.poseB);
      if (!sa || !sb) continue;
      if (sa.isStatic && sb.isStatic) continue;
      // The closing speed along n (out of a): (v_a − v_b)·n. DEVIATION (§4.3 writes "v_n = max(0, (v_other − v_self)·n)
      // with n out of self"): that sign gives 0 for every approach; the A lab it cites (normals.mjs: v_n = −(v_rel·n),
      // v_rel = v_other − v_self) and SPEC:279's "closing speed" are (v_self − v_other)·n.
      const vn = Math.max(0, dot(sub(g.va, g.vb), g.n));
      const s = Math.max(sharpOf(sa, sb, g.point), sharpOf(sb, sa, g.point));
      const sensor = p.sensor;
      const sides: [Side, Side, V3, 0 | 1][] = [
        [sa, sb, g.n, 0],
        [sb, sa, neg(g.n), 1],
      ];
      for (const [self, other, n, k] of sides) {
        if (!fr.leg && self.f?.ruler && other.e && strikingLeg(self.f, self.bone) && self.f.state !== 'tripped') {
          fr.leg = { f: self.f, e: other.e, point: { ...g.point }, n: { ...n } };
        }
        if (self.kind === 'creature' && self.f && self.bone) {
          const hit = this.creatureHit(self, other, n, vn, s, sensor, g.point);
          const E = hit.impact.energy;
          const dvl = len(hit.impact.dv);
          const cur = best[k];
          if (!cur || E > cur.E || (E === cur.E && dvl > cur.dv)) best[k] = { E, dv: dvl, hit };
          if (other.kind === 'terrain') {
            const full = impactEnergy(contactMeff(self.meff, other.meff, Infinity), vn, s);
            const land = acc.land;
            if (Number.isFinite(full) && (!land || full > land.energy)) acc.land = { f: self.f, energy: full, point: { ...g.point } };
          }
        } else if (self.kind === 'entity' && self.e) {
          // Its integrity: the effective masses at the contact point (integrityMeff; orchestrator decision, a departure
          // from §4.3's table recorded there).
          const mEff = integrityMeff(self.meff, other.meff);
          const E = Number.isFinite(mEff) ? impactEnergy(mEff, vn, s) : 0;
          const cur = ent[k];
          if (!cur || E > cur.energy) {
            const rel = sub(other.v, self.v);
            const rl = len(rel);
            ent[k] = { e: self.e, energy: E, point: { ...g.point }, breaker: other.owner, dir: rl > 0 ? scale(rel, 1 / rl) : null, landing: other.isStatic };
          }
        }
      }
    }
    for (const [k, b] of best.entries()) {
      if (!b) continue;
      if (b.E < DAMAGE_TUNING.minImpactJ && b.dv < IMPACT_TUNING.flinchDv) {
        // P28: unless the entity it met breaks in this episode (a stake a falling giant's shin snaps side-on): the
        // creature's side of that contact is applied and recorded first, whatever its energy (SPEC:344: "an impact's
        // damage is applied before it breaks"), so no break comes without its impact.
        const o = ent[1 - k];
        // For a fallen ruler (its body dynamic, its colliders solid), or a pointed entity (SPEC:344's "a stake that
        // shatters still delivers its blow") whoever meets it: a standing ruler's sensors walking through a blunt pole
        // are a brush the mover's obstacle trip answers (§4.7 steps 6, 9).
        const fallen = !!b.hit.impact.target.ruler && b.hit.impact.target.state === 'tripped';
        if (!o || !(fallen || o.e.sharpPoints.length > 0) || !breaks(o)) {
          this.unscored.brush++;
          continue;
        }
        fr.creature.push({ ...this.finishHit(b.hit), brushBreak: true });
        continue;
      }
      fr.creature.push(this.finishHit(b.hit));
    }
    for (const h of ent) if (h && h.energy >= DAMAGE_TUNING.minImpactJ) fr.entity.push(h);
    fr.land = acc.land;
  }

  /**
   * An entity's landing on the terrain (9c), scored once over the pairs of every tile it meets in this tick: the terrain
   * is one owner (§4.3), cut into tiles only for the heightfield, so the contact is at the mean of all those pairs'
   * points (each weighted by its points) with their mean normal. An entity's integrity reads its effective mass at that
   * point (integrityMeff): taken tile by tile, a log lying across a seam met each tile with half its length, half a log's
   * length from its centre of mass, and scored about half its landing. Null when no pair is scored (all excluded, or the
   * entity is static).
   */
  private groundHit(w: World, pairs: readonly ContactPair[], fighters: ReadonlyMap<number, Fighter>, held: ReadonlyMap<number, Set<number>>, tick: number): EntityHit | null {
    const nSum = { x: 0, y: 0, z: 0 };
    const pSum = { x: 0, y: 0, z: 0 };
    let k = 0;
    let first: ContactPair | null = null;
    for (const p of pairs) {
      if (!p.ca || !p.cb) continue;
      const why = this.excluded(p, fighters, held, tick);
      if (why) {
        this.unscored[why]++;
        continue;
      }
      // n out of the terrain (the pair's first collider), into the entity.
      const g = this.geometry(w, p);
      nSum.x += g.points * g.n.x;
      nSum.y += g.points * g.n.y;
      nSum.z += g.points * g.n.z;
      pSum.x += g.points * g.point.x;
      pSum.y += g.points * g.point.y;
      pSum.z += g.points * g.point.z;
      k += g.points;
      first ??= p;
    }
    const nl = len(nSum);
    if (!first || !(k > 0) || !(nl > 1e-9)) return null;
    const n = scale(nSum, 1 / nl);
    const point = scale(pSum, 1 / k);
    const me = this.motion(w, first.b, first.cb!);
    const ground = this.side(w, first.a, fighters, point, n, ZERO, me.body);
    const self = this.side(w, first.b, fighters, point, n, me.vAt(point), me.body);
    if (!ground || !self?.e || self.isStatic) return null;
    // The closing speed along n (out of the terrain): (v_terrain − v_entity)·n.
    const vn = Math.max(0, -dot(self.v, n));
    const s = sharpOf(self, ground, point);
    const E = impactEnergy(integrityMeff(self.meff, ground.meff), vn, s);
    const rel = neg(self.v);
    const rl = len(rel);
    return { e: self.e, energy: E, point, breaker: ground.owner, dir: rl > 0 ? scale(rel, 1 / rl) : null, landing: true };
  }

  /** Why a collider pair is never scored (both sides), or null. */
  private excluded(p: ContactPair, fighters: ReadonlyMap<number, Fighter>, held: ReadonlyMap<number, Set<number>>, tick: number): UnscoredWhy | null {
    const ents = this.world.entities;
    for (const [x, o] of [
      [p.a, p.b],
      [p.b, p.a],
    ] as const) {
      if (x.kind === 'fighter') {
        const f = fighters.get(x.id);
        if (!f) continue;
        if (this.inGrace(f.id, tick)) return 'grace';
        if ((x.part === 'zone' || x.part === 'ruler') && x.bone && attackingBones(f)?.has(x.bone)) return 'limb';
        if (o.kind === 'entity' && held.get(f.id)?.has(o.id)) return 'held';
      } else if (x.kind === 'entity') {
        const e = ents.get(x.id);
        if (!e) continue;
        if (e.releasedBy && o.kind === 'fighter' && o.id === e.releasedBy.fighter) return 'released';
        if (e.grace && (o.kind === 'fighter' || sameMerged(merged(o), merged(e.grace.from)))) return 'piece';
      }
    }
    return null;
  }

  /**
   * One side of a candidate pair (null: a fighter no longer in the sim, an entity gone). `n` is the contact normal (either
   * sign): a dynamic entity's effective mass at `point` along it is its MeffSide's pointKg.
   */
  private side(w: World, o: Owner, fighters: ReadonlyMap<number, Fighter>, point: V3, n: V3, v: V3, pose: Pose3): Side | null {
    switch (o.kind) {
      case 'terrain':
        return { owner: o, kind: 'terrain', f: null, e: null, bone: null, meff: { kind: 'terrain' }, isStatic: true, v: ZERO, pose: null };
      case 'rope':
        return null;
      case 'entity': {
        const e = w.entities.get(o.id);
        if (!e) return null;
        const isStatic = !e.body || !e.body.isDynamic() || w.entities.isAnchored(e);
        const pointKg = isStatic ? e.mass : entityPointMass(e, pose, point, n);
        return { owner: o, kind: 'entity', f: null, e, bone: null, meff: { kind: 'entity', massKg: e.mass, static: isStatic, pointKg }, isStatic, v: isStatic ? ZERO : v, pose };
      }
      case 'fighter': {
        const f = fighters.get(o.id);
        if (!f || o.part === 'kcc') return null;
        const bone = o.part === 'slab' ? w.downed.boneAt(f, point) : (o.bone ?? null);
        if (!bone) return null;
        return {
          owner: o,
          kind: 'creature',
          f,
          e: null,
          bone,
          meff: { kind: 'creature', boneKg: boneMass(f, bone), bodyKg: f.mass },
          isStatic: false,
          v,
          pose: null,
        };
      }
    }
  }

  /** The rule's answer for a creature side `self` hit by `other` (§4.3), with n out of `self`. */
  private creatureHit(self: Side, other: Side, n: V3, vn: number, s: number, sensor: boolean, point: V3): CreatureHit {
    const f = self.f!;
    const bone = self.bone!;
    const mb = boneMass(f, bone);
    // The creature's m_eff stays §4.3's table (the struck bone against the entity's whole mass), not the entity's
    // effective mass at the point that its own integrity reads (integrityMeff). Measured (SIM-fix): it changes nothing
    // where the bone is light against the entity (the AC-6 log on a player's head, centred or 0.6-1.2 m off: 94.1 J vs
    // 93.9-90.5 J), but on the giant's 860-2,865 kg bones it would cut a felled 30 cm tree's blow at 8 m from a 472 HP
    // wound to 188 HP, no wound (AC-2(d)'s ruler gate), and a 300 kg log landing 1.5 m off-centre on the lying giant
    // from 243 to 95 HP. With one score per episode (§4.3) the rest of the log lands in the same episode unscored, so
    // the whole mass is the better measure of the blow the creature takes; rule 5 needs traps to wound rulers.
    const mEff = contactMeff(self.meff, other.meff, IMPACT_TUNING.unbackedTargetMassRatio);
    const own = selfMotion(self.v, other.v, n);
    const E = contactEnergy({ mEff, vn, s, boneKg: mb, vSafe: safeLandingSpeed(f), staticOther: other.isStatic, selfMotion: own });
    const standingRuler = !!f.ruler && f.state !== 'tripped';
    // Δv only for sensor targets that are not a standing ruler, never from a static impactor or the creature's own
    // motion: in a solid pair the solver already exchanged the momentum (RF-4).
    const dv =
      sensor && !own && !other.isStatic && !standingRuler
        ? impactDv(sideMass(other.meff), sub(other.v, self.v), f.mass, other.kind === 'creature', IMPACT_TUNING.creatureRestitution)
        : { ...ZERO };
    const zone: HurtZone = BONE_ZONE[bone];
    const impact: Impact = {
      target: f,
      bone,
      zone,
      rulerZone: null,
      point: { ...point },
      normal: { ...n },
      mEff,
      vn,
      sharpness: s,
      energy: E.creature,
      toughness: 0,
      dv,
      impactorMass: other.isStatic ? Infinity : sideMass(other.meff),
      cause: causeOf(this.world, other, s, sharpFrom(other, self, point)),
    };
    const reactionEntity = other.kind === 'entity' && other.e && !other.isStatic ? other.e.id : null;
    return { impact, impactor: other, reactionEntity };
  }

  /** Zone toughness for the chosen hit (a ruler's zone from its classifier, §2.8). */
  private finishHit(h: CreatureHit): CreatureHit {
    const i = h.impact;
    const f = i.target;
    let rulerZone: RulerZoneId | null = null;
    let toughness: number;
    if (f.ruler) {
      const q = f.rig[i.bone].rot;
      const nb = rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, i.normal);
      rulerZone = classifyRulerZone(f, i.bone, new Vector3(i.point.x, i.point.y, i.point.z), new Vector3(nb.x, nb.y, nb.z));
      toughness = rulerToughness(rulerZone) + (f.armour[i.zone] ?? 0);
    } else toughness = zoneToughness(f, i.zone);
    return { ...h, impact: { ...i, rulerZone, toughness } };
  }

  // -------------------------------------------------------------------------
  // Dispatch (9b, 9c)
  // -------------------------------------------------------------------------

  private applyCreatureHit(w: World, h: CreatureHit): void {
    const i = h.impact;
    const f = i.target;
    if (!w.combat.fighters.includes(f)) return;
    const standingRuler = !!f.ruler && f.state !== 'tripped';
    const r = applyImpact(w.combat, i);
    this.scored++;
    if (h.reactionEntity !== null && (r.reaction.x !== 0 || r.reaction.y !== 0 || r.reaction.z !== 0) && w.entities.get(h.reactionEntity)) {
      w.entities.queueImpulse(h.reactionEntity, r.reaction, i.point);
    }
    // Impact trip (§4.7 step 9, SPEC:305): a blocking-class impactor (≥ impactTripMinKg, or static) on a leg between
    // ankle and knee faster than tripSpeed along the normal trips a standing ruler; smaller momenta are dropped. It runs
    // on scored impacts only. A static impactor meets a standing ruler only by the ruler's own motion, so a blunt one is
    // a brush (v_safe 14.07 m/s takes its energy) and the obstacle trip (§4.7 step 6.2: RulerBodies.legStrike for the
    // shin that meets it, RulerMover's sweep for the body) is what trips on it; a sharp one keeps its energy (SPEC:415),
    // is scored, and trips here.
    if (standingRuler && !h.brushBreak && f.state !== 'ko' && shinBand(f, i.bone, i.point)) {
      const T = RULER_BODY_TUNING;
      if ((i.impactorMass === Infinity || i.impactorMass >= T.impactTripMinKg) && i.vn > T.tripSpeed) w.rulers.requestTrip(f, 'impact', i.cause);
    }
  }

  private applyEntityHit(w: World, h: EntityHit): void {
    const e = w.entities.get(h.e.id);
    if (!e) return;
    w.breaking.hit(e, h.energy, h.point, h.breaker);
    // A notched tree: the impact's moment about the hinge in the fall direction (§4.12): E/hingeRad × max(0, d̂·fallDir),
    // the fall direction away from the cut side.
    const cut = e.plant?.phase === 'notched' ? e.plant.cut : null;
    if (cut && h.dir) {
      const along = -(h.dir.x * cut.fromDir.x + h.dir.y * cut.fromDir.y + h.dir.z * cut.fromDir.z);
      const moment = (h.energy / FELL_TUNING.hingeRad) * Math.max(0, along);
      if (moment > 0) w.felling.addMoment(e.id, moment);
    }
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /** Normal (out of the pair's first collider), point and velocities of a collider pair (§4.3). */
  private geometry(w: World, p: ContactPair): Geom {
    const ca = p.ca!;
    const cb = p.cb!;
    const ma = this.motion(w, p.a, ca);
    const mb = this.motion(w, p.b, cb);
    if (!p.sensor) {
      const solid = solidContact(w, ca, cb, ma, mb);
      if (solid) return { n: solid.n, point: solid.point, va: ma.vAt(solid.point), vb: mb.vAt(solid.point), poseA: ma.body, poseB: mb.body, points: solid.points };
    }
    const hit = castContact(ca.shape, ma.prev, ma.vCentre, cb.shape, mb.prev, mb.vCentre);
    if (hit) {
      const { n, point, toi } = hit;
      return { n, point, va: ma.vAt(point), vb: mb.vAt(point), poseA: advance(ma, toi), poseB: advance(mb, toi), points: 1 };
    }
    // Began overlapped (a jump, an enable, a switch): n = −v̂_rel, or the line between the centres when nothing moves.
    const rel = sub(mb.vCentre, ma.vCentre);
    const rl = len(rel);
    let n: V3;
    if (rl > 1e-9) n = scale(rel, -1 / rl);
    else {
      const d = sub(mb.pose.p, ma.pose.p);
      const dl = len(d);
      n = dl > 1e-9 ? scale(d, 1 / dl) : { ...UP };
    }
    const proj = cb.projectPoint(ma.pose.p, false);
    const point = proj ? { x: proj.point.x, y: proj.point.y, z: proj.point.z } : { ...ma.pose.p };
    return { n, point, va: ma.vAt(point), vb: mb.vAt(point), poseA: ma.body, poseB: mb.body, points: 1 };
  }

  /** A collider's motion from the phase-5 store: a dynamic body's, a kinematic zone's carryV, or still. */
  private motion(w: World, owner: Owner, c: RAPIER.Collider): Motion {
    const pre = owner.kind === 'terrain' ? null : w.physics.pre(ownerKey(owner));
    const b = c.parent();
    const cp = c.translation();
    const cq = c.rotation();
    const cur: Pose3 = { p: { x: cp.x, y: cp.y, z: cp.z }, q: { x: cq.x, y: cq.y, z: cq.z, w: cq.w } };
    if (pre && b && b.isDynamic()) {
      // The collider's offset in its body's frame (fixed for life), applied to the stored body poses.
      const bp = b.translation();
      const bq = b.rotation();
      const bqi = conj(bq);
      const lp = rotate(bqi, sub(cur.p, bp));
      const lq = qmul(bqi, cur.q);
      const body = { p: { ...pre.p }, q: { ...pre.q } };
      const bodyPrev = { p: { ...pre.prevP }, q: { ...pre.prevQ } };
      const pose = { p: addv(pre.p, rotate(pre.q, lp)), q: qmul(pre.q, lq) };
      const prev = { p: addv(pre.prevP, rotate(pre.prevQ, lp)), q: qmul(pre.prevQ, lq) };
      const v = pre.v;
      const wv = pre.w;
      const com = pre.com;
      const vAt = (x: V3): V3 => addv(v, cross(wv, sub(x, com)));
      return { pose, prev, body, bodyPrev, vAt, vCentre: vAt(pose.p) };
    }
    if (pre) {
      // A kinematic or parentless sensor: its stored poses and the previous tick's delta (carryV), no spin.
      const pose = { p: { ...pre.p }, q: { ...pre.q } };
      const prev = { p: { ...pre.prevP }, q: { ...pre.prevQ } };
      const carry = { ...pre.carryV };
      return { pose, prev, body: pose, bodyPrev: prev, vAt: () => carry, vCentre: carry };
    }
    // Fixed, asleep, terrain, or not stored this tick: still where it is.
    const body = b ? { p: v3(b.translation()), q: q4(b.rotation()) } : cur;
    return { pose: cur, prev: cur, body, bodyPrev: body, vAt: () => ({ ...ZERO }), vCentre: { ...ZERO } };
  }
}

/**
 * A ruler's bone that strikes an obstacle as a leg (RulerBodies.legStrike, SPEC:782 "its legs strike a blocking
 * obstacle"): a shin; and, in the knuckle charge (posture headLow, P20: both forearms down in front, the knuckles ≈ 1 m
 * up and ≈ 2.5 m ahead of the root), a forearm, its front leg. P26 (AC-5) found the gap: charging a lashed log at shin
 * height, the forearms met it ≈ 1.3 m before the shins and their impact snapped its lashings, so when the shins came
 * the log was no blocker and the charge shoved it aside instead of tripping.
 */
function strikingLeg(f: Fighter, bone: BoneName | null | undefined): boolean {
  if (bone === 'shinL' || bone === 'shinR') return true;
  return (bone === 'foreArmL' || bone === 'foreArmR') && f.posture?.id === 'headLow';
}

// ---------------------------------------------------------------------------
// Owners and groups
// ---------------------------------------------------------------------------

/** The merged owner of a collider's owner; null for a KCC capsule (no damage collider, §4.3). */
function merged(o: Owner): Merged | null {
  switch (o.kind) {
    case 'terrain':
      return { kind: 'terrain' };
    case 'entity':
      return { kind: 'entity', id: o.id };
    case 'fighter':
      return o.part === 'kcc' ? null : { kind: 'fighter', id: o.id };
    case 'rope':
      return { kind: 'rope', joint: o.joint };
  }
}

function mergedId(m: Merged): number {
  return m.kind === 'terrain' ? 0 : m.kind === 'rope' ? m.joint : m.id;
}

/** Owner order (§4.3: terrain < entity < fighter < rope, then by id), as physics.ts sorts the drained pairs. */
function compareMerged(a: Merged, b: Merged): number {
  return compareOwners(asOwner(a), asOwner(b));
}

/** A merged owner as an Owner (a fighter as its whole self: one part stands for all, so two equal fighters compare 0). */
function asOwner(m: Merged): Owner {
  return m.kind === 'fighter' ? { kind: 'fighter', id: m.id, part: 'kcc' } : m;
}

function sameMerged(a: Merged | null, b: Merged | null): boolean {
  return !!a && !!b && compareMerged(a, b) === 0;
}

function mergedKey(m: Merged): string {
  return m.kind === 'terrain' ? 'terrain' : `${m.kind}:${mergedId(m)}`;
}

function parseMergedKey(k: string): Merged {
  if (k === 'terrain') return { kind: 'terrain' };
  const [kind, id] = k.split(':');
  const n = Number(id);
  if (!Number.isInteger(n)) throw new Error(`ContactSystem.restoreRecord: a bad owner key '${k}'`);
  switch (kind) {
    case 'entity':
      return { kind: 'entity', id: n };
    case 'fighter':
      return { kind: 'fighter', id: n };
    case 'rope':
      return { kind: 'rope', joint: n };
  }
  throw new Error(`ContactSystem.restoreRecord: a bad owner key '${k}'`);
}

/** The group key of two merged owners, `a` before `b` in owner order. */
function groupKey(a: Merged, b: Merged): string {
  const [x, y] = compareMerged(a, b) <= 0 ? [a, b] : [b, a];
  return `${mergedKey(x)}|${mergedKey(y)}`;
}

/** The record's subject (a fighter's id, the lower when both are fighters; else −entity id) and the other side. */
function subjectOf(ep: Episode): [number, Merged] {
  if (ep.a.kind === 'fighter') return [ep.a.id, ep.b];
  if (ep.b.kind === 'fighter') return [ep.b.id, ep.a];
  if (ep.a.kind === 'entity') return [-ep.a.id, ep.b];
  if (ep.b.kind === 'entity') return [-ep.b.id, ep.a];
  throw new Error(`ContactSystem: a group with neither a fighter nor an entity (${mergedKey(ep.a)}|${mergedKey(ep.b)})`);
}

/**
 * Fighter id → the entities its hands hold, drag or tow by a held rope, or (P28) a creature's tug hauls (never scored
 * against its colliders: the 1 kg bait a tugging ape grips was scored against its own hands and chest, 46 J, and broke).
 */
function heldEntities(w: World): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const f of w.combat.fighters) {
    const tug = w.verbs.tugTarget(f);
    if (tug !== null) out.set(f.id, new Set([tug]));
    const h = f.inventory?.hands;
    if (!h) continue;
    const s = new Set<number>([h.entity]);
    if (tug !== null) s.add(tug);
    if (h.joint !== null) {
      const j = w.joints.get(h.joint);
      if (j) for (const end of [j.a, j.b]) if (end.entity !== null) s.add(end.entity);
    }
    out.set(f.id, s);
  }
  return out;
}

/** P28: whether an entity hit of this energy takes the entity's integrity to 0 (Breaking.hit's rule, SPEC:344). */
function breaks(h: EntityHit): boolean {
  const Eb = breakEnergyJ(MATERIALS[h.e.material], h.e.mass);
  if (!(Eb > 0) || !Number.isFinite(Eb) || !(h.energy > Eb)) return false;
  return ((h.energy - Eb) / Eb) * BREAK_TUNING.integrityPerExcess >= h.e.integrity;
}

/** The bones of the move's limb chain while a fighter is in 'attack' (both arms for a two-handed weapon), else null. */
function attackingBones(f: Fighter): Set<BoneName> | null {
  if (f.state !== 'attack' || !f.move) return null;
  const s = new Set<BoneName>(LIMB_CHAIN[f.move.limb]);
  if (f.move.weapon && f.weapon?.style === 'twoHand') for (const b of [...LIMB_CHAIN.handL, ...LIMB_CHAIN.handR]) s.add(b);
  return s;
}

// ---------------------------------------------------------------------------
// The rule's inputs
// ---------------------------------------------------------------------------

/** The sharpness of `pts`'s points leading into the contact (an entity side; creatures have none). */
function sharpOf(pts: Side, other: Side, point: V3): number {
  if (pts.kind !== 'entity' || !pts.e || !pts.pose || pts.e.sharpPoints.length === 0) return 0;
  return leadingSharpness(pts.e.sharpPoints, pts.pose, point, sub(other.v, pts.v));
}

/** Whether the impactor's own sharp point leads into `target` (the cause's feature). */
function sharpFrom(impactor: Side, target: Side, point: V3): boolean {
  return sharpOf(impactor, target, point) > 0;
}

/** What hit the creature, as the cause its wound, its KO and adaptation remember (§2.10). */
function causeOf(w: World, other: Side, s: number, sharpLeads: boolean): ImpactCause {
  switch (other.kind) {
    case 'terrain':
      return { kind: 'terrain', entityId: null, fighterId: null, credit: [], held: false, feature: 'fall' };
    case 'creature': {
      const f = other.f!;
      return { kind: 'creature', entityId: null, fighterId: f.id, credit: f.playerId ? [f.playerId] : [], held: false, feature: 'creature' };
    }
    default: {
      const e = other.e!;
      const holder = holderOf(w, e.id);
      const held = holder !== null || e.thrown !== null;
      const fighterId = holder ?? e.thrown?.by ?? null;
      let feature: CauseFeature;
      if (sharpLeads && s > 0) feature = 'sharpPoint';
      else if (other.isStatic) feature = 'fall';
      else if (hangs(w, e)) feature = 'swinging';
      else if (-other.v.y >= Math.hypot(other.v.x, other.v.z)) feature = 'falling';
      else feature = 'rolling';
      return { kind: 'entity', entityId: e.id, fighterId, credit: [...e.credit], held, feature };
    }
  }
}

/**
 * A dynamic entity's effective mass at `point` along `n` (damage.ts pointMass), its body at `pose` (the pose the contact
 * geometry used): the centre of mass and the principal axes from the body's mass properties, carried by that pose.
 */
function entityPointMass(e: Entity, pose: Pose3, point: V3, n: V3): number {
  const b = e.body;
  if (!b) return e.mass;
  const com = addv(pose.p, rotate(pose.q, v3(b.localCom())));
  return pointMass(e.mass, v3(b.principalInertia()), qmul(pose.q, q4(b.principalInertiaLocalFrame())), sub(point, com), n);
}

/** The fighter whose hands hold or drag the entity, or null. */
function holderOf(w: World, id: number): number | null {
  for (const f of w.combat.fighters) if (f.inventory?.hands?.entity === id) return f.id;
  return null;
}

/** The entity hangs from a rope joint (a swinging log). */
function hangs(w: World, e: Entity): boolean {
  for (const j of e.joints) if (w.joints.get(j)?.kind === 'rope') return true;
  return false;
}

/** A point on a ruler's shin between its ankle and its knee (the impact trip's band, §4.7 step 9). */
function shinBand(f: Fighter, bone: BoneName, point: V3): boolean {
  if (bone !== 'shinL' && bone !== 'shinR') return false;
  const knee = f.rig[bone].pos;
  const q = f.rig[bone].rot;
  const a = rotate({ x: q.x, y: q.y, z: q.z, w: q.w }, { x: 0, y: SKELETON[bone].dir * SKELETON[bone].length * f.rig[bone].s, z: 0 });
  const ankleY = knee.y + a.y;
  return point.y <= Math.max(knee.y, ankleY) && point.y >= Math.min(knee.y, ankleY);
}

/**
 * The normal and point of a sensor pair (§4.3, departure X4: `contactCollider` at the event gave (0, 1, 0) and v_n 0 in
 * 3 of 4 sensor cases, the cast was right in 4 of 4, A lab normals.mjs (1)): shape A cast from its pose at the start of
 * the previous step with velocity vA against shape B from its own with vB, over IMPACT_TUNING.castWindowTicks × DT,
 * not stopping at a starting penetration. Returns the normal out of A (world), the point on A's surface at the time of
 * impact (world) and that time (s); null when the cast misses (they began overlapped, or never meet).
 */
export function castContact(shapeA: RAPIER.Shape, prevA: Pose3, vA: V3, shapeB: RAPIER.Shape, prevB: Pose3, vB: V3): { n: V3; point: V3; toi: number } | null {
  const window = IMPACT_TUNING.castWindowTicks * DT;
  const hit = shapeA.castShape(prevA.p, prevA.q, vA, shapeB, prevB.p, prevB.q, vB, 0, window, false);
  if (!hit) return null;
  const n0 = rotate(prevA.q, hit.normal1);
  const nl = len(n0);
  if (!(nl > 1e-9) || !Number.isFinite(nl)) return null;
  const t = hit.time_of_impact;
  const w1 = rotate(prevA.q, hit.witness1);
  const point = { x: prevA.p.x + vA.x * t + w1.x, y: prevA.p.y + vA.y * t + w1.y, z: prevA.p.z + vA.z * t + w1.z };
  return { n: scale(n0, 1 / nl), point, toi: t };
}

/**
 * The contact of a solid pair from its manifolds (§4.3): the normal out of `ca` (Rapier's manifold normal points out of
 * its first collider, flipped when that is `cb`), the mean of the solver contact points, or of the manifold points
 * (through the start-of-step pose of the manifold's first collider) when it has none (a heightfield, A lab normals.mjs
 * (2)). Manifolds with no contacts are skipped; null when none has any.
 */
function solidContact(w: World, ca: RAPIER.Collider, cb: RAPIER.Collider, ma: Motion, mb: Motion): { n: V3; point: V3; points: number } | null {
  const nSum = { x: 0, y: 0, z: 0 };
  const pSum = { x: 0, y: 0, z: 0 };
  let np = 0;
  w.physics.rapier.contactPair(ca, cb, (m, flipped) => {
    const k = m.numContacts();
    if (k === 0) return;
    const nm = m.normal();
    const sgn = flipped ? -1 : 1;
    nSum.x += sgn * nm.x;
    nSum.y += sgn * nm.y;
    nSum.z += sgn * nm.z;
    const ns = m.numSolverContacts();
    if (ns > 0) {
      for (let i = 0; i < ns; i++) {
        const p = m.solverContactPoint(i);
        if (!p) continue;
        pSum.x += p.x;
        pSum.y += p.y;
        pSum.z += p.z;
        np++;
      }
      return;
    }
    const pose = flipped ? mb.pose : ma.pose;
    for (let i = 0; i < k; i++) {
      const l = m.localContactPoint1(i);
      if (!l) continue;
      const p = addv(pose.p, rotate(pose.q, l));
      pSum.x += p.x;
      pSum.y += p.y;
      pSum.z += p.z;
      np++;
    }
  });
  const nl = len(nSum);
  if (np === 0 || !(nl > 1e-9)) return null;
  return { n: scale(nSum, 1 / nl), point: scale(pSum, 1 / np), points: np };
}

// ---------------------------------------------------------------------------
// Vectors and quaternions (plain records)
// ---------------------------------------------------------------------------

function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function addv(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a: V3, k: number): V3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function neg(a: V3): V3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
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

function v3(v: { x: number; y: number; z: number }): V3 {
  return { x: v.x, y: v.y, z: v.z };
}

function q4(q: { x: number; y: number; z: number; w: number }): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** A motion's body pose `t` seconds after the start of the previous step (the cast's time of impact; rotation kept). */
function advance(m: Motion, t: number): Pose3 {
  const v = m.vCentre;
  return { p: { x: m.bodyPrev.p.x + v.x * t, y: m.bodyPrev.p.y + v.y * t, z: m.bodyPrev.p.z + v.z * t }, q: { ...m.bodyPrev.q } };
}
