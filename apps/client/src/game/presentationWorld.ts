// The presentation physics world (docs/M1-DESIGN.md §10.5, rule 6): its own Rapier world, never read by the sim, with
// the terrain and the entities mirrored in, and the ragdolls that draw the player and the apes. Plus `Fx`, the blood,
// gibs and particles an event throws (render/blood.ts, gibs.ts, particles.ts).
//
// - Mirrors: the terrain tiles as heightfields (re-shaped when a tile's version changes) and every fixed or anchored
//   entity as a fixed collider (syncStatic); free entities within mirrorRadiusM of the camera as kinematic colliders
//   that follow their sim pose (syncDynamic). Held, stowed, tied and flying things are not mirrored.
// - Ragdolls (body/ragdoll.ts, DS): at most maxRagdolls, for the fighters nearest the camera (level of detail, with
//   lodHysteresisM so two bodies at the edge don't swap every step); never the giant, whose rig is the sim's body
//   (§10.5). Standing, a ragdoll is driven toward the fighter's rig (DS); knocked down or KO'd, its root follows the
//   sim's slab (world.downed: RAGDOLL_TUNING.downRootGain), so the visible body lies where the sim's body lies. The
//   throw is the sim's `launch` event (onLaunch). A downed fighter without a ragdoll (beyond the level of detail) is
//   drawn as its rig laid on the slab.
// - Collision slots belong to this world (RagdollSlots, D-42) and are recycled when a ragdoll goes.
// - Nothing here writes sim state (rule 6): the world, its fighters, entities and slabs are only read, and the sim's
//   own Rapier world is never touched. Rapier calls run on this world's own bodies.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { Quaternion, type Scene, Vector3 } from 'three';
import {
  BONES,
  type BoneName,
  cylinderPoints,
  roundCylinderR,
  defineTuning,
  DT,
  type Entity,
  type Fighter,
  forwardKinematics,
  HUMANOID_MASS,
  limbBones,
  makeRig,
  MATERIALS,
  type Rig,
  Rng,
  type Shape,
  type V3,
  type World,
  WORLD_TUNING,
} from '@wild/sim';
import { type BodyMove, type DownTarget, GROUP_ENV, GROUP_MIRROR, groups, movePoint, Ragdoll, RagdollSlots, SLOT_COUNT } from '../body/ragdoll';
import { Blood } from '../render/blood';
import { Gibs } from '../render/gibs';
import { Effects, type Ground } from '../render/particles';
import type { BodyPose, FighterViewPort, FxPort, GoreLevel, PresentationPort, SimEvent, WorldViewsPort } from './ports';
import { Trauma } from './trauma';

export const PRESENTATION_TUNING = defineTuning(
  'PRESENTATION_TUNING',
  'Client › presentation',
  {
    maxRagdolls: 8,
    mirrorRadiusM: 30,
    lodHysteresisM: 2,
    // DS bodyLanding (game.ts), detected on the ragdoll: a downed body falling faster than bodyFallSpeed whose fall
    // drops below bodyFallStopFrac of that in one step, with its pelvis within bodyFallNearM × scale of the ground, has
    // landed; then no other landing for bodyFallQuietSteps. A fall at bodyFallHardSpeed is as hard as it gets.
    // (FEEL_TUNING.steps.landStopFrac / thuds.bodyHardSpeed (P37) and CAMERA_TUNING.landHardSpeed (P34) hold their
    // own copies of the same DS numbers for the sound and the camera.)
    bodyFallSpeed: 1.4,
    bodyFallStopFrac: 0.35,
    bodyFallNearM: 0.45,
    bodyFallQuietSteps: 20,
    bodyFallHardSpeed: 5,
  },
  {
    maxRagdolls: { unit: 'ragdolls', source: 'NEW: SPEC:655-656 (ragdoll LOD)', min: 0, max: SLOT_COUNT, step: 1, label: 'max ragdolls' },
    mirrorRadiusM: { unit: 'm', source: 'NEW: SPEC:655-656 (ragdoll LOD)', min: 5, max: 200, step: 1, label: 'mirror radius' },
    lodHysteresisM: {
      unit: 'm',
      source: 'NEW (P33): a body that has a ragdoll keeps it until another is this much nearer the camera (no swapping at the edge)',
      min: 0,
      max: 20,
      step: 0.5,
      label: 'LOD hysteresis',
    },
    bodyFallSpeed: { unit: 'm/s', source: 'DS (game.ts bodyLanding: falling faster than 1.4 m/s)', min: 0, max: 10, step: 0.1, label: 'body fall from' },
    bodyFallStopFrac: { unit: '× fall speed', source: 'DS (game.ts bodyLanding: stopped below 0.35 of the fall speed)', min: 0, max: 1, step: 0.05, label: 'body fall stopped below' },
    bodyFallNearM: { unit: 'm × scale', source: 'DS (game.ts bodyLanding: pelvis within 0.45 × scale of the ground)', min: 0, max: 2, step: 0.05, label: 'body fall near ground' },
    bodyFallQuietSteps: { unit: 'steps', source: 'DS (game.ts bodyLanding: 20 quiet steps after a landing)', min: 0, max: 120, step: 1, label: 'body fall quiet' },
    bodyFallHardSpeed: { unit: 'm/s', source: 'DS (game.ts bodyLanding: hard = fall speed / 5)', min: 0.5, max: 30, step: 0.5, label: 'body fall hard at' },
  },
);

