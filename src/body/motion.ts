/**
 * Contextual movement. How a fighter moves is not a fixed style: it is re-blended every
 * frame from the situation — how far away the opponent is, how hurt and tired the
 * fighter is, whether a strike is coming, whether they are pressing an advantage — and
 * smoothed so changes in posture and rhythm are gradual.
 */

export interface MotionProfile {
  /** Movement speed (× walk speed). */
  speed: number;
  /** Stride length (× step trigger distance): bigger means longer, less frequent steps. */
  stride: number;
  /** Step duration (× base step frames). */
  stepFrames: number;
  /** Step lift (× base step height). */
  stepHeight: number;
  /** Stance width (× base stance). */
  stance: number;
  /** Hip height offset (m, negative = sitting lower). */
  crouch: number;
  /** Extra forward lean of the torso (rad). */
  lean: number;
  /** Guard height / reach offsets (m). */
  guardY: number;
  guardZ: number;
  /** Rhythm bounce amplitude and frequency (×). */
  bounce: number;
  bounceHz: number;
  /** Weight-shift sway (×). */
  sway: number;
  /** Head and shoulder movement (×). */
  head: number;
  /** Feint and lead-hand paw frequency (×; 0 = none). */
  feints: number;
  paws: number;
  /** 0 = fighting footwork and stance, 1 = normal walking (square hips, arm swing). */
  gait: number;
}

export type Zone = 'pocket' | 'striking' | 'outside' | 'roaming';

export const ZONE_PROFILES: Record<Zone, MotionProfile> = {
  // Toe to toe: sit low, tight high guard, small quick steps, lots of head movement, little bounce.
  pocket: { speed: 0.45, stride: 0.7, stepFrames: 0.85, stepHeight: 0.6, stance: 0.92, crouch: -0.05, lean: 0.08, guardY: 0.03, guardZ: -0.05, bounce: 0.3, bounceHz: 0.85, sway: 0.7, head: 1.6, feints: 0.6, paws: 0.3, gait: 0 },
  // Punching range: active, balanced, feinting and pawing to create openings.
  striking: { speed: 0.58, stride: 1, stepFrames: 1, stepHeight: 1, stance: 1, crouch: -0.01, lean: 0.03, guardY: 0, guardZ: 0, bounce: 0.75, bounceHz: 1, sway: 1, head: 1, feints: 1, paws: 1, gait: 0 },
  // Kicking range / measuring distance: longer stance, lighter rhythm, pawing to find range.
  outside: { speed: 0.78, stride: 1.45, stepFrames: 1.05, stepHeight: 1.1, stance: 1.06, crouch: 0, lean: 0, guardY: -0.03, guardZ: 0.02, bounce: 0.9, bounceHz: 1, sway: 1, head: 0.8, feints: 0.7, paws: 1.3, gait: 0 },
  // Far away: run with long strides and a big arm swing, no fighting bounce.
  roaming: { speed: 1.45, stride: 2.7, stepFrames: 1.35, stepHeight: 1.8, stance: 0.85, crouch: 0.03, lean: -0.02, guardY: -0.17, guardZ: -0.07, bounce: 0.12, bounceHz: 0.6, sway: 0.4, head: 0.3, feints: 0, paws: 0, gait: 1 },
};

/** Distance bands (m): [full, blend-out] for each zone boundary. */
export const ZONE_RANGES = { pocket: 1.15, pocketBlend: 1.5, striking: 2.3, strikingBlend: 2.7, outside: 3.6, outsideBlend: 4.6 };

export interface MotionInputs {
  /** Distance to the opponent (Infinity when there is none). */
  dist: number;
  hpFrac: number;
  guardFrac: number;
  framesSinceHit: number;
  /** 0 = gassed, 1 = fresh. */
  stamina?: number;
  /** An opponent strike is winding up / live and in range. */
  threat: boolean;
  /** The opponent is down or getting up. */
  opponentDown: boolean;
  /** We are on top: opponent hurt, or we landed recently. */
  pressing: boolean;
}

export type MotionMods = 'hurt' | 'guardLow' | 'threat' | 'cautious' | 'pressing' | 'opponentDown' | 'tired';

const KEYS = Object.keys(ZONE_PROFILES.striking) as (keyof MotionProfile)[];

export function blendProfiles(weights: Partial<Record<Zone, number>>, out: MotionProfile): MotionProfile {
  let total = 0;
  for (const w of Object.values(weights)) total += w ?? 0;
  for (const k of KEYS) {
    let v = 0;
    for (const [z, w] of Object.entries(weights) as [Zone, number][]) v += ZONE_PROFILES[z][k] * w;
    out[k] = v / (total || 1);
  }
  return out;
}

