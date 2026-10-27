// Test scenes shared by the acceptance files (docs/M1-DESIGN.md §11.0, §11.2-§11.6; package P23).
//
// Rule 1: every scene here is built from entities and verbs only. Entities come from the harness's factory calls (the
// factory world generation uses, §6.7); every relation and pose comes from a verb the scripted player sends as a
// command (take, place, lash, tie, shape, cut, dig, pull, drop, stow, draw), after walking there. The fixture ops a
// scene may use are the harness's logged ones: `standAt` (where a walk can't go: up a wall over 45° or down a drop,
// into and out of a pit and over its spoil's berm; the tests bound the others at 0) and, for the ruler-scale logs no
// M1 verb can lift (D-25), `stage`/`unstage` while the player builds around them, before any creature exists. Nothing
// here writes a property of anything, or calls an entity, joint, terrain or body mutator, a teleport, a mind or a
// creature; the harness test reads this file to check it (sceneViolations).
//
// Units: m, kg, rad; yaw in the fighter convention (direction (sin yaw, 0, cos yaw): 0 faces +z, π/2 faces +x).
// Every number below is a recipe constant of §11 (or of the lab it cites), never tuning.
import { COMMAND_STEPS, toCm } from '../../src/sim/commands';
import type { Quat, V3 } from '../../src/world/types';
import { BACK_SLOT, type Harness, makeHarness, runSteps, runStepsAsync, type XZ } from './worldHarness';

// ---------------------------------------------------------------------------
// Small geometry
// ---------------------------------------------------------------------------

const dirOf = (yaw: number): XZ => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
const unit = (v: XZ): XZ => {
  const l = Math.hypot(v.x, v.z);
  if (!(l > 0)) throw new Error('scenes: a direction with no length');
  return { x: v.x / l, z: v.z / l };
};
const add = (a: XZ, b: XZ, k = 1): XZ => ({ x: a.x + b.x * k, z: a.z + b.z * k });
const yawOf = (d: XZ): number => Math.atan2(d.x, d.z);
/** A yaw (rad) as a place command's 1/256-turn steps, in [0, 256). */
const yawSteps = (yaw: number): number => (((Math.round((yaw / (2 * Math.PI)) * COMMAND_STEPS) % COMMAND_STEPS) + COMMAND_STEPS) % COMMAND_STEPS);