/** A body coming down hard on the ground (DS bodyLanding, detected from the ragdoll: presentation only). */
export interface BodyFall {
  f: Fighter;
  /** The pelvis as it landed (world). */
  at: Vector3;
  /** 0..1: how hard (DS: the fall speed ÷ 5 m/s). */
  hard: number;
  /** Its mass in human bodies (f.mass ÷ HUMANOID_MASS). */
  mass: number;
}

/** What Fx listens to besides the sim's events: bodies hitting the ground. */
export interface BodyFallSource {
  readonly bodyFalls: Set<(fall: BodyFall) => void>;
}

/** An entity's collider in the presentation world. */
interface Mirror {
  body: RAPIER_NS.RigidBody;
  shape: Shape;
  kinematic: boolean;
  p: V3;
  q: { x: number; y: number; z: number; w: number };
  /** The sync pass that last saw it (its kind's counter). */
  seen: number;
}

/** A downed fighter drawn without a ragdoll: its rig laid on the sim's slab, kept for interpolation. */
class SlabPose implements BodyPose {
  readonly prev = {} as Record<BoneName, { p: Vector3; q: Quaternion }>;
  readonly cur = {} as Record<BoneName, { p: Vector3; q: Quaternion }>;

  constructor(rig: Rig, move: BodyMove) {
    for (const b of BONES) {
      this.cur[b] = { p: new Vector3(), q: new Quaternion() };
      this.prev[b] = { p: new Vector3(), q: new Quaternion() };
    }
    this.update(rig, move);
    this.freeze();
  }

  update(rig: Rig, move: BodyMove): void {
    for (const b of BONES) {
      this.prev[b].p.copy(this.cur[b].p);
      this.prev[b].q.copy(this.cur[b].q);
      movePoint(move, rig[b].pos, this.cur[b].p);
      this.cur[b].q.copy(move.rot).multiply(rig[b].rot);
    }
  }

  freeze(): void {
    for (const b of BONES) {
      this.prev[b].p.copy(this.cur[b].p);
      this.prev[b].q.copy(this.cur[b].q);
    }
  }
}

const TORSO = ['chest', 'abdomen', 'head'] as const;
const UP = new Vector3(0, 1, 0);
const DOWN = Object.freeze({ x: 0, y: -1, z: 0 });
/** Rapier InteractionGroups for a query that sees only the environment (terrain and mirrors), never a ragdoll. */
const ENV_QUERY = groups(0xffff, GROUP_ENV | GROUP_MIRROR);

/** Knocked down or KO'd (a dead fighter is KO'd: Fighter.alive): the only states a slab may draw the body in. */
const isDown = (f: Fighter): boolean => f.state === 'knockdown' || f.state === 'ko';

const _yaw = new Quaternion();
const _v = new Vector3();

export class PresentationWorld implements PresentationPort, BodyFallSource {
  readonly rapier: RAPIER_NS.World;
  /** D-42: this world's ragdoll collision bits, recycled when a ragdoll is disposed. */
  readonly slots = new RagdollSlots();
  /** Listeners for bodies hitting the ground (Fx's dust). */
  readonly bodyFalls = new Set<(fall: BodyFall) => void>();
  private readonly ragdolls = new Map<Fighter, Ragdoll>();
  /** Downed fighters without a ragdoll, drawn as their rig laid on the slab. */
  private readonly slabPoses = new Map<Fighter, SlabPose>();
  private ground: RAPIER_NS.RigidBody | null = null;
  private readonly tiles: RAPIER_NS.Collider[] = [];
  private tileVersions: Uint32Array = new Uint32Array(0);
  /** Entity id → its collider here (fixed for fixed and anchored entities, kinematic for free ones near the camera). */
  private readonly mirrors = new Map<number, Mirror>();
  private staticPass = 0;
  private dynamicPass = 0;
  /** DS bodyLanding's per-body state: last step's fall speed and the quiet steps left after a landing. */
  private readonly falls = new Map<Fighter, { vy: number; quiet: number }>();
  /** Where the camera is (the level of detail and the mirrors are measured from it). */
  private camera: () => V3 | null;
  /**
   * Fighters snapped (snapTo) since the last step, with a fresh rig at f.pos and f.yaw: until the sim's next pose
   * update, f.rig is still where the body was (a respawn teleports in phase 15, after phase 3 posed the rig at the
   * corpse), so this step builds and drives their ragdolls toward the fresh rig instead. Cleared after each step.
   */
  private readonly snapped = new Map<Fighter, Rig>();
  private readonly move: BodyMove = { from: new Vector3(), to: new Vector3(), rot: new Quaternion() };
  private readonly down: DownTarget = { at: new Vector3(), rot: new Quaternion(), vel: new Vector3() };
  private disposed = false;

  /**
   * `camera`: where the camera is, read each step (level of detail and entity mirrors); by default the player's
   * position (the follow camera is a few metres behind it).
   */
  constructor(
    private readonly R: typeof RAPIER_NS,
    private readonly world: World,
    camera?: () => V3 | null,
  ) {
    this.camera = camera ?? (() => world.player?.pos ?? null);
    this.rapier = new R.World({ x: 0, y: WORLD_TUNING.gravityY, z: 0 });
    this.rapier.timestep = DT;
    this.syncStatic(world);
  }

  /** Where the camera is, from now on (main.ts can hand over the rendering camera's position). */
  setCamera(camera: () => V3 | null): void {
    this.camera = camera;
  }

