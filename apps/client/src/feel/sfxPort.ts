// Sound behind SfxPort (docs/M1-DESIGN.md §10.9): which sound every sim event makes, where it is heard from, and the
// per-frame sounds that come from reading the sim's state: footsteps and jump landings, creaking ropes and notched
// trees, the jungle hushing when the giant is near. feel/audio.ts makes the sounds; this adapter is the one place that
// decides them, so game.ts never has to (RF-9).
//
// Rule 6: everything here reads the world and writes nothing to it. DungeonStyle read footsteps from
// f.footwork.landed and cleared it, a write into sim state; this adapter instead watches each foot's `stepping` flag go
// false (a landing) between frames, which only reads.
import { Vector3 } from 'three';
import { DT, type Fighter, HUMANOID_MASS, type MaterialId, TERRAIN_TUNING, type V3, type World } from '@wild/sim';
import type { SfxPort, SimEvent } from '../game/ports';
import { RENDER_TUNING } from '../render/terrainView';
import { distanceGain, FEEL_TUNING, giantStepTrauma, type ImpactSound, type Sfx, type SoundMaterial, type Surface } from './audio';

/** What a blunt weapon sounds like when it lands (DS). */
const IMPACT: Partial<Record<string, ImpactSound>> = { pan: 'pan', chair: 'metal', crowbar: 'metal', pipe: 'metal', sledgehammer: 'metal', bottle: 'glass' };
/** Weapons that knock (wood) rather than ring (metal, glass) when they hit the floor (DS). */
const WOODEN = new Set(['bat', 'club', 'bokken', 'cue']);

/** A sim material's sound family. */
export const SOUND_OF: Readonly<Record<MaterialId, SoundMaterial>> = {
  greenWood: 'wood',
  dryWood: 'wood',
  rottenWood: 'wood',
  leaves: 'leaves',
  vine: 'rope',
  sinew: 'rope',
  hide: 'soft',
  bone: 'bone',
  rulerBone: 'bone',
  stone: 'stone',
  flint: 'stone',
  dirt: 'dirt',
  snow: 'dirt',
  ice: 'stone',
  resin: 'soft',
  fat: 'soft',
};

/** What a foot standing on a thing of this material lands on. */
export function surfaceOf(material: MaterialId): Surface {
  const s = SOUND_OF[material];
  return s === 'wood' ? 'log' : s === 'stone' || s === 'bone' ? 'rock' : s === 'leaves' ? 'leaves' : 'dirt';
}

/** A held tool or struck thing's material as a blow's sound. */
function impactSoundOf(material: MaterialId): ImpactSound {
  const s = SOUND_OF[material];
  return s === 'stone' || s === 'bone' ? 'stone' : 'wood';
}

/** What the adapter remembers of a fighter between frames (all read from the sim, none written to it). */
interface Track {
  L: boolean;
  R: boolean;
  air: boolean;
  y: number;
  tick: number;
  /** m/s, from the last two frames' heights (negative falling). */
  vy: number;
  /** Ticks with no landing sound (after a respawn or a teleport). */
  quietUntil: number;
}

const DOWN: V3 = { x: 0, y: -1, z: 0 };

export class SfxAdapter implements SfxPort {
  /**
   * The camera jolt a giant's footfall asks for (FEEL_TUNING: 0.05·(scale − 1)·near inside 6·scale m). Footfalls are
   * read here, not sent as events, so the camera hears of them through this. TODO(main.ts follow-up): wire it to
   * CameraPort.shake.
   */
  onTrauma: ((trauma: number) => void) | null = null;

  private readonly listener = new Vector3();
  private hasListener = false;
  /** Horizontal unit vector to the right of the listener (from where the camera looks), or null: no panning. */
  private right: { x: number; z: number } | null = null;
  private readonly tracks = new WeakMap<Fighter, Track>();
  /** Trees seen falling and not landed yet (their landing is the crash). */
  private readonly falling = new Map<number, number>();
  /** Game seconds: when each creaking rope (joint id) or tree (−entity id) may creak next. */
  private readonly creakAt = new Map<number, number>();
  private time = 0;
  private jungleOn = false;

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

