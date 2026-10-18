// Throw (docs/M1-DESIGN.md §5.11; package P17), headless, through commands only: a 40 kg log leaves at 4.47 m/s
// (SPEC:285's 400 J cap) as a Rapier body, spinning end over end, plus the thrower's walk; a spear and a stone at 20 m/s
// as DungeonStyle projectiles (D-29), the spear point first; the charge; aim quantisation round-trips; the throw moves;
// a thrown entity is `held` until its first contact (D-31), released by its thrower and credited; the projectile and
// its entity (the same id, through a save) and back again (landThrown); the refusals.
//
// Scene numbers (masses, lengths, positions, tick counts) are test constants, never tuning (§9).
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadWorld } from '../src/save/load';
import { serializeWorld } from '../src/save/serialize';
import { AIM_STEPS, aimOf, aimVector, moveCommand, type VerbCommand } from '../src/sim/commands';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { projectileDir, projectileGrip } from '../src/sim/projectiles';
import { launchSpeed } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { spawnLog, spawnStick, spawnStone } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Entity, V3, WorldEvent } from '../src/world/types';
import { heldShape, verbGeom } from '../src/world/verbs/tools';
import { landThrown, planThrow, thrownEntityOf, throwLaunchSpeed, throwSpeedFrac } from '../src/world/verbs/throw';
import { VERB_TUNING } from '../src/world/verbs/tuning';
import { createWorld, type World } from '../src/world/world';

vi.setConfig({ testTimeout: 120_000 });

const live: World[] = [];
async function make(seed = 51): Promise<World> {
  const w = await createWorld({ seed, scene: 'empty', nav: 'off', size: 60 });
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

type VerbEvent = Extract<WorldEvent, { type: 'verb' }>;
type ImpactEv = Extract<WorldEvent, { type: 'impact' }>;

function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind' | 'target'> & { target?: number }): VerbCommand {
  const c = { tick: w.tick + 1, player: 1, kind: 'verb', target: 0, ...v } as VerbCommand;
  w.commands.push(c);
  return c;
}

function run(w: World, n: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < n; t++) out.push(...w.step().world);
  return out;
}

const verbs = (evs: WorldEvent[], name?: VerbCommand['verb']): VerbEvent[] =>
  evs.filter((e): e is VerbEvent => e.type === 'verb' && (!name || e.verb === name));

const ent = (w: World, id: number): Entity => {
  const e = w.entities.get(id);
  if (!e) throw new Error(`no entity ${id}`);
  return e;
};

const len = (v: V3): number => Math.hypot(v.x, v.y, v.z);

function hold(w: World, id: number): void {
  expect(w.verbs.putInHands(w.player!, id)).toBe(true);
  w.step();
}

/**
 * Throws what the player holds with `aim` and `charge`, stepping until it leaves the hands (the `throw` event): the
 * tick it left, the events so far, and the members' velocities as they were set at that instant (a spy on the entity
 * store's state change, before any physics step).
 */
function throwIt(
  w: World,
  aim: [number, number],
  charge: number | undefined,
  max = 120,
  each?: () => void,
): { tick: number; evs: WorldEvent[]; released: Map<number, { lin: V3; ang: V3 }>; walk: V3; move: string | null; throwAim: Fighter['throwAim'] } {
  const released = new Map<number, { lin: V3; ang: V3 }>();
  let walk: V3 = { x: 0, y: 0, z: 0 };
  const store = w.entities;
  const real = store.setState.bind(store);
  const spy = vi.spyOn(store, 'setState').mockImplementation((e, s) => {
    real(e, s);
    if (s === 'free') {
      released.set(e.id, { lin: { ...e.vel.lin }, ang: { ...e.vel.ang } });
      const p = w.player!;
      walk = { x: p.walkVel.x, y: p.walkVel.y, z: p.walkVel.z };
    }
  });
  verb(w, charge === undefined ? { verb: 'throw', aim } : { verb: 'throw', aim, charge });
  const evs: WorldEvent[] = [];
  let move: string | null = null;
  let throwAim: Fighter['throwAim'] = null;
  const p = w.player!;
  for (let t = 0; t < max; t++) {
    each?.();
    const r = w.step();
    evs.push(...r.world);
    if (move === null && p.state === 'attack') {
      move = p.move?.id ?? null;
      throwAim = p.throwAim ? { dir: p.throwAim.dir.clone(), speedFrac: p.throwAim.speedFrac, techSpeed: p.throwAim.techSpeed } : null;
    }
    if (verbs(r.world, 'throw').length) {
      spy.mockRestore();
      return { tick: w.tick, evs, released, walk, move, throwAim };
    }
  }
  spy.mockRestore();
  throw new Error(`nothing was thrown within ${max} ticks`);
}

