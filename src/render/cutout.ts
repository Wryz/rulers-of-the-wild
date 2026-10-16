import { type Camera, type Material, Vector2, Vector3 } from 'three';

/**
 * See-through walls: geometry nearer the camera than the fight is dissolved in a soft,
 * dithered screen-space ellipse around the focus point. Works with any
 * MeshStandardMaterial (including instanced meshes) by patching its shader.
 */
export const cutoutUniforms = {
  uCutCenter: { value: new Vector2(0, 0) },
  uCutRadius: { value: new Vector2(0.2, 0.3) },
  uCutDepth: { value: 0 },
  uCutOn: { value: 1 },
};

const FRAG_HEAD = /* glsl */ `
uniform vec2 uCutCenter;
uniform vec2 uCutRadius;
uniform float uCutDepth;
uniform float uCutOn;
varying vec4 vCutClip;
float cutBayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return (m[idx] + 0.5) / 16.0;
}`;

const FRAG_BODY = /* glsl */ `
if (uCutOn > 0.5) {
  // vViewPosition = -viewPos, so -vViewPosition.z is view-space z (larger = nearer camera).
  float nearer = (-vViewPosition.z) - uCutDepth;
  if (nearer > 0.15) {
    vec2 ndc = vCutClip.xy / vCutClip.w;
    float r = length((ndc - uCutCenter) / uCutRadius);
    // Soft dithered rim; fade in with depth so the wall right beside the fighter
    // isn't sliced abruptly.
    // (smoothstep needs edge0 < edge1 to be well-defined on every GPU.)
    float cut = (1.0 - smoothstep(0.72, 1.0, r)) * smoothstep(0.15, 0.8, nearer);
    if (cut > cutBayer4(gl_FragCoord.xy)) discard;
  }
}`;

export function applyCutout<T extends Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cutoutUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vCutClip;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCutClip = gl_Position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_BODY}`);
  };
  mat.customProgramCacheKey = () => 'cutout-v2';
  return mat;
}

const _v = new Vector3();

/** Centres the cutout on `focus` (world) with a screen-space ellipse of `radiusY` (NDC). */
export function updateCutout(camera: Camera, focus: Vector3, radiusY: number, aspect: number) {
  _v.copy(focus).project(camera);
  cutoutUniforms.uCutCenter.value.set(_v.x, _v.y);
  cutoutUniforms.uCutRadius.value.set(radiusY / aspect, radiusY);
  _v.copy(focus).applyMatrix4(camera.matrixWorldInverse);
  cutoutUniforms.uCutDepth.value = _v.z;
}
