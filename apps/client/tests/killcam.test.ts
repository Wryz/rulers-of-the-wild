// The kill cam (docs/M1-DESIGN.md §10.3, SPEC:583-588, rule 8; package P36): every kill cam starts in KillCam.onMoment,
// which picks the shot for the moment's kind from KILLCAM_TUNING and hands it to Cinematics (the real one here). One cut
// per kind per cooldownS of sim time; a moment that gets no cut (its cooldown, a bigger cut running, or replaced in its
// own tick) is still marked as a saved moment (SPEC:933, RR-14). Nothing else in the client starts a cut.
//
// Positions, ticks and scales here are test constants, never tuning (§9).
import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { createPlayer, DT, type Fighter, type RulerState } from '@wild/sim';
import { KILLCAM_TUNING, KillCam, type KillCamViews, type Moment, type MomentKind, sideAcross } from '../src/game/killcam';
import { Cinematics, type Shot } from '../src/render/cinematics';

const SOURCES = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

/** The source with comments blanked (line numbers kept). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 5000;
const COOLDOWN_TICKS = () => Math.round(KILLCAM_TUNING.cooldownS / DT);

function fighter(o: { scale?: number; at?: [number, number, number]; ruler?: boolean; player?: boolean } = {}): Fighter {
  const f = createPlayer();
  f.scale = o.scale ?? 1;
  f.pos.set(...(o.at ?? [0, 0, 0]));
  if (o.player) f.playerId = 'p1';
  if (o.ruler) f.ruler = { maxHp: 12000, unhealed: 0, wounds: [] } as unknown as RulerState;
  // A standing body's joints around its position (the sim's rig, as the views would see it).
  const s = f.scale;
  f.rig.pelvis.pos.set(f.pos.x, f.pos.y + 1 * s, f.pos.z);
  f.rig.chest.pos.set(f.pos.x, f.pos.y + 1.4 * s, f.pos.z);
  f.rig.head.pos.set(f.pos.x, f.pos.y + 1.7 * s, f.pos.z);
  f.rig.shinL.pos.set(f.pos.x + 0.1 * s, f.pos.y + 0.5 * s, f.pos.z);
  return f;
}

function moment(kind: MomentKind, subject: Fighter, o: Partial<Moment> = {}): Moment {
  return {
    kind,
    tick: T0,
    subject,
    point: subject.pos.clone().setY(subject.pos.y + subject.scale),
    dir: new Vector3(1, 0, 0),
    causeEntity: 3,
    severity: 1,
    ...o,
  };
}

function rig(o: { view?: Vector3; ground?: number; pelvisY?: number; views?: Partial<KillCamViews> } = {}) {
  const cine = new Cinematics();
  const shots: Shot[] = [];
  const view = o.view ?? new Vector3(0, 3, 10);
  const views: KillCamViews = {
    pelvisOf: (f) => () => f.pos.clone().setY(o.pelvisY ?? f.pos.y + f.scale),
    ground: () => o.ground ?? 0,
    viewPos: () => view,
    ...o.views,
  };
  const kc = new KillCam((s) => {
    shots.push(s);
    return cine.play(s);
  }, views);
  return { cine, kc, shots, view };
}

// ---------------------------------------------------------------------------

describe('KillCam: one function receives the moment (§10.3)', () => {
  it("KILLCAM_TUNING holds §9.1's starting values", () => {
    const K = KILLCAM_TUNING;
    expect(K.cooldownS).toBe(4);
    expect(K.envKill).toMatchObject({ dist: 3.8, distScale: 0.75, height: 0.55, orbit: 0.3, fov: 38, durationS: 2.2, slow: 0.18, priority: 4, toward: 0.1 });
    expect(K.worldWound).toMatchObject({ dist: 3.3, height: -0.15, orbit: -0.12, dolly: -0.35, fov: 42, durationS: 2.4, slow: 0.25, priority: 4.5 });
    expect(K.rulerDeath).toMatchObject({ dist: 4, height: 0.3, orbit: 0.1, fov: 40, durationS: 4.0, slow: 0.2, priority: 6 });
    expect(K.playerByRuler).toMatchObject({ dist: 7, height: 2.5, orbit: 0.2, fov: 44, durationS: 2.6, slow: 0.3, priority: 5.5 });
    // DS's death cam and skull cut (game.ts onKO, skullBlow), on Cinematics' ladder: death 5, skull 4.5, finisher 4.
    expect(K.playerDeath).toMatchObject({ dist: 3.0, height: 1.7, orbit: 0.16, dolly: -0.2, fov: 40, durationS: 3.2, slow: 0.22, priority: 5, toward: -0.2 });
    expect(K.skullSplit).toMatchObject({ dist: 1.9, distScale: 0.8, height: 0.25, orbit: 0.4, dolly: -0.2, fov: 36, durationS: 2.1, slow: 0.1, priority: 4.5, toward: 0.45 });
    expect(K.focusFloor).toBe(0.35);
  });

  it('cuts every kind with its own shot', () => {
    const K = KILLCAM_TUNING;
    const { kc } = rig();
    const ape = fighter({ scale: 1.1, at: [2, 0, 0] });
    const big = fighter({ scale: 2, at: [4, 0, 0] });
    const giant = fighter({ scale: 5.5, at: [0, 0, 20], ruler: true });
    const me = fighter({ player: true });
    const shot = (kind: MomentKind, f: Fighter) => kc.shotFor(moment(kind, f));
    const pick = (s: Shot) => ({ distance: s.distance, height: s.height, orbit: s.orbit, dolly: s.dolly, fov: s.fov, duration: s.duration, slow: s.slow, priority: s.priority });

    expect(pick(shot('envKill', ape))).toEqual({ distance: 3.8, height: 0.55, orbit: 0.3, dolly: undefined, fov: 38, duration: 2.2, slow: 0.18, priority: 4 });
    expect(shot('envKill', big).distance).toBeCloseTo(3.8 * 1.5, 12);
    const ww = pick(shot('worldWound', giant));
    expect(ww).toMatchObject({ orbit: -0.12, dolly: -0.35, fov: 42, duration: 2.4, slow: 0.25, priority: 4.5 });
    expect(ww.distance).toBeCloseTo(3.3 * 5.5, 12);
    expect(ww.height).toBeCloseTo(-0.15 * 5.5, 12);
    const rd = pick(shot('rulerDeath', giant));
    expect(rd).toMatchObject({ orbit: 0.1, fov: 40, duration: 4, slow: 0.2, priority: 6 });
    expect(rd.distance).toBeCloseTo(4 * 5.5, 12);
    expect(rd.height).toBeCloseTo(0.3 * 5.5, 12);
    expect(pick(shot('playerByRuler', me))).toEqual({ distance: 7, height: 2.5, orbit: 0.2, dolly: undefined, fov: 44, duration: 2.6, slow: 0.3, priority: 5.5 });
    expect(pick(shot('playerDeath', me))).toEqual({ distance: 3, height: 1.7, orbit: 0.16, dolly: -0.2, fov: 40, duration: 3.2, slow: 0.22, priority: 5 });
    expect(pick(shot('skullSplit', ape))).toEqual({ distance: 1.9, height: 0.25, orbit: 0.4, dolly: -0.2, fov: 36, duration: 2.1, slow: 0.1, priority: 4.5 });
    expect(shot('skullSplit', big).distance).toBeCloseTo(1.9 * 1.6, 12);
    // playerByRuler beats the death cam; a ruler's death beats everything (§10.3).
    expect(K.playerByRuler.priority).toBeGreaterThan(K.playerDeath.priority);
    expect(K.rulerDeath.priority).toBeGreaterThan(K.playerByRuler.priority);
  });

  it('plays one cut per kind per cooldownS of sim time; a suppressed moment still marks', () => {
    const { kc, cine } = rig();
    const ape = fighter({ at: [2, 0, 0] });
    const marked: Moment[] = [];
    kc.onMark = (m) => marked.push(m);
    const first = moment('envKill', ape);
    expect(kc.onMoment(first)).toBe(true);
    expect(cine.active).toBe(true);
    cine.update(10);
    expect(cine.active).toBe(false);
    // Within the cooldown (counted in ticks of sim time, so slow motion stretches it): marked, no cut.
    const soon = moment('envKill', ape, { tick: T0 + COOLDOWN_TICKS() - 1 });
    expect(kc.onMoment(soon)).toBe(false);
    expect(cine.active).toBe(false);
    expect(kc.marks).toEqual([soon]);
    expect(marked).toEqual([soon]);
    // Another kind isn't held back by envKill's cooldown.
    const giant = fighter({ scale: 5.5, at: [0, 0, 20], ruler: true });
    expect(kc.onMoment(moment('worldWound', giant, { tick: T0 + 10 }))).toBe(true);
    cine.update(10);
    // Once the cooldown has run, envKill cuts again.
    expect(kc.onMoment(moment('envKill', ape, { tick: T0 + COOLDOWN_TICKS() + 1 }))).toBe(true);
    expect(kc.marks).toEqual([soon]);
  });

  it('a moment a bigger cut keeps off the screen is marked, and starts no cooldown', () => {
    const { kc, cine, shots } = rig();
    const ape = fighter({ at: [2, 0, 0] });
    const giant = fighter({ scale: 5.5, at: [0, 0, 20], ruler: true });
    expect(kc.onMoment(moment('rulerDeath', giant))).toBe(true);
    const kept = moment('envKill', ape, { tick: T0 + 30 });
    expect(kc.onMoment(kept)).toBe(false);
    expect(kc.marks).toEqual([kept]);
    expect(shots.at(-1)!.priority).toBe(4);
    cine.update(10);
    // It never cut, so its kind isn't cooling down.
    expect(kc.onMoment(moment('envKill', ape, { tick: T0 + 60 }))).toBe(true);
  });

  it('a cut replaced in its own tick by a bigger moment was never seen: it is marked and its cooldown cleared', () => {
    const { kc, cine } = rig();
    const ape = fighter({ at: [2, 0, 0] });
    const giant = fighter({ scale: 5.5, at: [0, 0, 20], ruler: true });
    const env = moment('envKill', ape);
    expect(kc.onMoment(env)).toBe(true);
    expect(kc.onMoment(moment('worldWound', giant))).toBe(true);
    expect(kc.marks).toEqual([env]);
    cine.update(10);
    expect(kc.onMoment(moment('envKill', ape, { tick: T0 + 20 }))).toBe(true);
    // Replaced a tick later, it was on screen: no mark.
    expect(kc.onMoment(moment('rulerDeath', giant, { tick: T0 + 21 }))).toBe(true);
    expect(kc.marks).toEqual([env]);
  });

  it('frames a followed body no lower than the ground + focusFloor × scale', () => {
    const ape = fighter({ at: [2, 0, 0] });
    const { kc } = rig({ ground: 0.5, pelvisY: -3 });
    expect(kc.shotFor(moment('envKill', ape)).focus().y).toBeCloseTo(0.5 + 0.35, 12);
    const giant = fighter({ scale: 5.5, at: [0, -20, 20], ruler: true });
    expect(kc.shotFor(moment('rulerDeath', giant)).focus().y).toBeCloseTo(0.5 + 0.35 * 5.5, 12);
    // A body above the floor is framed where it is.
    const { kc: high } = rig({ ground: 0.5, pelvisY: 2 });
    expect(high.shotFor(moment('playerDeath', fighter({ player: true }))).focus().y).toBe(2);
  });

  it('keeps left and right where the player sees them: the side is on the view position’s side of the line', () => {
    const ape = fighter({ at: [0, 0, 0] });
    // The blow came along +x; the line from the cause to the victim runs along x.
    const m = moment('envKill', ape, { point: new Vector3(0, 1, 0), dir: new Vector3(1, 0, 0) });
    const front = rig({ view: new Vector3(0, 3, 10) }).kc.shotFor(m).side;
    const back = rig({ view: new Vector3(0, 3, -10) }).kc.shotFor(m).side;
    expect(front.z).toBeGreaterThan(0.9);
    expect(back.z).toBeLessThan(-0.9);
    // Over the cause's shoulder by envKill's toward (0.1): a little back along the blow.
    expect(front.x).toBeLessThan(0);
    expect(front.toArray()).toEqual(sideAcross(new Vector3(0, 3, 10), new Vector3(-1, 1, 0), ape.pos, KILLCAM_TUNING.envKill.toward).toArray());
    // Without a view position, P31's `across` (deprecated) still decides it.
    const across = vi.fn((_a: Vector3, _b: Vector3, _t?: number) => new Vector3(0, 0, 1));
    const old = rig({ views: { viewPos: undefined, across } });
    expect(old.kc.shotFor(m).side.toArray()).toEqual([0, 0, 1]);
    expect(across).toHaveBeenCalledWith(new Vector3(-1, 1, 0), ape.pos, KILLCAM_TUNING.envKill.toward);
  });

  it("films a ruler's fling from the side of the flight (⟂ the launch), following the body", () => {
    const me = fighter({ player: true, at: [5, 0, 5] });
    const { kc } = rig({ view: new Vector3(5, 3, -20) });
    const s = kc.shotFor(moment('playerByRuler', me, { dir: new Vector3(0.6, 0.64, 0.48).normalize() }));
    const flight = new Vector3(0.6, 0, 0.48).normalize();
    expect(Math.abs(s.side.dot(flight))).toBeLessThan(1e-9);
    expect(s.side.length()).toBeCloseTo(1, 12);
    // On the viewer's side.
    expect(s.side.dot(new Vector3(0, 0, -25))).toBeGreaterThan(0);
  });

  it("holds the wound in the shot as the ruler's body moves, seen from outside the body", () => {
    const giant = fighter({ scale: 5.5, at: [0, 0, 20], ruler: true });
    const { kc } = rig();
    // A wound on the front of the chest (the body faces +z here).
    const at = giant.rig.chest.pos.clone().add(new Vector3(0, 0, 1.2));
    const s = kc.shotFor(moment('worldWound', giant, { point: at, dir: new Vector3(0, 0, -1) }));
    expect(s.focus().distanceTo(at)).toBeLessThan(1e-9);
    expect(s.side.toArray()).toEqual([0, 0, 1]);
    // The giant topples forward and sideways: the focus stays on the same spot of its chest.
    giant.rig.chest.pos.add(new Vector3(2, -3, 1));
    expect(s.focus().distanceTo(at.clone().add(new Vector3(2, -3, 1)))).toBeLessThan(1e-9);
  });

  it('nothing but KillCam.onMoment starts a kill cam (RR-14): cine.play( appears only in killcam.ts', () => {
    const files = Object.keys(SOURCES);
    expect(files).toContain('../src/game/killcam.ts');
    // (src only: the tests drive Cinematics themselves.)
    const offenders = files.filter((f) => f !== '../src/game/killcam.ts' && /\bcine\.play\(/.test(code(SOURCES[f])));
    expect(offenders).toEqual([]);
    // No shot is played anywhere else: the Cinematics adapter forwards, main.ts's one call is KillCam's cut callback,
    // and game.ts plays none: every moment of a step goes to onMoment.
    const players = files.filter((f) => /\.play\(\s*\w+\s*\)/.test(code(SOURCES[f])) && !/battleLog|feel\//.test(f));
    expect(players.sort()).toEqual(['../src/main.ts', '../src/render/cameraDirector.ts']);
    const main = code(SOURCES['../src/main.ts']);
    expect(main.match(/\.play\(/g)).toHaveLength(1);
    expect(main).toMatch(/new KillCam\(\s*\(?(\w+)\)?\s*=>\s*\w+\.play\(\1\)/);
    const game = code(SOURCES['../src/game/game.ts']);
    expect(game).not.toMatch(/\.play\(/);
    expect(game).toMatch(/for \(const m of this\.moments\.fromStep\(r\)\) this\.killCam\.onMoment\(m\);/);
  });
});
