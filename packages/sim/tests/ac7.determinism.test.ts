// AC-7: determinism (SPEC:904; docs/M1-DESIGN.md §11.7, §8.2, package P30).
//
// "The same seed and the same command log, run twice, give byte-identical saves and bit-identical body states every
// 60 ticks (rule 7)."
//
// The scene: `scene 'clearing'` from seed S = 20261017 with nav on (terrain, the player, three apes and the giant at
// their homes, every generated entity), populated by the spawner as the game does.
//
// The command log is data: tests/fixtures/ac7-script.json, a fixed list of tick-tagged commands authored against the
// Clearing of seed S (its entity ids and poses are known because generation is deterministic). The test first checks
// every id the script names: a generated one has the expected look and is within 1 cm of the expected pose before the
// first tick; one the script itself makes (the spear, the axe, a vine) is checked the same way at the tick it is first
// named. A generation change therefore fails with a clear message instead of turning the script into a silent no-op.
//
// What the log does (in order; 4,209 ticks): move and button noise from its own Rng(99); a `setTuning` of
// MOVE_TUNING.sprintMul and a sprint under it, then the edit undone by a second `setTuning`; take the starter cache's
// vine coil and stow it on the belt; take the digging stick and dig (6 strikes); drop it; take a flint and shape a dry
// stick's end to a point (three strokes, then `charge: 0`); drop the flint; take the stake and place it upright,
// driven, beside the 121 kg dry log; lash the log to the stake (rope from the belt); bend a sapling to the stake;
// take a stone and throw it; `giveTool` a spear and throw it; `giveTool` a stone axe; `teleport` to a 21 cm tree and
// chop it to a third (cut); stow the axe on the back; `giveTool` a 12 m vine, tie it to the notched tree, walk away
// paying it out, and pull: the tree falls (fell); drop the rope end; `teleport` to tree 33's hanging vine, draw the
// axe and cut the vine; `spawnApe` beside the player and strike at it (it fights back); `spawnGiant` 19 m away (it
// investigates, chases, telegraphs and charges); `pauseMinds` on and off; `killCreature` the ape; `respawnPlayer`; more noise;
// a `meta 'save'` at tick 1,800. Every command in the file came out of the recorder below (AC7_RECORD=1), which drives
// the P23 harness's helpers (walk, approach, chopTo, pull, verb) on a live world and writes down every command they
// push; the harness's `standAt` (a direct World.teleport, not a command) is replaced there by the `teleport` dev op, so
// nothing reaches the recorded world except through the command queue.
//
// Runs (§11.7): world C (seed 6) first, fed the first CONFIG.warmTicks of the log, and discarded (it catches
// module-level state that a plain "run twice" misses); then A and B from seed S one after the other; then W1 and W2 from
// seed S interleaved tick by tick. Every 60 ticks, A = B and W1 = W2 are checked on serializeWorld (byte-identical) and
// bodyStateBytes (bit-identical); a difference names the first differing tick, the save's first differing section (its
// top-level key, the record and the field) and the body bytes' block (entity, fighter body, rope sensor, fighter core,
// combat RNG) and field. The event digests (every world and combat event, Fighter references as ids) must also match,
// tick for tick.
//
// Live tuning (§8.1): the tuning registry is per process, and a world applies a `setTuning` to it at its own tick. Two
// interleaved worlds share one registry, so each world gets its own view of the keys the log edits (swapped in before
// it steps), as two processes would have; the sequential runs reset the registry before each run.
//
// GATE / PIN marks as §11 asks. Every world is disposed (RF-24).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bodyStateBytes } from '../src/save/bodyState';
import { serializeWorld } from '../src/save/serialize';
import type { CombatEvent } from '../src/sim/combat';
import { aimOf, type Command, cloneCommand, COMMAND_STEPS, type DevOp, MOVE_SPRINT, moveCommand, toCm, type TuningEdit } from '../src/sim/commands';
import { Fighter, LEGACY_IDS } from '../src/sim/fighter';
import { Rng } from '../src/sim/math';
import { getTuningValue, resetTuning, setTuningValue, type TuningValue } from '../src/tuning/registry';
import type { CreatureMind } from '../src/world/creatures/mind';
import type { WorldEvent } from '../src/world/types';
import { createWorld, type World } from '../src/world/world';
import { BACK_SLOT, makeHarness, type VerbPayload } from './support/worldHarness';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(here, 'fixtures', 'ac7-script.json');

/** §11.7's numbers (test constants, never tuning). */
const CONFIG = {
  seed: 20261017,
  /** World C's seed, and how much of the log it is fed before it is discarded. */
  warmSeed: 6,
  warmTicks: 1200,
  /** Checkpoint period (ticks). */
  every: 60,
  /** The tick of the script's `meta 'save'`. */
  saveTick: 1800,
  /** Yield to the event loop this often (ticks), so Vitest's worker RPC (60 s) never times out. */
  yieldTicks: 200,
  /** An id the script names must be within this of its expected position (m). */
  poseTolM: 0.01,
} as const;

// ---------------------------------------------------------------------------
// The script file
// ---------------------------------------------------------------------------

/** An id the script names, as it was when the recorder first named it. */
interface EntityRef {
  id: number;
  /** The tick whose commands first name it (0: it is generated, checked before the first tick). */
  tick: number;
  look: string;
  p: [number, number, number];
}

interface FighterRef {
  id: number;
  tick: number;
  species: string | null;
}

interface Ac7Script {
  format: 'rotw-ac7-script';
  seed: number;
  /** The last tick the log covers (the runs step exactly this many ticks). */
  ticks: number;
  /** What the recorder's helpers did, in order (documentation: "t<tick> what"). */
  notes: string[];
  entities: EntityRef[];
  fighters: FighterRef[];
  commands: Command[];
}

function readScript(): Ac7Script {
  const s = JSON.parse(readFileSync(SCRIPT_PATH, 'utf8')) as Ac7Script;
  if (s.format !== 'rotw-ac7-script') throw new Error(`${SCRIPT_PATH}: not an AC-7 script`);
  return s;
}

