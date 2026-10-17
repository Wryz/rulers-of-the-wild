// Path following (docs/M1-DESIGN.md §6.5): requests queued and served in (requestTick, fighterId) order, waypoints as
// positions with the versions of the tiles they cross, re-paths on goal moves, tile changes, schedule and stuck.
//
// - A mind asks with goTo (or request) in phase 2; MindRegistry serves at most navQueriesPerTick requests a tick in
//   (requestTick, fighter id) order, after every mind has sensed (§3 phase 2). A mind waiting for its path keeps
//   following the old one.
// - Goals are snapped to the layer's navmesh with nav.nearest (null: no path, a failure). The path is positions only
//   (poly refs die on rebuild, §7), with the tiles its corridor crosses and their versions: when one changes (checked
//   every repathCheckTicks near the player, every sensed tick far away) the follower asks again, so a felled tree or a
//   dug pit re-routes it (SPEC:775).
// - Failures: a request with no path, the end of a partial path (`complete: false`, followed to its end first) and a
//   stuck window (less than stuckMinM of progress in stuckTicks while asking for more than stuckAskSpeed) each count
//   one; maxPathFailures in a row make the goal unreachable, and the mind falls back to its state's fallback. Reaching
//   the end of a complete path, or a stuck window with progress, clears them.
// - Per layer, the numbers are the species' (CREATURE_TUNING.ape for the human layer, .giant for the ruler layer, read
//   live): arriveM, repathMoveM, stuckMinM, stuckTicks.
// - No navmesh (a world built with nav 'off', for physics-only tests): a path is the straight line to the goal,
//   complete, crossing no tiles. Deviation (P19): §7 leaves creatures in such worlds undefined; walking straight keeps
//   scripted and brain-on creatures usable in those scenes without changing anything where a navmesh exists.
import type { Fighter } from '../../sim/fighter';
import type { NavLayer } from '../nav';
import type { V3 } from '../types';
import type { World } from '../world';
import { CREATURE_TUNING } from './defs';

/** The follower's part of a mind's save record (MindRecV1.path; null for a follower with no goal). */
export interface PathRecord {
  points: V3[];
  i: number;
  goal: V3;
  complete: boolean;
  tiles: number[];
  versions: number[];
  requestTick: number;
  pending: boolean;
}

/** The stuck window and the consecutive failures (MindRecV1.stuck). */
export interface StuckRecord {
  pos: V3;
  tick: number;
  count: number;
}

const copy3 = (p: V3): V3 => ({ x: p.x, y: p.y, z: p.z });
const flatDist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** m/s a creature asks for now: its drive's speed (the giant), else its move input × its walk speed (the ape). */
export function askedSpeed(self: Fighter): number {
  if (self.drive) return self.drive.speed;
  return Math.hypot(self.moveInput.x, self.moveInput.z) * self.stats.walkSpeed;
}

export class PathFollower {
  readonly layer: NavLayer;
  /** The path's corners (the first is the start), as positions. */
  points: V3[] = [];
  /** The corner being steered at; points.length once the end is reached. */
  i = 0;
  /** The goal last asked for (pending or served); null with no task. */
  goal: V3 | null = null;
  /** The path reaches its goal (false: a partial path, whose end is a failure). */
  complete = false;
  /** The tiles the path's corridor crosses (sorted) and their versions when it was found. */
  tiles: number[] = [];
  versions: number[] = [];
  /** The tick of the request waiting to be served (or of the last one served); −1 before any. */
  requestTick = -1;
  /** A request is waiting for MindRegistry to serve it. */
  pending = false;
  /** The stuck window (where and when it opened) and the consecutive failures. */
  readonly stuck: StuckRecord = { pos: { x: 0, y: 0, z: 0 }, tick: -1, count: 0 };

  constructor(layer: NavLayer) {
    this.layer = layer;
  }

