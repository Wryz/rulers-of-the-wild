// The ape's mind (docs/M1-DESIGN.md §6.1, §6.3, §6.6; package P19): createCreature's ape, the state machine (idle,
// patrol, investigate, chase, fight with the inner BrawlerAI and Bruiser's shoulder charge, flee once per fight, return,
// down, dead and the gloat), the sparring ape's close-range fight, turns between apes, re-paths around a log spawned
// across the path, the pause, the scripts (route, hold, tug), the 1 Hz far-away rate, the markers, determinism and the
// mind's record.
//
// Scenes are flat `scene 'empty'` worlds with a navmesh (nav 'full', 50 m unless a scene needs more room). Scene
// numbers (distances, masses, tick budgets) are test constants, never tuning (§9); expected values come from the
// tuning tables.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, parseCanonicalJson } from '../src/save/canonical';
import type { MindRecV1 } from '../src/save/schema';
import { MOVE_CROUCH, moveCommand } from '../src/sim/commands';
import { ARCHETYPES } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { DT, Rng } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { ApeMind } from '../src/world/creatures/apeMind';
import { CREATURE_TUNING, NOISE_TUNING } from '../src/world/creatures/defs';
import { createCreature } from '../src/world/creatures/factory';
import type { CreatureMind, MindState } from '../src/world/creatures/mind';
import { spawnLog } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Finish, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

/** Rapier worlds, navmeshes and a few thousand ticks: explicit time limits (§11's convention). */
vi.setConfig({ testTimeout: 600_000 });

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 7, scene: 'empty', nav: 'full', size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const A = CREATURE_TUNING.ape;
const secs = (s: number): number => Math.round(s / DT);
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }): number => Math.atan2(to.x - from.x, to.z - from.z);

/** An ape at (x, z) facing `yaw`, made by createCreature, and its mind. */
function apeAt(w: World, x: number, z: number, yaw = 0): { f: Fighter; mind: ApeMind } {
  const f = createCreature(w, 'ape', { x, z }, yaw);
  const mind = w.minds.get(f);
  if (!(mind instanceof ApeMind)) throw new Error('not an ape mind');
  return { f, mind };
}

/**
 * Staging: an idle ape that stays put, facing where it faces (no wander pick, no patrol), so a still player in front
 * of it is seen long enough to be noticed (a grazing ape turns away within a quarter of a second).
 */
function staring(mind: ApeMind): void {
  mind.cooldownUntil = 1e9;
  mind.restUntil = 1e9;
}

/** Steps until `pred` holds; returns the tick, or throws after `max` ticks. `each` runs before every step. */
function until(w: World, pred: () => boolean, max: number, what: string, each?: () => void): number {
  for (let n = 0; n < max; n++) {
    each?.();
    w.step();
    if (pred()) return w.tick;
  }
  throw new Error(`${what} not reached in ${max} ticks (tick ${w.tick})`);
}

function steps(w: World, n: number, each?: () => void): void {
  for (let k = 0; k < n; k++) {
    each?.();
    w.step();
  }
}

/** The states a mind passes through while `run` steps (calling `note` after each step), in order, without repeats. */
function trace(mind: CreatureMind, run: (note: () => void) => void): MindState[] {
  const seen: MindState[] = [mind.state];
  run(() => {
    if (seen[seen.length - 1] !== mind.state) seen.push(mind.state);
  });
  return seen;
}

/** Started an attack in this tick's phase 3 (startMove zeroes sinceMoveStart after tickTimers counted it). */
const startedAttack = (f: Fighter): boolean => f.state === 'attack' && f.sinceMoveStart === 0;

/** A state of a mind's stream whose next draw is below 0.5 (`below`), or at or above it. */
function rngStateWhereNextIs(below: boolean): number {
  for (let s = 1; ; s++) if (new Rng(s).next() < 0.5 === below) return s;
}

/** Player 1 backs off along −x for `outTicks`, comes back for as long, then stands as long, over and over. */
function sparPattern(w: World, outTicks: number): () => void {
  return () => {
    const t = w.tick + 1;
    if (t % 10 !== 0) return;
    const phase = Math.floor(t / outTicks) % 3;
    w.commands.push(moveCommand(t, 1, phase === 0 ? -1 : phase === 1 ? 1 : 0, 0));
  };
}

const strikeBy = (killer: Fighter): Finish => ({
  by: 'strike',
  killer,
  cause: { kind: 'creature', entityId: null, fighterId: killer.id, credit: [], held: true, feature: 'creature' },
  point: { x: killer.pos.x, y: 1, z: killer.pos.z },
});

/** This tick's shout hints from near `at`. */
const shouts = (ev: readonly WorldEvent[], at: V3): Extract<WorldEvent, { type: 'noise' }>[] =>
  ev.filter((e): e is Extract<WorldEvent, { type: 'noise' }> => e.type === 'noise' && e.kind === 'shout' && flat(e.at, at) < 1);

