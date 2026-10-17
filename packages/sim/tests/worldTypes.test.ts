import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { VerbCommand } from '../src/sim/commands';
import { createPlayer } from '../src/sim/roster';
import type {
  Drive,
  Entity,
  EntitySpec,
  Finish,
  FighterMover,
  GroundQuery,
  Impact,
  ImpactCause,
  ImpactResult,
  Inventory,
  JointRecord,
  KnockRecord,
  Owner,
  Pose3,
  Posture,
  RulerState,
  V3,
  Work,
  WorldEvent,
  WorldPort,
} from '../src/world/types';

// These types are what every later package builds on (docs/M1-DESIGN.md §1.3, §2, §1.5.2): the checks below are
// mostly compile-time (this file is type-checked by `npm run typecheck`), plus a few runtime facts about them.

const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const pose = (): Pose3 => ({ p: v3(), q: { x: 0, y: 0, z: 0, w: 1 } });
const cause: ImpactCause = { kind: 'entity', entityId: 7, fighterId: null, credit: ['p1'], held: false, feature: 'sharpPoint' };

describe('world types', () => {
  it("accept Three's Vector3 where a V3 record is asked for", () => {
    const a: V3 = new Vector3(1, 2, 3);
    const hit: Impact['point'] = new Vector3();
    expect(a.y + hit.x).toBe(2);
  });

  it('describe an entity record with its runtime-only Rapier fields empty', () => {
    const spec: EntitySpec = { material: 'dryWood', shape: { kind: 'cylinder', halfHeight: 0.7, r: 0.025, sides: 8 }, p: v3(0, 1, 0), look: 'stake' };
    const e: Entity = {
      id: 1,
      material: spec.material,
      shape: spec.shape,
      mass: 1,
      state: 'anchored',
      pose: pose(),
      vel: { lin: v3(), ang: v3() },
      integrity: 1,
      moisture: 0,
      temperature: 15,
      burning: false,
      sharpPoints: [{ local: v3(0, 0.7, 0), dir: v3(0, 1, 0), sharpness: 0.6 }],
      joints: [],
      age: 0,
      credit: ['p1'],
      look: spec.look,
      plant: null,
      anchor: { depthM: 0.3, capacityN: 1200 },
      rope: null,
      crossCut: null,
      thrown: null,
      loadHist: new Float32Array(12),
      restTicks: 0,
      generated: false,
      touched: true,
      grace: { from: { kind: 'fighter', id: 3, part: 'ruler', bone: 'shinL' }, minUntil: 10, maxUntil: 600 },
      releasedBy: null,
      body: null,
      collider: null,
      prevPose: pose(),
    };
    const j: JointRecord = {
      id: 1,
      kind: 'rope',
      a: { entity: 1, local: v3() },
      b: { entity: null, local: v3(), fighter: 1 },
      rope: { entity: 2, lengthM: 4 },
      breakEnergyJ: Infinity,
      axis: null,
      limits: null,
      motor: null,
      holdsBend: null,
      tension: [0, 0, 0],
      pullN: 0,
      credit: [],
    };
    expect(e.sharpPoints[0].sharpness).toBeLessThanOrEqual(0.6);
    expect(j.b.fighter).toBe(1);
  });

  it('narrow owners and events by their tags', () => {
    const owners: Owner[] = [
      { kind: 'terrain' },
      { kind: 'entity', id: 4 },
      { kind: 'fighter', id: 2, part: 'zone', bone: 'head' },
      { kind: 'rope', joint: 9 },
    ];
    const ids = owners.map((o) => (o.kind === 'entity' ? o.id : o.kind === 'fighter' ? o.id : o.kind === 'rope' ? o.joint : 0));
    expect(ids).toEqual([0, 4, 2, 9]);

    const f = createPlayer();
    const wound = {
      id: 1,
      zone: 'knees' as const,
      bone: 'shinL' as const,
      local: v3(),
      severe: false,
      effect: null,
      hp: 300,
      remaining: 300,
      cause,
      tick: 5,
      credit: ['p1'],
    };
    const events: WorldEvent[] = [
      {
        type: 'impact', tick: 1, defender: f, point: v3(), normal: v3(0, 1), dir: v3(0, -1), zone: 'head', bone: 'head', rulerZone: null,
        energy: 212, toughness: 0, damage: 11.8, dv: v3(0, -7.1), knockdown: true, launched: false, ko: false, corpse: false,
        weight: 'heavy', impulse: 1, lift: 0, hitstop: 0, shake: 0, cause, wound: null,
      },
      { type: 'wound', ruler: f, wound, byWorld: true },
      { type: 'launch', f, vel: v3(6), angVel: v3() },
      { type: 'trip', f, at: v3(), why: 'cover', cause },
      { type: 'rise', f },
      { type: 'pit', f, on: true },
      { type: 'tripwire', joint: 1, by: owners[2], loadN: 3902, snapped: false, loosed: [], point: v3() },
      { type: 'pinned', f, on: true },
      { type: 'shove', ruler: f, entity: 3 },
      { type: 'deflect', ruler: f, along: v3(1) },
      { type: 'land', entity: 3, f: null, point: v3(), energy: 10, mass: 300 },
      { type: 'break', entity: 3, pieces: [4, 5], point: v3(), energy: 800 },
      { type: 'joint', joint: 1, what: 'snap', point: v3() },
      { type: 'chop', tree: 2, point: v3(), remaining: 0.9 },
      { type: 'fell', tree: 2, dir: v3(1) },
      { type: 'crossCut', entity: 3, pieces: null },
      { type: 'dig', point: v3(), volumeM3: 0.0391, pile: null },
      { type: 'spawn', entity: 6 },
      { type: 'remove', entity: 6 },
      { type: 'death', f, respawnTick: 600 },
      { type: 'respawn', f, at: v3() },
      { type: 'parts', victim: 2, entities: [7, 8], environmental: true },
      { type: 'verb', f, verb: 'take', ok: false, reason: 'tooHeavy', entity: 3 },
      { type: 'noise', at: v3(), radius: 40, kind: 'chop' },
    ];
    expect(new Set(events.map((e) => e.type)).size).toBe(events.length);
    const woundEvents = events.filter((e): e is Extract<WorldEvent, { type: 'wound' }> => e.type === 'wound');
    expect(woundEvents[0].wound.zone).toBe('knees');
  });

  it('give fighters their M1 data: hands, drive, posture, work, ruler state, knocks', () => {
    const inv: Inventory = { hands: { entity: 4, mode: 'wield', grip: v3(), twoHanded: false, joint: null }, belt: [null, 5, null], back: 6 };
    const drive: Drive = { heading: Math.PI / 2, speed: 6, accel: 4, climb: false };
    const posture: Posture = { id: 'headLow', weight: 0.5 };
    const cmd: VerbCommand = { tick: 1, player: 1, kind: 'verb', verb: 'lash', target: 1, second: 2 };
    const work: Work = { kind: 'lash', frames: 90, actAt: 60, faceAt: v3(), keys: [], cmd };
    const ruler: RulerState = {
      maxHp: 12000, unhealed: 0, wounds: [], pinned: false, pinnedKg: 0, unpinTicks: 0, stuck: false, burning: false,
      inPit: false, downWound: null, downCause: null, lastWorldTrip: null, deflectedHeading: null,
      pendingTrip: { why: 'obstacle', tick: 3, cause },
    };
    const knock: KnockRecord = { tick: 4, cause, by: 2 };
    const finish: Finish = { by: 'impact', killer: null, cause, point: v3() };
    const result: ImpactResult = { damage: 0, knockdown: false, launched: false, ko: false, reaction: v3(), wound: null };
    expect([inv.back, drive.speed, posture.weight, work.actAt, ruler.maxHp, knock.by, finish.by, result.damage]).toEqual([6, 6, 0.5, 60, 12000, 2, 'impact', 0]);
  });

  it('define the CombatSim seams as interfaces a world can implement', () => {
    const ground: GroundQuery = { heightAt: () => 0.5 };
    const support: GroundQuery = { heightAt: () => 0, supportAt: (_x, _z, fromY) => Math.min(fromY, 1) };
    const mover: FighterMover = { resolve: (f) => void f.pos.setY(ground.heightAt(f.pos.x, f.pos.z)) };
    const port: WorldPort = {
      strike: () => null,
      tryVerb: () => {},
      completeWork: () => {},
      throwRelease: () => false,
      projectile: () => null,
      onProjectileLanded: () => false,
      onKO: () => ({ environmental: false, credit: [] }),
      onWeaponDropped: () => false,
      rulerHit: () => {},
    };
    const f = createPlayer();
    mover.resolve(f, 0.3, 0);
    expect(f.pos.y).toBe(0.5);
    expect(support.supportAt!(0, 0, 3)).toBe(1);
    expect(port.onKO(f, { by: 'strike', killer: null, cause: null, point: v3() })).toEqual({ environmental: false, credit: [] });
  });
});
