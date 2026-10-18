// Felling (docs/M1-DESIGN.md §1.5.7, §2.5, §4.12): chops, the hinge capacity against the fall-direction moment, the
// fall on a hinge at the uncut edge, the hinge tear, felled (phase 13c).
//
// - standing → notched: each chop (`chop`, from the strike seam, §5.3) deepens one notch whose side `fromDir` is set by
//   the first chopper and kept for the tree's life; the tree stays `fixed` (a rigid, breakable lever: nothing wobbles).
// - notched → falling (phase 13c): when remaining ≤ fellAtRemaining, or when the fall-direction moment about the hinge
//   (pulls and pushes of phase 4d, impacts of phase 9c, `addMoment`) less the trunk's back-moment beats the hinge
//   capacity M_cap = hingeK × strength × density × (π/32) × (remaining × diameter)³. Then a `stump` entity (fixed, the
//   part below cutHeightM, look 'stump', the tree's credit) is made, the trunk keeps its id and shrinks to the part above
//   the cut (`plant.height` stays the tree's height, `plant.stump` names the stump), its joints move to the piece that
//   holds their anchors, it becomes dynamic (CCD on while falling), tips at tipAngVel about the hinge, and a runtime
//   revolute (not a JointRecord) joins it to the stump at the hinge H with limits [0, hingeLimitDeg], contacts off;
//   `fell` event.
// - torn at hingeTearDeg: the revolute becomes a never-taut contacts-off rope joint (it only keeps trunk-stump contacts
//   off, C F10), so the trunk lands on the fall line.
// - felled: once the torn trunk rests and is clear of its stump, the runtime joint goes and `plant` becomes null: an
//   ordinary free log. DEVIATION (§2.5: "once the trunk rests"): also "torn and clear of its stump", so a trunk hung up
//   on its hinge, or resting with its butt still in its stump, stays `falling` with its joint (dropping the joint there
//   would leave a hinged trunk unhinged, or depenetrate the butt out of the stump into a spin).
//   TODO "felled needs torn and clear" (for a §12 entry): the design's felled test is "once the trunk rests".
// TODO "short thick trees stand back up": a short, thick trunk (d / L^1.5 above ≈ 0.039, e.g. 0.15 m × 2.5 m) given
//   FELL_TUNING.tipAngVel (0.15 rad/s) rocks back onto its hinge and rests upright, staying `falling` with its runtime
//   joint for good. Options for the design: a tipAngVel scaled by d / L^1.5, or a falling tree resting upright (never
//   torn) for restTicks counted as notched again.
// TODO "felled trunks shatter on landing" (P09 design conflict, see whileFalling): a 30 cm × 15 m trunk lands tip
//   first at ≈ 20 m/s and the contact rule scores it with the whole trunk's mass, so it breaks.
// TODO "canopy collision (rule 3)": trees have no canopy collider in M1 (§2.5, X22); the client draws a falling crown
// collapsed against the trunk.
import RAPIER from '@dimforge/rapier3d-compat';
import type { FellingRecV1 } from '../save/schema';
import { defineTuning } from '../tuning/registry';
import { isSolid, MATERIALS } from './materials';
import { PHYSICS_TUNING } from './physics';
import { crossCut, principalAxis, shapeVolume } from './shapes';
import type { Entity, PlantState, Pose3, Quat, V3 } from './types';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

export const FELL_TUNING = defineTuning(
  'FELL_TUNING',
  'Materials & joints › felling',
  {
    chopDepthM: 0.02,
    refChopJ: 339,
    chopScaleMin: 0.5,
    chopScaleMax: 2.5,
    fellAtRemaining: 0,
    hingeK: 1500,
    hingeRad: 0.1,
    cutHeightM: 0.5,
    tipAngVel: 0.15,
    hingeTearDeg: 75,
    hingeLimitDeg: 80,
  },
  {
    chopDepthM: { unit: 'm per stone-axe chop', source: 'SPEC:882' },
    refChopJ: { unit: 'J', source: "NEW: the stone axe's fresh chop [B lab: tools.ts]" },
    chopScaleMin: { unit: '×', source: 'NEW' },
    chopScaleMax: { unit: '×', source: 'NEW' },
    fellAtRemaining: { unit: 'fraction of diameter', source: "D-44 (0 keeps SPEC:882's 15 chops for 30 cm)" },
    hingeK: { unit: '—', source: 'NEW: calibrated in §4.12' },
    hingeRad: { unit: 'rad', source: 'NEW: impact → moment' },
    cutHeightM: { unit: 'm', source: 'NEW' },
    tipAngVel: { unit: 'rad/s', source: 'NEW' },
    hingeTearDeg: { unit: '°', source: 'NEW: C F10' },
    hingeLimitDeg: { unit: '°', source: 'NEW' },
  },
);

