// Spoil at its angle of repose (SIM-fix4; docs/M1-DESIGN.md §4.13 and its departure in docs/work/ledger.md; found by
// P29's AC-3 test): the 8 × 6 × 2.5 m pit's spoil used to be a flat 1 m ridge with sheer sides all round the pit, which
// the giant's mover refuses (RULER_BODY_TUNING.maxSlopeDeg 40°), so a charge stopped dead at its foot. Spoil now settles
// at TERRAIN_TUNING.spoilReposeDeg (34°): no triangle of spoil is steeper, the setback ring round the pit holds none (no
// lip at the rim), dirt piles' faces are no steeper, volume is conserved, the strike gates hold, a reloaded terrain
// keeps the same spoil limit, and a scripted 7 m/s charge crosses the berm to the rim without the slope limit stopping
// it (kernel-dug pit; and, with ROTW_SCENES=pit, the cached AC-2(b)/AC-3 pit scene with its cover).
//
// Scene numbers are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { physicsReady } from '../src/world/physics';
import { RULER_BODY_TUNING, RulerBodies } from '../src/world/rulerBody';
import { shapeVolume } from '../src/world/shapes';
import { Terrain, TERRAIN_TUNING } from '../src/world/terrain';
import type { V3 } from '../src/world/types';
import { digAt, dirtPileShape, isDirtPile } from '../src/world/verbs/dig';
import { cachedScene, type Harness, loadHarness, makeHarness, SCENE_BUILD_TIMEOUT_MS } from './support/worldHarness';

vi.setConfig({ testTimeout: 900_000 });

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  resetTuning('TERRAIN_TUNING');
  resetTuning('DIG_TUNING');
  vi.restoreAllMocks();
});

const PIT = { lengthX: 8, widthZ: 6, depth: 2.5 } as const;
/** Degrees of slack on the repose angle (float32 heights). */
const SLOPE_TOL_DEG = 0.01;

// ---------------------------------------------------------------------------
// Helpers (observation only)
// ---------------------------------------------------------------------------

/**
 * The steepest heightfield triangle (°) in the square of half-width r about (cx, cz) with no ever-dug vertex (each
 * cell's two triangles, split along (r+1, c)–(r, c+1), as Rapier's heightfield and Terrain.normalAt are).
 */
function maxSlopeDeg(t: Terrain, cx: number, cz: number, r: number): { deg: number; at: { x: number; z: number } } {
  const a = t.vertexIndex(cx - r, cz - r);
  const b = t.vertexIndex(cx + r, cz + r);
  const s = t.spacing;
  let most = 0;
  let at = { x: NaN, z: NaN };
  for (let gj = a.gj; gj < b.gj; gj++) {
    for (let gi = a.gi; gi < b.gi; gi++) {
      const h00 = t.vertexHeightAt(gi, gj);
      const h01 = t.vertexHeightAt(gi + 1, gj);
      const h10 = t.vertexHeightAt(gi, gj + 1);
      const h11 = t.vertexHeightAt(gi + 1, gj + 1);
      const d01 = t.isDugVertex(gi + 1, gj);
      const d10 = t.isDugVertex(gi, gj + 1);
      const tris: [boolean, number][] = [
        [!t.isDugVertex(gi, gj) && !d01 && !d10, Math.hypot(h01 - h00, h10 - h00) / s],
        [!t.isDugVertex(gi + 1, gj + 1) && !d01 && !d10, Math.hypot(h11 - h10, h11 - h01) / s],
      ];
      for (const [ok, g] of tris) {
        if (ok && g > most) {
          most = g;
          at = { x: t.minX + gi * s, z: t.minZ + gj * s };
        }
      }
    }
  }
  return { deg: (Math.atan(most) * 180) / Math.PI, at };
}

/** Σ (height − original) × cell area over the vertices within the square of half-width r about (cx, cz), m³. */
function netVolume(t: Terrain, cx: number, cz: number, r: number): number {
  const a = t.vertexIndex(cx - r, cz - r);
  const b = t.vertexIndex(cx + r, cz + r);
  let v = 0;
  for (let gj = a.gj; gj <= b.gj; gj++) for (let gi = a.gi; gi <= b.gi; gi++) v += t.vertexHeightAt(gi, gj) - t.vertexOriginalAt(gi, gj);
  return v * t.spacing * t.spacing;
}

