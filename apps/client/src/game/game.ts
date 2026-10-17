// Game: the presenter (docs/M1-DESIGN.md §10.1). It shows a World the game loop (game/loop.ts) steps: it owns the
// views, the presentation world and the renderer, reacts to every stepped tick's events (present), runs the death and
// respawn flow, and renders. It never writes fighter or entity state (rule 6): input reaches the sim only as commands
// (input/verbInput.ts → the loop), and every time effect is the loop's (rule 8): present() only asks the loop for a
// hit-pause or a slow motion.
//
// game.ts talks to every other client module through the interfaces of game/ports.ts and imports nothing else from the
// client (RF-9; tests/inputRouting.test.ts checks it), so the packages that fill those modules (P32-P37) never edit it.
// DungeonStyle's event reactions are split by owner: each port's `handle(e, world)` (sounds, blood, ragdolls, markers,
// battle-log marks), while the time effects and camera trauma stay here.
import {
  ACESFilmicToneMapping,
  Group,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  type Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  BONES,
  defineTuning,
  DT,
  type Fighter,
  hurtSpheres,
  type StepResult,
  strikePoint,
  type V3,
  type World,
} from '@wild/sim';
import type {
  BodyPose,
  CameraPort,
  CinematicsPort,
  DevViewsPort,
  FxPort,
  GamePorts,
  GoreLevel,
  HudPort,
  InputFrame,
  KillCamPort,
  LoopPort,
  MenusPort,
  MomentsPort,
  PanelPort,
  PresentationPort,
  RendererPort,
  SfxPort,
  SimEvent,
  VerbInputPort,
  WorldViewsPort,
} from './ports';