  // ---------------------------------------------------------------------------
  // Mirrors
  // ---------------------------------------------------------------------------

  /** The terrain tiles as heightfields (re-shaped when a tile's version changes); fixed and anchored entities. */
  syncStatic(world: World): void {
    const t = world.terrain;
    if (!this.ground) this.ground = this.rapier.createRigidBody(this.R.RigidBodyDesc.fixed());
    if (this.tileVersions.length !== t.tileCount) this.tileVersions = new Uint32Array(t.tileCount);
    for (let i = 0; i < t.tileCount; i++) {
      if (this.tiles[i] && this.tileVersions[i] === t.version[i]) continue;
      if (this.tiles[i]) this.rapier.removeCollider(this.tiles[i], false);
      const c = t.tileCentre(i);
      const desc = this.R.ColliderDesc.heightfield(t.cells, t.cells, new Float32Array(t.heights[i]), { x: t.tileSize, y: 1, z: t.tileSize })
        .setTranslation(c.x, 0, c.z)
        .setFriction(0.9)
        .setCollisionGroups(groups(GROUP_ENV, 0xffff));
      this.tiles[i] = this.rapier.createCollider(desc, this.ground);
      this.tileVersions[i] = t.version[i];
    }
    // Fixed and anchored entities (trees, stumps, driven stakes, scaffolding), whatever their distance.
    const pass = ++this.staticPass;
    for (const e of world.entities.all()) {
      if (e.state !== 'fixed' && e.state !== 'anchored') continue;
      let m = this.mirrors.get(e.id);
      if (m && (m.kinematic || m.shape !== e.shape)) {
        this.dropMirror(e.id);
        m = undefined;
      }
      if (!m) m = this.addMirror(e, false) ?? undefined;
      else if (!samePose(m, e)) {
        // Re-placed (a stake driven again): moved where the sim has it.
        m.body.setTranslation(e.pose.p, false);
        m.body.setRotation(e.pose.q, false);
        copyPose(m, e);
      }
      if (m) m.seen = pass;
    }
    for (const [id, m] of this.mirrors) if (!m.kinematic && m.seen !== pass) this.dropMirror(id);
  }

  /** Free entities within mirrorRadiusM of the camera, as kinematic colliders that follow their sim pose. */
  syncDynamic(world: World, cam: V3): void {
    const r2 = PRESENTATION_TUNING.mirrorRadiusM ** 2;
    const pass = ++this.dynamicPass;
    for (const e of world.entities.all()) {
      if (e.state !== 'free') continue;
      const p = e.pose.p;
      if ((p.x - cam.x) ** 2 + (p.y - cam.y) ** 2 + (p.z - cam.z) ** 2 > r2) continue;
      let m = this.mirrors.get(e.id);
      if (m && (!m.kinematic || m.shape !== e.shape)) {
        this.dropMirror(e.id);
        m = undefined;
      }
      if (!m) m = this.addMirror(e, true) ?? undefined;
      else if (!samePose(m, e)) {
        m.body.setNextKinematicTranslation(e.pose.p);
        m.body.setNextKinematicRotation(e.pose.q);
        copyPose(m, e);
      }
      if (m) m.seen = pass;
    }
    for (const [id, m] of this.mirrors) if (m.kinematic && m.seen !== pass) this.dropMirror(id);
  }

  /** The kind of the entity's collider here (tests and the dev panel), or null when it has none. */
  mirrorOf(entity: number): 'fixed' | 'kinematic' | null {
    const m = this.mirrors.get(entity);
    return m ? (m.kinematic ? 'kinematic' : 'fixed') : null;
  }

  // ---------------------------------------------------------------------------
  // Ragdolls
  // ---------------------------------------------------------------------------

  /**
   * A ragdoll for `f`, while fewer than maxRagdolls exist and a slot is free; never the giant (§10.5). Which fighters
   * get one is the level of detail's choice (the nearest the camera, step()). A fighter that is down is built lying
   * on its slab, moving with it.
   */
  attachRagdoll(f: Fighter): Ragdoll | null {
    const have = this.ragdolls.get(f);
    if (have) return have;
    if (f.ruler || this.disposed) return null;
    if (this.ragdolls.size >= ragdollCap() || this.slots.count >= SLOT_COUNT) return null;
    const rd = new Ragdoll(this.R, this.rapier, f, this.slots);
    const rig = this.rigOf(f);
    const move = this.slabMove(f, rig);
    rd.snapTo(f, rig, move);
    if (move) {
      const slab = this.world.downed.pose(f.id);
      const v = this.world.downed.velocity(f.id);
      if (slab && v) rd.launch(v.lin, v.ang, slab.p);
    }
    this.ragdolls.set(f, rd);
    this.slabPoses.delete(f);
    return rd;
  }

  /** The ragdoll drawing `f`, if it has one (tests and the dev panel). */
  ragdollOf(f: Fighter): Ragdoll | null {
    return this.ragdolls.get(f) ?? null;
  }

  /** How many ragdolls exist. */
  get ragdollCount(): number {
    return this.ragdolls.size;
  }

