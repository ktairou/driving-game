import { Constants, Frustum, ImageProcessingPostProcess, Matrix, RenderTargetTexture, TargetCamera, Texture, Vector3 } from "@babylonjs/core";
import "./photos.css";
import { clamp } from "./noise.js";

// Speed camera photos (traps.js says when you're caught): a white flash and a
// click, then a card slides in with the picture of your car, taken from the
// camera's own spot on its pole, with what it read printed across it (speed,
// limit, place, date and time). Tapping the card opens the album (album.js),
// where the pictures are kept.
//
// Race finish photos (finishShow.js) are taken the same way, by a camera
// beside the finish line, framing you and the cars near you, with the race,
// your place and time printed across them. They go to the album too, but
// no card slides in: the race's result card shows them.
//
// The picture is drawn by a second camera into a small texture of its own,
// so the screen never shows a frame of the wrong view, with the game
// camera's own colour grading (tone mapping, exposure...). A couple of frames
// later, when the graphics chip has long finished it, it is read back and
// packed as a small JPEG. The texture is made the first time you're caught
// and kept (about 1.6 MB of graphics memory): letting its colour grading go
// would switch the game's own grading off.

export const PHOTO_W = 480;
export const PHOTO_H = 270;
const CARD_FOR = 5; // seconds the card stays on screen
const READ_AFTER = 2; // frames between drawing the picture and reading it back
const MAX_DRAWS = 2; // drawn once more (at most) if anything in it wasn't ready yet (the first picture)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const AXIS_Y = new Vector3(0, 1, 0);
// A race finish photo's place, in its medal's colour (white from 4th on).
const MEDAL_INK = { gold: "#ffd34d", silver: "#dfe5ec", bronze: "#f0a061" };

// "142 km/h" or "88 mph".
export const speedWords = (ms, units) => (units === "mph" ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`);
// A limit (km/h) as its sign shows it: in mph, to the nearest 5.
export const limitWords = (kmh, units) => (units === "mph" ? `${Math.round((kmh * 0.621371) / 5) * 5} mph` : `${kmh} km/h`);
// "18 Nov 2026, 14:05": the day it was taken, at the game's time of day
// (the game has no calendar of its own).
export function dateWords(taken, clock) {
  const d = new Date(taken);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock}`;
}

export class SpeedPhotos {
  // hooks: { subject() -> { x, y, z, length } (your vehicle), units() -> "kmh" | "mph",
  //   clock() -> the game's time of day ("14:05"), shutter() (the click),
  //   flash() -> how much the camera's flash brightens the picture (1 = none),
  //   before() / after() (just before and after the picture is drawn),
  //   keep(record) (into the album), open(record) (the card was tapped) }
  // A record: { taken (ms), clock, speed (m/s), limit (km/h), place, jpeg (ArrayBuffer) },
  // or for a race finish: { kind: "finish", taken, clock, race, pos ("1st"), time, jpeg }.
  constructor(scene, hooks) {
    this.scene = scene;
    this.hooks = hooks;
    this.queue = [];
    this.job = null;
    this.cam = null; // made the first time you're caught, with
    this.rtt = null; // the texture the picture is drawn into
    this.cardTime = 0;
    this.cardRec = null;
    this.cardUrl = null;
    this._at = new Vector3();
    this._vp = new Matrix();
    this._buildUi();
  }

  _buildUi() {
    const hud = document.getElementById("hud");
    this.card = document.createElement("button");
    this.card.className = "snap-card";
    this.card.innerHTML = `<span class="snap-label">Speed camera photo</span><img alt="Your car, caught by a speed camera">`;
    this.cardImg = this.card.querySelector("img");
    this.card.addEventListener("click", () => {
      if (!this.cardRec) return;
      this.card.classList.remove("show");
      this.cardTime = 0;
      this.hooks.open(this.cardRec);
    });
    hud.appendChild(this.card);
    // (Last, so the flash covers everything for a moment.)
    this.flashEl = document.createElement("div");
    this.flashEl.className = "snap-flash";
    hud.appendChild(this.flashEl);
  }

  // Caught: `from` is the camera's window ([x, y, z]), `speed` in m/s,
  // `limit` in km/h, `place` in words. The flash and click straight away;
  // the picture a moment later, once you're a few metres past the line.
  snap({ from, speed, limit, place }) {
    const f = this.flashEl;
    f.classList.remove("go");
    void f.offsetWidth; // (so the fade starts again)
    f.classList.add("go");
    this.hooks.shutter();
    if (this.queue.length < 3) this.queue.push({ from, speed, limit, place, clock: this.hooks.clock(), flash: this.hooks.flash?.() ?? 1, taken: Date.now(), wait: clamp(7 / Math.max(speed, 1), 0.08, 0.35), phase: "wait", frame: 0, draws: 0 });
  }

