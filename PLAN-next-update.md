# Plan: next update for the driving game

Written 2026-11-15 as a build brief. Nothing in here is built yet.

## Read this first

- **Project:** `C:\Users\ktair\Desktop\Ipad Games\driving-game`. Vite + Babylon.js 9.33.1, plain
  JavaScript, about 9,700 lines in `src/`. Runs as a Home Screen web app on a 2025 iPad (A16),
  hosted on GitHub Pages (pushing `main` deploys it).
- **Stay on Babylon.js.** Do not port to three.js. Both draw through WebGL2, so a port would
  rewrite everything for no visible gain.
- **The owner's rules** (in `~/.claude/CLAUDE.md`) apply: plain short words to the owner, ask
  before building, **never push without a clear "upload" for that push**, never estimate time.
- **Build everything in one go.** The owner has asked for the whole plan to be built in a
  single run, in the order under "Build order" at the end, without stopping for approval
  between parts. This overrides the "one step at a time" rule in the owner's CLAUDE.md for
  this job only. The rules about pushing still apply: build, test and commit locally, then
  ask once at the very end before pushing.
- **Make a local commit after each part** (never pushed), with the memory number in the
  message. If the finished game is too heavy for the iPad, single parts can then be undone
  without losing the rest.
- **Do not make it heavier.** See "Memory budget" below. The game stopped running on the iPad
  once already (commit `5bd31ff` fixed it). This is the hard constraint on every part.

## Memory budget (applies to every part)

The iPad closes the page when graphics memory runs out. Measured on desktop at the Medium
preset (what the iPad gets on Auto): about **650 MB** of textures at start. Treat that as the
ceiling, not a target.

- Measure before and after each part: sum `width * height * 4 * (mipmaps ? 1.33 : 1)` (x6 for
  cube maps, x4 for float textures) over the unique internal textures in `scene.textures`.
  Report both numbers. Set the saved setting `graphics` to `"medium"` first
  (localStorage key `drivingGame.settings.v1`).
- No new texture larger than 1024 px. Prefer `DynamicTexture` drawn in code, 512 px or less.
- No new downloaded models unless a part says so.
- New geometry: merge it per material, or use thin instances. Every new mesh:
  `isPickable = false`, `freezeWorldMatrix()` when static.
- Nothing new may render a second view of the scene on Low or Medium (no mirrors, no
  reflection probes, no SSAO).
- `window.__game` (dev builds only) exposes the game objects; `__game.step(frames)` advances
  time when the window is hidden. The render loop pauses while the pane is hidden, so use
  `step()` before taking screenshots.

## How the code is laid out (what you need for these parts)

- `src/world/layout.js`: all positions. Written in pre-scale coordinates, then multiplied by
  `WORLD_SCALE` (1.4) at the bottom of the file. `ISLANDS` (loop road, `towns[]`,
  `landmarks[]`), `EXTRA_ROADS`, `CONNECTORS` (the three bridges out of Britain),
  `BRIDGE_DECK = { beam: 14, suspension: 22 }`.
- `src/world/network.js`: turns those into sampled roads (`points`, `heights`, `tangents`,
  `bridge[]`, `style`), 2 m apart. `junctions`, `nearest()`, `isNearMeeting()`.
- `src/world/islands.js`: ground height. Towns, landmark plateaus and `hills` flatten or raise
  it. Roads are carved into a 2 m height grid in `buildGrid`.
- `src/world/road.js`: road surface, bridge decks and walls, the red suspension bridge
  (`buildSuspension`).
- `src/world/landmarkModels.js`: loads a landmark GLB within 1700 m, unloads beyond 2400 m.
  It scales by `size`/`fit`, turns by `yaw`, centres the bounding box on `x, z`, and for
  `sea: true` stands the lowest point at `SEA_LEVEL - 1.5`.
- `src/world/stations.js`: the pattern to copy for "a place beside a road with levelled
  ground": `planStations` picks sites and calls `levelGround`; `world.clearAreas` keeps trees
  off; `stationApproach` gives the self-driving a path in.
