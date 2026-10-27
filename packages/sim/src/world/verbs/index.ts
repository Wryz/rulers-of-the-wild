// The verb system (docs/M1-DESIGN.md §1.5.10, §5.0): command validation in phase 1b, the 12-frame buffer, tryVerb and
// completeWork (through WorldPort), continuous verbs, held entities following the hands, the code forces of dragging,
// pulling and creature tugs, the drag tether, forced releases when a fighter goes down.
//
// The machinery is shared; each verb's rules and effect are its module's handler (targets.ts registry): hands.ts's take,
// drop, stow and draw, the focus below, and P15-P17's modules, imported here so they register.
//
// Timing (§5.0, MAP gap-5 §8): a validated command waits as `f.verbRequest` for VERB_TUNING.bufferFrames while the
// fighter isn't free; it acts when `f.free && f.alive` and the right forearm is on (drop, and a continuous verb's off,
// in any state). Acting is immediate, or a work action (state 'pickup', CombatSim's faceWork turns and steps in) whose
// effect lands at actAt through completeWork. A hit or a knockdown leaves 'pickup' and so cancels it with no effect.
// Every verb is re-validated when it starts and again at actAt (RF-15): a failure emits `{ type: 'verb', ok: false,
// reason }` and changes nothing.
//
// Per-fighter state (saved, `toRecord`): the focus (the entity or ground point the client highlighted; `verbAim` is its
// surface point, refreshed every tick), a continuous verb that is on, and a creature's tug grip. Everything else lives
// on the fighter (inventory, load, work, verbRequest, verbAim; P04's record) and on the entities.
import { Vector3 } from 'three';
import type { VerbStateRecV1 } from '../../save/schema';
import { cloneCommand, type VerbCommand, type VerbId } from '../../sim/commands';
import type { Fighter } from '../../sim/fighter';
import type { V3 } from '../types';
import type { World } from '../world';
import { dragGrip, dragImpulse, forcedRelease, letGo as letGoHands, type LetGo, putInHands as putIn, refreshHands as refresh, syncHands, tetherHands, tetherTo } from './hands';
import { chestPoint, checkVerb, cmdPoint, type ContinuousState, registerVerb, ropeNearest, targetDistance, verbEvent, verbHandler, type WorkSpec } from './targets';
import { verbGeom } from './tools';
import { VERB_TUNING } from './tuning';
// The verb modules register their handlers when they load (targets.ts): importing them here registers every verb a
// World can run.
import './cut';
import './dig';
import './lash';
import './bend';
import './pull';
import './shape';
import './place';
import './throw';
import './strike';

/** focus (§5.2): applied in phase 1b, never buffered; target 0 without `at` clears it. */
registerVerb({ verb: 'focus', target: 'entityOrGround', validate: () => null, start: () => null });

/** A fighter's verb state beyond its own fields. */
interface FighterVerbs {
  /** What the client highlighted (§5.2): an entity, or the ground (target 0) at `at`. */
  focus: { target: number; at: V3 | null } | null;
  /** A continuous verb that is on (pull, shape, hand-dig). */
  cont: ContinuousState | null;
  /**
   * A creature's tug (§6.6): the entity it hauls with the drag code at creature strength, its grip (entity frame), and
   * how far in front of the hand it holds it (P28: the grip's distance when taken, at most dragHandOffsetM × scale).
   */
  tug: { entity: number; grip: V3; holdM: number } | null;
}

/** The verb system's save record, one per fighter with state (§8.3: `verbs`, by fighter id). */
export interface VerbStateRecord extends VerbStateRecV1 {
  fighter: number;
  focus: { target: number; at: V3 | null } | null;
  /** `data` as [key, value] pairs sorted by key. */
  cont: { verb: VerbId; cmd: VerbCommand; ticks: number; data: [string, number][] } | null;
  tug: { entity: number; grip: V3; holdM: number } | null;
}

const isDown = (f: Fighter): boolean => f.state === 'knockdown' || f.state === 'ko' || f.state === 'tripped';
const copy3 = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });

export class VerbSystem {
  readonly world: World;
  /** By fighter id. */
  private readonly byFighter = new Map<number, FighterVerbs>();