  /**
   * Where the ears are: the camera. Sounds are quieter with distance and panned to the side they come from, the
   * camera's right taken from `forward` when given, else from where it looks: at the player, as the follow and fight
   * cameras do.
   */
  setListener(p: Vector3, forward?: Vector3): void {
    this.listener.copy(p);
    this.hasListener = true;
    let fx: number;
    let fz: number;
    if (forward) {
      fx = forward.x;
      fz = forward.z;
    } else {
      const me = this.player();
      if (!me) {
        this.right = null;
        return;
      }
      fx = me.pos.x - p.x;
      fz = me.pos.z - p.z;
    }
    const len = Math.hypot(fx, fz);
    this.right = len > 1e-3 ? { x: -fz / len, z: fx / len } : null;
  }

  /** Per rendered frame: the jungle, footsteps and landings, creaks, and DS's panting when the player is gassed. */
  ambience(world: World, realDt: number, gameDt: number): void {
    const s = this.sfx;
    s.applyTuning();
    if (!this.jungleOn) {
      s.setAmbience('jungle');
      this.jungleOn = true;
    }
    s.setJungleLevel(this.jungleLevel(world));
    if (!(gameDt > 0)) return;
    this.time += gameDt;
    s.ambienceTick(gameDt);
    this.panting(realDt);
    this.feet(world);
    this.creaks(world);
  }

  /** The jungle hushes as a ruler comes within FEEL_TUNING.ambienceQuietRangeM of the ears (SPEC:851). */
  jungleLevel(world: World): number {
    const range = FEEL_TUNING.ambienceQuietRangeM;
    if (!(range > 0)) return 1;
    const ears = this.ears();
    let level = 1;
    for (const f of world.combat.fighters) {
      if (!f.ruler || !f.alive || !ears) continue;
      const d = Math.hypot(f.pos.x - ears.x, f.pos.z - ears.z);
      level = Math.min(level, Math.max(0, Math.min(1, d / range)));
    }
    return level;
  }

  private breathT = 0;
  private breathOut = false;

