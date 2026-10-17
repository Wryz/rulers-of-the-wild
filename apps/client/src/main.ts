// Boot (docs/M1-DESIGN.md §1.4, §10.1): physicsReady(), createWorld from the URL's seed, one of each client port around
// it, Game.create, the developer panel, loop.start(). The only place the concrete client modules are wired together:
// game.ts sees them only through game/ports.ts.
import './style.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { Scene } from 'three';
import { createWorld, physicsReady, type World } from '@wild/sim';
import { bootParams, cryptoSeed, DEV, fetchSave, nextPaint, pinCamera, rebuildSearch, shotParams, stashSave } from './dev';
import { Sfx } from './feel/audio';
import { SfxAdapter } from './feel/sfxPort';
import { Game } from './game/game';
import { KillCam } from './game/killcam';
import { GameLoop } from './game/loop';
import { MomentBuilder } from './game/moments';
import type { GamePorts, PanelPort } from './game/ports';
import { Fx, PresentationWorld } from './game/presentationWorld';
import { BattleRecorder } from './game/recorder';
import { Input } from './input/input';
import { VerbInput } from './input/verbInput';
import { AimArc } from './render/aimArc';
import { CameraDirector, CinematicsAdapter } from './render/cameraDirector';
import { CameraRig } from './render/cameraRig';
import { Cinematics } from './render/cinematics';
import { FollowCam } from './render/followCam';
import { Ghost } from './render/ghost';
import { Highlight } from './render/highlight';
import { WorldViews } from './render/worldViews';
import { BattleLog } from './ui/battleLog';
import { Hud } from './ui/hud';
import { Menus } from './ui/menusPort';
import { Radial } from './ui/radial';
import { SettingsMenu } from './ui/settings';

/** Until developer mode builds the panel. */
const NO_PANEL: PanelPort = { visible: false, refresh() {}, toggle() {} };

async function boot() {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const hudRoot = document.querySelector<HTMLDivElement>('#ui')!;
  const loading = document.querySelector<HTMLDivElement>('#loading');
  const say = (text: string) => {
    if (loading) loading.textContent = text;
  };
  try {
    const params = bootParams(location.search, DEV, cryptoSeed);
    // Developer screenshots (tools/shots): ?save=<url> builds the world from a canonical save instead of the seed;
    // ?paused, ?cam, ?fov and ?hud below. The dev server's build only: production replaces import.meta.env.DEV with
    // false and drops all of it.
    const shot = import.meta.env.DEV ? shotParams(location.search) : null;
    await physicsReady();
    // Building the Clearing holds the page for a few seconds (the terrain, the forest, both navmeshes): say so, and let
    // the message paint before it starts.
    say('building the Clearing…');
    await nextPaint();
    // TODO(P22): ?mode=training's sparring ape (D-50) appears once the Spawner places it; until then the flag reaches
    // the world and nothing spawns.
    const world =
      import.meta.env.DEV && shot?.save
        ? // (The loader by a dynamic import in this branch, which the production build drops: a static import of
          // loadWorld here keeps its module's record checkers in the player's bundle though nothing calls them.)
          await (await import('@wild/sim')).loadWorld(await fetchSave(shot.save), { applyTuning: true })
        : await createWorld({ seed: params.seed, scene: 'clearing', sparringApe: params.sparringApe });
    say('starting…');
    // Developer builds check the sim's invariants as it runs (§4.1, RF-6): a weapon reaching a DS drop in world mode
    // throws.
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
      const [{ buildPanel }, { DevViews }] = await Promise.all([import('./debug/panel'), import('./debug/devViews')]);
      game.setPanel(
        buildPanel({
          world,
          get loop() {
            return game.loop;
          },
          sfx: game.sfx,
          get onRebuild() {
            return game.onRebuild;
          },
          // "Load world": the picked save is kept for this tab and the page boots from it (?save=session), as dev
          // Backspace rebuilds by reloading. The dev server's build only, like ?save.
          loadWorld: import.meta.env.DEV
            ? (bytes) => {
                let search: string;
                try {
                  search = stashSave(bytes, location.search);
                } catch (err) {
                  console.error("Load world: this tab can't keep the save", err);
                  return;
                }
                loop.stop();
                world.dispose();
                location.search = search;
              }
            : null,
        }),
      );
      game.setDevViews(new DevViews(game.scene));
      Object.assign(window, { game, world, loop });
    }
    if (import.meta.env.DEV && shot) {
      // The loop's own pause (rule 8), a pinned camera and no HUD: presentation only, the sim is never written.
      if (shot.paused) game.tuning.paused = true;
      if (shot.cam) pinCamera(game.cams, shot.cam, shot.fov);
      if (!shot.hud) hudRoot.style.display = 'none';
    }
    loop.start();
    loading?.remove();
  } catch (err) {
    console.error(err);
    say("Couldn't start the game — please reload the page.");
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
  const cams = new CameraDirector(new CameraRig(), cuts, new FollowCam());
  const presentation = new PresentationWorld(RAPIER, world);
  const views = new WorldViews(scene, world);
  // The HUD reads the camera the frame is seen through, whether a cut runs, the prefs and the keys.
  hud.connect({ camera: () => cams.camera, cutActive: () => cuts.active, prefs: () => menus.prefs, bindings: () => input.bindings });

  // The verb UI (§10.7): targeting, the radial, the second target, the throw arc and the placement ghost. It aims
  // through the gameplay camera (never a kill cam's) and reads the world; Input reads its mode for the camera look and
  // Escape.
  const verbInput = new VerbInput(() => cams.moveBasis(), {
    world,
    view: () => ({ camera: cams.view, fight: cams.fightWeight >= 0.5 }),
    bindings: () => input.bindings,
    prefs: () => menus.prefs,
    radial: new Radial(hudRoot),
    highlight: new Highlight(scene, hudRoot),
    ghost: new Ghost(scene),
    arc: new AimArc(scene),
  });
  input.ui = verbInput;

  const sfxPort = new SfxAdapter(sfx, player);
  // A giant's footfall shakes the camera as well as the speakers (FEEL_TUNING).
  sfxPort.onTrauma = (trauma) => cams.shake(trauma);

  const ports: GamePorts = {
    scene,
    views,
    presentation,
    fx: new Fx(scene, views, presentation, () => menus.prefs.cues, player),
    cams,
    cine: cuts,
    verbInput,
    // Every kill cam goes through KillCam.onMoment (rule 8, RR-14); a new cut keeps left and right where the player
    // already sees them (the director's view position).
    killCam: new KillCam((shot) => cuts.play(shot), {
      pelvisOf: (f) => presentation.pelvisOf(f),
      ground: (x, z) => world.terrain.heightAt(x, z),
      viewPos: () => cams.camera.position,
    }),
    // (The world, not only its tick: a cause's fighter id names a ruler for playerByRuler.)
    moments: new MomentBuilder(world),
    hud,
    sfx: sfxPort,
    panel: NO_PANEL,
    menus,
  };
  const game = Game.create(world, canvas, ports);
  const loop = new GameLoop(world, game, input, cuts);
  return { game, loop };
}

void boot();
