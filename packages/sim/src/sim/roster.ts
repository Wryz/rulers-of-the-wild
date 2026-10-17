import { BrawlerAI, DEFAULT_AI, type AIConfig } from './ai';
import { Fighter, type FighterOpts, type FighterStyle } from './fighter';
import type { Rng } from './math';
import { ENEMY_MOVES, PLAYER_MOVES } from './moves';

/** The player. `opts`: a world's id counter and rng seed (default: the legacy counter and DungeonStyle's seed). */
export function createPlayer(opts?: FighterOpts): Fighter {
  return new Fighter('player', 'You', PLAYER_MOVES, { maxHp: 100, walkSpeed: 2.6 }, undefined, opts);
}

/** Heavy plodder: wider stance, slower deliberate steps, shoulder rolls, fewer feints. */
export const BRAWLER_STYLE: FighterStyle = {
  footwork: { stanceWidth: 1.12, stepFrames: 12, stepHeight: 0.035 },
  idle: {
    bounceHz: 1.2,
    bounceAmp: 0.016,
    swayAmp: 0.06,
    feintEvery: [1.8, 3.6],
    feintWeights: { jab: 1, shoulder: 4, level: 1, step: 3 },
    shuffleEvery: [1.2, 2.6],
    pawEvery: [1.8, 3.5],
    shoulderRoll: 0.08,
  },
};

export function createBrawler(rng: Rng, cfg: Partial<AIConfig> = {}, opts?: FighterOpts): { fighter: Fighter; ai: BrawlerAI } {
  const fighter = new Fighter('enemy', 'Brawler', ENEMY_MOVES, { maxHp: 70, walkSpeed: 1.9, staggerResist: 0.1 }, BRAWLER_STYLE, opts);
  return { fighter, ai: new BrawlerAI({ ...DEFAULT_AI, ...cfg }, rng) };
}
