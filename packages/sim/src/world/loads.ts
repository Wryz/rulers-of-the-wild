// Load capacity and covers (docs/M1-DESIGN.md §1.5.7, §4.11): foot loads of standing fighters and resting weights,
// passed down through coverings in equal shares, a 0.2 s average against capacity, load breaks (phase 11).
//
// Loads are computed, never pushed into the solver (a 716 N force on a 5 kg mat launched it 12.8 m, MAP rapier
// finding 14). Each tick:
// - Foot loads (D-39): a standing fighter's weight, shared equally among its planted feet (footwork feet not stepping;
//   a player or ape only while its controller is grounded); under each planted foot a disc (footRadiusM × scale,
//   footDiscH) finds the topmost entity it overlaps; a dynamic or anchored one takes the foot's share (a fixed one is
//   the ground).
// - Resting weights: every dynamic entity at rest (or asleep) passes its own weight on, like a foot.
// - Spreading (C F7): an entity that rests on another dynamic entity (a contact manifold whose normal from the support
//   up into it is steeper than supportNormalY) is a covering: it passes all it receives (its own weight included) in
//   equal shares to everything it rests on (a fixed or anchored support, or the terrain, takes its share into the
//   ground), recursively up to maxSpreadDepth levels. A covering is not itself load-tested ("loads on a cover spread
//   over the pieces under them", SPEC:345, I-1). Interpretation (§4.11 writes "in equal shares to those supports"): the
//   shares go to every support the covering rests on, static ones included, so a mat lying half on the rim passes half
//   of its load into the ground.
// - Which entity is tested (I-1): an entity resting on nothing dynamic carries what reaches it, and is tested only
//   where it spans: a downward ray from its underside below the load point finds no terrain or fixed/anchored support
//   within spanGapM. A branch across a pit spans; one lying on the ground, or an upright prop, doesn't.
// - Each tested entity's per-tick load goes into `loadHist` (loadWindowS of ticks); an average above its capacity
//   (E_b ÷ loadLeverM, SPEC:345) → Breaking.loadBreak at the heaviest load point (and the next one more than
//   loadPointSplitM away along it). A load break under a planted ruler foot whose support then drops more than
//   ledgeTripDropFrac × knee height trips the ruler `cover` (§4.7 step 8); the support is looked for without the
//   entities that broke this tick and the coverings that rested only on them.
// - A fresh piece in its grace (RF-7) takes none of its breaker's load: no foot share from the fighter that broke it,
//   and no share of a covering's load that came from that fighter. Without that, the pieces of a bearer broken by a
//   ruler foot broke again under the same foot every tick until they fell.
import RAPIER from '@dimforge/rapier3d-compat';
import { BONE_ZONE } from '../body/mass';
import { BONES, type BoneName } from '../body/skeleton';
import { applyImpact } from '../sim/impact';
import type { Fighter } from '../sim/fighter';
import { DT } from '../sim/math';
import { SPECIES_BODY } from '../sim/species';
import { defineTuning } from '../tuning/registry';
import { BREAK_TUNING } from './breaking';
import { loadCapacityN, MATERIALS } from './materials';
import { PHYSICS_TUNING } from './physics';
import { RULER_BODY_TUNING } from './rulerBody';
import { principalAxis } from './shapes';
import type { Entity, ImpactCause, Owner, V3 } from './types';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

export const LOAD_TUNING = defineTuning(
  'LOAD_TUNING',
  'Materials & joints › loads',
  {
    loadWindowS: 0.2,
    maxSpreadDepth: 4,
    supportNormalY: 0.5,
    footDiscH: 0.06,
    spanGapM: 0.1,
  },
  {
    loadWindowS: { unit: 's', source: 'SPEC:345' },
    maxSpreadDepth: { unit: 'levels', source: 'NEW: D-39' },
    supportNormalY: { unit: 'cos', source: 'NEW' },
    footDiscH: { unit: 'm', source: 'NEW: D-39' },
    spanGapM: { unit: 'm', source: 'NEW: an entity is load-tested only where nothing supports it within this below the load point (I-1)' },
  },
);

