// World impacts on fighters: applyImpact (HP, Δv, knockdown, launch, press, hitstun, lastKnock, the `impact` event) and
// the environmental-kill classification with its credit (docs/M1-DESIGN.md §1.5.5, §2.10, §4.4).
//
// - The energy and toughness of an Impact come from the one damage rule (rule 2), scored by the contact pipeline
//   (world/contacts.ts) or a landing (world/characters.ts); here they become HP (`hpFromEnergy`) and the body's answer.
// - Δv is whatever the Impact carries: the contact pipeline gives one only to sensor targets that are not a standing
//   ruler, and never for static impactors, terrain or the target's own motion (§4.3, §4.4, RF-4). Here it goes to the
//   body: a standing push (DS slide), or the slab (launched, pressed, already down).
// - Rulers take the HP through their own rule (sim/ruler.ts rulerDamage: wounds, finishing, recovery, KO); the
//   impact-trip check is the contact pipeline's (it needs the ruler body's rules, world/rulerBody.ts).
// - A KO goes through CombatSim.koFighter, the only way into 'ko' (§4.4), with `by 'impact'` and the cause.
//
// Imports from combat.ts and fighter.ts are type-only: combat.ts may import this module at runtime. The world is read
// through sim.world, checked structurally (ImpactWorld), so this file imports no world module at runtime.
import { Vector3 } from 'three';
import type { PoseName } from '../body/poses';
import { defineTuning } from '../tuning/registry';
import type { Finish, Impact, ImpactCause, ImpactResult, V3, WorldEvent, WorldPort } from '../world/types';
import type { CombatSim, HurtZone } from './combat';
import type { Fighter } from './fighter';
import { DT } from './math';
import type { Weight } from './moves';
import { rulerDamage } from './ruler';
import { hpFromEnergy } from './rules';

