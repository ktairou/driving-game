import { MeshBuilder, Mesh, Vector3 } from "@babylonjs/core";
import { GeometryBuilder, normalize, cross } from "../geom.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { TOWNS, ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./layout.js";
import { SEA_FLOOR } from "./islands.js";

const LIFT = 0.04; // road surface sits this far above the height grid
const ASPHALT_TILE = 7; // metres per asphalt texture repeat

// The town a point is in (with a margin around each), or null.
export function townAt(x, z, margin = 0) {
  for (const t of TOWNS) if (Math.abs(x - t.cx) < t.hx + margin && Math.abs(z - t.cz) < t.hz + margin) return t;
  return null;
}

export function inTown(x, z, margin = 0) {
  return townAt(x, z, margin) !== null;
}

export function onMainStreet(x, z) {
  return TOWNS.some((t) => x > t.street.x0 && x < t.street.x1 && Math.abs(z - t.street.z) < 15);
}

// Per-sample frame: centre point, right vector and surface normal.
function frames(road) {
  const { points, heights, tangents, count, closed } = road;
  const out = [];
  for (let i = 0; i < count; i++) {
    const [x, z] = points[i];
    const [tx, tz] = tangents[i];
    const prev = closed ? (i - 1 + count) % count : Math.max(0, i - 1);
    const next = closed ? (i + 1) % count : Math.min(count - 1, i + 1);
    const run = Math.max(1, next - prev) * ROAD_SAMPLE_STEP;
    const slope = closed ? (heights[next] - heights[prev]) / (2 * ROAD_SAMPLE_STEP) : (heights[next] - heights[prev]) / run;
    const t3 = normalize([tx, slope, tz]);
    const right = [tz, 0, -tx];
    const n = normalize(cross(t3, right));
    out.push({ c: [x, heights[i] + LIFT, z], right, n, along: i * ROAD_SAMPLE_STEP });
  }
  return out;
}

const at = (f, off, dy = 0) => [f.c[0] + f.right[0] * off, f.c[1] + dy, f.c[2] + f.right[2] * off];
const up = (p, y) => [p[0], p[1] + y, p[2]];

