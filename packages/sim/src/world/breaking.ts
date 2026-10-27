// Breaking (docs/M1-DESIGN.md §1.5.7, §4.10): integrity loss from impacts, load breaks across the axis, pieces in id
// order, piece grace until clear of the breaker (phase 12).
//
// - `hit` (phase 9c, after the creature damage of 9b, SPEC:344): a scored impact or strike push of energy E on an
//   entity. Lashed structures fail at their joints first: every lash or hinge on it whose break energy E beats snaps.
//   An anchored stake struck with E > capacity × loadLeverM is knocked loose (§2.3). Integrity falls by
//   max(0, E − E_b)/E_b × integrityPerExcess, E_b = strength × mass (SPEC:344).
// - `loadBreak` (phase 11, loads.ts): a sustained load above capacity; the entity snaps across its long axis at the
//   load point (2 pieces, or 3 when two load points are more than loadPointSplitM apart along the axis, RT-7). A load
//   break takes precedence over an impact break in the same tick.
// - `update` (phase 12): every entity at integrity 0, in id order, is replaced by its pieces (an impact break: n =
//   clamp(2 + ⌊E/E_b − 1⌋, piecesMin, piecesMax) pieces from `fracture` with the world stream; ids in order, bodies
//   made in id order), each with the parent's material, moisture, temperature, age and credit, integrity 1, the
//   parent's rotation, the velocity of its centre from the parent's (v + ω × (c − com)) and the sharp points it holds.
//   The parent's joints go first: a rope's end on it becomes loose where it was (`joint loose`), any other joint is
//   released. A `break` event names the pieces.
// - Grace until clear (RF-7): every piece of a break with a breaker ignores the breaker and every fighter (§2.11's grace
//   filter, EntityStore.setGrace) for at least pieceGraceTicks, then until it no longer overlaps the breaker's colliders
//   (tested each tick from minUntil); a piece still inside its breaker at maxUntil is crushed (removed, `break` event
//   with no pieces). A terrain or rope breaker can't be overlapped by a shape test, so its pieces clear at minUntil.
import type RAPIER from '@dimforge/rapier3d-compat';
import { defineTuning } from '../tuning/registry';
import { breakEnergyJ, MATERIALS } from './materials';
import { crossCut, fracture, GEOM_EPS, principalAxis, rapierHullOk, scaleShape, shapeContains, shapeVolume, type ShapePiece } from './shapes';
import type { Entity, Owner, Pose3, Quat, Shape, SharpPoint, V3 } from './types';
import type { World } from './world';

export const BREAK_TUNING = defineTuning(
  'BREAK_TUNING',
  'Materials & joints › breaking',
  {
    integrityPerExcess: 1,
    piecesMin: 2,
    piecesMax: 4,
    loadLeverM: 0.1,
    pieceGraceTicks: 10,
    pieceGraceMaxTicks: 600,
    loadPointSplitM: 0.5,
    pieceMinVolumeM3: 1e-6,
    loadBreakMinKg: 0.25,
  },
  {
    integrityPerExcess: { unit: '—', source: 'D-17' },
    // fracture() makes 2, 3 or 4 pieces: the piece count is clamped into that range whatever these say.
    piecesMin: { unit: 'pieces', source: 'SPEC:344 (fracture() makes 2-4)', min: 2, max: 4, step: 1 },
    piecesMax: { unit: 'pieces', source: 'SPEC:344 (fracture() makes 2-4)', min: 2, max: 4, step: 1 },
    loadLeverM: { unit: 'm', source: 'SPEC:345, 884' },
    pieceGraceTicks: { unit: 'ticks', source: 'NEW: C §7 item 7 (the minimum; the grace lasts until the piece is clear)' },
    pieceGraceMaxTicks: { unit: 'ticks', source: 'NEW: a piece still inside its breaker after 10 s is crushed (RF-7)' },
    loadPointSplitM: { unit: 'm along the axis', source: 'NEW: §4.10 (3 pieces "when two load points are more than 0.5 m apart", RT-7)' },
    pieceMinVolumeM3: { unit: 'm³', source: 'NEW (SIM-fix3): a smaller piece (a sliver cut at an end) is merged into its nearest neighbour' },
    loadBreakMinKg: {
      unit: 'kg',
      source:
        "NEW (P28): a load break of anything lighter crumbles it to nothing (rule 10) instead of snapping it in two: leaves (1 J/kg) carry 1.02 × their own weight, so a heap of grass-bundle pieces in a pit load-broke itself into ever smaller pieces, ≈ 200 a tick",
      min: 0,
    },
  },
);