// ---------------------------------------------------------------------------
// The creature
// ---------------------------------------------------------------------------

describe('createCreature: the ape (§6.3)', () => {
  it("is the Bruiser-style ape at the species' scale and mass, with world-owned ids and streams, and an ApeMind", async () => {
    const w = await make();
    const id = w.ids.fighter.next;
    const { f, mind } = apeAt(w, 6, -4, 1.2);
    const S = SPECIES_BODY.ape;
    expect(f.id).toBe(id);
    expect(w.ids.fighter.next).toBe(id + 1);
    expect(f.team).toBe('enemy');
    expect(f.species).toBe('ape');
    expect(f.scale).toBe(S.scale);
    expect(f.massKg).toBe(S.massKg);
    expect(f.mass).toBeCloseTo(97.56, 2);
    expect(f.stats.maxHp).toBe(90);
    expect(f.hp).toBe(90);
    expect(f.stats.walkSpeed).toBe(A.walkSpeed);
    expect(f.stats.staggerResist).toBe(A.staggerResist);
    expect(f.stats.defense).toBe(0);
    expect(f.readSkill).toBe(A.readSkill);
    expect(f.autoDefense).toBe(true);
    expect(f.toughnessJ).toBe(0);
    expect(f.ruler).toBeNull();
    expect(f.yaw).toBe(1.2);
    expect(f.pos.x).toBeCloseTo(6, 9);
    expect(f.pos.z).toBeCloseTo(-4, 9);
    expect(f.pos.y).toBeCloseTo(w.terrain.heightAt(6, -4), 6);
    // The mind: in the registry and CombatSim's brains, its own stream, the human layer, home where it stands.
    expect(w.combat.ais.get(f)).toBe(mind);
    expect(w.minds.get(f)).toBe(mind);
    expect(mind.rng).toBe(w.rngs.mind(f.id));
    expect(mind.path.layer).toBe('human');
    expect(mind.kind).toBe('ape');
    expect(mind.ownsTarget).toBe(true);
    expect(mind.home).toEqual({ x: f.pos.x, z: f.pos.z });
    expect(mind.homeIdx).toBe(-1);
    expect(mind.state).toBe('idle');
    // The inner BrawlerAI: Bruiser's plan at the ape's scale, DS's config with the ape's numbers, no weapon seeking.
    expect(mind.cfg).toEqual({ aggression: A.aggression, blockChance: A.blockChance, stringChance: 0, passive: false });
    const plan = mind.inner.plan;
    expect(plan.moves).toEqual(ARCHETYPES.bruiser.plan.moves);
    expect(plan.specials?.map((s) => s.move)).toContain('shoulderCharge');
    expect(plan.range).toBeCloseTo(1.0 * 1.1, 12);
    expect(plan.attackRange).toBeCloseTo(1.25 * 1.1, 12);
    expect(mind.inner.cfg).toBe(mind.cfg);
    expect(mind.inner.drops).toEqual([]);
    expect(mind.director).toBe(w.combat.director);
    // Bodies: a controller (standing), zones and a slab, like the player's.
    expect(w.kcc.crouched(f)).toBe(false);
    expect(() => w.zones.historyRecord(f)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('the ape notices, investigates, chases and fights (§6.2, §6.3)', () => {
  it('idle → investigate (a chop 20 m away) → chase (sees him) → fight at ≤ fightEnterM, with a shout', async () => {
    const w = await make();
    const p = w.player!;
    // 20 m from the player, its back to him: it can't see him (the cone is 140°) but hears the chop at his feet.
    const { f, mind } = apeAt(w, 20, 0, Math.PI / 2);
    steps(w, 30);
    expect(mind.state).toBe('idle');
    expect(w.minds.view(f).marker).toBe('');
    const chopAt: V3 = { x: p.pos.x, y: p.pos.y + 1, z: p.pos.z };
    w.noise.emit({ at: chopAt, radius: NOISE_TUNING.chop, kind: 'chop', source: null });
    const heardTick = w.tick + 1; // folded in the next tick's phase 17b
    let fightTick = -1;
    let fightDist = Infinity;
    let shoutsAtFight = 0;
    const markers = new Set<string>();
    let investigatedAt = -1;
    const states = trace(mind, (note) => {
      fightTick = until(
        w,
        () => {
          note();
          markers.add(`${mind.state}:${w.minds.view(f).marker}`);
          if (investigatedAt < 0 && mind.state === 'investigate') investigatedAt = w.tick;
          return mind.state === 'fight';
        },
        secs(30),
        'fight',
      );
      fightDist = f.distanceTo(p);
      shoutsAtFight = shouts(w.events, f.rig.head.pos).length;
    });
    expect(states).toEqual(['idle', 'investigate', 'chase', 'fight']);
    // Heard: s = 1 − 20/40 = 0.5, gain 0.6 × 0.5 = 0.3 ≥ investigateAt: investigating at the first decision after it.
    expect(investigatedAt).toBe(heardTick + 1);
    expect(markers).toContain('investigate:?');
    expect(markers).toContain('chase:!');
    expect(fightDist).toBeLessThanOrEqual(A.fightEnterM);
    expect(mind.senses.seenWithin(fightTick)).toBe(true);
    expect(f.target).toBe(p);
    expect(shoutsAtFight).toBe(1);
    expect(w.minds.view(f)).toEqual({ state: 'fight', awareness: mind.senses.level(), marker: '!' });
  });

  it('chases at gait 1.0 (faster than a run) on a path, and loses him: investigate after chaseMemoryS unseen', async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    const { f, mind } = apeAt(w, 14, 0, -Math.PI / 2); // facing the player 14 m away
    staring(mind);
    until(w, () => mind.state === 'chase', secs(5), 'chase');
    expect(f.target).toBe(p);
    steps(w, secs(1));
    expect(Math.hypot(f.walkVel.x, f.walkVel.z)).toBeGreaterThan(3.77);
    expect(mind.path.points.length).toBeGreaterThan(0);
    // He vanishes 40 m behind it (out of sight, still): it goes on to where he was, then investigates.
    w.teleport(p, -40, 30);
    const lastSeen = mind.senses.lastSeenTick;
    const t = until(w, () => mind.state !== 'chase', secs(12), 'leaving the chase');
    expect(mind.state).toBe('investigate');
    expect(t - lastSeen).toBeGreaterThan(secs(A.chaseMemoryS));
    expect(t - lastSeen).toBeLessThanOrEqual(secs(A.chaseMemoryS) + 2);
  });

  it('investigates on arrival: looks around (sniff) for lookAroundS, then returns home and idles there', async () => {
    const w = await make({ player: false });
    const { f, mind } = apeAt(w, -10, 0, 0);
    steps(w, 5);
    w.noise.emit({ at: { x: 2, y: 1, z: 0 }, radius: NOISE_TUNING.chop, kind: 'chop', source: null });
    until(w, () => mind.state === 'investigate', 3, 'investigate');
    const arrive = until(w, () => mind.mark >= 0, secs(15), 'the look-around');
    expect(flat(f.pos, { x: 2, z: 0 })).toBeLessThanOrEqual(A.repathMoveM + 0.5);
    steps(w, 2);
    expect(f.posture).toEqual({ id: 'sniff', weight: 1 });
    // The body sways about the heading it arrived with, within ± lookAroundDeg.
    const rad = (A.lookAroundDeg * Math.PI) / 180;
    const yaws: number[] = [];
    steps(w, secs(A.lookAroundS) - 10, () => yaws.push(f.yaw - mind.heading));
    expect(Math.max(...yaws)).toBeGreaterThan(rad * 0.9);
    expect(Math.min(...yaws)).toBeLessThan(-rad * 0.9);
    expect(Math.max(...yaws.map(Math.abs))).toBeLessThanOrEqual(rad + 1e-9);
    const back = until(w, () => mind.state === 'return', secs(2), 'return');
    expect(back - arrive).toBeGreaterThanOrEqual(secs(A.lookAroundS));
    expect(f.posture).toBeNull();
    until(w, () => mind.state === 'idle', secs(20), 'idle at home');
    expect(flat(f.pos, mind.home)).toBeLessThanOrEqual(A.repathMoveM + 0.5);
  });

  it('goes back to the state it was in once up after a knockdown (down keeps its timers)', async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    const { f, mind } = apeAt(w, 12, 0, -Math.PI / 2);
    staring(mind);
    until(w, () => mind.state === 'chase', secs(5), 'chase');
    const stateTick = mind.stateTick;
    f.enterKnockdown();
    until(w, () => mind.state === 'down', 3, 'down');
    expect(mind.resume).toBe('chase');
    expect(w.minds.view(f).marker).toBe('');
    steps(w, 3);
    expect(f.moveInput.length()).toBe(0);
    until(w, () => mind.state !== 'down', secs(10), 'up again');
    expect(f.state === 'knockdown' || f.state === 'getup').toBe(false);
    expect(['chase', 'fight']).toContain(mind.state);
    if (mind.state === 'chase') expect(mind.stateTick).toBe(stateTick);
    expect(mind.resume).toBeNull();
    expect(f.target).toBe(p);
  });

  it('gloats when he is knocked out (celebrate), then returns home and idles', async () => {
    const w = await make();
    const p = w.player!;
    const { f, mind } = apeAt(w, 0, 2.5, Math.PI);
    mind.setHome({ x: 15, z: 15 });
    mind.engage(w, p);
    steps(w, 30);
    w.combat.koFighter(p, strikeBy(f));
    const t = until(w, () => mind.state === 'return', secs(3), 'return');
    expect(f.state).toBe('celebrate');
    expect(f.target).toBeNull();
    expect(mind.restUntil - t).toBe(secs(A.gloatS));
    // Standing through the gloat.
    const at = { x: f.pos.x, z: f.pos.z };
    steps(w, secs(A.gloatS) - 30);
    expect(flat(f.pos, at)).toBeLessThan(0.3);
    until(w, () => mind.state === 'idle', secs(30), 'idle at home');
    expect(flat(f.pos, mind.home)).toBeLessThanOrEqual(A.repathMoveM + 0.5);
  });

  it('dead once knocked out (no input), and idle again if it is brought back (the spawner, §6.6)', async () => {
    const w = await make();
    const p = w.player!;
    const { f, mind } = apeAt(w, 0, 3, Math.PI);
    mind.engage(w, p);
    steps(w, 5);
    w.combat.koFighter(f, strikeBy(p));
    until(w, () => mind.state === 'dead', 2, 'dead');
    expect(f.target).toBeNull();
    expect(mind.senses.level()).toBe(0);
    steps(w, 10);
    expect(f.moveInput.length()).toBe(0);
    expect(mind.state).toBe('dead');
    // Brought back standing (as a respawn would): it starts over, grazing.
    f.hp = f.stats.maxHp;
    f.enterLocomotion(0);
    steps(w, 1);
    expect(mind.state).toBe('idle');
    expect(w.minds.view(f).state).toBe('idle');
  });
});

describe('the fight (§6.3: BrawlerAI unchanged, Bruiser plan)', () => {
  it('the sparring ape fights from spawn at close range: sparringDistM in front, engaged, it swings within 3 s (D-50)', async () => {
    const w = await make();
    const p = w.player!;
    const { f, mind } = apeAt(w, 0, A.sparringDistM, Math.PI);
    mind.engage(w, p);
    expect(mind.state).toBe('fight');
    expect(f.target).toBe(p);
    expect(mind.senses.of(p.id)).toBe(CREATURE_TUNING.shared.awarenessCap);
    expect(shouts(w.events, f.rig.head.pos).length).toBe(1);
    until(w, () => startedAttack(f), secs(3), 'a swing');
    expect(mind.state).toBe('fight');
  });

  it("uses Bruiser's shoulder charge within 60 s of fighting", async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    p.minHp = 1; // a sparring partner: the fight goes on
    const { f, mind } = apeAt(w, 0, 3, Math.PI);
    mind.engage(w, p);
    const moves: string[] = [];
    until(
      w,
      () => {
        if (startedAttack(f)) moves.push(f.move!.id);
        return moves.includes('shoulderCharge');
      },
      secs(60),
      'a shoulder charge',
      sparPattern(w, 120),
    );
    expect(mind.state).toBe('fight');
  });

  it('two apes never start attacks on the same frame (and both swing)', async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    p.minHp = 1;
    const a = apeAt(w, 0, 3, Math.PI);
    const b = apeAt(w, 3, 0, -Math.PI / 2);
    a.mind.engage(w, p);
    b.mind.engage(w, p);
    const counts = [0, 0];
    let both = 0;
    const spar = sparPattern(w, 150);
    for (let k = 0; k < secs(60); k++) {
      spar();
      w.step();
      const sa = startedAttack(a.f);
      const sb = startedAttack(b.f);
      if (sa) counts[0]++;
      if (sb) counts[1]++;
      if (sa && sb) both++;
    }
    expect(both).toBe(0);
    expect(counts[0]).toBeGreaterThanOrEqual(3);
    expect(counts[1]).toBeGreaterThanOrEqual(3);
    // The turn is the registry's: a second creature's swing on a tick another has swung on waits a tick.
    w.minds.noteAttack(a.f, w.tick + 1);
    expect(w.minds.attackTaken(b.f, w.tick + 1)).toBe(true);
    expect(w.minds.attackTaken(a.f, w.tick + 1)).toBe(false);
    expect(w.minds.attackTaken(b.f, w.tick + 2)).toBe(false);
  });

  it('beyond fightExitM for fightExitTicks it chases again', async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    const { f, mind } = apeAt(w, 0, 3, Math.PI);
    mind.engage(w, p);
    steps(w, 10);
    // He is suddenly 12 m off (in sight): out of reach for fightExitTicks.
    w.teleport(p, 0, 15);
    const out = w.tick;
    const t = until(w, () => mind.state !== 'fight', A.fightExitTicks + 5, 'leaving the fight');
    expect(mind.state).toBe('chase');
    expect(t - out).toBeGreaterThanOrEqual(A.fightExitTicks);
    expect(f.target).toBe(p);
  });
});

