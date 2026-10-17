// applyImpact (docs/M1-DESIGN.md §4.4, §2.10, §2.13; package P09): a world hit through the one damage rule becomes HP,
// Δv, a standing push, hitstun, a knockdown, a launch or a press, lastKnock, a KO by 'impact' (once), and an `impact`
// event with DungeonStyle's presentation hints; a downed or KO'd body takes Δv on its slab, never hitstun; a ruler takes
// the HP through its own rule and no Δv; a hard landing (world/characters.ts) now goes through it for real.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CombatSim, type CombatEvent } from '../src/sim/combat';
import { type Fighter, IdCounter, KNOCKDOWN_FRAMES } from '../src/sim/fighter';
import { applyImpact, freeDv, IMPACT_TUNING, impactReaction, impactWeight } from '../src/sim/impact';
import { createPlayer } from '../src/sim/roster';
import { DAMAGE_TUNING } from '../src/sim/rules';
import { restoreTuning, tuningSnapshot } from '../src/tuning/registry';
import { spawnBox } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import type { Impact, ImpactCause, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';

const snapshot = tuningSnapshot();
const live: World[] = [];
beforeAll(async () => {
  await physicsReady();
});
afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  restoreTuning(snapshot);
  vi.restoreAllMocks();
});

async function world(seed = 1): Promise<World> {
  const w = await createWorld({ seed, scene: 'empty', nav: 'off', size: 50 });
  live.push(w);
  return w;
}

function legacy(): { sim: CombatSim; p: Fighter } {
  const sim = new CombatSim(5);
  const p = createPlayer({ ids: new IdCounter(1) });
  p.species = 'human';
  sim.add(p);
  return { sim, p };
}

const LOG: ImpactCause = { kind: 'entity', entityId: 9, fighterId: null, credit: ['p1'], held: false, feature: 'falling' };

function impact(target: Fighter, o: Partial<Impact> = {}): Impact {
  return {
    target,
    bone: 'chest',
    zone: 'chest',
    rulerZone: null,
    point: { x: target.pos.x, y: target.pos.y + 1.3, z: target.pos.z },
    normal: { x: -1, y: 0, z: 0 },
    mEff: 14,
    vn: 4,
    sharpness: 0,
    energy: 0,
    toughness: 0,
    dv: { x: 0, y: 0, z: 0 },
    impactorMass: 40,
    cause: LOG,
    ...o,
  };
}

const impacts = (w: World): Extract<WorldEvent, { type: 'impact' }>[] => w.events.filter((e): e is Extract<WorldEvent, { type: 'impact' }> => e.type === 'impact');
const kos = (events: readonly CombatEvent[]) => events.filter((e): e is Extract<CombatEvent, { type: 'ko' }> => e.type === 'ko');

