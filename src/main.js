import { Engine, Scene, Color4, DefaultRenderingPipeline, ImageProcessingConfiguration, ColorCurves, KhronosTextureContainer2 } from "@babylonjs/core";
import { PRESETS, LEVELS, loadSettings, saveSettings, startingLevel } from "./quality.js";
import { setupSky, createShadows } from "./sky.js";
import { World } from "./world/world.js";
import { Colliders } from "./world/colliders.js";
import { buildTerrain, weatherFx } from "./world/terrain.js";
import { buildRoad } from "./world/road.js";
import { buildTown } from "./world/town.js";
import { buildLandmarks } from "./world/landmarks.js";
import { buildNature } from "./world/nature.js";
import { buildGroundCover } from "./world/groundCover.js";
import { updateWind } from "./world/wind.js";
import { buildParks } from "./world/parks.js";
import { buildFlags, flagPicture } from "./world/flags.js";
import { SPAWN, LANE_OFFSET } from "./world/layout.js";
import { loadCar, loadCarLod, loadVehicle, loadVehicleLod } from "./car/carModel.js";
import { Vehicle } from "./car/vehicle.js";
import { CarDamage } from "./car/damage.js";
import { Cabin } from "./car/cabin.js";
import { CarFx, fxKind } from "./car/carFx.js";
import { TyreFx } from "./car/tyres.js";
import { TrafficLights, speedLimitAt } from "./world/trafficLights.js";
import { planStations, buildStations, stationApproach } from "./world/stations.js";
import { LandmarkModels } from "./world/landmarkModels.js";
import { Fuel, Refuel, pumpSpotAt, NEARLY_EMPTY } from "./fuel.js";
import { ChaseCamera, EdgeBlur } from "./camera.js";
import { Input } from "./input.js";
import { Weather, WEATHERS } from "./weather.js";
import { GameAudio } from "./audio.js";
import { Traffic, TRAFFIC_MIX } from "./traffic.js";
import { People } from "./people.js";
import { Navigator, AutoDriver } from "./navigation.js";
import { renderMapImage, MiniMap, BigMap, PLACES, setFuelStations } from "./map.js";
import { GARAGE, REAL, applyPaint, figures } from "./garage.js";
import { DayNight, TIME_PRESETS } from "./daynight.js";
import { NightLights } from "./nightlights.js";
import { planDragStrips, buildDragStrips } from "./world/dragstrips.js";
import { DragRace } from "./race.js";
import { setDragStrips, setSpeedTraps, setStreetRaces } from "./map.js";
import { planStreetRaces, buildStreetRaces } from "./world/streetRaces.js";
import { StreetRace } from "./streetRace.js";
import { planSpeedTraps, planTownCameras, buildSpeedTraps, cameraEye } from "./world/speedtraps.js";
import { SpeedTraps } from "./traps.js";
import { PhotoMode } from "./photo.js";
import { Rescue } from "./rescue.js";
import { SpeedPhotos } from "./speedPhotos.js";
import { PhotoAlbum } from "./album.js";
import { FinishShow } from "./finishShow.js";

const $ = (id) => document.getElementById(id);

// Most pictures are KTX2 files (made by tools/compress-textures.mjs), which stay
// compressed in graphics memory. The code that unpacks them ships with the game
// instead of coming from Babylon's website, so the game also works offline.
// (Every entry must be set: a missing one falls back to the website.)
const KTX2 = "assets/ktx2/";
Object.assign(KhronosTextureContainer2.URLConfig, {
  jsDecoderModule: `${KTX2}babylon.ktx2Decoder.js`,
  wasmUASTCToASTC: `${KTX2}uastc_astc.wasm`,
  wasmUASTCToBC7: `${KTX2}uastc_bc7.wasm`,
  wasmUASTCToRGBA_UNORM: `${KTX2}uastc_rgba8_unorm_v2.wasm`,
  wasmUASTCToRGBA_SRGB: `${KTX2}uastc_rgba8_srgb_v2.wasm`,
  wasmUASTCToR8_UNORM: `${KTX2}uastc_r8_unorm.wasm`,
  wasmUASTCToRG8_UNORM: `${KTX2}uastc_rg8_unorm.wasm`,
  jsMSCTranscoder: `${KTX2}msc_basis_transcoder.js`,
  wasmMSCTranscoder: `${KTX2}msc_basis_transcoder.wasm`,
  wasmZSTDDecoder: `${KTX2}zstddec.wasm`,
});

const settings = loadSettings();
let level = startingLevel(settings);
let preset = { ...PRESETS[level] };

// ---------- Stop the iPad from zooming, scrolling or bouncing ----------
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());
document.addEventListener(
  "touchmove",
  (e) => {
    if (!e.target.closest(".panel-card, .map-side")) e.preventDefault();
  },
  { passive: false },
);

function setProgress(fraction, text) {
  $("bar-fill").style.width = `${Math.round(fraction * 100)}%`;
  if (text) $("loading-text").textContent = text;
}
// Short pause so the loading bar can repaint between heavy steps.
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

const IDLE = { steer: 0, throttle: 0, brake: 0, handbrake: true, steerAnalog: false };