describe('flee once per fight (§6.3)', () => {
  it('at ≤ fleeHpFrac on a winning 0.5 roll it flees toward home for fleeS, ignoring him, then returns with awareness halved', async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    p.minHp = 1;
    const { f, mind } = apeAt(w, 0, 3, Math.PI);
    mind.setHome({ x: 0, z: 20 });
    mind.engage(w, p);
    steps(w, 5);
    expect(mind.fleeUntil).toBe(-1);
    f.hp = f.stats.maxHp * A.fleeHpFrac;
    mind.rng.state = rngStateWhereNextIs(true);
    until(w, () => mind.state !== 'fight', 2, 'the roll');
    expect(mind.state).toBe('flee');
    const fled = w.tick;
    expect(mind.fleeUntil - fled).toBeGreaterThanOrEqual(secs(A.fleeS[0]));
    expect(mind.fleeUntil - fled).toBeLessThanOrEqual(secs(A.fleeS[1]));
    expect(f.target).toBeNull();
    // The goal: fleeDistM from the player toward home.
    const goal = mind.path.goal!;
    expect(flat(goal, p.pos)).toBeCloseTo(A.fleeDistM, 0);
    expect(goal.z).toBeGreaterThan(p.pos.z + A.fleeDistM - 1);
    let before = 0;
    until(w, () => mind.state !== 'flee', secs(A.fleeS[1]) + 2, 'the end of the flee', () => {
      before = mind.senses.of(p.id);
    });
    expect(mind.state).toBe('return');
    expect(w.tick).toBe(mind.fleeUntil);
    // Halved (after this tick's sight: unseen at ≥ 18 m, a decay of decayPerS × DT).
    expect(mind.senses.of(p.id)).toBeCloseTo((before - A.decayPerS * DT) / 2, 6);
    expect(flat(f.pos, p.pos)).toBeGreaterThan(15);
    // Back to the fight (he is near home), and no second flee: it rolled already.
    until(w, () => mind.state === 'fight', secs(30), 'the fight again');
    const states = trace(mind, (note) => steps(w, secs(20), note));
    expect(states).not.toContain('flee');
  });

  it('a losing roll keeps it fighting for the rest of the fight, however hurt; above fleeHpFrac it never rolls', async () => {
    const w = await make({ size: 100 });
    const p = w.player!;
    p.minHp = 1;
    const { f, mind } = apeAt(w, 0, 3, Math.PI);
    mind.engage(w, p);
    steps(w, 5);
    // Above the threshold: no draw from the mind's stream.
    f.hp = f.stats.maxHp * A.fleeHpFrac + 1;
    const s0 = mind.rng.state;
    steps(w, 30);
    expect(mind.rng.state).toBe(s0);
    expect(mind.fleeUntil).toBe(-1);
    f.hp = f.stats.maxHp * A.fleeHpFrac;
    mind.rng.state = rngStateWhereNextIs(false);
    steps(w, 1);
    expect(mind.state).toBe('fight');
    expect(mind.fleeUntil).toBe(w.tick);
    f.hp = 2;
    const states = trace(mind, (note) => steps(w, secs(10), note));
    expect(states).not.toContain('flee');
  });
});

