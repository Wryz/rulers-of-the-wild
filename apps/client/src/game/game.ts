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
  type AIConfig,
  BONES,
  DEFAULT_AI,
  defineTuning,
  DT,
  type Fighter,
  hurtSpheres,
  type StepResult,
  strikePoint,
  type WeaponId,
  type World,
} from '@wild/sim';
import type {
  BodyPose,
  CameraPort,
  CinematicsPort,
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
  },
);

const NO_LOOK = Object.freeze({ dx: 0, dy: 0 });
const _toward = new Vector3();

/**
 * Rule 12: the one place M1 reads the gore level. P35's prefs carry `gore` (default 'full'); until then DS's
 * blood toggle stands in for it (blood off → 'off').
 */
function goreOf(prefs: MenusPort['prefs']): GoreLevel {
  return (prefs as Partial<{ gore: GoreLevel }>).gore ?? (prefs.blood ? 'full' : 'off');
}

export class Game {
  readonly renderer: WebGLRenderer;
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

    const r = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = SRGBColorSpace;
    this.renderer = r;
    this.scene.add(this.debugGroup);

    // Cuts stand on the terrain and keep a clear line to what they film: no shooting through the ground or a trunk
    // (§10.6; the world's queries are read-only).
    this.cine.setGround((x, z) => world.terrain.heightAt(x, z));
    this.cine.setBlocked((cam, look) => this.lineBlocked(cam, look));
    this.cams.snapBehind(player);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** A menu is open: the loop pauses and turns no input into commands. */
  get menuOpen(): boolean {
    return this.menus.open;
  }

