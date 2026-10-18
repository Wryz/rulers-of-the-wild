// Perception (docs/M1-DESIGN.md §6.2; package P18): sight (cone, still and moving range, crouch and cover, occlusion by
// terrain and heavy entities, the peripheral band, a giant's blind side), hearing through the noise bus (radii, the
// felled tree, footsteps by gait, own and teammates' noises, the strongest stimulus), being hurt, wounds, voices, decay,
// the empty bus, and the senses' record.
//
// Scene numbers (distances, masses) are test constants, never tuning (§9). Expected values come from §6.2's formulas
// evaluated on the scene's own rig positions, so the checks are numeric, not just seen/unseen.
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI } from '../src/sim/ai';
import type { CombatEvent } from '../src/sim/combat';
import { MOVE_CROUCH, moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import { type Fighter, IdCounter } from '../src/sim/fighter';
import { DT, Rng } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { CREATURE_TUNING, NOISE_TUNING } from '../src/world/creatures/defs';
import { CreatureMind } from '../src/world/creatures/mind';
import { footstepRadius, heavyLandRadius, type Noise, roarRadius } from '../src/world/creatures/noise';
import { bearingDeg, Senses, UNKNOWN_STIMULUS, visibilityOf } from '../src/world/creatures/perception';
import { physicsReady } from '../src/world/physics';
import type { ImpactCause, Quat, RulerState, SevereEffect, V3, WorldEvent, WoundRecord } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const LYING_X: Quat = { x: Math.sin(Math.PI / 4), y: 0, z: 0, w: Math.cos(Math.PI / 4) }; // local +Y along world −z

/**
 * A mind that only records what reaches it: the senses are driven by the tests, the body stands still. Its phase 2 does
 * nothing (MindRegistry.sense runs each mind's own sight there, §6.1), so only the tests' calls move its awareness.
 */
class TestMind extends CreatureMind {
  readonly hurts: { cause: ImpactCause | null; attacker: Fighter | null; at: V3 }[] = [];
  readonly wounds: WoundRecord[] = [];
  onHurtHook: (() => void) | null = null;
  sense(): void {}
  decide(): void {}
  think(): void {}
  onHurt(cause: ImpactCause | null, attacker: Fighter | null, at: V3): void {
    this.hurts.push({ cause, attacker, at });
    this.onHurtHook?.();
  }
  onWound(w: WoundRecord): void {
    this.wounds.push(w);
  }
}

/** A creature body (the bruiser's, §6.3) at a species' scale and mass, unattached unless `w` adds it. */
function creatureBody(ids: IdCounter, seed: number, species: 'ape' | 'giantApe'): Fighter {
  const { fighter: f } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: seed });
  f.scale = SPECIES_BODY[species].scale;
  f.species = species;
  f.massKg = SPECIES_BODY[species].massKg;
  return f;
}

/** A creature with a TestMind, in the world at (x, z) facing `yaw` (its KCC, zones and slab included). */
function addCreature(w: World, x: number, z: number, yaw = 0, species: 'ape' | 'giantApe' = 'ape'): { f: Fighter; mind: TestMind } {
  const ids = w.ids.fighter;
  const f = creatureBody(ids, w.rngs.fighterSeed(ids.next), species);
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  f.yaw = yaw;
  const mind = new TestMind(w, f, { ...DEFAULT_AI }, species === 'ape' ? 'human' : 'ruler');
  w.addFighter(f, mind);
  w.teleport(f, x, z, yaw);
  return { f, mind };
}

/** A giant body outside the world (no colliders), posed at (x, z) facing `yaw`, with a ruler state. */
function detachedGiant(w: World, x: number, z: number, yaw: number, effects: SevereEffect[] = []): Fighter {
  const f = creatureBody(new IdCounter(1000), 7, 'giantApe');
  f.ruler = rulerWith(effects);
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  f.yaw = yaw;
  f.updatePose(0, 0, 0);
  return f;
}

function wound(effect: SevereEffect | null, id = 1): WoundRecord {
  return {
    id,
    zone: 'eyes',
    bone: 'head',
    local: { x: 0, y: 0, z: 0 },
    severe: effect !== null,
    effect,
    hp: 400,
    remaining: 400,
    cause: { kind: 'entity', entityId: null, fighterId: null, credit: [], held: false, feature: 'sharpPoint' },
    tick: 0,
    credit: [],
  };
}

