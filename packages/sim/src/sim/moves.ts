import type { Ease } from './math';
import type { PoseName } from '../body/poses';

export type Height = 'high' | 'mid' | 'low';
export type DefenseKind = 'block' | 'duck' | 'weave' | 'slide';
export type Limb = 'handL' | 'handR' | 'footL' | 'footR';
/** Strike shape, used by auto-defense to pick a reaction. */
export type StrikeKind = 'straight' | 'hook' | 'uppercut' | 'kick' | 'sweep';
export type Weight = 'light' | 'medium' | 'heavy';

/** How far round (0..1 of the whole turn) a spin has got by `frame`. */
export function spinProgress(sp: NonNullable<MoveDef['spin']>, frame: number): number {
  const ease = (u: number) => u * u * (3 - 2 * u);
  const seg = (a: number, b: number) => Math.min(1, Math.max(0, (frame - a) / Math.max(1, b - a)));
  if (!sp.hold) return ease(seg(sp.from, sp.to));
  return 0.5 * ease(seg(sp.from, sp.hold[0])) + 0.5 * ease(seg(sp.hold[1], sp.to));
}

/** Keyframe time marker: [phase, fraction] where phase is startup/active/recovery. */
export type Marker = ['s' | 'a' | 'r', number];

export interface Key {
  at: Marker;
  pose: PoseName;
  ease?: Ease;
}

/**
 * Where a strike is aimed. Each throw picks one, so the same button doesn't always land
 * on the same spot: jabs to the head or body, hooks to the head or liver, kicks to the
 * thigh, calf or ribs... An aim can change the strike's height class (body shots are
 * mid-height attacks for hit detection and for automatic defense).
 */
export interface Aim {
  id: string;
  weight: number;
  /** Added to the striking fist/foot IK target in the active key poses (fighter-local). */
  offset?: [number, number, number];
  height?: Height;
  /** Weapons: aim the striking part this far above (+) or below (-) the part's middle (m). */
  edgeDy?: number;
  /** Added to body angles / root in the active key poses (level change, hip turnover...). */
  add?: Partial<Record<'root' | 'pelvis' | 'abdomen' | 'chest' | 'head', [number, number, number]>>;
}

export interface MoveDef {
  id: string;
  name: string;
  /** Frames (60 fps). */
  startup: number;
  active: number;
  recovery: number;
  limb: Limb;
  height: Height;
  kind: StrikeKind;
  weight: Weight;
  damage: number;
  guardDamage: number;
  /** Stagger build-up; enough of it knocks the target down. */
  poiseDamage: number;
  hitstun: number;
  blockstun: number;
  /** Knockback speed applied to the target's body (m/s). */
  knockback: number;
  knockdown?: boolean;
  /** Ragdoll impulse magnitude (N·s) at the contact point. */
  impulse: number;
  /** Upward share of the impulse direction (0..1). */
  lift?: number;
  hitstop: number;
  shake: number;
  /** Strike sphere radius (m). */
  radius: number;
  /** Rough reach from the attacker's centre, used by AI and auto-defense to judge threat. */
  reach: number;
  lunge?: { from: number; to: number; distance: number };
  /** Ignores interruption by light hits during these frames (relative to move start). */
  armor?: [number, number];
  /** Airborne/low-profile frames that make low/high attacks whiff (relative to move start). */
  evades?: { from: number; to: number; heights: Height[] };
  /**
   * Off the ground for frames [from, to): a real jump. How high follows from how long
   * (apex = g·t²/8 — no hanging in the air), the horizontal speed is fixed at take-off
   * (no steering in mid-air), and the body turns at a constant rate: `flip` radians of
   * somersault (+ forward, − backward) about the centre of mass.
   */
  air?: { from: number; to: number; flip?: number };
  /**
   * The whole body turns through `turns` revolutions over frames [from, to), easing in
   * and out — stopping dead over `hold` (half the turn either side), as a spinning back
   * kick stops turning while the leg drives out.
   */
  spin?: { from: number; to: number; turns: number; hold?: [number, number] };
  /**
   * Lets go at frame `release`: the weapon in hand (or one from the belt: `ammo`)
   * flies at `speed` m/s, turning end over end at about `spin` rev/s (0 = point first).
   */
  throw?: { release: number; speed: number; spin: number; ammo?: boolean };
  /** Strikes nothing itself (an evasive flip; a throw — the weapon does the hitting). */
  noHit?: boolean;
  blockable: boolean;
  /**
   * 'upper': hands-only strike; while moving, the legs keep walking underneath and the
   * fighter can keep stepping. 'full' (default): whole-body move that carries momentum.
   */
  layer?: 'upper' | 'full';
  /** Struck with the weapon in hand (hit detection along the blade; damage × weapon). */
  weapon?: boolean;
  /** Target options (first = primary). Omitted: always the authored target. */
  aims?: Aim[];
  /** Moves this can cancel into, and the window (relative to move start) where that is allowed. */
  cancel?: { into: string[]; from: number; to: number };
  keys: Key[];
}