function addApe(w: World, x: number, z: number, yaw = 0): Fighter {
  const ids = w.ids.fighter;
  const { fighter: f } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  f.scale = SPECIES_BODY.ape.scale;
  f.species = 'ape';
  f.massKg = SPECIES_BODY.ape.massKg;
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  f.yaw = yaw;
  w.addFighter(f, null);
  w.teleport(f, x, z, yaw);
  return f;
}

const LEVEL_Z: [number, number] = [0, 0];

// ---------------------------------------------------------------------------
// The speeds (§5.11, SPEC:285, D-29)
// ---------------------------------------------------------------------------

describe('speeds (§5.11)', () => {
  it('a 40 kg log leaves at 4.47 m/s (400 J) as a Rapier body: the aim plus the walk, end over end, the throwHeavy move', async () => {
    const w = await make();
    const p = w.player!;
    const id = spawnLog(w, { p: { x: 2, y: 0.12, z: 2 }, length: 2.2, mass: 40 });
    w.step();
    hold(w, id);
    expect(p.inventory!.hands).toEqual(expect.objectContaining({ mode: 'carry', twoHanded: true }));
    // Walking +x (sideways to the throw) up to and through it.
    for (let t = 0; t < 20; t++) {
      w.commands.push(moveCommand(w.tick + 1, 1, 1, 0));
      w.step();
    }
    const { evs, released, walk, move, throwAim } = throwIt(w, LEVEL_Z, 255, 120, () => w.commands.push(moveCommand(w.tick + 1, 1, 1, 0)));
    // The walk at the release is added to the throw (§5.11: linvel = aim·v + walkVel).
    expect(Math.abs(walk.x)).toBeGreaterThan(0.05);
    expect(move).toBe('throwHeavy');
    expect(throwAim).toEqual(expect.objectContaining({ speedFrac: 1, techSpeed: VERB_TUNING.heavyThrowSpeed }));
    expect(verbs(evs, 'throw')).toEqual([expect.objectContaining({ ok: true, entity: id })]);
    // The aim is spent at the release.
    expect(p.throwAim).toBeNull();
    const v = released.get(id)!;
    expect(v).toBeDefined();
    const rel = { x: v.lin.x - walk.x, y: v.lin.y - walk.y, z: v.lin.z - walk.z };
    expect(len(rel)).toBeCloseTo(Math.sqrt((2 * 400) / 40), 4);
    expect(len(rel)).toBeCloseTo(4.4721, 3);
    expect(rel.z / len(rel)).toBeCloseTo(1, 6);
    expect(0.5 * 40 * len(rel) ** 2).toBeCloseTo(400, 1);
    // End over end: about up × the flat aim (+x for +z), throwSpinRadS.
    expect(v.ang.x).toBeCloseTo(VERB_TUNING.throwSpinRadS, 5);
    expect(Math.hypot(v.ang.y, v.ang.z)).toBeLessThan(1e-6);
    const e = ent(w, id);
    expect(e.state).toBe('free');
    expect(e.thrown?.by).toBe(p.id);
    // Released by its thrower (§4.3) as it leaves the hands, as the projectile path is.
    expect(e.releasedBy?.fighter).toBe(p.id);
    expect(e.credit).toEqual(['p1']);
    expect(p.inventory!.hands).toBeNull();
    expect(p.load).toBeNull();
  });

  it('the charge: 0 throws at throwMinFrac (half) speed, 255 at full; the speed is launchSpeed(m, techSpeed) × it', async () => {
    expect(throwSpeedFrac(0)).toBeCloseTo(VERB_TUNING.throwMinFrac, 12);
    expect(throwSpeedFrac(255)).toBe(1);
    expect(throwSpeedFrac(undefined)).toBe(1);
    expect(throwLaunchSpeed(40, 255)).toBeCloseTo(4.4721, 4);
    expect(throwLaunchSpeed(40, 0)).toBeCloseTo(2.2361, 4);
    expect(throwLaunchSpeed(1, 255)).toBe(VERB_TUNING.smallThrowSpeed);
    expect(throwLaunchSpeed(2, 255)).toBeCloseTo(20, 9);
    // Above projectileMaxKg the technique is two-handed: 12 m/s, under the 400 J cap until 5.56 kg.
    expect(throwLaunchSpeed(3, 255)).toBe(VERB_TUNING.heavyThrowSpeed);
    expect(throwLaunchSpeed(10, 255)).toBeCloseTo(launchSpeed(10, 12), 12);

    const w = await make();
    const id = spawnLog(w, { p: { x: 2, y: 0.12, z: 2 }, length: 2.2, mass: 40 });
    w.step();
    hold(w, id);
    const { released, walk } = throwIt(w, LEVEL_Z, 0);
    const v = released.get(id)!;
    expect(Math.hypot(v.lin.x - walk.x, v.lin.y - walk.y, v.lin.z - walk.z)).toBeCloseTo(2.2361, 3);
  });

  it('a spear and a stone leave at 20 m/s as DS projectiles: the spear point first (throwSpear), the stone spinning (throwOne)', async () => {
    for (const kind of ['spear', 'stone'] as const) {
      const w = await make();
      const p = w.player!;
      const id = kind === 'spear' ? spawnStick(w, { p: { x: 2, y: 0.04, z: 2 }, length: 1.9, r: 0.025, sharp: { end: 1, s: 0.6 } }) : spawnStone(w, { p: { x: 2, y: 0.1, z: 2 }, mass: 1 });
      w.step();
      hold(w, id);
      expect(p.weapon?.id).toBe(kind);
      expect(heldShape(w, id).massKg).toBeLessThanOrEqual(VERB_TUNING.projectileMaxKg);
      verb(w, { verb: 'throw', aim: LEVEL_Z, charge: 255 });
      let move: string | undefined;
      const evs: WorldEvent[] = [];
      let n = 0;
      for (let t = 0; t < 120 && n === 0; t++) {
        const r = w.step();
        evs.push(...r.world);
        if (p.state === 'attack') move = p.move?.id;
        n = w.combat.projectiles.length;
      }
      expect(move, kind).toBe(kind === 'spear' ? 'throwSpear' : 'throwOne');
      expect(verbs(evs, 'throw'), kind).toEqual([expect.objectContaining({ ok: true, entity: id })]);
      expect(w.combat.projectiles, kind).toHaveLength(1);
      const pr = w.combat.projectiles[0];
      expect(pr.owner).toBe(p);
      // 20 m/s along the aim; DS's scatter turns it about the vertical (keeping the horizontal speed) and adds a little
      // vertical, so the horizontal speed is exactly the launch speed. (It has flown one tick: gravity is vertical.)
      expect(Math.hypot(pr.vel.x, pr.vel.z), kind).toBeCloseTo(VERB_TUNING.smallThrowSpeed, 9);
      expect(pr.vel.length(), kind).toBeLessThan(20.5);
      expect(pr.vel.z / Math.hypot(pr.vel.x, pr.vel.z), kind).toBeGreaterThan(0.99);
      if (kind === 'spear') {
        // Point first: no spin, the grip-to-tip direction along the flight.
        expect(pr.omega).toBe(0);
        expect(projectileDir(pr, new Vector3()).dot(pr.vel.clone().normalize())).toBeCloseTo(1, 9);
      } else expect(pr.omega).toBeGreaterThan(0);
      // The entity has no body in flight; it is thrown, released and credited, and the projectile is it.
      const e = ent(w, id);
      expect(e.state, kind).toBe('projectile');
      expect(e.body, kind).toBeNull();
      expect(e.thrown, kind).toEqual({ by: p.id, tick: w.tick });
      expect(e.releasedBy?.fighter, kind).toBe(p.id);
      expect(e.credit, kind).toEqual(['p1']);
      expect(thrownEntityOf(w, pr), kind).toBe(id);
      expect(p.weapon).toBeNull();
      expect(p.inventory!.hands).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Aim (§1.5.3: 1/4096 turn), the projectile's entity, held until first contact
// ---------------------------------------------------------------------------

describe('aim, the projectile’s entity, and held until first contact (§5.11, D-31)', () => {
  it('aim quantisation round-trips: aimOf(aimVector(a)) = a, and a body leaves along aimVector(a)', async () => {
    for (let yaw = 0; yaw < AIM_STEPS; yaw += 37) {
      for (const pitch of [-1023, -700, -128, -1, 0, 1, 64, 333, 1023]) {
        const a: [number, number] = [yaw, pitch];
        expect(aimOf(aimVector(a, new Vector3()))).toEqual(a);
      }
    }
    for (const aim of [
      [0, 0],
      [1024, 300],
      [2900, -200],
      [4095, 57],
    ] as [number, number][]) {
      const w = await make();
      const id = spawnLog(w, { p: { x: 2, y: 0.12, z: 2 }, length: 1.2, mass: 8 });
      w.step();
      hold(w, id);
      const { released, walk } = throwIt(w, aim, 255);
      const v = released.get(id)!;
      const d = { x: v.lin.x - walk.x, y: v.lin.y - walk.y, z: v.lin.z - walk.z };
      const want = aimVector(aim, new Vector3());
      const l = len(d);
      expect(Math.hypot(d.x / l - want.x, d.y / l - want.y, d.z / l - want.z), JSON.stringify(aim)).toBeLessThan(1e-6);
      expect(aimOf(d), JSON.stringify(aim)).toEqual(aim);
      // 8 kg under the 400 J cap: √(800 / 8) = 10 m/s, not the technique's 12.
      expect(l).toBeCloseTo(launchSpeed(8, VERB_TUNING.heavyThrowSpeed), 4);
      expect(l).toBeCloseTo(10, 4);
    }
  });

  it('a thrown log is held until its first contact: CCD on, released by its thrower, its blow on an ape caused by him', async () => {
    const w = await make(53);
    const p = w.player!;
    const ape = addApe(w, 0, 2.6, Math.PI);
    const id = spawnLog(w, { p: { x: 2, y: 0.12, z: -1 }, length: 1.2, mass: 15 });
    run(w, 5);
    hold(w, id);
    // A little up, at the ape's chest.
    const pitch = Math.round((8 / 360) * AIM_STEPS);
    const { tick } = throwIt(w, [0, pitch], 255);
    const e = ent(w, id);
    expect(e.thrown).toEqual({ by: p.id, tick });
    expect(e.body!.isCcdEnabled()).toBe(true);
    let hit: ImpactEv | undefined;
    let flying = 0;
    for (let t = 0; t < 60 && !hit; t++) {
      const r = w.step();
      hit = r.world.find((x): x is ImpactEv => x.type === 'impact' && x.defender === ape && x.cause.entityId === id);
      if (!hit && e.thrown) flying++;
    }
    expect(flying).toBeGreaterThan(0);
    expect(hit).toBeDefined();
    expect(hit!.cause).toMatchObject({ kind: 'entity', entityId: id, held: true, fighterId: p.id, credit: ['p1'] });
    // The hit was its first contact: no longer thrown.
    expect(e.thrown).toBeNull();
  });

  it('the spear in flight is the same entity: through a save, and back as a body at the projectile’s pose with its velocity', async () => {
    const w = await make();
    const p = w.player!;
    const id = spawnStick(w, { p: { x: 2, y: 0.04, z: 2 }, length: 1.9, r: 0.025, sharp: { end: 1, s: 0.6 } });
    w.step();
    hold(w, id);
    const pitch = Math.round((20 / 360) * AIM_STEPS);
    throwIt(w, [0, pitch], 255);
    run(w, 6);
    expect(w.combat.projectiles).toHaveLength(1);
    const pr = w.combat.projectiles[0];
    expect(thrownEntityOf(w, pr)).toBe(id);

    // A save mid-flight: the loaded world's projectile is the same entity (the link is saved state only).
    const loaded = await loadWorld(serializeWorld(w), { nav: 'off' });
    live.push(loaded);
    expect(loaded.combat.projectiles).toHaveLength(1);
    expect(thrownEntityOf(loaded, loaded.combat.projectiles[0])).toBe(id);
    expect(loaded.entities.get(id)?.state).toBe('projectile');

    // Another of the thrower's objects in flight, released a tick earlier (a stand-in: its state and `thrown` are all
    // the link reads). The projectile is the spear alone: the link is its exact release tick, never the nearest one.
    const decoy = spawnStone(w, { p: { x: -3, y: 0.1, z: -3 }, mass: 1 });
    w.step();
    expect(w.combat.projectiles).toEqual([pr]);
    w.entities.setState(ent(w, decoy), 'projectile');
    ent(w, decoy).thrown = { by: p.id, tick: w.tick - pr.age };
    expect(thrownEntityOf(w, pr)).toBe(id);

    // Back as a body (what P15's landing does): the same id, its axis along the flight, its grip at the projectile's.
    expect(landThrown(w, pr)).toBe(id);
    const e = ent(w, id);
    expect(e.state).toBe('free');
    expect(e.body?.isEnabled()).toBe(true);
    const hs = heldShape(w, id);
    const axis = verbGeom.dirToWorld(e.pose, hs.axis);
    const dir = projectileDir(pr, new Vector3());
    expect(axis.x * dir.x + axis.y * dir.y + axis.z * dir.z).toBeCloseTo(1, 5);
    const grip = verbGeom.pointToWorld(e.pose, hs.grip);
    const g = projectileGrip(pr, new Vector3());
    expect(Math.hypot(grip.x - g.x, grip.y - g.y, grip.z - g.z)).toBeLessThan(1e-4);
    expect(Math.hypot(e.vel.lin.x - pr.vel.x, e.vel.lin.y - pr.vel.y, e.vel.lin.z - pr.vel.z)).toBeLessThan(1e-4);
    // Still held (D-31) until its first contact.
    expect(e.thrown?.by).toBe(p.id);
    // Nothing else is in flight for it: a second landing of the same projectile is a no-op (it never takes the other
    // object in flight).
    expect(thrownEntityOf(w, pr)).toBeNull();
    expect(landThrown(w, pr)).toBeNull();
    expect(ent(w, decoy).state).toBe('projectile');
    expect(ent(w, decoy).thrown).toEqual({ by: p.id, tick: w.tick - pr.age });
  });
});

// ---------------------------------------------------------------------------
// Refusals (§5.11 preconditions, §5.0)
// ---------------------------------------------------------------------------

describe('refusals (§5.11)', () => {
  it('empty hands, a dragged load, a rope end and a malformed aim are refused with no effect', async () => {
    const w = await make();
    const p = w.player!;
    const heavy = spawnLog(w, { p: { x: 0, y: 0.2, z: 1.4 }, length: 3, mass: 120 });
    const rope = spawnStick(w, { p: { x: 3, y: 0.05, z: 3 }, length: 0.5, r: 0.02, material: 'vine' });
    w.step();
    const cmd = (aim?: [number, number], charge?: number) => ({ tick: 0, player: 1, kind: 'verb', verb: 'throw', target: 0, aim, charge }) as VerbCommand;
    const why = (c: VerbCommand) => {
      const r = planThrow(w, p, c);
      return r.ok ? null : r.reason;
    };
    expect(why(cmd(LEVEL_Z))).toBe('handsEmpty');
    verb(w, { verb: 'throw', aim: LEVEL_Z, charge: 255 });
    expect(verbs(run(w, 2), 'throw')).toEqual([expect.objectContaining({ ok: false, reason: 'handsEmpty' })]);
    expect(w.verbs.putInHands(p, heavy)).toBe(true);
    expect(why(cmd(LEVEL_Z))).toBe('dragging');
    w.verbs.letGo(p);
    // A rope end in the hand (the joint store's; the mode is what matters here).
    p.inventory!.hands = { entity: rope, mode: 'ropeEnd', grip: { x: 0, y: 0, z: 0 }, twoHanded: false, joint: null };
    expect(why(cmd(LEVEL_Z))).toBe('ropeEnd');
    p.inventory!.hands = null;
    const stone = spawnStone(w, { p: { x: -1, y: 0.1, z: 1 }, mass: 1 });
    w.step();
    expect(w.verbs.putInHands(p, stone)).toBe(true);
    expect(why(cmd(undefined))).toBe('noTarget');
    expect(why(cmd([0, AIM_STEPS / 4 + 1]))).toBe('noTarget');
    expect(why(cmd([0.5, 0]))).toBe('noTarget');
    expect(why(cmd(LEVEL_Z, 1.5))).toBe('noTarget');
    expect(why(cmd(LEVEL_Z))).toBeNull();
    expect(planThrow(w, p, cmd(LEVEL_Z))).toEqual({ ok: true, plan: expect.objectContaining({ path: 'projectile', move: 'throwOne', techSpeed: 20, speedFrac: 1, speed: 20 }) });
    // Nothing moved: the stone is still in the hands.
    const inHands = (f: Fighter): number | undefined => f.inventory?.hands?.entity;
    expect(inHands(p)).toBe(stone);
    expect(ent(w, stone).state).toBe('held');
  });
});