/** What an entity rests on (one per supporting owner): a dynamic entity, or a static support (null). */
interface Support {
  entity: Entity | null;
  /** World point: the mean of the contact points. */
  point: V3;
}

/** A load an entity received this tick. */
interface Share {
  n: number;
  point: V3;
  loader: Owner | null;
  /** The planted foot it came from, or null (a resting weight). */
  foot: Foot | null;
}

/** A planted foot whose load is being delivered, and every covering that load passed through on its way down. */
interface Foot {
  f: Fighter;
  side: 'L' | 'R';
  at: V3;
  via: Set<number>;
  /** N: the foot's whole load (P28: the share each support carried, for the ruler's lost-support rule). */
  n: number;
}

/**
 * P38 (perf): what one entity's supports and span tests were when last read from Rapier, kept while nothing they come
 * from can have changed (see Loads's header comment below). Never saved: a loaded world starts with none.
 */
interface Memo {
  /** Tick it was made (a dynamic entity's: asleep then). */
  tick: number;
  /** A fixed, anchored or held entity's memo (span tests only), or a dynamic one's. */
  fixed: boolean;
  entityEpoch: number;
  terrainEpoch: number;
  /** A dynamic entity's centre of mass when it was made (null for a fixed one). */
  com: V3 | null;
  /** The owners its supports came from, in key order (−1 the terrain), each with its point; null: not kept. */
  supports: { key: number; point: V3 }[] | null;
  /** The tick `supports` was read, with every dynamic entity in `partners` asleep. */
  supportsTick: number;
  /** Every entity it had a contact pair with (any normal) when `supports` was read, id order. */
  partners: number[];
  /** spans() answers at exact load points. */
  spans: { x: number; y: number; z: number; spans: boolean }[];
}

export class Loads {
  readonly world: World;
  /**
   * P38 (perf, the WardedMMO plan in docs/work/warded-advice.md; outcome-identical): per entity, the tick it was last
   * seen not asleep (a dynamic entity awake, or not dynamic), and its memo. Rapier's narrow phase updates a contact pair
   * only when one of its colliders changed (moved, or was edited by code), and a body that ends a step asleep was not
   * integrated in it; so while an entity and every dynamic entity it has a contact pair with stay asleep at every tick's
   * end, with no code change to any entity (EntityStore.epoch: create, remove, state, reshape, code move, grace) and no
   * terrain edit (Terrain.editEpoch), its contact manifolds — and so its supports, its centre of mass and its span
   * tests — are what they were. A memo is used only then; everything that depends on live state (whether a support is
   * dynamic and unanchored, a fresh piece's grace, the loads and their history, the capacity test) is still computed
   * every tick, so rot and other capacity changes (rule 10, from M2) are tested every tick as before. A new pair with a
   * contact wakes a sleeping body (Rapier's island traversal), which drops the memo. `verify`: also compute every
   * memoised answer afresh and throw on any difference (tests and the perf proof only).
   */
  private readonly awakeTick = new Map<number, number>();
  private readonly memos = new Map<number, Memo>();
  static verify = false;

  constructor(world: World) {
    this.world = world;
  }

