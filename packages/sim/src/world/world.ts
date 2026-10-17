// The world (docs/M1-DESIGN.md §1.5.1, §3, §8.1): one World owns the tick, the id counters, every RNG stream, the sim's
// Rapier world, the terrain, entities, joints, both navmeshes and the CombatSim, and steps them through the tick
// pipeline of §3 in a fixed order. `createWorld` awaits the memoised physicsReady(); everything after is synchronous.
//
// The World is CombatSim's WorldPort (strikes on the world, verbs, throws, projectiles, knockouts, the ruler branch) and
// its GroundQuery (terrain, plus fixed, anchored and resting entities); its `mover` dispatches each standing fighter to
// the character controllers or the ruler's mover.
//
// Systems not yet built are the stubs of P05 (see each file): the pipeline calls every phase now, so each later package
// fills its own file and never edits this one.
import type { Vector3 } from 'three';
import type { BoneName } from '../body/skeleton';
import { serializeWorld } from '../save/serialize';
import type { Brain } from '../sim/ai';
import { CombatSim, type CombatEvent, type HurtZone } from '../sim/combat';
import type { CommandQueue, MetaCommand, VerbCommand } from '../sim/commands';
import { type Fighter, IdCounter } from '../sim/fighter';
import { isEnvironmental } from '../sim/impact';
import { DT } from '../sim/math';
import type { MoveDef } from '../sim/moves';
import type { Projectile } from '../sim/projectiles';
import { createPlayer } from '../sim/roster';
import { rulerHit as rulerHitRule, rulerTick } from '../sim/ruler';
import { DAMAGE_TUNING } from '../sim/rules';
import type { WeaponDef } from '../sim/weapons';
import { Breaking } from './breaking';
import { CharacterControllers } from './characters';
import { type ClearingSpawnData, generateClearing } from './clearing';
import { ContactSystem } from './contacts';
import { GroundCover } from './cover';
import { createCreature } from './creatures/factory';
import { CreatureMind, MindRegistry } from './creatures/mind';
import { NoiseBus } from './creatures/noise';
import { Spawner } from './creatures/spawner';
import { Deaths } from './deaths';
import { applyDevOp } from './devOps';
import { DownedBodies } from './downed';
import { EntityStore } from './entities';
import { Felling } from './felling';
import { JointStore } from './joints';
import { Loads } from './loads';
import { NavSystem, NavWalkable } from './nav';
import { isPhysicsReady, PHYSICS_TUNING, PhysicsWorld, physicsReady } from './physics';
import { WorldQueries } from './queries';
import { RulerBodies } from './rulerBody';
import { WorldRngs } from './rngs';
import { Terrain } from './terrain';
import type { Finish, FighterMover, GroundQuery, ProjectileWorldHit, WorldEvent, WorldPort, WorldStrike } from './types';
import { VerbSystem } from './verbs/index';
import { weaponDropped } from './verbs/hands';
import { projectileHit, projectileLanded, worldStrike } from './verbs/strike';
import { throwRelease as throwReleaseVerb } from './verbs/throw';
import { WORLD_TUNING } from './worldTuning';
import { ZoneBodies } from './zones';

export interface WorldOptions {
  /** uint32; every RNG stream derives from it (§8.1). */
  seed: number;
  /** 'empty' = flat terrain, no props, no creatures (tests build scenes). Default 'clearing'. */
  scene?: 'clearing' | 'empty';
  /** Default 'generated' for 'clearing', 'flat' for 'empty'. */
  terrain?: 'generated' | 'flat';
  /** m, default WORLD_TUNING.clearingSize (200); rounded to whole terrain tiles. */
  size?: number;
  /** 'off' for physics-only tests (saves ~1-1.5 s per world, MAP recast §6). Default 'full'. */
  nav?: 'full' | 'off';
  /** Spawn the local player, player number 1 = playerId 'p1'. Default true. */
  player?: boolean;
  /** Dev ?mode=training: an ape 3 m in front of the player (D-50; the Spawner's). Default false. */
  sparringApe?: boolean;
}

/** Player number → credit id (SPEC:566). */
export const playerIdOf = (n: number): string => `p${n}`;

/** Awaits the memoised physicsReady() (world/physics.ts), then builds the world synchronously. */
export async function createWorld(o: WorldOptions): Promise<World> {
  await physicsReady();
  return new World(o);
}

