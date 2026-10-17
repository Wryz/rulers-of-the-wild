// The sky (docs/M1-DESIGN.md §10.4): a hemisphere light and a warm sun; the sun and its shadow camera follow the player
// (±RENDER_TUNING.shadowExtentM, far shadowFarM), snapped to whole shadow-map texels in the light's frame so the shadows
// never shimmer as the player walks; fog from fogNear to fogFar in the sky's colour. Everything is read live from
// RENDER_TUNING (the dev panel's edits show on the next frame).
import { Color, DirectionalLight, Fog, HemisphereLight, Matrix4, type Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';
import { RENDER_TUNING } from './terrainView';

const DEG = Math.PI / 180;

/** The unit vector from the ground toward the sun (azimuth from +z toward +x, elevation above the horizon). */
export function sunDirection(out = new Vector3()): Vector3 {
  const S = RENDER_TUNING.sky;
  const az = S.sunAzimuthDeg * DEG;
  const el = S.sunElevationDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

/** The unit vector toward the fill light (RENDER_TUNING.sky.fill*: a shadowless sky bounce opposite the sun). */
export function fillDirection(out = new Vector3()): Vector3 {
  const S = RENDER_TUNING.sky;
  const az = S.fillAzimuthDeg * DEG;
  const el = S.fillElevationDeg * DEG;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

/** One shadow-map texel, m: the shadow camera's width over the map's size. */
export function shadowTexelM(): number {
  const T = RENDER_TUNING;
  return (2 * T.shadowExtentM) / Math.max(1, T.shadowMap);
}

const _basis = new Matrix4();
const _inv = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _l = new Vector3();
const _up = new Vector3(0, 1, 0);

/**
 * `focus` moved to the nearest point whose coordinates across the light (in the shadow camera's own x and y) are whole
 * texels, keeping its depth along the light: the shadow map then samples the world at the same points every frame.
 */
export function snapToTexels(focus: Vector3, out = new Vector3()): Vector3 {
  const dir = sunDirection(_l);
  // The shadow camera looks from the sun toward the focus (−dir), with world up as its up (Object3D.lookAt).
  _z.copy(dir);
  _x.crossVectors(_up, _z);
  if (_x.lengthSq() < 1e-12) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(_z, _x).normalize();
  _basis.makeBasis(_x, _y, _z);
  _inv.copy(_basis).transpose();
  const texel = shadowTexelM();
  out.copy(focus).applyMatrix4(_inv);
  out.x = Math.round(out.x / texel) * texel;
  out.y = Math.round(out.y / texel) * texel;
  return out.applyMatrix4(_basis);
}

export class Sky {
  readonly background = new Color();
  readonly hemi = new HemisphereLight();
  readonly sun = new DirectionalLight();
  /**
   * C-fix: a shadowless fill from opposite the sun. With only the hemisphere light, a face turned from the sun (the
   * valley rim, a pit wall, a crown's far side) took ambient alone, which three.js's physical lighting divides by π:
   * near-black and with no facets showing (rule 3: the rim must read as rock). The fill gives those faces a direction
   * to shade by, so they read as lit, faceted rock.
   */
  readonly fill = new DirectionalLight();
  readonly fog: Fog;
  private readonly snapped = new Vector3();
  private mapSize = 0;

  constructor(private readonly scene: Scene) {
    const T = RENDER_TUNING;
    this.fog = new Fog(this.background, T.fogNear, T.fogFar);
    scene.background = this.background;
    scene.fog = this.fog;
    this.sun.castShadow = true;
    scene.add(this.hemi, this.sun, this.sun.target, this.fill, this.fill.target);
    this.look();
  }

  /** Puts the sun's shadow over `focus` (the player), snapped to texels, and applies the live sky, fog and shadow values. */
  sync(_world: World | null, focus: Vector3): void {
    const T = RENDER_TUNING;
    const s = this.sun;
    const cam = s.shadow.camera;
    const e = T.shadowExtentM;
    if (cam.right !== e || cam.far !== T.shadowFarM) {
      cam.left = -e;
      cam.right = e;
      cam.top = e;
      cam.bottom = -e;
      cam.near = 0.5;
      cam.far = T.shadowFarM;
      cam.updateProjectionMatrix();
    }
    if (this.mapSize !== T.shadowMap) {
      this.mapSize = T.shadowMap;
      s.shadow.mapSize.set(T.shadowMap, T.shadowMap);
      // A new size needs a new map.
      s.shadow.map?.dispose();
      s.shadow.map = null;
    }
    snapToTexels(focus, this.snapped);
    s.target.position.copy(this.snapped);
    s.position.copy(this.snapped).addScaledVector(sunDirection(_l), T.shadowFarM / 2);
    s.target.updateMatrixWorld();
    s.updateMatrixWorld();
    this.fill.target.position.copy(this.snapped);
    this.fill.position.copy(this.snapped).add(fillDirection(_l));
    this.fill.target.updateMatrixWorld();
    this.fill.updateMatrixWorld();
    this.look();
  }

  dispose(): void {
    this.scene.remove(this.hemi, this.sun, this.sun.target, this.fill, this.fill.target);
    if (this.scene.fog === this.fog) this.scene.fog = null;
    this.sun.dispose();
    this.fill.dispose();
    this.hemi.dispose();
  }

  private look(): void {
    const T = RENDER_TUNING;
    const S = T.sky;
    this.background.set(S.sky);
    this.fog.color.copy(this.background);
    this.fog.near = T.fogNear;
    this.fog.far = T.fogFar;
    this.hemi.color.set(S.hemiSky);
    this.hemi.groundColor.set(S.hemiGround);
    this.hemi.intensity = S.hemiIntensity;
    this.sun.color.set(S.sun);
    this.sun.intensity = S.sunIntensity;
    this.fill.color.set(S.fill);
    this.fill.intensity = S.fillIntensity;
    this.fill.visible = S.fillIntensity > 0;
    this.sun.shadow.bias = S.shadowBias;
    this.sun.shadow.normalBias = S.shadowNormalBias;
  }
}
