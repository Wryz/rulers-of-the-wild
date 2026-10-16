import type { ThemeId } from '../arena/themes';
import { ARCHETYPES, type EnemyKind, type EnemyMods } from '../sim/enemies';
import type { Rng } from '../sim/math';
import type { WeaponId } from '../sim/weapons';
import { MAX_TIER, SLOTS, type Slot, WEAPON_SHOP } from './economy';

/** Regular rounds cycle through these; every boss is fought in the colosseum. */
export const ARENA_ORDER: ThemeId[] = ['ring', 'street', 'grocery', 'warehouse', 'bar', 'dojo', 'rooftop'];

/** The arena for round n. */
export function themeFor(round: number): ThemeId {
  if (round % 4 === 0) return 'colosseum';
  const regular = round - Math.floor(round / 4) - 1;
  return ARENA_ORDER[regular % ARENA_ORDER.length];
}
const BOSS_ORDER: EnemyKind[] = ['champion', 'minotaur', 'cyclops', 'troll'];

export interface Spawn extends EnemyMods {
  kind: EnemyKind;
  /** Armour worn, tier per slot (the same catalogue you buy from). */
  gear: Partial<Record<Slot, number>>;
  /** A weapon they walk in with (on top of any their style carries). */
  weapon?: WeaponId;
}

/**
 * What an opponent in round n wears: the further you get, the more of them is covered
 * and the better it is — by the late rounds they're in the same plate you can buy.
 */
export function gearFor(round: number, rng: Rng, boss: boolean): Partial<Record<Slot, number>> {
  const tier = Math.min(MAX_TIER, Math.floor((round - 1) / 3) + (boss ? 1 : 0));
  if (tier <= 0) return {};
  const pieces = Math.min(SLOTS.length, 1 + Math.floor(round / 3) + (boss ? 1 : 0));
  const order = [...SLOTS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.range(0, i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const gear: Partial<Record<Slot, number>> = {};
  for (const slot of order.slice(0, pieces)) gear[slot] = Math.max(1, tier - (rng.chance(0.35) ? 1 : 0));
  return gear;
}

/** From round 4, more and more of them come armed — with better weapons as it goes on. */
export function weaponFor(round: number, rng: Rng): WeaponId | undefined {
  if (round < 4 || !rng.chance(Math.min(0.6, 0.12 + 0.05 * round))) return undefined;
  const top = Math.min(WEAPON_SHOP.length, 1 + Math.floor((round - 3) / 2));
  return WEAPON_SHOP[Math.floor(rng.range(0, top))].weapon;
}

export interface RoundSpec {
  round: number;
  theme: ThemeId;
  spawns: Spawn[];
  boss: EnemyKind | null;
  /** Coins for clearing the round. */
  reward: number;
}

/** Which opponents can appear by round (newer ones weighted higher once unlocked). */
function pool(round: number): [EnemyKind, number][] {
  const p: [EnemyKind, number][] = [['rookie', 3]];
  if (round >= 2) p.push(['brawler', 3]);
  if (round >= 3) p.push(['kicker', 3]);
  if (round >= 3) p.push(['boxer', 2.5]);
  if (round >= 4) p.push(['knifeFighter', 2.5]);
  if (round >= 4) p.push(['nakmuay', 2.5]);
  if (round >= 5) p.push(['wrestler', 2.5]);
  if (round >= 5) p.push(['duelist', 2.5]);
  if (round >= 6) p.push(['capoeira', 2.5]);
  if (round >= 7) p.push(['berserker', 2.5]);
  if (round >= 7) p.push(['monk', 2.5]);
  if (round >= 8) p.push(['sumo', 2.5]);
  if (round >= 5) p.push(['bruiser', 2]);
  if (round >= 5) p.push(['samurai', 2.5]);
  if (round >= 6) p.push(['ninja', 2.5]);
  if (round >= 6) p.push(['imp', 3]);
  if (round >= 7) p.push(['demon', 2 + Math.min(3, (round - 7) * 0.5)]);
  // The rookies fade out as the gauntlet goes on.
  if (round >= 6) p[0][1] = 1;
  return p;
}

/**
 * Round n of the gauntlet: one opponent at a time. The arena theme rotates every round,
 * every fourth round is a giant boss in the colosseum, mythical creatures join from
 * round 6, and everyone gets tougher as the rounds go on.
 */
export function roundSpec(round: number, rng: Rng): RoundSpec {
  const theme = themeFor(round);
  const tier = round - 1;
  const mods: EnemyMods = {
    // (Their armour adds to this: see gearFor.)
    hpMul: 1 + 0.07 * tier,
    dmgMul: 1 + 0.04 * tier,
    aggression: Math.min(1.7, 1.05 + 0.05 * round),
    // Sharper every round.
    readMul: Math.min(1.5, 1 + 0.04 * tier),
  };
  let boss: EnemyKind | null = null;
  let kind: EnemyKind;
  if (round % 4 === 0) {
    boss = BOSS_ORDER[(round / 4 - 1) % BOSS_ORDER.length];
    const cycle = Math.floor((round / 4 - 1) / BOSS_ORDER.length);
    kind = boss;
    mods.hpMul = 1 + 0.25 * cycle + 0.04 * tier;
  } else {
    kind = rng.pickWeighted(pool(round));
  }
  const reward = 15 + 6 * round + (boss ? 40 + 10 * round : 0);
  const gear = gearFor(round, rng, !!boss);
  const weapon = boss || ARCHETYPES[kind].weapon ? undefined : weaponFor(round, rng);
  return { round, theme, spawns: [{ kind, ...mods, gear, weapon }], boss, reward };
}