/**
 * One tick's output. `combat` is CombatSim's event array of the tick (KOs scored in phase 9 included) and `world` the
 * world's: both are reused by the next step, so a caller that keeps them copies them. `save` is the end-of-tick save
 * when one was asked for.
 */
export interface StepResult {
  combat: CombatEvent[];
  world: WorldEvent[];
  save: Uint8Array | null;
}

export interface WorldIds {
  fighter: IdCounter;
  entity: IdCounter;
  joint: IdCounter;
  wound: IdCounter;
}

export class World implements WorldPort {
  readonly seed: number;
  /** The options the world was built with, defaults filled in (generation and the spawner read them). */
  readonly options: Readonly<Required<WorldOptions>>;
  readonly ids: WorldIds;
  readonly rngs: WorldRngs;
  readonly physics: PhysicsWorld;
  readonly queries: WorldQueries;
  readonly terrain: Terrain;
  readonly cover: GroundCover;
  readonly entities: EntityStore;
  readonly joints: JointStore;
  readonly breaking: Breaking;
  readonly loads: Loads;
  readonly felling: Felling;
  /** Seeded seedFor(seed, 'combat'); mover, ground, world, walkable, playerFighter and physicsOwnsDowned set. */
  readonly combat: CombatSim;
  readonly kcc: CharacterControllers;
  readonly zones: ZoneBodies;
  readonly downed: DownedBodies;
  readonly rulers: RulerBodies;
  readonly contacts: ContactSystem;
  readonly deaths: Deaths;
  readonly verbs: VerbSystem;
  readonly minds: MindRegistry;
  readonly noise: NoiseBus;
  readonly spawner: Spawner;
  readonly nav: NavSystem | null;
  /** === combat.commands: every input reaches the sim as a tick-tagged command pushed here. */
  readonly commands: CommandQueue;
  /** This tick's world events, in phase order (cleared at the start of step). */
  readonly events: WorldEvent[] = [];
  player: Fighter | null = null;
  /** Player number → fighter (the same Fighter object across respawns). */
  readonly players = new Map<number, Fighter>();
  /** CombatSim's mover: the ruler's mover for a ruler, the character controllers otherwise. */
  readonly mover: FighterMover;
  /** What CombatSim and footwork stand on: terrain heights, and supportAt with entities. */
  readonly ground: GroundQuery;
  /** The spawn data generation returned (null for scene 'empty'). */
  readonly spawnData: ClearingSpawnData | null;

  /** Set by a `meta 'save'` command in phase 1c; the save is written at the end of the tick (phase 19). */
  private saveDue = false;
  private disposed = false;

