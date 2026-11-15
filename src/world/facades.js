import { DynamicTexture, PBRMaterial, Texture, Color3 } from "@babylonjs/core";
import { mulberry32 } from "../noise.js";

// Facade pictures for the town buildings, painted in code.
//
// Each picture is an atlas 6 bays (21 m) wide with three rows, bottom to top:
//   g: the ground floor (shop fronts, doors, lobbies), as tall as GROUND[style];
//   u: one upper storey of the street front;
//   s: two storeys of plainer side and back wall, squashed into fewer pixels
//      (side walls are mostly seen side-on).
// Walls are drawn a storey (or two) at a time with texture coordinates into
// one row, so one picture gives a building a shop floor, windows above and
// plain sides. Along the wall the picture repeats; up the wall it doesn't.

export const BAY = 3.5; // metres per window bay
export const FLOOR = 3.4; // metres per storey
export const ATLAS_BAYS = 6;
export const ATLAS_M = ATLAS_BAYS * BAY;
export const GROUND = { british: 4.0, paris: 4.6, city: 4.6, desert: 3.6 };

const W = 1024;
const H = 512;
const S_PX = 112; // the side row: two storeys
const PX = W / ATLAS_M; // pixels per metre across

// Roughness map colours: red = ambient light, green = roughness, blue = metal.
const ORM = {
  wall: "rgb(255, 225, 0)",
  stone: "rgb(255, 205, 0)",
  frame: "rgb(255, 130, 0)",
  paint: "rgb(255, 105, 0)",
  glass: "rgb(255, 18, 0)",
  blind: "rgb(255, 210, 0)",
  metal: "rgb(255, 120, 190)",
};

const WINDOW_GLOWS = ["#ffd9a0", "#ffe8c2", "#fff2dc", "#ffcf8a", "#d9e6ff"];
const TV_GLOWS = ["#8fb2ff", "#a7c4ff", "#7f9cf0"]; // a few rooms lit by a television

// Rows of an atlas for one style. y0 is the row's top pixel, py its pixels per
// metre up the wall, v0..v1 its share of the texture (v = 0 at the bottom).
export function atlasRows(style) {
  const gH = GROUND[style];
  const rest = H - S_PX;
  const gPx = Math.round((rest * gH) / (gH + FLOOR));
  const uPx = rest - gPx;
  return {
    g: { y0: S_PX + uPx, px: gPx, m: gH, py: gPx / gH, v0: 0, v1: gPx / H },
    u: { y0: S_PX, px: uPx, m: FLOOR, py: uPx / FLOOR, v0: gPx / H, v1: (gPx + uPx) / H },
    s: { y0: 0, px: S_PX, m: FLOOR * 2, py: S_PX / (FLOOR * 2), v0: (gPx + uPx) / H, v1: 1 },
  };
}

