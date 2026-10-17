// P11, the ruler in CombatSim (docs/M1-DESIGN.md §2.8, §2.9, §4.6; sim/ruler.ts): the melee volumes (DS's 12 spheres,
// knees and elbows at the §2.8 radii), the zone classifier and toughness, rulerDamage (wounds strictly above 240 HP,
// severe strictly above 1,800 HP with the 5 % penalty and an effect by zone, finishing into the wound that put it down,
// D-37's opened wound, unhealed damage, the KO, the `wound` event's byWorld), rulerTick (recovery only when allowed,
// wounds healing oldest first, the down wound clearing), rulerHit (a perfect-counter axe overhead on a knee is 40.65 HP,
// armour bumps the blow off, a thrown weapon's energy through the rule), and RR-24: the best-paced axe rate computed
// from the live move and stamina data stays below recoveryHpPerS (rule 5 rests on it).
//
// Scene numbers (masses, points, HP) are test constants, never tuning (§9).
import { Vector3 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { type BoneName, bonePoint } from '../src/body/skeleton';
import { blowDamage, bodySpheres, type CombatEvent, CombatSim } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import { type Fighter, IdCounter } from '../src/sim/fighter';
import { DT, Rng } from '../src/sim/math';
import { createPlayer } from '../src/sim/roster';
import {
  classifyRulerZone,
  newRulerState,
  RULER_TUNING,
  RULER_ZONE_TUNING,
  rulerDamage,
  type RulerDamageWorld,
  rulerDown,
  rulerEffectiveMax,
  rulerHeld,
  rulerHit,
  rulerHp,
  rulerTick,
  rulerToughness,
  rulerVolumes,
} from '../src/sim/ruler';
import { DAMAGE_TUNING, hpFromEnergy } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { WEAPONS } from '../src/sim/weapons';
import { restoreTuning, tuningSnapshot } from '../src/tuning/registry';
import type { ImpactCause, RulerZoneId, WorldEvent } from '../src/world/types';
import type { World } from '../src/world/world';

const snapshot = tuningSnapshot();
afterEach(() => restoreTuning(snapshot));

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** A legacy CombatSim with a standing giant ape (scale 5.5, 14 t, a fresh RulerState) at the origin, facing +z. */
function giantScene(): { sim: CombatSim; g: Fighter; w: RulerDamageWorld & { events: WorldEvent[] } } {
  const sim = new CombatSim(11);
  const { fighter: g } = createEnemy('bruiser', new Rng(4), {}, {}, { ids: new IdCounter(20) });
  g.scale = SPECIES_BODY.giantApe.scale;
  g.massKg = SPECIES_BODY.giantApe.massKg;
  g.species = 'giantApe';
  g.ruler = newRulerState(SPECIES_BODY.giantApe.maxHp);
  g.autoDefense = false;
  // Rulers have no DS defence (D-13): toughness replaces it.
  g.stats.defense = 0;
  sim.add(g);
  const w = { ids: { wound: new IdCounter(1) }, combat: sim, events: [] as WorldEvent[] };
  return { sim, g, w };
}

const ENTITY: ImpactCause = { kind: 'entity', entityId: 7, fighterId: null, credit: ['p2', 'p1', 'p2'], held: false, feature: 'sharpPoint' };
const HELD_LOG: ImpactCause = { kind: 'entity', entityId: 8, fighterId: 3, credit: ['p1'], held: true, feature: 'falling' };
const TERRAIN: ImpactCause = { kind: 'terrain', entityId: null, fighterId: null, credit: [], held: false, feature: 'fall' };
const near = (got: number, want: number, eps = 1e-9) => expect(Math.abs(got - want)).toBeLessThanOrEqual(eps);

/** A point on `bone` of the standing giant, `out` m along the bone's outward direction `dir` (bone frame) from its joint. */
function pointOn(g: Fighter, bone: BoneName, t: number, dir: [number, number, number], out = 0): Vector3 {
  const p = bonePoint(g.rig, bone, t, new Vector3());
  return p.add(new Vector3(...dir).normalize().multiplyScalar(out).applyQuaternion(g.rig[bone].rot));
}

/** An outward normal in the bone frame. */
const n = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).normalize();

