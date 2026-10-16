import { type WeaponId, WEAPONS } from '../sim/weapons';
import { Pane } from 'tweakpane';
import { RAGDOLL_TUNING } from '../body/ragdoll';
import { GAME_TUNING, type Game } from '../game/game';
import { CAMERA_TUNING } from '../render/cameraRig';
import { FACING } from '../sim/combat';
import { ENEMY_MOVES, type MoveDef, PLAYER_MOVES } from '../sim/moves';

const MOVE_FIELDS: [keyof MoveDef, number, number, number][] = [
  ['startup', 1, 45, 1],
  ['active', 1, 12, 1],
  ['recovery', 1, 50, 1],
  ['damage', 0, 30, 0.5],
  ['hitstun', 0, 60, 1],
  ['knockback', 0, 8, 0.1],
  ['impulse', 0, 80, 1],
  ['hitstop', 0, 24, 1],
  ['shake', 0, 1, 0.01],
  ['radius', 0.05, 0.4, 0.01],
];

/** Live tuning panel (L). Everything edits the running game in place. */
export function buildPanel(game: Game): { toggle: () => void } {
  const container = document.createElement('div');
  container.className = 'panel';
  container.style.display = 'none';
  document.body.appendChild(container);
  const pane = new Pane({ title: 'Combat tuning', container });

  const time = pane.addFolder({ title: 'Time' });
  time.addBinding(GAME_TUNING, 'timeScale', { min: 0.05, max: 1.5, step: 0.05, label: 'time scale' });
  time.addBinding(GAME_TUNING, 'paused');
  time.addButton({ title: 'Step frame (.)' }).on('click', () => game.requestStep());
  time.addBinding(GAME_TUNING, 'showHitboxes', { label: 'hitboxes (H)' });

  const feel = pane.addFolder({ title: 'Feel' });
  feel.addBinding(GAME_TUNING, 'hitstopMul', { min: 0, max: 3, step: 0.05, label: 'hit-pause ×' });
  feel.addBinding(CAMERA_TUNING, 'shakeMul', { min: 0, max: 3, step: 0.05, label: 'shake ×' });
  feel.addBinding(RAGDOLL_TUNING, 'impulseMul', { min: 0, max: 4, step: 0.05, label: 'impulse ×' });
  feel.addBinding(RAGDOLL_TUNING, 'dipMul', { min: 0, max: 1.5, step: 0.05, label: 'hit limpness' });
  feel.addBinding(RAGDOLL_TUNING, 'muscleGain', { min: 0.05, max: 1, step: 0.01, label: 'muscle gain' });
  feel.addBinding(RAGDOLL_TUNING, 'rootGain', { min: 0.05, max: 1, step: 0.01, label: 'balance gain' });
  feel.addBinding(RAGDOLL_TUNING, 'limpStrength', { min: 0, max: 0.6, step: 0.01, label: 'downed muscle' });
  feel.addBinding(GAME_TUNING, 'volume', { min: 0, max: 1, step: 0.05 }).on('change', (ev) => game.sfx.setVolume(ev.value));

  const lock = pane.addFolder({ title: 'Lock-on', expanded: false });
  lock.addBinding(FACING, 'idleRate', { min: 0.01, max: 0.4, step: 0.005, label: 'turn (idle)' });
  lock.addBinding(FACING, 'walkRate', { min: 0.01, max: 0.4, step: 0.005, label: 'turn (moving)' });
  lock.addBinding(FACING, 'aimAssist', { min: 0, max: 0.3, step: 0.005, label: 'aim assist' });
  lock.addBinding(FACING, 'strafeLead', { min: 0, max: 1.2, step: 0.01, label: 'strafe lean' });
  lock.addBinding(FACING, 'idleDeadzone', { min: 0, max: 0.5, step: 0.01, label: 'deadzone' });

  const fw = pane.addFolder({ title: 'Footwork & idle (you)', expanded: false });
  const ps = game.player.footwork.style;
  const is = game.player.idle.style;
  fw.addBinding(ps, 'stanceWidth', { min: 0.7, max: 1.5, step: 0.01, label: 'stance width' });
  fw.addBinding(ps, 'stepFrames', { min: 4, max: 20, step: 1, label: 'step frames' });
  fw.addBinding(ps, 'stepHeight', { min: 0, max: 0.15, step: 0.005, label: 'step height' });
  fw.addBinding(is, 'bounceHz', { min: 0, max: 3, step: 0.05, label: 'bounce Hz' });
  fw.addBinding(is, 'bounceAmp', { min: 0, max: 0.1, step: 0.002, label: 'bounce height' });
  fw.addBinding(is, 'swayAmp', { min: 0, max: 0.15, step: 0.005, label: 'sway' });

  // Live view of how the player's movement is being shaped by the fight right now.
  const live = pane.addFolder({ title: 'Motion context (live)' });
  const mi = game.player.motionInfo;
  live.addBinding(mi, 'zone', { readonly: true, label: 'distance' });
  live.addBinding(mi, 'context', { readonly: true, label: 'context' });
  live.addBinding(mi, 'speed', { readonly: true });
  live.addBinding(mi, 'stride', { readonly: true });
  live.addBinding(mi, 'bounce', { readonly: true });
  live.addBinding(mi, 'guard', { readonly: true, label: 'guard Δ' });

  const cam = pane.addFolder({ title: 'Camera', expanded: false });
  cam.addBinding(CAMERA_TUNING, 'distance', { min: 1.5, max: 8, step: 0.05 });
  cam.addBinding(CAMERA_TUNING, 'rise', { min: 0.5, max: 5, step: 0.05 });
  cam.addBinding(CAMERA_TUNING, 'shoulder', { min: -1, max: 1, step: 0.05 });
  cam.addBinding(CAMERA_TUNING, 'sideAngle', { min: 0, max: 1.4, step: 0.02, label: 'side angle' });
  cam.addBinding(CAMERA_TUNING, 'turnRate', { min: 0.5, max: 10, step: 0.1, label: 'turn spring' });
  cam.addBinding(CAMERA_TUNING, 'fov', { min: 30, max: 90, step: 1 });

  const enemy = pane.addFolder({ title: 'Enemy AI' });
  enemy.addBinding(game.aiCfg, 'passive', { label: 'training dummy' });
  enemy.addBinding(game.aiCfg, 'aggression', { min: 0, max: 3, step: 0.05 });
  enemy.addBinding(game.aiCfg, 'blockChance', { min: 0, max: 1, step: 0.05, label: 'block chance' });
  enemy.addBinding(game.aiCfg, 'stringChance', { min: 0, max: 1, step: 0.05, label: 'string chance' });
  enemy.addButton({ title: 'Respawn enemy' }).on('click', () => game.spawnEnemy());
  enemy.addButton({ title: 'Restart (Backspace)' }).on('click', () => game.restart());

  const moves = pane.addFolder({ title: 'Moves', expanded: false });
  for (const [label, table] of [['You', PLAYER_MOVES], ['Brawler', ENEMY_MOVES]] as const) {
    const group = moves.addFolder({ title: label, expanded: false });
    for (const m of Object.values(table)) {
      const f = group.addFolder({ title: m.name, expanded: false });
      for (const [key, min, max, step] of MOVE_FIELDS) {
        f.addBinding(m as unknown as Record<string, number>, key, { min, max, step });
      }
    }
  }

  const wpn = pane.addFolder({ title: 'Weapons', expanded: false });
  const pick = { weapon: 'axe' };
  wpn.addBinding(pick, 'weapon', { options: Object.fromEntries(Object.values(WEAPONS).map((w) => [w.name, w.id])) });
  wpn.addButton({ title: 'Give to player' }).on('click', () => game.giveWeapon(pick.weapon as WeaponId));
  wpn.addButton({ title: 'Empty hands' }).on('click', () => game.giveWeapon(null));

  const runF = pane.addFolder({ title: 'Gauntlet', expanded: false });
  runF.addButton({ title: game.mode === 'gauntlet' ? 'Open training ring' : 'Back to the fights' }).on('click', () => {
    location.search = game.mode === 'gauntlet' ? '?mode=training' : '';
  });
  if (game.mode === 'gauntlet') {
    const jump = { round: 4 };
    runF.addBinding(jump, 'round', { min: 1, max: 40, step: 1, label: 'jump to' });
    runF.addButton({ title: 'Start that round' }).on('click', () => game.startRound(jump.round));
  }
  runF.addButton({ title: 'New game (reset save)' }).on('click', () => {
    try {
      localStorage.removeItem('brawler.save.v2');
    } catch {
      // ignore
    }
    location.reload();
  });
  runF.addButton({ title: '+200 coins' }).on('click', () => {
    game.save.coins += 200;
    game.hud.setCoins(game.save.coins);
  });

  pane.addButton({ title: 'Copy tuning as JSON' }).on('click', () => {
    const pick = (t: Record<string, MoveDef>) =>
      Object.fromEntries(Object.values(t).map((m) => [m.id, Object.fromEntries(MOVE_FIELDS.map(([k]) => [k, m[k]]))]));
    const json = JSON.stringify(
      { game: GAME_TUNING, ragdoll: RAGDOLL_TUNING, camera: CAMERA_TUNING, facing: FACING, ai: game.aiCfg, player: pick(PLAYER_MOVES), enemy: pick(ENEMY_MOVES) },
      null,
      2,
    );
    console.log(json);
    void navigator.clipboard?.writeText(json);
  });

  // Keep bindings in sync with keyboard shortcuts.
  setInterval(() => {
    if (container.style.display !== 'none') pane.refresh();
  }, 250);

  return {
    toggle: () => {
      container.style.display = container.style.display === 'none' ? 'block' : 'none';
    },
  };
}