  /** One presentation step after each sim step: mirrors, level of detail, ragdolls driven, the world stepped. */
  step(world: World): void {
    if (this.disposed) return;
    this.syncStatic(world);
    const cam = this.cameraAt(world);
    this.syncDynamic(world, cam);
    this.levelOfDetail(world, cam);
    const fighters = world.combat.fighters;
    let downSlots = 0;
    for (const [f, rd] of this.ragdolls) if (isDown(f)) downSlots |= rd.slot;
    for (const [f, rd] of this.ragdolls) {
      rd.setContacts(isDown(f), downSlots);
      this.slideOff(f, rd, fighters);
      rd.drive(f, this.downTarget(world, f), this.rigOf(f));
      rd.capturePrev();
    }
    // Downed fighters beyond the level of detail: the rig laid on the slab.
    for (const f of fighters) {
      if (f.ruler || this.ragdolls.has(f)) continue;
      const move = this.slabMove(f, f.rig);
      const sp = this.slabPoses.get(f);
      if (!move) this.slabPoses.delete(f);
      else if (sp) sp.update(f.rig, move);
      else this.slabPoses.set(f, new SlabPose(f.rig, move));
    }
    for (const f of this.slabPoses.keys()) if (!fighters.includes(f)) this.slabPoses.delete(f);
    this.snapped.clear();
    this.rapier.step();
    for (const [f, rd] of this.ragdolls) {
      rd.captureCur();
      this.bodyLanding(f, rd);
    }
  }

  /** The sim threw a body (§4.5): its ragdoll takes the slab's velocity and spin. */
  onLaunch(f: Fighter, vel: V3, angVel: V3): void {
    const rd = this.ragdolls.get(f);
    if (!rd) return;
    rd.launch(vel, angVel, this.world.downed.pose(f.id)?.p);
  }

  /** Follows the body as drawn: the ragdoll's pelvis (else the slab's hip, else the rig's), kept above the ground (DS: 0.35 × scale). */
  pelvisOf(f: Fighter): () => Vector3 {
    return () => {
      const rd = this.ragdolls.get(f);
      let p: Vector3;
      if (rd) p = rd.pelvisPos();
      else {
        // Only a downed body lies on its slab (a respawned one is at the spawn while the slab is still active).
        const hip = isDown(f) ? this.world.downed.hip(f.id) : null;
        p = hip ? new Vector3(hip.x, hip.y, hip.z) : f.rig.pelvis.pos.clone();
      }
      p.y = Math.max(this.world.terrain.heightAt(p.x, p.z) + 0.35 * f.scale, p.y);
      return p;
    };
  }

  /**
   * Puts the body back where the sim has the fighter, at once (a respawn): a fresh rig at f.pos and f.yaw (the sim's
   * rig is last tick's until its next pose update; the next step drives toward the fresh one), laid on the slab only
   * if the fighter is down and one holds it (a respawned fighter stands while its corpse slab is still active, until
   * the next tick's phase 4a). A body with limbs cut loose is rebuilt whole from what the sim keeps of it (f.severed,
   * which a respawn clears, §4.14), in this world's slots.
   */
  snapTo(f: Fighter): void {
    this.falls.delete(f);
    const rig = this.snapped.get(f) ?? makeRig();
    forwardKinematics(f.pose, rig, f.pos, f.yaw, f.scale);
    this.snapped.set(f, rig);
    let rd: Ragdoll | null = this.ragdolls.get(f) ?? null;
    if (!rd) return;
    if (rd.loose.size > 0) {
      this.detach(f);
      rd = this.attachRagdoll(f);
      if (!rd) return;
    }
    rd.snapTo(f, rig, this.slabMove(f, rig));
  }

  bodyPose(f: Fighter): BodyPose | null {
    return this.ragdolls.get(f) ?? this.slabPoses.get(f) ?? null;
  }

  freeze(): void {
    for (const rd of this.ragdolls.values()) rd.freezeInterpolation();
    for (const sp of this.slabPoses.values()) sp.freeze();
  }

