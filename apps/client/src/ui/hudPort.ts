// P31's HudPort adapter, folded into the HUD itself (P36): ui/hud.ts's Hud implements HudPort (with the compass and the
// awareness markers), and this file only keeps main.ts's P31 wiring compiling until the client follow-up rewires it.
//
// TODO(C-fix): main.ts calls `hud.connect({ camera: () => cams.camera, cutActive: () => cuts.active, prefs: () =>
// menus.prefs, bindings: () => input.bindings })` once the camera and menus exist, passes `hud` itself as the HudPort
// (`hud: hud` in GamePorts), drops its HudAdapter import, and deletes this file.
import type { Camera } from 'three';
import type { Fighter, World } from '@wild/sim';
import type { HudPort, SimEvent } from '../game/ports';
import type { Prefs } from '../game/prefs';
import type { Bindings } from '../input/bindings';
import type { Hud } from './hud';

/** @deprecated The Hud is the HudPort (ui/hud.ts); this forwards to it and goes with C-fix. */
export class HudAdapter implements HudPort {
  constructor(
    readonly hud: Hud,
    /** Unused: the Hud places its own compass and markers. */
    _root: HTMLElement,
    camera: () => Camera,
    cutActive: () => boolean,
    prefs: () => Readonly<Prefs>,
    bindings: () => Readonly<Bindings>,
  ) {
    hud.connect({ camera, cutActive, prefs, bindings });
  }

  update(world: World, player: Fighter | null, dt: number): void {
    this.hud.update(world, player, dt);
  }

  mood(m: '' | 'death'): void {
    this.hud.mood(m);
  }

  deathBanner(secondsLeft: number | null): void {
    this.hud.deathBanner(secondsLeft);
  }

  popup(text: string): void {
    this.hud.popup(text);
  }

  handle(e: SimEvent, world: World): void {
    this.hud.handle(e, world);
  }
}
