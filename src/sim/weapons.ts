import { Vector3 } from 'three';
import { type BoneName, fistPoint } from '../body/skeleton';
import type { AIPlan } from './ai';
import type { Button } from './fighter';
import type { PoseName } from '../body/poses';
import type { Aim, DefenseKind, Key, MoveDef } from './moves';

/**
 * Weapons lying around the arenas. One-handed weapons are held in the rear (right)
 * hand with the lead hand free; two-handed weapons are gripped with both hands. Edged
 * weapons leave lasting, bleeding cuts and heavy ones can take limbs off.
 */
export type WeaponId =
  | 'cleaver' | 'machete' | 'gladius' | 'pan' | 'axe' | 'bat' | 'chair' | 'club'
  | 'crowbar' | 'sledgehammer' | 'cue' | 'bottle' | 'katana' | 'bokken' | 'pipe' | 'fireaxe'
  | 'ninjato' | 'kunai';
export type WeaponStyle = 'oneHand' | 'twoHand';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  style: WeaponStyle;
  /** 'blade' cuts; 'blunt' bruises and staggers harder. */
  edge: 'blade' | 'blunt';
  /** Grip to tip (m, authored scale). */
  length: number;
  /** Where the striking part begins, measured from the grip (m). */
  strikeFrom: number;
  /** Thickness of the striking part for hit detection (m). */
  radius: number;
  damageMul: number;
  /** How deep / bloody its cuts are (0 = none). */
  cut: number;
  /** How much each blow does toward taking a limb off (whether it can at all: see GORE). */
  cleave: number;
  /** Frames an edge stays bitten into the body before it's wrenched free. */
  bite: number;
  /** Swing time multiplier: heavy weapons are slower to bring round. */
  tempo: number;
  /** Mass (kg): how heavy it is to lift, carry and swing. */
  mass: number;
  /**
   * How far the top hand can ride up the handle (fraction of the length): an axe or a
   * sledge is held choked up and the hand slides down the swing; a sword isn't.
   */
  choke: number;
  /** How it's used: quick strike (Q), committed strike (E), and what Q chains into. */
  light: string;
  heavy: string;
  chain: Record<string, string>;
}

