import { describe, expect, it } from 'vitest';
import { CombatSim, type CombatEvent } from '../src/sim/combat';
import type { Fighter } from '../src/sim/fighter';
import { createBrawler, createPlayer } from '../src/sim/roster';
import { selectPlayerMove } from '../src/sim/select';
import { ENEMY_MOVES } from '../src/sim/moves';

function setup(dist = 1.0, aiCfg = { passive: true, blockChance: 0 }) {
  const sim = new CombatSim(3);
  const player = createPlayer();
  const { fighter: enemy, ai } = createBrawler(sim.rng, aiCfg);
  player.pos.set(0, 0, 0);
  player.yaw = Math.PI / 2; // facing +X
  enemy.pos.set(dist, 0, 0);
  enemy.yaw = -Math.PI / 2;
  sim.add(player);
  sim.add(enemy, ai);
  return { sim, player, enemy };
}

function run(sim: CombatSim, frames: number, onFrame?: (ev: CombatEvent[], i: number) => void): CombatEvent[] {
  const all: CombatEvent[] = [];
  for (let i = 0; i < frames; i++) {
    const ev = sim.step();
    all.push(...ev);
    onFrame?.(ev, i);
  }
  return all;
}

const hits = (ev: CombatEvent[], defender: Fighter) =>
  ev.filter((e): e is Extract<CombatEvent, { type: 'hit' }> => e.type === 'hit' && e.defender === defender);

describe('move selection', () => {
  const ctx = (dist: number, counter: null | 'duck' | 'weave' | 'slide' | 'block' = null, chainFrom: string | null = null) => ({ dist, counter, chainFrom });
  it('picks moves per button from range', () => {
    expect(selectPlayerMove('lpunch', ctx(1.0))).toBe('jab');
    expect(selectPlayerMove('lpunch', ctx(2.0))).toBe('gazelle');
    expect(selectPlayerMove('rpunch', ctx(1.0))).toBe('cross');
    expect(selectPlayerMove('lkick', ctx(1.0))).toBe('frontKick');
    expect(selectPlayerMove('lkick', ctx(3.0))).toBe('flyingKick');
    expect(selectPlayerMove('rkick', ctx(1.0))).toBe('lowKick');
    expect(selectPlayerMove('rkick', ctx(2.2))).toBe('slideKick');
  });
  it('picks counters per button', () => {
    expect(selectPlayerMove('rpunch', ctx(1.0, 'duck'))).toBe('uppercut');
    expect(selectPlayerMove('lpunch', ctx(1.0, 'duck'))).toBe('counterHook');
    expect(selectPlayerMove('lpunch', ctx(1.0, 'weave'))).toBe('counterHook');
    expect(selectPlayerMove('rpunch', ctx(1.0, 'weave'))).toBe('counterCross');
    expect(selectPlayerMove('lkick', ctx(1.0, 'slide'))).toBe('slideKick');
  });
  it('chains per button', () => {
    expect(selectPlayerMove('rpunch', ctx(1.0, null, 'jab'))).toBe('cross');
    expect(selectPlayerMove('lpunch', ctx(1.0, null, 'jab'))).toBe('jab');
    expect(selectPlayerMove('lpunch', ctx(1.0, null, 'cross'))).toBe('hook');
    expect(selectPlayerMove('rkick', ctx(1.0, null, 'hook'))).toBe('lowKick');
  });
});

describe('offense', () => {
  it('jab lands on an idle dummy in range', () => {
    const { sim, player, enemy } = setup(1.0);
    run(sim, 2);
    player.press('lpunch');
    const ev = run(sim, 25);
    const h = hits(ev, enemy);
    expect(h.length).toBe(1);
    expect(h[0].move.id).toBe('jab');
    expect(enemy.hp).toBeLessThan(enemy.stats.maxHp);
  });

  it('jab whiffs out of range', () => {
    const { sim, player, enemy } = setup(1.45);
    // Force a jab rather than letting context pick the gazelle punch.
    run(sim, 1);
    player.startMove(player.moves.jab);
    const ev = run(sim, 25);
    expect(hits(ev, enemy).length).toBe(0);
  });

  it('chains jab -> cross -> hook with left, right, left', () => {
    const { sim, player } = setup(0.95);
    run(sim, 2);
    const used: string[] = [];
    const seq = ['lpunch', 'rpunch', 'lpunch'] as const;
    let next = 0;
    player.press(seq[next++]);
    run(sim, 80, (ev, i) => {
      for (const e of ev) if (e.type === 'attackStart' && e.f === player) used.push(e.move.id);
      if (i % 7 === 0 && next < seq.length && used.length === next) player.press(seq[next++]);
    });
    expect(used.slice(0, 3)).toEqual(['jab', 'cross', 'hook']);
  });

  it('gazelle punch closes distance and lands', () => {
    const { sim, player, enemy } = setup(2.1);
    run(sim, 1);
    player.press('lpunch');
    const ev = run(sim, 40);
    const h = hits(ev, enemy);
    expect(h.map((e) => e.move.id)).toEqual(['gazelle']);
  });

  it('flying kick from far knocks down', () => {
    const { sim, player, enemy } = setup(3.2);
    run(sim, 1);
    player.press('lkick');
    const ev = run(sim, 50);
    const h = hits(ev, enemy);
    expect(h.map((e) => e.move.id)).toEqual(['flyingKick']);
    expect(h[0].knockdown).toBe(true);
  });
});