// Draws the same shapes on the colour, roughness and night-glow pictures.
// The glow picture is half size: lit windows don't need the detail.
class Painter {
  constructor(scene, name) {
    const make = (suffix, w, h) => new DynamicTexture(`${name}_${suffix}`, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    this.albedo = make("albedo", W, H);
    this.orm = make("orm", W, H);
    this.glow = make("glow", W / 2, H / 2);
    this.a = this.albedo.getContext();
    this.o = this.orm.getContext();
    this.g = this.glow.getContext();
    this.g.scale(0.5, 0.5);
    this.g.fillStyle = "#000";
    this.g.fillRect(0, 0, W, H);
  }

  fill(shape, albedo, orm, glow) {
    for (const [c, style] of [[this.a, albedo], [this.o, orm], [this.g, glow]]) {
      if (style == null) continue;
      c.fillStyle = style;
      c.beginPath();
      shape(c);
      c.fill();
    }
  }

  rect(x, y, w, h, albedo, orm, glow) {
    this.fill((c) => c.rect(x, y, w, h), albedo, orm, glow);
  }
}

// Metre coordinates inside one row, starting `left` metres from the atlas edge.
// box(m0, h0, m1, h1) is a rectangle from (m0, h0) to (m1, h1), h up from the row's floor.
function frame(p, row, left = 0) {
  const x = (m) => (left + m) * PX;
  const y = (h) => row.y0 + row.px - h * row.py;
  return {
    x,
    y,
    box(m0, h0, m1, h1, albedo, orm, glow) {
      p.rect(x(m0), y(h1), (m1 - m0) * PX, (h1 - h0) * row.py, albedo, orm, glow);
    },
  };
}

// Window outline: square, round-arched or with a shallow arch.
function windowPath(c, x, y, w, h, top, ry) {
  if (top === "arch") {
    const r = w / 2;
    const rr = r * ry;
    c.moveTo(x, y + h);
    c.lineTo(x, y + rr);
    c.ellipse(x + r, y + rr, r, rr, 0, Math.PI, 0);
    c.lineTo(x + w, y + h);
    c.closePath();
  } else if (top === "segment") {
    const rise = w * 0.1 * ry;
    c.moveTo(x, y + h);
    c.lineTo(x, y + rise);
    c.quadraticCurveTo(x + w / 2, y - rise, x + w, y + rise);
    c.lineTo(x + w, y + h);
    c.closePath();
  } else c.rect(x, y, w, h);
}

function glassGradient(c, y, h, top = "#5d6f7d", bottom = "#1b242c") {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  return g;
}

function pickGlow(rand, chance) {
  if (rand() >= chance) return null;
  return rand() < 0.1 ? TV_GLOWS[Math.floor(rand() * TV_GLOWS.length)] : WINDOW_GLOWS[Math.floor(rand() * WINDOW_GLOWS.length)];
}

// One window: frame, glass, blinds, glazing bars, sill, lintel, shutters,
// a rain streak below and (sometimes) a light on at night.
function paintWindow(p, rand, x, y, w, h, win, ry, glowChance = 0.48) {
  const t = Math.max(3, w * 0.07);
  const top = win.top ?? "flat";
  const a = p.a;
  if (win.shutters) {
    // Two shutters folded back beside the window, with slats.
    for (const sx of [x - w / 2 - t, x + w + t]) {
      p.rect(sx, y, w / 2, h, win.shutters, ORM.paint);
      a.fillStyle = "rgba(0,0,0,0.22)";
      for (let k = y + 4; k < y + h - 2; k += 5) a.fillRect(sx + 2, k, w / 2 - 4, 1.5);
    }
  }
  if (win.lintel === "keystone" || win.lintel === "cornice") {
    p.rect(x - t * 2, y - t * 3.2, w + t * 4, t * 2.2, win.stone ?? "#e9e2d2", ORM.stone);
    if (win.lintel === "cornice") p.rect(x - t * 2.6, y - t * 3.8, w + t * 5.2, t * 0.9, "rgba(0,0,0,0.25)");
    else p.rect(x + w / 2 - t * 1.2, y - t * 3.6, t * 2.4, t * 3.2, win.stone ?? "#e9e2d2", ORM.stone);
  } else if (win.lintel === "brick") {
    p.fill((c) => windowPath(c, x - t * 1.8, y - t * 2.2, w + t * 3.6, h, top, ry), "#8e4a3a", ORM.wall);
  } else if (win.lintel === "flat") {
    p.rect(x - t * 1.5, y - t * 2.4, w + t * 3, t * 2.2, win.stone ?? "#ddd5c4", ORM.stone);
  }
  // Frame, then glass.
  p.fill((c) => windowPath(c, x - t, y - t, w + 2 * t, h + 2 * t, top, ry), win.frame, ORM.frame);
  const glow = pickGlow(rand, glowChance);
  p.fill((c) => windowPath(c, x, y, w, h, top, ry), glassGradient(a, y, h, win.glassTop, win.glassBottom), ORM.glass, glow ?? undefined);
  // A blind or curtains part-way down (a different one in each window).
  if (rand() < 0.42) {
    const bh = h * (0.12 + rand() * 0.5);
    const col = win.blinds ? win.blinds[Math.floor(rand() * win.blinds.length)] : rand() < 0.5 ? "#d6cdb9" : "#8f857a";
    a.save();
    a.beginPath();
    windowPath(a, x, y, w, h, top, ry);
    a.clip();
    p.rect(x, y, w, bh + (top === "arch" ? w * 0.5 * ry : 0), col, ORM.blind);
    a.restore();
    if (glow) {
      p.g.fillStyle = "rgba(0,0,0,0.45)";
      p.g.fillRect(x, y, w, bh);
    }
  }
  // Glazing bars.
  a.fillStyle = win.frame;
  const bar = Math.max(2, t * 0.55);
  const bars = win.bars ?? "sash";
  if (bars === "sash") {
    a.fillRect(x, y + h * 0.5 - bar / 2, w, bar);
    a.fillRect(x + w / 2 - bar / 2, y, bar, h);
  } else if (bars === "french") {
    a.fillRect(x + w / 2 - bar / 2, y, bar, h);
    a.fillRect(x, y + h * 0.28, w, bar);
    a.fillRect(x, y + h * 0.62, w, bar);
  } else if (bars === "casement") {
    a.fillRect(x + w / 2 - bar / 2, y, bar, h);
  } else if (bars === "wide") {
    a.fillRect(x + w / 3 - bar / 2, y, bar, h);
    a.fillRect(x + (2 * w) / 3 - bar / 2, y, bar, h);
    a.fillRect(x, y + h * 0.78, w, bar);
  } else if (bars === "grid") {
    for (const f of [1 / 3, 2 / 3]) a.fillRect(x, y + h * f - bar / 2, w, bar);
    a.fillRect(x + w / 2 - bar / 2, y, bar, h);
  }
  // A low iron rail across a tall window (Paris).
  if (win.rail) {
    const ry0 = y + h * 0.7;
    a.fillStyle = win.rail;
    a.fillRect(x - t, ry0, w + 2 * t, t * 0.8);
    a.fillRect(x - t, y + h - t * 0.6, w + 2 * t, t * 0.6);
    for (let k = x; k <= x + w; k += Math.max(4, w / 9)) a.fillRect(k, ry0, 1.6, y + h - ry0);
    a.strokeStyle = win.rail;
    a.lineWidth = 1.4;
    for (let k = x + w / 8; k < x + w; k += w / 4) {
      a.beginPath();
      a.ellipse(k, ry0 + (y + h - ry0) / 2, w / 12, (y + h - ry0) / 3, 0, 0, Math.PI * 2);
      a.stroke();
    }
  }
  // Sill, with a faint rain streak below it.
  if (win.sill !== false) {
    p.rect(x - t * 1.6, y + h + t * 0.6, w + t * 3.2, t * 1.4, win.stone ?? "#e6e0d4", ORM.stone);
    const streak = a.createLinearGradient(0, y + h + t * 2, 0, y + h + t * 2 + h * 0.5);
    streak.addColorStop(0, "rgba(40,34,28,0.16)");
    streak.addColorStop(1, "rgba(40,34,28,0)");
    a.fillStyle = streak;
    a.fillRect(x + w * 0.1, y + h + t * 2, w * 0.8, h * 0.5);
  }
}

function signText(c, text, cx, cy, maxW, hPx, colour, font) {
  let size = Math.floor(hPx * 0.72);
  c.font = `bold ${size}px ${font}`;
  while (size > 8 && c.measureText(text).width > maxW) {
    size--;
    c.font = `bold ${size}px ${font}`;
  }
  c.fillStyle = colour;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text, cx, cy);
}

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Helvetica, Arial, sans-serif";

// ---- Ground-floor units (each two bays, 7 m, wide) ---------------------------------

