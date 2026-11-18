import { Vector3 } from "@babylonjs/core";
import { CAMERA_MODES } from "./camera.js";
import { SEA_LEVEL } from "./world/layout.js";
import { isTouchDevice } from "./quality.js";
import { clamp, lerp } from "./noise.js";

// Photo mode: the world stops, the controls go, and the camera circles your
// vehicle (or you, on foot). Drag to go round, pinch to zoom, a slider sets
// the time of day, and "Save picture" saves what's on screen as a PNG.
// Leaving puts the time back and everything carries on where it stopped.

const PITCH_MIN = -0.3; // a little below the subject (the ground stops it sooner)
const PITCH_MAX = 1.45; // nearly straight down
const GROUND_GAP = 0.4; // never closer to the ground than this
const KNOB = 15; // half the slider knob's width (px), so it stays on the track

const $ = (id) => document.getElementById(id);
const two = (n) => String(n).padStart(2, "0");

export class PhotoMode {
  // `onLight` re-lights the lamps, windows and headlights for the time of
  // day (they normally follow it in the game loop, which is paused here).
  constructor(scene, chase, world, daynight, { onLight }) {
    this.scene = scene;
    this.chase = chase;
    this.world = world;
    this.daynight = daynight;
    this.onLight = onLight;
    this.active = false;
    this.subject = null;
    this.look = 1; // how high above the subject's feet the camera looks
    this.minDist = 3;
    this.maxDist = 40;
    // Where the camera is round the subject now, and where the fingers want it.
    this.yaw = 0;
    this.pitch = 0.2;
    this.dist = 6;
    this.goal = { yaw: 0, pitch: 0.2, dist: 6 };
    this.target = new Vector3();
    this.saved = { hour: 0, timeScale: 1 };
    this.frozen = []; // particle systems paused on the way in
    this.pointers = new Map();
    this.span = 0; // distance between two fingers, for pinching
    this.ui = $("photo");
    this.msgTimer = 0;
    this.sharing = false;
    this._wire();
  }

  // `subject` is your vehicle or you on foot (anything with x, y, z, heading);
  // `car` is the vehicle's model, for its size (null on foot).
  enter(subject, car) {
    if (this.active) return;
    this.active = true;
    this.subject = subject;
    const size = car ? (car.chase ?? { dist: 1, height: 1 }) : null;
    this.look = size ? 0.8 * size.height : 1;
    this.minDist = size ? 2.6 * size.dist : 1.3;
    this.maxDist = size ? 40 * Math.min(size.dist, 1.6) : 30;
    this._aim();

    // Start where the game camera is (chase views, on foot). From the driver's
    // seat, the bonnet, the bumper or the roadside TV camera, start behind
    // the car instead, at the usual chase distance.
    const cam = this.chase.camera;
    const g = this.goal;
    if (!car || CAMERA_MODES[this.chase.mode].kind === "chase") {
      const dx = cam.position.x - this.target.x;
      const dy = cam.position.y - this.target.y;
      const dz = cam.position.z - this.target.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      g.yaw = Math.atan2(dx, dz);
      g.pitch = clamp(Math.asin(dy / d), PITCH_MIN, PITCH_MAX);
      g.dist = clamp(d, this.minDist, this.maxDist);
    } else {
      g.yaw = subject.heading + Math.PI;
      g.pitch = 0.22;
      g.dist = clamp(6.4 * size.dist, this.minDist, this.maxDist);
      cam.fov = 0.9;
    }
    this.yaw = g.yaw;
    this.pitch = g.pitch;
    this.dist = g.dist;
    cam.minZ = 0.1;

    // The game loop stops (main.js checks `active`). These two move inside
    // scene.render() itself, so they're stopped here: animations (your body
    // on foot) and particles (sparks, smoke).
    this.saved.hour = this.daynight.hour;
    this.saved.timeScale = this.scene.animationTimeScale;
    this.scene.animationTimeScale = 0;
    for (const ps of this.scene.particleSystems) {
      if (ps.paused) continue;
      ps.paused = true;
      this.frozen.push(ps);
    }
    $("hud").hidden = true;
    this.ui.hidden = false;
    this._showTime();
    this._say("Drag to look around. Pinch to zoom.");
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    // Back to the time it was when you came in.
    this.daynight.hour = this.saved.hour;
    this._applyTime();
    this.scene.animationTimeScale = this.saved.timeScale;
    for (const ps of this.frozen) ps.paused = false;
    this.frozen.length = 0;
    this.pointers.clear();
    // The game camera snaps back to its own view (and field of view).
    this.chase._first = true;
    this.ui.hidden = true;
    $("hud").hidden = false;
  }

  _aim() {
    const s = this.subject;
    this.target.set(s.x, s.y + this.look, s.z);
  }

  // Every frame while active: ease towards where the fingers put the camera,
  // never going under the ground.
  update(dt) {
    const g = this.goal;
    const k = 1 - Math.exp(-dt * 14);
    this.yaw = lerp(this.yaw, g.yaw, k);
    this.pitch = lerp(this.pitch, g.pitch, k);
    this.dist = lerp(this.dist, g.dist, k);
    this._aim();
    const t = this.target;
    let cp = Math.cos(this.pitch);
    let x = t.x + Math.sin(this.yaw) * cp * this.dist;
    let z = t.z + Math.cos(this.yaw) * cp * this.dist;
    let y = t.y + Math.sin(this.pitch) * this.dist;
    let ground = Math.max(this.world.getHeight(x, z), SEA_LEVEL) + GROUND_GAP;
    if (y < ground) {
      // Ride up over the ground. The goal stops there too, so dragging back
      // up moves the camera straight away.
      const p = Math.min(PITCH_MAX, Math.asin(clamp((ground - t.y) / this.dist, -1, 1)));
      this.pitch = p;
      if (g.pitch < p) g.pitch = p;
      cp = Math.cos(p);
      x = t.x + Math.sin(this.yaw) * cp * this.dist;
      z = t.z + Math.cos(this.yaw) * cp * this.dist;
      ground = Math.max(this.world.getHeight(x, z), SEA_LEVEL) + GROUND_GAP;
      y = Math.max(t.y + Math.sin(p) * this.dist, ground);
    }
    const cam = this.chase.camera;
    cam.position.set(x, y, z);
    cam.setTarget(t);
  }