/** One command per line, so a diff of the fixture reads command by command. */
function writeScript(s: Ac7Script): void {
  const lines = (xs: unknown[]): string => xs.map((x) => `    ${JSON.stringify(x)}`).join(',\n');
  const text = [
    '{',
    `  "format": ${JSON.stringify(s.format)},`,
    `  "seed": ${s.seed},`,
    `  "ticks": ${s.ticks},`,
    `  "notes": [\n${lines(s.notes)}\n  ],`,
    `  "entities": [\n${lines(s.entities)}\n  ],`,
    `  "fighters": [\n${lines(s.fighters)}\n  ],`,
    `  "commands": [\n${lines(s.commands)}\n  ]`,
    '}',
    '',
  ].join('\n');
  writeFileSync(SCRIPT_PATH, text);
}

// ---------------------------------------------------------------------------
// Running a world on the log
// ---------------------------------------------------------------------------

const yieldToVitest = (): Promise<void> => new Promise((r) => setImmediate(r));
const tuningKey = (t: TuningEdit): string => `${t.table}\u0000${t.key}`;

/** The keys the log's setTuning commands edit, with their registered defaults. */
function editedKeys(cmds: readonly Command[]): Map<string, { table: string; key: string; dflt: TuningValue }> {
  const out = new Map<string, { table: string; key: string; dflt: TuningValue }>();
  resetTuning();
  for (const c of cmds) {
    if (c.kind !== 'meta' || c.dev?.op !== 'setTuning' || !c.dev.tuning) continue;
    const t = c.dev.tuning;
    if (!out.has(tuningKey(t))) out.set(tuningKey(t), { table: t.table, key: t.key, dflt: getTuningValue(t.table, t.key) as TuningValue });
  }
  return out;
}

/** What one run saw, for the coverage gates. */
interface Coverage {
  verbsOk: Map<string, number>;
  verbsRefused: Map<string, number>;
  worldEvents: Map<string, number>;
  jointWhat: Map<string, number>;
  impactsWithDamage: number;
  playerHits: number;
  /** Every mind state each creature was in, in order of first entry (fighter id → states). */
  mindStates: Map<number, string[]>;
  /** Checkpoint saves that held a tuning override (setTuning is in the world's state). */
  savesWithOverrides: number;
  /** The `meta 'save'` output (StepResult.save) and the tick it came at. */
  metaSave: { tick: number; bytes: Uint8Array } | null;
  navVersionsStart: string;
  navVersionsEnd: string;
}

interface Checkpoint {
  tick: number;
  save: Uint8Array;
  body: Uint8Array;
  /** The event digest through this tick. */
  events: number;
}

/** One world fed the log: push the commands of the next tick, step, observe. */
class Runner {
  readonly cov: Coverage;
  readonly checkpoints: Checkpoint[] = [];
  /** This world's view of the tuning keys the log edits (key → value; absent: the default). */
  readonly tuning = new Map<string, TuningValue>();
  private next = 0;
  private digest = 0x811c9dc5;
  private lastStates = new Map<number, string>();

  constructor(
    readonly name: string,
    readonly w: World,
    private readonly script: Ac7Script,
    private readonly keys: Map<string, { table: string; key: string; dflt: TuningValue }>,
    private readonly checkRefs: boolean,
  ) {
    this.cov = {
      verbsOk: new Map(),
      verbsRefused: new Map(),
      worldEvents: new Map(),
      jointWhat: new Map(),
      impactsWithDamage: 0,
      playerHits: 0,
      mindStates: new Map(),
      savesWithOverrides: 0,
      metaSave: null,
      navVersionsStart: navVersions(w),
      navVersionsEnd: '',
    };
    if (checkRefs) for (const r of script.entities) if (r.tick === 0) checkEntityRef(w, r, name);
    this.noteMinds();
  }

  /** Puts this world's view of the edited keys into the process's registry (a no-op when it is there already). */
  swapIn(): void {
    for (const [k, t] of this.keys) {
      const v = this.tuning.has(k) ? this.tuning.get(k)! : t.dflt;
      if (getTuningValue(t.table, t.key) !== v) setTuningValue(t.table, t.key, v);
    }
  }

  step(): void {
    const w = this.w;
    const tick = w.tick + 1;
    const cmds = this.script.commands;
    if (this.next < cmds.length && cmds[this.next].tick < tick) throw new Error(`${this.name}: command ${this.next} is for tick ${cmds[this.next].tick}, already past`);
    if (this.checkRefs) {
      for (const r of this.script.entities) if (r.tick === tick) checkEntityRef(w, r, this.name);
      for (const r of this.script.fighters) if (r.tick === tick) checkFighterRef(w, r, this.name);
    }
    while (this.next < cmds.length && cmds[this.next].tick === tick) w.commands.push(cloneCommand(cmds[this.next++]));
    const r = w.step();
    // This world's tuning view after its tick (a setTuning lands in phase 1c).
    for (const [k, t] of this.keys) this.tuning.set(k, getTuningValue(t.table, t.key) as TuningValue);
    this.observe(r.world, r.combat);
    if (r.save) {
      if (this.cov.metaSave) throw new Error(`${this.name}: a second meta save at tick ${w.tick}`);
      this.cov.metaSave = { tick: w.tick, bytes: r.save.slice() };
    }
    if (w.tick % CONFIG.every === 0) {
      const save = serializeWorld(w);
      if (hasOverrides(save)) this.cov.savesWithOverrides++;
      this.checkpoints.push({ tick: w.tick, save, body: bodyStateBytes(w), events: this.digest });
    }
  }

  finish(): void {
    this.cov.navVersionsEnd = navVersions(this.w);
  }

