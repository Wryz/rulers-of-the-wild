import type { WeaponId } from '../sim/weapons';
import type { ArenaShape, Obstacle } from '../world/collision';

export type ThemeId = 'ring' | 'street' | 'grocery' | 'colosseum' | 'warehouse' | 'bar' | 'dojo' | 'rooftop';

export interface ThemeDef {
  id: ThemeId;
  name: string;
  shape: ArenaShape;
  /** Solid props inside the fighting area. */
  obstacles: Obstacle[];
  playerSpawn: [number, number];
  /** Enemy spawn points (used in order; wraps around). */
  enemySpawns: [number, number][];
  /** Weapons lying around this arena, and where they can be. */
  weapons: WeaponId[];
  weaponSpots: [number, number][];
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  ring: {
    id: 'ring',
    name: 'The Ring',
    shape: { kind: 'rect', hx: 3.4, hz: 3.4 },
    obstacles: [],
    playerSpawn: [-2.2, 0.6],
    enemySpawns: [
      [2.2, -0.4],
      [2.4, 1.8],
      [2.4, -2.4],
      [0.6, -2.6],
    ],
    // Somebody always leaves a folding chair in the ring.
    weapons: ['chair'],
    weaponSpots: [[-2.5, -2.4], [2.5, 2.5], [-2.5, 2.5]],
  },
  street: {
    id: 'street',
    name: 'The Street',
    shape: { kind: 'rect', hx: 7, hz: 4.2 },
    obstacles: [
      { kind: 'box', x: 4.6, z: -3.2, hx: 1.05, hz: 0.5, h: 1.05 }, // parked car
      { kind: 'circle', x: -5.6, z: -3.6, r: 0.3, h: 0.9 }, // trash can
      { kind: 'circle', x: -1.4, z: 3.6, r: 0.18, h: 0.55 }, // hydrant
    ],
    playerSpawn: [-4, 0.5],
    enemySpawns: [
      [3.5, 0.6],
      [4.5, 2.6],
      [2, -2.2],
      [5.8, 0],
    ],
    weapons: ['bat', 'machete'],
    weaponSpots: [[-1.6, -2.9], [1.2, 3.0], [-5.4, 2.6], [5.6, 2.8]],
  },
  grocery: {
    id: 'grocery',
    name: 'Grocery Store',
    shape: { kind: 'rect', hx: 6.5, hz: 4.3 },
    obstacles: [
      { kind: 'box', x: -1.6, z: -0.6, hx: 1.6, hz: 0.35, h: 1.4 }, // aisle island
      { kind: 'box', x: 2.6, z: 1.6, hx: 1.2, hz: 0.35, h: 1.4 }, // aisle island
      { kind: 'circle', x: -4.8, z: 2.8, r: 0.45, h: 1.0 }, // cart
    ],
    playerSpawn: [-4.2, 1],
    enemySpawns: [
      [3.8, -1.4],
      [4.8, 2.8],
      [0.8, -3],
      [5.2, -3.2],
    ],
    weapons: ['cleaver', 'pan'],
    weaponSpots: [[-1.4, -1.5], [2.4, 0.7], [-4.6, -2.9], [0.4, 3.4]],
  },
  colosseum: {
    id: 'colosseum',
    name: 'The Colosseum',
    shape: { kind: 'circle', r: 8.2 },
    obstacles: [
      { kind: 'circle', x: -3.8, z: -4.2, r: 0.5, h: 1.6 }, // broken column
      { kind: 'circle', x: 4.4, z: 3.6, r: 0.5, h: 1.6 },
    ],
    playerSpawn: [-3.5, 0.8],
    enemySpawns: [
      [3.5, -0.4],
      [3.2, 2.6],
      [2.6, -3],
      [5.4, 0.8],
    ],
    weapons: ['gladius', 'axe'],
    weaponSpots: [[-1.6, 3.4], [0.6, -4.2], [-5.6, -1.6], [2.4, 5.4]],
  },
  warehouse: {
    id: 'warehouse',
    name: 'The Warehouse',
    shape: { kind: 'rect', hx: 6.2, hz: 4.2 },
    obstacles: [
      { kind: 'circle', x: -2.6, z: -1.6, r: 0.28, h: 4.5 }, // steel pillar
      { kind: 'circle', x: 2.8, z: 1.7, r: 0.28, h: 4.5 },
      { kind: 'box', x: 4.9, z: -3.1, hx: 0.6, hz: 0.6, h: 1.7 }, // crate stack
      { kind: 'box', x: -5, z: 3, hx: 0.55, hz: 0.45, h: 1.7 },
    ],
    playerSpawn: [-3.8, 0.8],
    enemySpawns: [[3.6, -0.6], [3.2, 2.6], [1.6, -3]],
    weapons: ['crowbar', 'sledgehammer'],
    weaponSpots: [[-0.6, -3.2], [0.8, 3.3], [-4.8, -2.6], [5.2, 0.8]],
  },
  bar: {
    id: 'bar',
    name: 'The Bar',
    shape: { kind: 'rect', hx: 5.8, hz: 3.9 },
    obstacles: [
      { kind: 'box', x: 0, z: -3.35, hx: 3.6, hz: 0.45, h: 1.1 }, // bar counter
      { kind: 'box', x: 3.7, z: 1.9, hx: 1.1, hz: 0.6, h: 0.8 }, // pool table
      { kind: 'circle', x: -3.3, z: 1.9, r: 0.42, h: 0.78 }, // table
      { kind: 'circle', x: -1.2, z: 2.9, r: 0.42, h: 0.78 },
    ],
    playerSpawn: [-3.6, -0.6],
    enemySpawns: [[3.2, -0.8], [1.4, 1.6], [4.6, -1.6]],
    weapons: ['cue', 'bottle'],
    weaponSpots: [[2.4, 0.9], [-1.6, -2.4], [-4.6, 0.2], [0.9, -2.3]],
  },
  dojo: {
    id: 'dojo',
    name: 'The Dojo',
    shape: { kind: 'rect', hx: 4.6, hz: 4.2 },
    obstacles: [],
    playerSpawn: [-2.8, 0.4],
    enemySpawns: [[2.8, -0.4], [2.6, 2.4], [2.2, -2.6]],
    weapons: ['katana', 'bokken'],
    weaponSpots: [[0, -3.5], [-3.6, -3.2], [3.6, 3.3], [-3.4, 3.2]],
  },
  rooftop: {
    id: 'rooftop',
    name: 'The Rooftop',
    shape: { kind: 'rect', hx: 6.6, hz: 4.3 },
    obstacles: [
      { kind: 'box', x: -4.4, z: -3.1, hx: 0.9, hz: 0.65, h: 1.1 }, // AC unit
      { kind: 'box', x: 4.6, z: 2.6, hx: 0.7, hz: 0.7, h: 2.6 }, // stairwell hut corner
      { kind: 'circle', x: 1.6, z: -2.9, r: 0.22, h: 1.4 }, // vent stack
    ],
    playerSpawn: [-3.8, 0.9],
    enemySpawns: [[3.6, -0.4], [2.8, -2.2], [5.4, -0.4]],
    weapons: ['pipe', 'fireaxe'],
    weaponSpots: [[-1.2, -3.3], [0.6, 3.3], [-5.2, 2.8], [3.4, 3.4]],
  },
};
