import { Color4, DynamicTexture, Mesh, ParticleSystem, StandardMaterial, Texture, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { clamp, smoothstep } from "../noise.js";

// Tyre smoke and skid marks from wheels that are sliding or spinning (hard
// launches, hard braking, slides). Only your vehicle makes them.

const MARKS = 200; // skid-mark pieces kept; the oldest is reused for the next
const MARK_WIDTH = 0.24;
const MARK_STEP = 0.8; // metres of travel per piece (200 pieces: 40 m of all four tyres braking)
const MARK_FROM = 0.3; // how hard a tyre must slide before it marks the road

// A soft grey puff with a ragged edge.
function puffTexture(scene) {
  const size = 64;
  const t = new DynamicTexture("tyreSmoke", { width: size, height: size }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const c = t.getContext();
  const img = c.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const a = Math.atan2(dy, dx);
      const edge = 0.42 + 0.05 * Math.sin(a * 5 + 1.3) + 0.03 * Math.sin(a * 11);
      const k = 1 - smoothstep(edge * 0.25, edge, Math.hypot(dx, dy));
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(k * k * 255);
    }
  }
  c.putImageData(img, 0, 0);
  t.update(false);
  t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
  return t;
}

export class TyreFx {
  // `cap`: most smoke puffs at once (fewer on Low).
  constructor(scene, world, cap = 150) {
    this.world = world;

    // --- Skid marks: one mesh, a ring of quads rewritten in place -----------
    const n = MARKS * 4;
    this.positions = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 4);
    const indices = new Uint32Array(MARKS * 6);
    for (let q = 0; q < MARKS; q++) {
      const v = q * 4;
      indices.set([v, v + 2, v + 1, v, v + 3, v + 2], q * 6);
    }
    const normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1;
    const mesh = new Mesh("skidMarks", scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = normals;
    vd.colors = this.colors;
    vd.indices = indices;
    vd.applyToMesh(mesh, true);
    mesh.hasVertexAlpha = true;
    const mat = new StandardMaterial("skidMat", scene);
    mat.disableLighting = true;
    mat.diffuseColor.set(0.025, 0.025, 0.027);
    mat.emissiveColor.set(0, 0, 0);
    mat.specularColor.set(0, 0, 0);
    mat.disableDepthWrite = true;
    mat.backFaceCulling = false;
    mat.zOffset = -2;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    // (Its pieces are anywhere in the world, so never skip it as off screen.)
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.alphaIndex = 0;
    mesh.freezeWorldMatrix();
    this.marks = mesh;
    this.next = 0;
    // Each wheel's last mark point, while it is marking.
    this.last = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    this.marking = [false, false, false, false];
    this.lastAlpha = [0, 0, 0, 0];

    // --- Smoke ---------------------------------------------------------------
    const ps = new ParticleSystem("tyreSmoke", cap, scene);
    ps.particleTexture = puffTexture(scene);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.emitter = new Vector3(0, -1000, 0);
    ps.minLifeTime = 1.1;
    ps.maxLifeTime = 2.3;
    ps.minSize = 0.55;
    ps.maxSize = 0.95;
    ps.addSizeGradient(0, 0.6);
    ps.addSizeGradient(1, 3.6);
    ps.addColorGradient(0, new Color4(0.86, 0.86, 0.86, 0.42));
    ps.addColorGradient(0.25, new Color4(0.84, 0.84, 0.85, 0.3));
    ps.addColorGradient(1, new Color4(0.82, 0.82, 0.84, 0));
    ps.minAngularSpeed = -0.6;
    ps.maxAngularSpeed = 0.6;
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    ps.minEmitPower = 0.4;
    ps.maxEmitPower = 1.3;
    ps.gravity = new Vector3(0, 0.45, 0);
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    // Puffs start at a sliding tyre (picked by how hard each one slides) and
    // drift up and out; they stay where they were made as the car drives on.
    this.weights = [0, 0, 0, 0];
    this.wheelAt = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    this.weightSum = 0;
    ps.startPositionFunction = (wm, pos) => {
      let r = Math.random() * this.weightSum;
      let i = 0;
      while (i < 3 && (r -= this.weights[i]) > 0) i++;
      const w = this.wheelAt[i];
      pos.set(w.x + (Math.random() - 0.5) * 0.3, w.y + 0.15, w.z + (Math.random() - 0.5) * 0.3);
    };
    ps.startDirectionFunction = (wm, dir) => {
      dir.set(Math.random() - 0.5, 0.5 + Math.random() * 0.5, Math.random() - 0.5);
    };
    ps.renderingGroupId = 0;
    ps.start();
    this.smoke = ps;
    this.emitDebt = 0;
    this.puffs = 0; // made so far (for tests)
  }

