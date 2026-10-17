// WORLD_TUNING: the world's own starting values (docs/M1-DESIGN.md §1.5.1, §9.1). A leaf module, so every system that
// reads it (deaths, minds, the spawner, queries) never imports world.ts.
import { defineTuning } from '../tuning/registry';

export const WORLD_TUNING = defineTuning(
  'WORLD_TUNING',
  'World',
  {
    clearingSize: 200,
    gravityY: -9.81,
    aiNearM: 60,
    aiFarPeriodTicks: 60,
    respawnDelayS: 10,
    spawnX: 0,
    spawnZ: 0,
    corpseDespawnS: 120,
    corpseDespawnMinDistM: 40,
    elementsPeriodTicks: 6,
    slowPeriodTicks: 60,
    // Not a §9.1 row: the chest point verbs measure range and reach from (§5.0 "pos + 1.2·scale up"), read by
    // WorldQueries.surfaceDistance and validateVerb, so the one number lives here instead of in two files.
    chestHeightM: 1.2,
  },
  {
    clearingSize: { unit: 'm', source: 'SPEC:869' },
    gravityY: { unit: 'm/s²', source: 'SPEC:618' },
    aiNearM: { unit: 'm', source: 'NEW: SPEC:698 says only "near the player"' },
    aiFarPeriodTicks: { unit: 'ticks', source: 'SPEC:698, 789 (1 Hz)' },
    respawnDelayS: { unit: 's', source: 'SPEC:421' },
    spawnX: { unit: 'm', source: 'D-33' },
    spawnZ: { unit: 'm', source: 'D-33' },
    corpseDespawnS: { unit: 's', source: 'NEW' },
    corpseDespawnMinDistM: { unit: 'm', source: "NEW: a corpse is removed only out of the player's way (RR-11)" },
    elementsPeriodTicks: { unit: 'ticks', source: 'SPEC:702 (10 Hz; M2 hook)' },
    slowPeriodTicks: { unit: 'ticks', source: 'SPEC:702 (1 Hz; M3 hook)' },
    chestHeightM: { unit: 'm × scale', source: 'NEW: §5.0 chest point (pos + 1.2·scale up) for verb range and reach' },
  },
);
