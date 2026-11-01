import { Engine, Scene, Color4, DefaultRenderingPipeline, ImageProcessingConfiguration, ColorCurves } from "@babylonjs/core";
import { PRESETS, LEVELS, loadSettings, saveSettings, startingLevel } from "./quality.js";
import { setupSky, createShadows } from "./sky.js";
import { World } from "./world/world.js";
import { Colliders } from "./world/colliders.js";
import { buildTerrain } from "./world/terrain.js";
import { buildRoad, inTown } from "./world/road.js";
import { buildTown } from "./world/town.js";
import { buildLandmarks } from "./world/landmarks.js";
import { buildNature } from "./world/nature.js";
import { SPAWN, LANE_OFFSET, SEA_LEVEL } from "./world/layout.js";
import { loadCar, loadCarLod } from "./car/carModel.js";
import { Vehicle } from "./car/vehicle.js";
import { CarDamage } from "./car/damage.js";
import { TrafficLights, speedLimitAt } from "./world/trafficLights.js";
import { planStations, buildStations, stationApproach } from "./world/stations.js";
import { Fuel, Refuel, pumpSpotAt, FUEL_FLOOR } from "./fuel.js";
import { ChaseCamera } from "./camera.js";
import { Input } from "./input.js";
import { Weather, WEATHERS } from "./weather.js";
import { GameAudio } from "./audio.js";
import { Traffic } from "./traffic.js";
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
  town.lampSpots.push(...stationParts.lampSpots);
  setProgress(0.42, "Planting trees…");
  await nextFrame();
  const nature = buildNature(scene, world, colliders, preset);

  setProgress(0.46, "Bringing the car round…");
  const car = await loadCar(scene, (p) => setProgress(0.46 + p * 0.34));
  let carEntry = GARAGE.find((g) => g.id === settings.car) ?? GARAGE[0];
  let paint = carEntry.paint;
  applyPaint(car, paint);
  const vehicle = new Vehicle(car, world, colliders, carEntry.spec);
  const damage = new CarDamage(scene, car);
  vehicle.onImpact = (hit) => damage.hit(hit);
  const fuel = new Fuel(settings.fuel);
  fuel.electric = !!carEntry.electric;
  fuel.auto = settings.fuelMode === "auto";
  vehicle.place(SPAWN.x, SPAWN.z, SPAWN.heading);

  setProgress(0.82, "Filling the roads…");
  const lod = await loadCarLod(scene);
  const lights = new TrafficLights(scene, world, colliders);
  const traffic = new Traffic(scene, world, lod, preset);
  traffic.lights = lights;
  const people = new People(scene, world, town.pavementSpots, preset, false);

  const chase = new ChaseCamera(scene, world, car, settings.cameraMode);
  chase.camera.maxZ = preset.viewDistance;
  scene.activeCamera = chase.camera;
  chase.update(0, vehicle);

  const csm = createShadows(scene, sky.light, chase.camera, preset);
  for (const m of [...car.shadowMeshes, ...town.casters, ...nature.casters, ...road.casters, ...landmarks.casters, lod, ...lights.casters, ...stationParts.casters]) csm.addShadowCaster(m, false);

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
  const audio = new GameAudio();
  audio.enabled = settings.sound;
  weather.onThunder = (delay) => audio.thunder(delay);
  document.addEventListener("pointerdown", () => audio.start(), true);
  document.addEventListener("keydown", () => audio.start(), true);

  // ---------- Map and self-driving ----------
  const navigator = new Navigator(world);
  const autodriver = new AutoDriver(world, navigator);
  autodriver.lights = lights;
  const mapImage = renderMapImage(world);
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
  $("btn-action").addEventListener("click", () => {
    if (mode === "drive") {
      // Step out on the driver's side.
      const lx = -Math.cos(vehicle.heading);
      const lz = Math.sin(vehicle.heading);
      people.player.x = vehicle.x + lx * 1.8;
      people.player.z = vehicle.z + lz * 1.8;
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
      // Swap: your old car is left parked here, you take this one.
      const t = nearbyCar;
      traffic.remove(t);
      traffic.addParked(vehicle.x, vehicle.z, vehicle.heading, paint.colour);
      vehicle.place(t.x, t.z, t.yaw);
      damage.repair();
      paint = { colour: t.colour, metallic: 0.75, roughness: 0.22 };
      applyPaint(car, paint);
      // Someone else's car: some are electric, and the tank is part full.
      fuel.electric = Math.random() < 0.3;
      fuel.level = 0.35 + Math.random() * 0.6;
      toast(fuel.electric ? "New car (electric) — enjoy!" : "New car — enjoy!");
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
  {
    const b = document.createElement("button");
    b.innerHTML = `Nearest fuel station<small>Fill up or charge</small>`;
    b.addEventListener("click", () => {
      const s = nearestStation();
      if (!s) return;
      pickDestination(s.x, s.z, s.name, s);
      bigmap.centreOn(s.x, s.z);
    });
    $("places").appendChild(b);
  }
  for (const s of stations) PLACES.push({ name: s.name.replace("Fuel station · ", "Fuel · "), country: s.island.name, x: s.x, z: s.z, station: s });
  for (const p of PLACES) {
    const b = document.createElement("button");
    b.innerHTML = `${p.name}<small>${p.country}</small>`;
    b.addEventListener("click", () => {
      pickDestination(p.x, p.z, p.name, p.station ?? null);
      bigmap.centreOn(p.x, p.z);
    });
    $("places").appendChild(b);
  }
  $("minimap").addEventListener("click", () => {
    mapPanel.hidden = false;
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
    for (const g of GARAGE) {
      const s = stats(g);
      const card = document.createElement("button");
      card.className = "car-card" + (g === carEntry ? " on" : "");
      const [r, gg, b] = g.paint.colour.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255));
      card.innerHTML = `
        <div class="swatch" style="background: linear-gradient(135deg, rgb(${r},${gg},${b}), rgb(${Math.round(r * 0.55)},${Math.round(gg * 0.55)},${Math.round(b * 0.55)}))"></div>
        <div class="name">${g.name}</div>
        <div class="trim">${g.trim} · ${g.electric ? "Electric" : "Petrol"}</div>
        ${["speed", "acceleration", "grip"].map((k) => `<div class="stat">${k[0].toUpperCase() + k.slice(1)}<span class="bar"><i style="width:${Math.round(s[k] * 100)}%"></i></span></div>`).join("")}`;
      card.addEventListener("click", () => {
        carEntry = g;
        paint = g.paint;
        applyPaint(car, paint);
        vehicle.setCar(car, g.spec);
        damage.repair();
        fuel.electric = !!g.electric;
        fuel.level = 1;
        settings.car = g.id;
        saveSettings(settings);
        renderGarage();
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
  const place = { town: 0, sea: 0 };
  let placeTimer = 0;
  let saveTimer = 20;
  vehicle.onBump = (o, speed) => {
    if (o.car && o.car.moving && speed > 1) o.car.stopTimer = 3;
  };

  const tick = (dt) => {
    input.update();
    const dynamicCars = traffic.colliders();
    if (mode === "drive") {
      let controls = input;
      if (autodriver.active) {
        controls = autodriver.drive(vehicle, traffic);
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
      const own = { x: vehicle.x, z: vehicle.z, r: 2.2 };
      people.movePlayer(dt, input.stick.x, input.stick.y, chase.yaw, colliders, [...dynamicCars, own]);
      // Which car could you get into?
      const p = people.player;
      const t = traffic.nearest(p.x, p.z, 3.6);
      nearbyCar = Math.hypot(vehicle.x - p.x, vehicle.z - p.z) < 3.8 ? "own" : t;
    }
    const me = playerPos();
    traffic.update(dt, mode === "foot" ? people.player : vehicle, chase.camera);
    const fuelWarning = fuel.update(dt, vehicle, mode === "drive");
    if (fuelWarning) toast(fuelWarning);
    people.update(dt, mode === "drive" ? vehicle : null);
    people.draw();
    weather.update(dt, chase.camera, vehicle);
    lights.update(dt);
    if (mode === "drive" && lights.ranRed(vehicle.x, vehicle.z, vehicle.vx, vehicle.vz)) toast("You went through a red light!");
    daynight.update(dt);
    damage.update(dt, vehicle, daynight.night);
    nightLights.update(daynight.night, mode === "drive" && vehicle.forwardSpeed > 0.5 && (autodriver.active ? false : input.brake > 0), me, traffic.cars);
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
    placeTimer -= dt;
    if (placeTimer <= 0) {
      placeTimer = 0.5;
      place.town = inTown(me.x, me.z, 40) ? 1 : 0;
      let wet = 0;
      for (const [ox, oz] of [[60, 0], [-60, 0], [0, 60], [0, -60]]) if (world.getHeight(me.x + ox, me.z + oz) < SEA_LEVEL) wet++;
      place.sea = wet / 4;
    }
    audio.update(dt, { car: vehicle, onFoot: mode === "foot", inCabin: mode === "drive" && chase.modeName === "Driver", weather: weather.cur, place });

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
    window.__game = { engine, scene, world, vehicle, chase, sky, csm, pipeline, nature, input, step, placeOn, traffic, people, weather, audio, navigator, autodriver, daynight, nightLights, damage, lights, stations, fuel, refuel, setMode, get mode() { return mode; }, pickDestination };
  }
}

start().catch((err) => {
  console.error(err);
  setProgress(1, "Something went wrong loading the game. Try closing and opening it again.");
});
