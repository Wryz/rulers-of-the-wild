// The canonical JSON writer of the save (docs/M1-DESIGN.md §8.3): explicit per-record writers emit keys in a fixed
// order (never JSON.stringify of live objects); numbers through `num(v)`: finite → String(v), −0 → "-0", Infinity,
// −Infinity and NaN → "$inf", "$-inf", "$nan".
//
// STUB (P05; P13 fills it): final exported signatures; both functions throw until P13.

/** One number as canonical JSON text. */
export function canonicalNum(v: number): string {
  return notImplemented('canonicalNum', v);
}

/** A save record as canonical JSON text (keys in the record's fixed order). */
export function canonicalJson(rec: unknown): string {
  return notImplemented('canonicalJson', rec);
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`save/canonical.ts: ${name} is not implemented yet (P13; called with ${args.length} arguments)`);
}
