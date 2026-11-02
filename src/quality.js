// Graphics levels. "scale" is how many rendered pixels per screen point
// (it is capped at the screen's real pixel density).
export const PRESETS = {
  low: { scale: 1.0, msaa: 1, fxaa: true, bloom: false, sharpen: false, shadowSize: 1024, cascades: 2, shadowMaxZ: 90, trees: 1050, rocks: 240, traffic: 13, parked: 16, people: 28, precip: 0.5, viewDistance: 1400 },
  medium: { scale: 1.4, msaa: 4, fxaa: false, bloom: true, sharpen: false, shadowSize: 1024, cascades: 3, shadowMaxZ: 150, trees: 1950, rocks: 390, traffic: 21, parked: 26, people: 48, precip: 0.8, viewDistance: 1900 },
  high: { scale: 2.0, msaa: 4, fxaa: false, bloom: true, sharpen: true, shadowSize: 2048, cascades: 4, shadowMaxZ: 240, trees: 3300, rocks: 600, traffic: 31, parked: 38, people: 72, precip: 1, viewDistance: 2600 },
};
export const LEVELS = ["low", "medium", "high"];

const KEY = "drivingGame.settings.v1";
const DEFAULTS = { graphics: "auto", units: "kmh", showFps: true, cameraMode: 0, sound: true, weather: "sunny", car: "gt-red", hour: 10, fuel: 1, fuelMode: "real" };

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const settings = { ...DEFAULTS, ...saved };
    // Speeds and limits show in km/h now (the signs read 60 in towns, 120
    // outside). Everyone is switched over once; after that the choice in
    // Settings sticks.
    if (!saved.kmhSwitched) {
      settings.units = "kmh";
      settings.kmhSwitched = true;
    }
    return settings;
  } catch {
    return { ...DEFAULTS };
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
