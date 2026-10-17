// The dev panel (docs/M1-DESIGN.md §10.10, P37): built from the tuning registry — a folder for every TUNING entry and a
// binding per field — with sim tables edited only through `meta 'dev' setTuning` commands applied at their tick (RR-17)
// and client tables at once. Driven through a fake Pane that behaves like Tweakpane where it matters: a change writes
// the bound object and fires 'change' (with `last` false while dragging), and refresh() re-reads the object and fires
// 'change' when the value moved.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Command,
  createWorld,
  defineTuning,
  getTuningValue,
  GIVE_TOOLS,
  type MetaCommand,
  restoreTuning,
  serializeWorld,
  setTuningValue,
  TUNING,
  tuningLeaves,
  tuningSnapshot,
  type World,
  type WorldEvent,
} from '@wild/sim';
import { buildPanel, DEV_OPS_READY, type DevPanel, PANEL_TUNING, type PanelBinding, type PanelButton, type PanelFolder, type PanelHost } from '../src/debug/panel';
import { FEEL_TUNING } from '../src/feel/audio';
import { GAME_TUNING } from '../src/game/game';
import { GameLoop, type LoopGame } from '../src/game/loop';
import type { InputFrame } from '../src/input/input';
// Every client table registers as its module loads (main.ts loads them all before the panel).
import '../src/game/killcam';
import '../src/game/presentationWorld';
import '../src/input/verbInput';
import '../src/render/followCam';
import '../src/render/terrainView';

type Change = { value: unknown; last: boolean };

class FakeBinding implements PanelBinding {
  readonly handlers: ((e: Change) => void)[] = [];
  refreshes = 0;
  private seen: unknown;
  constructor(
    readonly obj: Record<string, unknown>,
    readonly key: string,
    readonly params: Record<string, unknown>,
    readonly path: readonly string[],
  ) {
    this.seen = obj[key];
  }
  on(_ev: 'change', h: (e: Change) => void): this {
    this.handlers.push(h);
    return this;
  }
  /** Tweakpane: re-read the object; a value that moved is a change. */
  refresh(): void {
    this.refreshes++;
    const v = this.obj[this.key];
    if (Object.is(v, this.seen)) return;
    this.seen = v;
    for (const h of this.handlers) h({ value: v, last: true });
  }
  /** The user moves the control: the object is written, then the listeners hear it. */
  input(value: unknown, last = true): void {
    this.obj[this.key] = value;
    this.seen = value;
    for (const h of this.handlers) h({ value, last });
  }
  get value(): unknown {
    return this.obj[this.key];
  }
}

class FakeButton implements PanelButton {
  readonly handlers: (() => void)[] = [];
  constructor(
    readonly title: string,
    readonly disabled: boolean,
    readonly path: readonly string[],
  ) {}
  on(_ev: 'click', h: () => void): this {
    this.handlers.push(h);
    return this;
  }
  click(): void {
    if (this.disabled) return;
    for (const h of this.handlers) h();
  }
}