  // A race finish (finishShow.js): `from` is the camera beside the line
  // ([x, y, z]), `subjects` the cars to frame (anything with x, y, z and
  // maybe length; yours first), `race` its name, `pos` your place ("1st"),
  // `time` in words. Drawn this very frame, ahead of any speed photo waiting;
  // `done(record, blob)` once it's packed.
  finish({ from, subjects, race, pos, time, medal, done }) {
    this.hooks.shutter();
    // (Half the speed camera's flash at night: the finish line has its own lights.)
    const flash = 1 + ((this.hooks.flash?.() ?? 1) - 1) * 0.5;
    this.queue.unshift({ kind: "finish", from, subjects, race, pos, time, medal, done, clock: this.hooks.clock(), flash, taken: Date.now(), wait: 0, phase: "wait", frame: 0, draws: 0, maxDraws: 6 });
  }

  // Draws one picture of `subjects` from `from` and throws it away, so that
  // everything in it is ready before a race's finish photo (taken at full
  // speed: there's no waiting for a better moment). Nothing shows or is kept.
  warm({ from, subjects }) {
    if (this.job || this.queue.length) return;
    this.queue.push({ kind: "warm", from, subjects, wait: 0, phase: "wait", frame: 0, draws: 0, maxDraws: 6 });
  }

  // Every frame (not while the game is paused).
  update(dt) {
    if (this.cardTime > 0) {
      this.cardTime -= dt;
      if (this.cardTime <= 0) this.card.classList.remove("show");
    }
    if (!this.job && this.queue.length) this.job = this.queue.shift();
    const job = this.job;
    if (!job) return;
    if (job.phase === "wait") {
      job.wait -= dt;
      if (job.wait <= 0) this._draw(job);
    } else if (job.phase === "drawn") {
      // Babylon draws it again, next frame, if anything in it wasn't quite
      // ready; after a second go, or once it's read, it comes out of the
      // frame's list.
      const done = this.scene.getFrameId() >= job.frame + READ_AFTER;
      const list = this.scene.customRenderTargets;
      if ((done || job.draws >= (job.maxDraws ?? MAX_DRAWS)) && list.includes(this.rtt)) list.splice(list.indexOf(this.rtt), 1);
      if (done && job.kind === "warm") {
        this.rtt.renderList = [];
        this.job = null;
      } else if (done) this._read(job);
    }
  }

  // The camera, the texture with the game camera's colour grading, and the
  // picture's pixels (once). Kept, so the game's materials only get ready for
  // it once, and only in the frame's list while a picture is being drawn.
  _setup() {
    const scene = this.scene;
    const engine = scene.getEngine();
    this.cam = new TargetCamera("speedCamera", new Vector3(0, 10, 0), scene, false);
    this.cam.minZ = 0.6; // (past the camera's own housing)
    // (It looks down at the road: the top of the picture is only a few tens
    // of metres off, so nothing further away is needed.)
    this.cam.maxZ = 250;
    const r = new RenderTargetTexture("speedPhoto", { width: PHOTO_W, height: PHOTO_H }, scene, { doNotChangeAspectRatio: false, generateDepthBuffer: false, samplingMode: Texture.BILINEAR_SAMPLINGMODE });
    r.activeCamera = this.cam;
    r.renderParticles = false;
    r.renderSprites = false;
    r.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    // The same grading as the game camera's, from a half-float picture like its
    // own (if the device can draw into one), so bright skies aren't clipped.
    const hdr = engine.getCaps().textureHalfFloatRender;
    r.addPostProcess(new ImageProcessingPostProcess("speedPhotoGrade", 1, null, Texture.BILINEAR_SAMPLINGMODE, engine, false, hdr ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE, scene.imageProcessingConfiguration));
    // A mesh is ready for the picture once its materials are. (Babylon's own
    // check also asks about the shadow maps, which this doesn't draw, and that
    // never passes for the traffic, so the picture would be drawn again and
    // again.)
    r.customIsReadyFunction = (mesh) => {
      const m = mesh.sourceMesh ?? mesh;
      const instanced = m !== mesh || m.hasThinInstances || m.instances?.length > 0;
      for (const sm of m.subMeshes ?? []) {
        const mat = sm.getMaterial();
        if (mat && !(mat._storeEffectOnSubMeshes ? mat.isReadyForSubMesh(m, sm, instanced) : mat.isReady(m, instanced))) return false;
      }
      return true;
    };
    // Aimed (and the meshes moved to where they are this frame) just as it's
    // drawn: it can be a frame or two after asking, while everything it
    // needs gets ready the first time.
    r.onBeforeRenderObservable.add(() => {
      this.hooks.before?.();
      this._drawStart = performance.now();
      this._aim();
      for (const m of r.renderList) if (!m.isWorldMatrixFrozen) m.computeWorldMatrix(true);
    });
    r.onAfterRenderObservable.add(() => {
      this.hooks.after?.();
      this.drawMs = performance.now() - this._drawStart; // (for tests)
      const job = this.job;
      if (job?.phase === "draw" || job?.phase === "drawn") {
        job.phase = "drawn";
        job.frame = scene.getFrameId();
        job.draws++;
      }
    });
    this.rtt = r;
    this.pixels = new Uint8Array(PHOTO_W * PHOTO_H * 4);
    this.canvas = document.createElement("canvas");
    this.canvas.width = PHOTO_W;
    this.canvas.height = PHOTO_H;
    this.ctx2d = this.canvas.getContext("2d");
    this.image = this.ctx2d.createImageData(PHOTO_W, PHOTO_H);
  }

