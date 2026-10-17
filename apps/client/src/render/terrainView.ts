// The terrain on screen (docs/M1-DESIGN.md §10.4): one flat-shaded mesh per terrain tile built from the sim's own heights
// (world.terrain.heights), split into triangles exactly as the sim's heightfield is, so what you see is what bodies stand
// on; rebuilt when the tile's version changes (a dig) or its level of detail does. RENDER_TUNING (every starting value of
// the Clearing's render, P32) lives here.
//
// Level of detail: tiles within RENDER_TUNING.nearTileM of the camera use every sim vertex (nearSpacing 0.25 m: exactly
// the collider's surface); the others every second one (farSpacing 0.5 m), with lodHysteresisM of slack so a tile on the
// boundary doesn't flip every frame. A skirt hangs from every tile edge so the T-junctions between a near and a far tile
// never open a crack.
//
// Readability (rule 3): vertex colours show what the ground is: grass green, paler where the ground cover is dense dry
// grass (cover ≥ terrain.dryCoverFrom), fresh brown dirt where it has been dug or heaped (more than terrain.dugM off its
// generated height), grey rock where it is steeper than terrain.rockSlopeDeg (the rim and the ledge: too steep to climb).
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
  type Vector3,
} from 'three';
import { defineTuning, type FieldMeta, MATERIAL_IDS, type MaterialId, type Terrain } from '@wild/sim';

/** A colour row of RENDER_TUNING (shown, not edited, by the dev panel). */
const colour = (source: string): FieldMeta => ({ unit: 'colour', source });

/** One material's look: its colour and how rough (matte) or smooth (glossy) it is. (A type, so the registry's FieldsOf
 * sees it as a nested table.) */
export type MaterialLook = {
  color: string;
  roughness: number;
};

/** Each material's look (rule 3: green wood darker, dry wood pale, rotten wood dark, flint glossy dark). */
const MATERIAL_LOOKS: Record<MaterialId, MaterialLook> = {
  greenWood: { color: '#6e5a3c', roughness: 0.8 },
  dryWood: { color: '#c2a77c', roughness: 0.95 },
  rottenWood: { color: '#3f3226', roughness: 1 },
  leaves: { color: '#8a8a48', roughness: 0.95 },
  vine: { color: '#58682f', roughness: 0.85 },
  sinew: { color: '#d8c7a2', roughness: 0.6 },
  hide: { color: '#7a5636', roughness: 0.8 },
  bone: { color: '#e6dcc4', roughness: 0.6 },
  rulerBone: { color: '#d4c49e', roughness: 0.55 },
  stone: { color: '#8b8a84', roughness: 0.9 },
  flint: { color: '#2b2c33', roughness: 0.22 },
  dirt: { color: '#6a4a2e', roughness: 1 },
  snow: { color: '#eef3f8', roughness: 0.7 },
  ice: { color: '#bcdcec', roughness: 0.12 },
  resin: { color: '#c58a26', roughness: 0.2 },
  fat: { color: '#efe2bd', roughness: 0.45 },
};

