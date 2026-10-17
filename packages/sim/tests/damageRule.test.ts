// The one damage rule for world contacts (docs/M1-DESIGN.md §4.3, §4.4, §2.10; package P09): m_eff by pair kind with
// bone masses, the calibration rows of §4.3 (SPEC:292-301 with bone m_eff, 1 % tolerance, D-3), the sharpness leading
// test, the hard landing and the self-motion split, the world-impact Δv, the environmental-kill window (inclusive 120
// ticks) and its credit, and the audit that only the rule's own sites write a fighter's HP.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import typescript from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnemy } from '../src/sim/enemies';
import { Fighter, IdCounter } from '../src/sim/fighter';
import { freeDv, IMPACT_TUNING, isEnvironmental } from '../src/sim/impact';
import { DT, Rng } from '../src/sim/math';
import { createPlayer } from '../src/sim/roster';
import { RULER_ZONE_TUNING } from '../src/sim/ruler';
import { boneMass, DAMAGE_TUNING, hpFromEnergy, impactEnergy, reducedMass } from '../src/sim/rules';
import { SPECIES_BODY } from '../src/sim/species';
import { restoreTuning, tuningSnapshot } from '../src/tuning/registry';
import { contactEnergy, contactMeff, hardLandingJ, impactDv, integrityMeff, leadingSharpness, pointMass, selfMotion, sideMass } from '../src/world/damage';
import type { Finish, ImpactCause, Pose3, SharpPoint } from '../src/world/types';

const snapshot = tuningSnapshot();
afterEach(() => restoreTuning(snapshot));

const near = (got: number, want: number, rel = 0.01) => expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.abs(want) * rel);
const fall = (h: number) => Math.sqrt(2 * 9.81 * h);

function giant(): Fighter {
  const g = new Fighter('enemy', 'Giant', {}, {}, undefined, { ids: new IdCounter(50) });
  g.scale = SPECIES_BODY.giantApe.scale;
  g.massKg = SPECIES_BODY.giantApe.massKg;
  g.species = 'giantApe';
  return g;
}
function human(): Fighter {
  const p = createPlayer({ ids: new IdCounter(1) });
  p.species = 'human';
  return p;
}
function ape(): Fighter {
  const { fighter: a } = createEnemy('bruiser', new Rng(3), {}, {}, { ids: new IdCounter(9) });
  a.scale = SPECIES_BODY.ape.scale;
  a.massKg = SPECIES_BODY.ape.massKg;
  a.species = 'ape';
  return a;
}
const LOG: ImpactCause = { kind: 'entity', entityId: 7, fighterId: null, credit: ['p1'], held: false, feature: 'falling' };
const TERRAIN: ImpactCause = { kind: 'terrain', entityId: null, fighterId: null, credit: [], held: false, feature: 'fall' };
const finish = (by: Finish['by'], cause: ImpactCause | null, killer: Fighter | null = null): Finish => ({ by, killer, cause, point: { x: 0, y: 0, z: 0 } });

