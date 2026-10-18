// The world on screen behind WorldViewsPort (docs/M1-DESIGN.md §10.1, §10.4): the sky, the terrain, the trees, the
// entities, the ropes and the grass, and one FighterView (render/fighterView.ts, changed DS) per fighter behind the
// FighterViewPort adapter. The adapter file P32 changes, so game.ts never has to (RF-9).
//
// Each frame, in this order (each view draws from what the ones before it placed):
//   sky (the sun's shadow over the player) → terrain → fighters (from the ragdoll, else the rig; species looks, held
//   things, wounds, ruler scars) → trees → entities (held ones at the drawn hand, stowed ones at the drawn belt and back)
//   → ropes (ends on entities as drawn, held ends at the drawn fist) → drag links (a dragging hand to its grip) → grass.
// Every view reads the sim's state and writes nothing back (rule 6). Rule 3 is the point of all of it: every material
// state a rule depends on is drawn (see each view's header).
import { CylinderGeometry, type Group, Matrix4, Mesh, type MeshStandardMaterial, type Object3D, Quaternion, type Scene, Vector3 } from 'three';
import {
  BONES,
  type Entity,
  type Fighter,
  FIST_OFFSET,
  principalAxis,
  SKELETON,
  type World,
  type WoundRecord,
  type Wound,
} from '@wild/sim';
import type { BodyPose, FighterViewPort, GoreLevel, SimEvent, ViewFrame, WorldViewsPort } from '../game/ports';
import { type CarrySlot, EntityViews, flatMaterial, poseMatrix, stowedMatrix } from './entityViews';
import { FighterView, type ScarKind } from './fighterView';
import { ForestView } from './forestView';
import { GrassView } from './grassView';
import { lookForSpecies } from './looks';
import { RopeViews } from './ropeView';
import { Sky } from './sky';
import { RENDER_TUNING, TerrainView } from './terrainView';

/** Where a held or stowed entity is, and whose. */
interface Hold {
  f: Fighter;
  v: FighterViewAdapter;
  slot: 'hand' | CarrySlot;
}

const _a = new Matrix4();
const _b = new Matrix4();
const _v = new Vector3();
const _w = new Vector3();
const _q = new Quaternion();
const _yAxis = new Vector3(0, 1, 0);

/**
 * The link drawn from a dragging fighter's drawn fist to the grip it pulls by (rule 3: the sim tethers the hands to the
 * grip, VERB_TUNING.tetherM; without the link the dragged thing seems to follow on its own). RENDER_TUNING.drag.
 */
export class DragLinks {
  private readonly links = new Map<Fighter, Mesh>();
  private readonly material: MeshStandardMaterial = flatMaterial({ roughness: RENDER_TUNING.drag.linkRoughness });
  private geo: CylinderGeometry | null = null;
  private sides = 0;

  constructor(private readonly scene: Scene) {}

  /** The link of `f`, if one is drawn (tests). */
  linkOf(f: Fighter): Mesh | null {
    const m = this.links.get(f);
    return m && m.visible ? m : null;
  }

  /** Draws a link from `from` to `to` for `f`, or hides it (null). */
  set(f: Fighter, from: Vector3 | null, to: Vector3 | null): void {
    let m = this.links.get(f);
    if (!from || !to) {
      if (m) m.visible = false;
      return;
    }
    const D = RENDER_TUNING.drag;
    if (!this.geo || this.sides !== D.linkSides) {
      this.sides = D.linkSides;
      const old = this.geo;
      // A unit-length cord along +y from its foot (scaled to the hand-grip distance).
      this.geo = new CylinderGeometry(1, 1, 1, Math.max(3, Math.round(D.linkSides)), 1).translate(0, 0.5, 0);
      for (const l of this.links.values()) l.geometry = this.geo;
      old?.dispose();
    }
    if (!m) {
      m = new Mesh(this.geo, this.material);
      m.name = 'drag link';
      m.castShadow = true;
      this.scene.add(m);
      this.links.set(f, m);
    }
    this.material.color.set(D.linkColor);
    this.material.roughness = D.linkRoughness;
    const len = _w.subVectors(to, from).length();
    m.visible = len > 1e-4;
    if (!m.visible) return;
    _q.setFromUnitVectors(_yAxis, _w.divideScalar(len));
    const r = D.linkRadiusM * f.scale;
    m.position.copy(from);
    m.quaternion.copy(_q);
    m.scale.set(r, len, r);
  }

