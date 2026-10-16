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

/** Hit sparks, dust puffs, impact flashes and ground rings. */
export class Effects {
  private readonly mesh: InstancedMesh;
  private readonly ps: P[] = [];
  private readonly flashes: Flash[] = [];
  private readonly rings: Ring[] = [];
  private readonly flashGeo = new IcosahedronGeometry(1, 0);
  private readonly ringGeo = new RingGeometry(0.85, 1, 32);

  constructor(private readonly scene: Scene) {
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
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, 0.02, at.z);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, dur, size, follow });
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
      if (p.pos.y < 0.01) {
        p.pos.y = 0.01;
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
      if (at) r.mesh.position.set(at.x, 0.02, at.z);
      r.mesh.scale.setScalar(r.size * (0.5 + 0.6 * u));
      (r.mesh.material as MeshBasicMaterial).opacity = (1 - u) * 0.9;
    }
  }
}