const ONE_HAND_CUTS = { light: 'slash', heavy: 'chop', chain: { slash: 'backslash', backslash: 'slash' } };
const TWO_HAND = { light: 'sweep', heavy: 'overhead', chain: { sweep: 'sweepBack' } };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  cleaver: { id: 'cleaver', name: 'Meat Cleaver', style: 'oneHand', edge: 'blade', length: 0.36, strikeFrom: 0.12, radius: 0.07, damageMul: 1.25, cut: 0.85, cleave: 0.6, bite: 12, tempo: 0.9, mass: 0.8, choke: 0, light: 'hack', heavy: 'chop', chain: { hack: 'hack' } },
  machete: { id: 'machete', name: 'Machete', style: 'oneHand', edge: 'blade', length: 0.6, strikeFrom: 0.14, radius: 0.06, damageMul: 1.2, cut: 0.9, cleave: 0.45, bite: 9, tempo: 1, mass: 0.6, choke: 0, ...ONE_HAND_CUTS },
  gladius: { id: 'gladius', name: 'Gladius', style: 'oneHand', edge: 'blade', length: 0.64, strikeFrom: 0.14, radius: 0.06, damageMul: 1.3, cut: 0.85, cleave: 0.5, bite: 10, tempo: 0.95, mass: 0.9, choke: 0, light: 'thrust', heavy: 'slash', chain: { thrust: 'thrust', slash: 'backslash' } },
  pan: { id: 'pan', name: 'Frying Pan', style: 'oneHand', edge: 'blunt', length: 0.46, strikeFrom: 0.24, radius: 0.11, damageMul: 1.25, cut: 0, cleave: 0, bite: 0, tempo: 1, mass: 1.6, choke: 0, ...ONE_HAND_CUTS },
  axe: { id: 'axe', name: 'Battle Axe', style: 'twoHand', edge: 'blade', length: 0.98, strikeFrom: 0.7, radius: 0.1, damageMul: 1.6, cut: 1, cleave: 1, bite: 18, tempo: 1.15, mass: 2.6, choke: 0.42, ...TWO_HAND },
  bat: { id: 'bat', name: 'Baseball Bat', style: 'twoHand', edge: 'blunt', length: 0.88, strikeFrom: 0.3, radius: 0.07, damageMul: 1.45, cut: 0, cleave: 0, bite: 0, tempo: 1, mass: 1.0, choke: 0.12, ...TWO_HAND },
  chair: { id: 'chair', name: 'Folding Chair', style: 'twoHand', edge: 'blunt', length: 0.66, strikeFrom: 0.2, radius: 0.16, damageMul: 1.35, cut: 0, cleave: 0, bite: 0, tempo: 1.1, mass: 3.4, choke: 0, ...TWO_HAND },
  club: { id: 'club', name: 'Spiked Club', style: 'twoHand', edge: 'blunt', length: 1.0, strikeFrom: 0.35, radius: 0.11, damageMul: 1.6, cut: 0.3, cleave: 0, bite: 6, tempo: 1.2, mass: 2.6, choke: 0.3, ...TWO_HAND },
  crowbar: { id: 'crowbar', name: 'Crowbar', style: 'oneHand', edge: 'blunt', length: 0.62, strikeFrom: 0.3, radius: 0.05, damageMul: 1.3, cut: 0.2, cleave: 0, bite: 5, tempo: 1, mass: 1.6, choke: 0, ...ONE_HAND_CUTS },
  sledgehammer: { id: 'sledgehammer', name: 'Sledgehammer', style: 'twoHand', edge: 'blunt', length: 0.95, strikeFrom: 0.72, radius: 0.11, damageMul: 1.8, cut: 0, cleave: 0, bite: 0, tempo: 1.3, mass: 4.5, choke: 0.5, ...TWO_HAND },
  cue: { id: 'cue', name: 'Pool Cue', style: 'twoHand', edge: 'blunt', length: 1.25, strikeFrom: 0.55, radius: 0.04, damageMul: 1.1, cut: 0, cleave: 0, bite: 0, tempo: 0.9, mass: 0.55, choke: 0.15, ...TWO_HAND },
  bottle: { id: 'bottle', name: 'Beer Bottle', style: 'oneHand', edge: 'blunt', length: 0.3, strikeFrom: 0.12, radius: 0.06, damageMul: 1.1, cut: 0, cleave: 0, bite: 0, tempo: 0.85, mass: 0.45, choke: 0, light: 'hack', heavy: 'chop', chain: { hack: 'hack' } },
  // A katana slices: deep, long cuts that pass through rather than lodge.
  katana: { id: 'katana', name: 'Katana', style: 'twoHand', edge: 'blade', length: 0.98, strikeFrom: 0.22, radius: 0.05, damageMul: 1.5, cut: 1, cleave: 0.85, bite: 5, tempo: 0.95, mass: 1.1, choke: 0, ...TWO_HAND },
  bokken: { id: 'bokken', name: 'Bokken', style: 'twoHand', edge: 'blunt', length: 0.95, strikeFrom: 0.3, radius: 0.05, damageMul: 1.3, cut: 0, cleave: 0, bite: 0, tempo: 0.9, mass: 0.6, choke: 0, ...TWO_HAND },
  pipe: { id: 'pipe', name: 'Lead Pipe', style: 'oneHand', edge: 'blunt', length: 0.72, strikeFrom: 0.25, radius: 0.045, damageMul: 1.3, cut: 0, cleave: 0, bite: 0, tempo: 1, mass: 1.4, choke: 0, ...ONE_HAND_CUTS },
  // A short, straight one-handed sword: quick, and light enough to fight with on the move.
  ninjato: { id: 'ninjato', name: 'Ninjato', style: 'oneHand', edge: 'blade', length: 0.62, strikeFrom: 0.14, radius: 0.05, damageMul: 1.35, cut: 0.95, cleave: 0.55, bite: 6, tempo: 0.85, mass: 0.8, choke: 0, ...ONE_HAND_CUTS },
  // A throwing knife: a stab in the hand, but made to fly point first.
  kunai: { id: 'kunai', name: 'Kunai', style: 'oneHand', edge: 'blade', length: 0.26, strikeFrom: 0.08, radius: 0.03, damageMul: 1.3, cut: 0.7, cleave: 0, bite: 4, tempo: 0.8, mass: 0.2, choke: 0, light: 'hack', heavy: 'hack', chain: { hack: 'hack' } },
  fireaxe: { id: 'fireaxe', name: 'Fire Axe', style: 'twoHand', edge: 'blade', length: 0.9, strikeFrom: 0.68, radius: 0.09, damageMul: 1.5, cut: 1, cleave: 0.95, bite: 16, tempo: 1.1, mass: 2.8, choke: 0.42, ...TWO_HAND },
};