export const IMPACT_TUNING = defineTuning(
  'IMPACT_TUNING',
  'Damage rule › world impacts',
  {
    poisePerHp: 3.2,
    bluntPoiseMul: 1.35,
    weightMediumHp: 5,
    weightHeavyHp: 12,
    hitstunBase: 12,
    hitstunPerHp: 0.9,
    launchDv: 5,
    flinchDv: 0.5,
    envKillWindowS: 2,
    envKillPartsMul: 2,
    // TODO "ruler blows (SPEC:417)": rule 9 and SPEC:417 against SPEC:278 (RR-6, departure X20). Both levers stay off
    // by default so the calibrated numbers stand until a playtest asks (§4.4).
    creatureRestitution: 0,
    unbackedTargetMassRatio: Infinity,
    partsRingR: 0.6,
    partsDropH: 0.3,
    // Not §9.1 rows (P09): values the design gives in prose, or DS numbers the `impact` event's presentation hints
    // reuse, kept here so no file holds them as bare constants (CLAUDE.md; §13.0 adds keys to the owning table).
    releaseApartTicks: 2,
    castWindowTicks: 1.5,
    hitstunIntensityBase: 0.25,
    hitstunIntensityPerHp: 1 / 12,
    landMinJ: 20,
    hintImpulsePerNs: 0.25,
    hintImpulseMax: 60,
    hintLift: 0.05,
    hintHitstopBase: 4,
    hintHitstopPerHp: 1 / 3,
    hintHitstopMax: 8,
    hintShakeBase: 0.08,
    hintShakePerHp: 1 / 50,
    hintShakeMax: 0.5,
  },
  {
    poisePerHp: { unit: 'poise/HP', source: 'DS (hit poise damage)' },
    bluntPoiseMul: { unit: '×', source: 'DS' },
    weightMediumHp: { unit: 'HP', source: 'DS (projectileStrike weight)' },
    weightHeavyHp: { unit: 'HP', source: 'DS' },
    hitstunBase: { unit: 'frames', source: 'DS (projectileStrike)' },
    hitstunPerHp: { unit: 'frames/HP', source: 'DS' },
    launchDv: { unit: 'm/s', source: 'NEW: above every DS knockback (max 4.6), MAP gap-2 §8' },
    flinchDv: { unit: 'm/s', source: 'NEW: MAP gap-2 §8' },
    envKillWindowS: { unit: 's', source: 'SPEC:415' },
    envKillPartsMul: { unit: '× parts', source: 'SPEC:415 ("pay double parts"), D-30' },
    creatureRestitution: {
      unit: '—',
      source: 'NEW: off-by-default rule-9 lever, Δv × (1 + e) creature on creature (RR-6, §4.4)',
    },
    unbackedTargetMassRatio: { unit: '×', source: 'NEW: off-by-default SPEC:417 lever, Infinity = off (RR-6, §4.4)' },
    partsRingR: { unit: 'm × scale', source: 'NEW: where parts appear (RR-7)' },
    partsDropH: { unit: 'm', source: 'NEW: where parts appear (RR-7)' },
    releaseApartTicks: {
      unit: 'ticks',
      source: "NEW: §2.3, §4.3 (RF-3): a released entity's contacts with its releaser score again once apart this long",
      min: 0,
      step: 1,
    },
    castWindowTicks: {
      unit: 'ticks',
      source: "NEW: §4.3 sensor normals: Shape.castShape over 1.5·DT from the start-of-previous-step poses",
      min: 1,
    },
    hitstunIntensityBase: { unit: '—', source: 'DS (hit: rock = 0.25 + dmg/12), §4.4 hitstun row' },
    hitstunIntensityPerHp: { unit: '1/HP', source: 'DS (hit: rock = 0.25 + dmg/12), §4.4 hitstun row' },
    landMinJ: { unit: 'J', source: 'NEW: §3 9e "land events for heavy landings": the energy a landing needs to report one' },
    hintImpulsePerNs: { unit: 'per N·s', source: 'DS (projectileStrike impulse = momentum × 0.25): impact event hint' },
    hintImpulseMax: { unit: '—', source: 'DS (projectileStrike impulse cap 60): impact event hint' },
    hintLift: { unit: '—', source: 'DS (projectileStrike lift 0.05): impact event hint' },
    hintHitstopBase: { unit: 'frames', source: 'DS (projectileStrike hitstop 4 + min(8, dmg/3)): impact event hint' },
    hintHitstopPerHp: { unit: 'frames/HP', source: 'DS (projectileStrike hitstop): impact event hint' },
    hintHitstopMax: { unit: 'frames', source: 'DS (projectileStrike hitstop): impact event hint' },
    hintShakeBase: { unit: '—', source: 'DS (projectileStrike shake 0.08 + dmg/50, at most 0.5): impact event hint' },
    hintShakePerHp: { unit: '1/HP', source: 'DS (projectileStrike shake): impact event hint' },
    hintShakeMax: { unit: '—', source: 'DS (projectileStrike shake): impact event hint' },
  },
);

/**
 * What applyImpact reads of the world through `sim.world` (World satisfies it). Checked structurally, so a test's fake
 * WorldPort (or legacy CombatSim, world null) gets the body's answer without slabs, controllers or events.
 */
interface ImpactWorld {
  readonly events: WorldEvent[];
  readonly downed: { queueDv(f: Fighter, dv: V3): void; active(f: Fighter): boolean };
  readonly kcc: { grounded(f: Fighter): boolean };
  readonly ids: { wound: { take(): number } };
  readonly combat: CombatSim;
}

function impactWorld(port: WorldPort | null): ImpactWorld | null {
  const w = port as (WorldPort & Partial<ImpactWorld>) | null;
  return w && Array.isArray(w.events) && w.downed && w.kcc && w.ids && w.combat ? (w as ImpactWorld) : null;
}

/** The DS weight class of a world impact by its HP (projectileStrike's thresholds). */
export function impactWeight(hp: number): Weight {
  return hp > IMPACT_TUNING.weightHeavyHp ? 'heavy' : hp > IMPACT_TUNING.weightMediumHp ? 'medium' : 'light';
}

/** The hit reaction pose for a world impact on `zone` (DS reactionFor without a move: legs low, body folds, head snaps). */
export function impactReaction(zone: HurtZone, weight: Weight): PoseName {
  switch (zone) {
    case 'legs':
      return 'hitLow';
    case 'abdomen':
    case 'chest':
      return 'hitBody';
    case 'head':
      return weight === 'heavy' ? 'stagger' : 'hitHigh';
  }
}

