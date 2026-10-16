import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bonePoint, fistPoint, SKELETON } from '../src/body/skeleton';
import { CombatSim } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import { timed } from '../src/sim/fighter';
import { ENEMY_MOVES, PLAYER_MOVES } from '../src/sim/moves';
import { createPlayer } from '../src/sim/roster';
import { WEAPONS } from '../src/sim/weapons';
import { ArenaWalkable, RectWalkable } from '../src/world/collision';

describe('fighting logic', () => {
  it('two different moves that share a name keep their own timing', () => {
    // The player's hook and an enemy's haymaker are both 'hook'.
    const haymaker = timed(ENEMY_MOVES.hook, 1.2);
    const hook = timed(PLAYER_MOVES.hook, 1.2);
    expect(haymaker.name).not.toBe(hook.name);
    expect(hook.startup).toBe(Math.round(PLAYER_MOVES.hook.startup * 1.2));
  });

  it('an armed giant swings its axe rather than throwing leg sweeps', () => {
    const sim = new CombatSim(4);
    const player = createPlayer();
    player.minHp = 1;
    const { fighter: boss, ai } = createEnemy('minotaur', sim.rng);
    boss.weapon = WEAPONS.axe;
    player.pos.set(0, 0, 0);
    boss.pos.set(2.5, 0, 0);
    sim.add(player);
    sim.add(boss, ai);
    const thrown: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      player.pos.set(0, 0, 0);
      for (const e of sim.step()) if (e.type === 'swing' && e.f === boss) thrown[e.move.name] = (thrown[e.move.name] ?? 0) + 1;
    }
    expect(thrown['Leg Sweep'] ?? 0).toBe(0);
    expect(Object.entries(thrown).filter(([n]) => n !== 'Leg Sweep').length).toBeGreaterThan(0);
  });

  it('walks round a crate to get at you instead of pressing into it', () => {
    const sim = new CombatSim(6);
    sim.walkable = new ArenaWalkable({ kind: 'rect', hx: 8, hz: 8 }, [{ kind: 'box', x: 0, z: 0, hx: 0.4, hz: 2, h: 1.2 }]);
    const player = createPlayer();
    player.minHp = 1;
    const { fighter: e, ai } = createEnemy('brawler', sim.rng);
    player.pos.set(-1.2, 0, 0);
    player.yaw = Math.PI / 2;
    e.pos.set(1.6, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(player);
    sim.add(e, ai);
    let swung = -1;
    for (let i = 0; i < 60 * 15 && swung < 0; i++) {
      player.pos.set(-1.2, 0, 0);
      for (const ev of sim.step()) if (ev.type === 'swing' && ev.f === e) swung = i;
    }
    expect(swung).toBeGreaterThan(0);
    expect(swung).toBeLessThan(60 * 10);
  });

  it("doesn't try to block what a guard can't stop (a kick to the thigh)", () => {
    const sim = new CombatSim(7);
    const player = createPlayer();
    const { fighter: e, ai } = createEnemy('brawler', sim.rng, {}, { blockChance: 1 });
    player.pos.set(0, 0, 0);
    player.yaw = Math.PI / 2;
    e.pos.set(1.3, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(player);
    sim.add(e, ai);
    for (let i = 0; i < 20; i++) sim.step();
    player.startMove(player.moves.lowKick);
    let blocked = false;
    for (let i = 0; i < 30; i++) {
      sim.step();
      if (e.state === 'defend' && e.defense?.def.kind === 'block') blocked = true;
    }
    expect(blocked).toBe(false);
  });

  it('with no arms left an enemy can neither block nor punch — it kicks', () => {
    const sim = new CombatSim(8);
    const player = createPlayer();
    player.minHp = 1;
    const { fighter: e, ai } = createEnemy('rookie', sim.rng, {}, { blockChance: 1 });
    for (const b of ['foreArmL', 'foreArmR'] as const) e.severed.add(b);
    player.pos.set(0, 0, 0);
    e.pos.set(1.4, 0, 0);
    sim.add(player);
    sim.add(e, ai);
    let blocks = 0;
    let swings = 0;
    for (let i = 0; i < 60 * 20; i++) {
      player.pos.set(0, 0, 0);
      if (i % 50 === 0 && player.free) player.startMove(player.moves.jab);
      for (const ev of sim.step()) {
        if (ev.type === 'block' && ev.defender === e) blocks++;
        if (ev.type === 'swing' && ev.f === e) swings++;
      }
    }
    expect(blocks).toBe(0);
    expect(swings).toBeGreaterThan(0);
  });
});

describe('animation', () => {
  const runner = (weapon?: keyof typeof WEAPONS) => {
    const sim = new CombatSim(5);
    sim.walkable = new RectWalkable(-8, 8, -8, 8);
    const p = createPlayer();
    p.yaw = Math.PI / 2;
    if (weapon) p.weapon = WEAPONS[weapon];
    sim.add(p);
    for (let i = 0; i < 30; i++) sim.step();
    return { sim, p };
  };

  it("an arm pumping against a wall never flips round its own axis", () => {
    const { sim, p } = runner();
    let worst = 0;
    const prev = { L: p.rig.upperArmL.rot.clone(), R: p.rig.upperArmR.rot.clone() };
    for (let i = 0; i < 300; i++) {
      p.moveInput.set(1, 0, 0);
      sim.step();
      for (const s of ['L', 'R'] as const) {
        const q = p.rig[s === 'L' ? 'upperArmL' : 'upperArmR'].rot;
        worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(q.dot(prev[s])))));
        prev[s].copy(q);
      }
    }
    expect(worst).toBeLessThan(0.7);
  });

  it('breaking into a run, the hips stay over the body instead of lurching ahead', () => {
    const { sim, p } = runner();
    let worst = 0;
    for (let i = 0; i < 90; i++) {
      p.moveInput.set(1, 0, 0);
      sim.step();
      worst = Math.max(worst, Math.hypot(p.rig.pelvis.pos.x - p.pos.x, p.rig.pelvis.pos.z - p.pos.z));
    }
    expect(worst).toBeLessThan(0.3);
  });

  it("running with a two-hander, the lead hand stays on the haft", () => {
    const { sim, p } = runner('axe');
    let worst = 0;
    for (let i = 0; i < 150; i++) {
      p.moveInput.set(1, 0, 0.3);
      sim.step();
      if (i < 20) continue;
      const g = fistPoint(p.rig, 'R', new Vector3());
      const c = Math.cos(p.yaw);
      const sn = Math.sin(p.yaw);
      const b = p.pose.blade;
      const dir = new Vector3(b.x * c + b.z * sn, b.y, -b.x * sn + b.z * c).normalize();
      const hand = fistPoint(p.rig, 'L', new Vector3()).sub(g);
      const along = Math.max(-0.45, Math.min(p.weapon!.length, hand.dot(dir)));
      worst = Math.max(worst, hand.sub(dir.multiplyScalar(along)).length());
    }
    expect(worst).toBeLessThan(0.07);
  });

  it("rocked by a blow mid-run, the planted feet don't glide across the floor", () => {
    const { sim, p } = runner();
    for (let i = 0; i < 40; i++) {
      p.moveInput.set(1, 0, 0);
      sim.step();
    }
    p.moveInput.set(0, 0, 0);
    p.enterHitstun(30, 'hitHookL', 1);
    let slide = 0;
    const last = { L: new Vector3(), R: new Vector3() };
    for (let i = 0; i < 28; i++) {
      const was = { L: p.footwork.L.stepping, R: p.footwork.R.stepping };
      sim.step();
      for (const s of ['L', 'R'] as const) {
        const ank = bonePoint(p.rig, s === 'L' ? 'shinL' : 'shinR', SKELETON.shinL.length, new Vector3()).setY(0);
        if (i > 0 && !was[s] && !p.footwork.foot(s).stepping) slide = Math.max(slide, ank.distanceTo(last[s]));
        last[s].copy(ank);
      }
    }
    expect(slide).toBeLessThan(0.01);
  });

  it('no strike drives a fist or foot faster than a person can (one-frame spikes)', () => {
    const peaks: [string, number][] = [];
    for (const m of [...Object.values(PLAYER_MOVES), ...Object.values(ENEMY_MOVES)]) {
      const sim = new CombatSim(3);
      const p = createPlayer();
      p.autoDefense = false;
      sim.add(p);
      for (let i = 0; i < 30; i++) sim.step();
      p.startMove(m);
      const at = () =>
        m.limb === 'handL' ? fistPoint(p.rig, 'L', new Vector3()) : m.limb === 'handR' ? fistPoint(p.rig, 'R', new Vector3()) : bonePoint(p.rig, m.limb === 'footL' ? 'shinL' : 'shinR', SKELETON.shinL.length, new Vector3());
      let prev = at();
      let peak = 0;
      for (let i = 0; i < m.startup + m.active; i++) {
        sim.step();
        const q = at();
        peak = Math.max(peak, q.distanceTo(prev) * 60);
        prev = q;
      }
      peaks.push([m.id, peak]);
    }
    const worst = peaks.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(worst[1], worst[0]).toBeLessThan(32);
  });
});
