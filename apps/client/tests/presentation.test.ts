// The presentation physics world and its ragdolls (docs/M1-DESIGN.md §10.5, rule 6; package P33), headless with Rapier:
// a knocked-down body's ragdoll lies where the sim's slab lies; the sim's launch throws it; the ragdoll collision slots
// belong to their presentation world and are recycled (D-42); the level of detail keeps the nearest maxRagdolls and
// never the giant; the terrain and the entities are mirrored; a respawn rebuilds a cut body whole; nothing the
// presentation world does writes sim state; blood, gibs and particles land on the terrain.
//
// Scene numbers (blows, distances, positions, slopes) are test constants, never tuning (§9).
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Scene, Vector3 } from 'three';
import {
  BONES,
  type CombatEvent,
  createEnemy,
  createWorld,
  type Fighter,
  HUMANOID_MASS,
  physicsReady,
  resetTuning,
  Rng,
  type RulerState,
  spawnLog,
  spawnStone,
  type StepResult,
  TUNING,
  type V3,
  type World,
  type WorldEvent,
  type WorldOptions,
} from '@wild/sim';
import { GROUP_ENV, GROUP_MIRROR, groups, RAGDOLL_TUNING, RagdollSlots, SLOT_COUNT } from '../src/body/ragdoll';
import { type BodyFall, Fx, PRESENTATION_TUNING, PresentationWorld } from '../src/game/presentationWorld';
import type { SimEvent, WorldViewsPort } from '../src/game/ports';
import { Blood } from '../src/render/blood';
import { Gibs } from '../src/render/gibs';
import { Effects, type Ground } from '../src/render/particles';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const live: { w: World; pw: PresentationWorld[] }[] = [];

async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', size: 50, ...o });
  live.push({ w, pw: [] });
  return w;
}

function present(w: World, cam?: () => V3 | null): PresentationWorld {
  const pw = new PresentationWorld(RAPIER, w, cam);
  live.find((l) => l.w === w)!.pw.push(pw);
  return pw;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const { w, pw } of live.splice(0)) {
    for (const p of pw) p.dispose();
    w.dispose();
  }
  resetTuning('PRESENTATION_TUNING');
  resetTuning('RAGDOLL_TUNING');
});

/** One fixed step as the game loop and Game.present run it: the world steps, the events reach the bodies, they step. */
function tick(w: World, pw: PresentationWorld | null): StepResult {
  const r = w.step();
  if (!pw) return r;
  for (const e of [...r.combat, ...r.world] as SimEvent[]) {
    if (e.type === 'launch') pw.onLaunch(e.f, e.vel, e.angVel);
    pw.handle(e, w);
  }
  pw.step(w);
  return r;
}

function ticks(w: World, pw: PresentationWorld | null, n: number): void {
  for (let t = 0; t < n; t++) tick(w, pw);
}

/**
 * A blow in the next tick's phase 3, as CombatSim's hit() leaves it (as the sim's own downed tests do): the knockback
 * in f.vel, knockdown (or KO), and a `hit` event carrying the move's lift.
 */
function knock(w: World, f: Fighter, o: { kb: number; dir?: V3; lift?: number; ko?: boolean }): void {
  const sim = w.combat;
  const orig = sim.stepBody;
  sim.stepBody = function (): CombatEvent[] {
    sim.stepBody = orig;
    const ev = orig.call(sim);
    const d = o.dir ?? { x: 1, y: 0, z: 0 };
    f.vel.set(d.x * o.kb, 0, d.z * o.kb);
    if (o.ko) f.enterKO();
    else f.enterKnockdown();
    ev.push(hitEvent(f, { dir: d, lift: o.lift ?? 0, knockdown: !o.ko, ko: !!o.ko }));
    return ev;
  };
}

/** A melee `hit` event on `f` (only the fields the presentation reads). */
function hitEvent(f: Fighter, o: { dir?: V3; lift?: number; impulse?: number; knockdown?: boolean; ko?: boolean; sever?: string }): CombatEvent {
  const d = o.dir ?? { x: 1, y: 0, z: 0 };
  return {
    type: 'hit',
    attacker: f,
    defender: f,
    move: { lift: o.lift ?? 0, weight: 'heavy', impulse: o.impulse ?? 30, knockback: 2 },
    zone: 'chest',
    point: f.rig.chest.pos.clone(),
    dir: new Vector3(d.x, d.y, d.z),
    knockdown: !!o.knockdown,
    ko: !!o.ko,
    armored: false,
    push: 1,
    sever: o.sever ?? null,
  } as unknown as CombatEvent;
}

function addApe(w: World, x: number, z: number): Fighter {
  const ids = w.ids.fighter;
  const { fighter: f } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  w.addFighter(f, null);
  w.teleport(f, x, z, 0);
  return f;
}

const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const DEG = Math.PI / 180;
/** A ray that sees the terrain and the mirrors, never a ragdoll. */
const ENV_ONLY = groups(0xffff, GROUP_ENV | GROUP_MIRROR);

/** Everything the sim decides about its fighters, entities and slabs (rule 6: the presentation must change none of it). */
function simState(w: World): string {
  const fighters = w.combat.fighters.map((f) => ({
    rec: f.toRecord(w.combat.drops),
    rig: BONES.map((b) => [f.rig[b].pos.toArray(), f.rig[b].rot.toArray()]),
    alive: f.alive,
  }));
  return JSON.stringify({ tick: w.tick, combat: w.combat.toRecord(), fighters, entities: w.entities.toRecord(), downed: w.downed.toRecord() });
}

