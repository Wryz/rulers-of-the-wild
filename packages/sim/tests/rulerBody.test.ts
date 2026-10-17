// The ruler's hybrid body and RulerMover (docs/M1-DESIGN.md §4.7, P11): the body, AC-5's numbers on a fixture log,
// deflection, shove and block, the rim and the pit wall (RR-1), in-pit, the climb out, the ledge and cover trips (RT-1),
// the get-up over stakes (RF-1), pinned with hysteresis (D-38), the down wound (§4.6), the trip switch's momentum (RF-14),
// footfalls, teleport and the save round trip (RR-19).
import { Vector3 } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BONES } from '../src/body/skeleton';
import { canonicalJson, parseCanonicalJson } from '../src/save/canonical';
import { loadWorld } from '../src/save/load';
import type { SaveV1 } from '../src/save/schema';
import { serializeWorld } from '../src/save/serialize';
import type { Fighter } from '../src/sim/fighter';
import { DT } from '../src/sim/math';
import { newRulerState, RULER_TUNING, rulerDamage, rulerDown, rulerHeld, rulerHp } from '../src/sim/ruler';
import { SPECIES_BODY } from '../src/sim/species';
import { resetTuning } from '../src/tuning/registry';
import { NOISE_TUNING } from '../src/world/creatures/defs';
import { spawnBox, spawnLog } from '../src/world/factory';
import { physicsReady } from '../src/world/physics';
import { RULER_BODY_TUNING, rulerAnkleM, stepPinned } from '../src/world/rulerBody';
import type { ImpactCause, Quat, V3, WorldEvent } from '../src/world/types';
import { createWorld, type World, type WorldOptions } from '../src/world/world';
import { boneZoneShape } from '../src/world/zones';

// createCreature is P19's (a stub that throws until then). The loader makes a saved creature with it, so this file's
// giant is made by it: DS's bruiser at the giant ape's scale, mass and RulerState, without a mind.
vi.mock('../src/world/creatures/factory', async () => {
  const { createEnemy } = await import('../src/sim/enemies');
  const { Rng } = await import('../src/sim/math');
  const ruler = await import('../src/sim/ruler');
  const species = await import('../src/sim/species');
  return {
    createCreature(w: World, kind: 'ape' | 'giantApe', at: { x: number; z: number }, yaw: number): Fighter {
      if (kind !== 'giantApe') throw new Error(`rulerBody.test: the test factory makes only the giant ape, not ${kind}`);
      const ids = w.ids.fighter;
      const { fighter: g } = createEnemy('bruiser', new Rng(4), {}, {}, { ids, rngSeed: w.rngs.fighterSeed(ids.next) });
      const body = species.SPECIES_BODY.giantApe;
      g.scale = body.scale;
      g.massKg = body.massKg;
      g.species = 'giantApe';
      g.ruler = ruler.newRulerState(body.maxHp);
      g.autoDefense = false;
      g.pos.set(at.x, w.terrain.heightAt(at.x, at.z), at.z);
      g.yaw = yaw;
      w.addFighter(g, null);
      w.teleport(g, at.x, at.z, yaw);
      return g;
    },
  };
});

const live: World[] = [];
function track(w: World): World {
  live.push(w);
  return w;
}
async function make(o: Partial<WorldOptions> = {}): Promise<World> {
  return track(await createWorld({ seed: 7, scene: 'empty', nav: 'off', size: 100, player: false, ...o }));
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
  resetTuning();
});

const giant = (w: World, x: number, z: number, yaw = 0): Fighter => w.spawnCreature('giantApe', { x, z }, yaw);

const LOG_Z: Quat = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
const UP: Quat = { x: 0, y: 0, z: 0, w: 1 };
const EAST = Math.PI / 2;

/** Steps the world n ticks, handing each tick's events to `on`; stops early when `on` returns true. */
function run(w: World, n: number, on?: (e: readonly WorldEvent[], t: number) => boolean | void): number {
  for (let t = 0; t < n; t++) {
    w.step();
    if (on?.(w.events, t)) return t;
  }
  return n;
}

/** Lowers every terrain vertex in [x0, x1] × [z0, z1] by `depth` (a dug pit with vertical-ish walls). */
function digPit(w: World, x0: number, x1: number, z0: number, z1: number, depth: number): void {
  const t = w.terrain;
  const n1 = t.cells + 1;
  const edits: { tile: number; vertex: number; dh: number }[] = [];
  const dug: [number, number][] = [];
  for (let tile = 0; tile < t.tileCount; tile++) {
    const tx = tile % t.tilesX;
    const tz = (tile - tx) / t.tilesX;
    for (let i = 0; i < n1 * n1; i++) {
      const r = i % n1;
      const c = (i - r) / n1;
      const x = t.minX + (tx * t.cells + c) * t.spacing;
      const z = t.minZ + (tz * t.cells + r) * t.spacing;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) {
        edits.push({ tile, vertex: i, dh: -depth });
        dug.push([tile, i]);
      }
    }
  }
  t.applyEdits(edits, dug);
}

/** The giant's ruler colliders (owner part 'ruler'), in BONES order. */
function rulerColliders(w: World, g: Fighter) {
  const out: { bone: string; sensor: boolean; parentMass: number; handle: number }[] = [];
  w.physics.rapier.forEachCollider((c) => {
    const o = w.physics.ownerOf(c.handle);
    if (o?.kind === 'fighter' && o.id === g.id && o.part === 'ruler') {
      out.push({ bone: o.bone ?? '', sensor: c.isSensor(), parentMass: c.parent()!.mass(), handle: c.handle });
    }
  });
  return out.sort((a, b) => BONES.indexOf(a.bone as (typeof BONES)[number]) - BONES.indexOf(b.bone as (typeof BONES)[number]));
}

