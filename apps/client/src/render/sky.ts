// The sky (docs/M1-DESIGN.md §10.4): hemisphere light and sun; the sun and its shadow camera follow the player (snapped
// to texels, ±RENDER_TUNING.shadowExtentM, far shadowFarM); fog from fogNear to fogFar.
//
// STUB (P31; P32 fills it): the final exported name; a hemisphere light, a sun whose shadow follows the focus point, and
// the fog, all read live from RENDER_TUNING (P32: texel snapping, the real colours, the far planes).
import { Color, DirectionalLight, Fog, HemisphereLight, type Scene, Vector3 } from 'three';
import type { World } from '@wild/sim';
import { RENDER_TUNING } from './terrainView';

/** From the focus toward the sun (DS's arena sun at (−6, 14, 7)), unit length. */
const SUN_DIR = new Vector3(-6, 14, 7).normalize();

export class Sky {
  readonly background = new Color();
  readonly hemi = new HemisphereLight();
  readonly sun = new DirectionalLight();
  private readonly fog: Fog;

  constructor(private readonly scene: Scene) {
    const T = RENDER_TUNING;
    this.fog = new Fog(this.background, T.fogNear, T.fogFar);
    scene.background = this.background;
    scene.fog = this.fog;
    const s = this.sun;
    s.castShadow = true;
    s.shadow.mapSize.set(T.shadowMap, T.shadowMap);
    s.shadow.bias = -0.0005;
    s.shadow.normalBias = 0.02;
    scene.add(this.hemi, s, s.target);
    this.look();
  }

  /** Puts the sun's shadow over `focus` (the player) and applies the live sky, fog and shadow values. */
  sync(_world: World, focus: Vector3): void {
    const T = RENDER_TUNING;
    const s = this.sun;
    const cam = s.shadow.camera;
    const e = T.shadowExtentM;
    if (cam.right !== e || cam.far !== T.shadowFarM) {
      cam.left = -e;
      cam.right = e;
      cam.top = e;
      cam.bottom = -e;
      cam.near = 1;
      cam.far = T.shadowFarM;
      cam.updateProjectionMatrix();
    }
    s.target.position.copy(focus);
    s.position.copy(focus).addScaledVector(SUN_DIR, T.shadowFarM / 2);
    this.look();
  }

  dispose(): void {
    this.scene.remove(this.hemi, this.sun, this.sun.target);
    this.sun.dispose();
    this.hemi.dispose();
  }

  private look(): void {
    const T = RENDER_TUNING;
    this.background.set(T.skyColor);
    this.fog.color.copy(this.background);
    this.fog.near = T.fogNear;
    this.fog.far = T.fogFar;
    this.hemi.color.set(T.hemiSkyColor);
    this.hemi.groundColor.set(T.hemiGroundColor);
    this.hemi.intensity = T.hemiIntensity;
    this.sun.color.set(T.sunColor);
    this.sun.intensity = T.sunIntensity;
  }
}