  /** The species' path numbers for this layer (read live). */
  private get tune(): { arriveM: number; repathMoveM: number; stuckMinM: number; stuckTicks: number } {
    return this.layer === 'ruler' ? CREATURE_TUNING.giant : CREATURE_TUNING.ape;
  }

  /** Consecutive failures (no path, a partial path's end, stuck). */
  get failures(): number {
    return this.stuck.count;
  }

  /** maxPathFailures failures in a row: the goal can't be reached (the mind's state falls back, §6.5). */
  get unreachable(): boolean {
    return this.stuck.count >= CREATURE_TUNING.shared.maxPathFailures;
  }

  /** The end of a complete path has been reached. */
  get done(): boolean {
    return this.complete && this.points.length > 0 && this.i >= this.points.length;
  }

  /** A path is being followed (corners left to reach). */
  get following(): boolean {
    return this.i < this.points.length;
  }

  /**
   * Queue a path request to `goal` (served in phase 2, at most navQueriesPerTick per tick). A request already waiting
   * keeps its place in the queue and takes the new goal.
   */
  request(w: World, _self: Fighter, goal: V3): void {
    this.goal = copy3(goal);
    if (!this.pending) {
      this.pending = true;
      this.requestTick = w.tick;
    }
  }

  /**
   * Keep a path to `goal` (phase 2): asks when there is no path (none yet, or the last request failed), when the goal
   * has moved more than repathMoveM from the one asked for, or `repathTicks` after the last request (a chase, §6.5).
   * While a request waits, its goal follows `goal`.
   */
  goTo(w: World, self: Fighter, goal: V3, repathTicks = Infinity): void {
    if (this.pending) {
      this.goal = copy3(goal);
      return;
    }
    const moved = this.goal === null || flatDist(goal, this.goal) > this.tune.repathMoveM;
    const none = this.points.length === 0;
    const due = w.tick - this.requestTick >= repathTicks;
    if (moved || none || due) this.request(w, self, goal);
  }

  /**
   * Serves the waiting request now (MindRegistry, phase 2): the goal snapped to the layer's navmesh, a path from the
   * creature's position. No polygon near the goal, or no path, is a failure and leaves no path.
   */
  serve(w: World, self: Fighter): void {
    this.pending = false;
    const goal = this.goal;
    if (!goal) return;
    const nav = w.nav;
    if (!nav) {
      this.set(self, w.tick, [copy3(goal)], true, [], []);
      return;
    }
    const snapped = nav.nearest(this.layer, goal);
    if (!snapped) {
      this.fail(self, w.tick);
      return;
    }
    const p = nav.findPath(this.layer, self.pos, snapped);
    if (p.points.length === 0) {
      this.fail(self, w.tick);
      return;
    }
    this.set(self, w.tick, p.points, p.complete, p.tiles, p.versions);
  }

  /**
   * Phase 2 upkeep, after the mind's decision: a re-path when a tile the path crosses has a new version (when
   * `checkTiles`), and the stuck window (a failure and a re-path when less than stuckMinM of progress was made in
   * stuckTicks while asking for more than stuckAskSpeed; progress clears the failures).
   */
  upkeep(w: World, self: Fighter, checkTiles: boolean): void {
    const nav = w.nav;
    if (checkTiles && nav && !this.pending && this.goal && this.following) {
      for (let k = 0; k < this.tiles.length; k++) {
        if (nav.tileVersion(this.layer, this.tiles[k]) !== this.versions[k]) {
          this.request(w, self, this.goal);
          break;
        }
      }
    }
    const s = this.stuck;
    if (!this.following || askedSpeed(self) <= CREATURE_TUNING.shared.stuckAskSpeed || s.tick < 0) {
      this.openWindow(self, w.tick);
      return;
    }
    const T = this.tune;
    if (w.tick - s.tick < T.stuckTicks) return;
    if (flatDist(self.pos, s.pos) < T.stuckMinM) {
      s.count++;
      if (this.goal && !this.pending) this.request(w, self, this.goal);
    } else s.count = 0;
    this.openWindow(self, w.tick);
  }