// A shop: painted frame, a name board, a big window and a glazed door.
function paintShop(p, f, rand, u, gH, spec) {
  const c = u.colour;
  const fasciaTop = gH - (spec.style === "paris" ? 0.3 : 0.35);
  const fasciaBot = fasciaTop - (spec.style === "city" ? 0.8 : 0.66);
  f.box(0.05, 0, 6.95, fasciaTop + 0.12, c, ORM.paint);
  // Pilasters with a little shading, and a cornice above the name board.
  f.box(0.05, 0, 0.42, fasciaTop, "rgba(0,0,0,0.18)");
  f.box(6.58, 0, 6.95, fasciaTop, "rgba(0,0,0,0.18)");
  f.box(-0.05, fasciaTop, 7.05, fasciaTop + 0.16, spec.style === "city" ? "#2c2f33" : "rgba(0,0,0,0.35)", ORM.paint);
  // Name board.
  f.box(0.5, fasciaBot, 6.5, fasciaTop - 0.04, u.board ?? c, ORM.paint);
  const ry = f.y(0) - f.y(1); // pixels per metre up the wall
  signText(p.a, u.text, f.x(3.5), f.y((fasciaBot + fasciaTop) / 2), 5.6 * PX, (fasciaTop - fasciaBot) * ry, u.ink ?? "#f1d58a", spec.font ?? SERIF);
  // Display window over a panelled base, and the door at the right.
  const lit = rand() < 0.75 ? "#ffe2b0" : null; // some shops stay dark at night
  const doorAt = 5.3;
  const winA = 0.55;
  const winB = 5.15;
  f.box(winA, 0.12, winB, 0.62, "rgba(0,0,0,0.25)", ORM.paint);
  f.box(winA, 0.68, winB, fasciaBot - 0.14, glassGradient(p.a, f.y(fasciaBot - 0.14), (fasciaBot - 0.82) * ry, "#6f8494", "#20282f"), ORM.glass, lit ?? undefined);
  // Things on show in the window.
  for (let k = 0; k < 6; k++) {
    const gx = winA + 0.3 + rand() * (winB - winA - 0.9);
    const gw = 0.25 + rand() * 0.5;
    const gh = 0.2 + rand() * 0.7;
    f.box(gx, 0.7, gx + gw, 0.7 + gh, `hsl(${Math.floor(rand() * 360)}, 35%, ${30 + rand() * 30}%)`, ORM.blind);
  }
  f.box((winA + winB) / 2 - 0.05, 0.68, (winA + winB) / 2 + 0.05, fasciaBot - 0.14, c, ORM.paint);
  f.box(doorAt, 0, doorAt + 1.15, fasciaBot - 0.14, "rgba(0,0,0,0.35)");
  f.box(doorAt + 0.08, 0, doorAt + 1.07, fasciaBot - 0.22, c, ORM.paint);
  f.box(doorAt + 0.2, 1.0, doorAt + 0.95, fasciaBot - 0.4, glassGradient(p.a, f.y(fasciaBot), 60, "#55687a", "#1b242c"), ORM.glass, lit ? "#b89a70" : undefined);
}

// A front door to the homes or offices above, with a window beside it.
function paintDoor(p, f, rand, u, gH, spec) {
  const plinth = spec.plinth ?? "rgba(0,0,0,0.28)";
  f.box(0, 0, 7, 0.45, plinth);
  const big = spec.style === "paris";
  const dx = big ? 2.2 : 1.0;
  const dw = big ? 2.6 : 1.1;
  const dh = big ? 3.7 : 2.3;
  // Stone surround and step.
  f.box(dx - 0.22, 0, dx + dw + 0.22, dh + 0.5, spec.stone ?? "#e4ddcc", ORM.stone);
  f.box(dx - 0.3, -0.05, dx + dw + 0.3, 0.14, "#cfc8b8", ORM.stone);
  const ry = f.y(0) - f.y(1);
  if (big) {
    // Tall arched double door (a carriage entrance).
    p.fill((c) => windowPath(c, f.x(dx), f.y(dh), dw * PX, dh * ry, "arch", ry / PX), u.colour, ORM.paint);
    p.a.fillStyle = "rgba(0,0,0,0.3)";
    p.a.fillRect(f.x(dx + dw / 2) - 1.5, f.y(dh - 0.4), 3, (dh - 0.4) * ry);
    for (const hh of [0.5, 1.6, 2.6]) for (const m of [dx + 0.2, dx + dw / 2 + 0.15]) p.a.fillRect(f.x(m), f.y(hh + 0.8), (dw / 2 - 0.35) * PX, 2);
  } else {
    f.box(dx, 0.14, dx + dw, dh, u.colour, ORM.paint);
    p.a.fillStyle = "rgba(0,0,0,0.25)";
    for (const [m0, h0] of [[0.15, 0.4], [0.62, 0.4], [0.15, 1.3], [0.62, 1.3]]) p.a.fillRect(f.x(dx + m0), f.y(h0 + 0.75), 0.33 * PX, 0.75 * ry);
    // Fanlight over the door, sometimes lit.
    p.fill((c) => windowPath(c, f.x(dx), f.y(dh + 0.45), dw * PX, 0.4 * ry, "arch", ry / PX * 0.7), glassGradient(p.a, f.y(dh + 0.45), 20), ORM.glass, rand() < 0.5 ? "#ffd9a0" : undefined);
    p.a.fillStyle = "#c9a23a";
    p.a.fillRect(f.x(dx + 0.85), f.y(1.1), 4, 4);
  }
  // A ground-floor window beside the door.
  const win = { ...spec.win, top: spec.win.top === "arch" ? "arch" : "flat" };
  const wx = big ? 0.5 : 3.7;
  const ww = big ? 1.2 : 2.0;
  paintWindow(p, rand, f.x(wx), f.y(3.0), ww * PX, 2.0 * ry, win, ry / PX, 0.4);
  if (!big) paintWindow(p, rand, f.x(5.9), f.y(3.0), 0.8 * PX, 2.0 * ry, { ...win, bars: "casement" }, ry / PX, 0.3);
  else paintWindow(p, rand, f.x(5.3), f.y(3.0), 1.2 * PX, 2.0 * ry, win, ry / PX, 0.4);
}