  /** DS's body reactions (game.ts handleEvent): a blow's impulse, a block, a limb cut loose; a world impact; a respawn. */
  handle(e: SimEvent, _world: World): void {
    switch (e.type) {
      case 'hit': {
        const rd = this.ragdolls.get(e.defender);
        if (!rd) return;
        // The throw itself is the sim's `launch` (onLaunch): DS's presentation-computed throw is gone (§10.5).
        rd.applyHit(e.zone, e.point, e.dir, e.move, (e.armored ? 0.4 : 1) * Math.min(1.8, e.attacker.scale / e.defender.scale));
        if (e.sever) rd.sever(e.sever, limbBones(e.sever), e.dir.clone().multiplyScalar(2.6).add(new Vector3(0, e.sever === 'head' ? 3.2 : 2.2, 0)));
        return;
      }
      case 'block':
        this.ragdolls.get(e.defender)?.applyBlock(e.dir, e.move);
        return;
      case 'impact': {
        // A world hit (a log, a stake, a fall): the sim's presentation hints, as a blow (MAP gap-2 §8b).
        if (e.impulse > 0) this.ragdolls.get(e.defender)?.applyHit(e.zone, e.point, e.dir, { weight: e.weight, impulse: e.impulse, lift: e.lift });
        return;
      }
      case 'respawn':
        this.snapTo(e.f);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rd of this.ragdolls.values()) rd.dispose();
    this.ragdolls.clear();
    this.slabPoses.clear();
    this.snapped.clear();
    this.mirrors.clear();
    this.falls.clear();
    this.bodyFalls.clear();
    this.rapier.free();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private cameraAt(world: World): V3 {
    return this.camera() ?? world.player?.pos ?? { x: 0, y: 0, z: 0 };
  }

  /**
   * Level of detail (SPEC:655-656): the maxRagdolls fighters nearest the camera have ragdolls (rulers never); a
   * fighter that has one counts lodHysteresisM nearer; ties go in fighter order. Fighters gone from the world lose
   * theirs.
   */
  private levelOfDetail(world: World, cam: V3): void {
    const T = PRESENTATION_TUNING;
    const ranked: { f: Fighter; d: number; i: number }[] = [];
    world.combat.fighters.forEach((f, i) => {
      if (f.ruler) return;
      const d = Math.hypot(f.pos.x - cam.x, f.pos.y - cam.y, f.pos.z - cam.z) - (this.ragdolls.has(f) ? T.lodHysteresisM : 0);
      ranked.push({ f, d, i });
    });
    ranked.sort((a, b) => a.d - b.d || a.i - b.i);
    const keep = new Set<Fighter>();
    const cap = ragdollCap();
    for (let k = 0; k < ranked.length && keep.size < cap; k++) keep.add(ranked[k].f);
    for (const f of [...this.ragdolls.keys()]) if (!keep.has(f)) this.detach(f);
    for (const f of keep) this.attachRagdoll(f);
  }

  private detach(f: Fighter): void {
    this.ragdolls.get(f)?.dispose();
    this.ragdolls.delete(f);
    this.falls.delete(f);
  }

  /** The rig the body follows this step: the fresh one snapTo built since the last step, else the sim's f.rig. */
  private rigOf(f: Fighter): Rig {
    return this.snapped.get(f) ?? f.rig;
  }

  /**
   * The rigid move that lays `rig` (the fighter standing at f.pos, turned f.yaw) on the sim's slab: the rig's pelvis
   * to the slab's hip, the fighter's yaw frame to the slab's rotation (the slab is built standing at the fighter's
   * yaw, §4.5). Null unless the fighter is knocked down or KO'd and a slab holds it: a fighter standing again (a
   * respawn, a revive) keeps its slab active until the sim's next phase 4a, and must not be drawn lying on it.
   */
  private slabMove(f: Fighter, rig: Rig): BodyMove | null {
    if (!isDown(f)) return null;
    const slab = this.world.downed.pose(f.id);
    const hip = this.world.downed.hip(f.id);
    if (!slab || !hip) return null;
    const m = this.move;
    m.from.copy(rig.pelvis.pos);
    m.to.set(hip.x, hip.y, hip.z);
    _yaw.setFromAxisAngle(UP, f.yaw).invert();
    m.rot.set(slab.q.x, slab.q.y, slab.q.z, slab.q.w).multiply(_yaw);
    return m;
  }

  /**
   * While the fighter is knocked down or KO'd and the sim's slab holds it: the slab's hip, the pelvis turned with the
   * slab (its rotation × the pose's pelvis), and the slab's velocity at the hip. Null otherwise.
   */
  private downTarget(world: World, f: Fighter): DownTarget | null {
    if (!isDown(f)) return null;
    const slab = world.downed.pose(f.id);
    const hip = world.downed.hip(f.id);
    if (!slab || !hip) return null;
    const t = this.down;
    t.at.set(hip.x, hip.y, hip.z);
    t.rot.set(slab.q.x, slab.q.y, slab.q.z, slab.q.w).multiply(f.pose.rot.pelvis);
    const v = world.downed.velocity(f.id);
    if (v) {
      // v_hip = v + ω × (hip − centre)
      const rx = hip.x - slab.p.x;
      const ry = hip.y - slab.p.y;
      const rz = hip.z - slab.p.z;
      t.vel.set(v.lin.x + (v.ang.y * rz - v.ang.z * ry), v.lin.y + (v.ang.z * rx - v.ang.x * rz), v.lin.z + (v.ang.x * ry - v.ang.y * rx));
    } else t.vel.set(0, 0, 0);
    return t;
  }

  /**
   * DS: a body going down can fall against someone still standing but can't rest on them; it slides off to the floor.
   * (Presentation only now: nothing flows back into the sim.)
   */
  private slideOff(f: Fighter, rd: Ragdoll, fighters: readonly Fighter[]): void {
    if (!isDown(f)) return;
    for (const s of fighters) {
      if (s === f || isDown(s)) continue;
      for (const b of TORSO) {
        if (rd.loose.has(b)) continue;
        const body = rd.bodies[b];
        const v = body.linvel();
        if (v.y > 0.3) continue;
        const t = body.translation();
        if (t.y - s.pos.y < 0.35 * f.scale) continue;
        const dx = t.x - s.pos.x;
        const dz = t.z - s.pos.z;
        const d = Math.hypot(dx, dz);
        const reach = 0.42 * s.scale + 0.2 * f.scale;
        if (d > reach) continue;
        const k = (reach - d) * 6;
        const nx = d > 1e-3 ? dx / d : 1;
        const nz = d > 1e-3 ? dz / d : 0;
        body.setLinvel({ x: v.x + nx * k * DT * 30, y: Math.min(v.y, 0), z: v.z + nz * k * DT * 30 }, true);
      }
    }
  }

  /**
   * DS bodyLanding: a downed body that was falling fast and stops sharply near the ground has landed (heard and seen
   * when it lands, not when the blow was struck). Presentation only; the listeners (Fx) throw the dust.
   */
  private bodyLanding(f: Fighter, rd: Ragdoll): void {
    let s = this.falls.get(f);
    if (!s) this.falls.set(f, (s = { vy: 0, quiet: 0 }));
    s.quiet = Math.max(0, s.quiet - 1);
    const T = PRESENTATION_TUNING;
    const vy = Math.min(rd.bodies.pelvis.linvel().y, rd.bodies.chest.linvel().y);
    if (isDown(f) && s.quiet === 0 && s.vy < -T.bodyFallSpeed && vy > s.vy * T.bodyFallStopFrac) {
      const p = rd.pelvisPos();
      if (this.groundWithin(p, T.bodyFallNearM * f.scale)) {
        const fall: BodyFall = { f, at: p, hard: hardness(-s.vy), mass: f.mass / HUMANOID_MASS };
        for (const l of this.bodyFalls) l(fall);
        s.quiet = Math.round(T.bodyFallQuietSteps);
      }
    }
    s.vy = vy;
  }

  /** Is the ground (terrain or a mirrored entity, never a ragdoll) within `d` m below `p`? */
  private groundWithin(p: Vector3, d: number): boolean {
    if (p.y - this.world.terrain.heightAt(p.x, p.z) <= d) return true;
    return this.rapier.castRay(new this.R.Ray(p, DOWN), d, true, undefined, ENV_QUERY) !== null;
  }

  /** An entity's collider here: fixed, or kinematic (following its pose); null if Rapier can't build its shape. */
  private addMirror(e: Entity, kinematic: boolean): Mirror | null {
    const desc = this.mirrorDesc(e.shape);
    if (!desc) return null;
    const bd = (kinematic ? this.R.RigidBodyDesc.kinematicPositionBased() : this.R.RigidBodyDesc.fixed())
      .setTranslation(e.pose.p.x, e.pose.p.y, e.pose.p.z)
      .setRotation(e.pose.q);
    const body = this.rapier.createRigidBody(bd);
    // (GROUP_MIRROR: a standing fighter's ragdoll never meets it, only a downed one: ragdoll.ts setContacts.)
    this.rapier.createCollider(desc.setFriction(MATERIALS[e.material]?.friction ?? 0.6).setCollisionGroups(groups(GROUP_MIRROR, 0xffff)), body);
    const m: Mirror = { body, shape: e.shape, kinematic, p: { ...e.pose.p }, q: { ...e.pose.q }, seen: 0 };
    this.mirrors.set(e.id, m);
    return m;
  }

  private dropMirror(id: number): void {
    const m = this.mirrors.get(id);
    if (!m) return;
    this.rapier.removeRigidBody(m.body);
    this.mirrors.delete(id);
  }

  /** The shape's collider (the sim's shapes: a prism is the convex hull of its vertices, as colliderDesc builds it). */
  private mirrorDesc(s: Shape): RAPIER_NS.ColliderDesc | null {
    const C = this.R.ColliderDesc;
    switch (s.kind) {
      case 'ball':
        return C.ball(s.r);
      case 'box':
        return C.cuboid(s.hx, s.hy, s.hz);
      case 'capsule':
        return C.capsule(s.halfHeight, s.r);
      // SIM-fix3: ColliderDesc.convexHull never returns null (Rapier makes the hull when the collider is created, and a
      // needle or sliver then throws "expected instance of p"), so the hull is tried first. A prism Rapier can't make a
      // hull of is its round cylinder, as the sim's colliderDesc builds it; such a hull gets no mirror.
      case 'cylinder': {
        const pts = new Float32Array(cylinderPoints(s));
        return this.hullBuilds(pts) ? C.convexHull(pts) : C.cylinder(s.halfHeight, roundCylinderR(s));
      }
      case 'hull': {
        const pts = new Float32Array(s.points);
        return this.hullBuilds(pts) ? C.convexHull(pts) : null;
      }
    }
  }

  /** Whether Rapier can make a convex hull of the points (see mirrorDesc). */
  private hullBuilds(pts: Float32Array): boolean {
    const raw = new this.R.ConvexPolyhedron(pts, null).intoRaw();
    if (!raw) return false;
    raw.free();
    return true;
  }
}

/** How hard a fall at `speed` m/s lands, 0..1 (DS bodyLanding: full at bodyFallHardSpeed). */
function hardness(speed: number): number {
  const full = PRESENTATION_TUNING.bodyFallHardSpeed;
  return full > 0 ? Math.min(1, Math.max(0, speed) / full) : 1;
}

/** maxRagdolls as a whole number of slots (at most SLOT_COUNT: one collision bit each). */
function ragdollCap(): number {
  return Math.max(0, Math.min(SLOT_COUNT, Math.floor(PRESENTATION_TUNING.maxRagdolls)));
}

function samePose(m: Mirror, e: Entity): boolean {
  const p = e.pose.p;
  const q = e.pose.q;
  return m.p.x === p.x && m.p.y === p.y && m.p.z === p.z && m.q.x === q.x && m.q.y === q.y && m.q.z === q.z && m.q.w === q.w;
}

function copyPose(m: Mirror, e: Entity): void {
  m.p = { ...e.pose.p };
  m.q = { ...e.pose.q };
}

/**
 * Blood, gibs and particles (render/blood.ts, gibs.ts, particles.ts) and DS's face blood (game/trauma.ts): the effects an
 * event throws, and each frame the drips from faces, wounds and weapons, a fresh stump's spurts and the sweat sheen. It
 * finds the bodies as drawn through the views (FighterViewPort's points). Everything lands on the sim's terrain (read
 * only). Presentation only: Math.random and the client's own Rng never touch the sim (rule 7).
 */
export class Fx implements FxPort {
  readonly blood: Blood;
  readonly gibs: Gibs;
  readonly effects: Effects;
  /** Accumulated facial damage per fighter (DS game/trauma.ts). */
  private readonly trauma = new Map<Fighter, Trauma>();
  /** How sweaty each fighter has got (0..1, DS). */
  private readonly sweat = new Map<Fighter, number>();
  /** The client's own stream for face drips (DS fxRng): never the sim's. */
  private readonly fxRng = new Rng(99);
  /** The world the events and frames come from (its terrain is the ground everything lands on). */
  private world: World | null = null;
  /** The terrain, read-only (flat at y = 0 until a world is seen). */
  private readonly groundOf: Ground = {
    height: (x, z) => (this.world ? this.world.terrain.heightAt(x, z) : 0),
    normal: (x, z, out) => {
      if (!this.world) return out.set(0, 1, 0);
      this.world.terrain.normalAt(x, z, out);
      return out;
    },
  };