- `src/car/carModel.js`: `loadCar` (concept car, has a real cabin), `loadVehicle(id)` (the 20
  downloaded vehicles: body parts + `wheel_N`, **no interior**), `loadVehicleLod(id)` (one
  merged mesh for traffic). Each returns `geometry` (front, rear, halfWidth, length, height),
  `eye`, `views`.
- `src/car/vehicle.js`: the physics. `setCar(car, spec)` with `spec = { power, maxDrive, mass,
  grip, drag, gears, redline }` from `src/garage.js`.
- `src/camera.js`: `CAMERA_MODES`; the "Driver" mode is `kind: "attached", eye: "driver"`.
- `src/navigation.js`: `Navigator.route()` and `AutoDriver.drive()` (follows a route, obeys
  lights and limits).
- `src/traffic.js`: thin-instanced traffic by type; `colliders()` gives circles per vehicle.
- `src/fuel.js` + `main.js`: the "Fill up" flow (`mode === "fuel"`, a button that appears when
  stopped at a pump, a scripted camera). Copy this pattern for "Race".
- `src/map.js` + `main.js`: `PLACES` and the country-first picker (Landmarks / Towns / Fuel).
- `tools/prepare-models.mjs`: converts the Sketchfab downloads in `tools/.cache/sketchfab/`
  (kept on this PC, not in git) into `public/assets/...`. Run
  `node tools/prepare-models.mjs landmarks towerbridge` to remake one.

---

## Part 1: drive through Tower Bridge

**Now:** the Tower Bridge model stands alone in the sea off Britain's north coast
(`layout.js`: `x: 60, z: 690`, `size: 240`, `fit: "length"`, `sea: true`). No road goes near it.

**Goal:** the road to France leaves Britain through Tower Bridge. You drive along its deck,
between the two towers and under the high walkways.

**Where:** on the `toFrance` connector, at the British end of the water crossing. The
connector runs east along `z ≈ 0` (pre-scale points `[520,-10] … [1500,0]`). Find the first
sample where `road.bridge[i]` turns true (the British shore) and centre the model about 130 m
past it, so the whole 240 m model is over water and the plain concrete bridge carries on to
France after it.

**Steps**

1. **Measure the model.** Load `public/assets/landmarks/towerbridge.glb` (84.5k triangles,
   bounding box 177.9 x 86.8 x 383.1 in its own units, length along its z). Find, in model
   space: the top of the road deck along the centre line, the clear width between the tower
   legs at deck level, and the clear height under the lowest thing above the road. Do it by
   sampling vertices near the centre line, and confirm with a screenshot looking along the deck.
2. **Decide which of two builds to use, from those numbers.** At `size: 240` the scale is
   about 0.63.
   - **A (preferred): keep the model.** Needs a clear width of at least 11 m at that scale
     (the road is 10 m wide) and at least 5 m of clear height (the fire engine is 2.9 m tall,
     the chase camera sits about 3.8 m up for a bus). If the opening is a little narrow, scale
     the model up until it fits; up to about 300 m long is fine.
   - **B (fallback): build it in code**, like `buildSuspension` in `road.js`: two stone towers
     with a pointed-arch gateway (use the `sandstone` material), two high walkways joining
     them, pale blue suspension chains down to the abutments, blue-and-white railings. Use
     this if the model's opening cannot be made to fit, or its deck is too broken to drive on
     visually. Then delete `towerbridge.glb` and its credit line in `index.html`.
3. **Seat it on the road (build A).** Add options to the landmark entry and honour them in
   `landmarkModels.js`: `deck` (model-space height of the road deck) so the loader sets the
   model's deck top to the road height at that spot minus 0.05 m, instead of standing it on
   the sea bed; and `yaw` so its length runs along the road's tangent there. Take the road
   height and tangent from the connector's samples, not from constants.
4. **Keep the road flat through it.** The connector's heights are smoothed and can slope near
   the shore. Force the samples inside the model's span to one height (in `network.js`, where
   bridge heights are set), with a gentle blend either side (grade limit is 0.085).
