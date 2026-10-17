// Developer screenshots, step 1 (tools/shots/README.md): builds the test scenes' highlight moments with the sim's
// public API and writes each moment as a canonical save, plus a manifest the shooter reads.
//
//   npx vite-node tools/shots/scenes.ts [scenes...]
//
// Every scene mirrors a test in packages/sim/tests (named in the manifest): the same world options and seed, the same
// factory spawners, the same verb and move commands for the player, the same test scripting for creatures (a staring
// ape). Rule 1: nothing here is a trap type; a scene is entities, materials and verbs. Each moment is the world as it
// stands at the end of a tick, written by the sim's own save writer (serializeWorld), and checked to load again with
// loadWorld before it is listed. Scene numbers (masses, lengths, positions, tick budgets) are the tests' constants.
//
// Output (gitignored): tools/shots/out/<scene>-<moment>.json and tools/shots/out/manifest.json. Building some scenes
// keeps the other scenes' entries in the manifest.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApeMind,
  axisPitch,
  COMMAND_STEPS,
  createCreature,
  createWorld,
  DT,
  groundRestY,
  loadWorld,
  logPrism,
  LYING_ALONG_X,
  moveCommand,
  PHYSICS_TUNING,
  physicsReady,
  prismRForMass,
  serializeWorld,
  spawnGrass,
  spawnLog,
  spawnSapling,
  spawnStick,
  spawnStone,
  spawnTree,
  stickPrism,
  toCm,
  type V3,
  type VerbCommand,
  type World,
  type WorldEvent,
  type WorldOptions,
} from '@wild/sim';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

type Vec = [number, number, number];

/** Where a shot's camera stands and what it looks at (world metres); `fov` in degrees, else the game's. */
interface ShotCamera {
  pos: Vec;
  target: Vec;
  fov?: number;
}

/** The test a moment mirrors: its file and its `describe › it` name; `also`, other tests of that file it draws on. */
interface Mirror {
  file: string;
  test: string;
  also?: string[];
}

/** One saved moment, as the manifest lists it. */
interface Shot {
  scene: string;
  moment: string;
  /** `<scene>-<moment>`: the save's and the PNG's base name. */
  name: string;
  /** The save, relative to tools/shots/out. */
  save: string;
  tick: number;
  mirrors: Mirror;
  caption: string;
  camera: ShotCamera;
  /**
   * The shooter's optional second shot (`<name>-motion.png`): after the loop's dev advance of this many ticks (sim and
   * presentation stepped as in play; deterministic), or after the loop ran unpaused for `motionMs` of real time.
   */
  motionTicks?: number;
  motionMs?: number;
}

interface Manifest {
  shots: Shot[];
  skipped: { scene: string; what: string; reason: string }[];
}

/** A moment a scene captured: the save bytes and how to show them. */
interface Moment {
  moment: string;
  tick: number;
  bytes: Uint8Array;
  mirrors: Mirror;
  caption: string;
  camera: ShotCamera;
  motionTicks?: number;
  motionMs?: number;
}

/** What a scene gives back: its moments, and anything it had to leave out (with why). */
interface SceneResult {
  moments: Moment[];
  skipped: { what: string; reason: string }[];
}

interface Scene {
  name: string;
  build(): Promise<SceneResult>;
}

// ---------------------------------------------------------------------------
// Helpers (the tests' own: make, steps, until, verb, untilFree)
// ---------------------------------------------------------------------------

const live: World[] = [];
async function make(o: WorldOptions): Promise<World> {
  const w = await createWorld(o);
  live.push(w);
  return w;
}

const secs = (s: number): number => Math.round(s / DT);

function steps(w: World, n: number, each?: () => void): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let k = 0; k < n; k++) {
    each?.();
    out.push(...w.step().world);
  }
  return out;
}

/** Steps until `pred` holds after a step; returns the tick, or throws after `max` ticks. */
function until(w: World, pred: () => boolean, max: number, what: string, each?: () => void): number {
  for (let n = 0; n < max; n++) {
    each?.();
    w.step();
    if (pred()) return w.tick;
  }
  throw new Error(`${what} not reached in ${max} ticks (tick ${w.tick})`);
}

