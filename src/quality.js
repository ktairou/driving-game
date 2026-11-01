// Graphics levels. "scale" is how many rendered pixels per screen point
// (it is capped at the screen's real pixel density).
export const PRESETS = {
  low: { scale: 1.0, msaa: 1, fxaa: true, bloom: false, sharpen: false, shadowSize: 1024, cascades: 2, shadowMaxZ: 90, trees: 450, rocks: 110 },
  medium: { scale: 1.4, msaa: 4, fxaa: false, bloom: true, sharpen: false, shadowSize: 1024, cascades: 3, shadowMaxZ: 150, trees: 800, rocks: 170 },
  high: { scale: 2.0, msaa: 4, fxaa: false, bloom: true, sharpen: true, shadowSize: 2048, cascades: 4, shadowMaxZ: 240, trees: 1300, rocks: 240 },
};
export const LEVELS = ["low", "medium", "high"];

const KEY = "drivingGame.settings.v1";
const DEFAULTS = { graphics: "auto", autoLevel: null, units: "mph", showFps: true };

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

export function startingLevel(settings) {
  if (settings.graphics !== "auto") return settings.graphics;
  if (settings.autoLevel && PRESETS[settings.autoLevel]) return settings.autoLevel;
  return isTouchDevice() ? "medium" : "high";
}
