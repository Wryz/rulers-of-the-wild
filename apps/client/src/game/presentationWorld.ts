// The presentation physics world (docs/M1-DESIGN.md §10.5, rule 6): its own Rapier world, never read by the sim, with
// the terrain and the fixed and anchored entities mirrored in, and the ragdolls that draw the player and the apes. Plus
// `Fx`, the blood, gibs and particles an event throws (render/blood.ts, gibs.ts, particles.ts).
//
// STUB (P31; P33 fills it): the final exported names, PRESENTATION_TUNING with its §9 values, DungeonStyle's ragdolls
// (driven toward the rig, a blow's impulse, a block, a limb cut loose, the knockdown throw) on mirrored terrain tiles,
// and DungeonStyle's blood, gibs and particles (sprays, face blood, drips, stump spurts, sweat, sparks, dust, rings).
// Nothing here writes fighter state: the DS ragdoll → sim copy is gone (§10.11). P33 adds the down-follow toward the
// sim's slab, the launch from the sim's `launch` event, slots owned by this world (D-42), ragdoll LOD and the entity
// mirrors.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { type Scene, Vector3 } from 'three';
import { defineTuning, DT, type Fighter, limbBones, Rng, type V3, type World, WORLD_TUNING } from '@wild/sim';
import { GROUP_ENV, groups, Ragdoll } from '../body/ragdoll';
import { Blood } from '../render/blood';
import { Gibs } from '../render/gibs';
import { Effects } from '../render/particles';
import type { BodyPose, FighterViewPort, FxPort, GoreLevel, PresentationPort, SimEvent, WorldViewsPort } from './ports';
import { Trauma } from './trauma';

export const PRESENTATION_TUNING = defineTuning(
  'PRESENTATION_TUNING',
  'Client › presentation',
  { maxRagdolls: 8, mirrorRadiusM: 30 },
  {
    maxRagdolls: { unit: 'ragdolls', source: 'NEW: SPEC:655-656 (ragdoll LOD)', min: 0, max: 14, step: 1, label: 'max ragdolls' },
    mirrorRadiusM: { unit: 'm', source: 'NEW: SPEC:655-656 (ragdoll LOD)', min: 5, max: 200, step: 1, label: 'mirror radius' },
  },
);

const TORSO = ['chest', 'abdomen', 'head'] as const;

export class PresentationWorld implements PresentationPort {
  readonly rapier: RAPIER_NS.World;
  private readonly ragdolls = new Map<Fighter, Ragdoll>();
  private ground: RAPIER_NS.RigidBody | null = null;
  private readonly tiles: RAPIER_NS.Collider[] = [];
  private tileVersions: Uint32Array = new Uint32Array(0);
  /** True once the sim has thrown a body itself (a `launch` event): DS's presentation-computed throw stops. */
  private simLaunches = false;

  constructor(
    private readonly R: typeof RAPIER_NS,
    private readonly world: World,
  ) {
    this.rapier = new R.World({ x: 0, y: WORLD_TUNING.gravityY, z: 0 });
    this.rapier.timestep = DT;
    this.syncStatic(world);
  }

  /** The terrain tiles as heightfields (re-shaped when a tile's version changes). TODO(P33): fixed and anchored entities. */
  syncStatic(world: World): void {
    const t = world.terrain;
    if (!this.ground) this.ground = this.rapier.createRigidBody(this.R.RigidBodyDesc.fixed());
    if (this.tileVersions.length !== t.tileCount) this.tileVersions = new Uint32Array(t.tileCount);
    for (let i = 0; i < t.tileCount; i++) {
      if (this.tiles[i] && this.tileVersions[i] === t.version[i]) continue;
      if (this.tiles[i]) this.rapier.removeCollider(this.tiles[i], false);
      const c = t.tileCentre(i);
      const desc = this.R.ColliderDesc.heightfield(t.cells, t.cells, new Float32Array(t.heights[i]), { x: t.tileSize, y: 1, z: t.tileSize })
        .setTranslation(c.x, 0, c.z)
        .setFriction(0.9)
        .setCollisionGroups(groups(GROUP_ENV, 0xffff));
      this.tiles[i] = this.rapier.createCollider(desc, this.ground);
      this.tileVersions[i] = t.version[i];
    }
  }

