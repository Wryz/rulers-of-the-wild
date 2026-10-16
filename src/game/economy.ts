import { DEFAULT_STATS, type FighterStats } from '../sim/fighter';
import type { PerkId } from '../sim/perks';
import type { WeaponId } from '../sim/weapons';
import { OUTFITS, type OutfitId, RACK, type RackItem, SKILLS, type SkillDef, SUPPLIES, SUPPLY_STACK, type SupplyDef, type SupplyId, TRAINING, type TrainingDef, type TrainingId, trainingPrice } from './catalog';

export type Slot = 'helmet' | 'chest' | 'legs' | 'boots' | 'cuffs';
export const SLOTS: Slot[] = ['helmet', 'chest', 'legs', 'boots', 'cuffs'];
export const SLOT_NAMES: Record<Slot, string> = {
  helmet: 'Helmet',
  chest: 'Chestplate',
  legs: 'Leggings',
  boots: 'Boots',
  cuffs: 'Fist cuffs',
};

export type StatMods = Partial<Pick<FighterStats, 'defense' | 'staggerResist' | 'damageMul' | 'reach' | 'knockbackMul' | 'walkSpeed' | 'maxHp'>>;

export interface GearItem {
  slot: Slot;
  tier: number;
  name: string;
  price: number;
  /** Added to the fighter's base stats (multipliers add to 1.0). */
  mods: StatMods;
  /** Visual material for the gear meshes. */
  material: 'cloth' | 'leather' | 'iron' | 'steel' | 'gold' | 'blacksteel' | 'mythril';
}

/** Highest tier of each piece of gear (and of weapon). */
export const MAX_TIER = 6;

export const CATALOG: GearItem[] = [
  { slot: 'helmet', tier: 1, name: 'Leather Cap', price: 40, mods: { defense: 0.04, staggerResist: 0.05 }, material: 'leather' },
  { slot: 'helmet', tier: 2, name: 'Iron Helm', price: 110, mods: { defense: 0.06, staggerResist: 0.1 }, material: 'iron' },
  { slot: 'helmet', tier: 3, name: 'Steel Visor', price: 240, mods: { defense: 0.08, staggerResist: 0.15 }, material: 'steel' },
  { slot: 'helmet', tier: 4, name: 'Great Helm', price: 460, mods: { defense: 0.1, staggerResist: 0.2, maxHp: 5 }, material: 'steel' },
  { slot: 'helmet', tier: 5, name: 'Blacksteel Helm', price: 820, mods: { defense: 0.12, staggerResist: 0.25, maxHp: 10 }, material: 'blacksteel' },
  { slot: 'helmet', tier: 6, name: 'Mythril Crown-Helm', price: 1400, mods: { defense: 0.14, staggerResist: 0.3, maxHp: 15 }, material: 'mythril' },
  { slot: 'chest', tier: 1, name: 'Padded Vest', price: 50, mods: { defense: 0.06, maxHp: 10 }, material: 'cloth' },
  { slot: 'chest', tier: 2, name: 'Chain Shirt', price: 130, mods: { defense: 0.1, maxHp: 20 }, material: 'iron' },
  { slot: 'chest', tier: 3, name: 'Breastplate', price: 280, mods: { defense: 0.14, maxHp: 30, walkSpeed: -0.1 }, material: 'steel' },
  { slot: 'chest', tier: 4, name: 'Full Cuirass', price: 520, mods: { defense: 0.17, maxHp: 45, walkSpeed: -0.1 }, material: 'steel' },
  { slot: 'chest', tier: 5, name: 'Blacksteel Plate', price: 900, mods: { defense: 0.2, maxHp: 60, walkSpeed: -0.08 }, material: 'blacksteel' },
  { slot: 'chest', tier: 6, name: 'Mythril Hauberk', price: 1550, mods: { defense: 0.23, maxHp: 80 }, material: 'mythril' },
  { slot: 'legs', tier: 1, name: 'Shin Wraps', price: 35, mods: { staggerResist: 0.06 }, material: 'cloth' },
  { slot: 'legs', tier: 2, name: 'Greaves', price: 100, mods: { staggerResist: 0.1, defense: 0.03 }, material: 'iron' },
  { slot: 'legs', tier: 3, name: 'Plated Legs', price: 220, mods: { staggerResist: 0.14, defense: 0.05 }, material: 'steel' },
  { slot: 'legs', tier: 4, name: 'Tassets', price: 420, mods: { staggerResist: 0.18, defense: 0.07, maxHp: 10 }, material: 'steel' },
  { slot: 'legs', tier: 5, name: 'Blacksteel Cuisses', price: 760, mods: { staggerResist: 0.22, defense: 0.09, maxHp: 15 }, material: 'blacksteel' },
  { slot: 'legs', tier: 6, name: 'Mythril Legplates', price: 1300, mods: { staggerResist: 0.26, defense: 0.11, maxHp: 20 }, material: 'mythril' },
  { slot: 'boots', tier: 1, name: 'Runners', price: 30, mods: { walkSpeed: 0.15 }, material: 'leather' },
  { slot: 'boots', tier: 2, name: 'Fight Boots', price: 90, mods: { walkSpeed: 0.25, staggerResist: 0.05 }, material: 'iron' },
  { slot: 'boots', tier: 3, name: 'Wind Steps', price: 200, mods: { walkSpeed: 0.35, staggerResist: 0.08 }, material: 'gold' },
  { slot: 'boots', tier: 4, name: 'Sabatons', price: 380, mods: { walkSpeed: 0.4, staggerResist: 0.11, defense: 0.02 }, material: 'steel' },
  { slot: 'boots', tier: 5, name: 'Blacksteel Treads', price: 700, mods: { walkSpeed: 0.45, staggerResist: 0.14, defense: 0.03 }, material: 'blacksteel' },
  { slot: 'boots', tier: 6, name: 'Mythril Striders', price: 1200, mods: { walkSpeed: 0.55, staggerResist: 0.17, defense: 0.04 }, material: 'mythril' },
  { slot: 'cuffs', tier: 1, name: 'Hard Wraps', price: 45, mods: { damageMul: 0.08 }, material: 'leather' },
  { slot: 'cuffs', tier: 2, name: 'Iron Cuffs', price: 120, mods: { damageMul: 0.15, reach: 0.03, knockbackMul: 0.15 }, material: 'iron' },
  { slot: 'cuffs', tier: 3, name: 'Spiked Cuffs', price: 260, mods: { damageMul: 0.25, reach: 0.05, knockbackMul: 0.3 }, material: 'gold' },
  { slot: 'cuffs', tier: 4, name: 'Gauntlets', price: 480, mods: { damageMul: 0.35, reach: 0.06, knockbackMul: 0.4, defense: 0.02 }, material: 'steel' },
  { slot: 'cuffs', tier: 5, name: 'Blacksteel Fists', price: 860, mods: { damageMul: 0.45, reach: 0.07, knockbackMul: 0.5, defense: 0.03 }, material: 'blacksteel' },
  { slot: 'cuffs', tier: 6, name: 'Mythril Knuckles', price: 1450, mods: { damageMul: 0.6, reach: 0.08, knockbackMul: 0.6, defense: 0.04 }, material: 'mythril' },
];

