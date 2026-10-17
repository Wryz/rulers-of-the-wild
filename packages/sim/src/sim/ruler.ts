// The ruler in CombatSim: melee volumes, the zone classifier, RulerState (damage, wounds, recovery, finishing, down)
// and rulerHit (docs/M1-DESIGN.md §1.5.5, §2.8, §2.9, §4.6).
//
// - Volumes (§2.8): DungeonStyle's 12 bodySpheres plus a knee sphere per leg (the shin's root, kneeR × scale) and an
//   elbow sphere per arm (the forearm's root, elbowR × scale). Without the knees no soft zone is in a standing human's
//   reach (MAP gap-6), so AC-4's first half would be vacuous.
// - The classifier names the zone from the bone, the point and the outward normal in the bone's frame (+z the body's
//   front, +y up, +x its left): eyes, mouth and skull on the head; shoulders, back and flanks on the torso; belly on the
//   abdomen; knees and elbows by distance from the joint; every unlisted surface (chest, arm, leg, pelvis) armoured (D-8).
// - rulerDamage (SPEC:500-506): a hit above woundFrac × max HP opens a wound (severe above severeFrac: an effect by zone
//   and severePenaltyFrac off the effective maximum); otherwise, while the ruler is held (down, stuck or pinned), it is
//   finishing damage on the wound that put it there (D-37 opens one when there is none); otherwise it is unhealed damage
//   that recovers at recoveryHpPerS once the ruler is free. "Above" is strict (RR-8). Every new wound is a `wound` world
//   event; the giant's mind hears of it through the noise bus in phase 17b (this file never imports a mind).
// - rulerHit: the ruler branch of hit() (P02b calls it through WorldPort.rulerHit): DungeonStyle's perk-free damage as
//   energy (E = dmg × meleeJPerDmg; a thrown weapon's E comes from the rule, ruleDamageHp × K), the zone and its
//   toughness, rulerDamage, and the attacker's reaction (an edge that beats the zone bites in as DungeonStyle's does; a
//   blow that doesn't beat it rebounds with a `bump`, SPEC:282). Nothing else of hit() happens to a ruler (no poise,
//   knockdown, hitstun, push, fatal blow, cut, sever, tear, bleed or stamina drain, §4.6 step 5). A strike's push
//   momentum would go to the impact-trip check (SPEC:305), but no human strike is blocking-class (≥ impactTripMinKg),
//   so it is dropped (world/rulerBody.ts and world/contacts.ts own the trips).
//
// combat.ts imports this module at runtime and this module imports combat.ts (bodySpheres, blowDamage) and impact.ts
// (IMPACT_TUNING) at runtime: every use of either is inside a function, so the import cycles are safe.
import { Quaternion, Vector3 } from 'three';
import type { BoneName } from '../body/skeleton';
import { defineTuning } from '../tuning/registry';
import type { ImpactCause, RulerState, RulerZoneId, SevereEffect, V3, WorldEvent, WoundRecord } from '../world/types';
import type { World } from '../world/world';
import { blowDamage, bodySpheres, type CombatSim, type HurtSphere, type HurtZone } from './combat';
import type { Fighter } from './fighter';
import { IMPACT_TUNING } from './impact';
import { DT } from './math';
import type { MoveDef } from './moves';
import { DAMAGE_TUNING, hpFromEnergy } from './rules';
import type { WeaponDef } from './weapons';

