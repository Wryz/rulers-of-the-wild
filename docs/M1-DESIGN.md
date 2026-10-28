# M1-DESIGN: Milestone 1, "The Clearing" (single source of truth)

Integrated design for Rulers of the Wild Milestone 1, built on the DungeonStyle codebase in
`/home/user/rulers-of-the-wild` (npm workspaces: `packages/sim` = `@wild/sim`, `apps/client`). It merges the three
drafts `A-core.md` (sim core), `B-gameplay.md` (verbs, creatures, generation, client) and `C-feasibility.md`
(acceptance tests, measured physics) in `/tmp/claude-0/-home-user/af22c14c-9be6-54bb-9fed-8058f6dbeadf/scratchpad/design/`,
under the orchestrator brief in the same folder. Where the drafts disagreed, §12.3 states the choice and why. Where
this document and a draft differ, **this document wins**. Implementers follow it; a change to it is a design change.

**Revision 2** (after three reviews: `design/review-rules.md`, `design/review-feasibility.md`, `design/review-tests.md`).
Every finding was fixed in place or rejected with a reason; §14 lists each one by reviewer and number (`RR-n`
rules, `RF-n` feasibility, `RT-n` tests) and says what changed, plus four problems the integrator found while fixing
them (`I-n`). Revised text is not marked inline; §14 points to it.

**Conventions**
- `SPEC:N` = `docs/SPEC.md` line N (binding design rules 1-12, SPEC:60-73). `MAP/x` = the map docs in
  `/tmp/claude-0/-home-user/af22c14c-9be6-54bb-9fed-8058f6dbeadf/scratchpad/map/`. `D-n` = the ambiguity proposals in
  `MAP/spec-m1.md` §(d); the orchestrator accepted all of them (D-2 with the bone reading, D-50 as the sparring ape).
- Code citations are at RotW **HEAD `eb1bd13`** (cleanup landed: perks, shop, gauntlet, economy, coins gone;
  `packages/sim/src/body/mass.ts` holds `BONE_MASS`, `BONE_ZONE`, `HUMANOID_MASS`, `BONE_MASS_SHARE`,
  `ZONE_MASS_SHARE`; `timed()` pure). Written `combat.ts:N` for `packages/sim/src/sim/combat.ts`, `fighter.ts:N` for
  `packages/sim/src/sim/fighter.ts`, `game.ts:N` for `apps/client/src/game/game.ts`, and so on, always with the
  function name so a citation survives drift.
- Evidence tags: **[A lab: file]**, **[B lab: file]**, **[C lab: file]** = measured by that draft's lab
  (`design/lab-core/`, `design/lab-gameplay/`, `design/lab-feasibility/`; outputs in the matching `.out`);
  **[MAP x]** = measured by a map doc's lab; **[I verified: file]** = I ran it for this document in
  `design/lab-integrator/` (`fell.mjs` → `fell.out`: felling moments, rope lengths, tripwire loads, dig cone volume;
  `geom.mjs` → `geom.out`: the AC-2(c) staging reach and rope length, the AC-3 pacing distances, strike-push speeds;
  plus the AC-1 grep at HEAD: `grep -rniE trap packages/sim/src apps/client/src` returned no lines); **[I-rev ran:
  file]** = run for revision 2 in `design/lab-integrator-rev/` (`ac3_geom.ts` → `ac3_geom.out`, `ac3_lead.out`,
  `ac3_density.out`: the AC-3 player spot, trap distances and stake density with Rapier, a copy of the C lab's
  `e8_solo.ts` with the design's break-after-step stakes; `swing_light.ts` → `swing_light.out`: the verb-only swinging
  log with Rapier; `deadfall_light.ts` (+ a copy of the C lab's `e1_core.ts`) → `deadfall_light.out`: the verb-only
  deadfall with Rapier; `rev.mjs` → `rev.out`: arithmetic for moments, reach, cover loads, the ledge, the charge
  levers). Reviewer labs are cited as **[RR lab: file]** (`lab-reviewer-rules/`), **[RF lab: file]**
  (`lab-reviewer-feasibility/`), **[RT lab: file]** (`lab-reviewer-tests/`). Everything else is a design decision.
- Units: SI (m, kg, s, N, J); angles in degrees unless marked rad; `tick` = one 60 Hz sim step (`DT = 1/60`,
  `math.ts`). "Starting value" = a live tuning default (SPEC:12); every one is in §9.

**Decisions at a glance**

| Topic | Decision |
|---|---|
| World | One `World` owns the tick, id counters (fighter, entity, joint, wound), every RNG stream (seeded from the world seed), the sim's Rapier world, the terrain, entities, joints, both navmeshes and the `CombatSim`. `createWorld(opts): Promise<World>` awaits a memoised `physicsReady()`; everything after is synchronous. |
| Legacy | `new CombatSim(seed)` stays synchronous and bit-identical on flat ground: every world feature enters `CombatSim`/`Fighter`/`Footwork` through nullable seams whose defaults run today's arithmetic. Legacy tests never initialise Rapier or recast (they pay only the module import). |
| Where movement is resolved | Inside `CombatSim.separate()` through a `FighterMover` port (KCC for player/apes, `RulerMover` for the giant), so hits see resolved positions in the same tick (departure from SPEC:699-700's order, §12). |
| Damage | One rule (SPEC:275): m_eff from the struck **bone's** mass (orchestrator decision 2), v_n from pre-step velocities (kinematic zones: the previous tick's rig delta, with the history reset at every pose jump), sensor normals from `Shape.castShape` between start-of-previous-step poses, blunt hard landings with v_safe = 6·√scale whenever the creature's own motion drives the contact. A contact is new once per (creature, other owner) overlap episode. Momentum goes to sensor targets only; the solver already exchanged it for solid ones. Every impulse a contact causes is queued for the next tick. |
| Giant ape | A scale-5.5 `Fighter` with `f.ruler: RulerState`; one Rapier body for life (kinematic with 12 sensor bone colliders standing; the same body dynamic with solid colliders when tripped). Melee goes through one ruler branch in `hit()`. It stands on `supportAt` (terrain or a resting/anchored entity), so a covered pit is ground until its cover breaks; slopes over 40° and steps over 1 m block it; it is **down** while tripped **or in a pit** (SPEC:504) and climbs out slowly. |
| Downed player/ape | A sim-side dynamic rounded slab per fighter (not a capsule, which never rests on slopes). The client ragdoll follows it; no client code writes fighter state. |
| Ropes | Tension by a per-body non-negative least-squares fit over that body's taut ropes (SPEC:261's formula is its one-rope case), from the velocity Rapier returned (snapshot right after the step); parallel strands share the load. A held end hauls hand over hand (force while the load comes slower than 1.5 m/s). Tripwires load by the crossing body's root momentum. |
| Felling | Each chop removes 2 cm (stone axe, by fresh tool energy); the trunk stays fixed until the fall-direction moment beats a hinge capacity ∝ (remaining diameter)³, then hinges at the uncut edge and falls away from the cut side. |
| Loads | Computed, never pushed into the solver; feet and resting weight split in equal shares over supports; a covering passes its load down, only a spanning entity is tested; 0.2 s average vs capacity = break energy ÷ 0.1 m; a load break snaps a prism across its axis. |
| Verbs | Strikes stay `button` commands (cut and dig happen when a strike meets a tree, rope, entity or the ground); every other verb is a `verb` command with integer fields, validated by property predicates at the command, again when it starts and again when it lands, executed as a committed work action. Every AC-2 trap also has a gating variant built only from what M1's verbs can move (rule 1). |
| Creatures | `CreatureMind` per creature implements `Brain`; the ape fights with DS `BrawlerAI` + Bruiser's plan; the giant patrols, investigates, chases and makes a telegraphed, committed straight-line charge (8°/s turn). |
| Navigation | recast-navigation 0.43.1: two tiled navmeshes (human r 0.4 m, ruler r 1.65 m), fixed-count synchronous tile rebuilds per tick, positions-only paths. |
| Save | Canonical versioned JSON (`formatVersion 1`) by explicit writers in id order, plus `bodyStateBytes()` for AC-7; M1 loads terrain, entities, joints, rulers, counters, RNG states and fighter core state. |
| Tuning | Every table registers itself (`defineTuning`) with per-field unit and source, the humanoid bone masses included (`BODY_MASS_TUNING`); the dev panel is built from the registry and edits a value through a `meta 'dev' setTuning` command, so replays stay exact; §9 lists every value. |
| Client | New `GameLoop` owns every time effect (rule 8); `KillCam.onMoment` is the one kill-cam entry; follow camera in the open, DS fight camera when locked on; the training ring retires and `?mode=training` spawns a sparring ape in the Clearing (D-50); `game.ts` talks to every other client module through the interfaces of `game/ports.ts`. |

**Names (one name per concept).** World `World`; tick `world.tick` (= `combat.frame`); id counter `IdCounter`;
entity `Entity`/`EntitySpec`/`EntityStore`; material `Material`/`MATERIALS`/`MaterialId`; shape `Shape`; sharp
point `SharpPoint`; joint `JointRecord`/`JointStore`; rope end in a hand `Anchor.fighter`, lying free
`Anchor.loose`; tree progress `PlantState.cut`; cross-cut progress on a free entity `Entity.crossCut`; downed
body "slab" (`DownedBodies`); standing hit zones `ZoneBodies`; character controllers `CharacterControllers`; ruler
body `RulerBodies`/`RulerMover`; tripped state `FighterState 'tripped'`; ruler data `RulerState` (functions in
`sim/ruler.ts`); named ruler zone `RulerZoneId`; wound `WoundRecord`; world hit on a fighter `Impact`/`ImpactCause`
/`ImpactResult`; knockout `koFighter` + CombatEvent `ko`; kill-cam input `Moment`, kinds `envKill`, `worldWound`,
`rulerDeath`, `playerByRuler`; brain `Brain`/`CreatureMind`/`ApeMind`/`RulerMind`/`MindRegistry`; perception
`Senses`; noise `NoiseBus`; navigation `NavSystem`, layers `'human' | 'ruler'`; verbs `VerbSystem`/`VerbId`; tool
class `ToolClass`; tuning `defineTuning`/`TUNING`. Player ids for credit are strings (`Fighter.playerId`, `'p1'`);
a command's `player` field is the **player number** (`1` for `'p1'`; `playerIdOf(n) = 'p' + n`), which the world maps to
that player's fighter (SPEC:566); legacy `CombatSim` without a world keeps M0's reading (the fighter id).

## 1. Module map

All sim code is DOM-free, never calls `Math.random` or `Date.now`, iterates in id order, and is re-exported from
`packages/sim/src/index.ts`. No Rapier or recast call runs at module top level (MAP gap-1 §5.2.3), so tests that
import the index without creating a world pay only the module import. The WP column names the work package of §13
that owns the file (owns = the only package that edits it).

### 1.1 Dependencies

| File | Change | WP |
|---|---|---|
| `packages/sim/package.json` | add `"@dimforge/rapier3d-compat": "0.21.0"` and `"recast-navigation": "0.43.1"` (exact pins, MAP rapier §12.1, recast §10.1) | P05 |
| `apps/client/package.json` | `"@dimforge/rapier3d-compat": "^0.21.0"` → `"0.21.0"` (one copy of the WASM module for both Rapier worlds) | P05 |
| root `package.json` | add `"test:accept": "vitest run packages/sim/tests/ac"` (the acceptance files alone) and `"test:rehearsal": "ROTW_REHEARSAL=1 vitest run rehearsal"` (§11.9) | P05 |
| root `vitest.config.ts` | the `sim` project gains `globalSetup: ['packages/sim/tests/support/globalSetup.ts']` (the cached pit scene, §11.0) and excludes `**/*.rehearsal.test.ts` unless `ROTW_REHEARSAL=1`; root `.gitignore` gains `packages/sim/.cache/` | P23 |
| `package-lock.json` | regenerated once | P05 |

### 1.2 Changed sim files

| File | Change | WP |
|---|---|---|
| `sim/commands.ts` | The full M1 command union of §1.5.3 (`move` gains `flags`; `button` gains `'jump'`; `verb`; `meta`, including `meta 'dev' setTuning`); `player` is the player number (§1.5.3); `CommandQueue.push` also keeps only the newest `focus` verb per tick and player. | P01 |
| `sim/math.ts` | `Rng` gets a `state` accessor and a uint32 wrap (`this.s = (this.s + 0x6d2b79f5) >>> 0`), output-identical to today for the first 4,917,759 draws of a stream (MAP gap-7 §4; re-run for 2 × 10⁶ draws from four seeds **[RF lab: r1_rng.mjs]**); `seedFor`. | P02a |
| `sim/fighter.ts` | World-owned ids (`IdCounter`, `LEGACY_IDS`), optional rng seed; the M1 fields of §1.5.3; `FighterState` += `'tripped'`; `enterGetup(frames, keys)`; `startWork`; `updatePose` runs FK only for `'tripped'`; `boneShare` computed at construction from `BODY_MASS_TUNING` (P02a). `weaponFit` (fighter.ts:527) and `heightGap` (:580) measure the target height relative to `this.pos.y` and read `verbAim` when set and not locked on; `canReach` (:566) likewise (P02b). | P02a, P02b |
| `body/mass.ts` | `BONE_MASS` becomes the live table `BODY_MASS_TUNING.boneKg` (registered, folder "Creatures › bodies"; the same exported object, so `ragdoll.ts:7`'s import and the client ragdoll keep reading it). Code computes shares through `humanoidMass()`, `boneMassShares()`, `zoneMassShares()` from the table at call time (same arithmetic, so the default numbers are bit-identical). `HUMANOID_MASS`, `BONE_MASS_SHARE`, `ZONE_MASS_SHARE` stay exported as read-outs of the default table, so `tests/mass.test.ts` is unchanged, and no sim code reads them (a grep test in P02a) (RR-2). | P02a |
| `sim/roster.ts`, `sim/enemies.ts` | `createPlayer(opts?)` and `createEnemy(kind, rng, mods?, baseAi?, opts?)` take `{ ids?, rngSeed? }`. | P02a |
| `sim/combat.ts` | Seams only (§1.5.2). **P02a** (legacy-identical core): `beginTick`/`stepBody`; `mover`, `ground`, `world`, `physicsOwnsDowned` (renames `externalKnockdown`, combat.ts:258; `externalKnockdown` stays as a deprecated accessor alias until P31 deletes its last writer, game.ts:181), `playerFighter`; `koFighter` at every KO site; `blowDamage` extracted from `hit()` (combat.ts:1113); toughness line; `lastKnock` at DS knockback sites; ground height at every y = 0 site (§4.1). **P02b** (world-mode readers): ruler branch call; world-mode projectile rule path (skipping the 2-D walkable wall test, §4.1); `drive`, `moveFlags`, `load`, `work`, `verbAim`, `throwAim` readers; `autoDefend` skipped while carrying or dragging; no strikes with a carried non-tool load; punch presses become `pull` while a rope end is held (§5.12); `separate()`'s ruler skip (§4.4); the `fatal`/`sever` gate on `E > T` (§4.4); the TODO hooks of §12.4. | P02a, P02b |
| `sim/ai.ts` | `interface Brain` (with `cfg: AIConfig`, so `sim.ais.get(e)!.cfg` in styles.test.ts:182 and size.test.ts:98 still type-checks); `BrawlerAI implements Brain`; `CombatSim.ais: Map<Fighter, Brain>`. | P02a |
| `sim/weapons.ts` | `WeaponDef.sharpness?: number` (P02a); then the eight primitive `WeaponId`s, `WEAPONS` templates, `GORE` rows and `WEAPON_MOVES.throwSpear` (P14, append-only). | P02a, P14 |
| `body/footwork.ts` | `Body.ground?: GroundQuery \| null`; ground height at footwork.ts:75 (`toWorld`), :130 (`syncToRig`), :60 (`toLocal`), :375 (`localTarget`); optional `FootworkStyle.limp`. | P02a |
| `body/idle.ts` | `IdleBehavior` honours `Fighter.idlePaused` (no weight shift, look-around, feint or breathing). | P02a |
| `body/poses.ts` | `POSE_SPECS` += `carryFront`, `carryShoulder`, `dragBack`, `haulRope`, `workLow`, `workKnap`, `digScoop`, `aimThrow`, `crouch`, `headLow`, `sniff`, `climbOut` (all M1 poses, including the giant's). | P14 |
| `body/animator.ts`, `sim/ai.ts`, `sim/fighter.ts`, `body/footwork.ts`, `body/idle.ts` | Append-only `toRecord()`/`restoreRecord()` accessors for the save (§8.3), after P02b. | P04 |
| `world/collision.ts`, `arena/themes.ts` | **Unchanged.** `Walkable`, `RectWalkable`, `ArenaWalkable` and the arena shape data stay as flat-ground fixtures for the legacy tests (D-15); nothing in world mode uses them. TODO "move arena fixtures to tests/support" (M3). | — |

### 1.3 New sim files

| File | Responsibility | WP |
|---|---|---|
| `world/types.ts` | Every data type shared across files (§2): `V3`, `Quat`, `Pose3`, `Shape`, `SharpPoint`, `Material`, `Entity`, `EntitySpec`, `PlantState`, `Anchor`, `JointRecord`, `Inventory`, `Drive`, `Posture`, `Work`, `ImpactCause`, `Impact`, `ImpactResult`, `KnockRecord`, `Finish`, `RulerZoneId`, `RulerState`, `WoundRecord`, `SevereEffect`, `SpeciesId`, `GroundQuery`, `FighterMover`, `WorldPort`, `WorldStrike`, `ProjectileWorldHit`, `Owner`, `QueryFilter`, `Hit`, `WorldEvent`. | P01 |
| `tuning/registry.ts` | `defineTuning`, `TUNING`, snapshot/restore, overrides, `setTuningValue` (the `meta 'dev' setTuning` command's effect). | P01 |
| `sim/ruler.ts`, `sim/impact.ts` | Created by P01 as placeholders with their final exported signatures (§1.5.5) and their tuning tables registered with the §9 values, so `combat.ts` (P02b) can import `rulerVolumes` and `RULER_TUNING.lockScale` before P11 exists; the placeholder functions throw `not implemented` and are reached only when a ruler exists (RF-8). | P01 (stub) → P09, P11 |
| `sim/rules.ts` | `DAMAGE_TUNING`, `MOVE_TUNING`, `hpFromEnergy`, `launchSpeed`, `zoneToughness`, `boneMass`, `reducedMass`, `impactEnergy`. | P02a |
| `world/materials.ts` | `MATERIALS` (16 rows) and property predicates. | P03 |
| `world/shapes.ts` | Volume, collider descriptors, triangulation for nav input, fracture, cross-cut. | P03 |
| `sim/species.ts` | `SPECIES_BODY` (body data per species). | P03 |
| `world/world.ts` | `createWorld`, `World`, `WorldOptions`, the tick pipeline (§3). | P05 |
| `world/worldTuning.ts` | `WORLD_TUNING` (a leaf module, so systems that read it never import `world.ts`). | P05 |
| `world/physics.ts` | `physicsReady()`; `PhysicsWorld`: Rapier world, event queue, collider → owner map, pre-step store with one tick of pose history, sorted drain; `PHYSICS_TUNING`. | P05 |
| `world/groups.ts` | Collision and solver group bits (§2.11). | P05 |
| `world/rngs.ts` | `WorldRngs` (named streams from `seedFor`). | P05 |
| `world/queries.ts` | `WorldQueries` (ray/shape/overlap queries; never exposes handles). | P05 |
| `world/terrain.ts` | `Terrain`: heightfield tiles, exact `heightAt`/`normalAt`/`supportAt`, lower/raise kernels, spoil search, edits; `TERRAIN_TUNING`. | P05 |
| `world/entities.ts` | `EntityStore`: create/remove in id order, bodies from shapes, anchoring, `isAnchored`, impulse queue, record mirror, `touched`. | P06 |
| `world/factory.ts` | Entity-spec factories shared by generation, test scenes and dev spawns. | P07 |
| `world/characters.ts` | `CharacterControllers` (`FighterMover` for player and apes): KCC capsule, 500 N push, jump/fall/landing, teleport, tether hook; `CHARACTER_TUNING`. | P08 |
| `world/zones.ts` | `ZoneBodies`: kinematic body + 12 bone sensor colliders per standing player/ape; pose history. | P08 |
| `world/downed.ts` | `DownedBodies`: the slab per player/ape; launch, follow, settle, stand-spot search, hand-back; `DOWNED_TUNING`. | P08 |
| `world/contacts.ts` | `ContactSystem`: new contacts from events, owners, per-(creature, owner) touching counts and episodes, grace windows, normals, v_n, dedupe, dispatch (phase 9). | P09 |
| `world/damage.ts` | Pure rule functions for world contacts: m_eff by pair kind, sharpness leading test, hard landing, the self-motion split. | P09 |
| `sim/impact.ts` | `applyImpact`, environmental classification, credit; `IMPACT_TUNING`. | P09 (P01 stub) |
| `world/deaths.ts` | `Deaths`: parts, corpse timers, player death and respawn. | P09 |
| `world/devOps.ts` | `applyDevOp(w, cmd)`: every `meta 'dev'` op (spawn ape/giant, give tool, teleport, pause minds, kill creature, respawn player, setTuning), applied in phase 1c (RF-19). | P05 (stub) → P22 |
| `sim/ruler.ts` | Ruler volumes, zone classifier, `RulerState` functions (damage, wounds, recovery, finishing, down), `rulerHit`; `RULER_TUNING`, `RULER_ZONE_TUNING`. | P11 (P01 stub) |
| `world/rulerBody.ts` | `RulerBodies` and `RulerMover` (support, slope and step limits, climb, shove, block, deflect, trip, ledge, cover), trip switch, tripped rig, in-pit, pinned, get-up; `RULER_BODY_TUNING`. | P11 |
| `world/joints.ts` | `JointStore`: lash, hinge, rope, bend, held ends (haul model), rope sensors, NNLS tension, strands, snaps, tripwire loads; `JOINT_TUNING`. | P10 |
| `world/breaking.ts` | `Breaking`: integrity loss, split into pieces, piece grace; `BREAK_TUNING`. | P10 |
| `world/loads.ts` | `Loads`: foot loads, resting loads, equal-share spreading, 0.2 s average vs capacity; `LOAD_TUNING`. | P10 |
| `world/felling.ts` | `Felling`: chops, hinge capacity, fall-direction moment, fall, hinge tear, felled; `FELL_TUNING`. | P10 |
| `world/nav.ts`, `world/navInput.ts` | `NavSystem` (two tiled navmeshes, dirty queue, fixed-count rebuilds, path API), `NavWalkable`, input geometry; `NAV_TUNING`. | P12 |
| `world/cover.ts` | `GroundCover`: the 2 m ground-cover grid. | P21 |
| `world/clearing.ts` | `generateClearing` and `ClearingSpawnData`; `CLEARING_TUNING`. | P21 |
| `world/verbs/index.ts` | `VerbSystem`: command validation (phase 1b), buffer, `tryVerb`/`completeWork`, continuous verbs, held-entity sync, code forces, `tether`, `onDown`. | P14 |
| `world/verbs/targets.ts` | `verbsFor` (radial options) and `validateVerb` (shared by sim and client). | P14 |
| `world/verbs/tools.ts` | `HeldShape`, `toolClass`, `synthWeapon`, `freshChopEnergy`, predicates. | P14 |
| `world/verbs/hands.ts` | take, drop, stow, draw, carry, drag, forced release, credit. | P14 |
| `world/verbs/tuning.ts` | `VERB_TUNING`, `TOOL_TUNING`. | P14 |
| `world/verbs/strike.ts`, `cut.ts`, `dig.ts` | `WorldPort.strike`, projectile world hits and landings, chop, cross-cut, sever, push, strike-dig, hand-dig, spoil. | P15 |
| `world/verbs/lash.ts`, `bend.ts`, `pull.ts`, `shape.ts` | lash/tie/splice/untie, bend, pull and yank, shape and knap. | P16 |
| `world/verbs/place.ts`, `throw.ts` | place (three orientations, driving stakes), throw (projectile and Rapier paths). | P17 |
| `world/creatures/defs.ts` | `CREATURE_TUNING`, `NOISE_TUNING`. | P18 |
| `world/creatures/noise.ts`, `perception.ts` | `NoiseBus`; `Senses` (sight, hearing, awareness, memory). | P18 |
| `world/creatures/mind.ts`, `pathFollow.ts`, `apeMind.ts`, `factory.ts` | `CreatureMind`, `MindRegistry`, test scripts; `PathFollower`; `ApeMind`; `createCreature`. | P19 |
| `world/creatures/rulerMind.ts` | `RulerMind`. | P20 |
| `world/creatures/spawner.ts` | `Spawner`: ape homes, respawns, the giant's lair and route, the sparring ape. | P22 |
| `save/canonical.ts`, `schema.ts`, `serialize.ts`, `bodyState.ts`, `load.ts` | Canonical writer, `SaveV1`, world serialiser, AC-7 body bytes, partial loader and migrations. | P13 |

### 1.4 Client files (`apps/client/src`)

| File | Status | Responsibility | WP |
|---|---|---|---|
| `main.ts`, `dev.ts` | changed | Boot: `await physicsReady()`, `createWorld({ seed, scene: 'clearing', sparringApe })`, `Game.create`, panel, `loop.start()`; `?seed=N` (else a random uint32 from `crypto.getRandomValues`), `?mode=training` → `sparringApe: true`. | P31 |
| `game/loop.ts` | new | `GameLoop`: input → commands, accumulator, hit-pause, slow motion, cinematic time scale, pause, hidden-tab pause (rule 8). | P31 |
| `game/game.ts` | rewritten | `Game`, the presenter: owns views, the presentation world, `present(step)`, death/respawn flow, `render()`. Calls every other client module only through the interfaces of `game/ports.ts`. | P31 |
| `game/ports.ts` | new | The interfaces of everything `game.ts` calls, the changed DS modules included (`CinematicsPort`, `CameraRigPort`, `CutoutPort`, `FighterViewPort`, `RagdollPort`, `HudPort`, `SfxPort`, `PanelPort`, …; §10.1); later packages implement adapters in their own files (RF-9). | P31 |
| `game/killcam.ts`, `game/moments.ts` | new | `KillCam.onMoment`, moments from events (§10.3). | P36 |
| `game/presentationWorld.ts` | new | Presentation Rapier world: terrain and entity mirrors, ragdolls with LOD. | P33 |
| `render/terrainView.ts`, `forestView.ts`, `entityViews.ts`, `ropeView.ts`, `grassView.ts`, `sky.ts` | new | The Clearing on screen; `RENDER_TUNING` in `terrainView.ts`. | P32 |
| `render/highlight.ts`, `ghost.ts`, `aimArc.ts` | new | Target outline, placement ghost, throw arc. | P35 |
| `render/markers.ts` | new | `?`/`!` awareness markers. | P36 |
| `render/followCam.ts`, `cameraDirector.ts` | new | Open-world camera; follow ↔ fight blend. | P34 |
| `render/cameraRig.ts`, `cinematics.ts`, `cutout.ts` | changed | Ground-relative heights and floors, terrain/trunk line of sight, far plane 600 m, cutout focus at ground + 1 m. | P34 |
| `render/fighterView.ts`, `looks.ts`, `weaponView.ts` | changed | Species palettes, `scar()`, tools drawn from their entities, `lookForSpecies`. | P32 |
| `render/blood.ts`, `gibs.ts`, `particles.ts` | changed | `ground(x, z)` floors, stains on the terrain normal. | P33 |
| `body/ragdoll.ts` | changed | Down-follow toward the sim slab, launch from the sim's `launch` event, slots owned by the presentation world (D-42), LOD. | P33 |
| `input/bindings.ts`, `input/input.ts` | changed | New actions, holds/releases, wheel, pointer lock, pad axes and buttons (§5.14). | P35 |
| `input/verbInput.ts`, `input/targeting.ts` | new | The only producer of commands; client-side targeting. | P35 (stub by P31) |
| `ui/hud.ts`, `ui/compass.ts` | changed / new | Minimal HUD, hands strip, compass, target bar, death banner. | P36 |
| `ui/radial.ts`, `ui/settings.ts` | new / changed | Verb radial; new settings rows. | P35 |
| `game/prefs.ts` | changed | A "hold to crouch" pref; `cues` stays `false` by default (realism.test.ts). | P35 |
| `feel/audio.ts` | extended | New procedural sounds; `ImpactSound` rename; `FEEL_TUNING`. | P37 |
| `debug/panel.ts` | rewritten | Built from the tuning registry; dev ops as `meta 'dev'` commands; read-outs. | P37 |
| `arena/themeView.ts` | **deleted** | The training ring retires (D-50). | P31 |
| `tests/arenas.test.ts` | **retired** | SPEC:863. | P31 |
| `tests/inputRouting.test.ts` | extended | Guards: no client write of fighter state; commands only via `world.commands`. | P31 |

### 1.5 Public APIs (TypeScript)

#### 1.5.1 World (`world/world.ts`, P05)

```ts
export interface WorldOptions {
  seed: number;                          // uint32; every RNG stream derives from it (§8.1)
  scene?: 'clearing' | 'empty';          // 'empty' = flat terrain (heights 0), no props, no creatures (tests build scenes)
  terrain?: 'generated' | 'flat';        // default 'generated' for 'clearing', 'flat' for 'empty'
  size?: number;                         // m, default WORLD_TUNING.clearingSize (200)
  nav?: 'full' | 'off';                  // 'off' for physics-only tests (saves ~1-1.5 s per world, MAP recast §6)
  player?: boolean;                      // spawn the local player, player number 1 = playerId 'p1' (default true)
  sparringApe?: boolean;                 // dev ?mode=training: an ape 3 m in front of the player (D-50)
}
export const playerIdOf = (n: number): string => `p${n}`;   // player number → credit id (SPEC:566)
export function physicsReady(): Promise<void>;                   // memoised RAPIER.init() + recast init() (world/physics.ts)
export function createWorld(o: WorldOptions): Promise<World>;
export interface StepResult { combat: CombatEvent[]; world: WorldEvent[]; save: Uint8Array | null }
export interface WorldIds { fighter: IdCounter; entity: IdCounter; joint: IdCounter; wound: IdCounter }

export class World {
  readonly seed: number;
  readonly ids: WorldIds;
  readonly rngs: WorldRngs;
  readonly physics: PhysicsWorld;
  readonly queries: WorldQueries;
  readonly terrain: Terrain;
  readonly cover: GroundCover;
  readonly entities: EntityStore;
  readonly joints: JointStore;
  readonly breaking: Breaking;
  readonly loads: Loads;
  readonly felling: Felling;
  readonly combat: CombatSim;            // seeded seedFor(seed, 'combat'); mover, ground, world, physicsOwnsDowned set
  readonly kcc: CharacterControllers;
  readonly zones: ZoneBodies;
  readonly downed: DownedBodies;
  readonly rulers: RulerBodies;
  readonly contacts: ContactSystem;
  readonly deaths: Deaths;
  readonly verbs: VerbSystem;
  readonly minds: MindRegistry;
  readonly noise: NoiseBus;
  readonly spawner: Spawner;
  readonly nav: NavSystem | null;
  readonly commands: CommandQueue;       // === combat.commands
  readonly events: WorldEvent[];         // this tick's world events (cleared at the start of step)
  player: Fighter | null;
  readonly players: Map<number, Fighter>;   // player number → fighter (the same Fighter object across respawns)
  get tick(): number;                    // === combat.frame
  step(): StepResult;                    // one tick, §3
  addFighter(f: Fighter, brain?: Brain | null): void;   // combat.add + bodies, in creation order (= id order)
  removeFighter(f: Fighter): void;
  spawnCreature(kind: 'ape' | 'giantApe', at: { x: number; z: number }, yaw?: number): Fighter;  // createCreature (P19)
  teleport(f: Fighter, x: number, z: number, yaw?: number): void;   // the KCC sweep is skipped for one tick (MAP gap-1 §3.6);
                                                                     // zone/ruler pose history reset + contact grace (§4.3)
  addEntity(spec: EntitySpec): number;   // body created now; visible to queries after the next physics step
  removeEntity(id: number): void;
  mover: FighterMover;                   // dispatcher: f.ruler ? rulers.mover : kcc
  dispose(): void;                       // frees both recast navmeshes and queries (explicit destroy()) and the Rapier
                                         // world (world.free()); the harness calls it in afterEach, the client before a
                                         // Backspace rebuild (RF-24)
}
// world/worldTuning.ts
export const WORLD_TUNING: { clearingSize: number; aiNearM: number; aiFarPeriodTicks: number; respawnDelayS: number;
  spawnX: number; spawnZ: number; corpseDespawnS: number; corpseDespawnMinDistM: number; elementsPeriodTicks: number;
  slowPeriodTicks: number; gravityY: number };
```

#### 1.5.2 CombatSim seams (`sim/combat.ts`, P02a; the readers P02b)

```ts
export class CombatSim {
  mover: FighterMover | null = null;          // null: walkable.resolve + pos.y = 0 (legacy, combat.ts:794-795)
  ground: GroundQuery = FLAT_GROUND;
  world: WorldPort | null = null;
  physicsOwnsDowned = false;                  // was externalKnockdown (combat.ts:258); set only by World
  /** @deprecated alias of physicsOwnsDowned, kept until P31 removes game.ts:181's write (RF-8). */
  get externalKnockdown(): boolean; set externalKnockdown(v: boolean);
  playerFighter: ((player: number) => Fighter | undefined) | null = null;   // null: M0's find-by-fighter-id (combat.ts:318)
  readonly ais: Map<Fighter, Brain>;          // Brain carries cfg: AIConfig (styles.test.ts:182, size.test.ts:98)
  beginTick(): Command[];                     // events.length = 0; frame++; move/button commands applied in queue order;
                                              // director.frame = frame; returns verb and meta commands in queue order
  stepBody(): CombatEvent[];                  // retarget … stepProjectiles, DS order (combat.ts:296-312)
  step(): CombatEvent[];                      // = beginTick(); stepBody() — the legacy path, bit-identical to HEAD
  koFighter(d: Fighter, finish: Finish): void;   // the only way into 'ko' (§4.4)
}
export const FLAT_GROUND: GroundQuery;        // heightAt = () => 0, no supportAt
export function blowDamage(a: Fighter, d: Fighter | null, m: MoveDef, power: number, haft: boolean, thrown: WeaponDef | null): number;
  // the perk-free DS damage of hit(), same operations in the same order (defense 0 when d is null)
```

`world/types.ts` (P01) holds the seam interfaces:

```ts
export interface GroundQuery {
  heightAt(x: number, z: number): number;                         // terrain only
  supportAt?(x: number, z: number, fromY: number): number;        // terrain or a fixed/anchored/resting entity below fromY + 0.5
}
export interface FighterMover {
  /** f.pos holds this tick's proposal (locomote + separate's push). Resolve it in place, y included.
   *  Called once per standing fighter per tick, in combat.fighters order, at the separate() site. */
  resolve(f: Fighter, radius: number, propPad: number): void;
}
export interface WorldStrike {
  point: Vector3; normal: Vector3; owner: Owner;
  effect: 'chop' | 'crossCut' | 'sever' | 'dig' | 'push' | 'clang';
  reaction: { mode: 'stick' | 'rebound'; hold: number; retract: number };
}
export interface ProjectileWorldHit { point: Vector3; normal: Vector3; owner: Owner; toi: number }
export interface WorldPort {                          // implemented by World; null in legacy
  strike(a: Fighter, prev: readonly Vector3[] | null, pts: readonly Vector3[], offs: readonly number[], w: WeaponDef | null): WorldStrike | null;
  tryVerb(f: Fighter): void;                         // after tryPickup, every tick (§5.0)
  completeWork(f: Fighter): void;                    // advancePickup at stateFrame === work.actAt
  throwRelease(f: Fighter, m: MoveDef): boolean;     // true: a big object launched as a Rapier body (no DS projectile)
  projectile(p: Projectile, from: Vector3, to: Vector3): ProjectileWorldHit | null;
  onProjectileLanded(p: Projectile): boolean;        // true: it became an entity again (no DS drop)
  onKO(d: Fighter, finish: Finish): { environmental: boolean; credit: string[] };   // classification (sim/impact.ts) + parts/death
  onWeaponDropped(f: Fighter): boolean;              // true: handled as an entity (no DS drop)
  rulerHit(a: Fighter, d: Fighter, m: MoveDef, point: Vector3, dir: Vector3, zone: HurtZone, bone: BoneName,
           power: number, haft: boolean, thrown: WeaponDef | null, ruleDamageHp: number | null): void;   // §4.6
}
```

#### 1.5.3 Fighter fields and commands (`sim/fighter.ts`, `sim/commands.ts`)

```ts
export class IdCounter { constructor(start = 1); next: number; take(): number }
export const LEGACY_IDS: IdCounter;                  // the old module-level counter (fighter.ts:114); legacy numbering unchanged
export interface FighterOpts { ids?: IdCounter; rngSeed?: number }   // rngSeed default: id * 7919 + 13 (fighter.ts:256)
// new Fighter(team, name, moves, stats?, style?, opts?: FighterOpts)
export type FighterState = /* DS states */ | 'tripped';
export const GETUP_FRAMES = 40;
// Fighter, new public fields (defaults reproduce DS):
massKg: number | null;                  // null: HUMANOID_MASS * scale ** 3
get mass(): number;
boneShare: Readonly<Record<BoneName, number>>;  // default boneMassShares() at construction (BODY_MASS_TUNING, mass.ts)
toughnessJ: number;                     // species hide toughness (0 human, 0 ape); rulers use RulerState zones
species: SpeciesId | null;
playerId: string | null;                // 'p1' for the local player
lastKnock: KnockRecord | null;
armour: Partial<Record<HurtZone, number>>;      // J added per zone (hide 20, bone 40; SPEC:885)
ruler: RulerState | null;
ground: GroundQuery | null;             // set by CombatSim.add when sim.ground !== FLAT_GROUND
inventory: Inventory | null;            // players only
load: { massKg: number; mode: 'carry' | 'drag' | 'rope' } | null;   // derived by VerbSystem when the hands change
drive: Drive | null;                    // the giant's locomotion (and scripted charges)
posture: Posture | null;                // upper-body pose blended over the animation
work: Work | null;                      // a committed work action (state 'pickup')
verbRequest: { cmd: VerbCommand; frames: number } | null;
verbAim: Vector3 | null;                // a focused world point: strikes aim at it when not locked on
throwAim: { dir: Vector3; speedFrac: number; techSpeed: number } | null;   // release() launches at launchSpeed(m, techSpeed) × speedFrac
moveFlags: number;                      // MOVE_SPRINT | MOVE_CROUCH
jumpRequest: number;                    // frames left on a buffered jump (MOVE_TUNING.jumpBufferFrames, 6)
idlePaused: boolean;                    // AC-5's "AI paused" freezes idle life too (§12)
enterGetup(frames?: number, keys?: TrackKey[]): void;   // default DS track (fighter.ts:658)
startWork(w: Work): void;               // state 'pickup', stunFrames = w.frames, work = w

// sim/commands.ts (P01): all fields integers (except setTuning's value), so a command log is exact JSON.
// `player` is the player number (1 = 'p1'); the world maps it to that player's fighter (World.players, RR-18).
export const MOVE_SPRINT = 1, MOVE_CROUCH = 2;
export const AIM_STEPS = 4096;                                  // 1/4096 turn = 0.088°
export type CommandButton = Button | 'pickup' | 'jump';
export type VerbId = 'focus' | 'take' | 'drop' | 'stow' | 'draw' | 'place' | 'throw' | 'lash' | 'tie' | 'untie'
  | 'bend' | 'shape' | 'cut' | 'dig' | 'pull';
export interface VerbCommand {
  tick: number; player: number; kind: 'verb'; verb: VerbId;
  target: number;                       // entity id; 0 = none / the ground (with `at`)
  second?: number;                      // lash, bend
  at?: [number, number, number];        // world point in whole cm (anchor on target, place position, dig/shape/focus point)
  at2?: [number, number, number];       // anchor on `second`
  yaw?: number;                         // 0..255 (1/256 turn)
  pitch?: number;                       // 0..255: 0 lying, 64 upright, 32 angled
  aim?: [number, number];               // throw yaw, pitch in 1/AIM_STEPS turn
  charge?: number;                      // 0..255: throw strength; continuous verbs: > 0 on, 0 off
  slot?: number;                        // stow/draw: 0..2 belt, 3 back
  drive?: number;                       // place: absent = drive iff the object has a sharp point at its top end; 1 = drive; 0 = never
}
export type DevOp = 'spawnApe' | 'spawnGiant' | 'giveTool' | 'teleport' | 'pauseMinds' | 'killCreature' | 'respawnPlayer'
  | 'setTuning';
export interface MetaCommand { tick: number; player: number; kind: 'meta'; meta: 'pause' | 'save' | 'timeAway' | 'dev';
  seconds?: number;
  dev?: { op: DevOp; args: number[]; tuning?: { table: string; key: string; value: number | boolean | string } } }
  // setTuning: applied in phase 1c of its tick through registry.setTuningValue, so live tuning is in the command log
  // and a replay of the log reproduces it (RR-17); `key` is a dotted path for nested tables ('ape.vSafe').
export type Command =
  | { tick: number; player: number; kind: 'move'; dir: number; speed: number; flags?: number }
  | { tick: number; player: number; kind: 'button'; button: CommandButton }
  | VerbCommand | MetaCommand;
```

#### 1.5.4 Rules shared by CombatSim and the world (`sim/rules.ts`, P02a)

```ts
export const DAMAGE_TUNING: { kS: number; K: number; meleeJPerDmg: number; throwCapJ: number; leadingCos: number;
  tipRadiusM: number; impactCooldownTicks: number; minImpactJ: number; hardLandingBluntOnly: boolean;
  zoneGraceTicks: number };
export const MOVE_TUNING: { sprintMul: number; sprintStaminaPerS: number; sprintMinStamina: number; crouchSpeedMul: number;
  jumpStamina: number; jumpBufferFrames: number; carrySpeedPerKg: number; carrySpeedMin: number; carryRegenPerKg: number;
  carryRegenMin: number; carryNoSprintKg: number; dragSpeedMul: number; pullWalkMul: number };
export function hpFromEnergy(E: number, T: number): number;          // max(0, E − T) / DAMAGE_TUNING.K
export function launchSpeed(massKg: number, techSpeed: number): number;   // min(techSpeed, √(2·throwCapJ/m)) (SPEC:285)
export function zoneToughness(d: Fighter, zone: HurtZone): number;  // d.toughnessJ + (d.armour[zone] ?? 0); d.armour is
  // derived when worn items change: Σ MATERIALS[item.material].armourJ over the items covering the zone (RR-3)
export function boneMass(d: Fighter, bone: BoneName): number;       // d.mass × d.boneShare[bone] (or the HurtZone sum, §4.3)
export function reducedMass(m1: number, m2: number): number;         // m1·m2/(m1+m2); Infinity-safe (a static side → the other mass)
export function impactEnergy(mEff: number, vn: number, s: number): number;   // ½ mEff vn² (1 + kS s)
```
(These live in `sim/rules.ts` so `combat.ts` can use them without importing a world module.)

#### 1.5.5 Ruler, impacts, damage (`sim/ruler.ts` P11, `sim/impact.ts` P09, `world/damage.ts` P09)

```ts
// sim/ruler.ts
export interface RulerVolume extends HurtSphere { joint: 'knee' | 'elbow' | null }
export function rulerVolumes(f: Fighter): RulerVolume[];             // 12 DS bodySpheres (combat.ts:1739) + 2 knee + 2 elbow spheres
export function classifyRulerZone(f: Fighter, bone: BoneName, point: Vector3, normalOut: Vector3): RulerZoneId;
export function rulerToughness(z: RulerZoneId): number;
export function newRulerState(maxHp: number): RulerState;
export function rulerEffectiveMax(r: RulerState): number;            // maxHp × (1 − severePenaltyFrac × severe count)
export function rulerHp(r: RulerState): number;                      // effectiveMax − unhealed − Σ wound.remaining
export function rulerDown(f: Fighter): boolean;                      // f.state === 'tripped' || f.ruler.inPit (SPEC:504)
export function rulerHeld(f: Fighter): boolean;                      // rulerDown || stuck || pinned (no recovery; finishing)
export function rulerDamage(w: { ids: WorldIds; combat: CombatSim }, f: Fighter, hp: number, zone: RulerZoneId, bone: BoneName,
  cause: ImpactCause, point: Vector3): WoundRecord | null;           // §4.6
export function rulerTick(f: Fighter, dt: number): void;            // recovery and healing (§4.6)
export function rulerHit(sim: CombatSim, w: World, a: Fighter, d: Fighter, m: MoveDef, point: Vector3, dir: Vector3,
  zone: HurtZone, bone: BoneName, power: number, haft: boolean, thrown: WeaponDef | null, ruleDamageHp: number | null): void;

// sim/impact.ts
export function applyImpact(sim: CombatSim, i: Impact): ImpactResult;     // §4.4
export function isEnvironmental(d: Fighter, finish: Finish, tick: number): { environmental: boolean; credit: string[] };

// world/damage.ts (pure; uses reducedMass and impactEnergy from sim/rules.ts)
export function hardLandingJ(boneKg: number, vSafe: number): number;  // ½ m v_safe²
export function leadingSharpness(points: readonly SharpPoint[], pose: Pose3, contact: V3, vRelIntoPoint: V3): number;
export function selfMotion(vSelf: V3, vOther: V3, nOutOfSelf: V3): boolean;   // max(0, vSelf·n) ≥ max(0, −vOther·n) (§4.3)
```

#### 1.5.6 Physics, queries, terrain (P05)

```ts
// world/physics.ts
export class PhysicsWorld {
  readonly rapier: RAPIER.World;                       // gravity (0, −9.81, 0), timestep DT
  register(c: RAPIER.Collider, owner: Owner): void;    // collider handle → owner (never saved)
  ownerOf(handle: number): Owner | null;
  storePreStep(): void;                                // phase 5 (§4.3)
  pre(key: string): PreState | null;                   // owner key → stored state
  step(): void;                                        // phase 7
  drain(): ContactPair[];                              // phase 8: started/stopped pairs, sorted by (owner, owner, part)
  snapshotPostStep(): void;                            // phase 8: every awake dynamic body's linvel/angvel as Rapier returned
  post(key: string): { v: V3; w: V3 } | null;          //   them, before any code impulse (the rope fit's v_post, RF-2)
}
export interface PreState { p: V3; q: Quat; v: V3; w: V3; com: V3; prevP: V3; prevQ: Quat; carryV: V3 }
export interface ContactPair { a: Owner; b: Owner; ca: RAPIER.Collider; cb: RAPIER.Collider; started: boolean; sensor: boolean }

// world/types.ts (Owner, QueryFilter, Hit) and world/queries.ts (WorldQueries): what verbs, perception and the client read (never handles)
export type Owner = { kind: 'terrain' } | { kind: 'entity'; id: number } | { kind: 'fighter'; id: number;
  part: 'kcc' | 'zone' | 'slab' | 'ruler'; bone?: BoneName } | { kind: 'rope'; joint: number };
export interface QueryFilter { terrain?: boolean; entities?: 'all' | 'static' | 'none'; minEntityMassKg?: number;
  ropes?: boolean; fighters?: 'none' | 'zones' | 'kcc'; exclude?: { entities?: number[]; fighters?: number[] } }
export interface Hit { owner: Owner; toi: number; point: V3; normal: V3 /* outward normal of the struck collider at point */ }
export class WorldQueries {
  castRay(from: V3, dir: V3, maxToi: number, f: QueryFilter): Hit | null;
  castShape(shape: Shape, from: Pose3, vel: V3, maxToi: number, f: QueryFilter): Hit | null;
  overlaps(shape: Shape, at: Pose3, f: QueryFilter): Owner[];          // sorted by owner key
  projectPoint(entity: number, p: V3): { point: V3; dist: number; inside: boolean };
  surfaceDistance(f: Fighter, entity: number): number;                  // chest point (pos + 1.2·scale up) to collider surface
}

// world/terrain.ts
export class Terrain implements GroundQuery {
  readonly tileSize: number; readonly spacing: number; readonly tilesX: number; readonly tilesZ: number;
  readonly original: Float32Array[];       // generated heights per tile (dig floor, spoil test, nav extrusion rule)
  readonly heights: Float32Array[];        // column-major r + c·(n+1), rows along z (MAP rapier §2)
  readonly dug: Uint8Array[];              // per tile vertex: 1 once `lower` has ever left it > spoilUndugTolM (0.05 m) below original
                                           // ("ever dug"; never cleared; saved as edits, §8.3) (RT-2)
  readonly version: Uint32Array;           // per tile, bumped on every edit
  heightAt(x: number, z: number): number;  // exact triangle split (r+1,c)-(r,c+1): matches castRay within 1.45e-5 m (MAP rapier §2)
  originalHeightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: V3): V3;
  supportAt(x: number, z: number, fromY: number): number;   // terrain only (World.supportAt adds entities, §4.7)
  lower(x: number, z: number, depthMul: number): { volumeM3: number; tiles: number[] };   // cone kernel, 3 m floor (§4.13)
  raise(x: number, z: number, volumeM3: number): { tiles: number[]; raisedM3: number };  // inverted cone, capped; never
                                           // touches a vertex within spoilSetbackM of an ever-dug vertex (§4.13)
  findSpoilPoint(x: number, z: number): { x: number; z: number } | null;   // §4.13
  edits(): { tile: number; vertex: number; dh: number }[];   // sorted (tile, vertex), for the save
}
```

#### 1.5.7 Entities, joints, material rules (P06, P10)

```ts
// world/entities.ts
export class EntityStore {
  get(id: number): Entity | undefined;
  all(): readonly Entity[];                         // id order
  create(spec: EntitySpec, credit?: string[]): Entity;   // id from world.ids.entity; body created now
  remove(id: number): void;
  setState(e: Entity, s: EntityState): void;        // rebuilds/disables the body; marks touched
  anchor(e: Entity, depthM: number): void;          // fixed body, anchor capacity (§5.7)
  unanchor(e: Entity): void;                        // dynamic, awake
  isAnchored(e: Entity): boolean;                   // fixed/anchored, or lash/hinge-joined to one (depth ≤ 3)
  queueImpulse(id: number, j: V3, at: V3 | null): void;   // applied in phase 4d of the NEXT step in entity id order, by
                                                    // every source: strike pushes, contact reactions and tripwire shares
                                                    // of phase 9 (never addForce, C F3; never inside phase 9-10, RF-2)
  release(e: Entity, byFighter: number): void;      // drop/throw/place: no contact between e and that fighter's bodies
                                                    // is scored until they have been apart 2 ticks (RF-3)
  keepAwake(id: number, on: boolean): void;         // test harness only: wakeUp every tick (RT-4)
  mirror(): void;                                   // phase 18
}
// world/joints.ts
export class JointStore {
  get(id: number): JointRecord | undefined; all(): readonly JointRecord[];          // id order
  lash(a: Anchor, b: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): number;   // fixed joint
  hinge(a: Anchor, b: Anchor, axis: V3, limits: [number, number] | null, rope: { entity: number; lengthM: number }, credit: string[]): number;
  rope(a: Anchor, b: Anchor, lengthM: number, rope: { entity: number; lengthM: number }, credit: string[]): number;
  bend(sapling: number, top: Anchor, hold: Anchor, rope: { entity: number; lengthM: number }, credit: string[]): { bend: number; hold: number };
  remove(id: number, why: 'cut' | 'untie' | 'snap' | 'release'): void;
  holdEnd(joint: number, end: 'a' | 'b', fighterId: number): void;
  dropEnd(joint: number, at: V3): void;             // the end becomes loose
  setPull(joint: number, forceN: number): void;     // the held end's pull this tick (verbs set it every tick); haul model §4.9
  shorten(joint: number, dl: number): void;         // reel in a slack rope
  tieHeldEnd(joint: number, to: Anchor): void;      // the held end becomes tied to `to` at the current distance (tie, §5.8)
  poseSensors(): void;                              // phase 4e: re-pose every rope sensor before the step (RF-13)
  view(): readonly RopeView[];                      // client: anchors (world), length, T/strength, slack
}
export interface RopeView { joint: number; a: V3; b: V3; lengthM: number; taut: boolean; strain: number /* max(T)/(strength×strands) */ }
// world/breaking.ts, loads.ts, felling.ts
export class Breaking { hit(e: Entity, E: number, point: V3, breaker: Owner | null): void;
  loadBreak(e: Entity, at: V3, breaker: Owner | null): void;   // a load break: split across the axis at `at` (§4.10)
  update(w: World): void }
export class Loads { update(w: World): void; capacityN(e: Entity): number }
export class Felling {
  chop(tree: number, fromDir: V3, depthM: number, credit: string[]): { remaining: number; fell: boolean };
  addMoment(tree: number, moment: number): void;    // fall-direction moment this tick (pulls, pushes, impacts), N·m
  update(w: World): void;                           // phase 13c
}
```

#### 1.5.8 Bodies (P08, P11), contacts and deaths (P09)

```ts
export class CharacterControllers implements FighterMover {
  create(f: Fighter): void; remove(f: Fighter): void;
  resolve(f: Fighter, radius: number, propPad: number): void;
  setEnabled(f: Fighter, on: boolean): void;
  teleport(f: Fighter, x: number, y: number, z: number): void;
  applyPushes(): void;                               // phase 4d
  grounded(f: Fighter): boolean;
  crouched(f: Fighter): boolean;                     // capsule at crouchHeightFrac (§4.2)
}
export class ZoneBodies { create(f: Fighter): void; remove(f: Fighter): void; setEnabled(f: Fighter, on: boolean): void; pose(w: World): void;
  resetHistory(f: Fighter): void }                   // N−1 and N−2 := the current pose (carryV 0) + zone grace (§4.3, RF-1)
export class DownedBodies {
  create(f: Fighter): void; remove(f: Fighter): void;
  syncDown(w: World): void;                          // phase 4a
  postStep(w: World): void;                          // phase 13a
  queueDv(f: Fighter, dv: V3): void;                 // world-impact Δv for a downed or launched fighter
  pose(fighterId: number): { p: V3; q: Quat } | null;   // read-only (client ragdoll)
}
export class RulerBodies {
  create(f: Fighter): void; remove(f: Fighter): void;
  readonly mover: FighterMover;                      // RulerMover
  requestTrip(f: Fighter, why: TripWhy, cause: ImpactCause | null): void;   // switched in the next phase 4c
  preStep(w: World): void;                           // phase 4c: trip switches, standing zone pose
  applyShoves(): void;                               // phase 4d
  postStep(w: World): void;                          // phase 13b: tripped rig, in-pit, pinned, get-up
  resetHistory(f: Fighter): void;                    // as ZoneBodies.resetHistory (RF-1)
}
export type TripWhy = 'obstacle' | 'cover' | 'ledge' | 'impact';   // declared in world/types.ts (RulerState uses it)
export class ContactSystem { process(w: World, pairs: readonly ContactPair[]): void;   // phase 9
  grace(fighterId: number, untilTick: number): void;  // pairs starting before untilTick count as touching, never scored
  toRecord(): ContactRecV1[]; restoreRecord(r: ContactRecV1[]): void }
export class Deaths { onKO(w: World, d: Fighter, finish: Finish): void; update(w: World): void }
```

#### 1.5.9 Navigation (P12)

```ts
export type NavLayer = 'human' | 'ruler';
export class NavSystem {
  build(w: World): void;                                               // full tiled build of both layers (createWorld, load)
  findPath(layer: NavLayer, from: V3, to: V3): { points: V3[]; complete: boolean; tiles: number[]; versions: number[] };
  raycast(layer: NavLayer, from: V3, to: V3): { clear: boolean; t: number };
  nearest(layer: NavLayer, p: V3): V3 | null;                         // null when nearestRef === 0 (MAP recast §7.1)
  isWalkable(layer: NavLayer, x: number, z: number): boolean;
  tileVersion(layer: NavLayer, tile: number): number;
  markDirty(aabb: { min: V3; max: V3 }, why: string): void;
  rebuildDirty(): void;                                                // phase 16
  dirtyQueue(): [number, number, number][];                           // (layer, ty, tx), for the save
  walkBits(tile: number): Uint8Array;                                 // human layer: 1 bit per 0.2 m cell, rebuilt with the tile
  blockBits(tile: number): Uint8Array;                                // fixed/anchored/blocker entity cells at 0.2 m, same rebuild
}
export class NavWalkable implements Walkable { constructor(w: World) }   // ai.ts floor probes in world mode (§4.1): reads the
                                                                         // per-tile bitmaps, never a recast or Rapier query (RF-23)
```

#### 1.5.10 Verbs, creatures, generation (P14-P22)

```ts
export class VerbSystem {
  applyCommands(cmds: readonly VerbCommand[]): void;    // phase 1b: validate, buffer, focus
  tryVerb(f: Fighter): void;                           // WorldPort, phase 3
  completeWork(f: Fighter): void;                      // WorldPort, phase 3
  tether(f: Fighter, proposal: Vector3): void;         // called by CharacterControllers.resolve before the sweep
  onDown(w: World): void;                              // phase 4a: forced releases
  syncHeld(w: World): void;                            // phase 4b
  codeForces(w: World): void;                          // phase 4d: drag, pull, creature tug
  toRecord(): VerbStateRecV1[]; restoreRecord(r: VerbStateRecV1[]): void;
}
export function verbsFor(w: World, f: Fighter, target: TargetRef): VerbOption[];
export function validateVerb(w: World, f: Fighter, cmd: VerbCommand): { ok: true } | { ok: false; reason: RefuseReason };
export type ToolClass = 'stick' | 'sharpStick' | 'spear' | 'stoneAxe' | 'longAxe' | 'cudgel' | 'stone' | 'flintBlade';
export function toolClass(w: World, entity: number): ToolClass | null;
export function synthWeapon(w: World, entity: number, cls: ToolClass): WeaponDef;

export type MindState = 'idle' | 'patrol' | 'investigate' | 'chase' | 'fight' | 'flee' | 'return'
  | 'rest' | 'telegraph' | 'charge' | 'recover' | 'down' | 'dead';
export abstract class CreatureMind implements Brain {
  readonly cfg: AIConfig; director: AIDirector | null; drops: Drop[]; readonly ownsTarget = true;
  state: MindState; stateTick: number; paused: boolean; script: MindScript | null;
  readonly senses: Senses; readonly path: PathFollower; readonly rng: Rng;   // rng = rngs 'mind:<fighter id>'
  sense(w: World): void; abstract decide(w: World): void;
  think(self: Fighter, target: Fighter | null, wk: Walkable | null): void;
  onWound(w: WoundRecord): void; onHurt(cause: ImpactCause | null, attacker: Fighter | null, at: V3): void;
  toRecord(): MindRecV1;
}
export type MindScript =
  | { kind: 'route'; points: { x: number; z: number }[]; speed?: number; gait?: number; useNav?: boolean }
  | { kind: 'charge'; heading: number; speed: number; telegraph?: boolean }
  | { kind: 'tug'; entity: number; dirYaw: number; ticks: number }
  | { kind: 'hold'; posture?: PostureId };
export class MindRegistry { sense(w: World): void; get(f: Fighter): CreatureMind | null; view(f: Fighter): MindView;
  toRecord(): MindRecV1[] }
export class NoiseBus { emit(n: Noise): void; collect(w: World, ce: readonly CombatEvent[], we: readonly WorldEvent[]): void; fold(m: MindRegistry): void }
export function createCreature(w: World, kind: 'ape' | 'giantApe', at: { x: number; z: number }, yaw: number): Fighter;
export function generateClearing(w: World, rng: Rng): ClearingSpawnData;
export class GroundCover { at(x: number, z: number): number; set(x: number, z: number, v: number): void; edits(): [number, number][] }
export class Spawner { init(w: World, data: ClearingSpawnData | null): void; update(w: World): void; toRecord(): SpawnerRecV1 }
```

#### 1.5.11 Save and tuning (P13, P01)

```ts
export const SAVE_FORMAT_VERSION = 1;
export function saveRecord(w: World): SaveV1;
export function serializeWorld(w: World): Uint8Array;         // UTF-8 of canonicalJson(saveRecord(w))
export function bodyStateBytes(w: World): Uint8Array;         // AC-7 (§8.2)
export function loadWorld(bytes: Uint8Array, opts?: { nav?: 'full' | 'off'; applyTuning?: boolean }): Promise<World>;
  // applyTuning (default false): restore the save's tuningOverrides into the process-wide registry (RR-17). The registry
  // is per process and the client holds one live world; tests that load with applyTuning restore a snapshot afterwards.
export function migrate(rec: unknown): SaveV1;                // version ladder; v1 is the identity

export interface FieldMeta { unit: string; source: string; min?: number; max?: number; step?: number; label?: string; options?: readonly string[] }
export type FieldsOf<T> = { [K in keyof T]: T[K] extends Record<string, unknown> ? FieldsOf<T[K]> : FieldMeta };
export interface TuningEntry { name: string; folder: string; table: Record<string, unknown>; fields: Record<string, unknown>; defaults: string }
export const TUNING: readonly TuningEntry[];                  // registration order = module import order (deterministic)
export function defineTuning<T extends Record<string, unknown>>(name: string, folder: string, table: T, fields: FieldsOf<T>): T;
export function tuningSnapshot(): string;                     // canonical JSON of every table
export function restoreTuning(snapshot: string): void;
export function tuningOverrides(): { table: string; key: string; value: number | boolean | string }[];   // sorted (table, key)
export function setTuningValue(table: string, key: string, value: number | boolean | string): void;   // dotted key; throws
                                                              // on an unknown table/key or a type mismatch
```

Every tuning table is a plain mutable object defined and registered in the module that reads it (the home module
named in §9); values are read at use time, never cached, except per-entity state computed at creation (an
entity's mass from its density), which changes only for new entities.

## 2. Data model

All types below live in `world/types.ts` (P01) unless another file is named. Records hold plain numbers
(`V3 = { x; y; z }`, `Quat = { x; y; z; w }`, `Pose3 = { p: V3; q: Quat }`); Three's `Vector3` satisfies `V3`.
Rapier handles never appear in a record or a save.

### 2.1 Materials (SPEC:190-225; `world/materials.ts`, P03)

```ts
export type MaterialId = 'greenWood' | 'dryWood' | 'rottenWood' | 'leaves' | 'vine' | 'sinew' | 'hide' | 'bone'
  | 'rulerBone' | 'stone' | 'flint' | 'dirt' | 'snow' | 'ice' | 'resin' | 'fat';
export interface Material {
  density: number;            // kg/m³
  hardness: number;           // 0..1
  maxSharpness: number;       // 0..1
  flammability: number;       // 0..1 (M2)
  strength: { solidJPerKg: number } | { ropeKN: number } | null;   // null = n/a (resin, fat)
  springiness: number;        // 0..1
  friction: number;           // 0..1 → Rapier friction, combine rule Average (MAP rapier §6)
  armourJ: number;            // J this material adds to a zone it covers when worn (SPEC:417, 885): hide 20, bone 40,
                              // every other row 0 (rulerBone: TODO "ruler-bone armour value", no spec value) (RR-3)
  wetMassPerMoisture: number; // M2; 0 in M1
}
export const MATERIALS: Record<MaterialId, Material>;   // the 16 rows of SPEC:206-223 (§9)
```

Rules read properties only (SPEC:192); `look` and material ids are never read by a rule (AC-1, rule 1). The armour rule
is one of them: a worn item adds its material's `armourJ`, so a new armour material is a new row, not new code (an
eighth property beyond SPEC:194-202's seven, departure X19).
Predicates (`world/materials.ts`), the only way rules ask about materials:
- rope-like: `m.strength !== null && 'ropeKN' in m.strength`;
- soft ground: `hardness ≤ TERRAIN_TUNING.softGroundMaxHardness` (0.5);
- springy: `springiness ≥ JOINT_TUNING.bendMinSpringiness` (0.3);
- break energy `E_b = strength.solidJPerKg × mass` (SPEC:344); rope strength `ropeKN × 1000` N per strand;
- lashing break energy `ropeKN × 1000 × strands × JOINT_TUNING.lashLeverM` (0.1 m): vine 600 J, sinew 1,800 J (D-18);
- load capacity `E_b ÷ BREAK_TUNING.loadLeverM` (0.1 m) N (SPEC:345, 884).
Comparisons of property values use an epsilon of 1e-9 (`0.7 − 0.5` is `0.19999999999999996` in JS, so a 0.2 margin
test must read `≥ 0.2 − 1e-9`).

Terrain is dirt (`TERRAIN_TUNING.material = 'dirt'`, D-22): friction 0.7, hardness 0.2, so every tile is soft ground
for stakes.

### 2.2 Shapes and sharp points (`world/shapes.ts`, P03)

```ts
export type Shape =
  | { kind: 'ball'; r: number }
  | { kind: 'box'; hx: number; hy: number; hz: number }
  | { kind: 'capsule'; halfHeight: number; r: number }                  // axis local +Y
  | { kind: 'cylinder'; halfHeight: number; r: number; sides: number }  // regular N-gon prism, r = circumradius, axis +Y
  | { kind: 'hull'; points: readonly number[] };                        // local xyz triples
export interface SharpPoint {
  local: V3;        // entity-local tip
  dir: V3;          // unit, entity-local, pointing out of the tip
  sharpness: number;   // 0..1, ≤ material.maxSharpness (SPEC:183, 198)
}
export function shapeVolume(s: Shape): number;                // exact for every kind (prism: (N/2)·r²·sin(2π/N)·2·halfHeight)
export function colliderDesc(s: Shape, m: Material): RAPIER.ColliderDesc;   // density, friction; cylinder → convexHull of the prism
export function triangulate(s: Shape, pose: Pose3): { positions: Float32Array; indices: Uint32Array };   // nav input
export function fracture(s: Shape, n: 2 | 3 | 4, rng: Rng): { shape: Shape; offset: V3 }[];            // impact breaks (§4.10)
export function crossCut(s: Shape, axisT: number): [{ shape: Shape; offset: V3 }, { shape: Shape; offset: V3 }];  // Cut (§5.3)
                                                    // and load breaks (a prism snapped across its axis at the load point)
export function taperEnd(s: Shape, end: 1 | -1, taperM: number): Shape;   // Shape verb: the prism's end ring pulled to a
                                                    // tip on the axis over taperM → a pointed hull (§5.4, RF-18)
```

- **Mass = density × volume** (SPEC:196), set through `ColliderDesc.setDensity`; `Entity.mass` mirrors it.
- **No round bodies for logs, sticks, boulders or pieces.** Logs are 6-gon prisms, sticks, stakes, branches and
  trunks 8-gon prisms (`PHYSICS_TUNING.logFacets`, `cylinderFacets`), boulders and stones convex hulls resting on a
  face. Measured reasons: capsule logs roll forever (1.05 rad/s, never sleep) and make AC-5 fail at +10.83 s; prism
  logs sleep in 0.7-3.3 s **[C lab: e4b_spin, e5_trip]**; capsule props spring a deadfall in 32/36 runs **[C lab:
  e1_deadfall]**; an 800 kg ball rolls 1.06-1.49 m under a 500 N push, a hull 0.000 m **[C lab: e6_kcc]** (D-22);
  Rapier cylinders cost 16.6 ms vs 7.0 ms for 300 resting logs (MAP rapier finding 17). `ball` and `capsule` exist
  for M2+ and for tests.

### 2.3 Entity

```ts
export type EntityState = 'free' | 'anchored' | 'fixed' | 'held' | 'stowed' | 'tied' | 'projectile' | 'frozen';
export interface Entity {
  readonly id: number;                   // world counter, never reused
  material: MaterialId;
  shape: Shape;
  mass: number;                          // density × volume (× wet factor in M2)
  state: EntityState;                    // fixed: rooted trees, stumps, scaffolding; anchored: stakes driven into soft ground
  pose: Pose3;                           // authoritative record; mirrors the body after every step (f32 values)
  vel: { lin: V3; ang: V3 };
  integrity: number;                     // 0..1
  moisture: number; temperature: number; burning: boolean;   // M2 rules; fields exist now (rule 10, SPEC:178-181)
  sharpPoints: SharpPoint[];
  joints: number[];                      // JointRecord ids, sorted
  age: number;                           // s of play (advances while active)
  credit: string[];                      // player ids, sorted, de-duplicated (SPEC:186, 473)
  look: string;                          // presentation hint ('tree', 'log', 'stone'…); no rule reads it
  plant: PlantState | null;              // trees and saplings while rooted (§2.5)
  anchor: { depthM: number; capacityN: number } | null;   // stakes driven into soft ground (D-19)
  rope: { lengthM: number } | null;      // rope-like entities: total length
  crossCut: { axisT: number; remaining: number; fromDir: V3 } | null;   // Cut progress on a free entity (§5.3)
  thrown: { by: number; tick: number } | null;   // damage cause stays `held` until first contact or rest (D-31)
  loadHist: Float32Array;                // last 12 ticks of computed load, N (§4.11)
  restTicks: number;                     // consecutive ticks below PHYSICS_TUNING.restSpeed
  generated: boolean;                    // made by generateClearing (the save stores it only if touched)
  touched: boolean;                      // moved > 1 cm or 1°, or any field changed since generation (§8.3)
  grace: { from: Owner; minUntil: number; maxUntil: number } | null;   // a fresh piece ignores its breaker (and every
                                         // fighter, §2.11) until it no longer overlaps the breaker, at least 10 ticks
                                         // (§4.10, RF-7); saved
  releasedBy: { fighter: number; apartTicks: number } | null;   // dropped, thrown or placed: contacts with that
                                         // fighter's bodies are not scored until apart 2 ticks (§4.3, RF-3); saved
  // runtime only, never saved:
  body: RAPIER.RigidBody | null;         // null while stowed, tied, projectile, frozen; disabled (not null) while held
  collider: RAPIER.Collider | null;
  prevPose: Pose3;                       // client interpolation
}
export interface EntitySpec {
  material: MaterialId; shape: Shape; p: V3; q?: Quat; lin?: V3; ang?: V3;
  state?: 'free' | 'anchored' | 'fixed'; sharpPoints?: SharpPoint[]; look: string;
  plant?: { diameter: number; height: number }; rope?: { lengthM: number }; credit?: string[]; integrity?: number;
  anchorDepthM?: number; generated?: boolean;
}
```

Bodies (`EntityStore.create`, P06): `fixed` and `anchored` → `RigidBodyDesc.fixed()` (an anchored stake counts as
static for m_eff, trip and shove, D-19); `free` → dynamic with `setAdditionalSolverIterations(4)` (a 2 kg prop under
a 300 kg log holds with +4, falls with 0, MAP rapier finding 11), `linearDamping 0`, `angularDamping 0.1`,
`canSleep true`, CCD when the smallest half-extent < 0.15 m, when thrown, and for falling trunks (SPEC:267). Every
entity collider: `ActiveEvents.COLLISION_EVENTS`; dynamic ones also `CONTACT_FORCE_EVENTS` with threshold 2,000 N,
used only by a dev-mode cross-check counter, never for an outcome. Bodies are created and removed in id order.

**Anchored.** `isAnchored(e)` = state `fixed` or `anchored`, or `e` is joined by a `lash` or `hinge` joint to an
anchored entity (transitively, depth ≤ 3). A log lashed to anchored stakes ("a staked log", AC-5, AC-6) is therefore
a blocker and static for m_eff whatever its mass (SPEC:781, 879: "anchored or fixed"). An anchored stake becomes
`free` (dynamic, awake) when a scored impact on it exceeds `anchor.capacityN × 0.1 m` J, when a tripwire or pull
load exceeds `capacityN` (§4.9), or when digging exposes its driven end (§4.13).

### 2.4 Joints and ropes (`world/joints.ts`, P10)

```ts
export type JointKind = 'lash' | 'hinge' | 'rope' | 'bend';
export interface Anchor { entity: number | null; local: V3; fighter?: number; loose?: true }
  // entity null + no fighter + not loose = a world point; fighter = a held free end (Pull); loose = an end lying free
export interface JointRecord {
  readonly id: number;
  kind: JointKind;
  a: Anchor; b: Anchor;
  rope: { entity: number; lengthM: number } | null;   // the rope entity it is made of, and the free length now
  breakEnergyJ: number;          // lash/hinge: D-18; rope/bend: Infinity (ropes break on tension)
  axis: V3 | null; limits: [number, number] | null;   // hinge/bend, in a's frame, rad
  motor: { restAngle: number; stiffness: number; damping: number } | null;   // bend (SPEC:258)
  holdsBend: number | null;      // on a rope joint: the bend joint it keeps bent
  tension: [number, number, number];   // N per strand, last 3 steps (SPEC:261); saved
  pullN: number;                 // code pull on a held end this tick (0 = none)
  credit: string[];
}
```

- **lash** → `JointData.fixed`, `setContactsEnabled(false)` on the pair (MAP rapier §5). **hinge** →
  `JointData.revolute`; limits set on the joint after creation (`JointData` limits apply only to prismatic, MAP
  rapier §5). **rope** → `JointData.rope(lengthM, …)` when both ends are bodies; **no Rapier joint** when an end is
  held (`fighter`), loose, or a world point on a fixed entity (code forces, §4.9). **bend** → revolute at the sapling
  base with a `ForceBased` position motor (k 20,000 / d 2,000 overshoots −0.2°, MAP rapier §5),
  `stiffness = JOINT_TUNING.bendK × springiness × d²`, held bent by a rope joint whose `holdsBend` names it.
- Rapier reports rope, spring and spherical joints as `Generic` (MAP rapier finding 9): the kind lives only in the
  record.
- **A rope has no body** (SPEC:265): a tied rope entity has `state 'tied'`, `body null`; its joint owns one
  parentless sensor capsule (radius `JOINT_TUNING.ropeSensorR` 0.02 m, `ActiveCollisionTypes.ALL`,
  `COLLISION_EVENTS`) re-posed after every step between the anchors' world points (`setTranslation`,
  `setRotation`, `setHalfHeight`). A rope with a loose end gets a sensor from its anchor to the loose point (a
  hanging vine reads as a diagonal, enough for targeting and cutting; it is never a tripwire, §4.9). When both ends
  are loose or the joint is removed with no other joint on the rope entity, the rope becomes a coil (`state 'free'`,
  a `cylinder` coil shape of its mass). Draping chains (snares) are M4.
- **Strands add up** (SPEC:266): rope joints joining the same two anchor points (each within
  `JOINT_TUNING.strandMergeM` 0.05 m) form a strand group, one unknown in the tension fit (§4.9).

### 2.5 Trees: standing → notched → falling → felled (`world/felling.ts`, P10)

```ts
export interface PlantState {
  diameter: number; height: number;          // m (circum-diameter of the prism at the cut height)
  phase: 'standing' | 'notched' | 'bent' | 'falling' | 'felled';
  cut: { fromDir: V3; remaining: number; chops: number; depthSumM: number } | null;
     // fromDir: unit horizontal pointing from the trunk toward the side chops come from; remaining = 1 − depthSum/diameter
  stump: number | null;                      // stump entity id once felled
  fall: { hinge: V3; axis: V3; torn: boolean } | null;   // world hinge point H and axis while falling
}
```

- **standing**: `fixed` body, one 8-gon prism trunk collider from the ground to `height`. No canopy collider in M1.
  Rule 3 conflict, flagged (TODO "canopy collision (rule 3)" at the crown code in `forestView.ts` and here): a standing
  crown overlaps nothing a creature can reach, but a falling crown would visibly pass through bodies with no effect, so
  the client draws the crown of a falling or felled tree collapsed against the trunk, inside the trunk collider's radius
  + `RENDER_TUNING.fallenCrownPadM` (0.15 m) over its top third (§10.4): nothing is drawn where a contact could be seen
  without one being scored (RR-15).
- **notched**: still `fixed`. Each qualifying chop adds `depthM` (§5.3) to `depthSumM`; `remaining = max(0, 1 −
  depthSumM / diameter)`. `fromDir` = the horizontal unit vector from the trunk axis to the chopping fighter's root at
  first chop (not the struck facet's normal, which snaps to the 8-gon's 45° steps, RT-22), kept for the tree's life;
  later chops deepen the same notch from any side. The fall direction is `−fromDir` ("away from the cut side",
  SPEC:233); the hinge point H is on the trunk's surface at cut height on the fall side; the hinge axis is horizontal,
  ⟂ the fall direction.
- **falling** (phase 13c) when `remaining ≤ FELL_TUNING.fellAtRemaining + 1e-9` (0: the 15th stone-axe chop of a
  30 cm trunk) or when the fall-direction moment about H exceeds the hinge capacity (§4.12). Then: a stump entity is
  created (`fixed`, same diameter, height `cutHeightM` 0.5 m, credit of the chopper); the trunk entity keeps its id,
  its shape shrinks to the part above the cut, its body becomes `Dynamic` (mass from density × volume, CCD on);
  `felling.ts` creates a revolute joint (runtime, not a `JointRecord`) between trunk and stump at H with limits
  [0°, `hingeLimitDeg` 80°] in the fall direction and `setContactsEnabled(false)`; initial angular velocity
  `tipAngVel` 0.15 rad/s about the hinge axis toward the fall; the old footprint's nav tiles are marked dirty.
- **torn** at `hingeTearDeg` 75°: the revolute is removed and replaced by a contacts-off rope joint of length
  `cutHeightM + height` that is never taut (it only keeps trunk-stump contacts off, C F10), so the trunk lands on the
  fall line ±0.2° **[C lab: e4_fell]** instead of 19-39° toward the pull with a free-tipping trunk **[C lab: e4_free]**.
- **felled**: once the trunk rests (`restTicks ≥ 30`), its new AABB's nav tiles are marked dirty, `plant` becomes
  `null`, and it is an ordinary `free` log. Saplings bent by the Bend verb have phase `bent` (§5.9).

### 2.6 Terrain tiles and dig (`world/terrain.ts`, P05)

One logical 200 m chunk (D-7) of 8 × 8 tiles of `tileSize` 25 m at `spacing` 0.25 m (100 cells → 101² heights per
tile; spacing ≤ 0.25 m so a 0.5 m dig touches more than 3-5 vertices, MAP rapier §2). One fixed heightfield
collider per tile, `HeightFieldFlags.FIX_INTERNAL_EDGES`, centred on the tile; edits call
`collider.setShape(new Heightfield(…))` (keeps the handle, 0.55-0.69 ms per 257² tile **[C lab: e2_pit]**, wakes
bodies on the tile, MAP rapier finding 10). Tile-edge vertices are written identically in both neighbours. Heights
are column-major `r + c·(n+1)` with rows along z (MAP rapier §2). `heightAt` uses the heightfield's own triangle
split, so it matches `castRay` within 1.45e-5 m (MAP rapier §2). `original` keeps the generated heights (the 3 m dig
floor, the nav extrusion rule); `dug` marks every vertex ever dug (the spoil rule, §4.13). `version[tile]` bumps on
every edit (client mesh, nav). `setShape` on a 101² tile costs 0.013-0.020 ms **[RF lab: p1_tickcost.mjs]**.
`TERRAIN_TUNING.terrainChunkSize` (64 m, SPEC:97) is kept for M3's generator.

### 2.7 Creatures (`sim/species.ts` P03; behaviour in §6)

```ts
export type SpeciesId = 'human' | 'ape' | 'giantApe';      // declared in world/types.ts
export interface SpeciesBody {
  scale: number; massKg: number; maxHp: number;
  toughnessJ: number;            // hide (rulers: per zone, §2.8)
  vSafe: number;                 // m/s safe landing speed: 6·√scale (SPEC:284, D-4)
  footRadiusM: number;           // load footprint at scale 1, × scale (D-39)
  massShareMode: 'bone' | 'zone';   // m_eff source; 'bone' (orchestrator decision 2); a playtest lever (§4.3)
  defense: 0;                    // DS fractional armour off (D-13)
  parts: { material: MaterialId; count: number; shape: Shape }[];   // dropped at death, ×2 if environmental (D-30)
}
export const SPECIES_BODY: Record<SpeciesId, SpeciesBody>;
```

| Species | scale | mass kg | HP | toughness J | v_safe m/s | foot r m (× scale) | parts |
|---|---|---|---|---|---|---|---|
| human (player) | 1 | 73.3 (Σ`BONE_MASS`) | 100 (SPEC:368) | 0 (SPEC:288) | 6 (SPEC:284) | 0.12 | — |
| ape | 1.1 (SPEC:873) | 97.56 (73.3 × 1.1³, SPEC:660) | 90 (SPEC:873) | 0 (SPEC:873) | 6.29 | 0.12 | hide ×1 (2 kg box), bone ×2 (0.5 kg) |
| giantApe | 5.5 (SPEC:874) | 14,000 (SPEC:874) | 12,000 (SPEC:874) | per zone (§2.8) | 14.07 | 0.12 (0.66 m) | hide ×4 (20 kg), rulerBone ×6 (5 kg) |

Bone masses (kg) = `mass × boneShare[bone]` (the m_eff of §4.3; MAP spec-m1 derived numbers):

| bone | human | ape | giant ape |
|---|---|---|---|
| pelvis / abdomen / chest / head | 10 / 8 / 15 / 5.5 | 13.31 / 10.65 / 19.97 / 7.32 | 1,910 / 1,528 / 2,865 / 1,050 |
| upperArm / foreArm (each) | 2.2 / 1.7 | 2.93 / 2.26 | 420 / 325 |
| thigh / shin (each) | 9 / 4.5 | 11.98 / 5.99 | 1,719 / 859 |

The bone masses come from the live table `BODY_MASS_TUNING.boneKg` (`body/mass.ts`; DS's `MASS`, 73.3 kg in all;
SPEC:876, orchestrator decision 2). The HurtZone totals (SPEC:876: head 7.5 %, chest with arms 31.1 %, abdomen with
pelvis 24.6 %, legs 36.8 %; giant: head 1,050, chest+arms 4,355, abdomen+pelvis 3,438, legs 5,157 kg) are registered
read-outs of the same table (`BODY_MASS_TUNING.zoneShare`, computed, shown in the dev panel, not editable) and are used
only when `massShareMode === 'zone'` (RR-2).

### 2.8 Ruler zones, bones, sub-volumes, toughness, mass (`sim/ruler.ts`, P11)

```ts
export type RulerZoneId = 'skull' | 'eyes' | 'mouth' | 'back' | 'shoulders' | 'flanks' | 'belly' | 'knees' | 'elbows'
  | 'chest' | 'arm' | 'leg' | 'pelvis';      // last four: unlisted surfaces, armoured (D-8)
```

Two volume sets, one classifier:
- **Melee** (CombatSim): `rulerVolumes(f)` = DS `bodySpheres` (combat.ts:1739: head t 0.13/r 0.15, chest 0.16/0.19,
  abdomen 0.10/0.17, pelvis 0.02/0.15, upperArm 0.15/0.075, foreArm 0.14/0.07, thigh 0.22/0.10, shin 0.22/0.085;
  authored, × scale) **plus** a knee sphere per leg (shin root, t 0, r 0.09) and an elbow sphere per arm (foreArm
  root, t 0, r 0.07). At scale 5.5: knee r 0.495 m with centres 2.48-2.79 m up; elbow r 0.385 m (MAP gap-6 §3a). Used by
  `overlapBody` (weapons, thrown), `overlap` (fists, feet) and `projectileStrike` whenever `d.ruler`. Without the
  knee volumes no soft zone is in human reach and AC-4's first half is vacuous (MAP gap-6).
- **World** (Rapier): the ruler body's 12 bone-shaped colliders (ragdoll shapes × scale, MAP gap-3 §2.1); knees and
  elbows are found by distance inside the shin/foreArm colliders.

`classifyRulerZone(f, bone, point, n)`, `n` = the outward normal in the bone frame (`rig[bone].rot⁻¹`; melee:
`(point − sphereCentre)/r`; world: the manifold or cast normal). Thresholds in `RULER_ZONE_TUNING`:

| Bone / volume | Zone | T (J) |
|---|---|---|
| shin or thigh, point within `kneeR × scale` of the knee joint (`rig.shinX.pos`) | **knees** | 600 |
| foreArm or upperArm, point within `elbowR × scale` of the elbow joint (`rig.foreArmX.pos`) | **elbows** | 600 |
| head | n_z > 0.6, −0.05 ≤ n_y ≤ 0.35, \|n_x\| ≤ 0.55 → **eyes**; n_z > 0.6, −0.6 ≤ n_y < −0.05, \|n_x\| ≤ 0.4 → **mouth**; else **skull** | 600 / 600 / 4,000 |
| chest | n_y > 0.6 → **shoulders**; n_z < −0.4 → **back**; \|n_x\| > 0.6 → **flanks**; else *chest* | 4,000 |
| abdomen | n_z > 0.5 and \|n_x\| < 0.6 → **belly**; n_z < −0.4 → **back**; else **flanks** | 600 / 4,000 / 4,000 |
| pelvis | n_z < −0.4 → **back**; \|n_x\| > 0.6 → **flanks**; else *pelvis* | 4,000 |
| upperArm, point above the shoulder joint − r | **shoulders**; else *arm* | 4,000 |
| thigh, shin (not knee) | *leg* | 4,000 |

Soft zones (SPEC:875): eyes, mouth, belly, knees, elbows = 600 J. Armoured: skull, back, shoulders, flanks = 4,000 J;
every unlisted surface (*chest, arm, leg, pelvis*) = `RULER_ZONE_TUNING.defaultJ` 4,000 J (D-8). m_eff = the struck
bone's mass (§4.3).

```ts
export interface RulerState {
  maxHp: number;
  unhealed: number;              // damage that made no wound (recovers 30 HP/s when allowed)
  wounds: WoundRecord[];         // in creation order
  pinned: boolean; pinnedKg: number; unpinTicks: number;   // D-38 with hysteresis (§4.7)
  stuck: boolean; burning: boolean;                         // M2; always false in M1
  inPit: boolean;                // set by RulerBodies in phase 13b (§4.7): both planted feet more than
                                 // RULER_BODY_TUNING.pitDownDepthFrac × knee height (0.5 × 2.75 = 1.4 m) below originalHeightAt
  downWound: number | null;      // the wound finishing damage goes to: the wound that tripped, pitted or pinned it (§4.6)
  downCause: ImpactCause | null; // what put it down (the trip's or the pin's cause), for D-37's "opened with the cause"
  lastWorldTrip: { tick: number; cause: ImpactCause | null } | null;   // the last trip caused by the world (obstacle,
                                 // cover, ledge, impact): a terrain wound within envKillWindowS of it is byWorld (§4.6)
  deflectedHeading: number | null;   // set by RulerMover on a deflection, consumed by the mind (§6.4)
  pendingTrip: { why: TripWhy; tick: number; cause: ImpactCause | null } | null;
}
// The giant's committed heading is mind state (`RulerMind.heading`, saved in `MindRecV1`), not body state.
```

"Down" (SPEC:504: "**down** (tripped, or in a pit)") = `rulerDown(f)` = `f.state === 'tripped' || f.ruler.inPit`.
"Held" (no recovery, SPEC:504; finishing, SPEC:505) = `rulerHeld(f)` = down, stuck or pinned. Both are functions of
saved state, never separate flags (RR-1).

### 2.9 Wounds

```ts
export type SevereEffect = 'limp' | 'blindL' | 'blindR' | 'weakJaw' | 'winded';   // burns: M2
export interface WoundRecord {
  readonly id: number;           // world wound counter
  zone: RulerZoneId; bone: BoneName; local: V3;   // where on the bone (visible scar, SPEC:845)
  severe: boolean; effect: SevereEffect | null;
  hp: number;                    // damage recorded in it (opening hit + finishing damage)
  remaining: number;             // not yet healed
  cause: ImpactCause;            // recorded with its cause (SPEC:502); cause.feature feeds adaptation (M4)
  tick: number; credit: string[];
}
```

Severe effect by zone (SPEC:503): knees, leg → `limp`; eyes → `blindL`/`blindR` by the side of the point; mouth,
skull → `weakJaw`; any torso zone (chest, back, flanks, belly, shoulders, pelvis) and arm/elbows → `winded`.
Magnitudes are `CREATURE_TUNING.giant` values consumed by the mind (§6.4). SPEC:503 names four effects for four body
parts; the skull → `weakJaw` mapping and the `winded` effect for torso and arms are our reading (I25): every severe
wound must change behaviour (SPEC:503 "a severe wound that changes behaviour"), and SPEC's list has no torso or arm
entry, so those zones get the mildest effect (a longer charge cooldown, a slower chase) rather than none (RR-10).

### 2.10 Impacts and knockouts (`world/types.ts`)

```ts
export type CauseKind = 'entity' | 'terrain' | 'creature' | 'bleed';
export type CauseFeature = 'sharpPoint' | 'falling' | 'swinging' | 'rolling' | 'cover' | 'rope' | 'fall' | 'creature';
export interface ImpactCause {
  kind: CauseKind; entityId: number | null; fighterId: number | null;
  credit: readonly string[];     // entity credit or [playerId]; [] = nobody (SPEC:186, 473)
  held: boolean;                 // in a fighter's hands, or thrown and not yet at first contact or rest (D-31)
  feature: CauseFeature;         // what adaptation will remember (SPEC:785)
}
export interface Impact {
  target: Fighter; bone: BoneName; zone: HurtZone; rulerZone: RulerZoneId | null;
  point: V3; normal: V3;         // normal out of the target
  mEff: number; vn: number; sharpness: number;
  energy: number;                // J after the hard-landing subtraction
  toughness: number;             // J, zone toughness + armour
  dv: V3;                        // 3-D momentum transfer to the target; zero for static impactors and terrain
  impactorMass: number;          // kg; Infinity for static
  cause: ImpactCause;
}
export interface ImpactResult { damage: number; knockdown: boolean; launched: boolean; ko: boolean; reaction: V3; wound: WoundRecord | null }
export interface KnockRecord { tick: number; cause: ImpactCause; by: number | null /* knocker fighter id */ }
export interface Finish { by: 'strike' | 'thrown' | 'impact' | 'bleed' | 'fatal' | 'sever'; killer: Fighter | null;
  cause: ImpactCause | null; point: V3 }
```

### 2.11 Collision and solver groups (`world/groups.ts`, P05)

`G(member, filter) = ((member & 0xffff) << 16) | (filter & 0xffff)` (MAP rapier §4.1). A pair interacts when each
side's membership is in the other's filter. **Every collider's solver membership is its own bit only**: an entity
whose solver membership is the default "all bits" makes a falling log stop dead on the player's capsule, measured
0 m/s vs 86 % of its speed kept with the discipline **[C lab: e6_kcc, F4]**.

| Group | Bit | Collision filter | Solver filter | Used by |
|---|---|---|---|---|
| TERRAIN | 0x001 | ENTITY, CHAR, RULER_SOLID, DOWNED | ENTITY, CHAR, RULER_SOLID, DOWNED | heightfield tiles |
| ENTITY | 0x002 | TERRAIN, ENTITY, CHAR, ZONE, RULER_ZONE, RULER_SOLID, DOWNED, ROPE | TERRAIN, ENTITY, RULER_SOLID, DOWNED | every entity (fixed, anchored, free) |
| CHAR | 0x004 | TERRAIN, ENTITY, RULER_SOLID | TERRAIN | KCC capsules (kinematic); KCC queries pass `G(CHAR, TERRAIN\|ENTITY\|RULER_SOLID)` and `QueryFilterFlags.EXCLUDE_SENSORS` (SPEC:376, MAP rapier finding 6) |
| ZONE | 0x008 | ENTITY, RULER_ZONE, RULER_SOLID, ROPE | — (sensor) | standing player/ape zones; not ZONE, so player-ape body contacts never score (melee is CombatSim's) |
| RULER_ZONE | 0x010 | ENTITY, ZONE, DOWNED, ROPE | — (sensor) | the standing ruler; not TERRAIN (its feet stand in the ground, MAP gap-3 §3.1); DOWNED so it can stomp a downed player |
| RULER_SOLID | 0x020 | TERRAIN, ENTITY, CHAR, ZONE, DOWNED, ROPE | TERRAIN, ENTITY, DOWNED | the tripped ruler; the KCC stands on it but never pushes 14 t |
| DOWNED | 0x040 | TERRAIN, ENTITY, RULER_ZONE, RULER_SOLID, DOWNED, ROPE | TERRAIN, ENTITY, RULER_SOLID, DOWNED | slabs; standing KCCs walk through them (DS, combat.ts:770) |
| ROPE | 0x080 | ENTITY, ZONE, RULER_ZONE, RULER_SOLID, DOWNED | — (sensor) | rope sensor capsules |

Every sensor uses `ActiveCollisionTypes.ALL` (sensor-vs-fixed and sensor-vs-sensor need it, MAP rapier §4.3) and
`COLLISION_EVENTS`. A fresh broken piece (§4.10) is an ENTITY whose collision filter drops CHAR, ZONE, RULER_ZONE,
RULER_SOLID and DOWNED while `grace` lasts (until it is clear of its breaker, at least 10 ticks, §4.10). CCD on
kinematic-parented sensors is needed: without it 9-19 of 20 phases are detected at 12-20 m/s, with it 20/20 **[RF lab:
c1_ccd_sensor.mjs]**, so thrown and thin bodies keep CCD on (§2.3).

### 2.12 Player hands, belt, back

```ts
export interface Inventory {
  hands: { entity: number; mode: 'wield' | 'carry' | 'drag' | 'ropeEnd'; grip: V3; twoHanded: boolean; joint: number | null } | null;
  belt: [number | null, number | null, number | null];   // small items (SPEC:385)
  back: number | null;                                   // one tool or bundle (SPEC:386)
}
```

Held (`wield`, `carry`) entities keep their body, disabled (`setEnabled(false)` hides it from queries, MAP gap-5
§6.2); their record pose follows the hand frame each tick (phase 4b). Dragged entities stay dynamic. A held rope
end is `mode 'ropeEnd'` with `joint` set. Stowed entities have no body and are drawn on the body by the client. On
KO the hands drop where the player fell; belt and back stay (SPEC:422). `Fighter.weapon` is the `WeaponDef` derived
by `synthWeapon` from a wielded tool entity (§5.2).

### 2.13 Events to the client

`CombatEvent` (combat.ts:26) keeps DS's union and gains:

```ts
| { type: 'ko'; victim: Fighter; by: Finish['by']; killer: Fighter | null; cause: ImpactCause | null;
    environmental: boolean; credit: string[]; point: Vector3 }
// and 'hit' gains optional rulerZone?: RulerZoneId; energy?: number; toughness?: number
```

World events, ordered by phase, then by owner id within a phase (`world/types.ts`):

```ts
export type WorldEvent =
  | { type: 'impact'; tick: number; defender: Fighter; point: V3; normal: V3; dir: V3; zone: HurtZone; bone: BoneName;
      rulerZone: RulerZoneId | null; energy: number; toughness: number; damage: number; dv: V3;
      knockdown: boolean; launched: boolean; ko: boolean; corpse: boolean;
      weight: Weight; impulse: number; lift: number; hitstop: number; shake: number;   // presentation hints (MAP gap-2 §8b)
      cause: ImpactCause; wound: WoundRecord | null }
  | { type: 'wound'; ruler: Fighter; wound: WoundRecord; byWorld: boolean }   // byWorld: (cause.kind 'entity' and
      // !cause.held), or (cause.kind 'terrain' within envKillWindowS of ruler.lastWorldTrip) (RR-14)
  | { type: 'launch'; f: Fighter; vel: V3; angVel: V3 }                        // slab enabled; the ragdoll copies it
  | { type: 'trip'; f: Fighter; at: V3; why: TripWhy; cause: ImpactCause | null } | { type: 'rise'; f: Fighter }
  | { type: 'pit'; f: Fighter; on: boolean }                                    // ruler.inPit changed (§4.7)
  | { type: 'tripwire'; joint: number; by: Owner; loadN: number; snapped: boolean; loosed: number[] }   // §4.9 (RT-5)
  | { type: 'pinned'; f: Fighter; on: boolean }
  | { type: 'shove'; ruler: Fighter; entity: number } | { type: 'deflect'; ruler: Fighter; along: V3 }
  | { type: 'land'; entity: number | null; f: Fighter | null; point: V3; energy: number; mass: number }   // thud, dust, shake ∝ mass (SPEC:581)
  | { type: 'break'; entity: number; pieces: number[]; point: V3; energy: number }
  | { type: 'joint'; joint: number; what: 'snap' | 'cut' | 'untie' | 'loose' | 'release' }
  | { type: 'chop'; tree: number; point: V3; remaining: number } | { type: 'fell'; tree: number; dir: V3 }
  | { type: 'crossCut'; entity: number; pieces: number[] | null }
  | { type: 'dig'; point: V3; volumeM3: number; pile: number | null }
  | { type: 'spawn'; entity: number } | { type: 'remove'; entity: number }
  | { type: 'death'; f: Fighter; respawnTick: number } | { type: 'respawn'; f: Fighter; at: V3 }
  | { type: 'parts'; victim: number; entities: number[]; environmental: boolean }
  | { type: 'verb'; f: Fighter; verb: VerbId; ok: boolean; reason?: RefuseReason; entity?: number }
  | { type: 'noise'; at: V3; radius: number; kind: NoiseKind };     // presentation hint only
```

Rope tension (straight, thin, creak; SPEC:357) and integrity (cracks, sag; SPEC:362) are read as state each frame
(`world.joints.view()`, `entity.integrity`), not as events.

## 3. The tick pipeline

One `World.step()` is one sim tick (DT = 1/60 s). The client calls it 0-6 times per frame (§10.2; rule 8 lives
there, never here). Every list below is iterated in a fixed order: fighters in `combat.fighters` order (creation
order = id order, never re-sorted, MAP gap-7 §3.1), entities, joints, wounds and nav tiles in id order, contact
pairs in sorted owner order.

```
World.step():
 0   this.events.length = 0
 1   COMMANDS (SPEC:696)
 1a    rest = combat.beginTick()        frame++ (= world.tick); combat events cleared; move/button commands applied in
                                        queue order to combat.playerFighter(c.player) (world: World.players; legacy: the
                                        fighter whose id is c.player) (move writes moveInput and moveFlags; button 'jump'
                                        sets jumpRequest 6; a punch while holding a rope end → pull, §5.12);
                                        director.frame set; returns verb and meta commands in queue order
 1b    verbs.applyCommands(verbs)       validate (§5.0); 'focus' applied now; others buffered as f.verbRequest (12 frames)
 1c    meta: 'save' → saveDue; 'dev' → devOps.applyDevOp now (spawns, teleports, pauses, setTuning; so replays stay
       exact, RR-17); 'pause' and 'timeAway' are the client's / M3 (I27)
 2   MINDS (SPEC:698): minds.sense(world), fighter-id order. Full rate within WORLD_TUNING.aiNearM (60 m) of the player,
       else when (tick + id) % aiFarPeriodTicks (60) === 0. Sight, decide (transitions), path requests served
       (≤ navQueriesPerTick 4, in (requestTick, fighterId) order)
 3   COMBATSIM (SPEC:699) = combat.stepBody():
       retarget (skips brains with ownsTarget) → tickTimers → advance ('tripped': stateFrame++ only)
       → brains think (BrawlerAI in a fight; CreatureMind otherwise: writes moveInput, or f.drive and f.posture)
       → manualDefense → autoDefend (skipped while carrying or dragging) → tryBufferedAttack → tryPickup
       → world.tryVerb (§5.0; re-validates, may start a work action) → bleed
       → locomote (drive, moveFlags, load multipliers; no integration of vel/walkVel while physicsOwnsDowned and state
         ∈ {knockdown, ko, tripped})
       → separate(): pairwise push (unchanged; skips knockdown, ko, tripped; in world mode also skips a pair with a
           standing ruler whose closing speed exceeds RULER_TUNING.separateSkipSpeed, §4.4), then per fighter in order:
           mover ? (standing ? world.mover.resolve(f) : skip) : walkable.resolve + pos.y = 0 (legacy, combat.ts:794-795)
           player/ape: CharacterControllers.resolve (verbs.tether first, crouch height, jump, KCC sweep, landing, push
             queue) §4.2
           giant: RulerMover.resolve (support, slope and step limits, climb, shove queue, deflect, trip request, block,
             ledge) §4.7
       → updatePose ('tripped': FK from the body's rig) → resolveHits (melee; ruler branch via world.rulerHit;
         unmatched swings → world.strike: chop, cross-cut, sever, push, dig, clang; advancePickup → world.completeWork,
         which re-validates)
       → stepProjectiles (ground floor; world mode: no 2-D walkable wall test, world.projectile vs entities and terrain;
         onProjectileLanded; rule damage)
     → ce = combat events of this tick
 4   BODY SYNC (SPEC:700), fighter-id order
 4a    downed.syncDown: fighters that entered knockdown or ko this tick, or have a pending launch/press from phase 9 of
       the last tick → enable the slab with the launch velocity (+ the queued Δv), disable the KCC and zone body (§4.5);
       a slab handed back in 13a last tick → zone body enabled with zones.resetHistory (RF-1);
       verbs.onDown: forced releases (carry, drag, rope end; the wielded tool only on KO)
 4b    zones.pose: standing and rising players/apes: zone body setNextKinematicTranslation/Rotation(pelvis), 12 colliders
       setTranslationWrtParent/RotationWrtParent from the rig; push the pose history (reset instead after any enable,
       teleport, respawn or load, §4.3); verbs.syncHeld: held entities' record poses follow the hand
 4c    rulers.preStep: pending trips (from phase 3 this tick, phase 9 or 11 last tick) → trip switch (§4.7); standing
       and rising rulers: zones posed as 4b (history reset on the get-up switch)
 4d    code forces, as impulses F·DT (never addForce, which persists and accumulates torque, C F3), in this order:
       kcc.applyPushes (≤ 500 N, entity id order) → rulers.applyShoves → verbs.codeForces (drag, pull → joints.setPull,
       creature tug) → joints.applyHeldEnds (held/loose-end ropes, haul model: impulses on dynamic ends, moments on
       notched trees via felling.addMoment, loads on anchors) → entities' queued impulses in entity id order (strike
       pushes of phase 3, and contact reactions and tripwire shares queued in phase 9 of the LAST tick, RF-2)
 4e    joints.poseSensors(): every rope sensor re-posed from its anchors' current poses (the step then refreshes the
       broad phase, so a sensor moved 1 m is found at its new pose, RF-13)
 5   PRE-STEP STORE (SPEC:279): physics.storePreStep(): every awake dynamic body's pose, linvel, angvel, world COM
       (previous pose kept); every zone collider's start-of-step pose and carrying velocity (pose_{N−1} − pose_{N−2})/DT
 6   (reserved: M2 buoyancy and drag)
 7   physics.step() = rapier.step(eventQueue)                     (SPEC:701)
 8   physics.snapshotPostStep() (every awake dynamic body's linvel/angvel as the step left them: the rope fit's v_post);
     pairs = physics.drain(): collision events (contact-force events go only to the dev cross-check) copied into arrays;
       nothing acts inside the drain callback (an exception there is swallowed silently, MAP gap-3 §1.3); handles →
       owners; sorted by (lower owner key, higher owner key, part ids); terrain tiles merged into one owner
 9   CONTACTS AND THE DAMAGE RULE (SPEC:701), contacts.process, in sorted order:
 9a    every pair updates the per-(creature, owner) touching counts; a pair is a new contact only when its count goes
       0 → 1 outside the episode cooldown and grace windows (§4.3); each new contact: classify, normal, point, v_n
       from the phase-5 store, self-motion, m_eff, sharpness, hard landing → E (§4.3)
 9b    creature targets → applyImpact (HP; Δv only for sensor targets; knockdown/launch/press/ko, lastKnock; rulers:
       wounds, finishing, impact-trip check); the reaction impulse −M·Δv on the impactor is queued (entities.queueImpulse,
       applied in 4d of the next tick, RF-2)
 9c    entity targets → breaking.hit (integrity) and lash/hinge break checks (creature damage already applied, SPEC:344);
       felling.addMoment for impacts on notched trees
 9d    rope sensor starts → tripwire loads from the crossing body's root momentum (§4.9); shares queued like 9b;
       `tripwire` events
 9e    thrown entities: clear `thrown` on first contact; `land` events for heavy landings
10   ROPES (SPEC:701): joints.postStep: NNLS tension for taut ropes from (phase-8 snapshot − phase-5 store)/DT (§4.9),
       3-step max vs strength × strands → snaps (one strand per group per tick, weakest first); released bends spring
       back
11   LOADS: loads.update: foot loads of standing fighters + resting weights → covering layers pass them down, spanning
       entities carry them → 12-tick average vs capacity → loadBreak at the load point; a planted ruler foot whose
       support broke with a support drop beyond the ledge threshold → rulers.requestTrip(f, 'cover', cause) (§4.11)
12   BREAKING: breaking.update: entities at integrity 0 split into pieces (load breaks across the axis at the load
       point; impact breaks by `fracture`; parents in id order, piece ids allocated in that order, bodies created in
       id order); grace kept while a piece overlaps its breaker (min 10, max 600 ticks); their joints released; nav
       dirty
13   DOWNED, TRIPPED, FELLING
13a    downed.postStep: f.pos ← the slab hip's support point; settle hold; on the frame before getup: stand-spot search
       and hand-back to the KCC (§4.5)
13b    rulers.postStep: tripped rig and f.pos from the body, the pose history tracking the dynamic body every tick
       (RF-1); in-pit (`pit` event on change); pinned (D-38) with hysteresis; get-up at stateFrame ≥ 240 when not
       pinned, with resetHistory and a contact grace (§4.7)
13c    felling.update: moments accumulated this tick (4d, 9c) vs hinge capacity, or remaining ≤ 0 → fall; hinge tear at
       75°; trunk at rest → felled, nav dirty (§4.12)
14   WOUNDS AND RECOVERY: rulerTick(f, DT) for every ruler (30 HP/s recovery unless down (tripped or in a pit),
       stuck, pinned or burning; wounds heal 50 HP per hour of play)
15   DEATHS: deaths.update (parts ×2 if environmental, corpse timers, player respawn at tick + 600); spawner.update
       (ape respawns, sparring ape)
16   NAVMESH: nav.rebuildDirty(): up to tilesPerTick (human 2, ruler 1) dirty tiles, sorted (layer, ty, tx),
       synchronously; tile versions bumped (§7)
17   ELEMENTS 10 Hz / TERRITORY, DECAY, TRAPLINES 1 Hz (SPEC:702): empty hooks in M1 (tick % 6, tick % 60)
17b  NOISE: noise.collect(world, ce, events) turns this tick's combat and world events plus footsteps into noises;
       noise.fold(minds) adds them to awareness; the bus is empty afterwards
18   entities.mirror(): pose/vel/prevPose from bodies in id order; restTicks; touched
19   SAVE if saveDue: bytes = serializeWorld(world) (end of tick: nothing is pending, MAP gap-7 §3.8)
20   return { combat: ce, world: events, save }
```

Why this order:
- **Movement resolved inside 3** (SPEC:699-700 ask for it after `CombatSim`): CombatSim's own hits must use the
  resolved positions of the same tick; resolving after `step()` put strikes up to 6.1 cm off **[MAP gap-1 §3.1]**.
  SPEC:377's "CombatSim proposes … and the character controller resolves it" still holds word for word. The zone half
  of SPEC:700 runs in 4 because it needs the final rig. Recorded in §12.
- **Damage before breaking** (9 before 12): "an impact's damage is applied before the struck entity breaks, so a stake
  that shatters still delivers its blow" (SPEC:344); a stake removed after the step resists for exactly one step,
  which made the 8 × 6 m pit with 1.0 m stakes wound in 9/9 approaches in the C lab's pit scene **[C lab: e2b_none]**
  but in only 3 of 6 charges at the AC-3 player, and a 0.6 m grid in 15/15 **[I-rev ran: ac3_density.out]** (§11.2).
- **Impulses from contacts land next tick** (9 → next 4d): phase 10's rope fit reads `a = (v_post − v_pre)/DT` with
  v_post the phase-8 snapshot, so nothing applied after the step pollutes it; queued in 4d they fall into the next
  v_pre and drop out of that tick's `a` as well (RF-2). Contact reactions were already "felt next step"; now every
  code impulse takes the same path.
- **Trips switch between steps** (4c): body type and collider modes change outside every callback; the trip tick's
  damage uses the pre-switch store (MAP gap-3 §3.3).
- **Queries lag one step**: scene queries see colliders as of the last step (MAP rapier finding 7). Every system that
  creates or moves bodies (verbs, breaking, felling) does it at a fixed phase in id order, so the lag is identical in
  every run. Rope sensors are re-posed in 4e, before the step, because a collider moved after a step is found by a
  query only inside its old broad-phase AABB until the next step: a 1 m move was found at neither pose **[RF lab:
  q2_move.mjs]**.
- **One event list per tick**: CombatSim's events (phase 3) first, then world events. A KO caused in phase 9 pushes its
  `ko` onto the same combat event array `stepBody()` returned, so the client sees every KO of a tick in one list. A
  state set in phase 9 is seen by `advance()` next tick (one tick of latency for world impacts, MAP gap-2 §8).
- **Noise folded at the end** (17b), so a save at 19 never holds pending noise.

Legacy `CombatSim.step()` = `beginTick()` + `stepBody()` with every seam null: the same statements in the same order
as HEAD's `step()` (combat.ts:288-314), plus one `ko` event per KO from `koFighter`.

## 4. Every rule's implementation

### 4.1 Ground height at every y = 0 site (SPEC:379, D-1; P02a unless noted)

| Site (HEAD) | Today | World mode | Legacy (`FLAT_GROUND`) |
|---|---|---|---|
| combat.ts:795 `separate()` | `f.pos.y = 0` | the mover writes y (KCC feet; ruler terrain height) | unchanged |
| combat.ts:616 `defendProjectiles` | `y < 0` | `y < this.ground.heightAt(px, pz)` | 0 → same |
| combat.ts:1510 and the snap after it, `stepProjectiles` | `low <= 0.01`, `p.pos.y += -low + 0.01` | `g = ground.heightAt(p.pos.x, p.pos.z)`; `low <= g + 0.01`; `p.pos.y += g - low + 0.01` | g = 0 → same floats |
| combat.ts:1495-1505 `stepProjectiles` wall test (`!w.isWalkable(x, z) \|\| w.solidAt?.(p.pos, 0.05)`) | a 2-D wall at any height | **skipped** when `this.world` is set (P02b): `WorldPort.projectile` already casts each flight segment against entities and terrain, and a 2-D `NavWalkable` would read every tree footprint, slope, pit and staked log as a wall even 3 m up (RF-6) | unchanged |
| combat.ts:1367 `addDrop` | `new Vector3(x, 0, z)` | `y = ground.heightAt(x, z)`; unreachable in world mode (`onWeaponDropped` and `onProjectileLanded` return true; P02b asserts it with a dev-mode throw) | 0 |
| footwork.ts:75 `toWorld`, :130 `syncToRig`, :60 `toLocal`, :375 `localTarget` | y = 0 | `toWorld` sets `y = body.ground?.supportAt?.(x, z, body.pos.y) ?? body.ground?.heightAt(x, z) ?? 0`; `toLocal` uses `(world.y − body.pos.y)·k`; `localTarget` adds the planted foot's height above the body origin | `body.ground` null → 0 |
| fighter.ts:527 `weaponFit`, :580 `heightGap`, :566 `canReach` | world target height used as local | target height `− this.pos.y` (MAP tests §7.5 experiment C2: 230/232 legacy tests pass with all fighters at ground 0.5 once these two are relative) | `x − 0 === x` |
| fighter.ts:773 `P.root.y += airHeight/scale` | relative to `pos.y` | — | — |
| ai.ts floor probes (`walkable.isWalkable`/`solidAt`) | 2-D | `combat.walkable = new NavWalkable(world)` (P12): `isWalkable` = the human layer's per-tile walk bitmap (0.2 m cells, a cell is set when a navmesh polygon lies within 0.3 m of its centre); `solidAt(p)` = the per-tile blocker bitmap (fixed, anchored or ≥ 500 kg entities rasterised at 0.2 m); both bitmaps rebuilt with their tile in phase 16, so a `BrawlerAI.steer` think (up to 22 probes, ai.ts:578-600, plus 3 per `room()` direction) costs array reads, not ~66 recast and Rapier queries a tick for three fighting apes (RF-23); `resolve` is unused (the mover is set) | `RectWalkable` |
| apps/client game.ts:775 (`pelvisPos` → `f.pos`) | rule-6 write-back | **deleted** (P31; §4.5) | — |

`CombatSim.add` sets `f.ground = this.ground` when it is not `FLAT_GROUND`, so `Footwork` (which receives the fighter
as its `Body`) reads it.

### 4.2 Character controllers and the player push (`world/characters.ts`, P08)

Per player/ape: one `kinematicPositionBased` body with a capsule collider (`r = CHARACTER_TUNING.capsuleR × s` =
0.3·s, `halfHeight 0.6·s`: 1.8·s tall), groups `G(CHAR, …)` and solver groups `G(CHAR, TERRAIN)` (§2.11; a falling
log passes through it and reaches the player through the zones, MAP rapier §4.2), and one
`KinematicCharacterController(kccOffset × s)` with `enableSnapToGround(0.3·s)`, `enableAutostep(0.4·s, 0.2·s, true)`
("climb" = autostep over low ledges and fallen trunks, D-28), max slope climb 45°, min slope slide 30°,
`setApplyImpulsesToDynamicBodies(false)` (SPEC:374; MAP rapier finding 1).

```ts
resolve(f: Fighter) {                                     // called at the separate() site for standing players/apes
  const c = this.byId.get(f.id)!;                         // by fighter id, never by handle (MAP rapier finding 8)
  if (c.teleport) { c.body.setNextKinematicTranslation(feetToCentre(c.teleport)); f.pos.copy(c.teleport); c.teleport = null; return; }
  world.verbs.tether(f, f.pos);                           // drag grip ≤ tetherM; held rope end ≤ its length (§5.1, §5.12)
  const t = c.col.translation();                          // pose as of the last step (MAP gap-1 R1)
  if (f.jumpRequest > 0 && c.grounded) { c.vy = CHARACTER_TUNING.jumpSpeed * Math.sqrt(f.scale); c.grounded = false; f.jumpRequest = 0; }
  const dy = c.grounded ? 0 : (c.vy -= 9.81 * DT) * DT;   // dy 0 when grounded (MAP rapier finding 5)
  c.cc.computeColliderMovement(c.col, { x: f.pos.x - t.x, y: dy, z: f.pos.z - t.z },
    QueryFilterFlags.EXCLUDE_SENSORS, G(CHAR, TERRAIN | ENTITY | RULER_SOLID), c.excludeHeld);
  const m = c.cc.computedMovement();
  const x = Math.fround(t.x + m.x), y = Math.fround(t.y + m.y), z = Math.fround(t.z + m.z);   // f.pos == Rapier's f32 (MAP gap-1 R4)
  c.body.setNextKinematicTranslation({ x, y, z });
  f.pos.set(x, y - c.footOffset, z);
  const wasAir = !c.grounded; c.grounded = c.cc.computedGrounded();
  if (wasAir && c.grounded) { this.landed(f, -c.vy); c.vy = 0; }
  for (let i = 0; i < c.cc.numComputedCollisions(); i++) this.queuePush(f, c.cc.computedCollision(i));
}
```

- **Player push 500 N** (SPEC:374, 881): for each computed collision whose collider belongs to a dynamic,
  non-anchored entity, once per body per tick, queue an impulse `pushN × DT` along the horizontal `−normal1`; applied
  in 4d in entity id order. Friction decides: an 800 kg hull needs 0.7 × 800 × 9.81 = 5,494 N, a 40 kg log ~255 N.
  Measured: 800 kg hull moved 0.000 m, 40 kg hex log 2.26 m (walk) / 8.19 m (run) in 3 s **[C lab: e6_kcc]** (AC-6
  part 1). The 150 kg log moved 0.001 m (dragging is the verb for it).
- **Landing** (`landed(f, v)`): a hard landing scores one impact by the rule on bone `shinL` (feet first), m_eff = the
  shin's bone mass, v_n = v, s = 0, against terrain (or the entity under the feet, from `supportAt`), minus the
  species' safe landing (§4.3). `v > landingKnockdownSpeed` (9 m/s) also knocks the fighter down (slab, §4.5).
- **Spacing between fighters stays `separate()`'s** (scale-weighted, includes limb overlap): characters are not in each
  other's KCC filter (with them in, both stop at capsule contact and `separate()` and the KCC fight: 161 cuts in 120
  ticks, MAP gap-1 §4).
- **Teleport** (spawn, respawn, load, dev): `World.teleport` sets `c.teleport`; the KCC sweep is skipped that tick;
  the fighter's zone history is reset and its contacts get a grace (§4.3), so the jump is never read as a velocity.
- **Crouch height** (new): while `MOVE_CROUCH` is set, or the fighter holds a stooped work posture (`workLow`,
  `digScoop`, `crouch`, the `tug` script), the capsule's half-height shrinks so the capsule is
  `CHARACTER_TUNING.crouchHeightFrac` (0.7) of its height with the feet fixed (`collider.setHalfHeight`, the body
  re-centred): an ape is 1.39 m tall crouched instead of 1.98 m, which is what lets it reach bait under a deadfall
  (§11.2(a), RT-4). Standing up is deferred while a capsule cast at full height from the feet hits anything (headroom).
- Mid-size creatures use the same setup (SPEC:380). The giant does not (§4.7).

### 4.3 The contact pipeline and the damage rule (`world/contacts.ts`, `world/damage.ts`, P09)

**Pre-step store (phase 5).** For every awake dynamic body (entities, slabs, the tripped ruler) and every zone
collider, keyed by owner:

```ts
interface PreState { p: V3; q: Quat; v: V3; w: V3; com: V3; prevP: V3; prevQ: Quat; carryV: V3 }
```

- Dynamic bodies: `v`, `w` = `linvel()`, `angvel()` read before the step (the velocity they arrive with, before the
  solver resolves the new contact). A ball dropped 1.4 m raised `started` on the step whose start pose already
  overlapped; stored pre-step vy −5.232 vs −5.241 m/s analytic; post-step 0 **[A lab: timing.mjs (b)]**.
- Kinematic zones: `carryV = (pose_{N−1} − pose_{N−2}) / DT` (the previous tick's rig delta). Rapier's narrow phase
  tests start-of-step poses, so an event at step N is the overlap of the poses set one tick earlier; with an
  accelerating sensor the event step's start pose was reached at 48 m/s while that tick's own delta was 96 m/s
  **[A lab: timing.mjs (a), (c)]**.

**History resets and grace (RF-1).** The pose history is only true while the zones move continuously. At every
discontinuity Rapier raises fresh `started` events for whatever the zones now overlap (a sensor re-enabled over a
stake, a 5 m kinematic teleport onto it, a lying dynamic body switched back to sensors: `stopped, started` on the first
step **[RF lab: e1_reenable.mjs]**), and a stale history would read the jump as a velocity: between the trip pose and
the get-up 4 s later the giant's colliders move 4.09-11.7 m, a stale `carryV` of 245-700 m/s for one tick, millions of
HP on a stake **[RF lab: stale.ts]**. So:
- `ZoneBodies.resetHistory(f)` / `RulerBodies.resetHistory(f)` set poses N−1 and N−2 to the current pose (`carryV` = 0)
  on: every `setEnabled(true)` (slab hand-back, get-up), `World.teleport`, respawn, load, and the ruler's
  kinematic ↔ dynamic switch both ways; and every tick while the ruler is tripped the history is pushed from the
  dynamic body's pose (13b), so it is fresh at the get-up;
- each of those calls also opens a contact grace: `contacts.grace(f.id, tick + DAMAGE_TUNING.zoneGraceTicks)` (2).
  A pair of that fighter that starts during the grace is recorded as touching (it counts toward the episode below)
  but is never scored. Unit test (P09): a zone re-enabled, teleported, or switched to sensors over a fixed stake
  scores 0 J; the same zone then moved into the stake at 5 m/s scores as usual.

**New contacts: episodes (RF-12, RT-16).** Owners order `terrain < entity < fighter < rope`; the pair list is sorted
by (lower owner, higher owner, parts) before processing. Every `started` and `stopped` collider pair updates a
**touching count per (creature, other owner)** (all of the creature's colliders: zones, slab, ruler bones; all of the
other owner's colliders; terrain tiles merged into one owner). An **episode** begins when the count goes 0 → 1 and
ends when it returns to 0. Scoring:
- a contact is scored once per episode, at its first tick: of the creature's colliders that start against that owner
  in that tick, the one with the largest E (a log landing across two bones is one impact; a log falling through a
  standing body scores the first bone it meets, the rest of the episode is the same impact);
- a new episode within `DAMAGE_TUNING.impactCooldownTicks` (6) of the end of the last one with the same owner is a
  bounce, not scored;
- different owners are different episodes: three stakes under a falling ruler are three hits, each may open its own
  wound (D-20);
- the counts, episode starts and cooldown ends are saved (`contacts` in `SaveV1`, RR-19).
For an entity target (integrity, 9c) the same episode rule applies per (entity, other owner).

**Never scored:**
- a fighter's zones against the entity it holds, drags or tows by rope;
- **the attacking limb**: while a fighter is in `state 'attack'`, the zones of the move's limb chain against *any*
  collider (entities, ruler zones and bodies, slabs, terrain). Melee is CombatSim's (rule 6): a kick on the giant's
  shin is scored once, by `rulerHit`, never again by the contact pipeline as a 4.5 kg shin meeting an 859 kg bone
  (which would have been 503 J, 28 HP, *to the kicker*, RF-3); a strike that meets the world is the strike seam's (§5.2);
- an entity just released by a fighter (`drop`, `throw`, `place`: `Entity.releasedBy`) against that fighter's bodies
  until they have been apart 2 ticks, so a 40 kg log thrown from the hands doesn't hit its thrower (16 J and a
  116 N·s reaction measured in the review, RF-3);
- KCC capsules (they are not damage colliders; zones are); a fresh piece in its grace (§4.10); a fighter's pairs
  during its contact grace (above);
- any impact with `E < minImpactJ` (5 J) and `|Δv| < flinchDv` (0.5 m/s), so a log brushed by a shin doesn't make
  anyone flinch.

**Normal and point.**
- *Solid pairs* (any dynamic body vs anything; tripped ruler bones; slabs): `world.contactPair(a, b, (m, flipped) =>
  …)`, normal = `flipped ? −m.normal() : m.normal()` (MAP rapier §4.5); points = `solverContactPoint(i)` when
  `numSolverContacts() > 0`, else the manifold's `localContactPoint1(i)` through collider 1's pose; manifolds with
  `numContacts() === 0` are skipped. Heightfield manifolds carry points and normals but 0 solver contacts **[A lab:
  normals.mjs (2)]**.
- *Sensor pairs* (zones, rope): `zoneShape.castShape(zonePoseAtStartOfPrevStep, rot, carryV, otherShape,
  otherPoseAtStartOfPrevStep, otherRot, otherV, 0, 1.5·DT, false)` (`Shape.castShape`); normal = the hit's `normal1`
  (out of the zone); if the cast misses because they began overlapped, normal = −v̂_rel. `contactCollider` at the
  event gave normal (0,1,0) and v_n 0 in 3 of 4 sensor cases; the cast gave the right normal and v_n in 4 of 4
  **[A lab: normals.mjs (1)]** (departure from SPEC:280, §12).

**v_n** = closing speed along the normal from the stored state: `v_point = v + w × (p − com)` for bodies, `carryV`
for zones; `v_n = max(0, (v_other − v_self) · n)` with n out of self.

**Self-motion (RF-3).** For a creature side, split the closing speed: `own = max(0, v_self · n)` (its own body moving
into the other) and `brought = max(0, −v_other · n)` (the other side moving into it). The contact is **self-motion**
when `own ≥ brought` (`selfMotion()`, `world/damage.ts`): the creature ran, fell or was carried into something. Then
SPEC:284's safe landing applies ("a body hitting the ground or a wall"): for a blunt contact (s = 0) the creature's E
is reduced by ½·m_bone·v_safe², whatever the other side is (terrain, a fixed stake, a free log, another creature's
zone); and no Δv or flinch comes from it (the controller, `separate()` or the solver already stopped the body). A
sharp point leading into it keeps the full E: running or being knocked onto a stake hurts, which is SPEC:415's
hazard. When the other side brings the speed (a log falling on it, the giant's charging leg meeting the player), the
full rule applies to the creature, Δv included. Each side of a creature-creature pair is judged from its own side:
the giant's charge is self-motion for the giant (no damage to it at 14.07 m/s v_safe) and not for the player.

**m_eff** (SPEC:278, orchestrator decision 2):

| Pair | m_eff |
|---|---|
| creature zone, slab or ruler bone vs dynamic entity | `reducedMass(mb, me)`, mb = `boneMass(d, bone)` |
| creature vs fixed/anchored entity or terrain | mb |
| ruler zone vs another creature's zone or slab | `reducedMass(mb_ruler, mb_other)` |
| entity vs entity | `reducedMass(m1, m2)`; a fixed/anchored side → the other's mass |
| entity vs terrain | the entity's mass (for its own integrity) |

`boneMass(d, bone) = d.mass × d.boneShare[bone]`; with `SPECIES_BODY[species].massShareMode === 'zone'` it is
`d.mass × zoneMassShares()[BONE_ZONE[bone]]` instead (a playtest lever, §4.15; default 'bone' for every species).

**Sharpness leading test** (SPEC:281). A sharp point (tip t, outward dir d, sharpness s) on either body leads when the
contact point is within `tipRadiusM` (0.15 m) of t and the other side's velocity relative to the point's body
satisfies `−v̂_rel · d ≥ leadingCos` (0.7, DS's `dir·v̂ > 0.7` in `projectileStrike`); s = the max over leading points
of both bodies. Melee never applies it again (SPEC:283).

**Energy and hard landings.**

```ts
E = 0.5 * mEff * vn * vn * (1 + DAMAGE_TUNING.kS * s);                      // kS 3
if (DAMAGE_TUNING.hardLandingBluntOnly && s === 0 && targetIsCreature &&
    (other is terrain || other is fixed/anchored || selfMotion(vSelf, vOther, n)))
  E = Math.max(0, E - 0.5 * mb * SPECIES_BODY[species].vSafe ** 2);         // SPEC:284, D-4; self-motion (RF-3)
damage = hpFromEnergy(E, T);                                                // max(0, E − T) / 18, T = zone toughness + armour
```

v_safe = 6·√scale (D-4): human 6, ape 6.29, giant ape 14.07 m/s. With it the tripping ruler's terrain landings
(chest up to 8.2 m/s) score 0 HP; with 6 m/s the same landing would be ≈ 2,264 HP for merely falling over **[A lab:
pit.ts]**, and the AC-5 trip itself would be a 637 HP wound **[C lab: e5_trip, F13]**. Entity integrity always uses the
full E (v_safe only reduces the creature's own damage).

**Throw cap** (SPEC:285): `launchSpeed(m, techSpeed) = min(techSpeed, √(2 × 400 J / m))` (`sim/rules.ts`), used by
every throw (§5.11) and by `release` (combat.ts:1416) when `f.throwAim` is set.

**Calibration** (SPEC:292-301 with bone m_eff, MAP spec-m1 derived numbers): 300 kg log dropped 4 m (8.86 m/s) onto
the giant's chest bone (2,865 kg): m_eff 271.6 kg, 10,656 J → 370 HP (spec 390 HP with 281 kg); on the head bone 287
HP; the shin (859 kg) falling 3 m onto a 0.6 stake: 70,825 J → 3,713 HP (spec 2,982 with 700 kg); axe perfect counter
73.98 dmg → 1,331.7 J → 40.65 HP on a knee. Tests that assert calibration rows use a 1 % tolerance on these values
(D-3).

**Spike pit with bone shares** (the reason for decision 2): over 108 pit runs the giant died in 4 with per-bone m_eff
and in 45 with HurtZone masses **[C lab: e2_pit, e2b_robust, F8]**; an 8 × 6 × 2.5 m pit with 48 stakes 1 m apart
wounded it in 9/9 approaches (474-939 HP each) and never killed it **[C lab: e2b_none]**, but the same pit and stake
model met by a charge toward the AC-3 player wounded it in only 3 of 6 runs, and a 0.6 m grid (108 stakes) wounded it
in 15/15 runs (6 AC-3 charges, 9 AC-2(b) approaches; 385-3,084 HP of pit damage per run, so never a kill) **[I-rev ran:
ac3_density.out]**. The recipes use 0.6 m (§11.2(b), §11.3).

### 4.4 Melee through the rule, knockback, world impacts on fighters (`sim/combat.ts` P02a/P02b, `sim/impact.ts` P09)

**Melee on players and apes** (`hit()`, combat.ts:1113): DS's damage formula is unchanged (perks already removed),
then

```ts
const T = zoneToughness(d, zone);                               // d.toughnessJ (0 human/ape) + d.armour[zone] ?? 0
if (T > 0) dmg = Math.max(0, dmg * DAMAGE_TUNING.meleeJPerDmg - T) / DAMAGE_TUNING.K;   // E = dmg × 18 (SPEC:283)
```

With T = 0 the line is skipped, so `dmg` stays bit-identical to DS (`(x·18)/18` is not always `x` in floating point).
Armour (SPEC:417, 885): a worn item adds its material's `armourJ` (hide 20 J, bone 40 J, §2.1) to the zones it covers
(`Fighter.armour`, derived when the worn items change; wearing items is not an M1 verb, the data path is). Unit test
(P02b): changing only a material's `armourJ` changes `zoneToughness`, and no armour code names a `MaterialId` (RR-3).

**DS's instant kills go through the rule when there is toughness (RR-12).** `hit()` sets `d.hp = 0` for a crown-split
(combat.ts:1179-1181) and for a lost head or leg (combat.ts:1205-1207) whatever E and T are. P02b gates both on
`T === 0 || E > T` (E = the blow's `dmg × meleeJPerDmg`): with M1's 0 J humans and apes nothing changes (and legacy
stays bit-identical), but an armoured zone (+20/+40 J) or M4's 300 J brute hide (SPEC:288) can no longer be split by
a blow that does no damage. Rulers skip both anyway (§4.6). TODO at the limb rule (combat.ts:1199, `allowed = d.team
!== 'player' || ko`): "multiplayer: check for death, not KO (SPEC:423)" (RR-22).

**The giant's charge against a standing player is a contact, not a push (RF-5).** `separate()` pushes overlapping
fighters apart by position, 96.8 % of the overlap weighted by scale² (combat.ts:765-790), using `bodyCapsules`
that are fatter than the Rapier zones (the giant's chest capsule r 0.825 m against a 0.55 m half-deep chest box,
bodyShapes.ts:16-19, ragdoll.ts:142), so a charging giant would bulldoze the player sideways each tick and its zones
would barely touch him: no rule impact, no launch. In world mode `separate()` therefore skips the positional push
for a pair with a **standing ruler** when their closing speed along the line between them exceeds
`RULER_TUNING.separateSkipSpeed` (1.0 m/s); the zones then overlap and the contact pipeline scores the hit in the
same tick's phase 9 (the player's zone is a sensor target: full rule, Δv, launch). Below 1.0 m/s (a giant walking
into a player who stands still) DS's push stays. P20's dodge-table test runs with the real `separate()`.

**Thrown weapons in world mode** (D-12): `projectileStrike` (combat.ts:1533) computes E by the rule (m_eff =
`reducedMass(weapon mass, boneMass(d, bone))`, v = the projectile's speed relative to the bone, s = DS's `leading` test
× `WeaponDef.sharpness`, default `edge === 'blade' ? 0.8 : 0`), then calls `hit()` with a new trailing parameter
`ruleDamageHp = hpFromEnergy(E, T)` that replaces the multiplier chain (`damageMul`, heavy, counter) and keeps DS's
knockback, hitstun, gore and events. The legacy path never passes it (tests call the private `hit()` positionally;
only a trailing defaulted parameter is safe, MAP tests §7.7).

**Melee knockback** stays DS's `pushScale` (SPEC:305). **World-impact knockback** is Δv = p/(M + m).

**`applyImpact(sim, i)`** (MAP gap-2 §8b-8e; coefficients in `IMPACT_TUNING`):

| Output | Rule |
|---|---|
| HP | `hp = hpFromEnergy(E, T)`; `d.hp = max(d.minHp, d.hp − hp)`; rulers: §4.6 instead. TODO at this line "rule 11 (multiplayer): damage from an entity credited to another player knocks down, never kills" (SPEC:72, RR-22) |
| Δv | `dv = (1 + creatureRestitution·[impactor is a creature]) · m_imp · v_rel / (M + m_imp)` in 3-D (M = `d.mass`; m_imp = the entity's mass, or the striking ruler bone's mass; `IMPACT_TUNING.creatureRestitution` 0, a lever, below). **Applied only when the pair is a sensor pair (a standing player's or ape's zones, or a standing ruler's zone meeting a slab) and the target is not a standing ruler**: in a solid pair (anything vs a slab, the tripped ruler) the solver already exchanged the momentum, and a standing ruler's only momentum transfer is the mover's shove and the impact-trip check (SPEC:305) (RF-4). Zero for static impactors, terrain and self-motion contacts (§4.3) |
| launched | the part of dv not into the ground ≥ `launchDv` (5 m/s; above every DS move's knockback, max 4.6) |
| pressed | `dv · up ≤ −launchDv` (a crush from above): knockdown, no launch |
| knockdown | `poise ≤ 0 \|\| launched \|\| pressed \|\| isAirborne()`; poise −= `poisePerHp · hp · (s = 0 ? bluntPoiseMul : 1) · (1 − staggerResist)` |
| hitstun | otherwise when `hp > 0 \|\| \|dv\| ≥ flinchDv`: `enterHitstun(round(hitstunBase + hitstunPerHp·hp), impactReaction(zone, weight), 0.25 + hp/12)` |
| standing push | not launched: `d.vel += dv_xz` (DS slide) |
| reaction | whenever Δv was applied to a sensor target: impulse `−M·dv` on a dynamic impactor, **queued** (`entities.queueImpulse`) and applied in 4d of the next tick (RF-2): a 300 kg log on the player keeps `v − M·dv/m` (86 % of its speed measured) instead of stopping dead **[C lab: e6_kcc, F14]** (AC-6 part 2) |
| already down | knockdown/getup/slab active: HP applies; for a sensor pair (a standing ruler's zone stepping on the slab) dv goes to the slab (`downed.queueDv`); for a solid pair (a log on the slab) nothing (the solver did it); never `enterHitstun`; a second launch resets `stunFrames` |
| KO'd | no HP, no second `ko`; dv to the corpse slab as above; `impact` with `corpse: true` |
| gore | none from world impacts in M1 (TODO "impact gore": DS gore is keyed by weapon id, MAP gap-2 §4.6) |
| lastKnock | `d.lastKnock = { tick, cause, by: cause.fighterId }` when `\|dv\| > 0` |

Worked (bone m_eff): a 300 kg log dropped 4 m on a human head: m_eff 5.4 kg, 212 J → 11.8 HP and *pressed* (Δv 7.1 m/s
down) → knockdown; on an ape's chest bone 735 J → 40.8 HP. The ruler's charge at 6-7 m/s into a player's chest bone:
m_eff 14.9 kg → 269-366 J → 14.9-20.3 HP, Δv 5.85-6.83 m/s → launched (rule 9; kill-cam trigger 4) **[A lab:
numbers.mjs; RR lab: checks.out]**.

**Rule 9 and SPEC:417 against SPEC:278 (RR-6), flagged.** With m_eff from the struck bone (SPEC:278), the giant's only
M1 attack takes five charges to kill a player and flings him 6-7 m/s, a few metres; armour removes 7.4 % (hide) or
14.9 % (bone) of a ruler hit. SPEC:417 says ruler blows "deliver tens of thousands of joules" and armour "is nothing
against a ruler", rule 9 wants "a ruler flinging a player across a valley", SPEC:24 calls rulers "deadly". This is a
conflict inside the spec, recorded as departure X20 and in the AC-9 playtest notes (`docs/M1-PLAYTEST.md`), with two
levers inside the rule, both **off by default** so the calibrated numbers stand until a playtest asks:
- `IMPACT_TUNING.creatureRestitution` (0): Δv × (1 + e) for creature-on-creature impacts (e = 1: 11.9-13.9 m/s);
- `IMPACT_TUNING.unbackedTargetMassRatio` (Infinity = off): when the impactor bone outweighs the whole target by this
  ratio, the target's side of m_eff is its whole body mass (a 73.3 kg player can't be "backed" by the rest of a body
  against a 2,865 kg bone): 71.5 kg → 71.5-97.3 HP per charge **[I-rev ran: rev.out §6]**. TODO "ruler blows
  (SPEC:417)" at both.

**`koFighter(d, finish)`** (combat.ts, P02a) replaces every direct `enterKO()` (in `hit` at HP ≤ 0, fatal, sever,
`bleed`, and `applyImpact`): it returns at once if `d.state === 'ko'` (so `onKO` never runs twice, MAP gap-2 §4.5),
calls `d.enterKO()`, then `world?.onKO(d, finish)` (which classifies through `isEnvironmental` in `sim/impact.ts` and
runs the parts/death flow; legacy: `{ environmental: false, credit: [] }`), and pushes `{ type: 'ko', victim, by,
killer, cause, environmental, credit, point }`. combat.ts never imports a world module. DS's `hit.ko` flag and
`bleedout` event stay.

**Environmental kills** (SPEC:415, D-31). `lastKnock` is also set at every DS knockback site (`hit` knockback,
`block` pushes, the weak-swing bump in `applyStrike`, the teep in `resolveJams`). At `koFighter`, with
`W = round(envKillWindowS / DT)` = 120 ticks:
1. `by 'impact'`, `cause.kind 'entity'`, `!cause.held` → environmental (stakes, logs, boulders, felled trees, swinging
   logs). Credit = `cause.credit` ∪ the knocker's player id when `tick − lastKnock.tick ≤ W`.
2. `by 'impact'`, `cause.kind 'terrain'` (a fall, the ledge) with `lastKnock` within W → environmental; credit = the
   knocker's.
3. `strike`, `thrown`, `fatal`, `sever`, `bleed`, and impacts by a creature's body → not environmental (a thrown object
   stays `held` until its first contact or rest, D-31).
The window is inclusive: knock at t, KO at t+120 → environmental; t+121 → not.

### 4.5 The downed and launched body (rule 6; `world/downed.ts`, P08)

Replaces `externalKnockdown = true` (game.ts:181) and the pelvis copy (game.ts:775), SPEC:652, 890. Per player/ape,
created with the fighter and **disabled**: one dynamic body with `ColliderDesc.roundCuboid(0.20·s, 0.865·s, 0.06·s,
border 0.04·s)` (0.48 × 1.81 × 0.20 m at s = 1), `setMass(f.mass)`, friction 0.9, restitution 0.05, linear damping 0.05,
angular damping 0.6, CCD on, groups DOWNED, `COLLISION_EVENTS`.

- **Enable (4a)** when a fighter enters `knockdown` or `ko` this tick, or `applyImpact` returned launched/pressed:
  pose = the fighter's (centre at `pos.y + 0.905·s + airHeight`, long axis vertical, yaw); linvel = `(f.vel +
  f.walkVel)_xz` with a 0.8 m/s floor along the blow, plus `(0, liftBase + liftPerLift·lift, 0)` (1.2 + 3·lift, DS
  game.ts launch), plus any queued dv; angvel = `toppleRadS / √s` (2.5) about `up × dir`; zero `f.vel`, `f.walkVel`;
  disable the KCC body and the zone body; emit `launch { f, vel, angVel }` (the client ragdoll copies it). Reading
  `f.vel` after `stepBody()` inherits every DS knockback rule (KO +1.5, fatal +0.6, sever +1, blade ×0.4, pushScale up to
  3). Hip travel vs today's ragdoll: −23 % … +36 % over six blows **[MAP gap-4 §4]**.
- **While down (13a)**: `f.pos.x/z = hip.x/z`, `f.pos.y = supportAt(hip)`; `combat.physicsOwnsDowned = true` stops
  `locomote` integrating. Damage while down comes from slab contacts: the contact point's height `h` along the slab's
  long axis (from the foot end, × 1/s) picks the bone: < 0.50 shin, < 0.94 thigh, < 1.09 pelvis, < 1.29 abdomen,
  < 1.55 chest, else head; L/R by the side of the axis; so m_eff stays a bone mass.
- **Get up**: at `stateFrame ≥ stunFrames − 1`, if the slab is faster than `settleSpeed` (0.5 m/s), hold
  (`stunFrames = stateFrame + 1`, at most `settleMaxHold` 300 extra frames). On the frame before getup, the stand-spot
  search casts the standing capsule down at the hip, then 8 directions × 0.35/0.70/1.05 m in fixed order, and accepts the
  first whose `normal1.y ≥ cos 45°` and that `intersectionWithShape` finds clear (excluding the slab). Then the slab is
  disabled, the KCC enabled and teleported there, the zone body enabled with `zones.resetHistory(f)` and a contact
  grace (§4.3: re-enabling zones beside a 300 kg log would otherwise score the log as hitting them, RF-1); DS's
  `advance` calls `enterGetup()` as today.
  Verified on a 25° slope, across a fixed log, beside a 300 kg log **[MAP gap-4 §6]**.
- **KO**: the slab stays as the corpse body until the corpse timer (§4.14).
- **Legacy** never enables a slab: `physicsOwnsDowned` stays false and the DS slide code runs.
- A lying capsule rolls 8.07 m in 5 s on a 10° slope and never rests; the slab rests up to 40° **[MAP gap-4 §3]**
  (departure from "dynamic capsule", §12).

### 4.6 The ruler in CombatSim, wounds and recovery (`sim/ruler.ts`, P11)

At the top of `hit()` (P02b): `if (d.ruler && this.world) return this.world.rulerHit(a, d, m, point, dir, zone, bone,
power, haft, thrown, ruleDamageHp);` → `rulerHit`:
1. `dmg = blowDamage(a, d, m, power, haft, thrown)` (the perk-free DS formula in DS's order; rulers have defense 0,
   D-13). Melee: `E = dmg × meleeJPerDmg`. Thrown in world mode: E from the rule (as §4.4; `ruleDamageHp` carries it).
2. `n = (point − volumeCentre)/r`; `rz = classifyRulerZone(d, bone, point, n)`; `T = rulerToughness(rz) + armour`;
   `hp = hpFromEnergy(E, T)`.
3. `wound = rulerDamage(…, hp, rz, bone, { kind: 'creature', entityId: null, fighterId: a.id, credit: a.playerId ?
   [a.playerId] : [], held: true, feature: 'creature' }, point)`.
4. Attacker: `E > T` → `a.impact('stick', max(4, hold), heavy ? 16 : 12)` (the 60-tick landed cycle MAP gap-6
   measured); `E ≤ T` → `a.impact('rebound', 3, 11)` and a `bump` event ("bruises and pushes but does no damage",
   SPEC:282).
5. **Skipped for rulers**: poise, knockdown, hitstun, `d.vel` pushes, `headStrike`/fatal, DS cut (`addWound`), sever,
   tear, bleed, stamina drain, buffer/counter clearing (MAP gap-0 §2). The push momentum goes to the impact-trip check
   (§4.7), never to `d.vel` (SPEC:305).
6. Push `hit` with `rulerZone`, `energy`, `toughness`, `damage = hp`.
Also gated by `d.ruler` (P02b): `applyStrike`'s weak-swing bump, `block()` (rulers never block), `resolveJams`' teep
bump, `bleed()`. `retarget`'s size bias and `locomote`'s lock range use `min(scale, RULER_TUNING.lockScale)` (2) for
rulers, so the player doesn't square up from 14.85 m (MAP gap-0 §6.6).

**`rulerDamage(…, hp, zone, bone, cause, point)`** (SPEC:500-506; thresholds are "above", so strict `>`, RR-8):
- `hp > woundFrac × maxHp` (240 HP) → a new wound (`severe` when `> severeFrac × maxHp`, 1,800 HP; effect by zone,
  §2.9); every severe wound lowers `effectiveMax` by `severePenaltyFrac` (5 %); a `wound` event with `byWorld =
  (cause.kind === 'entity' && !cause.held) || (cause.kind === 'terrain' && lastWorldTrip within envKillWindowS)` (a
  ruler tripped by the world onto the ground counts as wounded by the world, RR-14); the giant's mind receives it as
  `onWound` in phase 17b (`sim/ruler.ts` never imports a mind). A new wound never moves `downWound` (RR-8).
- else if `rulerHeld(f)` (down: tripped or in a pit; stuck; pinned) → **finishing**: added to `downWound` (hp and
  remaining); if there is none, one is opened with `downCause` (D-37) and becomes `downWound`.
- else → `unhealed += hp` (recovers).
- **`downWound` is the wound that put it there** (SPEC:505): the wound opened by the impact that tripped it (the trip
  tick's impact, if it opened one); else, when it becomes pinned with no `downWound`, the newest wound whose cause entity
  is one of the pinning bodies; else the one D-37 opens. `downCause` is the trip's cause (`requestTrip`'s), or the
  pinning body's. Both clear when `rulerHeld` turns false.
- `rulerHp(r) ≤ 0` → `koFighter(d, { by: cause.kind === 'creature' && cause.held ? 'strike' : 'impact', … })`.

**`rulerTick(f, DT)`**: unless `rulerHeld(f)` or burning, `unhealed −= min(unhealed, recoveryHpPerS × DT)` (30 HP/s);
wounds heal `woundHealHpPerHour / 3600 × DT` in total (50 HP per hour of play), oldest first, never above
`effectiveMax` (SPEC:506). TODO at the recovery line: "rule 5 rests on DS stamina here: best-paced axe 18.77-18.91 HP/s
< 30 HP/s recovery; a stamina change must re-check it (§9.3)" (RR-24).

AC-4 with this design (MAP gap-6): a perfect-counter knee hit is 40.65 HP < 240 → `unhealed` → full again 1.36 s after
any hit; honest DS stamina caps the best-paced rate at 18.77 HP/s < 30 (18.91 HP/s in the tests reviewer's count
**[RT lab: numbers.out]**); while pinned the same hits are finishing damage on the down wound and nothing recovers.
Rule 5 holds through stamina pacing: with fresh stamina every swing the axe would do 40.6 HP/s gross against 30 HP/s
**[RR lab: checks.out §5]**. That dependence is a flagged rule-5 risk (RR-24): the stamina constants it rests on are
listed in §9.3 with "rule 5 depends on this", and P11 adds a millisecond unit test that computes the best-paced rate
from the live move and stamina data and asserts it is below `recoveryHpPerS`.

### 4.7 The ruler's hybrid body (`world/rulerBody.ts`, P11)

**Body.** One `kinematicPositionBased` body per ruler for life at the pelvis joint, `setCanSleep(true)` (cannot change
on a live body, MAP gap-3 §1.3), CCD on, 12 colliders in `BONES` order, bone shapes from ragdoll.ts × scale,
`setMass(f.mass × boneShare[b])`, friction 0.9, restitution 0.05, sensors, groups RULER_ZONE,
`ActiveCollisionTypes.ALL`, `COLLISION_EVENTS`. Sensor masses count, so the body weighs 14,000 kg after
`recomputeMassPropertiesFromColliders()` (MAP rapier §4.3, gap-3).

**Standing (4c).** `setNextKinematicTranslation(rig.pelvis.pos)`, `setNextKinematicRotation(rig.pelvis.rot)`, each
collider `setTranslationWrtParent(qi·(rig[b].pos − pelvis) + q·off[b])`, `setRotationWrtParent(qi·rig[b].rot)` (this
raises events against fixed and sleeping bodies even when the parent is asleep, MAP gap-3 e1). Zone velocities for the
rule come from the rig history (§4.3), never from Rapier's pelvis velocity.

**`RulerMover.resolve(f)`** (the `separate()` site; proposal `d = f.pos − posPrev`, speed `v = |d_xz| / DT`):
1. **Ground** (RR-1, RF-14, RT-1): `y_new = world.supportAt(x, z, f.pos.y + stepUpMaxM)`: the terrain, or the top of a
   fixed, anchored or resting (`restTicks ≥ 30` or asleep) entity under the root whose top is less than the ankle
   height (0.39 m at 5.5) above the terrain, found by a downward ray against TERRAIN and ENTITY (taller entities are
   obstacles for the sweep of step 4, never ground). A covered pit is therefore ground until its cover breaks, and a
   cover strong enough to hold the giant holds it up instead of being walked through. The footwork places each foot on
   the same `supportAt` (§4.1).
2. **Slope and step limits** (unless climbing, step 3): if `y_new − f.pos.y > RULER_BODY_TUNING.stepUpMaxM` (1.0 m,
   the ruler nav layer's climb, §7) in one tick, or the terrain under the new root rises along d̂ steeper than
   `maxSlopeDeg` (40°, the nav layer's), the move is blocked along the rise: the root advances only to where the limit
   is met and `walkVel` loses its component along the horizontal uphill gradient (a block, never a trip). So the 18 m
   rim (50-60°) and a dug pit's ≈ 79° walls stop it, on a charge or a scripted straight line as much as on a path
   (RR-1: "a valley nobody leaves"; RF-14).
3. **Climbing out** (RR-1): when `f.drive.climb` is set (RulerMind sets it while `ruler.inPit` and the giant is up,
   §6.4), steps 1-2 are relaxed: the root may rise at most `climbRateMps × DT` (0.4 m/s) per tick at a horizontal
   speed ≤ `climbWalkMps` (0.5 m/s), posture `climbOut`, but only toward a support no more than `climbMaxM` (4.5 m)
   above the pit floor within 3 m ahead (so a pit can be left, slowly and visibly, and the rim still can't: it rises
   18 m). A 2.5 m pit plus a berm of up to 1 m takes ≈ 6-9 s, all of it `rulerDown` (no recovery, every hit finishing).
4. Sweep a vertical capsule (radius `BODY_RADIUS × scale` = 1.65 m, from ankle to hip height) along `d` with
   `queries.castShape(…, { terrain: false, entities: 'all' })` excluding its own body, and collect overlaps at the end
   pose (`overlaps`, sorted by entity id). Obstacles whose top is below the ankle (0.39 m at 5.5) are stepped over. The
   mover never uses a KCC autostep: a 1.9 m autostep climbs a 1 m staked log wall **[C lab: e6_kcc, F6]**.
5. **Shoveable** (dynamic, `mass < shoveLimitKg` 500, not anchored): queue an impulse `m · max(0, v_ruler·n̂ −
   v_e·n̂) · n̂` (n̂ horizontal, from the ruler's centre to the entity): "shoved aside with the ruler's momentum"
   (SPEC:781); `shove` event. Damage to it comes separately from the sensor contact (§4.3).
6. **Blocker** (fixed, anchored, or ≥ 500 kg), at the first time of impact, in this order (D-11):
   1. **Deflect**: t̂ = the obstacle's long axis projected to xz (its collider's principal axis; round trunks: the tangent
      ⟂ n̂), signed so `d̂·t̂ ≥ 0`. If `acos(d̂·t̂) < deflectMaxDeg` (30°): advance to the contact (toi − `sweepSkinM`
      0.05 m), move the rest of `d` **projected** on t̂ (speed × cos θ), set `f.walkVel` to its component along t̂, set
      `ruler.deflectedHeading = atan2(t̂.x, t̂.z)`, emit `deflect`. At 20° this slides along the wall at 5.64 m/s with
      the heading within 0.2° **[C lab: e6_kcc]** (AC-6 part 3).
   2. **Trip** (SPEC:782, 879; D-10): else if `v > tripSpeed` (4 m/s root horizontal speed) and the obstacle's top above
      the ground (`aabbMax.y − heightAt`) lies between the ankle (`bonePoint(rig, 'shinX', 0.43)` height, 0.39 m) and
      the knee (`rig.shinX.pos` height, ≈ 2.2-2.75 m): advance to contact, `requestTrip(f, 'obstacle', cause)` with
      the obstacle's cause (entity id, credit, feature).
   3. **Block**: else advance to contact and zero `walkVel` along n̂.
7. **Ledge** (SPEC:782): `supportAt(front foot) < supportAt(planted foot) − ledgeTripDropFrac × kneeHeight` (0.5 × 2.75
   = 1.4 m) → `requestTrip(f, 'ledge', null)`. It reads `supportAt`, not the bare terrain, so a covered pit is not a
   ledge while its cover stands (RT-1: with `heightAt` the giant tripped `'ledge'` in phase 3 the first tick a foot
   crossed the 2.5 m hole, before phase 11 could load the cover). A ledge trip within `coverTripWindowTicks` (30) of a
   load break under the same ruler (step 8) is reported as `'cover'` with that break's cause.
8. **Cover failure** (the weight trigger, SPEC:458): phase 11, when a load break (§4.11) happens under a planted ruler
   foot, computes `drop = foot.y − supportAt(foot)` with the broken entity and its pieces excluded; `drop >
   ledgeTripDropFrac × kneeHeight` → `requestTrip(f, 'cover', cause)` (cause: the broken entity, `feature 'cover'`).
   Over a pit the drop is 2.5-3.5 m; over the solid rim under a cover's overhang it is a few cm and nothing trips there
   (the next foot over the hole trips by step 7, reported as `'cover'`).
9. **Impact trip** (SPEC:305 "checked against its trip rules"): an impact on a leg volume between ankle and knee by a
   blocking-class impactor (≥ `impactTripMinKg` 500 kg, or anchored) at relative speed > 4 m/s →
   `requestTrip(f, 'impact', cause)` (MAP gap-2 §8e). Smaller momenta are dropped (an 800 kg boulder at 8 m/s would
   give 14 t only 0.43 m/s).

**In a pit (13b, RR-1).** `ruler.inPit` = both planted feet (while tripped: the pelvis) lie more than
`pitDownDepthFrac` × knee height (0.5 × 2.75 = 1.4 m, the ledge threshold) below `terrain.originalHeightAt`. A `pit` event fires
on each change. `rulerDown` (no recovery, finishing to `downWound`) holds while it is tripped **or** in a pit, so a
giant that gets up inside a pit is still down until it has climbed out (SPEC:504).

**Trip switch (4c, outside callbacks, MAP gap-3 §3.3):**

```ts
capture local[b] = pelvis⁻¹ · rig[b]                          // frozen pose (RULER_BODY_TUNING.tripPose 'freeze')
v = Σ m_b·v_b / M;  ω = I⁻¹ Σ m_b (c_b − com) × (v_b − v)        // momentum fit of the zones' velocities from the
                                                               // history, (pose_{N−1} − pose_{N−2})/DT: the previous
                                                               // tick's motion, so this tick's root drop onto a broken
                                                               // cover or off a ledge doesn't leak into it (RF-14)
for each collider: setSensor(false); setCollisionGroups(G(RULER_SOLID, …)); setSolverGroups(G(RULER_SOLID, TERRAIN|ENTITY|DOWNED))
body.setBodyType(RigidBodyType.Dynamic, true); body.recomputeMassPropertiesFromColliders();
body.setLinvel(v); body.setAngvel(ω); setLinearDamping(0.1); setAngularDamping(1.0); setAdditionalSolverIterations(4); enableCcd(true)
f.setState('tripped'); f.stunFrames = round(getupAfterS × 60) /* 240 */; mind → 'down'; emit trip
rulers.resetHistory(f)   // from now on 13b pushes the history from the dynamic body every tick (RF-1)
```

The trip tick's damage uses the pre-switch store. Measured: max part speed 10.1-13.3 m/s (< 30), every part < 0.05 m/s
2.97-3.83 s after impact, no NaN; with a jointed 300 kg staked log and +4 iterations everything settles by 3.35 s
**[MAP gap-3 §2.2]**; on a heightfield: ≤ 13.0 m/s tripped, ≤ 8.4 m/s rising, every body still from +5.58 s **[C lab:
e5_trip]** (AC-5).

**Tripped rig (13b).** After each step, with `T = (body.translation(), body.rotation())`: `rig[b] = T ∘ local[b]`;
the zone pose history is pushed from these collider poses (so it is fresh when the body switches back);
`f.pos = (T.p.x, heightAt, T.p.z)`; `f.pose.root`/pelvis re-expressed in `(f.pos, f.yaw)`; `updatePose` for `'tripped'`
only runs FK, which reproduces the physics rig to 4.7e-7 m (MAP gap-3 §2.2). `'tripped'` is in none of DS's six skip
lists, so melee and throws hit the lying body through `rulerVolumes` (every soft zone is then within reach: collider
centres 0.53-2.36 m up, MAP gap-3). It is added to `locomote`'s external test and `separate()`'s skips (P02a).

**Pinned (D-38).** Each tick while tripped: for each ruler collider, `contactPairsWith` → `contactPair` manifolds with
dynamic non-ruler bodies, `numContacts > 0`, normal from the other body into the ruler with `· up < −pinnedNormalY`
(0.5) → that body rests on it; walk transitively to bodies resting on those; sum `body.mass()` once per body.
`pinned` turns on at ≥ `pinnedKg` (1,000 kg) and off below `unpinnedKg` (900 kg) held for `unpinTicks` (15)
(manifolds persist while the island sleeps; force events stop, MAP gap-3 §2.4). `pinned` event on each change.
Recorded alternative: MAP gap-3 measured that a 2 t log leaning with one end on the ground reads 2,000 kg by this rule
but carries 997 kg; D-38 is binding, and AC fixtures put ≥ 1.5 t fully on the body.

**Get-up (13b).** When `stateFrame ≥ stunFrames` and not pinned: body back to `KinematicPositionBased`, colliders back
to sensors / RULER_ZONE; light (< 1 t) bodies resting on it get the shove rule first so they don't fall through the
sensors; `f.yaw` = the twist of `pelvisRot · kneelPelvis⁻¹` about +Y; pose re-expressed; `f.enterGetup(94, [{ f: 52,
pose: kneel, ease: 'inOut' }, { f: 94, pose: guard, ease: 'inOut' }])` (94 = round(40·√5.5); DS's 1-frame `kneel` key
swept zones at 398.8 m/s, 94 frames peak 13.05 m/s, MAP gap-3 §2.3); `rise` event; the mind goes to `recover`. "Up
after 4 s" = the rise starts at +4.00 s and ends at +5.57 s (§12). During `getup` CombatSim doesn't hit it for 94
ticks (DS behaviour); world impacts still score through its zones. The switch back to sensors calls
`rulers.resetHistory(f)` and opens a contact grace (§4.3): the get-up off the AC-2(b)/AC-3 stakes raises fresh
`started` events for every stake the colliders overlap, which are recorded as touching and never scored (RF-1).

### 4.8 Hit zones of standing players and apes (`world/zones.ts`, P08)

The ruler's pattern without the trip: one kinematic body per fighter at the pelvis carrying 12 bone-shaped sensor
colliders re-posed each tick, groups ZONE, `ActiveCollisionTypes.ALL`, `COLLISION_EVENTS`. A pose history per collider
keeps the poses set at N−1 and N−2 (centre + rotation) for `carryV` and the normal cast, reset at every jump (§4.3).
Disabled while the fighter is down (the slab takes over; otherwise a log hits a standing ghost, MAP gap-4 §6).

### 4.9 Ropes, joints, tripwires (`world/joints.ts`, P10)

- **Taut**: distance between the anchors' world points ≥ `rope.lengthM − tautEps` (1 mm).
- **Tension (phase 10; departure from SPEC:261's formula, §12)**: for each dynamic body B (id order) with at least one
  taut strand group attached, solve the non-negative least squares
  `Σ_k t_k u_k = m(a − g)` (3 rows) and `Σ_k t_k (r_k × u_k) / L = (I_w α + ω × I_w ω) / L` (3 rows), `t_k ≥ 0`,
  where u_k = unit from B's anchor toward the group's other anchor, r_k = anchor − COM, a = (v_post − v_pre)/DT and
  α = (ω_post − ω_pre)/DT with v_pre, ω_pre from the phase-5 store (code impulses of phase 4d are already in them) and
  v_post, ω_post from the **phase-8 snapshot** (the velocities Rapier returned; every impulse a contact causes is
  queued for the next tick, so nothing applied in phase 9 enters `a`, RF-2), I_w = the world
  inertia tensor from `principalInertia` and `principalInertiaLocalFrame`, L = half of B's largest extent (unit
  balance). Lawson-Hanson NNLS, at most `3·n + 10` iterations, at most 8 groups per body (lowest joint ids first).
  With one rope at the COM this is exactly SPEC:261's `T = m(g − a)·û`. Per strand: `t_k / strands_k`; a rope between
  two dynamic bodies takes the max of its two ends' estimates; a held end's rope takes `max(pullN, fitted)`. Push into
  each joint's 3-entry ring; when `max(ring) > ropeKN × 1000` the weakest strand of the group snaps (one per group per
  tick, the rest re-checked next tick); `joint snap` event. Measured: the swinging log's two hanging ropes and a tie
  2.08/2.08/2.95 kN at 45° and 2.94/2.94/5.09 kN at 60° vs 2.94/2.94/5.10 analytic, swing peak 2.33 kN exact; the
  per-end formula read the tie as 0 **[C lab: e3_swing, F5]**; a still 300 kg log 2,943 N; released from horizontal,
  8,771 N peak (spec 8.8 kN): one vine (6 kN) snaps, two strands hold, sinew (18 kN) holds (MAP rapier §5). Limitation:
  a roped body that also rests on something has its support force unexplained by the ropes, so its tension reads low
  (TODO "rope tension with contacts").
- **Sensor capsule** re-posed in phase 4e, before the step, to the anchors' current world points (RF-13).
- **Tripwire load (9d, SPEC:259 "the body's momentum across the rope")**: on a new episode (§4.3) between a rope sensor
  whose both ends are attached (not loose, not held) and a creature (zone, slab, ruler bone) or a dynamic entity:
  n̂ = the horizontal unit ⟂ the rope; `p = M · |v · n̂|` with M the whole creature's mass and v **its root velocity**
  (`f.vel + f.walkVel`; a slab's or the tripped ruler's body velocity), not the velocity of the limb that touched the
  rope (a hand reaching for bait at 0.8 m/s is not the body crossing the rope, RT-5); for an entity, its mass and its
  stored velocity. `load = p / tripwireWindowS` (0.1 s). If `load > ropeKN × 1000 × strands` → snap. Else every
  dynamic end body gets an equal share of impulse `p` along the rope toward the crossing point, **queued** for the next
  4d (RF-2), and an anchored end whose `anchor.capacityN < load` is pulled loose (becomes free) and gets its share.
  A `tripwire` event records the joint, the crosser, the load and what happened. **Exempt**: a fighter's own work
  target and every rope attached to it while the fighter is in `'pickup'` (a work action, the tug script) or
  `'attack'`, and ropes the fighter holds. Numbers **[I verified: fell.mjs]**: a player at 1.5 m/s → 1,099 N (pulls a
  prop stick loose, holds on a vine); an ape at 4 m/s → 3,902 N; the giant at 4 m/s → 560 kN (snaps anything). With
  the shares queued, an ape's 3,902 N crossing that the rule says a vine holds no longer snaps it through the fit (the
  shares were 195 N·s on an 18 kg prop, read as 11.7 kN, RF-2); P10 tests exactly that case.
- **Lash and hinge break (9c)**: any scored impact on either jointed body with `E > joint.breakEnergyJ` removes the joint
  (`snap`). Lashed structures fail at their joints first (SPEC:344): 600-1,800 J is below most log break energies (a
  300 kg dry log: 9,000 J).
- **Bend**: the Bend verb (§5.9) creates the revolute + motor and the holding rope; when the holding rope is cut or
  snaps, `holdsBend` clears and the motor drives the sapling back toward its rest angle (`release` event).
- **Held free end** (Pull, D-26), the **haul model**: the free length never grows while held; each tick, if the
  hand-to-anchor distance is below the free length by more than 1 mm the free length shortens toward it by at most
  `pullHandSpeedMps × DT` (1.5 m/s, reeling in); when the distance is within `haulTautM` (0.05 m) of the free length the
  hand hauls: with `u` the unit from the attached point to the hand and `v_a` that point's velocity along `u`, it applies
  `pullN × clamp((pullHandSpeedMps − v_a) / haulRampMps, 0, 1) × DT` along `u` (ramp 0.2 m/s) to the attached body
  (dynamic), or `felling.addMoment(tree, ((P − H) × F) · axis)` for a notched tree, or tests `pullN` against an
  anchored stake's capacity (pulled loose if exceeded), and the free length becomes the current distance. A kinematic
  hand never pulls with infinite mass (SPEC:268). `pullN` comes from the verb (§5.12). (Revision 2, I-2: applying the
  force only while `distance ≥ free length` made a hauled free body creep: each kick left the rope slack for the next
  ticks, so a 30 kg log crept to 23° in 9.5 s **[I-rev ran: dbg_swing.ts]**; with the haul model 30-40 kg logs end an
  8 s haul at 28-45° (peaks 38-52°) **[I-rev ran: swing_light.out]**. The C lab's e1 and e8 pulls already used this
  form.)
- **Tying off a held end** (`tie` while holding the end, §5.8): the haul force keeps acting through the tie's work
  action, and at `actAt` `joints.tieHeldEnd(j, anchor)` turns the held end into a rope joint to the target at the
  distance of that tick; tying ends the pull. That is how a player holds a hauled-back log and ties it off to a stake.

### 4.10 Breaking (`world/breaking.ts`, P10)

- **Break energy** `E_b = strength.solidJPerKg × mass` (SPEC:344). Each scored contact or strike push with energy E on
  entity e (the rule's E with sharpness, never with the v_safe subtraction) lowers integrity by `max(0, E − E_b) / E_b
  × integrityPerExcess` (1, D-17), in 9c after creature damage.
- **Split** at integrity 0 (phase 12), two ways (RT-7):
  - **load break** (§4.11): the entity **snaps across its long axis at the load point** (`crossCut(shape, axisT)` at
    the point where the load was applied; 2 pieces, or 3 when two load points are more than 0.5 m apart). A bearer
    that gives way under a foot drops in two halves instead of leaving 8 m slivers still spanning the pit;
  - **impact break**: `n = clamp(2 + floor(E/E_b − 1), 2, 4)` pieces (SPEC:344 "2-4"), shapes from
    `fracture(shape, n, rngs.world)` (prisms split along their long axis, splinters; hulls by planes through the
    centroid chosen with the world RNG).
  Either way: material, moisture and credit inherited; integrity 1; each piece's velocity `v + ω × (c − com)` from the
  parent; sharp points kept by the piece containing them. Parents processed in id order, piece ids allocated in that
  order. Joints on the parent are released (`joint release`), their rope ends become loose.
- **Grace until clear** (RF-7): each piece gets `grace = { from: breaker, minUntil: tick + pieceGraceTicks (10),
  maxUntil: tick + pieceGraceMaxTicks (600) }` (the breaker is the owner whose contact or foot load broke it). While
  it lasts the piece's collision filter drops CHAR, ZONE, RULER_ZONE, RULER_SOLID and DOWNED. Each tick from
  `minUntil` (phase 12) the piece's AABB is tested against the breaker's colliders, then `intersectionPair` on the
  overlapping ones; the filter is restored only when the piece is clear, so pieces under a lying 14 t body never
  re-collide inside it and are never depenetrated into a launch (C §7 item 7). At `maxUntil` a piece still inside its
  breaker is removed with a `break` event (crushed). The AC-2(b) and AC-3 labs deleted broken stakes and cover
  pieces; P28/P29 re-measure with real pieces before freezing any number (§11.2(b), §11.3).
- **Decay** (SPEC:346-347) is M2; `age` advances now (`+= DT` while the entity is active).

### 4.11 Load capacity and covers (`world/loads.ts`, P10)

- `capacityN(e) = E_b / loadLeverM` (0.1 m; SPEC:345): a rotten 2 kg branch holds 100 N; a 4 kg one 200 N.
- **Foot loads** (D-39): for each standing fighter, `W = mass × 9.81` shared equally among its planted feet (footwork
  `L`/`R` not stepping; rulers: the same footwork at scale). Under each planted foot, `queries.overlaps(footDisc(r =
  footRadiusM × scale, h = footDiscH 0.06), EXCLUDE_SENSORS, excluding own bodies)` gives the topmost dynamic or anchored
  entity; that entity receives the foot's share.
- **Resting weight**: every dynamic entity at rest passes its own weight on, like a foot.
- **Spreading** (C F7, D-39): an entity that rests on other entities (a `contactPair` manifold with `numContacts > 0`
  whose normal from the support up into it has `· up > supportNormalY` 0.5) passes the total load it receives (its
  own weight plus what rests on it) in **equal shares** to those supports, recursively (depth ≤ `maxSpreadDepth` 4,
  entity id order). Contact impulses are never used to split load: they gave 0-163 N per branch under a 66 kg leaf mat
  (one untouched, some over 100 N from the leaves alone), equal shares give 68 N each with the player on top **[C lab:
  e2c_cover, F7]**.
- **Which entity is tested** (revision 2, I-1): a **covering** (an entity that rests on other entities) passes its
  load down and is **not** itself tested against its capacity ("loads on a cover spread over the pieces under them",
  SPEC:345). The first draft tested everything, so the 66 kg leaf mat itself (leaves: 1 J/kg × 66 kg ÷ 0.1 m = 660 N)
  would have broken under the player's own 719 N step. An entity whose supports are terrain or fixed/anchored bodies
  carries what reaches it and is tested **only where it spans**: a downward ray from the load point, from the entity's
  underside, finds no terrain or fixed support within `LOAD_TUNING.spanGapM` (0.1 m). A branch across a pit spans; a
  branch or a grass bundle lying on the ground doesn't (walking on it never "breaks" it); an upright prop carries its
  load into the ground under its end and is not load-tested (it fails by being knocked or yanked out).
- **Average** each tested entity's per-tick load over `loadWindowS` (0.2 s = 12 ticks, `loadHist`); `> capacityN` →
  `breaking.loadBreak(e, loadPoint, loader)` (it snaps across its axis at the load point in phase 12, §4.10). Loads are
  never pushed into the solver (a 716 N force on a 5 kg mat launched it 12.8 m, MAP rapier finding 14).
- Checks: ten rotten 2 kg branches under a covering hold a 73.3 kg player (719 N, ≈ 72 N each < 100 N) and break under
  one ruler foot (68,670 N) (SPEC:345's example, a P10 unit test with a spawned mat); 20 rotten 4 kg branches over an
  8 × 6 m pit with a 66 kg mat hold the player at 68 N each (ratio 0.34) and break at 6.9 kN each under a ruler foot
  **[C lab: e2c_cover]**. The verb-built cover of §11.2(b) (20 bearers + 30 grass bundles, no mat) holds its own weight
  at ≈ 31 N + 39 N per bearer < 200 N and breaks at 13.7-68.7 kN per bearer under a ruler foot, but it does **not**
  hold a walking player (a bundle on 2-3 bearers passes 240-360 N each): only a full covering spreads a person's step,
  and nothing in the criterion needs the player to cross the cover **[I-rev ran: rev.out §3]**.
- **Ruler**: a load break under a planted ruler foot trips it `'cover'` when the foot's support drop exceeds the ledge
  threshold (§4.7 step 8). **Player/ape**: the KCC becomes airborne and falls; its landing scores (§4.2).

### 4.12 Felling (`world/felling.ts`, P10)

Chop progress is §2.5 / §5.3. The hinge (the uncut wood) holds a fall-direction moment up to

```
M_cap = hingeK × strength.solidJPerKg × density × (π/32) × (remaining × diameter)³        N·m (strength × density is J/m³)
```

with `hingeK` 1,500. Each tick (13c), the fall-direction moment about the hinge axis through H is

```
M = Σ pull/push moments (4d)  +  Σ (E_impact / hingeRad) · max(0, d̂_impact · fallDir) (9c)  −  m_trunk · 9.81 · diameter/2
```

(the last term is the trunk's weight acting at its axis, d/2 behind H; it holds the trunk back on the closed cut).
The tree falls when `M > M_cap`, or when `remaining ≤ fellAtRemaining` (0). For a 30 cm × 15 m green-wood tree (738 kg
above the cut; back-moment 1,086 N·m) **[I verified: fell.mjs]**: M_cap = 15,904 N·m at half, 3,435 at 0.3, 1,018 at
0.2; a 500 N pull through a rope tied 10 m up from 15.6 m away (rope 17.96 m) gives 4,089 N·m on the fall line (falls
at remaining ≤ 0.287: 11 chops) and 2,880 N·m at 45° off it (≤ 0.242: 12 chops); the 1,200 N yank (§5.12) gives 9,813
N·m (≤ 0.409: 9 chops) and 6,912 N·m (≤ 0.358: 10 chops); after the 15th chop the 0.15 rad/s tip carries it past the
hinge against the back-moment (v² left 0.0216 rad²/s²). So the felled-tree trap (SPEC:443) works from a safe distance
on a tree cut to about a quarter, never on one cut halfway, and the AC-3 tree cut to 0.2 tears on the first pulling tick
(net 1,794 > 1,018 N·m). A rigid, breakable lever without a Rapier joint is deliberate: the trunk stays `fixed` until
the hinge breaks, so nothing wobbles, and every load on the hinge is a force the sim applied or an impact it scored (no
joint-force readback, which Rapier's JS API lacks). The fall itself is the hinge model of §2.5.

### 4.13 Dig, dirt and spoil (`world/terrain.ts` P05, `world/verbs/dig.ts` P15)

- **Lower** (`terrain.lower(x, z, depthMul)`): cone kernel (D-40): every vertex within `digRadiusM` (0.5 m) of (x, z)
  drops by `digDepthM × depthMul × (1 − dist/r)` (0.15 m peak), clamped to `original − maxDigDepthM` (3 m, SPEC:97).
  Removed volume = Σ Δh × spacing² = 0.0391 m³ = 58.7 kg of dirt for a full strike on the 0.25 m grid **[I verified:
  fell.mjs]** (a flat disc would be 177 kg, over the 150 kg drag limit). Affected tiles `setShape`, versions bump.
- **Ever dug** (RT-2): `lower` sets `terrain.dug[v] = 1` for every vertex it leaves more than `spoilUndugTolM`
  (0.05 m) below its original height; the mask is never cleared, so ground dug and then refilled still counts.
- **Where the dirt goes** (`dig.ts`): spoil point S = `terrain.findSpoilPoint(x, z)`: the first vertex, searching rings
  of 0.25 m outward from `digRadiusM + spoilMinGapM` (1.0 m) to `spoilSearchMaxM` (15 m) in fixed angular order, that
  has **no ever-dug vertex within `spoilSetbackM` (1.5 m)** and is below original + `spoilMaxRiseM`. Then:
  1. if a dirt pile entity lies within `pileMergeR` (1.5 m) of S and stays ≤ `pileCapKg` (150 kg) after adding: it grows
     (its hull is rescaled to the new volume, mass += 58.7 kg × depthMul);
  2. else if fewer than `maxPilesNear` (12) piles lie within `pilesNearR` (10 m) of S: a new pile (dirt, a low 8-point
     hull of the volume) is created at S;
  3. else the volume is added to the terrain as spoil: `terrain.raise(S, volume)` (an inverted cone of equal volume,
     capped at original + `spoilMaxRiseM` 1.0 m, that never raises an ever-dug vertex or one within `spoilSetbackM` of
     one; any remainder goes to the next spoil point).
  The first draft tested "undug" by height alone, so `raise` cones refilled dug ground and spilled into the hole being
  dug: the 8 × 6 × 2.5 m pit never finished in 100,000 strikes (3,856 m³ dug and re-dumped), even a 3 × 2 × 1.5 m pit
  took 6,851 strikes instead of 250 **[RT lab: spoil2.out, spoil_small.out]**. With the mask and a 1.5 m setback the
  big pit takes 3,573 strikes (3,185 with no spoil at all) and the rim under a cover's branch ends is uneven by only
  0-0.23 m **[RT lab: spoil_setback.out]** (that lab raises terrain only; the first 12 piles are extra bodies near the
  first strikes, which the dig planner of §11.0 drags out of a planned pit's footprint when a strike meets one).
  A ruler pit thus makes ≤ 12 piles and a berm, not 1,180 bodies (over the 600-active-body budget, SPEC:803) lying in
  the pit (departure from SPEC:241, §12). A dig test asserts termination: the 8 × 6 × 2.5 m pit finishes within 1.2 ×
  the no-spoil strike count (3,822 strikes) in P15's kernel test and in the harness (§11.0).
- **The climb-out limit** (RT-24): a dug wall is ≈ 79° (2.5 m over the 0.5 m cone), beyond the KCC's 45°, its 0.4 m
  autostep and a 0.9 m jump, so a player who digs deeper than ≈ 1.3 m can't walk out; he digs a ramp (strikes on the
  wall). Recorded as a playtest note (`docs/M1-PLAYTEST.md`); the harness leaves a pit with a logged `standAt`.
- Then: nav tiles under the dig and S marked dirty; ground cover cells under the dig set to 0; every anchored stake
  whose driven end is now above the terrain is un-anchored (free, awake); `dig` event; noise 15 m.

### 4.14 Parts, death and respawn (`world/deaths.ts`, P09)

- **Creature KO** (`onKO`): spawn `SPECIES_BODY[species].parts` around the hip (count × `envKillPartsMul` (2) if
  environmental, D-30; the i-th part at angle `2πi/n`, radius `IMPACT_TUNING.partsRingR × scale` (0.6 m), `partsDropH`
  (0.3 m) above the ground, in list order), credit = the KO credit; `parts` event. The giant's KO is kill-cam trigger 3
  on the client.
- **Corpses** (RR-11): an ape's corpse (its slab) stays until `corpseDespawnS` (120 s) has passed **and** the player is
  more than `corpseDespawnMinDistM` (40 m) from it, then `removeFighter`; the giant's corpse (its dynamic compound body,
  asleep, no cost) stays for the world's life in M1. Carcasses are not yet entities you can carry or use as bait
  (SPEC:171, 384): departure X21, TODO "carcass entity" (M4, with smell and bait).
- **Player KO** (SPEC:419-423): the hands drop where the player fell (verbs `onDown`), belt and back stay; `death {
  respawnTick = tick + respawnDelayS × 60 }` (600); at that tick: revive (hp, poise, stamina full; DS severed, torn,
  limbDamage and wounds cleared; state `idle`), teleport to (`spawnX`, `spawnZ`) at terrain height (D-33), slab off, KCC
  and zones on; `respawn` event. Built things stay (they are entities). The player's limbs come off only with the
  killing blow (DS rule unchanged).
- **Ape respawn**: `Spawner` (§6.6).

### 4.15 Pace risk (input to AC-9)

With bone m_eff, world impacts on apes are mild **[RT lab: numbers.out "AC-9"; RR lab: checks.out §2; I-rev ran:
rev.out §4]**:

| Hazard | HP on a 90 HP ape |
|---|---|
| a 2 m fall onto a 0.6 stake | 18 (shin) to 61 (chest) **[C lab: e1_final, F11]** |
| knocked into a snag point (s 0.45, leading) at a DS knockback of 2 / 3 / 4.6 m/s | chest 5.2 / 11.7 / 27.6; head 1.9 / 4.3 / 10.1 |
| a deadfall (170 kg staged / 40 kg verb-built) | ≈ 5-10 / 0.7-1.6 (§11.2(a)) |
| a 300 kg log dropped 4 m | 15.6-40.8 |
| a carried 40 kg log dropped from 1.2 m on a downed ape | 8.7 |
| a felled 30 cm trunk | 48 (head first) to 130 (chest) at 12 m (§11.2(d)) |
| the ledge, now 6 m (was 3 m, RR-16) | chest 43.3 (was 10.7); feet first 13.0 (was 3.2) |

AC-2 ("wounding or killing") is unaffected. AC-9's "environmental kill on an ape within 10 minutes" therefore relies on
finishing a brawl-weakened ape (≤ 20-45 HP left) with the world at the right moment, and on the Clearing's content
(§6.7: a close ape home with a snag, the 6 m ledge, the starter cache). Because only the human playtest (SPEC:906)
would otherwise find out, and late, a **non-gating headless rehearsal** (`packages/sim/tests/ac9.rehearsal.test.ts`,
P39, §11.9) plays a scripted player against a brain-on ape in the generated Clearing and must reach `ko {
environmental: true }` within 36,000 ticks; if it can't, a lever is pulled before the playtest (RT-12). The levers, in
order: (1) `SPECIES_BODY.ape.massShareMode = 'zone'` (tuning, no code); (2) `CLEARING_TUNING.ledgeDropM` and snag
sharpness; (3) a property-based crush rule (a zone backed by terrain or a fixed body counts as static for the impactor,
so m_eff = the impactor's mass: a 170 kg log at 4.6 m/s would deliver 1.8 kJ → 100 HP), recorded as an open TODO "crush
rule", not built in M1. The giant's charge levers of §4.4 (`creatureRestitution`, `unbackedTargetMassRatio`) are the
rule-9 counterpart, for the "flung across a valley" note of the same playtest.

## 5. Verbs

### 5.0 Rules every verb shares (`world/verbs/*`, P14-P17)

**Summary** (payload fields beyond `tick, player, kind: 'verb', verb`; controls in §5.14):

| Verb | Payload | Preconditions (properties only) | Effect | Work action (frames) |
|---|---|---|---|---|
| focus | `target`, `at` | target within 2.5 m | `f.verbAim` = the focused surface point (§5.2) | none, immediate |
| take | `target` (or a rope sensor's joint via `target` = rope entity) | not fixed/anchored/rooted/tied; mass ≤ 150 kg × scale² | wield / carry / drag / take a rope end (§5.1) | `18 + 0.8·m` |
| drop | — | something in hands | release at the hand (§5.1) | 12, any state |
| stow / draw | `slot` 0-3 | belt: ≤ 4 kg and ≤ 0.6 m (or a coil ≤ 4 kg); back: a tool or an all-elongated bundle ≤ 40 kg | to/from belt or back (§5.1) | 30 / 24 |
| cut (menu) | `target` | an edge that can cut the target | an aimed committed swing at the target (§5.3) | the tool's swing |
| shape | `target`, `at`, `charge` | tool/stone hardness ≥ target hardness − 0.1; target maxSharpness > current + 0.01; not rope-like | +0.10 sharpness per stroke (+0.15 knapping) at the end nearest `at` (§5.4) | 60 per stroke |
| place | `at`, `yaw`, `pitch`, `drive?` | carrying or wielding; support within 0.6 m under the lower end (and, sloped, under the body); no overlap | set down lying / sloped / upright; driven 0.3 m into soft ground → anchored (§5.7) | 24 lying, 60 driven |
| lash | `target`, `second`, `at`, `at2` | both in reach; rope available ≥ 1.0 m | fixed lashing (anchors ≤ 0.15 m apart) or taut rope joint (§5.8) | 90 |
| tie | `target`, `at` | a coil or rope end in hand | coil → rope from the target to the hand; end → tied at the current distance; a hauled end keeps its pull until the tie lands (§5.8) | 60 |
| untie | `target` (rope entity) | an anchor of its joint within reach | joint removed, rope back to a coil (§5.8) | 60 |
| bend | `target` (sapling), `second`, `at2` | rooted, springy, diameter ≤ 0.12 m; anchor in reach; rope available; holding force ≤ 500 N | sapling hinged with a motor, held by a 0.3 m rope (§5.9) | 90 |
| dig (menu) | `target: 0`, `at`, `charge` | a digging tool (aimed swing) or empty hands (hand-dig) | §5.10 | swing / 72 per scoop |
| throw | `aim`, `charge` | holding ≤ 40 kg, not a rope end, not dragging | projectile (≤ 2 kg) or Rapier body, 400 J cap (§5.11) | the throw move |
| pull | `charge` (>0 on, 0 off) | holding a rope end | reel in slack; when taut 1,200 N yank 0.15 s, then 500 N (§5.12) | continuous |

**Timing and state** (MAP gap-5 §8). A validated `verb` command sets `f.verbRequest = { cmd, frames: bufferFrames }`
(12, DS's press buffer). `VerbSystem.tryVerb(f)` runs right after `tryPickup` every tick: it decrements the buffer
while the fighter isn't `free`, and acts only when `f.free && f.alive && !f.isSevered('foreArmR')`. Exceptions: `drop`
and switching off a continuous verb (`charge: 0`) work in any state; `focus` applies in phase 1b. Acting is either
immediate (focus, drop, stow/draw finish within 1 tick of the action) or a **work action** through
`f.startWork({ kind, frames, actAt, faceAt, keys })`: state `'pickup'` (DS's committed, hittable state, already in
every DS skip list), the player turns toward `faceAt` (`VERB_TUNING.faceTurnRate` 0.12 of the remaining angle per
tick) and steps in to `standOffM` (0.6 m) as for a drop (`advancePickup`, combat.ts:1632), plays the verb's pose
track, and the effect lands at `actAt` through `world.completeWork(f)`; leaving `'pickup'` clears `work`. Any hitstun
or knockdown cancels it with no effect (an ape can punish a player who lashes mid-fight).

**Re-validation** (RF-15). A buffered verb waits up to 12 frames and a work action up to 90, during which its targets
can move, break (pieces get new ids in phase 12), be taken or leave reach. `tryVerb` re-runs `validateVerb` before it
starts the work action, and `completeWork` re-runs it at `actAt`; a failure emits `{ type: 'verb', ok: false, reason }`
and changes nothing (`get(id)` is never assumed to exist).

**Validation** (phase 1b, `validateVerb`, shared with the client's radial): the target exists; it is within
`targetRadiusM` (2.5 m, SPEC:406) of the player's chest point (`pos + 1.2·scale` up), measured to the collider surface
(`queries.surfaceDistance`); anchor points (`at`, `at2`, in whole cm, the sim divides by 100) lie within 0.3 m of their
entity's surface; the verb's property preconditions hold. A refused verb emits `{ type: 'verb', ok: false, reason }`
and changes nothing (MAP gap-5 §9: in multiplayer the client is untrusted).

**Reach** (rule 3: what you can't reach, you can't tie). A work action's anchor points must be within `handReachM`
(1.3 m) of the chest point after stepping in, so the highest point a standing player ties is about 2.5 m up.

**Credit** (SPEC:186, 473). Every verb that creates, moves, places, ties, shapes or throws an entity appends the
player id (sorted, de-duplicated); joints carry their maker's credit; pieces and spliced ropes merge their parents'.

**Property predicates** (`world/verbs/tools.ts`; property comparisons use the 1e-9 epsilon of §2.1):

| Predicate | Rule |
|---|---|
| rope-like | `'ropeKN' in material.strength` |
| springy | `springiness ≥ JOINT_TUNING.bendMinSpringiness` (0.3) |
| rooted | `plant !== null && plant.phase ∈ {standing, notched}` |
| soft ground | terrain at the point with material hardness ≤ `softGroundMaxHardness` (0.5), or an entity of such a material (a dirt pile) |
| elongated / compact | principal length ÷ largest cross dimension ≥ `minAspect` (5) / < `compactMaxAspect` (2.2) |
| point at an end | a `SharpPoint` within `headZoneM` (0.3 m) of an end, `\|dir·axis\| ≥ 0.7`, sharpness ≥ `pointMinSharpness` (0.3) |
| edge | a `SharpPoint` within 0.3 m of an end (anywhere on a compact object), `\|dir·axis\| < 0.5`, sharpness ≥ `edgeMinSharpness` (0.5) |
| can cut X | the tool has an edge and `edgeHardness(tool) − X.material.hardness ≥ cutHardnessMargin` (0.2): flint 0.95 cuts wood 0.5, bone 0.7, hide 0.3, rope 0.1-0.2; not stone 0.9 |
| can shape X | the tool's (or held stone's) hardness ≥ `X.hardness − shapeHardnessMargin` (0.1): stone 0.9 knaps flint 0.95 |
| digs | a two-handed tool (§5.2) whose head is a point or an edge of hardness ≥ `digMinHardness` (0.4) |

A **held object** is the entity in the hands plus every entity `lash`-joined to it (depth ≤ 3). Its mass is the sum;
its geometry (`HeldShape`) is the longest member's principal axis, the grip at the end opposite the head, and the union
of sharp points in that frame. That is how a knapped flint lashed to a stick becomes an axe (SPEC:247) with no recipe.

### 5.1 Hands: take, drop, stow, draw, carry, drag (`hands.ts`, P14)

| Verb | Preconditions | Effect |
|---|---|---|
| take | not fixed, anchored, rooted or tied; mass ≤ `dragMaxKg × scale²` (150 kg). A tool-classifiable held object (§5.2) → `wield`; else mass ≤ `carryMaxKg × scale²` (40 kg) → `carry`; ≤ 150 kg → `drag`; else refused `tooHeavy`. A rope's loose end or a hanging vine's end → `ropeEnd` (`joints.holdEnd`). A tool already in the hands is swapped (dropped where the new one lay, DS `tryPickup` semantics combat.ts:1597); a load is dropped first. | wield/carry: body `setEnabled(false)`, record pose follows the hand frame (4b), state `held`; wield: `f.weapon = synthWeapon(…)`. drag: the body stays dynamic, grip = the nearest end (`projectPoint`), `f.load = { massKg, 'drag' }`. ropeEnd: `f.load = { massKg: rope mass, 'rope' }`. Animation `pickupLow1/2` then `carryFront`/`carryShoulder` posture. |
| drop | something held | carry/wield: re-enable the body at the hand pose with velocity `walkVel + vel`; drag: release the grip; ropeEnd: `joints.dropEnd(j, handPoint)` (the end becomes loose). |
| stow | belt slot: mass ≤ `beltMaxKg` (4 kg) and length ≤ `beltMaxLenM` (0.6 m), or a rope coil ≤ 4 kg (a 20 m vine coil is 3.77 kg); back: a tool, or a held object whose members are all elongated (a bundle) ≤ `backMaxKg` (40 kg) | state `stowed`, body removed, drawn on the body by the client |
| draw | slot occupied, hands empty | the reverse |
| forced release | the fighter enters knockdown or KO (4a, `verbs.onDown`) | carry, drag and rope end released at once (a dragged log stays, a held rope end becomes loose at the hand); a wielded tool drops only on KO (DS `dropWeapon`, combat.ts:1376) |

**Carrying slows and tires** (SPEC:387) on its own curve (DS weapon curves cap at 7-8 kg, MAP gap-5 §5.2): speed ×
`max(carrySpeedMin 0.6, 1 − carrySpeedPerKg 0.01 × m)`, stamina regen × `max(0.4, 1 − 0.015 × m)`, no sprint above
`carryNoSprintKg` (20 kg), no strikes with a carried non-tool load, no automatic defence while carrying or dragging.

**Drag** (SPEC:235; forces in 4d as `applyImpulseAtPoint(F·DT, grip)`): horizontal `F = clamp(dragKp·(hand −
dragHandOffsetM − grip) − dragKd·(v_grip − ½·v_walk), |F| ≤ dragForceN)` with `dragKp` 3,000 N/m, `dragKd`
300 N·s/m, `dragHandOffsetM` 0.8 m, `dragForceN` **600 N**; vertical lift `clamp(liftKp·(liftHandM − grip.y) −
liftKd·v_grip.y, 0, dragLiftFrac·m·g)` with `liftKp` 2,000 N/m, `liftKd` 200 N·s/m, `liftHandM` 0.9 m,
`dragLiftFrac` 0.5 (all `VERB_TUNING`, RR-7). The mover's tether keeps the hand ≤ `tetherM`
(1.6 m) from the grip, so the player walks at the speed the log allows; desired walk while dragging × `dragSpeedMul`
(0.75). Measured (dry hex logs on a heightfield, dirt 0.7): 40 kg 1.99 m/s; 150 kg 0.53 m/s at 500 N (tethered 93 % of
ticks), **1.92 m/s at 600 N**; 150 kg with lift 0.3: 0.03 m/s; 300 kg 0.00 m/s **[B lab: drag.ts]**. So 600 N with a
half-weight lift makes the 150 kg drag limit a felt limit. Roll (SPEC:235) is not in M1: nothing round is generated
(TODO "roll verb").

### 5.2 Tools, primitive weapons and Strike (`tools.ts` P14, `strike.ts` P15)

**Strike** (SPEC:245, 400) is DS combat unchanged: Q/E/R/F → `button` → `tryBufferedAttack` → `startMove`. Armed, Q
is the tool's quick technique and E its committed one (`selectWeaponMove`).

**Tool classes** (`toolClass(held)`), evaluated whenever the hands change; mass ≤ `toolMaxKg` 6 kg, length 0.12-2.6 m:

| `ToolClass` (= new `WeaponId`) | Property rule | DS template (SPEC:391-398) | light / heavy technique | Digs |
|---|---|---|---|---|
| stone | compact, ≤ 3 kg, no edge | `bottle`-like, blunt | `hack` / `chop` | no |
| flintBlade | compact with an edge | `kunai`-like, blade | `hack` / `hack` | no |
| stick | elongated, no point/edge, < 1.5 kg | `bokken` (blunt, two-handed) | `sweep` / `overhead` | no |
| cudgel | elongated, no point/edge, ≥ 1.5 kg | `bat` | `sweep` / `overhead` | no |
| sharpStick | elongated, a point at an end, length < 1.6 m | `bokken`, edge blade | `thrust` / `overhead` (SPEC:393 "thrust only once sharpened"; the committed `overhead` keeps it the digging stick) (RR-9) | **yes** |
| spear | elongated, a point at an end, length ≥ 1.6 m | `gladius` techniques, longer (SPEC:394) | `thrust` / `thrust` | no |
| stoneAxe | elongated, an edge at an end, length < 1.1 m | `machete` (SPEC:395) | `slash` / `chop` | no |
| longAxe | elongated, an edge at an end, length ≥ 1.1 m | `fireaxe`-like two-hander | `sweep` / `overhead` | yes |

`synthWeapon(cls, held)`: the template with `length = held length − lengthTrimM` (0.08 m), `strikeFrom = length −
headLen` (`pointHeadM` 0.15 m for points, `edgeHeadFrac` 0.15 × length for edges), `mass = held mass`, `radius =
clamp(cross/2, radiusMinM 0.03, radiusMaxM 0.08)`, `sharpness` = the head's, `edge = 'blade'` for point/edge classes;
`cleave, tempo, choke` from `TOOL_TUNING[cls]`; **the head's material enters the numbers** (rule 4, RR-13): with s the
head's sharpness and `sRef = TOOL_TUNING[cls].refSharpness` (the sharpness the class's DS template stands for: 0.9 for
the flint-edged classes, 0.6 for wood points), `damageMul = TOOL_TUNING[cls].damageMul × (1 + kS·s) / (1 + kS·sRef)`,
`cut = min(1, TOOL_TUNING[cls].cut × s / sRef)`, `bite = TOOL_TUNING[cls].bite × s / sRef` (blunt classes: s = sRef = 0,
factor 1). So a flint-tipped spear (s 1.0) hits 1.43× as hard as a dry-wood point (s 0.6) of the same mass, through the
same factor (1 + k_s·s) the damage rule uses, and the melee number then "already has the weapon in it" (SPEC:283). The
starter stone axe's flint is 0.9, so its fresh chop stays 339 J and 15 chops (SPEC:882). All six constants are
`TOOL_TUNING` keys (RR-7). GORE
rows: stoneAxe, longAxe = `machete`'s; spear, sharpStick, flintBlade = `{ crown: null, sever: 'none', decap: false, tear:
true }`; cudgel `{ crown: 'crush', … }`; stick, stone `NO_GORE`. The DS `club` id (the spiked club) stays. The client's
`buildWeapon` draws the real held object from its entity shapes.

Measured with the real RotW `CombatSim` (scale 1, fresh, E = DS `hit()` damage × 18) **[B lab: tools.ts]**: stone axe
0.55 m 1.15 kg `chop` 339 J, head's lowest point +0.404 m (never reaches the ground); digging stick 1.45 m 1.73 kg
`overhead` 449 J, head 0.534 m below ground 1.56 m ahead for 7 frames; sharp stick 1.0 m `overhead` −0.083 m, 479 J;
spear 1.9 m `thrust` 257 J at 2.37 m; club `overhead` 754 J; references machete `chop` 301 J and axe `overhead` 832 J
reproduce MAP gap-5 and SPEC:295.

**Focus and aimed swings.** The client sends `{ verb: 'focus', target, at }` when the highlighted target changes
(§10.7). The sim sets `f.verbAim` = the focused entity's surface point nearest the player at `focusHeightM` (1.0 m)
above the ground (trees, logs); for a rope, the point of its sensor segment nearest the player's chest (a tie 1.8 m
above a scaffold has no point at 1.0 m, RT-6); or the `at` ground point; cleared when the focus clears, the target
leaves 2.5 m, or the player locks on to a creature. `weaponFit`, `heightGap`, `canReach` read it (P02b), so a committed swing at a focused tree
swings at the trunk, not at an ape 20 m away (MAP gap-5 §1.3 measured that bend).

**The strike seam** (`WorldPort.strike`, called from `resolveHits`' second loop, combat.ts:970-986, for a fighter
whose active swing found no body this tick, replacing the `walkable.solidAt` probe in world mode). Armed: for every
blade sample from `prev[i]` to `pts[i]`, `castShape(Ball(w.radius·scale))` with `{ terrain: true, entities: 'all',
ropes: true, fighters: 'none', exclude: own held object }`; the smallest toi wins (the swept cast catches a 30 cm trunk
the point test misses, MAP gap-5 §3). Unarmed: one overlap ball `(m.radius + reach)·scale` at `strikePoint`. Samples with
offset `< strikeFrom − haftMarginM` (0.02 m) are the haft (no cut). `power = a.swingPower()`; `E = blowDamage(a, null,
m, power, haft, null) × 18`.

| Hit | Condition | Effect | Fighter reaction |
|---|---|---|---|
| rooted tree | head, power ≥ 0.45 (`MIN_POWER`, combat.ts:112), the tool can cut wood | `felling.chop(tree, fromDir = the horizontal unit from the trunk axis to the striker's root, depthM, credit)` (the facet normal would snap to 45° steps, RT-22; §2.5); `chop` event; noise 40 m | `stick`, `w.bite`, 12 |
| free elongated entity | same | cross-cut progress (§5.3) | `stick` |
| rope sensor | head, power ≥ 0.45, the tool can cut rope | sever (§5.3); `joint cut` | `stick` |
| terrain below `heightAt` | the tool digs, head, power ≥ 0.45 | dig (§5.10) | `stick` |
| free dynamic entity otherwise (incl. unarmed kicks) | E > 0 | **push**: queued impulse `J = √(2·E·reducedMass(m_e, strikeMassKg 6))` along the swing (unarmed: the facing), applied in 4d; integrity by the rule in 9c. "Kick out a prop" (SPEC:432): a kick of 180 J moves an 18 kg prop by 2.2 m/s (J 40 N·s) and a 300 kg log by 0.15 m/s | `rebound`, 2, 10 |
| anything else (fixed, anchored, blunt on rope) | — | DS behaviour: `clang` event | `rebound`, 2, 10 |

One world contact per swing (the clang site already ends it: `hitThisAttack = true`). **Chop depth**:
`depthM = chopDepthM × clamp(freshChopEnergy(tool) / refChopJ, chopScaleMin, chopScaleMax)` = 0.02 m × clamp(E/339 J,
0.5, 2.5), where `freshChopEnergy` is the tool's committed-swing energy at full stamina and power 1 (computed once in
`synthWeapon`). So a stone axe always takes exactly 15 chops on a 30 cm trunk (SPEC:882), heavier tools fewer, and a
tired player chops slower (DS stretches tempo up to ×1.6 at zero stamina) but not shallower.

### 5.3 Cut (SPEC:233; `cut.ts`, P15)

Needs an edge that can cut the target (§5.0). Three targets:
- **Fell a tree**: strikes on a rooted trunk (§5.2); progress, hinge and fall are §2.5 and §4.12. The notch shows on the
  trunk (rule 3, §10.4).
- **Cross-cut a free entity** (a log, branch or stake; SPEC's "split a log" read as cutting it in two across its axis,
  §12): each qualifying strike advances `crossCut = { axisT, remaining, fromDir }` by `depthM`; a strike more than
  0.15 m from the stored `axisT` restarts there. At `remaining ≤ 0` the entity is replaced by the two halves of
  `crossCut(shape, axisT)` (ids in order; material, moisture, credit, integrity inherited; each sharp point kept by the
  piece containing it; velocities from the parent; joints move to the piece containing their anchor); `crossCut`
  event. Chops = thickness ÷ 2 cm (a 6 cm branch 3, a 30 cm log 15). Lengthwise splitting is not in M1 (TODO
  "lengthwise split").
- **Sever a rope** (tied rope, lashing, hanging vine): one qualifying strike on its sensor. The joint is removed
  (`joints.remove(id, 'cut')`, releasing what it held); the rope entity splits at the struck point into two rope
  entities with proportional lengths, each end loose, each keeping the anchor it was tied to (a severed hanging vine
  leaves its top tied to the tree; the bottom falls as a coil). A bent sapling springs back when its holding rope is
  cut.

From the menu (V → Cut on a highlighted rope, tree or log) the player plays the tool's committed swing with `verbAim`
on the target: the same strike path; nothing is cut unless the blade meets it. Headless tests issue `{ verb: 'cut',
target }` and get exactly the in-play behaviour.

### 5.4 Shape and knap (SPEC:234; `shape.ts`, P16)

`{ verb: 'shape', target, at, charge: 1 }` strokes until the end is at max sharpness, the player moves, or `charge: 0`.
Each stroke (work action `shapeStrokeFrames` 60; pose `workLow` for sticks and logs, `workKnap` for compact targets)
adds `shapeStep` 0.10 (`knapStep` 0.15 for compact targets) to the sharp point at the end nearest `at`, creating it
there if absent (tip at the end of the principal axis, `dir` outward along the axis: a stick becomes pointed; a flint
nodule gets an edge along its long axis), capped at `material.maxSharpness` (dry wood 0.6, green 0.5, bone 0.8, flint
1.0; rotten wood's 0.1 makes it useless, by its properties). Noise 10 m per stroke. A 300 kg log can be sharpened in
place (SPEC:234).

**The point is geometry too** (RF-18, rule 3). The first stroke on an elongated prism's end replaces its shape with
`taperEnd(shape, end, taperM)`: the end ring pulled to a tip on the axis over `taperM = TOOL_TUNING.pointTaperRadii
× radius` (5 radii: 0.25 m on a 5 cm stake, the C labs' stake hull), so the collider that meets a falling body has a
real point where the `SharpPoint` sits (mass = density × the new volume: a 1.4 m × 5 cm stake loses 12 % of its wood, 0.65 kg).
Sharpness decided the pit: 9/9 wounds with it, 0/9 without **[RF lab: pit_lab_thresholds.out, pit_nosharp.out]**, and
the design's leading test (tip radius 0.15 m, cos 0.7) gives the same 9/9 as the lab's looser one **[RF lab:
pit_design_thresholds.out]**. P16 unit-tests the leading test on the lab's stake-and-shin contact geometry.

### 5.5 Sprint, crouch, jump, climb (SPEC:370, 413; D-28)

Movement flags ride on `move` commands (`MOVE_SPRINT`, `MOVE_CROUCH`). Sprint (Shift held): speed × `sprintMul` 1.4
while stamina > `sprintMinStamina` (0.1), drains `sprintStaminaPerS` (0.15/s, 6.7 s from full), no regen; DS run 3.77
m/s → sprint 5.28 m/s. Crouch (Ctrl, a toggle by default): speed × `crouchSpeedMul` 0.5, posture `crouch`, own noise ×
0.3, seen at × 0.6 (× 0.35 crouched in cover ≥ 0.5, §6.2). Jump (Space → `button 'jump'`): the KCC (`jumpSpeed` 4.2 m/s
× √scale, ≈ 0.9 m), costs `jumpStamina` 0.05; a jump press is buffered `jumpBufferFrames` (6). Crouching also lowers
the controller to 0.7 of its height (§4.2), so a crouching player or ape fits under a log 1.4 m up. Climb = autostep
over low ledges and trunks (0.4 m × scale). Swim waits for water (M2).

### 5.6 Carry and drag

Carry is `take` of ≤ 40 kg; drag is `take` of 40-150 kg (D-27): §5.1.

### 5.7 Place (SPEC:238, 410; `place.ts`, P17)

`{ verb: 'place', at, yaw, pitch, drive? }` while carrying or wielding. `pitch` (0..64, 1/256 turn = 1.40625°) is the
long axis's tilt above horizontal in the vertical plane of `yaw`: 0 lying, 64 upright, anything between sloped (the
radial's "angled" is 32 = 45°). Upright and sloped put the end with the sharpest point up, else the thicker end down
(D-49). Resolution:
1. Reach: the nearest point of the placed shape (at the commanded pose; `at` is its centre) within `placeReachM` (2.5 m)
   horizontally and `placeReachVertM` (1.5 m) vertically of the player, so an 8 m bearer can be laid across a 6 m pit
   from its rim (its centre is 3 m out over the hole).
2. Support: a downward ray from 0.5 m above the lower end finds a surface within `placeSupportM` (0.6 m) (lying: from
   both ends, so a branch spanning a pit rests on its ends). **Sloped** (0 < pitch < 64, revision 2, RR-5/RT-8): the
   shape (shrunk by `placeShrinkM` 0.02 m) is also cast straight down from the commanded pose by up to 0.6 m; it must
   meet a support other than under its lower end (the top of a prop, a rock, a log). The object is set where the cast
   stops, `placeDropM` (0.02 m) above it, resting on its lower end and that support. That is how a player leans a light
   log on the prop of a deadfall (§11.2(a)); the client computes the pitch from the same cast (§10.7).
3. Clearance: `overlaps(shape shrunk by placeShrinkM, pose)` against entities and fighters (excluding sensors, the
   ground, the support found in 2, and for a driven end the drive depth) is empty.
4. Upright or sloped on **soft ground** (§5.0), when `drive === 1`, or `drive` is absent and the object has a sharp
   point at its top end (a point-up stake, SPEC:238): driven `stakeAnchorDepthM` (0.3 m) in and `anchored` (fixed body,
   `anchor { depthM 0.3, capacityN 0.3 × anchorHoldNPerM 4,000 = 1,200 N }`, D-19): static for m_eff, trips and shoves.
   Otherwise placed `free` (dynamic, awake, `placeDropM` above the support), and it may topple: a blunt stick set
   upright under a log is a free prop that can be yanked or kicked out (a driven prop could not).
5. Work action `placeFramesLying` 24, `placeFramesDriven` 60 (pose `workLow`, a two-handed push down). The placed
   entity gets `releasedBy` (§4.3).

The wheel sets yaw in 15° steps on the client; the command carries 1/256-turn yaw. Place does not refuse a thin prop
(its load is unknown until something rests on it); the strain shows instead (§10.4, rule 3).

### 5.8 Lash, tie, splice, untie (SPEC:239, 251-266; `lash.ts`, P16)

Rope comes from a rope-like entity in the hands or the first belt slot holding one.

| Verb | Command | Preconditions | Effect |
|---|---|---|---|
| lash | `{ verb: 'lash', target: A, second: B, at, at2 }` | both in reach; neither is a fighter; rope with `lengthM ≥ lashRopeUseM` (1.0 m) | anchors within `lashTouchM` (0.15 m): a **fixed lashing** (`joints.lash`, contacts off between the pair, break energy D-18); otherwise a **taut rope joint** of length = the anchor distance (`joints.rope`). A piece is split off the coil: 1.0 m for a lashing, distance + 0.5 m for a rope; the coil's length and mass shrink (< 0.5 m left: used up). **Snap assist**: an entity ≤ `lashSnapMaxKg` (3 kg) within `lashSnapM` (0.4 m) of an end of an elongated partner is moved flush to that end first, keeping its orientation (flint across a stick's end → an axe head; along it → a spear point). |
| tie | `{ verb: 'tie', target, at }` | a coil or a rope end in hand | coil: a rope joint from the target anchor to the hand (`ropeEnd`, length = the coil's), paid out as the player walks (tether); rope end: tied to the target anchor at the current distance (taut). A held end being hauled (`pull` on) keeps its haul force through the work action and is tied at the distance of the tick the tie lands (`joints.tieHeldEnd`, §4.9): that is how a hauled-back log is tied off (revision 2). Tripwires, pull ropes, guy ropes, tie-backs and hanging a log from a vine end are all `tie`. |
| splice | `lash`/`tie` where both sides are rope-like | — | one rope: `lengthM = a + b − spliceLossM` (0.5 m), strength = the weaker, credit merged (extends a vine past 15 m, §11.3) |
| untie | `{ verb: 'untie', target: ropeEntity }` | an anchor of that joint within reach | `joints.remove(id, 'untie')`; the piece becomes a coil (into empty hands) |

Work actions: lash 90, tie 60, splice 60, untie 60 frames (pose `workLow`).

### 5.9 Bend (SPEC:240, 258; `bend.ts`, P16)

`{ verb: 'bend', target: sapling, second: anchorEntity, at2 }` (two-target flow). Preconditions: the target is rooted
and springy (green wood 0.6 ≥ 0.3) with diameter ≤ `bendMaxDiamM` (0.12 m); the anchor point is in reach and within the
sapling's height of its base; rope available. The holding force at the chosen angle, `F = k·θ / L` with `k = bendK ×
springiness × d²` (6 cm sapling: 4e5 × 0.6 × 0.0036 = 864 N·m/rad) and L = the sapling's height, must be ≤
`bendMaxForceN` (500 N); otherwise the sapling bends only as far as 500 N allows, refused `tooStiff` under 20°. Effect
(P10): the sapling becomes a dynamic body hinged at its base (bend joint, motor toward its rest angle), posed at the
bent angle, `plant.phase 'bent'`, held by a 0.3 m rope joint from its top to the anchor (`holdsBend`). A 6 cm × 3 m
sapling bent 60° needs 302 N at the top and stores ½·864·1.047² = 474 J. Work action 90 frames (pose `haulRope`).

### 5.10 Dig (SPEC:241, 412, 883; `dig.ts`, P15)

- **By strike**: a tool that digs (§5.0) whose committed swing goes below the terrain (§5.2): each qualifying strike is
  one `lower` (0.15 m peak, 0.5 m cone, 3 m floor) plus the dirt policy of §4.13. Focus on the ground (`at`) aims the
  swing there; the digging stick's head enters 1.56 m ahead, so the hole appears where the blade visibly goes in.
- **By hand**: `{ verb: 'dig', target: 0, at, charge: 1 }` with empty hands; one scoop every `handDigFrames` (72, pose
  `digScoop`) at `handDigDepthMul` 0.25 of a strike (SPEC: "hands (slow)").
- Rate: an 8 × 6 × 2.5 m pit is 3,203 strikes **[C lab: dig8x6]**; with the digging stick's ≈ 55-frame cycle that is
  ≈ 50 min of swinging, ≈ 4.3 h by hand: a ruler pit is a multi-session project (SPEC:433), which is the design.

### 5.11 Throw (SPEC:244, 285, 409; `throw.ts`, P17)

`{ verb: 'throw', aim: [yaw, pitch], charge }` on releasing X. Preconditions: holding ≤ 40 kg; not dragging; not a rope
end. Speed `v = launchSpeed(m, techSpeed) × (throwMinFrac + (1 − throwMinFrac) × charge/255)` (0.5 → 1), with
`techSpeed` = `smallThrowSpeed` **20 m/s for objects ≤ `projectileMaxKg` (2 kg)** (spear and stone, D-29; the spear row
of SPEC:297), `heavyThrowSpeed` 12 m/s above (DS `throwHeavy`, two-handed). A 40 kg log leaves at 4.47 m/s (400 J,
SPEC:298). Paths:
- **Projectile** (tool classes ≤ 2 kg, SPEC:632): DS `release()` with `f.throwAim` (no `aimBallistic` at a target; the
  speed is `launchSpeed(m, techSpeed) × speedFrac`, not the move's own `speed`; DS scatter kept from `this.rng`); the spear uses the new `throwSpear` move (`throwOne`, speed 20, spin 0, point first);
  DS sub-stepped flight and fighter hits through the rule (§4.4). The entity is `state 'projectile'` (no body) until
  `WorldPort.projectile` reports a world hit (the flight segment cast vs entities and terrain) or it lands
  (`onProjectileLanded`); then its body is re-created at the projectile pose with its velocity, so the contact pipeline
  scores what it hits.
- **Rapier body** (everything else): at the move's release frame `throwRelease` re-enables the body at the hand pose with
  `linvel = aimDir·v + walkVel`, `angvel` 1.5 rad/s end over end, CCD on, `thrown = { by, tick }` (damage cause `held`
  until first contact or rest, D-31).
Noise 12 m on landing. The aim is a direction, never a target, so an ape 30 m away can't pull the throw.

### 5.12 Pull (SPEC:237, D-26; `pull.ts`, P16)

Holding a rope end, hold a punch button (Q/E/LMB; X/Y on a pad) → `{ verb: 'pull', charge: 255 }`; release →
`charge: 0`. While on (4d): if the rope is slack, the hand reels in at `pullHandSpeedMps` (1.5 m/s; `joints.shorten`);
when taut, `joints.setPull(j, F)` with `F = pullYankN` (1,200 N) for the first `pullYankTicks` (9 = 0.15 s) after it
becomes taut, then `pullForceN` (500 N), applied by the haul model of §4.9 (force scaled down as the load approaches
the hand at the 1.5 m/s haul speed; the free length only shortens). A person can jerk a prop out (springing a deadfall
takes 492-1,277 N inward **[C lab: e1c_pull]**, SPEC:237 "yank out a prop"), and haul a 30-40 kg hanging log back to
28-45° and hold it there for a tie-off (§11.2(c)) **[I-rev ran: swing_light.out]**. The player stands braced (posture `haulRope`, walk input ×
`pullWalkMul` 0.2 backwards allowed), drains `pullStaminaPerS` (0.15/s); at zero stamina the force drops to 60 %.
Knockdown releases the end. Felling numbers are §4.12. A creature's pull (the ape tugging bait) is the same code at
creature strength: `pullForceN × creaturePullMul (1.5) × scale²` = 907.5 N for the ape, hand speed 0.8 m/s (the
`tug` script, §6.6).

### 5.13 What the radial offers (`verbsFor`, shared by sim and client)

`verbsFor(world, f, target)` returns, in this fixed order, every option with `{ verb, needsSecond, label,
reasonIfDisabled? }`; options whose preconditions fail are returned disabled with the reason ("too heavy (210 kg)",
"needs an edge"), so the player learns the rule.

| Highlighted | Hands | Options |
|---|---|---|
| free entity ≤ 150 kg | any | Take (carry / drag / wield) |
| any entity, rope in hands or belt | — | Lash (→ second), Tie |
| rooted springy sapling ≤ 12 cm | rope available | Bend (→ second) |
| rope sensor, lashing, hanging vine | any | Untie (an anchor in reach); Take end (a loose end or a vine's end) |
| rope sensor, lashing, hanging vine | edged tool | Cut |
| tree or free wood | edged tool | Cut (aimed swing) |
| entity with maxSharpness > its current sharpness | a tool or stone that can shape it | Shape |
| the ground | digging tool or empty hands | Dig |
| nothing | something held | Stow (belt / back), Drop |

Place (C) and Throw (X) have their own controls; G is Take/Drop directly.

### 5.14 Controls (keyboard and mouse; the gamepad mapping decided here, SPEC:402, D-47)

| Action | Keyboard / mouse | Gamepad (Standard mapping, button index) | Command |
|---|---|---|---|
| Move | W A S D, arrows | left stick | `move` |
| Camera | mouse (pointer lock; click to lock, Esc releases) | right stick (axes 2/3) | — |
| Left / right punch (parry as a strike lands) | Q / E, LMB / RMB | X (2) / Y (3) | `button` |
| Left / right kick | R / F | LT (6) / RT (7) | `button` |
| Jump | Space | A (0) | `button 'jump'` |
| Sprint | Shift (hold) | LS click (10), toggle, ends when you stop | `move.flags` |
| Crouch | Ctrl (toggle; "hold to crouch" in settings) | B (1), toggle | `move.flags` |
| Target cycle | Tab, Shift+Tab back | D-pad right (15) / left (14) | `focus` |
| Take / drop | G | RS click (11) | `take` / `drop` |
| Verb radial | hold V, move the mouse to a sector, release | hold LB (4), right stick to a sector, release | per option |
| Second target confirm / cancel (lash, bend) | LMB or E / RMB or Esc | A / B | `lash`, `bend` |
| Throw | hold X to aim (arc shown), release; LMB while held cancels | hold RB (5), right stick aims, release | `throw` |
| Place | hold C: preview; wheel rotates 15°; RMB cycles lying/upright/angled; Shift toggles drive (auto / drive / don't); LMB sets it; releasing C cancels | D-pad down (13) toggles the preview; right stick X rotates 90°/s; Y cycles; X toggles drive; A sets; B cancels | `place` |
| Pull (holding a rope end) | hold Q, E or LMB | hold X or Y | `pull` |
| Belt / back | 1, 2, 3 / 4: draw into empty hands, or stow what you hold there | Back (8): cycle the belt into the hands; D-pad up (12): stow | `draw` / `stow` |
| Menu, mute, log | Esc, M, B (reserved, bindings.ts) | Start (9) | — |

Changes from DS's pad (input.ts): LB/RB no longer duplicate the punches, A/B no longer duplicate the kicks; X/Y punch
and LT/RT kick are unchanged; RS click still takes; Back moves from pick-up to the belt. The new keyboard actions
(`verb`, `throw`, `place`, `target`, `jump`, `sprint`, `crouch`, `belt1-3`, `back`) join `Action`/`ACTIONS`/
`DEFAULT_BINDINGS` so Settings lists and rebinds them; none clashes with the reserved or dev keys (MAP client §2.4).
Ctrl risk: Ctrl+W closes the tab and a page can't stop it, so crouch is a toggle by default, the page asks
`beforeunload` while in play, and fullscreen requests `navigator.keyboard.lock()`.

## 6. Creatures

### 6.1 Architecture (`world/creatures/*`, P18-P22)

- One `CreatureMind` per creature implements `Brain` (P02a's interface in `sim/ai.ts`, with `cfg`). `ApeMind` wraps an inner DS
  `BrawlerAI` (Bruiser plan) for the fight; `RulerMind` drives the giant. `ownsTarget = true`, so `retarget`
  (combat.ts:340) leaves `f.target` to the mind. `cfg.passive = true` for the giant (rulers never block). `director`:
  apes share CombatSim's `AIDirector` (DS turn-taking); `drops` stays empty (apes don't seek weapons).
- **Phase 2** (`MindRegistry.sense`, fighter-id order): a mind runs fully when its creature is within `aiNearM` (60 m)
  of the player, otherwise when `(tick + id) % 60 === 0` with Δt = 1 s (SPEC:698, 789). Sight is checked, `decide`
  makes transitions, path requests are queued.
- **Phase 3** (`think`, at CombatSim's brain site after `advance`): the ape writes `moveInput` (direction × gait) and
  `f.target`, or calls `inner.think(self, target, navWalkable)` in `fight`; the giant writes `f.drive` (`{ heading,
  speed, accel, climb }`, `climb` only while climbing out of a pit, §4.7) and `f.posture`. `think` returns at once (zeroing `moveInput` and `drive`) while the fighter is in
  knockdown, getup, ko or tripped, and while `paused`.
- **Phase 17b**: `NoiseBus.collect` turns the tick's events into noises and adds every moving fighter's footsteps;
  `fold(minds)` adds them to awareness and, in event order, calls `onHurt` / `onWound` on the mind of every creature
  that is the defender of this tick's `hit`, `impact` or `wound` events (so no sim module imports a mind).
- Only the player is a target in M1: apes and the giant are both team `enemy` and never fight each other, but a charging
  giant's zones still hit an ape through the rule (§4.3), and an ape fight is a noise the giant hears.
- Mind randomness uses `rngs` stream `mind:<fighter id>` (§8.1); the inner BrawlerAI keeps sharing `CombatSim.rng`
  exactly as DS does (un-sharing diverged, MAP gap-7 §3.3).

### 6.2 Perception (`perception.ts`, `noise.ts`, P18; SPEC:752-757)

**Sight** (per creature, per target, each sensed tick):
1. `eye = rig.head.pos`; target points `rig.chest.pos` and `rig.head.pos`; `d` = eye-to-chest distance; `β` = bearing
   from the creature's facing.
2. In view when `|β| ≤ sightConeDeg/2`; a giant with `blindL`/`blindR` does not see targets on that side beyond
   `blindDeadDeg` (15°).
3. Range `R = sightRangeM` when the target moves faster than 0.5 m/s, else `sightRangeStillM`; × `crouchSightMul` (0.6)
   when crouched; × `coverSightMul` (0.35) instead when crouched in ground cover ≥ 0.5 (`world.cover.at(x, z)`;
   SPEC:754 "crouching in undergrowth hides").
4. Occlusion: `queries.castRay(eye → point)` with `{ terrain: true, entities: 'all', minEntityMassKg: 100 }` for both
   points; seen when either ray reaches within `sightRayTolM` (0.3 m) of its point. Trunks, boulders and big logs block; branches, grass
   and canopy (no collider in M1) don't (TODO "dense foliage blocks sight", M4).
5. Visibility `v = √(1 − d/R)`, halved in the outer 20° of the cone; `awareness += seenRate × v × Δt`; `lkp =
   target.pos`, `lastSeenTick = tick`.
6. Not seen: `awareness −= decayPerS × Δt` (floor 0, cap 1.5).

**Hearing** (folded in 17b): a noise `{ at, radius, kind, source }` is heard by a creature (not its source) when
`s = 1 − d / (radius × hearingMul) > 0`: `awareness += heardGain × s`, and, if it is the strongest stimulus since the
last decision, `lkp = at`. Radii (`NOISE_TUNING`, m, just audible at `hearingMul` 1):

| Source | Radius | Emitted from |
|---|---|---|
| footsteps crouch / walk / run / sprint | 2 / 6 / 12 / 20 (× scale for big bodies) | each fighter's `walkVel` and `moveFlags` |
| strike landing / block / clang | 25 / 15 / 25 | CombatEvent `hit`, `block`, `clang` |
| chop / dig / shape stroke / stake driven | 40 / 15 / 10 / 20 | WorldEvent `chop`, `dig`, verb results |
| thrown object lands | 12 | `land` of a thrown entity |
| rope snaps / entity breaks | 35 / 25 | `joint snap`, `break` |
| heavy thing lands | `clamp(10 + 0.15 × mass, 10, 120)` (300 kg log 55 m; a felled 738 kg trunk 120 m) | `land`, `fell` |
| ape fight shouts | 30 | the ape mind entering `fight` and on each hit it takes |
| giant's roar | 120 (× `weakJawRoarMul` 0.6 with a weak jaw) | telegraph, wounds, getting up |

A felled tree is heard across the whole Clearing: the cheapest lure in M1 (SPEC:466).

**Being hurt**: any `hit` or `impact` on the creature sets `awareness = max(awareness, attacker is a fighter ? 1.5 :
0.9)` and `lkp` = the attacker's position or the impact point.

**Thresholds**: `investigateAt` → investigate; `chaseAt` (1.0) **and** seen within the last second → chase. A glimpse
at the edge of sight starts an investigation first; a close sighting reaches a chase in under half a second (ape at
5 m: v = 0.91, 2.5/s → 1.0 in 0.44 s).

**Readability** (rule 3; SPEC:787): the client draws `?` (investigating) and `!` (chasing, fighting) over a creature
from `MindRegistry.view` (a read-only view, never an input).

### 6.3 The ape (`apeMind.ts`, `creatures/factory.ts`, P19)

The Fighter: `new Fighter('enemy', 'Ape', ENEMY_MOVES, { maxHp: 90, walkSpeed: 2.8, staggerResist: 0.4, defense: 0 },
ARCHETYPES.bruiser.style, { ids: world.ids.fighter, rngSeed: seedFor(seed, 'fighter', id) })`, `scale 1.1`,
`autoDefense true`, `readSkill 0.5`, `massKg 97.56`, `species 'ape'`. Inner `BrawlerAI` with `{ ...DEFAULT_AI,
blockChance: 0.4, aggression: 0.8, stringChance: 0 }` and `{ ...ARCHETYPES.bruiser.plan, range: 1.0 × 1.1, attackRange:
1.25 × 1.1 }`: Bruiser's plan with its shoulder charge (SPEC:873, enemies.ts:185-208; the archetype's own HP and walk
speed are not taken, D-21). Not an `ARCHETYPES` entry (styles.test.ts forbids two identical repertoires).

| State | Output | Enter | Leave |
|---|---|---|---|
| idle (graze) | wanders within `homeRadiusM` (8 m) of home: a new point every 6-14 s (mind rng), gait 0.35 (≈ 1.4 m/s) | start; after `return`; after a patrol loop | → patrol after 20-40 s; → investigate at awareness ≥ 0.25; → chase at ≥ 1 and seen |
| patrol | walks its 3-waypoint home loop (radius 15 m) once, gait 0.45 | from idle | → idle at the end; same alert exits |
| investigate | paths to `lkp` at gait 0.6; on arrival (≤ 1.5 m) looks around 3 s (±`lookAroundDeg` 60°, posture `sniff`) | awareness ≥ 0.25 | → chase (≥ 1, seen); → return after looking |
| chase | `f.target = player`; paths to the player at gait 1.0 (2.8 × 1.45 = 4.06 m/s: faster than the 3.77 m/s run, slower than the 5.28 m/s sprint) | awareness ≥ 1 and seen | → fight at ≤ `fightEnterM` (4.5 m) seen in the last second; → investigate `lkp` after 8 s unseen; → return after 3 failed paths |
| fight | `inner.think(self, target, navWalkable)`: BrawlerAI unchanged (spacing, tempers, specials incl. the shoulder charge at 2.09-3.96 m, director turns) | from chase | → chase when > 8 m for 60 ticks; → flee once per fight at hp ≤ 25 % on a 0.5 roll; → gloat 3 s (`celebrate()`) then return when the player is KO'd |
| flee | paths to a point 25 m from the player toward home, gait 1.0, 6-10 s, ignoring the player | from fight | → return (awareness halved) |
| return | paths home at gait 0.6 | flee, lost target | → idle at home; → chase if seen |
| down | — (body knocked down) | knockdown | → the previous state after getup |
| dead | — | KO | the spawner respawns it (§6.6) |

The ape uses the human nav layer through `PathFollower`, and inside `fight` BrawlerAI's own local steering through
`NavWalkable` (§4.1). Chasing and fleeing apes run through whatever the player built: a fleeing ape is a chance at an
environmental kill.

### 6.4 The giant ape (`rulerMind.ts`, P20)

The Fighter: scale 5.5, `massKg` 14,000, 12,000 HP, `ruler = newRulerState(12000)`, `species 'giantApe'`, team
`enemy`, `autoDefense false`, no BrawlerAI. Body, zones, shove/block/deflect/trip, pinned and get-up are §4.7;
everything below is the mind, which drives the body through `f.drive` with a heading it turns at a limited rate.

| State | Drive and pose | Enter | Leave |
|---|---|---|---|
| rest | at the lair, speed 0, idle life | the route reaches the lair; after flee | → patrol after 20-40 s; → investigate (awareness ≥ 0.3); → chase (≥ 1, seen) |
| patrol | follows its 8-waypoint loop (§6.7) on the ruler layer: 1.8 m/s, turns ≤ 30°/s, accel 1 m/s², slows to `max(cornerMinFrac 0.35, cos Δ)` × speed into corners | from rest | → rest at the lair; alerts as above |
| investigate | paths to `lkp` at 1.4 m/s; at ≤ 4 m stops and sniffs 3 s (posture `sniff`, turns ±45°; with a blind eye it approaches with the good eye toward the sound, 25° off) | awareness ≥ 0.3 | → chase; → patrol (nearest waypoint) |
| chase | paths to the player at 4.5 m/s, turns ≤ 45°/s, accel 2 m/s²; checks the charge conditions every sensed tick | awareness ≥ 1 and seen | → telegraph when the conditions hold; → investigate `lkp` after 10 s unseen |
| telegraph | slows to 1 m/s (4 m/s²), turns toward the player at ≤ 70°/s, posture `headLow` ramping to full, roars (120 m) at its start; 1.0 s (close charge 0.6 s; × 1.3 with a limp) | charge conditions | → charge: **commits** `RulerMind.heading` = the bearing to the player's position at that instant |
| charge | accelerates to 7.0 m/s (5 m/s²; × 0.7 with a limp = 4.9 m/s, still above the 4 m/s trip speed); turns toward the player's current bearing at ≤ **8°/s**; when `ruler.deflectedHeading` is set (a deflection, §4.7) the heading becomes it and the field is cleared | from telegraph | → recover after 35 m (close charge 9 m), when the player is > 6 m behind it, when blocked (< 1.5 m/s for 15 ticks after the first 0.5 s), or on a trip |
| recover | brakes at 4 m/s² (overshoots ≈ 6 m from 7 m/s), stands 0.8 s; charge cooldown 5 s from the charge's end (× 1.5 winded) | charge, get-up | → chase if seen, else investigate `lkp` |
| down | no drive (tripped body); after the get-up, while `ruler.inPit`: `drive.climb` toward the nearest rim point (the lowest support within `climbMaxM` of the pit floor, 3 m ahead), posture `climbOut`, a roar at its start (RR-1) | the `trip` event, or `pit` on | → recover once up and out of the pit (roars) |
| flee | paths to the lair at 4.0 m/s for 20 s ignoring the player, then rests 30 s | any **severe** wound | → rest → patrol |

**Charge conditions** (all): in `chase`; target seen this tick; cooldown over; either `8 m ≤ d ≤ 30 m` and
`|β| ≤ 25°`, or `d < 7 m` and `|β| ≤ 40°` (the close charge, the giant's answer to a player under its feet; D-34's "no
other ruler attacks in M1" holds); and `chargeLineClear(from, to)`: a ball of radius 0.8 m cast at 0.55 × the pelvis
height (≈ 2.9 m at 5.5, above the 2.75 m knee) along the line against terrain and fixed or anchored entities ≥ 300 kg,
plus terrain samples every 2 m that must not rise more than 2 m above its feet. Standing trunks stop a charge before it
starts; **logs at shin height and covered pits do not**, because it sees over them. So it walks around staked logs while
chasing (they are extruded blockers on its nav layer, §7) but charges straight across them: that is what makes funnels,
trip logs and pits work (SPEC:776, 781-782), and the lowered head says "it's coming straight now". The nav `raycast` is
not used for this (MAP recast §10.8's advice would never charge across a staked log, §12.3).

**Dodging** (kinematics: commit at the telegraph's end, 1 → 7 m/s at 5 m/s², a hit when the centre passes within
1.95 m = sweep radius 1.65 + capsule 0.3) **[B lab: charge.mjs]**:

| Turn rate | Player 15 m ahead: standing | walks sideways from the commit | runs sideways | runs, 0.5 s late | sprints, 0.8 s late |
|---|---|---|---|---|---|
| 6°/s | hit | miss (2.37 m) | miss (7.36) | miss (6.12) | miss (7.36) |
| **8°/s** | **hit** | **hit (1.67)** | **miss (6.76)** | **miss (5.74)** | **miss (7.20)** |
| 10°/s | hit | hit (1.31) | miss (6.08) | miss (5.32) | miss (7.02) |
| 15°/s | hit | hit (0.83) | miss (3.89) | miss (4.07) | miss (6.50) |

8°/s makes the rule "you must run, walking isn't enough" at 10, 15 and 25 m alike; the telegraph gives a full second
to start running (SPEC:787).

**Interplay with the mover**: shoves (< 500 kg), blocks, the < 30° deflection and the trip are §4.7; the mind only
reads their results (`deflectedHeading`, the `trip` event, its own speed when blocked). Walking (1.8 m/s) it never
trips on obstacles (4 m/s); blocked while walking it re-paths.

**Wounds and severe effects** (SPEC:503, 783):

| Effect | Behaviour |
|---|---|
| any wound | roars; `awareness = max(awareness, 1.2)`; `lkp` = the wound's point |
| any severe wound | `flee` to the lair for 20 s, then rests (SPEC:768; the "pain" trait is M4) |
| `limp` | every speed × `limpSpeedMul` 0.6 (charge × `limpChargeMul` 0.7), telegraph × 1.3, turn rates × 0.8; visible through `FootworkStyle.limp` (P02a, optional: the bad leg's stance time × (1 − 0.4·amount), step height × 0.5; without it, speed only plus a client hitch; TODO "limp gait") |
| `blindL` / `blindR` | sight loses that side beyond 15°; investigates with the good eye toward the sound |
| `weakJaw` | roar radius × 0.6 (M1 has no bite; TODO "jaw weakens bite attacks", M4) |
| `winded` | charge cooldown × 1.5, chase speed × 0.85 |

### 6.5 Navigation use (`pathFollow.ts`, P19)

- Layers (§7): ape `'human'`, giant `'ruler'`. Goals snapped with `nav.nearest` (null → unreachable).
- Requests are queued and served in `(requestTick, fighterId)` order, at most `navQueriesPerTick` (4) per tick (a query
  is 30-62 µs, MAP recast §6); a mind waiting for a path keeps following its old one.
- Following: steer at the current corner; advance when within `arriveM` (ape 0.6 m, giant 2.5 m). Ape: `moveInput =
  dir × gait` (DS `locomote` turns it at `freeTurnRate`). Giant: `heading` turns toward the corner at the state's turn
  rate; `drive.speed` slows into corners.
- Re-path when the goal moved more than `repathMoveM` (1.5 / 4 m); when any tile the path crosses changed version
  (checked every `repathCheckTicks` (15): a felled tree or a dug pit re-routes them, SPEC:775); every `repathTicks`
  (30 / 60) while chasing; when stuck (< 0.3 / 0.8 m of progress in 90 / 120 ticks while asking for more than
  `stuckAskSpeed` 0.5 m/s). `maxPathFailures` (3) consecutive failures or stucks → unreachable → the state's fallback
  (chase → investigate → return/patrol). A partial path (`complete: false`) is followed to its end, then counts as a
  failure. (All `CREATURE_TUNING.shared`, RR-7.)
- A covered pit is walkable on both layers (light resting entities are real triangles, and stakes inside a pit are not
  extruded, §7), so a chasing giant paths straight over one; its charge crosses it regardless.

### 6.6 Spawning, respawn, sparring ape and test scripts (`spawner.ts` P22; scripts in `mind.ts` P19, `rulerMind.ts` P20)

- `Spawner.init(world, spawnData)`: one ape per home (§6.7), the giant at its lair. In `scene 'empty'` it spawns nothing.
- Ape death: respawn at `tick + respawnS × 60` (300 s) at its home, only when the player is more than
  `respawnMinPlayerDistM` (40 m) from that home (else retried every 10 s). The giant never respawns (dev `spawnGiant`
  only).
- **Sparring ape** (`?mode=training` → `WorldOptions.sparringApe`, D-50): an extra ape 3 m in front of the player,
  starting in `fight` with awareness 1.5; after its KO it respawns beside the player 3.2 s later (DS's training cadence).
  This replaces the retired training ring.
- **Scripts for tests** (`mind.script`; scripts drive creatures, never a trap):
  - `{ kind: 'route', points, speed? | gait?, useNav? }`: walk the points (straight lines unless `useNav`);
  - `{ kind: 'charge', heading, speed, telegraph? }`: the giant's charge state with that heading and speed (telegraph
    skipped unless asked; deflections are adopted as in play);
  - `{ kind: 'tug', entity, dirYaw, ticks }`: walk (crouched, §4.2: the capsule at 0.7 height, so it fits under a
    log 1.4 m up) to the entity, grab it with the drag code at creature strength (907.5 N for the ape, hand 0.8 m/s),
    posture `workLow` (stooped), back off along `dirYaw`; the bait and its ropes are the ape's work target, exempt from
    the tripwire rule (§4.9);
  - `{ kind: 'hold', posture?: PostureId }`: stand still (optionally stooped, e.g. grazing).
  While a script runs, senses update but transitions are suspended. **`mind.paused = true`** (AC-5's "AI paused")
  zeroes the drive and input and sets `f.idlePaused = true` (§12).

### 6.7 The Clearing (`clearing.ts`, `cover.ts`, `factory.ts`, P07/P21)

`generateClearing(world, rngs.gen)` builds the terrain heights, the ground cover and every entity in a fixed order from
the seed and `CLEARING_TUNING` only, so a load regenerates the same ids and poses and the save stores only what differs
(§8.3). Coordinates: x, z ∈ [−100, 100] m, y up, the player spawn at (0, 0) (D-33).

**Terrain** (8 × 8 tiles of 25 m at 0.25 m, §2.6):

```
h(x, z) = floor(x, z) · flat(r) + rim(x, z) − ledge(x, z)
floor   = 1.5 m · (0.65 · n(x/48, z/48) + 0.35 · n(x/16, z/16))           n = seeded value noise in [−1, 1]
flat(r) = smoothstep(15, 25, r), r = distance from the spawn                (flat within 15 m: the first minutes are easy)
rim     = 18 m · smoothstep(R(θ), R(θ) + 14, e)²,  e = (|x|⁴ + |z|⁴)^¼,  R(θ) = 82 + 5 · n(θ)    (an 18 m wall, 50-60°)
ledge   = 6 m on the low side of a 30 m line centred at (40, −35), normal (1, −1)/√2, a 3 m transition (≈ 63°),
          fading out over 25 m beyond it: a drop into a hollow (was 3 m; RR-16)
```

The rim is steeper than the controller's 45° and the ruler layer's 40°, so the Clearing is a valley nobody leaves (the
boundary is a visible cliff, not an invisible wall), and the giant's mover blocks slopes over 40° whatever drives it
(§4.7); four fixed boxes at ±100 m behind the rim top catch anything flung over it. The ledge is the Clearing's
cliff-edge hazard (SPEC:415, "shove one off a cliff", SPEC:24) and the giant's "steps off a ledge" trip (6 m > the 1.4 m
threshold). At 3 m it did 10.7 HP to an ape landing on its chest and 3.2 HP feet first; at 6 m it does 43.3 and 13.0 HP
(a brawl-weakened ape dies there), 10.2 HP and a knockdown to a player landing feet first, and 0 HP to the giant
(v_safe 14.07 m/s) **[I-rev ran: rev.out §4]** (RR-16).

**Content** (exact numbers in `CLEARING_TUNING`):

| Content | Count | Properties | Placement |
|---|---|---|---|
| Giant's route | 8 waypoints, loop ≈ 400 m | ellipse of radius 55 ± 8 m around (0, 10); waypoint 0 at the lair approach; ≥ 45 m from the spawn | one waypoint 6 m behind the ledge's high side; two legs between grove pairs (corridors 12-16 m wide); slope ≤ 25° along it |
| Lair | 1 | open ground at the north rim foot, r ≈ 78 m | route waypoint 0 leads there |
| Trees | **60** (SPEC:869) = 6 groves × 8 + 12 singles | green wood, diameter 0.20-0.30 m (50 %), 0.30-0.45 (35 %), 0.45-0.60 (15 %); height `clamp(6 + 18·d ± 1.5, 8, 16)` m; fixed 8-gon trunks | grove centres at 6 bearings 60° apart ± 15°, 30-65 m out, radius 10-15 m; Poisson rejection: ≥ 4 m apart, ≥ 15 m from the spawn, ≥ 6 m from the route, slope < 25°, inside the rim |
| Gates | 2 (of the 60) | two trees of d 0.5-0.6 m whose trunk surfaces are 1.8 m apart | grove edges facing the route: a person slips through, the giant (1.65 m radius, 2.0 m voxelised) can't (SPEC:774; MAP recast §9) |
| Hanging vines | 12 | vine rope (r 0.01 m), anchored 7 m to min(12 m, 0.8 × tree height) up a tree on its open side; length = anchor − 0.3 m + 3-8.5 m of slack lying on the ground (9.7-20.2 m); **4 long ones**: anchor ≥ 10 m with 8.5 m slack (≥ 18.2 m) | on the 12 tallest grove-edge trees (the long ones on trees ≥ 12.5 m); a `rope` joint record with `a` on the trunk and `b` loose on the ground; no Rapier joint; a sensor along it |
| Vine coils | 6 | 10, 12, 14, 16, 18, 20 m (shuffled), 1.9-3.8 kg | grove edges; the 12 m and 18 m coils within 20 m of the spawn |
| Saplings | 20 | green wood, d 0.04-0.08 m, h 2.5-3.5 m, rooted | 3-8 m outside grove rings; 4 within 25 m of the spawn |
| Boulders | 3 | stone hulls of 800 kg (D-22) | one 20 m from the spawn; two on the slope above a route leg |
| Stones | 40 | 25 throwing stones 0.5-3 kg, 15 weights 8-40 kg (hulls from 4 prototypes, scaled) | 3 outcrops (radius 4 m) + 5 throwing stones within 15 m of the spawn |
| Flint | 10 | nodules 0.3-1.0 kg, compact hulls, no edge yet | in the outcrops; 2 within 12 m of the spawn |
| Dry branches | 40 | dry wood, d 0.03-0.10 m, length 0.8-3.0 m (0.3-13 kg), 8-gon prisms | under groves; 8 within 25 m of the spawn, 2 of them straight 1.4-1.6 m × 5 cm (digging-stick blanks) |
| Dry logs | 5 | dry wood, d 0.25-0.40 m, length 3-5 m (81-346 kg), 6-gon prisms | grove edges; one 110-130 kg within 30 m of the spawn (draggable); one ≈ 300 kg beside a route leg |
| Rotten wood | 20 branches (2 kg: 2.5 m × 5 cm) + 2 logs (40 kg: 2 m × 25 cm) | rotten wood (a 2 kg branch holds 100 N) | the "damp grove" (one grove, rng) (D-24) |
| Grass bundles | 30 | leaves and dry grass, 1-3 kg flat boxes | meadows (cover ≥ 0.6) |
| Snags | 4 | dry deadwood logs 80-120 kg with 3 broken-branch points (sharpness 0.45, up and out at 45°) | one at the edge of each ape home, one at the foot of the ledge: hazards to knock an ape onto (SPEC:415; AC-9 pace) |
| Starter cache | 1 set | a stone axe (green stick 0.55 m × 4 cm + 0.6 kg flint with a 0.9 edge, lashed across), a digging stick (dry, 1.5 m × 5 cm, point 0.5), an 8 m vine coil; `credit: []` | (2.5, 3.0) beside the spawn: it shows how a tool is made without a recipe (SPEC:247) |
| Ape homes | 3 | home point + a 3-waypoint loop (radius 15 m) on the human layer | A 38 m from the spawn (meets the player in the first minutes); B ≈ 62 m; C ≈ 78 m; bearings ≥ 100° apart, at grove edges facing open ground |
| Player | 1 | spawn (0, 0) | facing ape home A |

Ground cover (`GroundCover`, a 100 × 100 grid of 2 m cells, `Uint8Array` 0..255 → 0..1): `cover = clamp(0.55 + 0.45 ·
n(x/30, z/30) − 0.4 · inGrove, 0, 1)`, 0 on the rim and within 3 m of a trunk, 0.4 around the spawn; digging sets a cell
to 0; read by perception (§6.2) and the grass renderer (§10.4); edits are saved (§8.3).

**Order and determinism.** Draws from `rngs.gen` only, never interleaved: noise tables → route and lair → groves →
trees (with gates) → hanging vines → saplings → outcrops → stones → flint → boulders → branches → logs → rotten wood →
grass → snags → starter cache → ape homes. Entity ids are allocated in exactly that order. Rejection sampling uses a
fixed 30 tries per item.

**Factories** (`world/factory.ts`, P07; the same calls generation, test scenes and dev spawns use):

```ts
export function spawnTree(w: World, o: { at: XZ; diameter: number; height: number;
  vine?: { anchorH: number; lengthM: number; yaw: number } }): { tree: number; vine: { rope: number; joint: number } | null };
export function spawnSapling(w: World, o: { at: XZ; diameter: number; height: number }): number;
export function spawnRopeCoil(w: World, o: { at: V3; material: 'vine' | 'sinew'; lengthM: number }): number;
export function spawnStick(w: World, o: { p: V3; q?: Quat; length: number; r: number; material?: MaterialId; sharp?: { end: 1 | -1; s: number } }): number;  // 8-gon
export function spawnLog(w: World, o: { p: V3; q?: Quat; length: number; r?: number; mass?: number; material?: MaterialId;
  state?: 'free' | 'anchored' | 'fixed'; snags?: number }): number;                                                      // 6-gon
export function spawnStone(w: World, o: { p: V3; mass: number; proto?: 0 | 1 | 2 | 3; material?: MaterialId }): number;   // stone or flint hulls
export function spawnBox(w: World, o: { p: V3; q?: Quat; size: [number, number, number]; material: MaterialId; state?: 'free' | 'fixed'; look: string }): number;
export function spawnGrass(w: World, o: { p: V3; mass: number; size?: [number, number, number] }): number;
export function spawnStarterAxe(w: World, at: V3): { stick: number; head: number; joint: number };
```

Checks (P21): exact counts; two generations from one seed byte-identical; no tree within 15 m of the spawn or 6 m of
the route; every route leg has a complete path on the ruler layer and every ape loop on the human layer; the rim slope
> 45° all round; the starter axe classifies as `stoneAxe` and the digging stick as `sharpStick` with `digs`; at least 4
hanging vines ≥ 17.96 m (§11.3).

### 6.8 Mind state in the save (records written by their owners, assembled by P13)

`MindRecV1 = { fighter, kind: 'ape' | 'giantApe', state, stateTick, paused, script, awareness: [targetId, aw][], lkp,
lkpTick, lastSeenTick, hurt: { tick, point } | null, homeIdx, routeIdx, restUntil, cooldownUntil, fleeUntil, heading,
charge: { heading, start, travelled, close } | null, path: { points, i, goal, tiles, versions, requestTick, pending } |
null, stuck: { pos, tick, count }, rng: uint32, inner: BrawlerRecV1 | null }` (the inner BrawlerAI's 20 history
fields, MAP gap-7 §3.3). `SpawnerRecV1 = { homes: { fighter: number | null; respawnTick: number }[]; sparring: {
fighter: number | null; respawnTick: number } }`.

## 7. Navigation (`world/nav.ts`, `world/navInput.ts`, P12)

- **Library**: `recast-navigation@0.43.1`; imports from `recast-navigation` and `recast-navigation/generators`
  (generators are not on the root entry, MAP recast §2.1); `init()` runs inside `physicsReady()`. Works in Node, Vitest
  and Vite with no config (MAP recast §2).
- **Layers**: one tiled navmesh per agent class over the whole Clearing (not per terrain chunk; MAP recast §10.2):

| Layer | Agents | radius / height / climb / max slope | cs / ch | tile | voxels (radius / height / climb) |
|---|---|---|---|---|---|
| human | player, ape (r 0.33 m fits) | 0.4 m / 1.8 m / 0.4 m / 45° | 0.2 / 0.2 m | 32 vox = 6.4 m | 2 / 9 / 2 |
| ruler | giant ape | 1.65 m (= `BODY_RADIUS` × 5.5, the radius `separate()` uses) / 10 m / 1.0 m / 40° | 0.5 / 0.25 m | 32 vox = 16 m | 4 (2.0 m effective) / 40 / 4 |

  Metres → voxels in one function: radius and height `ceil`, climb `floor` (recast truncates silently, MAP recast
  §3.2); `detailSampleDist` clamped ≥ 0.9 (lower values crash the WASM, MAP recast §7.6). A 2 m gap between trunks
  passes a person and blocks the giant (MAP recast §9).
- **Input geometry** (`navInput.ts`), built per tile from local geometry (byte-identical to the whole-mesh path, MAP
  recast §5.1): the terrain triangles of the tile's grown rect (`borderSize × cs`) with the heightfield's own diagonal
  split; every fixed, anchored or resting (`restTicks ≥ 30` or asleep) entity overlapping it, triangulated from its
  shape, in id order. **Ruler layer extrusion**: a blocker (fixed, anchored, or ≥ `blockerMinKg` 500 kg) whose top is
  above `terrain.originalHeightAt + 0.39 m` (the giant's ankle) is added as a box from its AABB bottom extruded up to
  `walkableHeight`, so the planner never steps over a staked log it would trip on (MAP recast §10.4). Blockers that do
  not rise above the original ground (stakes inside a dug pit) are plain triangles, so a covered pit stays walkable on
  the ruler layer (the cover's triangles are the top surface): the giant can be lured across it (C §6.4). Light entities
  appear as their real triangles on both layers ("the beast doesn't know"). Moving bodies, fighters and sensors are never
  input.
- **Dirty tiles**: a felling tree (its standing footprint at once, its landed AABB at rest); an entity coming to rest
  after moving > `dirtyMinMoveM` (0.25 m) or turning > `dirtyMinTurnDeg` (10°); placing, removing, breaking or
  cross-cutting an entity; a dig (the dug cone and the spoil point). Every tile whose grown rect overlaps the change's
  AABB is marked, on both layers. **Rebuilt synchronously in phase 16**, at most `tilesPerTick` per layer (human 2 at
  1.2-1.3 ms, ruler 1 at 3.4-4.2 ms: ≈ 7 ms on a rebuild tick, MAP recast §6), in sorted (layer, ty, tx) order, from the
  current sim state. A fixed count, never a millisecond budget (rule 7). Each tile has a `version` (Uint32) bumped on
  rebuild, and its human-layer walk bitmap and blocker bitmap (0.2 m cells, `NavWalkable`'s only data, §4.1) are
  rebuilt with it. The queue is in the save.
- **API**: §1.5.9. Positions only (poly refs die on rebuild, MAP recast §7.7). `complete` checks the last point's
  distance to the goal (recast reports partial paths as success, MAP recast §7.2). Query half-extents human (2, 4, 2),
  ruler (4, 6, 4). Creatures store waypoints and the versions of the tiles they cross and re-path when a version
  changes (§6.5).
- **Determinism**: identical input gives byte-identical navmeshes and identical paths in one or two processes, and
  incremental rebuilds equal a fresh build apart from Detour's link bookkeeping (MAP recast §8). `findRandomPoint*` (the
  only randomness, a process-global seed) is never called. The navmesh is not saved: the loader builds it fresh from
  terrain and entities and restores the dirty queue (`exportNavMesh` is version-tied).
- **Cost**: both full tiled builds ≈ 1.0-1.5 s in Node or Chromium for the 200 m Clearing (MAP recast §6), the bulk of
  `createWorld`'s time; tests that don't need AI pass `nav: 'off'`.

## 8. Determinism and the save format (`save/*`, P13; world ownership P05)

### 8.1 What the world owns (orchestrator decision 6)

- **Tick**: `world.tick` is `combat.frame`. The sim never reads wall time; `meta timeAway` is the only way it could enter
  (M3).
- **Ids**: `ids.fighter` (an `IdCounter` passed to every Fighter the world makes, MAP gap-7 §7 option 1: the 7
  id-sensitive legacy tests keep their numbering through `LEGACY_IDS`), `ids.entity`, `ids.joint`, `ids.wound`. Never
  reused. Same seed + same command log: 60/60 checkpoints bit-identical with a world-owned counter, 0/60 with the
  process-wide one **[C lab: e7_det, e7_det_legacy, F12]**.
- **RNG streams** (`WorldRngs`, each `new Rng(seedFor(seed, name, id))`): `combat` (`CombatSim.rng`, shared by
  BrawlerAIs as DS shares it), `world` (fracture, spawn jitter), `gen` (Clearing generation, consumed at creation only, so
  generation changes never shift combat draws), `fighter:<id>` (`Fighter.rng` via `rngSeed`, with id = `ids.fighter.next`
  at construction; idle keeps sharing it), `mind:<id>`. `seedFor(worldSeed, stream, id = 0)`: `h = FNV-1a32(stream)`;
  `h = Math.imul(h ^ worldSeed, 0x9e3779b1) >>> 0`; `h = Math.imul(h ^ id, 0x85ebca6b) >>> 0`; `h ^= h >>> 16`;
  return `h || 1`.
- **Order**: fighters step in `combat.fighters` order (insertion = id order, never re-sorted); entities, joints, wounds,
  nav tiles and events in id order; Rapier bodies, colliders and joints created and removed in id order (insertion and
  API-call order are part of Rapier's determinism, MAP rapier §7); impulses applied in id order (4d, 9b); the event
  drain sorted before use.
- **Module-level state**: `nextId` → `IdCounter`; `_timed` pure (cleanup agent); `usedSlots` belongs to the client's
  presentation world (D-42); the `getPose` cache is pure; scratch vectors carry nothing between calls (MAP gap-7 §2).
  Rapier and recast are process singletons whose only global randomness (Detour `FastRand`) is never used.
- **Live tuning is a command** (RR-17): the dev panel sends `meta 'dev' { op: 'setTuning', tuning: { table, key,
  value } }`, applied in phase 1c of its tick, so a replay of the command log reproduces every edit. Tests that change a
  table directly restore it (`restoreTuning`). Saves record non-default values (`tuningOverrides`); `loadWorld` applies
  them only when asked (`applyTuning`). The registry is per process; the client holds one live world, and tests that
  create several worlds in one process keep the defaults unless they say otherwise (SPEC:714 "counters belong to the
  world": tuning is not a counter, but a value that silently differs between worlds would be, so it never does).
- **Player numbers** (RR-18): commands carry the player number; `World.players` maps it to the fighter; credit uses
  `playerIdOf(n)`. A respawned player keeps the same Fighter object and number.
- **Forbidden in `packages/sim/src`** (checked by a grep test in P05): `Math.random`, `Date.now`, `performance.now`,
  `addForce`, `addTorque`, `addForceAtPoint` (code forces are impulses, C F3), `takeSnapshot`.

### 8.2 The AC-7 check

`bodyStateBytes(w): Uint8Array` = the concatenation, in owner order (entities by id; then per fighter by id: KCC body,
zone body, slab, ruler body: the raw f32 bits of `translation`, `rotation`, `linvel`, `angvel` of each Rapier body, MAP
rapier §7; then rope sensors by joint id: the collider's `translation` and `rotation` only, since a parentless collider
has no body and no velocity, RF-22), then the f64 bits of every fighter's `pos`, `vel`, `walkVel`,
`yaw`, `hp`, `stamina`, `stateFrame`, `Fighter.rng.state` and its 12 rig joints (position + quaternion), then
`combat.rng.state`. The AC-7 test (§11.7) compares `serializeWorld` and `bodyStateBytes` of two worlds every 60 ticks.

### 8.3 The canonical save

```ts
export interface SaveV1 {
  format: 'rotw-world'; formatVersion: 1;
  seed: number; tick: number;
  tuningOverrides: { table: string; key: string; value: number | boolean | string }[];   // sorted (table, key)
  counters: { fighter: number; entity: number; joint: number; wound: number; dropSerial: number; projSerial: number };
  rng: { combat: number; world: number; fighters: [number, number][]; minds: [number, number][] };   // uint32 states by id
  director: { lastAttack: number };
  pending: Command[];                           // CommandQueue order
  terrain: { tile: number; vertex: number; dh: number }[];   // edits vs generated heights, sorted
  dug: [number, number][];                      // (tile, vertex) of every ever-dug vertex, sorted (§4.13)
  cover: [number, number][];                    // (cell, value) edits, sorted
  entities: EntityRecV1[];                      // id order: every non-generated entity and every touched generated one
  removed: number[];                            // generated ids no longer present, sorted
  joints: JointRecV1[];                         // id order, incl. tension rings and pullN
  fighters: FighterRecV1[];                     // combat.fighters order
  minds: MindRecV1[];                           // by fighter id (§6.8)
  verbs: VerbStateRecV1[];                      // by fighter id
  spawner: SpawnerRecV1;
  drops: DropRecV1[]; projectiles: ProjRecV1[];
  bodies: { fighter: number; kcc: KccRecV1 /* incl. crouched */; zonesHistory: number[]; slab: SlabRecV1 | null;
    ruler: RulerBodyRecV1 | null }[];           // RulerBodyRecV1: body type, pose, velocities, the frozen local[b] trip
                                                // pose (12 × pos + quat), the zone pose history (RR-19)
  rulers: [number, RulerState][];               // HP, unhealed, wounds, flags (inPit), downWound, downCause,
                                                // lastWorldTrip, pin hysteresis, pending trip
  contacts: { creature: number; owner: string; touching: number; episodeStart: number; cooldownUntil: number }[];
                                                // ContactSystem's runtime maps, sorted (creature, owner key) (RR-19)
  contactGrace: [number, number][];             // (fighter, untilTick), sorted
  felling: { tree: number; phase: PlantState['phase']; fall: PlantState['fall'] }[];
  deaths: { fighter: number; respawnTick: number }[]; corpses: { fighter: number; removeTick: number }[];
  navDirty: [number, number, number][];         // (layer, ty, tx)
}
```

- **EntityRecV1** = every saved field of §2.3 (SPEC:729 lists material, shape, position, rotation, linvel, angvel,
  integrity, moisture, joints, credit; plus `grace` and `releasedBy`). Poses and velocities are the f32 values Rapier returned, so a rebuild reproduces
  them exactly (rebuilt at rest, awake, in the same order: within 0.114 cm and 0.343° over 10 s, MAP rapier §7).
- **FighterRecV1** = every field marked *Save* in MAP gap-7 §3.4-3.5 (state machine, timers, vitals, injuries, aim,
  skill fields, animator with key poses by value, footwork, idle, motion profile, private smoothing, `pose`; `rig`
  rebuilt by FK; `move` as `{ source, id, tempoKey }` now that `timed()` is pure), produced by P04's `toRecord()`
  accessors, plus the world fields (`playerId`, `species`, `massKg`, `toughnessJ`, `lastKnock`, `armour`, `inventory`,
  `drive`, `posture`, `work`, `verbRequest`, `verbAim`, `throwAim`, `moveFlags`, `jumpRequest`, `idlePaused`).
- **Writer** (`canonical.ts`): explicit per-record writers emit keys in a fixed order (never `JSON.stringify` of live
  objects); numbers through `num(v)`: finite → `String(v)` (shortest round trip, deterministic) except `-0` → `"-0"`;
  `Infinity`, `-Infinity`, `NaN` → the strings `"$inf"`, `"$-inf"`, `"$nan"`, read back by field-aware readers
  (`BrawlerAI.prevDist` starts at `Infinity`, MAP gap-7 §6). Arrays keep live order; sets and maps in insertion order.
- **Not saved**: events, `speeds`, `rig`, scratch poses, `motionInfo`, Rapier handles, the navmesh, `ai.armed`,
  `walkable`, KCC objects (recreated), the noise bus (empty at the end of a tick), ragdolls.
- **Touched**: a generated entity is saved when `touched` (set by any verb, joint, break, state change, or by the mirror
  when its pose leaves its generated pose by > 1 cm or 1°); untouched generated entities are regenerated from the seed on
  load (SPEC:728 "untouched forest isn't stored").
- **M1 scope**: `serializeWorld` covers everything above, so AC-7's byte comparison is a full-state check. `loadWorld`
  in M1 regenerates from the seed, applies terrain and cover edits, removes `removed`, restores entities, joints,
  rulers and wounds, felling state, counters, RNG states, minds' core state, the spawner, and each fighter's core state
  (position, yaw, vitals, state, inventory) and bodies, rebuilding animation fresh. The exact restore of animator,
  footwork, idle and BrawlerAI internals (MAP gap-7 §3.6-3.7: don't call `add()`'s `updatePose`; construct, then set the
  RNG state and overwrite idle `t`/`bouncePhase`) uses P04's `restoreRecord()` and lands with M3's "save, load, save"
  gate (SPEC:917). M1's AC-2 uses `loadWorld` to reuse a built pit scene (§11.2).
- **Versions**: `formatVersion` 1; `migrate()` is the identity ladder; a fixture save checked into
  `packages/sim/tests/fixtures/save-v1.json` is loaded by a test so M3's migrations have a v1 to start from.
- **Completeness** (RR-19): P13's test diff-checks the keys of every record against an inventory that covers every
  system's runtime state, not only the fighter's: `ContactSystem` (counts, episodes, cooldowns, grace), `ZoneBodies`
  and `RulerBodies` (histories, local poses), `JointStore` (tension rings, free lengths, held ends, `pullN`),
  `Loads` (`loadHist`), `Breaking` (grace), `Felling`, `NavSystem` (dirty queue), `VerbSystem`, minds, the spawner and
  devOps-paused flags. A system that adds a runtime map adds it to the inventory, or the test fails.

## 9. Tuning tables

Every starting value lives in a live tuning table (SPEC:12), defined and registered in its home module with
`defineTuning(name, folder, table, fields)` (§1.5.11), where `fields` gives every leaf its unit and source (a registry
test fails on a leaf without metadata, so this section and the code cannot drift apart silently). The dev panel builds
one Tweakpane folder per `folder` path and one binding per field (§10.10). Acceptance-test parameters (6 m/s, 300 kg,
30 m/s, 0.05 m/s, 10 s, 15 m, 10 m, 10 min, 800 kg, 40 kg) are test constants, never tuning (MAP spec-m1 §(b) advice),
so a test does not change when someone tunes.

**Source key**: `SPEC:N` = a spec starting value at that line; `D-n` = an accepted proposal of MAP/spec-m1.md;
`DS` = an existing DungeonStyle number (kept); `orchestrator decision n` = the brief; **`NEW`** = a value the spec
doesn't give, chosen by this design (with its reason or evidence). §9.2 lists exactly the `NEW` rows. The first
integration generated the table from one list (`design/lab-integrator/tuning.mjs`): 33 tables, 370 rows, 252 of them
`NEW`. Revision 2 added one table (`BODY_MASS_TUNING`), removed two rows (the name-keyed armour values, RR-3) and added
33, 30 of them `NEW` (§14): 34 tables, 401 rows, 282 `NEW`. `DT` (1/60 s, rule 7) is a fixed constant, not tuning;
values owned by later milestones, and the DS constants rule 5 rests on, are listed in §9.3 so none is lost. A P38 test
(`tests/noBareConstants.test.ts`) fails on a numeric literal in `world/**`, `save/**` or `sim/{rules,ruler,impact,
species}.ts` outside the tuning tables, with an allowlist of 0, 1, 2, 0.5, −1, π multiples, 1e-9 and unit conversions
(RR-7). **As built (P38):** the allowlist is maths (0, ±1, 2, ±0.5, 3 and 4 as dimensions and exact-formula
constants, 180 and 360 for degrees), any tolerance |v| ≤ 1e-6, literal types, panel ranges (`min`/`max`/`step`) of
field metadata, and per-file allowances each with its reason (bit masks, Recast/Detour limits, byte sizes, unit
conversions, formula constants, loop guards, DS's flat-ground fixture; `tests/support/bareConstants.ts` and the
`ALLOW` table of the test); the same scan covers the client logic M1 wrote (`apps/client/tests/tuningDoc.test.ts`).
Both tests also fail on a registered tuning key with no §9.1 row; the rows the packages added after this section was
written are under "Registered keys added at P38" (generated by `tools/tuning-rows.mjs`).

### 9.1 Every starting value, by table

#### DAMAGE_TUNING — `packages/sim/src/sim/rules.ts` (folder "Damage rule", P02a)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| DAMAGE_TUNING | kS | 3 | — | SPEC:281 |
| DAMAGE_TUNING | K | 18 | J/HP | SPEC:283 |
| DAMAGE_TUNING | meleeJPerDmg | 18 | J per DS damage point | SPEC:283 |
| DAMAGE_TUNING | throwCapJ | 400 | J | SPEC:285, 886 |
| DAMAGE_TUNING | leadingCos | 0.7 | cos | DS (projectileStrike leading test) |
| DAMAGE_TUNING | tipRadiusM | 0.15 | m | NEW: a sharp point counts only near its tip |
| DAMAGE_TUNING | impactCooldownTicks | 6 | ticks | NEW: bounce suppression per pair |
| DAMAGE_TUNING | minImpactJ | 5 | J | NEW: ignore brushes (with \|Δv\| < flinchDv) |
| DAMAGE_TUNING | hardLandingBluntOnly | true | — | D-4 |
| DAMAGE_TUNING | zoneGraceTicks | 2 | ticks | NEW: contacts starting this soon after a pose jump are never scored (RF-1) |

#### MOVE_TUNING — `packages/sim/src/sim/rules.ts` (folder "Bodies › movement", P02a)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| MOVE_TUNING | sprintMul | 1.4 | × speed | NEW: DS run 3.77 → sprint 5.28 m/s (SPEC:370) |
| MOVE_TUNING | sprintStaminaPerS | 0.15 | stamina/s | NEW: 6.7 s from full |
| MOVE_TUNING | sprintMinStamina | 0.1 | stamina | NEW |
| MOVE_TUNING | crouchSpeedMul | 0.5 | × speed | NEW |
| MOVE_TUNING | jumpStamina | 0.05 | stamina | NEW |
| MOVE_TUNING | jumpBufferFrames | 6 | ticks | NEW: D-28 jump press buffer (RR-7) |
| MOVE_TUNING | carrySpeedPerKg | 0.01 | 1/kg | NEW: SPEC:387 "carrying slows you" |
| MOVE_TUNING | carrySpeedMin | 0.6 | × speed | NEW (40 kg → 0.6) |
| MOVE_TUNING | carryRegenPerKg | 0.015 | 1/kg | NEW: SPEC:387 "costs stamina" |
| MOVE_TUNING | carryRegenMin | 0.4 | × regen | NEW |
| MOVE_TUNING | carryNoSprintKg | 20 | kg | NEW |
| MOVE_TUNING | dragSpeedMul | 0.75 | × walk | NEW |
| MOVE_TUNING | pullWalkMul | 0.2 | × walk | NEW: braced while pulling |

#### IMPACT_TUNING — `packages/sim/src/sim/impact.ts` (folder "Damage rule › world impacts", P09)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| IMPACT_TUNING | poisePerHp | 3.2 | poise/HP | DS (hit poise damage) |
| IMPACT_TUNING | bluntPoiseMul | 1.35 | × | DS |
| IMPACT_TUNING | weightMediumHp | 5 | HP | DS (projectileStrike weight) |
| IMPACT_TUNING | weightHeavyHp | 12 | HP | DS |
| IMPACT_TUNING | hitstunBase | 12 | frames | DS (projectileStrike) |
| IMPACT_TUNING | hitstunPerHp | 0.9 | frames/HP | DS |
| IMPACT_TUNING | launchDv | 5 | m/s | NEW: above every DS knockback (max 4.6), MAP gap-2 §8 |
| IMPACT_TUNING | flinchDv | 0.5 | m/s | NEW: MAP gap-2 §8 |
| IMPACT_TUNING | envKillWindowS | 2 | s | SPEC:415 |
| IMPACT_TUNING | envKillPartsMul | 2 | × parts | SPEC:415 ("pay double parts"), D-30 |
| IMPACT_TUNING | creatureRestitution | 0 | — | NEW: off-by-default rule-9 lever, Δv × (1 + e) creature on creature (RR-6, §4.4) |
| IMPACT_TUNING | unbackedTargetMassRatio | Infinity (off) | × | NEW: off-by-default SPEC:417 lever (RR-6, §4.4) |
| IMPACT_TUNING | partsRingR / partsDropH | 0.6 / 0.3 | m × scale / m | NEW: where parts appear (RR-7) |

#### WORLD_TUNING — `packages/sim/src/world/worldTuning.ts` (folder "World", P05)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| WORLD_TUNING | clearingSize | 200 | m | SPEC:869 |
| WORLD_TUNING | gravityY | -9.81 | m/s² | SPEC:618 |
| WORLD_TUNING | aiNearM | 60 | m | NEW: SPEC:698 says only "near the player" |
| WORLD_TUNING | aiFarPeriodTicks | 60 | ticks | SPEC:698, 789 (1 Hz) |
| WORLD_TUNING | respawnDelayS | 10 | s | SPEC:421 |
| WORLD_TUNING | spawnX | 0 | m | D-33 |
| WORLD_TUNING | spawnZ | 0 | m | D-33 |
| WORLD_TUNING | corpseDespawnS | 120 | s | NEW |
| WORLD_TUNING | corpseDespawnMinDistM | 40 | m | NEW: a corpse is removed only out of the player's way (RR-11) |
| WORLD_TUNING | elementsPeriodTicks | 6 | ticks | SPEC:702 (10 Hz; M2 hook) |
| WORLD_TUNING | slowPeriodTicks | 60 | ticks | SPEC:702 (1 Hz; M3 hook) |

#### TERRAIN_TUNING — `packages/sim/src/world/terrain.ts` (folder "World › terrain", P05)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| TERRAIN_TUNING | tileSize | 25 | m | NEW: D-7 (8 × 8 tiles = one 200 m chunk) |
| TERRAIN_TUNING | spacing | 0.25 | m | NEW: D-7, MAP rapier §2 (a 0.5 m dig needs ≤ 0.25 m) |
| TERRAIN_TUNING | terrainChunkSize | 64 | m | SPEC:97 (M3 generator) |
| TERRAIN_TUNING | material | 'dirt' | — | NEW: D-22 (friction 0.7, soft) |
| TERRAIN_TUNING | digDepthM | 0.15 | m per strike (peak) | SPEC:241, 883 |
| TERRAIN_TUNING | digRadiusM | 0.5 | m | SPEC:241, 883 |
| TERRAIN_TUNING | maxDigDepthM | 3 | m below original | SPEC:97 |
| TERRAIN_TUNING | digKernel | 'cone' | — | D-40 |
| TERRAIN_TUNING | softGroundMaxHardness | 0.5 | hardness | NEW: D-19 |
| TERRAIN_TUNING | pileMergeR | 1.5 | m | NEW |
| TERRAIN_TUNING | pileCapKg | 150 | kg | D-40 (the drag limit) |
| TERRAIN_TUNING | maxPilesNear | 12 | piles | NEW: SPEC:803 body budget (§4.13) |
| TERRAIN_TUNING | pilesNearR | 10 | m | NEW |
| TERRAIN_TUNING | spoilMinGapM | 0.5 | m beyond the dig radius | NEW |
| TERRAIN_TUNING | spoilSearchMaxM | 15 | m | NEW |
| TERRAIN_TUNING | spoilMaxRiseM | 1 | m above original | NEW |
| TERRAIN_TUNING | spoilUndugTolM | 0.05 | m | NEW: a vertex lowered more than this is ever dug |
| TERRAIN_TUNING | spoilSetbackM | 1.5 | m | NEW: spoil never lands within this of dug ground (RT-2; 3,573 strikes, rim 0-0.23 m [RT lab: spoil_setback.out]) |

#### PHYSICS_TUNING — `packages/sim/src/world/physics.ts` (folder "Physics", P05)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| PHYSICS_TUNING | entityExtraSolverIters | 4 | iterations | MAP rapier finding 11 (orchestrator decision 5) |
| PHYSICS_TUNING | entityLinDamp | 0 | 1/s | NEW |
| PHYSICS_TUNING | entityAngDamp | 0.1 | 1/s | NEW |
| PHYSICS_TUNING | ccdMinHalfExtent | 0.15 | m | NEW: SPEC:267 asks CCD for fast small bodies |
| PHYSICS_TUNING | cylinderFacets | 8 | sides | NEW: C F1, MAP rapier finding 17 |
| PHYSICS_TUNING | logFacets | 6 | sides | NEW: C F1, F2 (logs rest) |
| PHYSICS_TUNING | forceEventThresholdN | 2,000 | N | NEW: dev cross-check only |
| PHYSICS_TUNING | restSpeed | 0.05 | m/s | NEW |
| PHYSICS_TUNING | restTicks | 30 | ticks | NEW |
| PHYSICS_TUNING | settleDriftM / settleSwingM / settleS | 0.005 / 0.05 / 2 | m / m / s | NEW (P38): the settle rule (EntityStore.settle): a free body whose extreme points' mean positions moved < settleDriftM between two windows of settleS / 2, and swung < settleSwingM, is put to sleep (Rapier's speed thresholds never see through its heightfield contact jitter: thin branches rocked and crept for ever) |

#### MATERIALS — `packages/sim/src/world/materials.ts` (folder "Materials", P03)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| MATERIALS | greenWood | density 800; hardness 0.5; maxSharpness 0.5; flammability 0.2; strength 40 J/kg; springiness 0.6; friction 0.6 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:208 |
| MATERIALS | dryWood | density 550; hardness 0.5; maxSharpness 0.6; flammability 0.8; strength 30 J/kg; springiness 0.2; friction 0.6 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:209 |
| MATERIALS | rottenWood | density 400; hardness 0.1; maxSharpness 0.1; flammability 0.5; strength 5 J/kg; springiness 0; friction 0.6 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:210 |
| MATERIALS | leaves | density 100; hardness 0; maxSharpness 0; flammability 1; strength 1 J/kg; springiness 0; friction 0.4 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:211 |
| MATERIALS | vine | density 600; hardness 0.1; maxSharpness 0; flammability 0.5; strength 6 kN; springiness 0.1; friction 0.7 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:212 |
| MATERIALS | sinew | density 1100; hardness 0.2; maxSharpness 0; flammability 0.3; strength 18 kN; springiness 0.2; friction 0.7 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:213 |
| MATERIALS | hide | density 1100; hardness 0.3; maxSharpness 0; flammability 0.3; strength 20 J/kg; springiness 0.1; friction 0.6 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:214 |
| MATERIALS | bone | density 1900; hardness 0.7; maxSharpness 0.8; flammability 0.1; strength 60 J/kg; springiness 0.1; friction 0.5 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:215 |
| MATERIALS | rulerBone | density 2100; hardness 0.9; maxSharpness 0.9; flammability 0; strength 200 J/kg; springiness 0.1; friction 0.5 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:216 |
| MATERIALS | stone | density 2600; hardness 0.9; maxSharpness 0.2; flammability 0; strength 150 J/kg; springiness 0; friction 0.7 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:217 |
| MATERIALS | flint | density 2600; hardness 0.95; maxSharpness 1; flammability 0; strength 40 J/kg; springiness 0; friction 0.6 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:218 |
| MATERIALS | dirt | density 1500; hardness 0.2; maxSharpness 0; flammability 0; strength 5 J/kg; springiness 0; friction 0.7 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:219 |
| MATERIALS | snow | density 300; hardness 0.1; maxSharpness 0; flammability 0; strength 2 J/kg; springiness 0; friction 0.3 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:220 |
| MATERIALS | ice | density 900; hardness 0.6; maxSharpness 0.3; flammability 0; strength 20 J/kg; springiness 0; friction 0.05 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:221 |
| MATERIALS | resin | density 1000; hardness 0; maxSharpness 0; flammability 1; strength n/a (null); springiness 0; friction 0.3 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:222 |
| MATERIALS | fat | density 900; hardness 0; maxSharpness 0; flammability 0.9; strength n/a (null); springiness 0; friction 0.1 | kg/m³; 0-1; 0-1; 0-1; J/kg or kN; 0-1; 0-1 | SPEC:223 |
| MATERIALS | *.wetMassPerMoisture | 0 | kg/kg per unit moisture | NEW: M2 rule, 0 in M1 (SPEC:180, 324) |
| MATERIALS | hide.armourJ / bone.armourJ | 20 / 40 | J added to a covered zone | SPEC:885, 417 (RR-3) |
| MATERIALS | *.armourJ (every other row) | 0 | J | NEW: no spec value; rulerBone TODO "ruler-bone armour value" (RR-3) |

#### BODY_MASS_TUNING — `packages/sim/src/body/mass.ts` (folder "Creatures › bodies", P02a)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| BODY_MASS_TUNING | boneKg {pelvis, abdomen, chest, head, upperArmL/R, foreArmL/R, thighL/R, shinL/R} | 10, 8, 15, 5.5, 2.2, 1.7, 9, 4.5 (73.3 kg in all) | kg at scale 1 | SPEC:876 (DS `MASS`, ragdoll.ts); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | zoneShare {head, chest, abdomen, legs} (read-out, derived from boneKg) | 7.5 %, 31.1 %, 24.6 %, 36.8 % | fraction | SPEC:876 (kept as the HurtZone totals, decision 2) |

#### SPECIES_BODY — `packages/sim/src/sim/species.ts` (folder "Creatures › bodies", P03)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| SPECIES_BODY | human.scale | 1 | × | SPEC:368 |
| SPECIES_BODY | human.massKg | 73.3 | kg | SPEC:876 (Σ BONE_MASS) |
| SPECIES_BODY | human.maxHp | 100 | HP | SPEC:368 |
| SPECIES_BODY | human.toughnessJ | 0 | J | SPEC:288 |
| SPECIES_BODY | human.vSafe | 6 | m/s | SPEC:284 |
| SPECIES_BODY | human.footRadiusM | 0.12 | m × scale | NEW: D-39 footprint |
| SPECIES_BODY | human.massShareMode | 'bone' | — | orchestrator decision 2 (D-2) |
| SPECIES_BODY | ape.scale | 1.1 | × | SPEC:873 |
| SPECIES_BODY | ape.massKg | 97.56 | kg | NEW: 73.3 × 1.1³ (SPEC:660 "mass with size³") |
| SPECIES_BODY | ape.maxHp | 90 | HP | SPEC:873 |
| SPECIES_BODY | ape.toughnessJ | 0 | J | SPEC:873 |
| SPECIES_BODY | ape.vSafe | 6.29 | m/s | D-4 (6·√1.1) |
| SPECIES_BODY | ape.footRadiusM | 0.12 | m × scale | NEW |
| SPECIES_BODY | ape.massShareMode | 'bone' | — | orchestrator decision 2; playtest lever (§4.15) |
| SPECIES_BODY | ape.parts | hide ×1 (2 kg box); bone ×2 (0.5 kg) | entities | NEW: D-30 |
| SPECIES_BODY | giantApe.scale | 5.5 | × | SPEC:874 |
| SPECIES_BODY | giantApe.massKg | 14,000 | kg | SPEC:874 |
| SPECIES_BODY | giantApe.maxHp | 12,000 | HP | SPEC:874 |
| SPECIES_BODY | giantApe.toughnessJ | per zone (RULER_ZONE_TUNING) | J | SPEC:875 |
| SPECIES_BODY | giantApe.vSafe | 14.07 | m/s | D-4 (6·√5.5) |
| SPECIES_BODY | giantApe.footRadiusM | 0.12 | m × scale (0.66 m) | NEW |
| SPECIES_BODY | giantApe.massShareMode | 'bone' | — | orchestrator decision 2 |
| SPECIES_BODY | giantApe.parts | hide ×4 (20 kg); rulerBone ×6 (5 kg) | entities | NEW: D-30 |
| SPECIES_BODY | *.defense | 0 | fraction | D-13 |

#### RULER_TUNING — `packages/sim/src/sim/ruler.ts` (folder "Ruler", P11)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RULER_TUNING | recoveryHpPerS | 30 | HP/s | SPEC:504, 877 |
| RULER_TUNING | woundFrac | 0.02 | × max HP (240 HP) | SPEC:502 |
| RULER_TUNING | severeFrac | 0.15 | × max HP (1,800 HP) | SPEC:503 |
| RULER_TUNING | woundHealHpPerHour | 50 | HP per hour of play | SPEC:506, 877 |
| RULER_TUNING | severePenaltyFrac | 0.05 | × max HP per severe wound | SPEC:506 |
| RULER_TUNING | pinnedKg | 1,000 | kg | SPEC:878 |
| RULER_TUNING | unpinnedKg | 900 | kg | NEW: hysteresis |
| RULER_TUNING | unpinTicks | 15 | ticks | NEW: hysteresis |
| RULER_TUNING | pinnedNormalY | 0.5 | cos | D-38 |
| RULER_TUNING | lockScale | 2 | × | NEW: MAP gap-0 §6.6 (lock-on range for rulers) |
| RULER_TUNING | retargetBiasCapM | 0.35 | m | NEW: MAP gap-0 §6.6 |
| RULER_TUNING | separateSkipSpeed | 1.0 | m/s | NEW: above this closing speed `separate()` doesn't push a pair with a standing ruler; the contact scores instead (RF-5) |

#### RULER_ZONE_TUNING — `packages/sim/src/sim/ruler.ts` (folder "Ruler › zones", P11)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RULER_ZONE_TUNING | softJ | 600 | J | SPEC:875 (eyes, mouth, belly, knees, elbows) |
| RULER_ZONE_TUNING | armourJ | 4,000 | J | SPEC:875 (skull, back, shoulders, flanks) |
| RULER_ZONE_TUNING | defaultJ | 4,000 | J | D-8 (unlisted surfaces) |
| RULER_ZONE_TUNING | kneeR | 0.09 | m × scale | NEW: MAP gap-0 §5, gap-6 |
| RULER_ZONE_TUNING | elbowR | 0.07 | m × scale | NEW: MAP gap-0 §5 |
| RULER_ZONE_TUNING | eyeNzMin / eyeNyMin / eyeNyMax / eyeNxMax | 0.6 / −0.05 / 0.35 / 0.55 | normal components | NEW: MAP gap-0 §5 |
| RULER_ZONE_TUNING | mouthNzMin / mouthNyMin / mouthNyMax / mouthNxMax | 0.6 / −0.6 / −0.05 / 0.4 | normal components | NEW |
| RULER_ZONE_TUNING | shouldersNy / backNz / flanksNx | 0.6 / −0.4 / 0.6 | normal components | NEW |
| RULER_ZONE_TUNING | bellyNz / bellyNxMax | 0.5 / 0.6 | normal components | NEW |

#### RULER_BODY_TUNING — `packages/sim/src/world/rulerBody.ts` (folder "Ruler › body", P11)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RULER_BODY_TUNING | tripSpeed | 4 | m/s (root horizontal) | SPEC:782, 879; D-10 |
| RULER_BODY_TUNING | getupAfterS | 4 | s | SPEC:782, 879 |
| RULER_BODY_TUNING | shoveLimitKg | 500 | kg | SPEC:781, 880 |
| RULER_BODY_TUNING | deflectMaxDeg | 30 | ° | SPEC:781 |
| RULER_BODY_TUNING | impactTripMinKg | 500 | kg | SPEC:879 (blocking class) |
| RULER_BODY_TUNING | sweepSkinM | 0.05 | m | NEW |
| RULER_BODY_TUNING | ledgeTripDropFrac | 0.5 | × knee height (1.4 m) | NEW: D-9 (e) |
| RULER_BODY_TUNING | getupFrames | 94 | frames | NEW: 40·√5.5, MAP gap-3 §2.3 |
| RULER_BODY_TUNING | getupKneelFrame | 52 | frame | NEW: DS 0.55 of the track |
| RULER_BODY_TUNING | trippedLinDamp | 0.1 | 1/s | NEW: orchestrator decision 5, MAP gap-3 |
| RULER_BODY_TUNING | trippedAngDamp | 1 | 1/s | NEW: orchestrator decision 5 |
| RULER_BODY_TUNING | trippedExtraIters | 4 | iterations | NEW: MAP gap-3 |
| RULER_BODY_TUNING | tripPose | 'freeze' | — | NEW: MAP gap-3 |
| RULER_BODY_TUNING | friction | 0.9 | — | NEW |
| RULER_BODY_TUNING | restitution | 0.05 | — | NEW |
| RULER_BODY_TUNING | stepUpMaxM | 1.0 | m per tick | NEW: the ruler nav layer's climb (RR-1, RF-14) |
| RULER_BODY_TUNING | maxSlopeDeg | 40 | ° | NEW: the ruler nav layer's slope (RR-1) |
| RULER_BODY_TUNING | climbRateMps / climbWalkMps / climbMaxM | 0.4 / 0.5 / 4.5 | m/s / m/s / m | NEW: climbing out of a pit (3 m max dig + 1 m berm < 4.5 m) (RR-1) |
| RULER_BODY_TUNING | pitDownDepthFrac | 0.5 | × knee height (1.4 m) | NEW: "in a pit" (SPEC:504), the ledge threshold (RR-1) |
| RULER_BODY_TUNING | coverTripWindowTicks | 30 | ticks | NEW: a ledge trip this soon after a cover load break is a `'cover'` trip (RT-1) |

#### CHARACTER_TUNING — `packages/sim/src/world/characters.ts` (folder "Bodies › controllers", P08)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CHARACTER_TUNING | pushN | 500 | N | SPEC:374, 881 |
| CHARACTER_TUNING | capsuleR | 0.3 | m × scale | DS (BODY_RADIUS) |
| CHARACTER_TUNING | capsuleHalfH | 0.6 | m × scale | NEW: 1.8 m tall |
| CHARACTER_TUNING | kccOffset | 0.02 | m × scale | NEW: MAP rapier §3 |
| CHARACTER_TUNING | snapToGround | 0.3 | m × scale | NEW: MAP rapier §3 |
| CHARACTER_TUNING | autostepMaxH | 0.4 | m × scale | NEW: D-28 (climb = autostep) |
| CHARACTER_TUNING | autostepMinW | 0.2 | m × scale | NEW |
| CHARACTER_TUNING | autostepDynamic | true | — | NEW |
| CHARACTER_TUNING | maxSlopeClimbDeg | 45 | ° | NEW: MAP rapier §3 |
| CHARACTER_TUNING | minSlopeSlideDeg | 30 | ° | NEW: MAP rapier §3 |
| CHARACTER_TUNING | jumpSpeed | 4.2 | m/s × √scale | NEW: D-28 (≈ 0.9 m jump) |
| CHARACTER_TUNING | landingKnockdownSpeed | 9 | m/s | NEW |
| CHARACTER_TUNING | crouchHeightFrac | 0.7 | × capsule height | NEW: a crouched ape is 1.39 m, so it fits under a deadfall log (RT-4) |

#### DOWNED_TUNING — `packages/sim/src/world/downed.ts` (folder "Bodies › downed", P08)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| DOWNED_TUNING | halfWidth / halfLength / halfThick / border | 0.20 / 0.865 / 0.06 / 0.04 | m × scale | NEW: MAP gap-4 §8 |
| DOWNED_TUNING | friction / restitution | 0.9 / 0.05 | — | NEW: MAP gap-4 |
| DOWNED_TUNING | linDamp / angDamp | 0.05 / 0.6 | 1/s | NEW: MAP gap-4 |
| DOWNED_TUNING | toppleRadS | 2.5 | rad/s ÷ √scale | NEW: MAP gap-4 |
| DOWNED_TUNING | liftBase / liftPerLift | 1.2 / 3 | m/s / (m/s per lift) | DS (game.ts launch) |
| DOWNED_TUNING | minPush | 0.8 | m/s | NEW: MAP gap-4 |
| DOWNED_TUNING | settleSpeed | 0.5 | m/s | NEW |
| DOWNED_TUNING | settleMaxHold | 300 | frames | NEW |
| DOWNED_TUNING | standRings | [0.35, 0.70, 1.05] | m | NEW: MAP gap-4 §6 |
| DOWNED_TUNING | standDirs | 8 | directions | NEW |
| DOWNED_TUNING | maxStandSlopeDeg | 45 | ° | NEW |
| DOWNED_TUNING | boneBands | [0.50, 0.94, 1.09, 1.29, 1.55] | m along the slab × scale (shin/thigh/pelvis/abdomen/chest/head) | NEW: from the skeleton |

#### JOINT_TUNING — `packages/sim/src/world/joints.ts` (folder "Materials & joints › ropes", P10)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| JOINT_TUNING | tripwireWindowS | 0.1 | s | SPEC:259 |
| JOINT_TUNING | ropeBreakSteps | 3 | steps | SPEC:261 |
| JOINT_TUNING | tautEps | 0.001 | m | NEW: MAP rapier §5 |
| JOINT_TUNING | lashLeverM | 0.1 | m | D-18 (vine 600 J, sinew 1,800 J) |
| JOINT_TUNING | ropeSensorR | 0.02 | m | NEW |
| JOINT_TUNING | strandMergeM | 0.05 | m | NEW: SPEC:266 strands |
| JOINT_TUNING | nnlsMaxGroups | 8 | strand groups per body | NEW: C F5 |
| JOINT_TUNING | bendK | 400,000 | N·m/rad per m² of diameter | NEW (6 cm green sapling: 864 N·m/rad) |
| JOINT_TUNING | bendDamping | 40,000 | N·m·s/rad per m² | NEW |
| JOINT_TUNING | bendMinSpringiness | 0.3 | — | NEW: springy predicate |
| JOINT_TUNING | burnSpeedMps | 0.05 | m/s | SPEC:261 (M2) |

#### BREAK_TUNING — `packages/sim/src/world/breaking.ts` (folder "Materials & joints › breaking", P10)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| BREAK_TUNING | integrityPerExcess | 1 | — | D-17 |
| BREAK_TUNING | piecesMin | 2 | pieces | SPEC:344 |
| BREAK_TUNING | piecesMax | 4 | pieces | SPEC:344 |
| BREAK_TUNING | loadLeverM | 0.1 | m | SPEC:345, 884 |
| BREAK_TUNING | pieceGraceTicks | 10 | ticks | NEW: C §7 item 7 (the minimum; the grace lasts until the piece is clear) |
| BREAK_TUNING | pieceGraceMaxTicks | 600 | ticks | NEW: a piece still inside its breaker after 10 s is crushed (RF-7) |

#### LOAD_TUNING — `packages/sim/src/world/loads.ts` (folder "Materials & joints › loads", P10)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| LOAD_TUNING | loadWindowS | 0.2 | s | SPEC:345 |
| LOAD_TUNING | maxSpreadDepth | 4 | levels | NEW: D-39 |
| LOAD_TUNING | supportNormalY | 0.5 | cos | NEW |
| LOAD_TUNING | footDiscH | 0.06 | m | NEW: D-39 |
| LOAD_TUNING | spanGapM | 0.1 | m | NEW: an entity is load-tested only where nothing supports it within this below the load point (I-1) |

#### FELL_TUNING — `packages/sim/src/world/felling.ts` (folder "Materials & joints › felling", P10)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| FELL_TUNING | chopDepthM | 0.02 | m per stone-axe chop | SPEC:882 |
| FELL_TUNING | refChopJ | 339 | J | NEW: the stone axe's fresh chop [B lab: tools.ts] |
| FELL_TUNING | chopScaleMin | 0.5 | × | NEW |
| FELL_TUNING | chopScaleMax | 2.5 | × | NEW |
| FELL_TUNING | fellAtRemaining | 0 | fraction of diameter | D-44 (0 keeps SPEC:882's 15 chops for 30 cm) |
| FELL_TUNING | hingeK | 1,500 | — | NEW: calibrated in §4.12 |
| FELL_TUNING | hingeRad | 0.1 | rad | NEW: impact → moment |
| FELL_TUNING | cutHeightM | 0.5 | m | NEW |
| FELL_TUNING | tipAngVel | 0.15 | rad/s | NEW |
| FELL_TUNING | hingeTearDeg | 75 | ° | NEW: C F10 |
| FELL_TUNING | hingeLimitDeg | 80 | ° | NEW |

#### NAV_TUNING — `packages/sim/src/world/nav.ts` (folder "Navigation", P12)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| NAV_TUNING | human.radius / height / climb / maxSlopeDeg | 0.4 / 1.8 / 0.4 / 45 | m / m / m / ° | NEW: MAP recast §10.3 |
| NAV_TUNING | human.cs / ch / tileVox | 0.2 / 0.2 / 32 | m / m / voxels | NEW: MAP recast §10.3 |
| NAV_TUNING | human.halfExtents / tilesPerTick | [2, 4, 2] / 2 | m / tiles | NEW: MAP recast §6, §10.3 |
| NAV_TUNING | ruler.radius | 1.65 | m | DS (BODY_RADIUS × 5.5); SPEC:774 |
| NAV_TUNING | ruler.height / climb / maxSlopeDeg | 10 / 1.0 / 40 | m / m / ° | NEW: MAP recast §10.3 |
| NAV_TUNING | ruler.cs / ch / tileVox | 0.5 / 0.25 / 32 | m / m / voxels | NEW |
| NAV_TUNING | ruler.halfExtents / tilesPerTick | [4, 6, 4] / 1 | m / tiles | NEW |
| NAV_TUNING | maxSimplificationError / minRegionArea / mergeRegionArea | 1.3 / 8 / 20 | voxels | NEW: MAP recast §10.3 |
| NAV_TUNING | maxVertsPerPoly / detailSampleDist / detailSampleMaxError | 6 / 6 / 1 | — / voxels / voxels | NEW: MAP recast §7.6 (≥ 0.9) |
| NAV_TUNING | maxNodes | 2,048 | nodes | NEW |
| NAV_TUNING | dirtyMinMoveM / dirtyMinTurnDeg | 0.25 / 10 | m / ° | NEW |
| NAV_TUNING | blockerMinKg | 500 | kg | SPEC:880 |
| NAV_TUNING | extrudeAboveAnkleM | 0.39 | m above original ground | NEW: the giant's ankle (§7) |

#### CLEARING_TUNING — `packages/sim/src/world/clearing.ts` (folder "World › Clearing", P21)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CLEARING_TUNING | trees | 60 | trees | SPEC:869 |
| CLEARING_TUNING | groves / treesPerGrove / singleTrees | 6 / 8 / 12 | count | NEW |
| CLEARING_TUNING | treeDiamBands | 0.20-0.30 (50 %), 0.30-0.45 (35 %), 0.45-0.60 (15 %) | m | NEW |
| CLEARING_TUNING | treeHeight | clamp(6 + 18·d ± 1.5, 8, 16) | m | NEW |
| CLEARING_TUNING | groveDistM / groveRadiusM / groveBearingJitterDeg | 30-65 / 10-15 / 15 | m / m / ° | NEW |
| CLEARING_TUNING | treeMinGapM / spawnClearM / routeClearM / maxSlopeDeg | 4 / 15 / 6 / 25 | m / m / m / ° | NEW |
| CLEARING_TUNING | gates / gateGapM / gateDiamM | 2 / 1.8 / 0.5-0.6 | count / m / m | NEW: SPEC:774, MAP recast §9 |
| CLEARING_TUNING | hangingVines / vineAnchorM / vineAnchorMaxFrac / vineSlackM | 12 / 7-12 / 0.8 / 3-8.5 | count / m / × tree height / m | NEW |
| CLEARING_TUNING | longVines / longVineAnchorM / longVineSlackM / longVineTreeMinH | 4 / ≥ 10 / 8.5 / 12.5 | count / m / m / m | NEW: AC-3 needs ≥ 17.96 m |
| CLEARING_TUNING | vineCoilsM | 10, 12, 14, 16, 18, 20 | m | NEW |
| CLEARING_TUNING | saplings / saplingDiamM / saplingHeightM / saplingsNearSpawn | 20 / 0.04-0.08 / 2.5-3.5 / 4 | count / m / m / count | NEW |
| CLEARING_TUNING | boulders / boulderKg | 3 / 800 | count / kg | NEW (AC-6 mass) |
| CLEARING_TUNING | throwingStones / throwingStoneKg | 25 / 0.5-3 | count / kg | NEW |
| CLEARING_TUNING | weightStones / weightStoneKg / outcrops / outcropR | 15 / 8-40 / 3 / 4 | count / kg / count / m | NEW |
| CLEARING_TUNING | flint / flintKg / flintNearSpawn | 10 / 0.3-1.0 / 2 | count / kg / count | NEW |
| CLEARING_TUNING | dryBranches / branchDiamM / branchLenM / branchesNearSpawn / stickBlanks | 40 / 0.03-0.10 / 0.8-3.0 / 8 / 2 | count / m / m / count / count | NEW |
| CLEARING_TUNING | dryLogs / logDiamM / logLenM | 5 / 0.25-0.40 / 3-5 | count / m / m | NEW |
| CLEARING_TUNING | rottenBranches / rottenBranchSize | 20 / 2.5 m × 5 cm (2 kg) | count / m | NEW: D-24 |
| CLEARING_TUNING | rottenLogs / rottenLogSize | 2 / 2 m × 25 cm (40 kg) | count / m | NEW: D-24 |
| CLEARING_TUNING | grassBundles / grassKg | 30 / 1-3 | count / kg | NEW |
| CLEARING_TUNING | snags / snagKg / snagPoints / snagSharpness | 4 / 80-120 / 3 / 0.45 | count / kg / count / — | NEW: AC-9 pace |
| CLEARING_TUNING | starterCacheAt | (2.5, 3.0) | m | NEW |
| CLEARING_TUNING | apeHomes / apeHomeDistM / homeLoopR | 3 / 38, 62, 78 / 15 | count / m / m | NEW |
| CLEARING_TUNING | routeWaypoints / routeRadiusM / routeCentre / routeMinSpawnDistM / lairR | 8 / 55 ± 8 / (0, 10) / 45 / 78 | count / m / m / m / m | NEW |
| CLEARING_TUNING | floorAmpM / floorScalesM / flatInnerM / flatOuterM | 1.5 / 48, 16 / 15 / 25 | m | NEW |
| CLEARING_TUNING | rimHeightM / rimRadiusM / rimWidthM | 18 / 82 ± 5 / 14 | m | NEW |
| CLEARING_TUNING | ledgeDropM / ledgeLenM / ledgeCentre / ledgeTransitionM / ledgeFadeM | 6 / 30 / (40, −35) / 3 / 25 | m | NEW (6 m, was 3 m: a real cliff-edge hazard for an ape, RR-16) |
| CLEARING_TUNING | coverBase / coverAmp / coverScaleM / coverGrovePenalty / coverTrunkClearM / coverSpawn / coverCellM | 0.55 / 0.45 / 30 / 0.4 / 3 / 0.4 / 2 | — / — / m / — / m / — / m | NEW |
| CLEARING_TUNING | rejectionTries | 30 | tries | NEW |

#### VERB_TUNING — `packages/sim/src/world/verbs/tuning.ts` (folder "Verbs", P14)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| VERB_TUNING | targetRadiusM | 2.5 | m | SPEC:406 |
| VERB_TUNING | standOffM | 0.6 | m | NEW |
| VERB_TUNING | faceTurnRate | 0.12 | fraction of the remaining angle per tick | NEW: work actions turn toward their target (RR-7) |
| VERB_TUNING | handReachM | 1.3 | m from the chest | NEW: rule 3 (tie ≤ ~2.5 m up) |
| VERB_TUNING | anchorSurfaceTolM | 0.3 | m | NEW |
| VERB_TUNING | bufferFrames | 12 | ticks | DS (press buffer) |
| VERB_TUNING | carryMaxKg | 40 | kg × scale² | SPEC:235, 387 |
| VERB_TUNING | dragMaxKg | 150 | kg × scale² | SPEC:235, 387 |
| VERB_TUNING | twoHandCarryKg / twoHandCarryLenM | 10 / 1.5 | kg / m | NEW |
| VERB_TUNING | takeFramesBase / takeFramesPerKg | 18 / 0.8 | ticks / ticks per kg | NEW (DS pickup 18 + 7·heft is too slow for 40 kg) |
| VERB_TUNING | dropFrames / stowFrames / drawFrames | 12 / 30 / 24 | ticks | NEW |
| VERB_TUNING | dragForceN | 600 | N | NEW: [B lab: drag.ts] |
| VERB_TUNING | dragLiftFrac | 0.5 | × weight | NEW: [B lab: drag.ts] |
| VERB_TUNING | tetherM | 1.6 | m | NEW |
| VERB_TUNING | dragKp / dragKd / dragHandOffsetM | 3,000 / 300 / 0.8 | N/m / N·s/m / m | NEW: [B lab: drag.ts] (RR-7) |
| VERB_TUNING | liftKp / liftKd / liftHandM | 2,000 / 200 / 0.9 | N/m / N·s/m / m | NEW: [B lab: drag.ts] (RR-7) |
| VERB_TUNING | beltSlots | 3 | slots | SPEC:385 |
| VERB_TUNING | beltMaxKg / beltMaxLenM / backMaxKg | 4 / 0.6 / 40 | kg / m / kg | NEW (SPEC:385-386 "small items", "one bundle") |
| VERB_TUNING | placeReachM / placeSupportM | 2.5 / 0.6 | m | NEW |
| VERB_TUNING | placeReachVertM / placeShrinkM / placeDropM | 1.5 / 0.02 / 0.02 | m | NEW (RR-7) |
| VERB_TUNING | placeFramesLying / placeFramesDriven | 24 / 60 | ticks | NEW |
| VERB_TUNING | stakeAnchorDepthM | 0.3 | m | NEW: D-19 |
| VERB_TUNING | anchorHoldNPerM | 4,000 | N per m driven (1,200 N) | NEW: D-19 |
| VERB_TUNING | shapeStrokeFrames / shapeStep / knapStep / shapeHardnessMargin | 60 / 0.10 / 0.15 / 0.1 | ticks / sharpness / sharpness / hardness | NEW: D-9 (i) |
| VERB_TUNING | lashTouchM / lashRopeUseM / lashSnapMaxKg / spliceLossM | 0.15 / 1.0 / 3 / 0.5 | m / m / kg / m | NEW |
| VERB_TUNING | lashSnapM | 0.4 | m | NEW: snap-assist reach (RR-7) |
| VERB_TUNING | lashFrames / tieFrames / untieFrames / spliceFrames | 90 / 60 / 60 / 60 | ticks | NEW |
| VERB_TUNING | bendMaxDiamM / bendMaxForceN / bendMinDeg / bendFrames | 0.12 / 500 / 20 / 90 | m / N / ° / ticks | NEW |
| VERB_TUNING | cutHardnessMargin / crossCutRestartM | 0.2 / 0.15 | hardness / m | NEW: D-9 (k) |
| VERB_TUNING | minStrikePower | 0.45 | swing power | DS (MIN_POWER, combat.ts:112) |
| VERB_TUNING | strikeMassKg | 6 | kg | NEW: strike push m_eff (§5.2) |
| VERB_TUNING | focusHeightM | 1 | m | NEW |
| VERB_TUNING | handDigFrames / handDigDepthMul | 72 / 0.25 | ticks / × | NEW: D-9 (j), SPEC:241 "slow" |
| VERB_TUNING | projectileMaxKg | 2 | kg | D-29 |
| VERB_TUNING | smallThrowSpeed | 20 | m/s | D-29, SPEC:297 |
| VERB_TUNING | heavyThrowSpeed | 12 | m/s | NEW: DS throwHeavy |
| VERB_TUNING | throwChargeS / throwMinFrac / throwSpinRadS | 0.6 / 0.5 / 1.5 | s / × / rad/s | NEW |
| VERB_TUNING | pullForceN | 500 | N | D-26 (orchestrator decision 4) |
| VERB_TUNING | pullYankN / pullYankTicks | 1200 / 9 | N / ticks | NEW: SPEC:237 "yank out a prop"; C F1 (492-1,277 N) |
| VERB_TUNING | pullHandSpeedMps / pullStaminaPerS / pullTiredMul | 1.5 / 0.15 / 0.6 | m/s / stamina/s / × | NEW: C §5 |
| VERB_TUNING | creaturePullMul / creatureHandSpeedMps | 1.5 / 0.8 | × pullForceN × scale² / m/s | NEW: C §5 (ape 907.5 N) |
| VERB_TUNING | haulTautM / haulRampMps | 0.05 / 0.2 | m / m/s | NEW: the haul model (I-2) [I-rev ran: swing_light.out] |

#### TOOL_TUNING — `packages/sim/src/world/verbs/tuning.ts` (folder "Verbs › tools", P14)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| TOOL_TUNING | toolMaxKg / toolMinLenM / toolMaxLenM | 6 / 0.12 / 2.6 | kg / m / m | NEW |
| TOOL_TUNING | minAspect / compactMaxAspect / headZoneM | 5 / 2.2 / 0.3 | — / — / m | NEW |
| TOOL_TUNING | pointMinSharpness / edgeMinSharpness | 0.3 / 0.5 | sharpness | NEW |
| TOOL_TUNING | twoHandMinLenM / spearMinLenM / cudgelMinKg / stoneMaxKg / digMinHardness | 1.1 / 1.6 / 1.5 / 3 / 0.4 | m / m / kg / kg / hardness | NEW |
| TOOL_TUNING | stoneAxe {damageMul, cut, cleave, bite, tempo, choke} | 1.2, 0.7, 0.45, 10, 1.0, 0 | DS WeaponDef units | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | longAxe {…} | 1.4, 0.9, 0.8, 14, 1.1, 0.4 | DS WeaponDef units | NEW (fireaxe analogue) |
| TOOL_TUNING | spear {…} | 1.3, 0.85, 0, 8, 1.0, 0 | DS WeaponDef units | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | sharpStick {…} | 1.0, 0.4, 0, 4, 0.9, 0.1 | DS WeaponDef units | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | stick {…} | 1.0, 0, 0, 0, 0.9, 0 | DS WeaponDef units | NEW (bokken) |
| TOOL_TUNING | cudgel {…} | 1.45, 0, 0, 0, 1.0, 0.12 | DS WeaponDef units | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | stone {…} | 1.1, 0, 0, 0, 0.85, 0 | DS WeaponDef units | NEW (SPEC:397) |
| TOOL_TUNING | flintBlade {…} | 1.2, 0.8, 0, 4, 0.8, 0 | DS WeaponDef units | NEW (kunai analogue) |
| TOOL_TUNING | lengthTrimM / pointHeadM / edgeHeadFrac / radiusMinM / radiusMaxM / haftMarginM | 0.08 / 0.15 / 0.15 / 0.03 / 0.08 / 0.02 | m / m / × length / m / m / m | NEW: `synthWeapon` (RR-7) |
| TOOL_TUNING | refSharpness {stoneAxe, longAxe, flintBlade; spear, sharpStick} | 0.9; 0.6 | sharpness | NEW: the sharpness a class's DS template stands for (RR-13) |
| TOOL_TUNING | pointTaperRadii | 5 | × radius | NEW: the shaped point's taper (0.25 m on a 5 cm stake, the C labs' hull) (RF-18) |

#### CREATURE_TUNING — `packages/sim/src/world/creatures/defs.ts` (folder "Creatures › minds", P18)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CREATURE_TUNING | shared.navQueriesPerTick | 4 | queries/tick | NEW: MAP recast §6 |
| CREATURE_TUNING | shared.crouchSightMul / coverSightMul / coverMin | 0.6 / 0.35 / 0.5 | × / × / cover | NEW: SPEC:754 |
| CREATURE_TUNING | shared.movingMinSpeed / peripheralDeg / peripheralMul | 0.5 / 20 / 0.5 | m/s / ° / × | NEW |
| CREATURE_TUNING | shared.occluderMinKg / seenWithinS / awarenessCap | 100 / 1 / 1.5 | kg / s / — | NEW |
| CREATURE_TUNING | shared.hurtByFighter / hurtByWorld | 1.5 / 0.9 | awareness | NEW |
| CREATURE_TUNING | shared.sightRayTolM / repathCheckTicks / stuckAskSpeed / maxPathFailures | 0.3 / 15 / 0.5 / 3 | m / ticks / m/s / count | NEW (RR-7) |
| CREATURE_TUNING | ape.walkSpeed | 2.8 | m/s (DS stat) | SPEC:873, D-21 |
| CREATURE_TUNING | ape.staggerResist / readSkill / blockChance / aggression / stringChance | 0.4 / 0.5 / 0.4 / 0.8 / 0 | — | DS (bruiser); NEW stringChance 0 |
| CREATURE_TUNING | ape.plan | Bruiser (enemies.ts:185-208), range 1.0 × 1.1, attackRange 1.25 × 1.1 | — | SPEC:873 |
| CREATURE_TUNING | ape.sightConeDeg / sightRangeM / sightRangeStillM / hearingMul | 140 / 30 / 18 / 1.0 | ° / m / m / × | NEW: D-9 (c) |
| CREATURE_TUNING | ape.seenRate / heardGain / decayPerS | 2.5 / 0.6 / 0.12 | 1/s / — / 1/s | NEW |
| CREATURE_TUNING | ape.investigateAt / chaseAt / chaseMemoryS | 0.25 / 1.0 / 8 | — / — / s | NEW |
| CREATURE_TUNING | ape.gait wander / patrol / investigate / chase / flee / return | 0.35 / 0.45 / 0.6 / 1.0 / 1.0 / 0.6 | moveInput | NEW |
| CREATURE_TUNING | ape.homeRadiusM / idleWanderS / idleS / loopRadiusM / lookAroundS | 8 / 6-14 / 20-40 / 15 / 3 | m / s / s / m / s | NEW |
| CREATURE_TUNING | ape.lookAroundDeg | 60 | ° | NEW (RR-7) |
| CREATURE_TUNING | ape.fightEnterM / fightExitM / fightExitTicks | 4.5 / 8 / 60 | m / m / ticks | NEW |
| CREATURE_TUNING | ape.fleeHpFrac / fleeChance / fleeS / fleeDistM / gloatS | 0.25 / 0.5 / 6-10 / 25 / 3 | — / — / s / m / s | NEW |
| CREATURE_TUNING | ape.respawnS / respawnMinPlayerDistM / respawnRetryS | 300 / 40 / 10 | s / m / s | NEW: D-9 (q) |
| CREATURE_TUNING | ape.arriveM / repathMoveM / repathTicks / stuckMinM / stuckTicks | 0.6 / 1.5 / 30 / 0.3 / 90 | m / m / ticks / m / ticks | NEW |
| CREATURE_TUNING | ape.sparringDistM / sparringRespawnS | 3 / 3.2 | m / s | NEW: D-50 (DS training cadence) |
| CREATURE_TUNING | giant.sightConeDeg / sightRangeM / sightRangeStillM / hearingMul | 120 / 60 / 35 / 1.2 | ° / m / m / × | NEW: D-9 (c) |
| CREATURE_TUNING | giant.seenRate / heardGain / decayPerS / investigateAt / chaseAt / chaseMemoryS | 1.5 / 0.5 / 0.08 / 0.3 / 1.0 / 10 | — | NEW |
| CREATURE_TUNING | giant.speed patrol / investigate / chase / telegraph / charge / flee | 1.8 / 1.4 / 4.5 / 1.0 / 7.0 / 4.0 | m/s | NEW: D-9 (b) |
| CREATURE_TUNING | giant.turn patrol / chase / telegraph / charge | 30 / 45 / 70 / 8 | °/s | NEW: charge [B lab: charge.mjs] |
| CREATURE_TUNING | giant.cornerMinFrac | 0.35 | × speed | NEW: slowest corner speed on patrol (RR-7) |
| CREATURE_TUNING | giant.accel patrol / chase / telegraph / charge; brake | 1 / 2 / 4 / 5; 4 | m/s² | NEW |
| CREATURE_TUNING | giant.telegraphS / closeTelegraphS | 1.0 / 0.6 | s | NEW: D-9 (d), SPEC:787 |
| CREATURE_TUNING | giant.chargeMinM / chargeMaxM / chargeBearingDeg / closeChargeM / closeBearingDeg | 8 / 30 / 25 / 7 / 40 | m / m / ° / m / ° | NEW |
| CREATURE_TUNING | giant.chargeMaxDistM / closeChargeDistM / passEndM | 35 / 9 / 6 | m | NEW |
| CREATURE_TUNING | giant.blockedSpeed / blockedTicks / blockedGraceS | 1.5 / 15 / 0.5 | m/s / ticks / s | NEW |
| CREATURE_TUNING | giant.chargeCooldownS / recoverS | 5 / 0.8 | s | NEW |
| CREATURE_TUNING | giant.probeHeightFrac / probeRadiusM / probeMinMassKg / bankMaxRiseM / bankSampleM | 0.55 / 0.8 / 300 / 2.0 / 2 | × pelvis height / m / kg / m / m | NEW |
| CREATURE_TUNING | giant.restS / sniffS / sniffDeg / investigateStopM / lairRestS / fleeSevereS | 20-40 / 3 / 45 / 4 / 30 / 20 | s / s / ° / m / s / s | NEW |
| CREATURE_TUNING | giant.arriveM / repathMoveM / repathTicks / stuckMinM / stuckTicks | 2.5 / 4 / 60 / 0.8 / 120 | m / m / ticks / m / ticks | NEW |
| CREATURE_TUNING | giant.limpSpeedMul / limpChargeMul / limpTelegraphMul / limpTurnMul | 0.6 / 0.7 / 1.3 / 0.8 | × | NEW: D-9 (u) |
| CREATURE_TUNING | giant.blindDeadDeg / blindApproachDeg | 15 / 25 | ° | NEW: D-9 (u) |
| CREATURE_TUNING | giant.weakJawRoarMul / windedCooldownMul / windedChaseMul / woundAwareness | 0.6 / 1.5 / 0.85 / 1.2 | × / × / × / awareness | NEW |

#### NOISE_TUNING — `packages/sim/src/world/creatures/defs.ts` (folder "Creatures › senses", P18)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| NOISE_TUNING | stepCrouch / stepWalk / stepRun / stepSprint | 2 / 6 / 12 / 20 | m (× scale) | NEW: SPEC:755 |
| NOISE_TUNING | hit / block / clang | 25 / 15 / 25 | m | NEW |
| NOISE_TUNING | chop / dig / shape / stakeDriven | 40 / 15 / 10 / 20 | m | NEW |
| NOISE_TUNING | throwLand / ropeSnap / breakNoise | 12 / 35 / 25 | m | NEW |
| NOISE_TUNING | heavyLandBase / heavyLandPerKg / heavyLandMax | 10 / 0.15 / 120 | m / m per kg / m | NEW: SPEC:466 (a falling tree) |
| NOISE_TUNING | apeShout / giantRoar | 30 / 120 | m | NEW |
| NOISE_TUNING | crouchNoiseMul | 0.3 | × | NEW |

#### GAME_TUNING — `apps/client/src/game/game.ts` (folder "Client › game", P31)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| GAME_TUNING | timeScale / paused / hitstopMul / showHitboxes / volume | 1 / false / 1 / false / 0.7 | — / — / × / — / 0-1 | DS (game.ts:49) |
| GAME_TUNING | showNav / showSenses / showZones | false / false / false | — | NEW: dev views |

#### LOOP_TUNING — `apps/client/src/game/loop.ts` (folder "Client › loop", P31)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| LOOP_TUNING | maxStepsPerFrame | 6 | steps | DS (game.ts frame) |
| LOOP_TUNING | slowmoScale | 0.25 | × | DS |
| LOOP_TUNING | parrySlowmoS / dismemberSlowmoS / playerKoSlowmoS | 0.35 / 0.6 / 1.5 | s | DS (MAP game-loop §4) |
| LOOP_TUNING | treeFallHitstop / treeFallHitstopRangeM | 4 / 25 | frames / m | NEW |

#### CAMERA_TUNING — `apps/client/src/render/cameraRig.ts` (folder "Client › camera", P34)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CAMERA_TUNING | fov / distance / rise / sideAngle / shoulder | 52 / 3.4 / 2.35 / 0.6 / 0.7 | ° / m / m / rad / m | DS (cameraRig.ts:3) |
| CAMERA_TUNING | turnRate / follow / shakeMul / focusMix | 3.2 / 7 / 1 / 0.55 | DS units | DS |
| CAMERA_TUNING | groundClearanceM | 0.3 | m | NEW: replaces arena containment |

#### FOLLOW_TUNING — `apps/client/src/render/followCam.ts` (folder "Client › follow camera", P34)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| FOLLOW_TUNING | distance / minDistance / maxDistance / zoomStep | 4.2 / 2.2 / 7.5 / 0.4 | m | NEW |
| FOLLOW_TUNING | lookHeight / shoulder / clearance | 1.55 / 0.55 / 0.35 | m (× scale for lookHeight) | NEW |
| FOLLOW_TUNING | pitchDeg / minPitchDeg / maxPitchDeg | 14 / −25 / 65 | ° | NEW |
| FOLLOW_TUNING | mouseSens / stickSens / follow | 0.0022 / 2.6 / 9 | rad/px / rad/s / 1/s | NEW |
| FOLLOW_TUNING | boomSamples | 8 | samples | NEW |
| FOLLOW_TUNING | rulerPullbackPerScale / rulerRangeM / rulerPitchDeg | 0.8 / 35 / 8 | m per scale / m / ° | NEW: MAP client §4 |
| FOLLOW_TUNING | blendS | 0.45 | s | NEW |
| FOLLOW_TUNING | aimDistance / aimShoulder / aimFovMul | 2.4 / 0.75 / 0.85 | m / m / × | NEW |
| FOLLOW_TUNING | fightRangeM | 9 | m | DS (lock-on camera range) |

#### KILLCAM_TUNING — `apps/client/src/game/killcam.ts` (folder "Client › kill cam", P36)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| KILLCAM_TUNING | cooldownS | 4 | s per moment kind | NEW |
| KILLCAM_TUNING | envKill {dist, height, orbit, fov, durationS, slow, priority} | 3.8 × max(1, 0.75·scale), 0.55, 0.3, 38, 2.2, 0.18, 4 | m, m, rad, °, s, ×, — | DS (game.ts finishing shot) |
| KILLCAM_TUNING | worldWound {…, dolly} | 3.3·scale, −0.15·scale, −0.12, 42, 2.4, 0.25, 4.5; dolly −0.35 | m, m, rad, °, s, ×, — | NEW (DS boss-intro framing, MAP client §3.3) |
| KILLCAM_TUNING | rulerDeath {…} | 4·scale, 0.3·scale, 0.1, 40, 4.0, 0.2, 6 | m, m, rad, °, s, ×, — | NEW |
| KILLCAM_TUNING | playerByRuler {…} | 7, 2.5, 0.2, 44, 2.6, 0.3, 5.5 | m, m, rad, °, s, ×, — | NEW |

#### VERB_UI_TUNING — `apps/client/src/input/verbInput.ts` (folder "Client › verb UI", P35)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| VERB_UI_TUNING | targetConeDeg / fightTargetConeDeg | 28 / 50 | ° | NEW |
| VERB_UI_TUNING | radialDeadPx / secondTimeoutS / wheelStepDeg / padRotateDegS | 28 / 10 / 15 / 90 | px / s / ° / °/s | NEW: D-48 |
| VERB_UI_TUNING | arcPoints / highlightScale | 48 / 1.04 | points / × | NEW |
| VERB_UI_TUNING | markerRangeM / compassPingS / compassSeeRangeM | 60 / 30 / 120 | m / s / m | NEW |

#### RENDER_TUNING — `apps/client/src/render/terrainView.ts` (folder "Client › render", P32)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RENDER_TUNING | nearTileM / nearSpacing / farSpacing / lodHysteresisM | 40 / 0.25 / 0.5 / 5 | m | NEW |
| RENDER_TUNING | grassRadiusM / grassPerCell | 60 / 3 | m / tufts | NEW |
| RENDER_TUNING | fogNear / fogFar / cameraFar | 70 / 190 / 600 | m | NEW |
| RENDER_TUNING | shadowExtentM / shadowFarM / shadowMap | 40 / 120 / 2048 | m / m / px | NEW |
| RENDER_TUNING | chopShudderDeg / chopShudderS / creakBelowRemaining | 0.6 / 0.25 / 0.3 | ° / s / fraction | NEW: SPEC:581 |
| RENDER_TUNING | strainShowFrac / integrityCrack / integritySag | 0.6 / 0.6 / 0.3 | fraction | NEW: rule 3, SPEC:362 |
| RENDER_TUNING | ropeThinMax / ropeFrayFrac | 0.3 / 0.8 | fraction | NEW: SPEC:357-358 |
| RENDER_TUNING | fallenCrownPadM | 0.15 | m | NEW: a falling or felled crown is drawn within the trunk radius + this (rule 3, RR-15) |

#### PRESENTATION_TUNING — `apps/client/src/game/presentationWorld.ts` (folder "Client › presentation", P33)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| PRESENTATION_TUNING | maxRagdolls / mirrorRadiusM | 8 / 30 | ragdolls / m | NEW: SPEC:655-656 (ragdoll LOD) |

#### RAGDOLL_TUNING — `apps/client/src/body/ragdoll.ts` (folder "Client › ragdoll", P33)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RAGDOLL_TUNING | muscleGain / rootGain / impulseMul / dipMul / limpStrength / strikeGain | 0.55 / 0.45 / 1 / 1 / 0.12 / 0.92 | DS units | DS (ragdoll.ts:20) |
| RAGDOLL_TUNING | downRootGain | 0.15 | fraction per step | NEW: down-follow toward the sim slab |

#### FEEL_TUNING — `apps/client/src/feel/audio.ts` (folder "Client › feel", P37)

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| FEEL_TUNING | giantShakeRadiusPerScale / giantShakePerScale | 6 / 0.05 | m per scale / trauma per scale | NEW: SPEC:849 |
| FEEL_TUNING | ambienceQuietRangeM / creakFrom | 40 / 0.5 | m / strain | NEW: SPEC:851, 357 |

#### Registered keys added at P38

Keys the packages registered after the tables above were written (their values, units and sources are the registry's, generated by `tools/tuning-rows.mjs`; P38, RR-7). The P38 tests fail on a registered key with no §9.1 row, so code and this section can no longer drift apart silently.

##### BODY_MASS_TUNING (folder "Creatures › bodies")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| BODY_MASS_TUNING | boneKg.pelvis | 10 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: pelvis); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.abdomen | 8 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: abdomen); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.chest | 15 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: chest); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.head | 5.5 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: head); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.upperArmL | 2.2 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: upperArmL); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.foreArmL | 1.7 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: foreArmL); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.upperArmR | 2.2 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: upperArmR); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.foreArmR | 1.7 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: foreArmR); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.thighL | 9 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: thighL); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.shinL | 4.5 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: shinL); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.thighR | 9 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: thighR); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | boneKg.shinR | 4.5 | kg at scale 1 | SPEC:876 (DS MASS, ragdoll.ts: shinR); orchestrator decision 2 (RR-2) |
| BODY_MASS_TUNING | zoneShare.head | 0.07503410641200545 | fraction | SPEC:876 (head 7.5 %; a read-out of boneKg, decision 2) |
| BODY_MASS_TUNING | zoneShare.chest | 0.311050477489768 | fraction | SPEC:876 (chest with arms 31.1 %; a read-out of boneKg, decision 2) |
| BODY_MASS_TUNING | zoneShare.abdomen | 0.24556616643929055 | fraction | SPEC:876 (abdomen with pelvis 24.6 %; a read-out of boneKg, decision 2) |
| BODY_MASS_TUNING | zoneShare.legs | 0.36834924965893584 | fraction | SPEC:876 (legs 36.8 %; a read-out of boneKg, decision 2) |

##### SPECIES_BODY (folder "Creatures › bodies")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| SPECIES_BODY | human.defense | 0 | fraction | D-13 |
| SPECIES_BODY | human.parts | [] | entities | §2.7 (a player drops no parts) |
| SPECIES_BODY | ape.defense | 0 | fraction | D-13 |
| SPECIES_BODY | giantApe.defense | 0 | fraction | D-13 |

##### DAMAGE_TUNING (folder "Damage rule")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| DAMAGE_TUNING | bladeSharpness | 0.8 | sharpness | NEW: a DS blade without its own sharpness (§4.4, D-12) |
| DAMAGE_TUNING | integrityPointMass | true | — | NEW: orchestrator decision (P10's design conflict): an entity's integrity reads its effective mass at the contact point, 1/(1/m + (r×n)ᵀI⁻¹(r×n)), not its whole mass (departs from §4.3's m_eff table and SPEC:278 for integrity only; off = the table) |

##### MOVE_TUNING (folder "Bodies › movement")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| MOVE_TUNING | limpStanceMul | 0.4 | × amount | NEW: §6.4 limp row: the bad leg's stance time × (1 − this × amount) |
| MOVE_TUNING | limpStepHeightMul | 0.5 | × step height | NEW: §6.4 limp row: the bad leg's step height × |
| MOVE_TUNING | limpMinStepFrames | 4 | ticks | DS footwork.ts: its shortest hurried step (Math.max(4, dur − 2)); the floor on a limp's quickened swing |

##### BLEED_TUNING (folder "Damage rule › bleeding")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| BLEED_TUNING | clotSmallS | 180 | s | NEW: owner's decision after P39 (bleeds close); starting value for the playtest: a small cut's 2-7 min bleeding time (Ivy) |
| BLEED_TUNING | clotRefSeep | 0.0375 | bleed units | NEW: DS's smallest cut's seep (rate 0.15 × floor 0.25, combat.ts addWound); starting value for the playtest |
| BLEED_TUNING | clotSizeExp | 1 | — | NEW: clot time ∝ seep^this (1: the largest DS cut 6.7 × the smallest, 20 min); starting value for the playtest |

##### IMPACT_TUNING (folder "Damage rule › world impacts")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| IMPACT_TUNING | releaseApartTicks | 2 | ticks | NEW: §2.3, §4.3 (RF-3): a released entity's contacts with its releaser score again once apart this long |
| IMPACT_TUNING | castWindowTicks | 1.5 | ticks | NEW: §4.3 sensor normals: Shape.castShape over 1.5·DT from the start-of-previous-step poses |
| IMPACT_TUNING | hitstunIntensityBase | 0.25 | — | DS (hit: rock = 0.25 + dmg/12), §4.4 hitstun row |
| IMPACT_TUNING | hitstunIntensityPerHp | 0.08333333333333333 | 1/HP | DS (hit: rock = 0.25 + dmg/12), §4.4 hitstun row |
| IMPACT_TUNING | landMinJ | 20 | J | NEW: §3 9e "land events for heavy landings": the energy a landing needs to report one |
| IMPACT_TUNING | hintImpulsePerNs | 0.25 | per N·s | DS (projectileStrike impulse = momentum × 0.25): impact event hint |
| IMPACT_TUNING | hintImpulseMax | 60 | — | DS (projectileStrike impulse cap 60): impact event hint |
| IMPACT_TUNING | hintLift | 0.05 | — | DS (projectileStrike lift 0.05): impact event hint |
| IMPACT_TUNING | hintHitstopBase | 4 | frames | DS (projectileStrike hitstop 4 + min(8, dmg/3)): impact event hint |
| IMPACT_TUNING | hintHitstopPerHp | 0.3333333333333333 | frames/HP | DS (projectileStrike hitstop): impact event hint |
| IMPACT_TUNING | hintHitstopMax | 8 | frames | DS (projectileStrike hitstop): impact event hint |
| IMPACT_TUNING | hintShakeBase | 0.08 | — | DS (projectileStrike shake 0.08 + dmg/50, at most 0.5): impact event hint |
| IMPACT_TUNING | hintShakePerHp | 0.02 | 1/HP | DS (projectileStrike shake): impact event hint |
| IMPACT_TUNING | hintShakeMax | 0.5 | — | DS (projectileStrike shake): impact event hint |

##### RULER_TUNING (folder "Ruler")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RULER_TUNING | stickMinHold | 4 | frames | DS (hit: an edge sticks max(4, hold)); §4.6 step 4 |
| RULER_TUNING | stickRetract | 12 | frames | DS (hit: retract 12, 16 for a heavy move); §4.6 step 4 |
| RULER_TUNING | stickRetractHeavy | 16 | frames | DS (hit: retract 12, 16 for a heavy move); §4.6 step 4 |
| RULER_TUNING | hookHoldMul | 0.6 | × | DS (hit: a hook bites 0.6 as long) |
| RULER_TUNING | koHoldMul | 0.6 | × | DS (hit: a finishing blow bites 0.6 as long) |
| RULER_TUNING | reboundHoldWeapon | 3 | frames | DS (hit: a blunt weapon rebounds 3, 11) |
| RULER_TUNING | reboundHoldUnarmed | 2 | frames | DS (hit: a fist or foot rebounds 2) |
| RULER_TUNING | reboundRetractWeapon | 11 | frames | DS (hit: a blunt weapon rebounds 3, 11) |
| RULER_TUNING | reboundRetractKick | 10 | frames | DS (hit: a foot retracts 10) |
| RULER_TUNING | reboundRetractPunch | 8 | frames | DS (hit: a fist retracts 8) |
| RULER_TUNING | bumpHold | 3 | frames | NEW: MAP gap-0 §6.2 (E ≤ T rebounds 3, 11), §4.6 step 4 |
| RULER_TUNING | bumpRetract | 11 | frames | NEW: MAP gap-0 §6.2 (E ≤ T rebounds 3, 11), §4.6 step 4 |

##### BREAK_TUNING (folder "Materials & joints › breaking")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| BREAK_TUNING | loadPointSplitM | 0.5 | m along the axis | NEW: §4.10 (3 pieces "when two load points are more than 0.5 m apart", RT-7) |
| BREAK_TUNING | pieceMinVolumeM3 | 0.000001 | m³ | NEW (SIM-fix3): a smaller piece (a sliver cut at an end) is merged into its nearest neighbour |
| BREAK_TUNING | loadBreakMinKg | 0.25 | kg | NEW (P28): a load break of anything lighter crumbles it to nothing (rule 10) instead of snapping it in two: leaves (1 J/kg) carry 1.02 × their own weight, so a heap of grass-bundle pieces in a pit load-broke itself into ever smaller pieces, ≈ 200 a tick |

##### WORLD_TUNING (folder "World")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| WORLD_TUNING | chestHeightM | 1.2 | m × scale | NEW: §5.0 chest point (pos + 1.2·scale up) for verb range and reach |
| WORLD_TUNING | supportReachM | 0.5 | m | NEW: §1.5.2 GroundQuery.supportAt (an entity top below fromY + 0.5 is support) |
| WORLD_TUNING | teleportProbeM | 50 | m above the terrain | NEW: where World.teleport starts its search for support |

##### CHARACTER_TUNING (folder "Bodies › controllers")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CHARACTER_TUNING | pushYieldSpeed | 0.02 | m/s | NEW: a 40 kg log jammed against a kerb reads −0.01 m/s after a push, a free one 0.15 m/s (P08 review) |
| CHARACTER_TUNING | postureRampFrames | 12 | frames for a full posture | NEW: core-fix (a posture never jumps the pose; head ≤ ~1.5 m/s) |
| CHARACTER_TUNING | lowPostureRootM | 0.7 | m (pose root height, unscaled) | NEW: P28 (crouch 0.6, workLow 0.6, guard 0.86: low to low cross-fades) |
| CHARACTER_TUNING | workHeadSpeedMps | 3 | m/s (world; the head, relative to the feet) | NEW: core-fix (a bend at ≤ 2-3 m/s, under v_safe with the step-in) |
| CHARACTER_TUNING | workRiseMargin | 1.25 | × the head's way to the guard | NEW: core-fix (the rise after a work action at ≤ workHeadSpeedMps) |
| CHARACTER_TUNING | maxHipDropM | 0.2 | m × scale | NEW: core-fix (rule 3 on slopes: a planted ankle on its plant) |
| CHARACTER_TUNING | hipDropSpeedMps | 1.5 | m/s (world) | NEW: core-fix (the hips never jump: the zones ride on them) |
| CHARACTER_TUNING | zoneShapes.headR | 0.11 | m × scale | DS (ragdoll.ts head ball) |
| CHARACTER_TUNING | zoneShapes.headUp | 0.15 | m × scale along the bone | DS (ragdoll.ts head ball) |
| CHARACTER_TUNING | zoneShapes.pelvis | [0.14,0.08,0.09,0.03] | m × scale [hx, hy, hz, up] | DS (ragdoll.ts pelvis box) |
| CHARACTER_TUNING | zoneShapes.abdomen | [0.13,0.1,0.09,0.1] | m × scale [hx, hy, hz, up] | DS (ragdoll.ts abdomen box) |
| CHARACTER_TUNING | zoneShapes.chest | [0.17,0.13,0.1,0.13] | m × scale [hx, hy, hz, up] | DS (ragdoll.ts chest box) |
| CHARACTER_TUNING | zoneShapes.limbInset | 0.5 | × bone radius | DS (ragdoll.ts limb capsules) |
| CHARACTER_TUNING | zoneShapes.minLimbHalf | 0.01 | m × scale | DS (ragdoll.ts limb capsules) |

##### VERB_TUNING (folder "Verbs")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| VERB_TUNING | dragDeadbeatFrac | 0.75 | × the load's deadbeat gains (m/DT², m/DT) | NEW: P28 (a light load's drag PD held under its one-tick limits) |
| VERB_TUNING | placeShrinkMaxFrac | 0.5 | of the smallest half-extent | NEW (SIM-fix3: a thin bearer never shrinks into a needle) |
| VERB_TUNING | tugHoldMinM | -0.4 | m × scale (from the hand; < 0: behind it) | NEW: P28 (a tug draws its grip set point in at creatureHandSpeedMps to this: past the hand while the load holds, so a light load on a taut lash still feels the whole capped pull through its mass-limited drag PD) |
| VERB_TUNING | heldJoinDepth | 3 | joints | NEW: §5.0 (a held object is the entity in the hands plus every entity lash-joined to it, depth ≤ 3) |
| VERB_TUNING | takeGrabFrac | 0.5 | × the take frames | NEW: the hands close half-way through a take (DS pickup's grabAt = frames × 0.5) |
| VERB_TUNING | takeHoldFrames | 3 | ticks | NEW: the low pose held as the hands close (DS pickup's grabAt + 3 key) |
| VERB_TUNING | carryFrontUpM | 1.05 | m × scale above the feet | NEW: where a carried load sits (§5.1 carryFront) |
| VERB_TUNING | carryFrontFwdM | 0.4 | m × scale ahead | NEW: where a carried load sits (§5.1 carryFront) |
| VERB_TUNING | carryShoulderUpM | 1.55 | m × scale above the feet | NEW: a long load on the shoulder (§5.1 carryShoulder) |
| VERB_TUNING | carryShoulderSideM | 0.2 | m × scale to the right | NEW: a long load on the shoulder (§5.1 carryShoulder) |
| VERB_TUNING | repeatStopInput | 0.1 | move input (0..1) | NEW: §5.4 "strokes until … the player moves" (DS: moving = input > 0.1) |
| VERB_TUNING | takeReachM | 0.85 | m × scale, horizontal from the feet | NEW: §5.0 Reach, rule 3: a take's hands close only this near the target (DS advancePickup's grab reach, 0.85 × scale) |
| VERB_TUNING | workStepM | 0.045 | m × scale per tick | DS (PICKUP_STEP, combat.ts:144): a work action's step-in (CombatSim faceWork), which plans a take's walk-in |

##### TOOL_TUNING (folder "Verbs › tools")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| TOOL_TUNING | stoneAxe.damageMul | 1.2 | × (DS WeaponDef) | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | stoneAxe.cut | 0.7 | DS WeaponDef | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | stoneAxe.cleave | 0.45 | DS WeaponDef | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | stoneAxe.bite | 10 | DS WeaponDef | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | stoneAxe.tempo | 1 | × (DS WeaponDef) | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | stoneAxe.choke | 0 | DS WeaponDef | NEW (machete analogue, SPEC:395) |
| TOOL_TUNING | longAxe.damageMul | 1.4 | × (DS WeaponDef) | NEW (fireaxe analogue) |
| TOOL_TUNING | longAxe.cut | 0.9 | DS WeaponDef | NEW (fireaxe analogue) |
| TOOL_TUNING | longAxe.cleave | 0.8 | DS WeaponDef | NEW (fireaxe analogue) |
| TOOL_TUNING | longAxe.bite | 14 | DS WeaponDef | NEW (fireaxe analogue) |
| TOOL_TUNING | longAxe.tempo | 1.1 | × (DS WeaponDef) | NEW (fireaxe analogue) |
| TOOL_TUNING | longAxe.choke | 0.4 | DS WeaponDef | NEW (fireaxe analogue) |
| TOOL_TUNING | spear.damageMul | 1.3 | × (DS WeaponDef) | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | spear.cut | 0.85 | DS WeaponDef | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | spear.cleave | 0 | DS WeaponDef | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | spear.bite | 8 | DS WeaponDef | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | spear.tempo | 1 | × (DS WeaponDef) | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | spear.choke | 0 | DS WeaponDef | NEW (gladius analogue, SPEC:394) |
| TOOL_TUNING | sharpStick.damageMul | 1 | × (DS WeaponDef) | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | sharpStick.cut | 0.4 | DS WeaponDef | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | sharpStick.cleave | 0 | DS WeaponDef | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | sharpStick.bite | 4 | DS WeaponDef | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | sharpStick.tempo | 0.9 | × (DS WeaponDef) | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | sharpStick.choke | 0.1 | DS WeaponDef | NEW (bokken analogue, SPEC:393) |
| TOOL_TUNING | stick.damageMul | 1 | × (DS WeaponDef) | NEW (bokken) |
| TOOL_TUNING | stick.cut | 0 | DS WeaponDef | NEW (bokken) |
| TOOL_TUNING | stick.cleave | 0 | DS WeaponDef | NEW (bokken) |
| TOOL_TUNING | stick.bite | 0 | DS WeaponDef | NEW (bokken) |
| TOOL_TUNING | stick.tempo | 0.9 | × (DS WeaponDef) | NEW (bokken) |
| TOOL_TUNING | stick.choke | 0 | DS WeaponDef | NEW (bokken) |
| TOOL_TUNING | cudgel.damageMul | 1.45 | × (DS WeaponDef) | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | cudgel.cut | 0 | DS WeaponDef | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | cudgel.cleave | 0 | DS WeaponDef | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | cudgel.bite | 0 | DS WeaponDef | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | cudgel.tempo | 1 | × (DS WeaponDef) | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | cudgel.choke | 0.12 | DS WeaponDef | NEW (bat analogue, SPEC:396) |
| TOOL_TUNING | stone.damageMul | 1.1 | × (DS WeaponDef) | NEW (SPEC:397) |
| TOOL_TUNING | stone.cut | 0 | DS WeaponDef | NEW (SPEC:397) |
| TOOL_TUNING | stone.cleave | 0 | DS WeaponDef | NEW (SPEC:397) |
| TOOL_TUNING | stone.bite | 0 | DS WeaponDef | NEW (SPEC:397) |
| TOOL_TUNING | stone.tempo | 0.85 | × (DS WeaponDef) | NEW (SPEC:397) |
| TOOL_TUNING | stone.choke | 0 | DS WeaponDef | NEW (SPEC:397) |
| TOOL_TUNING | flintBlade.damageMul | 1.2 | × (DS WeaponDef) | NEW (kunai analogue) |
| TOOL_TUNING | flintBlade.cut | 0.8 | DS WeaponDef | NEW (kunai analogue) |
| TOOL_TUNING | flintBlade.cleave | 0 | DS WeaponDef | NEW (kunai analogue) |
| TOOL_TUNING | flintBlade.bite | 4 | DS WeaponDef | NEW (kunai analogue) |
| TOOL_TUNING | flintBlade.tempo | 0.8 | × (DS WeaponDef) | NEW (kunai analogue) |
| TOOL_TUNING | flintBlade.choke | 0 | DS WeaponDef | NEW (kunai analogue) |
| TOOL_TUNING | refSharpness.stoneAxe | 0.9 | sharpness | NEW: the sharpness a class's DS template stands for (RR-13) |
| TOOL_TUNING | refSharpness.longAxe | 0.9 | sharpness | NEW: the sharpness a class's DS template stands for (RR-13) |
| TOOL_TUNING | refSharpness.flintBlade | 0.9 | sharpness | NEW: the sharpness a class's DS template stands for (RR-13) |
| TOOL_TUNING | refSharpness.spear | 0.6 | sharpness | NEW: the sharpness a class's DS template stands for (RR-13) |
| TOOL_TUNING | refSharpness.sharpStick | 0.6 | sharpness | NEW: the sharpness a class's DS template stands for (RR-13) |
| TOOL_TUNING | pointAxisCos | 0.7 | cos | NEW: §5.0 ("a point at an end: \|dir·axis\| ≥ 0.7") |
| TOOL_TUNING | edgeAxisCos | 0.5 | cos | NEW: §5.0 ("an edge: \|dir·axis\| < 0.5") |

##### FACTORY_TUNING (folder "World › factory")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| FACTORY_TUNING | materials.tree | 'greenWood' | material | NEW: §6.7 (trees: green wood) |
| FACTORY_TUNING | materials.sapling | 'greenWood' | material | NEW: §6.7 (saplings: green wood) |
| FACTORY_TUNING | materials.stick | 'dryWood' | material | NEW: §6.7 (dry branches, stakes) |
| FACTORY_TUNING | materials.log | 'dryWood' | material | NEW: §6.7 (dry logs) |
| FACTORY_TUNING | materials.stone | 'stone' | material | NEW: §6.7 (stones and boulders) |
| FACTORY_TUNING | materials.grass | 'leaves' | material | NEW: §6.7 (grass bundles: leaves and dry grass) |
| FACTORY_TUNING | ropeRadiusM | 0.01 | m | NEW: §6.7 ("vine rope (r 0.01 m)"; a 20 m vine coil is 3.77 kg, §5.1) |
| FACTORY_TUNING | coilAspect | 0.25 | half-height ÷ radius | NEW: a coil lies as a flat disc (a 20 m vine: 33 cm across, 8 cm thick) |
| FACTORY_TUNING | grassThicknessM | 0.08 | m | NEW: §6.7 ("1-3 kg flat boxes") |
| FACTORY_TUNING | grassAspect | 1.5 | length ÷ width | NEW: §6.7 ("1-3 kg flat boxes") |
| FACTORY_TUNING | snagElevationDeg | 45 | ° | NEW: §6.7 (broken-branch points "up and out at 45°") |
| FACTORY_TUNING | stoneProtos | [[0.5,0.5,0.3,-0.3,0.5,0.45,-0.55,0.5,-0.2,0.2,0.5,-0.4,1,0,0,0.6,0.1,0.65,-0.2,-0.05,0.75,0.65,-0.1,-0.55],[0.75,0.32,0.25,0.05,0.32,0.55,-0.7,0.32,0.15,-0.1,0.32,-0.45,1.1,0,0,0.5,0.05,-0.65,-0.35,-0.05,0.72,0.8,0.1,0.45],[0.4,0.62,0.3,-0.45,0.62,0.35,0.05,0.62,-0.5,0.95,0,0,0.35,-0.1,0.8,-0.55,0.12,0.7,0.6,0.15,-0.65],[0.7,0.45,0.05,0,0.45,0.5,-0.45,0.45,-0.25,1.2,0,0,0.4,0.05,0.7,-0.3,0.12,0.62,0.55,-0.1,-0.6]] | local xyz triples (half of a symmetric hull; scaled to the mass) | NEW: §6.7 ("hulls from 4 prototypes, scaled"), D-22 |
| FACTORY_TUNING | starterAxe.handleLengthM | 0.55 | m | NEW: §6.7 starter cache (green stick 0.55 m × 4 cm) |
| FACTORY_TUNING | starterAxe.handleRoundDiamM | 0.04 | m (diameter of a round stick of the same cross-section) | NEW: §6.7 (× 4 cm); the B lab's 1.15 kg axe, on which FELL_TUNING.refChopJ (339 J) was measured [B lab: tools.ts] |
| FACTORY_TUNING | starterAxe.handleMaterial | 'greenWood' | material | NEW: §6.7 (a green stick) |
| FACTORY_TUNING | starterAxe.headKg | 0.6 | kg | NEW: §6.7 (a 0.6 kg flint) |
| FACTORY_TUNING | starterAxe.headMaterial | 'flint' | material | NEW: §6.7 (flint) |
| FACTORY_TUNING | starterAxe.headProto | 0 | stone prototype | NEW |
| FACTORY_TUNING | starterAxe.edgeSharpness | 0.9 | sharpness | NEW: §6.7 (a 0.9 edge), §5.2 (TOOL_TUNING.refSharpness) |
| FACTORY_TUNING | starterAxe.lashMaterial | 'vine' | material | NEW: §6.7 (lashed across; a lashing uses VERB_TUNING.lashRopeUseM of rope) |

##### CLEARING_TUNING (folder "World › Clearing")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CLEARING_TUNING | routeRadiusJitterM | 8 | m | NEW (55 ± 8) |
| CLEARING_TUNING | rimRadiusJitterM | 5 | m | NEW (82 ± 5) |
| CLEARING_TUNING | floorWeights | [0.65,0.35] | × floorAmpM per octave (floorScalesM order) | NEW: §6.7 floor = 1.5 m · (0.65 · n(x/48) + 0.35 · n(x/16)) |
| CLEARING_TUNING | rimNormPower | 4 | p of e = (\|x\|^p + \|z\|^p)^(1/p) | NEW: §6.7 rim, e = (\|x\|⁴ + \|z\|⁴)^¼ |
| CLEARING_TUNING | rimNoiseCells | 8 | noise cells around the valley | NEW (P21): §6.7's n(θ) for R(θ) = 82 + 5 · n(θ) |
| CLEARING_TUNING | ledgeNormal | [1,-1] | (x, z), toward the low side | NEW: §6.7 ledge normal (1, −1)/√2 |
| CLEARING_TUNING | ledgeKeepOutM | 2 | m | NEW (P21): how far trees, waypoints and fixed things keep from the ledge and its hollow |
| CLEARING_TUNING | ledgeRouteBehindM | 6 | m | NEW: §6.7 (one route waypoint 6 m behind the ledge's high side) |
| CLEARING_TUNING | lairBearingJitterDeg | 10 | ° from north | NEW (P21): §6.7 (the lair at the north rim foot) |
| CLEARING_TUNING | lairClearM | 10 | m | NEW (P21): §6.7 (the lair is open ground) |
| CLEARING_TUNING | routeRimMarginM | 10 | m inside the rim foot | NEW (P21): route waypoints stay on the valley floor |
| CLEARING_TUNING | routeSampleM | 1 | m | NEW (P21): the step at which a leg's slope (≤ maxSlopeDeg) is checked |
| CLEARING_TUNING | corridorLegs | 2 | count | NEW: §6.7 (two legs between grove pairs) |
| CLEARING_TUNING | corridorWidthM | [12,16] | m [min, max] | NEW: §6.7 (corridors 12-16 m wide) |
| CLEARING_TUNING | groveEdgeFrac | 0.5 | × the grove's radius | NEW (P21): a grove-edge tree is at least this far from its grove's centre |
| CLEARING_TUNING | groveEdgeGapM | [1,3] | m outside the grove's ring [min, max] | NEW (P21): where things "at grove edges" lie |
| CLEARING_TUNING | vineHangGapM | 0.3 | m | NEW: §6.7 (length = anchor − 0.3 m + slack) |
| CLEARING_TUNING | vineYawSteps | 16 | directions | NEW (P21): the directions tried for a vine's open side |
| CLEARING_TUNING | coilNearSpawnLengthsM | [12,18] | m | NEW: §6.7 (the 12 m and 18 m coils near the spawn) |
| CLEARING_TUNING | coilNearSpawnM | 20 | m | NEW: §6.7 (within 20 m of the spawn) |
| CLEARING_TUNING | nearSpawnMinM | 3 | m | NEW (P21): loose things keep this far from the spawn point |
| CLEARING_TUNING | cacheClearM | 1.5 | m | NEW (P21): generated things keep this far from the starter cache |
| CLEARING_TUNING | trunkClearM | 0.3 | m | NEW (P21): loose things keep this far from a trunk |
| CLEARING_TUNING | looseGapM | 0.05 | m | NEW (P21): the gap between loose things set down (none starts touching another) |
| CLEARING_TUNING | saplingRingGapM | [3,8] | m outside the grove's ring [min, max] | NEW: §6.7 (saplings 3-8 m outside grove rings) |
| CLEARING_TUNING | saplingNearSpawnM | 25 | m | NEW: §6.7 (4 within 25 m of the spawn) |
| CLEARING_TUNING | saplingGapM | 1.5 | m | NEW (P21): between a sapling and any trunk |
| CLEARING_TUNING | outcropDistM | [20,70] | m from the spawn [min, max] | NEW (P21) |
| CLEARING_TUNING | stonesNearSpawn | 5 | count | NEW: §6.7 (5 throwing stones within 15 m of the spawn) |
| CLEARING_TUNING | stoneNearSpawnM | 15 | m | NEW: §6.7 (5 throwing stones within 15 m of the spawn) |
| CLEARING_TUNING | flintNearSpawnM | 12 | m | NEW: §6.7 (2 within 12 m of the spawn) |
| CLEARING_TUNING | boulderNearSpawnM | 20 | m | NEW: §6.7 (one 20 m from the spawn) |
| CLEARING_TUNING | boulderLegOffsetM | [8,16] | m outside a route leg [min, max] | NEW (P21): §6.7 (two on the slope above a route leg) |
| CLEARING_TUNING | boulderAboveLegM | 1 | m above the leg | NEW (P21): §6.7 (two on the slope above a route leg) |
| CLEARING_TUNING | branchNearSpawnM | 25 | m | NEW: §6.7 (8 within 25 m of the spawn) |
| CLEARING_TUNING | blankLenM | [1.4,1.6] | m [min, max] | NEW: §6.7 (digging-stick blanks 1.4-1.6 m × 5 cm) |
| CLEARING_TUNING | blankDiamM | 0.05 | m | NEW: §6.7 (digging-stick blanks 1.4-1.6 m × 5 cm) |
| CLEARING_TUNING | logNearSpawnKg | [110,130] | kg [min, max] | NEW: §6.7 (one 110-130 kg within 30 m of the spawn) |
| CLEARING_TUNING | logNearSpawnM | 30 | m | NEW: §6.7 (one 110-130 kg within 30 m of the spawn) |
| CLEARING_TUNING | routeLogKg | 300 | kg | NEW: §6.7 (one ≈ 300 kg beside a route leg) |
| CLEARING_TUNING | routeLogOffsetM | 4 | m from the leg | NEW (P21): §6.7 (beside a route leg) |
| CLEARING_TUNING | grassMinCover | 0.6 | cover | NEW: §6.7 (grass in meadows, cover ≥ 0.6) |
| CLEARING_TUNING | coverSpawnR | 15 | m | NEW (P21): §6.7 (cover 0.4 around the spawn) |
| CLEARING_TUNING | homeEdgeGapM | 3 | m outside the grove's ring | NEW (P21): §6.7 (homes at grove edges facing open ground) |
| CLEARING_TUNING | apeHomeMinSepDeg | 100 | ° | NEW: §6.7 (bearings ≥ 100° apart) |
| CLEARING_TUNING | homeLoopRimMarginM | 5 | m inside the rim foot | NEW (P21): a home loop's waypoints stay on the valley floor |
| CLEARING_TUNING | homeClearM | 1.5 | m | NEW (P21): a home and its loop's waypoints keep this far from trunks and other things |
| CLEARING_TUNING | snagHomeDistM | [5,8] | m from the home [min, max] | NEW (P21): §6.7 (a snag at the edge of each ape home) |
| CLEARING_TUNING | snagLenM | [2.5,3.5] | m [min, max] | NEW (P21) |
| CLEARING_TUNING | snagLedgeOffsetM | 1.5 | m beyond the ledge's transition | NEW (P21): §6.7 (one at the foot of the ledge) |
| CLEARING_TUNING | snagLedgeSpreadM | 10 | m along the ledge (±) | NEW (P21): §6.7 (one at the foot of the ledge) |
| CLEARING_TUNING | diggingStick.lengthM | 1.5 | m | NEW: §6.7 starter cache (a digging stick, dry, 1.5 m × 5 cm, point 0.5) |
| CLEARING_TUNING | diggingStick.diamM | 0.05 | m (diameter of a round stick of the same cross-section) | NEW: §6.7 starter cache (1.5 m × 5 cm) |
| CLEARING_TUNING | diggingStick.sharpness | 0.5 | sharpness | NEW: §6.7 starter cache (point 0.5) |
| CLEARING_TUNING | starterStickOffset | [0,0.5] | m (x, z) from starterCacheAt | NEW (P21) |
| CLEARING_TUNING | starterCoilOffset | [1.1,0.25] | m (x, z) from starterCacheAt | NEW (P21) |
| CLEARING_TUNING | starterCoilM | 8 | m | NEW: §6.7 starter cache (an 8 m vine coil) |
| CLEARING_TUNING | boundaryWallThickM | 1 | m | NEW (P21): §6.7 (four fixed boxes behind the rim top) |
| CLEARING_TUNING | boundaryWallAboveM | 60 | m above the terrain's edge | NEW (P21): §6.7 (they catch anything flung over the rim; fixed boxes cost nothing, so high enough for a high arc) |
| CLEARING_TUNING | boundaryWallBelowM | 2 | m below the terrain's edge | NEW (P21) |
| CLEARING_TUNING | corridorLegSpan | [0.25,0.75] | fraction of the leg [from, to] | NEW (P21): where on its leg a corridor grove is centred (away from the waypoints, so the corridor is along one leg) |
| CLEARING_TUNING | corridorAlongFrac | 0.5 | × the grove's radius (±) | NEW (P21): how far along the leg from a split grove's centre its gate and corridor-lining trunks stand |
| CLEARING_TUNING | groveCentreMarginFrac | 0.5 | × the grove's radius | NEW (P21): a disk grove's centre keeps this far inside the rim's foot and off the ledge's hollow |
| CLEARING_TUNING | boulderLegSpan | [0.2,0.8] | fraction of the leg [from, to] | NEW (P21): where along the leg the two boulders above it lie |
| CLEARING_TUNING | routeLogLegSpan | [0.3,0.7] | fraction of the leg [from, to] | NEW (P21): where along its leg the ≈ 300 kg log lies |
| CLEARING_TUNING | outcropEdgeMarginM | 1 | m beyond the outcrop radius | NEW (P21): an outcrop keeps this far from the terrain's edge, trunks and rooted things |
| CLEARING_TUNING | outcropRimMarginM | 2 | m beyond the outcrop radius | NEW (P21): an outcrop's centre keeps this far inside the rim's foot |
| CLEARING_TUNING | outcropSpacingRadii | 3 | × outcropR | NEW (P21): outcrop centres at least this far apart |
| CLEARING_TUNING | looseEdgeMarginM | 0.5 | m beyond the thing's reach | NEW (P21): a loose or rooted thing keeps this far from the terrain's edge |
| CLEARING_TUNING | looseRimMarginM | 1 | m beyond the thing's reach | NEW (P21): a loose thing (or a vine's lying end) keeps this far inside the rim's foot |
| CLEARING_TUNING | snagHollowDepthFrac | 0.5 | × ledgeDropM | NEW (P21): the ledge's snag lies where the hollow is at least this deep (at the cliff's foot) |
| CLEARING_TUNING | tiltSampleM | [0.25,2.5] | m [min, max] | NEW (P21): the half-span over which a lying prism's ground slope is sampled (its half-length, clamped) |
| CLEARING_TUNING | homeLoopProbes | 12 | start angles | NEW (P21): how many evenly spaced start angles test whether a home's loop fits on the valley floor |
| CLEARING_TUNING | apeHomeDistJitterM | 4 | m (±) | NEW (P21): §6.7 (B ≈ 62 m; C ≈ 78 m): how far B and C may lie from that distance where it leaves no room for a loop |

##### RULER_BODY_TUNING (folder "Ruler › body")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RULER_BODY_TUNING | supportMinShare | 0.1 | × the foot's load | NEW: P28 (lost-support trip rule: a support carried at least this share of a foot's load; the WardedMMO session's ~10%) |
| RULER_BODY_TUNING | groundMaxSpeedMps | 0.25 | m/s (\|v\| + \|ω\| × reach) | NEW: P28 (a steady entity is a ruler's ground, not only one at rest) |
| RULER_BODY_TUNING | supportDisplaceM | 0.25 | m | NEW: P28 (lost-support trip rule: a support moved this far from where it held the ruler up is displaced) |
| RULER_BODY_TUNING | climbLookM | 3 | m | NEW: §4.7 step 3 ("a support no more than climbMaxM above the pit floor within 3 m ahead") |
| RULER_BODY_TUNING | pitOutDepthFrac | 0.15 | × knee height (0.41 m) | NEW: "down until it has climbed out" (SPEC:504, RR-1): once in a pit, the ruler is out only when it stands within this of the original ground on ground no steeper than maxSlopeDeg (the rim, not the pit wall it is climbing) |
| RULER_BODY_TUNING | deflectAxisMinXZ | 0.5 | horizontal share of the axis | NEW: §4.7 step 6.1: an obstacle whose long axis is steeper than this (an upright trunk or stake) is round, deflecting along the tangent ⟂ n̂ |
| RULER_BODY_TUNING | getupShoveMps | 2 | m/s | NEW: §4.7 get-up: light bodies resting on the ruler are shoved off at this speed before its colliders turn to sensors (MAP gap-3 §3.5) |
| RULER_BODY_TUNING | coverHoldTicks | 30 | ticks | NEW: P28 (a support woken by the ruler's own step keeps holding it this long, until it breaks) |
| RULER_BODY_TUNING | soleProbeHalfM | 0.02 | m | NEW: P28 (the sole cast as a flat box this half-thick) |
| RULER_BODY_TUNING | footProbeFrac | 0.8 | × footRadiusM × scale | NEW: P28 (the sole cast: its half-side inside the D-39 load footprint) |
| RULER_BODY_TUNING | slideGrazeDeg | 2 | ° | NEW: §4.7 step 6.1's slide: a blocker whose surface the slide moves into by no more than this is grazed, not met (the capsule ends a deflection touching the face; Rapier's grazing hits on it came 0.6° off the face and stalled a 25° slide mid-wall) |
| RULER_BODY_TUNING | riseBlendFrames | 40 | frames | NEW: the blend from the rise's last key into the ruler's own stance (DS's 4-frame fade swings a 5.5× arm at 88 m/s, over AC-5's 30 m/s; with 40 frames the blend peaks at 8.3 m/s, and the fastest part of the whole rise is 12.6 m/s, through the kneel; measured on AC-5's fixture log) |

##### CREATURE_TUNING (folder "Creatures › minds")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CREATURE_TUNING | ape.planRange | 1 | m × scale (1.1) | SPEC:873 (Bruiser range 1.0 × 1.1) |
| CREATURE_TUNING | ape.planAttackRange | 1.25 | m × scale (1.1) | SPEC:873 (Bruiser attackRange 1.25 × 1.1) |
| CREATURE_TUNING | ape.gait.wander | 0.35 | moveInput | NEW |
| CREATURE_TUNING | ape.investigateArriveM | 1.5 | m | NEW: §6.3 investigate "on arrival (≤ 1.5 m)"; also home and the loop waypoints |
| CREATURE_TUNING | ape.fleeAwarenessMul | 0.5 | × | NEW: §6.3 flee → return "awareness halved" |
| CREATURE_TUNING | giant.brake | 4 | m/s² | NEW |
| CREATURE_TUNING | giant.climbStuckFrac | 0.5 | × the way its slower climb rate covers in stuckTicks | NEW (P20 review): a climb out of a pit that moves less than this in stuckTicks is blocked (0.4 m of a normal 0.8 m), and goes for another rim |

##### NOISE_TUNING (folder "Creatures › senses")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| NOISE_TUNING | runMinSpeed | 2.9 | m/s × √scale | NEW (P18): the middle of footwork's walk-to-run blend (2.2-3.6 m/s, footwork.ts) |
| NOISE_TUNING | sprintMinSpeed | 4.5 | m/s × √scale | NEW (P18): between the 3.77 m/s run and the 5.28 m/s sprint (§5.5) |

##### JOINT_TUNING (folder "Materials & joints › ropes")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| JOINT_TUNING | bendHoldRopeM | 0.3 | m | NEW: §5.9 ("held by a 0.3 m rope joint from its top to the anchor") |
| JOINT_TUNING | bendSettleDeg | 5 | ° | NEW: a released sapling that comes to rest within this of upright is rooted again (standing, fixed), so it can be bent again |
| JOINT_TUNING | tieStillMps | 0.05 | m/s along the rope | NEW: a held end tied off while its load still runs along the rope faster than this cinches when the load stops (the haul keeps acting through the hitch); a rigid rope made around a moving load catches it in one step (P10 review: a 30 kg log at 2 m/s snapped its vine tie) |
| JOINT_TUNING | nnlsIterPerGroup | 3 | iterations per strand group | §4.9 (Lawson-Hanson, at most 3·n + 10 iterations) |
| JOINT_TUNING | nnlsIterBase | 10 | iterations | §4.9 (Lawson-Hanson, at most 3·n + 10 iterations) |
| JOINT_TUNING | tripwireEndSpeedMul | 1 | × the crosser's speed across the rope | NEW: orchestrator decision (P10's tripwire risk): each end's share of the crossing momentum is at most m_end × \|v·n̂\| × this, so no end leaves faster than the crosser crosses (§4.9's uncapped half of p sent a 2.3 kg stake off at ≈ 85 m/s) |

##### TERRAIN_TUNING (folder "World › terrain")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| TERRAIN_TUNING | spoilReposeDeg | 34 | ° | NEW (SIM-fix4, P29): loose dirt's angle of repose (≈ 30-35°, rule 3): no terrain triangle of spoil is steeper. Keep it below RULER_BODY_TUNING.maxSlopeDeg (40°), or a berm fences a ruler out of its pit (so the panel caps it at 39°) |
| TERRAIN_TUNING | spoilSlideM | 4 | m | NEW (SIM-fix4): how far (grid steps × spacing, along x plus along z) a raise's dirt may slide from its spoil point down the slopes it settles on |

##### DEV_OPS_TUNING (folder "World › dev ops")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| DEV_OPS_TUNING | spear.lengthM | 1.9 | m | NEW: §5.2's measured spear (1.9 m; a point at an end and ≥ 1.6 m is a spear) |
| DEV_OPS_TUNING | spear.roundDiamM | 0.05 | m | NEW: the digging stick's 5 cm (§6.7), as the 8-gon of that round section |
| DEV_OPS_TUNING | spear.sharpness | 0.6 | — | NEW: a wood point (TOOL_TUNING.refSharpness of the point classes, §5.2) |
| DEV_OPS_TUNING | vineM | 12 | m | §10.10 ("give a tool (stone axe, digging stick, spear, 12 m vine)") |

##### DOWNED_TUNING (folder "Bodies › downed")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| DOWNED_TUNING | standCastUp | 2.5 | m × scale above the hip | NEW: MAP gap-4 §6 (lab2.mjs standSpot) |
| DOWNED_TUNING | standCastLength | 6 | m × scale | NEW: MAP gap-4 §6 (lab2.mjs standSpot) |

##### ENTITY_TUNING (folder "Physics › entities")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| ENTITY_TUNING | touchedMoveM | 0.01 | m | NEW: §2.3, §8.3 (a generated entity moved > 1 cm is touched and saved) |
| ENTITY_TUNING | touchedTurnDeg | 1 | ° | NEW: §2.3, §8.3 (a generated entity turned > 1° is touched and saved) |
| ENTITY_TUNING | anchorJoinDepth | 3 | joints | NEW: §2.3 (lash/hinge-joined to an anchored entity, depth ≤ 3) |

##### NAV_TUNING (folder "Navigation")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| NAV_TUNING | human.goalTolM | 0.6 | m | NEW (P12): a path is complete when it ends this close to the goal: the ape's arriveM (§6.5) |
| NAV_TUNING | ruler.goalTolM | 2.5 | m | NEW (P12): a path is complete when it ends this close to the goal: the giant's arriveM (§6.5) |
| NAV_TUNING | maxEdgeLenM | 12 | m | NEW (P12): the MAP recast lab's 12 m (world.mjs recastConfigFor: 12 / cs voxels); read when the navmesh is built |
| NAV_TUNING | maxPathPolys | 1024 | polygons | NEW (P12): a path corridor across the 200 m Clearing on 6.4 m tiles |
| NAV_TUNING | maxStraightPoints | 256 | points | NEW (P12): recast's default (MAP recast §7) |
| NAV_TUNING | walkReachM | 0.3 | m | NEW: §4.1 (a walk bit is set when a polygon lies within this of the cell centre); a walk bitmap takes it when its tile is rebuilt |
| NAV_TUNING | boundsBelowM | 1 | m below the dig floor | NEW (P12): the navmesh's vertical bounds (read at build) |
| NAV_TUNING | boundsAboveM | 40 | m above the highest generated ground | NEW (P12): the navmesh's vertical bounds (read at build) |

##### STRIKE_TUNING (folder "Verbs › strike")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| STRIKE_TUNING | stickRetract | 12 | ticks | §5.2 strike table (a chop, cut or dig sticks: `stick`, w.bite, 12) |
| STRIKE_TUNING | reboundHold | 2 | ticks | §5.2 strike table (a push or clang rebounds: `rebound`, 2, 10; DS's clang) |
| STRIKE_TUNING | reboundRetract | 10 | ticks | §5.2 strike table (a push or clang rebounds: `rebound`, 2, 10; DS's clang) |
| STRIKE_TUNING | unarmedLimbBones | 2 | bones of the striking limb, from its end | NEW (P15 review, orchestrator decision; departs from §5.2's "strikeMassKg 6" for unarmed blows): the striker mass of an unarmed push is the striking limb's (boneMass): 2 = shin + thigh for a kick (13.5 kg at scale 1: J ≈ 41 N·s at 108 J, §5.2's 40 N·s), forearm + upper arm for a punch; 1 = the shin or the forearm alone |
| STRIKE_TUNING | aimTurnTolDeg | 3 | ° | NEW (P15 review): the radial's Cut and Dig turn at VERB_TUNING.faceTurnRate (§5.0) until the turn left is under this, then swing |

##### DIG_TUNING (folder "Verbs › dig")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| DIG_TUNING | pileHeightRatio | 0.5 | height ÷ base half-width | NEW: §4.13 "a low 8-point hull of the volume": a square frustum whose sides lie at ≈ 35°, loose dirt's angle of repose |
| DIG_TUNING | pileTopRatio | 0.3 | top half-width ÷ base half-width | NEW: §4.13 "a low 8-point hull of the volume" (a square frustum) |
| DIG_TUNING | handDigActFrac | 0.5 | × handDigFrames | NEW: §5.10 (the scoop lands at this fraction of the work action) |

##### PLACE_TUNING (folder "Verbs › place")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| PLACE_TUNING | supportProbeUpM | 0.5 | m | NEW: §5.7 step 2 ("a downward ray from 0.5 m above the lower end"); the place casts start this high too, or as high as the room over the commanded pose allows |
| PLACE_TUNING | actFrac | 0.75 | × the work action | NEW: §5.7 step 5 (the object is set down at the end of the push down, then the body rises) |

##### ROPE_TUNING (folder "Verbs › rope and shape")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| ROPE_TUNING | knotAllowanceM | 0.5 | m | NEW: §5.8 (a rope takes "distance + 0.5 m" off the coil: the rope its knots use) |
| ROPE_TUNING | coilMinM | 0.5 | m | NEW: §5.8 ("< 0.5 m left: used up": a coil with less left goes into the piece whole) |
| ROPE_TUNING | squatChestM | 0.6 | m × scale above the feet | NEW: §5.0 Reach: the chest point of a player working low (a deep squat, pose workLow), so a ground anchor 1.2 m out is in reach |
| ROPE_TUNING | shapeDoneMargin | 0.01 | sharpness | NEW: §5.0 shape precondition ("target maxSharpness > current + 0.01"): an end this near its material's max is done |
| ROPE_TUNING | workPoseFrac | 0.5 | × the work action | NEW: the rope and shape verbs' work actions are in their pose (workLow, workKnap, haulRope) by this fraction of their frames (as P14's takeGrabFrac) |
| ROPE_TUNING | snapEndMinY | -0.5 | y of the end’s outward axis (−1 straight down) | NEW: P16 review: lash's snap assist never moves a head onto an end pointing further down than this (a standing prop's foot) |

##### PANEL_TUNING (folder "Client › dev panel")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| PANEL_TUNING | refreshS | 0.25 | s | DS (panel.ts: refreshed every 250 ms) |
| PANEL_TUNING | impactsShown | 10 | impacts | §10.10 (the last 10 impacts, RT-24) |
| PANEL_TUNING | tripwiresShown | 6 | events | NEW: P37 (§10.10 tripwire events) |
| PANEL_TUNING | nearEntityM | 3 | m | NEW: P37 (the entity read out: the nearest this close to the focused point, or to the player) |
| PANEL_TUNING | spawnApeAheadM | 6 | m | NEW: P37 ("spawn an ape near": this far in front of the player) |
| PANEL_TUNING | teleportGiantOffsetM | 8 | m | NEW: P37 ("teleport to the giant": this far off it along x and z) |

##### RENDER_TUNING (folder "Client › render")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| RENDER_TUNING | terrain.distantTileM | 70 | m | NEW: P32 (a third level beyond §10.4's two: tiles this far from the camera, past fogNear, are drawn coarser) |
| RENDER_TUNING | terrain.distantSpacing | 1 | m | NEW: P32 (the distant level's vertex spacing) |
| RENDER_TUNING | terrain.grass | '#5d7a3a' | colour | NEW: P32 (grass green, §10.4) |
| RENDER_TUNING | terrain.grassDry | '#a8a066' | colour | NEW: P32 (dense dry grass is pale, §10.4, rule 3) |
| RENDER_TUNING | terrain.dirt | '#6b4a2d' | colour | NEW: P32 (dug or heaped ground, §10.4) |
| RENDER_TUNING | terrain.rock | '#7f7b72' | colour | NEW: P32 (ground too steep to climb, §10.4) |
| RENDER_TUNING | terrain.dryCoverFrom | 0.6 | cover 0-1 | NEW: §10.4 ("pale where cover ≥ 0.6") |
| RENDER_TUNING | terrain.dugM | 0.05 | m | NEW: §10.4 ("dirt brown where dug, h < original − 0.05") |
| RENDER_TUNING | terrain.rockSlopeDeg | 35 | ° | NEW: §10.4 ("grey rock above 35°") |
| RENDER_TUNING | terrain.variation | 0.06 | ± brightness | NEW: P32 (per-vertex shade so flat ground reads as ground) |
| RENDER_TUNING | terrain.rockVariation | 0.08 | ± brightness | NEW: C-fix (rock's per-vertex shade, a little above the grass's: the facets differ without speckle, rule 3) |
| RENDER_TUNING | terrain.skirtM | 0.6 | m | NEW: P32 (tile-edge skirts hide the cracks between levels of detail) |
| RENDER_TUNING | sky.sky | '#a9c6d6' | colour | NEW: P32 (background and fog) |
| RENDER_TUNING | sky.hemiSky | '#d9e8f2' | colour | NEW: P32 (hemisphere light from above) |
| RENDER_TUNING | sky.hemiGround | '#4f5a34' | colour | NEW: P32 (hemisphere light from below) |
| RENDER_TUNING | sky.hemiIntensity | 1.05 | × | NEW: P32 |
| RENDER_TUNING | sky.sun | '#ffe6c2' | colour | NEW: P32 (a warm sun, SPEC:840) |
| RENDER_TUNING | sky.sunIntensity | 2.3 | × | NEW: P32 |
| RENDER_TUNING | sky.sunAzimuthDeg | 215 | ° | NEW: P32 (where the sun stands, from +z toward +x) |
| RENDER_TUNING | sky.sunElevationDeg | 48 | ° | NEW: P32 (an afternoon sun: long-ish shadows, SPEC:840) |
| RENDER_TUNING | sky.fill | '#c4d2e0' | colour | NEW: C-fix (a cool sky-bounce light opposite the sun on the terrain's steep faces: the rim reads as lit faceted rock, not black) |
| RENDER_TUNING | sky.fillIntensity | 3 | × | NEW: C-fix (terrain only, × steepness: trees, bodies and flat ground keep P32's light; no shadow; 0 turns it off) |
| RENDER_TUNING | sky.fillAzimuthDeg | 35 | ° | NEW: C-fix (where the fill comes from, from +z toward +x: opposite the sun) |
| RENDER_TUNING | sky.fillElevationDeg | 22 | ° | NEW: C-fix (low, so the faces of cliffs turned from the sun catch it) |
| RENDER_TUNING | sky.shadowBias | -0.0004 | depth | NEW: P32 (DS −0.0005) |
| RENDER_TUNING | sky.shadowNormalBias | 0.03 | m | NEW: P32 (DS 0.02) |
| RENDER_TUNING | forest.bark | '#5a4530' | colour | NEW: P32 (trunks) |
| RENDER_TUNING | forest.canopy | '#4c7433' | colour | NEW: P32 (crowns) |
| RENDER_TUNING | forest.saplingStem | '#6f6a3a' | colour | NEW: P32 |
| RENDER_TUNING | forest.saplingLeaves | '#6a9a3e' | colour | NEW: P32 |
| RENDER_TUNING | forest.cutWood | '#e2c995' | colour | NEW: P32 (fresh-cut wood in a notch or on a stump: rule 3) |
| RENDER_TUNING | forest.crownRadiusPerH | 0.24 | m per m of height | NEW: P32 (a standing crown, no collider: TODO "canopy collision (rule 3)") |
| RENDER_TUNING | forest.crownMinM | 1.6 | m | NEW: P32 |
| RENDER_TUNING | forest.crownSinkFrac | 0.2 | × crown radius | NEW: P32 (how far the crown sits down over the trunk top) |
| RENDER_TUNING | forest.saplingCrownPerH | 0.22 | m per m of height | NEW: P32 |
| RENDER_TUNING | forest.notchOpenPerDepth | 0.6 | half-opening ÷ depth | NEW: P32 (the notch is a V about as open as it is deep) |
| RENDER_TUNING | forest.notchMinHalfOpenM | 0.03 | m | NEW: P32 |
| RENDER_TUNING | forest.notchSegments | 4 | rows per notch face | NEW: P32 |
| RENDER_TUNING | forest.creakDeg | 0.15 | ° | NEW: SPEC:581 (a tree cut below creakBelowRemaining trembles: it creaks before it goes) |
| RENDER_TUNING | forest.creakHz | 7 | Hz | NEW: SPEC:581 |
| RENDER_TUNING | forest.leavesPerChop | 10 | leaves | NEW: §10.4 ("sheds leaf particles") |
| RENDER_TUNING | forest.leafFallMps | 1.1 | m/s | NEW: P32 |
| RENDER_TUNING | forest.leafDriftMps | 0.6 | m/s | NEW: P32 |
| RENDER_TUNING | forest.leafLifeS | 5 | s | NEW: P32 |
| RENDER_TUNING | forest.leafMax | 400 | leaves | NEW: P32 (C-fix moved it here: the most falling leaves at once) |
| RENDER_TUNING | forest.variation | 0.1 | ± brightness | NEW: P32 (tree-to-tree colour) |
| RENDER_TUNING | materials.greenWood.color | '#6e5a3c' | colour | NEW: P32 (greenWood's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.greenWood.roughness | 0.8 | 0-1 | NEW: P32 (greenWood: matte 1, glossy 0) |
| RENDER_TUNING | materials.dryWood.color | '#c2a77c' | colour | NEW: P32 (dryWood's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.dryWood.roughness | 0.95 | 0-1 | NEW: P32 (dryWood: matte 1, glossy 0) |
| RENDER_TUNING | materials.rottenWood.color | '#3f3226' | colour | NEW: P32 (rottenWood's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.rottenWood.roughness | 1 | 0-1 | NEW: P32 (rottenWood: matte 1, glossy 0) |
| RENDER_TUNING | materials.leaves.color | '#8a8a48' | colour | NEW: P32 (leaves's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.leaves.roughness | 0.95 | 0-1 | NEW: P32 (leaves: matte 1, glossy 0) |
| RENDER_TUNING | materials.vine.color | '#58682f' | colour | NEW: P32 (vine's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.vine.roughness | 0.85 | 0-1 | NEW: P32 (vine: matte 1, glossy 0) |
| RENDER_TUNING | materials.sinew.color | '#d8c7a2' | colour | NEW: P32 (sinew's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.sinew.roughness | 0.6 | 0-1 | NEW: P32 (sinew: matte 1, glossy 0) |
| RENDER_TUNING | materials.hide.color | '#7a5636' | colour | NEW: P32 (hide's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.hide.roughness | 0.8 | 0-1 | NEW: P32 (hide: matte 1, glossy 0) |
| RENDER_TUNING | materials.bone.color | '#e6dcc4' | colour | NEW: P32 (bone's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.bone.roughness | 0.6 | 0-1 | NEW: P32 (bone: matte 1, glossy 0) |
| RENDER_TUNING | materials.rulerBone.color | '#d4c49e' | colour | NEW: P32 (rulerBone's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.rulerBone.roughness | 0.55 | 0-1 | NEW: P32 (rulerBone: matte 1, glossy 0) |
| RENDER_TUNING | materials.stone.color | '#8b8a84' | colour | NEW: P32 (stone's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.stone.roughness | 0.9 | 0-1 | NEW: P32 (stone: matte 1, glossy 0) |
| RENDER_TUNING | materials.flint.color | '#2b2c33' | colour | NEW: P32 (flint's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.flint.roughness | 0.22 | 0-1 | NEW: P32 (flint: matte 1, glossy 0) |
| RENDER_TUNING | materials.dirt.color | '#6a4a2e' | colour | NEW: P32 (dirt's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.dirt.roughness | 1 | 0-1 | NEW: P32 (dirt: matte 1, glossy 0) |
| RENDER_TUNING | materials.snow.color | '#eef3f8' | colour | NEW: P32 (snow's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.snow.roughness | 0.7 | 0-1 | NEW: P32 (snow: matte 1, glossy 0) |
| RENDER_TUNING | materials.ice.color | '#bcdcec' | colour | NEW: P32 (ice's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.ice.roughness | 0.12 | 0-1 | NEW: P32 (ice: matte 1, glossy 0) |
| RENDER_TUNING | materials.resin.color | '#c58a26' | colour | NEW: P32 (resin's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.resin.roughness | 0.2 | 0-1 | NEW: P32 (resin: matte 1, glossy 0) |
| RENDER_TUNING | materials.fat.color | '#efe2bd' | colour | NEW: P32 (fat's look; rule 3, SPEC:351-362) |
| RENDER_TUNING | materials.fat.roughness | 0.45 | 0-1 | NEW: P32 (fat: matte 1, glossy 0) |
| RENDER_TUNING | entities.variation | 0.07 | ± brightness | NEW: P32 (entity-to-entity colour) |
| RENDER_TUNING | entities.wetDarken | 0.35 | fraction at moisture 1 | NEW: SPEC:353 ("wet: darker, glossier"; moisture is M2) |
| RENDER_TUNING | entities.wetRoughness | 0.25 | roughness at moisture 1 | NEW: SPEC:353 |
| RENDER_TUNING | entities.crackDarken | 0.72 | × colour | NEW: rule 3, SPEC:362 (integrity < integrityCrack darkens) |
| RENDER_TUNING | entities.crackColor | '#1e1712' | colour | NEW: SPEC:362 (cracks) |
| RENDER_TUNING | entities.crackWidthM | 0.012 | m | NEW: SPEC:362 |
| RENDER_TUNING | entities.sharpColor | '#efe0bd' | colour | NEW: §10.4 ("a pale cone at every sharp point") |
| RENDER_TUNING | entities.sharpConeLenM | 0.12 | m at sharpness 1 | NEW: §10.4; never longer than DAMAGE_TUNING.tipRadiusM, so a snag stub never reaches past what the sharp-point test scores (TODO "snag stub geometry (rule 3)") |
| RENDER_TUNING | entities.sharpConeRadiusM | 0.03 | m at sharpness 1 | NEW: §10.4 |
| RENDER_TUNING | entities.snagStubOutM | 0.12 | m | NEW: P32 (a sharp point on a prism or box, a snag: drawn standing this far out of the surface, capped at DAMAGE_TUNING.tipRadiusM, so it reads; TODO "snag stub geometry (rule 3)") |
| RENDER_TUNING | entities.snagStubRadiusM | 0.05 | m at sharpness 1 | NEW: P32 (a snag stub's base) |
| RENDER_TUNING | entities.sagFrac | 0.03 | × length | NEW: SPEC:362 (integrity < integritySag sags) |
| RENDER_TUNING | entities.sagMaxM | 0.1 | m | NEW: SPEC:362 |
| RENDER_TUNING | entities.strainBendFrac | 0.04 | × length at capacity | NEW: §10.4 (a load above strainShowFrac of capacity bends it) |
| RENDER_TUNING | entities.rotLumpFrac | 0.12 | × radius | NEW: §10.4 ("dark spongy rotten wood": lumpy, not just dark) |
| RENDER_TUNING | entities.bloodColor | '#6e0a0a' | colour | NEW: P32 (blood on a tool, rule 12: drawn only when gore is on) |
| RENDER_TUNING | entities.bloodTintGain | 1.1 | × blood | NEW: P32 (C-fix moved it here: how fast blood covers a tool's colour) |
| RENDER_TUNING | entities.bloodTintMax | 0.92 | fraction | NEW: P32 (C-fix moved it here: the most of a tool's colour blood covers) |
| RENDER_TUNING | entities.bloodPerImpact | 0.2 | blood 0-1 | NEW: P32 (C-fix moved it here: blood a wounding world impact leaves on what struck) |
| RENDER_TUNING | entities.bloodDamagePer | 40 | damage per +1 blood | NEW: P32 (C-fix moved it here: more blood for a harder wound) |
| RENDER_TUNING | entities.instancerIdleFrames | 3600 | frames | NEW: P32 (C-fix moved it here: an entity mesh nothing has drawn this long is freed, a fracture's one-off hull) |
| RENDER_TUNING | ropes.segments | 8 | segments | NEW: §10.4 (an 8-segment parabola) |
| RENDER_TUNING | ropes.radiusMul | 1.6 | × FACTORY_TUNING.ropeRadiusM | NEW: P32 (a 1 cm rope drawn a little thicker so it reads) |
| RENDER_TUNING | ropes.frayColor | '#b5462c' | colour | NEW: SPEC:358 (fraying: reddish) |
| RENDER_TUNING | ropes.frayJitterFrac | 0.9 | × radius | NEW: SPEC:358 (fuzzy) |
| RENDER_TUNING | grass.heightM | 0.5 | m | NEW: P32 (a tuft at cover 1) |
| RENDER_TUNING | grass.widthM | 0.45 | m | NEW: P32 |
| RENDER_TUNING | grass.green | '#5f8a3a' | colour | NEW: P32 (sparse grass) |
| RENDER_TUNING | grass.dry | '#c4b878' | colour | NEW: P32 (dense dry grass: pale, rule 3) |
| RENDER_TUNING | grass.rebuildMoveM | 4 | m | NEW: P32 (the tufts round the camera are re-laid after it moves this far) |
| RENDER_TUNING | carry.beltOutM | 0.2 | m (× scale) | NEW: P32 (a belt item hangs this far out from the pelvis) |
| RENDER_TUNING | carry.beltDownM | 0.05 | m (× scale) | NEW: P32 |
| RENDER_TUNING | carry.backOutM | 0.17 | m (× scale) | NEW: P32 (a back item rides this far behind the chest) |
| RENDER_TUNING | carry.backTiltDeg | 35 | ° | NEW: P32 (slung diagonally) |
| RENDER_TUNING | carry.backUpM | 0.12 | m (× scale) | NEW: P32 (C-fix moved it here: a back item rides this far up the chest) |
| RENDER_TUNING | drag.linkColor | '#5e4b33' | colour | NEW: C-fix (the link drawn from a dragging hand to the grip it pulls by, rule 3) |
| RENDER_TUNING | drag.linkRadiusM | 0.014 | m | NEW: C-fix (the drag link's thickness) |
| RENDER_TUNING | drag.linkSides | 5 | sides | NEW: C-fix (a faceted cord, like the ropes) |
| RENDER_TUNING | drag.linkRoughness | 0.95 | 0-1 | NEW: C-fix (the drag link: matte) |
| RENDER_TUNING | wounds.scarLengthM | 0.1 | m (bone frame) | NEW: SPEC:845 (a healed ruler wound: a scar) |
| RENDER_TUNING | wounds.gashLengthM | 0.14 | m (bone frame) | NEW: SPEC:845 (an open ruler wound: a gash) |
| RENDER_TUNING | wounds.severeMul | 1.5 | × | NEW: SPEC:503 (a severe wound shows bigger) |

##### CAMERA_TUNING (folder "Client › camera")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| CAMERA_TUNING | traumaDecay | 1.6 | trauma/s | DS (cameraRig.ts update: 1.6/s) |
| CAMERA_TUNING | shakeAmpM | 0.12 | m | DS (cameraRig.ts update: ±0.12 m) |
| CAMERA_TUNING | shakeRollRad | 0.025 | rad | DS (cameraRig.ts update: ±0.025 rad) |
| CAMERA_TUNING | punchDecay | 4 | 1/s | DS (cameraRig.ts update: 4/s) |
| CAMERA_TUNING | punchFov | 0.05 | fov fraction per punch | DS (cameraRig.ts update: fov × (1 − 0.05·punch)) |
| CAMERA_TUNING | cutFloorM | 0.15 | m | DS (cinematics.ts place: 0.15 over y = 0); §10.6 |
| CAMERA_TUNING | slowmoZoom | 1.12 | × (fov divisor) | DS (game.ts: camRig.zoom = 1.12 in slow motion) |
| CAMERA_TUNING | cutoutHeightM | 1 | m | DS (game.ts cutFocus.y = 1), over the ground (§10.6) |
| CAMERA_TUNING | cutoutRadius | 0.3 | NDC | DS (game.ts updateCutout: 0.3) |
| CAMERA_TUNING | cutoutSpreadPerM | 0.06 | NDC per m | DS (game.ts updateCutout: spread × 0.06) |
| CAMERA_TUNING | cutoutSpreadMax | 0.25 | NDC | DS (game.ts updateCutout: ≤ 0.25) |
| CAMERA_TUNING | cutoutSpreadPerScale | 2.2 | m per scale over 1 | DS (game.ts updateCutout: (scale − 1) × 2.2) |
| CAMERA_TUNING | landShakePerHuman | 0.08 | trauma per human mass | DS (game.ts bodyLanding: 0.08·mass·hard) |
| CAMERA_TUNING | landShakeMax | 0.6 | trauma | DS (game.ts bodyLanding: ≤ 0.6) |
| CAMERA_TUNING | landMinHumans | 1.5 | human masses | DS (game.ts bodyLanding: mass > 1.5) |
| CAMERA_TUNING | landHardSpeed | 5 | m/s | DS (game.ts bodyLanding: fall speed / 5) |
| CAMERA_TUNING | landRangePerScaleM | 6 | m per ∛(human masses) | NEW: DS giant footfalls are felt within 6 m × scale |

##### FOLLOW_TUNING (folder "Client › follow camera")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| FOLLOW_TUNING | blendMaxSpeed | 18 | m/s | NEW (P34): caps the follow ↔ fight blend |
| FOLLOW_TUNING | blendMaxTurnDegS | 120 | °/s | NEW (P34): caps the follow ↔ fight blend |

##### VERB_UI_TUNING (folder "Client › verb UI")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| VERB_UI_TUNING | fightAimPitchDeg | 30 | ° | NEW (P35): the fight camera aims along your facing (§10.7), tilted down this much so it can meet the ground at your feet |
| VERB_UI_TUNING | fightThrowPitchDeg | 8 | ° | NEW (P35): a throw while the fight camera frames you goes along your facing, this far up |
| VERB_UI_TUNING | padStickDead | 0.2 | stick | DS (input.ts: the left stick ignored under 0.2); both sticks |
| VERB_UI_TUNING | radialStickMin | 0.5 | stick | NEW (P35): the right stick picks a radial sector, or flicks a placement round, past this |
| VERB_UI_TUNING | radialRadiusPx | 110 | px | NEW (P35): the radial ring; the virtual cursor stays on it |
| VERB_UI_TUNING | refocusS | 0.5 | s | NEW (P35): a focus the sim dropped (out of range, a fight) is sent again after this |
| VERB_UI_TUNING | groundRefocusM | 0.1 | m | NEW (P35): a ground focus is sent again once the aimed point moves this far |
| VERB_UI_TUNING | aimRangeM | 60 | m | NEW (P35): how far the crosshair looks for what a throw converges on |
| VERB_UI_TUNING | aimConvergeM | 30 | m | NEW (P35): a throw converges on the crosshair this far out when it rests on nothing |
| VERB_UI_TUNING | arcMaxS | 4 | s | NEW (P35): the throw arc is drawn for at most this long a flight |
| VERB_UI_TUNING | leanSampleM | 0.05 | m | NEW (P35): a sloped ghost looks for what it leans on with a downward ray this often along it |
| VERB_UI_TUNING | aimTerrainStepM | 0.1 | m | NEW (P38, was a bare default): the aim ray's march step over the terrain before it bisects (input/targeting.ts rayTerrain) |
| VERB_UI_TUNING | ropeShellRadiusM | 0.045 | m | NEW (P35): a highlighted rope is drawn this thick (ropes are thin; the outline must read at a few metres) |
| VERB_UI_TUNING | groundRingM | 0.3 | m | NEW (P35): the ring marking a ground target (dig, place) |
| VERB_UI_TUNING | landingRingM | 0.33 | m | NEW (P35): the ring where the throw arc lands |
| VERB_UI_TUNING | promptLiftM | 0.35 | m | NEW (P35): the prompt floats this far over what is outlined |
| VERB_UI_TUNING | ghostOpacity | 0.38 | 0-1 | NEW (P35): the placement ghost |
| VERB_UI_TUNING | wheelPxPerNotch | 100 | px | NEW (P35): a pixel-mode wheel event (Chrome: 100 px a notch) |
| VERB_UI_TUNING | wheelLinesPerNotch | 3 | lines | NEW (P35): a line-mode wheel event (Firefox: 3 lines a notch) |
| VERB_UI_TUNING | shellOpacity | 0.6 | 0-1 | NEW (P35): the outline shell over a highlighted entity |
| VERB_UI_TUNING | markOpacity | 0.7 | 0-1 | NEW (P35): the flat marks: a ground target’s ring, a highlighted rope |
| VERB_UI_TUNING | arcOpacity | 0.85 | 0-1 | NEW (P35): the throw arc |
| VERB_UI_TUNING | landingRingOpacity | 0.8 | 0-1 | NEW (P35): the ring where the throw arc lands |
| VERB_UI_TUNING | ringInnerFrac | 0.75 | fraction | NEW (P35): a ring’s inner radius over its outer (the ground ring, the landing ring) |
| VERB_UI_TUNING | groundRingLiftM | 0.02 | m | NEW (P35): the ground target’s ring floats this far over the terrain (no z-fighting) |
| VERB_UI_TUNING | landingRingLiftM | 0.03 | m | NEW (P35): the landing ring floats this far over where the arc lands |
| VERB_UI_TUNING | radialRingPadPx | 26 | px | NEW (P35): the radial’s backdrop reaches this far past the ring of options |

##### HUD_TUNING (folder "Client › HUD")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| HUD_TUNING | compassSpanDeg | 180 | ° | §10.8 ("a 180° strip") |
| HUD_TUNING | compassTickDeg | 15 | ° | NEW (P36): a tick on the compass every this many degrees |
| HUD_TUNING | spawnPingHideM | 3 | m | NEW (P36): the spawn ping hides this close to the spawn |
| HUD_TUNING | markerLiftM | 0.35 | m × scale | NEW (P36): an awareness marker floats this far over the head |
| HUD_TUNING | hintFadeAfter | 8 | strikes | DS (the controls hint fades after this many of your strikes) |

##### KILLCAM_TUNING (folder "Client › kill cam")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| KILLCAM_TUNING | causeBackM | 1 | m | NEW (P36): the cause point, back along the blow from the impact |
| KILLCAM_TUNING | focusFloor | 0.35 | m × scale over the ground | DS (game.ts pelvisOf: 0.35 × scale), §10.3 |
| KILLCAM_TUNING | envKill.dist | 3.8 | m (× max(1, distScale·scale)) | DS (game.ts finishing shot) |
| KILLCAM_TUNING | envKill.distScale | 0.75 | × scale | DS (game.ts finishing shot): the 0.75 of 3.8 × max(1, 0.75·scale) |
| KILLCAM_TUNING | envKill.height | 0.55 | m | DS (game.ts finishing shot) |
| KILLCAM_TUNING | envKill.orbit | 0.3 | rad (per s of the shot) | §9.1 KILLCAM_TUNING envKill (DS finishing shot) |
| KILLCAM_TUNING | envKill.fov | 38 | ° | §9.1 KILLCAM_TUNING envKill (DS finishing shot) |
| KILLCAM_TUNING | envKill.durationS | 2.2 | s (real) | §9.1 KILLCAM_TUNING envKill (DS finishing shot) |
| KILLCAM_TUNING | envKill.slow | 0.18 | × time | §9.1 KILLCAM_TUNING envKill (DS finishing shot) |
| KILLCAM_TUNING | envKill.priority | 4 | — | §9.1 KILLCAM_TUNING envKill (DS finishing shot) (Cinematics' ladder: death 5, skull 4.5, finisher 4) |
| KILLCAM_TUNING | envKill.toward | 0.1 | × (over the cause's shoulder; negative: over the subject's) | DS (game.ts finishing shot), §10.3: across(cause point, victim, 0.1) |
| KILLCAM_TUNING | worldWound.dist | 3.3 | m × scale | NEW (DS boss-intro framing, MAP client §3.3) |
| KILLCAM_TUNING | worldWound.height | -0.15 | m × scale | NEW (DS boss-intro framing) |
| KILLCAM_TUNING | worldWound.dolly | -0.35 | m/s | NEW (DS boss-intro framing) |
| KILLCAM_TUNING | worldWound.orbit | -0.12 | rad (per s of the shot) | §9.1 KILLCAM_TUNING worldWound |
| KILLCAM_TUNING | worldWound.fov | 42 | ° | §9.1 KILLCAM_TUNING worldWound |
| KILLCAM_TUNING | worldWound.durationS | 2.4 | s (real) | §9.1 KILLCAM_TUNING worldWound |
| KILLCAM_TUNING | worldWound.slow | 0.25 | × time | §9.1 KILLCAM_TUNING worldWound |
| KILLCAM_TUNING | worldWound.priority | 4.5 | — | §9.1 KILLCAM_TUNING worldWound (Cinematics' ladder: death 5, skull 4.5, finisher 4) |
| KILLCAM_TUNING | rulerDeath.dist | 4 | m × scale | NEW |
| KILLCAM_TUNING | rulerDeath.height | 0.3 | m × scale | NEW |
| KILLCAM_TUNING | rulerDeath.orbit | 0.1 | rad (per s of the shot) | §9.1 KILLCAM_TUNING rulerDeath |
| KILLCAM_TUNING | rulerDeath.fov | 40 | ° | §9.1 KILLCAM_TUNING rulerDeath |
| KILLCAM_TUNING | rulerDeath.durationS | 4 | s (real) | §9.1 KILLCAM_TUNING rulerDeath |
| KILLCAM_TUNING | rulerDeath.slow | 0.2 | × time | §9.1 KILLCAM_TUNING rulerDeath |
| KILLCAM_TUNING | rulerDeath.priority | 6 | — | §9.1 KILLCAM_TUNING rulerDeath (Cinematics' ladder: death 5, skull 4.5, finisher 4) |
| KILLCAM_TUNING | rulerDeath.toward | 0 | × (over the cause's shoulder; negative: over the subject's) | NEW (P36): §10.3 gives no side for this shot |
| KILLCAM_TUNING | playerByRuler.dist | 7 | m | NEW (rule 9) |
| KILLCAM_TUNING | playerByRuler.height | 2.5 | m | NEW (rule 9) |
| KILLCAM_TUNING | playerByRuler.orbit | 0.2 | rad (per s of the shot) | §9.1 KILLCAM_TUNING playerByRuler |
| KILLCAM_TUNING | playerByRuler.fov | 44 | ° | §9.1 KILLCAM_TUNING playerByRuler |
| KILLCAM_TUNING | playerByRuler.durationS | 2.6 | s (real) | §9.1 KILLCAM_TUNING playerByRuler |
| KILLCAM_TUNING | playerByRuler.slow | 0.3 | × time | §9.1 KILLCAM_TUNING playerByRuler |
| KILLCAM_TUNING | playerByRuler.priority | 5.5 | — | §9.1 KILLCAM_TUNING playerByRuler (Cinematics' ladder: death 5, skull 4.5, finisher 4) |
| KILLCAM_TUNING | playerDeath.dist | 3 | m | DS (game.ts onKO, the death cam) |
| KILLCAM_TUNING | playerDeath.height | 1.7 | m | DS (game.ts onKO, the death cam) |
| KILLCAM_TUNING | playerDeath.dolly | -0.2 | m/s | DS (game.ts onKO, the death cam) |
| KILLCAM_TUNING | playerDeath.orbit | 0.16 | rad (per s of the shot) | §9.1 KILLCAM_TUNING playerDeath (DS death cam; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | playerDeath.fov | 40 | ° | §9.1 KILLCAM_TUNING playerDeath (DS death cam; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | playerDeath.durationS | 3.2 | s (real) | §9.1 KILLCAM_TUNING playerDeath (DS death cam; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | playerDeath.slow | 0.22 | × time | §9.1 KILLCAM_TUNING playerDeath (DS death cam; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | playerDeath.priority | 5 | — | §9.1 KILLCAM_TUNING playerDeath (DS death cam; DEVIATION: no §9.1 row) (Cinematics' ladder: death 5, skull 4.5, finisher 4) |
| KILLCAM_TUNING | playerDeath.toward | -0.2 | × (over the cause's shoulder; negative: over the subject's) | DS (game.ts onKO: across(by, f, −0.2)) |
| KILLCAM_TUNING | skullSplit.dist | 1.9 | m (× max(1, distScale·scale)) | DS (game.ts skullBlow) |
| KILLCAM_TUNING | skullSplit.distScale | 0.8 | × scale | DS (game.ts skullBlow): the 0.8 of 1.9 × max(1, 0.8·scale) |
| KILLCAM_TUNING | skullSplit.height | 0.25 | m | DS (game.ts skullBlow) |
| KILLCAM_TUNING | skullSplit.dolly | -0.2 | m/s | DS (game.ts skullBlow) |
| KILLCAM_TUNING | skullSplit.orbit | 0.4 | rad (per s of the shot) | §9.1 KILLCAM_TUNING skullSplit (DS skull cut; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | skullSplit.fov | 36 | ° | §9.1 KILLCAM_TUNING skullSplit (DS skull cut; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | skullSplit.durationS | 2.1 | s (real) | §9.1 KILLCAM_TUNING skullSplit (DS skull cut; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | skullSplit.slow | 0.1 | × time | §9.1 KILLCAM_TUNING skullSplit (DS skull cut; DEVIATION: no §9.1 row) |
| KILLCAM_TUNING | skullSplit.priority | 4.5 | — | §9.1 KILLCAM_TUNING skullSplit (DS skull cut; DEVIATION: no §9.1 row) (Cinematics' ladder: death 5, skull 4.5, finisher 4) |
| KILLCAM_TUNING | skullSplit.toward | 0.45 | × (over the cause's shoulder; negative: over the subject's) | DS (game.ts skullBlow: across(by, f, 0.45)) |

##### GAME_TUNING (folder "Client › game")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| GAME_TUNING | devViews.navLiftM | 0.06 | m | NEW (C-fix): the nav polygons float this far over the ground (no z-fighting) |
| GAME_TUNING | devViews.navOpacity | 0.22 | 0-1 | NEW (C-fix): the nav polygons' fill |
| GAME_TUNING | devViews.navHuman | '#38c8ff' | colour | NEW (C-fix): the human layer's polygons |
| GAME_TUNING | devViews.navRuler | '#ff9a3c' | colour | NEW (C-fix): the ruler layer's polygons |
| GAME_TUNING | devViews.navRulerLiftMul | 2 | × navLiftM | NEW (C-fix): the ruler layer floats higher, so both read where they overlap |
| GAME_TUNING | devViews.navEdgeOpacityMul | 3 | × navOpacity | NEW (C-fix): the nav polygons' edges (capped at 1) |
| GAME_TUNING | devViews.senseColor | '#ffd36b' | colour | NEW (C-fix): a creature's sight cone at sightRangeM (§6.2) |
| GAME_TUNING | devViews.senseStillColor | '#b98a2e' | colour | NEW (C-fix): the cone's inner arc, sightRangeStillM (§6.2: a still target is seen nearer) |
| GAME_TUNING | devViews.senseArcSegments | 16 | segments | NEW (C-fix): the sight cone's arcs |
| GAME_TUNING | devViews.noiseColor | '#ff5a8a' | colour | NEW (C-fix): a noise's hearing ring (its radius, §6.2) |
| GAME_TUNING | devViews.noiseRingS | 1.5 | s (real) | NEW (C-fix): a hearing ring stays this long after its noise |
| GAME_TUNING | devViews.noiseRingSegments | 32 | segments | NEW (C-fix): a hearing ring's circle |
| GAME_TUNING | devViews.noiseLiftM | 0.1 | m | NEW (C-fix): a hearing ring floats this far over the ground at the noise |
| GAME_TUNING | devViews.zoneColor | '#ffe14a' | colour | NEW (C-fix): the hit zones' wireframes (§4.8) |
| GAME_TUNING | devViews.zoneOpacity | 0.55 | 0-1 | NEW (C-fix) |
| GAME_TUNING | devViews.zoneSphereSegments | 10 | segments | NEW (C-fix): a ball zone's wireframe, around (read when first built) |
| GAME_TUNING | devViews.zoneSphereRings | 8 | rings | NEW (C-fix): a ball zone's wireframe, top to bottom (read when first built) |
| GAME_TUNING | devViews.zoneCapsuleCapSegments | 3 | segments | NEW (C-fix): a capsule zone's end caps (read when first built) |
| GAME_TUNING | devViews.zoneCapsuleRadialSegments | 8 | segments | NEW (C-fix): a capsule zone, around (read when first built) |

##### LOOP_TUNING (folder "Client › loop")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| LOOP_TUNING | maxFrameS | 0.1 | s | DS (game.ts start: a frame counts at most 0.1 s) |
| LOOP_TUNING | devTimeScales | [1,0.5,0.25,0.1] | × | DS (game.ts TIME_SCALES: what the dev T key cycles through) |

##### PRESENTATION_TUNING (folder "Client › presentation")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| PRESENTATION_TUNING | lodHysteresisM | 2 | m | NEW (P33): a body that has a ragdoll keeps it until another is this much nearer the camera (no swapping at the edge) |
| PRESENTATION_TUNING | bodyFallSpeed | 1.4 | m/s | DS (game.ts bodyLanding: falling faster than 1.4 m/s) |
| PRESENTATION_TUNING | bodyFallStopFrac | 0.35 | × fall speed | DS (game.ts bodyLanding: stopped below 0.35 of the fall speed) |
| PRESENTATION_TUNING | bodyFallNearM | 0.45 | m × scale | DS (game.ts bodyLanding: pelvis within 0.45 × scale of the ground) |
| PRESENTATION_TUNING | bodyFallQuietSteps | 20 | steps | DS (game.ts bodyLanding: 20 quiet steps after a landing) |
| PRESENTATION_TUNING | bodyFallHardSpeed | 5 | m/s | DS (game.ts bodyLanding: hard = fall speed / 5) |

##### FEEL_TUNING (folder "Client › feel")

| Table | Key | Value | Unit | Source |
|---|---|---|---|---|
| FEEL_TUNING | mix.compressorThresholdDb | -14 | dB | DS (audio.ts unlock) |
| FEEL_TUNING | mix.compressorRatio | 6 | × | DS (audio.ts unlock) |
| FEEL_TUNING | space.refDistM | 6 | m | NEW: P37 (full volume within this, × the sound family's loud) |
| FEEL_TUNING | space.maxDistM | 160 | m | NEW: P37 (silent beyond this, × loud) |
| FEEL_TUNING | space.pan | 0.7 | 0-1 | NEW: P37 (how far left/right a sound beside the camera is panned) |
| FEEL_TUNING | space.inaudibleGain | 0.01 | 0-1 | NEW: P37 (quieter than this is not played) |
| FEEL_TUNING | steps.runSpeed | 3.8 | m/s (÷ scale) | DS (game.ts footsteps: weight = speed / 3.8) |
| FEEL_TUNING | steps.giantFromScale | 2.5 | × scale | NEW: P37 (a fighter this big steps as a giant: giantStep) |
| FEEL_TUNING | steps.coverGrass | 0.35 | cover 0-1 | NEW: P37 (ground cover above this sounds like grass) |
| FEEL_TUNING | steps.onEntityM | 0.12 | m | NEW: P37 (a foot this far above the terrain stands on an entity) |
| FEEL_TUNING | steps.jumpLandSpeed | 3.2 | m/s | NEW: P37 (a fall at least this fast lands with both feet, DS landings) |
| FEEL_TUNING | steps.landStopFrac | 0.35 | × fall speed | DS (game.ts bodyLanding: a fall has stopped once it is this fraction of what it was) |
| FEEL_TUNING | steps.jumpLandScaleMul | 1.15 | × scale | DS (game.ts landings: footstep(…, 1.15·scale)) |
| FEEL_TUNING | steps.teleportSpeed | 30 | m/s | NEW: P37 (faster than this between frames is a teleport, not a fall) |
| FEEL_TUNING | thuds.bodyHardSpeed | 5 | m/s | DS (game.ts bodyLanding: hard = fall speed / 5) |
| FEEL_TUNING | thuds.entityHardSpeed | 8 | m/s | DS (game.ts thud: hard = speed / 12), for the Clearing's heavier things |
| FEEL_TUNING | thuds.minEnergyJ | 2 | J | NEW: P37 (a landing with less energy makes no thud) |
| FEEL_TUNING | thuds.impactHardJPerKg | 10 | J per kg | NEW: P37 (a world impact this hard per kg of the body struck sounds full force) |
| FEEL_TUNING | creaks.ropePeriodS | 1.2 | s | NEW: SPEC:357 (one creak this often at creakFrom, quicker toward breaking) |
| FEEL_TUNING | creaks.treePeriodS | 1.8 | s | NEW: SPEC:581 (a notched tree creaks before it goes) |
| FEEL_TUNING | creaks.treeFallWhooshS | 0.7 | s | NEW: SPEC:581 (the crown's whoosh after the first creak of a fall) |
| FEEL_TUNING | creaks.chopCreakDelayS | 0.12 | s | NEW: SPEC:581 (a nearly cut trunk creaks this long after the chop) |
| FEEL_TUNING | breath.tiredBelow | 0.4 | stamina 0-1 | DS (game.ts panting: gassed below 0.4) |
| FEEL_TUNING | breath.tiredSpan | 0.35 | stamina 0-1 | DS (game.ts panting: fully winded 0.35 lower) |
| FEEL_TUNING | breath.outS | 0.42 | s | DS (game.ts panting: a breath out) |
| FEEL_TUNING | breath.outQuickerS | 0.12 | s | DS (game.ts panting: quicker winded) |
| FEEL_TUNING | breath.inS | 0.3 | s | DS (game.ts panting: a breath in) |
| FEEL_TUNING | breath.inQuickerS | 0.08 | s | DS (game.ts panting: quicker winded) |
| FEEL_TUNING | jungle.gain | 0.6 | 0-1 | NEW: SPEC:851 (the jungle bed's level) |
| FEEL_TUNING | jungle.birdsPerS | 0.4 | calls/s | NEW: SPEC:851 |
| FEEL_TUNING | jungle.insectGain | 0.012 | 0-1 | NEW: SPEC:851 |
| FEEL_TUNING | jungle.windGain | 0.01 | 0-1 | NEW: SPEC:851 |
| FEEL_TUNING | jungle.fadeS | 2.5 | s | NEW: SPEC:851 (how fast the jungle hushes and comes back) |
| FEEL_TUNING | loud.step | 1 | × ref distance | NEW: P37 (how far a footstep carries) |
| FEEL_TUNING | loud.combat | 1.5 | × ref distance | NEW: P37 (DS blows, blocks, swings) |
| FEEL_TUNING | loud.chop | 3 | × ref distance | NEW: P37 |
| FEEL_TUNING | loud.creak | 2 | × ref distance | NEW: P37 |
| FEEL_TUNING | loud.crack | 4 | × ref distance | NEW: P37 |
| FEEL_TUNING | loud.snap | 4 | × ref distance | NEW: P37 |
| FEEL_TUNING | loud.dig | 2 | × ref distance | NEW: P37 |
| FEEL_TUNING | loud.treeFall | 8 | × ref distance | NEW: P37 |
| FEEL_TUNING | loud.crash | 10 | × ref distance | NEW: P37 (a felled tree or a heavy thing landing) |
| FEEL_TUNING | loud.giantStep | 6 | × ref distance | NEW: SPEC:849 |
| FEEL_TUNING | loud.roar | 20 | × ref distance | NEW: SPEC:850 (every ruler has a distinct roar) |
| FEEL_TUNING | loud.hoot | 6 | × ref distance | NEW: P37 (the ape's call) |

### 9.2 Values the spec doesn't give (every `NEW` row of §9.1)

Each is a tuning default chosen here, with the reason; none is a spec value. The pull force (orchestrator decision 4)
is `VERB_TUNING.pullForceN` 500 N (D-26) with the yank `pullYankN` 1,200 N for 9 ticks below.

| Table.key | Value | Unit | Why |
|---|---|---|---|
| DAMAGE_TUNING.tipRadiusM | 0.15 | m | a sharp point counts only near its tip |
| DAMAGE_TUNING.impactCooldownTicks | 6 | ticks | bounce suppression per pair |
| DAMAGE_TUNING.minImpactJ | 5 | J | ignore brushes (with \|Δv\| < flinchDv) |
| MOVE_TUNING.sprintMul | 1.4 | × speed | DS run 3.77 → sprint 5.28 m/s (SPEC:370) |
| MOVE_TUNING.sprintStaminaPerS | 0.15 | stamina/s | 6.7 s from full |
| MOVE_TUNING.sprintMinStamina | 0.1 | stamina | chosen here |
| MOVE_TUNING.crouchSpeedMul | 0.5 | × speed | chosen here |
| MOVE_TUNING.jumpStamina | 0.05 | stamina | chosen here |
| MOVE_TUNING.carrySpeedPerKg | 0.01 | 1/kg | SPEC:387 "carrying slows you" |
| MOVE_TUNING.carrySpeedMin | 0.6 | × speed | (40 kg → 0.6) |
| MOVE_TUNING.carryRegenPerKg | 0.015 | 1/kg | SPEC:387 "costs stamina" |
| MOVE_TUNING.carryRegenMin | 0.4 | × regen | chosen here |
| MOVE_TUNING.carryNoSprintKg | 20 | kg | chosen here |
| MOVE_TUNING.dragSpeedMul | 0.75 | × walk | chosen here |
| MOVE_TUNING.pullWalkMul | 0.2 | × walk | braced while pulling |
| IMPACT_TUNING.launchDv | 5 | m/s | above every DS knockback (max 4.6), MAP gap-2 §8 |
| IMPACT_TUNING.flinchDv | 0.5 | m/s | MAP gap-2 §8 |
| WORLD_TUNING.aiNearM | 60 | m | SPEC:698 says only "near the player" |
| WORLD_TUNING.corpseDespawnS | 120 | s | chosen here |
| TERRAIN_TUNING.tileSize | 25 | m | D-7 (8 × 8 tiles = one 200 m chunk) |
| TERRAIN_TUNING.spacing | 0.25 | m | D-7, MAP rapier §2 (a 0.5 m dig needs ≤ 0.25 m) |
| TERRAIN_TUNING.material | 'dirt' | — | D-22 (friction 0.7, soft) |
| TERRAIN_TUNING.softGroundMaxHardness | 0.5 | hardness | D-19 |
| TERRAIN_TUNING.pileMergeR | 1.5 | m | chosen here |
| TERRAIN_TUNING.maxPilesNear | 12 | piles | SPEC:803 body budget (§4.13) |
| TERRAIN_TUNING.pilesNearR | 10 | m | chosen here |
| TERRAIN_TUNING.spoilMinGapM | 0.5 | m beyond the dig radius | chosen here |
| TERRAIN_TUNING.spoilSearchMaxM | 15 | m | chosen here |
| TERRAIN_TUNING.spoilMaxRiseM | 1 | m above original | chosen here |
| TERRAIN_TUNING.spoilUndugTolM | 0.05 | m | chosen here |
| PHYSICS_TUNING.entityLinDamp | 0 | 1/s | chosen here |
| PHYSICS_TUNING.entityAngDamp | 0.1 | 1/s | chosen here |
| PHYSICS_TUNING.ccdMinHalfExtent | 0.15 | m | SPEC:267 asks CCD for fast small bodies |
| PHYSICS_TUNING.cylinderFacets | 8 | sides | C F1, MAP rapier finding 17 |
| PHYSICS_TUNING.logFacets | 6 | sides | C F1, F2 (logs rest) |
| PHYSICS_TUNING.forceEventThresholdN | 2,000 | N | dev cross-check only |
| PHYSICS_TUNING.restSpeed | 0.05 | m/s | chosen here |
| PHYSICS_TUNING.restTicks | 30 | ticks | chosen here |
| MATERIALS.*.wetMassPerMoisture | 0 | kg/kg per unit moisture | M2 rule, 0 in M1 (SPEC:180, 324) |
| SPECIES_BODY.human.footRadiusM | 0.12 | m × scale | D-39 footprint |
| SPECIES_BODY.ape.massKg | 97.56 | kg | 73.3 × 1.1³ (SPEC:660 "mass with size³") |
| SPECIES_BODY.ape.footRadiusM | 0.12 | m × scale | chosen here |
| SPECIES_BODY.ape.parts | hide ×1 (2 kg box); bone ×2 (0.5 kg) | entities | D-30 |
| SPECIES_BODY.giantApe.footRadiusM | 0.12 | m × scale (0.66 m) | chosen here |
| SPECIES_BODY.giantApe.parts | hide ×4 (20 kg); rulerBone ×6 (5 kg) | entities | D-30 |
| RULER_TUNING.unpinnedKg | 900 | kg | hysteresis |
| RULER_TUNING.unpinTicks | 15 | ticks | hysteresis |
| RULER_TUNING.lockScale | 2 | × | MAP gap-0 §6.6 (lock-on range for rulers) |
| RULER_TUNING.retargetBiasCapM | 0.35 | m | MAP gap-0 §6.6 |
| RULER_ZONE_TUNING.kneeR | 0.09 | m × scale | MAP gap-0 §5, gap-6 |
| RULER_ZONE_TUNING.elbowR | 0.07 | m × scale | MAP gap-0 §5 |
| RULER_ZONE_TUNING.eyeNzMin / eyeNyMin / eyeNyMax / eyeNxMax | 0.6 / −0.05 / 0.35 / 0.55 | normal components | MAP gap-0 §5 |
| RULER_ZONE_TUNING.mouthNzMin / mouthNyMin / mouthNyMax / mouthNxMax | 0.6 / −0.6 / −0.05 / 0.4 | normal components | chosen here |
| RULER_ZONE_TUNING.shouldersNy / backNz / flanksNx | 0.6 / −0.4 / 0.6 | normal components | chosen here |
| RULER_ZONE_TUNING.bellyNz / bellyNxMax | 0.5 / 0.6 | normal components | chosen here |
| RULER_BODY_TUNING.sweepSkinM | 0.05 | m | chosen here |
| RULER_BODY_TUNING.ledgeTripDropFrac | 0.5 | × knee height (1.4 m) | D-9 (e) |
| RULER_BODY_TUNING.getupFrames | 94 | frames | 40·√5.5, MAP gap-3 §2.3 |
| RULER_BODY_TUNING.getupKneelFrame | 52 | frame | DS 0.55 of the track |
| RULER_BODY_TUNING.trippedLinDamp | 0.1 | 1/s | orchestrator decision 5, MAP gap-3 |
| RULER_BODY_TUNING.trippedAngDamp | 1 | 1/s | orchestrator decision 5 |
| RULER_BODY_TUNING.trippedExtraIters | 4 | iterations | MAP gap-3 |
| RULER_BODY_TUNING.tripPose | 'freeze' | — | MAP gap-3 |
| RULER_BODY_TUNING.friction | 0.9 | — | chosen here |
| RULER_BODY_TUNING.restitution | 0.05 | — | chosen here |
| CHARACTER_TUNING.capsuleHalfH | 0.6 | m × scale | 1.8 m tall |
| CHARACTER_TUNING.kccOffset | 0.02 | m × scale | MAP rapier §3 |
| CHARACTER_TUNING.snapToGround | 0.3 | m × scale | MAP rapier §3 |
| CHARACTER_TUNING.autostepMaxH | 0.4 | m × scale | D-28 (climb = autostep) |
| CHARACTER_TUNING.autostepMinW | 0.2 | m × scale | chosen here |
| CHARACTER_TUNING.autostepDynamic | true | — | chosen here |
| CHARACTER_TUNING.maxSlopeClimbDeg | 45 | ° | MAP rapier §3 |
| CHARACTER_TUNING.minSlopeSlideDeg | 30 | ° | MAP rapier §3 |
| CHARACTER_TUNING.jumpSpeed | 4.2 | m/s × √scale | D-28 (≈ 0.9 m jump) |
| CHARACTER_TUNING.landingKnockdownSpeed | 9 | m/s | chosen here |
| DOWNED_TUNING.halfWidth / halfLength / halfThick / border | 0.20 / 0.865 / 0.06 / 0.04 | m × scale | MAP gap-4 §8 |
| DOWNED_TUNING.friction / restitution | 0.9 / 0.05 | — | MAP gap-4 |
| DOWNED_TUNING.linDamp / angDamp | 0.05 / 0.6 | 1/s | MAP gap-4 |
| DOWNED_TUNING.toppleRadS | 2.5 | rad/s ÷ √scale | MAP gap-4 |
| DOWNED_TUNING.minPush | 0.8 | m/s | MAP gap-4 |
| DOWNED_TUNING.settleSpeed | 0.5 | m/s | chosen here |
| DOWNED_TUNING.settleMaxHold | 300 | frames | chosen here |
| DOWNED_TUNING.standRings | [0.35, 0.70, 1.05] | m | MAP gap-4 §6 |
| DOWNED_TUNING.standDirs | 8 | directions | chosen here |
| DOWNED_TUNING.maxStandSlopeDeg | 45 | ° | chosen here |
| DOWNED_TUNING.boneBands | [0.50, 0.94, 1.09, 1.29, 1.55] | m along the slab × scale (shin/thigh/pelvis/abdomen/chest/head) | from the skeleton |
| JOINT_TUNING.tautEps | 0.001 | m | MAP rapier §5 |
| JOINT_TUNING.ropeSensorR | 0.02 | m | chosen here |
| JOINT_TUNING.strandMergeM | 0.05 | m | SPEC:266 strands |
| JOINT_TUNING.nnlsMaxGroups | 8 | strand groups per body | C F5 |
| JOINT_TUNING.bendK | 400,000 | N·m/rad per m² of diameter | (6 cm green sapling: 864 N·m/rad) |
| JOINT_TUNING.bendDamping | 40,000 | N·m·s/rad per m² | chosen here |
| JOINT_TUNING.bendMinSpringiness | 0.3 | — | springy predicate |
| BREAK_TUNING.pieceGraceTicks | 10 | ticks | C §7 item 7 |
| LOAD_TUNING.maxSpreadDepth | 4 | levels | D-39 |
| LOAD_TUNING.supportNormalY | 0.5 | cos | chosen here |
| LOAD_TUNING.footDiscH | 0.06 | m | D-39 |
| FELL_TUNING.refChopJ | 339 | J | the stone axe's fresh chop [B lab: tools.ts] |
| FELL_TUNING.chopScaleMin | 0.5 | × | chosen here |
| FELL_TUNING.chopScaleMax | 2.5 | × | chosen here |
| FELL_TUNING.hingeK | 1,500 | — | calibrated in §4.12 |
| FELL_TUNING.hingeRad | 0.1 | rad | impact → moment |
| FELL_TUNING.cutHeightM | 0.5 | m | chosen here |
| FELL_TUNING.tipAngVel | 0.15 | rad/s | chosen here |
| FELL_TUNING.hingeTearDeg | 75 | ° | C F10 |
| FELL_TUNING.hingeLimitDeg | 80 | ° | chosen here |
| NAV_TUNING.human.radius / height / climb / maxSlopeDeg | 0.4 / 1.8 / 0.4 / 45 | m / m / m / ° | MAP recast §10.3 |
| NAV_TUNING.human.cs / ch / tileVox | 0.2 / 0.2 / 32 | m / m / voxels | MAP recast §10.3 |
| NAV_TUNING.human.halfExtents / tilesPerTick | [2, 4, 2] / 2 | m / tiles | MAP recast §6, §10.3 |
| NAV_TUNING.ruler.height / climb / maxSlopeDeg | 10 / 1.0 / 40 | m / m / ° | MAP recast §10.3 |
| NAV_TUNING.ruler.cs / ch / tileVox | 0.5 / 0.25 / 32 | m / m / voxels | chosen here |
| NAV_TUNING.ruler.halfExtents / tilesPerTick | [4, 6, 4] / 1 | m / tiles | chosen here |
| NAV_TUNING.maxSimplificationError / minRegionArea / mergeRegionArea | 1.3 / 8 / 20 | voxels | MAP recast §10.3 |
| NAV_TUNING.maxVertsPerPoly / detailSampleDist / detailSampleMaxError | 6 / 6 / 1 | — / voxels / voxels | MAP recast §7.6 (≥ 0.9) |
| NAV_TUNING.maxNodes | 2,048 | nodes | chosen here |
| NAV_TUNING.dirtyMinMoveM / dirtyMinTurnDeg | 0.25 / 10 | m / ° | chosen here |
| NAV_TUNING.extrudeAboveAnkleM | 0.39 | m above original ground | the giant's ankle (§7) |
| CLEARING_TUNING.groves / treesPerGrove / singleTrees | 6 / 8 / 12 | count | chosen here |
| CLEARING_TUNING.treeDiamBands | 0.20-0.30 (50 %), 0.30-0.45 (35 %), 0.45-0.60 (15 %) | m | chosen here |
| CLEARING_TUNING.treeHeight | clamp(6 + 18·d ± 1.5, 8, 16) | m | chosen here |
| CLEARING_TUNING.groveDistM / groveRadiusM / groveBearingJitterDeg | 30-65 / 10-15 / 15 | m / m / ° | chosen here |
| CLEARING_TUNING.treeMinGapM / spawnClearM / routeClearM / maxSlopeDeg | 4 / 15 / 6 / 25 | m / m / m / ° | chosen here |
| CLEARING_TUNING.gates / gateGapM / gateDiamM | 2 / 1.8 / 0.5-0.6 | count / m / m | SPEC:774, MAP recast §9 |
| CLEARING_TUNING.hangingVines / vineAnchorM / vineAnchorMaxFrac / vineSlackM | 12 / 7-12 / 0.8 / 3-8.5 | count / m / × tree height / m | chosen here |
| CLEARING_TUNING.longVines / longVineAnchorM / longVineSlackM / longVineTreeMinH | 4 / ≥ 10 / 8.5 / 12.5 | count / m / m / m | AC-3 needs ≥ 17.96 m |
| CLEARING_TUNING.vineCoilsM | 10, 12, 14, 16, 18, 20 | m | chosen here |
| CLEARING_TUNING.saplings / saplingDiamM / saplingHeightM / saplingsNearSpawn | 20 / 0.04-0.08 / 2.5-3.5 / 4 | count / m / m / count | chosen here |
| CLEARING_TUNING.boulders / boulderKg | 3 / 800 | count / kg | (AC-6 mass) |
| CLEARING_TUNING.throwingStones / throwingStoneKg | 25 / 0.5-3 | count / kg | chosen here |
| CLEARING_TUNING.weightStones / weightStoneKg / outcrops / outcropR | 15 / 8-40 / 3 / 4 | count / kg / count / m | chosen here |
| CLEARING_TUNING.flint / flintKg / flintNearSpawn | 10 / 0.3-1.0 / 2 | count / kg / count | chosen here |
| CLEARING_TUNING.dryBranches / branchDiamM / branchLenM / branchesNearSpawn / stickBlanks | 40 / 0.03-0.10 / 0.8-3.0 / 8 / 2 | count / m / m / count / count | chosen here |
| CLEARING_TUNING.dryLogs / logDiamM / logLenM | 5 / 0.25-0.40 / 3-5 | count / m / m | chosen here |
| CLEARING_TUNING.rottenBranches / rottenBranchSize | 20 / 2.5 m × 5 cm (2 kg) | count / m | D-24 |
| CLEARING_TUNING.rottenLogs / rottenLogSize | 2 / 2 m × 25 cm (40 kg) | count / m | D-24 |
| CLEARING_TUNING.grassBundles / grassKg | 30 / 1-3 | count / kg | chosen here |
| CLEARING_TUNING.snags / snagKg / snagPoints / snagSharpness | 4 / 80-120 / 3 / 0.45 | count / kg / count / — | AC-9 pace |
| CLEARING_TUNING.starterCacheAt | (2.5, 3.0) | m | chosen here |
| CLEARING_TUNING.apeHomes / apeHomeDistM / homeLoopR | 3 / 38, 62, 78 / 15 | count / m / m | chosen here |
| CLEARING_TUNING.routeWaypoints / routeRadiusM / routeCentre / routeMinSpawnDistM / lairR | 8 / 55 ± 8 / (0, 10) / 45 / 78 | count / m / m / m / m | chosen here |
| CLEARING_TUNING.floorAmpM / floorScalesM / flatInnerM / flatOuterM | 1.5 / 48, 16 / 15 / 25 | m | chosen here |
| CLEARING_TUNING.rimHeightM / rimRadiusM / rimWidthM | 18 / 82 ± 5 / 14 | m | chosen here |
| CLEARING_TUNING.ledgeDropM / ledgeLenM / ledgeCentre / ledgeTransitionM / ledgeFadeM | 6 / 30 / (40, −35) / 3 / 25 | m | 6 m: a chest landing does 43 HP to an ape (RR-16) |
| CLEARING_TUNING.coverBase / coverAmp / coverScaleM / coverGrovePenalty / coverTrunkClearM / coverSpawn / coverCellM | 0.55 / 0.45 / 30 / 0.4 / 3 / 0.4 / 2 | — / — / m / — / m / — / m | chosen here |
| CLEARING_TUNING.rejectionTries | 30 | tries | chosen here |
| VERB_TUNING.standOffM | 0.6 | m | chosen here |
| VERB_TUNING.handReachM | 1.3 | m from the chest | rule 3 (tie ≤ ~2.5 m up) |
| VERB_TUNING.anchorSurfaceTolM | 0.3 | m | chosen here |
| VERB_TUNING.twoHandCarryKg / twoHandCarryLenM | 10 / 1.5 | kg / m | chosen here |
| VERB_TUNING.takeFramesBase / takeFramesPerKg | 18 / 0.8 | ticks / ticks per kg | (DS pickup 18 + 7·heft is too slow for 40 kg) |
| VERB_TUNING.dropFrames / stowFrames / drawFrames | 12 / 30 / 24 | ticks | chosen here |
| VERB_TUNING.dragForceN | 600 | N | [B lab: drag.ts] |
| VERB_TUNING.dragLiftFrac | 0.5 | × weight | [B lab: drag.ts] |
| VERB_TUNING.tetherM | 1.6 | m | chosen here |
| VERB_TUNING.beltMaxKg / beltMaxLenM / backMaxKg | 4 / 0.6 / 40 | kg / m / kg | (SPEC:385-386 "small items", "one bundle") |
| VERB_TUNING.placeReachM / placeSupportM | 2.5 / 0.6 | m | chosen here |
| VERB_TUNING.placeFramesLying / placeFramesDriven | 24 / 60 | ticks | chosen here |
| VERB_TUNING.stakeAnchorDepthM | 0.3 | m | D-19 |
| VERB_TUNING.anchorHoldNPerM | 4,000 | N per m driven (1,200 N) | D-19 |
| VERB_TUNING.shapeStrokeFrames / shapeStep / knapStep / shapeHardnessMargin | 60 / 0.10 / 0.15 / 0.1 | ticks / sharpness / sharpness / hardness | D-9 (i) |
| VERB_TUNING.lashTouchM / lashRopeUseM / lashSnapMaxKg / spliceLossM | 0.15 / 1.0 / 3 / 0.5 | m / m / kg / m | chosen here |
| VERB_TUNING.lashFrames / tieFrames / untieFrames / spliceFrames | 90 / 60 / 60 / 60 | ticks | chosen here |
| VERB_TUNING.bendMaxDiamM / bendMaxForceN / bendMinDeg / bendFrames | 0.12 / 500 / 20 / 90 | m / N / ° / ticks | chosen here |
| VERB_TUNING.cutHardnessMargin / crossCutRestartM | 0.2 / 0.15 | hardness / m | D-9 (k) |
| VERB_TUNING.strikeMassKg | 6 | kg | strike push m_eff (§5.2) |
| VERB_TUNING.focusHeightM | 1 | m | chosen here |
| VERB_TUNING.handDigFrames / handDigDepthMul | 72 / 0.25 | ticks / × | D-9 (j), SPEC:241 "slow" |
| VERB_TUNING.heavyThrowSpeed | 12 | m/s | DS throwHeavy |
| VERB_TUNING.throwChargeS / throwMinFrac / throwSpinRadS | 0.6 / 0.5 / 1.5 | s / × / rad/s | chosen here |
| VERB_TUNING.pullYankN / pullYankTicks | 1200 / 9 | N / ticks | SPEC:237 "yank out a prop"; C F1 (492-1,277 N) |
| VERB_TUNING.pullHandSpeedMps / pullStaminaPerS / pullTiredMul | 1.5 / 0.15 / 0.6 | m/s / stamina/s / × | C §5 |
| VERB_TUNING.creaturePullMul / creatureHandSpeedMps | 1.5 / 0.8 | × pullForceN × scale² / m/s | C §5 (ape 907.5 N) |
| TOOL_TUNING.toolMaxKg / toolMinLenM / toolMaxLenM | 6 / 0.12 / 2.6 | kg / m / m | chosen here |
| TOOL_TUNING.minAspect / compactMaxAspect / headZoneM | 5 / 2.2 / 0.3 | — / — / m | chosen here |
| TOOL_TUNING.pointMinSharpness / edgeMinSharpness | 0.3 / 0.5 | sharpness | chosen here |
| TOOL_TUNING.twoHandMinLenM / spearMinLenM / cudgelMinKg / stoneMaxKg / digMinHardness | 1.1 / 1.6 / 1.5 / 3 / 0.4 | m / m / kg / kg / hardness | chosen here |
| TOOL_TUNING.stoneAxe {damageMul, cut, cleave, bite, tempo, choke} | 1.2, 0.7, 0.45, 10, 1.0, 0 | DS WeaponDef units | (machete analogue, SPEC:395) |
| TOOL_TUNING.longAxe {…} | 1.4, 0.9, 0.8, 14, 1.1, 0.4 | DS WeaponDef units | (fireaxe analogue) |
| TOOL_TUNING.spear {…} | 1.3, 0.85, 0, 8, 1.0, 0 | DS WeaponDef units | (gladius analogue, SPEC:394) |
| TOOL_TUNING.sharpStick {…} | 1.0, 0.4, 0, 4, 0.9, 0.1 | DS WeaponDef units | (bokken analogue, SPEC:393) |
| TOOL_TUNING.stick {…} | 1.0, 0, 0, 0, 0.9, 0 | DS WeaponDef units | (bokken) |
| TOOL_TUNING.cudgel {…} | 1.45, 0, 0, 0, 1.0, 0.12 | DS WeaponDef units | (bat analogue, SPEC:396) |
| TOOL_TUNING.stone {…} | 1.1, 0, 0, 0, 0.85, 0 | DS WeaponDef units | (SPEC:397) |
| TOOL_TUNING.flintBlade {…} | 1.2, 0.8, 0, 4, 0.8, 0 | DS WeaponDef units | (kunai analogue) |
| CREATURE_TUNING.shared.navQueriesPerTick | 4 | queries/tick | MAP recast §6 |
| CREATURE_TUNING.shared.crouchSightMul / coverSightMul / coverMin | 0.6 / 0.35 / 0.5 | × / × / cover | SPEC:754 |
| CREATURE_TUNING.shared.movingMinSpeed / peripheralDeg / peripheralMul | 0.5 / 20 / 0.5 | m/s / ° / × | chosen here |
| CREATURE_TUNING.shared.occluderMinKg / seenWithinS / awarenessCap | 100 / 1 / 1.5 | kg / s / — | chosen here |
| CREATURE_TUNING.shared.hurtByFighter / hurtByWorld | 1.5 / 0.9 | awareness | chosen here |
| CREATURE_TUNING.ape.sightConeDeg / sightRangeM / sightRangeStillM / hearingMul | 140 / 30 / 18 / 1.0 | ° / m / m / × | D-9 (c) |
| CREATURE_TUNING.ape.seenRate / heardGain / decayPerS | 2.5 / 0.6 / 0.12 | 1/s / — / 1/s | chosen here |
| CREATURE_TUNING.ape.investigateAt / chaseAt / chaseMemoryS | 0.25 / 1.0 / 8 | — / — / s | chosen here |
| CREATURE_TUNING.ape.gait wander / patrol / investigate / chase / flee / return | 0.35 / 0.45 / 0.6 / 1.0 / 1.0 / 0.6 | moveInput | chosen here |
| CREATURE_TUNING.ape.homeRadiusM / idleWanderS / idleS / loopRadiusM / lookAroundS | 8 / 6-14 / 20-40 / 15 / 3 | m / s / s / m / s | chosen here |
| CREATURE_TUNING.ape.fightEnterM / fightExitM / fightExitTicks | 4.5 / 8 / 60 | m / m / ticks | chosen here |
| CREATURE_TUNING.ape.fleeHpFrac / fleeChance / fleeS / fleeDistM / gloatS | 0.25 / 0.5 / 6-10 / 25 / 3 | — / — / s / m / s | chosen here |
| CREATURE_TUNING.ape.respawnS / respawnMinPlayerDistM / respawnRetryS | 300 / 40 / 10 | s / m / s | D-9 (q) |
| CREATURE_TUNING.ape.arriveM / repathMoveM / repathTicks / stuckMinM / stuckTicks | 0.6 / 1.5 / 30 / 0.3 / 90 | m / m / ticks / m / ticks | chosen here |
| CREATURE_TUNING.ape.sparringDistM / sparringRespawnS | 3 / 3.2 | m / s | D-50 (DS training cadence) |
| CREATURE_TUNING.giant.sightConeDeg / sightRangeM / sightRangeStillM / hearingMul | 120 / 60 / 35 / 1.2 | ° / m / m / × | D-9 (c) |
| CREATURE_TUNING.giant.seenRate / heardGain / decayPerS / investigateAt / chaseAt / chaseMemoryS | 1.5 / 0.5 / 0.08 / 0.3 / 1.0 / 10 | — | chosen here |
| CREATURE_TUNING.giant.speed patrol / investigate / chase / telegraph / charge / flee | 1.8 / 1.4 / 4.5 / 1.0 / 7.0 / 4.0 | m/s | D-9 (b) |
| CREATURE_TUNING.giant.turn patrol / chase / telegraph / charge | 30 / 45 / 70 / 8 | °/s | charge [B lab: charge.mjs] |
| CREATURE_TUNING.giant.accel patrol / chase / telegraph / charge; brake | 1 / 2 / 4 / 5; 4 | m/s² | chosen here |
| CREATURE_TUNING.giant.telegraphS / closeTelegraphS | 1.0 / 0.6 | s | D-9 (d), SPEC:787 |
| CREATURE_TUNING.giant.chargeMinM / chargeMaxM / chargeBearingDeg / closeChargeM / closeBearingDeg | 8 / 30 / 25 / 7 / 40 | m / m / ° / m / ° | chosen here |
| CREATURE_TUNING.giant.chargeMaxDistM / closeChargeDistM / passEndM | 35 / 9 / 6 | m | chosen here |
| CREATURE_TUNING.giant.blockedSpeed / blockedTicks / blockedGraceS | 1.5 / 15 / 0.5 | m/s / ticks / s | chosen here |
| CREATURE_TUNING.giant.chargeCooldownS / recoverS | 5 / 0.8 | s | chosen here |
| CREATURE_TUNING.giant.probeHeightFrac / probeRadiusM / probeMinMassKg / bankMaxRiseM / bankSampleM | 0.55 / 0.8 / 300 / 2.0 / 2 | × pelvis height / m / kg / m / m | chosen here |
| CREATURE_TUNING.giant.restS / sniffS / sniffDeg / investigateStopM / lairRestS / fleeSevereS | 20-40 / 3 / 45 / 4 / 30 / 20 | s / s / ° / m / s / s | chosen here |
| CREATURE_TUNING.giant.arriveM / repathMoveM / repathTicks / stuckMinM / stuckTicks | 2.5 / 4 / 60 / 0.8 / 120 | m / m / ticks / m / ticks | chosen here |
| CREATURE_TUNING.giant.limpSpeedMul / limpChargeMul / limpTelegraphMul / limpTurnMul | 0.6 / 0.7 / 1.3 / 0.8 | × | D-9 (u) |
| CREATURE_TUNING.giant.blindDeadDeg / blindApproachDeg | 15 / 25 | ° | D-9 (u) |
| CREATURE_TUNING.giant.weakJawRoarMul / windedCooldownMul / windedChaseMul / woundAwareness | 0.6 / 1.5 / 0.85 / 1.2 | × / × / × / awareness | chosen here |
| NOISE_TUNING.stepCrouch / stepWalk / stepRun / stepSprint | 2 / 6 / 12 / 20 | m (× scale) | SPEC:755 |
| NOISE_TUNING.hit / block / clang | 25 / 15 / 25 | m | chosen here |
| NOISE_TUNING.chop / dig / shape / stakeDriven | 40 / 15 / 10 / 20 | m | chosen here |
| NOISE_TUNING.throwLand / ropeSnap / breakNoise | 12 / 35 / 25 | m | chosen here |
| NOISE_TUNING.heavyLandBase / heavyLandPerKg / heavyLandMax | 10 / 0.15 / 120 | m / m per kg / m | SPEC:466 (a falling tree) |
| NOISE_TUNING.apeShout / giantRoar | 30 / 120 | m | chosen here |
| NOISE_TUNING.crouchNoiseMul | 0.3 | × | chosen here |
| GAME_TUNING.showNav / showSenses / showZones | false / false / false | — | dev views |
| LOOP_TUNING.treeFallHitstop / treeFallHitstopRangeM | 4 / 25 | frames / m | chosen here |
| CAMERA_TUNING.groundClearanceM | 0.3 | m | replaces arena containment |
| FOLLOW_TUNING.distance / minDistance / maxDistance / zoomStep | 4.2 / 2.2 / 7.5 / 0.4 | m | chosen here |
| FOLLOW_TUNING.lookHeight / shoulder / clearance | 1.55 / 0.55 / 0.35 | m (× scale for lookHeight) | chosen here |
| FOLLOW_TUNING.pitchDeg / minPitchDeg / maxPitchDeg | 14 / −25 / 65 | ° | chosen here |
| FOLLOW_TUNING.mouseSens / stickSens / follow | 0.0022 / 2.6 / 9 | rad/px / rad/s / 1/s | chosen here |
| FOLLOW_TUNING.boomSamples | 8 | samples | chosen here |
| FOLLOW_TUNING.rulerPullbackPerScale / rulerRangeM / rulerPitchDeg | 0.8 / 35 / 8 | m per scale / m / ° | MAP client §4 |
| FOLLOW_TUNING.blendS | 0.45 | s | chosen here |
| FOLLOW_TUNING.aimDistance / aimShoulder / aimFovMul | 2.4 / 0.75 / 0.85 | m / m / × | chosen here |
| KILLCAM_TUNING.cooldownS | 4 | s per moment kind | chosen here |
| KILLCAM_TUNING.worldWound {…, dolly} | 3.3·scale, −0.15·scale, −0.12, 42, 2.4, 0.25, 4.5; dolly −0.35 | m, m, rad, °, s, ×, — | (DS boss-intro framing, MAP client §3.3) |
| KILLCAM_TUNING.rulerDeath {…} | 4·scale, 0.3·scale, 0.1, 40, 4.0, 0.2, 6 | m, m, rad, °, s, ×, — | chosen here |
| KILLCAM_TUNING.playerByRuler {…} | 7, 2.5, 0.2, 44, 2.6, 0.3, 5.5 | m, m, rad, °, s, ×, — | chosen here |
| VERB_UI_TUNING.targetConeDeg / fightTargetConeDeg | 28 / 50 | ° | chosen here |
| VERB_UI_TUNING.radialDeadPx / secondTimeoutS / wheelStepDeg / padRotateDegS | 28 / 10 / 15 / 90 | px / s / ° / °/s | D-48 |
| VERB_UI_TUNING.arcPoints / highlightScale | 48 / 1.04 | points / × | chosen here |
| VERB_UI_TUNING.markerRangeM / compassPingS / compassSeeRangeM | 60 / 30 / 120 | m / s / m | chosen here |
| RENDER_TUNING.nearTileM / nearSpacing / farSpacing / lodHysteresisM | 40 / 0.25 / 0.5 / 5 | m | chosen here |
| RENDER_TUNING.grassRadiusM / grassPerCell | 60 / 3 | m / tufts | chosen here |
| RENDER_TUNING.fogNear / fogFar / cameraFar | 70 / 190 / 600 | m | chosen here |
| RENDER_TUNING.shadowExtentM / shadowFarM / shadowMap | 40 / 120 / 2048 | m / m / px | chosen here |
| RENDER_TUNING.chopShudderDeg / chopShudderS / creakBelowRemaining | 0.6 / 0.25 / 0.3 | ° / s / fraction | SPEC:581 |
| RENDER_TUNING.strainShowFrac / integrityCrack / integritySag | 0.6 / 0.6 / 0.3 | fraction | rule 3, SPEC:362 |
| RENDER_TUNING.ropeThinMax / ropeFrayFrac | 0.3 / 0.8 | fraction | SPEC:357-358 |
| PRESENTATION_TUNING.maxRagdolls / mirrorRadiusM | 8 / 30 | ragdolls / m | SPEC:655-656 (ragdoll LOD) |
| RAGDOLL_TUNING.downRootGain | 0.15 | fraction per step | down-follow toward the sim slab |
| FEEL_TUNING.giantShakeRadiusPerScale / giantShakePerScale | 6 / 0.05 | m per scale / trauma per scale | SPEC:849 |
| FEEL_TUNING.ambienceQuietRangeM / creakFrom | 40 / 0.5 | m / strain | SPEC:851, 357 |

Added in revision 2 (every one is also a §9.1 row):

| Table.key | Value | Unit | Why |
|---|---|---|---|
| DAMAGE_TUNING.zoneGraceTicks | 2 | ticks | contacts starting this soon after a pose jump are never scored (RF-1) |
| MOVE_TUNING.jumpBufferFrames | 6 | ticks | the jump press buffer, was a bare constant (RR-7) |
| IMPACT_TUNING.creatureRestitution | 0 | — | off-by-default rule-9 lever (RR-6) |
| IMPACT_TUNING.unbackedTargetMassRatio | Infinity (off) | × | off-by-default SPEC:417 lever (RR-6) |
| IMPACT_TUNING.partsRingR / partsDropH | 0.6 / 0.3 | m × scale / m | were bare constants (RR-7) |
| WORLD_TUNING.corpseDespawnMinDistM | 40 | m | corpses vanish only away from the player (RR-11) |
| TERRAIN_TUNING.spoilSetbackM | 1.5 | m | spoil never refills dug ground (RT-2) |
| MATERIALS.*.armourJ (other than hide, bone) | 0 | J | no spec value (RR-3) |
| RULER_TUNING.separateSkipSpeed | 1.0 | m/s | a charge is a contact, not a push (RF-5) |
| RULER_BODY_TUNING.stepUpMaxM | 1.0 | m per tick | the ruler nav layer's climb (RR-1) |
| RULER_BODY_TUNING.maxSlopeDeg | 40 | ° | the ruler nav layer's slope (RR-1) |
| RULER_BODY_TUNING.climbRateMps / climbWalkMps / climbMaxM | 0.4 / 0.5 / 4.5 | m/s / m/s / m | climbing out of a pit (RR-1) |
| RULER_BODY_TUNING.pitDownDepthFrac | 0.5 | × knee height | "in a pit" (RR-1) |
| RULER_BODY_TUNING.coverTripWindowTicks | 30 | ticks | a weight-triggered fall reads as `'cover'` (RT-1) |
| CHARACTER_TUNING.crouchHeightFrac | 0.7 | × capsule height | a crouched ape fits under a deadfall (RT-4) |
| BREAK_TUNING.pieceGraceMaxTicks | 600 | ticks | the longest a piece may stay inside its breaker (RF-7) |
| LOAD_TUNING.spanGapM | 0.1 | m | only spanning entities are load-tested (I-1) |
| VERB_TUNING.faceTurnRate | 0.12 | per tick | was a bare constant (RR-7) |
| VERB_TUNING.dragKp / dragKd / dragHandOffsetM | 3,000 / 300 / 0.8 | N/m / N·s/m / m | were bare constants [B lab: drag.ts] (RR-7) |
| VERB_TUNING.liftKp / liftKd / liftHandM | 2,000 / 200 / 0.9 | N/m / N·s/m / m | were bare constants [B lab: drag.ts] (RR-7) |
| VERB_TUNING.placeReachVertM / placeShrinkM / placeDropM | 1.5 / 0.02 / 0.02 | m | were bare constants (RR-7) |
| VERB_TUNING.lashSnapM | 0.4 | m | was a bare constant (RR-7) |
| VERB_TUNING.haulTautM / haulRampMps | 0.05 / 0.2 | m / m/s | the haul model (I-2) |
| TOOL_TUNING.lengthTrimM / pointHeadM / edgeHeadFrac / radiusMinM / radiusMaxM / haftMarginM | 0.08 / 0.15 / 0.15 / 0.03 / 0.08 / 0.02 | m / m / × length / m / m / m | were bare constants (RR-7) |
| TOOL_TUNING.refSharpness | 0.9 edged; 0.6 points | sharpness | the head's material enters melee numbers (RR-13) |
| TOOL_TUNING.pointTaperRadii | 5 | × radius | a shaped end is a real point (RF-18) |
| CREATURE_TUNING.shared.sightRayTolM / repathCheckTicks / stuckAskSpeed / maxPathFailures | 0.3 / 15 / 0.5 / 3 | m / ticks / m/s / count | were bare constants (RR-7) |
| CREATURE_TUNING.ape.lookAroundDeg | 60 | ° | was a bare constant (RR-7) |
| CREATURE_TUNING.giant.cornerMinFrac | 0.35 | × speed | was a bare constant (RR-7) |
| RENDER_TUNING.fallenCrownPadM | 0.15 | m | a fallen crown never shows a contact the sim didn't score (RR-15) |

### 9.3 Starting values owned by later milestones, and DS constants M1 keeps as code

Listed so nothing is lost (MAP/spec-m1.md §(b) B.3-B.8); each becomes a registered tuning key in the milestone whose
code reads it. None is read by M1 code.

| Value | Starting value | Unit | Source | Milestone |
|---|---|---|---|---|
| Fire damage, human | 8 | HP/s × species fire resistance | SPEC:318 | M2 |
| Burning rope fuse speed | 5 | cm/s | SPEC:261 (already `JOINT_TUNING.burnSpeedMps`, unused) | M2 |
| Mud threshold / mud trip | moisture > 0.7 / sunk past 40 % of leg length | — | SPEC:225, 329, 782 | M2 |
| Vine rope decay | 2 %/h, × 2 when wet | strength per hour of play | SPEC:346 | M2 |
| Loose-debris removal | untouched 5 h of play and > 200 m away | — | SPEC:346 | M2/M3 |
| Land cell | 32 × 32 | m | SPEC:84 | M3 |
| Time-away cap; autosave | 8 h; 60 s | h; s | SPEC:108, 727 | M3 |
| Day/night; rain | 40 min (30 day, 10 night); one 3-8 min shower per in-game day | min | SPEC:103-104 | M2/M3 |
| Beacon, hold, raids, ruler push, regrowth | SPEC:491-498 values | — | SPEC:491-498 | M3 |
| Trapline resolution | every 5 min beyond 150 m | min / m | SPEC:542 | M4 |
| Rare variant | 1 in 500 mid-size spawns | — | SPEC:161 | M4 |
| Adaptation memory | 2 h of play, fading | h | SPEC:785 | M4 |
| Performance tiers | active 40 m, frozen 150 m, 600 active bodies, sim step < 5 ms, fire grid 60 m | m / bodies / ms | SPEC:797-819 | M4 (profiled); P38 smoke-checks the 5 ms |
| Alerts | at most 1 per minute | — | SPEC:597 | M5 |
| Downed bleed-out | 30 | s | SPEC:424 | multiplayer (don't build) |
| `BLEED_DPS` | 1.1 | HP/s per bleed unit | SPEC:286; combat.ts:118 | DS constant, unchanged (not a spec starting value) |
| `ENEMY_MIN_STARTUP` | 15 | frames | SPEC:743; fighter.ts | DS constant, unchanged |
| Human run | 2.6 × 1.45 = 3.77 | m/s | SPEC:370; DS `walkSpeed`, motion.ts | DS stat, unchanged |
| Brute hide toughness | 300 | J | SPEC:288 | M4 (RR-25) |
| World size; territories | about 3 km × 3 km (4 × 4 km multiplayer); 6 territories about 1 km across (8-12 multiplayer) | km; count | SPEC:81-83 | M3/M6 (RR-25) |
| Regrowth | saplings within an hour of play, small trees within a few hours, in Wild cells | h | SPEC:112 | M3 (RR-25) |
| Snow slabs and avalanches | slopes > 30°; 20-60 chunk bodies | °; bodies | SPEC:334-335 | M4+ (RR-25) |
| Taming a world | 15-25 h of play (open question SPEC:983: tuned by ruler HP and territory count) | h | SPEC:509, 983 | M6 (RR-25) |
| Contested reverts | unvisited 3 h of play | h | SPEC:498 | M3 |
| Wound adaptation, beacon burn, raid hold loss | 2 h fading; 2 h per 4 logs; −20 hold | — | SPEC:491-497, 785 | M3/M4 |

**DS constants rule 5 rests on** (RR-24; kept as DS code, unchanged; a change to any of them must re-run P11's
best-paced unit test and AC-4, because the free ruler stays at full health only while the best-paced axe stays below
30 HP/s, 18.77-18.91 HP/s today):

| Constant | Value | Where |
|---|---|---|
| Move stamina cost | light 0.035, medium 0.055, heavy 0.085; × weapon lift (0.8 + 0.15 × heft); × 0.8 for a counter | `Fighter.startMove`, fighter.ts:448-450 |
| Stamina regen | +0.085/s free and not running, +0.03/s busy, 0 while attacking, −0.035/s × run when running; × hurt (0.5 + 0.5·hp/maxHp) × burden (1 − min(0.5, 0.06·heft)) | `CombatSim.tickTimers`, combat.ts:362-368 |
| Tired tempo | × (1 + 0.6 × (1 − stamina)) | `Fighter.startMove`, fighter.ts:442 |
| Swing behind the blow | damage × (0.5 + 0.5 × swingStamina) | `CombatSim.hit`, combat.ts:1126 |

## 10. Client (`apps/client/src`)

### 10.1 Structure

The client boots a `World`, steps it from a `GameLoop`, and presents it. It never writes fighter or entity state
(rule 6): every input becomes a command pushed to `world.commands`, every time effect lives in the loop (rule 8).
P31 creates `game.ts` with every call into the other client modules already in place, and `game/ports.ts` with the
interface of every module `game.ts` calls, the **changed DS modules included** (RF-9). Each later package implements
its port in its own files (an adapter class next to the DS module it changes), so P32-P37 never edit `game.ts`:

```ts
// apps/client/src/game/ports.ts (P31). Every method game.ts calls, and nothing else.
export interface WorldViewsPort {        // P32: render/terrainView, forestView, entityViews, ropeView, grassView, sky
  sync(world: World, alpha: number, cam: Vector3): void; fighterView(f: Fighter): FighterViewPort;
  dispose(): void }
export interface FighterViewPort {       // P32: render/fighterView.ts (changed DS)
  syncFromRig(f: Fighter): void; setHeld(entity: number | null, world: World): void;
  scar(bone: BoneName, local: V3, kind: 'scar' | 'gash' | 'eye'): void; setGore(level: GoreLevel): void }
export interface PresentationPort {      // P33: game/presentationWorld.ts + body/ragdoll.ts (changed DS)
  step(world: World): void; onLaunch(f: Fighter, vel: V3, angVel: V3): void; pelvisOf(f: Fighter): () => Vector3;
  snapTo(f: Fighter): void; dispose(): void }
export interface CameraPort {            // P34: render/cameraDirector, followCam, cameraRig (changed DS), cutout (changed DS)
  update(dt: number, world: World, player: Fighter | null, lockTarget: Fighter | null, look: { dx: number; dy: number }): void;
  moveBasis(): { forward: Vector3; right: Vector3 }; shake(trauma: number): void; snapBehind(f: Fighter): void;
  cutoutFocus(p: Vector3): void; readonly camera: PerspectiveCamera }
export interface CinematicsPort {        // P34: render/cinematics.ts (changed DS: ground floor, terrain line of sight)
  play(shot: Shot): boolean; update(dt: number): void; readonly active: boolean; readonly timeScale: number;
  setGround(ground: (x: number, z: number) => number): void; setBlocked(blocked: (a: Vector3, b: Vector3) => boolean): void }
export interface VerbInputPort {         // P35: input/verbInput.ts (P31's stub: today's move/button code)
  commands(inp: InputFrame, tick: number): Command[]; readonly mode: UiMode }
export interface KillCamPort { onMoment(m: Moment): boolean; mark(m: Moment): void }        // P36: game/killcam.ts
export interface MomentsPort { fromStep(r: StepResult): Moment[] }                          // P36: game/moments.ts
export interface HudPort {               // P36: ui/hud.ts (changed DS), ui/compass.ts, render/markers.ts
  update(world: World, player: Fighter | null, dt: number): void; mood(m: '' | 'death'): void;
  deathBanner(secondsLeft: number | null): void; popup(text: string): void }
export interface SfxPort {               // P37: feel/audio.ts (changed DS)
  handle(e: CombatEvent | WorldEvent, world: World): void; setListener(p: Vector3): void; ambience(world: World): void }
export interface PanelPort { refresh(world: World): void; readonly visible: boolean }   // P37: debug/panel.ts (rewritten)
export type GoreLevel = 'off' | 'stylised' | 'full';   // rule 12; the M5 setting; M1 reads prefs.gore ('full') in one place
```

P31's stubs implement every port with today's DS behaviour where one exists (the DS `CameraRig`, `Cinematics`,
`FighterView` wrapped as adapters) and no-ops elsewhere, so `npm run dev` runs from P31's merge on.

```ts
// apps/client/src/game/game.ts (P31)
export class Game {
  static create(world: World, canvas: HTMLCanvasElement, ports: GamePorts): Game;   // GamePorts: one of each port
  readonly views: WorldViewsPort;        // render/*View.ts (P32): sync(world, alpha), fighters, entities, ropes, terrain
  readonly presentation: PresentationPort;   // P33
  readonly cams: CameraPort;             // P34
  readonly cine: CinematicsPort;         // P34
  readonly verbInput: VerbInputPort;     // P35 (P31's stub: today's move/button command code, moved out of game.ts)
  readonly killCam: KillCamPort;         // P36
  readonly moments: MomentsPort;         // P36
  readonly hud: HudPort;                 // P36
  readonly sfx: SfxPort;                 // P37
  readonly panel: PanelPort;             // P37
  present(r: StepResult, loop: GameLoop): void;   // DS handleEvent cases kept (hit, block, dodge, swing, throw, thud, clang,
                                                  // bleedout, getup) + world events; moments → killCam.onMoment
  freezeFrame(): void;                   // hit-pause visuals (DS)
  render(realDt: number, gameDt: number, alpha: number): void;
  onSave(bytes: Uint8Array): void;       // M1: dev download; M3: the save worker
}
```

### 10.2 The game loop (rule 8: every time effect lives here; `game/loop.ts`, P31)

```ts
export const LOOP_TUNING = { maxStepsPerFrame: 6, slowmoScale: 0.25, parrySlowmoS: 0.35, dismemberSlowmoS: 0.6,
  playerKoSlowmoS: 1.5, treeFallHitstop: 4, treeFallHitstopRangeM: 25 };
export class GameLoop {
  hitstop = 0;            // sim steps to swallow (hit-pause)
  slowmo = 0;             // real seconds at slowmoScale
  constructor(readonly world: World, readonly game: Game, readonly input: Input, readonly cine: Cinematics);
  frame(realDt: number): void {
    const inp = this.input.poll();
    if (!this.blocked) for (const c of this.game.verbInput.commands(inp, this.world.tick + 1)) this.world.commands.push(c);
    if (!GAME_TUNING.paused) this.tickTimers(realDt);              // slowmo −= dt; cine.update(dt); HUD timers
    let scale = GAME_TUNING.timeScale * (this.cine.active ? this.cine.timeScale : this.slowmo > 0 ? LOOP_TUNING.slowmoScale : 1);
    if (GAME_TUNING.paused) scale = 0;
    if (this.stepOnce) { this.stepOnce = false; this.fixedStep(); }
    if (this.cine.active && this.hitstop > 0) this.hitstop = 0;  // a cut is already the slow beat (DS)
    this.accum += realDt * scale;
    let steps = 0;
    while (this.accum >= DT && steps < LOOP_TUNING.maxStepsPerFrame) { this.fixedStep(); this.accum -= DT; steps++; }
    if (steps === LOOP_TUNING.maxStepsPerFrame) this.accum = 0;
    const frozen = this.hitstop > 0 || scale === 0;
    this.game.render(realDt, frozen ? 0 : realDt * scale, frozen ? 1 : this.accum / DT);
  }
  private fixedStep(): void {
    if (this.hitstop > 0) { this.hitstop--; this.game.freezeFrame(); return; }   // the sim doesn't step
    const r = this.world.step();
    this.game.present(r, this);                  // may raise hitstop / slowmo / call killCam.onMoment
    this.game.presentation.step(this.world);     // ragdolls follow the sim; the presentation Rapier world steps
    if (r.save) this.game.onSave(r.save);
  }
  requestStep(): void; advance(n: number): void; // dev (DS requestStep/advance)
}
```

- The same structure as DS's `frame`/`fixedStep` (game.ts:620-780) minus the rule-6 write-back (game.ts:775:
  `pelvisPos` → `f.pos` and `walkable.resolve`) and minus `new CombatSim(Date.now())` / `externalKnockdown`
  (game.ts:180-181), `roundRng` (game.ts:104) and the ThemeView seed (game.ts:428). The sim never reads `timeScale`,
  `slowmo`, `hitstop` or the cinematic scale.
- Pause: menus, dev P, and a hidden tab (`visibilitychange` → paused; SPEC:108). Input is not turned into commands while
  paused or in a menu (`blocked`, DS).
- Hit-pause and slow-motion values are DS's (`m.hitstop × hitstopMul …`, game.ts:798; perfect parry 0.35 s, dismember
  0.6 s, player KO 1.5 s); world events add: a felled tree landing within 25 m of the camera → hitstop 4; an
  environmental kill and a world wound on the ruler → their kill cams (which carry their own slow).

### 10.3 The kill cam: one function that receives the moment (SPEC:583-588, rule 8; `game/killcam.ts`, `moments.ts`, P36)

```ts
export type MomentKind = 'envKill' | 'worldWound' | 'rulerDeath' | 'playerByRuler' | 'playerDeath' | 'skullSplit';
export interface Moment {
  kind: MomentKind; tick: number;
  subject: Fighter;               // the victim, the wounded ruler, or the flung player
  point: Vector3; dir: Vector3;   // impact point and direction (world)
  causeEntity: number | null;     // the log, stake, trunk… (the shot's side; the journal later)
  severity: number;               // 0..1 (the hit's HP fraction, or 1 for a death)
}
export class KillCam {
  constructor(cut: (s: Shot) => boolean, views: { pelvisOf(f: Fighter): () => Vector3; ground(x: number, z: number): number;
    across(a: Vector3, b: Vector3, toward?: number): Vector3 });
  /** Every kill cam goes through here. Multiplayer later turns this body into a replay request (SPEC:744). */
  onMoment(m: Moment): boolean;   // false when suppressed (cooldown, a higher-priority cut running): it still mark()s
  mark(m: Moment): void;          // a saved moment mark (the recorder's moment list; the M5 clip button and SPEC:933)
}
export class MomentBuilder { fromStep(r: StepResult): Moment[] }    // in event order
```

| Moment | From (§2.13 events) | Shot (`KILLCAM_TUNING`) |
|---|---|---|
| `envKill` (the M1 gate, SPEC:869) | CombatEvent `ko` with `environmental: true` and a non-ruler victim | DS's finishing shot (game.ts `onKO`): focus the victim's pelvis (ragdoll, floored at ground + 0.35·scale), side `across(cause point, victim, 0.1)`, distance 3.8·max(1, 0.75·scale), height 0.55, orbit 0.3, fov 38, 2.2 s, slow 0.18, priority 4 |
| `worldWound` | WorldEvent `wound` with `byWorld` | focus the wound point, distance 3.3·scale, height −0.15·scale, orbit −0.12, dolly −0.35, fov 42, 2.4 s, slow 0.25, priority 4.5 |
| `rulerDeath` | CombatEvent `ko` with `victim.ruler` | focus its chest, distance 4·scale, height 0.3·scale, orbit 0.1, fov 40, 4.0 s, slow 0.2, priority 6 |
| `playerByRuler` (rule 9) | WorldEvent `impact` on the player with `launched` and `cause.fighterId` a ruler; or the player's `death` whose `lastKnock.by` is a ruler | focus the player's pelvis (following the flying slab), side ⟂ the launch velocity, distance 7, height 2.5, orbit 0.2, fov 44, 2.6 s, slow 0.3, priority 5.5 (beats DS's death cam, 5) |
| `playerDeath` | CombatEvent `ko` on the player not covered by `playerByRuler` | DS's death cam (game.ts death cut), priority 5 |
| `skullSplit` | CombatEvent `hit` with DS's crown-split | DS's skull cut, priority 4.5 |

Rules: one cut per kind per 4 s; a moment that doesn't get a cut (cooldown, or a higher-priority cut running) is still
`mark()`ed as a saved moment, so every trigger produces a kill cam or a saved moment (SPEC:933) (RR-14).
`Cinematics.play` keeps its priority ladder (death 5, skull 4.5, finisher 4); all six kinds are wired (D-32), only
`envKill` is gated in M1. DS's death and skull cuts now go through `onMoment` as `playerDeath` and `skullSplit`, so
nothing but `onMoment` starts a kill cam (a grep test in P36: `cine.play(` appears only in `killcam.ts`) (RR-14). A
ruler tripped by the world and wounded by the terrain it fell onto produces a `worldWound` (the wound's `byWorld`,
§4.6).

### 10.4 Rendering the Clearing (P32)

| What | How | Readability (rule 3, SPEC:351-362) |
|---|---|---|
| Terrain (`terrainView`) | one flat-shaded `MeshStandardMaterial` mesh per 25 m tile from `world.terrain.heights`; tiles within 40 m of the camera at 0.25 m, others at 0.5 m (hysteresis 5 m); rebuilt when the tile's `version` changes | vertex colours: grass green, pale where cover ≥ 0.6, dirt brown where dug (h < original − 0.05), grey rock above 35° |
| Trees (`forestView`) | `InstancedMesh` for standing trunks (unit 8-gon prism, like the collider), one for canopies (3 faceted blobs), two for saplings; through `applyCutout` | a tree leaving `standing` gets its own mesh with a **notch wedge** cut to `1 − remaining` of its diameter on the cut side; it shudders 0.6° for 0.25 s on each `chop`, sheds leaf particles, creaks below 30 % remaining; once falling or felled its crown is drawn collapsed, within the trunk radius + `fallenCrownPadM` over the top third (rule 3: no crown visibly passes through a body the sim doesn't hit; TODO "canopy collision (rule 3)", RR-15) |
| Entities (`entityViews`) | per (look, shape prototype) `InstancedMesh`: unit hex prism (logs), unit 8-gon prism (sticks, stakes, branches), 4 stone hulls, flint, grass bundle, dirt pile, coil, hide, bone; non-uniform instance scale; matrices interpolated `prevPose → pose` by alpha; held and stowed items at the hand, belt, back | colour by material (green wood, pale dry wood, dark spongy rotten wood, glossy dark flint); a pale cone at every sharp point sized by sharpness (shaped ends are pointed hulls, §5.4); a **cross-cut notch** wedge at `crossCut.axisT`, `1 − remaining` deep on the `fromDir` side (RR-15); integrity < 0.6 darkens and cracks, < 0.3 sags; a load average above 60 % of capacity bends and creaks the entity (a thin prop shows it won't hold; TODO "prop strain readability") |
| Ropes (`ropeView`) | per `world.joints.view()` entry a 6-sided tube between its anchors; slack ropes sag (8-segment parabola); held ends at the hand; loose ends lie on the ground | taut → straight and thinner (radius × (1 − 0.3·strain)); strain > 0.8 → fuzzy jitter and a reddish tint; creak ∝ strain² above 0.5 |
| Ground cover (`grassView`) | one `InstancedMesh` of crossed-quad tufts from the cover grid within 60 m, ≤ 3 per cell | dry grass pale; dug cells bare |
| Sky (`sky`) | hemisphere + sun; sun and shadow camera follow the player, snapped to texels, ±40 m, far 120 m; fog 70-190 m; camera far planes 600 m | — |
| Fighters | DS `FighterView`; apes: dark-fur palette with a snout, `setScale(1.1)`; the giant: darker, silver back, `setScale(5.5)` | ruler wounds drawn where they are (`scar(bone, local, kind)`: scar, gash, missing eye; SPEC:845); every new gore-bearing visual of M1 (gashes, blood on world impacts) reads one `prefs.gore` value (`GoreLevel`, default `'full'`; the setting itself is M5, rule 12, RR-22) |

Budget estimate (checked at M4, SPEC:799-803): ~25 terrain tiles, 4 forest, ≈ 12 entity instancers + ≤ 10 individual
meshes, 1 grass, ≤ 20 ropes, 5 fighters × 23 ≈ 115 → about 190 draw calls before shadows.

### 10.5 The presentation physics world and ragdolls (rule 6; P33)

```ts
export class PresentationWorld {
  readonly rapier: RAPIER.World;                  // gravity −9.81, timestep DT; never read by the sim
  constructor(R: typeof RAPIER, world: World);
  syncStatic(world: World): void;                 // terrain tiles as heightfields (re-shaped on version change); fixed and anchored entities
  syncDynamic(world: World, cam: Vector3): void;  // dynamic entities within mirrorRadiusM (30 m) of the camera as kinematic colliders
  attachRagdoll(f: Fighter): Ragdoll | null;      // ≤ maxRagdolls (8) nearest the camera; never the giant
  step(world: World): void;                       // drive ragdolls (standing: toward f.rig as DS; down: toward the sim slab), step
}
```

- **Downed bodies follow the sim** (SPEC:378, 652): while a fighter is in knockdown or ko, the ragdoll root gets a weak
  drive (`RAGDOLL_TUNING.downRootGain` 0.15, replacing DS's 0) toward `world.downed.pose(f.id)`, so the visible body
  lies where the sim's body lies; the launch comes from the sim's `launch` event (replacing DS's presentation-computed
  launch). Nothing in the client writes `f.pos`.
- The giant has no ragdoll: `FighterView.syncFromRig` shows its rig, which is the kinematic body standing and the dynamic
  compound body tripped, so what you see is exactly what the sim hits.
- `usedSlots` (ragdoll.ts:17) moves into `PresentationWorld` (D-42) and slots are recycled on dispose.
- Cosmetic debris (wood chips, dust) are particles, not bodies, in M1.

### 10.6 Cameras (P34)

- **Follow camera** (`followCam.ts`, out of fights; SPEC:35): owns yaw and pitch; mouse under pointer lock × 0.0022
  rad/px, right stick × 2.6 rad/s, wheel zoom 2.2-7.5 m; looks at the player's chest (ground + 1.55·scale) from 4.2 m
  back, 0.55 m to the right; pitch −25° to 65°. The boom is tested against the terrain at 8 samples and kept ≥ ground +
  0.35 m; trunks between camera and player dissolve through the cutout (focus y = ground + 1, replacing `cutFocus.y =
  1`). When the giant is within 35 m and has been on screen, the boom lengthens by 0.8 m per scale unit × proximity and
  pitches up 8° so its head stays in frame (MAP client §4). Aim mode (X held): 2.4 m, shoulder 0.75 m, fov × 0.85.
- **Fight camera**: DS `CameraRig` when the player is locked on (target alive and within 9 m centre to centre): the
  three-quarter view (SPEC:35, 637). Heights become relative to the ground under the focus; arena containment
  (`inside`) becomes "camera above terrain + 0.3 m".
- **Director** (`cameraDirector.ts`): blends follow ↔ fight over 0.45 s (smoothstep on position, quaternion, fov); on
  leaving a fight the follow camera starts from the fight camera's yaw and pitch. Kill cams override both. The movement
  basis for `move` commands is the active camera's ground forward/right.
- **Cinematics**: the floor clamp becomes `max(ground(x, z) + 0.15, …)` with `ground` defaulting to `() => 0`
  (`cinematics.test.ts` keeps passing); `blocked` uses `world.queries.castRay` (read-only) against terrain and trunks
  instead of `walkable`; far plane 600 m.

### 10.7 The verb UI (SPEC:402-413; P35)

```ts
export type UiMode = 'idle' | 'radial' | 'second' | 'throwAim' | 'place';
export type TargetRef = { kind: 'entity'; id: number; at: Vector3 } | { kind: 'ground'; at: Vector3 };
export class VerbInput {
  mode: UiMode; target: TargetRef | null; first: TargetRef | null;   // `first` during the second-target step
  /** Turns one input frame into this frame's commands for `tick`; the only producer of commands in the client. */
  commands(inp: InputFrame, tick: number): Command[];
}
export interface InputFrame {
  moveX: number; moveY: number; presses: Button[]; pickup: boolean; keys: string[];
  held: ReadonlySet<Action>; released: Action[];        // holds and releases (V, X, C, Shift, punches for pull)
  look: { dx: number; dy: number };                     // pointer-locked mouse + right stick
  wheel: number; clicks: { button: 0 | 2; down: boolean }[];   // modes consume clicks before they become punches
  pad: { lb: boolean; rb: boolean; a: boolean; b: boolean; y: boolean; dpad: number; rx: number; ry: number } | null;
}
```

- **Targeting** (`targeting.ts`; SPEC:406): candidates are entity views whose surface (shape OBB / capsule / ball from
  the view's pose) is within 2.5 m of the player's chest, plus rope views as capsules; the best is the smallest angle
  between the camera's centre ray (follow camera; the player's facing in the fight camera) and the direction to its
  nearest surface point, inside 28° (50° in the fight camera). **Tab** / Shift+Tab / D-pad ←→ cycle the candidates in
  score order (the index kept while the set is unchanged). No entity, and the centre ray meets the terrain within 2.5 m →
  a ground target (dig, place). Excluded: what you hold or carry. On every change the client sends `{ verb: 'focus',
  target, at }`. The client computes this from what it draws; the sim re-validates every command.
- **Highlight** (`highlight.ts`): an emissive back-face shell (scale 1.04); a second colour for the first target of a
  two-target verb; a world-anchored prompt (`G take · V verbs`, `G drag (120 kg)`, `too heavy (300 kg)`, `G take the
  end`).
- **Hold V** → `radial` (`ui/radial.ts`): up to 8 sectors from `verbsFor(world, player, target)` (imported from
  `@wild/sim`, read-only), disabled ones greyed with their reason; a virtual cursor with a 28 px dead zone; release on a
  sector executes it; camera orbit frozen while open; the sim keeps running.
- **Lash / bend** → `second`: highlight a second target valid for the verb; LMB or E confirms (one `verb` with
  `target`, `second`, `at`, `at2` = the aim hit points), RMB or Esc cancels; 10 s timeout (D-48).
- **Hold X** → `throwAim`: the aim camera, an arc (`aimArc.ts`, 48 points of the sim's formula `v = launchSpeed(m,
  techSpeed) × charge`, g 9.81) and a landing ring; charge 0.5 → 1 over `VERB_TUNING.throwChargeS` (0.6 s); release →
  `throw`; LMB while held cancels.
- **Hold C** → `place` (carrying or wielding): a translucent ghost (`ghost.ts`) at the aim point within 2.5 m; wheel
  rotates 15° a notch; RMB cycles lying / upright / sloped; **sloped** leans the ghost from its lower end on the ground
  onto the highest support under its upper half (a prop's top, a rock), and the command carries the pitch that cast
  gives (§5.7); green when the client's estimate (support, no overlap) fits, red otherwise; LMB → `place`; releasing C
  cancels. A refused verb's `{ type: 'verb', ok: false, reason }` shows as a HUD
  popup.
- **Rope end in hand**: Q/E/LMB down → `pull` on, up → off.
- In `radial`, `second`, `throwAim` and `place` the left click is consumed by the mode, never a punch (MAP client §2.4).

### 10.8 HUD, death and respawn (SPEC:419-423, 853; P36)

Minimal HUD (`hud.ts`; DS's combat cues stay off by default, `DEFAULT_PREFS.cues = false`, realism.test.ts:77):
health and stamina bars (DS), the guard bar only while locked on; a **hands strip** (bottom left: the held thing's name,
mass and mode, a two-handed mark, belt slots 1-3 and back slot 4 with key labels); a **compass** (`compass.ts`, top
centre: a 180° strip with N/E/S/W, a ping for the spawn point, and a ping where the player last saw the giant (inside the
frustum, within 120 m, clear terrain line), fading after 30 s); a **target bar** while locked on (an ape's name and HP;
the giant's HP bar with its wounds as notches, severe ones larger); **awareness markers** (`markers.ts`, `?`/`!` within
60 m from `world.minds.view(f)`). The training `.wave` label goes.

Death and respawn: on the player's `ko`, DS's death beat (sfx, camera trauma, slow motion 1.5 s, the KO cut at priority
5 unless `playerByRuler` took the camera, `hud.mood('death')`); the `death { respawnTick }` event starts a banner "DOWN —
back in N s" counted from `(respawnTick − world.tick)/60` (sim time, so it slows in slow motion); on `respawn`:
`mood('')`, banner hidden, the camera snapped behind the player, the ragdoll `snapTo`. What was in the hands lies where
you fell (sim).

### 10.9 Audio (`feel/audio.ts`, P37; SPEC:581, 849-851)

Rename the client's `Material` sound type to `ImpactSound` (it collides with the sim's `Material`, MAP client §9). Add
`chop(diameter, edged)`, `creak(intensity)` (rope strain and notched trees), `crack(mass)` (breaks), `snap()` (ropes),
`treeFall(mass)` (creak, whoosh, then DS `landing(mass)`), `dig()`, `knap()`, `scrape()`, `rustle()`, footstep surfaces
`grass | dirt | leaves | rock | log`, `roar(scale, intensity)`, `apeHoot()`, `giantStep(near)` with camera trauma
`0.05·(scale − 1)·near` inside 6·scale m (33 m for the giant), and the `'jungle'` ambience (birds, insects) that thins
out when the giant is within 40 m.

### 10.10 Dev panel (`debug/panel.ts`, P37; SPEC:12, 644)

Built from the registry (`TUNING`): one Tweakpane folder per table `folder` path, one binding per field with its
`min/max/step/label/unit`; nested tables (material rows, species blocks) as sub-folders; client tables register through
the same `defineTuning` under `Client › …`; "Copy tuning as JSON" = `tuningSnapshot()`. **An edit to a sim table is
sent as `meta 'dev' setTuning`** (applied at its tick, so the command log replays it, RR-17); client tables
(`Client › …`) change at once (they never touch the sim). Read-outs: the player's hands, the focused entity (mass,
integrity, sharpness, anchor, cut progress, load average), the giant's mind (state, awareness, charge cooldown, path
length, in-pit) and wounds, and the **last 10 impacts** (cause entity, credit, HP, environmental) and tripwire events,
so a playtest observer can see what a trap did (RT-24). Buttons, all sent as `meta 'dev'` commands so the command log stays
complete: spawn an ape near, spawn the giant at its lair, give a tool (stone axe, digging stick, spear, 12 m vine),
teleport (spawn, home A, the giant), pause minds, kill the target, respawn. Toggles: hitboxes (H), nav polys
(human/ruler), senses (cones, hearing rings), zones. "Save world (download)" sends `meta save` and downloads the bytes;
"Load world" calls `loadWorld` (M1 partial). Dev keys stay (L, P, `.`, T, H; Backspace rebuilds the world from the
same seed).

### 10.11 What the client removes, and what it reuses

Removed: `arena/themeView.ts`; from `game.ts` the training ring (`setupTraining`, `spawnEnemy`, waves, `respawnIn`,
round banners, `resetArena`, `setTheme`, `scatterWeapons`, `clearDrops`, `stage`, `FLOOR`, the arena `envBody`, the
ground cuboid), `roundRng`, `new CombatSim(Date.now())`, `externalKnockdown`, the ragdoll → sim copy, `cine.blocked` over
`walkable`, `camRig.inside`, `cutFocus.y = 1`, `lookFor(kind, theme)` arena outfits and armour tier looks (rule 4);
`tests/arenas.test.ts` retires (SPEC:863); `giveWeapon` becomes the dev "give tool" op. `tests/inputRouting.test.ts`
changes its third assertion from `this.sim.commands.push(moveCommand(` in game.ts to: commands are pushed only in
`game/loop.ts` via `world.commands.push(`, produced only by `input/verbInput.ts`, and no client file writes
`.moveInput`, `.press(`, `.pickupRequest`, `.verbRequest`, `.pos.set(` / `.pos.copy(` on a fighter, or calls an
entity/joint mutator outside dev ops.

| DS piece | Reused for | Change |
|---|---|---|
| `render/fighterView.ts` | player, apes, the giant | species palettes, `scar()`, held objects drawn from entities |
| `body/ragdoll.ts` | player and apes | down-follow toward the sim slab, slots per presentation world, launch from the sim, LOD ≤ 8 |
| `render/blood.ts`, `gibs.ts`, `particles.ts`, `game/trauma.ts` | gore and juice | `ground(x, z)` floors; stains on the terrain normal |
| `render/cinematics.ts` | kill cams, death cam | ground floor, far plane, terrain/trunk line of sight |
| `render/cameraRig.ts` | the fight camera | ground-relative heights, no arena containment |
| `render/cutout.ts` | trunks and canopies between camera and player (SPEC:638, 828) | focus at ground + 1; forest materials through `applyCutout` |
| `game/recorder.ts`, `ui/battleLog.ts` | session recording | started once per session (the clip button is M5) |
| `ui/hud.ts`, `ui/settings.ts`, `game/prefs.ts` | HUD, rebinding, prefs | §10.8; new rows; a "hold to crouch" pref |
| `input/*` | input | §5.14, §10.7 |
| `debug/panel.ts` (Tweakpane 4) | dev panel | registry-driven |

## 11. Acceptance test plan

The seven automated criteria (SPEC:898-904). Every test lives in `packages/sim/tests/`, uses only the harness
(§11.0), builds scenes only from entities and verbs (rule 1, AC-2's words), scripts only creatures and the player
(through commands), never the arrangement that does the harm (orchestrator decision 8), asserts by entity ids from the
harness (never handles), prints its measured numbers (`console.info`) so a tuning change shows in CI logs, disposes
every world it creates (`afterEach(() => h.w.dispose())`, RF-24), and uses `it(…, 120_000)` timeouts for anything with
Rapier (`beforeAll` builds: 900 s, RT-23). A test that cannot pass as written is reported, never weakened.

**Gates and pins** (RT-21). Every assertion is marked in the test source as one of:
- **GATE**: the criterion's meaning (a wound or a kill, a distance, a stability limit, "no NaN", an event that must or
  must not happen). A gate never moves. If it fails, the recipe changes (and §11 with it), never the assertion.
- **PIN**: a measured number (HP, v_n, a time, a force), with its tolerance and the lab file it came from. A pin may be
  re-measured only together with a lab rerun that explains the change; the rerun's file and output are named in the
  test's comment. The first implementation run does not rewrite pins by itself.

### 11.0 The harness (`tests/support/worldHarness.ts`, `tests/support/scenes.ts`, `tests/support/globalSetup.ts`, P23)

```ts
export interface Harness {
  w: World;
  ticks(n: number, each?: (r: StepResult, t: number) => void): { combat: CombatEvent[]; world: WorldEvent[] };  // copies
  until(pred: () => boolean, maxTicks: number, what: string): number;   // the tick; throws `${what} not reached in ${maxTicks}`
  // entities, through the factory world generation uses (§6.7)
  log(o: { mass?: number; length: number; r: number; material?: MaterialId; p: V3; q?: Quat; state?: 'free' | 'anchored' | 'fixed' }): number;  // 6-gon
  stick(o: { length: number; r: number; p: V3; q?: Quat; material?: MaterialId; sharp?: { end: 1 | -1; s: number } }): number;  // 8-gon
  coil(o: { material: 'vine' | 'sinew'; lengthM: number; at: V3 }): number;
  grass(o: { p: V3; mass: number }): number;                                  // the Clearing's grass bundle
  tree(o: { at: XZ; diameter: number; height: number; vine?: { anchorH: number; lengthM: number; yaw: number } }): { tree: number; vine: { rope: number; joint: number } | null };
  box(o: { p: V3; size: [number, number, number]; material: MaterialId; state: 'free' | 'fixed'; look: string }): number;   // scaffolding
  keepAwake(entity: number, on?: boolean): void;   // test-only wakeUp each tick, so "holds 120 s awake" is tested awake (RT-4)
  // staging (logged fixture ops, physics `it`s only, before a scene's trigger; never after a creature script starts)
  stage(entity: number, pose?: Pose3): void;     // hold an entity fixed at a pose (D-25: no M1 verb lifts 300 kg)
  unstage(entity: number): void;                 // back to free (dynamic, awake)
  // the scripted player, through commands only
  give(tool: 'stoneAxe' | 'diggingStick' | 'spear' | 'axe2h', into?: 'hands' | 'back'): number;   // meta 'dev' giveTool
  standAt(p: V3, yaw?: number): void;            // meta 'dev' teleport (logged): a fixture move
  verb(v: Omit<VerbCommand, 'tick' | 'player' | 'kind'>): void;   // queued for the next tick; waits for the work action
  walk(to: XZ, o?: { speed?: number; crouch?: boolean }): void;  // move commands until there
  carryTo(entity: number, to: XZ): void;         // take, walk, (place is a separate verb)
  dragTo(entity: number, to: XZ): void;          // take (drag), walk, drop
  strikeAt(target: number | V3, button: Button, n: number): void;   // focus + n strikes
  digPit(o: { centre: XZ; lengthX: number; widthZ: number; depth: number; maxTicks: number }): { strikes: number; ticks: number };  // planner below
  chopTo(tree: number, remaining: number): void;   // stone-axe strikes until remaining ≤ the value (fromDir = the side it stands on)
  pull(onTicks: number): void;                   // pull on (charge 255) for n ticks, then off
  reelIn(joint: number, leaveSlackM: number): void;  // pull on until the free length is within leaveSlackM of taut, then off
  pace(at: XZ, along: XZ, halfM: number, untilTick: number): void;   // walk back and forth ±halfM along `along`
  // creatures (AC-2: "a creature's route and actions")
  creature(kind: 'ape' | 'giantApe', at: XZ, yaw: number, opts?: { brain?: 'off' | 'on' }): Fighter;
  script(f: Fighter, s: MindScript): void;       // route, charge, tug, hold (§6.6)
  pause(f: Fighter): void;                       // mind.paused (+ idlePaused)
  // observation
  impacts(on?: Fighter): Extract<WorldEvent, { type: 'impact' }>[];
  tripwires(): Extract<WorldEvent, { type: 'tripwire' }>[];
  wounds(f: Fighter): WoundRecord[];
  nearestDistH(from: XZ, owners: Owner[]): number;   // horizontal distance to the nearest point of those owners' colliders
  bodyStateBytes(): Uint8Array; saveBytes(): Uint8Array;
}
export async function makeHarness(o: Partial<WorldOptions> & { seed: number }): Promise<Harness>;   // scene 'empty', nav 'off' unless asked
export async function loadHarness(bytes: Uint8Array, o?: { nav?: 'full' | 'off' }): Promise<Harness>;
export function cachedScene(key: string): Uint8Array;   // a scene saved by globalSetup (below)
// scenes.ts: recipes shared by AC files (entities + verbs only)
export function buildPit(h: Harness, o: { centre: XZ; lengthX: 8; widthZ: 6; depth: 2.5; stakeSpacing: 0.6 }): { cover: number[]; stakes: number[]; strikes: number };
export function buildStakedLog(h: Harness, o: { centre: V3; yaw: number; massKg: 300; lengthM: 4.4 }): { log: number; stakes: number[] };
export function buildStakedWall(h: Harness, o: { start: XZ; dir: XZ; lengthM: 16; height: 1.0 }): number[];
export function buildNotchedTree(h: Harness, o: { at: XZ; fromSide: XZ; remaining: number; vine: { anchorH: number; lengthM: number } }): { tree: number; vineJoint: number };
export function buildLeaningLog(h: Harness, o: { at: XZ; yaw: number }): { prop: number; log: number; bait: number };   // §11.2(a) gate
export function buildHauledLog(h: Harness, o: { at: XZ }): { log: number; tie: number; stake: number };              // §11.2(c) gate
```

- **The dig planner** (`digPit`, RF-11). The digging stick's head reaches 0.534 m below the player's feet, 1.56 m ahead
  (§5.2), so a 2.5 m pit is dug from inside in layers of 0.5 m. For each layer the planner lists strike centres on a
  0.3 m grid over the footprint (strike `(x, z)` while any vertex within 0.25 m of it is above the layer's depth) and
  stand spots 1.56 m behind each centre on the current floor (the rim for the first layer), facing it; it walks between
  stand spots (`walk`), and uses a logged `standAt` when the walk fails (a wall steeper than the KCC's 45°) and to
  leave the finished pit; a strike that meets a dirt pile inside the footprint makes it `dragTo` the pile 3 m outside
  the footprint first. Gates: the pit finishes within `maxTicks` (360,000: 1.2 × 3,185 no-spoil strikes at up to 88
  ticks each, fatigue tempo ×1.6, plus walking) and within 1.2 × 3,185 = 3,822 strikes (RT-2); pin: 3,573 strikes
  **[RT lab: spoil_setback.out]**.
- **The cached pit** (RF-11, RT-23). `tests/support/globalSetup.ts` (a Vitest `globalSetup` of the `sim` project in
  `vitest.config.ts`) builds the AC-2(b)/AC-3 pit scene once (`buildPit` on a fresh `scene 'empty'` world) and writes
  its save bytes to `packages/sim/.cache/scenes/pit-<hash>.json` (gitignored), `hash = sha256(tuningSnapshot() +
  SAVE_FORMAT_VERSION + the text of packages/sim/src/** and tests/support/*.ts)`; a matching file is reused. AC-2 and
  AC-3, in different Vitest workers, read it through `cachedScene('pit')` and `loadHarness`. The first build costs
  ≈ 3.3 min of wall time at 1 ms/tick (3,617 strikes × 55 ticks **[RT lab: numbers.out]**); CI caches the directory.
  `npm test` also runs a 2 × 1 m dig scaling check that needs no cache.
- **Heavy entities** (D-25): the player carries ≤ 40 kg and drags ≤ 150 kg, and no M1 verb lifts a 300 kg log. Each AC-2
  trap therefore has **two `it`s** (RR-5, RT-8):
  - a **verb-only gate**: every entity is factory-spawned the way generation makes it (sticks, logs ≤ 150 kg, coils,
    grass, trees with hanging vines) and every relation and pose comes from a verb at a mass the verbs can move. This
    is the `it` that shows the trap emerges from M1's rules (rule 1: "if a trap can't be built from the rules, change
    the rules"; the sloped Place, the tie of a hauled end and the haul model of §4.9/§5.7/§5.8 were added for it);
  - a **staged physics `it`**: heavy entities spawned at their pose or held by `stage` while the player ties them
    (D-25: "fine as test scenes"), at the ruler-scale masses the C labs measured. Both are gates.
- **Credit** (RT-19): in a verb-only `it`, every scored cause must carry `'p1'` (the player moved, placed, tied or cut
  it). In a staged `it`, the credit check applies to the entities a verb touched; an entity only spawned or staged has
  `credit: []`, and the test says so instead of faking it.
- **Reach**: the player ties only what is within hand reach (§5.0). Where a recipe needs a tie above 2.5 m, the scene
  provides a fixed scaffold `box` to stand on (test scaffolding is an entity, not a trap).

### 11.1 AC-1: no trap types (SPEC:898) — `ac1.noTrapTypes.test.ts` (P24)

- Scan every `.ts`, `.tsx`, `.js`, `.mjs` and `.json` file under `packages/sim/src` and `apps/client/src` (RT-20).
- Parse the script files with the TypeScript 5.9 compiler API (`ts.createSourceFile`, no type-check). Collect class,
  interface, type-alias, enum and enum-member names; string-literal members of every union type alias, including
  literal types nested in object members and property signatures (`{ type: '…' }` inside `WorldEvent`); string
  literals assigned to properties named `kind`, `type`, `look`, `feature`, `why`, `effect`, `op` in object literals;
  `MaterialId`, `SpeciesId`, `CauseFeature`, `MindState`, `VerbId`, `ToolClass`, `MomentKind`, `DevOp` literals;
  exported function and const names. JSON files: every key and every string value.
- Fail on `/trap/i` in any of them (this also catches `Strap`, `Trapezoid`, `Bootstrap`: rename those if they appear).
- Second assertion, the spec's literal check: a case-insensitive search for `trap` over both trees with comments
  removed using the TypeScript scanner's comment ranges (`ts.getLeadingCommentRanges` / `getTrailingCommentRanges`, so
  a `//` inside a string such as a URL is not taken for a comment): no hits (the trapline exception is M4).
- Expected: 0 and 0. Today: 0 grep hits in either tree **[I verified: grep at HEAD; RT: re-run]**. This design
  introduces none (the kill-cam trigger the spec calls "a trap hit on a ruler" is `worldWound`; the wound event's flag
  is `byWorld`).

### 11.2 AC-2: four traps from entities and verbs (SPEC:899) — `ac2.traps.test.ts` (P28)

World: `scene 'empty'` (flat heightfield, 25 m tiles, 0.25 m spacing), `nav 'off'`. "Wounding" = for an ape, an
`impact` event whose `cause.entityId` is an entity of the scene, `cause.held === false`, `damage > 0` (so E ≥
`minImpactJ` or a flinch, by the scoring rule); for the giant, a `WoundRecord` (> 240 HP, SPEC:502) with that cause.
P28 starts with a **lab-first step**: each recipe below is run once with the real pipeline and the pins are recorded
with their output file before the test is frozen (RT-21); if a gate fails there, the recipe changes here.

**(a) Deadfall — the ape pulls the bait.**

*Gate `it`, verb-only* (`buildLeaningLog`; measured with the C lab's engine core **[I-rev ran: deadfall_light.out]**):

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | a dry stick r 0.07 m × 2.4 m (17.9 kg), carried and **placed** upright, not driven (`drive: 0`) | a free prop |
| 2 | a dry hex log 5.0 m, 40 kg (circumradius 0.075 m), carried and **placed sloped**: lower end on the ground, resting on the prop's top 4.4 m along it (pitch from the Place cast: 32.9°) | §5.7's sloped Place |
| 3 | bait: a 1 kg hide box **placed** lying 0.55 m inward of the prop's base; **lash**(bait, prop) with a vine coil, anchors 0.65 m apart → a 0.65 m rope at 0.15 × the prop's length | |
| 4 | ape (brain off): `route` to 0.45 m behind the bait, crouched (capsule 1.39 m; the log's underside there is 1.75 m); `tug { entity: bait, dirYaw: toward its own body, ticks: 120 }` (907.5 N, hand ≤ 0.8 m/s) | |

GATES: the log stays set 120 s with `keepAwake` (prop tilt < 1°; measured 0.17°); it springs within 1.0 s of the tug
(0.45 s); an `impact` on the ape from the log with v_n ≥ 1 m/s and `damage > 0`, credit `'p1'`; no `tripwire` event
(RT-5); the ape fits (no KCC overlap with the log before the spring). Negative control: a 200 N tug does not spring it
(threshold measured 266 N). PINS: v_n 1.34-2.08 m/s, 0.7-1.6 HP on a 0.25 m chest ball at 1.0-1.2 m (a 40 kg log
falls a short way; this is the honest size of an ape deadfall a player can lift, §4.15).

*Physics `it`, staged* (the C lab's scene):

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | `stick` dry wood, r 0.07 m (14 cm, ≈ 18 kg), length 2.38 m; the player carries it and **places** it upright, not driven (`drive: 0`), at x = 5.07 | a 3.5 cm stick self-springs; 10-18 kg props held 30/30 configurations 120 s awake **[C lab: e1e_angle, F1]** |
| 2 | `log` dry wood hex prism 6.0 m, circumradius 0.17 m (≈ 170 kg), spawned free with one end on the ground at x = 0 and its underside on the stick top 5.6 m along it (25°) | D-25 |
| 3 | bait: a 1 kg hide box, placed lying 0.55 m from the stick toward the ground end (x 4.52); `lash(bait, stick)` → a 0.65 m rope at 0.15 × the stick's length | |
| 4 | ape (brain off): `route` crouched to x 3.72 (0.8 m inward of the bait; the log's underside there is 1.75 m, the crouched capsule 1.39 m, RT-4), then `tug` toward its own body | |

GATES: set 120 s with `keepAwake` (tilt < 1°); springs within 1.0 s of the tug; an `impact` on the ape from the log with
v_n ≥ 2 m/s and `damage > 0`; no `tripwire` event; the log lands within 0.35 m of its own vertical plane. Negative
control: no spring below a 700 N tug (762 N needed **[C lab: e1c_thick]**). PINS: v_n 3.2-4.6 m/s; HP measured with
the real crouched ape rig in the lab-first step (the C lab's 4.9-10.1 HP came from a 0.25 m ball; on the 19.97 kg chest
bone it is 5.1-10.5 HP, on the head 2.0-4.1 HP **[RT lab: numbers.out]**).

**(b) Spike pit — the giant ape (weight-triggered).** `buildPit` (P23), cached by globalSetup, verb-only:

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | the player digs an 8 m (x) × 6 m (z) pit 2.5 m deep with the digging stick (`digPit` planner) | ≤ 3,822 strikes (gate); 3,573 (pin) **[RT lab: spoil_setback.out]**; spoil ≥ 1.5 m from dug ground, ≤ 12 piles, a berm |
| 2 | 108 `stick`s dry wood 1.4 m, r 0.05 m (factory-spawned beside the pit); the player **shapes** each to 0.6 (6 strokes; the first tapers the end to a point, §5.4) and **places** it upright point-up on the pit floor on a **0.6 m grid** (12 × 9), driven 0.3 m → anchored, 1.1 m exposed | 0.6 m: ≥ 1 stake wound in 15/15 lab runs, 1.0 m in 12/15 **[I-rev ran: ac3_density.out]** (I-4) |
| 3 | 20 rotten-wood bearers (4 kg, 8 m, r 0.02 m, factory-spawned) **placed** lying across the 6 m width, 0.4 m apart; 30 grass bundles (1-3 kg, the Clearing's) **placed** lying on them | each bearer holds 200 N; the old 66 kg mat (> 40 kg carry, spawned) is gone (RT-2, RT-8) |
| 4 | `saveBytes()` → the cache; for each of 9 runs: `loadHarness`, giant (brain off) `charge` along +x from x = −30 at {3, 4.5, 6} m/s × lateral offsets {−1, 0, +1} m | |

GATES: the cover holds its own weight 60 s awake (no `break`; no piece sinks > 5 cm; ≈ 70 N per bearer < 200 N
**[I-rev ran: rev.out §3]**). In each of the 9 runs: a `break` of a cover entity **from foot load** (a load break)
under the giant before the trip; the trip has `why 'cover'` (RT-1); ≥ 1 wound with `cause.entityId` = a stake and
credit `'p1'`; within 0.5 s of the first cover break no cover piece rests on both rims (load breaks snap a bearer across
its axis, RT-7); every stake that broke had its `impact` event before its `break` event (SPEC:344); no NaN. LOGGED (not
gated, RR-23): whether the giant is alive. PINS: pit damage per run 385-3,084 HP, ≥ 1 stake wound in 15/15 lab runs
**[I-rev ran: ac3_density.out]**; the lab used the C lab's scripted descent and deleted cover pieces, so P28's
lab-first step re-measures the 9 runs with the real mover (`supportAt`, §4.7), load-break fracture and piece grace
(RT-1, RT-7, RF-7) before freezing them. Nine runs because the outcome is chaotic (F8).
Negative control `it` (RT-1): the same pit bridged by 8 green logs r 0.18 m × 8 m (651 kg, capacity 261 kN > the
137 kN of one ruler foot; tops 0.36 m, below the giant's 0.39 m ankle, so they are ground, not obstacles) spawned at
their pose (D-25): the giant `charge`s across at 6 m/s: no `break`, no `trip`, `pit` never on **[I-rev ran: rev.out
§3]**. This is what makes the pit weight-triggered rather than a hole the giant falls into (SPEC:900, 458).

**(c) Swinging log — the ape.**

*Gate `it`, verb-only* (`buildHauledLog`; measured with Rapier **[I-rev ran: swing_light.out]**):

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | two `tree`s (d 0.4 m, h 14 m) at (0, ±2.6), each with a hanging vine anchored 8 m up on its inner side (anchor (0, 8, ±2.4), length ≥ 9 m) | as generated (§6.7) |
| 2 | a dry log r 0.2 m × 2 m (138 kg) **dragged** to lie along z under the anchors at x = 0 (the support) | drag ≤ 150 kg |
| 3 | a dry hex log 30 kg, 4 m (circumradius 0.072 m) carried and **placed** lying along z on the support (centre 0.47 m up) | |
| 4 | the player takes each vine end and **ties** it to the 30 kg log at local z ±1.6 (rope joints 7.57 m, taut); then **drags** the support away (the log stays hanging) | |
| 5 | a stick **placed** driven at (−9, 0, 0) (the tie stake, anchored 1,200 N); a vine coil ≥ 10 m **tied** to the log's back face and paid out walking to the stake; **Pull** for 8 s; **tie** the hauled end to the stake (§5.8: the haul force holds through the tie) | hauled to 35.6° (peak 51.9°), tied at 35.6°, log centre 1.88 m up; tie 4.61 m long, 244 N; vines 206 N each |
| 6 | the ape (brain off) `hold`s at the arc's bottom (x 0.25, z 0); the player `draw`s the stone axe from the back slot and **cuts** the tie (focused on the rope sensor, §5.2) | |

GATES: while tied nothing snaps or pulls loose (no `joint snap`, no `tripwire` event, the stake stays anchored); after
the cut the log passes the bottom at ≥ 4 m/s; an `impact` on the ape from the log with `damage > 0` and credit `'p1'`.
PINS: 5.26 m/s, shin hit v_n 4.94 m/s → 3.4 HP. The haul is chaotic: with the stake 5 or 7 m back the tie-off came at
34-45°, and one 7 m case gave a steep 2.24 m tie of ≈ 4.5 kN that would pull a 1,200 N stake loose; 9 m is the measured
safe distance (risk R11).

*Physics `it`, staged* (the C lab's swing):

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | the two trees and vines of the gate `it` | |
| 2 | `log` 300 kg dry hex, 4 m, axis along z; `stage`d at the pulled-back pose: 60° back, centre (−5.59, 4.78, 0) | D-25 |
| 3 | a fixed scaffold `box` x ∈ [−6.2, −5.85], z ∈ [−2.0, 3.5], top **2.65 m** (the player at x −6.0: chest 3.85 m, head top 4.45 m, 0.33 m under the tie, RF-21/RT-5); a fixed tie post `box` 0.4 × 6 × 0.4 m at x = −6.6, z = 0 | reach: log anchors 1.18 m, tie anchor 0.95 m, post 1.11 m (≤ 1.3 m) **[I-rev ran: rev.out §2]** |
| 4 | the player takes each vine end, `standAt` the scaffold, **ties** it to the log at local z ±1.6 (rope joints ≈ 6.42 m, taut); **ties** a vine coil from the log's back face to the post (a horizontal 0.58 m tie at 4.78 m); `unstage(log)` | held: per hanging rope 2.94 kN, tie 5.09 kN (vine 6 kN) **[C lab: e3_swing]** |
| 5 | the ape `hold`s at the arc's bottom (x 0.25, z 0) (RT-6: an ape walking +x with the swing was hit at 5.10 m/s, 13.5 HP, not launched); the player **cuts** the tie with the stone axe, focused on the rope sensor's nearest point, then walks along the scaffold to z = 3.0 | |

GATES: while held no rope snaps; no `tripwire` event (the player's head stays 0.33 m under the tie); after the cut
(timed from the `joint … 'cut'` event) an `impact` on the ape from the log with v_n ≥ 5 m/s and `damage > 0`. PINS:
per-rope peak ≤ 2.94 kN ± 3 %; the log reaches 7.95 m/s ± 3 %; v_n 7.95 m/s on the 19.97 kg chest bone → 32.9 HP, dv
6.00 m/s ≥ `launchDv` → launched **[C lab: e3_swing; I-rev ran: rev.out §2]**; the cut is measured from the scaffold in
the lab-first step (the chop arc must meet the 2 cm sensor). Negative control: the same log from 75° with one vine per
side holds at 5.66 kN per rope but the tie (10.98 kN > 6 kN) snaps at once: the rope rule working.

**(d) Felled tree — an ape at 12 m, and (second `it`) the giant at 8 m.** Verb-only already (the tree and its vine are
generated features; chop, take, pull are verbs).

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | `tree` 30 cm × 15 m green wood (738 kg above the cut) with a hanging vine anchored 10 m up, length 18.2 m | |
| 2 | the player stands on the −x side and chops it with the stone axe to remaining 0.2 (12 chops of 2 cm); `fromDir` = −x (the side he stands on, §2.5) | M_cap 1,018 N·m **[I verified: fell.mjs]** |
| 3 | the player takes the vine end and walks to P: 15.6 m horizontally from the trunk, 45° off the fall line (+x) | rope 17.96 m |
| 4 | the ape (brain off, `hold`) on the fall line 12 m from the stump; the player `pull`s 2 s | |

GATES: the tree stays `fixed` (phase `notched`) for 120 ticks with no pull (the back-moment closes the cut); with the
pull the hinge breaks on the first pulling tick (net 1,794 N·m > 1,018); the trunk lands within 5° of the fall line;
an `impact` on the ape from the trunk with v_n ≥ 10 m/s and `damage > 0` (RT-3). LOGGED: HP and whether the ape is KO'd
(and if so that the `ko` CombatEvent is `environmental: true`). PINS: lands within 1° of the fall line ≈ 4.6 s after
the pull and sleeps **[C lab: e4_fell]**; the first bone it meets is the head: v_n ≈ 15.5 m/s → 48 HP, no KO (the
chest alone would be 130 HP) **[RT lab: numbers.out]**; with episode scoring (§4.3) the head contact is the hit. The
C lab's "124 HP, KO at 12 m" was 1 of 7 runs and is no longer asserted. Ruler `it`: the standing giant at 8 m (brain
off, `hold`): GATE a wound (> 240 HP) from the trunk; PIN 534-721 HP on the head or chest **[C lab: e4_fell]** (534 HP
holds even when only the first contact counts **[RT: checked]**).

### 11.3 AC-3: the solo hunt (SPEC:900) — `ac3.soloHunt.test.ts` (P29)

World: `scene 'empty'` with `nav 'full'` (the giant paths and perceives). The pit is the cached `buildPit` scene (8 × 6
× 2.5 m, 108 stakes on 0.6 m, the verb-built cover) centred at (0, 0).

| Step | Entities and verbs | Numbers |
|---|---|---|
| 1 | a 30 cm × 15 m tree at (0, −9) with a hanging vine anchored 10 m up, 20.2 m long (the generator's longest, §6.7) | |
| 2 | the player stands on its −z side and **chops** it to remaining ≤ 0.14 (13 chops: 0.133), so it falls along +z across the pit; it holds with no pull (net −1,086 N·m) | M_cap(0.133) 299 N·m; 500 N from P nets 1,001 N·m > 299 (3.3×), the 1,200 N yank 3,924 **[I-rev ran: rev.out §1]** |
| 3 | the player takes the vine end, **splices** the starter cache's 8 m coil to it (27.7 m, §5.8), walks to **P = (18, 1)** and **reels in** until 0.3 m of slack is left (`reelIn`) | P: 20.59 m horizontally from the tie; rope ≥ 22.43 m taut; 13.4 m from the cover's AABB, 14.0 m from the pit's edge |
| 4 | the giant ape (brain on) starts at (−40, z0), z0 ∈ {−1.5, 0, +1.5}, in `patrol` on a two-waypoint route (−40, z0) → (30, z0) through the pit; the player paces ±1 m at P perpendicular to the line to the tie (`pace`), so it sees him moving (58 m < its 60 m moving sight) and chases, telegraphs and charges at him | the lure is being seen (SPEC:468); "along a path" is its patrol route (RT-9) |
| 5 | the player starts pulling on the first tick the giant is `tripped` ("then pulls a rope", SPEC:900) | reel 0.3 m (0.2 s), then the 1,200 N yank |

**The 10 m measurement** (RR-4, RT-10; stricter than D-43's centroid reading, so D-43's reading holds too): at each
spring tick the player's root is ≥ 10 m horizontally from the **nearest point** of every collider of: the cover
entities (and their pieces), the pit's dug footprint, the released trunk and its stump, and the giant. The first draft
measured to the cover's centroid with the player at (11, 2), 5.7-7.1 m from the mat's edge; the reviewers' own fix
(P 21 m out along the 45° line, (14.85, 5.85)) puts the charge line toward the player through z ≈ 3.4 at the pit's
near edge, outside the 6 m width (I-3). P = (18, 1) keeps the charge line through the pit and every distance well clear
**[I-rev ran: ac3_geom.out]**:

| At | Cover / pit | Giant (nearest collider, conservative) | Trunk / stump | Tie (horizontal) |
|---|---|---|---|---|
| the cover breaks (trip) | 12.91 m / 13.51 m | 19.93-20.13 m | — | 20.6 m |
| the hinge breaks (the first pulling tick) | 12.91 m | 19.93-20.13 m | 20.44 m | 20.6 m |

(minimum over P and P ± 1 m; scripted straight charges at 6 and 7 m/s from (−30, z0); the brain-on giant charges from
where it sees him, so the gate is re-measured in the lab-first step.)

GATES:
- the pit springs (the first cover load break) and the second trap springs (the `fell` event) with every distance
  above ≥ 10 m and the tie ≥ 15 m horizontally from the player (I18);
- both traps wound: a wound (> 240 HP) whose cause is a stake and one whose cause is the trunk, both credited `'p1'`;
- the giant is alive after the pit (a precondition for the second trap, RR-23); logged after the trunk.
PINS and records: in the lab, at P = (18, 1) with the design's break-after-step stakes on the 0.6 m grid, every
scripted charge (6 and 7 m/s, z0 −1.5/0/+1.5) gave 2-6 stake wounds (1,306-3,510 HP from the pit) and the trunk
wounded 6/6 (2,345-2,836 HP) arriving 4.77-4.82 s after the trip, on a lying body **[I-rev ran: ac3_final.out]**. In M1 the rise starts at +4.00 s, so the trunk meets a giant that is
rising inside the pit: still `rulerDown` (in a pit, §4.7), its kinematic zones score by the rule, and a 10 m body
rising under a 15 m trunk falling across it can't be missed. The test logs its state at impact.
**Lab-first** (P29, RT-9, RF-28): before freezing pins, P29 re-runs the scene with the real pipeline (the design's
pit with real pieces and the berm, the brain-on 7 m/s charge, ±1 m pacing, z0 variants, the rise at +4.00 s and the
climb-out) and records the wound counts and distances. If a gate fails, the recipe changes (stake grid, P, the tree's
remaining), never the assertion. A second `it` repeats the physics with the scripted `charge` (brain off) so a mind
failure and a physics failure are told apart.

### 11.4 AC-4: rule 5 (SPEC:901) — `ac4.rule5.test.ts` (P25)

- Scene: `scene 'empty'`, flat, nav off. The giant (brain off, `pause`d: drive zero, idle paused, a frozen stance),
  scale 5.5, 14 t, 12,000 HP, defense 0, knee spheres on. The player gets `WEAPONS.axe` (two-handed; `overhead` is its
  committed swing) through `give('axe2h')`.
- Placement: one deterministic search for a player spot where `overhead` first touches a knee sphere at full power
  (frame 26); the player is re-placed there with `standAt` whenever it drifts > 2 cm (commands, logged).
- Before every step the fixture sets `p.counter = { kind: 'block', frames: 2 }; p.perfectCounter = true` ("every hit
  counted as a perfect counter" is a condition of the criterion that no command can express; `tickTimers` clears
  `perfectCounter` without an open counter window, so a ≥ 2-frame window is needed, MAP gap-6 §3e). **Never touch
  `p.stamina`.**
- Two `it`s, the same assertions (RT-13):
  - **mash** (the literal "as fast as the move allows"): `button 'rpunch'` every tick;
  - **best-paced** (the worst case rule 5 must survive): press only when `p.free` and `p.stamina ≥ 0.999`.
- Run 36,000 ticks (10 min), then 120 ticks (2 s) of quiet.
- GATES (free ruler, D-5): knee hits ≥ 200; **wounds created = 0**; `rulerHp === 12000` exactly at the end; every hit's
  zone, frame, E and HP logged. PINS: hits 472 mashed / 277 best-paced; the largest `unhealed` ≤ 40.65 + 0.01 HP; HP/s
  2.89 mashed, 18.91 best-paced against 30 HP/s recovery **[MAP gap-6 §3c-3d; RT lab: numbers.out]**. With knee
  toughness 0 J the best-paced `it` would fail (34.4 HP/s) and the mash one would not (29.2): that is why both run.
- Documented negative control in the same file: stamina pinned at 1 → **5,642 HP** left at 10 min (fails), showing
  SPEC:303's margin rests on DS stamina (§9.3, RR-24).
- Second half ("while it's pinned add to its wound"): trip the giant (the AC-5 recipe; the trip opens no wound, v_safe
  14.07 m/s). Spawn two 1,000 kg hex logs 2 m above the lying body, across it, when every ruler collider is below
  0.05 m/s or at +2.5 s after the trip, whichever comes first (they land 0.639 s later **[RT lab: numbers.out]**;
  RT-14). GATE: `pinned` turns on before +4.0 s and the state stays `tripped` past +4 s. The logs' impact opens a wound
  (≈ 586 HP on the chest bone); it becomes `downWound` (the wound that pinned it, §4.6); **W = `ruler.downWound` read
  when the axe hits begin**. Then 20 s of the same axe attacks on soft zones in reach on the lying body (eyes, elbows,
  knees; the placement search re-run on the tripped rig). GATES: `W.hp` grew by exactly the sum of HP of every
  damage event on the ruler during the 20 s that opened no wound (axe hits, and any finishing from the logs settling,
  RF-17), with ≥ 1 axe hit of HP > 0; `unhealed` never fell while pinned. PINS: 40.65 HP for the first fresh perfect
  counter on a 600 J zone, then 3.66 HP per hit once stamina is spent; armoured surfaces add 0.

### 11.5 AC-5: trip, settle, get up (SPEC:902) — `ac5.rulerTrip.test.ts` (P26)

- Entities (`buildStakedLog`): a 300 kg dry hex log (4.4 m, circumradius 0.23 m), axis across the path, centre 1.0 m
  up (the shin band at 5.5 is 0.39-2.75 m), **lashed** with vine to two stakes the player **placed** point-up (driven,
  anchored) at its ends, so it is anchored → a blocker (§2.3). After building, the player is teleported 30 m away and
  `pause`d (idle paused, no input), so its kinematic bodies are still (RF-16, RT-18).
- Ruler: `charge` at 6 m/s along +x from x = −20 (brain off, telegraph skipped); at the `rise` event, `pause` it ("its
  AI paused once it's up": mind paused and idle paused, §12).
- The body set ("every body", "body part"): every Rapier body (entities, the paused player's KCC and zone bodies, the
  ruler's body; for the ruler each collider's point velocity `v + ω × r` while tripped, rig delta / DT while kinematic).
- GATES: a `trip` with `why 'obstacle'` on the first leg contact with root speed 6 > 4 m/s; no NaN in any body or
  fighter field at any tick; no body part faster than 30 m/s; the rise starts at +4.00 s; every body below 0.05 m/s
  within 10 s of the impact and still at +10 s. PINS: ≤ 13.0 m/s tripped, ≤ 8.4 m/s rising, the lashed log flung at up
  to 15.4 m/s; the rise ends at +5.57 s (94 frames); every body < 0.05 m/s from +5.58 s **[C lab: e5_trip]**.
  Variants in the file: anchored log, lashed log (the lashings break: per-bone E 15.5 kJ > 600 J), the log split into
  two 150 kg halves; all pass in the lab. The capsule-log variant (fails at +10.83 s) is kept as a skipped regression
  note. The trip itself costs the ruler 0 HP (v_safe 14.07 m/s; 637 HP without it, F13).
- Interpretations (§12): "gets up after 4 s" = the rise starts at +4 s; "body part" = each ruler collider plus every
  other rigid body.

### 11.6 AC-6: push, pass-through, deflection (SPEC:903) — `ac6.bodies.test.ts` (P27)

Terrain friction 0.7 (dirt) **[C lab: e6_kcc]**:
1. The player walks 3 s (move commands) into an 800 kg icosahedral stone hull (r 0.47 m) at walk and run. GATES: it
   moves < 0.01 m; the KCC reported a computed collision with the boulder on ≥ 120 of the 180 ticks and queued a push
   on each of them (so "didn't move" isn't "never touched", RT-15). Into a 40 kg dry hex log (2.2 m): GATE it moves
   > 1 m. PINS: 0.000 m; 2.26 m walking / 8.19 m running.
2. A 300 kg hex log dropped from 4 m onto the standing player. The masses are test constants (the player's
   `SPECIES_BODY.human` 73.3 kg at its default, the log 300 kg), so a tuning change can't move the margin silently.
   **Measured tick** (RT-16): N = the tick whose phase 9 scores the first episode between the log and the player's
   zones; *before* = the log's phase-5 stored velocity at N; *after* = its phase-8 snapshot at N + 1 (the reaction
   queued in 9b of N lands in 4d of N + 1, §3). GATES: after ≥ 80 % of before (D-23, binding); the log comes to rest on
   the terrain (rest height < 0.5 m), not on the capsule; an `impact` on the player with `damage > 0`; the impact's
   branch matches §4.4 for its dv: `launched === (dv_free ≥ launchDv)` with dv_free the part of dv not into the ground,
and with the pinned masses the
   test asserts the branch it expects (dv 4.99 m/s < 5.00: hitstun or pressed, not launched) by name, so a change that
   crosses the threshold fails loudly (RF-27). PINS: 6.21 m/s before, 5.32 m/s after (85.7 %; the physics is
   `v·m/(m + M)` = 80.4 % plus one tick of gravity **[C lab: F14; RT lab: numbers.out]**). Control in the same `it`:
   with the capsule's solver groups including ENTITY the log stops dead (0.00 m/s) and rests on the player's head
   (y 1.98).
3. `buildStakedWall`: a 16 m wall of two stacked anchored hex logs (1.0 m high); the giant `charge`s at 6 m/s from
   **15 m** before the wall (the 35 m charge cap can't end the run first, RT-17). At 20°: GATES it slides along the wall
   (no trip, no stop), never closer than r + face distance − 0.05 m, and leaves past the wall's end; PINS 5.64 m/s with
   its heading within 0.2° of the wall. At 45°: GATE a `trip` with `why 'obstacle'` (the wall's 1.0 m top is inside
   the 0.39-2.75 m band, so a trip is the only correct outcome; no "or a stop"). (A KCC with a 1.9 m autostep climbs the
   same wall: the negative control in the lab, F6.)

### 11.7 AC-7: determinism (SPEC:904) — `ac7.determinism.test.ts` (P30)

- Scene: `scene 'clearing'` from a fixed seed S (20261017) with nav on: terrain, the player, three apes, the giant.
- **Command log** (RF-10, RT-11): a fixed **script**, as data (`tests/fixtures/ac7-script.json`), authored against the
  Clearing of seed S, whose entity ids and poses are known because generation is deterministic (the test first
  asserts that every id the script names has the expected kind and is within 1 cm of the expected pose, so a
  generation change fails with a clear message instead of a silent no-op). It uses `meta 'dev'` gives, teleports and
  one `spawnGiant` near the player, then the verbs: take, carry, drop, drag, place (driven and sloped), shape, lash,
  tie, splice, cut (a hanging vine), dig (20 strikes), throw (a stone and a spear), pull (a vine through a notched
  tree: a felled tree), bend (a sapling), a rope pendulum (a light log tied to a vine end, released), and `meta save`
  at tick 1,800. Move and button noise from its own `Rng(99)` fills the ticks the script leaves free. 3,600 ticks.
- Runs: world C (seed 6) first and discarded (catches module-level leaks a plain "run twice" misses, MAP gap-7 §8);
  then A and B from seed S sequentially; then W1 and W2 interleaved tick by tick.
- GATES (determinism): every 60 ticks `bodyStateBytes` (§8.2) are bit-identical and `serializeWorld` byte-identical for
  A = B and W1 = W2 (60/60 checkpoints each); event digests equal; `LEGACY_IDS.next` unchanged.
- GATES (coverage, per run, so it can't pass on an idle world): `verb ok:true` ≥ 1 for each of take, drop, place,
  shape, lash, tie, cut, dig, throw, pull, bend; ≥ 1 each of the world events `fell`, `dig`, `joint` (snap or cut),
  `impact` with `damage > 0`, `break`, `tripwire` or `land`; ≥ 1 nav tile version change; an ape in `fight`; the giant
  in `chase` and then `charge` or tripped.
- PIN: measured with the real CombatSim and Rapier, 60/60, saves byte-identical, 1.0 ms/step **[C lab: e7_det]**.
- Negative control (documentation): fighters built with the process-wide id counter → 0/60 **[C lab: e7_det_legacy]**.

### 11.8 Risks against the criteria (not weakened; reported)

| # | Risk | What we do |
|---|---|---|
| R1 | AC-2's deadfall can only *wound* an ape (staged ≈ 5-10 HP; verb-built 0.7-1.6 HP; killing needs 1,620 J, 13.2 m/s on the chest bone) | Passes on "wounding"; the crush rule stays a recorded M1 TODO for the journal and AC-9 (§4.15) |
| R2 | The spike pit is chaotic (F8); one lab gave 9/9 at 1.0 m, another 3/6 | 0.6 m grid (15/15 in the lab); 9 AC-2 runs; P28/P29 lab-first with the real mover, pieces and berm; a death in the AC-3 pit would fail its "alive after the pit" precondition (correctly) |
| R3 | AC-2(c)'s staged swinging log and scaffold differ from the lab's geometry by up to ~3 % | Pins re-measured in the lab-first step with a rerun file; the gates don't move |
| R4 | AC-3's trunk lands on the rising giant (4.77-4.82 s after the trip in the lab vs the rise at +4.00 s) | In a pit it is still down (§4.7) and its zones score; the state at impact is logged; measured in the lab-first step (RF-28) |
| R5 | AC-3 with the brain on depends on the giant's perception and charge tuning (CRT-3) | The scripted-charge `it` isolates physics; the brain-on `it` is the gate |
| R6 | AC-4 passes only through the knee volumes and only because DS stamina paces the swings (18.77-18.91 < 30 HP/s) | Knee volumes are part of the design (§2.8); the best-paced `it`; the stamina constants listed in §9.3 with "rule 5 depends on this"; P11's unit test; a TODO naming rule 5 (RR-24) |
| R7 | AC-5 "AI paused": the giant's idle breathing at 5.5× may exceed 0.05 m/s | `paused` freezes idle life (`idlePaused`), recorded as an interpretation (§12) |
| R8 | AC-6 part 2's margin is 7 % (85.7 % vs 80 %), and dv sits 0.01 m/s under `launchDv` | Masses are test constants; the branch is asserted by name |
| R9 | AC-7 compares a save: any state missed by the writer blinds the check | P13's completeness test covers every system's runtime state (§8.3); AC-7 compares body bytes too and checks coverage |
| R10 | Test time: the pit build (~3.3 min), AC-4 (2 × 36,000 ticks), AC-7 (4 × 3,600 ticks) | The cached pit scene (§11.0); `test:accept`; long timeouts |
| R11 | AC-2(c)'s verb-only haul is chaotic: the tie-off angle varied 28-45° with the stake distance, and a short steep tie reached ≈ 4.5 kN | The recipe uses the measured safe distance (9 m); the gate checks the stake stays anchored |
| R12 | The verb-only traps hit apes lightly (0.7-3.4 HP) | They gate "built from M1's verbs" (rule 1); the staged `it`s gate the ruler-scale physics; both must pass |

### 11.9 AC-9 rehearsal (non-gating) — `ac9.rehearsal.test.ts` (P39)

A headless stand-in for the SPEC:906 playtest (RT-12), run before P38's human playtest. World: `scene 'clearing'`
(seed S), the ape of home A with its brain on. A scripted player (commands only) takes the starter axe, walks toward
home A until the ape notices him and fights, brawls (DS moves, the stone axe) until the ape is at ≤ 20 HP, then follows
one documented route to finish it with the world: knock it toward home A's snag (sharpness 0.45, §6.7) with kicks, or,
if the ape flees, drop a carried 40 kg log on it when it is down. It must reach `ko { environmental: true }` within
36,000 ticks (10 min); the test logs the time, the route and the finishing cause. It is not part of the M1 gate and
not part of `npm test`: `vitest.config.ts` (P23) excludes `**/*.rehearsal.test.ts` unless `ROTW_REHEARSAL=1`, which the
root script `npm run test:rehearsal` (P05) sets. A failure files an AC-9 risk and pulls a §4.15 lever before the human
playtest, never after.

## 12. Spec departures and ambiguities

### 12.1 Departures (the spec's text says one thing; we do another)

Each quote is verbatim from `docs/SPEC.md`. Code at each site carries a comment naming the departure (SPEC rule 1 of
reading: flag, don't quietly break).

| # | Spec line (quoted) | What we do | Why |
|---|---|---|---|
| X1 | SPEC:699-700: "2. `CombatSim` for active fights; it proposes each fighter's movement. 3. Move fighters and creatures in the sim's Rapier world: character controllers resolve the proposed movement …" | Controllers run **inside** `CombatSim.stepBody()` at the `separate()` site through `FighterMover`; zone posing stays after it (phase 4). | CombatSim's hits must see resolved positions in the same tick: resolving after the step put strikes up to 6.1 cm off (MAP gap-1 §3.1). SPEC:377 ("`CombatSim` proposes … and the character controller resolves it") still holds. |
| X2 | SPEC:378: "the player's root becomes a dynamic capsule in the sim's Rapier world until they get up"; SPEC:890: "downed and launched bodies get a sim-side dynamic capsule." | A pre-created dynamic **rounded slab** (0.48 × 1.81 × 0.20 m × scale), enabled while down. | A lying capsule rolls 8.07 m in 5 s down a 10° slope and never rests; the slab rests up to 40° (MAP gap-4 §3). |
| X3 | SPEC:876: "Zone mass shares (humanoid, by `HurtZone`) … head 7.5%, chest with arms 31.1%, abdomen with pelvis 24.6%, legs 36.8%" | m_eff uses the struck **bone's** share (`BODY_MASS_TUNING.boneKg`, a live table); the HurtZone totals stay registered as its `zoneShare` read-out and behind `massShareMode: 'zone'`. | Orchestrator decision 2 (D-2): by HurtZone one stake under a 3 m fall gives ≈ 23,400 HP (twice the ruler's HP) and the pit kills it in 45/108 runs; by bone it gives 3,713 HP (spec calibration 2,982, SPEC:301) and 4/108 (C F8). |
| X4 | SPEC:280: "On a started event, take the contact normal from `collider.contactCollider(other, …)`" | Sensor normals come from `Shape.castShape` between the start-of-previous-step poses (fallback −v̂_rel). | `contactCollider` gave normal (0,1,0) and v_n 0 in 3 of 4 cases; the cast was right in 4 of 4 [A lab: normals.mjs] (orchestrator decision 5). |
| X5 | SPEC:261: "its tension is T = m × (g − a) · û, where m is the hanging body's mass …" | A per-body non-negative least-squares fit over all of the body's taut ropes (6 equations); equal to SPEC:261's formula for one rope at the COM. | The formula reads a body on several ropes wrongly: the swinging log's horizontal tie read 0 N instead of 5.1 kN; the fit matched statics within 1 % and the swing peak exactly [C lab: e3_swing, F5]. |
| X6 | SPEC:241: "the removed earth becomes a dirt pile entity of the same volume" | Piles (merged up to 150 kg) while fewer than 12 lie within 10 m of the spoil point; beyond that the same volume is added to the terrain at the pit's rim as spoil. Volume is conserved. | A ruler pit is 118 m³ = 177 t = ~1,180 piles at the drag cap (C F9), over the 600-active-body budget (SPEC:803) and, placed beside the dig, inside the pit itself. |
| X7 | SPEC:782: "It gets up after 4 seconds"; SPEC:879: "up after 4 s" | The rise **starts** at +4.00 s and takes 94 frames (ends +5.57 s). | DS's 1-frame kneel key swept the giant's zones at 398.8 m/s; 94 frames peak at 13.05 m/s (MAP gap-3 §2.3). |
| X8 | SPEC:866 (M0 criterion): "the client still runs DungeonStyle's training ring (`?mode=training`) unchanged." | The ring retires with the arenas; `?mode=training` opens the Clearing with a sparring ape 3 m in front of the player (respawns 3.2 s after its KO). | Orchestrator decision 3 (D-50): cheap, and it keeps a fast brawl loop in dev mode on the new terrain. |
| X9 | SPEC:774: "Navigation meshes per terrain chunk …" | One tiled navmesh per agent class over the whole Clearing (human r 0.4 m, ruler r 1.65 m). | The Clearing is one logical chunk (D-7); tiles give the local rebuilds the spec wants (MAP recast §10.2). |
| X10 | SPEC:710: "`button`: punch, kick, parry or pick up." | `button` also carries `'jump'`; `move` carries sprint/crouch flags. | D-28 (orchestrator decision 1). |
| X11 | SPEC:711: "`verb`: the verb, the target entity's id, an optional second target (for lash and bend), and a placement position and angle (for place)." | `verb` also carries `at2`, `pitch`, `aim`, `charge`, `slot`, `drive`, and a `focus` verb. | Throw aim (D-29), continuous verbs (pull, shape, hand-dig), belt slots, anchor points on the second target, point-up placement (D-49), and aimed strikes (MAP gap-5 §1.3). |
| X12 | SPEC:712: "`meta`: pause, save, and the time away when a save loads." | `meta` also carries `'dev'` ops (spawns, teleports, pauses, give tool). | Dev actions go through the command log so replays stay exact (rule 7). |
| X13 | SPEC:233: "Chop a tree (it falls away from the cut side, as a dynamic body), split a log …" | "Split a log" is a cross-cut in two across the axis; lengthwise splitting is not in M1 (TODO "lengthwise split"). | Stakes and props of a chosen length are what traps need; breaking already splits along the axis (§4.10). |
| X14 | SPEC:421: "you **respawn after 10 seconds** at the nearest lit beacon, or at the Landing." | Respawn after 10 s at the Clearing's spawn point. | D-33: M1 has no beacons and no Landing (M3). |
| X15 | SPEC:370: "New for the Wild: **jump** and **climb** (low ledges, vines, fallen trunks), plus swimming." | Jump is a button; climb = autostep over low ledges and trunks (0.4 m × scale); vine climbing and swimming wait (M2+). | D-28 (orchestrator decision 1); there is no water before M2. |
| X16 | SPEC:235: "Carry, drag, roll \| Lift up to 40 kg alone, drag up to 150 kg, roll heavier round things." | No roll verb in M1 (TODO "roll verb"): logs, boulders and pieces are prisms and hulls that rest. | SPEC:869 lists carry and drag, not roll; round logs never rest (C F2) and AC-6 needs a boulder that doesn't roll (D-22). |
| X17 | SPEC:754: "Sight: a cone and a range per species, blocked by terrain and dense foliage." | Sight is blocked by terrain and entities ≥ 100 kg; foliage doesn't block it in M1 (TODO "dense foliage blocks sight"). | The canopy has no collider in M1 (TODO "canopy collision"); undergrowth arrives with M4 biomes. |
| X18 | SPEC:756: "Smell: players, bait and carcasses drop scent points …" | No smell in M1. | Scent drifts with wind (M2). |
| X19 | SPEC:194-202: the material table's seven properties (density … friction) | An eighth property, `armourJ` (hide 20, bone 40, others 0), read by the armour rule. | SPEC:192 "every rule reads properties, never material names" and SPEC:885 gives armour by material: a property is the only way to have both (RR-3). |
| X20 | SPEC:417: "nothing against a ruler (whose blows deliver tens of thousands of joules)"; rule 9: "a ruler flinging a player across a valley" | The giant's charge does 269-366 J, 14.9-20.3 HP, and flings at 5.85-6.83 m/s, because SPEC:278 takes m_eff from the struck zone. Two off-by-default levers (`creatureRestitution`, `unbackedTargetMassRatio`) are tuning, TODO "ruler blows (SPEC:417)". | A conflict inside the spec (SPEC:278 against SPEC:417 and rule 9), flagged rather than resolved silently; the calibrated numbers stand until the AC-9 playtest asks (RR-6, §4.4). |
| X21 | SPEC:171: "carcasses" are entities; SPEC:384: carcasses go in the hands | An ape's corpse is its slab until removed (120 s and the player > 40 m away); the giant's stays; no carcass entity in M1 (TODO "carcass entity", M4 with smell and bait). | M1 has no use for a carcass (no smell, no bait rule); converting a body to an entity of the right mass and shape is M4 work (RR-11). |
| X22 | Rule 3: "If it looks like it should work, it works" | Trees have no canopy collider in M1; a falling or felled crown is drawn collapsed against the trunk (within 0.15 m of its collider) so nothing visibly passes through a body unscored. TODO "canopy collision (rule 3)". | A crown collider of the drawn size would weigh tonnes at the leaves' 100 kg/m³ and change the measured fall; the draw is fitted to the collider instead (RR-15). |

### 12.2 Interpretations (the spec is ambiguous; this is our reading)

| # | Spec line (quoted) | Our reading | Why |
|---|---|---|---|
| I1 | SPEC:279: "store … the animated velocity of every hit zone … compute v_n from those stored velocities." | A kinematic zone's velocity is the **previous** tick's rig delta. | Rapier's narrow phase tests start-of-step poses: an event at step N is the overlap of the poses set a tick earlier [A lab: timing.mjs]. |
| I2 | SPEC:284: "for a body hitting the ground or a wall, first subtract the energy of a safe landing … v_safe = 6 m/s for humans (starting value; set per species)." | Only blunt (s = 0) impacts of a creature against terrain or fixed/anchored bodies; v_safe = 6·√scale. | D-4; without it the AC-5 trip is a 637 HP wound (C F13) and falling over costs the giant thousands of HP. |
| I3 | SPEC:782: "While tripped it's an ordinary dynamic body"; AC-5 "no body part faster than 30 m/s" | One compound dynamic body, one collider per bone; the nine named zones are a classifier on the contact point; "body part" = each collider. | D-35 (orchestrator); stable at 14 t (MAP gap-3). |
| I4 | SPEC:878: "At least 1 t of dynamic mass resting on the ruler" | D-38: mass of dynamic bodies in contact from above (normal·up < −0.5), transitively, ≥ 1,000 kg, off below 900 kg for 15 ticks. | D-38 is binding; MAP gap-3's carried-weight reading is recorded as the alternative (§4.7). |
| I5 | SPEC:879: "struck faster than 4 m/s" vs SPEC:782 "while it moves faster than 4 m/s" | The ruler's root horizontal speed. | D-10. |
| I6 | SPEC:781: "A charge that meets a blocking wall at under 30° is deflected along it" vs the trip rule | Deflect first (< 30°), then trip (band and speed), else block. | D-11; AC-5 and AC-6 need both. |
| I7 | SPEC:305: "the momentum an impact would transfer is checked against its trip rules instead" | A leg impact between ankle and knee by a blocking-class impactor (≥ 500 kg or anchored) above 4 m/s trips; other momenta are dropped. | MAP gap-2 §8e: an 800 kg boulder at 8 m/s gives 14 t only 0.43 m/s. |
| I8 | SPEC:782: "when it steps off a ledge" | A front-foot terrain drop > 0.5 × knee height (1.4 m at 5.5). | D-9 (e). |
| I9 | SPEC:255: "An impact on either body exceeds the lashing's break energy" | Lashing break energy = rope strength × strands × 0.1 m (vine 600 J, sinew 1,800 J). | D-18. |
| I10 | SPEC:344: "An impact above it lowers integrity in proportion" | Δintegrity = (E − E_b)/E_b × 1. | D-17. |
| I11 | SPEC:345: "loads on a cover spread over the pieces under them" | Equal shares over the supporting pieces, recursively (depth 4), for foot loads and resting weight. | D-39; contact impulses split 0-163 N unevenly and broke branches under their own leaves (C F7). |
| I12 | SPEC:882: "One stone-axe chop per 2 cm of trunk diameter (a 30 cm trunk takes 15)" | 2 cm per chop scaled by the tool's fresh chop energy over the stone axe's 339 J (clamped 0.5-2.5); the trunk falls at the 15th chop, or earlier when a pull or push beats a hinge capacity ∝ (remaining diameter)³, away from the cut side; the trunk hinges at the uncut edge and lands on the fall line. | Keeps the spec's count literal; the felled-tree trap (SPEC:443) needs a pullable hinge (D-44; C F10; §4.12). |
| I13 | SPEC:415: "a kill is environmental when the finishing damage came from a world entity, or from a hazard the creature was knocked into within the last 2 seconds" | A world entity not held or thrown by anyone (thrown objects count as held until first contact or rest), or terrain within 2 s (inclusive) of a knock. | D-31: otherwise every throwing kill would be environmental. |
| I14 | SPEC:899: "Headless test scenes built only from entities and verbs" | Each AC-2 trap has a verb-only gate (every entity at a mass the verbs move, every pose and relation from a verb; natural features from the generation factory) **and** a staged physics `it` where heavy entities (> 40 kg carry) are spawned at their pose or held still (`stage`) while the player ties them; a fixed scaffold box lets the player reach a high tie. | D-25 allows staged heavy scenes; rule 1 needs the trap to be buildable with the rules, so both gate (RR-5, RT-8). Reach is rule 3. |
| I15 | SPEC:901: "with every hit counted as a perfect counter" | Fixture state set before each step (`counter` window + `perfectCounter`); the player re-placed by logged dev teleports. | No command can express it (MAP gap-6 §3e). |
| I16 | SPEC:902: "With its AI paused once it's up" | The mind is paused **and** idle life is paused (`idlePaused`: no weight shift, look-around, feint or breathing). | Idle life is behaviour; breathing a 10 m body could move it past 0.05 m/s and mask the stability the test measures. |
| I17 | SPEC:900: "a scripted player lures the giant ape" | The giant's brain is on and it is lured by seeing the moving player; a scripted-charge variant runs alongside. | "Lures" is the giant's own behaviour; AC-2 is where creature actions may be scripted. |
| I18 | SPEC:900: "pulls a rope from at least 15 m away" | Horizontal distance from the player's root to the rope's tie point at the tick the hinge breaks (20.6 m at P = (18, 1)). | C §3.3: the test places P by distance. |
| I19 | SPEC:903: "a log falling onto the player doesn't stop dead as if it hit a wall" | D-23: one step after first overlap, the log keeps ≥ 80 % of its speed and comes to rest on the terrain. | D-23 (orchestrator); measured 85.7 %. |
| I20 | SPEC:585: "A trap hit on a ruler that creates a wound." | Moment kind `worldWound`: a wound whose cause is an unheld entity (`byWorld`). | AC-1 forbids "trap" in any type or kind. |
| I21 | SPEC:869: "one ruler prototype on the same rig (a giant ape: patrol, investigate, chase, a straight-line charge …)" | The charge's leading zones hit through the rule; no other ruler attack in M1; a close charge (< 7 m, 0.6 s telegraph) answers a player under its feet. | D-34. |
| I22 | SPEC:238: "including point-up stakes driven into soft ground" | Placing upright on soft ground drives the object when it has a sharp point at its top end (or when the player asks); a blunt stick set upright stays free (a prop). | A driven prop could never be yanked out (SPEC:237); D-19, D-49. |
| I23 | SPEC:97: "a heightmap in chunks (starting value: 64 m chunks)" vs SPEC:869 "A 200 m × 200 m heightfield chunk" | One logical 200 m chunk of 8 × 8 tiles of 25 m at 0.25 m; 64 m stays a tuning value for M3. | D-7 (orchestrator). |
| I24 | SPEC:237: "Pull … tug from up to the rope's length away: yank out a prop" | 500 N sustained (D-26) plus a 1,200 N yank for 0.15 s when the rope goes taut, applied hand over hand (the haul model, §4.9). | Springing a deadfall takes 492-1,277 N inward [C lab: e1c_pull]. |
| I25 | SPEC:503: "a broken leg (it limps …), a lost eye (a blind side), a broken tusk or jaw (weaker attacks), deep burns" | Skull → `weakJaw`; torso zones and arms → `winded` (charge cooldown × 1.5, chase speed × 0.85). | Every severe wound must change behaviour and the spec's list has no torso or arm entry; `winded` is the mildest change (RR-10). |
| I26 | SPEC:891: "move `nextId` and `usedSlots` into the world" | `nextId` → the sim world's `IdCounter`; `usedSlots` → the client's `PresentationWorld` (the ragdolls' world). | Ragdoll collision slots are presentation (rule 6); the sim must not know about them (D-42, RR-20). |
| I27 | SPEC:258: "stiffness from springiness × trunk thickness" | `stiffness = bendK × springiness × d²`. | A bending stiffness grows with the section, not the diameter; d² keeps a 6 cm sapling at 864 N·m/rad and a 12 cm one 4× stiffer (RR-20). |
| I28 | SPEC:712: "`meta`: pause, save, and the time away when a save loads" | `meta 'pause'` is accepted and does nothing in the sim; pausing is the game loop's (rule 8). | A paused sim is a sim that isn't stepped; the loop already does that (RR-20). |
| I29 | SPEC:504: "**down** (tripped, or in a pit)" | In a pit = both planted feet (or, tripped, the pelvis) more than 0.5 × knee height (1.4 m) below the original ground; down = tripped or in a pit. The giant climbs out slowly (0.4 m/s) and is down until it is out. | The spec doesn't define "in a pit"; the ledge threshold is the scale where the ground stops being a step (RR-1). |
| I30 | SPEC:900: "The player is never within 10 m when either trap springs" | Horizontal distance from the player's root to the nearest point of every collider of the springing trap (cover and its pieces, the pit, the released trunk and stump) and of the giant, at the spring tick, over the whole pacing range. | Stricter than D-43's centroid reading (so D-43's holds too); with a centroid an 8 × 6 m pit let the player stand 5.7 m from its cover (RR-4, RT-10). |
| I31 | SPEC:566: "Use player IDs and credit from the start" | Commands carry a player number (1 = `'p1'`), mapped by the world to that player's fighter. | Fighter ids are internal to a world; in multiplayer commands come from players (RR-18). |

### 12.3 Disagreements between the drafts, resolved

| # | A-core | B-gameplay | C-feasibility | Choice and why |
|---|---|---|---|---|
| R1 | Entity solver groups "all" (A §2.10) | — | Solver membership = own bit only (F4, measured: "all" stops a falling log dead on the player) | **C**: measured, and it is what makes AC-6 part 2 pass (§2.11). |
| R2 | Rope tension per end, shared per body pair (A §4.9) | — | Per-body 6-DoF NNLS (F5) | **C**: the per-end formula reads a horizontal tie as 0 N; NNLS matched statics within 1 % (§4.9; departure X5). |
| R3 | Resting loads from contact impulses (A §4.11) | — | Equal shares (F7) | **C**: impulses split 0-163 N and broke branches under their own leaves (§4.11). |
| R4 | Felled trunk free-tips (dynamic + 0.15 rad/s) once the hinge breaks (A §2.5) | — | Hinge model: revolute at the notch edge, contacts off, torn at 75° (F10) | **A's fixed-until-the-hinge-breaks + C's hinge fall**: lands on the fall line ±0.2° instead of 19-39° toward the pull; the spec's "falls away from the cut side" (SPEC:233) is the hinge geometry (§2.5, §4.12). A's hinge capacity formula is kept and the gravity back-moment added (I verified the numbers). |
| R5 | `refChopJ` 301 J (machete) and the blow's energy (A §2.5) | 339 J, the stone axe's **fresh** energy (B §3.2) | — | **B**: SPEC:882 names the stone axe; the blow's stamina factor would make a tired player need up to twice the chops. |
| R6 | `world/clearing.ts` owned by CORE-4 (A §1.2) | GEN-1 owns `clearing.ts`, `factory.ts`, `cover.ts` | — | **B**: the brief gives generation to gameplay; the entity store stays core (P06 vs P07/P21). |
| R7 | `CLEARING_TUNING`: 12 vines 6-20 m, stones 2-40 kg, branches 1-8 kg | 12 hanging vines + 6 coils, stones from 0.5 kg, branches to 13 kg, logs, snags, gates, ledge, rim, route, cache | — | **B**: hanging vines give a high anchor without climbing (rule 3), small stones feed the throw class, snags and the cache serve AC-9. |
| R8 | `WorldEvent wound { trap: boolean }` | rename `byWorld` | AC-1 scans property names | **B**: a field named `trap` fails AC-1. |
| R9 | `SaveV1` without minds, verbs, spawner, cover | adds them | — | **B** (§8.3). |
| R10 | Pull 500 N whenever taut | + 1,200 N yank for 9 ticks | props need 492-1,277 N | **B** (SPEC:237 "yank out a prop"; I24). |
| R11 | Mind state for a tripped giant: none | `'tripped'` | — | **`'down'`**: one name per concept; `'tripped'` is the body state. |
| R12 | `RulerState` class with a `tripped` flag | — | — | **Data + functions**, no `tripped` flag: down = `f.state === 'tripped'` (one source of truth; saves trivially). |
| R13 | — | throw speed 15 m/s for stones (DS `throwOne`) | — | **D-29 (binding)**: 20 m/s for every object ≤ 2 kg. |
| R14 | Nav ruler layer extrudes every blocker | — | "the covered pit must be walkable to the ruler's path" (§6.4) | **Integrator**: extrude only blockers rising above the original ground + 0.39 m, so stakes inside a pit don't punch holes in the cover's walkable surface (§7). |
| R15 | MAP recast §10.8: charges use the nav `raycast` | a hip-height physics probe (B §8 item 11) | — | **B**: the extruded ruler layer would never charge across a staked log, so funnels and trip logs would never work in play. |
| R16 | Ape mass: cube law 97.56 kg | cube law | asks to pick (2.5 law 93.0 kg) | **Cube law** (SPEC:660 "mass with size³"). |
| R17 | — | AC-3 recipe: a tree spawned with a hanging vine 10 m up; the player takes its end | "lash an 18 m vine 10 m up the trunk" via `standAt` | **B**: a standing player can't tie 10 m up (rule 3); the rope, anchor height, length and pull are the same, so C's numbers stand. |
| R18 | — | swinging log: hanging vines from two trees, a scaffold box | two vines from one tree's branch points 8 m up, a tie to a stake | **B, made concrete**: `stage` holds the log while the player ties it from a scaffold, and the tie goes to a fixed post (a horizontal tie keeps C's 5.09 kN; a tie angled down to a ground stake carries 5.1 kN ÷ cos θ, already 10.2 kN at 60°, over a vine's 6 kN). |
| R19 | — | — | AC-6: `v_after ≥ (m/(m+M))·v_before − 0.1` (78.7 %) | **D-23 (binding)**: ≥ 80 %, which is stricter and still passes (85.7 %). |
| R20 | — | — | AC-3 brain on or scripted, "both allowed" | **Brain on is the gate** (I17); the scripted `it` isolates physics. |
| R21 | — | — | AC-2(b): build the pit per run | **Build once, save, load per run** (≈ 3 min per build at real strike cadence). |
| R22 | Dirt piles beside the hole, merged ≤ 150 kg | — | piles exceed the body budget (§6.5) | **Integrator**: rim spoil after 12 piles (X6). |
| R23 | Pieces from breaking: no grace | — | spawn them without contacts against the breaker for 10 ticks | **C**, as a group-filter grace (no per-pair hooks; §4.10). |
| R24 | Place: upright on soft ground always drives and anchors | same | the deadfall needs a free prop | **Integrator**: drive only pointed objects by default; `drive` field (I22). |
| R25 | Strikes on entities: chop, dig, clang only | same | — | **Integrator**: a strike on a free dynamic entity pushes it by the rule's energy (SPEC:432 "kick out a prop"; §5.2). |
| R26 | `aiNearM` 60 m, ruler `lockScale` 2, `pullForceN` 500 N | agree | agree | Kept. |

### 12.4 Named TODOs left in the code (M1 scope cuts and open questions)

Scope cuts (the TODO text in quotes; the file where it sits):

| TODO | Site |
|---|---|
| "canopy collision (rule 3)" | `world/felling.ts` (trunk shape on fall), `render/forestView.ts` (crown draw) |
| "dense foliage blocks sight" | `world/creatures/perception.ts` (the occlusion ray filter) |
| "impact gore" | `sim/impact.ts` (`applyImpact`, the gore row) |
| "crush rule" | `world/damage.ts` (the m_eff table) |
| "rope tension with contacts" | `world/joints.ts` (the NNLS fit) |
| "roll verb" | `world/verbs/targets.ts` (`verbsFor`) |
| "lengthwise split" | `world/verbs/cut.ts` |
| "limp gait" (if `FootworkStyle.limp` is not built) | `body/footwork.ts` |
| "jaw weakens bite attacks" | `world/creatures/rulerMind.ts` (`weakJaw`) |
| "prop strain readability" | `render/entityViews.ts` |
| "move arena fixtures to tests/support" | `world/collision.ts`, `arena/themes.ts` |
| "ruler nav radius" (1.65 m vs the lab's 2.5 m) | `world/nav.ts` |
| "carcass entity" | `world/deaths.ts` (corpse timer) |
| "ruler blows (SPEC:417)" | `sim/impact.ts` (`creatureRestitution`, `unbackedTargetMassRatio`) |
| "ruler-bone armour value" | `world/materials.ts` (`rulerBone.armourJ`) |
| "rule 11 (multiplayer): damage from an entity credited to another player knocks down, never kills" | `sim/impact.ts` (the HP line of `applyImpact`) |
| "multiplayer: check for death, not KO (SPEC:423)" | `sim/combat.ts` (the limb rule, combat.ts:1199) |
| "rule 5 rests on DS stamina here" | `sim/ruler.ts` (`rulerTick`, the recovery line) |

Open questions (CLAUDE.md, SPEC:14: "use the default … and leave a TODO that names the question"; RR-21):

| Open question (SPEC:977-990) | Default used | TODO text | Site |
|---|---|---|---|
| SPEC:982 "Does the world keep living while the game is closed?" | No; only traplines catch up (none in M1) | "open question SPEC:982 (world alive while closed?): default no — the hidden tab pauses, time away only reaches traplines (M3)" | `apps/client/src/game/loop.ts` (the `visibilitychange` pause) and `sim/commands.ts` (`meta 'timeAway'`) |
| SPEC:983 "How long a world should take to tame" | Tune toward 15-25 h | "open question SPEC:983 (taming time): ruler HP is the lever" | `sim/species.ts` (`giantApe.maxHp`) |
| SPEC:981 "Fauna: dinosaurs and giant mammals together, or one kind?" | A mixed lost world | "open question SPEC:981 (fauna)" | `sim/species.ts` (`SpeciesId`) |
| SPEC:984-990 (mobile, monetisation, name, multiplayer questions) | Their defaults; nothing in M1 reads them | none needed in M1 code | — |

## 13. Implementation plan

### 13.0 Rules for every package

- **Ownership.** "Owns" lists the only files a package edits (paths relative to `packages/sim/` or `apps/client/`
  unless written in full). New files are created by their owner, or as stubs by P05 (sim) and P31 (client) with their
  final exported signatures from §1, after which the listed owner fills them. No two packages that can run at the same
  time own the same file (§13.2 checks it wave by wave).
- **Extension points defined up front**, so shared files are touched once: the shared types, the command union and
  the `sim/ruler.ts`/`sim/impact.ts` placeholders with their final signatures and tables (P01); every Fighter field and
  CombatSim seam (P02a) and their world-mode readers (P02b); the record accessors (P04); the tick pipeline with every
  phase call, `index.ts` with every export, every tuning table registered with its §9 values, and every package.json
  pin and script (P05); each system's `toRecord()/restoreRecord()` stub, assembled by the save (P13); `game.ts` with
  every call into the client modules and `game/ports.ts` with every interface they implement (P31); the test harness
  API and the root Vitest config (P23). A tuning table is never added after P05; new keys go into the owning module's
  table.
- **Change protocol.** A package that needs a change in a file it doesn't own asks that file's owner while the owner is
  open; after the owner has merged, a small follow-up package (`Pnn-fix`) owns the change and is scheduled when no
  running package owns the file. The integration branch merges in dependency order; CI runs `npm test` and `npm run
  typecheck` on every merge.
- **Every package's definition of done includes**: all legacy test files green (DS's files minus the retired ones, plus
  M0's), `npm run typecheck` green, its own new tests green, the sim purity test (no `Math.random`, `Date.now`,
  `performance.now`, `addForce`, `addTorque`, `addForceAtPoint`, `takeSnapshot` in `packages/sim/src`; from P05) and the
  AC-1 test (from P24) green, every new tuning key registered with unit and source (the registry test), and, for a
  package that owns a stateful system, its `toRecord()`/`restoreRecord()` implemented with a round-trip test.
- Sizes are rough developer-days (S ≤ 2, M 3-4, L ≥ 5). Risk: Low / Medium / High with the reason.

### 13.1 Work packages, in order

**P01 Types, commands, registry, placeholders** — S, Low. Depends on: the cleanup commits (HEAD `eb1bd13`).
- Owns: `src/world/types.ts` (new), `src/sim/commands.ts`, `src/tuning/registry.ts` (new), `src/index.ts`; empty
  placeholder modules (`export {}`) `src/sim/rules.ts`, `src/world/materials.ts`, `src/world/shapes.ts`,
  `src/sim/species.ts` (filled by P02a/P03); **placeholders with final signatures and registered tables**
  `src/sim/ruler.ts` (`rulerVolumes`, `RULER_TUNING`, `RULER_ZONE_TUNING`, …; filled by P11) and `src/sim/impact.ts`
  (`applyImpact`, `isEnvironmental`, `IMPACT_TUNING`; filled by P09) (RF-8); `tests/registry.test.ts`,
  `tests/commands.m1.test.ts`.
- Content: every type of §2 and §1.5.2 (seam interfaces), the command union of §1.5.3 (player numbers, `setTuning`)
  with the focus-dedupe rule, the registry of §1.5.11 (`setTuningValue`), index exports for these.
- Tests: snapshot/restore round-trips; `tuningOverrides` lists exactly the changed keys, sorted; `setTuningValue`
  rejects an unknown key or a wrong type; a table with a leaf lacking metadata throws; `CommandQueue` keeps only the
  newest `move` and the newest `focus` per tick and player and keeps verb/meta order; command JSON round-trips exactly.
- Done: types compile against HEAD's sim; legacy tests untouched and green.

**P02a Seams: the legacy-identical core** ★ — M, Medium (hot paths of combat.ts must stay bit-identical). Depends on:
P01.
- Owns: `src/sim/math.ts`, `src/sim/fighter.ts`, `src/sim/roster.ts`, `src/sim/enemies.ts`, `src/sim/combat.ts`,
  `src/sim/ai.ts`, `src/sim/weapons.ts` (the `sharpness` field only), `src/body/footwork.ts`, `src/body/idle.ts`,
  `src/body/mass.ts`, `src/sim/rules.ts`; `tests/seams.test.ts`, `tests/rng.test.ts`, `tests/legacyReplay.test.ts`,
  `tests/bodyMass.test.ts`, `tests/fixtures/legacy-fight.json` (recorded at HEAD before any change).
- Content: `Rng` state and wrap, `seedFor`; `IdCounter`/`LEGACY_IDS`/`rngSeed`; all Fighter fields of §1.5.3,
  `'tripped'`, `enterGetup(frames, keys)`, `startWork`, FK-only `updatePose` for tripped; `FootworkStyle.limp`
  (optional); `idlePaused`; `BODY_MASS_TUNING` and the share functions (§1.2); `GroundQuery`/`FLAT_GROUND`;
  `beginTick`/`stepBody`; `mover`, `ground`, `world`, `physicsOwnsDowned` with the deprecated `externalKnockdown`
  alias; `playerFighter`; `koFighter` at every KO site and the `ko` event; `lastKnock` at DS knockback sites;
  `blowDamage`; the toughness line; `Brain` with `ownsTarget` and `cfg`; the y = 0 sites of §4.1; `DAMAGE_TUNING`,
  `MOVE_TUNING`, `hpFromEnergy`, `launchSpeed`, `zoneToughness`, `boneMass`, `reducedMass`, `impactEnergy`.
- Tests: `Rng` outputs equal the old ones for 10⁶ draws and `state` round-trips; two `IdCounter` worlds number fighters
  1..n identically without `vi.resetModules`; a recorded legacy fight replays to HEAD's fighter-state hash and event
  stream plus exactly one `ko` per KO; the flat-ground raise test (every fighter on a constant ground 0.5 via a
  `GroundQuery`: strikes still land, MAP tests §7.5 C2); `koFighter` is idempotent; `T = 0` leaves `hit()` damage
  bit-identical; the default `boneMassShares()` equal the old constants bit for bit and no sim file reads the
  read-out constants (grep); `externalKnockdown` and `physicsOwnsDowned` read and write the same flag;
  `sim.ais.get(e)!.cfg` type-checks (styles.test.ts, size.test.ts unchanged).
- Done: all legacy files pass unchanged with every seam null; the client still type-checks (game.ts:181 writes the
  alias).

**P02b Seams: the world-mode readers** — M, Medium. Depends on: P02a, P01 (the ruler/impact placeholders).
- Owns: `src/sim/combat.ts`, `src/sim/fighter.ts` (the reader regions); `tests/seams.world.test.ts`.
- Content: relative `weaponFit`/`heightGap`/`canReach` and `verbAim`; the ruler branch call in `hit()` and the
  `d.ruler` gates; the world-mode projectile rule path (`ruleDamageHp`) without the 2-D wall test, and the `addDrop`
  assertion (RF-6); `drive`, `moveFlags`, `load`, `work`, `throwAim` readers in `locomote`, `tickTimers`,
  `advancePickup`, `release`, `stepProjectiles`; `autoDefend` skipped while carrying or dragging, no strikes with a
  carried non-tool load, punch presses → `pull` while holding a rope end (RF-25); `separate()`'s ruler skip (RF-5);
  the `fatal`/`sever` gate (RR-12); the §12.4 TODOs in combat.ts.
- Tests (fake `WorldPort`): `drive` reaches its speed at `accel` and turns at `freeTurnRate`; a projectile 3 m up over a
  non-walkable cell keeps flying in world mode and hits a wall in legacy mode; `separate()` doesn't push a player away
  from a ruler closing at 2 m/s and does at 0.5 m/s; with T = 40 J a 30 J blow can't split a skull; a carried log
  blocks strikes; legacy files unchanged.
- Done: every world-mode reader of §1.5.2 exists and the legacy replay is still bit-identical.

**P03 Materials, shapes, species** — S, Low. Depends on: P01. Parallel with P02a.
- Owns: `src/world/materials.ts`, `src/world/shapes.ts`, `src/sim/species.ts`; `tests/materials.test.ts`,
  `tests/shapes.test.ts`, `tests/species.test.ts`.
- Content: `MATERIALS` (16 rows, the `armourJ` column included) and predicates; `shapeVolume`, `colliderDesc` (cylinder →
  N-gon hull), `triangulate`, `fracture`, `crossCut` (also the load-break snap), `taperEnd`; `SPECIES_BODY`.
- Tests: materials equal SPEC:206-223 exactly, hide/bone `armourJ` SPEC:885; mass = density × volume per shape kind;
  prism volume formula; fracture and crossCut conserve volume within 1 %; `taperEnd` of a 1.4 m × 5 cm prism removes
  0.65 kg and puts the tip on the axis; the 0.7 − 0.5 ≥ 0.2 margin passes with the epsilon; bone masses of §2.7.
- Done: registered tables match §9.

**P04 Record accessors** — M, Medium (completeness). Depends on: P02b (nothing else edits these files after it).
- Owns (append-only regions): `src/sim/fighter.ts`, `src/sim/ai.ts`, `src/body/animator.ts`, `src/body/footwork.ts`,
  `src/body/idle.ts`; `tests/records.test.ts`.
- Content: `toRecord()`/`restoreRecord()` for Fighter, BrawlerAI (its 20 history fields), Animator (key poses by
  value), Footwork, IdleBehavior, per MAP gap-7 §3.4-3.7.
- Tests: record → restore → record is identical for fighters mid-attack, mid-step, knocked down; the record's key set
  equals MAP gap-7's *Save* inventory (a checked list); `Infinity` fields survive.
- Done: a legacy fight saved and restored mid-way continues bit-identically (in-process).

**P05 World skeleton, physics, terrain** ★ — L, Medium (WASM init in Vitest and Vite; many stubs). Depends on: P02a, P03.
- Owns: `src/world/world.ts`, `src/world/worldTuning.ts`, `src/world/physics.ts`, `src/world/groups.ts`, `src/world/rngs.ts`, `src/world/queries.ts`,
  `src/world/terrain.ts`, `src/index.ts`, `packages/sim/package.json`, `apps/client/package.json` (the Rapier pin only),
  root `package.json` (`test:accept`, `test:rehearsal` scripts), `package-lock.json`; creates stubs (with registered
  tuning tables) of every other new sim file in §1.3 not created by P01, `world/devOps.ts` included (RF-19);
  `tests/terrain.test.ts`, `tests/physicsWorld.test.ts`, `tests/worldSkeleton.test.ts`, `tests/simPurity.test.ts`.
- Content: `physicsReady`, `PhysicsWorld` (groups, owners, pre-step store with history, the phase-8 post-step snapshot,
  sorted drain), `WorldRngs`, `WorldQueries`, `Terrain` (tiles, `heightAt`, `normalAt`, `supportAt`, `lower` with the
  ever-dug mask, `raise` with the setback, `findSpoilPoint`, edits), `createWorld` and `World` with the full phase
  list of §3 calling the (stub) systems, `World.players`, `World.mover` dispatcher, `World.supportAt`, `World.dispose`.
- Tests: `heightAt` vs `castRay` < 2e-5 m over 5,000 points; a cone strike removes 0.0391 m³ and respects the 3 m floor;
  `raise` conserves volume, caps at +1 m and never raises a vertex within 1.5 m of a dug one; `findSpoilPoint` never
  returns a point within 1.5 m of dug ground; the kernel-only 8 × 6 × 2.5 m dig finishes within 3,822 strikes
  (RT-2); seam vertices equal across tiles; two `scene 'empty'` worlds step 600 ticks bit-identically; `createWorld`
  awaits the memoised `physicsReady` (a second world reuses the init); `dispose()` frees the Rapier world (P12 adds the
  navmesh part and its no-growth test over 20 create/dispose cycles); the purity grep.
- Done: `createWorld({ seed, scene: 'empty' })` steps 600 ticks; the client still builds against the new index.

**P06 Entity store** — M, Low. Depends on: P05.
- Owns: `src/world/entities.ts`; `tests/entities.test.ts`.
- Content: §2.3 bodies, id order, anchoring and `isAnchored`, impulse queue (4d), mirror, `touched`, state changes.
- Tests: bodies created and removed in id order; an anchored stake is static for m_eff; a log lashed to it (record only)
  is anchored; 40 kg log moves and 800 kg hull doesn't under 500 N impulses (no KCC yet); a free 2 kg prop under a 300 kg
  log holds 10 s with +4 iterations (MAP rapier finding 11).
- Done: entities appear, rest, sleep and mirror deterministically.

**P07 Factory** — S, Low. Depends on: P06. Parallel with P08, P12.
- Owns: `src/world/factory.ts`; `tests/factory.test.ts`.
- Content: §6.7 factories (hanging vines call `world.joints.rope`, tested in P10).
- Tests: shapes, masses and facets per factory; a 30 cm × 15 m tree is 738 kg above the cut; the starter axe's parts.
- Done: test scenes and generation can spawn every M1 entity kind.

**P08 Character bodies** ★ — L, Medium. Depends on: P06.
- Owns: `src/world/characters.ts`, `src/world/zones.ts`, `src/world/downed.ts`; `tests/characters.test.ts`,
  `tests/zones.test.ts`, `tests/downed.test.ts`.
- Content: §4.2 KCC (push queue, jump buffer, landing, teleport, tether hook, crouch height with headroom), §4.8 zones
  with pose history and `resetHistory`, §4.5 slab (hand-back with history reset and grace).
- Tests: AC-6 part 1 numbers (800 kg hull < 0.01 m, 40 kg log > 1 m in 3 s) and the collision count; grounded on a 25°
  slope; DS spacing kept (player-ape centre distance 0.693 m); `f.pos` equals the capsule's f32 pose; the slab rests on
  30°; getup across a fixed log and beside a 300 kg log; launch distances within MAP gap-4's ranges; the zone pose
  history gives `carryV` = the previous tick's delta, and 0 right after an enable, a teleport or a hand-back (RF-1); a
  crouched ape (1.39 m) walks under a log 1.5 m up and can't stand up under it.
- Done: a player and an ape walk, fight (DS melee) and get knocked down on bumpy terrain headless.

**P09 Contacts, the damage rule, impacts, deaths** ★ — L, High (event plumbing, many pair types). Depends on: P08,
P02b.
- Owns: `src/world/contacts.ts`, `src/world/damage.ts`, `src/sim/impact.ts`, `src/world/deaths.ts`;
  `tests/damageRule.test.ts`, `tests/contacts.test.ts`, `tests/impacts.test.ts`, `tests/deaths.test.ts`.
- Content: §4.3 (store use, episodes with touching counts and cooldowns, history-reset grace, released-entity grace,
  the attacking-limb exclusion, normals, v_n, self-motion, m_eff, sharpness, hard landings), §4.4 (`applyImpact`
  with Δv only for sensor targets, queued reactions, the off-by-default levers, environmental classification), §4.14
  (parts, corpses with the distance gate, player death and respawn), `ContactSystem` records.
- Tests: the calibration rows with bone m_eff within 1 %; A lab's `normals.mjs` cases (sensor cast normals) and
  `timing.mjs` (event step) as tests; a 300 kg log on the player keeps ≥ 80 % of its speed (the AC-6 measured tick) and
  the player takes damage; 417 J blunt knockdown vs 416 J hitstun at the poise edge; env window t+120 yes / t+121 no; a
  thrown spear's cause is `held`; parts doubled on an environmental kill; the player respawns 600 ticks later at the
  spawn with belt and back; **a log falling through a standing body scores one impact per episode** and a bounce
  inside 6 ticks scores none (RF-12); **a zone re-enabled, teleported or switched to sensors over a stake scores 0 J**
  (RF-1); **a kicking shin against a ruler zone scores nothing** and a player walking into a log at 3.8 m/s gets no
  damage or flinch, while a player knocked onto a sharp snag does take damage (RF-3); **a tripped ruler and a log
  exchange momentum only through the solver** (no `queueDv`, no reaction) and a standing ruler's foot gives a 66 kg
  mat no reaction impulse (RF-4); a 40 kg log thrown from the hands doesn't hit its thrower (RF-3).
- Done: falling logs and stakes hurt and kill creatures through the rule only; no other damage path exists (a grep test
  finds writes to a fighter's `hp` only in `hit()`, `applyImpact`, `bleed()` and revive/respawn).

**P10 Joints, breaking, loads, felling** ★ — L, High (stacked loads and props, rope topology). Depends on: P09. Parallel
with P11.
- Owns: `src/world/joints.ts`, `src/world/breaking.ts`, `src/world/loads.ts`, `src/world/felling.ts`;
  `tests/joints.test.ts`, `tests/breaking.test.ts`, `tests/loads.test.ts`, `tests/felling.test.ts`.
- Content: §2.4, §4.9 (NNLS from the phase-8 snapshot, strands, sensors re-posed in 4e, tripwire by root momentum with
  exemptions and queued shares, lash/hinge breaks, bend motor, held ends with the haul model, `tieHeldEnd`), §4.10
  (load-break snaps across the axis, impact fracture, grace until clear), §4.11 (coverings pass load, spanning test;
  calls `rulers.requestTrip` from P11's stub), §2.5/§4.12 (fromDir from the chopper, hinge capacity, moments, fall,
  tear, felled).
- Tests: still 300 kg → 2.94 kN; released from horizontal → ~8.8 kN peak, one vine snaps, two strands hold; the
  swinging-log statics 2.94/2.94/5.09 kN within 1 %; tripwire numbers of §4.9, and **an ape's 3,902 N crossing of a vine
  tied to an 18 kg prop holds the vine** (the queued shares don't enter the fit, RF-2); a hand reaching into a rope it
  is working on is no tripwire (RT-5); **a 30 kg log hauled by 500 N from 9 m reaches ≥ 30° within 8 s** (the haul
  model, I-2); ten rotten branches under a covering hold the player and break under a ruler foot within 12 ticks; the
  66 kg mat itself is not load-tested (I-1); a branch on flat ground is never load-broken; equal shares 68 N under the
  pit cover; **a bearer broken by a ruler foot drops in two pieces that don't rest on both rims** (RT-7); a 30 cm tree
  falls at chop 15 away from the chopper's side and lands within 1° of the fall line; pulls fell it at the §4.12
  thresholds (500 N on the fall line at remaining 0.28 yes / 0.30 no); a broken stake's pieces stay non-colliding with
  the lying giant until clear of it, and are crushed at 600 ticks if never clear (RF-7); a hanging vine from the
  factory has a loose end and is never a tripwire.
- Done: AC-2's four arrangements and AC-3's two can be assembled from entities and joints (verbs come in P14-P17).

**P11 The ruler** ★ — L, High (giant-scale physics, MAP risk table). Depends on: P09, P02b. Parallel with P10.
- Owns: `src/sim/ruler.ts`, `src/world/rulerBody.ts`; `tests/ruler.test.ts`, `tests/rulerBody.test.ts`.
- Content: §2.8 volumes and classifier, §4.6 (`rulerHit`, `rulerDamage` with strict thresholds and `downWound` =
  the wound that put it there, `rulerTick`, `rulerDown`/`rulerHeld`), §4.7 (body, mover on `supportAt` with the slope
  and step limits and the climb, ledge and cover trips, trip switch from the previous tick's motion, tripped rig with a
  fresh history, in-pit, pinned, get-up with history reset and grace).
- Tests: AC-5's numbers on a fixture log (trip at 6 m/s, rise +4.00 to +5.57 s, no NaN, parts < 30 m/s, all still within
  10 s); deflection at 20° (5.64 m/s, heading within 0.2°) and a trip at 45°; wounds above 240/1,800 HP (240.0 HP
  exactly is not a wound) and the 5 % penalty; recovery only when allowed; finishing into the down wound (the one that
  tripped or pinned it, a later wound doesn't move it; a new one when none, D-37); pinned on/off with hysteresis;
  knee and elbow spheres at the §2.8 radii; a perfect-counter axe overhead on a knee = 40.65 HP; **the best-paced axe
  rate computed from the live move and stamina data is below `recoveryHpPerS`** (RR-24); **a giant driven straight at
  the 18 m rim or a 2.5 m pit wall is blocked, never climbs it; one that gets up inside a pit is `rulerDown` and climbs
  out at ≤ 0.4 m/s** (RR-1, RF-14); **a covered pit is ground until a foot load breaks its cover, and the trip is
  `'cover'`; an uncovered 2.5 m hole trips it `'ledge'`** (RT-1); getting up over fixed stakes scores 0 HP (RF-1).
- Done: the giant stands, is driven, deflects, trips, lies, gets pinned and rises entirely in the sim.

**P12 Navigation** — M, Medium (build time, WASM traps). Depends on: P06. Parallel with P07-P11.
- Owns: `src/world/nav.ts`, `src/world/navInput.ts`; `tests/nav.test.ts`.
- Content: §7, `NavWalkable` on per-tile walk and blocker bitmaps (RF-23), the navmesh part of `World.dispose`.
- Tests: a 2 m gap passes a person and blocks the giant; felling a tree → rebuilt tiles give the same paths as a fresh
  build over 1,200 queries; a dug pit makes a detour on the human layer; a covered pit stays walkable on the ruler layer
  while a staked surface log is extruded; two builds byte-identical; `nearestRef 0` and partial paths reported; the
  bitmaps agree with `isWalkable` queries at 1,000 random points and are rebuilt with their tile; 20 create/dispose
  cycles don't grow the WASM heap.
- Done: paths on the Clearing terrain, re-paths after tile changes, deterministic.

**P13 Save and determinism** — M, Medium (any missed field blinds AC-7). Depends on: P04, P05. (It assembles each
system's `toRecord()` through the stub signatures; each system package implements its own records.)
- Owns: `src/save/canonical.ts`, `src/save/schema.ts`, `src/save/serialize.ts`, `src/save/bodyState.ts`,
  `src/save/load.ts`; `tests/save.test.ts`, `tests/canonical.test.ts`, `tests/fixtures/save-v1.json`.
- Content: §8.2-8.3.
- Tests: `-0`, `Infinity`, `NaN` round-trip; key order fixed; a world at rest saved and loaded matches within 1 cm and
  1° over 10 s (an M3 preview); the record keys of **every system** equal the inventory of §8.3 (contacts, histories,
  grace, ruler local poses included, RR-19); the v1 fixture loads; save → load → save is byte-identical for entity,
  joint, terrain (with the dug mask) and ruler records (the M1 loader's scope); `loadWorld` leaves the registry alone
  unless `applyTuning`.
- Done: AC-7's comparison has a complete writer.

**P14 Verbs: hands and tools** ★ — M, Medium. Depends on: P07, P08, P02b.
- Owns: `src/world/verbs/index.ts`, `targets.ts`, `tools.ts`, `hands.ts`, `tuning.ts`; append-only regions of
  `src/sim/weapons.ts` and `src/body/poses.ts` (all eleven M1 poses, the giant's included);
  `tests/verbs.hands.test.ts`, `tests/verbs.tools.test.ts`.
- Content: §5.0 (with re-validation at start and at `actAt`), §5.1, §5.2's classifier and `synthWeapon` (the head's
  sharpness in `damageMul`, `cut`, `bite`; sharpStick light = `thrust`), `verbsFor`, `validateVerb`, work actions,
  `releasedBy` on drop.
- Tests: classes from factory entities (a sharpened 1.5 m stick digs; flint lashed across a stick = stoneAxe, along a
  1.8 m stick = spear; a knapped flint = flintBlade; a 3 kg stone; a 7 kg branch is no tool) and unchanged when only
  `look` changes; a flint-tipped spear's `damageMul` is 1.43× a wood-pointed one's of equal mass (RR-13) and the starter
  axe's fresh chop stays 339 J; a sharpened stick's light technique is `thrust` (RR-9); take 40 kg carries, 41 kg drags,
  151 kg refused `tooHeavy`; the drag lab as a test (150 kg ≥ 1.5 m/s at 600 N, 300 kg < 0.05 m/s); belt and back
  limits; knockdown releases a carried log; a hit cancels a work action with no effect; a verb whose target broke or
  left reach during the buffer or the work action is refused at start or at `actAt` with no effect (RF-15); credit
  appended.
- Done: a player picks up, wields, carries, drags, stows and drops anything the rules allow, headless.

**P15 Verbs: strike, cut, dig** ★ — M, High (the seam inside DS's hit loop; swing aim). Depends on: P14, P09, P10.
- Owns: `src/world/verbs/strike.ts`, `cut.ts`, `dig.ts`; `tests/verbs.strike.test.ts`, `tests/verbs.dig.test.ts`.
- Content: §5.2's strike seam (chop with `fromDir` from the chopper, cross-cut, sever, push, dig, clang), §5.3, §5.10,
  §4.13's dirt policy (piles, then the masked, set-back berm), projectile world hits and landings.
- Tests: 15 stone-axe chops fell a 30 cm tree, each 0.0200 m fresh or tired; the fall direction follows the chopper's
  side at any angle, not in 45° steps (RT-22); the digging stick's overhead digs 0.15 m 1.4-1.7 m ahead and the stone
  axe never digs; a focused trunk is struck with an ape 20 m behind; a focused rope is aimed at its nearest point (RT-6);
  an edged strike severs a hanging vine (the bottom falls as a coil, the top stays tied); a blunt stick clangs; a 6 cm
  branch cross-cut in 3 chops conserves mass within 1 %; a kick knocks a 14 cm prop from under a 170 kg log; 30 strikes
  in one spot make ≤ 12 piles then a berm that never lands within 1.5 m of the hole; a 3 × 2 × 1.5 m pit dug with
  piles and spoil finishes within 1.2 × its no-spoil strike count (RT-2); a thrown spear lands as the same entity id.
- Done: cut and dig happen through strikes only.

**P16 Verbs: rope and shape** ★ — M, Medium-High (rope topology). Depends on: P14, P10.
- Owns: `src/world/verbs/lash.ts`, `bend.ts`, `pull.ts`, `shape.ts`; `tests/verbs.rope.test.ts`, `tests/verbs.shape.test.ts`.
- Content: §5.4 (with `taperEnd`), §5.8 (with the tie of a hauled end), §5.9, §5.12 (the haul model's verb side).
- Tests: touching lash → fixed joint; 1 m apart → a 1.00 m rope; the coil shrinks by what was used; splice 12 + 8 → 19.5
  m; an anchor 3 m up is refused `outOfReach`; untie returns a coil; a 6 cm sapling bends and is held, a 12 cm one is
  `tooStiff`; a dry stick reaches 0.6 in 6 strokes and stops, and its shaped end is a pointed hull (0.25 m taper on
  5 cm) with the `SharpPoint` at the tip; the design's leading test on the C lab's stake-and-shin geometry gives the
  lab's sharpness (RF-18); a stone knaps flint to 1.0 and wood can't knap it; the yank is 1,200 N for 9 ticks then
  500 N; reel-in ≤ 1.5 m/s; **a hauled 30 kg log tied off to a stake mid-haul stays at the angle reached** (§11.2(c));
  through a hanging vine anchored 10 m up, pulled from 15.6 m on the fall line, a tree cut to 0.3 falls (yank) and one
  cut to 0.5 doesn't.
- Done: AC-2's and AC-3's relations can be made with verbs.

**P17 Verbs: place and throw** — M, Medium. Depends on: P14, P09. Parallel with P15, P16.
- Owns: `src/world/verbs/place.ts`, `throw.ts`; `tests/verbs.place.test.ts`, `tests/verbs.throw.test.ts`.
- Content: §5.7 (with the sloped placement), §5.11, `releasedBy` on place and throw.
- Tests: a point-up stake on dirt is anchored (fixed, 1,200 N capacity, static for m_eff), on a boulder it is free; a
  blunt stick set upright stays free (`drive` absent) and is driven with `drive: 1`; a branch across a 2 m trench rests
  on its ends; **a 40 kg, 5 m log placed sloped onto a free 2.4 m prop rests on its lower end and the prop's top at
  32.9° and stays set 120 s awake** (§11.2(a)); a sloped placement with nothing under its upper half is refused; an
  overlapping place is refused; a 40 kg log leaves at 4.47 m/s, a spear and a stone at 20 m/s (spear point first); aim
  quantisation round-trips; a thrown entity is `held` until first contact.
- Done: stakes, covers, props and throws behave as §5.7 and §5.11.

**P18 Perception** — S, Low. Depends on: P08, P05. Parallel with P09-P17.
- Owns: `src/world/creatures/defs.ts`, `noise.ts`, `perception.ts`; `tests/perception.test.ts`.
- Content: §6.2.
- Tests: an ape sees a still player at 17 m ahead but not 19 m, a moving one at 29 m; a trunk between them hides him;
  crouched in cover he is unseen at 10 m; behind the cone unseen; a chop 30 m away adds 0.6 × 0.25; the giant hears a
  felled 738 kg trunk at 100 m; awareness decays at 0.12/s; the bus is empty after `fold`.
- Done: senses match §6.2 numerically.

**P19 Ape mind and path following** — M, Medium. Depends on: P18, P12, P09.
- Owns: `src/world/creatures/mind.ts`, `apeMind.ts`, `pathFollow.ts`, `factory.ts`; `tests/apeMind.test.ts`,
  `tests/pathFollow.test.ts`.
- Content: §6.1, §6.3, §6.5, scripts `route`/`tug`/`hold`, `paused`, `MindRegistry`, `createCreature`.
- Tests: idle → investigate (a chop 20 m away) → chase (sees him) → fight at ≤ 4.5 m; uses the shoulder charge within 60 s
  of fighting; flees once at ≤ 25 % on the 0.5 roll; re-paths around a 300 kg log **spawned** across its path after the
  tile rebuild (felling is P10's, in the same wave, RF-20); two apes never start attacks on the same frame; same seed +
  same log → identical mind records every 60 ticks; a paused mind writes no input and sets `idlePaused`; the `tug`
  script crouches.
- Done: apes patrol, notice, chase and brawl in the Clearing deterministically.

**P20 Giant mind** ★ — L, High (feel; coupling with the mover). Depends on: P19, P11.
- Owns: `src/world/creatures/rulerMind.ts`; `tests/rulerMind.test.ts`.
- Content: §6.4, the `charge` script, `chargeLineClear`, severe effects, deflection adoption, the climb out of a pit.
- Tests: the patrol loop takes 400 m ÷ 1.8 m/s ± 15 %; it investigates a tree felled 70 m away; every charge follows ≥ 60
  ticks of telegraph; heading change ≤ 8°/s while charging; the §6.4 dodge table reproduced with the real body **and
  the real `separate()`** (standing hit and launched, running missed, RF-5); a charge into a staked shin-height log trips
  and into a 20° wall deflects and continues; a limp makes the charge 4.9 m/s; a blind side hides a player 60° on that
  side; a severe wound sends it to its lair; the probe passes over a 1 m log and stops at a trunk; after a trip into a
  2.5 m pit it gets up, climbs out in 6-9 s and only then recovers.
- Done: the giant hunts, telegraphs, charges, trips and reacts to wounds headless.

**P21 The Clearing** — M, Low-Medium. Depends on: P07, P10 (vines), P12 (route checks).
- Owns: `src/world/clearing.ts`, `src/world/cover.ts`; `tests/clearing.test.ts`.
- Content: §6.7.
- Tests: §6.7's checks (counts, byte-identical generations, clearances, rim > 45°, routes and loops pathable, starter
  tools classify, 4 vines ≥ 17.96 m, the 6 m ledge).
- Done: `createWorld({ scene: 'clearing' })` builds in < 300 ms plus nav.

**P22 Spawner, sparring ape, dev ops** — S, Low. Depends on: P19, P20, P21.
- Owns: `src/world/creatures/spawner.ts`, `src/world/devOps.ts` (P05's stub, RF-19); `tests/spawner.test.ts`,
  `tests/devOps.test.ts`.
- Content: §6.6; every `DevOp` of §1.5.3 (spawn ape/giant, give tool, teleport with history reset, pause minds, kill
  creature, respawn player, setTuning).
- Tests: an ape respawns at home 300 s after death only with the player ≥ 40 m away; the giant never respawns; the
  sparring ape starts in `fight` 3 m ahead and respawns 3.2 s after its KO; each dev op applied through a command at
  tick t changes the world at t in both runs of a replay; `setTuning` is in the replay.
- Done: the Clearing populates itself; `?mode=training` works headless; every dev op is a command.

**P23 Test harness and scenes** ★ — M, Medium. Depends on: P13, P15, P16, P17, P19, P20.
- Owns: `tests/support/worldHarness.ts`, `tests/support/scenes.ts`, `tests/support/globalSetup.ts`,
  `tests/harness.test.ts`, root `vitest.config.ts` (the globalSetup entry and the rehearsal exclude), root `.gitignore`
  (`packages/sim/.cache/`).
- Content: §11.0: the harness, the dig planner, the cached pit scene, `buildLeaningLog`, `buildHauledLog`.
- Tests: each harness call produces the expected commands and effects; `buildStakedLog`, `buildStakedWall`,
  `buildNotchedTree`, `buildLeaningLog`, `buildHauledLog` and `buildPit` assemble with verbs only (a grep test:
  scenes.ts calls no `world.entities.*`/`joints.*` mutators, only the factory and `verb`); `stage` refuses after a
  creature script starts; `digPit` on a 3 × 2 × 1.5 m pit finishes within its tick and strike caps; a second
  `cachedScene('pit')` call reuses the file and a changed source hash rebuilds it.
- Done: the AC packages can be written without touching anything else.

**P24 AC-1** — S, Low. Depends on: P01 (can be written first and stays green).
- Owns: `tests/ac1.noTrapTypes.test.ts`. Content and assertions: §11.1. Done: green on every merge from then on.

**P25 AC-4** — M, Medium. Depends on: P23, P11. Owns: `tests/ac4.rule5.test.ts` (the mash and best-paced `it`s, the
pinned half). §11.4.

**P26 AC-5** — S, Low. Depends on: P23. Owns: `tests/ac5.rulerTrip.test.ts`. §11.5.

**P27 AC-6** — S, Low. Depends on: P23. Owns: `tests/ac6.bodies.test.ts`. §11.6.

**P28 AC-2** ★ — L, High (chaotic pit; two `it`s per trap; staging geometry). Depends on: P23. Owns:
`tests/ac2.traps.test.ts`. §11.2, starting with its lab-first step (the pins measured with the real pipeline before
freezing).

**P29 AC-3** ★ — M, High (brain-on lure; timing). Depends on: P23, P20. Owns: `tests/ac3.soloHunt.test.ts`. §11.3,
starting with its lab-first step.

**P30 AC-7** — M, Medium (the script). Depends on: P23, P13, P21, P22. Owns: `tests/ac7.determinism.test.ts`,
`tests/fixtures/ac7-script.json`. §11.7.

**P31 Client loop and skeleton** ★ (playtest path) — M, Medium. Depends on: P05 (starts on `scene 'empty'`).
- Owns: `src/main.ts`, `src/dev.ts`, `src/game/loop.ts`, `src/game/game.ts`, `src/game/ports.ts`; creates stubs of every
  new client module (§1.4) implementing its port, and thin port adapters around the changed DS modules (which their
  owners P32-P37 then change); deletes `src/arena/themeView.ts` and `tests/arenas.test.ts`;
  `tests/inputRouting.test.ts`, `tests/loop.test.ts`.
- Content: §10.1 (with `ports.ts`, RF-9), §10.2, §10.11's removals (game.ts:181's `externalKnockdown` write goes with
  them, ending the alias's last use); `verbInput.ts` stub carrying today's move/button command code (player number 1).
- Tests: with a fake world, 5 hit-pause frames run no `world.step`; slow motion runs a quarter of the steps; ≤ 6 steps per
  frame; a hidden tab pauses; `inputRouting` extended as §10.11; `game.ts` imports no client module except through
  `ports.ts` types (grep).
- Done: `npm run dev` boots and steps an empty world with the player shown (walking arrives with P08's controllers,
  RF-26); `npm run build` passes.

**P32 Client: the Clearing on screen** — L, Medium (performance). Depends on: P31, P07. (Not on P21: it is tested on
factory scenes, and the full Clearing appears on screen once P21 merges.)
- Owns: `src/render/terrainView.ts`, `forestView.ts`, `entityViews.ts`, `ropeView.ts`, `grassView.ts`, `sky.ts`,
  `looks.ts`, `fighterView.ts`, `weaponView.ts`; `tests/views.test.ts`.
- Content: §10.4 (`WorldViewsPort`, `FighterViewPort`): cross-cut notches, collapsed crowns on falling and felled
  trees, pointed stake ends, `prefs.gore` for new gore visuals.
- Tests: terrain vertices equal `heightAt` within 1e-5 m; 60 trunk instances; a felled tree gets its own mesh with notch
  depth = 1 − remaining and its crown inside the trunk radius + 0.15 m; a cross-cut log shows its notch; one rope view
  per joint; draw calls logged for the Clearing.
- Done: everything in the sim is visible and readable (rule 3).

**P33 Client: presentation physics** — M, Medium. Depends on: P31, P08.
- Owns: `src/game/presentationWorld.ts`, `src/body/ragdoll.ts`, `src/render/blood.ts`, `gibs.ts`, `particles.ts`;
  `tests/presentation.test.ts`.
- Content: §10.5 (`PresentationPort`).
- Tests (Node, Rapier): a knocked-down player's ragdoll pelvis is within 0.35 m of the slab's hip after 1 s; slots are
  recycled; no client file writes fighter state (shared with inputRouting).
- Done: rule 6 holds in the client.

**P34 Client: cameras** — M, Low-Medium. Depends on: P31.
- Owns: `src/render/followCam.ts`, `cameraDirector.ts`, `cameraRig.ts`, `cinematics.ts`, `cutout.ts`;
  `tests/followCam.test.ts`.
- Content: §10.6 (`CameraPort`, `CinematicsPort`). Tests: `cinematics.test.ts` passes with the ground callback; the
  follow camera stays ≥ ground + 0.35 m on a 30° slope at every yaw; no jump > 0.5 m between frames during a blend.
  Done: §10.6.

**P35 Client: verb UI and input** ★ (playtest path) — L, Medium-High (UX). Depends on: P31, P32, P14.
- Owns: `src/input/bindings.ts`, `input.ts`, `verbInput.ts`, `targeting.ts`, `src/ui/radial.ts`, `src/ui/settings.ts`,
  `src/game/prefs.ts`, `src/render/highlight.ts`, `ghost.ts`, `aimArc.ts`; `tests/verbInput.test.ts`,
  `tests/bindings.test.ts`.
- Content: §5.14, §10.7.
- Tests: scripted `InputFrame`s produce exactly the expected commands (take; the two-step lash; throw aim and charge
  quantised; place yaw, pitch (including a sloped pitch from the ghost's cast onto a prop) and drive; pull on/off;
  focus only on change); default bindings have no duplicates or reserved keys; the pad table maps as §5.14;
  `DEFAULT_PREFS.cues` stays false and `DEFAULT_PREFS.gore` is `'full'`.
- Done: every verb is reachable from keyboard and mouse and from a pad.

**P36 Client: HUD, kill cam, death** — S, Low. Depends on: P31, P09, P18.
- Owns: `src/ui/hud.ts`, `src/ui/compass.ts`, `src/render/markers.ts`, `src/game/killcam.ts`, `src/game/moments.ts`;
  `tests/moments.test.ts`, `tests/killcam.test.ts`.
- Content: §10.3, §10.8 (`KillCamPort`, `MomentsPort`, `HudPort`). Tests: moments from synthetic events
  (environmental `ko` → `envKill`; a `byWorld` wound → `worldWound`, including a terrain wound right after a world
  trip; a ruler `ko` → `rulerDeath`; a ruler launching the player → `playerByRuler`; the player's other deaths →
  `playerDeath`; a crown-split → `skullSplit`); one cut per kind per 4 s and **a suppressed moment still `mark()`s**
  (RR-14); `cine.play(` appears only in `killcam.ts`; the respawn countdown reads sim ticks. Done: §10.3, §10.8.

**P37 Client: audio and dev panel** — S, Low. Depends on: P31, P01.
- Owns: `src/feel/audio.ts`, `src/debug/panel.ts`; `tests/panel.test.ts`, `tests/audio.test.ts`.
- Content: §10.9, §10.10 (`SfxPort`, `PanelPort`). Tests: the panel builds a folder for every `TUNING` entry and a
  binding per field (fake Pane); an edit to a sim table produces exactly one `meta 'dev' setTuning` command and changes
  nothing until its tick (RR-17); every `Sfx` method is a no-op without an AudioContext. Done: every tuning table is
  live in the panel (SPEC:12), through the command log.

**P38 Milestone gate** ★ — M, Medium. Depends on: every package. Runs alone (may touch any file).
- Owns: `tests/perf.smoke.test.ts`, `tests/noBareConstants.test.ts`, `docs/M1-PLAYTEST.md`, follow-up fixes.
- Content: a 10-minute headless soak of the Clearing (no NaN; sim step median < 5 ms on the CI machine, SPEC:800); the
  no-bare-constants scan of §9 (RR-7); the acceptance suite (`npm run test:accept`) and the AC-9 rehearsal's latest
  result; `npm run build`; the playtest protocol for AC-8 (a tester builds a working trap not in SPEC:437-450 within
  an hour; **"working" = sim events**: an `impact` with `damage > 0` on a creature, or a ruler wound, whose cause entity
  carries the tester's credit, read off the dev panel's impact list, RT-24) and AC-9 (a first-time player gets an
  environmental ape kill within 10 minutes), with the AC-9 levers of §4.15 named, the climb-out limit of dug pits and
  the giant's charge levers (X20) noted for the tester; an independent verification pass; tag `m1`.
- Done: AC-1..AC-7 green, both playtests passed and recorded.

**P39 AC-9 rehearsal** — S, Medium (a scripted brawl in the full Clearing). Depends on: P23, P21, P22. Owns:
`tests/ac9.rehearsal.test.ts`. §11.9 (RT-12). Done: the rehearsal reaches an environmental ape kill within 36,000 ticks,
or a §4.15 lever has been pulled and recorded before P38's playtest.

### 13.2 Parallel waves (no two packages in a wave own the same file)

Every package's dependencies are in earlier waves (checked package by package against §13.1 for revision 2).

| Wave | Packages (in parallel) | Shared-file check |
|---|---|---|
| 0 | P01 | — (creates the ruler/impact placeholders) |
| 1 | P02a ‖ P03 ‖ P24 | P02a: sim core files + `body/mass.ts`; P03: the three P01 placeholders it fills; P24: one test file |
| 2 | P02b ‖ P05 | P02b: `combat.ts`, `fighter.ts` (reader regions) and its test; P05: world/*, index, package files, stubs of the other new sim files (never `sim/*` or `body/*`) |
| 3 | P04 ‖ P06 ‖ P31 | append regions of fighter/ai/animator/footwork/idle (P02b is merged) / entities.ts / client boot files, `ports.ts`, client stubs |
| 4 | P07 ‖ P08 ‖ P12 ‖ P13 ‖ P34 ‖ P37 | factory / characters, zones, downed / nav, navInput / save/* / camera files / audio, panel |
| 5 | P09 ‖ P14 ‖ P18 ‖ P32 ‖ P33 | contacts, damage, impact (P01's stub), deaths / verbs core + weapons.ts + poses.ts appends / creatures defs, noise, perception / render views / presentation, ragdoll, blood, gibs, particles |
| 6 | P10 ‖ P11 ‖ P17 ‖ P19 ‖ P36 | joints, breaking, loads, felling / ruler.ts (P01's stub), rulerBody.ts / place, throw / mind, apeMind, pathFollow, creatures/factory / hud, compass, markers, killcam, moments |
| 7 | P15 ‖ P16 ‖ P20 ‖ P21 ‖ P35 | strike, cut, dig / lash, bend, pull, shape / rulerMind / clearing, cover / input and UI files |
| 8 | P22 ‖ P23 | spawner, devOps (P05's stub) / harness, scenes, globalSetup, `vitest.config.ts`, `.gitignore` |
| 9 | P25 ‖ P26 ‖ P27 ‖ P28 ‖ P29 ‖ P30 ‖ P39 | one test file each (P30 also its script fixture) |
| 10 | P38 | alone |

### 13.3 Critical path

With the sizes above, the longest chain (≈ 42 developer-days end to end; P02's split shortens its head by a day and
P28's two `it`s per trap lengthen its tail by three) is:

**P01 → P02a → P05 → P06 → P08 → P09 → P10 → P15 ‖ P16 → P23 → P28 (AC-2) → P38.**

Co-critical within a day or two: **P09 → P11 → P20 → P23 → P29 (AC-3)** (the giant's body and mind meet the harness at the
same time as the verbs), and for the playtests **P05 → P31 → P32 → P35 → P38** (the verb UI is how a first-time player
meets the game) and **P21 → P22 → P39 → P38** (the AC-9 rehearsal must run before the playtest). P02b runs beside P05
and is needed by wave 5 (P09, P14). Slack: P03, P04, P07, P12, P13 (until P30), P17, P18, P21, P22, P24-P27, P33, P34,
P36, P37.

### 13.4 Risk register

| Risk | Where | Likelihood × impact | Mitigation |
|---|---|---|---|
| Legacy outcomes drift when the seams land (float order in `hit()`, `separate()`) | P02a, P02b | Medium × High | Seams null by default; the recorded legacy-fight replay test in both packages; `T > 0` guard; trailing defaulted parameters only |
| Contact plumbing breadth (pair kinds, normals, dedupe, cooldowns) | P09 | High × High | A lab test per pair kind (A's normals/timing labs become tests); sorted drain; no action inside callbacks |
| Giant-scale physics (trip, pinned, rise) unstable or slow to settle | P11, P26 | Medium × High | Compound body, damping 0.1/1.0, +4 iterations, prism logs, 94-frame rise: all measured (MAP gap-3, C e5_trip) |
| Props spring and covers break under their own weight (rule 3) | P10, P28 | High × Medium | Prism shapes, +4 iterations, thick props in tests, equal-share loads, visible strain (§10.4); the crush rule stays a TODO |
| Rope tension with several ropes, held ends and contacts | P10, P16 | Medium × Medium | NNLS (C F5); the contact limitation named (TODO); tests on the swinging-log statics |
| The giant feels dumb or unfair (SPEC:964) | P20, playtest | Medium × High | Telegraph 1 s, 8°/s committed charge measured to require running; awareness markers; the giant's tuning folder in the panel |
| AC-9 pace: per-bone m_eff makes world kills on apes rare | P21, playtest | Medium × High | Close ape home, snags, ledge, starter cache; levers named in §4.15 (`massShareMode 'zone'`, then the crush rule) |
| Test time (pit build, 10-minute AC-4, AC-7) | P28-P30 | High × Low | Build once and load; `test:accept`; long timeouts |
| Save completeness hides divergence from AC-7 | P13, P30 | Medium × Medium | Inventory-diff test; AC-7 compares body bytes as well as the save |
| WASM init or recast build cost in Vitest/Vite | P05, P12 | Low × Medium | Memoised `physicsReady`; `nav: 'off'` for physics-only tests; measured 1.0-1.5 s per full build |
| Navmesh rebuild cost on busy ticks (≈ 7 ms) | P12 | Medium × Low | Fixed tiles per tick; checked by P38's perf smoke; M4 profiling |
| Verb UI too complex for a first-time player | P35, playtest | Medium × High | Radial shows disabled options with reasons; prompts; starter cache shows a made tool |
| Contact episodes, grace windows and self-motion hide a hit that should score | P09 | Medium × High | One unit test per exclusion and its counter-case (§13.1 P09); every unscored started pair is countable in a dev counter |
| The verb-only AC-2 variants are chaotic (the haul's tie-off angle, a light deadfall's small hit) | P16, P17, P28 | Medium × Medium | Measured recipes (§11.2); lab-first step; the recipe changes, never the gate |
| The cached pit scene hides a stale build (hash misses an input) | P23 | Low × Medium | The hash covers tuning, format version and every source and support file; CI can force a rebuild with an env flag |
| The giant's pit climb-out looks wrong or traps it | P11, P20 | Medium × Medium | Climb limits in `RULER_BODY_TUNING`; P20's test of a 2.5 m pit; `climbMaxM` 4.5 m > any pit the dig floor allows |

## 14. Review log

Revision 2 answers every finding of `design/review-rules.md` (RR, 7 major + 18 minor), `design/review-feasibility.md`
(RF, 2 blockers + 10 major + 16 minor) and `design/review-tests.md` (RT, 2 blockers + 10 major + 12 minor). "Fixed"
names the section that now carries the fix; "rejected" gives the reason. Revision-2 labs are in
`design/lab-integrator-rev/` (tags **[I-rev ran: …]**).

### 14.1 review-rules (RR)

| # | Sev. | Finding | Outcome |
|---|---|---|---|
| RR-1 | major | "In a pit" is not a down state; nothing keeps the giant in a pit | **fixed**: `RulerState.inPit` (feet > 0.5 × knee height below the original ground), `rulerDown = tripped \|\| inPit`, `rulerHeld` adds stuck and pinned (§2.8, §4.6); `RulerMover` stands on `supportAt`, blocks steps > 1.0 m and slopes > 40° (the rim, pit walls), and climbs out of a pit slowly at 0.4 m/s while down (§4.7 steps 1-3, §6.4 `down`); I29 |
| RR-2 | major | Zone/bone mass shares not in a tuning table | **fixed**: `BODY_MASS_TUNING` (`boneKg`, `zoneShare` read-out) in `body/mass.ts`, shares computed from it at use or creation, the ragdoll reads the same object (§1.2, §2.7, §9.1) |
| RR-3 | major | Armour keyed by material names | **fixed**: `Material.armourJ` (hide 20, bone 40, others 0), the two name-keyed `DAMAGE_TUNING` keys deleted, a property-only unit test (§2.1, §4.4, §9.1); departure X19 |
| RR-4 | major | AC-3's 10 m measured to the cover centroid; the player ≈ 6 m from the pit | **fixed**: distances to the nearest point of every collider of the cover, pit, trunk, stump and giant over the whole pacing range (I30); P moved to (18, 1): ≥ 12.9 m from everything at both springs, 20.6 m from the tie **[I-rev ran: ac3_geom.out]**; the vine spliced to 27.7 m; moments re-checked (§11.3, I-3) |
| RR-5 | major | No M1 verb can set up the swinging log (or deadfall) as tested | **fixed**: every AC-2 trap has a verb-only gate `it` (a 30 kg log hung from a dragged-away support, hauled back by Pull, tied off by `tie` of the hauled end, cut; a 40 kg log placed sloped onto a free prop) measured with Rapier, plus the staged physics `it` D-25 allows; new rules: sloped Place, the haul model, tying a hauled end (§4.9, §5.7, §5.8, §11.2, I14) |
| RR-6 | major | The giant barely hurts or flings the player; conflict unflagged | **fixed**: flagged as a spec-internal conflict (departure X20, §4.4, AC-9 notes); two off-by-default levers `IMPACT_TUNING.creatureRestitution` and `unbackedTargetMassRatio` with TODO "ruler blows (SPEC:417)" (§4.4, §4.15, §9.1) |
| RR-7 | major | Many starting values are bare constants | **fixed**: every listed value is now a key (VERB_TUNING drag/lift gains, face rate, place, lash snap; MOVE_TUNING jump buffer; TOOL_TUNING synthWeapon trims; CREATURE_TUNING sight tolerance, re-path, stuck, failures, look-around, corner floor; IMPACT_TUNING parts ring/drop) (§5, §6, §9.1, §9.2); a P38 no-bare-constants test (§9) |
| RR-8 | minor | Finishing goes to the newest wound; ≥ vs "above" | **fixed**: `downWound` = the wound that tripped, pitted or pinned it, never moved by a later wound; strict `>` thresholds (§4.6) |
| RR-9 | minor | The sharpened stick has no thrust | **fixed**: `sharpStick` light = `thrust`, heavy = `overhead` (keeps digging) (§5.2) |
| RR-10 | minor | `winded` and skull → `weakJaw` unlisted | **fixed**: interpretation I25 with the reasoning (§2.9, §12.2) |
| RR-11 | minor | Corpses vanish after 120 s and never become carcass entities | **fixed (the departure route the reviewer offered)**: an ape corpse is removed only after 120 s and with the player > 40 m away; the giant's stays; departure X21 with TODO "carcass entity" (M4, with smell and bait) (§4.14). Converting bodies into carcass entities is not built: M1 has no rule that reads a carcass |
| RR-12 | minor | DS crown-split and sever bypass the damage rule | **fixed**: gated on `T === 0 \|\| E > T` (legacy and M1's 0 J bodies unchanged) (§4.4, P02b) |
| RR-13 | minor | A tool's melee damage ignores its material | **fixed**: `damageMul × (1 + kS·s)/(1 + kS·sRef)`, `cut` and `bite × s/sRef` from the head's sharpness; the starter axe keeps 339 J (§5.2, TOOL_TUNING.refSharpness) |
| RR-14 | minor | Kill cams can be dropped; DS cuts outside `onMoment`; terrain wounds after a world trip | **fixed**: suppressed moments `mark()` a saved moment; DS death and skull cuts are kinds `playerDeath`, `skullSplit` through `onMoment`; `byWorld` includes a terrain wound within 2 s of a world trip (`RulerState.lastWorldTrip`) (§2.13, §4.6, §10.3) |
| RR-15 | minor | Cross-cut progress not drawn; falling crowns pass through bodies | **fixed**: cross-cut notches drawn; a falling or felled crown is drawn collapsed within the trunk radius + 0.15 m; TODO renamed "canopy collision (rule 3)"; departure X22 (§2.5, §10.4). A canopy collider was rejected: at the leaves' 100 kg/m³ a crown of the drawn size weighs tonnes and would change the measured fall |
| RR-16 | minor | The 3 m ledge barely hurts an ape | **fixed**: `ledgeDropM` 6 m (chest landing 43.3 HP, feet first 13.0 HP; 0 HP to the giant) **[I-rev ran: rev.out §4]** (§6.7, §4.15, §9.1) |
| RR-17 | minor | Live tuning edits bypass the command log | **fixed**: `meta 'dev' setTuning` applied at its tick; the panel sends it; `loadWorld` applies overrides only with `applyTuning`; the registry is per process with one live world in the client (§1.5.3, §1.5.11, §8.1, §10.10) |
| RR-18 | minor | Commands identify the player by fighter id | **fixed**: `player` is the player number, mapped by `World.players`; `playerIdOf(n)`; legacy keeps M0's reading through the `playerFighter` seam (§1.5.1-1.5.3, §3 phase 1a, I31) |
| RR-19 | minor | Contact cooldown memory and the tripped local pose not saved | **fixed**: `SaveV1.contacts`, `contactGrace`, `RulerBodyRecV1` with `local[b]` and the history, entity `grace`/`releasedBy`, the dug mask; P13's completeness test covers every system's runtime state (§8.3) |
| RR-20 | minor | Interpretations missing (`usedSlots`, bend d², `meta pause`) | **fixed**: I26, I27, I28 (§12.2) |
| RR-21 | minor | Open-question TODOs have no sites | **fixed**: a table of TODO texts and files for SPEC:981-983, and every scope-cut TODO with its file (§12.4) |
| RR-22 | minor | Rules 11 and 12 and SPEC:423 have no hooks | **fixed**: TODO at `applyImpact`'s HP line (rule 11), TODO at the limb rule (SPEC:423), new gore visuals read one `prefs.gore` (default `'full'`) (§4.4, §10.4, §12.4) |
| RR-23 | minor | AC-2(b) requires the giant to survive | **fixed**: AC-2(b) gates ≥ 1 stake wound and logs survival; "alive after the pit" stays only in AC-3, where the trunk needs a living target (§11.2(b), §11.3) |
| RR-24 | minor | Rule 5 holds only through DS stamina, unflagged | **fixed**: TODO naming rule 5 at `rulerTick`; the stamina constants in §9.3 with "rule 5 depends on this"; P11's best-paced unit test; AC-4's best-paced `it` (§4.6, §9.3, §11.4) |
| RR-25 | minor | Later-milestone spec values missing from §9.3 | **fixed**: brute hide 300 J, world size and territories, regrowth, snow slabs, taming time and the M3/M4 rest added (§9.3) |

### 14.2 review-feasibility (RF)

| # | Sev. | Finding | Outcome |
|---|---|---|---|
| RF-1 | blocker | Zone pose history goes stale at every discontinuity | **fixed**: `resetHistory` on every enable, teleport, respawn, load and body-type switch; the history tracks the dynamic body while tripped; a 2-tick contact grace records but never scores pairs that start at the jump; unit tests (§4.3, §4.5, §4.7, §3 phases 4a-4c, 13b) |
| RF-2 | blocker | Phase-9 impulses pollute the phase-10 rope fit | **fixed**: every contact impulse (reactions, tripwire shares) is queued for the next tick's 4d, and the fit reads the phase-8 post-step snapshot; P10 tests the ape's 3,902 N crossing that must hold (§3, §4.4, §4.9) |
| RF-3 | major | A creature's own motion into a body is scored as an impact on it | **fixed**: the attacking limb never scores against any collider; the self-motion rule (safe-landing subtraction, no Δv or flinch when the creature's own motion drives a blunt contact); released entities ignore their releaser until apart (§4.3, `Entity.releasedBy`) |
| RF-4 | major | Momentum counted twice for ruler targets and solid pairs | **fixed**: Δv, the slab queue and the reaction apply only to sensor targets that aren't a standing ruler; the solver does solid pairs; the standing ruler's only transfer is the mover's shove (§4.4) |
| RF-5 | major | The charge against the player is decided by `separate()` | **fixed**: `separate()` skips a pair with a standing ruler closing faster than 1.0 m/s; the zones overlap and the contact pipeline scores it the same tick; P20's dodge test uses the real `separate()` (§4.4, §3, P02b, P20) |
| RF-6 | major | `NavWalkable` makes thrown weapons hit walls in mid-air | **fixed**: world mode skips the 2-D wall test (the projectile seam casts against entities and terrain); `addDrop` asserted unreachable (§4.1, P02b) |
| RF-7 | major | Broken pieces under the 14 t body; a fixed 10-tick grace | **fixed**: grace until the piece is clear of its breaker (min 10, max 600 ticks, then crushed); P28/P29 re-measure with real pieces (§4.10, §2.3, §11.2(b), §11.3) |
| RF-8 | major | P02's dependencies and ownership don't close; P02 too big | **fixed**: P01 creates `sim/ruler.ts`/`sim/impact.ts` placeholders with final signatures and tables; `externalKnockdown` kept as a deprecated alias until P31; `Brain.cfg`; P02 split into P02a (legacy core) and P02b (world-mode readers) (§1.2, §1.3, §13.1, §13.2) |
| RF-9 | major | `game.ts` must call changed DS modules with unspecified APIs | **fixed**: `game/ports.ts` with every interface `game.ts` calls, DS modules included; later packages implement adapters in their own files (§1.4, §10.1, P31) |
| RF-10 | major | AC-7's random command log can't exercise the verbs | **fixed**: a fixed script against the known Clearing of seed S, `Rng(99)` noise on top, and per-run coverage gates (§11.7, P30) |
| RF-11 | major | The pit build is underspecified, slow and shared with no mechanism | **fixed**: the layered `digPit` planner with stand spots, logged teleports and tick/strike caps; a Vitest `globalSetup` that caches the scene keyed by a source+tuning hash; spoil ≥ 1.5 m from dug ground (§4.13, §11.0, P23) |
| RF-12 | major | What makes a contact "new" is ambiguous | **fixed**: per-(creature, owner) touching counts and episodes, one score per episode, a 6-tick cooldown between episodes, terrain merged (§4.3) |
| RF-13 | minor | Rope sensors re-posed after the step aren't found by queries | **fixed**: re-posed in a new phase 4e, before the step (§3, §4.9) |
| RF-14 | minor | `RulerMover` climbs any slope, sinks through holding covers, leaks the root drop into the trip fit | **fixed**: `supportAt` ground, slope and step limits, the trip momentum fit from the previous tick's motion (§4.7) |
| RF-15 | minor | Verbs validated only at the command | **fixed**: re-validated when the work action starts and at `actAt` (§5.0, P14) |
| RF-16 | minor | AC-5's "every body" includes the player's moving kinematic bodies | **fixed**: the player is teleported away and paused; the body set is defined (§11.5) |
| RF-17 | minor | AC-4's "exactly Σ(hit HP)" ignores settling logs | **fixed**: W grows by the sum of every non-wound damage event while pinned, with ≥ 1 axe hit (§11.4) |
| RF-18 | minor | The labs' stakes were pointed hulls; the design's are flat prisms | **fixed**: shaping tapers the end into a pointed hull over 5 radii (the labs' geometry); P16 tests the leading test on that geometry (§5.4, §2.2) |
| RF-19 | minor | Dev ops have no owning module | **fixed**: `world/devOps.ts`, stubbed by P05, filled by P22 (§1.3, §13.1) |
| RF-20 | minor | P19's test needs felling from P10 in the same wave | **fixed**: it spawns a 300 kg log instead (P19) |
| RF-21 | minor | AC-2(c)'s tie crosses the player's head zone | **fixed**: scaffold top 2.65 m, the player at x −6.0: head 0.33 m under the tie, every anchor within 1.3 m **[I-rev ran: rev.out §2]** (§11.2(c)) |
| RF-22 | minor | `bodyStateBytes` asks velocities of parentless rope sensors | **fixed**: pose only for rope sensors (§8.2) |
| RF-23 | minor | `NavWalkable` would make ~66 queries a tick | **fixed**: per-tile walk and blocker bitmaps rebuilt with the tile (§1.5.9, §4.1, §7, P12) |
| RF-24 | minor | `World` has no `dispose()` | **fixed**: `World.dispose()` (recast `destroy()`, Rapier `free()`); the harness calls it after each test, the client before a rebuild (§1.5.1, §11, P05, P12) |
| RF-25 | minor | P02's list omits some readers | **fixed**: `autoDefend` while carrying, strikes with a load, presses as `pull` added to P02b (§1.2, §13.1) |
| RF-26 | minor | P31's done needs P08's controllers | **fixed**: P31 is done when it boots and steps an empty world (§13.1) |
| RF-27 | minor | AC-6 part 2 sits on the `launchDv` threshold | **fixed**: masses are test constants and the branch is asserted by name (§11.6) |
| RF-28 | minor | AC-3's trunk-on-a-rising-giant is unmeasured | **fixed**: P29's lab-first step measures it with the real rise; in a pit the giant is still down and its zones score; recorded as R4 (§11.3, §11.8) |

### 14.3 review-tests (RT)

| # | Sev. | Finding | Outcome |
|---|---|---|---|
| RT-1 | blocker | A covered pit trips the giant by the ledge rule; `'cover'` is unreachable and the weight trigger untested | **fixed**: the mover stands on `supportAt` (a cover is ground until it breaks); a load break under a planted foot with a drop past the ledge threshold trips `'cover'`, and a ledge trip within 30 ticks of such a break reads `'cover'`; AC-2(b) gates a foot-load break before the trip and adds a negative control (a strong log bridge: no break, no trip); the 9 runs are re-measured with the real mover (§4.7 steps 7-8, §4.11, §11.2(b)) |
| RT-2 | blocker | The spoil rule refills the hole; the pit recipe never terminates | **fixed**: an ever-dug mask; spoil and every vertex `raise` touches ≥ 1.5 m from dug ground (3,573 strikes, rim 0-0.23 m **[RT lab: spoil_setback.out]**); termination gated at 1.2 × the no-spoil count; the rigid 66 kg mat is replaced by placed bearers and grass bundles (§4.13, §11.0, §11.2(b)) |
| RT-3 | major | The felled tree's "ape KO at 12 m" came from 1 of 7 runs; head first it is 48 HP | **fixed**: the gate is an impact from the trunk with v_n ≥ 10 m/s and damage > 0; HP and KO are logged (§11.2(d)) |
| RT-4 | major | The deadfall's victim placement can't be built; the band came from a ball | **fixed**: crouching lowers the controller to 0.7 (an ape is 1.39 m; it fits under the log at 1.75 m); `keepAwake`; the gate is v_n ≥ 2 m/s (staged) / ≥ 1 m/s (verb-only) and damage > 0; the band is a pin re-measured with the real rig (§4.2, §11.0, §11.2(a)) |
| RT-5 | major | The tripwire rule can fire from the actor's own limbs | **fixed**: tripwire momentum from the root velocity; the work target and its ropes exempt during `'pickup'`/`'attack'`; `tripwire` events; AC-2(a) and (c) assert none fired; the tie is above the player's head (§4.9, §2.13, §11.2) |
| RT-6 | major | The scripted ape walks with the swing | **fixed**: the ape `hold`s at the arc's bottom; timing from the `joint cut` event; ropes are aimed at their nearest point; the cut measured in the lab-first step (§5.2, §11.2(c)) |
| RT-7 | major | Broken cover pieces still span the pit | **fixed**: a load break snaps a prism across its axis at the load point; AC-2(b) gates that no cover piece rests on both rims 0.5 s after the break; re-measured with the real fracture and grace (§4.10, §11.2(b)) |
| RT-8 | major | AC-2's stored energy and the cover are placed by fixture | **fixed**: a verb-only gate `it` per trap, measured with Rapier (the deadfall and swing labs), alongside the staged physics `it`s; the verb-only pit cover (§11.0, §11.2, I14) |
| RT-9 | major | AC-3's configuration differs from the measured one five ways | **fixed**: the pit now matches a measured configuration (0.6 m grid, break-after-step: 6/6 stake and trunk wounds at P (18, 1) **[I-rev ran: ac3_final.out]**); the giant starts on a patrol route; P29's lab-first step re-runs with berm, pieces, the brain-on charge and the rise; "change the recipe, never the assertion" (§11.3) |
| RT-10 | major | "Never within 10 m" measured to the centroid | **fixed**: as RR-4 (I30, §11.3) |
| RT-11 | major | AC-7 can pass on an idle world | **fixed**: as RF-10, with coverage gates per run (§11.7) |
| RT-12 | major | Nothing shows an environmental ape kill is reachable in 10 min | **fixed**: a non-gating headless rehearsal (P39, §11.9) run before the playtest, with §4.15's levers; the 6 m ledge (RR-16) |
| RT-13 | minor | AC-4 runs only the mash pacing | **fixed**: a best-paced `it` with the same gates (§11.4) |
| RT-14 | minor | AC-4's pin timing and W are unspecified | **fixed**: logs spawned at rest or +2.5 s; `pinned` gated before +4.0 s; W = `downWound`; the placement search re-run on the tripped rig (§11.4) |
| RT-15 | minor | AC-6's boulder check passes if never touched | **fixed**: ≥ 120 of 180 ticks with a KCC collision and a queued push (§11.6) |
| RT-16 | minor | The cooldown key is ambiguous; the AC-6 tick undefined | **fixed**: episodes per (creature, owner) (as RF-12); the measured tick defined exactly (§4.3, §11.6) |
| RT-17 | minor | AC-6 part 3 has an escape hatch and a distance cap | **fixed**: a trip `'obstacle'` is the only pass at 45°; the charge starts 15 m from the wall (§11.6) |
| RT-18 | minor | AC-5's "every body" includes the builder | **fixed**: as RF-16 (§11.5) |
| RT-19 | minor | The credit check fails for spawned impactors | **fixed**: credit is gated in the verb-only `it`s; in staged `it`s it applies to what a verb touched, and spawned-only entities are named as `credit: []` rather than faked (§11.0) |
| RT-20 | minor | AC-1's scan has holes | **fixed**: `.ts/.tsx/.js/.mjs/.json`, comment ranges from the TS scanner, nested property-signature literals (§11.1) |
| RT-21 | minor | "The first run re-measures" makes pins self-written | **fixed**: GATE and PIN marks; a pin moves only with a lab rerun named in the test (§11 preamble) |
| RT-22 | minor | The fall direction snaps to 45° facet normals | **fixed**: `fromDir` from the trunk axis to the chopper's root, fixed by the first chop (§2.5, §5.2) |
| RT-23 | minor | Test time; a build in `beforeAll` | **fixed**, with one part rejected: builds in `beforeAll`/globalSetup with 900 s, the cached scene shared by AC-2 and AC-3 (§11.0). **Rejected**: moving the full pit build out of `npm test` into `test:accept` only; the cache makes it a once-per-source-change cost, and CLAUDE.md's `npm test` runs every package's tests, the acceptance criteria included |
| RT-24 | minor | AC-8: "working" undefined; deep pits trap the digger | **fixed**: "working" = sim events credited to the tester, read from the dev panel's impact list (P38, §10.10); the climb-out limit recorded as a playtest note (§4.13). Raising the autostep was not done: digging a ramp is the in-world answer, and a 1.3 m autostep would let players climb staked log walls |

### 14.4 Found by the integrator while fixing (I)

| # | Problem | Outcome |
|---|---|---|
| I-1 | The load rule tested every entity, so the 66 kg leaf mat (660 N capacity) would break under the player's own 719 N step | **fixed**: a covering passes its load down untested; only entities spanning at the load point (no support within 0.1 m below) are tested (§4.11, `LOAD_TUNING.spanGapM`) |
| I-2 | The held-end rule (force only while distance ≥ free length) made a hauled free body creep: 23° in 9.5 s **[I-rev ran: dbg_swing.ts]** | **fixed**: the haul model (force scaled by the approach speed below 1.5 m/s, the free length only shortens): 28-45° in an 8 s haul **[I-rev ran: swing_light.out]** (§4.9, §5.12) |
| I-3 | The reviewers' AC-3 spot (14.85, 5.85) puts the charge line at z ≈ 3.4 at the pit's near edge, outside its 3 m half-width **[computed]** | **fixed**: P = (18, 1), measured (§11.3) |
| I-4 | With the design's break-after-step stakes on the 1.0 m grid, a charge toward the AC-3 player wounded in only 3 of 6 runs (12/15 over both scenes) **[I-rev ran: ac3_density.out]** | **fixed**: a 0.6 m grid (108 stakes): 15/15, and 6/6 at P (18, 1) **[I-rev ran: ac3_final.out]** (§4.3, §11.2(b), §11.3) |

No finding was rejected outright; RR-11, RR-15, RT-23 and RT-24 each had one suggested option declined, with the reason in
its row.
