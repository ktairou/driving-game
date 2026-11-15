import { DynamicTexture, StandardMaterial, Material, Color3, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { STREET_RACES, ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP, LANE_OFFSET } from "./layout.js";
import { plainMaterial, rgb } from "./materials.js";

// Street races: a start gate over the road near a landmark (a gantry with a
// "Street race" banner and a painted start grid behind it), and glowing gates
// along the route that show only while that race is on. Spots are frozen in
// layout.js (picked by tools/plan-extras.mjs).
//
// Each start gate has its own frame: u runs along the road the way the race
// goes (0 at the start line), w across it (to the right of that direction).

const POST_W = ROAD_HALF_WIDTH + 1.3; // gantry posts stand just off the road
const BEAM_Y = 6.2;
const BANNER = [4.85, 5.95]; // bottom and top of the banner
const LIFT = 0.04; // the road surface sits this far above its heights (road.js)
const PAINT = LIFT + 0.005;
// Where everyone lines up (u, and lane: 1 = the side traffic drives on, -1 = the
// other side). You start in the front row on the other side; the three other
// cars on the traffic side and one row further back across from them.
export const GRID = [
  { u: -8, lane: -1, you: true },
  { u: -8, lane: 1 },
  { u: -16, lane: 1 },
  { u: -24, lane: -1 },
];
const AREA = { u0: -42, u1: 5 }; // stop anywhere in here (on the road) for the Race button
const CHECK_W = ROAD_HALF_WIDTH + 1.6; // the glowing gates' posts
const CHECK_H = 5.4;
const MAX_CHECKS = 12;

// A road index `k` samples along from i, wrapped round a loop (or clamped).
const along = (road, i, k) => (road.closed ? (((i + k) % road.count) + road.count) % road.count : Math.min(road.count - 1, Math.max(0, i + k)));

// Works out each gate's frame, grid spots and where its posts go, and keeps
// trees off the posts. Run once the roads exist (before the trees).
export function planStreetRaces(world) {
  for (const r of STREET_RACES) {
    r.fx = Math.sin(r.heading);
    r.fz = Math.cos(r.heading);
    const { road } = world.network.nearest(r.x, r.z);
    const i = world.network._nearestOn(road, [r.x, r.z]);
    const [tx, tz] = road.tangents[i];
    r.road = road;
    r.index = i;
    r.dir = tx * r.fx + tz * r.fz >= 0 ? 1 : -1; // which way along the road the race goes
    r.y = road.heights[i];
    r.country = world.islandById(r.island).def.name;
    r.travel = world.islandById(r.island).def.drive === "left" ? -1 : 1; // the side traffic drives on (w)
    // The grid spots follow the road itself (it may bend a little).
    r.slots = GRID.map((g) => {
      const j = along(road, i, r.dir * Math.round(g.u / ROAD_SAMPLE_STEP));
      const [px, pz] = road.points[j];
      const [ax, az] = road.tangents[j];
      const fx = ax * r.dir;
      const fz = az * r.dir;
      const w = g.lane * r.travel * LANE_OFFSET;
      return { x: px + fz * w, z: pz - fx * w, heading: Math.atan2(fx, fz), you: !!g.you, index: j };
    });
    // Where the self-driving takes you: the middle of the grid.
    [r.tx, r.tz] = point(r, -13, 0);
    r.mapX = r.x;
    r.mapZ = r.z;
    r.posts = [-1, 1].map((s) => point(r, 0, s * POST_W));
  }
  world.clearAreas = (world.clearAreas ?? []).concat(STREET_RACES.flatMap((r) => r.posts.map(([x, z]) => ({ x, z, r: 3 }))));
  return STREET_RACES;
}

function point(r, u, w) {
  return [r.x + r.fx * u + r.fz * w, r.z + r.fz * u - r.fx * w];
}

// The race whose start area (x, z) is in, if any.
export function startAt(x, z) {
  for (const r of STREET_RACES) {
    const rx = x - r.x;
    const rz = z - r.z;
    if (Math.abs(rx) > 60 || Math.abs(rz) > 60) continue;
    const u = rx * r.fx + rz * r.fz;
    const w = rx * r.fz - rz * r.fx;
    if (u >= AREA.u0 && u <= AREA.u1 && Math.abs(w) <= ROAD_HALF_WIDTH + 2) return r;
  }
  return null;
}

// --- Pictures drawn in code ------------------------------------------------------

const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

// Top half "STREET RACE" (the start gates), bottom half "FINISH" (the last
// gate of a race), each with chequered ends.
function bannerTexture(scene) {
  const W = 512;
  const H = 256;
  const t = new DynamicTexture("streetBanner", { width: W, height: H }, scene, true);
  const c = t.getContext();
  for (const [y0, text] of [[0, "STREET RACE"], [128, "FINISH"]]) {
    c.fillStyle = "#101418";
    c.fillRect(0, y0, W, 128);
    const q = 16;
    for (const x0 of [0, W - 4 * q]) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 8; j++) {
          c.fillStyle = (i + j) % 2 ? "#101418" : "#f4f4f0";
          c.fillRect(x0 + i * q, y0 + j * q, q, q);
        }
      }
    }
    c.fillStyle = "#ffffff";
    c.font = `bold 62px ${FONT}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, W / 2, y0 + 68);
  }
  t.update();
  return t;
}

// --- Building them ---------------------------------------------------------------

export function buildStreetRaces(scene, world, colliders, races) {
  const steel = scene.getMaterialByName("steel");
  const paint = scene.getMaterialByName("paintWhite");
  const dark = plainMaterial(scene, "streetDark", rgb(0.05, 0.055, 0.06), { roughness: 0.5 });
  const banner = plainMaterial(scene, "streetBannerMat", rgb(1, 1, 1), { roughness: 0.5 });
  banner.albedoTexture = bannerTexture(scene);
  // A little light of its own, so it reads in the shade and after dark.
  banner.emissiveTexture = banner.albedoTexture;
  banner.emissiveColor = new Color3(0.35, 0.35, 0.35);

  const builders = new Map();
  const g = (mat) => {
    if (!builders.has(mat)) builders.set(mat, new GeometryBuilder());
    return builders.get(mat);
  };
  for (const r of races) {
    const P = (u, y, w) => {
      const [x, z] = point(r, u, w);
      return [x, r.y + y, z];
    };
    const N = (nu, ny, nw) => [r.fx * nu + r.fz * nw, ny, r.fz * nu - r.fx * nw];
    const box = (mat, u0, u1, y0, y1, w0, w1) => {
      const b = g(mat);
      b.addQuad(P(u0, y1, w0), P(u1, y1, w0), P(u1, y1, w1), P(u0, y1, w1), N(0, 1, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u0, y0, w0), P(u1, y0, w0), P(u1, y1, w0), P(u0, y1, w0), N(0, 0, -1), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u0, y0, w1), P(u1, y0, w1), P(u1, y1, w1), P(u0, y1, w1), N(0, 0, 1), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u0, y0, w0), P(u0, y0, w1), P(u0, y1, w1), P(u0, y1, w0), N(-1, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u1, y0, w0), P(u1, y0, w1), P(u1, y1, w1), P(u1, y1, w0), N(1, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
    };
    // The gantry: a post each side (from the ground there) and a beam across.
    for (const [k, [x, z]] of r.posts.entries()) {
      const w = (k ? 1 : -1) * POST_W;
      const ground = world.getHeight(x, z) - r.y;
      box(steel, -0.16, 0.16, ground - 0.4, BEAM_Y + 0.35, w - 0.16, w + 0.16);
      colliders.addCircle(x, z, 0.3);
    }
    box(steel, -0.2, 0.2, BEAM_Y, BEAM_Y + 0.35, -POST_W - 0.16, POST_W + 0.16);
    // The banner hangs under the beam, readable from both sides (the picture
    // starts at the left end as each side sees it).
    const bw = 4.7;
    box(dark, -0.06, 0.06, BANNER[0] - 0.05, BEAM_Y, -bw - 0.05, bw + 0.05);
    g(banner).addQuad(P(-0.07, BANNER[0], -bw), P(-0.07, BANNER[0], bw), P(-0.07, BANNER[1], bw), P(-0.07, BANNER[1], -bw), N(-1, 0, 0), [0, 0.5], [1, 0.5], [1, 1], [0, 1]);
    g(banner).addQuad(P(0.07, BANNER[0], bw), P(0.07, BANNER[0], -bw), P(0.07, BANNER[1], -bw), P(0.07, BANNER[1], bw), N(1, 0, 0), [0, 0.5], [1, 0.5], [1, 1], [0, 1]);
    // Paint: a chequered start line, and a bar across the front of each grid spot.
    const across = ROAD_HALF_WIDTH - 0.35;
    const SQ = 0.5;
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < Math.floor((2 * across) / SQ); k++) {
        if ((row + k) % 2) continue;
        const u0 = -row * SQ;
        const w0 = -across + k * SQ;
        g(paint).addQuad(P(u0 - SQ, PAINT, w0), P(u0, PAINT, w0), P(u0, PAINT, w0 + SQ), P(u0 - SQ, PAINT, w0 + SQ), N(0, 1, 0), [0, 0], [0, 1], [1, 1], [1, 0]);
      }
    }
    for (const s of GRID) {
      const w = s.lane * r.travel * LANE_OFFSET;
      const u = s.u + 2.6; // just in front of the car's nose
      g(paint).addQuad(P(u - 0.15, PAINT, w - 1.3), P(u + 0.15, PAINT, w - 1.3), P(u + 0.15, PAINT, w + 1.3), P(u - 0.15, PAINT, w + 1.3), N(0, 1, 0), [0, 0], [0, 1], [1, 1], [1, 0]);
    }
  }

  const meshes = [];
  const casters = [];
  for (const [mat, b] of builders) {
    const m = b.toMesh(`streetGates_${mat.name}`, scene);
    m.material = mat;
    m.receiveShadows = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
    meshes.push(m);
    if (mat === steel || mat === dark) casters.push(m);
  }

  // --- The glowing gates along a race's route ---
  // One gate shape, drawn once per gate (thin instances), each in its own
  // colour: the next one bright, the later ones dim; the finish white.
  const shape = new GeometryBuilder();
  {
    const box = (x0, x1, y0, y1, z0, z1) => {
      const P = (x, y, z) => [x, y, z];
      shape.addQuad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      shape.addQuad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      shape.addQuad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);
      shape.addQuad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
      shape.addQuad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), [-1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      shape.addQuad(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), [1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    };
    // (Across the road is x here, along it z: the instance turns it to face the route.)
    for (const s of [-1, 1]) box(s * CHECK_W - 0.18, s * CHECK_W + 0.18, -0.4, CHECK_H, -0.18, 0.18);
    box(-CHECK_W - 0.18, CHECK_W + 0.18, CHECK_H - 0.36, CHECK_H, -0.18, 0.18);
  }
  const gates = shape.toMesh("streetCheckpoints", scene);
  const glow = new StandardMaterial("streetCheckpointMat", scene);
  glow.disableLighting = true;
  glow.emissiveColor = new Color3(1, 1, 1); // each gate's own colour is what you see
  glow.fogEnabled = false; // the next gate shows up from far off, haze or not
  gates.material = glow;
  gates.isPickable = false;
  const matrices = new Float32Array(MAX_CHECKS * 16);
  const colours = new Float32Array(MAX_CHECKS * 4);
  gates.thinInstanceSetBuffer("matrix", matrices, 16, false);
  gates.thinInstanceSetBuffer("color", colours, 4, false);
  gates.thinInstanceCount = 0;
  // (Only ever a dozen: always drawn, rather than kept up to date for culling.)
  gates.alwaysSelectAsActiveMesh = true;
  gates.setEnabled(false);
  // "FINISH" under the last gate's beam (the bottom half of the banner picture).
  const finish = new GeometryBuilder();
  const fw = 4.2;
  const fy = [CHECK_H - 1.5, CHECK_H - 0.4];
  // (Local x is across the road to the right, z along it the way the race goes.)
  finish.addQuad([-fw, fy[0], -0.03], [fw, fy[0], -0.03], [fw, fy[1], -0.03], [-fw, fy[1], -0.03], [0, 0, -1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]);
  finish.addQuad([fw, fy[0], 0.03], [-fw, fy[0], 0.03], [-fw, fy[1], 0.03], [fw, fy[1], 0.03], [0, 0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]);
  const finishMat = new StandardMaterial("streetFinishMat", scene);
  finishMat.disableLighting = true;
  finishMat.emissiveTexture = banner.albedoTexture;
  finishMat.diffuseColor = new Color3(0, 0, 0);
  finishMat.fogEnabled = false;
  const finishBanner = finish.toMesh("streetFinish", scene);
  finishBanner.material = finishMat;
  finishBanner.isPickable = false;
  finishBanner.rotationQuaternion = new Quaternion();
  finishBanner.setEnabled(false);

  const COLOUR = {
    next: [2.5, 1.05, 0.07],
    later: [0.42, 0.18, 0.02],
    finishNext: [2.4, 2.6, 2.6],
    finishLater: [0.45, 0.48, 0.5],
  };
  const q = new Quaternion();
  const one = Vector3.One();
  const pos = new Vector3();
  const m = new Matrix();
  return {
    meshes,
    casters,
    // Shows a race's gates from `next` on: list = [{ x, y, z, yaw }], the
    // last one being the finish. (Only when a gate is passed, not every frame.)
    showCheckpoints(list, next) {
      let n = 0;
      for (let i = next; i < list.length && n < MAX_CHECKS; i++, n++) {
        const c = list[i];
        Quaternion.RotationYawPitchRollToRef(c.yaw, 0, 0, q);
        pos.set(c.x, c.y, c.z);
        Matrix.ComposeToRef(one, q, pos, m);
        m.copyToArray(matrices, n * 16);
        const last = i === list.length - 1;
        const col = last ? (i === next ? COLOUR.finishNext : COLOUR.finishLater) : i === next ? COLOUR.next : COLOUR.later;
        colours[n * 4] = col[0];
        colours[n * 4 + 1] = col[1];
        colours[n * 4 + 2] = col[2];
        colours[n * 4 + 3] = 1;
      }
      gates.thinInstanceCount = n;
      gates.thinInstanceBufferUpdated("matrix");
      gates.thinInstanceBufferUpdated("color");
      // (The shader only takes each gate's colour if it's set up while there
      // are gates to draw; the first time, there weren't.)
      glow.markAsDirty(Material.AttributesDirtyFlag);
      gates.setEnabled(n > 0);
      const f = list[list.length - 1];
      finishBanner.position.set(f.x, f.y, f.z);
      Quaternion.RotationYawPitchRollToRef(f.yaw, 0, 0, finishBanner.rotationQuaternion);
      finishBanner.setEnabled(n > 0);
    },
    hideCheckpoints() {
      gates.thinInstanceCount = 0;
      gates.setEnabled(false);
      finishBanner.setEnabled(false);
    },
  };
}
