// Parts, death and respawn (docs/M1-DESIGN.md §4.14, §3 phase 15; package P09): a creature's KO drops its species'
// parts around the hip in phase 15 (doubled when the kill is environmental, D-30), credited with the KO's credit; an
// ape's corpse goes after corpseDespawnS once no player is within corpseDespawnMinDistM, the giant's stays; the player
// dies, respawns respawnDelayS later at the spawn revived, with belt and back; the records round-trip.
//
// sim/ruler.ts's rule functions are stubbed (a stand-in giant is KO'd here; P11 builds the real one).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { IMPACT_TUNING } from '../src/sim/impact';
import { DT, Rng } from '../src/sim/math';
import { SPECIES_BODY } from '../src/sim/species';
import { restoreTuning, tuningSnapshot } from '../src/tuning/registry';
import { revive } from '../src/world/deaths';
import { spawnLog, spawnStick } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Finish, ImpactCause, RulerState, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { WORLD_TUNING } from '../src/world/worldTuning';

vi.mock('../src/sim/ruler', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/sim/ruler')>();
  return { ...m, rulerTick: vi.fn(), rulerDamage: vi.fn(() => null), rulerVolumes: vi.fn(() => []), rulerHit: vi.fn() };
});

const snapshot = tuningSnapshot();
const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
});
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  restoreTuning(snapshot);
});

async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  const w = await createWorld({ seed: 1, scene: 'empty', nav: 'off', size: 50, ...o });
  live.push(w);
  return w;
}

function addApe(w: World, x: number, z: number): Fighter {
  const ids = w.ids.fighter;
  const { fighter: f } = createEnemy('bruiser', new Rng(3), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  f.scale = SPECIES_BODY.ape.scale;
  f.species = 'ape';
  f.massKg = SPECIES_BODY.ape.massKg;
  f.pos.set(x, w.terrain.heightAt(x, z), z);
  w.addFighter(f, null);
  w.teleport(f, x, z);
  return f;
}

function addFakeGiant(w: World, x: number, z: number): Fighter {
  const ids = w.ids.fighter;
  const { fighter: g } = createEnemy('bruiser', new Rng(4), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
  g.scale = SPECIES_BODY.giantApe.scale;
  g.massKg = SPECIES_BODY.giantApe.massKg;
  g.species = 'giantApe';
  g.ruler = { maxHp: 12000, unhealed: 0, wounds: [], pinned: false, pinnedKg: 0, unpinTicks: 0, stuck: false, burning: false, inPit: false, downWound: null, downCause: null, lastWorldTrip: null, deflectedHeading: null, pendingTrip: null } satisfies RulerState;
  g.pos.set(x, 0, z);
  w.addFighter(g, null);
  return g;
}

function run(w: World, ticks: number): WorldEvent[] {
  const all: WorldEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    w.step();
    all.push(...w.events);
  }
  return all;
}

const strike = (killer: Fighter): Finish => ({
  by: 'strike',
  killer,
  cause: { kind: 'creature', entityId: null, fighterId: killer.id, credit: killer.playerId ? [killer.playerId] : [], held: true, feature: 'creature' },
  point: { x: 0, y: 1, z: 0 },
});
const LOG = (id: number, credit: string[] = []): ImpactCause => ({ kind: 'entity', entityId: id, fighterId: null, credit, held: false, feature: 'falling' });
const partsOf = (ev: readonly WorldEvent[]) => ev.filter((e): e is Extract<WorldEvent, { type: 'parts' }> => e.type === 'parts');

describe('parts (§4.14, D-30)', () => {
  it('a creature KO’d by a strike drops its parts in phase 15 on a ring round the hip, credited with the KO’s credit', async () => {
    const w = await make();
    const p = w.player!;
    const a = addApe(w, 4, 2);
    run(w, 5);
    w.combat.koFighter(a, strike(p));
    expect(w.entities.all()).toHaveLength(0); // nothing yet: phase 15 makes them
    const ev = run(w, 1);
    // The hip phase 15 saw: the corpse slab's (launched in this tick's phase 4a, followed in 13a).
    const hip = w.downed.hip(a.id)!;
    expect(hip).not.toBeNull();
    const parts = partsOf(ev);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ victim: a.id, environmental: false });
    const ents = parts[0].entities.map((id) => w.entities.get(id)!);
    // SPECIES_BODY.ape: one hide, two bones, in list order.
    expect(ents.map((e) => e.material)).toEqual(['hide', 'bone', 'bone']);
    const n = ents.length;
    const r = IMPACT_TUNING.partsRingR * a.scale;
    ents.forEach((e, i) => {
      expect(e.credit).toEqual(['p1']);
      // Created at angle 2πi/n on the ring, partsDropH above the ground (the record keeps the spawn pose until it moves).
      const ang = (2 * Math.PI * i) / n;
      expect(e.prevPose.p.x).toBeCloseTo(hip.x + r * Math.cos(ang), 5);
      expect(e.prevPose.p.z).toBeCloseTo(hip.z + r * Math.sin(ang), 5);
    });
    expect(ents[0].mass).toBeCloseTo(2, 2);
    expect(ents[1].mass).toBeCloseTo(0.5, 2);
    // A second KO call (koFighter refuses it) drops nothing more.
    w.combat.koFighter(a, strike(p));
    expect(partsOf(run(w, 2))).toHaveLength(0);
  });

  it('an environmental kill pays double parts: a log dropped on a weakened ape', async () => {
    const w = await make({ seed: 2 });
    const a = addApe(w, 3, 3);
    run(w, 10);
    a.hp = 1;
    const head = w.zones.zonePose(a, 'head')!.p;
    const id = spawnLog(w, { p: { x: head.x, y: head.y + 1.5, z: head.z }, length: 2, mass: 60 });
    w.entities.get(id)!.credit = ['p1'];
    let ko: unknown;
    const ev: WorldEvent[] = [];
    for (let t = 0; t < 90 && !ko; t++) {
      w.step();
      ev.push(...w.events);
      ko = w.combat.events.find((e) => e.type === 'ko' && e.victim === a);
    }
    expect(ko).toMatchObject({ by: 'impact', environmental: true, credit: ['p1'] });
    ev.push(...run(w, 1));
    const parts = partsOf(ev);
    expect(parts).toHaveLength(1);
    expect(parts[0].environmental).toBe(true);
    expect(parts[0].entities).toHaveLength(3 * IMPACT_TUNING.envKillPartsMul);
    for (const pid of parts[0].entities) expect(w.entities.get(pid)!.credit).toEqual(['p1']);
  });

  it('the giant drops its parts (doubled when environmental) and its corpse stays', async () => {
    const w = await make({ seed: 3, size: 80 });
    const g = addFakeGiant(w, 10, 10);
    run(w, 3);
    w.combat.koFighter(g, { by: 'impact', killer: null, cause: LOG(77), point: { x: 10, y: 1, z: 10 } });
    const parts = partsOf(run(w, 1));
    expect(parts[0].entities).toHaveLength((4 + 6) * IMPACT_TUNING.envKillPartsMul);
    expect(w.deaths.corpsesRecord()).toEqual([]);
    WORLD_TUNING.corpseDespawnS = 0;
    w.teleport(w.player!, -35, -35);
    run(w, 20);
    expect(w.combat.fighters).toContain(g);
  });
});