/** The depth one chop takes (§5.2): chopDepthM × clamp(fresh chop energy / refChopJ, chopScaleMin, chopScaleMax), m. */
export function chopDepth(freshChopJ: number): number {
  const T = FELL_TUNING;
  const k = Math.min(T.chopScaleMax, Math.max(T.chopScaleMin, freshChopJ / T.refChopJ));
  return T.chopDepthM * k;
}

/** A falling trunk's runtime joint to its stump (never saved: rebuilt from `plant.fall` and `plant.stump`). */
interface FallRuntime {
  joint: RAPIER.ImpulseJoint | null;
  stumpBody: RAPIER.RigidBody | null;
  trunkBody: RAPIER.RigidBody | null;
  torn: boolean;
}

export class Felling {
  readonly world: World;
  /** Tree id → the fall-direction moment added this tick (phases 4d and 9c), N·m; emptied in phase 13c. */
  private readonly moments = new Map<number, number>();
  /** Falling tree id → its runtime joint to the stump. */
  private readonly falls = new Map<number, FallRuntime>();

  constructor(world: World) {
    this.world = world;
  }

  /**
   * One chop on a rooted tree (§2.5, §4.12): the first sets the notch side, `fromDir`'s horizontal unit (the side the
   * chopper stands on), kept for the tree's life; each adds `depthM` to the notch; `remaining = max(0, 1 − depthSum /
   * diameter)`. The tree is `notched` and stays fixed; the chopper's credit joins the tree's. `fell`: the notch is through
   * (the tree falls in phase 13c). A tree already falling or felled (or no tree) is left as it is.
   */
  chop(tree: number, fromDir: V3, depthM: number, credit: string[]): { remaining: number; fell: boolean } {
    const e = this.world.entities.get(tree);
    const p = e?.plant;
    if (!e || !p) return { remaining: 1, fell: false };
    if (p.phase !== 'standing' && p.phase !== 'notched') return { remaining: p.cut?.remaining ?? 1, fell: p.phase === 'falling' || p.phase === 'felled' };
    if (!p.cut) {
      const h = Math.hypot(fromDir.x, fromDir.z);
      if (!(h > 0) || !Number.isFinite(h)) throw new Error(`Felling.chop: the first chop on tree ${tree} needs a horizontal fromDir`);
      p.cut = { fromDir: { x: fromDir.x / h, y: 0, z: fromDir.z / h }, remaining: 1, chops: 0, depthSumM: 0 };
    }
    p.cut.depthSumM += Math.max(0, depthM);
    p.cut.chops++;
    p.cut.remaining = Math.max(0, 1 - p.cut.depthSumM / p.diameter);
    p.phase = 'notched';
    e.credit = normCredit([...e.credit, ...credit]);
    e.touched = true;
    return { remaining: p.cut.remaining, fell: p.cut.remaining <= FELL_TUNING.fellAtRemaining + 1e-9 };
  }

  /** Fall-direction moment on a notched tree this tick (pulls, pushes, impacts), N·m; ignored for any other tree. */
  addMoment(tree: number, moment: number): void {
    if (!Number.isFinite(moment)) return;
    const e = this.world.entities.get(tree);
    if (e?.plant?.phase !== 'notched') return;
    this.moments.set(tree, (this.moments.get(tree) ?? 0) + moment);
  }

  /**
   * A notched (or falling) tree's hinge: the point H on the trunk's surface at the cut height on the fall side, the
   * horizontal axis ⟂ the fall direction (a positive moment about it tips the top toward `fallDir`), and `fallDir`
   * (away from the cut side, SPEC:233). null for a tree with no notch.
   */
  hingeOf(tree: number): { point: V3; axis: V3; fallDir: V3 } | null {
    const e = this.world.entities.get(tree);
    const p = e?.plant;
    if (!e || !p?.cut) return null;
    const fallDir = { x: -p.cut.fromDir.x, y: 0, z: -p.cut.fromDir.z };
    const axis = normalize(cross(UP, fallDir));
    if (p.fall) return { point: { ...p.fall.hinge }, axis: { ...p.fall.axis }, fallDir };
    const ax = principalAxis(e.shape);
    const cutAt = transform(e.pose, scale(ax.dir, ax.min + FELL_TUNING.cutHeightM));
    return { point: add(cutAt, scale(fallDir, p.diameter / 2)), axis, fallDir };
  }

  /** M_cap = hingeK × strength × density × (π/32) × (remaining × diameter)³, N·m (§4.12); 0 for a tree with no notch. */
  hingeCapacity(tree: number): number {
    const e = this.world.entities.get(tree);
    const p = e?.plant;
    if (!e || !p?.cut) return 0;
    const m = MATERIALS[e.material];
    const strength = isSolid(m) ? m.strength.solidJPerKg : 0;
    const d = p.cut.remaining * p.diameter;
    return FELL_TUNING.hingeK * strength * m.density * (Math.PI / 32) * d * d * d;
  }

