// P10, load capacity and covers (docs/M1-DESIGN.md §4.11, §1.5.7, §4.7 step 8): foot loads and resting weights passed
// down through coverings in equal shares, the spanning test, the 0.2 s average against E_b ÷ loadLeverM, load breaks
// and the ruler's cover trip.
//
// - capacity = E_b ÷ loadLeverM: a rotten 2 kg branch holds 100 N, a 4 kg one 200 N (SPEC:345).
// - ten rotten 2 kg branches under a covering hold the 73.3 kg player (≈ 72 N each) and break under one ruler foot
//   (68,670 N) within 12 ticks; the mat itself is not load-tested (I-1) (SPEC:345's example, with a spawned mat).
// - a bearer broken by a ruler foot drops in two pieces that don't rest on both rims (RT-7), and its pieces carry none
//   of that foot's load while their grace lasts.
// - a branch lying on flat ground is never load-broken (it doesn't span, I-1).
// - equal shares 68 N under the pit cover: 20 rotten 4 kg branches over an 8 × 6 m pit under a 66 kg leaf mat
//   [C lab: e2c_cover, F7], each also carrying its own 39 N (the I-rev count, §4.11).
// - a ruler foot that breaks the cover under it trips the ruler `cover` (§4.7 step 8); one whose covering is still held
//   up by something else doesn't.
//
// The player stands in for a ruler foot by weighing 14 t (two planted feet: 68,670 N each), and for the ruler itself by
// carrying a RulerState (P11 builds the giant; its tick is mocked here, as contacts.test.ts does).
//
// Scene numbers (masses, lengths, positions, pit sizes) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Fighter } from '../src/sim/fighter';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { BREAK_TUNING } from '../src/world/breaking';
import { prismRForMass, spawnBox, spawnStick } from '../src/world/factory';
import { LOAD_TUNING } from '../src/world/loads';
import { MATERIALS } from '../src/world/materials';
import { PHYSICS_TUNING, physicsReady } from '../src/world/physics';
import { principalAxis } from '../src/world/shapes';
import type { Entity, RulerState, WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';

vi.mock('../src/sim/ruler', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/ruler')>();
  return { ...m, rulerTick: vi.fn() };
});

vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
async function make(): Promise<World> {
  const w = await createWorld({ seed: 303, scene: 'empty', nav: 'off', size: 50, player: true });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

const G = 9.81;
/** One ruler foot (SPEC:345): a 14 t giant on two planted feet. */
const RULER_KG = 14_000;

function ent(w: World, id: number): Entity {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
}

function run(w: World, n: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let i = 0; i < n; i++) {
    w.step();
    out.push(...w.events);
  }
  return out;
}

type BreakEvent = Extract<WorldEvent, { type: 'break' }>;
const breaks = (ev: readonly WorldEvent[]): BreakEvent[] => ev.filter((e): e is BreakEvent => e.type === 'break');
const lastLoad = (e: Entity): number => e.loadHist[e.loadHist.length - 1];

/** A rotten-wood branch of `mass` and `length` lying along x, centred at (x, z) on ground of height y0. */
function branch(w: World, x: number, z: number, mass: number, length: number, y0 = 0): number {
  const r = prismRForMass(mass, length, MATERIALS.rottenWood.density, PHYSICS_TUNING.cylinderFacets);
  return spawnStick(w, { p: { x, y: y0 + r + 0.005, z }, length, r, material: 'rottenWood' });
}

/** A pit `wx` × `wz` m and `depth` deep centred at (cx, 0) (vertical-ish walls one terrain cell wide). */
function dig(w: World, cx: number, wx: number, wz: number, depth: number): void {
  w.terrain.generate((x, z) => (Math.abs(x - cx) < wx / 2 && Math.abs(z) < wz / 2 ? -depth : 0));
}

/** A covered pit: `n` rotten branches of `mass` across a pit along x, side by side along z, and a leaf mat on top. */
function coveredPit(w: World, o: { cx: number; wx: number; wz: number; n: number; mass: number; length: number; spacing: number; matKg: number; matSize: [number, number] }) {
  dig(w, o.cx, o.wx, o.wz, 1.5);
  const r = prismRForMass(o.mass, o.length, MATERIALS.rottenWood.density, PHYSICS_TUNING.cylinderFacets);
  const branches: number[] = [];
  for (let i = 0; i < o.n; i++) branches.push(branch(w, o.cx, (i - (o.n - 1) / 2) * o.spacing, o.mass, o.length));
  const t = o.matKg / (MATERIALS.leaves.density * o.matSize[0] * o.matSize[1]);
  const mat = spawnBox(w, { p: { x: o.cx, y: 2 * r + t / 2 + 0.01, z: 0 }, size: [o.matSize[0], t, o.matSize[1]], material: 'leaves', look: 'mat' });
  run(w, 90);
  return { branches, mat };
}