describe('corpses (§4.14, RR-11)', () => {
  it('an ape’s corpse goes after corpseDespawnS, only once no player is within corpseDespawnMinDistM', async () => {
    const w = await make({ seed: 4, size: 120 });
    const p = w.player!;
    const a = addApe(w, 3, 0);
    run(w, 3);
    w.combat.koFighter(a, strike(p));
    run(w, 1);
    expect(w.deaths.corpsesRecord()).toEqual([{ fighter: a.id, removeTick: w.tick + Math.round(WORLD_TUNING.corpseDespawnS / DT) }]);
    // Shorten the timer (live tuning reaches the next KO; this one keeps its tick): a second ape.
    WORLD_TUNING.corpseDespawnS = 0.5;
    const b = addApe(w, -3, 0);
    run(w, 3);
    w.combat.koFighter(b, strike(p));
    run(w, 60);
    expect(w.combat.fighters).toContain(b); // the player is 3 m away
    w.teleport(p, 50, 30);
    run(w, 3);
    expect(w.combat.fighters).not.toContain(b);
    expect(w.combat.fighters).toContain(a); // its 120 s haven't passed
    expect(w.deaths.corpsesRecord().map((c) => c.fighter)).toEqual([a.id]);
  });
});

describe('the player’s death and respawn (§4.14, SPEC:419-423, D-33)', () => {
  it('death event, then 600 ticks later revived at the spawn with belt and back, controller and zones back, slab off', async () => {
    const w = await make({ seed: 5 });
    const p = w.player!;
    const belt = spawnStick(w, { p: { x: -5, y: 0.1, z: -5 }, length: 0.5, r: 0.02 });
    const back = spawnStick(w, { p: { x: -6, y: 0.1, z: -5 }, length: 1, r: 0.03 });
    p.inventory = { hands: null, belt: [belt, null, null], back };
    w.teleport(p, 10, 5);
    run(w, 10);
    const a = addApe(w, 12, 5);
    p.severed.add('foreArmL');
    p.torn.add('earL');
    p.limbDamage.foreArmL = 30;
    p.wounds.push({ bone: 'chest', local: [0, 0, 0], angle: 0, length: 0.1, bleed: 1, floor: 0.4 });
    w.combat.koFighter(p, strike(a));
    const ev = run(w, 1);
    const death = ev.find((e): e is Extract<WorldEvent, { type: 'death' }> => e.type === 'death');
    expect(death).toBeDefined();
    expect(death!.f).toBe(p);
    expect(death!.respawnTick).toBe(w.tick + Math.round(WORLD_TUNING.respawnDelayS / DT));
    expect(death!.respawnTick - w.tick).toBe(600);
    expect(w.deaths.deathsRecord()).toEqual([{ fighter: p.id, respawnTick: death!.respawnTick }]);
    expect(partsOf(ev)).toHaveLength(0); // a player drops no parts
    let respawn: Extract<WorldEvent, { type: 'respawn' }> | undefined;
    while (!respawn && w.tick < death!.respawnTick + 5) {
      w.step();
      expect(p.state === 'ko').toBe(w.tick < death!.respawnTick);
      respawn = w.events.find((e): e is Extract<WorldEvent, { type: 'respawn' }> => e.type === 'respawn');
    }
    expect(respawn).toBeDefined();
    expect(w.tick).toBe(death!.respawnTick);
    expect(respawn!.f).toBe(p);
    expect(respawn!.at.x).toBeCloseTo(WORLD_TUNING.spawnX, 6);
    expect(respawn!.at.z).toBeCloseTo(WORLD_TUNING.spawnZ, 6);
    expect(p.hp).toBe(p.stats.maxHp);
    expect(p.stamina).toBe(1);
    expect(p.severed.size).toBe(0);
    expect(p.torn.size).toBe(0);
    expect(p.wounds).toHaveLength(0);
    expect(p.limbDamage).toEqual({});
    expect(p.inventory).toEqual({ hands: null, belt: [belt, null, null], back });
    expect(w.deaths.deathsRecord()).toEqual([]);
    run(w, 5);
    expect(w.downed.active(p)).toBe(false);
    expect(w.kcc.isEnabled(p)).toBe(true);
    expect(w.zones.enabled(p)).toBe(true);
    expect(p.pos.x).toBeCloseTo(WORLD_TUNING.spawnX, 4);
    expect(p.pos.z).toBeCloseTo(WORLD_TUNING.spawnZ, 4);
    expect(p.pos.y).toBeCloseTo(w.terrain.heightAt(p.pos.x, p.pos.z), 2);
    expect(['idle', 'walk']).toContain(p.state);
  });

  it('a player revived some other way before the respawn tick isn’t respawned again', async () => {
    const w = await make({ seed: 6 });
    const p = w.player!;
    const a = addApe(w, 2, 2);
    run(w, 3);
    w.combat.koFighter(p, strike(a));
    run(w, 1);
    expect(w.deaths.deathsRecord()).toHaveLength(1);
    revive(p);
    run(w, 1);
    expect(w.deaths.deathsRecord()).toEqual([]);
  });
});

