import './style.css';
import { DEV } from './dev';
import { Game } from './game/game';

async function boot() {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const hud = document.querySelector<HTMLDivElement>('#ui')!;
  const loading = document.querySelector<HTMLDivElement>('#loading');
  try {
    const game = await Game.create(canvas, hud);
    if (DEV) {
      // (Loaded only in developer mode: none of it ships in the player's bundle.)
      const { buildPanel } = await import('./debug/panel');
      game.onTogglePanel = buildPanel(game).toggle;
      (window as unknown as { game: Game }).game = game;
    }
    game.start();
    loading?.remove();
  } catch (err) {
    console.error(err);
    if (loading) loading.textContent = "Couldn't start the game — please reload the page.";
  }
}

void boot();