function materialFields(): Record<MaterialId, { color: FieldMeta; roughness: FieldMeta }> {
  const out = {} as Record<MaterialId, { color: FieldMeta; roughness: FieldMeta }>;
  for (const id of MATERIAL_IDS) {
    out[id] = {
      color: colour(`NEW: P32 (${id}'s look; rule 3, SPEC:351-362)`),
      roughness: { unit: '0-1', source: `NEW: P32 (${id}: matte 1, glossy 0)`, min: 0, max: 1, step: 0.01 },
    };
  }
  return out;
}

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
    // P32's own looks below (not §9.1 rows: the design names the effects, these are their sizes and colours), so none
    // is a bare constant in the views.
    terrain: {
      grass: '#5d7a3a',
      grassDry: '#a8a066',
      dirt: '#6b4a2d',
      rock: '#7f7b72',
      dryCoverFrom: 0.6,
      dugM: 0.05,
      rockSlopeDeg: 35,
      variation: 0.06,
      skirtM: 0.6,
    },
    sky: {
      sky: '#a9c6d6',
      hemiSky: '#d9e8f2',
      hemiGround: '#4f5a34',
      hemiIntensity: 1.05,
      sun: '#ffe6c2',
      sunIntensity: 2.3,
      sunAzimuthDeg: 215,
      sunElevationDeg: 48,
      shadowBias: -0.0004,
      shadowNormalBias: 0.03,
    },
    forest: {
      bark: '#5a4530',
      canopy: '#4c7433',
      saplingStem: '#6f6a3a',
      saplingLeaves: '#6a9a3e',
      cutWood: '#e2c995',
      crownRadiusPerH: 0.24,
      crownMinM: 1.6,
      crownSinkFrac: 0.2,
      saplingCrownPerH: 0.22,
      notchOpenPerDepth: 0.6,
      notchMinHalfOpenM: 0.03,
      notchSegments: 4,
      creakDeg: 0.15,
      creakHz: 7,
      leavesPerChop: 10,
      leafFallMps: 1.1,
      leafDriftMps: 0.6,
      leafLifeS: 5,
      variation: 0.1,
    },
    materials: MATERIAL_LOOKS,
    entities: {
      variation: 0.07,
      wetDarken: 0.35,
      wetRoughness: 0.25,
      crackDarken: 0.72,
      crackColor: '#1e1712',
      crackWidthM: 0.012,
      sharpColor: '#efe0bd',
      sharpConeLenM: 0.12,
      sharpConeRadiusM: 0.03,
      sagFrac: 0.03,
      sagMaxM: 0.1,
      strainBendFrac: 0.04,
      rotLumpFrac: 0.12,
      bloodColor: '#6e0a0a',
    },
    ropes: {
      segments: 8,
      radiusMul: 1.6,
      frayColor: '#b5462c',
      frayJitterFrac: 0.9,
    },
    grass: {
      heightM: 0.55,
      widthM: 0.55,
      green: '#5f8a3a',
      dry: '#c4b878',
      rebuildMoveM: 4,
    },
    carry: {
      beltOutM: 0.2,
      beltDownM: 0.05,
      backOutM: 0.17,
      backTiltDeg: 35,
    },
    wounds: {
      scarLengthM: 0.1,
      gashLengthM: 0.14,
      severeMul: 1.5,
    },
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
      source: 'NEW: a falling or felled crown is drawn within the trunk radius + this (rule 3, RR-15)',
      min: 0,
      max: 1,
      step: 0.01,
    },
    terrain: {
      grass: colour('NEW: P32 (grass green, §10.4)'),
      grassDry: colour('NEW: P32 (dense dry grass is pale, §10.4, rule 3)'),
      dirt: colour('NEW: P32 (dug or heaped ground, §10.4)'),
      rock: colour('NEW: P32 (ground too steep to climb, §10.4)'),
      dryCoverFrom: { unit: 'cover 0-1', source: 'NEW: §10.4 ("pale where cover ≥ 0.6")', min: 0, max: 1, step: 0.01 },
      dugM: { unit: 'm', source: 'NEW: §10.4 ("dirt brown where dug, h < original − 0.05")', min: 0, max: 1, step: 0.01 },
      rockSlopeDeg: { unit: '°', source: 'NEW: §10.4 ("grey rock above 35°")', min: 0, max: 90, step: 1 },
      variation: { unit: '± brightness', source: 'NEW: P32 (per-vertex shade so flat ground reads as ground)', min: 0, max: 0.5, step: 0.01 },
      skirtM: { unit: 'm', source: 'NEW: P32 (tile-edge skirts hide the cracks between levels of detail)', min: 0, max: 5, step: 0.05 },
    },
    sky: {
      sky: colour('NEW: P32 (background and fog)'),
      hemiSky: colour('NEW: P32 (hemisphere light from above)'),
      hemiGround: colour('NEW: P32 (hemisphere light from below)'),
      hemiIntensity: { unit: '×', source: 'NEW: P32', min: 0, max: 5, step: 0.05 },
      sun: colour('NEW: P32 (a warm sun, SPEC:840)'),
      sunIntensity: { unit: '×', source: 'NEW: P32', min: 0, max: 10, step: 0.05 },
      sunAzimuthDeg: { unit: '°', source: 'NEW: P32 (where the sun stands, from +z toward +x)', min: 0, max: 360, step: 1 },
      sunElevationDeg: { unit: '°', source: 'NEW: P32 (an afternoon sun: long-ish shadows, SPEC:840)', min: 1, max: 90, step: 1 },
      shadowBias: { unit: 'depth', source: 'NEW: P32 (DS −0.0005)', min: -0.01, max: 0.01, step: 0.0001 },
      shadowNormalBias: { unit: 'm', source: 'NEW: P32 (DS 0.02)', min: 0, max: 0.5, step: 0.005 },
    },
    forest: {
      bark: colour('NEW: P32 (trunks)'),
      canopy: colour('NEW: P32 (crowns)'),
      saplingStem: colour('NEW: P32'),
      saplingLeaves: colour('NEW: P32'),
      cutWood: colour('NEW: P32 (fresh-cut wood in a notch or on a stump: rule 3)'),
      crownRadiusPerH: { unit: 'm per m of height', source: 'NEW: P32 (a standing crown, no collider: TODO "canopy collision (rule 3)")', min: 0, max: 1, step: 0.01 },
      crownMinM: { unit: 'm', source: 'NEW: P32', min: 0, max: 10, step: 0.1 },
      crownSinkFrac: { unit: '× crown radius', source: 'NEW: P32 (how far the crown sits down over the trunk top)', min: 0, max: 1, step: 0.01 },
      saplingCrownPerH: { unit: 'm per m of height', source: 'NEW: P32', min: 0, max: 1, step: 0.01 },
      notchOpenPerDepth: { unit: 'half-opening ÷ depth', source: 'NEW: P32 (the notch is a V about as open as it is deep)', min: 0.1, max: 3, step: 0.05 },
      notchMinHalfOpenM: { unit: 'm', source: 'NEW: P32', min: 0, max: 0.5, step: 0.005 },
      notchSegments: { unit: 'rows per notch face', source: 'NEW: P32', min: 1, max: 16, step: 1 },
      creakDeg: { unit: '°', source: 'NEW: SPEC:581 (a tree cut below creakBelowRemaining trembles: it creaks before it goes)', min: 0, max: 2, step: 0.01 },
      creakHz: { unit: 'Hz', source: 'NEW: SPEC:581', min: 0, max: 30, step: 0.5 },
      leavesPerChop: { unit: 'leaves', source: 'NEW: §10.4 ("sheds leaf particles")', min: 0, max: 60, step: 1 },
      leafFallMps: { unit: 'm/s', source: 'NEW: P32', min: 0.1, max: 10, step: 0.1 },
      leafDriftMps: { unit: 'm/s', source: 'NEW: P32', min: 0, max: 5, step: 0.1 },
      leafLifeS: { unit: 's', source: 'NEW: P32', min: 0.5, max: 30, step: 0.5 },
      variation: { unit: '± brightness', source: 'NEW: P32 (tree-to-tree colour)', min: 0, max: 0.5, step: 0.01 },
    },
    materials: materialFields(),
    entities: {
      variation: { unit: '± brightness', source: 'NEW: P32 (entity-to-entity colour)', min: 0, max: 0.5, step: 0.01 },
      wetDarken: { unit: 'fraction at moisture 1', source: 'NEW: SPEC:353 ("wet: darker, glossier"; moisture is M2)', min: 0, max: 1, step: 0.01 },
      wetRoughness: { unit: 'roughness at moisture 1', source: 'NEW: SPEC:353', min: 0, max: 1, step: 0.01 },
      crackDarken: { unit: '× colour', source: 'NEW: rule 3, SPEC:362 (integrity < integrityCrack darkens)', min: 0, max: 1, step: 0.01 },
      crackColor: colour('NEW: SPEC:362 (cracks)'),
      crackWidthM: { unit: 'm', source: 'NEW: SPEC:362', min: 0.001, max: 0.1, step: 0.001 },
      sharpColor: colour('NEW: §10.4 ("a pale cone at every sharp point")'),
      sharpConeLenM: {
        unit: 'm at sharpness 1',
        source: 'NEW: §10.4; never longer than DAMAGE_TUNING.tipRadiusM, so a snag stub never reaches past what the sharp-point test scores (TODO "snag stub geometry (rule 3)")',
        min: 0,
        max: 0.5,
        step: 0.005,
      },
      sharpConeRadiusM: { unit: 'm at sharpness 1', source: 'NEW: §10.4', min: 0, max: 0.2, step: 0.005 },
      sagFrac: { unit: '× length', source: 'NEW: SPEC:362 (integrity < integritySag sags)', min: 0, max: 0.2, step: 0.005 },
      sagMaxM: { unit: 'm', source: 'NEW: SPEC:362', min: 0, max: 1, step: 0.01 },
      strainBendFrac: { unit: '× length at capacity', source: 'NEW: §10.4 (a load above strainShowFrac of capacity bends it)', min: 0, max: 0.3, step: 0.005 },
      rotLumpFrac: { unit: '× radius', source: 'NEW: §10.4 ("dark spongy rotten wood": lumpy, not just dark)', min: 0, max: 0.5, step: 0.01 },
      bloodColor: colour('NEW: P32 (blood on a tool, rule 12: drawn only when gore is on)'),
    },
    ropes: {
      segments: { unit: 'segments', source: 'NEW: §10.4 (an 8-segment parabola)', min: 1, max: 32, step: 1 },
      radiusMul: { unit: '× FACTORY_TUNING.ropeRadiusM', source: 'NEW: P32 (a 1 cm rope drawn a little thicker so it reads)', min: 0.5, max: 5, step: 0.1 },
      frayColor: colour('NEW: SPEC:358 (fraying: reddish)'),
      frayJitterFrac: { unit: '× radius', source: 'NEW: SPEC:358 (fuzzy)', min: 0, max: 3, step: 0.05 },
    },
    grass: {
      heightM: { unit: 'm', source: 'NEW: P32 (a tuft at cover 1)', min: 0.05, max: 3, step: 0.05 },
      widthM: { unit: 'm', source: 'NEW: P32', min: 0.05, max: 3, step: 0.05 },
      green: colour('NEW: P32 (sparse grass)'),
      dry: colour('NEW: P32 (dense dry grass: pale, rule 3)'),
      rebuildMoveM: { unit: 'm', source: 'NEW: P32 (the tufts round the camera are re-laid after it moves this far)', min: 0.5, max: 30, step: 0.5 },
    },
    carry: {
      beltOutM: { unit: 'm (× scale)', source: 'NEW: P32 (a belt item hangs this far out from the pelvis)', min: 0, max: 1, step: 0.01 },
      beltDownM: { unit: 'm (× scale)', source: 'NEW: P32', min: -1, max: 1, step: 0.01 },
      backOutM: { unit: 'm (× scale)', source: 'NEW: P32 (a back item rides this far behind the chest)', min: 0, max: 1, step: 0.01 },
      backTiltDeg: { unit: '°', source: 'NEW: P32 (slung diagonally)', min: 0, max: 90, step: 1 },
    },
    wounds: {
      scarLengthM: { unit: 'm (bone frame)', source: 'NEW: SPEC:845 (a healed ruler wound: a scar)', min: 0.01, max: 0.5, step: 0.01 },
      gashLengthM: { unit: 'm (bone frame)', source: 'NEW: SPEC:845 (an open ruler wound: a gash)', min: 0.01, max: 0.5, step: 0.01 },
      severeMul: { unit: '×', source: 'NEW: SPEC:503 (a severe wound shows bigger)', min: 1, max: 4, step: 0.05 },
    },
  },
);

