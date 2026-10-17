import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  AIM_STEPS,
  aimOf,
  aimVector,
  cloneCommand,
  type Command,
  CommandQueue,
  fromCm,
  type MetaCommand,
  MOVE_CROUCH,
  MOVE_SPRINT,
  moveCommand,
  setTuningCommand,
  toCm,
  type VerbCommand,
  type VerbId,
} from '../src/sim/commands';

const focus = (tick: number, player: number, target: number, at?: [number, number, number]): VerbCommand =>
  at ? { tick, player, kind: 'verb', verb: 'focus', target, at } : { tick, player, kind: 'verb', verb: 'focus', target };

const verb = (tick: number, player: number, v: VerbId, target = 0): VerbCommand => ({ tick, player, kind: 'verb', verb: v, target });

/** A command log with every kind and every optional field, as the client would send it. */
function everyKind(): Command[] {
  return [
    moveCommand(3, 1, 0.3, -0.8),
    moveCommand(3, 2, 0, 0),
    moveCommand(4, 1, -1, 0, MOVE_SPRINT),
    moveCommand(4, 2, 0.2, 0.2, MOVE_CROUCH | MOVE_SPRINT),
    { tick: 3, player: 1, kind: 'button', button: 'lpunch' },
    { tick: 3, player: 1, kind: 'button', button: 'pickup' },
    focus(3, 1, 17, [120, 100, -340]),
    { tick: 3, player: 1, kind: 'verb', verb: 'take', target: 17 },
    { tick: 4, player: 1, kind: 'verb', verb: 'lash', target: 17, second: 18, at: [10, 120, -5], at2: [-12, 118, 0] },
    { tick: 4, player: 1, kind: 'verb', verb: 'bend', target: 21, second: 22, at2: [300, 90, 40] },
    { tick: 4, player: 1, kind: 'verb', verb: 'place', target: 0, at: [250, 30, -75], yaw: 200, pitch: 64, drive: 1 },
    { tick: 4, player: 1, kind: 'verb', verb: 'place', target: 0, at: [250, 30, -75], yaw: 0, pitch: 0, drive: 0 },
    { tick: 5, player: 1, kind: 'verb', verb: 'throw', target: 0, aim: aimOf({ x: 1, y: 0.3, z: -2 }), charge: 255 },
    { tick: 5, player: 1, kind: 'verb', verb: 'pull', target: 0, charge: 0 },
    { tick: 5, player: 1, kind: 'verb', verb: 'shape', target: 9, at: [0, 50, 0], charge: 1 },
    { tick: 5, player: 1, kind: 'verb', verb: 'dig', target: 0, at: toCm({ x: 3.333, y: -0.004, z: -1.005 }), charge: 1 },
    { tick: 5, player: 1, kind: 'verb', verb: 'stow', target: 0, slot: 3 },
    { tick: 5, player: 1, kind: 'verb', verb: 'draw', target: 0, slot: 0 },
    { tick: 5, player: 1, kind: 'verb', verb: 'tie', target: 4, at: [1, 2, 3] },
    { tick: 5, player: 1, kind: 'verb', verb: 'untie', target: 5 },
    { tick: 5, player: 1, kind: 'verb', verb: 'cut', target: 6 },
    { tick: 5, player: 1, kind: 'verb', verb: 'drop', target: 0 },
    { tick: 6, player: 1, kind: 'meta', meta: 'pause' },
    { tick: 6, player: 1, kind: 'meta', meta: 'save' },
    { tick: 6, player: 1, kind: 'meta', meta: 'timeAway', seconds: 86400 },
    { tick: 6, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'spawnApe', args: [1200, -300, 64] } },
    setTuningCommand(6, 1, 'IMPACT_TUNING', 'launchDv', 5.25),
    setTuningCommand(6, 1, 'SPECIES_BODY', 'ape.massShareMode', 'zone'),
    setTuningCommand(6, 1, 'DAMAGE_TUNING', 'hardLandingBluntOnly', false),
  ];
}

/** Every number a command carries is an integer except a setTuning value. */
function integerFields(c: Command): boolean {
  const ints: number[] = [];
  const walk = (v: unknown, skip: boolean) => {
    if (typeof v === 'number') {
      if (!skip) ints.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, skip));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, skip || k === 'tuning');
  };
  walk(c, false);
  return ints.every((n) => Number.isInteger(n) && !Object.is(n, -0));
}

