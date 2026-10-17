# Rulers of the Wild

Read `docs/SPEC.md` first, in full, before changing anything. It is the design and build
spec and the source of truth; "The Wild" in the spec is this game. Work through its Build
plan one milestone at a time, and only start a milestone when the one before it has passed
its gate.

Milestone 1's implementation design is `docs/M1-DESIGN.md` (module map, tick pipeline, rules,
verbs, creatures, tuning tables, acceptance tests, work packages). Follow it; where it is wrong,
take the option closest to the design rules and record the deviation.

## The 12 design rules (binding)

Copied word for word from `docs/SPEC.md` (Design pillars and rules). If an implementation
choice conflicts with one, the rule wins: flag the conflict in a comment or a TODO instead
of quietly breaking it.

1. **No trap is ever coded as a trap.** There is no `SpikeTrap`, `Deadfall` or `TrapType` anywhere. A trap is an arrangement of entities, materials and verbs. If a trap can't be built from the rules, change the rules, never add the trap. One exception: a snare the player is far from is resolved statistically (see Traplines); up close, every snare works by physics.
2. **One damage rule for everything.** Fists, spears, falling logs, boulders, falls and floods all go through the same energy-versus-toughness rule (see The systemic physics model). Continuous harm (fire, bleeding, drowning) is a per-second rate instead.
3. **If it looks like it should work, it works.** Every material state a rule depends on is visible: wet things look darker, dry grass looks pale, fraying rope looks frayed, tension creaks.
4. **No stat progression.** No player XP, levels, stat training or armour tiers. Progress comes from knowledge (the bestiary) and from finding better materials; materials can be better than other materials because of their properties.
5. **Rulers can't be killed with weapons alone.** This has to follow from physics: a ruler's armoured zones have a toughness threshold above the most energy a human strike can deliver, and its soft zones take only small damage from one.
6. **The sim decides outcomes.** Anything that changes the game (hits, kills, falling objects, traps, wounds, territory) is simulated in the sim package. Ragdolls, blood, gibs and particles are presentation and never change an outcome. This extends DungeonStyle's own rule that physics can never make a correct move miss. Keeping this split now is what lets the sim move to a server unchanged when multiplayer arrives.
7. **Fixed step, seeded randomness.** The simulation runs at a fixed 60 Hz (`DT` in `src/sim/math.ts`). Simulation code never calls `Math.random`; it uses the seeded `Rng`, as DungeonStyle already does.
8. **Time effects live in the game loop, not the sim.** Single-player keeps DungeonStyle's hit-pause, slow motion and camera cuts, which work by changing how often the loop steps the sim. Keep them in that one place: a shared world can't slow down, so in multiplayer they'll become replays.
9. **Failure is funny, not punishing.** Death respawns fast, built things stay standing, wounds on rulers persist, and a ruler flinging a player across a valley should be worth clipping.
10. **Everything decays.** Rope rots, wood dries and rots, structures lose integrity, and untouched objects eventually return to the Wild. That keeps a persistent world, and its save, from filling with clutter.
11. **Players never kill players.** Damage to a player from something another player built or threw can knock them down, but never kill them. This applies once multiplayer arrives.
12. **Gore is a setting.** Three levels (off, stylised, full); clips export at the player's chosen level.

## Scope

- **Single-player only.** Build nothing from Milestone 7 onward: no servers, networking or
  accounts. Do follow rules 6–8 and the spec's "What to do now so it stays cheap later"
  (outcomes in the sim, a deterministic sim, input as tick-tagged commands, time effects in
  the game loop, the save file as the world state, player ids and credit from the start).
- **Every starting value goes in a live tuning table** (like `GAME_TUNING` and
  `RAGDOLL_TUNING`), exposed in the dev panel, never as a bare constant in the code.
- Open questions in the spec are not decided: use the default listed under Risks and open
  questions, and leave a TODO that names the question.

## Layout

npm workspaces:

- `packages/sim` (`@wild/sim`): the deterministic, DOM-free simulation. Entry point
  `src/index.ts`. Never use `Math.random`, `Date.now` or other wall-clock time here; use
  the seeded `Rng` and the fixed step `DT` from `src/sim/math.ts`.
- `apps/client`: Vite + Three.js. The game loop, rendering, input, audio, UI, ragdolls,
  cinematics and clips. It imports the sim from `@wild/sim`. Player input reaches the sim
  only as tick-tagged commands (`packages/sim/src/sim/commands.ts`).

## Commands

Run everything from the repository root:

- `npm install`: install all workspaces.
- `npm test`: run every package's tests (one Vitest config, `vitest.config.ts`, with a
  project per workspace). `npx vitest run --project sim` or `--project client` runs one
  package; `npx vitest run packages/sim/tests/combat.test.ts` runs one file.
- `npm run typecheck`: TypeScript across all workspaces.
- `npm run build`: typecheck the sim, then typecheck and build the client into
  `apps/client/dist`.
- `npm run dev`: the dev server at http://localhost:5173 (developer mode is on: L opens the
  tuning panel). `?seed=N` picks the world seed; `?mode=training` adds a sparring ape next to
  the player (dev mode only).
  To pick a port, pass it through both npm hops: `npm run dev -- -- --port 5180` (or
  `npm run dev -w apps/client -- --port 5180`); with a single `--`, Vite takes the number
  as its root folder.
