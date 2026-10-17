// The throw arc (docs/M1-DESIGN.md §10.7, §5.11): VERB_UI_TUNING.arcPoints points of the sim's own throw — it leaves
// the hand along the aim at v = throwLaunchSpeed(m, charge) (launchSpeed(m, techSpeed) × the charge's fraction, the
// sim's formula) and falls at the world's gravity — until it meets the terrain, and a ring where it lands. The arc is
// a guide: the sim decides where the throw goes (the aim is a direction, never a target).
//
// Presentation only (rule 6).
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Scene,
  Vector3,
} from 'three';
import { type World, WORLD_TUNING } from '@wild/sim';
import { VERB_UI_TUNING } from '../input/verbInput';

/** The arc's and the landing ring's colour (presentation, not tuning). */
const ARC_COLOUR = 0xfff1c4;
/** s: the landing search's step (then bisected): a numerical device, not a starting value. */
const SEARCH_STEP_S = 1 / 120;
/** The landing ring: its inner radius as a fraction of VERB_UI_TUNING.landingRingM, and its lift off the ground (m). */
const RING = { innerFrac: 0.75, lift: 0.03 } as const;

/**
 * The flight from `from` at velocity `vel` under gravity `g` (m/s², down) until it meets `ground` or `maxS` runs out,
 * as `n` points evenly spaced in time (the first at `from`, the last where it lands).
 */
export function arcPoints(from: Vector3, vel: Vector3, g: number, ground: (x: number, z: number) => number, n: number, maxS: number): { points: Vector3[]; landed: boolean; t: number } {
  const at = (t: number, out: Vector3) => out.set(from.x + vel.x * t, from.y + vel.y * t - 0.5 * g * t * t, from.z + vel.z * t);
  const p = new Vector3();
  const above = (t: number) => at(t, p).y - ground(p.x, p.z);
  let tEnd = maxS;
  let landed = false;
  let lo = 0;
  for (let t = SEARCH_STEP_S; t <= maxS + 1e-9; t += SEARCH_STEP_S) {
    if (above(t) <= 0) {
      let hi = t;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (above(mid) > 0) lo = mid;
        else hi = mid;
      }
      tEnd = hi;
      landed = true;
      break;
    }
    lo = t;
  }
  const count = Math.max(2, Math.round(n));
  const points: Vector3[] = [];
  for (let i = 0; i < count; i++) points.push(at((tEnd * i) / (count - 1), new Vector3()));
  return { points, landed, t: tEnd };
}

export class AimArc {
  private readonly group = new Group();
  private readonly line: Line;
  private readonly ring: Mesh;
  private positions = new Float32Array(0);
  /** The last arc shown (tests and the dev panel read it). */
  last: { points: Vector3[]; landed: boolean; t: number } | null = null;

  constructor(private readonly scene: Scene) {
    this.line = new Line(new BufferGeometry(), new LineBasicMaterial({ color: ARC_COLOUR, transparent: true, opacity: 0.85, depthWrite: false }));
    this.line.frustumCulled = false;
    this.ring = new Mesh(new RingGeometry(RING.innerFrac, 1, 28), new MeshBasicMaterial({ color: ARC_COLOUR, side: DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.line, this.ring);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Is the arc shown? */
  get visible(): boolean {
    return this.group.visible;
  }

  /** Draws the arc from `from` along `dir` at `speed` m/s (null hides it). */
  show(world: World, from: Vector3 | null, dir: Vector3 | null, speed: number): void {
    if (!from || !dir) {
      this.group.visible = false;
      this.last = null;
      return;
    }
    const vel = dir.clone().normalize().multiplyScalar(speed);
    const arc = arcPoints(from, vel, -WORLD_TUNING.gravityY, (x, z) => world.terrain.heightAt(x, z), VERB_UI_TUNING.arcPoints, VERB_UI_TUNING.arcMaxS);
    this.last = arc;
    const n = arc.points.length;
    if (this.positions.length !== n * 3) {
      this.positions = new Float32Array(n * 3);
      this.line.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    }
    arc.points.forEach((q, i) => this.positions.set([q.x, q.y, q.z], i * 3));
    (this.line.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.line.geometry.setDrawRange(0, n);
    const end = arc.points[n - 1];
    this.ring.visible = arc.landed;
    this.ring.scale.setScalar(VERB_UI_TUNING.landingRingM);
    this.ring.position.set(end.x, end.y + RING.lift, end.z);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.line.geometry.dispose();
    (this.line.material as LineBasicMaterial).dispose();
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicMaterial).dispose();
  }
}