const somebody: ImpactCause = { kind: 'entity', entityId: null, fighterId: null, credit: ['p1'], held: false, feature: 'falling' };

/** The giant's ruler body (the one Rapier body all its colliders hang on). */
function rulerBodyOf(w: World, g: Fighter) {
  return w.physics.rapier.getCollider(rulerColliders(w, g)[0].handle).parent()!;
}

/** Records the velocities the ruler body is given (the trip switch's momentum fit), and still sets them. */
function spyVelocities(w: World, g: Fighter): { lin: V3[]; ang: V3[] } {
  const body = rulerBodyOf(w, g);
  const got = { lin: [] as V3[], ang: [] as V3[] };
  const setLin = body.setLinvel.bind(body);
  const setAng = body.setAngvel.bind(body);
  body.setLinvel = (v, wake) => {
    got.lin.push({ x: v.x, y: v.y, z: v.z });
    setLin(v, wake);
  };
  body.setAngvel = (v, wake) => {
    got.ang.push({ x: v.x, y: v.y, z: v.z });
    setAng(v, wake);
  };
  return got;
}

/** The giant's bone collider centres from its rig (the bone shapes' offsets, × scale), 3 numbers a bone in BONES order. */
function colliderCentres(g: Fighter): number[] {
  const out: number[] = [];
  for (const b of BONES) {
    const off = boneZoneShape(b, g.scale).off;
    const c = new Vector3(off.x, off.y, off.z).applyQuaternion(g.rig[b].rot).add(g.rig[b].pos);
    out.push(c.x, c.y, c.z);
  }
  return out;
}

/** Σ m_b (c_b − c'_b) / DT / M over the bones: the momentum fit of the motion from centres `before` to `after`. */
function massVelocity(g: Fighter, after: number[], before: number[]): V3 {
  let M = 0;
  const v = { x: 0, y: 0, z: 0 };
  BONES.forEach((b, i) => {
    const m = g.mass * g.boneShare[b];
    M += m;
    v.x += (m * (after[3 * i] - before[3 * i])) / DT;
    v.y += (m * (after[3 * i + 1] - before[3 * i + 1])) / DT;
    v.z += (m * (after[3 * i + 2] - before[3 * i + 2])) / DT;
  });
  return { x: v.x / M, y: v.y / M, z: v.z / M };
}

/** Moves a standing (idle-paused) giant rigidly by (dx, 0, 0) before the next step: the root and both feet. */
function translate(g: Fighter, dx: number): void {
  g.pos.x += dx;
  for (const side of ['L', 'R'] as const) {
    const foot = g.footwork.foot(side);
    foot.pos.x += dx;
    foot.from.x += dx;
    foot.to.x += dx;
  }
}

describe('the body (§4.7)', () => {
  it('is one body with 12 bone sensors owned by the ruler standing, solid and weighing the giant once tripped', async () => {
    const w = await make();
    const g = giant(w, 0, 0, EAST);
    run(w, 2);
    let cols = rulerColliders(w, g);
    expect(cols.map((c) => c.bone)).toEqual([...BONES]);
    expect(cols.every((c) => c.sensor)).toBe(true);
    expect(w.rulers.isDynamic(g)).toBe(false);
    // The pose is the rig's pelvis.
    const p = w.rulers.pose(g.id)!;
    expect(Math.hypot(p.p.x - g.rig.pelvis.pos.x, p.p.y - g.rig.pelvis.pos.y, p.p.z - g.rig.pelvis.pos.z)).toBeLessThan(1e-3);
    w.rulers.requestTrip(g, 'impact', null);
    run(w, 1);
    expect(g.state).toBe('tripped');
    expect(w.rulers.isDynamic(g)).toBe(true);
    cols = rulerColliders(w, g);
    expect(cols.length).toBe(12);
    expect(cols.some((c) => c.sensor)).toBe(false);
    expect(cols[0].parentMass).toBeCloseTo(SPECIES_BODY.giantApe.massKg, -1);
    expect(g.stunFrames).toBe(Math.round(RULER_BODY_TUNING.getupAfterS / DT));
  });

  it('stands a teleported ruler on a 0.3 m box (below its ankle) but never on a 1 m one', async () => {
    const w = await make();
    const low = spawnBox(w, { p: { x: -10, y: 0.15, z: 0 }, size: [4, 0.3, 4], material: 'stone', state: 'fixed', look: 'slab' });
    const high = spawnBox(w, { p: { x: 10, y: 0.5, z: 0 }, size: [4, 1, 4], material: 'stone', state: 'fixed', look: 'slab' });
    run(w, 1);
    expect(w.entities.get(low)!.pose.p.y + 0.15).toBeLessThan(rulerAnkleM(giant(w, 30, 30)));
    const a = giant(w, -10, 0);
    const b = giant(w, 10, 0);
    expect(a.pos.y).toBeCloseTo(0.3, 3);
    expect(b.pos.y).toBeCloseTo(0, 3);
    expect(w.entities.get(high)).toBeDefined();
  });
});