/**
 * What a weapon can actually do to a body beyond hurting it, weapon by weapon — not
 * derived from its numbers, because "heavy" and "sharp" aren't enough on their own: a
 * lead pipe is heavy and won't split a skull; a kitchen knife is sharp and won't take
 * an arm off.
 */
export interface Gore {
  /**
   * Brought straight down onto the crown at full power: 'split' cleaves the head in two
   * (only a heavy edge), 'cleft' buries the blade in the skull (a lighter one), 'crush'
   * caves it in (only real mass will). Each kills; null: it hurts, and that's all.
   */
  crown: 'split' | 'cleft' | 'crush' | null;
  /** Which limbs it can take off: all of them, only forearms, or none. */
  sever: 'all' | 'forearms' | 'none';
  /** Can take the head off (a level cut through the neck). */
  decap: boolean;
  /** Can slice pieces away: an ear, scalp, a chunk of flesh. */
  tear: boolean;
}

const NO_GORE: Gore = { crown: null, sever: 'none', decap: false, tear: false };

export const GORE: Record<WeaponId, Gore> = {
  // Big edges with the weight behind them: everything. Only these split a skull in two.
  axe: { crown: 'split', sever: 'all', decap: true, tear: true },
  fireaxe: { crown: 'split', sever: 'all', decap: true, tear: true },
  // A long, keen edge takes limbs and heads, but it's too light to halve a skull: brought
  // straight down, it cuts deep into it instead (which kills just the same).
  katana: { crown: 'cleft', sever: 'all', decap: true, tear: true },
  // Short or light blades: deep, killing cuts into the skull, a hand or forearm off,
  // slices away flesh — but not a neck, a thigh or a whole skull in one blow.
  machete: { crown: 'cleft', sever: 'forearms', decap: false, tear: true },
  cleaver: { crown: 'cleft', sever: 'forearms', decap: false, tear: true },
  gladius: { crown: 'cleft', sever: 'forearms', decap: false, tear: true },
  ninjato: { crown: 'cleft', sever: 'forearms', decap: false, tear: true },
  // A knife cuts and slices; it doesn't chop.
  kunai: { crown: null, sever: 'none', decap: false, tear: true },
  // Only real mass coming down caves a skull in.
  sledgehammer: { crown: 'crush', sever: 'none', decap: false, tear: false },
  club: { crown: 'crush', sever: 'none', decap: false, tear: false },
  // Blunt and too light (or too awkward) for any of it: they bruise, cut skin, knock down.
  pipe: NO_GORE,
  crowbar: NO_GORE,
  bat: NO_GORE,
  chair: NO_GORE,
  pan: NO_GORE,
  cue: NO_GORE,
  bottle: NO_GORE,
  bokken: NO_GORE,
};


const HEAD: Aim = { id: 'head', weight: 3 };
/** A level cut at the head goes for the neck, under the jaw (dropping a little at the knees to get under it). */
const NECK: Aim = { id: 'head', weight: 3, edgeDy: -0.05, add: { root: [0, -0.05, 0] } };
const BODY: Aim = { id: 'body', weight: 2, offset: [0.02, -0.32, -0.04], height: 'mid', add: { root: [0, -0.06, 0], abdomen: [0.12, 0, 0] } };
const LEGS: Aim = { id: 'legs', weight: 1, offset: [0.04, -0.62, -0.08], height: 'low', add: { root: [0, -0.12, 0], abdomen: [0.3, 0, 0] } };

const keys = (wind: PoseName, ext: PoseName, follow: PoseName, recover: PoseName, windAt = 0.55): Key[] => [
    { at: ['s', windAt], pose: wind, ease: 'inOut' },
    { at: ['a', 0], pose: ext, ease: 'linear' },
    { at: ['a', 1], pose: follow, ease: 'out' },
    { at: ['r', 0.6], pose: recover, ease: 'inOut' },
];