// Runs of consecutive sample indices for which `test(i)` is true.
function runs(count, closed, test) {
  const out = [];
  let cur = null;
  for (let i = 0; i < count; i++) {
    if (test(i)) {
      if (!cur) cur = [i, i];
      cur[1] = i;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  // Join a run that wraps past the end of a loop.
  if (closed && out.length > 1 && out[0][0] === 0 && out[out.length - 1][1] === count - 1) {
    const last = out.pop();
    out[0] = [last[0], out[0][1] + count];
  }
  return out;
}

// A box-section strip running along the road between two side offsets
// (used for bridge parapets and the slab). "inner" faces the road centre,
// "outer" faces away from it.
function addStrip(g, F, i0, i1, n, offA, offB, yBot, yTop, faces) {
  const side = Math.sign(offA + offB);
  const offIn = Math.abs(offA) < Math.abs(offB) ? offA : offB;
  const offOut = offIn === offA ? offB : offA;
  for (let k = i0; k < i1; k++) {
    const f0 = F[k % n];
    const f1 = F[(k + 1) % n];
    const out = [f0.right[0] * side, 0, f0.right[2] * side];
    const inn = [-out[0], 0, -out[2]];
    const v0 = k * 0.25;
    const v1 = v0 + 0.25;
    if (faces.includes("inner")) g.addQuad(up(at(f0, offIn), yBot), up(at(f1, offIn), yBot), up(at(f1, offIn), yTop), up(at(f0, offIn), yTop), inn, [v0, 0], [v1, 0], [v1, 1], [v0, 1]);
    if (faces.includes("outer")) g.addQuad(up(at(f0, offOut), yBot), up(at(f1, offOut), yBot), up(at(f1, offOut), yTop), up(at(f0, offOut), yTop), out, [v0, 0], [v1, 0], [v1, 1], [v0, 1]);
    if (faces.includes("top")) g.addQuad(up(at(f0, offIn), yTop), up(at(f1, offIn), yTop), up(at(f1, offOut), yTop), up(at(f0, offOut), yTop), [0, 1, 0], [v0, 0], [v1, 0], [v1, 0.3], [v0, 0.3]);
    if (faces.includes("bottom")) g.addQuad(up(at(f0, offIn), yBot), up(at(f1, offIn), yBot), up(at(f1, offOut), yBot), up(at(f0, offOut), yBot), [0, -1, 0], [v0, 0], [v1, 0], [v1, 1], [v0, 1]);
  }
}

export function buildRoad(scene, world, colliders) {
  const hw = ROAD_HALF_WIDTH;
  const asphalt = surfaceMaterial(scene, "asphalt", "asphalt", { bump: 0.6 });
  // Connectors are drawn just on top of the loop where they join it.
  const asphaltTop = asphalt.clone("asphaltTop");
  asphaltTop.zOffset = -1;
  const gravel = surfaceMaterial(scene, "gravel", "rock", { tint: rgb(0.8, 0.76, 0.7), bump: 0.7 });
  const white = plainMaterial(scene, "paintWhite", rgb(0.78, 0.78, 0.74), { roughness: 0.55 });
  const yellow = plainMaterial(scene, "paintYellow", rgb(0.85, 0.62, 0.08), { roughness: 0.55 });
  white.zOffset = yellow.zOffset = -2;
  const steel = plainMaterial(scene, "steel", rgb(0.6, 0.62, 0.64), { metallic: 0.85, roughness: 0.38 });
  const concrete = surfaceMaterial(scene, "concrete", "plaster", { tint: rgb(0.78, 0.78, 0.76) });
  const red = plainMaterial(scene, "bridgeRed", rgb(0.62, 0.11, 0.05), { metallic: 0.3, roughness: 0.5 });

  const meshes = [];
  const casters = [];
  const keep = (m, material, cast = false) => {
    m.material = material;
    m.receiveShadows = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
    meshes.push(m);
    if (cast) casters.push(m);
    return m;
  };

  for (const road of world.network.roads) {
    const F = frames(road);
    const n = road.count;
    const closed = road.closed;
    const segs = closed ? n : n - 1;
    const isUSA = road.island === "usa";

    // --- Asphalt -----------------------------------------------------------
    const surf = new GeometryBuilder();
    for (let i = 0; i <= segs; i++) {
      const f = F[i % n];
      const v = (i * ROAD_SAMPLE_STEP) / ASPHALT_TILE;
      surf.addVertex(at(f, -hw), f.n, [0, v]);
      surf.addVertex(at(f, hw), f.n, [(2 * hw) / ASPHALT_TILE, v]);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      surf.addTriangle(a, a + 1, a + 3, F[i].n);
      surf.addTriangle(a, a + 3, a + 2, F[i].n);
    }
    keep(surf.toMesh(`road_${road.id}`, scene), closed ? asphalt : asphaltTop);

    // Leave gaps in paint, gravel and barriers wherever another road joins or crosses.
    const nearMeet = (i, r) => world.network.isNearMeeting(road.points[i % n][0], road.points[i % n][1], r);
    const isBridge = (i) => road.bridge[i % n];

    // --- Gravel shoulders with a skirt that hides any gap underneath ---------
    const sh = new GeometryBuilder();
    for (let side = -1; side <= 1; side += 2) {
      for (const [r0, r1] of runs(n, closed, (i) => !onMainStreet(...road.points[i]) && !isBridge(i) && !nearMeet(i, 9))) {
        for (let k = r0; k < r1 && (closed || k + 1 < n); k++) {
          const f0 = F[k % n];
          const f1 = F[(k + 1) % n];
          const v0 = f0.along / 4;
          const v1 = v0 + ROAD_SAMPLE_STEP / 4;
          const out = normalize([f0.right[0] * side, 0.2, f0.right[2] * side]);
          sh.addQuad(at(f0, side * hw, -0.005), at(f1, side * hw, -0.005), at(f1, side * (hw + 1.6), -0.08), at(f0, side * (hw + 1.6), -0.08), f0.n, [0, v0], [0, v1], [0.4, v1], [0.4, v0]);
          sh.addQuad(at(f0, side * (hw + 1.6), -0.08), at(f1, side * (hw + 1.6), -0.08), at(f1, side * (hw + 1.75), -0.9), at(f0, side * (hw + 1.75), -0.9), out, [0.4, v0], [0.4, v1], [0.6, v1], [0.6, v0]);
        }
      }
    }
    if (sh.vertexCount) keep(sh.toMesh(`shoulders_${road.id}`, scene), gravel);

    // --- Painted lines ------------------------------------------------------------
    const lines = new GeometryBuilder();
    const centre = new GeometryBuilder();
    const strip = (g, off, w, i, j) => {
      const f0 = F[i % n];
      const f1 = F[j % n];
      g.addQuad(at(f0, off - w / 2), at(f1, off - w / 2), at(f1, off + w / 2), at(f0, off + w / 2), f0.n, [0, 0], [0, 1], [1, 1], [1, 0]);
    };
    for (let i = 0; i < segs; i++) {
      if (nearMeet(i, 8) || nearMeet(i + 1, 8)) continue;
      strip(lines, -(hw - 0.35), 0.15, i, i + 1);
      strip(lines, hw - 0.35, 0.15, i, i + 1);
      if (isUSA) {
        // Double yellow centre line.
        strip(centre, -0.14, 0.11, i, i + 1);
        strip(centre, 0.14, 0.11, i, i + 1);
      } else if (i % 5 < 2) {
        strip(lines, 0, 0.14, i, i + 1); // 4 m dash, 6 m gap
      }
    }
    if (lines.vertexCount) keep(lines.toMesh(`lines_${road.id}`, scene), white);
    if (centre.vertexCount) keep(centre.toMesh(`centre_${road.id}`, scene), yellow);

    // --- Guard rails where the road sits high on a fill (on land) -------------
    const rail = new GeometryBuilder();
    const railOff = hw + 1.2;
    for (let side = -1; side <= 1; side += 2) {
      const needs = F.map((f, i) => {
        // (No barrier across the way into a fuel station.)
        if (isBridge(i) || nearMeet(i, 18) || inTown(f.c[0], f.c[2], 30) || !world.isClear(f.c[0], f.c[2])) return false;
        const p = at(f, side * (hw + 9));
        return f.c[1] - world.baseHeight(p[0], p[2]) > 2.5;
      });
      for (let i = 0; i < n; i++) if (!needs[i] && needs[(i - 3 + n) % n] && needs[(i + 3) % n] && !isBridge(i)) needs[i] = true;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        if (!needs[i] || !needs[j]) continue;
        const f0 = F[i];
        const f1 = F[j];
        const a = at(f0, side * railOff);
        const b = at(f1, side * railOff);
        const out = [f0.right[0] * side, 0, f0.right[2] * side];
        const inward = [-out[0], 0, -out[2]];
        const y0 = 0.45;
        const y1 = 0.78;
        rail.addQuad(up(a, y0), up(b, y0), up(b, y1), up(a, y1), inward, [0, 0], [1, 0], [1, 1], [0, 1]);
        rail.addQuad(up(a, y0), up(b, y0), up(b, y1), up(a, y1), out, [0, 0], [1, 0], [1, 1], [0, 1]);
        rail.addQuad(up(a, y1), up(b, y1), up(b, y1 + 0.02), up(a, y1 + 0.02), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
        if (i % 2 === 0) {
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
            rail.addQuad([p[0], a[1] - 0.6, p[1]], [q[0], a[1] - 0.6, q[1]], [q[0], a[1] + y1, q[1]], [p[0], a[1] + y1, p[1]], normalize(mid), [0, 0], [1, 0], [1, 1], [0, 1]);
          }
        }
        colliders.addSegment(a[0], a[2], b[0], b[2]);
      }
    }
    if (rail.vertexCount) keep(rail.toMesh(`rails_${road.id}`, scene), steel, true);

    // --- Bridges ---------------------------------------------------------------------
    for (const [r0, r1raw] of runs(n, closed, (i) => isBridge(i))) {
      // Start the structure a little before the water and end a little after.
      const b0 = Math.max(0, r0 - 6);
      const b1 = Math.min(closed ? r1raw + 6 : n - 1, r1raw + 6);
      const deck = new GeometryBuilder();
      const walls = new GeometryBuilder();
      // Slab under the road, and parapet walls along both edges.
      addStrip(deck, F, b0, b1, n, -hw - 0.6, hw + 0.6, -1.4, -0.05, ["bottom"]);
      addStrip(deck, F, b0, b1, n, hw + 0.6, hw + 0.6, -1.4, 0, ["outer"]);
      addStrip(deck, F, b0, b1, n, -hw - 0.6, -hw - 0.6, -1.4, 0, ["outer"]);
      for (const side of [-1, 1]) {
        const inner = side * (hw + 0.15);
        const outer = side * (hw + 0.6);
        addStrip(walls, F, b0, b1, n, inner, outer, -0.05, 0.95, ["inner", "top", "outer"]);
        for (let k = b0; k < b1; k++) {
          const a = at(F[k % n], inner);
          const b = at(F[(k + 1) % n], inner);
          colliders.addSegment(a[0], a[2], b[0], b[2]);
        }
      }
      // Piers down to the sea bed every 40 m where it's over water.
      const piers = [];
      for (let k = b0 + 10; k < b1 - 6; k += 20) {
        const f = F[k % n];
        if (!isBridge(k)) continue;
        const ground = Math.max(world.baseHeight(f.c[0], f.c[2]), SEA_FLOOR);
        const hgt = f.c[1] - 1.4 - ground;
        if (hgt < 2) continue;
        const pier = MeshBuilder.CreateBox("pier", { width: 2.6, depth: 5.5, height: hgt }, scene);
        pier.position.set(f.c[0], ground + hgt / 2, f.c[2]);
        pier.rotation.y = Math.atan2(f.right[0], f.right[2]);
        piers.push(pier);
      }
      keep(deck.toMesh(`bridgeDeck_${road.id}_${r0}`, scene), concrete, true);
      keep(walls.toMesh(`bridgeWalls_${road.id}_${r0}`, scene), road.style === "suspension" ? red : concrete, true);
      if (piers.length) keep(Mesh.MergeMeshes(piers, true, true), concrete, true);

      if (road.style === "suspension") buildSuspension(scene, F, n, b0, b1, red, keep);
    }
  }

  return { meshes, casters };
}

// Two tall towers, two main cables and hanging suspenders, all bridge red.
function buildSuspension(scene, F, n, b0, b1, red, keep) {
  const len = b1 - b0;
  const towersAt = [b0 + Math.round(len * 0.28), b0 + Math.round(len * 0.72)];
  const towerTop = 68; // above the deck
  const parts = [];
  const hw = ROAD_HALF_WIDTH + 1.6;
  for (const k of towersAt) {
    const f = F[k % n];
    const yaw = Math.atan2(f.right[0], f.right[2]);
    const base = f.c[1] - 30; // legs reach down into the water
    for (const side of [-1, 1]) {
      const leg = MeshBuilder.CreateBox("leg", { width: 3.2, depth: 4.2, height: towerTop + 30 }, scene);
      const p = at(f, side * hw);
      leg.position.set(p[0], base + (towerTop + 30) / 2, p[2]);
      leg.rotation.y = yaw;
      parts.push(leg);
    }
    // Cross beams (portals) between the legs.
    for (const y of [towerTop - 2, towerTop - 24, towerTop - 46, 6]) {
      const beam = MeshBuilder.CreateBox("beam", { width: hw * 2, depth: 3.2, height: 3.5 }, scene);
      beam.position.set(f.c[0], f.c[1] + y, f.c[2]);
      beam.rotation.y = yaw;
      parts.push(beam);
    }
  }
  // Main cables: anchored at the deck ends, over the tower tops, sagging between.
  const cableY = (k) => {
    const [t1, t2] = towersAt;
    const top = F[t1 % n].c[1] + towerTop;
    if (k <= t1) return F[b0 % n].c[1] + 1 + ((top - F[b0 % n].c[1] - 1) * (k - b0)) / (t1 - b0);
    if (k >= t2) return F[b1 % n].c[1] + 1 + ((top - F[b1 % n].c[1] - 1) * (b1 - k)) / (b1 - t2);
    const u = (k - t1) / (t2 - t1);
    return top - 4 * (towerTop - 6) * u * (1 - u);
  };
  for (const side of [-1, 1]) {
    const path = [];
    for (let k = b0; k <= b1; k += 2) {
      const p = at(F[k % n], side * hw);
      path.push(new Vector3(p[0], cableY(k), p[2]));
    }
    parts.push(MeshBuilder.CreateTube("cable", { path, radius: 0.55, tessellation: 8 }, scene));
    // Suspenders every 12 m.
    for (let k = b0 + 6; k < b1 - 3; k += 6) {
      const p = at(F[k % n], side * hw);
      const top = cableY(k);
      const h = top - F[k % n].c[1];
      if (h < 2) continue;
      const s = MeshBuilder.CreateBox("hanger", { width: 0.18, depth: 0.18, height: h }, scene);
      s.position.set(p[0], F[k % n].c[1] + h / 2, p[2]);
      parts.push(s);
    }
  }
  keep(Mesh.MergeMeshes(parts, true, true), red, true);
}
