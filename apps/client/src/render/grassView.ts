// Ground cover on screen (docs/M1-DESIGN.md §10.4): one InstancedMesh of crossed-quad tufts laid from the cover grid
// (world.cover, 2 m cells, CLEARING_TUNING.coverCellM) within RENDER_TUNING.grassRadiusM of the camera, at most
// grassPerCell per cell (round(cover × grassPerCell)), taller where the cover is denser. Rule 3: dense dry grass is pale
// (the meadows, cover ≥ terrain.dryCoverFrom), and dug ground is bare (a tuft is never laid where the ground is more
// than terrain.dugM off its generated height, nor on rock too steep to climb). Re-laid when the camera has moved
// grass.rebuildMoveM or the terrain changed (a dig also clears the cover cell, §4.13).
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Matrix4, Quaternion, type Scene, Vector3 } from 'three';
import { CLEARING_TUNING, type Terrain } from '@wild/sim';
import { flatMaterial, Instancer } from './entityViews';
import { hash2, RENDER_TUNING } from './terrainView';

/** What the grass view reads from the world. */
export interface GrassSource {
  terrain: Terrain;
  cover: { at(x: number, z: number): number };
}

/** Two crossed quads 1 m wide and 1 m tall standing on the origin, darker at the root (vertex colours). */
export function tuftGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  for (const a of [0, Math.PI / 2]) {
    const cx = Math.cos(a) * 0.5;
    const cz = Math.sin(a) * 0.5;
    const base = pos.length / 3;
    // Bottom left, bottom right, top right (leaning a little), top left.
    pos.push(-cx, 0, -cz, cx, 0, cz, cx * 0.7, 1, cz * 0.7, -cx * 0.7, 1, -cz * 0.7);
    col.push(0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 1, 1, 1, 1, 1, 1);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(index);
  g.computeVertexNormals();
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
    mat.side = DoubleSide;
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
    const cell = CLEARING_TUNING.coverCellM;
    const radius = T.grassRadiusM;
    const rockCos = Math.cos((T.terrain.rockSlopeDeg * Math.PI) / 180);
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
          const y = t.heightAt(x, z);
          // Bare where dug or heaped, and on rock.
          if (Math.abs(y - t.originalHeightAt(x, z)) > T.terrain.dugM) continue;
          t.normalAt(x, z, n);
          if (n.y < rockCos) continue;
          const h = G.heightM * (0.45 + 0.55 * cover) * (0.75 + 0.5 * hash2(i + k * 31, j));
          const w = G.widthM * (0.8 + 0.4 * hash2(j + k * 17, i));
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