/** Queues a verb command from player 1 for the next tick (the verb tests' `verb`). */
function verb(w: World, v: Omit<VerbCommand, 'tick' | 'player' | 'kind' | 'target'> & { target?: number }): VerbCommand {
  const c = { tick: w.tick + 1, player: 1, kind: 'verb', target: 0, ...v } as VerbCommand;
  w.commands.push(c);
  return c;
}

/** Steps until the player is free with nothing buffered (at least one tick). */
function untilFree(w: World, max = 600): WorldEvent[] {
  const out: WorldEvent[] = [];
  for (let t = 0; t < max; t++) {
    out.push(...w.step().world);
    const p = w.player!;
    if (p.free && !p.verbRequest) return out;
  }
  throw new Error(`the player was not free within ${max} ticks`);
}

/** Puts the entity straight into the player's hands, then steps once (verbs.place.test.ts's `hold`). */
function hold(w: World, id: number): void {
  if (!w.verbs.putInHands(w.player!, id)) throw new Error(`putInHands refused entity ${id}`);
  w.step();
}

const verbEvents = (evs: readonly WorldEvent[], name: VerbCommand['verb']) =>
  evs.filter((e): e is Extract<WorldEvent, { type: 'verb' }> => e.type === 'verb' && e.verb === name);

function expectOk(evs: readonly WorldEvent[], name: VerbCommand['verb'], entity: number): void {
  const got = verbEvents(evs, name);
  if (got.length !== 1 || !got[0].ok || got[0].entity !== entity) throw new Error(`expected one ok ${name} of entity ${entity}, got ${JSON.stringify(got.map((e) => ({ ok: e.ok, reason: e.ok ? null : e.reason, entity: e.entity })))}`);
}

/** The save of the world as it stands (the end of its last tick). */
function moment(w: World, m: Omit<Moment, 'tick' | 'bytes'>): Moment {
  return { ...m, tick: w.tick, bytes: serializeWorld(w) };
}

const v = (p: { x: number; y: number; z: number }): Vec => [p.x, p.y, p.z];

/**
 * A camera beside the line from `a` to `b` (on the side `side` picks, +1 or −1 about +y), far enough back to frame
 * both with `margin` metres to spare, `height` above their midpoint, looking at the midpoint raised by `lookUp`.
 */
function beside(a: V3, b: V3, o: { side: 1 | -1; height: number; lookUp: number; minDist: number; margin?: number; fov?: number }): ShotCamera {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  let dx = b.x - a.x;
  let dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) [dx, dz] = [1, 0];
  else [dx, dz] = [dx / len, dz / len];
  // The perpendicular on the chosen side, turned a little toward `a` so the shot is three-quarter, not flat.
  const px = -dz * o.side;
  const pz = dx * o.side;
  const dist = Math.max(o.minDist, len * 0.9 + (o.margin ?? 2));
  const cam = { x: mid.x + (px * 0.94 - dx * 0.34) * dist, y: mid.y + o.height, z: mid.z + (pz * 0.94 - dz * 0.34) * dist };
  return { pos: v(cam), target: [mid.x, mid.y + o.lookUp, mid.z], ...(o.fov ? { fov: o.fov } : {}) };
}

/** A side-on camera `dist` m off the midpoint of `a` and `b` (on the −z side of the line from a to b), `fov` degrees. */
function sideOn(a: V3, b: V3, dist: number, height: number, lookUp: number, fov: number): ShotCamera {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const [px, pz] = [(b.z - a.z) / len, -(b.x - a.x) / len];
  return { pos: [mid.x + px * dist, mid.y + height, mid.z + pz * dist], target: [mid.x, mid.y + lookUp, mid.z], fov };
}

// ---------------------------------------------------------------------------
// The scenes
// ---------------------------------------------------------------------------

type ImpactEv = Extract<WorldEvent, { type: 'impact' }>;

