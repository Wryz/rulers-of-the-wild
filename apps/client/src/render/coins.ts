import { CylinderGeometry, DynamicDrawUsage, InstancedMesh, MeshStandardMaterial, Object3D, type Scene, Vector3 } from 'three';

interface Coin {
  pos: Vector3;
  vel: Vector3;
  age: number;
  value: number;
  spin: number;
}

const MAX = 300;
const _o = new Object3D();

/** Coins burst out of a knocked-out enemy, bounce, then home in on the player. */
export class Coins {
  private readonly mesh: InstancedMesh;
  private readonly coins: Coin[] = [];

  constructor(scene: Scene) {
    this.mesh = new InstancedMesh(
      new CylinderGeometry(0.07, 0.07, 0.025, 8),
      new MeshStandardMaterial({ color: 0xf2c14e, emissive: 0x6b4a00, emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.35, flatShading: true }),
      MAX,
    );
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  /** Spawn coins worth `total` (split into up to 12 pieces). */
  burst(at: Vector3, total: number) {
    const n = Math.min(12, Math.max(1, Math.round(total / 2)));
    const each = total / n;
    for (let i = 0; i < n && this.coins.length < MAX; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 2;
      this.coins.push({
        pos: new Vector3(at.x, Math.max(0.4, at.y), at.z),
        vel: new Vector3(Math.cos(a) * sp, 3 + Math.random() * 2.5, Math.sin(a) * sp),
        age: 0,
        value: each,
        spin: Math.random() * 6,
      });
    }
  }

  clear() {
    this.coins.length = 0;
    this.mesh.count = 0;
  }

  /** Advances coins; returns the value collected by the player this frame. */
  update(dt: number, player: Vector3): number {
    let got = 0;
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      c.age += dt;
      const toP = new Vector3(player.x - c.pos.x, 0.9 - c.pos.y, player.z - c.pos.z);
      const d = toP.length();
      if (c.age > 0.55 && (d < 3.5 || c.age > 1.6)) {
        // Magnet: accelerate toward the player.
        c.vel.lerp(toP.normalize().multiplyScalar(Math.min(14, 4 + c.age * 6)), 1 - Math.exp(-dt * 12));
      } else {
        c.vel.y -= 14 * dt;
      }
      c.pos.addScaledVector(c.vel, dt);
      if (c.pos.y < 0.04 && c.age <= 0.55) {
        c.pos.y = 0.04;
        c.vel.y = Math.abs(c.vel.y) * 0.45;
        c.vel.x *= 0.7;
        c.vel.z *= 0.7;
      }
      if (d < 0.45 && c.age > 0.55) {
        got += c.value;
        this.coins.splice(i, 1);
      }
    }
    let k = 0;
    for (const c of this.coins) {
      _o.position.copy(c.pos);
      _o.rotation.set(Math.PI / 2, 0, c.age * 9 + c.spin);
      _o.updateMatrix();
      this.mesh.setMatrixAt(k++, _o.matrix);
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    return got;
  }
}
