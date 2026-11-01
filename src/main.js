import { Engine, Scene, Color4, DefaultRenderingPipeline, ImageProcessingConfiguration, ColorCurves } from "@babylonjs/core";
import { PRESETS, LEVELS, loadSettings, saveSettings, startingLevel } from "./quality.js";
import { setupSky, createShadows } from "./sky.js";
import { Heightfield } from "./world/heightfield.js";
import { Colliders } from "./world/colliders.js";
import { buildTerrain } from "./world/terrain.js";
import { buildRoad } from "./world/road.js";
import { buildTown } from "./world/town.js";
import { buildNature } from "./world/nature.js";
import { SPAWN } from "./world/layout.js";
import { loadCar } from "./car/carModel.js";
import { Vehicle } from "./car/vehicle.js";
import { ChaseCamera } from "./camera.js";
import { Input } from "./input.js";

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
    if (!e.target.closest(".panel-card")) e.preventDefault();
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
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

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
  scene.skipFrustumClipping = false;

  setProgress(0.05, "Painting the sky…");
  const sky = await setupSky(scene);

  setProgress(0.2, "Shaping the hills…");
  await nextFrame();
  const hf = new Heightfield(7);
  const colliders = new Colliders();
  buildTerrain(scene, hf);
  setProgress(0.28, "Laying the road…");
  await nextFrame();
  const road = buildRoad(scene, hf, colliders);
  setProgress(0.33, "Building the town…");
  const town = await buildTown(scene, hf, colliders);
  setProgress(0.4, "Planting trees…");
  await nextFrame();
  const nature = buildNature(scene, hf, colliders, preset);

  setProgress(0.45, "Bringing the car round…");
  const car = await loadCar(scene, (p) => setProgress(0.45 + p * 0.4));
  const vehicle = new Vehicle(car, hf, colliders);
  vehicle.place(SPAWN.x, SPAWN.z, SPAWN.heading);

  const chase = new ChaseCamera(scene, hf);
  scene.activeCamera = chase.camera;
  chase.update(0, vehicle);

  const csm = createShadows(scene, sky.light, chase.camera, preset);
  for (const m of [...car.shadowMeshes, ...town.casters, ...nature.casters, ...road.casters]) csm.addShadowCaster(m, false);

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

  // ---------- Controls ----------
  const input = new Input();
  const resetCar = () => {
    const i = hf.nearestRoadSample(vehicle.x, vehicle.z);
    const [x, z] = hf.road.points[i];
    const [tx, tz] = hf.road.tangents[i];
    vehicle.place(x, z, Math.atan2(tx, tz));
    chase._first = true;
  };
  input.handlers.camera = () => toast(chase.cycle());
  input.handlers.reset = resetCar;
  input.attachKeyboard();
  input.attachTouch({
    steerZone: $("steer-zone"),
    steerBase: $("steer-base"),
    steerKnob: $("steer-knob"),
    gas: $("btn-gas"),
    brake: $("btn-brake"),
    hand: $("btn-hand"),
  });
  $("btn-camera").addEventListener("click", () => input.handlers.camera());
  $("btn-reset").addEventListener("click", resetCar);

  // ---------- Settings panel ----------
  const panel = $("settings");
  const markSeg = (id, value) => {
    for (const b of $(id).querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === value);
  };
  const levelName = (l) => l[0].toUpperCase() + l.slice(1);
  const refreshPanel = () => {
    markSeg("seg-graphics", settings.graphics);
    markSeg("seg-units", settings.units);
    markSeg("seg-fps", settings.showFps ? "on" : "off");
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
  $("seg-graphics").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v || v === settings.graphics) return;
    settings.graphics = v;
    if (v === "auto") settings.autoLevel = null;
    saveSettings(settings);
    $("graphics-note").textContent = "Restarting…";
    setTimeout(() => location.reload(), 250);
  });
  $("seg-units").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    settings.units = v;
    saveSettings(settings);
    refreshPanel();
  });
  $("seg-fps").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    settings.showFps = v === "on";
    saveSettings(settings);
    refreshPanel();
  });
  refreshPanel();

  // ---------- Auto graphics: step down if the frame rate is low ----------
  const monitor = { warm: 5, time: 0, frames: 0, slow: 0 };
  const stepDown = () => {
    const i = LEVELS.indexOf(level);
    if (i > 0) {
      level = LEVELS[i - 1];
      preset = { ...PRESETS[level], trees: preset.trees, rocks: preset.rocks };
      applyScale();
      applyEffects();
      settings.autoLevel = level;
      saveSettings(settings);
      toast(`Graphics set to ${levelName(level)} so it runs smoothly`);
    } else if (preset.scale > 0.75) {
      preset.scale = Math.max(0.75, preset.scale - 0.15);
      applyScale();
    }
  };
  const watchFrameRate = (dt) => {
    if (settings.graphics !== "auto") return;
    // Ignore pauses (app in the background, menu open) so they don't count as slowness.
    if (document.hidden || !panel.hidden || dt > 0.25) {
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

  // ---------- Go ----------
  setProgress(0.9, "Warming up…");
  await scene.whenReadyAsync();
  setProgress(1, "Ready");
  $("loading").hidden = true;
  $("hud").hidden = false;

  let fpsTimer = 0;
  let shownSpeed = -1;
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    if (panel.hidden) {
      input.update();
      vehicle.update(dt, input);
    }
    chase.update(dt, vehicle);

    const speed = Math.round(Math.abs(vehicle.forwardSpeed) * (settings.units === "mph" ? 2.23694 : 3.6));
    if (speed !== shownSpeed) {
      shownSpeed = speed;
      $("speed").textContent = speed;
    }
    fpsTimer += dt;
    if (fpsTimer > 0.5) {
      fpsTimer = 0;
      $("fps").textContent = `${Math.round(engine.getFps())} fps · ${levelName(level)}`;
    }
    watchFrameRate(dt);
    scene.render();
  });

  if (import.meta.env.DEV) {
    // Test hook: run the game forward by hand (used when the tab is hidden).
    const step = (frames, dt = 1 / 60) => {
      for (let i = 0; i < frames; i++) {
        input.update();
        vehicle.update(dt, input);
        chase.update(dt, vehicle);
      }
      scene.render();
    };
    const placeAt = (i) => {
      const n = hf.road.count;
      i = ((i % n) + n) % n;
      const [x, z] = hf.road.points[i];
      const [tx, tz] = hf.road.tangents[i];
      vehicle.place(x, z, Math.atan2(tx, tz));
      chase._first = true;
    };
    window.__game = { engine, scene, vehicle, hf, chase, sky, csm, pipeline, nature, input, step, placeAt };
  }
}

start().catch((err) => {
  console.error(err);
  setProgress(1, "Something went wrong loading the game. Try closing and opening it again.");
});
