// The sim's Rapier world (docs/M1-DESIGN.md §1.5.6, §3 phases 5-8, §4.3, §8.1).
//
// - `physicsReady()`: the one async step of the sim. It initialises Rapier and recast once per process (memoised), and
//   createWorld awaits it; everything after is synchronous. Nothing here (or anywhere in the sim) calls Rapier or recast
//   at module top level, so legacy tests that import the index pay only the module import.
// - `PhysicsWorld`: the Rapier world and its event queue, the collider → owner map (handles are never saved or
//   exposed to rules), the pre-step store with one tick of pose history (phase 5), the post-step velocity snapshot
//   (phase 8, the rope fit's v_post), and the drain that turns collision events into owner pairs sorted by owner
//   (phase 8). Nothing acts inside a Rapier callback: an exception there is swallowed silently (MAP gap-3 §1.3).
// - PHYSICS_TUNING: the entity body parameters every body factory reads.
import RAPIER from '@dimforge/rapier3d-compat';
import { init as recastInit } from 'recast-navigation';
import { DT } from '../sim/math';
import { defineTuning } from '../tuning/registry';
import type { Owner, Quat, V3 } from './types';
import { WORLD_TUNING } from './worldTuning';

export const PHYSICS_TUNING = defineTuning(
  'PHYSICS_TUNING',
  'Physics',
  {
    entityExtraSolverIters: 4,
    entityLinDamp: 0,
    entityAngDamp: 0.1,
    ccdMinHalfExtent: 0.15,
    cylinderFacets: 8,
    logFacets: 6,
    forceEventThresholdN: 2000,
    restSpeed: 0.05,
    restTicks: 30,
  },
  {
    entityExtraSolverIters: { unit: 'iterations', source: 'MAP rapier finding 11 (orchestrator decision 5)' },
    entityLinDamp: { unit: '1/s', source: 'NEW' },
    entityAngDamp: { unit: '1/s', source: 'NEW' },
    ccdMinHalfExtent: { unit: 'm', source: 'NEW: SPEC:267 asks CCD for fast small bodies' },
    cylinderFacets: { unit: 'sides', source: 'NEW: C F1, MAP rapier finding 17' },
    logFacets: { unit: 'sides', source: 'NEW: C F1, F2 (logs rest)' },
    forceEventThresholdN: { unit: 'N', source: 'NEW: dev cross-check only' },
    restSpeed: { unit: 'm/s', source: 'NEW' },
    restTicks: { unit: 'ticks', source: 'NEW' },
  },
);

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

let ready: Promise<void> | null = null;
let initialised = false;
let initsStarted = 0;

/**
 * Initialises Rapier (`RAPIER.init()`) and recast (`init()`) once per process; every later call returns the same
 * promise. createWorld awaits it; tests and the client may await it earlier.
 */
export function physicsReady(): Promise<void> {
  if (!ready) {
    initsStarted++;
    ready = Promise.all([RAPIER.init(), recastInit()]).then(() => {
      initialised = true;
    });
  }
  return ready;
}

/** Whether physicsReady() has resolved (a World or PhysicsWorld can be built synchronously). */
export function isPhysicsReady(): boolean {
  return initialised;
}