export const GAME_TUNING = defineTuning(
  'GAME_TUNING',
  'Client › game',
  {
    timeScale: 1,
    paused: false,
    hitstopMul: 1,
    showHitboxes: false,
    volume: 0.7,
    showNav: false,
    showSenses: false,
    showZones: false,
    // How developer mode's world views look (debug/devViews.ts): C-fix's, so none is a bare constant there.
    devViews: {
      navLiftM: 0.06,
      navOpacity: 0.22,
      navHuman: '#38c8ff',
      navRuler: '#ff9a3c',
      navRulerLiftMul: 2,
      navEdgeOpacityMul: 3,
      senseColor: '#ffd36b',
      senseStillColor: '#b98a2e',
      senseArcSegments: 16,
      noiseColor: '#ff5a8a',
      noiseRingS: 1.5,
      noiseRingSegments: 32,
      noiseLiftM: 0.1,
      zoneColor: '#ffe14a',
      zoneOpacity: 0.55,
      zoneSphereSegments: 10,
      zoneSphereRings: 8,
      zoneCapsuleCapSegments: 3,
      zoneCapsuleRadialSegments: 8,
    },
  },
  {
    timeScale: { unit: '×', source: 'DS (game.ts:49)', min: 0.05, max: 1.5, step: 0.05, label: 'time scale' },
    paused: { unit: '—', source: 'DS (game.ts:49)' },
    hitstopMul: { unit: '×', source: 'DS (game.ts:49)', min: 0, max: 3, step: 0.05, label: 'hit-pause ×' },
    showHitboxes: { unit: '—', source: 'DS (game.ts:49)', label: 'hitboxes (H)' },
    volume: { unit: '0-1', source: 'DS (game.ts:49)', min: 0, max: 1, step: 0.05 },
    showNav: { unit: '—', source: 'NEW: dev views (nav polys, P12/P37)', label: 'nav polys' },
    showSenses: { unit: '—', source: 'NEW: dev views (sight cones, hearing rings, P18/P37)', label: 'senses' },
    showZones: { unit: '—', source: 'NEW: dev views (hit zones, P08/P37)', label: 'zones' },
    devViews: {
      navLiftM: { unit: 'm', source: 'NEW (C-fix): the nav polygons float this far over the ground (no z-fighting)', min: 0, max: 1, step: 0.01, label: 'nav lift' },
      navOpacity: { unit: '0-1', source: 'NEW (C-fix): the nav polygons\' fill', min: 0, max: 1, step: 0.01, label: 'nav opacity' },
      navHuman: { unit: 'colour', source: 'NEW (C-fix): the human layer\'s polygons' },
      navRuler: { unit: 'colour', source: 'NEW (C-fix): the ruler layer\'s polygons' },
      navRulerLiftMul: { unit: '× navLiftM', source: 'NEW (C-fix): the ruler layer floats higher, so both read where they overlap', min: 1, max: 10, step: 0.5, label: 'ruler nav lift' },
      navEdgeOpacityMul: { unit: '× navOpacity', source: 'NEW (C-fix): the nav polygons\' edges (capped at 1)', min: 1, max: 10, step: 0.5, label: 'nav edge opacity' },
      senseColor: { unit: 'colour', source: 'NEW (C-fix): a creature\'s sight cone at sightRangeM (§6.2)' },
      senseStillColor: { unit: 'colour', source: 'NEW (C-fix): the cone\'s inner arc, sightRangeStillM (§6.2: a still target is seen nearer)' },
      senseArcSegments: { unit: 'segments', source: 'NEW (C-fix): the sight cone\'s arcs', min: 2, max: 64, step: 1, label: 'cone segments' },
      noiseColor: { unit: 'colour', source: 'NEW (C-fix): a noise\'s hearing ring (its radius, §6.2)' },
      noiseRingS: { unit: 's (real)', source: 'NEW (C-fix): a hearing ring stays this long after its noise', min: 0.1, max: 10, step: 0.1, label: 'hearing ring shown' },
      noiseRingSegments: { unit: 'segments', source: 'NEW (C-fix): a hearing ring\'s circle', min: 8, max: 128, step: 1, label: 'ring segments' },
      noiseLiftM: { unit: 'm', source: 'NEW (C-fix): a hearing ring floats this far over the ground at the noise', min: 0, max: 2, step: 0.05, label: 'ring lift' },
      zoneColor: { unit: 'colour', source: 'NEW (C-fix): the hit zones\' wireframes (§4.8)' },
      zoneOpacity: { unit: '0-1', source: 'NEW (C-fix)', min: 0, max: 1, step: 0.01, label: 'zone opacity' },
      zoneSphereSegments: { unit: 'segments', source: 'NEW (C-fix): a ball zone\'s wireframe, around (read when first built)', min: 3, max: 64, step: 1, label: 'ball segments' },
      zoneSphereRings: { unit: 'rings', source: 'NEW (C-fix): a ball zone\'s wireframe, top to bottom (read when first built)', min: 2, max: 64, step: 1, label: 'ball rings' },
      zoneCapsuleCapSegments: { unit: 'segments', source: 'NEW (C-fix): a capsule zone\'s end caps (read when first built)', min: 1, max: 32, step: 1, label: 'capsule cap segments' },
      zoneCapsuleRadialSegments: { unit: 'segments', source: 'NEW (C-fix): a capsule zone, around (read when first built)', min: 3, max: 64, step: 1, label: 'capsule segments' },
    },
  },
);

const NO_LOOK = Object.freeze({ dx: 0, dy: 0 });

/**
 * Rule 12: the one place M1 reads the gore level. P35's prefs carry `gore` (default 'full'); until then DS's
 * blood toggle stands in for it (blood off → 'off').
 */
function goreOf(prefs: MenusPort['prefs']): GoreLevel {
  return (prefs as Partial<{ gore: GoreLevel }>).gore ?? (prefs.blood ? 'full' : 'off');
}

/** What slow motion is for (LOOP_TUNING's durations). */
export type SlowKind = Parameters<LoopPort['slowMotion']>[0];

/** What the presenter knows when an event arrives. */
export interface BeatContext {
  /** The local player. */
  player: Fighter;
  /** DS's game-style cues (prefs.cues): real blows freeze time only briefly without them. */
  cues: boolean;
  /** The loop's hit-pause now (steps). */
  hitstop: number;
  /** Trees seen falling and not landed yet. */
  falling: ReadonlySet<number>;
  /** Where the camera is (how far away a tree landed). */
  camera: V3;
}