/** One entity's break this tick (filled in phases 9c and 11, spent in phase 12). */
interface PendingBreak {
  kind: 'impact' | 'load';
  /** J: the impact that broke it (0 for a load break). */
  energy: number;
  /** E / E_b of that impact (the piece count). */
  ratio: number;
  point: V3;
  breaker: Owner | null;
  /** Load breaks: the load points, heaviest first. */
  loadPoints: V3[];
}

export class Breaking {
  readonly world: World;
  /** Entity id → its break this tick; empty at every tick end. */
  private readonly pending = new Map<number, PendingBreak>();

  constructor(world: World) {
    this.world = world;
  }

  /** An impact of energy E on e (phase 9c): lash and hinge breaks, a stake knocked loose, integrity loss (§4.10). */
  hit(e: Entity, E: number, point: V3, breaker: Owner | null): void {
    const w = this.world;
    if (!(E > 0) || !Number.isFinite(E) || w.entities.get(e.id) !== e) return;
    // Lashed structures fail at their joints first (SPEC:344): 600-1,800 J is below most log break energies.
    for (const jid of [...e.joints]) {
      const j = w.joints.get(jid);
      if (j && (j.kind === 'lash' || j.kind === 'hinge') && E > j.breakEnergyJ) w.joints.remove(jid, 'snap');
    }
    if (e.state === 'anchored' && e.anchor && E > e.anchor.capacityN * BREAK_TUNING.loadLeverM) knockLoose(w, e);
    const Eb = breakEnergyJ(MATERIALS[e.material], e.mass);
    if (!(Eb > 0) || !Number.isFinite(Eb) || !(E > Eb)) return;
    e.integrity = Math.max(0, e.integrity - ((E - Eb) / Eb) * BREAK_TUNING.integrityPerExcess);
    e.touched = true;
    if (e.integrity <= 0 && !this.pending.has(e.id)) {
      this.pending.set(e.id, { kind: 'impact', energy: E, ratio: E / Eb, point: { ...point }, breaker: breaker ? copyOwner(breaker) : null, loadPoints: [] });
    }
  }

  /**
   * A load break (phase 11, §4.11): e snaps across its long axis at `at` in phase 12. A second call for the same entity
   * in the tick adds a load point (3 pieces when it is more than loadPointSplitM from the first along the axis).
   */
  loadBreak(e: Entity, at: V3, breaker: Owner | null): void {
    if (this.world.entities.get(e.id) !== e) return;
    const p = this.pending.get(e.id);
    if (p?.kind === 'load') {
      p.loadPoints.push({ ...at });
      return;
    }
    this.pending.set(e.id, { kind: 'load', energy: 0, ratio: 0, point: { ...at }, breaker: breaker ? copyOwner(breaker) : null, loadPoints: [{ ...at }] });
    e.integrity = 0;
    e.touched = true;
  }

  /** Phase 12: entities at integrity 0 split into pieces (parents in id order); piece grace. */
  update(w: World): void {
    const now = [...w.entities.all()].filter((e) => e.integrity <= 0 || this.pending.has(e.id));
    for (const e of now) {
      if (w.entities.get(e.id) !== e) continue;
      const p = this.pending.get(e.id) ?? { kind: 'impact' as const, energy: 0, ratio: 1, point: { ...e.pose.p }, breaker: null, loadPoints: [] };
      // SIM-fix3: a Rapier (WASM) failure in a break never escapes World.step: split makes the pieces before it touches
      // the parent, and keeps the parent whole when they can't be made. A failure after that (releasing its joints,
      // removing it) is caught here and reported as a `breakFailed` event; any other error is a bug and is rethrown.
      try {
        this.split(w, e, p);
      } catch (err) {
        if (!isRapierError(err)) throw err;
        const kept = w.entities.get(e.id) === e;
        if (kept) e.integrity = 1;
        w.events.push({ type: 'breakFailed', entity: e.id, stage: 'split', kept, error: errorText(err) });
      }
    }
    this.pending.clear();
    for (const e of w.entities.all()) if (e.grace && w.entities.get(e.id) === e) this.graceTick(w, e);
  }

