// How fighters look: M1's species palettes (lookForSpecies, docs/M1-DESIGN.md §10.4): the player, the ape (dark fur, a snout) and the giant ape
// (darker still, a silver back, a heavy brow) — drawn at the fighter's own scale (1.1 and 5.5, SPEC:873-874), so the
// giant reads from far away by size, colour and silhouette (SPEC:842).
// (DS's outfits by enemy kind and arena, and their armour tiers, are gone: rule 4. Worn hide and bone armour, M1's
// armour rule, SPEC:417, will show as a material look, never as a tier.)
import type { SpeciesId } from '@wild/sim';
import { BRAWLER_PALETTE, type Palette, PLAYER_PALETTE } from './fighterView';

/** The ape: dark brown fur all over, a leathery grey face and hands, a snout (SPEC:873). */
export const APE_PALETTE: Palette = {
  skin: '#5b4c45',
  shirt: '#3a2a20',
  pants: '#33251c',
  gloves: '#4a3d37',
  boots: '#2f231b',
  hair: '#2a1e17',
  sleeves: 'shirt',
  bald: true,
  shins: '#33251c',
  addons: { snout: true, eyes: '#c79a3a', brow: true },
};

/** The giant ape: near-black fur, a silver back (an old male), a heavy brow (SPEC:874). */
export const GIANT_APE_PALETTE: Palette = {
  skin: '#3f3836',
  shirt: '#1d1816',
  pants: '#1a1513',
  gloves: '#2e2826',
  boots: '#171210',
  hair: '#141010',
  sleeves: 'shirt',
  bald: true,
  shins: '#1a1513',
  addons: { snout: true, eyes: '#d9862c', brow: true, silverBack: '#a9a7a2' },
};

/** A fighter's look by species: the player (or any human the player isn't: DS's brawler), the ape, the giant ape. */
export function lookForSpecies(species: SpeciesId | null, isPlayer: boolean): { palette: Palette } {
  switch (species) {
    case 'ape':
      return { palette: APE_PALETTE };
    case 'giantApe':
      return { palette: GIANT_APE_PALETTE };
    default:
      return { palette: isPlayer ? PLAYER_PALETTE : BRAWLER_PALETTE };
  }
}