const weaponMove = (m: Omit<MoveDef, 'limb' | 'blockable' | 'weapon'> & { blockable?: boolean }): MoveDef => ({
  limb: 'handR',
  blockable: true,
  weapon: true,
  ...m,
});

/**
 * Weapon techniques. Damage is multiplied by the weapon. One-handed: a forehand slash
 * that chains into a backhand, and an overhead chop. Two-handed: wide horizontal
 * sweeps and a slow, armoured overhead that knocks people down.
 */
export const WEAPON_MOVES: Record<string, MoveDef> = {
  slash: weaponMove({
    id: 'slash', name: 'Slash',
    layer: 'upper',
    startup: 10, active: 5, recovery: 17,
    height: 'high', kind: 'hook', weight: 'medium',
    damage: 8, guardDamage: 14, poiseDamage: 22, hitstun: 22, blockstun: 14,
    knockback: 1.4, impulse: 16, hitstop: 7, shake: 0.24, radius: 0, reach: 1.6,
    lunge: { from: 2, to: 10, distance: 0.2 },
    cancel: { into: ['backslash', 'chop', 'slash', 'frontKick', 'lowKick'], from: 13, to: 30 },
    aims: [NECK, BODY],
    keys: keys('wSlashWind', 'wSlashExt', 'wSlashFollow', 'wGuard1'),
  }),
  backslash: weaponMove({
    id: 'backslash', name: 'Backhand Slash',
    layer: 'upper',
    startup: 8, active: 5, recovery: 17,
    height: 'high', kind: 'hook', weight: 'medium',
    damage: 7, guardDamage: 12, poiseDamage: 20, hitstun: 22, blockstun: 12,
    knockback: 1.4, impulse: 15, hitstop: 7, shake: 0.22, radius: 0, reach: 1.55,
    lunge: { from: 1, to: 8, distance: 0.16 },
    cancel: { into: ['chop', 'slash', 'frontKick', 'lowKick'], from: 11, to: 28 },
    aims: [NECK, BODY],
    keys: keys('wBackWind', 'wBackExt', 'wBackFollow', 'wGuard1', 0.4),
  }),
  // Point-first stab: the sword arm drives straight from the hip with a lunge, and the
  // blade goes in and has to be drawn back out — no swing, no follow-through.
  thrust: weaponMove({
    id: 'thrust', name: 'Thrust',
    layer: 'upper',
    startup: 9, active: 4, recovery: 16,
    height: 'mid', kind: 'straight', weight: 'medium',
    damage: 11, guardDamage: 12, poiseDamage: 20, hitstun: 22, blockstun: 12,
    knockback: 0.8, impulse: 14, hitstop: 7, shake: 0.22, radius: 0, reach: 1.75,
    lunge: { from: 2, to: 9, distance: 0.3 },
    cancel: { into: ['thrust', 'slash', 'frontKick', 'lowKick'], from: 13, to: 28 },
    aims: [{ id: 'gut', weight: 3, offset: [0.02, -0.12, 0], height: 'mid', add: { root: [0, -0.04, 0] } }, HEAD],
    keys: keys('wThrustWind', 'wThrustExt', 'wThrustExt', 'wGuard1', 0.5),
  }),
  // Short, quick chop from by the ear — how a cleaver is actually used.
  hack: weaponMove({
    id: 'hack', name: 'Hack',
    layer: 'upper',
    startup: 7, active: 4, recovery: 14,
    height: 'high', kind: 'straight', weight: 'medium',
    damage: 7, guardDamage: 12, poiseDamage: 18, hitstun: 20, blockstun: 12,
    knockback: 0.9, impulse: 12, hitstop: 6, shake: 0.2, radius: 0, reach: 1.35,
    lunge: { from: 1, to: 7, distance: 0.18 },
    cancel: { into: ['hack', 'chop', 'frontKick', 'lowKick'], from: 10, to: 24 },
    aims: [HEAD, BODY],
    keys: keys('wHackWind', 'wHackExt', 'wHackFollow', 'wGuard1', 0.5),
  }),
  chop: weaponMove({
    id: 'chop', name: 'Overhead Chop',
    startup: 15, active: 5, recovery: 22,
    height: 'high', kind: 'straight', weight: 'heavy',
    damage: 12, guardDamage: 26, poiseDamage: 45, hitstun: 30, blockstun: 18,
    knockback: 2.2, impulse: 26, lift: 0.05, hitstop: 10, shake: 0.4, radius: 0, reach: 2.0,
    lunge: { from: 4, to: 15, distance: 0.3 },
    aims: [HEAD, { ...BODY, weight: 1 }],
    keys: keys('wChopWind', 'wChopExt', 'wChopFollow', 'wGuard1', 0.6),
  }),
  sweep: weaponMove({
    id: 'sweep', name: 'Sweeping Swing',
    startup: 14, active: 6, recovery: 24,
    height: 'high', kind: 'hook', weight: 'heavy',
    damage: 11, guardDamage: 24, poiseDamage: 42, hitstun: 28, blockstun: 18,
    knockback: 2.6, impulse: 30, lift: 0.08, hitstop: 10, shake: 0.42, radius: 0, reach: 2.05,
    lunge: { from: 3, to: 14, distance: 0.25 },
    cancel: { into: ['sweepBack', 'overhead', 'frontKick'], from: 18, to: 34 },
    aims: [NECK, BODY, LEGS],
    keys: keys('wSweepWind', 'wSweepExt', 'wSweepFollow', 'wGuard2', 0.6),
  }),
  sweepBack: weaponMove({
    id: 'sweepBack', name: 'Backswing',
    startup: 12, active: 6, recovery: 24,
    height: 'high', kind: 'hook', weight: 'heavy',
    damage: 9, guardDamage: 20, poiseDamage: 36, hitstun: 26, blockstun: 16,
    knockback: 2.4, impulse: 26, lift: 0.06, hitstop: 9, shake: 0.38, radius: 0, reach: 1.9,
    lunge: { from: 2, to: 12, distance: 0.2 },
    aims: [NECK, BODY],
    keys: keys('wSweepBackWind', 'wSweepBackExt', 'wSweepBackFollow', 'wGuard2', 0.4),
  }),
  overhead: weaponMove({
    id: 'overhead', name: 'Overhead Smash',
    startup: 21, active: 5, recovery: 30,
    height: 'high', kind: 'straight', weight: 'heavy',
    damage: 17, guardDamage: 45, poiseDamage: 70, hitstun: 34, blockstun: 22,
    knockback: 3.2, knockdown: true, impulse: 40, lift: 0.1, hitstop: 13, shake: 0.6, radius: 0, reach: 1.9,
    lunge: { from: 6, to: 21, distance: 0.35 },
    armor: [6, 22],
    aims: [HEAD],
    keys: keys('wOverheadWind', 'wOverheadExt', 'wOverheadFollow', 'wGuard2', 0.65),
  }),
};