// An office lobby: tall glass, a revolving door and the street number.
function paintLobby(p, f, rand, u, gH) {
  f.box(0, 0, 7, gH, "#cfcac0", ORM.stone);
  f.box(0.3, 0.05, 6.7, gH - 0.75, "#2a2f35", ORM.metal);
  f.box(0.42, 0.12, 6.58, gH - 0.85, glassGradient(p.a, f.y(gH - 0.85), (gH - 1) * 50, "#7d93a6", "#26313b"), ORM.glass, "#fff1d6");
  p.a.fillStyle = "#2a2f35";
  for (let m = 0.42 + 1.36; m < 6.5; m += 1.36) p.a.fillRect(f.x(m) - 2, f.y(gH - 0.85), 4, (gH - 0.97) * (f.y(0) - f.y(1)));
  // Revolving door: a dark drum with a bright band.
  f.box(2.6, 0.12, 4.4, 2.6, "#1e2329", ORM.metal);
  f.box(2.75, 0.2, 4.25, 2.45, glassGradient(p.a, f.y(2.45), 60, "#9fb2c2", "#3b4855"), ORM.glass, "#fff6e4");
  f.box(2.6, 2.6, 4.4, 2.75, "#9a9ea3", ORM.metal);
  signText(p.a, u.text, f.x(3.5), f.y(gH - 0.4), 3 * PX, 0.5 * (f.y(0) - f.y(1)), "#3a3d42", SANS);
}

// A desert shop: a wide arched opening, goods inside, a shutter half down.
function paintArchShop(p, f, rand, u, gH, spec) {
  const ry = f.y(0) - f.y(1);
  f.box(0, 0, 7, 0.35, "rgba(0,0,0,0.2)");
  p.fill((c) => windowPath(c, f.x(0.55), f.y(3.0), 5.9 * PX, 3.0 * ry, "arch", ry / PX), spec.stone ?? "#d9c3a0", ORM.stone);
  const lit = rand() < 0.7 ? "#ffcf8a" : undefined;
  p.fill((c) => windowPath(c, f.x(0.85), f.y(2.8), 5.3 * PX, 2.8 * ry, "arch", ry / PX), "#2b2119", ORM.blind, lit);
  // Rugs hanging at the back, sacks of spice along the front.
  for (let k = 0; k < 4; k++) {
    const gx = 1.3 + k * 1.15 + rand() * 0.2;
    const hue = Math.floor(rand() * 40);
    f.box(gx, 0.9, gx + 0.85, 2.1, `hsl(${hue}, 55%, ${28 + rand() * 15}%)`, ORM.blind);
    f.box(gx + 0.1, 1.1, gx + 0.75, 1.9, `hsl(${hue + 25}, 50%, ${40 + rand() * 15}%)`, ORM.blind);
    f.box(gx, 1.45, gx + 0.85, 1.55, "rgba(240,220,170,0.6)");
  }
  for (let k = 0; k < 7; k++) {
    const gx = 1.25 + k * 0.72 + rand() * 0.15;
    p.fill((c) => c.ellipse(f.x(gx), f.y(0.32), 0.3 * PX, 0.36 * ry, 0, 0, Math.PI * 2), `hsl(${Math.floor(rand() * 45)}, ${55 + rand() * 25}%, ${32 + rand() * 25}%)`, ORM.blind);
  }
  // Roller shutter part-way down (inside the arch).
  for (const c of [p.a, p.o]) {
    c.save();
    c.beginPath();
    windowPath(c, f.x(0.85), f.y(2.8), 5.3 * PX, 2.8 * ry, "arch", ry / PX);
    c.clip();
  }
  f.box(0.85, 1.9 + rand() * 0.4, 6.15, 2.85, "#8d8a84", ORM.metal);
  p.a.fillStyle = "rgba(0,0,0,0.25)";
  for (let h = 2.0; h < 2.85; h += 0.08) p.a.fillRect(f.x(0.85), f.y(h), 5.3 * PX, 1);
  p.a.restore();
  p.o.restore();
  // Name board above the arch.
  f.box(1.6, 3.04, 5.4, 3.48, u.board ?? "#2f5a4a", ORM.paint);
  signText(p.a, u.text, f.x(3.5), f.y(3.26), 3.5 * PX, 0.44 * ry, u.ink ?? "#f3e3b5", SANS);
}

// A desert front door: an arched wooden door in a pale surround.
function paintArchDoor(p, f, rand, u, gH, spec) {
  const ry = f.y(0) - f.y(1);
  f.box(0, 0, 7, 0.35, "rgba(0,0,0,0.2)");
  p.fill((c) => windowPath(c, f.x(2.6), f.y(2.75), 1.8 * PX, 2.75 * ry, "arch", ry / PX), spec.stone ?? "#efe4cf", ORM.stone);
  p.fill((c) => windowPath(c, f.x(2.8), f.y(2.55), 1.4 * PX, 2.55 * ry, "arch", ry / PX), u.colour, ORM.paint);
  p.a.fillStyle = "rgba(0,0,0,0.3)";
  p.a.fillRect(f.x(3.5) - 1, f.y(2.2), 2, 2.2 * ry);
  for (let h = 0.3; h < 2; h += 0.45) for (const m of [2.95, 3.6]) p.a.fillRect(f.x(m), f.y(h + 0.3), 0.25 * PX, 0.3 * ry);
  // A small window with a wooden grille.
  paintWindow(p, rand, f.x(5.0), f.y(2.3), 0.9 * PX, 1.1 * ry, { ...spec.win, bars: "grid" }, ry / PX, 0.4);
  paintWindow(p, rand, f.x(0.9), f.y(2.3), 0.9 * PX, 1.1 * ry, { ...spec.win, bars: "grid" }, ry / PX, 0.4);
}