function rulerWith(effects: SevereEffect[]): RulerState {
  return {
    maxHp: 12000,
    unhealed: 0,
    wounds: effects.map((e, i) => wound(e, i + 1)),
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

/** Puts the player at (x, z) and lets the rigs and queries catch up. */
function placePlayer(w: World, x: number, z: number, yaw = Math.PI): Fighter {
  const p = w.player!;
  w.teleport(p, x, z, yaw);
  settle(w);
  return p;
}

function settle(w: World, ticks = 3): void {
  for (let t = 0; t < ticks; t++) w.step();
  // Still bodies: nothing the steps left moving.
  for (const f of w.combat.fighters) f.walkVel.set(0, 0, 0);
}

/** §6.2 Sight 1-5 evaluated independently on the rigs: d, β, and v for range R (0 outside it). */
function sightNumbers(self: Fighter, target: Fighter, R: number): { d: number; beta: number; v: number } {
  const eye = self.rig.head.pos;
  const chest = target.rig.chest.pos;
  const d = eye.distanceTo(chest);
  const dx = chest.x - eye.x;
  const dz = chest.z - eye.z;
  // Bearing from the facing (sin yaw, 0, cos yaw), + to the left (cos yaw, 0, −sin yaw).
  const beta = Math.atan2(dx * Math.cos(self.yaw) - dz * Math.sin(self.yaw), dx * Math.sin(self.yaw) + dz * Math.cos(self.yaw)) / DEG;
  const v = d < R ? Math.sqrt(1 - d / R) : 0;
  return { d, beta, v };
}

function entity(w: World, shape: { halfHeight: number; r: number }, p: V3, q?: Quat): number {
  return w.addEntity({ material: 'greenWood', shape: { kind: 'cylinder', halfHeight: shape.halfHeight, r: shape.r, sides: 8 }, p, q, state: 'fixed', look: 'test' });
}

function noisesOf(events: readonly WorldEvent[], kind?: string): Extract<WorldEvent, { type: 'noise' }>[] {
  return events.filter((e): e is Extract<WorldEvent, { type: 'noise' }> => e.type === 'noise' && (kind === undefined || e.kind === kind));
}

const A = CREATURE_TUNING.ape;
const G = CREATURE_TUNING.giant;
const S = CREATURE_TUNING.shared;

// ---------------------------------------------------------------------------
// Sight
// ---------------------------------------------------------------------------

describe('sight (§6.2)', () => {
  it('an ape sees a still player at 17 m ahead but not 19 m, and a moving one at 29 m', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 17);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    // 17 m, still: R = sightRangeStillM 18.
    let n = sightNumbers(ape, p, A.sightRangeStillM);
    expect(n.d).toBeGreaterThan(16.5);
    expect(n.d).toBeLessThan(18);
    expect(Math.abs(n.beta)).toBeLessThan(A.sightConeDeg / 2 - S.peripheralDeg);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(n.v, 12);
    mind.senses.sight(w, ape, DT);
    expect(mind.senses.of(p.id)).toBeCloseTo(A.seenRate * n.v * DT, 12);
    expect(mind.senses.lastSeenTick).toBe(w.tick);
    expect(mind.senses.lkp).toEqual({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
    expect(mind.senses.lkpTick).toBe(w.tick);

    // 19 m, still: out of range.
    w.teleport(p, 0, 19, Math.PI);
    settle(w);
    expect(sightNumbers(ape, p, A.sightRangeStillM).d).toBeGreaterThan(18);
    expect(visibilityOf(w, ape, p)).toBe(0);

    // 29 m, moving faster than movingMinSpeed: R = sightRangeM 30.
    w.teleport(p, 0, 29, Math.PI);
    settle(w);
    expect(visibilityOf(w, ape, p)).toBe(0);
    p.walkVel.set(S.movingMinSpeed + 0.3, 0, 0);
    n = sightNumbers(ape, p, A.sightRangeM);
    expect(n.d).toBeGreaterThan(28.5);
    expect(n.d).toBeLessThan(30);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(n.v, 12);
    // At 31 m even moving he is out of range.
    w.teleport(p, 0, 31, Math.PI);
    settle(w);
    p.walkVel.set(S.movingMinSpeed + 0.3, 0, 0);
    expect(visibilityOf(w, ape, p)).toBe(0);
  });

  it('a trunk between them hides him; a light log does not', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 10);
    const { f: ape } = addCreature(w, 0, 0, 0);
    settle(w);
    const seen = visibilityOf(w, ape, p);
    expect(seen).toBeGreaterThan(0);
    // A 45 kg stick standing between (under occluderMinKg 100): still seen.
    const stick = entity(w, { halfHeight: 1, r: 0.1 }, { x: 0, y: 1, z: 5 });
    expect(w.entities.get(stick)!.mass).toBeLessThan(S.occluderMinKg);
    settle(w);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(sightNumbers(ape, p, A.sightRangeStillM).v, 12);
    // A 1.2 t trunk (6 m tall) between: hidden, chest and head.
    w.removeEntity(stick);
    const trunk = entity(w, { halfHeight: 3, r: 0.3 }, { x: 0, y: 3, z: 5 });
    expect(w.entities.get(trunk)!.mass).toBeGreaterThan(S.occluderMinKg);
    settle(w);
    expect(visibilityOf(w, ape, p)).toBe(0);
    const s = new Senses();
    s.sight(w, ape, DT);
    expect(s.of(p.id)).toBe(0);
    expect(s.lastSeenTick).toBe(-1);
    // Stepping out from behind it, he is seen again.
    w.teleport(p, 3, 10, Math.PI);
    settle(w);
    expect(visibilityOf(w, ape, p)).toBeGreaterThan(0);
  });

  it('terrain hides him: a rise between them blocks both rays', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 12);
    const { f: ape } = addCreature(w, 0, 0, 0);
    settle(w);
    expect(visibilityOf(w, ape, p)).toBeGreaterThan(0);
    // A 4 m bank of earth across the line of sight (a fixed dirt box: terrain-like for the ray, and over 100 kg).
    w.addEntity({ material: 'dirt', shape: { kind: 'box', hx: 4, hy: 2, hz: 0.5 }, p: { x: 0, y: 2, z: 6 }, state: 'fixed', look: 'test' });
    settle(w);
    expect(visibilityOf(w, ape, p)).toBe(0);
  });

  it('crouched in cover he is unseen at 10 m; crouched in the open he is seen, at crouchSightMul of the range', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 10);
    const { f: ape } = addCreature(w, 0, 0, 0);
    w.commands.push(moveCommand(w.tick + 1, 1, 0, 0, MOVE_CROUCH));
    settle(w, 5);
    expect(w.kcc.crouched(p)).toBe(true);
    // In the open: R = 18 × 0.6 = 10.8.
    const R = A.sightRangeStillM * S.crouchSightMul;
    const n = sightNumbers(ape, p, R);
    expect(n.d).toBeLessThan(R);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(n.v, 12);
    // Thin cover (below coverMin) is the open.
    const cover = vi.spyOn(w.cover, 'at').mockReturnValue(S.coverMin - 0.1);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(n.v, 12);
    // In cover ≥ coverMin: R = 18 × 0.35 = 6.3 < 10.
    cover.mockReturnValue(0.8);
    expect(visibilityOf(w, ape, p)).toBe(0);
    expect(cover).toHaveBeenCalledWith(p.pos.x, p.pos.z);
    // Standing up in the same cover, he is seen at full range (cover hides only a crouched body).
    w.commands.push(moveCommand(w.tick + 1, 1, 0, 0));
    settle(w, 5);
    expect(w.kcc.crouched(p)).toBe(false);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(sightNumbers(ape, p, A.sightRangeStillM).v, 12);
  });

  it('behind the cone he is unseen; in its outer 20° he counts half', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 5);
    const { f: ape } = addCreature(w, 0, 0, Math.PI); // facing −z: the player is behind it
    settle(w);
    expect(Math.abs(sightNumbers(ape, p, A.sightRangeStillM).beta)).toBeGreaterThan(A.sightConeDeg / 2);
    expect(visibilityOf(w, ape, p)).toBe(0);
    // 60° off the facing (inside the 70° half-cone, in the outer 20°): v halved.
    ape.yaw = 60 * DEG;
    ape.updatePose(0, 0, 0);
    let n = sightNumbers(ape, p, A.sightRangeStillM);
    expect(Math.abs(n.beta)).toBeGreaterThan(A.sightConeDeg / 2 - S.peripheralDeg);
    expect(Math.abs(n.beta)).toBeLessThan(A.sightConeDeg / 2);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(n.v * S.peripheralMul, 12);
    // 30° off: full.
    ape.yaw = -30 * DEG;
    ape.updatePose(0, 0, 0);
    n = sightNumbers(ape, p, A.sightRangeStillM);
    expect(Math.abs(n.beta)).toBeLessThan(A.sightConeDeg / 2 - S.peripheralDeg);
    expect(visibilityOf(w, ape, p)).toBeCloseTo(n.v, 12);
    // 80° off: outside the 140° cone.
    ape.yaw = 80 * DEG;
    ape.updatePose(0, 0, 0);
    expect(Math.abs(sightNumbers(ape, p, A.sightRangeStillM).beta)).toBeGreaterThan(A.sightConeDeg / 2);
    expect(visibilityOf(w, ape, p)).toBe(0);
  });

  it("a giant with a blind eye doesn't see on that side beyond blindDeadDeg", async () => {
    const w = await make();
    // Left of a giant facing +z is +x (fighter-local +X, DungeonStyle's convention).
    const at = (deg: number): [number, number] => [20 * Math.sin(deg * DEG), 20 * Math.cos(deg * DEG)];
    const p = placePlayer(w, ...at(30));
    const sighted = detachedGiant(w, 0, 0, 0);
    expect(bearingDeg(sighted, p.pos.x, p.pos.z)).toBeCloseTo(30, 4); // f32 positions
    const n = sightNumbers(sighted, p, G.sightRangeStillM);
    expect(n.beta).toBeGreaterThan(G.blindDeadDeg);
    expect(visibilityOf(w, sighted, p)).toBeCloseTo(n.v, 12);
    expect(visibilityOf(w, detachedGiant(w, 0, 0, 0, ['blindL']), p)).toBe(0);
    expect(visibilityOf(w, detachedGiant(w, 0, 0, 0, ['blindR']), p)).toBeCloseTo(n.v, 12);
    // A healed blind wound still blinds (wounds persist).
    const healed = detachedGiant(w, 0, 0, 0, ['blindL']);
    healed.ruler!.wounds[0].remaining = 0;
    expect(visibilityOf(w, healed, p)).toBe(0);
    // On the right: the left-blind giant sees him, the right-blind one doesn't.
    w.teleport(p, ...at(-30), Math.PI);
    settle(w);
    expect(visibilityOf(w, detachedGiant(w, 0, 0, 0, ['blindL']), p)).toBeGreaterThan(0);
    expect(visibilityOf(w, detachedGiant(w, 0, 0, 0, ['blindR']), p)).toBe(0);
    // Within blindDeadDeg of the facing: both see.
    w.teleport(p, ...at(10), Math.PI);
    settle(w);
    const nearAhead = sightNumbers(detachedGiant(w, 0, 0, 0), p, G.sightRangeStillM);
    expect(nearAhead.beta).toBeLessThan(G.blindDeadDeg);
    expect(visibilityOf(w, detachedGiant(w, 0, 0, 0, ['blindL']), p)).toBeCloseTo(nearAhead.v, 12);
    expect(visibilityOf(w, detachedGiant(w, 0, 0, 0, ['blindR']), p)).toBeCloseTo(nearAhead.v, 12);
  });

  it('a close sighting reaches chaseAt in under half a second; a far one counts a whole second per sensed tick', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 5);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    p.walkVel.set(1, 0, 0);
    const v = sightNumbers(ape, p, A.sightRangeM).v;
    expect(v).toBeGreaterThan(0.9);
    let ticks = 0;
    while (mind.senses.of(p.id) < A.chaseAt) {
      mind.senses.sight(w, ape, DT);
      ticks++;
    }
    expect(ticks).toBe(Math.ceil(A.chaseAt / (A.seenRate * v * DT) - 1e-9));
    expect(ticks * DT).toBeLessThan(0.5);
    expect(mind.senses.seenWithin(w.tick)).toBe(true);
    // Far rate: Δt = 1 s at once, capped at awarenessCap.
    const far = new Senses();
    far.sight(w, ape, 1);
    expect(far.of(p.id)).toBeCloseTo(Math.min(S.awarenessCap, A.seenRate * v), 12);
    far.sight(w, ape, 1);
    expect(far.of(p.id)).toBe(S.awarenessCap);
  });

  it('only targets are seen: a teammate, a dead player and itself are not', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 6);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    const { f: other } = addCreature(w, 2, 4, Math.PI);
    settle(w);
    mind.senses.sight(w, ape, DT);
    expect([...mind.senses.awareness.keys()]).toEqual([p.id]);
    expect(mind.senses.of(other.id)).toBe(0);
    p.state = 'ko';
    const s = new Senses();
    s.sight(w, ape, DT);
    expect(s.awareness.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Awareness over time
// ---------------------------------------------------------------------------

describe('awareness (§6.2)', () => {
  it('decays at decayPerS (0.12/s for the ape), at either rate, to 0, where the entry goes', async () => {
    const w = await make({ player: false });
    const ape = creatureBody(new IdCounter(50), 1, 'ape');
    ape.updatePose(0, 0, 0);
    const s = new Senses();
    s.awareness.set(9, 1);
    s.awareness.set(UNKNOWN_STIMULUS, 0.5);
    s.sight(w, ape, 1);
    expect(s.of(9)).toBeCloseTo(1 - A.decayPerS, 12);
    expect(s.of(UNKNOWN_STIMULUS)).toBeCloseTo(0.5 - A.decayPerS, 12);
    for (let t = 0; t < 60; t++) s.sight(w, ape, DT);
    expect(s.of(9)).toBeCloseTo(1 - 2 * A.decayPerS, 9);
    for (let t = 0; t < 10; t++) s.sight(w, ape, 1);
    expect(s.awareness.size).toBe(0);
    expect(s.level()).toBe(0);
    // The giant decays at its own rate.
    const giant = detachedGiant(w, 0, 0, 0);
    s.awareness.set(9, 1);
    s.sight(w, giant, 1);
    expect(s.of(9)).toBeCloseTo(1 - G.decayPerS, 12);
  });

  it('level() is the highest awareness; seenWithin() reads lastSeenTick', () => {
    const s = new Senses();
    expect(s.level()).toBe(0);
    s.awareness.set(UNKNOWN_STIMULUS, 0.4);
    s.awareness.set(3, 0.9);
    expect(s.level()).toBe(0.9);
    expect(s.seenWithin(100)).toBe(false);
    s.lastSeenTick = 40;
    expect(s.seenWithin(100)).toBe(true); // exactly seenWithinS (1 s)
    expect(s.seenWithin(101)).toBe(false);
    expect(s.seenWithin(140, 2)).toBe(true);
  });

  it('round-trips through its record, as copies', () => {
    const s = new Senses();
    s.awareness.set(4, 0.25);
    s.awareness.set(UNKNOWN_STIMULUS, 1.5);
    s.lkp = { x: 1.5, y: -0.25, z: 3 };
    s.lkpTick = 77;
    s.lastSeenTick = 70;
    const r = s.toRecord();
    expect(r).toEqual({ awareness: [[4, 0.25], [0, 1.5]], lkp: { x: 1.5, y: -0.25, z: 3 }, lkpTick: 77, lastSeenTick: 70 });
    const t = new Senses();
    t.stimulus = 3;
    t.awareness.set(99, 1);
    t.restoreRecord(r);
    expect(t.toRecord()).toEqual(r);
    expect([...t.awareness.keys()]).toEqual([4, 0]);
    expect(t.stimulus).toBe(0);
    r.lkp!.x = 9;
    r.awareness[0][1] = 9;
    expect(t.lkp).toEqual({ x: 1.5, y: -0.25, z: 3 });
    expect(t.of(4)).toBe(0.25);
    expect(JSON.parse(JSON.stringify(t.toRecord()))).toEqual(t.toRecord());
  });
});

// ---------------------------------------------------------------------------
// Hearing
// ---------------------------------------------------------------------------

describe('hearing (§6.2)', () => {
  it('a chop 30 m away adds heardGain × 0.25 (0.6 × 0.25) and moves lkp to it', async () => {
    const w = await make();
    placePlayer(w, 50, 50);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    const at = { x: ape.pos.x + 30, y: ape.pos.y, z: ape.pos.z };
    w.noise.collect(w, [], [{ type: 'chop', tree: 1, point: at, remaining: 0.5 }]);
    expect(noisesOf(w.events, 'chop')).toEqual([{ type: 'noise', at, radius: NOISE_TUNING.chop, kind: 'chop' }]);
    w.noise.fold(w.minds);
    expect(1 - 30 / (NOISE_TUNING.chop * A.hearingMul)).toBeCloseTo(0.25, 12);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(0.6 * 0.25, 12);
    expect(mind.senses.lkp).toEqual(at);
    expect(mind.senses.lkpTick).toBe(w.tick);
    expect(w.noise.pending).toBe(0);
    // 41 m away: not heard.
    w.noise.collect(w, [], [{ type: 'chop', tree: 1, point: { x: ape.pos.x - 41, y: ape.pos.y, z: ape.pos.z }, remaining: 0.4 }]);
    w.noise.fold(w.minds);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(0.6 * 0.25, 12);
    expect(mind.senses.lkp).toEqual(at);
  });

  it('the giant hears a felled 738 kg trunk at 100 m, from its fall and from its landing', async () => {
    const w = await make({ player: false });
    const { f: giant, mind } = addCreature(w, -60, 0, 0, 'giantApe');
    // A 30 cm, 14.5 m green-wood trunk (8-gon prism): 738 kg.
    const tree = entity(w, { halfHeight: 7.25, r: 0.15 }, { x: 40, y: 0.15, z: 0 }, LYING_X);
    const t = w.entities.get(tree)!;
    expect(t.mass).toBeCloseTo(738, 0);
    expect(heavyLandRadius(t.mass)).toBe(NOISE_TUNING.heavyLandMax);
    settle(w);
    const d = Math.hypot(t.pose.p.x - giant.pos.x, t.pose.p.y - giant.pos.y, t.pose.p.z - giant.pos.z);
    expect(d).toBeCloseTo(100, 1);
    const s = 1 - d / (NOISE_TUNING.heavyLandMax * G.hearingMul);
    expect(s).toBeGreaterThan(0.3);
    w.noise.collect(w, [], [{ type: 'fell', tree, dir: { x: 1, y: 0, z: 0 } }]);
    w.noise.fold(w.minds);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(G.heardGain * s, 12);
    expect(mind.senses.lkp).toEqual(t.pose.p);
    // The trunk lands 7 m on, away from the giant: a second heavy noise, from the landing point.
    const point = { x: 47, y: 0, z: 0 };
    w.noise.collect(w, [], [{ type: 'land', entity: tree, f: null, point, energy: 5000, mass: t.mass }]);
    w.noise.fold(w.minds);
    const s2 = 1 - Math.hypot(point.x - giant.pos.x, point.y - giant.pos.y, point.z - giant.pos.z) / (NOISE_TUNING.heavyLandMax * G.hearingMul);
    expect(s2).toBeGreaterThan(0);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(G.heardGain * (s + s2), 12);
    expect(mind.senses.lkp).toEqual(t.pose.p); // the landing, farther, was the weaker stimulus
  });

  it('heavy landings are heard by mass: 300 kg at 55 m, 738 kg (capped) at 120 m, a pebble at 10 m', () => {
    expect(heavyLandRadius(300)).toBeCloseTo(55, 12);
    expect(heavyLandRadius(738)).toBe(120);
    expect(heavyLandRadius(0.2)).toBeCloseTo(10.03, 12);
    expect(heavyLandRadius(0)).toBe(10);
  });

  it('every event source of §6.2 makes its noise at its radius', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 0, 0);
    const ape = creatureBody(new IdCounter(500), 2, 'ape');
    ape.updatePose(0, 0, 0);
    const T = NOISE_TUNING;
    const pt = new Vector3(1, 1, 1);
    const stone = w.addEntity({ material: 'stone', shape: { kind: 'ball', r: 0.1 }, p: { x: 3, y: 0.1, z: 0 }, state: 'free', look: 'test' });
    const log = w.addEntity({ material: 'greenWood', shape: { kind: 'cylinder', halfHeight: 1.6, r: 0.2, sides: 8 }, p: { x: 6, y: 0.2, z: 0 }, q: LYING_X, state: 'free', look: 'test' });
    const stake = w.addEntity({ material: 'greenWood', shape: { kind: 'cylinder', halfHeight: 0.5, r: 0.05, sides: 8 }, p: { x: -3, y: 0.2, z: 0 }, state: 'anchored', look: 'test' });
    w.entities.get(stone)!.releasedBy = { fighter: p.id, apartTicks: 0 };
    const logMass = w.entities.get(log)!.mass;
    w.events.length = 0;
    const ce = [
      { type: 'hit', attacker: p, defender: ape, point: pt },
      { type: 'block', attacker: p, defender: ape, point: pt },
      { type: 'clang', f: p, point: pt, metal: false },
      { type: 'thud', projectile: { owner: p }, point: pt, speed: 9, wall: false },
      { type: 'swing', f: p },
    ] as unknown as CombatEvent[];
    const we: WorldEvent[] = [
      { type: 'dig', point: pt, volumeM3: 0.01, pile: null },
      { type: 'break', entity: 3, pieces: [], point: pt, energy: 50 },
      { type: 'land', entity: stone, f: null, point: pt, energy: 1, mass: 2 },
      { type: 'land', entity: log, f: null, point: pt, energy: 100, mass: logMass },
      { type: 'land', entity: null, f: p, point: pt, energy: 0, mass: p.mass },
      { type: 'verb', f: p, verb: 'shape', ok: true, entity: log },
      { type: 'verb', f: p, verb: 'place', ok: true, entity: stake },
      { type: 'verb', f: p, verb: 'place', ok: true, entity: log },
      { type: 'verb', f: p, verb: 'shape', ok: false, reason: 'tooHard', entity: log },
      { type: 'joint', joint: 4, what: 'snap', point: pt },
      { type: 'spawn', entity: 9 },
    ];
    w.noise.collect(w, ce, we);
    const got = noisesOf(w.events).map((e) => [e.kind, e.radius]);
    expect(got).toEqual([
      ['hit', T.hit],
      ['shout', T.apeShout], // the ape takes the hit
      ['block', T.block],
      ['clang', T.clang],
      ['throwLand', T.throwLand],
      ['dig', T.dig],
      ['break', T.breakNoise],
      ['throwLand', T.throwLand], // a released stone: at least throwLand
      ['heavyLand', heavyLandRadius(logMass)],
      ['heavyLand', heavyLandRadius(p.mass)], // the player coming down
      ['shape', T.shape],
      ['stakeDriven', T.stakeDriven],
      // a rope snapping, heard at the event's point (the joint is gone by phase 17b)
      ['ropeSnap', T.ropeSnap],
      // a log set down (not anchored), a refused verb and a spawn are silent
    ]);
    // The noises at the shape and stake are at their entities.
    const at = noisesOf(w.events, 'stakeDriven')[0].at;
    expect(at).toEqual(w.entities.get(stake)!.pose.p);
    w.noise.fold(w.minds);
    expect(w.noise.pending).toBe(0);
  });

  it("a crouched maker's own noise is × crouchNoiseMul", async () => {
    const w = await make();
    const p = placePlayer(w, 0, 0);
    p.moveFlags = MOVE_CROUCH;
    const pt = new Vector3(0, 1, 0);
    w.events.length = 0;
    w.noise.collect(w, [{ type: 'clang', f: p, point: pt, metal: false }], [{ type: 'verb', f: p, verb: 'shape', ok: true }]);
    expect(noisesOf(w.events).map((e) => e.radius)).toEqual([NOISE_TUNING.clang * NOISE_TUNING.crouchNoiseMul, NOISE_TUNING.shape * NOISE_TUNING.crouchNoiseMul]);
    w.noise.fold(w.minds);
  });

  it("a noise names its maker when the maker is a target; a creature doesn't hear itself or a teammate's steps", async () => {
    const w = await make();
    const p = placePlayer(w, 4, 0);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    const { f: other, mind: otherMind } = addCreature(w, 0, 4, 0);
    settle(w);
    const step = (f: Fighter): Noise => ({ at: { x: f.pos.x, y: f.pos.y, z: f.pos.z }, radius: NOISE_TUNING.stepWalk, kind: 'step', source: f.id });
    // The player's step: the ape's awareness of the player.
    w.noise.emit(step(p));
    w.noise.fold(w.minds);
    const s = 1 - p.pos.distanceTo(ape.pos) / NOISE_TUNING.stepWalk;
    expect(mind.senses.of(p.id)).toBeCloseTo(A.heardGain * s, 12);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBe(0);
    // A teammate's step: neither ape hears it; its own step isn't heard by the maker.
    const before = mind.senses.toRecord();
    w.noise.emit(step(other));
    w.noise.fold(w.minds);
    expect(mind.senses.toRecord()).toEqual(before);
    expect(otherMind.senses.of(UNKNOWN_STIMULUS)).toBe(0);
    // A teammate's shout is heard (it names no target): something is out there.
    w.noise.shout(other);
    w.noise.fold(w.minds);
    const d = other.rig.head.pos.distanceTo(ape.pos);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(A.heardGain * (1 - d / NOISE_TUNING.apeShout), 12);
    expect(otherMind.senses.of(UNKNOWN_STIMULUS)).toBe(0);
  });

  it('lkp moves only to the strongest stimulus since the last decision', async () => {
    const w = await make({ player: false });
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    const noise = (x: number, radius: number): Noise => ({ at: { x, y: 0, z: 0 }, radius, kind: 'dig', source: null });
    w.noise.emit(noise(10, 20)); // s = 0.5
    w.noise.emit(noise(-15, 20)); // s = 0.25: weaker, lkp stays
    w.noise.fold(w.minds);
    expect(mind.senses.lkp!.x).toBe(10);
    w.noise.emit(noise(-15, 20)); // weaker than the strongest since the last decision: still stays
    w.noise.fold(w.minds);
    expect(mind.senses.lkp!.x).toBe(10);
    w.noise.emit(noise(5, 20)); // s = 0.75: stronger
    w.noise.fold(w.minds);
    expect(mind.senses.lkp!.x).toBe(5);
    // A decision (sight) opens a new window: a weak noise now moves lkp.
    mind.senses.sight(w, ape, DT);
    w.noise.emit(noise(-15, 20));
    w.noise.fold(w.minds);
    expect(mind.senses.lkp!.x).toBe(-15);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(A.heardGain * (0.5 + 0.25 + 0.25 + 0.75 + 0.25) - A.decayPerS * DT, 12);
  });

  it('the giant hears at hearingMul 1.2', async () => {
    const w = await make({ player: false });
    const { f: giant, mind } = addCreature(w, 0, 0, 0, 'giantApe');
    settle(w);
    const at = { x: giant.pos.x + 45, y: giant.pos.y, z: giant.pos.z };
    w.noise.emit({ at, radius: NOISE_TUNING.chop, kind: 'chop', source: null });
    w.noise.fold(w.minds);
    // 45 m: beyond the chop's 40 m for an ape, within 48 m for the giant.
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(G.heardGain * (1 - 45 / (40 * G.hearingMul)), 12);
  });
});