  /** TODO(P33): dynamic entities within mirrorRadiusM of the camera as kinematic colliders. */
  syncDynamic(_world: World, _cam: Vector3): void {}

  /** A ragdoll for `f`, while fewer than maxRagdolls exist; never the giant (§10.5). TODO(P33): the nearest to the camera. */
  attachRagdoll(f: Fighter): Ragdoll | null {
    const have = this.ragdolls.get(f);
    if (have) return have;
    if (f.ruler || this.ragdolls.size >= PRESENTATION_TUNING.maxRagdolls) return null;
    const rd = new Ragdoll(this.R, this.rapier, f);
    rd.snapTo(f);
    this.ragdolls.set(f, rd);
    return rd;
  }

  step(world: World): void {
    this.syncStatic(world);
    const fighters = world.combat.fighters;
    for (const [f, rd] of this.ragdolls) {
      if (fighters.includes(f)) continue;
      rd.dispose();
      this.ragdolls.delete(f);
    }
    for (const f of fighters) this.attachRagdoll(f);
    const isDown = (f: Fighter) => f.state === 'knockdown' || f.state === 'ko' || !f.alive;
    let downSlots = 0;
    for (const [f, rd] of this.ragdolls) if (isDown(f)) downSlots |= rd.slot;
    for (const [f, rd] of this.ragdolls) {
      rd.setContacts(isDown(f), downSlots);
      this.slideOff(f, rd, fighters);
      rd.drive(f);
      rd.capturePrev();
    }
    this.rapier.step();
    for (const rd of this.ragdolls.values()) rd.captureCur();
  }

  onLaunch(f: Fighter, vel: V3, _angVel: V3): void {
    // TODO(P33): the slab's spin too, and the down-follow toward the slab (RAGDOLL_TUNING.downRootGain).
    this.simLaunches = true;
    this.ragdolls.get(f)?.launch(new Vector3(vel.x, vel.y, vel.z));
  }

  /** Follows the body as drawn: the ragdoll's pelvis, kept above the ground (DS: 0.35 × scale). */
  pelvisOf(f: Fighter): () => Vector3 {
    return () => {
      const p = this.ragdolls.get(f)?.pelvisPos() ?? f.pos.clone();
      p.y = Math.max(this.world.terrain.heightAt(p.x, p.z) + 0.35 * f.scale, p.y);
      return p;
    };
  }

  /** Puts the body back on the rig at once (a respawn). DS resetPlayer: a body with limbs cut loose is rebuilt whole. */
  snapTo(f: Fighter): void {
    const rd = this.ragdolls.get(f);
    if (!rd) return;
    if (rd.loose.size > 0) {
      // TODO(P33): rebuild from what the sim's respawn keeps of the body (f.severed), in this world's slots (D-42).
      rd.dispose();
      this.ragdolls.delete(f);
      this.attachRagdoll(f);
      return;
    }
    rd.snapTo(f);
  }

  bodyPose(f: Fighter): BodyPose | null {
    return this.ragdolls.get(f) ?? null;
  }

  freeze(): void {
    for (const rd of this.ragdolls.values()) rd.freezeInterpolation();
  }

