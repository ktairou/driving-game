import { Engine, Scene, Color4, DefaultRenderingPipeline, ImageProcessingConfiguration, ColorCurves } from "@babylonjs/core";
import { PRESETS, LEVELS, loadSettings, saveSettings, startingLevel } from "./quality.js";
import { setupSky, createShadows } from "./sky.js";
import { World } from "./world/world.js";
import { Colliders } from "./world/colliders.js";
import { buildTerrain } from "./world/terrain.js";
import { buildRoad } from "./world/road.js";
import { buildTown } from "./world/town.js";
import { buildLandmarks } from "./world/landmarks.js";
import { buildNature } from "./world/nature.js";
import { buildParks } from "./world/parks.js";
import { buildFlags, flagPicture } from "./world/flags.js";
import { SPAWN, LANE_OFFSET } from "./world/layout.js";
import { loadCar, loadCarLod, loadVehicle, loadVehicleLod } from "./car/carModel.js";
import { Vehicle } from "./car/vehicle.js";
import { CarDamage } from "./car/damage.js";
import { TrafficLights, speedLimitAt } from "./world/trafficLights.js";
import { planStations, buildStations, stationApproach } from "./world/stations.js";
import { LandmarkModels } from "./world/landmarkModels.js";
import { Fuel, Refuel, pumpSpotAt, FUEL_FLOOR } from "./fuel.js";
import { ChaseCamera } from "./camera.js";
import { Input } from "./input.js";
import { Weather, WEATHERS } from "./weather.js";
import { GameAudio } from "./audio.js";
import { Traffic, TRAFFIC_MIX } from "./traffic.js";
import { People } from "./people.js";
import { Navigator, AutoDriver } from "./navigation.js";
import { renderMapImage, MiniMap, BigMap, PLACES, setFuelStations } from "./map.js";
import { GARAGE, stats, applyPaint } from "./garage.js";
import { DayNight, TIME_PRESETS } from "./daynight.js";
import { NightLights } from "./nightlights.js";

