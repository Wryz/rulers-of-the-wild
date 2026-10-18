// The HUD (docs/M1-DESIGN.md §10.8, SPEC:419-423): DungeonStyle's DOM overlay made the minimal HUD of the Clearing, and
// the HudPort game.ts calls (main.ts hands it in as the port itself, RF-9):
// - health and stamina bars (DS); the guard bar only while locked on;
// - the hands strip (bottom left): what the hands hold (name, mass, mode, a two-handed mark), the belt slots 1-3 and
//   the back slot 4 with their keys;
// - the compass (ui/compass.ts, top centre) and the awareness markers (render/markers.ts);
// - the target bar while locked on (DS's lock-on: the target alive and within FOLLOW_TUNING.fightRangeM): an ape's
//   name and HP; the giant's HP bar with each wound a notch (severe ones larger) and what it costs the bar;
// - the death banner "DOWN — back in N s" (game.ts counts it down in sim ticks), the mood, popups and DS's callouts
//   (combat markers always; COUNTER, ARMORED, SKULL SPLIT… only with prefs.cues, off by default, realism.test.ts);
// - a refused verb's reason over the player's head, in §5.13's words (ui/radial.ts reasonText: "too heavy (300 kg)").
// DS's training HUD is gone: the round label (`.wave`), the move panel, the fight tips and the incoming-threat marker
// (§10.8's minimal HUD has none of them; DS's cues-only telegraph rings went with the training ring).
//
// The HUD reads the world and never writes it (rule 6). Its starting values are in HUD_TUNING; the marker and compass
// ranges and the ping fade are VERB_UI_TUNING's (§9.1).
import type { Camera, Vector3 } from 'three';
import {
  defineTuning,
  type Entity,
  type Fighter,
  heldMembers,
  heldShape,
  type Inventory,
  type MaterialId,
  type RulerState,
  rulerEffectiveMax,
  type World,
  type WorldEvent,
} from '@wild/sim';
import type { HudPort, SimEvent } from '../game/ports';
import { DEFAULT_PREFS, type Prefs } from '../game/prefs';
import { type Bindings, keyLabel } from '../input/bindings';
import { FOLLOW_TUNING } from '../render/followCam';
import { AwarenessMarkers } from '../render/markers';
import { Compass } from './compass';
import { reasonText } from './radial';

/**
 * The HUD's own starting values. DEVIATION (P36): §13.0 adds no tuning table after P05 and §9.1 has no HUD table; these
 * values are new with the M1 HUD (or were bare DS constants), and CLAUDE.md puts every starting value in a live table,
 * so the HUD registers its own (as P06's ENTITY_TUNING and P37's PANEL_TUNING did). VERB_UI_TUNING keeps the three HUD
 * rows §9.1 gives it (markerRangeM, compassPingS, compassSeeRangeM).
 */
export const HUD_TUNING = defineTuning(
  'HUD_TUNING',
  'Client › HUD',
  {
    compassSpanDeg: 180,
    compassTickDeg: 15,
    spawnPingHideM: 3,
    markerLiftM: 0.35,
    hintFadeAfter: 8,
  },
  {
    compassSpanDeg: { unit: '°', source: '§10.8 ("a 180° strip")', min: 60, max: 360, step: 5, label: 'compass span' },
    compassTickDeg: { unit: '°', source: 'NEW (P36): a tick on the compass every this many degrees', min: 5, max: 90, step: 5, label: 'compass ticks' },
    spawnPingHideM: { unit: 'm', source: 'NEW (P36): the spawn ping hides this close to the spawn', min: 0, max: 30, step: 0.5, label: 'spawn ping hides within' },
    markerLiftM: { unit: 'm × scale', source: 'NEW (P36): an awareness marker floats this far over the head', min: 0, max: 2, step: 0.05, label: 'marker height' },
    hintFadeAfter: { unit: 'strikes', source: 'DS (the controls hint fades after this many of your strikes)', min: 1, max: 50, step: 1, label: 'hint fades after' },
  },
);