/** A material's look from RENDER_TUNING (falls back to stone for an id the table doesn't know). */
export function materialLook(id: MaterialId): MaterialLook {
  return RENDER_TUNING.materials[id] ?? RENDER_TUNING.materials.stone;
}

/** What the terrain view reads from the world. */
export interface TerrainSource {
  terrain: Terrain;
  cover: { at(x: number, z: number): number };
}

/** A tile's horizontal distance from (x, z) (0 inside it). */
export function tileDistance(t: Terrain, tile: number, x: number, z: number): number {
  const c = t.tileCentre(tile);
  const h = t.tileSize / 2;
  const dx = Math.max(0, Math.abs(x - c.x) - h);
  const dz = Math.max(0, Math.abs(z - c.z) - h);
  return Math.hypot(dx, dz);
}

/**
 * The vertex spacing a tile at `dist` m from the camera is drawn at: nearSpacing within nearTileM, farSpacing beyond,
 * with lodHysteresisM of slack around the boundary for a tile already drawn at one of them (`current`).
 */
export function tileSpacing(dist: number, current: number | null): number {
  const T = RENDER_TUNING;
  if (current === T.nearSpacing) return dist > T.nearTileM + T.lodHysteresisM ? T.farSpacing : T.nearSpacing;
  if (current === T.farSpacing) return dist < T.nearTileM - T.lodHysteresisM ? T.nearSpacing : T.farSpacing;
  return dist <= T.nearTileM ? T.nearSpacing : T.farSpacing;
}

