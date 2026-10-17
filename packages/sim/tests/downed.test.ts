// The downed and launched body (docs/M1-DESIGN.md §4.5, §1.5.8; package P08): the slab enabled in phase 4a with the
// launch velocity (DS knockback, the presentation pop moved into the sim, the topple), f.pos following its hip, the settle
// hold, the stand-spot search and the hand-back to the controller; a slab at rest on 30°; getting up across a fixed log
// and beside a 300 kg log; launch distances against MAP gap-4's calibration; KO corpses, respawns, Δv, records; and
// the definition of done: a player and an ape walk, fight with DS melee and get knocked down on bumpy terrain, headless.
//
// Scene numbers (masses, sizes, blows) are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BRAWLER_PLAN, BrawlerAI, DEFAULT_AI } from '../src/sim/ai';
import type { CombatEvent } from '../src/sim/combat';
import { moveCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { CHARACTER_TUNING } from '../src/world/characters';
import { DOWNED_TUNING } from '../src/world/downed';
import { MATERIALS } from '../src/world/materials';
import { physicsReady } from '../src/world/physics';
import type { Quat, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';

const live: World[] = [];
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', size: 50, ...o });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('DOWNED_TUNING');
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
const len = (v: V3): number => Math.hypot(v.x, v.y, v.z);
/** Lying on its back along +x, head toward +x (local +Y → x, local +Z (the face) → up). */
const ALONG_X: Quat = { x: -0.5, y: -0.5, z: -0.5, w: 0.5 };
/** Lying on its back along +z, head toward +z. */
const ALONG_Z: Quat = { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2, w: 0 };
const LOG_Z: Quat = { x: Math.sin(Math.PI / 4), y: 0, z: 0, w: Math.cos(Math.PI / 4) };

function addApe(w: World, x: number, z: number, yaw = 0, brain = false): Fighter {
  const ids = w.ids.fighter;
  const { fighter: f, ai } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  f.scale = SPECIES_BODY.ape.scale;
  f.species = 'ape';
  f.massKg = SPECIES_BODY.ape.massKg;
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  f.yaw = yaw;
  w.addFighter(f, brain ? ai : null);
  w.teleport(f, x, z, yaw);
  return f;
}

/**
 * A blow in the next tick's phase 3, as CombatSim's hit() leaves it: the knockback in f.vel, knockdown (or KO), and a
 * `hit` event carrying the move's lift (null: no blow, e.g. a bleed-out).
 */
function knock(w: World, f: Fighter, o: { kb: number; dir?: V3; lift?: number | null; ko?: boolean }): void {
  const sim = w.combat;
  const orig = sim.stepBody;
  sim.stepBody = function (): CombatEvent[] {
    sim.stepBody = orig;
    const ev = orig.call(sim);
    const d = o.dir ?? { x: 1, y: 0, z: 0 };
    f.vel.set(d.x * o.kb, 0, d.z * o.kb);
    if (o.ko) f.enterKO();
    else f.enterKnockdown();
    const lift = o.lift === undefined ? 0 : o.lift;
    if (lift !== null) ev.push({ type: 'hit', attacker: f, defender: f, move: { lift }, knockdown: !o.ko, ko: !!o.ko } as unknown as CombatEvent);
    return ev;
  };
}

/** Steps until the fighter is back on its feet (the hand-back): the tick, or −1. */
function untilHandBack(w: World, f: Fighter, max = 800): number {
  for (let t = 0; t < max; t++) {
    w.step();
    if (!w.downed.active(f) && w.kcc.isEnabled(f)) return w.tick;
  }
  return -1;
}

/** Puts an active slab at a pose, at rest (a staged body for the stand-spot cases). */
function placeSlab(w: World, f: Fighter, p: V3, q: Quat): void {
  const z = { x: 0, y: 0, z: 0 };
  w.downed.restoreRecord([{ fighter: f.id, slab: { enabled: true, pose: { p, q }, lin: z, ang: z, hold: 0, handedBack: false, dv: null } }]);
}

// ---------------------------------------------------------------------------

describe('the slab (§4.5)', () => {
  it('is built disabled with the fighter, a 0.48 × 1.81 × 0.20 m rounded box of the fighter’s mass', async () => {
    const w = await make();
    const p = w.player!;
    expect(w.downed.active(p)).toBe(false);
    expect(w.downed.pose(p.id)).toBeNull();
    // Found by no query while disabled.
    w.step();
    expect(w.queries.castRay({ x: 0, y: 0.9, z: -3 }, { x: 0, y: 0, z: 1 }, 6, { terrain: false, entities: 'none', fighters: 'zones' })?.owner.part).toBe('zone');
    const T = DOWNED_TUNING;
    expect(2 * (T.halfWidth + T.border)).toBeCloseTo(0.48, 9);
    expect(2 * (T.halfLength + T.border)).toBeCloseTo(1.81, 9);
    expect(2 * (T.halfThick + T.border)).toBeCloseTo(0.2, 9);
  });

  it('a knockdown launches it in phase 4a: (f.vel + f.walkVel) with the pop and the topple; controller and zones off', async () => {
    const w = await make({ seed: 2 });
    const p = w.player!;
    w.teleport(p, 0, 0, -Math.PI / 2); // facing −x, the blow along +x
    for (let t = 0; t < 5; t++) w.step();
    knock(w, p, { kb: 2.2, lift: 0.75 });
    const r = w.step();
    const launch = r.world.find((e): e is Extract<WorldEvent, { type: 'launch' }> => e.type === 'launch');
    expect(launch?.f).toBe(p);
    const T = DOWNED_TUNING;
    expect(launch!.vel.x).toBeCloseTo(2.2, 9);
    expect(launch!.vel.y).toBeCloseTo(T.liftBase + T.liftPerLift * 0.75, 9);
    expect(launch!.vel.z).toBeCloseTo(0, 9);
    // About up × dir = (0, 0, −1): the head goes with the blow.
    expect(launch!.angVel).toEqual({ x: 0, y: 0, z: -T.toppleRadS });
    expect(w.downed.active(p)).toBe(true);
    expect(w.kcc.isEnabled(p)).toBe(false);
    expect(w.zones.enabled(p)).toBe(false);
    expect([p.vel.x, p.vel.z, p.walkVel.x, p.walkVel.z]).toEqual([0, 0, 0, 0]);
    // Launched from where the fighter stood, upright, feet on the ground: one step on at the launch velocity.
    const pose = w.downed.pose(p.id)!;
    const half = (T.halfLength + T.border) * p.scale;
    expect(pose.p.y).toBeGreaterThan(half);
    expect(pose.p.y).toBeLessThan(half + launch!.vel.y / 60 + 1e-3);
    expect(pose.p.x).toBeCloseTo(launch!.vel.x / 60, 2);
    // A weak blow still topples along it at minPush; no blow at all (a collapse) falls backwards with no pop.
    const w2 = await make({ seed: 3 });
    const q = w2.player!;
    w2.teleport(q, 0, 0, 0); // facing +z
    w2.step();
    knock(w2, q, { kb: 0, lift: null });
    const r2 = w2.step();
    const l2 = r2.world.find((e): e is Extract<WorldEvent, { type: 'launch' }> => e.type === 'launch')!;
    expect(l2.vel.x).toBeCloseTo(0, 9);
    expect(l2.vel.y).toBe(0);
    expect(l2.vel.z).toBeCloseTo(-T.minPush, 9);
  });

  it('f.pos follows the hip on its support; the fighter gets up where the standing capsule fits, and walks on', async () => {
    const w = await make({ seed: 4 });
    w.terrain.generate((x, z) => 0.15 * Math.sin(x * 1.1) + 0.1 * Math.cos(z * 0.8));
    const p = w.player!;
    w.teleport(p, 0, 0, -Math.PI / 2);
    for (let t = 0; t < 5; t++) w.step();
    const start = { ...p.pos };
    knock(w, p, { kb: 4.8, lift: 0.15 });
    w.step();
    for (let t = 0; t < 30; t++) {
      w.step();
      const hip = w.downed.hip(p.id)!;
      expect(p.pos.x).toBe(hip.x);
      expect(p.pos.z).toBe(hip.z);
      expect(p.pos.y).toBeCloseTo(w.terrain.heightAt(hip.x, hip.z), 5);
      expect(p.state).toBe('knockdown');
    }
    const back = untilHandBack(w, p);
    expect(back).toBeGreaterThan(0);
    expect(hdist(p.pos, start)).toBeGreaterThan(1);
    expect(p.state).toBe('knockdown'); // the frame before the getup
    w.step();
    expect(p.state).toBe('getup');
    expect(w.zones.enabled(p)).toBe(true);
    expect(w.kcc.grounded(p)).toBe(true);
    const c = w.kcc.capsulePose(p)!;
    expect(p.pos.x).toBe(c.p.x);
    expect(p.pos.y).toBe(c.p.y - w.kcc.footOffsetOf(p));
    for (let t = 0; t < 60; t++) w.step();
    expect(p.state === 'idle' || p.state === 'walk').toBe(true);
    let grounded = 0;
    for (let t = 0; t < 60; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
      if (w.kcc.grounded(p)) grounded++;
    }
    expect(grounded).toBe(60);
  });

  it('holds the fighter down while the slab still moves faster than settleSpeed, at most settleMaxHold frames', async () => {
    const w = await make({ seed: 5 });
    const p = w.player!;
    w.step();
    knock(w, p, { kb: 1, lift: 0 });
    w.step();
    // Keep it sliding through the frame before the getup (≈ 1 m/s: a world impact's Δv every tick against friction).
    let held = 0;
    let pushedUntil = -1;
    for (let t = 0; t < 400; t++) {
      if (p.stateFrame >= 60 && p.stateFrame < 100) {
        w.downed.queueDv(p, { x: 0, y: 0, z: 0.25 });
        pushedUntil = w.tick + 1;
      }
      w.step();
      if (p.state === 'knockdown' && p.stunFrames > 70) held = Math.max(held, p.stunFrames - 70);
      if (p.state === 'getup') break;
    }
    expect(held).toBeGreaterThan(25);
    expect(p.state).toBe('getup');
    // Up only once it slowed down: after the pushes stopped.
    expect(w.tick).toBeGreaterThan(pushedUntil);
    // A slab that never settles still gets up after settleMaxHold frames.
    const w2 = await make({ seed: 6 });
    const q = w2.player!;
    w2.step();
    knock(w2, q, { kb: 1, lift: 0 });
    w2.step();
    let downFor = 0;
    for (let t = 0; t < 600 && q.state === 'knockdown'; t++) {
      // Kept sliding at 1 m/s along x.
      const v = w2.downed.velocity(q.id);
      if (v) w2.downed.queueDv(q, { x: 1 - v.lin.x, y: 0, z: -v.lin.z });
      w2.step();
      downFor++;
    }
    expect(q.state).not.toBe('knockdown');
    expect(downFor).toBeGreaterThan(69 + DOWNED_TUNING.settleMaxHold - 2);
    expect(downFor).toBeLessThan(69 + DOWNED_TUNING.settleMaxHold + 5);
  });

  it('rests on a 30° slope (a lying capsule would roll away)', async () => {
    const w = await make({ seed: 7 });
    const k = Math.tan(30 * DEG);
    w.terrain.generate((x) => k * x);
    const p = w.player!;
    w.teleport(p, 0, 0, 0); // facing +z: the blow along +z, across the slope
    w.step();
    knock(w, p, { kb: 2, dir: { x: 0, y: 0, z: 1 }, lift: 0 });
    w.step();
    for (let t = 0; t < 60; t++) w.step();
    const at = w.downed.hip(p.id)!;
    const v = w.downed.velocity(p.id)!;
    expect(len(v.lin)).toBeLessThan(DOWNED_TUNING.settleSpeed);
    // Still there a second later.
    for (let t = 0; t < 60; t++) w.step();
    const later = w.downed.hip(p.id) ?? p.pos;
    expect(Math.hypot(later.x - at.x, later.y - at.y, later.z - at.z)).toBeLessThan(0.15);
    // And it gets up on the slope, grounded.
    const back = untilHandBack(w, p);
    expect(back).toBeGreaterThan(0);
    w.step();
    expect(w.kcc.grounded(p)).toBe(true);
    expect(Math.abs(p.pos.y - w.terrain.heightAt(p.pos.x, p.pos.z))).toBeLessThan(0.1);
  });

  it('gets up across a fixed log: on top of it at the hip, then walks off grounded', async () => {
    const w = await make({ seed: 8 });
    const r = 0.2;
    w.addEntity({ material: 'greenWood', shape: { kind: 'cylinder', halfHeight: 2, r, sides: 6 }, p: { x: 0, y: r, z: 0 }, q: LOG_Z, state: 'fixed', look: 'log' });
    const p = w.player!;
    w.teleport(p, -2, 0, Math.PI / 2);
    for (let t = 0; t < 3; t++) w.step();
    knock(w, p, { kb: 1, lift: 0 });
    w.step();
    // The body lying across the log, its hip over it.
    const hipAlong = DOWNED_TUNING.boneBands[1] - (DOWNED_TUNING.halfLength + DOWNED_TUNING.border);
    placeSlab(w, p, { x: -hipAlong, y: 2 * r + 0.11, z: 0 }, ALONG_X);
    for (let t = 0; t < 40; t++) w.step();
    expect(Math.abs(w.downed.hip(p.id)!.x)).toBeLessThan(0.4);
    const back = untilHandBack(w, p);
    expect(back).toBeGreaterThan(0);
    // On the log's top (a hex of circumradius 0.2: its top between 0.346 and 0.4 m).
    expect(p.pos.y).toBeGreaterThan(0.3);
    expect(Math.abs(p.pos.x)).toBeLessThan(0.4);
    w.step();
    let grounded = 0;
    for (let t = 0; t < 60; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
      if (w.kcc.grounded(p)) grounded++;
    }
    expect(grounded).toBeGreaterThanOrEqual(57);
    expect(p.pos.x).toBeGreaterThan(1);
    expect(Math.abs(p.pos.y)).toBeLessThan(0.05);
  });

  it('gets up beside a 300 kg log: the hip spot is blocked, the first ring spot (0.35 m) clear of it is taken', async () => {
    const w = await make({ seed: 9 });
    const R = 0.3;
    const length = 300 / MATERIALS.dryWood.density / ((6 / 2) * R * R * Math.sin((2 * Math.PI) / 6));
    const log = w.addEntity({ material: 'dryWood', shape: { kind: 'cylinder', halfHeight: length / 2, r: R, sides: 6 }, p: { x: 0, y: R, z: 0 }, q: LOG_Z, state: 'free', look: 'log' });
    expect(w.entities.get(log)!.mass).toBeCloseTo(300, 6);
    const p = w.player!;
    w.teleport(p, 2, 0, Math.PI / 2);
    for (let t = 0; t < 3; t++) w.step();
    knock(w, p, { kb: 1, lift: 0 });
    w.step();
    const apothem = R * Math.cos(Math.PI / 6);
    const sx = apothem + 0.1 + 0.02;
    placeSlab(w, p, { x: sx, y: 0.1, z: 0 }, ALONG_Z);
    for (let t = 0; t < 40; t++) w.step();
    const hip = w.downed.hip(p.id)!;
    expect(hip.x).toBeLessThan(0.55); // still beside the log: a standing capsule (r 0.3) at the hip would be in it
    const logAt = { ...w.entities.get(log)!.pose.p };
    const back = untilHandBack(w, p);
    expect(back).toBeGreaterThan(0);
    const ring = DOWNED_TUNING.standRings[0];
    expect(Math.hypot(p.pos.x - hip.x, p.pos.z - hip.z)).toBeCloseTo(ring, 2);
    // Clear of the log: the capsule's axis is more than its radius plus the log's from the log's axis.
    expect(p.pos.x - logAt.x).toBeGreaterThan(CHARACTER_TUNING.capsuleR + apothem - 0.01);
    w.step();
    expect(w.kcc.grounded(p)).toBe(true);
    // The log was not shoved by the hand-back.
    expect(hdist(w.entities.get(log)!.pose.p, logAt)).toBeLessThan(0.01);
    let grounded = 0;
    for (let t = 0; t < 60; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
      if (w.kcc.grounded(p)) grounded++;
    }
    expect(grounded).toBe(60);
  });

  // MAP gap-4 §2 and §4: DS's knockback after CombatSim's step (kb) and the move's lift for six blows; the hip travel at
  // the getup frame its lab measured for the recommended slab on flat ground (`slab`, its calibration table), and where
  // today's ragdoll pelvis is then (`ragdoll`: the slab lands −23 % … +36 % of it, §4.5). The gate is gap-4's slab
  // calibration within ±10 %: its lab ground had friction 0.9 and M1's dirt has 0.7 (the slab's 0.9 averaged with it:
  // 0.8, not 0.9), so a body slides a few per cent further here (+3 % for the sweep, which puts it at +40 % of the
  // ragdoll instead of gap-4's +36 %).
  const BLOWS: { name: string; kb: number; lift: number; ape?: boolean; ko?: boolean; slab: number; ragdoll: number }[] = [
    { name: 'Shoulder Charge, ape → man', kb: 4.8, lift: 0.15, slab: 2.94, ragdoll: 2.861 },
    { name: 'Uppercut', kb: 2.2, lift: 0.75, slab: 1.86, ragdoll: 1.734 },
    { name: 'Flying kick, man → ape', kb: 3.111, lift: 0.3, ape: true, slab: 2.13, ragdoll: 2.425 },
    { name: 'Sweep', kb: 1.828, lift: 0.6, slab: 1.43, ragdoll: 1.053 },
    { name: 'Poise-break jab', kb: 0.8, lift: 0, slab: 0.75, ragdoll: 0.724 },
    { name: 'KO hook', kb: 4.1, lift: 0.1, ko: true, slab: 2.31, ragdoll: 2.83 },
  ];
  for (const b of BLOWS) {
    it(`launch distance, ${b.name}: hip travel at the getup frame within ±10 % of MAP gap-4's ${b.slab} m`, async () => {
      const w = await make({ seed: 10, player: !b.ape });
      const f = b.ape ? addApe(w, 0, 0, -Math.PI / 2) : w.player!;
      w.teleport(f, 0, 0, -Math.PI / 2); // facing the attacker at −x; the blow along +x
      for (let t = 0; t < 5; t++) w.step();
      const start = { ...f.pos };
      knock(w, f, { kb: b.kb, lift: b.lift, ko: b.ko });
      w.step();
      let travel = -1;
      // The getup frame: the hand-back (the frame before getup) of a knockdown, frame 69 for a KO (it never gets up).
      for (let t = 0; t < 600 && travel < 0; t++) {
        const before = { ...f.pos };
        w.step();
        if (b.ko) {
          if (f.stateFrame >= 69) travel = hdist(f.pos, start);
        } else if (!w.downed.active(f)) travel = hdist(before, start);
      }
      expect(travel).toBeGreaterThan(0.9 * b.slab);
      expect(travel).toBeLessThan(1.1 * b.slab);
      // Against today's ragdoll: the spread gap-4 reports, plus the few per cent of M1's ground.
      expect(travel / b.ragdoll - 1).toBeGreaterThan(-0.23);
      expect(travel / b.ragdoll - 1).toBeLessThan(0.36 * 1.1 + 0.01);
    });
  }

  it('a KO keeps its slab as the corpse; standing again (a respawn) hands it back where the fighter now is', async () => {
    const w = await make({ seed: 11 });
    const p = w.player!;
    w.step();
    knock(w, p, { kb: 3, lift: 0, ko: true });
    for (let t = 0; t < 300; t++) w.step();
    expect(p.state).toBe('ko');
    expect(w.downed.active(p)).toBe(true);
    expect(p.pos.x).toBe(w.downed.hip(p.id)!.x);
    // A respawn (P09's Deaths): back on its feet and moved.
    p.hp = p.stats.maxHp;
    p.enterLocomotion();
    w.teleport(p, 6, -4, 0);
    w.step();
    expect(w.downed.active(p)).toBe(false);
    expect(w.kcc.isEnabled(p)).toBe(true);
    expect(w.zones.enabled(p)).toBe(true);
    expect(hdist(p.pos, { x: 6, y: 0, z: -4 })).toBeLessThan(1e-6);
    for (let t = 0; t < 10; t++) w.step();
    expect(hdist(p.pos, { x: 6, y: 0, z: -4 })).toBeLessThan(1e-6);
    expect(w.kcc.grounded(p)).toBe(true);
  });

  it('queueDv reaches an active slab in the next phase 4a, and a launching one in its launch velocity', async () => {
    const w = await make({ seed: 12 });
    const p = w.player!;
    w.step();
    knock(w, p, { kb: 1, lift: null });
    w.downed.queueDv(p, { x: 0, y: 2, z: 0 }); // queued before the launch: part of it
    const r = w.step();
    const l = r.world.find((e): e is Extract<WorldEvent, { type: 'launch' }> => e.type === 'launch')!;
    expect(l.vel.y).toBeCloseTo(2, 9);
    for (let t = 0; t < 60; t++) w.step();
    const before = w.downed.velocity(p.id)!.lin;
    w.downed.queueDv(p, { x: 0, y: 3, z: 0 });
    let after: V3 | null = null;
    const syncDown = w.downed.syncDown.bind(w.downed);
    w.downed.syncDown = (ww) => {
      syncDown(ww);
      after = w.downed.velocity(p.id)!.lin;
    };
    w.step();
    expect(after!.y - before.y).toBeCloseTo(3, 4);
    // A Δv for a standing fighter is CombatSim's: dropped.
    const w2 = await make({ seed: 13 });
    const q = w2.player!;
    w2.step();
    w2.downed.queueDv(q, { x: 5, y: 0, z: 0 });
    w2.step();
    knock(w2, q, { kb: 1, lift: null });
    const r2 = w2.step();
    expect(r2.world.find((e) => e.type === 'launch')).toMatchObject({ vel: { y: 0 } });
  });

  it('boneAt picks the bone from the contact point’s height along the slab (boneBands), left or right of its axis', async () => {
    const w = await make({ seed: 14 });
    const p = w.player!;
    w.step();
    knock(w, p, { kb: 1, lift: 0 });
    w.step();
    placeSlab(w, p, { x: 0, y: 0.1, z: 0 }, ALONG_X);
    const half = DOWNED_TUNING.halfLength + DOWNED_TUNING.border;
    // Local +X (the left) is world +z here (local Y → x, Z → y, X → z).
    const at = (h: number, side: number) => w.downed.boneAt(p, { x: h - half, y: 0.1, z: side * 0.1 });
    expect(at(0.2, 1)).toBe('shinL');
    expect(at(0.2, -1)).toBe('shinR');
    expect(at(0.7, 1)).toBe('thighL');
    expect(at(0.7, -1)).toBe('thighR');
    expect(at(1.0, 1)).toBe('pelvis');
    expect(at(1.2, -1)).toBe('abdomen');
    expect(at(1.4, 1)).toBe('chest');
    expect(at(1.7, 1)).toBe('head');
    expect(w.downed.boneAt({ id: 99 } as Fighter, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('records round-trip exactly; two worlds launch, settle and get up bit-identically', async () => {
    const run = async (): Promise<{ w: World; trace: string }> => {
      const w = await make({ seed: 15 });
      w.terrain.generate((x, z) => 0.3 * Math.sin(x * 0.7) * Math.cos(z * 0.5));
      const p = w.player!;
      w.teleport(p, 0, 0, 0.4);
      for (let t = 0; t < 5; t++) w.step();
      knock(w, p, { kb: 3.5, dir: { x: Math.sin(2), y: 0, z: Math.cos(2) }, lift: 0.4 });
      const out: number[] = [];
      for (let t = 0; t < 150; t++) {
        w.step();
        const s = w.downed.pose(p.id);
        if (s) out.push(s.p.x, s.p.y, s.p.z, s.q.x, s.q.y, s.q.z, s.q.w);
        out.push(p.pos.x, p.pos.y, p.pos.z, p.stunFrames);
      }
      return { w, trace: out.join(',') };
    };
    const a = await run();
    const b = await run();
    expect(a.trace).toBe(b.trace);
    // Records: mid-flight.
    const w = await make({ seed: 16 });
    const p = w.player!;
    w.step();
    knock(w, p, { kb: 4, lift: 0.5 });
    for (let t = 0; t < 6; t++) w.step();
    w.downed.queueDv(p, { x: 0.5, y: 0, z: 0 });
    const rec = w.downed.toRecord();
    expect(rec).toHaveLength(1);
    expect(rec[0].slab.enabled).toBe(true);
    expect(len(rec[0].slab.lin)).toBeGreaterThan(1);
    const text = JSON.stringify(rec);
    for (let t = 0; t < 30; t++) w.step();
    expect(JSON.stringify(w.downed.toRecord())).not.toBe(text);
    w.downed.restoreRecord(JSON.parse(text));
    expect(JSON.stringify(w.downed.toRecord())).toBe(text);
    expect(() => w.downed.restoreRecord([{ fighter: 42, slab: rec[0].slab }])).toThrow(/no slab/);
  });
});

describe('definition of done (P08)', () => {
  it('a player and an ape walk, fight with DS melee and get knocked down on bumpy terrain, headless', async () => {
    const w = await make({ seed: 20261017 });
    w.terrain.generate((x, z) => 0.25 * Math.sin(x * 0.9) + 0.2 * Math.cos(z * 1.1) + 0.08 * Math.sin((x - z) * 2.3));
    const p = w.player!;
    w.teleport(p, -4, 0, Math.PI / 2);
    const pai = new BrawlerAI({ ...DEFAULT_AI, aggression: 1.4, blockChance: 0.2 }, new Rng(5), BRAWLER_PLAN, w.combat.director);
    pai.drops = w.combat.drops;
    w.combat.ais.set(p, pai);
    const ape = addApe(w, 4, 0.5, -Math.PI / 2, true);
    p.minHp = 1;
    ape.minHp = 1;
    let launches = 0;
    let getups = 0;
    let hits = 0;
    let closest = Infinity;
    for (let t = 0; t < 3600; t++) {
      const r = w.step();
      for (const e of r.world) if (e.type === 'launch') launches++;
      for (const e of r.combat) {
        if (e.type === 'getup') getups++;
        if (e.type === 'hit') hits++;
      }
      closest = Math.min(closest, hdist(p.pos, ape.pos));
      for (const f of [p, ape]) {
        for (const v of [f.pos.x, f.pos.y, f.pos.z]) expect(Number.isFinite(v)).toBe(true);
        if (w.downed.active(f)) {
          expect(w.kcc.isEnabled(f)).toBe(false);
          expect(w.zones.enabled(f)).toBe(false);
          expect(Math.abs(f.pos.y - w.terrain.heightAt(f.pos.x, f.pos.z))).toBeLessThan(1e-3);
        } else if (!w.kcc.teleportPending(f)) {
          // (Handed back this tick, the capsule is put at the stand spot by the next resolve.)
          const c = w.kcc.capsulePose(f)!;
          expect(f.pos.x).toBe(c.p.x);
          expect(f.pos.y).toBe(c.p.y - w.kcc.footOffsetOf(f));
          // Standing on the bumps, not in them or above them (a jump or a fall aside).
          expect(Math.abs(f.pos.y - w.terrain.heightAt(f.pos.x, f.pos.z))).toBeLessThan(0.15);
        }
      }
      if (launches >= 2 && getups >= 2 && t > 1200) break;
    }
    console.log(`P08 done: ${w.tick} ticks, ${hits} hits, ${launches} launches, ${getups} getups, closest ${closest.toFixed(3)} m`);
    expect(closest).toBeLessThan(1.5);
    expect(hits).toBeGreaterThan(5);
    expect(launches).toBeGreaterThanOrEqual(1);
    expect(getups).toBeGreaterThanOrEqual(1);
  });
});
