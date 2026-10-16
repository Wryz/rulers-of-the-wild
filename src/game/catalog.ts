import type { PerkId } from '../sim/perks';
import type { WeaponId } from '../sim/weapons';

/**
 * Everything the shop sells besides armour: training (stats, levelled up), skills
 * (bought once, always on), supplies (one used up each round), a rack of weapons to
 * choose from, and outfits.
 */

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export type TrainingId = 'vitality' | 'power' | 'toughness' | 'guard' | 'grit' | 'footwork' | 'conditioning' | 'poise';

export interface TrainingDef {
  id: TrainingId;
  name: string;
  /** What one level gives, for the card. */
  per: string;
  blurb: string;
  /** Price of the first level; each level after costs more. */
  base: number;
  max: number;
}

export const TRAINING: TrainingDef[] = [
  { id: 'vitality', name: 'Vitality', per: '+10 health', blurb: 'Roadwork and raw eggs. Take more before you go down.', base: 60, max: 10 },
  { id: 'power', name: 'Power', per: '+5% damage', blurb: 'Heavy bag sessions. Everything you throw lands harder.', base: 80, max: 10 },
  { id: 'toughness', name: 'Toughness', per: '+2% damage reduction', blurb: 'Conditioning the body to take a shot.', base: 90, max: 10 },
  { id: 'guard', name: 'Guard', per: '+12 guard', blurb: 'Pad work. Your guard holds up under a beating for longer.', base: 50, max: 10 },
  { id: 'grit', name: 'Grit', per: '+4% stagger resist', blurb: 'Stay on your feet when the big ones land.', base: 70, max: 10 },
  { id: 'footwork', name: 'Footwork', per: '+0.06 speed', blurb: 'Skipping rope. Get in, get out, get round them.', base: 55, max: 10 },
  { id: 'conditioning', name: 'Conditioning', per: '+8% stamina recovery', blurb: 'Sprints until you drop. You get your breath back faster.', base: 65, max: 10 },
  { id: 'poise', name: 'Poise', per: '+10 poise', blurb: 'Balance drills. It takes more to knock you off your feet.', base: 60, max: 10 },
];