interface TileView {
  mesh: Mesh;
  spacing: number;
  version: number;
}

export class TerrainView {
  readonly group = new Group();
  readonly material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  private tiles: (TileView | null)[] = [];

  constructor(scene: Scene, world: TerrainSource) {
    this.group.name = 'terrain';
    scene.add(this.group);
    this.sync(world);
  }

  /** The mesh of tile `i` (null before its first sync). */
  tileMesh(i: number): Mesh | null {
    return this.tiles[i]?.mesh ?? null;
  }

  /** The spacing tile `i` is drawn at (null before its first sync). */
  tileSpacingOf(i: number): number | null {
    return this.tiles[i]?.spacing ?? null;
  }

  /** Builds or rebuilds every tile whose terrain version or level of detail changed. Without a camera, all are near. */
  sync(world: TerrainSource, cam?: Vector3): void {
    const t = world.terrain;
    if (this.tiles.length !== t.tileCount) {
      for (const v of this.tiles) v && this.drop(v);
      this.tiles = new Array<TileView | null>(t.tileCount).fill(null);
    }
    const at = (x: number, z: number) => world.cover.at(x, z);
    for (let i = 0; i < t.tileCount; i++) {
      const cur = this.tiles[i];
      const spacing = cam ? tileSpacing(tileDistance(t, i, cam.x, cam.z), cur?.spacing ?? null) : RENDER_TUNING.nearSpacing;
      if (cur && cur.version === t.version[i] && cur.spacing === spacing) continue;
      if (cur) this.drop(cur);
      const mesh = new Mesh(tileGeometry(t, i, spacing, at), this.material);
      mesh.receiveShadow = true;
      mesh.name = `tile ${i}`;
      this.group.add(mesh);
      this.tiles[i] = { mesh, spacing, version: t.version[i] };
    }
  }

