// The HUD behind HudPort (docs/M1-DESIGN.md §10.8): ui/hud.ts (changed DS), ui/compass.ts and render/markers.ts. The
// adapter file P36 changes, so game.ts never has to (RF-9).
//
// STUB (P31; P36 fills it): DungeonStyle's bars (you, and the target you're fighting), mood, banner, popups, the
// always-on combat markers, the cues-only popups and the controls hint that fades once you've thrown a few strikes;
// the death banner counts down from the sim's respawn tick (game.ts passes the seconds left).
// P36: the hands strip, the compass, the target bar with the giant's wounds, the awareness markers.
// TODO(P36): DS's training HUD is not shown: the move panel (Hud.moves: each button's move, ready/busy/chain/counter,
// keyLabel(bindings())), the fight tips (Hud.cue from DS game.ts tactics(), gated by prefs().tips) and the
// incoming-threat marker (Hud.incoming); and the cues-only telegraph rings on an enemy's wind-up (DS render: a ring
// per new attackSerial, Fx's effects). §10.8's minimal HUD leaves them out; keep or drop them, and say so in Settings
// (P35's "Fight tips" row and the telegraph part of "Combat cues" do nothing until then).
// TODO(P36): the controls hint (Hud.setBindings, ui/hud.ts) still lists DS's keys ("G grab / drop weapon"); M1's
// verbs (§5.14, P35's bindings) replace it.
import { type Camera, Vector3 } from 'three';
import type { Fighter, World } from '@wild/sim';
import type { HudPort, SimEvent } from '../game/ports';
import type { Prefs } from '../game/prefs';
import type { Bindings } from '../input/bindings';
import { AwarenessMarkers } from '../render/markers';
import { Compass } from './compass';
import type { Hud } from './hud';

/** DS: the controls hint fades after this many strikes of yours. */
const HINT_FADE_AFTER = 8;

export class HudAdapter implements HudPort {
  readonly compass: Compass;
  readonly markers: AwarenessMarkers;
  private player: Fighter | null = null;
  private bannerText: string | null = null;
  private attacksThrown = 0;

  constructor(
    readonly hud: Hud,
    /** The HUD's root element (#ui). */
    root: HTMLElement,
    /** The camera the frame is seen through (popups are placed with it). */
    private readonly camera: () => Camera,
    /** A kill cam is running: no markers over it (DS). */
    private readonly cutActive: () => boolean,
    /** The player's prefs (cues, tips). */
    private readonly prefs: () => Readonly<Prefs>,
    /** The current key bindings (key labels on the HUD; P36's move panel or hands strip). */
    readonly bindings: () => Readonly<Bindings>,
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
    this.hud.popup(text, this.overHead(p, 2.1), this.camera(), '');
  }

  /** DS's combat markers (always on) and cues popups (prefs.cues) for an event: what a blow did, where it landed. */
  handle(e: SimEvent, _world: World): void {
    const me = this.player;
    const cues = this.prefs().cues;
    switch (e.type) {
      case 'attackStart':
        if (e.f === me && ++this.attacksThrown === HINT_FADE_AFTER) this.hud.fadeHint();
        return;
      case 'hit': {
        const dmg = Math.max(1, Math.round(e.damage));
        const byMe = e.attacker === me;
        if (byMe) this.marker(e.counter ? `COUNTER ${dmg}` : String(dmg), e.point, e.counter || e.damage >= 12 ? 'dmg big' : 'dmg');
        else if (e.defender === me) this.marker(`-${dmg}`, e.point, 'hurt');
        if (e.tear) {
          const label = e.tear.piece === 'earL' || e.tear.piece === 'earR' ? 'EAR OFF' : e.tear.piece === 'scalp' ? 'SCALPED' : null;
          if (label) this.marker(label, e.tear.point, e.defender === me ? 'hurt' : 'big');
        }
        if (!cues) return;
        if (byMe && e.combo >= 2) this.hud.showCombo(e.combo);
        if (byMe && e.counter) this.hud.popup('COUNTER', e.point, this.camera(), 'counter');
        if (byMe && e.armored) this.hud.popup('ARMORED', e.point, this.camera(), 'armor');
        if (e.sever) {
          const b = e.sever;
          this.hud.popup(b === 'head' ? 'DECAPITATED' : b.startsWith('thigh') || b.startsWith('shin') ? 'LEG OFF' : 'ARM OFF', e.point, this.camera(), 'armor');
        } else if (e.fatal) {
          this.hud.popup(e.fatal === 'split' ? 'SKULL SPLIT' : e.fatal === 'cleft' ? 'SKULL CLEFT' : 'SKULL CRUSHED', e.point, this.camera(), 'armor');
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
      case 'pickup':
        if (cues && e.f === me) this.hud.popup(e.drop.weapon.name.toUpperCase(), this.overHead(e.f, 2.1), this.camera(), 'counter');
        return;
      case 'bleedout':
        if (cues) this.hud.popup('BLED OUT', this.overHead(e.f, 1.6), this.camera(), 'armor');
        return;
      default:
        return;
    }
  }

  /** A point `h` m (× scale) above the fighter's feet (DS popups sat at fixed heights over a flat floor). */
  private overHead(f: Fighter, h: number): Vector3 {
    return new Vector3(f.pos.x, f.pos.y + h * f.scale, f.pos.z);
  }

  private marker(text: string, at: Vector3, cls: string): void {
    if (this.cutActive()) return;
    this.hud.popup(text, at.clone().setY(at.y + 0.25), this.camera(), cls);
  }
}