// ---------------------------------------------------------------------------

describe('downed bodies follow the sim (§10.5)', () => {
  it("a knocked-down player's ragdoll pelvis is within 0.35 m of the slab's hip after 1 s", async () => {
    const w = await make({ seed: 2 });
    const p = w.player!;
    const pw = present(w);
    ticks(w, pw, 10);
    expect(pw.ragdollOf(p)).not.toBeNull();
    knock(w, p, { kb: 3, lift: 0.75 });
    const r = tick(w, pw);
    expect(r.world.some((e: WorldEvent) => e.type === 'launch' && e.f === p)).toBe(true);
    let worst = 0;
    for (let t = 0; t < 60; t++) {
      tick(w, pw);
      worst = Math.max(worst, dist(pw.ragdollOf(p)!.pelvisPos(), w.downed.hip(p.id)!));
    }
    expect(p.state).toBe('knockdown');
    expect(dist(pw.ragdollOf(p)!.pelvisPos(), w.downed.hip(p.id)!)).toBeLessThan(0.35);
    // And all along the fall, not only at the end.
    expect(worst).toBeLessThan(0.35);
  });

  it('follows the slab when the world shoves it while down, on a 20° slope; DS’s free root (downRootGain 0) drifts off', async () => {
    const run = async (gain: number): Promise<{ end: number; worst: number }> => {
      RAGDOLL_TUNING.downRootGain = gain;
      const w = await make({ seed: 4 });
      w.terrain.generate((x) => Math.tan(20 * DEG) * x);
      const p = w.player!;
      w.teleport(p, 0, 0, 0);
      const pw = present(w);
      ticks(w, pw, 10);
      knock(w, p, { kb: 2.5, dir: { x: 0, y: 0, z: 1 }, lift: 0.5 });
      tick(w, pw);
      let worst = 0;
      for (let t = 0; t < 60; t++) {
        // A log's blow while down: the sim's Δv on the slab (§4.5), which the presentation never sees as a throw.
        if (t === 20) w.downed.queueDv(p, { x: -3, y: 1, z: 3 });
        tick(w, pw);
        worst = Math.max(worst, dist(pw.ragdollOf(p)!.pelvisPos(), w.downed.hip(p.id)!));
      }
      expect(p.state).toBe('knockdown');
      return { end: dist(pw.ragdollOf(p)!.pelvisPos(), w.downed.hip(p.id)!), worst };
    };
    const follow = await run(0.15);
    expect(follow.end).toBeLessThan(0.35);
    expect(follow.worst).toBeLessThan(0.5);
    const free = await run(0);
    expect(free.end).toBeGreaterThan(0.6);
  });

  it('a KO’d ape lies on its corpse slab', async () => {
    const w = await make({ seed: 5 });
    const pw = present(w);
    const ape = addApe(w, 3, 2);
    ticks(w, pw, 5);
    knock(w, ape, { kb: 2, dir: { x: 0, y: 0, z: -1 }, ko: true });
    ticks(w, pw, 120);
    expect(ape.state).toBe('ko');
    expect(dist(pw.ragdollOf(ape)!.pelvisPos(), w.downed.hip(ape.id)!)).toBeLessThan(0.35);
    // The world shoves the corpse (a log's Δv on the slab, §4.5): the limp body goes with it (a free root stays put).
    const before = { ...w.downed.hip(ape.id)! };
    w.downed.queueDv(ape, { x: 3, y: 1, z: 2 });
    ticks(w, pw, 90);
    expect(ape.state).toBe('ko');
    expect(dist(w.downed.hip(ape.id)!, before)).toBeGreaterThan(0.6);
    expect(dist(pw.ragdollOf(ape)!.pelvisPos(), w.downed.hip(ape.id)!)).toBeLessThan(0.35);
  });

  it('the launch is the sim’s: the body’s bulk motion becomes the slab’s velocity and spin (no presentation throw)', async () => {
    const w = await make({ seed: 6 });
    const p = w.player!;
    const pw = present(w);
    ticks(w, pw, 10);
    knock(w, p, { kb: 3, lift: 0.75 });
    const r = w.step();
    // The hit first (its blow), as Game.present hands them on: combat events, then world events.
    for (const e of r.combat) pw.handle(e, w);
    const launch = r.world.find((e): e is Extract<WorldEvent, { type: 'launch' }> => e.type === 'launch')!;
    expect(launch.f).toBe(p);
    const rd = pw.ragdollOf(p)!;
    const spun = BONES.map((b) => rd.bodies[b].angvel());
    pw.onLaunch(launch.f, launch.vel, launch.angVel);
    const centre = w.downed.pose(p.id)!.p;
    const com = rd.centreOfMass();
    let m = 0;
    const mean = new Vector3();
    for (const b of BONES) {
      const body = rd.bodies[b];
      const v = body.linvel();
      mean.addScaledVector(new Vector3(v.x, v.y, v.z), body.mass());
      m += body.mass();
    }
    mean.divideScalar(m);
    const w0 = launch.angVel;
    const r0 = { x: com.x - centre.x, y: com.y - centre.y, z: com.z - centre.z };
    // v̄ = vel + ω × (COM − centre): the slab's velocity at the body's centre of mass.
    expect(mean.x).toBeCloseTo(launch.vel.x + (w0.y * r0.z - w0.z * r0.y), 3);
    expect(mean.y).toBeCloseTo(launch.vel.y + (w0.z * r0.x - w0.x * r0.z), 3);
    expect(mean.z).toBeCloseTo(launch.vel.z + (w0.x * r0.y - w0.y * r0.x), 3);
    // Every bone turns with the slab, on top of what the blow set it doing.
    BONES.forEach((b, i) => {
      const a = rd.bodies[b].angvel();
      expect(a.x - spun[i].x, b).toBeCloseTo(w0.x, 4);
      expect(a.y - spun[i].y, b).toBeCloseTo(w0.y, 4);
      expect(a.z - spun[i].z, b).toBeCloseTo(w0.z, 4);
    });
    // About the body's own centre of mass (no slab given), a launch leaves the body moving at exactly `vel`.
    rd.launch({ x: 1, y: 0.5, z: -2 }, { x: 0, y: 3, z: 1 });
    const again = new Vector3();
    for (const b of BONES) {
      const v = rd.bodies[b].linvel();
      again.addScaledVector(new Vector3(v.x, v.y, v.z), rd.bodies[b].mass() / m);
    }
    expect(again.x).toBeCloseTo(1, 4);
    expect(again.y).toBeCloseTo(0.5, 4);
    expect(again.z).toBeCloseTo(-2, 4);
    // A second hit event of a knockdown (no launch) throws nothing: the presentation has no throw of its own.
    for (const e of r.world) if (e.type !== 'launch') pw.handle(e, w);
    const before = BONES.map((b) => rd.bodies[b].linvel());
    pw.handle(hitEvent(p, { knockdown: true, lift: 1, impulse: 0 }), w);
    // DS threw every bone 1.2 + 3 × lift m/s up (and along the blow) here; now nothing moves but the blow's own impulse
    // (none in this one).
    BONES.forEach((b, i) => expect(rd.bodies[b].linvel(), b).toEqual(before[i]));
  });
});

