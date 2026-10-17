// The HUD behind HudPort (docs/M1-DESIGN.md §10.8): ui/hud.ts (changed DS), ui/compass.ts and render/markers.ts. The
// adapter file P36 changes, so game.ts never has to (RF-9).
//
// STUB (P31; P36 fills it): DungeonStyle's bars (you, and the target you're fighting), mood, banner, popups and the
// always-on combat markers; the death banner counts down from the sim's respawn tick (game.ts passes the seconds left).
// P36: the hands strip, the compass, the target bar with the giant's wounds, the awareness markers.
import { type Camera, Vector3 } from 'three';
import type { Fighter, World } from '@wild/sim';
import type { HudPort, SimEvent } from '../game/ports';
import { AwarenessMarkers } from '../render/markers';
import { Compass } from './compass';
import type { Hud } from './hud';

export class HudAdapter implements HudPort {
  readonly compass: Compass;
  readonly markers: AwarenessMarkers;
  private player: Fighter | null = null;
  private bannerText: string | null = null;

  constructor(
    readonly hud: Hud,
    /** The HUD's root element (#ui). */
    root: HTMLElement,
    /** The camera the frame is seen through (popups are placed with it). */
    private readonly camera: () => Camera,
    /** A kill cam is running: no markers over it (DS). */
    private readonly cutActive: () => boolean,
  ) {
    this.compass = new Compass(root);
    this.markers = new AwarenessMarkers(root);
    // The training ring's round label goes (§10.8). TODO(P36): drop it from ui/hud.ts itself.
    root.querySelector<HTMLElement>('.hud .wave')?.style.setProperty('display', 'none');
  }

  update(world: World, player: Fighter | null, dt: number): void {
    this.player = player;
    if (!player) return;
    const t = player.target && player.target.alive ? player.target : null;
    // (The training ring's `.wave` label goes, §10.8.)
    this.hud.update(dt, player, t, '');
    this.compass.update(world, player, this.camera(), dt);
    this.markers.update(world, player, this.camera());
  }

  mood(m: '' | 'death'): void {
    this.hud.mood(m);
  }

  /** "DOWN — back in N s" (null hides it). */
  deathBanner(secondsLeft: number | null): void {
    const text = secondsLeft === null ? null : `back in ${Math.max(0, Math.ceil(secondsLeft))} s`;
    if (text === this.bannerText) return;
    this.bannerText = text;
    if (text === null) this.hud.hideBanner();
    else this.hud.showBanner('DOWN', text, 'down');
  }

  /** A callout over the player's head (a refused verb's reason). */
  popup(text: string): void {
    const p = this.player;
    if (!p) return;
    this.hud.popup(text, new Vector3(p.pos.x, p.pos.y + 2.1 * p.scale, p.pos.z), this.camera(), '');
  }

  /** DS's always-on combat markers (game.ts handleEvent): what a blow did, where it landed. */
  handle(e: SimEvent, _world: World): void {
    const me = this.player;
    switch (e.type) {
      case 'hit': {
        const dmg = Math.max(1, Math.round(e.damage));
        if (e.attacker === me) this.marker(e.counter ? `COUNTER ${dmg}` : String(dmg), e.point, e.counter || e.damage >= 12 ? 'dmg big' : 'dmg');
        else if (e.defender === me) this.marker(`-${dmg}`, e.point, 'hurt');
        if (e.tear) {
          const label = e.tear.piece === 'earL' || e.tear.piece === 'earR' ? 'EAR OFF' : e.tear.piece === 'scalp' ? 'SCALPED' : null;
          if (label) this.marker(label, e.tear.point, e.defender === me ? 'hurt' : 'big');
        }
        return;
      }
      case 'block':
        if (e.guardBreak) this.marker('GUARD BREAK', e.point, 'armor');
        else if (e.parry && e.perfect) this.marker('PERFECT PARRY', e.point, 'parry big');
        else if (e.parry) this.marker(e.defender === me ? 'PARRY!' : 'PARRIED', e.point, e.defender === me ? 'parry' : 'hurt');
        else this.marker(e.defender === me ? 'BLOCK' : 'BLOCKED', e.point, 'block');
        return;
      case 'dodge':
        if (e.defender === me && e.perfect) this.marker('PERFECT DODGE', e.point, 'parry big');
        else if (e.defender === me) this.marker(e.kind === 'airborne' ? 'EVADED' : 'DODGE', e.point, 'parry');
        else this.marker('MISS', e.point, 'miss');
        return;
      default:
        return;
    }
  }

  private marker(text: string, at: Vector3, cls: string): void {
    if (this.cutActive()) return;
    this.hud.popup(text, at.clone().setY(at.y + 0.25), this.camera(), cls);
  }
}