  /** DS's body reactions (game.ts handleEvent): a blow's impulse and throw, a block, a limb cut loose. */
  handle(e: SimEvent, _world: World): void {
    switch (e.type) {
      case 'hit': {
        const rd = this.ragdolls.get(e.defender);
        if (!rd) return;
        const m = e.move;
        rd.applyHit(e.zone, e.point, e.dir, m, (e.armored ? 0.4 : 1) * Math.min(1.8, e.attacker.scale / e.defender.scale));
        if ((e.knockdown || e.ko) && !this.simLaunches) {
          // DS's presentation-computed throw, until the sim's own `launch` events arrive (P08's slab, P33's follow).
          const k = Math.min(2.2, e.push);
          rd.launch(e.dir.clone().multiplyScalar((m.knockback * 0.9 + (e.ko ? 1 : 0)) * k).add(new Vector3(0, 1.2 + (m.lift ?? 0) * 3, 0)));
        }
        if (e.sever) rd.sever(e.sever, limbBones(e.sever), e.dir.clone().multiplyScalar(2.6).add(new Vector3(0, e.sever === 'head' ? 3.2 : 2.2, 0)));
        return;
      }
      case 'block':
        this.ragdolls.get(e.defender)?.applyBlock(e.dir, e.move);
        return;
      case 'respawn':
        // TODO(P33): the respawned body's ragdoll from the sim's state (the slab handed back, §4.5).
        this.snapTo(e.f);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    for (const rd of this.ragdolls.values()) rd.dispose();
    this.ragdolls.clear();
    this.rapier.free();
  }

  /**
   * DS: a body going down can fall against someone still standing but can't rest on them; it slides off to the floor.
   * (Presentation only now: nothing flows back into the sim.)
   */
  private slideOff(f: Fighter, rd: Ragdoll, fighters: readonly Fighter[]): void {
    if (f.state !== 'knockdown' && f.state !== 'ko') return;
    for (const s of fighters) {
      if (s === f || !s.alive || s.state === 'knockdown' || s.state === 'ko') continue;
      for (const b of TORSO) {
        const body = rd.bodies[b];
        const v = body.linvel();
        if (v.y > 0.3) continue;
        const t = body.translation();
        if (t.y - s.pos.y < 0.35 * f.scale) continue;
        const dx = t.x - s.pos.x;
        const dz = t.z - s.pos.z;
        const d = Math.hypot(dx, dz);
        const reach = 0.42 * s.scale + 0.2 * f.scale;
        if (d > reach) continue;
        const k = (reach - d) * 6;
        const nx = d > 1e-3 ? dx / d : 1;
        const nz = d > 1e-3 ? dz / d : 0;
        body.setLinvel({ x: v.x + nx * k * DT * 30, y: Math.min(v.y, 0), z: v.z + nz * k * DT * 30 }, true);
      }
    }
  }
}

/**
 * Blood, gibs and particles (render/blood.ts, gibs.ts, particles.ts) and DS's face blood (game/trauma.ts): the effects an
 * event throws, and each frame the drips from faces, wounds and weapons, a fresh stump's spurts and the sweat sheen. It
 * finds the bodies as drawn through the views (FighterViewPort's points). Presentation only: Math.random and the
 * client's own Rng never touch the sim (rule 7).
 */
export class Fx implements FxPort {
  readonly blood: Blood;
  readonly gibs: Gibs;
  readonly effects: Effects;
  /** Accumulated facial damage per fighter (DS game/trauma.ts). */
  private readonly trauma = new Map<Fighter, Trauma>();
  /** How sweaty each fighter has got (0..1, DS). */
  private readonly sweat = new Map<Fighter, number>();
  /** The client's own stream for face drips (DS fxRng): never the sim's. */
  private readonly fxRng = new Rng(99);

  constructor(
    scene: Scene,
    private readonly views: WorldViewsPort,
    /** The bodies as drawn (TODO(P33): body-fall dust at the ragdoll's pelvis on the sim's `land` events). */
    readonly presentation: PresentationPort,
    /** DS's game-style cues (prefs.cues). */
    private readonly cues: () => boolean,
    private readonly player: () => Fighter | null,
  ) {
    this.blood = new Blood(scene);
    this.gibs = new Gibs(scene);
    this.effects = new Effects(scene);
  }

