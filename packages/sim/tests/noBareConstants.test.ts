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
const NOISE = 'the value-noise permutation table (256 entries, doubled)';
const BOX = "a box's corner indices (the face table)";
const POSE6 = "a pose's six numbers per bone (the saved zone history)";
/** An allowed site: the value, a pattern its line matches, and why it isn't a starting value. */
const at = (v: string, re: RegExp, why: string) => ({ v, at: re, why });
/** Per file: the sites whose values are not starting values, and why. */
export const ALLOW: FileAllowlist = {
  'world/shapes.ts': [
    at('16', /const ROUND_SEGMENTS = 16;/, "the facets a round shape's outline is drawn with (geometry, not a starting value)"),
    at('12', /pts\.length >= 12/, 'a hull needs four xyz points (12 numbers)'),
    at('6', /const RAPIER_BAD_FACE_VERTICES = 6;/, "Rapier 0.21's heightfield limit (documented in place)"),
    at('5', /^\[\d, \d, \d, \d\], \/\/ [+−][xyz]$/, BOX),
    at('6', /^\[\d, \d, \d, \d\], \/\/ [+−][xyz]$/, BOX),
    at('7', /^\[\d, \d, \d, \d\], \/\/ [+−][xyz]$/, BOX),
    at('8', /for \(let i = 0; i < 8; i\+\+\) out\.push\(\[i & 1/, "a box's eight corners"),
    at('6', /cross\(pb, pc\)\) \/ 6;/, "a tetrahedron's volume (÷ 6)"),
  ],
  'world/clearing.ts': [
    at('512', /Uint16Array\(512\)|i < 512/, NOISE),
    at('256', /Float64Array\(256\)|length: 256|i < 256/, NOISE),
    at('255', /& 255/, NOISE),
    at('1000', /const HARD = 1000;/, 'HARD: a broken hard rule outweighs any sum of soft scores (a scoring constant, not a layout value)'),
    at('0.1', /Math\.max\(0\.1, T\.routeSampleM\)/, "a floor under CLEARING_TUNING.routeSampleM, so a panel edit to 0 can't make the sampling loop endless"),
  ],
  'world/nav.ts': [
    at('0.9', /const DETAIL_SAMPLE_DIST_MIN = 0\.9;/, "Recast's buildPolyMeshDetail crashes below it (MAP recast §7.6)"),
    at('6', /footprint\.length < 6/, 'a footprint needs three xz points (6 numbers)'),
    at('7', /bit & 7/, BITS),
    at('8', /\/ 8\)/, BITS),
    at('14', /const REF_MAX_TILE_BITS = 14;/, "Detour's 32-bit poly refs (MAP recast §3.3)"),
    at('22', /const REF_TILE_POLY_BITS = 22;/, "Detour's 32-bit poly refs (MAP recast §3.3)"),
    at('65535', /const QUERY_INCLUDE_ALL = 0xffff;/, 'a query filter including every flag'),
    at('256', /const WALK_QUERY_MAX_POLYS = 256;/, "Detour's polygon query buffer"),
    at('0.0001', /const WALK_REACH_TOL = 1e-4;/, 'float32 (Detour) against float64 ties on the voxel grid, documented in place'),
  ],
  'world/navInput.ts': [
    at('6', /\(nz - 1\) \* 6\)/, 'two triangles (6 indices) per grid quad'),
    at('6', /fp\.length < 6/, 'a footprint needs three xz points (6 numbers)'),
  ],
  'world/groups.ts': [
    at('8', /ZONE: 0x008,/, BITS),
    at('16', /RULER_ZONE: 0x010,|<< 16/, BITS),
    at('32', /RULER_SOLID: 0x020,/, BITS),
    at('64', /DOWNED: 0x040,/, BITS),
    at('128', /ROPE: 0x080,/, BITS),
    at('65535', /& 0xffff/, BITS),
  ],
  'world/downed.ts': [at('16', />>> 16\)/, `${BITS}: a collider's membership bits are its groups' top half`)],
  'world/cover.ts': [at('255', /const BYTE = 255;/, 'a byte (the cover grid is stored in bytes)')],
  'world/felling.ts': [at('32', /Math\.PI \/ 32/, "a round section's modulus π·d³/32 (exact formula)")],
  'world/rulerBody.ts': [
    at('6', /6 \* BONES\.length/, POSE6),
    at('64', /const SOLE_CAST_MAX_HITS = 64;/, 'a bound on the entities one sole cast steps through (a loop guard)'),
  ],
  'world/world.ts': [at('64', /const SOLE_CAST_MAX_HITS = 64;/, 'a bound on the entities one sole cast steps through (a loop guard)')],
  'world/verbs/dig.ts': [at('6', /6 \* k;/, "a hexagonal ring's 6·k cells")],
  'world/verbs/place.ts': [
    at('0.001', /const (LIFT_GAP_M|PIECE_MIN_M) = 1e-3;|const min = 1e-3;/, "numerical devices of the casts (documented in place)"),
    at('0.9', /const AXIS_ALONG_UP_COS = 0\.9;/, "a box axis this close to `up` can't be the ground direction (documented in place)"),
  ],
  'world/queries.ts': [at('0.0001', /const VERTICAL_RAY_SLACK_M = 1e-4;/, 'float32 slack between the heightfield and heightAt (documented in place)')],
  'world/creatures/rulerMind.ts': [
    at('0.25', /const tri = u < 0\.25/, 'a triangle wave of one period (its quarter points)'),
    at('0.75', /const tri = u < 0\.25/, 'a triangle wave of one period (its quarter points)'),
  ],
  'world/devOps.ts': [at('100', /const CM = 100;/, 'centimetres per metre (dev positions are integer cm)')],
  'world/materials.ts': [at('1000', /const N_PER_KN = 1000;/, 'newtons per kilonewton (SPEC gives rope strength in kN)')],
  'world/collision.ts': [at('2.5', /o\.h \?\? 2\.5/, "DS's flat-ground Walkable fixture (SPEC:896 keeps it for the DS tests): a prop's default height")],
  'save/bodyState.ts': [
    at('5', /const TAG_FIGHTER = 5;/, 'a record tag of the body-state bytes'),
    at('6', /const TAG_COMBAT_RNG = 6;/, 'a record tag of the body-state bytes'),
    at('8', /this\.room\(8\);|this\.n \+= 8;/, 'bytes in a float64'),
    at('4096', /new ArrayBuffer\(4096\)/, "the byte buffer's first size (it grows)"),
  ],
  'save/load.ts': [
    at('6', /6 \* BONES\.length/, POSE6),
    at('12', /points\.length < 12/, 'a hull needs four xyz points (12 numbers)'),
    at('57', /t\.length > 60 \? `\$\{t\.slice\(0, 57\)\}/, 'error text: a value is cut to 60 characters (57 and an ellipsis)'),
    at('60', /t\.length > 60 \? /, 'error text: a value is cut to 60 characters (57 and an ellipsis)'),
    at('4294967295', /v <= 0xffffffff/, "the largest uint32 (a saved Rng's state)"),
  ],
  'sim/ruler.ts': [at('3600', /const SECONDS_PER_HOUR = 3600;/, 'seconds per hour (SPEC:506 gives wound healing per hour of play)')],
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