  /** Phase 11 (see the top of this file). */
  update(w: World): void {
    const tick = w.tick;
    // P38: which dynamic entities are asleep at this step's end (the memos' condition), in id order.
    for (const e of w.entities.dynamic()) if (!e.body!.isSleeping()) this.awakeTick.set(e.id, tick);
    if (Loads.verify) {
      expectSame('dynamic entities', w.entities.dynamic().map((e) => e.id), w.entities.all().filter(dynamicBody).map((e) => e.id));
    }
    const received = new Map<number, Share[]>();
    const supports = new Map<number, Support[]>();
    const supportsOf = (e: Entity): Support[] => {
      let s = supports.get(e.id);
      if (!s) supports.set(e.id, (s = this.supportsMemo(w, e)));
      return s;
    };
    // P38: the coverings a load passed through on its way down, as a path pushed and popped (was a new Set per level).
    const path: number[] = [];
    const deliver = (e: Entity, n: number, point: V3, loader: Owner | null, foot: Foot | null, depth: number): void => {
      if (!(n > 0)) return;
      // A fresh piece ignores its breaker until clear (RF-7): it carries none of the breaker's load either, so the
      // pieces of a bearer a foot broke fall away instead of breaking again under the same foot every tick.
      const sup = dynamicBody(e) ? supportsOf(e).filter((s) => !s.entity || !ignores(s.entity, loader)) : [];
      const covering = sup.some((s) => s.entity !== null);
      if (covering && depth < LOAD_TUNING.maxSpreadDepth) {
        const share = n / sup.length;
        path.push(e.id);
        foot?.via.add(e.id);
        for (const s of sup) if (s.entity && !path.includes(s.entity.id)) deliver(s.entity, share, s.point, loader, foot, depth + 1);
        path.pop();
        return;
      }
      let l = received.get(e.id);
      if (!l) received.set(e.id, (l = []));
      l.push({ n, point: { ...point }, loader, foot });
    };
    const g = Math.abs(WORLD_TUNING.gravityY);

    // Foot loads.
    const feet: Foot[] = [];
    for (const f of w.combat.fighters) {
      if (!standing(w, f)) continue;
      const planted = (['L', 'R'] as const).filter((s) => !f.footwork.foot(s).stepping);
      if (planted.length === 0) continue;
      const share = (f.mass * g) / planted.length;
      for (const side of planted) {
        // P28: the loader names the leg the foot ends (a break's source, `break.by`: the support a foot's load broke).
        const loader: Owner = { kind: 'fighter', id: f.id, part: f.ruler ? 'ruler' : 'zone', bone: side === 'L' ? 'shinL' : 'shinR' };
        const fp = f.footwork.foot(side).pos;
        const at = { x: fp.x, y: fp.y, z: fp.z };
        const e = this.underFoot(w, f, at, loader);
        if (!e) continue;
        const foot: Foot = { f, side, at, via: new Set(), n: share };
        feet.push(foot);
        deliver(e, share, at, loader, foot, 0);
      }
    }
    // Resting weights (P38: the maintained list of dynamic entities, EntityStore.dynamic, in id order).
    for (const e of w.entities.dynamic()) {
      if (!resting(e)) continue;
      deliver(e, e.mass * g, this.comOf(w, e), { kind: 'entity', id: e.id }, null, 0);
    }

    // P28 (§4.11 "resting weights"): a ruler down on its dynamic body (tripped, or dead) is a weight on what it lies on, in
    // equal shares among them (the terrain and fixed entities take theirs into the ground), whether or not it is still:
    // a tripped giant sliding over a pit's cover was held up by 4 kg bearers no load ever tested.
    for (const f of w.combat.fighters) {
      if (!f.ruler) continue;
      const on = w.rulers.lyingOn(f, LOAD_TUNING.supportNormalY);
      if (on.length === 0) continue;
      const share = (f.mass * g) / on.length;
      const loader: Owner = { kind: 'fighter', id: f.id, part: 'ruler' };
      for (const s of on) if (s.entity && (dynamicBody(s.entity) || s.entity.state === 'anchored')) deliver(s.entity, share, s.point, loader, null, 0);
    }

    // P28 (§4.7 steps 7-8, the lost-support rule): each entity that carried a share of a ruler's planted foot joins its
    // support set (RulerBodies.noteFootLoad): the coverings the load passed through, and what received it.
    for (const foot of feet) {
      if (!foot.f.ruler || !(foot.n > 0)) continue;
      const carried = new Map<number, number>();
      for (const id of foot.via) carried.set(id, 1);
      for (const [id, shares] of received) {
        let n = 0;
        for (const sh of shares) if (sh.foot === foot) n += sh.n;
        if (n > 0) carried.set(id, Math.max(carried.get(id) ?? 0, n / foot.n));
      }
      for (const id of [...carried.keys()].sort((a, b) => a - b)) w.rulers.noteFootLoad(foot.f, id, carried.get(id)!);
    }

    // Tested loads, the averages, load breaks (entity id order).
    const broken = new Set<number>();
    const n = Math.max(1, Math.round(LOAD_TUNING.loadWindowS / DT));
    for (const e of w.entities.all()) {
      const shares = received.get(e.id);
      let tested = 0;
      const points: Share[] = [];
      if (shares) {
        const spans = this.spansMemo(w, e, shares);
        for (let i = 0; i < shares.length; i++) {
          if (!spans[i]) continue;
          tested += shares[i].n;
          points.push(shares[i]);
        }
      }
      const h = e.loadHist;
      if (tested === 0 && h.every((x) => x === 0)) continue;
      if (h.length !== n) e.loadHist = resized(h, n);
      const hist = e.loadHist;
      hist.copyWithin(0, 1);
      hist[hist.length - 1] = tested;
      e.touched = true;
      let sum = 0;
      for (const x of hist) sum += x;
      const avg = sum / hist.length;
      if (!(avg > this.capacityN(e)) || points.length === 0) continue;
      // The heaviest load point breaks it; a second point more than loadPointSplitM away along it makes 3 pieces.
      const byLoad = [...points].sort((a, b) => b.n - a.n);
      const main = byLoad[0];
      weightContact(w, e, main.point, main.loader);
      w.breaking.loadBreak(e, main.point, main.loader);
      const ax = principalAxis(e.shape);
      const along = (p: V3): number => {
        const l = rotate(conj(e.pose.q), sub(p, e.pose.p));
        return l.x * ax.dir.x + l.y * ax.dir.y + l.z * ax.dir.z;
      };
      const t0 = along(main.point);
      const far = byLoad.find((s) => s.foot !== null && Math.abs(along(s.point) - t0) > BREAK_TUNING.loadPointSplitM);
      if (far) w.breaking.loadBreak(e, far.point, far.loader);
      broken.add(e.id);
    }
    if (broken.size > 0) this.coverTrips(w, feet, broken, received, supportsOf);
  }

