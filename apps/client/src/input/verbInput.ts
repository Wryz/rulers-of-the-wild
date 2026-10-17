// The verb UI's input side (docs/M1-DESIGN.md §10.7, §5.14): turns one input frame into this frame's commands. The only
// producer of player commands in the client (rule 6: input reaches the sim only as tick-tagged commands, §10.11).
//
// What it does each frame, in order:
// 1. Targeting (input/targeting.ts): the candidate the aim ray points at, which Tab / Shift+Tab / D-pad ←→ cycle; a
//    `focus` command whenever it changes (only then), never one the sim would refuse (validateVerb), none while the
//    player is locked on to a creature (the sim drops the focus then, §5.2).
// 2. The verb modes. Every verb acts on the sim's focus (world.verbs.focusOf), never on a client guess, so what is
//    outlined is what is acted on:
//    - idle: G takes the focused thing (or drops what the hands hold); 1-4 draw from or stow onto the belt and back;
//      strikes are `button` commands (the mouse's buttons punch); holding a rope end, the punch buttons haul it
//      (`pull` on while one is held, off when none is, §5.12);
//    - radial (hold V / LB): the options verbsFor gives the focus, greyed with their reasons; release on one runs it;
//      lash and bend go on to
//    - second: the next focus is the second target; LMB or E (pad A) confirms, RMB or Esc (pad B) cancels, and it
//      lapses after secondTimeoutS;
//    - throwAim (hold X / RB, something carried or wielded): the arc, the charge rising from 0.5 to 1 of launch speed
//      over throwChargeS (counted in sim ticks), release throws, LMB (pad B) cancels;
//    - place (hold C / D-pad ↓ toggles, something carried or wielded): the ghost at the aim point within reach, the
//      wheel (pad right stick X) turns it wheelStepDeg a notch, RMB (a flick of the stick) cycles lying / upright /
//      sloped, Shift (pad X) cycles drive auto / on / off, LMB (pad A) sets it, releasing C (pad B, D-pad ↓) cancels.
//      The ghost is the sim's own placement rule run read-only (planPlace), and a sloped placement carries the pitch
//      that rule's cast gives (§5.7).
//    In every mode the mouse's left click is the mode's, never a punch (MAP client §2.4), and so are the strike keys.
// 3. The walk: a camera-relative `move` with the sprint and crouch flags (Shift held, or the pad's LS toggle that ends
//    when you stop; Ctrl toggles crouch unless "hold to crouch" is set; the pad's B toggles it), and Space / pad A jump.
// 4. The visuals: the outline and its prompt (render/highlight.ts), the ghost (render/ghost.ts), the arc
//    (render/aimArc.ts) and the radial (ui/radial.ts). All read the world and write nothing in it.
//
// DECISION (P35; the orchestrator's ledger asked): aim does not override the fight camera. While the fight camera frames
// you (CameraDirector.fightWeight ≥ 0.5) a throw goes along your facing, pitched up fightThrowPitchDeg, with the arc
// shown; the aim camera (FOLLOW_TUNING.aim*) is the follow camera's. Overriding it would mean a change in P34's
// cameraDirector.ts, and a fight is framed for the fight.
import { type Camera, Vector3 } from 'three';
import {
  aimOf,
  backSlot,
  type Button,
  BUTTONS,
  type Command,
  COMMAND_STEPS,
  defineTuning,
  DT,
  type Fighter,
  handPoint,
  heldMembers,
  heldShape,
  isRooted,
  isRopeEntity,
  MOVE_CROUCH,
  MOVE_SPRINT,
  moveCommand,
  planPlace,
  type Pose3,
  ropeEndInReach,
  ropeNearest,
  takeMode,
  throwLaunchSpeed,
  toCm,
  validateVerb,
  VERB_TUNING,
  type VerbCommand,
  verbGeom,
  verbsFor,
  type World,
} from '@wild/sim';
import type { VerbInputPort } from '../game/ports';
import type { Prefs } from '../game/prefs';
import type { AimArc } from '../render/aimArc';
import type { Ghost, PlaceOrientation } from '../render/ghost';
import type { Highlight } from '../render/highlight';
import { Radial, type RadialOption, reasonText } from '../ui/radial';
import { type Bindings, DEFAULT_BINDINGS, keyLabel, PAD, PAD_BINDINGS, PAD_MODE } from './bindings';
import { type FullInputFrame, fullFrame, type InputFrame } from './input';
import { type AimRay, chestOf, rayTerrain, Targeting } from './targeting';

/** The local player's number: its commands carry `player: 1`, which the world maps to fighter 'p1' (§1.5.3). */
export const LOCAL_PLAYER = 1;

