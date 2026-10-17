// Strike, cut and the strike seam (docs/M1-DESIGN.md §5.2, §5.3; package P15), headless, through commands only: the
// stone axe's chops on a standing tree (15 on a 30 cm trunk, each 0.0200 m fresh or tired, SPEC:882), the notch's side
// from the chopper's root at any angle (RT-22), the digging stick's overhead digging 1.4-1.7 m ahead and the stone axe
// never digging, a focused trunk struck with an ape 20 m behind, a focused rope aimed at its nearest point (RT-6), a
// hanging vine severed (the bottom falls as a coil, the top stays tied), a blunt stick clanging, a 6 cm branch cross-cut
// in 3 chops conserving mass, kicks knocking a 14 cm prop from under a 170 kg log, a thrown spear landing as the same
// entity, the radial's Cut (`{ verb: 'cut', target }`) as the in-play swing, and determinism.
//
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorld } from '../src/save/load';
import { serializeWorld } from '../src/save/serialize';
import { AIM_STEPS, type VerbCommand } from '../src/sim/commands';
import type { CombatEvent } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import type { Button } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { DAMAGE_TUNING, reducedMass } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { FELL_TUNING } from '../src/world/felling';
import { LYING_ALONG_X, spawnBox, spawnLog, spawnRopeCoil, spawnStarterAxe, spawnStick, spawnStone, spawnTree } from '../src/world/factory';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import { principalAxis, shapeVolume } from '../src/world/shapes';
import type { Entity, Quat, V3, WorldEvent, WorldStrike } from '../src/world/types';
import { crossCutStrike, strokeDepthM } from '../src/world/verbs/cut';
import { STRIKE_TUNING } from '../src/world/verbs/strike';
import { chestPoint, ropeNearest } from '../src/world/verbs/targets';
import { freshChopEnergy } from '../src/world/verbs/tools';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 180_000 });

const live: World[] = [];
async function make(seed = 15, size = 50): Promise<World> {
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

const DEG = Math.PI / 180;
const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
const bearingOf = (d: V3): number => Math.atan2(d.x, d.z) / DEG;
/** The difference of two bearings in degrees, wrapped to (−180, 180]. */
const angleDiff = (a: number, b: number): number => {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};

/** Queues a verb command from player 1 for the next tick. */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): void {
  w.commands.push({ tick: w.tick + 1, player: 1, kind: 'verb', ...v } as VerbCommand);
}

/** Queues a button press from player 1 for the next tick (Q/E punches, R/F kicks). */
function press(w: World, button: Button): void {
  w.commands.push({ tick: w.tick + 1, player: 1, kind: 'button', button });
}

/** Puts the entity in the player's hands at once and steps a tick (the dev give-tool path). */
function hold(w: World, id: number): void {
  expect(w.verbs.putInHands(w.player!, id)).toBe(true);
  w.step();
}

/** Stands the player at (x, z) facing `toward` (a fixture move: World.teleport, as the harness's standAt). */
function standAt(w: World, x: number, z: number, toward: { x: number; z: number }): void {
  w.teleport(w.player!, x, z, Math.atan2(toward.x - x, toward.z - z));
}

/** Every strike the world was offered that met something, from now on (the WorldPort call, spied through): call it for the list. */
function strikes(w: World): () => WorldStrike[] {
  const spy = vi.spyOn(w, 'strike');
  return () => spy.mock.results.filter((r) => r.type === 'return' && r.value).map((r) => r.value as WorldStrike);
}

/** Steps n ticks: the world and combat events, copied. */
function run(w: World, n: number, each?: () => void): { world: WorldEvent[]; combat: CombatEvent[] } {
  const world: WorldEvent[] = [];
  const combat: CombatEvent[] = [];
  for (let t = 0; t < n; t++) {
    each?.();
    const r = w.step();
    world.push(...r.world);
    combat.push(...r.combat);
  }
  return { world, combat };
}

/** One swing: the press, then ticks until the player is free again (or `max`). */
function swing(w: World, button: Button = 'rpunch', max = 200): { world: WorldEvent[]; combat: CombatEvent[] } {
  press(w, button);
  const out = run(w, 2);
  for (let t = 0; t < max && !w.player!.free; t++) {
    const r = w.step();
    out.world.push(...r.world);
    out.combat.push(...r.combat);
  }
  return out;
}

/** The starter cache axe (§6.7) in the player's hands. */
function wieldAxe(w: World): { stick: number; head: number } {
  const axe = spawnStarterAxe(w, { x: -8, y: 0, z: -8 });
  w.step();
  hold(w, axe.stick);
  return axe;
}

/** A digging stick (a dry stick 1.5 m × r 0.025 sharpened to 0.6 at one end, §5.2) in the player's hands. */
function wieldDiggingStick(w: World): number {
  const id = spawnStick(w, { p: { x: -8, y: 0.05, z: -8 }, length: 1.5, r: 0.025, sharp: { end: 1, s: 0.6 } });
  w.step();
  hold(w, id);
  return id;
}