/** a. contacts.test.ts, AC-6 part 2's rig: a 300 kg, 3 m log dropped onto a standing player from 3.75 m. */
const logOnPlayer: Scene = {
  name: 'log-on-player',
  async build() {
    const mirrors = {
      file: 'packages/sim/tests/contacts.test.ts',
      test: 'a log on a standing player › 300 kg arriving at the lab’s 6.2 m/s: keeps ≥ 80 % of its speed over the measured tick (AC-6, D-23), hurts, rests on the terrain',
    };
    // The 3.75 m drop (the test's); the design's 4 m is the it.fails case waiting on a P08-fix.
    const w = await make({ seed: 3, scene: 'empty', nav: 'off', size: 50 });
    const p = w.player!;
    steps(w, 10);
    const id = spawnLog(w, { p: { x: p.pos.x, y: 3.75, z: p.pos.z }, length: 3, mass: 300 });
    const spawnTick = w.tick;
    // Every tick's save from the drop on, so the mid-fall moment can be picked once the impact tick is known.
    const tape = new Map<number, Uint8Array>();
    let hit: ImpactEv | null = null;
    let arrival = 0;
    for (let t = 0; t < 80 && !hit; t++) {
      const lin = w.entities.get(id)!.vel.lin;
      arrival = Math.hypot(lin.x, lin.y, lin.z);
      const r = w.step();
      tape.set(w.tick, serializeWorld(w));
      hit = (r.world.find((e) => e.type === 'impact' && e.defender === p && e.cause.entityId === id) as ImpactEv | undefined) ?? null;
    }
    if (!hit) throw new Error('the log never hit the player');
    const hitTick = w.tick;
    const midTick = spawnTick + Math.round((hitTick - spawnTick) / 2);
    const at = { x: p.pos.x, y: 0, z: p.pos.z };
    const cam: ShotCamera = { pos: [at.x + 3.6, 2.3, at.z + 4.6], target: [at.x, 1.75, at.z] };
    const fall: Moment = {
      moment: 'mid-fall',
      tick: midTick,
      bytes: tape.get(midTick)!,
      mirrors,
      caption: `A 300 kg, 3 m log dropped from 3.75 m, half-way down to the standing player's head (tick ${midTick}).`,
      camera: { pos: [at.x + 4, 2.4, at.z + 5.2], target: [at.x, 2.0, at.z] },
      // Played on through the impact: what the presentation (ragdoll) makes of it.
      motionTicks: 30,
    };
    const impact = moment(w, {
      moment: 'impact',
      mirrors,
      caption: `The impact tick: the log meets the head at ${arrival.toFixed(2)} m/s; the damage rule (rule 2) gives ${hit.damage.toFixed(1)} damage and a ${Math.hypot(hit.dv.x, hit.dv.y, hit.dv.z).toFixed(2)} m/s knock, under launchDv: the player in ${p.state}.`,
      camera: cam,
    });
    steps(w, secs(1));
    const le = w.entities.get(id)!;
    const resting = le.pose.p.y < 0.5 && Math.hypot(le.vel.lin.x, le.vel.lin.y, le.vel.lin.z) < 0.1;
    const after = moment(w, {
      moment: '1s-after',
      mirrors,
      caption: `One second later: the log fell on through the body and ${resting ? 'rests' : 'is still moving'} on the terrain (centre ${le.pose.p.y.toFixed(2)} m up); the player is ${p.state}.`,
      camera: { pos: [at.x + 3.6, 2.0, at.z + 4.6], target: [at.x, 0.8, at.z] },
    });
    return { moments: [fall, impact, after], skipped: [] };
  },
};