  /** Drops the links of fighters no longer in `keep`. */
  prune(keep: (f: Fighter) => boolean): void {
    for (const [f, m] of this.links) {
      if (keep(f)) continue;
      this.scene.remove(m);
      this.links.delete(f);
    }
  }

  dispose(): void {
    for (const m of this.links.values()) this.scene.remove(m);
    this.links.clear();
    this.geo?.dispose();
    this.material.dispose();
  }
}

export class WorldViews implements WorldViewsPort {
  readonly sky: Sky;
  readonly terrain: TerrainView;
  readonly forest: ForestView;
  readonly entities: EntityViews;
  readonly ropes: RopeViews;
  readonly grass: GrassView;
  readonly dragLinks: DragLinks;
  private readonly fighters = new Map<Fighter, FighterViewAdapter>();
  private cues = false;
  private gore: GoreLevel = 'full';
  /** The world last synced (the held tools' tips). */
  private world: World | null = null;
  /** Blood a world impact left on the entity that struck (a stake that wounded, a thrown spear): 0..1 by entity id. */
  private readonly struck = new Map<number, number>();

  constructor(
    private readonly scene: Scene,
    world: World,
  ) {
    this.sky = new Sky(scene);
    this.terrain = new TerrainView(scene, world, world.player?.pos);
    this.forest = new ForestView(scene);
    this.entities = new EntityViews(scene);
    this.ropes = new RopeViews(scene);
    this.grass = new GrassView(scene);
    this.dragLinks = new DragLinks(scene);
  }

  sync(world: World, alpha: number, cam: Vector3, frame: ViewFrame): void {
    this.world = world;
    this.cues = frame.cues;
    if (frame.gore !== this.gore) {
      this.gore = frame.gore;
      for (const v of this.fighters.values()) v.setGore(frame.gore);
    }
    const player = world.player;
    this.sky.sync(world, player ? _v.set(player.pos.x, player.pos.y, player.pos.z) : cam);
    this.terrain.sync(world, cam);
    this.syncFighters(world, alpha, frame);

    const all = world.entities.all();
    const ground = (x: number, z: number) => world.terrain.heightAt(x, z);
    this.forest.sync(all, { alpha, dt: frame.gameDt, ground });
    const holds = this.holds(world);
    this.entities.sync(all, {
      alpha,
      // The Clearing's boundary walls (look 'boundary', 60 m tall just outside the terrain) keep things in the world;
      // the valley rim is the visible edge, so they aren't drawn (the presentation world still mirrors them).
      skip: (e) => this.forest.owns(e) || e.look === 'boundary',
      placed: (e) => this.placed(e, holds),
      blood: (e) => {
        if (this.gore === 'off') return 0;
        const h = holds.get(e.id);
        return Math.max(h && h.slot === 'hand' ? h.v.weaponBlood : 0, this.struck.get(e.id) ?? 0);
      },
      capacity: (e) => capacityOf(world, e),
    });
    const byId = new Map<number, FighterViewAdapter>();
    for (const [f, v] of this.fighters) byId.set(f.id, v);
    this.ropes.sync(world, {
      matrixOf: (id) => this.entities.matrixOf(id) ?? this.forest.matrixOf(id),
      handOf: (id) => byId.get(id)?.fist() ?? null,
    });
    this.syncDragLinks(world);
    this.grass.sync(world, player ? player.pos : cam);
    for (const id of this.struck.keys()) if (!world.entities.get(id)) this.struck.delete(id);
  }

  fighterView(f: Fighter): FighterViewAdapter | null {
    return this.fighters.get(f) ?? null;
  }