async function start() {
  const canvas = $("game");
  const engine = new Engine(canvas, false, {
    stencil: true,
    antialias: false,
    powerPreference: "high-performance",
    adaptToDeviceRatio: false,
    preserveDrawingBuffer: false,
  });
  const applyScale = () => {
    const s = Math.min(preset.scale, window.devicePixelRatio || 1);
    engine.setHardwareScalingLevel(1 / s);
  };
  applyScale();
  window.addEventListener("resize", () => engine.resize());

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.62, 0.7, 0.8, 1);
  scene.skipPointerMovePicking = true;

  setProgress(0.04, "Painting the sky…");
  const sky = await setupSky(scene);

  setProgress(0.12, "Shaping four countries…");
  await nextFrame();
  const world = new World();
  const colliders = new Colliders();
  // Fuel stations are planned before the ground is built, so it can be levelled under them.
  const stations = planStations(world);
  // ...and so are the drag strips (levelled, and kept free of trees).
  const strips = planDragStrips(world);
  // ...and the speed traps (no trees on their poles).
  const traps = planSpeedTraps(world);
  // ...and the towns' speed cameras (on the pavements).
  const townCameras = planTownCameras(world);
  // ...and the street race start gates (no trees on their posts).
  const streetRaces = planStreetRaces(world);
  setProgress(0.22, "Laying the land and sea…");
  await nextFrame();
  buildTerrain(scene, world);
  setProgress(0.3, "Building roads and bridges…");
  await nextFrame();
  const road = buildRoad(scene, world, colliders);
  setProgress(0.36, "Building the towns…");
  const town = await buildTown(scene, world, colliders);
  const landmarks = buildLandmarks(scene, world, colliders);
  const stationParts = buildStations(scene, world, colliders, stations);
  const dragParts = buildDragStrips(scene, world, colliders, strips);
  const trapParts = buildSpeedTraps(scene, world, colliders, traps, townCameras);
  const gateParts = buildStreetRaces(scene, world, colliders, streetRaces);
  const landmarkModels = new LandmarkModels(scene, world, colliders);
  const parks = buildParks(scene, world, colliders, town.parks, preset, town.lampGlow);
  town.lampSpots.push(...stationParts.lampSpots, ...parks.lampSpots, ...dragParts.lampSpots);
  const flags = buildFlags(scene, world, colliders, { roofs: town.roofs, parks: town.parks, stations, strips });
  // (Mixed in near the front, so some people stroll in the parks even when there are few people.)
  parks.walkSpots.forEach((sp, i) => town.pavementSpots.splice(Math.min(town.pavementSpots.length, i * 3), 0, sp));
  setProgress(0.42, "Planting trees…");
  await nextFrame();
  const nature = buildNature(scene, world, colliders, preset, parks.trees);
  const cover = buildGroundCover(scene, world, colliders, preset, nature.trunk);

  setProgress(0.46, "Bringing the car round…");
  // The concept car, or one of the downloaded vehicles.
  const loadEntry = (entry, onProgress) => (entry.model ? loadVehicle(scene, entry.model, onProgress) : loadCar(scene, onProgress));
  let carEntry = GARAGE.find((g) => g.id === settings.car) ?? GARAGE[0];
  let car;
  try {
    car = await loadEntry(carEntry, (p) => setProgress(0.46 + p * 0.2));
  } catch (err) {
    console.warn("couldn't load", carEntry.id, err);
    carEntry = GARAGE[0];
    car = await loadCar(scene);
  }
  let paint = carEntry.paint;
  applyPaint(car, paint);
  const vehicle = new Vehicle(car, world, colliders, carEntry.spec);
  const damage = new CarDamage(scene, car);
  vehicle.onImpact = (hit) => damage.hit(hit);
  const fuel = new Fuel(settings.fuel);
  fuel.electric = !!carEntry.electric;
  fuel.auto = settings.fuelMode === "auto";
  vehicle.place(SPAWN.x, SPAWN.z, SPAWN.heading);

  setProgress(0.7, "Filling the roads…");
  const lod = await loadCarLod(scene);
  // The real cars are drawn in traffic (and as race rivals) from their light copy.
  const lodFile = (id) => (REAL.some((g) => g.model === id) ? `${id}_lod` : id);
  // All kinds of vehicle only on the High setting; each kind costs graphics
  // memory, and an iPad (Medium on Auto) closes the page if that runs out.
  // (High also has a few everyday real cars about: those marked `traffic` in tools/cars.json.)
  const realTraffic = REAL.filter((g) => g.traffic).map((g) => ({ id: g.model, weight: 0.7, parked: true, more: true }));
  const mix = [...TRAFFIC_MIX, ...realTraffic].filter((t) => level === "high" || !t.more);
  let loadedKinds = 0;
  const kinds = await Promise.all(
    mix.map(async (t) => {
      try {
        const v = await loadVehicleLod(scene, t.id, lodFile(t.id));
        setProgress(0.7 + (++loadedKinds / mix.length) * 0.15, "Filling the roads…");
        return { ...t, ...v };
      } catch (err) {
        console.warn("couldn't load traffic", t.id, err);
        return null;
      }
    }),
  );
  const lights = new TrafficLights(scene, world, colliders);
  const traffic = new Traffic(scene, world, [{ id: "gt", mesh: lod, length: 4.6, halfWidth: 1.0, weight: 1, parked: true, coloured: true, tailLamps: lod.metadata?.tailLamps }, ...kinds.filter(Boolean)], preset);
  traffic.lights = lights;
  // Brake lights and a soft shadow under every vehicle (yours is the extra one).
  const carFx = new CarFx(scene, traffic.maxInstances + 1);
  traffic.fx = carFx;
  // (The concept car's own lamps light up, so it needs no added glow.)
  const playerKind = (c) => {
    const g = c.geometry;
    return fxKind({ lamps: c.tailLamps ?? [], length: g.length ?? 4.6, halfWidth: g.halfWidth ?? 1, centreZ: g.front !== undefined ? (g.front + g.rear) / 2 : 0 });
  };
  let playerFx = playerKind(car);
  const tyres = new TyreFx(scene, world, preset.smoke);
  const people = new People(scene, world, town.pavementSpots, preset, false);

  const chase = new ChaseCamera(scene, world, car, settings.cameraMode);
  chase.camera.maxZ = preset.viewDistance;
  scene.activeCamera = chase.camera;
  chase.update(0, vehicle);

  const csm = createShadows(scene, sky.light, chase.camera, preset);
  for (const m of [...car.shadowMeshes, ...town.casters, ...nature.casters, ...cover.casters, ...road.casters, ...landmarks.casters, ...traffic.types.map((t) => t.mesh), ...lights.casters, ...stationParts.casters, ...parks.casters, ...flags.casters, ...dragParts.casters, ...trapParts.casters, ...gateParts.casters]) csm.addShadowCaster(m, false);
  // Real landmark models load as you get near them.
  landmarkModels.onLoaded = (meshes) => meshes.forEach((m) => csm.addShadowCaster(m, false));
  landmarkModels.update(SPAWN.x, SPAWN.z);
  // Tower Bridge is nearly a kilometre long, and the shadow maps draw every
  // caster however far off it is, so each stretch of it casts only while
  // you're near enough for its shadow to show (checked once a second).
  const castNear = (x, z) => {
    for (const part of road.nearCasters) {
      const [x0, z0, x1, z1] = part.box;
      const near = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)) < preset.shadowMaxZ + 100;
      if (near === !!part.casting) continue;
      part.casting = near;
      for (const m of part.meshes) near ? csm.addShadowCaster(m, false) : csm.removeShadowCaster(m, false);
    }
  };
  castNear(SPAWN.x, SPAWN.z);


  // ---------- Camera effects ----------
  const pipeline = new DefaultRenderingPipeline("post", true, scene, [chase.camera]);
  const ip = pipeline.imageProcessing;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.05;
  ip.contrast = 1.12;
  ip.vignetteEnabled = true;
  ip.vignetteWeight = 1.6;
  ip.vignetteStretch = 0.4;
  ip.colorCurvesEnabled = true;
  const curves = new ColorCurves();
  curves.globalSaturation = 6;
  ip.colorCurves = curves;
  pipeline.bloomThreshold = 0.92;
  pipeline.bloomWeight = 0.22;
  pipeline.bloomKernel = 48;
  pipeline.bloomScale = 0.5;
  pipeline.sharpen.edgeAmount = 0.18;
  const applyEffects = () => {
    pipeline.samples = preset.msaa;
    pipeline.fxaaEnabled = preset.fxaa;
    pipeline.bloomEnabled = preset.bloom;
    pipeline.sharpenEnabled = preset.sharpen;
    csm.numCascades = preset.cascades;
    csm.shadowMaxZ = preset.shadowMaxZ;
  };
  applyEffects();
  // At speed the screen's edges blur a little (High only). Made after the
  // effects above, so it comes last, after the colour grading.
  let edgeBlur = preset.edgeBlur ? new EdgeBlur(chase.camera) : null;

  // ---------- Weather and sound ----------
  const findMats = (re) => scene.materials.filter((m) => re.test(m.name));
  const asphalt = findMats(/^(asphalt|asphaltTop|paintWhite|paintYellow|pavers)$/);
  for (const m of asphalt) m._baseTint = m.albedoColor.clone();
  const weather = new Weather(scene, sky, world, preset, { asphalt, leaves: findMats(/^(leaves|groundCover|palmFronds)/) });
  weather.set(settings.weather);
  const daynight = new DayNight(scene, sky, pipeline, weather, settings.hour);
  const nightLights = new NightLights(scene, { world, town, car, lod });
  for (const t of traffic.types) if (t.lights) nightLights.addTrafficLights(t.lights);

  // Swap the vehicle you're driving for another one, where you are now.
  const swapCar = async (entry, paintOverride = null) => {
    const next = await loadEntry(entry);
    const old = car;
    car = next;
    carEntry = entry;
    paint = paintOverride ?? entry.paint;
    applyPaint(car, paint);
    vehicle.setCar(car, entry.spec);
    vehicle.sync();
    playerFx = playerKind(car);
    damage.setCar(car);
    nightLights.setCar(car);
    audio.setEngine(entry.sound);
    // (Before the old vehicle goes: the cockpit kit hangs off its body.)
    cabin.setCar(car);
    chase.car = car;
    chase._first = true;
    for (const m of old.shadowMeshes) csm.removeShadowCaster(m, false);
    for (const m of car.shadowMeshes) csm.addShadowCaster(m, false);
    old.root.dispose(false, true);
    fuel.electric = !!entry.electric;
  };
  // A kind of vehicle the traffic can draw (loading it if it isn't on the roads yet).
  const trafficKind = async (id) => {
    if (traffic.type(id)) return id;
    try {
      const v = await loadVehicleLod(scene, id, lodFile(id));
      traffic.addType({ id, ...v });
      nightLights.addTrafficLights(v.lights);
      csm.addShadowCaster(v.mesh, false);
      return id;
    } catch {
      return "gt";
    }
  };
  let swapping = false;
  const audio = new GameAudio();
  audio.enabled = settings.sound;
  audio.setEngine(carEntry.sound);
  document.addEventListener("pointerdown", () => audio.start(), true);
  document.addEventListener("keydown", () => audio.start(), true);

  // ---------- The finish of a race ----------
  // Slow motion over the line, your place, a photo finish, the top three
  // lined up under fireworks, then the result card (both kinds of race).
  const finishShow = new FinishShow({
    scene,
    world,
    vehicle,
    traffic,
    audio,
    hooks: {
      camera: () => chase.camera,
      handBack: () => (chase._first = true),
      car: () => car,
      photo: (job) => photos.finish(job),
      warm: (job) => photos.warm(job),
      view: (rec) => album.view(rec),
      night: () => daynight.night,
    },
  });

  // ---------- Drag races ----------
  // A kind of vehicle loaded only for a race goes again afterwards (it costs
  // graphics memory), unless it was on the roads to begin with or one is
  // parked somewhere.
  const roadKinds = new Set(traffic.types.map((t) => t.id));
  const releaseKinds = (ids) => {
    for (const id of ids) {
      const t = traffic.type(id);
      if (!t || roadKinds.has(id) || traffic.cars.some((c) => c.type === t)) continue;
      traffic.types = traffic.types.filter((k) => k !== t);
      nightLights.lodHead = nightLights.lodHead.filter((m) => !t.lights?.includes(m));
      csm.removeShadowCaster(t.mesh, false);
      t.mesh.dispose(false, true);
    }
  };
  const race = new DragRace({
    vehicle,
    traffic,
    audio,
    fuel,
    settings,
    save: saveSettings,
    boardTexture: dragParts.boardTexture,
    hooks: {
      entry: () => carEntry,
      place: (x, z, heading) => {
        vehicle.place(x, z, heading);
        chase._first = true;
      },
      toast,
      ready: () => mode === "drive" && !autodriver.active && !street.active,
      onStart: () => {
        autodriver.stop();
        $("auto-chip").hidden = true;
        finishShow.warmUp(race);
      },
      kinds: { load: trafficKind, release: releaseKinds },
      show: finishShow,
    },
  });

  // ---------- Map and self-driving ----------
  const navigator = new Navigator(world);
  const autodriver = new AutoDriver(world, navigator);
  autodriver.lights = lights;
  autodriver.colliders = colliders;
  const mapImage = renderMapImage(world, town.parks);
  const minimap = new MiniMap($("minimap"), mapImage);
  // The cockpit seen from the driver's seat (dials, wheel, map screen...).
  const cabin = new Cabin(scene, { vehicle, fuel, damage, daynight, settings, minimap: minimap.canvas });
  cabin.setCar(car);

  // ---------- Speed traps ----------
  // (Only when you're driving yourself: not self-driving, not on foot.)
  const speedTraps = new SpeedTraps({
    traps,
    cameras: townCameras,
    vehicle,
    settings,
    save: saveSettings,
    hooks: {
      active: () => mode === "drive" && !autodriver.active,
      entry: () => carEntry,
      flash: (k) => trapParts.flash(k),
      // Over the limit: the camera takes your picture (country added, as trap names repeat).
      photo: (t, speed, limit, end) => photos.snap({ from: cameraEye(t, end), speed, limit, place: `${t.town ?? t.name}, ${world.islandById(t.island).def.name}` }),
    },
  });
  let guide = null; // { route, name, progress, x, z, race (a street race's route) }
  let picked = null; // destination chosen on the big map

  // ---------- Street races ----------
  const street = new StreetRace({
    world,
    navigator,
    vehicle,
    traffic,
    audio,
    fuel,
    settings,
    save: saveSettings,
    parts: gateParts,
    hooks: {
      entry: () => carEntry,
      place: (x, z, heading) => {
        vehicle.place(x, z, heading);
        chase._first = true;
      },
      toast,
      ready: () => mode === "drive" && !autodriver.active && !race.active,
      onStart: () => {
        autodriver.stop();
        $("auto-chip").hidden = true;
        finishShow.warmUp(street);
      },
      // The race's route shows on the little map, like a route you picked.
      guide: (route, name) => {
        if (route) {
          const end = route.points[route.points.length - 1];
          guide = { route, name, progress: 0, x: end.x, z: end.z, race: true };
        } else if (guide?.race) guide = null;
      },
      kinds: { load: trafficKind, release: releaseKinds },
      show: finishShow,
    },
  });
  // Opening the map or garage, getting out, being put back on the road...
  // ends whichever race is on.
  const endRaces = () => {
    race.end();
    street.end();
  };

  // ---------- Who is where ----------
  let mode = "drive"; // or "foot"
  const playerPos = () => (mode === "drive" ? { x: vehicle.x, z: vehicle.z } : { x: people.player.x, z: people.player.z });

  // ---------- Photo mode ----------
  // The world pauses (like an open menu) and the camera circles you.
  const photo = new PhotoMode(scene, chase, world, daynight, {
    onLight: () => nightLights.update(daynight.night, false, playerPos(), traffic.cars),
  });
  $("btn-photo").addEventListener("click", () => {
    // (Not at the pump, where the button is hidden too, mid-splash, or while
    // another vehicle is loading.)
    if (mode === "fuel" || vehicle.inWater || swapping) return;
    photo.enter(mode === "foot" ? people.player : vehicle, mode === "foot" ? null : car);
  });

  // ---------- Speed camera photos ----------
  // Taken when a speed trap or a town's speed camera catches you over the
  // limit, and kept in the album (in Settings, or tap the new photo's card).
  const album = new PhotoAlbum({ units: () => settings.units, deliver: (file, say) => photo.deliver(file, say), settings: () => $("settings") });
  let cabinShown = false;
  const photos = new SpeedPhotos(scene, {
    subject: () => vehicle,
    units: () => settings.units,
    clock: () => daynight.clock,
    shutter: () => audio.shutter(),
    // At night the camera's flash lights the car up.
    flash: () => 1 + 0.8 * daynight.night,
    // From outside, your car has its windows (the Driver view takes them out).
    before: () => {
      cabinShown = cabin.shown;
      cabin.setShown(false);
    },
    after: () => cabin.setShown(cabinShown),
    keep: (rec) => album.add(rec),
    open: (rec) => album.view(rec),
  });

  const input = new Input();
  const resetCar = () => {
    endRaces();
    const { road: r, index } = world.network.nearest(vehicle.x, vehicle.z);
    const [x, z] = r.points[index];
    const [tx, tz] = r.tangents[index];
    const isl = world.islandAt(x, z);
    const lane = isl && isl.def.drive === "left" ? -LANE_OFFSET : LANE_OFFSET;
    vehicle.place(x + tz * lane, z - tx * lane, Math.atan2(tx, tz));
    damage.repair();
    chase._first = true;
  };
  input.handlers.camera = () => {
    if (photo.active) return;
    toast(chase.cycle());
    settings.cameraMode = chase.mode;
    saveSettings(settings);
  };
  input.handlers.reset = () => mode === "drive" && !photo.active && resetCar();
  input.handlers.any = () => {
    if (autodriver.active && mode === "drive" && !photo.active) {
      autodriver.stop();
      $("auto-chip").hidden = true;
      toast("Self-driving off — you're driving");
    }
  };
  input.attachKeyboard();
  input.attachTouch({
    steerZone: $("steer-zone"),
    wheel: $("wheel"),
    stick: $("stick"),
    stickKnob: $("stick-knob"),
    gas: $("btn-gas"),
    brake: $("btn-brake"),
    reverse: $("btn-reverse"),
    horn: $("btn-horn"),
    look: $("btn-look"),
  });
  $("btn-camera").addEventListener("click", () => input.handlers.camera());
  $("btn-reset").addEventListener("click", () => mode === "drive" && resetCar());
  $("btn-time").addEventListener("click", () => {
    const i = TIME_PRESETS.findIndex((p) => p.id === daynight.phase);
    const next = TIME_PRESETS[(i + 1) % TIME_PRESETS.length];
    daynight.jumpTo(next.id);
    settings.hour = daynight.hour;
    saveSettings(settings);
    toast(next.name);
  });
  // Mute button (the same switch as Sound in Settings).
  const setSound = (on) => {
    settings.sound = on;
    audio.setEnabled(on);
    saveSettings(settings);
    $("btn-sound").classList.toggle("muted", !on);
  };
  setSound(settings.sound);
  $("btn-sound").addEventListener("click", () => {
    setSound(!settings.sound);
    toast(settings.sound ? "Sound on" : "Sound off");
  });
  $("btn-weather").addEventListener("click", () => {
    const w = weather.cycle();
    settings.weather = w.id;
    saveSettings(settings);
    toast(w.name);
  });

  // ---------- Getting out and swapping cars ----------
  const setMode = (m) => {
    mode = m;
    const foot = m === "foot";
    input.footMode = foot;
    $("hud").classList.toggle("hud-foot", foot);
    $("hud").classList.toggle("hud-fuel", m === "fuel");
    // (An <svg> ignores the `hidden` property, so use display.)
    $("wheel").style.display = m === "drive" ? "" : "none";
    $("stick").hidden = !foot;
    people.player.hidden = !foot;
    chase._first = true;
  };
  let nearbyCar = null;
  const refuel = new Refuel(scene, world, people);

  // ---------- Out of fuel: calling for help ----------
  // A road service truck comes along the roads and fills you up for free.
  const rescue = new Rescue({
    world,
    navigator,
    vehicle,
    traffic,
    fuel,
    lights,
    colliders,
    hooks: {
      kinds: { load: trafficKind, release: releaseKinds },
      camera: () => chase.camera,
      toast,
      call: () => {
        if (!fuel.empty || mode === "fuel" || photo.active) return;
        endRaces();
        autodriver.stop();
        $("auto-chip").hidden = true;
        rescue.call();
      },
      filled: () => {
        settings.fuel = fuel.level;
        saveSettings(settings);
      },
    },
  });
  let wasEmpty = fuel.empty;
  $("btn-fuel").addEventListener("click", () => {
    const at = pumpSpotAt(stations, vehicle);
    if (!at || mode !== "drive" || race.active || street.active) return;
    if (fuel.level > 0.99) {
      toast(fuel.electric ? "Already fully charged" : "Your tank is already full");
      return;
    }
    autodriver.stop();
    $("auto-chip").hidden = true;
    rescue.cancel();
    setMode("fuel");
    $("fuel-chip").hidden = false;
    refuel.start({
      station: at.station,
      vehicle,
      fuel,
      onDone: () => {
        $("fuel-chip").hidden = true;
        setMode("drive");
        settings.fuel = fuel.level;
        saveSettings(settings);
        toast(fuel.electric ? "Fully charged" : "Full tank");
      },
    });
  });
  $("btn-fuel-skip").addEventListener("click", () => refuel.skip());
  $("btn-action").addEventListener("click", async () => {
    if (swapping) return;
    if (mode === "drive") {
      endRaces();
      // Step out on the driver's side. If that spot is far below the car (off
      // the edge of a bridge deck), try the other side, then right beside the
      // car, so you never drop into the sea.
      const lx = -Math.cos(vehicle.heading);
      const lz = Math.sin(vehicle.heading);
      const half = car.geometry.halfWidth ?? 1;
      let px = vehicle.x, pz = vehicle.z, py = vehicle.y;
      for (const out of [half + 0.8, -(half + 0.8), half + 0.2, -(half + 0.2)]) {
        const x = vehicle.x + lx * out;
        const z = vehicle.z + lz * out;
        const y = world.getHeight(x, z);
        if (Math.abs(y - vehicle.y) < 2) { px = x; pz = z; py = y; break; }
      }
      people.player.x = px;
      people.player.z = pz;
      people.player.y = py;
      people.player.heading = vehicle.heading;
      chase.footYaw = vehicle.heading;
      autodriver.stop();
      $("auto-chip").hidden = true;
      setMode("foot");
      return;
    }
    if (!nearbyCar) return;
    if (nearbyCar !== "own") {
      // Swap: your old vehicle is left parked here, you take this one.
      const t = nearbyCar;
      const left = { x: vehicle.x, z: vehicle.z, heading: vehicle.heading, colour: paint?.colour ?? [0.6, 0.6, 0.6], kind: carEntry.model ?? "gt" };
      const entry = GARAGE.find((g) => g.model && g.model === t.type.id) ?? GARAGE[0];
      swapping = true;
      try {
        await swapCar(entry, entry.model ? null : { colour: t.colour, metallic: 0.75, roughness: 0.22 });
        traffic.remove(t);
        vehicle.place(t.x, t.z, t.yaw);
        traffic.addParked(left.x, left.z, left.heading, left.colour, await trafficKind(left.kind)).abandoned = true;
      } finally {
        swapping = false;
      }
      // Someone else's vehicle: the tank (or battery) is part full.
      fuel.level = 0.35 + Math.random() * 0.6;
      rescue.cancel();
      toast(`${entry.model ? entry.name : "New car"}${fuel.electric ? " (electric)" : ""} — enjoy!`);
    }
    setMode("drive");
  });

  // ---------- Big map ----------
  const mapPanel = $("map-panel");
  const bigmap = new BigMap($("bigmap"), mapImage, (x, z) => pickDestination(x, z, "Picked spot"));
  function pickDestination(x, z, name, station = null) {
    const p = playerPos();
    const route = navigator.route(p.x, p.z, station ? station.ox : x, station ? station.oz : z);
    if (!route) return;
    // To a fuel station: turn in and stop at a pump.
    if (station) route.points = stationApproach(route.points, station);
    const end = route.points[route.points.length - 1];
    picked = { route, name, x: end.x, z: end.z };
    bigmap.route = route;
    bigmap.destination = picked;
    bigmap.draw();
    $("route-info").textContent = `${name} · ${(route.length / 1000).toFixed(1)} km`;
    $("btn-drive-there").disabled = mode !== "drive";
    $("btn-show-route").disabled = false;
    $("btn-clear-route").disabled = false;
  }
  // Fuel stations: the nearest one, then each by name.
  setFuelStations(stations);
  const nearestStation = () => {
    const p = playerPos();
    return stations.reduce((best, s) => (!best || Math.hypot(s.x - p.x, s.z - p.z) < Math.hypot(best.x - p.x, best.z - p.z) ? s : best), null);
  };
  // (Listed under their country, so "Fuel station · Britain north" shows as "North".)
  const shortName = (s) => {
    const n = s.name.replace("Fuel station · ", "").replace(`${s.island.name} `, "");
    return n[0].toUpperCase() + n.slice(1);
  };
  for (const s of stations) PLACES.push({ name: shortName(s), country: s.island.name, x: s.x, z: s.z, station: s });
  // Drag strips: picking one drives you into its staging box.
  setDragStrips(strips);
  for (const s of strips) {
    const country = world.islandById(s.island).def.name;
    const where = s.name.replace("Drag strip · ", "").replace(`${country} `, "");
    PLACES.push({ name: `${where[0].toUpperCase()}${where.slice(1)} strip`, country, x: s.tx, z: s.tz, strip: s });
  }
  // Street races: picking one drives you to its start gate.
  setStreetRaces(streetRaces);
  for (const r of streetRaces) PLACES.push({ name: r.name, country: r.country, x: r.tx, z: r.tz, street: r });
  // Speed traps: picking one takes you to its line.
  setSpeedTraps([...traps, ...townCameras]);
  for (const t of traps) PLACES.push({ name: t.name, country: world.islandById(t.island).def.name, x: t.x, z: t.z, trap: t });
  // Places, a country at a time: pick a country, then its landmarks, towns or
  // fuel stations. Starts on the country you're in.
  const COUNTRIES = world.islands.map((isl) => ({ id: isl.def.id, name: isl.def.name, x: isl.def.cx, z: isl.def.cz, flag: flagPicture(isl.def.id) }));
  const KINDS = [
    ["landmark", "Landmarks"],
    ["town", "Towns"],
    ["fuel", "Fuel"],
    ["race", "Races"],
  ];
  const kindOf = (p) => (p.strip || p.street || p.trap ? "race" : p.station ? "fuel" : p.landmark ? "landmark" : "town");
  let placeCountry = COUNTRIES[0];
  let placeKind = "landmark";
  const button = (parent, html, onClick, on = false) => {
    const b = document.createElement("button");
    b.innerHTML = html;
    if (on) b.className = "on";
    b.addEventListener("click", onClick);
    parent.appendChild(b);
    return b;
  };
  const row = (parent, cls) => {
    const d = document.createElement("div");
    d.className = cls;
    parent.appendChild(d);
    return d;
  };
  const renderPlaces = () => {
    const box = $("places");
    box.innerHTML = "";
    button(row(box, "place-quick"), `Nearest fuel station<small>Fill up or charge</small>`, () => {
      const s = nearestStation();
      if (!s) return;
      pickDestination(s.x, s.z, s.name, s);
      bigmap.centreOn(s.x, s.z);
    });
    const countries = row(box, "place-countries");
    for (const c of COUNTRIES) {
      button(countries, `<img src="${c.flag}" alt="">${c.name}`, () => {
        placeCountry = c;
        bigmap.centreOn(c.x, c.z);
        renderPlaces();
      }, c === placeCountry);
    }
    const kinds = row(box, "place-kinds");
    for (const [k, label] of KINDS) {
      button(kinds, label, () => {
        placeKind = k;
        renderPlaces();
      }, k === placeKind);
    }
    const list = row(box, "place-list");
    const me = playerPos();
    for (const p of PLACES.filter((q) => q.country === placeCountry.name && kindOf(q) === placeKind)) {
      const km = Math.hypot(p.x - me.x, p.z - me.z) / 1000;
      // (A drag strip also shows your best time there, and your best medal;
      // a speed trap your best speed.)
      const best = p.strip ? race.bestText(p.strip) : p.street ? street.bestText(p.street) : p.trap ? speedTraps.bestText(p.trap) : "";
      const medal = p.strip || p.street ? settings.races[(p.strip ?? p.street).id]?.medal : null;
      const what = p.street ? `Street race, ${(p.street.length / 1000).toFixed(1)} km · ` : "";
      button(list, `${p.name}<small>${what}${km < 1 ? "Under 1 km away" : `${km.toFixed(1)} km away`}${best ? ` · ${best}` : ""}${medal ? `<i class="medal-dot ${medal}"></i>` : ""}</small>`, () => {
        pickDestination(p.x, p.z, p.station?.name ?? p.strip?.name ?? p.name, p.station ?? null);
        bigmap.centreOn(p.x, p.z);
      });
    }
  };
  renderPlaces();
  $("minimap").addEventListener("click", () => {
    endRaces();
    mapPanel.hidden = false;
    // Start on the country you're in (on a bridge, keep the last one).
    const here = playerPos();
    const isl = world.islandAt(here.x, here.z);
    placeCountry = COUNTRIES.find((c) => c.id === isl?.def.id) ?? placeCountry;
    renderPlaces();
    const p = playerPos();
    bigmap.route = guide?.route ?? null;
    bigmap.destination = guide ? { x: guide.x, z: guide.z } : null;
    bigmap.open({ x: p.x, z: p.z, heading: mode === "drive" ? vehicle.heading : people.player.heading });
  });
  $("btn-zoom-in").addEventListener("click", () => bigmap.zoomBy(1.4));
  $("btn-zoom-out").addEventListener("click", () => bigmap.zoomBy(1 / 1.4));
  $("btn-zoom-me").addEventListener("click", () => {
    const p = playerPos();
    bigmap.centreOn(p.x, p.z);
  });
  $("btn-map-close").addEventListener("click", () => (mapPanel.hidden = true));
  $("btn-show-route").addEventListener("click", () => {
    if (!picked) return;
    guide = { ...picked, progress: 0 };
    mapPanel.hidden = true;
    toast(`Showing the way to ${picked.name}`);
  });
  $("btn-drive-there").addEventListener("click", () => {
    if (!picked || mode !== "drive") return;
    if (fuel.empty) {
      toast(fuel.electric ? "Out of charge. Call for help first" : "Out of fuel. Call for help first");
      return;
    }
    guide = { ...picked, progress: 0 };
    autodriver.start(picked.route);
    $("auto-text").textContent = `Self-driving to ${picked.name}`;
    $("auto-chip").hidden = false;
    mapPanel.hidden = true;
  });
  $("btn-clear-route").addEventListener("click", () => {
    guide = null;
    picked = null;
    autodriver.stop();
    $("auto-chip").hidden = true;
    bigmap.route = null;
    bigmap.destination = null;
    bigmap.draw();
    $("route-info").textContent = "";
    for (const id of ["btn-drive-there", "btn-show-route", "btn-clear-route"]) $(id).disabled = true;
  });
  $("btn-auto-stop").addEventListener("click", () => {
    autodriver.stop();
    $("auto-chip").hidden = true;
    toast("Self-driving off — you're driving");
  });

  // ---------- Garage ----------
  // Every vehicle is free to drive: tap one to swap to it.
  const garagePanel = $("garage-panel");
  const drive = async (g, card) => {
    if (swapping || g === carEntry) return;
    swapping = true;
    card?.classList.add("loading");
    try {
      await swapCar(g);
      fuel.level = 1;
      rescue.cancel();
      settings.car = g.id;
      saveSettings(settings);
    } catch (err) {
      console.warn("couldn't load", g.id, err);
      toast("Couldn't load that one — try again");
    } finally {
      swapping = false;
      renderGarage();
    }
  };
  // The garage is laid out like a car show: brands down the side (with how
  // many of each), the kind of car and its country along the top, and a
  // choice of order. The real cars show their brand, model and year; every
  // card shows power, 0-100 (or 0-60) and top speed as the game drives it.
  const OTHER = "Other cars";
  const SERVICE = "Service vehicles";
  const brandOf = (g) => g.brand ?? (g.kind === "service" ? SERVICE : OTHER);
  const SORTS = [
    ["name", "Name"],
    ["power", "Power"],
    ["year", "Year"],
  ];
  const show = { brand: null, kind: null, country: null, sort: "name" };
  const chip = (parent, label, on, onClick) => {
    const b = document.createElement("button");
    b.className = "pick" + (on ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    parent.appendChild(b);
  };
  const statLine = (g) => {
    const p = figures(g);
    const mph = settings.units === "mph";
    const top = mph ? `${Math.round(p.topKmh * 0.621371)} mph` : `${p.topKmh} km/h`;
    const sprint = mph ? `0–${p.slow ? 50 : 60} in ${p.zeroTo60.toFixed(1)}` : `0–${p.slow ? 80 : 100} in ${p.zeroTo100.toFixed(1)}`;
    return `${p.hp.toLocaleString("en-GB")} hp · ${sprint} s · ${top}`;
  };
  const sorted = (list) => {
    const by = {
      power: (a, b) => figures(b).hp - figures(a).hp,
      name: (a, b) => a.name.localeCompare(b.name),
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name),
    }[show.sort];
    return [...list].sort(by);
  };
  const renderGarage = () => {
    // Brands, with how many cars each has (the real brands A to Z, then the rest).
    const brands = $("garage-brands");
    brands.innerHTML = "";
    const count = new Map();
    for (const g of GARAGE) count.set(brandOf(g), (count.get(brandOf(g)) ?? 0) + 1);
    const names = [...count.keys()].filter((b) => b !== OTHER && b !== SERVICE).sort((a, b) => a.localeCompare(b));
    const brandButton = (label, value, n) => {
      const b = document.createElement("button");
      if (show.brand === value) b.className = "on";
      const name = document.createElement("span");
      name.textContent = label;
      const many = document.createElement("small");
      many.textContent = n;
      b.append(name, many);
      b.addEventListener("click", () => {
        show.brand = value;
        renderGarage();
        $("garage-list").scrollTop = 0;
      });
      brands.appendChild(b);
    };
    brandButton("All cars", null, GARAGE.length);
    for (const name of [...names, OTHER, SERVICE]) if (count.has(name)) brandButton(name, name, count.get(name));

    // Kind of car and country: only the ones the chosen brand has.
    const inBrand = GARAGE.filter((g) => !show.brand || brandOf(g) === show.brand);
    const kinds = [...new Set(inBrand.map((g) => g.class).filter(Boolean))].sort();
    const countries = [...new Set(inBrand.map((g) => g.country).filter(Boolean))].sort();
    if (show.kind && !kinds.includes(show.kind)) show.kind = null;
    if (show.country && !countries.includes(show.country)) show.country = null;
    const kindRow = $("garage-kinds");
    kindRow.innerHTML = "";
    kindRow.hidden = kinds.length < 2;
    chip(kindRow, "Every kind", !show.kind, () => ((show.kind = null), renderGarage()));
    for (const k of kinds) chip(kindRow, k, show.kind === k, () => ((show.kind = k), renderGarage()));
    const countryRow = $("garage-countries");
    countryRow.innerHTML = "";
    countryRow.hidden = countries.length < 2;
    chip(countryRow, "Every country", !show.country, () => ((show.country = null), renderGarage()));
    for (const c of countries) chip(countryRow, c, show.country === c, () => ((show.country = c), renderGarage()));
    const sortRow = $("garage-sort");
    sortRow.innerHTML = "";
    for (const [k, label] of SORTS) chip(sortRow, label, show.sort === k, () => ((show.sort = k), renderGarage()));

    const list = $("garage-list");
    list.innerHTML = "";
    const cars = sorted(inBrand.filter((g) => (!show.kind || g.class === show.kind) && (!show.country || g.country === show.country)));
    $("garage-count").textContent = `${cars.length} ${cars.length === 1 ? "car" : "cars"}`;
    for (const g of cars) {
      const card = document.createElement("button");
      card.className = "car-card" + (g === carEntry ? " on" : "");
      const tag = g === carEntry ? `<span class="tag now">Driving</span>` : "";
      card.innerHTML = `
        <img class="thumb" src="assets/vehicles/thumbs/${g.model ?? "concept"}.webp" alt="" loading="lazy">
        <div class="brand"></div>
        <div class="name"></div>
        <div class="trim"></div>
        <div class="figures">${statLine(g)}</div>
        <div class="card-foot">${tag}</div>`;
      card.querySelector(".brand").textContent = g.brand ?? (g.kind === "service" ? "Service vehicle" : "Game car");
      card.querySelector(".name").textContent = g.brand ? g.modelName : g.name;
      card.querySelector(".trim").textContent = g.real ? `${g.year} · ${g.class} · ${g.country}` : `${g.trim} · ${g.electric ? "Electric" : "Petrol"}`;
      card.addEventListener("click", () => drive(g, card));
      list.appendChild(card);
    }
  };
  // The real cars' credits, in the Settings panel (from the same list as the garage).
  for (const g of REAL) {
    const c = g.credit;
    const link = (text, url) => {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = text;
      return a;
    };
    const li = document.createElement("li");
    li.append(`${g.name}: "`, link(c.title, c.url), `" by ${c.author} (${c.license})`);
    if (c.via) li.append(`, from a copy uploaded as "`, link(c.via.title, c.via.url), `" by ${c.via.author}`);
    $("credit-cars").appendChild(li);
  }
  $("btn-garage").addEventListener("click", () => {
    endRaces();
    renderGarage();
    garagePanel.hidden = false;
  });
  $("btn-garage-close").addEventListener("click", () => (garagePanel.hidden = true));

  // ---------- Settings panel ----------
  const panel = $("settings");
  const markSeg = (id, value) => {
    for (const b of $(id).querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === value);
  };
  for (const w of [{ id: "auto", name: "Auto" }, ...WEATHERS]) {
    const b = document.createElement("button");
    b.dataset.v = w.id;
    b.textContent = w.name;
    $("seg-weather").appendChild(b);
  }
  const levelName = (l) => l[0].toUpperCase() + l.slice(1);
  const refreshPanel = () => {
    markSeg("seg-graphics", settings.graphics);
    markSeg("seg-units", settings.units);
    markSeg("seg-fuel", settings.fuelMode);
    markSeg("seg-fps", settings.showFps ? "on" : "off");
    markSeg("seg-sound", settings.sound ? "on" : "off");
    markSeg("seg-weather", weather.mode);
    $("graphics-note").textContent =
      settings.graphics === "auto" ? `Auto picked ${levelName(level)} for this device.` : "Changing this restarts the game.";
    $("unit").textContent = settings.units === "mph" ? "mph" : "km/h";
    $("fps").hidden = !settings.showFps;
  };
  $("btn-settings").addEventListener("click", () => {
    refreshPanel();
    panel.hidden = false;
  });
  $("btn-close").addEventListener("click", () => (panel.hidden = true));
  const onSeg = (id, fn) =>
    $(id).addEventListener("click", (e) => {
      const v = e.target.closest("button")?.dataset.v;
      if (v) fn(v);
      saveSettings(settings);
      refreshPanel();
    });
  onSeg("seg-graphics", (v) => {
    if (v === settings.graphics) return;
    settings.graphics = v;
    saveSettings(settings);
    $("graphics-note").textContent = "Restarting…";
    setTimeout(() => location.reload(), 250);
  });
  onSeg("seg-units", (v) => (settings.units = v));
  onSeg("seg-fuel", (v) => {
    settings.fuelMode = v;
    fuel.auto = v === "auto";
    // (Auto tops the tank up by itself, so help isn't needed.)
    if (fuel.auto) rescue.cancel();
  });
  onSeg("seg-fps", (v) => (settings.showFps = v === "on"));
  onSeg("seg-sound", (v) => setSound(v === "on"));
  onSeg("seg-weather", (v) => {
    weather.set(v);
    settings.weather = v;
  });
  refreshPanel();

  // ---------- Auto graphics: step down if the frame rate is low ----------
  const monitor = { warm: 6, time: 0, frames: 0, slow: 0 };
  const anyPanelOpen = () => !panel.hidden || !mapPanel.hidden || !garagePanel.hidden || photo.active || album.open;
  const stepDown = () => {
    const i = LEVELS.indexOf(level);
    if (i > 0) {
      level = LEVELS[i - 1];
      preset = { ...PRESETS[level], trees: preset.trees, rocks: preset.rocks };
      cover.setEnabled(level !== "low");
      // (Off before the effects are rebuilt, which would put it first in line.)
      if (edgeBlur && !preset.edgeBlur) {
        edgeBlur.dispose();
        edgeBlur = null;
      }
      applyScale();
      applyEffects();
      chase.camera.maxZ = preset.viewDistance;
      // Not saved: next launch checks again (e.g. once Low Power Mode is off).
      toast(`Graphics set to ${levelName(level)} so it runs smoothly`);
    } else if (preset.scale > 0.75) {
      preset.scale = Math.max(0.75, preset.scale - 0.15);
      applyScale();
    }
  };
  const watchFrameRate = (dt) => {
    if (settings.graphics !== "auto") return;
    // Ignore pauses (app in the background, menu open) so they don't count as slowness.
    if (document.hidden || anyPanelOpen() || dt > 0.25) {
      monitor.time = 0;
      monitor.frames = 0;
      return;
    }
    if (monitor.warm > 0) {
      monitor.warm -= dt;
      return;
    }
    monitor.time += dt;
    monitor.frames++;
    if (monitor.time >= 5) {
      const fps = monitor.frames / monitor.time;
      monitor.time = 0;
      monitor.frames = 0;
      // Two slow stretches in a row (10 s) before acting, so a one-off hitch
      // (e.g. loading new scenery) doesn't lower the graphics.
      monitor.slow = fps < 40 ? monitor.slow + 1 : 0;
      if (monitor.slow >= 2) {
        monitor.slow = 0;
        stepDown();
        monitor.warm = 3;
      }
    }
  };

  // ---------- Per-frame game logic ----------
  let country = null;
  let splashing = false;
  let lastImpact = 0;
  let saveTimer = 20;
  let landmarkTimer = 0;
  vehicle.onBump = (o, speed) => {
    if (o.car && o.car.moving && speed > 1) o.car.stopTimer = 3;
  };

  let hornTimer = 0;
  const tick = (realDt) => {
    // (A moment of slow motion as you cross a finish line: finishShow.js.)
    const dt = realDt * finishShow.timeScale;
    input.update();
    // Out of fuel (or being filled up by the road service): the engine gives
    // nothing, and the self-driving gives up.
    vehicle.engineOff = fuel.empty || rescue.holding;
    if (fuel.empty && autodriver.active) {
      autodriver.stop();
      $("auto-chip").hidden = true;
    }
    // Horn: people ahead step aside and the car in front pulls over (again
    // every so often while it's held).
    const hooting = mode === "drive" && input.horn;
    hornTimer = hooting ? hornTimer - dt : 0;
    if (hooting && hornTimer <= 0) {
      hornTimer = 1.2;
      people.honk(vehicle.x, vehicle.z, Math.sin(vehicle.heading), Math.cos(vehicle.heading));
      traffic.honk(vehicle.x, vehicle.z, vehicle.heading);
    }
    audio.setHorn(hooting);
    chase.lookBack = mode === "drive" && input.lookBack;
    const dynamicCars = traffic.colliders();
    let controls = IDLE;
    if (mode === "drive") {
      controls = input;
      const racing = race.active ? race : street.active ? street : null;
      if (racing) controls = racing.controls(input);
      else if (autodriver.active) {
        controls = autodriver.drive(vehicle, traffic, dt);
        if (autodriver.arrived) {
          $("auto-chip").hidden = true;
          toast(`You've arrived at ${guide?.name ?? "your destination"}`);
          guide = null;
        }
      }
      vehicle.dynamic = [...dynamicCars, ...people.colliders()];
      vehicle.update(dt, controls);
    } else if (mode === "fuel") {
      vehicle.dynamic = dynamicCars;
      vehicle.update(dt, IDLE);
      refuel.update(dt);
    } else {
      vehicle.dynamic = dynamicCars;
      vehicle.update(dt, IDLE);
      const fx = Math.sin(vehicle.heading);
      const fz = Math.cos(vehicle.heading);
      const own = vehicle.hitOffsets.map((o) => ({ x: vehicle.x + fx * o, z: vehicle.z + fz * o, r: vehicle.hitRadius + 0.2 }));
      people.movePlayer(dt, input.stick.x, input.stick.y, chase.yaw, colliders, [...dynamicCars, ...own]);
      // Which car could you get into?
      const p = people.player;
      const t = traffic.nearest(p.x, p.z, 3.6);
      nearbyCar = own.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < c.r + 1.8) ? "own" : t;
    }
    const me = playerPos();
    race.update(dt);
    street.update(dt);
    // (After the races, which move their cars, and before the traffic draws them.)
    finishShow.update(realDt);
    speedTraps.update(dt);
    rescue.update(dt);
    photos.update(dt);
    // Brake lights: the brake pedal, or Reverse or Gas stopping the car
    // rolling the other way (whoever is driving: you or the self-driving).
    const fwd = vehicle.forwardSpeed;
    const braking = mode === "drive" && (controls.brake > 0 || (controls.reverse > 0 && fwd > 0.8) || (controls.throttle > 0 && fwd < -0.8));
    carFx.begin();
    traffic.update(dt, mode === "foot" ? people.player : vehicle, chase.camera);
    carFx.add(car.root.computeWorldMatrix(true), playerFx, braking, car.body.computeWorldMatrix(true));
    carFx.end(daynight.night);
    tyres.update(dt, vehicle, 1 - 0.8 * daynight.night, weatherFx.x, mode === "drive");
    const fuelWarning = fuel.update(dt, vehicle, mode === "drive");
    if (fuelWarning) toast(fuelWarning);
    // Just run out: remembered at once (so a reload keeps you empty), and any race is over.
    if (fuel.empty !== wasEmpty) {
      wasEmpty = fuel.empty;
      if (wasEmpty) {
        endRaces();
        settings.fuel = 0;
        saveSettings(settings);
      }
    }
    people.update(dt, mode === "drive" ? vehicle : null);
    people.draw();
    weather.update(dt, chase.camera, vehicle);
    lights.update(dt);
    flags.update(dt);
    updateWind(dt);
    if (mode === "drive" && lights.ranRed(vehicle.x, vehicle.z, vehicle.vx, vehicle.vz)) toast("You went through a red light!");
    daynight.update(dt);
    damage.update(dt, vehicle, daynight.night);
    nightLights.update(daynight.night, braking, me, traffic.cars);
    landmarkTimer -= dt;
    if (landmarkTimer <= 0) {
      landmarkTimer = 1;
      landmarkModels.update(me.x, me.z);
      castNear(me.x, me.z);
    }
    // Remember the time of day now and then, so it carries on next time.
    saveTimer -= dt;
    if (saveTimer <= 0) {
      saveTimer = 20;
      settings.hour = daynight.hour;
      settings.fuel = fuel.level;
      saveSettings(settings);
    }

    // Crashes and splashes.
    if (vehicle.impact > lastImpact + 0.12) audio.crash(Math.min(1, vehicle.impact));
    lastImpact = vehicle.impact;
    if (vehicle.inWater && !splashing) {
      splashing = true;
      audio.splash();
      toast("Splash! Putting you back on the road");
      setTimeout(() => {
        if (mode === "foot") setMode("drive");
        resetCar();
        splashing = false;
      }, 1300);
    }

    // Which country are we in?
    const isl = world.islandAt(me.x, me.z);
    const name = isl ? isl.def.name : null;
    if (name && name !== country) {
      if (country) toast(`Welcome to ${name} — drive on the ${isl.def.drive}`);
      country = name;
    }
    audio.update(dt, { car: vehicle, onFoot: mode === "foot", inCabin: mode === "drive" && chase.modeName === "Driver", engineOff: vehicle.engineOff });

    // Keep the guide line's progress marker moving.
    if (guide) {
      if (autodriver.active) guide.progress = autodriver.progress;
      else {
        const pts = guide.route.points;
        let best = guide.progress;
        let bestD = Infinity;
        for (let i = guide.progress; i < Math.min(pts.length, guide.progress + 60); i++) {
          const d = (pts[i].x - me.x) ** 2 + (pts[i].z - me.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        guide.progress = best;
        // (A street race says when you're over the line itself.)
        if (!guide.race && Math.hypot(guide.x - me.x, guide.z - me.z) < 15) {
          toast(`You've arrived at ${guide.name}`);
          guide = null;
        }
      }
    }
  };

  // ---------- Go ----------
  setProgress(0.92, "Warming up…");
  await scene.whenReadyAsync();
  setProgress(1, "Ready");
  $("loading").hidden = true;
  $("hud").hidden = false;
  // People download in the background once you can drive.
  people
    .load()
    .then(() => {
      for (const m of people.meshList) csm.addShadowCaster(m, false);
    })
    .catch((err) => console.warn("People did not load", err));
  country = world.islandAt(vehicle.x, vehicle.z)?.def.name ?? null;

  // The camera for what you're doing. The cockpit kit shows only while you
  // drive in the Driver view: not on foot or at the pump, whatever the camera
  // button last picked.
  let cockpitHud = false;
  const moveCamera = (dt) => {
    if (photo.active) photo.update(dt);
    else if (finishShow.filming) finishShow.film(dt);
    else if (mode === "drive") chase.update(dt, vehicle);
    else if (mode === "fuel") refuel.camera(chase.camera);
    else chase.followPerson(dt, people.player);
    // (Hidden while you look behind, as the head turns away from it.)
    const inSeat = mode === "drive" && chase.inDriverSeat && !finishShow.filming;
    cabin.setShown(inSeat && !chase.lookingBack && !photo.active);
    if (cabin.shown) cabin.update(dt);
    // With the cockpit's own dials in view, the speed panel and the Get out
    // button move up out of their way (and stay there while you look behind).
    const kit = inSeat && !!car.cockpit;
    if (kit !== cockpitHud) {
      cockpitHud = kit;
      $("hud").classList.toggle("hud-cockpit", cockpitHud);
    }
    edgeBlur?.update(mode === "drive" && !finishShow.filming ? vehicle.speed : 0);
  };

  let fpsTimer = 0;
  let shownSpeed = -1;
  let shownLimit = -1;
  let shownFuel = -1;
  let shownElectric = null;
  let shownOver = false;
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    const paused = anyPanelOpen();
    audio.setPaused(paused);
    if (!paused) tick(dt);
    moveCamera(dt);

    const me = playerPos();
    const heading = mode === "drive" ? vehicle.heading : chase.yaw;
    minimap.draw(dt, me.x, me.z, heading, guide?.route ?? null, guide?.progress ?? 0, guide);

    const speed = Math.round(Math.abs(vehicle.forwardSpeed) * (settings.units === "mph" ? 2.23694 : 3.6));
    if (speed !== shownSpeed) {
      shownSpeed = speed;
      $("speed").textContent = speed;
    }
    // Speed limit sign, in the same units as the speed; the speed turns red when over.
    const limitKmh = speedLimitAt(vehicle.x, vehicle.z);
    const limit = settings.units === "mph" ? Math.round((limitKmh * 0.621371) / 5) * 5 : limitKmh;
    if (limit !== shownLimit) {
      shownLimit = limit;
      // (No limit on a drag strip: the sign shows a dash.)
      $("limit-num").textContent = Number.isFinite(limit) ? limit : "–";
    }
    const over = speed > limit;
    if (over !== shownOver) {
      shownOver = over;
      $("speedo").classList.toggle("over", over);
    }
    // Fuel gauge, and the Fill up button when you're stopped at a pump.
    const fuelPct = Math.round(fuel.level * 100);
    if (fuelPct !== shownFuel || fuel.electric !== shownElectric) {
      shownFuel = fuelPct;
      shownElectric = fuel.electric;
      $("fuel-fill").style.width = `${fuelPct}%`;
      $("fuel-pct").textContent = `${fuelPct}%`;
      const gauge = $("fuel");
      gauge.classList.toggle("electric", fuel.electric);
      gauge.classList.toggle("low", fuel.level <= 0.2);
      gauge.classList.toggle("empty", fuel.level <= NEARLY_EMPTY);
    }
    if (mode === "fuel") $("fuel-text").textContent = refuel.status;
    const fuelBtn = $("btn-fuel");
    fuelBtn.hidden = !(mode === "drive" && vehicle.speed < 0.8 && !autodriver.active && !race.active && !street.active && pumpSpotAt(stations, vehicle));
    if (!fuelBtn.hidden) fuelBtn.textContent = fuel.electric ? "Charge" : "Fill up";
    // Out of fuel: the Call for help card (not at a pump, where Fill up shows instead).
    rescue.hud(fuel.empty && mode !== "fuel" && fuelBtn.hidden);
    // Get out (when stopped) / Get in (next to a car).
    const action = $("btn-action");
    if (mode === "fuel") action.hidden = true;
    else if (mode === "drive") {
      action.hidden = vehicle.speed > 2 || autodriver.active;
      action.textContent = "Get out";
    } else {
      action.hidden = !nearbyCar;
      action.textContent = nearbyCar === "own" ? "Get in" : "Get in this car";
    }
    fpsTimer += dt;
    if (fpsTimer > 0.5) {
      fpsTimer = 0;
      $("fps").textContent = `${daynight.clock} · ${Math.round(engine.getFps())} fps · ${levelName(level)}`;
    }
    watchFrameRate(dt);
    scene.render();
  });

  if (import.meta.env.DEV) {
    // Test hooks: run the game forward by hand (used when the tab is hidden).
    const step = (frames, dt = 1 / 60) => {
      for (let i = 0; i < frames; i++) {
        if (!photo.active) tick(dt); // (paused, as in the render loop)
        moveCamera(dt);
      }
      scene.render();
    };
    const placeOn = (roadIndex, i) => {
      const r = world.network.roads[roadIndex];
      const [x, z] = r.points[i];
      const [tx, tz] = r.tangents[i];
      vehicle.place(x, z, Math.atan2(tx, tz));
      chase._first = true;
    };
    window.__game = { engine, scene, world, vehicle, chase, sky, csm, pipeline, nature, cover, input, step, placeOn, traffic, people, weather, audio, navigator, autodriver, daynight, nightLights, damage, lights, stations, fuel, refuel, landmarkModels, flags, setMode, get mode() { return mode; }, pickDestination, race, strips, dragParts, traps, townCameras, speedTraps, trapParts, rescue, photos, album, street, streetRaces, show: finishShow, gateParts, settings, GARAGE, swapCar, cabin, photo, get car() { return car; }, carFx, tyres, get edgeBlur() { return edgeBlur; } };
  }
}

start().catch((err) => {
  console.error(err);
  setProgress(1, "Something went wrong loading the game. Try closing and opening it again.");
});