  handle(e: SimEvent, _world: World): void {
    const me = this.player();
    switch (e.type) {
      case 'hit': {
        const heavy = e.move.weight === 'heavy';
        const view = this.views.fighterView(e.defender);
        if (this.cues()) {
          const col = e.armored ? '#ff9a3c' : e.counter ? '#ffd36b' : '#fff0c8';
          this.effects.flash(e.point, heavy ? 0.42 : 0.26, e.counter ? '#ffd36b' : '#fff3d6');
          this.effects.sparks(e.point, e.dir, heavy ? 22 : 12, col, heavy ? 6.5 : 4.5);
        } else if (!e.weapon || e.weapon.edge === 'blunt') {
          // Real impacts don't spark: sweat flies off a face or body that gets hit.
          const head = e.zone === 'head';
          const wet = 0.4 + (this.sweat.get(e.defender) ?? 0) * 1.2;
          this.effects.sparks(e.point, e.dir.clone().setY(head ? 0.35 : 0.1), Math.round((head ? 10 : 5) * (heavy ? 1.6 : 1) * wet), '#dbe6ee', head ? 2.6 : 1.6, 0.016);
        }
        this.bleed(e.defender, view, e);
        if (e.weapon?.edge === 'blade') this.blood.spray(e.point, e.dir.clone().setY(0.25), 0.5 + (e.wound?.bleed ?? 0.3) * 1.2, 3);
        if (e.sever) {
          for (let i = 0; i < 4; i++) this.blood.spray(e.point, e.dir.clone().setY(0.6 + i * 0.2), 1, 3.4);
        } else if (e.fatal) {
          const top = view ? view.facePoint('brow') : e.point.clone();
          for (let i = 0; i < 5; i++) this.blood.spray(top, e.dir.clone().setY(1 + i * 0.25), 1, e.fatal === 'split' ? 2.6 : 3.2);
        }
        if (e.tear && this.blood.enabled) {
          this.gibs.spawn(e.tear.point, e.tear.vel, e.tear.size, view?.skin ?? '#d9a07a', e.tear.piece);
          this.blood.spray(e.tear.point, e.tear.vel.clone(), 0.8, 2.2);
        }
        return;
      }
      case 'block':
        if (this.cues()) {
          this.effects.sparks(e.point, e.dir, e.guardBreak ? 18 : 8, '#8fd0ff', 3.5, 0.03);
          this.effects.flash(e.point, 0.2, '#9fd8ff');
        } else this.effects.sparks(e.point, e.dir, e.guardBreak ? 8 : 4, '#dbe6ee', 1.5, 0.014);
        // Timed to the last instant: a gold ring round whoever parried (DS).
        if (e.parry && e.perfect) this.effects.ring(e.defender.pos, 1.1, '#ffd36b', 0.5, () => e.defender.pos);
        return;
      case 'dodge':
        if (e.defender === me && e.perfect) this.effects.ring(e.defender.pos, 1.1, '#ffd36b', 0.5, () => e.defender.pos);
        if (e.defender === me && e.kind !== 'airborne' && this.cues()) this.effects.ring(e.defender.pos, 0.9, '#ffd36b', 0.45, () => e.defender.pos);
        return;
      case 'defend':
        if (e.kind === 'slide') this.effects.dust(e.f.pos, 10, 0.4);
        return;
      case 'swing':
        if (e.move.id === 'slideKick' || e.move.id === 'flyingKick') this.effects.dust(e.f.pos, 8, 0.4);
        return;
      case 'getup':
        this.effects.dust(e.f.pos, 10, 0.5 * e.f.scale);
        return;
      case 'thud': {
        const hard = Math.min(1, e.speed / 12);
        this.effects.dust(e.point, Math.round(2 + 4 * hard), 0.06 + 0.04 * e.projectile.weapon.mass);
        return;
      }
      case 'clang': {
        const away = new Vector3(e.f.pos.x - e.point.x, 0.4, e.f.pos.z - e.point.z).normalize();
        this.effects.sparks(e.point, away, e.metal ? 10 : 6, e.metal ? '#ffd27a' : '#8a6a48', e.metal ? 3.2 : 1.4, e.metal ? 0.012 : 0.02);
        return;
      }
      case 'land':
        // TODO(P33): dust where a body or a log landed, ∝ its mass (SPEC:581; DS bodyLanding: 6 + 10·hard·min(3, mass)
        // puffs over 0.25·scale m at the ragdoll's pelvis), and DS's jump landings (both feet, 6 puffs over 0.3·scale m;
        // DS detected them per step from f.isAirborne()).
        return;
      case 'respawn':
        // Patched up (DS resetPlayer): the face and the sweat start again (the views reset their own looks).
        this.trauma.delete(e.f);
        this.sweat.delete(e.f);
        return;
      default:
        return;
    }
  }

