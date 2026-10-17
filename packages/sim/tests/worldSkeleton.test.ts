// The world skeleton (docs/M1-DESIGN.md §1.5.1, §3, §8.1; package P05): createWorld and its memoised init, the seams it
// sets, the player, world-owned ids and streams, the full phase list of §3 in order, live tuning as a command, 600-tick
// determinism of two empty worlds, supportAt, teleport (with its pose-history reset and contact grace), the KO seam and
// dispose.
import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BONES } from '../src/body/skeleton';
import type { CombatEvent } from '../src/sim/combat';
import { type Command, moveCommand, setTuningCommand, type VerbCommand } from '../src/sim/commands';
import { type Fighter, IdCounter, LEGACY_IDS } from '../src/sim/fighter';
import { Rng, seedFor } from '../src/sim/math';
import { createPlayer } from '../src/sim/roster';
import { getTuningValue, resetTuning } from '../src/tuning/registry';
import { NavSystem, NavWalkable } from '../src/world/nav';
import { collisionGroups } from '../src/world/groups';
import { ownerKey, PHYSICS_TUNING, physicsInitCount, physicsReady } from '../src/world/physics';
import { DAMAGE_TUNING } from '../src/sim/rules';
import type { Entity, EntityState, RulerState, WorldEvent } from '../src/world/types';
import { createWorld, playerIdOf, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

const live: World[] = [];
async function make(o: WorldOptions): Promise<World> {
  const w = await createWorld(o);
  live.push(w);
  return w;
}

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning('WORLD_TUNING');
});

beforeAll(async () => {
  await physicsReady();
});

/** A fighter's own Rng (private on Fighter; the save reads it through P04's records). */
const rngOf = (f: Fighter): Rng => (f as unknown as { rng: Rng }).rng;

/** Every number of the player's and the sim's state that outcomes depend on, as exact text. */
function digest(w: World): string {
  const parts: number[] = [w.tick, w.combat.rng.state];
  for (const f of w.combat.fighters) {
    parts.push(f.id, f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.walkVel.x, f.walkVel.z, f.yaw, f.hp, f.stamina, f.stateFrame, rngOf(f).state);
    for (const b of BONES) {
      const x = f.rig[b];
      parts.push(x.pos.x, x.pos.y, x.pos.z, x.rot.x, x.rot.y, x.rot.z, x.rot.w);
    }
  }
  return parts.map((v) => (Object.is(v, -0) ? '-0' : String(v))).join(',');
}

/** Events as comparable text (fighters by id). */
function eventsText(ce: readonly CombatEvent[], we: readonly WorldEvent[]): string {
  return JSON.stringify([...ce, ...we], (_k, v) => (v && typeof v === 'object' && 'id' in v && 'rig' in v ? `fighter:${v.id}` : v));
}