/** How many times the underlying initialisation has started in this process (0 or 1: it is memoised). */
export function physicsInitCount(): number {
  return initsStarted;
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

const KIND_RANK: Readonly<Record<Owner['kind'], number>> = { terrain: 0, entity: 1, fighter: 2, rope: 3 };
const PART_RANK: Readonly<Record<'kcc' | 'zone' | 'slab' | 'ruler', number>> = { kcc: 0, zone: 1, slab: 2, ruler: 3 };

/**
 * An owner's stable key: 'terrain' (every heightfield tile is one owner), 'entity:<id>', 'fighter:<id>:<part>' or
 * 'fighter:<id>:<part>:<bone>', 'rope:<joint>'. The pre-step and post-step stores are keyed by it.
 */
export function ownerKey(o: Owner): string {
  switch (o.kind) {
    case 'terrain':
      return 'terrain';
    case 'entity':
      return `entity:${o.id}`;
    case 'fighter':
      return o.bone === undefined ? `fighter:${o.id}:${o.part}` : `fighter:${o.id}:${o.part}:${o.bone}`;
    case 'rope':
      return `rope:${o.joint}`;
  }
}

/** Owner order (§4.3): terrain < entity < fighter < rope, then by id, then a fighter's part and bone. */
export function compareOwners(a: Owner, b: Owner): number {
  const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (k !== 0) return k;
  switch (a.kind) {
    case 'terrain':
      return 0;
    case 'entity':
      return a.id - (b as typeof a).id;
    case 'rope':
      return a.joint - (b as typeof a).joint;
    case 'fighter': {
      const o = b as typeof a;
      if (a.id !== o.id) return a.id - o.id;
      if (a.part !== o.part) return PART_RANK[a.part] - PART_RANK[o.part];
      if (a.bone === o.bone) return 0;
      if (a.bone === undefined) return -1;
      if (o.bone === undefined) return 1;
      return a.bone < o.bone ? -1 : 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Stores and pairs
// ---------------------------------------------------------------------------

/**
 * One owner's state at the start of a step (phase 5).
 * - Dynamic bodies: the body's pose, linvel, angvel and world centre of mass as they arrive at the step; `prevP`,
 *   `prevQ` = the pose stored one tick earlier (or this pose if the body wasn't stored then); `carryV` = `v`.
 * - Kinematic and parentless colliders (zones, ruler zones, rope sensors): the collider's start-of-step world pose
 *   (the pose set one tick earlier: Rapier's narrow phase tests start-of-step poses, §4.3); `prevP`, `prevQ` = the pose
 *   stored one tick earlier; `carryV` = `v` = (p − prevP)/DT, the previous tick's delta; `w` = 0.
 * - After `resetHistory(key)` every store of the key sets prevP := p (carryV 0) up to and including the first one that
 *   shows a pose other than the one the key had when the reset was asked, and at most two stores of the key.
 *   A kinematic body's new pose (setNextKinematic*, phase 4b) shows only at the store after the step that applies it,
 *   so a teleport or an enable reads 0 at both stores around the jump; a parentless collider's (setTranslation) shows
 *   at once, so only that store is zeroed. Either way the jump is never read as a speed (§4.3 "N−1 and N−2 := the
 *   current pose", RF-1).
 */
export interface PreState {
  p: V3;
  q: Quat;
  v: V3;
  w: V3;
  com: V3;
  prevP: V3;
  prevQ: Quat;
  carryV: V3;
}

/**
 * A collision event as owners, `a` before `b` in owner order. The colliders are null only on a `stopped` pair whose
 * collider was removed before this step (its owner is still reported, so touching counts can end).
 */
export interface ContactPair {
  a: Owner;
  b: Owner;
  ca: RAPIER.Collider | null;
  cb: RAPIER.Collider | null;
  started: boolean;
  sensor: boolean;
}

interface Removed {
  owner: Owner;
  key: string;
  sensor: boolean;
}

const v3 = (v: { x: number; y: number; z: number }): V3 => ({ x: v.x, y: v.y, z: v.z });
const quat = (q: { x: number; y: number; z: number; w: number }): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 });
const sameV3 = (a: V3, b: V3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const sameQuat = (a: Quat, b: Quat): boolean => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;

export class PhysicsWorld {
  /** Gravity (0, WORLD_TUNING.gravityY, 0), timestep DT. */
  readonly rapier: RAPIER.World;
  /** autoDrain: undrained events are dropped before the next step; the world drains every tick (phase 8). */
  readonly events: RAPIER.EventQueue;
  /** Contact-force events drained in the last phase 8 (a dev cross-check only, never an outcome). */
  forceEventCount = 0;

  private readonly owners = new Map<number, Owner>();
  private readonly keys = new Map<number, string>();
  /** Colliders unregistered since the last drain: their `stopped` events arrive after the next step. */
  private readonly removed = new Map<number, Removed>();
  private preStore = new Map<string, PreState>();
  private readonly postStore = new Map<string, { v: V3; w: V3 }>();
  /**
   * Pending history resets by owner key: the pose the key showed when the reset was asked (null: no collider had the
   * key then), and whether a store has already held the reset because that pose hadn't changed yet.
   */
  private readonly resets = new Map<string, { p: V3 | null; q: Quat | null; held: boolean }>();
  private gravityY: number;
  private freed = false;

  constructor() {
    if (!initialised) throw new Error('PhysicsWorld: await physicsReady() before building a world');
    this.gravityY = WORLD_TUNING.gravityY;
    this.rapier = new RAPIER.World({ x: 0, y: this.gravityY, z: 0 });
    this.rapier.timestep = DT;
    this.events = new RAPIER.EventQueue(true);
  }

  /** Collider handle → owner (never saved). Register colliders as they are created, in id order. */
  register(c: RAPIER.Collider, owner: Owner): void {
    this.owners.set(c.handle, owner);
    this.keys.set(c.handle, ownerKey(owner));
    this.removed.delete(c.handle);
  }

  /** Call before (or right after) removing a collider: its last `stopped` events still map to its owner. */
  unregister(c: RAPIER.Collider): void {
    const owner = this.owners.get(c.handle);
    if (!owner) return;
    this.removed.set(c.handle, { owner, key: this.keys.get(c.handle)!, sensor: c.isSensor() });
    this.owners.delete(c.handle);
    this.keys.delete(c.handle);
  }

  ownerOf(handle: number): Owner | null {
    return this.owners.get(handle) ?? this.removed.get(handle)?.owner ?? null;
  }

  /** The owner key of a registered collider, or null. */
  keyOf(handle: number): string | null {
    return this.keys.get(handle) ?? this.removed.get(handle)?.key ?? null;
  }

  /**
   * Phase 5: stores every awake, enabled dynamic body's state and every enabled kinematic or parentless sensor
   * collider's pose, keyed by owner (see PreState). Fixed bodies, terrain and sleeping bodies are not stored.
   */
  storePreStep(): void {
    const prev = this.preStore;
    const next = new Map<string, PreState>();
    const bodies = new Map<number, PreState>();
    for (const [h, owner] of this.owners) {
      if (owner.kind === 'terrain') continue;
      const c = this.rapier.getCollider(h);
      if (!c || !c.isEnabled()) continue;
      const key = this.keys.get(h)!;
      const b = c.parent();
      const old = this.resets.has(key) ? undefined : prev.get(key);
      // A pending reset: prevP := p (a kinematic or parentless collider's carryV is 0).
      let s: PreState;
      if (b && b.isDynamic()) {
        if (!b.isEnabled() || b.isSleeping()) continue;
        let base = bodies.get(b.handle);
        if (!base) {
          const p = v3(b.translation());
          const q = quat(b.rotation());
          const v = v3(b.linvel());
          base = { p, q, v, w: v3(b.angvel()), com: v3(b.worldCom()), prevP: p, prevQ: q, carryV: v };
          bodies.set(b.handle, base);
        }
        s = { ...base, prevP: old ? old.p : base.p, prevQ: old ? old.q : base.q };
      } else if (b && b.isFixed()) {
        continue;
      } else if (!b && !c.isSensor()) {
        continue;
      } else {
        const p = v3(c.translation());
        const q = quat(c.rotation());
        const prevP = old ? old.p : p;
        const carryV = { x: (p.x - prevP.x) / DT, y: (p.y - prevP.y) / DT, z: (p.z - prevP.z) / DT };
        s = { p, q, v: carryV, w: { ...ZERO }, com: p, prevP, prevQ: old ? old.q : q, carryV };
      }
      next.set(key, s);
    }
    this.settleResets(next);
    this.preStore = next;
  }

  /** The state stored for an owner key in this tick's phase 5, or null (not stored: fixed, asleep, disabled). */
  pre(key: string): PreState | null {
    return this.preStore.get(key) ?? null;
  }

  /**
   * From the next storePreStep on, `key`'s stored pose is its previous one too (carryV 0), until the new pose shows (see
   * PreState): called on every enable, teleport, respawn, load and body-type switch (§4.3, RF-1), at the time it
   * happens. A key not stored at a store (disabled, asleep) keeps its reset for the store that next stores it.
   */
  resetHistory(key: string): void {
    const now = this.storedPoseOf(key);
    this.resets.set(key, { p: now?.p ?? null, q: now?.q ?? null, held: false });
  }

  /**
   * End of a store: a reset whose key was stored ends once the store shows a pose other than the one at the reset (or
   * on its second store); a reset whose key is no longer registered is dropped; any other reset stays pending.
   */
  private settleResets(stored: ReadonlyMap<string, PreState>): void {
    if (this.resets.size === 0) return;
    let live: Set<string> | null = null;
    for (const [key, r] of [...this.resets]) {
      const s = stored.get(key);
      if (!s) {
        live ??= new Set(this.keys.values());
        if (!live.has(key)) this.resets.delete(key);
        continue;
      }
      const unchanged = r.p !== null && r.q !== null && sameV3(s.p, r.p) && sameQuat(s.q, r.q);
      if (unchanged && !r.held) r.held = true;
      else this.resets.delete(key);
    }
  }

  /** The pose a store would read for `key` now (the last registered collider with that key), or null. */
  private storedPoseOf(key: string): { p: V3; q: Quat } | null {
    let found: { p: V3; q: Quat } | null = null;
    for (const [h, k] of this.keys) {
      if (k !== key) continue;
      const c = this.rapier.getCollider(h);
      if (!c) continue;
      const b = c.parent();
      found = b && b.isDynamic() ? { p: v3(b.translation()), q: quat(b.rotation()) } : { p: v3(c.translation()), q: quat(c.rotation()) };
    }
    return found;
  }

  /** Phase 7: one Rapier step (gravity re-read from WORLD_TUNING, so it is live). */
  step(): void {
    this.assertLive();
    if (WORLD_TUNING.gravityY !== this.gravityY) {
      this.gravityY = WORLD_TUNING.gravityY;
      this.rapier.gravity = { x: 0, y: this.gravityY, z: 0 };
    }
    this.rapier.step(this.events);
  }

  /** Phase 8: every awake dynamic body's linvel and angvel as the step left them, before any code impulse (RF-2). */
  snapshotPostStep(): void {
    this.postStore.clear();
    const bodies = new Map<number, { v: V3; w: V3 }>();
    for (const [h, owner] of this.owners) {
      if (owner.kind === 'terrain') continue;
      const c = this.rapier.getCollider(h);
      const b = c?.parent();
      if (!b || !b.isDynamic() || !b.isEnabled() || b.isSleeping()) continue;
      let s = bodies.get(b.handle);
      if (!s) {
        s = { v: v3(b.linvel()), w: v3(b.angvel()) };
        bodies.set(b.handle, s);
      }
      this.postStore.set(this.keys.get(h)!, s);
    }
  }

  /** The phase-8 snapshot of an owner key, or null. */
  post(key: string): { v: V3; w: V3 } | null {
    return this.postStore.get(key) ?? null;
  }

  /**
   * Phase 8: this step's collision events as owner pairs, sorted by (lower owner, higher owner) in owner order (a
   * stable sort, so pairs of the same owners keep Rapier's deterministic order). Contact-force events only feed the
   * dev counter. Pairs whose colliders were never registered are dropped.
   */
  drain(): ContactPair[] {
    const raw: number[] = [];
    const flags: boolean[] = [];
    // Copy only: nothing acts inside the callback.
    this.events.drainCollisionEvents((h1, h2, started) => {
      raw.push(h1, h2);
      flags.push(started);
    });
    let forces = 0;
    this.events.drainContactForceEvents(() => {
      forces++;
    });
    this.forceEventCount = forces;
    const pairs: ContactPair[] = [];
    for (let i = 0; i < flags.length; i++) {
      const h1 = raw[2 * i];
      const h2 = raw[2 * i + 1];
      const o1 = this.ownerOf(h1);
      const o2 = this.ownerOf(h2);
      if (!o1 || !o2) continue;
      const c1 = this.owners.has(h1) ? this.rapier.getCollider(h1) : null;
      const c2 = this.owners.has(h2) ? this.rapier.getCollider(h2) : null;
      const sensor = (c1 ? c1.isSensor() : (this.removed.get(h1)?.sensor ?? false)) || (c2 ? c2.isSensor() : (this.removed.get(h2)?.sensor ?? false));
      const swap = compareOwners(o1, o2) > 0;
      pairs.push({ a: swap ? o2 : o1, b: swap ? o1 : o2, ca: swap ? c2 : c1, cb: swap ? c1 : c2, started: flags[i], sensor });
    }
    this.removed.clear();
    return pairs.sort((x, y) => compareOwners(x.a, y.a) || compareOwners(x.b, y.b));
  }

  /**
   * One empty step so colliders built before any body exists (the terrain) are visible to scene queries from the first
   * tick (a new collider is invisible to queries until a step, MAP rapier finding 7). Only valid while the world has
   * no rigid body; its events are discarded.
   */
  primeQueries(): void {
    this.assertLive();
    if (this.rapier.bodies.len() !== 0) throw new Error('PhysicsWorld.primeQueries: only before any rigid body exists');
    this.rapier.step(this.events);
    this.events.drainCollisionEvents(() => {});
    this.events.drainContactForceEvents(() => {});
  }

  /** Frees the Rapier world and the event queue (controllers and bodies go with the world). Idempotent. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.events.free();
    this.rapier.free();
    this.owners.clear();
    this.keys.clear();
    this.removed.clear();
    this.preStore.clear();
    this.postStore.clear();
    this.resets.clear();
  }

  get isFreed(): boolean {
    return this.freed;
  }

  private assertLive(): void {
    if (this.freed) throw new Error('PhysicsWorld: used after free()');
  }
}