5. **Hide the game's own bridge there.** In `road.js`, skip the concrete deck, walls and
   pillars for samples inside the model's span (keep the asphalt surface and lane markings).
   The model's own deck and railings take their place. Leave the invisible driving surface
   alone; `world.getHeight` on bridges comes from `deckHeight`, not from the model.
6. **Collisions.** Add collider boxes for the four tower legs (each side of the road) and for
   the model's railings along the span, so you cannot drive through the stonework or off the
   side. Remove the old `sea` skip for this landmark in `LandmarkModels`' constructor only if
   the box positions come from the measured model.
7. **Loading distance.** The bridge must be loaded before you reach it. `LOAD_DIST` is 1700 m,
   which is enough; check by driving from Kingsford at full speed.
8. **Tidy up.** Flags and the "Welcome to Britain" sign at this bridge end (`flags.js`, part
   4 of `buildFlags`) must not stand inside the model: move them to the landward side. The
   map label comes from `layout.js` automatically. Update the comment above `CONNECTORS`.

**Test**

- Drive Britain to France and back in the sports car, the city bus and the fire engine, in
  Chase and Driver views. No clipping through stone, no gap or step in the road, no camera
  inside geometry.
- Run the self-driving from Kingsford to Paris: it must pass through cleanly.
- Traffic passes through without stopping.
- Night: the bridge is lit by the car's headlights, not glowing.
- Memory number unchanged (the model is already loaded near Britain today).

---

## Part 2: better inside view

**Now:** only the concept car has a cabin. In the 20 downloaded vehicles the Driver view shows
a black silhouette and nothing else (they have no interior geometry).

**Goal:** every vehicle has a believable cockpit in Driver view: dashboard, a steering wheel
that turns, working dials, pillars and a mirror, with the road clearly visible.

**Approach: one shared "cabin kit" built in code**, shown only in Driver view, sized to each
vehicle. No downloads, tiny memory cost.

1. **New file `src/car/cabin.js`**, a `Cabin` class built once and re-fitted on every
   `swapCar`:
   - **Dashboard:** a curved top with a hooded instrument binnacle, a centre console, air
     vents. Dark soft-touch material (roughness 0.9) so it does not reflect in the windscreen.
   - **Steering wheel:** a torus rim, three spokes and a hub, on a pivot. Turn it with
     `vehicle.steerInput * 2.8` exactly as `vehicle.sync()` does for the concept car's
     `steeringPivot`.
   - **Instrument cluster:** one 512 x 256 `DynamicTexture`, emissive so it reads at night.
     Draw a speedometer (in the chosen units), a rev counter (`vehicle.rpm`, red zone from
     `spec.redline`), a fuel or battery bar (`fuel.level`, `fuel.electric`), the gear, and
     warning lights (low fuel, damage over 0.4, headlights on). Redraw only when a shown
     value changes, and at most 15 times a second.
   - **Centre screen:** a second small quad showing the existing minimap canvas (`MiniMap`
     already draws to a canvas; reuse it as the texture source, updated a few times a second).
   - **Frame:** two A-pillars, a roof header with a sun-visor edge, door tops with a window
     sill each side. Tint the door tops with a colour sampled once from the body.
   - **Rear-view mirror:** a mirror-shaped quad with a dark glass look. **Do not render a
     real reflection on Low or Medium.** On High only, optionally a 256 x 96 render target
     updated every third frame; make this a separate last step and drop it if it costs more
     than 1 ms.
2. **Three shapes** chosen from `car.geometry`: **car** (low dash, small wheel), **van or
   truck** (`height > 1.9`: upright seat, flatter dash, bigger wheel), **bus**
   (`length > 6.2`: very large flat wheel, wide flat dash, split windscreen pillar in the
   middle to match the model). Position everything from `car.eye`, so it fits all 20 without a
   table of numbers.
3. **Camera and body.** In Driver view: show the kit, hide the vehicle's glass meshes
   (`car_Glass_*`) so the tinted glass no longer darkens the road, keep the bonnet visible.
   In every other view: hide the kit. Hook this in `camera.js` where the mode changes, and in
   `swapCar` in `main.js`. Set the driver camera's `minZ` to 0.03 as now.