describe('m_eff by pair kind (§4.3 table, orchestrator decision 2)', () => {
  it('is the reduced mass of the two sides, a static side counting as Infinity', () => {
    const mb = 15;
    expect(contactMeff({ kind: 'creature', boneKg: mb, bodyKg: 73.3 }, { kind: 'entity', massKg: 300, static: false }, Infinity)).toBe(reducedMass(mb, 300));
    expect(contactMeff({ kind: 'creature', boneKg: mb, bodyKg: 73.3 }, { kind: 'entity', massKg: 300, static: true }, Infinity)).toBe(mb);
    expect(contactMeff({ kind: 'creature', boneKg: mb, bodyKg: 73.3 }, { kind: 'terrain' }, Infinity)).toBe(mb);
    expect(contactMeff({ kind: 'creature', boneKg: mb, bodyKg: 73.3 }, { kind: 'creature', boneKg: 2865, bodyKg: 14000 }, Infinity)).toBe(reducedMass(mb, 2865));
    expect(contactMeff({ kind: 'entity', massKg: 40, static: false }, { kind: 'entity', massKg: 300, static: false }, Infinity)).toBe(reducedMass(40, 300));
    expect(contactMeff({ kind: 'entity', massKg: 40, static: false }, { kind: 'entity', massKg: 300, static: true }, Infinity)).toBe(40);
    expect(contactMeff({ kind: 'entity', massKg: 40, static: false }, { kind: 'terrain' }, Infinity)).toBe(40);
    expect(sideMass({ kind: 'terrain' })).toBe(Infinity);
  });

  it('the unbacked-target lever (off by default) makes the target side its whole body against a bone that outweighs it', () => {
    expect(IMPACT_TUNING.unbackedTargetMassRatio).toBe(Infinity);
    const self = { kind: 'creature' as const, boneKg: 15, bodyKg: 73.3 };
    const bone = { kind: 'creature' as const, boneKg: 2865, bodyKg: 14000 };
    expect(contactMeff(self, bone, Infinity)).toBeCloseTo(14.92, 2);
    // With the lever at 10×: 2,865 ≥ 10 × 73.3, so the player's side is 73.3 kg (71.5 kg m_eff, §4.4).
    near(contactMeff(self, bone, 10), 71.47);
    expect(contactMeff(self, bone, 100)).toBeCloseTo(14.92, 2);
  });
});

describe("an entity's integrity at its effective mass at the contact point (orchestrator decision on P10's conflict)", () => {
  const Q0 = { x: 0, y: 0, z: 0, w: 1 };
  const UP = { x: 0, y: 1, z: 0 };
  /** A thin rod of mass m and length L along local y: principal moments (mL²/12, ~0, mL²/12). */
  const rod = (m: number, L: number) => ({ x: (m * L * L) / 12, y: 0, z: (m * L * L) / 12 });

  it('pointMass is 1/(1/m + (r×n)ᵀI⁻¹(r×n)): m through the centre of mass, m/4 at a rod end struck across it, m/7 at a square plate corner', () => {
    const m = 738;
    const L = 14.5;
    // Struck through its centre of mass, or along its axis at the end: the whole mass.
    expect(pointMass(m, rod(m, L), Q0, { x: 0, y: 0, z: 0 }, UP)).toBe(m);
    expect(pointMass(m, rod(m, L), Q0, { x: 0, y: L / 2, z: 0 }, UP)).toBeCloseTo(m, 9);
    // Across its axis at the end (the tip of a felled trunk landing): m/4.
    near(pointMass(m, rod(m, L), Q0, { x: 0, y: L / 2, z: 0 }, { x: 1, y: 0, z: 0 }), m / 4, 1e-9);
    // The same rod lying along world x (local y turned onto x), its end met from below: m/4.
    const alongX = { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 };
    near(pointMass(m, rod(m, L), alongX, { x: L / 2, y: -0.15, z: 0 }, UP), m / 4, 1e-9);
    // A thin square plate a × a (2.2 t, 10 m) met flat at a corner: m/7.
    const a = 10;
    const plate = { x: (2200 * a * a) / 12, y: (2200 * a * a) / 6, z: (2200 * a * a) / 12 };
    near(pointMass(2200, plate, Q0, { x: a / 2, y: 0, z: a / 2 }, UP), 2200 / 7, 1e-9);
    // The normal's sign doesn't matter.
    expect(pointMass(m, rod(m, L), Q0, { x: 0, y: L / 2, z: 0 }, { x: -1, y: 0, z: 0 })).toBeCloseTo(m / 4, 9);
  });

  it('integrityMeff: the reduced mass of the two sides at the point; static sides and the terrain infinite, a creature its bone', () => {
    const log = { kind: 'entity' as const, massKg: 738, static: false, pointKg: 738 / 4 };
    const other = { kind: 'entity' as const, massKg: 300, static: false, pointKg: 120 };
    expect(DAMAGE_TUNING.integrityPointMass).toBe(true);
    expect(integrityMeff(log, { kind: 'terrain' })).toBe(738 / 4);
    expect(integrityMeff(log, { kind: 'entity', massKg: 50, static: true, pointKg: 50 })).toBe(738 / 4);
    expect(integrityMeff(log, other)).toBe(reducedMass(738 / 4, 120));
    expect(integrityMeff(log, { kind: 'creature', boneKg: 859, bodyKg: 14000 })).toBe(reducedMass(738 / 4, 859));
    // A fixed entity's integrity against a bone is the bone (AC-5's log against the giant's shin).
    expect(integrityMeff({ kind: 'entity', massKg: 300, static: true, pointKg: 300 }, { kind: 'creature', boneKg: 859.5, bodyKg: 14000 })).toBe(859.5);
    // No point mass given: the whole mass.
    expect(integrityMeff({ kind: 'entity', massKg: 40, static: false }, { kind: 'terrain' })).toBe(40);
    // The lever off: §4.3's table (whole masses), as contactMeff.
    DAMAGE_TUNING.integrityPointMass = false;
    expect(integrityMeff(log, { kind: 'terrain' })).toBe(738);
    expect(integrityMeff(log, other)).toBe(contactMeff(log, other, Infinity));
  });
});