describe('createWorld', () => {
  it('awaits the memoised physicsReady: every world reuses the one initialisation', async () => {
    await make({ seed: 1, scene: 'empty', nav: 'off' });
    await make({ seed: 2, scene: 'empty', nav: 'off' });
    expect(physicsInitCount()).toBe(1);
    expect(physicsReady()).toBe(physicsReady());
  });

  it('fills in the options: empty scenes are flat, the Clearing is the default scene, size rounds to tiles', async () => {
    const e = await make({ seed: 3, scene: 'empty', nav: 'off' });
    expect(e.options).toEqual({ seed: 3, scene: 'empty', terrain: 'flat', size: 200, nav: 'off', player: true, sparringApe: false });
    expect([e.terrain.tilesX, e.terrain.tilesZ, e.terrain.spacing]).toEqual([8, 8, 0.25]);
    expect(e.terrain.heightAt(12.3, -40)).toBe(0);
    expect(e.spawnData).toBeNull();
    const c = await make({ seed: 0xffffffff, nav: 'off', size: 50 });
    expect(c.options.scene).toBe('clearing');
    expect(c.options.terrain).toBe('generated');
    expect(c.seed).toBe(0xffffffff);
    expect(c.terrain.tilesX).toBe(2);
    expect(c.spawnData).not.toBeNull();
    const n = await make({ seed: 4, scene: 'empty', nav: 'full' });
    expect(n.nav).toBeInstanceOf(NavSystem);
    expect(e.nav).toBeNull();
  });

  it('sets every CombatSim seam before any fighter joins', async () => {
    const w = await make({ seed: 5, scene: 'empty', nav: 'off' });
    const sim = w.combat;
    expect(sim.mover).toBe(w.mover);
    expect(sim.ground).toBe(w.ground);
    expect(sim.world).toBe(w);
    expect(sim.physicsOwnsDowned).toBe(true);
    expect(sim.walkable).toBeInstanceOf(NavWalkable);
    expect(w.commands).toBe(sim.commands);
    expect(sim.playerFighter!(1)).toBe(w.player);
    expect(sim.playerFighter!(2)).toBeUndefined();
    expect(w.player!.ground).toBe(w.ground);
    expect(w.ground.heightAt(3, 4)).toBe(w.terrain.heightAt(3, 4));
  });

  it("spawns player number 1 ('p1') at the spawn on the terrain, with world-owned ids and streams", async () => {
    const before = LEGACY_IDS.next;
    const a = await make({ seed: 77, scene: 'empty', nav: 'off' });
    const b = await make({ seed: 77, scene: 'empty', nav: 'off' });
    expect(LEGACY_IDS.next).toBe(before);
    for (const w of [a, b]) {
      const p = w.player!;
      expect(p.id).toBe(1);
      expect(w.ids.fighter.next).toBe(2);
      expect(w.players.get(1)).toBe(p);
      expect(p.playerId).toBe(playerIdOf(1));
      expect(p.playerId).toBe('p1');
      expect(p.species).toBe('human');
      expect(p.inventory).toEqual({ hands: null, belt: [null, null, null], back: null });
      expect([p.pos.x, p.pos.y, p.pos.z]).toEqual([WORLD_TUNING.spawnX, 0, WORLD_TUNING.spawnZ]);
      // Its own stream is seedFor(seed, 'fighter', id): a replica built with that seed and posed as CombatSim.add poses
      // a fighter has drawn the same numbers.
      const replica = createPlayer({ ids: new IdCounter(1), rngSeed: seedFor(77, 'fighter', 1) });
      replica.ground = w.ground;
      replica.updatePose(0, 0, 0);
      expect(rngOf(p).state).toBe(rngOf(replica).state);
      expect(w.combat.rng.state).toBe(new Rng(seedFor(77, 'combat')).state);
      expect(w.rngs.combat).toBe(w.combat.rng);
      expect(w.rngs.world.state).toBe(new Rng(seedFor(77, 'world')).state);
      expect(w.rngs.mind(9)).toBe(w.rngs.mind(9));
      expect(w.rngs.mind(9).state).toBe(new Rng(seedFor(77, 'mind', 9)).state);
    }
    const none = await make({ seed: 77, scene: 'empty', nav: 'off', player: false });
    expect(none.player).toBeNull();
    expect(none.combat.fighters).toEqual([]);
  });
});

