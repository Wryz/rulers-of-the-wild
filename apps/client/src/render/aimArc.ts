// The throw arc (docs/M1-DESIGN.md §10.7, §5.11): VERB_UI_TUNING.arcPoints points of the sim's own throw — it leaves
// the hand at the velocity the sim's planThrow gives (along the aim at launchSpeed(m, techSpeed) × the charge's
// fraction, plus the walk for a Rapier-body throw: input/verbInput.ts works it out) and falls at the world's gravity —
// until it meets the terrain or something in the way (a log, a rock, a creature), and a ring where it lands. The arc
// is a guide: the sim decides where the throw goes (the aim is a direction, never a target).
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
/** The landing ring's segments round (a mesh resolution, not a starting value). */
const RING_SEGMENTS = 28;
/** s: the landing search's step (then bisected): a numerical device, not a starting value. */
const SEARCH_STEP_S = 1 / 120;
/**
 * s: the chords along which the flight is cast against what stands in the way: a numerical device (a chord is cast
 * whole, so nothing is skipped; it sags off the true curve by only g·dt²/8, 1.4 mm), not a starting value.
 */
const CHORD_S = 1 / 30;

/** A computed flight: its points, whether (and on what) it ends before maxS, and its time (s). */
export interface ArcFlight {
  points: Vector3[];
  /** It comes down (on the terrain, or on something in the way): the landing ring is drawn. */
  landed: boolean;
  /** It ends on something in the way (block), not on the terrain. */
  struck: boolean;
  t: number;
}

/**
 * The flight from `from` at velocity `vel` under gravity `g` (m/s², down) until it meets `ground`, or something in the
 * way (`block(a, b)`: the fraction 0..1 along the segment a → b where it first meets one, or null), or `maxS` runs out,
 * as `n` points evenly spaced in time (the first at `from`, the last where it ends).
 */
export function arcPoints(
  from: Vector3,
  vel: Vector3,
  g: number,
  ground: (x: number, z: number) => number,
  n: number,
  maxS: number,
  block: ((a: Vector3, b: Vector3) => number | null) | null = null,
): ArcFlight {
  const at = (t: number, out: Vector3) => out.set(from.x + vel.x * t, from.y + vel.y * t - 0.5 * g * t * t, from.z + vel.z * t);
  const p = new Vector3();
  const above = (t: number) => at(t, p).y - ground(p.x, p.z);
  let tEnd = maxS;
  let landed = false;
  let struck = false;
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
  if (block) {
    // Chord by chord up to where it lands: the first thing in the way ends it there.
    const a = new Vector3();
    const b = new Vector3();
    for (let t0 = 0; t0 < tEnd - 1e-9; t0 += CHORD_S) {
      const t1 = Math.min(tEnd, t0 + CHORD_S);
      const k = block(at(t0, a), at(t1, b));
      if (k !== null) {
        tEnd = t0 + (t1 - t0) * Math.max(0, Math.min(1, k));
        landed = true;
        struck = true;
        break;
      }
    }
  }
  const count = Math.max(2, Math.round(n));
  const points: Vector3[] = [];
  for (let i = 0; i < count; i++) points.push(at((tEnd * i) / (count - 1), new Vector3()));
  return { points, landed, struck, t: tEnd };
}

export class AimArc {
  private readonly group = new Group();
  private readonly line: Line;
  private readonly ring: Mesh;
  private positions = new Float32Array(0);
  private readonly lineMat: LineBasicMaterial;
  private readonly ringMat: MeshBasicMaterial;
  /** The inner fraction the landing ring's geometry was built with (rebuilt when the tuning changes it). */
  private ringInner: number;
  /** The last arc shown (tests and the dev panel read it). */
  last: ArcFlight | null = null;

  constructor(private readonly scene: Scene) {
    const T = VERB_UI_TUNING;
    this.lineMat = new LineBasicMaterial({ color: ARC_COLOUR, transparent: true, opacity: T.arcOpacity, depthWrite: false });
    this.line = new Line(new BufferGeometry(), this.lineMat);
    this.line.frustumCulled = false;
    this.ringMat = new MeshBasicMaterial({ color: ARC_COLOUR, side: DoubleSide, transparent: true, opacity: T.landingRingOpacity, depthWrite: false });
    this.ringInner = T.ringInnerFrac;
    this.ring = new Mesh(new RingGeometry(this.ringInner, 1, RING_SEGMENTS), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.line, this.ring);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Is the arc shown? */
  get visible(): boolean {
    return this.group.visible;
  }

  /**
   * Draws the flight from `from` at velocity `vel` (m/s; null hides it), ending on the terrain or on the first entity
   * or creature in the way, `exclude`d ones aside (what is thrown, and the thrower).
   */
  show(world: World, from: Vector3 | null, vel: Vector3 | null, exclude: { entities?: number[]; fighters?: number[] } = {}): void {
    if (!from || !vel) {
      this.group.visible = false;
      this.last = null;
      return;
    }
    const T = VERB_UI_TUNING;
    const d = new Vector3();
    const block = (a: Vector3, b: Vector3): number | null => {
      const l = d.copy(b).sub(a).length();
      if (!(l > 1e-9)) return null;
      const hit = world.queries.castRay(a, d, l, { terrain: false, entities: 'all', fighters: 'zones', exclude });
      return hit ? hit.toi / l : null;
    };
    const arc = arcPoints(from, vel, -WORLD_TUNING.gravityY, (x, z) => world.terrain.heightAt(x, z), T.arcPoints, T.arcMaxS, block);
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
    this.lineMat.opacity = T.arcOpacity;
    this.ringMat.opacity = T.landingRingOpacity;
    if (this.ringInner !== T.ringInnerFrac) {
      this.ring.geometry.dispose();
      this.ringInner = T.ringInnerFrac;
      this.ring.geometry = new RingGeometry(this.ringInner, 1, RING_SEGMENTS);
    }
    this.ring.visible = arc.landed;
    this.ring.scale.setScalar(T.landingRingM);
    this.ring.position.set(end.x, end.y + T.landingRingLiftM, end.z);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.line.geometry.dispose();
    this.lineMat.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
  }
}
