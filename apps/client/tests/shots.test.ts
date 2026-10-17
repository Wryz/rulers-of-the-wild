import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { pinCamera, shotParams } from '../src/dev';

// Developer screenshots (tools/shots/README.md): the boot parameters ?save, ?paused, ?cam, ?fov and ?hud, the pinned
// camera, and that main.ts reads them only in the dev server's build (import.meta.env.DEV, which production replaces
// with false, so the branch never reaches the player's bundle).
const MAIN = import.meta.glob<string>('../src/main.ts', { query: '?raw', import: 'default', eager: true })['../src/main.ts'];

describe('developer screenshot parameters', () => {
  it('are absent from a normal boot', () => {
    expect(shotParams('')).toBeNull();
    expect(shotParams('?seed=3&mode=training')).toBeNull();
  });

  it('read the save, the loop pause, the camera, the field of view and the HUD', () => {
    expect(shotParams('?save=/@fs/x/out/pit-rim.json&paused=1&cam=1,2.5,-3,0,0.5,4&fov=40&hud=0')).toEqual({
      save: '/@fs/x/out/pit-rim.json',
      paused: true,
      cam: { pos: { x: 1, y: 2.5, z: -3 }, target: { x: 0, y: 0.5, z: 4 } },
      fov: 40,
      hud: false,
    });
    expect(shotParams('?paused')).toEqual({ save: null, paused: true, cam: null, fov: null, hud: true });
    expect(shotParams('?paused=0&hud=1')).toMatchObject({ paused: false, hud: true });
    expect(shotParams('?save=')).toMatchObject({ save: null });
  });

  it('refuse a malformed camera or field of view', () => {
    expect(() => shotParams('?cam=1,2,3')).toThrow(/six numbers/);
    expect(() => shotParams('?cam=1,2,3,4,5,x')).toThrow(/six numbers/);
    expect(() => shotParams('?cam=1,2,,4,5,6')).toThrow(/six numbers/);
    expect(() => shotParams('?fov=0')).toThrow(/degrees/);
    expect(() => shotParams('?fov=wide')).toThrow(/degrees/);
  });
});

describe('the pinned camera', () => {
  it('stands where the shot says, looking at its target, after every update of the director', () => {
    const camera = new PerspectiveCamera(52, 16 / 9, 0.1, 600);
    let updates = 0;
    const cams = {
      camera,
      update(dt: number) {
        updates++;
        // The director moves its camera every frame.
        camera.position.set(dt, 9, 9);
        camera.lookAt(0, 0, 0);
      },
    };
    const target = new Vector3(0, 1, 4);
    pinCamera(cams, { pos: { x: 2, y: 3, z: -5 }, target: { x: target.x, y: target.y, z: target.z } }, 35);
    cams.update(0.016);
    cams.update(0.016);
    expect(updates).toBe(2);
    expect(camera.position.toArray()).toEqual([2, 3, -5]);
    const look = camera.getWorldDirection(new Vector3());
    const want = target.clone().sub(camera.position).normalize();
    expect(look.distanceTo(want)).toBeLessThan(1e-6);
    expect(camera.fov).toBe(35);
  });
});

describe('main.ts', () => {
  it('reads and applies the shot parameters only under import.meta.env.DEV', () => {
    const code = MAIN.replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/const shot = import\.meta\.env\.DEV \? shotParams\(location\.search\) : null;/);
    expect(code).toMatch(
      /import\.meta\.env\.DEV && shot\?\.save\s*\?\s*await \(await import\('@wild\/sim'\)\)\.loadWorld\(await fetchSave\(shot\.save\), \{ applyTuning: true \}\)/,
    );
    expect(code).toMatch(/if \(import\.meta\.env\.DEV && shot\) \{[^}]*pinCamera\(/);
    // The loader comes in only by that dynamic import: a static import of it would keep its record checkers in the
    // production bundle.
    expect(code).not.toMatch(/import\s*\{[^}]*\bloadWorld\b[^}]*\}\s*from/);
    for (const call of ['shotParams(', 'fetchSave(', 'pinCamera(']) {
      const lines = code.split('\n').filter((l) => l.includes(call) && !/^\s*import /.test(l));
      expect(lines.length, call).toBe(1);
    }
  });
});
