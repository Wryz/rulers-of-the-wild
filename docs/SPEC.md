# The Wild — Game Design & Technical Overview

Oct 16, 2026 · @My Phung

## How to use this document

This is the build spec for **The Wild** (working title). A Claude Code session should read it once in full, fork the DungeonStyle repo as the starting codebase, then work through the Build plan one milestone at a time. This build is single-player and runs entirely in the browser; multiplayer comes later, on top of the same sim and save files.

Rules for reading it:

1. **The design rules are binding.** If an implementation choice conflicts with one, the rule wins. Flag the conflict in a comment or a TODO instead of quietly breaking it.
2. **Numbers marked "starting value" are tuning defaults, not specs.** Put every one of them in a live tuning table, the way DungeonStyle does with `RAGDOLL_TUNING` and `GAME_TUNING`, so they can be changed in the dev panel.
3. **File paths refer to** [github.com/Wryz/dungeon-style](https://github.com/Wryz/dungeon-style) at commit `50b64bf` (2026-10-14).
4. **Open questions are not decided.** Use the default listed under Risks and open questions, and leave a TODO that names the question.
5. **Work in milestone order.** Don't build servers, networking or accounts until the single-player milestones are done. Do follow rules 6–8 and the list in Multiplayer later, so adding multiplayer stays cheap.
6. **Diagrams are summaries.** Everything a diagram shows is also stated in the text, so nothing is lost if this document is exported to Markdown.

The Glossary at the end defines the game's own terms: ruler, verb, material, hold, environmental kill and the rest.

## Vision and pitch

**One-liner:** Brawl the small ones. Trap the big ones. Use the world for everything.

**Pitch:** A single-player open-world game (multiplayer later) set in the Wild: dense jungles and breathtaking landscapes ruled by giant, deadly beasts. You're small here. Raptors, boars and apes you can fight hand-to-hand in fast, physical, gory brawls, and they go down hardest when you use the world: kick one into a fire, crush one under a falling tree, shove one off a cliff. The giants that rule the Wild can't be fought. They can only be outsmarted. Drop a log mid-chase, set the grass ablaze behind you, or spend hours building the perfect trap: a funnel of logs, a hidden pit, an avalanche waiting on the ridge. Every trap that lands leaves a scar the beast carries forever, so even a failed hunt brings it closer to falling. Kill a ruler and its land is yours to clear and build on, but the Wild fights back, and beasts can take back what you've claimed. When the last ruler falls, the Wild is tamed, and a new one begins.

**The magic moment:** one player sprints out of the trees with a giant beast right behind them, straight into a funnel of logs, a hidden pit, and three trees coming down on it at once. Nobody coded that trap. The player built it out of the world.

**The game at a glance:**

| Aspect | Decision |
| --- | --- |
| Genre | Single-player open world (multiplayer later), physics-driven, systemic (emergent traps) |
| Platform | Browser, desktop first (keyboard and mouse, gamepad) |
| Players | Single-player first; multiplayer (30–50 per world) comes later, built on the same sim and save files |
| Camera | Third-person follow camera in the open; DungeonStyle's three-quarter fight camera when locked onto a creature |
| Look | Low-poly 3D, matching DungeonStyle's blocky faceted bodies |
| World goal | Kill every territory ruler; the Wild is then tamed and a new world can start |
| Session shape | 10 minutes is enough for a hit (brawl, trapline, improvised trap); hours for a ruler hunt |

**What it is not:**

- Not an RPG. There are no levels, no XP and no stat training.
- Not a base builder with owned plots. Everything is a physical part of the world.
- Not tower defense. There is no trap menu and no trap is ever coded.
- Not story-driven. There is no plot, dialogue or scripted arc. Ruins and old bones can hint at the past, but nothing is told.
- Not PvP. Players never fight each other.

## Design pillars and rules

Five pillars decide every feature; a feature that serves none of them gets cut. The twelve rules below them are binding on the code.

**Pillars:**

1. **Use the world.** Every object has a material and obeys physics. Traps, weapons and kills come out of those rules, not out of special cases.
2. **Humans are weak.** Primitive weapons only. Small creatures can be brawled; the giants can only be beaten with the world.
3. **Strategy over stats.** Players get better by knowing more and having more options, never by bigger numbers.
4. **Solo first, friends later.** The game is complete for one player. When multiplayer arrives, 2–6 friends make it better, and the world goal stays the sum of what everyone does, never needing strangers to coordinate.
5. **A Wild worth exploring.** Beautiful, dangerous, and always something new past the edge of claimed land.

**Rules:**

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

## The world

Each world (one save) is one continuous Wild: a lost-world island of jungle, forest, cliffs and rivers, split into territories that each belong to one giant ruler, with a small human foothold on the coast.

**Layout (starting values):**

- **Size:** about 3 km × 3 km of playable land in a single-player world (about 4 km × 4 km in later multiplayer worlds), generated from a seed.
- **The Landing:** a small coastal clearing where the player starts. It is permanently Claimed (hold 100), and no ruler can enter it. It is the only safe ground at the start of a world.
- **Territories:** 6 in a single-player world (8–12 in later multiplayer worlds), each ruled by one ruler, each roughly 1 km across, separated by natural borders (ridges, rivers, ravines).
- **Land cells:** the map is divided into 32 m × 32 m cells. Every cell is Wild, Contested or Claimed (see Territory and the front).

**Biomes:** each territory leans on a biome, and each biome leans on different physics, so different rulers need different traps.

| Biome | What it's made of | The physics it invites |
| --- | --- | --- |
| Jungle valley | Huge trees, vines, dense undergrowth | Felling, swinging logs, vine rope, ambush |
| Highland forest | Tall straight trunks, slopes, boulders | Rolling logs and boulders, deadfalls |
| Swamp | Mud, still water, gas vents, rotting wood | Sinking heavy beasts, gas explosions, fire on gas |
| River delta | Fast streams, banks, waterfalls | Dams and floods, washing things downstream |
| Canyon | Cliffs, loose rock, narrow passes | Funnels, rockfalls, drops |
| Snow ridge | Snow slabs on steep slopes, ice | Avalanches, slipping on ice |

**Terrain:** a heightmap in chunks (starting value: 64 m chunks). The player can dig it locally (pits, trenches) to a limited depth (starting value: 3 m below the original surface). Dug earth becomes a pile of dirt that can be moved.

**Water:** rivers and lakes are water bodies with a level and a flow direction. Damming a channel raises the level upstream over time; releasing it sends a surge (see Elements).

**Time and weather (starting values):**

- **Day and night:** a 40-minute cycle, 30 minutes of day and 10 of night. Beasts roam further at night, and rulers push into human land.
- **Rain:** soaks everything it falls on, puts out fire and turns soil to mud. About one shower per in-game day, lasting 3–8 minutes.
- **Dry spells:** dry out grass and wood, so fire spreads fast.
- **Wind:** has a direction and strength. It pushes fire, and it carries scent to beasts downwind.

**World time runs only while you play.** The world is paused while the game is closed. On loading a save, only traplines catch up on the time away (capped at 8 hours, starting value). A hidden browser tab counts as closed: the game pauses, and the hidden time counts as time away. Every duration in this document is in play time unless it says otherwise.

**Resources come from the world, not menus.** Trees give logs, branches and bark. Vines give rope. The ground gives stones, flint and clay. Some plants give flammable sap and resin. Animals give meat, hide, bone, sinew, fat, teeth and tusks.

**Regrowth:** cleared ground in Wild cells grows back (saplings within an hour of play, small trees within a few hours of play). Claimed cells don't regrow.

**Ruins and old bones** are scattered through the Wild for wonder and hints, not story: a giant skull half-buried in a riverbank, an old stone wall that still funnels beasts, a collapsed tower that shows someone once hunted here.

## Creatures

Creatures form a food chain with four tiers, and the tier decides how you beat it: by hand, by improvised trap, or only by a planned trap.

| Tier | Examples | Size vs a human | How it's beaten | What it gives | Its job in the game |
| --- | --- | --- | --- | --- | --- |
| Small game | Rabbits, jungle fowl, lizards, piglets | 0.2–0.5× | Snares, thrown stones, bare hands | Meat, small hide, feathers, bone | Teaches trapping; feeds traplines |
| Mid-size | Boars, raptors, apes, wolf packs | 0.8–1.5× | DungeonStyle brawl, best finished with the world | Hide, bone, teeth, tusk, sinew, fat | The every-minute fight; guards territory edges |
| Brutes | Bears, rhino-like grazers, crocodiles | 2–3× | Improvised traps; a brawl is very risky | Large hide and bone, rare parts | Raises the stakes between brawls and rulers |
| Rulers | One per territory (examples below) | 3–6× (4–10 m tall, up to 18 m long; 6–15 t) | Planned traps only; weapons barely scratch them | Legendary materials, the territory itself | The world goal |

All creatures obey the same physics as everything else: mass, momentum, per-zone toughness. A ruler can trip over a log, slip in mud, break through a bridge too weak for its weight, burn and drown.

**Rulers.** Each is defined by the same template:

- **Body:** mass, size, skeleton type (ape, quadruped, serpent, biped), and hit zones, each with a toughness threshold. Armoured zones (back, skull, flanks) are above any human strike; soft zones (eyes, joints, belly, mouth) are not, but take only small damage from one.
- **Territory:** a lair, a patrol route through waypoints, and the cells it rules.
- **Senses:** sight cone and range, hearing radius, smell range (carried by wind).
- **Temper:** how it reacts to intruders, to pain and to fire.
- **Signature behaviour:** one or two things only this ruler does.
- **Traits:** drawn at random per world from a pool, so a wiki can't solve every ruler (pool below).

Example rulers (working names; avoid naming any film's monster in public material). Every ruler's last column must include at least one trap a solo player can spring from a safe distance: a weight trigger, a pulled rope, a fuse or a thrown torch.

| Ruler | Biome | Body | Signature behaviour | Built to be beaten by |
| --- | --- | --- | --- | --- |
| The Great Ape | Jungle valley | Ape, 10 m, 14 t | Climbs, and throws logs and boulders back at you | Deadfalls and felled trees; it can't dodge from up a tree |
| Old Tusk | Highland forest | Quadruped, 6 m at the shoulder, 12 t | Charges in long straight lines and turns badly | Funnels and pits along its charge line |
| The Mire King | Swamp | Giant reptile, 18 m long, 9 t | Hides under still water, ambushes from it | Draining or igniting swamp gas, dragging it into mud |
| Thunderfoot | Canyon | Biped predator, 8 m, 8 t | Huge bite, poor at sharp turns, roars that shake rocks loose | Rockfalls and narrow passes |
| The Horned Mother | River delta | Quadruped, 6 m at the shoulder, 10 t, with a herd | Herd stampedes when she's threatened | Floods and the herd's own stampede off a bank |
| The Pale Stalker | Snow ridge | Giant cat, 4 m at the shoulder, 6 t | Silent ambush hunter | Avalanches and ice |

**Trait pool** (each ruler draws 2–3 per world):

| Trait | Options |
| --- | --- |
| Fire | Fears it and flees · ignores it · enraged by it |
| Water | Swims well · avoids deep water |
| Climbing | Climbs steep slopes · can't climb at all |
| Senses | Keen smell, poor sight · keen sight, poor smell |
| Sleep | Sleeps by day · sleeps by night |
| Charge | Reckless (doesn't brake) · cautious (stops short) |
| Pain | Retreats to its lair when badly hurt · fights harder when hurt |

**Rare variants:** about 1 mid-size creature in 500 (starting value) spawns as a rare variant, such as a white wolf, with a rare-material part. Rare variants of rulers don't exist; every ruler is already unique.

**Respawning:** small game and mid-size creatures respawn in Wild cells over time. A killed ruler never respawns in the same world, but a neighbouring ruler can expand into its land if the player doesn't hold it.

## The systemic physics model

Every object in the world is an entity made of a material, with a physical body in Rapier; a short list of rules (rigid-body physics, one damage rule, a few element rules, breaking and decay) produces every trap, weapon and kill. This is the heart of the game and the part to build first.

### Entities

Everything that can be moved, broken, burned or climbed is an entity: trees, logs, branches, stones, ropes, stakes, carcasses, dirt piles, built structures. Creatures and players are entities too, with extra systems on top. A starting sketch:

```ts
interface Entity {
  id: number;
  material: MaterialId;
  shape: Shape;                 // ball | box | capsule | cylinder | convex hull
  body: RigidBodyHandle | null; // null while frozen (see Performance)
  integrity: number;            // 0..1; 0 = breaks apart
  moisture: number;             // 0..1; wet things don't burn and are heavier
  temperature: number;          // rises near fire; burning above ignition
  burning: boolean;
  sharpPoints: SharpPoint[];    // local points with a sharpness 0..1 and a direction
  joints: JointRef[];           // lashings, ropes, hinges to other entities
  age: number;                  // seconds; drives decay
  credit: string[];             // IDs of players who built, placed or moved it (weights wait for multiplayer)
}
```

### Materials

A material is a set of properties; every rule reads properties, never material names. Adding a material must never require new rule code.

| Property | Meaning | Range | Read by |
| --- | --- | --- | --- |
| Density | Mass per volume (mass = density × shape volume) | kg/m³ | Rapier mass, buoyancy, damage |
| Hardness | Resists denting and blunting | 0–1 | Integrity, how sharp it can be kept |
| Max sharpness | Highest sharpness it can be shaped to | 0–1 | Shape verb, damage rule |
| Flammability | How readily it catches and spreads fire | 0–1 | Fire |
| Strength | Rope: tension it breaks at (kN). Solid: impact energy that starts breaking it (J per kg) | per type | Joints, integrity |
| Springiness | Energy it stores when bent and returns when released | 0–1 | Bend verb, joint motors |
| Friction | Grip | 0–1 | Rapier friction |

Starting values:

| Material | Density (kg/m³) | Hardness | Max sharpness | Flammability | Strength | Springiness | Friction | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Green wood | 800 | 0.5 | 0.5 | 0.2 | 40 J/kg | 0.6 | 0.6 | Living trees, saplings |
| Dry wood | 550 | 0.5 | 0.6 | 0.8 | 30 J/kg | 0.2 | 0.6 | Logs, stakes, fuel |
| Rotten wood | 400 | 0.1 | 0.1 | 0.5 | 5 J/kg | 0 | 0.6 | Snaps under weight: pit covers |
| Leaves and dry grass | 100 | 0 | 0 | 1.0 | 1 J/kg | 0 | 0.4 | Ground cover and covering |
| Vine rope | 600 | 0.1 | 0 | 0.5 | 6 kN | 0.1 | 0.7 | Rots fast when wet |
| Sinew rope | 1100 | 0.2 | 0 | 0.3 | 18 kN | 0.2 | 0.7 | From mid-size creatures |
| Hide | 1100 | 0.3 | 0 | 0.3 | 20 J/kg | 0.1 | 0.6 | Covers, armour, bags |
| Bone | 1900 | 0.7 | 0.8 | 0.1 | 60 J/kg | 0.1 | 0.5 | Stakes, points |
| Ruler bone | 2100 | 0.9 | 0.9 | 0 | 200 J/kg | 0.1 | 0.5 | Legendary stakes and points |
| Stone | 2600 | 0.9 | 0.2 | 0 | 150 J/kg | 0 | 0.7 | Boulders, weights |
| Flint | 2600 | 0.95 | 1.0 | 0 | 40 J/kg | 0 | 0.6 | Knapped into edges; brittle |
| Dirt | 1500 | 0.2 | 0 | 0 | 5 J/kg | 0 | 0.7 | Dug from pits |
| Snow (slab) | 300 | 0.1 | 0 | 0 | 2 J/kg | 0 | 0.3 | Avalanches |
| Ice | 900 | 0.6 | 0.3 | 0 | 20 J/kg | 0 | 0.05 | Slipping |
| Resin and sap | 1000 | 0 | 0 | 1.0 | n/a | 0 | 0.3 | Coats things to make them flammable |
| Fat and oil | 900 | 0 | 0 | 0.9 | n/a | 0 | 0.1 | Fuel; a slick makes the ground slippery |

**Mud** is not a material but a ground state: soil whose moisture is above 0.7 (see Elements).

### Verbs

Players act on the world with verbs that work on any entity whose properties allow it. There is no crafting menu.

| Verb | What it does | Needs |
| --- | --- | --- |
| Cut | Chop a tree (it falls away from the cut side, as a dynamic body), split a log, cut a rope or vine (releasing whatever it held) | An edged tool |
| Shape | Sharpen an end of a stick, log or bone up to the material's max sharpness; knap flint into an edge | A hard tool or stone |
| Carry, drag, roll | Lift up to 40 kg alone, drag up to 150 kg, roll heavier round things. In multiplayer, several players on one object will add their strength | Hands |
| Lever | Use a long pole over a fulcrum to move what can't be pushed: dislodge a boulder, tip a log off a ledge | A pole and a fulcrum |
| Pull | Hold the free end of a rope and tug from up to the rope's length away: yank out a prop, pull over a half-cut tree, open a dam. The main way a solo player springs a trap from a safe distance | A rope tied to something |
| Place | Set an object down at a chosen position and angle, including point-up stakes driven into soft ground | Hands |
| Lash | Tie two entities together with rope (a Rapier joint, see below) | Rope or vine |
| Bend | Pull a sapling or springy branch over and tie it, storing energy | Rope, a springy material |
| Dig | Lower the terrain by 0.15 m in a 0.5 m radius per strike (starting values); the removed earth becomes a dirt pile entity of the same volume | A digging tool or hands (slow) |
| Ignite | Start a fire on a flammable, dry enough entity | Flint and tinder, or a burning thing |
| Coat | Pour resin, sap or fat over an entity or the ground | A container of it |
| Throw | Throw anything you can carry (DungeonStyle's ballistic projectiles) | Hands |
| Strike | Hit with whatever is in your hand (DungeonStyle combat) | Hands or a weapon |

Primitive tools are made the same way: a stone axe is a knapped flint lashed to a stick, a spear is a stick sharpened (or a flint point lashed on), a torch is a stick coated in resin and lit. The game records what a player has made in a journal; it never offers a recipe list.

### Joints and rope

Lashing creates a Rapier impulse joint between two bodies. Rapier 0.21 provides all the joint kinds needed (`JointData.fixed`, `.rope`, `.revolute`, `.spherical`, `.spring`):

| Built thing | Joint | Breaks when |
| --- | --- | --- |
| Two sticks lashed rigid (frames, platforms, stake bundles) | Fixed | An impact on either body exceeds the lashing's break energy |
| A log hanging from a branch | Rope (max length) | Rope tension exceeds the rope's strength |
| A swinging log or a gate | Revolute (hinge) | Same as fixed |
| A bent sapling | Revolute at the base with a position motor toward its rest angle, stiffness from springiness × trunk thickness; held bent by a rope | The holding rope is cut or snaps |
| A tripwire | A rope across a path tied to whatever it holds up | A body crossing it exceeds its strength or pulls its anchor loose. The rope has no body to push, so its load is computed when a body overlaps its sensor: the body's momentum across the rope ÷ 0.1 s (starting value) |

Rapier's JavaScript API doesn't report the force a joint applies, so rope tension is estimated each step. While a rope is taut (distance between anchors ≥ its length), its tension is T = m × (g − a) · û, where m is the hanging body's mass, a is that body's acceleration over the step ((v₁ − v₀) ÷ DT), g is gravity, and û is the unit vector from the anchor to the body. A still 300 kg log gives 2.9 kN. Break on the maximum over the last 3 steps exceeding strength (starting value). A burning rope loses strength as fire travels along it at 5 cm a second (starting value), which makes a slow fuse.

**Rapier setup notes:**

- **A joint has no body.** A rope joint holds a load but can't be walked into, cut or burnt. Give each rope a thin sensor capsule between its anchors, updated every step, so tripping, cutting and fire can find it. Ropes that must drape or wrap (snares) are chains of short capsules on spherical joints.
- **Strands add up.** Two vine strands hold twice what one does. A 300 kg log hanging still pulls 2.9 kN; released from horizontal it pulls about 3 × its weight at the bottom of the swing (8.8 kN). One vine rope (6 kN) holds the still log but snaps on that swing; sinew (18 kN) holds both.
- **Turn on the contacts you need.** Rapier ignores contacts between kinematic or sensor colliders and fixed ones by default. Give hit zones and rope sensors `ActiveCollisionTypes.ALL`. Colliders that can deal or take damage need `ActiveEvents.COLLISION_EVENTS` (new contacts) and, for dynamic bodies, `CONTACT_FORCE_EVENTS` (forces). Turn on continuous collision detection for fast bodies (thrown spears, falling logs), or a 20 m/s spear can pass through a 10 cm zone without an event.
- **Never let a kinematic body push the world.** Kinematic bodies act as if their mass were infinite. See The player and Beast AI for how characters and rulers avoid it.

### The damage rule

Every impact is scored by the energy it delivers, concentrated by sharpness, minus the toughness of what it hits:

```latex
E = \tfrac{1}{2}\, m_{\mathrm{eff}}\, v_n^{2}\,\bigl(1 + k_s\, s\bigr) \qquad \mathrm{damage} = \frac{\max(0,\; E - T_{\mathrm{zone}})}{K}
```

- **m\_eff** is the reduced mass of the two bodies, m1·m2 ÷ (m1 + m2). For a creature, the mass on its side is the mass of the zone that was hit, not the whole body (zone shares are in the Milestone 1 table and, for rulers, set per ruler). When something hits a static object or the ground, m\_eff is the hitting zone's mass.
- **v\_n** is the relative speed along the contact normal at the moment of first contact. Before each physics step, store the linear and angular velocity of every body and the animated velocity of every hit zone, whatever its speed. When a new contact appears, compute v\_n from those stored velocities. For dynamic-against-dynamic contacts, Rapier's contact-force events (impulse ≈ `totalForceMagnitude()` × DT) are a cross-check.
- **Sensor zones give no contact data.** A sensor only reports that an overlap started or stopped. On a started event, take the contact normal from `collider.contactCollider(other, …)` and v\_n from the stored velocities.
- **s** is the sharpness of the striking point, counted only when that point is leading into the contact (DungeonStyle already checks for a leading edge on thrown weapons). k\_s = 3 (starting value).
- **T\_zone** is the toughness threshold of the zone that was hit. Below it, the hit bruises and pushes but does no damage.
- **K = 18 J per hit point**, the same constant DungeonStyle uses for thrown weapons (`projectileStrike` in `src/sim/combat.ts`: damage = ½·m·v² ÷ 18). DungeonStyle's tuned melee moves are expressed through the rule as E = `MoveDef.damage` × 18, so a jab (4) is 72 J and a hook (10) is 180 J, close to real punch energies. For melee, use the damage DungeonStyle's `hit()` computes for the blow (weapon, counter and power multipliers included, perks removed) × 18, and don't apply the sharpness factor again: the weapon is already in that number.
- **Hard landings:** for a body hitting the ground or a wall, first subtract the energy of a safe landing, ½ · m\_zone · v\_safe², with v\_safe = 6 m/s for humans (starting value; set per species).
- **Human muscle is capped:** a throw's launch speed is the technique's speed or √(2 × 400 J ÷ mass), whichever is lower (starting value), so a heavy object thrown by a person carries no more energy than a spear.
- **Continuous harm is a rate, not an impact.** Fire, bleeding (DungeonStyle's `BLEED_DPS`) and drowning do damage per second. This is the only exception to the rule.

Starting toughness thresholds: humans 0 J (keeps DungeonStyle's tuning), mid-size hide 0 J (keeps DungeonStyle's tuned brawls), brute hide 300 J, ruler soft zones 600 J, ruler armoured zones 4,000 J. Ruler hit points: 12,000 (starting value). Damage that makes no wound heals fast (see Persistent wounds).

Worked calibration, which also proves rule 5 (rulers can't be killed with weapons):

| Impact (on the 14 t Milestone 1 ruler) | m\_eff | v\_n | Sharpness | E | On armour (4,000 J) | On an eye (600 J) |
| --- | --- | --- | --- | --- | --- | --- |
| Human hook | — | — | 0 | 180 J | 0 HP | 0 HP |
| Two-handed axe, committed swing (46 damage in DungeonStyle) | — | — | In the weapon's damage | 830 J | 0 HP | 13 HP |
| The same swing as a perfect counter (×1.6) | — | — | In the weapon's damage | 1,330 J | 0 HP | 40 HP |
| Thrown spear, 1.5 kg | 1.5 kg | 20 m/s | 0.9 | 1,110 J | 0 HP | 28 HP |
| Thrown 40 kg sharpened log (held to the 400 J muscle cap) | 40 kg | 4.5 m/s | 0.6 | 1,120 J | 0 HP | 29 HP |
| 300 kg log dropped 4 m onto its chest zone (31% of its mass, 4.35 t) | 281 kg | 8.9 m/s | 0 | 11,000 J | 390 HP | — |
| 800 kg boulder rolling into the same zone | 676 kg | 8 m/s | 0 | 21,600 J | 979 HP | — |
| Ruler falls 3 m onto a stake (5% of its mass, 700 kg, lands on it) | 700 kg | 7.7 m/s | 0.6 | 57,700 J | 2,982 HP per stake | — |

Weapons can't keep up with a ruler's recovery (30 HP a second of damage that makes no wound), while one good trap leaves a wound worth hundreds or thousands of hit points. The numbers make rule 5 true by physics, not by a special case. Weapons matter when a ruler is down: see Persistent wounds.

**Knockback** follows momentum, as DungeonStyle already does (`pushScale`, and Δv = p ÷ (M + m) for thrown weapons). Rapier resolves pushes between free dynamic bodies. A ruler on its feet takes no pushes from the physics solver: its hit zones are sensors, and the momentum an impact would transfer is checked against its trip rules instead (see Beast AI).

### Elements

Each element is a few rules on properties, so every new entity works with fire and water automatically.

**Fire:**

- An entity ignites when its temperature passes its ignition point and its moisture is below 0.3. Heat dries an entity first, then warms it.
- A burning entity heats everything within a radius proportional to its size, scaled by flammability, and pushed downwind.
- Burning consumes integrity. Wood turns to embers, then ash. Rope burns through and drops what it held.
- Ground cover (grass, leaves, undergrowth) burns on a 2 m grid near activity: unburnt, burning, burnt.
- Rain and water add moisture and put fires out.
- Creatures in fire take damage per second (starting value: 8 HP/s for a human, scaled by a species' fire resistance) and react by temper and traits: most flee, some charge through.

**Water:**

- Water bodies have a level and a flow direction. Entities in water get buoyancy (water density × submerged volume) and drag toward the flow.
- Damming: a river segment blocked by enough entities raises the water level upstream over time. When the blockage breaks or is removed, a surge travels downstream: a burst of flow speed that drags entities and creatures with it and soaks everything it reaches.
- Wet entities are heavier (moisture adds mass) and rot faster.

**Mud:**

- Soil with moisture above 0.7 is mud. A creature sinks in proportion to its ground pressure (weight ÷ foot area), so a 10-ton ruler sinks deep while a person barely slows.
- Sinking slows movement; sinking past 40% of leg length means stuck for a few seconds while it struggles.
- Logs or planks laid on mud spread weight, so the player can build a path a ruler can't use.

**Snow and avalanches:**

- Snow cells on slopes steeper than 30° have a stability value, 0–1. Impacts, explosions, loud noises (a ruler's roar) and digging underneath lower it.
- At zero the slab releases. Simulate it cheaply: 20–60 large snow-chunk bodies driven down the fall line, plus particle visuals. Chunks deliver impact damage by the rule; anything caught is buried and immobile for a few seconds.

**Gas and explosions:**

- Swamp vents fill a volume with gas that regenerates slowly. Fire inside the volume explodes it.
- An explosion applies a radial impulse falling off with distance (scaled by gas volume) and ignites what's around it. Damage comes from the impulse through the damage rule.

### Breaking and decay

- **Breaking:** every entity has a break energy (material strength × its mass). An impact above it lowers integrity in proportion; at zero the entity splits into 2–4 pre-cut pieces (a log into halves, a rock into chunks). Lashed structures usually fail at their joints first. An impact's damage is applied before the struck entity breaks, so a stake that shatters still delivers its blow.
- **Load:** every entity also has a load capacity: its break energy ÷ 0.1 m (starting value), in newtons. A sustained force above it, averaged over 0.2 seconds, breaks it; loads on a cover spread over the pieces under them. A rotten 2 kg branch holds about 100 N, so ten of them under leaves hold a careful 73 kg player (716 N) but not a 14 t ruler's foot (about 69 kN). Players' and creatures' feet don't push through the solver, so their load is computed: body weight shared among the feet on the ground, applied to whatever is under each foot.
- **Decay (starting values):** vine rope loses 2% strength per hour of play, doubled when wet; green wood dries over a few hours of play; dry wood rots slowly. Decay weakens things but never deletes what the player built: an entity is removed only when it rots to zero integrity. Loose debris in Wild cells (fallen branches, broken pieces) that the player hasn't touched for 5 hours of play, while more than 200 m away, is removed.
- **Frozen entities age when they wake.** An entity frozen far from the player (see Performance budgets) applies the decay and drying it missed, all at once, when it's put back into the physics world.

### Readability

Every state a rule depends on is shown (rule 3):

| State | Look | Sound |
| --- | --- | --- |
| Wet | Darker, glossier | Drips, squelch underfoot |
| Dry | Paler, matte | Crunch underfoot |
| Rope under tension | Straight and thin | Creaks louder near breaking |
| Rope fraying or burning | Fuzzy, thinner, glowing | Snapping fibres |
| Unstable snow | Overhanging cornice, cracks | Low groans |
| Mud | Glossy dark ground, footprints fill with water | Suck and squelch |
| Gas | Shimmer and bubbles over the water | Bubbling |
| Low integrity | Cracks, splinters, sagging | Cracking |

## The player

The player is DungeonStyle's fighter, unchanged in how it fights, dropped into an open world with hands that can pick up, carry and use anything light enough.

**Body:** DungeonStyle's `Fighter` at scale 1: the 12-bone humanoid skeleton, planted-foot footwork, contextual motion, stamina, automatic defence and the powered ragdoll. Human hit points stay at 100 (`DEFAULT_STATS`).

**Movement:** walk, run (DungeonStyle's real run at about 3.8 m/s), sprint while stamina lasts. New for the Wild: **jump** and **climb** (low ledges, vines, fallen trunks), plus swimming. Movement over terrain uses Rapier's `KinematicCharacterController` (available in 0.21) instead of DungeonStyle's flat 2D `Walkable`.

**Body in the physics world** (verified with Rapier 0.21 in Node):

- **A character-controller capsule** moves the player. Turn its built-in pushing off (`setApplyImpulsesToDynamicBodies(false)`): left on, a walking capsule shoved an 800 kg box 4.6 m in 3 seconds, whatever `setCharacterMass` was set to. Instead, for each `computedCollision` against a dynamic body, apply a push in code of at most 500 N (starting value), so friction decides: a 40 kg log slides, an 800 kg boulder doesn't move.
- **Keep the capsule out of the solver for dynamic bodies** (solver groups that exclude them). Otherwise a falling log bounces off the player as if off a fixed wall. Falling and thrown things reach the player through sensor hit zones and the damage rule, and push the player through knockback.
- **Pass `QueryFilterFlags.EXCLUDE_SENSORS`** to every `computeColliderMovement` call, or rope sensors and other creatures' hit zones block the player.
- **Who owns position:** `CombatSim` proposes each step's movement (its `locomote`), and the character controller resolves it against the world.
- **Knocked down or launched** (by a blow, an explosion, a fall or a ruler's swing, but not DungeonStyle's own authored jumps and flips, which stay animated), the player's root becomes a dynamic capsule in the sim's Rapier world until they get up, so falls, cliffs and being flung are decided by the sim, not by the presentation ragdoll.
- **Terrain height:** DungeonStyle assumes flat ground at y = 0 in several places (`combat.ts` lines 604, 783 and 1517, `footwork.ts` lines 75 and 130, `game.ts` line 1057); each needs the terrain height under it.
- Mid-size creatures use the same setup.

**Hands and carrying:**

- **Hands:** one held object, or one two-handed object. Weapons, tools, rope coils, logs and carcasses all go in the hands.
- **Belt:** up to three small items (flint, a rope coil, bait).
- **Back:** one tool or one bundle (a stack of stakes, a bundle of branches).
- **Limits come from mass:** up to 40 kg carried alone, 150 kg dragged; heavier things need a lever or rolling. Carrying slows you and costs stamina, as heavy weapons already do in DungeonStyle.

**Primitive weapons** are built with verbs and described in DungeonStyle's `WeaponDef` format (mass, length, edge, cut, cleave, tempo), so the existing armed techniques and `GORE` rules apply:

| Weapon | Built from | Closest DungeonStyle weapon | Notes |
| --- | --- | --- | --- |
| Sharpened stick | A branch, shaped | Bokken (blunt until sharpened) | Thrust only once sharpened |
| Spear | A long branch, sharpened or flint-tipped | Gladius techniques (`thrust`), longer reach | The best throwing weapon |
| Stone axe | Flint lashed to a handle | Machete / cleaver | Also the main cutting tool |
| Club | A heavy branch or bone | Bat | Blunt, staggers |
| Throwing stone | A stone | Thrown weapons (`projectiles.ts`) | Free, everywhere |
| Torch | A stick coated in resin, lit | Lead pipe, plus fire | Ignites what it touches; scares some beasts |

**Combat:** DungeonStyle's controls and rules carry over: Q and E punch or parry, R and F kick, G picks up or swaps a weapon, automatic block, duck, weave and slide, counters, perfect parries, lock-on when a creature is within range. Mid-size creatures are fought exactly like DungeonStyle opponents.

**Verb controls** (starting bindings; rebindable through DungeonStyle's settings; gamepad mapping is decided in Milestone 1):

| Action | Keyboard and mouse |
| --- | --- |
| Target | The nearest entity under the camera's aim within 2.5 m is highlighted; Tab cycles between nearby ones |
| Verb menu | Hold V for a radial of the verbs the highlighted entity allows; release on one |
| Pick up, drop | G, as in DungeonStyle, for anything light enough |
| Throw | Hold X to aim, release to throw |
| Place | While carrying, hold C for a placement preview; the mouse wheel rotates it; click to set it down |
| Lash, bend | Choose it from the verb menu on the first entity, then highlight the second and confirm |
| Cut, dig | Strike with an edged or digging tool in hand: a strike on a tree chops it, a strike on the ground digs |
| Jump, sprint, crouch | Space, Shift, Ctrl |

**Environmental kills:** a kill is environmental when the finishing damage came from a world entity, or from a hazard the creature was knocked into within the last 2 seconds (fire, a cliff edge, stakes, water). Environmental kills pay double parts and trigger the kill cam. This is how a 30-second brawl teaches the trapping mindset without a tutorial.

**Armour is material, not tiers:** hide or bone armour adds its toughness to the zones it covers. It matters against mid-size creatures and is nothing against a ruler (whose blows deliver tens of thousands of joules). DungeonStyle's armour shop, training stats and skills are removed.

**Down, death and respawn (starting values):**

1. At 0 HP you die. In single-player, `CombatSim`'s KO at 0 HP runs the death flow: a short slow-motion beat (DungeonStyle's death camera), then you **respawn after 10 seconds** at the nearest lit beacon, or at the Landing.
2. You drop what was in your hands where you fell. Belt and back stay with you, and so does everything you built.
3. Your own limbs only come off with the blow that kills you (DungeonStyle's existing rule, which checks for a KO; in multiplayer it must check for death instead, because a downed player can be revived).
4. Multiplayer later adds a **downed** state: crawling and bleeding out over 30 seconds while a teammate can revive you.

## Trapping

There is no trap system: a trap is any arrangement that makes the world deliver far more energy than a human can, at the right moment. Trapping is the skill the whole game is about.

**Two speeds:**

- **Improvised traps (seconds):** made mid-chase from what's already there. Cut the rope holding a log, kick out a prop, light the grass behind you, topple the tree you half-chopped earlier, lead a boar over a ledge.
- **Planned traps (one or more sessions):** prepared for rulers. Pits, log funnels, stacked deadfalls, dams, avalanche ridges. They persist in the world and in the save, so one can be built over several sessions.

**Traps that must emerge from the rules.** These are not features to implement; they are tests of the physics model. Each one gets an automated test scene built only from entities and verbs (see the Build plan).

| Trap | Built from | Why it works |
| --- | --- | --- |
| Deadfall | A heavy log propped on a stick, bait tied to the stick | The beast pulls the bait, the prop falls, gravity drops the log |
| Spike pit | A dug pit, sharpened stakes placed point-up, covered with branches and leaves | The cover's strength is below the beast's weight; falling onto sharp points concentrates the energy |
| Spring snare | A bent sapling, a vine loop, a trigger stick | Released spring energy lifts small game by the leg |
| Swinging log | A log roped to a high branch, pulled back and tied | Cutting the tie releases a pendulum across the path |
| Felled tree | A tree cut most of the way through, with a rope tied high on the trunk | Pulling the rope from a safe distance (or one last cut, timed as the beast passes) drops the trunk on it |
| Rolling boulder | A boulder on a slope, levered loose | Gravity and mass |
| Fire line | Fat or resin on dry grass across a path | Ignited when the beast is inside; fire spreads, the beast burns and panics |
| Flood | A dammed stream released above a crossing | The surge drags and knocks down whatever is in the channel |
| Mud trap | A wet hollow, made wetter by diverted water | A heavy beast sinks and gets stuck; light humans don't |
| Avalanche | An unstable slab above a pass | Noise or an impact releases it onto the path below |
| Funnel | Fallen trees and log walls along a charge path | A charging beast can't steer fast, so it's guided into whatever waits at the end |
| Slow fuse | A rope holding something, set alight at one end | The rope burns through after a delay |

The real goal is the traps nobody listed. Milestones 1 and 4 aren't done until a playtester invents a trap nobody planned.

**Triggers** are just physics too:

- **Manual:** cut a rope, pull out a prop, pull a rope from cover, light a fuse.
- **Contact:** a tripwire, a rope across a path whose anchor gives way.
- **Weight:** a cover or platform whose strength is below what crosses it.
- **Time:** a burning rope.

**Lures:**

| Lure | How it works |
| --- | --- |
| Bait | Meat and carcasses give off scent, carried downwind; beasts follow scent trails |
| Noise | Shouting, banging wood, a falling tree; hearing range falls off with distance |
| Being seen | A running player is the strongest lure for a predator: the chase itself |
| Fire | Attracts or repels, depending on the ruler's traits |
| Distress | An injured creature's cries draw predators |

**Hunting alone:** a solo player can't lure a beast and spring a trap by hand at the same moment, so solo hunting leans on triggers that need no hands at the right instant: weight (a pit cover), a tripwire, a fuse, or a rope pulled from cover with the Pull verb. The usual solo pattern is to bait a trail or be chased past a weight trigger, or to wait in cover at the end of a pull rope.

**Credit:** every entity records the IDs of the players who built, placed or moved it, and damage it deals is credited to them. In single-player that's always the player, so credit only decides what the journal records. How credit is split between players is a multiplayer decision; don't build weights or splits now.

## Territory and the front

The front is simply where human land ends and a ruler's land begins: it moves forward when a ruler dies and the player holds its land, and backward when the Wild takes neglected land back.

**Cell states.** Every 32 m cell is in one of three states and has a **hold** value from 0 to 100:

| State | What it means | What happens there |
| --- | --- | --- |
| Wild | Ruled by a living ruler, or reclaimed by the Wild | Forest regrows, creatures spawn, the ruler hunts anyone it detects |
| Contested | Its ruler is dead, but the player doesn't hold it yet | Regrowth slows, creatures spawn less, beacons can be built |
| Claimed | Held by the player: a beacon within range and hold above 50 | No regrowth, few spawns, shelters can be built, respawn at beacons |

**Taking land:**

1. While a ruler lives, its whole territory is Wild. Mid-size packs patrol its edges. The player can go in, but it's deadly.
2. When the ruler dies, its territory turns Contested, and the kill goes into the journal as a marked moment.
3. The player claims cells by building a **beacon**: at least 4 logs and 3 stones within 2 m of each other, lit (starting values). The game recognises the arrangement; there's no beacon item. A lit beacon burns for 2 hours of play per refuel of 4 more logs.
4. **Hold (starting values):** cells within 64 m of a lit beacon gain 10 hold a minute, up to 100, and are Claimed above 50. Cells whose beacon has gone out lose 1 hold every 5 minutes. A creature raid takes 20 hold from the cells it reaches. The Landing is always Claimed at 100.

**The Wild fights back (starting values):**

- A living ruler next to Contested or weakly held cells pushes into them, mostly at night. It can take at most **1 cell per in-game night in single-player (3 in multiplayer)**, only cells adjacent to its own land, and only cells with hold below 30.
- Mid-size creatures raid claimed land next to living rulers at night. Near the player they're real creatures that can wreck structures; far away, a raid is resolved statistically and only lowers hold.
- Contested cells (no beacon) left unvisited for 3 hours of play regrow and revert to Wild.

**Persistent wounds.** A big enough hit leaves a wound that never fully heals within the world:

- Any single hit above 2% of the ruler's maximum hit points (240 HP on a 12,000 HP ruler, starting value) creates a **wound**: a visible scar, burn or bleeding cut, recorded with its cause.
- A hit above 15% creates a **severe wound** that changes behaviour: a broken leg (it limps, slower to charge), a lost eye (a blind side), a broken tusk or jaw (weaker attacks), deep burns (it fears fire more, or rages at it, by trait).
- **Recovery:** damage that made no wound heals at 30 HP a second (starting value). It doesn't heal while the ruler is **down** (tripped, or in a pit), **stuck** (sunk in mud), **pinned** (at least 1 t of dynamic mass resting on it) or burning.
- **Finishing:** any damage dealt while the ruler is down, stuck or pinned is added to the wound that put it there. That's when weapons matter: they finish what a trap started.
- **Wounds heal slowly:** 50 HP per hour of play (starting value), and never above the ruler's maximum minus its wound penalties (each severe wound takes 5% off its maximum).
- Wounds are saved with the world, so a ruler can be worn down over many sessions. In multiplayer, wounds from every group will add up, and every contributor will be named on the kill record.

**Taming a world.** When the last ruler falls, the Wild is tamed: the player gets a record of the world and its trophies, and can start a new Wild from a new seed. Knowledge, the bestiary, trophies and cosmetics carry over; the world, structures and land don't. Single-player target: roughly 15–25 hours of play to tame a world (starting value), tuned by ruler hit points and the number of territories. In multiplayer this becomes a **season** shared by a whole server, aimed at 3–6 weeks.

## Progression and economy

Players progress through knowledge, materials and trophies; nothing in the game makes a player's numbers bigger.

**Knowledge (the bestiary):** each species has a page that fills in as players observe, fight and trap it.

| Entry | Revealed by |
| --- | --- |
| Habitat and patrol habits | Watching it from cover for a while |
| Senses (sight, hearing, smell) | Being noticed, or not, at a distance |
| Weak zones | Landing a hit on that zone |
| What lures it | Using that lure on it |
| What it fears | Seeing it flee from something |
| This world's traits (rulers) | Seeing the trait in action, such as a ruler crossing deep water |

The bestiary is per player and carries across worlds, except ruler traits, which are drawn fresh per world. It lives in a player profile store in IndexedDB, separate from any world's save.

**The journal** records what a player has made (the first spear, the first deadfall that killed something), with the moment marked (and saved as a clip once the clip button exists, in Milestone 5). It never shows recipes.

**Materials are the economy.** Beast parts are what's valuable, because better materials make better tools and traps through their properties, not through tiers:

- Sinew rope is 3× as strong as vine rope.
- Bone stakes hold a sharper point than wood.
- Ruler bone holds a point almost as hard and sharp as flint, and is five times as strong, so it doesn't shatter.
- Fat is fuel and makes ground slippery.
- Hide makes covers, bags and armour.

**Trading** arrives with multiplayer, and stays physical: hand an item over, or drop it for someone.

**Rare drops (the Diablo hit):** rare variants (about 1 in 500 mid-size creatures, starting value) drop rare-material parts, and every ruler drops legendary parts. A rare drop gets its own moment: a sound, a glint and a line in the journal.

**Traplines (the idle layer):** snares set for small game catch things while you're away. When the player is more than 150 m from a snare (the frozen distance), the sim resolves it statistically every 5 minutes of play (starting value) from where it's placed (near game trails, with bait, in the right biome) instead of simulating the animal. Checking a trapline is quick, a little unpredictable, and a reason to come back: on loading a save, traplines catch up on the time away (capped at 8 hours).

**Trophies and status:** ruler parts can be mounted in a shelter; a memorial at the Landing lists every ruler kill; cosmetics come from rare materials. None of them change how a player fights.

## Multiplayer later

Multiplayer is not part of this build, but the single-player game is built so it can be added without a rewrite: the same sim moves to a server, and a single-player save can become the starting state of a hosted world.

**What multiplayer will be:**

- **Worlds:** one world per server, 30–50 players (starting cap: 40). More players means more servers.
- **Solo and groups:** solo players keep a complete game; parties of up to 6 share map markers, revives and trap credit, and rulers are where groups shine (one scouts, one lures, one springs the trap).
- **Collaboration without coordination:** built things persist, so good killing grounds grow as different players add to them; wounds on a ruler add up across every group; ruler kills are announced server-wide with names.
- **No ownership:** no plots; anyone can use anything. Griefing limits (starting values): rule 11; taking apart someone else's structure is slow (5 seconds per joint, 20 seconds for structures under 30 minutes old built outside your party), visible and logged; at most 60 built entities per player.
- **Talking:** proximity text chat, party chat, emotes and map pings. No voice chat.
- **Seasons:** taming a world becomes a season shared by the whole server, aimed at 3–6 weeks.

**What to do now so it stays cheap later:**

1. **Keep every outcome in the sim** (rule 6). Nothing in rendering, audio or ragdolls may change the game.
2. **Keep the sim deterministic** (rule 7). The same seed and the same inputs must give the same world state; a test checks it from Milestone 1.
3. **Route all input through commands.** Player input becomes tick-tagged commands (move, button, verb) before the sim sees it. Networking later only changes where the commands come from.
4. **Keep time effects in the game loop** (rule 8).
5. **Make the save file the world state.** Everything the sim needs to resume lives in the save (see Technical architecture), so a server can load the same format.
6. **Use player IDs and credit from the start,** even with one player.

## Dopamine loop and virality

The game needs hits at every time scale, from a tree crashing down every few seconds to a ruler falling every few sessions, and the best moments have to turn into clips with one button.

| Every… | What happens | Where it comes from |
| --- | --- | --- |
| Few seconds | A tree crashes down, a boulder rolls, a snare snaps, a hit lands with a ragdoll reaction | Physics juice on every action |
| 30 seconds | A gory knockout on a mid-size creature | DungeonStyle combat |
| Few minutes | An improvised trap mid-chase; a trapline check; a rare drop | Systemic physics, traplines, rare variants |
| Session | Wounding a ruler, or being flung across a valley by one | Persistent wounds, funny failure |
| Few sessions | A ruler falls and its land opens up | Territory |
| World | The last ruler falls; a new Wild begins | Taming a world |

**Juice on every action.** Chopping should feel like DungeonStyle punching: the tree shudders with each chop, creaks before it goes, falls with weight, and lands with a thud, dust and camera shake scaled by its mass (DungeonStyle's `bodyLanding` already does this for bodies). Every rope snap, every crush, every splash gets a sound and a reaction.

**The kill cam** reuses `src/render/cinematics.ts` (a `Shot` with focus, side, distance, orbit, dolly, slow and priority) the way DungeonStyle uses it now: a camera cut with real slow motion. Trigger every kill cam through one function that receives the moment (rule 8), so multiplayer can later make that function play a replay instead, since a shared world can't slow down. Triggers:

1. An environmental kill (see The player).
2. A trap hit on a ruler that creates a wound.
3. A ruler's death.
4. The player being killed or flung by a ruler (funny failure).

**The clip button** reuses `src/game/recorder.ts`, which already encodes the canvas to H.264 with WebCodecs (30 fps, a keyframe every second, MP4 export). Changes:

- Keep a **rolling 30-second buffer** instead of whole battles: drop chunks older than 30 seconds, always starting from a keyframe.
- Encode the buffer as a **vertical 720×1280 crop** centred on the player (the encoder already draws each frame into its own canvas, so this is a change to that `drawImage`), ready for TikTok and Instagram Reels. The clip button needs the WebCodecs encoder: the MediaRecorder fallback films the canvas as it is and can't crop. The encoder support check currently runs at 1280×720, so repeat it at 720×1280.
- Add the game's name as a small watermark and keep DungeonStyle's moment marks (hits, gore, KOs) so the best second is easy to find.
- Export at the player's gore setting (rule 12).

**Big moments get an alert:** a ruler wounded, a ruler killed, a rare drop, reaching a landmark for the first time. At most one a minute (starting value), with ruler deaths always shown. In multiplayer these become server-wide, with names.

## Technical foundation: the DungeonStyle repo

Fork [Wryz/dungeon-style](https://github.com/Wryz/dungeon-style) at `50b64bf` as the starting codebase: its deterministic 60 Hz combat sim, humanoid bodies, powered ragdolls, rendering, audio and clip recorder carry over almost unchanged, while its arena, gauntlet and shop layers are replaced by the open world.

**What was verified on 2026-10-16:**

- **Stack:** TypeScript 5.9, Three.js 0.186.1, Rapier 3D (`@dimforge/rapier3d-compat` 0.21.0, WASM), Vite 7.3, Vitest 3.2, Tweakpane 4 for the dev panel. No backend.
- **Size:** about 17,500 lines in `src/` and 3,300 lines of tests.
- **The sim already runs headless:** `npm test` runs 24 test files (232 tests) in Node 22, all passing, including AI-vs-AI fights across every arena (`tests/collision.test.ts`). Nothing in `src/sim/` or `src/body/` touches the DOM; they use Three.js only for vector and quaternion maths, which works in Node.
- **Rapier runs on a server:** a Node 22 smoke test of rapier3d-compat 0.21 created a heightfield terrain, dropped a 300 kg log with continuous collision detection onto a stake, read contact-force events from it, held a weight on a rope joint at exactly its 3 m length, and took and restored a world snapshot. All of it worked.

### The principle to keep

DungeonStyle separates **gameplay truth from visuals**. The combat sim (`src/sim/`) decides every hit against the *animated* pose; the visible body is a Rapier ragdoll that chases that pose (`src/body/ragdoll.ts`), which is where the weight and reactions come from. Physics can never make a correct move miss. The Wild keeps this for fighters and creatures, and extends it to the world: anything that changes outcomes is decided by the sim, and everything that only looks physical is presentation.

### What Rapier does today, and what it must do in the Wild

This is the most important finding about the foundation:

- **Today, Rapier is visual only.** It's imported in two files: `src/game/game.ts` creates the world (gravity −9.81, timestep `DT`, a 400 m × 400 m ground box and arena walls) and `src/body/ragdoll.ts` builds the ragdolls. Every gameplay physics rule (momentum knockback in `pushScale`, ballistic thrown weapons in `src/sim/projectiles.ts`, body capsules in `src/sim/bodyShapes.ts`, 2D circles and boxes for props in `src/world/collision.ts`) is hand-written in the sim.
- **In the Wild, Rapier becomes gameplay physics inside the sim.** Falling trees, logs, boulders, ropes and stakes decide outcomes, so they must be real rigid bodies simulated in one place. The sim owns one Rapier world for terrain and entities (in the browser now, on a server later); a second, separate Rapier world handles only ragdolls and cosmetic debris, so presentation can never change an outcome.
- **The hand-written sim rules stay and connect to that world.** Fighter-vs-creature melee stays in `CombatSim` (it's tuned and tested). Fighters and creatures appear in the sim's Rapier world as character-controller capsules with sensor hit zones (not plain kinematic bodies, which act as if their mass were infinite), so falling logs and boulders hit them through the damage rule, and DungeonStyle's 2D `Walkable` is replaced by terrain and collider queries.

### Reuse map

| Path | What it is | In the Wild |
| --- | --- | --- |
| `src/sim/combat.ts` | `CombatSim`: the 60 Hz step loop, hit detection, block, dodge, counter and parry, events, `pushScale`, thrown-weapon strikes | **Keep.** Runs creature brawls; damage expressed through the damage rule |
| `src/sim/fighter.ts` | `Fighter` state machine, stats, scale, stamina | **Keep** for players and humanoid creatures; remove shop stats |
| `src/sim/moves.ts`, `select.ts` | Frame data for every move, context move selection, automatic defence | **Keep** as is for players |
| `src/sim/ai.ts` | `BrawlerAI`, `AIPlan`, tempers, specials, `AIDirector` turn-taking | **Keep** as the fighting layer of mid-size creatures, under the new world AI (see Beast AI) |
| `src/sim/enemies.ts`, `roster.ts` | Archetypes: stats, style, plan, scale up to 1.95× | **Template** for creature archetypes |
| `src/sim/weapons.ts` | `WeaponDef` (mass, length, edge, cut, cleave, tempo), armed techniques, `GORE`, wounds, dismemberment | **Keep**; add primitive weapons in the same format |
| `src/sim/projectiles.ts` | Rigid ballistic flight, spin, sub-steps, `aimBallistic` | **Keep** for fast small throws (spears, stones); big thrown objects become Rapier bodies |
| `src/sim/math.ts` | `DT = 1/60`, seeded `Rng` | **Keep**; mandatory for determinism |
| `src/sim/perks.ts`, `src/game/catalog.ts`, `economy.ts` | Skills, shop catalogue, armour tiers, coins, `localStorage` saves | **Remove** (rule 4); replaced by world save files. combat.ts imports PERFECT\_TIMING\_FRAMES and checks perks about a dozen times, fighter.ts checks quickHands, and combat.test.ts tests three perks; strip the checks and those tests together in Milestone 1 |
| `src/body/*` | 12-bone skeleton, authored poses, animator, footwork, idle life, contextual motion, ragdoll | **Keep** for humanoids; ragdoll stays client-side |
| `src/render/fighterView.ts`, `blood.ts`, `gibs.ts`, `particles.ts` | Low-poly bodies, blood, flying body parts | **Keep** |
| `src/render/cinematics.ts`, `cameraRig.ts` | Camera cuts with slow motion; the three-quarter fight camera with trauma shake | **Keep**; add an open-world follow mode (cuts become replays only in multiplayer) |
| `src/render/cutout.ts` | Dissolves geometry between the camera and the action | **Keep**: essential in dense forest |
| `src/feel/audio.ts` | Procedural WebAudio: surfaces, materials, impacts, ambience | **Keep and extend** to the new materials (creaks, cracks, fire, water) |
| `src/game/recorder.ts`, `src/ui/battleLog.ts` | WebCodecs H.264 recording with marked moments, MP4 export | **Adapt** into the clip button |
| `src/game/trauma.ts` | Accumulated damage and bleeding by zone | **Keep** |
| `src/input/*` | Rebindable keyboard, mouse, gamepad and touch | **Keep**; add verb bindings |
| `src/ui/hud.ts`, `settings.ts` | HUD and settings | **Keep**; drop shop and run-summary screens |
| `src/debug/panel.ts` | Tweakpane live tuning in dev mode | **Keep**; add every world starting value |
| `src/arena/*`, `src/world/collision.ts`, `src/game/gauntlet.ts` | Arenas, 2D walkable areas, round flow | **Replace** with terrain, world and territory |
| `src/game/game.ts` | 1,793 lines of glue: fixed-step loop, events, spawning, gore, camera | **Split**, don't port: the game loop and the sim world each take the parts they need |
| `tests/*` | Combat, reach, collision, gravity, weapons and AI tests | **Keep passing**; add world tests |

### Limits in the foundation that need work

1. **Time scale is global.** `Game.frame` multiplies the fixed-step accumulator by a time scale for slow motion and cinematics, and `fixedStep` freezes everything during hit-pause. Single-player can keep this, as long as it stays in the game loop (rule 8); multiplayer will turn it into replays.
2. **The ragdoll writes into sim state today** (breaks rule 6). `game.ts` line 232 sets `externalKnockdown = true`, and lines 1056–1058 copy the ragdoll's pelvis into a knocked-down fighter's `f.pos`. In the Wild, the sim's own dynamic capsule decides where a downed body lies, and the ragdoll follows it.
3. **Hidden randomness and global counters** (break rule 7). Seeds come from `Date.now()` (`game.ts` lines 136, 231 and 570), and module-level counters hand out ids (`nextId` in `fighter.ts` line 115, `usedSlots` in `ragdoll.ts` line 17). The sim's seeds come from the world seed, and counters belong to the world so they reset with it.
4. **Input arrives per frame, not per tick.** `game.ts` lines 903–913 write `moveInput` and button presses once per rendered frame. Commands must be queued and applied per sim tick.
5. **Ragdoll collision slots run out.** Each ragdoll takes one collision bit from `SLOT_BITS = 0xfffc` (bits 2–15), so only 14 ragdolls get a collision bit of their own; a 15th gets none, and other bodies stop colliding with it. The open world needs ragdolls only for the nearest creatures (ragdoll level of detail) and collision filtering by group rather than one bit per body.
6. **Ragdoll bodies never sleep** (`setCanSleep(false)`, 12 bodies per fighter). Fine for a duel, too costly for a crowd: only creatures near the camera get a powered ragdoll; the rest are animated meshes.
7. **Body data lives in the presentation code.** The bone masses the damage rule needs (`MASS`) are private to `ragdoll.ts`, which goes to the client. Move them into the sim package and have the ragdoll import them. The sim's hit zones (`HurtZone` in `combat.ts`: head, chest, abdomen, legs) have no arms; arms count as chest.
8. **Humanoid-only skeleton.** `src/body/skeleton.ts` defines one 12-bone humanoid. Quadrupeds, serpents and bipedal predators need data-driven rigs (bones, joints, hit zones) that the same ragdoll and hit-detection code can read. Milestone 1 stays on the humanoid rig (apes); data-driven rigs arrive in Milestone 4.
9. **Flat 2D arenas.** Positions are on a ground plane with `y = 0`, walls are boxes, and `Walkable` resolves circles in 2D. The Wild needs terrain height, slopes and digging (see The player for the lines that assume flat ground).
10. **Scale tops out at 1.95×.** The size laws generalise (strength grows with size², mass with size³), but set ruler masses explicitly: DungeonStyle's ragdoll mass law (size^2.5) would give a 5.5× ape only 5.2 t, not 14 t. Rulers at 3–6× need the hybrid physics in Beast AI to stay stable.
11. **Single-player saves** in `localStorage` (`loadSave`, `writeSave`). A world is far bigger than localStorage can hold, so world saves go to IndexedDB in a versioned format (see Technical architecture).

## Technical architecture

This build runs entirely in the browser, as DungeonStyle does today: one game loop steps a deterministic sim, a presentation layer draws it, and the world is saved locally. The sim is its own package so it can later run on a server unchanged.

_(Diagram in the online doc: architecture · the browser build now, the server and database later. Its content is spelled out in the text.)_

In single-player everything runs in one browser tab; multiplayer later moves the same sim package to a server and turns save files into a database.

**Repository layout** (npm workspaces):

```text
the-wild/
  package.json      npm workspaces; one Vitest workspace config runs every package's tests
  packages/
    sim/            @wild/sim: deterministic and DOM-free. Entry point src/index.ts.
                    Depends on three (and @dimforge/rapier3d-compat from Milestone 1).
      src/          DungeonStyle's src/sim and src/body (minus ragdoll.ts), plus
                    src/world/collision.ts and src/arena/themes.ts until Milestone 1 replaces them
      src/world/    entities, materials, damage rule, verbs, joints, elements, terrain, territory, decay
      src/save/     world state serialisation, format versions and migrations
      tests/        DungeonStyle's sim tests plus world tests (headless)
  apps/
    client/         Vite + Three.js; depends on @wild/sim through the workspace
      src/          game loop, rendering, input, audio, UI, ragdolls, cinematics, clips, save storage
      tests/        DungeonStyle's tests that import game, render or UI code
```

`apps/server` and `packages/protocol` are added only when multiplayer starts.

**Client:** plain Three.js with DOM UI, as DungeonStyle is built today. No React in the game loop; a framework can be added later for menus only.

**The game loop** (fixed 60 Hz, DungeonStyle's accumulator):

1. Queue input as tick-tagged commands (below), and apply each tick's commands at the start of that tick.
2. Step the sim:
   1. Perception and world AI: full rate near the player, 1 Hz far away.
   2. `CombatSim` for active fights; it proposes each fighter's movement.
   3. Move fighters and creatures in the sim's Rapier world: character controllers resolve the proposed movement for the player and mid-size creatures; rulers' animated sensor hit zones follow their animation.
   4. Step that Rapier world with an event queue. Apply the damage rule to new contacts, update rope tension, break what breaks.
   5. Elements at 10 Hz; territory, decay and traplines at 1 Hz or slower (starting values).
3. Step the presentation Rapier world (ragdolls, debris), then render, interpolating between sim steps.

Hit-pause, slow motion and cinematics only change how many sim steps the loop runs per frame (rule 8).

**Commands:** every input reaches the sim as `{ tick, kind, … }`:

- `move`: a direction quantised to 1/256 and a speed.
- `button`: punch, kick, parry or pick up.
- `verb`: the verb, the target entity's id, an optional second target (for lash and bend), and a placement position and angle (for place).
- `meta`: pause, save, and the time away when a save loads. Wall-clock time enters the sim only this way.

**Determinism (what the tests check):** in one browser or Node process, a fresh world built from the same seed and fed the same command log gives byte-identical saves and bit-identical body states, checked every 60 ticks. Matching across machines or browsers isn't required; Rapier only promises determinism on the same machine. Counters belong to the world and reset with it, entities are iterated in id order, and the sim never reads `Math.random` or the clock.

**Two Rapier worlds:**

| The sim's Rapier world (decides outcomes) | The presentation Rapier world (looks only) |
| --- | --- |
| Terrain, entities, joints, ropes, character controllers and sensor hit zones for fighters and creatures | Ragdolls and cosmetic debris |
| `CombatSim` hits, the damage rule, breaking, elements, decay | Animation, ragdoll reactions, blood, gibs, particles |
| AI, territory, wounds | Sounds, camera shake, cinematics, clips |
| Moves to a server in multiplayer | Stays in the browser |

**Saving:**

- **Where:** IndexedDB, autosaved every 60 seconds (starting value) and on quit. Serialise in a Web Worker so saving never hitches a frame. A separate **player profile** store holds what carries across worlds: the bestiary, the journal, trophies, cosmetics and settings.
- **What a world save holds:** the seed plus everything that differs from what the seed generates (terrain edits; moved, built, broken and removed entities), creatures with their AI state, rulers and their wounds, cells, the sim's random-number states, `CombatSim` and AI timers, world time, and the player. Untouched forest isn't stored.
- **How:** entities are stored as records (material, shape, position, rotation, linear and angular velocity, integrity, moisture, joints, credit). On load, their Rapier bodies are rebuilt in id order, awake. Don't use Rapier's `takeSnapshot()` as the save format: it ties saves to one Rapier version.
- **What "the world matches" means:** save, load and save again gives a byte-identical file; right after loading, every body is exactly where it was saved; a world at rest stays within 1 cm and 1° of its saved positions for 10 seconds. Things in motion when the game was saved (a rolling log) may diverge slightly after loading, and that's acceptable.
- **Versions:** every save carries a format version; loading an older one runs migrations, and tests load saves from earlier versions.
- **Export and import:** a player can download a world as a file and load it again. It's a backup now, and later the way to move a single-player world onto a server.

**Hosting:** a static site with no backend; it can stay on Vercel like DungeonStyle.

### Multiplayer architecture (later)

When multiplayer starts, the sim package moves to a server as it is. Planned shape:

- **Server:** one Node 22 process per world, running the same 60 Hz loop without rendering, and sending each client a snapshot every third tick (20 Hz).
- **Transport:** WebSockets with the `ws` package and a custom binary protocol. Tick-tagged commands go up; delta-compressed snapshots (positions quantised to 1 cm within the chunk, rotations in smallest-three encoding) and reliable events go down.
- **Interest management (starting values):** full detail within 60 m of a player, position-only at 5 Hz out to 200 m, and beyond that only the territory map.
- **Prediction:** the local player's movement is predicted and corrected; a pressed attack animates at once and the server confirms the hit. DungeonStyle's minimum enemy wind-up of 15 frames (`ENEMY_MIN_STARTUP`, 250 ms) also hides network delay. Everything else is interpolated about 100 ms behind. Clients send only commands, never positions as truth.
- **Time effects become replays:** a shared world can't slow down, so kill cams play from a short buffer of rendered transforms while the live game continues.
- **Database and accounts: Supabase.** Its Postgres stores what the save file stores today (wounds, cells, structures, bestiary, players, kill records), and Supabase Auth handles accounts. Only the game server writes game state, connecting with a server-side key; browsers use Supabase only to sign in and read their own profile. Crash-recovery snapshots go to the server's disk and are copied to object storage (Supabase Storage, Cloudflare R2 or Amazon S3).
- **Hosting the game server:** it needs a long-running process with open WebSockets, which neither Vercel nor Supabase can host. Use Railway or Fly.io for the first playtests, then a Hetzner server once a world runs all the time. Choose dedicated CPUs (a physics tick uses CPU constantly, and shared CPUs can be throttled) and a region near the players.

## Beast AI

Beast AI is the hardest and most important system: if beasts don't feel smart and readable, traps feel random and the game falls flat. It's built in four layers, and DungeonStyle's fight AI becomes the bottom layer for mid-size creatures.

**1. Perception:**

- **Sight:** a cone and a range per species, blocked by terrain and dense foliage. Moving targets are seen further than still ones; crouching in undergrowth hides.
- **Hearing:** every noise is an event with a loudness (a footstep, a chop, a falling tree, a shout, a roar). Hearing range falls off with distance.
- **Smell:** players, bait and carcasses drop scent points that fade over minutes and drift downwind; beasts can follow a scent trail.
- **Memory:** last known position of each threat, and what recently hurt it (see Adaptation).

**2. Behaviour (a state machine per creature):**

| State | What it does | Typical way in |
| --- | --- | --- |
| Idle and graze | Feeds, rests, wanders near its home | Nothing noticed |
| Patrol | Walks its route between territory waypoints | Its schedule (by trait: day or night) |
| Investigate | Goes to a noise, a smell or a glimpse, cautiously | A weak or uncertain stimulus |
| Hunt and chase | Pursues a seen target at full speed; charges when in a straight line | A clear sighting |
| Fight | Mid-size creatures: DungeonStyle's `BrawlerAI` with the creature's `AIPlan`; rulers: their own attack set | In striking range |
| Flee and panic | Runs from fire, from a big wound, or from a fight it's losing | Fire, a severe wound, a temper rule |
| Return to lair | Goes home to recover | Badly hurt, or dawn for night hunters |
| Raid | Pushes into weakly held human land at night (rulers) | Night, a neighbouring Contested or weak cell |

**3. Navigation:**

- Navigation meshes per terrain chunk with `recast-navigation-js` (npm package recast-navigation 0.43.1, verified on 2026-10-16 building a navmesh and a path in Node 22; it also runs in the browser), using a larger agent radius for big creatures, so a gap a person can slip through blocks a ruler.
- Rebuild only the affected tiles when trees fall, structures are placed or pits are dug, so beasts respond to a changed world.
- **Charges don't steer.** A charging beast commits to a direction with real momentum and turns slowly (DungeonStyle's bodies already have inertia that scales with size). That's what makes funnels and pits work, and it's readable: the beast lowers its head before it charges.

**4. Body (hybrid physics for giants):**

- Rulers move by animation, like DungeonStyle's fighters. Each hit zone is a sensor collider carrying a share of the ruler's mass (set per ruler; the Milestone 1 giant ape uses the humanoid shares), so logs, boulders and stakes hit it through the damage rule without the solver treating the ruler as an unstoppable kinematic body.
- **Obstacles by mass (starting values):** a dynamic object under 500 kg is shoved aside with the ruler's momentum; anything heavier, anchored or fixed (standing trees, staked log walls) blocks it. A charge that meets a blocking wall at under 30° is deflected along it, which is how funnels steer a ruler.
- A ruler **trips** into full physics when its legs strike a blocking obstacle between ankle and knee height while it moves faster than 4 m/s, when the ground under a foot gives way (a pit cover's load capacity), when it steps off a ledge, or when mud sinks it past 40% of leg length. While tripped it's an ordinary dynamic body, so logs can pin it. It gets up after 4 seconds (starting value), unless pinned.
- Severe wounds change animation and speed (a limp, a blind side).

**Adaptation (so cheap tricks stop working):** when a ruler is wounded, it remembers the cause by feature: a rope across a path, a pit cover, a log above a trail, fire on grass. For a while (starting value: 2 hours of play, fading), it detours around that feature or tests it first. The same trap won't work twice in a row; a new idea will.

**Readable telegraphs:** every big ruler action has a visible, audible wind-up long enough to react to (and, in multiplayer, to hide network delay): the head lowering for a charge, a roar before it pounces, a sniff before it follows a scent. Rulers should feel smart, never unfair.

**Far from the player,** creatures are simulated abstractly at 1 Hz along their routes and territory graph, so the world keeps moving without the cost of full AI.

## Performance budgets and simulation detail

A fully physical world fits in one browser tab only if physics, AI and elements run at full detail near the player and almost not at all elsewhere. All numbers below are starting values to confirm by profiling at Milestone 4.

**Budgets:**

| Target | Budget |
| --- | --- |
| Frame rate | 60 fps at 1080p on a mid-range laptop with integrated graphics |
| Sim step | Under 5 ms on average, leaving the rest of the 16.7 ms frame for rendering |
| Draw calls | Under 300 per frame |
| Visible triangles | Under 1.5 million |
| Active dynamic bodies | 600 at once |
| Save size | Under 20 MB for a fully played world |
| Autosave | No visible hitch (serialised in a Web Worker) |

If the sim step goes over budget, move the whole sim into a Web Worker. Its boundary (commands in, state out) is the same one multiplayer will use, so the work isn't wasted.

**Physics detail for entities:**

| Tier | When | What runs |
| --- | --- | --- |
| Active | Within 40 m of the player, or moving | Full Rapier dynamic body |
| Asleep | At rest within range | Rapier's own sleeping: no cost until something touches it |
| Frozen | More than 150 m from the player | Removed from Rapier and kept as a stored record; put back when the player comes near |

A trap the player isn't near waits, frozen, until they come back. That's fine for gameplay, and it's what makes a fully physical world affordable.

**Elements:** the fire grid runs at 2 m resolution only within 60 m of activity and pauses elsewhere. Water levels and snow stability update at low rates far from the player.

**Creatures:** full perception and AI near the player; abstract movement along routes at 1 Hz far away; powered ragdolls only for the nearest few creatures (see the ragdoll slot limit in Technical foundation).

**Rendering:**

- Instanced meshes for trees, rocks and grass (thousands in one draw call), with simpler meshes at distance.
- Terrain streamed in chunks around the player; frustum culling.
- Shadows only near the camera.
- DungeonStyle's `cutout.ts` dissolves trees between the camera and the player.

**Later, in multiplayer:** a server tick under 8 ms on average at 40 players on one core, and under 64 kbit/s of network traffic per player.

**Mobile** is not a target for the first version.

## Art and audio direction

The Wild should look like DungeonStyle grown into a world: chunky, faceted low-poly shapes, warm light, and silhouettes you can read at a glance, especially the giants.

**Look:**

- **Bodies:** DungeonStyle's blocky, faceted fighters and creatures, with the same chunky low-poly blood and gore.
- **Nature:** flat-shaded trees, rocks and terrain in the same faceted style. CC0 low-poly nature packs (for example Kenney's) can fill in props while bespoke assets are made.
- **Light:** warm sun, long shadows at dawn and dusk, mist in valleys, darker and bluer nights with fires as the main light.
- **Scale:** rulers must read from far away. Their heads and backs rise above the canopy, and trees sway and fall where they walk.
- **Readability over realism:** material states follow the readability table in The systemic physics model. Never rely on colour alone; pair it with shape or movement (sag, fray, shimmer).
- **Wounds show:** every persistent ruler wound is visible on its model: scars, burns, a broken tusk, a missing eye.

**Audio:**

- **Procedural, like DungeonStyle:** impacts by material and mass, footsteps by surface, giants' footsteps that shake the camera. Extend `src/feel/audio.ts` with wood creaking and cracking, rope strain, fire crackle and roar, water and surge, mud, snow groans.
- **Beasts:** every ruler has a distinct roar, and every big action has an audible wind-up (see Beast AI).
- **Ambience over music:** a living jungle (birds, insects, wind, rivers) that goes quiet when a ruler is near. Music only for big moments: a ruler sighting, a ruler's fall.

**UI:** a minimal HUD (health, stamina, what's in your hands, a compass with pings). DungeonStyle's combat cues stay optional and off by default. The bestiary and journal are the only big screens.

## Build plan

Seven single-player milestones, each gated by acceptance criteria, then multiplayer as a later phase; the first real gate is Milestone 1, which proves the fun in a single clearing.

_(Diagram in the online doc: build plan · 7 single-player milestones, then multiplayer later. Its content is spelled out in the text.)_

Each milestone starts only when the one before it has passed its gate; the multiplayer phase starts only after Milestone 6.

**Milestone 0: Fork and split.** Fork the repo into npm workspaces (`packages/sim` as `@wild/sim`, and `apps/client`) without changing behaviour, laid out as in Technical architecture. `packages/sim` takes `src/sim`, `src/body` except `ragdoll.ts`, and, until Milestone 1 replaces them, `src/world/collision.ts` and `src/arena/themes.ts`, which the sim and 14 of its tests import. Everything else goes to `apps/client`, with the tests that import game, render or UI code (arenas, cinematics, economy, gauntlet, lockon, realism, trauma). The economy, gauntlet and arenas tests retire with the shop and gauntlet in Milestone 1; `lockon.test.ts` imports `loadSave` from the economy, so rewrite that part of it then.

- [ ] DungeonStyle's 24 test files still pass from the new layout.
- [ ] In dev mode (`npm run dev`), the client still runs DungeonStyle's training ring (`?mode=training`) unchanged.
- [ ] Player input reaches the sim only as tick-tagged commands, applied per tick (see Commands in Technical architecture).

**Milestone 1: The Clearing.** A 200 m × 200 m heightfield chunk with about 60 trees, saplings, vines, stones, flint and dry grass. Materials and their rules; the verbs cut, shape, carry, drag, place, lash, bend, dig, throw and strike, with their controls; the damage rule on every impact; a navigation mesh, with tiles rebuilt when trees fall; one mid-size creature (an ape, so it can use the humanoid rig, `BrawlerAI` and DungeonStyle's moves); one ruler prototype on the same rig (a giant ape: patrol, investigate, chase, a straight-line charge, tripping into physics, wounds); environmental kills with a kill cam. The shop, gauntlet and perks are removed.

| Milestone 1 value | Starting value |
| --- | --- |
| Ape (mid-size) | Scale 1.1, 90 HP, hide 0 J, walks 2.8 m/s; Bruiser's plan with its shoulder charge |
| Giant ape (ruler prototype) | Scale 5.5 (about 10 m tall), mass set to 14 t (not from DungeonStyle's size law), 12,000 HP |
| Ruler zones | Skull, back, shoulders, flanks: 4,000 J. Eyes, mouth, belly, knees, elbows: 600 J |
| Zone mass shares (humanoid, by `HurtZone`) | From DungeonStyle's `MASS` table (73.3 kg in all): head 7.5%, chest with arms 31.1%, abdomen with pelvis 24.6%, legs 36.8% |
| Ruler recovery | 30 HP a second of damage that made no wound; none while down, stuck, pinned or burning. Wounds heal 50 HP per hour of play |
| Pinned | At least 1 t of dynamic mass resting on the ruler |
| Trip | A blocking obstacle (500 kg or more, anchored or fixed) between ankle and knee height, struck faster than 4 m/s; up after 4 s |
| Shove limit | Dynamic objects under 500 kg are shoved; heavier ones block |
| Player push | Up to 500 N on dynamic bodies, applied in code (the controller's own pushing is off) |
| Felling a tree | One stone-axe chop per 2 cm of trunk diameter (a 30 cm trunk takes 15) |
| Digging | 0.15 m deeper in a 0.5 m radius per strike |
| Load capacity | Break energy ÷ 0.1 m |
| Armour | Hide adds 20 J to the zones it covers, bone 40 J |
| Human throw cap | 400 J of launch energy |

**Milestone 1 repo tasks** (from Limits in the foundation):

- Stop the ragdoll writing into sim state (`externalKnockdown`, `game.ts` lines 232 and 1056–1058); downed and launched bodies get a sim-side dynamic capsule.
- Seed the sim from the world seed instead of `Date.now()`, and move `nextId` and `usedSlots` into the world.
- Apply input per tick through commands.
- Move `MASS` into the sim package.
- Pass terrain height to every place that assumes y = 0.
- Strip perks from `combat.ts` and `fighter.ts`, and delete the perk tests.
- Keep `Walkable` and `RectWalkable` as a flat-ground test fixture, so the tests that use them still run.

* [ ] A case-insensitive search for `trap` in `packages/sim` and `apps/client/src` finds no class, type, enum or entity kind with that word in it; comments, tests and the trapline exception are allowed (rule 1).
* [ ] Headless test scenes built only from entities and verbs show a deadfall, a spike pit, a swinging log and a felled tree each wounding or killing a creature. Tests may script a creature's route and actions (walking a path, pulling bait), never the trap.
* [ ] Solo hunting works: a scripted player lures the giant ape along a path into a weight-triggered spike pit, then pulls a rope from at least 15 m away to drop a log on it. The player is never within 10 m when either trap springs.
* [ ] Rule 5 holds: a scripted player hitting the free ruler's soft zones for 10 minutes with the two-handed axe's committed swing, as fast as the move allows and with every hit counted as a perfect counter, leaves it at full health; the same attacks while it's pinned add to its wound.
* [ ] A test charges the 14-ton ruler at 6 m/s into a staked 300 kg log at shin height: it trips and gets up after 4 seconds. With its AI paused once it's up, it stays stable: no NaN, no body part faster than 30 m/s, and every body below 0.05 m/s within 10 seconds of the impact.
* [ ] A walking player can't shove an 800 kg boulder but can slide a 40 kg log; a log falling onto the player doesn't stop dead as if it hit a wall; a charging ruler is deflected by a staked log wall.
* [ ] Determinism: the same seed and the same command log, run twice, give byte-identical saves and bit-identical body states every 60 ticks (rule 7).
* [ ] Playtest (a person, not a test): within an hour, a tester builds a working trap that isn't in the Trapping table.
* [ ] Playtest: a first-time player gets an environmental kill on an ape within 10 minutes.

**Milestone 2: Elements.** Fire (entity temperature, a ground-cover grid, wind), water bodies with dams and surges, rain, mud, and decay. Snow and gas wait for the biome that needs them.

- [ ] A fire line on dry grass burns across a path and stops at wet grass.
- [ ] A burning rope drops its load after a delay that grows with rope length.
- [ ] The same mud slows the 14-ton ruler far more than a player.
- [ ] A released dam's surge carries a 300 kg log downstream.

**Milestone 3: Saves and a living world.** World generation from a seed (the Landing plus one territory to start); saving to IndexedDB with format versions, migrations, export and import; the player profile store; cells, beacons and hold; persistent wounds; the Wild reclaiming land; decay in play time; frozen entities ageing when they wake; trapline catch-up.

- [ ] Save, load and save again gives a byte-identical file; right after loading, every body is exactly where it was saved; a world at rest stays within 1 cm and 1° of its saved positions for 10 seconds.
- [ ] A save from the previous format version loads after migration.
- [ ] In a headless test fixture with a living ruler next to Contested and weakly held cells, the ruler takes at most 1 cell per in-game night, only adjacent cells with hold below 30. (In the generated world the only ruler has nothing to push into, and the Landing is always Claimed.)
- [ ] Reopening a save after 3 hours away advances traplines and nothing else.
- [ ] The bestiary carries over into a new world; the old world's state doesn't.

**Milestone 4: Vertical slice.** The Landing plus one full territory: a ruler with drawn traits and adaptation, its biome's elements, three mid-size species, small game, traplines, the bestiary and journal, rare variants and beast-part materials. Data-driven rigs (bones, joints, hit zones) arrive here, so the territory's ruler and creatures don't have to be humanoid.

- [ ] The game stays within the performance budgets on the target laptop during a ruler hunt.
- [ ] The same trap built twice in a row on the same ruler fails the second time (adaptation).
- [ ] Playtest: a solo player kills the ruler across several sessions, in 2–3.5 hours of play in all, and can say how.
- [ ] Playtest: a tester invents a trap nobody planned.

**Milestone 5: Virality.** Kill-cam triggers, the clip button (rolling 30 seconds, vertical), the watermark, alerts, the gore setting.

- [ ] The clip button saves a 720×1280 MP4 of the last 30 seconds in under 2 seconds.
- [ ] Every kill-cam trigger in Dopamine loop and virality produces a kill cam or a saved moment.

**Milestone 6: A full world.** Six territories; the last ruler's death tames the world; a new Wild from a new seed; knowledge, bestiary, trophies and cosmetics carry over.

- [ ] A test world with weakened rulers plays through to tamed and starts a new one.
- [ ] Playtest: taming a full world takes 15–25 hours (tune ruler hit points to hit it).

**Later: multiplayer.** Not part of this build; listed so the single-player work aims at it.

**Milestone 7: Multiplayer core (2–8 players).** The sim on a Node server, the `ws` protocol, prediction and interpolation, time effects as replays.

- [ ] Two clients at 150 ms simulated latency see the same tree fall and the same hit outcomes.
- [ ] Server tick under 8 ms on average with 8 players and 300 active bodies.
- [ ] A single-player save loads on the server as a hosted world.

**Milestone 8: Hosted saves and accounts.** Supabase Postgres and Auth, with only the server writing game state; griefing limits.

- [ ] Restarting the server keeps every wound, cell and structure.
- [ ] Damage from player-built things never kills a player (rule 11).

**Milestone 9: Shared worlds and seasons.** 40-player worlds, server-wide alerts, seasons.

- [ ] 40 bot players for an hour stay within budget, with no steady memory growth.
- [ ] A season runs to its end and the next one starts.

## Risks and open questions

The biggest risks are that beasts feel dumb, that giant-scale physics turns unstable, that the pace is too slow for quick hits, and that single-player shortcuts make multiplayer expensive later; each has a mitigation and a milestone where it gets checked.

| Risk | Why it matters | Mitigation | Checked at |
| --- | --- | --- | --- |
| Beast AI feels dumb or unfair | Traps only feel clever if beasts behave believably | Perception, readable telegraphs, adaptation; most of Milestone 1's time goes here | M1 playtests |
| Giant mass ratios break the physics | A 12-ton body hitting a 1 kg stick makes engines jitter or explode | Hybrid ruler bodies (animation plus sensor hit zones, full physics only when tripped), obstacle rules by mass, continuous collision detection on fast small bodies, a stability test | M1 test |
| The pace is too slow | Long hunts don't give quick dopamine | Mid-size brawls, improvised traps, traplines, juice on every action | M1 playtest: first environmental kill within 10 minutes |
| The browser runs out of CPU | Sim and rendering share one tab | Physics tiers (active, asleep, frozen), caps on active bodies, low-rate elements and far AI; move the sim to a Web Worker if needed | M4 performance test |
| Saves grow too big or break between versions | A played world holds thousands of entities | Store only what differs from the seed's world; versioned format with migrations; tests that load old saves | M3 tests |
| Single-player shortcuts block multiplayer | Logic in render code, randomness or global time would all have to be rewritten | Rules 6–8, command-based input, the determinism test, the save file as the world state | Every milestone |
| One cheap trick kills everything | Systemic games always produce exploits | Ruler adaptation, randomised traits, tuning from replays | M4 |
| Scope for a small team | A systemic world is large | Milestone gates; cut later milestones' features before cutting quality | Every milestone |
| Clips don't spread | The game's growth depends on short videos | Built-in vertical clip button, kill cams, a gore setting for platform-friendly clips | M5 |
| Borrowed identity | The pitch leans on a famous giant-ape film | Original names and designs; describe the feeling, never name the film, in public material | Before any public post |
| Later: chases feel bad with network delay | Being caught by lag is unfair | Server authority, long telegraphs, prediction for the local player | M7 latency test |
| Later: griefing in a shared world | Persistent physical things can be abused | Rule 11, slow and logged dismantling, a per-player cap on built entities | M8 |

**Open questions** (use the default until decided):

| Question | Default |
| --- | --- |
| Fauna: dinosaurs and giant mammals together, or one kind? | A mixed "lost world" |
| Does the world keep living while the game is closed? | No; only traplines catch up, capped at 8 hours |
| How long a world should take to tame | Tune toward 15–25 hours of play |
| Mobile support | Not in the first version |
| Monetisation | Undecided; nothing that affects power (rule 4) |
| The game's name | The Wild (working title) |
| Multiplayer: players per world | 40 |
| Multiplayer: database and accounts | Supabase (Postgres and Auth); only the game server writes game state |
| Multiplayer: game server hosting | Railway or Fly.io for first playtests, then a Hetzner server |
| Multiplayer: voice chat | Not planned |

## Glossary

| Term | Meaning |
| --- | --- |
| Active, asleep, frozen | The three levels of physics detail for an entity (see Performance budgets) |
| Beacon | A lit arrangement of at least 4 logs and 3 stones that claims the cells around it; a respawn point |
| Brute | A creature 2–3× human size: beaten with improvised traps |
| Cell | A 32 m × 32 m square of the map, Wild, Contested or Claimed |
| Damage rule | Impact energy, concentrated by sharpness, minus the toughness of the zone hit, divided by 18 J per hit point |
| Entity | Anything physical in the world: trees, logs, ropes, stakes, creatures, players |
| Environmental kill | A kill whose finishing damage came from the world, or from a hazard the creature was knocked into within 2 seconds |
| Hold | A cell's 0–100 measure of how firmly the player holds it |
| Hybrid physics | Rulers move by animation with sensor hit zones, and switch to full physics only when they trip or fall |
| Improvised trap | A trap made in seconds from what's already there, often mid-chase |
| Kill cam | A slow-motion camera cut of a big moment (a replay, in multiplayer) |
| Landing | The safe coastal start area of every world |
| Material | A named set of physical properties (density, hardness, sharpness, flammability, strength, springiness, friction) |
| Mid-size | A creature 0.8–1.5× human size, fought hand-to-hand |
| Planned trap | A trap prepared over one or more sessions, usually for a ruler |
| Ruler | The giant beast that rules a territory; killed only with traps |
| Season | In multiplayer, one shared Wild from its first day to its last ruler's death (single-player calls this taming a world) |
| Severe wound | A wound big enough to change a ruler's behaviour (a limp, a blind side) |
| Starting value | A tuning default, to be put in a live tuning table |
| Territory | The land a ruler rules, about 1 km across |
| Toughness threshold | The impact energy a body zone ignores before taking damage |
| Trapline | A set of snares for small game that keeps catching while its owner is away |
| Verb | An action a player can apply to any entity whose properties allow it: cut, shape, carry, lash, bend, dig, ignite and the rest |
| Wound | A persistent mark of damage on a ruler, recorded with its cause |

## Sources

- [Wryz/dungeon-style](https://github.com/Wryz/dungeon-style) (commit 50b64bf), the starting codebase
- [DungeonStyle project page](https://phung.my/dungeon-style)
- [Rapier physics engine](https://rapier.rs), via @dimforge/rapier3d-compat 0.21.0
- [recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js), the npm package recast-navigation
