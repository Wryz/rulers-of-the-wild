// The ports of the client (docs/M1-DESIGN.md §10.1, RF-9): the interface of every module game.ts calls, the changed
// DungeonStyle modules included. game.ts imports nothing from the client but these types; main.ts builds one of each
// port (GamePorts) and hands them to Game.create. Each later package implements its port in its own files, next to the
// module it changes, so P32-P37 never edit game.ts:
//
//   WorldViewsPort, FighterViewPort  P32  render/worldViews.ts (+ terrainView, forestView, entityViews, ropeView,
//                                         grassView, sky; render/fighterView.ts is the DS view it wraps)
//   PresentationPort, FxPort         P33  game/presentationWorld.ts (body/ragdoll.ts, render/blood, gibs, particles)
//   CameraPort, CinematicsPort       P34  render/cameraDirector.ts (render/followCam, cameraRig, cinematics, cutout)
//   VerbInputPort, MenusPort         P35  input/verbInput.ts; ui/menusPort.ts (ui/settings.ts, ui/battleLog.ts,
//                                         game/recorder.ts)
//   KillCamPort, MomentsPort, HudPort P36 game/killcam.ts, game/moments.ts; ui/hud.ts (ui/compass.ts,
//                                         render/markers.ts)
//   SfxPort, PanelPort               P37  feel/sfxPort.ts (feel/audio.ts); debug/panel.ts
//   DevViewsPort                     C-fix debug/devViews.ts (developer mode: the panel's nav, senses and zones views)
//
// Every method game.ts calls is here, and nothing else. §10.1 lists the methods M1 adds; the DungeonStyle ones game.ts
// keeps calling are here too (marked "DS"), and so are a few P31 needed to keep DS's behaviour behind a port (marked
// "P31"): the `handle(e, world)` methods, through which each owner reacts to the sim's events itself (DS's handleEvent
// cases, split by owner), and what game.ts needs to draw a ragdoll, freeze a hit-pause and run the menus.
import type { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import type { BoneName, Command, CombatEvent, DevOp, Fighter, StepResult, TuningEdit, V3, World, WorldEvent, Wound } from '@wild/sim';
import type { InputFrame } from '../input/input';
import type { UiMode } from '../input/verbInput';
import type { Shot } from '../render/cinematics';
import type { Moment } from './killcam';
import type { Prefs } from './prefs';

/** One rendered frame of input (input/input.ts; P35 adds holds, releases, look, wheel, clicks and the pad). */
export type { InputFrame } from '../input/input';

/** Rule 12: the gore setting (the M5 settings row); M1 reads one value (`'full'`) in one place (game.ts). */
export type GoreLevel = 'off' | 'stylised' | 'full';

/** One of the sim's events of a tick: CombatSim's first, then the world's (§3, "one event list per tick"). */
export type SimEvent = CombatEvent | WorldEvent;

/** A body's bone poses after the last two presentation steps (a ragdoll), for drawing interpolated by alpha. P31. */
export interface BodyPose {
  readonly prev: Readonly<Record<BoneName, { readonly p: Vector3; readonly q: Quaternion }>>;
  readonly cur: Readonly<Record<BoneName, { readonly p: Vector3; readonly q: Quaternion }>>;
}

/** What the views need each rendered frame besides the world. P31 (§10.1's sync(world, alpha, cam) plus these). */
export interface ViewFrame {
  /** Real seconds since the last frame (blinks, flashes). */
  realDt: number;
  /** Game seconds since the last frame: 0 in a hit-pause or a pause, slowed in slow motion (drips, sweat, weapons). */
  gameDt: number;
  /** The presentation body to draw a fighter from (its ragdoll), or null to draw the sim's rig. */
  poseOf(f: Fighter): BodyPose | null;
  gore: GoreLevel;
  /** DS's game-style readability cues (prefs.cues; off by default, realism.test.ts). */
  cues: boolean;
}

/** P32: render/worldViews.ts over terrainView, forestView, entityViews, ropeView, grassView, sky. */
export interface WorldViewsPort {
  /** Everything in the world on screen this frame: terrain, trees, entities, ropes, grass, sky, fighters. */
  sync(world: World, alpha: number, cam: Vector3, frame: ViewFrame): void;
  /** The view of a fighter that has been synced at least once (null before that, or once it has left the world). */
  fighterView(f: Fighter): FighterViewPort | null;
  /** P31: the views' own reactions to an event (DS: a bloodied weapon, a hit flash, a torn ear, a split skull). */
  handle(e: SimEvent, world: World): void;
  dispose(): void;
}

/** P32: render/fighterView.ts (changed DS), behind the adapter in render/worldViews.ts. */
export interface FighterViewPort {
  syncFromRig(f: Fighter): void;
  setHeld(entity: number | null, world: World): void;
  // DEVIATION (C-fix): §10.1's scar(bone, local, kind) is not here. The adapter draws every ruler wound from the sim's
  // own wound records each frame (a gash healing into a scar, a wound gone), so a scar() call could only add a second,
  // untracked mark on top of one it already draws.
  setGore(level: GoreLevel): void;
  /** DS: the hit-pause jitter of the struck body (0 stills it). */
  setShiver(amount: number): void;
  // DS points and looks the effects need (FxPort: face blood, wound and weapon drips, stump spurts, sweat), P31:
  /** A point on the face (world), where blood comes from. */
  facePoint(where: 'mouth' | 'nose' | 'brow', out?: Vector3): Vector3;
  /** Where a wound bleeds from (world). */
  woundPoint(w: Wound, out?: Vector3): Vector3;
  /** The tip of the weapon in `f`'s hand as drawn (world), or null. */
  weaponTip(f: Fighter, out?: Vector3): Vector3 | null;
  /** How much blood is on the weapon in hand (0..1): a blow puts it there, drips use it up. */
  weaponBlood: number;
  /** The chest as drawn (world): a stump's spurt points away from it. */
  chest(out?: Vector3): Vector3;
  /** The skin's colour (a torn piece's gib). */
  readonly skin: string;
  /** Skin from dry to glistening (0..1). */
  setSweat(s: number): void;
  /** Facial bruising (0..1) and an open cut over the brow. */
  setTrauma(bruise: number, cut: boolean): void;
  /** Healed and clean (a respawn): wounds, blood, bruises and sweat gone; the sim's wounds are drawn again. */
  reset(): void;
}

/** P33: game/presentationWorld.ts + body/ragdoll.ts (changed DS). Never read by the sim (rule 6). */
export interface PresentationPort {
  /** One presentation step after each sim step: ragdolls follow the sim, the presentation Rapier world steps. */
  step(world: World): void;
  onLaunch(f: Fighter, vel: V3, angVel: V3): void;
  pelvisOf(f: Fighter): () => Vector3;
  snapTo(f: Fighter): void;
  dispose(): void;
  /** P31: the body to draw a fighter from (its ragdoll), or null (none: draw the rig). */
  bodyPose(f: Fighter): BodyPose | null;
  /** P31, DS: a hit-pause frame: the bodies hold still (no interpolation across the frozen step). */
  freeze(): void;
  /** P31, DS: the bodies' reactions to an event (a blow's impulse, a block, a limb cut loose). */
  handle(e: SimEvent, world: World): void;
}

/** P33: render/blood.ts, gibs.ts, particles.ts (changed DS), behind `Fx` in game/presentationWorld.ts. P31. */
export interface FxPort {
  /** Particles, blood and gibs an event throws (DS: sparks, dust, a blade's spray). */
  handle(e: SimEvent, world: World): void;
  /** Per rendered frame: particles fly, blood drips from faces, wounds and weapons, sweat builds (through the views). */
  update(gameDt: number, realDt: number, world: World): void;
  setGore(level: GoreLevel): void;
  clear(): void;
}

/** P34: render/cameraDirector.ts over followCam, cameraRig (changed DS) and cutout (changed DS). */
export interface CameraPort {
  update(dt: number, world: World, player: Fighter | null, lockTarget: Fighter | null, look: { dx: number; dy: number }): void;
  /** The ground forward/right of the camera the frame is seen through: the basis of `move` commands. */
  moveBasis(): { forward: Vector3; right: Vector3 };
  shake(trauma: number): void;
  snapBehind(f: Fighter): void;
  cutoutFocus(p: Vector3): void;
  /** The camera the frame is rendered through (a kill cam's while one runs: kill cams override both). */
  readonly camera: PerspectiveCamera;
  /** DS: a brief zoom on a heavy blow (CameraRig.zoomPunch). */
  punch(amount: number): void;
  /** DS: the view tightens a little while slow motion runs (the loop's slowmo > 0). */
  setSlowMotion(on: boolean): void;
  /** P31: the camera's own reactions to an event (landings and footfalls felt ∝ mass and distance, SPEC:581, 849). */
  handle(e: SimEvent, world: World): void;
  /** DS: the canvas changed size (px). */
  resize(width: number, height: number): void;
}

/** P34: render/cinematics.ts (changed DS: ground floor, terrain line of sight), behind render/cameraDirector.ts. */
export interface CinematicsPort {
  play(shot: Shot): boolean;
  update(dt: number): void;
  readonly active: boolean;
  readonly timeScale: number;
  setGround(ground: (x: number, z: number) => number): void;
  setBlocked(blocked: (a: Vector3, b: Vector3) => boolean): void;
  /** DS. */
  resize(aspect: number): void;
}

/** P35: input/verbInput.ts, the only producer of player commands (P31's stub: DS's move/button code). */
export interface VerbInputPort {
  commands(inp: InputFrame, tick: number): Command[];
  readonly mode: UiMode;
}

/** P36: game/killcam.ts. Every kill cam goes through onMoment (SPEC:583-588, RR-14). */
export interface KillCamPort {
  onMoment(m: Moment): boolean;
  mark(m: Moment): void;
}

/** P36: game/moments.ts. */
export interface MomentsPort {
  fromStep(r: StepResult): Moment[];
}

/** P36: ui/hud.ts (changed DS, which implements it), ui/compass.ts, render/markers.ts. */
export interface HudPort {
  update(world: World, player: Fighter | null, dt: number): void;
  mood(m: '' | 'death'): void;
  deathBanner(secondsLeft: number | null): void;
  popup(text: string): void;
  /** P31, DS: the callouts an event raises (a parry, a guard break, a missed strike). */
  handle(e: SimEvent, world: World): void;
}

/** P37: feel/audio.ts (changed DS), behind feel/sfxPort.ts. */
export interface SfxPort {
  handle(e: SimEvent, world: World): void;
  /** The ears: the camera's position, and where it looks (sounds pan to their side of it). */
  setListener(p: Vector3, forward?: Vector3): void;
  /** Per rendered frame: the ambience, and DS's panting when the player is gassed (it stops when the game does). */
  ambience(world: World, realDt: number, gameDt: number): void;
  /** DS: the mute key toggles between 0 and GAME_TUNING.volume. */
  readonly volume: number;
  setVolume(v: number): void;
}

/** P37: debug/panel.ts (rewritten). */
export interface PanelPort {
  refresh(world: World): void;
  readonly visible: boolean;
  /** DS: the L key. */
  toggle(): void;
  /** Every event of every stepped tick (the impact and tripwire read-outs); a panel without read-outs leaves it out. */
  handle?(e: SimEvent, world: World): void;
}

/** Developer mode: the panel's world views (GAME_TUNING.showNav, showSenses, showZones). Presentation only. */
export interface DevViewsPort {
  /** Per rendered frame: draws what the toggles ask for (nothing when they are off). */
  update(world: World, realDt: number): void;
  /** Every event of every stepped tick (the noises the senses view rings). */
  handle(e: SimEvent, world: World): void;
  dispose(): void;
}

/**
 * P35: ui/menusPort.ts over ui/settings.ts (changed DS), ui/battleLog.ts and game/recorder.ts (DS; the session
 * recording is started once per session, §10.11). P31.
 */
export interface MenusPort {
  /** A menu is open: the game loop pauses and turns no input into commands (rule 8, §10.2). */
  readonly open: boolean;
  readonly prefs: Readonly<Prefs>;
  /** Escape. */
  toggleSettings(): void;
  /** B. */
  openLog(): void;
  /** The battle log's marks for an event. */
  handle(e: SimEvent, world: World): void;
  /** Once per rendered frame, before the steps: the recording's clock (it stops while paused). */
  frame(paused: boolean): void;
  /** Once per rendered frame, right after the render: the recording grabs the canvas. */
  afterRender(): void;
}

/**
 * What Game (and the dev panel) may ask of the game loop (game/loop.ts). Every time effect is the loop's (rule 8): the
 * presenter raises a hit-pause or a slow motion through here and never steps the world itself. P31.
 */
export interface LoopPort {
  /** Sim steps to swallow (hit-pause). */
  hitstop: number;
  /** Real seconds left at LOOP_TUNING.slowmoScale. */
  slowmo: number;
  /** Paused (dev P, a menu, a hidden tab): the sim doesn't step and input becomes no command. */
  readonly paused: boolean;
  /** Raises slow motion for a moment of this kind (LOOP_TUNING's durations; never shortens one running). */
  slowMotion(kind: 'parry' | 'dismember' | 'playerKo'): void;
  /** A felled tree landed this far from the camera (m): a short hit-pause when close (§10.2). */
  treeLanded(distanceM: number): void;
  /** Dev: one step on the next frame, even while paused (DS requestStep). */
  requestStep(): void;
  /** Dev: run `n` steps now (DS advance; headless checks). */
  advance(n: number): void;
  /** Dev: a `meta 'dev'` command for the next tick (spawns, teleports, setTuning…; applied in phase 1c, RR-17). */
  dev(op: DevOp, args: number[], tuning?: TuningEdit): void;
  /** A `meta 'save'` command for the next tick: the world writes a save at its end (Game.onSave gets the bytes). */
  save(): void;
}

/** What Game asks of its three.js renderer (a WebGLRenderer; tests hand in one that draws nothing). */
export interface RendererPort {
  render(scene: Scene, camera: PerspectiveCamera): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  dispose(): void;
}

/** One of each port (Game.create). `scene` is the three.js scene every view draws into. */
export interface GamePorts {
  scene: Scene;
  /** The renderer (absent: Game makes a WebGLRenderer on its canvas). */
  renderer?: RendererPort;
  views: WorldViewsPort;
  presentation: PresentationPort;
  fx: FxPort;
  cams: CameraPort;
  cine: CinematicsPort;
  verbInput: VerbInputPort;
  killCam: KillCamPort;
  moments: MomentsPort;
  hud: HudPort;
  sfx: SfxPort;
  panel: PanelPort;
  menus: MenusPort;
}