describe('automatic defense', () => {
  function enemyAttack(id: string, dist = 1.05) {
    const s = setup(dist);
    run(s.sim, 2);
    s.enemy.startMove(s.enemy.moves[id], false, 'head');
    return s;
  }

  it('ducks a haymaker, then the counter punch is an uppercut that knocks down', () => {
    const { sim, player, enemy } = enemyAttack('hook');
    const defended: string[] = [];
    const ev = run(sim, 34, (e) => {
      for (const x of e) if (x.type === 'defend') defended.push(x.kind);
    });
    expect(defended).toEqual(['duck']);
    expect(hits(ev, player).length).toBe(0);
    expect(player.counter?.kind).toBe('duck');
    player.press('rpunch');
    const ev2 = run(sim, 25);
    const h = hits(ev2, enemy);
    expect(h.map((e) => e.move.id)).toEqual(['uppercut']);
    expect(h[0].knockdown).toBe(true);
  });

  it('weaves a straight', () => {
    const { sim, player } = enemyAttack('straight');
    const ev = run(sim, 30);
    expect(ev.some((e) => e.type === 'defend' && e.kind === 'weave')).toBe(true);
    expect(hits(ev, player).length).toBe(0);
    expect(ev.some((e) => e.type === 'dodge')).toBe(true);
  });

  it('blocks a body blow and loses guard', () => {
    const { sim, player } = enemyAttack('body');
    const ev = run(sim, 30);
    expect(ev.some((e) => e.type === 'block')).toBe(true);
    expect(hits(ev, player).length).toBe(0);
    expect(player.guard).toBeLessThan(player.stats.maxGuard);
  });

  it('slides away from a sweep', () => {
    const { sim, player } = enemyAttack('sweep');
    const ev = run(sim, 40);
    expect(ev.some((e) => e.type === 'defend' && e.kind === 'slide')).toBe(true);
    expect(hits(ev, player).length).toBe(0);
  });

  it('a committed player gets hit', () => {
    const { sim, player } = enemyAttack('straight');
    // Wait until the straight is about to land, then throw a slow kick.
    run(sim, 14);
    player.startMove(player.moves.frontKick);
    const ev = run(sim, 20);
    expect(hits(ev, player).length).toBe(1);
  });

  it('jab does not interrupt an armored haymaker', () => {
    const { sim, player, enemy } = enemyAttack('hook', 0.95);
    run(sim, 10);
    player.startMove(player.moves.jab, false, 'head');
    const ev = run(sim, 30);
    const onEnemy = hits(ev, enemy);
    expect(onEnemy.length).toBe(1);
    expect(onEnemy[0].armored).toBe(true);
    expect(hits(ev, player).length).toBe(1);
  });
});

describe('full fight smoke test', () => {
  it('runs a long AI fight without NaNs', () => {
    const { sim, player, enemy } = setup(2, { passive: false, blockChance: 0.3 });
    let presses = 0;
    run(sim, 60 * 40, (_e, i) => {
      if (i % 23 === 0) {
        player.press((['lpunch', 'rpunch', 'lkick', 'rkick'] as const)[presses % 4]);
        presses++;
      }
      player.moveInput.set(enemy.pos.x - player.pos.x, 0, enemy.pos.z - player.pos.z).normalize().multiplyScalar(0.5);
    });
    expect(presses).toBeGreaterThan(50);
    for (const f of [player, enemy]) {
      expect(Number.isFinite(f.pos.x)).toBe(true);
      expect(Number.isFinite(f.hp)).toBe(true);
    }
  });
});