describe('the tick pipeline (§3)', () => {
  it('calls every phase in order, once per tick, with verb commands in 1b and meta commands in 1c', async () => {
    const w = await make({ seed: 6, scene: 'empty', nav: 'full' });
    const log: string[] = [];
    const spy = (label: string, obj: object, method: string) => {
      const o = obj as Record<string, (...a: unknown[]) => unknown>;
      const orig = o[method].bind(obj);
      o[method] = (...args: unknown[]) => {
        log.push(label);
        return orig(...args);
      };
    };
    spy('1a combat.beginTick', w.combat, 'beginTick');
    spy('2 minds.sense', w.minds, 'sense');
    spy('3 combat.stepBody', w.combat, 'stepBody');
    spy('4a downed.syncDown', w.downed, 'syncDown');
    spy('4a verbs.onDown', w.verbs, 'onDown');
    spy('4b zones.pose', w.zones, 'pose');
    spy('4b verbs.syncHeld', w.verbs, 'syncHeld');
    spy('4c rulers.preStep', w.rulers, 'preStep');
    spy('4d kcc.applyPushes', w.kcc, 'applyPushes');
    spy('4d rulers.applyShoves', w.rulers, 'applyShoves');
    spy('4d verbs.codeForces', w.verbs, 'codeForces');
    spy('4d joints.applyHeldEnds', w.joints, 'applyHeldEnds');
    spy('4d entities.applyImpulses', w.entities, 'applyImpulses');
    spy('4e joints.poseSensors', w.joints, 'poseSensors');
    spy('5 physics.storePreStep', w.physics, 'storePreStep');
    spy('7 physics.step', w.physics, 'step');
    spy('8 physics.snapshotPostStep', w.physics, 'snapshotPostStep');
    spy('8 physics.drain', w.physics, 'drain');
    spy('9 contacts.process', w.contacts, 'process');
    spy('10 joints.postStep', w.joints, 'postStep');
    spy('11 loads.update', w.loads, 'update');
    spy('12 breaking.update', w.breaking, 'update');
    spy('13a downed.postStep', w.downed, 'postStep');
    spy('13b rulers.postStep', w.rulers, 'postStep');
    spy('13c felling.update', w.felling, 'update');
    spy('15 deaths.update', w.deaths, 'update');
    spy('15 spawner.update', w.spawner, 'update');
    spy('16 nav.rebuildDirty', w.nav!, 'rebuildDirty');
    spy('17b noise.collect', w.noise, 'collect');
    spy('17b noise.fold', w.noise, 'fold');
    spy('18 entities.mirror', w.entities, 'mirror');
    // Phase 1b sees the verb commands in queue order, and runs before phase 1c's live tuning edit; phase 2 runs after.
    const seenVerbs: VerbCommand[][] = [];
    const aiNear: number[] = [];
    const applyCommands = w.verbs.applyCommands.bind(w.verbs);
    w.verbs.applyCommands = (cmds) => {
      log.push('1b verbs.applyCommands');
      seenVerbs.push([...cmds]);
      aiNear.push(WORLD_TUNING.aiNearM);
      applyCommands(cmds);
    };
    const sense = w.minds.sense;
    w.minds.sense = (ww) => {
      aiNear.push(WORLD_TUNING.aiNearM);
      sense(ww);
    };
    const v1: VerbCommand = { tick: 1, player: 1, kind: 'verb', verb: 'focus', target: 0, at: [0, 0, 100] };
    const v2: VerbCommand = { tick: 1, player: 1, kind: 'verb', verb: 'drop', target: 0 };
    const cmds: Command[] = [v1, setTuningCommand(1, 1, 'WORLD_TUNING', 'aiNearM', 61), moveCommand(1, 1, 0, 1), v2, { tick: 1, player: 1, kind: 'meta', meta: 'pause' }];
    for (const c of cmds) w.commands.push(c);
    const r = w.step();
    expect(log).toEqual([
      '1a combat.beginTick',
      '1b verbs.applyCommands',
      '2 minds.sense',
      '3 combat.stepBody',
      '4a downed.syncDown',
      '4a verbs.onDown',
      '4b zones.pose',
      '4b verbs.syncHeld',
      '4c rulers.preStep',
      '4d kcc.applyPushes',
      '4d rulers.applyShoves',
      '4d verbs.codeForces',
      '4d joints.applyHeldEnds',
      '4d entities.applyImpulses',
      '4e joints.poseSensors',
      '5 physics.storePreStep',
      '7 physics.step',
      '8 physics.snapshotPostStep',
      '8 physics.drain',
      '9 contacts.process',
      '10 joints.postStep',
      '11 loads.update',
      '12 breaking.update',
      '13a downed.postStep',
      '13b rulers.postStep',
      '13c felling.update',
      '15 deaths.update',
      '15 spawner.update',
      '16 nav.rebuildDirty',
      '17b noise.collect',
      '17b noise.fold',
      '18 entities.mirror',
    ]);
    expect(seenVerbs).toEqual([[v1, v2]]);
    expect(aiNear).toEqual([60, 61]);
    expect(w.tick).toBe(1);
    expect(r.save).toBeNull();
    expect(r.combat).toBe(w.combat.events);
    expect(r.world).toBe(w.events);
    // The move command reached player 1 in phase 1a.
    expect(w.player!.moveInput.z).toBeCloseTo(1, 6);
  });

  it('applies a live tuning edit in phase 1c of its own tick, so the command log replays it', async () => {
    const w = await make({ seed: 8, scene: 'empty', nav: 'off' });
    w.commands.push(setTuningCommand(5, 1, 'WORLD_TUNING', 'corpseDespawnS', 90));
    for (let t = 1; t < 5; t++) w.step();
    expect(getTuningValue('WORLD_TUNING', 'corpseDespawnS')).toBe(120);
    w.step();
    expect(w.tick).toBe(5);
    expect(getTuningValue('WORLD_TUNING', 'corpseDespawnS')).toBe(90);
  });

  it('steps an empty world 600 ticks, and two of them bit-identically, with the player walking on commands', async () => {
    const a = await make({ seed: 1234, scene: 'empty', nav: 'off' });
    const b = await make({ seed: 1234, scene: 'empty', nav: 'off' });
    // A walk out and back, the same tick-tagged commands for both worlds.
    const script: Command[] = [moveCommand(30, 1, 0.6, 0.8), moveCommand(200, 1, -1, 0), moveCommand(320, 1, 0, 0), moveCommand(400, 1, 0, -0.5), moveCommand(520, 1, 0, 0)];
    for (const w of [a, b]) for (const c of script) w.commands.push({ ...c });
    let moved = 0;
    for (let t = 1; t <= 600; t++) {
      const ra = a.step();
      const rb = b.step();
      expect(eventsText(ra.combat, ra.world)).toBe(eventsText(rb.combat, rb.world));
      if (t % 60 === 0) expect(digest(a)).toBe(digest(b));
      moved = Math.max(moved, Math.hypot(a.player!.pos.x, a.player!.pos.z));
    }
    expect(a.tick).toBe(600);
    expect(digest(a)).toBe(digest(b));
    expect(moved).toBeGreaterThan(1);
    for (const v of [a.player!.pos.x, a.player!.pos.y, a.player!.pos.z]) expect(Number.isFinite(v)).toBe(true);
    // A different seed is a different world (the streams really derive from it).
    const c = await make({ seed: 1235, scene: 'empty', nav: 'off' });
    expect(c.combat.rng.state).not.toBe(new Rng(seedFor(1234, 'combat')).state);
  });
});

