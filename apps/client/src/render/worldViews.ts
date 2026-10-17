// The world on screen behind WorldViewsPort (docs/M1-DESIGN.md §10.1, §10.4): the sky, terrain, trees, entities, ropes and
// grass views, and one FighterView (render/fighterView.ts, changed DS) per fighter behind the FighterViewPort adapter.
// The adapter file P32 changes, so game.ts never has to (RF-9).
//
// STUB (P31; P32 fills it): DungeonStyle's fighter views (drawn from the ragdoll, else from the rig; the weapon in hand,
// new wounds, blinks, hit flashes, torn ears, split skulls), the terrain tiles and the sky. P32: species palettes and
// scale, held entities, scars, trees, entities, ropes, grass.
import type { Scene, Vector3 } from 'three';
import { BONES, type BoneName, type Fighter, type V3, type World, type Wound } from '@wild/sim';
import type { BodyPose, FighterViewPort, GoreLevel, SimEvent, ViewFrame, WorldViewsPort } from '../game/ports';
import { EntityViews } from './entityViews';
import { BRAWLER_PALETTE, FighterView, PLAYER_PALETTE } from './fighterView';
import { ForestView } from './forestView';
import { GrassView } from './grassView';
import { RopeViews } from './ropeView';
import { Sky } from './sky';
import { TerrainView } from './terrainView';

export class WorldViews implements WorldViewsPort {
  readonly sky: Sky;
  readonly terrain: TerrainView;
  readonly forest: ForestView;
  readonly entities: EntityViews;
  readonly ropes: RopeViews;
  readonly grass: GrassView;
  private readonly fighters = new Map<Fighter, FighterViewAdapter>();
  private cues = false;

  constructor(
    private readonly scene: Scene,
    world: World,
  ) {
    this.sky = new Sky(scene);
    this.terrain = new TerrainView(scene, world);
    this.forest = new ForestView(scene);
    this.entities = new EntityViews(scene);
    this.ropes = new RopeViews(scene);
    this.grass = new GrassView(scene);
  }

  sync(world: World, alpha: number, cam: Vector3, frame: ViewFrame): void {
    this.cues = frame.cues;
    this.sky.sync(world, world.player?.pos ?? cam);
    this.terrain.sync(world, cam);
    this.forest.sync(world, alpha, cam);
    this.entities.sync(world, alpha, cam);
    this.ropes.sync(world, alpha, cam);
    this.grass.sync(world, cam);

    const fighters = world.combat.fighters;
    for (const [f, v] of this.fighters) {
      if (fighters.includes(f)) continue;
      this.scene.remove(v.view.root);
      this.fighters.delete(f);
    }
    for (const f of fighters) {
      let v = this.fighters.get(f);
      if (!v) {
        // TODO(P32): species palettes (`lookForSpecies`: the ape's dark fur and snout, the giant's silver back).
        const view = new FighterView(f.playerId !== null ? PLAYER_PALETTE : BRAWLER_PALETTE);
        view.setScale(f.scale);
        this.scene.add(view.root);
        v = new FighterViewAdapter(view);
        this.fighters.set(f, v);
      }
      const pose = frame.poseOf(f);
      if (pose) v.syncFromPose(pose, alpha);
      else v.syncFromRig(f);
      v.frame(f, frame);
    }
  }

  fighterView(f: Fighter): FighterViewPort | null {
    return this.fighters.get(f) ?? null;
  }

  /** DS's view reactions (game.ts handleEvent): blood on what hit, a hit flash, a torn piece, a skull blow. */
  handle(e: SimEvent, _world: World): void {
    if (e.type !== 'hit') return;
    const m = e.move;
    const av = this.fighters.get(e.attacker)?.view;
    const dv = this.fighters.get(e.defender)?.view;
    const bleeding = e.defender.wounds.length > 0;
    if (av && e.weapon) av.bloodyWeapon(e.weapon.edge === 'blade' ? 0.35 : e.zone === 'head' && bleeding ? 0.12 : 0);
    else if (av && !m.weapon && bleeding && e.zone === 'head' && (m.limb === 'handL' || m.limb === 'handR')) av.bloodyFist(m.limb === 'handL' ? 'L' : 'R', 0.08);
    if (!dv) return;
    if (this.cues) dv.hitFlash();
    if (e.tear) dv.tear(e.tear.piece, e.tear.bone, e.tear.local, e.tear.size / e.defender.scale);
    if (!e.sever && e.fatal === 'split') dv.splitHead();
    else if (!e.sever && e.fatal === 'cleft') dv.cleftHead();
    else if (!e.sever && e.fatal === 'crush') dv.crushHead();
  }

  dispose(): void {
    for (const v of this.fighters.values()) this.scene.remove(v.view.root);
    this.fighters.clear();
    this.sky.dispose();
    this.terrain.dispose();
    this.forest.dispose();
    this.entities.dispose();
    this.ropes.dispose();
    this.grass.dispose();
  }
}

/** The DS FighterView behind FighterViewPort. */
export class FighterViewAdapter implements FighterViewPort {
  private readonly shown = new WeakSet<Wound>();

  constructor(readonly view: FighterView) {}

  syncFromRig(f: Fighter): void {
    this.view.syncFromRig(f);
  }

  /** The body as the presentation world has it, interpolated between its last two steps (DS syncFromRagdoll). */
  syncFromPose(pose: BodyPose, alpha: number): void {
    const v = this.view;
    for (const b of BONES) {
      const g = v.bones[b];
      g.position.lerpVectors(pose.prev[b].p, pose.cur[b].p, alpha).add(v.shiver);
      g.quaternion.slerpQuaternions(pose.prev[b].q, pose.cur[b].q, alpha);
    }
  }

  /** TODO(P32): the held entity drawn at the hand (tools from their entities, §10.11). */
  setHeld(_entity: number | null, _world: World): void {}

  /** TODO(P32): a ruler's wound drawn where it is (SPEC:845). */
  scar(_bone: BoneName, _local: V3, _kind: 'scar' | 'gash' | 'eye'): void {}

  /** TODO(P32): every new gore-bearing visual reads the one gore level (rule 12). */
  setGore(_level: GoreLevel): void {}

  setShiver(amount: number): void {
    // (Presentation only: Math.random never touches the sim, rule 7.)
    if (amount <= 0) this.view.shiver.set(0, 0, 0);
    else this.view.shiver.set((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount * 0.5, (Math.random() - 0.5) * amount);
  }

  /** Per rendered frame (DS game.ts render): the weapon in hand, new wounds, eyes and cues. */
  frame(f: Fighter, frame: ViewFrame): void {
    const v = this.view;
    v.setWeapon(f.isSevered('foreArmR') ? null : f.weapon);
    if (f.weapon) v.updateWeapon(f, f.weapon.length, frame.gameDt);
    for (const w of f.wounds) {
      if (this.shown.has(w)) continue;
      this.shown.add(w);
      v.addWound(w);
    }
    v.updateCues(frame.realDt, f, frame.cues);
  }
}
