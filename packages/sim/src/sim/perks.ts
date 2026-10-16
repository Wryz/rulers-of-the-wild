/**
 * Skills a fighter can have (bought in the shop): each one changes how a fight goes in
 * one particular way. The sim checks for them where they apply.
 */
export type PerkId =
  | 'secondWind'
  | 'bloodlust'
  | 'counterMaster'
  | 'perfectTiming'
  | 'heavyHands'
  | 'thickBlood'
  | 'fortune'
  | 'executioner'
  | 'adrenaline'
  | 'lastStand'
  | 'quickHands';

/** Extra frames a parry can come in late and still be one (Perfect Timing). */
export const PERFECT_TIMING_FRAMES = 3;
