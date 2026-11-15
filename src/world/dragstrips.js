import { DynamicTexture, PBRMaterial, StandardMaterial, MeshBuilder, Matrix, Quaternion, Vector3, Color3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { smoothstep, lerp, clamp, mulberry32 } from "../noise.js";
import { DRAG_STRIPS, DRAG_STRIP, ROAD_HALF_WIDTH } from "./layout.js";
import { plainMaterial, rgb } from "./materials.js";

// Drag strips: a dead-straight, dead-level run of four lanes with a staging
// box, a quarter mile to race over and a run-off to stop in, between concrete
// barriers. Positions are frozen in layout.js; the strip and its link road
// are roads in the network (style "drag", so traffic keeps off them).
//
// Each strip has its own frame: u runs down the strip from the back of the
// staging box, w across it (to the right, seen driving down it). Lanes are
// numbered 1 to 4 from the left. Heights are above the strip's level.

export const STAGE = DRAG_STRIP.stage; // the start line is this far down the strip
export const FINISH = DRAG_STRIP.stage + DRAG_STRIP.run; // ...and the finish line this far
export const HALF = (DRAG_STRIP.lanes * DRAG_STRIP.lane) / 2; // half the width of the lanes
const APRON = DRAG_STRIP.apron;
const WALL = HALF + 0.35; // inner face of the concrete barriers
const WALL_T = 0.6;
const WALL_H = 0.95;
const LIFT = 0.06; // the surface sits this far above the levelled ground
const PAINT = LIFT + 0.006;
const ENTRY_U = STAGE / 2; // a link road from the side comes in here...
const GAP = 7.5; // ...through a gap this far each side of it in the barrier
const TREE_U = STAGE + 14; // the start lights hang over the lanes here
const POST_W = WALL + WALL_T + 0.6; // gantry posts stand just outside the barriers
const GANTRY_Y = 6.6;
const BLEND_MIN = 15; // metres of ground blended from the strip's level back to nature...
const BLEND_MAX = 60; // ...more where the cut or fill is deep, so the banks aren't too steep
const FLOOD_H = 12;

export const laneW = (lane) => -HALF + DRAG_STRIP.lane * (lane - 0.5);

// Each strip's frame, from the layout alone (the speed limits need it).
for (const s of DRAG_STRIPS) {
  s.fx = Math.sin(s.heading);
  s.fz = Math.cos(s.heading);
  s.side = s.entry === "left" ? -1 : s.entry === "right" ? 1 : 0; // where the link road comes in
  s.stand = s.side ? -s.side : 1; // the grandstand is on the other side
  s.flagSide = -s.stand;
}

// Strip-frame coordinates of a world point, and back.
export function toStrip(s, x, z) {
  const rx = x - s.x;
  const rz = z - s.z;
  return { u: rx * s.fx + rz * s.fz, w: rx * s.fz - rz * s.fx };
}
export function stripPoint(s, u, w) {
  return [s.x + s.fx * u + s.fz * w, s.z + s.fz * u - s.fx * w];
}

function within(s, x, z, u0, u1, halfW) {
  const rx = x - s.x;
  const rz = z - s.z;
  if (Math.abs(rx) > s.length + 40 || Math.abs(rz) > s.length + 40) return false;
  const u = rx * s.fx + rz * s.fz;
  const w = rx * s.fz - rz * s.fx;
  return u >= u0 && u <= u1 && Math.abs(w) <= halfW;
}

// The strip whose lanes (x, z) is on, if any.
export function dragStripAt(x, z) {
  for (const s of DRAG_STRIPS) if (within(s, x, z, -2, s.length + 2, HALF + 1.5)) return s;
  return null;
}

// The strip whose staging box (x, z) is in, if any.
export function stagingAt(x, z) {
  for (const s of DRAG_STRIPS) if (within(s, x, z, 0, STAGE + 1, HALF)) return s;
  return null;
}

// Levels the ground under each strip, keeps trees off it, and works out where
// its flags, lights and signs go. Run once the ground grid exists.
export function planDragStrips(world) {
  for (const s of DRAG_STRIPS) {
    levelGround(world, s);
    // Where the self-driving takes you: near the front of the staging box.
    [s.tx, s.tz] = stripPoint(s, STAGE - 4, 0);
    [s.mapX, s.mapZ] = stripPoint(s, s.length / 2, 0);
    // A row of flags down one side, so the strip shows from far off.
    s.flagSpots = [];
    for (let u = STAGE + 30; u < FINISH; u += 48) s.flagSpots.push(stripPoint(s, u, s.flagSide * (WALL + WALL_T + 2.2)));
    // Four floodlights, two each side, leaning over the lanes.
    s.floods = [
      { u: STAGE + 6, side: s.flagSide },
      { u: STAGE + 150, side: s.stand },
      { u: STAGE + 290, side: s.flagSide },
      { u: FINISH + 25, side: s.stand },
    ];
    s.signs = signSpots(world, s);
  }
  world.clearAreas = (world.clearAreas ?? []).concat(
    DRAG_STRIPS.map((s) => {
      const hu = s.length / 2 + 14;
      const hw = APRON + 4;
      const [x, z] = stripPoint(s, s.length / 2, 0);
      return { x, z, r: Math.hypot(hu, hw), ux: s.fx, uz: s.fz, hu, hw };
    }),
    DRAG_STRIPS.flatMap((s) => s.signs.map((g) => ({ x: g.x, z: g.z, r: 4 }))),
  );
  return DRAG_STRIPS;
}

// Flattens the ground under the strip and its apron to the strip's level,
// easing back to the land around it. Roads nearby (its link road, a public
// road) keep their own level.
function levelGround(world, s) {
  const isl = world.islandById(s.island);
  const { size, cell, minX, minZ, heights, roadDist } = isl;
  const ext = APRON + BLEND_MAX;
  const corners = [[-ext, -ext], [s.length + ext, -ext], [-ext, ext], [s.length + ext, ext]].map(([u, w]) => stripPoint(s, u, w));
  const xs = corners.map((p) => p[0]);
  const zs = corners.map((p) => p[1]);
  const gx0 = Math.max(0, Math.floor((Math.min(...xs) - minX) / cell));
  const gx1 = Math.min(size - 1, Math.ceil((Math.max(...xs) - minX) / cell));
  const gz0 = Math.max(0, Math.floor((Math.min(...zs) - minZ) / cell));
  const gz1 = Math.min(size - 1, Math.ceil((Math.max(...zs) - minZ) / cell));
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = minX + gx * cell;
      const z = minZ + gz * cell;
      const { u, w } = toStrip(s, x, z);
      const out = Math.max(-u - 6, u - s.length - 6, Math.abs(w) - APRON, 0);
      if (out >= BLEND_MAX) continue;
      const i = gz * size + gx;
      // Under the lanes and barriers (and a cell beyond): dead level, whatever
      // else is near. The link road's last few metres are level too (network.js).
      if (u >= -3 && u <= s.length + 3 && Math.abs(w) <= WALL + WALL_T + 2) {
        heights[i] = s.height;
        continue;
      }
      const cur = heights[i];
      const blend = clamp(Math.abs(cur - s.height) * 2.2, BLEND_MIN, BLEND_MAX);
      if (out >= blend) continue;
      let h = lerp(s.height, cur, smoothstep(0, blend, out));
      // Nearer another road than the strip's middle line: leave that road be.
      const toLine = Math.hypot(Math.max(0, -u, u - s.length), w);
      if (roadDist[i] < toLine - 1) h = lerp(cur, h, smoothstep(ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH + 9, roadDist[i]));
      // Nor does a town's ground move (USA south comes near Springfield).
      const town = isl.townWeight(x, z, 25);
      if (town > 0) h = lerp(h, cur, town);
      heights[i] = h;
    }
  }
}