const $ = (id) => document.getElementById(id);

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
  const landmarkModels = new LandmarkModels(scene, world, colliders);
  const parks = buildParks(scene, world, colliders, town.parks, preset, town.lampGlow);
  town.lampSpots.push(...stationParts.lampSpots, ...parks.lampSpots);
  const flags = buildFlags(scene, world, colliders, { roofs: town.roofs, parks: town.parks, stations });
  // (Mixed in near the front, so some people stroll in the parks even when there are few people.)
  parks.walkSpots.forEach((sp, i) => town.pavementSpots.splice(Math.min(town.pavementSpots.length, i * 3), 0, sp));
  setProgress(0.42, "Planting trees…");
  await nextFrame();
  const nature = buildNature(scene, world, colliders, preset, parks.trees);

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
  // Fewer kinds of vehicle on the Low setting (each kind costs graphics memory).
  const mix = TRAFFIC_MIX.filter((t) => level !== "low" || !t.more);
  let loadedKinds = 0;
  const kinds = await Promise.all(
    mix.map(async (t) => {
      try {
        const v = await loadVehicleLod(scene, t.id);
        setProgress(0.7 + (++loadedKinds / mix.length) * 0.15, "Filling the roads…");
        return { ...t, ...v };
      } catch (err) {
        console.warn("couldn't load traffic", t.id, err);
        return null;
      }
    }),
  );
  const lights = new TrafficLights(scene, world, colliders);
  const traffic = new Traffic(scene, world, [{ id: "gt", mesh: lod, length: 4.6, halfWidth: 1.0, weight: 1, parked: true, coloured: true }, ...kinds.filter(Boolean)], preset);
  traffic.lights = lights;
  const people = new People(scene, world, town.pavementSpots, preset, false);

  const chase = new ChaseCamera(scene, world, car, settings.cameraMode);
  chase.camera.maxZ = preset.viewDistance;
  scene.activeCamera = chase.camera;
  chase.update(0, vehicle);

  const csm = createShadows(scene, sky.light, chase.camera, preset);
  for (const m of [...car.shadowMeshes, ...town.casters, ...nature.casters, ...road.casters, ...landmarks.casters, ...traffic.types.map((t) => t.mesh), ...lights.casters, ...stationParts.casters, ...parks.casters, ...flags.casters]) csm.addShadowCaster(m, false);
  // Real landmark models load as you get near them.
  landmarkModels.onLoaded = (meshes) => meshes.forEach((m) => csm.addShadowCaster(m, false));
  landmarkModels.update(SPAWN.x, SPAWN.z);


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

  // ---------- Weather and sound ----------
  const findMats = (re) => scene.materials.filter((m) => re.test(m.name));
  const asphalt = findMats(/^(asphalt|asphaltTop|paintWhite|paintYellow|pavers)$/);
  for (const m of asphalt) m._baseTint = m.albedoColor.clone();
  const weather = new Weather(scene, sky, world, preset, { asphalt, leaves: findMats(/^leaves/) });
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
    damage.setCar(car);
    nightLights.setCar(car);
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
      const v = await loadVehicleLod(scene, id);
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
  document.addEventListener("pointerdown", () => audio.start(), true);
  document.addEventListener("keydown", () => audio.start(), true);

  // ---------- Map and self-driving ----------
  const navigator = new Navigator(world);
  const autodriver = new AutoDriver(world, navigator);
  autodriver.lights = lights;
  autodriver.colliders = colliders;
  const mapImage = renderMapImage(world, town.parks);
  const minimap = new MiniMap($("minimap"), mapImage);
  let guide = null; // { route, name, progress }
  let picked = null; // destination chosen on the big map

  // ---------- Who is where ----------
  let mode = "drive"; // or "foot"
  const playerPos = () => (mode === "drive" ? { x: vehicle.x, z: vehicle.z } : { x: people.player.x, z: people.player.z });

  const input = new Input();
  const resetCar = () => {
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
    toast(chase.cycle());
    settings.cameraMode = chase.mode;
    saveSettings(settings);
  };
  input.handlers.reset = () => mode === "drive" && resetCar();
  input.handlers.any = () => {
    if (autodriver.active && mode === "drive") {
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
  $("btn-fuel").addEventListener("click", () => {
    const at = pumpSpotAt(stations, vehicle);
    if (!at || mode !== "drive") return;
    if (fuel.level > 0.99) {
      toast(fuel.electric ? "Already fully charged" : "Your tank is already full");
      return;
    }
    autodriver.stop();
    $("auto-chip").hidden = true;
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
      // Step out on the driver's side.
      const lx = -Math.cos(vehicle.heading);
      const lz = Math.sin(vehicle.heading);
      const out = (car.geometry.halfWidth ?? 1) + 0.8;
      people.player.x = vehicle.x + lx * out;
      people.player.z = vehicle.z + lz * out;
      people.player.y = world.getHeight(people.player.x, people.player.z);
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
  // Places, a country at a time: pick a country, then its landmarks, towns or
  // fuel stations. Starts on the country you're in.
  const COUNTRIES = world.islands.map((isl) => ({ id: isl.def.id, name: isl.def.name, x: isl.def.cx, z: isl.def.cz, flag: flagPicture(isl.def.id) }));
  const KINDS = [
    ["landmark", "Landmarks"],
    ["town", "Towns"],
    ["fuel", "Fuel"],
  ];
  const kindOf = (p) => (p.station ? "fuel" : p.landmark ? "landmark" : "town");
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
      button(list, `${p.name}<small>${km < 1 ? "Under 1 km away" : `${km.toFixed(1)} km away`}</small>`, () => {
        pickDestination(p.x, p.z, p.station?.name ?? p.name, p.station ?? null);
        bigmap.centreOn(p.x, p.z);
      });
    }
  };
  renderPlaces();
  $("minimap").addEventListener("click", () => {
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
  const garagePanel = $("garage-panel");
  const renderGarage = () => {
    const list = $("garage-list");
    list.innerHTML = "";
    let lastKind = null;
    for (const g of GARAGE) {
      if (g.kind !== lastKind) {
        lastKind = g.kind;
        const head = document.createElement("div");
        head.className = "garage-group";
        head.textContent = g.kind === "service" ? "Service vehicles" : "Cars";
        list.appendChild(head);
      }
      const s = stats(g);
      const card = document.createElement("button");
      card.className = "car-card" + (g === carEntry ? " on" : "");
      card.innerHTML = `
        <img class="thumb" src="assets/vehicles/thumbs/${g.model ?? "concept"}.webp" alt="" loading="lazy">
        <div class="name">${g.name}</div>
        <div class="trim">${g.trim} · ${g.electric ? "Electric" : "Petrol"}</div>
        ${["speed", "acceleration", "grip"].map((k) => `<div class="stat">${k[0].toUpperCase() + k.slice(1)}<span class="bar"><i style="width:${Math.round(s[k] * 100)}%"></i></span></div>`).join("")}`;
      card.addEventListener("click", async () => {
        if (swapping || g === carEntry) return;
        swapping = true;
        card.classList.add("loading");
        try {
          await swapCar(g);
          fuel.level = 1;
          settings.car = g.id;
          saveSettings(settings);
        } catch (err) {
          console.warn("couldn't load", g.id, err);
          toast("Couldn't load that one — try again");
        } finally {
          swapping = false;
          renderGarage();
        }
      });
      list.appendChild(card);
    }
  };
  $("btn-garage").addEventListener("click", () => {
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
  const anyPanelOpen = () => !panel.hidden || !mapPanel.hidden || !garagePanel.hidden;
  const stepDown = () => {
    const i = LEVELS.indexOf(level);
    if (i > 0) {
      level = LEVELS[i - 1];
      preset = { ...PRESETS[level], trees: preset.trees, rocks: preset.rocks };
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

  const tick = (dt) => {
    input.update();
    const dynamicCars = traffic.colliders();
    if (mode === "drive") {
      let controls = input;
      if (autodriver.active) {
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
    traffic.update(dt, mode === "foot" ? people.player : vehicle, chase.camera);
    const fuelWarning = fuel.update(dt, vehicle, mode === "drive");
    if (fuelWarning) toast(fuelWarning);
    people.update(dt, mode === "drive" ? vehicle : null);
    people.draw();
    weather.update(dt, chase.camera, vehicle);
    lights.update(dt);
    flags.update(dt);
    if (mode === "drive" && lights.ranRed(vehicle.x, vehicle.z, vehicle.vx, vehicle.vz)) toast("You went through a red light!");
    daynight.update(dt);
    damage.update(dt, vehicle, daynight.night);
    nightLights.update(daynight.night, mode === "drive" && vehicle.forwardSpeed > 0.5 && (autodriver.active ? false : input.brake > 0), me, traffic.cars);
    landmarkTimer -= dt;
    if (landmarkTimer <= 0) {
      landmarkTimer = 1;
      landmarkModels.update(me.x, me.z);
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
    audio.update(dt, { car: vehicle, onFoot: mode === "foot", inCabin: mode === "drive" && chase.modeName === "Driver" });

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
        if (Math.hypot(guide.x - me.x, guide.z - me.z) < 15) {
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
    if (mode === "drive") chase.update(dt, vehicle);
    else if (mode === "fuel") refuel.camera(chase.camera);
    else chase.followPerson(dt, people.player);

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
      $("limit-num").textContent = limit;
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
      gauge.classList.toggle("empty", fuel.level <= FUEL_FLOOR + 0.001);
    }
    if (mode === "fuel") $("fuel-text").textContent = refuel.status;
    const fuelBtn = $("btn-fuel");
    fuelBtn.hidden = !(mode === "drive" && vehicle.speed < 0.8 && !autodriver.active && pumpSpotAt(stations, vehicle));
    if (!fuelBtn.hidden) fuelBtn.textContent = fuel.electric ? "Charge" : "Fill up";
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
        tick(dt);
        if (mode === "drive") chase.update(dt, vehicle);
        else if (mode === "fuel") refuel.camera(chase.camera);
        else chase.followPerson(dt, people.player);
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
    window.__game = { engine, scene, world, vehicle, chase, sky, csm, pipeline, nature, input, step, placeOn, traffic, people, weather, audio, navigator, autodriver, daynight, nightLights, damage, lights, stations, fuel, refuel, landmarkModels, flags, setMode, get mode() { return mode; }, pickDestination };
  }
}

start().catch((err) => {
  console.error(err);
  setProgress(1, "Something went wrong loading the game. Try closing and opening it again.");
});
