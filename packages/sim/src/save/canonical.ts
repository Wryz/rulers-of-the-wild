// The canonical JSON of the save (docs/M1-DESIGN.md §8.3): the writer and its reader.
//
// Writer (canonicalJson): records are plain data built by explicit per-record writers (every toRecord, and
// save/serialize.ts for what it assembles), so keys are emitted in the order those writers give them, never sorted and
// never JSON.stringify of live objects. Numbers go through canonicalNum:
// - a finite number → String(v), the shortest text that reads back as the same double (deterministic);
// - −0 → the text `-0` (String(−0) is "0"): a JSON number token that JSON.parse reads back as −0, the form P04's record
//   readers (numFromRecord) and the tuning registry's snapshots already use. §8.3 writes it `"-0"`; we read that as the
//   text, not as a JSON string, since a string "-0" would be refused by every record reader (numFromRecord);
// - Infinity, −Infinity, NaN → the JSON strings "$inf", "$-inf", "$nan".
// So that those three strings can never be confused with a string field, a string that starts with '$' is written with
// one more '$' in front ('$x' → '$$x'). The reader therefore decodes without knowing the field (parseCanonicalJson),
// and P04's field-aware readers, which take both a number and the '$' strings, read either form.
//
// Plain data only: null, booleans, numbers, strings, arrays and plain objects. Anything else (a Vector3, a Map or Set,
// a typed array, a function, a cycle) is a writer bug and throws with the path to it. An object property whose value is
// undefined is left out, as JSON does (an optional field that is absent); an undefined array element throws.
//
// Bytes: serializeWorld encodes the text as UTF-8 (save/serialize.ts); loadWorld decodes it (save/load.ts).

/** The strings that stand for numbers JSON can't hold. */
const SPECIAL_NUMBERS: Readonly<Record<string, number>> = { $inf: Infinity, '$-inf': -Infinity, $nan: NaN };

/** One number as canonical JSON text. */
export function canonicalNum(v: number): string {
  if (typeof v !== 'number') throw new Error(`canonicalNum: ${String(v)} is not a number`);
  if (Number.isNaN(v)) return '"$nan"';
  if (v === Infinity) return '"$inf"';
  if (v === -Infinity) return '"$-inf"';
  return Object.is(v, -0) ? '-0' : String(v);
}

/** A string as canonical JSON text: a leading '$' is doubled, so it never reads back as a number. */
export function canonicalStr(s: string): string {
  return JSON.stringify(s.startsWith('$') ? `$${s}` : s);
}

/** A save record as canonical JSON text (keys in the record's fixed order). */
export function canonicalJson(rec: unknown): string {
  const out: string[] = [];
  write(rec, 'record', out, []);
  return out.join('');
}

function write(v: unknown, path: string, out: string[], stack: object[]): void {
  switch (typeof v) {
    case 'number':
      out.push(canonicalNum(v));
      return;
    case 'string':
      out.push(canonicalStr(v));
      return;
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'object':
      break;
    default:
      throw notPlain(path, v);
  }
  if (v === null) {
    out.push('null');
    return;
  }
  if (stack.includes(v)) throw new Error(`canonicalJson: ${path} refers back to itself (a cycle)`);
  if (Array.isArray(v)) {
    stack.push(v);
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      if (v[i] === undefined) throw new Error(`canonicalJson: ${path}[${i}] is undefined`);
      write(v[i], `${path}[${i}]`, out, stack);
    }
    out.push(']');
    stack.pop();
    return;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw notPlain(path, v);
  stack.push(v);
  out.push('{');
  let first = true;
  for (const k of Object.keys(v)) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    if (!first) out.push(',');
    first = false;
    out.push(JSON.stringify(k), ':');
    write(x, `${path}.${k}`, out, stack);
  }
  out.push('}');
  stack.pop();
}

function notPlain(path: string, v: unknown): Error {
  const what = v !== null && typeof v === 'object' ? (v.constructor?.name ?? 'object') : typeof v;
  return new Error(`canonicalJson: ${path} is not plain data (${what})`);
}

/**
 * Reads canonical JSON text back into plain data: "$inf", "$-inf" and "$nan" become numbers, a '$$…' string loses its
 * escape, −0 stays −0 (JSON.parse reads the `-0` token as −0). A string that starts with a single '$' and is none of
 * the three is not something the writer makes, and throws.
 */
export function parseCanonicalJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    if (value.startsWith('$$')) return value.slice(1);
    if (Object.prototype.hasOwnProperty.call(SPECIAL_NUMBERS, value)) return SPECIAL_NUMBERS[value];
    throw new Error(`parseCanonicalJson: the string ${JSON.stringify(value)} is neither an escaped string nor a number`);
  });
}