  /** Break energy ÷ loadLeverM, N (SPEC:345, 884); Infinity for a material with no break energy (ropes). */
  capacityN(e: Entity): number {
    return loadCapacityN(MATERIALS[e.material], e.mass, BREAK_TUNING.loadLeverM);
  }

  // -------------------------------------------------------------------------
  // P38 (perf): the memos (see the class comment)
  // -------------------------------------------------------------------------

  /** Whether `id` has been asleep at the end of every tick since `since` (only dynamic entities are ever awake). */
  private sleptSince(id: number, since: number): boolean {
    const t = this.awakeTick.get(id);
    return t === undefined || t < since;
  }

  /** Whether `e` is a dynamic entity asleep at this tick's end. */
  private asleep(w: World, e: Entity): boolean {
    return e.body !== null && bodyKindIsDynamic(e) && this.awakeTick.get(e.id) !== w.tick && e.body.isSleeping();
  }

  /** Whether a memo made at `tick` was made under the epochs that hold now. */
  private sameEpochs(w: World, m: Memo): boolean {
    return m.entityEpoch === w.entities.epoch && m.terrainEpoch === w.terrain.editEpoch;
  }

  /**
   * A dynamic entity's memo: the one it has if it still holds (the same epochs, and e asleep at every tick's end since it
   * was made), else a fresh one when e is asleep now (its centre of mass read now), else null.
   */
  private dynamicMemo(w: World, e: Entity): Memo | null {
    const m = this.memos.get(e.id);
    if (m && !m.fixed && this.sameEpochs(w, m) && this.sleptSince(e.id, m.tick) && this.asleep(w, e)) return m;
    if (m) this.memos.delete(e.id);
    if (!this.asleep(w, e)) return null;
    const com = e.body!.worldCom();
    const fresh: Memo = {
      tick: w.tick,
      fixed: false,
      entityEpoch: w.entities.epoch,
      terrainEpoch: w.terrain.editEpoch,
      com: { x: com.x, y: com.y, z: com.z },
      supports: null,
      supportsTick: 0,
      partners: [],
      spans: [],
    };
    this.memos.set(e.id, fresh);
    return fresh;
  }

