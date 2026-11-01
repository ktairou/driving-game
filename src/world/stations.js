import { DynamicTexture, PBRMaterial, Texture, Color3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { smoothstep, lerp } from "../noise.js";
import { inTown } from "./road.js";
import { ISLANDS, ROAD_HALF_WIDTH } from "./layout.js";
import { plainMaterial, rgb } from "./materials.js";

// Fuel stations: a forecourt beside the road with a canopy over an island of
// petrol pumps and electric chargers, a lane each side of it, a small shop and
// a tall sign. They're planned as soon as the roads exist, before the ground
// is built, so the ground under each one can be levelled.
//
// Each station has its own frame: u runs along the road, w away from it (the
// forecourt is at w > 0), heights are above the road there.

const EDGE = ROAD_HALF_WIDTH + 0.3; // the forecourt starts at the road edge
const PAD_U = 16; // half its length along the road
const PAD_W = 22; // how far it reaches back from the road edge
export const LANE_A = ROAD_HALF_WIDTH + 5;
const ISLAND = ROAD_HALF_WIDTH + 8;
const LANE_B = ROAD_HALF_WIDTH + 11;
const CANOPY_Y = 5.2;
// Along the island: pump, charger, pump, charger.
const DEVICES = [
  { u: -5.6, type: "petrol" },
  { u: -2, type: "electric" },
  { u: 2, type: "petrol" },
  { u: 5.6, type: "electric" },
];
const SPOT_U = [-3.8, 3.8];
const BLEND = 12; // metres of ground blended from the forecourt level back to nature

// Picks where the stations go (one per country near its town, plus two out
// on country roads) and levels the ground under them.
export function planStations(world) {
  const net = world.network;
  const cands = [];
  for (const road of net.roads) {
    const isl = world.islandById(road.island);
    if (!isl || road.style) continue;
    const def = isl.def;
    const side = def.drive === "left" ? -1 : 1;
    const n = road.count;
    const at = (i) => (road.closed ? ((i % n) + n) % n : i);
    for (let i = 16; i < n - 16; i += 5) {
      let bridge = false;
      for (let k = -14; k <= 14; k++) bridge ||= road.bridge[at(i + k)];
      if (bridge) continue;
      const [ox, oz] = road.points[i];
      if (inTown(ox, oz, 50) || net.isNearMeeting(ox, oz, 55)) continue;
      const y = road.heights[i];
      if (Math.abs(road.heights[at(i + 9)] - road.heights[at(i - 9)]) > 0.6) continue;
      const [tx, tz] = road.tangents[i];
      const [ax, az] = road.tangents[at(i - 9)];
      const [bx, bz] = road.tangents[at(i + 9)];
      if (ax * bx + az * bz < 0.975 || ax * tx + az * tz < 0.985) continue; // fairly straight
      const nx = side * tz;
      const nz = -side * tx;
      let ok = true;
      let rough = 0;
      for (let u = -PAD_U - 6; u <= PAD_U + 6 && ok; u += 4) {
        for (let w = EDGE + 2; w <= EDGE + PAD_W + 8; w += 4) {
          const x = ox + tx * u + nx * w;
          const z = oz + tz * u + nz * w;
          const base = isl.contains(x, z) ? isl.baseHeight(x, z) : -10;
          // Not in the sea, not on top of a town, landmark or another road.
          if (base < 2.5 || inTown(x, z, 10) || world.getRoadDistance(x, z) < w - 2) ok = false;
          else if (def.landmarks.some((lm) => Math.hypot(x - lm.x, z - lm.z) < (lm.base ?? 30) / 2 + 25)) ok = false;
          rough = Math.max(rough, Math.abs(base - y));
          if (!ok) break;
        }
      }
      if (!ok || rough > 4) continue;
      const t = def.town;
      cands.push({ road, index: i, island: def, side, ox, oz, tx, tz, nx, nz, y, rough, toTown: Math.hypot(ox - t.cx, oz - t.cz) });
    }
  }

  // One per country, a little way out of its town...
  const chosen = [];
  for (const def of ISLANDS) {
    const mine = cands.filter((c) => c.island === def);
    mine.sort((a, b) => Math.abs(a.toTown - 380) / 120 + a.rough - (Math.abs(b.toTown - 380) / 120 + b.rough));
    if (mine.length) chosen.push({ ...mine[0], name: `Fuel station · ${def.name}` });
  }
  // ...then two more out in the country, as far from the others as possible.
  for (let k = 0; k < 2; k++) {
    let best = null;
    let bestD = 450;
    for (const c of cands) {
      const d = Math.min(...chosen.map((s) => Math.hypot(s.ox - c.ox, s.oz - c.oz)));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) chosen.push({ ...best, name: `Fuel station · ${best.island.name} countryside` });
  }

  const stations = chosen.map((c, id) => {
    const s = { ...c, id };
    s.at = (u, w) => [s.ox + s.tx * u + s.nx * w, s.oz + s.tz * u + s.nz * w];
    [s.x, s.z] = s.at(0, EDGE + PAD_W / 2);
    s.spots = [];
    for (const w of [LANE_A, LANE_B]) for (const u of SPOT_U) s.spots.push({ u, w });
    s.devices = DEVICES.map((d) => {
      const [x, z] = s.at(d.u, ISLAND);
      return { ...d, x, z };
    });
    return s;
  });
  for (const s of stations) levelGround(world, s);
  world.clearAreas = (world.clearAreas ?? []).concat(stations.map((s) => ({ x: s.x, z: s.z, r: Math.hypot(PAD_U, PAD_W) + 8 })));
  return stations;
}

// Station-frame coordinates of a world point.
export function toStation(s, x, z) {
  const rx = x - s.ox;
  const rz = z - s.oz;
  return { u: rx * s.tx + rz * s.tz, w: rx * s.nx + rz * s.nz };
}

// Flattens the ground under the forecourt to the road's height, easing back
// to the natural ground around it. The road itself is left alone.
function levelGround(world, s) {
  const isl = world.islandById(s.island.id);
  const { size, cell, minX, minZ, heights } = isl;
  const reach = Math.hypot(PAD_U + BLEND, EDGE + PAD_W + BLEND) + cell;
  const gx0 = Math.max(0, Math.floor((s.x - reach - minX) / cell));
  const gx1 = Math.min(size - 1, Math.ceil((s.x + reach - minX) / cell));
  const gz0 = Math.max(0, Math.floor((s.z - reach - minZ) / cell));
  const gz1 = Math.min(size - 1, Math.ceil((s.z + reach - minZ) / cell));
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const { u, w } = toStation(s, minX + gx * cell, minZ + gz * cell);
      if (w < EDGE + 0.4) continue;
      const out = Math.max(Math.abs(u) - PAD_U - 1, w - (EDGE + PAD_W + 1), 0);
      if (out > BLEND) continue;
      const i = gz * size + gx;
      heights[i] = lerp(s.y, heights[i], smoothstep(0, BLEND, out));
    }
  }
}

