// Navigation (docs/M1-DESIGN.md §1.5.9, §7): two tiled recast navmeshes (human r 0.4 m, ruler r 1.65 m) over the whole
// Clearing, a dirty-tile queue rebuilt a fixed number of tiles per tick (phase 16), position-only paths, and the per-tile
// walk and blocker bitmaps NavWalkable reads for ai.ts's floor probes (RF-23).
//
// STUB (P05; P12 fills it): final exported signatures and NAV_TUNING with its §9 values. Until P12 there is no navmesh:
// build, markDirty and rebuildDirty do nothing, tile versions are 0, the queries throw; NavWalkable reads every point as
// open ground (nothing solid).
// TODO "ruler nav radius" (1.65 m vs the lab's 2.5 m): NAV_TUNING.ruler.radius keeps BODY_RADIUS × 5.5 (§7).
import type { Walkable } from './collision';
import { defineTuning } from '../tuning/registry';
import type { V3 } from './types';
import type { World } from './world';

export type NavLayer = 'human' | 'ruler';

export const NAV_TUNING = defineTuning(
  'NAV_TUNING',
  'Navigation',
  {
    human: { radius: 0.4, height: 1.8, climb: 0.4, maxSlopeDeg: 45, cs: 0.2, ch: 0.2, tileVox: 32, halfExtents: [2, 4, 2], tilesPerTick: 2 },
    ruler: { radius: 1.65, height: 10, climb: 1.0, maxSlopeDeg: 40, cs: 0.5, ch: 0.25, tileVox: 32, halfExtents: [4, 6, 4], tilesPerTick: 1 },
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
    maxNodes: 2048,
    dirtyMinMoveM: 0.25,
    dirtyMinTurnDeg: 10,
    blockerMinKg: 500,
    extrudeAboveAnkleM: 0.39,
  },
  {
    human: {
      radius: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      height: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      climb: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      maxSlopeDeg: { unit: '°', source: 'NEW: MAP recast §10.3' },
      cs: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      ch: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      tileVox: { unit: 'voxels', source: 'NEW: MAP recast §10.3' },
      halfExtents: { unit: 'm', source: 'NEW: MAP recast §6, §10.3' },
      tilesPerTick: { unit: 'tiles', source: 'NEW: MAP recast §6, §10.3' },
    },
    ruler: {
      radius: { unit: 'm', source: 'DS (BODY_RADIUS × 5.5); SPEC:774' },
      height: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      climb: { unit: 'm', source: 'NEW: MAP recast §10.3' },
      maxSlopeDeg: { unit: '°', source: 'NEW: MAP recast §10.3' },
      cs: { unit: 'm', source: 'NEW' },
      ch: { unit: 'm', source: 'NEW' },
      tileVox: { unit: 'voxels', source: 'NEW' },
      halfExtents: { unit: 'm', source: 'NEW' },
      tilesPerTick: { unit: 'tiles', source: 'NEW' },
    },
    maxSimplificationError: { unit: 'voxels', source: 'NEW: MAP recast §10.3' },
    minRegionArea: { unit: 'voxels', source: 'NEW: MAP recast §10.3' },
    mergeRegionArea: { unit: 'voxels', source: 'NEW: MAP recast §10.3' },
    maxVertsPerPoly: { unit: '—', source: 'NEW: MAP recast §7.6' },
    detailSampleDist: { unit: 'voxels', source: 'NEW: MAP recast §7.6 (≥ 0.9)' },
    detailSampleMaxError: { unit: 'voxels', source: 'NEW: MAP recast §7.6' },
    maxNodes: { unit: 'nodes', source: 'NEW' },
    dirtyMinMoveM: { unit: 'm', source: 'NEW' },
    dirtyMinTurnDeg: { unit: '°', source: 'NEW' },
    blockerMinKg: { unit: 'kg', source: 'SPEC:880' },
    extrudeAboveAnkleM: { unit: 'm above original ground', source: "NEW: the giant's ankle (§7)" },
  },
);

export class NavSystem {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Full tiled build of both layers (createWorld, load). */
  build(_w: World): void {}

  findPath(layer: NavLayer, from: V3, to: V3): { points: V3[]; complete: boolean; tiles: number[]; versions: number[] } {
    return notImplemented('findPath', layer, from, to);
  }

  raycast(layer: NavLayer, from: V3, to: V3): { clear: boolean; t: number } {
    return notImplemented('raycast', layer, from, to);
  }

  /** null when nearestRef === 0 (MAP recast §7.1). */
  nearest(layer: NavLayer, p: V3): V3 | null {
    return notImplemented('nearest', layer, p);
  }

  isWalkable(layer: NavLayer, x: number, z: number): boolean {
    return notImplemented('isWalkable', layer, x, z);
  }

  tileVersion(_layer: NavLayer, _tile: number): number {
    return 0;
  }

  markDirty(_aabb: { min: V3; max: V3 }, _why: string): void {}

  /** Phase 16: up to tilesPerTick dirty tiles per layer, sorted (layer, ty, tx). */
  rebuildDirty(): void {}

  /** (layer, ty, tx), for the save. */
  dirtyQueue(): [number, number, number][] {
    return [];
  }

  /** Restores the save's dirty queue (the loader, after build). */
  restoreDirty(q: [number, number, number][]): void {
    if (q.length > 0) notImplemented('restoreDirty', q);
  }

  /** Human layer: 1 bit per 0.2 m cell, rebuilt with the tile. */
  walkBits(tile: number): Uint8Array {
    return notImplemented('walkBits', tile);
  }

  /** Fixed, anchored or blocker entity cells at 0.2 m, rebuilt with the tile. */
  blockBits(tile: number): Uint8Array {
    return notImplemented('blockBits', tile);
  }

  /** Frees both navmeshes and their queries (explicit destroy(); World.dispose, RF-24). */
  dispose(): void {}
}

/** ai.ts floor probes in world mode (§4.1): the per-tile bitmaps, never a recast or Rapier query (RF-23). */
export class NavWalkable implements Walkable {
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Unused in world mode (CombatSim's mover resolves positions). */
  resolve(): void {}

  solidAt(): null {
    return null;
  }

  isWalkable(_x: number, _z: number): boolean {
    return true;
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/nav.ts: NavSystem.${name} is not implemented yet (P12; called with ${args.length} arguments)`);
}