// ---------------------------------------------------------------------------
// Volumes and zones
// ---------------------------------------------------------------------------

describe('volumes (§2.8)', () => {
  it("are DS's 12 bodySpheres, then a knee per leg at the shin's root (0.09 × scale) and an elbow per arm at the forearm's root (0.07 × scale)", () => {
    const { g } = giantScene();
    const v = rulerVolumes(g);
    expect(v.length).toBe(16);
    const ds = bodySpheres(g);
    for (let i = 0; i < 12; i++) {
      expect(v[i].bone).toBe(ds[i].bone);
      expect(v[i].zone).toBe(ds[i].zone);
      expect(v[i].r).toBe(ds[i].r);
      expect(v[i].center.toArray()).toEqual(ds[i].center.toArray());
      expect(v[i].joint).toBeNull();
    }
    const knees = v.filter((x) => x.joint === 'knee');
    const elbows = v.filter((x) => x.joint === 'elbow');
    expect(knees.map((x) => x.bone)).toEqual(['shinL', 'shinR']);
    expect(elbows.map((x) => x.bone)).toEqual(['foreArmL', 'foreArmR']);
    for (const k of knees) {
      near(k.r, 0.495, 1e-12);
      expect(k.zone).toBe('legs');
      expect(k.center.toArray()).toEqual(g.rig[k.bone!].pos.toArray());
      // Knee height in a standing stance (MAP gap-6 §3a: 2.48-2.79 m in DS's brawler build; 2.75 m standing straight).
      expect(k.center.y).toBeGreaterThan(2.0);
      expect(k.center.y).toBeLessThan(2.9);
    }
    for (const e of elbows) {
      near(e.r, 0.385, 1e-12);
      expect(e.center.toArray()).toEqual(g.rig[e.bone!].pos.toArray());
    }
    // The radii are live: a tuned knee radius is used at once.
    RULER_ZONE_TUNING.kneeR = 0.1;
    near(rulerVolumes(g).find((x) => x.joint === 'knee')!.r, 0.55, 1e-12);
  });

  it('classify the named zone by bone, joint distance and the outward normal in the bone frame', () => {
    const { g } = giantScene();
    const at = new Vector3();
    const cases: [BoneName, Vector3, Vector3, RulerZoneId][] = [
      // Knees and elbows by distance from the joint (shin or thigh; forearm or upper arm).
      ['shinL', pointOn(g, 'shinL', 0.05, [0, 0, 1]), n(0, 0, 1), 'knees'],
      ['thighL', pointOn(g, 'thighL', 0.4, [0, 0, 1]), n(0, 0, 1), 'knees'],
      ['shinR', pointOn(g, 'shinR', 0.3, [0, 0, 1], 0.4), n(0, 0, 1), 'leg'],
      ['thighR', pointOn(g, 'thighR', 0.1, [0, 0, 1], 0.5), n(0, 0, 1), 'leg'],
      ['foreArmL', pointOn(g, 'foreArmL', 0.03, [0, 0, 1]), n(0, 0, 1), 'elbows'],
      ['upperArmR', pointOn(g, 'upperArmR', 0.27, [0, 0, 1]), n(0, 0, 1), 'elbows'],
      ['foreArmR', pointOn(g, 'foreArmR', 0.2, [0, 0, 1], 0.3), n(0, 0, 1), 'arm'],
      // The upper arm: above the shoulder joint less its volume radius is the shoulder.
      ['upperArmL', pointOn(g, 'upperArmL', 0, [0, 1, 0], 0.2), n(0, 1, 0), 'shoulders'],
      ['upperArmL', pointOn(g, 'upperArmL', 0.18, [1, 0, 0], 0.3), n(1, 0, 0), 'arm'],
      // The head.
      ['head', at, n(0, 0.1, 1), 'eyes'],
      ['head', at, n(0.5, 0.3, 0.8), 'eyes'],
      ['head', at, n(0, -0.3, 1), 'mouth'],
      ['head', at, n(0, 1, 0), 'skull'],
      ['head', at, n(0.9, 0, 0.4), 'skull'],
      ['head', at, n(0, 0, -1), 'skull'],
      // The torso.
      ['chest', at, n(0, 1, 0.2), 'shoulders'],
      ['chest', at, n(0, 0, -1), 'back'],
      ['chest', at, n(1, 0, 0), 'flanks'],
      ['chest', at, n(0, 0, 1), 'chest'],
      ['abdomen', at, n(0, 0, 1), 'belly'],
      ['abdomen', at, n(0, 0.2, -1), 'back'],
      ['abdomen', at, n(-1, 0, 0.2), 'flanks'],
      ['pelvis', at, n(0, 0, -1), 'back'],
      ['pelvis', at, n(1, 0, 0), 'flanks'],
      ['pelvis', at, n(0, 0, 1), 'pelvis'],
    ];
    for (const [bone, point, normal, want] of cases) expect(classifyRulerZone(g, bone, point, normal), `${bone} → ${want}`).toBe(want);
  });

  it('toughness: soft zones 600 J, skull, back, shoulders and flanks 4,000 J, every unlisted surface the default (D-8)', () => {
    for (const z of ['eyes', 'mouth', 'belly', 'knees', 'elbows'] as const) expect(rulerToughness(z)).toBe(600);
    for (const z of ['skull', 'back', 'shoulders', 'flanks'] as const) expect(rulerToughness(z)).toBe(4000);
    for (const z of ['chest', 'arm', 'leg', 'pelvis'] as const) expect(rulerToughness(z)).toBe(4000);
    RULER_ZONE_TUNING.defaultJ = 3000;
    expect(rulerToughness('leg')).toBe(3000);
    expect(rulerToughness('back')).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Damage, wounds, finishing, recovery
// ---------------------------------------------------------------------------

describe('rulerDamage (§4.6, SPEC:500-506)', () => {
  it('240.0 HP is unhealed damage, anything above it a wound; 1,800 HP is a plain wound, anything above it severe', () => {
    const { g, w } = giantScene();
    const r = g.ruler!;
    const pt = pointOn(g, 'abdomen', 0.1, [0, 0, 1], 0.9);
    expect(rulerDamage(w, g, 240, 'belly', 'abdomen', ENTITY, pt)).toBeNull();
    expect(r.unhealed).toBe(240);
    expect(r.wounds).toEqual([]);
    expect(w.events).toEqual([]);
    const a = rulerDamage(w, g, 240.000001, 'belly', 'abdomen', ENTITY, pt)!;
    expect(a).not.toBeNull();
    expect(a).toMatchObject({ id: 1, zone: 'belly', bone: 'abdomen', severe: false, effect: null, hp: 240.000001, remaining: 240.000001, tick: 0 });
    expect(a.credit).toEqual(['p1', 'p2']);
    expect(a.cause).toEqual(ENTITY);
    expect(a.cause).not.toBe(ENTITY);
    const b = rulerDamage(w, g, 1800, 'belly', 'abdomen', ENTITY, pt)!;
    expect(b.severe).toBe(false);
    expect(rulerEffectiveMax(r)).toBe(12000);
    const c = rulerDamage(w, g, 1800.000001, 'belly', 'abdomen', ENTITY, pt)!;
    expect(c).toMatchObject({ id: 3, severe: true, effect: 'winded' });
    // Each severe wound takes severePenaltyFrac off the maximum (SPEC:506).
    near(rulerEffectiveMax(r), 12000 * 0.95, 1e-9);
    rulerDamage(w, g, 2000, 'skull', 'head', ENTITY, pointOn(g, 'head', 0.13, [0, 1, 0], 0.8));
    near(rulerEffectiveMax(r), 12000 * 0.9, 1e-9);
    near(rulerHp(r), 12000 * 0.9 - 240 - 240.000001 - 1800 - 1800.000001 - 2000, 1e-6);
    // One `wound` event per wound, an unheld entity's: byWorld.
    expect(w.events.map((e) => (e.type === 'wound' ? [e.wound.id, e.byWorld] : null))).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ]);
  });

  it('a severe wound changes behaviour by zone: a leg limps, an eye goes blind on its side, the jaw weakens, the body is winded', () => {
    const { g, w } = giantScene();
    const big = 2000;
    // Each wound healed at once, so a dozen severe ones (5 % off the maximum each) never knock the ruler out.
    const effect = (zone: RulerZoneId, bone: BoneName, p: Vector3) => {
      const wd = rulerDamage(w, g, big, zone, bone, ENTITY, p)!;
      wd.remaining = 0;
      expect(wd.severe).toBe(true);
      return wd.effect;
    };
    expect(effect('knees', 'shinL', g.rig.shinL.pos.clone())).toBe('limp');
    expect(effect('leg', 'thighR', pointOn(g, 'thighR', 0.2, [0, 0, 1], 0.5))).toBe('limp');
    // +x in the head frame is the body's left.
    expect(effect('eyes', 'head', pointOn(g, 'head', 0.15, [0.4, 0.1, 1], 0.8))).toBe('blindL');
    expect(effect('eyes', 'head', pointOn(g, 'head', 0.15, [-0.4, 0.1, 1], 0.8))).toBe('blindR');
    expect(effect('mouth', 'head', pointOn(g, 'head', 0.1, [0, -0.3, 1], 0.8))).toBe('weakJaw');
    expect(effect('skull', 'head', pointOn(g, 'head', 0.2, [0, 1, 0], 0.8))).toBe('weakJaw');
    for (const [zone, bone] of [
      ['back', 'chest'],
      ['shoulders', 'chest'],
      ['flanks', 'abdomen'],
      ['chest', 'chest'],
      ['pelvis', 'pelvis'],
      ['belly', 'abdomen'],
      ['arm', 'foreArmL'],
      ['elbows', 'foreArmR'],
    ] as const) {
      expect(effect(zone, bone, g.rig[bone].pos.clone())).toBe('winded');
    }
  });

  it("records the wound where it is on the bone, in the bone's frame ÷ scale (the scar's place)", () => {
    const { g, w } = giantScene();
    const p = pointOn(g, 'chest', 0.16, [0.3, 0.2, -1], 1.0);
    const wd = rulerDamage(w, g, 500, 'back', 'chest', ENTITY, p)!;
    const want = p.clone().sub(g.rig.chest.pos).applyQuaternion(g.rig.chest.rot.clone().invert()).divideScalar(g.scale);
    near(wd.local.x, want.x, 1e-12);
    near(wd.local.y, want.y, 1e-12);
    near(wd.local.z, want.z, 1e-12);
  });

  it('byWorld: an unheld entity; never a held or thrown one or a creature; the terrain only within envKillWindowS of a world trip', () => {
    const { sim, g, w } = giantScene();
    const r = g.ruler!;
    const pt = g.rig.chest.pos.clone();
    const byWorld = (cause: ImpactCause): boolean => {
      w.events.length = 0;
      rulerDamage(w, g, 300, 'back', 'chest', cause, pt);
      const e = w.events.find((x) => x.type === 'wound');
      return e?.type === 'wound' ? e.byWorld : (null as never);
    };
    expect(byWorld(ENTITY)).toBe(true);
    expect(byWorld(HELD_LOG)).toBe(false);
    expect(byWorld({ kind: 'creature', entityId: null, fighterId: 1, credit: ['p1'], held: true, feature: 'creature' })).toBe(false);
    expect(byWorld(TERRAIN)).toBe(false);
    r.lastWorldTrip = { tick: 100, cause: null };
    for (const [tick, want] of [
      [99, false],
      [100, true],
      [220, true],
      [221, false],
    ] as const) {
      (sim as unknown as { frame: number }).frame = tick;
      expect(byWorld(TERRAIN), `tick ${tick}`).toBe(want);
    }
  });

  it('finishing: while held, damage goes into the wound that put it down; a later wound never moves it; with none, D-37 opens one', () => {
    const { g, w } = giantScene();
    const r = g.ruler!;
    const pt = g.rig.chest.pos.clone();
    // Down with a down wound: a small hit adds to it, recovers nothing.
    const first = rulerDamage(w, g, 300, 'back', 'chest', ENTITY, pt)!;
    g.setState('tripped');
    expect(rulerDown(g) && rulerHeld(g)).toBe(true);
    r.downWound = first.id;
    expect(rulerDamage(w, g, 40, 'knees', 'shinL', { ...HELD_LOG, credit: ['p3'] }, pt)).toBeNull();
    expect(first.hp).toBe(340);
    expect(first.remaining).toBe(340);
    expect(first.credit).toEqual(['p1', 'p2', 'p3']);
    expect(r.unhealed).toBe(0);
    // A new wound while down is its own, and downWound stays.
    const second = rulerDamage(w, g, 500, 'belly', 'abdomen', ENTITY, pt)!;
    expect(second.id).not.toBe(first.id);
    expect(r.downWound).toBe(first.id);
    rulerDamage(w, g, 10, 'eyes', 'head', ENTITY, pt);
    expect(first.hp).toBe(350);
    // None yet: one is opened with the cause that put it down, and becomes the down wound.
    r.downWound = null;
    r.downCause = { ...TERRAIN };
    w.events.length = 0;
    const opened = rulerDamage(w, g, 30, 'knees', 'shinR', HELD_LOG, pt)!;
    expect(opened).toMatchObject({ zone: 'knees', bone: 'shinR', severe: false, effect: null, hp: 30, remaining: 30, cause: TERRAIN });
    expect(opened.credit).toEqual(['p1']);
    expect(r.downWound).toBe(opened.id);
    expect(w.events).toHaveLength(1);
    rulerDamage(w, g, 5, 'knees', 'shinR', HELD_LOG, pt);
    expect(opened.hp).toBe(35);
    // No down cause either: the hit's own cause.
    r.downWound = null;
    r.downCause = null;
    expect(rulerDamage(w, g, 5, 'knees', 'shinR', ENTITY, pt)!.cause).toEqual(ENTITY);
    // Held without being down: pinned, stuck, or in a pit.
    g.setState('idle');
    for (const hold of ['pinned', 'stuck', 'inPit'] as const) {
      r[hold] = true;
      const before = r.unhealed;
      expect(rulerHeld(g)).toBe(true);
      rulerDamage(w, g, 7, 'knees', 'shinR', ENTITY, pt);
      expect(r.unhealed).toBe(before);
      r[hold] = false;
    }
    expect(rulerHeld(g)).toBe(false);
    expect(rulerDown(g)).toBe(false);
    rulerDamage(w, g, 7, 'knees', 'shinR', ENTITY, pt);
    expect(r.unhealed).toBe(7);
  });

  it("held with no down wound, the first wound opened by the down cause's entity becomes it; nobody else's does", () => {
    // An 'obstacle' trip stops the giant short of the log; its legs strike the log only after the trip tick.
    const { g, w } = giantScene();
    const r = g.ruler!;
    const pt = g.rig.shinL.pos.clone();
    // Standing, a wound by that entity is no down wound (nothing put it down).
    r.downCause = { ...ENTITY };
    rulerDamage(w, g, 500, 'knees', 'shinL', ENTITY, pt);
    expect(r.downWound).toBeNull();
    g.setState('tripped');
    // Another entity's wound, or one with no entity, isn't what put it down.
    rulerDamage(w, g, 500, 'knees', 'shinL', { ...ENTITY, entityId: 9 }, pt);
    rulerDamage(w, g, 500, 'knees', 'shinL', TERRAIN, pt);
    expect(r.downWound).toBeNull();
    const byCause = rulerDamage(w, g, 600, 'knees', 'shinL', ENTITY, pt)!;
    expect(r.downWound).toBe(byCause.id);
    // A later wound by the same entity is its own; finishing goes into the first.
    const later = rulerDamage(w, g, 700, 'knees', 'shinL', ENTITY, pt)!;
    expect(later.id).not.toBe(byCause.id);
    expect(r.downWound).toBe(byCause.id);
    rulerDamage(w, g, 20, 'knees', 'shinL', HELD_LOG, pt);
    expect(byCause.hp).toBe(620);
    expect(r.wounds).toHaveLength(5);
  });

  it('knocks the ruler out at 0 HP: by a strike for a creature’s held blow, by impact otherwise, once', () => {
    for (const [cause, by] of [
      [ENTITY, 'impact'],
      [{ kind: 'creature', entityId: null, fighterId: 1, credit: ['p1'], held: true, feature: 'creature' } as ImpactCause, 'strike'],
    ] as const) {
      const { sim, g, w } = giantScene();
      const p = createPlayer({ ids: new IdCounter(1) });
      sim.add(p);
      g.ruler!.unhealed = 11990;
      rulerDamage(w, g, 9.5, 'knees', 'shinL', cause, g.rig.shinL.pos.clone());
      expect(g.state).toBe('idle');
      rulerDamage(w, g, 0.5, 'knees', 'shinL', cause, g.rig.shinL.pos.clone());
      expect(g.state).toBe('ko');
      const kos = sim.events.filter((e): e is Extract<CombatEvent, { type: 'ko' }> => e.type === 'ko');
      expect(kos).toHaveLength(1);
      expect(kos[0].by).toBe(by);
      expect(kos[0].killer).toBe(cause.fighterId === 1 ? p : null);
      // Out: nothing more is recorded.
      expect(rulerDamage(w, g, 500, 'knees', 'shinL', cause, g.rig.shinL.pos.clone())).toBeNull();
      expect(g.ruler!.wounds).toEqual([]);
    }
  });
});

describe('rulerTick (§4.6)', () => {
  it('recovers unhealed damage at 30 HP/s only when the ruler is free: not down, in a pit, stuck, pinned or burning', () => {
    const { g } = giantScene();
    const r = g.ruler!;
    r.unhealed = 45;
    for (let i = 0; i < 60; i++) rulerTick(g, DT);
    near(r.unhealed, 15, 1e-9);
    for (let i = 0; i < 60; i++) rulerTick(g, DT);
    expect(r.unhealed).toBe(0);
    expect(rulerHp(r)).toBe(12000);
    for (const hold of ['tripped', 'inPit', 'stuck', 'pinned', 'burning'] as const) {
      r.unhealed = 10;
      if (hold === 'tripped') g.setState('tripped');
      else r[hold] = true;
      for (let i = 0; i < 60; i++) rulerTick(g, DT);
      expect(r.unhealed, hold).toBe(10);
      if (hold === 'tripped') g.setState('idle');
      else r[hold] = false;
    }
    rulerTick(g, DT);
    near(r.unhealed, 9.5, 1e-12);
    RULER_TUNING.recoveryHpPerS = 60;
    rulerTick(g, DT);
    near(r.unhealed, 8.5, 1e-12);
  });

  it('heals wounds 50 HP per hour of play, oldest first, held or not; never above the effective maximum', () => {
    const { g, w } = giantScene();
    const r = g.ruler!;
    const pt = g.rig.chest.pos.clone();
    const a = rulerDamage(w, g, 260, 'back', 'chest', ENTITY, pt)!;
    const b = rulerDamage(w, g, 2000, 'back', 'chest', ENTITY, pt)!;
    a.remaining = 10;
    rulerTick(g, 720); // 10 HP
    expect(a.remaining).toBe(0);
    expect(b.remaining).toBe(2000);
    g.setState('tripped');
    rulerTick(g, 72); // 1 HP, while down
    near(b.remaining, 1999, 1e-9);
    g.setState('idle');
    rulerTick(g, 3600 * 100);
    expect(b.remaining).toBe(0);
    // The scar stays, and so does its penalty (SPEC:506).
    expect(r.wounds).toHaveLength(2);
    near(rulerHp(r), 12000 * 0.95, 1e-9);
  });

  it('clears the down wound and cause once the ruler is no longer held', () => {
    const { g } = giantScene();
    const r = g.ruler!;
    g.setState('tripped');
    r.downWound = 4;
    r.downCause = { ...ENTITY };
    rulerTick(g, DT);
    expect(r.downWound).toBe(4);
    g.setState('getup');
    r.pinned = true;
    rulerTick(g, DT);
    expect(r.downWound).toBe(4);
    r.pinned = false;
    rulerTick(g, DT);
    expect(r.downWound).toBeNull();
    expect(r.downCause).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rulerHit: the ruler branch of hit()
// ---------------------------------------------------------------------------

/** A player with the two-handed axe in the committed overhead (a perfect counter), its swing at full power. */
function axeman(sim: CombatSim): { p: Fighter; m: NonNullable<Fighter['move']> } {
  const p = createPlayer({ ids: new IdCounter(1) });
  p.playerId = 'p1';
  p.weapon = WEAPONS.axe;
  sim.add(p);
  p.perfectCounter = true;
  p.startMove(p.moveDef('overhead')!, true, 'head');
  p.stateFrame = p.move!.startup;
  return { p, m: p.move! };
}

describe('rulerHit (§4.6)', () => {
  it('a perfect-counter axe overhead on a knee: 1,331.7 J on 600 J, 40.65 HP of unhealed damage; the edge bites in', () => {
    const { sim, g, w } = giantScene();
    const { p, m } = axeman(sim);
    const knee = rulerVolumes(g).find((v) => v.joint === 'knee' && v.bone === 'shinL')!;
    const point = knee.center.clone().add(new Vector3(0, 0.3, 1).normalize().multiplyScalar(knee.r));
    const sf = p.stateFrame;
    sim.events.length = 0;
    rulerHit(sim, w as unknown as World, p, g, m, point, new Vector3(0, 0, 1), 'legs', 'shinL', 1, false, null, null);
    const E = blowDamage(p, g, m, 1, false, null) * DAMAGE_TUNING.meleeJPerDmg;
    expect(Math.abs(E - 1331.7)).toBeLessThan(13.3);
    const hp = hpFromEnergy(E, 600);
    expect(Math.abs(hp - 40.65)).toBeLessThan(0.41);
    expect(g.ruler!.unhealed).toBe(hp);
    expect(g.ruler!.wounds).toEqual([]);
    const hit = sim.events.find((e): e is Extract<CombatEvent, { type: 'hit' }> => e.type === 'hit')!;
    expect(hit).toMatchObject({ attacker: p, defender: g, rulerZone: 'knees', energy: E, toughness: 600, damage: hp, zone: 'legs', bone: 'shinL', knockdown: false, ko: false, counter: true, thrown: false });
    expect(hit.weapon).toBe(WEAPONS.axe);
    expect(sim.events.some((e) => e.type === 'bump')).toBe(false);
    // DS's stick: bite 18 frames, retract 16 (heavy).
    expect(p.stuckUntil).toBe(sf + 18);
    expect(p.attackEnd).toBe(sf + 18 + 16);
    // Nothing of DS's defender side: no hitstun, knockback, poise or stamina loss, no DS cut.
    expect(g.state).toBe('idle');
    expect(g.vel.length()).toBe(0);
    expect(g.wounds).toEqual([]);
    expect(g.poise).toBe(g.stats.maxPoise);
    expect(g.stamina).toBe(1);
  });

  it('a blow that does not beat the zone does no damage, rebounds 3/11 and bumps (SPEC:282); a strike on a lying ruler finishes', () => {
    const { sim, g, w } = giantScene();
    const { p, m } = axeman(sim);
    const shin = rulerVolumes(g).find((v) => v.joint === null && v.bone === 'shinR')!;
    const point = shin.center.clone().add(new Vector3(0, 0, 1).multiplyScalar(shin.r));
    const sf = p.stateFrame;
    sim.events.length = 0;
    rulerHit(sim, w as unknown as World, p, g, m, point, new Vector3(0, 0, 1), 'legs', 'shinR', 1, false, null, null);
    expect(g.ruler!.unhealed).toBe(0);
    const hit = sim.events.find((e): e is Extract<CombatEvent, { type: 'hit' }> => e.type === 'hit')!;
    expect(hit).toMatchObject({ rulerZone: 'leg', toughness: 4000, damage: 0 });
    expect(sim.events.filter((e) => e.type === 'bump')).toHaveLength(1);
    expect(p.stuckUntil).toBe(0);
    expect(p.attackEnd).toBe(sf + 3 + 11);
    // Down: the same knee blow is finishing damage on the down wound, not unhealed.
    const { p: p2, m: m2 } = axeman(sim);
    const wd = rulerDamage(w, g, 400, 'back', 'chest', ENTITY, g.rig.chest.pos.clone())!;
    g.setState('tripped');
    g.ruler!.downWound = wd.id;
    const knee = rulerVolumes(g).find((v) => v.joint === 'knee' && v.bone === 'shinR')!;
    rulerHit(sim, w as unknown as World, p2, g, m2, knee.center.clone().add(new Vector3(0, 0, knee.r)), new Vector3(0, 0, 1), 'legs', 'shinR', 1, false, null, null);
    expect(wd.hp).toBeGreaterThan(440);
    expect(g.ruler!.unhealed).toBe(0);
  });

  it("a thrown weapon's energy comes from the rule (ruleDamageHp × K, computed with no toughness) against the zone's", () => {
    const { sim, g, w } = giantScene();
    const p = createPlayer({ ids: new IdCounter(1) });
    sim.add(p);
    const belly = rulerVolumes(g).find((v) => v.bone === 'abdomen')!;
    // A point on the abdomen's front (+z in its frame): the belly.
    const front = new Vector3(0, 0, 1).applyQuaternion(g.rig.abdomen.rot);
    const point = belly.center.clone().addScaledVector(front, belly.r);
    const E = 2400;
    sim.events.length = 0;
    rulerHit(sim, w as unknown as World, p, g, p.moveDef('jab') ?? p.moves[Object.keys(p.moves)[0]], point, front.clone().negate(), 'abdomen', 'abdomen', 1, false, WEAPONS.axe, E / DAMAGE_TUNING.K);
    const hit = sim.events.find((e): e is Extract<CombatEvent, { type: 'hit' }> => e.type === 'hit')!;
    expect(hit.rulerZone).toBe('belly');
    expect(hit.thrown).toBe(true);
    near(hit.energy!, E, 1e-9);
    near(g.ruler!.unhealed, (E - 600) / DAMAGE_TUNING.K, 1e-9);
  });
});

// ---------------------------------------------------------------------------
// RR-24: rule 5 rests on DS stamina
// ---------------------------------------------------------------------------

describe('rule 5 (RR-24)', () => {
  it('the best-paced axe rate on a knee, from the live move and stamina data, is below recoveryHpPerS', () => {
    const { sim, g } = giantScene();
    // The swing: the overhead as a perfect counter at full stamina (fighter.ts startMove: tempo, cost).
    const p = createPlayer({ ids: new IdCounter(1) });
    p.weapon = WEAPONS.axe;
    sim.add(p);
    p.perfectCounter = true;
    p.startMove(p.moveDef('overhead')!, true, 'head');
    const m = p.move!;
    const cost = 1 - p.stamina;
    expect(cost).toBeGreaterThan(0);
    // Its HP on a knee at full power (combat.ts blowDamage → E → the soft zone).
    const hpPerHit = hpFromEnergy(blowDamage(p, g, m, 1, false, null) * DAMAGE_TUNING.meleeJPerDmg, RULER_ZONE_TUNING.softJ);
    // The landed cycle: full power from the startup frame, then rulerHit's stick (bite) and retract.
    const R = RULER_TUNING;
    const landed = m.startup + Math.max(R.stickMinHold, Math.round(WEAPONS.axe.bite)) + R.stickRetractHeavy;
    // Stamina comes back only while free (none during the swing), at the live regen rate with the axe in hand.
    const q = new CombatSim(5);
    const idle = createPlayer({ ids: new IdCounter(1) });
    idle.weapon = WEAPONS.axe;
    q.add(idle);
    idle.stamina = 0.5;
    const ticks = 60;
    for (let i = 0; i < ticks; i++) q.step();
    expect(idle.free).toBe(true);
    const regenPerTick = (idle.stamina - 0.5) / ticks;
    expect(regenPerTick).toBeGreaterThan(0);
    // Best paced: swing only at full stamina, so each cycle is the landed cycle plus the ticks to earn the cost back.
    const cycle = landed + Math.ceil(cost / regenPerTick);
    const rate = hpPerHit / (cycle * DT);
    // MAP gap-6: 18.77-18.91 HP/s. A change to DS stamina that broke this would let an axe wear a free ruler down.
    expect(rate).toBeGreaterThan(15);
    expect(rate).toBeLessThan(RULER_TUNING.recoveryHpPerS);
    // And without the stamina pacing (every swing fresh) it would not hold: the margin is stamina's.
    expect(hpPerHit / (landed * DT)).toBeGreaterThan(RULER_TUNING.recoveryHpPerS);
  });
});
