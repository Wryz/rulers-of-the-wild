import { type WeaponId, WEAPONS } from './weapons';
import { type AIConfig, type AIPlan, BRAWLER_PLAN, BrawlerAI, DEFAULT_AI } from './ai';
import { Fighter, type FighterStats, type FighterStyle } from './fighter';
import type { Rng } from './math';
import { ENEMY_MOVES } from './moves';
import { BRAWLER_STYLE } from './roster';

export type EnemyKind =
  | 'rookie'
  | 'brawler'
  | 'kicker'
  | 'bruiser'
  | 'samurai'
  | 'ninja'
  | 'imp'
  | 'demon'
  | 'champion'
  | 'minotaur'
  | 'cyclops'
  | 'boxer'
  | 'nakmuay'
  | 'wrestler'
  | 'capoeira'
  | 'duelist'
  | 'berserker'
  | 'knifeFighter'
  | 'monk'
  | 'sumo'
  | 'troll';

export const BOSSES: EnemyKind[] = ['champion', 'minotaur', 'cyclops', 'troll'];

export interface Archetype {
  kind: EnemyKind;
  name: string;
  stats: Partial<FighterStats>;
  style: FighterStyle;
  plan: AIPlan;
  ai: Partial<AIConfig>;
  /** Coins dropped on KO [min, max] before round bonuses. */
  coins: [number, number];
  /** Body size (giant bosses > 1, small creatures < 1). */
  scale?: number;
  boss?: boolean;
  /** Comes armed. */
  weapon?: WeaponId;
  /** Carries throwing weapons on the belt. */
  ammo?: { weapon: WeaponId; count: number };
  /** How well it reads what's coming and gets out of the way (1 = as well as you). */
  read: number;
}

const LIGHT_STYLE: FighterStyle = {
  footwork: { stanceWidth: 0.95, stepFrames: 9, stepHeight: 0.045 },
  idle: {
    bounceHz: 2,
    bounceAmp: 0.03,
    swayAmp: 0.04,
    feintEvery: [2, 4],
    feintWeights: { jab: 3, shoulder: 1, level: 1, step: 2 },
    shuffleEvery: [0.7, 1.5],
    pawEvery: [1, 2],
    shoulderRoll: 0,
  },
};

const KICKER_STYLE: FighterStyle = {
  // Muay Thai: tall, square-ish stance, slow deliberate rhythm, lots of stepping.
  footwork: { stanceWidth: 1.05, stepFrames: 11, stepHeight: 0.06 },
  idle: {
    bounceHz: 1.3,
    bounceAmp: 0.02,
    swayAmp: 0.05,
    feintEvery: [1.6, 3.2],
    feintWeights: { jab: 1, shoulder: 1, level: 1, step: 4 },
    shuffleEvery: [0.6, 1.3],
    pawEvery: [0.9, 2],
    shoulderRoll: 0.03,
  },
};

const HEAVY_STYLE: FighterStyle = {
  footwork: { stanceWidth: 1.2, stepFrames: 14, stepHeight: 0.03 },
  idle: {
    bounceHz: 0.8,
    bounceAmp: 0.01,
    swayAmp: 0.05,
    feintEvery: [4, 7],
    feintWeights: { jab: 0, shoulder: 3, level: 0, step: 2 },
    shuffleEvery: [1.6, 3],
    pawEvery: [3, 5],
    shoulderRoll: 0.1,
  },
};

const SAMURAI_STYLE: FighterStyle = {
  // Settled and still: low, steady, no bouncing, sliding steps.
  footwork: { stanceWidth: 1.1, stepFrames: 13, stepHeight: 0.02 },
  idle: {
    bounceHz: 0.5,
    bounceAmp: 0.006,
    swayAmp: 0.015,
    feintEvery: [3.5, 6],
    feintWeights: { jab: 0, shoulder: 1, level: 2, step: 3 },
    shuffleEvery: [1.2, 2.4],
    pawEvery: [6, 9],
    shoulderRoll: 0,
  },
};