describe("AC-5's numbers on a fixture log (§4.7, §11.5)", () => {
  it('trips at 6 m/s, rises at +4.00 s and is up by +5.57 s, no NaN, every part under 30 m/s, all still within 10 s', async () => {
    const w = await make();
    // A fixed 300 kg log across the path, its top at the giant's shin (between its ankle and knee).
    spawnLog(w, { p: { x: 0, y: 1.0, z: 0 }, q: LOG_Z, length: 4.4, mass: 300, state: 'fixed' });
    const g = giant(w, -20, 0.3, EAST);
    g.drive = { heading: EAST, speed: 6, accel: 50, climb: false };
    let trip = -1;
    let why = '';
    let speedAtTrip = 0;
    let lastSpeed = 0;
    let rise = -1;
    let up = -1;
    let maxPart = 0;
    let lastMoving = -1;
    let finite = true;
    for (let t = 0; t < 1400; t++) {
      lastSpeed = Math.hypot(g.walkVel.x, g.walkVel.z);
      w.step();
      for (const e of w.events) {
        if (e.type === 'trip' && e.f === g) {
          trip = w.tick;
          why = e.why;
          speedAtTrip = lastSpeed;
        }
        if (e.type === 'rise' && e.f === g) {
          rise = w.tick;
          g.drive = null;
          g.idlePaused = true;
        }
      }
      if (rise > 0 && up < 0 && g.state !== 'getup') up = w.tick;
      const sp = w.rulers.partSpeeds(g);
      for (const b of BONES) finite &&= Number.isFinite(g.rig[b].pos.x + g.rig[b].pos.y + g.rig[b].pos.z);
      finite &&= sp.every(Number.isFinite);
      if (trip > 0) {
        maxPart = Math.max(maxPart, ...sp);
        if (Math.max(...sp) >= 0.05) lastMoving = w.tick;
      }
      if (trip > 0 && w.tick > trip + 660) break;
    }
    expect(why).toBe('obstacle');
    expect(speedAtTrip).toBeGreaterThan(RULER_BODY_TUNING.tripSpeed);
    expect(speedAtTrip).toBeCloseTo(6, 1);
    expect((rise - trip) * DT).toBeCloseTo(4.0, 6);
    expect(up).toBeGreaterThan(rise);
    expect((up - trip) * DT).toBeLessThanOrEqual(4 + RULER_BODY_TUNING.getupFrames * DT + 1e-9);
    expect(finite).toBe(true);
    expect(maxPart).toBeLessThan(30);
    expect(lastMoving).toBeGreaterThan(rise);
    expect((lastMoving - trip) * DT).toBeLessThan(10);
    expect(g.state).not.toBe('tripped');
  });
});

describe('deflection (§4.7 step 6)', () => {
  /** A 16 m wall along +x; the giant driven at it `deg` off the wall, meeting it mid-wall. */
  async function atWall(deg: number) {
    const w = await make();
    spawnBox(w, { p: { x: 8, y: 0.5, z: 0 }, size: [16, 1.0, 0.44], material: 'dryWood', state: 'fixed', look: 'wall' });
    const a = (deg * Math.PI) / 180;
    const yaw = Math.atan2(Math.cos(a), Math.sin(a));
    const g = giant(w, 6 - 14 * Math.cos(a), -1.95 - 14 * Math.sin(a), yaw);
    g.drive = { heading: yaw, speed: 6, accel: 50, climb: false };
    return { w, g };
  }

  it('slides along a wall met 20° off at 5.64 m/s (6 cos 20°), heading within 0.2° of the wall, and reports the heading', async () => {
    const { w, g } = await atWall(20);
    let first = -1;
    let along = { x: 0, y: 0, z: 0 };
    let tripped = false;
    run(w, 400, (ev) => {
      for (const e of ev) {
        if (e.type === 'deflect' && first < 0) {
          first = w.tick;
          along = e.along;
        }
        if (e.type === 'trip') tripped = true;
      }
      return first > 0 && w.tick >= first + 29;
    });
    expect(tripped).toBe(false);
    expect(first).toBeGreaterThan(0);
    expect(Math.abs(along.z)).toBeLessThan(1e-6);
    const x0 = g.pos.x;
    const z0 = g.pos.z;
    run(w, 1);
    const vx = (g.pos.x - x0) / DT;
    const vz = (g.pos.z - z0) / DT;
    expect(Math.hypot(vx, vz)).toBeCloseTo(6 * Math.cos((20 * Math.PI) / 180), 1);
    expect(Math.abs((Math.atan2(vz, vx) * 180) / Math.PI)).toBeLessThan(0.2);
    expect(g.ruler!.deflectedHeading).toBeCloseTo(EAST, 6);
  });

  it('trips on the same wall met 45° off', async () => {
    const { w, g } = await atWall(45);
    let why = '';
    run(w, 400, (ev) => {
      for (const e of ev) if (e.type === 'trip' && e.f === g) why = e.why;
      return why !== '';
    });
    expect(why).toBe('obstacle');
    expect(g.state).toBe('tripped');
  });
});

describe('shove and block (§4.7 steps 5-6)', () => {
  it('shoves a tall body under 500 kg aside with a shove event, and is blocked by a 4.5 t boulder without tripping', async () => {
    for (const heavy of [false, true]) {
      const w = await make();
      const id = heavy
        ? spawnBox(w, { p: { x: 0, y: 0.6, z: 0 }, size: [1.2, 1.2, 1.2], material: 'stone', look: 'boulder' })
        : spawnBox(w, { p: { x: 0, y: 0.6, z: 0 }, size: [0.8, 1.2, 0.8], material: 'dryWood', look: 'crate' });
      run(w, 40);
      const e0 = { ...w.entities.get(id)!.pose.p };
      const mass = w.entities.get(id)!.mass;
      expect(mass < RULER_BODY_TUNING.shoveLimitKg).toBe(!heavy);
      const g = giant(w, -8, 0, EAST);
      g.drive = { heading: EAST, speed: 2, accel: 5, climb: false };
      let shoves = 0;
      let trips = 0;
      run(w, 400, (ev) => {
        for (const e of ev) {
          if (e.type === 'shove' && e.ruler === g && e.entity === id) shoves++;
          if (e.type === 'trip') trips++;
        }
      });
      const e1 = w.entities.get(id)!.pose.p;
      expect(trips).toBe(0);
      if (heavy) {
        expect(shoves).toBe(0);
        expect(Math.hypot(e1.x - e0.x, e1.z - e0.z)).toBeLessThan(0.01);
        expect(g.pos.x).toBeLessThan(e0.x - 0.6);
        expect(Math.hypot(g.walkVel.x, g.walkVel.z)).toBeLessThan(0.01);
      } else {
        expect(shoves).toBeGreaterThan(0);
        expect(Math.hypot(e1.x - e0.x, e1.z - e0.z)).toBeGreaterThan(0.5);
        expect(g.pos.x).toBeGreaterThan(e0.x);
      }
    }
  });
});

