import type { Camera, Vector3 } from 'three';
import { type Bindings, keyLabel } from '../input/bindings';
import type { Fighter } from '../sim/fighter';

/** DOM overlay: health/guard bars, combo counter, pop-up callouts, controls hint. */
export class Hud {
  private readonly el: HTMLDivElement;
  private readonly pHp: HTMLDivElement;
  private readonly pHpLag: HTMLDivElement;
  private readonly pGuard: HTMLDivElement;
  private readonly pStamina: HTMLDivElement;
  private readonly eWrap: HTMLDivElement;
  private readonly eHp: HTMLDivElement;
  private readonly eHpLag: HTMLDivElement;
  private readonly eName: HTMLDivElement;
  private readonly combo: HTMLDivElement;
  private readonly wave: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly coinsEl: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly flashEl: HTMLDivElement;
  private readonly movesEl: HTMLDivElement;
  private readonly incomingEl: HTMLDivElement;
  private slotEls: { root: HTMLDivElement; name: HTMLSpanElement; cd: HTMLElement; key: HTMLElement; alt: HTMLElement }[] = [];
  private shownCoins = 0;
  private comboTimer = 0;
  private lagP = 1;
  private lagE = 1;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="bars left">
        <div class="name">YOU</div>
        <div class="bar hp"><div class="lag"></div><div class="fill"></div></div>
        <div class="bar guard"><div class="fill"></div></div>
        <div class="bar stamina"><div class="fill"></div></div>
      </div>
      <div class="bars right">
        <div class="name enemy-name">BRAWLER</div>
        <div class="bar hp"><div class="lag"></div><div class="fill"></div></div>
      </div>
      <div class="wave"></div>
      <div class="coins"><span class="coin"></span><b>0</b></div>
      <div class="prompt"></div>
      <div class="flash"></div>
      <div class="combo"></div>
      <div class="moves"></div>
      <div class="incoming">!</div>
      <div class="tcue"><span class="tkey"></span><span class="ttext"></span></div>
      <div class="banner"></div>
      <div class="hint"></div>
      <div class="vignette"></div>
      <div class="letterbox top"></div>
      <div class="letterbox bottom"></div>
      <div class="hud-btns"><button class="logbtn" title="Battle log (B)"><i></i>Log</button><button class="gear" title="Settings (Esc)">⚙</button></div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector<T>(s)!;
    this.pHp = q('.left .hp .fill');
    this.pHpLag = q('.left .hp .lag');
    this.pGuard = q('.left .guard .fill');
    this.pStamina = q('.left .stamina .fill');
    this.eWrap = q('.bars.right');
    this.eHp = q('.right .hp .fill');
    this.eHpLag = q('.right .hp .lag');
    this.eName = q('.enemy-name');
    this.combo = q('.combo');
    this.wave = q('.wave');
    this.banner = q('.banner');
    this.hint = q('.hint');
    this.coinsEl = q('.coins');
    this.promptEl = q('.prompt');
    this.flashEl = q('.flash');
    this.movesEl = q('.moves');
    this.incomingEl = q('.incoming');
    this.cueEl = q('.tcue');
    this.cueKey = q('.tcue .tkey');
    this.cueText = q('.tcue .ttext');
  }

  private readonly cueEl: HTMLDivElement;
  private readonly cueKey: HTMLSpanElement;
  private readonly cueText: HTMLSpanElement;
  private cueShown = '';

  /**
   * What to do right now, in a word, centre screen: an axe coming down (dodge), an
   * opening (punish), a counter window, a guard to go round. Null hides it.
   */
  cue(c: { text: string; key: string; kind: 'danger' | 'open' | 'counter' | 'info' } | null) {
    const id = c ? `${c.kind}|${c.key}|${c.text}` : '';
    if (id === this.cueShown) return;
    this.cueShown = id;
    if (!c) {
      this.cueEl.classList.remove('show');
      return;
    }
    this.cueEl.className = `tcue show ${c.kind}`;
    this.cueKey.textContent = c.key;
    this.cueKey.style.display = c.key ? '' : 'none';
    this.cueText.textContent = c.text;
    // Restart the pop-in.
    void this.cueEl.offsetWidth;
    this.cueEl.classList.add('pop');
  }

  /**
   * The four attack buttons, bottom left: what each one throws right now, and whether
   * it can — ready, still recovering (the dark sweep is how much is left), a chain
   * follow-up, a counter, or gone (that limb is).
   */
  moves(slots: { key: string; name: string; state: 'ready' | 'busy' | 'chain' | 'counter' | 'locked'; left: number; alt?: string; hint?: boolean; wide?: boolean }[]) {
    if (this.slotEls.length !== slots.length) {
      this.movesEl.innerHTML = '';
      this.slotEls = slots.map(() => {
        const root = document.createElement('div');
        root.className = 'slot';
        root.innerHTML = '<i class="cd"></i><b class="key"></b><span class="name"></span><small class="alt"></small>';
        this.movesEl.appendChild(root);
        return { root, name: root.querySelector('.name')!, cd: root.querySelector('.cd')!, key: root.querySelector('.key')!, alt: root.querySelector('.alt')! };
      });
    }
    slots.forEach((s, i) => {
      const el = this.slotEls[i];
      if (el.key.textContent !== s.key) el.key.textContent = s.key;
      if (el.name.textContent !== s.name) el.name.textContent = s.name;
      if (el.alt.textContent !== (s.alt ?? '')) el.alt.textContent = s.alt ?? '';
      const cls = `slot ${s.state}${s.hint ? ' hint' : ''}${s.wide ? ' wide' : ''}`;
      if (el.root.className !== cls) el.root.className = cls;
      el.cd.style.height = `${Math.round(Math.max(0, Math.min(1, s.left)) * 100)}%`;
    });
  }

  /** A red '!' over whoever's winding up a strike at you (orange: it can't be stopped with a jab). */
  incoming(world: Vector3 | null, camera: Camera | null, armored = false) {
    if (!world || !camera) {
      this.incomingEl.classList.remove('show');
      return;
    }
    const p = world.clone().project(camera);
    if (p.z > 1) {
      this.incomingEl.classList.remove('show');
      return;
    }
    this.incomingEl.classList.add('show');
    this.incomingEl.classList.toggle('armor', armored);
    this.incomingEl.style.left = `${(p.x * 0.5 + 0.5) * 100}%`;
    this.incomingEl.style.top = `${(-p.y * 0.5 + 0.5) * 100}%`;
  }

  /** Letterbox bars in, gameplay HUD out (camera cuts). */
  cinematic(on: boolean) {
    this.el.classList.toggle('cine', on);
  }

  /** Screen mood: '' normal, 'death' dark red edges and drained colour. */
  mood(kind: '' | 'death') {
    this.el.classList.toggle('dying', kind === 'death');
    document.body.classList.toggle('dying', kind === 'death');
  }

  setCoins(n: number, animate = true) {
    if (!animate) this.shownCoins = n;
    const target = Math.floor(n);
    if (target > this.shownCoins) {
      this.coinsEl.classList.remove('bump');
      void this.coinsEl.offsetWidth;
      this.coinsEl.classList.add('bump');
    }
    this.shownCoins = target;
    this.coinsEl.querySelector('b')!.textContent = String(target);
  }

  showCoins(show: boolean) {
    this.coinsEl.style.display = show ? '' : 'none';
  }

  /** Short prompt floating above a world position (empty text hides it). */
  prompt(text: string, world?: Vector3, camera?: Camera) {
    if (!text) {
      this.promptEl.classList.remove('show');
      return;
    }
    if (this.promptEl.innerHTML !== text) this.promptEl.innerHTML = text;
    this.promptEl.classList.add('show');
    if (world && camera) {
      const p = world.clone().project(camera);
      this.promptEl.style.left = `${(p.x * 0.5 + 0.5) * 100}%`;
      this.promptEl.style.top = `${(-p.y * 0.5 + 0.5) * 100}%`;
    }
  }

  /** Full-screen white flash (memory erase). */
  flash() {
    this.flashEl.classList.remove('on');
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('on');
  }

  update(dt: number, player: Fighter, enemy: Fighter | null, label: string) {
    const ph = player.hp / player.stats.maxHp;
    this.lagP = Math.max(ph, this.lagP - dt * 0.5);
    this.pHp.style.width = `${ph * 100}%`;
    this.pHpLag.style.width = `${this.lagP * 100}%`;
    this.pGuard.style.width = `${(player.guard / player.stats.maxGuard) * 100}%`;
    this.pGuard.parentElement!.classList.toggle('low', player.guard < 30);
    this.pStamina.style.width = `${player.stamina * 100}%`;
    this.pStamina.parentElement!.classList.toggle('low', player.stamina < 0.3);
    if (enemy) {
      const eh = enemy.hp / enemy.stats.maxHp;
      this.lagE = Math.max(eh, this.lagE - dt * 0.5);
      this.eHp.style.width = `${eh * 100}%`;
      this.eHpLag.style.width = `${this.lagE * 100}%`;
      this.eName.textContent = enemy.name.toUpperCase();
      this.eWrap.style.opacity = '1';
    } else {
      this.eWrap.style.opacity = '0';
      this.lagE = 1;
    }
    this.wave.textContent = label;
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) this.combo.classList.remove('show');
  }

  /** Rebuilds the controls hint from the current key bindings. */
  setBindings(b: Bindings) {
    const k = (code: string) => `<b>${keyLabel(code)}</b>`;
    this.hint.innerHTML = `
      <span>${k(b.up)}${k(b.left)}${k(b.down)}${k(b.right)} move</span>
      <span>${k(b.lpunch)} ${k(b.rpunch)} punch L / R <span class="dim">· as a strike lands: parry</span></span>
      <span>${k(b.lkick)} ${k(b.rkick)} kick L / R</span>
      <span>${k(b.pickup)} grab / drop weapon</span>
      <span class="dim">blocking is automatic</span>
      <span class="dim"><b>Esc</b> settings</span>
      <span class="dim"><b>B</b> battle log</span>
      <span class="dim"><b>M</b> mute</span>`;
  }

  get gearButton(): HTMLButtonElement {
    return this.el.querySelector('.gear')!;
  }

  get logButton(): HTMLButtonElement {
    return this.el.querySelector('.logbtn')!;
  }

  showCombo(n: number) {
    if (n < 2) return;
    this.combo.innerHTML = `<b>${n}</b> HITS`;
    this.combo.classList.remove('show');
    void this.combo.offsetWidth;
    this.combo.classList.add('show');
    this.comboTimer = 1.4;
  }

  showBanner(text: string, sub = '', cls = '') {
    this.banner.className = `banner show ${cls}`;
    this.banner.innerHTML = `<div>${text}</div>${sub ? `<small>${sub}</small>` : ''}`;
  }

  hideBanner() {
    this.banner.className = 'banner';
  }

  fadeHint() {
    this.hint.classList.add('faded');
  }

  /** Small callout that floats up from a world position. */
  popup(text: string, world: Vector3, camera: Camera, cls = '') {
    const p = world.clone().project(camera);
    const div = document.createElement('div');
    div.className = `popup ${cls}`;
    div.textContent = text;
    div.style.left = `${(p.x * 0.5 + 0.5) * 100}%`;
    div.style.top = `${(-p.y * 0.5 + 0.5) * 100}%`;
    this.el.appendChild(div);
    setTimeout(() => div.remove(), 900);
  }
}