/** What one event asks of the loop, the camera and the HUD (beatOf; Game.present applies it). */
export interface Beat {
  /** The loop's hit-pause after this event (steps). */
  hitstop: number;
  /** Slow motion to raise (LoopPort.slowMotion), or null. */
  slow: SlowKind | null;
  /** Camera trauma to add (0: none). */
  shake: number;
  /** The zoom punch (the biggest asked for; 0: none). */
  punch: number;
  /** The body that shivers through the hit-pause (null: unchanged). */
  victim: Fighter | null;
  /** The screen mood (null: unchanged). */
  mood: '' | 'death' | null;
  /** A tree started falling: its landing will be a beat. */
  treeFalling: number | null;
  /** A falling tree landed this far from the camera: LoopPort.treeLanded. */
  treeLanded: { tree: number; distanceM: number } | null;
  /** The dead player's respawn tick (a number), cleared (null), or unchanged (undefined). */
  respawnTick: number | null | undefined;
  /** A respawn: the camera behind, the body snapped back, the death banner gone. */
  snap: Fighter | null;
}

/**
 * The beat of one event (pure: it reads the event, the context and GAME_TUNING, and changes nothing). DS's hit-pause,
 * slow-motion and camera values (game.ts handleEvent, onKO): a blow's hit-pause from the move (capped short without
 * cues), a block's 3 or 8 steps, a perfect parry or dodge and a severed limb or split skull in slow motion, the player's
 * KO in slow motion with the colour draining out; and M1's: the sim's hit-pause hint on a world impact, a felled tree's
 * landing (the loop decides how close is close), the death banner's respawn tick and the respawn snap (§10.2, §10.8).
 */
export function beatOf(e: SimEvent, c: BeatContext): Beat {
  const b: Beat = {
    hitstop: c.hitstop,
    slow: null,
    shake: 0,
    punch: 0,
    victim: null,
    mood: null,
    treeFalling: null,
    treeLanded: null,
    respawnTick: undefined,
    snap: null,
  };
  const me = c.player;
  switch (e.type) {
    case 'hit': {
      const m = e.move;
      const big = e.attacker.scale > 1.3;
      // A heavy weapon lands like one: a longer catch on impact, a bigger jolt.
      const weight = e.weapon ? Math.min(1.4, 0.8 + 0.1 * e.weapon.mass) : 1;
      let hs = Math.max(
        c.hitstop,
        Math.round(m.hitstop * GAME_TUNING.hitstopMul * (e.counter ? 1.35 : 1) * (e.ko ? 1.8 : 1) * (e.armored ? 0.5 : 1) * (big ? 1.25 : 1) * weight),
      );
      // Real blows don't freeze time: only a short catch (unless cues are on).
      if (!c.cues) hs = Math.min(hs, Math.max(2, Math.round(m.hitstop * 0.45 * weight)));
      b.hitstop = hs;
      b.victim = e.defender;
      b.shake = m.shake * (e.counter ? 1.3 : 1) * (e.ko ? 1.6 : 1) * (big ? 1.6 : 1) * weight * (c.cues ? 1 : 0.6);
      if (m.weight === 'heavy' || e.counter || big) b.punch = 1;
      if (e.sever || e.fatal) {
        // A limb comes off, a skull splits: close to frozen for a moment.
        b.slow = 'dismember';
        b.shake += e.sever ? 0.45 : 0.5;
        b.punch = Math.max(b.punch, 1.2);
      }
      return b;
    }
    case 'block':
      b.hitstop = Math.max(c.hitstop, Math.round((e.guardBreak ? 8 : 3) * GAME_TUNING.hitstopMul));
      b.victim = e.defender;
      b.shake = e.guardBreak ? 0.35 : 0.1;
      if (e.parry && e.perfect) {
        // Timed to the last instant: a beat of slow motion, and you're straight in.
        b.slow = 'parry';
        b.punch = 0.6;
      }
      return b;
    case 'dodge':
      if (e.defender === me && e.perfect) {
        b.slow = 'parry';
        b.punch = 0.6;
      }
      return b;
    case 'clang':
      if (e.f === me) b.shake = 0.12;
      return b;
    case 'ko':
      b.shake = 0.5 * e.victim.scale;
      if (e.victim === me) {
        // Your fall: slow, the colour drains out; the death cam is the playerDeath moment's.
        b.slow = 'playerKo';
        b.mood = 'death';
      }
      return b;
    case 'impact':
      // The sim's presentation hints for a world hit (MAP gap-2 §8b).
      if (e.hitstop > 0) b.hitstop = Math.max(c.hitstop, Math.round(e.hitstop * GAME_TUNING.hitstopMul));
      b.victim = e.defender;
      if (e.defender === me && e.shake > 0) b.shake = e.shake;
      return b;
    case 'fell':
      b.treeFalling = e.tree;
      return b;
    case 'land':
      if (e.entity !== null && c.falling.has(e.entity)) {
        b.treeLanded = { tree: e.entity, distanceM: Math.hypot(e.point.x - c.camera.x, e.point.y - c.camera.y, e.point.z - c.camera.z) };
      }
      return b;
    case 'death':
      if (e.f === me) b.respawnTick = e.respawnTick;
      return b;
    case 'respawn':
      if (e.f === me) {
        b.respawnTick = null;
        b.mood = '';
        b.snap = e.f;
      }
      return b;
    default:
      // (A refused verb's popup is the HUD's own reaction, in §5.13's words: ui/hud.ts.)
      return b;
  }
}