export const PUNCH_RANGE = 1.3;
export const SLIDE_RANGE_MIN = 1.4;
export const SLIDE_RANGE_MAX = 3.0;
export const GAZELLE_RANGE = 2.5;
export const FLYING_KICK_MIN = 1.8;
export const FLYING_KICK_MAX = 4.1;

const BODY_PUNCH = (drop = 0.34): Aim => ({
  id: 'body',
  weight: 1.4,
  offset: [0.02, -drop, -0.06],
  height: 'mid',
  // Level change: bend the knees and dip toward the body shot.
  add: { root: [0, -0.09, 0], abdomen: [0.14, 0, 0] },
});
const HEAD: Aim = { id: 'head', weight: 3 };

const strike = (wind: PoseName, ext: PoseName, recover: PoseName = 'guard', follow?: PoseName): Key[] => {
  const keys: Key[] = [
    // Smooth in and out of each key: the fist gathers, then accelerates through the
    // line and arrives (no segment starting at full speed from a standstill).
    { at: ['s', 0.55], pose: wind, ease: 'inOut' },
    { at: ['a', 0], pose: ext, ease: 'inOut' },
  ];
  if (follow) keys.push({ at: ['a', 1], pose: follow, ease: 'out' });
  else keys.push({ at: ['a', 1], pose: ext });
  // Snap back along the same line: most of the retraction happens early in recovery.
  keys.push({ at: ['r', 0.5], pose: recover, ease: 'out' });
  return keys;
};

