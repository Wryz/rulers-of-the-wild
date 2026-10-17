// Bend (docs/M1-DESIGN.md §5.9, SPEC:240, 258): pull a rooted, springy sapling over toward an anchor and tie it there,
// storing energy. The joint store (P10) makes it: the sapling becomes a dynamic body hinged at its base (a `bend` joint
// with a motor toward upright), posed bent, `plant.phase 'bent'`, held by a short rope from its top to the anchor whose
// `holdsBend` names the bend; cut or snapped, the motor springs it back.
//
// `{ verb: 'bend', target: sapling, second: anchorEntity, at2 }` (the radial's two-target flow; the client sends no `at`:
// the rope goes on the sapling's top). Preconditions (§5.9): the target rooted and springy, its diameter ≤ bendMaxDiamM;
// the anchor point in reach and within the sapling's height of its base; rope available. The angle is the joint store's
// bendAngle: as far as the top reaches toward the anchor, capped where the holding force at the top, k·θ / L, reaches
// bendMaxForceN (and at 90°); a sapling that 500 N bends less than bendMinDeg is refused `tooStiff`. The rope taken off
// the coil is the holding rope (the top's distance from the anchor once bent, at least JOINT_TUNING.bendHoldRopeM) plus
// the knots (ROPE_TUNING.knotAllowanceM). Work action bendFrames (90), pose haulRope; the bend lands at its end.
//
// Rule 1: a bent sapling is a sapling, a hinge and a rope; what it does when released is the motor's physics.
import type { VerbCommand } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { bendAngle, JOINT_TUNING } from '../joints';
import { GEOM_EPS, principalAxis } from '../shapes';
import type { Entity, RefuseReason, V3 } from '../types';
import type { World } from '../world';
import { creditEntity } from './hands';
import { endCentre, heldRopeEnd, inWorkReach, makerCredit, ROPE_TUNING, ropeLength, ropeSource, type RopeSource, surfacePoint, takeRope, workSpec } from './lash';
import { cmdPoint, ownedBy, registerVerb, verbEvent, type VerbHandler, type VerbStage } from './targets';
import { isRooted, isRopeEntity, isSpringyEntity, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

const { add, sub, scale, len, pointToWorld, pointToLocal } = verbGeom;
const DEG = Math.PI / 180;

/** A bend as planned from the world now (shared by the checks and the effect, RF-15). */
interface BendPlan {
  sapling: Entity;
  anchorOn: Entity;
  /** The rope's end on the sapling (its top, sapling frame) and on the anchor entity (its frame). */
  top: V3;
  hold: V3;
  /** The anchor point (world). */
  at: V3;
  /** The holding rope's length once bent, and the coil it comes off. */
  holdLen: number;
  src: RopeSource;
}

/** v rotated by `angle` about the unit `axis` (Rodrigues). */
function turn(axis: V3, angle: number, p: V3): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = axis.x * p.x + axis.y * p.y + axis.z * p.z;
  const cx = axis.y * p.z - axis.z * p.y;
  const cy = axis.z * p.x - axis.x * p.z;
  const cz = axis.x * p.y - axis.y * p.x;
  return { x: p.x * c + cx * s + axis.x * k * (1 - c), y: p.y * c + cy * s + axis.y * k * (1 - c), z: p.z * c + cz * s + axis.z * k * (1 - c) };
}

/** The bend a command makes; null: the radial's probe (no anchor yet) found nothing against it. */
function planBend(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): BendPlan | RefuseReason | null {
  if (!f.inventory) return 'cantAct';
  const s = w.entities.get(cmd.target)!;
  if (!isRooted(s) || s.state !== 'fixed') return 'notRooted';
  if (!isSpringyEntity(s)) return 'notSpringy';
  if (!(s.plant!.diameter <= VERB_TUNING.bendMaxDiamM + GEOM_EPS)) return 'tooThick';
  const src = ropeSource(w, f);
  if (!src) return heldRopeEnd(w, f) ? 'ropeEnd' : 'noRope';
  if (cmd.second === undefined) return stage === 'probe' ? null : 'noTarget';
  const B = w.entities.get(cmd.second);
  if (!B || B.id === s.id) return 'noTarget';
  if (isRopeEntity(B)) return 'ropeLike';
  if (ownedBy(w, f, B.id)) return 'handsFull';
  if (!cmd.at2) return 'badAnchor';
  // The rope goes round the anchor entity at its surface point nearest the aimed one.
  const at = surfacePoint(w, B, cmdPoint(cmd.at2));
  // Within the sapling's height of its base (§5.9).
  const ax = principalAxis(s.shape);
  const base = pointToWorld(s.pose, endCentre(s.shape, -1));
  if (len(sub(at, base)) > ax.max - ax.min + GEOM_EPS) return 'badAnchor';
  if (!inWorkReach(f, [at], at, stage)) return 'outOfReach';
  const top = endCentre(s.shape, 1);
  const bp = bendAngle(s, top, at);
  if (!bp) return 'badAnchor';
  if (bp.forceLimited && bp.theta < VERB_TUNING.bendMinDeg * DEG) return 'tooStiff';
  // The holding rope once bent, as the joint store makes it: the top turned about the pivot by θ, to the anchor.
  const topNow = add(bp.pivot, turn(bp.axis, bp.theta, sub(pointToWorld(s.pose, top), bp.pivot)));
  const holdLen = Math.max(JOINT_TUNING.bendHoldRopeM, len(sub(topNow, at)));
  if (ropeLength(w.entities.get(src.entity)!) < holdLen + ROPE_TUNING.knotAllowanceM - GEOM_EPS) return 'ropeTooShort';
  return { sapling: s, anchorOn: B, top, hold: pointToLocal(B.pose, at), at, holdLen, src };
}

const bend: VerbHandler = {
  verb: 'bend',
  target: 'entity',
  second: true,
  validate(w, f, cmd, stage) {
    const r = planBend(w, f, cmd, stage);
    return typeof r === 'string' ? r : null;
  },
  start(w, f, cmd) {
    const r = planBend(w, f, cmd, 'start');
    if (r === null || typeof r === 'string') return null;
    return workSpec(VERB_TUNING.bendFrames, r.at, 'haulRope');
  },
  land(w, f, cmd) {
    const r = planBend(w, f, cmd, 'land');
    if (r === null || typeof r === 'string') {
      verbEvent(w, f, 'bend', false, r ?? 'noTarget', cmd.target);
      return;
    }
    const piece = takeRope(w, f, r.src, r.holdLen + ROPE_TUNING.knotAllowanceM, scale(add(r.at, pointToWorld(r.sapling.pose, r.top)), 0.5));
    w.joints.bend(r.sapling.id, { entity: r.sapling.id, local: r.top }, { entity: r.anchorOn.id, local: r.hold }, { entity: piece, lengthM: r.holdLen }, makerCredit(f));
    creditEntity(r.sapling, f);
    creditEntity(r.anchorOn, f);
    verbEvent(w, f, 'bend', true, undefined, r.sapling.id);
  },
};

registerVerb(bend);