// Signs on the public road, one before the turning each way, on the side the
// link road leaves from, facing the traffic coming up to it.
function signSpots(world, s) {
  const link = s.linkRoad;
  const j = world.network.junctions.find((jj) => jj.road === link && jj.end === 0);
  if (!j) return [];
  const [px, pz] = j.other.points[j.at];
  const [tx, tz] = j.other.tangents[j.at];
  const [lx, lz] = link.points[Math.min(6, link.count - 1)];
  const nSide = (lx - px) * tz - (lz - pz) * tx > 0 ? 1 : -1; // right of +t is (tz, -tx)
  const out = [];
  for (const dir of [1, -1]) {
    const off = ROAD_HALF_WIDTH + 3;
    const x = px + tx * dir * 32 + tz * nSide * off;
    const z = pz + tz * dir * 32 - tx * nSide * off;
    // Not on the link road itself, nor off the land.
    if (link.points.some(([qx, qz]) => Math.hypot(qx - x, qz - z) < 9) || world.getHeight(x, z) < 2) continue;
    // Faces traffic driving towards the turning (travelling -dir * t); the
    // turning is on its right when the link side is right of that direction.
    out.push({ x, z, y: world.getHeight(x, z), fx: tx * dir, fz: tz * dir, right: -dir * nSide > 0 });
  }
  return out;
}