export const RULER_TUNING = defineTuning(
  'RULER_TUNING',
  'Ruler',
  {
    recoveryHpPerS: 30,
    woundFrac: 0.02,
    severeFrac: 0.15,
    woundHealHpPerHour: 50,
    severePenaltyFrac: 0.05,
    pinnedKg: 1000,
    unpinnedKg: 900,
    unpinTicks: 15,
    pinnedNormalY: 0.5,
    lockScale: 2,
    retargetBiasCapM: 0.35,
    separateSkipSpeed: 1.0,
    // Not §9.1 rows (P11): the attacker's reaction to a ruler hit (§4.6 step 4). A blow that beats the zone is
    // DungeonStyle's hit() ending (an edge bites in for max(stickMinHold, bite × the hook and KO factors) frames and
    // retracts over stickRetract(Heavy); fists, feet and blunt weapons rebound); one that doesn't rebounds for
    // bumpHold/bumpRetract (MAP gap-0 §6.2: "bruises and pushes but does no damage", SPEC:282). Kept here so the file
    // holds no bare constants (§9, RR-7); the values are DungeonStyle's.
    stickMinHold: 4,
    stickRetract: 12,
    stickRetractHeavy: 16,
    hookHoldMul: 0.6,
    koHoldMul: 0.6,
    reboundHoldWeapon: 3,
    reboundHoldUnarmed: 2,
    reboundRetractWeapon: 11,
    reboundRetractKick: 10,
    reboundRetractPunch: 8,
    bumpHold: 3,
    bumpRetract: 11,
  },
  {
    recoveryHpPerS: { unit: 'HP/s', source: 'SPEC:504, 877' },
    woundFrac: { unit: '× max HP (240 HP)', source: 'SPEC:502' },
    severeFrac: { unit: '× max HP (1,800 HP)', source: 'SPEC:503' },
    woundHealHpPerHour: { unit: 'HP per hour of play', source: 'SPEC:506, 877' },
    severePenaltyFrac: { unit: '× max HP per severe wound', source: 'SPEC:506' },
    pinnedKg: { unit: 'kg', source: 'SPEC:878' },
    unpinnedKg: { unit: 'kg', source: 'NEW: hysteresis' },
    unpinTicks: { unit: 'ticks', source: 'NEW: hysteresis' },
    pinnedNormalY: { unit: 'cos', source: 'D-38' },
    lockScale: { unit: '×', source: 'NEW: MAP gap-0 §6.6 (lock-on range for rulers)' },
    retargetBiasCapM: { unit: 'm', source: 'NEW: MAP gap-0 §6.6' },
    separateSkipSpeed: {
      unit: 'm/s',
      source: "NEW: above this closing speed separate() doesn't push a pair with a standing ruler; the contact scores instead (RF-5)",
    },
    stickMinHold: { unit: 'frames', source: 'DS (hit: an edge sticks max(4, hold)); §4.6 step 4' },
    stickRetract: { unit: 'frames', source: 'DS (hit: retract 12, 16 for a heavy move); §4.6 step 4' },
    stickRetractHeavy: { unit: 'frames', source: 'DS (hit: retract 12, 16 for a heavy move); §4.6 step 4' },
    hookHoldMul: { unit: '×', source: 'DS (hit: a hook bites 0.6 as long)' },
    koHoldMul: { unit: '×', source: 'DS (hit: a finishing blow bites 0.6 as long)' },
    reboundHoldWeapon: { unit: 'frames', source: 'DS (hit: a blunt weapon rebounds 3, 11)' },
    reboundHoldUnarmed: { unit: 'frames', source: 'DS (hit: a fist or foot rebounds 2)' },
    reboundRetractWeapon: { unit: 'frames', source: 'DS (hit: a blunt weapon rebounds 3, 11)' },
    reboundRetractKick: { unit: 'frames', source: 'DS (hit: a foot retracts 10)' },
    reboundRetractPunch: { unit: 'frames', source: 'DS (hit: a fist retracts 8)' },
    bumpHold: { unit: 'frames', source: 'NEW: MAP gap-0 §6.2 (E ≤ T rebounds 3, 11), §4.6 step 4' },
    bumpRetract: { unit: 'frames', source: 'NEW: MAP gap-0 §6.2 (E ≤ T rebounds 3, 11), §4.6 step 4' },
  },
);

