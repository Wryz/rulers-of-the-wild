// Developer mode's world views (docs/M1-DESIGN.md §10.10: "Toggles: hitboxes (H), nav polys (human/ruler), senses
// (cones, hearing rings), zones"), drawn when the panel's GAME_TUNING toggles ask for them. The hitboxes stay game.ts's
// own (DS); these three are here, loaded with the panel, so none of it ships in the player's bundle.
//
// - Nav polys (showNav): both navmesh layers as translucent triangles with their edges, a little over the ground, the
//   human layer and the ruler's in their own colours; rebuilt only when a layer's tile versions change (a dig, a
//   placed log), since reading the navmesh makes a binding call per vertex (NavSystem.debugGeometry).
// - Senses (showSenses): each creature's sight cone from its eyes along its facing, the outer arc at sightRangeM and the
//   inner at sightRangeStillM (§6.2); and a ring at every noise for noiseRingS, its radius the noise's (a listener hears
//   it within radius × its hearingMul).
// - Zones (showZones): every fighter's 12 bone hit zones as the sim shapes them (boneZoneShape, §4.8), on its rig; none
//   for a body that is down (its zones are off while the slab has it) or a severed bone.
//
// Presentation only (rule 6): it reads the world and writes nothing in it.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Scene,
  SphereGeometry,
  Vector3,
  WireframeGeometry,
} from 'three';
import { type BoneZoneShape, BONES, boneZoneShape, type Fighter, type NavLayer, senseValues, type World } from '@wild/sim';
import { GAME_TUNING } from '../game/game';
import type { DevViewsPort, SimEvent } from '../game/ports';

const LAYERS: readonly NavLayer[] = ['human', 'ruler'];

interface NavLayerView {
  key: string;
  fill: Mesh;
  edges: LineSegments;
}

interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
  left: number;
}

const _v = new Vector3();
const _off = new Vector3();

/** Is the fighter down (knocked down or KO'd: the sim's slab has the body and its zones are off)? */
const isDown = (f: Fighter): boolean => f.state === 'knockdown' || f.state === 'ko';

export class DevViews implements DevViewsPort {
  readonly group = new Group();
  private readonly nav = new Map<NavLayer, NavLayerView>();
  private readonly navGroup = new Group();
  private readonly senseLines: LineSegments;
  private readonly senseMat = new LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
  private rings: Ring[] = [];
  private readonly zoneGroup = new Group();
  private readonly zoneMat = new MeshBasicMaterial({ wireframe: true, transparent: true, depthWrite: false });
  private readonly zonePool: Mesh[] = [];
  private readonly zoneGeo = new Map<string, BufferGeometry>();
  private readonly colour = new Color();

  constructor(private readonly scene: Scene) {
    this.group.name = 'dev views';
    this.senseLines = new LineSegments(new BufferGeometry(), this.senseMat);
    this.senseLines.frustumCulled = false;
    this.senseLines.renderOrder = 3;
    this.group.add(this.navGroup, this.senseLines, this.zoneGroup);
    scene.add(this.group);
  }

  update(world: World, realDt: number): void {
    const T = GAME_TUNING;
    this.navGroup.visible = T.showNav;
    if (T.showNav) this.syncNav(world);
    for (const r of this.rings) r.left -= realDt;
    this.rings = this.rings.filter((r) => r.left > 0);
    this.senseLines.visible = T.showSenses;
    if (T.showSenses) this.syncSenses(world);
    this.zoneGroup.visible = T.showZones;
    if (T.showZones) this.syncZones(world);
  }

  handle(e: SimEvent, _world: World): void {
    if (e.type !== 'noise' || !GAME_TUNING.showSenses) return;
    this.rings.push({ x: e.at.x, y: e.at.y, z: e.at.z, r: e.radius, left: GAME_TUNING.devViews.noiseRingS });
  }

  dispose(): void {
    for (const v of this.nav.values()) this.dropNav(v);
    this.nav.clear();
    this.senseLines.geometry.dispose();
    this.senseMat.dispose();
    for (const g of this.zoneGeo.values()) g.dispose();
    this.zoneGeo.clear();
    this.zoneMat.dispose();
    this.scene.remove(this.group);
  }

  // ---------------------------------------------------------------------------
  // Nav polys
  // ---------------------------------------------------------------------------

  /** Both layers' triangles, rebuilt when the layer's tile versions change (and recoloured live). */
  private syncNav(world: World): void {
    const D = GAME_TUNING.devViews;
    const nav = world.nav;
    for (const layer of LAYERS) {
      let key: string | null = null;
      try {
        if (nav) {
          const g = nav.grid(layer);
          const n = g.tilesX * g.tilesZ;
          const parts: number[] = [];
          for (let t = 0; t < n; t++) parts.push(nav.tileVersion(layer, t));
          key = `${D.navLiftM}|${parts.join(',')}`;
        }
      } catch {
        key = null; // not built (nav 'off', or disposed): nothing to draw
      }
      let v = this.nav.get(layer) ?? null;
      if (v && v.key !== key) {
        this.dropNav(v);
        this.nav.delete(layer);
        v = null;
      }
      if (!v && key !== null && nav) {
        const { positions, indices } = nav.debugGeometry(layer);
        const g = new BufferGeometry();
        const p = Float32Array.from(positions);
        // The ruler's layer a little higher than the human's, so both read where they overlap.
        const lift = D.navLiftM * (layer === 'ruler' ? 2 : 1);
        for (let i = 1; i < p.length; i += 3) p[i] += lift;
        g.setAttribute('position', new BufferAttribute(p, 3));
        g.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
        const fill = new Mesh(g, new MeshBasicMaterial({ transparent: true, depthWrite: false, side: DoubleSide }));
        const edges = new LineSegments(new WireframeGeometry(g), new LineBasicMaterial({ transparent: true }));
        fill.renderOrder = 2;
        edges.renderOrder = 2;
        v = { key, fill, edges };
        this.navGroup.add(fill, edges);
        this.nav.set(layer, v);
      }
      if (!v) continue;
      const colour = layer === 'ruler' ? D.navRuler : D.navHuman;
      const fm = v.fill.material as MeshBasicMaterial;
      fm.color.set(colour);
      fm.opacity = D.navOpacity;
      const em = v.edges.material as LineBasicMaterial;
      em.color.set(colour);
      em.opacity = Math.min(1, D.navOpacity * 3);
    }
  }

