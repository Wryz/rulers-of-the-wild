# Codex follow-ups on current main

Base: `ccf9ba7`. Branch: `codex/m1-followups`. This is follow-up maintenance, not Milestone 1 sign-off.

## Scope and runtime

The checkout initially contained older main (`abd8e94`). Work started on a new branch from current `origin/main`, `ccf9ba7`. The P28/P29 patches and pause note were verified on `claude/rulers-wild-setup-3p5iba` by read-only Git inspection; they were not applied. Every file in the owner's do-not-touch list is unchanged from `ccf9ba7`.

Node 24.19.0 reproduces two legacy replay fixture mismatches, starting at scenario 2, tick 90. Both recorded replay tests pass on Node 22.20.0 (`2 passed | 1 skipped (3)`); the fixture and assertions were left intact. Final verification uses Node 22.20.0:

```sh
export PATH="/workspace/.tools/node22/node_modules/.bin:$PATH"
npm test -- --maxWorkers=1
npm run typecheck
npm run build
```

The Node 24 full run was stopped after diagnosing the runtime mismatch and is not counted among the required clean runs. On Node 22 with two workers, one full run passed (`99 passed`, `1533 passed | 5 skipped`) and the next failed only the existing Clearing creation CPU budget (`425.845 ms` against `< 300 ms`; `98 passed`, `1532 passed | 5 skipped`, one failure). The isolated Clearing file passed at a 173 ms median. An experimental benchmark split/warm-up did not reliably solve this and was fully reverted. The original benchmark, CPU accounting, sampling and limit remain unchanged. Final full runs use one worker to reduce resource contention.

## Tasks

| Task | Status | Change and evidence |
| --- | --- | --- |
| 1. Vitest worker RPC starvation | Done; three consecutive serial full runs passed | `098ab53`: test-only `support/yieldToVitest.ts`; rulerMind and spawner loops yield every 200 ticks; harness yields between tests and uses a yielding dig planner. `support/worldHarness.ts` drives both synchronous and asynchronous planner APIs from the same generator, preserving scene recipes. No timeout or assertion changes. Targeted: `Test Files  3 passed (3)` / `Tests  93 passed \| 1 skipped (94)`. Small-pit planner remains 268 strikes / 28,286 ticks; furnishing completed at tick 48,531, with 8 stakes and 12 grass bundles. Full-run evidence below. |
| 2. Terrain timing flake | Done | `d313a51`: `terrain.test.ts` warms three complete generation calls, then retains the existing best-of-five wall-time measurement and 20 ms limit. An event-loop turn precedes each sample. No terrain production code or threshold changed. Targeted terrain/place: `Test Files  2 passed (2)` / `Tests  40 passed (40)`. |
| 3. Non-finite place target | Done | `e7bb178`: `verbs/place.ts` refuses non-finite `at` coordinates as `noTarget` before geometry queries. `verbs.place.test.ts` covers NaN, positive infinity and negative infinity on all three axes, with no queries or object release. Same targeted 40-test run above. |
| 4. Tick cost | Partly done: profiled; optimization deferred | `55fa49a`: `tools/profile-world.mjs` replays all 1,134 AC-7 commands over 4,209 ticks, times phases and hashes save/body checkpoints. Main hotspot is protected `loads.ts`; no performance changes were made. See profiling below. |
| 5. Ledger tidy-ups | Partly done | `7fa1eae`: AC-7 header now says exactly 4,209 ticks; AC-4 comments correctly attribute the shoulder wound to the trip log after the trip tick; AC-6.1 asserts the boulder body is dynamic. `ledger.md` records fixes and deferred items. Targeted AC-6: `Test Files  1 passed (1)` / `Tests  7 passed (7)`. |

## Profiling

Run from the repository root with the validated Node runtime:

```sh
ROTW_PROFILE_DIR=/tmp/rotw-profile-node22 node_modules/.bin/vite-node tools/profile-world.mjs
```

The tool uses AC-7's real Clearing seed and command log, nav enabled, with the normal player, apes and ruler. It writes `profile.json` and `checkpoints.json` outside the repository. Phase wrappers and host contention are included in timings. Checkpoint serialization/hashing and event-loop yields are outside measured `World.step`; the script's own `meta save` inside the world step remains included.

