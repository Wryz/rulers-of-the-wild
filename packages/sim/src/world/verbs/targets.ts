// What the radial offers and whether a verb command is valid (docs/M1-DESIGN.md §1.5.10, §5.0, §5.13), shared by the
// sim (phase 1b and both re-validations) and the client's radial; and the verb handlers' registry.
//
// The registry. Each verb module registers a VerbHandler for its verbs at module top level (hands.ts: take, drop, stow,
// draw; index.ts: focus; P15's cut.ts and dig.ts; P16's lash.ts, bend.ts, pull.ts, shape.ts; P17's place.ts and
// throw.ts). index.ts imports every verb module, so a handler is registered whenever a World exists. The VerbSystem
// (index.ts) runs the shared machinery (validation, the 12-frame buffer, work actions, re-validation at start and at
// actAt, continuous verbs, events) and calls the handler for the verb's own rules and effect, so a verb module never
// edits index.ts. DEVIATION (P14): §1.3 has index.ts call each module's own API, which §13.0's ownership would make a
// follow-up edit of index.ts for each of P15-P17; a registry in this file, which no verb module's import cycle reaches
// (it imports only tools.ts and tuning), lets them plug in instead. A module registers through this file at top level
// and uses index.ts's exports only inside functions (index.ts imports it).
//
// A verb whose module has not registered yet is refused 'cantAct' and verbsFor leaves it out.
// TODO "roll verb": no roll verb in M1 (X16); verbsFor offers none (§12.4).
import { Vector3 } from 'three';
import type { TrackKey } from '../../body/animator';
import { fistPoint } from '../../body/skeleton';
import { CM_PER_M, toCm, type VerbCommand, type VerbId } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import { MATERIALS } from '../materials';
import type { Anchor, Entity, JointRecord, RefuseReason, V3, WorldEvent } from '../types';
import type { World } from '../world';
import { WORLD_TUNING } from '../worldTuning';
import { heldMembers, isRooted, isRopeEntity, takeMode, verbGeom } from './tools';
import { VERB_TUNING } from './tuning';

/** What the player has highlighted: an entity (at a surface point) or the ground. */
export type TargetRef = { kind: 'entity'; id: number; at: Vector3 } | { kind: 'ground'; at: Vector3 };

/** One radial option, in §5.13's fixed order; disabled options carry the reason (the player learns the rule). */
export interface VerbOption {
  verb: VerbId;
  needsSecond: boolean;
  label: string;
  reasonIfDisabled?: RefuseReason;
  /** stow: the slot the option stows into (0..2 belt, 3 back). */
  slot?: number;
}

// ---------------------------------------------------------------------------
// The handler registry
// ---------------------------------------------------------------------------

/**
 * When a check runs: at the command (phase 1b), when the verb starts (tryVerb, after the buffer), when the effect lands
 * (completeWork at actAt), or as the radial's probe (verbsFor: `second` absent for a two-target verb, `at` the
 * highlighted point). Re-validation at start and at actAt is RF-15's: targets can move, break or be taken meanwhile.
 */
export type VerbStage = 'command' | 'start' | 'land' | 'probe';

/** A work action a verb starts (§5.0): `kind` and `cmd` are filled in by the VerbSystem. */
export interface WorkSpec {
  frames: number;
  /** The frame the effect lands at (completeWork → handler.land); 0 = no landing (the effect happened at start). */
  actAt: number;
  /** The fighter turns toward it and steps in to VERB_TUNING.standOffM (CombatSim's faceWork). */
  faceAt: V3;
  keys: TrackKey[];
}

/** A continuous verb that is on (pull, shape, hand-dig): saved with the fighter's verb state. */
export interface ContinuousState {
  verb: VerbId;
  cmd: VerbCommand;
  /** Ticks since it went on (advanced in phase 4d). */
  ticks: number;
  /** The handler's own numbers (a yank's ticks, strokes done…), saved as they are. */
  data: Record<string, number>;
}

