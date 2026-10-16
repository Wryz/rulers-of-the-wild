import { Vector3 } from 'three';
import type { Fighter } from '../sim/fighter';
import { getPose } from './poses';

/** Weapons whose weight sits in the head: they don't roll round the haft on a whim. */
const HEAVY_HEAD = new Set(['axe', 'fireaxe', 'sledgehammer', 'cleaver', 'club', 'pan']);

/** At rest the edge faces forward and a little down: the head hangs upright. */
const REST = new Vector3(0, -0.4, 1).normalize();

/**
 * Which way a weapon's edge faces, in the fighter's own frame (always square to the
 * haft). A weapon is rigid in the hands, so its roll isn't re-decided every frame:
 * - in a swing the edge stays in the plane of the swing and leads it (an overhead
 *   keeps the head upright, a sweep keeps it level), turning with the haft;
 * - at rest the head hangs upright, edge forward;
 * - in between, the edge is carried along with the haft and can only twist so fast
 *   (slowly for a heavy head, quicker for a light blade).
 */
export class WeaponEdge {
  readonly edge = new Vector3();
  private ready = false;
  private readonly plane = new Vector3();
  private planeFor = -1;
  private hasPlane = false;

  reset() {
    this.ready = false;
    this.planeFor = -1;
  }

  /** @param steps sim steps since the last update. */
  update(f: Fighter, steps = 1): Vector3 {
    const b = _b.copy(f.pose.blade).normalize();
    if (!this.ready) {
      this.edge.copy(REST).addScaledVector(b, -REST.dot(b));
      if (this.edge.lengthSq() < 1e-6) this.edge.set(1, 0, 0).addScaledVector(b, -b.x);
      this.edge.normalize();
      this.ready = true;
      const t0 = this.target(f, b);
      if (t0) this.edge.copy(t0);
      return this.edge;
    }
    // Carried with the haft: whatever roll it had, square to the new haft direction.
    this.edge.addScaledVector(b, -this.edge.dot(b));
    if (this.edge.lengthSq() < 1e-6) this.edge.copy(REST).addScaledVector(b, -REST.dot(b));
    if (this.edge.lengthSq() < 1e-6) this.edge.set(1, 0, 0).addScaledVector(b, -b.x);
    this.edge.normalize();
    const target = this.target(f, b);
    if (!target) return this.edge;
    // Twist toward where it should face, no faster than the wrists can turn that weight.
    const ang = Math.atan2(_c.crossVectors(this.edge, target).dot(b), this.edge.dot(target));
    const rate = (f.weapon && HEAVY_HEAD.has(f.weapon.id) ? 0.09 : 0.22) * steps;
    const turn = Math.max(-rate, Math.min(rate, ang));
    this.edge.applyAxisAngle(b, turn).addScaledVector(b, -this.edge.dot(b)).normalize();
    return this.edge;
  }

  private target(f: Fighter, b: Vector3): Vector3 | null {
    const m = f.move;
    if (f.state === 'attack' && m?.weapon) {
      if (this.planeFor !== f.attackSerial) {
        this.planeFor = f.attackSerial;
        // The plane the swing was authored in: from the wind-up to the moment of contact.
        const ci = m.keys.findIndex((k) => k.at[0] === 'a' && k.at[1] === 0);
        this.hasPlane = false;
        if (ci >= 1) {
          this.plane.crossVectors(getPose(m.keys[ci - 1].pose).blade, getPose(m.keys[ci].pose).blade);
          this.hasPlane = this.plane.lengthSq() > 0.04;
          if (this.hasPlane) this.plane.normalize();
        }
      }
      if (this.hasPlane) {
        // Leading edge: the way the haft is turning about the swing plane's normal.
        _t.crossVectors(this.plane, b);
        if (_t.lengthSq() > 0.05) return _t.normalize();
        return null;
      }
    }
    // At rest the head hangs upright: the edge lies in the vertical plane through the
    // haft (on whichever side it already faces, so it never flips over by itself).
    // With the haft near vertical that plane is undefined: face forward instead.
    _t.set(0, 1, 0).addScaledVector(b, -b.y);
    const upright = _t.lengthSq();
    if (upright > 1e-6) {
      _t.normalize();
      const side = this.edge.dot(_t);
      if (Math.abs(side) > 0.2 ? side < 0 : REST.dot(_t) < 0) _t.negate();
    }
    _r.copy(REST).addScaledVector(b, -REST.dot(b));
    if (_r.lengthSq() > 1e-6) _r.normalize();
    // Blend toward "forward" only as the haft comes up to vertical.
    const w = Math.min(1, upright / 0.25);
    _t.multiplyScalar(w).addScaledVector(_r, 1 - w);
    return _t.lengthSq() > 0.02 ? _t.normalize() : null;
  }
}

const _b = new Vector3();
const _t = new Vector3();
const _c = new Vector3();
const _r = new Vector3();