export const ARCHETYPES = {
  rookie: {
    kind: 'rookie',
    read: 0.4,
    name: 'Rookie',
    stats: { maxHp: 45, walkSpeed: 2.1 },
    style: LIGHT_STYLE,
    // Sloppy: pawing jabs, a wild haymaker when he's been hurt, and he backs off
    // flinching after every one he takes.
    plan: {
      moves: [
        ['rookieJab', 40],
        ['straight', 25],
        ['body', 15],
        ['haymaker', 12],
      ],
      range: 1.05,
      attackRange: 1.35,
      punish: 'rookieJab',
      chains: { rookieJab: 'straight' },
      temper: 'sloppy',
      specials: [{ move: 'haymaker', min: 0.6, max: 1.4, rate: 0.05, cooldown: 200, when: 'afterHit' }],
    },
    ai: { blockChance: 0.15, aggression: 1.1 },
    coins: [4, 7],
  },
  brawler: {
    kind: 'brawler',
    read: 0.55,
    name: 'Brawler',
    stats: { maxHp: 70, walkSpeed: 1.9, staggerResist: 0.1 },
    style: BRAWLER_STYLE,
    // Street fighter: walks you down, picks up whatever's lying around — and throws it.
    plan: {
      ...BRAWLER_PLAN,
      moves: [...BRAWLER_PLAN.moves, ['quickJab', 18]],
      counters: ['quickJab'],
      temper: 'pressure',
      specials: [
        { move: 'throwOne', min: 2.5, max: 9, rate: 0.05, cooldown: 420, weapons: ['bottle', 'pan', 'cleaver', 'crowbar', 'pipe', 'machete', 'kunai'] },
      ],
    },
    ai: {},
    coins: [7, 11],
  },
  kicker: {
    kind: 'kicker',
    read: 0.65,
    name: 'Kicker',
    stats: { maxHp: 60, walkSpeed: 2.0 },
    style: KICKER_STYLE,
    plan: {
      moves: [
        ['teep', 30],
        ['kLowKick', 30],
        ['roundhouse', 25],
        ['straight', 15],
      ],
      range: 1.15,
      attackRange: 1.45,
      punish: 'teep',
      chains: { kLowKick: 'straight' },
      counters: ['quickJab'],
      temper: 'pressure',
      // Taekwondo off the back foot: a spinning back kick in close, a jumping kick to
      // close the distance.
      specials: [
        { move: 'spinBackKick', min: 0.6, max: 1.2, rate: 0.02, cooldown: 240 },
        { move: 'jumpKick', min: 1.5, max: 2.3, rate: 0.02, cooldown: 300 },
      ],
    },
    ai: { blockChance: 0.25 },
    coins: [8, 12],
  },
  bruiser: {
    kind: 'bruiser',
    read: 0.5,
    name: 'Bruiser',
    stats: { maxHp: 120, walkSpeed: 1.5, staggerResist: 0.4, defense: 0.15 },
    style: HEAVY_STYLE,
    plan: {
      moves: [
        ['bruiserHook', 35],
        ['bruiserBody', 35],
        ['sweep', 15],
      ],
      range: 1.0,
      attackRange: 1.25,
      punish: 'bruiserBody',
      chains: {},
      temper: 'pressure',
      // A wall of a man: runs you over with his shoulder, stamps on your feet.
      specials: [
        { move: 'shoulderCharge', min: 1.9, max: 3.6, rate: 0.025, cooldown: 360 },
        { move: 'stomp', min: 0.5, max: 1.1, rate: 0.012, cooldown: 300 },
      ],
    },
    ai: { blockChance: 0.4, aggression: 0.8, stringChance: 0 },
    coins: [16, 24],
  },
  samurai: {
    kind: 'samurai',
    read: 0.95,
    name: 'Samurai',
    weapon: 'katana',
    stats: { maxHp: 90, walkSpeed: 1.9, staggerResist: 0.45 },
    style: SAMURAI_STYLE,
    // Waits just out of reach, sword up. Step in and he's already cutting; miss and the
    // draw cut answers before you've recovered.
    plan: {
      moves: [['straight', 30], ['body', 25], ['teep', 25]],
      range: 1.05,
      attackRange: 1.35,
      punish: 'straight',
      chains: {},
      counters: ['quickJab'],
      temper: 'patient',
      armed: [
        { weapons: ['katana', 'bokken'], moves: [['kesa', 3], ['menCut', 2], ['tsuki', 2], ['iai', 1]], punish: 'tsuki' },
        { weapons: ['machete', 'gladius', 'ninjato', 'pipe', 'crowbar'], moves: [['slash', 3], ['thrust', 2], ['chop', 1]], punish: 'thrust' },
      ],
      specials: [
        { move: 'iai', min: 0, max: 1.8, rate: 0.12, cooldown: 160, when: 'targetWhiffed', weapons: ['katana', 'bokken'] },
        { move: 'kesa', min: 0, max: 1.7, rate: 0.3, cooldown: 120, when: 'targetEntered', weapons: ['katana', 'bokken'] },
        { move: 'tsuki', min: 1.5, max: 2.2, rate: 0.012, cooldown: 220, weapons: ['katana', 'bokken'] },
      ],
    },
    ai: { blockChance: 0.5, aggression: 1, stringChance: 0 },
    coins: [14, 20],
  },
  ninja: {
    kind: 'ninja',
    read: 0.85,
    name: 'Ninja',
    weapon: 'ninjato',
    ammo: { weapon: 'kunai', count: 5 },
    stats: { maxHp: 62, walkSpeed: 2.6 },
    style: LIGHT_STYLE,
    // Never where you want him: knives from range, a dash or a flip to get in, a cut, and
    // gone again — flipping away from anything that comes his way.
    plan: {
      moves: [['rookieJab', 30], ['teep', 30], ['kLowKick', 25]],
      range: 1.1,
      attackRange: 1.4,
      punish: 'rookieJab',
      chains: {},
      counters: ['quickJab'],
      temper: 'skirmish',
      armed: [{ weapons: ['ninjato', 'katana', 'machete', 'gladius', 'cleaver', 'kunai'], moves: [['slash', 3], ['thrust', 2], ['dashSlash', 1]] }],
      specials: [
        { move: 'backflip', min: 0, max: 1.4, rate: 0.3, cooldown: 140, when: 'targetAttacking' },
        { move: 'backflip', min: 0, max: 1.3, rate: 0.2, cooldown: 140, when: 'afterHit' },
        { move: 'kunaiThrow', min: 2.2, max: 9, rate: 0.09, cooldown: 70, when: 'hasAmmo' },
        { move: 'dashSlash', min: 2.2, max: 3.1, rate: 0.03, cooldown: 200, when: 'armed' },
        { move: 'flipSlash', min: 1.9, max: 2.6, rate: 0.02, cooldown: 280, when: 'armed' },
        { move: 'frontFlipKick', min: 1.9, max: 2.6, rate: 0.015, cooldown: 300, when: 'unarmed' },
      ],
    },
    ai: { blockChance: 0.2, aggression: 1.15 },
    coins: [14, 20],
  },
} as unknown as Record<EnemyKind, Archetype>; // creatures and bosses are added below