export const RULER_ZONE_TUNING = defineTuning(
  'RULER_ZONE_TUNING',
  'Ruler › zones',
  {
    softJ: 600,
    armourJ: 4000,
    defaultJ: 4000,
    kneeR: 0.09,
    elbowR: 0.07,
    eyeNzMin: 0.6,
    eyeNyMin: -0.05,
    eyeNyMax: 0.35,
    eyeNxMax: 0.55,
    mouthNzMin: 0.6,
    mouthNyMin: -0.6,
    mouthNyMax: -0.05,
    mouthNxMax: 0.4,
    shouldersNy: 0.6,
    backNz: -0.4,
    flanksNx: 0.6,
    bellyNz: 0.5,
    bellyNxMax: 0.6,
  },
  {
    softJ: { unit: 'J', source: 'SPEC:875 (eyes, mouth, belly, knees, elbows)' },
    armourJ: { unit: 'J', source: 'SPEC:875 (skull, back, shoulders, flanks)' },
    defaultJ: { unit: 'J', source: 'D-8 (unlisted surfaces)' },
    kneeR: { unit: 'm × scale', source: 'NEW: MAP gap-0 §5, gap-6' },
    elbowR: { unit: 'm × scale', source: 'NEW: MAP gap-0 §5' },
    eyeNzMin: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    eyeNyMin: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    eyeNyMax: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    eyeNxMax: { unit: 'normal component', source: 'NEW: MAP gap-0 §5' },
    mouthNzMin: { unit: 'normal component', source: 'NEW' },
    mouthNyMin: { unit: 'normal component', source: 'NEW' },
    mouthNyMax: { unit: 'normal component', source: 'NEW' },
    mouthNxMax: { unit: 'normal component', source: 'NEW' },
    shouldersNy: { unit: 'normal component', source: 'NEW' },
    backNz: { unit: 'normal component', source: 'NEW' },
    flanksNx: { unit: 'normal component', source: 'NEW' },
    bellyNz: { unit: 'normal component', source: 'NEW' },
    bellyNxMax: { unit: 'normal component', source: 'NEW' },
  },
);

/** A melee volume of a ruler: one of DS's 12 bodySpheres, or a knee or elbow sphere (§2.8). */
export interface RulerVolume extends HurtSphere {
  joint: 'knee' | 'elbow' | null;
}

const SIDES = ['L', 'R'] as const;
/** A point on a joint sphere's surface counts as within it (float rounding of centre + n × r). */
const SURFACE_TOL = 1e-9;

/**
 * 12 DS bodySpheres (combat.ts bodySpheres, in their order), then a knee sphere per leg (the shin's root, kneeR × scale)
 * and an elbow sphere per arm (the forearm's root, elbowR × scale), L before R. A severed limb's joint has no sphere.
 */
export function rulerVolumes(f: Fighter): RulerVolume[] {
  const Z = RULER_ZONE_TUNING;
  const out: RulerVolume[] = bodySpheres(f).map((s) => ({ ...s, joint: null }));
  for (const side of SIDES) {
    const shin: BoneName = side === 'L' ? 'shinL' : 'shinR';
    if (!f.isSevered(shin)) out.push({ zone: 'legs', bone: shin, center: f.rig[shin].pos.clone(), r: Z.kneeR * f.scale, joint: 'knee' });
  }
  for (const side of SIDES) {
    const fore: BoneName = side === 'L' ? 'foreArmL' : 'foreArmR';
    if (!f.isSevered(fore)) out.push({ zone: 'chest', bone: fore, center: f.rig[fore].pos.clone(), r: Z.elbowR * f.scale, joint: 'elbow' });
  }
  return out;
}

/**
 * The named zone a hit on `bone` at world `point` meets (§2.8). `normalOut`: the outward normal in the bone's frame
 * (rig[bone].rot⁻¹; melee: (point − sphere centre)/r; world: the contact normal).
 */