describe('applyImpact on a standing fighter (§4.4)', () => {
  it('HP by the rule, hitstun for hp > 0, the DS slide from Δv, lastKnock, and the reaction −M·Δv', () => {
    const { sim, p } = legacy();
    sim.frame = 77;
    const dv = { x: 1.2, y: -0.3, z: 0.4 };
    const r = applyImpact(sim, impact(p, { energy: 180, dv }));
    expect(r.damage).toBeCloseTo(10, 12);
    expect(p.hp).toBeCloseTo(90, 12);
    expect(p.state).toBe('hitstun');
    expect(p.stunFrames).toBe(Math.round(IMPACT_TUNING.hitstunBase + IMPACT_TUNING.hitstunPerHp * 10));
    expect(p.hitReaction).toBe('hitBody');
    expect(p.vel.x).toBeCloseTo(1.2, 12);
    expect(p.vel.y).toBe(0);
    expect(p.vel.z).toBeCloseTo(0.4, 12);
    expect(p.lastKnock).toEqual({ tick: 77, cause: LOG, by: null });
    expect(r).toMatchObject({ knockdown: false, launched: false, ko: false, wound: null });
    expect(r.reaction).toEqual({ x: -p.mass * 1.2, y: p.mass * 0.3, z: -p.mass * 0.4 });
  });

  it('toughness first: an armoured zone takes E − T; minHp holds', () => {
    const { sim, p } = legacy();
    p.minHp = 95;
    const r = applyImpact(sim, impact(p, { energy: 400, toughness: 40 }));
    expect(r.damage).toBeCloseTo(20, 12);
    expect(p.hp).toBe(95);
  });

  it('417 J blunt knocks down at the poise edge; 416 J is hitstun; a sharp 417 J is hitstun (no blunt multiplier)', () => {
    for (const [E, s, down] of [
      [417, 0, true],
      [416, 0, false],
      [417, 0.5, false],
    ] as const) {
      const { sim, p } = legacy();
      expect(p.poise).toBe(100);
      const r = applyImpact(sim, impact(p, { energy: E, sharpness: s }));
      expect(r.knockdown).toBe(down);
      expect(p.state).toBe(down ? 'knockdown' : 'hitstun');
      expect(p.poise).toBeCloseTo(100 - 3.2 * (E / 18) * (s === 0 ? 1.35 : 1), 9);
    }
  });

  it('a brush (no HP, |Δv| under flinchDv) moves nobody into hitstun; a flinch-sized Δv does', () => {
    const { sim, p } = legacy();
    applyImpact(sim, impact(p, { energy: 0, dv: { x: 0.3, y: 0, z: 0 } }));
    expect(p.state).toBe('idle');
    expect(p.vel.x).toBeCloseTo(0.3, 12);
    applyImpact(sim, impact(p, { energy: 0, dv: { x: IMPACT_TUNING.flinchDv, y: 0, z: 0 } }));
    expect(p.state).toBe('hitstun');
  });

  it('launched: the free part of Δv ≥ launchDv knocks down and the slab takes the whole Δv in the next phase 4a', async () => {
    const w = await world();
    const p = w.player!;
    for (let t = 0; t < 5; t++) w.step();
    const dv = { x: 6, y: 1, z: 0 };
    expect(freeDv(dv)).toBeGreaterThanOrEqual(IMPACT_TUNING.launchDv);
    const r = applyImpact(w.combat, impact(p, { energy: 50, dv }));
    expect(r).toMatchObject({ knockdown: true, launched: true });
    expect(p.state).toBe('knockdown');
    expect(p.vel.x).toBe(0); // not slid: the slab carries it
    w.step();
    expect(w.downed.active(p)).toBe(true);
    const launch = w.events.find((e) => e.type === 'launch') as Extract<WorldEvent, { type: 'launch' }>;
    expect(launch.vel.x).toBeCloseTo(6, 4);
    expect(launch.vel.y).toBeCloseTo(1, 4);
  });

  it('pressed: Δv down by launchDv or more knocks down without a launch', async () => {
    const w = await world();
    const p = w.player!;
    w.step();
    const r = applyImpact(w.combat, impact(p, { energy: 30, dv: { x: 0.5, y: -6, z: 0 } }));
    expect(r).toMatchObject({ knockdown: true, launched: false });
    expect(p.state).toBe('knockdown');
    w.step();
    const launch = w.events.find((e) => e.type === 'launch') as Extract<WorldEvent, { type: 'launch' }>;
    expect(launch.vel.y).toBeCloseTo(-6, 4);
  });

  it('airborne (the controller in the air) a reacting impact knocks down', async () => {
    const w = await world();
    const p = w.player!;
    for (let t = 0; t < 3; t++) w.step();
    vi.spyOn(w.kcc, 'grounded').mockReturnValue(false);
    const r = applyImpact(w.combat, impact(p, { energy: 36 }));
    expect(r.knockdown).toBe(true);
  });

  it('a ruler takes the HP through rulerDamage (§4.6), no Δv, no lastKnock', async () => {
    const ruler = await import('../src/sim/ruler');
    const wound = { id: 1 } as never;
    const spy = vi.spyOn(ruler, 'rulerDamage').mockReturnValue(wound);
    const w = await world();
    const g = createPlayer({ ids: w.ids.fighter });
    g.ruler = {} as never;
    const r = applyImpact(w.combat, impact(g, { energy: 4600, toughness: 4000, rulerZone: 'chest', dv: { x: 0, y: 0, z: 0 } }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toBeCloseTo(600 / 18, 9);
    expect(spy.mock.calls[0][3]).toBe('chest');
    expect(r.wound).toBe(wound);
    expect(r.damage).toBeCloseTo(600 / 18, 9);
    expect(g.hp).toBe(100); // a ruler's HP is its RulerState's
    expect(g.lastKnock).toBeNull();
  });
});

describe('applyImpact on a downed or KO’d body (§4.4)', () => {
  it('already down: HP applies, never hitstun, Δv goes to the slab; a second launch restarts the knockdown', async () => {
    const w = await world();
    const p = w.player!;
    w.step();
    p.enterKnockdown();
    for (let t = 0; t < 20; t++) w.step();
    expect(w.downed.active(p)).toBe(true);
    expect(p.stateFrame).toBeGreaterThan(10);
    const queue = vi.spyOn(w.downed, 'queueDv');
    const r = applyImpact(w.combat, impact(p, { energy: 90, dv: { x: 1, y: 0, z: 0 } }));
    expect(p.hp).toBeCloseTo(95, 9);
    expect(p.state).toBe('knockdown');
    expect(r).toMatchObject({ knockdown: false, launched: false });
    expect(queue).toHaveBeenCalledWith(p, { x: 1, y: 0, z: 0 });
    expect(r.reaction.x).toBeCloseTo(-p.mass, 9);
    const r2 = applyImpact(w.combat, impact(p, { energy: 0, dv: { x: 7, y: 0, z: 0 } }));
    expect(r2.launched).toBe(true);
    expect(p.stateFrame).toBe(0);
    expect(p.stunFrames).toBe(KNOCKDOWN_FRAMES);
    // A solid pair's impact (Δv 0) changes nothing but HP.
    queue.mockClear();
    applyImpact(w.combat, impact(p, { energy: 18 }));
    expect(queue).not.toHaveBeenCalled();
  });

  it('a fatal impact KOs once (by impact, environmental for an unheld entity); a later one is a corpse impact', async () => {
    const w = await world();
    const p = w.player!;
    w.step();
    p.hp = 5;
    const ce = w.combat.events;
    ce.length = 0;
    w.events.length = 0;
    const r = applyImpact(w.combat, impact(p, { energy: 180, dv: { x: 0, y: -2, z: 0 } }));
    expect(r.ko).toBe(true);
    expect(p.hp).toBe(0);
    expect(p.state).toBe('ko');
    const ko = kos(ce);
    expect(ko).toHaveLength(1);
    expect(ko[0]).toMatchObject({ victim: p, by: 'impact', environmental: true, credit: ['p1'], cause: LOG, killer: null });
    expect(impacts(w)[0]).toMatchObject({ ko: true, corpse: false, damage: 10 });
    const again = applyImpact(w.combat, impact(p, { energy: 900, dv: { x: 3, y: 0, z: 0 } }));
    expect(again).toMatchObject({ damage: 0, ko: false });
    expect(p.hp).toBe(0);
    expect(kos(ce)).toHaveLength(1);
    expect(impacts(w)[1]).toMatchObject({ corpse: true, damage: 0 });
    expect(again.reaction.x).toBeCloseTo(-3 * p.mass, 9);
  });

  it('a creature’s body or a held object killing is not environmental, and names its killer', async () => {
    const w = await world();
    const p = w.player!;
    const other = createPlayer({ ids: w.ids.fighter });
    w.addFighter(other, null);
    w.step();
    p.hp = 1;
    w.combat.events.length = 0;
    applyImpact(w.combat, impact(p, { energy: 90, cause: { kind: 'creature', entityId: null, fighterId: other.id, credit: [], held: false, feature: 'creature' } }));
    expect(kos(w.combat.events)[0]).toMatchObject({ by: 'impact', environmental: false, killer: other });
  });
});

describe('the impact event (§2.13)', () => {
  it('carries the rule’s numbers, the outcome and DS’s presentation hints', async () => {
    const w = await world();
    const p = w.player!;
    w.step();
    w.events.length = 0;
    applyImpact(w.combat, impact(p, { energy: 18 * 13, dv: { x: 0, y: 0, z: 2 }, mEff: 10, vn: 7 }));
    const e = impacts(w)[0];
    expect(e).toMatchObject({ tick: w.tick, defender: p, zone: 'chest', bone: 'chest', damage: 13, energy: 234, toughness: 0, weight: 'heavy' });
    expect(e.dir).toEqual({ x: 0, y: 0, z: 1 });
    expect(e.hitstop).toBe(Math.round(4 + Math.min(8, 13 / 3)));
    expect(e.shake).toBeCloseTo(Math.min(0.5, 0.08 + 13 / 50), 12);
    expect(e.impulse).toBeCloseTo(Math.min(60, 70 * 0.25), 12);
    expect(e.cause).toBe(LOG);
    // Without Δv the blow goes into the target, against the normal.
    applyImpact(w.combat, impact(p, { energy: 18 }));
    expect(impacts(w)[1].dir).toEqual({ x: 1, y: -0, z: -0 });
  });

  it('weight classes and reactions follow DS’s projectileStrike thresholds', () => {
    expect(impactWeight(5)).toBe('light');
    expect(impactWeight(5.01)).toBe('medium');
    expect(impactWeight(12.01)).toBe('heavy');
    expect(impactReaction('legs', 'heavy')).toBe('hitLow');
    expect(impactReaction('abdomen', 'light')).toBe('hitBody');
    expect(impactReaction('head', 'heavy')).toBe('stagger');
    expect(impactReaction('head', 'medium')).toBe('hitHigh');
  });
});

describe('hard landings go through the rule (§4.2, world/characters.ts)', () => {
  it('an 8 m fall: the shin takes E − ½ m v_safe², an impact event, the land event’s energy, and a knockdown', async () => {
    const w = await world(3);
    const p = w.player!;
    const box = spawnBox(w, { p: { x: 4, y: 7.5, z: 0 }, size: [2, 1, 2], material: 'stone', state: 'fixed', look: 'scaffold' });
    w.step();
    w.teleport(p, 4, 0);
    for (let t = 0; t < 5; t++) w.step();
    expect(p.pos.y).toBeCloseTo(8, 1);
    w.removeEntity(box);
    let land: Extract<WorldEvent, { type: 'land' }> | undefined;
    let hit: Extract<WorldEvent, { type: 'impact' }> | undefined;
    for (let t = 0; t < 120 && !land; t++) {
      w.step();
      land = w.events.find((e): e is Extract<WorldEvent, { type: 'land' }> => e.type === 'land' && e.f === p);
      hit = impacts(w).find((e) => e.defender === p);
    }
    expect(land).toBeDefined();
    expect(hit).toBeDefined();
    const v = Math.sqrt(2 * 9.81 * 8);
    const mb = p.mass * p.boneShare.shinL;
    expect(hit!.bone).toBe('shinL');
    // (The controller integrates the fall tick by tick: its touchdown speed is within a few % of √(2gh).)
    const want = 0.5 * mb * (v * v - 36);
    expect(Math.abs(hit!.energy - want) / want).toBeLessThan(0.04);
    expect(hit!.damage).toBeCloseTo(hit!.energy / DAMAGE_TUNING.K, 9);
    expect(land!.energy).toBe(hit!.energy);
    expect(p.hp).toBeCloseTo(100 - hit!.damage, 9);
    expect(p.state).toBe('knockdown');
    expect(hit!.cause).toMatchObject({ kind: 'terrain', feature: 'fall' });
  });
});

describe('Δv vectors are plain records', () => {
  it('applyImpact copies the dv it is given (a caller may reuse it)', () => {
    const { sim, p } = legacy();
    const dv: V3 = { x: 1, y: 0, z: 0 };
    applyImpact(sim, impact(p, { energy: 18, dv }));
    dv.x = 50;
    expect(p.vel.x).toBeCloseTo(1, 12);
  });
});