  /** A resting weight's point: its centre of mass (from the memo while it holds). */
  private comOf(w: World, e: Entity): V3 {
    const m = this.dynamicMemo(w, e);
    const fresh = (): V3 => {
      const c = e.body!.worldCom();
      return { x: c.x, y: c.y, z: c.z };
    };
    if (!m?.com) return fresh();
    if (Loads.verify) expectSame(`centre of mass of entity ${e.id}`, m.com, fresh());
    return { ...m.com };
  }

  /**
   * supportsOf through the memo: its support owners and points are kept while e and every dynamic entity it has a contact
   * pair with have been asleep at every tick's end since they were read.
   */
  private supportsMemo(w: World, e: Entity): Support[] {
    const m = this.dynamicMemo(w, e);
    if (m?.supports && m.partners.every((id) => this.sleptSince(id, m.supportsTick))) {
      const out = this.resolve(w, m.supports);
      if (Loads.verify) expectSame(`supports of entity ${e.id}`, view(out), view(this.supportsOf(w, e)));
      return out;
    }
    const read = this.readSupports(w, e);
    if (m) {
      // Kept only when every dynamic entity it touches is asleep now too.
      const quiet = read.partners.every((id) => {
        const p = w.entities.get(id);
        return !p || !p.body || !bodyKindIsDynamic(p) || this.asleep(w, p);
      });
      m.supports = quiet ? read.raw : null;
      m.supportsTick = w.tick;
      m.partners = read.partners;
    }
    return this.resolve(w, read.raw);
  }

  /**
   * spans() for each share, through the memo: an answer at the same exact load point as the last tick's is kept, for a
   * dynamic entity while its memo holds, for a fixed or anchored one while the epochs hold (its body moves only by code).
   * The memo keeps this tick's points only.
   */
  private spansMemo(w: World, e: Entity, shares: readonly Share[]): boolean[] {
    if (!e.collider) return shares.map((s) => this.spans(w, e, s.point));
    let m: Memo | null;
    if (e.body && bodyKindIsDynamic(e)) m = this.dynamicMemo(w, e);
    else {
      m = this.memos.get(e.id) ?? null;
      if (!m || !m.fixed || !this.sameEpochs(w, m)) {
        m = {
          tick: w.tick,
          fixed: true,
          entityEpoch: w.entities.epoch,
          terrainEpoch: w.terrain.editEpoch,
          com: null,
          supports: null,
          supportsTick: 0,
          partners: [],
          spans: [],
        };
        this.memos.set(e.id, m);
      }
    }
    if (!m) return shares.map((s) => this.spans(w, e, s.point));
    const prev = m.spans;
    const next: Memo['spans'] = [];
    const at = (list: Memo['spans'], p: V3): Memo['spans'][number] | undefined => list.find((s) => s.x === p.x && s.y === p.y && s.z === p.z);
    const out = shares.map(({ point: p }) => {
      const now = at(next, p);
      if (now) return now.spans;
      const kept = at(prev, p);
      if (kept && Loads.verify) expectSame(`span test of entity ${e.id}`, kept.spans, this.spans(w, e, p));
      const entry = kept ?? { x: p.x, y: p.y, z: p.z, spans: this.spans(w, e, p) };
      next.push(entry);
      return entry.spans;
    });
    m.spans = next;
    return out;
  }

  /** Memoised support owners → supports, with whether each support entity is dynamic and unanchored read live. */
  private resolve(w: World, raw: readonly { key: number; point: V3 }[]): Support[] {
    const out: Support[] = [];
    for (const r of raw) {
      if (r.key < 0) {
        out.push({ entity: null, point: { ...r.point } });
        continue;
      }
      const s = w.entities.get(r.key);
      if (!s) continue;
      out.push({ entity: dynamicBody(s) && !w.entities.isAnchored(s) ? s : null, point: { ...r.point } });
    }
    return out;
  }

  // -------------------------------------------------------------------------

