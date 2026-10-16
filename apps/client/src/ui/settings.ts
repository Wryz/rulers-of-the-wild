import { ACTIONS, type Bindings, DEFAULT_BINDINGS, keyLabel, rebind, RESERVED_KEYS } from '../input/bindings';
import type { Input } from '../input/input';
import { loadPrefs, type Prefs, savePrefs } from '../game/prefs';

/** Settings overlay (Esc): rebind controls. Changes apply immediately and persist. */
export class SettingsMenu {
  private readonly el: HTMLDivElement;
  private readonly rows: HTMLDivElement;
  private open = false;
  onChange: ((b: Bindings) => void) | null = null;
  onPrefs: ((p: Prefs) => void) | null = null;
  readonly prefs: Prefs = loadPrefs();
  onOpenChange: ((open: boolean) => void) | null = null;

  constructor(
    root: HTMLElement,
    private readonly input: Input,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'settings';
    this.el.innerHTML = `
      <div class="settings-card">
        <h2>Controls</h2>
        <p class="sub">Click a key, then press the new one. Blocking is automatic. Press a punch just as a strike lands to parry it — timed to the last instant, it's a perfect parry.</p>
        <div class="rows"></div>
        <p class="sub small">Arrow keys also move · Mouse: left / right punch · Gamepad: X/Y punch, A/B kick · M mutes · B battle log</p>
        <h2 class="opt-title">Options</h2>
        <div class="row"><span>Blood effects</span><button class="key blood-toggle"></button></div>
        <div class="row"><span>Combat cues (flashes, telegraphs, popups)</span><button class="key cues-toggle"></button></div>
        <div class="row"><span>Fight tips (what to do right now)</span><button class="key tips-toggle"></button></div>
        <div class="row"><span>Record battles for the Battle Log</span><button class="key rec-toggle"></button></div>
        <div class="actions">
          <button class="reset">Reset to defaults</button>
          <button class="close primary">Resume</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    this.rows = this.el.querySelector('.rows')!;
    const blood = this.el.querySelector<HTMLButtonElement>('.blood-toggle')!;
    const showBlood = () => (blood.textContent = this.prefs.blood ? 'On' : 'Off');
    showBlood();
    blood.addEventListener('click', () => {
      this.prefs.blood = !this.prefs.blood;
      savePrefs(this.prefs);
      showBlood();
      this.onPrefs?.(this.prefs);
    });
    const cues = this.el.querySelector<HTMLButtonElement>('.cues-toggle')!;
    const showCues = () => (cues.textContent = this.prefs.cues ? 'On' : 'Off');
    showCues();
    cues.addEventListener('click', () => {
      this.prefs.cues = !this.prefs.cues;
      savePrefs(this.prefs);
      showCues();
      this.onPrefs?.(this.prefs);
    });
    const tips = this.el.querySelector<HTMLButtonElement>('.tips-toggle')!;
    const showTips = () => (tips.textContent = this.prefs.tips ? 'On' : 'Off');
    showTips();
    tips.addEventListener('click', () => {
      this.prefs.tips = !this.prefs.tips;
      savePrefs(this.prefs);
      showTips();
      this.onPrefs?.(this.prefs);
    });
    const rec = this.el.querySelector<HTMLButtonElement>('.rec-toggle')!;
    const showRec = () => (rec.textContent = this.prefs.record ? 'On' : 'Off');
    showRec();
    rec.addEventListener('click', () => {
      this.prefs.record = !this.prefs.record;
      savePrefs(this.prefs);
      showRec();
      this.onPrefs?.(this.prefs);
    });
    this.el.querySelector('.reset')!.addEventListener('click', () => this.apply({ ...DEFAULT_BINDINGS }));
    this.el.querySelector('.close')!.addEventListener('click', () => this.toggle(false));
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.toggle(false);
    });
    this.render();
  }

  get isOpen() {
    return this.open;
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.el.classList.toggle('show', this.open);
    if (!this.open) this.input.capture = null;
    this.render();
    this.onOpenChange?.(this.open);
  }

  private apply(b: Bindings) {
    this.input.setBindings(b);
    this.render();
    this.onChange?.(b);
  }

  private render() {
    const b = this.input.bindings;
    this.rows.innerHTML = '';
    for (const a of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = a.label;
      const key = document.createElement('button');
      key.className = 'key';
      key.textContent = keyLabel(b[a.id]);
      key.addEventListener('click', () => {
        key.textContent = 'press a key…';
        key.classList.add('listening');
        this.input.capture = (code) => {
          if (code !== 'Escape' && !RESERVED_KEYS.has(code)) this.apply(rebind(this.input.bindings, a.id, code));
          else this.render();
        };
      });
      row.append(label, key);
      this.rows.appendChild(row);
    }
  }
}