// --- Building them -------------------------------------------------------------

function boardTexture(scene) {
  const t = new DynamicTexture("stationSign", { width: 256, height: 384 }, scene, true);
  const c = t.getContext();
  c.fillStyle = "#0d5f63";
  c.fillRect(0, 0, 256, 384);
  c.fillStyle = "#f4f6f6";
  c.fillRect(10, 10, 236, 364);
  c.fillStyle = "#0d5f63";
  c.fillRect(18, 18, 220, 348);
  // A petrol pump...
  c.fillStyle = "#ffffff";
  c.fillRect(88, 42, 56, 84);
  c.fillStyle = "#0d5f63";
  c.fillRect(98, 54, 36, 24);
  c.strokeStyle = "#ffffff";
  c.lineWidth = 7;
  c.beginPath();
  c.moveTo(144, 60);
  c.lineTo(166, 72);
  c.lineTo(166, 112);
  c.stroke();
  c.fillStyle = "#ffffff";
  c.font = "bold 46px Segoe UI, Helvetica, Arial, sans-serif";
  c.textAlign = "center";
  c.fillText("FUEL", 128, 178);
  // ...and a lightning bolt for charging.
  c.fillStyle = "#ffd23f";
  c.beginPath();
  c.moveTo(138, 208);
  c.lineTo(100, 270);
  c.lineTo(126, 270);
  c.lineTo(114, 318);
  c.lineTo(158, 248);
  c.lineTo(132, 248);
  c.closePath();
  c.fill();
  c.fillStyle = "#ffffff";
  c.font = "bold 38px Segoe UI, Helvetica, Arial, sans-serif";
  c.fillText("CHARGE", 128, 360);
  t.update();
  return t;
}

