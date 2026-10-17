// Ground cover (docs/M1-DESIGN.md §6.7): a grid of square cells (CLEARING_TUNING.coverCellM, 2 m) over the terrain,
// starting at its min corner, each one byte (0..255 → 0..1). Perception reads it ("crouching in undergrowth hides",
// SPEC:754), the grass renderer and the footstep sounds read it at cell centres, digging clears a cell (§4.13), and
// fire burns it in M2. Generation (generateClearing) fills it from its formula; every later change is an edit against
// the generated values, and the edits are saved (§8.3: `cover`).
//
// An empty scene has no ground cover: its GroundCover holds no grid until something writes a non-zero value, and reads
// 0 everywhere. The Clearing's grid is made by `generate`, sized from the terrain when it is made (a retuned
// coverCellM applies to the next world).
import { CLEARING_TUNING } from './clearing';
import type { World } from './world';

/** The cover grid of a world (never shared). */
interface CoverGrid {
  /** m, a cell's side. */
  readonly cellM: number;
  /** Cells along x and z. */
  readonly nx: number;
  readonly nz: number;
  /** World x and z of the grid's min corner (the terrain's). */
  readonly minX: number;
  readonly minZ: number;
  /** Current values, cell j·nx + i (i along x, j along z). */
  readonly values: Uint8Array;
  /** The generated values (edits are the cells that differ from these). */
  readonly original: Uint8Array;
}

/** Bytes per unit of cover. */
const BYTE = 255;

export class GroundCover {
  /** The world (its terrain sizes the grid). */
  readonly world: World;
  /**
   * The grid, made by `generate` (the Clearing) or by the first write of a non-zero value: null in an empty scene until
   * then. Saved as the edits against its generated values (`cover`); its size and generated values regenerate.
   */
  private grid: CoverGrid | null = null;

  constructor(world: World) {
    this.world = world;
  }

  /** Whether the world has a cover grid (generated, or written to). */
  get hasGrid(): boolean {
    return this.grid !== null;
  }

  /** m, a cell's side: the grid's, or CLEARING_TUNING.coverCellM before there is one. */
  get cellM(): number {
    return this.grid?.cellM ?? CLEARING_TUNING.coverCellM;
  }

  /** Cells along x and z (0 before there is a grid). */
  get cellsX(): number {
    return this.grid?.nx ?? 0;
  }

  get cellsZ(): number {
    return this.grid?.nz ?? 0;
  }

  /**
   * Fills the grid from `f(x, z)` (0..1, clamped) at every cell centre, as both the generated and the current values:
   * generation's call, before any edit. The grid covers the terrain from its min corner in cells of `cellM`.
   */
  generate(cellM: number, f: (x: number, z: number) => number): void {
    const g = this.makeGrid(cellM);
    for (let j = 0; j < g.nz; j++) {
      const z = g.minZ + (j + 0.5) * g.cellM;
      for (let i = 0; i < g.nx; i++) g.values[j * g.nx + i] = toByte(f(g.minX + (i + 0.5) * g.cellM, z));
    }
    g.original.set(g.values);
    this.grid = g;
  }

  /** Cover 0..1 at (x, z): its cell's value; 0 outside the grid or without one. */
  at(x: number, z: number): number {
    const g = this.grid;
    if (!g) return 0;
    const c = cellOf(g, x, z);
    return c < 0 ? 0 : g.values[c] / BYTE;
  }

  /**
   * Sets the cell under (x, z) to `v` (clamped to 0..1, stored as a byte): digging sets it to 0 (§4.13). Outside the
   * terrain nothing changes. A non-zero value where there is no grid makes one (an empty scene's, all 0 as generated).
   */
  set(x: number, z: number, v: number): void {
    if (!Number.isFinite(v)) throw new Error(`GroundCover.set: cover must be a finite number, not ${v}`);
    const b = toByte(v);
    let g = this.grid;
    if (!g) {
      if (b === 0) return;
      g = this.makeGrid(CLEARING_TUNING.coverCellM);
      this.grid = g;
    }
    const c = cellOf(g, x, z);
    if (c >= 0) g.values[c] = b;
  }

  /** The cell index under (x, z), or −1 outside the grid (or without one). */
  cellIndex(x: number, z: number): number {
    return this.grid ? cellOf(this.grid, x, z) : -1;
  }

  /** World x, z of a cell's centre. */
  cellCentre(cell: number): { x: number; z: number } {
    const g = this.grid;
    if (!g || !Number.isInteger(cell) || cell < 0 || cell >= g.values.length) throw new Error(`GroundCover.cellCentre: no cell ${cell}`);
    const i = cell % g.nx;
    const j = (cell - i) / g.nx;
    return { x: g.minX + (i + 0.5) * g.cellM, z: g.minZ + (j + 0.5) * g.cellM };
  }

  /** (cell, value 0..1) of every cell that differs from its generated value, sorted by cell: the save's `cover`. */
  edits(): [number, number][] {
    const g = this.grid;
    const out: [number, number][] = [];
    if (!g) return out;
    for (let c = 0; c < g.values.length; c++) if (g.values[c] !== g.original[c]) out.push([c, g.values[c] / BYTE]);
    return out;
  }

  /**
   * Applies saved edits over the generated cover (the loader, after generation). Each value is stored as the nearest
   * byte, so the values `edits()` gives come back exactly.
   */
  applyEdits(edits: readonly (readonly [number, number])[]): void {
    if (edits.length === 0) return;
    if (!this.grid) this.grid = this.makeGrid(CLEARING_TUNING.coverCellM);
    const g = this.grid;
    for (const [c, v] of edits) {
      if (!Number.isInteger(c) || c < 0 || c >= g.values.length) throw new Error(`GroundCover.applyEdits: no cell ${c} (${g.nx} × ${g.nz} cells)`);
      if (!(v >= 0 && v <= 1)) throw new Error(`GroundCover.applyEdits: cell ${c}'s cover ${v} is not in 0..1`);
      g.values[c] = toByte(v);
    }
  }

  /** An all-zero grid over the world's terrain in cells of `cellM`. */
  private makeGrid(cellM: number): CoverGrid {
    if (!(cellM > 0) || !Number.isFinite(cellM)) throw new Error(`GroundCover: a cell's side must be a positive number, not ${cellM}`);
    const t = this.world.terrain;
    const nx = Math.ceil((t.tilesX * t.tileSize) / cellM - 1e-9);
    const nz = Math.ceil((t.tilesZ * t.tileSize) / cellM - 1e-9);
    return { cellM, nx, nz, minX: t.minX, minZ: t.minZ, values: new Uint8Array(nx * nz), original: new Uint8Array(nx * nz) };
  }
}

/** 0..1 (clamped) → the nearest byte. */
function toByte(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * BYTE);
}

function cellOf(g: CoverGrid, x: number, z: number): number {
  const i = Math.floor((x - g.minX) / g.cellM);
  const j = Math.floor((z - g.minZ) / g.cellM);
  return i < 0 || j < 0 || i >= g.nx || j >= g.nz ? -1 : j * g.nx + i;
}