| Phase | ms/tick | Share of measured step time |
| --- | ---: | ---: |
| `loads.update` | 5.639 | 39.7% |
| `physics.step` | 4.138 | 29.1% |
| `combat.stepBody` | 2.527 | 17.8% |
| `entities.mirror` | 0.400 | 2.8% |
| `physics.storePreStep` | 0.347 | 2.4% |
| `nav.rebuildDirty` | 0.298 | 2.1% |
| `contacts.process` | 0.086 | 0.6% |
| `physics.snapshotPostStep` | 0.083 | 0.6% |
| Whole `World.step` | **14.200** | **100%** |

This final profile ran after full validation, with no other test workers running. Timings include wrapper overhead and host contention; an earlier Node 22 profile under concurrent test load measured 18.91 ms/tick with similar phase proportions. All 71 final save/body checkpoint hashes matched that earlier Node 22 profile.

No optimization was applied, so there is no before/after optimization equivalence claim. The authoritative AC-7 test still checks sequential and interleaved world pairs, all save/body checkpoints and event digests.

Larger ideas for the owner of the load/physics systems: profile support-manifold collection and per-share span casts inside `Loads.update`; investigate reusing stable support information only with explicit invalidation for wakes, moved/broken bodies and terrain edits. Also profile Rapier's active bodies/contact workload and combat movement queries separately. Changing load cadence, contact order, solver settings or sleeping behavior is not a safe local edit: each can change load history, contacts and saved bytes. Even removing all load-system cost would leave several milliseconds per step, so a 1 ms goal needs broader profiling.

## Deferred findings

- P38 tuning-table consolidation and missing §9 rows, including `PLACE_TUNING`/`ROPE_TUNING`; renaming persisted tuning keys needs a compatibility decision.
- Numeric-constant allowlist for Recast/Detour limits and arithmetic.
- AC-7 end-to-end negative control and broader verb coverage.
- Pinned/sleeping-ruler save-format issue.
- Charge posture ramps, shin-band semantics, split AC-5 expected failures.
- Dev-op/spawn validation, pause semantics, spawn clearance and corpse clutter.
- Planner edge over-digging, capped spoil placement and unbounded spoil range. These overlap protected terrain/digging work.
- GitHub's push response reported four existing default-branch dependency alerts (two critical, two moderate). These were not investigated or changed in this scoped follow-up.
- The Clearing creation CPU benchmark is sensitive to parallel load; its original 300 ms median criterion remains unchanged.
- The noise fallback cleanup is already present on current main.
- The existing expected-failure tests for the 70 m tree lure and AC-5 rise/settle pins remain unchanged. Opt-in/recording tests retain their original gates.

No design-rule conflict was introduced. Scheduling and profiling clocks live in test/support tooling, outside `packages/sim/src`; tick order, seeded randomness, damage rules and client/sim ownership are unchanged. Placement validation remains authoritative in the sim. No new gameplay starting values were added.

## Final validation

Run 1, `npm test -- --maxWorkers=1` (exit 0):

```text
Test Files  99 passed (99)
Tests  1533 passed | 5 skipped (1538)
Duration  941.20s (transform 7.96s, setup 0ms, collect 37.83s, tests 875.63s, environment 27ms, prepare 7.82s)
```

Run 2, `npm test -- --maxWorkers=1` (exit 0):

```text
Test Files  99 passed (99)
Tests  1533 passed | 5 skipped (1538)
Duration  1043.40s (transform 10.63s, setup 0ms, collect 47.73s, tests 958.74s, environment 31ms, prepare 10.05s)
```

Run 3, `npm test -- --maxWorkers=1` (exit 0):

```text
Test Files  99 passed (99)
Tests  1533 passed | 5 skipped (1538)
Duration  975.58s (transform 10.13s, setup 0ms, collect 41.25s, tests 904.12s, environment 27ms, prepare 8.34s)
```

`npm run typecheck` exited 0 for both workspaces (`tsc --noEmit`). `npm run build` exited 0: sim typecheck, client typecheck and Vite production build. Exact build result:

```text
✓ built in 8.12s
```

The existing large-chunk warning remains. The passed test count includes two existing `it.fails` cases that failed as expected; all five existing skips remain. No tests, assertions, or timeout limits were weakened.

The browser smoke check also passed: the game title/canvas were present, seed 1 booted paused at tick 0 with five fighters and 261 entities, the loading indicator disappeared, and no uncaught page errors occurred. Reinstalling dependencies while an old Vite process ran initially caused a missing optimizer chunk; restarting Vite with `--force` fixed it. Manual gameplay, audio and frame-rate acceptance were not claimed.

Reusable cloud `install_script` and `start_skill` were saved, including the writable npm cache, Node 22.20.0 installation/activation, server restart guidance and checks. The draft is saved; publishing is a separate user action in environment settings.