  dispose(): void {
    for (const v of this.tiles) v && this.drop(v);
    this.tiles = [];
    this.material.dispose();
    this.group.removeFromParent();
  }

  private drop(v: TileView): void {
    this.group.remove(v.mesh);
    v.mesh.geometry.dispose();
  }
}

/** How many of a tile geometry's vertices are its surface (the rest are its skirts). */
export function surfaceVertexCount(g: BufferGeometry): number {
  return (g.userData.surfaceVertices as number | undefined) ?? g.getAttribute('position').count;
}

const _c = new Color();
const _grass = new Color();
const _dry = new Color();
const _dirt = new Color();
const _rock = new Color();

/**
 * Tile `tile` of `t` as a flat-shaded, vertex-coloured mesh: every `spacing`-th sim vertex (rounded to whole cells;
 * the last row and column always included), split into triangles as the sim's heightfield is (the diagonal from
 * (c + 1, r) to (c, r + 1)), so at the sim's own spacing the surface is exactly the collider's. Then a skirt
 * RENDER_TUNING.terrain.skirtM deep under each edge. `cover(x, z)` is the ground cover there (0..1).
 */
export function tileGeometry(t: Terrain, tile: number, spacing: number, cover: (x: number, z: number) => number = () => 0): BufferGeometry {
  const T = RENDER_TUNING.terrain;
  const stride = Math.max(1, Math.round(spacing / t.spacing));
  const n1 = t.cells + 1;
  const idx: number[] = [];
  for (let c = 0; c <= t.cells; c += stride) idx.push(c);
  if (idx[idx.length - 1] !== t.cells) idx.push(t.cells);
  const n = idx.length;
  const H = t.heights[tile];
  const O = t.original[tile];
  const tx = tile % t.tilesX;
  const tz = (tile - tx) / t.tilesX;
  const x0 = t.minX + tx * t.tileSize;
  const z0 = t.minZ + tz * t.tileSize;
  const skirts = 4 * n;
  const pos = new Float32Array((n * n + skirts) * 3);
  const col = new Float32Array((n * n + skirts) * 3);
  _grass.set(T.grass);
  _dry.set(T.grassDry);
  _dirt.set(T.dirt);
  _rock.set(T.rock);
  const rockCos = Math.cos((T.rockSlopeDeg * Math.PI) / 180);
  const s = t.spacing;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = idx[i];
      const r = idx[j];
      const k = j * n + i;
      const x = x0 + c * s;
      const z = z0 + r * s;
      const y = H[r + c * n1];
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      // The slope from the sim heights around the vertex (central differences over one sim cell).
      const gx = (t.heightAt(x + s, z) - t.heightAt(x - s, z)) / (2 * s);
      const gz = (t.heightAt(x, z + s) - t.heightAt(x, z - s)) / (2 * s);
      const up = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      const off = y - O[r + c * n1];
      if (Math.abs(off) > T.dugM) {
        // Dug or heaped: fresh dirt, darker the deeper it goes.
        _c.copy(_dirt).multiplyScalar(off < 0 ? Math.max(0.6, 1 + off * 0.12) : 1.05);
      } else if (up < rockCos) {
        _c.copy(_rock);
      } else {
        const cv = Math.min(1, Math.max(0, cover(x, z)));
        if (cv >= T.dryCoverFrom) _c.copy(_dry);
        else _c.copy(_grass).lerp(_dry, (0.35 * cv) / Math.max(1e-6, T.dryCoverFrom));
      }
      _c.multiplyScalar(1 + T.variation * (hash2(tx * n1 + c, tz * n1 + r) * 2 - 1));
      col[k * 3] = _c.r;
      col[k * 3 + 1] = _c.g;
      col[k * 3 + 2] = _c.b;
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
  // Skirts: a copy of every edge vertex skirtM lower, joined to the edge by quads facing out of the tile.
  let k = n * n;
  const edges: [number[], [number, number]][] = [
    [range(n, (i) => i), [0, -1]], // r = 0: −z
    [range(n, (i) => (n - 1) * n + i), [0, 1]], // r = last: +z
    [range(n, (j) => j * n), [-1, 0]], // c = 0: −x
    [range(n, (j) => j * n + n - 1), [1, 0]], // c = last: +x
  ];
  for (const [edge, out] of edges) {
    const first = k;
    for (const v of edge) {
      pos[k * 3] = pos[v * 3];
      pos[k * 3 + 1] = pos[v * 3 + 1] - T.skirtM;
      pos[k * 3 + 2] = pos[v * 3 + 2];
      col[k * 3] = col[v * 3];
      col[k * 3 + 1] = col[v * 3 + 1];
      col[k * 3 + 2] = col[v * 3 + 2];
      k++;
    }
    for (let e = 0; e + 1 < edge.length; e++) {
      const a = edge[e];
      const b = edge[e + 1];
      const a2 = first + e;
      const b2 = first + e + 1;
      pushFacing(tri, pos, [a, b, a2], out);
      pushFacing(tri, pos, [b, b2, a2], out);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(tri);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.userData.surfaceVertices = n * n;
  return g;
}

function range(n: number, f: (i: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(f(i));
  return out;
}

/** Pushes triangle `v` wound so its normal points along the horizontal `out` (x, z). */
function pushFacing(tri: number[], pos: Float32Array, v: [number, number, number], out: [number, number]): void {
  const [a, b, c] = v;
  const ux = pos[b * 3] - pos[a * 3];
  const uy = pos[b * 3 + 1] - pos[a * 3 + 1];
  const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
  const vx = pos[c * 3] - pos[a * 3];
  const vy = pos[c * 3 + 1] - pos[a * 3 + 1];
  const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
  const nx = uy * vz - uz * vy;
  const nz = ux * vy - uy * vx;
  if (nx * out[0] + nz * out[1] >= 0) tri.push(a, b, c);
  else tri.push(a, c, b);
}

/** A stable pseudo-random number in [0, 1) for a pair of integers (presentation only: never the sim's streams). */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