  constructor(
    scene: Scene,
    private readonly views: WorldViewsPort,
    /** The bodies as drawn; a PresentationWorld also reports bodies hitting the ground (DS bodyLanding's dust). */
    readonly presentation: PresentationPort & Partial<BodyFallSource>,
    /** DS's game-style cues (prefs.cues). */
    private readonly cues: () => boolean,
    private readonly player: () => Fighter | null,
  ) {
    this.blood = new Blood(scene, this.groundOf);
    this.gibs = new Gibs(scene, this.groundOf);
    this.effects = new Effects(scene, this.groundOf);
    presentation.bodyFalls?.add((fall) => {
      const at = fall.at;
      this.landingDust(_v.set(at.x, this.groundOf.height(at.x, at.z), at.z), fall.hard, fall.mass, fall.f.scale);
    });
  }

  handle(e: SimEvent, world: World): void {
    this.world = world;
    const me = this.player();
    switch (e.type) {
      case 'hit': {
        const heavy = e.move.weight === 'heavy';
        const view = this.views.fighterView(e.defender);
        if (this.cues()) {
          const col = e.armored ? '#ff9a3c' : e.counter ? '#ffd36b' : '#fff0c8';
          this.effects.flash(e.point, heavy ? 0.42 : 0.26, e.counter ? '#ffd36b' : '#fff3d6');
          this.effects.sparks(e.point, e.dir, heavy ? 22 : 12, col, heavy ? 6.5 : 4.5);
        } else if (!e.weapon || e.weapon.edge === 'blunt') {
          // Real impacts don't spark: sweat flies off a face or body that gets hit.
          const head = e.zone === 'head';
          const wet = 0.4 + (this.sweat.get(e.defender) ?? 0) * 1.2;
          this.effects.sparks(e.point, e.dir.clone().setY(head ? 0.35 : 0.1), Math.round((head ? 10 : 5) * (heavy ? 1.6 : 1) * wet), '#dbe6ee', head ? 2.6 : 1.6, 0.016);
        }
        this.bleed(e.defender, view, e);
        if (e.weapon?.edge === 'blade') this.blood.spray(e.point, e.dir.clone().setY(0.25), 0.5 + (e.wound?.bleed ?? 0.3) * 1.2, 3);
        if (e.sever) {
          for (let i = 0; i < 4; i++) this.blood.spray(e.point, e.dir.clone().setY(0.6 + i * 0.2), 1, 3.4);
        } else if (e.fatal) {
          const top = view ? view.facePoint('brow') : e.point.clone();
          for (let i = 0; i < 5; i++) this.blood.spray(top, e.dir.clone().setY(1 + i * 0.25), 1, e.fatal === 'split' ? 2.6 : 3.2);
        }
        if (e.tear && this.blood.enabled) {
          this.gibs.spawn(e.tear.point, e.tear.vel, e.tear.size, view?.skin ?? '#d9a07a', e.tear.piece);
          this.blood.spray(e.tear.point, e.tear.vel.clone(), 0.8, 2.2);
        }
        return;
      }
      case 'block':
        if (this.cues()) {
          this.effects.sparks(e.point, e.dir, e.guardBreak ? 18 : 8, '#8fd0ff', 3.5, 0.03);
          this.effects.flash(e.point, 0.2, '#9fd8ff');
        } else this.effects.sparks(e.point, e.dir, e.guardBreak ? 8 : 4, '#dbe6ee', 1.5, 0.014);
        // Timed to the last instant: a gold ring round whoever parried (DS).
        if (e.parry && e.perfect) this.effects.ring(e.defender.pos, 1.1, '#ffd36b', 0.5, () => e.defender.pos);
        return;
      case 'dodge':
        if (e.defender === me && e.perfect) this.effects.ring(e.defender.pos, 1.1, '#ffd36b', 0.5, () => e.defender.pos);
        if (e.defender === me && e.kind !== 'airborne' && this.cues()) this.effects.ring(e.defender.pos, 0.9, '#ffd36b', 0.45, () => e.defender.pos);
        return;
      case 'defend':
        if (e.kind === 'slide') this.effects.dust(e.f.pos, 10, 0.4);
        return;
      case 'swing':
        if (e.move.id === 'slideKick' || e.move.id === 'flyingKick') this.effects.dust(e.f.pos, 8, 0.4);
        return;
      case 'getup':
        this.effects.dust(e.f.pos, 10, 0.5 * e.f.scale);
        return;
      case 'thud': {
        const hard = Math.min(1, e.speed / 12);
        this.effects.dust(e.point, Math.round(2 + 4 * hard), 0.06 + 0.04 * e.projectile.weapon.mass);
        return;
      }
      case 'clang': {
        const away = new Vector3(e.f.pos.x - e.point.x, 0.4, e.f.pos.z - e.point.z).normalize();
        this.effects.sparks(e.point, away, e.metal ? 10 : 6, e.metal ? '#ffd27a' : '#8a6a48', e.metal ? 3.2 : 1.4, e.metal ? 0.012 : 0.02);
        return;
      }
      case 'land': {
        const at = new Vector3(e.point.x, e.point.y, e.point.z);
        if (e.f) {
          // Feet first after a jump or a fall (the controller's touchdown, §4.2): DS's jump landing, both feet at once.
          this.effects.dust(at, 6, 0.3 * e.f.scale);
          // A landing hard enough to hurt (scored by the rule) is a body hitting the ground: DS bodyLanding at full force.
          if (e.energy > 0) this.landingDust(at, 1, e.mass / HUMANOID_MASS, e.f.scale);
        } else {
          // A log, a stone, a felled trunk (SPEC:581): dust ∝ its mass, as hard as it was fast (√(2E/m), DS: full at
          // bodyFallHardSpeed), spread as wide as a body of that mass.
          const mass = e.mass / HUMANOID_MASS;
          const speed = e.mass > 0 ? Math.sqrt((2 * Math.max(0, e.energy)) / e.mass) : 0;
          this.landingDust(at, hardness(speed), mass, Math.cbrt(mass));
        }
        return;
      }
      case 'respawn':
        // Patched up (DS resetPlayer): the face and the sweat start again (the views reset their own looks).
        this.trauma.delete(e.f);
        this.sweat.delete(e.f);
        return;
      default:
        return;
    }
  }