// ---------------------------------------------------------------------------
// Idle, patrol, the far rate
// ---------------------------------------------------------------------------

describe('idle and patrol (§6.3)', () => {
  it('grazes within homeRadiusM of home, a new point every idleWanderS, then patrols its loop once and idles', async () => {
    const w = await make({ player: false });
    const { f, mind } = apeAt(w, 0, 0, 0);
    const loop = [
      { x: 12, z: 0 },
      { x: -6, z: 10 },
      { x: -6, z: -10 },
    ];
    // The Clearing's spawn data (generation is P21's): one home with its 3-waypoint loop.
    (w as unknown as { spawnData: unknown }).spawnData = { playerYaw: 0, apeHomes: [{ home: { x: 0, z: 0 }, loop }], lair: null, route: [] };
    mind.setHome({ x: 0, z: 0 }, 0);
    const picks: number[] = [];
    let far = 0;
    let last = mind.cooldownUntil;
    const patrolAt = until(
      w,
      () => {
        if (mind.cooldownUntil !== last) {
          picks.push(w.tick);
          last = mind.cooldownUntil;
        }
        far = Math.max(far, flat(f.pos, mind.home));
        return mind.state === 'patrol';
      },
      secs(A.idleS[1]) + 2,
      'patrol',
    );
    expect(patrolAt).toBeGreaterThanOrEqual(secs(A.idleS[0]));
    expect(far).toBeLessThanOrEqual(A.homeRadiusM + 0.5);
    expect(far).toBeGreaterThan(1);
    expect(picks.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < picks.length; k++) {
      expect(picks[k] - picks[k - 1]).toBeGreaterThanOrEqual(secs(A.idleWanderS[0]));
      expect(picks[k] - picks[k - 1]).toBeLessThanOrEqual(secs(A.idleWanderS[1]));
    }
    // The loop, in order, then idle.
    const reached: number[] = [];
    until(
      w,
      () => {
        for (let k = 0; k < loop.length; k++) if (!reached.includes(k) && flat(f.pos, loop[k]) <= A.repathMoveM + 0.3) reached.push(k);
        return mind.state === 'idle';
      },
      secs(90),
      'idle after the loop',
    );
    expect(reached).toEqual([0, 1, 2]);
  });

  it('an ape with no spawn-data home has no loop: it goes straight back to grazing', async () => {
    const w = await make({ player: false });
    const { mind } = apeAt(w, 0, 0, 0);
    const states = trace(mind, (note) => until(w, () => (note(), mind.state === 'idle' && mind.stateTick > 0), secs(A.idleS[1]) + 2, 'idle again'));
    expect(states).toEqual(['idle', 'patrol', 'idle']);
  });

  it('far from the player (> aiNearM) a mind senses once a second, with Δt = aiFarPeriodTicks × DT; near, every tick', async () => {
    const w = await make({ size: 150 });
    const near = apeAt(w, 20, 0, 0);
    const far = apeAt(w, WORLD_TUNING.aiNearM + 5, 0, 0);
    const nearCalls: number[] = [];
    const farCalls: { tick: number; dt: number }[] = [];
    const ns = near.mind.sense.bind(near.mind);
    const fs = far.mind.sense.bind(far.mind);
    vi.spyOn(near.mind, 'sense').mockImplementation((ww, dt) => {
      nearCalls.push(ww.tick);
      ns(ww, dt);
    });
    vi.spyOn(far.mind, 'sense').mockImplementation((ww, dt) => {
      farCalls.push({ tick: ww.tick, dt: dt ?? DT });
      fs(ww, dt);
    });
    steps(w, 180);
    expect(nearCalls.length).toBe(180);
    expect(farCalls.length).toBe(3);
    for (const c of farCalls) {
      expect((c.tick + far.f.id) % WORLD_TUNING.aiFarPeriodTicks).toBe(0);
      expect(c.dt).toBeCloseTo(WORLD_TUNING.aiFarPeriodTicks * DT, 12);
    }
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('re-pathing (§6.5)', () => {
  it('re-paths around a 300 kg log spawned across its path once the tile is rebuilt', async () => {
    const w = await make({ player: false });
    const { f, mind } = apeAt(w, 0, -12, 0);
    mind.script = { kind: 'route', points: [{ x: 0, z: 12 }], useNav: true };
    steps(w, 10);
    const before = mind.path.points.map((q) => ({ ...q }));
    expect(before.length).toBe(2); // straight across open ground
    expect(Math.max(...before.map((q) => Math.abs(q.x)))).toBeLessThan(0.1);
    // A 1.6 m, 300 kg log lying along x at z = 0, across the way (felling is P10's; RF-20): 0.63 m high lying on a
    // face, a step the human layer's 0.4 m climb can't take on its 0.2 m voxels (a 4.4 m log of that mass is 0.38 m
    // high, and a person steps over it).
    const log = spawnLog(w, { p: { x: 0, y: 0.4, z: 0 }, length: 1.6, mass: 300 });
    const tiles = [...mind.path.tiles];
    const versions = tiles.map((t) => w.nav!.tileVersion('human', t));
    let bumped = -1;
    const repathed = until(
      w,
      () => {
        if (bumped < 0 && tiles.some((t, k) => w.nav!.tileVersion('human', t) !== versions[k])) bumped = w.tick;
        return mind.path.points.some((q) => Math.abs(q.x) > 0.8);
      },
      secs(4),
      'the re-path',
    );
    // After the rebuild (the log at rest), within one tile check (repathCheckTicks) and its service.
    expect(bumped).toBeGreaterThan(0);
    expect(repathed).toBeGreaterThan(bumped);
    expect(repathed - bumped).toBeLessThanOrEqual(CREATURE_TUNING.shared.repathCheckTicks + 1);
    // Around an end of the log (half-length 0.8 m, plus the layer's 0.4 m agent radius), and on to the goal without
    // shoving it.
    expect(w.entities.get(log)!.shape).toMatchObject({ halfHeight: 0.8 });
    expect(Math.max(...mind.path.points.map((q) => Math.abs(q.x)))).toBeGreaterThan(1.1);
    const at = { ...w.entities.get(log)!.pose.p };
    until(w, () => mind.scriptDone, secs(20), 'the goal');
    expect(flat(f.pos, { x: 0, z: 12 })).toBeLessThanOrEqual(A.arriveM + 0.2);
    expect(flat(w.entities.get(log)!.pose.p, at)).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// Pause and scripts
// ---------------------------------------------------------------------------

describe('pause and scripts (§6.6)', () => {
  it('a paused mind writes no input (and no drive) and sets idlePaused; its senses still update; unpaused it acts again', async () => {
    const w = await make();
    const { f, mind } = apeAt(w, 8, 0, -Math.PI / 2);
    until(w, () => mind.state === 'chase', secs(5), 'chase');
    steps(w, 20);
    expect(f.moveInput.length()).toBeGreaterThan(0.5);
    mind.paused = true;
    f.drive = { heading: 1, speed: 2, accel: 1, climb: true };
    const state = mind.state;
    steps(w, 1);
    expect(f.moveInput.length()).toBe(0);
    expect(f.drive).toEqual({ heading: 1, speed: 0, accel: 1, climb: false });
    expect(f.idlePaused).toBe(true);
    f.drive = null;
    const seen = mind.senses.lastSeenTick;
    let attacks = 0;
    steps(w, secs(3), () => {
      if (startedAttack(f)) attacks++;
    });
    expect(attacks).toBe(0);
    expect(f.moveInput.length()).toBe(0);
    expect(Math.hypot(f.walkVel.x, f.walkVel.z)).toBeLessThan(0.01);
    expect(mind.state).toBe(state);
    expect(mind.senses.lastSeenTick).toBeGreaterThan(seen);
    mind.paused = false;
    steps(w, 2);
    expect(f.idlePaused).toBe(false);
    expect(f.moveInput.length()).toBeGreaterThan(0.5);
  });

  it('the tug script crouches: walks crouched to the entity, grips it, stoops and hauls it along dirYaw for `ticks`, then lets go', async () => {
    const w = await make({ player: false, nav: 'off' });
    const log = spawnLog(w, { p: { x: 0, y: 0.15, z: 0 }, length: 1.5, mass: 20 });
    steps(w, 40);
    const { f, mind } = apeAt(w, 0, 3, Math.PI);
    mind.script = { kind: 'tug', entity: log, dirYaw: 0, ticks: 120 };
    steps(w, 2);
    expect(w.kcc.crouched(f)).toBe(true);
    expect(f.moveFlags & MOVE_CROUCH).toBe(MOVE_CROUCH);
    const gripped = until(w, () => mind.routeIdx === 1, secs(5), 'the grip');
    expect(w.verbs.workTarget(f)).toBe(log);
    expect(mind.mark).toBe(gripped);
    const z0 = w.entities.get(log)!.pose.p.z;
    steps(w, 30);
    expect(f.posture).toEqual({ id: 'workLow', weight: 1 });
    expect(w.kcc.crouched(f)).toBe(true);
    const done = until(w, () => mind.scriptDone, 200, 'the end of the tug');
    expect(done - gripped).toBe(120);
    expect(w.verbs.workTarget(f)).toBeNull();
    // Hauled toward +z (dirYaw 0), at creature strength.
    expect(w.entities.get(log)!.pose.p.z - z0).toBeGreaterThan(0.5);
    steps(w, 2);
    expect(f.posture).toBeNull();
    expect(f.moveInput.length()).toBe(0);
  });

  it('route walks its points in order (crouched if asked), suspends transitions, and stands at its end; hold holds a posture', async () => {
    const w = await make({ nav: 'off' });
    const p = w.player!;
    const { f, mind } = apeAt(w, 10, 9, 0);
    // Its last leg heads toward the player (at the spawn), ending about 6 m from him.
    const pts = [
      { x: 10, z: 4 },
      { x: 6, z: 2 },
    ];
    mind.script = { kind: 'route', points: pts, gait: 0.5, crouch: true };
    const order: number[] = [];
    until(
      w,
      () => {
        for (let k = 0; k < pts.length; k++) if (!order.includes(k) && flat(f.pos, pts[k]) <= A.arriveM) order.push(k);
        expect(f.moveFlags).toBe(MOVE_CROUCH);
        return mind.scriptDone;
      },
      secs(15),
      'the route',
    );
    expect(order).toEqual([0, 1]);
    expect(w.kcc.crouched(f)).toBe(true);
    // The player in plain sight 6 m away: awareness rises, but a scripted ape doesn't chase.
    steps(w, secs(2));
    expect(mind.senses.of(p.id)).toBeGreaterThan(A.chaseAt);
    expect(mind.state).toBe('idle');
    expect(f.moveInput.length()).toBe(0);
    mind.script = { kind: 'hold', posture: 'sniff' };
    steps(w, 2);
    expect(f.posture).toEqual({ id: 'sniff', weight: 1 });
    expect(f.moveInput.length()).toBe(0);
    expect(mind.state).toBe('idle');
    // Cleared, the brain takes over: it sees him and chases.
    mind.script = null;
    until(w, () => mind.state === 'chase', secs(2), 'the chase');
  });
});

// ---------------------------------------------------------------------------
// Determinism and the record
// ---------------------------------------------------------------------------

describe('determinism and the record (§6.8, §8)', () => {
  /** An ape 15 m off the player, a 300 kg log spawned between them at tick 30, the player moving: records every 60 ticks. */
  async function run(): Promise<string[]> {
    const w = await make({ seed: 11 });
    const { mind } = apeAt(w, 15, 3, yawTo({ x: 15, z: 3 }, { x: 0, z: 0 }));
    const out: string[] = [];
    const rng = new Rng(99);
    const states = new Set<MindState>();
    for (let t = 1; t <= 1200; t++) {
      if (t === 30) spawnLog(w, { p: { x: 7, y: 0.4, z: 1 }, length: 1.6, mass: 300 });
      if (t % 20 === 0) w.commands.push(moveCommand(w.tick + 1, 1, rng.range(-1, 1), rng.range(-1, 1)));
      w.step();
      states.add(mind.state);
      if (t % 60 === 0) out.push(canonicalJson(w.minds.toRecord()));
    }
    expect(states).toContain('fight');
    return out;
  }

  it('same seed + same log → identical mind records every 60 ticks', async () => {
    const a = await run();
    const b = await run();
    expect(a.length).toBe(20);
    for (let k = 0; k < a.length; k++) expect(b[k], `record at tick ${(k + 1) * 60}`).toBe(a[k]);
    expect(new Set(a).size).toBe(a.length);
  });

  it('round-trips through its record (canonical JSON) onto the mind of the same creature in another world', async () => {
    const w = await make({ size: 100 });
    const { mind } = apeAt(w, 14, 0, -Math.PI / 2);
    staring(mind);
    until(w, () => mind.state === 'chase' && mind.path.points.length > 0, secs(5), 'a chase on a path');
    steps(w, 7);
    mind.senses.stimulus = Infinity; // the window after a hurt
    mind.hurt = { tick: w.tick - 3, point: { x: 1, y: 0.5, z: -2 } };
    const r = mind.toRecord();
    expect(Object.keys(r)).toEqual([
      'fighter',
      'kind',
      'state',
      'stateTick',
      'resume',
      'mark',
      'paused',
      'script',
      'awareness',
      'lkp',
      'lkpTick',
      'lastSeenTick',
      'stimulus',
      'hurt',
      'home',
      'homeIdx',
      'routeIdx',
      'restUntil',
      'cooldownUntil',
      'fleeUntil',
      'heading',
      'charge',
      'path',
      'stuck',
      'rng',
      'inner',
    ]);
    expect(r.state).toBe('chase');
    expect(r.path).not.toBeNull();
    expect(r.inner).not.toBeNull();
    const text = canonicalJson(r);
    // A second world, the same creature made the same way: the record puts the first's mind back exactly.
    const w2 = await make({ size: 100 });
    const { mind: m2 } = apeAt(w2, 14, 0, -Math.PI / 2);
    m2.restoreRecord(parseCanonicalJson(text) as MindRecV1);
    expect(canonicalJson(m2.toRecord())).toBe(text);
    expect(m2.senses.stimulus).toBe(Infinity);
    expect(m2.rng.state).toBe(mind.rng.state);
    // A script, with its options in their order, round-trips too.
    m2.script = { crouch: true, useNav: true, speed: 1.5, points: [{ x: 1, z: 2 }], kind: 'route' } as never;
    const withScript = canonicalJson(m2.toRecord());
    expect(withScript).toContain('"script":{"kind":"route","points":[{"x":1,"z":2}],"speed":1.5,"useNav":true,"crouch":true}');
    m2.restoreRecord(parseCanonicalJson(withScript) as MindRecV1);
    expect(canonicalJson(m2.toRecord())).toBe(withScript);
    // Through the registry, by fighter id; a record for a fighter without a mind, or of another kind, is refused.
    w2.minds.restoreRecord([parseCanonicalJson(text) as MindRecV1]);
    expect(canonicalJson(m2.toRecord())).toBe(text);
    expect(() => w2.minds.restoreRecord([{ ...r, fighter: 99 }])).toThrow(/fighter 99 has no creature mind/);
    expect(() => m2.restoreRecord({ ...r, kind: 'giantApe' })).toThrow(/giantApe/);
    expect(() => m2.restoreRecord({ ...r, inner: null })).toThrow(/no inner BrawlerAI/);
  });
});