function concreteTexture(scene) {
  const size = 256;
  const t = new DynamicTexture("forecourt", { width: size, height: size }, scene, true);
  const c = t.getContext();
  const img = c.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 150 + Math.random() * 22;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v - 4;
    img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  // Joints between the concrete slabs.
  c.strokeStyle = "rgba(60,60,58,0.55)";
  c.lineWidth = 2;
  c.strokeRect(1, 1, size - 2, size - 2);
  t.update();
  t.wrapU = Texture.WRAP_ADDRESSMODE;
  t.wrapV = Texture.WRAP_ADDRESSMODE;
  return t;
}

export function buildStations(scene, world, colliders, stations) {
  const mats = {
    pad: plainMaterial(scene, "forecourtMat", rgb(1, 1, 1), { roughness: 0.92 }),
    kerb: plainMaterial(scene, "stationKerb", rgb(0.62, 0.62, 0.6), { roughness: 0.85 }),
    white: plainMaterial(scene, "canopyWhite", rgb(0.86, 0.87, 0.86), { roughness: 0.55 }),
    teal: plainMaterial(scene, "stationTeal", rgb(0.02, 0.32, 0.34), { roughness: 0.45 }),
    metal: plainMaterial(scene, "pumpMetal", rgb(0.13, 0.14, 0.15), { metallic: 0.4, roughness: 0.45 }),
    wall: plainMaterial(scene, "shopWall", rgb(0.78, 0.74, 0.66), { roughness: 0.85 }),
    glass: plainMaterial(scene, "shopGlass", rgb(0.08, 0.1, 0.12), { metallic: 0.2, roughness: 0.12 }),
    glow: plainMaterial(scene, "canopyLights", rgb(0.9, 0.9, 0.88), { roughness: 0.4 }),
    screen: plainMaterial(scene, "pumpScreens", rgb(0.05, 0.06, 0.06), { roughness: 0.3 }),
    sign: plainMaterial(scene, "stationSignMat", rgb(1, 1, 1), { roughness: 0.5 }),
    line: plainMaterial(scene, "forecourtLines", rgb(0.9, 0.9, 0.86), { roughness: 0.8 }),
  };
  mats.pad.albedoTexture = concreteTexture(scene);
  mats.sign.albedoTexture = boardTexture(scene);
  mats.sign.emissiveTexture = mats.sign.albedoTexture;
  mats.sign.emissiveColor = new Color3(0.25, 0.25, 0.25);
  mats.screen.emissiveColor = new Color3(0.1, 0.45, 0.4);
  // These light up at night along with the town windows (nightlights.js).
  mats.glass.metadata = { windows: true };
  mats.glow.metadata = { windows: true };
  mats.glass.emissiveColor = new Color3(0, 0, 0);
  mats.glow.emissiveColor = new Color3(0, 0, 0);

  const builders = new Map();
  const g = (mat) => {
    if (!builders.has(mat)) builders.set(mat, new GeometryBuilder());
    return builders.get(mat);
  };

  for (const s of stations) {
    const P = (u, y, w) => {
      const [x, z] = s.at(u, w);
      return [x, s.y + y, z];
    };
    const N = (nu, ny, nw) => [s.tx * nu + s.nx * nw, ny, s.tz * nu + s.nz * nw];
    // A box in the station frame.
    const box = (mat, u0, u1, y0, y1, w0, w1, tile = 2) => {
      const b = g(mat);
      const du = (u1 - u0) / tile;
      const dy = (y1 - y0) / tile;
      const dw = (w1 - w0) / tile;
      b.addQuad(P(u0, y1, w0), P(u1, y1, w0), P(u1, y1, w1), P(u0, y1, w1), N(0, 1, 0), [0, 0], [du, 0], [du, dw], [0, dw]);
      b.addQuad(P(u0, y0, w0), P(u1, y0, w0), P(u1, y0, w1), P(u0, y0, w1), N(0, -1, 0), [0, 0], [du, 0], [du, dw], [0, dw]);
      b.addQuad(P(u0, y0, w0), P(u1, y0, w0), P(u1, y1, w0), P(u0, y1, w0), N(0, 0, -1), [0, 0], [du, 0], [du, dy], [0, dy]);
      b.addQuad(P(u0, y0, w1), P(u1, y0, w1), P(u1, y1, w1), P(u0, y1, w1), N(0, 0, 1), [0, 0], [du, 0], [du, dy], [0, dy]);
      b.addQuad(P(u0, y0, w0), P(u0, y0, w1), P(u0, y1, w1), P(u0, y1, w0), N(-1, 0, 0), [0, 0], [dw, 0], [dw, dy], [0, dy]);
      b.addQuad(P(u1, y0, w0), P(u1, y0, w1), P(u1, y1, w1), P(u1, y1, w0), N(1, 0, 0), [0, 0], [dw, 0], [dw, dy], [0, dy]);
    };
    const flat = (mat, u0, u1, w0, w1, y, tile = 4) => {
      g(mat).addQuad(P(u0, y, w0), P(u1, y, w0), P(u1, y, w1), P(u0, y, w1), N(0, 1, 0), [u0 / tile, w0 / tile], [u1 / tile, w0 / tile], [u1 / tile, w1 / tile], [u0 / tile, w1 / tile]);
    };

    // Forecourt, with a painted box at each place to stop.
    flat(mats.pad, -PAD_U, PAD_U, EDGE, EDGE + PAD_W, 0.03);
    for (const sp of s.spots) {
      for (const [a, b] of [[-2.6, -2.48], [2.48, 2.6]]) flat(mats.line, sp.u + a, sp.u + b, sp.w - 1.5, sp.w + 1.5, 0.045, 1);
    }
    // The island the pumps stand on.
    box(mats.kerb, -8.6, 8.6, 0, 0.16, ISLAND - 0.8, ISLAND + 0.8);
    colliders.addBox(...s.at(0, ISLAND), 0.8, 8.6, Math.atan2(s.tx, s.tz));
    // Canopy: roof, a coloured band round the edge, two pillars, lights underneath.
    box(mats.white, -11, 11, CANOPY_Y, CANOPY_Y + 0.5, ISLAND - 6.5, ISLAND + 6.5);
    box(mats.teal, -11.05, 11.05, CANOPY_Y + 0.08, CANOPY_Y + 0.42, ISLAND - 6.55, ISLAND + 6.55, 1);
    for (const u of [-8.2, 8.2]) {
      box(mats.white, u - 0.22, u + 0.22, 0.16, CANOPY_Y, ISLAND - 0.22, ISLAND + 0.22);
      colliders.addCircle(...s.at(u, ISLAND), 0.32);
    }
    for (const w of [ISLAND - 3.2, ISLAND + 3.2]) box(mats.glow, -9, 9, CANOPY_Y - 0.04, CANOPY_Y, w - 0.35, w + 0.35, 1);
    // Pumps and chargers.
    for (const d of DEVICES) {
      if (d.type === "petrol") {
        box(mats.metal, d.u - 0.4, d.u + 0.4, 0.16, 1.85, ISLAND - 0.28, ISLAND + 0.28);
        box(mats.teal, d.u - 0.42, d.u + 0.42, 1.85, 2.1, ISLAND - 0.3, ISLAND + 0.3, 1);
        // Screens and nozzle holders on both lane sides.
        for (const sgn of [-1, 1]) {
          box(mats.screen, d.u - 0.22, d.u + 0.22, 1.25, 1.6, ISLAND + sgn * 0.28, ISLAND + sgn * 0.3, 1);
          box(mats.metal, d.u + 0.18, d.u + 0.32, 0.8, 1.15, ISLAND + sgn * 0.28, ISLAND + sgn * 0.4, 1);
        }
      } else {
        box(mats.white, d.u - 0.26, d.u + 0.26, 0.16, 1.75, ISLAND - 0.2, ISLAND + 0.2);
        box(mats.teal, d.u - 0.28, d.u + 0.28, 1.75, 1.85, ISLAND - 0.22, ISLAND + 0.22, 1);
        for (const sgn of [-1, 1]) box(mats.screen, d.u - 0.16, d.u + 0.16, 1.2, 1.5, ISLAND + sgn * 0.2, ISLAND + sgn * 0.22, 1);
      }
      colliders.addCircle(d.x, d.z, 0.45);
    }
    // The shop at the back.
    const shopW0 = EDGE + PAD_W - 6;
    const shopW1 = EDGE + PAD_W - 0.5;
    box(mats.wall, -14.5, -2.5, 0, 3.8, shopW0, shopW1);
    box(mats.teal, -14.6, -2.4, 3.8, 4.25, shopW0 - 0.1, shopW1 + 0.1, 1);
    box(mats.glass, -13.5, -3.5, 0.2, 2.9, shopW0 - 0.04, shopW0, 1);
    colliders.addBox(...s.at(-8.5, (shopW0 + shopW1) / 2), (shopW1 - shopW0) / 2, 6, Math.atan2(s.tx, s.tz));
    // A tall sign by the road you can see from a distance (just past the
    // end of the forecourt, clear of the way in).
    const SU = PAD_U + 3;
    const SW = EDGE + 3;
    box(mats.metal, SU - 0.2, SU + 0.2, -0.5, 4.4, SW - 0.2, SW + 0.2);
    box(mats.metal, SU - 1.1, SU + 1.1, 4.3, 7.6, SW - 0.18, SW + 0.18);
    const sign = g(mats.sign);
    for (const [w, nw] of [[SW - 0.2, -1], [SW + 0.2, 1]]) {
      // Flip the picture where needed so it never reads backwards.
      const m = nw * s.side < 0;
      sign.addQuad(P(SU - 1, 4.4, w), P(SU + 1, 4.4, w), P(SU + 1, 7.5, w), P(SU - 1, 7.5, w), N(0, 0, nw), m ? [1, 0] : [0, 0], m ? [0, 0] : [1, 0], m ? [0, 1] : [1, 1], m ? [1, 1] : [0, 1]);
    }
    colliders.addCircle(...s.at(SU, SW), 0.3);
  }

  const meshes = [];
  for (const [mat, b] of builders) {
    const m = b.toMesh(`stations_${mat.name}`, scene);
    m.material = mat;
    m.receiveShadows = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
    meshes.push(m);
  }
  // Night lighting: the nearest-lamp lights (nightlights.js) treat each
  // canopy like a street lamp, just lower down.
  const lampSpots = stations.map((s) => {
    const [x, z] = s.at(0, ISLAND);
    return { x, y: s.y, z, lightHeight: CANOPY_Y - 0.4 };
  });
  const casters = meshes.filter((m) => m.material !== mats.pad && m.material !== mats.line);
  return { meshes, casters, lampSpots };
}

