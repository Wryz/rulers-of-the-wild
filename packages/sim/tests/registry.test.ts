import { afterEach, describe, expect, it } from 'vitest';
import * as sim from '../src/index';
import { IMPACT_TUNING } from '../src/sim/impact';
import { RULER_TUNING, RULER_ZONE_TUNING } from '../src/sim/ruler';
import {
  defineTuning,
  type FieldsOf,
  getTuningValue,
  resetTuning,
  restoreTuning,
  setTuningValue,
  TUNING,
  tuningLeaves,
  tuningOverrides,
  tuningSnapshot,
} from '../src/tuning/registry';
import type { Material } from '../src/world/types';

const M = (unit = 'm', source = 'test') => ({ unit, source });

/** A material's strength (world/types.ts Material): a union with null, so one FieldMeta covers it. */
type Strength = { solidJPerKg: number } | { ropeKN: number } | null;

let serial = 0;
/** A fresh table name per use (the registry is per process and never forgets a table). */
const fresh = (base: string) => `${base}_${++serial}`;

/** A table with every kind of leaf: numbers (incl. Infinity and -0), a boolean, an option string, a nested table, a
 *  compound leaf (an object under one FieldMeta, like a material's strength), a null leaf and an array leaf. */
function richTable() {
  const name = fresh('T_RICH');
  const table = defineTuning(
    name,
    'Tests › rich',
    {
      speed: 3.5,
      ratio: Infinity,
      floor: -Infinity,
      zero: -0,
      on: true,
      mode: 'bone',
      ape: { vSafe: 6.29, scale: 1.1, deep: { k: 1 } },
      strength: { solidJPerKg: 40 } as Strength,
      none: null as Strength,
      parts: [{ material: 'hide', count: 1 }],
    },
    {
      speed: M('m/s', 'SPEC:1'),
      ratio: M('×', 'NEW'),
      floor: M('×', 'NEW'),
      zero: M('m', 'NEW'),
      on: M('—', 'D-4'),
      mode: { unit: '—', source: 'decision 2', options: ['bone', 'zone'] },
      ape: { vSafe: M('m/s', 'D-4'), scale: M('×', 'SPEC:873'), deep: { k: M('—', 'NEW') } },
      strength: M('J/kg or kN', 'SPEC:208'),
      none: M('kN', 'SPEC:222'),
      parts: M('entities', 'D-30'),
    },
  );
  return { name, table };
}