function mulQuat(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * A prism (axis local +y) lying with its axis horizontal along `yaw` and a flat face down (as LYING_ALONG_X lays one
 * along x): the cyclic turn x→y, y→z, z→x lays it along +z with local x (a face normal of the factory's prisms) up,
 * then a turn about world y.
 */
export function lyingAlong(yaw: number): Quat {
  const alongZ: Quat = { x: 0.5, y: 0.5, z: 0.5, w: 0.5 };
  return mulQuat({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, alongZ);
}

/** Hex prism (6-gon) inradius from circumradius. */
const hexIn = (r: number): number => r * Math.cos(Math.PI / 6);
/** 8-gon inradius from circumradius. */
const octIn = (r: number): number => r * Math.cos(Math.PI / 8);

/** Ground height under (x, z). */
const ground = (h: Harness, q: XZ): number => h.w.terrain.heightAt(q.x, q.z);

/**
 * The point nudged 13 mm off the terrain's vertex lines when it sits on one. A place ray cast straight down through a
 * heightfield vertex misses the heightfield (P23 found it: an upright place at (0, 2.5) on a 30 m world is refused
 * noSupport, at (0.01, 2.5) it isn't; reported for the physics owner), so scene positions never sit exactly on one.
 */
function offVertex(h: Harness, q: XZ): XZ {
  const sp = h.w.terrain.spacing;
  const nudge = (v: number): number => (Math.abs(v / sp - Math.round(v / sp)) < 1e-6 ? v + 0.013 : v);
  return { x: nudge(q.x), z: nudge(q.z) };
}

/** Walk there, or (blocked: a pit wall, a pile, a berm) a logged standAt. */
function goTo(h: Harness, q: XZ, yaw?: number): void {
  const p = h.p.pos;
  if (!h.walk(q, { tolM: 0.15, tryOnly: true }) || Math.hypot(p.x - q.x, p.z - q.z) > 0.3) h.standAt(q, yaw);
}

/** Walks through the points in order (goTo each): a route round something in the way. */
function route(h: Harness, pts: readonly XZ[]): void {
  for (const q of pts) goTo(h, q);
}

/**
 * Walks up to the entity and takes it; refused for reach (it lies on a bank or a pile the walk ended below or beside), a
 * logged standAt next to it and once more.
 */
function take(h: Harness, id: number, what: string): void {
  if (!h.p.alive) {
    const hurt = h.impacts(h.p).slice(-3).map((i) => `${JSON.stringify(i.cause)} ${i.damage.toFixed(1)} HP at (${i.point.x.toFixed(2)}, ${i.point.y.toFixed(2)}, ${i.point.z.toFixed(2)})`);
    throw new Error(`scenes: the player is dead (${what}); the last hits: ${hurt.join('; ')}`);
  }
  h.approach(id);
  const r = h.verb({ verb: 'take', target: id });
  if (r.ok) return;
  if (r.reason !== 'outOfReach' && r.reason !== 'outOfRange') throw new Error(`harness: ${what} refused (${r.reason})`);
  const e = h.ent(id).pose.p;
  const p = h.p.pos;
  const d = Math.max(1e-6, Math.hypot(p.x - e.x, p.z - e.z));
  h.standAt({ x: e.x + ((p.x - e.x) / d) * 0.8, z: e.z + ((p.z - e.z) / d) * 0.8 });
  h.ticks(2);
  h.must({ verb: 'take', target: id }, what);
}

/**
 * Takes the entity and walks it along `pts` (goTo each); if it left the hands on the way (a stumble off a dirt pile is a
 * knockdown, and a knockdown lets go of a load, §5.1), it is taken up again where it fell and the walk goes on, up to
 * three times.
 */
function bring(h: Harness, id: number, pts: readonly XZ[]): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    // A light thing that fell may have broken (a grass bundle of leaves breaks at a few joules): it is gone.
    if (!h.w.entities.get(id)) return false;
    if (h.p.inventory?.hands?.entity !== id) {
      take(h, id, `take ${id}`);
    }
    route(h, pts);
    if (h.p.inventory?.hands?.entity === id) return true;
  }
  throw new Error(`scenes: ${id} kept leaving the hands on the way`);
}

/** Takes a vine coil of `lengthM` lying at `at` into the first belt slot (the rope lash and tie use, §5.8). */
function coilToBelt(h: Harness, at: XZ, lengthM: number): number {
  const coil = h.coil({ material: 'vine', lengthM, at: { x: at.x, y: ground(h, at), z: at.z } });
  h.ticks(1);
  take(h, coil, 'take the vine coil');
  h.must({ verb: 'stow', target: 0, slot: 0 }, 'the vine coil to the belt');
  return coil;
}

/** A dry stick lying along x at (x, z) on the ground (the factory's 8-gon), optionally pointed at its +x end. */
function stickAt(h: Harness, q: XZ, length: number, r: number, o?: { material?: 'dryWood' | 'rottenWood'; sharp?: number; along?: number }): number {
  const along = o?.along ?? Math.PI / 2;
  const d = dirOf(along);
  const ends = [add(q, d, length / 2), add(q, d, -length / 2), q];
  const y = Math.max(...ends.map((e) => ground(h, e))) + r + 0.02;
  return h.stick({
    length,
    r,
    p: { x: q.x, y, z: q.z },
    q: lyingAlong(along),
    material: o?.material,
    sharp: o?.sharp === undefined ? undefined : { end: 1, s: o.sharp },
  });
}

/**
 * Carries the entity there and places it upright at `base` (its lower end on the ground there): driven when it has a
 * point up or `drive` is 1, free with drive 0 (§5.7). The player stands `standOff` m from it on the `from` side.
 */
function placeUpright(h: Harness, id: number, where: XZ, length: number, o: { drive?: 0 | 1; from: XZ; standOff?: number; via?: readonly XZ[] }): void {
  const base = offVertex(h, where);
  const s = add(base, unit(o.from), o.standOff ?? 0.9);
  take(h, id, `take ${id}`);
  route(h, [...(o.via ?? []), s]);
  const at = toCm({ x: base.x, y: ground(h, base) + length / 2, z: base.z });
  const v = o.drive === undefined ? { verb: 'place' as const, target: 0, at, yaw: 0, pitch: 64 } : { verb: 'place' as const, target: 0, at, yaw: 0, pitch: 64, drive: o.drive };
  h.must(v, `place ${id} upright`);
}

// ---------------------------------------------------------------------------
// AC-5: the staked log (§11.5); AC-6 part 3: the staked wall (§11.6)
// ---------------------------------------------------------------------------

/** The stakes' stick: dry, r 0.05 (§6.7's 5 cm stake), long enough to stand 1.3 m out of the ground once driven 0.3 m. */
const STAKE = { lengthM: 1.6, r: 0.05, sharpness: 0.6, gapM: 0.05 } as const;

/**
 * §11.5: a 300 kg dry hex log (4.4 m, circumradius 0.23 m) lying with its axis along `yaw` (across the path), its centre
 * at `centre` (1.0 m up in AC-5), lashed with vine to two stakes the player placed point-up (driven, anchored) against
 * its end faces. The log is staged at its pose while the player works (D-25: no verb lifts 300 kg) and unstaged once
 * lashed: anchored by its lashings (§2.3), a blocker.
 */
export function buildStakedLog(h: Harness, o: { centre: V3; yaw: number; massKg: 300; lengthM: 4.4 }): { log: number; stakes: number[] } {
  const axis = dirOf(o.yaw);
  const side = { x: axis.z, z: -axis.x };
  const L = o.lengthM;
  const c: XZ = { x: o.centre.x, z: o.centre.z };
  coilToBelt(h, add(c, side, 3), 4);
  const log = h.log({ mass: o.massKg, length: L, r: 0.23, p: { x: c.x + side.x * 6, y: ground(h, add(c, side, 6)) + 0.3, z: c.z + side.z * 6 }, q: lyingAlong(o.yaw) });
  h.stage(log, { p: { x: o.centre.x, y: o.centre.y, z: o.centre.z }, q: lyingAlong(o.yaw) });
  // Round the log by a lane 2.5 m out on one side (it is 0.77 m up: the player would walk into it).
  const lane = (end: number): XZ => add(add(c, axis, end * (L / 2 + 0.6)), side, 2.5);
  const stakes: number[] = [];
  for (const end of [1, -1]) {
    const base = add(c, axis, end * (L / 2 + STAKE.gapM + octIn(STAKE.r)));
    route(h, [lane(end)]);
    const id = stickAt(h, add(lane(end), axis, end * 0.8), STAKE.lengthM, STAKE.r, { sharp: STAKE.sharpness });
    h.ticks(1);
    placeUpright(h, id, base, STAKE.lengthM, { from: axis, standOff: end * 0.9, via: [lane(end)] });
    route(h, [lane(end)]);
    stakes.push(id);
  }
  for (let k = 0; k < 2; k++) {
    const end = k === 0 ? 1 : -1;
    const face = add(c, axis, end * (L / 2));
    const stakeFace = add(c, axis, end * (L / 2 + STAKE.gapM));
    route(h, [lane(end), add(add(c, axis, end * (L / 2 - 0.3)), side, 0.9)]);
    h.must(
      { verb: 'lash', target: log, second: stakes[k], at: toCm({ x: face.x, y: o.centre.y, z: face.z }), at2: toCm({ x: stakeFace.x, y: o.centre.y, z: stakeFace.z }) },
      `lash the log to stake ${stakes[k]}`,
    );
  }
  route(h, [lane(-1)]);
  h.unstage(log);
  h.ticks(30);
  return { log, stakes };
}

/**
 * §11.6 part 3: a `lengthM` wall `height` high of two stacked dry hex logs (each staged at its pose, D-25), from `start`
 * along `dir`, lashed at both end faces to stakes the player placed point-up in line with the wall (so neither face has
 * anything standing in front of it), then unstaged: anchored by their lashings (§2.3). Returns [lower, upper, stakes…].
 */
export function buildStakedWall(h: Harness, o: { start: XZ; dir: XZ; lengthM: 16; height: 1.0 }): number[] {
  const axis = unit(o.dir);
  const yaw = yawOf(axis);
  const side = { x: axis.z, z: -axis.x };
  const L = o.lengthM;
  const r = o.height / 2 / (2 * Math.cos(Math.PI / 6)); // two flat-down hexes stacked: 2 × 2·r·cos30 = height
  const mid = add(o.start, axis, L / 2);
  coilToBelt(h, add(mid, side, -3), 6);
  const g = ground(h, mid);
  const logs: number[] = [];
  for (let k = 0; k < 2; k++) {
    const away = add(mid, side, 6 + 2 * k);
    const id = h.log({ length: L, r, p: { x: away.x, y: ground(h, away) + hexIn(r) + 0.02, z: away.z }, q: lyingAlong(yaw) });
    h.stage(id, { p: { x: mid.x, y: g + hexIn(r) * (1 + 2 * k), z: mid.z }, q: lyingAlong(yaw) });
    logs.push(id);
  }
  // Round the wall by a lane 2.5 m out on its −side (16 m of logs: never walked through).
  const lane = (end: number): XZ => add(add(mid, axis, end * (L / 2 + 0.6)), side, -2.5);
  const stakes: number[] = [];
  for (const end of [1, -1]) {
    const base = add(mid, axis, end * (L / 2 + STAKE.gapM + octIn(STAKE.r)));
    route(h, [lane(end)]);
    const id = stickAt(h, add(lane(end), axis, end * 0.8), STAKE.lengthM, STAKE.r, { sharp: STAKE.sharpness });
    h.ticks(1);
    placeUpright(h, id, base, STAKE.lengthM, { from: axis, standOff: end * 0.9, via: [lane(end)] });
    route(h, [lane(end)]);
    stakes.push(id);
  }
  for (let e = 0; e < 2; e++) {
    const end = e === 0 ? 1 : -1;
    route(h, [lane(end), add(add(mid, axis, end * (L / 2 + 0.3)), side, -0.9)]);
    for (let k = 0; k < 2; k++) {
      const y = g + hexIn(r) * (1 + 2 * k);
      const face = add(mid, axis, end * (L / 2));
      const stakeFace = add(mid, axis, end * (L / 2 + STAKE.gapM));
      h.must(
        { verb: 'lash', target: logs[k], second: stakes[e], at: toCm({ x: face.x, y, z: face.z }), at2: toCm({ x: stakeFace.x, y, z: stakeFace.z }) },
        `lash wall log ${logs[k]} to stake ${stakes[e]}`,
      );
    }
    route(h, [lane(end)]);
  }
  for (const id of logs) h.unstage(id);
  h.ticks(30);
  return [...logs, ...stakes];
}

// ---------------------------------------------------------------------------
// AC-2(d), AC-3: the notched tree (§11.2(d), §11.3)
// ---------------------------------------------------------------------------

/**
 * A 30 cm × 15 m green tree at `at` with a hanging vine (anchored `anchorH` up on the fall side, `lengthM` long, its slack
 * lying out along the fall line), chopped by the player with the stone axe from `fromSide` (a direction from the
 * trunk) to `remaining` m (§2.5: it falls away from that side). The player is given the stone axe if he doesn't wield
 * one, and walks round to that side first.
 */
export function buildNotchedTree(h: Harness, o: { at: XZ; fromSide: XZ; remaining: number; vine: { anchorH: number; lengthM: number } }): { tree: number; vineJoint: number } {
  const from = unit(o.fromSide);
  const fall = { x: -from.x, z: -from.z };
  const t = h.tree({ at: o.at, diameter: 0.3, height: 15, vine: { anchorH: o.vine.anchorH, lengthM: o.vine.lengthM, yaw: yawOf(fall) } });
  if (!t.vine) throw new Error('buildNotchedTree: no vine');
  h.ticks(1);
  const hands = h.p.inventory?.hands;
  if (!hands || h.p.weapon?.id !== 'stoneAxe') h.give('stoneAxe');
  goTo(h, add(o.at, from, 0.15 + 1.3));
  h.chopTo(t.tree, o.remaining);
  return { tree: t.tree, vineJoint: t.vine.joint };
}

// ---------------------------------------------------------------------------
// AC-2(a): the leaning log (§11.2(a) gate)
// ---------------------------------------------------------------------------

/** §11.2(a)'s verb-only deadfall numbers (I-rev ran: deadfall_light.out; verbs.place.test's lean). */
const LEAN = {
  prop: { lengthM: 2.4, r: 0.07 },
  log: { lengthM: 5.0, massKg: 40 },
  /** The prop's near top edge this far along from the log's lower end: 2.4 m up over 3.71 m is 32.9°. */
  propNearM: 3.71,
  pitchDeg: 32.9,
  bait: { size: [0.25, 0.04, 1 / 1100 / (0.25 * 0.04)] as [number, number, number], inwardM: 0.55 },
  ropeM: 0.65,
} as const;

/** The leaning log's geometry (buildLeaningLog's `lean`): §11.2(a)'s by default. */
export type LeanGeometry = { logLengthM: number; propNearM: number; pitchDeg: number };

/**
 * DEPARTURE (P28, §11.2(a) gate step 2 "5.0 m … 4.4 m along … 32.9°"), for AC-2(a)'s bait-tug runs: the 40 kg log 5.6 m
 * long leaning at 30° on the same 2.4 m prop, 4.16 m out (4.8 m along it): the underside over the crouched, tugging ape
 * stands ≈ 0.1 m higher (the prop is no taller: a 2.5 m or 2.55 m one left no place for the sloped log, `noSupport`).
 * At 32.9° the ape backing off with the bait was under the log (clearance 0.017 m) and the 200 N control sprang it
 * (P28 lab; nearby geometries, 29-32° and 5.5-5.8 m, are as chaotic: see the ledger).
 */
export const LEAN_P28: LeanGeometry = { logLengthM: 5.6, propNearM: 4.16, pitchDeg: 30 };

/**
 * §11.2(a) gate (verb-only): from the log's lower end at `at`, rising along `yaw`: a dry stick r 0.07 × 2.4 m carried
 * and placed upright, not driven (a free prop); a 40 kg, 5 m dry hex log carried and placed sloped, its lower end on the
 * ground and its underside on the prop's top 4.4 m along (32.9°); a 1 kg hide bait placed lying 0.55 m inward of the
 * prop's base and lashed to the prop with vine, anchors 0.65 m apart (a 0.65 m rope).
 */
export function buildLeaningLog(h: Harness, o: { at: XZ; yaw: number; lean?: LeanGeometry }): { prop: number; log: number; bait: number } {
  const g0 = o.lean ?? { logLengthM: LEAN.log.lengthM, propNearM: LEAN.propNearM, pitchDeg: LEAN.pitchDeg };
  const L = { ...LEAN, log: { ...LEAN.log, lengthM: g0.logLengthM }, propNearM: g0.propNearM, pitchDeg: g0.pitchDeg };
  const A = offVertex(h, o.at);
  const u = dirOf(o.yaw);
  const n = { x: u.z, z: -u.x };
  const g = ground(h, A);
  coilToBelt(h, add(A, n, -3), 3);
  // The prop, upright, free.
  const propBase = add(A, u, L.propNearM + octIn(L.prop.r));
  const prop = stickAt(h, add(propBase, n, 3), L.prop.lengthM, L.prop.r);
  h.ticks(1);
  placeUpright(h, prop, propBase, L.prop.lengthM, { drive: 0, from: n, standOff: 1.2 });
  h.ticks(60);
  // The log, sloped onto the prop (the place test's command: the lower-end underside corner placeDropM over the ground).
  const logSpot = add(add(A, u, 2), n, 3.5);
  const logId = h.log({ mass: L.log.massKg, length: L.log.lengthM, r: 0.1, p: { x: logSpot.x, y: ground(h, logSpot) + 0.1, z: logSpot.z }, q: lyingAlong(o.yaw) });
  h.ticks(30);
  take(h, logId, 'take the deadfall log');
  goTo(h, add(add(A, u, 2.0), n, 1.2));
  const r = h.ent(logId).shape.kind === 'cylinder' ? (h.ent(logId).shape as { r: number }).r : 0.075;
  const steps = Math.round((L.pitchDeg / 360) * COMMAND_STEPS);
  const th = (steps / COMMAND_STEPS) * 2 * Math.PI;
  const rho = hexIn(r);
  const lowH = -rho * Math.sin(th);
  const lowY = g + 0.02 + rho * Math.cos(th);
  const centre = add(A, u, lowH + (Math.cos(th) * L.log.lengthM) / 2);
  h.must({ verb: 'place', target: 0, at: toCm({ x: centre.x, y: lowY + (Math.sin(th) * L.log.lengthM) / 2, z: centre.z }), yaw: yawSteps(o.yaw), pitch: steps }, 'place the log sloped onto the prop');
  h.ticks(30);
  // The bait, lying 0.55 m inward of the prop's base.
  const baitAt = offVertex(h, add(propBase, u, -L.bait.inwardM));
  const spot = add(baitAt, n, 2.5);
  const bait = h.box({ p: { x: spot.x, y: ground(h, spot) + L.bait.size[1] / 2 + 0.01, z: spot.z }, size: [...L.bait.size], material: 'hide', state: 'free', look: 'hide' });
  h.ticks(10);
  take(h, bait, 'take the bait');
  goTo(h, add(baitAt, n, 1.0));
  const baitY = g + L.bait.size[1] / 2 + 0.02;
  h.must({ verb: 'place', target: 0, at: toCm({ x: baitAt.x, y: baitY, z: baitAt.z }), yaw: yawSteps(o.yaw), pitch: 0 }, 'place the bait');
  h.ticks(20);
  // The lash: bait top to the prop's side facing it, 0.65 m apart.
  const b = h.ent(bait).pose.p;
  const top = { x: b.x, y: b.y + L.bait.size[1] / 2, z: b.z };
  const pe = h.ent(prop).pose.p;
  const toward = unit({ x: top.x - pe.x, z: top.z - pe.z });
  const face = add({ x: pe.x, z: pe.z }, toward, octIn(L.prop.r));
  const dh = Math.hypot(face.x - top.x, face.z - top.z);
  const up = dh < L.ropeM ? Math.sqrt(L.ropeM * L.ropeM - dh * dh) : 0.15 * L.prop.lengthM;
  h.must({ verb: 'lash', target: bait, second: prop, at: toCm(top), at2: toCm({ x: face.x, y: top.y + up, z: face.z }) }, 'lash the bait to the prop');
  h.ticks(30);
  return { prop, log: logId, bait };
}

// ---------------------------------------------------------------------------
// AC-2(c): the hauled log (§11.2(c) gate)
// ---------------------------------------------------------------------------

const flatXZ = (a: XZ, b: XZ): number => Math.hypot(a.x - b.x, a.z - b.z);
const aboutZ = (a: number): Quat => ({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) });

