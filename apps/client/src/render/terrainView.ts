// The terrain on screen (docs/M1-DESIGN.md §10.4): one flat-shaded mesh per terrain tile from world.terrain.heights,
// rebuilt when the tile's version changes; RENDER_TUNING (the Clearing's render starting values) lives here.
//
// STUB (P31; P32 fills it): the final exported names, RENDER_TUNING with its §9 values, and one plain mesh per tile at
// RENDER_TUNING.farSpacing (P32: 0.25 m within nearTileM of the camera with hysteresis, vertex colours for dry grass,
// dug dirt and rock, exactly the sim's heights).
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type Scene, type Vector3 } from 'three';
import { defineTuning, type Terrain, type World } from '@wild/sim';

export const RENDER_TUNING = defineTuning(
  'RENDER_TUNING',
  'Client › render',
  {
    nearTileM: 40,
    nearSpacing: 0.25,
    farSpacing: 0.5,
    lodHysteresisM: 5,
    grassRadiusM: 60,
    grassPerCell: 3,
    fogNear: 70,
    fogFar: 190,
    cameraFar: 600,
    shadowExtentM: 40,
    shadowFarM: 120,
    shadowMap: 2048,
    chopShudderDeg: 0.6,
    chopShudderS: 0.25,
    creakBelowRemaining: 0.3,
    strainShowFrac: 0.6,
    integrityCrack: 0.6,
    integritySag: 0.3,
    ropeThinMax: 0.3,
    ropeFrayFrac: 0.8,
    fallenCrownPadM: 0.15,
    // Not §9.1 rows: the stub's sky and ground looks (P31), so none is a bare constant; P32 sets the real ones.
    groundColor: '#5f7d3c',
    skyColor: '#a9c3cf',
    hemiSkyColor: '#d6e6f0',
    hemiGroundColor: '#4b5a33',
    hemiIntensity: 1.15,
    sunColor: '#fff1d8',
    sunIntensity: 2.1,
  },
  {
    nearTileM: { unit: 'm', source: 'NEW (§10.4)', min: 0, max: 200, step: 1 },
    nearSpacing: { unit: 'm', source: 'NEW (§10.4)', min: 0.25, max: 2, step: 0.25 },
    farSpacing: { unit: 'm', source: 'NEW (§10.4)', min: 0.25, max: 4, step: 0.25 },
    lodHysteresisM: { unit: 'm', source: 'NEW (§10.4)', min: 0, max: 20, step: 0.5 },
    grassRadiusM: { unit: 'm', source: 'NEW (§10.4)', min: 0, max: 200, step: 1 },
    grassPerCell: { unit: 'tufts', source: 'NEW (§10.4)', min: 0, max: 10, step: 1 },
    fogNear: { unit: 'm', source: 'NEW (§10.4)', min: 0, max: 600, step: 1 },
    fogFar: { unit: 'm', source: 'NEW (§10.4)', min: 1, max: 1000, step: 1 },
    cameraFar: { unit: 'm', source: 'NEW (§10.4)', min: 50, max: 2000, step: 10 },
    shadowExtentM: { unit: 'm', source: 'NEW (§10.4)', min: 5, max: 200, step: 1 },
    shadowFarM: { unit: 'm', source: 'NEW (§10.4)', min: 10, max: 500, step: 1 },
    shadowMap: { unit: 'px', source: 'NEW (§10.4)', min: 256, max: 8192, step: 256 },
    chopShudderDeg: { unit: '°', source: 'NEW: SPEC:581', min: 0, max: 5, step: 0.05 },
    chopShudderS: { unit: 's', source: 'NEW: SPEC:581', min: 0, max: 2, step: 0.05 },
    creakBelowRemaining: { unit: 'fraction', source: 'NEW: SPEC:581', min: 0, max: 1, step: 0.01 },
    strainShowFrac: { unit: 'fraction', source: 'NEW: rule 3, SPEC:362', min: 0, max: 1, step: 0.01 },
    integrityCrack: { unit: 'fraction', source: 'NEW: rule 3, SPEC:362', min: 0, max: 1, step: 0.01 },
    integritySag: { unit: 'fraction', source: 'NEW: rule 3, SPEC:362', min: 0, max: 1, step: 0.01 },
    ropeThinMax: { unit: 'fraction', source: 'NEW: SPEC:357-358', min: 0, max: 1, step: 0.01 },
    ropeFrayFrac: { unit: 'fraction', source: 'NEW: SPEC:357-358', min: 0, max: 1, step: 0.01 },
    fallenCrownPadM: {
      unit: 'm',
      source: "NEW: a falling or felled crown is drawn within the trunk radius + this (rule 3, RR-15)",
      min: 0,
      max: 1,
      step: 0.01,
    },
    groundColor: { unit: 'colour', source: 'NEW (P31 stub: the plain ground until P32 colours it)' },
    skyColor: { unit: 'colour', source: 'NEW (P31 stub: background and fog)' },
    hemiSkyColor: { unit: 'colour', source: 'NEW (P31 stub)' },
    hemiGroundColor: { unit: 'colour', source: 'NEW (P31 stub)' },
    hemiIntensity: { unit: '×', source: 'NEW (P31 stub)', min: 0, max: 5, step: 0.05 },
    sunColor: { unit: 'colour', source: 'NEW (P31 stub)' },
    sunIntensity: { unit: '×', source: 'NEW (P31 stub)', min: 0, max: 10, step: 0.05 },
  },
);