const UNIT_PAINTERS = { shop: paintShop, door: paintDoor, lobby: paintLobby, archShop: paintArchShop, archDoor: paintArchDoor };

// Tiles a wall photo over a row, the right size for the wall (one tile is about 2.3 m).
function tileRow(c, img, row) {
  const tw = 2.3 * PX;
  const th = 2.3 * row.py;
  c.save();
  c.beginPath();
  c.rect(0, row.y0, W, row.px);
  c.clip();
  for (let y = row.y0 + row.px; y > row.y0 - th; y -= th) for (let x = 0; x < W; x += tw) c.drawImage(img, x, y - th, tw, th);
  c.restore();
}

// Paints one facade atlas and returns its material.
function paintAtlas(scene, spec, images) {
  const rows = atlasRows(spec.style);
  const p = new Painter(scene, spec.name);
  const rand = mulberry32(spec.seed);
  const a = p.a;
  const img = images[spec.wall];

  // Wall: photo tiles, toned down (brick turned yellow-grey for London stock brick), then tinted.
  for (const row of [rows.g, rows.u, rows.s]) tileRow(a, img, row);
  if (spec.grey) {
    a.globalCompositeOperation = "saturation";
    a.fillStyle = `rgba(128,128,128,${spec.grey})`;
    a.fillRect(0, 0, W, H);
  }
  a.globalCompositeOperation = "multiply";
  a.fillStyle = spec.tint;
  a.fillRect(0, 0, W, H);
  a.globalCompositeOperation = "source-over";
  p.o.fillStyle = spec.wall === "stone" ? ORM.stone : ORM.wall;
  p.o.fillRect(0, 0, W, H);

  // Upper storey: a string course at the floor line, then a window in every bay.
  {
    const r = rows.u;
    const f = frame(p, r);
    if (spec.string) {
      f.box(0, 0, ATLAS_M, 0.24, spec.string, ORM.stone);
      f.box(0, -0.02, ATLAS_M, 0.03, "rgba(0,0,0,0.25)");
    } else f.box(0, 0, ATLAS_M, 0.06, "rgba(0,0,0,0.16)");
    if (spec.rustic) for (let h = 0.55; h < FLOOR; h += 0.55) f.box(0, h, ATLAS_M, h + 0.025, "rgba(0,0,0,0.12)");
    const win = spec.win;
    for (let b = 0; b < ATLAS_BAYS; b++) {
      const w = BAY * win.w;
      const h = FLOOR * win.h;
      const y0 = FLOOR * (win.y ?? 0.24);
      paintWindow(p, rand, f.x(b * BAY + (BAY - w) / 2), f.y(y0 + h), w * PX, h * r.py, win, r.py / PX);
    }
    if (spec.fireEscape) paintFireEscape(p, f);
  }

  // Side and back wall: two storeys, a few smaller windows and a drainpipe.
  {
    const r = rows.s;
    const f = frame(p, r);
    const win = { ...spec.win, rail: null, shutters: spec.win.shutters && rand() < 0.5 ? spec.win.shutters : null, bars: spec.win.bars === "wide" ? "casement" : spec.win.bars };
    for (let k = 0; k < 2; k++) {
      const base = k * FLOOR;
      f.box(0, base, ATLAS_M, base + 0.05, "rgba(0,0,0,0.12)");
      for (const b of spec.sideBays ?? [1, 4]) {
        const w = BAY * Math.min(win.w, 0.42);
        const h = FLOOR * Math.min(win.h, 0.5);
        paintWindow(p, rand, f.x(b * BAY + (BAY - w) / 2), f.y(base + 0.95 + h), w * PX, h * r.py, win, r.py / PX, 0.35);
      }
    }
    // Drainpipe with brackets, and a grubby streak down the wall beside it.
    const px = f.x(3 * BAY);
    a.fillStyle = "rgba(30,28,26,0.12)";
    a.fillRect(px - 10, 0, 24, r.px);
    p.rect(px - 3, 0, 6, r.px, spec.pipe ?? "#3b3d40", ORM.metal);
    a.fillStyle = spec.pipe ?? "#3b3d40";
    for (let y = 6; y < r.px; y += 14) a.fillRect(px - 5, y, 10, 2);
    a.fillRect(px - 8, 1, 16, 6);
  }

  // Ground floor: three units of two bays each.
  {
    const r = rows.g;
    const gH = r.m;
    const whole = frame(p, r);
    if (spec.rustic) {
      for (let h = 0.5; h < gH; h += 0.5) whole.box(0, h, ATLAS_M, h + 0.04, "rgba(0,0,0,0.2)");
    }
    whole.box(0, gH - 0.2, ATLAS_M, gH, spec.string ?? "rgba(0,0,0,0.15)", ORM.stone);
    spec.units.forEach((u, k) => {
      const f = frame(p, r, k * 2 * BAY);
      UNIT_PAINTERS[u.type](p, f, rand, u, gH, spec);
    });
  }

  for (const t of [p.albedo, p.orm, p.glow]) t.update(true);
  return { p, rows };
}

// A New York style fire escape across bays 2 to 4: a landing with railings at
// each floor and a stair up to the next (drawn on every storey, so they join).
function paintFireEscape(p, f) {
  const a = p.a;
  const iron = "#24262a";
  const ry = f.y(0) - f.y(1);
  f.box(7.2, 0, 13.8, 0.14, iron, ORM.metal);
  f.box(7.2, 1.0, 13.8, 1.06, iron, ORM.metal);
  a.fillStyle = iron;
  for (let m = 7.2; m <= 13.8; m += 0.16) a.fillRect(f.x(m), f.y(1.0), 1.3, 0.86 * ry);
  // The stair, rising to the right to the landing above.
  a.beginPath();
  a.moveTo(f.x(8.0), f.y(0.14));
  a.lineTo(f.x(12.6), f.y(3.4));
  a.lineTo(f.x(13.2), f.y(3.4));
  a.lineTo(f.x(8.6), f.y(0.14));
  a.closePath();
  a.fill();
  p.o.fillStyle = ORM.metal;
  p.o.beginPath();
  p.o.moveTo(f.x(8.0), f.y(0.14));
  p.o.lineTo(f.x(12.6), f.y(3.4));
  p.o.lineTo(f.x(13.2), f.y(3.4));
  p.o.lineTo(f.x(8.6), f.y(0.14));
  p.o.fill();
  a.strokeStyle = iron;
  a.lineWidth = 1.5;
  a.beginPath();
  a.moveTo(f.x(8.0), f.y(1.0));
  a.lineTo(f.x(12.6), f.y(4.2));
  a.stroke();
}