export function classifyRulerZone(f: Fighter, bone: BoneName, point: Vector3, normalOut: Vector3): RulerZoneId {
  const Z = RULER_ZONE_TUNING;
  const n = normalOut;
  switch (bone) {
    case 'shinL':
    case 'thighL':
    case 'shinR':
    case 'thighR': {
      const knee = f.rig[bone === 'shinL' || bone === 'thighL' ? 'shinL' : 'shinR'].pos;
      return point.distanceTo(knee) <= Z.kneeR * f.scale * (1 + SURFACE_TOL) ? 'knees' : 'leg';
    }
    case 'foreArmL':
    case 'upperArmL':
    case 'foreArmR':
    case 'upperArmR': {
      const left = bone === 'foreArmL' || bone === 'upperArmL';
      const elbow = f.rig[left ? 'foreArmL' : 'foreArmR'].pos;
      if (point.distanceTo(elbow) <= Z.elbowR * f.scale * (1 + SURFACE_TOL)) return 'elbows';
      if (bone === 'upperArmL' || bone === 'upperArmR') {
        // Above the shoulder joint less the upper arm's own volume radius: the top of the shoulder.
        const r = bodySpheres(f).find((s) => s.bone === bone)?.r ?? 0;
        if (point.y > f.rig[bone].pos.y - r) return 'shoulders';
      }
      return 'arm';
    }
    case 'head':
      if (n.z > Z.eyeNzMin && n.y >= Z.eyeNyMin && n.y <= Z.eyeNyMax && Math.abs(n.x) <= Z.eyeNxMax) return 'eyes';
      if (n.z > Z.mouthNzMin && n.y >= Z.mouthNyMin && n.y < Z.mouthNyMax && Math.abs(n.x) <= Z.mouthNxMax) return 'mouth';
      return 'skull';
    case 'chest':
      if (n.y > Z.shouldersNy) return 'shoulders';
      if (n.z < Z.backNz) return 'back';
      if (Math.abs(n.x) > Z.flanksNx) return 'flanks';
      return 'chest';
    case 'abdomen':
      if (n.z > Z.bellyNz && Math.abs(n.x) < Z.bellyNxMax) return 'belly';
      if (n.z < Z.backNz) return 'back';
      return 'flanks';
    case 'pelvis':
      if (n.z < Z.backNz) return 'back';
      if (Math.abs(n.x) > Z.flanksNx) return 'flanks';
      return 'pelvis';
  }
}

/** J: soft zones (eyes, mouth, belly, knees, elbows) softJ; skull, back, shoulders, flanks armourJ; the rest defaultJ (D-8). */
export function rulerToughness(z: RulerZoneId): number {
  const Z = RULER_ZONE_TUNING;
  switch (z) {
    case 'eyes':
    case 'mouth':
    case 'belly':
    case 'knees':
    case 'elbows':
      return Z.softJ;
    case 'skull':
    case 'back':
    case 'shoulders':
    case 'flanks':
      return Z.armourJ;
    case 'chest':
    case 'arm':
    case 'leg':
    case 'pelvis':
      return Z.defaultJ;
  }
}

/** A fresh RulerState at full health (keys in the type's order, as the save writes them). */
export function newRulerState(maxHp: number): RulerState {
  return {
    maxHp,
    unhealed: 0,
    wounds: [],
    pinned: false,
    pinnedKg: 0,
    unpinTicks: 0,
    stuck: false,
    burning: false,
    inPit: false,
    downWound: null,
    downCause: null,
    lastWorldTrip: null,
    deflectedHeading: null,
    pendingTrip: null,
  };
}

/** maxHp × (1 − severePenaltyFrac × severe count), never below 0 (SPEC:506). */
export function rulerEffectiveMax(r: RulerState): number {
  let severe = 0;
  for (const w of r.wounds) if (w.severe) severe++;
  return r.maxHp * Math.max(0, 1 - RULER_TUNING.severePenaltyFrac * severe);
}

/** effectiveMax − unhealed − Σ wound.remaining. */
export function rulerHp(r: RulerState): number {
  let open = 0;
  for (const w of r.wounds) open += w.remaining;
  return rulerEffectiveMax(r) - r.unhealed - open;
}

/** f.state === 'tripped' || f.ruler.inPit (SPEC:504). */
export function rulerDown(f: Fighter): boolean {
  return f.state === 'tripped' || (f.ruler?.inPit ?? false);
}

/** rulerDown || stuck || pinned: no recovery; finishing (SPEC:504-505). */
export function rulerHeld(f: Fighter): boolean {
  const r = f.ruler;
  return rulerDown(f) || (!!r && (r.stuck || r.pinned));
}

/**
 * What rulerDamage reads of the world (World satisfies it, and so does sim/impact.ts's view of it): the wound counter,
 * the CombatSim (its tick, its fighters, koFighter) and, when there is one, the world's event list for `wound` events.
 */
export interface RulerDamageWorld {
  readonly ids: { readonly wound: { take(): number } };
  readonly combat: CombatSim;
  readonly events?: WorldEvent[];
}