  _zoom(factor) {
    this.goal.dist = clamp(this.goal.dist * factor, this.minDist, this.maxDist);
  }

  // ---------- Saving ----------

  // The picture is copied straight after drawing a frame, in the same go:
  // the game canvas is wiped once it has been shown (preserveDrawingBuffer
  // is off). The controls are page elements, so they're never in it.
  save() {
    // (Not again while the share sheet from the last one is still open.)
    if (!this.active || this.sharing) return;
    const src = this.scene.getEngine().getRenderingCanvas();
    this.scene.render();
    // Onto a plain canvas with a solid background, so the PNG has no
    // see-through spots.
    const copy = document.createElement("canvas");
    copy.width = src.width;
    copy.height = src.height;
    copy.getContext("2d", { alpha: false }).drawImage(src, 0, 0);
    const url = copy.toDataURL("image/png");
    copy.width = copy.height = 0; // let its memory go now
    // An empty frame packs down to a few KB; a real one is far bigger.
    if (url.length < 30000) {
      this._say("Couldn't save the picture. Try again.");
      return;
    }
    // Done here rather than with toBlob(), so the share sheet still opens
    // as part of the tap (Safari refuses it otherwise).
    const bytes = atob(url.slice(url.indexOf(",") + 1));
    const data = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i);
    const d = new Date();
    const name = `driving-game-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.png`;
    this.deliver(new File([data], name, { type: "image/png" }));
  }

  // On the iPad a download link can open the picture in a new tab instead,
  // so it goes to the share sheet, which has "Save Image". On a computer it
  // downloads. `say` shows a message (the speed camera album has its own place).
  deliver(file, say = (text) => this._say(text)) {
    if (isTouchDevice() && navigator.canShare?.({ files: [file] })) {
      this.sharing = true;
      navigator
        .share({ files: [file] })
        .catch((err) => {
          // (Closing the share sheet isn't a failure.)
          if (err.name !== "AbortError") this._download(file, say);
        })
        .finally(() => (this.sharing = false));
      return;
    }
    this._download(file, say);
  }

  _download(file, say) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    say("Picture saved");
  }

  // ---------- Controls ----------

  _say(text) {
    const el = $("photo-msg");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  _applyTime() {
    this.daynight.update(0);
    this.onLight();
  }

  _showTime() {
    const f = this.daynight.hour / 24;
    $("photo-knob").style.left = `calc(${KNOB}px + (100% - ${KNOB * 2}px) * ${f.toFixed(4)})`;
    $("photo-clock").textContent = this.daynight.clock;
    $("photo-slider").setAttribute("aria-valuenow", this.daynight.hour.toFixed(1));
  }

  _wire() {
    const el = this.ui;
    const ptrs = this.pointers;
    // (Capture can fail for a finger the browser has already let go of.)
    const capture = (node, id) => {
      try {
        node.setPointerCapture(id);
      } catch {}
    };

    // Drag to orbit, pinch to zoom: anywhere on screen except the bar.
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".photo-bar")) return;
      capture(el, e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.span = 0;
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (ptrs.size === 1) {
        // The view turns with your finger, as if you'd grabbed the world.
        this.goal.yaw += dx * 0.008;
        this.goal.pitch = clamp(this.goal.pitch + dy * 0.006, PITCH_MIN, PITCH_MAX);
        return;
      }
      // Two fingers: the first two count.
      let a = null;
      let b = null;
      for (const q of ptrs.values()) {
        if (!a) a = q;
        else if (!b) b = q;
      }
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.span > 0 && span > 0) this._zoom(this.span / span);
      this.span = span;
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      this.span = 0;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    // Mouse wheel, on a computer.
    el.addEventListener(
      "wheel",
      (e) => {
        this._zoom(Math.exp(e.deltaY * 0.0015));
        e.preventDefault();
      },
      { passive: false },
    );

    // Time of day: drag along the slider (built from pointer events like the
    // steering wheel, so it works under the iPad's touch blocking).
    const slider = $("photo-slider");
    let sliderId = null;
    let left = 0;
    let width = 1;
    const slide = (e) => {
      const f = clamp((e.clientX - left - KNOB) / Math.max(1, width - KNOB * 2), 0, 1);
      this.daynight.hour = Math.min(f * 24, 23.99);
      this._applyTime();
      this._showTime();
    };
    slider.addEventListener("pointerdown", (e) => {
      if (sliderId !== null) return;
      sliderId = e.pointerId;
      capture(slider, e.pointerId);
      const r = slider.getBoundingClientRect();
      left = r.left;
      width = r.width;
      slide(e);
      e.preventDefault();
    });
    slider.addEventListener("pointermove", (e) => e.pointerId === sliderId && slide(e));
    const release = (e) => {
      if (e.pointerId === sliderId) sliderId = null;
    };
    slider.addEventListener("pointerup", release);
    slider.addEventListener("pointercancel", release);

    $("btn-photo-save").addEventListener("click", () => this.save());
    $("btn-photo-done").addEventListener("click", () => this.exit());
    window.addEventListener("keydown", (e) => {
      if (this.active && e.code === "Escape") this.exit();
    });
  }
}