/** What the HUD reads besides the world: the camera the frame is seen through, a running cut, the prefs, the keys. */
export interface HudContext {
  /** The camera the frame is seen through (popups and markers are placed with it). */
  camera: () => Camera;
  /** A kill cam is running: no combat markers over it (DS). */
  cutActive: () => boolean;
  /** The player's prefs (cues). */
  prefs: () => Readonly<Prefs>;
  /** The current key bindings (the hands strip's slot keys). */
  bindings: () => Readonly<Bindings>;
}

// ---------------------------------------------------------------------------
// What the HUD shows, as data (pure; the DOM below draws it)
// ---------------------------------------------------------------------------

/** §5.14's keys for the actions P35 adds to Bindings (shown until the player's bindings carry them). */
const M1_KEYS: Readonly<Record<string, string>> = {
  verb: 'KeyV',
  throw: 'KeyX',
  place: 'KeyC',
  target: 'Tab',
  jump: 'Space',
  sprint: 'ShiftLeft',
  crouch: 'ControlLeft',
  belt1: 'Digit1',
  belt2: 'Digit2',
  belt3: 'Digit3',
  back: 'Digit4',
};

/** The key bound to `action` (an action Bindings doesn't have yet reads §5.14's default). */
export function keyFor(b: Readonly<Bindings> | Readonly<Record<string, string>>, action: string): string {
  const code = (b as Readonly<Record<string, string | undefined>>)[action] ?? M1_KEYS[action] ?? '';
  return code ? keyLabel(code) : '';
}

const MATERIAL_WORDS: Readonly<Record<MaterialId, string>> = {
  greenWood: 'green wood',
  dryWood: 'dry wood',
  rottenWood: 'rotten wood',
  leaves: 'leaves',
  vine: 'vine',
  sinew: 'sinew',
  hide: 'hide',
  bone: 'bone',
  rulerBone: 'ruler bone',
  stone: 'stone',
  flint: 'flint',
  dirt: 'dirt',
  snow: 'snow',
  ice: 'ice',
  resin: 'resin',
  fat: 'fat',
};

/** What a thing is called on the HUD: its material and what it looks like ("dry wood log", "flint", "vine coil"). */
export function entityLabel(e: Pick<Entity, 'material' | 'look'>): string {
  const m = MATERIAL_WORDS[e.material] ?? e.material;
  const look = e.look;
  if (!look || look === e.material || look === m) return m;
  if (look === 'grass') return 'grass bundle';
  if (look in MATERIAL_WORDS) return MATERIAL_WORDS[look as MaterialId];
  return `${m} ${look}`;
}

export type HandsMode = NonNullable<Inventory['hands']>['mode'];

const MODE_WORDS: Readonly<Record<HandsMode, string>> = { wield: 'wielded', carry: 'carried', drag: 'dragging', ropeEnd: 'rope end' };

export interface HandsModel {
  /** What the hands hold, or null (empty hands). */
  held: { name: string; massKg: number; mode: HandsMode; modeLabel: string; twoHanded: boolean } | null;
  /** Belt slots 1-3, then the back (slot 4): the key and what is there (null: empty). */
  slots: { key: string; name: string | null; back: boolean }[];
}

/**
 * The hands strip (§10.8): the held thing's name (a wielded tool by its tool class, DS's weapon name; anything else by
 * its material and look), its mass (a wielded tool with everything lashed to it; a load as the sim weighs it) and mode;
 * the belt and back slots with their keys. A player without an inventory shows empty hands and slots.
 */
export function handsModel(world: World, f: Fighter, keys: Readonly<Bindings> | Readonly<Record<string, string>>): HandsModel {
  const inv = f.inventory;
  const name = (id: number | null): string | null => {
    if (id === null) return null;
    const e = world.entities.get(id);
    return e ? entityLabel(e) : null;
  };
  let held: HandsModel['held'] = null;
  const h = inv?.hands ?? null;
  const e = h ? world.entities.get(h.entity) : undefined;
  if (h && e) {
    const massKg = h.mode === 'wield' ? heldMembers(world, h.entity).reduce((s, id) => s + (world.entities.get(id)?.mass ?? 0), 0) : (f.load?.massKg ?? e.mass);
    held = {
      name: h.mode === 'wield' && f.weapon ? f.weapon.name : entityLabel(e),
      massKg,
      mode: h.mode,
      modeLabel: MODE_WORDS[h.mode],
      twoHanded: h.twoHanded,
    };
  }
  const belt = inv?.belt ?? [null, null, null];
  const slots: HandsModel['slots'] = [
    { key: keyFor(keys, 'belt1'), name: name(belt[0]), back: false },
    { key: keyFor(keys, 'belt2'), name: name(belt[1]), back: false },
    { key: keyFor(keys, 'belt3'), name: name(belt[2]), back: false },
    { key: keyFor(keys, 'back'), name: name(inv?.back ?? null), back: true },
  ];
  return { held, slots };
}

