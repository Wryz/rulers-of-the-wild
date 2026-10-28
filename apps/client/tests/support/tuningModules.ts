// P38: the client modules that register tuning tables (defineTuning), relative to apps/client/src, without extension.
// tests/tuningDoc.test.ts and tools/tuning-rows.mjs import them all; a test checks this list against the sources.
export const CLIENT_TUNING_MODULES: readonly string[] = [
  'debug/panel',
  'ui/hud',
  'body/ragdoll',
  'game/killcam',
  'game/loop',
  'game/presentationWorld',
  'game/game',
  'feel/audio',
  'render/followCam',
  'render/cameraRig',
  'render/terrainView',
  'input/verbInput',
];
