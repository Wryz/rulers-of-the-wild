# Milestone 1 playtests: AC-8 and AC-9

The two acceptance criteria of Milestone 1 that only a person can pass (SPEC:905-906; docs/M1-DESIGN.md §13.1 P38).
The automated gate (AC-1..AC-7) is `npm run test:accept`; these two are run by the owner with testers and recorded at the
end of this file.

- **AC-8, the invented trap:** within an hour, a tester builds a *working* trap that is **not** in the spec's Trapping
  table (SPEC:437-450).
- **AC-9, the first environmental kill:** a first-time player gets an **environmental kill on an ape within 10 minutes**.

"Working" and "environmental" are read off the game's dev panel, not judged by eye (RT-24, below).

---

## 1. Before the session (owner, once)

1. Use **Node 22** (the repo pins it: `.nvmrc`, `engines`). Check with `node --version` (`v22.x`).
2. From the repository root:
   ```bash
   npm install
   npm run test:accept      # AC-1..AC-7 must be green before a playtest counts
   npm run dev              # the game at http://localhost:5173 (developer mode is on)
   ```
   To use another port: `npm run dev -- -- --port 5180`.
3. Open the game with a **fixed seed** so every session can be compared and replayed:
   **http://localhost:5173/?seed=1** (any integer works; write down the one you use).
   Chrome or Edge on a desktop, keyboard and mouse, sound on.
4. Check the dev keys work (developer mode only; the tester doesn't need them):

   | Key | What it does |
   |---|---|
   | **L** | opens the tuning/dev panel (right side) |
   | **P** | pauses the game; **.** steps one frame while paused |
   | **T** | cycles slow motion |
   | **H** | hit boxes on/off |
   | **Backspace** | rebuilds the world from the same seed (a fresh start) |
   | **Esc** | releases the mouse / opens Settings (every key can be rebound there) |

5. In the panel (**L**), open **Read-outs (live)**. Keep it open on the observer's screen (or glance at it after each
   attempt). The part that matters is **LAST IMPACTS (newest first)**, ten lines, for example:

   ```
   t5321 ape#2 ← entity #187 (fall) 412 J → 22.9 HP env [p1]
   t5322 KO ape#2 — environmental [p1]
   t9050 WOUND giantApe#5 shoulders 306 HP (world) [p1]
   ```

   Read a line as: tick, who was hit, what hit it (an entity number, its feature: fall, sharp point, rolling…), the
   impact's energy, the damage, `env` when the world did it, and in brackets **the credit**: the players who built,
   placed or moved that entity (`p1` is the tester; `nobody` means an untouched part of the generated world).
   **TRIPWIRES** below it lists ropes something walked into.

## 2. What the tester is told

Read this to the tester, nothing more (no tutorial, no recipes; that is the point):

> "This is an early build. You're in a valley with apes and one giant ape. You can pick things up and use them:
> **G** take or drop, hold **V** for what you can do with what you're looking at, hold **C** to place what you carry
> (mouse wheel turns it, click sets it), hold **X** to throw, **Q E** punch, **R F** kick, **Space** jump, **Shift**
> sprint, **Ctrl** crouch, **Tab** picks the next thing in reach, **1 2 3 / 4** belt and back. Click the window to
> look around with the mouse. Play however you like; think out loud."

Show them the controls once if they ask; don't suggest what to build.

## 3. AC-9: a first-time player's first environmental ape kill (10 minutes)

**Who:** someone who has never played the game (one person per run; don't reuse a tester who has seen another
session). **Seed:** `?seed=1` for the first tester, then `?seed=2`, `?seed=3`, … (record it).

**Steps (observer):**

1. Start a stopwatch when the tester first moves.
2. Watch the panel's LAST IMPACTS. **Pass** = a line `KO ape#… — environmental [...]` within 10:00. Any credit counts for
   AC-9 (the kill must be environmental, not credited). The kill cam (a slow-motion cut) also plays on an
   environmental kill: it confirms what the panel says.
3. Stop at the first environmental ape KO, or at 10:00.
4. Record (table at the end): seed, time to the kill (or "none"), how (the panel's feature: a sharp point, a fall,
   rolling, a log…), the tester's deaths, and what they tried.