/** b. apeMind.test.ts: an ape 14 m off, staring, sees the player and chases; it closes in, fights, and a blow lands. */
const apeFight: Scene = {
  name: 'ape-fight',
  async build() {
    const w = await make({ seed: 7, scene: 'empty', nav: 'full', size: 100 });
    const p = w.player!;
    const f = createCreature(w, 'ape', { x: 14, z: 0 }, -Math.PI / 2); // facing the player 14 m away
    const mind = w.minds.get(f);
    if (!(mind instanceof ApeMind)) throw new Error('not an ape mind');
    // The test's staging (`staring`): an idle ape that stays put, facing where it faces, so it notices him.
    mind.cooldownUntil = 1e9;
    mind.restUntil = 1e9;
    until(w, () => mind.state === 'chase', secs(5), 'chase');
    steps(w, secs(1));
    const chase = moment(w, {
      moment: 'chase',
      mirrors: {
        file: 'packages/sim/tests/apeMind.test.ts',
        test: 'the ape notices, investigates, chases and fights (§6.2, §6.3) › chases at gait 1.0 (faster than a run) on a path, and loses him: investigate after chaseMemoryS unseen',
      },
      caption: `The ape has seen the player and chases him on its path at ${Math.hypot(f.walkVel.x, f.walkVel.z).toFixed(2)} m/s (gait 1.0), ${f.distanceTo(p).toFixed(1)} m out.`,
      camera: sideOn(p.pos, f.pos, 13, 1.7, 0.9, 32),
    });
    // He stands his ground: it closes in, fights, and its first blow lands.
    let b: { damage: number; zone: string; move: string } | null = null;
    for (let n = 0; n < secs(30) && !b; n++) {
      for (const e of w.step().combat) if (e.type === 'hit' && e.attacker === f && e.defender === p) b = { damage: e.damage, zone: e.zone, move: e.move.id };
    }
    if (!b) throw new Error(`no blow landed on the player in 30 s (mind ${mind.state})`);
    const attack = moment(w, {
      moment: 'attack-lands',
      mirrors: {
        file: 'packages/sim/tests/apeMind.test.ts',
        test: 'the ape notices, investigates, chases and fights (§6.2, §6.3) › idle → investigate (a chop 20 m away) → chase (sees him) → fight at ≤ fightEnterM, with a shout',
        also: ['the fight (§6.3: BrawlerAI unchanged, Bruiser plan) › the sparring ape fights from spawn at close range: sparringDistM in front, engaged, it swings within 3 s (D-50)'],
      },
      caption: `In the fight (mind ${mind.state}), the ape's ${b.move} lands on the player's ${b.zone}: ${b.damage.toFixed(1)} damage, the player ${p.state}.`,
      camera: beside(p.pos, f.pos, { side: -1, height: 1.0, lookUp: 1.1, minDist: 4.2, margin: 1.5 }),
      motionTicks: 20,
    });
    return { moments: [chase, attack], skipped: [] };
  },
};

/** verbs.hands.test.ts's `log`: a dry 6-gon log of `massKg`, `length` m along x, resting on the terrain at (x, z). */
function restingLog(w: World, massKg: number, length: number, x: number, z: number): number {
  const shape = logPrism(length, prismRForMass(massKg, length, 550, PHYSICS_TUNING.logFacets));
  return spawnLog(w, { p: { x, y: groundRestY(w, x, z, shape, LYING_ALONG_X), z }, length, mass: massKg });
}

/** c. verbs.hands.test.ts: the player takes a 40 kg log onto his shoulder, and drags a 150 kg one behind him. */
const carryDrag: Scene = {
  name: 'carry-drag',
  async build() {
    const file = 'packages/sim/tests/verbs.hands.test.ts';
    // Carry: 40 kg is carried (the take test's first case).
    const w = await make({ seed: 21, scene: 'empty', nav: 'off', size: 60 });
    const p = w.player!;
    const id = restingLog(w, 40, 2.2, 0, 1.2);
    w.step();
    verb(w, { verb: 'take', target: id });
    expectOk(untilFree(w), 'take', id);
    if (p.inventory?.hands?.mode !== 'carry') throw new Error(`40 kg: hands ${p.inventory?.hands?.mode}`);
    steps(w, 30);
    const carry = moment(w, {
      moment: 'carry',
      mirrors: { file, test: 'take (§5.1): wield, carry, drag, or refused › 40 kg is carried, 41 kg dragged, 151 kg refused tooHeavy' },
      caption: `The player has taken a 40 kg, 2.2 m log onto his shoulder (take → carry, posture ${p.posture?.id}).`,
      camera: { pos: [p.pos.x + 2.6, 1.9, p.pos.z + 3.4], target: [p.pos.x, 1.2, p.pos.z] },
    });

    // Drag: the B lab as a test (150 kg, 3.6 m, taken by its +x end, walking +x for 6 s); the moment 5 s in.
    const d = await make({ seed: 31, scene: 'empty', nav: 'off', size: 60 });
    const q = d.player!;
    d.teleport(q, 0, 0, -Math.PI / 2);
    const L = 3.6;
    const heavy = restingLog(d, 150, L, -0.8 - L / 2, 0);
    d.step();
    verb(d, { verb: 'take', target: heavy });
    expectOk(untilFree(d), 'take', heavy);
    if (q.inventory?.hands?.mode !== 'drag') throw new Error(`150 kg: hands ${q.inventory?.hands?.mode}`);
    const x0 = d.entities.get(heavy)!.pose.p.x;
    steps(d, secs(5), () => d.commands.push(moveCommand(d.tick + 1, 1, 1, 0)));
    const e = d.entities.get(heavy)!;
    const logSpeed = Math.hypot(e.vel.lin.x, e.vel.lin.z);
    const drag = moment(d, {
      moment: 'drag',
      mirrors: { file, test: 'drag (§5.1): the B lab as a test › 150 kg follows at ≥ 1.5 m/s with the 600 N pull and a half-weight lift, the player tethered within 1.6 m' },
      caption: `Five seconds into a drag: a 150 kg, 3.6 m log hauled ${(e.pose.p.x - x0).toFixed(1)} m along the ground behind the player, now at ${logSpeed.toFixed(1)} m/s (600 N pull, half-weight lift).`,
      camera: beside(q.pos, e.pose.p, { side: 1, height: 1.6, lookUp: 0.6, minDist: 5.5, margin: 1.5 }),
    });
    return { moments: [carry, drag], skipped: [] };
  },
};