  // Lay one piece of skid mark from a to b (world points on the ground).
  _mark(a, b, alphaA, alphaB) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const sx = (-dz / l) * MARK_WIDTH * 0.5;
    const sz = (dx / l) * MARK_WIDTH * 0.5;
    const q = this.next;
    this.next = (q + 1) % MARKS;
    const v = q * 4;
    this._put(v, a.x - sx, a.y, a.z - sz, alphaA);
    this._put(v + 1, a.x + sx, a.y, a.z + sz, alphaA);
    this._put(v + 2, b.x + sx, b.y, b.z + sz, alphaB);
    this._put(v + 3, b.x - sx, b.y, b.z - sz, alphaB);
    this.dirty = true;
  }

  // One corner of a skid-mark piece.
  _put(v, x, y, z, alpha) {
    const P = this.positions;
    const C = this.colors;
    P[v * 3] = x;
    P[v * 3 + 1] = y;
    P[v * 3 + 2] = z;
    C[v * 4] = C[v * 4 + 1] = C[v * 4 + 2] = 1;
    C[v * 4 + 3] = alpha;
  }

  // Every frame. `v` is the vehicle; `light` 0..1 (dark at night) tints the
  // smoke; `wet` 0..1 (wet tyres hardly smoke); `active` false when nobody is
  // driving (on foot, at the pump).
  update(dt, v, light = 1, wet = 0, active = true) {
    const slip = v.wheelSlip;
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    const ground = v.wheelGround;
    let sum = 0;
    // Front left, front right, rear left, rear right (as vehicle.js has them).
    for (let i = 0; i < 4; i++) {
      const lz = i < 2 ? v.a : -v.b;
      const lx = i % 2 ? v.halfTrack : -v.halfTrack;
      const w = this.wheelAt[i];
      w.set(v.x + s * lz + c * lx, (ground ? ground[i] : v.y) + 0.03, v.z + c * lz - s * lx);
      const k = active && v.grounded ? slip[i] : 0;
      this.weights[i] = k * k;
      sum += k * k;

      // Skid marks: a strip behind each sliding tyre, faded in and out.
      const last = this.last[i];
      if (k > MARK_FROM) {
        const alpha = 0.7 * smoothstep(0.25, 0.65, k);
        if (!this.marking[i]) {
          this.marking[i] = true;
          last.copyFrom(w);
          this.lastAlpha[i] = 0;
        } else {
          const d = Math.hypot(w.x - last.x, w.z - last.z);
          if (d > 4) last.copyFrom(w); // jumped (reset, swap): start afresh
          else if (d >= MARK_STEP) {
            this._mark(last, w, this.lastAlpha[i], alpha);
            last.copyFrom(w);
            this.lastAlpha[i] = alpha;
          }
        }
      } else if (this.marking[i]) {
        // Ends with a short fade to nothing.
        this.marking[i] = false;
        const d = Math.hypot(w.x - last.x, w.z - last.z);
        if (this.lastAlpha[i] > 0 && d > 0.05 && d < 4) this._mark(last, w, this.lastAlpha[i], 0);
      }
    }
    if (this.dirty) {
      this.dirty = false;
      this.marks.updateVerticesData(VertexBuffer.PositionKind, this.positions, false, false);
      this.marks.updateVerticesData(VertexBuffer.ColorKind, this.colors, false, false);
    }

    // Smoke: puffs a second from each tyre, by how hard it slides.
    this.weightSum = sum;
    const rate = sum * 46 * (1 - 0.75 * clamp(wet, 0, 1));
    this.emitDebt += rate * dt;
    const n = Math.floor(this.emitDebt);
    this.emitDebt -= n;
    if (n > 0 && sum > 0.01) {
      this.smoke.manualEmitCount = n;
      this.puffs += n;
    }
    const l = 0.25 + 0.75 * clamp(light, 0, 1);
    this.smoke.textureMask.set(l, l, l, 1);
  }
}