const BOSS_STYLE: FighterStyle = {
  footwork: { stanceWidth: 1.15, stepFrames: 15, stepHeight: 0.035 },
  idle: {
    bounceHz: 0.7,
    bounceAmp: 0.012,
    swayAmp: 0.06,
    feintEvery: [3, 6],
    feintWeights: { jab: 1, shoulder: 3, level: 0, step: 3 },
    shuffleEvery: [1.4, 2.8],
    pawEvery: [2.5, 4.5],
    shoulderRoll: 0.12,
  },
};

Object.assign(ARCHETYPES, {
  imp: {
    kind: 'imp',
    read: 0.6,
    name: 'Imp',
    stats: { maxHp: 34, walkSpeed: 2.7 },
    style: LIGHT_STYLE,
    // An acrobat: darts in and out, flips away from trouble and comes over the top with a
    // heel.
    plan: {
      moves: [['rookieJab', 40], ['body', 25], ['teep', 20]],
      range: 1.05,
      attackRange: 1.35,
      punish: 'rookieJab',
      chains: { rookieJab: 'body' },
      temper: 'skirmish',
      specials: [
        { move: 'backflip', min: 0, max: 1.4, rate: 0.15, cooldown: 180, when: 'targetAttacking' },
        { move: 'frontFlipKick', min: 1.8, max: 2.6, rate: 0.025, cooldown: 260 },
      ],
    },
    ai: { blockChance: 0.1, aggression: 1.35 },
    coins: [5, 8],
    scale: 0.72,
  },
  demon: {
    kind: 'demon',
    read: 0.7,
    name: 'Demon',
    stats: { maxHp: 95, walkSpeed: 2.2, staggerResist: 0.25 },
    style: KICKER_STYLE,
    // A predator: in for a flurry, back out to circle, then leaps on you from out of reach.
    plan: {
      moves: [['hook', 30], ['straight', 20], ['roundhouse', 25], ['bruiserBody', 20]],
      range: 1.1,
      attackRange: 1.4,
      punish: 'straight',
      chains: { straight: 'hookChain' },
      counters: ['quickJab'],
      temper: 'skirmish',
      specials: [
        { move: 'pounce', min: 1.8, max: 3.6, rate: 0.08, cooldown: 280 },
        { move: 'spinBackKick', min: 0.6, max: 1.2, rate: 0.012, cooldown: 300 },
      ],
    },
    ai: { blockChance: 0.3, aggression: 1.15 },
    coins: [14, 20],
    scale: 1.12,
  },
  champion: {
    kind: 'champion',
    read: 0.9,
    name: 'The Champion',
    stats: { maxHp: 260, walkSpeed: 1.7, staggerResist: 0.6, defense: 0.15 },
    style: BRAWLER_STYLE,
    // A pro: combinations, and the superman punch to cover distance.
    plan: {
      moves: [['quickJab', 30], ['straight', 25], ['hook', 25], ['body', 25], ['bruiserHook', 12]],
      range: 1.05,
      attackRange: 1.3,
      punish: 'straight',
      chains: { straight: 'hookChain', quickJab: 'straight' },
      counters: ['quickJab'],
      temper: 'pressure',
      specials: [{ move: 'superman', min: 0.8, max: 2.0, rate: 0.04, cooldown: 260 }],
    },
    ai: { blockChance: 0.45, aggression: 1 },
    coins: [60, 80],
    scale: 1.6,
    boss: true,
  },
  minotaur: {
    kind: 'minotaur',
    read: 0.55,
    name: 'The Minotaur',
    weapon: 'axe',
    stats: { maxHp: 320, walkSpeed: 1.6, staggerResist: 0.7, defense: 0.2 },
    style: BOSS_STYLE,
    // A berserker: the axe goes round in full circles, gets hurled at you from across
    // the arena (then he charges in after it, head down), and he never backs off.
    plan: {
      moves: [['bruiserHook', 30], ['bruiserBody', 30], ['sweep', 20], ['teep', 20]],
      range: 1.0,
      attackRange: 1.3,
      punish: 'bruiserBody',
      chains: {},
      temper: 'berserk',
      armed: [{ weapons: ['axe', 'fireaxe', 'club', 'sledgehammer', 'bat'], moves: [['sweep', 3], ['overhead', 2], ['sweepBack', 1]] }],
      specials: [
        { move: 'spinCleave', min: 0.9, max: 1.35, rate: 0.02, cooldown: 240, weapons: ['axe', 'fireaxe', 'club', 'sledgehammer'] },
        { move: 'throwHeavy', min: 2.1, max: 5, rate: 0.04, cooldown: 900, weapons: ['axe', 'fireaxe'] },
        { move: 'shoulderCharge', min: 1.6, max: 3.4, rate: 0.03, cooldown: 280, when: 'unarmed' },
      ],
    },
    ai: { blockChance: 0.25, aggression: 1.05, stringChance: 0 },
    coins: [80, 110],
    scale: 1.75,
    boss: true,
  },
  cyclops: {
    kind: 'cyclops',
    read: 0.45,
    name: 'The Cyclops',
    weapon: 'club',
    stats: { maxHp: 380, walkSpeed: 1.35, staggerResist: 0.75, defense: 0.25 },
    style: BOSS_STYLE,
    // A giant: slow, huge sweeps and pounding overheads with the club, and that foot.
    plan: {
      moves: [['bruiserHook', 35], ['sweep', 25], ['bruiserBody', 25], ['roundhouse', 15]],
      range: 1.0,
      attackRange: 1.3,
      punish: 'bruiserBody',
      chains: {},
      temper: 'pressure',
      armed: [{ moves: [['sweep', 3], ['overhead', 3]] }],
      specials: [
        { move: 'stomp', min: 0.3, max: 0.9, rate: 0.03, cooldown: 220 },
        { move: 'spinCleave', min: 0.9, max: 1.3, rate: 0.01, cooldown: 420, weapons: ['club', 'axe', 'fireaxe', 'sledgehammer'] },
        { move: 'throwHeavy', min: 2.1, max: 5, rate: 0.006, cooldown: 1200, weapons: ['club'] },
      ],
    },
    ai: { blockChance: 0.2, aggression: 0.95, stringChance: 0 },
    coins: [100, 140],
    scale: 1.85,
    boss: true,
  },
} satisfies Partial<Record<EnemyKind, Archetype>>);