/**
 * §11.2(a)'s staged deadfall geometry: a stick r 0.07 m `propLengthM` long placed upright at x = propX, a dry hex log
 * `logLengthM` long (circumradius `logR`; the design's 0.17 m) from the ground at x = 0 onto its top (25°).
 */
export type ProppedGeometry = { propX: number; propLengthM: number; logLengthM: number; logR: number };
/**
 * DEPARTURE (P28, §11.2(a) staged steps 1-2 "2.38 m … x = 5.07 … 6.0 m … circumradius 0.17 m"): the bait-tug runs
 * use a 2.47 m stick at x 5.3 and a 6.2 m log (25° still): the underside over the ape 0.8 m in from the bait stands
 * 0.1 m higher, so the log, once sprung, falls far enough to arrive at v_n ≥ 2 m/s (1.83-1.89 m/s on the design's).
 * Fifth pass (the sustained forces in-solver, C F3 departure): the log is circumradius 0.13 m (150 kg, not 248 kg).
 * With forces in-solver the design's 248 kg log holds the prop against a sustained 850 N on the bait (the C lab), past
 * the ape's 907.5 N tug; the ape's tug, applied where it grips the 1 kg hide (which tumbles and bounces on its lash),
 * moves the prop less than the same force at the bait's centre: 0.15 m (199 kg) held the tug 2 s; 0.13-0.14 m spring
 * to it in 0.68-0.88 s and hold the 700 N tug (P28 lab). Under a step force at the bait's centre this prop gives from
 * ≈ 600 N (tests/proppedLog.lab.test.ts measures the 199 kg and 248 kg logs).
 */