describe('calibration (§4.3, SPEC:292-301 with bone m_eff, D-3: 1 %)', () => {
  it('a 300 kg log dropped 4 m onto the giant’s chest bone: m_eff 271.6 kg, 10,656 J, 370 HP', () => {
    const g = giant();
    near(boneMass(g, 'chest'), 2865);
    const mEff = contactMeff({ kind: 'creature', boneKg: boneMass(g, 'chest'), bodyKg: g.mass }, { kind: 'entity', massKg: 300, static: false }, Infinity);
    near(mEff, 271.6);
    const E = impactEnergy(mEff, fall(4), 0);
    near(E, 10656);
    near(hpFromEnergy(E, RULER_ZONE_TUNING.defaultJ), 370);
  });

  it('the same log on the head bone: 287 HP (skull 4,000 J)', () => {
    const g = giant();
    const mEff = reducedMass(boneMass(g, 'head'), 300);
    near(hpFromEnergy(impactEnergy(mEff, fall(4), 0), RULER_ZONE_TUNING.armourJ), 287);
  });

  it('the shin (859 kg) falling 3 m onto a 0.6 stake: 70,825 J, 3,713 HP', () => {
    const g = giant();
    near(boneMass(g, 'shinL'), 859.5);
    const mEff = contactMeff({ kind: 'creature', boneKg: boneMass(g, 'shinL'), bodyKg: g.mass }, { kind: 'entity', massKg: 2, static: true }, Infinity);
    expect(mEff).toBe(boneMass(g, 'shinL'));
    // A sharp point leading: no safe-landing subtraction (§4.3).
    const E = contactEnergy({ mEff, vn: fall(3), s: 0.6, boneKg: mEff, vSafe: SPECIES_BODY.giantApe.vSafe, staticOther: true, selfMotion: true });
    expect(E.creature).toBe(E.full);
    near(E.full, 70825);
    near(hpFromEnergy(E.full, RULER_ZONE_TUNING.defaultJ), 3713);
  });

  it('an axe perfect counter of 73.98 dmg on a knee: 1,331.7 J, 40.65 HP (melee through the rule, §4.4)', () => {
    // E = dmg × meleeJPerDmg (SPEC:283); a knee is a soft zone (softJ 600 J, SPEC:875); HP = (E − T) / K.
    const E = 73.98 * DAMAGE_TUNING.meleeJPerDmg;
    near(E, 1331.7);
    near(hpFromEnergy(E, RULER_ZONE_TUNING.softJ), 40.65);
    expect(hpFromEnergy(E, RULER_ZONE_TUNING.softJ)).toBeCloseTo(Math.max(0, E - RULER_ZONE_TUNING.softJ) / DAMAGE_TUNING.K, 12);
  });

  it('players and apes: a 300 kg log dropped 4 m on a head is 11.8 HP and pressed (Δv 7.1 m/s down); on an ape’s chest 40.8 HP', () => {
    const p = human();
    const mEff = reducedMass(boneMass(p, 'head'), 300);
    near(mEff, 5.4);
    near(impactEnergy(mEff, fall(4), 0), 212);
    near(hpFromEnergy(impactEnergy(mEff, fall(4), 0), 0), 11.8);
    const dv = impactDv(300, { x: 0, y: -fall(4), z: 0 }, p.mass, false, 0);
    near(dv.y, -7.12);
    expect(dv.y <= -IMPACT_TUNING.launchDv).toBe(true); // pressed
    expect(freeDv(dv)).toBe(0); // all of it into the ground: not launched
    const a = ape();
    near(hpFromEnergy(impactEnergy(reducedMass(boneMass(a, 'chest'), 300), fall(4), 0), 0), 40.8);
  });

  it('the giant’s charge at 6-7 m/s into a player’s chest bone: m_eff 14.9 kg, 14.9-20.3 HP, Δv 5.85-6.83 m/s (launched)', () => {
    const p = human();
    const g = giant();
    const mEff = contactMeff({ kind: 'creature', boneKg: boneMass(p, 'chest'), bodyKg: p.mass }, { kind: 'creature', boneKg: boneMass(g, 'chest'), bodyKg: g.mass }, Infinity);
    near(mEff, 14.92);
    for (const [v, hp, dvx] of [
      [6, 14.9, 5.85],
      [7, 20.3, 6.83],
    ]) {
      near(hpFromEnergy(impactEnergy(mEff, v, 0), 0), hp);
      const dv = impactDv(boneMass(g, 'chest'), { x: v, y: 0, z: 0 }, p.mass, true, IMPACT_TUNING.creatureRestitution);
      near(dv.x, dvx);
      expect(freeDv(dv) >= IMPACT_TUNING.launchDv).toBe(true);
    }
    // The creatureRestitution lever (off by default) doubles it at e = 1: (1 + e) × 5.85 m/s (§4.4 quotes ≈ 12-14 m/s).
    near(impactDv(boneMass(g, 'chest'), { x: 6, y: 0, z: 0 }, p.mass, true, 1).x, 11.7);
    // The charge is the giant's own motion: its v_safe (14.07 m/s) takes the whole blunt landing off its side.
    const giantSide = contactEnergy({ mEff, vn: 7, s: 0, boneKg: boneMass(g, 'chest'), vSafe: SPECIES_BODY.giantApe.vSafe, staticOther: false, selfMotion: true });
    expect(giantSide.creature).toBe(0);
  });

  it('a static impactor or the terrain gives no Δv', () => {
    expect(impactDv(Infinity, { x: 0, y: -9, z: 0 }, 73.3, false, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('hard landings and self-motion (§4.3, SPEC:284, D-4, RF-3)', () => {
  it('hardLandingJ is ½ m v_safe², v_safe = 6·√scale per species', () => {
    expect(hardLandingJ(4.5, 6)).toBe(81);
    near(SPECIES_BODY.giantApe.vSafe, 6 * Math.sqrt(5.5));
    near(SPECIES_BODY.ape.vSafe, 6 * Math.sqrt(1.1));
  });

  it('a blunt contact against a static side or by the creature’s own motion loses the safe landing; a brought or sharp one keeps it all', () => {
    const base = { mEff: 15, vn: 8, boneKg: 15, vSafe: 6 };
    const full = impactEnergy(15, 8, 0);
    expect(contactEnergy({ ...base, s: 0, staticOther: true, selfMotion: false })).toEqual({ full, creature: full - hardLandingJ(15, 6) });
    expect(contactEnergy({ ...base, s: 0, staticOther: false, selfMotion: true }).creature).toBe(full - hardLandingJ(15, 6));
    expect(contactEnergy({ ...base, s: 0, staticOther: false, selfMotion: false }).creature).toBe(full);
    const sharp = contactEnergy({ ...base, s: 0.6, staticOther: true, selfMotion: true });
    expect(sharp.creature).toBe(sharp.full);
    expect(sharp.full).toBeCloseTo(full * (1 + DAMAGE_TUNING.kS * 0.6), 9);
    // Below v_safe a blunt fall costs nothing; the lever off keeps the full energy.
    expect(contactEnergy({ ...base, vn: 5.9, s: 0, staticOther: true, selfMotion: true }).creature).toBe(0);
    DAMAGE_TUNING.hardLandingBluntOnly = false;
    expect(contactEnergy({ ...base, s: 0, staticOther: true, selfMotion: true }).creature).toBe(full);
  });

  it('selfMotion: the creature’s own speed into the other against the speed the other brings', () => {
    const n = { x: 1, y: 0, z: 0 }; // out of the creature, toward the other side
    expect(selfMotion({ x: 3.8, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, n)).toBe(true); // walking into a log
    expect(selfMotion({ x: 0, y: 0, z: 0 }, { x: -6, y: 0, z: 0 }, n)).toBe(false); // a log brought into it
    expect(selfMotion({ x: 2, y: 0, z: 0 }, { x: -3, y: 0, z: 0 }, n)).toBe(false);
    expect(selfMotion({ x: 3, y: 0, z: 0 }, { x: -3, y: 0, z: 0 }, n)).toBe(true); // a tie is the creature's
    expect(selfMotion({ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, n)).toBe(true); // separating: nothing either way
  });
});

describe('the sharpness leading test (§4.3, SPEC:281)', () => {
  const pose: Pose3 = { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 } };
  const stake: SharpPoint = { local: { x: 0, y: 0.5, z: 0 }, dir: { x: 0, y: 1, z: 0 }, sharpness: 0.6 };

  it('leads when the contact is within tipRadiusM of the tip and the other side comes at it within leadingCos', () => {
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5, z: 0 }, { x: 0, y: -8, z: 0 })).toBe(0.6);
    expect(leadingSharpness([stake], pose, { x: 0.1, y: 0.45, z: 0.05 }, { x: 0, y: -8, z: 0 })).toBe(0.6);
    // Out of the tip radius, from the side, or moving away: no lead.
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5 - DAMAGE_TUNING.tipRadiusM - 0.01, z: 0 }, { x: 0, y: -8, z: 0 })).toBe(0);
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5, z: 0 }, { x: 8, y: 0, z: 0 })).toBe(0);
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5, z: 0 }, { x: 0, y: 8, z: 0 })).toBe(0);
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(0);
    // At exactly leadingCos it leads (≥), just past it it doesn't.
    const c = DAMAGE_TUNING.leadingCos;
    const at = { x: Math.sqrt(1 - c * c), y: -c, z: 0 };
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5, z: 0 }, at)).toBe(0.6);
    const past = { x: Math.sqrt(1 - (c - 0.01) ** 2), y: -(c - 0.01), z: 0 };
    expect(leadingSharpness([stake], pose, { x: 0, y: 0.5, z: 0 }, past)).toBe(0);
  });

  it('reads the points in the entity’s pose and takes the sharpest leading one', () => {
    // A stake lying along +x (its +y turned onto +x), 2 m away, tip at x = 2.5.
    const lying: Pose3 = { p: { x: 2, y: 0, z: 0 }, q: { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 } };
    const blunt: SharpPoint = { ...stake, sharpness: 0.2 };
    expect(leadingSharpness([blunt, stake], lying, { x: 2.5, y: 0, z: 0 }, { x: -5, y: 0, z: 0 })).toBe(0.6);
    expect(leadingSharpness([stake], lying, { x: 2, y: 0.5, z: 0 }, { x: 0, y: -5, z: 0 })).toBe(0);
  });
});

