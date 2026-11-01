import { SpotLight, PointLight, Vector3, Color3, Mesh, VertexData, StandardMaterial, DynamicTexture, Engine, Matrix, Quaternion } from "@babylonjs/core";
import { smoothstep } from "./noise.js";

// Everything that lights up after dark: street lamps (with pools of light on
// the road), car headlights and tail lights, town windows, and the landmarks.

// One patch of light per lamp, draped over the ground like a sheet so it lies
// on both the road and the raised pavement instead of being cut off at the kerb.
function poolMesh(scene, world, spots, radius) {
  const n = 22;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (const s of spots) {
    const base = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const v = j / n;
        const x = s.x + (u - 0.5) * 2 * radius;
        const z = s.z + (v - 0.5) * 2 * radius;
        positions.push(x, world.getHeight(x, z) + 0.03, z);
        uvs.push(u, v);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i;
        indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }
  }
  const mesh = new Mesh("lightPools", scene);
  const data = new VertexData();
  data.positions = positions;
  data.uvs = uvs;
  data.indices = indices;
  data.applyToMesh(mesh);
  return mesh;
}

// The patch of road lit by a car's headlights: bright just ahead, spreading
// and fading further out.
function beamTexture(scene) {
  const w = 64;
  const h = 128;
  const t = new DynamicTexture("beamPatch", { width: w, height: h }, scene, true);
  const c = t.getContext();
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const d = (h - 1 - y) / (h - 1); // 0 at the car, 1 at the far end
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5;
      const spread = 0.12 + 0.26 * d;
      const a = Math.pow(1 - d, 1.3) * Math.exp(-((u / spread) ** 2)) * smoothstep(0, 0.08, d);
      const o = (y * w + x) * 4;
      img.data[o] = 255;
      img.data[o + 1] = 240;
      img.data[o + 2] = 215;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  c.putImageData(img, 0, 0);
  t.update();
  return t;
}

function poolTexture(scene) {
  const size = 128;
  const t = new DynamicTexture("lightPool", { width: size, height: size }, scene, true);
  const c = t.getContext();
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255, 200, 130, 1)");
  g.addColorStop(0.45, "rgba(255, 176, 105, 0.45)");
  g.addColorStop(1, "rgba(255, 160, 90, 0)");
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  t.update(true);
  return t;
}

export class NightLights {
  constructor(scene, { world, town, car, lod }) {
    this.scene = scene;
    this.town = town;
    this.car = car;

    // Pools of warm light under each street lamp (painted on, not real lights,
    // so dozens of them cost almost nothing).
    this.pool = poolMesh(scene, world, town.lampSpots, 7.5);
    const pm = new StandardMaterial("lightPoolMat", scene);
    pm.disableLighting = true;
    pm.emissiveTexture = poolTexture(scene);
    pm.opacityTexture = pm.emissiveTexture;
    pm.alphaMode = Engine.ALPHA_ADD;
    pm.disableDepthWrite = true;
    pm.backFaceCulling = false;
    pm.zOffset = -2;
    pm.fogEnabled = true;
    this.pool.material = pm;
    this.poolMat = pm;
    this.pool.freezeWorldMatrix();
    this.pool.isPickable = false;
    this.pool.setEnabled(false);

    // Your car's headlight beam: one real light, so the road ahead lights up.
    this.beam = new SpotLight("headlights", new Vector3(0, 0.75, 2.3), new Vector3(0, -0.13, 1), Math.PI / 3.6, 14, scene);
    this.beam.parent = car.root;
    this.beam.diffuse = new Color3(1, 0.95, 0.85);
    this.beam.range = 70;
    this.beam.intensity = 0;

    // The two street lamps nearest you really light things up as well (cars,
    // people, walls), not just the ground. Only two, to stay quick on the iPad.
    this.spots = town.lampSpots;
    this.lamps = [0, 1].map((i) => {
      const l = new PointLight(`streetLamp${i}`, new Vector3(), scene);
      l.diffuse = new Color3(1, 0.76, 0.5);
      l.specular = new Color3(0.5, 0.38, 0.25);
      // Always switched on (just at zero brightness by day): turning a light on
      // or off makes every surface rebuild its shader, which would make the
      // scene flicker for a moment at dusk.
      l.intensity = 0;
      return l;
    });

    // Other cars' headlights light up the road in front of them.
    const beams = new Mesh("trafficBeams", scene);
    const quad = new VertexData();
    quad.positions = [-2.6, 0, 1.6, 2.6, 0, 1.6, 2.6, 0, 16, -2.6, 0, 16];
    quad.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    quad.indices = [0, 2, 1, 0, 3, 2];
    quad.applyToMesh(beams);
    const bm = new StandardMaterial("trafficBeamMat", scene);
    bm.disableLighting = true;
    bm.emissiveTexture = beamTexture(scene);
    bm.opacityTexture = bm.emissiveTexture;
    bm.alphaMode = Engine.ALPHA_ADD;
    bm.disableDepthWrite = true;
    bm.backFaceCulling = false;
    bm.zOffset = -2;
    beams.material = bm;
    beams.isPickable = false;
    beams.alwaysSelectAsActiveMesh = true;
    this.beamCap = 96;
    this.beamMatrices = new Float32Array(this.beamCap * 16);
    beams.thinInstanceSetBuffer("matrix", this.beamMatrices, 16, false);
    beams.setEnabled(false);
    this.beams = beams;
    this.beamMat = bm;
    this._m = new Matrix();
    this._q = new Quaternion();
    this._v = new Vector3();

    const find = (mats, re) => mats.filter((m) => m && re.test(m.name));
    this.carHead = find(car.materials, /^Headlight$/);
    this.carTail = find(car.materials, /^Brakelight$/);
    const lodMats = lod.material?.subMaterials ?? [lod.material];
    this.lodHead = find(lodMats, /^Headlight$/);
    this.lodTail = find(lodMats, /^Brakelight$/);
    this.windows = scene.materials.filter((m) => m.metadata?.windows);
    this.lattice = scene.getMaterialByName("ironLattice");
    this.clock = scene.getMaterialByName("clockFaceMat");
  }