export const VERB_UI_TUNING = defineTuning(
  'VERB_UI_TUNING',
  'Client › verb UI',
  {
    targetConeDeg: 28,
    fightTargetConeDeg: 50,
    radialDeadPx: 28,
    secondTimeoutS: 10,
    wheelStepDeg: 15,
    padRotateDegS: 90,
    arcPoints: 48,
    highlightScale: 1.04,
    markerRangeM: 60,
    compassPingS: 30,
    compassSeeRangeM: 120,
    // Not §9.1 rows (P35, listed in its deviations): starting values §10.7 leaves open.
    fightAimPitchDeg: 30,
    fightThrowPitchDeg: 8,
    padStickDead: 0.2,
    radialStickMin: 0.5,
    radialRadiusPx: 110,
    refocusS: 0.5,
    groundRefocusM: 0.1,
    aimRangeM: 60,
    aimConvergeM: 30,
    arcMaxS: 4,
    wheelPxPerNotch: 100,
    wheelLinesPerNotch: 3,
  },
  {
    targetConeDeg: { unit: '°', source: 'NEW (§10.7)', min: 5, max: 90, step: 1, label: 'target cone' },
    fightTargetConeDeg: { unit: '°', source: 'NEW (§10.7)', min: 5, max: 120, step: 1, label: 'target cone (fight)' },
    radialDeadPx: { unit: 'px', source: 'NEW: D-48', min: 0, max: 100, step: 1, label: 'radial dead zone' },
    secondTimeoutS: { unit: 's', source: 'NEW: D-48', min: 1, max: 60, step: 0.5, label: 'second target timeout' },
    wheelStepDeg: { unit: '°', source: 'NEW: D-48', min: 1, max: 90, step: 1, label: 'wheel step' },
    padRotateDegS: { unit: '°/s', source: 'NEW: D-48', min: 10, max: 360, step: 5, label: 'pad rotate' },
    arcPoints: { unit: 'points', source: 'NEW (§10.7)', min: 8, max: 128, step: 1, label: 'throw arc points' },
    highlightScale: { unit: '×', source: 'NEW (§10.7)', min: 1, max: 1.2, step: 0.005, label: 'highlight shell' },
    markerRangeM: { unit: 'm', source: 'NEW (§10.8)', min: 5, max: 200, step: 1, label: 'marker range' },
    compassPingS: { unit: 's', source: 'NEW (§10.8)', min: 1, max: 120, step: 1, label: 'compass ping' },
    compassSeeRangeM: { unit: 'm', source: 'NEW (§10.8)', min: 10, max: 300, step: 1, label: 'compass sight range' },
    fightAimPitchDeg: {
      unit: '°',
      source: 'NEW (P35): the fight camera aims along your facing (§10.7), tilted down this much so it can meet the ground at your feet',
      min: 0,
      max: 80,
      step: 1,
      label: 'fight aim tilt',
    },
    fightThrowPitchDeg: { unit: '°', source: 'NEW (P35): a throw while the fight camera frames you goes along your facing, this far up', min: -20, max: 60, step: 1, label: 'fight throw pitch' },
    padStickDead: { unit: 'stick', source: 'DS (input.ts: the left stick ignored under 0.2); both sticks', min: 0, max: 0.9, step: 0.01, label: 'stick dead zone' },
    radialStickMin: { unit: 'stick', source: 'NEW (P35): the right stick picks a radial sector, or flicks a placement round, past this', min: 0.1, max: 1, step: 0.05, label: 'stick pick' },
    radialRadiusPx: { unit: 'px', source: 'NEW (P35): the radial ring; the virtual cursor stays on it', min: 40, max: 300, step: 1, label: 'radial radius' },
    refocusS: { unit: 's', source: "NEW (P35): a focus the sim dropped (out of range, a fight) is sent again after this", min: 0.05, max: 5, step: 0.05, label: 'refocus' },
    groundRefocusM: { unit: 'm', source: 'NEW (P35): a ground focus is sent again once the aimed point moves this far', min: 0.01, max: 1, step: 0.01, label: 'ground refocus' },
    aimRangeM: { unit: 'm', source: 'NEW (P35): how far the crosshair looks for what a throw converges on', min: 5, max: 200, step: 1, label: 'aim range' },
    aimConvergeM: { unit: 'm', source: 'NEW (P35): a throw converges on the crosshair this far out when it rests on nothing', min: 2, max: 200, step: 1, label: 'aim converge' },
    arcMaxS: { unit: 's', source: 'NEW (P35): the throw arc is drawn for at most this long a flight', min: 0.5, max: 10, step: 0.1, label: 'arc length' },
    wheelPxPerNotch: { unit: 'px', source: 'NEW (P35): a pixel-mode wheel event (Chrome: 100 px a notch)', min: 1, max: 400, step: 1, label: 'wheel px / notch' },
    wheelLinesPerNotch: { unit: 'lines', source: 'NEW (P35): a line-mode wheel event (Firefox: 3 lines a notch)', min: 1, max: 20, step: 1, label: 'wheel lines / notch' },
  },
);

/** What the verb UI is doing (§10.7). */
export type UiMode = 'idle' | 'radial' | 'second' | 'throwAim' | 'place';

/** A highlighted target: an entity (with the aimed point on it) or a point on the ground. */
export type TargetRef = { kind: 'entity'; id: number; at: Vector3 } | { kind: 'ground'; at: Vector3 };

/** The ground forward/right of the camera the player steers by (CameraPort.moveBasis). */
export type MoveBasis = () => { forward: Vector3; right: Vector3 };

/** What the verb UI reads and draws with (main.ts builds it; tests pass a world and a camera). */
export interface VerbUiDeps {
  /** The world the player is in (read-only: the player, focus, entities, ropes, terrain, queries). */
  readonly world: World;
  /**
   * The view the player aims through: the gameplay camera (never a kill cam's) and whether it is the fight camera
   * (CameraDirector: `view`, `fightWeight ≥ 0.5`).
   */
  view(): { camera: Camera; fight: boolean };
  /** The key bindings, for the prompts' key labels. */
  readonly bindings?: () => Readonly<Bindings>;
  /** The player's prefs ("hold to crouch"). */
  readonly prefs?: () => Readonly<Pick<Prefs, 'holdToCrouch'>>;
  readonly radial?: Radial | null;
  readonly highlight?: Highlight | null;
  readonly ghost?: Ghost | null;
  readonly arc?: AimArc | null;
}

/** The placement being previewed: what the C key's ghost shows and the command LMB would send. */
export interface PlacePreview {
  /** The command LMB sends (a sloped one carries the pitch the sim's cast gives). */
  cmd: VerbCommand;
  /** Where the ghost is drawn: the resting pose when it fits, the commanded pose otherwise. */
  pose: Pose3;
  /** The sim's placement rule accepts it (planPlace, read-only). */
  ok: boolean;
  /** Why not, when it doesn't. */
  reason: string | null;
}

const DEG = Math.PI / 180;
const MAX_CHARGE = COMMAND_STEPS - 1;
const QUARTER = COMMAND_STEPS / 4;
const PITCH_SLOPED_PROBE = COMMAND_STEPS / 8;
const ORIENTATIONS: readonly PlaceOrientation[] = ['lying', 'upright', 'sloped'];
const BELT_ACTIONS = ['belt1', 'belt2', 'belt3'] as const;
const isStrike = (m: unknown): m is Button => (BUTTONS as readonly unknown[]).includes(m);
const isPunch = (b: Button) => b === 'lpunch' || b === 'rpunch';