/** The chop of a stone axe at a 30 cm trunk from `bearing` (degrees, the tree → player direction) and `dist` m off its surface. */
function standToChop(w: World, tree: number, bearing: number, dist = 1.3): void {
  const t = ent(w, tree);
  const r = t.plant!.diameter / 2 + dist;
  const x = t.pose.p.x + r * Math.sin(bearing * DEG);
  const z = t.pose.p.z + r * Math.cos(bearing * DEG);
  standAt(w, x, z, { x: t.pose.p.x, z: t.pose.p.z });
}

// ---------------------------------------------------------------------------
// Chop (§2.5, §5.2, §5.3)
// ---------------------------------------------------------------------------

describe('chopping a standing tree (§5.2, §2.5)', () => {
  it('15 stone-axe chops fell a 30 cm tree, each 0.0200 m deep fresh or tired; it falls away from the chopper’s side', async () => {
    const w = await make();
    const p = w.player!;
    const { tree } = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 15 });
    const axe = wieldAxe(w);
    // The chop depth rule (§5.2): chopDepthM × clamp(E/refChopJ, …) with the axe's fresh chop ≥ refChopJ (339 J).
    const E = freshChopEnergy(w, axe.stick);
    expect(E).toBeGreaterThanOrEqual(FELL_TUNING.refChopJ);
    expect(strokeDepthM(w, axe.stick).toFixed(4)).toBe('0.0200');
    const met = strikes(w);
    // Between the 8-gon's 45° facet normals (22.5° off), so a snapped notch would show.
    const bearing = 37;
    const chops: Ev<'chop'>[] = [];
    let fell: Ev<'fell'> | undefined;
    for (let k = 1; k <= 15; k++) {
      standToChop(w, tree, bearing);
      verb(w, { verb: 'focus', target: tree });
      w.step();
      // Every fourth chop by a player out of breath (DS stretches a tired swing's tempo; the depth stays).
      const tired = k % 4 === 0;
      if (tired) p.stamina = 0;
      const { world } = swing(w);
      if (tired) expect(p.swingStamina, `chop ${k}`).toBeLessThan(0.01);
      const c = of(world, 'chop');
      expect(c, `chop ${k}`).toHaveLength(1);
      expect(of(world, 'verb').filter((v) => v.verb === 'cut' && v.ok && v.entity === tree), `chop ${k}`).toHaveLength(1);
      chops.push(c[0]);
      const cut = ent(w, tree).plant!.cut!;
      expect(cut.chops).toBe(k);
      // Each chop adds the same 0.0200 m, fresh or tired.
      expect((cut.depthSumM / k).toFixed(4), `chop ${k}`).toBe('0.0200');
      fell = of(world, 'fell')[0] ?? fell;
      if (k < 15) {
        expect(fell, `chop ${k}`).toBeUndefined();
        expect(ent(w, tree).plant!.phase).toBe('notched');
      }
    }
    expect(met().filter((s) => s.effect === 'chop')).toHaveLength(15);
    expect(met().every((s) => s.effect !== 'chop' || (s.reaction.mode === 'stick' && s.reaction.retract === STRIKE_TUNING.stickRetract))).toBe(true);
    expect(chops.map((c) => c.remaining)).toEqual([...chops.map((c) => c.remaining)].sort((a, b) => b - a));
    expect(chops[14].remaining).toBe(0);
    // The 15th chop is through: it falls (phase 13c of the same tick), away from the chopper's side.
    expect(fell).toBeDefined();
    expect(ent(w, tree).plant!.phase).toBe('falling');
    expect(Math.abs(angleDiff(bearingOf(fell!.dir), bearing + 180))).toBeLessThan(0.5);
    expect(ent(w, tree).credit).toEqual(['p1']);
  });

  it('the notch’s side follows the chopper’s side at any angle, not in the 8-gon’s 45° steps (RT-22)', async () => {
    const w = await make(16, 75);
    const bearings = [10, 100, 200, 290, -24];
    const trees = bearings.map((_, i) => spawnTree(w, { at: { x: -24 + 12 * i, z: 0 }, diameter: 0.3, height: 15 }).tree);
    wieldAxe(w);
    bearings.forEach((b, i) => {
      standToChop(w, trees[i], b);
      verb(w, { verb: 'focus', target: trees[i] });
      w.step();
      const { world } = swing(w);
      expect(of(world, 'chop'), `bearing ${b}`).toHaveLength(1);
      const cut = ent(w, trees[i]).plant!.cut!;
      const side = bearingOf(cut.fromDir);
      expect(Math.abs(angleDiff(side, b)), `bearing ${b}`).toBeLessThan(0.5);
      // Not a facet normal (those are 22.5° + k·45° off the prism's local axes here).
      const toStep = Math.abs(angleDiff(side, 45 * Math.round(side / 45)));
      expect(toStep, `bearing ${b}`).toBeGreaterThan(5);
      // The fall direction is away from that side (felling's hinge, §4.12).
      const fall = w.felling.hingeOf(trees[i])!.fallDir;
      expect(fall.x).toBeCloseTo(-cut.fromDir.x, 12);
      expect(fall.z).toBeCloseTo(-cut.fromDir.z, 12);
    });
  });

  it('a focused trunk is struck, not an ape 20 m behind (§5.2: verbAim, MAP gap-5 §1.3)', async () => {
    const w = await make();
    const p = w.player!;
    const { tree } = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 12 });
    wieldAxe(w);
    standToChop(w, tree, 180);
    const ids = w.ids.fighter;
    const { fighter: ape } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
    ape.scale = SPECIES_BODY.ape.scale;
    ape.species = 'ape';
    ape.massKg = SPECIES_BODY.ape.massKg;
    w.addFighter(ape, null);
    // 20 m behind the player, facing it.
    w.teleport(ape, p.pos.x, p.pos.z - 20, 0);
    run(w, 3);
    verb(w, { verb: 'focus', target: tree });
    w.step();
    expect(p.verbAim).not.toBeNull();
    const { world } = swing(w);
    expect(p.target).toBe(ape);
    expect(p.lockedOn).toBe(false);
    expect(of(world, 'chop')).toHaveLength(1);
    expect(ent(w, tree).plant!.cut!.chops).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ropes (§5.3)
