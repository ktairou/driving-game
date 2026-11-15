import { Color3, DynamicTexture, Engine, GetTextureDataAsync, Matrix, PBRMaterial, StandardMaterial, Texture, Vector3, VertexBuffer } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { smoothstep } from "../noise.js";

// Brake lights and a soft shadow under every vehicle: yours and the traffic's.
// Both are thin instances (one draw each for every vehicle on screen), filled
// in world space each frame, so nothing hangs off a vehicle that can be
// thrown away when you swap cars.

// ---------- Finding the tail lamps on a model ----------

const tmpP = new Vector3();
const tmpN = new Vector3();

// The tail lamps of a vehicle, from the rear-facing triangles of its lamp
// parts. `parts` must stand in vehicle space (on the origin, facing +Z).
// Optics pictures carry the headlights, tail lights, indicators and reversing
// lamps together, so a small copy of the picture is read and only the red bits
// are kept (when it can't be read, every rear-facing lamp triangle counts).
// Returns [{ x, y, z, w, h }]: centre of each lamp's glow, and its size.
export async function findTailLamps(parts, { test = /optic/i, red = true } = {}) {
  const tris = [];
  for (const m of parts) {
    if (!test.test(m.material?.name ?? "")) continue;
    const pos = m.getVerticesData(VertexBuffer.PositionKind);
    const nor = m.getVerticesData(VertexBuffer.NormalKind);
    const uv = m.getVerticesData(VertexBuffer.UVKind);
    const idx = m.getIndices();
    if (!pos || !nor || !idx) continue;
    const wm = m.computeWorldMatrix(true);
    const P = new Float32Array(pos.length);
    const NZ = new Float32Array(pos.length / 3);
    for (let i = 0; i < pos.length / 3; i++) {
      Vector3.TransformCoordinatesFromFloatsToRef(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], wm, tmpP);
      P[i * 3] = tmpP.x;
      P[i * 3 + 1] = tmpP.y;
      P[i * 3 + 2] = tmpP.z;
      Vector3.TransformNormalFromFloatsToRef(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2], wm, tmpN);
      NZ[i] = tmpN.z / (tmpN.length() || 1);
    }
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      // Facing backwards, and on the back half of the vehicle.
      if ((NZ[a] + NZ[b] + NZ[c]) / 3 > -0.5) continue;
      const cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      if (cz > 0) continue;
      tris.push({
        m,
        v: [a, b, c].map((k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]),
        u: uv ? [(uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3, (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3] : null,
      });
    }
  }
  if (!tris.length) return [];

  let lit = tris;
  if (red) {
    // (Read once per picture; given a moment at most, like the cockpit paint.)
    const N = 64;
    const pictures = new Map();
    for (const t of tris) {
      const tex = t.m.material.albedoTexture;
      if (!tex || !t.u || pictures.has(tex)) continue;
      const timeout = new Promise((r) => setTimeout(() => r(null), 2500));
      const ready = () => (tex.isReady() ? Promise.resolve() : new Promise((r) => tex.onLoadObservable.addOnce(() => r())));
      pictures.set(tex, await Promise.race([ready().then(() => GetTextureDataAsync(tex, N, N)), timeout]).catch(() => null));
    }
    const isRed = (t) => {
      const data = pictures.get(t.m.material.albedoTexture);
      if (!data || !t.u) return null;
      const fx = t.u[0] - Math.floor(t.u[0]);
      const fy = t.u[1] - Math.floor(t.u[1]);
      const i = (Math.min(N - 1, Math.floor(fy * N)) * N + Math.min(N - 1, Math.floor(fx * N))) * 4;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      return r > 50 && r > g * 1.7 && r > b * 1.7;
    };
    const verdicts = tris.map(isRed);
    // Only trust the picture if it could be read at all.
    if (verdicts.some((v) => v !== null)) lit = tris.filter((t, i) => verdicts[i]);
  }
  if (!lit.length) return [];

  // Group touching triangles into lamps (a lamp each side, maybe a third one
  // high in the middle), then keep the biggest few.
  const parent = lit.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const centre = lit.map((t) => [0, 1, 2].map((k) => (t.v[0][k] + t.v[1][k] + t.v[2][k]) / 3));
  for (let i = 0; i < lit.length; i++) {
    for (let j = i + 1; j < lit.length; j++) {
      const d = Math.hypot(centre[i][0] - centre[j][0], centre[i][1] - centre[j][1], centre[i][2] - centre[j][2]);
      if (d < 0.22) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  lit.forEach((t, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, n: 0 });
    const g = groups.get(k);
    for (const v of t.v) {
      g.x0 = Math.min(g.x0, v[0]);
      g.x1 = Math.max(g.x1, v[0]);
      g.y0 = Math.min(g.y0, v[1]);
      g.y1 = Math.max(g.y1, v[1]);
      g.z0 = Math.min(g.z0, v[2]);
    }
    g.n++;
  });
  const lamps = [...groups.values()]
    // (The glow spreads a little past the lamp, and fades out over that edge.)
    .map((g) => ({ x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, z: g.z0 - 0.015, w: Math.max(0.08, g.x1 - g.x0) * 1.25 + 0.1, h: Math.max(0.06, g.y1 - g.y0) * 1.25 + 0.1, area: (g.x1 - g.x0) * (g.y1 - g.y0) }))
    .filter((l) => l.w < 1.4 && l.h < 1.0)
    .sort((a, b) => b.area - a.area)
    .slice(0, 4);
  return lamps.map(({ x, y, z, w, h }) => ({ x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3) }));
}