class FakePane implements PanelFolder {
  readonly folders: FakePane[] = [];
  readonly bindings: FakeBinding[] = [];
  readonly buttons: FakeButton[] = [];
  /** Like Tweakpane: folders report their first opening (the panel then fills them). */
  onFirstOpen?: (h: () => void) => void;
  private readonly opened: (() => void)[] = [];
  constructor(
    readonly path: readonly string[] = [],
    readonly all: { folders: FakePane[]; bindings: FakeBinding[]; buttons: FakeButton[] } = { folders: [], bindings: [], buttons: [] },
    readonly lazy = false,
  ) {
    if (lazy) this.onFirstOpen = (h) => void this.opened.push(h);
  }
  /** The user opens the folder. */
  open(): void {
    for (const h of this.opened.splice(0)) h();
  }
  addFolder(p: { title: string; expanded?: boolean }): FakePane {
    const f = new FakePane([...this.path, p.title], this.all, this.lazy);
    this.folders.push(f);
    this.all.folders.push(f);
    return f;
  }
  addBinding(obj: Record<string, unknown>, key: string, params: Record<string, unknown> = {}): FakeBinding {
    const b = new FakeBinding(obj, key, params, this.path);
    this.bindings.push(b);
    this.all.bindings.push(b);
    return b;
  }
  addButton(p: { title: string; disabled?: boolean }): FakeButton {
    const b = new FakeButton(p.title, !!p.disabled, this.path);
    this.buttons.push(b);
    this.all.buttons.push(b);
    return b;
  }
  folderAt(path: readonly string[]): FakePane | undefined {
    return this.all.folders.find((f) => f.path.length === path.length && f.path.every((s, i) => s === path[i]));
  }
  button(title: RegExp): FakeButton {
    const b = this.all.buttons.find((x) => title.test(x.title));
    if (!b) throw new Error(`no button ${title}`);
    return b;
  }
}

const frame: InputFrame = { moveX: 0, moveY: 0, presses: [], pickup: false, keys: [] };

/** A presenter that does nothing: the loop only needs to step the world. */
const quietGame: LoopGame = {
  verbInput: { commands: () => [], mode: 'idle' },
  presentation: { step() {} },
  menuOpen: false,
  beginFrame() {},
  metaKey() {},
  present() {},
  freezeFrame() {},
  render() {},
  onSave() {},
};

let world: World;
let loop: GameLoop;
let pushed: Command[];
let snapshot: string;

beforeAll(async () => {
  world = await createWorld({ seed: 7, scene: 'empty', nav: 'off' });
  loop = new GameLoop(world, quietGame, { poll: () => frame }, { active: false, timeScale: 1, update() {} });
  // Watch what reaches the sim's command queue.
  const push = world.commands.push.bind(world.commands);
  world.commands.push = (c: Command) => {
    pushed.push(c);
    push(c);
  };
  snapshot = tuningSnapshot();
});

afterAll(() => world.dispose());

afterEach(() => restoreTuning(snapshot));

function setup(over: Partial<PanelHost> = {}) {
  pushed = [];
  const pane = new FakePane();
  let t = 0;
  const volume = vi.fn();
  const host: PanelHost = { world, loop, sfx: { setVolume: volume }, onRebuild: null, ...over };
  // Every refresh() is past the throttle (a fake clock a second further on each call).
  const panel: DevPanel = buildPanel(host, { pane, now: () => (t += 1000) });
  return { pane, panel, volume };
}

const setTunings = () => pushed.filter((c): c is MetaCommand => c.kind === 'meta' && c.meta === 'dev' && c.dev?.op === 'setTuning');

/** The single binding of a field that sits in its table's folder. */
function bindingOf(panel: DevPanel, table: string, key: string): FakeBinding {
  const path = panel.folderPathOf(table)!;
  const b = (panel.bindingsOf(table, key) as FakeBinding[]).find((x) => path.every((s, i) => x.path[i] === s));
  if (!b) throw new Error(`no binding for ${table}.${key}`);
  return b;
}