  update(gameDt: number, realDt: number, world: World): void {
    this.world = world;
    this.effects.update(gameDt, realDt);
    // (In a freeze-frame the blood still creeps outward — barely — so a spray is a fan of drops, not one clump.)
    this.blood.update(Math.max(gameDt, realDt * 0.1));
    this.gibs.update(gameDt, (at, speed) => this.blood.spray(at, new Vector3(0, 1, 0), Math.min(0.4, speed * 0.08), 0.6));
    // Drips, spurts and sweat move with game time: none in a pause or a hit-pause (DS).
    if (gameDt <= 0) return;
    for (const f of world.combat.fighters) {
      const view = this.views.fighterView(f);
      if (!view) continue;
      // Sweat builds with time and exertion.
      const s = Math.min(1, (this.sweat.get(f) ?? 0) + gameDt * (0.006 + 0.035 * (1 - f.stamina)));
      this.sweat.set(f, s);
      view.setSweat(s);
      if (!this.blood.enabled) continue;
      const t = this.trauma.get(f);
      if (t?.drip(gameDt, this.fxRng)) this.blood.drip(view.facePoint(t.cut && Math.random() < 0.4 ? 'brow' : 'mouth'));
      // A bloodied blade drips for a while.
      if (f.weapon && view.weaponBlood > 0.08) {
        view.weaponBlood *= 0.999;
        if (Math.random() < view.weaponBlood * gameDt * 5) {
          const tip = view.weaponTip(f);
          if (tip) this.blood.drip(tip);
        }
      }
      for (const w of f.wounds) {
        if (w.bleed <= 0.02) continue;
        if (w.stump && w.bleed > 0.45 && Math.random() < 0.6) {
          // Arterial spurts from a fresh stump.
          const at = view.woundPoint(w);
          const out = at.clone().sub(view.chest()).setY(0).normalize().setY(w.stump === 'head' ? 1.4 : 0.5);
          this.blood.spray(at, out, 0.18 * w.bleed, 1.6 + Math.random());
        } else if (Math.random() < w.bleed * gameDt * 6) {
          this.blood.drip(view.woundPoint(w));
        }
      }
    }
  }

