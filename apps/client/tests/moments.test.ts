// Moments from a tick's events (docs/M1-DESIGN.md §10.3, package P36): which sim events deserve a kill cam, read with
// synthetic events. An environmental `ko` is an envKill; a `byWorld` wound a worldWound (a terrain wound right after a
// world trip too); a ruler's `ko` a rulerDeath; a ruler flinging or killing the player a playerByRuler; the player's other
// deaths a playerDeath; a crown split a skullSplit. One death or fling makes one moment, in event order.
//
// Fighter positions, ticks, HP and wound numbers here are test constants, never tuning (§9).
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  type CombatEvent,
  createPlayer,
  DT,
  type Fighter,
  IMPACT_TUNING,
  type ImpactCause,
  type RulerState,
  type StepResult,
  type WorldEvent,
  type WoundRecord,
} from '@wild/sim';
import { MomentBuilder, type MomentWorld, woundPoint } from '../src/game/moments';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TICK = 1000;

function scene() {
  const player = createPlayer();
  player.playerId = 'p1';
  player.pos.set(0, 0, 0);
  const ape = createPlayer();
  ape.name = 'Ape';
  ape.pos.set(2, 0, 0);
  const giant = createPlayer();
  giant.name = 'Giant Ape';
  giant.scale = 5.5;
  giant.pos.set(0, 0, 12);
  giant.ruler = { maxHp: 12000, unhealed: 0, wounds: [] } as unknown as RulerState;
  const world: MomentWorld = { tick: TICK, combat: { fighters: [player, ape, giant] } };
  return { player, ape, giant, world, moments: new MomentBuilder(world) };
}

const step = (combat: CombatEvent[], world: WorldEvent[] = []): StepResult => ({ combat, world, save: null });

const cause = (o: Partial<ImpactCause> = {}): ImpactCause => ({ kind: 'entity', entityId: 42, fighterId: null, credit: ['p1'], held: false, feature: 'falling', ...o });

function ko(victim: Fighter, o: Partial<Extract<CombatEvent, { type: 'ko' }>> = {}): CombatEvent {
  return { type: 'ko', victim, by: 'impact', killer: null, cause: cause(), environmental: false, credit: [], point: victim.pos.clone().setY(1), ...o };
}

function impact(defender: Fighter, o: Partial<Extract<WorldEvent, { type: 'impact' }>> = {}): WorldEvent {
  return {
    type: 'impact',
    tick: TICK,
    defender,
    point: { x: defender.pos.x, y: 1, z: defender.pos.z },
    normal: { x: -1, y: 0, z: 0 },
    dir: { x: 1, y: 0, z: 0 },
    zone: 'chest',
    bone: 'chest',
    rulerZone: null,
    energy: 900,
    toughness: 0,
    damage: 30,
    dv: { x: 0, y: 0, z: 0 },
    knockdown: false,
    launched: false,
    ko: false,
    corpse: false,
    weight: 'heavy',
    impulse: 0,
    lift: 0,
    hitstop: 0,
    shake: 0,
    cause: cause(),
    wound: null,
    ...o,
  };
}

function hit(attacker: Fighter, defender: Fighter, o: Partial<Extract<CombatEvent, { type: 'hit' }>> = {}): CombatEvent {
  return {
    type: 'hit',
    attacker,
    defender,
    point: defender.pos.clone().setY(1.7),
    dir: new Vector3(0, -1, 0),
    damage: 20,
    knockdown: false,
    ko: false,
    sever: null,
    fatal: null,
    tear: null,
    ...o,
  } as Extract<CombatEvent, { type: 'hit' }>;
}

function wound(o: Partial<WoundRecord> = {}): WoundRecord {
  return {
    id: 7,
    zone: 'knees',
    bone: 'shinL',
    local: { x: 0, y: 0.02, z: 0.05 },
    severe: false,
    effect: null,
    hp: 600,
    remaining: 600,
    cause: cause({ entityId: 31, feature: 'sharpPoint' }),
    tick: TICK,
    credit: ['p1'],
    ...o,
  };
}

const knockedBy = (f: Fighter, by: Fighter, tick: number) => {
  f.lastKnock = { tick, cause: cause({ kind: 'creature', entityId: null, fighterId: by.id, held: true, feature: 'creature' }), by: by.id };
};

// ---------------------------------------------------------------------------

