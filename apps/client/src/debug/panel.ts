// The developer panel (L; docs/M1-DESIGN.md §10.10, SPEC:12, 644): every live tuning table, built from the registry
// (TUNING) — one folder per table's registered `folder`, one binding per field with its label, unit and range — plus
// developer buttons, toggles and read-outs for a playtest observer.
//
// Rule 6 and RR-17: an edit to a sim table is never written into the table here. It goes out as a `meta 'dev'
// setTuning` command through the game loop (loop.dev), is applied in phase 1c of the next tick, and so sits in the
// command log, and a replay reproduces it; until that tick the sim's value is unchanged (the panel shows the pending
// value meanwhile). Client tables ("Client › …") never touch the sim and change at once. The panel binds only its own
// objects (a proxy per field, its read-outs); it binds no sim table, no fighter and nothing a fighter holds.
import { type FolderApi, Pane } from 'tweakpane';
import {
  defineTuning,
  type DevOp,
  GIVE_TOOLS,
  type GiveTool,
  DT,
  type Entity,
  type Fighter,
  getTuningValue,
  rulerHp,
  serializeWorld,
  TUNING,
  type TuningEntry,
  type TuningLeaf,
  tuningLeaves,
  tuningSnapshot,
  type TuningValue,
  type V3,
  type World,
} from '@wild/sim';
import type { LoopPort, PanelPort, SfxPort, SimEvent } from '../game/ports';

/** The panel's own starting values (a dev-only client table: it registers when developer mode loads the panel). */
export const PANEL_TUNING = defineTuning(
  'PANEL_TUNING',
  'Client › dev panel',
  { refreshS: 0.25, impactsShown: 10, tripwiresShown: 6, nearEntityM: 3, spawnApeAheadM: 6, teleportGiantOffsetM: 8 },
  {
    refreshS: { unit: 's', source: 'DS (panel.ts: refreshed every 250 ms)', min: 0, max: 2, step: 0.05, label: 'refresh every' },
    impactsShown: { unit: 'impacts', source: '§10.10 (the last 10 impacts, RT-24)', min: 1, max: 50, step: 1, label: 'impacts shown' },
    tripwiresShown: { unit: 'events', source: 'NEW: P37 (§10.10 tripwire events)', min: 1, max: 50, step: 1, label: 'tripwires shown' },
    nearEntityM: { unit: 'm', source: 'NEW: P37 (the entity read out: the nearest this close to the focused point, or to the player)', min: 0, max: 20, step: 0.5, label: 'nearest entity within' },
    spawnApeAheadM: { unit: 'm', source: 'NEW: P37 ("spawn an ape near": this far in front of the player)', min: 1, max: 50, step: 0.5, label: 'spawn ape ahead' },
    teleportGiantOffsetM: { unit: 'm', source: 'NEW: P37 ("teleport to the giant": this far off it along x and z)', min: 0, max: 50, step: 0.5, label: 'teleport off the giant' },
  },
);

/**
 * The dev ops world/devOps.ts applies (P22: all of them). An op left out of this set gets a disabled button: a dev op
 * devOps.ts can't apply would throw in phase 1c and break the tick.
 */
export const DEV_OPS_READY: ReadonlySet<DevOp> = new Set<DevOp>([
  'spawnApe',
  'spawnGiant',
  'giveTool',
  'teleport',
  'pauseMinds',
  'killCreature',
  'respawnPlayer',
  'setTuning',
]);

/** What the panel needs of the game (game/game.ts's Game is one). */
export interface PanelHost {
  readonly world: World;
  /** The loop driving the game (null before its first frame): dev ops and setTuning go through it as commands. */
  readonly loop: Pick<LoopPort, 'dev' | 'requestStep' | 'save'> | null;
  readonly sfx: Pick<SfxPort, 'setVolume'>;
  /** Developer Backspace: rebuild the world from the same seed. */
  readonly onRebuild: (() => void) | null;
  /** Rebuilds the game around a loaded save (absent: "Load world" is disabled). TODO(main.ts follow-up). */
  readonly loadWorld?: ((bytes: Uint8Array) => void) | null;
}

/** The subset of Tweakpane the panel uses (tests hand in a fake). */
export interface PanelBinding {
  on(ev: 'change', handler: (e: { value: unknown; last: boolean }) => void): unknown;
  refresh(): void;
}
export interface PanelButton {
  on(ev: 'click', handler: () => void): unknown;
}
export interface PanelFolder {
  addFolder(params: { title: string; expanded?: boolean }): PanelFolder;
  addBinding(obj: Record<string, unknown>, key: string, params?: Record<string, unknown>): PanelBinding;
  addButton(params: { title: string; disabled?: boolean }): PanelButton;
  /**
   * Calls `handler` the first time the folder is opened (Tweakpane's fold event). A table's bindings are made then:
   * the registry has ~1,100 fields, too many to build at boot. Without it the panel fills every folder at once.
   */
  onFirstOpen?(handler: () => void): void;
}