// What the brake lights and the shadow need to know about one kind of
// vehicle, worked out once: where its lamps are and how big it is.
export function fxKind({ lamps = [], length = 4.6, halfWidth = 1, centreZ = 0 }) {
  return {
    lamps: lamps.map((l) => Matrix.Scaling(l.w, l.h, 1).multiply(Matrix.Translation(l.x, l.y, l.z))),
    shadow: Matrix.Scaling(halfWidth * 2 * 1.22, 1, length * 1.1).multiply(Matrix.Translation(0, 0.04, centreZ)),
  };
}

// ---------- Drawing ----------

// A soft-edged rounded rectangle: white, with the softness in the alpha.
// `inner` is how much of it is solid before it starts to fade.
function softRect(scene, name, w, h, inner, power) {
  const t = new DynamicTexture(name, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const c = t.getContext();
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.abs((x + 0.5) / w - 0.5) * 2;
      const dy = Math.abs((y + 0.5) / h - 0.5) * 2;
      const d = Math.pow(dx ** 4 + dy ** 4, 0.25);
      const a = Math.pow(1 - smoothstep(inner, 1, d), power);
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  c.putImageData(img, 0, 0);
  t.update(false);
  t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
  return t;
}

// One quad, drawn once per instance; matrices are written in each frame.
function quads(scene, name, flat, material, cap) {
  const g = new GeometryBuilder();
  if (flat) g.addQuad([-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  else g.addQuad([-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0], [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);
  const mesh = g.toMesh(name, scene);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.alwaysSelectAsActiveMesh = true;
  const matrices = new Float32Array(cap * 16);
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
  mesh.thinInstanceCount = 0;
  mesh.freezeWorldMatrix();
  return { mesh, matrices, cap, count: 0 };
}

export class CarFx {
  // `cap`: most vehicles drawn at once.
  constructor(scene, cap) {
    // Brake lights: a red glow added over each lamp. (Unlit PBR, as a plain
    // material can't glow brighter than white, and bright is what makes the
    // soft halo round a lamp.)
    const gm = new PBRMaterial("brakeGlowMat", scene);
    gm.unlit = true;
    gm.albedoColor = new Color3(0, 0, 0);
    gm.emissiveTexture = softRect(scene, "brakeGlow", 64, 32, 0.45, 1.5);
    gm.opacityTexture = gm.emissiveTexture;
    gm.emissiveColor = new Color3(2.4, 0.12, 0.06);
    gm.alphaMode = Engine.ALPHA_ADD;
    gm.disableDepthWrite = true;
    gm.backFaceCulling = false;
    gm.zOffset = -2;
    this.glowMat = gm;
    this.glow = quads(scene, "brakeGlow", false, gm, cap * 2);

    // Soft shadow on the ground under each vehicle, so it sits on the road
    // even where the sun's shadow is faint or out of range.
    const sm = new StandardMaterial("contactShadowMat", scene);
    sm.disableLighting = true;
    sm.diffuseColor.set(0, 0, 0);
    sm.emissiveColor.set(0, 0, 0);
    sm.opacityTexture = softRect(scene, "contactShadow", 64, 64, 0.2, 1.4);
    sm.alpha = 0.62;
    sm.disableDepthWrite = true;
    sm.backFaceCulling = false;
    sm.zOffset = -3;
    sm.specularColor.set(0, 0, 0);
    this.shadowMat = sm;
    this.shadow = quads(scene, "contactShadows", true, sm, cap);
    // Drawn before the brake glow and the lamp pools, after the road.
    this.shadow.mesh.alphaIndex = 1;
    this.glow.mesh.alphaIndex = 3;

    this._m = new Matrix();
  }

  begin() {
    this.glow.count = 0;
    this.shadow.count = 0;
  }

  // One vehicle: `world` is its matrix (on the ground), `kind` from fxKind().
  // `lampWorld` is where its body is, when that leans (yours), else `world`.
  add(world, kind, braking, lampWorld = world) {
    const s = this.shadow;
    if (s.count < s.cap) {
      kind.shadow.multiplyToRef(world, this._m);
      this._m.copyToArray(s.matrices, s.count++ * 16);
    }
    if (!braking) return;
    const g = this.glow;
    for (const lamp of kind.lamps) {
      if (g.count >= g.cap) break;
      lamp.multiplyToRef(lampWorld, this._m);
      this._m.copyToArray(g.matrices, g.count++ * 16);
    }
  }

  // `night` 0..1: the glow is a little softer after dark, where it stands out more.
  end(night) {
    this._show(this.glow);
    this._show(this.shadow);
    const k = 1 - 0.3 * night;
    this.glowMat.emissiveColor.set(2.4 * k, 0.12 * k, 0.06 * k);
    this.shadowMat.alpha = 0.62 - 0.12 * night;
  }

  _show(q) {
    q.mesh.thinInstanceCount = q.count;
    if (q.count) q.mesh.thinInstanceBufferUpdated("matrix");
  }
}