describe('tuning registry', () => {
  // Tables registered inside a test aren't in a snapshot taken before it, so every test ends at the defaults.
  afterEach(() => {
    resetTuning();
  });

  it('registers a table in order and returns the same object', () => {
    const before = TUNING.length;
    const t = { a: 1 };
    const name = fresh('T_ORDER');
    expect(defineTuning(name, 'Tests', t, { a: M() })).toBe(t);
    const name2 = fresh('T_ORDER');
    defineTuning(name2, 'Tests', { b: 2 }, { b: M() });
    expect(TUNING.slice(before).map((e) => e.name)).toEqual([name, name2]);
    const e = TUNING[before];
    expect(e.table).toBe(t);
    expect(e.folder).toBe('Tests');
    expect(e.defaults).toBe('{"a":1}');
  });

  it('throws on a leaf without metadata, top-level or nested', () => {
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { a: 1, b: 2 }, { a: M() } as never)).toThrow(/b has no metadata/);
    expect(() =>
      defineTuning(fresh('T_BAD'), 'Tests', { n: { a: 1, b: 2 } }, { n: { a: M() } } as never),
    ).toThrow(/n\.b has no metadata/);
    // A nested table given nothing at all, or something that isn't metadata.
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { n: { a: 1 } }, { n: undefined } as never)).toThrow(/no metadata/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { a: 1 }, { a: { unit: 'm' } } as never)).toThrow(/no metadata/);
  });

  it('throws on metadata without a unit or source, metadata naming no value, and bad values', () => {
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { a: 1 }, { a: { unit: 'm', source: '' } })).toThrow(/unit and a source/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { a: 1 }, { a: { unit: '', source: 'x' } })).toThrow(/unit and a source/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { a: 1 }, { a: M(), b: M() } as never)).toThrow(/b names no value/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { a: 1 }, { a: { x: M() } } as never)).toThrow(/nested table/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { f: () => 1 }, { f: M() } as never)).toThrow(/plain data/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { 'a.b': 1 }, { 'a.b': M() })).toThrow(/dotted path/);
    expect(() => defineTuning(fresh('T_BAD'), 'Tests', { m: 'x' }, { m: { ...M(), options: ['a', 'b'] } })).toThrow(/options/);
    expect(() => defineTuning(fresh('T_BAD'), '', { a: 1 }, { a: M() })).toThrow(/folder/);
  });

  it('throws on a second table of the same name', () => {
    const name = fresh('T_DUP');
    defineTuning(name, 'Tests', { a: 1 }, { a: M() });
    expect(() => defineTuning(name, 'Tests', { a: 1 }, { a: M() })).toThrow(/already registered/);
  });

  it('asks for metadata on every leaf at compile time', () => {
    const table = { a: 1, n: { b: true }, s: { solidJPerKg: 1 } as { solidJPerKg: number } | null };
    const ok: FieldsOf<typeof table> = { a: M(), n: { b: M() }, s: M() };
    // @ts-expect-error: n.b has no metadata
    const missing: FieldsOf<typeof table> = { a: M(), n: {}, s: M() };
    // @ts-expect-error: a FieldMeta needs a source
    const noSource: FieldsOf<typeof table> = { a: { unit: 'm' }, n: { b: M() }, s: M() };
    expect([ok, missing, noSource].length).toBe(3);
    // A material row asks for one FieldMeta per property (Material is an indexable type alias), its strength one in all.
    const material: FieldsOf<Material> = {
      density: M('kg/m³'),
      hardness: M('0-1'),
      maxSharpness: M('0-1'),
      flammability: M('0-1'),
      strength: M('J/kg or kN'),
      springiness: M('0-1'),
      friction: M('0-1'),
      armourJ: M('J'),
      wetMassPerMoisture: M('kg/kg'),
    };
    // @ts-expect-error: a whole row can't share one FieldMeta
    const row: FieldsOf<{ greenWood: Material }> = { greenWood: M('mixed') };
    expect([material, row].length).toBe(2);
  });

  it('round-trips snapshot and restore, Infinity, -0 and nested keys included', () => {
    const { name, table } = richTable();
    const s0 = tuningSnapshot();
    expect(JSON.parse(s0)[name]).toEqual({
      ape: { deep: { k: 1 }, scale: 1.1, vSafe: 6.29 },
      floor: '$-inf',
      mode: 'bone',
      none: null,
      on: true,
      parts: [{ count: 1, material: 'hide' }],
      ratio: '$inf',
      speed: 3.5,
      strength: { solidJPerKg: 40 },
      zero: -0,
    });
    expect(s0).toContain(`"zero":-0`);

    setTuningValue(name, 'speed', 4);
    setTuningValue(name, 'ratio', 7);
    setTuningValue(name, 'floor', 0);
    setTuningValue(name, 'zero', 1);
    setTuningValue(name, 'on', false);
    setTuningValue(name, 'mode', 'zone');
    setTuningValue(name, 'ape.vSafe', 7);
    setTuningValue(name, 'ape.deep.k', 2);
    setTuningValue(name, 'strength.solidJPerKg', 41);
    setTuningValue(name, 'parts.0.count', 2);
    setTuningValue(name, 'parts.0.material', 'bone');
    const s1 = tuningSnapshot();
    expect(s1).not.toBe(s0);

    const apeRef = table.ape;
    const strengthRef = table.strength;
    restoreTuning(s0);
    expect(tuningSnapshot()).toBe(s0);
    expect(table.ratio).toBe(Infinity);
    expect(table.floor).toBe(-Infinity);
    expect(Object.is(table.zero, -0)).toBe(true);
    expect(table.ape.vSafe).toBe(6.29);
    expect(table.strength).toEqual({ solidJPerKg: 40 });
    expect(table.parts[0]).toEqual({ material: 'hide', count: 1 });
    // Restoring writes into the objects other code already holds.
    expect(table.ape).toBe(apeRef);
    expect(table.strength).toBe(strengthRef);

    restoreTuning(s1);
    expect(tuningSnapshot()).toBe(s1);
    expect(table.ratio).toBe(7);
    expect(table.mode).toBe('zone');
    expect(table.ape.deep.k).toBe(2);
  });

  it('restores a compound leaf whose shape changed, and NaN', () => {
    const name = fresh('T_SHAPE');
    const table = defineTuning(name, 'Tests', { strength: { solidJPerKg: 40 } as Strength, x: NaN }, {
      strength: M('J/kg or kN', 'SPEC:208'),
      x: M(),
    });
    const s0 = tuningSnapshot();
    expect(JSON.parse(s0)[name].x).toBe('$nan');
    table.strength = { ropeKN: 6 };
    table.x = 1;
    const s1 = tuningSnapshot();
    restoreTuning(s0);
    expect(table.strength).toEqual({ solidJPerKg: 40 });
    expect(Number.isNaN(table.x)).toBe(true);
    restoreTuning(s1);
    expect(table.strength).toEqual({ ropeKN: 6 });
    table.strength = null;
    const s2 = tuningSnapshot();
    restoreTuning(s0);
    restoreTuning(s2);
    expect(table.strength).toBeNull();
  });

  it('lists exactly the changed keys, sorted by table then key', () => {
    expect(tuningOverrides()).toEqual([]);
    const { name } = richTable();
    const other = fresh('T_AAA');
    defineTuning(other, 'Tests', { z: 1, a: 2 }, { z: M(), a: M() });
    expect(tuningOverrides()).toEqual([]);

    setTuningValue(name, 'ratio', 3);
    setTuningValue(name, 'ape.vSafe', 7);
    setTuningValue(name, 'strength.solidJPerKg', 41);
    setTuningValue(name, 'zero', 0); // -0 → 0 is a change
    setTuningValue(name, 'parts.0.count', 2);
    setTuningValue(other, 'z', 5);
    setTuningValue(other, 'a', 2); // unchanged value: not an override
    setTuningValue('IMPACT_TUNING', 'launchDv', 6);
    setTuningValue(name, 'mode', 'zone');
    expect(tuningOverrides()).toEqual([
      { table: 'IMPACT_TUNING', key: 'launchDv', value: 6 },
      { table: other, key: 'z', value: 5 },
      { table: name, key: 'ape.vSafe', value: 7 },
      { table: name, key: 'mode', value: 'zone' },
      { table: name, key: 'parts.0.count', value: 2 },
      { table: name, key: 'ratio', value: 3 },
      { table: name, key: 'strength.solidJPerKg', value: 41 },
      { table: name, key: 'zero', value: 0 },
    ]);
    // Setting a value back to its default removes it; so does a reset.
    setTuningValue(name, 'ratio', Infinity);
    expect(tuningOverrides().some((o) => o.key === 'ratio')).toBe(false);
    resetTuning(name);
    expect(tuningOverrides().map((o) => o.table)).toEqual(['IMPACT_TUNING', other]);
    resetTuning();
    expect(tuningOverrides()).toEqual([]);
    expect(() => resetTuning('NO_SUCH_TABLE')).toThrow(/unknown table/);
  });

  it('applies overrides back onto defaults (the save path)', () => {
    const { name } = richTable();
    setTuningValue(name, 'speed', 9);
    setTuningValue(name, 'ape.deep.k', 3);
    setTuningValue('RULER_TUNING', 'lockScale', 2.5);
    const overrides = JSON.parse(JSON.stringify(tuningOverrides())) as ReturnType<typeof tuningOverrides>;
    const changed = tuningSnapshot();
    resetTuning();
    // A registry at its defaults plus the overrides gives the same state.
    for (const o of overrides) setTuningValue(o.table, o.key, o.value);
    expect(tuningSnapshot()).toBe(changed);
  });

  it('rejects an unknown table or key, a wrong type, NaN, a compound key and a string outside the options', () => {
    const { name, table } = richTable();
    expect(() => setTuningValue('NO_SUCH_TABLE', 'a', 1)).toThrow(/unknown table/);
    expect(() => setTuningValue(name, 'nope', 1)).toThrow(/unknown key/);
    expect(() => setTuningValue(name, 'ape.nope', 1)).toThrow(/unknown key/);
    expect(() => setTuningValue(name, 'speed.x', 1)).toThrow(/unknown key/);
    expect(() => setTuningValue(name, 'parts.1.count', 1)).toThrow(/unknown key/);
    expect(() => setTuningValue(name, 'parts.01.count', 1)).toThrow(/unknown key/);
    expect(() => setTuningValue(name, 'ape..vSafe', 1)).toThrow(/bad key/);
    expect(() => setTuningValue(name, 'speed', '4')).toThrow(/number/);
    expect(() => setTuningValue(name, 'speed', true)).toThrow(/number/);
    expect(() => setTuningValue(name, 'on', 1)).toThrow(/boolean/);
    expect(() => setTuningValue(name, 'mode', 1)).toThrow(/string/);
    expect(() => setTuningValue(name, 'mode', 'other')).toThrow(/one of/);
    expect(() => setTuningValue(name, 'speed', NaN)).toThrow(/NaN/);
    expect(() => setTuningValue(name, 'ape', 1)).toThrow(/not a single value/);
    expect(() => setTuningValue(name, 'strength', 1)).toThrow(/not a single value/);
    expect(() => setTuningValue(name, 'none', 1)).toThrow(/not a single value/);
    expect(table.speed).toBe(3.5);
    expect(tuningOverrides()).toEqual([]);
  });

  it('restores all or nothing', () => {
    const { name, table } = richTable();
    const good = JSON.parse(tuningSnapshot()) as Record<string, Record<string, unknown>>;
    const bad = (mutate: (s: typeof good) => void) => {
      const s = JSON.parse(JSON.stringify(good)) as typeof good;
      s[name].speed = 99; // a valid change that must not land
      mutate(s);
      return JSON.stringify(s);
    };
    expect(() => restoreTuning(bad((s) => (s.NO_SUCH_TABLE = {})))).toThrow(/unknown table/);
    expect(() => restoreTuning(bad((s) => (s[name].extra = 1)))).toThrow(/unknown key/);
    expect(() => restoreTuning(bad((s) => delete s[name].on))).toThrow(/missing key/);
    expect(() => restoreTuning(bad((s) => (s[name].on = 1)))).toThrow(/boolean/);
    expect(() => restoreTuning(bad((s) => (s[name].ratio = 'x')))).toThrow(/number/);
    expect(() => restoreTuning(bad((s) => (s[name].mode = 'other')))).toThrow(/one of/);
    expect(() => restoreTuning(bad((s) => (s[name].strength = 3)))).toThrow(/object/);
    expect(() => restoreTuning(bad((s) => ((s[name].ape as Record<string, unknown>).vSafe = false)))).toThrow(/number/);
    expect(() => restoreTuning(bad((s) => (s[name].ape = 1)))).toThrow(/object/);
    expect(() => restoreTuning('[]')).toThrow(/JSON object/);
    expect(table.speed).toBe(3.5);
    // A snapshot naming only some tables restores those and leaves the rest.
    setTuningValue(name, 'speed', 5);
    setTuningValue('RULER_TUNING', 'pinnedKg', 1200);
    restoreTuning(JSON.stringify({ [name]: good[name] }));
    expect(table.speed).toBe(3.5);
    expect(RULER_TUNING.pinnedKg).toBe(1200);
  });

  it('treats a getter-only key as a read-out: listed, never set, snapshotted or restored', () => {
    const name = fresh('T_READOUT');
    const table = defineTuning(
      name,
      'Tests',
      {
        boneKg: { head: 5.5, chest: 15 },
        get zoneShare() {
          const total = this.boneKg.head + this.boneKg.chest;
          return { head: this.boneKg.head / total, chest: this.boneKg.chest / total };
        },
      },
      { boneKg: { head: M('kg', 'SPEC:876'), chest: M('kg', 'SPEC:876') }, zoneShare: { head: M('fraction', 'SPEC:876'), chest: M('fraction', 'SPEC:876') } },
    );
    const entry = TUNING.find((e) => e.name === name)!;
    expect(tuningLeaves(entry)).toEqual([
      { key: 'boneKg.head', meta: M('kg', 'SPEC:876'), readOnly: false },
      { key: 'boneKg.chest', meta: M('kg', 'SPEC:876'), readOnly: false },
      { key: 'zoneShare.head', meta: M('fraction', 'SPEC:876'), readOnly: true },
      { key: 'zoneShare.chest', meta: M('fraction', 'SPEC:876'), readOnly: true },
    ]);
    expect(entry.defaults).toBe('{"boneKg":{"chest":15,"head":5.5}}');
    expect(() => setTuningValue(name, 'zoneShare.head', 0.5)).toThrow(/read-out/);
    expect(getTuningValue(name, 'zoneShare.head')).toBeCloseTo(5.5 / 20.5, 15);
    setTuningValue(name, 'boneKg.head', 10);
    expect(table.zoneShare.head).toBeCloseTo(0.4, 15);
    expect(tuningOverrides()).toEqual([{ table: name, key: 'boneKg.head', value: 10 }]);
    const withReadout = JSON.parse(tuningSnapshot()) as Record<string, Record<string, unknown>>;
    expect(withReadout[name]).toEqual({ boneKg: { chest: 15, head: 10 } });
    withReadout[name].zoneShare = { head: 1, chest: 0 };
    expect(() => restoreTuning(JSON.stringify(withReadout))).toThrow(/unknown key zoneShare/);
  });

  it('reads values by dotted key', () => {
    const { name } = richTable();
    expect(getTuningValue(name, 'ape.vSafe')).toBe(6.29);
    expect(getTuningValue(name, 'parts.0.material')).toBe('hide');
    expect(getTuningValue(name, 'strength')).toEqual({ solidJPerKg: 40 });
    expect(() => getTuningValue(name, 'ape.x')).toThrow(/unknown key/);
    expect(() => getTuningValue('NO_SUCH_TABLE', 'a')).toThrow(/unknown table/);
  });
});

