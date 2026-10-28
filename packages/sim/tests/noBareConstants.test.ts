// P38 (docs/M1-DESIGN.md §9, RR-7): no bare constants. Every starting value lives in a live tuning table (SPEC:12):
// - the scan: no numeric literal in world/**, save/** or sim/{rules,ruler,impact,species}.ts (the code M1 wrote; DS's
//   ported combat, moves, poses and AI keep their tuned numbers as code, §9.3) outside the tuning tables, except maths
//   constants, numerical tolerances and the per-file allowances below, each with its reason (support/bareConstants.ts);
// - the table of tables: every registered sim tuning key has a row in §9.1 (the client's are checked by
//   apps/client/tests/tuningDoc.test.ts), so the code and the design's tables can't drift apart silently.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import '../src/index';
import { TUNING, tuningLeaves } from '../src/tuning/registry';
import { bareConstants, type FileAllowlist, tsFiles, unusedAllowances } from './support/bareConstants';
import { uncoveredTuningKeys } from './support/tuningDoc';

const ROOT = fileURLToPath(new URL('../src', import.meta.url));
const DOC = fileURLToPath(new URL('../../../docs/M1-DESIGN.md', import.meta.url));

/** §9's scope: the world, the save, and the sim files M1 wrote. */
const FILES = [...tsFiles(ROOT, 'world'), ...tsFiles(ROOT, 'save'), 'sim/rules.ts', 'sim/ruler.ts', 'sim/impact.ts', 'sim/species.ts'];

const BITS = 'bit arithmetic (masks, shifts, bytes)';
/** Per file: the values that are not starting values, and why. */
export const ALLOW: FileAllowlist = {
  'world/shapes.ts': {
    '5': "a box's corner indices (the face table)",
    '6': "a box's corner indices; a tetrahedron's volume (÷ 6); RAPIER_BAD_FACE_VERTICES, Rapier 0.21's heightfield limit",
    '7': "a box's corner indices",
    '8': "a box's eight corners",
    '12': 'a hull needs four xyz points (12 numbers)',
    '16': "ROUND_SEGMENTS: the facets a round shape's outline is drawn with (geometry, not a starting value)",
  },
  'world/clearing.ts': {
    '255': 'the value-noise permutation table (256 entries, doubled)',
    '256': 'the value-noise permutation table (256 entries, doubled)',
    '512': 'the value-noise permutation table (256 entries, doubled)',
    '1000': 'HARD: a broken hard rule outweighs any sum of soft scores (a scoring constant, not a layout value)',
    '0.1': "a floor under CLEARING_TUNING.routeSampleM, so a panel edit to 0 can't make the sampling loop endless",
  },
  'world/nav.ts': {
    '0.9': "DETAIL_SAMPLE_DIST_MIN: Recast's buildPolyMeshDetail crashes below it (MAP recast §7.6)",
    '6': 'a footprint needs three xz points (6 numbers)',
    '7': BITS,
    '8': BITS,
    '14': "REF_MAX_TILE_BITS: Detour's 32-bit poly refs (MAP recast §3.3)",
    '22': "REF_TILE_POLY_BITS: Detour's 32-bit poly refs (MAP recast §3.3)",
    '65535': 'QUERY_INCLUDE_ALL: a query filter including every flag',
    '256': "WALK_QUERY_MAX_POLYS: Detour's polygon query buffer",
    '0.0001': "WALK_REACH_TOL: float32 (Detour) against float64 ties on the voxel grid, documented in place",
  },
  'world/navInput.ts': { '6': 'two triangles (6 indices) per grid quad; a footprint needs three xz points (6 numbers)' },
  'world/groups.ts': { '8': BITS, '16': BITS, '32': BITS, '64': BITS, '128': BITS, '65535': BITS },
  'world/downed.ts': { '16': `${BITS}: a collider's membership bits are its groups' top half` },
  'world/cover.ts': { '255': 'a byte (the cover grid is stored in bytes)' },
  'world/felling.ts': { '32': "a round section's modulus π·d³/32 (exact formula)" },
  'world/rulerBody.ts': {
    '6': "a pose's six numbers per bone (the saved zone history)",
    '64': 'SOLE_CAST_MAX_HITS: a bound on the entities one sole cast steps through (a loop guard)',
  },
  'world/world.ts': { '64': 'SOLE_CAST_MAX_HITS: a bound on the entities one sole cast steps through (a loop guard)' },
  'world/verbs/dig.ts': { '6': "a hexagonal ring's 6·k cells" },
  'world/verbs/place.ts': {
    '0.001': 'LIFT_GAP_M, PIECE_MIN_M and shrinkShape\'s floor: numerical devices of the casts (documented in place)',
    '0.9': "AXIS_ALONG_UP_COS: a box axis this close to `up` can't be the ground direction (a geometric choice of axis, documented in place)",
  },
  'world/queries.ts': { '0.0001': 'VERTICAL_RAY_SLACK_M: float32 slack between the heightfield and heightAt (documented in place)' },
  'world/creatures/rulerMind.ts': { '0.25': 'a triangle wave of one period (its quarter points)', '0.75': 'a triangle wave of one period (its quarter points)' },
  'world/devOps.ts': { '100': 'centimetres per metre (dev positions are integer cm)' },
  'world/materials.ts': { '1000': 'newtons per kilonewton (SPEC gives rope strength in kN)' },
  'world/collision.ts': { '2.5': "DS's flat-ground Walkable fixture (SPEC:896 keeps it for the DS tests): a prop's default height" },
  'save/bodyState.ts': {
    '5': 'record tags of the body-state bytes',
    '6': 'record tags of the body-state bytes',
    '8': 'bytes in a float64',
    '4096': "the byte buffer's first size (it grows)",
  },
  'save/load.ts': {
    '6': "a pose's six numbers per bone (the saved zone history)",
    '12': 'a hull needs four xyz points (12 numbers)',
    '57': 'error text: a value is cut to 60 characters (57 and an ellipsis)',
    '60': 'error text: a value is cut to 60 characters (57 and an ellipsis)',
    '4294967295': "the largest uint32 (a saved Rng's state)",
  },
  'sim/ruler.ts': { '3600': 'seconds per hour (SPEC:506 gives wound healing per hour of play)' },
};

describe('no bare constants (P38, §9, RR-7)', () => {
  it('no numeric literal outside the tuning tables in world/**, save/** and sim/{rules,ruler,impact,species}.ts', () => {
    const found = bareConstants(ROOT, FILES, ALLOW).map((b) => `${b.file}:${b.line}: ${b.value}   ${b.text}`);
    expect(found).toEqual([]);
  });

  it('every allowance is still used and names a scanned file', () => {
    for (const f of Object.keys(ALLOW)) expect(FILES).toContain(f);
    expect(unusedAllowances(ROOT, ALLOW)).toEqual([]);
  });

  it('every registered sim tuning key has a row in docs/M1-DESIGN.md §9.1', () => {
    const doc = readFileSync(DOC, 'utf8');
    const missing: string[] = [];
    for (const e of TUNING) for (const k of uncoveredTuningKeys(doc, e.name, tuningLeaves(e).map((l) => l.key))) missing.push(`${e.name}.${k}`);
    // A missing row: run `npx vite-node tools/tuning-rows.mjs --write` and check what it wrote.
    expect(missing).toEqual([]);
  });
});