/** d. verbs.place.test.ts: the AC-2(a) lean on a free prop, and a point-up stake driven into dirt. */
const lean: Scene = {
  name: 'lean',
  async build() {
    const file = 'packages/sim/tests/verbs.place.test.ts';
    // The AC-2(a) lean (the test's `lean(3.71 + inradius, 32.9)`): a free 2.4 m prop set upright with drive 0, then a
    // dry hex log 5 m, 40 kg placed sloped along +x with its lower end's underside corner at the origin.
    const w = await make({ seed: 43, scene: 'empty', nav: 'off', size: 60 });
    const p = w.player!;
    const inradius = 0.07 * Math.cos(Math.PI / 8);
    const propX = 3.71 + inradius;
    const prop = spawnStick(w, { p: { x: 5, y: 0.07 + 0.01, z: -3 }, length: 2.4, r: 0.07 });
    w.step();
    w.teleport(p, propX, -1.2, 0);
    w.step();
    hold(w, prop);
    verb(w, { verb: 'place', at: toCm({ x: propX, y: 1.2, z: 0 }), yaw: 0, pitch: 64, drive: 0 });
    expectOk(untilFree(w), 'place', prop);
    steps(w, 60);
    const L = 5;
    const r = prismRForMass(40, L, 550, PHYSICS_TUNING.logFacets);
    const log = spawnLog(w, { p: { x: 2, y: r + 0.01, z: -3 }, length: L, mass: 40 });
    w.step();
    w.teleport(p, 2.0, -1.2, 0);
    w.step();
    hold(w, log);
    const pitchSteps = Math.round((32.9 / 360) * COMMAND_STEPS);
    const th = (pitchSteps / COMMAND_STEPS) * 2 * Math.PI;
    const rho = r * Math.cos(Math.PI / 6);
    const down = { x: Math.sin(th), y: -Math.cos(th) };
    const along = { x: Math.cos(th), y: Math.sin(th) };
    const lowEnd = { x: -rho * down.x, y: 0.02 - rho * down.y };
    const centre = { x: lowEnd.x + (along.x * L) / 2, y: lowEnd.y + (along.y * L) / 2, z: 0 };
    verb(w, { verb: 'place', at: toCm(centre), yaw: 64, pitch: pitchSteps });
    expectOk(untilFree(w), 'place', log);
    steps(w, 30);
    const pitchDeg = (axisPitch(w.entities.get(log)!) * 180) / Math.PI;
    const leaned = moment(w, {
      moment: 'ac2a',
      mirrors: { file, test: 'sloped (§5.7 step 2, §11.2(a)) › a 40 kg, 5 m log placed sloped onto a free 2.4 m prop rests on its lower end and the prop’s top at 32.9° and stays set 120 s awake' },
      caption: `AC-2(a): a 40 kg, 5 m log placed sloped onto a free 2.4 m prop rests on its lower end and the prop's top at ${pitchDeg.toFixed(1)}°.`,
      camera: { pos: [2.8, 2.3, 6.6], target: [2.2, 1.1, 0] },
    });

    // A point-up stake (1.4 m × r 0.05 m, sharpness 0.6) set upright on dirt: driven 0.3 m and anchored.
    const s = await make({ seed: 41, scene: 'empty', nav: 'off', size: 60 });
    const stake = spawnStick(s, { p: { x: 2, y: 0.05 + 0.01, z: 2 }, length: 1.4, r: 0.05, sharp: { end: 1, s: 0.6 } });
    s.step();
    hold(s, stake);
    verb(s, { verb: 'place', at: toCm({ x: 0, y: 0.7, z: 1.2 }), yaw: 0, pitch: 64 });
    expectOk(untilFree(s), 'place', stake);
    steps(s, 60);
    const se = s.entities.get(stake)!;
    if (se.state !== 'anchored') throw new Error(`the stake is ${se.state}, not anchored`);
    const driven = moment(s, {
      moment: 'stake',
      mirrors: { file, test: 'upright: stakes driven into soft ground, free otherwise (§5.7 step 4, D-19) › a point-up stake on dirt is driven 0.3 m and anchored: fixed, 1,200 N, static for m_eff; the bus hears it' },
      caption: `A sharpened 1.4 m stake set point-up on dirt is driven 0.3 m in and anchored (holds ${se.anchor!.capacityN.toFixed(0)} N); the player stands back.`,
      camera: { pos: [1.5, 1.25, 3.5], target: [0.1, 0.75, 0.9] },
    });
    return { moments: [leaned, driven], skipped: [] };
  },
};