describe('collision slots belong to the presentation world (D-42)', () => {
  it('RagdollSlots: the lowest free bit, 14 of them, recycled on release', () => {
    const s = new RagdollSlots();
    const got: number[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) got.push(s.claim());
    expect(got[0]).toBe(0x4);
    expect(new Set(got).size).toBe(SLOT_COUNT);
    expect(got.every((b) => b >= 0x4 && b < 0x10000 && (b & (b - 1)) === 0)).toBe(true);
    expect(s.claim()).toBe(0);
    expect(s.count).toBe(SLOT_COUNT);
    s.release(got[3]);
    s.release(got[7]);
    expect(s.count).toBe(SLOT_COUNT - 2);
    expect(s.claim()).toBe(got[3]);
    expect(s.claim()).toBe(got[7]);
  });

  it('ragdolls take distinct slots of their own world; disposing one frees its slot for the next; two worlds never share', async () => {
    const w = await make({ seed: 7 });
    const p = w.player!;
    const apes = [addApe(w, 2, 0), addApe(w, -2, 0), addApe(w, 0, 2)];
    const pw = present(w);
    ticks(w, pw, 2);
    expect(pw.ragdollCount).toBe(4);
    const slots = [p, ...apes].map((f) => pw.ragdollOf(f)!.slot);
    expect(new Set(slots).size).toBe(4);
    expect(pw.slots.mask).toBe(slots.reduce((a, b) => a | b, 0));
    // A second presentation world (a rebuild, a second view) starts from its own first slot.
    const other = present(w);
    other.step(w);
    expect(other.ragdollOf(p)!.slot).toBe(0x4);
    expect(other.slots.count).toBe(4);
    // The ape whose ragdoll goes (it leaves the world) gives its slot back; the next ragdoll takes it.
    const gone = pw.ragdollOf(apes[1])!.slot;
    w.removeFighter(apes[1]);
    tick(w, pw);
    expect(pw.ragdollCount).toBe(3);
    expect(pw.slots.mask & gone).toBe(0);
    const fresh = addApe(w, 0, -2);
    tick(w, pw);
    expect(pw.ragdollOf(fresh)!.slot).toBe(gone);
    // Level of detail cutting the count recycles too.
    PRESENTATION_TUNING.maxRagdolls = 1;
    tick(w, pw);
    expect(pw.ragdollCount).toBe(1);
    expect(pw.slots.count).toBe(1);
    pw.dispose();
    expect(pw.slots.count).toBe(0);
  });
});

