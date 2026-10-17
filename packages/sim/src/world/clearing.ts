// The Clearing (docs/M1-DESIGN.md §6.7): generateClearing builds the terrain heights, the ground cover and every entity
// in a fixed order from the seed's `gen` stream and CLEARING_TUNING only, so a load regenerates the same ids and poses
// and the save stores only what differs (§8.3).
//
// The layout, in the order the `gen` stream is drawn and entity ids are allocated (§6.7, with the departures marked *):
//  1. noise tables (two floor octaves, the rim's radius around the valley, the cover), then the terrain heights;
//  2. the lair at the north rim foot (north = −z) and the giant's 8-waypoint route around (0, 10), waypoint 0 on the
//     line toward the lair, one waypoint 6 m behind the ledge's high side;
//  3. six groves on a ring of bearings; two opposite ones are centred on the route, so a leg runs through a tree-free
//     corridor 12-16 m wide between the grove's two halves*;
//  4. 60 trees: each grove's gate first (two big trunks 1.8 m apart at the grove's edge facing the route), then the
//     other grove trees, then 12 singles (ids in that order); then the ground cover (no draws);
//  5. 12 hanging vines on the 12 tallest grove-edge trees, then the 6 vine coils*;
//  6. saplings, outcrop centres, stones, flint, boulders, dry branches, dry logs, the damp grove's rotten wood, grass;
//  7. the three ape homes and their loops* (drawn farthest first: C, B, A), the snags (one at each home, one at the
//     ledge's foot), the starter cache;
//  8. four fixed walls behind the rim top at the terrain's edges*.
// * Departures and readings (each is also noted where it happens): the vine coils, which §6.7's order leaves out, are
//   drawn with the vines; the ape homes are drawn before the snags, since a snag lies at each home's edge (no entity
//   id moves: homes make none); the boundary walls, also absent from the order, come last; a "corridor between a grove
//   pair" is a grove the route splits in two.
//
// Every choice is rejection-sampled with CLEARING_TUNING.rejectionTries tries; when none passes, the try with the fewest
// violations (a broken hard rule weighs more than any number of soft ones) is taken, so the counts are always exact and
// the result is a pure function of the seed and the tuning. Loose things are set down at rest: a prism lying along
// the local slope (its rotation tilted to the terrain normal), at `groundRestY`; stones, grass and coils at
// `groundRestY` unrotated, as the factory sets them down (on a slope they tip flush in their first second, a few
// degrees, and count as touched; TODO "rotated generated stones": the factory's spawnStone, spawnGrass and
// spawnRopeCoil take no rotation yet).
//
// Distances "from the spawn" are from (WORLD_TUNING.spawnX, spawnZ); the rim and the route are laid out around the
// terrain's centre and CLEARING_TUNING.routeCentre. A world smaller than the Clearing's 200 m (a test's) gets the same
// draws, and only the things that land on its terrain.
//
// TODO "M2 decay (rule 10)": an untouched generated entity is not saved, so it reloads regenerated with age 0; M2's
// decay must either save the age of what it ages or derive it from the world's tick.
import type { Rng } from '../sim/math';
import { defineTuning } from '../tuning/registry';
import {
  FACTORY_TUNING,
  grassBox,
  groundRestY,
  hangVine,
  logPrism,
  LYING_ALONG_X,
  prismRForMass,
  prismRForRoundDiam,
  ropeCoilShape,
  spawnBox,
  spawnGrass,
  spawnLog,
  spawnRopeCoil,
  spawnSapling,
  spawnStarterAxe,
  spawnStick,
  spawnStone,
  spawnTree,
  stickPrism,
  stoneHull,
  type XZ,
} from './factory';
import { MATERIALS } from './materials';
import { PHYSICS_TUNING } from './physics';
import type { MaterialId, Quat, Shape, V3 } from './types';
import type { World } from './world';
import { WORLD_TUNING } from './worldTuning';