  /** Developer mode's panel (main.ts builds it once the game exists). */
  setPanel(panel: PanelPort): void {
    this.panel = panel;
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
    for (const e of r.combat) {
      this.combatBeat(e, loop);
      this.dispatch(e);
    }
    for (const e of r.world) {
      this.worldBeat(e, loop);
      this.dispatch(e);
    }
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
    this.fx.update(gameDt, realDt);
    // Camera: framing you and whoever you're fighting (the director decides when that's a fight).
    this.cams.update(realDt, w, p, p.target && p.target.alive ? p.target : null, this.look);
    this.cams.cutoutFocus(p.pos);
    this.sfx.setListener(this.cams.camera.position);
    this.sfx.ambience(w);
    this.hud.update(w, p, realDt);
    this.hud.deathBanner(this.respawnTick === null ? null : Math.max(0, (this.respawnTick - w.tick) * DT));
    if (this.panel.visible) this.panel.refresh(w);
    this.updateDebug();
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
    this.views.dispose();
    this.presentation.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------------
  // Beats: the time effects and camera jolts a tick's events raise (DS handleEvent / onKO values)
  // ---------------------------------------------------------------------------

  private combatBeat(e: SimEvent, loop: LoopPort): void {
    const cues = this.menus.prefs.cues;
    switch (e.type) {
      case 'hit': {
        const m = e.move;
        const big = e.attacker.scale > 1.3;
        // A heavy weapon lands like one: a longer catch on impact, a bigger jolt.
        const weight = e.weapon ? Math.min(1.4, 0.8 + 0.1 * e.weapon.mass) : 1;
        let hs = Math.max(
          loop.hitstop,
          Math.round(m.hitstop * GAME_TUNING.hitstopMul * (e.counter ? 1.35 : 1) * (e.ko ? 1.8 : 1) * (e.armored ? 0.5 : 1) * (big ? 1.25 : 1) * weight),
        );
        // Real blows don't freeze time: only a short catch (unless cues are on).
        if (!cues) hs = Math.min(hs, Math.max(2, Math.round(m.hitstop * 0.45 * weight)));
        loop.hitstop = hs;
        this.hitstopVictim = e.defender;
        this.cams.shake(m.shake * (e.counter ? 1.3 : 1) * (e.ko ? 1.6 : 1) * (big ? 1.6 : 1) * weight * (cues ? 1 : 0.6));
        if (m.weight === 'heavy' || e.counter || big) this.cams.punch(1);
        if (e.sever) {
          // A limb comes off: close to frozen for a moment.
          loop.slowMotion('dismember');
          this.cams.shake(0.45);
          this.cams.punch(1.2);
        } else if (e.fatal) {
          loop.slowMotion('dismember');
          this.cams.shake(0.5);
          this.cams.punch(1.2);
        }
        return;
      }
      case 'block':
        loop.hitstop = Math.max(loop.hitstop, Math.round((e.guardBreak ? 8 : 3) * GAME_TUNING.hitstopMul));
        this.hitstopVictim = e.defender;
        this.cams.shake(e.guardBreak ? 0.35 : 0.1);
        if (e.parry && e.perfect) {
          // Timed to the last instant: a beat of slow motion, and you're straight in.
          loop.slowMotion('parry');
          this.cams.punch(0.6);
        }
        return;
      case 'dodge':
        if (e.defender === this.player && e.perfect) {
          loop.slowMotion('parry');
          this.cams.punch(0.6);
        }
        return;
      case 'clang':
        if (e.f === this.player) this.cams.shake(0.12);
        return;
      case 'ko':
        this.cams.shake(0.5 * e.victim.scale);
        if (e.victim === this.player) {
          // Your fall: slow, the colour drains out; the death cam is the playerDeath moment's.
          loop.slowMotion('playerKo');
          this.hud.mood('death');
        }
        return;
      default:
        return;
    }
  }

  private worldBeat(e: SimEvent, loop: LoopPort): void {
    switch (e.type) {
      case 'impact':
        // The sim's presentation hints for a world hit (MAP gap-2 §8b).
        if (e.hitstop > 0) loop.hitstop = Math.max(loop.hitstop, Math.round(e.hitstop * GAME_TUNING.hitstopMul));
        this.hitstopVictim = e.defender;
        if (e.defender === this.player && e.shake > 0) this.cams.shake(e.shake);
        return;
      case 'fell':
        this.fallingTrees.add(e.tree);
        return;
      case 'land':
        if (e.entity !== null && this.fallingTrees.delete(e.entity)) {
          loop.treeLanded(this.cams.camera.position.distanceTo(_toward.set(e.point.x, e.point.y, e.point.z)));
        }
        return;
      case 'launch':
        this.presentation.onLaunch(e.f, e.vel, e.angVel);
        return;
      case 'death':
        if (e.f === this.player) this.respawnTick = e.respawnTick;
        return;
      case 'respawn':
        if (e.f === this.player) {
          this.respawnTick = null;
          this.hud.deathBanner(null);
          this.hud.mood('');
          this.cams.snapBehind(e.f);
          this.presentation.snapTo(e.f);
        }
        return;
      case 'verb':
        // A refused verb says why (§10.7).
        if (!e.ok && e.f === this.player) this.hud.popup(e.reason ? `${e.verb}: ${e.reason}` : `can't ${e.verb}`);
        return;
      default:
        return;
    }
  }

  /** Each owner's own reaction to the event (DS handleEvent's cases, split by owner). */
  private dispatch(e: SimEvent): void {
    const w = this.world;
    this.presentation.handle(e, w);
    this.views.handle(e, w);
    this.fx.handle(e, w);
    this.sfx.handle(e, w);
    this.hud.handle(e, w);
    this.menus.handle(e, w);
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

  // ---------------------------------------------------------------------------
  // The DS tuning panel's calls (debug/panel.ts, until P37 rebuilds the panel from the registry and dev-op commands).
  // TODO(P37): once the rewritten panel no longer calls these, a follow-up (Pnn-fix) removes them from game.ts.
  // ---------------------------------------------------------------------------

  /** @deprecated DS panel only. Inert: in M1 every creature's mind owns its AIConfig (no client write of sim state). */
  readonly aiCfg: AIConfig = { ...DEFAULT_AI };

  /** @deprecated DS panel: "Step frame (.)". */
  requestStep(): void {
    this.loop?.requestStep();
  }

  /** @deprecated DS panel: "Restart (Backspace)": rebuilds the world from the same seed. */
  restart(): void {
    this.onRebuild?.();
  }

  /** @deprecated DS panel: "Respawn enemy". In M1 that is the dev op `spawnApe` (a command; P22 implements it). */
  spawnEnemy(): void {
    // TODO(P22): send this.loop.dev('spawnApe', …) once world/devOps.ts applies it (it throws until P22).
    console.warn('Spawning an ape is the dev op spawnApe, which arrives with P22.');
  }

  /** @deprecated DS panel: "Give to player". In M1 that is the dev op `giveTool` (a command; P22 implements it). */
  giveWeapon(id: WeaponId | null): void {
    // TODO(P22): send this.loop.dev('giveTool', …): putting a weapon in a fighter's hands from the client breaks rule 6.
    console.warn(`Giving ${id ?? 'nothing'} is the dev op giveTool, which arrives with P22.`);
  }
}