  // -------------------------------------------------------------------------

  private split(w: World, e: Entity, p: PendingBreak): void {
    // P28: a light thing that gives way under a load crumbles: removed, its joints released, a `break` with no pieces.
    if (p.kind === 'load' && e.mass < BREAK_TUNING.loadBreakMinKg) {
      const at = { ...p.point };
      for (const jid of [...e.joints]) {
        const j = w.joints.get(jid);
        if (!j) continue;
        const end = j.a.entity === e.id && j.a.fighter === undefined && !j.a.loose ? 'a' : j.b.entity === e.id && j.b.fighter === undefined && !j.b.loose ? 'b' : null;
        if (j.kind === 'rope' && end) w.joints.loosen(jid, end, at);
        else w.joints.remove(jid, 'release');
      }
      w.entities.remove(e.id);
      w.events.push({ type: 'break', entity: e.id, pieces: [], point: at, energy: 0, by: p.breaker ? copyOwner(p.breaker) : null });
      return;
    }
    // The parent's pose and motion: the body's, as this tick's step left it (the record still holds the pose from
    // before the step until phase 18 mirrors it; pieces placed there would sit a tick behind their velocities).
    const b = e.body;
    const live = !!b && b.isEnabled();
    const dyn = live && b.isDynamic();
    const pose = live ? { p: v3(b.translation()), q: q4(b.rotation()) } : { p: { ...e.pose.p }, q: { ...e.pose.q } };
    const v = dyn ? v3(b.linvel()) : { ...e.vel.lin };
    const omega = dyn ? v3(b.angvel()) : { ...e.vel.ang };
    const com = dyn ? v3(b.worldCom()) : { ...pose.p };
    const cut = p.kind === 'load' ? loadPieces(e.shape, pose, p.loadPoints) : fracture(e.shape, pieceCount(p.ratio), w.rngs.world);
    // SIM-fix3: no piece without volume (or one Rapier can't build) reaches the entity store, and mass is conserved.
    const pieces = settlePieces(e.shape, cut);
    const parent = {
      material: e.material,
      credit: [...e.credit],
      look: e.look,
      moisture: e.moisture,
      temperature: e.temperature,
      burning: e.burning,
      age: e.age,
      sharp: e.sharpPoints.map((s) => ({ local: { ...s.local }, dir: { ...s.dir }, sharpness: s.sharpness })),
      span: shapeSpan(e),
    };
    // Each sharp point goes to the first piece holding it, else the nearest.
    const owner = parent.sharp.map((s) => pieceOf(pieces, s.local, parent.span));
    const ids: number[] = [];
    const tick = w.tick;
    // SIM-fix3: the pieces are made before the parent's joints go and before it is removed, so a piece Rapier fails
    // to make (settlePieces leaves only shapes the store and Rapier accept: this is a WASM failure) leaves the parent
    // exactly as it was, joints and all, rather than half-broken or gone with its mass. Their `spawn` events are put back
    // after the parent's joint and `remove` events, in the order they always had.
    const mark = w.events.length;
    try {
      pieces.forEach((pc, i) => {
        const sharpPoints: SharpPoint[] = [];
        parent.sharp.forEach((s, k) => {
          if (owner[k] === i) sharpPoints.push({ local: sub(s.local, pc.offset), dir: s.dir, sharpness: s.sharpness });
        });
        const c = add(pose.p, rotate(pose.q, pc.offset));
        const lin = add(v, cross(omega, sub(c, com)));
        // A piece of a stake that was driven in starts inside the ground: lifted out, as a stake knocked loose is
        // (EntityStore.unanchor's measure).
        c.y += w.entities.depthBelowGround(pc.shape, { p: c, q: pose.q });
        const piece = w.entities.create({
          material: parent.material,
          shape: pc.shape,
          p: c,
          q: pose.q,
          lin,
          ang: omega,
          state: 'free',
          sharpPoints,
          look: parent.look,
          credit: parent.credit,
          integrity: 1,
        });
        piece.moisture = parent.moisture;
        piece.temperature = parent.temperature;
        piece.burning = parent.burning;
        piece.age = parent.age;
        if (p.breaker) w.entities.setGrace(piece, { from: p.breaker, minUntil: tick + BREAK_TUNING.pieceGraceTicks, maxUntil: tick + BREAK_TUNING.pieceGraceMaxTicks });
        ids.push(piece.id);
      });
    } catch (err) {
      if (!isRapierError(err)) throw err;
      for (const id of ids) if (w.entities.get(id)) w.entities.remove(id);
      // Their spawn and remove events go: as far as listeners know, nothing was made.
      w.events.length = mark;
      // Whole again (at integrity 0 it would fail the same way every tick); the event says what happened.
      e.integrity = 1;
      w.events.push({ type: 'breakFailed', entity: e.id, stage: 'pieces', kept: true, error: errorText(err) });
      return;
    }
    const spawned = w.events.splice(mark);
    // Its joints go first: a rope's end on it lies loose where it was; anything else is released.
    for (const jid of [...e.joints]) {
      const j = w.joints.get(jid);
      if (!j) continue;
      const end = j.a.entity === e.id && j.a.fighter === undefined && !j.a.loose ? 'a' : j.b.entity === e.id && j.b.fighter === undefined && !j.b.loose ? 'b' : null;
      if (j.kind === 'rope' && end) w.joints.loosen(jid, end, add(pose.p, rotate(pose.q, j[end].local)));
      else w.joints.remove(jid, 'release');
    }
    w.entities.remove(e.id);
    w.events.push(...spawned);
    w.events.push({ type: 'break', entity: e.id, pieces: ids, point: { ...p.point }, energy: p.energy, by: p.breaker ? copyOwner(p.breaker) : null });
  }