/** e. terrain.test.ts: the 8 × 6 × 2.5 m pit dug by kernel and spoil alone, the player at its rim. */
const pit: Scene = {
  name: 'pit',
  async build() {
    const w = await make({ seed: 5, scene: 'empty', nav: 'off', size: 50 });
    const t = w.terrain;
    // The test's planner, applied to the world's terrain directly (the dig verb, P15, isn't merged): strike centres on
    // a 0.3 m grid over the footprint, struck in passes while the nearest vertex is above −2.48 m; each strike's
    // volume goes to the spoil point (raised there, the rest to the next point).
    const pts: [number, number][] = [];
    for (let i = 0; -3.75 + 0.3 * i <= 3.75 + 1e-9; i++) for (let j = 0; -2.75 + 0.3 * j <= 2.75 + 1e-9; j++) pts.push([-3.75 + 0.3 * i, -2.75 + 0.3 * j]);
    let strikes = 0;
    let pass = 0;
    for (; pass < 2000; pass++) {
      let any = false;
      for (const [x, z] of pts) {
        const vi = t.vertexIndex(x, z);
        if (t.vertexHeightAt(vi.gi, vi.gj) <= -2.48) continue;
        any = true;
        strikes++;
        let rest = t.lower(x, z, 1).volumeM3;
        for (let g = 0; rest > 1e-8 && g < 100; g++) {
          const sp = t.findSpoilPoint(x, z);
          if (!sp) break;
          rest -= t.raise(sp.x, sp.z, rest).raisedM3;
        }
      }
      if (!any) break;
    }
    const p = w.player!;
    // At the rim of a long side (z = 3), on the strip the spoil setback keeps clear, facing in.
    w.teleport(p, 0.6, 3.6, Math.PI);
    steps(w, 30);
    const rim = moment(w, {
      moment: 'rim',
      mirrors: { file: 'packages/sim/tests/terrain.test.ts', test: 'spoil: raise and the spoil search (§4.13, RT-2) › digs the 8 × 6 × 2.5 m pit with kernel and spoil alone within 1.2 × 3,185 = 3,822 strikes (RT-2)' },
      caption: `The 8 × 6 × 2.5 m pit dug by the cone kernel alone (${strikes} strikes in ${pass} passes), its spoil heaped beyond the 1.5 m setback; the player at the rim.`,
      camera: { pos: [1.5, 8.5, -10.5], target: [0, -1.2, 0.8] },
    });
    return { moments: [rim], skipped: [] };
  },
};