export interface VerbHandler {
  readonly verb: VerbId;
  /**
   * What `cmd.target` must be, checked before `validate`: none; an entity in range (targetRadiusM of the chest point,
   * to the collider surface; a tied rope to its sensor segment), with `at` within anchorSurfaceTolM of it when given;
   * the ground (target 0, `at` in range); or either.
   */
  readonly target: 'none' | 'entity' | 'ground' | 'entityOrGround';
  /** `cmd.second`, when given, is checked as an entity target (with `at2` as its anchor). */
  readonly second?: boolean;
  /** Acts in any state, not only when the fighter is free (drop). A continuous verb's off (charge 0) always does. */
  readonly anyState?: boolean;
  /**
   * 'repeat': the work action starts again each time the fighter is free while the verb is on (shape, hand-dig), until
   * it is switched off, the player moves, or a restart fails its checks; 'hold': `hold` runs every phase 4d while on
   * (pull). The verb goes on with a command whose `charge` > 0 and off with `charge` 0, a knockdown or a KO.
   */
  readonly continuous?: 'repeat' | 'hold';
  /** The verb's own preconditions (properties only, §5.0); null when they hold. */
  validate(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): RefuseReason | null;
  /**
   * The verb starts (re-validated): a work action whose effect lands at actAt, or null when it acted now (or, for a
   * 'hold' verb, when it is simply on). A verb acting at once emits its own `verb` event (verbEvent).
   */
  start(w: World, f: Fighter, cmd: VerbCommand): WorkSpec | null;
  /** The effect at actAt (re-validated); emits its own `verb` event. */
  land?(w: World, f: Fighter, cmd: VerbCommand): void;
  /** 'hold' verbs, phase 4d: false switches the verb off. */
  hold?(w: World, f: Fighter, s: ContinuousState): boolean;
  /** The verb went off (any reason). */
  stop?(w: World, f: Fighter, s: ContinuousState): void;
}

const HANDLERS = new Map<VerbId, VerbHandler>();

/** Registers a verb's handler (once per verb; module top level). */
export function registerVerb(h: VerbHandler): void {
  if (HANDLERS.has(h.verb)) throw new Error(`registerVerb: a handler for '${h.verb}' is already registered`);
  HANDLERS.set(h.verb, h);
}

/** The registered handler of a verb, if its module has registered one. */
export function verbHandler(verb: VerbId): VerbHandler | undefined {
  return HANDLERS.get(verb);
}

/**
 * Tests only: runs `run` with `h` standing in for its verb's handler (registered or not), then puts back what was there,
 * so the shared machinery can be tested on a stand-in verb without registering one for good.
 */
export function withVerbHandler<T>(h: VerbHandler, run: () => T): T {
  const was = HANDLERS.get(h.verb);
  HANDLERS.set(h.verb, h);
  try {
    return run();
  } finally {
    if (was) HANDLERS.set(h.verb, was);
    else HANDLERS.delete(h.verb);
  }
}

// ---------------------------------------------------------------------------
// Points: the chest, the hand, rope anchors and segments
// ---------------------------------------------------------------------------

/** The point verbs measure range and reach from (§5.0): pos + chestHeightM × scale up. */
export function chestPoint(f: Fighter): V3 {
  return { x: f.pos.x, y: f.pos.y + WORLD_TUNING.chestHeightM * f.scale, z: f.pos.z };
}

/** The right hand (the rear fist, where a tool is gripped), world. */
export function handPoint(f: Fighter): V3 {
  const p = fistPoint(f.rig, 'R', new Vector3());
  return { x: p.x, y: p.y, z: p.z };
}

/** A joint end's world point: an entity's local point, a world or loose point, or the hand of the fighter holding it. */
export function anchorPoint(w: World, a: Anchor): V3 | null {
  if (a.fighter !== undefined) {
    const f = w.combat.fighters.find((x) => x.id === a.fighter);
    return f ? handPoint(f) : null;
  }
  if (a.loose || a.entity === null) return { x: a.local.x, y: a.local.y, z: a.local.z };
  const e = w.entities.get(a.entity);
  return e ? verbGeom.pointToWorld(e.pose, a.local) : null;
}

/** The joints a rope entity is made of (JointRecord.rope.entity), in joint id order. */
export function ropeJoints(w: World, rope: number): JointRecord[] {
  return w.joints.all().filter((j) => j.rope?.entity === rope);
}

/** The point of a segment nearest `p`. */
function nearestOnSegment(a: V3, b: V3, p: V3): V3 {
  const ab = verbGeom.sub(b, a);
  const l2 = verbGeom.dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, verbGeom.dot(verbGeom.sub(p, a), ab) / l2)) : 0;
  return verbGeom.add(a, verbGeom.scale(ab, t));
}

/**
 * The nearest point of a tied rope to `p` (its sensor segments between their anchors, §2.4) and its distance; null when
 * the rope has no joint with two known ends.
 */
export function ropeNearest(w: World, rope: number, p: V3): { point: V3; dist: number } | null {
  let best: { point: V3; dist: number } | null = null;
  for (const j of ropeJoints(w, rope)) {
    const a = anchorPoint(w, j.a);
    const b = anchorPoint(w, j.b);
    if (!a || !b) continue;
    const q = nearestOnSegment(a, b, p);
    const d = verbGeom.len(verbGeom.sub(q, p));
    if (!best || d < best.dist) best = { point: q, dist: d };
  }
  return best;
}