/** The pit's rim on the row z: the least x of an ever-dug vertex within 0.5 m of the row. */
function rimX(t: Terrain, cx: number, z: number): number {
  let best = Infinity;
  for (let x = cx - 8; x <= cx; x += t.spacing) {
    for (const dz of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const v = t.vertexIndex(x, z + dz);
      if (t.isDugVertex(v.gi, v.gj)) best = Math.min(best, t.minX + v.gi * t.spacing);
    }
  }
  return best;
}

/** The ground along the row z from x0 to x1 every 0.5 m, as metres above original (for a failure's message). */
function profile(t: Terrain, z: number, x0: number, x1: number): string {
  const out: string[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += 0.5) out.push((t.heightAt(x, z) - t.originalHeightAt(x, z)).toFixed(2));
  return out.join(' ');
}

/** The berm and its setback ring round a dug pit: the highest spoil, and the highest the ring stands above original. */
function berm(t: Terrain, cx: number, cz: number, r: number): { peak: number; lip: number } {
  const a = t.vertexIndex(cx - r, cz - r);
  const b = t.vertexIndex(cx + r, cz + r);
  let peak = -Infinity;
  let lip = -Infinity;
  for (let gj = a.gj; gj <= b.gj; gj++) {
    for (let gi = a.gi; gi <= b.gi; gi++) {
      const rise = t.vertexHeightAt(gi, gj) - t.vertexOriginalAt(gi, gj);
      peak = Math.max(peak, rise);
      if (t.isNearDug(gi, gj) && !t.isDugVertex(gi, gj)) lip = Math.max(lip, rise);
    }
  }
  return { peak, lip };
}

/**
 * The RT lab's pit planner (as verbs.dig.test.ts runs it): strike centres on a 0.3 m grid over the footprint, struck in
 * passes while the vertex at the centre is above depth − 0.02 m. Returns the strike count.
 */
function digPitKernel(t: Terrain, o: { cx: number; lengthX: number; widthZ: number; depth: number }, dig: (x: number, z: number) => void): { strikes: number; passes: number } {
  const pts: [number, number][] = [];
  const x0 = -o.lengthX / 2 + 0.25;
  const z0 = -o.widthZ / 2 + 0.25;
  for (let i = 0; x0 + 0.3 * i <= -x0 + 1e-9; i++) for (let j = 0; z0 + 0.3 * j <= -z0 + 1e-9; j++) pts.push([o.cx + x0 + 0.3 * i, z0 + 0.3 * j]);
  const floor = -o.depth + 0.02;
  let strikes = 0;
  let passes = 0;
  for (; passes < 2000; passes++) {
    let any = false;
    for (const [x, z] of pts) {
      const v = t.vertexIndex(x, z);
      if (t.vertexHeightAt(v.gi, v.gj) <= floor) continue;
      any = true;
      strikes++;
      dig(x, z);
    }
    if (!any) break;
  }
  return { strikes, passes };
}

interface ChargeResult {
  /** The slope limit's cuts of the giant's move (the move it asked for, the one it got) while its root was short of the rim. */
  blocks: { tick: number; x: number; asked: number; got: number }[];
  maxX: number;
  trip: string | null;
  /** At the trip: the x of the giant's front foot (where it is set down, or stepping to). */
  tripFootX: number;
  ticks: number;
}

/**
 * A brain-off giant at (fromX, z) charging along +x at 7 m/s (the creature's script, never the terrain), stepped until
 * its root reaches `rim`, it trips, or maxTicks. Every call of the mover's slope limit (§4.7 step 2,
 * RulerBodies.slopeLimit) on it is watched.
 */