/** The weapon ladder opponents are armed from as the rounds go on (best last). */
export interface WeaponItem {
  tier: number;
  weapon: WeaponId;
  name: string;
  price: number;
  blurb: string;
}

export const WEAPON_SHOP: WeaponItem[] = [
  { tier: 1, weapon: 'bat', name: 'Baseball Bat', price: 70, blurb: 'Blunt, two hands, good reach' },
  { tier: 2, weapon: 'machete', name: 'Machete', price: 180, blurb: 'Fast one-handed cuts' },
  { tier: 3, weapon: 'gladius', name: 'Gladius', price: 380, blurb: 'Thrusts and slashes, bites deep' },
  { tier: 4, weapon: 'katana', name: 'Katana', price: 680, blurb: 'Long, fast, cuts clean through' },
  { tier: 5, weapon: 'fireaxe', name: 'Fire Axe', price: 1100, blurb: 'Splits skulls; slow' },
  { tier: 6, weapon: 'axe', name: 'Battle Axe', price: 1700, blurb: 'The heaviest edge there is' },
];

export function weaponItem(tier: number): WeaponItem | undefined {
  return WEAPON_SHOP.find((w) => w.tier === tier);
}

export function item(slot: Slot, tier: number): GearItem | undefined {
  return CATALOG.find((g) => g.slot === slot && g.tier === tier);
}

export interface SaveData {
  coins: number;
  /** Highest tier owned per slot (0 = none); the best owned piece is worn. */
  gear: Record<Slot, number>;
  /** Best gauntlet round reached. */
  bestRound: number;
  /** Weapons bought from the rack, and the one carried into every round (null: bare hands). */
  weapons: WeaponId[];
  loadout: WeaponId | null;
  /** Training level per stat. */
  training: Record<TrainingId, number>;
  /** Skills bought (always on). */
  skills: PerkId[];
  /** Supplies in the bag: one of each is used up at the start of every round. */
  supplies: Record<SupplyId, number>;
  /** Outfits bought, and the one worn. */
  outfits: OutfitId[];
  outfit: OutfitId;
}