describe('dev panel: built from the registry', () => {
  it('builds a folder for every TUNING entry, named as registered, and a binding per field with its unit and range', () => {
    const { pane, panel } = setup();
    const names = TUNING.map((e) => e.name);
    // The sim's tables and every client table (FEEL_TUNING and the panel's own included).
    for (const n of ['DAMAGE_TUNING', 'MATERIALS', 'SPECIES_BODY', 'ENTITY_TUNING', 'CREATURE_TUNING', 'GAME_TUNING', 'LOOP_TUNING', 'FEEL_TUNING', 'PANEL_TUNING', 'KILLCAM_TUNING', 'RENDER_TUNING']) {
      expect(names).toContain(n);
    }
    let leaves = 0;
    for (const e of TUNING) {
      // The folder as registered ("Physics › entities", "Client › feel"…) is a top-level folder of the pane.
      expect(pane.folders.map((f) => f.path[0]), e.folder).toContain(e.folder);
      const path = panel.folderPathOf(e.name);
      expect(path, e.name).not.toBeNull();
      const shares = TUNING.filter((x) => x.folder === e.folder).length > 1;
      expect(path).toEqual(shares ? [e.folder, e.name] : [e.folder]);
      expect(pane.folderAt(path!), e.name).toBeDefined();
      const keys = panel.boundKeys(e.name);
      for (const leaf of tuningLeaves(e)) {
        leaves++;
        const mine = keys.filter((k) => k === leaf.key || k.startsWith(`${leaf.key}.`));
        expect(mine.length, `${e.name}.${leaf.key}`).toBeGreaterThan(0);
        for (const k of mine) {
          const bs = panel.bindingsOf(e.name, k) as FakeBinding[];
          // Bound inside the table's folder (sub-folders for nested tables and compound values), never the table itself.
          const inFolder = bs.filter((b) => path!.every((s, i) => b.path[i] === s));
          expect(inFolder.length, `${e.name}.${k}`).toBeGreaterThan(0);
          for (const b of bs) {
            expect(b.obj).not.toBe(e.table);
            expect(typeof b.params.label).toBe('string');
            const u = leaf.meta.unit;
            if (u !== '—' && u !== '-' && u !== '') expect(b.params.label as string, `${e.name}.${k}`).toContain(u);
          }
          const value = getTuningValue(e.name, k);
          if (k === leaf.key && typeof value === 'number' && Number.isFinite(value) && !leaf.readOnly) {
            const p = inFolder[0].params;
            expect(p.min).toBe(leaf.meta.min);
            expect(p.max).toBe(leaf.meta.max);
            expect(p.step).toBe(leaf.meta.step);
            expect(p.readonly).toBeUndefined();
          }
          if (leaf.readOnly) for (const b of bs) expect(b.params.readonly).toBe(true);
        }
      }
    }
    expect(leaves).toBeGreaterThan(800);
    // Nested tables are sub-folders (a material row, a species block, a mind's block).
    expect(pane.folderAt(['Materials', 'greenWood'])).toBeDefined();
    expect(pane.folderAt(['Creatures › minds', 'giant'])).toBeDefined();
    expect(pane.folderAt(['Client › feel', 'jungle'])).toBeDefined();
    // Read-outs are getter-only fields: shown, not edited.
    expect((panel.bindingsOf('BODY_MASS_TUNING', 'zoneShare.head') as FakeBinding[])[0].params.readonly).toBe(true);
    // A compound value gets one binding per primitive (a [min, max] range, a material's strength).
    expect(panel.boundKeys('CLEARING_TUNING')).toEqual(expect.arrayContaining(['groveDistM.0', 'groveDistM.1']));
    expect(panel.boundKeys('MATERIALS')).toContain('greenWood.strength.solidJPerKg');
    // An option field is a list of its options; a value at Infinity (an "off" lever) is typed.
    expect(bindingOf(panel, 'TERRAIN_TUNING', 'material').params.options).toMatchObject({ dirt: 'dirt', stone: 'stone' });
    expect(bindingOf(panel, 'IMPACT_TUNING', 'unbackedTargetMassRatio').value).toBe('Infinity');
  });

  it("makes a table's bindings when its folder first opens (Tweakpane's fold event), not at boot", () => {
    pushed = [];
    const pane = new FakePane([], undefined, true);
    const panel = buildPanel({ world, loop, sfx: { setVolume() {} }, onRebuild: null }, { pane, now: () => 0 });
    expect(panel.boundKeys('DAMAGE_TUNING')).toEqual([]);
    expect(panel.boundKeys('SPECIES_BODY')).toEqual([]);
    // The quick bindings in "Dev" exist at once.
    expect(panel.bindingsOf('GAME_TUNING', 'timeScale')).toHaveLength(1);
    pane.folderAt(['Damage rule'])!.open();
    expect(panel.boundKeys('DAMAGE_TUNING').sort()).toEqual(tuningLeaves(TUNING.find((e) => e.name === 'DAMAGE_TUNING')!).map((l) => l.key).sort());
    pane.folderAt(['Damage rule'])!.open(); // once
    expect(panel.bindingsOf('DAMAGE_TUNING', 'K')).toHaveLength(1);
    // A shared folder's tables fill when their own sub-folder opens.
    pane.folderAt(['Creatures › bodies'])!.open();
    expect(panel.boundKeys('SPECIES_BODY')).toEqual([]);
    pane.folderAt(['Creatures › bodies', 'SPECIES_BODY'])!.open();
    expect(panel.boundKeys('SPECIES_BODY').length).toBeGreaterThan(20);
    pane.folderAt(['Client › game'])!.open();
    expect(panel.bindingsOf('GAME_TUNING', 'timeScale')).toHaveLength(2);
  });

  it('builds the folders of a table registered after it, on the next refresh', () => {
    const { pane, panel } = setup();
    defineTuning('P37_LATE_TUNING', 'Client › late', { gain: 1 }, { gain: { unit: '×', source: 'test', min: 0, max: 2, step: 0.1 } });
    expect(panel.folderPathOf('P37_LATE_TUNING')).toBeNull();
    panel.refresh(world);
    expect(panel.folderPathOf('P37_LATE_TUNING')).toEqual(['Client › late']);
    expect(pane.folderAt(['Client › late'])).toBeDefined();
    expect(panel.bindingsOf('P37_LATE_TUNING', 'gain')).toHaveLength(1);
  });

  it("keeps DS's dev controls, routed through the loop; every dev op is an enabled button", () => {
    const step = vi.spyOn(loop, 'requestStep');
    const rebuild = vi.fn();
    const { pane, panel } = setup({ onRebuild: rebuild });
    pane.button(/^Step frame/).click();
    expect(step).toHaveBeenCalledTimes(1);
    pane.button(/^Restart/).click();
    expect(rebuild).toHaveBeenCalledTimes(1);
    // Time scale, pause and the view toggles are quick bindings in "Dev", sharing GAME_TUNING's fields.
    for (const key of ['timeScale', 'paused', 'showHitboxes', 'showNav', 'showSenses', 'showZones']) {
      const bs = panel.bindingsOf('GAME_TUNING', key) as FakeBinding[];
      expect(bs.map((b) => b.path[0]), key).toEqual(['Dev', 'Client › game']);
    }
    // Every dev op is a button, enabled now that world/devOps.ts applies every op (P22).
    const ops = pane.folderAt(['Dev', 'Dev ops (commands)'])!;
    expect(ops.buttons.length).toBeGreaterThanOrEqual(12);
    for (const b of ops.buttons) expect(b.disabled, b.title).toBe(false);
    for (const op of ['spawnApe', 'spawnGiant', 'giveTool', 'teleport', 'pauseMinds', 'killCreature', 'respawnPlayer', 'setTuning'] as const) {
      expect(DEV_OPS_READY.has(op), op).toBe(true);
    }
    // "Save world" waits for the save writer (P13): a `meta 'save'` would throw inside its tick until then.
    let saves = true;
    try {
      serializeWorld(world);
    } catch {
      saves = false;
    }
    expect(pane.button(/^Save world/).disabled).toBe(!saves);
    expect(pane.button(/^Load world/).disabled).toBe(true);
    expect(pushed).toEqual([]);
    step.mockRestore();
  });
});