/** Is the entity part of what the fighter holds, or stowed on the fighter's belt or back? */
export function ownedBy(w: World, f: Fighter, entity: number): boolean {
  const inv = f.inventory;
  if (!inv) return false;
  const roots: number[] = [];
  if (inv.hands && inv.hands.mode !== 'drag' && inv.hands.mode !== 'ropeEnd') roots.push(inv.hands.entity);
  for (const b of inv.belt) if (b !== null) roots.push(b);
  if (inv.back !== null) roots.push(inv.back);
  return roots.some((r) => r === entity || heldMembers(w, r).includes(entity));
}

/**
 * The back's slot number in stow and draw commands: the one after the belt's (§1.5.3: "0..2 belt, 3 back"; the belt is
 * Inventory's 3-tuple, of which VERB_TUNING.beltSlots are in use).
 */
export function backSlot(f: Fighter): number {
  return f.inventory?.belt.length ?? 0;
}

/** A command's whole-centimetre point as metres. */
export function cmdPoint(at: readonly [number, number, number]): V3 {
  return { x: at[0] / CM_PER_M, y: at[1] / CM_PER_M, z: at[2] / CM_PER_M };
}

/** Pushes a `verb` world event (an outcome for the HUD and the noise bus; §2.13). */
export function verbEvent(w: World, f: Fighter, verb: VerbId, ok: boolean, reason?: RefuseReason, entity?: number): void {
  const ev: Extract<WorldEvent, { type: 'verb' }> = { type: 'verb', f, verb, ok };
  if (reason !== undefined) ev.reason = reason;
  if (entity !== undefined && entity > 0) ev.entity = entity;
  w.events.push(ev);
}

// ---------------------------------------------------------------------------
// Validation (§5.0)
// ---------------------------------------------------------------------------

type Verdict = { ok: true } | { ok: false; reason: RefuseReason };
const OK: Verdict = Object.freeze({ ok: true });
const no = (reason: RefuseReason): Verdict => ({ ok: false, reason });

/** The distance from the chest to an entity a verb may act on (0 for what the fighter holds or carries); null: none. */
export function targetDistance(w: World, f: Fighter, entity: number): number | null {
  const e = w.entities.get(entity);
  if (!e) return null;
  if (ownedBy(w, f, entity)) return 0;
  if (e.body && e.collider && e.body.isEnabled()) return w.queries.surfaceDistance(f, entity);
  if (e.state === 'tied' && isRopeEntity(e)) return ropeNearest(w, entity, chestPoint(f))?.dist ?? null;
  return null;
}

/** An entity target: it exists, isn't in someone else's hands, and is within targetRadiusM of the chest. */
function checkEntity(w: World, f: Fighter, entity: number): RefuseReason | null {
  if (!(entity > 0)) return 'noTarget';
  const d = targetDistance(w, f, entity);
  if (d === null) return 'noTarget';
  return d <= VERB_TUNING.targetRadiusM ? null : 'outOfRange';
}

/** An anchor point lies within anchorSurfaceTolM of its entity's surface (a tied rope: of its sensor segment). */
function checkAnchor(w: World, f: Fighter, entity: number, at: readonly [number, number, number]): RefuseReason | null {
  const p = cmdPoint(at);
  const e = w.entities.get(entity)!;
  if (ownedBy(w, f, entity)) return null;
  let d: number;
  if (e.collider && e.body?.isEnabled()) d = w.queries.projectPoint(entity, p).dist;
  else d = ropeNearest(w, entity, p)?.dist ?? Infinity;
  return d <= VERB_TUNING.anchorSurfaceTolM ? null : 'badAnchor';
}

/** A ground point within targetRadiusM of the chest. */
function checkGround(f: Fighter, at: readonly [number, number, number] | undefined): RefuseReason | null {
  if (!at) return 'noTarget';
  const d = verbGeom.len(verbGeom.sub(cmdPoint(at), chestPoint(f)));
  return d <= VERB_TUNING.targetRadiusM ? null : 'outOfRange';
}

/**
 * Every check of a verb at one stage (§5.0): the fighter can act (alive, right forearm on), the verb has a handler, the
 * target (and second) exist and are in range, anchor points lie on their entities, then the verb's own preconditions.
 */
