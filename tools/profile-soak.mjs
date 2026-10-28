// From the repo root, on Node 22: npx vite-node tools/profile-soak.mjs
// A headless soak of the Clearing with no commands (the P38 perf smoke's world), timing World.step and its phases.
// ROTW_SOAK_TICKS (default 36,000 = 10 min), ROTW_SOAK_SEED (default 1), ROTW_SOAK_PHASES=0 to time World.step only.
// Prints the median, mean and phase table, and hashes of the body bytes every 600 ticks and of the final save (to
// compare runs before and after an optimisation: they must be identical).
import { createHash } from 'node:crypto';
import { createWorld } from '../packages/sim/src/world/world.ts';
import { serializeWorld } from '../packages/sim/src/save/serialize.ts';
import { bodyStateBytes } from '../packages/sim/src/save/bodyState.ts';
import { Loads } from '../packages/sim/src/world/loads.ts';

const ticks = Number(process.env.ROTW_SOAK_TICKS ?? 36000);
const seed = Number(process.env.ROTW_SOAK_SEED ?? 1);
// ROTW_LOADS_VERIFY=1: the loads memos (P38) recompute every memoised answer and throw on a difference.
if (process.env.ROTW_LOADS_VERIFY === '1') Loads.verify = true;
const w = await createWorld({ seed, scene: 'clearing', nav: 'full' });
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
if (process.env.ROTW_SOAK_PHASES !== '0') {
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
}
const per = new Float64Array(ticks);
const hash = createHash('sha256');
for (let t = 0; t < ticks; t++) {
  const start = performance.now();
  w.step();
  per[t] = performance.now() - start;
  if ((t + 1) % 600 === 0) hash.update(bodyStateBytes(w));
  if ((t + 1) % 3000 === 0) console.log(`soak tick ${t + 1}/${ticks} ${per[t].toFixed(2)} ms`);
}
const sorted = Float64Array.from(per).sort();
const sum = per.reduce((a, b) => a + b, 0);
const save = createHash('sha256').update(serializeWorld(w)).digest('hex');
console.log(
  JSON.stringify(
    {
      node: process.version,
      seed,
      ticks,
      entities: w.entities.all().length,
      medianMs: sorted[Math.floor(ticks / 2)],
      meanMs: sum / ticks,
      p90Ms: sorted[Math.floor(ticks * 0.9)],
      maxMs: sorted[ticks - 1],
      saveHash: save,
      bodyHash: hash.digest('hex'),
      phases: [...times]
        .map(([n, s]) => [n, s.ms / ticks, (100 * s.ms) / sum])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([n, ms, pc]) => `${n} ${ms.toFixed(3)} ms ${pc.toFixed(1)}%`),
    },
    null,
    1,
  ),
);
w.dispose();