4. **Left or right hand drive.** Offset the eye and the wheel sideways by about 0.35 m: right
   seat for Britain's vehicles feels right, but vehicles move between countries, so base it on
   the vehicle, not the country. Simplest: left-hand drive for all the downloaded vehicles
   (their models are American), centre seat stays for the concept car.
5. **Concept car.** It already has a real cabin and a turning wheel. Add only the live cluster
   texture over its instrument panel if a clean flat surface can be found
   (`fixMaterials` in `carModel.js` already knows its material names); otherwise leave it.
6. **Head movement.** Small and cheap: lean the eye 2 to 3 cm into turns and back under
   braking (from `vehicle.accLat` and `vehicle.accLong`), and a look-left / look-right when
   steering hard at low speed (up to 12 degrees). Keep the horizon level as `_attached` does.

**Test**

- Driver view in the compact, sports car, SUV, pickup, ambulance, city bus and fire engine:
  road visible, wheel turns the right way, nothing blocks more than the bottom third.
- Dials match the on-screen speed and fuel. Readable at night, not glaring.
- Switching views and switching vehicles never leaves a kit visible from outside.
- Memory: under 2 MB of new textures. Frame time in Driver view no worse than Chase view.

---

## Part 3: drag strips with AI racers

**Goal:** eight drag strips (two per country) you can drive to, line up at, and race three AI
cars over a quarter mile, with times and medals kept.

### The strips

1. **Layout.** Add `DRAG_STRIPS` to `layout.js`, one entry per strip: a start point, a
   heading, and the road it joins. Each strip is a dead-straight, dead-flat piece: 40 m
   staging area, **402 m** timed run, 260 m run-off, **4 lanes of 4 m** (16 m wide), plus a
   short two-lane link road to the nearest public road.
2. **Choosing sites.** Do it the way `planStations` does: search for flat open ground
   (roughness under about 6 m over the footprint), at least 120 m from towns, landmarks,
   fuel stations and other roads, entirely on land (`baseHeight > 3`). Pick two per country as
   far apart as possible. Prefer picking by search over hand-typed coordinates, then print the
   chosen spots and freeze them into `layout.js` so they never move between versions.
3. **Ground.** Level the footprint to one height with a 15 m blend, the way
   `stations.js` `levelGround` does. Add the footprint to `world.clearAreas` so no trees or
   rocks land on it.
4. **Network.** Add the strip and its link as roads with `style: "drag"` so the map draws them
   and the Navigator can route to the staging area. **Keep traffic off:** in `traffic.js`
   never spawn on, or turn onto, a `drag` road; in `trafficLights.js` do not put lights at
   their junction; speed limit on the strip is none (`speedLimitAt` returns `Infinity`
   there and the HUD sign shows a dash).
5. **Scenery** (new file `src/world/dragstrips.js`, all merged or instanced, code-drawn
   textures only):
   - Dark asphalt with white lane lines, a start line, a chequered finish band, rubber marks
     near the start, lane numbers painted on the ground.
   - Concrete barriers both sides (they are colliders) and a tyre wall at the far end.
   - A **start light tree** between the middle lanes: three amber lights and a green per side,
     emissive, driven by the race state. A finish gantry with a **timing board**
     (`DynamicTexture`) showing the last run's times.
   - A small grandstand and a row of flags (reuse `flags.js` `fly`) so the strip is visible
     from far off. Four floodlight poles added to `town.lampSpots` so the night pools and
     nearest-lamp lights work there.
   - A roadside sign on the public road pointing to it.

### The race

6. **New file `src/race.js`** with a `DragRace` state machine: `idle → staged → countdown →
   running → finished`. Add `mode === "race"` to `main.js` beside `"drive"`, `"foot"`,
   `"fuel"`.
7. **Starting one.** When you stop inside a staging box, show a **Race** button (same pattern
   as the "Fill up" button and `pumpSpotAt`). Tapping it opens a small panel: pick
   **Easy / Medium / Hard**, then **Start**. Your car is placed exactly on the start line in
   lane 2, the three AI cars in lanes 1, 3 and 4.