  /** The trunk's weight above the cut acting at its axis, diameter/2 behind H, holding the cut closed, N·m (§4.12). */
  backMoment(tree: number): number {
    const e = this.world.entities.get(tree);
    const p = e?.plant;
    if (!e || !p) return 0;
    return trunkMass(e) * Math.abs(WORLD_TUNING.gravityY) * (p.diameter / 2);
  }

  /** Phase 13c: notched trees against their hinges, falling trees torn and felled; the tick's moments spent. */
  update(w: World): void {
    for (const e of w.entities.all()) {
      const p = e.plant;
      if (!p) continue;
      if (p.phase === 'notched' && p.cut) {
        const through = p.cut.remaining <= FELL_TUNING.fellAtRemaining + 1e-9;
        const net = (this.moments.get(e.id) ?? 0) - this.backMoment(e.id);
        if (through || net > this.hingeCapacity(e.id)) this.startFall(w, e);
      } else if (p.phase === 'falling') this.whileFalling(w, e);
    }
    this.moments.clear();
    // Id order (insertion order differs between a run and a loaded one; Rapier's joint arena sees the removal order).
    for (const id of [...this.falls.keys()].sort((a, b) => a - b)) {
      if (w.entities.get(id)?.plant?.phase === 'falling') continue;
      this.drop(this.falls.get(id)!);
      this.falls.delete(id);
    }
  }

  /** Trees that are notched or falling, by id (a felled trunk is an ordinary log: nothing left to restore). */
  toRecord(): FellingRecV1[] {
    const out: FellingRecV1[] = [];
    for (const e of this.world.entities.all()) {
      const p = e.plant;
      if (!p || (p.phase !== 'notched' && p.phase !== 'falling')) continue;
      out.push({ tree: e.id, phase: p.phase, fall: p.fall ? { hinge: { ...p.fall.hinge }, axis: { ...p.fall.axis }, torn: p.fall.torn } : null });
    }
    return out;
  }

  /**
   * The loader's step after the entities (their records hold the plant state): checks every record against its tree and
   * makes a falling trunk's joint to its stump again (a revolute from the upright reference, so its limits still read
   * from upright; or the never-taut rope once torn).
   */
  restoreRecord(r: FellingRecV1[]): void {
    for (const id of [...this.falls.keys()].sort((a, b) => a - b)) this.drop(this.falls.get(id)!);
    this.falls.clear();
    this.moments.clear();
    r.forEach((rec, i) => {
      const e = this.world.entities.get(rec.tree);
      if (!e?.plant || e.plant.phase !== rec.phase) throw new Error(`save record: felling[${i}] names tree ${rec.tree}, which isn't a ${rec.phase} tree in the loaded world`);
      if (rec.phase === 'falling') this.makeJoint(e, e.plant);
    });
  }

  // -------------------------------------------------------------------------

  private startFall(w: World, e: Entity): void {
    const p = e.plant!;
    const cut = p.cut!;
    const fallDir = normalize({ x: -cut.fromDir.x, y: 0, z: -cut.fromDir.z });
    const axis = normalize(cross(UP, fallDir));
    const ax = principalAxis(e.shape);
    const cutT = Math.min(ax.max, ax.min + FELL_TUNING.cutHeightM);
    const [lower, upper] = crossCut(e.shape, cutT);
    const pose: Pose3 = { p: { ...e.pose.p }, q: { ...e.pose.q } };
    const hinge = add(transform(pose, scale(ax.dir, cutT)), scale(fallDir, p.diameter / 2));
    const stump = w.entities.create({
      material: e.material,
      shape: lower.shape,
      p: transform(pose, lower.offset),
      q: pose.q,
      state: 'fixed',
      look: 'stump',
      credit: [...e.credit],
    });
    stump.moisture = e.moisture;
    stump.temperature = e.temperature;
    stump.age = e.age;
    p.stump = stump.id;
    p.phase = 'falling';
    p.fall = { hinge, axis, torn: false };
    w.entities.reshape(e, upper.shape, upper.offset);
    w.joints.transferAnchors(e.id, [
      { entity: stump.id, offset: lower.offset, shape: lower.shape },
      { entity: e.id, offset: upper.offset, shape: upper.shape },
    ]);
    w.entities.unanchor(e);
    const b = e.body;
    if (b) {
      const omega = scale(axis, FELL_TUNING.tipAngVel);
      const com = b.worldCom();
      b.setAngvel(omega, true);
      b.setLinvel(cross(omega, sub({ x: com.x, y: com.y, z: com.z }, hinge)), true);
    }
    e.touched = true;
    this.makeJoint(e, p);
    w.events.push({ type: 'fell', tree: e.id, dir: fallDir });
  }