  // Asks for the picture with this frame, from the camera's window.
  _draw(job) {
    if (!this.cam) this._setup();
    this.rtt.resetRefreshCounter();
    this.scene.customRenderTargets.push(this.rtt);
    const cam = this.cam;
    cam.position.set(job.from[0], job.from[1], job.from[2]);
    const fov = this._aim();
    // What it can see (worked out once a picture): the meshes in its view,
    // a little wider than the picture so nothing at the edges is missed, and
    // the ones that are always drawn (the traffic's).
    cam.fov = fov * 1.4;
    cam.getViewMatrix(true).multiplyToRef(cam.getProjectionMatrix(true), this._vp);
    const planes = Frustum.GetPlanes(this._vp);
    cam.fov = fov;
    cam.getProjectionMatrix(true);
    this.rtt.renderList = this.scene.meshes.filter((m) => m.isEnabled() && (m.alwaysSelectAsActiveMesh || m.infiniteDistance || m.isInFrustum(planes)));
    job.phase = "draw";
  }

  // Points the camera at your vehicle, framed so it fills about half the
  // picture (a bus needs a wider view than a car).
  _aim() {
    if (this.job?.kind === "finish" || this.job?.kind === "warm") return this._frame(this.job);
    const cam = this.cam;
    const s = this.hooks.subject();
    this._at.set(s.x, s.y + 0.6, s.z);
    cam.upVector.copyFrom(AXIS_Y);
    cam.setTarget(this._at);
    const reach = Math.max(2.6, (s.length ?? 4.6) * 0.55);
    cam.fov = clamp(2 * Math.atan(reach / Vector3.Distance(cam.position, this._at)), 0.2, 1.1);
    return cam.fov;
  }