describe('level of detail (SPEC:655-656)', () => {
  it('the maxRagdolls fighters nearest the camera have ragdolls; the others are drawn from the rig', async () => {
    const w = await make({ seed: 8, size: 100 });
    const p = w.player!;
    const apes: Fighter[] = [];
    for (let i = 0; i < 10; i++) apes.push(addApe(w, 4 + 3 * i, 0));
    const cam = { x: 0, y: 2, z: 0 };
    const pw = present(w, () => cam);
    ticks(w, pw, 2);
    expect(PRESENTATION_TUNING.maxRagdolls).toBe(8);
    expect(pw.ragdollCount).toBe(8);
    const have = (f: Fighter) => pw.ragdollOf(f) !== null;
    expect(have(p)).toBe(true);
    expect(apes.map(have)).toEqual([true, true, true, true, true, true, true, false, false, false]);
    expect(pw.bodyPose(apes[9])).toBeNull();
    // The camera crosses to the far end: the nearest eight there.
    cam.x = 40;
    tick(w, pw);
    expect(pw.ragdollCount).toBe(8);
    expect(have(p)).toBe(false);
    expect(apes.map(have)).toEqual([false, false, true, true, true, true, true, true, true, true]);
    // Hysteresis: ape 1 (x 7, no ragdoll) comes 0.8 m nearer than ape 9 (x 31, which has one): within
    // lodHysteresisM (2 m), nothing swaps…
    cam.x = 18.6;
    tick(w, pw);
    expect(apes.map(have)).toEqual([false, false, true, true, true, true, true, true, true, true]);
    // …3.9 m nearer, it takes ape 9's.
    cam.x = 17;
    tick(w, pw);
    expect(apes.map(have)).toEqual([false, true, true, true, true, true, true, true, true, false]);
    expect(pw.ragdollCount).toBe(8);
  });

  it('never gives the giant a ragdoll, nor a place in the level of detail (its rig is the sim’s body, §10.5)', async () => {
    const w = await make({ seed: 9 });
    const p = w.player!;
    // A stand-in ruler in the world's fighters (spawnCreature('giantApe') arrives with P11/P19; until then rulerTick
    // throws, so only the presentation world steps with it here).
    // TODO(P11/P19): a real giant from spawnCreature('giantApe'), stepped with the world.
    const { fighter: giant } = createEnemy('bruiser', new Rng(1), {}, {}, { ids: w.ids.fighter, rngSeed: 1 });
    giant.scale = 5.5;
    giant.ruler = {} as RulerState;
    giant.pos.set(p.pos.x + 6, p.pos.y, p.pos.z);
    w.addFighter(giant, null);
    // The camera at the giant, one ragdoll: the giant is the nearest fighter, and still the player gets it.
    const cam = { x: giant.pos.x, y: giant.pos.y + 2, z: giant.pos.z };
    const pw = present(w, () => cam);
    PRESENTATION_TUNING.maxRagdolls = 1;
    for (let i = 0; i < 3; i++) pw.step(w);
    expect(pw.ragdollOf(giant)).toBeNull();
    expect(pw.ragdollOf(p)).not.toBeNull();
    expect(pw.attachRagdoll(giant)).toBeNull();
    expect(pw.bodyPose(giant)).toBeNull();
    // Tripped or killed, it is still drawn from its rig (no ragdoll, no slab pose).
    giant.enterKO();
    PRESENTATION_TUNING.maxRagdolls = 8;
    for (let i = 0; i < 3; i++) pw.step(w);
    expect(pw.ragdollOf(giant)).toBeNull();
    expect(pw.bodyPose(giant)).toBeNull();
    w.removeFighter(giant);
  });

  it('a downed fighter beyond the level of detail is drawn as its rig laid on the slab', async () => {
    const w = await make({ seed: 10 });
    const p = w.player!;
    const pw = present(w);
    PRESENTATION_TUNING.maxRagdolls = 0;
    ticks(w, pw, 3);
    expect(pw.bodyPose(p)).toBeNull();
    knock(w, p, { kb: 2, lift: 0.5 });
    ticks(w, pw, 40);
    const pose = pw.bodyPose(p)!;
    expect(pose).not.toBeNull();
    expect(dist(pose.cur.pelvis.p, w.downed.hip(p.id)!)).toBeLessThan(1e-6);
    // Lying: the head is about as high as the hip, not a metre and a half above it.
    expect(Math.abs(pose.cur.head.p.y - pose.cur.pelvis.p.y)).toBeLessThan(0.4);
    // The kill cam follows the slab's hip (floored over the ground).
    const at = pw.pelvisOf(p)();
    expect(Math.hypot(at.x - w.downed.hip(p.id)!.x, at.z - w.downed.hip(p.id)!.z)).toBeLessThan(1e-6);
    // Back up: drawn from the rig again.
    ticks(w, pw, 400);
    expect(p.state).not.toBe('knockdown');
    expect(pw.bodyPose(p)).toBeNull();
  });

  it('a ragdoll built for a body already down starts lying on its slab, moving with it', async () => {
    const w = await make({ seed: 11 });
    const p = w.player!;
    const pw = present(w);
    PRESENTATION_TUNING.maxRagdolls = 0;
    ticks(w, pw, 3);
    knock(w, p, { kb: 3, lift: 0.75 });
    ticks(w, pw, 8);
    PRESENTATION_TUNING.maxRagdolls = 8;
    tick(w, pw);
    const rd = pw.ragdollOf(p)!;
    expect(rd).not.toBeNull();
    expect(dist(rd.pelvisPos(), w.downed.hip(p.id)!)).toBeLessThan(0.2);
    ticks(w, pw, 40);
    expect(dist(rd.pelvisPos(), w.downed.hip(p.id)!)).toBeLessThan(0.35);
  });
});