/**
 * Armed button mapping: Q is the weapon's quick strike (chaining into its follow-up), E
 * the big committed one; kicks stay kicks. Returns undefined to fall back to unarmed.
 */
export function selectWeaponMove(button: Button, w: WeaponDef, counter: DefenseKind | null, chainFrom: string | null): string | null | undefined {
  if (button === 'lkick' || button === 'rkick') return undefined;
  if (counter) return button === 'lpunch' ? w.light : w.heavy;
  if (chainFrom) return button === 'lpunch' ? (w.chain[chainFrom] ?? null) : w.heavy;
  return button === 'lpunch' ? w.light : w.heavy;
}

// ---- Fighting styles: how particular fighters use a weapon --------------------
const FLIP = Math.PI * 2;
Object.assign(WEAPON_MOVES, {
  // The berserker's spinning cleave: the weapon held out at arm's length and the whole
  // body turned under it — a full circle, wound up from the feet and carried round by
  // its own weight, then braked. Anything within reach all the way round gets it.
  spinCleave: weaponMove({
    id: 'spinCleave', name: 'Spinning Cleave',
    startup: 16, active: 20, recovery: 30,
    // Round at chest height: nothing to duck under, only a guard to take it on.
    height: 'mid', kind: 'hook', weight: 'heavy',
    damage: 13, guardDamage: 30, poiseDamage: 55, hitstun: 30, blockstun: 20,
    knockback: 3.0, impulse: 36, lift: 0.05, hitstop: 11, shake: 0.5, radius: 0, reach: 2.3,
    spin: { from: 6, to: 40, turns: 1 },
    keys: [
      { at: ['s', 0.5], pose: 'wSpinWind', ease: 'inOut' },
      { at: ['s', 1], pose: 'wSpinExt', ease: 'in' },
      { at: ['a', 1], pose: 'wSpinExt' },
      { at: ['r', 0.4], pose: 'wSpinFollow', ease: 'out' },
      { at: ['r', 1], pose: 'wGuard2', ease: 'inOut' },
    ],
  }),
  // Two-handed throw: up behind the head and over, the whole body behind it.
  throwHeavy: weaponMove({
    id: 'throwHeavy', name: 'Throw',
    startup: 22, active: 3, recovery: 22,
    height: 'high', kind: 'straight', weight: 'heavy',
    damage: 0, guardDamage: 0, poiseDamage: 0, hitstun: 0, blockstun: 0,
    knockback: 0, impulse: 0, hitstop: 0, shake: 0, radius: 0, reach: 9,
    throw: { release: 22, speed: 12, spin: 1.5 },
    noHit: true,
    keys: [
      { at: ['s', 0.7], pose: 'wThrow2Wind', ease: 'inOut' },
      { at: ['a', 0], pose: 'wThrow2Rel', ease: 'in' },
      { at: ['a', 1], pose: 'wThrow2Rel' },
      { at: ['r', 0.5], pose: 'wThrow2Follow', ease: 'out' },
      { at: ['r', 1], pose: 'guard', ease: 'inOut' },
    ],
  }),
  // One-handed overarm throw (a bottle, a cleaver, a knife).
  throwOne: weaponMove({
    id: 'throwOne', name: 'Throw',
    startup: 16, active: 3, recovery: 18,
    height: 'high', kind: 'straight', weight: 'medium',
    damage: 0, guardDamage: 0, poiseDamage: 0, hitstun: 0, blockstun: 0,
    knockback: 0, impulse: 0, hitstop: 0, shake: 0, radius: 0, reach: 9,
    throw: { release: 16, speed: 15, spin: 2 },
    noHit: true,
    keys: [
      { at: ['s', 0.65], pose: 'wThrow1Wind', ease: 'inOut' },
      { at: ['a', 0], pose: 'wThrow1Rel', ease: 'in' },
      { at: ['a', 1], pose: 'wThrow1Rel' },
      { at: ['r', 0.6], pose: 'guard', ease: 'inOut' },
    ],
  }),
  // Samurai: the draw cut — flat across from the left hip on a step in.
  iai: weaponMove({
    id: 'iai', name: 'Iai Draw Cut',
    startup: 12, active: 5, recovery: 20,
    height: 'mid', kind: 'hook', weight: 'heavy',
    damage: 12, guardDamage: 18, poiseDamage: 35, hitstun: 26, blockstun: 14,
    knockback: 1.6, impulse: 22, hitstop: 9, shake: 0.35, radius: 0, reach: 2.1,
    lunge: { from: 3, to: 14, distance: 0.55 },
    keys: keys('wIaiWind', 'wIaiExt', 'wIaiFollow', 'wGuard2', 0.5),
  }),
  // Samurai: kesa-giri — the diagonal cut down from the shoulder.
  kesa: weaponMove({
    id: 'kesa', name: 'Kesa-giri',
    startup: 13, active: 5, recovery: 20,
    height: 'high', kind: 'hook', weight: 'heavy',
    damage: 13, guardDamage: 22, poiseDamage: 40, hitstun: 28, blockstun: 16,
    knockback: 1.8, impulse: 26, hitstop: 10, shake: 0.4, radius: 0, reach: 2.0,
    lunge: { from: 3, to: 13, distance: 0.35 },
    aims: [HEAD, BODY],
    keys: keys('wKesaWind', 'wKesaExt', 'wKesaFollow', 'wGuard2', 0.55),
  }),
  // Samurai: tsuki — the point driven in on a long lunge.
  tsuki: weaponMove({
    id: 'tsuki', name: 'Tsuki',
    startup: 11, active: 4, recovery: 18,
    height: 'mid', kind: 'straight', weight: 'medium',
    damage: 12, guardDamage: 14, poiseDamage: 25, hitstun: 24, blockstun: 12,
    knockback: 1.0, impulse: 16, hitstop: 8, shake: 0.3, radius: 0, reach: 2.3,
    lunge: { from: 2, to: 11, distance: 0.7 },
    keys: keys('wTsukiWind', 'wTsukiExt', 'wTsukiExt', 'wGuard2', 0.5),
  }),
  // Samurai: men — straight down on the head, quick and clean.
  menCut: weaponMove({
    id: 'menCut', name: 'Men',
    startup: 12, active: 4, recovery: 18,
    height: 'high', kind: 'straight', weight: 'heavy',
    damage: 13, guardDamage: 24, poiseDamage: 45, hitstun: 28, blockstun: 16,
    knockback: 1.8, impulse: 26, hitstop: 10, shake: 0.4, radius: 0, reach: 2.1,
    lunge: { from: 3, to: 12, distance: 0.45 },
    aims: [HEAD],
    keys: keys('wOverheadWind', 'wOverheadExt', 'wOverheadFollow', 'wGuard2', 0.5),
  }),
  // Ninja: low and long, cutting across on the way past.
  dashSlash: weaponMove({
    id: 'dashSlash', name: 'Dash Slash',
    startup: 14, active: 5, recovery: 20,
    height: 'mid', kind: 'hook', weight: 'heavy',
    damage: 11, guardDamage: 16, poiseDamage: 35, hitstun: 26, blockstun: 14,
    knockback: 1.4, impulse: 20, hitstop: 8, shake: 0.3, radius: 0, reach: 3.2,
    lunge: { from: 2, to: 16, distance: 2.2 },
    keys: keys('wDashWind', 'wDashExt', 'wDashFollow', 'wGuard1', 0.45),
  }),
  // Ninja: a front flip, the sword brought down by the turn itself.
  flipSlash: weaponMove({
    id: 'flipSlash', name: 'Flip Slash',
    startup: 36, active: 7, recovery: 16,
    height: 'high', kind: 'straight', weight: 'heavy',
    damage: 14, guardDamage: 26, poiseDamage: 60, hitstun: 28, blockstun: 16,
    knockback: 2.0, impulse: 28, hitstop: 11, shake: 0.5, radius: 0, reach: 2.6,
    lunge: { from: 8, to: 44, distance: 1.6 },
    air: { from: 8, to: 44, flip: FLIP },
    evades: { from: 10, to: 42, heights: ['low'] },
    keys: [
      { at: ['s', 0.2], pose: 'bfCrouch', ease: 'inOut' },
      { at: ['s', 0.3], pose: 'bfLaunch', ease: 'out' },
      { at: ['s', 0.55], pose: 'wFlipTuck', ease: 'out' },
      { at: ['s', 0.8], pose: 'wFlipTuck' },
      { at: ['a', 0], pose: 'wFlipExt', ease: 'inOut' },
      { at: ['a', 1], pose: 'wFlipExt' },
      { at: ['r', 0.4], pose: 'bfLand', ease: 'in' },
      { at: ['r', 1], pose: 'wGuard1', ease: 'inOut' },
    ],
  }),
} satisfies Record<string, MoveDef>);