  // A race finish: your car, and the cars near you as long as the picture
  // can take them in and still show yours well; aimed at the middle of them
  // all. (Worked out in place: it can run a few frames in a row.)
  _frame(job) {
    const cam = this.cam;
    const p = cam.position;
    const list = job.subjects;
    const me = list[0];
    // The camera's own axes, looking at your car: forward, right (level) and up.
    let fx = me.x - p.x;
    let fy = me.y + 0.7 - p.y;
    let fz = me.z - p.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const rl = Math.hypot(fz, fx) || 1;
    const rx = fz / rl;
    const rz = -fx / rl;
    const ux = fy * rz;
    const uy = fz * rx - fx * rz;
    const uz = -fy * rx;
    // Where each car is in the picture (as tangents of the angle across and
    // up from yours), with room round it.
    let h0 = 0;
    let h1 = 0;
    let v0 = 0;
    let v1 = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const dx = s.x - p.x;
      const dy = s.y + 0.7 - p.y;
      const dz = s.z - p.z;
      const depth = dx * fx + dy * fy + dz * fz;
      if (depth < 2) continue;
      const h = (dx * rx + dz * rz) / depth;
      const v = (dx * ux + dy * uy + dz * uz) / depth;
      const pad = ((s.length ?? 4.6) * 0.95) / depth;
      const a0 = Math.min(h0, h - pad);
      const a1 = Math.max(h1, h + pad);
      const b0 = Math.min(v0, v - pad * 0.6);
      const b1 = Math.max(v1, v + pad * 0.6);
      if (i > 0 && (a1 - a0 > 1.25 || b1 - b0 > 0.7)) continue;
      h0 = a0;
      h1 = a1;
      v0 = b0;
      v1 = b1;
    }
    const hc = (h0 + h1) / 2;
    const vc = (v0 + v1) / 2;
    this._at.set(p.x + (fx + rx * hc + ux * vc) * 10, p.y + (fy + uy * vc) * 10, p.z + (fz + rz * hc + uz * vc) * 10);
    cam.upVector.copyFrom(AXIS_Y);
    cam.setTarget(this._at);
    // (The field of view is up and down; the picture is wider than it is tall.)
    cam.fov = clamp(2 * Math.atan(Math.max((v1 - v0) / 2, ((h1 - h0) / 2) * (PHOTO_H / PHOTO_W)) * 1.08), 0.42, 1.2);
    return cam.fov;
  }

  _read(job) {
    job.phase = "packing";
    this.rtt.renderList = []; // (lets go of the meshes till the next picture)
    const p = this.rtt.readPixels(0, 0, this.pixels, false);
    if (p?.then) p.then(() => this._pack(job), () => (this.job = null));
    else this._pack(job);
  }

  // Into a JPEG, with what the camera read printed across it.
  _pack(job) {
    const W = PHOTO_W;
    const H = PHOTO_H;
    const src = this.pixels;
    const d = this.image.data;
    // (The rows come back bottom first.)
    for (let y = 0; y < H; y++) d.set(src.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    // Solid, and brighter where the flash lit it (at night). (The pixels stop at 255 by themselves.)
    const k = job.flash;
    for (let i = 0; i < d.length; i += 4) {
      if (k !== 1) {
        d[i] *= k;
        d[i + 1] *= k;
        d[i + 2] *= k;
      }
      d[i + 3] = 255;
    }
    const c = this.ctx2d;
    c.putImageData(this.image, 0, 0);
    if (job.kind === "finish") return this._packFinish(job);
    const units = this.hooks.units();
    c.fillStyle = "rgba(0, 0, 0, 0.66)";
    c.fillRect(0, 0, W, 30);
    c.fillRect(0, H - 26, W, 26);
    c.fillStyle = "#ffffff";
    c.textBaseline = "middle";
    c.font = "bold 16px ui-monospace, Menlo, Consolas, monospace";
    c.textAlign = "left";
    c.fillText(`${speedWords(job.speed, units)}  LIMIT ${limitWords(job.limit, units)}`.toUpperCase(), 10, 15);
    c.textAlign = "right";
    c.fillText(dateWords(job.taken, job.clock).toUpperCase(), W - 10, 15);
    c.font = "bold 14px ui-monospace, Menlo, Consolas, monospace";
    c.textAlign = "left";
    c.fillText(job.place.toUpperCase(), 10, H - 13);
    this.canvas.toBlob(
      (blob) => {
        this.job = null;
        if (!blob) return;
        blob.arrayBuffer().then((jpeg) => {
          const rec = { taken: job.taken, clock: job.clock, speed: +job.speed.toFixed(2), limit: job.limit, place: job.place, jpeg };
          this._show(rec, blob);
          this.hooks.keep(rec);
        });
      },
      "image/jpeg",
      0.85,
    );
  }

  // A race finish's strip: your place (in its medal's colour) and time, the
  // date, the race and "Photo finish".
  _packFinish(job) {
    const W = PHOTO_W;
    const H = PHOTO_H;
    const c = this.ctx2d;
    c.fillStyle = "rgba(0, 0, 0, 0.66)";
    c.fillRect(0, 0, W, 30);
    c.fillRect(0, H - 26, W, 26);
    c.textBaseline = "middle";
    c.font = "bold 16px ui-monospace, Menlo, Consolas, monospace";
    c.textAlign = "left";
    const pos = job.pos.toUpperCase();
    c.fillStyle = MEDAL_INK[job.medal] ?? "#ffffff";
    c.fillText(pos, 10, 15);
    c.fillStyle = "#ffffff";
    c.fillText(`  ${job.time.toUpperCase()}`, 10 + c.measureText(pos).width, 15);
    c.textAlign = "right";
    c.fillText(dateWords(job.taken, job.clock).toUpperCase(), W - 10, 15);
    c.font = "bold 14px ui-monospace, Menlo, Consolas, monospace";
    c.fillText("PHOTO FINISH", W - 10, H - 13);
    c.textAlign = "left";
    c.fillText(job.race.toUpperCase(), 10, H - 13, W - 150);
    this.canvas.toBlob(
      (blob) => {
        this.job = null;
        if (!blob) return;
        blob.arrayBuffer().then((jpeg) => {
          const rec = { kind: "finish", taken: job.taken, clock: job.clock, race: job.race, pos: job.pos, time: job.time, jpeg };
          this.hooks.keep(rec);
          job.done?.(rec, blob);
        });
      },
      "image/jpeg",
      0.88,
    );
  }

  _show(rec, blob) {
    if (this.cardUrl) URL.revokeObjectURL(this.cardUrl);
    this.cardUrl = URL.createObjectURL(blob);
    this.cardImg.src = this.cardUrl;
    this.cardRec = rec;
    this.card.classList.add("show");
    this.cardTime = CARD_FOR;
  }
}