describe('the rim, the pit wall, in-pit and the climb out (RR-1, RF-14)', () => {
  it('a giant driven straight at the 18 m rim is blocked and never climbs it', async () => {
    const w = await make();
    // A 55° rim rising from x = 10 to 18 m.
    w.terrain.generate((x) => (x > 10 ? Math.min(18, (x - 10) * Math.tan((55 * Math.PI) / 180)) : 0));
    run(w, 1);
    const g = giant(w, 0, 0, EAST);
    g.drive = { heading: EAST, speed: 7, accel: 5, climb: false };
    let maxY = -Infinity;
    let trips = 0;
    run(w, 400, (ev) => {
      maxY = Math.max(maxY, g.pos.y);
      for (const e of ev) if (e.type === 'trip') trips++;
    });
    expect(maxY).toBeLessThan(RULER_BODY_TUNING.stepUpMaxM);
    expect(g.pos.x).toBeLessThan(10.5);
    expect(trips).toBe(0);
    expect(g.state).not.toBe('tripped');
  });

  it('in a 2.5 m pit: the wall blocks it; it is rulerDown; it gets up inside still down, and climbs out at ≤ 0.4 m/s', async () => {
    const w = await make();
    digPit(w, -4, 4, -3, 3, 2.5);
    run(w, 1);
    const g = giant(w, 0, 0, EAST);
    expect(g.pos.y).toBeCloseTo(-2.5, 3);
    g.drive = { heading: EAST, speed: 2, accel: 5, climb: false };
    let maxY = -Infinity;
    run(w, 300, () => {
      maxY = Math.max(maxY, g.pos.y);
    });
    expect(maxY).toBeLessThan(-2.5 + RULER_BODY_TUNING.stepUpMaxM);
    expect(g.pos.x).toBeLessThan(4.5);
    expect(g.pos.x).toBeGreaterThan(2);
    expect(g.ruler!.inPit).toBe(true);
    expect(rulerDown(g)).toBe(true);
    expect(rulerHeld(g)).toBe(true);
    // Tripped in the pit and up again: still in it, still down.
    g.drive = null;
    w.rulers.requestTrip(g, 'impact', null);
    let trip = -1;
    let rise = -1;
    run(w, 400, (ev) => {
      for (const e of ev) {
        if (e.type === 'trip' && e.f === g) trip = w.tick;
        if (e.type === 'rise' && e.f === g) rise = w.tick;
      }
    });
    expect(trip).toBeGreaterThan(0);
    expect(rise - trip).toBe(Math.round(RULER_BODY_TUNING.getupAfterS / DT));
    expect(g.state).not.toBe('tripped');
    expect(g.ruler!.inPit).toBe(true);
    expect(rulerDown(g)).toBe(true);
    // Climbing out (the mind's climb drive): never faster than climbRateMps up, and out.
    g.drive = { heading: EAST, speed: RULER_BODY_TUNING.climbWalkMps, accel: 5, climb: true };
    let maxRate = 0;
    let out = -1;
    let pitOff = false;
    let py = g.pos.y;
    run(w, 1500, (ev, t) => {
      maxRate = Math.max(maxRate, (g.pos.y - py) / DT);
      py = g.pos.y;
      for (const e of ev) if (e.type === 'pit' && e.f === g && !e.on) pitOff = true;
      if (out < 0 && !g.ruler!.inPit) out = t;
    });
    expect(maxRate).toBeGreaterThan(0.3);
    expect(maxRate).toBeLessThanOrEqual(RULER_BODY_TUNING.climbRateMps + 1e-6);
    expect(pitOff).toBe(true);
    expect(out).toBeGreaterThan(0);
    expect(g.ruler!.inPit).toBe(false);
    expect(rulerDown(g)).toBe(false);
    expect(g.pos.y).toBeCloseTo(0, 1);
    expect(g.pos.x).toBeGreaterThan(4);
  });

  it('driven as the mind drives it (climb only while ruler.inPit, §6.4): down every tick until on the rim, one pit event, out', async () => {
    const w = await make();
    digPit(w, -4, 4, -3, 3, 2.5);
    run(w, 1);
    const g = giant(w, 0, 0, EAST);
    run(w, 1);
    expect(g.ruler!.inPit).toBe(true);
    const mind = (): void => {
      g.drive = { heading: EAST, speed: RULER_BODY_TUNING.climbWalkMps, accel: 5, climb: g.ruler!.inPit };
    };
    mind();
    const pits: boolean[] = [];
    let upBelowRim = 0;
    let out = -1;
    let outAt = { x: Number.NaN, y: Number.NaN };
    run(w, 1500, (ev, t) => {
      for (const e of ev) if (e.type === 'pit' && e.f === g) pits.push(e.on);
      // Anywhere below the rim (the original ground is at 0 here), on the floor or on the wall it climbs: down.
      if (g.pos.y < -0.01 && !rulerDown(g)) upBelowRim++;
      if (out < 0 && !g.ruler!.inPit) {
        out = t;
        outAt = { x: g.pos.x, y: g.pos.y };
      }
      mind();
    });
    // In-pit went off once (no flicker on the wall), with the root on the rim past the wall's top, and it walked on.
    expect(pits).toEqual([false]);
    expect(upBelowRim).toBe(0);
    expect(out).toBeGreaterThan(0);
    expect(outAt.y).toBeGreaterThan(-0.01);
    expect(outAt.x).toBeGreaterThan(4);
    expect(g.ruler!.inPit).toBe(false);
    expect(rulerDown(g)).toBe(false);
    expect(g.pos.y).toBeCloseTo(0, 6);
    expect(g.pos.x).toBeGreaterThan(outAt.x + 2);
  });
});

