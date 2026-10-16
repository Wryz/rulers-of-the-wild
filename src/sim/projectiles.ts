import { Vector3 } from 'three';
import type { Fighter } from './fighter';
import { DT } from './math';
import type { WeaponDef } from './weapons';
import { sampleOffsets } from './weapons';

/** m/s². */
const G = 9.81;

/**
 * A weapon in flight. It's a rigid body: its centre of mass follows a ballistic arc
 * (gravity only — at these speeds and ranges drag doesn't matter) and it turns about
 * that centre at a constant rate. Nothing steers it once it's left the hand.
 */
export interface Projectile {
  id: number;
  /** Threat id for automatic defence (negative, apart from attack serials). */
  serial: number;
  weapon: WeaponDef;
  owner: Fighter;
  /** Thrower's size: the weapon is as big as it was in their hand. */
  scale: number;
  /** Centre of mass (world). */
  pos: Vector3;
  vel: Vector3;
  /** Spin axis (world, unit) and rate (rad/s). 0 = flies point first. */
  axis: Vector3;
  omega: number;
  angle: number;
  /** Direction from the grip to the tip at angle 0. */
  dir0: Vector3;
  /** Where the mass is centred along the weapon, from the grip (m, authored scale). */
  com: number;
  /** Still dangerous: false once it has struck something and is only falling. */
  live: boolean;
  /** Frames since release. */
  age: number;
  /** People it has already gone past (they got out of its way). */
  passed?: Set<Fighter>;
}

/** Where along the weapon its mass sits: by the head of an axe or hammer, mid-way along a stick or blade. */
export function centreOfMass(w: WeaponDef): number {
  return w.choke > 0.3 ? (w.strikeFrom + w.length) / 2 : w.length * 0.45;
}

const _d = new Vector3();

/** The weapon's grip-to-tip direction now (world, unit). */
export function projectileDir(p: Projectile, out = _d): Vector3 {
  if (p.omega === 0) {
    // Point first, like a dart: it lines up with where it's going.
    out.copy(p.vel);
    if (out.lengthSq() < 1e-6) out.copy(p.dir0);
    return out.normalize();
  }
  return out.copy(p.dir0).applyAxisAngle(p.axis, p.angle).normalize();
}

/** Grip (world) of a weapon in flight. */
export function projectileGrip(p: Projectile, out: Vector3): Vector3 {
  const dir = projectileDir(p);
  return out.copy(p.pos).addScaledVector(dir, -p.com * p.scale);
}

/** Points along the weapon (world) and how far along it each one is (m, authored scale). */
export function projectilePoints(p: Projectile): { points: Vector3[]; at: number[] } {
  const at = sampleOffsets(p.weapon);
  const dir = projectileDir(p).clone();
  const grip = projectileGrip(p, new Vector3());
  return { points: at.map((t) => grip.clone().addScaledVector(dir, t * p.scale)), at };
}

/**
 * Velocity of a point on the weapon (world): the centre's velocity plus the spin
 * (ω × r). Whether the edge of an axe meets you depends on where in its turn it is.
 */
export function pointVelocity(p: Projectile, point: Vector3, out: Vector3): Vector3 {
  const r = _r.subVectors(point, p.pos);
  return out.crossVectors(p.axis, r).multiplyScalar(p.omega).add(p.vel);
}
const _r = new Vector3();

/** Advance one sub-step of `dt` seconds: gravity and spin. */
export function integrate(p: Projectile, dt: number) {
  p.vel.y -= G * dt;
  p.pos.addScaledVector(p.vel, dt);
  p.angle += p.omega * dt;
}

/** How many sub-steps a frame needs so a fast weapon can't skip through a body. */
export function substeps(p: Projectile): number {
  const travel = (p.vel.length() + Math.abs(p.omega) * p.weapon.length * p.scale) * DT;
  return Math.max(1, Math.ceil(travel / 0.07));
}

/**
 * Launch velocity to reach `to` from `from` at `speed` m/s on the flatter of the two
 * arcs (how people throw); null if it can't get there at that speed.
 */
export function aimBallistic(from: Vector3, to: Vector3, speed: number): { vel: Vector3; time: number } | null {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const D = Math.hypot(dx, dz);
  const H = to.y - from.y;
  if (D < 1e-3) return null;
  const v2 = speed * speed;
  const disc = v2 * v2 - G * (G * D * D + 2 * H * v2);
  if (disc < 0) return null;
  const theta = Math.atan2(v2 - Math.sqrt(disc), G * D);
  const c = Math.cos(theta);
  const vel = new Vector3((dx / D) * speed * c, speed * Math.sin(theta), (dz / D) * speed * c);
  return { vel, time: D / (speed * c) };
}