/** Whole 1/256 turns of a yaw in degrees (0..255). */
export function yawSteps(deg: number): number {
  return ((Math.round((deg / 360) * COMMAND_STEPS) % COMMAND_STEPS) + COMMAND_STEPS) % COMMAND_STEPS;
}

/** A throw's charge (0..255) after `ticks` held: from 0 (half speed) to 255 (full) over VERB_TUNING.throwChargeS. */
export function chargeAfter(ticks: number): number {
  const s = VERB_TUNING.throwChargeS;
  if (!(s > 0)) return MAX_CHARGE;
  return Math.max(0, Math.min(MAX_CHARGE, Math.round((MAX_CHARGE * Math.max(0, ticks) * DT) / s)));
}

/**
 * The prompt over a highlighted target (§10.7): "G take · V verbs", "G drag (120 kg)", "too heavy (300 kg)", "G take
 * the end". Keys from the bindings; masses from the sim's own take rule (takeMode).
 */
export function promptFor(world: World, player: Fighter, target: TargetRef | null, keys: Readonly<Bindings> = DEFAULT_BINDINGS): string | null {
  if (!target) return null;
  const verbs = `${keyLabel(keys.verb)} verbs`;
  const take = keyLabel(keys.pickup);
  if (target.kind === 'ground') return verbs;
  const e = world.entities.get(target.id);
  if (!e) return null;
  if (e.state === 'tied' && isRopeEntity(e)) return ropeEndInReach(world, player, e.id) ? `${take} take the end · ${verbs}` : verbs;
  if (e.state !== 'free' || isRooted(e) || world.entities.isAnchored(e)) return verbs;
  const kg = Math.round(heldShape(world, e.id).massKg);
  const tm = takeMode(world, e.id, player.scale);
  if (!tm) return `too heavy (${kg} kg) · ${verbs}`;
  if (tm.mode === 'drag') return `${take} drag (${kg} kg) · ${verbs}`;
  if (tm.mode === 'carry') return `${take} carry (${kg} kg) · ${verbs}`;
  return `${take} take · ${verbs}`;
}

/** Per-frame working state. */
interface Frame {
  inp: FullInputFrame;
  tick: number;
  /** Sim seconds since the last frame (from the ticks). */
  dtS: number;
  out: Command[];
}

export class VerbInput implements VerbInputPort {
  mode: UiMode = 'idle';
  /** The client's pick this frame (what the focus commands follow). */
  target: TargetRef | null = null;
  /** The first target during the second-target step. */
  first: TargetRef | null = null;
  /** The verb waiting for its second target. */
  secondVerb: 'lash' | 'bend' | null = null;
  readonly targeting = new Targeting();
  /** The placement preview's settings (C): yaw in degrees (from +z toward +x), orientation, drive (auto / 1 / 0). */
  readonly placing: { yawDeg: number; orientation: PlaceOrientation; drive: 0 | 1 | undefined } = { yawDeg: 0, orientation: 'lying', drive: undefined };
  /** The current placement preview (place mode). */
  preview: PlacePreview | null = null;
  /** The throw being aimed: its charge (0..255) and unit direction. */
  readonly aiming = { charge: 0, dir: new Vector3(0, 0, 1) };
  /** Crouching (the toggle, or the key held with "hold to crouch"). */
  crouching = false;
  /** The pad's sprint toggle (LS), which ends when you stop. */
  padSprint = false;
  /** A `pull` is on (a punch held with a rope end in hand). */
  pulling = false;
  private modeTick = 0;
  private modeBy: 'key' | 'pad' = 'key';
  private radialTarget: TargetRef | null = null;
  private lastTick: number | null = null;
  /** The last focus sent: its key ('e:<id>', 'g', or 'none'), the target and ground point, and when. */
  private sent: { key: string; target: number; at: Vector3 | null; tick: number } | null = null;
  private wheelAcc = 0;
  private flickArmed = true;
  private beltNext = 0;
  private readonly headlessRadial = new Radial(null);

  constructor(
    private readonly basis: MoveBasis,
    private readonly deps: VerbUiDeps | null = null,
    readonly player = LOCAL_PLAYER,
  ) {}

  /** The radial (the one main.ts built, or a headless one). */
  get radial(): Radial {
    return this.deps?.radial ?? this.headlessRadial;
  }

  /** Turns one input frame into this frame's commands for `tick`; the only producer of commands in the client. */
  commands(raw: InputFrame, tick: number): Command[] {
    const inp = fullFrame(raw);
    const dtS = this.lastTick === null ? 0 : Math.max(0, tick - this.lastTick) * DT;
    this.lastTick = tick;
    const f: Frame = { inp, tick, dtS, out: [] };
    const world = this.deps?.world ?? null;
    const me = world?.player ?? null;
    if (!world || !me) return [this.move(f), ...this.bare(f)];

    if (!me.alive) this.toIdle();
    const startMode = this.mode;
    this.retarget(f, world, me);
    this.syncFocus(f, world, me);
    if (inp.cancel && this.mode !== 'idle') this.toIdle();
    else if (startMode === 'radial') this.radialFrame(f, world, me);
    else if (startMode === 'second') this.secondFrame(f, world, me);
    else if (startMode === 'throwAim') this.throwFrame(f, world, me);
    else if (startMode === 'place') this.placeFrame(f, world, me);
    if (startMode === 'idle' && me.alive) this.idleFrame(f, world, me);
    this.pull(f, me);
    this.body(f, startMode);
    this.draw(world, me);
    return [this.move(f), ...f.out];
  }

  // ---------------------------------------------------------------------------
  // Targeting and focus
  // ---------------------------------------------------------------------------

  /** The ray the player aims along: the camera's centre ray, or the facing in the fight camera (§10.7). */
  aimRay(me: Fighter): AimRay | null {
    const v = this.deps?.view();
    if (!v) return null;
    if (v.fight) {
      const p = VERB_UI_TUNING.fightAimPitchDeg * DEG;
      return { origin: chestOf(me), dir: new Vector3(Math.sin(me.yaw) * Math.cos(p), -Math.sin(p), Math.cos(me.yaw) * Math.cos(p)), fight: true };
    }
    const cam = v.camera;
    return { origin: cam.position.clone(), dir: new Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize(), fight: false };
  }

