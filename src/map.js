import { ISLANDS, TOWNS, SEA_LEVEL, WORLD_SCALE } from "./world/layout.js";
import { clamp } from "./noise.js";

// World bounds shown on the map (metres) and map resolution.
const X0 = -2650 * WORLD_SCALE;
const X1 = 2650 * WORLD_SCALE;
const Z0 = -2650 * WORLD_SCALE;
const Z1 = 950 * WORLD_SCALE;
const MPP = 5; // metres per map pixel

// Landmarks come first (they get labels on the big map); then every town.
// More landmarks are added by the game as it sets them up.
export const PLACES = [
  ...ISLANDS.flatMap((isl) => isl.landmarks.filter((lm) => lm.name).map((lm) => ({ name: lm.name, country: isl.name, x: lm.x, z: lm.z, landmark: true, sea: !!lm.sea }))),
  { name: "Red Bridge", country: "USA", x: -1250 * WORLD_SCALE, z: -24 * WORLD_SCALE, landmark: true },
  ...TOWNS.map((t) => ({ name: t.name, country: ISLANDS.find((i) => i.id === t.island).name, x: t.cx, z: t.cz })),
];

const toPx = (x, z) => [(x - X0) / MPP, (Z1 - z) / MPP];

// Fuel stations, shown as small pump badges on both maps.
let FUEL = [];
export function setFuelStations(list) {
  FUEL = list;
}

function drawFuelBadge(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = "#0d5f63";
  c.fill();
  c.lineWidth = r * 0.22;
  c.strokeStyle = "#ffffff";
  c.stroke();
  // A tiny pump.
  c.fillStyle = "#ffffff";
  c.fillRect(x - r * 0.38, y - r * 0.45, r * 0.5, r * 0.9);
  c.fillRect(x + r * 0.12, y - r * 0.2, r * 0.3, r * 0.12);
}
const toWorld = (px, py) => [X0 + px * MPP, Z1 - py * MPP];

// Paints the whole world once: sea, beaches, hills (with shading), towns, roads.
export function renderMapImage(world, parks = []) {
  const w = Math.round((X1 - X0) / MPP);
  const h = Math.round((Z1 - Z0) / MPP);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const heights = new Float32Array(w * h);
  const climate = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const [x, z] = toWorld(px + 0.5, py + 0.5);
      const isl = world.islandAt(x, z);
      heights[py * w + px] = isl ? isl.getHeight(x, z) : -24;
      climate[py * w + px] = isl && isl.def.climate === "desert" ? 1 : 0;
    }
  }
  const mix = (a, b, t) => a + (b - a) * t;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = py * w + px;
      const hh = heights[i];
      let c;
      if (hh < SEA_LEVEL) {
        const t = clamp(-hh / 18, 0, 1);
        c = [mix(76, 22, t), mix(150, 78, t), mix(170, 112, t)];
      } else if (hh < 2.6) c = [222, 205, 160];
      else if (climate[i]) c = [mix(220, 196, clamp(hh / 30, 0, 1)), mix(196, 168, clamp(hh / 30, 0, 1)), mix(140, 112, clamp(hh / 30, 0, 1))];
      else {
        const t = clamp((hh - 3) / 70, 0, 1);
        c = [mix(108, 140, t), mix(152, 140, t), mix(86, 104, t)];
      }
      // Hill shading from the north-west.
      if (hh >= SEA_LEVEL) {
        const e = heights[Math.max(0, i - 1)] - heights[Math.min(w * h - 1, i + 1)];
        const n = heights[Math.max(0, i - w)] - heights[Math.min(w * h - 1, i + w)];
        const shade = clamp(1 + (e + n) * 0.06, 0.7, 1.25);
        c = c.map((v) => v * shade);
      }
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Towns
  ctx.fillStyle = "rgba(120, 112, 104, 0.55)";
  for (const t of TOWNS) {
    const [ax, ay] = toPx(t.cx - t.hx, t.cz + t.hz);
    ctx.fillRect(ax, ay, (t.hx * 2) / MPP, (t.hz * 2) / MPP);
  }
  // Parks, in green over their town.
  ctx.fillStyle = "rgba(86, 150, 70, 0.95)";
  for (const p of parks) {
    const [ax, ay] = toPx(p.x0, p.z1);
    ctx.fillRect(ax, ay, (p.x1 - p.x0) / MPP, (p.z1 - p.z0) / MPP);
  }
  // Roads: dark edge, light middle.
  const drawRoad = (road, width, colour) => {
    ctx.beginPath();
    road.points.forEach(([x, z], k) => {
      const [px, py] = toPx(x, z);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    if (road.closed) ctx.closePath();
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.lineJoin = "round";
    ctx.stroke();
  };
  for (const r of world.network.roads) drawRoad(r, 7, "#3b3f45");
  for (const r of world.network.roads) drawRoad(r, 3.5, r.closed ? "#f4f1e8" : "#ffe08a");
  // Country names
  ctx.textAlign = "center";
  ctx.font = "bold 34px -apple-system, Segoe UI, sans-serif";
  for (const isl of ISLANDS) {
    const [px, py] = toPx(isl.cx, isl.cz + isl.coast * 0.62);
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.strokeText(isl.name.toUpperCase(), px, py);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(isl.name.toUpperCase(), px, py);
  }
  return canvas;
}

function drawPin(ctx, x, y, colour) {
  ctx.beginPath();
  ctx.arc(x, y - 16, 9, 0, Math.PI * 2);
  ctx.moveTo(x - 7, y - 11);
  ctx.lineTo(x, y);
  ctx.lineTo(x + 7, y - 11);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
}

function drawArrow(ctx, x, y, angle, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.7, size * 0.75);
  ctx.lineTo(0, size * 0.35);
  ctx.lineTo(-size * 0.7, size * 0.75);
  ctx.closePath();
  ctx.fillStyle = "#ffcf4a";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#1a1d22";
  ctx.stroke();
  ctx.restore();
}