8. **Opponents.** Pick three from `GARAGE` whose power-to-weight is closest to yours
   (within about 25 %), so a bus races buses and vans and a sports car races fast cars.
   Draw them with `loadVehicleLod` meshes through the existing traffic types
   (`trafficKind(id)` in `main.js` loads a kind on demand), as cars with `racing: true` that
   the normal traffic update skips.
9. **AI.** Straight-line only, so no steering needed. Simulate each one with the same
   numbers the player's physics uses: force = `min(maxDrive, power / speed)`, minus
   `drag * v²` and rolling resistance, divided by mass. Add a reaction time and a power
   factor per difficulty: Easy 0.45 s and 88 %, Medium 0.30 s and 97 %, Hard 0.18 s and
   104 %, each with a little random spread. Check the result against the player: on Medium a
   clean launch in the same car should win by a small margin.
10. **Countdown.** Three ambers at 0.5 s apart, then green. Hold your car with the brake
    until green. Moving before green is a **false start**: add 1.0 s to your time and flash
    the red light. Input stays the normal gas / brake / steering; gears stay automatic.
11. **Running.** Time each car from green to the finish line. Show a live stopwatch, your
    position (1st to 4th) and speed. Lane barriers keep cars apart; if you hit an AI car,
    nothing special happens beyond the normal bump.
12. **Finish.** After the line the AI cars brake and pull to the end of the run-off. Show a
    result card: your time, top speed, position, the gap to the winner, and a medal (gold for
    1st, silver 2nd, bronze 3rd). Buttons: **Race again** and **Leave**. Leaving returns the
    AI cars to nothing and you to `"drive"` at the end of the run-off, facing the exit.
13. **Saved results.** Best time per strip, and best time per strip per vehicle, plus medals,
    in the settings object in `quality.js` (`saveSettings`). Show the best time on the
    timing board and in the map list.
14. **During a race:** the self-driving is off, people and normal traffic are not allowed on
    the strip, fuel drains as usual but a race cannot start under 10 % fuel (say why), crash
    damage works as usual.
15. **Map.** Add a fourth kind, **Races**, to the country picker in `main.js` (`KINDS`), and a
    small chequered badge on both maps (see `drawFuelBadge` in `map.js`). Picking one routes
    you to its staging box; the self-driving stops in the staging area.
16. **Sound.** Reuse `audio.js`: three short beeps and a higher one for the lights, a short
    cheer-like noise burst is not needed. Keep it to car sounds and the beeps (the owner
    removed music and ambience on purpose).

**Test**

- Drive to a strip in each country by picking it on the map, with and without self-driving.
- Run a race on each difficulty in the sports car, the saloon and the city bus. Check false
  starts, the result card, "Race again" five times in a row (no leftover cars or lights), and
  leaving mid-race by tapping the map or getting out (must end the race cleanly).
- Best times survive a reload.
- Traffic never enters a strip. Trees never stand on one.
- Memory: under 10 MB of new textures; at most three extra traffic kinds loaded for a race,
  released when it ends if they were not already on the roads.

---

## Part 4: more realistic terrain

**Now:** `src/world/terrain.js` draws each island as a grid of 6 m squares (`STEP = 6`) with
one custom PBR material: a grass (or sand) texture, a second larger copy to hide repeats,
rock on steep slopes (tri-planar), a dirt verge by roads, sand near the water line, and
weather tinting. The land shape comes from `Island._natural` in `islands.js` (a few layers of
noise). It reads as smooth rolling lawn: one grass everywhere, soft hills, no fields, no
cliffs, bare ground between trees.

**Goal:** ground that looks like real countryside from the driver's seat and from far away,
with no new large textures and no more triangles.

**Do not change `Island._natural`'s overall heights near roads, towns, stations, parks,
landmarks or drag strips.** Everything is placed against them, and roads are carved into the
same grid. Shape changes below are limited to where they are safe.