export interface PanelOptions {
  /** The panel's root (default: a Tweakpane in a `.panel` div on the page). */
  pane?: PanelFolder;
  /** Milliseconds, for the refresh throttle (default performance.now). */
  now?: () => number;
}

/** One field's view: the proxy the panel binds and what it edits. A compound field has one view per primitive. */
interface LeafView {
  readonly entry: TuningEntry;
  /** A sim table: edits are setTuning commands. */
  readonly sim: boolean;
  /** Dotted key of the primitive in its table. */
  readonly key: string;
  /** The key's segments (read straight from the table on every refresh). */
  readonly path: readonly string[];
  readonly kind: 'number' | 'numberText' | 'boolean' | 'options' | 'readOnly';
  readonly proxy: { v: TuningValue };
  readonly bindings: PanelBinding[];
  /** A drag in progress (no refresh until its last change). */
  editing: boolean;
}

/** A sim edit sent and not yet applied (its tick hasn't run). */
interface PendingEdit {
  value: TuningValue;
  tick: number;
}

const IS_CLIENT = /^Client(\s›|$)/;

/** Builds the panel (developer mode, main.ts). */
export function buildPanel(host: PanelHost, opts: PanelOptions = {}): DevPanel {
  return new DevPanel(host, opts);
}

export class DevPanel implements PanelPort {
  private readonly root: PanelFolder;
  private readonly container: HTMLElement | null = null;
  private shown = false;
  private readonly now: () => number;
  private lastRefresh = -Infinity;
  private refreshing = false;
  private readonly views = new Map<string, LeafView>();
  private readonly tableFolders = new Map<string, { folder: PanelFolder; path: string[] }>();
  private readonly folderByName = new Map<string, PanelFolder>();
  private readonly pending = new Map<string, PendingEdit>();
  private built = 0;
  private readonly ro = { player: 'PLAYER', focus: 'ENTITY', giant: 'GIANT', impacts: 'LAST IMPACTS', tripwires: 'TRIPWIRES' };
  private readonly inspect = { entity: 0 };
  private readonly impacts: string[] = [];
  private readonly tripwires: string[] = [];
  /** handle() has been called: the game dispatches every tick's events here (else refresh reads the last tick's). */
  private gotEvents = false;
  private scannedTick = -1;
  private readonly monitors: PanelBinding[] = [];

