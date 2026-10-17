// The HUD of the Clearing (docs/M1-DESIGN.md §10.8, package P36), read as data (the DOM that draws it needs a browser):
// the hands strip (held thing's name, mass, mode, two-handed mark; belt and back slots with their keys), the target bar
// (an ape's HP; a ruler's bar with a notch per wound, severe ones marked), the lock-on that shows them, the compass's
// bearings and the giant's last sighting (frustum, range, terrain line, fading), the awareness markers, and the death
// banner, whose countdown reads sim ticks (it slows with slow motion and stops with the sim).
//
// Positions, masses, HP and ticks here are test constants, never tuning (§9).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import {
  createPlayer,
  createWorld,
  DT,
  type Fighter,
  type Hit,
  type MindView,
  physicsReady,
  spawnLog,
  spawnStick,
  spawnStone,
  type RulerState,
  WEAPONS,
  WORLD_TUNING,
  type World,
} from '@wild/sim';
import { beatOf } from '../src/game/game';
import { FOLLOW_TUNING } from '../src/render/followCam';
import { awarenessMarks, markerPoint } from '../src/render/markers';
import { VERB_UI_TUNING } from '../src/input/verbInput';
import { bannerText, entityLabel, handsModel, HUD_TUNING, keyFor, lockedTarget, massText, rulerBarLayout, targetModel } from '../src/ui/hud';
import { bearingDeg, GiantSighting, headingDeg, type SightWorld, stripOffset } from '../src/ui/compass';
import { DEFAULT_BINDINGS } from '../src/input/bindings';

const SOURCES = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