describe('moments from events (§10.3)', () => {
  it("an environmental ko of a creature is an envKill, pointed along the impact that did it", () => {
    const { ape, moments } = scene();
    const out = moments.fromStep(step([ko(ape, { environmental: true })], [impact(ape, { ko: true, dir: { x: 0, y: 0, z: -1 } })]));
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.kind).toBe('envKill');
    expect(m.subject).toBe(ape);
    expect(m.tick).toBe(TICK);
    expect(m.causeEntity).toBe(42);
    expect(m.severity).toBe(1);
    expect(m.dir.toArray()).toEqual([0, 0, -1]);
    expect(m.point.distanceTo(new Vector3(2, 1, 0))).toBeLessThan(1e-9);
  });

  it("a creature's ko that isn't environmental is no moment", () => {
    const { ape, player, moments } = scene();
    expect(moments.fromStep(step([ko(ape, { by: 'strike', killer: player, cause: null })]))).toEqual([]);
  });

  it('a wound by the world on a ruler is a worldWound at the impact that opened it; a wound by a blow is none', () => {
    const { giant, moments } = scene();
    const w = wound();
    const out = moments.fromStep(step([], [impact(giant, { wound: w, point: { x: 0.4, y: 2.6, z: 11 }, dir: { x: 0, y: -0.6, z: 0.8 } }), { type: 'wound', ruler: giant, wound: w, byWorld: true }]));
    expect(out.map((m) => m.kind)).toEqual(['worldWound']);
    expect(out[0].subject).toBe(giant);
    expect(out[0].point.toArray()).toEqual([0.4, 2.6, 11]);
    expect(out[0].dir.length()).toBeCloseTo(1, 9);
    expect(out[0].causeEntity).toBe(31);
    expect(out[0].severity).toBeCloseTo(600 / 12000, 12);
    expect(moments.fromStep(step([], [{ type: 'wound', ruler: giant, wound: wound({ id: 8 }), byWorld: false }]))).toEqual([]);
  });

  it('a terrain wound right after a world trip (byWorld) is a worldWound where the wound is on the bone', () => {
    const { giant, moments } = scene();
    const w = wound({ id: 9, zone: 'skull', bone: 'head', local: { x: 0, y: 0.2, z: 0.1 }, cause: cause({ kind: 'terrain', entityId: null, feature: 'fall' }) });
    const out = moments.fromStep(step([], [{ type: 'wound', ruler: giant, wound: w, byWorld: true }]));
    expect(out.map((m) => m.kind)).toEqual(['worldWound']);
    expect(out[0].causeEntity).toBeNull();
    expect(out[0].point.distanceTo(woundPoint(giant, 'head', w.local))).toBeLessThan(1e-9);
    // On the bone at the subject's scale: as far from the head's joint as `local` × 5.5.
    expect(out[0].point.distanceTo(giant.rig.head.pos)).toBeCloseTo(Math.hypot(0.2, 0.1) * 5.5, 9);
  });

  it("a ruler's ko is a rulerDeath, never an envKill", () => {
    const { giant, moments } = scene();
    const out = moments.fromStep(step([ko(giant, { environmental: true })]));
    expect(out.map((m) => m.kind)).toEqual(['rulerDeath']);
    expect(out[0].subject).toBe(giant);
  });

  it('a ruler launching the player (its body, a world impact) is a playerByRuler, and the launch that follows is the same fling', () => {
    const { player, giant, moments } = scene();
    const body = cause({ kind: 'creature', entityId: null, fighterId: giant.id, credit: [], held: false, feature: 'creature' });
    const fling = impact(player, { launched: true, knockdown: true, dv: { x: 0, y: 3, z: -8 }, damage: 25, cause: body });
    const out = moments.fromStep(step([], [fling]));
    expect(out.map((m) => m.kind)).toEqual(['playerByRuler']);
    expect(out[0].subject).toBe(player);
    expect(out[0].dir.toArray().map((x) => Math.round(x * 1e6) / 1e6)).toEqual(new Vector3(0, 3, -8).normalize().toArray().map((x) => Math.round(x * 1e6) / 1e6));
    expect(out[0].severity).toBeCloseTo(25 / 100, 12);
    // Next tick's phase 4a launches the slab: the same fling, no second moment.
    knockedBy(player, giant, TICK);
    expect(moments.fromStep(step([], [{ type: 'launch', f: player, vel: { x: 0, y: 3, z: -8 }, angVel: { x: 0, y: 0, z: 0 } }]))).toEqual([]);
    // An impact that doesn't launch, or comes from an ape's body, is none.
    expect(moments.fromStep(step([], [impact(player, { cause: body })]))).toEqual([]);
    const { ape } = scene();
    const apeWorld = new MomentBuilder({ tick: TICK, combat: { fighters: [player, ape, giant] } });
    const apeBody = cause({ kind: 'creature', entityId: null, fighterId: ape.id, credit: [], held: false, feature: 'creature' });
    expect(apeWorld.fromStep(step([], [impact(player, { launched: true, dv: { x: 4, y: 1, z: 0 }, cause: apeBody })]))).toEqual([]);
  });

  it("a ruler's swat that knocks the player flying is a playerByRuler; an ape's isn't", () => {
    const { player, ape, giant, moments } = scene();
    knockedBy(player, giant, TICK);
    const out = moments.fromStep(step([hit(giant, player, { knockdown: true, damage: 40 })], [{ type: 'launch', f: player, vel: { x: 6, y: 2, z: 0 }, angVel: { x: 0, y: 0, z: 0 } }]));
    expect(out.map((m) => m.kind)).toEqual(['playerByRuler']);
    expect(out[0].dir.x).toBeGreaterThan(0.9);
    expect(out[0].severity).toBeCloseTo(0.4, 12);
    knockedBy(player, ape, TICK + 300);
    const later = new MomentBuilder({ tick: TICK + 300, combat: { fighters: [player, ape, giant] } });
    expect(later.fromStep(step([hit(ape, player, { knockdown: true })], [{ type: 'launch', f: player, vel: { x: 2, y: 1, z: 0 }, angVel: { x: 0, y: 0, z: 0 } }]))).toEqual([]);
  });

  it("the player killed by a ruler is a playerByRuler: its blow, or a fall after its knock within the window; else a playerDeath", () => {
    const { player, ape, giant, world } = scene();
    // Killed by its blow (the ko's killer).
    expect(new MomentBuilder(world).fromStep(step([ko(player, { by: 'strike', killer: giant, cause: null })])).map((m) => m.kind)).toEqual(['playerByRuler']);
    // Flung, then killed by the landing (terrain) within IMPACT_TUNING.envKillWindowS of the ruler's knock.
    const W = Math.round(IMPACT_TUNING.envKillWindowS / DT);
    knockedBy(player, giant, TICK - W);
    const fall = ko(player, { cause: cause({ kind: 'terrain', entityId: null, feature: 'fall' }) });
    expect(new MomentBuilder(world).fromStep(step([fall])).map((m) => m.kind)).toEqual(['playerByRuler']);
    // …a knock longer ago than that is just a death.
    knockedBy(player, giant, TICK - W - 1);
    expect(new MomentBuilder(world).fromStep(step([fall])).map((m) => m.kind)).toEqual(['playerDeath']);
    // Killed by an ape.
    knockedBy(player, ape, TICK);
    expect(new MomentBuilder(world).fromStep(step([ko(player, { by: 'strike', killer: ape, cause: null })])).map((m) => m.kind)).toEqual(['playerDeath']);
  });

  it("the player's other deaths are a playerDeath: one per death (ko and death together), the world's too, never an envKill", () => {
    const { player, moments } = scene();
    player.lastKnock = null;
    const out = moments.fromStep(step([ko(player, { environmental: true })], [{ type: 'death', f: player, respawnTick: TICK + 600 }]));
    expect(out.map((m) => m.kind)).toEqual(['playerDeath']);
    expect(out[0].subject).toBe(player);
    // A death event with no ko in its tick still makes the death's moment.
    expect(moments.fromStep(step([], [{ type: 'death', f: player, respawnTick: TICK + 600 }])).map((m) => m.kind)).toEqual(['playerDeath']);
  });

  it('a crown split, cleft or crushed is a skullSplit; a severed head or a plain blow is none', () => {
    const { player, ape, moments } = scene();
    for (const fatal of ['split', 'cleft', 'crush'] as const) {
      const out = moments.fromStep(step([hit(player, ape, { fatal })]));
      expect(out.map((m) => m.kind)).toEqual(['skullSplit']);
      expect(out[0].subject).toBe(ape);
      expect(out[0].point.y).toBeCloseTo(1.7, 12);
    }
    expect(moments.fromStep(step([hit(player, ape, { fatal: 'split', sever: 'head' })]))).toEqual([]);
    expect(moments.fromStep(step([hit(player, ape)]))).toEqual([]);
  });

  it('keeps event order: combat events first, then world events, as the sim lists them', () => {
    const { player, ape, giant, moments } = scene();
    const w = wound({ id: 11 });
    const out = moments.fromStep(
      step([hit(player, ape, { fatal: 'split' }), ko(ape, { environmental: true }), ko(giant)], [{ type: 'wound', ruler: giant, wound: w, byWorld: true }]),
    );
    expect(out.map((m) => m.kind)).toEqual(['skullSplit', 'envKill', 'rulerDeath', 'worldWound']);
  });

  it("given only the world's tick (P31's main.ts), a ruler's body impact names nobody, but its own blows still count", () => {
    const { player, giant } = scene();
    const legacy = new MomentBuilder(() => TICK);
    const body = cause({ kind: 'creature', entityId: null, fighterId: giant.id, held: false, feature: 'creature' });
    expect(legacy.fromStep(step([], [impact(player, { launched: true, dv: { x: 5, y: 2, z: 0 }, cause: body })]))).toEqual([]);
    expect(legacy.fromStep(step([ko(player, { by: 'strike', killer: giant, cause: null })])).map((m) => m.kind)).toEqual(['playerByRuler']);
    expect(legacy.fromStep(step([ko(player)]))[0].tick).toBe(TICK);
  });
});
