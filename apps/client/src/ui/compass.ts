// The compass (docs/M1-DESIGN.md §10.8): a strip at the top centre showing HUD_TUNING.compassSpanDeg (180°) of the
// horizon ahead of the camera, with N/E/S/W, a ping for the spawn point (WORLD_TUNING.spawnX/Z), and a ping where the
// player last saw the giant: a ruler counts as seen while its chest is inside the camera's frustum, within
// VERB_UI_TUNING.compassSeeRangeM of the player, with a clear terrain line from the camera (the world's read-only
// queries); the ping stays where it was last seen and fades out over VERB_UI_TUNING.compassPingS.
//
// Convention: north is −z and east is +x (a bearing is measured clockwise from north, so it reads like a map with x to
// the right). TODO(P21): the Clearing's lair is "at the north rim foot" (§6.7): the generator should use this convention.
import { type Camera, Vector3 } from 'three';
import { type Fighter, type QueryFilter, type V3, WORLD_TUNING, type Hit } from '@wild/sim';
import { VERB_UI_TUNING } from '../input/verbInput';

/** The compass's starting values (HUD_TUNING, ui/hud.ts, read live). */
export interface CompassTuning {
  compassSpanDeg: number;
  compassTickDeg: number;
  spawnPingHideM: number;
}

/** A bearing in degrees, [0, 360): clockwise from north (−z) toward east (+x), of the ground direction (dx, dz). */
export function bearingDeg(dx: number, dz: number): number {
  const b = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return b < 0 ? b + 360 : b;
}

/** The bearing the camera looks along (its forward direction on the ground). */
export function headingDeg(camera: Camera): number {
  const f = camera.getWorldDirection(new Vector3());
  return bearingDeg(f.x, f.z);
}

/**
 * Where a bearing sits on a strip centred on `heading` and `span` degrees wide: −0.5 (left edge) … 0.5 (right edge),
 * or null when it is off the strip.
 */
export function stripOffset(bearing: number, heading: number, span: number): number | null {
  let d = (bearing - heading) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  if (Math.abs(d) > span / 2) return null;
  return d / span;
}

/** What the giant's sighting reads of the world (World satisfies it; tests pass a stand-in). */
export interface SightWorld {
  readonly combat: { readonly fighters: readonly Fighter[] };
  readonly queries: { castRay(from: V3, dir: V3, maxToi: number, f: QueryFilter): Hit | null };
}

/** Terrain only: what hides the giant from you is the land (trunks are thin). */
const TERRAIN_ONLY: QueryFilter = { terrain: true, entities: 'none' };

/**
 * Where the player last saw a ruler (§10.8), and how long ago (real seconds). While one is in sight the ping is where it
 * stands now; once out of sight the ping stays put and fades.
 */
export class GiantSighting {
  /** Ground position of the last sighting, or null (never seen, or faded out). */
  at: { x: number; z: number } | null = null;
  /** Seconds since it was last seen (0 while it is in sight). */
  age = 0;
  /** A ruler is in sight now. */
  seen = false;

  update(world: SightWorld, player: Fighter, camera: Camera, dt: number): void {
    const R = VERB_UI_TUNING;
    this.seen = false;
    for (const f of world.combat.fighters) {
      if (!f.ruler || !f.alive || !this.visible(world, player, camera, f, R.compassSeeRangeM)) continue;
      this.at = { x: f.pos.x, z: f.pos.z };
      this.age = 0;
      this.seen = true;
      return;
    }
    if (!this.at) return;
    this.age += dt;
    if (this.age >= R.compassPingS) this.at = null;
  }

  /** How strongly the ping shows: 1 while in sight, fading to 0 over compassPingS once out of it. */
  get opacity(): number {
    if (!this.at) return 0;
    return Math.max(0, 1 - this.age / VERB_UI_TUNING.compassPingS);
  }

  private visible(world: SightWorld, player: Fighter, camera: Camera, f: Fighter, rangeM: number): boolean {
    if (player.pos.distanceTo(f.pos) > rangeM) return false;
    const chest = f.rig.chest.pos;
    camera.updateMatrixWorld();
    const p = chest.clone().project(camera);
    if (!(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z >= -1 && p.z <= 1)) return false;
    const from = camera.getWorldPosition(new Vector3());
    const d = chest.clone().sub(from);
    const len = d.length();
    if (!(len > 0)) return true;
    return world.queries.castRay(from, d, len, TERRAIN_ONLY) === null;
  }
}

export class Compass {
  readonly sighting = new GiantSighting();
  private readonly el: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly spawn: HTMLDivElement;
  private readonly giant: HTMLDivElement;
  private ticks: { el: HTMLDivElement; bearing: number }[] = [];
  private tickDeg = 0;

  constructor(
    root: HTMLElement,
    private readonly tuning: Readonly<CompassTuning>,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'compass';
    this.el.innerHTML = '<div class="ctrack"></div><div class="cping spawn" title="Spawn">⌂</div><div class="cping giant" title="The giant, last seen">▲</div><div class="ccentre"></div>';
    root.appendChild(this.el);
    this.track = this.el.querySelector<HTMLDivElement>('.ctrack')!;
    this.spawn = this.el.querySelector<HTMLDivElement>('.cping.spawn')!;
    this.giant = this.el.querySelector<HTMLDivElement>('.cping.giant')!;
  }

  update(world: SightWorld, player: Fighter | null, camera: Camera, dt: number): void {
    this.el.style.display = player ? '' : 'none';
    if (!player) return;
    const T = this.tuning;
    if (T.compassTickDeg !== this.tickDeg) this.buildTicks(T.compassTickDeg);
    const heading = headingDeg(camera);
    for (const t of this.ticks) place(t.el, stripOffset(t.bearing, heading, T.compassSpanDeg));
    // The spawn point (hidden when you stand on it).
    const sx = WORLD_TUNING.spawnX - player.pos.x;
    const sz = WORLD_TUNING.spawnZ - player.pos.z;
    place(this.spawn, Math.hypot(sx, sz) < T.spawnPingHideM ? null : stripOffset(bearingDeg(sx, sz), heading, T.compassSpanDeg));
    // The giant, where you last saw it.
    this.sighting.update(world, player, camera, dt);
    const at = this.sighting.at;
    place(this.giant, at ? stripOffset(bearingDeg(at.x - player.pos.x, at.z - player.pos.z), heading, T.compassSpanDeg) : null);
    this.giant.style.opacity = this.sighting.opacity.toFixed(3);
    this.giant.classList.toggle('seen', this.sighting.seen);
  }

  dispose(): void {
    this.el.remove();
  }

  /** A tick every `deg` degrees; N, E, S and W labelled. */
  private buildTicks(deg: number): void {
    this.tickDeg = deg;
    this.track.innerHTML = '';
    this.ticks = [];
    const step = deg > 0 ? deg : 90;
    const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    const bearings = new Set<number>([0, 90, 180, 270]);
    for (let b = 0; b < 360 - 1e-9; b += step) bearings.add(Math.round(b * 1000) / 1000);
    for (const b of [...bearings].sort((x, y) => x - y)) {
      const el = document.createElement('div');
      const name = names[b];
      el.className = name ? `ctick card${name === 'N' ? ' north' : ''}` : 'ctick';
      el.textContent = name ?? '';
      this.track.appendChild(el);
      this.ticks.push({ el, bearing: b });
    }
  }
}

/** Puts a strip element at its offset (−0.5 … 0.5), or hides it (null). */
function place(el: HTMLElement, offset: number | null): void {
  if (offset === null) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  el.style.left = `${(50 + offset * 100).toFixed(2)}%`;
}
