// The cameras (docs/M1-DESIGN.md §10.6, P34): the follow camera stays over the terrain on a 30° slope at every yaw and
// tilt, the director's follow ↔ fight blend never jumps, cuts stand on the ground they film, the cutout centres on the
// ground under the player, heavy landings are felt, and none of it touches the sim (rule 6). Driven with a fake world
// (a planar heightfield and a list of fighters) and real Fighters; real seconds at 60 frames a second.
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createPlayer, type Fighter, type RulerState, TUNING, type WorldEvent } from '@wild/sim';
import type { SimEvent } from '../src/game/ports';
import { CameraDirector, type CameraWorld, CinematicsAdapter } from '../src/render/cameraDirector';
import { CAMERA_TUNING, CameraRig, type GroundFn } from '../src/render/cameraRig';
import { Cinematics, type Shot } from '../src/render/cinematics';
import { cutoutUniforms } from '../src/render/cutout';
import { FOLLOW_TUNING, FollowCam, type LookInput } from '../src/render/followCam';
import { RENDER_TUNING } from '../src/render/terrainView';

const DT60 = 1 / 60;
const DEG = Math.PI / 180;
const NO_LOOK: LookInput = { dx: 0, dy: 0 };
/** Float slack for "at least": the clamps are exact, the arithmetic around them isn't. */
const EPS = 1e-9;

/** A plane rising at `slopeDeg` toward the ground direction `upYaw` (rad, from +z toward +x). */
function plane(slopeDeg: number, upYaw = 0): GroundFn {
  const t = Math.tan(slopeDeg * DEG);
  const sx = Math.sin(upYaw) * t;
  const sz = Math.cos(upYaw) * t;
  return (x, z) => sx * x + sz * z;
}

function fakeWorld(ground: GroundFn, fighters: Fighter[] = []): CameraWorld {
  return { terrain: { heightAt: ground }, combat: { fighters } };
}

/** A fighter standing on the ground at (x, z) (the sim's movers keep pos.y on the ground). */
function standing(ground: GroundFn, x: number, z: number, yaw = 0, scale = 1): Fighter {
  const f = createPlayer();
  f.scale = scale;
  f.pos.set(x, ground(x, z), z);
  f.yaw = yaw;
  return f;
}

/** A mouse movement (px) that turns the follow camera by `rad`. */
const mouseFor = (rad: number) => rad / FOLLOW_TUNING.mouseSens;

function director() {
  const cine = new Cinematics();
  const d = new CameraDirector(new CameraRig(), new CinematicsAdapter(cine), new FollowCam());
  return { d, cine };
}

describe('follow camera: framing and look', () => {
  it('looks at the chest from distance m back and shoulder m to the right, along its yaw and pitch', () => {
    const g = plane(0);
    const p = standing(g, 3, -2, 0.7);
    const cam = new FollowCam();
    cam.snapBehind(p);
    cam.update(DT60, fakeWorld(g, [p]), p, NO_LOOK);
    const T = FOLLOW_TUNING;
    expect(cam.yaw).toBeCloseTo(0.7, 12);
    expect(cam.pitch).toBeCloseTo(T.pitchDeg * DEG, 12);
    const { forward, right } = cam.moveBasis();
    const chest = new Vector3(p.pos.x, p.pos.y + T.lookHeight * p.scale, p.pos.z);
    const look = chest.clone().addScaledVector(right, T.shoulder);
    const pitch = T.pitchDeg * DEG;
    const want = look.clone().addScaledVector(forward, -Math.cos(pitch) * T.distance);
    want.y += Math.sin(pitch) * T.distance;
    expect(cam.camera.position.distanceTo(want)).toBeLessThan(1e-9);
    // It looks along the yaw and pitch: the view's forward is the move basis' forward, tilted down by the pitch.
    const dir = cam.camera.getWorldDirection(new Vector3());
    expect(dir.y).toBeCloseTo(-Math.sin(pitch), 9);
    expect(Math.atan2(dir.x, dir.z)).toBeCloseTo(0.7, 9);
    expect(cam.camera.far).toBe(RENDER_TUNING.cameraFar);
    expect(cam.camera.fov).toBeCloseTo(CAMERA_TUNING.fov, 9);
  });

  it('the mouse turns it right and tilts it down, the stick by the second, the wheel zooms within its limits', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const w = fakeWorld(g, [p]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    cam.update(DT60, w, p, NO_LOOK);
    const before = cam.moveBasis();
    // Mouse right: the view turns toward what was screen right.
    cam.update(DT60, w, p, { dx: mouseFor(0.3), dy: 0 });
    const after = cam.moveBasis().forward;
    expect(after.dot(before.right)).toBeCloseTo(Math.sin(0.3), 9);
    // Mouse down: looks further down, never past maxPitchDeg; up never past minPitchDeg.
    cam.update(DT60, w, p, { dx: 0, dy: mouseFor(0.1) });
    expect(cam.pitch).toBeCloseTo((FOLLOW_TUNING.pitchDeg * DEG) + 0.1, 9);
    cam.update(DT60, w, p, { dx: 0, dy: mouseFor(10) });
    expect(cam.pitch).toBeCloseTo(FOLLOW_TUNING.maxPitchDeg * DEG, 12);
    cam.update(DT60, w, p, { dx: 0, dy: -mouseFor(10) });
    expect(cam.pitch).toBeCloseTo(FOLLOW_TUNING.minPitchDeg * DEG, 12);
    // The stick: stickSens rad/s for as long as it is held.
    const yaw0 = cam.yaw;
    for (let i = 0; i < 30; i++) cam.update(DT60, w, p, { dx: 0, dy: 0, stickX: 1 });
    expect(cam.yaw - yaw0).toBeCloseTo(-FOLLOW_TUNING.stickSens * 0.5, 9);
    // Zoom: zoomStep a notch, within minDistance..maxDistance.
    cam.update(DT60, w, p, { dx: 0, dy: 0, zoom: 2 });
    expect(cam.distance).toBeCloseTo(FOLLOW_TUNING.distance + 2 * FOLLOW_TUNING.zoomStep, 9);
    cam.update(DT60, w, p, { dx: 0, dy: 0, zoom: 100 });
    expect(cam.distance).toBe(FOLLOW_TUNING.maxDistance);
    cam.update(DT60, w, p, { dx: 0, dy: 0, zoom: -100 });
    expect(cam.distance).toBe(FOLLOW_TUNING.minDistance);
  });

  it('aim mode comes in to aimDistance over aimShoulder with a narrower view, eased', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const w = fakeWorld(g, [p]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    cam.update(DT60, w, p, NO_LOOK);
    const far = cam.camera.position.clone();
    cam.update(DT60, w, p, { dx: 0, dy: 0, aim: true });
    // (Eased: one frame in, it has only started to move.)
    expect(cam.camera.position.distanceTo(far)).toBeLessThan(0.5);
    for (let i = 0; i < 120; i++) cam.update(DT60, w, p, { dx: 0, dy: 0, aim: true });
    const T = FOLLOW_TUNING;
    const chest = new Vector3(0, T.lookHeight, 0);
    const look = chest.clone().addScaledVector(cam.moveBasis().right, T.aimShoulder);
    expect(cam.camera.position.distanceTo(look)).toBeCloseTo(T.aimDistance, 3);
    expect(cam.camera.fov).toBeCloseTo(CAMERA_TUNING.fov * T.aimFovMul, 3);
  });
});