describe('Deaths records', () => {
  it('round-trip the respawn and corpse timers; a restored respawn still happens at its tick', async () => {
    const w = await make({ seed: 7 });
    const p = w.player!;
    const a = addApe(w, 3, 0);
    const b = addApe(w, -3, 0);
    run(w, 3);
    w.combat.koFighter(b, strike(p));
    w.combat.koFighter(p, strike(a));
    run(w, 1);
    const deaths = w.deaths.deathsRecord();
    const corpses = w.deaths.corpsesRecord();
    expect(deaths).toHaveLength(1);
    expect(corpses).toEqual([{ fighter: b.id, removeTick: expect.any(Number) }]);
    w.deaths.restoreRecord([], []);
    expect(w.deaths.deathsRecord()).toEqual([]);
    w.deaths.restoreRecord(JSON.parse(JSON.stringify(deaths)), JSON.parse(JSON.stringify(corpses)));
    expect(w.deaths.deathsRecord()).toEqual(deaths);
    expect(w.deaths.corpsesRecord()).toEqual(corpses);
    let respawned = false;
    while (w.tick < deaths[0].respawnTick + 2 && !respawned) {
      w.step();
      respawned = w.events.some((e) => e.type === 'respawn');
    }
    expect(respawned).toBe(true);
    expect(w.tick).toBe(deaths[0].respawnTick);
  });
});
