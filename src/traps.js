import { ROAD_HALF_WIDTH } from "./world/layout.js";
import { speedLimitAt } from "./world/trafficLights.js";

// Speed traps: driving over a trap's line records your speed. Your best at
// each trap is kept (in m/s, in settings.traps), and a banner shows what you
// did. The camera flashes and takes your picture (speedPhotos.js) if you were
// over the limit. The towns' speed cameras only do that last part: no bests
// or banner.

const MIN_SPEED = 5; // m/s: crawling over the line doesn't count
const BANNER_FOR = 3.6; // seconds
const FLASH_FOR = 0.25;
const JUMP = 6; // metres more than your speed covers in a frame: you were put there (not driven)

export class SpeedTraps {
  // hooks: { active() -> are you driving the car yourself, entry() -> your
  //   garage entry, flash(0..1),
  //   photo(camera, speed, limit, end) (caught: `end` is which way you went, 1 or -1) }
  // cameras: the towns' speed cameras (layout.js TOWN_CAMERAS).
  constructor({ traps, cameras = [], vehicle, settings, save, hooks }) {
    Object.assign(this, { traps, vehicle, settings, save, hooks });
    this.all = [...traps, ...cameras];
    this.prev = new Float64Array(this.all.length).fill(NaN); // how far along each camera's road you were last frame
    this.bannerTime = 0;
    this.flashTime = 0;
    const hud = document.getElementById("hud");
    this.banner = document.createElement("div");
    this.banner.className = "trap-banner";
    this.banner.innerHTML = `<span class="trap-label">Speed trap</span><b class="trap-speed"></b><span class="trap-note"></span>`;
    hud.appendChild(this.banner);
    this.speedEl = this.banner.querySelector(".trap-speed");
    this.noteEl = this.banner.querySelector(".trap-note");
  }

  // In the chosen units: "187 km/h".
  speedText(ms) {
    return this.settings.units === "mph" ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`;
  }

  // Your best at a trap, in words (for the map list), or "".
  bestText(t) {
    const best = this.settings.traps[t.id]?.best;
    return best ? `Best ${this.speedText(best)}` : "";
  }

  update(dt) {
    if (this.bannerTime > 0) {
      this.bannerTime -= dt;
      if (this.bannerTime <= 0) this.banner.classList.remove("show");
    }
    if (this.flashTime > 0) {
      this.flashTime = Math.max(0, this.flashTime - dt);
      this.hooks.flash(this.flashTime / FLASH_FOR);
    }
    const prev = this.prev;
    if (!this.hooks.active()) {
      prev.fill(NaN);
      return;
    }
    const v = this.vehicle;
    for (let k = 0; k < this.all.length; k++) {
      const t = this.all[k];
      const rx = v.x - t.x;
      const rz = v.z - t.z;
      if (Math.abs(rx) > 60 || Math.abs(rz) > 60) {
        prev[k] = NaN;
        continue;
      }
      const along = rx * t.fx + rz * t.fz;
      const side = rx * t.fz - rz * t.fx;
      const p = prev[k];
      prev[k] = along;
      // Over the line (either way), on the road, and driven there (a slow
      // frame at speed can cover a lot of ground, so that's allowed for).
      if (Number.isNaN(p) || (p < 0) === (along < 0) || Math.abs(along - p) > JUMP + v.speed * dt * 1.5 || Math.abs(side) > ROAD_HALF_WIDTH + 2.5) continue;
      this._pass(t, v.speed, along < 0 ? -1 : 1);
    }
  }

  _pass(t, speed, end) {
    if (speed < MIN_SPEED) return;
    // Over the limit (as the speedometer shows it): one flash and one picture a pass.
    const limit = speedLimitAt(t.x, t.z);
    if (Math.round(speed * 3.6) > limit) {
      this.flashTime = FLASH_FOR;
      this.hooks.flash(1);
      this.hooks.photo?.(t, speed, limit, end);
    }
    if (t.town) return;
    const rec = (this.settings.traps[t.id] ??= {});
    const old = rec.best ?? 0;
    // (Half a km/h better at least, so a tie on the display isn't a new best.)
    const newBest = speed > old + 0.14;
    let note;
    if (newBest) {
      rec.best = +speed.toFixed(2);
      rec.car = this.hooks.entry().id;
      this.save(this.settings);
      note = "New best!";
    } else note = `Your best: ${this.speedText(old)}`;
    this.speedEl.textContent = this.speedText(speed);
    this.noteEl.textContent = note;
    this.banner.classList.toggle("best", newBest);
    this.banner.classList.add("show");
    this.bannerTime = BANNER_FOR;
  }
}
