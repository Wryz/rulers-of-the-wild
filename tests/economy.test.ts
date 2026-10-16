import { describe, expect, it } from 'vitest';
import { OUTFITS, RACK, SKILLS, SUPPLIES, TRAINING } from '../src/game/catalog';
import { buy, buyOutfit, buyRack, buySkill, buySupply, buyTraining, canBuy, CATALOG, deathReward, loadSave, NEW_SAVE, nextItem, nextTraining, SLOTS, statsWithGear, useSupplies, writeSave } from '../src/game/economy';
import { DEFAULT_STATS } from '../src/sim/fighter';

describe('economy', () => {
  it('buys tiers in order and applies stats', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 1000;
    const cuffs2 = CATALOG.find((g) => g.slot === 'cuffs' && g.tier === 2)!;
    expect(canBuy(s, cuffs2)).toBe(false); // must own tier 1 first
    expect(buy(s, nextItem(s, 'cuffs')!)).toBe(true);
    expect(buy(s, nextItem(s, 'cuffs')!)).toBe(true);
    expect(s.gear.cuffs).toBe(2);
    expect(s.coins).toBe(1000 - 45 - 120);
    const st = statsWithGear(s);
    expect(st.damageMul).toBeCloseTo(DEFAULT_STATS.damageMul + 0.15);
    expect(st.reach).toBeCloseTo(0.03);
  });

  it('refuses purchases without enough coins', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 10;
    expect(buy(s, nextItem(s, 'helmet')!)).toBe(false);
    expect(s.gear.helmet).toBe(0);
  });

  it('saves and loads', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = structuredClone(NEW_SAVE);
    s.coins = 77;
    s.bestRound = 2;
    s.gear.boots = 1;
    writeSave(s, store);
    expect(loadSave(store)).toEqual(s);
    mem.set('brawler.save.v2', '{broken');
    expect(loadSave(store)).toEqual(NEW_SAVE);
  });
});

describe('progression', () => {
  it('six tiers in every slot, each better than the last', () => {
    for (const slot of SLOTS) {
      const tiers = CATALOG.filter((g) => g.slot === slot).sort((a, b) => a.tier - b.tier);
      expect(tiers.map((g) => g.tier)).toEqual([1, 2, 3, 4, 5, 6]);
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i].price).toBeGreaterThan(tiers[i - 1].price);
        const sum = (g: (typeof tiers)[number]) => Object.values(g.mods).reduce((a, v) => a + Math.abs(v as number), 0);
        expect(sum(tiers[i])).toBeGreaterThan(sum(tiers[i - 1]));
      }
    }
  });

  it('a rack of weapons: buy any, carry the one you choose, switch freely', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 300;
    const katana = RACK.find((r) => r.weapon === 'katana')!;
    expect(buyRack(s, katana)).toBe(false); // can't afford
    expect(buyRack(s, RACK.find((r) => r.weapon === 'bat')!)).toBe(true);
    expect(buyRack(s, RACK.find((r) => r.weapon === 'machete')!)).toBe(true);
    expect(s.loadout).toBe('machete');
    const coins = s.coins;
    expect(buyRack(s, RACK.find((r) => r.weapon === 'bat')!)).toBe(true); // owned: just switch
    expect(s.coins).toBe(coins);
    expect(s.loadout).toBe('bat');
    expect(RACK.length).toBeGreaterThanOrEqual(15);
  });

  it('training levels up, each level dearer; stats rise with it', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 1e6;
    const vit = TRAINING.find((t) => t.id === 'vitality')!;
    const p1 = nextTraining(s, vit)!;
    expect(buyTraining(s, vit)).toBe(true);
    expect(nextTraining(s, vit)!).toBeGreaterThan(p1);
    while (buyTraining(s, vit));
    expect(s.training.vitality).toBe(vit.max);
    expect(nextTraining(s, vit)).toBeNull();
    expect(statsWithGear(s).maxHp).toBe(statsWithGear(NEW_SAVE).maxHp + 10 * vit.max);
  });

  it('skills are bought once, some only after you have got far enough', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 1e6;
    const last = SKILLS.find((k) => k.id === 'lastStand')!;
    expect(buySkill(s, last)).toBe(false); // locked
    s.bestRound = last.unlock;
    expect(buySkill(s, last)).toBe(true);
    expect(buySkill(s, last)).toBe(false); // already learned
    expect(SKILLS.length).toBeGreaterThanOrEqual(10);
  });

  it('supplies stack in the bag and one of each goes into every round', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 1e6;
    const tonic = SUPPLIES.find((x) => x.id === 'tonic')!;
    while (buySupply(s, tonic));
    expect(s.supplies.tonic).toBe(9);
    buySupply(s, SUPPLIES.find((x) => x.id === 'luckyCoin')!);
    const b = useSupplies(s);
    expect(s.supplies.tonic).toBe(8);
    expect(s.supplies.luckyCoin).toBe(0);
    expect(b.coinMul).toBe(2);
    expect(statsWithGear(s, undefined, b).maxHp).toBe(statsWithGear(s).maxHp + 40);
  });

  it('outfits: bought once, worn by choice', () => {
    const s = structuredClone(NEW_SAVE);
    s.coins = 1000;
    expect(buyOutfit(s, 'royal')).toBe(true);
    expect(s.outfit).toBe('royal');
    expect(buyOutfit(s, 'classic')).toBe(true);
    expect(s.coins).toBe(1000 - OUTFITS.find((o) => o.id === 'royal')!.price);
  });

  it('an old save that bought weapons up the ladder keeps them all, carrying the best', () => {
    const mem = new Map<string, string>([['brawler.save.v2', JSON.stringify({ coins: 50, gear: { boots: 2 }, bestRound: 5, weapon: 3 })]]);
    const s = loadSave({ getItem: (k: string) => mem.get(k) ?? null });
    expect(s.weapons.sort()).toEqual(['bat', 'gladius', 'machete']);
    expect(s.loadout).toBe('gladius');
    expect(s.gear.boots).toBe(2);
    expect(s.training.vitality).toBe(0);
    expect(s.outfit).toBe('classic');
  });

  it('fully geared, you are much harder to hurt — but never untouchable', () => {
    const s = structuredClone(NEW_SAVE);
    for (const slot of SLOTS) s.gear[slot] = 6;
    const st = statsWithGear(s);
    expect(st.defense).toBeLessThanOrEqual(0.7);
    expect(st.staggerResist).toBeLessThanOrEqual(0.8);
    expect(st.maxHp).toBeGreaterThan(statsWithGear(NEW_SAVE).maxHp + 100);
  });

  it('a run that ends in death still pays — more the further it got, a bonus for a new best', () => {
    expect(deathReward(1, 0)).toBeGreaterThan(0);
    expect(deathReward(6, 10)).toBeGreaterThan(deathReward(3, 10));
    expect(deathReward(8, 4)).toBeGreaterThan(deathReward(8, 10));
  });
});
