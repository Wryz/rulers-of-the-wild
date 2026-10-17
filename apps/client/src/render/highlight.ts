// The target highlight (docs/M1-DESIGN.md §10.7): an emissive back-face shell (VERB_UI_TUNING.highlightScale) on the
// target the sim has focused (input/verbInput.ts passes the sim's focus, never a client guess: what is outlined is what
// a verb acts on), a second colour for the first target of a two-target verb, a ring on the ground for a ground
// target, and a world-anchored prompt ("G take · V verbs", "G drag (120 kg)", "too heavy (300 kg)", "G take the end").
//
// Presentation only (rule 6): it reads records (poses, shapes, rope anchors) and writes nothing in the world.
import {
  BackSide,
  type BufferGeometry,
  type Camera,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  type Scene,
  Vector3,
} from 'three';
import type { Shape as SimShape, World } from '@wild/sim';
import type { TargetRef } from '../input/verbInput';
import { VERB_UI_TUNING } from '../input/verbInput';
import { shapeBox } from '../input/targeting';
import { shapeGeometry } from './entityViews';

/** The focused target's shell, the first target's (lash, bend) and the prompt's colours (presentation, not tuning). */
const FOCUS_COLOUR = 0xffd27a;
const FIRST_COLOUR = 0x7fd4ff;
/** Mesh resolutions (not starting values): the ground ring's segments round, a rope segment's sides. */
const RING_SEGMENTS = 28;
const ROPE_SIDES = 6;

/** A shell's geometry: the shape's own surface, centred on its bounding box so it scales about its middle. */
interface ShellGeo {
  geo: BufferGeometry;
  centre: Vector3;
}

const _p = new Vector3();
const _c = new Vector3();
const _q = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _d = new Vector3();

/** One coloured outline: shells for an entity's shape, segments for a rope, a ring for the ground. */
class Outline {
  readonly group = new Group();
  private readonly mat: MeshBasicMaterial;
  private readonly flatMat: MeshBasicMaterial;
  private readonly shell: Mesh;
  private readonly ring: Mesh;
  private readonly segs: Mesh[] = [];
  private readonly segGeo = new CylinderGeometry(1, 1, 1, ROPE_SIDES, 1, true);
  /** The inner fraction the ring's geometry was built with (rebuilt when the tuning changes it). */
  private ringInner: number;

  constructor(colour: number, private readonly geoOf: (s: SimShape) => ShellGeo) {
    const T = VERB_UI_TUNING;
    this.mat = new MeshBasicMaterial({ color: colour, side: BackSide, transparent: true, opacity: T.shellOpacity, depthWrite: false });
    this.flatMat = new MeshBasicMaterial({ color: colour, side: DoubleSide, transparent: true, opacity: T.markOpacity, depthWrite: false });
    this.shell = new Mesh(undefined, this.mat);
    this.ringInner = T.ringInnerFrac;
    this.ring = new Mesh(new RingGeometry(this.ringInner, 1, RING_SEGMENTS), this.flatMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.shell, this.ring);
    this.group.visible = false;
  }

  /** Outlines `t` (null hides); returns the point the prompt hangs over. */
  show(world: World, t: TargetRef | null): Vector3 | null {
    this.shell.visible = false;
    this.ring.visible = false;
    for (const s of this.segs) s.visible = false;
    this.group.visible = t !== null;
    if (!t) return null;
    const T = VERB_UI_TUNING;
    this.mat.opacity = T.shellOpacity;
    this.flatMat.opacity = T.markOpacity;
    if (t.kind === 'ground') {
      if (this.ringInner !== T.ringInnerFrac) {
        (this.ring.geometry as BufferGeometry).dispose();
        this.ringInner = T.ringInnerFrac;
        this.ring.geometry = new RingGeometry(this.ringInner, 1, RING_SEGMENTS);
      }
      this.ring.visible = true;
      this.ring.scale.setScalar(T.groundRingM);
      this.ring.position.set(t.at.x, world.terrain.heightAt(t.at.x, t.at.z) + T.groundRingLiftM, t.at.z);
      return this.ring.position.clone();
    }
    const e = world.entities.get(t.id);
    if (!e) {
      this.group.visible = false;
      return null;
    }
    if (e.state === 'tied') return this.rope(world, t.id);
    const g = this.geoOf(e.shape);
    const s = VERB_UI_TUNING.highlightScale;
    _q.set(e.pose.q.x, e.pose.q.y, e.pose.q.z, e.pose.q.w);
    _c.copy(g.centre).applyQuaternion(_q);
    this.shell.geometry = g.geo;
    this.shell.position.set(e.pose.p.x + _c.x, e.pose.p.y + _c.y, e.pose.p.z + _c.z);
    this.shell.quaternion.copy(_q);
    this.shell.scale.setScalar(s);
    this.shell.visible = true;
    // The prompt hangs over the top of what is outlined.
    if (!g.geo.boundingSphere) g.geo.computeBoundingSphere();
    const r = g.geo.boundingSphere?.radius ?? 0;
    return new Vector3(this.shell.position.x, this.shell.position.y + r * s, this.shell.position.z);
  }