  setCar(car) {
    this.car = car;
    this.beam.parent = car.root;
  }

  // `at` is where you are; `cars` is the traffic.
  update(night, braking, at, cars) {
    // Lights switch on as dusk falls, not all at once at midnight.
    const on = smoothstep(0.2, 0.55, night);
    this._updateLamps(on, at);
    this._updateBeams(on, at, cars);
    this.pool.setEnabled(on > 0.01);
    this.poolMat.emissiveColor.set(on * 0.15, on * 0.15, on * 0.15);
    this.town.lampGlow.emissiveColor.set(on * 4, on * 3.1, on * 2);
    this.beam.intensity = on * 70;

    const set = (mats, r, g, b) => {
      for (const m of mats) {
        m.emissiveColor.set(r, g, b);
        m.emissiveIntensity = 1;
      }
    };
    set(this.carHead, 3 * on, 2.9 * on, 2.6 * on);
    const tail = Math.min(4, on * 1.2 + (braking ? 3 : 0));
    set(this.carTail, tail, tail * 0.05, tail * 0.03);
    set(this.lodHead, 3 * on, 2.9 * on, 2.6 * on);
    set(this.lodTail, on * 1.4, on * 0.07, on * 0.04);
    for (const m of this.windows) m.emissiveColor.set(on * 0.95, on * 0.95, on * 0.95);
    this.lattice?.emissiveColor.set(on * 0.9, on * 0.55, on * 0.2);
    this.clock?.emissiveColor.set(0.12 + on * 0.9, 0.11 + on * 0.85, 0.09 + on * 0.6);
  }

  _updateLamps(on, at) {
    if (on < 0.01) {
      for (const l of this.lamps) l.intensity = 0;
      return;
    }
    // The nearest two lamps; each fades out as it gets further away, so
    // handing a light on to the next lamp along doesn't show.
    let a = null;
    let b = null;
    let da = Infinity;
    let db = Infinity;
    for (const s of this.spots) {
      const d = (s.x - at.x) ** 2 + (s.z - at.z) ** 2;
      if (d < da) {
        b = a;
        db = da;
        a = s;
        da = d;
      } else if (d < db) {
        b = s;
        db = d;
      }
    }
    [[a, da], [b, db]].forEach(([s, d2], i) => {
      const l = this.lamps[i];
      if (!s) {
        l.intensity = 0;
        return;
      }
      l.position.set(s.x, s.y + 7.2, s.z);
      l.intensity = on * 60 * smoothstep(58, 30, Math.sqrt(d2));
    });
  }

  _updateBeams(on, at, cars) {
    if (on < 0.01 || !cars) {
      this.beams.setEnabled(false);
      return;
    }
    let n = 0;
    for (const c of cars) {
      if (!c.moving || n >= this.beamCap) continue;
      if ((c.x - at.x) ** 2 + (c.z - at.z) ** 2 > 300 * 300) continue;
      Quaternion.RotationYawPitchRollToRef(c.yaw, c.pitch ?? 0, 0, this._q);
      this._v.set(c.x, c.y + 0.06, c.z);
      Matrix.ComposeToRef(Vector3.OneReadOnly, this._q, this._v, this._m);
      this._m.copyToArray(this.beamMatrices, n * 16);
      n++;
    }
    this.beams.setEnabled(n > 0);
    if (!n) return;
    this.beams.thinInstanceCount = n;
    this.beams.thinInstanceBufferUpdated("matrix");
    this.beamMat.emissiveColor.set(on * 0.32, on * 0.32, on * 0.32);
  }
}
