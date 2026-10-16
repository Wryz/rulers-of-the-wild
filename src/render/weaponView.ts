import {
  Matrix4,
  Quaternion,
  Vector3,
  BoxGeometry,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
} from 'three';
import type { WeaponDef } from '../sim/weapons';

const MATS: Record<string, { color: string; metalness?: number; roughness?: number }> = {
  steel: { color: '#eef2f5', metalness: 0.3, roughness: 0.25 },
  iron: { color: '#7e858b', metalness: 0.6, roughness: 0.45 },
  wood: { color: '#7a5232', roughness: 0.85 },
  darkWood: { color: '#4a2f1c', roughness: 0.85 },
  black: { color: '#1d1d20', roughness: 0.6 },
  brass: { color: '#c79a3c', metalness: 0.7, roughness: 0.35 },
  ash: { color: '#d7b98a', roughness: 0.8 },
  grey: { color: '#9aa0a8', metalness: 0.4, roughness: 0.5 },
  bone: { color: '#e6dcc4', roughness: 0.7 },
  glass: { color: '#2f6b3a', metalness: 0.1, roughness: 0.12 },
  red: { color: '#b3261e', roughness: 0.5 },
  cue: { color: '#c89a5c', roughness: 0.55 },
  white: { color: '#f2f2f2', roughness: 0.5 },
  darkSteel: { color: '#5d6166', metalness: 0.6, roughness: 0.4 },
  wrap: { color: '#2a2230', roughness: 0.9 },
};

const mat = (k: string) => {
  const m = MATS[k];
  return new MeshStandardMaterial({ color: m.color, metalness: m.metalness ?? 0, roughness: m.roughness ?? 0.7, flatShading: true });
};

/**
 * Blocky weapon models in weapon space: grip at the origin, the weapon running up +Y to
 * its tip, the flat of the blade facing ±X (the edge leads along +Z).
 */