  /** The topmost entity a planted foot's disc overlaps, if it is dynamic or anchored (a fixed one is the ground). */
  private underFoot(w: World, f: Fighter, at: V3, loader: Owner): Entity | null {
    const r = (SPECIES_BODY[f.species ?? 'human']?.footRadiusM ?? SPECIES_BODY.human.footRadiusM) * f.scale;
    const disc = { kind: 'cylinder' as const, halfHeight: LOAD_TUNING.footDiscH / 2, r, sides: PHYSICS_TUNING.cylinderFacets };
    const owners = w.queries.overlaps(disc, { p: at, q: { x: 0, y: 0, z: 0, w: 1 } }, { terrain: false, entities: 'all', fighters: 'none' });
    let best: Entity | null = null;
    let bestY = -Infinity;
    for (const o of owners) {
      if (o.kind !== 'entity') continue;
      const e = w.entities.get(o.id);
      if (!e?.collider || ignores(e, loader)) continue;
      const pr = e.collider.projectPoint({ x: at.x, y: at.y + LOAD_TUNING.footDiscH, z: at.z }, false);
      const y = pr ? pr.point.y : -Infinity;
      if (y > bestY) {
        bestY = y;
        best = e;
      }
    }
    if (!best) return null;
    return dynamicBody(best) || best.state === 'anchored' ? best : null;
  }

  /** What a dynamic entity rests on (contact manifolds whose normal up into it is steeper than supportNormalY). */
  private supportsOf(w: World, e: Entity): Support[] {
    return this.resolve(w, this.readSupports(w, e).raw);
  }

  /**
   * supportsOf's reading of Rapier: the owners e rests on in key order (−1 the terrain, else the entity id), each with its
   * point (the mean of the solver contact points, or e's centre of mass without any), and every entity e has a contact
   * pair with (P38: the memo's partners).
   */
  private readSupports(w: World, e: Entity): { raw: { key: number; point: V3 }[]; partners: number[] } {
    const c = e.collider;
    if (!c) return { raw: [], partners: [] };
    const rapier = w.physics.rapier;
    const others: { key: number; o: typeof c; owner: Owner }[] = [];
    rapier.contactPairsWith(c, (o) => {
      // Null for a collider removed since the last step (the narrow phase lists the pair until the next step).
      if (!o) return;
      const owner = w.physics.ownerOf(o.handle);
      if (!owner || (owner.kind !== 'terrain' && owner.kind !== 'entity')) return;
      others.push({ key: owner.kind === 'terrain' ? 0 : owner.id, o, owner });
    });
    others.sort((a, b) => a.key - b.key || a.o.handle - b.o.handle);
    const partners: number[] = [];
    for (const { owner } of others) if (owner.kind === 'entity' && partners[partners.length - 1] !== owner.id) partners.push(owner.id);
    const byOwner = new Map<number, { sum: V3; k: number }>();
    for (const { key, o, owner } of others) {
      let nUp = 0;
      let k = 0;
      const sum = { x: 0, y: 0, z: 0 };
      rapier.contactPair(c, o, (m, flipped) => {
        const nc = m.numContacts();
        if (nc === 0) return;
        const nm = m.normal();
        // The normal out of e (Rapier's points out of the manifold's first collider); up into e is its opposite.
        const ny = (flipped ? 1 : -1) * nm.y;
        if (!(ny > LOAD_TUNING.supportNormalY)) return;
        nUp++;
        const ns = m.numSolverContacts();
        for (let i = 0; i < ns; i++) {
          const p = m.solverContactPoint(i);
          if (!p) continue;
          sum.x += p.x;
          sum.y += p.y;
          sum.z += p.z;
          k++;
        }
      });
      if (nUp === 0) continue;
      // An entity no longer in the store is left out when resolved (resolve), as it always was.
      const cur = byOwner.get(owner.kind === 'terrain' ? -1 : key);
      if (cur) {
        cur.sum = add(cur.sum, sum);
        cur.k += k;
      } else byOwner.set(owner.kind === 'terrain' ? -1 : key, { sum, k });
    }
    const raw: { key: number; point: V3 }[] = [];
    for (const key of [...byOwner.keys()].sort((a, b) => a - b)) {
      const s = byOwner.get(key)!;
      const com = e.body!.worldCom();
      raw.push({ key, point: s.k > 0 ? scale(s.sum, 1 / s.k) : { x: com.x, y: com.y, z: com.z } });
    }
    return { raw, partners };
  }

