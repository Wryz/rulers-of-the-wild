import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, type Scene, Vector3 } from 'three';

interface Gib {
  obj: Group;
  vel: Vector3;
  spin: Vector3;
  size: number;
  rest: boolean;
}

const MAX_GIBS = 40;
const RAW = new MeshStandardMaterial({ color: '#9e1016', roughness: 0.3, flatShading: true });
const skinMats = new Map<string, MeshStandardMaterial>();
const skinMat = (c: string) => {
  let m = skinMats.get(c);
  if (!m) skinMats.set(c, (m = new MeshStandardMaterial({ color: new Color(c), roughness: 0.7, flatShading: true })));
  return m;
};

/**
 * Pieces of people: an ear, a flap of scalp, a lump of muscle — skin on one side, raw
 * on the other. They fly off on a ballistic arc, tumble, bounce once or twice and lie
 * where they land until the arena is cleaned up.
 */
export class Gibs {
  private readonly list: Gib[] = [];

  constructor(private readonly scene: Scene) {}

  spawn(at: Vector3, vel: Vector3, size: number, skin: string, piece: string) {
    const g = new Group();
    const ear = piece === 'earL' || piece === 'earR';
    const [w, h, d] = ear ? [0.03, 0.075, 0.055] : piece === 'scalp' ? [size, size * 0.3, size * 0.9] : [size, size * 0.6, size * 0.8];
    const outer = new Mesh(new BoxGeometry(w, h, d), skinMat(skin));
    const inner = new Mesh(new BoxGeometry(w * 0.85, h * 0.85, d * 0.85), RAW);
    // The torn side is raw.
    inner.position.set(ear ? 0 : 0, -h * 0.12, 0);
    outer.castShadow = true;
    g.add(outer, inner);
    g.position.copy(at);
    this.scene.add(g);
    this.list.push({ obj: g, vel: vel.clone(), spin: new Vector3((Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24), size: Math.max(w, h, d), rest: false });
    while (this.list.length > MAX_GIBS) this.scene.remove(this.list.shift()!.obj);
  }

  update(dt: number, onLand?: (at: Vector3, speed: number) => void) {
    for (const g of this.list) {
      if (g.rest) continue;
      g.vel.y -= 9.8 * dt;
      g.obj.position.addScaledVector(g.vel, dt);
      g.obj.rotation.x += g.spin.x * dt;
      g.obj.rotation.y += g.spin.y * dt;
      g.obj.rotation.z += g.spin.z * dt;
      const floor = g.size * 0.25;
      if (g.obj.position.y < floor) {
        g.obj.position.y = floor;
        const speed = -g.vel.y;
        if (speed > 0.6) onLand?.(g.obj.position, speed);
        // Wet and soft: hardly bounces, slides a little, stops.
        g.vel.y = speed * 0.2;
        g.vel.x *= 0.45;
        g.vel.z *= 0.45;
        g.spin.multiplyScalar(0.4);
        if (speed < 0.8) {
          g.rest = true;
          // Lies flat.
          g.obj.rotation.x = Math.round(g.obj.rotation.x / (Math.PI / 2)) * (Math.PI / 2);
          g.obj.rotation.z = Math.round(g.obj.rotation.z / (Math.PI / 2)) * (Math.PI / 2);
        }
      }
    }
  }

  clear() {
    for (const g of this.list) this.scene.remove(g.obj);
    this.list.length = 0;
  }
}
