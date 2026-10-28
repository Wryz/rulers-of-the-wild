// Dig (docs/M1-DESIGN.md §5.10, §4.13; package P15): the dirt policy (piles merged up to pileCapKg, a new pile while
// fewer than maxPilesNear lie near, then the masked, set-back berm), its termination on a pit with piles and spoil
// within 1.2 × the no-spoil strike count (RT-2; the 3 × 2 × 1.5 m pit and §4.13's 8 × 6 × 2.5 m one, kernel-level),
// what follows a dig (exposed stakes un-anchored, the `dig` event and its noise), and the dig verb (hand-digging, the
// digging stick's aimed swing, the refusals).
//
// Kernel-level tests call digAt as a strike does (one strike = depthMul 1) without stepping the world; the strike path
// itself is verbs.strike.test.ts's. Scene numbers are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveCommand, type VerbCommand } from '../src/sim/commands';
import { resetTuning, setTuningValue } from '../src/tuning/registry';
import { NOISE_TUNING } from '../src/world/creatures/defs';
import { groundRestY, spawnLog, spawnStarterAxe, spawnStick, stickPrism } from '../src/world/factory';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import { shapeVolume } from '../src/world/shapes';
import { Terrain, TERRAIN_TUNING } from '../src/world/terrain';
import type { Entity, WorldEvent } from '../src/world/types';
import { DIG_TUNING, digAt, dirtPileShape, isDirtPile, liftBuried, placeSpoil, spoilLostM3 } from '../src/world/verbs/dig';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 300_000 });

