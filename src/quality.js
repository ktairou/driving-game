// Graphics levels. "scale" is how many rendered pixels per screen point
// (it is capped at the screen's real pixel density).
export const PRESETS = {
  low: { scale: 1.0, msaa: 1, fxaa: true, bloom: false, sharpen: false, shadowSize: 1024, cascades: 2, shadowMaxZ: 90, trees: 700, rocks: 160, traffic: 10, parked: 10, people: 18, precip: 0.5, viewDistance: 1400 },
  medium: { scale: 1.4, msaa: 4, fxaa: false, bloom: true, sharpen: false, shadowSize: 1024, cascades: 3, shadowMaxZ: 150, trees: 1300, rocks: 260, traffic: 16, parked: 16, people: 30, precip: 0.8, viewDistance: 1900 },
  high: { scale: 2.0, msaa: 4, fxaa: false, bloom: true, sharpen: true, shadowSize: 2048, cascades: 4, shadowMaxZ: 240, trees: 2200, rocks: 400, traffic: 24, parked: 24, people: 48, precip: 1, viewDistance: 2600 },
};
export const LEVELS = ["low", "medium", "high"];

const KEY = "drivingGame.settings.v1";
const DEFAULTS = { graphics: "auto", units: "mph", showFps: true, cameraMode: 0, sound: true, weather: "sunny", car: "gt-red", hour: 10 };

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
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
