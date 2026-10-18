// From the repo root, on Node 22: npx vite-node tools/profile-world.mjs
// Replay AC-7's commands, time World.step phases, and hash saves/body bytes at each checkpoint.
// Output defaults to /tmp/rotw-profile (override ROTW_PROFILE_DIR); no fixtures are changed.
// Timings include wrapper overhead and host contention. Yields/checkpoints are outside stepMs.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createWorld } from '../packages/sim/src/world/world.ts';
import { serializeWorld } from '../packages/sim/src/save/serialize.ts';
import { bodyStateBytes } from '../packages/sim/src/save/bodyState.ts';

const script = JSON.parse(readFileSync(new URL('../packages/sim/tests/fixtures/ac7-script.json', import.meta.url), 'utf8'));
const output = process.env.ROTW_PROFILE_DIR ?? '/tmp/rotw-profile';
mkdirSync(output, { recursive: true });
const w = await createWorld({ seed: script.seed, scene: 'clearing', nav: 'full' });
const times = new Map();
const groups = {
  combat: ['beginTick', 'stepBody'],
  minds: ['sense'],
  verbs: ['applyCommands', 'onDown', 'syncHeld', 'codeForces'],
  downed: ['syncDown', 'postStep'],
  zones: ['pose'],
  rulers: ['preStep', 'applyShoves', 'postStep'],
  kcc: ['applyPushes'],
  joints: ['applyHeldEnds', 'poseSensors', 'postStep'],
  entities: ['applyImpulses', 'mirror'],
  physics: ['storePreStep', 'step', 'snapshotPostStep', 'drain'],
  contacts: ['process'],
  loads: ['update'],
  breaking: ['update'],
  felling: ['update'],
  deaths: ['update'],
  spawner: ['update'],
  nav: ['rebuildDirty'],
  noise: ['collect', 'fold'],
};
for (const [group, names] of Object.entries(groups)) {
  const obj = w[group];
  if (!obj) continue;
  for (const name of names) {
    const fn = obj[name];
    const stat = { ms: 0, calls: 0 };
    times.set(`${group}.${name}`, stat);
    obj[name] = function (...args) {
      const start = performance.now();
      try {
        return fn.apply(this, args);
      } finally {
        stat.ms += performance.now() - start;
        stat.calls++;
      }
    };
  }
}

let next = 0;
let stepMs = 0;
let checkpointMs = 0;
const checkpoints = [];
for (let t = 1; t <= script.ticks; t++) {
  while (next < script.commands.length && script.commands[next].tick === t) w.commands.push(script.commands[next++]);
  const start = performance.now();
  w.step();
  stepMs += performance.now() - start;
  if (t % 60 === 0 || t === script.ticks) {
    const start = performance.now();
    const save = serializeWorld(w);
    const body = bodyStateBytes(w);
    checkpoints.push({
      tick: t,
      save: createHash('sha256').update(save).digest('hex'),
      body: createHash('sha256').update(body).digest('hex'),
    });
    checkpointMs += performance.now() - start;
  }
  if (t % 200 === 0) {
    console.log(`profile tick ${t}/${script.ticks}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
writeFileSync(`${output}/checkpoints.json`, JSON.stringify(checkpoints, null, 2));
const report = {
  node: process.version,
  ticks: script.ticks,
  commands: next,
  entities: w.entities.all().length,
  stepMs,
  msPerTick: stepMs / script.ticks,
  checkpointMs,
  phases: [...times]
    .map(([name, stat]) => ({ name, ...stat, perTick: stat.ms / script.ticks, percent: (100 * stat.ms) / stepMs }))
    .sort((a, b) => b.ms - a.ms),
};
writeFileSync(`${output}/profile.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
w.dispose();