// ---- The second wave: ten more fighters, each with a way of fighting all its own ----

const BOXER_STYLE: FighterStyle = {
  // Up on the toes, bouncing, rolling the shoulders, head never still.
  footwork: { stanceWidth: 0.9, stepFrames: 8, stepHeight: 0.05 },
  idle: {
    bounceHz: 2.4,
    bounceAmp: 0.035,
    swayAmp: 0.07,
    feintEvery: [1.2, 2.4],
    feintWeights: { jab: 4, shoulder: 3, level: 2, step: 1 },
    shuffleEvery: [0.5, 1.1],
    pawEvery: [0.7, 1.5],
    shoulderRoll: 0.08,
  },
};

const GINGA_STYLE: FighterStyle = {
  // Capoeira's ginga: wide, low, always swaying side to side, never set.
  footwork: { stanceWidth: 1.35, stepFrames: 10, stepHeight: 0.07 },
  idle: {
    bounceHz: 1.6,
    bounceAmp: 0.04,
    swayAmp: 0.12,
    feintEvery: [1, 2],
    feintWeights: { jab: 0, shoulder: 1, level: 3, step: 4 },
    shuffleEvery: [0.4, 0.9],
    pawEvery: [3, 5],
    shoulderRoll: 0.02,
  },
};

const FENCER_STYLE: FighterStyle = {
  // Side-on, light on the feet, blade out in front: in and out on quick steps.
  footwork: { stanceWidth: 1.15, stepFrames: 7, stepHeight: 0.03 },
  idle: {
    bounceHz: 1.8,
    bounceAmp: 0.02,
    swayAmp: 0.02,
    feintEvery: [1, 2.2],
    feintWeights: { jab: 3, shoulder: 0, level: 1, step: 4 },
    shuffleEvery: [0.4, 0.9],
    pawEvery: [5, 8],
    shoulderRoll: 0,
  },
};