1. **More ground types, blended by rules in the shader** (extend `Fragment_Custom_Albedo`;
   reuse the textures already loaded: grass, rock, sand, sandstone). Drive them from data
   already available per pixel or per vertex:
   - **Height bands:** lush green low down, drier yellow-green higher, bare rock and scree on
     the highest ground (Britain, France, USA). Desert: pale dunes low, darker stony ground
     high.
   - **Slope:** keep the rock-on-steep rule, and add a "worn earth" band on medium slopes.
   - **Fields (Britain and France):** large patchwork patches in three or four crop tones
     (fresh green, wheat, ploughed brown, pale hay) on flat ground away from towns. Make the
     patches from a cellular (Voronoi) pattern in world space at about 150 m, with a thin
     dark hedge line on the cell edges. Flat ground only, so it fades out on hills.
   - **Forest floor:** darker, browner ground where the tree-density noise is high (the same
     `fbm(forest, x / 260, z / 260, 3)` that `nature.js` uses; bake it into a spare vertex
     attribute next to `terrainMask` so the two always agree).
   - **Wet edge:** a darker damp band just above the water line before the sand.
   - Add a second vertex attribute rather than new textures. Keep the shader to the existing
     texture count plus at most one: mobile GPUs limit samplers, and each tri-planar lookup
     is three reads.
2. **Break up the tiling close to the car.** Add a detail normal at a much smaller scale
   (reuse `grass_normal` at about 0.7 m) that fades out by 40 m, so the ground has grain
   under the wheels without a new texture.
3. **Distance colour.** Add a low-frequency colour variation (the `macro` value, widened) so
   far hills are not one flat green.
4. **Sharper land shape, only where safe.** In `_natural`, add ridged noise to ground above
   about 30 m and more than 150 m from any road sample, town, landmark or strip (a
   precomputed "keep-out" test), so the hilltops become craggy instead of rounded. Add low
   sea cliffs on some stretches of coast by steepening the shoreline ramp where a coast
   noise is high (the beach stays elsewhere). Then check every road, station, park and
   landmark still sits correctly; if any moved, limit the change further rather than
   re-tuning placements.
5. **Ground cover (instanced, cheap).** Low-poly grass tufts, bushes and small flowers as thin
   instances, placed only within about 60 m of roads (that is all the player sees closely),
   in sectors like the trees so off-screen ones are skipped. One shared alpha-tested texture,
   512 px, drawn in code. Count by preset: none on Low, about 3,000 on Medium, 8,000 on High.
   Give them the same wind sway as the trees (part 6.3).
6. **Desert.** Wind ripples on dunes (a fine directional normal), darker hollows between
   dunes, scattered dry shrubs instead of grass tufts, and a few palm groups near Al Nahr and
   Al Wadi (reuse the broadleaf trunk with a new code-built crown; no download).
7. **Rivers are out of scope** (they would need new bridges and road changes).

**Test:** drive a full lap of each country at ground level and look from a hilltop. No hard
edges between ground types, no pattern that visibly repeats, roads and buildings still meet
the ground. Frame time on Medium within 1 ms of before; memory within 5 MB.

---

## Part 5: more realistic buildings

**Now:** `src/world/town.js` makes every building a plain box with a flat or mansard roof.
Walls use a painted facade texture (wall colour plus a grid of identical windows) that
repeats over the whole box, so the ground floor looks the same as the top floor and every
side is identical. There are four styles: `british`, `paris`, `city`, `desert`. The tops of
tall buildings are recorded in `roofs` (flags stand on them). Collisions are one box each.

**Goal:** streets that read as real places: ground floors with shops and doors, varied
shapes and roofs, and details at eye level, at about the same cost.

Keep each building's footprint and collision box exactly as now (parked cars, pavements,
people, flags and lamps are all placed against them). Change only what is drawn inside it.

1. **Ground floors.** Split each facade vertically: a ground-floor band with its own texture
   strip (shop windows, doors, a fascia sign band, an entrance for flats and offices) and the
   upper floors as now. Do it with UVs into one taller atlas per style, not extra materials.
   Draw shop names with canvas text from a list of made-up names per country; no real brands.
