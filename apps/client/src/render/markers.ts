// Awareness markers (docs/M1-DESIGN.md §10.8, rule 3): a `?` over a creature that is investigating and a `!` over one
// that is chasing or fighting, for creatures within VERB_UI_TUNING.markerRangeM of the player. What a creature knows
// is read from world.minds.view(f) (read-only, never an input), so the player can see what the creature has noticed.
import { type Camera, Vector3 } from 'three';
import type { Fighter, MindView } from '@wild/sim';
import { VERB_UI_TUNING } from '../input/verbInput';

/** The markers' starting values (HUD_TUNING, ui/hud.ts, read live). */
export interface MarkerTuning {
  markerLiftM: number;
}

/** What the markers read of the world (World satisfies it; tests pass a stand-in). */
export interface MarkerWorld {
  readonly combat: { readonly fighters: readonly Fighter[] };
  readonly minds: { view(f: Fighter): MindView };
}

export interface AwarenessMark {
  f: Fighter;
  mark: '?' | '!';
}

/** Every creature within `rangeM` of the player showing `?` or `!`, in fighter (id) order. */
export function awarenessMarks(world: MarkerWorld, player: Fighter, rangeM: number): AwarenessMark[] {
  const out: AwarenessMark[] = [];
  for (const f of world.combat.fighters) {
    if (f === player || f.playerId !== null || !f.alive) continue;
    if (player.pos.distanceTo(f.pos) > rangeM) continue;
    const mark = world.minds.view(f).marker;
    if (mark === '?' || mark === '!') out.push({ f, mark });
  }
  return out;
}

/** Where a fighter's marker floats: `liftM` × its scale over its head (a new vector). */
export function markerPoint(f: Fighter, liftM: number): Vector3 {
  return f.rig.head.pos.clone().setY(f.rig.head.pos.y + liftM * f.scale);
}

export class AwarenessMarkers {
  private readonly el: HTMLDivElement;
  private readonly pool: HTMLDivElement[] = [];

  constructor(
    root: HTMLElement,
    private readonly tuning: Readonly<MarkerTuning>,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'aware';
    root.appendChild(this.el);
  }

  update(world: MarkerWorld, player: Fighter | null, camera: Camera): void {
    const marks = player ? awarenessMarks(world, player, VERB_UI_TUNING.markerRangeM) : [];
    let n = 0;
    for (const m of marks) {
      const p = markerPoint(m.f, this.tuning.markerLiftM).project(camera);
      if (!(p.z <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1)) continue;
      const el = this.slot(n++);
      if (el.textContent !== m.mark) el.textContent = m.mark;
      const cls = m.mark === '!' ? 'amark alert' : 'amark';
      if (el.className !== cls) el.className = cls;
      el.style.display = '';
      el.style.left = `${((p.x * 0.5 + 0.5) * 100).toFixed(2)}%`;
      el.style.top = `${((-p.y * 0.5 + 0.5) * 100).toFixed(2)}%`;
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  dispose(): void {
    this.el.remove();
  }

  private slot(i: number): HTMLDivElement {
    let el = this.pool[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'amark';
      this.el.appendChild(el);
      this.pool.push(el);
    }
    return el;
  }
}