  /** A piece's grace (RF-7): over once it is clear of its breaker (from minUntil); crushed at maxUntil if never clear. */
  private graceTick(w: World, e: Entity): void {
    const g = e.grace!;
    const tick = w.tick;
    if (tick < g.minUntil) return;
    if (!this.insideBreaker(w, e, g.from)) {
      w.entities.setGrace(e, null);
      return;
    }
    if (tick >= g.maxUntil) {
      const at = { ...e.pose.p };
      w.entities.remove(e.id);
      w.events.push({ type: 'break', entity: e.id, pieces: [], point: at, energy: 0, by: copyOwner(g.from) });
    }
  }

  /** Whether the piece's collider overlaps any collider of `from` (an entity, or any of a fighter's). */
  private insideBreaker(w: World, e: Entity, from: Owner): boolean {
    const c = e.collider;
    if (!c || from.kind === 'terrain' || from.kind === 'rope') return false;
    let inside = false;
    w.physics.rapier.intersectionsWithShape(
      c.translation(),
      c.rotation(),
      c.shape,
      () => {
        inside = true;
        return false;
      },
      undefined,
      undefined,
      c,
      undefined,
      (o: RAPIER.Collider) => {
        const owner = w.physics.ownerOf(o.handle);
        if (!owner) return false;
        if (from.kind === 'entity') return owner.kind === 'entity' && owner.id === from.id;
        return owner.kind === 'fighter' && owner.id === from.id;
      },
    );
    return inside;
  }
}

// ---------------------------------------------------------------------------
// Stakes knocked loose
// ---------------------------------------------------------------------------