2. **Shape.** Break the box up without leaving its footprint:
   - **British:** terraced houses with pitched tiled roofs, chimney stacks, bay windows on
     some, brick and render mixes; a few taller Victorian blocks with gables.
   - **Paris:** keep the mansards; add balconies with railings on two floors, taller ground
     floors with awnings, dormer windows in the roof, stone string courses.
   - **City (USA):** setbacks on tall towers (a wider base, a narrower top), a lobby level
     with glass and a canopy, roof plant (water tanks, AC units, a mast with a red night
     light); a few brick mid-rise blocks with fire-escape detail drawn into the texture.
   - **Desert:** flat roofs with parapets, small domes on a few, arched doorways, wooden
     balconies, awnings, rooftop water tanks.
   All of this is extra quads and boxes merged into the existing per-material builders.
   Budget: at most about 3x today's town triangle count, which is small.
3. **Facade variety.** More facade variants per style (today 2 to 4): different window
   shapes, shutters, sills, drainpipes, weathering streaks under sills, a darker plinth at
   the base. Vary window lighting at night (already per-window in the glow texture; add a
   few blue TV-coloured ones and some dark shops). Keep every facade canvas at its current
   size or smaller; the count of facade textures may rise by at most 6 in total.
4. **Street furniture, instanced:** awnings, hanging shop signs, post boxes (red pillar box in
   Britain, blue mailbox in the USA), bins, bollards, a bus stop with a shelter on each main
   street, cafe tables under awnings in Paris. One merged mesh or one thin-instance set per
   item type. Add small colliders for the solid ones, and keep them off side streets, park
   gates and the kerb where parked cars stand (`traffic.js` `_addParked`).
5. **Back and side walls.** Give side and rear walls a plainer variant (fewer windows, pipes,
   a back door) instead of repeating the front.
6. **Second-row buildings.** Each town is one street deep. Add a sparse second row behind the
   first where the ground is flat (lower houses, gardens, garages), with simple one-box
   colliders, so towns have depth when seen from the hills. Skip where a park, landmark,
   station or side road is.
7. **Roofs for flags.** Keep pushing the true top of tall buildings into `roofs`, now the top
   of the setback or the ridge, so the rooftop flags still stand on something.

**Test:** walk and drive each of the eight towns by day and night. Nothing floats or pokes
into the road or pavement; people still walk the pavements; parked cars still fit; flags
still stand on roofs; the self-driving still gets down every main street. Memory: at most
25 MB more textures on Medium, paid for by part 6.0.

---

## Part 6: the extras (all approved by the owner)

Every extra here is approved. Build them in the order under "Build order".

**Graphics**

0. **Compressed textures (KTX2 / Basis). Do this first of all.** The same pictures take
   roughly a quarter of the graphics memory. It makes the iPad safer and pays for the extra
   detail in parts 4 and 5. Babylon reads KTX2 natively; the iPad supports ASTC, desktops
   BC7. Steps: add a build step (in `tools/`) that converts `public/assets/textures/*.webp`
   and the textures inside the vehicle, landmark and concept-car GLBs (`KHR_texture_basisu`
   via gltf-transform) to KTX2: UASTC for normal maps, ETC1S for colour where it looks
   clean. Host the transcoder files locally under `public/` (no CDN: the game must work
   from the Home Screen). `DynamicTexture`s and the sky HDRs stay as they are. Check every
   material by eye in day and night; watch normal maps and alpha (leaves, glass, flags). Has
   unknowns, so do it alone, measure, and report the before and after memory numbers. If any
   group of textures looks worse, leave that group uncompressed.
1. **Brake lights that work on the new vehicles.** Only the concept car's brighten now. Add
   a red glow quad at each tail lamp (find lamp positions from the rear-facing parts of the
   optics mesh), driven by braking, for the player's vehicle and for traffic that is slowing.
2. **Tyre smoke and skid marks.** Particles and thin dark ground decals from wheels that are
   slipping (hard launches, hard braking, slides). Cap particles at about 150 and decals at
   a ring buffer of about 200 quads in one mesh.
3. **Trees that sway.** The `FlagWave` material-plugin approach from `flags.js`, on the two
   leaf materials: displacement grows with height above the trunk base, phase from world
   position. Wind strength follows the weather.
4. **Soft contact shadow under every vehicle.** One dark blurred quad per vehicle, thin
   instanced, for traffic and the player.