  constructor(world: World) {
    this.world = world;
  }

  // -------------------------------------------------------------------------
  // The pipeline (§3)
  // -------------------------------------------------------------------------

  /**
   * Phase 1b: each command for its player's fighter, in queue order: `focus` applied now; a continuous verb's off
   * (charge 0) applied now; anything else validated (§5.0) and buffered as `f.verbRequest`, or refused with a `verb`
   * event. Then every fighter's focus is refreshed (its target moved, left range, went away, or the fighter locked on to
   * a creature).
   */
  applyCommands(cmds: readonly VerbCommand[]): void {
    const w = this.world;
    for (const c of cmds) {
      const f = w.players.get(c.player);
      if (!f) continue;
      if (c.verb === 'focus') {
        this.focusOn(f, c);
        continue;
      }
      if (verbHandler(c.verb)?.continuous && c.charge === 0) {
        this.switchOff(f, c.verb);
        continue;
      }
      const r = checkVerb(w, f, c, 'command');
      if (!r.ok) {
        verbEvent(w, f, c.verb, false, r.reason, c.target);
        continue;
      }
      f.verbRequest = { cmd: cloneCommand(c), frames: VERB_TUNING.bufferFrames };
    }
    for (const f of w.combat.fighters) this.keepFocus(f);
  }

  /**
   * WorldPort, phase 3 (after tryPickup): a buffered verb starts once the fighter is free (re-validated), or lapses
   * `busy`; with none, a repeating continuous verb starts its next work action while the fighter is free and still.
   */
  tryVerb(f: Fighter): void {
    const w = this.world;
    const req = f.verbRequest;
    if (req) {
      const h = verbHandler(req.cmd.verb);
      const canAct = f.free && f.alive && !f.isSevered('foreArmR');
      if (canAct || (h?.anyState && f.alive)) {
        f.verbRequest = null;
        this.begin(f, req.cmd, canAct);
        return;
      }
      if (--req.frames <= 0 || !f.alive) {
        f.verbRequest = null;
        verbEvent(w, f, req.cmd.verb, false, f.alive ? 'busy' : 'cantAct', req.cmd.target);
      }
      return;
    }
    const s = this.byFighter.get(f.id);
    const c = s?.cont;
    if (!c || !f.free || !f.alive) return;
    const h = verbHandler(c.verb);
    if (h?.continuous !== 'repeat') return;
    // "Strokes until … the player moves" (§5.4); a restart that fails its checks (fully sharp, out of reach) is the
    // verb's natural end, so it stops quietly.
    if (Math.hypot(f.moveInput.x, f.moveInput.z) > VERB_TUNING.repeatStopInput || !checkVerb(w, f, c.cmd, 'start').ok) {
      this.stopContinuous(f);
      return;
    }
    const spec = h.start(w, f, c.cmd);
    if (spec) this.startWork(f, c.cmd, spec);
  }

  /** WorldPort, phase 3 (advancePickup at stateFrame === work.actAt): re-validates, then the verb's effect lands. */
  completeWork(f: Fighter): void {
    const work = f.work;
    if (!work?.cmd) return;
    const h = verbHandler(work.kind);
    if (!h?.land) return;
    const r = checkVerb(this.world, f, work.cmd, 'land');
    if (!r.ok) {
      verbEvent(this.world, f, work.kind, false, r.reason, work.cmd.target);
      if (this.byFighter.get(f.id)?.cont?.verb === work.kind) this.stopContinuous(f);
      return;
    }
    h.land(this.world, f, work.cmd);
  }

  /**
   * Called by CharacterControllers.resolve before the sweep: a dragged grip keeps the player within tetherM of it, a
   * held rope end within the rope's free length of its other end, a creature's tug within tetherM of its grip.
   */
  tether(f: Fighter, proposal: Vector3): void {
    tetherHands(this.world, f, proposal);
    const tug = this.byFighter.get(f.id)?.tug;
    const e = tug ? this.world.entities.get(tug.entity) : undefined;
    if (tug && e) tetherTo(proposal, verbGeom.pointToWorld(e.pose, tug.grip), VERB_TUNING.tetherM * f.scale);
  }