  constructor(
    private readonly host: PanelHost,
    opts: PanelOptions = {},
  ) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    if (opts.pane) this.root = opts.pane;
    else {
      const container = document.createElement('div');
      container.className = 'panel';
      container.style.display = 'none';
      container.style.width = '340px';
      // Typing into a field is the field's: the game's keys (Enter, L, P, the number keys…) listen on the window and
      // would steal the keystrokes, and Enter's preventDefault there would stop the field from committing.
      container.addEventListener('keydown', (e) => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) e.stopPropagation();
      });
      document.body.appendChild(container);
      this.container = container;
      this.root = tweakpane(container);
    }
    this.buildDev();
    this.buildReadouts();
    this.syncTables();
  }

  // ---------------------------------------------------------------------------
  // PanelPort
  // ---------------------------------------------------------------------------

  get visible(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.shown = !this.shown;
    if (this.container) this.container.style.display = this.shown ? 'block' : 'none';
    if (this.shown) this.lastRefresh = -Infinity;
  }

  /** Per rendered frame while shown (Game.render): pending edits resolve, values and read-outs follow the game. */
  refresh(world: World): void {
    if (!this.gotEvents) this.scanEvents(world);
    const now = this.now();
    if (now - this.lastRefresh < PANEL_TUNING.refreshS * 1000) return;
    this.lastRefresh = now;
    this.syncTables();
    this.refreshing = true;
    try {
      for (const [id, p] of this.pending) if (world.tick >= p.tick) this.pending.delete(id);
      for (const [id, v] of this.views) {
        if (v.editing) continue;
        const next = shown(this.effective(id, v), v.kind);
        if (Object.is(next, v.proxy.v)) continue;
        v.proxy.v = next;
        for (const b of v.bindings) b.refresh();
      }
      this.readouts(world);
      for (const m of this.monitors) m.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * One event of a stepped tick, for the impact and tripwire read-outs. TODO(game.ts follow-up): Game.dispatch should
   * call this for every event; until it does, refresh() reads the world's events of the last tick of each frame.
   */
  handle(e: SimEvent, world: World): void {
    this.gotEvents = true;
    this.record(e, world.tick);
  }

  // ---------------------------------------------------------------------------
  // For tests and tools
  // ---------------------------------------------------------------------------

  /** The bindings of a field (`key` dotted; a compound field's primitives are `key.0`, `key.minM`…). */
  bindingsOf(table: string, key: string): readonly PanelBinding[] {
    return this.views.get(viewId(table, key))?.bindings ?? [];
  }

  /** Every bound primitive's dotted key in a table. */
  boundKeys(table: string): string[] {
    return [...this.views.values()].filter((v) => v.entry.name === table).map((v) => v.key);
  }

  /** The folder path a table's fields sit in (its registered folder, then its name when it shares the folder). */
  folderPathOf(table: string): readonly string[] | null {
    return this.tableFolders.get(table)?.path ?? null;
  }

  /** Sim edits sent and not yet applied. */
  get pendingEdits(): number {
    return this.pending.size;
  }

  // ---------------------------------------------------------------------------
  // Building
  // ---------------------------------------------------------------------------

  /** Developer controls: DS's step, restart and quick views, save/load, tuning as JSON, and the dev-op commands. */
  private buildDev(): void {
    const dev = this.root.addFolder({ title: 'Dev', expanded: true });
    dev.addButton({ title: 'Step frame (.)' }).on('click', () => this.host.loop?.requestStep());
    dev.addButton({ title: 'Restart (Backspace)' }).on('click', () => this.host.onRebuild?.());
    // The time and view toggles are GAME_TUNING's ("Client › game"); the quickest ones are also here.
    const game = TUNING.find((e) => e.name === 'GAME_TUNING');
    if (game) {
      const leaves = tuningLeaves(game);
      for (const key of ['timeScale', 'paused', 'showHitboxes', 'showNav', 'showSenses', 'showZones']) {
        const leaf = leaves.find((l) => l.key === key);
        if (leaf) this.bindLeaf(dev, game, leaf, key, leaf.meta);
      }
    }
    const saveReady = this.saveReady();
    dev.addButton({ title: saveReady ? 'Save world (download)' : 'Save world (arrives with P13)', disabled: !saveReady }).on('click', () => this.host.loop?.save());
    const load = this.host.loadWorld;
    dev.addButton({ title: load ? 'Load world…' : 'Load world (needs main.ts)', disabled: !load }).on('click', () => this.pickSave());
    dev.addButton({ title: 'Copy tuning as JSON' }).on('click', () => {
      const json = tuningSnapshot();
      console.log(json);
      void (typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(json) : undefined);
    });
    dev.addButton({ title: 'Reset sim tuning (commands)' }).on('click', () => this.resetToDefaults(true));
    dev.addButton({ title: 'Reset client tuning' }).on('click', () => this.resetToDefaults(false));

    const ops = dev.addFolder({ title: 'Dev ops (commands)', expanded: false });
    const op = (title: string, devOp: DevOp, args: () => number[] | null) => {
      const ready = DEV_OPS_READY.has(devOp);
      ops.addButton({ title: ready ? title : `${title} (P22)`, disabled: !ready }).on('click', () => {
        const a = args();
        if (a) this.host.loop?.dev(devOp, a);
      });
    };
    // Argument encodings: world/devOps.ts's table (points in whole cm, like verb commands; giveTool indexes GIVE_TOOLS).
    op('Spawn an ape near', 'spawnApe', () => {
      const p = this.host.world.player;
      if (!p) return null;
      const d = PANEL_TUNING.spawnApeAheadM;
      return cm([p.pos.x + Math.sin(p.yaw) * d, p.pos.z + Math.cos(p.yaw) * d]);
    });
    op('Spawn the giant at its lair', 'spawnGiant', () => []);
    GIVE_TOOLS.forEach((tool, i) => op(`Give: ${TOOL_LABELS[tool]}`, 'giveTool', () => [i]));
    op('Teleport: spawn', 'teleport', () => cm([Number(getTuningValue('WORLD_TUNING', 'spawnX')), Number(getTuningValue('WORLD_TUNING', 'spawnZ'))]));
    op('Teleport: home A', 'teleport', () => {
      const h = this.homeA();
      return h ? cm([h.x, h.z]) : null;
    });
    op('Teleport: the giant', 'teleport', () => {
      const g = giantOf(this.host.world);
      const o = PANEL_TUNING.teleportGiantOffsetM;
      return g ? cm([g.pos.x + o, g.pos.z + o]) : null;
    });
    op('Pause minds', 'pauseMinds', () => [1]);
    op('Resume minds', 'pauseMinds', () => [0]);
    op('Kill the target', 'killCreature', () => {
      const t = this.host.world.player?.target;
      return t ? [t.id] : null;
    });
    op('Respawn', 'respawnPlayer', () => []);

    const note = {
      text: ['Sim tables: an edit is a setTuning', 'command, applied on the next tick', '(so a replay keeps it).', 'Client tables: applied at once.'].join('\n'),
    };
    dev.addBinding(note, 'text', { readonly: true, multiline: true, rows: 4, label: null, interval: 0 });
  }

  /** The read-outs a playtest observer needs to see what a trap did (§10.10, RT-24). */
  private buildReadouts(): void {
    const f = this.root.addFolder({ title: 'Read-outs (live)', expanded: false });
    f.addBinding(this.inspect, 'entity', { min: 0, step: 1, label: 'inspect entity (0: focus)' });
    // Full width (no label column): each text starts with its own title line.
    const mon = (key: keyof DevPanel['ro'], rows: number) => {
      this.monitors.push(f.addBinding(this.ro, key, { readonly: true, multiline: true, rows, label: null, interval: 0 }));
    };
    mon('player', 7);
    mon('focus', 8);
    mon('giant', 7);
    mon('impacts', 11);
    mon('tripwires', 7);
  }

  /** Builds the folders of every table registered since the last call (tables register as modules load). */
  private syncTables(): void {
    for (; this.built < TUNING.length; this.built++) this.buildTable(TUNING[this.built]);
  }

  /** One table: its registered folder (shared folders get a sub-folder per table), one binding per field. */
  private buildTable(entry: TuningEntry): void {
    let shared = this.folderByName.get(entry.folder);
    if (!shared) {
      shared = this.root.addFolder({ title: entry.folder, expanded: false });
      this.folderByName.set(entry.folder, shared);
    }
    // Tables sharing a folder ("Creatures › bodies") each get a sub-folder named after the table.
    const own = TUNING.filter((e) => e.folder === entry.folder).length > 1;
    const folder = own ? shared.addFolder({ title: entry.name, expanded: false }) : shared;
    this.tableFolders.set(entry.name, { folder, path: own ? [entry.folder, entry.name] : [entry.folder] });
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      this.fillTable(entry, folder);
    };
    if (folder.onFirstOpen) folder.onFirstOpen(fill);
    else fill();
  }

  /** A table's bindings: one per field (nested tables as sub-folders; a compound value, one per primitive). */
  private fillTable(entry: TuningEntry, folder: PanelFolder): void {
    const subs = new Map<string, PanelFolder>();
    const folderFor = (segments: readonly string[]): PanelFolder => {
      let f = folder;
      for (let i = 0; i < segments.length; i++) {
        const k = segments.slice(0, i + 1).join('.');
        let sub = subs.get(k);
        if (!sub) {
          sub = f.addFolder({ title: segments[i], expanded: false });
          subs.set(k, sub);
        }
        f = sub;
      }
      return f;
    };
    for (const leaf of tuningLeaves(entry)) {
      const path = leaf.key.split('.');
      const parent = folderFor(path.slice(0, -1));
      const value = getTuningValue(entry.name, leaf.key);
      if (value !== null && typeof value === 'object') {
        // A compound value (a range [min, max], a material's strength, a species' parts): one binding per primitive.
        const into = parent.addFolder({ title: leafLabel(leaf.meta.label ?? path[path.length - 1], leaf.meta.unit), expanded: false });
        const prims = primitivesOf(value, []);
        if (prims.length === 0) this.bindLeaf(into, entry, leaf, leaf.key, leaf.meta, 'value', true);
        for (const p of prims) this.bindLeaf(into, entry, leaf, `${leaf.key}.${p.join('.')}`, leaf.meta, p.join('.'), leaf.readOnly);
      } else this.bindLeaf(parent, entry, leaf, leaf.key, leaf.meta, undefined, leaf.readOnly);
    }
  }

  /** Binds one primitive through its proxy (a second binding of the same primitive shares the proxy). */
  private bindLeaf(
    folder: PanelFolder,
    entry: TuningEntry,
    leaf: TuningLeaf,
    key: string,
    meta: TuningLeaf['meta'],
    label?: string,
    readOnly = leaf.readOnly,
  ): void {
    const id = viewId(entry.name, key);
    let v = this.views.get(id);
    if (!v) {
      const value = readValue(entry.name, key);
      const kind = kindOf(value, meta, readOnly);
      v = { entry, sim: !IS_CLIENT.test(entry.folder), key, path: key.split('.'), kind, proxy: { v: shown(value, kind) }, bindings: [], editing: false };
      this.views.set(id, v);
    }
    const view = v;
    const params: Record<string, unknown> = { label: leafLabel(label ?? meta.label ?? key.split('.').pop()!, meta.unit) };
    switch (view.kind) {
      case 'number':
        if (meta.min !== undefined) params.min = meta.min;
        if (meta.max !== undefined) params.max = meta.max;
        if (meta.step !== undefined) params.step = meta.step;
        // Without a step Tweakpane shows two decimals, which hides small values (0.0022 rad/px reads 0.00).
        else params.format = formatNumber;
        break;
      case 'options':
        params.options = Object.fromEntries((meta.options ?? []).map((o) => [o, o]));
        break;
      case 'readOnly':
        // (Refreshed by the panel with everything else, not by a timer of its own.)
        params.readonly = true;
        params.interval = 0;
        break;
      default:
        break;
    }
    const b = folder.addBinding(view.proxy, 'v', params);
    view.bindings.push(b);
    if (view.kind !== 'readOnly') b.on('change', (e) => this.edited(id, view, e.value, e.last));
  }

  // ---------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------

  /** A binding changed: a sim value goes out as a setTuning command (its last change only), a client value at once. */
  private edited(id: string, v: LeafView, raw: unknown, last: boolean): void {
    if (this.refreshing) return;
    const value = parsed(raw, v.kind);
    if (value === null) {
      this.show(id, v);
      return;
    }
    if (!v.sim) {
      const before = readAt(v);
      if (!Object.is(before, value)) {
        writeClient(v.entry, v.key, value);
        clientEdited(this.host, v.entry.name, v.key, value);
      }
      this.syncBindings(v, value);
      return;
    }
    v.editing = !last;
    if (!last) return; // a drag sends its final value only: one command per edit
    if (Object.is(value, this.effective(id, v))) {
      this.syncBindings(v, value);
      return;
    }
    const loop = this.host.loop;
    if (!loop) {
      console.warn('Dev panel: the game loop has not started yet; the edit was not sent.');
      this.show(id, v);
      return;
    }
    loop.dev('setTuning', [], { table: v.entry.name, key: v.key, value });
    this.pending.set(id, { value, tick: this.host.world.tick + 1 });
    this.syncBindings(v, value);
  }

  /** The value a field shows: a sent edit until its tick has run, else the table's. */
  private effective(id: string, v: LeafView): TuningValue | null {
    const p = this.pending.get(id);
    if (p && this.host.world.tick < p.tick) return p.value;
    return readAt(v);
  }

  /** Puts the field's bindings back on its effective value. */
  private show(id: string, v: LeafView): void {
    v.editing = false;
    this.syncBindings(v, this.effective(id, v));
  }

  private syncBindings(v: LeafView, value: TuningValue | null): void {
    const was = this.refreshing;
    this.refreshing = true;
    try {
      v.proxy.v = shown(value, v.kind);
      for (const b of v.bindings) b.refresh();
    } finally {
      this.refreshing = was;
    }
  }

  /** Every field back to its registered default: sim tables by setTuning commands, client tables at once. */
  private resetToDefaults(sim: boolean): void {
    const defaults = new Map<string, unknown>();
    for (const [id, v] of this.views) {
      if (v.sim !== sim || v.kind === 'readOnly') continue;
      let table = defaults.get(v.entry.name);
      if (table === undefined) defaults.set(v.entry.name, (table = JSON.parse(v.entry.defaults) as unknown));
      const d = defaultOf(table, v.entry.name, v.key);
      if (d === null) continue;
      if (Object.is(this.effective(id, v), d)) continue;
      if (sim) {
        if (!this.host.loop) return;
        this.host.loop.dev('setTuning', [], { table: v.entry.name, key: v.key, value: d });
        this.pending.set(id, { value: d, tick: this.host.world.tick + 1 });
      } else {
        writeClient(v.entry, v.key, d);
        clientEdited(this.host, v.entry.name, v.key, d);
      }
      this.syncBindings(v, d);
    }
  }

  // ---------------------------------------------------------------------------
  // Read-outs
  // ---------------------------------------------------------------------------

  private readouts(world: World): void {
    const ro = this.ro;
    const me = world.player;
    ro.player = `PLAYER\n${me ? playerLines(me, world) : '—'}`;
    const ent = this.inspected(world);
    ro.focus = `ENTITY (${this.inspect.entity > 0 ? 'inspected' : 'focus, or nearest'})\n${ent ? entityLines(ent, world) : '— none in reach'}`;
    const g = giantOf(world);
    ro.giant = `GIANT\n${g ? giantLines(g, world) : '— none'}`;
    ro.impacts = `LAST IMPACTS (newest first)\n${this.impacts.length ? this.impacts.join('\n') : '—'}`;
    ro.tripwires = `TRIPWIRES (newest first)\n${this.tripwires.length ? this.tripwires.join('\n') : '—'}`;
  }

  /** The entity typed in, else the one in focus (nearest the focused point), else the nearest within reach. */
  private inspected(world: World): Entity | null {
    if (this.inspect.entity > 0) return world.entities.get(Math.round(this.inspect.entity)) ?? null;
    const me = world.player;
    if (!me) return null;
    // TODO(P14): read the focused entity's id from the verb system once it keeps one; until then the nearest to
    // the focused point (f.verbAim), else to the player.
    const at: V3 = me.verbAim ?? me.pos;
    const held = me.inventory?.hands?.entity ?? null;
    let best: Entity | null = null;
    let bd = PANEL_TUNING.nearEntityM;
    for (const e of world.entities.all()) {
      if (e.id === held) continue;
      const d = Math.hypot(e.pose.p.x - at.x, e.pose.p.z - at.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private homeA(): { x: number; z: number } | null {
    return this.host.world.spawnData?.apeHomes[0]?.home ?? null;
  }

  /** Reads the world's events of the latest tick (until game.ts dispatches every event to handle()). */
  private scanEvents(world: World): void {
    if (world.tick === this.scannedTick) return;
    this.scannedTick = world.tick;
    for (const e of world.events) this.record(e, world.tick);
  }

  private record(e: SimEvent, tick: number): void {
    switch (e.type) {
      case 'impact':
        push(this.impacts, impactLine(e), PANEL_TUNING.impactsShown);
        return;
      case 'ko':
        if (e.environmental) push(this.impacts, `t${tick} KO ${who(e.victim)} — environmental [${e.credit.join(',') || 'nobody'}]`, PANEL_TUNING.impactsShown);
        return;
      case 'wound':
        push(
          this.impacts,
          `t${tick} WOUND ${who(e.ruler)} ${e.wound.zone}${e.wound.severe ? ' severe' : ''} ${fmt(e.wound.hp)} HP${e.byWorld ? ' (world)' : ''} [${e.wound.credit.join(',') || 'nobody'}]`,
          PANEL_TUNING.impactsShown,
        );
        return;
      case 'tripwire':
        push(this.tripwires, `t${tick} rope #${e.joint} by ${ownerName(e.by)}: ${fmt(e.loadN)} N${e.snapped ? ' SNAPPED' : ''}${e.loosed.length ? ` loosed ${e.loosed.join(',')}` : ''}`, PANEL_TUNING.tripwiresShown);
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Save / load
  // ---------------------------------------------------------------------------

  /**
   * Can the world write a save yet? save/serialize.ts throws until P13, and a `meta 'save'` would then throw inside
   * its tick, so the button waits for it. A dry run of what the command does at the end of its tick (a read).
   */
  private saveReady(): boolean {
    try {
      serializeWorld(this.host.world);
      return true;
    } catch {
      return false;
    }
  }

  private pickSave(): void {
    const load = this.host.loadWorld;
    if (!load || typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void file.arrayBuffer().then((buf) => load(new Uint8Array(buf)));
    };
    input.click();
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** The labels of the tools "give a tool" offers (§10.10); giveTool's argument is the tool's index in GIVE_TOOLS. */
const TOOL_LABELS: Record<GiveTool, string> = { stoneAxe: 'stone axe', diggingStick: 'digging stick', spear: 'spear', vine: 'vine (DEV_OPS_TUNING.vineM)' };

/** A Tweakpane on `container`, as the panel's root folder. */
function tweakpane(container: HTMLElement): PanelFolder {
  return adapt(new Pane({ title: 'Dev panel (L)', container }) as unknown as FolderApi);
}

function adapt(f: FolderApi): PanelFolder {
  return {
    addFolder: (p) => adapt(f.addFolder(p)),
    addBinding: (obj, key, params) => f.addBinding(obj, key, params) as unknown as PanelBinding,
    addButton: (p) => f.addButton(p),
    onFirstOpen: (handler) => {
      let done = false;
      f.on('fold', (ev) => {
        if (!ev.expanded || done) return;
        done = true;
        handler();
      });
    },
  };
}

/** A number as it is, to four significant digits. */
function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)));
}

function viewId(table: string, key: string): string {
  return `${table}:${key}`;
}

function leafLabel(label: string, unit: string): string {
  const u = unit.trim();
  return u === '' || u === '—' || u === '-' || label.includes(`(${u})`) ? label : `${label} (${u})`;
}

/** Every primitive inside a compound value, as path segments. */
function primitivesOf(v: unknown, path: string[]): string[][] {
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => primitivesOf(x, [...path, String(i)]));
  if (v !== null && typeof v === 'object') return Object.keys(v).flatMap((k) => primitivesOf((v as Record<string, unknown>)[k], [...path, k]));
  return [];
}

/** A primitive's current value in the registry (null for an empty compound or null). */
function readValue(table: string, key: string): TuningValue | null {
  return primitive(getTuningValue(table, key));
}

/** A view's current value, read straight from its table (refresh reads ~1,100 of them: no registry lookups). */
function readAt(v: LeafView): TuningValue | null {
  let h: unknown = v.entry.table;
  for (const seg of v.path) {
    if (h === null || typeof h !== 'object') return null;
    h = (h as Record<string, unknown>)[seg];
  }
  return primitive(h);
}

function primitive(v: unknown): TuningValue | null {
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : null;
}

/**
 * How a primitive is edited. Strings without options are shown, not edited (a typo in a material id inside a species'
 * parts would break the sim at its next use); numbers that aren't finite (an "off" lever at Infinity) are typed.
 */
function kindOf(value: TuningValue | null, meta: TuningLeaf['meta'], readOnly: boolean): LeafView['kind'] {
  if (readOnly || value === null) return 'readOnly';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return meta.options ? 'options' : 'readOnly';
  return Number.isFinite(value) ? 'number' : 'numberText';
}

/** What the proxy holds for a value. */
function shown(value: TuningValue | null, kind: LeafView['kind']): TuningValue {
  if (value === null) return kind === 'readOnly' ? '—' : 0;
  if (kind === 'numberText' || (kind === 'readOnly' && typeof value === 'number')) return String(value);
  return value;
}

/** A binding's new value as the table's type, or null (not a value: the binding goes back). */
function parsed(raw: unknown, kind: LeafView['kind']): TuningValue | null {
  switch (kind) {
    case 'number':
      return typeof raw === 'number' && !Number.isNaN(raw) ? raw : null;
    case 'numberText': {
      const t = String(raw).trim().toLowerCase();
      const n = t === 'inf' || t === 'infinity' || t === '+infinity' ? Infinity : t === '-inf' || t === '-infinity' ? -Infinity : Number(t);
      return t !== '' && !Number.isNaN(n) ? n : null;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    case 'options':
      return typeof raw === 'string' ? raw : null;
    default:
      return null;
  }
}

/** A client table's primitive, written in place (client tables never touch the sim: no command). */
function writeClient(entry: TuningEntry, key: string, value: TuningValue): void {
  const path = key.split('.');
  let holder: unknown = entry.table;
  for (let i = 0; i < path.length - 1; i++) holder = (holder as Record<string, unknown>)[path[i]];
  (holder as Record<string, unknown>)[path[path.length - 1]] = value;
}

/** Client edits that something running must hear of (the rest are read at use time). */
function clientEdited(host: PanelHost, table: string, key: string, value: TuningValue): void {
  if (table === 'GAME_TUNING' && key === 'volume' && typeof value === 'number') host.sfx.setVolume(value);
}

/** A primitive's registered default (from the table's parsed canonical defaults), or null. */
function defaultOf(defaults: unknown, table: string, key: string): TuningValue | null {
  let v = defaults;
  for (const seg of key.split('.')) {
    if (v === null || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[seg];
  }
  const cur = readValue(table, key);
  if (typeof v === 'string' && typeof cur === 'number') return v === '$inf' ? Infinity : v === '$-inf' ? -Infinity : v === '$nan' ? NaN : null;
  return typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : null;
}

function cm(xz: [number, number]): number[] {
  return xz.map((v) => Math.round(v * 100) + 0);
}

function push(list: string[], line: string, max: number): void {
  list.unshift(line);
  if (list.length > max) list.length = Math.max(0, max);
}

function fmt(n: number): string {
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function who(f: Fighter): string {
  return `${f.species ?? f.name}#${f.id}`;
}

function ownerName(o: { kind: string; id?: number }): string {
  return o.id !== undefined ? `${o.kind}#${o.id}` : o.kind;
}

function safe(fn: () => string): string {
  try {
    return fn();
  } catch {
    return '—';
  }
}

function impactLine(e: Extract<SimEvent, { type: 'impact' }>): string {
  const c = e.cause;
  const by = c.kind === 'entity' ? `entity #${c.entityId}` : c.kind === 'creature' ? `creature #${c.fighterId}` : c.kind;
  // Environmental: the world did it (an entity no one is holding, or the ground), as §2.13 reads `byWorld`.
  const env = (c.kind === 'entity' && !c.held) || c.kind === 'terrain';
  return `t${e.tick} ${who(e.defender)} ← ${by} (${c.feature}) ${fmt(e.energy)} J → ${fmt(e.damage)} HP${env ? ' env' : ''}${e.ko ? ' KO' : ''} [${c.credit.join(',') || 'nobody'}]`;
}

function giantOf(world: World): Fighter | null {
  return world.combat.fighters.find((f) => f.ruler !== null && f.alive) ?? world.combat.fighters.find((f) => f.ruler !== null) ?? null;
}

function playerLines(me: Fighter, world: World): string {
  const inv = me.inventory;
  const h = inv?.hands;
  const held = h ? world.entities.get(h.entity) : undefined;
  const hands = h ? `#${h.entity} ${held ? `${held.look || held.material} ${fmt(held.mass)} kg` : '?'} ${h.mode}${h.twoHanded ? ' 2H' : ''}` : 'empty';
  const slot = (id: number | null) => (id === null ? '·' : `#${id}`);
  const mi = me.motionInfo;
  return [
    `hp ${fmt(me.hp)}  stamina ${me.stamina.toFixed(2)}  ${me.state}`,
    `hands: ${hands}`,
    `belt: ${inv ? inv.belt.map(slot).join(' ') : '—'}  back: ${inv ? slot(inv.back) : '—'}`,
    `load: ${me.load ? `${fmt(me.load.massKg)} kg ${me.load.mode}` : '—'}`,
    `motion: ${mi.zone} ${mi.context} ${mi.speed.toFixed(2)} m/s`,
    `at ${me.pos.x.toFixed(1)}, ${me.pos.y.toFixed(1)}, ${me.pos.z.toFixed(1)}  tick ${world.tick}`,
  ].join('\n');
}

function entityLines(e: Entity, world: World): string {
  const sharp = e.sharpPoints.reduce((m, p) => Math.max(m, p.sharpness), 0);
  const cut = e.plant?.cut ? `trunk ${(1 - e.plant.cut.remaining).toFixed(2)} cut (${e.plant.cut.chops} chops) ${e.plant.phase}` : e.crossCut ? `cross-cut ${e.crossCut.remaining.toFixed(3)} m left` : '—';
  const loadAvg = e.loadHist.length ? e.loadHist.reduce((s, v) => s + v, 0) / e.loadHist.length : 0;
  const anchor = e.anchor ? `${e.anchor.depthM.toFixed(2)} m, holds ${fmt(e.anchor.capacityN)} N` : e.state;
  return [
    `#${e.id} ${e.look || e.material} (${e.material})`,
    `mass ${fmt(e.mass)} kg  integrity ${e.integrity.toFixed(2)}`,
    `sharpness ${sharp.toFixed(2)} (${e.sharpPoints.length} points)`,
    `anchor: ${anchor}`,
    `cut: ${cut}`,
    `load avg ${fmt(loadAvg)} N  joints ${e.joints.length ? e.joints.join(',') : '—'}`,
    `credit ${e.credit.join(',') || '—'}  tick ${world.tick}`,
  ].join('\n');
}

function giantLines(g: Fighter, world: World): string {
  const r = g.ruler!;
  const view = safe(() => {
    const v = world.minds.view(g);
    return `${v.state} awareness ${v.awareness.toFixed(2)}`;
  });
  const mind = world.minds.get(g);
  // TODO(P20): the charge cooldown's name in RulerMind (MindRecV1.cooldownUntil, a tick).
  const until = (mind as unknown as Partial<{ cooldownUntil: number }> | null)?.cooldownUntil;
  const cooldown = typeof until === 'number' ? `${Math.max(0, (until - world.tick) * DT).toFixed(1)} s` : '—';
  const path = mind ? pathLength(mind.path.points, mind.path.i, g.pos) : 0;
  const wounds = r.wounds.map((w) => `${w.zone}${w.severe ? '!' : ''} ${fmt(w.remaining)}/${fmt(w.hp)}`);
  return [
    `${who(g)} ${g.state}  hp ${safe(() => fmt(rulerHp(r)))} / ${fmt(r.maxHp)}`,
    `mind: ${view}${mind?.paused ? ' (paused)' : ''}`,
    `charge cooldown ${cooldown}  path ${path.toFixed(1)} m`,
    `in pit ${r.inPit ? 'yes' : 'no'}  pinned ${r.pinned ? `${fmt(r.pinnedKg)} kg` : 'no'}`,
    `wounds (${r.wounds.length}): ${wounds.join(', ') || '—'}`,
    `at ${g.pos.x.toFixed(1)}, ${g.pos.z.toFixed(1)}`,
  ].join('\n');
}

/** Metres left along a path from `from` through its corners from `i`. */
function pathLength(points: readonly V3[], i: number, from: V3): number {
  let len = 0;
  let prev = from;
  for (let k = Math.max(0, i); k < points.length; k++) {
    len += Math.hypot(points[k].x - prev.x, points[k].z - prev.z);
    prev = points[k];
  }
  return len;
}