**What counts as environmental** (SPEC:415): the finishing damage came from a world entity (something not held: a
falling or rolling log, a stone, a snag's sharp point, a stake), or from the ground (a fall, the ledge), or the ape was
knocked into that hazard within the last 2 s. A KO by fists or the axe in hand is **not** environmental; neither is an
ape **bleeding out** after an axe cut (the bleed is credited to nobody).

### What the tester will meet (know this; don't tell them)

- **The starter cache** at (2.5, 3) beside the spawn: a stone axe (a flint head lashed across a stick: how tools are
  made, without a recipe), a digging stick and an 8 m vine coil. **Ape home A** is 38 m away, in the direction the
  player faces at the start: the first ape arrives in the first minutes.
- **Hazards placed for this criterion** (§6.7, AC-9 pace): a **snag** (a dead log with three broken-branch points,
  sharpness 0.45) at the edge of each ape home and at the foot of the ledge; the **6 m ledge** centred at (40, −35),
  dropping into a hollow (an ape knocked off it takes ≈ 43 HP on the chest, 13 HP feet first: a brawl-weakened ape
  dies there); loose logs and stones near the spawn; boulders.
- **Why it is hard (the AC-9 risk, §4.15):** world hits on an ape are mild by design (the damage rule takes the mass of
  the struck bone, SPEC:278): a 40 kg log dropped on a downed ape does 0.2-0.5 HP; walking into snag points 0.3-1.8 HP;
  a snag rolling into its shins 4.9-7 HP; a clean knock onto the points ≈ 23 HP; a felled 30 cm trunk 48-130 HP. The
  kill usually has to be a brawl-weakened ape (≤ 20 HP) finished by the world: knocked onto a snag's points or off the
  ledge, or caught by a rolling or falling log.

### The AC-9 rehearsal's latest result (headless, non-gating; `npm run test:rehearsal`)

A scripted player (commands only) on seeds 1-8 brawls an ape at home A with the starter axe and fists to ≤ 20 HP, then
tries to finish it with the world (a flying kick onto the snag, or a ≤ 40 kg log dropped on it), within 36,000 ticks
(10 minutes). **Latest: 2 of 8 seeds** (with bleed clotting, as committed):

| Seed | Result | How / why not |
|---|---|---|
| 1 | **pass** at tick 7,463 (2:04) | a log rolling onto a bled-down ape |
| 2 | **pass** at tick 12,650 (3:31) | the snag's sharp point (22.9 HP) |
| 3 | fail, out of time (ape at 11.4 HP) | 18 falls, 6 player deaths |
| 4 | fail, out of time (ape at 11.8 HP) | 25 falls, 9 player deaths |
| 5 | fail at 11,314 | the ape **bled out** (not environmental) |
| 6 | fail at 10,449 | bled out |
| 7 | fail at 8,745 | bled out |
| 8 | fail at 14,443 | bled out |

Why the bot fails (docs/work/ledger.md, P39 and its follow-up): (1) the ape ends below the flying kick's threshold
(the kick itself takes ≈ 12 HP, so the bot kicks only while the ape has > 13 HP; a snag hit or the brawl leaves it at
0.7-12.9 HP, where nothing the bot does lands); (2) the one or two axe cuts of the brawl (2.4-9.4 HP, 3-8 minutes to
clot) are still bleeding when the ape is down to a few HP and take the last of it; (3) bot limits: a log dropped on a
downed ape is out of reach (the ape is down < 2 s and a carried load allows no blow), and while the bot fetches a log
the ape beats it to death again and again. A person adapts in ways the bot can't, so the human test still decides.

**The owner's lever decision (recorded):**
- **Lever 1** (§4.15: `SPECIES_BODY.ape.massShareMode = 'zone'`, tuning only) was **approved for apes, then
  reverted**: with it the rehearsal was no better (3/8 with clotting) and it broke an AC-2 gate (AC-2(a) staged
  deadfall: after the hit the ape's shin brushed the bait line, a `tripwire` event the gate forbids) and moved AC-2
  pins. The ape stays `'bone'`. (`ROTW_AC9_PROBE_ZONE=1` still probes it in the rehearsal.)
- **Bleed clotting was kept**: a cut's seep tapers to nothing over its clot time (`BLEED_TUNING`: a small cut clots in
  3 minutes, a stone-axe slash on an ape in 3.7-8.4 minutes). A ruler's wounds never clot (rule 9).
- **Not tried yet:** lever 2 (`CLEARING_TUNING.ledgeDropM` and the snags' sharpness), lever 3 (the property-based
  "crush rule": a zone backed by terrain counts as static, so m_eff = the impactor's mass; a TODO, not built in M1),
  and counting a bleed-out within 2 s of a world knock as the world's.

### What to watch in AC-9 (and write down)

- Does the tester **find a hazard on their own** (the snag, the ledge, a log on a slope)? How long until they first
  use the world on purpose?
- **Bleed-outs:** an ape that dies of axe cuts shows `KO` without `environmental` and doesn't pass. Note how often the
  tester's kill is "stolen" by the bleed (the rehearsal's main failure).
- **Low-HP apes:** an ape at a few HP that nothing seems to finish (the rehearsal's other failure).
- **Deaths:** how often the ape (or the giant) kills the tester, and whether it feels fair (rule 9: failure should be
  funny, not punishing; respawn is 10 s).
- **The giant's charge (X20):** with the calibrated numbers the giant's charge does 15-20 HP to a player and flings him
  only 6-7 m/s (a few metres), against SPEC:417 ("tens of thousands of joules") and rule 9 ("flung across a valley").
  Two levers exist, **off by default**: `IMPACT_TUNING.creatureRestitution` (0; at 1 the fling is 11.9-13.9 m/s) and
  `IMPACT_TUNING.unbackedTargetMassRatio` (Infinity = off; when on, 71.5-97.3 HP a charge). Note whether the tester
  finds the giant scary or harmless. Don't change them mid-session; if the owner wants to try them, it's a separate
  session (panel → Damage rule › world impacts), recorded with the result.
- **Readability (rule 3):** did they understand what they could do with things (the V radial), and why a trap did or
  didn't work (creaks, cracks, sagging covers)?

### If AC-9 fails

Write down the run, then the owner picks the next lever (§4.15 order): lever 2 (a deeper ledge, sharper snags: both
tuning, panel → World › Clearing; changing the ledge needs a new world: Backspace), then lever 3 (the crush rule:
code, its own package). Re-run the rehearsal (`npm run test:rehearsal`) and `npm run test:accept` after any lever,
since lever 1 showed a lever can break an AC-2 gate.

---

## 4. AC-8: a working trap that isn't in the Trapping table (within an hour)

**Who:** any tester (a first-timer is fine; a second session is fine). **Seed:** any; record it. **Time:** 60 minutes
from the first move.

**The Trapping table** (SPEC:437-450). A trap of one of these kinds does **not** count:
deadfall (log propped on a stick, bait on the stick) · spike pit (dug pit, stakes, a cover) · spring snare (bent
sapling, vine loop, trigger) · swinging log (log roped to a high branch, pulled back and tied) · felled tree (cut most
of the way, pulled with a rope or a last cut) · rolling boulder (levered loose on a slope) · fire line · flood · mud
trap · avalanche · funnel (log walls along a charge path) · slow fuse (a burning rope).
Fire, water, mud and snow don't exist in M1, so the last five can't happen anyway.

**What counts as "working"** (RT-24, the sim's own record, never the observer's impression): the panel's LAST IMPACTS
shows either
- an **impact with damage > 0 on a creature** (an ape or the giant) whose cause is an **entity**, with **the tester's
  credit** (`[p1]`) — e.g. `t8123 ape#3 ← entity #241 (fall) 230 J → 4.1 HP env [p1]`; or
- a **ruler wound** credited to the tester — e.g. `t20311 WOUND giantApe#5 back 612 HP (world) [p1]`.

An entity carries the tester's credit once they built, placed, moved, cut or threw it (SPEC:473). An untouched part of
the world that happens to fall on an ape shows `[nobody]` and doesn't count. Damage dealt by something **in the
tester's hands** (a swung axe) isn't a trap.

**Steps (observer):**

1. Tell the tester only: "If you can, build a trap that hurts a creature, any kind you can think of. You have an
   hour." Don't list the Trapping table; don't suggest designs.
2. Watch, and **note every attempt** (what they built, from what, how it was meant to spring).
3. When a qualifying line appears, **pause (P)**, read the cause entity's number, and check with the tester what that
   entity was part of. Take a screenshot of the panel and the scene. Then decide with the owner whether the
   arrangement is outside the Trapping table (a variation that works the same way as a listed trap, e.g. a deadfall
   with a stone instead of a log, is **still a deadfall** and doesn't count).
4. Record: seed, time, the trap in one sentence ("a stone wedged on a lashed frame, knocked loose by a rope through a
   stake"), the panel line(s), the screenshot file.
5. Optional, for a clip: panel → **Save world (download)** right after, so the moment can be re-run.

### Known limits the tester may hit (note them, don't count them against the tester)

- **The climb-out limit of a dug pit** (§4.13, RT-24): a dug wall is ≈ 79°, beyond the controller's 45°, its 0.4 m step
  and a 0.9 m jump, so a player who digs deeper than ≈ 1.3 m **can't walk out**; he digs a ramp out (strikes on the
  wall). Expected, not a bug.
- **Logs dragged across a terrain tile seam stop dead** (a known regression, ledger P28 fifth pass): the ground is made
  of 25 m tiles (seams at x or z = −75, −50, −25, 0, 25, 50, 75); a log pulled across one sticks on the next tile's
  first edge. Lift or roll it over the seam, or drag it along another line.
- **Thin dry branches on the ground twitch** and creep a few millimetres a second instead of settling (found by P38's
  perf work: 31 branches 2-4 cm thick never fall asleep). Harmless for traps, but it looks wrong (rule 3) and costs
  ≈ 3 ms a tick.
- **The giant** patrols, investigates noises, chases a seen player and charges in straight lines (it turns slowly:
  that's what funnels and pits are for). Its blows are weak for now (X20, above).
- **Covers:** a cover of rotten branches over a pit holds a careful player but breaks under the giant's foot; grass
  laid on top hides it.

---

## 5. Results (fill in)

### AC-9 runs

| Date | Tester | First time? | Seed | Time to env. ape kill | How (panel feature, credit) | Deaths | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

AC-9 passes when a first-time player gets the kill within 10:00. Record every run, passed or not.

### AC-8 runs

| Date | Tester | Seed | Time | The trap (one sentence) | Panel line(s) | Not in the Trapping table because… | Owner's ruling |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

AC-8 passes on the first run the owner rules a working trap outside the table within 60:00.

### Sign-off

- [ ] `npm run test:accept` green on the commit played (write the commit): ______
- [ ] AC-8 passed (run #__)
- [ ] AC-9 passed (run #__)
- [ ] Milestone 1 tagged `m1` (P38's last step, after both pass)