/**
 * §4.6 (SPEC:500-506; thresholds are "above", so strict, RR-8). `hp` of damage on `zone` of `bone` at world `point`:
 * - hp > woundFrac × maxHp: a new wound (severe above severeFrac × maxHp, with its effect by zone); a `wound` event
 *   (byWorld: an unheld entity, or the terrain within envKillWindowS of the last world trip, RR-14). A new wound never
 *   moves downWound (RR-8);
 * - else, while held (down, stuck or pinned): finishing damage added to downWound; with none, a wound is opened with
 *   downCause (D-37) and becomes downWound;
 * - else unhealed damage (it recovers).
 * Then rulerHp ≤ 0 knocks the ruler out (by 'strike' for a creature's held blow, else 'impact'). Returns the wound this
 * damage opened, or null (none opened: unhealed, finishing into an existing wound, no damage, no ruler, already out).
 */
export function rulerDamage(
  w: RulerDamageWorld,
  f: Fighter,
  hp: number,
  zone: RulerZoneId,
  bone: BoneName,
  cause: ImpactCause,
  point: Vector3,
): WoundRecord | null {
  const r = f.ruler;
  if (!r || f.state === 'ko' || !(hp > 0)) return null;
  const T = RULER_TUNING;
  const tick = w.combat.frame;
  let opened: WoundRecord | null = null;
  if (hp > T.woundFrac * r.maxHp) {
    const severe = hp > T.severeFrac * r.maxHp;
    const local = woundLocal(f, bone, point);
    opened = makeWound(w, zone, bone, local, severe ? severeEffect(zone, local) : null, severe, hp, cause, tick);
    r.wounds.push(opened);
    w.events?.push({ type: 'wound', ruler: f, wound: opened, byWorld: byWorld(r, cause, tick) });
  } else if (rulerHeld(f)) {
    const down = r.downWound === null ? undefined : r.wounds.find((x) => x.id === r.downWound);
    if (down) {
      // The wound's own HP, not a fighter's: written through Object.assign so the one-damage-path audit
      // (tests/damageRule.test.ts, which matches every `.hp` assignment) keeps meaning a fighter's HP (rule 2).
      Object.assign(down, { hp: down.hp + hp, remaining: down.remaining + hp, credit: credits(down.credit, cause.credit) });
    } else {
      // D-37: no wound put it down (the trip opened none, nothing pinning it opened one): this damage opens one, with
      // the cause that put it down, and finishing goes there from now on.
      const c = r.downCause ?? cause;
      opened = makeWound(w, zone, bone, woundLocal(f, bone, point), null, false, hp, c, tick);
      opened.credit = credits(opened.credit, cause.credit);
      r.wounds.push(opened);
      r.downWound = opened.id;
      w.events?.push({ type: 'wound', ruler: f, wound: opened, byWorld: byWorld(r, c, tick) });
    }
  } else {
    r.unhealed += hp;
  }
  if (rulerHp(r) <= 0) {
    const killer = cause.fighterId === null ? null : (w.combat.fighters.find((x) => x.id === cause.fighterId) ?? null);
    w.combat.koFighter(f, { by: cause.kind === 'creature' && cause.held ? 'strike' : 'impact', killer, cause, point: { x: point.x, y: point.y, z: point.z } });
  }
  return opened;
}

/**
 * Phase 14: recovery and healing (§4.6). Unless held or burning, unhealed damage recovers at recoveryHpPerS; wounds heal
 * woundHealHpPerHour in total, oldest first (SPEC:506: never above the effective maximum, which their remaining HP
 * can't exceed). downWound and downCause clear once the ruler is no longer held. A knocked-out ruler stays as it is.
 */
