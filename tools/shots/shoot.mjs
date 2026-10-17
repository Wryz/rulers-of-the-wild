// Developer screenshots, step 3 (tools/shots/README.md): opens each shot of tools/shots/out/manifest.json in the real
// client on a running dev server (headless Chromium through Playwright, WebGL on SwiftShader) and writes a 1280×720 PNG
// of the moment the scene builder saved.
//
//   node tools/shots/shoot.mjs <devServerUrl> <outDir> [names...]
//
// `names` filters by scene ("log-on-player") or by shot ("log-on-player-impact"); none means every shot. A shot with
// `motionTicks` or `motionMs` in the manifest also gets a second PNG (`<shot>-motion.png`): after the loop's own dev
// advance of that many ticks (GameLoop.advance: sim and presentation stepped exactly as in play, deterministic), or
// after the loop ran unpaused for that much real time (SwiftShader frames are slow and the loop caps its steps per
// frame, so that is only a few ticks a second). The page is the dev build (import.meta.env.DEV), booted with
// ?save=…&paused=1&cam=…&hud=0: the world is loadWorld's from the save, the loop starts paused (rule 8: the loop's
// pause, not the sim's), the camera is pinned.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVES = join(HERE, 'out');
const VIEW = { width: 1280, height: 720 };
/** Rendered frames to wait after the world is up before the shot (terrain tiles, instancing, shadows settle). */
const SETTLE_FRAMES = 30;
/** How long one page may take to boot (a SwiftShader frame of the Clearing can take a second). */
const BOOT_TIMEOUT_MS = 120_000;

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node tools/shots/shoot.mjs <devServerUrl> <outDir> [names...]');
  process.exit(2);
}

const [server, outArg, ...names] = process.argv.slice(2);
if (!server || !outArg) usage();
const outDir = resolve(outArg);
const manifestPath = join(SAVES, 'manifest.json');
if (!existsSync(manifestPath)) usage(`no ${manifestPath}: run the scene builder first (npx vite-node tools/shots/scenes.ts)`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const shots = manifest.shots.filter((s) => names.length === 0 || names.includes(s.scene) || names.includes(s.name));
if (shots.length === 0) usage(`no shot matches ${names.join(', ')}`);
mkdirSync(outDir, { recursive: true });

/** The dev-server URL that boots `shot` paused at its saved tick, framed by its camera, without the HUD. */
function shotUrl(shot) {
  const c = shot.camera;
  const q = new URLSearchParams({
    save: `/@fs${join(SAVES, shot.save)}`,
    paused: '1',
    cam: [...c.pos, ...c.target].map((v) => +v.toFixed(3)).join(','),
    hud: '0',
  });
  if (c.fov) q.set('fov', String(c.fov));
  return `${server.replace(/\/$/, '')}/?${q.toString()}`;
}

/** Resolves after `n` animation frames of the page. */
const frames = (page, n) =>
  page.evaluate(
    (count) =>
      new Promise((done) => {
        let k = 0;
        const f = () => (++k >= count ? done() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
try {
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
    });
    try {
      await page.goto(shotUrl(shot), { waitUntil: 'load', timeout: BOOT_TIMEOUT_MS });
      // The world is up: developer mode exposes `game`, and the boot removes #loading once the loop has started (it
      // stays, with its text changed, if the boot failed).
      await page.waitForFunction(() => 'game' in window || /Couldn't start/.test(document.querySelector('#loading')?.textContent ?? ''), null, {
        timeout: BOOT_TIMEOUT_MS,
        polling: 250,
      });
      const loading = await page.evaluate(() => document.querySelector('#loading')?.textContent ?? null);
      if (loading !== null && /Couldn't start/.test(loading)) throw new Error(`the client did not boot: ${problems.join(' | ') || loading}`);
      await page.waitForFunction(() => !document.querySelector('#loading'), null, { timeout: BOOT_TIMEOUT_MS, polling: 250 });
      await frames(page, SETTLE_FRAMES);
      const tick = await page.evaluate(() => window.world.tick);
      if (tick !== shot.tick) throw new Error(`the page is at tick ${tick}, the save at ${shot.tick} (did the loop run?)`);
      const png = join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: png });
      console.log(`${shot.name}: tick ${tick} → ${png}`);
      if (shot.motionTicks || shot.motionMs) {
        if (shot.motionTicks) {
          // The loop's dev advance (rule 8: the loop decides how often the sim steps; still paused afterwards).
          await page.evaluate((n) => window.loop.advance(n), shot.motionTicks);
        } else {
          // The loop's own pause off for motionMs of real time, then on again for the shot.
          await page.evaluate(() => {
            window.game.tuning.paused = false;
          });
          await page.waitForTimeout(shot.motionMs);
          await page.evaluate(() => {
            window.game.tuning.paused = true;
          });
        }
        await frames(page, 5);
        const t2 = await page.evaluate(() => window.world.tick);
        const png2 = join(outDir, `${shot.name}-motion.png`);
        await page.screenshot({ path: png2 });
        console.log(`${shot.name}: ${shot.motionTicks ? `advanced ${shot.motionTicks} ticks` : `+${shot.motionMs} ms unpaused`}, tick ${t2} → ${png2}`);
      }
      for (const p of problems) console.warn(`  ${shot.name}: ${p}`);
    } catch (e) {
      failed++;
      console.error(`${shot.name}: FAILED: ${e instanceof Error ? e.message : String(e)}`);
      for (const p of problems) console.error(`  ${p}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
if (failed > 0) {
  console.error(`${failed} of ${shots.length} shots failed`);
  process.exit(1);
}
