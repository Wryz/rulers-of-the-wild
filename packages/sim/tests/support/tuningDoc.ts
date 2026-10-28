// P38 (RR-7): which registered tuning keys have no row in docs/M1-DESIGN.md §9.1 ("Every starting value, by table").
//
// A §9.1 row is `| TABLE | key | value | unit | source |`; its key cell may group keys with " / " ("a / b / c"), name a
// compound value by its path (MATERIALS "greenWood" covers greenWood.density …: the row gives every part of the value),
// and give later keys of a group relative to the first one's parent ("shared.sightRayTolM / repathCheckTicks" names
// shared.repathCheckTicks). A leaf is covered only by its full path: a key token equal to it, or a dotted prefix of it
// (a compound value). P38 review: a key's last segments alone no longer count.

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
    let parent = '';
    cells[2].split('/').forEach((t, i) => {
      const k = t.trim().replace(/`/g, '');
      if (!k) return;
      if (i === 0) parent = k.includes('.') ? k.slice(0, k.lastIndexOf('.')) : '';
      out.push(i > 0 && parent && !k.includes('.') ? `${parent}.${k}` : k);
    });
  }
  return out;
}

/** The keys among `keys` (dotted leaf paths of `table`) that no §9.1 row covers, in the order given. */
export function uncoveredTuningKeys(doc: string, table: string, keys: readonly string[]): string[] {
  const tokens = rowKeys(doc, table);
  return keys.filter((k) => !tokens.some((t) => k === t || k.startsWith(`${t}.`)));
}