  /** TODO(M5, rule 12): 'stylised'. M1 draws blood unless gore is off. */
  setGore(level: GoreLevel): void {
    const on = level !== 'off';
    if (this.blood.enabled && !on) this.clear();
    this.blood.enabled = on;
  }

  clear(): void {
    this.blood.clear();
    this.gibs.clear();
  }

  /** DS bodyLanding's dust: 6 + 10·hard·min(3, mass) puffs over 0.25 × scale m (mass in human bodies). */
  private landingDust(at: Vector3, hard: number, mass: number, scale: number): void {
    this.effects.dust(at, Math.round(6 + 10 * hard * Math.min(3, mass)), 0.25 * scale);
  }

  /** DS bleed(): accumulated facial damage spills blood from the mouth, nose or a cut brow. */
  private bleed(f: Fighter, view: FighterViewPort | null, e: Extract<SimEvent, { type: 'hit' }>): void {
    let t = this.trauma.get(f);
    if (!t) this.trauma.set(f, (t = new Trauma()));
    for (const b of t.onHit(e.zone, e.move, e.damage, e.counter)) {
      if (!view) break;
      // Along the blow and up; a cough spills forward (toward the attacker) and down.
      const d = b.style === 'hit' ? e.dir.clone().setY(0.35) : e.dir.clone().negate().setY(-0.4);
      this.blood.spray(view.facePoint(b.source), d, b.amount * f.scale, b.style === 'hit' ? 2.8 : 1.4);
    }
    view?.setTrauma(t.bruise, t.cut);
  }
}