  /** Synchronous: physicsReady() must have resolved (createWorld awaits it). */
  constructor(o: WorldOptions) {
    if (!isPhysicsReady()) throw new Error('World: await physicsReady() first (or build worlds with createWorld)');
    const scene = o.scene ?? 'clearing';
    this.options = Object.freeze({
      seed: o.seed >>> 0,
      scene,
      terrain: o.terrain ?? (scene === 'clearing' ? 'generated' : 'flat'),
      size: o.size ?? WORLD_TUNING.clearingSize,
      nav: o.nav ?? 'full',
      player: o.player ?? true,
      sparringApe: o.sparringApe ?? false,
    });
    this.seed = this.options.seed;
    this.ids = { fighter: new IdCounter(1), entity: new IdCounter(1), joint: new IdCounter(1), wound: new IdCounter(1) };
    this.rngs = new WorldRngs(this.seed);

    // Rapier world and terrain; one empty step so the terrain is visible to queries from tick 1.
    this.physics = new PhysicsWorld();
    this.terrain = new Terrain(this.physics, this.options.size);
    this.physics.primeQueries();

    this.cover = new GroundCover(this);
    this.entities = new EntityStore(this);
    this.joints = new JointStore(this);
    this.breaking = new Breaking(this);
    this.loads = new Loads(this);
    this.felling = new Felling(this);
    this.queries = new WorldQueries(this.physics, {
      mass: (id) => this.entities.get(id)?.mass ?? 0,
      collider: (id) => this.entities.get(id)?.collider ?? null,
    });

    this.combat = new CombatSim(this.rngs.seedOf('combat'));
    this.rngs.attachCombat(this.combat.rng);
    this.commands = this.combat.commands;
    this.kcc = new CharacterControllers(this);
    this.zones = new ZoneBodies(this);
    this.downed = new DownedBodies(this);
    this.rulers = new RulerBodies(this);
    this.contacts = new ContactSystem(this);
    this.deaths = new Deaths(this);
    this.verbs = new VerbSystem(this);
    this.minds = new MindRegistry(this);
    this.noise = new NoiseBus(this);
    this.spawner = new Spawner(this);
    this.nav = this.options.nav === 'full' ? new NavSystem(this) : null;

    const kcc = this.kcc;
    const rulers = this.rulers;
    this.mover = { resolve: (f, radius, propPad) => (f.ruler ? rulers.mover : kcc).resolve(f, radius, propPad) };
    const terrain = this.terrain;
    this.ground = {
      heightAt: (x, z) => terrain.heightAt(x, z),
      supportAt: (x, z, fromY) => this.supportAt(x, z, fromY),
    };

    // The seams (§1.5.2): set before any fighter is added, so every fighter gets the ground.
    const sim = this.combat;
    sim.mover = this.mover;
    sim.ground = this.ground;
    sim.world = this;
    sim.walkable = new NavWalkable(this);
    sim.physicsOwnsDowned = true;
    sim.playerFighter = (n) => this.players.get(n);

    // Generation (entities in §6.7's fixed order), the navmesh, the player, the spawner.
    this.spawnData = this.options.scene === 'clearing' ? generateClearing(this, this.rngs.gen) : null;
    this.nav?.build(this);
    if (this.options.player) this.spawnPlayer(this.spawnData?.playerYaw ?? 0);
    this.spawner.init(this, this.spawnData);
  }

