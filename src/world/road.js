import { GeometryBuilder, normalize, cross } from "../geom.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP, TOWN, MAIN_STREET } from "./layout.js";

const LIFT = 0.04; // road surface sits this far above the height grid
const ASPHALT_TILE = 7; // metres per asphalt texture repeat

export function inTown(x, z, margin = 0) {
  return Math.abs(x - TOWN.cx) < TOWN.hx + margin && Math.abs(z - TOWN.cz) < TOWN.hz + margin;
}

const onMainStreet = (x, z) => x > MAIN_STREET.x0 && x < MAIN_STREET.x1 && Math.abs(z) < 15;

// Per-sample frame: centre point, right vector and surface normal.
function frames(hf) {
  const { points, heights, tangents, count } = hf.road;
  const out = [];
  for (let i = 0; i < count; i++) {
    const [x, z] = points[i];
    const [tx, tz] = tangents[i];
    const prev = (i - 1 + count) % count;
    const next = (i + 1) % count;
    const slope = (heights[next] - heights[prev]) / (2 * ROAD_SAMPLE_STEP);
    const t3 = normalize([tx, slope, tz]);
    const right = [tz, 0, -tx];
    const n = normalize(cross(t3, right));
    out.push({ c: [x, heights[i] + LIFT, z], right, n, along: i * ROAD_SAMPLE_STEP });
  }
  return out;
}

const at = (f, off, dy = 0) => [f.c[0] + f.right[0] * off, f.c[1] + dy, f.c[2] + f.right[2] * off];