  private observe(world: readonly WorldEvent[], combat: readonly CombatEvent[]): void {
    const c = this.cov;
    const player = this.w.player;
    for (const e of world) {
      inc(c.worldEvents, e.type);
      if (e.type === 'verb' && e.f === player) inc(e.ok ? c.verbsOk : c.verbsRefused, e.ok ? e.verb : `${e.verb}:${e.reason ?? '?'}`);
      if (e.type === 'joint') inc(c.jointWhat, e.what);
      if (e.type === 'impact' && e.damage > 0) c.impactsWithDamage++;
    }
    for (const e of combat) if (e.type === 'hit' && e.attacker === player) c.playerHits++;
    this.digest = fnv(this.digest, `${this.w.tick}|${eventsJson(world)}|${eventsJson(combat)}`);
    this.noteMinds();
  }

  private noteMinds(): void {
    for (const f of this.w.combat.fighters) {
      const m = this.w.minds.get(f) as CreatureMind | undefined;
      if (!m) continue;
      const s = (m as unknown as { state: string }).state;
      if (this.lastStates.get(f.id) === s) continue;
      this.lastStates.set(f.id, s);
      let l = this.cov.mindStates.get(f.id);
      if (!l) this.cov.mindStates.set(f.id, (l = []));
      l.push(s);
    }
  }
}

const inc = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Events as JSON, every Fighter as its id (events hold live Fighter objects). */
function eventsJson(es: readonly unknown[]): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(es, (_k, v: unknown) => {
    if (v instanceof Fighter) return `F${v.id}`;
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[seen]';
      seen.add(v);
    }
    return v;
  });
}

function hasOverrides(save: Uint8Array): boolean {
  const rec = JSON.parse(new TextDecoder().decode(save)) as { tuningOverrides: unknown[] };
  return rec.tuningOverrides.length > 0;
}

/** Every nav tile version of both layers, as one string (a rebuild bumps a tile's version). */
function navVersions(w: World): string {
  const layers = (w.nav as unknown as { layers: { versions: Uint32Array }[] | null } | null)?.layers;
  if (!layers) return '';
  return layers.map((L) => Array.from(L.versions).join(',')).join('|');
}

function checkEntityRef(w: World, r: EntityRef, run: string): void {
  const e = w.entities.get(r.id);
  const where = `${run}: the script's entity ${r.id} (${r.look}, ${r.tick === 0 ? 'generated' : `first named at tick ${r.tick}`})`;
  if (!e) throw new Error(`${where} does not exist: generation or the script's world changed (re-record with AC7_RECORD=1)`);
  if (e.look !== r.look) throw new Error(`${where} is a ${e.look}`);
  const d = Math.hypot(e.pose.p.x - r.p[0], e.pose.p.y - r.p[1], e.pose.p.z - r.p[2]);
  if (d > CONFIG.poseTolM) throw new Error(`${where} is ${(d * 100).toFixed(1)} cm from where the script expects it`);
}

function checkFighterRef(w: World, r: FighterRef, run: string): void {
  const f = w.combat.fighters.find((x) => x.id === r.id);
  if (!f) throw new Error(`${run}: the script's fighter ${r.id} (${r.species}) does not exist at tick ${r.tick}`);
  if (f.species !== r.species) throw new Error(`${run}: the script's fighter ${r.id} is a ${f.species}, not a ${r.species}`);
}

// ---------------------------------------------------------------------------
// Naming the first difference
// ---------------------------------------------------------------------------

/** The save's first differing section: top-level key, then the record (by id where it has one) and the field. */
function saveDiff(a: Uint8Array, b: Uint8Array): string {
  const ja = JSON.parse(new TextDecoder().decode(a)) as Record<string, unknown>;
  const jb = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  const path = firstDiff(ja, jb, []);
  return path === null ? 'the bytes differ but the JSON values are equal (key order or number spelling)' : path;
}

