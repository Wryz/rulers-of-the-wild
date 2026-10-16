import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  type Scene,
  SpotLight,
} from 'three';
import { applyCutout } from '../render/cutout';
import { Rng } from '../sim/math';
import type { ThemeDef } from './themes';

const _o = new Object3D();
const _c = new Color();

/** Visuals for an arena theme: floor, boundary, props, lights. */
export class ThemeView {
  readonly group = new Group();
  readonly background: Color;
  private readonly flicker: { light: PointLight | SpotLight; base: number; seed: number }[] = [];
  private readonly sun: DirectionalLight;

  constructor(
    private readonly scene: Scene,
    readonly def: ThemeDef,
    seed: number,
  ) {
    scene.add(this.group);
    const rng = new Rng(seed);
    this.sun = new DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -12;
    c.right = 12;
    c.top = 11;
    c.bottom = -11;
    c.near = 1;
    c.far = 50;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.position.set(-6, 14, 7);
    this.group.add(this.sun, this.sun.target);
    this.background = new Color();
    switch (def.id) {
      case 'ring':
        this.buildRing(rng);
        break;
      case 'street':
        this.buildStreet(rng);
        break;
      case 'grocery':
        this.buildGrocery(rng);
        break;
      case 'colosseum':
        this.buildColosseum(rng);
        break;
      case 'warehouse':
        this.buildWarehouse(rng);
        break;
      case 'bar':
        this.buildBar(rng);
        break;
      case 'dojo':
        this.buildDojo(rng);
        break;
      case 'rooftop':
        this.buildRooftop(rng);
        break;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private mat(color: number | string, opts: { cut?: boolean; rough?: number; metal?: number; emissive?: number | string } = {}): MeshStandardMaterial {
    const m = new MeshStandardMaterial({
      color,
      flatShading: true,
      roughness: opts.rough ?? 0.85,
      metalness: opts.metal ?? 0,
      emissive: opts.emissive ?? 0x000000,
    });
    return opts.cut === false ? m : applyCutout(m);
  }

  private box(w: number, h: number, d: number, material: Material, x: number, y: number, z: number, ry = 0, shadow = true) {
    const m = new Mesh(new BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = shadow;
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  private light(skyColor: number, groundColor: number, hemi: number, sunColor: number, sun: number, sunPos: [number, number, number]) {
    this.group.add(new HemisphereLight(skyColor, groundColor, hemi));
    this.sun.color.set(sunColor);
    this.sun.intensity = sun;
    this.sun.position.set(...sunPos);
  }

  private ground(color: number, size = 120, y = -0.02) {
    const g = new Mesh(new PlaneGeometry(size, size), new MeshStandardMaterial({ color, roughness: 1 }));
    g.rotation.x = -Math.PI / 2;
    g.position.y = y;
    g.receiveShadow = true;
    this.group.add(g);
  }

  // ---------------------------------------------------------------------------
  // Themes
  // ---------------------------------------------------------------------------

  private buildRing(_rng: Rng) {
    this.background.set('#16171d');
    this.light(0x8d95b3, 0x2a2730, 0.7, 0xfff4e6, 1.2, [-3, 16, 5]);
    this.ground(0x24242c, 120, -0.9);
    const R = 3.6;
    // Raised platform and canvas.
    this.box(8.2, 0.9, 8.2, this.mat(0x1e3a6e, { cut: false }), 0, -0.45, 0, 0, false);
    const canvas = new Mesh(new PlaneGeometry(7.6, 7.6), new MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.95 }));
    canvas.rotation.x = -Math.PI / 2;
    canvas.position.y = 0.001;
    canvas.receiveShadow = true;
    this.group.add(canvas);
    const logo = new Mesh(new CylinderGeometry(1.1, 1.1, 0.004, 24), new MeshStandardMaterial({ color: 0xb8322a, roughness: 0.9 }));
    logo.position.y = 0.004;
    logo.receiveShadow = true;
    this.group.add(logo);
    // Corner posts and pads.
    const pads = [0xc0392b, 0xffffff, 0x2a62c9, 0xffffff];
    [
      [-R, -R],
      [R, -R],
      [R, R],
      [-R, R],
    ].forEach(([x, z], i) => {
      const post = new Mesh(new CylinderGeometry(0.08, 0.08, 1.6, 8), this.mat(0xb8b8bc, { metal: 0.6, rough: 0.35 }));
      post.position.set(x, 0.8, z);
      post.castShadow = true;
      this.group.add(post);
      this.box(0.22, 1.1, 0.22, this.mat(pads[i]), x * 0.97, 0.75, z * 0.97, Math.PI / 4);
    });
    // Ropes.
    const ropes = [0xc0392b, 0xf2f2f2, 0x2a62c9];
    [0.45, 0.85, 1.25].forEach((h, k) => {
      const m = this.mat(ropes[k], { rough: 0.5 });
      for (const [x, z, len, alongX] of [
        [0, -R, 2 * R, true],
        [0, R, 2 * R, true],
        [-R, 0, 2 * R, false],
        [R, 0, 2 * R, false],
      ] as [number, number, number, boolean][]) {
        this.box(alongX ? len : 0.05, 0.05, alongX ? 0.05 : len, m, x, h, z, 0, false);
      }
    });
    // Spotlights from the rig, with visible beams.
    for (const [x, z] of [
      [-5, -5],
      [5, -5],
      [0, 6],
    ]) {
      const spot = new SpotLight(0xfff2dc, 40, 22, 0.42, 0.5, 1.2);
      spot.position.set(x, 9, z);
      spot.target.position.set(0, 0, 0);
      this.group.add(spot, spot.target);
      const beam = new Mesh(
        new ConeGeometry(2.4, 9, 16, 1, true),
        new MeshBasicMaterial({ color: 0xfff2dc, transparent: true, opacity: 0.05, blending: AdditiveBlending, depthWrite: false }),
      );
      beam.position.set(x * 0.5, 4.5, z * 0.5);
      beam.lookAt(0, 0, 0);
      beam.rotateX(Math.PI / 2);
      this.group.add(beam);
    }
  }

  private buildStreet(rng: Rng) {
    this.background.set('#e9a679');
    this.light(0xffc9a0, 0x4a3d52, 1.1, 0xffb77a, 2, [-10, 9, 6]);
    this.ground(0x6b6660);
    const { hx, hz } = this.def.shape as { hx: number; hz: number };
    // Asphalt road and markings.
    this.box(hx * 2 + 8, 0.04, hz * 2, this.mat(0x3c3e43, { cut: false }), 0, -0.01, 0, 0, false);
    for (let x = -hx - 3; x < hx + 3; x += 1.6) this.box(0.8, 0.045, 0.12, this.mat(0xf2d04a, { cut: false }), x, 0, 0, 0, false);
    // Sidewalks.
    for (const s of [-1, 1]) this.box(hx * 2 + 8, 0.16, 2.2, this.mat(0xa29c94, { cut: false }), 0, 0.05, s * (hz + 1.1), 0, false);
    // Buildings on the far side.
    const colors = [0x8e4b3a, 0xc2a37a, 0x4f7c7a, 0x9b8a78, 0x6a5a8c];
    let x = -hx - 4;
    while (x < hx + 4) {
      const w = rng.range(2.4, 4);
      const h = rng.range(4, 8);
      const col = colors[Math.floor(rng.next() * colors.length)];
      this.box(w, h, 3, this.mat(col), x + w / 2, h / 2, -hz - 3.8);
      for (let wy = 1.4; wy < h - 0.6; wy += 1.3) {
        for (let wx = x + 0.5; wx < x + w - 0.4; wx += 0.9) {
          const lit = rng.chance(0.4);
          this.box(0.5, 0.65, 0.05, this.mat(lit ? 0xffe2a0 : 0x2d3440, { emissive: lit ? 0x8a6a2a : 0 }), wx + 0.25, wy, -hz - 2.28, 0, false);
        }
      }
      x += w + 0.1;
    }
    // Street lamps.
    for (const lx of [-hx + 1, 0, hx - 1]) {
      this.box(0.1, 3.6, 0.1, this.mat(0x2b2b2e, { metal: 0.5 }), lx, 1.8, -hz - 0.6);
      this.box(0.7, 0.08, 0.1, this.mat(0x2b2b2e), lx + 0.3, 3.6, -hz - 0.6);
      this.box(0.3, 0.12, 0.25, this.mat(0xfff0c0, { emissive: 0xffd080 }), lx + 0.6, 3.5, -hz - 0.6, 0, false);
      const l = new PointLight(0xffc070, 4, 9, 1.5);
      l.position.set(lx + 0.6, 3.3, -hz - 0.5);
      this.group.add(l);
      this.flicker.push({ light: l, base: 4, seed: rng.range(0, 9) });
    }
    // Parked car (obstacle), trash can, hydrant.
    const car = this.def.obstacles[0];
    if (car.kind === 'box') {
      const paint = this.mat(0x2f6fa8, { metal: 0.3, rough: 0.4 });
      this.box(car.hx * 2, 0.55, car.hz * 2, paint, car.x, 0.45, car.z);
      this.box(car.hx * 1.1, 0.45, car.hz * 1.8, this.mat(0x9fc2d9, { metal: 0.2, rough: 0.2 }), car.x - 0.1, 0.95, car.z);
      for (const [dx, dz] of [
        [-0.65, -0.45],
        [0.65, -0.45],
        [-0.65, 0.45],
        [0.65, 0.45],
      ]) {
        const w = new Mesh(new CylinderGeometry(0.2, 0.2, 0.14, 10), this.mat(0x1a1a1a));
        w.rotation.x = Math.PI / 2;
        w.position.set(car.x + dx, 0.2, car.z + dz);
        this.group.add(w);
      }
    }
    for (const o of this.def.obstacles.slice(1)) {
      if (o.kind !== 'circle') continue;
      const big = o.r > 0.25;
      const m = new Mesh(new CylinderGeometry(o.r, o.r * 0.9, big ? 0.9 : 0.55, 10), this.mat(big ? 0x4a5a4a : 0xc0392b, { metal: 0.3 }));
      m.position.set(o.x, big ? 0.45 : 0.28, o.z);
      m.castShadow = true;
      this.group.add(m);
    }
  }

  private buildGrocery(rng: Rng) {
    this.background.set('#dfe6ea');
    this.light(0xf4f8ff, 0xc9c2b4, 1.5, 0xffffff, 1.4, [-4, 16, 6]);
    this.ground(0xb9b4ac);
    const { hx, hz } = this.def.shape as { hx: number; hz: number };
    // Checker tile floor.
    const tiles = new InstancedMesh(new BoxGeometry(0.98, 0.04, 0.98), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }), Math.ceil(hx * 2 + 4) * Math.ceil(hz * 2 + 4));
    let k = 0;
    for (let x = -hx - 2; x < hx + 2; x++) {
      for (let z = -hz - 2; z < hz + 2; z++) {
        _o.position.set(x + 0.5, -0.02, z + 0.5);
        _o.rotation.set(0, 0, 0);
        _o.scale.set(1, 1, 1);
        _o.updateMatrix();
        tiles.setMatrixAt(k, _o.matrix);
        tiles.setColorAt(k, _c.set((x + z) % 2 === 0 ? '#f2f2ef' : '#c9cfd4'));
        k++;
      }
    }
    tiles.count = k;
    tiles.receiveShadow = true;
    this.group.add(tiles);
    const productColors = ['#d9533d', '#e8b53a', '#3aa76d', '#3d7bd9', '#8e5bd9', '#f2f2f2', '#c96a2b'];
    const shelf = (x: number, z: number, len: number, alongX: boolean, h: number) => {
      const frame = this.mat(0xd9d9d6, { metal: 0.3, rough: 0.5 });
      this.box(alongX ? len : 0.7, h, alongX ? 0.7 : len, frame, x, h / 2, z);
      for (let level = 0.35; level < h - 0.2; level += 0.45) {
        for (let t = -len / 2 + 0.2; t < len / 2 - 0.15; t += rng.range(0.22, 0.34)) {
          const c = productColors[Math.floor(rng.next() * productColors.length)];
          const ph = rng.range(0.18, 0.32);
          const m = this.mat(c);
          for (const side of [-1, 1]) {
            this.box(alongX ? 0.18 : 0.12, ph, alongX ? 0.12 : 0.18, m, alongX ? x + t : x + side * 0.4, level + ph / 2, alongX ? z + side * 0.4 : z + t, 0, false);
          }
        }
      }
    };
    // Perimeter shelving (far and sides), low freezers on the near side.
    shelf(0, -hz - 0.5, hx * 2 + 1, true, 2.2);
    shelf(-hx - 0.5, 0, hz * 2, false, 2.2);
    shelf(hx + 0.5, 0, hz * 2, false, 2.2);
    for (let x = -hx + 1; x < hx; x += 2.2) {
      this.box(2, 0.9, 0.9, this.mat(0xf4f6f8), x, 0.45, hz + 0.55);
      this.box(1.9, 0.05, 0.8, this.mat(0x9fd4f0, { metal: 0.2, rough: 0.1 }), x, 0.92, hz + 0.55, 0, false);
    }
    // Aisle islands (obstacles) and a cart.
    for (const o of this.def.obstacles) {
      if (o.kind === 'box') shelf(o.x, o.z, o.hx * 2, true, 1.4);
      else {
        const wire = this.mat(0xb8bcc2, { metal: 0.7, rough: 0.3 });
        this.box(0.6, 0.45, 0.85, wire, o.x, 0.65, o.z, 0.4);
        this.box(0.05, 0.5, 0.05, wire, o.x - 0.2, 0.25, o.z - 0.3, 0.4);
        this.box(0.05, 0.5, 0.05, wire, o.x + 0.2, 0.25, o.z + 0.3, 0.4);
      }
    }
    // Hanging sale signs.
    for (const sx of [-3, 3]) this.box(1.2, 0.45, 0.05, this.mat(0xe8402b, { emissive: 0x5a1000 }), sx, 2.8, -hz + 0.3, 0, false);
  }

