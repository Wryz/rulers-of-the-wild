// The ape's mind (docs/M1-DESIGN.md §6.3): idle, patrol, investigate, chase, fight (an inner DungeonStyle BrawlerAI with
// the Bruiser plan), flee and return, on the human nav layer.
//
// STUB (P05; P19 fills it): the exported class; decide() throws until P19.
import type { World } from '../world';
import { CreatureMind } from './mind';

export class ApeMind extends CreatureMind {
  decide(w: World): void {
    throw new Error(`world/creatures/apeMind.ts: ApeMind.decide is not implemented yet (P19; world tick ${w.tick})`);
  }
}
