import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fistPoint } from '../src/body/skeleton';
import { CombatSim } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import type { Fighter } from '../src/sim/fighter';
import { createPlayer } from '../src/sim/roster';
import { heft, type WeaponId, WEAPONS, weaponTempo } from '../src/sim/weapons';
import { RectWalkable } from '../src/world/collision';

function solo(weapon: WeaponId | null) {
  const sim = new CombatSim(6);
  sim.walkable = new RectWalkable(-40, 40, -40, 40);
  const p = createPlayer();
  p.weapon = weapon ? WEAPONS[weapon] : null;
  p.yaw = Math.PI / 2;
  sim.add(p);
  for (let i = 0; i < 30; i++) sim.step();
  return { sim, p };
}

/** How far up the handle (from the rear hand) the lead hand sits, in metres. */
function leadUpHandle(p: Fighter): number {
  const g = fistPoint(p.rig, 'R', new Vector3());
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  const b = p.pose.blade;
  const dir = new Vector3(b.x * c + b.z * s, b.y, -b.x * s + b.z * c).normalize();
  return fistPoint(p.rig, 'L', new Vector3()).sub(g).dot(dir) / p.scale;
}

describe('heavy weapons', () => {
  it('an axe is held choked up — lead hand by the head — and swung with the hands slid together', () => {
    const sim = new CombatSim(4);
    const p = createPlayer();
    p.weapon = WEAPONS.axe;
    p.yaw = Math.PI / 2;
    p.autoDefense = false;
    const { fighter: e, ai } = createEnemy('brawler', sim.rng);
    ai.cfg.passive = true;
    e.pos.set(2.2, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(p);
    sim.add(e, ai);
    for (let i = 0; i < 40; i++) sim.step();
    expect(leadUpHandle(p)).toBeGreaterThan(0.25);
    p.startMove(p.moveDef('overhead')!);
    const m = p.move!;
    for (let i = 0; i < m.startup - 1; i++) sim.step();
    expect(leadUpHandle(p)).toBeLessThan(0.16);
  });

  it('carrying something heavy slows you down', () => {
    const speed = (w: WeaponId | null) => {
      const { sim, p } = solo(w);
      const x0 = p.pos.x;
      for (let i = 0; i < 120; i++) {
        p.moveInput.set(1, 0, 0);
        sim.step();
      }
      return p.pos.x - x0;
    };
    const bare = speed(null);
    const sledge = speed('sledgehammer');
    expect(sledge).toBeLessThan(bare * 0.9);
    expect(speed('machete')).toBeGreaterThan(sledge);
  });

  it('holding a heavy weapon, you get your breath back slower', () => {
    const regen = (w: WeaponId | null) => {
      const { sim, p } = solo(w);
      p.stamina = 0.3;
      for (let i = 0; i < 120; i++) sim.step();
      return p.stamina - 0.3;
    };
    expect(regen('sledgehammer')).toBeLessThan(regen(null) * 0.85);
  });

  it('heavy is relative to who holds it: a giant swings an axe like you swing a light weapon', () => {
    const giant = createEnemy('minotaur', new CombatSim(1).rng).fighter;
    expect(heft(WEAPONS.axe, 1)).toBeGreaterThan(2);
    expect(heft(WEAPONS.axe, giant.scale)).toBeLessThan(1);
    expect(weaponTempo(WEAPONS.axe, 1)).toBeGreaterThan(weaponTempo(WEAPONS.axe, giant.scale));
    expect(weaponTempo(WEAPONS.sledgehammer, 1)).toBeGreaterThan(weaponTempo(WEAPONS.machete, 1) * 1.4);
  });
});