/**
 * How an armed enemy fights (distances scaled by its size later): it stands where the
 * middle of the striking part — the head of an axe, not its handle — meets the body,
 * swings from as far as the tip reaches, and only counts as crowded when even the
 * near end of the head can't land.
 */
export function weaponPlan(w: WeaponDef): AIPlan {
  // Arms out in a swing, the grip is ~0.5 m in front of the body's centre, and the
  // target's surface is ~0.15 m in front of its centre.
  const body = 0.65;
  const range = body + (w.strikeFrom + w.length) / 2;
  return {
    moves: [[w.light, 4], [w.heavy, 2]],
    range,
    attackRange: body + w.length + 0.1,
    crowded: body - 0.2 + w.strikeFrom,
    punish: w.light,
    chains: { [w.light]: w.chain[w.light] ?? w.light },
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface Rigged {
  rig: import('../body/skeleton').Rig;
  pose: import('../body/skeleton').Pose;
  yaw: number;
  scale: number;
}

/**
 * The weapon in hand: grip (rear fist) and the direction from grip to tip. Each key
 * pose says where the weapon points (the wrist does the rest), so guards, chambers
 * and follow-throughs hold it the way a person would.
 */
export function bladeFrame(f: Rigged, grip: Vector3, dir: Vector3) {
  fistPoint(f.rig, 'R', grip);
  const b = f.pose.blade;
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  dir.set(b.x * c + b.z * s, b.y, -b.x * s + b.z * c).normalize();
}

/**
 * How heavy a weapon is for whoever holds it: mass over strength (strength goes with
 * the square of body size, so a giant swings an axe like you'd swing a machete).
 * ~1 = a light, handy weapon; 2.6 an axe in your hands; 4.5 a sledgehammer.
 */
export function heft(w: WeaponDef | null, scale: number): number {
  return w ? w.mass / (scale * scale) : 0;
}

/** Swing time multiplier for a weapon in these hands: heavy is slow to bring round. */
export function weaponTempo(w: WeaponDef, scale: number): number {
  return w.tempo * (1 + 0.06 * Math.max(0, heft(w, scale) - 1));
}

/**
 * How far up the handle from the rear (bottom) hand the lead hand rides on a heavy
 * two-hander (m, authored scale), for a pose's `slide`: choked up toward the head to
 * hold and lift it, slid down to the bottom hand to swing it.
 */
export function gripSlide(slide: number, w: WeaponDef): number {
  return Math.max(0, Math.min(1, slide)) * w.choke * w.length;
}

/** How far down the haft the second hand sits on a two-handed weapon (m). */
export const SECOND_HAND = 0.2;

/** Distance from the grip (m) of each sample `bladePoints` takes along a weapon. */
export function sampleOffsets(w: WeaponDef): number[] {
  const n = Math.max(3, Math.ceil((w.length - 0.08) / 0.09) + 1);
  return Array.from({ length: n }, (_, i) => 0.08 + ((w.length - 0.08) * i) / (n - 1));
}

/** Sample points along the whole weapon, haft included (world). */
export function bladePoints(f: Rigged, w: WeaponDef, out: Vector3[] = []): Vector3[] {
  const grip = new Vector3();
  const dir = new Vector3();
  bladeFrame(f, grip, dir);
  out.length = 0;
  for (const t of sampleOffsets(w)) out.push(grip.clone().addScaledVector(dir, t * f.scale));
  return out;
}

// ---------------------------------------------------------------------------
// Wounds and dismemberment
// ---------------------------------------------------------------------------

/** A lasting cut: where it is on the body, and how hard it still bleeds. */
export interface Wound {
  bone: BoneName;
  /** Position in the bone's local frame (authored scale). */
  local: [number, number, number];
  /** Orientation of the cut around the surface (rad) and its length (m). */
  angle: number;
  length: number;
  /** Bleeding rate 0..1; eases down but never fully stops. */
  bleed: number;
  floor: number;
  /** Set on the stump left where this limb was cut off. */
  stump?: BoneName;
}

/** Where a limb comes off, by the bone that was struck. */
export const SEVER_AT: Partial<Record<BoneName, BoneName>> = {
  head: 'head',
  upperArmL: 'upperArmL',
  foreArmL: 'foreArmL',
  upperArmR: 'upperArmR',
  foreArmR: 'foreArmR',
  thighL: 'thighL',
  shinL: 'shinL',
  thighR: 'thighR',
  shinR: 'shinR',
};

/** Accumulated cleaving damage a limb takes before it comes off (× body scale). */
export const LIMB_TOUGHNESS: Partial<Record<BoneName, number>> = {
  head: 42,
  upperArmL: 24,
  upperArmR: 24,
  foreArmL: 17,
  foreArmR: 17,
  thighL: 50,
  thighR: 50,
  shinL: 38,
  shinR: 38,
};

/** Bones below `bone` in the skeleton (inclusive). */
export function limbBones(bone: BoneName): BoneName[] {
  switch (bone) {
    case 'upperArmL':
      return ['upperArmL', 'foreArmL'];
    case 'upperArmR':
      return ['upperArmR', 'foreArmR'];
    case 'thighL':
      return ['thighL', 'shinL'];
    case 'thighR':
      return ['thighR', 'shinR'];
    default:
      return [bone];
  }
}