  private retarget(f: Frame, world: World, me: Fighter): void {
    // The radial freezes the view: what was pointed at stays pointed at.
    if (this.mode === 'radial') return;
    const ray = this.aimRay(me);
    if (!ray || !me.alive) {
      this.target = null;
      return;
    }
    this.target = this.targeting.pick(world, me, ray, (ref) => validateVerb(world, me, this.focusCommand(f.tick, ref)).ok);
    let step = 0;
    if (this.mode === 'idle' || this.mode === 'second') {
      step += f.inp.cycle;
      const pad = f.inp.pad;
      if (pad?.pressed.includes(PAD.right)) step += 1;
      if (pad?.pressed.includes(PAD.left)) step -= 1;
    }
    if (step !== 0) this.target = this.targeting.cycle(step);
  }

  private focusCommand(tick: number, ref: TargetRef | null): VerbCommand {
    if (!ref) return { tick, player: this.player, kind: 'verb', verb: 'focus', target: 0 };
    if (ref.kind === 'ground') return { tick, player: this.player, kind: 'verb', verb: 'focus', target: 0, at: toCm(ref.at) };
    return { tick, player: this.player, kind: 'verb', verb: 'focus', target: ref.id };
  }

  /**
   * A `focus` whenever the pick changes (a ground point once it has moved groundRefocusM), a clear when it goes, none
   * while locked on (the sim drops a focus then); and again after refocusS when the sim has dropped one it was sent.
   */
  private syncFocus(f: Frame, world: World, me: Fighter): void {
    const want = me.alive && !me.lockedOn ? this.target : null;
    const key = want ? (want.kind === 'entity' ? `e:${want.id}` : 'g') : 'none';
    const s = this.sent;
    let send = false;
    if (!s) send = want !== null;
    else if (s.key !== key) send = true;
    else if (want?.kind === 'ground' && s.at && s.at.distanceTo(want.at) >= VERB_UI_TUNING.groundRefocusM) send = true;
    else if (want && f.tick - s.tick >= VERB_UI_TUNING.refocusS / DT) {
      const fo = world.verbs.focusOf(me);
      const target = want.kind === 'entity' ? want.id : 0;
      send = !fo || fo.target !== target;
    }
    if (!send) return;
    f.out.push(this.focusCommand(f.tick, want));
    this.sent = { key, target: want?.kind === 'entity' ? want.id : 0, at: want?.kind === 'ground' ? want.at.clone() : null, tick: f.tick };
  }

  /**
   * What a verb acts on: the sim's focus (world.verbs.focusOf), with the aimed point on it (the client's, when it is the
   * client's pick too; else the sim's verbAim).
   */
  actTarget(world: World, me: Fighter): TargetRef | null {
    const fo = world.verbs.focusOf(me);
    if (!fo) return null;
    if (fo.target > 0) {
      const pick = this.target;
      const e = world.entities.get(fo.target);
      if (!e) return null;
      const at =
        pick?.kind === 'entity' && pick.id === fo.target
          ? pick.at.clone()
          : me.verbAim
            ? me.verbAim.clone()
            : new Vector3(e.pose.p.x, e.pose.p.y, e.pose.p.z);
      return { kind: 'entity', id: fo.target, at };
    }
    return fo.at ? { kind: 'ground', at: new Vector3(fo.at.x, fo.at.y, fo.at.z) } : null;
  }