const SUMO_STYLE: FighterStyle = {
  // Low and wide, heavy on the feet; long still waits, then all at once.
  footwork: { stanceWidth: 1.45, stepFrames: 15, stepHeight: 0.025 },
  idle: {
    bounceHz: 0.5,
    bounceAmp: 0.008,
    swayAmp: 0.03,
    feintEvery: [4, 7],
    feintWeights: { jab: 0, shoulder: 2, level: 3, step: 1 },
    shuffleEvery: [2, 3.5],
    pawEvery: [4, 7],
    shoulderRoll: 0.05,
  },
};

Object.assign(ARCHETYPES, {
  boxer: {
    kind: 'boxer',
    read: 0.85,
    name: 'The Boxer',
    stats: { maxHp: 72, walkSpeed: 2.4, staggerResist: 0.15 },
    style: BOXER_STYLE,
    // A counter-puncher: hands only, waits for you to throw, slips it and makes you pay
    // with a combination — jab, straight, hook, and the uppercut when you duck in.
    plan: {
      moves: [['quickJab', 30], ['straight', 22], ['checkHook', 18], ['body', 14], ['eUppercut', 12]],
      range: 1.1,
      attackRange: 1.35,
      punish: 'straight',
      chains: { quickJab: 'straight', straight: 'checkHook', body: 'eUppercut' },
      counters: ['quickJab', 'checkHook'],
      temper: 'patient',
      specials: [
        { move: 'checkHook', min: 0, max: 1.4, rate: 0.3, cooldown: 120, when: 'targetWhiffed' },
        { move: 'eUppercut', min: 0, max: 1.1, rate: 0.25, cooldown: 140, when: 'targetEntered' },
      ],
    },
    ai: { blockChance: 0.55, aggression: 0.95, stringChance: 0.6 },
    coins: [10, 15],
  },
  nakmuay: {
    kind: 'nakmuay',
    read: 0.7,
    name: 'Nak Muay',
    stats: { maxHp: 82, walkSpeed: 2.0, staggerResist: 0.25 },
    style: KICKER_STYLE,
    // Thai boxing: walks forward behind push kicks, chops the legs out with low kicks,
    // slams roundhouses into the ribs, and leaps in with a flying kick.
    plan: {
      moves: [['pushKick', 25], ['kLowKick', 28], ['roundhouse', 25], ['body', 12]],
      range: 1.2,
      attackRange: 1.5,
      punish: 'pushKick',
      chains: { kLowKick: 'roundhouse', body: 'kLowKick' },
      temper: 'pressure',
      specials: [
        { move: 'pushKick', min: 0, max: 1.0, rate: 0.25, cooldown: 100, when: 'crowded' },
        { move: 'leapKick', min: 1.8, max: 2.6, rate: 0.015, cooldown: 340 },
      ],
    },
    ai: { blockChance: 0.35, aggression: 1.05, stringChance: 0.5 },
    coins: [11, 16],
  },
  wrestler: {
    kind: 'wrestler',
    read: 0.5,
    name: 'The Wrestler',
    stats: { maxHp: 112, walkSpeed: 1.8, staggerResist: 0.45, defense: 0.08 },
    style: HEAVY_STYLE,
    // Wants you on the floor: shoots in shoulder-first, sweeps the legs, dives on you
    // from out of reach, and keeps coming.
    plan: {
      moves: [['bruiserBody', 30], ['body', 20], ['sweep', 30], ['teep', 10]],
      range: 0.95,
      attackRange: 1.25,
      punish: 'sweep',
      chains: { body: 'sweep' },
      temper: 'pressure',
      specials: [
        { move: 'shoulderCharge', min: 1.6, max: 3.6, rate: 0.05, cooldown: 220 },
        { move: 'pounce', min: 1.8, max: 3.2, rate: 0.025, cooldown: 360 },
      ],
    },
    ai: { blockChance: 0.3, aggression: 1.2, stringChance: 0.3 },
    coins: [14, 20],
  },
  capoeira: {
    kind: 'capoeira',
    read: 0.75,
    name: 'Capoeirista',
    stats: { maxHp: 62, walkSpeed: 2.5 },
    style: GINGA_STYLE,
    // Never still: swaying, cartwheeling away, sliding in low, and spinning kicks from
    // every angle.
    plan: {
      moves: [['roundhouse', 25], ['rasteira', 18], ['kLowKick', 20], ['teep', 12]],
      range: 1.25,
      attackRange: 1.5,
      punish: 'kLowKick',
      chains: { kLowKick: 'roundhouse' },
      temper: 'skirmish',
      specials: [
        { move: 'backflip', min: 0, max: 1.5, rate: 0.25, cooldown: 150, when: 'targetAttacking' },
        { move: 'spinBackKick', min: 0.6, max: 1.25, rate: 0.04, cooldown: 200 },
        { move: 'frontFlipKick', min: 1.9, max: 2.7, rate: 0.02, cooldown: 280 },
        { move: 'jumpKick', min: 1.5, max: 2.3, rate: 0.015, cooldown: 300 },
      ],
    },
    ai: { blockChance: 0.1, aggression: 1.2 },
    coins: [12, 17],
  },
  duelist: {
    kind: 'duelist',
    read: 0.9,
    name: 'The Duelist',
    weapon: 'gladius',
    stats: { maxHp: 70, walkSpeed: 2.4, staggerResist: 0.15 },
    style: FENCER_STYLE,
    // A fencer: point first, always. Lunges in with the thrust, back out of reach, and
    // the riposte the instant you miss.
    plan: {
      moves: [['rookieJab', 30], ['teep', 30], ['straight', 20]],
      range: 1.15,
      attackRange: 1.45,
      punish: 'rookieJab',
      chains: {},
      counters: ['quickJab'],
      temper: 'skirmish',
      armed: [{ weapons: ['gladius', 'ninjato', 'katana', 'machete', 'cleaver', 'bokken'], moves: [['thrust', 5], ['slash', 2], ['backslash', 1]], punish: 'thrust' }],
      specials: [
        { move: 'thrust', min: 0, max: 1.9, rate: 0.35, cooldown: 90, when: 'targetWhiffed', weapons: ['gladius', 'ninjato', 'katana', 'machete', 'cleaver'] },
        { move: 'dashSlash', min: 2.2, max: 3.1, rate: 0.035, cooldown: 220, when: 'armed' },
      ],
    },
    ai: { blockChance: 0.45, aggression: 1.05, stringChance: 0 },
    coins: [14, 20],
  },
  berserker: {
    kind: 'berserker',
    read: 0.4,
    name: 'The Berserker',
    weapon: 'fireaxe',
    stats: { maxHp: 104, walkSpeed: 2.1, staggerResist: 0.35, defense: 0.05 },
    style: HEAVY_STYLE,
    // No defence to speak of, no fear: the axe comes down again and again, goes round
    // in circles, and gets hurled at you if you run.
    plan: {
      moves: [['haymaker', 30], ['bruiserHook', 25], ['hookChain', 15]],
      range: 1.0,
      attackRange: 1.3,
      punish: 'haymaker',
      chains: { haymaker: 'hookChain' },
      temper: 'berserk',
      armed: [{ weapons: ['fireaxe', 'axe', 'club', 'sledgehammer', 'bat', 'chair'], moves: [['overhead', 3], ['sweep', 2], ['sweepBack', 2]] }],
      specials: [
        { move: 'spinCleave', min: 0.9, max: 1.35, rate: 0.03, cooldown: 200, weapons: ['fireaxe', 'axe', 'club', 'sledgehammer'] },
        { move: 'throwHeavy', min: 2.4, max: 6, rate: 0.02, cooldown: 900, weapons: ['fireaxe', 'axe'] },
        { move: 'haymaker', min: 0.6, max: 1.4, rate: 0.12, cooldown: 160, when: 'afterHit' },
      ],
    },
    ai: { blockChance: 0.1, aggression: 1.3, stringChance: 0.4 },
    coins: [16, 22],
  },
  knifeFighter: {
    kind: 'knifeFighter',
    read: 0.6,
    name: 'Knife Fighter',
    weapon: 'cleaver',
    ammo: { weapon: 'kunai', count: 3 },
    stats: { maxHp: 56, walkSpeed: 2.5 },
    style: LIGHT_STYLE,
    // Dirty and fast: flicks a knife at you to make you flinch, darts in hacking, and
    // goes for the legs.
    plan: {
      moves: [['rookieJab', 30], ['kLowKick', 25], ['body', 20]],
      range: 1.0,
      attackRange: 1.3,
      punish: 'rookieJab',
      chains: { rookieJab: 'body' },
      temper: 'sloppy',
      armed: [{ weapons: ['cleaver', 'machete', 'kunai', 'bottle', 'pipe', 'crowbar'], moves: [['hack', 5], ['slash', 2], ['chop', 1]], punish: 'hack' }],
      specials: [
        { move: 'kunaiThrow', min: 2.5, max: 8, rate: 0.05, cooldown: 160, when: 'hasAmmo' },
        { move: 'hack', min: 0, max: 1.4, rate: 0.2, cooldown: 120, when: 'targetEntered', weapons: ['cleaver', 'machete', 'kunai'] },
      ],
    },
    ai: { blockChance: 0.15, aggression: 1.05, stringChance: 0.4 },
    coins: [9, 14],
  },
  monk: {
    kind: 'monk',
    read: 0.95,
    name: 'The Monk',
    weapon: 'bokken',
    stats: { maxHp: 74, walkSpeed: 2.2, staggerResist: 0.3 },
    style: SAMURAI_STYLE,
    // Calm, patient, almost never caught: turns your attacks aside, flips away, and
    // answers each mistake with one clean blow from the staff.
    plan: {
      moves: [['straight', 30], ['pushKick', 25], ['eUppercut', 15]],
      range: 1.2,
      attackRange: 1.5,
      punish: 'straight',
      chains: {},
      counters: ['checkHook'],
      temper: 'patient',
      armed: [{ weapons: ['bokken', 'cue', 'pipe', 'bat'], moves: [['sweep', 3], ['sweepBack', 2], ['overhead', 1]], punish: 'sweep' }],
      specials: [
        { move: 'backflip', min: 0, max: 1.4, rate: 0.2, cooldown: 170, when: 'targetAttacking' },
        { move: 'sweep', min: 0, max: 2.0, rate: 0.3, cooldown: 110, when: 'targetWhiffed', weapons: ['bokken', 'cue', 'pipe', 'bat'] },
        { move: 'spinBackKick', min: 0.6, max: 1.2, rate: 0.015, cooldown: 300, when: 'unarmed' },
      ],
    },
    ai: { blockChance: 0.6, aggression: 0.85, stringChance: 0 },
    coins: [15, 21],
  },
  sumo: {
    kind: 'sumo',
    read: 0.5,
    name: 'The Sumo',
    stats: { maxHp: 165, walkSpeed: 1.5, staggerResist: 0.55, defense: 0.1 },
    style: SUMO_STYLE,
    // All mass: the charge off the line, then a storm of open-hand thrusts driving you
    // back, and the stamp of the foot.
    plan: {
      moves: [['straight', 35], ['teep', 25], ['bruiserBody', 20]],
      range: 0.95,
      attackRange: 1.25,
      punish: 'straight',
      chains: { straight: 'straight' },
      temper: 'pressure',
      specials: [
        { move: 'shoulderCharge', min: 1.5, max: 3.4, rate: 0.05, cooldown: 240 },
        { move: 'stomp', min: 0.4, max: 1.0, rate: 0.02, cooldown: 260 },
      ],
    },
    ai: { blockChance: 0.3, aggression: 1.0, stringChance: 0.55 },
    coins: [20, 28],
    scale: 1.3,
  },
  troll: {
    kind: 'troll',
    read: 0.45,
    name: 'The Troll',
    weapon: 'sledgehammer',
    stats: { maxHp: 420, walkSpeed: 1.3, staggerResist: 0.78, defense: 0.25 },
    style: BOSS_STYLE,
    // The biggest thing in the arena: the hammer comes down like a falling tree, the
    // ground shakes when it stamps, and it charges if it's lost its hammer.
    plan: {
      moves: [['haymaker', 30], ['bruiserHook', 25], ['bruiserBody', 25]],
      range: 1.0,
      attackRange: 1.3,
      punish: 'bruiserBody',
      chains: {},
      temper: 'berserk',
      armed: [{ moves: [['overhead', 4], ['sweep', 2], ['sweepBack', 1]] }],
      specials: [
        { move: 'stomp', min: 0.3, max: 1.0, rate: 0.035, cooldown: 200 },
        { move: 'throwHeavy', min: 2.4, max: 5, rate: 0.008, cooldown: 1200, weapons: ['sledgehammer'] },
        { move: 'shoulderCharge', min: 1.6, max: 3.6, rate: 0.03, cooldown: 280, when: 'unarmed' },
      ],
    },
    ai: { blockChance: 0.2, aggression: 1, stringChance: 0 },
    coins: [110, 150],
    scale: 1.95,
    boss: true,
  },
} satisfies Partial<Record<EnemyKind, Archetype>>);

