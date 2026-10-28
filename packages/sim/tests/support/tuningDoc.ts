// P38 (RR-7): which registered tuning keys have no row in docs/M1-DESIGN.md §9.1 ("Every starting value, by table").
//
// A §9.1 row is `| TABLE | key | value | unit | source |`; its key cell may group keys with " / " ("a / b / c"), name a
// compound value by its first path segment (MATERIALS "greenWood" covers greenWood.density …), and give later keys of a
// group relative to the first one's parent ("shared.sightRayTolM / repathCheckTicks"). A leaf is covered when a key
// token of one of its table's rows equals it, is a dotted prefix of it, or is its last segments.

/** §9.1's text (from its heading to §9.2's). */
export function section91(doc: string): string {
  const a = doc.indexOf('### 9.1 ');
  const b = doc.indexOf('### 9.2 ', a);
  if (a < 0 || b < 0) throw new Error('docs/M1-DESIGN.md: no §9.1 / §9.2 headings');
  return doc.slice(a, b);
}

/** The key tokens of every §9.1 row of `table`. */
export function rowKeys(doc: string, table: string): string[] {
  const out: string[] = [];
  for (const line of section91(doc).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    // ['', TABLE, key, value, unit, source, '']
    if (cells.length < 4 || cells[1] !== table) continue;
    for (const t of cells[2].split('/')) {
      const k = t.trim().replace(/`/g, '');
      if (k) out.push(k);
    }
  }
  return out;
}

/** The keys among `keys` (dotted leaf paths of `table`) that no §9.1 row covers, in the order given. */
export function uncoveredTuningKeys(doc: string, table: string, keys: readonly string[]): string[] {
  const tokens = rowKeys(doc, table);
  return keys.filter((k) => !tokens.some((t) => k === t || k.startsWith(`${t}.`) || k.endsWith(`.${t}`)));
}