  private dropNav(v: NavLayerView): void {
    this.navGroup.remove(v.fill, v.edges);
    v.fill.geometry.dispose();
    (v.fill.material as MeshBasicMaterial).dispose();
    v.edges.geometry.dispose();
    (v.edges.material as LineBasicMaterial).dispose();
  }

  // ---------------------------------------------------------------------------
  // Senses
  // ---------------------------------------------------------------------------

  /** Every creature's sight cone and every recent noise's ring, as one set of line segments. */
  private syncSenses(world: World): void {
    const D = GAME_TUNING.devViews;
    const pos: number[] = [];
    const col: number[] = [];
    const c = this.colour;
    const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, colour: string) => {
      pos.push(ax, ay, az, bx, by, bz);
      c.set(colour);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const arcN = Math.max(2, Math.round(D.senseArcSegments));
    for (const f of world.combat.fighters) {
      if (f.species === null || f.playerId !== null || !f.alive) continue;
      const s = senseValues(f);
      const eye = f.rig.head.pos;
      const half = ((s.sightConeDeg / 2) * Math.PI) / 180;
      const at = (a: number, r: number) => _v.set(eye.x + Math.sin(f.yaw + a) * r, eye.y, eye.z + Math.cos(f.yaw + a) * r);
      for (const side of [-1, 1]) {
        at(side * half, s.sightRangeM);
        line(eye.x, eye.y, eye.z, _v.x, _v.y, _v.z, D.senseColor);
      }
      for (const [r, colour] of [
        [s.sightRangeM, D.senseColor],
        [s.sightRangeStillM, D.senseStillColor],
      ] as const) {
        for (let k = 0; k < arcN; k++) {
          const a0 = -half + (2 * half * k) / arcN;
          const a1 = -half + (2 * half * (k + 1)) / arcN;
          at(a0, r);
          const x0 = _v.x;
          const z0 = _v.z;
          at(a1, r);
          line(x0, eye.y, z0, _v.x, eye.y, _v.z, colour);
        }
      }
    }
    const ringN = Math.max(8, Math.round(D.noiseRingSegments));
    for (const r of this.rings) {
      const y = world.terrain.heightAt(r.x, r.z) + D.noiseLiftM;
      for (let k = 0; k < ringN; k++) {
        const a0 = (2 * Math.PI * k) / ringN;
        const a1 = (2 * Math.PI * (k + 1)) / ringN;
        line(r.x + Math.cos(a0) * r.r, y, r.z + Math.sin(a0) * r.r, r.x + Math.cos(a1) * r.r, y, r.z + Math.sin(a1) * r.r, D.noiseColor);
      }
    }
    const g = this.senseLines.geometry;
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
    g.computeBoundingSphere();
  }

  // ---------------------------------------------------------------------------
  // Zones
  // ---------------------------------------------------------------------------

  /** Every standing fighter's bone zones on its rig (pooled wireframe meshes). */
  private syncZones(world: World): void {
    const D = GAME_TUNING.devViews;
    this.zoneMat.color.set(D.zoneColor);
    this.zoneMat.opacity = D.zoneOpacity;
    let i = 0;
    for (const f of world.combat.fighters) {
      if (!f.alive || isDown(f)) continue;
      for (const b of BONES) {
        if (f.isSevered(b)) continue;
        const shape = boneZoneShape(b, f.scale);
        let m = this.zonePool[i];
        if (!m) {
          m = new Mesh(undefined, this.zoneMat);
          m.renderOrder = 3;
          this.zonePool.push(m);
          this.zoneGroup.add(m);
        }
        m.geometry = this.geometryOf(shape);
        const bone = f.rig[b];
        _off.set(shape.off.x, shape.off.y, shape.off.z).applyQuaternion(bone.rot);
        m.position.set(bone.pos.x, bone.pos.y, bone.pos.z).add(_off);
        m.quaternion.copy(bone.rot);
        m.scale.setScalar(1);
        if (shape.kind === 'ball') m.scale.setScalar(shape.r);
        else if (shape.kind === 'box') m.scale.set(shape.hx, shape.hy, shape.hz);
        m.visible = true;
        i++;
      }
    }
    for (; i < this.zonePool.length; i++) this.zonePool[i].visible = false;
  }

  /** A unit sphere or box (scaled per use), or a capsule of the shape's own size (cached). */
  private geometryOf(s: BoneZoneShape): BufferGeometry {
    const key = s.kind === 'capsule' ? `capsule|${s.r.toFixed(4)}|${s.halfHeight.toFixed(4)}` : s.kind;
    let g = this.zoneGeo.get(key);
    if (!g) {
      g = s.kind === 'ball' ? new SphereGeometry(1, 10, 8) : s.kind === 'box' ? new BoxGeometry(2, 2, 2) : new CapsuleGeometry(s.r, 2 * s.halfHeight, 3, 8);
      this.zoneGeo.set(key, g);
    }
    return g;
  }
}