export const CLEARING_TUNING = defineTuning(
  'CLEARING_TUNING',
  'World › Clearing',
  {
    trees: 60,
    groves: 6,
    treesPerGrove: 8,
    singleTrees: 12,
    treeDiamBands: [
      { minM: 0.2, maxM: 0.3, share: 0.5 },
      { minM: 0.3, maxM: 0.45, share: 0.35 },
      { minM: 0.45, maxM: 0.6, share: 0.15 },
    ],
    treeHeight: { baseM: 6, perDiamM: 18, jitterM: 1.5, minM: 8, maxM: 16 },
    groveDistM: [30, 65],
    groveRadiusM: [10, 15],
    groveBearingJitterDeg: 15,
    treeMinGapM: 4,
    spawnClearM: 15,
    routeClearM: 6,
    maxSlopeDeg: 25,
    gates: 2,
    gateGapM: 1.8,
    gateDiamM: [0.5, 0.6],
    hangingVines: 12,
    vineAnchorM: [7, 12],
    vineAnchorMaxFrac: 0.8,
    vineSlackM: [3, 8.5],
    longVines: 4,
    longVineAnchorM: 10,
    longVineSlackM: 8.5,
    longVineTreeMinH: 12.5,
    vineCoilsM: [10, 12, 14, 16, 18, 20],
    saplings: 20,
    saplingDiamM: [0.04, 0.08],
    saplingHeightM: [2.5, 3.5],
    saplingsNearSpawn: 4,
    boulders: 3,
    boulderKg: 800,
    throwingStones: 25,
    throwingStoneKg: [0.5, 3],
    weightStones: 15,
    weightStoneKg: [8, 40],
    outcrops: 3,
    outcropR: 4,
    flint: 10,
    flintKg: [0.3, 1.0],
    flintNearSpawn: 2,
    dryBranches: 40,
    branchDiamM: [0.03, 0.1],
    branchLenM: [0.8, 3.0],
    branchesNearSpawn: 8,
    stickBlanks: 2,
    dryLogs: 5,
    logDiamM: [0.25, 0.4],
    logLenM: [3, 5],
    rottenBranches: 20,
    rottenBranchSize: { lengthM: 2.5, diamM: 0.05 },
    rottenLogs: 2,
    rottenLogSize: { lengthM: 2, diamM: 0.25 },
    grassBundles: 30,
    grassKg: [1, 3],
    snags: 4,
    snagKg: [80, 120],
    snagPoints: 3,
    snagSharpness: 0.45,
    starterCacheAt: [2.5, 3.0],
    apeHomes: 3,
    apeHomeDistM: [38, 62, 78],
    homeLoopR: 15,
    routeWaypoints: 8,
    routeRadiusM: 55,
    routeRadiusJitterM: 8,
    routeCentre: [0, 10],
    routeMinSpawnDistM: 45,
    lairR: 78,
    floorAmpM: 1.5,
    floorScalesM: [48, 16],
    flatInnerM: 15,
    flatOuterM: 25,
    rimHeightM: 18,
    rimRadiusM: 82,
    rimRadiusJitterM: 5,
    rimWidthM: 14,
    ledgeDropM: 6,
    ledgeLenM: 30,
    ledgeCentre: [40, -35],
    ledgeTransitionM: 3,
    ledgeFadeM: 25,
    coverBase: 0.55,
    coverAmp: 0.45,
    coverScaleM: 30,
    coverGrovePenalty: 0.4,
    coverTrunkClearM: 3,
    coverSpawn: 0.4,
    coverCellM: 2,
    rejectionTries: 30,
    // Values §6.7 states in prose or formulas, or leaves open (P21; the registry gives each its source):
    floorWeights: [0.65, 0.35],
    rimNormPower: 4,
    rimNoiseCells: 8,
    ledgeNormal: [1, -1],
    ledgeKeepOutM: 2,
    ledgeRouteBehindM: 6,
    lairBearingJitterDeg: 10,
    lairClearM: 10,
    routeRimMarginM: 10,
    routeSampleM: 1,
    corridorLegs: 2,
    corridorWidthM: [12, 16],
    groveEdgeFrac: 0.5,
    groveEdgeGapM: [1, 3],
    vineHangGapM: 0.3,
    vineYawSteps: 16,
    coilNearSpawnLengthsM: [12, 18],
    coilNearSpawnM: 20,
    nearSpawnMinM: 3,
    cacheClearM: 1.5,
    trunkClearM: 0.3,
    looseGapM: 0.05,
    saplingRingGapM: [3, 8],
    saplingNearSpawnM: 25,
    saplingGapM: 1.5,
    outcropDistM: [20, 70],
    stonesNearSpawn: 5,
    stoneNearSpawnM: 15,
    flintNearSpawnM: 12,
    boulderNearSpawnM: 20,
    boulderLegOffsetM: [8, 16],
    boulderAboveLegM: 1,
    branchNearSpawnM: 25,
    blankLenM: [1.4, 1.6],
    blankDiamM: 0.05,
    logNearSpawnKg: [110, 130],
    logNearSpawnM: 30,
    routeLogKg: 300,
    routeLogOffsetM: 4,
    grassMinCover: 0.6,
    coverSpawnR: 15,
    homeEdgeGapM: 3,
    apeHomeMinSepDeg: 100,
    homeLoopRimMarginM: 5,
    homeClearM: 1.5,
    snagHomeDistM: [5, 8],
    snagLenM: [2.5, 3.5],
    snagLedgeOffsetM: 1.5,
    snagLedgeSpreadM: 10,
    diggingStick: { lengthM: 1.5, diamM: 0.05, sharpness: 0.5 },
    starterStickOffset: [0, 0.5],
    starterCoilOffset: [1.1, 0.25],
    starterCoilM: 8,
    boundaryWallThickM: 1,
    boundaryWallAboveM: 4,
    boundaryWallBelowM: 2,
  },
  {
    trees: { unit: 'trees', source: 'SPEC:869' },
    groves: { unit: 'count', source: 'NEW' },
    treesPerGrove: { unit: 'count', source: 'NEW' },
    singleTrees: { unit: 'count', source: 'NEW' },
    treeDiamBands: { unit: 'm (share of trees)', source: 'NEW: 0.20-0.30 (50 %), 0.30-0.45 (35 %), 0.45-0.60 (15 %)' },
    treeHeight: {
      baseM: { unit: 'm', source: 'NEW: clamp(6 + 18·d ± 1.5, 8, 16)' },
      perDiamM: { unit: 'm per m of diameter', source: 'NEW: clamp(6 + 18·d ± 1.5, 8, 16)' },
      jitterM: { unit: 'm', source: 'NEW: clamp(6 + 18·d ± 1.5, 8, 16)' },
      minM: { unit: 'm', source: 'NEW: clamp(6 + 18·d ± 1.5, 8, 16)' },
      maxM: { unit: 'm', source: 'NEW: clamp(6 + 18·d ± 1.5, 8, 16)' },
    },
    groveDistM: { unit: 'm [min, max]', source: 'NEW' },
    groveRadiusM: { unit: 'm [min, max]', source: 'NEW' },
    groveBearingJitterDeg: { unit: '°', source: 'NEW' },
    treeMinGapM: { unit: 'm', source: 'NEW' },
    spawnClearM: { unit: 'm', source: 'NEW' },
    routeClearM: { unit: 'm', source: 'NEW' },
    maxSlopeDeg: { unit: '°', source: 'NEW' },
    gates: { unit: 'count', source: 'NEW: SPEC:774, MAP recast §9' },
    gateGapM: { unit: 'm', source: 'NEW: SPEC:774, MAP recast §9' },
    gateDiamM: { unit: 'm [min, max]', source: 'NEW: SPEC:774, MAP recast §9' },
    hangingVines: { unit: 'count', source: 'NEW' },
    vineAnchorM: { unit: 'm [min, max]', source: 'NEW' },
    vineAnchorMaxFrac: { unit: '× tree height', source: 'NEW' },
    vineSlackM: { unit: 'm [min, max]', source: 'NEW' },
    longVines: { unit: 'count', source: 'NEW: AC-3 needs ≥ 17.96 m' },
    longVineAnchorM: { unit: 'm (at least)', source: 'NEW: AC-3 needs ≥ 17.96 m' },
    longVineSlackM: { unit: 'm', source: 'NEW: AC-3 needs ≥ 17.96 m' },
    longVineTreeMinH: { unit: 'm', source: 'NEW: AC-3 needs ≥ 17.96 m' },
    vineCoilsM: { unit: 'm', source: 'NEW' },
    saplings: { unit: 'count', source: 'NEW' },
    saplingDiamM: { unit: 'm [min, max]', source: 'NEW' },
    saplingHeightM: { unit: 'm [min, max]', source: 'NEW' },
    saplingsNearSpawn: { unit: 'count', source: 'NEW' },
    boulders: { unit: 'count', source: 'NEW (AC-6 mass)' },
    boulderKg: { unit: 'kg', source: 'NEW (AC-6 mass)' },
    throwingStones: { unit: 'count', source: 'NEW' },
    throwingStoneKg: { unit: 'kg [min, max]', source: 'NEW' },
    weightStones: { unit: 'count', source: 'NEW' },
    weightStoneKg: { unit: 'kg [min, max]', source: 'NEW' },
    outcrops: { unit: 'count', source: 'NEW' },
    outcropR: { unit: 'm', source: 'NEW' },
    flint: { unit: 'count', source: 'NEW' },
    flintKg: { unit: 'kg [min, max]', source: 'NEW' },
    flintNearSpawn: { unit: 'count', source: 'NEW' },
    dryBranches: { unit: 'count', source: 'NEW' },
    branchDiamM: { unit: 'm [min, max]', source: 'NEW' },
    branchLenM: { unit: 'm [min, max]', source: 'NEW' },
    branchesNearSpawn: { unit: 'count', source: 'NEW' },
    stickBlanks: { unit: 'count', source: 'NEW' },
    dryLogs: { unit: 'count', source: 'NEW' },
    logDiamM: { unit: 'm [min, max]', source: 'NEW' },
    logLenM: { unit: 'm [min, max]', source: 'NEW' },
    rottenBranches: { unit: 'count', source: 'NEW: D-24' },
    rottenBranchSize: {
      lengthM: { unit: 'm', source: 'NEW: D-24 (2.5 m × 5 cm, 2 kg)' },
      diamM: { unit: 'm', source: 'NEW: D-24 (2.5 m × 5 cm, 2 kg)' },
    },
    rottenLogs: { unit: 'count', source: 'NEW: D-24' },
    rottenLogSize: {
      lengthM: { unit: 'm', source: 'NEW: D-24 (2 m × 25 cm, 40 kg)' },
      diamM: { unit: 'm', source: 'NEW: D-24 (2 m × 25 cm, 40 kg)' },
    },
    grassBundles: { unit: 'count', source: 'NEW' },
    grassKg: { unit: 'kg [min, max]', source: 'NEW' },
    snags: { unit: 'count', source: 'NEW: AC-9 pace' },
    snagKg: { unit: 'kg [min, max]', source: 'NEW: AC-9 pace' },
    snagPoints: { unit: 'count', source: 'NEW: AC-9 pace' },
    snagSharpness: { unit: '—', source: 'NEW: AC-9 pace' },
    starterCacheAt: { unit: 'm (x, z)', source: 'NEW' },
    apeHomes: { unit: 'count', source: 'NEW' },
    apeHomeDistM: { unit: 'm', source: 'NEW' },
    homeLoopR: { unit: 'm', source: 'NEW' },
    routeWaypoints: { unit: 'count', source: 'NEW' },
    routeRadiusM: { unit: 'm', source: 'NEW (55 ± 8)' },
    routeRadiusJitterM: { unit: 'm', source: 'NEW (55 ± 8)' },
    routeCentre: { unit: 'm (x, z)', source: 'NEW' },
    routeMinSpawnDistM: { unit: 'm', source: 'NEW' },
    lairR: { unit: 'm', source: 'NEW' },
    floorAmpM: { unit: 'm', source: 'NEW' },
    floorScalesM: { unit: 'm', source: 'NEW' },
    flatInnerM: { unit: 'm', source: 'NEW' },
    flatOuterM: { unit: 'm', source: 'NEW' },
    rimHeightM: { unit: 'm', source: 'NEW' },
    rimRadiusM: { unit: 'm', source: 'NEW (82 ± 5)' },
    rimRadiusJitterM: { unit: 'm', source: 'NEW (82 ± 5)' },
    rimWidthM: { unit: 'm', source: 'NEW' },
    ledgeDropM: { unit: 'm', source: 'NEW (6 m, was 3 m: a real cliff-edge hazard for an ape, RR-16)' },
    ledgeLenM: { unit: 'm', source: 'NEW' },
    ledgeCentre: { unit: 'm (x, z)', source: 'NEW' },
    ledgeTransitionM: { unit: 'm', source: 'NEW' },
    ledgeFadeM: { unit: 'm', source: 'NEW' },
    coverBase: { unit: '—', source: 'NEW' },
    coverAmp: { unit: '—', source: 'NEW' },
    coverScaleM: { unit: 'm', source: 'NEW' },
    coverGrovePenalty: { unit: '—', source: 'NEW' },
    coverTrunkClearM: { unit: 'm', source: 'NEW' },
    coverSpawn: { unit: '—', source: 'NEW' },
    coverCellM: { unit: 'm', source: 'NEW' },
    rejectionTries: { unit: 'tries', source: 'NEW' },
    floorWeights: { unit: '× floorAmpM per octave (floorScalesM order)', source: 'NEW: §6.7 floor = 1.5 m · (0.65 · n(x/48) + 0.35 · n(x/16))' },
    rimNormPower: { unit: 'p of e = (|x|^p + |z|^p)^(1/p)', source: 'NEW: §6.7 rim, e = (|x|⁴ + |z|⁴)^¼', min: 1 },
    rimNoiseCells: { unit: 'noise cells around the valley', source: "NEW (P21): §6.7's n(θ) for R(θ) = 82 + 5 · n(θ)", min: 1, step: 1 },
    ledgeNormal: { unit: '(x, z), toward the low side', source: 'NEW: §6.7 ledge normal (1, −1)/√2' },
    ledgeKeepOutM: { unit: 'm', source: 'NEW (P21): how far trees, waypoints and fixed things keep from the ledge and its hollow' },
    ledgeRouteBehindM: { unit: 'm', source: "NEW: §6.7 (one route waypoint 6 m behind the ledge's high side)" },
    lairBearingJitterDeg: { unit: '° from north', source: 'NEW (P21): §6.7 (the lair at the north rim foot)' },
    lairClearM: { unit: 'm', source: 'NEW (P21): §6.7 (the lair is open ground)' },
    routeRimMarginM: { unit: 'm inside the rim foot', source: 'NEW (P21): route waypoints stay on the valley floor' },
    routeSampleM: { unit: 'm', source: "NEW (P21): the step at which a leg's slope (≤ maxSlopeDeg) is checked" },
    corridorLegs: { unit: 'count', source: 'NEW: §6.7 (two legs between grove pairs)' },
    corridorWidthM: { unit: 'm [min, max]', source: 'NEW: §6.7 (corridors 12-16 m wide)' },
    groveEdgeFrac: { unit: "× the grove's radius", source: "NEW (P21): a grove-edge tree is at least this far from its grove's centre" },
    groveEdgeGapM: { unit: "m outside the grove's ring [min, max]", source: 'NEW (P21): where things "at grove edges" lie' },
    vineHangGapM: { unit: 'm', source: 'NEW: §6.7 (length = anchor − 0.3 m + slack)' },
    vineYawSteps: { unit: 'directions', source: "NEW (P21): the directions tried for a vine's open side", min: 1, step: 1 },
    coilNearSpawnLengthsM: { unit: 'm', source: 'NEW: §6.7 (the 12 m and 18 m coils near the spawn)' },
    coilNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (within 20 m of the spawn)' },
    nearSpawnMinM: { unit: 'm', source: 'NEW (P21): loose things keep this far from the spawn point' },
    cacheClearM: { unit: 'm', source: 'NEW (P21): generated things keep this far from the starter cache' },
    trunkClearM: { unit: 'm', source: 'NEW (P21): loose things keep this far from a trunk' },
    looseGapM: { unit: 'm', source: 'NEW (P21): the gap between loose things set down (none starts touching another)' },
    saplingRingGapM: { unit: "m outside the grove's ring [min, max]", source: 'NEW: §6.7 (saplings 3-8 m outside grove rings)' },
    saplingNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (4 within 25 m of the spawn)' },
    saplingGapM: { unit: 'm', source: 'NEW (P21): between a sapling and any trunk' },
    outcropDistM: { unit: 'm from the spawn [min, max]', source: 'NEW (P21)' },
    stonesNearSpawn: { unit: 'count', source: 'NEW: §6.7 (5 throwing stones within 15 m of the spawn)' },
    stoneNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (5 throwing stones within 15 m of the spawn)' },
    flintNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (2 within 12 m of the spawn)' },
    boulderNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (one 20 m from the spawn)' },
    boulderLegOffsetM: { unit: 'm outside a route leg [min, max]', source: 'NEW (P21): §6.7 (two on the slope above a route leg)' },
    boulderAboveLegM: { unit: 'm above the leg', source: 'NEW (P21): §6.7 (two on the slope above a route leg)' },
    branchNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (8 within 25 m of the spawn)' },
    blankLenM: { unit: 'm [min, max]', source: 'NEW: §6.7 (digging-stick blanks 1.4-1.6 m × 5 cm)' },
    blankDiamM: { unit: 'm', source: 'NEW: §6.7 (digging-stick blanks 1.4-1.6 m × 5 cm)' },
    logNearSpawnKg: { unit: 'kg [min, max]', source: 'NEW: §6.7 (one 110-130 kg within 30 m of the spawn)' },
    logNearSpawnM: { unit: 'm', source: 'NEW: §6.7 (one 110-130 kg within 30 m of the spawn)' },
    routeLogKg: { unit: 'kg', source: 'NEW: §6.7 (one ≈ 300 kg beside a route leg)' },
    routeLogOffsetM: { unit: 'm from the leg', source: 'NEW (P21): §6.7 (beside a route leg)' },
    grassMinCover: { unit: 'cover', source: 'NEW: §6.7 (grass in meadows, cover ≥ 0.6)' },
    coverSpawnR: { unit: 'm', source: 'NEW (P21): §6.7 (cover 0.4 around the spawn)' },
    homeEdgeGapM: { unit: "m outside the grove's ring", source: 'NEW (P21): §6.7 (homes at grove edges facing open ground)' },
    apeHomeMinSepDeg: { unit: '°', source: 'NEW: §6.7 (bearings ≥ 100° apart)' },
    homeLoopRimMarginM: { unit: 'm inside the rim foot', source: "NEW (P21): a home loop's waypoints stay on the valley floor" },
    homeClearM: { unit: 'm', source: "NEW (P21): a home and its loop's waypoints keep this far from trunks and other things" },
    snagHomeDistM: { unit: 'm from the home [min, max]', source: 'NEW (P21): §6.7 (a snag at the edge of each ape home)' },
    snagLenM: { unit: 'm [min, max]', source: 'NEW (P21)' },
    snagLedgeOffsetM: { unit: "m beyond the ledge's transition", source: 'NEW (P21): §6.7 (one at the foot of the ledge)' },
    snagLedgeSpreadM: { unit: 'm along the ledge (±)', source: 'NEW (P21): §6.7 (one at the foot of the ledge)' },
    diggingStick: {
      lengthM: { unit: 'm', source: 'NEW: §6.7 starter cache (a digging stick, dry, 1.5 m × 5 cm, point 0.5)' },
      diamM: { unit: 'm (diameter of a round stick of the same cross-section)', source: 'NEW: §6.7 starter cache (1.5 m × 5 cm)' },
      sharpness: { unit: 'sharpness', source: 'NEW: §6.7 starter cache (point 0.5)', min: 0, max: 1 },
    },
    starterStickOffset: { unit: 'm (x, z) from starterCacheAt', source: 'NEW (P21)' },
    starterCoilOffset: { unit: 'm (x, z) from starterCacheAt', source: 'NEW (P21)' },
    starterCoilM: { unit: 'm', source: 'NEW: §6.7 starter cache (an 8 m vine coil)' },
    boundaryWallThickM: { unit: 'm', source: 'NEW (P21): §6.7 (four fixed boxes behind the rim top)' },
    boundaryWallAboveM: { unit: "m above the terrain's edge", source: 'NEW (P21): §6.7 (they catch anything flung over the rim)' },
    boundaryWallBelowM: { unit: "m below the terrain's edge", source: 'NEW (P21)' },
  },
);

/** What generation tells the spawner and the world (§6.6, §6.7). */
export interface ClearingSpawnData {
  /** The player's yaw at the spawn (facing ape home A). */
  playerYaw: number;
  /** Ape homes: the home point and its 3-waypoint loop on the human layer. */
  apeHomes: { home: XZ; loop: XZ[] }[];
  /** The giant's lair; null in an empty scene. */
  lair: XZ | null;
  /** The giant's patrol route (waypoint 0 at the lair approach). */
  route: XZ[];
}

/**
 * Builds the terrain heights (`w.terrain.generate`, unless `w.options.terrain` is 'flat'), the ground cover and every
 * entity in §6.7's fixed order, drawing only from `rng` (the world's `gen` stream).
 */
export function generateClearing(w: World, rng: Rng): ClearingSpawnData {
  return new ClearingGen(w, rng).run();
}

// ---------------------------------------------------------------------------
// The terrain's shape (pure: generation and tests read it)
// ---------------------------------------------------------------------------

