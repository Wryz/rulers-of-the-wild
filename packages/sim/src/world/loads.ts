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
//   ledgeTripDropFrac × knee height trips the ruler `cover` (§4.7 step 8).
import RAPIER from '@dimforge/rapier3d-compat';
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
  foot: { f: Fighter; side: 'L' | 'R'; at: V3 } | null;
}

export class Loads {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Phase 11 (see the top of this file). */
  update(w: World): void {
    const received = new Map<number, Share[]>();
    const supports = new Map<number, Support[]>();
    const supportsOf = (e: Entity): Support[] => {
      let s = supports.get(e.id);
      if (!s) supports.set(e.id, (s = this.supportsOf(w, e)));
      return s;
    };
    const deliver = (e: Entity, n: number, point: V3, loader: Owner | null, foot: Share['foot'], depth: number, seen: ReadonlySet<number>): void => {
      if (!(n > 0)) return;
      const sup = dynamicBody(e) ? supportsOf(e) : [];
      const covering = sup.some((s) => s.entity !== null);
      if (covering && depth < LOAD_TUNING.maxSpreadDepth) {
        const share = n / sup.length;
        const next = new Set(seen).add(e.id);
        for (const s of sup) if (s.entity && !next.has(s.entity.id)) deliver(s.entity, share, s.point, loader, foot, depth + 1, next);
        return;
      }
      let l = received.get(e.id);
      if (!l) received.set(e.id, (l = []));
      l.push({ n, point: { ...point }, loader, foot });
    };
    const g = Math.abs(WORLD_TUNING.gravityY);

    // Foot loads.
    for (const f of w.combat.fighters) {
      if (!standing(w, f)) continue;
      const planted = (['L', 'R'] as const).filter((s) => !f.footwork.foot(s).stepping);
      if (planted.length === 0) continue;
      const share = (f.mass * g) / planted.length;
      const loader: Owner = { kind: 'fighter', id: f.id, part: f.ruler ? 'ruler' : 'zone' };
      for (const side of planted) {
        const fp = f.footwork.foot(side).pos;
        const at = { x: fp.x, y: fp.y, z: fp.z };
        const e = this.underFoot(w, f, at);
        if (e) deliver(e, share, at, loader, { f, side, at }, 0, new Set());
      }
    }
    // Resting weights.
    for (const e of w.entities.all()) {
      if (!dynamicBody(e) || !resting(e)) continue;
      const com = e.body!.worldCom();
      deliver(e, e.mass * g, { x: com.x, y: com.y, z: com.z }, { kind: 'entity', id: e.id }, null, 0, new Set());
    }

    // Tested loads, the averages, load breaks (entity id order).
    const n = Math.max(1, Math.round(LOAD_TUNING.loadWindowS / DT));
    for (const e of w.entities.all()) {
      const shares = received.get(e.id);
      let tested = 0;
      const points: Share[] = [];
      if (shares) {
        for (const s of shares) {
          if (!this.spans(w, e, s.point)) continue;
          tested += s.n;
          points.push(s);
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
      w.breaking.loadBreak(e, main.point, main.loader);
      const ax = principalAxis(e.shape);
      const along = (p: V3): number => {
        const l = rotate(conj(e.pose.q), sub(p, e.pose.p));
        return l.x * ax.dir.x + l.y * ax.dir.y + l.z * ax.dir.z;
      };
      const t0 = along(main.point);
      const far = byLoad.find((s) => s.foot !== null && Math.abs(along(s.point) - t0) > BREAK_TUNING.loadPointSplitM);
      if (far) w.breaking.loadBreak(e, far.point, far.loader);
      this.coverTrips(w, e, points);
    }
  }

  /** Break energy ÷ loadLeverM, N (SPEC:345, 884); Infinity for a material with no break energy (ropes). */
  capacityN(e: Entity): number {
    return loadCapacityN(MATERIALS[e.material], e.mass, BREAK_TUNING.loadLeverM);
  }

  // -------------------------------------------------------------------------

  /** The topmost entity a planted foot's disc overlaps, if it is dynamic or anchored (a fixed one is the ground). */
  private underFoot(w: World, f: Fighter, at: V3): Entity | null {
    const r = (SPECIES_BODY[f.species ?? 'human']?.footRadiusM ?? SPECIES_BODY.human.footRadiusM) * f.scale;
    const disc = { kind: 'cylinder' as const, halfHeight: LOAD_TUNING.footDiscH / 2, r, sides: PHYSICS_TUNING.cylinderFacets };
    const owners = w.queries.overlaps(disc, { p: at, q: { x: 0, y: 0, z: 0, w: 1 } }, { terrain: false, entities: 'all', fighters: 'none' });
    let best: Entity | null = null;
    let bestY = -Infinity;
    for (const o of owners) {
      if (o.kind !== 'entity') continue;
      const e = w.entities.get(o.id);
      if (!e?.collider) continue;
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
    const c = e.collider;
    if (!c) return [];
    const rapier = w.physics.rapier;
    const others: { key: number; o: typeof c; owner: Owner }[] = [];
    rapier.contactPairsWith(c, (o) => {
      const owner = w.physics.ownerOf(o.handle);
      if (!owner || (owner.kind !== 'terrain' && owner.kind !== 'entity')) return;
      others.push({ key: owner.kind === 'terrain' ? 0 : owner.id, o, owner });
    });
    others.sort((a, b) => a.key - b.key || a.o.handle - b.o.handle);
    const byOwner = new Map<number, { entity: Entity | null; sum: V3; k: number }>();
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
      let entity: Entity | null = null;
      if (owner.kind === 'entity') {
        const s = w.entities.get(owner.id);
        if (!s) continue;
        entity = dynamicBody(s) && !w.entities.isAnchored(s) ? s : null;
      }
      const cur = byOwner.get(owner.kind === 'terrain' ? -1 : key);
      if (cur) {
        cur.sum = add(cur.sum, sum);
        cur.k += k;
      } else byOwner.set(owner.kind === 'terrain' ? -1 : key, { entity, sum, k });
    }
    const out: Support[] = [];
    for (const key of [...byOwner.keys()].sort((a, b) => a - b)) {
      const s = byOwner.get(key)!;
      const com = e.body!.worldCom();
      out.push({ entity: s.entity, point: s.k > 0 ? scale(s.sum, 1 / s.k) : { x: com.x, y: com.y, z: com.z } });
    }
    return out;
  }

  /**
   * Whether `e` spans at `point` (I-1): its underside below the point has no terrain and no fixed or anchored support
   * within spanGapM under it.
   */
  private spans(w: World, e: Entity, point: V3): boolean {
    const c = e.collider;
    if (!c) return false;
    const reach = bodyReach(e);
    const from = { x: point.x, y: point.y - 2 * reach, z: point.z };
    const toi = c.castRay(new RAPIER.Ray(from, { x: 0, y: 1, z: 0 }), 4 * reach, true);
    const under = toi >= 0 ? from.y + toi : point.y;
    const gap = LOAD_TUNING.spanGapM;
    if (under - w.terrain.heightAt(point.x, point.z) <= gap) return false;
    const hit = w.queries.castRay({ x: point.x, y: under, z: point.z }, { x: 0, y: -1, z: 0 }, gap, {
      terrain: false,
      entities: 'static',
      exclude: { entities: [e.id] },
    });
    return hit === null;
  }

  /**
   * §4.7 step 8: a load break under a planted ruler foot whose support then drops more than ledgeTripDropFrac × its knee
   * height trips the ruler `cover`, with the broken entity as the cause (feature 'cover').
   */
  private coverTrips(w: World, e: Entity, points: readonly Share[]): void {
    const done = new Set<number>();
    for (const s of points) {
      const foot = s.foot;
      if (!foot || !foot.f.ruler || done.has(foot.f.id)) continue;
      done.add(foot.f.id);
      const f = foot.f;
      const knee = f.rig[foot.side === 'L' ? 'shinL' : 'shinR'].pos;
      const kneeH = knee.y - foot.at.y;
      const drop = foot.at.y - w.supportAt(foot.at.x, foot.at.z, foot.at.y, { excludeEntities: [e.id] });
      if (!(drop > RULER_BODY_TUNING.ledgeTripDropFrac * kneeH)) continue;
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