  /** DS: you can hear yourself sucking air when you're gassed. */
  private panting(dt: number): void {
    const p = this.player();
    if (!p) return;
    const B = FEEL_TUNING.breath;
    const tired = Math.max(0, Math.min(1, (B.tiredBelow - p.stamina) / Math.max(1e-6, B.tiredSpan)));
    if (!p.alive || tired <= 0) return;
    this.breathT -= dt;
    if (this.breathT > 0) return;
    this.breathOut = !this.breathOut;
    this.sfx.pant(this.breathOut, 0.5 + tired);
    this.breathT = this.breathOut ? B.outS - tired * B.outQuickerS : B.inS - tired * B.inQuickerS;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  handle(e: SimEvent, world: World): void {
    const s = this.sfx;
    const L = FEEL_TUNING.loud;
    switch (e.type) {
      // DungeonStyle's fight sounds, now heard from where they happen.
      case 'hit': {
        const m = e.move;
        const heavy = m.weight === 'heavy';
        const w = e.weapon;
        const tool = this.wielded(e.attacker, world);
        this.at(e.point, L.combat, () => {
          if (w?.edge === 'blade') {
            if (w.id === 'axe') s.impact('axe', heavy);
          } else if (w) s.impact(IMPACT[w.id] ?? 'wood', heavy);
          else if (tool) s.impact(impactSoundOf(tool), heavy);
          else if (m.weapon) s.impact('wood', false); // caught with the haft
          else s.flesh(e.zone === 'head', m.weight);
          if (e.damage >= 9) s.grunt(e.defender.scale);
          if (w?.edge === 'blade') s.slice(heavy);
          if (e.sever || e.fatal) s.sever();
        });
        return;
      }
      case 'block':
        this.at(e.point, L.combat, () => {
          s.block(e.move.weight === 'heavy');
          if (e.parry && e.perfect) s.counterReady();
        });
        return;
      case 'dodge':
        this.at(e.point, L.combat, () => {
          s.dodge();
          if (e.defender === this.player() && e.kind !== 'airborne') s.counterReady();
        });
        return;
      case 'swing':
        this.at(e.f.pos, L.combat, () => {
          s.whoosh(e.move.weight);
          s.exhale(e.move.weight !== 'light', e.f.scale);
        });
        return;
      case 'throw': {
        const mass = e.projectile.weapon.mass;
        this.at(e.f.pos, L.combat, () => {
          s.whoosh(mass > 1.5 ? 'heavy' : mass > 0.5 ? 'medium' : 'light');
          s.exhale(true, e.f.scale);
        });
        return;
      }
      case 'thud': {
        const w = e.projectile.weapon;
        this.at(e.point, L.combat, () => s.landing(w.mass, !WOODEN.has(w.id), Math.min(1, e.speed / 12)));
        return;
      }
      case 'pickup':
        this.at(e.f.pos, L.step, () => s.clank(true));
        return;
      case 'drop':
        // (Something let go of mid-air sounds when it lands.)
        if (!e.drop.from) this.at(e.drop.pos, L.step, () => s.clank(false));
        return;
      case 'bump':
        this.at(e.point, L.combat, () => s.bump());
        return;
      case 'clang': {
        const w = e.f.weapon;
        this.at(e.point, L.combat, () => {
          if (w) s.impact(e.metal ? 'metal' : (IMPACT[w.id] ?? 'wood'), true);
          else s.bump();
        });
        return;
      }
      case 'ko':
        this.at(e.point, L.combat * Math.max(1, e.victim.scale), () => s.ko());
        if (e.victim.ruler) this.at(e.victim.pos, L.roar, () => s.roar(e.victim.scale, 1));
        return;

      // The world's events.
      case 'impact':
        this.impact(e, world);
        return;
      case 'wound':
        // A trap opens a wound on a ruler: it bellows (SPEC:850).
        this.at(e.ruler.pos, L.roar, () => s.roar(e.ruler.scale, e.wound.severe ? 1 : 0.7));
        return;
      case 'trip':
        if (e.f.ruler) this.at(e.at, L.roar, () => s.roar(e.f.scale, 0.85));
        return;
      case 'launch':
        this.at(e.f.pos, L.combat, () => s.whoosh('heavy'));
        return;
      case 'land':
        this.land(e, world);
        return;
      case 'break': {
        const m = e.pieces.reduce((sum, id) => sum + (world.entities.get(id)?.mass ?? 0), 0);
        const first = e.pieces.length > 0 ? world.entities.get(e.pieces[0]) : undefined;
        const kind = first && SOUND_OF[first.material] === 'stone' ? 'stone' : 'wood';
        this.at(e.point, L.crack, () => s.crack(m, kind));
        return;
      }
      case 'joint': {
        const where = this.jointPoint(e.joint, world);
        if (e.what === 'snap') this.at(where, L.snap, () => s.snap());
        else if (e.what === 'cut') {
          this.at(where, L.snap, () => {
            s.snap();
            s.slice(false);
          });
        } else this.at(where, L.step, () => s.rustle());
        return;
      }
      case 'tripwire': {
        const where = this.jointPoint(e.joint, world);
        if (e.snapped) this.at(where, L.snap, () => s.snap());
        else this.at(where, L.creak, () => s.creak(0.6));
        return;
      }
      case 'chop': {
        const tree = world.entities.get(e.tree);
        const d = tree?.plant?.diameter ?? 0.3;
        const below = RENDER_TUNING.creakBelowRemaining;
        this.at(e.point, L.chop, () => {
          s.chop(d, true);
          // The last chops before it goes: the trunk creaks (SPEC:581).
          if (below > 0 && e.remaining <= below) s.later(FEEL_TUNING.creaks.chopCreakDelayS, () => s.creak(1 - e.remaining / below));
        });
        return;
      }
      case 'fell': {
        const tree = world.entities.get(e.tree);
        const mass = tree?.mass ?? 500;
        this.falling.set(e.tree, mass);
        this.at(tree?.pose.p ?? this.ears(), L.treeFall, () => s.treeFall(mass));
        return;
      }
      case 'crossCut': {
        const ent = world.entities.get(e.entity) ?? (e.pieces ? world.entities.get(e.pieces[0]) : undefined);
        const where = ent?.pose.p ?? null;
        this.at(where, L.chop, () => {
          s.chop(0.12, true);
          if (e.pieces) s.crack(ent?.mass ?? 5, 'wood');
        });
        return;
      }
      case 'dig':
        this.at(e.point, L.dig, () => s.dig());
        return;
      case 'shove': {
        // A ruler shoves an entity aside: it scrapes and knocks, by the entity's mass and material.
        const ent = world.entities.get(e.entity);
        this.at(ent?.pose.p ?? e.ruler.pos, L.crack, () => {
          s.scrape();
          if (ent) s.thud(ent.mass, SOUND_OF[ent.material], 0.6);
        });
        return;
      }
      case 'deflect':
        this.at(e.ruler.pos, L.crack, () => s.scrape());
        return;
      case 'respawn':
        if (e.f === this.player()) s.chime();
        this.quiet(e.f, world);
        return;
      case 'parts':
        // An environmental kill tears a body apart (DS sever).
        if (e.environmental) this.at(null, L.combat, () => s.sever());
        return;
      case 'verb':
        this.verb(e, world);
        return;
      case 'noise':
        // The sim's noise hints carry voices; every other kind has its own event above (or is read per frame).
        // TODO(P18, P20): roars and shouts arrive as `noise` events ('roar', 'shout') once the minds emit them.
        if (e.kind === 'roar') {
          const r = this.nearestRuler(world, e.at);
          this.at(e.at, L.roar, () => s.roar(r?.scale ?? 5.5, 1));
        } else if (e.kind === 'shout') this.at(e.at, L.hoot, () => s.apeHoot());
        return;
      default:
        return;
    }
  }

  /** A world hit on a fighter (§2.13 `impact`): the thing that struck it, by material and mass, then the body. */
  private impact(e: Extract<SimEvent, { type: 'impact' }>, world: World): void {
    const s = this.sfx;
    const c = e.cause;
    const ent = c.kind === 'entity' && c.entityId !== null ? world.entities.get(c.entityId) : undefined;
    const hard = Math.min(1, e.energy / Math.max(1, e.defender.mass * FEEL_TUNING.thuds.impactHardJPerKg));
    this.at(e.point, FEEL_TUNING.loud.crash, () => {
      if (ent) {
        s.thud(ent.mass, SOUND_OF[ent.material], hard);
        if (c.feature === 'sharpPoint' && e.damage > 0) s.slice(e.weight === 'heavy');
      } else if (c.kind === 'terrain') s.bodyFall(e.defender.mass / HUMANOID_MASS, hard);
      if (e.damage > 0) s.flesh(e.zone === 'head', e.weight);
    });
  }

  /** Something landed (SPEC:581: a thud, scaled by mass): a felled tree's crash, a body, a log or a stone. */
  private land(e: Extract<SimEvent, { type: 'land' }>, world: World): void {
    const s = this.sfx;
    const T = FEEL_TUNING;
    if (e.entity !== null && this.falling.has(e.entity)) {
      const mass = this.falling.get(e.entity) ?? e.mass;
      this.falling.delete(e.entity);
      this.at(e.point, T.loud.crash, () => s.treeLand(mass));
      return;
    }
    if (e.energy < T.thuds.minEnergyJ) return;
    const m = Math.max(1e-3, e.mass);
    const speed = Math.sqrt((2 * e.energy) / m);
    if (e.f) {
      // DS bodyLanding: mass in bodies (scale³ there; kg ÷ the humanoid's mass here), hard = fall speed / 5.
      const f = e.f;
      this.at(e.point, T.loud.crash * Math.max(1, f.scale), () => s.bodyFall(f.mass / HUMANOID_MASS, speed / T.thuds.bodyHardSpeed));
      return;
    }
    const ent = e.entity !== null ? world.entities.get(e.entity) : undefined;
    const material: SoundMaterial = ent ? SOUND_OF[ent.material] : 'wood';
    this.at(e.point, m > 100 ? T.loud.crash : T.loud.step * 2, () => s.thud(m, material, speed / T.thuds.entityHardSpeed));
  }

  /** A verb landing (§2.13 `verb`): what the hands did, heard. Refusals are the HUD's. */
  private verb(e: Extract<SimEvent, { type: 'verb' }>, world: World): void {
    if (!e.ok) return;
    const s = this.sfx;
    const ent = e.entity !== undefined ? world.entities.get(e.entity) : undefined;
    const where = ent?.pose.p ?? e.f.pos;
    const L = FEEL_TUNING.loud;
    switch (e.verb) {
      case 'take':
      case 'stow':
      case 'draw':
        this.at(where, L.step, () => (ent && SOUND_OF[ent.material] === 'stone' ? s.clank(true) : s.rustle()));
        return;
      case 'shape':
        this.at(where, L.dig, () => (ent && SOUND_OF[ent.material] === 'stone' ? s.knap() : s.scrape()));
        return;
      case 'lash':
      case 'tie':
      case 'untie':
        this.at(where, L.step, () => {
          s.rustle();
          s.creak(0.15);
        });
        return;
      case 'bend':
      case 'pull':
        this.at(where, L.creak, () => s.creak(0.5));
        return;
      case 'place':
        this.at(where, L.step * 2, () => s.thud(ent?.mass ?? 5, ent ? SOUND_OF[ent.material] : 'wood', 0.5));
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Per frame: feet, landings, creaks (read from the sim's state, never written)
  // ---------------------------------------------------------------------------

  /**
   * Footsteps and jump landings. TODO(P08, P18): a per-tick `step` event (fighter, foot, point) and a `land` event for
   * every KCC landing (`landed(f, v)`, §4.2) would make these exact; until then a foot whose `stepping` went false
   * since the last frame has landed, and a fall that stops is a landing (two steps inside one rendered frame — rare
   * below 30 fps — sound as one).
   */
  private feet(world: World): void {
    const T = FEEL_TUNING;
    const tick = world.tick;
    const ears = this.ears();
    for (const f of world.combat.fighters) {
      const fw = f.footwork;
      let t = this.tracks.get(f);
      if (!t) {
        t = { L: fw.L.stepping, R: fw.R.stepping, air: f.isAirborne(), y: f.pos.y, tick, vy: 0, quietUntil: tick };
        this.tracks.set(f, t);
        continue;
      }
      const standing = f.alive && f.state !== 'knockdown' && f.state !== 'tripped' && f.state !== 'getup';
      const far = ears ? Math.hypot(f.pos.x - ears.x, f.pos.z - ears.z) > T.space.maxDistM * Math.max(T.loud.step, T.loud.giantStep) : false;
      const quiet = tick < t.quietUntil || !standing || far;
      for (const foot of [fw.L, fw.R]) {
        const was = t[foot.side];
        t[foot.side] = foot.stepping;
        if (was && !foot.stepping && !quiet) this.step(world, f, foot.pos);
      }
      // A jump or a fall coming down: both feet at once, with weight (DS landings).
      const dt = (tick - t.tick) * DT;
      const vy = dt > 0 ? (f.pos.y - t.y) / dt : t.vy;
      const air = f.isAirborne();
      const dsLanding = t.air && !air && f.state === 'attack';
      const fellFast = t.vy < -T.steps.jumpLandSpeed && vy > t.vy * T.steps.landStopFrac && t.vy > -T.steps.teleportSpeed;
      if ((dsLanding || fellFast) && !quiet) this.jumpLanding(world, f);
      if (Math.abs(vy) > T.steps.teleportSpeed) t.quietUntil = tick + 2;
      t.air = air;
      if (dt > 0) {
        t.vy = vy;
        t.y = f.pos.y;
        t.tick = tick;
      }
    }
  }

  /** One footfall of `f` at `at`: on what it stands on; a giant's shakes the ground (and the camera). */
  private step(world: World, f: Fighter, at: V3): void {
    const T = FEEL_TUNING;
    const s = this.sfx;
    if (f.scale >= T.steps.giantFromScale) {
      const me = this.player();
      const d = me ? Math.hypot(me.pos.x - at.x, me.pos.z - at.z) : Infinity;
      const radius = T.giantShakeRadiusPerScale * f.scale;
      const near = radius > 0 ? Math.max(0, 1 - d / radius) : 0;
      this.at(at, T.loud.giantStep, () => s.giantStep(near));
      const trauma = giantStepTrauma(f.scale, d);
      if (trauma > 0) this.onTrauma?.(trauma);
      return;
    }
    const speed = Math.hypot(f.walkVel.x, f.walkVel.z) / f.scale;
    const surface = this.surfaceAt(world, at);
    this.at(at, T.loud.step * f.scale, () => s.footstep(surface, Math.min(1, speed / T.steps.runSpeed), f.scale));
  }

  private jumpLanding(world: World, f: Fighter): void {
    const T = FEEL_TUNING;
    if (f.scale >= T.steps.giantFromScale) {
      this.step(world, f, f.pos);
      return;
    }
    const surface = this.surfaceAt(world, f.pos);
    const k = T.steps.jumpLandScaleMul * f.scale;
    this.at(f.pos, T.loud.step * f.scale, () => {
      this.sfx.footstep(surface, 1, k);
      this.sfx.footstep(surface, 0.9, k);
    });
  }

  /** What the ground under `p` is: the entity a foot stands on (a log, a stone, a leaf cover), grass, or bare earth. */
  surfaceAt(world: World, p: V3): Surface {
    const T = FEEL_TUNING.steps;
    const ground = world.terrain.heightAt(p.x, p.z);
    if (p.y > ground + T.onEntityM) {
      const hit = world.queries.castRay({ x: p.x, y: p.y + 0.3, z: p.z }, DOWN, 0.3 + (p.y - ground), { terrain: false, entities: 'all' });
      if (hit && hit.owner.kind === 'entity') {
        const e = world.entities.get(hit.owner.id);
        if (e) return surfaceOf(e.material);
      }
    }
    if (world.cover.at(p.x, p.z) >= T.coverGrass) return 'grass';
    return surfaceOf(TERRAIN_TUNING.material);
  }

  /**
   * Ropes under strain creak louder and more often toward breaking (SPEC:357, rule 3); a notched tree creaks before
   * it goes (SPEC:581), from RENDER_TUNING.creakBelowRemaining, where its look starts to creak too.
   */
  private creaks(world: World): void {
    const T = FEEL_TUNING;
    const s = this.sfx;
    const from = T.creakFrom;
    for (const r of world.joints.view()) {
      if (!(r.strain >= from)) continue;
      const i = Math.min(1, (r.strain - from) / Math.max(1e-6, 1 - from));
      if (!this.due(r.joint, T.creaks.ropePeriodS * (1 - 0.75 * i))) continue;
      this.at({ x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2, z: (r.a.z + r.b.z) / 2 }, T.loud.creak, () => s.creak(i));
    }
    const below = RENDER_TUNING.creakBelowRemaining;
    if (!(below > 0)) return;
    for (const e of world.entities.all()) {
      const p = e.plant;
      if (!p || p.phase !== 'notched' || !p.cut || p.cut.remaining > below) continue;
      const i = 1 - p.cut.remaining / below;
      if (!this.due(-e.id, T.creaks.treePeriodS * (1 - 0.6 * i))) continue;
      this.at(e.pose.p, T.loud.creak, () => s.creak(0.3 + 0.7 * i));
    }
  }

  /** Is the creak keyed `key` due (and if so, when is the next)? The period is jittered so creaks never tick. */
  private due(key: number, periodS: number): boolean {
    const next = this.creakAt.get(key);
    if (next !== undefined && this.time < next) return false;
    this.creakAt.set(key, this.time + Math.max(0.05, periodS) * (0.7 + 0.6 * Math.random()));
    // The first sighting only arms the timer: a rope already taut when you arrive doesn't creak the same frame.
    return next !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Plays `fn` from `p` (null: at the ears): quieter with distance, panned to its side. */
  private at(p: V3 | null, loud: number, fn: () => void): void {
    if (!p || !this.hasListener) {
      this.sfx.emit(1, 0, fn);
      return;
    }
    const dx = p.x - this.listener.x;
    const dy = p.y - this.listener.y;
    const dz = p.z - this.listener.z;
    const d = Math.hypot(dx, dy, dz);
    const gain = distanceGain(d, loud);
    if (gain <= 0) return;
    let pan = 0;
    const h = Math.hypot(dx, dz);
    if (this.right && h > 1e-3) pan = ((dx * this.right.x + dz * this.right.z) / h) * FEEL_TUNING.space.pan;
    this.sfx.emit(gain, pan, fn);
  }

  /** Where the sound is heard from: the listener once set, else the player. */
  private ears(): V3 | null {
    if (this.hasListener) return this.listener;
    return this.player()?.pos ?? null;
  }

  /** The material of what `f` wields (M1 tools are entities in the hands), or null. */
  private wielded(f: Fighter, world: World): MaterialId | null {
    const h = f.inventory?.hands;
    if (!h || h.mode !== 'wield') return null;
    return world.entities.get(h.entity)?.material ?? null;
  }

  /** The middle of a rope (from the ropes' view), or null (heard at the ears). */
  private jointPoint(joint: number, world: World): V3 | null {
    const r = world.joints.view().find((v) => v.joint === joint);
    return r ? { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2, z: (r.a.z + r.b.z) / 2 } : null;
  }

  private nearestRuler(world: World, at: V3): Fighter | null {
    let best: Fighter | null = null;
    let bd = Infinity;
    for (const f of world.combat.fighters) {
      if (!f.ruler) continue;
      const d = Math.hypot(f.pos.x - at.x, f.pos.z - at.z);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  /** No landing sounds for `f` for a moment (a respawn or a teleport moves it, it doesn't fall). */
  private quiet(f: Fighter, world: World): void {
    const t = this.tracks.get(f);
    if (t) {
      t.quietUntil = world.tick + 2;
      t.vy = 0;
      t.y = f.pos.y;
      t.tick = world.tick;
    }
  }
}