describe('M1 commands', () => {
  it('keeps only the newest move per tick and player', () => {
    const q = new CommandQueue();
    q.push(moveCommand(5, 1, 1, 0));
    q.push(moveCommand(5, 2, 1, 0));
    q.push(moveCommand(6, 1, 1, 0));
    q.push(moveCommand(5, 1, 0, 1, MOVE_SPRINT));
    const moves = q.take(6).filter((c) => c.kind === 'move');
    expect(moves.map((c) => [c.tick, c.player])).toEqual([
      [5, 1],
      [5, 2],
      [6, 1],
    ]);
    expect(moves[0]).toEqual(moveCommand(5, 1, 0, 1, MOVE_SPRINT));
  });

  it('keeps only the newest focus per tick and player, and every other verb and meta in push order', () => {
    const q = new CommandQueue();
    q.push(focus(5, 1, 10));
    q.push(verb(5, 1, 'take', 10));
    q.push(focus(5, 2, 30));
    q.push({ tick: 5, player: 1, kind: 'meta', meta: 'save' });
    q.push(focus(6, 1, 40));
    q.push(verb(5, 1, 'drop'));
    q.push(focus(5, 1, 11, [1, 2, 3]));
    q.push(verb(5, 1, 'take', 11));
    q.push(focus(5, 1, 12));
    const due = q.take(6);
    expect(due.map((c) => (c.kind === 'verb' ? `${c.player}:${c.verb}:${c.target}` : `${c.player}:${c.kind}`))).toEqual([
      '1:take:10',
      '2:focus:30',
      '1:meta',
      '1:focus:40',
      '1:drop:0',
      '1:take:11',
      '1:focus:12',
    ]);
  });

  it('never merges two verbs that are not focus, nor focus across ticks or players', () => {
    const q = new CommandQueue();
    for (let i = 0; i < 3; i++) q.push(verb(5, 1, 'take', 10 + i));
    q.push(focus(5, 1, 1));
    q.push(focus(6, 1, 2));
    q.push(focus(5, 2, 3));
    q.push({ tick: 5, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'pauseMinds', args: [1] } });
    q.push({ tick: 5, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'pauseMinds', args: [0] } });
    expect(q.length).toBe(8);
  });

  it('round-trips a command log through JSON exactly', () => {
    const log = everyKind();
    for (const c of log) expect(integerFields(c)).toBe(true);
    const text = JSON.stringify(log);
    expect(JSON.parse(text)).toEqual(log);
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
  });

  it('passes a command log through the queue and its record unchanged', () => {
    const log = everyKind();
    const q = new CommandQueue();
    for (const c of log) q.push(c);
    const rec = q.toRecord();
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
    const r = new CommandQueue();
    r.restoreRecord(JSON.parse(JSON.stringify(rec)) as Command[]);
    expect(r.toRecord()).toEqual(rec);
    expect(JSON.stringify(r.take(100))).toBe(JSON.stringify(q.take(100)));
  });

  it("copies its record, so changing one doesn't change the queue", () => {
    const q = new CommandQueue();
    q.push({ tick: 4, player: 1, kind: 'verb', verb: 'lash', target: 1, second: 2, at: [1, 2, 3] });
    const rec = q.toRecord();
    (rec[0] as VerbCommand).at![0] = 99;
    rec.push(moveCommand(4, 1, 1, 0));
    expect(q.length).toBe(1);
    expect((q.toRecord()[0] as VerbCommand).at).toEqual([1, 2, 3]);
    const src: Command[] = [{ tick: 4, player: 1, kind: 'meta', meta: 'dev', dev: { op: 'teleport', args: [1, 2] } }];
    q.restoreRecord(src);
    (src[0] as MetaCommand).dev!.args[0] = 7;
    expect((q.toRecord()[0] as MetaCommand).dev!.args).toEqual([1, 2]);
  });

  it('clones commands deeply', () => {
    const c = setTuningCommand(1, 1, 'T', 'a.b', 3);
    const d = cloneCommand(c);
    expect(d).toEqual(c);
    d.dev!.tuning!.value = 4;
    expect(c.dev!.tuning!.value).toBe(3);
  });

  it('writes move flags only when set', () => {
    expect(moveCommand(1, 1, 1, 0)).not.toHaveProperty('flags');
    expect(moveCommand(1, 1, 1, 0, MOVE_CROUCH).flags).toBe(MOVE_CROUCH);
    expect(MOVE_SPRINT & MOVE_CROUCH).toBe(0);
  });

  it('carries world points in whole centimetres', () => {
    const p = { x: 12.3456, y: -0.004, z: -0.0049 };
    const at = toCm(p);
    expect(at).toEqual([1235, 0, 0]);
    expect(at.every((v) => !Object.is(v, -0))).toBe(true);
    const out = fromCm(at, new Vector3());
    expect(out.x).toBeCloseTo(12.35, 12);
    for (let i = 0; i < 200; i++) {
      const q = { x: Math.sin(i) * 80, y: Math.cos(i * 1.3) * 5, z: Math.sin(i * 0.7) * 80 };
      const back = fromCm(toCm(q), new Vector3());
      expect(Math.abs(back.x - q.x)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(back.y - q.y)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(back.z - q.z)).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });

  it('quantises a throw aim to 1/4096 of a turn', () => {
    const out = new Vector3();
    const step = (Math.PI * 2) / AIM_STEPS;
    for (let i = 0; i < 300; i++) {
      const yaw = (i / 300) * Math.PI * 2 - Math.PI + 0.001;
      const pitch = ((i % 37) / 36 - 0.5) * 2.8;
      const dir = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(3);
      const aim = aimOf(dir);
      expect(Number.isInteger(aim[0]) && aim[0] >= 0 && aim[0] < AIM_STEPS).toBe(true);
      expect(Number.isInteger(aim[1]) && Math.abs(aim[1]) <= AIM_STEPS / 4).toBe(true);
      expect(Object.is(aim[1], -0)).toBe(false);
      aimVector(aim, out);
      expect(out.length()).toBeCloseTo(1, 12);
      // Half a step in yaw and half in pitch at most.
      expect(out.angleTo(dir.clone().normalize())).toBeLessThanOrEqual(step + 1e-9);
    }
    expect(aimOf({ x: 0, y: 0, z: 0 })).toEqual([0, 0]);
    expect(aimOf({ x: 0, y: 1, z: 0 })).toEqual([0, AIM_STEPS / 4]);
    expect(aimOf({ x: 1, y: 0, z: 0 })).toEqual([AIM_STEPS / 4, 0]);
  });

  it('builds the dev panel setTuning command', () => {
    expect(setTuningCommand(9, 1, 'RULER_TUNING', 'lockScale', 2.5)).toEqual({
      tick: 9,
      player: 1,
      kind: 'meta',
      meta: 'dev',
      dev: { op: 'setTuning', args: [], tuning: { table: 'RULER_TUNING', key: 'lockScale', value: 2.5 } },
    });
  });

  it('leaves a legacy CombatSim untouched by verb and meta commands', async () => {
    // DS hands out fighter ids from a process-wide counter and seeds each fighter's Rng from its id, so each run gets
    // fresh modules, as a fresh process would (P02a moves ids into the world).
    const run = async (extra: boolean) => {
      vi.resetModules();
      const { CombatSim: Sim } = await import('../src/sim/combat');
      const roster = await import('../src/sim/roster');
      const cmd = await import('../src/sim/commands');
      const sim = new Sim(5);
      const player = roster.createPlayer();
      const { fighter: enemy, ai } = roster.createBrawler(sim.rng, { blockChance: 0.5 });
      player.pos.set(-1.2, 0, 0);
      player.yaw = Math.PI / 2;
      enemy.pos.set(1.2, 0, 0);
      enemy.yaw = -Math.PI / 2;
      sim.add(player);
      sim.add(enemy, ai);
      const trace: unknown[] = [];
      for (let i = 0; i < 240; i++) {
        const t = sim.frame + 1;
        sim.commands.push(cmd.moveCommand(t, player.id, 0.5, 0));
        if (i % 20 === 3) sim.commands.push({ tick: t, player: player.id, kind: 'button', button: 'rpunch' });
        if (extra) {
          sim.commands.push(focus(t, player.id, 3));
          sim.commands.push(verb(t, player.id, 'take', 3));
          sim.commands.push({ tick: t, player: player.id, kind: 'meta', meta: 'save' });
        }
        sim.step();
        expect(sim.commands.length).toBe(0);
        trace.push(sim.fighters.map((f) => [f.pos.x, f.pos.z, f.yaw, f.hp, f.state, f.stateFrame]));
      }
      return { trace, hurt: sim.fighters.some((f) => f.hp < f.stats.maxHp) };
    };
    const plain = await run(false);
    const withVerbs = await run(true);
    expect(withVerbs.trace).toEqual(plain.trace);
    expect(plain.hurt).toBe(true);
  });
});