describe('the ledge and the cover (§4.7 steps 7-8, RT-1)', () => {
  /** A 2.5 m pit 8 × 6 m at the origin, covered or not, and the giant walking east at it from 14 m. */
  async function atPit(covered: boolean) {
    const w = await make();
    digPit(w, -4, 4, -3, 3, 2.5);
    // A 10 × 8 m deck of dry wood resting on the rim all round.
    const cover = covered ? spawnBox(w, { p: { x: 0, y: 0.1, z: 0 }, size: [10, 0.2, 8], material: 'dryWood', look: 'plank' }) : -1;
    run(w, 40);
    const g = giant(w, -14, 0, EAST);
    g.drive = { heading: EAST, speed: 2, accel: 5, climb: false };
    return { w, g, cover };
  }

  it("an uncovered 2.5 m hole trips it 'ledge' (no cause)", async () => {
    const { w, g } = await atPit(false);
    let trip: Extract<WorldEvent, { type: 'trip' }> | null = null;
    run(w, 600, (ev) => {
      for (const e of ev) if (e.type === 'trip' && e.f === g) trip = { ...e };
      return trip !== null;
    });
    expect(trip).not.toBeNull();
    expect(trip!.why).toBe('ledge');
    expect(trip!.cause).toBeNull();
    expect(trip!.at.x).toBeLessThan(-2);
  });

  it("a covered pit is ground until its cover breaks under the feet; then the trip is 'cover', the cover its cause", async () => {
    const { w, g, cover } = await atPit(true);
    expect(w.entities.get(cover)!.restTicks).toBeGreaterThan(0);
    // The load break of phase 12 (P10's loads and breaking split the deck under a 14 t foot load; here the deck goes
    // in that phase once the giant stands on its middle, which is what the ruler sees of a break).
    const orig = w.breaking.update.bind(w.breaking);
    let onCover = Number.NaN;
    w.breaking.update = (ww: World) => {
      orig(ww);
      if (g.pos.x > 0 && w.entities.get(cover)) {
        onCover = g.pos.y;
        w.removeEntity(cover);
      }
    };
    let trip: Extract<WorldEvent, { type: 'trip' }> | null = null;
    let minY = Infinity;
    run(w, 900, (ev) => {
      for (const e of ev) if (e.type === 'trip' && e.f === g) trip = { ...e, cause: e.cause ? { ...e.cause } : null };
      // (Standing: once tripped, f.pos is the ground under the lying pelvis.)
      if (!trip) minY = Math.min(minY, g.pos.y);
      return trip !== null;
    });
    // Walked over the hole on the deck (its top 0.2 m up), never down into it.
    expect(onCover).toBeCloseTo(0.2, 2);
    expect(minY).toBeGreaterThan(-0.01);
    expect(trip).not.toBeNull();
    expect(trip!.why).toBe('cover');
    expect(trip!.cause).toMatchObject({ kind: 'entity', entityId: cover, feature: 'cover' });
    expect(g.ruler!.downCause).toMatchObject({ entityId: cover, feature: 'cover' });
  });
});

describe('the get-up over stakes (RF-1)', () => {
  it('scores 0 HP: the sensors come back inside fixed stakes under a contact grace', async () => {
    const w = await make();
    for (let i = -6; i <= 6; i++) {
      for (let k = -6; k <= 6; k++) spawnLog(w, { p: { x: i, y: 0.3, z: k }, q: UP, length: 0.6, r: 0.06, state: 'fixed' });
    }
    const g = giant(w, 0.5, 0.5, EAST);
    run(w, 1);
    w.rulers.requestTrip(g, 'impact', null);
    let rise = -1;
    let hpBefore = Number.NaN;
    let overlaps = 0;
    const scored: number[] = [];
    run(w, 400, (ev) => {
      for (const e of ev) {
        if (e.type === 'rise' && e.f === g) rise = w.tick;
        if (rise > 0 && e.type === 'impact' && e.defender === g) scored.push(e.damage);
      }
      if (rise < 0) hpBefore = rulerHp(g.ruler!);
      if (rise > 0 && w.tick <= rise + 2) {
        // The stakes the standing sensors are inside of just after the rise.
        for (const c of rulerColliders(w, g)) {
          w.physics.rapier.intersectionPairsWith(w.physics.rapier.getCollider(c.handle), (o) => {
            if (w.physics.ownerOf(o.handle)?.kind === 'entity') overlaps++;
          });
        }
      }
      return rise > 0 && w.tick >= rise + 120;
    });
    expect(rise).toBeGreaterThan(0);
    expect(overlaps).toBeGreaterThan(0);
    expect(scored).toEqual([]);
    expect(rulerHp(g.ruler!)).toBe(hpBefore);
  });
});

