import { Color3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { SPEED_TRAPS, ROAD_HALF_WIDTH } from "./layout.js";
import { plainMaterial, rgb } from "./materials.js";

// Speed traps: a yellow camera on a pole beside a long straight road, and
// white lines painted across the road where it measures your speed. Spots are
// frozen in layout.js (picked by tools/plan-extras.mjs).
//
// Each trap has its own frame: u runs along the road (its `heading`), w across
// it (to the right of that direction).

const POLE_W = ROAD_HALF_WIDTH + 2.4; // the pole stands this far from the middle of the road
const POLE_H = 4.4;
const LIFT = 0.04; // the road surface sits this far above its heights (road.js)
const PAINT = LIFT + 0.004;

// Works out each trap's frame, road height and pole spot, and keeps trees off
// the pole. Run once the roads exist (before the trees are planted).
export function planSpeedTraps(world) {
  for (const t of SPEED_TRAPS) {
    t.fx = Math.sin(t.heading);
    t.fz = Math.cos(t.heading);
    const { road } = world.network.nearest(t.x, t.z);
    const i = world.network._nearestOn(road, [t.x, t.z]);
    t.road = road;
    t.index = i;
    t.y = road.heights[i];
    // How much the road climbs per metre along `heading` (for the paint).
    const a = road.closed ? (i - 1 + road.count) % road.count : Math.max(0, i - 1);
    const b = road.closed ? (i + 1) % road.count : Math.min(road.count - 1, i + 1);
    const [tx, tz] = road.tangents[i];
    const run = Math.hypot(road.points[b][0] - road.points[a][0], road.points[b][1] - road.points[a][1]) || 1;
    t.slope = ((road.heights[b] - road.heights[a]) / run) * Math.sign(tx * t.fx + tz * t.fz || 1);
    // right of heading = (fz, -fx)
    t.poleX = t.x + t.fz * t.side * POLE_W;
    t.poleZ = t.z - t.fx * t.side * POLE_W;
    t.mapX = t.x;
    t.mapZ = t.z;
  }
  world.clearAreas = (world.clearAreas ?? []).concat(SPEED_TRAPS.map((t) => ({ x: t.poleX, z: t.poleZ, r: 3 })));
  return SPEED_TRAPS;
}

export function buildSpeedTraps(scene, world, colliders, traps) {
  const steel = scene.getMaterialByName("steel");
  const paint = scene.getMaterialByName("paintWhite");
  const housing = plainMaterial(scene, "trapHousing", rgb(0.93, 0.68, 0.06), { roughness: 0.45 });
  const dark = plainMaterial(scene, "trapDark", rgb(0.05, 0.05, 0.055), { roughness: 0.5 });
  // The camera windows: dark glass that flashes white when it catches you.
  const lens = plainMaterial(scene, "trapLens", rgb(0.02, 0.02, 0.025), { roughness: 0.15 });
  lens.emissiveColor = new Color3(0, 0, 0);

  const builders = new Map();
  const g = (mat) => {
    if (!builders.has(mat)) builders.set(mat, new GeometryBuilder());
    return builders.get(mat);
  };
  for (const t of traps) {
    // A point in the trap's frame; `y` above the road there.
    const P = (u, y, w) => [t.x + t.fx * u + t.fz * w, t.y + y, t.z + t.fz * u - t.fx * w];
    const N = (nu, ny, nw) => [t.fx * nu + t.fz * nw, ny, t.fz * nu - t.fx * nw];
    const box = (mat, u0, u1, y0, y1, w0, w1) => {
      const b = g(mat);
      b.addQuad(P(u0, y1, w0), P(u1, y1, w0), P(u1, y1, w1), P(u0, y1, w1), N(0, 1, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u0, y0, w0), P(u1, y0, w0), P(u1, y1, w0), P(u0, y1, w0), N(0, 0, -1), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u0, y0, w1), P(u1, y0, w1), P(u1, y1, w1), P(u0, y1, w1), N(0, 0, 1), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u0, y0, w0), P(u0, y0, w1), P(u0, y1, w1), P(u0, y1, w0), N(-1, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
      b.addQuad(P(u1, y0, w0), P(u1, y0, w1), P(u1, y1, w1), P(u1, y1, w0), N(1, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
    };
    // The pole, from the ground beside the road (which may sit a little
    // above or below the road) up to the camera.
    const pw = t.side * POLE_W;
    const ground = world.getHeight(t.poleX, t.poleZ) - t.y;
    box(steel, -0.09, 0.09, ground - 0.4, POLE_H, pw - 0.09, pw + 0.09);
    colliders.addCircle(t.poleX, t.poleZ, 0.2);
    // The camera: a yellow box lying along the road with a window at each end,
    // so it catches cars both ways. A dark band round its middle.
    box(housing, -0.5, 0.5, POLE_H, POLE_H + 0.62, pw - 0.24, pw + 0.24);
    box(dark, -0.12, 0.12, POLE_H - 0.01, POLE_H + 0.63, pw - 0.25, pw + 0.25);
    for (const end of [-1, 1]) {
      const u = end * 0.505;
      g(lens).addQuad(P(u, POLE_H + 0.18, pw - 0.15), P(u, POLE_H + 0.18, pw + 0.15), P(u, POLE_H + 0.46, pw + 0.15), P(u, POLE_H + 0.46, pw - 0.15), N(end, 0, 0), [0, 0], [1, 0], [1, 1], [0, 1]);
    }
    // Lines across the road: a wide one where it measures, a thin one each side.
    const across = ROAD_HALF_WIDTH - 0.35;
    for (const [u, half] of [[0, 0.22], [-1.6, 0.07], [1.6, 0.07]]) {
      const ya = PAINT + t.slope * (u - half);
      const yb = PAINT + t.slope * (u + half);
      g(paint).addQuad(P(u - half, ya, -across), P(u + half, yb, -across), P(u + half, yb, across), P(u - half, ya, across), N(0, 1, 0), [0, 0], [0, 1], [1, 1], [1, 0]);
    }
  }

  const meshes = [];
  const casters = [];
  for (const [mat, b] of builders) {
    const m = b.toMesh(`speedTraps_${mat.name}`, scene);
    m.material = mat;
    m.receiveShadows = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
    meshes.push(m);
    if (mat !== paint && mat !== lens) casters.push(m);
  }
  return {
    meshes,
    casters,
    // The windows flash for a moment (0 = off, 1 = full).
    flash(k) {
      lens.emissiveColor.set(6 * k, 6 * k, 6 * k);
    },
  };
}
