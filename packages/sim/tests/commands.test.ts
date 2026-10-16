import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CombatSim } from '../src/sim/combat';
import { type Command, COMMAND_STEPS, CommandQueue, moveCommand, moveVector } from '../src/sim/commands';
import type { Button } from '../src/sim/fighter';
import { createBrawler, createPlayer } from '../src/sim/roster';

function setup() {
  const sim = new CombatSim(11);
  const player = createPlayer();
  const { fighter: enemy, ai } = createBrawler(sim.rng, { blockChance: 0.5 });
  player.pos.set(-1.2, 0, 0);
  player.yaw = Math.PI / 2;
  enemy.pos.set(1.2, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  return { sim, player, enemy };
}

describe('tick-tagged commands', () => {
  it('quantises a walk direction to 1/256 of a turn and its speed to 1/256', () => {
    const out = new Vector3();
    for (let i = 0; i < 100; i++) {
      const a = (i / 100) * Math.PI * 2 + 0.013;
      const s = (i % 10) / 9;
      const c = moveCommand(1, 1, Math.sin(a) * s, Math.cos(a) * s);
      if (c.kind !== 'move') throw new Error('not a move');
      expect(Number.isInteger(c.dir) && c.dir >= 0 && c.dir < COMMAND_STEPS).toBe(true);
      expect(Number.isInteger(c.speed)).toBe(true);
      moveVector(c, out);
      expect(Math.abs(out.length() - s)).toBeLessThanOrEqual(0.5 / COMMAND_STEPS + 1e-9);
      if (s > 0) expect(Math.abs(Math.atan2(Math.sin(Math.atan2(out.x, out.z) - a), Math.cos(Math.atan2(out.x, out.z) - a)))).toBeLessThanOrEqual(Math.PI / COMMAND_STEPS + 1e-9);
    }
  });

  it('holds each command until its tick, then applies it at the start of that tick', () => {
    const { sim, player } = setup();
    const t = sim.frame;
    sim.commands.push(moveCommand(t + 3, player.id, 1, 0));
    sim.step();
    sim.step();
    expect(player.moveInput.length()).toBe(0);
    expect(sim.commands.length).toBe(1);
    sim.step();
    expect(sim.frame).toBe(t + 3);
    expect(player.moveInput.x).toBeCloseTo(1, 9);
    expect(sim.commands.length).toBe(0);
  });

  it('keeps one move per tick while the loop is not stepping', () => {
    const q = new CommandQueue();
    for (let i = 0; i < 1000; i++) q.push(moveCommand(5, 1, 0, i / 1000));
    q.push({ tick: 5, player: 1, kind: 'button', button: 'lpunch' });
    expect(q.length).toBe(2);
    const due = q.take(5);
    expect(due.map((c) => c.kind)).toEqual(['move', 'button']);
  });

  it('plays out exactly like writing the same input straight into the fighter before each tick', async () => {
    // The same scripted input, once as commands and once written directly (the old path).
    const script = (i: number): { x: number; z: number; press?: Button | 'pickup' } => {
      const a = i * 0.05;
      const press: (Button | 'pickup')[] = ['lpunch', 'rpunch', 'lkick', 'rkick', 'pickup'];
      return { x: Math.sin(a) * 0.8, z: Math.cos(a) * 0.8, press: i % 17 === 5 ? press[(i / 17) % 5 | 0] : undefined };
    };
    // DungeonStyle's sim keeps state at module level (a process-wide fighter id counter
    // that seeds each fighter's Rng, and more), so two fights in one process don't match.
    // Each run gets fresh modules, as a fresh process would. (Milestone 1 moves that state
    // into the world.)
    const run = async (viaCommands: boolean) => {
      vi.resetModules();
      const { CombatSim: Sim } = await import('../src/sim/combat');
      const { createBrawler: brawler, createPlayer: player } = await import('../src/sim/roster');
      const cmd = await import('../src/sim/commands');
      const sim = new Sim(11);
      const p = player();
      const { fighter: enemy, ai } = brawler(sim.rng, { blockChance: 0.5 });
      p.pos.set(-1.2, 0, 0);
      p.yaw = Math.PI / 2;
      enemy.pos.set(1.2, 0, 0);
      enemy.yaw = -Math.PI / 2;
      sim.add(p);
      sim.add(enemy, ai);
      const v = new Vector3();
      const trace: unknown[] = [];
      for (let i = 0; i < 600; i++) {
        const s = script(i);
        const move = cmd.moveCommand(sim.frame + 1, p.id, s.x, s.z) as Extract<Command, { kind: 'move' }>;
        if (viaCommands) {
          sim.commands.push(move);
          if (s.press) sim.commands.push({ tick: sim.frame + 1, player: p.id, kind: 'button', button: s.press });
        } else {
          p.moveInput.copy(cmd.moveVector(move, v));
          if (s.press && p.alive) {
            if (s.press !== 'pickup') p.press(s.press);
            else if (p.state !== 'pickup') p.pickupRequest = 12;
          }
        }
        sim.step();
        trace.push(sim.fighters.map((f) => [f.pos.x, f.pos.z, f.yaw, f.hp, f.state, f.stateFrame, f.move?.id ?? null]));
      }
      return { trace, hurt: sim.fighters.some((f) => f.hp < f.stats.maxHp) };
    };
    const direct = await run(false);
    const commands = await run(true);
    expect(commands.trace).toEqual(direct.trace);
    expect(commands.hurt).toBe(true);
  });
});