export const PLAYER_MOVES: Record<string, MoveDef> = {
  jab: {
    id: 'jab', name: 'Jab',
    layer: 'upper',
    startup: 6, active: 3, recovery: 13,
    limb: 'handL', height: 'high', kind: 'straight', weight: 'light',
    damage: 4, guardDamage: 6, poiseDamage: 8, hitstun: 16, blockstun: 10,
    knockback: 0.8, impulse: 9, hitstop: 4, shake: 0.12, radius: 0.12, reach: 1.3,
    lunge: { from: 1, to: 6, distance: 0.18 },
    blockable: true,
    cancel: { into: ['jab', 'cross', 'frontKick', 'lowKick'], from: 7, to: 22 },
    aims: [HEAD, BODY_PUNCH(0.33)],
    keys: strike('jabWind', 'jabExt'),
  },
  cross: {
    id: 'cross', name: 'Cross',
    layer: 'upper',
    startup: 8, active: 3, recovery: 15,
    limb: 'handR', height: 'high', kind: 'straight', weight: 'medium',
    damage: 7, guardDamage: 10, poiseDamage: 16, hitstun: 20, blockstun: 12,
    knockback: 1.3, impulse: 14, hitstop: 6, shake: 0.2, radius: 0.12, reach: 1.35,
    lunge: { from: 1, to: 8, distance: 0.22 },
    blockable: true,
    cancel: { into: ['hook', 'frontKick', 'lowKick'], from: 9, to: 26 },
    aims: [HEAD, BODY_PUNCH(0.35)],
    keys: strike('crossWind', 'crossExt'),
  },
  hook: {
    id: 'hook', name: 'Hook',
    layer: 'upper',
    startup: 10, active: 4, recovery: 19,
    limb: 'handL', height: 'high', kind: 'hook', weight: 'heavy',
    damage: 10, guardDamage: 18, poiseDamage: 40, hitstun: 28, blockstun: 14,
    knockback: 2.6, impulse: 24, lift: 0.1, hitstop: 9, shake: 0.38, radius: 0.15, reach: 1.1,
    lunge: { from: 2, to: 10, distance: 0.2 },
    blockable: true,
    cancel: { into: ['cross', 'lowKick'], from: 15, to: 33 },
    aims: [HEAD, { ...BODY_PUNCH(0.38), id: 'liver' }],
    keys: [
      { at: ['s', 0.4], pose: 'hookWind', ease: 'inOut' },
      { at: ['s', 0.72], pose: 'hookMid', ease: 'in' },
      { at: ['a', 0], pose: 'hookExt', ease: 'out' },
      { at: ['a', 1], pose: 'hookFollow', ease: 'out' },
      { at: ['r', 0.6], pose: 'guard', ease: 'out' },
    ],
  },
  counterHook: {
    id: 'counterHook', name: 'Counter Hook',
    layer: 'upper',
    startup: 8, active: 4, recovery: 18,
    limb: 'handL', height: 'high', kind: 'hook', weight: 'heavy',
    damage: 13, guardDamage: 25, poiseDamage: 60, hitstun: 32, blockstun: 16,
    knockback: 3.0, impulse: 30, lift: 0.1, hitstop: 11, shake: 0.45, radius: 0.16, reach: 1.2,
    lunge: { from: 1, to: 8, distance: 0.3 },
    blockable: true,
    cancel: { into: ['cross', 'lowKick'], from: 13, to: 30 },
    aims: [HEAD, { ...BODY_PUNCH(0.38), id: 'liver' }],
    keys: [
      { at: ['s', 0.4], pose: 'hookWind', ease: 'inOut' },
      { at: ['s', 0.85], pose: 'hookMid', ease: 'in' },
      { at: ['a', 0], pose: 'hookExt', ease: 'linear' },
      { at: ['a', 1], pose: 'hookFollow', ease: 'out' },
      { at: ['r', 0.6], pose: 'guard', ease: 'out' },
    ],
  },
  counterCross: {
    id: 'counterCross', name: 'Counter Cross',
    layer: 'upper',
    startup: 5, active: 3, recovery: 14,
    limb: 'handR', height: 'high', kind: 'straight', weight: 'medium',
    damage: 8, guardDamage: 12, poiseDamage: 22, hitstun: 22, blockstun: 12,
    knockback: 1.5, impulse: 16, hitstop: 7, shake: 0.24, radius: 0.13, reach: 1.45,
    lunge: { from: 0, to: 5, distance: 0.25 },
    blockable: true,
    cancel: { into: ['hook', 'frontKick', 'lowKick'], from: 6, to: 22 },
    aims: [HEAD, BODY_PUNCH(0.35)],
    keys: strike('crossWind', 'crossExt'),
  },
  uppercut: {
    id: 'uppercut', name: 'Uppercut',
    startup: 6, active: 4, recovery: 22,
    limb: 'handR', height: 'high', kind: 'uppercut', weight: 'heavy',
    damage: 14, guardDamage: 25, poiseDamage: 100, hitstun: 30, blockstun: 16,
    knockback: 2.2, knockdown: true, impulse: 34, lift: 0.75, hitstop: 12, shake: 0.55, radius: 0.16, reach: 1.2,
    lunge: { from: 0, to: 7, distance: 0.38 },
    blockable: true,
    keys: [
      { at: ['s', 0.3], pose: 'upperWind', ease: 'out' },
      { at: ['a', 0], pose: 'upperExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'upperExt' },
      { at: ['r', 0.6], pose: 'guard', ease: 'out' },
    ],
  },
  gazelle: {
    id: 'gazelle', name: 'Gazelle Punch',
    startup: 13, active: 4, recovery: 19,
    limb: 'handL', height: 'high', kind: 'uppercut', weight: 'heavy',
    damage: 11, guardDamage: 20, poiseDamage: 45, hitstun: 26, blockstun: 14,
    knockback: 3.0, impulse: 28, lift: 0.4, hitstop: 10, shake: 0.42, radius: 0.16, reach: 2.45,
    lunge: { from: 4, to: 15, distance: 1.45 },
    blockable: true,
    keys: [
      { at: ['s', 0.35], pose: 'gazelleWind', ease: 'out' },
      { at: ['s', 0.6], pose: 'gazelleWind' },
      { at: ['a', 0], pose: 'gazelleExt', ease: 'out' },
      { at: ['a', 1], pose: 'gazelleExt' },
      { at: ['r', 0.85], pose: 'guard', ease: 'inOut' },
    ],
  },
  frontKick: {
    id: 'frontKick', name: 'Push Kick',
    startup: 10, active: 4, recovery: 17,
    limb: 'footL', height: 'mid', kind: 'kick', weight: 'medium',
    damage: 6, guardDamage: 40, poiseDamage: 25, hitstun: 22, blockstun: 18,
    knockback: 4.6, impulse: 26, lift: 0.1, hitstop: 7, shake: 0.28, radius: 0.17, reach: 1.2,
    blockable: true,
    aims: [
      { id: 'stomach', weight: 3 },
      { id: 'chest', weight: 1.5, offset: [0, 0.22, -0.03] },
      { id: 'thigh', weight: 1, offset: [0, -0.38, -0.06], height: 'low' },
    ],
    keys: [
      { at: ['s', 0.6], pose: 'kickChamber', ease: 'out' },
      { at: ['a', 0], pose: 'kickExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'kickExt' },
      { at: ['r', 0.4], pose: 'kickChamber', ease: 'inOut' },
      { at: ['r', 0.95], pose: 'guard', ease: 'inOut' },
    ],
  },
  lowKick: {
    id: 'lowKick', name: 'Low Kick',
    startup: 10, active: 4, recovery: 16,
    limb: 'footR', height: 'low', kind: 'kick', weight: 'medium',
    damage: 6, guardDamage: 10, poiseDamage: 35, hitstun: 20, blockstun: 12,
    knockback: 1.0, impulse: 16, lift: 0.2, hitstop: 6, shake: 0.22, radius: 0.17, reach: 1.45,
    lunge: { from: 1, to: 10, distance: 0.22 },
    blockable: false,
    aims: [
      { id: 'thigh', weight: 3 },
      { id: 'calf', weight: 1.5, offset: [0, -0.2, 0.02] },
      // Body roundhouse: hips turn over even further, kick lands on the ribs.
      { id: 'ribs', weight: 2.5, offset: [0.04, 0.58, -0.02], height: 'mid', add: { root: [0, 0.03, 0], pelvis: [0, 0.3, 0], abdomen: [0, 0, -0.16] } },
    ],
    keys: [
      { at: ['s', 0.35], pose: 'lowKickWind', ease: 'inOut' },
      { at: ['s', 0.62], pose: 'lowKickTurn', ease: 'in' },
      { at: ['a', 0], pose: 'lowKickExt', ease: 'out' },
      { at: ['a', 1], pose: 'lowKickExt' },
      { at: ['r', 0.45], pose: 'lowKickRecover', ease: 'inOut' },
      { at: ['r', 0.95], pose: 'guard', ease: 'inOut' },
    ],
  },
  flyingKick: {
    id: 'flyingKick', name: 'Flying Kick',
    startup: 18, active: 6, recovery: 22,
    limb: 'footL', height: 'mid', kind: 'kick', weight: 'heavy',
    damage: 12, guardDamage: 35, poiseDamage: 100, hitstun: 30, blockstun: 18,
    knockback: 3.8, knockdown: true, impulse: 40, lift: 0.3, hitstop: 11, shake: 0.6, radius: 0.2, reach: 4.05,
    lunge: { from: 5, to: 22, distance: 2.6 },
    evades: { from: 8, to: 24, heights: ['low'] },
    blockable: true,
    aims: [
      { id: 'chest', weight: 3 },
      { id: 'head', weight: 1, offset: [0, 0.25, 0], height: 'high' },
    ],
    keys: [
      { at: ['s', 0.3], pose: 'flyCrouch', ease: 'out' },
      { at: ['s', 0.65], pose: 'flyAir', ease: 'out' },
      { at: ['a', 0], pose: 'flyExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'flyExt' },
      { at: ['r', 0.35], pose: 'flyLand', ease: 'in' },
      { at: ['r', 0.95], pose: 'guard', ease: 'inOut' },
    ],
  },
  slideKick: {
    id: 'slideKick', name: 'Sliding Strike',
    startup: 7, active: 8, recovery: 20,
    limb: 'footL', height: 'low', kind: 'sweep', weight: 'heavy',
    damage: 10, guardDamage: 20, poiseDamage: 100, hitstun: 30, blockstun: 16,
    knockback: 2.0, knockdown: true, impulse: 26, lift: 0.5, hitstop: 9, shake: 0.4, radius: 0.2, reach: 3.1,
    lunge: { from: 0, to: 14, distance: 1.7 },
    evades: { from: 2, to: 18, heights: ['high'] },
    blockable: false,
    keys: [
      { at: ['s', 0.6], pose: 'slideKickExt', ease: 'inOut' },
      { at: ['a', 0], pose: 'slideKickExt' },
      { at: ['a', 1], pose: 'slideKickExt' },
      { at: ['r', 0.5], pose: 'kneel', ease: 'inOut' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  },
};

export const ENEMY_MOVES: Record<string, MoveDef> = {
  straight: {
    id: 'straight', name: 'Straight',
    layer: 'upper',
    startup: 20, active: 3, recovery: 20,
    limb: 'handR', height: 'high', kind: 'straight', weight: 'medium',
    damage: 8, guardDamage: 14, poiseDamage: 25, hitstun: 22, blockstun: 12,
    knockback: 1.6, impulse: 16, hitstop: 7, shake: 0.3, radius: 0.13, reach: 1.45,
    lunge: { from: 12, to: 22, distance: 0.3 },
    blockable: true,
    cancel: { into: ['hookChain'], from: 23, to: 34 },
    aims: [HEAD, { id: 'chin', weight: 1.5, offset: [0.03, -0.06, 0] }],
    keys: [
      { at: ['s', 0.7], pose: 'straightWind', ease: 'out' },
      { at: ['a', 0], pose: 'straightExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'straightExt' },
      { at: ['r', 0.85], pose: 'guard', ease: 'inOut' },
    ],
  },
  hook: {
    id: 'hook', name: 'Haymaker',
    layer: 'upper',
    startup: 26, active: 4, recovery: 24,
    limb: 'handL', height: 'high', kind: 'hook', weight: 'heavy',
    damage: 13, guardDamage: 28, poiseDamage: 50, hitstun: 28, blockstun: 16,
    knockback: 2.8, impulse: 28, lift: 0.1, hitstop: 10, shake: 0.5, radius: 0.16, reach: 1.35,
    lunge: { from: 14, to: 28, distance: 0.35 },
    armor: [8, 26],
    blockable: true,
    aims: [HEAD, { ...BODY_PUNCH(0.36), id: 'body', weight: 1.2 }],
    keys: [
      { at: ['s', 0.7], pose: 'ehookWind', ease: 'out' },
      { at: ['a', 0], pose: 'ehookExt', ease: 'linear' },
      { at: ['a', 1], pose: 'ehookFollow', ease: 'out' },
      { at: ['r', 0.85], pose: 'guard', ease: 'inOut' },
    ],
  },
  body: {
    id: 'body', name: 'Body Blow',
    layer: 'upper',
    startup: 22, active: 4, recovery: 20,
    limb: 'handR', height: 'mid', kind: 'straight', weight: 'medium',
    damage: 9, guardDamage: 26, poiseDamage: 30, hitstun: 24, blockstun: 16,
    knockback: 1.8, impulse: 18, hitstop: 7, shake: 0.3, radius: 0.15, reach: 1.45,
    lunge: { from: 12, to: 24, distance: 0.3 },
    blockable: true,
    keys: [
      { at: ['s', 0.7], pose: 'bodyWind', ease: 'out' },
      { at: ['a', 0], pose: 'bodyExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'bodyExt' },
      { at: ['r', 0.85], pose: 'guard', ease: 'inOut' },
    ],
  },
  sweep: {
    id: 'sweep', name: 'Leg Sweep',
    startup: 28, active: 5, recovery: 26,
    limb: 'footR', height: 'low', kind: 'sweep', weight: 'heavy',
    damage: 10, guardDamage: 20, poiseDamage: 100, hitstun: 28, blockstun: 16,
    knockback: 1.6, knockdown: true, impulse: 24, lift: 0.6, hitstop: 9, shake: 0.4, radius: 0.2, reach: 1.6,
    lunge: { from: 16, to: 30, distance: 0.35 },
    armor: [10, 28],
    blockable: false,
    keys: [
      { at: ['s', 0.7], pose: 'sweepWind', ease: 'out' },
      { at: ['a', 0], pose: 'sweepExt', ease: 'linear' },
      { at: ['a', 1], pose: 'sweepExt' },
      { at: ['r', 0.85], pose: 'guard', ease: 'inOut' },
    ],
  },
};

// Haymaker thrown as the second hit of a string: shorter wind-up.
ENEMY_MOVES.hookChain = { ...ENEMY_MOVES.hook, id: 'hookChain', startup: 17, armor: [4, 17], lunge: { from: 6, to: 19, distance: 0.35 } };

// ---- Fighting styles: each opponent's own techniques -----------------------
const ALL_HEIGHTS: Height[] = ['high', 'mid', 'low'];
Object.assign(ENEMY_MOVES, {
  // The rookie's wild one: wound up from miles back, looping in, carrying him past.
  haymaker: {
    id: 'haymaker', name: 'Haymaker',
    startup: 24, active: 4, recovery: 28,
    limb: 'handR', height: 'high', kind: 'hook', weight: 'heavy',
    damage: 12, guardDamage: 22, poiseDamage: 45, hitstun: 28, blockstun: 16,
    knockback: 2.2, impulse: 28, hitstop: 9, shake: 0.4, radius: 0.12, reach: 1.45,
    lunge: { from: 10, to: 26, distance: 0.35 },
    blockable: true,
    aims: [HEAD],
    keys: [
      { at: ['s', 0.55], pose: 'haymakerWind', ease: 'inOut' },
      { at: ['a', 0], pose: 'haymakerExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'haymakerFollow', ease: 'out' },
      { at: ['r', 0.65], pose: 'guard', ease: 'inOut' },
    ],
  },
  // The champion's superman punch: a hop off the rear knee closes the distance in the air.
  superman: {
    id: 'superman', name: 'Superman Punch',
    startup: 20, active: 4, recovery: 20,
    limb: 'handR', height: 'high', kind: 'straight', weight: 'heavy',
    damage: 13, guardDamage: 20, poiseDamage: 50, hitstun: 28, blockstun: 14,
    knockback: 2.4, impulse: 30, hitstop: 10, shake: 0.42, radius: 0.12, reach: 2.4,
    lunge: { from: 8, to: 22, distance: 1.1 },
    air: { from: 8, to: 22 },
    blockable: true,
    aims: [HEAD],
    keys: [
      { at: ['s', 0.3], pose: 'smChamber', ease: 'inOut' },
      { at: ['s', 0.7], pose: 'smAir', ease: 'out' },
      { at: ['a', 0], pose: 'smExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'smExt' },
      { at: ['r', 0.4], pose: 'crossExt', ease: 'in' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  },
  jumpKick: {
    id: 'jumpKick', name: 'Jumping Front Kick',
    startup: 20, active: 5, recovery: 22,
    limb: 'footL', height: 'mid', kind: 'kick', weight: 'heavy',
    damage: 12, guardDamage: 26, poiseDamage: 70, hitstun: 28, blockstun: 16,
    knockback: 3.0, impulse: 34, lift: 0.2, hitstop: 10, shake: 0.5, radius: 0.17, reach: 2.3,
    lunge: { from: 6, to: 30, distance: 1.2 },
    air: { from: 6, to: 30 },
    blockable: true,
    aims: [{ id: 'chest', weight: 3 }, { id: 'head', weight: 1, offset: [0, 0.22, 0], height: 'high' }],
    keys: [
      { at: ['s', 0.3], pose: 'flyCrouch', ease: 'out' },
      { at: ['s', 0.65], pose: 'jkAir', ease: 'out' },
      { at: ['a', 0], pose: 'jkExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'jkExt' },
      { at: ['r', 0.35], pose: 'flyLand', ease: 'in' },
      { at: ['r', 0.95], pose: 'guard', ease: 'inOut' },
    ],
  },
  // Spinning back kick: the body turns its back on you — and keeps turning, so the rear
  // leg driving out behind it arrives at you halfway round.
  spinBackKick: {
    id: 'spinBackKick', name: 'Spinning Back Kick',
    startup: 20, active: 4, recovery: 20,
    limb: 'footR', height: 'mid', kind: 'kick', weight: 'heavy',
    damage: 15, guardDamage: 30, poiseDamage: 75, hitstun: 30, blockstun: 16,
    knockback: 3.4, impulse: 38, lift: 0.1, hitstop: 11, shake: 0.55, radius: 0.18, reach: 1.2,
    lunge: { from: 4, to: 20, distance: 0.35 },
    spin: { from: 2, to: 40, turns: 1, hold: [18, 25] },
    blockable: true,
    keys: [
      { at: ['s', 0.3], pose: 'sbkTurn', ease: 'inOut' },
      { at: ['s', 0.55], pose: 'sbkTurn' },
      { at: ['a', 0], pose: 'sbkExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'sbkExt' },
      { at: ['r', 0.5], pose: 'sbkRecover', ease: 'inOut' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  },
  // The bruiser's shoulder charge: a run at you with all his weight behind the shoulder.
  shoulderCharge: {
    id: 'shoulderCharge', name: 'Shoulder Charge',
    startup: 24, active: 6, recovery: 28,
    limb: 'handL', height: 'mid', kind: 'straight', weight: 'heavy',
    damage: 12, guardDamage: 40, poiseDamage: 90, hitstun: 30, blockstun: 22,
    knockback: 4.2, knockdown: true, impulse: 50, lift: 0.15, hitstop: 12, shake: 0.6, radius: 0.2, reach: 3.8,
    lunge: { from: 6, to: 30, distance: 2.8 },
    armor: [6, 30],
    blockable: true,
    keys: [
      { at: ['s', 0.25], pose: 'chargeRun', ease: 'inOut' },
      { at: ['s', 0.9], pose: 'chargeRun' },
      { at: ['a', 0], pose: 'chargeHit', ease: 'inOut' },
      { at: ['a', 1], pose: 'chargeHit' },
      { at: ['r', 0.6], pose: 'guard', ease: 'inOut' },
    ],
  },
  // The demon's pounce: a crouch and a leap from out of reach, both hands raking down.
  pounce: {
    id: 'pounce', name: 'Pounce',
    startup: 34, active: 6, recovery: 24,
    limb: 'handR', height: 'high', kind: 'straight', weight: 'heavy',
    damage: 14, guardDamage: 30, poiseDamage: 80, hitstun: 30, blockstun: 18,
    knockback: 3.2, knockdown: true, impulse: 42, lift: 0.1, hitstop: 12, shake: 0.6, radius: 0.18, reach: 4.25,
    lunge: { from: 8, to: 38, distance: 3.0 },
    air: { from: 8, to: 38 },
    blockable: true,
    keys: [
      { at: ['s', 0.2], pose: 'pounceCrouch', ease: 'inOut' },
      { at: ['s', 0.3], pose: 'pounceCrouch' },
      { at: ['s', 0.55], pose: 'pounceAir', ease: 'out' },
      { at: ['a', 0], pose: 'pounceExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'pounceExt' },
      { at: ['r', 0.35], pose: 'flyLand', ease: 'in' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  },
  // A giant's stomp: whatever's under that foot when it comes down.
  stomp: {
    id: 'stomp', name: 'Stomp',
    startup: 22, active: 4, recovery: 24,
    limb: 'footR', height: 'low', kind: 'kick', weight: 'heavy',
    damage: 13, guardDamage: 30, poiseDamage: 90, hitstun: 30, blockstun: 18,
    knockback: 2.0, knockdown: true, impulse: 40, lift: 0.05, hitstop: 12, shake: 0.7, radius: 0.2, reach: 1.25,
    blockable: false,
    keys: [
      { at: ['s', 0.6], pose: 'stompRaise', ease: 'inOut' },
      { at: ['a', 0], pose: 'stompExt', ease: 'in' },
      { at: ['a', 1], pose: 'stompExt' },
      { at: ['r', 0.6], pose: 'guard', ease: 'inOut' },
    ],
  },
  // A standing back flip out of trouble: about two-thirds of a second in the air.
  backflip: {
    id: 'backflip', name: 'Back Flip',
    startup: 8, active: 40, recovery: 14,
    limb: 'footL', height: 'low', kind: 'kick', weight: 'medium',
    damage: 0, guardDamage: 0, poiseDamage: 0, hitstun: 0, blockstun: 0,
    knockback: 0, impulse: 0, hitstop: 0, shake: 0, radius: 0, reach: 0,
    lunge: { from: 8, to: 48, distance: -1.5 },
    air: { from: 8, to: 48, flip: -Math.PI * 2 },
    evades: { from: 6, to: 48, heights: ALL_HEIGHTS },
    blockable: false,
    noHit: true,
    keys: [
      { at: ['s', 0.9], pose: 'bfCrouch', ease: 'inOut' },
      { at: ['a', 0.05], pose: 'bfLaunch', ease: 'out' },
      { at: ['a', 0.25], pose: 'tuck', ease: 'out' },
      { at: ['a', 0.75], pose: 'tuck' },
      { at: ['a', 1], pose: 'bfOpen', ease: 'inOut' },
      { at: ['r', 0.45], pose: 'bfLand', ease: 'in' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  },
  // Front flip into a heel drop: coming over the top, the straight leg comes down on you.
  frontFlipKick: {
    id: 'frontFlipKick', name: 'Flip Heel Drop',
    startup: 38, active: 7, recovery: 16,
    limb: 'footR', height: 'high', kind: 'kick', weight: 'heavy',
    damage: 14, guardDamage: 30, poiseDamage: 85, hitstun: 30, blockstun: 18,
    knockback: 2.6, knockdown: true, impulse: 40, hitstop: 12, shake: 0.6, radius: 0.18, reach: 2.85,
    lunge: { from: 8, to: 46, distance: 1.7 },
    air: { from: 8, to: 46, flip: Math.PI * 2 },
    evades: { from: 10, to: 44, heights: ['low'] },
    blockable: true,
    keys: [
      { at: ['s', 0.2], pose: 'bfCrouch', ease: 'inOut' },
      { at: ['s', 0.3], pose: 'bfLaunch', ease: 'out' },
      { at: ['s', 0.55], pose: 'tuck', ease: 'out' },
      { at: ['s', 0.8], pose: 'tuck' },
      { at: ['a', 0], pose: 'ffOpen', ease: 'inOut' },
      { at: ['a', 1], pose: 'ffOpen' },
      { at: ['r', 0.4], pose: 'bfLand', ease: 'in' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  },
  // A knife off the belt with the free hand: quick, and it can be thrown on the move.
  kunaiThrow: {
    id: 'kunaiThrow', name: 'Kunai',
    layer: 'upper',
    startup: 10, active: 2, recovery: 12,
    limb: 'handL', height: 'high', kind: 'straight', weight: 'light',
    damage: 0, guardDamage: 0, poiseDamage: 0, hitstun: 0, blockstun: 0,
    knockback: 0, impulse: 0, hitstop: 0, shake: 0, radius: 0, reach: 9,
    throw: { release: 10, speed: 19, spin: 0, ammo: true },
    blockable: false,
    noHit: true,
    keys: [
      { at: ['s', 0.6], pose: 'kThrowWind', ease: 'inOut' },
      { at: ['a', 0], pose: 'kThrowRel', ease: 'in' },
      { at: ['a', 1], pose: 'kThrowRel' },
      { at: ['r', 0.7], pose: 'guard', ease: 'inOut' },
    ],
  },
} satisfies Record<string, MoveDef>);

// ---- Other archetypes' moves (built from the shared poses) -------------------
const P = PLAYER_MOVES;
const E = ENEMY_MOVES;
// Rookie: a telegraphed jab and the straight / body shot.
E.rookieJab = { ...P.jab, id: 'rookieJab', name: 'Jab', startup: 13, recovery: 15, damage: 5, reach: 1.45, cancel: { into: ['straight', 'body'], from: 15, to: 28 }, aims: [{ id: 'head', weight: 3 }] };
// A trained fighter's jab: nearly as quick as yours, used to counter and to punch into
// the gaps of a flurry.
E.quickJab = { ...P.jab, id: 'quickJab', name: 'Jab', startup: 8, recovery: 14, damage: 5, reach: 1.4, cancel: { into: ['straight', 'body', 'hookChain'], from: 10, to: 24 }, aims: [{ id: 'head', weight: 3 }, { ...BODY_PUNCH(0.33), weight: 1 }] };
// Kicker (Muay Thai): push kick, low kick, body roundhouse.
E.teep = { ...P.frontKick, id: 'teep', name: 'Teep', startup: 19, recovery: 20, damage: 8, reach: 1.35, guardDamage: 30, aims: [{ id: 'stomach', weight: 1 }] };
E.kLowKick = { ...P.lowKick, id: 'kLowKick', name: 'Low Kick', startup: 21, recovery: 20, damage: 9, poiseDamage: 40, cancel: { into: ['straight'], from: 24, to: 38 }, aims: [{ id: 'thigh', weight: 1 }] };
E.roundhouse = {
  ...P.lowKick,
  id: 'roundhouse',
  name: 'Roundhouse',
  reach: 1.45,
  startup: 25,
  recovery: 24,
  damage: 13,
  weight: 'heavy',
  height: 'mid',
  hitstop: 9,
  shake: 0.4,
  impulse: 26,
  aims: [{ ...P.lowKick.aims![2], weight: 1 }],
  armor: [8, 25],
  // To the ribs: an arm can take it (unlike a kick to the thigh).
  blockable: true,
};
// Bruiser: slow, armored, hits like a truck.
E.bruiserHook = { ...E.hook, id: 'bruiserHook', name: 'Sledge', startup: 31, recovery: 28, damage: 18, impulse: 34, knockback: 3.4, hitstop: 12, shake: 0.6, armor: [5, 31], poiseDamage: 70 };
E.bruiserBody = { ...E.body, id: 'bruiserBody', name: 'Gut Punch', startup: 26, damage: 14, guardDamage: 45, armor: [8, 26], weight: 'heavy' };

export function moveLength(m: MoveDef): number {
  return m.startup + m.active + m.recovery;
}

export function markerFrame(m: Pick<MoveDef, 'startup' | 'active' | 'recovery'>, [phase, f]: Marker): number {
  if (phase === 's') return m.startup * f;
  if (phase === 'a') return m.startup + m.active * f;
  return m.startup + m.active + m.recovery * f;
}

// ---------------------------------------------------------------------------
// Defensive reactions (automatic)
// ---------------------------------------------------------------------------

export interface DefenseDef {
  kind: DefenseKind;
  /** Frames to get into position. */
  startup: number;
  recovery: number;
  /** Heights fully evaded once in position. */
  evades: Height[];
  /** Heights blocked once in position. */
  blocks: Height[];
  /** Frames after success during which a counter can be thrown. */
  counterWindow: number;
  /** Frames before this reaction can be used again. */
  cooldown: number;
  /** Displacement (m, backwards) applied over startup+some frames. */
  retreat?: number;
}

export const DEFENSES: Record<DefenseKind, DefenseDef> = {
  block: { kind: 'block', startup: 3, recovery: 8, evades: [], blocks: ['high', 'mid'], counterWindow: 20, cooldown: 0 },
  duck: { kind: 'duck', startup: 5, recovery: 9, evades: ['high'], blocks: [], counterWindow: 28, cooldown: 0 },
  weave: { kind: 'weave', startup: 4, recovery: 8, evades: ['high'], blocks: [], counterWindow: 26, cooldown: 0 },
  slide: { kind: 'slide', startup: 4, recovery: 12, evades: ['high', 'mid', 'low'], blocks: [], counterWindow: 30, cooldown: 40, retreat: 1.25 },
};

// ---- The second wave of opponents: their own takes on shared techniques ------
// Boxer: a short, rising uppercut off the back hand; a check hook to answer a miss.
E.eUppercut = { ...P.uppercut, id: 'eUppercut', name: 'Uppercut', startup: 16, recovery: 20, reach: 1.15, cancel: undefined };
E.checkHook = { ...P.hook, id: 'checkHook', name: 'Check Hook', startup: 15, recovery: 18, damage: 9, cancel: undefined };
// Nak muay: the straight push kick that keeps you off, and the flying knee-high kick.
E.pushKick = { ...P.frontKick, id: 'pushKick', name: 'Push Kick', startup: 18, recovery: 18, damage: 9, guardDamage: 34, reach: 1.35, cancel: undefined };
E.leapKick = { ...P.flyingKick, id: 'leapKick', name: 'Flying Kick', cancel: undefined };
// Capoeirista: sliding in under it.
E.rasteira = { ...P.slideKick, id: 'rasteira', name: 'Rasteira', cancel: undefined };