function chargeAt(h: Harness, fromX: number, z: number, rim: number, maxTicks: number): ChargeResult {
  const g: Fighter = h.creature('giantApe', { x: fromX, z }, Math.PI / 2, { brain: 'off' });
  type SlopeLimit = (f: Fighter, prev: V3, dx: number, dz: number) => [number, number];
  const proto = RulerBodies.prototype as unknown as { slopeLimit: SlopeLimit };
  const original = proto.slopeLimit;
  const blocks: ChargeResult['blocks'] = [];
  vi.spyOn(proto, 'slopeLimit').mockImplementation(function (this: unknown, f: Fighter, prev: V3, dx: number, dz: number): [number, number] {
    const r = original.call(this, f, prev, dx, dz);
    const asked = Math.hypot(dx, dz);
    const got = Math.hypot(r[0], r[1]);
    if (f === g && prev.x < rim && got < asked * 0.999) blocks.push({ tick: h.w.tick, x: prev.x, asked, got });
    return r;
  });
  h.script(g, { kind: 'charge', heading: Math.PI / 2, speed: 7 });
  let maxX = g.pos.x;
  let trip: string | null = null;
  let tripFootX = NaN;
  let t = 0;
  for (; t < maxTicks && g.pos.x < rim && !trip; t++) {
    const r = h.step();
    for (const e of r.world) {
      if (e.type === 'trip' && e.f === g) {
        trip = e.why;
        tripFootX = Math.max(...(['L', 'R'] as const).map((side) => {
          const foot = g.footwork.foot(side);
          return (foot.stepping ? foot.to : foot.pos).x;
        }));
      }
    }
    maxX = Math.max(maxX, g.pos.x);
  }
  return { blocks, maxX, trip, tripFootX, ticks: t };
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('spoil settles at its angle of repose (SIM-fix4, §4.13)', () => {
  it('spoilReposeDeg stays below the ruler mover’s and the ruler nav layer’s 40° slope limit', () => {
    expect(TERRAIN_TUNING.spoilReposeDeg).toBeGreaterThan(25);
    expect(TERRAIN_TUNING.spoilReposeDeg).toBeLessThan(RULER_BODY_TUNING.maxSlopeDeg);
  });

  it('a dirt pile’s faces are no steeper than the repose angle, even tuned steep; its volume stays exact', () => {
    const faces = (v: number): number => {
      const p = dirtPileShape(v).points;
      const a = p[3];
      const b = p[15];
      const h = p[13];
      return (Math.atan(h / (a - b)) * 180) / Math.PI;
    };
    for (const v of [0.0391, 0.1]) {
      expect(faces(v)).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + 1e-9);
      expect(shapeVolume(dirtPileShape(v))).toBeCloseTo(v, 12);
    }
    // A pile tuned tall and flat-topped (a sheer-sided box at the old rule) is held to the repose angle.
    setTuningValue('DIG_TUNING', 'pileHeightRatio', 3);
    setTuningValue('DIG_TUNING', 'pileTopRatio', 1);
    expect(faces(0.0391)).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + 1e-9);
    expect(shapeVolume(dirtPileShape(0.0391))).toBeCloseTo(0.0391, 12);
  });

  it('a reloaded terrain (generated, then the edits and the dug mask) has the live spoil limit exactly, and the same spoil points', () => {
    const a = new Terrain(null, 50);
    digPitKernel(a, { cx: 0, lengthX: 3, widthZ: 2, depth: 1.5 }, (x, z) => {
      let rest = a.lower(x, z, 1).volumeM3;
      for (let k = 0; rest > 1e-8 && k < 50; k++) {
        const s = a.findSpoilPoint(x, z);
        if (!s) break;
        rest -= a.raise(s.x, s.z, rest).raisedM3;
      }
    });
    const b = new Terrain(null, 50);
    b.generate(() => 0);
    b.applyEdits(a.edits(), a.dugVertices());
    const lo = a.vertexIndex(-10, -10);
    const hi = a.vertexIndex(10, 10);
    const diffs: string[] = [];
    for (let gj = lo.gj; gj <= hi.gj; gj++) for (let gi = lo.gi; gi <= hi.gi; gi++) if (a.spoilLimitAt(gi, gj) !== b.spoilLimitAt(gi, gj)) diffs.push(`${gi},${gj}`);
    expect(diffs.slice(0, 10)).toEqual([]);
    for (const [x, z] of [[0, 0], [1.5, 1], [-1.5, -1]]) expect(b.findSpoilPoint(x, z)).toEqual(a.findSpoilPoint(x, z));
  });

  it('a gap dug through the berm throws up no new sheer ridge: every slope outside the dug ground stays at the repose angle', () => {
    const t = new Terrain(null, 75);
    const dig = (x: number, z: number): void => {
      let rest = t.lower(x, z, 1).volumeM3;
      for (let k = 0; rest > 1e-8 && k < 100; k++) {
        const s = t.findSpoilPoint(x, z);
        if (!s) break;
        rest -= t.raise(s.x, s.z, rest).raisedM3;
      }
    };
    digPitKernel(t, { cx: 0, lengthX: 3, widthZ: 2, depth: 1.5 }, dig);
    // A 1 m deep trench out through the −x berm (P29's lab cut a gap like it through the old ridge).
    digPitKernel(t, { cx: -5, lengthX: 4, widthZ: 1.5, depth: 1 }, dig);
    const s = maxSlopeDeg(t, 0, 0, 20);
    console.info(`gap through the berm: steepest spoil triangle ${s.deg.toFixed(2)}° at (${s.at.x}, ${s.at.z}); along z 0 from x −16: ${profile(t, 0, -16, -3)}`);
    expect(s.deg).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + SLOPE_TOL_DEG);
    expect(berm(t, 0, 0, 20).lip).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(netVolume(t, 0, 0, 25))).toBeLessThan(1e-4);
  });
});