/**
 * The ledge's depth below the floor at (x, z) (§6.7): ledgeDropM on the low side of a ledgeLenM line centred at
 * ledgeCentre with normal ledgeNormal (toward the low side), reached over a linear transition of ledgeTransitionM
 * (6 m over 3 m: ≈ 63°) and fading back to 0 over ledgeFadeM beyond it (a hollow whose far side rises gently); at
 * the line's ends the drop ends over the same transition (steep end walls).
 */
export function clearingLedgeDepth(x: number, z: number): number {
  return ledgeDepthFn()(x, z);
}

/** clearingLedgeDepth with the tuning read once (generation calls it per terrain vertex). */
function ledgeDepthFn(): (x: number, z: number) => number {
  const T = CLEARING_TUNING;
  const L = ledgeFrame();
  const half = T.ledgeLenM / 2;
  const tr = T.ledgeTransitionM;
  const fadeM = T.ledgeFadeM;
  const drop = T.ledgeDropM;
  if (!(drop > 0)) return () => 0;
  return (x, z) => {
    const dx = x - L.cx;
    const dz = z - L.cz;
    const d = dx * L.nx + dz * L.nz;
    if (!(d > 0)) return 0;
    const u = Math.abs(dx * L.tx + dz * L.tz);
    if (u >= half + tr) return 0;
    const across = u <= half ? 1 : 1 - (u - half) / tr;
    const fall = d < tr ? d / tr : 1 - smoothstep(tr, tr + fadeM, d);
    return drop * across * fall;
  };
}

/** The ledge's line: its centre, its unit normal toward the low side (n) and its direction (t = n turned 90°). */
export function clearingLedgeFrame(): { cx: number; cz: number; nx: number; nz: number; tx: number; tz: number } {
  return ledgeFrame();
}

/** The rim's superellipse norm e = (|x|^p + |z|^p)^(1/p) about the terrain's centre (§6.7). */
export function clearingRimNorm(x: number, z: number): number {
  const p = CLEARING_TUNING.rimNormPower;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (p === 4) return Math.sqrt(Math.sqrt(ax * ax * ax * ax + az * az * az * az));
  if (p === 2) return Math.hypot(ax, az);
  return Math.pow(Math.pow(ax, p) + Math.pow(az, p), 1 / p);
}

function ledgeFrame(): { cx: number; cz: number; nx: number; nz: number; tx: number; tz: number } {
  const T = CLEARING_TUNING;
  const [ax, az] = T.ledgeNormal;
  const n = Math.hypot(ax, az);
  if (!(n > 0)) throw new Error('CLEARING_TUNING.ledgeNormal must not be zero');
  const nx = ax / n;
  const nz = az / n;
  return { cx: T.ledgeCentre[0], cz: T.ledgeCentre[1], nx, nz, tx: -nz, tz: nx };
}

// ---------------------------------------------------------------------------
// Seeded value noise (drawn from the gen stream)
// ---------------------------------------------------------------------------

/** 2-D value noise in [−1, 1]: random lattice values (256, hashed by a random permutation), smoothstep-interpolated. */
class ValueNoise2 {
  private readonly perm = new Uint16Array(512);
  private readonly vals = new Float64Array(256);

  constructor(rng: Rng) {
    const p = shuffled(rng, Array.from({ length: 256 }, (_, i) => i));
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) this.vals[i] = rng.next() * 2 - 1;
  }

  at(x: number, z: number): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const sx = fade(x - xi);
    const sz = fade(z - zi);
    const P = this.perm;
    const V = this.vals;
    const p0 = P[xi & 255];
    const p1 = P[(xi + 1) & 255];
    const j0 = zi & 255;
    const j1 = (zi + 1) & 255;
    const v00 = V[P[p0 + j0]];
    const v01 = V[P[p0 + j1]];
    const a = v00 + (V[P[p1 + j0]] - v00) * sx;
    const b = v01 + (V[P[p1 + j1]] - v01) * sx;
    return a + (b - a) * sz;
  }
}

/** 1-D value noise in [−1, 1] around a circle: `cells` random values, smoothstep-interpolated, periodic in 2π. */
class CircleNoise {
  private readonly vals: Float64Array;

  constructor(rng: Rng, cells: number) {
    const n = Math.max(1, Math.round(cells));
    this.vals = new Float64Array(n);
    for (let i = 0; i < n; i++) this.vals[i] = rng.next() * 2 - 1;
  }

  at(theta: number): number {
    const n = this.vals.length;
    const u = ((theta / (2 * Math.PI)) * n) % n;
    const w = u < 0 ? u + n : u;
    const i = Math.floor(w);
    const s = fade(w - i);
    const a = this.vals[i % n];
    const b = this.vals[(i + 1) % n];
    return a + (b - a) * s;
  }
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

interface Grove {
  c: XZ;
  r: number;
  /** m: trees keep this far (surface) from the route: the corridor's half width for a split grove, else routeClearM. */
  lane: number;
  /**
   * A split grove (the route runs through it): the unit direction of its leg and that leg's left normal. Its two halves
   * are half-disks of radius r whose flat edges line the corridor at `lane` on either side of its centre `c` (on the
   * leg), so the leg runs between them through a tree-free corridor 2 × lane wide. Null for an ordinary disk grove.
   */
  split: { dir: XZ; n: XZ } | null;
}

interface TreeRec {
  p: XZ;
  d: number;
  h: number;
  /** Its grove, −1 for a single. */
  grove: number;
  /** A gate's trunk, or a trunk lining a split grove's corridor: at the grove's edge facing the route. */
  edge: boolean;
  gate: boolean;
  /** Its entity, null when it lies off a small world's terrain. */
  id: number | null;
}

/** A thing on the ground as the placement rules see it: a capsule on the ground plane (a circle when a = b). */
interface Footprint {
  a: XZ;
  b: XZ;
  r: number;
}

/** Weight of a broken hard rule in a candidate's score (any soft rule weighs 1). */
const HARD = 1000;
const DEG = Math.PI / 180;

class ClearingGen {
  private readonly w: World;
  private readonly rng: Rng;
  private readonly T = CLEARING_TUNING;
  private readonly spawn: XZ;
  private readonly half: number;

  private readonly ledge = ledgeFrame();
  private readonly ledgeDepth = ledgeDepthFn();
  private floorNoise: [ValueNoise2, ValueNoise2] | null = null;
  private rimNoise: CircleNoise | null = null;
  private coverNoise: ValueNoise2 | null = null;

  private lair: XZ = { x: 0, z: 0 };
  private route: XZ[] = [];
  /** Every route segment: the closed loop's legs, then the lair leg (waypoint 0 → lair). */
  private routeSegs: [XZ, XZ][] = [];
  private ledgeIdx = -1;
  private groves: Grove[] = [];
  private trees: TreeRec[] = [];
  /** Rooted or heavy things placement keeps clear of (saplings, boulders). */
  private fixed: Footprint[] = [];
  /** Loose things on the ground. */
  private loose: Footprint[] = [];
  private outcropCentres: XZ[] = [];
  private homes: { home: XZ; loop: XZ[] }[] = [];
  private readonly cache: XZ;

  constructor(w: World, rng: Rng) {
    this.w = w;
    this.rng = rng;
    this.spawn = { x: WORLD_TUNING.spawnX, z: WORLD_TUNING.spawnZ };
    const t = w.terrain;
    this.half = Math.min(t.tilesX, t.tilesZ) * t.tileSize * 0.5;
    this.cache = { x: this.T.starterCacheAt[0], z: this.T.starterCacheAt[1] };
  }

  run(): ClearingSpawnData {
    this.noiseTables();
    if (this.w.options.terrain !== 'flat') this.w.terrain.generate(this.heightFn());
    this.routeAndLair();
    this.placeGroves();
    this.placeTrees();
    this.w.cover.generate(this.T.coverCellM, this.coverFn());
    this.hangingVines();
    // §6.7's order leaves the vine coils out: drawn with the vines.
    this.vineCoils();
    this.saplings();
    this.outcrops();
    this.stones();
    this.flint();
    this.boulders();
    this.branches();
    this.logs();
    this.rottenWood();
    this.grass();
    // Departure from §6.7's order (snags → starter cache → ape homes): a snag lies at each home's edge, so the homes
    // are drawn first. Homes make no entities, so no id moves.
    this.apeHomes();
    this.snags();
    this.starterCache();
    this.boundaryWalls();
    const a = this.homes[0]?.home;
    return {
      playerYaw: a ? Math.atan2(a.x - this.spawn.x, a.z - this.spawn.z) : 0,
      apeHomes: this.homes.map((h) => ({ home: { ...h.home }, loop: h.loop.map((p) => ({ ...p })) })),
      lair: { ...this.lair },
      route: this.route.map((p) => ({ ...p })),
    };
  }

  // -------------------------------------------------------------------------
  // Terrain
  // -------------------------------------------------------------------------

  private noiseTables(): void {
    this.floorNoise = [new ValueNoise2(this.rng), new ValueNoise2(this.rng)];
    this.rimNoise = new CircleNoise(this.rng, this.T.rimNoiseCells);
    this.coverNoise = new ValueNoise2(this.rng);
  }

  /** h(x, z) = floor · flat(r) + rim − ledge (§6.7), with this generation's constants read once (it runs per vertex). */
  private heightFn(): (x: number, z: number) => number {
    const T = this.T;
    const [n1, n2] = this.floorNoise!;
    const rim = this.rimNoise!;
    const sx = this.spawn.x;
    const sz = this.spawn.z;
    const fIn = T.flatInnerM;
    const fOut = T.flatOuterM;
    const a1 = T.floorAmpM * T.floorWeights[0];
    const a2 = T.floorAmpM * T.floorWeights[1];
    const s1 = T.floorScalesM[0];
    const s2 = T.floorScalesM[1];
    const R0 = T.rimRadiusM;
    const RJ = T.rimRadiusJitterM;
    const Rmin = R0 - Math.abs(RJ);
    const RW = T.rimWidthM;
    const RH = T.rimHeightM;
    const ledge = this.ledgeDepth;
    return (x, z) => {
      const dx = x - sx;
      const dz = z - sz;
      const flat = smoothstep(fIn, fOut, Math.sqrt(dx * dx + dz * dz));
      let h = flat > 0 ? (a1 * n1.at(x / s1, z / s1) + a2 * n2.at(x / s2, z / s2)) * flat : 0;
      const e = clearingRimNorm(x, z);
      if (e > Rmin) {
        const R = R0 + RJ * rim.at(Math.atan2(z, x));
        if (e > R) {
          const k = smoothstep(R, R + RW, e);
          h += RH * k * k;
        }
      }
      return h - ledge(x, z);
    };
  }

  /** R(θ) = rimRadiusM + rimRadiusJitterM · n(θ): where the rim starts on the bearing of (x, z). */
  private rimR(x: number, z: number): number {
    return this.T.rimRadiusM + this.T.rimRadiusJitterM * this.rimNoise!.at(Math.atan2(z, x));
  }

  /** Inside the rim's foot with `margin` m to spare (in the rim's norm). */
  private insideRim(p: XZ, margin: number): boolean {
    return clearingRimNorm(p.x, p.z) <= this.rimR(p.x, p.z) - margin;
  }

  private onTerrain(p: XZ, margin = 0.5): boolean {
    return Math.abs(p.x) <= this.half - margin && Math.abs(p.z) <= this.half - margin;
  }

  /** The terrain's slope at (x, z), degrees. */
  private slopeDeg(p: XZ): number {
    const n = this.w.terrain.normalAt(p.x, p.z, { x: 0, y: 1, z: 0 });
    return Math.acos(Math.min(1, Math.max(-1, n.y))) / DEG;
  }

  /** In the ledge's drop or its hollow, or within `margin` of them. */
  private inLedgeZone(p: XZ, margin: number): boolean {
    const T = this.T;
    if (!(T.ledgeDropM > 0)) return false;
    const L = this.ledge;
    const dx = p.x - L.cx;
    const dz = p.z - L.cz;
    const d = dx * L.nx + dz * L.nz;
    const u = Math.abs(dx * L.tx + dz * L.tz);
    return d > -margin && d < T.ledgeTransitionM + T.ledgeFadeM + margin && u < T.ledgeLenM / 2 + T.ledgeTransitionM + margin;
  }

  // -------------------------------------------------------------------------
  // Route and lair
  // -------------------------------------------------------------------------