/** f. factory.test.ts: factory trees, saplings, a hanging vine, sticks and stones around the player. */
const trees: Scene = {
  name: 'trees',
  async build() {
    const skipped: SceneResult['skipped'] = [];
    const o: WorldOptions = { seed: 7, scene: 'empty', nav: 'off', size: 50 };
    // The vine needs the joint store (P10). Tried first in a throwaway world, so a refusal leaves nothing behind here.
    const vine = { anchorH: 8, lengthM: 9, yaw: 0 };
    let vineOk = false;
    {
      const probe = await createWorld({ ...o, player: false });
      try {
        spawnTree(probe, { at: { x: 0, z: 0 }, diameter: 0.4, height: 14, vine });
        vineOk = true;
      } catch (e) {
        skipped.push({ what: 'the hanging vine', reason: e instanceof Error ? e.message : String(e) });
      } finally {
        probe.dispose();
      }
    }
    const w = await make(o);
    // The tests' trees: a 30 cm × 15 m tree, a 50 cm × 12 m one, the swinging-log scene's 40 cm × 14 m with its vine.
    spawnTree(w, { at: { x: 3, z: -4 }, diameter: 0.3, height: 15 });
    spawnTree(w, { at: { x: -4.5, z: -7 }, diameter: 0.5, height: 12 });
    spawnTree(w, { at: { x: -1.2, z: -3 }, diameter: 0.4, height: 14, ...(vineOk ? { vine } : {}) });
    spawnTree(w, { at: { x: 6.5, z: -9 }, diameter: 0.3, height: 15 });
    spawnSapling(w, { at: { x: -2, z: 1.5 }, diameter: 0.06, height: 3 });
    spawnSapling(w, { at: { x: 2.4, z: -1 }, diameter: 0.06, height: 3 });
    // Sticks lying along x, a pointed stake, a 5 m dry log, stones (a throwing stone, a weight, a 40 kg rock) and flint.
    const lying = (x: number, z: number, length: number, r: number) => spawnStick(w, { p: { x, y: groundRestY(w, x, z, stickPrism(length, r), LYING_ALONG_X), z }, length, r });
    lying(1.3, 1.1, 2.4, 0.07);
    lying(-1.6, 2.6, 1.0, 0.03);
    spawnStick(w, { p: { x: 0.9, y: 0.06, z: 2.4 }, length: 1.4, r: 0.05, sharp: { end: 1, s: 0.6 } });
    const lr = prismRForMass(40, 5, 550, PHYSICS_TUNING.logFacets);
    spawnLog(w, { p: { x: -0.5, y: groundRestY(w, -0.5, -1.2, logPrism(5, lr), LYING_ALONG_X), z: -1.2 }, length: 5, mass: 40 });
    spawnStone(w, { p: { x: 1.8, y: 0.3, z: 2.0 }, mass: 0.5, proto: 0 });
    spawnStone(w, { p: { x: -0.9, y: 0.4, z: 1.9 }, mass: 3, proto: 1 });
    spawnStone(w, { p: { x: 3.2, y: 0.6, z: 0.6 }, mass: 40, proto: 2 });
    spawnStone(w, { p: { x: 2.3, y: 0.3, z: 2.6 }, mass: 0.6, proto: 0, material: 'flint' });
    spawnGrass(w, { p: { x: -2.2, y: 0.2, z: 0.4 }, mass: 4 });
    steps(w, secs(1.5));
    const mirrors: Mirror = {
      file: 'packages/sim/tests/factory.test.ts',
      test: 'trees and saplings › a 30 cm × 15 m tree is a fixed green 8-gon trunk, 738 kg above the cut',
      also: [
        'trees and saplings › a sapling is a rooted green 8-gon too',
        "hanging vines › the swinging-log scene's vine: anchored 8 m up the inner side, its end lying loose, a rope joint of vine (§11.2(c))",
      ],
    };
    const scenery = moment(w, {
      moment: 'scenery',
      mirrors,
      caption: `Factory scenery around the player: four standing trees (30-50 cm × 12-15 m) and two 3 m saplings${vineOk ? ', a vine hanging 8 m up a trunk' : ''}, with the props at his feet.`,
      camera: { pos: [7, 3.2, 15], target: [0, 5.2, -4], fov: 58 },
    });
    const ground = moment(w, {
      moment: 'ground',
      mirrors: {
        file: mirrors.file,
        test: 'sticks › an 8-gon prism of dry wood lying along x with a flat face down',
        also: [
          "sticks › a pointed stake is the Shape verb's taper with a SharpPoint at the tip (1.4 m × r 0.05 m: 5.44 → 4.79 kg)",
          "logs › a 6-gon prism by radius: the deadfall's 5 m × r 0.075 m dry log is 40 kg (§11.2(a))",
          'stones and flint › hulls of exactly their mass, compact, unrotated: throwing stones, weights, an 800 kg boulder, flint nodules',
          'boxes and grass › a grass bundle: a flat box of leaves and dry grass of its mass',
        ],
      },
      caption: 'The same tick close up: dry sticks lying along x, a pointed stake, a 5 m 40 kg log, a throwing stone, a 3 kg weight, a 40 kg rock, a flint nodule and a grass bundle, settled on the ground.',
      camera: { pos: [2.8, 2.1, 5.4], target: [0.3, 0.3, 1.0], fov: 52 },
    });
    return { moments: [scenery, ground], skipped };
  },
};