  /** A point on an entity's surface (or a tied rope's segment) nearest `p`, in whole cm: an anchor the sim accepts. */
  private anchorCm(world: World, id: number, p: Vector3): [number, number, number] {
    const proj = world.queries.projectPoint(id, p);
    if (Number.isFinite(proj.dist)) return toCm(proj.point);
    const r = ropeNearest(world, id, p);
    return toCm(r ? r.point : p);
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------

  private toIdle(): void {
    if (this.mode === 'radial') this.radial.close();
    this.mode = 'idle';
    this.first = null;
    this.secondVerb = null;
    this.preview = null;
    this.radialTarget = null;
  }

  private enter(mode: UiMode, tick: number, by: 'key' | 'pad'): void {
    this.mode = mode;
    this.modeTick = tick;
    this.modeBy = by;
  }

  /** Something carried or wielded (not dragged, not a rope end): what can be thrown or placed. */
  private holding(me: Fighter): number | null {
    const h = me.inventory?.hands;
    return h && (h.mode === 'wield' || h.mode === 'carry') ? h.entity : null;
  }

  private idleFrame(f: Frame, world: World, me: Fighter): void {
    const { inp } = f;
    const pad = inp.pad;
    const padPressed = (b: number) => !!pad?.pressed.includes(b);
    const keyPressed = (a: FullInputFrame['pressed'][number]) => inp.pressed.includes(a);

    // Starting a mode.
    if (keyPressed('verb') || padPressed(PAD.lb)) {
      this.radialTarget = this.actTarget(world, me);
      const opts = verbsFor(world, me, this.radialTarget).map((o) => this.radialOption(world, o, this.radialTarget));
      this.radial.open(opts);
      this.enter('radial', f.tick, keyPressed('verb') ? 'key' : 'pad');
      return;
    }
    const held = this.holding(me);
    if ((keyPressed('throw') || padPressed(PAD.rb)) && held !== null) {
      this.enter('throwAim', f.tick, keyPressed('throw') ? 'key' : 'pad');
      this.aiming.charge = 0;
      return;
    }
    if ((keyPressed('place') || padPressed(PAD.down)) && held !== null) {
      this.enter('place', f.tick, keyPressed('place') ? 'key' : 'pad');
      const ray = this.aimRay(me);
      this.placing.yawDeg = ray ? Math.atan2(ray.dir.x, ray.dir.z) / DEG : (me.yaw / DEG);
      this.placing.orientation = 'lying';
      this.placing.drive = undefined;
      this.wheelAcc = 0;
      this.flickArmed = true;
      this.preview = this.placePreview(f.tick, world, me);
      return;
    }

    // Take / drop.
    if (inp.pickup || keyPressed('pickup') || padPressed(PAD.rs)) this.takeOrDrop(f, world, me);

    // Belt and back: draw into empty hands, or stow what is held there.
    const inv = me.inventory;
    if (inv) {
      BELT_ACTIONS.forEach((a, slot) => {
        if (keyPressed(a)) f.out.push(this.slotCommand(f.tick, inv.hands ? 'stow' : 'draw', slot));
      });
      if (keyPressed('back')) f.out.push(this.slotCommand(f.tick, inv.hands ? 'stow' : 'draw', backSlot(me)));
      if (padPressed(PAD.back)) this.beltCycle(f, world, me);
      if (padPressed(PAD.up) && inv.hands) this.stowAnywhere(f, world, me);
    }

    // Strikes (holding a rope end, the punches haul it instead: pull()).
    const ropeEnd = me.inventory?.hands?.mode === 'ropeEnd';
    for (const b of this.strikes(inp)) {
      if (ropeEnd && isPunch(b)) continue;
      f.out.push({ tick: f.tick, player: this.player, kind: 'button', button: b });
    }
  }

  /** This frame's strike presses: the keyboard's and touch's, the mouse's buttons, and the pad's X/Y/LT/RT. */
  private strikes(inp: FullInputFrame): Button[] {
    const out: Button[] = [...inp.presses];
    for (const c of inp.clicks) if (c.down) out.push(c.button === 0 ? 'lpunch' : 'rpunch');
    for (const b of inp.pad?.pressed ?? []) {
      const m = PAD_BINDINGS[b];
      if (isStrike(m)) out.push(m);
    }
    return out;
  }

  private slotCommand(tick: number, verb: 'stow' | 'draw', slot: number): VerbCommand {
    return { tick, player: this.player, kind: 'verb', verb, target: 0, slot };
  }

  /** G (pad RS): take the focused thing when the sim would let you (or when the hands are empty, to hear why); else drop. */
  private takeOrDrop(f: Frame, world: World, me: Fighter): void {
    const t = this.actTarget(world, me);
    const hands = me.inventory?.hands ?? null;
    if (t?.kind === 'entity') {
      const take: VerbCommand = { tick: f.tick, player: this.player, kind: 'verb', verb: 'take', target: t.id };
      if (!hands || validateVerb(world, me, take).ok) {
        f.out.push(take);
        return;
      }
    }
    if (hands) f.out.push({ tick: f.tick, player: this.player, kind: 'verb', verb: 'drop', target: 0 });
  }

  /** The pad's Back: the belt into empty hands one slot after another; with something held, it goes onto the belt. */
  private beltCycle(f: Frame, world: World, me: Fighter): void {
    const inv = me.inventory!;
    if (inv.hands) {
      this.stowAnywhere(f, world, me);
      return;
    }
    const n = Math.min(VERB_TUNING.beltSlots, inv.belt.length);
    for (let k = 0; k < n; k++) {
      const s = (this.beltNext + k) % n;
      if (inv.belt[s] !== null) {
        f.out.push(this.slotCommand(f.tick, 'draw', s));
        this.beltNext = (s + 1) % n;
        return;
      }
    }
  }

  /** The pad's D-pad ↑: onto the first belt slot that takes it, else the back (else the belt, to hear why not). */
  private stowAnywhere(f: Frame, world: World, me: Fighter): void {
    const inv = me.inventory!;
    const n = Math.min(VERB_TUNING.beltSlots, inv.belt.length);
    const slots: number[] = [];
    for (let s = 0; s < n; s++) if (inv.belt[s] === null) slots.push(s);
    slots.push(backSlot(me));
    for (const s of slots) {
      const c = this.slotCommand(f.tick, 'stow', s);
      if (validateVerb(world, me, c).ok) {
        f.out.push(c);
        return;
      }
    }
    f.out.push(this.slotCommand(f.tick, 'stow', slots[0]));
  }

  /** A verbsFor option as a sector, its refusal in words. */
  private radialOption(world: World, o: ReturnType<typeof verbsFor>[number], target: TargetRef | null): RadialOption {
    let mass: number | undefined;
    if (o.reasonIfDisabled === 'tooHeavy' && target?.kind === 'entity' && world.entities.get(target.id)) mass = heldShape(world, target.id).massKg;
    const r: RadialOption = { verb: o.verb, label: o.label, disabled: o.reasonIfDisabled ? reasonText(o.reasonIfDisabled, mass) : null };
    if (o.slot !== undefined) r.slot = o.slot;
    if (o.needsSecond) r.needsSecond = true;
    return r;
  }

  private radialFrame(f: Frame, world: World, me: Fighter): void {
    const { inp } = f;
    const r = this.radial;
    const pad = inp.pad;
    if (inp.mouse.dx !== 0 || inp.mouse.dy !== 0) r.point(inp.mouse.dx, inp.mouse.dy);
    if (this.modeBy === 'pad' && pad) r.stick(pad.rx, pad.ry);
    const released = this.modeBy === 'key' ? !inp.held.has('verb') : !pad?.held[PAD.lb];
    if (!released) return;
    const sel = r.selected;
    const target = this.radialTarget;
    this.toIdle();
    if (sel && !sel.disabled) this.runOption(f, world, me, sel, target);
  }

  /** A radial option, run on the target the radial was opened on. */
  private runOption(f: Frame, world: World, me: Fighter, o: RadialOption, t: TargetRef | null): void {
    const tick = f.tick;
    const player = this.player;
    const entity = t?.kind === 'entity' ? t : null;
    switch (o.verb) {
      case 'lash':
      case 'bend':
        if (!entity) return;
        this.enter('second', tick, this.modeBy);
        this.first = { kind: 'entity', id: entity.id, at: entity.at.clone() };
        this.secondVerb = o.verb;
        return;
      case 'take':
      case 'untie':
      case 'cut':
        if (entity) f.out.push({ tick, player, kind: 'verb', verb: o.verb, target: entity.id });
        return;
      case 'tie':
        if (entity) f.out.push({ tick, player, kind: 'verb', verb: 'tie', target: entity.id, at: this.anchorCm(world, entity.id, entity.at) });
        return;
      case 'shape':
        if (entity) f.out.push({ tick, player, kind: 'verb', verb: 'shape', target: entity.id, at: this.anchorCm(world, entity.id, entity.at), charge: 1 });
        return;
      case 'dig':
        if (t?.kind === 'ground') f.out.push({ tick, player, kind: 'verb', verb: 'dig', target: 0, at: toCm(t.at), charge: 1 });
        return;
      case 'stow':
      case 'draw':
        f.out.push(this.slotCommand(tick, o.verb, o.slot ?? 0));
        return;
      case 'drop':
        if (me.inventory?.hands) f.out.push({ tick, player, kind: 'verb', verb: 'drop', target: 0 });
        return;
      default:
        // focus, place, throw and pull have their own controls (§5.13).
        return;
    }
  }

  private secondFrame(f: Frame, world: World, me: Fighter): void {
    const { inp } = f;
    const pad = inp.pad;
    const first = this.first;
    if (!first || first.kind !== 'entity' || !world.entities.get(first.id) || f.tick - this.modeTick >= VERB_UI_TUNING.secondTimeoutS / DT) {
      this.toIdle();
      return;
    }
    const cancel = inp.clicks.some((c) => c.down && c.button === 2) || !!pad?.pressed.includes(PAD_MODE.cancel);
    if (cancel) {
      this.toIdle();
      return;
    }
    const confirm = inp.clicks.some((c) => c.down && c.button === 0) || inp.pressed.includes('rpunch') || !!pad?.pressed.includes(PAD_MODE.confirm);
    if (!confirm) return;
    const second = this.actTarget(world, me);
    // (Nothing else focused yet: the step waits for one.)
    if (second?.kind !== 'entity' || second.id === first.id) return;
    const at2 = this.anchorCm(world, second.id, second.at);
    if (this.secondVerb === 'bend') f.out.push({ tick: f.tick, player: this.player, kind: 'verb', verb: 'bend', target: first.id, second: second.id, at2 });
    else f.out.push({ tick: f.tick, player: this.player, kind: 'verb', verb: 'lash', target: first.id, second: second.id, at: this.anchorCm(world, first.id, first.at), at2 });
    this.toIdle();
  }

  /** The throw's direction: converging on what the crosshair rests on, or along the facing in the fight camera. */
  private throwDir(world: World, me: Fighter, held: number): Vector3 {
    const ray = this.aimRay(me);
    if (!ray || ray.fight) {
      const p = VERB_UI_TUNING.fightThrowPitchDeg * DEG;
      return new Vector3(Math.sin(me.yaw) * Math.cos(p), Math.sin(p), Math.cos(me.yaw) * Math.cos(p));
    }
    const T = VERB_UI_TUNING;
    const hit = world.queries.castRay(ray.origin, ray.dir, T.aimRangeM, {
      terrain: true,
      entities: 'all',
      fighters: 'zones',
      exclude: { entities: heldMembers(world, held), fighters: [me.id] },
    });
    const aim = hit ? new Vector3(hit.point.x, hit.point.y, hit.point.z) : ray.origin.clone().addScaledVector(ray.dir, T.aimConvergeM);
    const hand = handPoint(me);
    const d = aim.sub(new Vector3(hand.x, hand.y, hand.z));
    if (!(d.dot(ray.dir) > 1e-6) || !(d.lengthSq() > 1e-12)) return ray.dir.clone();
    return d.normalize();
  }

  private throwFrame(f: Frame, world: World, me: Fighter): void {
    const { inp } = f;
    const pad = inp.pad;
    const held = this.holding(me);
    if (held === null) {
      this.toIdle();
      return;
    }
    if (inp.clicks.some((c) => c.down && c.button === 0) || !!pad?.pressed.includes(PAD_MODE.cancel)) {
      this.toIdle();
      return;
    }
    this.aiming.charge = chargeAfter(f.tick - this.modeTick);
    this.aiming.dir.copy(this.throwDir(world, me, held));
    const released = this.modeBy === 'key' ? !inp.held.has('throw') : !pad?.held[PAD.rb];
    if (!released) return;
    f.out.push({ tick: f.tick, player: this.player, kind: 'verb', verb: 'throw', target: 0, aim: aimOf(this.aiming.dir), charge: this.aiming.charge });
    this.toIdle();
  }

  private placeFrame(f: Frame, world: World, me: Fighter): void {
    const { inp } = f;
    const pad = inp.pad;
    const padPressed = (b: number) => !!pad?.pressed.includes(b);
    const T = VERB_UI_TUNING;
    if (this.holding(me) === null) {
      this.toIdle();
      return;
    }
    const cancel = this.modeBy === 'key' ? !inp.held.has('place') : padPressed(PAD.down) || padPressed(PAD_MODE.cancel);
    if (cancel) {
      this.toIdle();
      return;
    }
    // Turn: the wheel a notch at a time, the pad's stick at padRotateDegS.
    this.wheelAcc += inp.wheel;
    while (Math.abs(this.wheelAcc) >= 1) {
      const s = Math.sign(this.wheelAcc);
      this.placing.yawDeg += s * T.wheelStepDeg;
      this.wheelAcc -= s;
    }
    if (pad) this.placing.yawDeg += pad.rx * T.padRotateDegS * f.dtS;
    this.placing.yawDeg = ((this.placing.yawDeg % 360) + 360) % 360;
    // Lying → upright → sloped: RMB, or a flick of the pad's stick.
    let cycle = inp.clicks.some((c) => c.down && c.button === 2);
    if (pad) {
      if (this.flickArmed && Math.abs(pad.ry) > T.radialStickMin) {
        cycle = true;
        this.flickArmed = false;
      } else if (Math.abs(pad.ry) <= T.padStickDead) this.flickArmed = true;
    }
    if (cycle) this.placing.orientation = ORIENTATIONS[(ORIENTATIONS.indexOf(this.placing.orientation) + 1) % ORIENTATIONS.length];
    // Drive: auto → drive → don't → auto (Shift, pad X).
    if (inp.pressed.includes('sprint') || padPressed(PAD_MODE.drive)) this.placing.drive = this.placing.drive === undefined ? 1 : this.placing.drive === 1 ? 0 : undefined;
    this.preview = this.placePreview(f.tick, world, me);
    const set = inp.clicks.some((c) => c.down && c.button === 0) || padPressed(PAD_MODE.confirm);
    if (set && this.preview) {
      f.out.push(this.preview.cmd);
      this.toIdle();
    }
  }

  /**
   * Where the aim puts the near (or lower) end of what is held: where the aim ray meets the terrain or an entity, no
   * further than placeReachM across the ground from the player.
   */
  private placeAim(world: World, me: Fighter, held: number): Vector3 {
    const reach = VERB_TUNING.placeReachM * me.scale;
    const ray = this.aimRay(me);
    let p: Vector3 | null = null;
    if (ray) {
      const hit = world.queries.castRay(ray.origin, ray.dir, VERB_UI_TUNING.aimRangeM, {
        terrain: true,
        entities: 'all',
        exclude: { entities: heldMembers(world, held) },
      });
      p = hit ? new Vector3(hit.point.x, hit.point.y, hit.point.z) : rayTerrain(world, ray, VERB_UI_TUNING.aimRangeM);
    }
    const fwd = ray ? new Vector3(ray.dir.x, 0, ray.dir.z) : new Vector3(Math.sin(me.yaw), 0, Math.cos(me.yaw));
    if (!(fwd.lengthSq() > 1e-12)) fwd.set(Math.sin(me.yaw), 0, Math.cos(me.yaw));
    fwd.normalize();
    if (!p) p = new Vector3(me.pos.x, 0, me.pos.z).addScaledVector(fwd, reach);
    const dx = p.x - me.pos.x;
    const dz = p.z - me.pos.z;
    const h = Math.hypot(dx, dz);
    if (h > reach) {
      p.set(me.pos.x + (dx / h) * reach, 0, me.pos.z + (dz / h) * reach);
      p.y = world.terrain.heightAt(p.x, p.z);
    }
    return p;
  }

  /**
   * The place command the preview would send, and what the sim's placement rule makes of it (planPlace, read-only):
   * lying with its near end at the aim point, upright on it, or sloped from it at the pitch the rule's cast finds onto
   * the highest support under the upper half (the command then carries that pitch, and the resting centre as `at`).
   */
  placePreview(tick: number, world: World, me: Fighter): PlacePreview | null {
    const held = this.holding(me);
    if (held === null) return null;
    const hs = heldShape(world, held);
    const L = hs.lengthM;
    const r = hs.crossHalfM;
    const drop = VERB_TUNING.placeDropM;
    const aim = this.placeAim(world, me, held);
    const yaw = this.placing.yawDeg * DEG;
    const o = this.placing.orientation;
    const pitchSteps = o === 'lying' ? 0 : o === 'upright' ? QUARTER : PITCH_SLOPED_PROBE;
    const pitch = (pitchSteps / COMMAND_STEPS) * 2 * Math.PI;
    const hor = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const along = hor.clone().multiplyScalar(Math.cos(pitch)).add(new Vector3(0, Math.sin(pitch), 0));
    // The side that faces up, square to the axis in its vertical plane.
    const upSide = hor.clone().multiplyScalar(-Math.sin(pitch)).add(new Vector3(0, Math.cos(pitch), 0));
    const at =
      o === 'upright'
        ? aim.clone().add(new Vector3(0, L / 2 + drop, 0))
        : aim
            .clone()
            .addScaledVector(along, L / 2)
            .addScaledVector(upSide, r + drop);
    const base: VerbCommand = { tick, player: this.player, kind: 'verb', verb: 'place', target: 0, at: toCm(at), yaw: yawSteps(this.placing.yawDeg), pitch: pitchSteps };
    if (this.placing.drive !== undefined) base.drive = this.placing.drive;
    const plan = planPlace(world, me, base);
    if (!plan.ok) return { cmd: base, pose: this.displayPose(world, held, at, along), ok: false, reason: reasonText(plan.reason) };
    if (plan.plan.mode !== 'sloped' || plan.plan.driven) return { cmd: base, pose: plan.plan.pose, ok: true, reason: null };
    // Sloped: the pitch the cast found (and the centre it rests at), quantised to the command's 1/256 turn.
    const steps = Math.max(1, Math.min(QUARTER - 1, Math.round((plan.plan.pitch / (2 * Math.PI)) * COMMAND_STEPS)));
    const centre = verbGeom.pointToWorld(plan.plan.pose, hs.centre);
    const cmd: VerbCommand = { ...base, at: toCm(centre), pitch: steps };
    const again = planPlace(world, me, cmd);
    if (!again.ok) return { cmd: base, pose: plan.plan.pose, ok: true, reason: null };
    return { cmd, pose: again.plan.pose, ok: true, reason: null };
  }

  /** The commanded pose, roughly (the held object's axis along `along`, its centre at `at`): the red ghost. */
  private displayPose(world: World, held: number, at: Vector3, along: Vector3): Pose3 {
    const e = world.entities.get(held)!;
    const hs = heldShape(world, held);
    // The end that goes up (D-49): the head's end, else the lighter end (heldShape's axis points at the heavier one).
    const ax = hs.head ? hs.axis : verbGeom.scale(hs.axis, -1);
    const d = verbGeom.dirToWorld(e.pose, ax);
    const turn = rotationBetween(new Vector3(d.x, d.y, d.z).normalize(), along.clone().normalize());
    // The held entity's rotation: the turn taking its axis onto `along`, after its current rotation.
    const q = verbGeom.mulQuat(turn, e.pose.q);
    const c = verbGeom.rotate(q, hs.centre);
    return { p: { x: at.x - c.x, y: at.y - c.y, z: at.z - c.z }, q };
  }

  // ---------------------------------------------------------------------------
  // Pull, the walk, the visuals
  // ---------------------------------------------------------------------------

  /** Holding a rope end, a punch held hauls it (§5.12): `pull` on when one is first held, off when none is. */
  private pull(f: Frame, me: Fighter): void {
    const { inp } = f;
    const ropeEnd = me.alive && me.inventory?.hands?.mode === 'ropeEnd';
    const pad = inp.pad;
    const punching =
      inp.held.has('lpunch') || inp.held.has('rpunch') || inp.mouse.left || inp.mouse.right || !!pad?.held[PAD.x] || !!pad?.held[PAD.y];
    const want = ropeEnd && this.mode === 'idle' && punching;
    if (want === this.pulling) return;
    this.pulling = want;
    f.out.push({ tick: f.tick, player: this.player, kind: 'verb', verb: 'pull', target: 0, charge: want ? MAX_CHARGE : 0 });
  }

  /** Jump, crouch and the pad's sprint toggle. */
  private body(f: Frame, startMode: UiMode): void {
    const { inp } = f;
    const pad = inp.pad;
    const padIdle = startMode === 'idle';
    if (startMode !== 'radial' && (inp.pressed.includes('jump') || (padIdle && pad?.pressed.includes(PAD.a)))) {
      f.out.push({ tick: f.tick, player: this.player, kind: 'button', button: 'jump' });
    }
    if (this.deps?.prefs?.().holdToCrouch) this.crouching = inp.held.has('crouch');
    else if (inp.pressed.includes('crouch')) this.crouching = !this.crouching;
    if (padIdle && pad?.pressed.includes(PAD.b)) this.crouching = !this.crouching;
    if (padIdle && pad?.pressed.includes(PAD.ls)) this.padSprint = !this.padSprint;
  }

  /** The camera-relative walk with the sprint and crouch flags. */
  private move(f: Frame): Command {
    const { inp } = f;
    const { forward: fwd, right } = this.basis();
    if (Math.hypot(inp.moveX, inp.moveY) <= VERB_UI_TUNING.padStickDead) this.padSprint = false;
    // (While placing, Shift is the drive toggle, not a sprint.)
    const sprint = (inp.held.has('sprint') && this.mode !== 'place') || this.padSprint;
    const flags = (sprint ? MOVE_SPRINT : 0) | (this.crouching ? MOVE_CROUCH : 0);
    // Screen-space stick → a world walk vector on the camera's ground plane (DS game.ts frame).
    return moveCommand(f.tick, this.player, right.x * inp.moveX + fwd.x * inp.moveY, right.z * inp.moveX + fwd.z * inp.moveY, flags);
  }

  /** No world (P31's stub behaviour): the strikes, DS's pick-up button, jump. */
  private bare(f: Frame): Command[] {
    const { inp, tick } = f;
    const player = this.player;
    const out: Command[] = this.strikes(inp).map((b) => ({ tick, player, kind: 'button', button: b }) as Command);
    if (inp.pickup || inp.pad?.pressed.includes(PAD.rs)) out.push({ tick, player, kind: 'button', button: 'pickup' });
    if (inp.pressed.includes('jump') || inp.pad?.pressed.includes(PAD.a)) out.push({ tick, player, kind: 'button', button: 'jump' });
    if (inp.pressed.includes('crouch')) this.crouching = !this.crouching;
    return out;
  }

  /** The outline and prompt, the ghost, the arc (presentation; reads the world, writes nothing). */
  private draw(world: World, me: Fighter): void {
    const d = this.deps;
    if (!d) return;
    const cam = d.view().camera;
    const keys = d.bindings?.() ?? DEFAULT_BINDINGS;
    const held = this.holding(me);
    if (d.highlight) {
      const outline = this.mode === 'idle' || this.mode === 'second' || this.mode === 'radial';
      const t = outline && me.alive ? this.actTarget(world, me) : null;
      let prompt: { text: string; at: Vector3 | null } | null = null;
      if (this.mode === 'idle' && t) {
        const text = promptFor(world, me, t, keys);
        if (text) prompt = { text, at: null };
      } else if (this.mode === 'second') {
        prompt = { text: `LMB / ${keyLabel(keys.rpunch)} ${this.secondVerb} to this · RMB cancel`, at: null };
      } else if (this.mode === 'place' && this.preview) {
        const p = this.preview;
        const drive = this.placing.drive === undefined ? 'auto' : this.placing.drive === 1 ? 'on' : 'off';
        const centre = new Vector3(p.pose.p.x, p.pose.p.y + 0.3, p.pose.p.z);
        prompt = {
          text: `${this.placing.orientation}${p.ok ? '' : ` — ${p.reason ?? "won't fit"}`} · wheel turn · RMB lying/upright/angled · ${keyLabel(keys.sprint)} drive: ${drive} · LMB set`,
          at: centre,
        };
      }
      d.highlight.show(world, t, this.mode === 'second' ? this.first : null, cam, prompt);
    }
    if (d.ghost) {
      if (this.mode === 'place' && this.preview && held !== null) d.ghost.show(world, held, this.preview.pose, this.preview.ok);
      else d.ghost.show(world, null, null, false);
    }
    if (d.arc) {
      if (this.mode === 'throwAim' && held !== null) {
        const hand = handPoint(me);
        const speed = throwLaunchSpeed(heldShape(world, held).massKg, this.aiming.charge);
        d.arc.show(world, new Vector3(hand.x, hand.y, hand.z), this.aiming.dir, speed);
      } else d.arc.show(world, null, null, 0);
    }
  }
}

/** The shortest rotation taking unit `a` onto unit `b` (half a turn about a perpendicular when opposite). */
function rotationBetween(a: Vector3, b: Vector3): { x: number; y: number; z: number; w: number } {
  const c = a.dot(b);
  if (c < -1 + 1e-9) {
    const p = verbGeom.perpendicular({ x: a.x, y: a.y, z: a.z });
    return { x: p.x, y: p.y, z: p.z, w: 0 };
  }
  const x = new Vector3().crossVectors(a, b);
  const l = Math.hypot(x.x, x.y, x.z, 1 + c);
  return { x: x.x / l, y: x.y / l, z: x.z / l, w: (1 + c) / l };
}
