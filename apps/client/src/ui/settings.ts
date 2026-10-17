import { DEV } from '../dev';
import { ACTIONS, type Bindings, DEFAULT_BINDINGS, isBindable, keyLabel, rebind } from '../input/bindings';
import type { Input } from '../input/input';
import { loadPrefs, type Prefs, savePrefs } from '../game/prefs';

/** The gamepad's controls (docs/M1-DESIGN.md §5.14; not rebindable), as the settings card lists them. */
export const PAD_HELP =
  'Gamepad: left stick move · right stick look · X / Y punch (hold: haul a rope) · LT / RT kick · A jump · B crouch · LS sprint · ' +
  'RS take / drop · hold LB verbs (right stick picks) · hold RB throw (right stick aims) · D-pad ↓ place (stick turns, flick: lying / upright / angled, X drive, A set, B cancel) · ' +
  'D-pad ← → target · Back belt · D-pad ↑ stow · Start menu';

/** Settings overlay (Esc): rebind controls, the options. Changes apply immediately and persist. */
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
        <p class="sub small">Arrow keys also move · Mouse: click the game to look around (Esc lets go), left / right button punch; in a verb mode the left button is the mode's (set, confirm, cancel a throw) · Wheel: zoom, or turn what you place · M mutes · B battle log</p>
        <p class="sub small pad-help"></p>
        <h2 class="opt-title">Options</h2>
        <div class="row"><span>Crouch key</span><button class="key crouch-toggle"></button></div>
        <div class="row"><span>Blood effects</span><button class="key blood-toggle"></button></div>
        <div class="row"><span>Combat cues (hit flashes, callouts, longer hit-pauses)</span><button class="key cues-toggle"></button></div>
        <div class="row"><span>Record battles for the Battle Log</span><button class="key rec-toggle"></button></div>
        <div class="actions">
          <button class="reset">Reset to defaults</button>
          <button class="close primary">Resume</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    this.rows = this.el.querySelector('.rows')!;
    // M1's controls are many: the list scrolls rather than pushing the options off the card.
    this.rows.style.maxHeight = '42vh';
    this.rows.style.overflowY = 'auto';
    this.el.querySelector('.pad-help')!.textContent = PAD_HELP;
    this.toggleRow('.crouch-toggle', () => (this.prefs.holdToCrouch ? 'Hold' : 'Toggle'), () => {
      this.prefs.holdToCrouch = !this.prefs.holdToCrouch;
    });
    // Rule 12: blood on is the gore level 'full', off is 'off' (the three-level setting is M5's).
    this.toggleRow('.blood-toggle', () => (this.prefs.gore !== 'off' ? 'On' : 'Off'), () => {
      this.prefs.gore = this.prefs.gore === 'off' ? 'full' : 'off';
      this.prefs.blood = this.prefs.gore !== 'off';
    });
    this.toggleRow('.cues-toggle', () => (this.prefs.cues ? 'On' : 'Off'), () => {
      this.prefs.cues = !this.prefs.cues;
    });
    this.toggleRow('.rec-toggle', () => (this.prefs.record ? 'On' : 'Off'), () => {
      this.prefs.record = !this.prefs.record;
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
    if (this.open) this.input.releasePointer();
    else this.input.capture = null;
    this.render();
    this.onOpenChange?.(this.open);
  }

  /** An option row's button: shows `label()`, and a click runs `flip`, saves and tells onPrefs. */
  private toggleRow(selector: string, label: () => string, flip: () => void): void {
    const b = this.el.querySelector<HTMLButtonElement>(selector)!;
    const show = () => (b.textContent = label());
    show();
    b.addEventListener('click', () => {
      flip();
      savePrefs(this.prefs);
      show();
      this.onPrefs?.(this.prefs);
    });
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
          // Escape cancels; reserved keys (menu, mute, log) and, in developer mode, the developer keys can't be bound.
          if (code !== 'Escape' && isBindable(code, DEV)) this.apply(rebind(this.input.bindings, a.id, code));
          else this.render();
        };
      });
      row.append(label, key);
      this.rows.appendChild(row);
    }
  }
}
