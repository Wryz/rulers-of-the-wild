/** What the end-of-run screen shows. */
export interface RunSummary {
  round: number;
  best: number;
  newBest: boolean;
  killedBy: string;
  kos: number;
  hits: number;
  damage: number;
  bestCombo: number;
  perfect: number;
  brutal: number;
  seconds: number;
  pay: { base: number; bonus: number };
  coins: number;
}

/** A letter for how far the run got. */
export function runRank(round: number): { letter: string; label: string } {
  if (round >= 13) return { letter: 'S', label: 'Legend' };
  if (round >= 9) return { letter: 'A', label: 'Champion' };
  if (round >= 6) return { letter: 'B', label: 'Contender' };
  if (round >= 3) return { letter: 'C', label: 'Brawler' };
  return { letter: 'D', label: 'Rookie' };
}

/**
 * The end of a run: you fell. A rank for how far you got, what you did on the way, and
 * the payout counting up into your wallet — then gear up, or straight back in.
 */
export class DeathScreen {
  private readonly el: HTMLDivElement;
  onShop: (() => void) | null = null;
  onAgain: (() => void) | null = null;
  /** Open the battle log on the fight just lost. */
  onReplay: (() => void) | null = null;
  /** Each step of the payout count (for a coin tick). */
  onTick: (() => void) | null = null;
  private raf = 0;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'death';
    root.appendChild(this.el);
  }

  get isOpen() {
    return this.el.classList.contains('show');
  }

  open(r: RunSummary) {
    const rank = runRank(r.round);
    const mins = Math.floor(r.seconds / 60);
    const secs = Math.floor(r.seconds % 60);
    const stat = (icon: string, value: string, label: string, i: number) =>
      `<div class="stat" style="animation-delay:${0.35 + i * 0.07}s"><i>${icon}</i><b>${value}</b><span>${label}</span></div>`;
    const stats = [
      stat('⚑', String(Math.max(0, r.round - 1)), 'rounds cleared', 0),
      stat('✊', String(r.kos), 'knockouts', 1),
      stat('✸', String(Math.round(r.damage)), 'damage dealt', 2),
      stat('⚡', `${r.bestCombo}×`, 'best combo', 3),
      stat('◎', String(r.perfect), 'perfect parries', 4),
      stat('☠', String(r.brutal), 'brutal kills', 5),
      stat('⏱', `${mins}:${String(secs).padStart(2, '0')}`, 'survived', 6),
      stat('✦', String(r.hits), 'hits landed', 7),
    ].join('');
    const total = r.pay.base + r.pay.bonus;
    this.el.innerHTML = `
      <div class="death-inner">
        <div class="death-title" data-text="DEFEATED">DEFEATED</div>
        <div class="death-sub">Fell in round <b>${r.round}</b>${r.killedBy ? ` · ${escapeHtml(r.killedBy)}` : ''}</div>
        <div class="death-body">
          <div class="rank rank-${rank.letter}">
            <div class="rank-letter">${rank.letter}</div>
            <div class="rank-label">${rank.label}</div>
            ${r.newBest ? '<div class="ribbon">NEW BEST</div>' : `<div class="rank-best">best: round ${r.best}</div>`}
          </div>
          <div class="stats">${stats}</div>
        </div>
        <div class="payout">
          <div class="line"><span>Rounds survived</span><b class="n" data-to="${r.pay.base}">+0</b></div>
          ${r.pay.bonus ? `<div class="line bonus"><span>New best bonus</span><b class="n" data-to="${r.pay.bonus}">+0</b></div>` : ''}
          <div class="line total"><span>Run reward</span><b><span class="coin"></span> <span class="n big" data-to="${total}">0</span></b></div>
          <div class="wallet-after">Wallet: <span class="coin"></span> <b class="n wallet" data-to="${Math.floor(r.coins)}" data-from="${Math.floor(r.coins - total)}">${Math.floor(r.coins - total)}</b> · gear and coins are kept</div>
        </div>
        <div class="death-actions">
          <button class="replay">▶ Watch it back <small>battle log</small></button>
          <button class="again">Fight again <small>round 1</small></button>
          <button class="primary shop">Gear up <kbd>Enter</kbd></button>
        </div>
      </div>`;
    this.el.classList.add('show');
    this.el.querySelector('.shop')!.addEventListener('click', () => this.finish(this.onShop));
    this.el.querySelector('.again')!.addEventListener('click', () => this.finish(this.onAgain));
    this.el.querySelector('.replay')!.addEventListener('click', () => this.onReplay?.());
    this.keyHandler = (e) => {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        this.finish(this.onShop);
      }
    };
    window.addEventListener('keydown', this.keyHandler);
    this.countUp();
  }

  /** The numbers roll up, one after another. */
  private countUp() {
    cancelAnimationFrame(this.raf);
    const els = Array.from(this.el.querySelectorAll<HTMLElement>('.n'));
    const start = performance.now() + 900;
    const each = 650;
    let lastTick = 0;
    const step = (now: number) => {
      let done = true;
      els.forEach((el, i) => {
        const to = Number(el.dataset.to);
        const from = Number(el.dataset.from ?? 0);
        const k = Math.max(0, Math.min(1, (now - start - i * each * 0.6) / each));
        if (k < 1) done = false;
        const v = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
        const txt = el.classList.contains('wallet') || el.classList.contains('big') ? String(v) : `+${v}`;
        if (el.textContent !== txt) {
          el.textContent = txt;
          if (now - lastTick > 70 && k > 0 && k < 1) {
            lastTick = now;
            this.onTick?.();
          }
        }
        el.classList.toggle('done', k >= 1 && to > 0);
      });
      if (!done) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private finish(cb: (() => void) | null) {
    this.close();
    cb?.();
  }

  close() {
    cancelAnimationFrame(this.raf);
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.el.classList.remove('show');
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