describe('the 8 × 6 × 2.5 m pit dug with piles and spoil, and a giant’s charge across its berm (SIM-fix4)', () => {
  it('no slope outside the dug ground over the repose angle, no lip at the rim, volume conserved, within 3,822 strikes and 12 piles; a 7 m/s charge reaches the rim unblocked by the slope limit', async () => {
    const h = await makeHarness({ seed: 42, size: 100 });
    try {
      const w = h.w;
      const t = w.terrain;
      w.teleport(h.p, 0, -30, 0);
      const r = digPitKernel(t, { cx: 0, ...PIT }, (x, z) => {
        digAt(w, x, z, 1, h.p);
      });
      const piles = w.entities.all().filter(isDirtPile);
      const pileVolume = piles.reduce((s, e) => s + shapeVolume(e.shape), 0);
      const slope = maxSlopeDeg(t, 0, 0, 25);
      const b = berm(t, 0, 0, 25);
      const rim = rimX(t, 0, 0);
      console.info(
        `8 × 6 × 2.5 m pit with piles and spoil: ${r.strikes} strikes, ${piles.length} piles; berm ${b.peak.toFixed(2)} m high, steepest spoil triangle ${slope.deg.toFixed(2)}° at (${slope.at.x}, ${slope.at.z}), setback ring ≤ ${b.lip.toFixed(3)} m above original; rim x ${rim}; along z 0 from x −16 (m above original): ${profile(t, 0, -16, rim)}`,
      );
      // GATES (§4.13, RT-2, AC-2(b)): it finishes within 3,822 strikes and makes ≤ 12 piles; no dirt is lost.
      expect(r.strikes).toBeLessThanOrEqual(3822);
      expect(piles.length).toBeLessThanOrEqual(TERRAIN_TUNING.maxPilesNear);
      expect(Math.abs(netVolume(t, 0, 0, 30) + pileVolume)).toBeLessThan(1e-3);
      // GATES (SIM-fix4): the spoil at the repose angle; the ring round the pit at original ground (no lip, no sheer
      // drop at the rim); the berm rises from the ring no faster than the repose slope.
      expect(slope.deg).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + SLOPE_TOL_DEG);
      expect(b.lip).toBeLessThanOrEqual(1e-6);
      expect(b.peak).toBeGreaterThan(0.5);
      expect(b.peak).toBeLessThanOrEqual(TERRAIN_TUNING.spoilMaxRiseM + 1e-6);
      // Along the charge's row, out from the rim: no step between neighbouring vertices near the giant's step height,
      // and nothing higher than the repose slope from the setback ring's edge.
      const d = t.spoilStepM();
      const tan = Math.tan((TERRAIN_TUNING.spoilReposeDeg * Math.PI) / 180);
      // (From the pair just outside the rim: the step from rim − spacing down to the rim is the pit wall.)
      for (let x = rim - 2 * t.spacing; x >= -20; x -= t.spacing) {
        const step = Math.abs(t.heightAt(x, 0) - t.heightAt(x + t.spacing, 0));
        expect(step).toBeLessThanOrEqual(d + 1e-6);
        expect(step).toBeLessThan(RULER_BODY_TUNING.stepUpMaxM);
        const out = rim - x - TERRAIN_TUNING.spoilSetbackM;
        expect(t.heightAt(x, 0) - t.originalHeightAt(x, 0)).toBeLessThanOrEqual(Math.max(0, out) * tan + 1e-6);
      }
      // The charge: from x −30 along z 0, over the −x berm toward the pit.
      const c = chargeAt(h, -30, 0, rim, 600);
      console.info(`kernel pit charge: ${c.ticks} ticks, root at most x ${c.maxX.toFixed(2)} (rim ${rim}), trip ${c.trip} (front foot x ${c.tripFootX.toFixed(2)}), slope-limit cuts before the rim ${c.blocks.length}${c.blocks.length ? ` (first at x ${c.blocks[0].x.toFixed(2)})` : ''}`);
      expect(c.blocks).toEqual([]);
      // It reached the rim: its root there, or a trip with its front foot over the pit (no cover here: the pit's own edge
      // is the ledge), never one on the berm.
      if (c.trip) expect(c.tripFootX).toBeGreaterThanOrEqual(rim - t.spacing);
      else expect(c.maxX).toBeGreaterThanOrEqual(rim);
    } finally {
      h.w.dispose();
    }
  });
});