const SCENES: Scene[] = [logOnPlayer, apeFight, carryDrag, lean, pit, trees];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((n) => !SCENES.some((s) => s.name === n));
  if (unknown.length > 0) throw new Error(`unknown scene ${unknown.join(', ')}; scenes: ${SCENES.map((s) => s.name).join(', ')}`);
  const run = wanted.length === 0 ? SCENES : SCENES.filter((s) => wanted.includes(s.name));
  await physicsReady();
  mkdirSync(OUT, { recursive: true });
  const manifestPath = join(OUT, 'manifest.json');
  const old: Manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest) : { shots: [], skipped: [] };
  const built = new Set(run.map((s) => s.name));
  const keep = (x: { scene: string }) => !built.has(x.scene) && SCENES.some((s) => s.name === x.scene);
  const shots: Shot[] = (old.shots ?? []).filter(keep);
  const skipped: Manifest['skipped'] = (old.skipped ?? []).filter(keep);
  let failed = 0;
  for (const scene of run) {
    const t0 = performance.now();
    let result: SceneResult;
    try {
      result = await scene.build();
    } catch (e) {
      failed++;
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`${scene.name}: SKIPPED: ${reason}`);
      skipped.push({ scene: scene.name, what: 'the whole scene', reason });
      continue;
    } finally {
      for (const w of live.splice(0)) w.dispose();
    }
    for (const s of result.skipped) {
      console.warn(`${scene.name}: skipped ${s.what}: ${s.reason}`);
      skipped.push({ scene: scene.name, ...s });
    }
    for (const m of result.moments) {
      // A save the client couldn't load is no shot: load it back first (no navmesh: only the loader is checked).
      const back = await loadWorld(m.bytes, { nav: 'off' });
      const tick = back.tick;
      back.dispose();
      if (tick !== m.tick) throw new Error(`${scene.name}-${m.moment}: the save loads at tick ${tick}, not ${m.tick}`);
      const name = `${scene.name}-${m.moment}`;
      writeFileSync(join(OUT, `${name}.json`), m.bytes);
      const round = (c: Vec): Vec => c.map((x) => Math.round(x * 1000) / 1000) as Vec;
      shots.push({
        scene: scene.name,
        moment: m.moment,
        name,
        save: `${name}.json`,
        tick: m.tick,
        mirrors: m.mirrors,
        caption: m.caption,
        camera: { ...m.camera, pos: round(m.camera.pos), target: round(m.camera.target) },
        ...(m.motionTicks ? { motionTicks: m.motionTicks } : {}),
        ...(m.motionMs ? { motionMs: m.motionMs } : {}),
      });
      console.log(`${name}: tick ${m.tick}, ${m.bytes.length} bytes: ${m.caption}`);
    }
    console.log(`${scene.name}: built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  const order = (x: { scene: string }) => SCENES.findIndex((s) => s.name === x.scene);
  shots.sort((a, b) => order(a) - order(b));
  skipped.sort((a, b) => order(a) - order(b));
  writeFileSync(manifestPath, `${JSON.stringify({ shots, skipped } satisfies Manifest, null, 2)}\n`);
  console.log(`${shots.length} shots in ${manifestPath}${skipped.length ? `; ${skipped.length} skipped` : ''}`);
  if (failed > 0) process.exitCode = 1;
}

await main();