// --- Pictures drawn in code ------------------------------------------------------

const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

// Lane numbers 1 to 4, side by side, white on clear.
function numbersTexture(scene) {
  const t = new DynamicTexture("dragNumbers", { width: 256, height: 64 }, scene, true);
  const c = t.getContext();
  c.clearRect(0, 0, 256, 64);
  c.fillStyle = "#ffffff";
  c.font = `bold 56px ${FONT}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (let k = 0; k < 4; k++) c.fillText(String(k + 1), 32 + k * 64, 34);
  t.hasAlpha = true;
  t.update();
  return t;
}

// Dark streaks of burnt rubber, fading out down the strip.
function rubberTexture(scene) {
  const W = 32;
  const H = 128;
  const t = new DynamicTexture("dragRubber", { width: W, height: H }, scene, true);
  const c = t.getContext();
  const img = c.createImageData(W, H);
  const rand = mulberry32(402);
  const streak = Array.from({ length: W }, () => 0.45 + rand() * 0.55);
  for (let y = 0; y < H; y++) {
    const fade = Math.pow(y / (H - 1), 1.6); // strongest at one end
    for (let x = 0; x < W; x++) {
      const edge = smoothstep(0, 5, x) * smoothstep(0, 5, W - 1 - x);
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 12;
      img.data[o + 3] = Math.round(235 * streak[x] * fade * edge * (0.85 + rand() * 0.15));
    }
  }
  c.putImageData(img, 0, 0);
  t.hasAlpha = true;
  t.update();
  return t;
}

// The road sign: "Drag strip" with an arrow, pointing right (top half) or left.
function signTexture(scene) {
  const t = new DynamicTexture("dragSign", { width: 256, height: 256 }, scene, true);
  const c = t.getContext();
  for (const [y0, right] of [[0, true], [128, false]]) {
    c.fillStyle = "#16305a";
    c.fillRect(0, y0, 256, 128);
    c.strokeStyle = "#ffffff";
    c.lineWidth = 5;
    c.strokeRect(6, y0 + 6, 244, 116);
    // A little chequered flag.
    const fx = right ? 20 : 196;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        c.fillStyle = (i + j) % 2 ? "#16305a" : "#ffffff";
        c.fillRect(fx + i * 10, y0 + 22 + j * 10, 10, 10);
      }
    }
    c.fillStyle = "#ffffff";
    c.font = `bold 34px ${FONT}`;
    c.textAlign = "center";
    c.fillText("DRAG", right ? 128 : 112, y0 + 50);
    c.fillText("STRIP", right ? 128 : 112, y0 + 88);
    // The arrow.
    c.beginPath();
    const ax = right ? 205 : 51;
    const d = right ? 1 : -1;
    c.moveTo(ax - d * 28, y0 + 80);
    c.lineTo(ax + d * 4, y0 + 80);
    c.lineTo(ax + d * 4, y0 + 66);
    c.lineTo(ax + d * 28, y0 + 92);
    c.lineTo(ax + d * 4, y0 + 118 - 0);
    c.lineTo(ax + d * 4, y0 + 104);
    c.lineTo(ax - d * 28, y0 + 104);
    c.closePath();
    c.fill();
  }
  t.update();
  return t;
}

// The timing board over the finish line: the last run's times, and the best.
// One picture shared by every strip; it shows the strip you're nearest.
const BOARD_W = 512;
const BOARD_H = 256;
export function drawBoard(texture, { title, rows, best }) {
  const c = texture.getContext();
  c.fillStyle = "#07090b";
  c.fillRect(0, 0, BOARD_W, BOARD_H);
  c.strokeStyle = "#2b3138";
  c.lineWidth = 6;
  c.strokeRect(3, 3, BOARD_W - 6, BOARD_H - 6);
  c.textBaseline = "middle";
  c.font = `bold 30px ${FONT}`;
  c.fillStyle = "#ffffff";
  c.textAlign = "center";
  c.fillText(title, BOARD_W / 2, 30);
  c.font = `bold 34px ${FONT}`;
  rows.forEach((r, i) => {
    const y = 76 + i * 40;
    c.fillStyle = r.you ? "#ffd23f" : "#ff9a2e";
    c.textAlign = "left";
    c.fillText(String(r.lane), 28, y);
    c.fillText(r.name, 70, y);
    c.textAlign = "right";
    c.fillText(r.time, BOARD_W - 28, y);
  });
  c.font = `bold 30px ${FONT}`;
  c.fillStyle = "#7ee0a5";
  c.textAlign = "center";
  c.fillText(best, BOARD_W / 2, BOARD_H - 24);
  texture.update();
}

// --- Building them ---------------------------------------------------------------

const LAMP = {
  amber: { on: [5, 2.4, 0.2], off: [0.1, 0.05, 0.008] },
  green: { on: [0.25, 4.5, 1.6], off: [0.008, 0.08, 0.04] },
  red: { on: [5, 0.22, 0.12], off: [0.1, 0.012, 0.01] },
};
// Top to bottom on each side of the start lights.
const LAMP_ROWS = ["amber", "amber", "amber", "green", "red"];

export function buildDragStrips(scene, world, colliders, strips) {
  const mats = {
    asphalt: scene.getMaterialByName("asphaltTop").clone("dragAsphalt"),
    paint: scene.getMaterialByName("paintWhite"),
    black: plainMaterial(scene, "dragBlack", rgb(0.02, 0.02, 0.022), { roughness: 0.7 }),
    concrete: scene.getMaterialByName("concrete"),
    steel: scene.getMaterialByName("steel"),
    tyre: plainMaterial(scene, "dragTyres", rgb(0.035, 0.035, 0.038), { roughness: 0.92 }),
    seats: plainMaterial(scene, "dragSeats", rgb(0.08, 0.2, 0.55), { roughness: 0.6 }),
    roof: plainMaterial(scene, "dragRoof", rgb(0.85, 0.86, 0.86), { roughness: 0.5 }),
    dark: plainMaterial(scene, "dragDark", rgb(0.04, 0.045, 0.05), { roughness: 0.5 }),
    floodHead: plainMaterial(scene, "dragFloodHeads", rgb(0.85, 0.85, 0.8), { roughness: 0.3 }),
    numbers: plainMaterial(scene, "dragNumbersMat", rgb(0.82, 0.82, 0.78), { roughness: 0.6 }),
    rubber: plainMaterial(scene, "dragRubberMat", rgb(1, 1, 1), { roughness: 0.75 }),
    sign: plainMaterial(scene, "dragSignMat", rgb(1, 1, 1), { roughness: 0.5 }),
  };
  // The strip is resurfaced darker than the public roads.
  mats.asphalt.albedoColor = rgb(0.55, 0.55, 0.56);
  mats.black.zOffset = -2;
  for (const m of [mats.numbers, mats.rubber]) {
    m.useAlphaFromAlbedoTexture = true;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    m.zOffset = -3;
  }
  mats.numbers.albedoTexture = numbersTexture(scene);
  mats.rubber.albedoTexture = rubberTexture(scene);
  mats.sign.albedoTexture = signTexture(scene);
  mats.sign.emissiveTexture = mats.sign.albedoTexture;
  mats.sign.emissiveColor = new Color3(0.25, 0.25, 0.25);
  // The floodlights glow after dark, with the town windows (nightlights.js).
  mats.floodHead.metadata = { windows: true };
  mats.floodHead.emissiveColor = new Color3(0, 0, 0);
  // The timing board is lit from inside, so it reads by day and by night.
  const boardTexture = new DynamicTexture("dragBoard", { width: BOARD_W, height: BOARD_H }, scene, true);
  const board = new StandardMaterial("dragBoardMat", scene);
  board.disableLighting = true;
  board.diffuseColor = new Color3(0, 0, 0); // (only the picture itself shows)
  board.emissiveTexture = boardTexture;
  drawBoard(boardTexture, { title: "QUARTER MILE · 402 m", rows: [], best: "" });
  mats.board = board;
  // Start lights: unlit, each lamp's own colour (set per lamp) is what you see.
  const lampMat = new StandardMaterial("dragLampMat", scene);
  lampMat.disableLighting = true;
  lampMat.emissiveColor = new Color3(1, 1, 1);
  lampMat.backFaceCulling = false;

  const meshes = [];
  const casters = [];
  const lampSpots = [];
  const keep = (m, mat, cast) => {
    m.material = mat;
    m.receiveShadows = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
    meshes.push(m);
    if (cast) casters.push(m);
    return m;
  };
  const CAST = new Set([mats.concrete, mats.steel, mats.tyre, mats.seats, mats.roof, mats.dark, mats.floodHead]);

  for (const s of strips) {
    const builders = new Map();
    const g = (mat) => {
      if (!builders.has(mat)) builders.set(mat, new GeometryBuilder());
      return builders.get(mat);
    };
    const P = (u, y, w) => {
      const [x, z] = stripPoint(s, u, w);
      return [x, s.height + y, z];
    };
    // A direction given along the strip, up, and across it.
    const N = (nu, ny, nw) => [s.fx * nu + s.fz * nw, ny, s.fz * nu - s.fx * nw];
    // A box in the strip frame.
    const box = (mat, u0, u1, y0, y1, w0, w1, tile = 2) => {
      const b = g(mat);
      const du = (u1 - u0) / tile;
      const dy = (y1 - y0) / tile;
      const dw = (w1 - w0) / tile;
      b.addQuad(P(u0, y1, w0), P(u1, y1, w0), P(u1, y1, w1), P(u0, y1, w1), N(0, 1, 0), [0, 0], [du, 0], [du, dw], [0, dw]);
      b.addQuad(P(u0, y0, w0), P(u1, y0, w0), P(u1, y1, w0), P(u0, y1, w0), N(0, 0, -1), [0, 0], [du, 0], [du, dy], [0, dy]);
      b.addQuad(P(u0, y0, w1), P(u1, y0, w1), P(u1, y1, w1), P(u0, y1, w1), N(0, 0, 1), [0, 0], [du, 0], [du, dy], [0, dy]);
      b.addQuad(P(u0, y0, w0), P(u0, y0, w1), P(u0, y1, w1), P(u0, y1, w0), N(-1, 0, 0), [0, 0], [dw, 0], [dw, dy], [0, dy]);
      b.addQuad(P(u1, y0, w0), P(u1, y0, w1), P(u1, y1, w1), P(u1, y1, w0), N(1, 0, 0), [0, 0], [dw, 0], [dw, dy], [0, dy]);
    };
    // A flat piece lying on the strip; uv corners as [u0w0, u1w0, u1w1, u0w1].
    const flat = (mat, u0, u1, w0, w1, y, uv) => {
      const t = uv ?? [[w0 / 7, u0 / 7], [w0 / 7, u1 / 7], [w1 / 7, u1 / 7], [w1 / 7, u0 / 7]];
      g(mat).addQuad(P(u0, y, w0), P(u1, y, w0), P(u1, y, w1), P(u0, y, w1), N(0, 1, 0), ...t);
    };
    const wallAlong = (side, u0, u1) => {
      const w0 = side * WALL;
      const w1 = side * (WALL + WALL_T);
      box(mats.concrete, u0, u1, -0.3, WALL_H, Math.min(w0, w1), Math.max(w0, w1), 3);
      const [ax, az] = stripPoint(s, u0, w0);
      const [bx, bz] = stripPoint(s, u1, w0);
      colliders.addSegment(ax, az, bx, bz);
    };
    const wallAcross = (u, w0, w1) => {
      box(mats.concrete, u, u + WALL_T, -0.3, WALL_H, w0, w1, 3);
      const [ax, az] = stripPoint(s, u + (u < 1 ? WALL_T : 0), w0);
      const [bx, bz] = stripPoint(s, u + (u < 1 ? WALL_T : 0), w1);
      colliders.addSegment(ax, az, bx, bz);
    };
    const L = s.length;
    const outer = WALL + WALL_T;

    // --- The surface and its paint ---
    for (let u = 0; u < L; u += 20) flat(mats.asphalt, u, Math.min(L, u + 20), -outer, outer, LIFT);
    for (const side of [-1, 1]) flat(mats.paint, 0, L, side * (HALF - 0.3), side * (HALF - 0.15), PAINT, [[0, 0], [0, 1], [1, 1], [1, 0]]);
    for (const w of [-4, 0, 4]) {
      // Solid between the lanes from the back of the staging box to the finish, dashed after.
      flat(mats.paint, 0, FINISH, w - 0.07, w + 0.07, PAINT, [[0, 0], [0, 1], [1, 1], [1, 0]]);
      for (let u = FINISH + 6; u < L - 4; u += 9) flat(mats.paint, u, u + 3, w - 0.07, w + 0.07, PAINT, [[0, 0], [0, 1], [1, 1], [1, 0]]);
    }
    flat(mats.paint, STAGE - 0.4, STAGE, -HALF, HALF, PAINT + 0.001, [[0, 0], [0, 1], [1, 1], [1, 0]]);
    // Chequered band across the finish line.
    const SQ = 0.5;
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < (2 * HALF) / SQ; k++) {
        const u0 = FINISH - 1 + i * SQ;
        const w0 = -HALF + k * SQ;
        flat((i + k) % 2 ? mats.black : mats.paint, u0, u0 + SQ, w0, w0 + SQ, PAINT + 0.001, [[0, 0], [0, 1], [1, 1], [1, 0]]);
      }
    }
    // Lane numbers just behind the start line, reading down the strip.
    for (let lane = 1; lane <= 4; lane++) {
      const w = laneW(lane);
      const a = (lane - 1) / 4;
      const b = lane / 4;
      flat(mats.numbers, STAGE - 10, STAGE - 5, w - 1.25, w + 1.25, PAINT + 0.002, [[a, 0], [a, 1], [b, 1], [b, 0]]);
    }
    // Burnt rubber where the cars set off, two tracks a lane.
    for (let lane = 1; lane <= 4; lane++) {
      for (const t of [-0.8, 0.8]) {
        const w = laneW(lane) + t;
        flat(mats.rubber, STAGE - 3, STAGE + 85, w - 0.17, w + 0.17, PAINT + 0.003, [[0, 0], [0, 1], [1, 1], [1, 0]]);
      }
    }

    // --- Barriers, with a gap where the link road comes in ---
    for (const side of [-1, 1]) {
      if (side === s.side) {
        wallAlong(side, 0, ENTRY_U - GAP);
        wallAlong(side, ENTRY_U + GAP, L);
      } else wallAlong(side, 0, L);
    }
    if (s.side) wallAcross(-WALL_T, -outer, outer);
    else for (const side of [-1, 1]) wallAcross(-WALL_T, side < 0 ? -outer : ROAD_HALF_WIDTH + 0.8, side < 0 ? -(ROAD_HALF_WIDTH + 0.8) : outer);
    wallAcross(L, -outer, outer);
    // A wall of old tyres in front of the far end.
    const tyres = [];
    for (const u of [L - 0.45, L - 1.2]) {
      for (let w = -WALL + 0.37; w < WALL - 0.3; w += 0.74) {
        for (let k = 0; k < 3; k++) {
          const [x, z] = stripPoint(s, u, w);
          tyres.push(Matrix.Translation(x, s.height + LIFT + 0.13 + k * 0.26, z));
        }
      }
    }
    {
      const [ax, az] = stripPoint(s, L - 1.6, -WALL);
      const [bx, bz] = stripPoint(s, L - 1.6, WALL);
      colliders.addSegment(ax, az, bx, bz);
    }
    // (A mesh of its own per strip: clones would share their instance buffers.)
    const tyreMesh = MeshBuilder.CreateCylinder(`dragTyres_${s.id}`, { diameter: 0.72, height: 0.26, tessellation: 12 }, scene);
    const tbuf = new Float32Array(tyres.length * 16);
    tyres.forEach((m, i) => m.copyToArray(tbuf, i * 16));
    tyreMesh.thinInstanceSetBuffer("matrix", tbuf, 16, true);
    tyreMesh.thinInstanceRefreshBoundingInfo(false);
    tyreMesh.material = mats.tyre;
    tyreMesh.receiveShadows = true;
    tyreMesh.isPickable = false;
    tyreMesh.freezeWorldMatrix();
    meshes.push(tyreMesh);
    casters.push(tyreMesh);

    // --- Gantries: the start lights, and the timing board over the finish ---
    const gantry = (u) => {
      for (const side of [-1, 1]) {
        box(mats.steel, u - 0.18, u + 0.18, -0.4, GANTRY_Y + 0.5, side * POST_W - 0.18, side * POST_W + 0.18, 1);
        colliders.addCircle(...stripPoint(s, u, side * POST_W), 0.3);
      }
      box(mats.steel, u - 0.25, u + 0.25, GANTRY_Y, GANTRY_Y + 0.5, -POST_W, POST_W, 1);
    };
    gantry(TREE_U);
    gantry(FINISH);
    // The start lights hang from the middle of their gantry, facing the start line.
    box(mats.dark, TREE_U - 0.15, TREE_U + 0.15, 3.95, GANTRY_Y, -0.58, 0.58, 1);
    const lamps = [];
    for (const [col, w] of [[0, -0.28], [1, 0.28]]) {
      LAMP_ROWS.forEach((_, row) => {
        const [x, z] = stripPoint(s, TREE_U - 0.17, w);
        lamps.push(Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(s.heading, 0, 0), new Vector3(x, s.height + 6.25 - row * 0.5, z)));
      });
    }
    const lampMesh = MeshBuilder.CreateDisc(`dragLamps_${s.id}`, { radius: 0.17, tessellation: 16 }, scene);
    const lbuf = new Float32Array(lamps.length * 16);
    lamps.forEach((m, i) => m.copyToArray(lbuf, i * 16));
    lampMesh.thinInstanceSetBuffer("matrix", lbuf, 16, true);
    s.lampColours = new Float32Array(lamps.length * 4);
    lampMesh.thinInstanceSetBuffer("color", s.lampColours, 4, false);
    lampMesh.thinInstanceRefreshBoundingInfo(false);
    lampMesh.material = lampMat;
    lampMesh.isPickable = false;
    lampMesh.freezeWorldMatrix();
    meshes.push(lampMesh);
    s.lampMesh = lampMesh;
    // The timing board, readable from both sides.
    box(mats.dark, FINISH - 0.2, FINISH + 0.2, GANTRY_Y + 0.5, GANTRY_Y + 3.3, -4.7, 4.7, 1);
    const bw = 4.5;
    const by0 = GANTRY_Y + 0.6;
    const by1 = GANTRY_Y + 3.2;
    g(mats.board).addQuad(P(FINISH - 0.22, by0, -bw), P(FINISH - 0.22, by0, bw), P(FINISH - 0.22, by1, bw), P(FINISH - 0.22, by1, -bw), N(-1, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
    g(mats.board).addQuad(P(FINISH + 0.22, by0, bw), P(FINISH + 0.22, by0, -bw), P(FINISH + 0.22, by1, -bw), P(FINISH + 0.22, by1, bw), N(1, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);

    // --- A small grandstand by the start, away from the link road ---
    {
      const gs = s.stand;
      const u0 = STAGE - 8;
      const u1 = STAGE + 52;
      const w0 = outer + 2.4;
      const STEP_W = 1.15;
      const STEP_H = 0.45;
      const span = (a, b) => [Math.min(gs * a, gs * b), Math.max(gs * a, gs * b)];
      for (let k = 0; k < 5; k++) {
        const a = w0 + k * STEP_W;
        box(mats.concrete, u0, u1, -0.5, STEP_H * (k + 1), ...span(a, a + STEP_W), 3);
        box(mats.seats, u0 + 0.5, u1 - 0.5, STEP_H * (k + 1), STEP_H * (k + 1) + 0.38, ...span(a + 0.15, a + 0.55), 2);
      }
      const back = w0 + 5 * STEP_W;
      box(mats.concrete, u0, u1, -0.5, 4.3, ...span(back, back + 0.3), 3);
      box(mats.roof, u0 - 0.5, u1 + 0.5, 4.3, 4.45, ...span(w0 - 0.6, back + 0.3), 4);
      for (let u = u0 + 1; u <= u1 - 1; u += 14.5) box(mats.steel, u - 0.1, u + 0.1, STEP_H, 4.3, ...span(w0 - 0.4, w0 - 0.2), 1);
      const [cx, cz] = stripPoint(s, (u0 + u1) / 2, gs * (w0 + back + 0.3) / 2);
      colliders.addBox(cx, cz, (back + 0.3 - w0) / 2, (u1 - u0) / 2, s.heading);
    }

    // --- Floodlights, leaning out over the lanes ---
    for (const f of s.floods) {
      const pw = f.side * (outer + 1.2);
      const hw = f.side * (HALF - 2.5);
      box(mats.steel, f.u - 0.16, f.u + 0.16, -0.4, FLOOD_H, pw - 0.16, pw + 0.16, 1);
      box(mats.steel, f.u - 0.1, f.u + 0.1, FLOOD_H - 0.25, FLOOD_H, Math.min(pw, hw), Math.max(pw, hw), 1);
      box(mats.floodHead, f.u - 0.9, f.u + 0.9, FLOOD_H - 0.55, FLOOD_H - 0.2, hw - 0.45, hw + 0.45, 1);
      colliders.addCircle(...stripPoint(s, f.u, pw), 0.3);
      const [x, z] = stripPoint(s, f.u, f.side * (HALF - 3.5));
      lampSpots.push({ x, y: s.height, z, lightHeight: FLOOD_H - 0.6 });
    }

    for (const [mat, b] of builders) keep(b.toMesh(`drag_${s.id}_${mat.name}`, scene), mat, CAST.has(mat));

    // --- Signs on the public road ---
    const sb = new GeometryBuilder();
    const back = new GeometryBuilder();
    for (const sg of s.signs) {
      const rx = sg.fz; // the board's left-to-right, as the drivers see it: right of (-fx, -fz)
      const rz = -sg.fx;
      const half = 1.6;
      const p = (k, h, o = 0) => [sg.x - rx * k * half + sg.fx * o, sg.y + h, sg.z - rz * k * half + sg.fz * o];
      const v0 = sg.right ? 0.5 : 0;
      const v1 = sg.right ? 1 : 0.5;
      sb.addQuad(p(-1, 2.1, 0.06), p(1, 2.1, 0.06), p(1, 3.7, 0.06), p(-1, 3.7, 0.06), [sg.fx, 0, sg.fz], [0, v0], [1, v0], [1, v1], [0, v1]);
      // Its back and two legs.
      const leg = (k) => {
        const [x0, , z0] = p(k * 0.75, 0);
        const e = 0.06;
        for (const [ax, az, bx, bz, nx, nz] of [[-e, -e, e, -e, 0, -1], [e, -e, e, e, 1, 0], [e, e, -e, e, 0, 1], [-e, e, -e, -e, -1, 0]]) {
          back.addQuad([x0 + ax, sg.y - 0.3, z0 + az], [x0 + bx, sg.y - 0.3, z0 + bz], [x0 + bx, sg.y + 3.6, z0 + bz], [x0 + ax, sg.y + 3.6, z0 + az], [nx, 0, nz], [0, 0], [1, 0], [1, 1], [0, 1]);
        }
        colliders.addCircle(x0, z0, 0.12);
      };
      leg(-1);
      leg(1);
      back.addQuad(p(-1, 2.05, 0), p(1, 2.05, 0), p(1, 3.75, 0), p(-1, 3.75, 0), [-sg.fx, 0, -sg.fz], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
    if (sb.vertexCount) {
      keep(sb.toMesh(`dragSign_${s.id}`, scene), mats.sign);
      keep(back.toMesh(`dragSignBack_${s.id}`, scene), mats.steel, true);
    }

    setLamps(s, null, null);
  }

  return { meshes, casters, lampSpots, boardTexture, setLamps };
}

// Lights one strip's start lights. `left` and `right` (lanes 1-2 and 3-4)
// are { amber: 0-3 (which one is lit), green, red }, or null for all off.
export function setLamps(s, left, right) {
  if (!s.lampColours) return;
  [left, right].forEach((side, col) => {
    LAMP_ROWS.forEach((name, row) => {
      const on = !!side && (name === "amber" ? side.amber === row + 1 : side[name]);
      s.lampColours.set([...LAMP[name][on ? "on" : "off"], 1], (col * LAMP_ROWS.length + row) * 4);
    });
  });
  s.lampMesh.thinInstanceBufferUpdated("color");
}