export function buildRoad(scene, hf, colliders) {
  const F = frames(hf);
  const n = F.length;
  const hw = ROAD_HALF_WIDTH;

  // --- Asphalt -------------------------------------------------------------
  const road = new GeometryBuilder();
  for (let i = 0; i <= n; i++) {
    const f = F[i % n];
    const v = (i * ROAD_SAMPLE_STEP) / ASPHALT_TILE;
    road.addVertex(at(f, -hw), f.n, [0, v]);
    road.addVertex(at(f, hw), f.n, [(2 * hw) / ASPHALT_TILE, v]);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    road.addTriangle(a, a + 1, a + 3, F[i].n);
    road.addTriangle(a, a + 3, a + 2, F[i].n);
  }
  const asphalt = surfaceMaterial(scene, "asphalt", "asphalt", { bump: 0.6 });
  const roadMesh = road.toMesh("road", scene);
  roadMesh.material = asphalt;
  roadMesh.receiveShadows = true;

  // --- Gravel shoulders with a skirt that hides any gap underneath ---------
  const sh = new GeometryBuilder();
  for (let side = -1; side <= 1; side += 2) {
    let run = [];
    const flush = () => {
      for (let k = 0; k + 1 < run.length; k++) {
        const f0 = run[k];
        const f1 = run[k + 1];
        const v0 = f0.along / 4;
        const v1 = v0 + ROAD_SAMPLE_STEP / 4;
        const out = [f0.right[0] * side, 0.2, f0.right[2] * side];
        sh.addQuad(at(f0, side * hw, -0.005), at(f1, side * hw, -0.005), at(f1, side * (hw + 1.6), -0.08), at(f0, side * (hw + 1.6), -0.08),
          f0.n, [0, v0], [0, v1], [0.4, v1], [0.4, v0]);
        sh.addQuad(at(f0, side * (hw + 1.6), -0.08), at(f1, side * (hw + 1.6), -0.08), at(f1, side * (hw + 1.75), -0.9), at(f0, side * (hw + 1.75), -0.9),
          normalize(out), [0.4, v0], [0.4, v1], [0.6, v1], [0.6, v0]);
      }
      run = [];
    };
    for (let i = 0; i <= n; i++) {
      const f = F[i % n];
      if (onMainStreet(f.c[0], f.c[2])) flush();
      else run.push(f);
    }
    flush();
  }
  const gravel = surfaceMaterial(scene, "gravel", "rock", { tint: rgb(0.8, 0.76, 0.7), bump: 0.7 });
  const shoulderMesh = sh.toMesh("shoulders", scene);
  shoulderMesh.material = gravel;
  shoulderMesh.receiveShadows = true;

  // --- Painted lines ---------------------------------------------------------
  const lines = new GeometryBuilder();
  const lineStrip = (off, w, i, j) => {
    const f0 = F[i % n];
    const f1 = F[j % n];
    lines.addQuad(at(f0, off - w / 2), at(f1, off - w / 2), at(f1, off + w / 2), at(f0, off + w / 2), f0.n, [0, 0], [0, 1], [1, 1], [1, 0]);
  };
  for (let i = 0; i < n; i++) {
    lineStrip(-(hw - 0.35), 0.15, i, i + 1);
    lineStrip(hw - 0.35, 0.15, i, i + 1);
    if (i % 5 < 2) lineStrip(0, 0.14, i, i + 1); // 4 m dash, 6 m gap
  }
  const paint = plainMaterial(scene, "paint", rgb(0.78, 0.78, 0.74), { roughness: 0.55 });
  paint.zOffset = -2;
  const linesMesh = lines.toMesh("roadLines", scene);
  linesMesh.material = paint;
  linesMesh.receiveShadows = true;

  // --- Guard rails where the road sits high on a fill ------------------------
  const rail = new GeometryBuilder();
  const railOff = hw + 1.2;
  for (let side = -1; side <= 1; side += 2) {
    const needs = F.map((f) => {
      if (inTown(f.c[0], f.c[2], 30)) return false;
      const p = at(f, side * (hw + 9));
      return f.c[1] - hf.baseHeight(p[0], p[2]) > 2.5;
    });
    // Fill small holes so rails come in long runs.
    for (let i = 0; i < n; i++) if (!needs[i] && needs[(i - 3 + n) % n] && needs[(i + 3) % n]) needs[i] = true;
    for (let i = 0; i < n; i++) {
      if (!needs[i] || !needs[(i + 1) % n]) continue;
      const f0 = F[i];
      const f1 = F[(i + 1) % n];
      const a = at(f0, side * railOff);
      const b = at(f1, side * railOff);
      const out = [f0.right[0] * side, 0, f0.right[2] * side];
      const inward = [-out[0], 0, -out[2]];
      const y0 = 0.45;
      const y1 = 0.78;
      const up = (p, y) => [p[0], p[1] + y, p[2]];
      rail.addQuad(up(a, y0), up(b, y0), up(b, y1), up(a, y1), inward, [0, 0], [1, 0], [1, 1], [0, 1]);
      rail.addQuad(up(a, y0), up(b, y0), up(b, y1), up(a, y1), out, [0, 0], [1, 0], [1, 1], [0, 1]);
      rail.addQuad(up(a, y1), up(b, y1), up(b, y1 + 0.02), up(a, y1 + 0.02), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      if (i % 2 === 0) {
        // Post: a thin box from the ground to the beam.
        const s = 0.07;
        const fx = [f0.right[2], 0, -f0.right[0]];
        const pts = [
          [a[0] - out[0] * s - fx[0] * s, a[2] - out[2] * s - fx[2] * s],
          [a[0] + out[0] * s - fx[0] * s, a[2] + out[2] * s - fx[2] * s],
          [a[0] + out[0] * s + fx[0] * s, a[2] + out[2] * s + fx[2] * s],
          [a[0] - out[0] * s + fx[0] * s, a[2] - out[2] * s + fx[2] * s],
        ];
        for (let k = 0; k < 4; k++) {
          const p = pts[k];
          const q = pts[(k + 1) % 4];
          const mid = [(p[0] + q[0]) / 2 - a[0], 0, (p[1] + q[1]) / 2 - a[2]];
          rail.addQuad([p[0], a[1] - 0.6, p[1]], [q[0], a[1] - 0.6, q[1]], [q[0], a[1] + y1, q[1]], [p[0], a[1] + y1, p[1]],
            normalize(mid), [0, 0], [1, 0], [1, 1], [0, 1]);
        }
      }
      colliders.addSegment(a[0], a[2], b[0], b[2]);
    }
  }
  const steel = plainMaterial(scene, "steel", rgb(0.6, 0.62, 0.64), { metallic: 0.85, roughness: 0.38 });
  const railMesh = rail.toMesh("rails", scene);
  railMesh.material = steel;
  railMesh.receiveShadows = true;

  const meshes = [roadMesh, shoulderMesh, linesMesh, railMesh];
  for (const m of meshes) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
  return { meshes, casters: [railMesh] };
}