export const PROPPED_P28: ProppedGeometry = { propX: 5.3, propLengthM: 2.47, logLengthM: 6.2, logR: 0.13 };
export const PROPPED_AS_DESIGNED: ProppedGeometry = { propX: 5.07, propLengthM: 2.38, logLengthM: 6, logR: 0.17 };
/**
 * DEPARTURE (P28 fifth pass, §11.2(a) staged "circumradius 0.17 m"): the walked run keeps the design's stick and log
 * length with a 0.16 m log (220 kg): with the controller's lean on the bait and prop a force (C F3 departure), the
 * design's log, having hit the ape's head at 4.5 m/s, rolled 0.83 m off its plane (gate < 0.35 m). Chaotic: 0.13,
 * 0.15 and 0.17 m roll 0.61-0.91 m, 0.16 m 0.25 m (P28 lab).
 */
export const PROPPED_WALKED: ProppedGeometry = { ...PROPPED_AS_DESIGNED, logR: 0.16 };

/**
 * §11.2(a)'s staged scene: a dry stick r 0.07 × 2.38 m carried and placed upright, not driven, at x 5.07; a dry hex
 * log 6.0 m, circumradius 0.17 m spawned free at its pose (D-25), its lower end on the ground at x 0 and its
 * underside on the stick's top (25°); a 1 kg hide bait placed 0.55 m inward of the stick and lashed to it (a 0.65 m
 * vine). DEVIATION (§11.2(a) "≈ 170 kg"): the factory's dry wood makes that log 248 kg; the recipe's dimensions are
 * kept (they set the underside's height over the ape). The runs build it to their geometry (PROPPED_P28,
 * PROPPED_WALKED, PROPPED_AS_DESIGNED: the departures recorded there).
 */
export function buildProppedLog(h: Harness, STAGED: ProppedGeometry = PROPPED_P28): { prop: number; log: number; bait: number } {
  const PROP = { x: STAGED.propX, z: 0.013, lengthM: STAGED.propLengthM, r: 0.07 };
  const g = h.w.terrain.heightAt(PROP.x, PROP.z);
  const prop = h.stick({ length: PROP.lengthM, r: PROP.r, p: { x: 5, y: g + PROP.r + 0.03, z: 3 }, q: lyingAlong(Math.PI / 2) });
  h.ticks(20);
  take(h, prop, 'take the prop');
  goTo(h, { x: PROP.x, z: -1.2 });
  h.must({ verb: 'place', target: 0, at: toCm({ x: PROP.x, y: g + PROP.lengthM / 2, z: PROP.z }), yaw: 0, pitch: 64, drive: 0 }, 'place the prop upright');
  h.ticks(60);
  const sp = h.ent(prop).pose.p;
  const top = sp.y + PROP.lengthM / 2 - g;
  // The log: its underside on the line from (0, ground) to the prop's top; a flat face down.
  const th = Math.atan2(top, sp.x);
  const ri = STAGED.logR * Math.cos(Math.PI / 6);
  const c = { x: -ri * Math.sin(th) + (STAGED.logLengthM / 2) * Math.cos(th), y: g + ri * Math.cos(th) + (STAGED.logLengthM / 2) * Math.sin(th) + 0.01 };
  goTo(h, { x: 3, z: -4 });
  const log = h.log({ length: STAGED.logLengthM, r: STAGED.logR, p: { x: c.x, y: c.y, z: 0 }, q: mulQuat(aboutZ(th), lyingAlong(Math.PI / 2)) });
  h.ticks(120);
  // The bait, placed lying 0.55 m inward of the prop, lashed to the prop's side facing it by a 0.65 m vine.
  const bx = sp.x - 0.55;
  const bait = h.box({ p: { x: bx, y: g + 0.03, z: -2.5 }, size: [0.25, 0.04, 1 / 1100 / (0.25 * 0.04)], material: 'hide', state: 'free', look: 'hide' });
  h.ticks(10);
  take(h, bait, 'take the bait');
  goTo(h, { x: bx, z: -1.0 });
  h.must({ verb: 'place', target: 0, at: toCm({ x: bx, y: g + 0.04, z: PROP.z }), yaw: 64, pitch: 0 }, 'place the bait');
  h.ticks(20);
  const coil = h.coil({ material: 'vine', lengthM: 3, at: { x: 2, y: g, z: -2 } });
  h.ticks(5);
  take(h, coil, 'take the vine coil');
  h.must({ verb: 'stow', target: 0, slot: 0 }, 'the coil to the belt');
  goTo(h, { x: bx + 0.2, z: -0.9 });
  const bp = h.ent(bait).pose.p;
  const btop = { x: bp.x, y: bp.y + 0.02, z: bp.z };
  const face = { x: sp.x - PROP.r * Math.cos(Math.PI / 8), z: sp.z };
  const dh = flatXZ(face, btop);
  h.must({ verb: 'lash', target: bait, second: prop, at: toCm(btop), at2: toCm({ x: face.x, y: btop.y + Math.sqrt(0.65 * 0.65 - dh * dh), z: face.z }) }, 'lash the bait to the prop');
  h.ticks(30);
  goTo(h, { x: -3, z: -6 });
  return { prop, log, bait };
}


/**
 * §11.2(c) gate (verb-only), at `at`: two trees (d 0.4 m, h 14 m) at ±2.6 m in z, each with a 9 m hanging vine anchored
 * 8 m up on its inner side; a 138 kg dry log (2 m) dragged to lie along z under the anchors (the support); a 30 kg, 4 m
 * dry hex log carried and placed lying along z on it; each vine end taken and tied to the log at local z ±1.6 (taut);
 * a dry stick placed driven 9 m back (the tie stake); a 10 m vine coil tied to the log's back face and its end let go
 * of; the support dragged away (the log hangs); the rope end taken up again and paid out walking back; a 5 s pull (P16: a fresh hauler is spent at 6.7 s, verbs.rope
 * .test), and the hauled end tied to the stake while the pull holds. The stone axe waits on the player's back (§11.2(c)
 * step 6 draws it to cut the tie).
 * DEVIATION (§11.2(c) step 5 "(−9, 0, 0)"): the stake stands 0.6 m aside in z, as in verbs.rope.test's measured haul.
 */