export function buildWeapon(def: WeaponDef): Group {
  const g = new Group();
  const part = (geo: BufferGeometry, m: string, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const mesh = new Mesh(geo, mat(m));
    // Metal and bare-wood striking surfaces take blood.
    mesh.userData.bloodies = ['steel', 'iron', 'ash', 'bone', 'darkSteel', 'cue', 'glass'].includes(m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
  const L = def.length;
  switch (def.id) {
    case 'cleaver':
      part(box(0.035, 0.16, 0.035), 'darkWood', 0, -0.02, 0);
      part(box(0.012, 0.25, 0.11), 'steel', 0, 0.2, 0.035);
      break;
    case 'machete':
      part(box(0.035, 0.15, 0.035), 'black', 0, -0.02, 0);
      part(box(0.012, L - 0.1, 0.068), 'steel', 0, 0.06 + (L - 0.1) / 2, 0.01);
      part(box(0.014, L - 0.12, 0.012), 'iron', 0, 0.06 + (L - 0.12) / 2, -0.026);
      part(box(0.012, 0.09, 0.045), 'steel', 0, L - 0.02, 0.02, 0.45, 0, 0);
      break;
    case 'gladius':
      part(box(0.035, 0.13, 0.035), 'wood', 0, -0.02, 0);
      part(box(0.045, 0.03, 0.045), 'brass', 0, -0.1, 0);
      part(box(0.04, 0.025, 0.13), 'brass', 0, 0.06, 0);
      part(box(0.014, L - 0.16, 0.065), 'steel', 0, 0.07 + (L - 0.16) / 2, 0);
      part(box(0.014, 0.08, 0.046), 'steel', 0, L - 0.05, 0, Math.PI / 4, 0, 0);
      break;
    case 'pan':
      part(box(0.03, 0.26, 0.02), 'black', 0, 0.08, 0);
      part(new CylinderGeometry(0.13, 0.12, 0.035, 10), 'iron', 0, 0.33, 0, 0, 0, Math.PI / 2);
      break;
    case 'axe':
      part(box(0.04, L + 0.15, 0.04), 'wood', 0, (L - 0.15) / 2, 0);
      part(box(0.03, 0.12, 0.06), 'iron', 0, L - 0.14, 0);
      part(box(0.018, 0.2, 0.2), 'steel', 0, L - 0.14, 0.13);
      part(box(0.018, 0.26, 0.04), 'steel', 0, L - 0.14, 0.235);
      part(box(0.02, 0.05, 0.1), 'iron', 0, L - 0.14, -0.08);
      break;
    case 'bat':
      part(new CylinderGeometry(0.028, 0.022, 0.1, 8), 'black', 0, -0.07, 0);
      part(new CylinderGeometry(0.045, 0.024, L - 0.05, 8), 'ash', 0, (L - 0.05) / 2, 0);
      part(new CylinderGeometry(0.036, 0.036, 0.02, 8), 'ash', 0, -0.13, 0);
      break;
    case 'club':
      part(new CylinderGeometry(0.08, 0.035, L + 0.1, 7), 'darkWood', 0, (L - 0.1) / 2, 0);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const y = L * (0.55 + 0.4 * ((i * 0.37) % 1));
        part(box(0.025, 0.025, 0.06), 'bone', Math.sin(a) * 0.07, y, Math.cos(a) * 0.07, 0, a, 0);
      }
      break;
    case 'crowbar':
      // Hex bar with a hooked claw at the business end.
      part(box(0.03, L, 0.03), 'darkSteel', 0, L / 2 - 0.08, 0);
      part(box(0.03, 0.12, 0.03), 'darkSteel', 0, L - 0.06, 0.05, 0.9, 0, 0);
      part(box(0.03, 0.05, 0.03), 'red', 0, -0.04, 0);
      break;
    case 'pipe':
      part(new CylinderGeometry(0.026, 0.026, L + 0.08, 8), 'darkSteel', 0, L / 2 - 0.04, 0);
      part(new CylinderGeometry(0.034, 0.034, 0.05, 8), 'darkSteel', 0, L - 0.02, 0);
      break;
    case 'sledgehammer':
      part(box(0.04, L + 0.15, 0.04), 'wood', 0, (L - 0.15) / 2, 0);
      part(box(0.12, 0.12, 0.26), 'darkSteel', 0, L - 0.05, 0);
      break;
    case 'cue':
      // Tapered: thick butt in the hands, thin tip out front.
      part(new CylinderGeometry(0.009, 0.02, L + 0.2, 8), 'cue', 0, (L - 0.2) / 2, 0);
      part(new CylinderGeometry(0.022, 0.024, 0.3, 8), 'black', 0, -0.12, 0);
      part(new CylinderGeometry(0.009, 0.009, 0.02, 8), 'white', 0, L - 0.1, 0);
      break;
    case 'bottle':
      // Held by the neck, the heavy body out front.
      part(new CylinderGeometry(0.014, 0.016, 0.12, 8), 'glass', 0, 0.02, 0);
      part(new CylinderGeometry(0.035, 0.035, 0.16, 8), 'glass', 0, 0.17, 0);
      part(new CylinderGeometry(0.036, 0.036, 0.06, 8), 'white', 0, 0.17, 0);
      break;
    case 'ninjato':
      // Straight blade, square guard, cord-wrapped grip.
      part(box(0.034, 0.22, 0.032), 'wrap', 0, -0.05, 0);
      part(box(0.07, 0.012, 0.07), 'darkSteel', 0, 0.065, 0);
      part(box(0.008, L - 0.12, 0.036), 'steel', 0, 0.08 + (L - 0.12) / 2, 0.004);
      part(box(0.008, 0.05, 0.026), 'steel', 0, L - 0.02, 0.01, 0.6, 0, 0);
      break;
    case 'kunai':
      // Ring pommel, wrapped grip, leaf blade.
      part(new CylinderGeometry(0.022, 0.022, 0.008, 10), 'darkSteel', 0, -0.06, 0, Math.PI / 2, 0, 0);
      part(box(0.018, 0.1, 0.018), 'wrap', 0, 0.0, 0);
      part(box(0.006, 0.13, 0.04), 'darkSteel', 0, 0.12, 0);
      part(box(0.006, 0.04, 0.022), 'darkSteel', 0, 0.2, 0, 0.6, 0, 0);
      break;
    case 'katana':
      part(box(0.035, 0.26, 0.032), 'wrap', 0, -0.06, 0);
      part(new CylinderGeometry(0.05, 0.05, 0.012, 10), 'brass', 0, 0.075, 0);
      part(box(0.008, L - 0.1, 0.034), 'steel', 0, 0.08 + (L - 0.1) / 2, 0.004, 0.02, 0, 0);
      part(box(0.008, 0.06, 0.022), 'steel', 0, L - 0.01, 0.012, 0.5, 0, 0);
      break;
    case 'bokken':
      part(box(0.035, 0.26, 0.032), 'wood', 0, -0.06, 0);
      part(box(0.02, L - 0.1, 0.034), 'wood', 0, 0.08 + (L - 0.1) / 2, 0, 0.02, 0, 0);
      break;
    case 'fireaxe':
      part(box(0.035, L + 0.12, 0.035), 'red', 0, (L - 0.12) / 2, 0);
      part(box(0.03, 0.1, 0.05), 'darkSteel', 0, L - 0.1, 0);
      part(box(0.016, 0.16, 0.16), 'red', 0, L - 0.1, 0.1);
      part(box(0.016, 0.2, 0.025), 'steel', 0, L - 0.1, 0.19);
      part(box(0.02, 0.04, 0.12), 'darkSteel', 0, L - 0.1, -0.09, 0, 0, 0.2);
      break;
    case 'chair': {
      // Held by the back legs: legs, seat and backrest of a folding chair.
      for (const s of [1, -1]) part(box(0.022, L + 0.1, 0.022), 'grey', s * 0.17, (L - 0.1) / 2, 0);
      part(box(0.38, 0.28, 0.02), 'grey', 0, L - 0.12, 0);
      part(box(0.38, 0.02, 0.34), 'grey', 0, L * 0.45, 0.17);
      for (const s of [1, -1]) part(box(0.022, 0.4, 0.022), 'grey', s * 0.17, L * 0.45 - 0.2, 0.32, -0.5, 0, 0);
      break;
    }
  }
  return g;
}

/** A weapon lying on the floor, with a soft glow ring so it reads as a pickup. */
export class DropView {
  readonly root = new Group();
  private readonly ring: Mesh;
  private readonly ringMat: MeshStandardMaterial;
  private readonly holder = new Group();
  private readonly rest = new Quaternion();
  private readonly mass: number;
  /** A weapon let go of mid-air: falling, then a bounce, then still. */
  private fallState: { from: Vector3; t: number; tf: number; axis: Vector3; spin: number; bounce: number; landed: boolean; onLand?: (hard: number) => void } | null = null;
  private last = -1;

  constructor(def: WeaponDef, x: number, z: number, yaw: number) {
    const w = buildWeapon(def);
    this.mass = def.mass;
    // Lie it on its flat, along `yaw`, centred on the drop point.
    w.rotation.set(Math.PI / 2, 0, 0);
    w.position.set(0, def.id === 'chair' ? 0.03 : 0.035, -def.length / 2);
    const holder = this.holder;
    holder.add(w);
    holder.rotation.y = yaw;
    this.rest.copy(holder.quaternion);
    this.root.add(holder);
    this.ringMat = new MeshStandardMaterial({ color: '#ffe08a', emissive: new Color('#ffcf4a'), emissiveIntensity: 0.8, transparent: true, opacity: 0.5, depthWrite: false });
    this.ring = new Mesh(new RingGeometry(0.42, 0.5, 28), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.012;
    this.root.add(this.ring);
    this.root.position.set(x, 0, z);
  }

  /**
   * Fall from where a hand let go of it (world point, with height): straight down under
   * gravity, drifting to where it lands, tumbling a little (less the heavier it is —
   * the head drops first), a small bounce, then still. `onLand` fires on impact with
   * how hard it hit (0..1).
   */
  fall(fromWorld: Vector3, onLand?: (hard: number) => void) {
    const from = fromWorld.clone().sub(this.root.position);
    const h = Math.max(0.05, from.y);
    const seed = Math.sin(from.x * 12.9898 + from.z * 78.233) * 43758.5453;
    const r = seed - Math.floor(seed);
    this.fallState = {
      from,
      t: 0,
      tf: Math.sqrt((2 * h) / G),
      axis: new Vector3(Math.cos(r * 6.28), 0, Math.sin(r * 6.28)),
      spin: (1.1 + r) / Math.sqrt(Math.max(0.4, this.mass)),
      bounce: Math.min(0.08, 0.06 / Math.sqrt(Math.max(0.4, this.mass))) * Math.min(1, h),
      landed: false,
      onLand,
    };
    this.ring.visible = false;
    this.place(0);
  }

  private place(dt: number) {
    const f = this.fallState;
    if (!f) return;
    f.t += dt;
    const u = Math.min(1, f.t / f.tf);
    if (u < 1) {
      // Ballistic: dropped (not thrown), so it simply accelerates down.
      const y = Math.max(0, f.from.y - 0.5 * G * f.t * f.t);
      this.holder.position.set(f.from.x * (1 - u), y, f.from.z * (1 - u));
      _q.setFromAxisAngle(f.axis, f.spin * (1 - u) * (1 - u));
      this.holder.quaternion.copy(this.rest).premultiply(_q);
      return;
    }
    if (!f.landed) {
      f.landed = true;
      f.onLand?.(Math.min(1, Math.sqrt(2 * G * Math.max(0.05, f.from.y)) / 4.5));
    }
    // One small hop off the floor, then it settles.
    const tb = f.t - f.tf;
    const hop = Math.sqrt((2 * f.bounce) / G) * 2;
    const y = tb < hop ? Math.max(0, f.bounce - 0.5 * G * (tb - hop / 2) ** 2) : 0;
    this.holder.position.set(0, y, 0);
    this.holder.quaternion.copy(this.rest);
    if (tb >= hop) {
      this.fallState = null;
      this.ring.visible = true;
    }
  }

  update(time: number, near: boolean) {
    const dt = this.last < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.last));
    this.last = time;
    if (this.fallState) this.place(dt);
    const p = 0.5 + 0.5 * Math.sin(time * 3);
    this.ringMat.opacity = near ? 0.85 : 0.25 + 0.2 * p;
    this.ring.scale.setScalar(near ? 1.05 : 0.95 + 0.05 * p);
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as MeshStandardMaterial).dispose();
      }
    });
  }
}