// Office tower curtain wall (repeats both ways): glass panels and mullions.
function paintGlass(scene, name, seed) {
  const GW = 1024;
  const GH = 512;
  const BAYS = 4;
  const FLOORS = 2;
  const rand = mulberry32(seed);
  const make = (suffix, w, h) => new DynamicTexture(`${name}_${suffix}`, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const albedo = make("albedo", GW, GH);
  const orm = make("orm", GW, GH);
  const glow = make("glow", GW / 2, GH / 2);
  const a = albedo.getContext();
  const o = orm.getContext();
  const g = glow.getContext();
  g.scale(0.5, 0.5);
  g.fillStyle = "#000";
  g.fillRect(0, 0, GW, GH);
  const bayPx = GW / BAYS;
  const floorPx = GH / FLOORS;
  for (let f = 0; f < FLOORS; f++) {
    for (let b = 0; b < BAYS; b++) {
      if (rand() < 0.4) {
        g.fillStyle = rand() < 0.7 ? "#e8f0ff" : "#ffe6b8";
        g.fillRect(b * bayPx, f * floorPx, bayPx, floorPx);
      }
      a.fillStyle = glassGradient(a, f * floorPx, floorPx, "#6f8aa3", "#20303f");
      a.fillRect(b * bayPx, f * floorPx, bayPx, floorPx);
      if (rand() < 0.2) {
        a.fillStyle = "rgba(230,225,210,0.35)";
        a.fillRect(b * bayPx, f * floorPx + floorPx * 0.75, bayPx, floorPx * 0.25);
      }
    }
  }
  o.fillStyle = "rgb(255, 14, 40)";
  o.fillRect(0, 0, GW, GH);
  a.fillStyle = "#c9ced3";
  o.fillStyle = "rgb(255, 90, 200)";
  g.fillStyle = "#000";
  for (let b = 0; b <= BAYS; b++) {
    a.fillRect(b * bayPx - 5, 0, 10, GH);
    o.fillRect(b * bayPx - 5, 0, 10, GH);
    g.fillRect(b * bayPx - 5, 0, 10, GH);
  }
  for (let f = 0; f <= FLOORS; f++) {
    a.fillRect(0, f * floorPx - 14, GW, 28);
    o.fillRect(0, f * floorPx - 14, GW, 28);
    g.fillRect(0, f * floorPx - 14, GW, 28);
  }
  for (const t of [albedo, orm, glow]) t.update(true);
  return { albedo, orm, glow };
}

// A facade material from painted pictures. (Colour variants don't need their
// own material: they are vertex colours, so each picture is drawn once for
// all its buildings.) `wrapV` is off for atlases.
function facadeMaterial(scene, name, { albedo, orm, glow }, wrapV) {
  for (const t of [albedo, orm, glow]) {
    // Dynamic textures clamp by default; facades repeat along the wall.
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = wrapV ? Texture.WRAP_ADDRESSMODE : Texture.CLAMP_ADDRESSMODE;
    t.anisotropicFilteringLevel = 4;
  }
  orm.gammaSpace = false;
  const m = new PBRMaterial(name, scene);
  m.albedoTexture = albedo;
  m.metallicTexture = orm;
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;
  // Lit windows: switched on at night by nightlights.js.
  m.emissiveTexture = glow;
  m.emissiveColor = new Color3(0, 0, 0);
  m.metadata = { windows: true };
  return m;
}

// ---- The facades of each style -------------------------------------------------------

const BRIT = { style: "british", font: SERIF };
const PARIS = { style: "paris", font: SERIF, wall: "stone", rustic: true };
const sash = (frame, extra = {}) => ({ w: 0.5, h: 0.6, frame, bars: "sash", ...extra });
const french = (extra = {}) => ({ w: 0.44, h: 0.72, y: 0.1, frame: "#ece6da", bars: "french", rail: "#262626", lintel: "keystone", ...extra });

// tints: colour variants of each facade (extra materials, same pictures).
export const FACADES = {
  british: [
    { ...BRIT, name: "facade_redbrick", seed: 2, wall: "brick", tint: "#f2ddd2", win: sash("#efece6", { top: "segment", lintel: "brick" }), units: [{ type: "shop", text: "Corner Cafe", colour: "#1f4a36" }, { type: "shop", text: "Hartley Books", colour: "#1d2b4a", ink: "#f4efe2" }, { type: "door", colour: "#8a1d1d" }], tints: [null, [0.9, 0.86, 0.84]] },
    { ...BRIT, name: "facade_yellowbrick", seed: 3, wall: "brick", grey: 0.75, tint: "#efe0bc", win: sash("#f1eee8", { lintel: "flat" }), units: [{ type: "shop", text: "Crown Bakery", colour: "#5b1f2b" }, { type: "door", colour: "#24406e" }, { type: "shop", text: "Barber", colour: "#141414", ink: "#e9e4d8" }], tints: [null] },
    { ...BRIT, name: "facade_stucco", seed: 1, wall: "plaster", tint: "#fff8ea", string: "#f6efe0", win: sash("#f4f1ea", { h: 0.64, lintel: "cornice", stone: "#f3ecdc" }), units: [{ type: "shop", text: "Bloom Florist", colour: "#1e5a5a" }, { type: "door", colour: "#161616" }, { type: "shop", text: "The Tea Room", colour: "#c8b27a", ink: "#2a2418" }], tints: [null, [0.96, 0.92, 0.85]] },
    { ...BRIT, name: "facade_pastel", seed: 4, wall: "plaster", tint: "#f7f3ea", win: sash("#f6f4ef"), units: [{ type: "shop", text: "Chemist", colour: "#2c5e3a", ink: "#f4efe2" }, { type: "shop", text: "Newsagent", colour: "#6a2c4a" }, { type: "door", colour: "#2a4f6e" }], tints: [[1, 0.86, 0.84], [0.84, 0.9, 1], [0.86, 1, 0.9], [1, 0.95, 0.8]] },
  ],
  paris: [
    { ...PARIS, name: "facade_paris1", seed: 5, tint: "#f6ead2", string: "#f2e6cc", win: french(), units: [{ type: "shop", text: "Cafe Margot", colour: "#5a1e1e" }, { type: "door", colour: "#1f3d2e" }, { type: "shop", text: "Dupont Bakery", colour: "#1d2b45" }], tints: [null] },
    { ...PARIS, name: "facade_paris2", seed: 6, tint: "#efebe3", string: "#ebe6dc", win: french({ top: "segment" }), units: [{ type: "shop", text: "Rose Flowers", colour: "#2b2b2b" }, { type: "shop", text: "Book Shop", colour: "#3f5a2a" }, { type: "door", colour: "#3a2a1e" }], tints: [null] },
    { ...PARIS, name: "facade_paris3", seed: 12, tint: "#f2dcb8", string: "#eed8b2", win: french({ lintel: "cornice" }), units: [{ type: "door", colour: "#22344a" }, { type: "shop", text: "Bistro Paul", colour: "#6b2a2a" }, { type: "shop", text: "Wine Cellar", colour: "#2a4a4a" }], tints: [null] },
  ],
  city: [
    { style: "city", font: SANS, name: "facade_office", seed: 9, wall: "plaster", tint: "#d9dbdc", sideBays: [1, 2, 4], win: { w: 0.8, h: 0.6, frame: "#3a4046", bars: "wide", sill: false, glassTop: "#7b90a2", glassBottom: "#1e2830" }, units: [{ type: "lobby", text: "200" }, { type: "shop", text: "Joe's Diner", colour: "#8c1c1c", ink: "#ffffff" }, { type: "shop", text: "Star Pizza", colour: "#1d1d1d", ink: "#f2c94c" }], tints: [null, [0.86, 0.83, 0.78]] },
    { style: "city", font: SANS, name: "facade_citybrick", seed: 13, wall: "brick", tint: "#e2c2b2", fireEscape: true, win: sash("#e8e4da", { w: 0.42, lintel: "flat" }), units: [{ type: "shop", text: "Sunny Deli", colour: "#2d5a2d", ink: "#fdf6e0" }, { type: "door", colour: "#2a2420" }, { type: "shop", text: "Drugstore", colour: "#21406b", ink: "#ffffff" }], tints: [null, [0.82, 0.78, 0.76]] },
  ],
  desert: [
    { style: "desert", font: SANS, name: "facade_mud", seed: 10, wall: "plaster", tint: "#e8c99a", stone: "#d9bd90", sideBays: [1, 4], win: { w: 0.3, h: 0.42, y: 0.28, frame: "#5a3a22", shutters: "#6b4a2a", bars: "grid", top: "arch" }, units: [{ type: "archShop", text: "Spice Market" }, { type: "archDoor", colour: "#6b4426" }, { type: "archShop", text: "Rug Shop", board: "#6e2a1e" }], tints: [null, [1, 0.9, 0.82]] },
    { style: "desert", font: SANS, name: "facade_white", seed: 11, wall: "plaster", tint: "#fbf3e3", stone: "#efe6d4", sideBays: [2, 4], win: { w: 0.3, h: 0.42, y: 0.28, frame: "#2f5a78", shutters: "#3a6e96", bars: "grid", top: "arch" }, units: [{ type: "archShop", text: "Tea House", board: "#2f5a78" }, { type: "archShop", text: "Lamp Shop", board: "#7a5a1e" }, { type: "archDoor", colour: "#2f5a78" }], tints: [null, [1, 0.94, 0.88]] },
  ],
};

// Paints every facade. Returns, per style, a list of sets:
//   { spec, rows, mat, tints: [[r, g, b] per colour variant], wallColour: [r, g, b] (0..1, average wall colour) }
// and the glass towers' material with its two colours.
export function buildFacades(scene, images) {
  const sets = {};
  for (const [style, specs] of Object.entries(FACADES)) {
    sets[style] = specs.map((spec) => {
      const { p, rows } = paintAtlas(scene, spec, images);
      // Average colour of a patch of plain wall (for roofs, gables and chimneys that match).
      const d = p.a.getImageData(Math.round(3 * BAY * PX) + 20, 30, 40, 40).data;
      const avg = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) avg[k] += d[i + k];
      const wallColour = avg.map((v) => v / (d.length / 4) / 255);
      const mat = facadeMaterial(scene, spec.name, { albedo: p.albedo, orm: p.orm, glow: p.glow }, false);
      return { spec, rows, mat, tints: spec.tints.map((t) => t ?? [1, 1, 1]), wallColour };
    });
  }
  const glass = { mat: facadeMaterial(scene, "glass", paintGlass(scene, "glass", 7), true), tints: [[1, 1, 1], [0.62, 0.66, 0.7]] };
  return { sets, glass };
}