const zero = <K extends string>(ids: readonly K[]) => Object.fromEntries(ids.map((k) => [k, 0])) as Record<K, number>;

export const NEW_SAVE: SaveData = {
  coins: 0,
  gear: { helmet: 0, chest: 0, legs: 0, boots: 0, cuffs: 0 },
  bestRound: 0,
  weapons: [],
  loadout: null,
  training: zero(TRAINING.map((t) => t.id)),
  skills: [],
  supplies: zero(SUPPLIES.map((x) => x.id)),
  outfits: ['classic'],
  outfit: 'classic',
};
const KEY = 'brawler.save.v2';
const OLD_KEY = 'brawler.save.v1';

export function loadSave(storage: Pick<Storage, 'getItem'> | null = safeStorage()): SaveData {
  try {
    // Saves from the dungeon version carry over their coins and gear.
    const raw = storage?.getItem(KEY) ?? storage?.getItem(OLD_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SaveData> & { weapon?: number };
      const num = (v: unknown, max = Infinity) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
      const rack = new Set(RACK.map((r) => r.weapon));
      let weapons = (Array.isArray(s.weapons) ? s.weapons : []).filter((w) => rack.has(w));
      let loadout = s.loadout && weapons.includes(s.loadout) ? s.loadout : null;
      // (Older saves bought weapons up a ladder: you own everything up to the one you had.)
      if (typeof s.weapon === 'number' && s.weapon > 0) {
        const ladder = WEAPON_SHOP.filter((w) => w.tier <= s.weapon!).map((w) => w.weapon);
        weapons = [...new Set([...weapons, ...ladder])];
        loadout = loadout ?? ladder[ladder.length - 1] ?? null;
      }
      const training = { ...NEW_SAVE.training };
      for (const t of TRAINING) training[t.id] = num(s.training?.[t.id], t.max);
      const supplies = { ...NEW_SAVE.supplies };
      for (const x of SUPPLIES) supplies[x.id] = num(s.supplies?.[x.id], SUPPLY_STACK);
      const skillIds = new Set(SKILLS.map((k) => k.id));
      const outfitIds = new Set(OUTFITS.map((o) => o.id));
      const outfits = [...new Set(['classic' as OutfitId, ...(Array.isArray(s.outfits) ? s.outfits : []).filter((o) => outfitIds.has(o))])];
      return {
        coins: num(s.coins),
        gear: { ...NEW_SAVE.gear, ...(s.gear ?? {}) },
        bestRound: num(s.bestRound),
        weapons,
        loadout,
        training,
        skills: (Array.isArray(s.skills) ? s.skills : []).filter((k) => skillIds.has(k)),
        supplies,
        outfits,
        outfit: s.outfit && outfits.includes(s.outfit) ? s.outfit : 'classic',
      };
    }
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  return structuredClone(NEW_SAVE);
}

export function writeSave(s: SaveData, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not persisted this session.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** The next piece on offer for a slot, or null when maxed. */
export function nextItem(s: SaveData, slot: Slot): GearItem | null {
  return item(slot, s.gear[slot] + 1) ?? null;
}

export function canBuy(s: SaveData, g: GearItem): boolean {
  return s.gear[g.slot] === g.tier - 1 && s.coins >= g.price;
}

export function buy(s: SaveData, g: GearItem): boolean {
  if (!canBuy(s, g)) return false;
  s.coins -= g.price;
  s.gear[g.slot] = g.tier;
  return true;
}

// ---------------------------------------------------------------------------
// The rest of the shop
// ---------------------------------------------------------------------------

/** Spend `price` if there's enough. */
function spend(s: SaveData, price: number): boolean {
  if (s.coins < price) return false;
  s.coins -= price;
  return true;
}

/** The next level of a stat (its price), or null when maxed. */
export function nextTraining(s: SaveData, t: TrainingDef): number | null {
  return s.training[t.id] >= t.max ? null : trainingPrice(t, s.training[t.id]);
}

export function buyTraining(s: SaveData, t: TrainingDef): boolean {
  const price = nextTraining(s, t);
  if (price === null || !spend(s, price)) return false;
  s.training[t.id]++;
  return true;
}

export function skillLocked(s: SaveData, k: SkillDef): boolean {
  return s.bestRound < k.unlock;
}

export function buySkill(s: SaveData, k: SkillDef): boolean {
  if (s.skills.includes(k.id) || skillLocked(s, k) || !spend(s, k.price)) return false;
  s.skills.push(k.id);
  return true;
}

export function buySupply(s: SaveData, x: SupplyDef): boolean {
  if (s.supplies[x.id] >= SUPPLY_STACK || !spend(s, x.price)) return false;
  s.supplies[x.id]++;
  return true;
}

/** Buys a weapon off the rack (and takes it), or takes one already owned. */
export function buyRack(s: SaveData, r: RackItem): boolean {
  if (!s.weapons.includes(r.weapon)) {
    if (!spend(s, r.price)) return false;
    s.weapons.push(r.weapon);
  }
  s.loadout = r.weapon;
  return true;
}

export function buyOutfit(s: SaveData, id: OutfitId): boolean {
  const o = OUTFITS.find((x) => x.id === id);
  if (!o) return false;
  if (!s.outfits.includes(id)) {
    if (!spend(s, o.price)) return false;
    s.outfits.push(id);
  }
  s.outfit = id;
  return true;
}

/** Per-round buffs from supplies being used this round. */
export interface RoundBuffs {
  maxHp: number;
  damageMul: number;
  weaponDamageMul: number;
  staminaRegen: number;
  lastStand: boolean;
  coinMul: number;
  used: SupplyId[];
}

export const NO_BUFFS: RoundBuffs = { maxHp: 0, damageMul: 0, weaponDamageMul: 0, staminaRegen: 0, lastStand: false, coinMul: 1, used: [] };

/** Takes one of each supply in the bag for the round about to start. */
export function useSupplies(s: SaveData): RoundBuffs {
  const b: RoundBuffs = { ...NO_BUFFS, used: [] };
  for (const x of SUPPLIES) {
    if (s.supplies[x.id] <= 0) continue;
    s.supplies[x.id]--;
    b.used.push(x.id);
    if (x.id === 'tonic') b.maxHp += 40;
    if (x.id === 'warpaint') b.damageMul += 0.15;
    if (x.id === 'whetstone') b.weaponDamageMul += 0.25;
    if (x.id === 'rations') b.staminaRegen += 0.4;
    if (x.id === 'salts') b.lastStand = true;
    if (x.id === 'luckyCoin') b.coinMul = 2;
  }
  return b;
}

/** Player stats: base, worn gear, training, and this round's supplies. */
export function statsWithGear(s: SaveData, base: FighterStats = DEFAULT_STATS, buffs: RoundBuffs = NO_BUFFS): FighterStats {
  const t = s.training;
  const out = applyGear(base, s.gear);
  out.maxHp += 10 * t.vitality + buffs.maxHp;
  out.damageMul += 0.05 * t.power + buffs.damageMul;
  out.defense = Math.min(0.7, out.defense + 0.02 * t.toughness);
  out.maxGuard += 12 * t.guard;
  out.staggerResist = Math.min(0.8, out.staggerResist + 0.04 * t.grit);
  out.walkSpeed += 0.06 * t.footwork;
  out.maxPoise += 10 * t.poise;
  return out;
}

/** How much faster than normal you get your breath back (training and supplies). */
export function staminaRegen(s: SaveData, buffs: RoundBuffs = NO_BUFFS): number {
  return 1 + 0.08 * s.training.conditioning + buffs.staminaRegen;
}

/** Stats with the given tier of gear worn in each slot (anyone: you, or an opponent). */
export function applyGear(base: FighterStats, gear: Partial<Record<Slot, number>>): FighterStats {
  const out = { ...base };
  for (const slot of SLOTS) {
    const g = item(slot, gear[slot] ?? 0);
    if (!g) continue;
    for (const [k, v] of Object.entries(g.mods) as [keyof StatMods, number][]) out[k] += v;
  }
  out.defense = Math.min(0.7, out.defense);
  out.staggerResist = Math.min(0.8, out.staggerResist);
  return out;
}

/**
 * An opponent's stats in a round's armour. They already grow tougher every round, so
 * plate counts for less on them: half the extra health, and never quite as hard to cut.
 */
export function opponentGear(base: FighterStats, gear: Partial<Record<Slot, number>>): FighterStats {
  const out = applyGear(base, gear);
  out.maxHp = Math.round(base.maxHp + (out.maxHp - base.maxHp) * 0.5);
  out.defense = Math.min(0.5, out.defense);
  return out;
}

/**
 * What a run pays out when it ends: something for every round got through, more the
 * further you got, and a bonus for beating your best.
 */
export function deathReward(round: number, best: number): number {
  const r = deathRewardParts(round, best);
  return r.base + r.bonus;
}

/** The payout, itemised: for the rounds got through, and the bonus for a new best. */
export function deathRewardParts(round: number, best: number): { base: number; bonus: number } {
  const cleared = Math.max(0, round - 1);
  return { base: 10 + 12 * cleared + 2 * cleared * cleared, bonus: round - 1 > best ? 25 * cleared : 0 };
}