function firstDiff(a: unknown, b: unknown, path: string[]): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  const at = (): string => path.join('.') || '(root)';
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) return `${at()}: length ${a.length} vs ${b.length}`;
      const id = idOf(a[i]);
      const d = firstDiff(a[i], b[i], [...path, id === null ? `[${i}]` : `[${i} id ${id}]`]);
      if (d) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join() !== kb.join()) return `${at()}: keys ${ka.join(',')} vs ${kb.join(',')}`;
    for (const k of ka) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k]);
      if (d) return d;
    }
    return null;
  }
  return `${at()}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
}

function idOf(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return Array.isArray(v) && typeof v[0] === 'number' ? String(v[0]) : null;
  const o = v as Record<string, unknown>;
  for (const k of ['id', 'fighter', 'entity', 'joint', 'tree', 'creature']) if (typeof o[k] === 'number') return `${k} ${o[k]}`;
  return null;
}

/** bodyStateBytes' layout (src/save/bodyState.ts): tag, owner id, [part], then f32/f64 fields. */
const BODY_FIELDS = ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz'];
const POSE_FIELDS = BODY_FIELDS.slice(0, 7);
const PARTS = ['kcc', 'zone', 'slab', 'ruler'];
const FIGHTER_FIELDS = ['pos.x', 'pos.y', 'pos.z', 'vel.x', 'vel.y', 'vel.z', 'walkVel.x', 'walkVel.y', 'walkVel.z', 'yaw', 'hp', 'stamina', 'stateFrame', 'rngState'];

/** The block (and field) of bodyStateBytes holding byte `off`, walking a's layout. */
function bodyBlockAt(bytes: Uint8Array, off: number): string {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  while (i < bytes.length) {
    const start = i;
    const tag = v.getUint8(i);
    let what: string;
    let fields: { name: string; size: number }[];
    let head: number;
    if (tag === 1) {
      what = `entity ${v.getUint32(i + 1, true)} body`;
      head = 5;
      fields = BODY_FIELDS.map((name) => ({ name, size: 4 }));
    } else if (tag === 2 || tag === 3) {
      what = `fighter ${v.getUint32(i + 1, true)} ${PARTS[v.getUint8(i + 5)]} ${tag === 2 ? 'body' : 'collider'}`;
      head = 6;
      fields = (tag === 2 ? BODY_FIELDS : POSE_FIELDS).map((name) => ({ name, size: 4 }));
    } else if (tag === 4) {
      what = `rope sensor of joint ${v.getUint32(i + 1, true)}`;
      head = 5;
      fields = POSE_FIELDS.map((name) => ({ name, size: 4 }));
    } else if (tag === 5) {
      what = `fighter ${v.getUint32(i + 1, true)} core`;
      head = 5;
      fields = FIGHTER_FIELDS.map((name) => ({ name, size: 8 }));
      for (let b = 0; b < 12; b++) for (const n of ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw']) fields.push({ name: `rig[${b}].${n}`, size: 8 });
    } else if (tag === 6) {
      what = 'combat.rng';
      head = 1;
      fields = [{ name: 'state', size: 8 }];
    } else return `byte ${off} (unknown tag ${tag} at ${start})`;
    const end = start + head + fields.reduce((s, f) => s + f.size, 0);
    if (off < end) {
      if (off < start + head) return `${what} (its header)`;
      let at = start + head;
      for (const f of fields) {
        if (off < at + f.size) return `${what}, ${f.name}`;
        at += f.size;
      }
    }
    i = end;
  }
  return `byte ${off} (past the end)`;
}

function bodyDiff(a: Uint8Array, b: Uint8Array): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `${bodyBlockAt(a, i)} (byte ${i})`;
  return `lengths ${a.length} vs ${b.length} (from ${bodyBlockAt(a.length < b.length ? b : a, n)})`;
}

/** A copy of `b` with byte `at` changed (xor `x`). */
function flipped(b: Uint8Array, at: number, x = 0x40): Uint8Array {
  const c = b.slice();
  c[at] ^= x;
  return c;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** Compares two runs checkpoint by checkpoint; null when all agree, else the first difference, named. */
function compareRuns(x: Pick<Runner, 'name' | 'checkpoints'>, y: Pick<Runner, 'name' | 'checkpoints'>): string | null {
  if (x.checkpoints.length !== y.checkpoints.length) return `${x.name} has ${x.checkpoints.length} checkpoints, ${y.name} ${y.checkpoints.length}`;
  for (let i = 0; i < x.checkpoints.length; i++) {
    const a = x.checkpoints[i];
    const b = y.checkpoints[i];
    if (a.tick !== b.tick) return `checkpoint ${i}: tick ${a.tick} vs ${b.tick}`;
    const saveSame = same(a.save, b.save);
    const bodySame = same(a.body, b.body);
    if (!saveSame || !bodySame || a.events !== b.events) {
      const parts: string[] = [];
      if (!saveSame) parts.push(`save differs at ${saveDiff(a.save, b.save)}`);
      if (!bodySame) parts.push(`body state differs at ${bodyDiff(a.body, b.body)}`);
      if (a.events !== b.events) parts.push('the event digests differ');
      return `${x.name} vs ${y.name}: first difference at tick ${a.tick} (checkpoint ${i + 1}/${x.checkpoints.length}): ${parts.join('; ')}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

const live: World[] = [];
afterEach(() => {
  for (const w of live.splice(0)) if (!w.isDisposed) w.dispose();
  resetTuning();
});

type EditedKeys = Map<string, { table: string; key: string; dflt: TuningValue }>;

async function makeRunner(name: string, seed: number, script: Ac7Script, keys: EditedKeys, checkRefs: boolean): Promise<Runner> {
  await yieldToVitest();
  const w = await createWorld({ seed, scene: 'clearing', nav: 'full' });
  live.push(w);
  w.combat.devChecks = true;
  return new Runner(name, w, script, keys, checkRefs);
}

/** Steps runners to `ticks`, interleaved tick by tick when there are several, each with its own tuning view. */
async function runTogether(rs: Runner[], ticks: number): Promise<void> {
  for (let t = 1; t <= ticks; t++) {
    for (const r of rs) {
      r.swapIn();
      r.step();
    }
    if (t % CONFIG.yieldTicks === 0) await yieldToVitest();
  }
  for (const r of rs) r.finish();
}

function summary(r: Runner): string {
  const c = r.cov;
  const m = (x: Map<string, number>): string => [...x].map(([k, v]) => `${k} ${v}`).join(', ');
  const minds = [...c.mindStates].map(([id, s]) => `${id}: ${s.join('→')}`).join('; ');
  return [
    `${r.name}: ${r.checkpoints.length} checkpoints to tick ${r.w.tick}`,
    `  verbs ok: ${m(c.verbsOk)}`,
    `  verbs refused: ${m(c.verbsRefused) || 'none'}`,
    `  world events: ${m(c.worldEvents)}`,
    `  joints: ${m(c.jointWhat)}; impacts with damage ${c.impactsWithDamage}; the player's hits ${c.playerHits}`,
    `  minds: ${minds}`,
    `  saves with tuning overrides ${c.savesWithOverrides}; meta save at ${c.metaSave?.tick ?? 'none'}; nav tiles rebuilt ${c.navVersionsStart !== c.navVersionsEnd}`,
  ].join('\n');
}