const G = 9.81;
const _q = new Quaternion();

/**
 * A weapon in flight: the same model, placed every frame from the sim's rigid body —
 * grip where it is, pointing the way it points, the edge on the side it turns toward.
 */
export class ProjectileView {
  readonly root = new Group();
  private readonly model: Group;
  private readonly m = new Matrix4();
  private readonly x = new Vector3();
  private readonly y = new Vector3();
  private readonly z = new Vector3();

  constructor(def: WeaponDef, scale: number) {
    this.model = buildWeapon(def);
    this.model.scale.setScalar(scale);
    this.root.add(this.model);
  }

  /** @param grip world grip point; `dir` grip-to-tip; `edge` the way the edge faces (both unit). */
  place(grip: Vector3, dir: Vector3, edge: Vector3) {
    this.y.copy(dir).normalize();
    this.z.copy(edge).addScaledVector(this.y, -edge.dot(this.y));
    if (this.z.lengthSq() < 1e-6) this.z.set(0, 1, 0).addScaledVector(this.y, -this.y.y);
    this.z.normalize();
    this.x.crossVectors(this.y, this.z).normalize();
    this.m.makeBasis(this.x, this.y, this.z);
    this.model.quaternion.setFromRotationMatrix(this.m);
    this.model.position.copy(grip);
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as MeshStandardMaterial).dispose();
      }
    });
  }
}