  /**
   * The views' own reactions to an event: DS's (blood on what hit, a hit flash, a torn piece, a skull blow), a chop's,
   * and blood on the entity a world impact wounded with (rule 12: none with gore off).
   */
  handle(e: SimEvent, _world: World): void {
    if (e.type === 'chop') {
      this.forest.handle(e);
      return;
    }
    if (e.type === 'impact') {
      const id = e.cause.entityId;
      const E = RENDER_TUNING.entities;
      if (id !== null && e.damage > 0 && this.gore !== 'off') this.struck.set(id, Math.min(1, (this.struck.get(id) ?? 0) + E.bloodPerImpact + e.damage / E.bloodDamagePer));
      return;
    }
    if (e.type === 'respawn') {
      // DS resetPlayer: patched up and clean (wounds, gloves, sweat, bruising, the blood on what was in hand). What the
      // sim keeps of the body after its own reset (rule 9) is drawn again from its state on the next frame.
      this.fighters.get(e.f)?.reset();
      return;
    }
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
    this.dragLinks.dispose();
  }

  // -------------------------------------------------------------------------

  /** A dragging fighter's link: from its drawn fist to the grip (entity frame) on the entity as drawn. */
  private syncDragLinks(world: World): void {
    this.dragLinks.prune((f) => this.fighters.has(f));
    for (const [f, v] of this.fighters) {
      const h = f.inventory?.hands ?? null;
      const m = h && h.mode === 'drag' ? (this.entities.matrixOf(h.entity) ?? this.forest.matrixOf(h.entity)) : null;
      if (!h || !m || !world.entities.get(h.entity)) {
        this.dragLinks.set(f, null, null);
        continue;
      }
      const grip = _v.set(h.grip.x, h.grip.y, h.grip.z).applyMatrix4(m);
      this.dragLinks.set(f, v.fist(), grip);
    }
  }

  private syncFighters(world: World, alpha: number, frame: ViewFrame): void {
    const fighters = world.combat.fighters;
    for (const [f, v] of this.fighters) {
      if (fighters.includes(f)) continue;
      this.scene.remove(v.view.root);
      this.fighters.delete(f);
    }
    for (const f of fighters) {
      let v = this.fighters.get(f);
      if (!v) {
        const view = new FighterView(lookForSpecies(f.species, f.playerId !== null).palette);
        view.gore = this.gore;
        this.scene.add(view.root);
        v = new FighterViewAdapter(view, (id) => this.heldTip(id));
        this.fighters.set(f, v);
      }
      v.setScale(f.scale);
      const pose = frame.poseOf(f);
      if (pose) v.syncFromPose(pose, alpha);
      else v.syncFromRig(f);
      v.frame(f, frame, world);
    }
  }

