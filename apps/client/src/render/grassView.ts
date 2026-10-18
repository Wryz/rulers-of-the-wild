// Ground cover on screen (docs/M1-DESIGN.md §10.4): one InstancedMesh of crossed-quad tufts laid from the cover grid
// (world.cover, in its own cells of world.cover.cellM) within RENDER_TUNING.grassRadiusM of the camera, at most
// grassPerCell per cell (round(cover × grassPerCell)), taller where the cover is denser. Rule 3: dense dry grass is pale
// (the meadows, cover ≥ terrain.dryCoverFrom), and dug ground is bare (a tuft is never laid where the ground is more
// than terrain.dugM off its generated height, nor on rock too steep to climb; C-fix: and the tuft's whole footprint must
// be such ground, so none stands on the edge of raised spoil or hangs off a cliff or a pit's lip). Re-laid when the camera has moved
// grass.rebuildMoveM or the terrain changed (a dig also clears the cover cell, §4.13).
import { BufferAttribute, BufferGeometry, Color, Group, Matrix4, Quaternion, type Scene, Vector3 } from 'three';
import { CLEARING_TUNING, type Terrain } from '@wild/sim';
import { flatMaterial, Instancer } from './entityViews';
import { hash2, RENDER_TUNING } from './terrainView';

/** What the grass view reads from the world. */
export interface GrassSource {
  terrain: Terrain;
  /** The cover grid; `cellM` is its cell size (absent: CLEARING_TUNING.coverCellM, as the sim's own default). */
  cover: { at(x: number, z: number): number; readonly cellM?: number };
}

/**
 * Can a tuft `w` m wide stand at (x, z)? Its root and the four points of its footprint (±w/2 on each axis) must all be
 * undug, unheaped ground (within terrain.dugM of the generated height), and none of them may rise or drop from the root
 * more than a slope of terrain.rockSlopeDeg would: so no tuft on raised spoil, on rock, or on the lip of a cliff or a pit.
 */
export function tuftFits(t: Terrain, x: number, z: number, w: number, n = new Vector3()): boolean {
  const T = RENDER_TUNING.terrain;
  const y = t.heightAt(x, z);
  if (Math.abs(y - t.originalHeightAt(x, z)) > T.dugM) return false;
  t.normalAt(x, z, n);
  if (n.y < Math.cos((T.rockSlopeDeg * Math.PI) / 180)) return false;
  const r = w / 2;
  const rise = r * Math.tan((T.rockSlopeDeg * Math.PI) / 180);
  for (const [dx, dz] of FOOTPRINT) {
    const px = x + dx * r;
    const pz = z + dz * r;
    const h = t.heightAt(px, pz);
    if (Math.abs(h - y) > rise || Math.abs(h - t.originalHeightAt(px, pz)) > T.dugM) return false;
  }
  return true;
}

const FOOTPRINT: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * A tuft 1 m wide and 1 m tall standing on the origin: two crossed rows of three pointed blades, leaning out, darker at
 * the root (vertex colours), each blade faced both ways. Its normals point up, so a blade is lit like the ground it grows
 * from, from either side.
 */
