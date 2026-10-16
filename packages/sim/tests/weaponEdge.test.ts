import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { WeaponEdge } from '../src/body/weaponEdge';
import { CombatSim } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import { createPlayer } from '../src/sim/roster';
import { WEAPONS } from '../src/sim/weapons';
import { RectWalkable } from '../src/world/collision';

/** Player with an axe and a (passive) opponent; the edge model updated every step. */
function setup(dist = 2.2) {
  const sim = new CombatSim(4);
  sim.walkable = new RectWalkable(-20, 20, -20, 20);
  const p = createPlayer();
  p.weapon = WEAPONS.axe;
  p.yaw = Math.PI / 2;
  p.autoDefense = false;
  const { fighter: e, ai } = createEnemy('brawler', sim.rng);
  ai.cfg.passive = true;
  e.autoDefense = false;
  e.pos.set(dist, 0, 0);
  e.yaw = -Math.PI / 2;
  sim.add(p);
  sim.add(e, ai);
  const edge = new WeaponEdge();
  let worstTwist = 0;
  const prev = new Vector3();
  const step = () => {
    sim.step();
    const b = p.pose.blade.clone().normalize();
    const had = edge.edge.lengthSq() > 0;
    // Where the old edge ends up just carried along with the haft...
    const carried = prev.clone().addScaledVector(b, -prev.dot(b));
    const e = edge.update(p, 1).clone();
    // ...vs where it is now: any difference is the head twisting round the haft.
    if (had && carried.lengthSq() > 1e-6) worstTwist = Math.max(worstTwist, carried.normalize().angleTo(e));
    prev.copy(e);
    return { b, e };
  };
  return { sim, p, edge, step, twist: () => worstTwist };
}

/** How far the head's flat faces tilt off vertical (0 = head upright). */
const tilt = (b: Vector3, e: Vector3) => Math.abs(new Vector3().crossVectors(b, e).normalize().y);

describe('a heavy axe head', () => {
  it('hangs upright at rest and when walking', () => {
    const { p, step } = setup(5);
    let worst = 0;
    for (let i = 0; i < 180; i++) {
      p.moveInput.set(i < 60 ? 0 : 0.8, 0, i < 120 ? 0 : 0.6);
      const { b, e } = step();
      if (i > 30 && Math.abs(b.y) < 0.9) worst = Math.max(worst, tilt(b, e));
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('stays upright through an overhead chop, edge leading', () => {
    const { p, step } = setup();
    for (let i = 0; i < 40; i++) step();
    p.startMove(p.moveDef('overhead')!, false, 'head');
    const m = p.move!;
    let worstTilt = 0;
    let lead = 1;
    let last = p.pose.blade.clone();
    for (let i = 0; i < m.startup + 2; i++) {
      const { b, e } = step();
      // Through the downswing (the head coming over and down).
      if (p.stateFrame > m.startup * 0.7 && p.stateFrame <= m.startup && Math.abs(b.y) < 0.9) {
        worstTilt = Math.max(worstTilt, tilt(b, e));
        const motion = b.clone().sub(last);
        if (motion.length() > 0.02) lead = Math.min(lead, motion.normalize().dot(e));
      }
      last = b.clone();
    }
    // Upright give or take the slight diagonal of a re-aimed chop (~25 degrees).
    expect(worstTilt).toBeLessThan(0.42);
    expect(lead).toBeGreaterThan(0.3);
  });

  it('turns level for a sweep (edge leading sideways), never flapping round the haft', () => {
    const { p, step, twist } = setup();
    for (let i = 0; i < 40; i++) step();
    p.startMove(p.moveDef('sweep')!, false, 'head');
    const m = p.move!;
    let lead = 1;
    let last = p.pose.blade.clone();
    for (let i = 0; i < m.startup + m.active + m.recovery + 30; i++) {
      const { b, e } = step();
      if (p.state === 'attack' && p.stateFrame > m.startup * 0.8 && p.stateFrame <= m.startup && !p.attackEnd) {
        const motion = b.clone().sub(last);
        if (motion.length() > 0.02) lead = Math.min(lead, motion.normalize().dot(e));
      }
      last = b.clone();
    }
    expect(lead).toBeGreaterThan(0.3);
    // A 2-3 kg head can't be spun round the haft in a frame.
    expect(twist()).toBeLessThan(0.1);
  });

  it('after any amount of fighting, at a render rate that skips steps, the head settles back upright', () => {
    const { sim, p, edge } = setup(1.8);
    let worstRest = 0;
    let i = 0;
    while (i < 900) {
      // A render frame covers one to three sim steps.
      const n = 1 + (i % 3);
      for (let k = 0; k < n; k++, i++) {
        if (i < 600 && i % 70 === 10 && p.free) p.startMove(p.moveDef(i % 140 === 10 ? 'sweep' : 'overhead')!);
        p.moveInput.set(i < 600 ? Math.sin(i / 40) : 0, 0, i < 600 ? Math.cos(i / 55) : 0);
        sim.step();
      }
      const e = edge.update(p, n);
      const b = p.pose.blade.clone().normalize();
      if (i > 700 && Math.abs(b.y) < 0.9) worstRest = Math.max(worstRest, tilt(b, e));
    }
    expect(p.state).not.toBe('attack');
    expect(worstRest).toBeLessThan(0.2);
  });
});