// The cached pit (≈ 12.5 min to build cold, RT-23, synchronously in a worker): as harness.test.ts's own check of it, this
// runs only with ROTW_SCENES=pit (which builds it in globalSetup), so a plain run never waits for it; the kernel-dug pit
// above runs the same charge every time. (Measured with it: berm 1.00 m, 34.00°, ring 0.000 m, rim x −4.5, no slope-limit
// cut, a 'ledge' trip with the front foot at x −2.67, over the cover.)
const PIT_SCENE_ON = (process.env.ROTW_SCENES ?? '').split(',').includes('pit');

describe.runIf(PIT_SCENE_ON)('the cached AC-2(b)/AC-3 pit scene (SIM-fix4)', () => {
  let scene: Uint8Array;

  beforeAll(async () => {
    scene = await cachedScene('pit');
  }, SCENE_BUILD_TIMEOUT_MS);

  it('its berm is at the repose angle with no lip, and a scripted 7 m/s charge from (−30, 0) is not stopped by the slope limit before the rim', async () => {
    const h = await loadHarness(scene, { nav: 'off' });
    try {
      const t = h.w.terrain;
      const slope = maxSlopeDeg(t, 0, 0, 25);
      const b = berm(t, 0, 0, 25);
      const rim = rimX(t, 0, 0);
      console.info(`pit scene: berm ${b.peak.toFixed(2)} m high, steepest spoil triangle ${slope.deg.toFixed(2)}°, ring ≤ ${b.lip.toFixed(3)} m; rim x ${rim}; along z 0 from x −16: ${profile(t, 0, -16, rim)}`);
      expect(slope.deg).toBeLessThanOrEqual(TERRAIN_TUNING.spoilReposeDeg + SLOPE_TOL_DEG);
      expect(b.lip).toBeLessThanOrEqual(1e-6);
      const c = chargeAt(h, -30, 0, rim, 600);
      console.info(`pit scene charge: ${c.ticks} ticks, root at most x ${c.maxX.toFixed(2)} (rim ${rim}), trip ${c.trip} (front foot x ${c.tripFootX.toFixed(2)}), slope-limit cuts before the rim ${c.blocks.length}${c.blocks.length ? ` (first at x ${c.blocks[0].x.toFixed(2)})` : ''}`);
      expect(c.blocks).toEqual([]);
      // It got over the berm: to the rim, or to a trip with its front foot at the rim or beyond it (the cover over the
      // pit is the weight trigger; whether that trip is the cover's is AC-3's to gate, not this test's).
      if (c.trip) expect(c.tripFootX).toBeGreaterThanOrEqual(rim - t.spacing);
      else expect(c.maxX).toBeGreaterThanOrEqual(rim);
    } finally {
      h.w.dispose();
    }
  });
});