/** Stands the player on (x, z) and waits until its feet have planted on what is there (the cover rests again). */
function standOn(w: World, p: Fighter, x: number, z: number): void {
  w.teleport(p, x, z, 0);
  run(w, 60);
}

function rulerState(): RulerState {
  return {
    maxHp: SPECIES_BODY.giantApe.maxHp,
    unhealed: 0,
    wounds: [],
    pinned: false,
    pinnedKg: 0,
    unpinTicks: 0,
    stuck: false,
    burning: false,
    inPit: false,
    downWound: null,
    downCause: null,
    lastWorldTrip: null,
    deflectedHeading: null,
    pendingTrip: null,
  };
}

// ---------------------------------------------------------------------------

describe('capacity (§4.11, SPEC:345)', () => {
  it('capacity is E_b ÷ loadLeverM: a rotten 2 kg branch holds 100 N, a 4 kg one 200 N', async () => {
    const w = await make();
    const a = ent(w, branch(w, 0, 5, 2, 2));
    const b = ent(w, branch(w, 0, 7, 4, 2));
    expect(BREAK_TUNING.loadLeverM).toBe(0.1);
    expect(w.loads.capacityN(a)).toBeCloseTo(100, 6);
    expect(w.loads.capacityN(b)).toBeCloseTo(200, 6);
    expect(Math.round(LOAD_TUNING.loadWindowS / (1 / 60))).toBe(12);
    expect(a.loadHist).toHaveLength(12);
  });
});

describe('covers (§4.11, I-1, RT-7)', () => {
  it('ten rotten 2 kg branches under a mat hold the player (≈ 72 N each) and break under a ruler foot within 12 ticks; the mat is never load-tested', async () => {
    const w = await make();
    const p = w.player!;
    expect(p.mass).toBeCloseTo(73.3, 6);
    const cx = 10;
    const { branches, mat } = coveredPit(w, { cx, wx: 1.6, wz: 2, n: 10, mass: 2, length: 2.6, spacing: 0.07, matKg: 3.6, matSize: [2.4, 0.75] });
    const own = 2 * G;
    const matShare = (ent(w, mat).mass * G) / 10;
    // Resting: each spanning branch carries its own weight and a tenth of the mat's.
    for (const id of branches) expect(lastLoad(ent(w, id))).toBeCloseTo(own + matShare, 1);
    standOn(w, p, cx, 0);
    const playerShare = (p.mass * G) / 10;
    expect(playerShare).toBeCloseTo(71.9, 1);
    for (const id of branches) {
      const e = ent(w, id);
      expect(lastLoad(e)).toBeCloseTo(playerShare + own + matShare, 0);
      expect(lastLoad(e)).toBeLessThan(w.loads.capacityN(e));
      expect(e.integrity).toBe(1);
    }
    expect(Array.from(ent(w, mat).loadHist).every((x) => x === 0)).toBe(true);
    // One ruler foot on it.
    p.massKg = RULER_KG;
    let ev: BreakEvent[] = [];
    let ticks = 0;
    while (ev.length === 0 && ticks < 12) {
      w.step();
      ticks++;
      ev = breaks(w.events);
      if (ev.length === 0) expect(Array.from(ent(w, mat).loadHist).every((x) => x === 0)).toBe(true);
    }
    expect(ticks).toBeLessThanOrEqual(12);
    expect(ev.map((x) => x.entity)).toEqual(branches);
    expect(Array.from(ent(w, mat).loadHist).every((x) => x === 0)).toBe(true);
    // RT-7: each bearer snaps across its axis under the foot, in two pieces too short to rest on both rims (the
    // opening is 2 m wide at the top: the walls slope over one 0.25 m cell).
    const pieces: number[] = [];
    for (const x of ev) {
      expect(x.pieces).toHaveLength(2);
      for (const id of x.pieces) {
        const e = ent(w, id);
        const ax = principalAxis(e.shape);
        expect(ax.max - ax.min).toBeLessThan(2);
        expect(e.grace?.from).toMatchObject({ kind: 'fighter', id: p.id });
        pieces.push(id);
      }
    }
    // While their grace lasts the pieces take none of that foot's load: no piece is load-broken again.
    const later = run(w, 90);
    for (const b of breaks(later)) expect(pieces).not.toContain(b.entity);
    // They fell into the pit.
    for (const id of pieces) {
      const e = w.entities.get(id);
      if (e) expect(e.pose.p.y).toBeLessThan(-0.5);
    }
  });

  it('a branch lying on flat ground is never load-broken, even under a ruler foot (it doesn’t span)', async () => {
    const w = await make();
    const p = w.player!;
    const b = branch(w, 6, 0, 2, 2);
    run(w, 60);
    standOn(w, p, 6, 0);
    p.massKg = RULER_KG;
    const ev = run(w, 60);
    expect(breaks(ev)).toEqual([]);
    const e = ent(w, b);
    expect(e.integrity).toBe(1);
    expect(Array.from(e.loadHist).every((x) => x === 0)).toBe(true);
  });

  it('equal shares under the pit cover: 20 rotten 4 kg branches over an 8 × 6 m pit under a 66 kg mat carry 68 N each from the mat and the player (and their own 39 N), and 6.9 kN each under a ruler foot', async () => {
    const w = await make();
    const p = w.player!;
    const cx = 12;
    const { branches, mat } = coveredPit(w, { cx, wx: 8, wz: 6, n: 20, mass: 4, length: 9, spacing: 0.3, matKg: 66, matSize: [9, 6.2] });
    expect(ent(w, mat).mass).toBeCloseTo(66, 6);
    standOn(w, p, cx, 0);
    const share = (p.mass * G + 66 * G) / 20;
    expect(share).toBeCloseTo(68.3, 1);
    for (const id of branches) {
      const e = ent(w, id);
      expect(lastLoad(e) - 4 * G).toBeCloseTo(share, 0);
      expect((lastLoad(e) - 4 * G) / w.loads.capacityN(e)).toBeCloseTo(0.34, 2);
      expect(e.integrity).toBe(1);
    }
    expect(Array.from(ent(w, mat).loadHist).every((x) => x === 0)).toBe(true);
    p.massKg = RULER_KG;
    // Read one tick's loads with the capacities raised out of reach (the lever is a live tuning value): a ruler foot's
    // 68,670 N × 2 / 20 ≈ 6.9 kN each, plus the mat's share and their own weight.
    BREAK_TUNING.loadLeverM = 1e-5;
    w.step();
    expect(breaks(w.events)).toEqual([]);
    for (const id of branches) expect(lastLoad(ent(w, id)) / ((RULER_KG * G + 66 * G) / 20 + 4 * G)).toBeCloseTo(1, 2);
    // At the real lever they all break on the next tick.
    BREAK_TUNING.loadLeverM = 0.1;
    w.step();
    expect(breaks(w.events).map((x) => x.entity)).toEqual(branches);
  });
});