describe('pinned (D-38, with hysteresis)', () => {
  it('stepPinned: on at ≥ pinnedKg, off only after unpinTicks ticks in a row under unpinnedKg', () => {
    const T = RULER_TUNING;
    const r = newRulerState(12000);
    stepPinned(r, T.pinnedKg - 1);
    expect(r.pinned).toBe(false);
    stepPinned(r, T.pinnedKg);
    expect(r.pinned).toBe(true);
    // Between the two marks it stays on, and the count doesn't start.
    stepPinned(r, (T.pinnedKg + T.unpinnedKg) / 2);
    expect(r.pinned).toBe(true);
    expect(r.unpinTicks).toBe(0);
    for (let i = 1; i < T.unpinTicks; i++) {
      stepPinned(r, 0);
      expect(r.pinned).toBe(true);
      expect(r.unpinTicks).toBe(i);
    }
    // A tick back at the unpinned mark restarts the count.
    stepPinned(r, T.unpinnedKg);
    expect(r.unpinTicks).toBe(0);
    for (let i = 1; i < T.unpinTicks; i++) stepPinned(r, T.unpinnedKg - 1);
    expect(r.pinned).toBe(true);
    stepPinned(r, T.unpinnedKg - 1);
    expect(r.pinned).toBe(false);
    expect(r.pinnedKg).toBe(T.unpinnedKg - 1);
    // Off, the in-between weight doesn't pin it again.
    stepPinned(r, (T.pinnedKg + T.unpinnedKg) / 2);
    expect(r.pinned).toBe(false);
  });

  it('a 2.2 t lid pins a tripped giant, which waits to rise until unpinTicks after the lid is gone; the lid is downCause', async () => {
    const w = await make();
    const g = giant(w, 0, 0, EAST);
    run(w, 1);
    w.rulers.requestTrip(g, 'impact', null);
    let trip = -1;
    let lid = -1;
    let pinnedAt = -1;
    let removedAt = -1;
    let unpinnedAt = -1;
    let rise = -1;
    let heldWhilePinned = true;
    let causeWhilePinned: ImpactCause | null = null;
    run(w, 700, (ev) => {
      for (const e of ev) {
        if (e.type === 'trip' && e.f === g) trip = w.tick;
        if (e.type === 'pinned' && e.f === g && e.on) pinnedAt = w.tick;
        if (e.type === 'pinned' && e.f === g && !e.on) unpinnedAt = w.tick;
        if (e.type === 'rise' && e.f === g) rise = w.tick;
      }
      if (g.ruler!.pinned) heldWhilePinned &&= rulerHeld(g) && g.state === 'tripped';
      if (trip > 0 && w.tick === trip + 120) {
        let top = -Infinity;
        for (const b of BONES) top = Math.max(top, g.rig[b].pos.y);
        const c = g.rig.abdomen.pos;
        lid = spawnBox(w, { p: { x: c.x, y: top + 0.3, z: c.z }, size: [10, 0.04, 10], material: 'dryWood', look: 'lid' });
      }
      if (trip > 0 && w.tick === trip + 360 && g.ruler!.pinned) {
        causeWhilePinned = g.ruler!.downCause ? { ...g.ruler!.downCause } : null;
        removedAt = w.tick;
        w.removeEntity(lid);
      }
      return rise > 0;
    });
    expect(w.entities.get(lid)).toBeUndefined();
    expect(pinnedAt).toBeGreaterThan(trip + 120);
    expect(pinnedAt).toBeLessThan(trip + 160);
    expect(heldWhilePinned).toBe(true);
    expect(causeWhilePinned).toMatchObject({ kind: 'entity', entityId: lid, feature: 'falling' });
    // Past getupAfterS while pinned; up as soon as the pin lets go.
    expect(removedAt - trip).toBeGreaterThan(Math.round(RULER_BODY_TUNING.getupAfterS / DT));
    expect(unpinnedAt - removedAt).toBe(RULER_TUNING.unpinTicks);
    expect(rise).toBe(unpinnedAt);
  });

  it('the wound a pinning body opened is downWound when nothing put it down before (§4.6)', async () => {
    const w = await make();
    const g = giant(w, 0, 0, EAST);
    run(w, 1);
    w.rulers.requestTrip(g, 'impact', null);
    let trip = -1;
    let lid = -1;
    let pinnedAt = -1;
    let downBefore: number | null = -1;
    const wounds: { id: number; entity: number | null; tick: number; byWorld: boolean }[] = [];
    run(w, 400, (ev) => {
      for (const e of ev) {
        if (e.type === 'trip' && e.f === g) trip = w.tick;
        if (e.type === 'pinned' && e.f === g && e.on) pinnedAt = w.tick;
        if (e.type === 'wound' && e.ruler === g) wounds.push({ id: e.wound.id, entity: e.wound.cause.entityId, tick: w.tick, byWorld: e.byWorld });
      }
      if (trip > 0 && w.tick === trip + 120) {
        downBefore = g.ruler!.downWound;
        let top = -Infinity;
        for (const b of BONES) top = Math.max(top, g.rig[b].pos.y);
        const c = g.rig.abdomen.pos;
        // A 10 t stone slab dropped 3 m: the blow opens a wound (15 kJ on the skull), then the slab lies on the giant.
        lid = spawnBox(w, { p: { x: c.x, y: top + 3, z: c.z }, size: [10, 0.1, 10], material: 'stone', look: 'slab' });
      }
      return pinnedAt > 0 && w.tick > pinnedAt + 5;
    });
    expect(downBefore).toBeNull();
    expect(pinnedAt).toBeGreaterThan(0);
    const byLid = wounds.filter((x) => x.entity === lid);
    expect(byLid.length).toBeGreaterThan(0);
    expect(byLid.every((x) => x.byWorld)).toBe(true);
    const down = byLid.filter((x) => x.tick <= pinnedAt).at(-1)!.id;
    expect(g.ruler!.downWound).toBe(down);
    expect(g.ruler!.downCause).toMatchObject({ kind: 'entity', entityId: lid });
    // A later wound doesn't move it; finishing damage goes into it.
    const later = rulerDamage(w, g, 2000, 'back', 'chest', somebody, g.rig.chest.pos.clone());
    expect(later).not.toBeNull();
    expect(g.ruler!.downWound).toBe(down);
    const before = g.ruler!.wounds.find((x) => x.id === down)!.hp;
    rulerDamage(w, g, 100, 'flanks', 'abdomen', somebody, g.rig.abdomen.pos.clone());
    expect(g.ruler!.wounds.find((x) => x.id === down)!.hp).toBeCloseTo(before + 100, 9);
  });
});