describe('dev panel: dev ops', () => {
  it("sends each dev op as one meta 'dev' command in world/devOps.ts's encoding (points in whole cm)", () => {
    const { pane } = setup();
    const devs = (): NonNullable<MetaCommand['dev']>[] =>
      pushed.filter((c): c is MetaCommand => c.kind === 'meta' && c.meta === 'dev').map((c) => c.dev!);
    const click = (title: RegExp): NonNullable<MetaCommand['dev']>[] => {
      pushed.length = 0;
      pane.button(title).click();
      return devs();
    };
    const p = world.player!;
    const d = PANEL_TUNING.spawnApeAheadM;
    expect(click(/^Spawn an ape near/)).toEqual([
      { op: 'spawnApe', args: [Math.round((p.pos.x + Math.sin(p.yaw) * d) * 100) + 0, Math.round((p.pos.z + Math.cos(p.yaw) * d) * 100) + 0] },
    ]);
    expect(click(/^Spawn the giant/)).toEqual([{ op: 'spawnGiant', args: [] }]);
    GIVE_TOOLS.forEach((_t, i) => expect(click(new RegExp(`^Give: ${['stone axe', 'digging stick', 'spear', 'vine'][i]}`))).toEqual([{ op: 'giveTool', args: [i] }]));
    expect(click(/^Teleport: spawn/)).toEqual([{ op: 'teleport', args: [0, 0] }]);
    expect(click(/^Pause minds/)).toEqual([{ op: 'pauseMinds', args: [1] }]);
    expect(click(/^Resume minds/)).toEqual([{ op: 'pauseMinds', args: [0] }]);
    expect(click(/^Respawn/)).toEqual([{ op: 'respawnPlayer', args: [] }]);
    // Nothing to aim at in the empty scene (no home A, no giant, no target): no command.
    expect(click(/^Teleport: home A/)).toEqual([]);
    expect(click(/^Teleport: the giant/)).toEqual([]);
    expect(click(/^Kill the target/)).toEqual([]);
    for (const c of pushed) expect(c.tick).toBe(world.tick + 1);
    // The shared world never runs them (the other tests read it as built).
    world.commands.discard(1, 'meta');
  });
});