  private whileFalling(w: World, e: Entity): void {
    const p = e.plant!;
    const fall = p.fall;
    if (!fall) return;
    const stump = p.stump !== null ? w.entities.get(p.stump) : undefined;
    const rt = this.falls.get(e.id);
    if (stump?.body && e.body && (!rt || !rt.joint || !rt.joint.isValid() || rt.stumpBody !== stump.body || rt.trunkBody !== e.body)) this.makeJoint(e, p);
    const ax = principalAxis(e.shape);
    const up = rotate(e.pose.q, ax.dir);
    const tilt = (Math.acos(Math.max(-1, Math.min(1, dot(up, UP)))) * 180) / Math.PI;
    if (!fall.torn && tilt > FELL_TUNING.hingeTearDeg) {
      fall.torn = true;
      e.touched = true;
      this.makeJoint(e, p);
    }
    const resting = e.restTicks >= PHYSICS_TUNING.restTicks || (e.body?.isSleeping() ?? false);
    if (!fall.torn || !resting) return;
    if (stump && overlaps(e, stump)) return;
    const done = this.falls.get(e.id);
    if (done) this.drop(done);
    this.falls.delete(e.id);
    e.plant = null;
    e.touched = true;
  }

  /** The trunk's runtime joint to its stump, made again from `plant.fall`: the hinge, or the never-taut rope once torn. */
  private makeJoint(e: Entity, p: PlantState): void {
    const old = this.falls.get(e.id);
    if (old) this.drop(old);
    this.falls.delete(e.id);
    const fall = p.fall;
    const stump = p.stump !== null ? this.world.entities.get(p.stump) : undefined;
    if (!fall || !stump?.body || !e.body) return;
    const rapier = this.world.physics.rapier;
    let joint: RAPIER.ImpulseJoint;
    if (!fall.torn) {
      // Both frames from the axis in each body's frame: the stump keeps the tree's rotation and so does the upright
      // trunk, so the joint reads 0 upright and the fall angle as it tips (limits [0, hingeLimitDeg]).
      const data = RAPIER.JointData.revoluteWithAxes(
        toLocal(stump.pose, fall.hinge),
        toLocal(e.pose, fall.hinge),
        rotate(conj(stump.pose.q), fall.axis),
        rotate(conj(e.pose.q), fall.axis),
      );
      joint = rapier.createImpulseJoint(data, stump.body, e.body, true);
      (joint as RAPIER.RevoluteImpulseJoint).setLimits(0, (FELL_TUNING.hingeLimitDeg * Math.PI) / 180);
    } else {
      const zero = { x: 0, y: 0, z: 0 };
      joint = rapier.createImpulseJoint(RAPIER.JointData.rope(FELL_TUNING.cutHeightM + p.height, zero, zero), stump.body, e.body, true);
    }
    joint.setContactsEnabled(false);
    this.falls.set(e.id, { joint, stumpBody: stump.body, trunkBody: e.body, torn: fall.torn });
  }

  private drop(rt: FallRuntime): void {
    if (rt.joint && rt.joint.isValid()) this.world.physics.rapier.removeImpulseJoint(rt.joint, true);
    rt.joint = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UP: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 });

/** The mass of the trunk above the cut: density × the volume of the upper piece of a cut at cutHeightM, kg. */
function trunkMass(e: Entity): number {
  if (!e.plant || (e.plant.phase !== 'standing' && e.plant.phase !== 'notched')) return e.mass;
  const ax = principalAxis(e.shape);
  const cutT = Math.min(ax.max, ax.min + FELL_TUNING.cutHeightM);
  const upper = crossCut(e.shape, cutT)[1];
  return MATERIALS[e.material].density * shapeVolume(upper.shape);
}

/** Whether two entities' colliders intersect (shape against shape at their current poses). */
function overlaps(a: Entity, b: Entity): boolean {
  const ca = a.collider;
  const cb = b.collider;
  if (!ca || !cb) return false;
  return ca.shape.intersectsShape(ca.translation(), ca.rotation(), cb.shape, cb.translation(), cb.rotation());
}

function normCredit(c: readonly string[]): string[] {
  return [...new Set(c)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

function normalize(a: V3): V3 {
  const n = Math.hypot(a.x, a.y, a.z);
  return n > 0 ? scale(a, 1 / n) : { x: 0, y: 0, z: 0 };
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

function transform(p: Pose3, local: V3): V3 {
  return add(p.p, rotate(p.q, local));
}

function toLocal(p: Pose3, world: V3): V3 {
  return rotate(conj(p.q), sub(world, p.p));
}