/** m/s: the part of Δv not into the ground (its downward component dropped), the launch test of §4.4. */
export function freeDv(dv: V3): number {
  return Math.hypot(dv.x, Math.max(0, dv.y), dv.z);
}

/**
 * §4.4: the world hit `i` on `i.target`, through the one damage rule.
 *
 * | Output | Rule |
 * |---|---|
 * | HP | hpFromEnergy(E, T); d.hp = max(d.minHp, d.hp − hp); rulers: rulerDamage (§4.6) |
 * | launched | freeDv(dv) ≥ launchDv |
 * | pressed | dv·up ≤ −launchDv (a crush from above): knockdown, no launch |
 * | knockdown | launched or pressed; or, when it reacts, poise ≤ 0 or airborne (DS's jump, or the controller aloft) |
 * | hitstun | otherwise when it reacts: hp > 0 or |dv| ≥ flinchDv |
 * | standing push | not launched or pressed: d.vel += dv_xz (DS slide); launched or pressed: the slab takes dv |
 * | reaction | −M·dv whenever dv was applied (the caller queues it on a dynamic impactor) |
 * | already down | HP applies; dv goes to the slab; never hitstun; a second launch restarts the knockdown |
 * | rising | getup (the slab off): a launch or a press puts it down again, a smaller dv slides it; never hitstun |
 * | KO'd | no HP, no second `ko`; dv to the corpse slab; the `impact` event says `corpse` |
 * | lastKnock | { tick, cause (its credit with the knocker's player), by: cause.fighterId } when |dv| > 0 |
 */
