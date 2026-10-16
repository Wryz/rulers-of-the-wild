import type { ThemeId } from '../arena/themes';
import type { EnemyKind } from '../sim/enemies';
import { BRAWLER_PALETTE, ENEMY_PALETTES, type GearLook, type Palette } from './fighterView';

/** What each opponent wears depends on where you fight them. */
export function lookFor(kind: EnemyKind, theme: ThemeId | null): { palette: Palette; gear?: GearLook } {
  switch (kind) {
    case 'samurai':
      // Indigo kimono top, dark hakama, white tabi, hair tied up.
      return { palette: { skin: '#e0b68e', shirt: '#2c3a5c', pants: '#1d1d24', gloves: '#e0b68e', boots: '#e6e0d0', hair: '#141414', sleeves: 'shirt', shins: '#1d1d24', addons: { topknot: true } } };
    case 'ninja':
      return { palette: { skin: '#d1a37c', shirt: '#17171d', pants: '#17171d', gloves: '#17171d', boots: '#101014', hair: '#101014', sleeves: 'shirt', shins: '#17171d', addons: { mask: '#17171d' } } };
    case 'imp':
      return { palette: { skin: '#7a3a8c', shirt: '#7a3a8c', pants: '#2a1830', gloves: '#3a1a40', boots: '#2a1830', hair: '#140a18', sleeves: 'skin', bald: true, addons: { horns: 'small', eyes: '#ffd23a', tail: true } } };
    case 'demon':
      return { palette: { skin: '#b0281f', shirt: '#b0281f', pants: '#2a0e0e', gloves: '#1a0808', boots: '#1a0808', hair: '#1a0808', sleeves: 'skin', bald: true, addons: { horns: 'big', eyes: '#ffb020', tail: true } } };
    case 'champion':
      return {
        palette: { skin: '#8a5a40', shirt: '#8a5a40', pants: '#d8a71c', gloves: '#d8a71c', boots: '#f2f2f2', hair: '#151515', sleeves: 'skin', shins: '#8a5a40', bald: true },
        gear: { helmet: { material: 'leather', tier: 1 } },
      };
    case 'minotaur':
      return { palette: { skin: '#5e3b24', shirt: '#5e3b24', pants: '#3a2414', gloves: '#2a1a10', boots: '#2a1a10', hair: '#2a1a10', sleeves: 'skin', bald: true, addons: { horns: 'bull', snout: true, eyes: '#ff4020', tail: true } }, gear: { legs: { material: 'iron', tier: 2 } } };
    case 'cyclops':
      return { palette: { skin: '#7d9468', shirt: '#7d9468', pants: '#5a4632', gloves: '#5a4632', boots: '#3a2c20', hair: '#2a2a1a', sleeves: 'skin', bald: true, addons: { cyclops: true, eyes: '#fff3a0' } }, gear: { chest: { material: 'leather', tier: 1 } } };
    // ---- The second wave: each dresses the part, wherever you meet them. ----
    case 'boxer':
      // Shirtless, satin trunks, red gloves, high boots.
      return { palette: { skin: '#c99068', shirt: '#c99068', pants: '#b8202a', gloves: '#c0392b', boots: '#f2f2f2', hair: '#1a1410', sleeves: 'skin', shins: '#c99068' } };
    case 'nakmuay':
      // Muay Thai shorts, bare shins, hand wraps.
      return { palette: { skin: '#b07a52', shirt: '#b07a52', pants: '#2a62c9', gloves: '#e8e2d4', boots: '#b07a52', hair: '#111111', sleeves: 'skin', shins: '#b07a52', bald: true } };
    case 'wrestler':
      // Singlet and boots.
      return { palette: { skin: '#d39a72', shirt: '#7a1f2b', pants: '#7a1f2b', gloves: '#d39a72', boots: '#1a1a1a', hair: '#2a1a10', sleeves: 'skin', shins: '#7a1f2b' }, gear: { helmet: { material: 'leather', tier: 1 } } };
    case 'capoeira':
      // White abadá trousers, bare chest, a coloured cord.
      return { palette: { skin: '#8a5a3c', shirt: '#8a5a3c', pants: '#f2efe6', gloves: '#8a5a3c', boots: '#8a5a3c', hair: '#141414', sleeves: 'skin', shins: '#f2efe6' } };
    case 'duelist':
      // Fencing whites, a dark sash.
      return { palette: { skin: '#e8c2a0', shirt: '#f4f1ea', pants: '#f4f1ea', gloves: '#2a2a30', boots: '#2a2a30', hair: '#6a4a2a', sleeves: 'shirt', shins: '#f4f1ea' } };
    case 'berserker':
      // Furs and leather, wild beard, iron cap.
      return { palette: { skin: '#e0b08a', shirt: '#5a3a22', pants: '#3a2a1a', gloves: '#2a1a10', boots: '#2a1a10', hair: '#b4502a', sleeves: 'skin', bald: true }, gear: { helmet: { material: 'iron', tier: 1 }, cuffs: { material: 'leather', tier: 1 } } };
    case 'knifeFighter':
      // Hoodie, dark jeans, a mask over the face.
      return { palette: { skin: '#d9a982', shirt: '#3a3f4a', pants: '#22283a', gloves: '#d9a982', boots: '#121212', hair: '#121212', sleeves: 'shirt', addons: { mask: '#1a1a1e' } } };
    case 'monk':
      // Saffron robes, shaved head.
      return { palette: { skin: '#d8a678', shirt: '#e08a1e', pants: '#c26a12', gloves: '#d8a678', boots: '#6a4a2a', hair: '#d8a678', sleeves: 'shirt', shins: '#c26a12', bald: true } };
    case 'sumo':
      // The mawashi, and the topknot.
      return { palette: { skin: '#e8b890', shirt: '#e8b890', pants: '#2a2a5a', gloves: '#e8b890', boots: '#e8b890', hair: '#121212', sleeves: 'skin', shins: '#e8b890', addons: { topknot: true } } };
    case 'troll':
      return { palette: { skin: '#6f7f86', shirt: '#6f7f86', pants: '#3a3226', gloves: '#3a3226', boots: '#2a241a', hair: '#2a2a22', sleeves: 'skin', bald: true, addons: { horns: 'small', eyes: '#c8ff6a', snout: true } }, gear: { cuffs: { material: 'iron', tier: 2 } } };
    default:
      break;
  }
  const base = ENEMY_PALETTES[kind] ?? BRAWLER_PALETTE;
  switch (theme) {
    case 'ring':
      // Boxers: shirtless, coloured trunks, gloves, white boots.
      return { palette: { ...base, shirt: base.skin, sleeves: 'skin', pants: kind === 'bruiser' ? '#1f1f22' : '#2a62c9', shins: base.skin, gloves: '#c0392b', boots: '#f2f2f2' } };
    case 'street':
      return { palette: { ...base, shirt: kind === 'kicker' ? '#2b2b2b' : base.shirt === base.skin ? '#4a4a52' : base.shirt, sleeves: 'shirt', pants: '#3a4a66', shins: undefined, gloves: base.skin, boots: '#1a1a1a' } };
    case 'grocery':
      // Store staff in green aprons.
      return { palette: { ...base, shirt: '#2f7d4a', sleeves: 'skin', pants: '#2b2d36', shins: undefined, gloves: base.skin, boots: '#1a1a1a' } };
    case 'warehouse':
      // Fight club: shirtless, jeans, taped hands.
      return { palette: { ...base, shirt: base.skin, sleeves: 'skin', pants: '#2f3e5c', shins: undefined, gloves: '#e8e2d4', boots: '#2a2018' } };
    case 'bar':
      // Bikers: leather vests over bare arms.
      return { palette: { ...base, shirt: '#2a1f1a', sleeves: 'skin', pants: '#33415e', shins: undefined, gloves: base.skin, boots: '#1a1410' } };
    case 'dojo':
      // Martial artists in white gis (a black belt for the dangerous ones).
      return { palette: { ...base, shirt: '#f2efe6', sleeves: 'shirt', pants: '#f2efe6', shins: '#f2efe6', gloves: base.skin, boots: base.skin } };
    case 'rooftop':
      // Thugs in tracksuits.
      return { palette: { ...base, shirt: kind === 'kicker' ? '#6a2b8c' : '#1f2a3a', sleeves: 'shirt', pants: '#1f2a3a', shins: undefined, gloves: base.skin, boots: '#f2f2f2' } };
    case 'colosseum':
      return {
        palette: { ...base, shirt: base.skin, sleeves: 'skin', pants: '#7a4e2e', shins: base.skin, gloves: '#5a4632', boots: '#7a4e2e' },
        gear: { helmet: { material: kind === 'bruiser' ? 'steel' : 'iron', tier: kind === 'rookie' ? 1 : 2 }, chest: kind === 'rookie' ? undefined : { material: 'leather', tier: 1 } },
      };
    default:
      return { palette: base, gear: kind === 'bruiser' ? { helmet: { material: 'iron', tier: 2 }, chest: { material: 'iron', tier: 2 } } : undefined };
  }
}