  /** A tied rope: every segment of its joints between their anchors. */
  private rope(world: World, rope: number): Vector3 | null {
    let top: Vector3 | null = null;
    let i = 0;
    for (const v of world.joints.view()) {
      if (world.joints.get(v.joint)?.rope?.entity !== rope) continue;
      let m = this.segs[i];
      if (!m) {
        m = new Mesh(this.segGeo, this.flatMat);
        this.segs.push(m);
        this.group.add(m);
      }
      i++;
      _p.set(v.a.x, v.a.y, v.a.z);
      _d.set(v.b.x - v.a.x, v.b.y - v.a.y, v.b.z - v.a.z);
      const len = _d.length();
      if (!(len > 1e-6)) continue;
      m.position.copy(_p).addScaledVector(_d, 0.5);
      m.quaternion.setFromUnitVectors(_up, _d.divideScalar(len));
      const rr = VERB_UI_TUNING.ropeShellRadiusM;
      m.scale.set(rr, len, rr);
      m.visible = true;
      const hi = v.a.y > v.b.y ? v.a : v.b;
      if (!top || hi.y > top.y) top = new Vector3(hi.x, hi.y, hi.z);
    }
    return top;
  }

  dispose(): void {
    this.mat.dispose();
    this.flatMat.dispose();
    this.segGeo.dispose();
    (this.ring.geometry as BufferGeometry).dispose();
  }
}

export class Highlight {
  private readonly root = new Group();
  /**
   * The shells' geometries, by shape: only those outlined in the last show() are kept (a focus change builds the new
   * one), so pieces broken off and shapes that no longer exist never pile up on the GPU.
   */
  private readonly geos = new Map<SimShape, ShellGeo>();
  private readonly used = new Set<SimShape>();
  private readonly focus: Outline;
  private readonly firstOutline: Outline;
  private readonly prompt: HTMLDivElement | null = null;

  constructor(
    private readonly scene: Scene,
    /** Where the prompt is drawn (the HUD root); none: no prompt (tests). */
    hudRoot: HTMLElement | null = null,
  ) {
    const geoOf = (s: SimShape) => this.geometry(s);
    this.focus = new Outline(FOCUS_COLOUR, geoOf);
    this.firstOutline = new Outline(FIRST_COLOUR, geoOf);
    this.root.add(this.focus.group, this.firstOutline.group);
    this.root.renderOrder = 2;
    scene.add(this.root);
    if (hudRoot && typeof document !== 'undefined') {
      const p = document.createElement('div');
      p.className = 'rotw-prompt';
      Object.assign(p.style, {
        position: 'absolute',
        transform: 'translate(-50%, -100%)',
        padding: '3px 8px',
        borderRadius: '6px',
        background: 'rgba(16,20,18,0.72)',
        color: '#f3efe2',
        font: '600 13px/1.25 system-ui, sans-serif',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        display: 'none',
        zIndex: '20',
      } satisfies Partial<CSSStyleDeclaration>);
      hudRoot.appendChild(p);
      this.prompt = p;
    }
  }

  /** Is anything outlined? */
  get visible(): boolean {
    return this.focus.group.visible || this.firstOutline.group.visible;
  }

  /**
   * Outlines `target` (and `first`, the first target of a two-target verb); null clears. `prompt` is drawn over
   * `prompt.at`, or over the target when `at` is null.
   */
  show(world: World, target: TargetRef | null, first: TargetRef | null, camera: Camera, prompt: { text: string; at: Vector3 | null } | null = null): void {
    this.used.clear();
    const over = this.focus.show(world, target);
    // (The first target is drawn in its own colour; when it is also the focus the focus colour wins.)
    this.firstOutline.show(world, first && !(target && sameTarget(first, target)) ? first : null);
    this.sweep();
    const p = this.prompt;
    if (!p) return;
    const at = prompt ? (prompt.at ?? over) : null;
    if (!prompt || !at) {
      p.style.display = 'none';
      return;
    }
    _p.copy(at);
    if (!prompt.at) _p.y += VERB_UI_TUNING.promptLiftM;
    _p.project(camera);
    if (_p.z > 1 || _p.z < -1 || Math.abs(_p.x) > 1.1 || Math.abs(_p.y) > 1.1) {
      p.style.display = 'none';
      return;
    }
    p.textContent = prompt.text;
    p.style.left = `${(_p.x * 0.5 + 0.5) * 100}%`;
    p.style.top = `${(-_p.y * 0.5 + 0.5) * 100}%`;
    p.style.display = 'block';
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.focus.dispose();
    this.firstOutline.dispose();
    this.used.clear();
    this.sweep();
    this.prompt?.remove();
  }

  /** How many shell geometries are held (tests: they don't pile up). */
  get cached(): number {
    return this.geos.size;
  }

  private geometry(s: SimShape): ShellGeo {
    this.used.add(s);
    let g = this.geos.get(s);
    if (!g) {
      const box = shapeBox(s);
      const centre = box.min.clone().add(box.max).multiplyScalar(0.5);
      const geo = shapeGeometry(s);
      geo.translate(-centre.x, -centre.y, -centre.z);
      geo.computeBoundingSphere();
      g = { geo, centre };
      this.geos.set(s, g);
    }
    return g;
  }

  /** Disposes the geometries of shapes not outlined now (a hidden shell may still point at one: it isn't drawn). */
  private sweep(): void {
    for (const [s, g] of this.geos) {
      if (this.used.has(s)) continue;
      g.geo.dispose();
      this.geos.delete(s);
    }
  }
}

/** The same target (an entity by id; the ground by its point to the centimetre). */
export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.kind === 'entity' && b.kind === 'entity') return a.id === b.id;
  if (a.kind === 'ground' && b.kind === 'ground') return a.at.distanceTo(b.at) < 0.01;
  return false;
}