  /**
   * Phase 3: the corner to steer at, advancing past every corner within arriveM; null with no path or at its end.
   * Reaching the end of a complete path clears the failures; the end of a partial path is a failure, and the path is
   * dropped so the next goTo asks again.
   */
  corner(self: Fighter): V3 | null {
    const arrive = this.tune.arriveM;
    while (this.i < this.points.length) {
      const p = this.points[this.i];
      if (flatDist(p, self.pos) > arrive) return p;
      this.i++;
      if (this.i < this.points.length) continue;
      if (this.complete) this.stuck.count = 0;
      else this.fail(self, null);
    }
    return null;
  }

  /** Forgets the path, the goal, a waiting request and the failures (a new task). */
  clear(): void {
    this.points = [];
    this.i = 0;
    this.goal = null;
    this.complete = false;
    this.tiles = [];
    this.versions = [];
    this.requestTick = -1;
    this.pending = false;
    this.stuck.tick = -1;
    this.stuck.count = 0;
  }

  /** Metres left along the path from `from` (0 with none). */
  remaining(from: V3): number {
    let len = 0;
    let prev = from;
    for (let k = this.i; k < this.points.length; k++) {
      len += flatDist(prev, this.points[k]);
      prev = this.points[k];
    }
    return len;
  }

  /** MindRecV1.path: null with no goal. Copies throughout. */
  toRecord(): PathRecord | null {
    if (!this.goal) return null;
    return {
      points: this.points.map(copy3),
      i: this.i,
      goal: copy3(this.goal),
      complete: this.complete,
      tiles: [...this.tiles],
      versions: [...this.versions],
      requestTick: this.requestTick,
      pending: this.pending,
    };
  }

  /** MindRecV1.stuck. */
  stuckRecord(): StuckRecord {
    return { pos: copy3(this.stuck.pos), tick: this.stuck.tick, count: this.stuck.count };
  }

  /** Puts back toRecord() and stuckRecord() (copies). */
  restoreRecord(path: PathRecord | null, stuck: StuckRecord): void {
    this.clear();
    if (path) {
      if (path.tiles.length !== path.versions.length) throw new Error('PathFollower.restoreRecord: tiles and versions differ in length');
      if (!Number.isInteger(path.i) || path.i < 0 || path.i > path.points.length) throw new Error(`PathFollower.restoreRecord: corner ${path.i} of ${path.points.length}`);
      this.points = path.points.map(copy3);
      this.i = path.i;
      this.goal = copy3(path.goal);
      this.complete = path.complete;
      this.tiles = [...path.tiles];
      this.versions = [...path.versions];
      this.requestTick = path.requestTick;
      this.pending = path.pending;
    }
    this.stuck.pos = copy3(stuck.pos);
    this.stuck.tick = stuck.tick;
    this.stuck.count = stuck.count;
  }

  /** A new path: from its first corner, the stuck window reopened here and now. */
  private set(self: Fighter, tick: number, points: readonly V3[], complete: boolean, tiles: readonly number[], versions: readonly number[]): void {
    this.points = points.map(copy3);
    this.i = 0;
    this.complete = complete;
    this.tiles = [...tiles];
    this.versions = [...versions];
    this.openWindow(self, tick);
  }

  /**
   * One failure: no path left to follow (the goal stays, so the next goTo asks again). The stuck window reopens at
   * `tick` when given (phase 2); phase 3's failures leave it to the next upkeep, which reopens it (nothing followed).
   */
  private fail(self: Fighter, tick: number | null): void {
    this.points = [];
    this.i = 0;
    this.complete = false;
    this.tiles = [];
    this.versions = [];
    this.stuck.count++;
    if (tick !== null) this.openWindow(self, tick);
  }

  /** The stuck window starts here and now. */
  private openWindow(self: Fighter, tick: number): void {
    this.stuck.pos = { x: self.pos.x, y: self.pos.y, z: self.pos.z };
    this.stuck.tick = tick;
  }
}
