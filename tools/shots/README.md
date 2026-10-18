# Test highlight screenshots (developer tool)

In-game screenshots of the highlight moments of the sim's test scenes, drawn by the real client's renderer from real
simulated worlds. Three steps, all run from the repository root:

```sh
# 1. Build the scenes: each test scene is stepped to its highlight ticks and saved (canonical saves + a manifest).
npx vite-node tools/shots/scenes.ts                 # every scene
npx vite-node tools/shots/scenes.ts pit trees       # some scenes (the others' manifest entries are kept)

# 2. Start the dev server (developer mode; the shooter needs the dev build).
npm run dev -- -- --port 5182

# 3. Shoot: headless Chromium (Playwright, WebGL on SwiftShader) opens each shot and writes a 1280×720 PNG.
node tools/shots/shoot.mjs http://localhost:5182 /path/to/pngs              # every shot
node tools/shots/shoot.mjs http://localhost:5182 /path/to/pngs ape-fight    # a scene, or a shot by name
```

Step 1 takes a few seconds; step 3 about 10-20 s a shot (SwiftShader). Typecheck the builder with
`npx tsc -p tools/shots`.

## What each step does

- **`scenes.ts`** (Node, run by vite-node, which ships with Vitest) builds each scene with the sim's public API the way
  its test does: the same `createWorld` options and seed, the factory spawners, verb and move commands for the player,
  and the tests' own creature staging (a staring ape). Rule 1 holds: a scene is entities, materials and verbs, never a
  trap type. At each highlight tick it writes the world with the sim's save writer (`serializeWorld`) to
  `tools/shots/out/<scene>-<moment>.json`, loads it back with `loadWorld` to check it, and lists it in
  `tools/shots/out/manifest.json`: scene, moment, tick, the test it mirrors (file, `describe › it` name), a one-line
  caption, a camera (position, look-at point, optional fov) and an optional second shot (`motionTicks` or `motionMs`).
  Anything a scene can't build yet is logged and listed under `skipped` with the reason (today: the hanging vine,
  which needs the joint store, P10). `tools/shots/out/` is gitignored.
- **The client's load path** (developer builds only, `apps/client/src/dev.ts` and the boot in `main.ts`) reads:
  - `?save=<url>`: fetch a canonical save and build the world with `loadWorld` (its tuning applied) instead of
    `createWorld`. The shooter passes `/@fs/<absolute path to the save>`, which the Vite dev server serves from the
    workspace.
  - `?paused=1`: the loop starts paused (the loop's own pause, `GAME_TUNING.paused`: rule 8, the sim isn't touched).
  - `?cam=px,py,pz,tx,ty,tz` (and `?fov=N`): the camera is pinned there, looking at the target (client-side only).
  - `?hud=0`: no HUD.

  All of it sits behind `import.meta.env.DEV`, which the production build replaces with `false`, so none of it is in
  the player's bundle (`apps/client/tests/shots.test.ts` checks main.ts's gate; `npm run build` then
  `grep -c 'six numbers px,py,pz' apps/client/dist/assets/*.js` finds nothing). Loading a save is creating the world:
  the client still never writes sim state (rule 6).
- **`shoot.mjs`** opens `<server>/?save=…&paused=1&cam=…&hud=0` for each shot, waits until `window.game` exists and
  `#loading` is gone, lets 30 frames render, checks the page is at the saved tick, and writes `<name>.png`. A shot with
  `motionTicks` gets `<name>-motion.png` after the loop's dev advance (`GameLoop.advance`: sim and presentation stepped
  as in play, deterministic; a hit-pause swallows some of the steps, as in play); `motionMs` instead unpauses the loop
  for that much real time (only a few ticks a second under SwiftShader). Playwright comes from
  `/opt/node-tools/node_modules` and Chromium runs with `--use-angle=swiftshader --enable-unsafe-swiftshader
  --ignore-gpu-blocklist` (no `playwright install`).

## Reading the shots

- The paused shot draws each fighter from the sim's rig at the saved tick: no ragdoll exists until the presentation
  world steps once, which only the motion shot does.
- A loaded world matches the saved one within 1 cm and 1° (`packages/sim/src/save/load.ts`), and M1's load rebuilds
  animation state fresh (docs/M1-DESIGN.md §8.3).

## Adding a scene

Add a `Scene` to `SCENES` in `scenes.ts`: copy the test's setup exactly, step to the moment, and return
`moment(w, { moment, mirrors, caption, camera })` for each highlight. Then look at every PNG: if the subject is off
frame, dark or hidden, fix the camera in the scene and shoot again.