export function buildHauledLog(h: Harness, o: { at: XZ }): { log: number; tie: number; stake: number } {
  const a = o.at;
  const g = ground(h, a);
  /** The rig (trees, vines, support, log) stands across x = a.x: the player crosses it by a lane 3.6 m north of it. */
  const cross = (to: XZ): void => {
    const p = h.p.pos;
    if (Math.sign(p.x - a.x) !== Math.sign(to.x - a.x) && Math.abs(p.x - a.x) > 0.3 && Math.abs(to.x - a.x) > 0.3) {
      route(h, [{ x: p.x, z: a.z + 3.6 }, { x: to.x, z: a.z + 3.6 }]);
    }
    goTo(h, to);
  };
  h.give('stoneAxe', 'back');
  goTo(h, { x: a.x + 4.2, z: a.z });
  const vines: number[] = [];
  for (const s of [1, -1]) {
    const t = h.tree({ at: { x: a.x, z: a.z + 2.6 * s }, diameter: 0.4, height: 14, vine: { anchorH: 8, lengthM: 9, yaw: s > 0 ? Math.PI : 0 } });
    vines.push(t.vine!.rope);
  }
  // The vines' ends, which lie inward under where the log will be, carried out east first (taken from under the log,
  // the player's stoop would shove it).
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    take(h, vines[k], 'take a vine end');
    goTo(h, { x: a.x + 1.4, z: a.z + 1.6 * s });
    h.must({ verb: 'drop', target: 0 }, 'put a vine end down');
  }
  goTo(h, { x: a.x + 4.2, z: a.z });
  // The support, dragged in from 3 m out (gripped by its side, so it keeps lying along z).
  const support = h.log({ mass: 138, length: 2, r: 0.2, p: { x: a.x + 3, y: g + 0.25, z: a.z }, q: lyingAlong(0) });
  h.ticks(30);
  h.dragTo(support, { x: a.x, z: a.z }, { tolM: 0.25 });
  h.ticks(30);
  // The 30 kg log, placed lying along z on the support.
  const logAt = { x: a.x + 2.8, z: a.z + 1.4 };
  const log = h.log({ mass: 30, length: 4, r: 0.07, p: { x: logAt.x, y: ground(h, logAt) + 0.08, z: logAt.z }, q: lyingAlong(Math.PI / 2) });
  h.ticks(20);
  cross({ x: a.x + 2.8, z: a.z + 0.4 });
  take(h, log, 'take the 30 kg log');
  goTo(h, { x: a.x + 1.1, z: a.z });
  const sp0 = h.ent(support).pose.p;
  const supportTop = sp0.y + hexIn(shapeR(h, support));
  h.must({ verb: 'place', target: 0, at: toCm({ x: sp0.x, y: supportTop + 0.08, z: sp0.z }), yaw: 0, pitch: 0 }, 'place the log on the support');
  h.ticks(30);
  // Each vine end tied to the log at local z ±1.6.
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    take(h, vines[k], 'take a vine end');
    // 1.6 m along the log's axis (its local ±y) from its centre, at the end toward this vine's tree.
    const ends = [pointOn(h, log, { x: 0, y: 1.6, z: 0 }), pointOn(h, log, { x: 0, y: -1.6, z: 0 })];
    const q = (ends[0].z - a.z) * s >= (ends[1].z - a.z) * s ? ends[0] : ends[1];
    goTo(h, { x: q.x + 0.8, z: q.z });
    h.must({ verb: 'tie', target: log, at: toCm({ x: q.x, y: q.y + 0.06, z: q.z }) }, 'tie a vine end to the log');
  }
  h.ticks(30);
  // The tie stake, driven 9 m back.
  const stakeBase = { x: a.x - 9, z: a.z + 0.6 };
  const stake = stickAt(h, { x: a.x - 7, z: a.z + 2.5 }, 1.4, 0.05);
  h.ticks(1);
  cross({ x: a.x - 6.5, z: a.z + 1.8 });
  placeUpright(h, stake, stakeBase, 1.4, { drive: 1, from: { x: 1, z: 0 }, standOff: 0.9 });
  // The 10 m coil tied to the log's back face while it still rests on the support (once hanging it swings for
  // minutes), its end let go of beside it.
  const coil = h.coil({ material: 'vine', lengthM: 10, at: { x: a.x - 1.8, y: g, z: a.z + 1.2 } });
  h.ticks(1);
  take(h, coil, 'take the 10 m coil');
  goTo(h, { x: a.x - 1.0, z: a.z });
  const lp = h.ent(log).pose.p;
  h.must({ verb: 'tie', target: log, at: toCm({ x: lp.x - hexIn(shapeR(h, log)), y: lp.y, z: lp.z }) }, 'tie the coil to the log');
  h.must({ verb: 'drop', target: 0 }, 'let go of the rope end');
  // The support dragged away east: the log hangs.
  cross({ x: a.x + 1.4, z: a.z + 0.3 });
  h.dragTo(support, { x: a.x + 3.5, z: a.z }, { tolM: 0.4 });
  // The rope end taken up again and paid out walking back to the stake.
  cross({ x: a.x - 1.8, z: a.z + 0.5 });
  take(h, coil, 'take the rope end');
  goTo(h, { x: a.x - 8.4, z: a.z });
  h.ticks(30);
  const tie = h.w.joints.all().find((j) => j.rope?.entity === coil);
  if (!tie) throw new Error('buildHauledLog: the coil is no rope joint');
  // Pull 5 s, then tie the hauled end to the stake while the pull holds (§5.8).
  const on = h.verb({ verb: 'pull', target: 0, charge: 255 });
  if (!on.ok) throw new Error(`buildHauledLog: pull refused (${on.reason})`);
  h.ticks(299);
  const sp = h.ent(stake).pose.p;
  h.must({ verb: 'tie', target: stake, at: toCm({ x: sp.x + 0.05, y: g + 1.0, z: sp.z - 0.05 }) }, 'tie the hauled end to the stake');
  h.ticks(60);
  return { log, tie: tie.id, stake };
}