describe('the down wound (§4.6, SPEC:505)', () => {
  it("is the wound the trip tick's impact opened (the trip cause's); a later wound doesn't move it; a small hit finishes into it", async () => {
    const w = await make();
    const log = spawnLog(w, { p: { x: 20, y: 0.3, z: 20 }, q: LOG_Z, length: 3, mass: 600, state: 'fixed' });
    const g = giant(w, 0, 0, EAST);
    run(w, 2);
    const r = g.ruler!;
    const byLog: ImpactCause = { kind: 'entity', entityId: log, fighterId: null, credit: ['p1'], held: false, feature: 'falling' };
    // Tick N: the log's impact opens a wound and trips the giant ('impact'); something else wounds it on the same tick.
    const tick = w.tick;
    const wound = rulerDamage(w, g, 500, 'knees', 'shinL', byLog, g.rig.shinL.pos.clone())!;
    const other = rulerDamage(w, g, 300, 'leg', 'shinR', somebody, g.rig.shinR.pos.clone())!;
    expect(wound.tick).toBe(tick);
    expect(other.tick).toBe(tick);
    w.rulers.requestTrip(g, 'impact', byLog);
    expect(r.downWound).toBeNull();
    let trip: Extract<WorldEvent, { type: 'trip' }> | null = null;
    run(w, 1, (ev) => {
      for (const e of ev) if (e.type === 'trip' && e.f === g) trip = { ...e };
    });
    expect(trip).not.toBeNull();
    expect(trip!.why).toBe('impact');
    expect(g.state).toBe('tripped');
    expect(r.downWound).toBe(wound.id);
    expect(r.downCause).toEqual(byLog);
    // A later wound, even by the same log, is its own: the down wound stays.
    const later = rulerDamage(w, g, 2000, 'back', 'chest', byLog, g.rig.chest.pos.clone())!;
    expect(later.id).not.toBe(wound.id);
    expect(r.downWound).toBe(wound.id);
    // A hit below the wound threshold is finishing damage on the down wound (nothing recovers).
    const before = wound.hp;
    const unhealed = r.unhealed;
    expect(rulerDamage(w, g, 100, 'flanks', 'abdomen', somebody, g.rig.abdomen.pos.clone())).toBeNull();
    expect(wound.hp).toBeCloseTo(before + 100, 9);
    expect(r.unhealed).toBe(unhealed);
  });
});

describe('the trip switch (§4.7, RF-14)', () => {
  it("carries the previous tick's motion of the walking rig into the body, not an older tick's", async () => {
    const w = await make();
    const g = giant(w, -30, 0, EAST);
    g.drive = { heading: EAST, speed: 6, accel: 50, climb: false };
    run(w, 157);
    const got = spyVelocities(w, g);
    const c0 = colliderCentres(g);
    run(w, 1);
    const c1 = colliderCentres(g);
    run(w, 1);
    const c2 = colliderCentres(g);
    w.rulers.requestTrip(g, 'impact', null);
    run(w, 1);
    expect(g.state).toBe('tripped');
    expect(got.lin).toHaveLength(1);
    const prev = massVelocity(g, c2, c1);
    const older = massVelocity(g, c1, c0);
    const lin = got.lin[0];
    expect(Math.hypot(lin.x - prev.x, lin.y - prev.y, lin.z - prev.z)).toBeLessThan(1e-9);
    // (The DS stride swings the whole 5.5× body: the pairs differ, so the check above tells them apart.)
    expect(Math.hypot(older.x - prev.x, older.y - prev.y, older.z - prev.z)).toBeGreaterThan(0.05);
    expect(got.ang.every((a) => [a.x, a.y, a.z].every(Number.isFinite))).toBe(true);
  });

  it('a giant moving steadily over a pit cover keeps its velocity when the cover goes; the drop does not leak in (vy ≈ 0)', async () => {
    const w = await make();
    digPit(w, -4, 4, -3, 3, 2.5);
    const cover = spawnBox(w, { p: { x: 0, y: 0.1, z: 0 }, size: [10, 0.2, 8], material: 'dryWood', look: 'plank' });
    run(w, 40);
    const g = giant(w, -14, 0, EAST);
    g.drive = { heading: EAST, speed: 2, accel: 5, climb: false };
    run(w, 900, () => g.pos.x > -1);
    // On the cover over the hole: stop, hold still, then move rigidly at 3 m/s (root and feet together).
    g.drive = null;
    g.idlePaused = true;
    run(w, 90);
    expect(g.pos.y).toBeCloseTo(0.2, 3);
    const got = spyVelocities(w, g);
    const v = 3;
    for (let k = 0; k < 6; k++) {
      translate(g, v * DT);
      run(w, 1);
    }
    const pelvisY = g.rig.pelvis.pos.y;
    // The cover goes before the next step: the giant's ground drops 2.7 m under it on the trip tick.
    translate(g, v * DT);
    w.removeEntity(cover);
    let why = '';
    run(w, 1, (ev) => {
      for (const e of ev) if (e.type === 'trip' && e.f === g) why = e.why;
    });
    expect(why).toBe('cover');
    expect(got.lin).toHaveLength(1);
    const lin = got.lin[0];
    const ang = got.ang[0];
    expect(lin.x).toBeCloseTo(v, 1);
    expect(Math.abs(lin.y)).toBeLessThan(0.05);
    expect(Math.abs(lin.z)).toBeLessThan(0.05);
    expect(Math.hypot(ang.x, ang.y, ang.z)).toBeLessThan(0.05);
    // The body starts where the pelvis stood (one physics step of gravity later), not 2.7 m lower.
    expect(Math.abs(w.rulers.pose(g.id)!.p.y - pelvisY)).toBeLessThan(0.05);
  });
});

