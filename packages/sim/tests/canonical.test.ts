// P13, the save's canonical JSON (docs/M1-DESIGN.md §8.3): the writer (canonicalNum, canonicalJson) and its reader
// (parseCanonicalJson).
//
// - Numbers: finite → the shortest text that reads back as the same double; −0 → the `-0` token, read back as −0;
//   Infinity, −Infinity, NaN → "$inf", "$-inf", "$nan", read back as numbers; every double survives (seeded sweep).
// - Strings: a leading '$' is escaped, so a string can never read back as a number; an unescaped '$' string is refused.
// - Keys: emitted in the record's own order (the writers fix it), never sorted; the output is valid JSON and the same
//   record always gives the same text.
// - Plain data only: a Vector3, Map, Set, typed array, function, class instance, cycle or undefined array element is
//   refused with its path; an undefined property is left out (an absent optional field).
// - P04's field-aware readers (numFromRecord) read what this reader gives back.
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { numFromRecord } from '../src/body/animator';
import { Rng } from '../src/sim/math';
import { canonicalJson, canonicalNum, canonicalStr, parseCanonicalJson } from '../src/save/canonical';

/** A record through the canonical text and back. */
const reread = (v: unknown): unknown => parseCanonicalJson(canonicalJson(v));

describe('canonicalNum', () => {
  it('writes finite numbers as their shortest round-trip text', () => {
    expect(canonicalNum(0)).toBe('0');
    expect(canonicalNum(1)).toBe('1');
    expect(canonicalNum(-2.5)).toBe('-2.5');
    expect(canonicalNum(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalNum(1e21)).toBe('1e+21');
    expect(canonicalNum(1e-7)).toBe('1e-7');
    expect(canonicalNum(5e-324)).toBe('5e-324');
    expect(canonicalNum(Number.MAX_VALUE)).toBe('1.7976931348623157e+308');
    expect(canonicalNum(0xffffffff)).toBe('4294967295');
    expect(canonicalNum(Math.fround(0.1))).toBe('0.10000000149011612');
  });

  it('writes −0 as the -0 token and the non-finite numbers as "$inf", "$-inf", "$nan"', () => {
    expect(canonicalNum(-0)).toBe('-0');
    expect(canonicalNum(Infinity)).toBe('"$inf"');
    expect(canonicalNum(-Infinity)).toBe('"$-inf"');
    expect(canonicalNum(NaN)).toBe('"$nan"');
  });

  it('refuses what is not a number', () => {
    expect(() => canonicalNum('1' as unknown as number)).toThrow(/not a number/);
  });
});

describe('numbers round-trip through the text', () => {
  it('−0, Infinity, −Infinity and NaN come back as themselves, at any depth', () => {
    const back = reread({ a: -0, b: [Infinity, -Infinity, NaN, -0, 0], c: { d: { e: -0 } } }) as {
      a: number;
      b: number[];
      c: { d: { e: number } };
    };
    expect(Object.is(back.a, -0)).toBe(true);
    expect(back.b[0]).toBe(Infinity);
    expect(back.b[1]).toBe(-Infinity);
    expect(Number.isNaN(back.b[2])).toBe(true);
    expect(Object.is(back.b[3], -0)).toBe(true);
    expect(Object.is(back.b[4], 0)).toBe(true);
    expect(Object.is(back.c.d.e, -0)).toBe(true);
  });

  it('every double comes back bit for bit (a seeded sweep of 20,000 values over the whole range)', () => {
    const rng = new Rng(20261017);
    const bits = new DataView(new ArrayBuffer(8));
    const values: number[] = [];
    for (let i = 0; i < 20000; i++) {
      // Random bit patterns (every exponent, subnormals included), plus f32 values like Rapier's.
      bits.setUint32(0, Math.floor(rng.next() * 0x100000000));
      bits.setUint32(4, Math.floor(rng.next() * 0x100000000));
      const v = bits.getFloat64(0);
      values.push(v, Math.fround(rng.range(-1000, 1000)), rng.range(-1, 1) * 10 ** Math.floor(rng.range(-30, 30)));
    }
    const back = reread(values) as number[];
    expect(back.length).toBe(values.length);
    for (let i = 0; i < values.length; i++) {
      if (!Object.is(back[i], values[i])) throw new Error(`value ${i}: ${values[i]} came back as ${back[i]}`);
    }
  });

  it("P04's numFromRecord reads what the reader gives back, and the raw '$' strings too", () => {
    const back = reread({ prevDist: Infinity, z: -0 }) as { prevDist: number; z: number };
    expect(numFromRecord(back.prevDist, 'prevDist')).toBe(Infinity);
    expect(Object.is(numFromRecord(back.z, 'z'), -0)).toBe(true);
    const raw = JSON.parse(canonicalJson({ prevDist: Infinity })) as { prevDist: unknown };
    expect(raw.prevDist).toBe('$inf');
    expect(numFromRecord(raw.prevDist, 'prevDist')).toBe(Infinity);
  });
});

describe('strings', () => {
  it("escape a leading '$', so no string reads back as a number", () => {
    expect(canonicalStr('$inf')).toBe('"$$inf"');
    expect(canonicalStr('$$x')).toBe('"$$$x"');
    expect(canonicalStr('a$b')).toBe('"a$b"');
    const strings = ['$inf', '$-inf', '$nan', '$', '$$', '$$$inf', '-0', 'plain', '', 'ünïcødé ✓ 🌲', 'quote " and \\ backslash', 'line\nbreak'];
    expect(reread(strings)).toEqual(strings);
    const mixed = reread({ s: '$nan', n: NaN }) as { s: unknown; n: unknown };
    expect(mixed.s).toBe('$nan');
    expect(Number.isNaN(mixed.n)).toBe(true);
  });

  it("refuse an unescaped '$' string that names no number (the writer never makes one)", () => {
    expect(() => parseCanonicalJson('{"a":"$x"}')).toThrow(/neither an escaped string nor a number/);
    expect(() => parseCanonicalJson('["$"]')).toThrow(/neither an escaped string nor a number/);
  });
});

describe('keys and text', () => {
  it("keep the record's own key order (writers fix it; nothing is sorted)", () => {
    expect(canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe('{"b":1,"a":2,"c":{"z":1,"y":2}}');
    expect(canonicalJson({ a: 2, b: 1 })).not.toBe(canonicalJson({ b: 1, a: 2 }));
    const back = reread({ z: 1, a: 2, m: 3 }) as Record<string, number>;
    expect(Object.keys(back)).toEqual(['z', 'a', 'm']);
  });

  it('is compact, valid JSON, and the same record always gives the same text', () => {
    const rec = { id: 3, pose: { p: { x: 1.5, y: -0, z: 2 }, q: { x: 0, y: 0, z: 0, w: 1 } }, tags: ['a', 'b'], none: null, ok: true };
    const t = canonicalJson(rec);
    expect(t).toBe('{"id":3,"pose":{"p":{"x":1.5,"y":-0,"z":2},"q":{"x":0,"y":0,"z":0,"w":1}},"tags":["a","b"],"none":null,"ok":true}');
    expect(() => JSON.parse(t)).not.toThrow();
    expect(canonicalJson(JSON.parse(t))).toBe(t);
    expect(canonicalJson(structuredClone(rec))).toBe(t);
  });

  it('leaves out an undefined property (an absent optional field) and keeps null', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: null })).toBe('{"a":1,"c":null}');
  });

  it('writes objects with a null prototype like plain ones', () => {
    const o = Object.create(null) as Record<string, number>;
    o.x = 1;
    expect(canonicalJson(o)).toBe('{"x":1}');
  });
});