describe('the ruler’s cover trip (§4.7 step 8)', () => {
  async function rulerOnCover(scaffold: boolean) {
    const w = await make();
    const p = w.player!;
    const cx = 10;
    // The mat is wider than the row of branches (±0.34 m), so a post can stand beside them.
    const matSize: [number, number] = [2.4, 1.2];
    const { branches, mat } = coveredPit(w, { cx, wx: 1.6, wz: 2, n: 10, mass: 2, length: 2.6, spacing: 0.07, matKg: 3.6, matSize });
    let post = -1;
    if (scaffold) {
      // A fixed post on the pit floor holding up the mat's corner: the mat no longer rests on the branches alone.
      const m = ent(w, mat);
      const t = 3.6 / (MATERIALS.leaves.density * matSize[0] * matSize[1]);
      const h = m.pose.p.y - t / 2 + 0.002 + 1.5;
      post = spawnBox(w, { p: { x: cx + 0.6, y: -1.5 + h / 2, z: 0.5 }, size: [0.2, h, 0.1], material: 'dryWood', state: 'fixed', look: 'scaffold' });
      run(w, 60);
    }
    standOn(w, p, cx, 0);
    p.ruler = rulerState();
    p.massKg = RULER_KG;
    const trip = vi.spyOn(w.rulers, 'requestTrip');
    let ev: BreakEvent[] = [];
    for (let i = 0; i < 12 && ev.length === 0; i++) {
      w.step();
      ev = breaks(w.events);
    }
    return { w, p, branches, mat, post, trip, ev };
  }

  it('a load break under a planted ruler foot whose support then drops more than half its knee height trips it `cover`, the first broken bearer the cause', async () => {
    const { p, branches, trip, ev } = await rulerOnCover(false);
    expect(ev.map((x) => x.entity)).toEqual(branches);
    expect(trip).toHaveBeenCalledTimes(1);
    const [f, why, cause] = trip.mock.calls[0];
    expect(f).toBe(p);
    expect(why).toBe('cover');
    expect(cause).toMatchObject({ kind: 'entity', entityId: branches[0], feature: 'cover', held: false });
  });

  it('a ruler on a cover whose mat something else still holds up doesn’t trip when the branches under it break', async () => {
    const { mat, branches, trip, ev, post } = await rulerOnCover(true);
    expect(post).toBeGreaterThan(0);
    // The branches still break (the mat's load goes to them and the post in equal shares), but the mat stays up.
    expect(ev.map((x) => x.entity)).toEqual(branches);
    expect(trip).not.toHaveBeenCalled();
    expect(mat).toBeGreaterThan(0);
  });
});