describe('environmental kills (§4.4, SPEC:415, D-31)', () => {
  const knock = (d: Fighter, tick: number) => {
    d.lastKnock = { tick, cause: { kind: 'creature', entityId: null, fighterId: 1, credit: ['p1'], held: false, feature: 'creature' }, by: 1 };
  };

  it('the terrain within the 2 s window (120 ticks, inclusive) is environmental with the knocker’s credit; t + 121 is not', () => {
    const W = Math.round(IMPACT_TUNING.envKillWindowS / DT);
    expect(W).toBe(120);
    const a = ape();
    knock(a, 1000);
    expect(isEnvironmental(a, finish('impact', TERRAIN), 1000 + W)).toEqual({ environmental: true, credit: ['p1'] });
    expect(isEnvironmental(a, finish('impact', TERRAIN), 1000 + W + 1)).toEqual({ environmental: false, credit: [] });
    a.lastKnock = null;
    expect(isEnvironmental(a, finish('impact', TERRAIN), 1000).environmental).toBe(false);
  });

  it('an entity nobody holds is environmental whenever it kills, with its credit and a recent knocker’s', () => {
    const a = ape();
    expect(isEnvironmental(a, finish('impact', { ...LOG, credit: ['p2'] }), 50)).toEqual({ environmental: true, credit: ['p2'] });
    knock(a, 40);
    expect(isEnvironmental(a, finish('impact', { ...LOG, credit: ['p2'] }), 50)).toEqual({ environmental: true, credit: ['p1', 'p2'] });
    expect(isEnvironmental(a, finish('impact', { ...LOG, credit: [] }), 40 + 121)).toEqual({ environmental: true, credit: [] });
  });

  it('a held or thrown object, a strike, a creature’s body, bleeding, fatal and severing blows are not', () => {
    const a = ape();
    knock(a, 10);
    const p = human();
    p.playerId = 'p1';
    expect(isEnvironmental(a, finish('impact', { ...LOG, held: true, fighterId: p.id }, p), 20).environmental).toBe(false);
    expect(isEnvironmental(a, finish('impact', { kind: 'creature', entityId: null, fighterId: 3, credit: [], held: false, feature: 'creature' }), 20).environmental).toBe(false);
    for (const by of ['strike', 'thrown', 'fatal', 'sever', 'bleed'] as const) {
      const r = isEnvironmental(a, finish(by, { kind: 'creature', entityId: null, fighterId: p.id, credit: ['p1'], held: true, feature: 'creature' }, p), 20);
      expect(r).toEqual({ environmental: false, credit: ['p1'] });
    }
    expect(isEnvironmental(a, finish('bleed', null), 20)).toEqual({ environmental: false, credit: [] });
  });
});