  /** Phase 4a: a fighter down lets go (§5.1 forced release); its continuous verb and tug stop. */
  onDown(w: World): void {
    for (const f of w.combat.fighters) {
      if (!isDown(f)) continue;
      forcedRelease(w, f);
      this.stopContinuous(f);
      const s = this.byFighter.get(f.id);
      if (s) s.tug = null;
    }
  }

  /** Phase 4b: held entities' record poses follow the hand. */
  syncHeld(w: World): void {
    for (const f of w.combat.fighters) syncHands(w, f);
  }

  /**
   * Phase 4d, fighter order: the drag pull (impulses queued for this 4d's entities.applyImpulses), a creature's tug at
   * creature strength (pullForceN × creaturePullMul × scale², §5.12, §6.6), and every 'hold' continuous verb (pull).
   */
  codeForces(w: World): void {
    const t = VERB_TUNING;
    for (const f of w.combat.fighters) {
      const s = this.byFighter.get(f.id);
      if (s?.cont) s.cont.ticks++;
      if (isDown(f)) continue;
      const h = f.inventory?.hands;
      if (h?.mode === 'drag') {
        const imp = dragImpulse(w, f, h.entity, h.grip, t.dragForceN);
        if (imp) w.entities.queueImpulse(h.entity, imp.j, imp.at);
      }
      if (s?.tug) {
        const imp = dragImpulse(w, f, s.tug.entity, s.tug.grip, t.pullForceN * t.creaturePullMul * f.scale * f.scale, s.tug.holdM);
        if (imp) w.entities.queueImpulse(s.tug.entity, imp.j, imp.at);
      }
      const c = s?.cont;
      if (c) {
        const hh = verbHandler(c.verb);
        if (hh?.continuous === 'hold' && hh.hold && !hh.hold(w, f, c)) this.stopContinuous(f);
      }
    }
  }

  // -------------------------------------------------------------------------
  // For the other verb modules, minds, the dev panel and tests
  // -------------------------------------------------------------------------

  /** The entity the fighter has focused (the client's highlight), or null (none, or the ground). */
  focusedEntity(f: Fighter): number | null {
    const fo = this.byFighter.get(f.id)?.focus;
    return fo && fo.target > 0 ? fo.target : null;
  }

  /**
   * Sets the fighter's focus as an accepted `focus` command sets it (P15: the radial's Cut and Dig aim their swing at
   * their target): an entity (`at` null), or the ground (target 0) at `at`; verbAim follows it from now on, and phase 1b
   * keeps or clears it as it does any focus. The caller has validated the target.
   */
  setFocus(f: Fighter, target: number, at: V3 | null): void {
    const s = this.state(f);
    s.focus = { target, at: at ? copy3(at) : null };
    this.aim(f, s);
  }

  /** The focus as the sim holds it: the entity (0 = the ground) and the ground point. */
  focusOf(f: Fighter): { target: number; at: V3 | null } | null {
    const fo = this.byFighter.get(f.id)?.focus;
    return fo ? { target: fo.target, at: fo.at ? copy3(fo.at) : null } : null;
  }

  /**
   * What the fighter is working on (§4.9's tripwire exemption): its work action's target while in 'pickup', else the
   * entity it tugs; null otherwise.
   */
  workTarget(f: Fighter): number | null {
    const t = f.state === 'pickup' ? f.work?.cmd?.target : undefined;
    if (t && t > 0) return t;
    return this.byFighter.get(f.id)?.tug?.entity ?? null;
  }

  /** The continuous verb that is on for the fighter, if any (its handler may change `data`). */
  continuousOf(f: Fighter): ContinuousState | null {
    return this.byFighter.get(f.id)?.cont ?? null;
  }

  /** Switches the fighter's continuous verb off (its handler's `stop` runs). */
  stopContinuous(f: Fighter): void {
    const s = this.byFighter.get(f.id);
    const c = s?.cont;
    if (!s || !c) return;
    s.cont = null;
    verbHandler(c.verb)?.stop?.(this.world, f, c);
  }

  /** Re-derives the fighter's weapon, load, grip and posture from the hands (after a held object changed). */
  refreshHands(f: Fighter): void {
    refresh(this.world, f);
  }