export function applyImpact(sim: CombatSim, i: Impact): ImpactResult {
  const T = IMPACT_TUNING;
  const d = i.target;
  const w = impactWorld(sim.world);
  const dv = { x: i.dv.x, y: i.dv.y, z: i.dv.z };
  const dvLen = Math.hypot(dv.x, dv.y, dv.z);
  const hasDv = dvLen > 0;
  const launchedDv = freeDv(dv) >= T.launchDv;
  const pressed = dv.y <= -T.launchDv;
  const corpse = d.state === 'ko';
  let damage = 0;
  let knockdown = false;
  let launched = false;
  let ko = false;
  let wound = null as ImpactResult['wound'];
  let applied = false;

  if (corpse) {
    // KO'd: no HP and no second `ko` (koFighter would refuse it anyway); the corpse slab takes the blow.
    if (hasDv && w) {
      w.downed.queueDv(d, dv);
      applied = true;
    }
  } else if (d.ruler) {
    // §4.6: wounds, finishing, recovery and the KO are the ruler's rule. A ruler never takes Δv from a world impact
    // (the contact pipeline gives it none: its only momentum transfer is the mover's shove and the impact trip, RF-4).
    damage = hpFromEnergy(i.energy, i.toughness);
    if (w && i.rulerZone) wound = rulerDamage(w, d, damage, i.rulerZone, i.bone, i.cause, vec(i.point));
    ko = d.state === 'ko';
  } else {
    damage = hpFromEnergy(i.energy, i.toughness);
    // TODO "rule 11 (multiplayer): damage from an entity credited to another player knocks down, never kills"
    // (SPEC:72, RR-22): single-player M1 has no other player to credit.
    d.hp = Math.max(d.minHp, d.hp - damage);
    // TODO "impact gore": no wound, sever, tear or blood from world impacts in M1 (DS gore is keyed by weapon id,
    // MAP gap-2 §4.6); the client's blood reads the `impact` event.
    const slab = w?.downed.active(d) ?? false;
    if (d.hp <= 0) {
      d.hp = 0;
      // The corpse goes with the blow: the Δv is queued before the KO, so the slab launched in the next phase 4a has it.
      if (hasDv && w) {
        w.downed.queueDv(d, dv);
        applied = true;
      }
      ko = true;
      sim.koFighter(d, { by: 'impact', killer: impactorFighter(sim, i.cause), cause: i.cause, point: vec(i.point) });
    } else if (d.state === 'knockdown' || slab) {
      // Already down (the slab, or knocked down earlier this tick and launched in the next 4a): HP applies, the slab
      // takes Δv, never hitstun; a second launch restarts the knockdown (stunFrames from its start).
      if (hasDv && w) {
        w.downed.queueDv(d, dv);
        applied = true;
      }
      if (launchedDv) {
        launched = true;
        if (d.state === 'knockdown') d.enterKnockdown();
      }
    } else if (d.state === 'getup') {
      // Rising (the zones are back, the slab is not): only a launch or a press puts it down again; never hitstun.
      // INTERPRETATION (§4.4's "already down" row sends getup's Δv to the slab): the slab is off while rising, and
      // DownedBodies drops a Δv queued for a fighter that isn't going down, so a smaller Δv slides the body (DS slide)
      // instead of putting it down again for any Δv at all.
      if (launchedDv || pressed) {
        knockdown = true;
        launched = launchedDv;
        d.enterKnockdown();
        if (w) w.downed.queueDv(d, dv);
        else addXZ(d, dv);
        applied = hasDv;
      } else if (hasDv) {
        addXZ(d, dv);
        applied = true;
      }
    } else {
      // Standing.
      d.poise -= T.poisePerHp * damage * (i.sharpness === 0 ? T.bluntPoiseMul : 1) * (1 - d.stats.staggerResist);
      // INTERPRETATION (§4.4's knockdown row says isAirborne()): DS's authored jump, or the controller off the ground
      // (a fall, a world-mode jump), which isAirborne() doesn't see.
      const airborne = d.isAirborne() || (w ? !w.kcc.grounded(d) : false);
      // INTERPRETATION (§4.4's knockdown row has no such condition): a poise ≤ 0 or airborne knockdown needs an impact
      // that reacts at all (hp > 0 or |Δv| ≥ flinchDv, the hitstun row's test); a 0 HP, Δv-less touch (E under an
      // armoured zone's T) moves nobody. Launched and pressed always react (their |Δv| ≥ launchDv).
      const reacts = damage > 0 || dvLen >= T.flinchDv;
      if (reacts && (d.poise <= 0 || launchedDv || pressed || airborne)) {
        knockdown = true;
        launched = launchedDv;
        d.enterKnockdown();
        d.buffer = null;
        d.counter = null;
        if ((launchedDv || pressed) && w) w.downed.queueDv(d, dv);
        else addXZ(d, dv);
      } else {
        if (reacts) {
          const weight = impactWeight(damage);
          d.enterHitstun(
            Math.round(T.hitstunBase + T.hitstunPerHp * damage),
            impactReaction(i.zone, weight),
            T.hitstunIntensityBase + T.hitstunIntensityPerHp * damage,
          );
          d.buffer = null;
          d.counter = null;
        }
        addXZ(d, dv);
      }
      applied = hasDv;
    }
  }
  // Every world knock is remembered (environmental kills, §4.4), after the KO's own classification read the knock
  // before it. Its cause credits the knocker as DS's knock() does ([attacker.playerId]): the entity's credit plus the
  // player of the fighter that holds or threw it, so a thrown stone whose own credit doesn't name its thrower still
  // credits him with the fall that follows (isEnvironmental reads the knocker's player id from lastKnock.cause.credit).
  if (hasDv && !d.ruler) d.lastKnock = { tick: sim.frame, cause: knockCause(sim, i.cause), by: i.cause.fighterId };

  const reaction = applied ? { x: -d.mass * dv.x, y: -d.mass * dv.y, z: -d.mass * dv.z } : { x: 0, y: 0, z: 0 };
  if (w) w.events.push(impactEvent(sim.frame, i, damage, knockdown, launched, ko, corpse, wound));
  return { damage, knockdown, launched, ko, reaction, wound };
}

/**
 * §4.4 "Environmental kills" (SPEC:415, D-31): whether a KO counts as the world's, and who gets the credit. With
 * W = round(envKillWindowS / DT) (120 ticks), inclusive:
 * 1. by 'impact' of an entity nobody holds (stakes, logs, boulders, felled trees, swinging logs; a thrown object is held
 *    until its first contact or rest) → environmental; credit = the entity's ∪ the knocker's when knocked within W;
 * 2. by 'impact' of the terrain (a fall, the ledge) with a knock within W → environmental; credit = the knocker's;
 *    (the knocker's player id is lastKnock.cause.credit: DS's knock() writes [attacker.playerId] there, and applyImpact
 *    the entity's credit plus the player of the fighter holding or throwing it)
 * 3. everything else (strikes, thrown weapons, fatal and severing blows, bleeding, a creature's body) → not; credit =
 *    the cause's ∪ the killer's player id.
 * Credit is sorted and de-duplicated.
 */