/** Price of the next level of a stat already at `level`. */
export function trainingPrice(t: TrainingDef, level: number): number {
  return Math.round((t.base * 1.4 ** level) / 5) * 5;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface SkillDef {
  id: PerkId;
  name: string;
  blurb: string;
  price: number;
  /** Round you need to have reached (best) before it's on sale. */
  unlock: number;
}

export const SKILLS: SkillDef[] = [
  { id: 'perfectTiming', name: 'Perfect Timing', blurb: 'Parries come in 3 frames later and still count — perfect parries are easier to land.', price: 350, unlock: 0 },
  { id: 'counterMaster', name: 'Counter Master', blurb: 'Counter windows last 50% longer and counters hit 20% harder.', price: 400, unlock: 0 },
  { id: 'bloodlust', name: 'Bloodlust', blurb: 'Every hit you land heals you for 3% of your health.', price: 450, unlock: 2 },
  { id: 'thickBlood', name: 'Thick Blood', blurb: 'Your wounds bleed 60% slower.', price: 300, unlock: 2 },
  { id: 'adrenaline', name: 'Adrenaline', blurb: 'Below 30% health you hit 20% harder.', price: 450, unlock: 3 },
  { id: 'secondWind', name: 'Second Wind', blurb: 'Once a round, dropping under 25% health brings back 35% of it.', price: 600, unlock: 4 },
  { id: 'quickHands', name: 'Quick Hands', blurb: 'Every strike comes out 10% faster.', price: 650, unlock: 4 },
  { id: 'fortune', name: 'Fortune', blurb: '30% more coins from knockouts and rounds.', price: 500, unlock: 3 },
  { id: 'heavyHands', name: 'Heavy Hands', blurb: 'Heavy weapon blows hit 30% harder still.', price: 600, unlock: 5 },
  { id: 'executioner', name: 'Executioner', blurb: 'You hit 30% harder against opponents under 30% health.', price: 700, unlock: 6 },
  { id: 'lastStand', name: 'Last Stand', blurb: 'Once a round, a blow that would knock you out leaves you on 1 health instead. (Not a split skull.)', price: 900, unlock: 8 },
];

// ---------------------------------------------------------------------------
// Supplies
// ---------------------------------------------------------------------------

export type SupplyId = 'tonic' | 'warpaint' | 'whetstone' | 'rations' | 'salts' | 'luckyCoin';

export interface SupplyDef {
  id: SupplyId;
  name: string;
  blurb: string;
  price: number;
}

export const SUPPLIES: SupplyDef[] = [
  { id: 'tonic', name: 'Health Tonic', blurb: '+40 health for the round.', price: 80 },
  { id: 'warpaint', name: 'War Paint', blurb: '+15% damage for the round.', price: 90 },
  { id: 'whetstone', name: 'Whetstone', blurb: '+25% weapon damage for the round.', price: 70 },
  { id: 'rations', name: 'Iron Rations', blurb: '+40% stamina recovery for the round.', price: 60 },
  { id: 'salts', name: 'Smelling Salts', blurb: 'Last Stand for the round: survive one knockout blow on 1 health.', price: 160 },
  { id: 'luckyCoin', name: 'Lucky Coin', blurb: 'Double coins for the round.', price: 120 },
];

/** Most of any one supply you can carry. */
export const SUPPLY_STACK = 9;

// ---------------------------------------------------------------------------
// Weapon rack
// ---------------------------------------------------------------------------

export interface RackItem {
  weapon: WeaponId;
  price: number;
  /** Rarity tier for the card's colour (1 common … 6 mythic). */
  tier: number;
  blurb: string;
}

export const RACK: RackItem[] = [
  { weapon: 'bottle', price: 25, tier: 1, blurb: 'One-handed, quick, breaks heads not bones.' },
  { weapon: 'pan', price: 40, tier: 1, blurb: 'A satisfying clang.' },
  { weapon: 'cue', price: 45, tier: 1, blurb: 'Longest reach there is, light and whippy.' },
  { weapon: 'bokken', price: 60, tier: 2, blurb: 'A wooden sword. Fast, and it bruises.' },
  { weapon: 'chair', price: 60, tier: 2, blurb: 'Heavy, awkward, very effective.' },
  { weapon: 'bat', price: 70, tier: 2, blurb: 'Blunt, two hands, good reach.' },
  { weapon: 'pipe', price: 90, tier: 2, blurb: 'Lead pipe. One-handed, heavy for its size.' },
  { weapon: 'crowbar', price: 110, tier: 2, blurb: 'Hooks, hacks and hurts.' },
  { weapon: 'cleaver', price: 140, tier: 3, blurb: 'Short chops that bite deep.' },
  { weapon: 'machete', price: 180, tier: 3, blurb: 'Fast one-handed cuts.' },
  { weapon: 'club', price: 260, tier: 3, blurb: 'Spiked and heavy: caves skulls in.' },
  { weapon: 'gladius', price: 380, tier: 4, blurb: 'Thrusts and slashes, bites deep.' },
  { weapon: 'ninjato', price: 420, tier: 4, blurb: 'Quick, straight and sharp.' },
  { weapon: 'sledgehammer', price: 520, tier: 4, blurb: 'Slow. Devastating when it lands.' },
  { weapon: 'katana', price: 680, tier: 5, blurb: 'Long, fast, cuts clean through.' },
  { weapon: 'fireaxe', price: 1100, tier: 5, blurb: 'Splits skulls; slow.' },
  { weapon: 'axe', price: 1700, tier: 6, blurb: 'The heaviest edge there is.' },
];

// ---------------------------------------------------------------------------
// Outfits
// ---------------------------------------------------------------------------

export type OutfitId = 'classic' | 'crimson' | 'midnight' | 'jungle' | 'ivory' | 'goldrush' | 'shadow' | 'royal';

export interface OutfitDef {
  id: OutfitId;
  name: string;
  price: number;
  colors: { shirt: string; pants: string; gloves: string; boots: string; hair?: string };
}

export const OUTFITS: OutfitDef[] = [
  { id: 'classic', name: 'Classic', price: 0, colors: { shirt: '#2aa7a0', pants: '#34476e', gloves: '#f6f1e4', boots: '#3a2f2a' } },
  { id: 'crimson', name: 'Crimson', price: 120, colors: { shirt: '#b3262b', pants: '#2b2b30', gloves: '#1f1f22', boots: '#1a1414' } },
  { id: 'jungle', name: 'Jungle', price: 140, colors: { shirt: '#4e6b2f', pants: '#6b5a3a', gloves: '#c9b27a', boots: '#3b2f1f' } },
  { id: 'midnight', name: 'Midnight', price: 180, colors: { shirt: '#23305e', pants: '#14182b', gloves: '#5fb6ff', boots: '#0f1120' } },
  { id: 'ivory', name: 'Ivory', price: 220, colors: { shirt: '#ece6d6', pants: '#c9c1ad', gloves: '#b8312d', boots: '#6b5643' } },
  { id: 'goldrush', name: 'Gold Rush', price: 400, colors: { shirt: '#d9a72b', pants: '#2a2116', gloves: '#f3d36b', boots: '#2a2116' } },
  { id: 'shadow', name: 'Shadow', price: 450, colors: { shirt: '#18181c', pants: '#0e0e10', gloves: '#9e1016', boots: '#0b0b0d', hair: '#0b0b0d' } },
  { id: 'royal', name: 'Royal', price: 600, colors: { shirt: '#5b2a86', pants: '#1d1430', gloves: '#e8c35a', boots: '#e8c35a' } },
];