describe('follow camera over the terrain', () => {
  it('stays at least clearance (0.35 m) over a 30° slope at every yaw, tilt and zoom', () => {
    const clear = FOLLOW_TUNING.clearance;
    expect(clear).toBe(0.35);
    let checked = 0;
    let lowest = Infinity;
    for (const upYaw of [0, 50 * DEG, 200 * DEG]) {
      const g = plane(30, upYaw);
      for (const [px, pz] of [
        [0, 0],
        [7.3, -4.1],
      ]) {
        const p = standing(g, px, pz, 0.4);
        const w = fakeWorld(g, [p]);
        for (const pitchDeg of [FOLLOW_TUNING.minPitchDeg, -10, 0, FOLLOW_TUNING.pitchDeg, 35, FOLLOW_TUNING.maxPitchDeg]) {
          for (const dist of [FOLLOW_TUNING.minDistance, FOLLOW_TUNING.distance, FOLLOW_TUNING.maxDistance]) {
            for (const aim of [false, true]) {
              const cam = new FollowCam();
              cam.snapBehind(p);
              cam.pitch = pitchDeg * DEG;
              cam.distance = dist;
              // A full turn a degree a frame, every frame checked (the eased lift included).
              for (let i = 0; i <= 360; i++) {
                cam.update(DT60, w, p, { dx: i === 0 ? 0 : mouseFor(DEG), dy: 0, aim });
                const c = cam.camera.position;
                const above = c.y - g(c.x, c.z);
                lowest = Math.min(lowest, above);
                expect(above).toBeGreaterThanOrEqual(clear - EPS);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(3 * 2 * 6 * 3 * 2 * 361);
    // (It does come down to the clearance somewhere: the slope is what holds it up.)
    expect(lowest).toBeLessThan(clear + 0.05);
  });

  it('also while turning fast and walking across the slope, and through the director with the shake on', () => {
    const g = plane(30, 1.1);
    const p = standing(g, 0, 0, 0);
    const w = fakeWorld(g, [p]);
    const { d } = director();
    d.snapBehind(p);
    for (let i = 0; i < 600; i++) {
      // Walking a circle at 3.8 m/s while the mouse swings back and forth and tilts the view up and down.
      const a = i * DT60 * 0.6;
      const x = Math.sin(a) * 6;
      const z = Math.cos(a) * 6 - 6;
      p.pos.set(x, g(x, z), z);
      d.shake(0.4);
      d.update(DT60, w, p, null, { dx: Math.sin(i * 0.05) * 60, dy: Math.cos(i * 0.031) * 25 });
      const c = d.camera.position;
      expect(c.y - g(c.x, c.z)).toBeGreaterThanOrEqual(FOLLOW_TUNING.clearance - EPS);
    }
    expect(d.shakeTrauma).toBeGreaterThan(0);
  });

  it("the fight camera stays groundClearanceM over the slope whichever side the fight is on", () => {
    const g = plane(30, 0.3);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      const p = standing(g, 0, 0);
      const t = standing(g, Math.sin(a) * 3, Math.cos(a) * 3, 0, k % 2 ? 5.5 : 1.1);
      const rig = new CameraRig();
      rig.ground = g;
      rig.snap(p, t);
      for (let i = 0; i < 90; i++) {
        rig.update(DT60, p, t);
        const c = rig.camera.position;
        expect(c.y - g(c.x, c.z)).toBeGreaterThanOrEqual(CAMERA_TUNING.groundClearanceM - EPS);
      }
    }
  });
});

describe('the spring arm: the boom comes in before it lifts, so the view turns where it is asked', () => {
  /** The view's pitch (rad, positive looking down). */
  const viewPitch = (cam: FollowCam) => {
    const d = cam.camera.getWorldDirection(new Vector3());
    return Math.atan2(-d.y, Math.hypot(d.x, d.z));
  };

  it('on flat ground every pitch asked for is the pitch seen, at every zoom', () => {
    const g = plane(0);
    for (const dist of [FOLLOW_TUNING.minDistance, FOLLOW_TUNING.distance, FOLLOW_TUNING.maxDistance]) {
      const p = standing(g, 0, 0, 0);
      const w = fakeWorld(g, [p]);
      const cam = new FollowCam();
      cam.snapBehind(p);
      cam.distance = dist;
      for (const pd of [FOLLOW_TUNING.maxPitchDeg, 14, 0, -10, -15, -20, FOLLOW_TUNING.minPitchDeg]) {
        cam.pitch = pd * DEG;
        for (let i = 0; i < 120; i++) cam.update(DT60, w, p, NO_LOOK);
        expect(viewPitch(cam), `${dist} m at ${pd}°`).toBeCloseTo(pd * DEG, 9);
        expect(cam.pitch).toBeCloseTo(pd * DEG, 12);
        const c = cam.camera.position;
        expect(c.y - g(c.x, c.z)).toBeGreaterThanOrEqual(FOLLOW_TUNING.clearance - EPS);
      }
    }
  });

  it('looking fully up at the default zoom, a look down turns the view on the very next frame', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const w = fakeWorld(g, [p]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    for (let i = 0; i < 30; i++) cam.update(DT60, w, p, { dx: 0, dy: -mouseFor(1) });
    for (let i = 0; i < 60; i++) cam.update(DT60, w, p, NO_LOOK);
    expect(cam.pitch).toBeCloseTo(FOLLOW_TUNING.minPitchDeg * DEG, 12);
    const before = cam.camera.getWorldDirection(new Vector3());
    cam.update(DT60, w, p, { dx: 0, dy: mouseFor(2 * DEG) });
    const after = cam.camera.getWorldDirection(new Vector3());
    expect(after.angleTo(before) / DEG).toBeCloseTo(2, 6);
  });

  it('when even minDistance is under the hill, the rest is lifted and the pitch becomes the one seen (no unseen pile-up)', () => {
    // Facing downhill on 30°: the camera is up the slope behind.
    const g = plane(30, 0);
    const p = standing(g, 0, 0, Math.PI);
    const w = fakeWorld(g, [p]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    for (let i = 0; i < 30; i++) cam.update(DT60, w, p, { dx: 0, dy: -mouseFor(1) });
    for (let i = 0; i < 120; i++) cam.update(DT60, w, p, NO_LOOK);
    // In as far as it goes, then lifted: it looks down more steeply than minPitchDeg, and the pitch says so.
    const c = cam.camera.position;
    expect(c.distanceTo(cam.lookPoint)).toBeGreaterThan(FOLLOW_TUNING.minDistance - 1e-9);
    expect(c.distanceTo(cam.lookPoint)).toBeLessThan(FOLLOW_TUNING.minDistance + 0.5);
    expect(cam.pitch).toBeGreaterThan(FOLLOW_TUNING.minPitchDeg * DEG + 5 * DEG);
    expect(viewPitch(cam)).toBeCloseTo(cam.pitch, 9);
    expect(c.y - g(c.x, c.z)).toBeGreaterThanOrEqual(FOLLOW_TUNING.clearance - EPS);
    // Pushing further up changes nothing and stores nothing; a look down answers at once.
    const held = cam.pitch;
    cam.update(DT60, w, p, { dx: 0, dy: -mouseFor(0.5) });
    expect(cam.pitch).toBeCloseTo(held, 9);
    const before = cam.camera.getWorldDirection(new Vector3());
    cam.update(DT60, w, p, { dx: 0, dy: mouseFor(2 * DEG) });
    const after = cam.camera.getWorldDirection(new Vector3());
    expect(after.angleTo(before) / DEG).toBeGreaterThan(1.5);
  });

  it('a ridge between the player and the camera: every one of the boomSamples points stays clearance over the ground', () => {
    // A ring-shaped ridge 2.2 m high, 2.6 m out round the player: wherever the camera turns, the boom crosses it, while
    // the camera itself (4.2 m out) would stand on flat ground — only the points along the boom see the ridge.
    const ridge: GroundFn = (x, z) => 2.2 * Math.exp(-(((Math.hypot(x, z) - 2.6) / 0.45) ** 2));
    const n = FOLLOW_TUNING.boomSamples;
    expect(n).toBe(8);
    let lowest = Infinity;
    for (const pd of [FOLLOW_TUNING.pitchDeg, 0, -10, 30]) {
      for (const dist of [FOLLOW_TUNING.distance, FOLLOW_TUNING.maxDistance]) {
        const p = standing(ridge, 0, 0, 0);
        const w = fakeWorld(ridge, [p]);
        const cam = new FollowCam();
        cam.snapBehind(p);
        cam.pitch = pd * DEG;
        cam.distance = dist;
        for (let i = 0; i <= 360; i++) {
          cam.update(DT60, w, p, { dx: i === 0 ? 0 : mouseFor(DEG), dy: 0 });
          const a = cam.lookPoint;
          const c = cam.camera.position;
          for (let k = 1; k <= n; k++) {
            const u = k / n;
            const x = a.x + (c.x - a.x) * u;
            const y = a.y + (c.y - a.y) * u;
            const z = a.z + (c.z - a.z) * u;
            const above = y - ridge(x, z);
            lowest = Math.min(lowest, above);
            expect(above, `pitch ${pd}°, ${dist} m, yaw step ${i}, point ${k}`).toBeGreaterThanOrEqual(FOLLOW_TUNING.clearance - EPS);
          }
        }
      }
    }
    // (The ridge does hold the boom up somewhere.)
    expect(lowest).toBeLessThan(FOLLOW_TUNING.clearance + 0.05);
  });
});

describe('heights over the ground, not over y = 0 (a plateau where no clamp binds)', () => {
  it('the follow camera looks at pos.y + lookHeight × scale and hangs its boom from there', () => {
    const g: GroundFn = () => 10;
    const p = createPlayer();
    p.scale = 1.1;
    // Standing on a log on the plateau.
    p.pos.set(3, 10.4, -2);
    const w = fakeWorld(g, [p]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    cam.update(DT60, w, p, NO_LOOK);
    const T = FOLLOW_TUNING;
    expect(cam.lookPoint.y).toBeCloseTo(10.4 + T.lookHeight * 1.1, 12);
    expect(cam.camera.position.y).toBeCloseTo(10.4 + T.lookHeight * 1.1 + Math.sin(T.pitchDeg * DEG) * T.distance, 9);
    const dir = cam.camera.getWorldDirection(new Vector3());
    const toLook = cam.lookPoint.clone().sub(cam.camera.position).normalize();
    expect(toLook.dot(dir)).toBeCloseTo(1, 12);
  });

  it('the fight camera stands over the ground under the fight and looks at each chest over its own feet', () => {
    const g: GroundFn = (x, z) => 10 + 0.05 * x - 0.03 * z;
    const p = standing(g, 0, 0, 0);
    const t = createPlayer();
    t.scale = 1.1;
    // The opponent up on a log, 0.6 m over the ground.
    t.pos.set(1.5, g(1.5, 3) + 0.6, 3);
    const rig = new CameraRig();
    rig.ground = g;
    rig.snap(p, t);
    const T = CAMERA_TUNING;
    const gap = Math.hypot(1.5, 3);
    const big = 0.1;
    const mx = 1.5 * T.focusMix;
    const mz = 3 * T.focusMix;
    const yaw = Math.atan2(1.5, 3) - T.sideAngle;
    const dist = T.distance + gap * 0.85 + big * 2.2;
    const want = new Vector3(mx - Math.sin(yaw) * dist, g(mx, mz) + T.rise + gap * 0.25 + big * 1.4, mz - Math.cos(yaw) * dist);
    expect(rig.camera.position.distanceTo(want)).toBeLessThan(1e-9);
    expect(rig.heading).toBeCloseTo(yaw, 12);
    const look = new Vector3(p.pos.x, p.pos.y + 1.0, p.pos.z).lerp(new Vector3(t.pos.x, t.pos.y + 1.15 * 1.1, t.pos.z), T.focusMix);
    const dir = rig.camera.getWorldDirection(new Vector3());
    expect(look.sub(rig.camera.position).normalize().dot(dir)).toBeCloseTo(1, 12);
  });

  it('out of a fight the rig sits (rise − 0.2) × scale over the feet and looks ahead at chest height over them', () => {
    const g: GroundFn = () => 10;
    const p = createPlayer();
    p.pos.set(0, 10.25, 0);
    const rig = new CameraRig();
    rig.ground = g;
    rig.snap(p);
    expect(rig.camera.position.y).toBeCloseTo(10.25 + CAMERA_TUNING.rise - 0.2, 12);
    const look = new Vector3(0, 10.25 + 1.15, 2.2);
    const dir = rig.camera.getWorldDirection(new Vector3());
    expect(look.sub(rig.camera.position).normalize().dot(dir)).toBeCloseTo(1, 12);
  });
});

describe('the director: follow ↔ fight', () => {
  /** Runs `frames` frames, returning the largest move of the camera between two frames and the last fight weight. */
  /**
   * Runs `frames` frames; over the frames that blend, the largest move of the camera between two frames (m), its largest
   * turn (°) and its largest change of fov (°).
   */
  function run(
    d: CameraDirector,
    w: CameraWorld,
    p: Fighter,
    lock: (i: number) => Fighter | null,
    frames: number,
    each?: (i: number) => void,
    look: LookInput = NO_LOOK,
  ): { maxStep: number; maxTurnDeg: number; maxFovDeg: number; blendingFrames: number } {
    let prev = d.camera.position.clone();
    let prevQ = d.camera.quaternion.clone();
    let prevFov = d.camera.fov;
    let maxStep = 0;
    let maxTurnDeg = 0;
    let maxFovDeg = 0;
    let blendingFrames = 0;
    for (let i = 0; i < frames; i++) {
      each?.(i);
      const w0 = d.fightWeight;
      d.update(DT60, w, p, lock(i), look);
      const w1 = d.fightWeight;
      if (w0 !== w1 || (w1 > 0 && w1 < 1)) {
        blendingFrames++;
        maxStep = Math.max(maxStep, d.camera.position.distanceTo(prev));
        maxTurnDeg = Math.max(maxTurnDeg, d.camera.quaternion.angleTo(prevQ) / DEG);
        maxFovDeg = Math.max(maxFovDeg, Math.abs(d.camera.fov - prevFov));
      }
      prev = d.camera.position.clone();
      prevQ = d.camera.quaternion.clone();
      prevFov = d.camera.fov;
    }
    return { maxStep, maxTurnDeg, maxFovDeg, blendingFrames };
  }

  /** No jump: under 0.5 m, 3° and 1° of fov between two frames of a blend. */
  function smooth(r: ReturnType<typeof run>): void {
    expect(r.maxStep).toBeLessThan(0.5);
    expect(r.maxTurnDeg).toBeLessThan(3);
    expect(r.maxFovDeg).toBeLessThan(1);
  }

  for (const [label, scale, gap] of [
    ['an ape', 1.1, 3],
    ['the giant', 5.5, 8],
  ] as const) {
    it(`blending into a fight with ${label} and back out never jumps (0.5 m, 3°, 1° of fov a frame)`, () => {
      const g = plane(12, 0.8);
      const p = standing(g, 0, 0, 0);
      const t = standing(g, 1.2, gap, Math.PI, scale);
      const w = fakeWorld(g, [p, t]);
      const { d } = director();
      d.snapBehind(p);
      // (Aiming, so the two cameras' fovs differ and the fov blend is exercised.)
      const aim: LookInput = { dx: 0, dy: 0, aim: true };
      run(d, w, p, () => null, 60, undefined, aim);
      expect(d.fightWeight).toBe(0);
      expect(d.camera.fov).toBeCloseTo(CAMERA_TUNING.fov * FOLLOW_TUNING.aimFovMul, 1);
      const into = run(d, w, p, () => t, 240, undefined, aim);
      expect(d.fightWeight).toBe(1);
      expect(d.camera.fov).toBeCloseTo(CAMERA_TUNING.fov, 6);
      expect(into.blendingFrames).toBeGreaterThanOrEqual(Math.floor(FOLLOW_TUNING.blendS * 60) - 1);
      smooth(into);
      const out = run(d, w, p, () => null, 240, undefined, aim);
      expect(d.fightWeight).toBe(0);
      expect(out.blendingFrames).toBeGreaterThanOrEqual(Math.floor(FOLLOW_TUNING.blendS * 60) - 1);
      smooth(out);
    });
  }

  it('also with the player walking, the target circling and the lock flickering on and off', () => {
    const g = plane(20, 2.2);
    const p = standing(g, 0, 0, 0);
    const t = standing(g, 0, 4, Math.PI, 1.1);
    const w = fakeWorld(g, [p, t]);
    const { d } = director();
    d.snapBehind(p);
    run(d, w, p, () => null, 30);
    const res = run(
      d,
      w,
      p,
      (i) => (Math.floor(i / 17) % 2 === 0 ? t : null),
      600,
      (i) => {
        const x = i * DT60 * 1.4;
        p.pos.set(x, g(x, 0), 0);
        const a = i * DT60 * 1.2;
        const tx = x + Math.sin(a) * 4;
        const tz = Math.cos(a) * 4;
        t.pos.set(tx, g(tx, tz), tz);
      },
    );
    expect(res.blendingFrames).toBeGreaterThan(100);
    smooth(res);
  });

  it('the fight camera starts on the side of the fight the follow camera is on', () => {
    const g = plane(0);
    for (const followYaw of [0.45, -0.45]) {
      const p = standing(g, 0, 0, 0);
      const t = standing(g, 0, 3, Math.PI);
      const w = fakeWorld(g, [p, t]);
      const { d } = director();
      d.snapBehind(p);
      run(d, w, p, () => null, 10);
      d.update(DT60, w, p, null, { dx: -mouseFor(followYaw), dy: 0 });
      expect(d.follow.yaw).toBeCloseTo(followYaw, 9);
      d.update(DT60, w, p, t, NO_LOOK);
      // The fight heads along the line to the target (yaw 0) swung sideAngle to one side: the follow camera's side.
      expect(Math.sign(d.rig.heading)).toBe(Math.sign(followYaw));
      expect(Math.abs(d.rig.heading)).toBeCloseTo(CAMERA_TUNING.sideAngle, 1);
    }
  });

  it('a fight is a live target within fightRangeM; out of a fight the follow camera frames the player', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const near = standing(g, 0, FOLLOW_TUNING.fightRangeM - 0.5, Math.PI);
    const far = standing(g, 0, FOLLOW_TUNING.fightRangeM + 0.5, Math.PI);
    const w = fakeWorld(g, [p, near, far]);
    const { d } = director();
    d.snapBehind(p);
    run(d, w, p, () => far, 120);
    expect(d.fightWeight).toBe(0);
    expect(d.camera.position.distanceTo(d.follow.camera.position)).toBeLessThan(1e-9);
    run(d, w, p, () => near, 120);
    expect(d.fightWeight).toBe(1);
    // Knocked out: no longer a fight.
    near.state = 'ko';
    run(d, w, p, () => near, 120);
    expect(d.fightWeight).toBe(0);
  });

  it('moves by the active camera: the follow camera, the fight camera, and leaving a fight starts from its view', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const t = standing(g, 3, 2, Math.PI);
    const w = fakeWorld(g, [p, t]);
    const { d } = director();
    d.snapBehind(p);
    run(d, w, p, () => null, 10);
    expect(d.moveBasis().forward.distanceTo(d.follow.moveBasis().forward)).toBeLessThan(1e-12);
    run(d, w, p, () => t, 240);
    expect(d.fightWeight).toBe(1);
    expect(d.moveBasis().forward.distanceTo(d.rig.groundForward)).toBeLessThan(1e-12);
    // The fight camera's view as the fight ends: the follow camera turns to it.
    const fightDir = d.camera.getWorldDirection(new Vector3());
    d.update(DT60, w, p, null, NO_LOOK);
    expect(d.follow.yaw).toBeCloseTo(Math.atan2(fightDir.x, fightDir.z), 2);
    expect(d.follow.pitch).toBeCloseTo(Math.atan2(-fightDir.y, Math.hypot(fightDir.x, fightDir.z)), 2);
    // Mid-blend, the basis turns between the two headings.
    const mid = d.moveBasis().forward;
    expect(mid.y).toBe(0);
    expect(mid.length()).toBeCloseTo(1, 12);
  });

  it('the mouse turns the view out of a fight, not in one', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const t = standing(g, 0, 3, Math.PI);
    const w = fakeWorld(g, [p, t]);
    const { d } = director();
    d.snapBehind(p);
    d.update(DT60, w, p, null, NO_LOOK);
    const y0 = d.follow.yaw;
    d.update(DT60, w, p, null, { dx: mouseFor(0.2), dy: 0 });
    expect(d.follow.yaw).toBeCloseTo(y0 - 0.2, 9);
    run(d, w, p, () => t, 240);
    const y1 = d.follow.yaw;
    d.update(DT60, w, p, t, { dx: mouseFor(0.2), dy: 0 });
    expect(d.follow.yaw).toBe(y1);
  });

  it('a kill cam overrides both framings and hands back when it ends; the shake and punch are the gameplay view’s', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const w = fakeWorld(g, [p]);
    const { d, cine } = director();
    d.snapBehind(p);
    d.update(DT60, w, p, null, NO_LOOK);
    expect(d.camera).toBe(d.view);
    const shot: Shot = { focus: () => new Vector3(0, 1, 0), side: new Vector3(1, 0, 0), distance: 3, height: 0.5, duration: 0.5, slow: 0.2, priority: 4 };
    expect(d.cine.play(shot)).toBe(true);
    expect(d.camera).toBe(cine.camera);
    for (let i = 0; i < 40; i++) {
      d.cine.update(DT60);
      d.update(DT60, w, p, null, NO_LOOK);
    }
    expect(cine.active).toBe(false);
    expect(d.camera).toBe(d.view);
    // Slow motion tightens the view; a punch narrows it a moment.
    const fov = d.view.fov;
    d.setSlowMotion(true);
    d.update(DT60, w, p, null, NO_LOOK);
    expect(d.view.fov).toBeCloseTo(fov / CAMERA_TUNING.slowmoZoom, 6);
    d.setSlowMotion(false);
    d.punch(1);
    d.update(DT60, w, p, null, NO_LOOK);
    expect(d.view.fov).toBeLessThan(fov);
    // The rig's camera stands where the gameplay view is (main.ts picks kill-cam sides from it).
    expect(d.rig.camera.position.distanceTo(d.view.position)).toBe(0);
  });

  it('a respawn snaps the view behind the player with no blend and no shake left', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const t = standing(g, 0, 3, Math.PI);
    const w = fakeWorld(g, [p, t]);
    const { d } = director();
    d.snapBehind(p);
    run(d, w, p, () => t, 240);
    d.shake(1);
    p.pos.set(40, 0, 40);
    p.yaw = 2;
    d.snapBehind(p);
    expect(d.fightWeight).toBe(0);
    expect(d.shakeTrauma).toBe(0);
    d.update(DT60, w, p, null, NO_LOOK);
    expect(d.follow.yaw).toBeCloseTo(2, 12);
    const chest = new Vector3(40, FOLLOW_TUNING.lookHeight, 40);
    expect(d.camera.position.distanceTo(chest)).toBeLessThan(FOLLOW_TUNING.distance + 1);
  });
});

describe('the giant: pull back and tilt up', () => {
  function giantAt(g: GroundFn, x: number, z: number): Fighter {
    const f = standing(g, x, z, Math.PI, 5.5);
    f.ruler = {} as RulerState;
    // (Its rig as posed: hips and head over its feet.)
    f.rig.pelvis.pos.set(x, g(x, z) + 1.0 * 5.5, z);
    f.rig.head.pos.set(x, g(x, z) + 1.7 * 5.5, z);
    return f;
  }

  it('lengthens the boom by rulerPullbackPerScale × scale × proximity once the giant has been on screen', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const behind = giantAt(g, 0, -20);
    const w = fakeWorld(g, [p, behind]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    for (let i = 0; i < 120; i++) cam.update(DT60, w, p, NO_LOOK);
    const chest = new Vector3(0, FOLLOW_TUNING.lookHeight, 0);
    // Behind the camera, never seen: no pull-back.
    const boom = () => cam.camera.position.distanceTo(chest.clone().addScaledVector(cam.moveBasis().right, FOLLOW_TUNING.shoulder));
    expect(boom()).toBeCloseTo(FOLLOW_TUNING.distance, 6);
    // In front, 14 m away: seen, so the boom lengthens and the view tilts up.
    const ahead = giantAt(g, 0, 14);
    const w2 = fakeWorld(g, [p, ahead]);
    for (let i = 0; i < 240; i++) cam.update(DT60, w2, p, NO_LOOK);
    const near = 1 - 14 / FOLLOW_TUNING.rulerRangeM;
    expect(boom()).toBeCloseTo(FOLLOW_TUNING.distance + FOLLOW_TUNING.rulerPullbackPerScale * 5.5 * near, 3);
    const dir = cam.camera.getWorldDirection(new Vector3());
    expect(Math.asin(-dir.y)).toBeCloseTo((FOLLOW_TUNING.pitchDeg - FOLLOW_TUNING.rulerPitchDeg * near) * DEG, 3);
    // Out of range: back to normal.
    ahead.pos.set(0, 0, FOLLOW_TUNING.rulerRangeM + 5);
    for (let i = 0; i < 240; i++) cam.update(DT60, w2, p, NO_LOOK);
    expect(boom()).toBeCloseTo(FOLLOW_TUNING.distance, 3);
  });
});

describe('cuts stand on the ground (render/cinematics.ts with the ground callback)', () => {
  it('a cut looking up from a hillside stays cutFloorM over the ground under it, and sees 600 m', () => {
    const g = plane(30, 0.5);
    const c = new Cinematics();
    const adapter = new CinematicsAdapter(c);
    adapter.setGround(g);
    expect(c.ground).toBe(g);
    expect(adapter.ground).toBe(g);
    const focus = new Vector3(2, g(2, 3) + 1, 3);
    for (const side of [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, -1)]) {
      c.stop();
      expect(c.play({ focus: () => focus, side, distance: 4, height: -5, orbit: 0.8, duration: 3, slow: 0.2, priority: 6 })).toBe(true);
      for (let i = 0; i < 150; i++) {
        const p = c.camera.position;
        expect(p.y - g(p.x, p.z)).toBeGreaterThanOrEqual(CAMERA_TUNING.cutFloorM - EPS);
        c.update(DT60);
      }
    }
    expect(c.camera.far).toBe(RENDER_TUNING.cameraFar);
  });

  it('picks a clear angle with the floor on the ground: the blocked check sees the floored spot', () => {
    const g = plane(0);
    const c = new Cinematics();
    c.ground = (x, z) => g(x, z) + 10;
    const seen: number[] = [];
    c.blocked = (cam) => {
      seen.push(cam.y);
      return false;
    };
    c.play({ focus: () => new Vector3(0, 11, 0), side: new Vector3(1, 0, 0), distance: 3, height: -5, duration: 1, slow: 0.5, priority: 2 });
    expect(seen.length).toBeGreaterThan(0);
    for (const y of seen) expect(y).toBeCloseTo(10 + CAMERA_TUNING.cutFloorM, 9);
  });
});

describe('the cutout centres on the ground under the player', () => {
  it('cutoutHeightM over the terrain, not over y = 0', () => {
    const g = plane(30, 0.2);
    const p = standing(g, 5, 9, 0);
    const w = fakeWorld(g, [p]);
    const { d } = director();
    d.snapBehind(p);
    for (let i = 0; i < 10; i++) d.update(DT60, w, p, null, NO_LOOK);
    d.cutoutFocus(p.pos);
    const focus = new Vector3(5, g(5, 9) + CAMERA_TUNING.cutoutHeightM, 9);
    const cam = d.camera;
    const view = focus.clone().applyMatrix4(cam.matrixWorldInverse);
    expect(cutoutUniforms.uCutDepth.value).toBeCloseTo(view.z, 9);
    const ndc = focus.clone().project(cam);
    expect(cutoutUniforms.uCutCenter.value.x).toBeCloseTo(ndc.x, 9);
    expect(cutoutUniforms.uCutCenter.value.y).toBeCloseTo(ndc.y, 9);
    expect(cutoutUniforms.uCutRadius.value.y).toBeCloseTo(CAMERA_TUNING.cutoutRadius, 12);
  });
});

describe('heavy landings are felt (the sim’s land events)', () => {
  const land = (mass: number, speed: number, at: Vector3): SimEvent =>
    ({ type: 'land', entity: 7, f: null, point: { x: at.x, y: at.y, z: at.z }, energy: 0.5 * mass * speed * speed, mass }) satisfies WorldEvent;

  function feel(e: SimEvent): number {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const { d } = director();
    d.snapBehind(p);
    d.update(DT60, fakeWorld(g, [p]), p, null, NO_LOOK);
    d.handle(e, null as never);
    return d.shakeTrauma;
  }

  it('a heavy log landing close shakes the camera ∝ its mass and how hard it fell; a light or far one does not', () => {
    const close = new Vector3(2, 0, 1);
    const log = feel(land(300, 6, close));
    expect(log).toBeGreaterThan(0);
    expect(log).toBeLessThanOrEqual(CAMERA_TUNING.landShakeMax);
    expect(feel(land(300, 2, close))).toBeLessThan(log);
    expect(feel(land(300, 0, close))).toBe(0);
    // A thrown stone, a person-sized body: not felt (DS: only over 1.5 human masses).
    expect(feel(land(20, 6, close))).toBe(0);
    expect(feel(land(75, 6, close))).toBe(0);
    // A felled trunk 60 m off: out of range.
    expect(feel(land(738, 9, new Vector3(60, 0, 0)))).toBe(0);
    // Other events don't shake it here (the presenter's beats do).
    expect(feel({ type: 'fell', tree: 3, dir: { x: 1, y: 0, z: 0 } })).toBe(0);
  });
});

describe('cameras are presentation (rule 6) and their starting values are live', () => {
  it('a minute of camera work changes nothing about the fighters', () => {
    const g = plane(30, 1);
    const p = standing(g, 0, 0, 0.3);
    const t = standing(g, 1, 3, 2, 1.1);
    const w = fakeWorld(g, [p, t]);
    const before = JSON.stringify([p.pos, p.yaw, p.scale, p.hp, t.pos, t.yaw, t.scale, t.hp, p.target, t.target]);
    const { d } = director();
    d.snapBehind(p);
    for (let i = 0; i < 3600; i++) {
      d.update(DT60, w, p, i % 400 < 200 ? t : null, { dx: 3, dy: Math.sin(i) * 2, zoom: i % 300 === 0 ? 1 : 0 });
      d.cutoutFocus(p.pos);
      d.moveBasis();
    }
    expect(JSON.stringify([p.pos, p.yaw, p.scale, p.hp, t.pos, t.yaw, t.scale, t.hp, p.target, t.target])).toBe(before);
  });

  it('CAMERA_TUNING and FOLLOW_TUNING are registered tables with every key described', () => {
    for (const [name, table, folder] of [
      ['CAMERA_TUNING', CAMERA_TUNING, 'Client › camera'],
      ['FOLLOW_TUNING', FOLLOW_TUNING, 'Client › follow camera'],
    ] as const) {
      const entry = TUNING.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      expect(entry!.table).toBe(table);
      expect(entry!.folder).toBe(folder);
      for (const key of Object.keys(table)) {
        const meta = entry!.fields[key] as { unit?: string; source?: string } | undefined;
        expect(meta?.unit, `${name}.${key}`).toBeTruthy();
        expect(meta?.source, `${name}.${key}`).toBeTruthy();
      }
    }
    // §9.1's values.
    expect(CAMERA_TUNING).toMatchObject({ fov: 52, distance: 3.4, rise: 2.35, sideAngle: 0.6, shoulder: 0.7, turnRate: 3.2, follow: 7, shakeMul: 1, focusMix: 0.55, groundClearanceM: 0.3 });
    expect(FOLLOW_TUNING).toMatchObject({
      distance: 4.2, minDistance: 2.2, maxDistance: 7.5, zoomStep: 0.4, lookHeight: 1.55, shoulder: 0.55, clearance: 0.35,
      pitchDeg: 14, minPitchDeg: -25, maxPitchDeg: 65, mouseSens: 0.0022, stickSens: 2.6, follow: 9, boomSamples: 8,
      rulerPullbackPerScale: 0.8, rulerRangeM: 35, rulerPitchDeg: 8, blendS: 0.45, aimDistance: 2.4, aimShoulder: 0.75,
      aimFovMul: 0.85, fightRangeM: 9,
    });
  });

  it('a tuning change takes effect at once (values are read at use time)', () => {
    const g = plane(0);
    const p = standing(g, 0, 0, 0);
    const w = fakeWorld(g, [p]);
    const cam = new FollowCam();
    cam.snapBehind(p);
    const keep = FOLLOW_TUNING.lookHeight;
    try {
      FOLLOW_TUNING.lookHeight = 2.5;
      cam.update(DT60, w, p, NO_LOOK);
      const dir = cam.camera.getWorldDirection(new Vector3());
      // The view passes through the shoulder point at the new chest height.
      const look = new Vector3(0, 2.5, 0).addScaledVector(cam.moveBasis().right, FOLLOW_TUNING.shoulder);
      const toLook = look.sub(cam.camera.position).normalize();
      expect(toLook.dot(dir)).toBeCloseTo(1, 9);
    } finally {
      FOLLOW_TUNING.lookHeight = keep;
    }
  });
});

