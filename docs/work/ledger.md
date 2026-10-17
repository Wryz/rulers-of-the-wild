# Cross-package ledger (requests raised by implementers/reviewers)
- [P05] packages/sim/package.json: exact pin "@dimforge/rapier3d-compat": "0.21.0" (shapes.ts/types.ts import it); add @types/node as a devDependency of the sim and "node" to its test typing so tests can use node:fs (P02a, P03 and P24 worked around it with dynamic imports).
- [P02b] rules.ts TODO(P02a-fix): switch boneMass's namespace import of sim/species.ts to a named import now P03 is merged.
- [P04] Fighter.heldBreath (private) must be in Fighter.toRecord()/restoreRecord() with breathPhase and IdleBehavior clocks (TODO(P04) in code).
- [P08/P32/playtest] Footwork.localTarget: pelvis not lowered for downhill leg on slopes (ankle misses by up to 0.1 m on 0.3 grade). TODO in code.
- [§9 doc] MOVE_TUNING gains limpStanceMul 0.4, limpStepHeightMul 0.5, limpMinStepFrames 4.
- [P13/P37] setTuning command with a non-finite value (e.g. Infinity) doesn't survive plain JSON; the command log must use the save's number convention ($inf/$nan).
- [rules.ts fix, give to P09 (owns contacts/damage) or a P02a-fix] Add DAMAGE_TUNING.bladeSharpness = 0.8 (§4.4); combat.ts holds a named const BLADE_SHARPNESS with TODO(P02a-fix).
- [P31/P23] CombatSim.devChecks (addDrop throws in world mode when on) needs wiring in dev mode / test harness.
- [P11] Thrown weapon on a ruler: rulerHit gets ruleDamageHp = E/K with T=0; recover E = hp × K and apply the classified zone's toughness (§4.6 step 1).
- [P15] WorldPort.projectile toi = fraction of the from→to segment.
- [P16] Set posture 'haulRope' while pulling (pullWalkMul reads it); punch while holding a rope end → pull on.
- [P15/P23/P28] Spoil rule: P05 implemented §4.13 text (dug mask only for vertices >0.05 m below original): pit takes 3,662 strikes; long-side rim up to 0.86 m (cover branch ends rest there).
- [P11] World.teleport for a ruler: TODO(P11) pass ankle height as maxAboveTerrainM.
- [P13] BodiesRecV1.kcc nullable (ruler has none) TODO(P13).
- [P02-fix, wave 4, owns combat.ts + rules.ts] CombatSim record accessors: dropSerial, projSerial, prevBlade (fighter id -> points), Drop and Projectile records (owner by id, passed as ids), restore path (P04 deviation 7); plus DAMAGE_TUNING.bladeSharpness (P02b ledger); plus anything else pending on combat.ts/rules.ts.
- [P13] schema.ts: FighterRecV1 = FighterRecord (sim/fighter), BrawlerRecV1 = BrawlerAIRecord, SaveV1.director: AIDirectorRecord (P04 dev. 6). Save: fighters via f.toRecord(combat.drops); rng.fighters [f.id, f.rngState]. Load: same factory + new IdCounter(savedId); combat.add(f, brain); restore drops; f.restoreRecord(rec,{fighters,drops}); f.rngState=...; ai.restoreRecord(rec).
- [P13/M3] Fighter.restoreRecord rebuilds rig by FK; in world mode phases 13a/13b move f.pos after updatePose: TODO(P13, M3).
- [P05-fix/§9] P06 added ENTITY_TUNING (touchedMoveM, touchedTurnDeg, anchorJoinDepth) — fine to keep; record in §9 notes.
- [P07] entities.create makes body immediately; anchored specs default 0.3 m / 1200 N; generated: true for generation.
- [P08] 500 N pushes via queueImpulse(id, F·DT, null), skip isAnchored.
- [P09] isAnchored → static for m_eff; advance releasedBy.apartTicks; clearing thrown turns CCD off.
- [P10] keep entity.joints sorted; JointStore.remove callable from EntityStore.remove; felling: reshape → unanchor → plant.phase='falling'; grace groups on e.collider after create.
- [P02-fix] CombatSim.externalKnockdown has no writer left: delete it.
- [P13] Client tables in the global registry (folders "Client ›") must be excluded from the save's tuningOverrides (e.g. GAME_TUNING.timeScale/paused).
- [P18/P37/P08] Nothing clears footwork.landed now (DS client did): sim needs a per-tick reset or footstep events before noise/footstep sound read it.
- [P22] All dev ops except setTuning throw; ?mode=training reaches world as sparringApe; switch Game.spawnEnemy/giveWeapon to loop.dev(...).
- [P32] Views draw from frame.poseOf (ragdoll) or rig; place weapon after pose; terrain LOD would speed headless checks (swiftshader ~650 ms/frame).
- [P33] usedSlots still module-level in ragdoll.ts (D-42); register RAGDOLL_TUNING; knockdown throw in presentation stub until sim emits 'launch'.
- [P34] register CAMERA_TUNING; Cinematics stores ground fn but doesn't apply it.
- [P36] drop .wave from hud.ts (hidden via DOM by adapter); KillCam gets cut callback from main.ts.
- [P37] Rewrite panel.ts against game.world, game.loop and the registry (DS panel binds sim tables directly — rule 6 break until then); register FEEL_TUNING; then remove Game's deprecated DS-panel members.
- [me] CLAUDE.md line about ?mode=training = DS training ring is outdated after P31: update at merge.
- [P10] JointStore.remove(j,'release') re-entrant from EntityStore.remove; updates joints on both ends; pushes joint/release event. loadHist length round(LOAD_TUNING.loadWindowS/DT) or record's. reshape(e, shape, offset) then setState(e,'free') for falling trunk. Set e.touched on changed fields. Use setGrace (P06-fix) for pieces.
- [P07/P10/P21/P32] EntityStore pushes spawn/remove events; don't push again; client builds first views from all(); queueImpulse throws for unknown ids; restoreRecord replacing a regenerated entity deletes Rapier joints generation made on it → P10 restoreRecord rebuilds joints from save.
- [P21] Place loose generated items at rest (else they become touched → saved).
- [M2] Untouched generated entities reload with age 0: decay TODO.
- [P09/P10] rest radius loose for long bodies (restTicks may effectively wait for sleep): use "or asleep".
- [P13] After load, Rapier body slots aren't in id order (only restored bodies rebuilt) — deterministic between loads; departure from §8.3 "same order" unless P13 rebuilds all.
- [ownership] P31-created adapters: render/worldViews.ts → P32, ui/hudPort.ts → P36, feel/sfxPort.ts → P37, ui/menusPort.ts → P35, tests/weaponModels.test.ts → P32.
- [departure, accepted] Recording is filed at each player death and restarted at respawn (design §10.11 "started once per session") — bounds memory until M5's rolling buffer.
- [infra] Under load (many agents on 4 cores) legacy tests time out at vitest's 5 s default → raise testTimeout/hookTimeout in vitest configs (orchestrator commit).
- [P35] Fill InputFrame.look: dx/dy pointer-locked movementX/Y px; stickX/stickY pad axes 2,3 with dead zone; zoom wheel notches (only when no mode uses the wheel); aim = X held; zero look while radial open.
- [P08/P09/P10] Emit 'land' events with mass kg and energy J for heavy landings (camera shake + thuds read them). Sim needs a per-step footfall source (giant footfall shake/sound).
- [P31-fix] main.ts picks kill-cam side from rig.camera.position; better: pass the director's view position.
- [P36] cine.play grep should cover src only (followCam.test.ts calls d.cine.play).
- [P32] forest materials need applyCutout; cutout focus already 1 m over ground.
- [§9/P38] P34 extra keys: CAMERA_TUNING cutFloorM, slowmoZoom, cutoutHeightM, cutoutRadius, cutoutSpreadPerM, cutoutSpreadMax, landShakePerHuman, landShakeMax, landMinHumans, landHardSpeed, landRangePerScaleM; FOLLOW_TUNING blendMaxSpeed.
- [departure, design §10.6 vs §13.1] Camera blend stretches when cameras are far apart (FOLLOW_TUNING.blendMaxSpeed 18 m/s): giant blend ~1.35 s in / 1.27 s out instead of 0.45 s, to satisfy the ≤0.5 m/frame gate. (design-level, not a SPEC departure)
- [P35] look, zoom and aim are ignored once the fight-camera weight reaches 1 (throwing while locked on gets no aim camera).
- [P13] restoreRecord(r, { fighters, drops }) requires drops.
- [P10] rope entities arrive as free coils (ropeCoilShape); loose anchor local = world point; generated vines & axe lashing create joints — regeneration + restoreRecord must not duplicate them (also P13).
- [P13] FACTORY_TUNING changes tuningSnapshot() (pit-scene cache hash).
- [P14] axe edge local (ax.max,0,0) dir (1,0,0) on the flint; 0.042 m past the handle's +y end pointing +z → headZoneM must allow points beyond the end; decide whether the 1 m lashing rope (0.188 kg) counts toward held mass (lab's 1.15 kg excludes it).
- [P15] confirm starter axe chop ≥ 339 J (refChopJ) else 15 chops become 16 (SPEC:882).
- [P21] pass generated: true everywhere incl. spawnStarterAxe(w, at, {generated:true}); place lying things with groundRestY; round sections via prismRForRoundDiam or spawnLog({mass}); tree diameter = circum-diameter; digging stick = spawnStick({sharp}) with CLEARING_TUNING values; factory imports CLEARING_TUNING (cycle safe only if no load-time reads).
- [P32] draw stones from exact hull points; draw snag points (no geometry; rule 3).
- [P10/P15] stumps (P10) and dirt piles (P15) are made by those systems.
- [post-merge cleanup after P02-fix, me] delete CombatSim.externalKnockdown alias + its seams test (no client writer since P31); replace combat.ts private numFromRecord/v3Record/readV3 copies with P04's exports from body/animator.ts; unify CombatWeaponRecord with P04's WeaponRecord.
- [P13] Save: c = world.combat.toRecord(); SaveV1.tick=c.frame; rng.combat=c.rng; counters.dropSerial/projSerial; pending=c.pending; drops=c.drops (DropRecV1:=DropRecord); projectiles (ProjRecV1:=ProjectileRecord); director=combat.director.toRecord(); NEW SaveV1.prevBlade: [number, V3[]][]. Load order: construct fighters & brains first (construction can draw combat.rng) → push into combat.fighters/ais → combat.restoreRecord({...}) → Fighter.restoreRecord(rec,{fighters, drops}) → brain/director records → fighters' Rng states. Canonical writer: -0 as "-0", non-finite as "$inf"/"$-inf"/"$nan".
- [§9] DAMAGE_TUNING bladeSharpness 0.8 sharpness §4.4 D-12.
- [P13] navDirty = nav.dirtyQueue(); on load call nav.build(w) after terrain edits & entities restored, then restoreDirty(q).
- [P19] nearest needs p.y near the surface; store findPath tiles/versions, compare with tileVersion; partial path complete:false.
- [P10/P15/P17] markDirty optional (phase-16 scan detects entity/terrain changes).
- [P38] no-bare-constants allowlist for nav.ts Recast/Detour limits and bit/stride arithmetic.
- [P31/P21] nav 'full' adds ~2–3 s to createWorld at 200 m (0.25 m terrain); consider a loading message; recast chunk ~726 kB.
- [P37] NAV_TUNING per-layer values apply only on nav.build(w); read-outs dirtyReasons, buildFailures, dirtyQueue().
- [test infra] long synchronous tests should yield to the event loop between batches (vitest onTaskUpdate RPC timeouts under load).
- [P09] zones are child colliders of one kinematic body; narrow phase sees previous tick's pelvis with this tick's limb offsets; pre-step store holds whole previous-tick poses. Use downed.boneAt for slab contacts, downed.queueDv for Δv, kcc.grounded/verticalSpeed. Remove applyWorldImpact's fallback in characters.ts (P08 caught the P01 placeholder throw) — characters.ts owned by P08: P09 needs permission or a P08-fix. Landing on an entity may raise a shin-zone pair (self-motion → v_safe). Keep the later grace window (World.teleport's grace comes after zones.resetHistory's).
- [P13] kcc.toRecord {pose, vy, grounded, crouched, enabled, halfHeight, teleport}; downed.toRecord {enabled, pose, lin, ang, hold, handedBack, dv}; zones.historyRecord(f); call zones.resetHistory after loading; extend KccRecV1/SlabRecV1.
- [P05/P22] World.teleport of a downed fighter doesn't move its slab: a dev teleport must stand the fighter up first or downed.ts needs a teleport.
- [P31/P37/P35] footwork.landed now means "this tick's footsteps" (emptied each tick by P08): the client must read it after every step.
- [P11] reuse boneZoneShape/boneZoneDesc for the ruler's bones.
- [P27] kcc.collidedEntities / pushedEntities give per-tick collision/push counts.
- [P33] launch event vel/angVel and downed.pose(id)/hip(id) are what the ragdoll follows.
- [P10] hanging vine b anchor = { entity: null, local: <world point>, loose: true }; vines shorter than anchorH hang in the air; axe lash anchors are the same world point (Anchor has no rotation → fixed joint frames from bodies' current poses); re-coil with ropeCoilShape; rope mass from FACTORY_TUNING.ropeRadiusM.
- [P13/P10] joints have no generated/touched flag: generation recreates vine joints and the axe lash on load — saved joints must not duplicate them.
- [P21] use hangVine(w, treeId, ...) after all trees (P07 minor fix) for §6.7 id order.
- [§9] FACTORY_TUNING (World › factory, 12 leaves) and ENTITY_TUNING to be recorded.
- [§9/design] P34: FOLLOW_TUNING.blendMaxTurnDegS 120; CAMERA_TUNING traumaDecay 1.6, shakeAmpM 0.12, shakeRollRad 0.025, punchDecay 4, punchFov 0.05, cutoutSpreadPerScale 2.2; blend swings round the player's chest by yaw/pitch (not lerp+slerp as §10.6 says).
- [P31-fix/main.ts] wire SfxAdapter.onTrauma → cams.shake; kill-cam side from cams.view.position; panel loadWorld hook; call panel.handle(e,w) in dispatch; pass camera forward to sfx.setListener; remove Game's deprecated DS-panel members; PanelPort optional handle; draw showNav/showSenses/showZones.
- [P35] input.ts: ignore keydown whose target is input/textarea/select (preventDefault on Enter breaks text fields).
- [P22] add ops to DEV_OPS_READY in debug/panel.ts as devOps implements them; confirm arg encodings.
- [P14] expose the focused entity id (panel read-out uses nearest to f.verbAim). [P20] confirm charge-cooldown field (panel reads mind.cooldownUntil). [P18/P20] emit noise events 'roar' and 'shout'.
- [§12/§9 design notes, P08] autostepDynamic used conditionally (only after meeting a body the push can't shove, or one pushed last tick that didn't yield: CHARACTER_TUNING.pushYieldSpeed 0.02 m/s); controller self-snap down slopes; standing still never shoved/pushes (airborne sweeps); settle hold stunFrames = stateFrame + 2; launch pop only for melee knockdowns; zone grace tick+1; hand-back at hip after settleMaxHold; new keys zoneShapes, standCastUp, standCastLength, pushYieldSpeed.
- [P13/design] nav baked set and tile versions are derived state rebuilt on load (tile versions restart at 1 → minds re-path once after load).
- [P21/P38] nav full build of 200 m both layers ~2.3–7.5 s depending on load; rebuild ticks 8–12 ms under load.
- [P32/P37] NavSystem.debugGeometry(layer) exists for drawing nav polys (showNav).
- [P13/P19] MindRecV1 needs `stimulus: number` (Senses.stimulus window), written/restored by CreatureMind.toRecord/restore (TODO(P13/P19) in perception.ts).
- [P10] joint 'snap' event has no point: noise bus reads JointStore.get(id) in phase 17b → keep removed joints readable until end of tick, or add point: V3 to the joint event (types.ts). TODO(P10) in noise.ts.
- [P11] RulerMover.resolve must empty f.footwork.landed at its start (as characters.ts does) or the giant's steps are re-heard every tick. TODO(P11) in noise.ts.
- [C-fix/P37] sfxPort plays a roar on every 'wound' AND the bus emits a noise 'roar' hint on wounds → double roar: drop sfxPort's wound→roar case.
- [P19] emit only the ape's shout on entering 'fight' via world.noise.shout(f); the bus already emits event-driven shouts (on hits). fold calls Senses.hurt before mind.onHurt — don't re-apply.
- [P20] emit the telegraph roar and the climb-out roar via world.noise.roar(f) (applies weakJawRoarMul); not the event-driven roars (wounds, rise).
- [P14-P17] emit a successful `verb` event when each stroke/placement lands (noise bus makes shape/stakeDriven noises from them).
- [core-fix: downed.ts] AC-6 part 2 at 4 m: never enable a slab overlapping a dynamic body (start it lying when the queued Δv is a press, or drop ENTITY from its collision filter until clear); P09 left an it.fails test in contacts.test.ts for the 4 m case → flip it to a passing test.
- [core-fix: characters.ts] fold applyWorldImpact try/catch into a plain applyImpact call; drop the CombatSim type import (TODO(P09)).
- [core-fix: world.ts] classifyKO try/catch → plain isEnvironmental call (dead fallback).
- [core-fix: combat.ts] faceWork reads VERB_TUNING.workStepM through verbTuning() (widen key union).
- [core-fix: fighter.ts] updatePose blends getPose(f.posture.id) by f.posture.weight over the animation (§1.5.3; poses exist).
- [P10] implement JointStore.tripwire(w, joint, by) (TripwireSink) and declare it; remove the cast in contacts.ts; lash/hinge break check inside Breaking.hit; felling.addMoment; fold contacts.ts's catch wrappers around breaking.hit/felling.addMoment into plain calls (authorised edit of those lines in contacts.ts). Re-create Rapier joints for lash/hinge records whose entities' bodies were rebuilt (stow → draw → drop must keep the axe's lash; restore). Joint snap event needs a point (or keep removed joints readable until end of tick).
- [P13] ContactSystem: restore contacts into the freshly built world BEFORE its first step, don't prime the narrow phase; restoreGrace(r) inverse of graceRecord(); ContactRecV1 creature = −entityId for entity-only episodes. VerbStateRecV1 := index.ts VerbStateRecord; saveRecord writes w.verbs.toRecord(), loadWorld calls w.verbs.restoreRecord; add a save round-trip with a VerbStateRecord.
- [P32-fix] buildWeapon models for TOOL_WEAPON_IDS (or draw the held entity), then remove the non-enumerable trick in weapons.ts.
- [P22] giveTool can use w.verbs.putInHands(f, entityId).
- [§4.3 design] closing speed is (v_self − v_other)·n (design text had the sign wrong). §11.6 pinned numbers: real rig 4 m → 6.38 m/s, Δv 5.09 (press); 3.75 m → 5.89 m/s, Δv 4.74 (hitstun) keeps 85.9 %.
- [§9 rows] IMPACT_TUNING 14 new keys; VERB_TUNING/TOOL_TUNING 12 new keys (P14).
- [§12] HP writers also include DS block() chip and resolveJams() nick; impact-trip check in contacts after applyImpact (sharp static impactor).
- [P10, from P13] JointStore.restoreRecord REPLACES the store: drop joints generation just made without releasing (remove their Rapier joints and rope sensors, no events), then rebuild every saved joint with its saved id in id order.
- [P10, from P32] stump look 'stump'; keep plant.stump set while the trunk falls; keep look 'tree' on the felled trunk; plant.height semantics (notch drawn by |2·halfHeight − plant.height| test).
- [core-fix: contacts.ts] ContactSystem.restoreRecord must replace all runtime maps incl. graces (and any grace left by World construction); then P13's loader can stop re-opening graces by hand.
- [P19, from P13] MindRegistry.restoreRecord(r: MindRecV1[]) (load.ts calls it via a structural check; refuses saves with minds until it exists).
- [core-fix: zones.ts/downed.ts] ZoneBodies 'enabled' flag in a record (or DownedBodies.restoreRecord sets it).
- [core-fix: world.ts/physics.ts] WorldOptions load-mode flag skipping spawnPlayer, spawner.init and the first nav build; PhysicsWorld.refreshQueries() (general primeQueries) — then load.ts calls it (TODO(P05-fix)).
- [ALL later sim packages] RR-19 completeness lists live in packages/sim/tests/save.test.ts (INVENTORY, AWAITING, PARTIAL, DESCRIPTIVE, UNREACHED): when you add runtime fields to your system, update YOUR system's entries there (authorised) and take your save key off AWAITING.
- [P15, from P32] store crossCut.fromDir entity-local.
- [P11, from P32] WoundRecord.local in the bone frame divided by scale (as combat.ts's Wound.local).
- [P21, from P32] cover grid starts at the terrain's min corner in CLEARING_TUNING.coverCellM (2 m) cells; the grass view samples world.cover.at() at cell centres.
- [core-fix: footwork.ts] the downhill planted foot floats/sinks on slopes (pelvis not lowered) — TODO naming P32 rendering.
- [C-fix later] P32 minors: remove dead lookFor armour tiers; TerrainView constructor builds all tiles at near spacing then throws away; bare constants in entityViews/forestView (instancer idle 3600, LeafFall.MAX 400, blood per impact, tint cap, back-slot lift); capacityOf's catch will hide P10's real errors; gore 'off' doesn't block severed stumps; port scar() duplicates syncScars.

## Integration note after P09+P14 (for core-fix)
- verbs.hands.test.ts: a take on a stick lying on a 2.6 m block directly in front made the bend swing the head into
  the block face at ~6.2 m/s (> human v_safe 6), a self-motion hit with hp > 0 → hitstun cancelled the take with no
  event. The test now uses two posts. Gameplay consequence: reaching for something on a ledge in front headbutts it.
  core-fix should check the take/pickup bend's head carryV (a bend should not move the head at punch speed); if the
  pose blend is a snap, smooth it (fighter.ts updatePose posture blend is already on the core-fix list).

## Wave 6 handoffs (P19, P17)
- [P15, from P17] throw.ts exports thrownEntityOf(w,p)/landThrown(w,p) (exact release-tick match). P15's projectileLanded (verbs/strike.ts) calls landThrown(w,p) ONCE and returns true when it gives an id; projectileHit must not call it (CombatSim calls onProjectileLanded right after a world hit, combat.ts:2039). Until then a thrown ≤2 kg tool reaches CombatSim.addDrop on landing (throws under devChecks in the dev client) and stays 'projectile' forever. Test "a thrown spear lands as the same entity id".
- [P38/verb-tuning follow-up, from P17] PLACE_TUNING ('Verbs › place': supportProbeUpM 0.5, actFrac 0.75) should move into VERB_TUNING with §9.1 rows; drop resetTuning('PLACE_TUNING') in verbs.place.test.ts.
- [P20, from P19] delete rulerMind.ts's redeclared `heading = 0` (it overwrites CreatureMind's constructor value self.yaw); huntTarget() lives on ApeMind (copy or move to base); override walk/stand/halt with the drive; giant leaves down → recover, not resume; createCreature('giantApe') builds the §6.4 body and throws until newRulerState (P11) and RulerMind.decide (P20) exist.
- [P22, from P19] ApeMind.engage(w, target) puts a sparring ape straight into a fight; setHome(home, homeIdx) links an ape to its spawn.
- [report: design observation, P19] the human nav layer (0.4 m climb on 0.2 m voxels) steps over anything lower than ~0.6 m: a 300 kg 4.4 m log (0.38 m high) or a 0.3 m felled trunk does not re-route an ape; SPEC:775 "a felled tree re-routes them" holds for apes only for trunks thicker than ~0.6 m (the giant's layer re-routes).
- [P18-fix done on P19's branch] TestMind.sense(){}, ape.investigateArriveM, fleeAwarenessMul keys.

## Wave 6 handoffs (P36) → C-fix (wave 8) and P21/P35
- [C-fix main.ts] new KillCam((shot) => cuts.play(shot), { pelvisOf: (f) => presentation.pelvisOf(f), ground: (x,z) => world.terrain.heightAt(x,z), viewPos: () => cams.camera.position }); drop `across` + sideAcross import. moments: new MomentBuilder(world) (not () => world.tick: ruler cause ids need the world). hud.connect({ camera: () => cams.camera, cutActive: () => cuts.active, prefs: () => menus.prefs, bindings: () => input.bindings }); pass `hud` as GamePorts.hud; remove HudAdapter import and delete ui/hudPort.ts. Optional killCam.onMark → recorder (M5).
- [C-fix] hud.test.ts respawn-countdown test only regexes game.ts: drive Game/Hud.deathBanner for real once main.ts is rewired.
- [C-fix style.css] dead rules .wave, .moves, .tcue, .incoming, .flash.
- [P35/C-fix] Settings 'Fight tips' (prefs.tips) and the telegraph part of 'Combat cues' have nothing behind them now; menusPort.ts comment points at ui/hudPort.ts. Bindings actions should use §5.14 ids verbatim (verb, throw, place, target, jump, sprint, crouch, belt1, belt2, belt3, back) — the hands strip and controls hint read those keys.
- [P21] compass: north = −z, east = +x. Put the lair "at the north rim foot" (§6.7) on −z.
- [P38/§9] new client tables HUD_TUNING ('Client › HUD') and KILLCAM_TUNING rows playerDeath, skullSplit, causeBackM, focusFloor, envKill.toward 0.1, rulerDeath.toward 0.

## Visual findings from the screenshot tool (tools/shots, wave 6) → follow-up "V-fix" (rule 3: if it looks like it should work, it works)
- carry: log rides on the shoulders, both hands hang at the hips (in the sim: hands ~0.95 m, log 1.55 m). carryShoulder posture hand targets never reach the skeleton: body/poses.ts (carryShoulder) + posture blending in body/animator.ts / fighter.ts updatePose (core-fix item 10 overlaps).
- drag: grip trails 1.58 m (VERB_TUNING.tetherM) and 1.77 m from the nearest hand; hands in front (dragBack posture not reaching); nothing drawn between hand and log, so the log seems to follow on its own (rule 3). Files: world/verbs/hands.ts, body/poses.ts (dragBack), apps/client/src/render/worldViews.ts (draws only wield/carry at the hand: draw the drag link). Also check whether player+log accelerating 0.4→2.8 m/s over 6 s is just the run speed or a runaway.
- log-on-player: client ragdoll is shoved down by the presentation mirror of the falling log while the sim has the player standing in hitstun (presentation only; apps/client/src/game/presentationWorld.ts should not let mirrored entities push a fighter whose sim state is standing).
- pit: grass tufts drawn on the spoil ring's outer cliff and on raised spoil (render/grassView.ts / cover not cleared under spoil); −x pit walls near-black (flat shading, render/terrainView.ts); spoil ring is a flat 1 m ring with sheer edges (sim spoil cap shape).
- trees: canopies near-black from the shaded side (lighting/ambient), sapling canopy dithered by the cutout (render/cutout.ts).

## Wave 7 handoffs (P35) → C-fix
- [C-fix, from P35] MAIN.TS WIRING (for a C-fix/P31-fix before P38; I did not edit main.ts, it isn't P35's). Today main.ts calls `new VerbInput(() => cams.moveBasis())`, which still works: with no world it keeps P31's stub behaviour (move, strikes, DS pickup button, jump). So the verb UI is NOT active in the running client at this commit, and the ★ playtest path needs this fix. To switch it on, assemble() must: (1) import { Highlight } from './render/highlight', { Ghost } from './render/ghost', { AimArc } from './render/aimArc' and { Radial } from './ui/radial'. (2) Build `const verbInput = new VerbInput(() => cams.moveBasis(), { world, view: () => ({ camera: cams.view, fight: cams.fightWeight >= 0.5 }), bindings: () => input.bindings, prefs: () => menus.prefs, radial: new Radial(hudRoot), highlight: new Highlight(scene, hudRoot), ghost: new Ghost(scene), arc: new AimArc(scene) });`. (3) Set `input.ui = verbInput;` so Input reads the mode for the camera look and for Escape. (4) Pass `verbInput` as GamePorts.verbInput. The reviewer checked that cams.view, cams.fightWeight, menus.prefs, input.bindings, hudRoot and scene all exist with the right types.
- [C-fix, from P35] InputFrame: the fields §10.7 adds are optional (pressed, held, released, cycle, cancel, lost, mouse, clicks, wheel, look, pad). P31's loop.test.ts and P37's panel.test.ts build frames with only DungeonStyle's five fields, and I don't own those tests. fullFrame() in input.ts fills the missing fields with 'nothing pressed', and Input.poll() always fills every field. NEW in this fix: `lost` is true on the frame where the window blurred, which marks the releases in that frame as the blur's.
- [C-fix, from P35] Prefs and settings. Prefs gains gore: GoreLevel (default 'full', which game.ts goreOf now reads) and holdToCrouch (default false). `blood` stays as a deprecated mirror of gore !== 'off', because game.ts goreOf falls back to prefs.blood and I can't edit it. A saved blood:false migrates to gore 'off'. The 'Blood effects' row sets gore 'full' or 'off'; the three-level setting is M5's. A 'Crouch key: Toggle/Hold' row is added. Settings lists every new action, refuses reserved keys (and developer keys in developer mode), and shows the pad's controls. I kept the 'Fight tips' row and left a TODO(P36) in menusPort.ts, since whether to keep the tips HUD is P36's call. Opening a menu releases pointer lock.
- [C-fix, from P35] OWNERSHIP (finding 10): apps/client/src/ui/menusPort.ts is edited (pointer release in openLog, header comment, TODO(P36)) but is not in §13.1's Owns list for P35. P31's stub header says 'STUB (P31; P35 fills it)', it is the adapter next to settings.ts (RF-9), and no wave-7 package owns it. Suggest adding `src/ui/menusPort.ts` to P35's Owns in §13.1.
- [C-fix, from P35] FOR C-FIX / P36 (files I don't own). (a) game.ts beatOf shows refused verbs as raw codes ('take: tooHeavy'). ui/radial.ts exports reasonText(reason, massKg?) with §5.13's wording; the popup should go through it, for example in HudAdapter.handle on `verb` events, and should skip `focus` refusals: the UI pre-validates focus, but a target leaving range in the one tick between could still produce 'focus: outOfRange'. (b) hud.ts setBindings' controls hint still lists DungeonStyle's keys ('grab / drop weapon'); it should list G take/drop, V verbs, X throw, C place, Tab target, Space jump, Shift sprint, Ctrl crouch, 1-4 belt.
- [C-fix, from P35 review] route `verb` refusals through reasonText; update hud.ts controls hint.

## From SIM-fix (wave 6 integration)
- [RulerMover, rulerBody.ts — follow-up, affects AC-6 part 3] giant stalls when deflected at 25° off a wall: slide sweep reports a grazing hit (toi 0.319, normal (−0.01,−1)); capsule sits on the wall face because the 0.05 m skin is taken along the motion, not the normal → advance max(0, 0.319·0.091 − 0.05) = 0. 20° and 10° slide fine; 45° trips. Fix: in the slide sweep ignore hits whose normal doesn't oppose the slide direction, or keep the skin along the normal. (Give to SIM-fix after its review.)
- [C-fix] apps/client/src/feel/sfxPort.ts: joint/tripwire sounds look the joint up in world.joints.view(); a snapped/cut joint is gone → plays unplaced. Use e.point (now required).
- [P38 cleanup] noise.ts: the `e.point ? … : jointPoint(…)` fallback is dead code.
- [report departures] (1) entity-integrity m_eff = point mass (§4.3 table rows for entity vs entity / terrain; SPEC:278 for integrity); creature side keeps whole entity mass. (2) tripwire end share cap (§4.9). (3) obstacle trip from the shin strike, RulerBodies.legStrike (§4.7 steps 4–6; grounded in SPEC:782, SPEC:344). (4) unanchor lift (§2.3).

## From P15 (wave 7)
- [P28/P23 decision] AC-2(b) "≤ 12 piles": literal rule is 12 within 10 m of S (TERRAIN_TUNING.pilesNearR); 8×6×2.5 m pit made 20 piles in all (ring wider than 10 m). Either pilesNearR ≈ 16 m or count per pit.
- [P14-fix] verbs/index.ts: add public VerbSystem.setFocus(f, target, at); P15's aimedSwing fakes a focus command through applyCommands.
- [P23] chopTo planner: stone axe lands its head on a 30 cm trunk only from ~1.2–1.4 m off the surface (closer, haft clangs) → stand ~1.3 m off. Digging stick's hole lands 1.56 m ahead.
- [P19/P20 note] strike seam applies to every fighter: creature fists clang off trees, push free entities; a giant blow on a dirt pile can break it.
- [report] dry spear into a wall at 20 m/s shatters (340 J vs 51 J break).
- [deviation, under review] kick vs design's "a kick knocks a 14 cm prop from under a 170 kg log" (DS low kick 108 J, not 180 J): 4 kicks needed.
- [§9] new tables STRIKE_TUNING, DIG_TUNING; spoil pile placement on rings around S.

## From P21 (wave 7) → SIM-fix2 (wave 8)
- [physics, P07/P05] vine coils (flat 8-gon disc, coilAspect 0.25) sink through sloping heightfield: 16/30 on Clearing terrain, 28/30 on a planar 2 % slope, 1/30 flat; aspect 1.0 and boxes: 0. CCD no effect. Likely convex-hull vs heightfield with FIX_INTERNAL_EDGES. Quick mitigation coilAspect → 1; real fix in physics/shape (e.g. thicker coil hull, or a cuboid/capsule collider for coils). Affects play (any coil dropped on uneven ground). clearing.test has an it.fails that turns red when fixed.
- [perf, terrain.ts] Terrain.generate ~130 ms of the ~210–250 ms Clearing build (forEachCopy allocations per vertex): per-tile loop from global vertex indices (minX + gi·spacing) writing original/heights directly → ~10–20 ms.
- [P13 save.test] GroundCover.grid inventory entry ('saved: cover (edits against generated cover)'), remove cover from AWAITING; cover.ts allocate grid eagerly (one-line) or read from a Clearing world.
- [P07 factory] optional q for spawnStone/spawnGrass/spawnRopeCoil so generation tilts them to the slope (92/164 free generated things become touched after 2 s → saved). TODO in clearing.ts.
- [M3] downed-slab rotation rebuilt from yaw after load differs in last f32 bits (bodies NOT_EXACT).

## Decisions after P15 review
- Unarmed strike push uses the striking limb's bone mass (≈12 kg leg → J≈39 N·s at DS's 108 J kick, = §5.2's 40 N·s); armed: strikeMassKg × scale³. Departure from §5.2 "strikeMassKg 6".
- TERRAIN_TUNING.pilesNearR 10 → 15 m (12 piles per ruler pit, §4.13 budget).
- [P28/P29/P20 notes] giant blows can break cover pieces by strike, not foot load; AC-2(b) gates "a break of a cover entity from foot load".
- [P23] chop/cut/dig need a wielded entity; giveTool must spawn entities; pushes have no world event; digPit's first piles land inside the 8×6 footprint → dragTo step needed.
- [playtest risk] dry spears break on any fixed surface above ~7.7 m/s.
## From P20 (giant mind) — pending review
- charge aims nearest leg (legAim); walkers escape at 8°/s (it.fails); 70 m felled tree not investigated (it.fails; P18 heardGain 0.6 or investigateAt 0.25); standing charge hit 98.5 HP / Δv 21 m/s vs §4.4's 14.9–20.3 HP (shin faster than root) — rule 9 risk; [P22] setHome(lair) on giant; [P29] setRoute then enter('patrol'); [P37] TODO(P20) closable.
- [C-fix, from P21 review] compass.ts:8 TODO(P21) removable (lair at −z); grassView.ts:108 should read world.cover.cellM not CLEARING_TUNING.coverCellM; boundary walls need a hideable look in the client.
- [visual, Clearing shots] rim faces render near-black (flat shading, terrainView); the boundary walls show as a dark band above the rim crest (needs hideable look, P21 follow-up + client); 6 m ledge face is a sheer grey wall; sapling canopy dithered by cutout.

## Decisions after P20 review
- Giant charge: knuckle-charge posture (forearms down in front during telegraph+charge) closes the ~1 m shin gap at player height; aim at the bearing (§6.4), drop legAim. Departure note: §6.4's body assumption (B lab 1.95 m disc) vs real bone zones.
- Severe limp sets FootworkStyle.limp (visible, rule 3).
- Charge damage on a standing player is honest physics (shin carryV 20–28 m/s; 1.3–171 HP by gait phase, often KO) — contradicts §4.4's calibrated 15–20 HP; variance risk vs SPEC:787 "never unfair". Report in m1.md; lever if needed = charge gait with flight phase, not the damage rule.
- [P18/design] 70 m felled-tree lure fails (0.256 < investigateAt 0.3): a felled tree lures only from within 57.6 m, contradicting §6.2 "heard across the whole Clearing". Lever: giant.heardGain 0.6 or investigateAt 0.25 — spec value? check SPEC; if design-only, adjust in P18-fix.
- [report] §13.1's "every charge ≥ 60 ticks telegraph" vs §6.4's 0.6 s close telegraph (36 ticks).
- [P20 fixes done, 4a8fb51] contains CORE's fe2f79a (posture ramp) → merge ONLY after CORE's fixed branch merges. Knuckle charge (headLow redefined, giant-only); dodge table passes at 10/15/25 m both directions; limp gait; climb replan (CREATURE_TUNING.giant.climbStuckFrac 0.5, MindRecV1.climb). [report] charge on standing player now 0.9–21.9 HP (mostly forearm hits 1–3 HP; 4/22 chest 12.9–21.9), Δv 5.4–7.3 m/s (≈ §4.4's 5.85–6.83), launched 20/22, no KO; §4.4 X20 / rule 9 vs "rulers are deadly" — playtest question. Only it.fails left: 70 m tree lure (with passing companion).
- [P16 departures, for the M1 report] (1) Hauling (pull on), the rope-end tether is one-sided: it never draws the hauler in and stops a step only beyond max(his body's horizontal distance now, where his hand meets √(L² − dy²)); the reach is measured at the hand, the "now" at the body (measured at the hand, turning and the arm's swing ratchet him outward: +0.5 m in 5 s of backing off). (2) One side of a lash may be what the hands hold, but only a light head (≤ lashSnapMaxKg, not elongated), snapped onto the held side's end away from the hand; anything else is refused handsFull (the workLow pose moves the held object ~0.7 m between command and land, so an aim-based plan can't match at both, RF-15). (3) ROPE_TUNING (knotAllowanceM, coilMinM, squatChestM, shapeDoneMargin, workPoseFrac, snapEndMinY) lives in lash.ts until moved into VERB_TUNING (§9.1 has no rows). (4) The haul's taut test (joints.ts reelIn) counts a hand within haulTautM as taut, so a load coming in slower than pullHandSpeedMps + haulTautM/DT (4.5 m/s) never leaves the rope slack; the "one yank per pull" test shoves the log at 5 m/s. (5) Creature reel-in still uses pullHandSpeedMps (TODO "creature hand speed").