5. **Better sea and shoreline.** Foam where water meets land (terrain height is known per
   position), and sky colour mixed in by viewing angle. Shader only, no extra render pass.
6. **Town variety.** Now covered by part 5.
7. **Speed feel.** Wider field of view with speed (all presets), a light edge blur on High
   only, and a little camera shake over rough ground and at very high speed.

**Gameplay**

8. **Speed traps.** About four per country on fast straight roads: a camera pole and a
   painted line. Passing one records your speed; keep the best per trap. Show a banner
   ("Speed trap: 187 km/h, new best") and the bests in the map list with the Races kind.
9. **Point-to-point street races** between landmarks against three AI cars. Opponents drive
   with `AutoDriver` on a route from `Navigator`, with a speed factor by difficulty and no
   speed-limit or red-light obedience during the race. Start from a marked gate near each of
   about six landmarks; checkpoints as glowing gates along the route; the same result card
   and medals as drag racing.
10. **Credits and unlocking.** Earn credits from drag races, street races and new speed-trap
    bests. Show the balance in the garage. Start with the concept car and the six everyday
    cars unlocked; the rest cost credits, priced by performance. **Everything the owner has
    now must stay usable:** on first run after this update, unlock the vehicle currently
    saved in settings, and add an "Unlock everything" switch in Settings so the owner is
    never locked out of a vehicle.
11. **Engine sounds by vehicle type.** In `audio.js`, give each garage entry a sound profile:
    diesel (buses, lorries: lower pitch range, rougher), sports (higher, sharper), everyday,
    and electric (a rising hum, no idle rumble). Car sounds only: no music, no ambience.
12. **Horn and a look-behind button.** Two small on-screen buttons, placed so they do not
    crowd the steering side. Horn: people step aside and the car ahead in traffic pulls over
    briefly. Look behind: hold to flip the chase or driver camera.
13. **Photo mode.** From a button: pause the world, hide all controls, drag to orbit, pinch
    to zoom, a slider for time of day, and a "Save picture" button that saves a PNG (read
    the canvas straight after `scene.render()`).

**Not to be built (too heavy for the iPad):** real mirrors or reflections on Low or Medium,
ambient-occlusion passes, more downloaded models, textures over 1024 px, a three.js rewrite.

---

## Build order

Build all of it in this order, in one run. After each line: run that part's tests, measure
memory on the Medium preset, fix what fails, make a local commit, and carry on. Do not stop
to ask between lines. Only stop early for something that cannot be decided without the
owner (not for ordinary bugs).

1. Part 6.0: compressed textures (frees the memory everything else uses).
2. Part 1: Tower Bridge.
3. Part 4: terrain.
4. Part 5: buildings.
5. Part 2: inside view.
6. Part 3: drag strips.
7. Parts 6.1 to 6.5: brake lights, tyre smoke and skid marks, swaying trees, contact shadows,
   sea and shoreline.
8. Parts 6.7, 6.11, 6.12: speed feel, engine sounds, horn and look-behind.
9. Part 6.8: speed traps.
10. Part 6.9: street races.
11. Part 6.10: credits and unlocking (last, so every way of earning already exists).
12. Part 6.13: photo mode.

**If step 1 fails or saves much less than expected, do not stop.** Carry on, but build parts
4 and 5 with no new texture memory at all (reuse existing textures and shrink facade
canvases to make room), and say so in the final report.

**After every line, the memory ceiling still holds:** Medium-preset texture memory must not
end above the number measured before step 1. If a part pushes it over, cut that part back
(smaller canvases, fewer variants, lower counts) before moving on.

## When everything is built

1. Run the whole game once more from a fresh load on Low, Medium and High: drive a lap of
   each country, one drag race, one street race, a speed trap, a fill-up, a car swap, photo
   mode, day and night. No console errors.
2. `npx vite build` must pass.
3. Give the owner one short report in plain words: what was built, the memory number before
   and after, anything cut back or left out and why, and what was not tested (the iPad).
4. Ask before pushing. After the push, the owner tests on the iPad. If it is slow or will
   not run, undo parts using the per-part commits, heaviest first: buildings, terrain,
   ground cover, tyre smoke.