  /** Empties the hands (see hands.ts letGo): place and throw pass the pose, state and velocities. */
  letGo(f: Fighter, o: LetGo = {}): number[] {
    return letGoHands(this.world, f, o);
  }

  /** Into the hands at once, no work action (dev give-tool, tests); false when it can't be taken. */
  putInHands(f: Fighter, entity: number): boolean {
    return putIn(this.world, f, entity);
  }

  /**
   * A creature's tug (§6.6 `tug` script, §5.12): it grips `entity` at the point nearest its chest and hauls it with
   * the drag code at creature strength from the next phase 4d; null lets go.
   */
  tug(f: Fighter, entity: number | null): void {
    const s = this.state(f);
    const e = entity === null ? undefined : this.world.entities.get(entity);
    if (!e || entity === null) {
      s.tug = null;
      return;
    }
    const near = e.collider ? this.world.queries.projectPoint(entity, chestPoint(f)).point : null;
    const grip = near ? verbGeom.pointToLocal(e.pose, near) : dragGrip(this.world, f, entity);
    // P28 fix: held where it was gripped (never further than the drag's hand offset). With the drag's fixed 0.8 m, a
    // bait gripped 0.45 m from the ape was first shoved 0.35 m away from it, into the deadfall's prop.
    const gw = verbGeom.pointToWorld(e.pose, grip);
    const holdM = Math.min(VERB_TUNING.dragHandOffsetM * f.scale, Math.hypot(gw.x - f.pos.x, gw.z - f.pos.z));
    s.tug = { entity, grip, holdM };
  }

  // -------------------------------------------------------------------------
  // Save records (§8.3)
  // -------------------------------------------------------------------------

  /** One record per fighter in the world with any verb state, by fighter id (a removed fighter's state is gone). */
  toRecord(): VerbStateRecV1[] {
    const out: VerbStateRecord[] = [];
    const present = new Set(this.world.combat.fighters.map((f) => f.id));
    const ids = [...this.byFighter.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const s = this.byFighter.get(id)!;
      if (!present.has(id) || (!s.focus && !s.cont && !s.tug)) continue;
      out.push({
        fighter: id,
        focus: s.focus ? { target: s.focus.target, at: s.focus.at ? copy3(s.focus.at) : null } : null,
        cont: s.cont
          ? {
              verb: s.cont.verb,
              cmd: cloneCommand(s.cont.cmd),
              ticks: s.cont.ticks,
              data: Object.keys(s.cont.data)
                .sort()
                .map((k): [string, number] => [k, s.cont!.data[k]]),
            }
          : null,
        tug: s.tug ? { entity: s.tug.entity, grip: copy3(s.tug.grip), holdM: s.tug.holdM } : null,
      });
    }
    return out;
  }

