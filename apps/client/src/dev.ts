/**
 * Developer mode: the tuning panel (L), debug keys (hitboxes, slow motion, pause, frame
 * step, restart), the training ring and `window.game`. On in local development, or with
 * `?dev` in the URL; never shown to players otherwise.
 */
export const DEV = import.meta.env.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('dev'));
