// P38 (docs/M1-DESIGN.md §9, RR-7), the client's half of packages/sim/tests/noBareConstants.test.ts:
// - the scan over the client logic M1 wrote (the kill cam, the loop, moments, the verb UI, targeting, the follow
//   camera); DS's ported presentation (bodies, weapons, audio synthesis, the fight camera, the HUD) keeps its numbers
//   as code, and art data (meshes, colours) is not a starting value;
// - every registered client tuning key has a row in §9.1;
// - CLIENT_TUNING_MODULES (what tools/tuning-rows.mjs and this test import) lists every client file that registers a
//   table.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TUNING, tuningLeaves } from '@wild/sim';
import { bareConstants, type FileAllowlist, tsFiles, unusedAllowances } from '../../../packages/sim/tests/support/bareConstants';
import { uncoveredTuningKeys } from '../../../packages/sim/tests/support/tuningDoc';
import { CLIENT_TUNING_MODULES } from './support/tuningModules';

const ROOT = fileURLToPath(new URL('../src', import.meta.url));
const DOC = fileURLToPath(new URL('../../../docs/M1-DESIGN.md', import.meta.url));

/** The client logic M1 wrote that reads starting values. */
const FILES = ['game/killcam.ts', 'game/loop.ts', 'game/moments.ts', 'input/verbInput.ts', 'input/targeting.ts', 'render/followCam.ts'];

const at = (v: string, re: RegExp, why: string) => ({ v, at: re, why });
const ALLOW: FileAllowlist = {
  'game/loop.ts': [at('1000', /\(now - last\) \/ 1000/, 'milliseconds per second')],
  'input/verbInput.ts': [
    at('8', /const PITCH_SLOPED_PROBE = COMMAND_STEPS \/ 8;/, 'an eighth of a turn in command steps'),
    at('0.001', /Math\.max\(1e-3, VERB_UI_TUNING\.leanSampleM\)/, "a floor under VERB_UI_TUNING.leanSampleM so a panel edit to 0 can't make the sampling loop endless"),
  ],
  'input/targeting.ts': [
    at('12', /for \(let i = 0; i < 12; i\+\+\)/, 'alternating-projection iterations of nearestToRay (a numerical device: it converges in a few)'),
    at('24', /for \(let i = 0; i < 24; i\+\+\)/, 'bisection steps of rayTerrain (a numerical device: 2⁻²⁴ of a step)'),
  ],
  'render/followCam.ts': [
    at('16', /new PerspectiveCamera\(CAMERA_TUNING\.fov, 16 \/ 9, 0\.1,/, "the camera's aspect before the first resize (16 / 9; the canvas sets it)"),
    at('9', /new PerspectiveCamera\(CAMERA_TUNING\.fov, 16 \/ 9, 0\.1,/, "the camera's aspect before the first resize (16 / 9; the canvas sets it)"),
    at('0.1', /new PerspectiveCamera\(CAMERA_TUNING\.fov, 16 \/ 9, 0\.1,/, "the camera's near plane, DS's (render/cameraRig.ts), kept equal so a cut between the two cameras never pops"),
    at('24', /const BISECT = 24;/, 'bisection steps for the boom (a numerical device, documented in place)'),
  ],
};

describe('no bare constants in the client logic (P38, §9, RR-7)', () => {
  it('no numeric literal outside the tuning tables', () => {
    const found = bareConstants(ROOT, FILES, ALLOW).map((b) => `${b.file}:${b.line}: ${b.value}   ${b.text}`);
    expect(found).toEqual([]);
  });

  it('every allowance is still used and names a scanned file', () => {
    for (const f of Object.keys(ALLOW)) expect(FILES).toContain(f);
    expect(unusedAllowances(ROOT, ALLOW)).toEqual([]);
  });

  it('CLIENT_TUNING_MODULES names every client file that registers a tuning table', () => {
    const registering = tsFiles(ROOT, '.')
      .filter((f) => /\bdefineTuning\(\s*['"]/.test(readFileSync(`${ROOT}/${f}`, 'utf8')))
      .map((f) => f.replace(/^\.\//, '').replace(/\.ts$/, ''))
      .sort();
    expect([...CLIENT_TUNING_MODULES].sort()).toEqual(registering);
  });

  it('every registered client tuning key has a row in docs/M1-DESIGN.md §9.1', async () => {
    for (const m of CLIENT_TUNING_MODULES) await import(/* @vite-ignore */ `${ROOT}/${m}.ts`);
    const doc = readFileSync(DOC, 'utf8');
    const missing: string[] = [];
    for (const e of TUNING) {
      if (!e.folder.startsWith('Client')) continue;
      for (const k of uncoveredTuningKeys(doc, e.name, tuningLeaves(e).map((l) => l.key))) missing.push(`${e.name}.${k}`);
    }
    // A missing row: run `npx vite-node tools/tuning-rows.mjs --write` and check what it wrote.
    expect(missing).toEqual([]);
  });
});
