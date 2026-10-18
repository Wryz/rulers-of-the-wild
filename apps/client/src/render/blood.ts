import {
  BoxGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  type Scene,
  Vector3,
} from 'three';
import { FLAT_GROUND, type Ground } from './particles';

interface Drop {
  pos: Vector3;
  vel: Vector3;
  size: number;
  spin: number;
}

const MAX_DROPS = 500;
const MAX_STAINS = 400;
const _o = new Object3D();
const _up = new Vector3(0, 1, 0);
const _dir = new Vector3();
const _n = new Vector3();
const _spin = new Quaternion();
/** A drop becomes a stain this far over the ground (DS: 0.01 m over y = 0). */
const DROP_FLOOR = 0.01;
/** A stain lies this far off the ground along its normal (DS: 0.006 m), plus up to STAIN_JITTER (no z-fighting). */
const STAIN_LIFT = 0.006;
const STAIN_JITTER = 0.002;

/** Stylised low-poly blood: droplets that arc, fall and leave stains on the ground, lying on its slope. */
export class Blood {
  enabled = true;
  /** What drops fall onto (the terrain in the game; settable). */
  ground: Ground;
  private readonly drops: Drop[] = [];
  private readonly dropMesh: InstancedMesh;
  private readonly stainMesh: InstancedMesh;
  private stainCount = 0;
  private stainNext = 0;

  constructor(scene: Scene, ground: Ground = FLAT_GROUND) {
    this.ground = ground;
    this.dropMesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: 0x8a0d0d, roughness: 0.35, metalness: 0.1, emissive: 0x2a0000, flatShading: true }),
      MAX_DROPS,
    );
    this.dropMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.dropMesh.frustumCulled = false;
    this.dropMesh.count = 0;
    this.stainMesh = new InstancedMesh(
      new CylinderGeometry(1, 1, 0.004, 7),
      new MeshStandardMaterial({ color: 0x5c0707, roughness: 0.3, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 }),
      MAX_STAINS,
    );
    this.stainMesh.frustumCulled = false;
    this.stainMesh.count = 0;
    this.stainMesh.receiveShadow = true;
    scene.add(this.dropMesh, this.stainMesh);
  }

  /** Burst of droplets from `at`, thrown along `dir`. */
  spray(at: Vector3, dir: Vector3, amount: number, speed = 2.5) {
    if (!this.enabled) return;
    const n = Math.round(3 + 10 * Math.min(1, amount));
    for (let i = 0; i < n && this.drops.length < MAX_DROPS; i++) {
      const v = dir
        .clone()
        .normalize()
        .multiplyScalar(speed * (0.5 + Math.random() * 0.8))
        .add(new Vector3((Math.random() - 0.5) * 1.4, 0.4 + Math.random() * 1.3, (Math.random() - 0.5) * 1.4));
      // Already on its way out when the shot freezes: each drop starts a little along its
      // own path, so the spray reads as a spray — a fan of streaks — not a ball.
      const t0 = 0.012 + Math.random() * 0.075;
      const pos = at.clone().addScaledVector(v, t0);
      pos.y -= 4.9 * t0 * t0;
      v.y -= 9.8 * t0;
      this.drops.push({ pos, vel: v, size: 0.015 + Math.random() * 0.025 * (0.6 + amount), spin: Math.random() * 10 });
    }
  }

  /** A single drop (or two) falling from a wound. */
  drip(at: Vector3) {
    if (!this.enabled) return;
    const n = 1 + (Math.random() < 0.3 ? 1 : 0);
    for (let i = 0; i < n && this.drops.length < MAX_DROPS; i++) {
      this.drops.push({
        pos: at.clone(),
        vel: new Vector3((Math.random() - 0.5) * 0.3, -0.2, (Math.random() - 0.5) * 0.3),
        size: 0.012 + Math.random() * 0.012,
        spin: Math.random() * 10,
      });
    }
  }

  clear() {
    this.drops.length = 0;
    this.dropMesh.count = 0;
    this.stainCount = 0;
    this.stainNext = 0;
    this.stainMesh.count = 0;
  }

  /** How many drops are in the air. */
  get dropCount(): number {
    return this.drops.length;
  }

  /** How many stains lie on the ground (the newest MAX_STAINS). */
  get stains(): number {
    return this.stainCount;
  }

  /** The `i`-th stain's placement (tests, read-only): its centre and its up axis (the ground's normal there). */
  stainAt(i: number, centre = new Vector3(), up = new Vector3()): { centre: Vector3; up: Vector3 } {
    this.stainMesh.getMatrixAt(i, _o.matrix);
    _o.matrix.decompose(_o.position, _o.quaternion, _o.scale);
    return { centre: centre.copy(_o.position), up: up.copy(_up).applyQuaternion(_o.quaternion) };
  }

  /** A stain where a drop met the ground: flat on the ground's slope there, turned at random about its normal. */
  private stain(x: number, z: number, size: number) {
    const i = this.stainNext;
    this.stainNext = (this.stainNext + 1) % MAX_STAINS;
    this.stainCount = Math.min(MAX_STAINS, this.stainCount + 1);
    const r = size * (1.5 + Math.random() * 1.6);
    const n = this.ground.normal(x, z, _n);
    _o.position.set(x, this.ground.height(x, z), z).addScaledVector(n, STAIN_LIFT + Math.random() * STAIN_JITTER);
    _o.quaternion.setFromUnitVectors(_up, n).multiply(_spin.setFromAxisAngle(_up, Math.random() * Math.PI));
    _o.scale.set(r * (0.7 + Math.random() * 0.6), 1, r);
    _o.updateMatrix();
    this.stainMesh.setMatrixAt(i, _o.matrix);
    this.stainMesh.count = this.stainCount;
    this.stainMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.vel.y -= 9.8 * dt;
      d.vel.multiplyScalar(Math.exp(-0.6 * dt));
      d.pos.addScaledVector(d.vel, dt);
      if (d.pos.y <= this.ground.height(d.pos.x, d.pos.z) + DROP_FLOOR) {
        this.stain(d.pos.x, d.pos.z, d.size);
        this.drops.splice(i, 1);
      }
    }
    let k = 0;
    for (const d of this.drops) {
      _o.position.copy(d.pos);
      // Stretched along the way it's flying, for a liquid read.
      const speed = d.vel.length();
      if (speed > 0.05) _o.quaternion.setFromUnitVectors(_up, _dir.copy(d.vel).divideScalar(speed));
      else _o.rotation.set(d.spin, d.spin * 0.7, 0);
      _o.scale.set(d.size, d.size * (1 + Math.min(3, speed * 0.45)), d.size);
      _o.updateMatrix();
      this.dropMesh.setMatrixAt(k++, _o.matrix);
    }
    this.dropMesh.count = k;
    this.dropMesh.instanceMatrix.needsUpdate = true;
  }
}
