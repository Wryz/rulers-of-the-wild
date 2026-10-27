# Advice from the WardedMMO session (2026-10-27)

Advisory only, from the Claude session on Wryz/WardedMMO (same owner). Not yet adopted: each item needs a design
decision and the usual review before it changes anything here. Rule 6 stands (trap outcomes stay in the sim).

## P28 (AC-2)
- **Trip cause from lost support, not a one-tick ray.** Each stance foot keeps a support set over ~0.25 s: entities (or
  terrain) whose contact carried ≥ ~10% of that foot's load. Every break event carries its source (entity + zone that
  delivered the energy). When the foot loses support, look back: (a) a support-set entity broke or moved > X → cause
  `support` (our 'cover' = support by a placed entity); (b) terrain-only support over a drop → `ledge`; (c) shin hit →
  `obstacle`; precedence a > b > c. A bearer broken by the foot's own landing counts (source = that foot); a forearm or
  blow break does not. Lab first: one foot on two bearers broken by foot impact / sustained load / side axe →
  support / support / not-support.
- **Bridge logs 539 vs 651 kg:** 539/651 = 0.828 ≈ hexagon area / circle area (0.827). The design likely used πr²L and
  the logs are 6-sided hulls. Fix in shape code for every log (equal-area circumradius ≈ 1.10 r, or a cylinder collider).
- **Deadfall:** v = √(2gh): 1.83 m/s ≈ 0.17 m of fall; ≥ 0.1 m more clearance gives ≈ 2.3 m/s. Measure v_n at the contact
  point, not the log's CoM. Springing at 700 N (lab 762 N, ratio 0.92) suggests friction creep: log |F_t|/F_n at the
  prop for 2 s with no tug; set the friction combine rule from the materials table and raise solver iterations sim-wide;
  then state the threshold as μ·N in the test. Tug back-off should be the tug verb's general behaviour.
- **2/9 stake misses:** log CoM and lowest-zone landing points against the stake grid. At 6 m/s the body travels
  ≈ v·√(2h/g) ≈ 4.3 m during a 2.5 m fall.

## P39 (AC-9 stand-in): Warded's quest bot (Wryz/WardedMMO tools/sim-cli/src/quests/{bot,main,nav,book}.ts, MIT)
- Commands only; decides from what a player could see; deterministic seed; never dies (falls counted, HP topped up).
- Stuck test once per second (< 1 m moved → stuckTicks += 30). Over 30: sidestep 3 m at angle (tick·0.618 mod 2π).
  Over 60: replan with obstacles closed; still stuck → break the nearest structure within 8 m. Unreachable target:
  attack in 90-tick bursts. Step budget with human-readable `reason` on timeout.
- Shapes: StepRun {index, kind, text, ticks, ok, reason?}; QuestRun {id, ok, ticks, falls, steps}.
- Report one line per run, `--json` for diffs, `--check` for CI, an HTML "book" for reviewers.
- For AC-9: phases approach → brawl → finish-with-world, each a step with a budget; an ordered list of finishing options;
  5–10 seeds, report the spread of time-to-environmental-KO.

## M2 (Elements): Warded's reactive terrain (ADRs 008/010)
- Per-cell Uint8 heat / moisture / fuel / vigor + surface id + regrowth timer; an active set in insertion order;
  RLE in snapshots. Order-independent pass (gather, then apply). Elements only push heat or moisture; ignition, mud,
  scorch and regrowth come from content rules plus per-surface rest values. Wind = anisotropic transfer weight.
- Contained vs spreading fire via a vigor byte (spread ∝ max(vigor/255, primed)); vigor from material state (dry grass
  high, wet grass 0).
- For 3 km: 2 m cells, allocated per loaded 64 m chunk, active set; frozen chunks catch up in closed form on thaw.
- Couple entities and cells through Entity.temperature, one exchange rule both ways.

## Creature AI (ADR 011), to compare with the ruler mind
- Brains write the player's intent path; think at 10 Hz staggered, act each tick; sight cone, LOS, a decaying threat
  table, last-seen memory. Utility selection with commitment: a challenger must win by 0.12 after ≥ 12 ticks unless
  urgent (≥ 0.95). Behaviours as modules; a creature is data.
- A content validator at load (e.g. every charge telegraph ≥ the design minimum) instead of a report line.

## Saves (M3)
- Envelope {schema, payload}; chained migrations; game code never fills defaults; keep a fixture save per old version.
- Separate world snapshot from player progress.
- Check hash(load(save(w))) == hash(w) at several ticks, including with sleeping and pinned bodies (the AC-4
  pinned-sleeping-ruler load bug); sleep state belongs in the save.

## Perf
- Warded enforces a 1 ms average tick in CI. Ours is 14.2 ms (Codex profile: loads.update 39.7%, Rapier 29.1%,
  combat.stepBody 17.8%).

## Follow-ups from the same session
- **Log mass (confirmed in our code by that agent):** `logPrism(length, r)` (factory.ts:155) is a 6-gon of circumradius r; the
  design's 651 kg is a round r 0.18 log. `prismRForRoundDiam(0.36, PHYSICS_TUNING.logFacets)` (factory.ts:162) gives
  r ≈ 0.198 and 651 kg. Check every logPrism caller whose r was a round design radius. Passed to P28.
- **loads.update cost (P38 perf):** it recomputes unchanged loads every tick (deliver → supportsOf walking contact pairs,
  `new Set(seen)` per recursion level, two passes over all entities). Proposal, bit-identical outcomes:
  1. cache resting shares per quiet chain; invalidate on wake, break, new joint, contact change, capacity change, or a
     foot entering it;
  2. keep rot working (rule 10) by re-testing quiet chains at a staggered low rate in id order, or re-testing when
     capacity crosses the cached breaking point;
  3. skip the history window for quiet entities, and keep a running sum;
  4. cheap wins first: a push/pop path array instead of `new Set(seen)`, and a maintained list of dynamic entities.
  Prove it with identical AC-7 replay hashes, then gate the timing in the CI tick budget.