function drawRoute(ctx, route, from) {
  if (!route) return;
  ctx.beginPath();
  let started = false;
  for (let i = from; i < route.points.length; i += 2) {
    const p = route.points[i];
    const [px, py] = toPx(p.x, p.z);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = "#2f8cff";
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

// Small round map in the corner, turned so you always face up.
export class MiniMap {
  constructor(canvas, image) {
    this.canvas = canvas;
    this.image = image;
    this.ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = canvas.clientWidth || 150;
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    this.ctx.scale(dpr, dpr);
    this.timer = 0;
  }

  draw(dt, x, z, heading, route, progress, destination) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 15;
    const c = this.ctx;
    const s = this.size;
    c.clearRect(0, 0, s, s);
    c.save();
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = "#1d4e6b";
    c.fillRect(0, 0, s, s);
    const [px, py] = toPx(x, z);
    c.translate(s / 2, s / 2);
    c.rotate(-heading);
    c.scale(1.7, 1.7);
    c.translate(-px, -py);
    c.drawImage(this.image, 0, 0);
    drawRoute(c, route, progress);
    for (const s of FUEL) drawFuelBadge(c, ...toPx(s.x, s.z), 4.5);
    if (destination) {
      const [dx, dy] = toPx(destination.x, destination.z);
      c.beginPath();
      c.arc(dx, dy, 5, 0, Math.PI * 2);
      c.fillStyle = "#e2574c";
      c.fill();
    }
    c.restore();
    drawArrow(c, s / 2, s / 2, 0, 9);
    c.beginPath();
    c.arc(s / 2, s / 2, s / 2 - 1.5, 0, Math.PI * 2);
    c.lineWidth = 3;
    c.strokeStyle = "rgba(255,255,255,0.85)";
    c.stroke();
    // North marker
    const nAngle = -heading - Math.PI / 2;
    const nx = s / 2 + Math.cos(nAngle) * (s / 2 - 12);
    const ny = s / 2 + Math.sin(nAngle) * (s / 2 - 12);
    c.font = "bold 12px -apple-system, Segoe UI, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = "#fff";
    c.fillText("N", nx, ny);
  }
}

// Full-screen map you can drag around, zoom, and tap to pick a destination.
export class BigMap {
  constructor(canvas, image, onPick) {
    this.canvas = canvas;
    this.image = image;
    this.onPick = onPick;
    this.ctx = canvas.getContext("2d");
    this.zoom = 0;
    this.cx = 0;
    this.cy = 0;
    this.player = { x: 0, z: 0, heading: 0 };
    this.route = null;
    this.destination = null;
    let down = null;
    canvas.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 8) down.moved = true;
      this.cx = down.cx - dx / this.zoom;
      this.cy = down.cy - dy / this.zoom;
      this.draw();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (down && !down.moved) {
        const r = canvas.getBoundingClientRect();
        const px = this.cx + (e.clientX - r.left - r.width / 2) / this.zoom;
        const py = this.cy + (e.clientY - r.top - r.height / 2) / this.zoom;
        const [x, z] = toWorld(px, py);
        this.onPick(x, z);
      }
      down = null;
    });
  }

  open(player) {
    this.player = player;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    // Start centred on the player, zoomed so a good chunk of the world shows.
    const fit = Math.min(this.w / this.image.width, this.h / this.image.height);
    this.zoom = Math.max(fit, 0.55);
    [this.cx, this.cy] = toPx(player.x, player.z);
    this.draw();
  }

  zoomBy(f) {
    const fit = Math.min(this.w / this.image.width, this.h / this.image.height);
    this.zoom = clamp(this.zoom * f, fit * 0.9, 3);
    this.draw();
  }

  centreOn(x, z) {
    [this.cx, this.cy] = toPx(x, z);
    this.draw();
  }

  draw() {
    const c = this.ctx;
    c.fillStyle = "#1d4e6b";
    c.fillRect(0, 0, this.w, this.h);
    c.save();
    c.translate(this.w / 2, this.h / 2);
    c.scale(this.zoom, this.zoom);
    c.translate(-this.cx, -this.cy);
    c.drawImage(this.image, 0, 0);
    drawRoute(c, this.route, 0);
    c.restore();
    const screen = (x, z) => {
      const [px, py] = toPx(x, z);
      return [(px - this.cx) * this.zoom + this.w / 2, (py - this.cy) * this.zoom + this.h / 2];
    };
    // Landmark labels
    c.font = "600 13px -apple-system, Segoe UI, sans-serif";
    c.textAlign = "center";
    for (const p of PLACES.filter((q) => q.landmark)) {
      const [sx, sy] = screen(p.x, p.z);
      c.beginPath();
      c.arc(sx, sy, 6, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = "#1a1d22";
      c.stroke();
      c.lineWidth = 4;
      c.strokeStyle = "rgba(0,0,0,0.55)";
      c.strokeText(p.name, sx, sy - 12);
      c.fillStyle = "#fff";
      c.fillText(p.name, sx, sy - 12);
    }
    for (const s of FUEL) drawFuelBadge(c, ...screen(s.x, s.z), 9);
    if (this.destination) {
      const [dx, dy] = screen(this.destination.x, this.destination.z);
      drawPin(c, dx, dy, "#e2574c");
    }
    const [sx, sy] = screen(this.player.x, this.player.z);
    drawArrow(c, sx, sy, this.player.heading, 11);
  }
}