  restoreRecord(r: VerbStateRecV1[]): void {
    this.byFighter.clear();
    for (const raw of r) {
      const rec = raw as Partial<VerbStateRecord>;
      const fighter = rec.fighter;
      if (typeof fighter !== 'number' || !Number.isInteger(fighter)) throw new Error('VerbSystem.restoreRecord: a record without a fighter id');
      if (this.byFighter.has(fighter)) throw new Error(`VerbSystem.restoreRecord: two records for fighter ${fighter}`);
      const need = <T>(v: T | undefined, what: string): T => {
        if (v === undefined) throw new Error(`VerbSystem.restoreRecord: fighter ${fighter}: no ${what}`);
        return v;
      };
      const focus = need(rec.focus, 'focus');
      const cont = need(rec.cont, 'cont');
      const tug = need(rec.tug, 'tug');
      this.byFighter.set(fighter, {
        focus: focus ? { target: focus.target, at: focus.at ? copy3(focus.at) : null } : null,
        cont: cont ? { verb: cont.verb, cmd: cloneCommand(cont.cmd), ticks: cont.ticks, data: Object.fromEntries(cont.data.map(([k, v]) => [k, v])) } : null,
        tug: tug ? { entity: tug.entity, grip: copy3(tug.grip), holdM: tug.holdM } : null,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private state(f: Fighter): FighterVerbs {
    let s = this.byFighter.get(f.id);
    if (!s) {
      s = { focus: null, cont: null, tug: null };
      this.byFighter.set(f.id, s);
    }
    return s;
  }

  /** A verb starts (re-validated at 'start'): a continuous one goes on; its handler acts or returns a work action. */
  private begin(f: Fighter, cmd: VerbCommand, free: boolean): void {
    const w = this.world;
    const r = checkVerb(w, f, cmd, 'start');
    if (!r.ok) {
      verbEvent(w, f, cmd.verb, false, r.reason, cmd.target);
      return;
    }
    const h = verbHandler(cmd.verb)!;
    if (h.continuous && (cmd.charge ?? 0) > 0) {
      this.stopContinuous(f);
      this.state(f).cont = { verb: cmd.verb, cmd: cloneCommand(cmd), ticks: 0, data: {} };
    }
    const spec = h.start(w, f, cmd);
    // A verb acting in any state (drop) starts its work action only when the fighter is free.
    if (spec && free) this.startWork(f, cmd, spec);
  }

  private startWork(f: Fighter, cmd: VerbCommand, spec: WorkSpec): void {
    f.startWork({ kind: cmd.verb, frames: spec.frames, actAt: spec.actAt, faceAt: copy3(spec.faceAt), keys: spec.keys, cmd: cloneCommand(cmd) });
  }

  /** A continuous verb's off: a buffered on of it is dropped and it stops (any state). */
  private switchOff(f: Fighter, verb: VerbId): void {
    if (f.verbRequest?.cmd.verb === verb) f.verbRequest = null;
    if (this.byFighter.get(f.id)?.cont?.verb === verb) this.stopContinuous(f);
  }

  /** Phase 1b, a focus command: validated like any verb; target 0 without `at` clears the focus. */
  private focusOn(f: Fighter, c: VerbCommand): void {
    const s = this.state(f);
    if (c.target === 0 && !c.at) {
      s.focus = null;
      f.verbAim = null;
      return;
    }
    const r = checkVerb(this.world, f, c, 'command');
    if (!r.ok) {
      verbEvent(this.world, f, 'focus', false, r.reason, c.target);
      s.focus = null;
      f.verbAim = null;
      return;
    }
    s.focus = { target: c.target, at: c.at ? cmdPoint(c.at) : null };
    this.aim(f, s);
  }

  /**
   * Phase 1b, every fighter with a focus: cleared when the fighter is down or dead, has locked on to a creature, or the
   * target is gone or out of range (§5.2); otherwise `verbAim` follows the target.
   */
  private keepFocus(f: Fighter): void {
    const s = this.byFighter.get(f.id);
    const fo = s?.focus;
    if (!s || !fo) return;
    let keep = f.alive && !f.lockedOn;
    if (keep && fo.target > 0) {
      const d = targetDistance(this.world, f, fo.target);
      keep = d !== null && d <= VERB_TUNING.targetRadiusM;
    } else if (keep && fo.at) keep = verbGeom.len(verbGeom.sub(fo.at, chestPoint(f))) <= VERB_TUNING.targetRadiusM;
    if (!keep) {
      s.focus = null;
      f.verbAim = null;
      return;
    }
    this.aim(f, s);
  }

  /**
   * verbAim (§5.2): an entity's surface point nearest the point focusHeightM above the fighter's feet (a trunk at chest
   * height, a log's near top edge); a tied rope's sensor point nearest the chest (RT-6); or the ground point.
   */
  private aim(f: Fighter, s: FighterVerbs): void {
    const fo = s.focus!;
    const w = this.world;
    let p: V3 | null = fo.at;
    if (fo.target > 0) {
      const e = w.entities.get(fo.target);
      if (e?.collider && e.body?.isEnabled()) {
        p = w.queries.projectPoint(fo.target, { x: f.pos.x, y: f.pos.y + VERB_TUNING.focusHeightM * f.scale, z: f.pos.z }).point;
      } else p = ropeNearest(w, fo.target, chestPoint(f))?.point ?? null;
    }
    if (!p) {
      f.verbAim = null;
      return;
    }
    if (f.verbAim) f.verbAim.set(p.x, p.y, p.z);
    else f.verbAim = new Vector3(p.x, p.y, p.z);
  }
}