const ramp = (x: number, a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));

export function zoneWeights(dist: number): Record<Zone, number> {
  const R = ZONE_RANGES;
  if (!Number.isFinite(dist)) return { pocket: 0, striking: 0, outside: 0, roaming: 1 };
  const toStriking = ramp(dist, R.pocket, R.pocketBlend);
  const toOutside = ramp(dist, R.striking, R.strikingBlend);
  const toRoaming = ramp(dist, R.outside, R.outsideBlend);
  return {
    pocket: 1 - toStriking,
    striking: toStriking * (1 - toOutside),
    outside: toOutside * (1 - toRoaming),
    roaming: toRoaming,
  };
}

/** Target profile for the current situation, plus how strongly each modifier applies. */
export function targetProfile(i: MotionInputs, out: MotionProfile): { weights: Record<Zone, number>; mods: Record<MotionMods, number> } {
  const weights = zoneWeights(i.dist);
  blendProfiles(weights, out);
  const mods: Record<MotionMods, number> = {
    hurt: ramp(0.4 - i.hpFrac, 0, 0.3),
    guardLow: ramp(0.35 - i.guardFrac, 0, 0.25),
    threat: i.threat ? 1 : 0,
    cautious: i.framesSinceHit < 90 ? 1 - i.framesSinceHit / 90 : 0,
    pressing: i.pressing ? 1 : 0,
    opponentDown: i.opponentDown ? 1 : 0,
    tired: ramp(0.45 - (i.stamina ?? 1), 0, 0.35),
  };
  const m = mods;
  // Gassed: hands sag, the bounce and the feints go, feet get heavy.
  out.guardY -= 0.07 * m.tired;
  out.bounce *= 1 - 0.7 * m.tired;
  out.feints *= 1 - 0.7 * m.tired;
  out.paws *= 1 - 0.5 * m.tired;
  out.speed *= 1 - 0.15 * m.tired;
  out.stepFrames *= 1 + 0.2 * m.tired;
  out.crouch -= 0.015 * m.tired;
  // Hurt / tired: heavier, slower, hands drop, rhythm dies, a bit wobbly.
  out.speed *= 1 - 0.18 * m.hurt;
  out.stepFrames *= 1 + 0.25 * m.hurt;
  out.bounce *= 1 - 0.65 * m.hurt;
  out.bounceHz *= 1 - 0.2 * m.hurt;
  out.guardY -= 0.08 * m.hurt;
  out.crouch -= 0.02 * m.hurt;
  out.sway *= 1 + 0.35 * m.hurt;
  out.feints *= 1 - 0.6 * m.hurt;
  // Guard running low: shell up tighter.
  out.guardY += 0.04 * m.guardLow;
  out.guardZ -= 0.05 * m.guardLow;
  out.head *= 1 + 0.3 * m.guardLow;
  // Strike incoming: plant, sit down, stop feinting.
  out.bounce *= 1 - 0.8 * m.threat;
  out.crouch -= 0.03 * m.threat;
  out.guardY += 0.02 * m.threat;
  out.feints *= 1 - m.threat;
  out.paws *= 1 - m.threat;
  // Just got hit: cautious — hands up, head moving, less bounce.
  out.head *= 1 + 0.6 * m.cautious;
  out.guardY += 0.03 * m.cautious;
  out.bounce *= 1 - 0.3 * m.cautious;
  out.speed *= 1 - 0.06 * m.cautious;
  out.feints *= 1 - 0.5 * m.cautious;
  // On top: stalk forward, more feints, more spring.
  out.bounce *= 1 + 0.2 * m.pressing;
  out.feints *= 1 + 0.5 * m.pressing;
  out.lean += 0.03 * m.pressing;
  out.speed *= 1 + 0.06 * m.pressing;
  // Opponent down: relax, hands lower, circle.
  out.guardY -= 0.08 * m.opponentDown;
  out.bounce *= 1 - 0.5 * m.opponentDown;
  out.feints *= 1 - m.opponentDown;
  out.paws *= 1 - m.opponentDown;
  out.sway *= 1 - 0.4 * m.opponentDown;
  // A strike coming in always snaps you back into stance.
  out.gait *= 1 - m.threat;
  return { weights, mods };
}

export function makeProfile(): MotionProfile {
  return { ...ZONE_PROFILES.striking };
}

/** Exponential smoothing toward a target profile (rate per frame). */
export function smoothProfile(cur: MotionProfile, target: MotionProfile, rate: number) {
  for (const k of KEYS) cur[k] += (target[k] - cur[k]) * rate;
}