/** GATES (coverage, per run): the log really exercised the world, so the comparison can't pass on an idle one. */
function expectCoverage(r: Runner): void {
  const c = r.cov;
  const n = r.name;
  for (const v of ['take', 'drop', 'stow', 'draw', 'place', 'shape', 'lash', 'tie', 'bend', 'cut', 'dig', 'throw', 'pull']) {
    expect(c.verbsOk.get(v) ?? 0, `${n}: GATE verb ${v} ok ≥ 1`).toBeGreaterThanOrEqual(1);
  }
  for (const e of ['fell', 'dig', 'chop', 'land', 'break']) expect(c.worldEvents.get(e) ?? 0, `${n}: GATE world event ${e} ≥ 1`).toBeGreaterThanOrEqual(1);
  expect(c.jointWhat.get('cut') ?? 0, `${n}: GATE a rope cut (joint 'cut')`).toBeGreaterThanOrEqual(1);
  expect(c.impactsWithDamage, `${n}: GATE a world impact with damage > 0`).toBeGreaterThanOrEqual(1);
  expect(c.playerHits, `${n}: GATE the player's strikes hit (combat 'hit')`).toBeGreaterThanOrEqual(1);
  expect(c.navVersionsEnd, `${n}: GATE a nav tile was rebuilt`).not.toBe(c.navVersionsStart);
  expect(c.savesWithOverrides, `${n}: GATE a checkpoint save holds the setTuning edit`).toBeGreaterThanOrEqual(1);
  // The meta save is the world's own end-of-tick save: the checkpoint's serializeWorld of the same tick, byte for byte.
  expect(c.metaSave?.tick, `${n}: GATE the meta save at tick ${CONFIG.saveTick}`).toBe(CONFIG.saveTick);
  const cp = r.checkpoints.find((x) => x.tick === CONFIG.saveTick)!;
  expect(same(c.metaSave!.bytes, cp.save), `${n}: GATE the meta save equals serializeWorld at its tick`).toBe(true);
  const states = [...c.mindStates.values()];
  expect(states.some((s) => s.includes('fight')), `${n}: GATE an ape in fight`).toBe(true);
  const giant = r.w.combat.fighters.filter((f) => f.ruler && f.id > 5);
  expect(giant.length, `${n}: the spawned giant is there`).toBe(1);
  const gs = c.mindStates.get(giant[0].id) ?? [];
  const chase = gs.indexOf('chase');
  expect(chase, `${n}: GATE the giant in chase (${gs.join('→')})`).toBeGreaterThanOrEqual(0);
  expect(gs.slice(chase).some((s) => s === 'charge' || s === 'down'), `${n}: GATE then charge or tripped (${gs.join('→')})`).toBe(true);
}

const RECORD = process.env.AC7_RECORD === '1';

