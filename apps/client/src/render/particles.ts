import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RingGeometry,
  Scene,
  TetrahedronGeometry,
  Vector3,
} from 'three';

/**
 * What blood, gibs and particles land on (docs/M1-DESIGN.md §10.11: `ground(x, z)` floors, stains on the terrain
 * normal). The presentation world hands them the sim's terrain, read-only; DS's arena floor was y = 0.
 */
export interface Ground {
  /** Height of the ground at (x, z) (m). */
  height(x: number, z: number): number;
  /** The ground's unit up-normal at (x, z), into `out`. */
  normal(x: number, z: number, out: Vector3): Vector3;
}

/** DS's floor: flat at y = 0 (tests, and until a world is known). */
export const FLAT_GROUND: Ground = Object.freeze({
  height: () => 0,
  normal: (_x: number, _z: number, out: Vector3) => out.set(0, 1, 0),
});

interface P {
  pos: Vector3;
  vel: Vector3;
  life: number;
  max: number;
  size: number;
  gravity: number;
  drag: number;
  color: Color;
}

interface Flash {
  mesh: Mesh;
  t: number;
  dur: number;
  size: number;
}

interface Ring {
  mesh: Mesh;
  t: number;
  dur: number;
  size: number;
  follow?: () => Vector3 | null;
}

const MAX = 400;
const _o = new Object3D();
const _n = new Vector3();
const _z = new Vector3(0, 0, 1);
/** A ring floats this far over the ground (DS: 0.02 m over y = 0), along its normal. */
const RING_LIFT = 0.02;
/** A particle bounces this far over the ground (DS: 0.01 m). */
const PARTICLE_FLOOR = 0.01;

/** Hit sparks, dust puffs, impact flashes and ground rings, on the ground they are given (`ground`, settable). */
export class Effects {
  /** What sparks and dust bounce off and rings lie on. */
  ground: Ground;
  private readonly mesh: InstancedMesh;
  private readonly ps: P[] = [];
  private readonly flashes: Flash[] = [];
  private readonly rings: Ring[] = [];
  private readonly flashGeo = new IcosahedronGeometry(1, 0);
  private readonly ringGeo = new RingGeometry(0.85, 1, 32);

  constructor(
    private readonly scene: Scene,
    ground: Ground = FLAT_GROUND,
  ) {
    this.ground = ground;
    this.mesh = new InstancedMesh(new TetrahedronGeometry(1), new MeshBasicMaterial({ toneMapped: false }), MAX);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  sparks(at: Vector3, dir: Vector3, count: number, color: Color | string, speed = 5, size = 0.035) {
    const c = new Color(color);
    for (let i = 0; i < count && this.ps.length < MAX; i++) {
      const v = new Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      v.addScaledVector(dir, 1.4).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      const max = 0.18 + Math.random() * 0.25;
      this.ps.push({ pos: at.clone(), vel: v, life: max, max, size: size * (0.6 + Math.random()), gravity: 9, drag: 2.5, color: c });
    }
  }

  dust(at: Vector3, count: number, spread = 0.3) {
    const c = new Color('#8d8273');
    for (let i = 0; i < count && this.ps.length < MAX; i++) {
      const v = new Vector3((Math.random() - 0.5) * 1.6, Math.random() * 0.8 + 0.2, (Math.random() - 0.5) * 1.6);
      const p = at.clone().add(new Vector3((Math.random() - 0.5) * spread, 0.03, (Math.random() - 0.5) * spread));
      const max = 0.4 + Math.random() * 0.4;
      this.ps.push({ pos: p, vel: v, life: max, max, size: 0.05 + Math.random() * 0.05, gravity: -0.6, drag: 3.5, color: c });
    }
  }

  flash(at: Vector3, size: number, color: Color | string = '#fff6d8', dur = 0.11) {
    const mesh = new Mesh(
      this.flashGeo,
      new MeshBasicMaterial({ color, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    mesh.position.copy(at);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.scene.add(mesh);
    this.flashes.push({ mesh, t: 0, dur, size });
  }

  ring(at: Vector3, size: number, color: Color | string, dur = 0.35, follow?: () => Vector3 | null) {
    const mesh = new Mesh(
      this.ringGeo,
      new MeshBasicMaterial({ color, transparent: true, depthWrite: false, toneMapped: false, blending: AdditiveBlending }),
    );
    this.placeRing(mesh, at.x, at.z);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, dur, size, follow });
  }

  /** How many sparks and dust puffs are flying. */
  get particleCount(): number {
    return this.ps.length;
  }

  /** A ring lies on the ground at (x, z), turned to its normal. */
  private placeRing(mesh: Mesh, x: number, z: number): void {
    const n = this.ground.normal(x, z, _n);
    mesh.quaternion.setFromUnitVectors(_z, n);
    mesh.position.set(x, this.ground.height(x, z), z).addScaledVector(n, RING_LIFT);
  }

  /** `simDt` freezes with hit-pause; `realDt` keeps impact flashes alive during it. */
  update(simDt: number, realDt: number) {
    let n = 0;
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      p.life -= simDt;
      if (p.life <= 0) {
        this.ps.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * simDt;
      p.vel.multiplyScalar(Math.exp(-p.drag * simDt));
      p.pos.addScaledVector(p.vel, simDt);
      const floor = this.ground.height(p.pos.x, p.pos.z) + PARTICLE_FLOOR;
      if (p.pos.y < floor) {
        p.pos.y = floor;
        p.vel.y *= -0.3;
      }
    }
    for (const p of this.ps) {
      const k = p.life / p.max;
      _o.position.copy(p.pos);
      _o.scale.setScalar(p.size * (0.3 + 0.7 * k));
      _o.rotation.set(p.life * 20, p.life * 13, 0);
      _o.updateMatrix();
      this.mesh.setMatrixAt(n, _o.matrix);
      this.mesh.setColorAt(n, p.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += realDt;
      const u = f.t / f.dur;
      if (u >= 1) {
        this.scene.remove(f.mesh);
        (f.mesh.material as MeshBasicMaterial).dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      f.mesh.scale.setScalar(f.size * (0.4 + 0.9 * Math.sqrt(u)));
      (f.mesh.material as MeshBasicMaterial).opacity = 1 - u * u;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += realDt;
      const u = r.t / r.dur;
      if (u >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as MeshBasicMaterial).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const at = r.follow?.();
      if (at) this.placeRing(r.mesh, at.x, at.z);
      r.mesh.scale.setScalar(r.size * (0.5 + 0.6 * u));
      (r.mesh.material as MeshBasicMaterial).opacity = (1 - u) * 0.9;
    }
  }
}