export class Game {
  /** The three.js renderer (GamePorts.renderer, else a WebGLRenderer on the canvas). */
  readonly renderer: RendererPort;
  readonly scene: Scene;
  /** render/*View.ts (P32): terrain, trees, entities, ropes, grass, sky and the fighters. */
  readonly views: WorldViewsPort;
  /** P33: ragdolls in the presentation Rapier world. */
  readonly presentation: PresentationPort;
  /** P33: blood, gibs and particles. */
  readonly fx: FxPort;
  /** P34. */
  readonly cams: CameraPort;
  /** P34. */
  readonly cine: CinematicsPort;
  /** P35 (P31's stub: DS's move/button command code, moved out of game.ts). */
  readonly verbInput: VerbInputPort;
  /** P36. */
  readonly killCam: KillCamPort;
  /** P36. */
  readonly moments: MomentsPort;
  /** P36. */
  readonly hud: HudPort;
  /** P37. */
  readonly sfx: SfxPort;
  /** P37 (developer mode sets the real one: setPanel). */
  panel: PanelPort;
  /** Developer mode's nav, senses and zones views (setDevViews), or null. */
  devViews: DevViewsPort | null = null;
  /** P35: settings, the battle log and the session recording. */
  readonly menus: MenusPort;
  /** The local player (player number 1, 'p1'): the same Fighter across respawns. */
  readonly player: Fighter;
  /** Exposed for the developer panel and automated capture scripts (developer mode). */
  readonly tuning = GAME_TUNING;
  /** The loop driving this game (set on its first frame or step). */
  loop: LoopPort | null = null;
  /** Developer Backspace (and the panel's "Restart"): main.ts rebuilds the world from the same seed. */
  onRebuild: (() => void) | null = null;

  private look: { dx: number; dy: number } = NO_LOOK;
  /** Whose body shivers through a hit-pause. */
  private hitstopVictim: Fighter | null = null;
  /** The tick the dead player gets back up (the death banner counts down in sim time, so it slows in slow motion). */
  private respawnTick: number | null = null;
  /** Trees that started falling: their landing is a beat (§10.2). */
  private readonly fallingTrees = new Set<number>();
  private gore: GoreLevel | null = null;
  private readonly poseOf = (f: Fighter): BodyPose | null => this.presentation.bodyPose(f);

  private readonly debugGroup = new Group();
  private readonly debugPool: Mesh[] = [];
  private readonly debugMats = {
    hurt: new MeshBasicMaterial({ color: 0x40ff80, wireframe: true, transparent: true, opacity: 0.5 }),
    strike: new MeshBasicMaterial({ color: 0xff3030, wireframe: true }),
    target: new MeshBasicMaterial({ color: 0x40d0ff }),
  };
  private readonly sphereGeo = new SphereGeometry(1, 10, 8);
  /** Where the camera looks (the listener's facing). */
  private readonly camForward = new Vector3();

  static create(world: World, canvas: HTMLCanvasElement, ports: GamePorts): Game {
    return new Game(world, canvas, ports);
  }

  private constructor(
    readonly world: World,
    private readonly canvas: HTMLCanvasElement,
    ports: GamePorts,
  ) {
    const player = world.player;
    if (!player) throw new Error('Game: the world has no local player (createWorld with player: true)');
    this.player = player;
    this.scene = ports.scene;
    this.views = ports.views;
    this.presentation = ports.presentation;
    this.fx = ports.fx;
    this.cams = ports.cams;
    this.cine = ports.cine;
    this.verbInput = ports.verbInput;
    this.killCam = ports.killCam;
    this.moments = ports.moments;
    this.hud = ports.hud;
    this.sfx = ports.sfx;
    this.panel = ports.panel;
    this.menus = ports.menus;

    this.renderer = ports.renderer ?? Game.webgl(canvas);
    this.scene.add(this.debugGroup);

    // Cuts stand on the terrain and keep a clear line to what they film: no shooting through the ground or a trunk
    // (§10.6; the world's queries are read-only).
    this.cine.setGround((x, z) => world.terrain.heightAt(x, z));
    this.cine.setBlocked((cam, look) => this.lineBlocked(cam, look));
    this.cams.snapBehind(player);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** The game's WebGL renderer on `canvas` (DS's settings: shadows, ACES tone mapping, sRGB). */
  private static webgl(canvas: HTMLCanvasElement): WebGLRenderer {
    const r = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = SRGBColorSpace;
    return r;
  }