describe('Q / E as a strike lands: parry', () => {
  const meet = (move: string, pressAt: number | null, button: 'lpunch' | 'rkick' = 'lpunch') => {
    const { sim, player: p, enemy: e } = setup(1.0);
    p.autoDefense = false;
    p.minHp = 1;
    e.startMove(ENEMY_MOVES[move]);
    let ev: CombatEvent[] = [];
    let pressed = false;
    for (let i = 0; i < 60; i++) {
      if (pressAt !== null && !pressed && e.state === 'attack' && e.framesToActive <= pressAt) {
        p.press(button);
        pressed = true;
      }
      ev = ev.concat(sim.step());
    }
    const blocks = ev.filter((x): x is Extract<CombatEvent, { type: 'block' }> => x.type === 'block' && x.defender === p);
    const dodges = ev.filter((x): x is Extract<CombatEvent, { type: 'dodge' }> => x.type === 'dodge' && x.defender === p);
    return { p, e, ev, blocks, dodges };
  };

  it('timed to the last instant, a punch is parried perfectly: the attacker is knocked off balance and the counter is yours', () => {
    const r = meet('straight', 5);
    expect(r.blocks[0]?.parry).toBe(true);
    expect(r.blocks[0]?.perfect).toBe(true);
    expect(hits(r.ev, r.p).length).toBe(0);
    expect(r.e.state === 'hitstun' || r.e.state === 'idle' || r.e.state === 'walk').toBe(true);
    // (No punch thrown: the press met the strike instead.)
    expect(r.ev.some((x) => x.type === 'attackStart' && x.f === r.p)).toBe(false);
  });

  it('pressed early it only blocks; a big swing it slides you out of instead; no strike coming, it attacks; kicks stay kicks', () => {
    const early = meet('straight', 12);
    expect(early.blocks.length).toBe(1);
    expect(early.blocks[0].parry).toBe(false);
    const big = meet('haymaker', 6);
    expect(hits(big.ev, big.p).length).toBe(0);
    expect(big.dodges[0]?.perfect).toBe(true);
    const none = meet('haymaker', null);
    expect(hits(none.ev, none.p).length).toBeGreaterThan(0);
    const { sim, player } = setup(3);
    player.press('lpunch');
    const ev = run(sim, 3);
    expect(ev.some((x) => x.type === 'attackStart' && x.f === player)).toBe(true);
    const kick = meet('straight', 5, 'rkick');
    expect(kick.blocks.length).toBe(0);
  });
});

describe('skills', () => {
  const takeHaymaker = (setupP: (p: Fighter) => void) => {
    const { sim, player: p, enemy: e } = setup(1.0);
    p.autoDefense = false;
    setupP(p);
    e.startMove(ENEMY_MOVES.haymaker);
    return { p, ev: run(sim, 60) };
  };

  it('Last Stand: the blow that would knock you out leaves you on 1 health, once', () => {
    const { p, ev } = takeHaymaker((f) => {
      f.perks.add('lastStand');
      f.hp = 2;
    });
    expect(p.alive).toBe(true);
    expect(p.hp).toBe(1);
    expect(ev.some((x) => x.type === 'perk' && x.perk === 'lastStand')).toBe(true);
    const none = takeHaymaker((f) => (f.hp = 2));
    expect(none.p.alive).toBe(false);
  });

  it('Second Wind: knocked under a quarter of your health, a third of it comes back', () => {
    const { p, ev } = takeHaymaker((f) => {
      f.perks.add('secondWind');
      f.hp = 0.3 * f.stats.maxHp;
    });
    expect(ev.some((x) => x.type === 'perk' && x.perk === 'secondWind')).toBe(true);
    expect(p.hp).toBeGreaterThan(0.4 * p.stats.maxHp);
  });

  it('Perfect Timing: a parry a little late still counts', () => {
    const late = (perk: boolean) => {
      const { sim, player: p, enemy: e } = setup(1.0);
      p.autoDefense = false;
      p.minHp = 1;
      if (perk) p.perks.add('perfectTiming');
      e.startMove(ENEMY_MOVES.straight);
      let pressed = false;
      const ev: CombatEvent[] = [];
      for (let i = 0; i < 50; i++) {
        if (!pressed && e.state === 'attack' && e.framesToActive <= 10) {
          p.press('lpunch');
          pressed = true;
        }
        ev.push(...sim.step());
      }
      return ev.find((x): x is Extract<CombatEvent, { type: 'block' }> => x.type === 'block' && x.defender === p);
    };
    expect(late(false)?.parry).toBe(false);
    expect(late(true)?.perfect).toBe(true);
  });
});