// ---------------------------------------------------------------------------
// The audit: no other damage path exists (§13.1 P09 "Done")
// ---------------------------------------------------------------------------

const ts = typescript;
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/** Every assignment to an `.hp` property in the sim's code, as "file:function". */
function hpWrites(): string[] {
  const out: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = relative(SRC, file).split('\\').join('/');
    const fnName = (n: typescript.Node): string => {
      for (let p: typescript.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isConstructorDeclaration(p)) return 'constructor';
        if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText(sf);
      }
      return '<top>';
    };
    const visit = (n: typescript.Node): void => {
      const isWrite =
        (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken));
      if (isWrite) {
        const target = ts.isBinaryExpression(n) ? n.left : n.operand;
        if (ts.isPropertyAccessExpression(target) && target.name.text === 'hp') out.push(`${rel}:${fnName(n)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...new Set(out)].sort();
}

describe('one damage path (rule 2)', () => {
  it('only hit(), applyImpact, bleed(), revive and the record readers write a fighter’s HP', () => {
    // DEVIATION (§13.1 P09 Done lists hit(), applyImpact, bleed() and revive/respawn): DungeonStyle's block chip damage
    // (block()) and the jammed-blade nick (resolveJams) also write HP; legacy replays must stay bit-identical, so they
    // are listed here as the melee rule's own sites. The constructor and restoreRecord set HP, they don't damage.
    expect(hpWrites()).toEqual([
      'sim/combat.ts:bleed',
      'sim/combat.ts:block',
      'sim/combat.ts:hit',
      'sim/combat.ts:resolveJams',
      'sim/fighter.ts:constructor',
      'sim/fighter.ts:restoreRecord',
      'sim/impact.ts:applyImpact',
      'world/deaths.ts:revive',
    ]);
  });
});