  private buildColosseum(rng: Rng) {
    this.background.set('#9fd0f0');
    this.light(0xdcefff, 0xc9a77a, 1.2, 0xfff1d6, 2.3, [-8, 16, 4]);
    this.ground(0xc7ae7c);
    const R = (this.def.shape as { r: number }).r;
    // Sand floor with darker patches.
    const sand = new Mesh(new CylinderGeometry(R + 0.6, R + 0.6, 0.04, 48), new MeshStandardMaterial({ color: 0xdcc28c, roughness: 1, flatShading: true }));
    sand.position.y = -0.02;
    sand.receiveShadow = true;
    this.group.add(sand);
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, R - 1);
      const p = new Mesh(new CylinderGeometry(rng.range(0.4, 1.2), rng.range(0.4, 1.2), 0.01, 9), new MeshStandardMaterial({ color: 0xc9ac74, roughness: 1 }));
      p.position.set(Math.cos(a) * d, 0.002, Math.sin(a) * d);
      p.receiveShadow = true;
      this.group.add(p);
    }
    // Arena wall with arches.
    const segs = 40;
    const stone = this.mat(0xc8b48e);
    const dark = this.mat(0x6b5a44);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = Math.cos(a) * (R + 0.9);
      const z = Math.sin(a) * (R + 0.9);
      const w = ((Math.PI * 2 * (R + 0.9)) / segs) * 1.02;
      this.box(w, 2.6, 0.6, stone, x, 1.3, z, -a + Math.PI / 2);
      if (i % 2 === 0) this.box(w * 0.55, 1.5, 0.05, dark, Math.cos(a) * (R + 0.58), 0.75, Math.sin(a) * (R + 0.58), -a + Math.PI / 2, false);
    }
    // Tiered stands behind the wall.
    for (let row = 0; row < 6; row++) {
      const rr = R + 1.8 + row * 0.8;
      const y = 2.6 + row * 0.55;
      const tier = new Mesh(new CylinderGeometry(rr + 0.4, rr + 0.4, 0.55, 48, 1, true), this.mat(0xbfa983, { cut: false }));
      tier.position.y = y - 0.3;
      this.group.add(tier);
    }
    // Banners and the emperor's box.
    for (const a of [-2.2, -1.6, -1.0]) {
      const x = Math.cos(a) * (R + 0.95);
      const z = Math.sin(a) * (R + 0.95);
      this.box(0.08, 3.6, 0.08, this.mat(0x5a4632), x, 1.8, z);
      this.box(0.7, 1.4, 0.03, this.mat(0xa8231c), x, 2.9, z + 0.05, -a + Math.PI / 2, false);
    }
    this.box(3, 0.2, 1.6, this.mat(0x7a1f1a), 0, 4.4, -R - 2.2);
    // Broken columns (obstacles).
    for (const o of this.def.obstacles) {
      if (o.kind !== 'circle') continue;
      const col = new Mesh(new CylinderGeometry(o.r * 0.85, o.r, rng.range(1.2, 2.2), 10), this.mat(0xe0d2b4));
      col.position.set(o.x, 0.8, o.z);
      col.castShadow = true;
      this.group.add(col);
    }
  }

  /** Wooden planks (instanced) over a rectangle. */
  private planks(hx: number, hz: number, w: number, colors: string[], rng: Rng, y = -0.02) {
    const nx = Math.ceil((hx * 2 + 4) / w);
    const nz = Math.ceil((hz * 2 + 4) / 1.2);
    const mesh = new InstancedMesh(new BoxGeometry(w * 0.97, 0.04, 1.18), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 }), nx * nz);
    let k = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const stagger = (i % 2) * 0.6;
        _o.position.set(-hx - 2 + i * w + w / 2, y, -hz - 2 + j * 1.2 + stagger);
        _o.rotation.set(0, 0, 0);
        _o.scale.set(1, 1, 1);
        _o.updateMatrix();
        mesh.setMatrixAt(k, _o.matrix);
        mesh.setColorAt(k, _c.set(colors[Math.floor(rng.next() * colors.length)]));
        k++;
      }
    }
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  /** A hanging bulb or lamp with a little sway in its light. */
  private bulb(x: number, y: number, z: number, color: number, intensity: number, rng: Rng, shade = 0x2b2b2e) {
    this.box(0.012, 1.2, 0.012, this.mat(0x111111, { cut: false }), x, y + 0.6, z, 0, false);
    this.box(0.32, 0.12, 0.32, this.mat(shade, { metal: 0.4, cut: false }), x, y + 0.06, z, 0, false);
    this.box(0.1, 0.1, 0.1, this.mat(0xfff2c8, { emissive: color, cut: false }), x, y - 0.03, z, 0, false);
    const l = new PointLight(color, intensity, 10, 1.6);
    l.position.set(x, y - 0.15, z);
    l.castShadow = false;
    this.group.add(l);
    this.flicker.push({ light: l, base: intensity, seed: rng.range(0, 9) });
  }

  private buildWarehouse(rng: Rng) {
    this.background.set('#121216');
    this.light(0x6a7080, 0x231f1c, 0.55, 0xd8e0ff, 0.6, [-6, 14, 4]);
    this.ground(0x2a2a2c);
    const { hx, hz } = this.def.shape as { hx: number; hz: number };
    // Stained concrete slab.
    this.box(hx * 2 + 6, 0.04, hz * 2 + 6, this.mat(0x6d6c69, { cut: false, rough: 0.95 }), 0, -0.02, 0, 0, false);
    for (let i = 0; i < 9; i++) {
      const st = new Mesh(new CylinderGeometry(rng.range(0.3, 1), rng.range(0.3, 1), 0.005, 9), new MeshStandardMaterial({ color: 0x4c4a46, roughness: 1 }));
      st.position.set(rng.range(-hx, hx), 0.003, rng.range(-hz, hz));
      st.receiveShadow = true;
      this.group.add(st);
    }
    // Corrugated walls on the far side and ends.
    const wall = this.mat(0x5a6168, { metal: 0.4, rough: 0.6 });
    this.box(hx * 2 + 4, 4, 0.2, wall, 0, 2, -hz - 1.6);
    for (let x = -hx - 2; x < hx + 2; x += 0.35) this.box(0.08, 4, 0.08, this.mat(0x4a5056, { metal: 0.4 }), x, 2, -hz - 1.48, 0, false);
    for (const s of [-1, 1]) this.box(0.2, 4, hz * 2 + 3, wall, s * (hx + 1.8), 2, 0);
    // Roller door, glowing exit sign.
    this.box(3, 3, 0.06, this.mat(0x7a7f85, { metal: 0.5 }), 2.5, 1.5, -hz - 1.45, 0, false);
    this.box(0.5, 0.18, 0.05, this.mat(0x2a8a3a, { emissive: 0x1a8a2a }), -3, 3.2, -hz - 1.45, 0, false);
    // Pillars with hazard bands, and crate stacks.
    for (const o of this.def.obstacles) {
      if (o.kind === 'circle') {
        const col = new Mesh(new CylinderGeometry(o.r, o.r, 4.5, 10), this.mat(0x7c858d, { metal: 0.5, rough: 0.4 }));
        col.position.set(o.x, 2.25, o.z);
        col.castShadow = true;
        this.group.add(col);
        for (let b = 0; b < 4; b++) {
          const band = new Mesh(new CylinderGeometry(o.r + 0.01, o.r + 0.01, 0.12, 10), this.mat(b % 2 ? 0x1a1a1a : 0xe8b52a));
          band.position.set(o.x, 0.3 + b * 0.12, o.z);
          this.group.add(band);
        }
      } else {
        const wood = this.mat(0x9a7448);
        this.box(o.hx * 2, 0.9, o.hz * 2, wood, o.x, 0.45, o.z);
        this.box(o.hx * 1.6, 0.8, o.hz * 1.6, this.mat(0x8a6a40), o.x + 0.05, 1.3, o.z - 0.05, 0.2);
      }
    }
    // Oil drums and pallets around the edge.
    for (const [x, z] of [[-hx - 0.9, -hz + 0.4], [hx + 1, hz - 1], [hx + 0.9, -1.4]]) {
      const d = new Mesh(new CylinderGeometry(0.28, 0.28, 0.85, 10), this.mat(rng.chance(0.5) ? 0x2a5a8a : 0x8a2a2a, { metal: 0.4 }));
      d.position.set(x, 0.43, z);
      d.castShadow = true;
      this.group.add(d);
    }
    // Bare bulbs over the fight.
    for (const [x, z] of [[-2.5, -0.5], [2.5, 0.6], [0, -2.5], [0, 2.4]]) this.bulb(x, 3.1, z, 0xffc77a, 5, rng);
  }

  private buildBar(rng: Rng) {
    this.background.set('#20140e');
    this.light(0xffc89a, 0x2a1a12, 0.65, 0xffd9a8, 0.7, [-5, 14, 6]);
    this.ground(0x2a1c14);
    const { hx, hz } = this.def.shape as { hx: number; hz: number };
    this.planks(hx, hz, 0.28, ['#6b4426', '#5e3b20', '#74492a', '#553519'], rng);
    // Walls: dark wood panelling, back bar with lit bottles.
    const panel = this.mat(0x3d2414);
    this.box(hx * 2 + 4, 3.6, 0.2, panel, 0, 1.8, -hz - 1.3);
    for (const s of [-1, 1]) this.box(0.2, 3.6, hz * 2 + 3, panel, s * (hx + 1.5), 1.8, 0);
    const counter = this.def.obstacles[0];
    if (counter.kind === 'box') {
      this.box(counter.hx * 2, 1.05, counter.hz * 2, this.mat(0x5a3418, { rough: 0.4 }), counter.x, 0.52, counter.z);
      this.box(counter.hx * 2 + 0.1, 0.06, counter.hz * 2 + 0.1, this.mat(0x2a1a10, { rough: 0.25 }), counter.x, 1.07, counter.z, 0, false);
      // Back shelves of bottles glowing in the bar light.
      const glass = ['#3a8a4a', '#8a5a1a', '#c9a227', '#7a2a2a', '#d9d9d9', '#2a5a8a'];
      for (const shelfY of [1.3, 1.75, 2.2]) {
        this.box(counter.hx * 2, 0.04, 0.3, this.mat(0x4a2a14), counter.x, shelfY, -hz - 1.05, 0, false);
        for (let x = -counter.hx + 0.1; x < counter.hx; x += rng.range(0.1, 0.18)) {
          const c = glass[Math.floor(rng.next() * glass.length)];
          const h = rng.range(0.22, 0.34);
          this.box(0.07, h, 0.07, this.mat(c, { emissive: c, rough: 0.15 }), counter.x + x, shelfY + h / 2 + 0.02, -hz - 1.05, 0, false);
        }
      }
    }
    // Pool table under its lamp.
    const pool = this.def.obstacles[1];
    if (pool.kind === 'box') {
      this.box(pool.hx * 2, 0.75, pool.hz * 2, this.mat(0x4a2a14), pool.x, 0.37, pool.z);
      this.box(pool.hx * 2 - 0.16, 0.04, pool.hz * 2 - 0.16, this.mat(0x1f6b3a, { rough: 0.95 }), pool.x, 0.77, pool.z, 0, false);
      for (let i = 0; i < 6; i++) {
        const b = new Mesh(new CylinderGeometry(0.03, 0.03, 0.06, 8), this.mat(['#f2f2f2', '#c9a227', '#2a5a8a', '#c0392b', '#1a1a1a', '#6a2b8c'][i]));
        b.position.set(pool.x + rng.range(-pool.hx + 0.2, pool.hx - 0.2), 0.81, pool.z + rng.range(-pool.hz + 0.15, pool.hz - 0.15));
        this.group.add(b);
      }
      this.bulb(pool.x, 2.4, pool.z, 0xfff0c8, 4, rng, 0x1f4a2a);
    }
    // Round tables with chairs.
    for (const o of this.def.obstacles.slice(2)) {
      if (o.kind !== 'circle') continue;
      const top = new Mesh(new CylinderGeometry(o.r, o.r, 0.05, 14), this.mat(0x5a3418, { rough: 0.4 }));
      top.position.set(o.x, 0.75, o.z);
      top.castShadow = true;
      this.group.add(top);
      this.box(0.08, 0.72, 0.08, this.mat(0x2a1a10), o.x, 0.36, o.z);
      for (let a = 0; a < 3; a++) {
        const ang = a * 2.1 + rng.range(-0.2, 0.2);
        this.box(0.32, 0.45, 0.32, this.mat(0x4a2a14), o.x + Math.cos(ang) * (o.r + 0.25), 0.22, o.z + Math.sin(ang) * (o.r + 0.25), ang);
      }
    }
    // Neon signs.
    this.box(1.4, 0.3, 0.04, this.mat(0xff4fa3, { emissive: 0xff2a8a }), -2.6, 2.8, -hz - 1.18, 0, false);
    this.box(1.0, 0.25, 0.04, this.mat(0x4fd9ff, { emissive: 0x2ab8ff }), 2.8, 2.9, -hz - 1.18, 0, false);
    for (const [x, z] of [[-2.2, 0.4], [1.4, -0.6]]) this.bulb(x, 2.6, z, 0xffb070, 3, rng);
  }

  private buildDojo(rng: Rng) {
    this.background.set('#e6d8bc');
    this.light(0xfff6e4, 0xb89a72, 1.4, 0xfff0d6, 1.6, [-6, 15, 5]);
    this.ground(0x8a6a48);
    const { hx, hz } = this.def.shape as { hx: number; hz: number };
    this.planks(hx, hz, 0.24, ['#c9a06a', '#c29862', '#d0a972', '#bb9058'], rng);
    // Tatami border where the students sit.
    for (const s of [-1, 1]) this.box(hx * 2 + 2, 0.05, 0.9, this.mat(0xb8b07a, { cut: false }), 0, 0.005, s * (hz + 0.55), 0, false);
    // Shoji screens: paper panels in dark wooden frames.
    const frame = this.mat(0x3a2414);
    const paper = this.mat(0xf6f0e0, { emissive: 0x2a2620 });
    const screen = (x: number, z: number, len: number, alongX: boolean) => {
      this.box(alongX ? len : 0.06, 2.6, alongX ? 0.06 : len, paper, x, 1.3, z);
      for (let t = -len / 2; t <= len / 2 + 0.01; t += 0.5) this.box(alongX ? 0.05 : 0.08, 2.6, alongX ? 0.08 : 0.05, frame, alongX ? x + t : x, 1.3, alongX ? z : z + t, 0, false);
      for (const y of [0.05, 0.9, 1.75, 2.6]) this.box(alongX ? len : 0.08, 0.05, alongX ? 0.08 : len, frame, x, y, z, 0, false);
    };
    screen(0, -hz - 1.1, hx * 2 + 2, true);
    for (const s of [-1, 1]) screen(s * (hx + 1.1), 0, hz * 2 + 2, false);
    // Weapon rack, a hanging scroll, a small shrine.
    this.box(2.2, 0.08, 0.2, frame, -1.8, 1.6, -hz - 0.95, 0, false);
    for (let i = 0; i < 5; i++) this.box(0.04, 0.95, 0.04, this.mat(i % 2 ? 0x8a5a2a : 0x1a1a1a), -2.6 + i * 0.4, 1.15, -hz - 0.9, 0.15, false);
    this.box(0.6, 1.3, 0.02, this.mat(0xf2ead6), 1.8, 1.7, -hz - 1.02, 0, false);
    this.box(0.12, 0.7, 0.025, this.mat(0x1a1a1a), 1.8, 1.75, -hz - 1.0, 0, false);
    this.box(0.9, 0.5, 0.4, this.mat(0x7a2418), 3.4, 1.4, -hz - 0.9);
  }

  private buildRooftop(rng: Rng) {
    this.background.set('#141b2c');
    this.light(0x8a9cd0, 0x2a2a36, 1.0, 0xc8d4ff, 1.5, [6, 14, -4]);
    this.ground(0x0c0f18, 120, -14);
    const { hx, hz } = this.def.shape as { hx: number; hz: number };
    // Tar-and-gravel roof slab with a low parapet.
    this.box(hx * 2 + 3, 0.3, hz * 2 + 3, this.mat(0x3a3a3e, { cut: false, rough: 1 }), 0, -0.15, 0, 0, false);
    for (let i = 0; i < 160; i++) this.box(0.05, 0.02, 0.05, this.mat(rng.chance(0.5) ? 0x5a5a5e : 0x2a2a2e, { cut: false }), rng.range(-hx - 1, hx + 1), 0.005, rng.range(-hz - 1, hz + 1), rng.range(0, 3), false);
    const ledge = this.mat(0x6a6660);
    this.box(hx * 2 + 3, 0.6, 0.3, ledge, 0, 0.3, -hz - 1.35);
    this.box(hx * 2 + 3, 0.6, 0.3, ledge, 0, 0.3, hz + 1.35);
    for (const s of [-1, 1]) this.box(0.3, 0.6, hz * 2 + 3, ledge, s * (hx + 1.35), 0.3, 0);
    // The building's side dropping away below the parapet.
    this.box(hx * 2 + 3, 14, hz * 2 + 3, this.mat(0x2a2c34, { cut: false }), 0, -7.3, 0, 0, false);
    // AC unit, stairwell hut, vent stack.
    for (const o of this.def.obstacles) {
      if (o.kind === 'box' && o.hx > 0.8) {
        this.box(o.hx * 2, 1.1, o.hz * 2, this.mat(0xa8adb2, { metal: 0.4, rough: 0.5 }), o.x, 0.55, o.z);
        const fan = new Mesh(new CylinderGeometry(0.42, 0.42, 0.04, 14), this.mat(0x2a2a2e));
        fan.position.set(o.x, 1.12, o.z);
        this.group.add(fan);
      } else if (o.kind === 'box') {
        this.box(o.hx * 2, 2.6, o.hz * 2, this.mat(0x8a7a6a), o.x, 1.3, o.z);
        this.box(0.7, 1.9, 0.05, this.mat(0x4a3a2a), o.x - o.hx - 0.01, 0.95, o.z, Math.PI / 2, false);
        this.bulb(o.x - o.hx - 0.3, 2.3, o.z, 0xffd28a, 3, rng);
      } else {
        const v = new Mesh(new CylinderGeometry(o.r, o.r, 1.4, 10), this.mat(0x9aa0a6, { metal: 0.6, rough: 0.3 }));
        v.position.set(o.x, 0.7, o.z);
        v.castShadow = true;
        this.group.add(v);
      }
    }
    // Water tower behind, and the skyline all around.
    const tank = new Mesh(new CylinderGeometry(1.1, 1.1, 1.8, 14), this.mat(0x6a4a32, { cut: false }));
    tank.position.set(-hx + 1, 4.2, -hz - 3.2);
    this.group.add(tank);
    for (const dx of [-0.8, 0.8]) this.box(0.08, 3.2, 0.08, this.mat(0x3a3a3e, { cut: false }), -hx + 1 + dx, 1.6, -hz - 3.2, 0, false);
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      if (Math.sin(a) > 0.6) continue; // keep the camera side clear
      const d = rng.range(14, 26);
      const w = rng.range(2, 5);
      const h = rng.range(6, 22);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      this.box(w, h, w, this.mat(rng.chance(0.5) ? 0x232838 : 0x1c2030, { cut: false }), x, h / 2 - 14 + rng.range(4, 14), z, a, false);
      for (let k = 0; k < 6; k++) {
        if (!rng.chance(0.6)) continue;
        const wy = rng.range(0, h) - h / 2;
        this.box(w * 0.2, 0.3, 0.05, this.mat(0xffe2a0, { emissive: 0xc9a050, cut: false }), x - Math.cos(a) * (w / 2 + 0.03), h / 2 - 14 + rng.range(4, 14) + wy, z - Math.sin(a) * (w / 2 + 0.03), a + Math.PI / 2, false);
      }
    }
    // Work lights on the parapet.
    for (const x of [-hx + 0.5, hx - 2]) {
      this.box(0.25, 0.18, 0.15, this.mat(0xfff2c8, { emissive: 0xffd28a }), x, 0.72, -hz - 1.2, 0, false);
      const l = new PointLight(0xffd8a0, 5, 11, 1.4);
      l.position.set(x, 1.1, -hz - 0.9);
      this.group.add(l);
    }
  }

  update(time: number) {
    for (const f of this.flicker) f.light.intensity = f.base * (0.9 + 0.1 * Math.sin(time * 9 + f.seed));
  }
}
