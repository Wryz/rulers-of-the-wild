// Sound behind SfxPort (docs/M1-DESIGN.md §10.9): feel/audio.ts (changed DS) decides what every event sounds like. The
// adapter file P37 changes, so game.ts never has to (RF-9).
//
// STUB (P31; P37 fills it): DungeonStyle's sound choices for its events (game.ts handleEvent). P37: chop, creak, crack,
// snap, tree falls, dig, knap, footstep surfaces, roars, the jungle ambience, positional sound, FEEL_TUNING.
// TODO(P37, P18): footsteps. DS read and cleared f.footwork.landed from the client, a write into sim state that the
// sim's noise (P18) would read; the client no longer clears it, so footsteps wait for a per-tick source in the sim.
import type { Vector3 } from 'three';
import type { Fighter, World } from '@wild/sim';
import type { SfxPort, SimEvent } from '../game/ports';
import type { Material, Sfx } from './audio';

/** What a blunt weapon sounds like when it lands (DS). */
const IMPACT: Partial<Record<string, Material>> = { pan: 'pan', chair: 'metal', crowbar: 'metal', pipe: 'metal', sledgehammer: 'metal', bottle: 'glass' };
/** Weapons that knock (wood) rather than ring (metal, glass) when they hit the floor (DS). */
const WOODEN = new Set(['bat', 'club', 'bokken', 'cue']);

export class SfxAdapter implements SfxPort {
  constructor(
    readonly sfx: Sfx,
    private readonly player: () => Fighter | null,
  ) {}

  get volume(): number {
    return this.sfx.volume;
  }

  setVolume(v: number): void {
    this.sfx.setVolume(v);
  }

  /** TODO(P37): positional sound around the camera. */
  setListener(_p: Vector3): void {}

  /** TODO(P37): the 'jungle' ambience, thinning out when the giant is near. Plus DS's panting, now. */
  ambience(_world: World, realDt: number, gameDt: number): void {
    if (gameDt > 0) this.panting(realDt);
  }

  private breathT = 0;
  private breathOut = false;

  /** DS: you can hear yourself sucking air when you're gassed. */
  private panting(dt: number): void {
    const p = this.player();
    if (!p) return;
    const tired = Math.max(0, Math.min(1, (0.4 - p.stamina) / 0.35));
    if (!p.alive || tired <= 0) return;
    this.breathT -= dt;
    if (this.breathT > 0) return;
    this.breathOut = !this.breathOut;
    this.sfx.pant(this.breathOut, 0.5 + tired);
    this.breathT = this.breathOut ? 0.42 - tired * 0.12 : 0.3 - tired * 0.08;
  }

  handle(e: SimEvent, _world: World): void {
    const s = this.sfx;
    switch (e.type) {
      case 'hit': {
        const m = e.move;
        const heavy = m.weight === 'heavy';
        const w = e.weapon;
        if (w?.edge === 'blade') {
          if (w.id === 'axe') s.impact('axe', heavy);
        } else if (w) s.impact(IMPACT[w.id] ?? 'wood', heavy);
        else if (m.weapon) s.impact('wood', false); // caught with the haft
        else s.flesh(e.zone === 'head', m.weight);
        if (e.damage >= 9) s.grunt(e.defender.scale);
        if (w?.edge === 'blade') s.slice(heavy);
        if (e.sever || e.fatal) s.sever();
        return;
      }
      case 'block':
        s.block(e.move.weight === 'heavy');
        if (e.parry && e.perfect) s.counterReady();
        return;
      case 'dodge':
        s.dodge();
        if (e.defender === this.player() && e.kind !== 'airborne') s.counterReady();
        return;
      case 'swing':
        s.whoosh(e.move.weight);
        s.exhale(e.move.weight !== 'light', e.f.scale);
        return;
      case 'throw': {
        const mass = e.projectile.weapon.mass;
        s.whoosh(mass > 1.5 ? 'heavy' : mass > 0.5 ? 'medium' : 'light');
        s.exhale(true, e.f.scale);
        return;
      }
      case 'thud': {
        const w = e.projectile.weapon;
        s.landing(w.mass, !WOODEN.has(w.id), Math.min(1, e.speed / 12));
        return;
      }
      case 'pickup':
        s.clank(true);
        return;
      case 'drop':
        // (Something let go of mid-air sounds when it lands.)
        if (!e.drop.from) s.clank(false);
        return;
      case 'bump':
        s.bump();
        return;
      case 'clang': {
        const w = e.f.weapon;
        if (w) s.impact(e.metal ? 'metal' : (IMPACT[w.id] ?? 'wood'), true);
        else s.bump();
        return;
      }
      case 'ko':
        s.ko();
        return;
      case 'land':
        // TODO(P37): the thud of something landing, heard when it lands (SPEC:581): a body → bodyFall(mass, hard) (DS
        // bodyLanding: mass = scale³, hard = min(1, fall speed / 5)); a log or a stone → landing(mass, …); a felled tree
        // → treeFall(mass). DS's jump landings (both feet at once, footstep(surface, 1 and 0.9, 1.15·scale)) need a
        // per-step source too (DS detected them from f.isAirborne()).
        return;
      default:
        return;
    }
  }
}
