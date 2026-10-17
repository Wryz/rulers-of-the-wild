// Entity-spec factories shared by generation, test scenes and dev spawns (docs/M1-DESIGN.md §6.7): trees with their
// hanging vines, saplings, rope coils, sticks (8-gon prisms), logs (6-gon prisms), stones and flint (hulls), boxes,
// grass bundles, the starter axe.
//
// STUB (P05; P07 fills it): final exported signatures; every factory throws until P07.
import type { MaterialId, Quat, V3 } from './types';
import type { World } from './world';

/** A point on the ground plane. */
export interface XZ {
  x: number;
  z: number;
}

export function spawnTree(
  w: World,
  o: { at: XZ; diameter: number; height: number; vine?: { anchorH: number; lengthM: number; yaw: number } },
): { tree: number; vine: { rope: number; joint: number } | null } {
  return notImplemented('spawnTree', w, o);
}

export function spawnSapling(w: World, o: { at: XZ; diameter: number; height: number }): number {
  return notImplemented('spawnSapling', w, o);
}

export function spawnRopeCoil(w: World, o: { at: V3; material: 'vine' | 'sinew'; lengthM: number }): number {
  return notImplemented('spawnRopeCoil', w, o);
}

/** An 8-gon prism. */
export function spawnStick(
  w: World,
  o: { p: V3; q?: Quat; length: number; r: number; material?: MaterialId; sharp?: { end: 1 | -1; s: number } },
): number {
  return notImplemented('spawnStick', w, o);
}

/** A 6-gon prism. */
export function spawnLog(
  w: World,
  o: { p: V3; q?: Quat; length: number; r?: number; mass?: number; material?: MaterialId; state?: 'free' | 'anchored' | 'fixed'; snags?: number },
): number {
  return notImplemented('spawnLog', w, o);
}

/** Stone or flint hulls. */
export function spawnStone(w: World, o: { p: V3; mass: number; proto?: 0 | 1 | 2 | 3; material?: MaterialId }): number {
  return notImplemented('spawnStone', w, o);
}

export function spawnBox(
  w: World,
  o: { p: V3; q?: Quat; size: [number, number, number]; material: MaterialId; state?: 'free' | 'fixed'; look: string },
): number {
  return notImplemented('spawnBox', w, o);
}

export function spawnGrass(w: World, o: { p: V3; mass: number; size?: [number, number, number] }): number {
  return notImplemented('spawnGrass', w, o);
}

export function spawnStarterAxe(w: World, at: V3): { stick: number; head: number; joint: number } {
  return notImplemented('spawnStarterAxe', w, at);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/factory.ts: ${name} is not implemented yet (P07; called with ${args.length} arguments)`);
}
