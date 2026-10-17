// The live tuning registry (docs/M1-DESIGN.md §1.5.11, §9). Every starting value lives in a plain mutable table,
// defined and registered in the module that reads it with defineTuning(name, folder, table, fields). `fields` gives
// every leaf its unit and source, so a value without metadata can't be registered. The dev panel builds itself from
// TUNING and edits a value through a `meta 'dev' setTuning` command (applied with setTuningValue), so live tuning is
// in the command log and a replay reproduces it.
//
// The registry is per process: the client holds one live world; a test that changes tuning restores a snapshot.
//
// Tables are read at use time, never cached. A leaf is whatever its FieldMeta sits on: usually a number, boolean or
// string; it may also be a compound value (an object, an array or null, e.g. a material's `strength`), whose
// primitives share that metadata and are set by a dotted path into it. A key defined by a getter with no setter is a
// read-out (derived from other values, shown by the panel, never edited, snapshotted or restored).

export interface FieldMeta {
  unit: string;
  source: string;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  options?: readonly string[];
}

export type FieldsOf<T> = { [K in keyof T]: T[K] extends Record<string, unknown> ? FieldsOf<T[K]> : FieldMeta };

export interface TuningEntry {
  name: string;
  /** Panel folder path, levels joined by ' › ' ("Damage rule › world impacts"). */
  folder: string;
  table: Record<string, unknown>;
  fields: Record<string, unknown>;
  /** Canonical JSON of the table as registered (its defaults). */
  defaults: string;
}

export type TuningValue = number | boolean | string;

/** One FieldMeta of a table, in definition order (what the panel binds). */
export interface TuningLeaf {
  /** Dotted path from the table. */
  key: string;
  meta: FieldMeta;
  /** A getter-only read-out. */
  readOnly: boolean;
}

const entries: TuningEntry[] = [];

/** Every registered table, in registration order (= module import order, deterministic). */
export const TUNING: readonly TuningEntry[] = entries;

type Data = null | boolean | number | string | Data[] | { [k: string]: Data };

export function defineTuning<T extends Record<string, unknown>>(name: string, folder: string, table: T, fields: FieldsOf<T>): T {
  if (typeof name !== 'string' || name === '') throw new Error('defineTuning: a table needs a name');
  if (entries.some((e) => e.name === name)) throw new Error(`defineTuning: a table named ${name} is already registered`);
  if (typeof folder !== 'string' || folder === '') throw new Error(`defineTuning(${name}): a table needs a folder`);
  if (!isPlainObject(table)) throw new Error(`defineTuning(${name}): the table must be a plain object`);
  checkNode(name, [], table, fields as unknown);
  const entry: TuningEntry = { name, folder, table, fields: fields as Record<string, unknown>, defaults: '' };
  entry.defaults = encodeTable(entry);
  entries.push(entry);
  return table;
}

/** Canonical JSON of every table (sorted by table name, keys sorted; read-outs left out). */
export function tuningSnapshot(): string {
  const names = entries.map((e) => e.name).sort(byString);
  return `{${names.map((n) => `${JSON.stringify(n)}:${encodeTable(entryOf(n))}`).join(',')}}`;
}

/**
 * Puts every table named in `snapshot` back to its values. All or nothing: it throws, changing nothing, on an
 * unknown table or key, a missing key, or a value of the wrong type. Tables registered after the snapshot was taken
 * (absent from it) are left alone.
 */
export function restoreTuning(snapshot: string): void {
  const parsed = JSON.parse(snapshot) as unknown;
  if (!isPlainObject(parsed)) throw new Error('restoreTuning: a snapshot is a JSON object of tables');
  const names = Object.keys(parsed).sort(byString);
  const entriesToRestore = names.map((n) => {
    const e = entries.find((x) => x.name === n);
    if (!e) throw new Error(`restoreTuning: unknown table ${n}`);
    return e;
  });
  for (const e of entriesToRestore) restoreTable(e, parsed[e.name], true);
  for (const e of entriesToRestore) restoreTable(e, parsed[e.name], false);
}

/** Puts every table, or the one named, back to its registered defaults (tests, the panel's reset). */
export function resetTuning(table?: string): void {
  const list = table === undefined ? entries : entries.filter((e) => e.name === table);
  if (list.length === 0 && table !== undefined) throw new Error(`resetTuning: unknown table ${table}`);
  restoreTuning(`{${list.map((e) => `${JSON.stringify(e.name)}:${e.defaults}`).join(',')}}`);
}