/** A mass as the HUD prints it: tenths of a kilogram under 10 kg, whole kilograms above. */
export function massText(kg: number): string {
  return kg < 10 ? `${kg.toFixed(1)} kg` : `${Math.round(kg)} kg`;
}

/** The fighter the player is locked on to (DS: its target, alive, within FOLLOW_TUNING.fightRangeM centre to centre). */
export function lockedTarget(player: Fighter): Fighter | null {
  const t = player.target;
  return t && t.alive && player.distanceTo(t) < FOLLOW_TUNING.fightRangeM ? t : null;
}

/** A ruler's HP bar (fractions of its max HP from the bar's full end): HP, then what recovers, the wounds, what's lost. */
export interface RulerBar {
  /** HP left: [0, hp]. */
  hp: number;
  /** Damage that made no wound and recovers (RulerState.unhealed): [hp, hp + recovering]. */
  recovering: number;
  /** Each wound's unhealed remainder, in creation order, after what recovers; a notch at each wound's start. */
  wounds: { from: number; to: number; severe: boolean }[];
  /** Max HP lost to severe wounds (SPEC:506): [lostFrom, 1]. */
  lostFrom: number;
}

/**
 * The layout of a ruler's bar from its state (§2.8: HP = effectiveMax − unhealed − Σ wound.remaining). Every wound gets
 * its notch, a healed one too (wounds on rulers persist, rule 9).
 */
export function rulerBarLayout(maxHp: number, effectiveMax: number, unhealed: number, wounds: readonly { remaining: number; severe: boolean }[]): RulerBar {
  const max = maxHp > 0 ? maxHp : 1;
  const c = (x: number) => Math.min(1, Math.max(0, x / max));
  const owed = wounds.reduce((s, w) => s + Math.max(0, w.remaining), 0);
  const hp = c(effectiveMax - unhealed - owed);
  const recovering = Math.min(c(Math.max(0, unhealed)), 1 - hp);
  let at = hp + recovering;
  const out: RulerBar['wounds'] = [];
  for (const w of wounds) {
    const to = Math.min(1, at + c(Math.max(0, w.remaining)));
    out.push({ from: at, to, severe: w.severe });
    at = to;
  }
  return { hp, recovering, wounds: out, lostFrom: Math.max(at, c(effectiveMax)) };
}

export interface TargetModel {
  name: string;
  /** HP fraction (an ape's hp / maxHp; a ruler's bar.hp). */
  hp: number;
  /** A ruler's bar, or null. */
  ruler: RulerBar | null;
}

/** The target bar while locked on (§10.8): an ape's name and HP; a ruler's bar with its wounds. */
export function targetModel(t: Fighter): TargetModel {
  const r: RulerState | null = t.ruler;
  if (r) {
    const bar = rulerBarLayout(r.maxHp, rulerEffectiveMax(r), r.unhealed, r.wounds);
    return { name: t.name, hp: bar.hp, ruler: bar };
  }
  return { name: t.name, hp: t.stats.maxHp > 0 ? Math.min(1, Math.max(0, t.hp / t.stats.maxHp)) : 0, ruler: null };
}

/**
 * What a refused verb says over the player's head (§10.7), in §5.13's words ("take: too heavy (300 kg)"); null for one
 * that worked, someone else's, or a `focus` (the UI checks a focus before sending it; a target leaving reach in the tick
 * between is not news).
 */