describe('footfalls', () => {
  it("a walking giant's feet set down are this tick's footwork.landed, heard as its footsteps; never `land` events", async () => {
    const w = await make();
    const g = giant(w, -10, 0, EAST);
    g.drive = { heading: EAST, speed: 2, accel: 5, climb: false };
    const noises: { kind: string; radius: number }[] = [];
    const emit = w.noise.emit.bind(w.noise);
    w.noise.emit = (n) => {
      if (n.source === g.id) noises.push({ kind: n.kind, radius: n.radius });
      emit(n);
    };
    let set = 0;
    let maxLanded = 0;
    let lands = 0;
    run(w, 400, (ev) => {
      set += g.footwork.landed.length;
      maxLanded = Math.max(maxLanded, g.footwork.landed.length);
      lands += ev.filter((e) => e.type === 'land' && e.f === g).length;
    });
    expect(set).toBeGreaterThan(4);
    expect(maxLanded).toBeLessThanOrEqual(2);
    expect(lands).toBe(0);
    // One walking footstep (§6.2: 6 m × scale) per foot set down, and no heavy landing (a 2 t leg would be heard at 120 m).
    expect(noises.length).toBe(set);
    expect(noises.every((n) => n.kind === 'step' && n.radius === NOISE_TUNING.stepWalk * g.scale)).toBe(true);
    // A foot set down by an earlier tick never comes back as this tick's.
    g.drive = null;
    g.idlePaused = true;
    run(w, 120);
    g.footwork.landed.push('L', 'R');
    run(w, 1);
    expect(g.footwork.landed).toEqual([]);
  });
});

describe('save → load → save (RR-19)', () => {
  it('keeps a standing and a tripped ruler with wounds byte for byte, and the loaded ones go on as the originals do', async () => {
    const w = await make();
    const a = giant(w, -12, 0, EAST);
    const b = giant(w, 12, 0, 0);
    run(w, 2);
    for (const g of [a, b]) {
      rulerDamage(w, g, 400, 'leg', 'shinL', somebody, g.rig.shinL.pos.clone());
      rulerDamage(w, g, 2000, 'back', 'chest', { ...somebody, credit: ['p2'] }, g.rig.chest.pos.clone().add(new Vector3(0, 0.5, 0)));
      rulerDamage(w, g, 50, 'belly', 'abdomen', somebody, g.rig.abdomen.pos.clone());
    }
    a.drive = { heading: EAST, speed: 2, accel: 5, climb: false };
    w.rulers.requestTrip(b, 'impact', somebody);
    run(w, 60);
    expect(w.rulers.isDynamic(a)).toBe(false);
    expect(w.rulers.isDynamic(b)).toBe(true);
    expect(a.ruler!.wounds.length).toBe(2);
    expect(b.ruler!.wounds.length).toBe(2);
    const bytes = serializeWorld(w);
    const l = track(await loadWorld(bytes, { nav: 'off' }));
    const again = serializeWorld(l);
    const sa = parseCanonicalJson(new TextDecoder().decode(bytes)) as unknown as SaveV1;
    const sb = parseCanonicalJson(new TextDecoder().decode(again)) as unknown as SaveV1;
    for (const k of ['fighters', 'rulers', 'entities', 'counters', 'rng', 'contacts'] as const) expect(canonicalJson(sb[k]), k).toBe(canonicalJson(sa[k]));
    const rulers = (s: SaveV1) => canonicalJson(s.bodies.map((x) => [x.fighter, x.ruler ?? null]));
    expect(sa.bodies.filter((x) => x.ruler).length).toBe(2);
    expect(rulers(sb)).toBe(rulers(sa));
    const la = l.combat.fighters.find((f) => f.id === a.id)!;
    const lb = l.combat.fighters.find((f) => f.id === b.id)!;
    expect(l.rulers.isDynamic(la)).toBe(false);
    expect(l.rulers.isDynamic(lb)).toBe(true);
    expect(lb.state).toBe('tripped');
    expect(lb.ruler!.wounds).toEqual(b.ruler!.wounds);
    expect(lb.ruler!.downCause).toEqual(b.ruler!.downCause);
    // Both go on: the tripped one rises on the same tick in both worlds, the standing one walks on with its twin.
    const riseAt = (x: World, f: Fighter): number => {
      let at = -1;
      run(x, 400, (ev) => {
        for (const e of ev) if (e.type === 'rise' && e.f === f) at = x.tick;
        return at > 0;
      });
      return at;
    };
    const t1 = riseAt(w, b);
    const t2 = riseAt(l, lb);
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBe(t1);
    expect(Math.hypot(la.pos.x - a.pos.x, la.pos.z - a.pos.z)).toBeLessThan(0.01);
    expect(la.ruler!.wounds).toEqual(a.ruler!.wounds);
  });
});