/** Every primitive that differs from its registered default, sorted by (table, key); keys are dotted paths. */
export function tuningOverrides(): { table: string; key: string; value: TuningValue }[] {
  const out: { table: string; key: string; value: TuningValue }[] = [];
  for (const e of entries) {
    const defaults = JSON.parse(e.defaults) as Data;
    for (const [path, value] of primitives(e)) {
      const d = getPath(defaults, path);
      if (d === MISSING || encodeData(decodeLike(d as Data, value)) !== encodeData(value)) out.push({ table: e.name, key: path.join('.'), value });
    }
  }
  return out.sort((a, b) => byString(a.table, b.table) || byString(a.key, b.key));
}

/**
 * Sets one primitive by table name and dotted key (the `meta 'dev' setTuning` command's effect). Throws on an
 * unknown table or key, a read-out, a key that names a compound value, a type mismatch, NaN, or a string outside the
 * field's options.
 */
export function setTuningValue(table: string, key: string, value: TuningValue): void {
  const e = entries.find((x) => x.name === table);
  if (!e) throw new Error(`setTuningValue: unknown table ${table}`);
  const at = locate(e, key);
  const current = at.holder[at.prop];
  if (current === null || typeof current === 'object') throw new Error(`setTuningValue: ${table}.${key} is not a single value`);
  if (typeof value !== typeof current) {
    throw new Error(`setTuningValue: ${table}.${key} is a ${typeof current}, not a ${typeof value}`);
  }
  if (typeof value === 'number' && Number.isNaN(value)) throw new Error(`setTuningValue: ${table}.${key} can't be NaN`);
  if (typeof value === 'string' && at.meta?.options && !at.meta.options.includes(value)) {
    throw new Error(`setTuningValue: ${table}.${key} must be one of ${at.meta.options.join(', ')}`);
  }
  at.holder[at.prop] = value;
}

/** The current value at a dotted key (a primitive, or a compound leaf as it is). Throws on an unknown table or key. */
export function getTuningValue(table: string, key: string): unknown {
  const e = entries.find((x) => x.name === table);
  if (!e) throw new Error(`getTuningValue: unknown table ${table}`);
  const at = locate(e, key, true);
  return at.holder[at.prop];
}

/** Every FieldMeta of a table in definition order, with its dotted key. */
export function tuningLeaves(e: TuningEntry): TuningLeaf[] {
  const out: TuningLeaf[] = [];
  const walk = (holder: Record<string, unknown>, fields: Record<string, unknown>, path: string[], readOnly: boolean) => {
    for (const k of Object.keys(fields)) {
      const ro = readOnly || isGetterOnly(holder, k);
      const f = fields[k];
      if (isFieldMeta(f)) out.push({ key: [...path, k].join('.'), meta: f, readOnly: ro });
      else walk(holder[k] as Record<string, unknown>, f as Record<string, unknown>, [...path, k], ro);
    }
  };
  walk(e.table, e.fields, [], false);
  return out;
}

// ---------------------------------------------------------------------------
// Validation at registration
// ---------------------------------------------------------------------------

function checkNode(name: string, path: string[], value: unknown, fields: unknown): void {
  const where = `defineTuning(${name}): ${path.length ? path.join('.') : 'the table'}`;
  if (isFieldMeta(fields)) {
    checkMeta(where, fields);
    if (!isData(value)) throw new Error(`${where} holds a value that isn't plain data`);
    if (fields.options && (typeof value !== 'string' || !fields.options.includes(value))) {
      throw new Error(`${where} must be one of its options`);
    }
    return;
  }
  if (!isPlainObject(fields)) throw new Error(`${where} has no metadata (a FieldMeta with unit and source)`);
  if (!isPlainObject(value)) {
    throw new Error(`${where} has no metadata (a FieldMeta with unit and source): what it has describes a nested table`);
  }
  for (const k of Object.keys(value)) {
    if (k === '' || k.includes('.')) throw new Error(`${where}: the key "${k}" can't be addressed by a dotted path`);
    if (!Object.prototype.hasOwnProperty.call(fields, k)) {
      throw new Error(`defineTuning(${name}): ${[...path, k].join('.')} has no metadata (a FieldMeta with unit and source)`);
    }
  }
  for (const k of Object.keys(fields)) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) throw new Error(`defineTuning(${name}): metadata for ${[...path, k].join('.')} names no value`);
    checkNode(name, [...path, k], value[k], fields[k]);
  }
}