/** How much more punishment opponents can take than their archetype's base. */
const ENEMY_HP = 1.6;

export interface EnemyMods {
  hpMul?: number;
  dmgMul?: number;
  aggression?: number;
  /** Sharper reactions (multiplies the archetype's read). */
  readMul?: number;
}

/** Builds an enemy; round modifiers make later rounds tougher. */
export function createEnemy(kind: EnemyKind, rng: Rng, mods: EnemyMods = {}, baseAi: Partial<AIConfig> = {}): { fighter: Fighter; ai: BrawlerAI } {
  const a = ARCHETYPES[kind];
  const sc = a.scale ?? 1;
  // (Everyone takes a good deal more than a few clean shots to put away.)
  const stats = { ...a.stats, maxHp: Math.round((a.stats.maxHp ?? 70) * ENEMY_HP * (mods.hpMul ?? 1)) };
  stats.damageMul = (stats.damageMul ?? 1) * (mods.dmgMul ?? 1);
  // Bigger bodies stride further per step.
  if (stats.walkSpeed) stats.walkSpeed *= Math.sqrt(sc);
  const fighter = new Fighter('enemy', a.name, ENEMY_MOVES, stats, a.style);
  fighter.scale = sc;
  if (a.weapon) fighter.weapon = WEAPONS[a.weapon];
  if (a.ammo) fighter.ammo = { weapon: WEAPONS[a.ammo.weapon], count: a.ammo.count };
  // They see your strikes coming and react — block, slip, duck, slide — as you do,
  // each as well as it's able.
  fighter.autoDefense = true;
  fighter.readSkill = Math.min(1, a.read * (mods.readMul ?? 1));
  const cfg = { ...DEFAULT_AI, ...baseAi, ...a.ai };
  cfg.aggression *= mods.aggression ?? 1;
  // Spacing scales with size.
  const plan = { ...a.plan, range: a.plan.range * sc, attackRange: a.plan.attackRange * sc };
  return { fighter, ai: new BrawlerAI(cfg, rng, plan) };
}

export function coinDrop(kind: EnemyKind, rng: Rng, round: number): number {
  const [lo, hi] = ARCHETYPES[kind].coins;
  return Math.round(rng.range(lo, hi + 1) * (1 + 0.08 * Math.max(0, round - 1)));
}