export function refusalText(e: Extract<WorldEvent, { type: 'verb' }>, player: Fighter | null, world: World | null): string | null {
  if (e.ok || e.f !== player || e.verb === 'focus') return null;
  if (!e.reason) return `can't ${e.verb}`;
  let kg: number | undefined;
  if (e.reason === 'tooHeavy' && e.entity !== undefined && world?.entities.get(e.entity)) kg = heldShape(world, e.entity).massKg;
  return `${e.verb}: ${reasonText(e.reason, kg)}`;
}

/** The death banner's line: "back in N s" (whole seconds, rounded up; never below 0). */
export function bannerText(secondsLeft: number): string {
  return `back in ${Math.max(0, Math.ceil(secondsLeft))} s`;
}

// ---------------------------------------------------------------------------
// The DOM
// ---------------------------------------------------------------------------

/** The HUD's own styles (the M1 parts; DS's are in style.css), added to the page once. */
const STYLE = `
.hud .bar.guard.off { display: none; }
.hud .bars.right .bar.hp .segs { position: absolute; inset: 0; }
.hud .bars.right .bar.hp .seg { position: absolute; top: 0; bottom: 0; }
.hud .bars.right .bar.hp .seg.wound { background: #6a1a14; }
.hud .bars.right .bar.hp .seg.lost { background: #08090c; }
.hud .bars.right .bar.hp .notch { position: absolute; top: 0; bottom: 0; width: 2px; margin-right: -1px; background: rgba(242, 237, 226, 0.85); }
.hud .bars.right .bar.hp .notch.severe { width: 4px; margin-right: -2px; background: var(--gold); }
.hud .bars.right .wounds { margin-top: 4px; font-size: 11px; letter-spacing: 0.12em; color: var(--dim); }
.hud .compass { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); width: min(46vw, 420px); height: 26px; overflow: hidden; background: rgba(20, 24, 32, 0.5); border-radius: 3px; color: var(--ink); font: 700 11px/1 var(--font); letter-spacing: 0.08em; transition: opacity 0.25s; }
.hud .compass .ctick { position: absolute; top: 3px; width: 1px; height: 6px; background: rgba(242, 237, 226, 0.45); transform: translateX(-50%); }
.hud .compass .ctick.card { width: auto; height: auto; top: 4px; background: none; }
.hud .compass .ctick.north { color: #ff6b5c; }
.hud .compass .cping { position: absolute; bottom: 2px; transform: translateX(-50%); font-size: 11px; }
.hud .compass .cping.spawn { color: #9ec8ff; }
.hud .compass .cping.giant { color: #ff9a3c; }
.hud .compass .cping.giant.seen { color: #ff5a3a; }
.hud .compass .ccentre { position: absolute; left: 50%; top: 0; width: 1px; height: 5px; background: var(--gold); }
.hud .hands { position: absolute; left: 16px; bottom: 58px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; color: var(--ink); font: 600 12px/1.2 var(--font); transition: opacity 0.25s; }
.hud .hands .held { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(12, 14, 20, 0.62); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 6px; }
.hud .hands .held.empty { color: var(--dim); }
.hud .hands .held .hmeta { color: var(--dim); font-weight: 500; }
.hud .hands .held .two { padding: 1px 5px; border-radius: 3px; background: var(--gold); color: #1d222c; font-size: 10px; }
.hud .hands .slots { display: flex; gap: 4px; }
.hud .hands .hslot { display: flex; align-items: center; gap: 5px; max-width: 130px; height: 24px; padding: 0 7px 0 4px; background: rgba(12, 14, 20, 0.55); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px; white-space: nowrap; overflow: hidden; }
.hud .hands .hslot span { overflow: hidden; text-overflow: ellipsis; }
.hud .hands .hslot b { min-width: 16px; height: 16px; padding: 0 3px; display: grid; place-items: center; border-radius: 3px; background: rgba(255, 255, 255, 0.85); color: #111; font-size: 10px; }
.hud .hands .hslot.empty span { color: var(--dim); }
.hud .hands .hslot.back { margin-left: 6px; }
.hud .aware { position: absolute; inset: 0; pointer-events: none; transition: opacity 0.25s; }
.hud .aware .amark { position: absolute; transform: translate(-50%, -100%); font: 900 24px/1 system-ui, sans-serif; color: var(--gold); text-shadow: 0 0 4px #000, 0 2px 6px #000; }
.hud .aware .amark.alert { color: #ff4030; }
.hud.cine > .compass, .hud.cine > .hands, .hud.cine > .aware { opacity: 0 !important; }
`;