export function isEnvironmental(d: Fighter, finish: Finish, tick: number): { environmental: boolean; credit: string[] } {
  const W = Math.round(IMPACT_TUNING.envKillWindowS / DT);
  const k = d.lastKnock;
  const recent = k !== null && tick >= k.tick && tick - k.tick <= W;
  const knocker = recent ? k.cause.credit : [];
  const c = finish.cause;
  if (finish.by === 'impact' && c) {
    if (c.kind === 'entity' && !c.held) return { environmental: true, credit: credits(c.credit, knocker) };
    if (c.kind === 'terrain' && recent) return { environmental: true, credit: credits(knocker) };
  }
  const killer = finish.killer?.playerId;
  return { environmental: false, credit: credits(c?.credit ?? [], killer ? [killer] : []) };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The fighter the cause names (a creature's body, or the thrower of a held object), if it is still in the sim. */
function impactorFighter(sim: CombatSim, cause: ImpactCause): Fighter | null {
  if (cause.fighterId === null) return null;
  return sim.fighters.find((f) => f.id === cause.fighterId) ?? null;
}

/** The cause a knock remembers: `cause` with the knocker's player id in its credit (unchanged when it is already there). */
function knockCause(sim: CombatSim, cause: ImpactCause): ImpactCause {
  const player = impactorFighter(sim, cause)?.playerId;
  if (!player || cause.credit.includes(player)) return cause;
  return { ...cause, credit: credits(cause.credit, [player]) };
}

/** d.vel += dv_xz (DS's knockback slide). */
function addXZ(d: Fighter, dv: V3): void {
  d.vel.x += dv.x;
  d.vel.z += dv.z;
}

function vec(p: V3): Vector3 {
  return new Vector3(p.x, p.y, p.z);
}

function credits(...lists: readonly (readonly string[])[]): string[] {
  const s = new Set<string>();
  for (const l of lists) for (const c of l) s.add(c);
  return [...s].sort();
}

/** The `impact` world event (§2.13) with DS's presentation hints (projectileStrike's weight, impulse, lift, hitstop, shake). */
function impactEvent(
  tick: number,
  i: Impact,
  damage: number,
  knockdown: boolean,
  launched: boolean,
  ko: boolean,
  corpse: boolean,
  wound: ImpactResult['wound'],
): WorldEvent {
  const T = IMPACT_TUNING;
  const dvLen = Math.hypot(i.dv.x, i.dv.y, i.dv.z);
  // The way the blow went: along Δv, or into the target (the normal points out of it).
  const dir = dvLen > 0 ? { x: i.dv.x / dvLen, y: i.dv.y / dvLen, z: i.dv.z / dvLen } : { x: -i.normal.x, y: -i.normal.y, z: -i.normal.z };
  const momentum = Number.isFinite(i.mEff) ? i.mEff * i.vn : 0;
  return {
    type: 'impact',
    tick,
    defender: i.target,
    point: { x: i.point.x, y: i.point.y, z: i.point.z },
    normal: { x: i.normal.x, y: i.normal.y, z: i.normal.z },
    dir,
    zone: i.zone,
    bone: i.bone,
    rulerZone: i.rulerZone,
    energy: i.energy,
    toughness: i.toughness,
    damage,
    dv: { x: i.dv.x, y: i.dv.y, z: i.dv.z },
    knockdown,
    launched,
    ko,
    corpse,
    weight: impactWeight(damage),
    impulse: Math.min(T.hintImpulseMax, momentum * T.hintImpulsePerNs),
    lift: T.hintLift,
    hitstop: Math.round(T.hintHitstopBase + Math.min(T.hintHitstopMax, damage * T.hintHitstopPerHp)),
    shake: Math.min(T.hintShakeMax, T.hintShakeBase + damage * T.hintShakePerHp),
    cause: i.cause,
    wound,
  };
}
