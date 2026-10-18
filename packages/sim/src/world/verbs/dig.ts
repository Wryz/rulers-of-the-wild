// Dig (docs/M1-DESIGN.md §5.10, §4.13): strike-digs with a digging tool and hand-digs, the dirt policy (merge into a
// pile within pileMergeR, a new pile while fewer than maxPilesNear lie near, else the masked, set-back berm through
// terrain.raise), nav and cover updates, stakes un-anchored when their driven end is exposed.
//
// - By strike (strike.ts): a qualifying strike of a tool that digs (§5.0) that meets the terrain is one `digAt` at the
//   struck point with depthMul 1 (0.15 m peak, the 0.5 m cone, the 3 m floor: terrain.lower). The radial's Dig with
//   such a tool plays its committed swing at the ground point (cut.ts aimedSwing), so the hole appears where the blade
//   visibly goes in.
// - By hand: `{ verb: 'dig', target: 0, at, charge: 1 }` with empty hands is a repeating work action, one scoop every
//   VERB_TUNING.handDigFrames (pose digScoop) at handDigDepthMul of a strike, while the player stays put (SPEC:241
//   "hands (slow)"); each scoop lands only within the hands' reach of the feet (inTakeReach, as a take's does).
// - Where the dirt goes (§4.13): the spoil point S = terrain.findSpoilPoint (no ever-dug vertex within spoilSetbackM, so
//   spoil never refills the hole, RT-2). Then (1) a dirt pile within pileMergeR of S that stays ≤ pileCapKg grows (its
//   hull rescaled to the new volume); else (2) while fewer than maxPilesNear piles lie within pilesNearR of S, a new
//   pile (a low 8-point hull of the volume) is set down at S (or beside the piles and things already there,
//   newPileNear); else (3) the volume is raised into the terrain at S, the remainder at the next spoil point (the berm,
//   settled at TERRAIN_TUNING.spoilReposeDeg: a sloped mound whose inner flank comes down to the setback ring, SIM-fix4;
//   spoil a later dig brings into the setback slides off and is poured again by terrain.lower).
//   pilesNearR (15 m) is the per-pit budget, so a ruler pit makes at most 12 piles and a berm, not 1,180 bodies. Dirt
//   the berm can't take (nothing free within spoilSearchMaxM) is set down as a pile at the nearest free spot beyond the
//   setback (placeFar), never lost silently (spoilLostM3 counts the float rounding).
// - Then: nav tiles under the dig and the spoil marked dirty; ground cover under the dig cleared; every anchored stake
//   whose driven end is now above the terrain un-anchored (free, awake); a `dig` event (the noise bus hears it).
//
// A dirt pile is any free entity of the terrain's material (TERRAIN_TUNING.material): read by its properties, never by
// its look (AC-1).
import { getPose } from '../../body/poses';
import type { VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { defineTuning } from '../../tuning/registry';
import { groundRestY } from '../factory';
import { MATERIALS, propertyAtMost } from '../materials';
import { principalAxis, shapeVolume } from '../shapes';
import { TERRAIN_TUNING } from '../terrain';
import type { Entity, Shape, V3 } from '../types';
import type { World } from '../world';
import { aimedSwing, committedSwing, wieldedEntity } from './cut';
import { inTakeReach } from './hands';
import { cmdPoint, registerVerb, verbEvent, type VerbHandler } from './targets';
import { toolDigs, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

/**
 * Dig's own starting values. DEVIATION (P15): §13.0 adds no tuning table after P05, but P05 registered none for this
 * file and §9.1 has no row for these (§4.13 says only "a low 8-point hull of the volume"; §5.10 gives the scoop's
 * frames, not when in them the dirt moves); CLAUDE.md puts every starting value in a live tuning table, so they live
 * here (as P06's ENTITY_TUNING and P07's FACTORY_TUNING do).
 */
export const DIG_TUNING = defineTuning(
  'DIG_TUNING',
  'Verbs › dig',
  {
    pileHeightRatio: 0.5,
    pileTopRatio: 0.3,
    handDigActFrac: 0.5,
  },
  {
    pileHeightRatio: {
      unit: 'height ÷ base half-width',
      source: 'NEW: §4.13 "a low 8-point hull of the volume": a square frustum whose sides lie at ≈ 35°, loose dirt\'s angle of repose',
      min: 0.01,
    },
    pileTopRatio: { unit: 'top half-width ÷ base half-width', source: 'NEW: §4.13 "a low 8-point hull of the volume" (a square frustum)', min: 0, max: 1 },
    handDigActFrac: { unit: '× handDigFrames', source: 'NEW: §5.10 (the scoop lands at this fraction of the work action)', min: 0, max: 1 },
  },
);

const IDQ = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
/**
 * Spoil left to place below which the berm loop stops: raise is exact up to the float32 rounding of the heights it
 * writes (≈ 1e-7 m per vertex), so a request of a few nm³ can't move any vertex. A numerical tolerance, not a
 * starting value.
 */
const SPOIL_EPS_M3 = 1e-8;

// ---------------------------------------------------------------------------
// Dirt piles
// ---------------------------------------------------------------------------

/**
 * A dirt pile's hull for `volumeM3` (§4.13: "a low 8-point hull"): a square frustum, base half-width a on its local
 * y = 0 plane, top half-width pileTopRatio·a at height pileHeightRatio·a, so V = (4/3)·h·(a² + ab + b²); its faces no
 * steeper than TERRAIN_TUNING.spoilReposeDeg (SIM-fix4: the top is narrowed, or the height held, to keep them so). Its origin is
 * the middle of its base: rescaled in place, a pile keeps its base on what it rests on.
 */
export function dirtPileShape(volumeM3: number): Extract<Shape, { kind: 'hull' }> {
  if (!(volumeM3 > 0) || !Number.isFinite(volumeM3)) throw new Error(`dirtPileShape: a pile's volume must be positive, not ${volumeM3}`);
  const T = DIG_TUNING;
  // SIM-fix4: a pile's faces (rise h over run a − b) are never steeper than loose dirt's angle of repose
  // (TERRAIN_TUNING.spoilReposeDeg, as the terrain's spoil): the height ratio is held to tan(repose) and the top shrunk
  // until its faces are that steep at most.
  const tanRepose = Math.tan((TERRAIN_TUNING.spoilReposeDeg * Math.PI) / 180);
  const hr = Math.min(T.pileHeightRatio, tanRepose);
  const tr = Math.min(1 - hr / tanRepose, Math.max(0, T.pileTopRatio));
  const a = Math.cbrt(volumeM3 / ((4 / 3) * hr * (1 + tr + tr * tr)));
  const b = tr * a;
  const h = hr * a;
  return {
    kind: 'hull',
    points: [-a, 0, -a, a, 0, -a, a, 0, a, -a, 0, a, -b, h, -b, b, h, -b, b, h, b, -b, h, b],
  };
}

/** Is the entity a dirt pile (§4.13): free (dynamic), of the terrain's material? */
export function isDirtPile(e: Entity): boolean {
  return e.state === 'free' && e.material === TERRAIN_TUNING.material && e.plant === null && e.rope === null && !!e.body?.isEnabled();
}

/** The world-space bounds of a pile's hull at its pose. */
function hullBounds(e: Entity, points: readonly number[]): { min: V3; max: V3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i + 2 < points.length; i += 3) {
    const q = verbGeom.pointToWorld(e.pose, { x: points[i], y: points[i + 1], z: points[i + 2] });
    min.x = Math.min(min.x, q.x);
    min.y = Math.min(min.y, q.y);
    min.z = Math.min(min.z, q.z);
    max.x = Math.max(max.x, q.x);
    max.y = Math.max(max.y, q.y);
    max.z = Math.max(max.z, q.z);
  }
  return { min, max };
}

/** Every dirt pile's world bounds (piles made this tick included: queries find them only after the next step). */
function pileBounds(w: World): { min: V3; max: V3 }[] {
  const out: { min: V3; max: V3 }[] = [];
  for (const e of w.entities.all()) if (isDirtPile(e) && e.shape.kind === 'hull') out.push(hullBounds(e, e.shape.points));
  return out;
}

/**
 * Whether a pile `shape` (base half-width `a`) can be set down at (x, z): its footprint inside the terrain, clear of every
 * pile's bounds (piles of this tick too), and, resting on the ground placeDropM clear, overlapping no entity and no
 * fighter's capsule (queries.overlaps, as of the last step).
 */
function spotFree(w: World, x: number, z: number, shape: Shape, a: number, piles: readonly { min: V3; max: V3 }[]): boolean {
  const t = w.terrain;
  if (x - a < t.minX || z - a < t.minZ || x + a > t.minX + t.tilesX * t.tileSize || z + a > t.minZ + t.tilesZ * t.tileSize) return false;
  if (piles.some((b) => !(b.max.x <= x - a || b.min.x >= x + a || b.max.z <= z - a || b.min.z >= z + a))) return false;
  const y = groundRestY(w, x, z, shape, IDQ) + VERB_TUNING.placeDropM;
  return w.queries.overlaps(shape, { p: { x, y, z }, q: IDQ }, { terrain: false, entities: 'all', ropes: false, fighters: 'kcc' }).length === 0;
}

/**
 * The first spot for a pile on rings `2a` apart around `c` (ring k0 to k1; ring 0 is `c` itself; each ring in a fixed
 * angular order from +x toward +z) that keeps spoilSetbackM from dug ground and is free (spotFree); null when none is.
 */
function ringSpot(w: World, c: { x: number; z: number }, shape: Shape, a: number, k0: number, k1: number): { x: number; z: number } | null {
  const t = w.terrain;
  const piles = pileBounds(w);
  for (let k = k0; k <= k1; k++) {
    const n = k === 0 ? 1 : 6 * k;
    for (let i = 0; i < n; i++) {
      const th = (2 * Math.PI * i) / n;
      const x = c.x + 2 * a * k * Math.cos(th);
      const z = c.z + 2 * a * k * Math.sin(th);
      const v = t.vertexIndex(x, z);
      if (t.isNearDug(v.gi, v.gj)) continue;
      if (spotFree(w, x, z, shape, a, piles)) return { x, z };
    }
  }
  return null;
}

/**
 * A new pile of `volumeM3` (§4.13: "created at S"), set down resting on the ground placeDropM clear (as Place sets a
 * thing down). INTERPRETATION: §4.13 doesn't say what happens when S is taken. S is the terrain's first spoil point,
 * which no pile moves, so while the dug ground doesn't grow every new pile would land on the last (one set on top of
 * another stood in a balanced dirt tower 12 piles high, rule 3). So the pile goes at S when S is free (spotFree: inside
 * the terrain, clear of every pile and entity), else at the first free spot on rings around S that also keeps
 * spoilSetbackM from dug ground, at most maxPilesNear rings out: dirt heaped beside dirt. null when there is none (the
 * dirt then goes to the berm).
 */
function newPileNear(w: World, S: { x: number; z: number }, volumeM3: number, credit: readonly string[]): Entity | null {
  const shape = dirtPileShape(volumeM3);
  const a = shape.points[3];
  const at = ringSpot(w, S, shape, a, 0, Math.max(1, Math.ceil(TERRAIN_TUNING.maxPilesNear)));
  return at ? setPile(w, at, shape, credit) : null;
}

function setPile(w: World, at: { x: number; z: number }, shape: Shape, credit: readonly string[]): Entity {
  const y = groundRestY(w, at.x, at.z, shape, IDQ);
  return w.entities.create({
    material: TERRAIN_TUNING.material,
    shape,
    p: { x: at.x, y: y + VERB_TUNING.placeDropM, z: at.z },
    q: IDQ,
    state: 'free',
    look: 'dirtPile',
    credit: [...credit],
  });
}

/** The nearest pile within pileMergeR of (x, z) that stays ≤ pileCapKg with `volumeM3` more (ties: the lower id), or null. */
function pileToGrow(w: World, x: number, z: number, volumeM3: number): Entity | null {
  const T = TERRAIN_TUNING;
  const density = MATERIALS[T.material].density;
  let grow: Entity | null = null;
  let growD = Infinity;
  for (const e of w.entities.all()) {
    if (!isDirtPile(e)) continue;
    const d = Math.hypot(e.pose.p.x - x, e.pose.p.z - z);
    if (d <= T.pileMergeR && d < growD && propertyAtMost(e.mass + density * volumeM3, T.pileCapKg)) {
      grow = e;
      growD = d;
    }
  }
  return grow;
}

/** The pile grows by `volumeM3`: its hull rescaled to the new volume about its base (mass = density × volume). */
function growPile(w: World, e: Entity, volumeM3: number, credit: readonly string[]): void {
  w.entities.reshape(e, dirtPileShape(shapeVolume(e.shape) + volumeM3));
  e.body?.wakeUp();
  for (const id of credit) if (!e.credit.includes(id)) e.credit = [...e.credit, id].sort();
}

/** Dirt no rule could place, per world (a dev read-out, never saved and never read by the sim). */
const LOST = new WeakMap<World, number>();

/**
 * The volume of dirt (m³) a world's digs could not place since it was built (a dev read-out: float32 rounding of the
 * raised heights, a few nm³ a dig, or a dig with no free spot anywhere on the terrain). Never saved; no rule reads it.
 */
export function spoilLostM3(w: World): number {
  return LOST.get(w) ?? 0;
}

/**
 * Spoil left over (m³) at or below which it is the float32 rounding of raise's heights (≈ 1e-7 m per vertex, a few
 * grams of dirt), counted lost rather than made into a pile. A numerical tolerance, not a starting value.
 */
const SPOIL_ROUNDING_M3 = 1e-6;

/**
 * Dirt the berm couldn't take (no spoil point within spoilSearchMaxM: everything near is dug or at its cap): set down
 * as a pile at the nearest free spot beyond the dug ground and its setback, searching rings around the dig to the
 * terrain's edge (a pile there grows when it can). DEVIATION (P15 review: "don't lose dirt silently"): this pile is over
 * maxPilesNear's budget; §4.13 places spoil only within spoilSearchMaxM. A remainder at the float rounding level, or
 * one with no free spot on the whole terrain, is counted lost (spoilLostM3).
 * TODO "spoil beyond the search": a far pile is a body the 600-body budget (SPEC:803) doesn't count on; M3's terrain
 * edits may want a wider spoil search instead.
 */
function placeFar(w: World, x: number, z: number, volumeM3: number, credit: readonly string[]): { pile: number | null; point: { x: number; z: number } | null } {
  if (!(volumeM3 > SPOIL_ROUNDING_M3)) {
    LOST.set(w, spoilLostM3(w) + Math.max(0, volumeM3));
    return { pile: null, point: null };
  }
  const shape = dirtPileShape(volumeM3);
  const a = shape.points[3];
  const T = TERRAIN_TUNING;
  const t = w.terrain;
  const k0 = Math.max(1, Math.floor((T.digRadiusM + T.spoilMinGapM) / (2 * a)));
  const extent = Math.max(t.tilesX * t.tileSize, t.tilesZ * t.tileSize);
  const at = ringSpot(w, { x, z }, shape, a, k0, Math.ceil(extent / (2 * a)));
  if (!at) {
    LOST.set(w, spoilLostM3(w) + volumeM3);
    return { pile: null, point: null };
  }
  const grow = pileToGrow(w, at.x, at.z, volumeM3);
  if (grow) {
    growPile(w, grow, volumeM3, credit);
    return { pile: grow.id, point: at };
  }
  return { pile: setPile(w, at, shape, credit).id, point: at };
}

/**
 * The dirt policy of §4.13 for `volumeM3` dug at (x, z): a pile within pileMergeR of the spoil point S grows, else a new
 * pile at S (or beside it, newPileNear) while fewer than maxPilesNear lie within pilesNearR of S, else the berm
 * (terrain.raise at S, the remainder at the next spoil point). Dirt the berm can't take goes to placeFar. Returns the
 * pile that took the dirt (null: the berm) and the spoil points used.
 */
export function placeSpoil(w: World, x: number, z: number, volumeM3: number, credit: readonly string[]): { pile: number | null; points: { x: number; z: number }[] } {
  const T = TERRAIN_TUNING;
  if (!(volumeM3 > 0)) return { pile: null, points: [] };
  const S = w.terrain.findSpoilPoint(x, z);
  const points: { x: number; z: number }[] = [];
  let rest = volumeM3;
  if (S) {
    const grow = pileToGrow(w, S.x, S.z, volumeM3);
    if (grow) {
      growPile(w, grow, volumeM3, credit);
      return { pile: grow.id, points: [S] };
    }
    let near = 0;
    for (const e of w.entities.all()) if (isDirtPile(e) && Math.hypot(e.pose.p.x - S.x, e.pose.p.z - S.z) <= T.pilesNearR) near++;
    if (near < T.maxPilesNear) {
      const pile = newPileNear(w, S, volumeM3, credit);
      if (pile) return { pile: pile.id, points: [S] };
    }
    // The berm: raised at the spoil point, the rest at the next one (raise never touches dug ground or its setback).
    let s: { x: number; z: number } | null = S;
    while (s && rest > SPOIL_EPS_M3) {
      const placed = w.terrain.raise(s.x, s.z, rest).raisedM3;
      points.push(s);
      if (!(placed > 0)) break;
      rest -= placed;
      if (rest > SPOIL_EPS_M3) s = w.terrain.findSpoilPoint(x, z);
    }
    if (!(rest > SPOIL_EPS_M3)) return { pile: null, points };
  }
  const far = placeFar(w, x, z, rest, credit);
  if (far.point) points.push(far.point);
  return { pile: far.pile, points };
}

// ---------------------------------------------------------------------------
// One dig (§4.13)
// ---------------------------------------------------------------------------

/**
 * One dig at (x, z) (a qualifying strike: depthMul 1; a hand scoop: handDigDepthMul): terrain.lower, the dirt policy
 * (placeSpoil), nav tiles dirty under the dig and the spoil, ground cover cleared under the dig, anchored stakes whose
 * driven end is now above the terrain un-anchored, and a `dig` event. `by` is the digger (credit for the piles; null
 * for none). Returns the volume dug, the pile that took it (null: the berm) and the spoil points used.
 */
export function digAt(w: World, x: number, z: number, depthMul: number, by: Fighter | null): { volumeM3: number; pile: number | null; spoil: { x: number; z: number }[] } {
  const T = TERRAIN_TUNING;
  const r = T.digRadiusM;
  const credit = by?.playerId ? [by.playerId] : [];
  const dug = w.terrain.lower(x, z, depthMul);
  // Spoil the dig made slide (off the new setback ring, SIM-fix4) was poured again by lower; what found no spoil point
  // is set down as dirt the berm can't take.
  const settledFar = dug.unplacedM3 > 0 ? placeFar(w, x, z, dug.unplacedM3, credit).point : null;
  const spoil = placeSpoil(w, x, z, dug.volumeM3, credit);
  const spoilPoints = [...dug.spoil, ...(settledFar ? [settledFar] : []), ...spoil.points];
  const y = w.terrain.heightAt(x, z);
  // The navmesh (phase 16 also finds terrain and entity changes by its own scan; marking them is cheap and immediate).
  if (w.nav) {
    w.nav.markDirty({ min: { x: x - r, y: y - T.maxDigDepthM, z: z - r }, max: { x: x + r, y: y + T.spoilMaxRiseM, z: z + r } }, 'dig');
    for (const s of spoilPoints) {
      const sy = w.terrain.heightAt(s.x, s.z);
      w.nav.markDirty({ min: { x: s.x - T.pileMergeR, y: sy - T.spoilMaxRiseM, z: s.z - T.pileMergeR }, max: { x: s.x + T.pileMergeR, y: sy + T.spoilMaxRiseM, z: s.z + T.pileMergeR } }, 'spoil');
    }
  }
  // Ground cover under the dig (the cells under the cone and its centre).
  for (const [cx, cz] of [
    [x, z],
    [x - r, z - r],
    [x + r, z - r],
    [x - r, z + r],
    [x + r, z + r],
  ]) {
    if (w.cover.at(cx, cz) > 0) w.cover.set(cx, cz, 0);
  }
  // Stakes whose driven end the dig exposed (§2.3, §4.13): free and awake.
  for (const e of w.entities.all()) {
    if (e.state !== 'anchored') continue;
    const ax = principalAxis(e.shape);
    const reach = Math.max(Math.abs(ax.min), Math.abs(ax.max)) + ax.crossHalf;
    if (Math.hypot(e.pose.p.x - x, e.pose.p.z - z) > r + reach) continue;
    if (w.entities.depthBelowGround(e.shape, e.pose) <= 0) w.entities.unanchor(e);
  }
  w.events.push({ type: 'dig', point: { x, y, z }, volumeM3: dug.volumeM3, pile: spoil.pile });
  return { volumeM3: dug.volumeM3, pile: spoil.pile, spoil: spoil.points };
}

// ---------------------------------------------------------------------------
// The dig verb (§5.0, §5.10)
// ---------------------------------------------------------------------------

/** A dig command's ground point: its `at` on the terrain. */
function groundPoint(w: World, cmd: VerbCommand): V3 | null {
  if (!cmd.at) return null;
  const p = cmdPoint(cmd.at);
  return { x: p.x, y: w.terrain.heightAt(p.x, p.z), z: p.z };
}

/**
 * dig (§5.0, §5.10): `{ verb: 'dig', target: 0, at, charge }` on the ground. With a wielded tool that digs: the tool's
 * committed swing at the ground point (aimedSwing: a turn at faceTurnRate, then the swing), once (the strike digs where
 * it meets the ground, strike.ts); with empty hands: hand-digging, on while charge > 0, one scoop per work action of
 * handDigFrames (pose digScoop) landing at handDigActFrac of it within the hands' reach (inTakeReach), at
 * handDigDepthMul of a strike. Anything else in the hands is refused `noDigTool`.
 */
const digVerb: VerbHandler = {
  verb: 'dig',
  target: 'ground',
  continuous: 'repeat',
  validate(w, f, cmd, stage) {
    const inv = f.inventory;
    if (!inv) return 'cantAct';
    if (inv.hands) {
      const tool = wieldedEntity(f);
      return tool !== null && toolDigs(w, tool) ? null : 'noDigTool';
    }
    if (stage === 'land') {
      const p = groundPoint(w, cmd);
      if (!p || !inTakeReach(f, p)) return 'outOfReach';
    }
    return null;
  },
  start(w, f, cmd) {
    const p = groundPoint(w, cmd);
    if (!p) return null;
    if (f.inventory?.hands) {
      // A strike-dig is one swing, not a repeating verb (the player swings again to dig again).
      w.verbs.stopContinuous(f);
      return aimedSwing(w, f, 0, cmdPoint(cmd.at!), 'dig');
    }
    const frames = Math.max(1, Math.round(VERB_TUNING.handDigFrames));
    const actAt = Math.max(1, Math.min(frames, Math.round(frames * DIG_TUNING.handDigActFrac)));
    return {
      frames,
      actAt,
      faceAt: p,
      keys: [
        { f: actAt, pose: getPose('digScoop'), ease: 'inOut' },
        { f: frames, pose: getPose('guard'), ease: 'inOut' },
      ],
    };
  },
  land(w, f, cmd) {
    if (f.inventory?.hands) {
      // The aimed swing's turn landed: the swing.
      const r = committedSwing(w, f);
      if (r) verbEvent(w, f, 'dig', false, r);
      return;
    }
    const p = groundPoint(w, cmd)!;
    digAt(w, p.x, p.z, VERB_TUNING.handDigDepthMul, f);
    verbEvent(w, f, 'dig', true);
  },
};

registerVerb(digVerb);