/** The source with comments blanked. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const live: World[] = [];
async function make(): Promise<World> {
  const w = await createWorld({ seed: 3, scene: 'empty', nav: 'off', size: 50 });
  live.push(w);
  return w;
}

beforeAll(async () => {
  await physicsReady();
});

afterEach(() => {
  for (const w of live.splice(0)) w.dispose();
});

describe('the hands strip (§10.8)', () => {
  it("names what the hands hold, its mass and mode, and the belt and back slots with their keys", async () => {
    const w = await make();
    const me = w.player!;
    const spear = spawnStick(w, { p: { x: 3, y: 0.2, z: 0 }, length: 1.8, r: 0.02, material: 'greenWood', sharp: { end: 1, s: 0.5 } });
    const flint = spawnStone(w, { p: { x: 4, y: 0.2, z: 0 }, mass: 0.6, material: 'flint' });
    const stick = spawnStick(w, { p: { x: 5, y: 0.2, z: 0 }, length: 1.5, r: 0.025, material: 'dryWood' });
    const stone = spawnStone(w, { p: { x: 6, y: 0.3, z: 0 }, mass: 12 });
    const log = spawnLog(w, { p: { x: 7, y: 0.3, z: 0 }, length: 3, mass: 120 });

    // Empty hands and slots, keys from §5.14 until the bindings carry the belt actions (P35).
    const empty = handsModel(w, me, DEFAULT_BINDINGS);
    expect(empty.held).toBeNull();
    expect(empty.slots).toEqual([
      { key: '1', name: null, back: false },
      { key: '2', name: null, back: false },
      { key: '3', name: null, back: false },
      { key: '4', name: null, back: true },
    ]);
    expect(keyFor({ ...DEFAULT_BINDINGS, belt1: 'KeyZ' }, 'belt1')).toBe('Z');

    // A wielded tool: its tool class's name, and the mass of the held object (everything lashed to it, heldMembers;
    // a lash needs P10's joints, so this one is a single shaped stick).
    me.inventory = { hands: { entity: spear, mode: 'wield', grip: { x: 0, y: 0, z: 0 }, twoHanded: false, joint: null }, belt: [flint, null, null], back: stick };
    me.weapon = WEAPONS.sharpStick;
    const wield = handsModel(w, me, DEFAULT_BINDINGS);
    expect(wield.held).toEqual({ name: 'Sharpened Stick', massKg: w.entities.get(spear)!.mass, mode: 'wield', modeLabel: 'wielded', twoHanded: false });
    expect(wield.slots.map((s) => s.name)).toEqual(['flint', null, null, 'dry wood stick']);

    // A carried stone weighs what the sim's load says; a dragged log is two-handed.
    me.weapon = null;
    me.inventory = { hands: { entity: stone, mode: 'carry', grip: { x: 0, y: 0, z: 0 }, twoHanded: true, joint: null }, belt: [null, null, null], back: null };
    me.load = { massKg: 12, mode: 'carry' };
    expect(handsModel(w, me, DEFAULT_BINDINGS).held).toEqual({ name: 'stone', massKg: 12, mode: 'carry', modeLabel: 'carried', twoHanded: true });
    me.inventory = { hands: { entity: log, mode: 'drag', grip: { x: 0, y: 0, z: 0 }, twoHanded: true, joint: null }, belt: [null, null, null], back: null };
    me.load = { massKg: w.entities.get(log)!.mass, mode: 'drag' };
    const drag = handsModel(w, me, DEFAULT_BINDINGS).held!;
    expect(drag.name).toBe('dry wood log');
    expect(drag.massKg).toBeCloseTo(120, 6);
    expect(drag.modeLabel).toBe('dragging');
    expect(massText(drag.massKg)).toBe('120 kg');
    expect(massText(1.234)).toBe('1.2 kg');

    // Something gone from the world (a stowed entity removed) shows as an empty slot, never a crash.
    me.inventory = { hands: null, belt: [999_999, null, null], back: null };
    expect(handsModel(w, me, DEFAULT_BINDINGS).slots[0].name).toBeNull();
  });

  it('labels things by material and look', () => {
    expect(entityLabel({ material: 'dryWood', look: 'log' })).toBe('dry wood log');
    expect(entityLabel({ material: 'flint', look: 'flint' })).toBe('flint');
    expect(entityLabel({ material: 'vine', look: 'coil' })).toBe('vine coil');
    expect(entityLabel({ material: 'leaves', look: 'grass' })).toBe('grass bundle');
    expect(entityLabel({ material: 'stone', look: 'flint' })).toBe('flint');
  });
});

describe('the target bar while locked on (§10.8)', () => {
  it("shows while the target is alive and within the fight camera's range; an ape's bar is its HP", () => {
    const me = createPlayer();
    const ape = createPlayer();
    ape.name = 'Ape';
    me.target = ape;
    ape.pos.set(FOLLOW_TUNING.fightRangeM - 0.5, 0, 0);
    expect(lockedTarget(me)).toBe(ape);
    ape.pos.set(FOLLOW_TUNING.fightRangeM + 0.5, 0, 0);
    expect(lockedTarget(me)).toBeNull();
    ape.pos.set(2, 0, 0);
    ape.hp = ape.stats.maxHp / 4;
    expect(targetModel(ape)).toEqual({ name: 'Ape', hp: 0.25, ruler: null });
    ape.enterKO();
    expect(lockedTarget(me)).toBeNull();
  });

  it("lays a ruler's bar out: HP, what recovers, a notch per wound (severe ones marked, healed ones kept), the lost maximum", () => {
    const max = 12000;
    const eff = max * (1 - 0.05);
    const bar = rulerBarLayout(max, eff, 300, [
      { remaining: 600, severe: false },
      { remaining: 2000, severe: true },
      { remaining: 0, severe: false },
    ]);
    expect(bar.hp).toBeCloseTo((eff - 300 - 2600) / max, 12);
    expect(bar.recovering).toBeCloseTo(300 / max, 12);
    expect(bar.wounds.map((w) => w.severe)).toEqual([false, true, false]);
    expect(bar.wounds[0].from).toBeCloseTo(bar.hp + bar.recovering, 12);
    expect(bar.wounds[0].to - bar.wounds[0].from).toBeCloseTo(600 / max, 12);
    expect(bar.wounds[1].from).toBe(bar.wounds[0].to);
    expect(bar.wounds[1].to - bar.wounds[1].from).toBeCloseTo(2000 / max, 12);
    // A healed wound keeps its notch (rule 9: wounds on rulers persist).
    expect(bar.wounds[2].from).toBe(bar.wounds[2].to);
    expect(bar.lostFrom).toBeCloseTo(0.95, 12);
    // Never outside the bar.
    const over = rulerBarLayout(max, max, 20000, [{ remaining: 5000, severe: true }]);
    expect(over.hp).toBe(0);
    expect(over.recovering).toBe(1);
    expect(over.wounds[0]).toEqual({ from: 1, to: 1, severe: true });
  });
});

describe('the compass (§10.8)', () => {
  it('reads bearings clockwise from north (−z) through east (+x), on a 180° strip ahead of the camera', () => {
    expect(bearingDeg(0, -1)).toBe(0);
    expect(bearingDeg(1, 0)).toBe(90);
    expect(bearingDeg(0, 1)).toBe(180);
    expect(bearingDeg(-1, 0)).toBe(270);
    const cam = new PerspectiveCamera();
    expect(headingDeg(cam)).toBeCloseTo(0, 9);
    cam.lookAt(1, 0, 0);
    cam.updateMatrixWorld();
    expect(headingDeg(cam)).toBeCloseTo(90, 9);
    const span = HUD_TUNING.compassSpanDeg;
    expect(span).toBe(180);
    expect(stripOffset(90, 0, span)).toBe(0.5);
    expect(stripOffset(91, 0, span)).toBeNull();
    expect(stripOffset(350, 10, span)).toBeCloseTo(-20 / 180, 12);
    expect(stripOffset(10, 350, span)).toBeCloseTo(20 / 180, 12);
  });

  it('pings where the giant was last seen: in the frustum, within range, over a clear terrain line; then it fades', () => {
    const me = createPlayer();
    const giant = createPlayer();
    giant.scale = 5.5;
    giant.ruler = {} as RulerState;
    let blocked = false;
    const world: SightWorld = {
      combat: { fighters: [me, giant] },
      queries: { castRay: () => (blocked ? ({ toi: 1 } as Hit) : null) },
    };
    const place = (z: number) => {
      giant.pos.set(0, 0, z);
      giant.rig.chest.pos.set(0, 8, z);
    };
    const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 600);
    cam.position.set(0, 2, 5);
    cam.lookAt(0, 2, -100);
    const s = new GiantSighting();
    place(-60);
    s.update(world, me, cam, 0.016);
    expect(s.seen).toBe(true);
    expect(s.at).toEqual({ x: 0, z: -60 });
    expect(s.opacity).toBe(1);
    // Out of range: not seen; the ping stays where it was and starts to fade.
    place(-(VERB_UI_TUNING.compassSeeRangeM + 5));
    s.update(world, me, cam, 3);
    expect(s.seen).toBe(false);
    expect(s.at).toEqual({ x: 0, z: -60 });
    expect(s.opacity).toBeCloseTo(1 - 3 / VERB_UI_TUNING.compassPingS, 12);
    // Behind the camera, or behind a hill: not seen either.
    place(40);
    s.update(world, me, cam, 1);
    expect(s.seen).toBe(false);
    place(-50);
    blocked = true;
    s.update(world, me, cam, 1);
    expect(s.seen).toBe(false);
    expect(s.at).toEqual({ x: 0, z: -60 });
    // Seen again: the ping jumps to where it is now; then it fades out over compassPingS and goes.
    blocked = false;
    s.update(world, me, cam, 1);
    expect(s.at).toEqual({ x: 0, z: -50 });
    blocked = true;
    s.update(world, me, cam, VERB_UI_TUNING.compassPingS / 2);
    expect(s.opacity).toBeCloseTo(0.5, 12);
    s.update(world, me, cam, VERB_UI_TUNING.compassPingS / 2);
    expect(s.at).toBeNull();
    expect(s.opacity).toBe(0);
    // A dead ruler is no sighting.
    blocked = false;
    giant.enterKO();
    s.update(world, me, cam, 1);
    expect(s.at).toBeNull();
  });
});

describe('awareness markers (§10.8, rule 3)', () => {
  it("shows a creature's ? or ! from its mind's read-only view, within markerRangeM of the player", () => {
    const me = createPlayer();
    me.playerId = 'p1';
    const near = createPlayer();
    const far = createPlayer();
    const calm = createPlayer();
    const dead = createPlayer();
    near.pos.set(5, 0, 0);
    far.pos.set(VERB_UI_TUNING.markerRangeM + 1, 0, 0);
    calm.pos.set(3, 0, 0);
    dead.pos.set(4, 0, 0);
    dead.enterKO();
    const marks = new Map<Fighter, MindView['marker']>([
      [near, '!'],
      [far, '?'],
      [calm, ''],
      [dead, '!'],
    ]);
    const world = {
      combat: { fighters: [me, near, far, calm, dead] },
      minds: { view: (f: Fighter): MindView => ({ state: 'idle', awareness: 0, marker: marks.get(f) ?? '' }) },
    };
    expect(awarenessMarks(world, me, VERB_UI_TUNING.markerRangeM)).toEqual([{ f: near, mark: '!' }]);
    marks.set(near, '?');
    expect(awarenessMarks(world, me, VERB_UI_TUNING.markerRangeM)).toEqual([{ f: near, mark: '?' }]);
    // Over the head, by the creature's size.
    near.scale = 1.1;
    near.rig.head.pos.set(5, 1.8, 0);
    expect(markerPoint(near, HUD_TUNING.markerLiftM).toArray()).toEqual([5, 1.8 + HUD_TUNING.markerLiftM * 1.1, 0]);
  });
});

describe('death and respawn (§10.8)', () => {
  it('counts the respawn down in sim ticks: "DOWN — back in N s" from (respawnTick − tick) × DT', async () => {
    const w = await make();
    const me = w.player!;
    w.combat.koFighter(me, { by: 'strike', killer: null, cause: null, point: me.pos.clone() });
    const r = w.step();
    const death = r.world.find((e) => e.type === 'death');
    expect(death && death.type === 'death' && death.f).toBe(me);
    if (!death || death.type !== 'death') return;
    expect(death.respawnTick).toBe(w.tick + Math.round(WORLD_TUNING.respawnDelayS / DT));
    // game.ts keeps the death's respawn tick (beatOf) and feeds the HUD the sim seconds left each frame.
    const beat = beatOf(death, { player: me, cues: false, hitstop: 0, falling: new Set(), camera: { x: 0, y: 0, z: 0 } });
    expect(beat.respawnTick).toBe(death.respawnTick);
    const game = SOURCES['../src/game/game.ts'];
    expect(game).toMatch(/this\.hud\.deathBanner\(this\.respawnTick === null \? null : Math\.max\(0, \(this\.respawnTick - w\.tick\) \* DT\)\)/);
    const left = () => Math.max(0, (beat.respawnTick! - w.tick) * DT);
    expect(bannerText(left())).toBe('back in 10 s');
    // Rendered frames that step no tick (a pause, a hit-pause) leave it where it is; ticks count it down.
    expect(bannerText(left())).toBe('back in 10 s');
    for (let i = 0; i < 300; i++) w.step();
    expect(left()).toBeCloseTo(5, 9);
    expect(bannerText(left())).toBe('back in 5 s');
    expect(bannerText(left() - 0.01)).toBe('back in 5 s');
    expect(bannerText(4.2)).toBe('back in 5 s');
    // The respawn comes at that tick, and the banner reads 0 there.
    let respawned = false;
    while (!respawned && w.tick < death.respawnTick + 5) respawned = w.step().world.some((e) => e.type === 'respawn' && e.f === me);
    expect(respawned).toBe(true);
    expect(w.tick).toBe(death.respawnTick);
    expect(bannerText(left())).toBe('back in 0 s');
    expect(beatOf({ type: 'respawn', f: me, at: { x: 0, y: 0, z: 0 } }, { player: me, cues: false, hitstop: 0, falling: new Set(), camera: { x: 0, y: 0, z: 0 } }).respawnTick).toBeNull();
  });

  it("the training ring's round label is gone from the HUD", () => {
    for (const f of ['../src/ui/hud.ts', '../src/ui/hudPort.ts']) expect(code(SOURCES[f]), f).not.toMatch(/class="wave"|\.wave\b|\bthis\.wave\b/);
  });
});