describe('the default empty world and the RNG record', () => {
  it("createWorld({ seed, scene: 'empty' }) with every other option at its default steps 600 ticks", async () => {
    const w = await make({ seed: 21, scene: 'empty' });
    expect(w.options.nav).toBe('full');
    for (let t = 0; t < 600; t++) w.step();
    expect(w.tick).toBe(600);
    for (const v of [w.player!.pos.x, w.player!.pos.y, w.player!.pos.z, w.player!.hp]) expect(Number.isFinite(v)).toBe(true);
  });

  it("the world-level stream states round-trip through WorldRngs' record", async () => {
    const w = await make({ seed: 22, scene: 'empty', nav: 'off' });
    for (let t = 0; t < 30; t++) w.step();
    w.rngs.world.next();
    const rec = w.rngs.toRecord();
    expect(rec).toEqual({ combat: w.combat.rng.state, world: w.rngs.world.state });
    const next = [w.rngs.combat.next(), w.rngs.world.next(), w.rngs.world.next()];
    w.rngs.restoreRecord(rec);
    expect([w.rngs.combat.next(), w.rngs.world.next(), w.rngs.world.next()]).toEqual(next);
    expect(w.rngs.toRecord()).not.toEqual(rec);
  });
});

describe('support, teleport and dispose', () => {
  it('supportAt is the terrain where no entity rests', async () => {
    const w = await make({ seed: 9, scene: 'empty', nav: 'off' });
    w.terrain.lower(5, 5, 1);
    expect(w.supportAt(5, 5, 2)).toBe(w.terrain.heightAt(5, 5));
    expect(w.supportAt(5, 5, -10)).toBe(w.terrain.heightAt(5, 5));
    expect(w.ground.supportAt!(1, 2, 0)).toBe(0);
  });

  it('teleport puts a fighter on the ground at (x, z), at rest, facing yaw', async () => {
    const w = await make({ seed: 10, scene: 'empty', nav: 'off' });
    const p = w.player!;
    for (let k = 0; k < 4; k++) w.terrain.lower(-7, 3, 1);
    p.walkVel.set(1, 0, 2);
    w.teleport(p, -7, 3, 1.25);
    expect([p.pos.x, p.pos.y, p.pos.z]).toEqual([-7, w.terrain.heightAt(-7, 3), 3]);
    expect(p.pos.y).toBeLessThan(0);
    expect(p.yaw).toBe(1.25);
    expect([p.walkVel.x, p.walkVel.z, p.vel.x, p.vel.y, p.vel.z]).toEqual([0, 0, 0, 0, 0]);
    w.step();
    expect(Number.isFinite(p.pos.x)).toBe(true);
  });

  /**
   * A box entity of the given state standing on the (flat) terrain, its top at `top` (bottom at `bottom`), with a
   * stand-in record (the EntityStore is P06's: its stub knows no entity). Queries see it after the next step.
   */
  function box(w: World, records: Map<number, Entity>, id: number, x: number, z: number, half: number, bottom: number, top: number, state: EntityState): void {
    const desc = state === 'free' ? RAPIER.RigidBodyDesc.dynamic().setGravityScale(0) : RAPIER.RigidBodyDesc.fixed();
    const body = w.physics.rapier.createRigidBody(desc.setTranslation(x, (bottom + top) / 2, z));
    const c = w.physics.rapier.createCollider(RAPIER.ColliderDesc.cuboid(half, (top - bottom) / 2, half).setCollisionGroups(collisionGroups('ENTITY')), body);
    w.physics.register(c, { kind: 'entity', id });
    records.set(id, { id, state, restTicks: 0, body, collider: c } as unknown as Entity);
  }

  function withEntities(w: World): Map<number, Entity> {
    const records = new Map<number, Entity>();
    (w.entities as { get: (id: number) => Entity | undefined }).get = (id) => records.get(id);
    return records;
  }

  it('supportAt stands on fixed, anchored and resting entities below the reach, never on one the ray starts inside', async () => {
    const w = await make({ seed: 12, scene: 'empty', nav: 'off', player: false });
    const e = withEntities(w);
    box(w, e, 1, 10, 10, 1, 0, 0.3, 'fixed'); // a low slab
    box(w, e, 2, 5, 5, 0.25, 0, 10, 'fixed'); // a trunk
    box(w, e, 3, -10, -10, 0.5, 0, 0.4, 'free'); // a free box, not yet at rest
    box(w, e, 4, -5, 5, 0.05, 0, 0.6, 'anchored'); // a stake
    box(w, e, 5, 20, 20, 1, 0, 0.3, 'fixed'); // two stacked slabs: 0.3 m and 0.6 m
    box(w, e, 6, 20, 20, 1, 0.3, 0.6, 'fixed');
    w.step();
    const near = (v: number, want: number) => expect(v).toBeCloseTo(want, 6);
    near(w.supportAt(10, 10, 0), 0.3);
    near(w.ground.supportAt!(10, 10, 0), 0.3); // CombatSim's and footwork's GroundQuery
    // A top not below fromY + supportReachM is no support: the ray starts inside the slab, and inside the trunk (a foot
    // target in a trunk stays on the ground, and never rises by the reach).
    expect(WORLD_TUNING.supportReachM).toBe(0.5);
    expect(w.supportAt(10, 10, -0.3)).toBe(0);
    expect(w.supportAt(5.1, 5, 0)).toBe(0);
    expect(w.ground.supportAt!(5.1, 5, 0)).toBe(0);
    near(w.supportAt(5.1, 5, 9.6), 10); // standing on the trunk's top
    near(w.supportAt(-5, 5, 0.2), 0.6); // an anchored stake
    // A free entity is support only once it rests.
    expect(w.supportAt(-10, -10, 0)).toBe(0);
    (e.get(3) as { restTicks: number }).restTicks = PHYSICS_TUNING.restTicks;
    near(w.supportAt(-10, -10, 0), 0.4);
    // maxAboveTerrainM: taller tops are obstacles and the ray goes on to the one below; excludeEntities likewise.
    near(w.supportAt(20, 20, 0.3), 0.6);
    near(w.supportAt(20, 20, 0.3, { maxAboveTerrainM: 0.39 }), 0.3);
    near(w.supportAt(20, 20, 0.3, { excludeEntities: [6] }), 0.3);
    expect(w.supportAt(20, 20, 0.3, { excludeEntities: [6, 5] })).toBe(0);
    expect(w.supportAt(20, 20, 0.3, { maxAboveTerrainM: 0.2 })).toBe(0);
  });

  it('teleport stands a player on the highest support (a scaffold) and a ruler only on low ones', async () => {
    const w = await make({ seed: 13, scene: 'empty', nav: 'off' });
    const e = withEntities(w);
    box(w, e, 1, -20, 0, 0.5, 0, 2.65, 'fixed'); // §11.2(c)'s scaffold top
    box(w, e, 2, 10, 10, 1, 0, 0.3, 'fixed');
    w.step();
    const p = w.player!;
    w.teleport(p, -20, 0);
    expect(p.pos.y).toBeCloseTo(2.65, 4); // f32, from a ray 50 m long
    // A ruler (only the flag is read here) never lands on top of an obstacle.
    p.ruler = {} as RulerState;
    try {
      w.teleport(p, -20, 0);
      expect(p.pos.y).toBe(0);
      w.teleport(p, 10, 10);
      expect(p.pos.y).toBeCloseTo(0.3, 6);
    } finally {
      p.ruler = null;
    }
  });

  /**
   * A stand-in for P08's zone body (one kinematic sensor 0.3 m above the player's feet, posed in phase 4b, history
   * reset through the physics world) and P09's grace and pair intake, over a fixed stake (entity 50) at (20, 0).
   */
  function zoneRig(w: World): { graces: [number, number][]; starts: number[]; carry: number[] } {
    const p = w.player!;
    const kin = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.pos.x, p.pos.y + 0.3, p.pos.z));
    const zone = w.physics.rapier.createCollider(
      RAPIER.ColliderDesc.ball(0.2)
        .setSensor(true)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(collisionGroups('ZONE')),
      kin,
    );
    const key = `fighter:${p.id}:zone:shinL`;
    w.physics.register(zone, { kind: 'fighter', id: p.id, part: 'zone', bone: 'shinL' });
    const sb = w.physics.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(20, 1, 0));
    w.physics.register(w.physics.rapier.createCollider(RAPIER.ColliderDesc.cuboid(0.1, 1, 0.1).setCollisionGroups(collisionGroups('ENTITY')), sb), { kind: 'entity', id: 50 });
    w.zones.pose = () => kin.setNextKinematicTranslation({ x: p.pos.x, y: p.pos.y + 0.3, z: p.pos.z });
    w.zones.resetHistory = () => w.physics.resetHistory(key);
    const out = { graces: [] as [number, number][], starts: [] as number[], carry: [] as number[] };
    w.contacts.grace = (id, until) => void out.graces.push([id, until]);
    w.contacts.process = (_w, pairs) => {
      out.carry.push(w.physics.pre(key)!.carryV.x);
      for (const q of pairs) if (q.started && ownerKey(q.a) === 'entity:50' && ownerKey(q.b) === key) out.starts.push(w.tick);
    };
    return out;
  }

  for (const when of ['between steps', 'phase 2', 'phase 15'] as const) {
    it(`teleport ${when}: the zone never reads the jump as a speed and the pair it raises starts inside the grace (RF-1)`, async () => {
      const w = await make({ seed: 14, scene: 'empty', nav: 'off' });
      const p = w.player!;
      const rig = zoneRig(w);
      const jump = () => w.teleport(p, 20, 0);
      if (when === 'phase 2') {
        const sense = w.minds.sense.bind(w.minds);
        w.minds.sense = (ww) => {
          if (w.tick === 4) jump();
          sense(ww);
        };
      } else if (when === 'phase 15') {
        const update = w.deaths.update.bind(w.deaths);
        w.deaths.update = (ww) => {
          if (w.tick === 4) jump();
          update(ww);
        };
      }
      for (let t = 1; t <= 10; t++) {
        if (when === 'between steps' && t === 4) jump();
        w.step();
      }
      // The tick whose phase 4 poses the new place: 4, except after phase 4 of tick 4 (5).
      const poseTick = when === 'phase 15' ? 5 : 4;
      expect(rig.graces).toEqual([[p.id, poseTick + DAMAGE_TUNING.zoneGraceTicks]]);
      expect(rig.starts).toEqual([poseTick + 1]);
      expect(rig.starts[0]).toBeLessThan(rig.graces[0][1]);
      expect(rig.carry).toHaveLength(10);
      for (const c of rig.carry) expect(c).toBe(0);
    });
  }

  it("a KO in a world doesn't throw while sim/impact.ts is P01's placeholder (not environmental, no credit)", async () => {
    const w = await make({ seed: 15, scene: 'empty', nav: 'off' });
    const p = w.player!;
    w.step();
    w.combat.koFighter(p, { by: 'strike', killer: null, cause: null, point: { x: 0, y: 1, z: 0 } });
    expect(p.state).toBe('ko');
    const ko = w.combat.events.find((ev) => ev.type === 'ko');
    expect(ko).toMatchObject({ environmental: false, credit: [] });
    for (let t = 0; t < 5; t++) w.step();
  });

  it('dispose frees the Rapier world once; the world can’t step afterwards', async () => {
    const w = await createWorld({ seed: 11, scene: 'empty', nav: 'off' });
    w.step();
    w.dispose();
    w.dispose();
    expect(w.isDisposed).toBe(true);
    expect(w.physics.isFreed).toBe(true);
    expect(() => w.step()).toThrow(/disposed/);
  });
});