// ---------------------------------------------------------------------------
// Footsteps
// ---------------------------------------------------------------------------

describe('footsteps (§6.2)', () => {
  it('are heard by gait: crouch / walk / run / sprint, × scale, at √scale-scaled speeds', async () => {
    const w = await make({ player: false });
    const T = NOISE_TUNING;
    const human = creatureBody(new IdCounter(600), 1, 'ape');
    human.scale = 1;
    const at = (f: Fighter, speed: number): number => {
      f.walkVel.set(speed, 0, 0);
      return footstepRadius(w, f);
    };
    expect(at(human, 1.4)).toBe(T.stepWalk);
    expect(at(human, 2.6)).toBe(T.stepWalk); // DungeonStyle's locked-on walk
    expect(at(human, 3.77)).toBe(T.stepRun); // the free run
    expect(at(human, 5.28)).toBe(T.stepSprint); // the sprint
    human.moveFlags = MOVE_CROUCH;
    expect(at(human, 1.9)).toBe(T.stepCrouch);
    expect(at(human, 5)).toBe(T.stepCrouch);
    const giant = creatureBody(new IdCounter(700), 1, 'giantApe');
    expect(at(giant, 1.8)).toBeCloseTo(T.stepWalk * 5.5, 12); // patrol: a walk, heard 33 m
    expect(at(giant, 4.5)).toBeCloseTo(T.stepWalk * 5.5, 12); // chase
    expect(at(giant, 7)).toBeCloseTo(T.stepRun * 5.5, 12); // charge: a run, heard 66 m
    const ape = creatureBody(new IdCounter(800), 1, 'ape');
    expect(at(ape, 2.44)).toBeCloseTo(T.stepWalk * 1.1, 12); // investigating
    expect(at(ape, 4.06)).toBeCloseTo(T.stepRun * 1.1, 12); // chasing
  });

  it('a walking player is heard step by step; standing still he is silent; crouched he is quieter', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 0, Math.PI / 2);
    const { f: ape, mind } = addCreature(w, 0, -9, Math.PI); // facing away: it can only hear him
    settle(w);
    const steps: { radius: number; expect: number }[] = [];
    const run = (ticks: number) => {
      for (let t = 0; t < ticks; t++) {
        const r = w.step();
        for (const e of noisesOf(r.world, 'step')) steps.push({ radius: e.radius, expect: footstepRadius(w, p) });
        expect(w.noise.pending).toBe(0);
      }
    };
    run(30);
    expect(steps).toEqual([]);
    expect(mind.senses.of(p.id)).toBe(0);
    // Walking along +x past the ape.
    w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
    run(60);
    expect(steps.length).toBeGreaterThan(2);
    for (const s of steps) expect(s.radius).toBe(s.expect);
    expect(steps.some((s) => s.radius === NOISE_TUNING.stepRun)).toBe(true); // full stick: DungeonStyle's 3.77 m/s run
    expect(new Set(steps.map((s) => s.radius)).has(NOISE_TUNING.stepCrouch)).toBe(false);
    expect(mind.senses.of(p.id)).toBeGreaterThan(0);
    expect(mind.senses.lkp).not.toBeNull();
    expect(visibilityOf(w, ape, p)).toBe(0); // heard, not seen
    // Crouched: every step at stepCrouch.
    steps.length = 0;
    w.commands.push(moveCommand(w.tick + 1, 1, -1, 0, MOVE_CROUCH));
    run(10);
    steps.length = 0;
    run(60);
    expect(steps.length).toBeGreaterThan(2);
    for (const s of steps) expect(s.radius).toBe(NOISE_TUNING.stepCrouch);
  });
});

