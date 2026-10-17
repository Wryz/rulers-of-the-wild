// Boot (docs/M1-DESIGN.md §1.4, §10.1): physicsReady(), createWorld from the URL's seed, one of each client port around
// it, Game.create, the developer panel, loop.start(). The only place the concrete client modules are wired together:
// game.ts sees them only through game/ports.ts.
import './style.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { Scene } from 'three';
import { createWorld, physicsReady, type World } from '@wild/sim';
import { bootParams, cryptoSeed, DEV, rebuildSearch } from './dev';
import { Sfx } from './feel/audio';
import { SfxAdapter } from './feel/sfxPort';
import { Game } from './game/game';
import { KillCam, sideAcross } from './game/killcam';
import { GameLoop } from './game/loop';
import { MomentBuilder } from './game/moments';
import type { GamePorts, PanelPort } from './game/ports';
import { Fx, PresentationWorld } from './game/presentationWorld';
import { BattleRecorder } from './game/recorder';
import { Input } from './input/input';
import { VerbInput } from './input/verbInput';
import { CameraDirector, CinematicsAdapter } from './render/cameraDirector';
import { CameraRig } from './render/cameraRig';
import { Cinematics } from './render/cinematics';
import { FollowCam } from './render/followCam';
import { WorldViews } from './render/worldViews';
import { BattleLog } from './ui/battleLog';
import { Hud } from './ui/hud';
import { HudAdapter } from './ui/hudPort';
import { Menus } from './ui/menusPort';
import { SettingsMenu } from './ui/settings';

/** Until developer mode builds the panel. */
const NO_PANEL: PanelPort = { visible: false, refresh() {}, toggle() {} };

async function boot() {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const hudRoot = document.querySelector<HTMLDivElement>('#ui')!;
  const loading = document.querySelector<HTMLDivElement>('#loading');
  try {
    const params = bootParams(location.search, DEV, cryptoSeed);
    await physicsReady();
    // TODO(P22): ?mode=training's sparring ape (D-50) appears once the Spawner places it; until then the flag reaches
    // the world and nothing spawns.
    const world = await createWorld({ seed: params.seed, scene: 'clearing', sparringApe: params.sparringApe });
    // Developer builds check the sim's invariants as it runs (§4.1, RF-6): a weapon reaching a DS drop in world mode
    // throws. (Until P14/P15 nothing in the client can put a weapon in a hand, so it can't fire before the verbs exist.)
    world.combat.devChecks = DEV;
    const { game, loop } = assemble(world, canvas, hudRoot);
    // Rebuild from the same seed (RF-24): the world's Rapier world and navmeshes are freed, then the page reloads.
    game.onRebuild = () => {
      loop.stop();
      world.dispose();
      location.search = rebuildSearch(location.search, world.seed);
    };
    if (DEV) {
      // (Loaded only in developer mode: none of it ships in the player's bundle.)
      const { buildPanel } = await import('./debug/panel');
      game.setPanel(panelPort(buildPanel(game)));
      Object.assign(window, { game, world, loop });
    }
    loop.start();
    loading?.remove();
  } catch (err) {
    console.error(err);
    if (loading) loading.textContent = "Couldn't start the game — please reload the page.";
  }
}

/** One of each port around `world`, the Game and its loop. */
function assemble(world: World, canvas: HTMLCanvasElement, hudRoot: HTMLElement): { game: Game; loop: GameLoop } {
  const scene = new Scene();
  const player = () => world.player;

  const input = new Input(canvas);
  const sfx = new Sfx();
  input.onAnyInput = () => sfx.unlock();
  const hud = new Hud(hudRoot);
  hud.setBindings(input.bindings);
  const settings = new SettingsMenu(document.body, input);
  settings.onChange = (b) => hud.setBindings(b);
  const recorder = new BattleRecorder(canvas);
  const menus = new Menus(settings, new BattleLog(document.body, recorder), recorder, player, hud.logButton);
  // (Blood on or off reaches the game as its gore level, read each frame; recording is the menus'.)
  settings.onPrefs = (p) => {
    recorder.enabled = p.record;
  };
  hud.gearButton.addEventListener('click', () => menus.toggleSettings());
  hud.logButton.addEventListener('click', () => menus.openLog());

  const cinematics = new Cinematics();
  cinematics.onChange = (on) => hud.cinematic(on);
  const cuts = new CinematicsAdapter(cinematics);
  const rig = new CameraRig();
  const cams = new CameraDirector(rig, cuts, new FollowCam());
  const presentation = new PresentationWorld(RAPIER, world);
  const views = new WorldViews(scene, world);

  const ports: GamePorts = {
    scene,
    views,
    presentation,
    fx: new Fx(scene, views, presentation, () => menus.prefs.cues, player),
    cams,
    cine: cuts,
    verbInput: new VerbInput(() => cams.moveBasis()),
    killCam: new KillCam((shot) => cuts.play(shot), {
      pelvisOf: (f) => presentation.pelvisOf(f),
      ground: (x, z) => world.terrain.heightAt(x, z),
      across: (a, b, toward) => sideAcross(rig.camera.position, a, b, toward),
    }),
    moments: new MomentBuilder(() => world.tick),
    hud: new HudAdapter(hud, hudRoot, () => cams.camera, () => cuts.active, () => menus.prefs, () => input.bindings),
    sfx: new SfxAdapter(sfx, player),
    panel: NO_PANEL,
    menus,
  };
  const game = Game.create(world, canvas, ports);
  const loop = new GameLoop(world, game, input, cuts);
  return { game, loop };
}

/** The DS panel's `{ toggle }` as a PanelPort; a panel that already is one (P37's rewrite) is used as it is. */
function panelPort(p: { toggle(): void } & Partial<PanelPort>): PanelPort {
  if (typeof p.refresh === 'function' && 'visible' in p) return p as PanelPort;
  let visible = false;
  return {
    get visible() {
      return visible;
    },
    refresh() {},
    toggle() {
      visible = !visible;
      p.toggle();
    },
  };
}

void boot();
