
// Graphics levels. "scale" is how many rendered pixels per screen point
// (it is capped at the screen's real pixel density). "cover" is how many
// clumps of grass, flowers and bushes line the country roads. "smoke" is the
// most tyre-smoke puffs at once; "edgeBlur" blurs the screen's edges at speed.
export const PRESETS = {
  low: { scale: 1.0, msaa: 1, fxaa: true, bloom: false, sharpen: false, shadowSize: 1024, cascades: 2, shadowMaxZ: 90, trees: 1050, rocks: 240, cover: 0, traffic: 13, parked: 16, people: 28, precip: 0.5, viewDistance: 1400, smoke: 70, edgeBlur: false },
  medium: { scale: 1.4, msaa: 4, fxaa: false, bloom: true, sharpen: false, shadowSize: 1024, cascades: 3, shadowMaxZ: 150, trees: 1950, rocks: 390, cover: 3000, traffic: 21, parked: 26, people: 48, precip: 0.8, viewDistance: 1900, smoke: 150, edgeBlur: false },
  high: { scale: 2.0, msaa: 4, fxaa: false, bloom: true, sharpen: true, shadowSize: 2048, cascades: 4, shadowMaxZ: 240, trees: 3300, rocks: 600, cover: 8000, traffic: 31, parked: 38, people: 72, precip: 1, viewDistance: 2600, smoke: 150, edgeBlur: true },
};
export const LEVELS = ["low", "medium", "high"];

const KEY = "drivingGame.settings.v1";
// races: race results per drag strip or street race id, { best: { time, car }, cars: { [car id]: { time, medal } }, medal }.
// traps: your best per speed trap id, { best (m/s), car }.
// Every vehicle is free to drive, so nothing is bought or unlocked.
const DEFAULTS = { graphics: "auto", units: "kmh", showFps: true, cameraMode: 0, sound: true, weather: "sunny", car: "gt-red", hour: 10, fuel: 1, fuelMode: "real", races: {}, raceLevel: "medium", traps: {} };

// The quarter-mile drag strips, since replaced by half-mile strips with ids
// of their own: their results no longer mean anything, so they are dropped.
const RETIRED_STRIPS = ["britain-south-west", "britain-north", "france-south-west", "france-north-west", "egypt-south", "egypt-north-east", "usa-south", "usa-west"];

// (Its own copy of a saved object, or a fresh one if what was saved is broken.)
const own = (v) => (v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {});

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const settings = { ...DEFAULTS, ...saved };
    settings.races = own(settings.races);
    for (const id of RETIRED_STRIPS) delete settings.races[id];
    settings.traps = own(settings.traps);
    // Credits and bought cars are gone (every car is free): drop them.
    delete settings.credits;
    delete settings.unlocked;
    delete settings.unlockAll;
    // Speeds and limits show in km/h now (the signs read 70 in towns, 140
    // outside). Everyone is switched over once; after that the choice in
    // Settings sticks.
    if (!saved.kmhSwitched) {
      settings.units = "kmh";
      settings.kmhSwitched = true;
    }
    return settings;
  } catch {
    return { ...DEFAULTS, races: {}, traps: {} };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing etc. Settings just won't be remembered.
  }
}

export function isTouchDevice() {
  return navigator.maxTouchPoints > 1 || "ontouchstart" in window;
}

// Auto starts from a guess each launch and steps down if the frame rate is low.
export function startingLevel(settings) {
  if (settings.graphics !== "auto" && PRESETS[settings.graphics]) return settings.graphics;
  return isTouchDevice() ? "medium" : "high";
}