describe('dev panel: edits', () => {
  it("sends an edit to a sim table as exactly one meta 'dev' setTuning command, and changes nothing until its tick", () => {
    const { panel } = setup();
    const before = getTuningValue('DAMAGE_TUNING', 'K') as number;
    const b = bindingOf(panel, 'DAMAGE_TUNING', 'K');
    // A drag: intermediate values send nothing; the last one is the edit.
    b.input(before + 1, false);
    b.input(before + 2, false);
    expect(setTunings()).toEqual([]);
    b.input(before + 3, true);
    const tick = world.tick;
    expect(setTunings()).toEqual([
      { tick: tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'setTuning', args: [], tuning: { table: 'DAMAGE_TUNING', key: 'K', value: before + 3 } } },
    ]);
    expect(pushed).toHaveLength(1);
    // Nothing changes until the command's tick runs; meanwhile the panel shows the pending value.
    expect(getTuningValue('DAMAGE_TUNING', 'K')).toBe(before);
    expect(panel.pendingEdits).toBe(1);
    panel.refresh(world);
    expect(b.value).toBe(before + 3);
    expect(getTuningValue('DAMAGE_TUNING', 'K')).toBe(before);
    loop.advance(1);
    expect(world.tick).toBe(tick + 1);
    expect(getTuningValue('DAMAGE_TUNING', 'K')).toBe(before + 3);
    panel.refresh(world);
    expect(panel.pendingEdits).toBe(0);
    expect(b.value).toBe(before + 3);
    // Refreshing (which fires Tweakpane's change events) never sends another command.
    expect(pushed).toHaveLength(1);
  });

  it('sends nested, compound, boolean and option edits with their dotted keys and types', () => {
    const { panel } = setup();
    bindingOf(panel, 'CREATURE_TUNING', 'giant.chargeCooldownS').input(7);
    bindingOf(panel, 'CLEARING_TUNING', 'groveDistM.1').input(70);
    bindingOf(panel, 'MATERIALS', 'greenWood.strength.solidJPerKg').input(45);
    bindingOf(panel, 'TERRAIN_TUNING', 'material').input('stone');
    bindingOf(panel, 'IMPACT_TUNING', 'unbackedTargetMassRatio').input('12.5');
    expect(setTunings().map((c) => c.dev!.tuning)).toEqual([
      { table: 'CREATURE_TUNING', key: 'giant.chargeCooldownS', value: 7 },
      { table: 'CLEARING_TUNING', key: 'groveDistM.1', value: 70 },
      { table: 'MATERIALS', key: 'greenWood.strength.solidJPerKg', value: 45 },
      { table: 'TERRAIN_TUNING', key: 'material', value: 'stone' },
      { table: 'IMPACT_TUNING', key: 'unbackedTargetMassRatio', value: 12.5 },
    ]);
    // Every one applies cleanly at its tick (setTuningValue would throw on a wrong type, inside the tick).
    loop.advance(1);
    expect(getTuningValue('CREATURE_TUNING', 'giant.chargeCooldownS')).toBe(7);
    expect(getTuningValue('CLEARING_TUNING', 'groveDistM.1')).toBe(70);
    expect(getTuningValue('MATERIALS', 'greenWood.strength.solidJPerKg')).toBe(45);
    expect(getTuningValue('TERRAIN_TUNING', 'material')).toBe('stone');
    expect(getTuningValue('IMPACT_TUNING', 'unbackedTargetMassRatio')).toBe(12.5);
  });

  it('puts a binding back, sending nothing, when its value is not a value', () => {
    const { panel } = setup();
    const b = bindingOf(panel, 'IMPACT_TUNING', 'unbackedTargetMassRatio');
    b.input('lots');
    expect(pushed).toEqual([]);
    expect(b.value).toBe('Infinity');
    // Setting a field back to the value it has sends nothing either.
    bindingOf(panel, 'DAMAGE_TUNING', 'K').input(getTuningValue('DAMAGE_TUNING', 'K'));
    expect(pushed).toEqual([]);
  });

  it('changes a client table at once, with no command', () => {
    const { panel, volume } = setup();
    const b = bindingOf(panel, 'GAME_TUNING', 'hitstopMul');
    b.input(2.5, false); // client tables follow a drag live
    expect(GAME_TUNING.hitstopMul).toBe(2.5);
    bindingOf(panel, 'FEEL_TUNING', 'jungle.birdsPerS').input(1.2);
    expect(FEEL_TUNING.jungle.birdsPerS).toBe(1.2);
    bindingOf(panel, 'GAME_TUNING', 'volume').input(0.3);
    expect(GAME_TUNING.volume).toBe(0.3);
    expect(volume).toHaveBeenCalledWith(0.3);
    // The quick binding in "Dev" and the one in "Client › game" are one field.
    const [quick, inTable] = panel.bindingsOf('GAME_TUNING', 'showHitboxes') as FakeBinding[];
    quick.input(true);
    expect(GAME_TUNING.showHitboxes).toBe(true);
    expect(inTable.value).toBe(true);
    expect(pushed).toEqual([]);
  });

  it('follows values changed elsewhere (the H key, a replayed command) without sending anything', () => {
    const { panel } = setup();
    const hit = bindingOf(panel, 'GAME_TUNING', 'showHitboxes');
    const k = bindingOf(panel, 'DAMAGE_TUNING', 'K');
    GAME_TUNING.showHitboxes = !GAME_TUNING.showHitboxes;
    setTuningValue('DAMAGE_TUNING', 'K', (getTuningValue('DAMAGE_TUNING', 'K') as number) + 5);
    panel.refresh(world);
    expect(hit.value).toBe(GAME_TUNING.showHitboxes);
    expect(k.value).toBe(getTuningValue('DAMAGE_TUNING', 'K'));
    expect(hit.refreshes).toBeGreaterThan(0);
    expect(pushed).toEqual([]);
  });

  it('resets sim tuning by setTuning commands and client tuning at once', () => {
    const { pane, panel } = setup();
    const k = getTuningValue('DAMAGE_TUNING', 'K') as number;
    setTuningValue('DAMAGE_TUNING', 'K', k * 2);
    setTuningValue('CLEARING_TUNING', 'groveDistM.0', 31);
    GAME_TUNING.hitstopMul = 2;
    panel.refresh(world);
    pane.button(/^Reset sim tuning/).click();
    expect(
      setTunings()
        .map((c) => c.dev!.tuning)
        .sort((a, b) => a!.table.localeCompare(b!.table)),
    ).toEqual([
      { table: 'CLEARING_TUNING', key: 'groveDistM.0', value: 30 },
      { table: 'DAMAGE_TUNING', key: 'K', value: k },
    ]);
    expect(getTuningValue('DAMAGE_TUNING', 'K')).toBe(k * 2); // until its tick
    expect(GAME_TUNING.hitstopMul).toBe(2);
    pane.button(/^Reset client tuning/).click();
    expect(GAME_TUNING.hitstopMul).toBe(1);
    expect(setTunings()).toHaveLength(2);
    loop.advance(1);
    expect(getTuningValue('DAMAGE_TUNING', 'K')).toBe(k);
  });
});