export function rulerTick(f: Fighter, dt: number): void {
  const r = f.ruler;
  if (!r || f.state === 'ko') return;
  const T = RULER_TUNING;
  const held = rulerHeld(f);
  if (!held && !r.burning) {
    // TODO "rule 5 rests on DS stamina here: best-paced axe 18.77-18.91 HP/s < 30 HP/s recovery; a stamina change must
    // re-check it (§9.3)" (RR-24): the free ruler stays at full health only while the best-paced swing rate stays
    // below this recovery (tests/ruler.test.ts computes it from the live move and stamina data).
    r.unhealed -= Math.min(r.unhealed, T.recoveryHpPerS * dt);
  }
  let heal = (T.woundHealHpPerHour / SECONDS_PER_HOUR) * dt;
  for (const wd of r.wounds) {
    if (!(heal > 0)) break;
    const take = Math.min(wd.remaining, heal);
    wd.remaining -= take;
    heal -= take;
  }
  if (!held) {
    r.downWound = null;
    r.downCause = null;
  }
}

/**
 * The ruler branch of hit() (§4.6), called through WorldPort.rulerHit. `ruleDamageHp` (a thrown weapon in world mode)
 * carries the blow's energy as E / K, computed with no toughness (combat.ts thrownRule): E = ruleDamageHp × K.
 */
