import { describe, expect, it } from 'vitest';
import { makeProfile, targetProfile, zoneWeights } from '../src/body/motion';
import { CombatSim } from '../src/sim/combat';
import { createBrawler, createPlayer } from '../src/sim/roster';

const inputs = (dist: number, extra: Partial<Parameters<typeof targetProfile>[0]> = {}) => ({
  dist,
  hpFrac: 1,
  guardFrac: 1,
  framesSinceHit: 999,
  threat: false,
  opponentDown: false,
  pressing: false,
  ...extra,
});

describe('contextual motion profile', () => {
  it('blends distance zones', () => {
    expect(zoneWeights(0.9).pocket).toBe(1);
    expect(zoneWeights(1.8).striking).toBe(1);
    expect(zoneWeights(3.2).outside).toBe(1);
    expect(zoneWeights(7).roaming).toBe(1);
    const w = zoneWeights(1.3);
    expect(w.pocket).toBeGreaterThan(0);
    expect(w.striking).toBeGreaterThan(0);
  });

  it('takes long strides far away and short ones in the pocket', () => {
    const far = makeProfile();
    const close = makeProfile();
    targetProfile(inputs(7), far);
    targetProfile(inputs(0.9), close);
    expect(far.stride).toBeGreaterThan(2 * close.stride);
    expect(far.speed).toBeGreaterThan(close.speed);
    expect(far.guardY).toBeLessThan(close.guardY); // hands relaxed lower when far
  });

  it('reacts to being hurt and to incoming strikes', () => {
    const fresh = makeProfile();
    const hurt = makeProfile();
    const threatened = makeProfile();
    targetProfile(inputs(1.8), fresh);
    targetProfile(inputs(1.8, { hpFrac: 0.15 }), hurt);
    targetProfile(inputs(1.8, { threat: true }), threatened);
    expect(hurt.bounce).toBeLessThan(fresh.bounce * 0.6);
    expect(hurt.speed).toBeLessThan(fresh.speed);
    expect(hurt.guardY).toBeLessThan(fresh.guardY);
    expect(threatened.bounce).toBeLessThan(fresh.bounce * 0.3);
    expect(threatened.feints).toBe(0);
  });
});

describe('contextual footwork in the sim', () => {
  function strideLengths(startDist: number, dir: 1 | -1, frames: number) {
    const sim = new CombatSim(4);
    const p = createPlayer();
    const { fighter: e, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
    p.pos.set(0, 0, 0);
    p.yaw = Math.PI / 2;
    e.pos.set(startDist, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(p);
    sim.add(e, ai);
    for (let i = 0; i < 90; i++) sim.step(); // let the profile settle
    const lens: number[] = [];
    const was = { L: false, R: false };
    const from = { L: p.footwork.L.pos.clone(), R: p.footwork.R.pos.clone() };
    for (let i = 0; i < frames; i++) {
      p.moveInput.set(dir, 0, 0);
      sim.step();
      for (const s of ['L', 'R'] as const) {
        const f = p.footwork.foot(s);
        if (f.stepping && !was[s]) from[s].copy(f.from);
        if (!f.stepping && was[s]) lens.push(f.pos.distanceTo(from[s]));
        was[s] = f.stepping;
      }
    }
    return lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  }

  it('strides out when far, shuffles when close', () => {
    expect(strideLengths(12, 1, 60)).toBeGreaterThan(strideLengths(1.6, 1, 30) * 1.5);
  });

  it('retreats with shorter steps than it advances', () => {
    expect(strideLengths(1.8, -1, 40)).toBeLessThan(strideLengths(1.8, 1, 20));
  });
});