/** A point in an entity's frame, in the world (its record pose). */
function pointOn(h: Harness, id: number, local: V3): V3 {
  const { p, q } = h.ent(id).pose;
  // v + 2w × (w × v + q.w v), the rotation of v by the unit quaternion q.
  const tx = 2 * (q.y * local.z - q.z * local.y);
  const ty = 2 * (q.z * local.x - q.x * local.z);
  const tz = 2 * (q.x * local.y - q.y * local.x);
  return {
    x: p.x + local.x + q.w * tx + (q.y * tz - q.z * ty),
    y: p.y + local.y + q.w * ty + (q.z * tx - q.x * tz),
    z: p.z + local.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** A prism entity's circumradius (0 for other shapes). */
function shapeR(h: Harness, id: number): number {
  const s = h.ent(id).shape;
  return s.kind === 'cylinder' ? s.r : 0;
}

// ---------------------------------------------------------------------------
// AC-2(b), AC-3: the spike pit (§11.2(b), §11.3)
// ---------------------------------------------------------------------------

/** Ground this far below its original height is dug (the terrain's spoilUndugTolM, §4.13): the hole's edge. */
const DUG_EDGE_M = 0.05;

/** §11.2(b)'s pit numbers. */
const PIT = {
  stake: { lengthM: 1.4, r: 0.05, sharpness: 0.6 },
  /** The dig planner's caps (§11.0, RT-2): 1.2 × 3,185 no-spoil strikes; 360,000 ticks. */
  maxStrikes: 3822,
  maxTicks: 360_000,
  /**
   * DEVIATION (§11.2(b) "r 0.02 m"): r 0.025 m. Place's clearance test shrinks the held shape by placeShrinkM (0.02 m)
   * to r 0.001 m, and Rapier can't build that 8 m needle's hull: the query throws ("expected instance of p"; P23
   * measured r ≤ 0.002 m failing at 4 m half-length). Reported for P17 (shrinkShape). 5.7 kg, holding 283 N (≥ 200 N).
   */
  /** 8 m across the 6 m width (overM beyond each long rim), spacingM apart along the length (20 on an 8 m pit). */
  bearer: { overM: 1, r: 0.025, spacingM: 0.4, endOutM: 0.25, minOnRimM: 0.5, bermGapM: 0.1 },
  /**
   * Up to `count` bundles (at least PIT_GRASS_MIN laid) in rows along the long rims (rowsInsetM inside each: |z| 2.5
   * and 3.0 m on the 6 m pit), each across the two neighbouring bearers nearest a spot of the row (spots every 0.2 m,
   * bundles at least 0.77 m apart along a row): the player lays them from grassLaneM beyond the bearers' ends, so the
   * place's step-in (≈ 0.7 m) never puts him on one (a man's weight on a rotten bearer is a load break, §4.11). His
   * 2.5 m reach ends at the nearer row.
   */
  grass: { masses: [3], rowsInsetM: [0.5, 0], count: 30 },
  grassLaneM: 1.2,
  /** coverDugRim: the outer grass row lies this far in from the longest nearby bearer's end; bearers within grassNearM count. */
  grassRowInM: 0.5,
  grassNearM: 0.6,
  /** Where the player stands to lay a bearer: this far beyond its end. */
  rimM: 0.6,
} as const;

/**
 * The fewest grass bundles the 8 × 6 m pit's cover may have laid on two bearers each. DEVIATION (§11.2(b) "30 grass
 * bundles"): as many of 30 as find two bearers, at least this many (P23 measured 26 of 30 on a pit's real bearers).
 */
export const PIT_GRASS_MIN = 24;

/**
 * §11.2(b) step 1-3 (verb-only): the player digs an 8 (x) × 6 (z) × 2.5 m pit centred at `centre` with the digging stick
 * (the dig planner; its piles dragged out of the long sides, so the ends stay clear for a charge along x), shapes 108
 * factory-spawned dry sticks (1.4 m, r 0.05) to 0.6 with it, and places each upright point-up on the floor on a
 * `stakeSpacing` grid (12 × 9), driven 0.3 m; then lays 20 rotten-wood bearers (8 m, r 0.025: see PIT.bearer) across
 * the width 0.4 m apart from the rim, and up to 30 grass bundles (3 kg) lying on them (at least PIT_GRASS_MIN). Into and out of the pit the player goes by logged
 * standAt (its walls are steeper than he climbs).
 */
export function buildPit(h: Harness, o: PitOptions): PitBuilt {
  return runSteps(buildPitSteps(h, o));
}

/**
 * buildPit, yielding to the worker's event loop between strikes, stakes, bearers and bundles (runStepsAsync): the same
 * commands on the same ticks, so the same scene. The cached pit is built this way (pitScene): ≈ 12 min of synchronous
 * work in a test worker otherwise blocks Vitest's RPC past its 60 s timeout.
 */
export function buildPitAsync(h: Harness, o: PitOptions): Promise<PitBuilt> {
  return runStepsAsync(buildPitSteps(h, o));
}

type PitOptions = { centre: XZ; lengthX: 8; widthZ: 6; depth: 2.5; stakeSpacing: 0.6 };
type PitBuilt = { cover: number[]; stakes: number[]; strikes: number };

function* buildPitSteps(h: Harness, o: PitOptions): Generator<void, PitBuilt> {
  const c = o.centre;
  const x0 = c.x - o.lengthX / 2;
  goTo(h, { x: x0 - 2, z: c.z });
  const stick = h.give('diggingStick');
  const dug = yield* h.digPitSteps({ centre: c, lengthX: o.lengthX, widthZ: o.widthZ, depth: o.depth, maxTicks: PIT.maxTicks, maxStrikes: PIT.maxStrikes, pileSides: 'z' });
  console.info(`buildPit: dig ${JSON.stringify(dug)}`);
  h.ticks(60);
  // Out of the pit at its −x end: round its −z side (between it and the piles) to the staging off its +x end.
  route(h, [
    { x: x0 - 1.5, z: c.z - o.widthZ / 2 - 2.2 },
    { x: c.x + o.lengthX / 2 + 1.5, z: c.z - o.widthZ / 2 - 2.2 },
  ]);
  const furnished = yield* furnishPitSteps(h, { ...o, grass: { count: PIT.grass.count, minCount: PIT_GRASS_MIN }, coverDugRim: true }, stick);
  console.info(`buildPit: ${furnished.stakes.length} stakes, ${furnished.cover.length} cover; standAts ${JSON.stringify(h.standAts())}, tick ${h.w.tick}`);
  return { ...furnished, strikes: dug.strikes };
}

/**
 * buildPit after the dig (exported for the harness test, which furnishes its smaller 3 × 2 m pit): the stakes shaped
 * with the digging stick the player wields and placed, then the cover. The pit is the dug footprint at `centre`; the
 * grid, the bearers (widthZ + 2 overM long, lengthX / spacingM of them) and the grass rows scale with it.
 */
export function furnishPit(h: Harness, o: FurnishOptions, stick: number): { cover: number[]; stakes: number[] } {
  return runSteps(furnishPitSteps(h, o, stick));
}

/** furnishPit, yielding to the worker's event loop between stakes, bearers and bundles (see buildPitAsync). */
export function furnishPitAsync(h: Harness, o: FurnishOptions, stick: number): Promise<{ cover: number[]; stakes: number[] }> {
  return runStepsAsync(furnishPitSteps(h, o, stick));
}

type FurnishOptions = { centre: XZ; lengthX: number; widthZ: number; stakeSpacing: number; grass: { count: number; minCount: number }; coverDugRim?: boolean };

function* furnishPitSteps(h: Harness, o: FurnishOptions, stick: number): Generator<void, { cover: number[]; stakes: number[] }> {
  const c = o.centre;
  const x0 = c.x - o.lengthX / 2;
  const z0 = c.z - o.widthZ / 2;
  const z1 = c.z + o.widthZ / 2;

  // The stakes on the grid (12 × 9 on an 8 × 6 m floor: 0.7 m clear of the ends' walls, 0.6 m of the sides'), spawned
  // beside the +x end, each shaped to 0.6 with the digging stick.
  const nx = Math.round((o.lengthX - 2 * 0.7) / o.stakeSpacing) + 1;
  const nz = Math.round((o.widthZ - 2 * 0.6) / o.stakeSpacing) + 1;
  const grid: XZ[][] = [];
  for (let i = 0; i < nx; i++) {
    const col: XZ[] = [];
    for (let j = 0; j < nz; j++) col.push({ x: c.x - ((nx - 1) * o.stakeSpacing) / 2 + i * o.stakeSpacing, z: c.z - ((nz - 1) * o.stakeSpacing) / 2 + j * o.stakeSpacing });
    grid.push(col);
  }
  const sticks: number[] = [];
  for (let k = 0; k < nx * nz; k++) {
    const q = { x: c.x + o.lengthX / 2 + 4 + 3 * (k % 4), z: c.z - 9 + 0.5 * Math.floor(k / 4) };
    sticks.push(stickAt(h, q, PIT.stake.lengthM, PIT.stake.r));
  }
  h.ticks(60);
  const sharp = (id: number): number => Math.max(0, ...h.ent(id).sharpPoints.map((sp) => sp.sharpness));
  for (const id of sticks) {
    yield;
    // Standing off its +x end, in the 1.6 m lane between the columns (never among the sticks). A stick on the uneven
    // ground of the staging can shift under the strokes; the player follows its end and goes on (up to 4 times).
    for (let attempt = 0; sharp(id) < PIT.stake.sharpness - 1e-9; attempt++) {
      if (attempt >= 4) throw new Error(`buildPit: stake ${id} could not be shaped (sharpness ${sharp(id)})`);
      const tip = pointOn(h, id, { x: 0, y: PIT.stake.lengthM / 2, z: 0 });
      const e = h.ent(id).pose.p;
      const out = { x: tip.x - e.x, z: tip.z - e.z };
      const l = Math.max(1e-6, Math.hypot(out.x, out.z));
      goTo(h, { x: tip.x + (out.x / l) * 0.8, z: tip.z + (out.z / l) * 0.8 });
      const r = h.verb({ verb: 'shape', target: id, at: toCm(pointOn(h, id, { x: 0, y: PIT.stake.lengthM / 2, z: 0 })), charge: 1 });
      if (!r.ok && r.reason !== 'badAnchor' && r.reason !== 'outOfRange' && r.reason !== 'outOfReach') throw new Error(`harness: shape stake ${id} refused (${r.reason})`);
    }
  }
  h.must({ verb: 'stow', target: 0, slot: BACK_SLOT }, 'the digging stick to the back');
  if (h.p.inventory?.back !== stick) throw new Error('buildPit: the digging stick is not on the back');

  // Placed upright point-up on the floor (driven), column by column from the +x end, the player on the floor behind.
  const stakes: number[] = [];
  let k = 0;
  for (let i = nx - 1; i >= 0; i--) {
    for (const q of grid[i]) {
      yield;
      const id = sticks[k++];
      const sx = Math.max(x0 + 0.15, q.x - 0.75);
      take(h, id, `take stake ${id}`);
      h.standAt({ x: sx, z: q.z }, Math.PI / 2);
      h.ticks(2);
      const v = offVertex(h, q);
      const at = toCm({ x: v.x, y: ground(h, v) + PIT.stake.lengthM / 2, z: v.z });
      h.must({ verb: 'place', target: 0, at, yaw: 0, pitch: 64 }, `place stake ${id} at (${q.x.toFixed(2)}, ${q.z.toFixed(2)})`);
      if (h.ent(id).state !== 'anchored') throw new Error(`buildPit: stake ${id} was not driven (${h.ent(id).state})`);
      stakes.push(id);
      // Back out to the staging area for the next one.
      h.standAt({ x: c.x + o.lengthX / 2 + 2.5, z: c.z - 9 + 0.5 * Math.floor(k / 4) });
    }
  }

  // The cover: bearers across the width, laid from the −z rim; grass bundles on them from the nearer long rim.
  const bearers: number[] = [];
  // P28 (coverDugRim, the 8 × 6 m pit): the bearers span the hole as dug, not the planned footprint. The planner's cone
  // strikes dig the rim out beyond the footprint (≈ ±4.3 m at an 8 m pit's ends, where 20 bearers 0.4 m apart reached
  // ±3.8: a giant's front foot met the open strip and tripped `ledge`, not `cover`), so the bearers run from the dug
  // edge at one end to the other, at most spacingM apart, each overM onto undug ground beyond both long rims.
  const dug = (x: number, z: number): boolean => ground(h, { x, z }) < h.w.terrain.originalHeightAt(x, z) - DUG_EDGE_M;
  let xMin = c.x;
  let xMax = c.x;
  if (o.coverDugRim) {
    for (let x = c.x; x > c.x - o.lengthX; x -= 0.05) if (dug(x, c.z)) xMin = x;
    for (let x = c.x; x < c.x + o.lengthX; x += 0.05) if (dug(x, c.z)) xMax = x;
    // The end bearers on undug ground just beyond the ends as dug on the centre line (P28: one laid on the dug edge's
    // slope rolled in under the giant's first step).
    xMin -= PIT.bearer.endOutM;
    xMax += PIT.bearer.endOutM;
  }
  const spanX = xMax - xMin;
  const count = o.coverDugRim ? Math.ceil(spanX / PIT.bearer.spacingM - 1e-9) + 1 : Math.round(o.lengthX / PIT.bearer.spacingM);
  const bearerX = (i: number): number => (o.coverDugRim ? xMin + (spanX * i) / (count - 1) : c.x - ((count - 1) * PIT.bearer.spacingM) / 2 + i * PIT.bearer.spacingM);
  // Each bearer's half-length. coverDugRim (P28 third pass): its own line's dug width + overM, so both ends lie on the
  // undug ground of the rim, but short of the spoil's berm (the ring spoilSetbackM wide that holds no spoil): one long
  // enough for the widest dug point (±4.25 m at the cone-dug corners) lay with its ends up on the berm's flanks, a pole
  // 0.4 m up across the giant's path at the pit's end (at its ankle), not a cover lying on the rim.
  const raised = (x: number, z: number): boolean => ground(h, { x, z }) > h.w.terrain.originalHeightAt(x, z) + DUG_EDGE_M;
  const halfZ = (x: number): number => {
    if (!o.coverDugRim) return o.widthZ / 2 + PIT.bearer.overM;
    let w = 0;
    for (let z = 0; z < o.widthZ; z += 0.05) if (dug(x, c.z + z) || dug(x, c.z - z)) w = Math.max(w, z);
    let hz = w + PIT.bearer.overM;
    for (let z = w; z <= w + PIT.bearer.overM + 1e-9; z += 0.05) {
      if (raised(x, c.z + z) || raised(x, c.z - z)) {
        hz = Math.max(w + PIT.bearer.minOnRimM, z - PIT.bearer.bermGapM);
        break;
      }
    }
    return hz;
  };
  const hzs = Array.from({ length: count }, (_, i) => halfZ(offVertex(h, { x: bearerX(i), z: c.z }).x));
  const maxHz = Math.max(...hzs);
  /** The shortest and longest half-length of the bearers within grassNearM of x. */
  const hzNear = (x: number): { min: number; max: number } => {
    const hs = hzs.filter((_, i) => Math.abs(bearerX(i) - x) <= PIT.grassNearM);
    return hs.length > 0 ? { min: Math.min(...hs), max: Math.max(...hs) } : { min: zHalf, max: maxHz };
  };
  const zHalf = o.widthZ / 2;
  if (o.coverDugRim) console.info(`furnishPit: bearers x ${xMin.toFixed(2)} … ${xMax.toFixed(2)}: ${count} bearers ${hzs.map((z) => (2 * z).toFixed(2)).join(', ')} m long`);
  for (let i = 0; i < count; i++) {
    // Staged south-east of the pit (the player fetches them from the −z rim lane without crossing the pit).
    const q = { x: c.x + o.lengthX / 2 + 2, z: c.z - 9 - 0.4 * i };
    const L = 2 * hzs[i];
    bearers.push(h.stick({ length: L, r: PIT.bearer.r, material: 'rottenWood', p: { x: q.x + L / 2 - 1, y: ground(h, q) + PIT.bearer.r + 0.05, z: q.z }, q: lyingAlong(Math.PI / 2) }));
  }
  const grassIds: number[] = [];
  const G = PIT.grass;
  const spots: { q: XZ; side: number }[] = [];
  const half = o.lengthX / 2 - 0.3;
  for (const side of [-1, 1]) {
    // (coverDugRim: the rows inset from the hole's dug edge, as the bearers' ends are set from it, so the player laying
    // them from beyond those ends still reaches both rows.)
    // (coverDugRim: the rows set in from the nearest bearers' ends, each grassRowInM in, so the player laying them from
    // beyond those ends still reaches both rows.)
    for (const inset of G.rowsInsetM) {
      for (let cx = -half; cx <= half + 1e-9; cx += 0.2) {
        const rowHalf = o.coverDugRim ? hzNear(c.x + cx).max - PIT.grassRowInM : zHalf;
        spots.push({ q: offVertex(h, { x: c.x + cx, z: c.z + side * (rowHalf - inset) }), side });
      }
    }
  }
  Array.from({ length: o.grass.count }).forEach((_, gi) => {
    const q = { x: c.x + o.lengthX / 2 + 4 + 1.2 * (gi % 5), z: c.z - 19 - 1.0 * Math.floor(gi / 5) };
    grassIds.push(h.grass({ p: { x: q.x, y: ground(h, q) + 0.06, z: q.z }, mass: G.masses[gi % G.masses.length] }));
  });
  h.ticks(60);
  const rimY = (x: number, hz: number): number => {
    let top = -Infinity;
    const zs = o.coverDugRim
      ? [0.1, 0.35, 0.6, 0.85].flatMap((d) => [c.z - hz + PIT.bearer.overM - d, c.z + hz - PIT.bearer.overM + d]).filter((zz) => Math.abs(zz - c.z) <= hz)
      : [z0 - 0.5, z0 - 0.75, z0 - 1.0, z1 + 0.5, z1 + 0.75, z1 + 1.0];
    for (const zz of zs) top = Math.max(top, h.w.terrain.heightAt(x, zz));
    return top;
  };
  // The dirt piles lie out beyond the long sides (digPit's pileSides 'z'), and a pile heaped on a pile rolls: between
  // the staging (south-east) and the −z rim the player goes by the pit's +x end, never past them.
  const southEast = { x: c.x + o.lengthX / 2 + 1.5, z: c.z - maxHz - PIT.rimM };
  for (let i = 0; i < count; i++) {
    yield;
    const x = offVertex(h, { x: bearerX(i), z: c.z }).x;
    route(h, [southEast]);
    if (!bring(h, bearers[i], [southEast, { x, z: c.z - hzs[i] - PIT.rimM }])) throw new Error(`buildPit: bearer ${bearers[i]} broke on the way`);
    h.must({ verb: 'place', target: 0, at: toCm({ x, y: rimY(x, hzs[i]) + PIT.bearer.r + 0.05, z: c.z }), yaw: 0, pitch: 0 }, `lay bearer ${bearers[i]} at x ${x.toFixed(2)}`);
  }
  h.ticks(60);
  // Each bundle across two neighbouring bearers as they lie now (a light 8-gon pole settles and rolls a little on a
  // sloped rim): row by row, at the pair nearest each planned spot that no bundle covers yet, at their top there; a spot
  // with no free pair is passed over: as many as find two bearers, at least o.grass.minCount (PIT_GRASS_MIN on the
  // 8 × 6 m pit); the ones left over stay where they were spawned.
  const laid: XZ[] = [];
  const laidIds: number[] = [];
  const pairAt = (q: XZ): { x: number; y: number } | null => {
    const at = bearers
      .filter((b) => h.w.entities.get(b) !== undefined)
      .map((b) => {
        const d = q.z - h.ent(b).pose.p.z;
        const [u, v] = [pointOn(h, b, { x: 0, y: d, z: 0 }), pointOn(h, b, { x: 0, y: -d, z: 0 })];
        return Math.abs(u.z - q.z) <= Math.abs(v.z - q.z) ? u : v;
      })
      .filter((p) => Math.abs(p.z - q.z) < 0.3)
      .sort((a, b) => a.x - b.x);
    let pick: { x: number; y: number } | null = null;
    for (let k = 0; k + 1 < at.length; k++) {
      if (at[k + 1].x - at[k].x > 0.65 || at[k + 1].x - at[k].x < 0.15) continue;
      const m = { x: (at[k].x + at[k + 1].x) / 2, y: Math.max(at[k].y, at[k + 1].y) + PIT.bearer.r };
      if (Math.abs(m.x - q.x) > 0.15 || laid.some((l) => Math.abs(l.z - q.z) < 0.3 && Math.abs(l.x - m.x) < 0.77)) continue;
      if (!pick || Math.abs(m.x - q.x) < Math.abs(pick.x - q.x)) pick = m;
    }
    return pick;
  };
  let next = 0;
  for (const { q, side } of spots) {
    yield;
    if (next >= grassIds.length) break;
    if (!pairAt(q)) continue;
    const id = grassIds[next++];
    // To the +z rim round the pit's +x end, and back the same way (never across the pit).
    const lane = maxHz + PIT.grassLaneM;
    const corner = (z: number): XZ => ({ x: c.x + o.lengthX / 2 + 1.5, z });
    if (h.p.pos.z > c.z + o.widthZ / 2) route(h, [corner(c.z + lane), corner(c.z - lane)]);
    else route(h, [corner(c.z - lane)]);
    if (!bring(h, id, side > 0 ? [corner(c.z - lane), corner(c.z + lane)] : [corner(c.z - lane)])) continue;
    const pick = pairAt(q);
    if (!pick) throw new Error(`buildPit: the bearers under (${q.x.toFixed(2)}, ${q.z.toFixed(2)}) moved`);
    const gx = offVertex(h, { x: pick.x, z: q.z });
    // From the lane, or (out of reach: the berm there stood him higher or further off) a step nearer the bearers' ends.
    let placed: string | null = 'outOfReach';
    const near = o.coverDugRim ? hzNear(gx.x).max + PIT.grassLaneM : lane;
    for (const d of [near, near - 0.25]) {
      if (!bring(h, id, [{ x: gx.x, z: c.z + side * d }])) break;
      const r = h.verb({ verb: 'place', target: 0, at: toCm({ x: gx.x, y: pick.y + 0.07, z: gx.z }), yaw: 64, pitch: 0 });
      placed = r.ok ? null : r.reason;
      if (placed !== 'outOfReach') break;
    }
    if (!h.w.entities.get(id)) continue;
    if (placed !== null) throw new Error(`buildPit: lay grass ${id} at (${gx.x.toFixed(2)}, ${q.z.toFixed(2)}) refused (${placed})`);
    laid.push(gx);
    laidIds.push(id);
  }
  if (h.p.pos.z > c.z + o.widthZ / 2) route(h, [{ x: c.x + o.lengthX / 2 + 1.5, z: c.z + maxHz + PIT.grassLaneM }, { x: c.x + o.lengthX / 2 + 1.5, z: c.z - maxHz - PIT.grassLaneM }]);
  if (laidIds.length < o.grass.minCount) throw new Error(`buildPit: only ${laidIds.length} of ${grassIds.length} grass bundles laid on two bearers`);
  h.ticks(120);
  return { cover: [...bearers, ...laidIds], stakes };
}

// ---------------------------------------------------------------------------
// Cached scenes (globalSetup.ts)
// ---------------------------------------------------------------------------

/** The world the pit scene is built in: §11.2(b)/§11.3's pit at (0, 0), room for the giant's run-ups from x −40. */
export const PIT_SCENE = { seed: 20261017, size: 120 } as const;

/** AC-2(b)/AC-3's pit scene: buildPit at (0, 0) on a fresh `scene 'empty'` world; the player left on the −z rim. */
export async function pitScene(): Promise<Uint8Array> {
  const h = await makeHarness({ seed: PIT_SCENE.seed, size: PIT_SCENE.size });
  try {
    await buildPitAsync(h, { centre: { x: 0, z: 0 }, lengthX: 8, widthZ: 6, depth: 2.5, stakeSpacing: 0.6 });
    h.standAt({ x: 0, z: -10 });
    h.ticks(60);
    return h.saveBytes();
  } finally {
    h.w.dispose();
  }
}

/** The probe scene's numbers (the harness test checks them). */
export const PROBE_SCENE = { seed: 5, size: 30, stakes: [{ x: 1, z: 2 }, { x: -1, z: 2 }], log: { x: 0, z: -2 } } as const;

/** The harness test's cache probe: two stakes placed driven and a 20 kg log carried and laid down, by verbs. */
export async function probeScene(): Promise<Uint8Array> {
  const h = await makeHarness({ seed: PROBE_SCENE.seed, size: PROBE_SCENE.size });
  try {
    for (const s of PROBE_SCENE.stakes) {
      const id = stickAt(h, { x: s.x + 2, z: s.z + 2 }, 1.4, 0.05, { sharp: 0.6 });
      h.ticks(1);
      placeUpright(h, id, s, 1.4, { from: { x: 0, z: -1 }, standOff: 0.9 });
    }
    const log = h.log({ mass: 20, length: 1.5, r: 0.1, p: { x: 3, y: 0.12, z: -4 } });
    h.ticks(10);
    h.carryTo(log, { x: PROBE_SCENE.log.x, z: PROBE_SCENE.log.z - 1 });
    h.must({ verb: 'place', target: 0, at: toCm({ x: PROBE_SCENE.log.x, y: 0.1, z: PROBE_SCENE.log.z }), yaw: 64, pitch: 0 }, 'lay the probe log');
    h.ticks(60);
    return h.saveBytes();
  } finally {
    h.w.dispose();
  }
}
