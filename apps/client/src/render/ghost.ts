// The placement ghost (docs/M1-DESIGN.md §10.7, §5.7): a translucent copy of what the hands carry or wield, drawn at the
// pose it would rest at, green when the client's estimate says it fits, red otherwise. The estimate is the sim's own
// rule run read-only (planPlace, world/verbs/place.ts), which input/verbInput.ts calls with the place command it would
// send: lying, upright or sloped (leaning from its lower end onto the highest support under its upper half), so a
// green ghost is exactly where the object goes. Every member of a lashed object is drawn where it sits on it.
//
// Presentation only (rule 6): it reads records and writes nothing in the world.
import { type BufferGeometry, Group, Mesh, MeshBasicMaterial, type Scene } from 'three';
import { heldMembers, type Pose3, type Shape, verbGeom, type World } from '@wild/sim';
import { shapeGeometry } from './entityViews';

/** How a placed thing is set down (§5.7: pitch 0 lying, 64 upright, anything between sloped). */
export type PlaceOrientation = 'lying' | 'upright' | 'sloped';

/** The ghost's colours: fits, doesn't (presentation, not tuning). */
const FITS = 0x6fe07a;
const BLOCKED = 0xff5a4a;
const OPACITY = 0.38;

export class Ghost {
  private readonly group = new Group();
  private readonly mat = new MeshBasicMaterial({ color: FITS, transparent: true, opacity: OPACITY, depthWrite: false });
  private readonly meshes: Mesh[] = [];
  private readonly geos = new WeakMap<Shape, BufferGeometry>();
  private readonly owned: BufferGeometry[] = [];
  /** Whether the last ghost shown fits (green). */
  fits = false;

  constructor(private readonly scene: Scene) {
    this.group.visible = false;
    this.group.renderOrder = 3;
    scene.add(this.group);
  }

  /** Is a ghost shown? */
  get visible(): boolean {
    return this.group.visible;
  }

  /**
   * Shows the held object of `entity` (its lashed members where they sit on it) with `entity` at `pose`; `fits` colours
   * it green or red. A null entity or pose hides it.
   */
  show(world: World, entity: number | null, pose: Pose3 | null, fits: boolean): void {
    const main = entity === null ? undefined : world.entities.get(entity);
    if (!main || !pose) {
      this.group.visible = false;
      return;
    }
    this.fits = fits;
    this.mat.color.setHex(fits ? FITS : BLOCKED);
    const ids = heldMembers(world, main.id);
    let i = 0;
    for (const id of ids) {
      const e = world.entities.get(id);
      if (!e) continue;
      const at = e === main ? pose : verbGeom.compose(pose, verbGeom.relative(main.pose, e.pose));
      let m = this.meshes[i];
      if (!m) {
        m = new Mesh(undefined, this.mat);
        this.meshes.push(m);
        this.group.add(m);
      }
      i++;
      m.geometry = this.geometry(e.shape);
      m.position.set(at.p.x, at.p.y, at.p.z);
      m.quaternion.set(at.q.x, at.q.y, at.q.z, at.q.w);
      m.visible = true;
    }
    for (; i < this.meshes.length; i++) this.meshes[i].visible = false;
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.mat.dispose();
    for (const g of this.owned) g.dispose();
  }

  private geometry(s: Shape): BufferGeometry {
    let g = this.geos.get(s);
    if (!g) {
      g = shapeGeometry(s);
      this.geos.set(s, g);
      this.owned.push(g);
    }
    return g;
  }
}