  private routeAndLair(): void {
    const T = this.T;
    const rng = this.rng;
    // The lair: at the north rim foot (north = −z, the compass's), lairR from the spawn.
    const lb = Math.PI + rng.range(-T.lairBearingJitterDeg, T.lairBearingJitterDeg) * DEG;
    this.lair = polar(this.spawn, T.lairR, lb);

    const c: XZ = { x: T.routeCentre[0], z: T.routeCentre[1] };
    const n = Math.max(3, Math.round(T.routeWaypoints));
    const a0 = Math.atan2(this.lair.x - c.x, this.lair.z - c.z);
    const L = this.ledge;
    const ledgeWp: XZ = { x: L.cx - T.ledgeRouteBehindM * L.nx, z: L.cz - T.ledgeRouteBehindM * L.nz };
    // The waypoint nearest the ledge's bearing (never waypoint 0, the lair approach) is the one behind its high side.
    const la = Math.atan2(ledgeWp.x - c.x, ledgeWp.z - c.z);
    let best = Infinity;
    if (T.ledgeDropM > 0) {
      for (let k = 1; k < n; k++) {
        const d = Math.abs(angleDelta(a0 + (k * 2 * Math.PI) / n, la));
        if (d < best) {
          best = d;
          this.ledgeIdx = k;
        }
      }
    }
    const wp: (XZ | null)[] = new Array<XZ | null>(n).fill(null);
    if (this.ledgeIdx >= 0) wp[this.ledgeIdx] = ledgeWp;
    for (let k = 0; k < n; k++) {
      if (k === this.ledgeIdx) continue;
      const ak = a0 + (k * 2 * Math.PI) / n;
      wp[k] = this.pick(
        () => polar(c, rng.range(T.routeRadiusM - T.routeRadiusJitterM, T.routeRadiusM + T.routeRadiusJitterM), ak),
        (p) => {
          let s = 0;
          if (dist(p, this.spawn) < T.routeMinSpawnDistM) s += HARD;
          if (!this.insideRim(p, T.routeRimMarginM)) s += HARD;
          if (this.slopeDeg(p) > T.maxSlopeDeg) s += HARD;
          if (this.inLedgeZone(p, T.ledgeKeepOutM)) s += HARD;
          // The legs to whichever neighbours are already placed (the ledge's waypoint is placed first), and the lair leg.
          const prev = wp[(k - 1 + n) % n];
          const next = wp[(k + 1) % n];
          if (prev && this.legBad(prev, p)) s += HARD;
          if (next && this.legBad(p, next)) s += HARD;
          if (k === 0 && this.legBad(p, this.lair)) s += HARD;
          return s;
        },
      );
    }
    this.route = wp as XZ[];
    for (let k = 0; k < n; k++) this.routeSegs.push([this.route[k], this.route[(k + 1) % n]]);
    this.routeSegs.push([this.route[0], this.lair]);
  }