describe('the registered tables', () => {
  it('give every leaf a unit and a source, under unique names and a folder', () => {
    expect(sim.TUNING).toBe(TUNING);
    const names = TUNING.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['RULER_TUNING', 'RULER_ZONE_TUNING', 'IMPACT_TUNING']));
    for (const e of TUNING) {
      expect(e.folder.length, e.name).toBeGreaterThan(0);
      const leaves = tuningLeaves(e);
      expect(leaves.length, e.name).toBeGreaterThan(0);
      for (const l of leaves) {
        expect(l.meta.unit.length, `${e.name}.${l.key}`).toBeGreaterThan(0);
        expect(l.meta.source.length, `${e.name}.${l.key}`).toBeGreaterThan(0);
      }
    }
  });

  it('snapshot and restore the whole registry exactly', () => {
    const s0 = tuningSnapshot();
    for (const e of TUNING) {
      for (const l of tuningLeaves(e)) {
        const v = getTuningValue(e.name, l.key);
        if (!l.readOnly && typeof v === 'number' && Number.isFinite(v)) setTuningValue(e.name, l.key, v + 1);
      }
    }
    expect(tuningSnapshot()).not.toBe(s0);
    expect(tuningOverrides().length).toBeGreaterThan(0);
    restoreTuning(s0);
    expect(tuningSnapshot()).toBe(s0);
    expect(tuningOverrides()).toEqual([]);
  });

  it('hold the §9 starting values of the ruler and impact tables', () => {
    expect(RULER_TUNING).toMatchObject({
      recoveryHpPerS: 30,
      woundFrac: 0.02,
      severeFrac: 0.15,
      woundHealHpPerHour: 50,
      severePenaltyFrac: 0.05,
      pinnedKg: 1000,
      unpinnedKg: 900,
      unpinTicks: 15,
      pinnedNormalY: 0.5,
      lockScale: 2,
      retargetBiasCapM: 0.35,
      separateSkipSpeed: 1.0,
    });
    expect(RULER_ZONE_TUNING).toMatchObject({
      softJ: 600,
      armourJ: 4000,
      defaultJ: 4000,
      kneeR: 0.09,
      elbowR: 0.07,
      eyeNzMin: 0.6,
      eyeNyMin: -0.05,
      eyeNyMax: 0.35,
      eyeNxMax: 0.55,
      mouthNzMin: 0.6,
      mouthNyMin: -0.6,
      mouthNyMax: -0.05,
      mouthNxMax: 0.4,
      shouldersNy: 0.6,
      backNz: -0.4,
      flanksNx: 0.6,
      bellyNz: 0.5,
      bellyNxMax: 0.6,
    });
    expect(IMPACT_TUNING).toMatchObject({
      poisePerHp: 3.2,
      bluntPoiseMul: 1.35,
      weightMediumHp: 5,
      weightHeavyHp: 12,
      hitstunBase: 12,
      hitstunPerHp: 0.9,
      launchDv: 5,
      flinchDv: 0.5,
      envKillWindowS: 2,
      envKillPartsMul: 2,
      creatureRestitution: 0,
      unbackedTargetMassRatio: Infinity,
      partsRingR: 0.6,
      partsDropH: 0.3,
    });
    // Rule 5 rests on these: armoured zones far above a human strike, soft zones above none.
    expect(RULER_ZONE_TUNING.armourJ).toBeGreaterThan(RULER_ZONE_TUNING.softJ);
    expect(TUNING.find((e) => e.name === 'RULER_ZONE_TUNING')!.folder).toBe('Ruler › zones');
    expect(TUNING.find((e) => e.name === 'IMPACT_TUNING')!.folder).toBe('Damage rule › world impacts');
    expect(TUNING.find((e) => e.name === 'RULER_TUNING')!.folder).toBe('Ruler');
  });
});
