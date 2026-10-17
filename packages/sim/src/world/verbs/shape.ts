// Shape and knap (docs/M1-DESIGN.md §5.4, SPEC:234): `{ verb: 'shape', target, at, charge: 1 }` strokes until the end
// is at its material's max sharpness, the player moves, or `charge: 0` (a 'repeat' continuous verb: each stroke is a
// work action of shapeStrokeFrames, re-validated, and the next starts when the fighter is free again).
//
// Each stroke adds shapeStep (0.10; knapStep 0.15 on a compact target, pose workKnap, else workLow) to the sharp point
// at the target's end nearest `at`, creating it there if absent: its tip at that end of the principal axis, `dir`
// outward along the axis (a stick becomes pointed; a flint nodule gets an edge along its long axis, which the held-object
// predicates read as an edge on a compact object, §5.0). Capped at material.maxSharpness (dry wood 0.6, green 0.5, bone
// 0.8, flint 1.0; rotten wood's 0.1 leaves it useless, by its properties alone). The tool is the held object in the hands;
// it must be hard enough (canShape: its hardest member ≥ the target's hardness − shapeHardnessMargin: stone 0.9 knaps
// flint 0.95, wood can't). A 300 kg log is sharpened where it lies (SPEC:234). Noise: the `verb` event of each stroke is
// what the noise bus hears (NOISE_TUNING.shape, 10 m).
//
// The point is geometry too (RF-18, rule 3): the first stroke on an elongated target's end replaces its shape with
// taperEnd(shape, end, pointTaperRadii × its radius), a hull whose end ring is pulled to a tip on the axis (0.25 m on a
// 5 cm stake), so the collider a falling body meets has a real point where the SharpPoint sits; the mass follows (density
// × the new volume: a 1.4 m × 5 cm stake loses 0.65 kg). The SharpPoint's tip is that hull's vertex furthest along the
// axis at that end (on a prism, the centre of its end).
//
// INTERPRETATIONS: a target with `plant` (a rooted, bent, falling tree or sapling) is refused 'immovable': its ends are
// in the ground and in the crown, and reshaping a trunk would change the felling's shapes under it. The end being shaped
// must be in the hands' reach after the step-in (§5.0 Reach, lash.ts's inWorkReach), and the target can't be part of
// what the player holds ('handsFull': you shape with what is in your hands).
import type { VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { MATERIALS } from '../materials';
import { GEOM_EPS, principalAxis, taperEnd } from '../shapes';
import type { Entity, RefuseReason, SharpPoint, V3 } from '../types';
import type { World } from '../world';
import { creditEntity } from './hands';
import { endCentre, inWorkReach, ROPE_TUNING, shapeVerts, workSpec } from './lash';
import { chestPoint, cmdPoint, ownedBy, registerVerb, verbEvent, type VerbHandler, type VerbStage } from './targets';
import { canShape, isCompact, isElongated, isRopeEntity, verbGeom } from './tools';
import { TOOL_TUNING, VERB_TUNING } from './tuning';

const { sub, scale, dot, len, pointToWorld, pointToLocal } = verbGeom;

/** The end of an entity's principal axis nearest a world point: +1 (the max end) or −1. */
export function nearestEnd(e: Entity, p: V3): 1 | -1 {
  const ax = principalAxis(e.shape);
  return dot(pointToLocal(e.pose, p), ax.dir) >= (ax.min + ax.max) / 2 ? 1 : -1;
}

/**
 * The sharp point at an end (§5.4: the one shaping raises): a point within headZoneM of that end along the axis whose
 * `dir` leads out of it (|dir·axis| ≥ pointAxisCos); the sharpest, the first on a tie. −1 when there is none.
 */
export function endPointIndex(e: Entity, end: 1 | -1): number {
  const ax = principalAxis(e.shape);
  const tip = end > 0 ? ax.max : ax.min;
  let best = -1;
  e.sharpPoints.forEach((sp, i) => {
    const along = dot(sp.local, ax.dir);
    if (Math.abs(along - tip) > TOOL_TUNING.headZoneM + GEOM_EPS) return;
    if (end * dot(sp.dir, ax.dir) < TOOL_TUNING.pointAxisCos - GEOM_EPS) return;
    if (best < 0 || sp.sharpness > e.sharpPoints[best].sharpness) best = i;
  });
  return best;
}

/** The tip a new sharp point gets at an end (entity frame): a hull's vertex furthest out along the axis, else the end's centre. */
function tipAt(e: Entity, end: 1 | -1): V3 {
  const ax = principalAxis(e.shape);
  if (e.shape.kind !== 'hull') return endCentre(e.shape, end);
  let best: V3 | null = null;
  let bestAlong = -Infinity;
  let bestOff = Infinity;
  for (const p of shapeVerts(e.shape)) {
    const along = end * dot(p, ax.dir);
    const off = len(sub(p, scale(ax.dir, dot(p, ax.dir))));
    if (along > bestAlong + GEOM_EPS || (Math.abs(along - bestAlong) <= GEOM_EPS && off < bestOff)) {
      best = p;
      bestAlong = along;
      bestOff = off;
    }
  }
  return best ?? endCentre(e.shape, end);
}

interface ShapePlan {
  target: Entity;
  end: 1 | -1;
  /** The point's index, or −1 (a stroke makes it). */
  point: number;
  /** The end's centre (world), where the player works. */
  at: V3;
  knap: boolean;
}

/** A stroke as planned from the world now (shared by the checks and the effect, RF-15). */
function planShape(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): ShapePlan | RefuseReason {
  const inv = f.inventory;
  if (!inv) return 'cantAct';
  const e = w.entities.get(cmd.target)!;
  if (isRopeEntity(e)) return 'ropeLike';
  if (e.plant) return 'immovable';
  if (ownedBy(w, f, e.id)) return 'handsFull';
  const h = inv.hands;
  if (!h) return 'handsEmpty';
  if (h.mode === 'drag') return 'dragging';
  if (h.mode === 'ropeEnd') return 'ropeEnd';
  if (!canShape(w, h.entity, e.id)) return 'tooHard';
  const end = nearestEnd(e, cmd.at ? cmdPoint(cmd.at) : chestPoint(f));
  const point = endPointIndex(e, end);
  const now = point >= 0 ? e.sharpPoints[point].sharpness : 0;
  // §5.0: "target maxSharpness > current + 0.01".
  if (!(MATERIALS[e.material].maxSharpness > now + ROPE_TUNING.shapeDoneMargin)) return 'fullySharp';
  const at = pointToWorld(e.pose, endCentre(e.shape, end));
  if (!inWorkReach(f, [at], at, stage)) return 'outOfReach';
  return { target: e, end, point, at, knap: isCompact(e) };
}

/** One stroke on the plan's end (§5.4): a new point (tapering an elongated target's end first) or a sharper one. */
function stroke(w: World, f: Fighter, p: ShapePlan): void {
  const e = p.target;
  const max = MATERIALS[e.material].maxSharpness;
  const step = p.knap ? VERB_TUNING.knapStep : VERB_TUNING.shapeStep;
  if (p.point >= 0) {
    const sp = e.sharpPoints[p.point];
    e.sharpPoints = e.sharpPoints.map((x, i) => (i === p.point ? { local: { ...sp.local }, dir: { ...sp.dir }, sharpness: Math.min(max, sp.sharpness + step) } : x));
  } else {
    if (isElongated(e)) {
      const ax = principalAxis(e.shape);
      w.entities.reshape(e, taperEnd(e.shape, p.end, TOOL_TUNING.pointTaperRadii * ax.crossHalf));
    }
    const ax = principalAxis(e.shape);
    const point: SharpPoint = { local: tipAt(e, p.end), dir: scale(ax.dir, p.end), sharpness: Math.min(max, step) };
    e.sharpPoints = [...e.sharpPoints, point];
  }
  e.touched = true;
  creditEntity(e, f);
}

const shape: VerbHandler = {
  verb: 'shape',
  target: 'entity',
  continuous: 'repeat',
  validate(w, f, cmd, stage) {
    const r = planShape(w, f, cmd, stage);
    return typeof r === 'string' ? r : null;
  },
  start(w, f, cmd) {
    const r = planShape(w, f, cmd, 'start');
    if (typeof r === 'string') return null;
    return workSpec(VERB_TUNING.shapeStrokeFrames, r.at, r.knap ? 'workKnap' : 'workLow');
  },
  land(w, f, cmd) {
    const r = planShape(w, f, cmd, 'land');
    if (typeof r === 'string') {
      verbEvent(w, f, 'shape', false, r, cmd.target);
      return;
    }
    stroke(w, f, r);
    verbEvent(w, f, 'shape', true, undefined, r.target.id);
  },
};

registerVerb(shape);
