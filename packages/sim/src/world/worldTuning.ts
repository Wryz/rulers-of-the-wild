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
    // Not §9.1 rows (values the design states in prose, kept here so no file holds them as bare constants):
    // the chest point verbs measure range and reach from (§5.0 "pos + 1.2·scale up"), read by
    // WorldQueries.surfaceDistance and validateVerb;
    chestHeightM: 1.2,
    // how far above `fromY` an entity's top still counts as support (§1.5.2 GroundQuery.supportAt "below fromY + 0.5");
    supportReachM: 0.5,
    // how far above the terrain World.teleport looks for the support it lands on (a scaffold box, a log).
    teleportProbeM: 50,
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
    supportReachM: { unit: 'm', source: 'NEW: §1.5.2 GroundQuery.supportAt (an entity top below fromY + 0.5 is support)' },
    teleportProbeM: { unit: 'm above the terrain', source: 'NEW: where World.teleport starts its search for support' },
  },
);