const live: World[] = [];
async function make(seed = 41, size = 50): Promise<World> {
  const w = await createWorld({ seed, scene: 'empty', nav: 'off', size });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('VERB_TUNING');
  resetTuning('TERRAIN_TUNING');
  resetTuning('DIG_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ev<T extends WorldEvent['type']> = Extract<WorldEvent, { type: T }>;
const of = <T extends WorldEvent['type']>(evs: readonly WorldEvent[], type: T): Ev<T>[] => evs.filter((e): e is Ev<T> => e.type === type);

const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

const piles = (w: World): Entity[] => w.entities.all().filter(isDirtPile);

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): void {
  w.commands.push({ tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand);
}

function run(w: World, n: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < n; t++) out.push(...w.step().world);
  return out;
}

/** World vertices (gi, gj) within a square of half-width r around (cx, cz). */
function vertices(t: Terrain, cx: number, cz: number, r: number): [number, number][] {
  const a = t.vertexIndex(cx - r, cz - r);
  const b = t.vertexIndex(cx + r, cz + r);
  const out: [number, number][] = [];
  for (let gj = a.gj; gj <= b.gj; gj++) for (let gi = a.gi; gi <= b.gi; gi++) out.push([gi, gj]);
  return out;
}

/** Σ (height − original) × cell area within r of (cx, cz): the terrain's net volume change, m³. */
function netTerrainVolume(t: Terrain, cx: number, cz: number, r: number): number {
  let v = 0;
  for (const [gi, gj] of vertices(t, cx, cz, r)) v += t.vertexHeightAt(gi, gj) - t.vertexOriginalAt(gi, gj);
  return v * t.spacing * t.spacing;
}

/**
 * The RT lab's pit planner (as terrain.test.ts runs it): strike centres on a 0.3 m grid over the footprint, struck in
 * passes while the vertex at the centre is above depth − 0.02 m; `dig` is one strike there. Returns the strike count.
 */
function digPitKernel(t: Terrain, o: { lengthX: number; widthZ: number; depth: number }, dig: (x: number, z: number) => void): { strikes: number; passes: number } {
  const pts: [number, number][] = [];
  const x0 = -o.lengthX / 2 + 0.25;
  const z0 = -o.widthZ / 2 + 0.25;
  for (let i = 0; x0 + 0.3 * i <= -x0 + 1e-9; i++) for (let j = 0; z0 + 0.3 * j <= -z0 + 1e-9; j++) pts.push([x0 + 0.3 * i, z0 + 0.3 * j]);
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

// ---------------------------------------------------------------------------
// The dirt policy (§4.13)
// ---------------------------------------------------------------------------

describe('where the dirt goes (§4.13)', () => {
  it('a pile is a low 8-point hull of exactly the dug volume; it grows by rescaling while it stays ≤ pileCapKg', async () => {
    const s = dirtPileShape(0.0391);
    expect(s.points).toHaveLength(24);
    expect(shapeVolume(s)).toBeCloseTo(0.0391, 12);
    const ys = s.points.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBe(0);
    const a = s.points[3];
    expect(Math.max(...ys)).toBeCloseTo(DIG_TUNING.pileHeightRatio * a, 12);
    expect(Math.max(...ys)).toBeLessThan(a);

    const w = await make();
    const p = w.player!;
    w.teleport(p, -10, -10, 0);
    const rho = MATERIALS[TERRAIN_TUNING.material].density;
    const first = placeSpoil(w, 0, 0, 0.0391, ['p1']);
    expect(first.pile).not.toBeNull();
    const pile = ent(w, first.pile!);
    // Set down at rest on the ground, VERB_TUNING.placeDropM clear (as Place sets a thing down).
    expect(pile.pose.p.y - groundRestY(w, pile.pose.p.x, pile.pose.p.z, pile.shape, pile.pose.q)).toBeCloseTo(VERB_TUNING.placeDropM, 5);
    expect(pile.material).toBe('dirt');
    expect(pile.state).toBe('free');
    expect(pile.credit).toEqual(['p1']);
    expect(pile.mass).toBeCloseTo(0.0391 * rho, 9);
    // Within pileMergeR of the next spoil point and under the cap: it grows (mass += 58.7 kg).
    expect(placeSpoil(w, 0, 0, 0.0391, ['p1']).pile).toBe(pile.id);
    expect(pile.mass).toBeCloseTo(2 * 0.0391 * rho, 9);
    expect(shapeVolume(pile.shape)).toBeCloseTo(2 * 0.0391, 12);
    // A third would take it past 150 kg: a new pile, beside it (never on top of it).
    const third = placeSpoil(w, 0, 0, 0.0391, ['p1']).pile!;
    expect(third).not.toBe(pile.id);
    expect(ent(w, third).mass).toBeCloseTo(0.0391 * rho, 9);
    for (const e of piles(w)) expect(e.mass).toBeLessThanOrEqual(TERRAIN_TUNING.pileCapKg + 1e-9);
    const d = Math.hypot(ent(w, third).pose.p.x - pile.pose.p.x, ent(w, third).pose.p.z - pile.pose.p.z);
    expect(d).toBeGreaterThan(0.5);
    run(w, 60);
    for (const e of piles(w)) expect(e.pose.p.y).toBeLessThan(0.2);
  });

  it('30 strikes in one spot make ≤ 12 piles, then a berm that never lands within 1.5 m of the hole; no dirt is lost', async () => {
    const w = await make();
    const p = w.player!;
    w.teleport(p, -12, -12, 0);
    const t = w.terrain;
    let dug = 0;
    let bermDigs = 0;
    let most = 0;
    for (let k = 0; k < 30; k++) {
      const r = digAt(w, 0, 0, 1, p);
      dug += r.volumeM3;
      if (r.pile === null) bermDigs++;
      most = Math.max(most, piles(w).length);
      expect(piles(w).length, `strike ${k + 1}`).toBeLessThanOrEqual(TERRAIN_TUNING.maxPilesNear);
      run(w, 20);
    }
    console.info(`30 strikes in one spot: ${most} piles, ${bermDigs} strikes to the berm, ${dug.toFixed(4)} m³ dug`);
    expect(most).toBe(TERRAIN_TUNING.maxPilesNear);
    expect(bermDigs).toBeGreaterThan(0);
    // Every pile lies near, every one is the digger's, none over 150 kg.
    for (const e of piles(w)) {
      expect(Math.hypot(e.pose.p.x, e.pose.p.z)).toBeLessThan(TERRAIN_TUNING.pilesNearR);
      expect(e.credit).toEqual(['p1']);
      expect(e.mass).toBeLessThanOrEqual(TERRAIN_TUNING.pileCapKg + 1e-9);
    }
    // The berm: every raised vertex at least spoilSetbackM from every ever-dug vertex (RT-2).
    const near = vertices(t, 0, 0, 16);
    const dugV = near.filter(([gi, gj]) => t.isDugVertex(gi, gj));
    const raised = near.filter(([gi, gj]) => t.vertexHeightAt(gi, gj) > t.vertexOriginalAt(gi, gj) + 1e-6);
    expect(dugV.length).toBeGreaterThan(0);
    expect(raised.length).toBeGreaterThan(0);
    let closest = Infinity;
    for (const [ri, rj] of raised) for (const [di, dj] of dugV) closest = Math.min(closest, Math.hypot(ri - di, rj - dj) * t.spacing);
    expect(closest).toBeGreaterThan(TERRAIN_TUNING.spoilSetbackM);
    // Nothing lost: the terrain's net change plus the piles' volume is zero (float32 heights aside).
    const pileVolume = piles(w).reduce((s, e) => s + shapeVolume(e.shape), 0);
    expect(Math.abs(netTerrainVolume(t, 0, 0, 16) + pileVolume)).toBeLessThan(1e-4);
    // Only float32 rounding of the raised heights went unplaced (grams of dirt), and it was counted.
    expect(spoilLostM3(w)).toBeLessThan(1e-5);
    expect(Math.abs(netTerrainVolume(t, 0, 0, 16) + pileVolume + spoilLostM3(w))).toBeLessThan(1e-4);
  });

  it('a 3 × 2 × 1.5 m pit dug with piles and spoil finishes within 1.2 × its no-spoil strike count (RT-2)', async () => {
    const pit = { lengthX: 3, widthZ: 2, depth: 1.5 };
    const bare = new Terrain(null, 50);
    const noSpoil = digPitKernel(bare, pit, (x, z) => bare.lower(x, z, 1));
    const w = await make();
    const p = w.player!;
    w.teleport(p, -15, -15, 0);
    let dug = 0;
    const withSpoil = digPitKernel(w.terrain, pit, (x, z) => {
      dug += digAt(w, x, z, 1, p).volumeM3;
    });
    console.info(`3 × 2 × 1.5 m pit: ${withSpoil.strikes} strikes with piles and spoil (${withSpoil.passes} passes), ${noSpoil.strikes} with none`);
    expect(withSpoil.passes).toBeLessThan(2000); // it finishes
    expect(withSpoil.strikes).toBeLessThanOrEqual(1.2 * noSpoil.strikes);
    expect(piles(w).length).toBeLessThanOrEqual(TERRAIN_TUNING.maxPilesNear);
    const pileVolume = piles(w).reduce((s, e) => s + shapeVolume(e.shape), 0);
    expect(Math.abs(netTerrainVolume(w.terrain, 0, 0, 20) + pileVolume)).toBeLessThan(1e-4);
    expect(dug).toBeGreaterThan(0);
  });

  it('the 8 × 6 × 2.5 m pit with piles and spoil finishes within 1.2 × 3,185 = 3,822 strikes (§4.13, RT-2)', async () => {
    const w = await make(42, 75);
    const p = w.player!;
    w.teleport(p, -30, -30, 0);
    const seen = new Set<number>();
    let crowded = 0;
    const r = digPitKernel(w.terrain, { lengthX: 8, widthZ: 6, depth: 2.5 }, (x, z) => {
      const d = digAt(w, x, z, 1, p);
      if (d.pile === null || seen.has(d.pile)) return;
      seen.add(d.pile);
      // A new pile is made only while fewer than maxPilesNear lie within pilesNearR of the spoil point (§4.13).
      const S = d.spoil[0];
      const near = piles(w).filter((e) => Math.hypot(e.pose.p.x - S.x, e.pose.p.z - S.z) <= TERRAIN_TUNING.pilesNearR).length;
      if (near > TERRAIN_TUNING.maxPilesNear) crowded++;
    });
    console.info(`8 × 6 × 2.5 m pit: ${r.strikes} strikes with piles and spoil in ${r.passes} passes; ${piles(w).length} piles in all`);
    expect(r.passes).toBeLessThan(2000);
    expect(r.strikes).toBeLessThanOrEqual(3822); // GATE (RT-2)
    expect(crowded).toBe(0);
    // The per-pit budget (§4.13, AC-2(b): "≤ 12 piles"): pilesNearR (15 m) takes in the pit's whole spoil ring.
    expect(piles(w).length).toBeLessThanOrEqual(TERRAIN_TUNING.maxPilesNear);
    expect(spoilLostM3(w)).toBeLessThan(1e-4);
    const pileVolume = piles(w).reduce((s, e) => s + shapeVolume(e.shape), 0);
    expect(Math.abs(netTerrainVolume(w.terrain, 0, 0, 25) + pileVolume)).toBeLessThan(1e-3);
  });
});

describe('where a new pile goes, and dirt never lost (§4.13)', () => {
  it('a new pile is never set down on another entity, nor past the terrain’s edge', async () => {
    // Where the first pile of a dig at (0, 0) goes in an empty world: S.
    const bare = await make(43);
    bare.teleport(bare.player!, -15, -15, 0);
    const S = digAt(bare, 0, 0, 1, null).spoil[0];
    // The same dig with a log lying across S: the pile goes beside it, overlapping nothing.
    const w = await make(43);
    w.teleport(w.player!, -15, -15, 0);
    const log = spawnLog(w, { p: { x: S.x, y: 0.12, z: S.z }, length: 1.2, mass: 20 });
    run(w, 30);
    const r = digAt(w, 0, 0, 1, null);
    expect(r.spoil[0]).toEqual(S);
    const pile = ent(w, r.pile!);
    expect(Math.hypot(pile.pose.p.x - S.x, pile.pose.p.z - S.z)).toBeGreaterThan(0.3);
    w.step();
    expect(w.queries.overlaps(pile.shape, pile.pose, { terrain: false, entities: 'all', exclude: { entities: [pile.id] } })).toEqual([]);
    expect(ent(w, log).pose.p.y).toBeLessThan(0.2);
    // At the edge: a dig whose spoil point is the terrain's last vertex sets its pile down inside the terrain.
    const t = w.terrain;
    const edge = t.minX + t.tilesX * t.tileSize;
    const e = digAt(w, edge - 2, 5, 1, null);
    expect(e.spoil[0].x).toBeGreaterThan(edge - 0.3);
    const ep = ent(w, e.pile!);
    const a = ep.shape.kind === 'hull' ? ep.shape.points[3] : NaN;
    expect(ep.pose.p.x + a).toBeLessThanOrEqual(edge + 1e-9);
  });

  it('dirt the berm can’t take (no spoil point within reach) is set down as a pile beyond the dug ground, not lost', async () => {
    const w = await make();
    w.teleport(w.player!, -15, -15, 0);
    // The spoil search reaches only its first ring (1.0 m out), inside the setback of any dig's own dug ground: no spoil
    // point lies within reach of a dig (§4.13 would leave its dirt nowhere).
    setTuningValue('TERRAIN_TUNING', 'spoilSearchMaxM', TERRAIN_TUNING.digRadiusM + TERRAIN_TUNING.spoilMinGapM);
    const r = digAt(w, 3, 3, 1, null);
    expect(w.terrain.findSpoilPoint(3, 3)).toBeNull();
    // Its dirt: a pile at the nearest free spot beyond the dug ground and its setback.
    expect(r.pile).not.toBeNull();
    const far = ent(w, r.pile!);
    const rho = MATERIALS[TERRAIN_TUNING.material].density;
    expect(far.mass).toBeCloseTo(r.volumeM3 * rho, 9);
    const t = w.terrain;
    const v = t.vertexIndex(far.pose.p.x, far.pose.p.z);
    expect(t.isNearDug(v.gi, v.gj)).toBe(false);
    // The next dig's dirt grows it (it lies within pileMergeR of the next free spot and stays under the cap).
    const r2 = digAt(w, 3, 3, 1, null);
    expect(r2.pile).toBe(r.pile);
    expect(far.mass).toBeCloseTo((r.volumeM3 + r2.volumeM3) * rho, 9);
    expect(spoilLostM3(w)).toBe(0);
    const pileVolume = piles(w).reduce((s, e) => s + shapeVolume(e.shape), 0);
    expect(Math.abs(netTerrainVolume(t, 3, 3, 10) + pileVolume)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// After a dig (§4.13)
// ---------------------------------------------------------------------------

describe('after a dig (§4.13)', () => {
  it('a stake whose driven end the dig exposes is un-anchored (free, awake); one still driven stays anchored', async () => {
    const w = await make();
    w.teleport(w.player!, -10, -10, 0);
    const stake = (x: number): number =>
      w.entities.create({ material: 'dryWood', shape: stickPrism(1.4, 0.05), p: { x, y: 0.7 - VERB_TUNING.stakeAnchorDepthM, z: 0 }, state: 'anchored', look: 'stake' }).id;
    const near = stake(1);
    const far = stake(3);
    w.step();
    expect(ent(w, near).state).toBe('anchored');
    // Two strikes leave its ring still 0.03 m in the ground; the third bares it.
    digAt(w, 1, 0, 1, null);
    digAt(w, 1, 0, 1, null);
    expect(ent(w, near).state).toBe('anchored');
    digAt(w, 1, 0, 1, null);
    expect(ent(w, near).state).toBe('free');
    expect(ent(w, near).body?.isDynamic()).toBe(true);
    expect(ent(w, near).body?.isSleeping()).toBe(false);
    expect(ent(w, far).state).toBe('anchored');
  });

  it('a body spoil buries is lifted clear and stays in the world (P38: the dirt pile that fell to y −1.3e6, P29)', async () => {
    // A resting pile with 0.46 m of spoil raised under it (terrain.raise, what the berm does): Rapier pushes a body whose
    // centre is under the heightfield's surface down, out of the world. digAt ends with liftBuried round what it changed.
    const bury = async (lift: boolean): Promise<{ y: number; ground: number; deepest: number; impaled: number }> => {
      const w = await make();
      w.teleport(w.player!, -15, -15, 0);
      const id = w.entities.create({ material: TERRAIN_TUNING.material, shape: dirtPileShape(0.1), p: { x: 3, y: w.terrain.heightAt(3, 3) + 0.01, z: 3 }, look: 'pile' }).id;
      run(w, 200);
      w.terrain.raise(3, 3, 0.3);
      if (lift) liftBuried(w, [{ x: 3, z: 3 }]);
      run(w, 300);
      const e = ent(w, id);
      // The terrain under its middle against its underside there (its base, the hull's y = 0).
      return { y: e.pose.p.y, ground: w.terrain.heightAt(e.pose.p.x, e.pose.p.z), deepest: w.entities.depthBelowGround(e.shape, e.pose), impaled: w.terrain.heightAt(e.pose.p.x, e.pose.p.z) - e.pose.p.y };
    };
    const control = await bury(false);
    const fixed = await bury(true);
    expect(control.y, JSON.stringify(control)).toBeLessThan(control.ground - 1);
    expect(fixed.deepest, JSON.stringify(fixed)).toBeLessThanOrEqual(DIG_TUNING.buriedLiftMinM);
    expect(fixed.impaled, JSON.stringify(fixed)).toBeLessThanOrEqual(DIG_TUNING.buriedLiftMinM);
    expect(fixed.y, JSON.stringify(fixed)).toBeGreaterThan(fixed.ground - DIG_TUNING.buriedLiftMinM);
  });
});

// ---------------------------------------------------------------------------
// The dig verb (§5.10)
// ---------------------------------------------------------------------------

describe('the dig verb (§5.10)', () => {
  it('hand-digging: empty hands scoop every handDigFrames at handDigDepthMul of a strike, heard 15 m off, until the player moves', async () => {
    const w = await make();
    const p = w.player!;
    w.teleport(p, 0, 0, 0);
    w.step();
    const ref = new Terrain(null, 50);
    const scoop = ref.lower(0, 0.6, VERB_TUNING.handDigDepthMul).volumeM3;
    verb(w, { verb: 'dig', target: 0, at: [0, 0, 60], charge: 1 });
    // Three scoops, one each handDigFrames (each a committed work action, the dirt moving at handDigActFrac of it).
    const evs: WorldEvent[] = [];
    const at: number[] = [];
    for (let t = 0; t < 4 * VERB_TUNING.handDigFrames && at.length < 3; t++) {
      const r = w.step();
      evs.push(...r.world);
      if (r.world.some((e) => e.type === 'dig')) at.push(w.tick);
    }
    expect(at).toHaveLength(3);
    expect([at[1] - at[0], at[2] - at[1]]).toEqual([VERB_TUNING.handDigFrames, VERB_TUNING.handDigFrames]);
    const digs = of(evs, 'dig');
    for (const d of digs) {
      expect(d.volumeM3).toBeCloseTo(scoop, 9);
      expect(d.point.x).toBeCloseTo(0, 9);
      expect(d.point.z).toBeCloseTo(0.6, 9);
    }
    expect(of(evs, 'verb').filter((v) => v.verb === 'dig' && v.ok)).toHaveLength(3);
    // The noise bus heard each (§6.2: a dig carries NOISE_TUNING.dig).
    expect(of(evs, 'noise').filter((n) => n.kind === 'dig').map((n) => n.radius)).toEqual([NOISE_TUNING.dig, NOISE_TUNING.dig, NOISE_TUNING.dig]);
    // The player walks off as the third scoop lands: that scoop's action plays out (committed, §5.0), the next never
    // starts ("strokes until … the player moves", §5.4): exactly three scoops.
    const after: WorldEvent[] = [];
    for (let t = 0; t < 3 * VERB_TUNING.handDigFrames; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      after.push(...w.step().world);
    }
    expect(of(after, 'dig')).toEqual([]);
    expect(w.verbs.continuousOf(p)).toBeNull();
    expect(of(run(w, 2 * VERB_TUNING.handDigFrames), 'dig')).toEqual([]);
  });

  it('with a digging stick the radial’s Dig is one committed swing at the ground point, digging where it goes in', async () => {
    const w = await make();
    const p = w.player!;
    const s = spawnStick(w, { p: { x: -8, y: 0.05, z: -8 }, length: 1.5, r: 0.025, sharp: { end: 1, s: 0.6 } });
    w.step();
    expect(w.verbs.putInHands(p, s)).toBe(true);
    w.teleport(p, 0, 0, 0);
    run(w, 2);
    verb(w, { verb: 'dig', target: 0, at: [0, 0, 156], charge: 1 });
    const evs = run(w, 150);
    const digs = of(evs, 'dig');
    expect(digs).toHaveLength(1);
    expect(Math.hypot(digs[0].point.x, digs[0].point.z - 1.56)).toBeLessThan(0.3);
    expect(w.verbs.continuousOf(p)).toBeNull();
    expect(w.verbs.focusOf(p)).toEqual({ target: 0, at: { x: 0, y: 0, z: 1.56 } });
  });

  it('refuses a tool that doesn’t dig or a load (noDigTool), and a scoop beyond the hands’ reach at actAt (outOfReach)', async () => {
    const w = await make();
    const p = w.player!;
    const axe = spawnStarterAxe(w, { x: -8, y: 0, z: -8 });
    const log = spawnLog(w, { p: { x: -6, y: 0.15, z: -6 }, length: 1.5, mass: 20 });
    w.step();
    expect(w.verbs.putInHands(p, axe.stick)).toBe(true);
    w.step();
    verb(w, { verb: 'dig', target: 0, at: [0, 0, 100], charge: 1 });
    let evs = run(w, 2);
    expect(of(evs, 'verb')).toEqual([expect.objectContaining({ verb: 'dig', ok: false, reason: 'noDigTool' })]);
    w.verbs.letGo(p);
    w.step();
    expect(w.verbs.putInHands(p, log)).toBe(true);
    expect(p.inventory!.hands!.mode).toBe('carry');
    w.step();
    verb(w, { verb: 'dig', target: 0, at: [0, 0, 100], charge: 1 });
    evs = run(w, 2);
    expect(of(evs, 'verb')).toEqual([expect.objectContaining({ verb: 'dig', ok: false, reason: 'noDigTool' })]);
    w.verbs.letGo(p);
    run(w, 30);
    // A scoop the step-in can't bring within the hands' reach: refused at actAt, nothing dug.
    setTuningValue('VERB_TUNING', 'standOffM', 2);
    w.teleport(p, 0, 0, 0);
    w.step();
    const versions = [...w.terrain.version];
    verb(w, { verb: 'dig', target: 0, at: [0, 0, 210], charge: 1 });
    evs = run(w, VERB_TUNING.handDigFrames);
    expect(of(evs, 'verb').filter((v) => v.verb === 'dig')).toEqual([expect.objectContaining({ ok: false, reason: 'outOfReach' })]);
    expect(of(evs, 'dig')).toEqual([]);
    expect([...w.terrain.version]).toEqual(versions);
  });
});