  /** A leg is bad where its ground is steeper than maxSlopeDeg or it enters the ledge's drop or hollow. */
  private legBad(a: XZ, b: XZ): boolean {
    const T = this.T;
    const len = dist(a, b);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.1, T.routeSampleM)));
    for (let i = 0; i <= steps; i++) {
      const p = lerpXZ(a, b, i / steps);
      if (this.slopeDeg(p) > T.maxSlopeDeg || this.inLedgeZone(p, 0)) return true;
    }
    return false;
  }

  /** The distance from p to the route (the loop and the lair leg). */
  private routeDist(p: XZ): number {
    let d = Infinity;
    for (const [a, b] of this.routeSegs) d = Math.min(d, segDist(p, a, b));
    return d;
  }

  /** The nearest point of the route's loop (not the lair leg) to p, with the unit direction of its leg. */
  private nearestOnLoop(p: XZ): { q: XZ; dir: XZ; leg: number } {
    let best = { q: this.route[0], dir: { x: 1, z: 0 }, leg: 0 };
    let bd = Infinity;
    const n = this.route.length;
    for (let k = 0; k < n; k++) {
      const a = this.route[k];
      const b = this.route[(k + 1) % n];
      const q = segClosest(p, a, b);
      const d = dist(p, q);
      if (d < bd) {
        bd = d;
        best = { q, dir: unit({ x: b.x - a.x, z: b.z - a.z }), leg: k };
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Groves and trees
  // -------------------------------------------------------------------------

  private placeGroves(): void {
    const T = this.T;
    const rng = this.rng;
    const G = Math.max(0, Math.round(T.groves));
    const b0 = rng.range(0, 2 * Math.PI);
    const bearings = Array.from({ length: G }, (_, g) => b0 + (g * 2 * Math.PI) / G + rng.range(-T.groveBearingJitterDeg, T.groveBearingJitterDeg) * DEG);
    // Corridor groves (§6.7 "two legs between grove pairs (corridors 12-16 m wide)"), read as groves the route splits
    // in two: a leg runs through a tree-free corridor between the two halves. Opposite each other on the ring, each is
    // centred where its bearing meets the route, moved into the middle half of that leg, away from the lair approach
    // and the ledge.
    const split = this.corridorGroves(bearings);
    const groves: (Grove | null)[] = new Array<Grove | null>(G).fill(null);
    for (const g of split) {
      const x = this.corridorSpot(bearings[g])!;
      const lane = rng.range(T.corridorWidthM[0], T.corridorWidthM[1]) / 2;
      groves[g] = { c: x.p, r: rng.range(T.groveRadiusM[0], T.groveRadiusM[1]), lane, split: { dir: x.dir, n: { x: -x.dir.z, z: x.dir.x } } };
    }
    for (let g = 0; g < G; g++) {
      if (groves[g]) continue;
      groves[g] = this.pick(
        (): Grove => ({ c: polar(this.spawn, rng.range(T.groveDistM[0], T.groveDistM[1]), bearings[g]), r: rng.range(T.groveRadiusM[0], T.groveRadiusM[1]), lane: T.routeClearM, split: null }),
        (gr) => {
          // Soft, graded by how much of the grove each rule takes, so the fallback keeps the most room for its trees:
          // other groves, the route's lanes, the spawn's and the lair's clearings, the rim and the ledge.
          let s = 0;
          if (!this.insideRim(gr.c, gr.r * 0.5)) s += HARD;
          const over = (d: number): number => (d > 0 ? Math.min(2, d / gr.r) : 0);
          for (const o of groves) if (o) s += over(o.r + gr.r + (o.split ? o.lane : 0) - dist(o.c, gr.c));
          s += over(gr.r + T.routeClearM - this.routeDist(gr.c));
          s += over(gr.r + T.spawnClearM - dist(gr.c, this.spawn));
          s += over(gr.r + T.lairClearM - dist(gr.c, this.lair));
          s += over(clearingRimNorm(gr.c.x, gr.c.z) + gr.r - this.rimR(gr.c.x, gr.c.z));
          if (this.inLedgeZone(gr.c, gr.r * 0.5)) s += 1;
          return s;
        },
      );
    }
    this.groves = groves as Grove[];
  }

  /** The corridor groves: opposite pairs on the ring, the first (from a drawn start) whose route crossings suit. */
  private corridorGroves(bearings: number[]): number[] {
    const T = this.T;
    const G = bearings.length;
    const want = Math.min(Math.max(0, Math.round(T.corridorLegs)), G);
    if (want === 0 || G === 0) return [];
    const step = Math.max(1, Math.floor(G / want));
    const start = Math.floor(this.rng.next() * G) % G;
    const keep = T.groveRadiusM[1] + T.corridorWidthM[1] / 2;
    const ok = (g: number): boolean => {
      const x = this.corridorSpot(bearings[g]);
      if (!x) return false;
      const d = dist(x.p, this.spawn);
      if (d < T.groveDistM[0] || d > T.groveDistM[1]) return false;
      if (dist(x.p, this.route[0]) < keep || dist(x.p, this.lair) < keep) return false;
      if (this.ledgeIdx >= 0 && dist(x.p, this.route[this.ledgeIdx]) < keep) return false;
      return !this.inLedgeZone(x.p, keep);
    };
    let first: number[] | null = null;
    for (let i = 0; i < G; i++) {
      const set = Array.from({ length: want }, (_, k) => (start + i + k * step) % G);
      first ??= set;
      if (set.every(ok)) return set.sort((a, b) => a - b);
    }
    return first!.sort((a, b) => a - b);
  }

  /** Where the ray from the spawn on `bearing` meets the route's loop, moved into the middle half of that leg. */
  private corridorSpot(bearing: number): { p: XZ; dir: XZ } | null {
    const dx = Math.sin(bearing);
    const dz = Math.cos(bearing);
    let best: { t: number; s: number; k: number } | null = null;
    const n = this.route.length;
    for (let k = 0; k < n; k++) {
      const hit = raySeg(this.spawn, dx, dz, this.route[k], this.route[(k + 1) % n]);
      if (hit && (!best || hit.t < best.t)) best = { ...hit, k };
    }
    if (!best) return null;
    const a = this.route[best.k];
    const b = this.route[(best.k + 1) % n];
    return { p: lerpXZ(a, b, clamp(best.s, 0.25, 0.75)), dir: unit({ x: b.x - a.x, z: b.z - a.z }) };
  }

  /** The middle of a split grove's half on `side` (±1 along its normal): the centre of its flat edge, on the corridor. */
  private lobe(gr: Grove, side: number): XZ {
    const n = gr.split!.n;
    return { x: gr.c.x + side * gr.lane * n.x, z: gr.c.z + side * gr.lane * n.z };
  }

  /** A drawn point under a grove: uniform in its disk, or in one of a split grove's halves. */
  private groveSpot(gr: Grove): XZ {
    if (!gr.split) return inDisk(this.rng, gr.c, gr.r);
    const side = this.rng.next() < 0.5 ? -1 : 1;
    const q = inDisk(this.rng, { x: 0, z: 0 }, gr.r);
    const o = this.lobe(gr, side);
    const { dir, n } = gr.split;
    const across = side * Math.abs(q.z);
    return { x: o.x + q.x * dir.x + across * n.x, z: o.z + q.x * dir.z + across * n.z };
  }

  /** A drawn point `gap` outside a grove's ring: around a disk grove, or around the outer arc of a split grove's half. */
  private groveRingPoint(gr: Grove, gap: readonly number[]): XZ {
    const rng = this.rng;
    if (!gr.split) return polar(gr.c, gr.r + rng.range(gap[0], gap[1]), rng.range(0, 2 * Math.PI));
    const side = rng.next() < 0.5 ? -1 : 1;
    const R = gr.r + rng.range(gap[0], gap[1]);
    const phi = rng.range(-Math.PI / 2, Math.PI / 2);
    const o = this.lobe(gr, side);
    const { dir, n } = gr.split;
    return { x: o.x + R * (Math.sin(phi) * dir.x + Math.cos(phi) * side * n.x), z: o.z + R * (Math.sin(phi) * dir.z + Math.cos(phi) * side * n.z) };
  }

  /** Whether p lies under a grove (in its disk, or in a split grove's half). */
  private inGrove(p: XZ): boolean {
    for (const gr of this.groves) {
      if (!gr.split) {
        if (dist(p, gr.c) <= gr.r) return true;
        continue;
      }
      for (const side of [-1, 1]) {
        const o = this.lobe(gr, side);
        if (((p.x - o.x) * gr.split.n.x + (p.z - o.z) * gr.split.n.z) * side >= 0 && dist(p, o) <= gr.r) return true;
      }
    }
    return false;
  }

  /** The centres of the circles a grove's ring follows: its disk's, or each of a split grove's halves'. */
  private groveCircles(gr: Grove): XZ[] {
    return gr.split ? [this.lobe(gr, -1), this.lobe(gr, 1)] : [gr.c];
  }

  /** The point a grove tree's outward direction starts from: its disk's centre, or its half's. */
  private groveOrigin(t: TreeRec): XZ {
    const gr = this.groves[t.grove];
    if (!gr.split) return gr.c;
    const side = (t.p.x - gr.c.x) * gr.split.n.x + (t.p.z - gr.c.z) * gr.split.n.z >= 0 ? 1 : -1;
    return this.lobe(gr, side);
  }

  private placeTrees(): void {
    const T = this.T;
    const rng = this.rng;
    const G = this.groves.length;
    const perGrove = Math.max(0, Math.round(T.treesPerGrove));
    const singles = Math.max(0, Math.round(T.singleTrees));
    const total = G * perGrove + singles;
    if (total !== T.trees) throw new Error(`CLEARING_TUNING: trees (${T.trees}) must equal groves × treesPerGrove + singleTrees (${total})`);

    // Diameters: exact band counts; the gates' trunks first (each from the band that holds it), the rest shuffled.
    const bands = T.treeDiamBands;
    const shareSum = bands.reduce((s, b) => s + b.share, 0);
    const counts = bands.map((b) => Math.round((b.share / shareSum) * total));
    counts[counts.length - 1] = total - counts.slice(0, -1).reduce((s, c) => s + c, 0);
    const gateGroves = this.gateGroves();
    const gateDs: number[] = [];
    for (let k = 0; k < gateGroves.length * 2; k++) {
      const d = rng.range(T.gateDiamM[0], T.gateDiamM[1]);
      let b = bands.findIndex((x) => d >= x.minM && d <= x.maxM);
      if (b < 0 || counts[b] <= 0) b = lastPositive(counts);
      if (b >= 0) counts[b]--;
      gateDs.push(d);
    }
    const rest: number[] = [];
    bands.forEach((b, i) => {
      for (let k = 0; k < counts[i]; k++) rest.push(rng.range(b.minM, b.maxM));
    });
    const ds = shuffled(rng, rest);
    const nextD = (): number => ds.pop() ?? bands[0].minM;

    for (let g = 0; g < G; g++) {
      const gr = this.groves[g];
      let n = perGrove;
      const gi = gateGroves.indexOf(g);
      let sides = gr.split ? [1, -1] : [];
      if (gi >= 0 && n >= 2) {
        const side = this.placeGate(g, gateDs[2 * gi], gateDs[2 * gi + 1]);
        sides = sides.filter((s) => s !== side);
        n -= 2;
      }
      // A split grove's corridor is lined on both sides: a trunk at the lane's edge on each side the gate isn't on.
      for (const side of sides) {
        if (n <= 0) break;
        this.placeLaneTree(nextD(), g, side);
        n--;
      }
      for (let k = 0; k < n; k++) this.placeTree(nextD(), g);
    }
    for (let k = 0; k < singles; k++) this.placeTree(nextD(), -1);
  }

  /** The groves with a gate: the split groves (they face the route), then the others nearest the route. */
  private gateGroves(): number[] {
    const n = Math.max(0, Math.round(this.T.gates));
    const order = this.groves.map((_, g) => g);
    order.sort((a, b) => {
      const ga = this.groves[a];
      const gb = this.groves[b];
      if (!!ga.split !== !!gb.split) return ga.split ? -1 : 1;
      return this.routeDist(ga.c) - ga.r - (this.routeDist(gb.c) - gb.r) || a - b;
    });
    return order.slice(0, Math.min(n, order.length)).sort((a, b) => a - b);
  }

  private treeHeight(d: number): number {
    const H = this.T.treeHeight;
    return clamp(H.baseM + H.perDiamM * d + this.rng.range(-H.jitterM, H.jitterM), H.minM, H.maxM);
  }

  /** The hard rules every trunk keeps (§6.7): spawn, route, lair, inside the rim, gentle ground, off the ledge. */
  private trunkViolations(p: XZ, d: number, lane: number): number {
    const T = this.T;
    let s = 0;
    if (dist(p, this.spawn) - d / 2 < T.spawnClearM) s += HARD;
    if (this.routeDist(p) - d / 2 < lane) s += HARD;
    if (dist(p, this.lair) - d / 2 < T.lairClearM) s += HARD;
    if (clearingRimNorm(p.x, p.z) + d / 2 > this.rimR(p.x, p.z)) s += HARD;
    if (this.slopeDeg(p) >= T.maxSlopeDeg) s += HARD;
    if (this.inLedgeZone(p, T.ledgeKeepOutM)) s += HARD;
    return s;
  }

  /** Soft: trunks treeMinGapM apart (centre to centre); graded, so the fallback takes the least crowded spot. */
  private gapViolations(p: XZ): number {
    const gap = this.T.treeMinGapM;
    let s = 0;
    for (const t of this.trees) {
      const d = dist(t.p, p);
      if (d < gap) s += 1 + (gap - d) / gap;
    }
    return s;
  }

  /**
   * A gate (§6.7): two trunks whose surfaces are gateGapM apart, side by side along the route at the grove's edge facing
   * it (a split grove's corridor edge, on a drawn side), so a person slips between them away from the route and the
   * giant can't. Returns the side of the route it stands on (along the leg's left normal).
   */
  private placeGate(g: number, d1: number, d2: number): number {
    const T = this.T;
    const rng = this.rng;
    const gr = this.groves[g];
    const near = gr.split ? { q: gr.c, dir: gr.split.dir } : this.nearestOnLoop(gr.c);
    const N = { x: -near.dir.z, z: near.dir.x };
    const towardGrove = (gr.c.x - near.q.x) * N.x + (gr.c.z - near.q.z) * N.z >= 0 ? 1 : -1;
    const pair = this.pick(
      () => {
        const side = gr.split ? (rng.next() < 0.5 ? -1 : 1) : towardGrove;
        const along = rng.range(-gr.r / 2, gr.r / 2);
        const off = gr.lane + Math.max(d1, d2) / 2;
        const E = { x: near.q.x + along * near.dir.x + side * off * N.x, z: near.q.z + along * near.dir.z + side * off * N.z };
        const k1 = T.gateGapM / 2 + d1 / 2;
        const k2 = T.gateGapM / 2 + d2 / 2;
        const at: [XZ, XZ] = [
          { x: E.x - k1 * near.dir.x, z: E.z - k1 * near.dir.z },
          { x: E.x + k2 * near.dir.x, z: E.z + k2 * near.dir.z },
        ];
        return { side, at };
      },
      ({ at: [a, b] }) => this.trunkViolations(a, d1, gr.lane) + this.trunkViolations(b, d2, gr.lane) + this.gapViolations(a) + this.gapViolations(b),
    );
    this.addTree(pair.at[0], d1, g, true, true);
    this.addTree(pair.at[1], d2, g, true, true);
    return pair.side;
  }

  /** A trunk lining a split grove's corridor on `side`: its surface at the lane's edge. */
  private placeLaneTree(d: number, g: number, side: number): void {
    const rng = this.rng;
    const gr = this.groves[g];
    const { dir, n } = gr.split!;
    const p = this.pick(
      () => {
        const along = rng.range(-gr.r / 2, gr.r / 2);
        const off = side * (gr.lane + d / 2);
        return { x: gr.c.x + along * dir.x + off * n.x, z: gr.c.z + along * dir.z + off * n.z };
      },
      (q) => this.trunkViolations(q, d, gr.lane) + this.gapViolations(q),
    );
    this.addTree(p, d, g, true, false);
  }

  private placeTree(d: number, g: number): void {
    const rng = this.rng;
    const gr = g >= 0 ? this.groves[g] : null;
    const p = this.pick(
      () => (gr ? this.groveSpot(gr) : { x: rng.range(-this.half, this.half), z: rng.range(-this.half, this.half) }),
      (q) => this.trunkViolations(q, d, gr ? gr.lane : this.T.routeClearM) + this.gapViolations(q) + (!gr && this.inGrove(q) ? 1 : 0),
    );
    this.addTree(p, d, g, false, false);
  }

  private addTree(p: XZ, d: number, grove: number, edge: boolean, gate: boolean): void {
    const h = this.treeHeight(d);
    const id = this.onTerrain(p) ? spawnTree(this.w, { at: p, diameter: d, height: h, generated: true }).tree : null;
    this.trees.push({ p, d, h, grove, edge, gate, id });
  }

  // -------------------------------------------------------------------------
  // Ground cover (no draws)
  // -------------------------------------------------------------------------

  /**
   * cover = clamp(0.55 + 0.45 · n(x/30, z/30) − 0.4 · inGrove, 0, 1); 0 on the rim and within coverTrunkClearM of a
   * trunk; coverSpawn within coverSpawnR of the spawn (§6.7). Cells near a trunk are found tree by tree first.
   */
  private coverFn(): (x: number, z: number) => number {
    const T = this.T;
    const t = this.w.terrain;
    const cell = T.coverCellM;
    const nx = Math.ceil((t.tilesX * t.tileSize) / cell - 1e-9);
    const nz = Math.ceil((t.tilesZ * t.tileSize) / cell - 1e-9);
    const bare = new Uint8Array(nx * nz);
    for (const tr of this.trees) {
      const R = tr.d / 2 + T.coverTrunkClearM;
      const i0 = Math.max(0, Math.floor((tr.p.x - R - t.minX) / cell));
      const i1 = Math.min(nx - 1, Math.floor((tr.p.x + R - t.minX) / cell));
      const j0 = Math.max(0, Math.floor((tr.p.z - R - t.minZ) / cell));
      const j1 = Math.min(nz - 1, Math.floor((tr.p.z + R - t.minZ) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = t.minX + (i + 0.5) * cell - tr.p.x;
          const cz = t.minZ + (j + 0.5) * cell - tr.p.z;
          if (cx * cx + cz * cz <= R * R) bare[j * nx + i] = 1;
        }
      }
    }
    const noise = this.coverNoise!;
    return (x, z) => {
      const i = Math.floor((x - t.minX) / cell);
      const j = Math.floor((z - t.minZ) / cell);
      if (i >= 0 && j >= 0 && i < nx && j < nz && bare[j * nx + i]) return 0;
      const p = { x, z };
      if (!this.insideRim(p, 0)) return 0;
      if (dist(p, this.spawn) <= T.coverSpawnR) return T.coverSpawn;
      const inGrove = this.inGrove(p) ? 1 : 0;
      return clamp(T.coverBase + T.coverAmp * noise.at(x / T.coverScaleM, z / T.coverScaleM) - T.coverGrovePenalty * inGrove, 0, 1);
    };
  }

  // -------------------------------------------------------------------------
  // Vines
  // -------------------------------------------------------------------------

  /**
   * 12 hanging vines (§6.7) on the 12 tallest grove-edge trees (a gate's trunks count as edge trees), the 4 long ones
   * on the tallest of them; each hangs on its tree's open side and its slack lies on the ground. Vines are hung in
   * tree id order, after every tree.
   */
  private hangingVines(): void {
    const T = this.T;
    const rng = this.rng;
    const isEdge = (t: TreeRec): boolean => t.grove >= 0 && (t.edge || dist(t.p, this.groveOrigin(t)) >= T.groveEdgeFrac * this.groves[t.grove].r);
    const byHeight = (a: number, b: number): number => this.trees[b].h - this.trees[a].h || a - b;
    const idx = this.trees.map((_, i) => i);
    // Edge trees first, then the other grove trees, then singles, each by height.
    const rank = (i: number): number => (isEdge(this.trees[i]) ? 0 : this.trees[i].grove >= 0 ? 1 : 2);
    idx.sort((a, b) => rank(a) - rank(b) || byHeight(a, b));
    const chosen = idx.slice(0, Math.min(Math.max(0, Math.round(T.hangingVines)), idx.length));
    const long = new Set([...chosen].sort(byHeight).slice(0, Math.max(0, Math.round(T.longVines))));
    for (const i of [...chosen].sort((a, b) => a - b)) {
      const t = this.trees[i];
      const top = Math.min(T.vineAnchorM[1], T.vineAnchorMaxFrac * t.h);
      let anchorH: number;
      let slack: number;
      if (long.has(i)) {
        anchorH = rng.range(Math.min(T.longVineAnchorM, top), top);
        slack = T.longVineSlackM;
      } else {
        anchorH = rng.range(Math.min(T.vineAnchorM[0], top), top);
        slack = rng.range(T.vineSlackM[0], T.vineSlackM[1]);
      }
      const lengthM = anchorH - T.vineHangGapM + slack;
      if (t.id === null) continue;
      hangVine(this.w, t.id, { anchorH, lengthM, yaw: this.openYaw(i, Math.max(0, lengthM - anchorH)) }, { generated: true });
    }
  }

  /**
   * A tree's open side for its vine: of vineYawSteps directions (starting outward from its grove's centre, or from the
   * spawn for a single), the one whose lying slack passes farthest from every other trunk, and stays on gentle ground
   * inside the rim; ties go to the first.
   */
  private openYaw(i: number, out: number): number {
    const T = this.T;
    const t = this.trees[i];
    const from = t.grove >= 0 ? this.groveOrigin(t) : this.spawn;
    const base = Math.atan2(t.p.x - from.x, t.p.z - from.z);
    const n = Math.max(1, Math.round(T.vineYawSteps));
    let best = base;
    let bestScore = -Infinity;
    for (let k = 0; k < n; k++) {
      const yaw = base + (k * 2 * Math.PI) / n;
      const a = polar(t.p, t.d / 2, yaw);
      const b = polar(t.p, t.d / 2 + out, yaw);
      let clear = Infinity;
      this.trees.forEach((o, j) => {
        if (j !== i) clear = Math.min(clear, segDist(o.p, a, b) - o.d / 2);
      });
      if (!this.insideRim(b, 1) || this.slopeDeg(b) > T.maxSlopeDeg || this.inLedgeZone(b, 0)) clear -= HARD;
      if (clear > bestScore + 1e-9) {
        bestScore = clear;
        best = yaw;
      }
    }
    return best;
  }

  /** 6 vine coils (§6.7): lengths shuffled; the 12 m and 18 m ones within 20 m of the spawn, the others at grove edges. */
  private vineCoils(): void {
    const T = this.T;
    const rng = this.rng;
    for (const len of shuffled(rng, [...T.vineCoilsM])) {
      const near = T.coilNearSpawnLengthsM.includes(len);
      const shape = ropeCoilShape(len);
      const p = this.pick(
        () => (near ? polar(this.spawn, rng.range(T.nearSpawnMinM, T.coilNearSpawnM), rng.range(0, 2 * Math.PI)) : this.groveEdgePoint()),
        (q) => this.looseViolations(circle(q, shape.r)),
      );
      this.loose.push(circle(p, shape.r));
      if (!this.onTerrain(p)) continue;
      const y = groundRestY(this.w, p.x, p.z, shape);
      spawnRopeCoil(this.w, { at: { x: p.x, y: y - shape.halfHeight, z: p.z }, material: 'vine', lengthM: len, generated: true });
    }
  }

  /** A point just outside a drawn grove's ring (groveEdgeGapM). */
  private groveEdgePoint(): XZ {
    return this.groveRingPoint(this.drawGrove(), this.T.groveEdgeGapM);
  }

  /** A grove drawn from the gen stream. */
  private drawGrove(): Grove {
    return this.groves[Math.floor(this.rng.next() * this.groves.length) % this.groves.length];
  }

  // -------------------------------------------------------------------------
  // Saplings, outcrops, stones, flint, boulders
  // -------------------------------------------------------------------------

  /** 20 saplings: 4 within 25 m of the spawn, the rest 3-8 m outside grove rings (§6.7). Rooted: off the route. */
  private saplings(): void {
    const T = this.T;
    const rng = this.rng;
    const n = Math.max(0, Math.round(T.saplings));
    const nearN = Math.min(n, Math.max(0, Math.round(T.saplingsNearSpawn)));
    for (let k = 0; k < n; k++) {
      const near = k < nearN;
      const d = rng.range(T.saplingDiamM[0], T.saplingDiamM[1]);
      const h = rng.range(T.saplingHeightM[0], T.saplingHeightM[1]);
      const p = this.pick(
        () => {
          if (near) return polar(this.spawn, rng.range(T.nearSpawnMinM, T.saplingNearSpawnM), rng.range(0, 2 * Math.PI));
          return this.groveRingPoint(this.drawGrove(), T.saplingRingGapM);
        },
        (q) => {
          let s = this.groundViolations(q, d / 2);
          if (dist(q, this.spawn) < T.nearSpawnMinM || dist(q, this.cache) < T.cacheClearM) s += HARD;
          if (this.routeDist(q) - d / 2 < T.routeClearM) s += HARD;
          if (dist(q, this.lair) < T.lairClearM) s += HARD;
          for (const t of this.trees) if (dist(t.p, q) - t.d / 2 - d / 2 < T.saplingGapM) s += 1;
          for (const f of this.fixed) if (capDist(q, f) - d / 2 < T.saplingGapM) s += 1;
          return s;
        },
      );
      this.fixed.push(circle(p, d / 2));
      if (this.onTerrain(p)) spawnSapling(this.w, { at: p, diameter: d, height: h, generated: true });
    }
  }

  /** Three outcrop centres on open ground (no entities). */
  private outcrops(): void {
    const T = this.T;
    const rng = this.rng;
    const R = T.outcropR;
    for (let k = 0; k < Math.max(0, Math.round(T.outcrops)); k++) {
      const p = this.pick(
        () => polar(this.spawn, rng.range(T.outcropDistM[0], T.outcropDistM[1]), rng.range(0, 2 * Math.PI)),
        (q) => {
          let s = 0;
          if (!this.onTerrain(q, R + 1) || !this.insideRim(q, R + 2) || this.slopeDeg(q) > T.maxSlopeDeg || this.inLedgeZone(q, R)) s += HARD;
          if (this.routeDist(q) < T.routeClearM + R) s += HARD;
          if (dist(q, this.lair) < T.lairClearM + R) s += HARD;
          if (dist(q, this.spawn) < T.spawnClearM) s += HARD;
          for (const g of this.groves) for (const c of this.groveCircles(g)) if (dist(c, q) < g.r + R) s += 1;
          for (const t of this.trees) if (dist(t.p, q) < R + t.d / 2 + 1) s += 1;
          for (const f of this.fixed) if (capDist(q, f) < R + 1) s += 1;
          for (const o of this.outcropCentres) if (dist(o, q) < 3 * R) s += 1;
          return s;
        },
      );
      this.outcropCentres.push(p);
    }
  }

  /** 40 stones: 5 throwing stones within 15 m of the spawn, then the other throwing stones and the weights in outcrops. */
  private stones(): void {
    const T = this.T;
    const throwing = Math.max(0, Math.round(T.throwingStones));
    const weights = Math.max(0, Math.round(T.weightStones));
    const nearN = Math.min(throwing, Math.max(0, Math.round(T.stonesNearSpawn)));
    for (let k = 0; k < throwing + weights; k++) {
      const kg = k < throwing ? T.throwingStoneKg : T.weightStoneKg;
      this.placeStone('stone', kg, k < nearN ? T.stoneNearSpawnM : null);
    }
  }

  /** 10 flint nodules: 2 within 12 m of the spawn, the rest in outcrops. */
  private flint(): void {
    const T = this.T;
    const n = Math.max(0, Math.round(T.flint));
    const nearN = Math.min(n, Math.max(0, Math.round(T.flintNearSpawn)));
    for (let k = 0; k < n; k++) this.placeStone('flint', T.flintKg, k < nearN ? T.flintNearSpawnM : null);
  }

  /** A stone or flint nodule of a drawn prototype and mass, near the spawn (within `nearM`) or in a drawn outcrop. */
  private placeStone(material: MaterialId, kg: readonly number[], nearM: number | null): void {
    const T = this.T;
    const rng = this.rng;
    const proto = Math.floor(rng.next() * 4) % 4;
    const mass = rng.range(kg[0], kg[1]);
    const shape = stoneHull(mass, proto, material);
    const r = horizontalReach(shape);
    const p = this.pick(
      () => {
        if (nearM !== null || this.outcropCentres.length === 0) return polar(this.spawn, rng.range(T.nearSpawnMinM, nearM ?? T.stoneNearSpawnM), rng.range(0, 2 * Math.PI));
        const o = this.outcropCentres[Math.floor(rng.next() * this.outcropCentres.length) % this.outcropCentres.length];
        return inDisk(rng, o, T.outcropR);
      },
      (q) => this.looseViolations(circle(q, r)),
    );
    this.loose.push(circle(p, r));
    if (!this.onTerrain(p)) return;
    const y = groundRestY(this.w, p.x, p.z, shape);
    spawnStone(this.w, { p: { x: p.x, y, z: p.z }, mass, proto: proto as 0 | 1 | 2 | 3, material, generated: true });
  }

  /** 3 boulders (§6.7): one 20 m from the spawn, two on the slope above one route leg (off the route: they block it). */
  private boulders(): void {
    const T = this.T;
    const rng = this.rng;
    const n = Math.max(0, Math.round(T.boulders));
    // The leg: drawn among the legs that touch neither the lair approach nor the ledge's waypoint.
    const legs = this.route.map((_, k) => k).filter((k) => {
      const k2 = (k + 1) % this.route.length;
      return k !== 0 && k2 !== 0 && k !== this.ledgeIdx && k2 !== this.ledgeIdx;
    });
    const leg = legs.length > 0 ? legs[Math.floor(rng.next() * legs.length) % legs.length] : 0;
    const c: XZ = { x: T.routeCentre[0], z: T.routeCentre[1] };
    for (let k = 0; k < n; k++) {
      const proto = Math.floor(rng.next() * 4) % 4;
      const shape = stoneHull(T.boulderKg, proto, 'stone');
      const r = horizontalReach(shape);
      let legPoint: XZ = this.spawn;
      const p = this.pick(
        () => {
          if (k === 0) return polar(this.spawn, T.boulderNearSpawnM, rng.range(0, 2 * Math.PI));
          const a = this.route[leg];
          const b = this.route[(leg + 1) % this.route.length];
          legPoint = lerpXZ(a, b, rng.range(0.2, 0.8));
          const dir = unit({ x: b.x - a.x, z: b.z - a.z });
          let N = { x: -dir.z, z: dir.x };
          // Outward: away from the route's centre, toward the rim.
          if ((legPoint.x - c.x) * N.x + (legPoint.z - c.z) * N.z < 0) N = { x: -N.x, z: -N.z };
          const off = rng.range(T.boulderLegOffsetM[0], T.boulderLegOffsetM[1]);
          return { x: legPoint.x + off * N.x, z: legPoint.z + off * N.z };
        },
        (q) => {
          let s = this.looseViolations(circle(q, r));
          if (this.routeDist(q) - r < T.routeClearM) s += HARD;
          if (dist(q, this.lair) < T.lairClearM) s += HARD;
          for (const f of this.fixed) if (capDist(q, f) - r < T.saplingGapM) s += 1;
          if (k > 0 && this.w.terrain.originalHeightAt(q.x, q.z) - this.w.terrain.originalHeightAt(legPoint.x, legPoint.z) < T.boulderAboveLegM) s += 1;
          return s;
        },
      );
      this.fixed.push(circle(p, r));
      this.loose.push(circle(p, r));
      if (!this.onTerrain(p)) continue;
      const y = groundRestY(this.w, p.x, p.z, shape);
      spawnStone(this.w, { p: { x: p.x, y, z: p.z }, mass: T.boulderKg, proto: proto as 0 | 1 | 2 | 3, material: 'stone', generated: true });
    }
  }

  // -------------------------------------------------------------------------
  // Wood and grass
  // -------------------------------------------------------------------------

  /** 40 dry branches: 8 within 25 m of the spawn (the first 2 the digging-stick blanks), the rest under groves. */
  private branches(): void {
    const T = this.T;
    const rng = this.rng;
    const n = Math.max(0, Math.round(T.dryBranches));
    const nearN = Math.min(n, Math.max(0, Math.round(T.branchesNearSpawn)));
    const blanks = Math.min(nearN, Math.max(0, Math.round(T.stickBlanks)));
    for (let k = 0; k < n; k++) {
      const near = k < nearN;
      const blank = k < blanks;
      const length = blank ? rng.range(T.blankLenM[0], T.blankLenM[1]) : rng.range(T.branchLenM[0], T.branchLenM[1]);
      const diam = blank ? T.blankDiamM : rng.range(T.branchDiamM[0], T.branchDiamM[1]);
      const r = prismRForRoundDiam(diam, PHYSICS_TUNING.cylinderFacets);
      const yaw = rng.range(0, 2 * Math.PI);
      const centre = near
        ? (): XZ => polar(this.spawn, rng.range(T.nearSpawnMinM, T.branchNearSpawnM), rng.range(0, 2 * Math.PI))
        : (): XZ => {
            return this.groveSpot(this.drawGrove());
          };
      this.layProp(stickPrism(length, r), length, r, yaw, centre, (p, q) =>
        spawnStick(this.w, { p, q, length, r, material: FACTORY_TUNING.materials.stick, generated: true }),
      );
    }
  }

  /**
   * 5 dry logs (§6.7): 3 at grove edges, then one of 110-130 kg within 30 m of the spawn (draggable), then one of
   * ≈ 300 kg lying beside a route leg, along it.
   */
  private logs(): void {
    const T = this.T;
    const rng = this.rng;
    const n = Math.max(0, Math.round(T.dryLogs));
    const sides = PHYSICS_TUNING.logFacets;
    const density = MATERIALS[FACTORY_TUNING.materials.log].density;
    const special = Math.min(n, 2);
    for (let k = 0; k < n; k++) {
      const kind = k < n - special ? 'edge' : k === n - special ? 'near' : 'route';
      let length: number;
      let r: number;
      let mass: number | undefined;
      if (kind === 'edge') {
        length = rng.range(T.logLenM[0], T.logLenM[1]);
        r = prismRForRoundDiam(rng.range(T.logDiamM[0], T.logDiamM[1]), sides);
      } else {
        mass = kind === 'near' ? rng.range(T.logNearSpawnKg[0], T.logNearSpawnKg[1]) : T.routeLogKg;
        length = rng.range(...this.logLengthFor(mass, density));
        r = prismRForMass(mass, length, density, sides);
      }
      if (kind === 'route') {
        const leg = Math.floor(rng.next() * this.route.length) % this.route.length;
        const side = rng.next() < 0.5 ? -1 : 1;
        const a = this.route[leg];
        const b = this.route[(leg + 1) % this.route.length];
        const dir = unit({ x: b.x - a.x, z: b.z - a.z });
        const yaw = Math.atan2(-dir.z, dir.x);
        this.layProp(
          logPrism(length, r),
          length,
          r,
          yaw,
          () => {
            const m = lerpXZ(a, b, rng.range(0.3, 0.7));
            return { x: m.x - side * dir.z * T.routeLogOffsetM, z: m.z + side * dir.x * T.routeLogOffsetM };
          },
          (p, q) => spawnLog(this.w, { p, q, length, mass, generated: true }),
        );
        continue;
      }
      const yaw = rng.range(0, 2 * Math.PI);
      const centre = kind === 'near' ? (): XZ => polar(this.spawn, rng.range(T.nearSpawnMinM, T.logNearSpawnM), rng.range(0, 2 * Math.PI)) : (): XZ => this.groveEdgePoint();
      this.layProp(logPrism(length, r), length, r, yaw, centre, (p, q) =>
        spawnLog(this.w, mass === undefined ? { p, q, length, r, generated: true } : { p, q, length, mass, generated: true }),
      );
    }
  }

  /** The lengths (within logLenM) at which a round log of `mass` has a diameter within logDiamM. */
  private logLengthFor(mass: number, density: number): [number, number] {
    const T = this.T;
    const at = (d: number): number => mass / (density * Math.PI * (d / 2) * (d / 2));
    const lo = Math.max(T.logLenM[0], at(T.logDiamM[1]));
    const hi = Math.min(T.logLenM[1], at(T.logDiamM[0]));
    return lo <= hi ? [lo, hi] : [T.logLenM[0], T.logLenM[1]];
  }

  /** The damp grove (D-24, drawn): 20 rotten branches and 2 rotten logs under it. */
  private rottenWood(): void {
    const T = this.T;
    const rng = this.rng;
    if (this.groves.length === 0) return;
    const gr = this.groves[Math.floor(rng.next() * this.groves.length) % this.groves.length];
    const centre = (): XZ => this.groveSpot(gr);
    const B = T.rottenBranchSize;
    const rb = prismRForRoundDiam(B.diamM, PHYSICS_TUNING.cylinderFacets);
    for (let k = 0; k < Math.max(0, Math.round(T.rottenBranches)); k++) {
      this.layProp(stickPrism(B.lengthM, rb), B.lengthM, rb, rng.range(0, 2 * Math.PI), centre, (p, q) =>
        spawnStick(this.w, { p, q, length: B.lengthM, r: rb, material: 'rottenWood', generated: true }),
      );
    }
    const L = T.rottenLogSize;
    const rl = prismRForRoundDiam(L.diamM, PHYSICS_TUNING.logFacets);
    for (let k = 0; k < Math.max(0, Math.round(T.rottenLogs)); k++) {
      this.layProp(logPrism(L.lengthM, rl), L.lengthM, rl, rng.range(0, 2 * Math.PI), centre, (p, q) =>
        spawnLog(this.w, { p, q, length: L.lengthM, r: rl, material: 'rottenWood', generated: true }),
      );
    }
  }

  /** 30 grass bundles in the meadows (cover ≥ grassMinCover): each in a drawn meadow cell. */
  private grass(): void {
    const T = this.T;
    const rng = this.rng;
    const cover = this.w.cover;
    const meadows: number[] = [];
    for (let c = 0; c < cover.cellsX * cover.cellsZ; c++) {
      const m = cover.cellCentre(c);
      if (cover.at(m.x, m.z) >= T.grassMinCover) meadows.push(c);
    }
    const cell = cover.cellM;
    for (let k = 0; k < Math.max(0, Math.round(T.grassBundles)); k++) {
      const mass = rng.range(T.grassKg[0], T.grassKg[1]);
      const shape = grassBox(mass, FACTORY_TUNING.materials.grass);
      const r = Math.hypot(shape.hx, shape.hz);
      const p = this.pick(
        () => {
          if (meadows.length === 0) return { x: rng.range(-this.half, this.half), z: rng.range(-this.half, this.half) };
          const m = cover.cellCentre(meadows[Math.floor(rng.next() * meadows.length) % meadows.length]);
          return { x: m.x + rng.range(-cell / 2, cell / 2), z: m.z + rng.range(-cell / 2, cell / 2) };
        },
        (q) => this.looseViolations(circle(q, r)) + (this.w.cover.at(q.x, q.z) < T.grassMinCover ? 1 : 0),
      );
      this.loose.push(circle(p, r));
      if (!this.onTerrain(p)) continue;
      const y = groundRestY(this.w, p.x, p.z, shape);
      spawnGrass(this.w, { p: { x: p.x, y, z: p.z }, mass, generated: true });
    }
  }

  /**
   * Lays a prism lying along its axis (yaw about up from +x) at a drawn centre, tilted to the ground's slope and set at
   * rest on it, and records its footprint. `make` gets the pose (it's skipped off a small world's terrain).
   */
  private layProp(shape: Shape, length: number, r: number, yaw: number, centre: () => XZ, make: (p: V3, q: Quat) => number): void {
    const dir = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const fp = (c: XZ): Footprint => ({
      a: { x: c.x - (dir.x * length) / 2, z: c.z - (dir.z * length) / 2 },
      b: { x: c.x + (dir.x * length) / 2, z: c.z + (dir.z * length) / 2 },
      r,
    });
    const c = this.pick(centre, (q) => this.looseViolations(fp(q)));
    this.loose.push(fp(c));
    if (!this.onTerrain(c, length / 2 + 0.5)) return;
    const q = mulQuat(this.tiltAt(c, length / 2), mulQuat(yawQuat(yaw), LYING_ALONG_X));
    make({ x: c.x, y: groundRestY(this.w, c.x, c.z, shape, q), z: c.z }, q);
  }

  /** The rotation taking up to the ground's mean normal over ±reach around c (central differences of the heights). */
  private tiltAt(c: XZ, reach: number): Quat {
    const t = this.w.terrain;
    const s = clamp(reach, 0.25, 2.5);
    const dx = (t.originalHeightAt(c.x + s, c.z) - t.originalHeightAt(c.x - s, c.z)) / (2 * s);
    const dz = (t.originalHeightAt(c.x, c.z + s) - t.originalHeightAt(c.x, c.z - s)) / (2 * s);
    const n = Math.hypot(dx, 1, dz);
    // Shortest arc from (0, 1, 0) to the normal (−dx, 1, −dz)/n: (up × n, 1 + up·n), normalised.
    const qx = -dz / n;
    const qz = dx / n;
    const qw = 1 + 1 / n;
    const m = Math.hypot(qx, qz, qw);
    return { x: qx / m, y: 0, z: qz / m, w: qw / m };
  }

  /** The rules every loose thing keeps: on gentle ground inside the rim, off trunks, the spawn point and the cache. */
  private looseViolations(f: Footprint): number {
    const T = this.T;
    const mid = lerpXZ(f.a, f.b, 0.5);
    let s = 0;
    for (const p of f.a === f.b ? [mid] : [f.a, mid, f.b]) s += this.groundViolations(p, f.r);
    for (const t of this.trees) if (capDist(t.p, f) - t.d / 2 < T.trunkClearM) s += HARD;
    for (const x of this.fixed) if (capCapDist(x, f) < T.trunkClearM) s += HARD;
    if (capDist(this.spawn, f) < T.nearSpawnMinM) s += HARD;
    if (capDist(this.cache, f) < T.cacheClearM) s += HARD;
    for (const o of this.loose) if (capCapDist(o, f) < T.looseGapM) s += 1;
    return s;
  }

  /** On the terrain, inside the rim, on gentle ground, off the ledge. */
  private groundViolations(p: XZ, r: number): number {
    const T = this.T;
    let s = 0;
    if (!this.onTerrain(p, r + 0.5)) s += HARD;
    if (!this.insideRim(p, r + 1)) s += HARD;
    if (this.slopeDeg(p) > T.maxSlopeDeg) s += HARD;
    if (this.inLedgeZone(p, r)) s += HARD;
    return s;
  }

  // -------------------------------------------------------------------------
  // Ape homes, snags, the starter cache, the walls
  // -------------------------------------------------------------------------

  /**
   * The 3 ape homes (§6.7): A, B and C at apeHomeDistM from the spawn, bearings ≥ 100° apart, each where that circle
   * meets a drawn grove's ring (homeEdgeGapM outside it: a grove edge facing open ground); then each home's 3-waypoint
   * loop of radius homeLoopR on walkable ground.
   */
  private apeHomes(): void {
    const T = this.T;
    const rng = this.rng;
    const n = Math.min(Math.max(0, Math.round(T.apeHomes)), T.apeHomeDistM.length);
    const sep = T.apeHomeMinSepDeg * DEG;
    const tries = this.tries();
    const bearingOf = (p: XZ): number => Math.atan2(p.x - this.spawn.x, p.z - this.spawn.z);
    const homes: ({ home: XZ; loop: XZ[] } | null)[] = new Array<{ home: XZ; loop: XZ[] } | null>(n).fill(null);
    // Drawn farthest first (C, B, A): the farther the home, the less of the valley floor its loop fits on.
    const order = Array.from({ length: n }, (_, h) => h).sort((a, b) => T.apeHomeDistM[b] - T.apeHomeDistM[a] || a - b);
    // The last home's whole-degree bearings whose spot breaks no hard rule: the home before it leaves one of them open.
    const lastSpots: number[] = [];
    if (n >= 2) {
      const rl = T.apeHomeDistM[order[n - 1]];
      for (let d = 0; d < 360; d++) if (this.spotViolations(polar(this.spawn, rl, d * DEG)) < HARD) lastSpots.push(d * DEG);
    }
    order.forEach((h, k) => {
      const rh = T.apeHomeDistM[h];
      const placed = homes.filter((x): x is { home: XZ; loop: XZ[] } => x !== null).map((x) => bearingOf(x.home));
      // Bearings that keep the separation and leave room for the homes still to come.
      const bearingOk = (b: number): boolean => placed.every((bo) => Math.abs(angleDelta(b, bo)) >= sep - 1e-12) && roomForBearings([...placed, b], n - k - 1, sep);
      // The whole-degree ones whose spot breaks no hard rule (no draws): where the open-bearing tries go.
      const open: number[] = [];
      for (let d = 0; d < 360; d++) {
        const b = d * DEG;
        if (bearingOk(b) && this.spotViolations(polar(this.spawn, rh, b)) < HARD) open.push(b);
      }
      let onEdge = false;
      const home = this.pick(
        (i) => {
          // Half the tries where the circle meets a grove's ring, the rest on an open bearing.
          onEdge = false;
          if (i < tries / 2 && this.groves.length > 0) {
            const gr = this.drawGrove();
            const circles = this.groveCircles(gr);
            const c = circles[Math.floor(rng.next() * circles.length) % circles.length];
            const side = rng.next() < 0.5 ? 0 : 1;
            const pts = circleMeet(this.spawn, rh, c, gr.r + T.homeEdgeGapM);
            if (pts && bearingOk(bearingOf(pts[side]))) {
              onEdge = true;
              return pts[side];
            }
          }
          const b = open.length > 0 ? open[Math.floor(rng.next() * open.length) % open.length] : rng.range(0, 2 * Math.PI);
          return polar(this.spawn, rh, b);
        },
        (q) => {
          let s = this.spotViolations(q);
          const bq = bearingOf(q);
          for (const bo of placed) if (Math.abs(angleDelta(bq, bo)) < sep - 1e-12) s += HARD;
          // Room left for the homes still to come, each ≥ apeHomeMinSepDeg from every other.
          if (!roomForBearings([...placed, bq], n - k - 1, sep)) s += HARD;
          if (k === n - 2 && !lastSpots.some((b) => [...placed, bq].every((bo) => Math.abs(angleDelta(b, bo)) >= sep - 1e-12))) s += HARD;
          // (The loop probe is the costly rule: a spot already out on a hard rule needn't pay for it.)
          if (s < HARD && !this.loopFits(q)) s += HARD;
          if (!onEdge) s += 1;
          return s;
        },
      );
      const loop = this.pick(
        () => {
          const a = rng.range(0, 2 * Math.PI);
          return [0, 1, 2].map((j) => polar(home, T.homeLoopR, a + (j * 2 * Math.PI) / 3));
        },
        (pts) => {
          let s = 0;
          for (const p of pts) s += this.spotViolations(p);
          const ring = [home, ...pts, pts[0]];
          for (let i = 0; i + 1 < ring.length; i++) if (this.legBad(ring[i], ring[i + 1])) s += 1;
          return s;
        },
      );
      homes[h] = { home, loop };
    });
    this.homes = homes as { home: XZ; loop: XZ[] }[];
  }

  /** A home's 3-waypoint loop of radius homeLoopR fits on the valley floor at some start angle (12 tried; no draws). */
  private loopFits(home: XZ): boolean {
    for (let i = 0; i < 12; i++) {
      const a = (i * 2 * Math.PI) / 12;
      if ([0, 1, 2].every((k) => this.spotViolations(polar(home, this.T.homeLoopR, a + (k * 2 * Math.PI) / 3)) === 0)) return true;
    }
    return false;
  }

  /** A spot a creature stands at (a home, a loop waypoint): walkable, clear of trunks, rooted and loose things. */
  private spotViolations(p: XZ): number {
    const T = this.T;
    let s = 0;
    if (!this.onTerrain(p, 1) || !this.insideRim(p, T.homeLoopRimMarginM)) s += HARD;
    if (this.slopeDeg(p) > T.maxSlopeDeg || this.inLedgeZone(p, T.ledgeKeepOutM)) s += HARD;
    for (const t of this.trees) if (dist(t.p, p) - t.d / 2 < T.homeClearM) s += HARD;
    for (const f of this.fixed) if (capDist(p, f) < T.homeClearM) s += HARD;
    for (const f of this.loose) if (capDist(p, f) < T.homeClearM) s += 1;
    return s;
  }

  /** 4 snags (§6.7): one at the edge of each ape home, one at the foot of the ledge, lying along it. */
  private snags(): void {
    const T = this.T;
    const rng = this.rng;
    const n = Math.max(0, Math.round(T.snags));
    const L = this.ledge;
    for (let k = 0; k < n; k++) {
      const mass = rng.range(T.snagKg[0], T.snagKg[1]);
      const length = rng.range(T.snagLenM[0], T.snagLenM[1]);
      const r = prismRForMass(mass, length, MATERIALS[FACTORY_TUNING.materials.log].density, PHYSICS_TUNING.logFacets);
      const atHome = k < this.homes.length;
      const home = atHome ? this.homes[k] : null;
      let yaw: number;
      let centre: () => XZ;
      if (home) {
        yaw = rng.range(0, 2 * Math.PI);
        centre = () => polar(home.home, rng.range(T.snagHomeDistM[0], T.snagHomeDistM[1]), rng.range(0, 2 * Math.PI));
      } else {
        yaw = Math.atan2(-L.tz, L.tx);
        const d = T.ledgeTransitionM + T.snagLedgeOffsetM;
        centre = () => {
          const u = rng.range(-T.snagLedgeSpreadM, T.snagLedgeSpreadM);
          return { x: L.cx + d * L.nx + u * L.tx, z: L.cz + d * L.nz + u * L.tz };
        };
      }
      const shape = logPrism(length, r);
      const dir = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const fp = (c: XZ): Footprint => ({
        a: { x: c.x - (dir.x * length) / 2, z: c.z - (dir.z * length) / 2 },
        b: { x: c.x + (dir.x * length) / 2, z: c.z + (dir.z * length) / 2 },
        r,
      });
      const c = this.pick(centre, (q) => {
        const f = fp(q);
        // The ledge's snag lies in its hollow by design: only the hollow's own rule is waived for it.
        let s = home ? this.looseViolations(f) : this.looseViolationsInHollow(f);
        for (const h of this.homes) for (const p of [h.home, ...h.loop]) if (capDist(p, f) < T.homeClearM) s += 1;
        return s;
      });
      this.loose.push(fp(c));
      if (!this.onTerrain(c, length / 2 + 0.5)) continue;
      const q = mulQuat(this.tiltAt(c, length / 2), mulQuat(yawQuat(yaw), LYING_ALONG_X));
      spawnLog(this.w, { p: { x: c.x, y: groundRestY(this.w, c.x, c.z, shape, q), z: c.z }, q, length, mass, snags: T.snagPoints, generated: true });
    }
  }

  /** looseViolations without the ledge zone (a thing meant to lie in the hollow under the ledge). */
  private looseViolationsInHollow(f: Footprint): number {
    const T = this.T;
    let s = 0;
    for (const p of [f.a, lerpXZ(f.a, f.b, 0.5), f.b]) {
      if (!this.onTerrain(p, f.r + 0.5) || !this.insideRim(p, f.r + 1) || this.slopeDeg(p) > T.maxSlopeDeg) s += HARD;
      if (this.ledgeDepth(p.x, p.z) < T.ledgeDropM * 0.5) s += 1;
    }
    for (const t of this.trees) if (capDist(t.p, f) - t.d / 2 < T.trunkClearM) s += HARD;
    for (const x of this.fixed) if (capCapDist(x, f) < T.trunkClearM) s += HARD;
    for (const o of this.loose) if (capCapDist(o, f) < T.looseGapM) s += 1;
    return s;
  }

  /**
   * The starter cache at starterCacheAt beside the spawn (§6.7, SPEC:247): the stone axe (FACTORY_TUNING.starterAxe),
   * the digging stick (dry, pointed) and an 8 m vine coil, with no credit.
   */
  private starterCache(): void {
    const T = this.T;
    const w = this.w;
    const at = this.cache;
    if (!this.onTerrain(at, 2)) return;
    spawnStarterAxe(w, { x: at.x, y: w.terrain.heightAt(at.x, at.z), z: at.z }, { generated: true });
    const D = T.diggingStick;
    const r = prismRForRoundDiam(D.diamM, PHYSICS_TUNING.cylinderFacets);
    const sp = { x: at.x + T.starterStickOffset[0], z: at.z + T.starterStickOffset[1] };
    const q = mulQuat(this.tiltAt(sp, D.lengthM / 2), LYING_ALONG_X);
    // The point is tapered inside the prism, so the prism's rest height is the stick's.
    const y = groundRestY(w, sp.x, sp.z, stickPrism(D.lengthM, r), q);
    spawnStick(w, { p: { x: sp.x, y, z: sp.z }, q, length: D.lengthM, r, sharp: { end: 1, s: D.sharpness }, generated: true });
    const coil = ropeCoilShape(T.starterCoilM);
    const cp = { x: at.x + T.starterCoilOffset[0], z: at.z + T.starterCoilOffset[1] };
    const cy = groundRestY(w, cp.x, cp.z, coil);
    spawnRopeCoil(w, { at: { x: cp.x, y: cy - coil.halfHeight, z: cp.z }, material: 'vine', lengthM: T.starterCoilM, generated: true });
  }

  /**
   * Four fixed stone walls just outside the terrain's edges, from below the edge up boundaryWallAboveM above its
   * highest point (§6.7: "four fixed boxes at ±100 m behind the rim top catch anything flung over it"). Not in §6.7's
   * order: made last, so they move no other id.
   */
  private boundaryWalls(): void {
    const T = this.T;
    const t = this.w.terrain;
    const th = T.boundaryWallThickM;
    if (!(th > 0)) return;
    const x0 = t.minX;
    const x1 = t.minX + t.tilesX * t.tileSize;
    const z0 = t.minZ;
    const z1 = t.minZ + t.tilesZ * t.tileSize;
    const edge = (sample: (s: number) => number, from: number, to: number): [number, number] => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let s = from; s <= to + 1e-9; s += t.spacing) {
        const h = sample(s);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      return [lo - T.boundaryWallBelowM, hi + T.boundaryWallAboveM];
    };
    const walls: { p: XZ; size: [number, number]; ys: [number, number] }[] = [
      { p: { x: x0 - th / 2, z: (z0 + z1) / 2 }, size: [th, z1 - z0 + 2 * th], ys: edge((s) => t.originalHeightAt(x0, s), z0, z1) },
      { p: { x: x1 + th / 2, z: (z0 + z1) / 2 }, size: [th, z1 - z0 + 2 * th], ys: edge((s) => t.originalHeightAt(x1, s), z0, z1) },
      { p: { x: (x0 + x1) / 2, z: z0 - th / 2 }, size: [x1 - x0, th], ys: edge((s) => t.originalHeightAt(s, z0), x0, x1) },
      { p: { x: (x0 + x1) / 2, z: z1 + th / 2 }, size: [x1 - x0, th], ys: edge((s) => t.originalHeightAt(s, z1), x0, x1) },
    ];
    for (const wl of walls) {
      const [lo, hi] = wl.ys;
      spawnBox(this.w, {
        p: { x: wl.p.x, y: (lo + hi) / 2, z: wl.p.z },
        size: [wl.size[0], hi - lo, wl.size[1]],
        material: 'stone',
        state: 'fixed',
        look: 'rock',
        generated: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rejection sampling
  // -------------------------------------------------------------------------

  /** Tries per item (CLEARING_TUNING.rejectionTries, at least 1). */
  private tries(): number {
    return Math.max(1, Math.round(this.T.rejectionTries));
  }

  /**
   * Up to rejectionTries proposals: the first with no violation, else the one with the lowest score (the earliest on a
   * tie). Pure in the gen stream: the proposals draw from it, the scores never do.
   */
  private pick<C>(propose: (i: number) => C, score: (c: C) => number): C {
    const tries = this.tries();
    let best: C | undefined;
    let bestScore = Infinity;
    for (let i = 0; i < tries; i++) {
      const c = propose(i);
      const s = score(c);
      if (s === 0) return c;
      if (s < bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best as C;
  }
}

// ---------------------------------------------------------------------------
// Geometry on the ground plane and small math
// ---------------------------------------------------------------------------

function smoothstep(a: number, b: number, x: number): number {
  if (!(b > a)) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** b − a wrapped to (−π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** The point `r` from `c` on bearing `yaw` (the fighters' convention: (sin yaw, cos yaw)). */
function polar(c: XZ, r: number, yaw: number): XZ {
  return { x: c.x + r * Math.sin(yaw), z: c.z + r * Math.cos(yaw) };
}

function inDisk(rng: Rng, c: XZ, r: number): XZ {
  return polar(c, r * Math.sqrt(rng.next()), rng.range(0, 2 * Math.PI));
}

function dist(a: XZ, b: XZ): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function lerpXZ(a: XZ, b: XZ, t: number): XZ {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function unit(v: XZ): XZ {
  const n = Math.hypot(v.x, v.z);
  return n > 0 ? { x: v.x / n, z: v.z / n } : { x: 1, z: 0 };
}

function segClosest(p: XZ, a: XZ, b: XZ): XZ {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const L2 = vx * vx + vz * vz;
  const t = L2 > 0 ? clamp(((p.x - a.x) * vx + (p.z - a.z) * vz) / L2, 0, 1) : 0;
  return { x: a.x + t * vx, z: a.z + t * vz };
}

function segDist(p: XZ, a: XZ, b: XZ): number {
  return dist(p, segClosest(p, a, b));
}

/** Distance from a point to a footprint's surface (negative inside). */
function capDist(p: XZ, f: Footprint): number {
  return segDist(p, f.a, f.b) - f.r;
}

/** Distance between two footprints' surfaces (negative when they overlap). */
function capCapDist(f: Footprint, g: Footprint): number {
  return segSegDist(f.a, f.b, g.a, g.b) - f.r - g.r;
}

function segSegDist(a: XZ, b: XZ, c: XZ, d: XZ): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}

function segsCross(a: XZ, b: XZ, c: XZ, d: XZ): boolean {
  const o = (p: XZ, q: XZ, r: XZ): number => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function circle(p: XZ, r: number): Footprint {
  return { a: p, b: p, r };
}

/** Where the ray from `o` along (dx, dz) meets segment a-b: its distance along the ray and the segment's parameter. */
function raySeg(o: XZ, dx: number, dz: number, a: XZ, b: XZ): { t: number; s: number } | null {
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a.x - o.x) * ez - (a.z - o.z) * ex) / den;
  const s = ((a.x - o.x) * dz - (a.z - o.z) * dx) / den;
  return t >= 0 && s >= 0 && s <= 1 ? { t, s } : null;
}

/** The two points where circles (c1, r1) and (c2, r2) meet (ordered by the side of c1→c2), or null. */
function circleMeet(c1: XZ, r1: number, c2: XZ, r2: number): [XZ, XZ] | null {
  const d = dist(c1, c2);
  if (!(d > 0) || d > r1 + r2 || d < Math.abs(r1 - r2)) return null;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2.x - c1.x) / d;
  const uz = (c2.z - c1.z) / d;
  const mx = c1.x + a * ux;
  const mz = c1.z + a * uz;
  return [
    { x: mx - h * uz, z: mz + h * ux },
    { x: mx + h * uz, z: mz - h * ux },
  ];
}

/** The index of the last positive count, or −1. */
function lastPositive(counts: readonly number[]): number {
  for (let i = counts.length - 1; i >= 0; i--) if (counts[i] > 0) return i;
  return -1;
}

/**
 * Whether `m` more bearings fit among `bearings` (rad), every one at least `sep` from every other: a gap of G between
 * neighbouring bearings holds floor(G / sep) − 1 more.
 */
function roomForBearings(bearings: readonly number[], m: number, sep: number): boolean {
  if (m <= 0) return true;
  if (!(sep > 0)) return true;
  const TAU = 2 * Math.PI;
  if (bearings.length === 0) return m * sep <= TAU + 1e-12;
  const b = bearings.map((x) => ((x % TAU) + TAU) % TAU).sort((x, y) => x - y);
  let room = 0;
  for (let i = 0; i < b.length; i++) {
    const gap = i + 1 < b.length ? b[i + 1] - b[i] : b[0] + TAU - b[i];
    room += Math.max(0, Math.floor(gap / sep + 1e-12) - 1);
  }
  return room >= m;
}

/** The farthest horizontal reach of a hull's points from its origin. */
function horizontalReach(s: Shape): number {
  if (s.kind !== 'hull') throw new Error('clearing: horizontalReach takes a hull');
  let r = 0;
  for (let i = 0; i + 2 < s.points.length; i += 3) r = Math.max(r, Math.hypot(s.points[i], s.points[i + 2]));
  return r;
}

/** Fisher-Yates with the gen stream (a new array). */
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1)) % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** A rotation by `yaw` about up (+x turns toward −z: the prism's axis lies along (cos yaw, 0, −sin yaw)). */
function yawQuat(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** a ⊗ b: rotate by b, then by a. */
function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
