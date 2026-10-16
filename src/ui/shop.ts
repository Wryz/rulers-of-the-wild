import { OUTFITS, RACK, SKILLS, SUPPLIES, SUPPLY_STACK, TRAINING } from '../game/catalog';
import {
  buy,
  buyOutfit,
  buyRack,
  buySkill,
  buySupply,
  buyTraining,
  item,
  MAX_TIER,
  nextItem,
  nextTraining,
  type SaveData,
  skillLocked,
  SLOT_NAMES,
  SLOTS,
  type Slot,
} from '../game/economy';
import type { FighterStats } from '../sim/fighter';
import { WEAPONS } from '../sim/weapons';

const STAT_LABELS: Record<string, (v: number) => string> = {
  defense: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}% defense`,
  staggerResist: (v) => `+${Math.round(v * 100)}% stagger resist`,
  damageMul: (v) => `+${Math.round(v * 100)}% damage`,
  reach: (v) => `+${Math.round(v * 100)} cm reach`,
  knockbackMul: (v) => `+${Math.round(v * 100)}% knockback`,
  walkSpeed: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} speed`,
  maxHp: (v) => `+${v} health`,
};

type Tab = 'armour' | 'weapons' | 'training' | 'skills' | 'supplies' | 'outfits';
const TABS: { id: Tab; name: string; icon: string }[] = [
  { id: 'armour', name: 'Armour', icon: 'helmet' },
  { id: 'weapons', name: 'Weapons', icon: 'sword' },
  { id: 'training', name: 'Training', icon: 'dumbbell' },
  { id: 'skills', name: 'Skills', icon: 'star' },
  { id: 'supplies', name: 'Supplies', icon: 'potion' },
  { id: 'outfits', name: 'Outfits', icon: 'shirt' },
];

const RARITY = ['', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];

/** Simple filled icons (24×24) for the cards and tabs. */
const ICONS: Record<string, string> = {
  helmet: 'M12 2C7 2 4 5.5 4 10v6l3 2v-5h10v5l3-2v-6c0-4.5-3-8-8-8zm-5 9V10c0-2.8 2-5 5-5s5 2.2 5 5v1H7z',
  chest: 'M7 3l-4 3 2 5 2-1v11h10V10l2 1 2-5-4-3-2 2h-6L7 3zm3 6h4v2h-4V9z',
  legs: 'M7 2h10l1 9-2 11h-3l-1-9-1 9H8L6 11l1-9z',
  boots: 'M6 2h5v10l6 3c2 1 3 2 3 4v2H4v-5l2-3V2z',
  cuffs: 'M8 3h8v3h2v6l-2 3v6H8v-6L6 12V6h2V3zm1 5v3h6V8H9z',
  sword: 'M19 2l3 3-11 11 2 2-2 2-2-2-3 3-2-2 3-3-2-2 2-2 2 2L19 2z',
  axe: 'M14 2c4 0 8 4 8 8-2-1-4-1-6 1l-2-2-9 9 2 2-2 2-3-3 10-10-2-2c2-2 2-4 4-5z',
  hammer: 'M13 2l9 9-3 3-3-3-9 9-3-3 9-9-3-3 3-3z',
  dumbbell: 'M2 9h3V7h3v10H5v-2H2V9zm20 0h-3V7h-3v10h3v-2h3V9zM9 11h6v2H9v-2z',
  heart: 'M12 21l-8.5-8.5C1 10 1 6 4 4s6-1 8 2c2-3 5-4 8-2s3 6 .5 8.5L12 21z',
  fist: 'M5 10a2 2 0 012-2V7a2 2 0 013.5-1.3A2 2 0 0114 6a2 2 0 013 1v1a2 2 0 012 2v4a7 7 0 01-7 7h-1a6 6 0 01-6-6v-4zm3-1v3h1.5V9H8zm3.5-1v4H13V8h-1.5zm3.5 1v3h1.5V9H15z',
  stone: 'M4 15l4-7h9l3 6-3 5H7l-3-4zm5-5l-2 4h9l-1.5-4H9z',
  bread: 'M4 12c0-4 4-7 8-7s8 3 8 7v6H4v-6zm4-3l1 4h1.5l-1-4H8zm3.5-.5l.5 4.5h1.5l-.5-4.5h-1.5zm4 .5l-1 4H16l1-4h-1.5z',
  paint: 'M17 2l5 5-9 9-2-2-3 1v4H4v-4l4-4-1-3 2 1 8-7z',
  shield: 'M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  wind: 'M3 8h11a3 3 0 10-3-3h2a1 1 0 111 1H3v2zm0 4h15a3 3 0 11-3 3h2a1 1 0 101-1H3v-2zm0 4h8v2H3v-2z',
  anchor: 'M12 2a3 3 0 011 5.8V10h4v2h-4v7.9c2.8-.4 5-2.4 5.8-4.9H17l3-3 3 3h-1.2C20.7 19 16.7 22 12 22S3.3 19 2.2 15H1l3-3 3 3H5.2c.8 2.5 3 4.5 5.8 4.9V12H7v-2h4V7.8A3 3 0 0112 2z',
  star: 'M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7l3-7z',
  potion: 'M9 2h6v2h-1v4l5 8c1.5 2.5-.3 6-3 6H8c-2.7 0-4.5-3.5-3-6l5-8V4H9V2zm-1 13h8l-2-4h-4l-2 4z',
  shirt: 'M8 3l-6 4 3 5 2-1v10h10V11l2 1 3-5-6-4c-1 2-2 3-4 3S9 5 8 3z',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 3a6 6 0 110 12 6 6 0 010-12z',
  lock: 'M7 10V7a5 5 0 0110 0v3h2v12H5V10h2zm2 0h6V7a3 3 0 00-6 0v3z',
};
const svg = (name: string, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] ?? ICONS.star}"/></svg>`;