  /**
   * Whether `e` spans at `point` (I-1): its underside below the point has no terrain and no fixed or anchored support
   * within spanGapM under it.
   */
  private spans(w: World, e: Entity, point: V3): boolean {
    const c = e.collider;
    if (!c) return false;
    // Up through the entity from twice its reach below the point, as far again above it: the first hit is its underside.
    const below = 2 * bodyReach(e);
    let from = { x: point.x, y: point.y - below, z: point.z };
    let toi = c.castRay(new RAPIER.Ray(from, { x: 0, y: 1, z: 0 }), 2 * below, true);
    if (toi < 0) {
      // P28 fix: the load point isn't over the entity (a big sole on a thin stake's top): the span is judged under its
      // point nearest the load. Read at the load point, nothing was under it, and an upright driven stake under a giant's
      // foot was load-tested as if it spanned a gap, and load-broke (no impact on the foot first, SPEC:344).
      const near = c.projectPoint(point, true)?.point ?? point;
      from = { x: near.x, y: point.y - below, z: near.z };
      toi = c.castRay(new RAPIER.Ray(from, { x: 0, y: 1, z: 0 }), 2 * below, true);
    }
    const under = toi >= 0 ? from.y + toi : point.y;
    const gap = LOAD_TUNING.spanGapM;
    if (under - w.terrain.heightAt(from.x, from.z) <= gap) return false;
    const hit = w.queries.castRay({ x: from.x, y: under, z: from.z }, { x: 0, y: -1, z: 0 }, gap, {
      terrain: false,
      entities: 'static',
      exclude: { entities: [e.id] },
    });
    return hit === null;
  }