// ---------------------------------------------------------------------------

describe('severing ropes (§5.3)', () => {
  it('a focused rope is aimed at its nearest point (RT-6), and an axe stroke there severs it: each piece keeps its tie', async () => {
    const w = await make();
    const p = w.player!;
    // A vine tied between two trees 1.8 m up: it has no point at focusHeightM (1.0 m).
    const a = spawnTree(w, { at: { x: -1.6, z: 1.3 }, diameter: 0.2, height: 6 }).tree;
    const b = spawnTree(w, { at: { x: 1.6, z: 1.3 }, diameter: 0.2, height: 6 }).tree;
    const coil = spawnRopeCoil(w, { at: { x: 4, y: 0, z: -4 }, material: 'vine', lengthM: 3.5 });
    w.step();
    const ya = 1.8 - ent(w, a).pose.p.y;
    const joint = w.joints.rope({ entity: a, local: { x: 0.1, y: ya, z: 0 } }, { entity: b, local: { x: -0.1, y: ya, z: 0 } }, 3.2, { entity: coil, lengthM: 3.5 }, []);
    wieldAxe(w);
    standAt(w, 0.2, 0, { x: 0.2, z: 1.3 });
    run(w, 2);
    verb(w, { verb: 'focus', target: coil });
    w.step();
    const near = ropeNearest(w, coil, chestPoint(p))!;
    expect(p.verbAim).not.toBeNull();
    expect(p.verbAim!.distanceTo(new Vector3(near.point.x, near.point.y, near.point.z))).toBeLessThan(1e-9);
    expect(p.verbAim!.y).toBeCloseTo(1.8, 6);
    const met = strikes(w);
    const { world } = swing(w);
    expect(met().map((s) => s.effect)).toEqual(['sever']);
    expect(of(world, 'joint').filter((e) => e.what === 'cut')).toEqual([expect.objectContaining({ joint })]);
    expect(w.joints.get(joint)).toBeUndefined();
    // Two pieces, each tied to its tree with its other end loose; proportional lengths summing to the rope's.
    const pieces = w.joints.all().filter((j) => j.kind === 'rope');
    expect(pieces).toHaveLength(2);
    const trees = pieces.map((j) => j.a.entity).sort();
    expect(trees).toEqual([a, b].sort());
    for (const j of pieces) {
      expect(j.b.loose).toBe(true);
      expect(j.credit).toEqual(['p1']);
      expect(ent(w, j.rope!.entity).state).toBe('tied');
    }
    expect(pieces.reduce((s, j) => s + j.rope!.lengthM, 0)).toBeCloseTo(3.5, 9);
    expect(pieces.some((j) => j.rope!.entity === coil)).toBe(true);
  });

  it('an edged strike severs a hanging vine: the bottom falls as a coil, the top stays tied', async () => {
    const w = await make();
    const { tree, vine } = spawnTree(w, { at: { x: 0, z: 2 }, diameter: 0.3, height: 10, vine: { anchorH: 3, lengthM: 5, yaw: Math.PI } });
    const rope = vine!.rope;
    const mass0 = ent(w, rope).mass;
    wieldAxe(w);
    standAt(w, 1.3, 0.75, { x: 0, z: 0.75 });
    run(w, 2);
    verb(w, { verb: 'focus', target: rope });
    w.step();
    const met = strikes(w);
    const { world } = swing(w);
    expect(met().map((s) => s.effect)).toEqual(['sever']);
    expect(of(world, 'joint').filter((e) => e.what === 'cut').map((e) => e.joint)).toEqual([vine!.joint]);
    // The top keeps the rope entity's id and its tie to the tree, its end loose and hanging below the anchor.
    const top = w.joints.all().filter((j) => j.rope?.entity === rope);
    expect(top).toHaveLength(1);
    expect(top[0].a.entity).toBe(tree);
    expect(top[0].b.loose).toBe(true);
    expect(ent(w, rope).state).toBe('tied');
    const anchor = w.joints.anchorPoint(top[0].a)!;
    const end = top[0].b.local;
    expect(hdist(anchor, end)).toBeLessThan(1e-9);
    expect(anchor.y - end.y).toBeCloseTo(top[0].rope!.lengthM, 6);
    // The bottom is a coil lying on the ground: a new rope entity of the rest of the length.
    const spawned = of(world, 'spawn').map((e) => ent(w, e.entity)).filter((e) => e.rope && e.id !== rope);
    expect(spawned).toHaveLength(1);
    const coil = spawned[0];
    expect(coil.state).toBe('free');
    expect(coil.material).toBe('vine');
    expect(coil.joints).toEqual([]);
    expect(coil.credit).toEqual(['p1']);
    expect(ent(w, rope).rope!.lengthM + coil.rope!.lengthM).toBeCloseTo(5, 9);
    expect((ent(w, rope).mass + coil.mass) / mass0).toBeCloseTo(1, 9);
  });

  it('a blunt stick clangs off a trunk and off a vine (DS behaviour), cutting nothing', async () => {
    const w = await make();
    const { tree, vine } = spawnTree(w, { at: { x: 0, z: 2 }, diameter: 0.3, height: 10, vine: { anchorH: 3, lengthM: 5, yaw: Math.PI } });
    const s = spawnStick(w, { p: { x: -8, y: 0.05, z: -8 }, length: 1.2, r: 0.025 });
    w.step();
    hold(w, s);
    expect(w.player!.weapon?.id).toBe('stick');
    for (const target of [tree, vine!.rope]) {
      if (target === tree) standAt(w, 1.45, 2, { x: 0, z: 2 });
      else standAt(w, 1.3, 0.75, { x: 0, z: 0.75 });
      run(w, 2);
      verb(w, { verb: 'focus', target });
      w.step();
      const met = strikes(w);
      const { world, combat } = swing(w);
      expect(met().map((m) => m.effect), `target ${target}`).toEqual(['clang']);
      expect(met()[0].reaction).toEqual({ mode: 'rebound', hold: STRIKE_TUNING.reboundHold, retract: STRIKE_TUNING.reboundRetract });
      expect(combat.filter((c) => c.type === 'clang'), `target ${target}`).toHaveLength(1);
      expect(of(world, 'chop')).toEqual([]);
      expect(of(world, 'joint')).toEqual([]);
      vi.restoreAllMocks();
    }
    expect(ent(w, tree).plant!.cut).toBeNull();
    expect(w.joints.get(vine!.joint)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cut (§5.3)
// ---------------------------------------------------------------------------

describe('cross-cutting free wood (§5.3)', () => {
  it('a 6 cm branch is cut in two in 3 chops, conserving mass within 1 %; the notch side is stored entity-local', async () => {
    const w = await make();
    const p = w.player!;
    // A dry branch resting across a stone block 0.9 m high (the stone axe never reaches the ground, §5.2).
    spawnBox(w, { p: { x: 0, y: 0.45, z: 1.5 }, size: [0.4, 0.9, 0.4], material: 'stone', state: 'fixed', look: 'block' });
    const br = spawnStick(w, { p: { x: 0, y: 0.94, z: 1.5 }, q: LYING_ALONG_X, length: 2, r: 0.03 });
    const axe = wieldAxe(w);
    run(w, 30);
    const parent = ent(w, br);
    const mass = parent.mass;
    const thick = 2 * principalAxis(parent.shape).crossHalf;
    expect(thick).toBeCloseTo(0.06, 12);
    const met = strikes(w);
    const cuts: Ev<'crossCut'>[] = [];
    for (let k = 1; k <= 3; k++) {
      standAt(w, 0.5, 0.25, { x: 0.5, z: 1.5 });
      verb(w, { verb: 'focus', target: br });
      w.step();
      const { world } = swing(w);
      const c = of(world, 'crossCut');
      expect(c, `chop ${k}`).toHaveLength(1);
      cuts.push(c[0]);
      if (k < 3) {
        const cc = ent(w, br).crossCut!;
        expect(cc.remaining).toBeCloseTo(1 - (k * strokeDepthM(w, axe.stick)) / thick, 9);
        // fromDir: entity-local, across the axis (the client draws the notch from it).
        const ax = principalAxis(ent(w, br).shape).dir;
        expect(Math.abs(cc.fromDir.x * ax.x + cc.fromDir.y * ax.y + cc.fromDir.z * ax.z)).toBeLessThan(1e-9);
        expect(Math.hypot(cc.fromDir.x, cc.fromDir.y, cc.fromDir.z)).toBeCloseTo(1, 12);
        expect(ent(w, br).credit).toEqual(['p1']);
      }
    }
    expect(met().map((s) => s.effect)).toEqual(['crossCut', 'crossCut', 'crossCut']);
    expect(cuts.map((c) => c.pieces === null)).toEqual([true, true, false]);
    const pieces = cuts[2].pieces!;
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBeGreaterThan(br);
    expect(pieces[1]).toBe(pieces[0] + 1);
    expect(w.entities.get(br)).toBeUndefined();
    const total = pieces.reduce((s, id) => s + ent(w, id).mass, 0);
    expect(Math.abs(total / mass - 1)).toBeLessThan(0.01);
    for (const id of pieces) {
      expect(ent(w, id).state).toBe('free');
      expect(ent(w, id).credit).toEqual(['p1']);
      expect(ent(w, id).material).toBe('dryWood');
    }
    // The pieces fall and rest (no explosion out of the cut).
    run(w, 120);
    for (const id of pieces) expect(Math.hypot(ent(w, id).vel.lin.x, ent(w, id).vel.lin.y, ent(w, id).vel.lin.z)).toBeLessThan(2);
    void p;
  });

  it('a stroke more than crossCutRestartM along from the cut starts a new cut there; sharp points stay on their piece', async () => {
    const w = await make();
    const p = w.player!;
    const s = spawnStick(w, { p: { x: 0, y: 0.04, z: 3 }, length: 1.4, r: 0.03, sharp: { end: 1, s: 0.6 } });
    const axe = wieldAxe(w);
    const e = ent(w, s);
    const at = (t: number): V3 => {
      const local = { x: 0.03, y: t, z: 0 };
      const q = e.pose.q;
      // pose ∘ local (the stick lies along x)
      const v = new Vector3(local.x, local.y, local.z).applyQuaternion({ x: q.x, y: q.y, z: q.z, w: q.w } as never);
      return { x: e.pose.p.x + v.x, y: e.pose.p.y + v.y, z: e.pose.p.z + v.z };
    };
    expect(crossCutStrike(w, p, s, at(0.2), axe.stick)).toBeNull();
    expect(ent(w, s).crossCut!.axisT).toBeCloseTo(0.2, 6);
    const after1 = ent(w, s).crossCut!.remaining;
    expect(crossCutStrike(w, p, s, at(0.3), axe.stick)).toBeNull();
    expect(ent(w, s).crossCut!.axisT).toBeCloseTo(0.2, 6);
    const after2 = ent(w, s).crossCut!.remaining;
    expect(after2).toBeLessThan(after1);
    // 0.2 m along from the stored cut: a new one.
    expect(crossCutStrike(w, p, s, at(-0.01), axe.stick)).toBeNull();
    expect(ent(w, s).crossCut!.axisT).toBeCloseTo(-0.01, 6);
    expect(ent(w, s).crossCut!.remaining).toBeCloseTo(after1, 12);
    let pieces: number[] | null = null;
    for (let k = 0; k < 3 && !pieces; k++) pieces = crossCutStrike(w, p, s, at(-0.01), axe.stick);
    expect(pieces).not.toBeNull();
    // The sharp point (at the +y end) stays on the piece holding it.
    const sharp = pieces!.map((id) => ent(w, id).sharpPoints.length);
    expect(sharp).toEqual([0, 1]);
    const v0 = shapeVolume(e.shape);
    expect(pieces!.reduce((sum, id) => sum + shapeVolume(ent(w, id).shape), 0) / v0).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// Push (§5.2: "kick out a prop", SPEC:432)
// ---------------------------------------------------------------------------

/** a ⊗ b. */
function qmul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

describe('pushing free things (§5.2)', () => {
  it('kicks knock a 14 cm prop from under a 170 kg log (each a push J = √(2·E·μ) along the facing, crediting the kicker)', async () => {
    const w = await make();
    const p = w.player!;
    // §11.2(a)'s staged scene: the prop upright at x 5.07, a 6 m log of 170 kg with one end on the ground at x 0 and its
    // underside on the prop's top 5.6 m along it (25°).
    const prop = spawnStick(w, { p: { x: 5.07, y: 1.191, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, length: 2.38, r: 0.07 });
    const L = 6;
    const r = Math.sqrt(170 / MATERIALS.dryWood.density / L / (1.5 * Math.sqrt(3)));
    const inr = r * Math.cos(Math.PI / 6);
    const ang = 25 * DEG;
    const d = { x: Math.cos(ang), y: Math.sin(ang) };
    const n = { x: -Math.sin(ang), y: Math.cos(ang) };
    const s0 = { x: 5.07 - 5.6 * d.x + inr * n.x, y: 2.38 - 5.6 * d.y + inr * n.y };
    const q = qmul({ x: 0, y: 0, z: Math.sin(ang / 2), w: Math.cos(ang / 2) }, LYING_ALONG_X);
    const log = spawnLog(w, { p: { x: s0.x + (L / 2) * d.x, y: s0.y + (L / 2) * d.y + 0.003, z: 0 }, q, length: L, mass: 170 });
    expect(ent(w, log).mass).toBeCloseTo(170, 6);
    expect(ent(w, prop).mass).toBeGreaterThan(17);
    w.step();
    standAt(w, 5.07, -1.05, { x: 5.07, z: 0 });
    run(w, 120);
    const set = ent(w, log).pose.p.y;
    run(w, 60);
    // It stands set (§11.2(a): the prop holds).
    expect(Math.abs(ent(w, log).pose.p.y - set)).toBeLessThan(0.01);
    const met = strikes(w);
    const queued = vi.spyOn(w.entities, 'queueImpulse');
    let kicks = 0;
    for (; kicks < 4 && ent(w, log).pose.p.y > set - 0.5; kicks++) {
      const pp = ent(w, prop).pose.p;
      standAt(w, pp.x, pp.z - 1.05, { x: pp.x, z: pp.z });
      w.step();
      // A fresh kick each time (a tired one has less behind it, DS's swing stamina).
      p.stamina = 1;
      swing(w, 'rkick');
      expect(p.lastMoveId).toBe('lowKick');
      run(w, 60);
      console.info(`kick ${kicks + 1}: log middle ${ent(w, log).pose.p.y.toFixed(2)} m, prop at z ${ent(w, prop).pose.p.z.toFixed(2)}`);
    }
    console.info(`kick out a prop: the 170 kg log came down after ${kicks} low kicks`);
    expect(met().length).toBe(kicks);
    expect(met().every((m) => m.effect === 'push' && m.reaction.mode === 'rebound')).toBe(true);
    // The log came down (its middle more than 0.5 m lower) within 4 kicks of 108 J each (DS's low kick: 6 × 18 J).
    // DEVIATION (§13.1 P15 "a kick knocks a 14 cm prop from under a 170 kg log"): one such kick moves the loaded prop
    // only 7-11 cm (the log's weight pins both its ends by friction); it takes 2-3. Recorded with the package.
    expect(ent(w, log).pose.p.y).toBeLessThan(set - 0.5);
    expect(kicks).toBeLessThanOrEqual(4);
    expect(ent(w, prop).credit).toEqual(['p1']);
    // Each push: J = √(2·E·μ(m_prop, strikeMassKg)) along the facing (+z here), at the struck point.
    const E = 6 * p.stats.damageMul * DAMAGE_TUNING.meleeJPerDmg;
    const J = Math.sqrt(2 * E * reducedMass(ent(w, prop).mass, VERB_TUNING.strikeMassKg));
    const pushes = queued.mock.calls.filter((c) => c[0] === prop);
    expect(pushes).toHaveLength(kicks);
    for (const [, j, at] of pushes) {
      expect(Math.hypot(j.x, j.y, j.z)).toBeCloseTo(J, 6);
      expect(j.z / J).toBeCloseTo(1, 6);
      expect(at).not.toBeNull();
    }
  });

  it('an axe clangs off a fixed stone block (§5.2: anything fixed)', async () => {
    const w = await make();
    const block = spawnBox(w, { p: { x: 0, y: 0.45, z: 1.5 }, size: [0.4, 0.9, 0.4], material: 'stone', state: 'fixed', look: 'block' });
    wieldAxe(w);
    standAt(w, 0, 0.2, { x: 0, z: 1.5 });
    run(w, 2);
    verb(w, { verb: 'focus', target: block });
    w.step();
    const met = strikes(w);
    const { combat } = swing(w);
    expect(met().map((m) => m.effect)).toEqual(['clang']);
    expect(combat.filter((c) => c.type === 'clang')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dig by strike (§5.10)
// ---------------------------------------------------------------------------

describe('digging by strike (§5.10)', () => {
  it('the digging stick’s overhead digs 0.15 m deep 1.4-1.7 m ahead, where the focus aims it', async () => {
    const w = await make();
    const p = w.player!;
    const stick = wieldDiggingStick(w);
    expect(p.weapon?.id).toBe('sharpStick');
    expect(p.weapon?.heavy).toBe('overhead');
    standAt(w, 0, 0, { x: 0, z: 1 });
    run(w, 2);
    const from = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    verb(w, { verb: 'focus', target: 0, at: [0, 0, 156] });
    w.step();
    const met = strikes(w);
    const { world } = swing(w);
    expect(met().map((m) => m.effect)).toEqual(['dig']);
    expect(met()[0].reaction.mode).toBe('stick');
    const digs = of(world, 'dig');
    expect(digs).toHaveLength(1);
    const ahead = hdist(digs[0].point, from);
    expect(ahead).toBeGreaterThanOrEqual(1.4);
    expect(ahead).toBeLessThanOrEqual(1.7);
    // One full strike of the cone kernel there: 0.15 m at its peak.
    let deepest = 0;
    for (let x = -1; x <= 1; x += 0.25) for (let z = 0.5; z <= 2.5; z += 0.25) deepest = Math.max(deepest, w.terrain.originalHeightAt(x, z) - w.terrain.heightAt(x, z));
    const { digDepthM, digRadiusM, spacing } = { digDepthM: 0.15, digRadiusM: 0.5, spacing: w.terrain.spacing };
    expect(deepest).toBeLessThanOrEqual(digDepthM + 1e-6);
    expect(deepest).toBeGreaterThanOrEqual(digDepthM * (1 - (spacing * Math.SQRT1_2) / digRadiusM) - 1e-6);
    expect(digs[0].volumeM3).toBeGreaterThan(0.035);
    expect(of(world, 'verb').filter((v) => v.verb === 'dig' && v.ok)).toHaveLength(1);
    void stick;
  });

  it('the stone axe never digs: its head never reaches the ground, wherever the focus is (§5.2)', async () => {
    const w = await make();
    wieldAxe(w);
    const versions = [...w.terrain.version];
    for (const at of [60, 100, 156, 200]) {
      standAt(w, 0, 0, { x: 0, z: 1 });
      run(w, 2);
      verb(w, { verb: 'focus', target: 0, at: [0, 0, at] });
      w.step();
      const met = strikes(w);
      const { world } = swing(w);
      expect(met().filter((m) => m.effect === 'dig'), `at ${at} cm`).toEqual([]);
      expect(of(world, 'dig'), `at ${at} cm`).toEqual([]);
      vi.restoreAllMocks();
    }
    expect([...w.terrain.version]).toEqual(versions);
    // And the radial's Dig refuses it: it is no digging tool.
    verb(w, { verb: 'dig', target: 0, at: [0, 0, 150], charge: 1 });
    const evs = run(w, 2).world;
    expect(of(evs, 'verb').filter((v) => v.verb === 'dig')).toEqual([expect.objectContaining({ ok: false, reason: 'noDigTool' })]);
  });
});

// ---------------------------------------------------------------------------
// The radial's Cut (§5.3)
// ---------------------------------------------------------------------------

describe('the cut verb (§5.3)', () => {
  it('{ verb: cut, target } plays the committed swing at the target: the same chop as a press of E', async () => {
    const w = await make();
    const p = w.player!;
    const { tree } = spawnTree(w, { at: { x: 0, z: 0 }, diameter: 0.3, height: 12 });
    wieldAxe(w);
    standToChop(w, tree, 150);
    // Facing away: the verb turns the player to the target.
    p.yaw += Math.PI / 2;
    run(w, 2);
    verb(w, { verb: 'cut', target: tree });
    const out = run(w, 2);
    for (let t = 0; t < 200 && !p.free; t++) out.world.push(...w.step().world);
    expect(of(out.world, 'chop')).toHaveLength(1);
    expect(out.combat.filter((c) => c.type === 'attackStart')).toHaveLength(1);
    expect(Math.abs(angleDiff(bearingOf(ent(w, tree).plant!.cut!.fromDir), 150))).toBeLessThan(0.5);
    // The focus stays on the target as the client's highlight would.
    expect(w.verbs.focusedEntity(p)).toBe(tree);
  });

  it('is refused without an edge (noEdge) and on a material the edge can’t cut (tooHard), changing nothing', async () => {
    const w = await make();
    const stone = spawnStone(w, { p: { x: 0, y: 0.2, z: 1 }, mass: 20 });
    const { tree } = spawnTree(w, { at: { x: 1.5, z: 0 }, diameter: 0.3, height: 12 });
    w.step();
    verb(w, { verb: 'cut', target: tree });
    let evs = run(w, 2).world;
    expect(of(evs, 'verb')).toEqual([expect.objectContaining({ verb: 'cut', ok: false, reason: 'noEdge' })]);
    const s = spawnStick(w, { p: { x: -8, y: 0.05, z: -8 }, length: 1.2, r: 0.025 });
    w.step();
    hold(w, s);
    verb(w, { verb: 'cut', target: tree });
    evs = run(w, 2).world;
    expect(of(evs, 'verb')).toEqual([expect.objectContaining({ verb: 'cut', ok: false, reason: 'noEdge' })]);
    w.verbs.letGo(w.player!);
    w.step();
    wieldAxe(w);
    verb(w, { verb: 'cut', target: stone });
    evs = run(w, 2).world;
    expect(of(evs, 'verb')).toEqual([expect.objectContaining({ verb: 'cut', ok: false, reason: 'tooHard' })]);
    expect(w.player!.state).not.toBe('attack');
  });
});

// ---------------------------------------------------------------------------
// Projectiles (§5.11)
// ---------------------------------------------------------------------------

describe('projectile world hits and landings (§5.11)', () => {
  it('a thrown spear lands as the same entity id: on the ground, and stopped by a wall in flight (no DS drop, a body again)', async () => {
    for (const into of ['ground', 'wall'] as const) {
      const w = await make();
      const p = w.player!;
      // A fixed scaffold 3 m wide across the flight (DS's scatter turns a throw a little about the vertical).
      const wall = into === 'wall' ? spawnBox(w, { p: { x: 0, y: 1.5, z: 6 }, size: [3, 3, 0.4], material: 'dryWood', state: 'fixed', look: 'scaffold' }) : null;
      const spear = spawnStick(w, { p: { x: -8, y: 0.05, z: -8 }, length: 1.9, r: 0.025, sharp: { end: 1, s: 0.6 } });
      w.step();
      hold(w, spear);
      expect(p.weapon?.id).toBe('spear');
      standAt(w, 0, 0, { x: 0, z: 6 });
      run(w, 2);
      // Level at the wall; or a little down onto the ground.
      const pitch = into === 'wall' ? Math.round((2 / 360) * AIM_STEPS) : -Math.round((10 / 360) * AIM_STEPS);
      verb(w, { verb: 'throw', target: 0, aim: [0, pitch], charge: 255 });
      // The landing (WorldPort.onProjectileLanded): the entity as it is the moment the projectile becomes it again.
      const landed: { ok: boolean; state: string | undefined; enabled: boolean | undefined }[] = [];
      const real = w.onProjectileLanded.bind(w);
      w.onProjectileLanded = (pr) => {
        const ok = real(pr);
        const e = w.entities.get(spear);
        landed.push({ ok, state: e?.state, enabled: e?.body?.isEnabled() });
        return ok;
      };
      const combat: CombatEvent[] = [];
      const world: WorldEvent[] = [];
      let flight: number | null = null;
      for (let t = 0; t < 240; t++) {
        const r = w.step();
        combat.push(...r.combat);
        world.push(...r.world);
        if (w.combat.projectiles.length) flight ??= w.combat.projectiles[0].id;
        if (flight !== null && w.combat.projectiles.length === 0) break;
      }
      expect(flight, into).not.toBeNull();
      expect(w.combat.projectiles, into).toEqual([]);
      // Landed once, as the same entity: free, a body again (no DungeonStyle drop), still the thrower's.
      expect(landed, into).toEqual([{ ok: true, state: 'free', enabled: true }]);
      expect(w.combat.drops, into).toEqual([]);
      expect(w.entities.all().filter((x) => x.state === 'projectile'), into).toEqual([]);
      // From there the contact pipeline scores what it meets: a dry spear into a wall at 20 m/s (340 J against its
      // 51 J break energy) shatters, its pieces still the thrower's.
      const broke = of(world, 'break').find((b) => b.entity === spear);
      const now = broke ? broke.pieces.map((id) => ent(w, id)) : [ent(w, spear)];
      for (const e of now) expect(e.credit, into).toEqual(['p1']);
      if (wall !== null) {
        // Stopped by the world in flight (projectileHit: a `thud` off a wall), as the entity again where it met it.
        const thuds = combat.filter((c): c is Extract<CombatEvent, { type: 'thud' }> => c.type === 'thud' && c.wall);
        expect(thuds.length, into).toBeGreaterThan(0);
        expect(Math.abs(thuds[0].point.z - (6 - 0.2))).toBeLessThan(0.1);
      }
      run(w, 120);
      expect(w.combat.drops, into).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism and the save
// ---------------------------------------------------------------------------

describe('determinism (§8.1)', () => {
  it('two worlds given the same commands chop, cut, cross-cut and dig bit-identically, and the save round-trips', async () => {
    const script = async (): Promise<{ w: World; bytes: Uint8Array }> => {
      const w = await make(33);
      const { tree, vine } = spawnTree(w, { at: { x: 0, z: 2 }, diameter: 0.3, height: 10, vine: { anchorH: 3, lengthM: 5, yaw: Math.PI } });
      wieldAxe(w);
      standAt(w, 1.3, 0.75, { x: 0, z: 0.75 });
      run(w, 2);
      verb(w, { verb: 'focus', target: vine!.rope });
      w.step();
      swing(w);
      for (let k = 0; k < 3; k++) {
        standToChop(w, tree, 100);
        verb(w, { verb: 'cut', target: tree });
        for (let t = 0; t < 200 && (t < 3 || !w.player!.free); t++) w.step();
      }
      w.verbs.letGo(w.player!);
      w.step();
      wieldDiggingStick(w);
      for (let k = 0; k < 3; k++) {
        standAt(w, 4, 0, { x: 4, z: 1 });
        verb(w, { verb: 'focus', target: 0, at: [400, 0, 156] });
        w.step();
        swing(w);
      }
      run(w, 30);
      return { w, bytes: serializeWorld(w) };
    };
    const a = await script();
    const b = await script();
    expect(a.w.entities.all().some((e) => e.material === 'dirt')).toBe(true);
    expect(ent(a.w, 1).plant?.cut?.chops).toBe(3);
    expect(a.w.entities.all().filter((e) => e.material === 'vine' && e.state === 'free')).toHaveLength(1);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    // Save → load → save gives the same entity, joint, terrain (with the dug mask) and felling records (the M1 loader's
    // scope, §8.3): the piles, the severed vine's pieces and the notched tree come back as they were.
    const loaded = await loadWorld(a.bytes, { nav: 'off' });
    live.push(loaded);
    const pick = (bytes: Uint8Array) => {
      const r = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>;
      return JSON.stringify([r.entities, r.removed, r.joints, r.terrain, r.dug, r.felling]);
    };
    expect(pick(serializeWorld(loaded))).toBe(pick(a.bytes));
  });
});