export function checkVerb(w: World, f: Fighter, cmd: VerbCommand, stage: VerbStage): Verdict {
  if (!f.alive || f.isSevered('foreArmR')) return no('cantAct');
  const h = HANDLERS.get(cmd.verb);
  // TODO(P15-P17): a verb whose module hasn't registered its handler yet.
  if (!h) return no('cantAct');
  let r: RefuseReason | null = null;
  const entityTarget = h.target === 'entity' || (h.target === 'entityOrGround' && cmd.target !== 0);
  if (entityTarget) {
    r = checkEntity(w, f, cmd.target);
    if (!r && cmd.at) r = checkAnchor(w, f, cmd.target, cmd.at);
  } else if (h.target === 'ground' || h.target === 'entityOrGround') {
    r = cmd.target !== 0 ? 'noTarget' : checkGround(f, cmd.at);
  }
  if (r) return no(r);
  if (h.second && cmd.second !== undefined) {
    r = checkEntity(w, f, cmd.second);
    if (!r && cmd.at2) r = checkAnchor(w, f, cmd.second, cmd.at2);
    if (r) return no(r);
  }
  r = h.validate(w, f, cmd, stage);
  return r ? no(r) : OK;
}

/** Is the command valid now (phase 1b; the client's radial asks the same)? */
export function validateVerb(w: World, f: Fighter, cmd: VerbCommand): { ok: true } | { ok: false; reason: RefuseReason } {
  return checkVerb(w, f, cmd, 'command');
}

/** Is `p` within the fighter's hand reach (VERB_TUNING.handReachM of the chest point; rule 3)? Handlers check it at actAt. */
export function inHandReach(f: Fighter, p: V3): boolean {
  return verbGeom.len(verbGeom.sub(p, chestPoint(f))) <= VERB_TUNING.handReachM * f.scale;
}

// ---------------------------------------------------------------------------
// The radial (§5.13)
// ---------------------------------------------------------------------------

/** Wood or anything else a blade might cut: a rooted plant, or a free entity that isn't rope. */
function cuttable(e: Entity): boolean {
  return isRooted(e) || (e.state === 'free' && !isRopeEntity(e));
}

/**
 * The radial's options for what the player has highlighted (or nothing: `null`), in §5.13's fixed order, each checked
 * by the verb's own rules: disabled with the reason when they fail. Verbs whose module hasn't registered are left out.
 */
export function verbsFor(w: World, f: Fighter, target: TargetRef | null): VerbOption[] {
  const out: VerbOption[] = [];
  const add = (verb: VerbId, label: string, probe: Partial<VerbCommand>, needsSecond = false, slot?: number): void => {
    if (!HANDLERS.has(verb)) return;
    const cmd: VerbCommand = { tick: w.tick, player: 0, kind: 'verb', verb, target: 0, ...probe };
    const r = checkVerb(w, f, cmd, 'probe');
    const o: VerbOption = { verb, needsSecond, label };
    if (!r.ok) o.reasonIfDisabled = r.reason;
    if (slot !== undefined) o.slot = slot;
    out.push(o);
  };
  if (!target) {
    const inv = f.inventory;
    if (!inv?.hands) return out;
    const free = inv.belt.findIndex((b, i) => b === null && i < VERB_TUNING.beltSlots);
    add('stow', 'Stow on belt', { slot: free >= 0 ? free : 0 }, false, free >= 0 ? free : 0);
    add('stow', 'Stow on back', { slot: backSlot(f) }, false, backSlot(f));
    add('drop', 'Drop', {});
    return out;
  }
  if (target.kind === 'ground') {
    add('dig', 'Dig', { target: 0, at: toCm(target.at), charge: 1 });
    return out;
  }
  const e = w.entities.get(target.id);
  if (!e) return out;
  const at = toCm(target.at);
  const rope = isRopeEntity(e) && e.state === 'tied';
  if (!rope) {
    const mode = takeMode(w, e.id, f.scale)?.mode;
    add('take', mode === 'wield' ? 'Wield' : mode === 'drag' ? 'Drag' : mode === 'carry' ? 'Carry' : 'Take', { target: e.id });
  }
  add('lash', 'Lash', { target: e.id, at }, true);
  add('tie', 'Tie', { target: e.id, at });
  if (e.plant) add('bend', 'Bend', { target: e.id }, true);
  if (rope) {
    add('untie', 'Untie', { target: e.id });
    add('take', 'Take end', { target: e.id });
  }
  if (rope || cuttable(e)) add('cut', 'Cut', { target: e.id });
  if (!rope && MATERIALS[e.material].maxSharpness > 0) add('shape', 'Shape', { target: e.id, at, charge: 1 });
  return out;
}