  /**
   * §4.7 step 8: a load break under a planted ruler foot whose support then drops more than ledgeTripDropFrac × its knee
   * height trips the ruler `cover`, with the lowest-id broken entity under that foot as the cause (feature 'cover'). The
   * support is found without everything giving way under the foot: every entity load-broken this tick, and every
   * covering the foot's load passed through whose dynamic supports are all giving way (a mat on ten bearers that all
   * broke falls with them; one on bearers that mostly held doesn't). At most once per ruler per tick, feet in combat
   * order.
   */
  private coverTrips(
    w: World,
    feet: readonly Foot[],
    broken: ReadonlySet<number>,
    received: ReadonlyMap<number, Share[]>,
    supportsOf: (e: Entity) => Support[],
  ): void {
    const done = new Set<number>();
    for (const foot of feet) {
      const f = foot.f;
      if (!f.ruler || done.has(f.id)) continue;
      const under = [...broken].filter((id) => received.get(id)?.some((s) => s.foot === foot)).sort((a, b) => a - b);
      if (under.length === 0) continue;
      const falling = new Set(broken);
      const via = [...foot.via].sort((a, b) => a - b);
      for (let changed = true; changed; ) {
        changed = false;
        for (const id of via) {
          if (falling.has(id)) continue;
          const c = w.entities.get(id);
          const sup = c ? supportsOf(c) : [];
          if (sup.length > 0 && sup.every((s) => s.entity !== null && falling.has(s.entity.id))) {
            falling.add(id);
            changed = true;
          }
        }
      }
      const knee = f.rig[foot.side === 'L' ? 'shinL' : 'shinR'].pos;
      const kneeH = knee.y - foot.at.y;
      const exclude = [...falling].sort((a, b) => a - b);
      const drop = foot.at.y - w.supportAt(foot.at.x, foot.at.z, foot.at.y, { excludeEntities: exclude });
      if (!(drop > RULER_BODY_TUNING.ledgeTripDropFrac * kneeH)) continue;
      done.add(f.id);
      const e = w.entities.get(under[0])!;
      const cause: ImpactCause = { kind: 'entity', entityId: e.id, fighterId: null, credit: [...e.credit], held: false, feature: 'cover' };
      w.rulers.requestTrip(f, 'cover', cause);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A standing fighter's feet carry it: alive, up, and (a player or ape) on the ground. */
function standing(w: World, f: Fighter): boolean {
  if (!f.alive || f.state === 'knockdown' || f.state === 'ko' || f.state === 'tripped') return false;
  return f.ruler ? true : w.kcc.grounded(f);
}

const dynamicBody = (e: Entity): boolean => !!e.body && e.body.isEnabled() && e.body.isDynamic();

/** P38: the store's own answer to dynamicBody (EntityStore.dynamic): a body kept dynamic and enabled by its state. */
const bodyKindIsDynamic = (e: Entity): boolean => e.state === 'free';

/** P38: a support list as plain data (entity ids and points), for the memo's verify mode. */
function view(s: readonly Support[]): { id: number | null; point: V3 }[] {
  return s.map((x) => ({ id: x.entity ? x.entity.id : null, point: x.point }));
}

/** P38: the memo's verify mode: a memoised answer must equal the fresh one bit for bit. */
function expectSame(what: string, memo: unknown, fresh: unknown): void {
  const a = JSON.stringify(memo, bits);
  const b = JSON.stringify(fresh, bits);
  if (a !== b) throw new Error(`Loads memo (P38) differs from Rapier for the ${what}: memo ${a}, fresh ${b}`);
}

/** JSON replacer keeping every number's exact bits (−0 and NaN included). */
function bits(_k: string, v: unknown): unknown {
  return typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : v;
}

/** A fresh piece in its grace ignores its breaker (RF-7): the same entity, or the same fighter by any of its parts. */
function ignores(e: Entity, loader: Owner | null): boolean {
  const g = e.grace?.from;
  if (!g || !loader) return false;
  if (g.kind === 'fighter' && loader.kind === 'fighter') return g.id === loader.id;
  if (g.kind === 'entity' && loader.kind === 'entity') return g.id === loader.id;
  return false;
}

/** At rest, or asleep (the rest radius is loose for long bodies). */
const resting = (e: Entity): boolean => e.restTicks >= PHYSICS_TUNING.restTicks || (e.body?.isSleeping() ?? false);

/** m: how far the entity's shape reaches from its origin (a bound for the underside ray). */
function bodyReach(e: Entity): number {
  const ax = principalAxis(e.shape);
  return Math.max(Math.abs(ax.min), Math.abs(ax.max)) + ax.crossHalf;
}

function resized(h: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  const k = Math.min(n, h.length);
  out.set(h.subarray(h.length - k), n - k);
  return out;
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

function conj(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number; w: number } {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function rotate(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * P28 (SPEC:344, "an impact's damage is applied before it breaks"): a ruler whose weight (a planted foot, or its body
 * lying on it) load-breaks an entity met it: that contact is recorded on the ruler as an `impact` from the entity, before
 * the break, with no energy (a weight is no blow: no damage, no Δv, no trip). Without it a loose stake crushed under a
 * fallen giant broke with no impact of its own (AC-2(b)'s gate). Nothing for any other loader.
 */
function weightContact(w: World, e: Entity, point: V3, loader: Owner | null): void {
  if (!loader || loader.kind !== 'fighter') return;
  const f = w.combat.fighters.find((x) => x.id === loader.id);
  if (!f?.ruler || !f.alive) return;
  let bone: BoneName = loader.bone ?? 'pelvis';
  if (!loader.bone) {
    let best = Infinity;
    for (const b of BONES) {
      const p = f.rig[b].pos;
      const d = Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z);
      if (d < best) [best, bone] = [d, b];
    }
  }
  applyImpact(w.combat, {
    target: f,
    bone,
    zone: BONE_ZONE[bone],
    rulerZone: null,
    point: { ...point },
    normal: { x: 0, y: -1, z: 0 },
    mEff: e.mass,
    vn: 0,
    sharpness: 0,
    energy: 0,
    toughness: 0,
    dv: { x: 0, y: 0, z: 0 },
    impactorMass: e.mass,
    cause: { kind: 'entity', entityId: e.id, fighterId: null, credit: [...e.credit], held: false, feature: 'fall' },
  });
}
