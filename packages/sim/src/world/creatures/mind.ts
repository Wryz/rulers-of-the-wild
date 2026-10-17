// Creature minds (docs/M1-DESIGN.md §1.5.10, §6.1, §6.6): CreatureMind implements CombatSim's Brain for one creature
// (senses in phase 2, decisions, path requests; moveInput or drive and posture in phase 3), test scripts that drive a
// creature (never a trap), the pause, and MindRegistry, which runs them in fighter-id order.
//
// STUB (P05; P19 fills it): final exported types and signatures. The registry keeps the minds it is given and reads as
// idle; sense() does nothing; every CreatureMind method throws until P19 (no creature exists before P19).
import type { BrawlerRecV1, MindRecV1 } from '../../save/schema';
import type { AIConfig, AIDirector, Brain } from '../../sim/ai';
import type { Drop } from '../../sim/combat';
import type { Fighter } from '../../sim/fighter';
import type { Rng } from '../../sim/math';
import type { Walkable } from '../collision';
import type { NavLayer } from '../nav';
import type { ImpactCause, PostureId, V3, WoundRecord } from '../types';
import type { World } from '../world';
import { PathFollower } from './pathFollow';
import { Senses } from './perception';

export type MindState =
  | 'idle'
  | 'patrol'
  | 'investigate'
  | 'chase'
  | 'fight'
  | 'flee'
  | 'return'
  | 'rest'
  | 'telegraph'
  | 'charge'
  | 'recover'
  | 'down'
  | 'dead';

/** Scripts drive creatures in tests (§6.6); while one runs, senses update but transitions are suspended. */
export type MindScript =
  | { kind: 'route'; points: { x: number; z: number }[]; speed?: number; gait?: number; useNav?: boolean }
  | { kind: 'charge'; heading: number; speed: number; telegraph?: boolean }
  | { kind: 'tug'; entity: number; dirYaw: number; ticks: number }
  | { kind: 'hold'; posture?: PostureId };

/** A read-only view for the client's awareness markers (rule 3; never an input). */
export interface MindView {
  state: MindState;
  awareness: number;
  /** '?' investigating, '!' chasing or fighting. */
  marker: '' | '?' | '!';
}

export abstract class CreatureMind implements Brain {
  readonly cfg: AIConfig;
  director: AIDirector | null = null;
  drops: Drop[] = [];
  readonly ownsTarget = true;
  state: MindState = 'idle';
  stateTick = 0;
  /** AC-5's "AI paused": no drive or input, idle life paused (§6.6). */
  paused = false;
  script: MindScript | null = null;
  readonly senses = new Senses();
  readonly path: PathFollower;
  /** The world's 'mind:<fighter id>' stream. */
  readonly rng: Rng;
  readonly self: Fighter;

  constructor(w: World, self: Fighter, cfg: AIConfig, layer: NavLayer) {
    this.self = self;
    this.cfg = cfg;
    this.path = new PathFollower(layer);
    this.rng = w.rngs.mind(self.id);
  }

  /** Phase 2: sight, decide (transitions), path requests. */
  sense(w: World): void {
    notImplemented('sense', w);
  }

  abstract decide(w: World): void;

  /** Phase 3 (CombatSim's brain site): moveInput and target, or drive and posture. */
  think(self: Fighter, target: Fighter | null, wk: Walkable | null): void {
    notImplemented('think', self, target, wk);
  }

  onWound(w: WoundRecord): void {
    notImplemented('onWound', w);
  }

  onHurt(cause: ImpactCause | null, attacker: Fighter | null, at: V3): void {
    notImplemented('onHurt', cause, attacker, at);
  }

  toRecord(): MindRecV1 {
    return notImplemented('toRecord');
  }

  /** The inner BrawlerAI's record (apes), or null. */
  innerRecord(): BrawlerRecV1 | null {
    return null;
  }
}

export class MindRegistry {
  private readonly minds = new Map<Fighter, CreatureMind>();

  add(f: Fighter, mind: CreatureMind): void {
    this.minds.set(f, mind);
  }

  remove(f: Fighter): void {
    this.minds.delete(f);
  }

  /** Phase 2, fighter-id order: full rate within aiNearM of the player, else once a second (§6.1). */
  sense(_w: World): void {}

  get(f: Fighter): CreatureMind | null {
    return this.minds.get(f) ?? null;
  }

  view(f: Fighter): MindView {
    const m = this.minds.get(f);
    return { state: m?.state ?? 'idle', awareness: 0, marker: '' };
  }

  /** By fighter id. */
  toRecord(): MindRecV1[] {
    return [...this.minds.keys()].sort((a, b) => a.id - b.id).map((f) => this.minds.get(f)!.toRecord());
  }
}

function notImplemented(name: string, ...args: unknown[]): never {
  throw new Error(`world/creatures/mind.ts: CreatureMind.${name} is not implemented yet (P19; called with ${args.length} arguments)`);
}