// ---- Small shared pictures ------------------------------------------------------------

// Roof tiles in neutral grey, tinted per material (red clay, slate, zinc).
// One repeat is 2 m of roof.
export function roofTileTexture(scene) {
  const S = 256;
  const t = new DynamicTexture("roofTiles", { width: S, height: S }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const c = t.getContext();
  const rand = mulberry32(77);
  c.fillStyle = "#bdbdbd";
  c.fillRect(0, 0, S, S);
  const rowsN = 8;
  const rh = S / rowsN;
  for (let r = 0; r < rowsN; r++) {
    const cols = 8;
    const cw = S / cols;
    const off = r % 2 ? cw / 2 : 0;
    for (let k = -1; k < cols; k++) {
      const x = k * cw + off;
      const v = 175 + Math.floor(rand() * 50);
      const g = c.createLinearGradient(0, r * rh, 0, (r + 1) * rh);
      g.addColorStop(0, `rgb(${v - 40},${v - 40},${v - 40})`);
      g.addColorStop(0.25, `rgb(${v},${v},${v})`);
      g.addColorStop(1, `rgb(${v - 18},${v - 18},${v - 18})`);
      c.fillStyle = g;
      c.fillRect(x + 1, r * rh + 1, cw - 2, rh - 1);
    }
    c.fillStyle = "rgba(0,0,0,0.45)";
    c.fillRect(0, (r + 1) * rh - 3, S, 3);
  }
  t.update(true);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 4;
  return t;
}

// Bands of the small "details" picture (v ranges, v = 0 at the bottom).
// Railings and lattice are see-through (alpha tested); stripes are awnings.
export const DETAIL = {
  railing: [7 / 8, 1],
  lattice: [6 / 8, 7 / 8],
  stripes: [[5 / 8, 6 / 8], [4 / 8, 5 / 8], [3 / 8, 4 / 8], [2 / 8, 3 / 8]],
  // Hanging-sign pictures along the bottom quarter: cup, book, cross, scissors.
  signs: [0, 1 / 4],
};

export function detailTexture(scene) {
  const S = 256;
  const t = new DynamicTexture("streetDetails", { width: S, height: S }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const c = t.getContext();
  c.clearRect(0, 0, S, S);
  const band = S / 8;
  // Iron railing: top and bottom rails, bars, and a curl between each pair.
  c.fillStyle = "#1d1e20";
  c.fillRect(0, 2, S, 4);
  c.fillRect(0, band - 5, S, 4);
  for (let x = 4; x < S; x += 16) c.fillRect(x, 2, 2.5, band - 4);
  c.strokeStyle = "#1d1e20";
  c.lineWidth = 2;
  for (let x = 12; x < S; x += 16) {
    c.beginPath();
    c.ellipse(x + 1, band / 2, 4.5, 8, 0, 0, Math.PI * 2);
    c.stroke();
  }
  // Wooden lattice (desert balconies).
  const ly = band;
  c.fillStyle = "#5e3d22";
  c.fillRect(0, ly + 2, S, 4);
  c.fillRect(0, ly + band - 6, S, 4);
  c.save();
  c.beginPath();
  c.rect(0, ly, S, band);
  c.clip();
  c.lineWidth = 3;
  c.strokeStyle = "#6b4628";
  for (let x = -band; x < S + band; x += 10) {
    c.beginPath();
    c.moveTo(x, ly);
    c.lineTo(x + band, ly + band);
    c.moveTo(x + band, ly);
    c.lineTo(x, ly + band);
    c.stroke();
  }
  c.restore();
  // Awning stripes: four colourways.
  const stripes = [["#b8322c", "#f2ead8"], ["#2d6a3e", "#f0e9d6"], ["#2b4f86", "#f3efe4"], ["#7a2236", "#7a2236"]];
  stripes.forEach(([s1, s2], i) => {
    const y = band * (2 + i);
    c.fillStyle = s2;
    c.fillRect(0, y, S, band);
    c.fillStyle = s1;
    for (let x = 0; x < S; x += 32) c.fillRect(x, y, 16, band);
    c.fillStyle = "rgba(0,0,0,0.15)";
    c.fillRect(0, y + band - 3, S, 3);
  });
  // Hanging signs: four 64 px pictures on cream boards.
  const sy = band * 6;
  const pics = [
    (x) => {
      c.fillStyle = "#6b3a1e";
      c.fillRect(x + 18, sy + 22, 24, 22);
      c.strokeStyle = "#6b3a1e";
      c.lineWidth = 4;
      c.beginPath();
      c.arc(x + 44, sy + 32, 6, -Math.PI / 2, Math.PI / 2);
      c.stroke();
      c.fillRect(x + 14, sy + 46, 32, 3);
    },
    (x) => {
      c.fillStyle = "#1d3c6b";
      c.fillRect(x + 14, sy + 20, 17, 26);
      c.fillRect(x + 33, sy + 20, 17, 26);
      c.fillStyle = "#f0e6c8";
      for (let k = 0; k < 4; k++) {
        c.fillRect(x + 17, sy + 25 + k * 5, 11, 1.5);
        c.fillRect(x + 36, sy + 25 + k * 5, 11, 1.5);
      }
    },
    (x) => {
      c.fillStyle = "#1f8a3c";
      c.fillRect(x + 26, sy + 16, 12, 34);
      c.fillRect(x + 15, sy + 27, 34, 12);
    },
    (x) => {
      c.strokeStyle = "#2a2a2a";
      c.lineWidth = 4;
      c.beginPath();
      c.arc(x + 22, sy + 42, 6, 0, Math.PI * 2);
      c.arc(x + 42, sy + 42, 6, 0, Math.PI * 2);
      c.moveTo(x + 26, sy + 37);
      c.lineTo(x + 44, sy + 16);
      c.moveTo(x + 38, sy + 37);
      c.lineTo(x + 20, sy + 16);
      c.stroke();
    },
  ];
  pics.forEach((draw, i) => {
    const x = i * 64;
    c.fillStyle = "#3a2a1a";
    c.fillRect(x, sy, 64, 64);
    c.fillStyle = "#efe4c8";
    c.fillRect(x + 5, sy + 5, 54, 54);
    draw(x);
  });
  t.hasAlpha = true;
  t.update(true);
  t.wrapU = Texture.WRAP_ADDRESSMODE;
  t.wrapV = Texture.CLAMP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 4;
  return t;
}