  /** A menu is open: the loop pauses and turns no input into commands. */
  get menuOpen(): boolean {
    return this.menus.open;
  }

  /** Developer mode's panel (main.ts builds it once the game exists). */
  setPanel(panel: PanelPort): void {
    this.panel = panel;
  }

  /** Developer mode's world views (main.ts builds them with the panel). */
  setDevViews(views: DevViewsPort): void {
    this.devViews?.dispose();
    this.devViews = views;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.cams.resize(w, h);
    this.cine.resize(w / h);
  }

  // ---------------------------------------------------------------------------
  // Called by the loop
  // ---------------------------------------------------------------------------

  /** Once per rendered frame, first: the camera's look input and the recording's clock. */
  beginFrame(inp: InputFrame, loop: LoopPort): void {
    this.loop = loop;
    this.look = (inp as Partial<{ look: { dx: number; dy: number } }>).look ?? NO_LOOK;
    this.menus.frame(loop.paused);
  }

  /** Menu and developer keys (the loop keeps the time keys P, `.` and T). Input only reports L, H and Backspace in dev. */
  metaKey(code: string): void {
    switch (code) {
      case 'Escape':
        this.menus.toggleSettings();
        return;
      case 'KeyM':
        this.sfx.setVolume(this.sfx.volume > 0 ? 0 : GAME_TUNING.volume);
        return;
      case 'KeyB':
        this.menus.openLog();
        return;
      case 'KeyL':
        this.panel.toggle();
        return;
      case 'KeyH':
        GAME_TUNING.showHitboxes = !GAME_TUNING.showHitboxes;
        return;
      case 'Backspace':
        this.onRebuild?.();
        return;
      default:
        return;
    }
  }

  /** One stepped tick: time effects and camera beats here, every other reaction in its owner's port, then the moments. */
  present(r: StepResult, loop: LoopPort): void {
    this.loop = loop;
    for (const f of this.world.combat.fighters) this.views.fighterView(f)?.setShiver(0);
    for (const e of r.combat) this.react(e, loop);
    for (const e of r.world) this.react(e, loop);
    // Every kill cam goes through KillCam.onMoment (SPEC:583-588, RR-14).
    for (const m of this.moments.fromStep(r)) this.killCam.onMoment(m);
  }

  /** A swallowed step (hit-pause): the struck body shivers, every body holds (DS). */
  freezeFrame(): void {
    const v = this.hitstopVictim ? this.views.fighterView(this.hitstopVictim) : null;
    v?.setShiver(0.022 * Math.min(1, (this.loop?.hitstop ?? 0) / 3 + 0.3));
    this.presentation.freeze();
  }

  render(realDt: number, gameDt: number, alpha: number): void {
    const w = this.world;
    const p = this.player;
    const prefs = this.menus.prefs;
    const gore = goreOf(prefs);
    if (gore !== this.gore) {
      this.gore = gore;
      this.fx.setGore(gore);
    }
    this.views.sync(w, alpha, this.cams.camera.position, { realDt, gameDt, poseOf: this.poseOf, gore, cues: prefs.cues });
    this.fx.update(gameDt, realDt, w);
    // Camera: framing you and whoever you're fighting (the director decides when that's a fight).
    this.cams.setSlowMotion((this.loop?.slowmo ?? 0) > 0);
    this.cams.update(realDt, w, p, p.target && p.target.alive ? p.target : null, this.look);
    this.cams.cutoutFocus(p.pos);
    const cam = this.cams.camera;
    this.sfx.setListener(cam.position, cam.getWorldDirection(this.camForward));
    this.sfx.ambience(w, realDt, gameDt);
    this.hud.update(w, p, realDt);
    this.hud.deathBanner(this.respawnTick === null ? null : Math.max(0, (this.respawnTick - w.tick) * DT));
    if (this.panel.visible) this.panel.refresh(w);
    this.updateDebug();
    this.devViews?.update(w, realDt);
    this.renderer.render(this.scene, this.cams.camera);
    this.menus.afterRender();
  }

