// Pull and yank (docs/M1-DESIGN.md §5.12, SPEC:237, D-26): holding a rope end, hold a punch → `{ verb: 'pull', charge:
// 255 }`, release → `charge: 0` (the client sends both; CombatSim turns a punch pressed with a rope end in hand into the
// on, §3 phase 1a). The verb's side of the haul model (§4.9): every phase 4d while on it sets the held end's pull
// (joints.setPull), and the joint store's applyHeldEnds then reels the slack in (pullHandSpeedMps, the free length only
// shortening) and, once the rope is taut, hauls with that pull in the same tick.
//
// The pull: pullYankN (1,200 N) for the first pullYankTicks (9) ticks after the rope becomes taut, then pullForceN
// (500 N). INTERPRETATION (§5.12 "for the first pullYankTicks after it becomes taut"): the first taut ticks of the pull,
// as the design's own haul lab counts them [I-rev ran: swing_light.ts]: a rope that goes slack and taut again (a hauled
// log swinging in faster than the hand reels) is not yanked again; a new pull (the punch pressed again) yanks anew. A
// person jerks a prop out from under a log (492-1,277 N inward, C F1) and hauls a 30-40 kg hanging log back to 28-45° and
// holds it there for a tie-off (§11.2(c)). Braced while on: posture haulRope (walk input × MOVE_TUNING.pullWalkMul, read
// by CombatSim), stamina drained at pullStaminaPerS; at zero stamina the pull drops to pullTiredMul of itself. A
// creature pulls at creature strength, × creaturePullMul × scale² (§5.12: the ape 907.5 N). Off with `charge: 0`, a
// knockdown or KO (the end is let go, §5.1), a tie of the end (§5.8: tying ends the pull), or the end leaving the hand
// or its rope coming loose at the far end.
//
// "Taut" is the joint store's own test (joints.ts reelIn), asked here before applyHeldEnds runs in the same phase: the
// free length after this tick's reel-in within haulTautM of the hand's distance to the far anchor, i.e. the haul acts
// this tick. The yank count lives in the continuous verb's `data.taut` (taut ticks since the pull went on), so it is
// saved with the fighter's verb state.
//
// The hauler stands braced: while the pull is on, the rope-end tether (hands.ts tetherHands) only stops him walking the
// hand beyond the rope's reach and never draws him to the load, and he gets no rest regen (CombatSim's tickTimers).
//
// TODO "creature hand speed": §5.12 reels a creature's slack in at creatureHandSpeedMps (0.8 m/s); the joint store's
// reel-in (joints.ts reelIn) reads pullHandSpeedMps for every hand.
import type { Fighter } from '../../sim/fighter';
import { DT } from '../../sim/math';
import { reelIn } from '../joints';
import type { World } from '../world';
import { heldRopeEnd } from './lash';
import { anchorPoint, handPoint, registerVerb, verbEvent, type ContinuousState, type VerbHandler } from './targets';
import { verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

/** The rope end the fighter hauls on, and its far anchor's world point; null when there is none to haul on. */
function haulable(w: World, f: Fighter): { joint: number; far: { x: number; y: number; z: number } } | null {
  const held = heldRopeEnd(w, f);
  if (!held?.joint.rope) return null;
  const other = held.end === 'a' ? held.joint.b : held.joint.a;
  if (other.loose || other.fighter !== undefined) return null;
  const far = anchorPoint(w, other);
  return far ? { joint: held.joint.id, far } : null;
}

/** Whether the joint store's haul acts this tick (see the top): its own reel-in test, asked before it runs. */
function tautNow(w: World, f: Fighter, joint: number, far: { x: number; y: number; z: number }): boolean {
  return reelIn(verbGeom.len(verbGeom.sub(handPoint(f), far)), w.joints.get(joint)!.rope!.lengthM).taut;
}

/** The pull this tick, N (§5.12): the yank for the pull's first taut ticks, then the steady pull; tired, less; a creature, more. */
export function pullForce(f: Fighter, tautTicks: number): number {
  const t = VERB_TUNING;
  let F = tautTicks >= 1 && tautTicks <= t.pullYankTicks ? t.pullYankN : t.pullForceN;
  if (f.stamina <= 0) F *= t.pullTiredMul;
  if (f.playerId === null) F *= t.creaturePullMul * f.scale * f.scale;
  return F;
}

const brace = (f: Fighter): void => {
  f.posture = { id: 'haulRope', weight: 1 };
};

const pull: VerbHandler = {
  verb: 'pull',
  target: 'none',
  continuous: 'hold',
  validate(w, f) {
    if (!f.inventory) return 'cantAct';
    const held = heldRopeEnd(w, f);
    if (!held) return 'noRopeEnd';
    return haulable(w, f) ? null : 'notTied';
  },
  start(w, f) {
    brace(f);
    verbEvent(w, f, 'pull', true, undefined, f.inventory?.hands?.entity);
    return null;
  },
  hold(w, f, s: ContinuousState) {
    const h = haulable(w, f);
    if (!h) return false;
    brace(f);
    f.stamina = Math.max(0, f.stamina - VERB_TUNING.pullStaminaPerS * DT);
    s.data.taut = (s.data.taut ?? 0) + (tautNow(w, f, h.joint, h.far) ? 1 : 0);
    w.joints.setPull(h.joint, pullForce(f, s.data.taut));
    return true;
  },
  stop(w, f) {
    if (f.posture?.id === 'haulRope') f.posture = null;
    const held = heldRopeEnd(w, f);
    if (held) w.joints.setPull(held.joint.id, 0);
  },
};

registerVerb(pull);