// ---------------------------------------------------------------------------
// Being hurt, wounds, voices
// ---------------------------------------------------------------------------

describe('being hurt, wounds and voices (§6.2, §6.1 phase 17b)', () => {
  it('a hit from a fighter sets awareness to hurtByFighter and lkp to the attacker, then calls onHurt; the ape shouts', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 1.2, Math.PI);
    const { f: ape, mind } = addCreature(w, 0, 0, Math.PI); // its back to him
    const { mind: friend } = addCreature(w, 6, 0, 0);
    settle(w);
    const point = new Vector3(0, 1.4, 0.3);
    w.events.length = 0;
    w.noise.collect(w, [{ type: 'hit', attacker: p, defender: ape, point } as unknown as CombatEvent], []);
    expect(noisesOf(w.events).map((e) => e.kind)).toEqual(['hit', 'shout']);
    w.noise.fold(w.minds);
    expect(mind.senses.of(p.id)).toBe(S.hurtByFighter);
    expect(mind.senses.lkp).toEqual({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
    expect(mind.hurts).toEqual([{ cause: null, attacker: p, at: { x: 0, y: 1.4, z: 0.3 } }]);
    // The friend heard the blow (the player's: his awareness) and the shout (a teammate's: something).
    expect(friend.senses.of(p.id)).toBeGreaterThan(0);
    expect(friend.senses.of(UNKNOWN_STIMULUS)).toBeGreaterThan(0);
    expect(friend.hurts).toEqual([]);
  });

  it('a log falling on it sets hurtByWorld and lkp to the impact; a thrown spear names its thrower', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 10, Math.PI);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    const point = { x: 0.1, y: 1.6, z: 0 };
    const cause: ImpactCause = { kind: 'entity', entityId: 5, fighterId: null, credit: ['p1'], held: false, feature: 'falling' };
    const impact = (c: ImpactCause, damage: number) =>
      ({ type: 'impact', tick: w.tick, defender: ape, point, cause: c, damage, knockdown: false }) as unknown as WorldEvent;
    w.events.length = 0;
    w.noise.collect(w, [], [impact(cause, 12)]);
    w.noise.fold(w.minds);
    expect(mind.senses.of(UNKNOWN_STIMULUS)).toBe(S.hurtByWorld);
    expect(mind.senses.of(p.id)).toBe(0);
    expect(mind.senses.lkp).toEqual(point);
    expect(mind.hurts).toEqual([{ cause, attacker: null, at: point }]);
    expect(noisesOf(w.events, 'shout')).toHaveLength(1);
    // A thrown spear (the cause names the thrower): the thrower's awareness, lkp at him.
    const spear: ImpactCause = { kind: 'entity', entityId: 6, fighterId: p.id, credit: ['p1'], held: true, feature: 'sharpPoint' };
    w.events.length = 0;
    w.noise.collect(w, [], [impact(spear, 0)]);
    w.noise.fold(w.minds);
    expect(mind.senses.of(p.id)).toBe(S.hurtByFighter);
    expect(mind.senses.lkp).toEqual({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
    expect(mind.hurts[1].attacker).toBe(p);
    // A blow that did nothing raises no shout.
    expect(noisesOf(w.events, 'shout')).toEqual([]);
    // Hurt never lowers awareness, and a dead creature is not told.
    ape.state = 'ko';
    w.noise.collect(w, [], [impact(cause, 50)]);
    w.noise.fold(w.minds);
    expect(mind.hurts).toHaveLength(2);
  });

  it("a wound goes to the ruler's mind with a roar (× weakJawRoarMul with a weak jaw); getting up roars", async () => {
    const w = await make({ player: false });
    const g = detachedGiant(w, 0, 0, 0);
    const mind = new TestMind(w, g, { ...DEFAULT_AI, passive: true }, 'ruler');
    w.minds.add(g, mind);
    const wd = wound(null);
    w.events.length = 0;
    w.noise.collect(w, [], [{ type: 'wound', ruler: g, wound: wd, byWorld: true }, { type: 'rise', f: g }]);
    expect(noisesOf(w.events).map((e) => [e.kind, e.radius])).toEqual([
      ['roar', NOISE_TUNING.giantRoar],
      ['roar', NOISE_TUNING.giantRoar],
    ]);
    expect(noisesOf(w.events)[0].at).toEqual({ x: g.rig.head.pos.x, y: g.rig.head.pos.y, z: g.rig.head.pos.z });
    w.noise.fold(w.minds);
    expect(mind.wounds).toEqual([wd]);
    const jaw = detachedGiant(w, 0, 0, 0, ['weakJaw']);
    expect(roarRadius(jaw)).toBeCloseTo(NOISE_TUNING.giantRoar * G.weakJawRoarMul, 12);
    // A player getting up (no ruler) is silent.
    const human = creatureBody(new IdCounter(900), 3, 'ape');
    w.events.length = 0;
    w.noise.collect(w, [], [{ type: 'rise', f: human }]);
    expect(noisesOf(w.events)).toEqual([]);
    w.noise.fold(w.minds);
  });

  it('a noise a mind makes while it is folded is heard in the same fold', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 1, Math.PI);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    const { mind: friend } = addCreature(w, 0, -8, 0);
    settle(w);
    mind.onHurtHook = () => w.noise.roar(ape);
    w.noise.collect(w, [{ type: 'hit', attacker: p, defender: ape, point: new Vector3() } as unknown as CombatEvent], []);
    w.noise.fold(w.minds);
    // The friend heard the hit, the bus's shout and the mind's roar; all in this fold.
    const d = (q: V3) => Math.hypot(q.x - (friend.self.pos.x), q.y - friend.self.pos.y, q.z - friend.self.pos.z);
    const head = ape.rig.head.pos;
    const expected = A.heardGain * (1 - d(head) / NOISE_TUNING.apeShout) + A.heardGain * (1 - d(head) / NOISE_TUNING.giantRoar);
    expect(friend.senses.of(UNKNOWN_STIMULUS)).toBeCloseTo(expected, 12);
    expect(w.noise.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The bus
// ---------------------------------------------------------------------------

describe('the noise bus (§3 phase 17b)', () => {
  it('is empty after fold, even when a mind throws', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 1, Math.PI);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    w.noise.emit({ at: { x: 0, y: 0, z: 0 }, radius: 5, kind: 'dig', source: null });
    w.noise.collect(w, [{ type: 'hit', attacker: p, defender: ape, point: new Vector3() } as unknown as CombatEvent], []);
    expect(w.noise.pending).toBe(4); // dig, hit, the hurt, the shout
    w.noise.fold(w.minds);
    expect(w.noise.pending).toBe(0);
    mind.onHurtHook = () => {
      throw new Error('a mind that breaks');
    };
    w.noise.collect(w, [{ type: 'hit', attacker: p, defender: ape, point: new Vector3() } as unknown as CombatEvent], []);
    expect(() => w.noise.fold(w.minds)).toThrow(/breaks/);
    expect(w.noise.pending).toBe(0);
  });

  it('drops a noise without a finite point; a hurt without one is at the defender', async () => {
    const w = await make();
    const p = placePlayer(w, 0, 2, Math.PI);
    const { f: ape, mind } = addCreature(w, 0, 0, 0);
    settle(w);
    w.events.length = 0;
    w.noise.emit({ at: { x: NaN, y: 0, z: 0 }, radius: 5, kind: 'dig', source: null });
    w.noise.emit({ at: { x: 0, y: 0, z: 0 }, radius: NaN, kind: 'heavyLand', source: null });
    w.noise.collect(w, [{ type: 'hit', attacker: p, defender: ape } as unknown as CombatEvent], []);
    expect(noisesOf(w.events).map((e) => e.kind)).toEqual(['shout']);
    w.noise.fold(w.minds);
    expect(mind.hurts).toEqual([{ cause: null, attacker: p, at: { x: ape.pos.x, y: ape.pos.y, z: ape.pos.z } }]);
    expect(w.noise.pending).toBe(0);
  });

  it('is empty at the end of every world step, and the same scene hears the same in two worlds', async () => {
    const run = async () => {
      const w = await make({ seed: 11 });
      placePlayer(w, 0, 0, Math.PI / 2);
      const { mind } = addCreature(w, 3, -6, Math.PI);
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      const records: unknown[] = [];
      for (let t = 0; t < 90; t++) {
        w.step();
        expect(w.noise.pending).toBe(0);
        if (t % 30 === 29) records.push(JSON.stringify(mind.senses.toRecord()));
      }
      return records;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.at(-1)).not.toBe(JSON.stringify(new Senses().toRecord()));
  });
});
