import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Cinematics, type Shot } from '../src/render/cinematics';

const shot = (priority: number, extra: Partial<Shot> = {}): Shot => ({
  focus: () => new Vector3(0, 1, 0),
  side: new Vector3(1, 0, 0),
  distance: 3,
  height: 0.5,
  duration: 2,
  slow: 0.2,
  priority,
  ...extra,
});

describe('camera cuts', () => {
  it('a bigger moment takes over; a smaller one waits its turn', () => {
    const c = new Cinematics();
    const ended: number[] = [];
    expect(c.play(shot(3, { onEnd: () => ended.push(3) }))).toBe(true);
    expect(c.play(shot(1))).toBe(false);
    expect(c.play(shot(5))).toBe(true);
    expect(ended).toEqual([3]);
  });

  it('runs slow, eases back to full speed, then hands the camera back', () => {
    const c = new Cinematics();
    let on = false;
    c.onChange = (v) => (on = v);
    c.play(shot(4));
    expect(on).toBe(true);
    expect(c.timeScale).toBeCloseTo(0.2);
    for (let i = 0; i < 100; i++) c.update(0.0175);
    expect(c.timeScale).toBeGreaterThan(0.3);
    for (let i = 0; i < 30; i++) c.update(0.0175);
    expect(c.active).toBe(false);
    expect(on).toBe(false);
    expect(c.timeScale).toBe(1);
  });

  it('frames the subject from the requested side and height, and never dips below the floor', () => {
    const c = new Cinematics();
    c.play(shot(2, { height: -5 }));
    const p = c.camera.position;
    expect(p.x).toBeGreaterThan(2.5);
    expect(p.y).toBeGreaterThanOrEqual(0.15);
  });

  it('minor punch-ins do not fire back to back', () => {
    const c = new Cinematics();
    c.play(shot(1, { duration: 0.2 }));
    for (let i = 0; i < 20; i++) c.update(0.02);
    expect(c.active).toBe(false);
    expect(c.play(shot(1))).toBe(false);
    expect(c.play(shot(3))).toBe(true);
  });
});