  /** === combat.frame. */
  get tick(): number {
    return this.combat.frame;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // -------------------------------------------------------------------------
  // The tick (§3)
  // -------------------------------------------------------------------------

  /** One sim tick (DT = 1/60 s). Every list is iterated in a fixed order (fighters in combat order, the rest by id). */
  step(): StepResult {
    if (this.disposed) throw new Error('World.step: the world was disposed');
    // 0
    this.events.length = 0;
    this.saveDue = false;

    // 1 COMMANDS (SPEC:696). 1a: frame++, move and button commands applied in queue order.
    const rest = this.combat.beginTick();
    const verbCmds: VerbCommand[] = [];
    const metaCmds: MetaCommand[] = [];
    for (const c of rest) {
      if (c.kind === 'verb') verbCmds.push(c);
      else if (c.kind === 'meta') metaCmds.push(c);
    }
    // 1b: validate, apply focus, buffer the rest.
    this.verbs.applyCommands(verbCmds);
    // 1c: meta commands, in queue order.
    for (const c of metaCmds) this.applyMeta(c);

    // 2 MINDS (SPEC:698).
    this.minds.sense(this);

    // 3 COMBATSIM (SPEC:699): brains, defence, attacks, verbs (WorldPort), movement resolved by the mover at the
    // separate() site (departure X1), hits, projectiles.
    const ce = this.combat.stepBody();

    // 4 BODY SYNC (SPEC:700), fighter-id order.
    this.downed.syncDown(this); // 4a
    this.verbs.onDown(this);
    this.zones.pose(this); // 4b
    this.verbs.syncHeld(this);
    this.rulers.preStep(this); // 4c
    this.kcc.applyPushes(); // 4d: code forces as impulses, in this order
    this.rulers.applyShoves();
    this.verbs.codeForces(this);
    this.joints.applyHeldEnds(this);
    this.entities.applyImpulses();
    this.joints.poseSensors(); // 4e

    // 5 PRE-STEP STORE (SPEC:279).
    this.physics.storePreStep();
    // 6 (reserved: M2 buoyancy and drag)
    // 7 (SPEC:701)
    this.physics.step();
    // 8
    this.physics.snapshotPostStep();
    const pairs = this.physics.drain();

    // 9 CONTACTS AND THE DAMAGE RULE (SPEC:701).
    this.contacts.process(this, pairs);
    // 10 ROPES
    this.joints.postStep(this);
    // 11 LOADS
    this.loads.update(this);
    // 12 BREAKING
    this.breaking.update(this);
    // 13 DOWNED, TRIPPED, FELLING
    this.downed.postStep(this); // 13a
    this.rulers.postStep(this); // 13b
    this.felling.update(this); // 13c
    // 14 WOUNDS AND RECOVERY
    for (const f of this.combat.fighters) if (f.ruler) rulerTick(f, DT);
    // 15 DEATHS
    this.deaths.update(this);
    this.spawner.update(this);
    // 16 NAVMESH
    this.nav?.rebuildDirty();
    // 17 ELEMENTS 10 Hz / TERRITORY, DECAY, TRAPLINES 1 Hz (SPEC:702): empty hooks in M1.
    if (this.tick % WORLD_TUNING.elementsPeriodTicks === 0) this.elements();
    if (this.tick % WORLD_TUNING.slowPeriodTicks === 0) this.slowSystems();
    // 17b NOISE: this tick's events and footsteps to awareness; the bus is empty afterwards.
    this.noise.collect(this, ce, this.events);
    this.noise.fold(this.minds);
    // 18
    this.entities.mirror();
    // 19 SAVE (end of tick: nothing is pending, MAP gap-7 §3.8)
    const save = this.saveDue ? serializeWorld(this) : null;
    // 20
    return { combat: ce, world: this.events, save };
  }

  // -------------------------------------------------------------------------
  // Fighters and entities
  // -------------------------------------------------------------------------

  /** combat.add + the fighter's bodies, in creation order (= id order). A creature mind joins the registry. */
  addFighter(f: Fighter, brain?: Brain | null): void {
    this.combat.add(f, brain ?? undefined);
    if (brain instanceof CreatureMind) this.minds.add(f, brain);
    if (f.ruler) this.rulers.create(f);
    else {
      this.kcc.create(f);
      this.zones.create(f);
      this.downed.create(f);
    }
  }

  removeFighter(f: Fighter): void {
    if (f.ruler) this.rulers.remove(f);
    else {
      this.downed.remove(f);
      this.zones.remove(f);
      this.kcc.remove(f);
    }
    this.minds.remove(f);
    this.combat.remove(f);
    for (const [n, p] of this.players) if (p === f) this.players.delete(n);
    if (this.player === f) this.player = null;
  }

  /** createCreature (P19): an ape or the giant ape, added to the world. */
  spawnCreature(kind: 'ape' | 'giantApe', at: { x: number; z: number }, yaw = 0): Fighter {
    return createCreature(this, kind, at, yaw);
  }

  /**
   * Moves a fighter to (x, z) on whatever supports it there (terrain, or a fixed, anchored or resting entity), facing
   * `yaw` if given, at rest. The controller's sweep is skipped for one tick (MAP gap-1 §3.6); the zone or ruler pose
   * history is reset and its contacts get a grace (§4.3), so the jump is never read as a velocity.
   */
  teleport(f: Fighter, x: number, z: number, yaw?: number): void {
    const y = this.supportAt(x, z, this.terrain.heightAt(x, z) + WORLD_TUNING.teleportProbeM);
    f.pos.set(x, y, z);
    if (yaw !== undefined) f.yaw = yaw;
    f.vel.set(0, 0, 0);
    f.walkVel.set(0, 0, 0);
    if (f.ruler) this.rulers.resetHistory(f);
    else {
      this.kcc.teleport(f, x, y, z);
      this.zones.resetHistory(f);
    }
    this.contacts.grace(f.id, this.tick + DAMAGE_TUNING.zoneGraceTicks);
  }

  /** The entity's body is created now; queries see it after the next physics step. Returns its id. */
  addEntity(spec: Parameters<EntityStore['create']>[0]): number {
    return this.entities.create(spec).id;
  }

  removeEntity(id: number): void {
    this.entities.remove(id);
  }

  /**
   * The height a body standing over (x, z) rests on: the terrain, or the top of a fixed, anchored or resting
   * (restTicks ≥ PHYSICS_TUNING.restTicks, or asleep) entity whose top is below fromY + supportReachM, found by a
   * downward ray against entities (§1.5.2, §4.7). `maxAboveTerrainM` drops supports whose top is higher than that above
   * the terrain (the ruler passes its ankle height: taller entities are obstacles, never ground); `excludeEntities`
   * leaves entities out (a cover that just broke and its pieces, §4.7 step 8).
   */
  supportAt(x: number, z: number, fromY: number, o?: { maxAboveTerrainM?: number; excludeEntities?: readonly number[] }): number {
    const ground = this.terrain.heightAt(x, z);
    const top = fromY + WORLD_TUNING.supportReachM;
    if (!(top > ground)) return ground;
    const exclude = [...(o?.excludeEntities ?? [])];
    const maxAbove = o?.maxAboveTerrainM ?? Infinity;
    for (;;) {
      const hit = this.queries.castRay({ x, y: top, z }, { x: 0, y: -1, z: 0 }, top - ground, {
        terrain: false,
        entities: 'all',
        exclude: { entities: exclude },
      });
      if (!hit || hit.owner.kind !== 'entity') return ground;
      const id = hit.owner.id;
      const e = this.entities.get(id);
      const resting =
        !!e &&
        (e.state === 'fixed' || e.state === 'anchored' || e.restTicks >= PHYSICS_TUNING.restTicks || (e.body?.isSleeping() ?? false));
      if (resting && hit.point.y - ground <= maxAbove) return Math.max(ground, hit.point.y);
      exclude.push(id);
    }
  }

  /** Frees both navmeshes and the Rapier world (the harness after each test, the client before a rebuild, RF-24). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.nav?.dispose();
    this.physics.free();
  }

  // -------------------------------------------------------------------------
  // WorldPort (CombatSim → world)
  // -------------------------------------------------------------------------

  strike(a: Fighter, prev: readonly Vector3[] | null, pts: readonly Vector3[], offs: readonly number[], w: WeaponDef | null): WorldStrike | null {
    return worldStrike(this, a, prev, pts, offs, w);
  }

  tryVerb(f: Fighter): void {
    this.verbs.tryVerb(f);
  }

  completeWork(f: Fighter): void {
    this.verbs.completeWork(f);
  }

  throwRelease(f: Fighter, m: MoveDef): boolean {
    return throwReleaseVerb(this, f, m);
  }

  projectile(p: Projectile, from: Vector3, to: Vector3): ProjectileWorldHit | null {
    return projectileHit(this, p, from, to);
  }

  onProjectileLanded(p: Projectile): boolean {
    return projectileLanded(this, p);
  }

  /** The environmental classification and credit (sim/impact.ts), then parts and death (deaths.ts). */
  onKO(d: Fighter, finish: Finish): { environmental: boolean; credit: string[] } {
    const r = isEnvironmental(d, finish, this.tick);
    this.deaths.onKO(this, d, finish);
    return r;
  }

  onWeaponDropped(f: Fighter): boolean {
    return weaponDropped(this, f);
  }

  rulerHit(
    a: Fighter,
    d: Fighter,
    m: MoveDef,
    point: Vector3,
    dir: Vector3,
    zone: HurtZone,
    bone: BoneName,
    power: number,
    haft: boolean,
    thrown: WeaponDef | null,
    ruleDamageHp: number | null,
  ): void {
    rulerHitRule(this.combat, this, a, d, m, point, dir, zone, bone, power, haft, thrown, ruleDamageHp);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The local player, player number 1 ('p1'), at the spawn (D-33) on the terrain. */
  private spawnPlayer(yaw: number): void {
    const ids = this.ids.fighter;
    const f = createPlayer({ ids, rngSeed: this.rngs.fighterSeed(ids.next) });
    f.playerId = playerIdOf(1);
    f.species = 'human';
    f.inventory = { hands: null, belt: [null, null, null], back: null };
    const x = WORLD_TUNING.spawnX;
    const z = WORLD_TUNING.spawnZ;
    f.pos.set(x, this.terrain.heightAt(x, z), z);
    f.yaw = yaw;
    this.players.set(1, f);
    this.player = f;
    this.addFighter(f, null);
    this.teleport(f, x, z, yaw);
  }

  /** Phase 1c. */
  private applyMeta(c: MetaCommand): void {
    switch (c.meta) {
      case 'save':
        this.saveDue = true;
        return;
      case 'dev':
        applyDevOp(this, c);
        return;
      case 'pause': // pausing is the game loop's (rule 8, I28)
      case 'timeAway': // M3 (I27)
        return;
    }
  }

  /** Phase 17, 10 Hz: fire, water, weather (M2). */
  private elements(): void {}

  /** Phase 17, 1 Hz: territory, decay, traplines (M3, M4). */
  private slowSystems(): void {}
}