describe('mirrors: terrain and entities in the presentation world', () => {
  it('a mirrored entity never touches the ragdoll of a fighter the sim has standing; a downed one lies on it (C-fix)', async () => {
    const w = await make({ seed: 13 });
    const p = w.player!;
    const cam = { x: p.pos.x, y: 2, z: p.pos.z };
    const stone = spawnStone(w, { p: { x: p.pos.x + 1.5, y: 1.5, z: p.pos.z }, mass: 20 });
    const pw = present(w, () => cam);
    ticks(w, pw, 3);
    const rd = pw.ragdollOf(p)!;
    expect(pw.mirrorOf(stone)).toBe('kinematic');
    const meet = (a: number, b: number) => ((a >>> 16) & b & 0xffff) !== 0 && ((b >>> 16) & a & 0xffff) !== 0;
    const mirrorGroups = (() => {
      let g = -1;
      pw.rapier.forEachCollider((c) => {
        if (c.parent()?.isKinematic()) g = c.collisionGroups();
      });
      return g;
    })();
    expect(mirrorGroups).not.toBe(-1);
    const terrain = groups(GROUP_ENV, 0xffff);
    const pelvis = rd.bodies.pelvis.collider(0).collisionGroups();
    expect(p.state).not.toBe('knockdown');
    expect(meet(pelvis, mirrorGroups)).toBe(false);
    expect(meet(pelvis, terrain)).toBe(true);
    knock(w, p, { kb: 3, lift: 0.75 });
    ticks(w, pw, 2);
    expect(p.state).toBe('knockdown');
    expect(meet(rd.bodies.pelvis.collider(0).collisionGroups(), mirrorGroups)).toBe(true);
  });


  it('the terrain tiles match heightAt, and follow an edit', async () => {
    const w = await make({ seed: 12 });
    const h1 = (x: number, z: number) => 0.4 * Math.sin(x * 0.3) + 0.3 * Math.cos(z * 0.25);
    w.terrain.generate(h1);
    const pw = present(w);
    pw.step(w);
    const down = (x: number, z: number) => {
      const hit = pw.rapier.castRay(new RAPIER.Ray({ x, y: 20, z }, { x: 0, y: -1, z: 0 }), 40, true, undefined, ENV_ONLY);
      return 20 - hit!.timeOfImpact;
    };
    for (const [x, z] of [
      [0, 0],
      [3.3, -7.1],
      [-12.4, 9.9],
      [17.2, 4.4],
    ]) {
      expect(Math.abs(down(x, z) - w.terrain.heightAt(x, z))).toBeLessThan(2e-3);
    }
    w.terrain.generate((x, z) => h1(x, z) + 1);
    pw.step(w);
    expect(Math.abs(down(3.3, -7.1) - w.terrain.heightAt(3.3, -7.1))).toBeLessThan(2e-3);
  });

  it('fixed entities as fixed colliders; free ones near the camera as kinematic colliders that follow them; removed ones go', async () => {
    const w = await make({ seed: 13 });
    const cam = { x: 0, y: 2, z: 0 };
    PRESENTATION_TUNING.mirrorRadiusM = 10;
    const fixed = spawnLog(w, { p: { x: 2, y: 0.3, z: 2 }, length: 3, r: 0.2, state: 'fixed' });
    const near = spawnStone(w, { p: { x: -2, y: 1.5, z: 1 }, mass: 20 });
    const far = spawnStone(w, { p: { x: 18, y: 1.5, z: 0 }, mass: 20 });
    const pw = present(w, () => cam);
    tick(w, pw);
    expect(pw.mirrorOf(fixed)).toBe('fixed');
    expect(pw.mirrorOf(near)).toBe('kinematic');
    expect(pw.mirrorOf(far)).toBeNull();
    // The near stone falls in the sim; its mirror follows (a kinematic body reaches its next pose in the step after).
    ticks(w, pw, 40);
    tick(w, pw);
    const e = w.entities.get(near)!;
    expect(e.pose.p.y).toBeLessThan(0.5); // it has fallen from 1.5 m
    const hit = pw.rapier.castRay(new RAPIER.Ray({ x: e.pose.p.x, y: e.pose.p.y + 5, z: e.pose.p.z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, ENV_ONLY);
    expect(hit).not.toBeNull();
    // The first thing the ray meets is the stone's mirror where the stone now lies (a 20 kg stone is ~0.2 m across).
    expect(Math.abs(e.pose.p.y + 5 - hit!.timeOfImpact - e.pose.p.y)).toBeLessThan(0.3);
    // The camera goes to the far stone.
    cam.x = 18;
    tick(w, pw);
    expect(pw.mirrorOf(near)).toBeNull();
    expect(pw.mirrorOf(far)).toBe('kinematic');
    expect(pw.mirrorOf(fixed)).toBe('fixed');
    w.removeEntity(fixed);
    tick(w, pw);
    expect(pw.mirrorOf(fixed)).toBeNull();
  });

  it('a body falls onto a fixed log, not through it', async () => {
    const w = await make({ seed: 14 });
    const p = w.player!;
    w.teleport(p, 0, 0, -Math.PI / 2);
    spawnLog(w, { p: { x: 1.1, y: 0.35, z: 0 }, q: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }, length: 4, r: 0.35, state: 'fixed' });
    const pw = present(w);
    ticks(w, pw, 5);
    knock(w, p, { kb: 2.5, lift: 0.2 });
    ticks(w, pw, 50);
    // The body lies over the log (its top is 0.7 m up, along z at x 1.1 ± 0.35): the pelvis rests on it…
    const rd = pw.ragdollOf(p)!;
    const pel = rd.pelvisPos();
    expect(Math.abs(pel.x - 1.1)).toBeLessThan(0.35);
    expect(pel.y).toBeGreaterThan(0.6);
    // …and no bone sinks into it.
    for (const b of BONES) {
      const t = rd.bodies[b].translation();
      const inside = Math.abs(t.x - 1.1) < 0.2 && Math.abs(t.z) < 1.8 && t.y < 0.5;
      expect(inside, b).toBe(false);
    }
  });
});

describe('respawn (§10.8)', () => {
  it('rebuilds a body with a limb cut loose whole, in a recycled slot, where the sim has the fighter now', async () => {
    const w = await make({ seed: 15 });
    const p = w.player!;
    const pw = present(w);
    ticks(w, pw, 5);
    const first = pw.ragdollOf(p)!;
    const slot = first.slot;
    pw.handle(hitEvent(p, { sever: 'upperArmL' }), w);
    expect(first.loose.has('foreArmL')).toBe(true);
    // The sim's respawn: teleported to the spawn in phase 15, after phase 3 posed the rig (still last tick's).
    w.teleport(p, 8, -6, 1);
    const stale = p.rig.pelvis.pos.clone();
    pw.handle({ type: 'respawn', f: p, at: { x: 8, y: 0, z: -6 } } as WorldEvent, w);
    pw.snapTo(p); // Game's beat snaps the player's body too: twice is harmless
    const rd = pw.ragdollOf(p)!;
    expect(rd).not.toBe(first);
    expect(rd.loose.size).toBe(0);
    expect(rd.slot).toBe(slot);
    expect(pw.slots.count).toBe(1);
    expect(Math.hypot(rd.pelvisPos().x - 8, rd.pelvisPos().z + 6)).toBeLessThan(0.3);
    expect(dist(rd.pelvisPos(), stale)).toBeGreaterThan(5);
    tick(w, pw);
    expect(Math.hypot(rd.pelvisPos().x - 8, rd.pelvisPos().z + 6)).toBeLessThan(0.3);
  });

  it('a body respawned from its corpse is drawn at the spawn, not on the corpse slab the sim still holds that tick', async () => {
    // As the game loop runs it: the world steps (Deaths revives and teleports the player in phase 15, after phase 3
    // posed the rig at the corpse; the slab stays active until the next tick's phase 4a), the events reach the bodies,
    // then the presentation world steps.
    const run = async (ragdolls: boolean) => {
      const w = await make({ seed: 20 });
      const p = w.player!;
      const pw = present(w);
      PRESENTATION_TUNING.maxRagdolls = ragdolls ? 8 : 0;
      ticks(w, pw, 5);
      knock(w, p, { kb: 2, ko: true });
      ticks(w, pw, 90);
      expect(p.state).toBe('ko');
      const corpse = w.downed.hip(p.id)!;
      if (ragdolls) expect(dist(pw.ragdollOf(p)!.pelvisPos(), corpse)).toBeLessThan(0.35);
      else expect(dist(pw.bodyPose(p)!.cur.pelvis.p, corpse)).toBeLessThan(1e-6);
      // Phase 15's respawn (P09's Deaths): patched up and teleported to the spawn.
      p.hp = p.stats.maxHp;
      p.enterLocomotion();
      w.teleport(p, 8, -6, 1);
      expect(w.downed.active(p)).toBe(true);
      expect(dist(p.rig.pelvis.pos, corpse)).toBeLessThan(1.5); // the rig is still the corpse's
      pw.handle({ type: 'respawn', f: p, at: { x: 8, y: 0, z: -6 } } as WorldEvent, w);
      pw.snapTo(p); // Game's beat
      return { w, p, pw, corpse };
    };
    const off = (at: V3) => Math.hypot(at.x - 8, at.z + 6);

    const a = await run(true);
    const rd = a.pw.ragdollOf(a.p)!;
    expect(off(rd.pelvisPos())).toBeLessThan(0.3);
    a.pw.step(a.w); // the respawn tick's presentation step: the slab still active, the rig still the corpse's
    expect(a.w.downed.active(a.p)).toBe(true);
    expect(off(rd.pelvisPos())).toBeLessThan(0.3);
    let worst = 0;
    for (let t = 0; t < 30; t++) {
      tick(a.w, a.pw);
      worst = Math.max(worst, off(rd.pelvisPos()));
    }
    expect(a.w.downed.active(a.p)).toBe(false);
    expect(worst).toBeLessThan(0.3);

    // Beyond the level of detail: drawn from the rig at the spawn, never laid on the corpse.
    const b = await run(false);
    b.pw.step(b.w);
    expect(b.w.downed.active(b.p)).toBe(true);
    expect(b.pw.bodyPose(b.p)).toBeNull();
    tick(b.w, b.pw);
    expect(b.pw.bodyPose(b.p)).toBeNull();
    expect(off(b.pw.pelvisOf(b.p)())).toBeLessThan(0.3);
  });
});

describe('rule 6: the presentation never changes the sim', () => {
  it('stepping the presentation, handing it events, snapping and following bodies leave the sim state untouched', async () => {
    const w = await make({ seed: 16 });
    const p = w.player!;
    const ape = addApe(w, 2, 1);
    spawnStone(w, { p: { x: -1, y: 1, z: 1 }, mass: 15 });
    const pw = present(w);
    ticks(w, pw, 5);
    knock(w, p, { kb: 3, lift: 0.75 });
    const r = w.step();
    const before = simState(w);
    for (const e of [...r.combat, ...r.world] as SimEvent[]) {
      if (e.type === 'launch') pw.onLaunch(e.f, e.vel, e.angVel);
      pw.handle(e, w);
    }
    for (let i = 0; i < 30; i++) pw.step(w);
    pw.handle(hitEvent(ape, { sever: 'upperArmR' }), w);
    pw.handle({ type: 'respawn', f: ape, at: { x: 2, y: 0, z: 1 } } as WorldEvent, w);
    pw.snapTo(p);
    pw.pelvisOf(p)();
    pw.bodyPose(p);
    pw.freeze();
    pw.step(w);
    expect(simState(w)).toBe(before);
  });

  it('a world stepped with a presentation world attached plays out exactly as one without', async () => {
    const play = async (withBodies: boolean): Promise<string> => {
      const w = await make({ seed: 17 });
      const p = w.player!;
      const ape = addApe(w, 1.5, 0.5);
      spawnStone(w, { p: { x: 0.5, y: 2, z: 0.6 }, mass: 25 });
      const pw = withBodies ? present(w) : null;
      ticks(w, pw, 5);
      knock(w, p, { kb: 3, lift: 0.75 });
      ticks(w, pw, 30);
      knock(w, ape, { kb: 2, dir: { x: -1, y: 0, z: 0 }, ko: true });
      ticks(w, pw, 90);
      return simState(w);
    };
    expect(await play(true)).toBe(await play(false));
  });

  it('the presentation sources reach nothing of the sim but read-outs', () => {
    const SOURCES = import.meta.glob<string>(['../src/game/presentationWorld.ts', '../src/body/ragdoll.ts', '../src/render/{blood,gibs,particles}.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(SOURCES)).toHaveLength(5);
    for (const [file, text] of Object.entries(SOURCES)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // Never the sim's own Rapier world or an entity's body or collider.
      expect(code, file).not.toMatch(/\.physics\b|\be\.(body|collider)\b|\.entities\.(?!all\(|get\()\w+\(/);
      // The slabs are read, never driven.
      expect(code, file).not.toMatch(/\.downed\.(?!pose\(|hip\(|velocity\(|active\()\w+/);
      // No fighter write (inputRouting.test.ts guards every client file; here the presentation's own names too).
      expect(code, file).not.toMatch(/\b(f|s|e\.f|e\.defender|fighter)\.(pos|vel|walkVel|rig|pose)\.(set|copy|add|sub)\(|\b(f|s|fighter)\.(state|hp|yaw|stunFrames|stateFrame)\s*=[^=]/);
    }
  });
});

describe('bodies hitting the ground (DS bodyLanding)', () => {
  it('a knocked-down body landing is reported once, hard in 0..1, its mass in human bodies', async () => {
    const w = await make({ seed: 18 });
    const p = w.player!;
    const pw = present(w);
    const falls: BodyFall[] = [];
    pw.bodyFalls.add((f) => falls.push(f));
    ticks(w, pw, 5);
    knock(w, p, { kb: 3, lift: 0.5 });
    ticks(w, pw, 100);
    expect(falls.length).toBeGreaterThanOrEqual(1);
    expect(falls.length).toBeLessThanOrEqual(3);
    expect(falls[0].f).toBe(p);
    expect(falls[0].hard).toBeGreaterThan(0);
    expect(falls[0].hard).toBeLessThanOrEqual(1);
    expect(falls[0].mass).toBeCloseTo(p.mass / HUMANOID_MASS, 9);
    expect(falls[0].at.y - w.terrain.heightAt(falls[0].at.x, falls[0].at.z)).toBeLessThan(0.45 * p.scale + 1e-9);
  });
});

describe('blood, gibs and particles land on the terrain', () => {
  const k = Math.tan(25 * DEG);
  const slope: Ground = {
    height: (x) => k * x,
    normal: (_x, _z, out) => out.set(-k, 1, 0).normalize(),
  };

  it('blood stains lie on the slope, on its normal, where the drops met the ground', () => {
    const blood = new Blood(new Scene(), slope);
    for (let i = 0; i < 5; i++) blood.spray(new Vector3(0.5 * i, 2 + k * 0.5 * i, 0), new Vector3(1, 0.3, 0.2), 1, 3);
    for (let t = 0; t < 400 && blood.dropCount > 0; t++) blood.update(1 / 60);
    expect(blood.dropCount).toBe(0);
    expect(blood.stains).toBeGreaterThan(10);
    const n = slope.normal(0, 0, new Vector3());
    for (let i = 0; i < blood.stains; i++) {
      const { centre, up } = blood.stainAt(i);
      const off = centre.y - slope.height(centre.x, centre.z);
      expect(off).toBeGreaterThan(0);
      expect(off).toBeLessThan(0.02);
      expect(up.dot(n)).toBeGreaterThan(0.9999);
    }
  });

  it('dust bounces off the ground, never below it; rings lie on it', () => {
    const fx = new Effects(new Scene(), slope);
    fx.dust(new Vector3(2, slope.height(2, 0), 0), 30, 0.5);
    fx.sparks(new Vector3(-1, slope.height(-1, 0) + 0.5, 0), new Vector3(0, -1, 0), 20, '#fff', 6);
    expect(fx.particleCount).toBe(50);
    const ps = (fx as unknown as { ps: { pos: Vector3 }[] }).ps;
    for (let t = 0; t < 30; t++) {
      fx.update(1 / 60, 1 / 60);
      for (const q of ps) expect(q.pos.y).toBeGreaterThanOrEqual(slope.height(q.pos.x, q.pos.z) + 0.01 - 1e-9);
    }
  });

  it('gibs come to rest on the slope', () => {
    const gibs = new Gibs(new Scene(), slope);
    gibs.spawn(new Vector3(1, 3, 0), new Vector3(0.5, 2, 0), 0.06, '#d9a07a', 'scalp');
    for (let t = 0; t < 600; t++) gibs.update(1 / 60);
    const [g] = gibs.pieces();
    expect(g.rest).toBe(true);
    expect(g.at.y).toBeCloseTo(slope.height(g.at.x, g.at.z) + 0.25 * g.size, 6);
  });

  it('Fx throws dust where a body or a log lands, more for a hard landing and a heavier thing, on the world’s terrain', async () => {
    const w = await make({ seed: 19 });
    w.terrain.generate((x) => 0.2 * x);
    const p = w.player!;
    const views = { fighterView: () => null } as unknown as WorldViewsPort;
    const pw = present(w);
    const fx = new Fx(new Scene(), views, pw, () => false, () => p);
    const count = (e: WorldEvent): number => {
      fx.update(0, 0, w);
      const before = fx.effects.particleCount;
      fx.handle(e, w);
      return fx.effects.particleCount - before;
    };
    const land = (o: Partial<Extract<WorldEvent, { type: 'land' }>>) => ({ type: 'land', entity: null, f: null, point: { x: 3, y: 0.6, z: 1 }, energy: 0, mass: 0, ...o }) as WorldEvent;
    expect(count(land({ f: p, mass: p.mass }))).toBe(6); // DS jump landing
    expect(count(land({ f: p, mass: p.mass, energy: 50 }))).toBeGreaterThan(6 + 10);
    const light = count(land({ entity: 1, mass: 20, energy: 0.5 * 20 * 16 }));
    const heavy = count(land({ entity: 2, mass: 300, energy: 0.5 * 300 * 16 }));
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).toBe(Math.round(6 + 10 * Math.min(1, 4 / 5) * Math.min(3, 300 / HUMANOID_MASS)));
    // Particles land on the world's terrain (0.2 m per m here), not on y = 0.
    fx.update(1, 1, w);
    const ps = (fx.effects as unknown as { ps: { pos: Vector3 }[] }).ps;
    for (const q of ps) expect(q.pos.y).toBeGreaterThanOrEqual(0.2 * q.pos.x + 0.01 - 1e-6);
    // A body hitting the ground (reported by the presentation world) kicks up dust too.
    const before = fx.effects.particleCount;
    for (const l of pw.bodyFalls) l({ f: p, at: new Vector3(0, 0.3, 0), hard: 1, mass: 1 });
    expect(fx.effects.particleCount - before).toBe(16);
  });
});

describe('tuning', () => {
  it('RAGDOLL_TUNING and PRESENTATION_TUNING are registered live tables with their §9 values', () => {
    const rag = TUNING.find((e) => e.name === 'RAGDOLL_TUNING')!;
    expect(rag.folder).toBe('Client › ragdoll');
    expect(rag.table).toBe(RAGDOLL_TUNING);
    expect({ ...RAGDOLL_TUNING }).toEqual({ muscleGain: 0.55, rootGain: 0.45, impulseMul: 1, dipMul: 1, limpStrength: 0.12, strikeGain: 0.92, downRootGain: 0.15 });
    const pres = TUNING.find((e) => e.name === 'PRESENTATION_TUNING')!;
    expect(pres.folder).toBe('Client › presentation');
    expect(pres.table).toBe(PRESENTATION_TUNING);
    expect(PRESENTATION_TUNING.maxRagdolls).toBe(8);
    expect(PRESENTATION_TUNING.mirrorRadiusM).toBe(30);
    // DS bodyLanding's numbers (game.ts) are live keys, not bare constants.
    expect({ ...PRESENTATION_TUNING }).toEqual({
      maxRagdolls: 8,
      mirrorRadiusM: 30,
      lodHysteresisM: 2,
      bodyFallSpeed: 1.4,
      bodyFallStopFrac: 0.35,
      bodyFallNearM: 0.45,
      bodyFallQuietSteps: 20,
      bodyFallHardSpeed: 5,
    });
    for (const k of Object.keys(PRESENTATION_TUNING)) {
      const meta = pres.fields[k] as { unit?: string; source?: string };
      expect(meta.unit, k).toBeTruthy();
      expect(meta.source, k).toBeTruthy();
    }
  });
});