describe('dev panel: read-outs', () => {
  it('reads out the player, and the last impacts and tripwires with cause, credit, HP and environmental', () => {
    const { pane, panel } = setup();
    const ro = pane.folderAt(['Read-outs (live)'])!;
    const text = (key: string) => String(ro.bindings.find((b) => b.key === key)!.value);
    const player = world.player!;
    const impact = {
      type: 'impact',
      tick: world.tick,
      defender: player,
      energy: 230,
      damage: 12.34,
      ko: false,
      cause: { kind: 'entity', entityId: 17, fighterId: null, credit: ['p1'], held: false, feature: 'falling' },
    } as unknown as WorldEvent;
    panel.handle(impact, world);
    panel.handle({ type: 'tripwire', joint: 4, by: { kind: 'fighter', id: 9, part: 'kcc' }, loadN: 812, snapped: true, loosed: [21], point: { x: 0, y: 0.3, z: 0 } } as WorldEvent, world);
    panel.refresh(world);
    expect(text('impacts')).toMatch(/entity #17 \(falling\) 230 J → 12\.3 HP env \[p1\]/);
    expect(text('tripwires')).toMatch(/rope #4 by fighter#9: 812 N SNAPPED loosed 21/);
    expect(text('player')).toMatch(/^PLAYER\nhp \d/);
    expect(text('player')).toMatch(/hands: empty/);
    expect(text('giant')).toMatch(/^GIANT\n— none/);
    // Only the last PANEL_TUNING.impactsShown impacts stay.
    for (let i = 0; i < PANEL_TUNING.impactsShown + 5; i++) panel.handle(impact, world);
    panel.refresh(world);
    expect(text('impacts').split('\n')).toHaveLength(PANEL_TUNING.impactsShown + 1);
  });

  it("reads the last tick's world events itself until the game hands it every event", () => {
    const { pane, panel } = setup();
    const ro = pane.folderAt(['Read-outs (live)'])!;
    loop.advance(1);
    world.events.push({ type: 'tripwire', joint: 2, by: { kind: 'terrain' }, loadN: 50, snapped: false, loosed: [], point: { x: 0, y: 0.3, z: 0 } } as WorldEvent);
    panel.refresh(world);
    panel.refresh(world); // the same tick is read once
    const trip = String(ro.bindings.find((b) => b.key === 'tripwires')!.value);
    expect(trip.split('\n')).toHaveLength(2);
    expect(trip).toMatch(/rope #2 by terrain: 50\.0 N/);
  });

  it('toggles visibility (the L key)', () => {
    const { panel } = setup();
    expect(panel.visible).toBe(false);
    panel.toggle();
    expect(panel.visible).toBe(true);
    panel.toggle();
    expect(panel.visible).toBe(false);
  });
});