function addStyle(): void {
  if (typeof document === 'undefined' || document.getElementById('wild-hud-style')) return;
  const s = document.createElement('style');
  s.id = 'wild-hud-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

/** DOM overlay: bars, the hands strip, the compass, the markers, the banner, popups and the controls hint. */
export class Hud implements HudPort {
  readonly compass: Compass;
  readonly markers: AwarenessMarkers;
  private ctx: HudContext | null;
  private readonly el: HTMLDivElement;
  private readonly pHp: HTMLDivElement;
  private readonly pHpLag: HTMLDivElement;
  private readonly pGuard: HTMLDivElement;
  private readonly pStamina: HTMLDivElement;
  private readonly eWrap: HTMLDivElement;
  private readonly eHp: HTMLDivElement;
  private readonly eHpLag: HTMLDivElement;
  private readonly eSegs: HTMLDivElement;
  private readonly eName: HTMLDivElement;
  private readonly eWounds: HTMLDivElement;
  private readonly combo: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly heldEl: HTMLDivElement;
  private readonly slotEls: { root: HTMLDivElement; key: HTMLElement; name: HTMLSpanElement }[] = [];
  private comboTimer = 0;
  private lagP = 1;
  private lagE = 1;
  private lagTarget: Fighter | null = null;
  private segsKey = '';
  private heldKey = '';
  private player: Fighter | null = null;
  private bannerShown: string | null = null;
  private attacksThrown = 0;

  constructor(root: HTMLElement, ctx: HudContext | null = null) {
    this.ctx = ctx;
    addStyle();
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="bars left">
        <div class="name">YOU</div>
        <div class="bar hp"><div class="lag"></div><div class="fill"></div></div>
        <div class="bar guard off"><div class="fill"></div></div>
        <div class="bar stamina"><div class="fill"></div></div>
      </div>
      <div class="bars right">
        <div class="name enemy-name"></div>
        <div class="bar hp"><div class="segs"></div><div class="lag"></div><div class="fill"></div></div>
        <div class="wounds"></div>
      </div>
      <div class="hands">
        <div class="held empty"></div>
        <div class="slots"></div>
      </div>
      <div class="prompt"></div>
      <div class="combo"></div>
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
    this.eSegs = q('.right .hp .segs');
    this.eName = q('.enemy-name');
    this.eWounds = q('.right .wounds');
    this.combo = q('.combo');
    this.banner = q('.banner');
    this.hint = q('.hint');
    this.promptEl = q('.prompt');
    this.heldEl = q('.hands .held');
    const slots = q<HTMLDivElement>('.hands .slots');
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('div');
      s.className = i === 3 ? 'hslot back empty' : 'hslot empty';
      s.innerHTML = '<b></b><span></span>';
      slots.appendChild(s);
      this.slotEls.push({ root: s, key: s.querySelector('b')!, name: s.querySelector('span')! });
    }
    this.eWrap.style.opacity = '0';
    // The compass sits under the bars' row; the markers float over everything but the bars.
    this.compass = new Compass(this.el, HUD_TUNING);
    this.markers = new AwarenessMarkers(this.el, HUD_TUNING);
  }

  /** Hands the HUD what it reads besides the world (main.ts, once the camera and the menus exist). */
  connect(ctx: HudContext): void {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  // HudPort
  // ---------------------------------------------------------------------------

  update(world: World, player: Fighter | null, dt: number): void {
    this.player = player;
    if (!player) return;
    const target = lockedTarget(player);
    this.bars(dt, player, target);
    this.hands(world, player);
    const cam = this.ctx?.camera() ?? null;
    if (cam) {
      cam.updateMatrixWorld();
      this.compass.update(world, player, cam, dt);
      this.markers.update(world, player, cam);
    }
  }

  /** Screen mood: '' normal, 'death' dark red edges and drained colour. */
  mood(kind: '' | 'death'): void {
    this.el.classList.toggle('dying', kind === 'death');
    document.body.classList.toggle('dying', kind === 'death');
  }

  /** "DOWN — back in N s" (null hides it); game.ts counts the seconds from the sim's respawn tick. */
  deathBanner(secondsLeft: number | null): void {
    const text = secondsLeft === null ? null : bannerText(secondsLeft);
    if (text === this.bannerShown) return;
    this.bannerShown = text;
    if (text === null) this.hideBanner();
    else this.showBanner('DOWN', text, 'down');
  }

  /** A callout over the player's head (a refused verb's reason). */
  popup(text: string): void {
    const p = this.player;
    const cam = this.ctx?.camera();
    if (!p || !cam) return;
    this.popupAt(text, overHead(p, 2.1), cam, '');
  }

  /**
   * DS's combat markers (always on) and cues popups (prefs.cues) for an event: what a blow did, where it landed; and a
   * refused verb's reason.
   */
  handle(e: SimEvent, world: World): void {
    const me = this.player;
    const cam = this.ctx?.camera();
    if (!cam) return;
    const cues = (this.ctx?.prefs() ?? DEFAULT_PREFS).cues;
    switch (e.type) {
      case 'verb': {
        const text = refusalText(e, me, world);
        if (text) this.popup(text);
        return;
      }
      case 'attackStart':
        if (e.f === me && ++this.attacksThrown === HUD_TUNING.hintFadeAfter) this.fadeHint();
        return;
      case 'hit': {
        const dmg = Math.max(1, Math.round(e.damage));
        const byMe = e.attacker === me;
        if (byMe) this.marker(e.counter ? `COUNTER ${dmg}` : String(dmg), e.point, e.counter || e.damage >= 12 ? 'dmg big' : 'dmg');
        else if (e.defender === me) this.marker(`-${dmg}`, e.point, 'hurt');
        if (e.tear) {
          const label = e.tear.piece === 'earL' || e.tear.piece === 'earR' ? 'EAR OFF' : e.tear.piece === 'scalp' ? 'SCALPED' : null;
          if (label) this.marker(label, e.tear.point, e.defender === me ? 'hurt' : 'big');
        }
        if (!cues) return;
        if (byMe && e.combo >= 2) this.showCombo(e.combo);
        if (byMe && e.counter) this.popupAt('COUNTER', e.point, cam, 'counter');
        if (byMe && e.armored) this.popupAt('ARMORED', e.point, cam, 'armor');
        if (e.sever) {
          const b = e.sever;
          this.popupAt(b === 'head' ? 'DECAPITATED' : b.startsWith('thigh') || b.startsWith('shin') ? 'LEG OFF' : 'ARM OFF', e.point, cam, 'armor');
        } else if (e.fatal) {
          this.popupAt(e.fatal === 'split' ? 'SKULL SPLIT' : e.fatal === 'cleft' ? 'SKULL CLEFT' : 'SKULL CRUSHED', e.point, cam, 'armor');
        }
        return;
      }
      case 'block':
        if (e.guardBreak) this.marker('GUARD BREAK', e.point, 'armor');
        else if (e.parry && e.perfect) this.marker('PERFECT PARRY', e.point, 'parry big');
        else if (e.parry) this.marker(e.defender === me ? 'PARRY!' : 'PARRIED', e.point, e.defender === me ? 'parry' : 'hurt');
        else this.marker(e.defender === me ? 'BLOCK' : 'BLOCKED', e.point, 'block');
        return;
      case 'dodge':
        if (e.defender === me && e.perfect) this.marker('PERFECT DODGE', e.point, 'parry big');
        else if (e.defender === me) this.marker(e.kind === 'airborne' ? 'EVADED' : 'DODGE', e.point, 'parry');
        else this.marker('MISS', e.point, 'miss');
        return;
      case 'pickup':
        if (cues && e.f === me) this.popupAt(e.drop.weapon.name.toUpperCase(), overHead(e.f, 2.1), cam, 'counter');
        return;
      case 'bleedout':
        if (cues) this.popupAt('BLED OUT', overHead(e.f, 1.6), cam, 'armor');
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // DS (main.ts and the cut's letterbox)
  // ---------------------------------------------------------------------------

  /** Letterbox bars in, gameplay HUD out (camera cuts). */
  cinematic(on: boolean): void {
    this.el.classList.toggle('cine', on);
  }

  /** Short prompt floating above a world position (empty text hides it). */
  prompt(text: string, world?: Vector3, camera?: Camera): void {
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

  /** Rebuilds the controls hint from the current key bindings (M1's controls, §5.14). */
  setBindings(b: Bindings): void {
    const k = (action: string) => `<b>${keyFor(b, action)}</b>`;
    this.hint.innerHTML = `
      <span>${k('up')}${k('left')}${k('down')}${k('right')} move</span>
      <span>${k('lpunch')} ${k('rpunch')} punch <span class="dim">· as a strike lands: parry</span></span>
      <span>${k('lkick')} ${k('rkick')} kick</span>
      <span>${k('target')} target</span>
      <span>${k('pickup')} take / drop</span>
      <span>hold ${k('verb')} verbs</span>
      <span>hold ${k('throw')} throw · hold ${k('place')} place</span>
      <span>${k('belt1')}–${k('back')} belt / back</span>
      <span>${k('jump')} jump · ${k('sprint')} sprint · ${k('crouch')} crouch</span>
      <span class="dim"><b>Esc</b> settings</span>
      <span class="dim"><b>B</b> log</span>
      <span class="dim"><b>M</b> mute</span>`;
  }

  get gearButton(): HTMLButtonElement {
    return this.el.querySelector('.gear')!;
  }

  get logButton(): HTMLButtonElement {
    return this.el.querySelector('.logbtn')!;
  }

  showCombo(n: number): void {
    if (n < 2) return;
    this.combo.innerHTML = `<b>${n}</b> HITS`;
    this.combo.classList.remove('show');
    void this.combo.offsetWidth;
    this.combo.classList.add('show');
    this.comboTimer = 1.4;
  }

  showBanner(text: string, sub = '', cls = ''): void {
    this.banner.className = `banner show ${cls}`;
    this.banner.innerHTML = `<div>${text}</div>${sub ? `<small>${sub}</small>` : ''}`;
  }

  hideBanner(): void {
    this.banner.className = 'banner';
  }

  fadeHint(): void {
    this.hint.classList.add('faded');
  }

  /** Small callout that floats up from a world position (DS popup). */
  popupAt(text: string, world: Vector3, camera: Camera, cls = ''): void {
    const p = world.clone().project(camera);
    const div = document.createElement('div');
    div.className = `popup ${cls}`;
    div.textContent = text;
    div.style.left = `${(p.x * 0.5 + 0.5) * 100}%`;
    div.style.top = `${(-p.y * 0.5 + 0.5) * 100}%`;
    this.el.appendChild(div);
    setTimeout(() => div.remove(), 900);
  }

  dispose(): void {
    this.compass.dispose();
    this.markers.dispose();
    this.el.remove();
  }

  // ---------------------------------------------------------------------------

  /** You (HP, stamina; guard while locked on) and the target you're locked on to (DS bars; a ruler's wounds). */
  private bars(dt: number, player: Fighter, target: Fighter | null): void {
    const ph = player.hp / player.stats.maxHp;
    this.lagP = Math.max(ph, this.lagP - dt * 0.5);
    this.pHp.style.width = `${ph * 100}%`;
    this.pHpLag.style.width = `${this.lagP * 100}%`;
    const guardBar = this.pGuard.parentElement!;
    guardBar.classList.toggle('off', target === null);
    this.pGuard.style.width = `${(player.guard / player.stats.maxGuard) * 100}%`;
    guardBar.classList.toggle('low', player.guard < 30);
    this.pStamina.style.width = `${player.stamina * 100}%`;
    this.pStamina.parentElement!.classList.toggle('low', player.stamina < 0.3);
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) this.combo.classList.remove('show');
    if (!target) {
      this.eWrap.style.opacity = '0';
      this.lagE = 1;
      this.lagTarget = null;
      return;
    }
    const t = targetModel(target);
    if (target !== this.lagTarget) {
      this.lagTarget = target;
      this.lagE = t.hp;
    }
    this.eWrap.style.opacity = '1';
    const name = t.name.toUpperCase();
    if (this.eName.textContent !== name) this.eName.textContent = name;
    this.eHp.style.width = `${t.hp * 100}%`;
    if (t.ruler) {
      // What recovers shows as the trail; the wounds and the lost maximum after it, each wound with its notch.
      this.eHpLag.style.width = `${(t.ruler.hp + t.ruler.recovering) * 100}%`;
      this.drawRulerBar(t.ruler);
      const severe = t.ruler.wounds.filter((w) => w.severe).length;
      const text = t.ruler.wounds.length ? `${t.ruler.wounds.length} WOUND${t.ruler.wounds.length > 1 ? 'S' : ''}${severe ? ` · ${severe} SEVERE` : ''}` : '';
      if (this.eWounds.textContent !== text) this.eWounds.textContent = text;
    } else {
      this.lagE = Math.max(t.hp, this.lagE - dt * 0.5);
      this.eHpLag.style.width = `${this.lagE * 100}%`;
      this.drawRulerBar(null);
      if (this.eWounds.textContent) this.eWounds.textContent = '';
    }
  }

  /** The wound segments and notches of a ruler's bar (the right bar runs from the right, so offsets are from it). */
  private drawRulerBar(bar: RulerBar | null): void {
    const key = bar ? `${bar.lostFrom.toFixed(4)}|${bar.wounds.map((w) => `${w.from.toFixed(4)}-${w.to.toFixed(4)}${w.severe ? 's' : ''}`).join(',')}` : '';
    if (key === this.segsKey) return;
    this.segsKey = key;
    this.eSegs.innerHTML = '';
    if (!bar) return;
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    const seg = (cls: string, from: number, to: number) => {
      const d = document.createElement('div');
      d.className = `seg ${cls}`;
      d.style.right = pct(from);
      d.style.width = pct(Math.max(0, to - from));
      this.eSegs.appendChild(d);
    };
    for (const w of bar.wounds) seg('wound', w.from, w.to);
    if (bar.lostFrom < 1) seg('lost', bar.lostFrom, 1);
    for (const w of bar.wounds) {
      const n = document.createElement('div');
      n.className = w.severe ? 'notch severe' : 'notch';
      n.style.right = pct(w.from);
      this.eSegs.appendChild(n);
    }
  }

  /** The hands strip (redrawn only when what it shows changes). */
  private hands(world: World, player: Fighter): void {
    const m = handsModel(world, player, this.ctx?.bindings() ?? {});
    const h = m.held;
    const key = `${h ? `${h.name}|${massText(h.massKg)}|${h.modeLabel}|${h.twoHanded}` : ''}#${m.slots.map((s) => `${s.key}:${s.name ?? ''}`).join('|')}`;
    if (key === this.heldKey) return;
    this.heldKey = key;
    this.heldEl.classList.toggle('empty', !h);
    this.heldEl.innerHTML = h
      ? `<span class="hname"></span><span class="hmeta"></span>${h.twoHanded ? '<b class="two" title="Two-handed">2H</b>' : ''}`
      : '<span class="hname">empty hands</span>';
    if (h) {
      this.heldEl.querySelector('.hname')!.textContent = h.name;
      this.heldEl.querySelector('.hmeta')!.textContent = `${massText(h.massKg)} · ${h.modeLabel}`;
    }
    m.slots.forEach((s, i) => {
      const el = this.slotEls[i];
      el.key.textContent = s.key;
      el.name.textContent = s.name ?? (s.back ? 'back' : '—');
      el.root.classList.toggle('empty', s.name === null);
    });
  }

  private marker(text: string, at: Vector3, cls: string): void {
    const cam = this.ctx?.camera();
    if (!cam || this.ctx?.cutActive()) return;
    this.popupAt(text, at.clone().setY(at.y + 0.25), cam, cls);
  }
}

/** A point `h` m (× scale) above the fighter's feet (DS popups sat at fixed heights over a flat floor). */
function overHead(f: Fighter, h: number): Vector3 {
  return f.pos.clone().setY(f.pos.y + h * f.scale);
}