function checkMeta(where: string, m: FieldMeta): void {
  if (m.unit === '' || m.source === '') throw new Error(`${where} needs a unit and a source`);
  for (const k of ['min', 'max', 'step'] as const) {
    if (m[k] !== undefined && typeof m[k] !== 'number') throw new Error(`${where}: ${k} must be a number`);
  }
  if (m.label !== undefined && typeof m.label !== 'string') throw new Error(`${where}: label must be a string`);
  if (m.options !== undefined && (!Array.isArray(m.options) || m.options.some((o) => typeof o !== 'string'))) {
    throw new Error(`${where}: options must be strings`);
  }
}

/** A FieldMeta is the object carrying string `unit` and `source` (a nested table's metadata is objects all the way). */
function isFieldMeta(v: unknown): v is FieldMeta {
  return isPlainObject(v) && typeof v.unit === 'string' && typeof v.source === 'string';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isData(v: unknown): boolean {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return true;
  if (Array.isArray(v)) return v.every(isData);
  if (isPlainObject(v)) return Object.keys(v).every((k) => isData(v[k]));
  return false;
}

function isGetterOnly(holder: object, key: string): boolean {
  const d = Object.getOwnPropertyDescriptor(holder, key);
  return !!d && d.get !== undefined && d.set === undefined;
}

// ---------------------------------------------------------------------------
// Canonical encoding: sorted keys; numbers as their shortest round-trip text, −0 as -0; Infinity, −Infinity and NaN
// as the strings "$inf", "$-inf", "$nan" (the save's convention, §8.3), read back by type-aware restores.
// ---------------------------------------------------------------------------

function encodeTable(e: TuningEntry): string {
  return encodeEditable(e.table, e.fields);
}

/** Encodes a table node, leaving out read-outs. */
function encodeEditable(holder: Record<string, unknown>, fields: Record<string, unknown>): string {
  const keys = Object.keys(fields)
    .filter((k) => !isGetterOnly(holder, k))
    .sort(byString);
  const parts = keys.map((k) => {
    const f = fields[k];
    const v = holder[k];
    return `${JSON.stringify(k)}:${isFieldMeta(f) ? encodeData(v as Data) : encodeEditable(v as Record<string, unknown>, f as Record<string, unknown>)}`;
  });
  return `{${parts.join(',')}}`;
}

function encodeData(v: Data): string {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '"$nan"';
    if (v === Infinity) return '"$inf"';
    if (v === -Infinity) return '"$-inf"';
    return Object.is(v, -0) ? '-0' : String(v);
  }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(encodeData).join(',')}]`;
  const keys = Object.keys(v).sort(byString);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${encodeData(v[k])}`).join(',')}}`;
}

const SPECIAL: Record<string, number> = { $inf: Infinity, '$-inf': -Infinity, $nan: NaN };

/**
 * Decodes encoded data guided by the value it replaces: "$inf", "$-inf" and "$nan" become numbers where the current
 * value is a number, or where there is no current value to go by (a compound leaf whose shape changed); a string
 * stays a string where the current value is one.
 */
function decodeLike(v: Data, like: unknown): Data {
  if (typeof v === 'string') return v in SPECIAL && typeof like !== 'string' ? SPECIAL[v] : v;
  if (Array.isArray(v)) return v.map((x, i) => decodeLike(x, Array.isArray(like) ? like[i] : undefined));
  if (v !== null && typeof v === 'object') {
    const o: { [k: string]: Data } = {};
    for (const k of Object.keys(v)) o[k] = decodeLike(v[k], isPlainObject(like) && Object.prototype.hasOwnProperty.call(like, k) ? like[k] : undefined);
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function restoreTable(e: TuningEntry, snap: unknown, dryRun: boolean): void {
  restoreNode(e.name, [], e.table, e.fields, snap, dryRun);
}

function restoreNode(name: string, path: string[], holder: Record<string, unknown>, fields: Record<string, unknown>, snap: unknown, dryRun: boolean): void {
  const where = `restoreTuning: ${[name, ...path].join('.')}`;
  if (!isPlainObject(snap)) throw new Error(`${where} must be an object`);
  const keys = Object.keys(fields).filter((k) => !isGetterOnly(holder, k));
  for (const k of Object.keys(snap)) if (!keys.includes(k)) throw new Error(`${where}: unknown key ${k}`);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(snap, k)) throw new Error(`${where}: missing key ${k}`);
    const f = fields[k];
    if (isFieldMeta(f)) {
      const v = restoredValue(`${where}.${k}`, holder[k], snap[k] as Data, f);
      if (!dryRun) assignData(holder, k, v);
    } else restoreNode(name, [...path, k], holder[k] as Record<string, unknown>, f as Record<string, unknown>, snap[k], dryRun);
  }
}

/** The value a leaf gets back, checked against the leaf's current type. */
function restoredValue(where: string, current: unknown, snap: Data, meta: FieldMeta): Data {
  if (typeof current === 'number') {
    const n = typeof snap === 'string' && snap in SPECIAL ? SPECIAL[snap] : snap;
    if (typeof n !== 'number') throw new Error(`${where} must be a number`);
    return n;
  }
  if (typeof current === 'boolean' || typeof current === 'string') {
    if (typeof snap !== typeof current) throw new Error(`${where} must be a ${typeof current}`);
    if (meta.options && !meta.options.includes(snap as string)) throw new Error(`${where} must be one of its options`);
    return snap;
  }
  // A compound leaf: any plain data (its shape may differ from today's, e.g. a strength that changed kind).
  if (snap !== null && typeof snap !== 'object') throw new Error(`${where} must be an object, an array or null`);
  return decodeLike(snap, current);
}

/** Writes a restored leaf, keeping existing objects (and the references other code holds) where the shape matches. */
function assignData(holder: Record<string, unknown> | unknown[], k: string | number, v: Data): void {
  const cur = (holder as Record<string | number, unknown>)[k];
  if (Array.isArray(cur) && Array.isArray(v) && cur.length === v.length) {
    v.forEach((x, i) => assignData(cur, i, x));
    return;
  }
  if (isPlainObject(cur) && v !== null && typeof v === 'object' && !Array.isArray(v) && sameKeys(cur, v)) {
    for (const key of Object.keys(v)) assignData(cur, key, v[key]);
    return;
  }
  (holder as Record<string | number, unknown>)[k] = v;
}

function sameKeys(a: object, b: object): boolean {
  const ka = Object.keys(a).sort(byString);
  const kb = Object.keys(b).sort(byString);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MISSING = Symbol('missing');

/** Every editable primitive of a table with its path (read-outs left out). */
function primitives(e: TuningEntry): [string[], TuningValue][] {
  const out: [string[], TuningValue][] = [];
  const data = (v: unknown, path: string[]) => {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => data(x, [...path, String(i)]));
    else if (isPlainObject(v)) for (const k of Object.keys(v)) data(v[k], [...path, k]);
  };
  const node = (holder: Record<string, unknown>, fields: Record<string, unknown>, path: string[]) => {
    for (const k of Object.keys(fields)) {
      if (isGetterOnly(holder, k)) continue;
      const f = fields[k];
      if (isFieldMeta(f)) data(holder[k], [...path, k]);
      else node(holder[k] as Record<string, unknown>, f as Record<string, unknown>, [...path, k]);
    }
  };
  node(e.table, e.fields, []);
  return out;
}

function getPath(v: unknown, path: readonly string[]): unknown {
  let cur = v;
  for (const seg of path) {
    if (Array.isArray(cur) && isIndex(seg, cur.length)) cur = cur[Number(seg)];
    else if (isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
    else return MISSING;
  }
  return cur;
}

/** Finds the holder of a dotted key. Throws on an unknown key, or (unless reading) a read-out. */
function locate(e: TuningEntry, key: string, reading = false): { holder: Record<string | number, unknown>; prop: string | number; meta: FieldMeta | null } {
  const path = key.split('.');
  if (path.some((s) => s === '')) throw new Error(`${e.name}: bad key "${key}"`);
  let holder: unknown = e.table;
  let fields: unknown = e.fields;
  let meta: FieldMeta | null = null;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    let prop: string | number;
    if (Array.isArray(holder) && isIndex(seg, holder.length)) prop = Number(seg);
    else if (isPlainObject(holder) && Object.prototype.hasOwnProperty.call(holder, seg)) prop = seg;
    else throw new Error(`${e.name}: unknown key ${key}`);
    if (!reading && isGetterOnly(holder as object, seg)) throw new Error(`${e.name}.${key} is a read-out`);
    if (fields !== null) {
      const f = (fields as Record<string, unknown>)[seg];
      if (isFieldMeta(f)) {
        fields = null;
        if (i === path.length - 1) meta = f;
      } else fields = isPlainObject(f) ? f : null;
    }
    if (i === path.length - 1) return { holder: holder as Record<string | number, unknown>, prop, meta };
    holder = (holder as Record<string | number, unknown>)[prop];
  }
  throw new Error(`${e.name}: unknown key ${key}`);
}

function isIndex(seg: string, length: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(seg) && Number(seg) < length;
}

function entryOf(name: string): TuningEntry {
  return entries.find((e) => e.name === name)!;
}

/** Code-unit order (locale-independent, so every machine sorts alike). */
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