const SLOT_ICON: Record<Slot, string> = { helmet: 'helmet', chest: 'chest', legs: 'legs', boots: 'boots', cuffs: 'cuffs' };
const TRAIN_ICON: Record<string, string> = { vitality: 'heart', power: 'fist', toughness: 'shield', guard: 'shield', grit: 'bolt', footwork: 'boots', conditioning: 'wind', poise: 'anchor' };
const SUPPLY_ICON: Record<string, string> = { tonic: 'potion', warpaint: 'paint', whetstone: 'stone', rations: 'bread', salts: 'potion', luckyCoin: 'coin' };
const SKILL_TIER: Record<string, number> = { perfectTiming: 3, counterMaster: 3, bloodlust: 4, thickBlood: 3, adrenaline: 4, secondWind: 5, quickHands: 5, fortune: 4, heavyHands: 5, executioner: 5, lastStand: 6 };

/** The shop between rounds (and after a fall): armour, weapons, training, skills, supplies, outfits. */
export class Shop {
  private readonly el: HTMLDivElement;
  /** Opened after a death: the run starts again from round 1. */
  fallen = false;
  onBuy: (() => void) | null = null;
  /** Something couldn't be bought (not enough coins). */
  onDenied: (() => void) | null = null;
  onDone: (() => void) | null = null;
  /** Open the battle log on the fight just finished. */
  onReplay: (() => void) | null = null;
  /** Your stats as they stand (for the summary strip). */
  stats: (() => FighterStats) | null = null;
  private tab: Tab = 'armour';
  private round = 1;
  private pay = 0;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly save: SaveData,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'overlay shop';
    root.appendChild(this.el);
  }

  /** @param pay what the run paid out, when it ended in a death (null: a round was cleared). */
  open(round: number, pay: number | null) {
    this.fallen = pay !== null;
    this.pay = pay ?? 0;
    this.round = round;
    this.render();
    this.el.classList.add('show');
    this.keyHandler = (e) => {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        this.onDone?.();
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  close() {
    this.el.classList.remove('show');
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
  }

  get isOpen() {
    return this.el.classList.contains('show');
  }

  /** Items you could buy right now, per tab (the badge on each tab). */
  private affordable(tab: Tab): number {
    const s = this.save;
    const c = s.coins;
    switch (tab) {
      case 'armour':
        return SLOTS.filter((sl) => (nextItem(s, sl)?.price ?? Infinity) <= c).length;
      case 'weapons':
        return RACK.filter((r) => !s.weapons.includes(r.weapon) && r.price <= c).length;
      case 'training':
        return TRAINING.filter((t) => (nextTraining(s, t) ?? Infinity) <= c).length;
      case 'skills':
        return SKILLS.filter((k) => !s.skills.includes(k.id) && !skillLocked(s, k) && k.price <= c).length;
      case 'supplies':
        return SUPPLIES.filter((x) => s.supplies[x.id] < SUPPLY_STACK && x.price <= c).length;
      case 'outfits':
        return OUTFITS.filter((o) => !s.outfits.includes(o.id) && o.price <= c).length;
    }
  }

  private render() {
    const s = this.save;
    const head = this.fallen
      ? `<h2>Fallen in round ${this.round}</h2><p class="sub">Back to round 1 — the run paid <b>+${this.pay}</b>. Everything you buy here stays yours.</p>`
      : `<h2>Round ${this.round} cleared</h2><p class="sub">Everything you buy stays with you, even if you fall. Your opponents gear up too.</p>`;
    const tabs = TABS.map((t) => {
      const n = this.affordable(t.id);
      return `<button class="tab ${t.id === this.tab ? 'on' : ''}" data-tab="${t.id}">${svg(t.icon)}<span>${t.name}</span>${n ? `<i class="badge">${n}</i>` : ''}</button>`;
    }).join('');
    const st = this.stats?.();
    const summary = st
      ? [
          ['heart', `${Math.round(st.maxHp)}`, 'health'],
          ['fist', `${Math.round(st.damageMul * 100)}%`, 'damage'],
          ['shield', `${Math.round(st.defense * 100)}%`, 'defense'],
          ['bolt', `${Math.round(st.staggerResist * 100)}%`, 'grit'],
          ['boots', st.walkSpeed.toFixed(1), 'speed'],
          ['sword', s.loadout ? WEAPONS[s.loadout].name : 'Fists', 'weapon'],
        ]
          .map(([i, v, l]) => `<div class="sum">${svg(i)}<b>${v}</b><span>${l}</span></div>`)
          .join('')
      : '';
    this.el.innerHTML = `
      <div class="store">
        <header class="store-head">
          <div class="store-title">${svg('coin', 'ico big')}<div><div class="brand">The Armoury</div>${head}</div></div>
          <div class="store-right"><button class="replay" title="Battle log (B)">▶ Watch it back</button><div class="wallet"><span class="coin"></span><b>${Math.floor(s.coins).toLocaleString()}</b></div></div>
        </header>
        <div class="store-body">
          <nav class="tabs">${tabs}</nav>
          <section class="cards">${this.cards()}</section>
        </div>
        <footer class="store-foot">
          <div class="sums">${summary}</div>
          <button class="primary go">${this.fallen ? 'Fight again · round 1' : `Next round · ${this.round + 1}`} <kbd>Enter</kbd></button>
        </footer>
      </div>`;
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>('.tab'))) {
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as Tab;
        this.render();
      });
    }
    for (const b of Array.from(this.el.querySelectorAll<HTMLButtonElement>('button[data-buy]'))) {
      b.addEventListener('click', () => this.purchase(b));
    }
    this.el.querySelector('.go')!.addEventListener('click', () => this.onDone?.());
    this.el.querySelector('.replay')!.addEventListener('click', () => this.onReplay?.());
  }

  /** A card: icon, name, what it does, and its price (or state). */
  private card(o: { id: string; tier: number; icon: string; name: string; sub: string; body: string; price?: number; state?: string; level?: [number, number]; equipped?: boolean; tag?: string; tint?: string }) {
    const s = this.save;
    const pips = o.level ? `<div class="lvl">${Array.from({ length: o.level[1] }, (_, i) => `<i class="${i < o.level![0] ? 'on' : ''}"></i>`).join('')}</div>` : '';
    const action =
      o.price !== undefined
        ? `<button class="buy ${s.coins >= o.price ? '' : 'poor'}" data-buy="${o.id}"><span class="coin"></span>${o.price.toLocaleString()}</button>`
        : o.state
          ? o.state.startsWith('equip:')
            ? `<button class="buy equip" data-buy="${o.id}">Equip</button>`
            : `<div class="state">${o.state}</div>`
          : '';
    return `
      <div class="card r${Math.max(1, Math.min(6, o.tier))} ${o.equipped ? 'equipped' : ''}" data-card="${o.id}">
        <div class="art"${o.tint ? ` style="--tint:${o.tint}"` : ''}>${svg(o.icon, `ico art-ico${o.tint ? ' tinted' : ''}`)}<span class="rarity">${RARITY[Math.max(1, Math.min(6, o.tier))]}</span>${o.equipped ? `<span class="tag">${o.tag ?? 'Equipped'}</span>` : ''}</div>
        <div class="info">
          <div class="name">${o.name}</div>
          <div class="sub">${o.sub}</div>
          ${pips}
          <div class="body">${o.body}</div>
        </div>
        ${action}
      </div>`;
  }

  private cards(): string {
    const s = this.save;
    switch (this.tab) {
      case 'armour':
        return SLOTS.map((slot) => {
          const owned = item(slot, s.gear[slot]);
          const next = nextItem(s, slot);
          const stats = (next ?? owned) ? Object.entries((next ?? owned)!.mods).map(([k, v]) => STAT_LABELS[k]?.(v as number) ?? '').join(' · ') : '';
          return this.card({
            id: `armour:${slot}`,
            tier: next?.tier ?? owned?.tier ?? 1,
            icon: SLOT_ICON[slot],
            name: next ? next.name : `${owned!.name}`,
            sub: `${SLOT_NAMES[slot]} · ${owned ? `wearing ${owned.name}` : 'nothing worn'}`,
            body: next ? stats : `Best in slot. ${stats}`,
            level: [s.gear[slot], MAX_TIER],
            price: next?.price,
            state: next ? undefined : 'Maxed',
          });
        }).join('');
      case 'weapons':
        return [
          this.card({ id: 'weapon:none', tier: 1, icon: 'fist', name: 'Bare Hands', sub: 'Unarmed', body: 'Walk in with nothing but your fists (you can still pick weapons up).', equipped: s.loadout === null, state: s.loadout === null ? 'Equipped' : 'equip:' }),
          ...RACK.map((r) => {
            const w = WEAPONS[r.weapon];
            const owned = s.weapons.includes(r.weapon);
            const icon = r.weapon.includes('axe') ? 'axe' : w.edge === 'blunt' ? 'hammer' : 'sword';
            const kind = `${w.style === 'twoHand' ? 'Two-handed' : 'One-handed'} · ${w.edge === 'blade' ? 'edged' : 'blunt'} · ${w.mass} kg`;
            return this.card({
              id: `weapon:${r.weapon}`,
              tier: r.tier,
              icon,
              name: w.name,
              sub: kind,
              body: `${r.blurb} <em>×${w.damageMul.toFixed(2)} damage.</em>`,
              equipped: s.loadout === r.weapon,
              price: owned ? undefined : r.price,
              state: owned ? (s.loadout === r.weapon ? 'Equipped' : 'equip:') : undefined,
            });
          }),
        ].join('');
      case 'training':
        return TRAINING.map((t) => {
          const lvl = s.training[t.id];
          const price = nextTraining(s, t);
          return this.card({
            id: `training:${t.id}`,
            tier: 1 + Math.min(5, Math.floor(lvl / 2)),
            icon: TRAIN_ICON[t.id] ?? 'dumbbell',
            name: t.name,
            sub: `Level ${lvl} / ${t.max} · ${t.per} per level`,
            body: t.blurb,
            level: [lvl, t.max],
            price: price ?? undefined,
            state: price === null ? 'Maxed' : undefined,
          });
        }).join('');
      case 'skills':
        return SKILLS.map((k) => {
          const owned = s.skills.includes(k.id);
          const locked = skillLocked(s, k);
          return this.card({
            id: `skill:${k.id}`,
            tier: SKILL_TIER[k.id] ?? 3,
            icon: locked ? 'lock' : 'star',
            name: k.name,
            sub: owned ? 'Learned · always on' : locked ? `Reach round ${k.unlock} to unlock` : 'Skill · always on once learned',
            body: k.blurb,
            equipped: owned,
            tag: 'Learned',
            price: owned || locked ? undefined : k.price,
            state: owned ? 'Learned' : locked ? `Locked · round ${k.unlock}` : undefined,
          });
        }).join('');
      case 'supplies':
        return SUPPLIES.map((x) => {
          const n = s.supplies[x.id];
          return this.card({
            id: `supply:${x.id}`,
            tier: x.price >= 150 ? 4 : x.price >= 90 ? 3 : 2,
            icon: SUPPLY_ICON[x.id] ?? 'potion',
            name: x.name,
            sub: `In the bag: ${n} / ${SUPPLY_STACK} · one used each round`,
            body: x.blurb,
            price: n < SUPPLY_STACK ? x.price : undefined,
            state: n >= SUPPLY_STACK ? 'Bag full' : undefined,
          });
        }).join('');
      case 'outfits':
        return OUTFITS.map((o) => {
          const owned = s.outfits.includes(o.id);
          const sw = `<span class="swatch">${[o.colors.shirt, o.colors.pants, o.colors.gloves, o.colors.boots].map((c) => `<i style="background:${c}"></i>`).join('')}</span>`;
          return this.card({
            id: `outfit:${o.id}`,
            tier: o.price >= 450 ? 5 : o.price >= 200 ? 4 : o.price > 0 ? 2 : 1,
            icon: 'shirt',
            tint: o.colors.shirt,
            name: o.name,
            sub: owned ? 'Owned' : 'Outfit',
            body: sw,
            equipped: s.outfit === o.id,
            tag: 'Wearing',
            price: owned ? undefined : o.price,
            state: owned ? (s.outfit === o.id ? 'Wearing' : 'equip:') : undefined,
          });
        }).join('');
    }
  }

  private purchase(btn: HTMLButtonElement) {
    const s = this.save;
    const [kind, id] = btn.dataset.buy!.split(':');
    let ok = false;
    if (kind === 'armour') {
      const next = nextItem(s, id as Slot);
      ok = !!next && buy(s, next);
    } else if (kind === 'weapon') {
      if (id === 'none') {
        s.loadout = null;
        ok = true;
      } else ok = buyRack(s, RACK.find((r) => r.weapon === id)!);
    } else if (kind === 'training') ok = buyTraining(s, TRAINING.find((t) => t.id === id)!);
    else if (kind === 'skill') ok = buySkill(s, SKILLS.find((k) => k.id === id)!);
    else if (kind === 'supply') ok = buySupply(s, SUPPLIES.find((x) => x.id === id)!);
    else if (kind === 'outfit') ok = buyOutfit(s, id as (typeof OUTFITS)[number]['id']);
    if (!ok) {
      const card = btn.closest('.card');
      card?.classList.remove('nope');
      void (card as HTMLElement | null)?.offsetWidth;
      card?.classList.add('nope');
      this.onDenied?.();
      return;
    }
    this.onBuy?.();
    this.render();
    const card = this.el.querySelector(`[data-card="${CSS.escape(btn.dataset.buy!)}"]`);
    card?.classList.add('bought');
  }
}