  /** Every held and stowed entity, and whose hand, belt slot or back it is in. */
  private holds(world: World): Map<number, Hold> {
    const out = new Map<number, Hold>();
    for (const [f, v] of this.fighters) {
      const inv = f.inventory;
      if (!inv) continue;
      if (inv.hands && (inv.hands.mode === 'wield' || inv.hands.mode === 'carry')) out.set(inv.hands.entity, { f, v, slot: 'hand' });
      inv.belt.forEach((id, i) => {
        if (id !== null) out.set(id, { f, v, slot: i as CarrySlot });
      });
      if (inv.back !== null) out.set(inv.back, { f, v, slot: 3 });
    }
    // A held thing's other parts (an axe head lashed to its handle, P14): held too, carried by the nearest hand.
    for (const e of world.entities.all()) {
      if (e.state !== 'held' || out.has(e.id)) continue;
      let best: Hold | null = null;
      let bestD = Infinity;
      for (const h of out.values()) {
        if (h.slot !== 'hand') continue;
        const r = h.f.rig.foreArmR.pos;
        const d = Math.hypot(e.pose.p.x - r.x, e.pose.p.y - r.y, e.pose.p.z - r.z);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      if (best) out.set(e.id, best);
    }
    return out;
  }

  /**
   * Where a held or stowed entity is drawn: in a hand, its record pose (the sim's hand frame, phase 4b) carried from the
   * sim's forearm to the drawn one (a ragdoll's arm lags the rig a little); on the belt or back, hung from the drawn
   * pelvis or chest. Null: drawn at its record pose.
   */
  private placed(e: Entity, holds: Map<number, Hold>): Matrix4 | null {
    const h = holds.get(e.id);
    if (!h) return null;
    const bones = h.v.view.bones;
    if (h.slot === 'hand') {
      const rig = h.f.rig.foreArmR;
      const drawn = bones.foreArmR;
      _a.compose(drawn.position, drawn.quaternion, ONE);
      _b.compose(_v.set(rig.pos.x, rig.pos.y, rig.pos.z), rig.rot, ONE).invert();
      return new Matrix4().multiplyMatrices(_a, _b).multiply(poseMatrix(e.pose));
    }
    const bone = h.slot === 3 ? bones.chest : bones.pelvis;
    _a.compose(bone.position, bone.quaternion, ONE);
    return stowedMatrix(e, h.slot, _a, h.f.scale, new Matrix4());
  }

  /** The far end of a held tool as drawn (its sharp point, else the end of its long axis away from the grip). */
  private heldTip(id: number): Vector3 | null {
    const m = this.entities.matrixOf(id);
    const e = this.world?.entities.get(id);
    if (!m || !e) return null;
    if (e.sharpPoints.length > 0) {
      const sp = e.sharpPoints[0].local;
      return new Vector3(sp.x, sp.y, sp.z).applyMatrix4(m);
    }
    const ax = principalAxis(e.shape);
    const end = new Vector3(ax.dir.x, ax.dir.y, ax.dir.z).multiplyScalar(ax.max).applyMatrix4(m);
    const start = new Vector3(ax.dir.x, ax.dir.y, ax.dir.z).multiplyScalar(ax.min).applyMatrix4(m);
    // The end farther from the drawn hand that holds it.
    const holder = [...this.fighters.values()].find((v) => v.held === id);
    const fist = holder?.fist();
    if (fist && fist.distanceTo(start) > fist.distanceTo(end)) return start;
    return end;
  }
}

const ONE = new Vector3(1, 1, 1);

/** The entity's load capacity (N), or null when nothing is loading it or the sim can't say yet (P10's loads). */
function capacityOf(world: World, e: Entity): number | null {
  let any = false;
  for (const v of e.loadHist) {
    if (v > 0) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  // (No catch: P10's loads are in, and an error from them is a real one. A material with no break energy, a rope, has
  // an infinite capacity: nothing to show.)
  const cap = world.loads.capacityN(e);
  return Number.isFinite(cap) ? cap : null;
}

/** A ruler wound's mark: a missing eye for a severe eye wound, an open gash until it heals, then a scar (SPEC:845). */
export function scarKindOf(w: WoundRecord): ScarKind {
  if (w.zone === 'eyes' && w.severe) return 'eye';
  return w.remaining > 0 ? 'gash' : 'scar';
}

/** The DS FighterView behind FighterViewPort. */
export class FighterViewAdapter implements FighterViewPort {
  private shown = new WeakSet<Wound>();
  /** Ruler wound id → its mark as drawn. */
  private readonly scars = new Map<number, { kind: ScarKind; mark: Group }>();
  /** The entity in hand (drawn by the entity views at this fighter's drawn hand), or null. */
  held: number | null = null;
  private scale = 1;

  constructor(
    readonly view: FighterView,
    private readonly tipOf: (entity: number) => Vector3 | null = () => null,
  ) {}

  get weaponBlood(): number {
    return this.view.weaponBlood;
  }

  set weaponBlood(v: number) {
    this.view.weaponBlood = v;
  }

  get skin(): string {
    return this.view.palette.skin;
  }

  /** How many ruler wounds are drawn (tests). */
  get scarCount(): number {
    return this.scars.size;
  }

  facePoint(where: 'mouth' | 'nose' | 'brow', out = new Vector3()): Vector3 {
    return this.view.facePoint(where, out);
  }

  woundPoint(w: Wound, out = new Vector3()): Vector3 {
    return this.view.woundPoint(w, out);
  }

  weaponTip(f: Fighter, out = new Vector3()): Vector3 | null {
    if (this.held !== null) {
      const tip = this.tipOf(this.held);
      return tip ? out.copy(tip) : null;
    }
    return f.weapon ? this.view.weaponTip(f.weapon.length, f.scale, out) : null;
  }

  chest(out = new Vector3()): Vector3 {
    return this.view.bones.chest.getWorldPosition(out);
  }

  /** The drawn right fist (world): where a held rope end is. */
  fist(out = new Vector3()): Vector3 {
    const b = this.view.bones.foreArmR;
    b.updateMatrixWorld();
    return b.localToWorld(out.set(0, -(SKELETON.foreArmR.length + FIST_OFFSET), 0));
  }

  setSweat(s: number): void {
    this.view.setSweat(s);
  }

  setTrauma(bruise: number, cut: boolean): void {
    this.view.setTrauma(bruise, cut);
  }

  reset(): void {
    const v = this.view;
    v.clearWounds();
    v.clean();
    v.setTrauma(0, false);
    v.weaponBlood = 0;
    this.shown = new WeakSet<Wound>();
  }

  setScale(s: number): void {
    if (s === this.scale) return;
    this.scale = s;
    this.view.setScale(s);
  }

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

  /**
   * The entity in hand, drawn from the entity itself (tools drawn from their entities, §10.11, §5.2): the DS weapon
   * model goes, and the entity views draw the entity at this fighter's drawn hand. A new thing in hand starts clean.
   */
  setHeld(entity: number | null, _world: World): void {
    if (entity === this.held) return;
    this.held = entity;
    this.view.weaponBlood = 0;
    if (entity !== null) this.view.setWeapon(null);
  }

  /** Rule 12: the gore level every gore-bearing visual reads; what is drawn already is drawn again at the new level. */
  setGore(level: GoreLevel): void {
    if (this.view.gore === level) return;
    this.view.gore = level;
    this.view.clearWounds();
    this.shown = new WeakSet<Wound>();
    for (const s of this.scars.values()) this.view.removeMark(s.mark);
    this.scars.clear();
  }

  setShiver(amount: number): void {
    // (Presentation only: Math.random never touches the sim, rule 7.)
    if (amount <= 0) this.view.shiver.set(0, 0, 0);
    else this.view.shiver.set((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount * 0.5, (Math.random() - 0.5) * amount);
  }

  /** Per rendered frame: what is in hand, new wounds, ruler scars, eyes and cues. */
  frame(f: Fighter, frame: ViewFrame, world: World): void {
    const v = this.view;
    const hands = f.inventory?.hands ?? null;
    this.setHeld(hands && (hands.mode === 'wield' || hands.mode === 'carry') ? hands.entity : null, world);
    if (this.held === null) {
      // A DS weapon with no entity behind it (the legacy roster) keeps its DS model.
      v.setWeapon(f.isSevered('foreArmR') ? null : f.weapon);
      if (f.weapon) v.updateWeapon(f, f.weapon.length, frame.gameDt);
    }
    for (const w of f.wounds) {
      if (this.shown.has(w)) continue;
      this.shown.add(w);
      v.addWound(w);
    }
    this.syncScars(f);
    v.updateCues(frame.realDt, f, frame.cues);
  }

  /** A mark per ruler wound, redrawn when its kind changes (a gash heals into a scar); a wound gone takes its mark. */
  private syncScars(f: Fighter): void {
    const wounds = f.ruler?.wounds ?? EMPTY;
    if (wounds.length === 0 && this.scars.size === 0) return;
    const live = new Set<number>();
    for (const w of wounds) {
      live.add(w.id);
      const kind = scarKindOf(w);
      const cur = this.scars.get(w.id);
      if (cur && cur.kind === kind) continue;
      if (cur) this.view.removeMark(cur.mark);
      const size = w.severe ? RENDER_TUNING.wounds.severeMul : 1;
      this.scars.set(w.id, { kind, mark: this.view.scar(w.bone, [w.local.x, w.local.y, w.local.z], kind, size) });
    }
    for (const [id, s] of this.scars) {
      if (live.has(id)) continue;
      this.view.removeMark(s.mark);
      this.scars.delete(id);
    }
  }
}

const EMPTY: readonly WoundRecord[] = [];

/**
 * The draw calls a scene makes before shadows (§10.4's budget): every visible mesh with something to draw, an instanced
 * mesh counting once (and not at all with no instances), a mesh with several materials once per material.
 */
export function drawCallCount(root: Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    if (!(o instanceof Mesh)) return;
    const count = (o as Mesh & { count?: number; isInstancedMesh?: boolean }).isInstancedMesh ? (o as unknown as { count: number }).count : 1;
    if (count <= 0) return;
    n += Array.isArray(o.material) ? o.material.length : 1;
  });
  return n;
}