export function tuftGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  for (const a of [0, Math.PI / 2]) {
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    for (let b = 0; b < 3; b++) {
      const c = (b - 1) / 3;
      const w = 0.17 + 0.03 * b;
      const lean = (b - 1) * 0.22;
      const h = b === 1 ? 1 : 0.78;
      // Root left, root right, tip (leaning out from the middle); then the same blade wound the other way, so it has a
      // front face from both sides (a double-sided material would flip the back face's normal and draw it black).
      const l = [(c - w) * ux, 0, (c - w) * uz];
      const r = [(c + w) * ux, 0, (c + w) * uz];
      const t = [(c + lean) * ux, h, (c + lean) * uz];
      pos.push(...l, ...r, ...t, ...r, ...l, ...t);
      col.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 1, 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  const normals = new Float32Array(pos.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  return g;
}

/** Tufts in a cell with this much cover. */
export function tuftsFor(cover: number): number {
  const n = RENDER_TUNING.grassPerCell;
  return Math.max(0, Math.min(n, Math.round(Math.min(1, Math.max(0, cover)) * n)));
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _green = new Color();
const _dry = new Color();
const _up = new Vector3(0, 1, 0);

export class GrassView {
  readonly group = new Group();
  readonly tufts: Instancer;
  private centre: { x: number; z: number } | null = null;
  private versions = '';

  constructor(scene: Scene) {
    this.group.name = 'grass';
    scene.add(this.group);
    const mat = flatMaterial({ vertexColors: true, roughness: 1 });
    // (Smooth-shaded with the tuft's up normals: flat shading would light each blade by its own face, dark from behind.)
    mat.flatShading = false;
    this.tufts = new Instancer(this.group, tuftGeometry(), mat, 1024, 'grass');
    this.tufts.mesh.castShadow = false;
  }

  /** Re-lays the tufts around `at` (the camera) when it has moved far enough or the terrain has changed. */
  sync(world: GrassSource, at: { x: number; z: number }): void {
    const G = RENDER_TUNING.grass;
    const t = world.terrain;
    const versions = t.version.join(',');
    if (this.centre && versions === this.versions && Math.hypot(at.x - this.centre.x, at.z - this.centre.z) < G.rebuildMoveM) return;
    this.centre = { x: at.x, z: at.z };
    this.versions = versions;
    this.lay(world, at);
  }

  /** Forces a re-lay on the next sync (the cover changed). */
  invalidate(): void {
    this.centre = null;
  }

  dispose(): void {
    this.tufts.dispose();
    this.group.removeFromParent();
  }

  private lay(world: GrassSource, at: { x: number; z: number }): void {
    const T = RENDER_TUNING;
    const G = T.grass;
    const t = world.terrain;
    const cell = world.cover.cellM ?? CLEARING_TUNING.coverCellM;
    const radius = T.grassRadiusM;
    _green.set(G.green);
    _dry.set(G.dry);
    this.tufts.begin();
    const maxX = t.minX + t.tilesX * t.tileSize;
    const maxZ = t.minZ + t.tilesZ * t.tileSize;
    const i0 = Math.max(0, Math.floor((at.x - radius - t.minX) / cell));
    const i1 = Math.min(Math.ceil((maxX - t.minX) / cell) - 1, Math.floor((at.x + radius - t.minX) / cell));
    const j0 = Math.max(0, Math.floor((at.z - radius - t.minZ) / cell));
    const j1 = Math.min(Math.ceil((maxZ - t.minZ) / cell) - 1, Math.floor((at.z + radius - t.minZ) / cell));
    const n = new Vector3();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = t.minX + (i + 0.5) * cell;
        const cz = t.minZ + (j + 0.5) * cell;
        if (Math.hypot(cx - at.x, cz - at.z) > radius) continue;
        const cover = world.cover.at(cx, cz);
        const count = tuftsFor(cover);
        for (let k = 0; k < count; k++) {
          const x = cx + (hash2(i * 7 + k, j * 13 + 1) - 0.5) * cell;
          const z = cz + (hash2(i * 11 + 3, j * 5 + k) - 0.5) * cell;
          const w = G.widthM * (0.8 + 0.4 * hash2(j + k * 17, i));
          // Bare where dug or heaped, on rock, and where the tuft would overhang either (its whole footprint).
          if (!tuftFits(t, x, z, w, n)) continue;
          const y = t.heightAt(x, z);
          const h = G.heightM * (0.45 + 0.55 * cover) * (0.75 + 0.5 * hash2(i + k * 31, j));
          _q.setFromAxisAngle(_up, hash2(i * 3 + k, j * 3) * Math.PI);
          _m.compose(_p.set(x, y - 0.02, z), _q, _s.set(w, h, w));
          const dry = cover >= T.terrain.dryCoverFrom ? 1 : 0.4 * cover;
          _c.copy(_green).lerp(_dry, dry).multiplyScalar(0.9 + 0.2 * hash2(i, j + k * 5));
          this.tufts.push(_m, _c);
        }
      }
    }
    this.tufts.end();
  }
}