  /** M1: the dev "Save world" downloads the bytes; M3: the save worker. */
  onSave(bytes: Uint8Array): void {
    if (typeof document === 'undefined') return;
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `rulers-of-the-wild-seed${this.world.seed}-tick${this.world.tick}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  dispose(): void {
    this.devViews?.dispose();
    this.views.dispose();
    this.presentation.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------------
  // Beats: the time effects and camera jolts a tick's events raise (beatOf), applied
  // ---------------------------------------------------------------------------

  /** One event: its beat (beatOf) applied, the sim's launch handed to the bodies, then every owner's reaction. */
  private react(e: SimEvent, loop: LoopPort): void {
    const b = beatOf(e, { player: this.player, cues: this.menus.prefs.cues, hitstop: loop.hitstop, falling: this.fallingTrees, camera: this.cams.camera.position });
    loop.hitstop = b.hitstop;
    if (b.victim) this.hitstopVictim = b.victim;
    if (b.slow) loop.slowMotion(b.slow);
    if (b.shake > 0) this.cams.shake(b.shake);
    if (b.punch > 0) this.cams.punch(b.punch);
    if (b.mood !== null) this.hud.mood(b.mood);
    if (b.treeFalling !== null) this.fallingTrees.add(b.treeFalling);
    if (b.treeLanded) {
      this.fallingTrees.delete(b.treeLanded.tree);
      loop.treeLanded(b.treeLanded.distanceM);
    }
    if (b.respawnTick !== undefined) this.respawnTick = b.respawnTick;
    if (b.snap) {
      this.hud.deathBanner(null);
      this.cams.snapBehind(b.snap);
      this.presentation.snapTo(b.snap);
    }
    if (e.type === 'launch') this.presentation.onLaunch(e.f, e.vel, e.angVel);
    this.dispatch(e);
  }

  /** Each owner's own reaction to the event (DS handleEvent's cases, split by owner). */
  private dispatch(e: SimEvent): void {
    const w = this.world;
    this.presentation.handle(e, w);
    this.cams.handle(e, w);
    this.views.handle(e, w);
    this.fx.handle(e, w);
    this.sfx.handle(e, w);
    this.hud.handle(e, w);
    this.menus.handle(e, w);
    this.panel.handle?.(e, w);
    this.devViews?.handle(e, w);
  }

  /** Is the line from a cut's camera spot to what it films blocked by the terrain or a trunk? (Read-only queries.) */
  private lineBlocked(cam: Vector3, look: Vector3): boolean {
    const w = this.world;
    if (cam.y < w.terrain.heightAt(cam.x, cam.z)) return true;
    const d = { x: look.x - cam.x, y: look.y - cam.y, z: look.z - cam.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (!(len > 0)) return false;
    return w.queries.castRay(cam, d, len, { terrain: true, entities: 'static' }) !== null;
  }

  private updateDebug(): void {
    this.debugGroup.visible = GAME_TUNING.showHitboxes;
    if (!GAME_TUNING.showHitboxes) return;
    let i = 0;
    const use = (mat: MeshBasicMaterial, at: Vector3, r: number) => {
      let m = this.debugPool[i];
      if (!m) {
        m = new Mesh(this.sphereGeo, mat);
        this.debugPool.push(m);
        this.debugGroup.add(m);
      }
      m.material = mat;
      m.visible = true;
      m.position.copy(at);
      m.scale.setScalar(r);
      i++;
    };
    for (const f of this.world.combat.fighters) {
      for (const h of ['high', 'mid', 'low'] as const) for (const s of hurtSpheres(f, h)) use(this.debugMats.hurt, s.center, s.r);
      for (const b of BONES) use(this.debugMats.target, f.rig[b].pos, 0.018 * f.scale);
      if (f.move && f.inActiveFrames()) use(this.debugMats.strike, strikePoint(f, f.move, new Vector3()), (f.move.radius + f.stats.reach) * f.scale);
    }
    for (; i < this.debugPool.length; i++) this.debugPool[i].visible = false;
  }
}