export function rulerHit(
  sim: CombatSim,
  w: World,
  a: Fighter,
  d: Fighter,
  m: MoveDef,
  point: Vector3,
  dir: Vector3,
  zone: HurtZone,
  bone: BoneName,
  power: number,
  haft: boolean,
  thrown: WeaponDef | null,
  ruleDamageHp: number | null,
): void {
  if (!d.ruler || d.state === 'ko') return;
  const R = RULER_TUNING;
  // 1. The blow's energy: DungeonStyle's perk-free damage (rulers have defense 0, D-13) as joules (SPEC:283), or the
  //    rule's for a thrown weapon (§4.4).
  const E = ruleDamageHp !== null ? ruleDamageHp * DAMAGE_TUNING.K : blowDamage(a, d, m, power, haft, thrown) * DAMAGE_TUNING.meleeJPerDmg;
  // 2. The zone: a knee or elbow sphere is its joint; elsewhere the classifier on the outward normal in the bone frame.
  const vol = volumeAt(d, bone, point);
  const rz: RulerZoneId = vol?.joint === 'knee' ? 'knees' : vol?.joint === 'elbow' ? 'elbows' : classifyRulerZone(d, bone, point, boneNormal(d, bone, point, vol));
  const T = rulerToughness(rz) + (d.armour[zone] ?? 0);
  const hp = hpFromEnergy(E, T);
  // 3. The ruler's rule.
  const cause: ImpactCause = { kind: 'creature', entityId: null, fighterId: a.id, credit: a.playerId ? [a.playerId] : [], held: true, feature: 'creature' };
  rulerDamage(w, d, hp, rz, bone, cause, point);
  const ko = knockedOut(d);
  // 4. The attacker: DungeonStyle's reaction for a blow that beats the zone, a rebound and a bump for one that doesn't.
  const beats = E > T;
  const held = thrown ?? a.weapon;
  const weapon = m.weapon && !haft ? held : null;
  if (!thrown) {
    if (beats) {
      if (weapon && weapon.cut > 0) {
        const hold = Math.round(weapon.bite * (m.kind === 'hook' ? R.hookHoldMul : 1) * (ko ? R.koHoldMul : 1));
        a.impact('stick', Math.max(R.stickMinHold, hold), m.weight === 'heavy' ? R.stickRetractHeavy : R.stickRetract);
      } else if (!ko) {
        a.impact(
          'rebound',
          m.weapon ? R.reboundHoldWeapon : R.reboundHoldUnarmed,
          m.weapon ? R.reboundRetractWeapon : m.limb.startsWith('foot') ? R.reboundRetractKick : R.reboundRetractPunch,
        );
      }
    } else {
      a.impact('rebound', R.bumpHold, R.bumpRetract);
    }
  }
  if (beats) {
    d.framesSinceHit = 0;
    a.framesSinceLanded = 0;
    // (A ruler is never in hitstun, so a run of blows on it is never a combo.)
    a.combo = 1;
  } else {
    sim.events.push({ type: 'bump', attacker: a, defender: d, point: point.clone() });
  }
  // 6. The hit, with the ruler zone, the energy, the toughness and the HP it did.
  const caughtInStartup = d.state === 'attack' && !!d.move && d.stateFrame < d.move.startup;
  sim.events.push({
    type: 'hit',
    attacker: a,
    defender: d,
    move: m,
    point: point.clone(),
    dir: dir.clone(),
    zone,
    damage: hp,
    counter: caughtInStartup || (!thrown && a.isCounterAttack),
    armored: false,
    knockdown: false,
    ko,
    combo: a.combo,
    bone,
    weapon,
    push: 0,
    thrown: !!thrown,
    wound: null,
    sever: null,
    fatal: null,
    tear: null,
    rulerZone: rz,
    energy: E,
    toughness: T,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Whether the fighter is out (a function, so a check after a call isn't narrowed away by one before it). */
function knockedOut(f: Fighter): boolean {
  return f.state === 'ko';
}

/** Seconds in an hour (a unit conversion). */
const SECONDS_PER_HOUR = 3600;

const _q = new Quaternion();
const _v = new Vector3();

/** The ruler volume of `bone` whose surface `point` lies on (the one it is nearest to), or null. */
function volumeAt(f: Fighter, bone: BoneName, point: Vector3): RulerVolume | null {
  let best: RulerVolume | null = null;
  let bestErr = Infinity;
  for (const v of rulerVolumes(f)) {
    if (v.bone !== bone) continue;
    const err = Math.abs(point.distanceTo(v.center) - v.r);
    if (err < bestErr) {
      bestErr = err;
      best = v;
    }
  }
  return best;
}

/** The outward normal at `point` on the volume (or from the bone's joint), in the bone's frame. */
function boneNormal(f: Fighter, bone: BoneName, point: Vector3, vol: RulerVolume | null): Vector3 {
  const n = new Vector3().subVectors(point, vol ? vol.center : f.rig[bone].pos);
  if (n.lengthSq() < SURFACE_TOL) n.set(0, 1, 0);
  n.normalize();
  return n.applyQuaternion(_q.copy(f.rig[bone].rot).invert());
}

/** `point` in the bone's frame, ÷ scale (combat.ts's Wound.local convention; the client draws the scar there). */
function woundLocal(f: Fighter, bone: BoneName, point: V3): V3 {
  const x = f.rig[bone];
  _v.set(point.x, point.y, point.z).sub(x.pos).applyQuaternion(_q.copy(x.rot).invert()).divideScalar(f.scale);
  return { x: _v.x, y: _v.y, z: _v.z };
}

/**
 * SPEC:503 (§2.9): knees and legs limp; an eye goes blind on its side (+x in the head frame is the body's left);
 * mouth and skull weaken the jaw; every torso zone and the arms wind it (I25, RR-10).
 */
function severeEffect(zone: RulerZoneId, local: V3): SevereEffect {
  switch (zone) {
    case 'knees':
    case 'leg':
      return 'limp';
    case 'eyes':
      return local.x >= 0 ? 'blindL' : 'blindR';
    case 'mouth':
    case 'skull':
      return 'weakJaw';
    default:
      return 'winded';
  }
}

function makeWound(
  w: RulerDamageWorld,
  zone: RulerZoneId,
  bone: BoneName,
  local: V3,
  effect: SevereEffect | null,
  severe: boolean,
  hp: number,
  cause: ImpactCause,
  tick: number,
): WoundRecord {
  return {
    id: w.ids.wound.take(),
    zone,
    bone,
    local,
    severe,
    effect,
    hp,
    remaining: hp,
    cause: { ...cause, credit: [...cause.credit] },
    tick,
    credit: credits(cause.credit),
  };
}

/** The `wound` event's byWorld (RR-14): an entity nobody holds, or the terrain soon after a trip the world caused. */
function byWorld(r: RulerState, cause: ImpactCause, tick: number): boolean {
  if (cause.kind === 'entity') return !cause.held;
  if (cause.kind !== 'terrain' || !r.lastWorldTrip) return false;
  const since = tick - r.lastWorldTrip.tick;
  return since >= 0 && since <= Math.round(IMPACT_TUNING.envKillWindowS / DT);
}

/** Player ids, sorted and de-duplicated (SPEC:186, 473). */
function credits(...lists: readonly (readonly string[])[]): string[] {
  const s = new Set<string>();
  for (const l of lists) for (const c of l) s.add(c);
  return [...s].sort();
}

