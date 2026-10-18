# Paused again: 2026-10-18 (owner asked to stop spending tokens)

**Update:** Codex follow-ups (codex/m1-followups af34b28) reviewed and merged as b0b57d6: 99 files, 1,533 passed, 5 skipped; typecheck and build pass. Use Node 22 (Node 24 breaks the replay fixture). P28 has not been restarted.

**State:** `claude/rulers-wild-setup-3p5iba` = verified integration head a1789cc + this note; `main` = ccf9ba7 (same
tree as a1789cc). Waves 0–9 merged except P28, P29, P39, then P38 gate. AC-4, AC-5, AC-6, AC-7 pass and are verified.
SIM-fix4 (spoil at repose) merged. Open follow-ups: `docs/work/ledger.md` (search "P38", "SIM-fix4").

**Unmerged work, saved as patches in `docs/work/wip/`:**
- `P28-ac2-traps.patch` (diff vs a1789cc). AC-2: (c) swing and (d) felled tree pass; (a) bait-tug deadfall and (b)
  spike pit fail. Includes the second pass (full-rim cover, low-posture blend, backing tug) and an UNVERIFIED,
  partly done third pass (stopped just before its ledger entry and full-suite run): raise the deadfall for ≥ 0.1 m
  clearance and v_n ≥ 2; find why the prop springs at 700 N; sole-footprint ledge check; tag trips 'cover' from the
  supporting bearer's break; the 2/9 stake misses; bridge logs to 651 kg. Delete `tests/ac2.lab*.test.ts` if present.
- `P29-ac3-solo-hunt.patch` (diff vs 1c93088; its null guards are already merged via SIM-fix4). Rerun after P28.

**Resume:** branch from the integration head, `git apply --3way docs/work/wip/<name>.patch`, finish P28, rebuild the
pit scene (~12 min cold), full suite `--maxWorkers=2`, typecheck, build, independent review, merge. Then P29, P39,
P38, independent verification of every criterion, `docs/reports/m1.md`, tag m1, ask the owner before merging to
main. A Codex prompt for safe follow-ups (outside P28's files) was given to the owner; review its branch if one
appears.

---

# Paused: where the build stands and how to resume

The owner asked to pause on 2026-10-17 at about 18:45 UTC because of token usage. Everything merged is green and
pushed on `claude/rulers-wild-setup-3p5iba`.

## Where things stand
- **Milestone 0:** done. Tag `m0` is at 30c8205, but only locally: the proxy refused the tag push with HTTP 403.
  From a machine with push rights, run `git tag m0 30c8205 && git push origin m0`.
- **Milestone 1: about three quarters done.** The integration head before this note was 0943cb9:
  88 test files, 1,400 tests passing, 2 skipped; typecheck and build pass.
  - **Merged** (design packages, waves 0–7): P01–P15, P17–P21, P24, P31–P37, plus these fix packages:
    - the P09+P14 integration fix;
    - the save fix after P13;
    - SIM-fix and SIM-fix2;
    - CORE (core-fix);
    - P21's follow-ups;
    - the screenshot tool (`tools/shots`).
  - **Not merged; work in progress saved as patches in `docs/work/wip/`.** All three are unreviewed, and each patch is
    a diff against 0943cb9:
    - **`P16-review-fixes.patch`:**
      - It contains P16 (lash, tie, splice, untie, bend, pull, shape) plus its review fixes, partly done. The
        independent review asked for:
        - a one-sided rope tether in `verbs/hands.ts` `tetherHands`. Delete the `bracedHauler` test helper and use
          the real tether.
        - snapOnto safety: no snapping into a prop's foot or across a rope gap.
        - anchors projected onto surfaces;
        - one exported taut predicate;
        - tighter §11.2(c) thresholds;
        - no stamina regen while hauling;
        - JointStore.lengthen;
        - lashing with one side held.
      - Check each item against the patch before merging.
    - **`P22-spawner-devops.patch`:** the spawner (apes at their homes, the giant at its lair, the sparring ape,
      respawn rules) and every dev op as a command. Only just started.
    - **`C-fix-client-wiring.patch`:** the client wiring that makes the verb UI, HUD and kill cam live in the
      browser, plus client defects (black rim faces, the drag link, sfx, panel). Partly done. Its brief is the
      `C-fix` lines of `docs/work/ledger.md`.
- **Milestones 2–6:** not started.

## How to resume
1. Make a branch from the integration head, then `git apply --3way docs/work/wip/<name>.patch`. Finish the package
   against its brief and the ledger notes. Run `npx vitest run --maxWorkers=2`, `npm run typecheck` and
   `npm run build`.
2. Have the package reviewed by an agent that didn't write it. Fix what the review finds, then merge.
3. Delete `docs/work/wip/` once all three patches are merged.
4. **The rest of Milestone 1**, in order (docs/M1-DESIGN.md §13.2):
   - wave 8: P23, the test harness and scenes;
   - wave 9: the acceptance tests:
     - P25 AC-4 (rule 5);
     - P26 AC-5 (the trip);
     - P27 AC-6 (bodies);
     - P28 AC-2 (trap scenes);
     - P29 AC-3 (the solo hunt);
     - P30 AC-7 (determinism);
     - P39, the AC-9 stand-in;
   - wave 10: P38, the gate.
   - Then have every criterion verified independently, write `docs/reports/m1.md`, tag `m1`, and merge to main
     with the owner's permission.
5. Then do Milestones 2–6 in order, each one: design, build, independent review, report `docs/reports/mN.md`,
   tag `mN`.

## What to read
- **`docs/work/ledger.md`:** every cross-package note and decision so far. Departures from the design and spec must
  go into the M1 report. Search it for "Decisions", "departure" and "report".
- **`docs/work/journal.md`:** the orchestration log.
- **Process:**
  - Merges go through a script (copied in the ledger notes). It runs typecheck, the full test suite (re-run with
    `--maxWorkers=2` when vitest workers time out under load) and the build.
  - Never cd outside the repository in a shell while agents are creating worktrees: a worktree created outside
    the repo fails.
  - Kill dev servers by PID, never with `pkill -f`: the pattern also matches, and kills, your own shell.

## Decisions made so far (details in the ledger)
- **Entity integrity:** an entity's integrity uses its effective mass at the contact point. Hits on creatures still
  use the whole entity mass, so felled trees land whole and traps still wound rulers.
- **Tripwires:** a tripwire end's momentum is capped at its mass × the crosser's speed across the rope.
- **Giant trip:** the giant trips from the shin strike itself (legStrike), so AC-5's log works even when it breaks.
- **Stakes:** a stake knocked loose is lifted clear of the ground.
- **Coils:** flat prisms such as coils collide as Rapier cylinders. This works around a Rapier 0.21 bug with
  FIX_INTERNAL_EDGES.
- **Strikes:** an unarmed strike pushes with the striking limb's mass; an armed one with strikeMassKg × scale³.
- **Dirt piles:** `pilesNearR` is 15 m, so a pit makes 12 dirt piles.
- **Giant charge:** the giant charges on its knuckles (posture `headLow`) at the bearing to the player. The dodge
  table holds at 10, 15 and 25 m. A standing hit now does 0.9–22 HP and launches the player at 5.4–7.3 m/s.
  Whether the charge is deadly enough is a playtest question.
- **Downed slab:** a downed slab's not-clear list only shrinks after the launch, and it is saved, so falling logs
  can't pass through a lying player.
- **Art:** the owner briefly asked for a painterly look, then reverted. The spec's low-poly, faceted look stands.