/**
 * A stake knocked or pulled loose (§2.3, §4.9: an impact above capacity × loadLeverM, a haul or a tripwire share above
 * its capacity): EntityStore.unanchor, which makes it free and awake and lifts its driven end out of the ground.
 * Returns the lift (m).
 */
export function knockLoose(w: World, e: Entity): number {
  return w.entities.unanchor(e);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The piece counts fracture() can make (its `n`): BREAK_TUNING.piecesMin/piecesMax are clamped into them. */
const FRACTURE_PIECES: readonly (2 | 3 | 4)[] = [2, 3, 4];

/**
 * n = clamp(2 + ⌊E/E_b − 1⌋, piecesMin, piecesMax) (SPEC:344 "2-4"). fracture() makes 2-4 pieces, so a piecesMax tuned
 * above 4 (or a piecesMin below 2) is held to that range.
 */
function pieceCount(ratio: number): 2 | 3 | 4 {
  const T = BREAK_TUNING;
  const n = Math.round(Math.max(T.piecesMin, Math.min(T.piecesMax, 2 + Math.floor(ratio - 1))));
  return FRACTURE_PIECES.find((k) => k >= n) ?? FRACTURE_PIECES[FRACTURE_PIECES.length - 1];
}

/**
 * A load break's pieces (§4.10, RT-7): the shape cut across its long axis at the heaviest load point, and again at the
 * first other load point more than loadPointSplitM away along the axis (3 pieces). Offsets in the parent's frame.
 */
function loadPieces(shape: Shape, pose: Pose3, points: readonly V3[]): ShapePiece[] {
  const ax = principalAxis(shape);
  const at = (w: V3): number => {
    const l = rotate(conj(pose.q), sub(w, pose.p));
    return l.x * ax.dir.x + l.y * ax.dir.y + l.z * ax.dir.z;
  };
  const ts = points.map(at);
  const t0 = ts[0];
  const t1 = ts.find((t) => Math.abs(t - t0) > BREAK_TUNING.loadPointSplitM);
  const lo = t1 === undefined ? t0 : Math.min(t0, t1);
  const [a, rest] = crossCut(shape, lo);
  if (t1 === undefined) return [a, rest];
  const hi = Math.max(t0, t1);
  const along = rest.offset.x * ax.dir.x + rest.offset.y * ax.dir.y + rest.offset.z * ax.dir.z;
  const [b, c] = crossCut(rest.shape, hi - along);
  return [a, { shape: b.shape, offset: add(rest.offset, b.offset) }, { shape: c.shape, offset: add(rest.offset, c.offset) }];
}

/**
 * SIM-fix3: the pieces a split may make. A cut at an end (a load point at a tip, an axisT clamped GEOM_EPS inside the
 * shape) or a wedge of a sliver leaves pieces of ~1e-28 m³ or of none at all (a flat point set: shapeVolume 0), which
 * the entity store refuses ("a hull shape with no volume") or Rapier can't make a hull of: either threw out of
 * World.step. A piece under pieceMinVolumeM3, or one Rapier can't build, is merged into the nearest kept piece (centre
 * to centre), and volume fracture lost outright (a wedge with none) goes to the largest; a kept piece that gains volume
 * is scaled about its centre to hold it, so the pieces' mass (density × volume) sums to the parent's. No piece kept:
 * the parent is one piece of its own shape.
 */
export function settlePieces(parentShape: Shape, cut: readonly ShapePiece[]): ShapePiece[] {
  const V = shapeVolume(parentShape);
  const volOf = (s: Shape): number => {
    const x = shapeVolume(s);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const ok = (pc: ShapePiece): boolean => {
    if (!(volOf(pc.shape) >= BREAK_TUNING.pieceMinVolumeM3) || !rapierHullOk(pc.shape)) return false;
    if (pc.shape.kind === 'cylinder' && !(Number.isInteger(pc.shape.sides) && pc.shape.sides >= 3)) return false;
    return [pc.offset.x, pc.offset.y, pc.offset.z].every(Number.isFinite);
  };
  const keep = cut.filter(ok);
  if (keep.length === 0) return [{ shape: parentShape, offset: { x: 0, y: 0, z: 0 } }];
  const vols = keep.map((pc) => volOf(pc.shape));
  for (const pc of cut) {
    if (keep.includes(pc)) continue;
    let best = 0;
    let bestD = Infinity;
    keep.forEach((k, i) => {
      const d = Math.hypot(pc.offset.x - k.offset.x, pc.offset.y - k.offset.y, pc.offset.z - k.offset.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    vols[best] += volOf(pc.shape);
  }
  // Volume lost outright (a wedge fracture dropped for having none) goes to the largest piece.
  const lost = V - vols.reduce((a, x) => a + x, 0);
  if (Math.abs(lost) > GEOM_EPS * V) {
    let big = 0;
    vols.forEach((x, i) => {
      if (x > vols[big]) big = i;
    });
    if (vols[big] + lost > 0) vols[big] += lost;
  }
  // Scaled to hold its volume. A piece Rapier can't build once scaled stays as it was and its gain goes to the next
  // kept piece, largest first, that can take it; should none (never seen: scaling keeps a hull's proportions), that
  // gain is lost. TODO(SIM-fix3): conserve it then too (split the gain across several pieces).
  const out = keep.map((pc) => ({ ...pc }));
  const now = keep.map((pc) => volOf(pc.shape));
  const order = vols.map((_, i) => i).sort((a, b) => vols[b] - vols[a] || a - b);
  const scaled = (i: number, vol: number): boolean => {
    if (!(Math.abs(vol - now[i]) > GEOM_EPS * V)) return true;
    if (!(vol > 0)) return false;
    const shape = scaleShape(keep[i].shape, Math.cbrt(vol / now[i]));
    if (!rapierHullOk(shape)) return false;
    out[i] = { shape, offset: keep[i].offset };
    return true;
  };
  let spare = 0;
  for (let i = 0; i < keep.length; i++) {
    if (scaled(i, vols[i])) continue;
    spare += vols[i] - now[i];
    vols[i] = now[i];
  }
  if (Math.abs(spare) > GEOM_EPS * V) {
    for (const i of order) {
      if (scaled(i, vols[i] + spare)) {
        vols[i] += spare;
        break;
      }
    }
  }
  return out;
}

/**
 * Whether an error is Rapier's (its WASM bindings or colliderDesc's hull check), the only kind a break may survive:
 * wasm-bindgen's argument and ownership checks ("expected instance of …", "null pointer passed to rust", "recursive use
 * of an object", "attempted to take ownership …") and a WASM fault (WebAssembly.RuntimeError).
 */
export function isRapierError(err: unknown): boolean {
  // (The sim's lib has no WebAssembly typings: the RuntimeError class is looked up on the global.)
  const wasmFault = (globalThis as { WebAssembly?: { RuntimeError?: abstract new (...a: never[]) => Error } }).WebAssembly?.RuntimeError;
  if (wasmFault && err instanceof wasmFault) return true;
  if (!(err instanceof Error)) return false;
  return /expected instance of|null pointer passed to rust|recursive use of an object|attempted to take ownership|unreachable|could not build a convex hull/i.test(err.message);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The piece a parent-local point belongs to: the first whose shape holds it, else the one whose centre is nearest. */
function pieceOf(pieces: readonly ShapePiece[], local: V3, span: number): number {
  const tol = GEOM_EPS * span;
  for (let i = 0; i < pieces.length; i++) if (shapeContains(pieces[i].shape, sub(local, pieces[i].offset), tol)) return i;
  let best = 0;
  let bestD = Infinity;
  pieces.forEach((pc, i) => {
    const d = Math.hypot(local.x - pc.offset.x, local.y - pc.offset.y, local.z - pc.offset.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function shapeSpan(e: Entity): number {
  const ax = principalAxis(e.shape);
  return ax.max - ax.min + 2 * ax.crossHalf;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function v3(v: { x: number; y: number; z: number }): V3 {
  return { x: v.x, y: v.y, z: v.z };
}

function q4(q: { x: number; y: number; z: number; w: number }): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function add(a: V3, b: V3): V3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function conj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

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
