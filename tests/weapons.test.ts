import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fistPoint } from '../src/body/skeleton';
import { moveLength } from '../src/sim/moves';
import { BLEED_DPS, type CombatEvent, CombatSim } from '../src/sim/combat';
import { createEnemy } from '../src/sim/enemies';
import { type Fighter } from '../src/sim/fighter';
import { createBrawler, createPlayer } from '../src/sim/roster';
import { bladePoints, GORE, WEAPON_MOVES, type WeaponId, WEAPONS } from '../src/sim/weapons';
import { RectWalkable } from '../src/world/collision';

function duel(weapon: WeaponId | null, dist: number) {
  const sim = new CombatSim(3);
  sim.walkable = new RectWalkable(-50, 50, -50, 50);
  const player = createPlayer();
  player.weapon = weapon ? WEAPONS[weapon] : null;
  player.autoDefense = false;
  const { fighter: enemy, ai } = createBrawler(sim.rng, { passive: true, blockChance: 0 });
  player.yaw = Math.PI / 2;
  enemy.pos.set(dist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  for (let i = 0; i < 30; i++) sim.step();
  player.pos.set(0, 0, 0);
  enemy.pos.set(dist, 0, 0);
  return { sim, player, enemy };
}

function swing(sim: CombatSim, f: Fighter, id: string, frames = 45): CombatEvent[] {
  f.startMove(WEAPON_MOVES[id], false, 'head');
  const out: CombatEvent[] = [];
  for (let i = 0; i < frames; i++) out.push(...sim.step());
  return out;
}

const hits = (ev: CombatEvent[]) => ev.filter((e) => e.type === 'hit') as Extract<CombatEvent, { type: 'hit' }>[];

describe('weapons', () => {
  it('every technique connects at its fighting range', () => {
    for (const [w, ids, d] of [
      ['machete', ['slash', 'backslash', 'chop'], 1.4],
      ['axe', ['sweep', 'sweepBack', 'overhead'], 1.7],
    ] as const) {
      for (const id of ids) {
        const { sim, player } = duel(w, d);
        expect(hits(swing(sim, player, id)).length, `${w} ${id}`).toBe(1);
      }
    }
  });

  it('a weapon outreaches a fist', () => {
    const { sim, player } = duel('machete', 1.85);
    expect(hits(swing(sim, player, 'chop')).length).toBe(1);
    const unarmed = duel(null, 1.85);
    unarmed.player.press('rpunch');
    const ev: CombatEvent[] = [];
    for (let i = 0; i < 40; i++) ev.push(...unarmed.sim.step());
    expect(hits(ev).length).toBe(0);
  });

  it('edges leave lasting cuts that keep bleeding; blunt weapons do not cut', () => {
    const { sim, player, enemy } = duel('machete', 1.4);
    const [h] = hits(swing(sim, player, 'slash'));
    expect(h.wound).not.toBeNull();
    expect(enemy.wounds.length).toBe(1);
    const hp = enemy.hp;
    for (let i = 0; i < 300; i++) sim.step();
    // Five seconds later: still bleeding, health drained by it.
    expect(enemy.wounds[0].bleed).toBeGreaterThan(0.1);
    expect(enemy.hp).toBeLessThan(hp - BLEED_DPS * enemy.wounds[0].floor * 4);
    const blunt = duel('bat', 1.7);
    const [b] = hits(swing(blunt.sim, blunt.player, 'sweep'));
    expect(b.wound).toBeNull();
    expect(blunt.enemy.wounds.length).toBe(0);
  });

  it('a level cut through the neck takes the head off, and that ends the fight', () => {
    const { sim, player, enemy } = duel('axe', 1.8);
    enemy.limbDamage.head = 30;
    const [h] = hits(swing(sim, player, 'sweep'));
    expect(h.bone).toBe('head');
    expect(h.sever).toBe('head');
    expect(h.fatal).toBeNull();
    expect(enemy.alive).toBe(false);
    expect(enemy.isSevered('head')).toBe(true);
  });

  it('chopped straight down onto the crown, the head splits instead of coming off — and nobody survives it', () => {
    for (const [w, fatal] of [['axe', 'split'], ['katana', 'cleft'], ['sledgehammer', 'crush']] as const) {
      const { sim, player, enemy } = duel(w, 1.8);
      enemy.limbDamage.head = 999;
      expect(enemy.hp).toBe(enemy.stats.maxHp);
      const [h] = hits(swing(sim, player, 'overhead'));
      expect(h.bone, w).toBe('head');
      expect(h.fatal, w).toBe(fatal);
      expect(h.sever, w).toBeNull();
      expect(enemy.alive, w).toBe(false);
      expect(enemy.isSevered('head'), w).toBe(false);
    }
    // The same goes for you.
    const sim = new CombatSim(5);
    sim.walkable = new RectWalkable(-50, 50, -50, 50);
    const player = createPlayer();
    player.autoDefense = false;
    const { fighter: e, ai } = createBrawler(sim.rng, { passive: true });
    e.weapon = WEAPONS.axe;
    player.yaw = Math.PI / 2;
    e.pos.set(1.8, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(player);
    sim.add(e, ai);
    for (let i = 0; i < 20; i++) sim.step();
    const [h] = hits(swing(sim, e, 'overhead'));
    expect(h.fatal).toBe('split');
    expect(player.alive).toBe(false);
  });

  it('a glancing edge takes a piece with it — an ear only comes off once', () => {
    const { sim, player, enemy } = duel('axe', 1.7);
    const hit = (sim as unknown as { hit: (...a: unknown[]) => void }).hit.bind(sim);
    const torn: string[] = [];
    for (let i = 0; i < 12; i++) {
      enemy.hp = enemy.stats.maxHp;
      enemy.enterLocomotion(1);
      // Down past the left side of the head.
      const side = enemy.rig.head.pos.clone().add(new Vector3(0, 0.15, 0.14));
      hit(player, enemy, WEAPON_MOVES.overhead, side, new Vector3(1, 0, 0), 'head', 'head', 1, false, WEAPONS.axe, new Vector3(0, -1, 0));
      const ev = sim.events.filter((e) => e.type === 'hit').at(-1) as Extract<CombatEvent, { type: 'hit' }>;
      if (ev?.tear) torn.push(ev.tear.piece);
    }
    expect(torn.filter((p) => p === 'earL').length).toBe(1);
    expect(enemy.torn.has('earL')).toBe(true);
  });

  it('only weapons that really could do it split, cleave or crush a skull, take limbs or heads off, or slice pieces away', () => {
    // The table itself: nothing blunt cuts anything off, and only real mass crushes.
    for (const w of Object.values(WEAPONS)) {
      const g = GORE[w.id];
      if (w.edge === 'blunt') {
        expect(g.sever, w.id).toBe('none');
        expect(g.decap, w.id).toBe(false);
        expect(g.tear, w.id).toBe(false);
        expect([null, 'crush'], w.id).toContain(g.crown);
        if (g.crown) expect(w.mass, w.id).toBeGreaterThanOrEqual(2.5);
      } else {
        expect(g.crown, w.id).not.toBe('crush');
        if (g.decap || g.sever === 'all') expect(w.mass, w.id).toBeGreaterThanOrEqual(1);
        // Halving a skull takes a heavy weapon; a light blade (a katana) cuts deep instead.
        if (g.crown === 'split') expect(w.mass, w.id).toBeGreaterThanOrEqual(2.5);
      }
    }
    expect(GORE.pipe).toEqual({ crown: null, sever: 'none', decap: false, tear: false });
    expect(GORE.katana.crown).toBe('cleft');

    // And in a fight: the same blows with each weapon, at the same places.
    type Hit = Extract<CombatEvent, { type: 'hit' }>;
    const blow = (id: WeaponId, at: 'crown' | 'neck' | 'thigh' | 'forearm') => {
      const { sim, player, enemy } = duel(id, 1.6);
      for (const k of Object.keys(enemy.limbDamage)) delete enemy.limbDamage[k as keyof typeof enemy.limbDamage];
      for (const b of ['head', 'thighL', 'foreArmL'] as const) enemy.limbDamage[b] = 999;
      const r = enemy.rig;
      const point = at === 'crown' ? r.head.pos.clone().add(new Vector3(0, 0.27, 0))
        : at === 'neck' ? r.head.pos.clone().add(new Vector3(-0.1, 0.03, 0))
        : at === 'thigh' ? r.thighL.pos.clone().add(new Vector3(-0.08, -0.2, 0))
        : r.foreArmL.pos.clone().add(new Vector3(-0.05, -0.1, 0));
      const bone = at === 'crown' || at === 'neck' ? 'head' : at === 'thigh' ? 'thighL' : 'foreArmL';
      const swing = at === 'crown' ? new Vector3(0, -1, 0) : new Vector3(0, 0, 1);
      const hit = (sim as unknown as { hit: (...a: unknown[]) => void }).hit.bind(sim);
      hit(player, enemy, WEAPON_MOVES.chop, point, new Vector3(1, 0, 0), at === 'thigh' ? 'legs' : 'head', bone, 1, false, WEAPONS[id], swing);
      return sim.events.filter((e) => e.type === 'hit').at(-1) as Hit;
    };
    for (const w of Object.values(WEAPONS)) {
      const g = GORE[w.id];
      expect(blow(w.id, 'crown').fatal, `${w.id} crown`).toBe(g.crown);
      expect(blow(w.id, 'neck').sever, `${w.id} neck`).toBe(g.decap ? 'head' : null);
      expect(blow(w.id, 'thigh').sever, `${w.id} thigh`).toBe(g.sever === 'all' ? 'thighL' : null);
      expect(blow(w.id, 'forearm').sever, `${w.id} forearm`).toBe(g.sever !== 'none' ? 'foreArmL' : null);
      if (!g.tear) for (const at of ['crown', 'neck', 'thigh'] as const) expect(blow(w.id, at).tear, `${w.id} ${at} tear`).toBeNull();
    }
  });

  it('a heavy weapon swung right hits like nothing else — and gets its head on them even when they crowd in', () => {
    const land = (id: WeaponId, move: string, dist: number) => {
      const { sim, player, enemy } = duel(id, dist);
      enemy.minHp = 1;
      const [h] = hits(swing(sim, player, move, 70));
      return h;
    };
    const axe = land('axe', 'overhead', 1.8);
    const machete = land('machete', 'chop', 1.4);
    expect(axe.weapon?.id).toBe('axe');
    expect(axe.damage).toBeGreaterThan(40);
    expect(axe.damage).toBeGreaterThan(machete.damage * 3);
    // Crowded at point-blank range: it gives ground winding up, so it's still the head
    // of the axe that lands, not the haft.
    const close = land('axe', 'overhead', 1.0);
    expect(close.weapon?.id).toBe('axe');
    expect(close.damage).toBeGreaterThan(40);
    // Even taken on the guard, it costs far more of it than a light weapon's chop.
    const guardCost = (id: WeaponId, move: string) => {
      const { sim, player, enemy } = duel(id, 1.6);
      const block = (sim as unknown as { block: (...a: unknown[]) => void }).block.bind(sim);
      const g0 = enemy.guard;
      block(player, enemy, WEAPON_MOVES[move], enemy.rig.chest.pos.clone(), new Vector3(1, 0, 0));
      return g0 - enemy.guard;
    };
    expect(guardCost('sledgehammer', 'overhead')).toBeGreaterThan(WEAPON_MOVES.overhead.guardDamage * 1.4);
  });

  it('losing an arm takes its strikes away and drops the weapon', () => {
    const sim = new CombatSim(4);
    const { fighter: e } = createEnemy('brawler', sim.rng);
    e.weapon = WEAPONS.machete;
    sim.add(e);
    (sim as unknown as { sever(f: Fighter, b: string): void }).sever(e, 'foreArmR');
    expect(e.weapon).toBeNull();
    expect(sim.drops.length).toBe(1);
    expect(e.canUse(e.moves.straight)).toBe(false);
    expect(e.wounds.some((w) => w.stump === 'foreArmR')).toBe(true);
  });

  it('your own limbs only come off with the blow that finishes you', () => {
    const sim = new CombatSim(5);
    sim.walkable = new RectWalkable(-50, 50, -50, 50);
    const player = createPlayer();
    player.autoDefense = false;
    const { fighter: e, ai } = createBrawler(sim.rng, { passive: true });
    e.weapon = WEAPONS.axe;
    player.yaw = Math.PI / 2;
    e.pos.set(1.8, 0, 0);
    e.yaw = -Math.PI / 2;
    sim.add(player);
    sim.add(e, ai);
    for (let i = 0; i < 20; i++) sim.step();
    player.limbDamage.head = 999;
    player.limbDamage.upperArmL = 999;
    e.startMove(WEAPON_MOVES.sweep, false, 'body');
    for (let i = 0; i < 45; i++) sim.step();
    expect(player.hp).toBeGreaterThan(0);
    expect(player.severed.size).toBe(0);
  });

  it('picks up, swaps and drops weapons (bending down for them takes time)', () => {
    const { sim, player } = duel(null, 4);
    sim.addDrop(WEAPONS.machete, 0.4, 0);
    sim.addDrop(WEAPONS.bat, -0.5, 0.2);
    const pick = () => {
      player.pickupRequest = 10;
      sim.step();
      let n = 1;
      while (!player.free && n < 200) {
        sim.step();
        n++;
      }
      return n;
    };
    player.pickupRequest = 10;
    sim.step();
    // Not in hand the instant you reach for it.
    expect(player.state).toBe('pickup');
    expect(player.weapon).toBeNull();
    while (!player.free) sim.step();
    expect(player.weapon?.id).toBe('machete');
    pick();
    expect(player.weapon?.id).toBe('bat');
    expect(sim.drops.map((d) => d.weapon.id)).toEqual(['machete']);
    player.pos.set(5, 0, 5);
    player.pickupRequest = 10;
    sim.step();
    expect(player.weapon).toBeNull();
    expect(sim.drops.length).toBe(2);
    void pick;
  });

  it('a heavy weapon takes longer to get up off the floor than a light one', () => {
    const time = (id: 'machete' | 'axe' | 'sledgehammer') => {
      const { sim, player } = duel(null, 4);
      sim.addDrop(WEAPONS[id], 0.4, 0);
      player.pickupRequest = 10;
      sim.step();
      let n = 1;
      while (!player.free && n < 200) {
        sim.step();
        n++;
      }
      expect(player.weapon?.id).toBe(id);
      return n;
    };
    const machete = time('machete');
    const axe = time('axe');
    const sledge = time('sledgehammer');
    expect(axe).toBeGreaterThan(machete + 8);
    expect(sledge).toBeGreaterThan(axe + 8);
  });

  it("caught while bending down for a weapon, you don't get it", () => {
    const { sim, player, enemy } = duel(null, 1.3);
    player.autoDefense = false;
    sim.addDrop(WEAPONS.axe, 0.2, 0.5);
    // (Bent over, the head is down out of the way of a straight: it's the body that's open.)
    enemy.startMove(enemy.moves.body);
    for (let i = 0; i < 8; i++) sim.step();
    player.pickupRequest = 10;
    sim.step();
    expect(player.state).toBe('pickup');
    let hit = false;
    for (let i = 0; i < 60; i++) for (const e of sim.step()) if (e.type === 'hit' && e.defender === player) hit = true;
    expect(hit).toBe(true);
    expect(player.weapon).toBeNull();
    expect(sim.drops.length).toBe(1);
  });

  it('pressing pickup again while bending down does not throw the new weapon away', () => {
    for (const held of [null, 'bat'] as const) {
      const { sim, player } = duel(held, 4);
      sim.addDrop(WEAPONS.machete, 0.4, 0);
      player.pickupRequest = 12;
      sim.step();
      expect(player.state).toBe('pickup');
      const events: string[] = [];
      // Impatient: a press every few frames all the way down and up.
      for (let i = 0; i < 80; i++) {
        if (player.state === 'pickup' && i % 4 === 0) player.pickupRequest = 12;
        for (const e of sim.step()) if (e.type === 'pickup' || e.type === 'drop') events.push(e.type);
      }
      expect(player.weapon?.id).toBe('machete');
      expect(events.filter((e) => e === 'pickup').length).toBe(1);
    }
  });

  it('with the left forearm gone, a reach for a weapon skips the two-handers for one it can hold', () => {
    const { sim, player } = duel(null, 4);
    (sim as unknown as { sever(f: Fighter, b: string): void }).sever(player, 'foreArmL');
    player.state = 'idle';
    for (let i = 0; i < 30; i++) sim.step();
    sim.addDrop(WEAPONS.axe, 0.3, 0);
    sim.addDrop(WEAPONS.machete, 0.8, 0);
    player.pickupRequest = 12;
    for (let i = 0; i < 120; i++) sim.step();
    expect(player.weapon?.id).toBe('machete');
  });

  it('shoved out of reach mid-squat, the hand closes on nothing', () => {
    const { sim, player } = duel(null, 4);
    sim.addDrop(WEAPONS.axe, 0.4, 0);
    player.pickupRequest = 12;
    sim.step();
    expect(player.state).toBe('pickup');
    for (let i = 0; i < 4; i++) sim.step();
    player.pos.set(-1.2, 0, 0);
    for (let i = 0; i < 2; i++) sim.step();
    player.pos.set(-1.2, 0, 0);
    while (player.state === 'pickup') sim.step();
    expect(player.weapon).toBeNull();
    expect(sim.drops.length).toBe(1);
  });

  it('armed buttons: Q is the quick strike, E the heavy one', () => {
    for (const [w, light, heavy] of [['machete', 'slash', 'chop'], ['gladius', 'thrust', 'slash'], ['bat', 'sweep', 'overhead']] as const) {
      const { sim, player } = duel(w, 3);
      player.press('lpunch');
      sim.step();
      expect(player.move?.id).toBe(light);
      for (let i = 0; i < 80; i++) sim.step();
      player.press('rpunch');
      sim.step();
      expect(player.move?.id).toBe(heavy);
    }
  });

  it('enemies go and grab weapons lying nearby, then fight with them', () => {
    const sim = new CombatSim(6);
    sim.walkable = new RectWalkable(-50, 50, -50, 50);
    const player = createPlayer();
    const { fighter: e, ai } = createBrawler(sim.rng, { blockChance: 0 });
    player.pos.set(-3, 0, 0);
    e.pos.set(1, 0, 0);
    sim.add(player);
    sim.add(e, ai);
    sim.addDrop(WEAPONS.machete, 2.5, 1);
    let used = false;
    for (let i = 0; i < 900 && !used; i++) {
      sim.step();
      if (e.move?.weapon) used = true;
    }
    expect(e.weapon?.id).toBe('machete');
    expect(used).toBe(true);
  });

  it('bosses come armed', () => {
    const sim = new CombatSim(7);
    expect(createEnemy('minotaur', sim.rng).fighter.weapon?.id).toBe('axe');
    expect(createEnemy('cyclops', sim.rng).fighter.weapon?.id).toBe('club');
    expect(createEnemy('champion', sim.rng).fighter.weapon).toBeNull();
  });
});

describe('strikes stop at the body', () => {
  it('an edge bites in and stays put until it is wrenched free', () => {
    const { sim, player } = duel('cleaver', 1.3);
    player.startMove(WEAPON_MOVES.hack, false, 'head');
    let tipAtHit: number[] | null = null;
    let drift = 0;
    for (let i = 0; i < 40; i++) {
      const ev = sim.step();
      const tip = bladePoints(player, player.weapon!).at(-1)!;
      if (hits(ev).length) tipAtHit = tip.toArray();
      else if (tipAtHit && player.state === 'attack' && player.stateFrame < player.stuckUntil) drift = Math.max(drift, tip.distanceTo(new Vector3(...tipAtHit)));
    }
    expect(tipAtHit).not.toBeNull();
    // Held in the wound (only the body's own sway moves it).
    expect(drift).toBeLessThan(0.04);
    expect(player.state).not.toBe('attack');
  });

  it('a punch stops at the face instead of driving through it', () => {
    const { sim, player, enemy } = duel(null, 1.0);
    player.press('lpunch');
    let reachAtHit = 0;
    let deepest = 0;
    for (let i = 0; i < 30; i++) {
      const ev = sim.step();
      const fist = fistPoint(player.rig, 'L', new Vector3());
      const r = fist.x - player.pos.x;
      if (hits(ev).length) reachAtHit = r;
      else if (reachAtHit) deepest = Math.max(deepest, r - reachAtHit);
    }
    expect(reachAtHit).toBeGreaterThan(0);
    expect(deepest).toBeLessThan(0.05);
    expect(enemy.hp).toBeLessThan(enemy.stats.maxHp);
  });

  it('a miss carries all the way through', () => {
    const { sim, player } = duel('machete', 2.8);
    player.startMove(WEAPON_MOVES.slash);
    let frames = 0;
    while (player.state === 'attack' && frames < 80) {
      sim.step();
      frames++;
    }
    expect(player.attackEnd).toBe(0);
    expect(frames).toBeGreaterThanOrEqual(moveLength(WEAPON_MOVES.slash) - 1);
  });

  it('only a blow that cuts clean through follows through', () => {
    const { sim, player, enemy } = duel('axe', 1.8);
    enemy.limbDamage.head = 30;
    const [h] = hits(swing(sim, player, 'sweep', 30));
    expect(h.sever).toBe('head');
    expect(player.attackEnd).toBe(0);
  });

  it('too close for the edge, with no room to back off: the haft knocks, it does not cut', () => {
    // (Whatever the opponent's hands happen to be doing at the time.)
    for (let n = 0; n < 6; n++) {
      const { sim, player, enemy } = duel('axe', 0.85);
      // Back to the wall: nowhere to give ground.
      sim.walkable = new RectWalkable(-0.2, 50, -50, 50);
      const [h] = hits(swing(sim, player, 'sweep'));
      expect(h).toBeDefined();
      expect(h.weapon).toBeNull();
      expect(h.wound).toBeNull();
      expect(enemy.wounds.length).toBe(0);
    }
  });
});