describe.skipIf(RECORD)('AC-7: determinism (SPEC:904, §11.7)', () => {
  it('the same seed and the same command log, run twice (A, B), give byte-identical saves and bit-identical body states every 60 ticks', async () => {
    const script = readScript();
    expect(script.seed).toBe(CONFIG.seed);
    const keys = editedKeys(script.commands);
    expect(keys.size, 'the log holds setTuning edits').toBeGreaterThanOrEqual(1);
    const legacy0 = LEGACY_IDS.next;

    // World C (another seed) first, discarded: module-level state it leaves would show as A ≠ B.
    resetTuning();
    const c = await makeRunner('C', CONFIG.warmSeed, script, keys, false);
    await runTogether([c], Math.min(CONFIG.warmTicks, script.ticks));
    c.w.dispose();

    const t0 = performance.now();
    resetTuning();
    const a = await makeRunner('A', CONFIG.seed, script, keys, true);
    await runTogether([a], script.ticks);
    const msPerTick = (performance.now() - t0) / script.ticks;
    resetTuning();
    const b = await makeRunner('B', CONFIG.seed, script, keys, true);
    await runTogether([b], script.ticks);

    console.info(`AC-7 A/B: ${script.commands.length} commands over ${script.ticks} ticks; ${(msPerTick).toFixed(2)} ms per tick (A, checkpoints included)\n${summary(a)}`);
    // GATES (determinism)
    expect(a.checkpoints.length, 'GATE every 60 ticks').toBe(Math.floor(script.ticks / CONFIG.every));
    expect(compareRuns(a, b), 'GATE A = B at every checkpoint (saves, body states, events)').toBeNull();
    expect(LEGACY_IDS.next, 'GATE no world fighter took a process-wide id').toBe(legacy0);
    console.info(`AC-7 A = B: ${a.checkpoints.length}/${a.checkpoints.length} checkpoints identical (save ${a.checkpoints.at(-1)!.save.length} B, body state ${a.checkpoints.at(-1)!.body.length} B at tick ${a.w.tick})`);
    expectCoverage(a);
    expectCoverage(b);
    // The check can see a difference, and names it: one f32 of the last body state and one save byte changed.
    const last = a.checkpoints.length - 1;
    const bent = a.checkpoints.map((cp, i) => (i === last ? { ...cp, body: flipped(cp.body, 1 + 4 + 2) } : cp));
    expect(compareRuns(a, { name: 'A*', checkpoints: bent })).toMatch(new RegExp(`tick ${a.checkpoints[last].tick} .*body state differs at entity \\d+ body, tx`));
    const tickAt = new TextDecoder().decode(a.checkpoints[0].save).indexOf('"tick":') + 8;
    const bentSave = a.checkpoints.map((cp, i) => (i === 0 ? { ...cp, save: flipped(cp.save, tickAt, 1) } : cp));
    expect(compareRuns(a, { name: 'A*', checkpoints: bentSave })).toMatch(/tick 60 .*save differs at tick: /);
  }, 600_000);

  it('negative control (P38): one move command turned by one step shows from the next checkpoint on and not before; another seed differs at the first', async () => {
    // End to end, not only the comparator's byte flips above: the same runner and checks fed a log that differs in one
    // command, and a world of another seed, must be told apart, at the right checkpoint.
    const script = readScript();
    const keys = editedKeys(script.commands);
    const at = script.commands.findIndex((c) => c.kind === 'move' && c.tick > 600 && c.speed > 0);
    expect(at, 'a moving move command after tick 600').toBeGreaterThanOrEqual(0);
    const cmd = script.commands[at] as Extract<Command, { kind: 'move' }>;
    const bent: Ac7Script = { ...script, commands: script.commands.map((c, i) => (i === at ? { ...cmd, dir: (cmd.dir + 1) % COMMAND_STEPS } : c)) };
    const firstAfter = Math.ceil(cmd.tick / CONFIG.every) * CONFIG.every;
    const ticks = firstAfter + 3 * CONFIG.every;
    resetTuning();
    const a = await makeRunner('A', CONFIG.seed, script, keys, false);
    await runTogether([a], ticks);
    resetTuning();
    const n = await makeRunner('N', CONFIG.seed, bent, keys, false);
    await runTogether([n], ticks);
    const before = (r: Runner) => ({ name: r.name, checkpoints: r.checkpoints.filter((cp) => cp.tick < cmd.tick) });
    expect(before(a).checkpoints.length).toBeGreaterThan(5);
    expect(compareRuns(before(a), before(n)), 'GATE identical before the changed command').toBeNull();
    expect(compareRuns(a, n), 'GATE the changed command shows at the first checkpoint after it').toMatch(new RegExp(`first difference at tick ${firstAfter} `));
    resetTuning();
    const o = await makeRunner('O', CONFIG.seed + 1, script, keys, false);
    await runTogether([o], CONFIG.every);
    const first = (r: Runner) => ({ name: r.name, checkpoints: r.checkpoints.slice(0, 1) });
    expect(compareRuns(first(a), first(o)), 'GATE another seed differs at the first checkpoint').toMatch(/first difference at tick 60 .*save differs at seed/);
    // Not only the seed field: the world itself differs (P38 review): its bodies' states, from the first entity body on
    // (the generated Clearing is another one), and the saves' content with the seed left out.
    const [ca, co] = [a.checkpoints[0], o.checkpoints[0]];
    expect(same(ca.body, co.body), 'GATE another seed: different body states').toBe(false);
    expect(bodyDiff(ca.body, co.body), 'GATE another seed: the entities differ').toMatch(/entity \d+ body/);
    const withoutSeed = (b: Uint8Array): string => {
      const s = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
      delete s.seed;
      return JSON.stringify(s);
    };
    expect(withoutSeed(ca.save) === withoutSeed(co.save), 'GATE another seed: the saves differ beyond the seed').toBe(false);
    console.info(`AC-7 negative control: move command ${at} (tick ${cmd.tick}) turned one step: ${compareRuns(a, n)}`);
  }, 600_000);

  it('two worlds stepped interleaved tick by tick (W1, W2) stay byte-identical every 60 ticks', async () => {
    const script = readScript();
    const keys = editedKeys(script.commands);
    const legacy0 = LEGACY_IDS.next;
    resetTuning();
    const w1 = await makeRunner('W1', CONFIG.seed, script, keys, true);
    const w2 = await makeRunner('W2', CONFIG.seed, script, keys, true);
    await runTogether([w1, w2], script.ticks);
    console.info(`AC-7 W1/W2 interleaved:\n${summary(w1)}`);
    expect(compareRuns(w1, w2), 'GATE W1 = W2 at every checkpoint (saves, body states, events)').toBeNull();
    expect(LEGACY_IDS.next, 'GATE no world fighter took a process-wide id').toBe(legacy0);
    console.info(`AC-7 W1 = W2: ${w1.checkpoints.length}/${w1.checkpoints.length} checkpoints identical`);
    expectCoverage(w1);
    expectCoverage(w2);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// The recorder (AC7_RECORD=1 npx vitest run packages/sim/tests/ac7.determinism.test.ts): authors the fixture
// ---------------------------------------------------------------------------

describe.runIf(RECORD)('AC-7 script recorder', () => {
  it('drives the harness on the Clearing of seed S and writes every command it pushes to tests/fixtures/ac7-script.json', async () => {
    resetTuning();
    const h = await makeHarness({ seed: CONFIG.seed, scene: 'clearing', nav: 'full' });
    live.push(h.w);
    const w = h.w;
    const p = h.p;
    const commands: Command[] = [];
    const notes: string[] = [];
    const entities = new Map<number, EntityRef>();
    const fighters = new Map<number, FighterRef>();
    const generated = new Set([...w.entities.all()].map((e) => e.id));
    const refEntity = (id: number | undefined, tick: number): void => {
      if (!id || entities.has(id)) return;
      const e = w.entities.get(id);
      if (!e) throw new Error(`recorder: tick ${tick} names entity ${id}, which does not exist`);
      const at = generated.has(id) && !e.touched ? 0 : tick;
      entities.set(id, { id, tick: at, look: e.look, p: [e.pose.p.x, e.pose.p.y, e.pose.p.z] });
    };
    const q = w.commands;
    const push0 = q.push.bind(q);
    q.push = (c: Command): void => {
      if (c.tick !== w.tick + 1) throw new Error(`recorder: a command for tick ${c.tick} pushed after tick ${w.tick}`);
      if (c.kind === 'verb') {
        refEntity(c.target, c.tick);
        refEntity(c.second, c.tick);
      }
      if (c.kind === 'meta' && c.dev) {
        const ids = c.dev.op === 'killCreature' ? [c.dev.args[0]] : c.dev.op === 'pauseMinds' && c.dev.args.length === 2 ? [c.dev.args[1]] : c.dev.op === 'teleport' && c.dev.args.length >= 3 && c.dev.args[2] > 0 ? [c.dev.args[2]] : [];
        for (const id of ids) {
          const f = w.combat.fighters.find((x) => x.id === id);
          if (!f) throw new Error(`recorder: tick ${c.tick} names fighter ${id}, which does not exist`);
          if (!fighters.has(id)) fighters.set(id, { id, tick: c.tick, species: f.species });
        }
      }
      commands.push(cloneCommand(c));
      push0(c);
    };
    const push = (c: Command): void => q.push(c);
    // The meta save at its tick, whatever helper is stepping then.
    const step0 = h.step.bind(h);
    (h as unknown as { step: () => unknown }).step = () => {
      if (w.tick + 1 === CONFIG.saveTick) push({ tick: w.tick + 1, player: 1, kind: 'meta', meta: 'save' });
      return step0();
    };
    // The harness's standAt is a direct World.teleport between ticks; here it is the dev op, so the log holds it.
    (h as unknown as { standAt: (at: { x: number; z: number }, yaw?: number) => void }).standAt = (at, yaw) => {
      const args = [Math.round(at.x * 100), Math.round(at.z * 100)];
      if (yaw !== undefined) args.push(0, Math.round((yaw / (2 * Math.PI)) * COMMAND_STEPS));
      push({ tick: w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'teleport', args } });
      step0();
    };
    const note = (what: string): void => {
      const s = `t${w.tick} ${what} | player (${p.pos.x.toFixed(2)}, ${p.pos.y.toFixed(2)}, ${p.pos.z.toFixed(2)}) ${p.state}, hands ${p.inventory?.hands ? `${p.inventory.hands.mode} ${p.inventory.hands.entity}` : 'empty'}`;
      notes.push(s);
      console.info(s);
    };
    const dev = (op: DevOp, args: number[], tuning?: TuningEdit): void => {
      push({ tick: w.tick + 1, player: 1, kind: 'meta', meta: 'dev', dev: tuning ? { op, args, tuning } : { op, args } });
      h.step();
      note(`dev ${op} ${JSON.stringify(tuning ?? args)}`);
    };
    const verb = (v: VerbPayload): void => {
      const r = h.verb(v);
      note(`${v.verb} ${v.target}${v.second ? ` + ${v.second}` : ''}: ${r.ok ? 'ok' : `refused (${r.reason})`}`);
      if (!r.ok) throw new Error(`recorder: ${v.verb} ${v.target} refused (${r.reason})`);
    };
    const button = (b: 'lpunch' | 'rpunch' | 'lkick' | 'rkick' | 'jump'): void => push({ tick: w.tick + 1, player: 1, kind: 'button', button: b });
    const noise = new Rng(99);
    /** Move and button noise from Rng(99): a new walk every 6 ticks (sprinting at times), now and then a jump or a punch. */
    const jitter = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const r = noise.next();
        if (r < 0.04) button('jump');
        else if (r < 0.07) button(noise.chance(0.5) ? 'lpunch' : 'rpunch');
        if (i % 6 === 0) {
          const a = noise.range(0, 2 * Math.PI);
          const s = noise.range(0, 1);
          push(moveCommand(w.tick + 1, 1, Math.sin(a) * s, Math.cos(a) * s, noise.chance(0.3) ? MOVE_SPRINT : 0));
        }
        h.step();
      }
      push(moveCommand(w.tick + 1, 1, 0, 0));
      h.step();
      note(`noise ${n} ticks`);
    };
    const ent = (id: number) => {
      const e = w.entities.get(id);
      if (!e) throw new Error(`recorder: no entity ${id}`);
      return e;
    };
    /** The two ends of a prism's long axis (local y). */
    const ends = (id: number): { x: number; y: number; z: number }[] => {
      const e = ent(id);
      const { x, y, z, w: qw } = e.pose.q;
      const hh = (e.shape as { halfHeight: number }).halfHeight;
      const ax = { x: 2 * (x * y - qw * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + qw * x) };
      const c = e.pose.p;
      return [1, -1].map((s) => ({ x: c.x + ax.x * hh * s, y: c.y + ax.y * hh * s, z: c.z + ax.z * hh * s }));
    };
    const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

    // The Clearing of seed S around the spawn (0, 0): the starter cache at (2.5, 3) (axe 253 with flint 254 lashed by
    // 255, digging stick 256, vine coil 257), dry stick 152, flint 140, stone 101, the 121 kg dry log 195, sapling 81,
    // tree 35 (21 cm, at (32.4, -8.2)) and tree 33's hanging vine 71 (its loose end at (25.9, 1.1)).
    const COIL = 257, DIGGING_STICK = 256, FLINT = 140, STICK = 152, LOG = 195, SAPLING = 81, STONE = 101, TREE = 35, VINE = 71;

    jitter(90);
    dev('setTuning', [], { table: 'MOVE_TUNING', key: 'sprintMul', value: 1.6 });
    h.walk({ x: 3.0, z: 2.2 });
    dev('setTuning', [], { table: 'MOVE_TUNING', key: 'sprintMul', value: 1.4 });
    // The vine coil to the belt (rope for the lash and the bend).
    h.approach(COIL);
    verb({ verb: 'take', target: COIL });
    verb({ verb: 'stow', target: 0, slot: 0 });
    // Dig with the digging stick.
    h.approach(DIGGING_STICK);
    verb({ verb: 'take', target: DIGGING_STICK });
    h.walk({ x: 0.5, z: 4.6 });
    for (let i = 0; i < 6; i++) {
      const x = 0.2 + (i % 3) * 0.3;
      const z = 5.7 + Math.floor(i / 3) * 0.3;
      verb({ verb: 'dig', target: 0, at: toCm({ x, y: w.terrain.heightAt(x, z), z }), charge: 1 });
    }
    verb({ verb: 'drop', target: 0 });
    // Shape the dry stick's end with a flint: three strokes, then charge 0.
    h.approach(FLINT);
    verb({ verb: 'take', target: FLINT });
    h.approach(STICK);
    const stakeLen = 2 * (ent(STICK).shape as { halfHeight: number }).halfHeight;
    {
      const end = ends(STICK).sort((a, b) => flat(a, p.pos) - flat(b, p.pos))[0];
      push({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'shape', target: STICK, at: toCm(end), charge: 1 });
      h.ticks(200);
      push({ tick: w.tick + 1, player: 1, kind: 'verb', verb: 'shape', target: STICK, at: toCm(end), charge: 0 });
      h.until(() => p.free && !p.verbRequest && !w.verbs.continuousOf(p), 300, 'shape off');
      note(`shape ${STICK}: sharpness ${ent(STICK).sharpPoints.map((s) => s.sharpness.toFixed(2)).join(',')}`);
    }
    verb({ verb: 'drop', target: 0 });
    // The stake, upright and driven just past the log's end nearer the sapling; the log lashed to it.
    verb({ verb: 'take', target: STICK });
    const sap = ent(SAPLING).pose.p;
    const lc = ent(LOG).pose.p;
    const le = ends(LOG).sort((a, b) => flat(a, sap) - flat(b, sap))[0];
    const u = { x: (le.x - lc.x) / flat(le, lc), z: (le.z - lc.z) / flat(le, lc) };
    const base = { x: le.x + u.x * 0.1, z: le.z + u.z * 0.1 };
    h.walk({ x: base.x + u.x * 0.9, z: base.z + u.z * 0.9 });
    verb({ verb: 'place', target: 0, at: toCm({ x: base.x, y: w.terrain.heightAt(base.x, base.z) + stakeLen / 2, z: base.z }), yaw: 0, pitch: 64, drive: 1 });
    note(`stake ${STICK} ${ent(STICK).state}`);
    {
      const sp = ent(STICK).pose.p;
      verb({ verb: 'lash', target: LOG, second: STICK, at: toCm({ x: le.x, y: lc.y, z: le.z }), at2: toCm({ x: sp.x - u.x * 0.03, y: lc.y, z: sp.z - u.z * 0.03 }) });
    }
    // Bend the sapling down to the stake.
    {
      const sp = ent(STICK).pose.p;
      h.approach(SAPLING);
      verb({ verb: 'bend', target: SAPLING, second: STICK, at2: toCm({ x: sp.x, y: sp.y + 0.4, z: sp.z }) });
      note(`sapling ${SAPLING} ${ent(SAPLING).plant?.phase}`);
    }
    // Throw a stone, then a spear.
    h.approach(STONE);
    verb({ verb: 'take', target: STONE });
    verb({ verb: 'throw', target: 0, aim: aimOf({ x: 1, y: 0.3, z: 0.2 }), charge: 255 });
    h.ticks(40);
    dev('giveTool', [2]);
    verb({ verb: 'throw', target: 0, aim: aimOf({ x: 1, y: 0.15, z: -0.3 }), charge: 255 });
    h.ticks(40);
    // A stone axe, a teleport to the tree, chop it to a third.
    dev('giveTool', [0]);
    const tc = ent(TREE).pose.p;
    dev('teleport', [Math.round((tc.x - 2.5) * 100), Math.round((tc.z + 0.3) * 100)]);
    h.ticks(20);
    const chop = h.chopTo(TREE, 0.3);
    note(`chopTo ${TREE}: ${chop.chops} chops in ${chop.swings} swings, remaining ${ent(TREE).plant?.cut?.remaining.toFixed(3)}`);
    // A 12 m vine tied to the notched tree, paid out, pulled: it falls.
    verb({ verb: 'stow', target: 0, slot: BACK_SLOT });
    dev('giveTool', [3]);
    const r35 = ent(TREE).plant!.diameter / 2;
    h.walk({ x: tc.x + r35 + 0.7, z: tc.z - 0.4 });
    verb({ verb: 'tie', target: TREE, at: toCm({ x: tc.x + r35 * 0.95, y: w.terrain.heightAt(tc.x, tc.z) + 1.8, z: tc.z }) });
    h.walk({ x: tc.x + 9.5, z: tc.z - 4 });
    const pulled = h.pull(200);
    note(`pull: fell ${pulled.world.filter((e) => e.type === 'fell').length}, tree ${TREE} ${ent(TREE).plant?.phase ?? 'felled'}`);
    if (!pulled.world.some((e) => e.type === 'fell')) throw new Error('recorder: the tree did not fall');
    h.ticks(90);
    verb({ verb: 'drop', target: 0 });
    // Cut tree 33's hanging vine with the axe, from where its line passes 1.2 m up.
    dev('teleport', [2650, 30]);
    h.ticks(10);
    verb({ verb: 'draw', target: 0, slot: BACK_SLOT });
    let severed = false;
    for (const d of [0.9, 0.7, 1.1, 0.5, 1.3]) {
      h.walk({ x: 26.67 - 0.214 * d, z: 0.93 - 0.977 * d });
      const r = h.verb({ verb: 'cut', target: VINE });
      severed = r.events.some((e) => e.type === 'joint' && e.what === 'cut');
      note(`cut ${VINE} from ${d} m: ${r.ok ? 'ok' : `refused (${r.reason})`}${severed ? ', severed' : ', missed'}`);
      if (severed) break;
    }
    if (!severed) throw new Error('recorder: the vine was not cut');
    // An ape beside the player, struck at; it fights back.
    dev('spawnApe', [Math.round((p.pos.x + 3) * 100), Math.round((p.pos.z - 2) * 100)]);
    const ape = w.combat.fighters[w.combat.fighters.length - 1];
    for (let i = 0; i < 6; i++) {
      button(i % 2 ? 'lpunch' : 'rpunch');
      const r = h.ticks(45);
      note(`strike ${i + 1}: ${r.combat.filter((e) => e.type === 'hit').length} hits; ape ${ape.id} ${(w.minds.get(ape) as unknown as { state: string }).state}, hp ${ape.hp.toFixed(1)}`);
    }
    // The giant, 19 m off: it investigates, telegraphs and charges.
    dev('spawnGiant', [Math.round((p.pos.x - 18) * 100), Math.round((p.pos.z + 6) * 100)]);
    const giant = w.combat.fighters[w.combat.fighters.length - 1];
    for (let i = 0; i < 8; i++) {
      h.ticks(30);
      note(`giant ${giant.id} ${(w.minds.get(giant) as unknown as { state: string }).state} at (${giant.pos.x.toFixed(1)}, ${giant.pos.z.toFixed(1)})`);
    }
    dev('pauseMinds', [1]);
    h.ticks(30);
    dev('pauseMinds', [0]);
    dev('killCreature', [ape.id]);
    h.ticks(30);
    dev('respawnPlayer', []);
    jitter(60);
    expect(h.fixtures.map((f) => f.op), 'the recorded world was driven by commands only').toEqual([]);
    expect(w.tick).toBeGreaterThan(CONFIG.saveTick);

    writeScript({
      format: 'rotw-ac7-script',
      seed: CONFIG.seed,
      ticks: w.tick,
      notes,
      entities: [...entities.values()].sort((a, b) => a.tick - b.tick || a.id - b.id),
      fighters: [...fighters.values()],
      commands,
    });
    console.info(`AC-7 recorder: ${commands.length} commands over ${w.tick} ticks → ${SCRIPT_PATH}`);
  }, 600_000);
});