  update(gameDt: number, realDt: number, world: World): void {
    this.effects.update(gameDt, realDt);
    // (In a freeze-frame the blood still creeps outward — barely — so a spray is a fan of drops, not one clump.)
    this.blood.update(Math.max(gameDt, realDt * 0.1));
    this.gibs.update(gameDt, (at, speed) => this.blood.spray(at, new Vector3(0, 1, 0), Math.min(0.4, speed * 0.08), 0.6));
    // Drips, spurts and sweat move with game time: none in a pause or a hit-pause (DS).
    if (gameDt <= 0) return;
    for (const f of world.combat.fighters) {
      const view = this.views.fighterView(f);
      if (!view) continue;
      // Sweat builds with time and exertion.
      const s = Math.min(1, (this.sweat.get(f) ?? 0) + gameDt * (0.006 + 0.035 * (1 - f.stamina)));
      this.sweat.set(f, s);
      view.setSweat(s);
      if (!this.blood.enabled) continue;
      const t = this.trauma.get(f);
      if (t?.drip(gameDt, this.fxRng)) this.blood.drip(view.facePoint(t.cut && Math.random() < 0.4 ? 'brow' : 'mouth'));
      // A bloodied blade drips for a while.
      if (f.weapon && view.weaponBlood > 0.08) {
        view.weaponBlood *= 0.999;
        if (Math.random() < view.weaponBlood * gameDt * 5) {
          const tip = view.weaponTip(f);
          if (tip) this.blood.drip(tip);
        }
      }
      for (const w of f.wounds) {
        if (w.bleed <= 0.02) continue;
        if (w.stump && w.bleed > 0.45 && Math.random() < 0.6) {
          // Arterial spurts from a fresh stump.
          const at = view.woundPoint(w);
          const out = at.clone().sub(view.chest()).setY(0).normalize().setY(w.stump === 'head' ? 1.4 : 0.5);
          this.blood.spray(at, out, 0.18 * w.bleed, 1.6 + Math.random());
        } else if (Math.random() < w.bleed * gameDt * 6) {
          this.blood.drip(view.woundPoint(w));
        }
      }
    }
  }

  /** TODO(M5, rule 12): 'stylised'. M1 draws blood unless gore is off. */
  setGore(level: GoreLevel): void {
    const on = level !== 'off';
    if (this.blood.enabled && !on) this.clear();
    this.blood.enabled = on;
  }

  clear(): void {
    this.blood.clear();
    this.gibs.clear();
  }

  /** DS bleed(): accumulated facial damage spills blood from the mouth, nose or a cut brow. */
  private bleed(f: Fighter, view: FighterViewPort | null, e: Extract<SimEvent, { type: 'hit' }>): void {
    let t = this.trauma.get(f);
    if (!t) this.trauma.set(f, (t = new Trauma()));
    for (const b of t.onHit(e.zone, e.move, e.damage, e.counter)) {
      if (!view) break;
      // Along the blow and up; a cough spills forward (toward the attacker) and down.
      const d = b.style === 'hit' ? e.dir.clone().setY(0.35) : e.dir.clone().negate().setY(-0.4);
      this.blood.spray(view.facePoint(b.source), d, b.amount * f.scale, b.style === 'hit' ? 2.8 : 1.4);
    }
    view?.setTrauma(t.bruise, t.cut);
  }
}
