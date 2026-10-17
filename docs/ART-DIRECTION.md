# Art direction: painterly storybook

**Status: binding.** The project owner set this direction on 2026-10-17 from four reference images. It replaces these
lines of docs/SPEC.md "Art and audio direction → Look":

- "The Wild should look like DungeonStyle grown into a world: chunky, faceted low-poly shapes";
- "**Bodies:** DungeonStyle's blocky, faceted fighters and creatures";
- "**Nature:** flat-shaded trees, rocks and terrain in the same faceted style".

Everything else in that section stays binding: warm sun and long shadows, mist in valleys, rulers readable from far
away, wounds that show. So does the **readability table** in docs/SPEC.md (rule 3). The new look must never hide a
state a rule depends on.

The owner's brief, verbatim:

> Stylized 3D fantasy environment with a painterly storybook aesthetic. Chunky, exaggerated architecture; sculpted
> stone and timber with softened edges; hand-painted-looking textures with broad, readable details. Rich warm colors
> balanced with cool blues, golden sunlight, soft shadows, and atmospheric depth. Whimsical, inviting, and polished,
> with strong silhouettes and handcrafted imperfections.

## The four references (described, since the images aren't in the repo)

1. **Autumn ruin meadow.**
   - A broken grey stone arch on a low wall. The blocks are chunky, with rounded, softened edges and slightly irregular
     outlines. Small niches hold a scroll and a candle.
   - The stone is a cool grey-lavender (#8d8a95 lit, #5e5b6e in shade), with ochre-green moss patches on the tops.
   - Flat stone steps lead up through knee-high grass. The grass is bright orange-gold (#e8902a to #f5b44a), and its
     shaded blades go deep rust (#8a3d12).
   - White daisies dot the grass, and cobalt-blue four-petal flowers (#2f5fe0) fill the foreground.
   - Sky: saturated cerulean (#1f74d8 at the zenith, #6fb2f0 lower) with big hand-painted white cumulus clouds. Their
     edges are soft brushy strokes, their undersides slightly blue-grey.
   - The far hillside is a soft orange-red autumn forest, lighter and hazier with distance.
   - Low golden sun from the left: long soft dappled shadows, warm rim light on grass tips, leaves drifting in the air.
2. **Desert temple courtyard.**
   - Terracotta domes and walls (#c8743d) with chunky beveled bricks.
   - Turquoise and teal painted stone trim (#2aa6a0, #1d6f7a).
   - A carved stone face spouts a stylized waterfall: cyan, with white foam bands, into a round pool.
   - Palm trees with chunky curved trunks and broad leaf cards. Ferns.
   - Warm sandstone floor tiles with soft edges, and blue sky with soft clouds.
3. **Autumn forest ruins.**
   - Cobblestone walls of rounded, pillow-like grey stones (#b7b4bb), with pale fluted columns.
   - Trees with chunky, slightly twisted trunks, and canopies built from many clustered leaf puffs (each puff a cluster
     of leaf cards) in orange (#e07a2a), red (#c4442e), gold (#f2b84b) and a few yellow-green (#a9c443).
   - A wooden signpost with chunky plank arrows, a hanging lantern, a barrel and a rough stick fence.
   - The background trees fade to lighter, desaturated tones (aerial perspective).
   - Orange grass, ferns, and small rounded pebbles on a dirt path.
4. **Desert oasis.**
   - Sandstone arches and broken columns: chunky, beveled, with carved bands, vines climbing them, and fallen blocks.
   - Pottery jars, purple-grey wooden fences.
   - A deep-blue lagoon (#1f4fa0 to #3f8fd0) with lily pads.
   - Distant mesas in hazy peach (#e3b48a), palm groves, and a bright sky with painted clouds.

## Common rules (what makes it look like this)

**Shapes**
- Chunky and exaggerated, with **softened edges**: bevel every box-like thing (a radius of 4-10 % of its size).
- No razor-sharp faceted look, but no smooth realism either: sculpted, slightly irregular forms. Every stone, plank and
  block is a little different (handcrafted imperfection, seeded per object id so it is stable).
- Strong silhouettes that read in grey-scale.

**Surfaces**
- Hand-painted look, made procedurally in the shader:
  - broad colour patches in world space (low-frequency noise);
  - a few stroke-like streaks along the form;
  - lighter painted edges on convex rims;
  - darker crevices and contact shadows (ambient occlusion).
- No fine high-frequency noise, no photo textures.
- Detail is broad and readable at game distance.

**Light**
- A warm golden sun (#ffd29a, fairly strong) at a low-to-mid elevation (about 25-40°), casting **soft but clearly
  shaped shadows**.
- Shadows are never black: they are tinted cool blue-violet (#4a5a9a at about 35-45 % strength over the lit colour).
- Sky fill from above is blue (#8fc3ff). There is a warm bounce from the ground.
- Warm rim and back light on foliage and characters.
- Gentle bloom on the brightest highlights.

**Colour**
- Rich, warm and saturated: orange, gold, terracotta and warm greens, balanced with cool blues in the sky, the
  shadows, water, flowers and some accents.
- Avoid muddy browns and pure greys: greys lean lavender or warm.
- Keep a value structure: dark foreground accents, a mid-value play space, light hazy distance.

**Atmosphere**
- Distance haze that shifts toward a warm peach/orange near the sun's side and a soft blue on the far side.
- Distant layers are lighter and less saturated.
- Light dust motes and drifting leaves in the air.

**Mood**
- Whimsical, inviting, polished: a storybook, not grimdark.
- Gore is still the setting's (off, stylised, full), drawn in the same painted, chunky style.

## Applying it to The Wild (Milestone 1's Clearing and creatures)

**The look is presentation only (rule 6).** Nothing in the client may change an outcome.

**Rule 3 also binds it.** Anything that looks solid and walkable must be solid in the sim.
- Decorative, non-solid things are fine inside the play space: grass, flowers, small ferns, falling leaves, dust.
- Solid-looking architecture (ruins, walls, arches) may only be built in two ways:
  - (a) as sim entities, which is a world-content change the owner must approve first;
  - (b) as unreachable backdrop beyond the valley rim.
- Today only (b) is allowed.

**Each part of the scene:**

- **Sky:**
  - A gradient dome (deep cerulean zenith to a pale horizon, warmer near the sun).
  - Hand-painted cumulus clouds: soft brushy edges, slight blue-grey bellies, slow drift.
  - A soft sun glow.
- **Valley rim and cliffs:** sculpted, layered stone:
  - horizontal strata bands;
  - softened ledges;
  - warm sandstone and lavender-grey;
  - moss and grass caps on top;
  - darker crevices.

  The rim faces must never render near-black. The 6 m ledge is the same stone.
- **Beyond the rim (backdrop, unreachable):**
  - Rolling hills covered with clustered autumn trees.
  - A few chunky ruined stone arches and walls on the skyline.
  - Far mesas or mountains fading into haze.

  The boundary walls the sim uses must be invisible.
- **Ground:**
  - Painted terrain colour from the ground-cover grid: golden-orange dry meadow, warm green patches, ochre bare earth.
    Dug earth is rich brown with clumps.
  - Grass:
    - stylized blades with a dark base and bright warm tips;
    - drawn as clumps, with wind sway;
    - dry grass is visibly paler and straw-gold, and green grass greener (rule 3: dry vs wet/green must read);
    - white daisies and blue flowers are sprinkled in.
- **Trees:**
  - Trunks: chunky, slightly curved and twisted, with a root flare and painted bark with vertical strokes.
  - Canopies: many clustered leaf puffs, each puff made of leaf cards or lumpy blobs.
  - Mixed autumn palette per tree (orange, red, gold, some yellow-green), varied by tree id. Gentle sway.
  - Felled trunks, stumps and chop notches stay clearly visible: the notch shows pale fresh wood.
  - Saplings are smaller, brighter, bendy.
  - Vines are leafy and hang.
- **Rocks, stones, boulders, flint:**
  - Rounded, pillow-like, chunky, lavender-grey or warm sandstone, with moss on top.
  - Flint must read as flint: dark blue-grey with glassy pale chipped edges.
- **Wood props:**
  - Logs: thick, with end-grain rings, a bark stripe pattern and softened ends.
  - Sticks and branches: knobbly.
  - **Sharpened points must read as sharp:** a pale carved taper.
  - **Wood states must read:**
    - green: fresh, lighter bark with a green tint;
    - dry: paler, greyer, cracked;
    - rotten: dark, crumbly, with moss and fungus spots.
- **Rope and vines:**
  - Rope: twisted fibre bands, warm hemp.
  - Vine: green, leafy.
  - Sinew: pale, waxy.
  - **Taut** rope is straight and thin; **slack** rope sags. Fraying shows fuzzy fibres.
- **Tools:** the stone axe is a chunky flint head lashed to a curved handle with visible wraps. The digging stick is
  knobbly, with a fire-hardened dark point.
- **Characters** (all drawn on the sim's rig; the visual volumes stay within about 15 % of the sim's bone zones, so a
  hit that looks like it lands does land):
  - **The player:** a storybook adventurer.
    - Chunky, slightly exaggerated proportions: bigger hands and feet, sturdy torso, rounded shapes, softened edges.
    - A teal tunic with a leather belt and pouches, dark trousers, wrapped forearms, brown boots, a short scarf or
      collar.
    - A simple expressive face (eyes, brows, nose) and a chunky hair mass.
    - Must read in silhouette from the follow camera.
  - **The ape (mid-size):**
    - Heavy rounded shoulders, long arms with big knuckled hands, short legs.
    - Russet-brown fur with lighter tan face, chest and palms. Fur is shown as chunky tufts and clumps, not strands.
    - Expressive brow ridge.
  - **The giant ape (ruler, scale 5.5):**
    - Same language, with a darker coat: blue-black with a silver-grey back.
    - Huge forearms and knuckles, which matter for the knuckle-charge pose.
    - Readable from far away: the head and back rise above the canopy.
    - Every persistent wound shows as scars, cuts or a missing eye (SPEC "Wounds show").
- **Effects:**
  - Blood and gibs: painted, chunky, stylised.
  - Dust puffs on impacts and footfalls.
  - Falling leaves when trees are hit or fall.
  - Water is not in M1; when it comes (M2) it follows reference 4: deep blue, cyan shallows, white foam bands.

## Performance and quality

- The target is a mid-range laptop (SPEC performance budgets).
- Use instancing for grass, flowers, leaf puffs and stones.
- Keep the number of draw calls bounded.
- Use one shadow map that follows the camera, sized by a quality setting.
- Make every expensive feature switchable: post effects, shadow size, grass density, cloud detail.
- Everything that tunes the look lives in live client tuning tables ("Client › Look", "Client › Sky", …), as CLAUDE.md
  requires. Nothing is saved; it is client presentation.

## Things to avoid

- Photoreal textures and fine noise.
- Pure flat-shaded faceting (the old look).
- Black shadows, grey-on-grey scenes and muddy brown.
- Hard black outlines.
- Neon over-saturation.
- Anything that hides the readability table's states.