// Extends a route that ends on the road beside a station so it turns into the
// forecourt and stops at the first pump in the near lane. (The self-driver
// keeps to its lane, 1.9 m to one side of the route, so allow for that.)
export function stationApproach(points, s) {
  const n = points.length;
  const a = points[Math.max(0, n - 6)];
  const b = points[n - 1];
  const dir = (b.x - a.x) * s.tx + (b.z - a.z) * s.tz >= 0 ? 1 : -1;
  let keep = n;
  while (keep > 2 && toStation(s, points[keep - 1].x, points[keep - 1].z).u * dir > -PAD_U - 8) keep--;
  const out = points.slice(0, keep);
  const laneW = LANE_A - 1.9 * dir;
  // Route points are 2 m apart (the self-driver counts on it), so fill in.
  const add = (u, w) => {
    const [x, z] = s.at(u * dir, w);
    const prev = out[out.length - 1];
    const steps = Math.max(1, Math.round(Math.hypot(x - prev.x, z - prev.z) / 2));
    for (let k = 1; k <= steps; k++) out.push({ x: prev.x + ((x - prev.x) * k) / steps, z: prev.z + ((z - prev.z) * k) / steps, y: s.y });
  };
  const stopU = SPOT_U[0];
  add(-PAD_U - 6, 0);
  add(-PAD_U + 4, laneW);
  add(stopU - 3, laneW);
  add(stopU + 6, laneW);
  return out;
}