describe('plain data only', () => {
  it('refuses live objects with the path to them', () => {
    expect(() => canonicalJson({ pos: new Vector3(1, 2, 3) })).toThrow('canonicalJson: record.pos is not plain data (Vector3)');
    expect(() => canonicalJson({ m: new Map() })).toThrow('record.m is not plain data (Map)');
    expect(() => canonicalJson({ s: [new Set([1])] })).toThrow('record.s[0] is not plain data (Set)');
    expect(() => canonicalJson({ h: new Float32Array(2) })).toThrow('record.h is not plain data (Float32Array)');
    expect(() => canonicalJson({ f: () => 1 })).toThrow('record.f is not plain data (function)');
    expect(() => canonicalJson({ b: 1n })).toThrow('record.b is not plain data (bigint)');
    class Thing {
      x = 1;
    }
    expect(() => canonicalJson({ t: new Thing() })).toThrow('record.t is not plain data (Thing)');
  });

  it('refuses an undefined array element and a cycle', () => {
    expect(() => canonicalJson({ a: [1, undefined] })).toThrow('record.a[1] is undefined');
    const c: Record<string, unknown> = { a: 1 };
    c.self = { back: c };
    expect(() => canonicalJson(c)).toThrow('record.self.back refers back to itself');
    // The same object twice (not a cycle) is plain data.
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});