export class TerrainView {
  readonly group = new Group();
  private readonly material = new MeshStandardMaterial({ color: RENDER_TUNING.groundColor, flatShading: true, roughness: 0.95, metalness: 0 });
  private readonly meshes: (Mesh | null)[] = [];
  private versions = new Uint32Array(0);

  constructor(scene: Scene, world: World) {
    scene.add(this.group);
    this.sync(world);
  }

  /** Rebuilds every tile whose terrain version changed (all of them the first time). */
  sync(world: World, _cam?: Vector3): void {
    this.material.color.set(RENDER_TUNING.groundColor);
    const t = world.terrain;
    if (this.versions.length !== t.tileCount) this.versions = new Uint32Array(t.tileCount).fill(0xffffffff);
    for (let i = 0; i < t.tileCount; i++) {
      if (this.versions[i] === t.version[i] && this.meshes[i]) continue;
      this.versions[i] = t.version[i];
      const old = this.meshes[i];
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
      }
      const mesh = new Mesh(tileGeometry(t, i), this.material);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.meshes[i] = mesh;
    }
  }

  dispose(): void {
    for (const m of this.meshes) m?.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/** Tile `t` as triangles split like the sim's (the diagonal from (c + 1, r) to (c, r + 1)), every `stride`-th vertex. */
function tileGeometry(t: Terrain, tile: number): BufferGeometry {
  const stride = Math.max(1, Math.round(RENDER_TUNING.farSpacing / t.spacing));
  const n1 = t.cells + 1;
  const idx: number[] = [];
  for (let c = 0; c <= t.cells; c += stride) idx.push(c);
  if (idx[idx.length - 1] !== t.cells) idx.push(t.cells);
  const n = idx.length;
  const H = t.heights[tile];
  const tx = tile % t.tilesX;
  const tz = (tile - tx) / t.tilesX;
  const x0 = t.minX + tx * t.tileSize;
  const z0 = t.minZ + tz * t.tileSize;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = idx[i];
      const r = idx[j];
      const k = (j * n + i) * 3;
      pos[k] = x0 + c * t.spacing;
      pos[k + 1] = H[r + c * n1];
      pos[k + 2] = z0 + r * t.spacing;
    }
  }
  const tri: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i; // (c, r)
      const b = a + 1; // (c + 1, r)
      const cc = a + n; // (c, r + 1)
      const d = cc + 1; // (c + 1, r + 1)
      tri.push(a, cc, b, d, b, cc);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(tri);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
