import { MeshBuilder, Mesh, Matrix, Quaternion, Vector3, PBRMaterial, Color3 } from "@babylonjs/core";
import { clamp, lerp, mulberry32 } from "./noise.js";
import { ISLANDS, SEA_LEVEL } from "./world/layout.js";

// Simple people, built from a few rounded shapes and animated in code.
// Every body part is one instanced mesh, so a crowd costs only a few draws.
// (Placeholder look until realistic downloaded people replace them.)

const SKIN = [[0.94, 0.78, 0.66], [0.82, 0.62, 0.48], [0.6, 0.42, 0.3], [0.38, 0.25, 0.17]];
const HAIR = [[0.08, 0.06, 0.05], [0.3, 0.18, 0.08], [0.75, 0.6, 0.35], [0.5, 0.5, 0.5]];
const CLOTHES = [[0.15, 0.25, 0.5], [0.7, 0.12, 0.12], [0.9, 0.9, 0.88], [0.12, 0.12, 0.13], [0.2, 0.45, 0.3], [0.85, 0.65, 0.2], [0.45, 0.3, 0.55], [0.55, 0.55, 0.58]];
const TROUSERS = [[0.12, 0.14, 0.2], [0.2, 0.2, 0.22], [0.35, 0.3, 0.25], [0.1, 0.1, 0.1], [0.25, 0.3, 0.45]];

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// Part meshes, each built with its pivot (joint) at the origin.
function makeParts(scene) {
  const mat = new PBRMaterial("personMat", scene);
  mat.albedoColor = new Color3(1, 1, 1);
  mat.metallic = 0;
  mat.roughness = 0.8;
  const capsule = (name, h, r) => {
    const m = MeshBuilder.CreateCapsule(name, { height: h, radius: r, tessellation: 10, subdivisions: 2 }, scene);
    m.bakeTransformIntoVertices(Matrix.Translation(0, -h / 2, 0)); // hang down from the joint
    return m;
  };
  const torso = MeshBuilder.CreateCapsule("pTorso", { height: 0.66, radius: 0.19, tessellation: 12 }, scene);
  torso.scaling.set(1.15, 1, 0.68);
  torso.bakeCurrentTransformIntoVertices();
  const head = MeshBuilder.CreateSphere("pHead", { diameter: 0.25, segments: 10 }, scene);
  head.scaling.set(0.88, 1.08, 0.95);
  head.bakeCurrentTransformIntoVertices();
  // Hair: a flattened cap over the top and back of the head, leaving the face clear.
  const hair = MeshBuilder.CreateSphere("pHair", { diameter: 0.262, segments: 10 }, scene);
  hair.scaling.set(0.92, 0.62, 1.0);
  hair.position.set(0, 0.06, -0.022);
  hair.bakeCurrentTransformIntoVertices();
  const parts = {
    torso,
    head,
    hair,
    arm: capsule("pArm", 0.66, 0.06),
    leg: capsule("pLeg", 0.92, 0.085),
  };
  for (const m of Object.values(parts)) {
    m.material = mat;
    m.isPickable = false;
    m.receiveShadows = true;
    m.alwaysSelectAsActiveMesh = true;
  }
  return parts;
}

export class People {
  constructor(scene, world, pavementSpots, quality, onFoot) {
    this.world = world;
    this.rand = mulberry32(555);
    this.parts = makeParts(scene);
    this.people = [];
    // Slot 0 is you, when you're out of the car.
    this.player = this._make({ kind: "player", x: 0, z: 0, colours: { shirt: [0.85, 0.3, 0.1], trousers: [0.12, 0.14, 0.2], skin: SKIN[1], hair: HAIR[0] } });
    this.player.hidden = !onFoot;

    // Walkers on town pavements.
    const walkers = Math.round(quality.people * 0.7);
    for (let i = 0; i < walkers && pavementSpots.length; i++) {
      const sp = pavementSpots[i % pavementSpots.length];
      const p = this._make({ kind: "pavement", spot: sp, x: lerp(sp.x0, sp.x1, this.rand()), z: sp.z + (this.rand() - 0.5) * 2.4 });
      p.dirX = this.rand() < 0.5 ? 1 : -1;
      p.y = sp.y;
    }
    // Sightseers strolling round the landmarks.
    const landmarks = ISLANDS.flatMap((isl) => isl.landmarks);
    const tourists = quality.people - walkers;
    for (let i = 0; i < tourists; i++) {
      const lm = landmarks[i % landmarks.length];
      const r = (lm.base ?? 30) / 2 + 10 + this.rand() * 14;
      const a = this.rand() * Math.PI * 2;
      const p = this._make({ kind: "tourist", lm, radius: r, angle: a, x: lm.x + Math.sin(a) * r, z: lm.z + Math.cos(a) * r });
      p.turn = (this.rand() < 0.5 ? 1 : -1) * (p.speed / r);
    }

    const count = this.people.length;
    this.buffers = {};
    for (const key of ["torso", "head", "hair", "armL", "armR", "legL", "legR"]) {
      this.buffers[key] = { m: new Float32Array(count * 16), c: new Float32Array(count * 4) };
    }
    // Arms and legs share a mesh for both sides: two instance sets each.
    this.meshes = {
      torso: this.parts.torso,
      head: this.parts.head,
      hair: this.parts.hair,
      armL: this.parts.arm,
      armR: this.parts.arm.clone("pArmR"),
      legL: this.parts.leg,
      legR: this.parts.leg.clone("pLegR"),
    };
    this.meshes.armR.makeGeometryUnique();
    this.meshes.legR.makeGeometryUnique();
    for (const [key, mesh] of Object.entries(this.meshes)) {
      mesh.thinInstanceSetBuffer("matrix", this.buffers[key].m, 16, false);
      mesh.thinInstanceSetBuffer("color", this.buffers[key].c, 4, false);
    }
    this._tmp = { base: new Matrix(), local: new Matrix(), out: new Matrix(), q: new Quaternion(), v: new Vector3(), one: Vector3.One(), size: new Vector3() };
  }

  _make(o) {
    const rand = this.rand;
    const p = {
      speed: 1.1 + rand() * 0.5,
      phase: rand() * 10,
      heading: rand() * Math.PI * 2,
      walk: 1,
      y: 0,
      hidden: false,
      colours: o.colours ?? { shirt: pick(rand, CLOTHES), trousers: pick(rand, TROUSERS), skin: pick(rand, SKIN), hair: pick(rand, HAIR) },
      height: 0.92 + rand() * 0.14,
      ...o,
    };
    this.people.push(p);
    return p;
  }

  get meshList() {
    return Object.values(this.meshes);
  }

  // Bumpers for the car: one small circle per visible person.
  colliders() {
    return this.people.filter((p) => !p.hidden && p.kind !== "player").map((p) => ({ x: p.x, z: p.z, r: 0.35, person: p }));
  }

  update(dt, car) {
    for (const p of this.people) {
      if (p.kind === "player" || p.hidden) continue;
      let vx = 0;
      let vz = 0;
      if (p.kind === "pavement") {
        p.x += p.dirX * p.speed * dt;
        if (p.x > p.spot.x1) p.dirX = -1;
        if (p.x < p.spot.x0) p.dirX = 1;
        vx = p.dirX;
        p.y = p.spot.y;
      } else {
        p.angle += p.turn * dt;
        const nx = p.lm.x + Math.sin(p.angle) * p.radius;
        const nz = p.lm.z + Math.cos(p.angle) * p.radius;
        vx = nx - p.x;
        vz = nz - p.z;
        p.x = nx;
        p.z = nz;
        p.y = this.world.getHeight(p.x, p.z);
      }
      // Step out of the way of a car coming at you.
      if (car) {
        const dx = p.x - car.x;
        const dz = p.z - car.z;
        const d = Math.hypot(dx, dz);
        if (d < 4.5 && d > 0.01) {
          p.x += (dx / d) * 3.5 * dt;
          p.z += (dz / d) * 3.5 * dt;
        }
      }
      if (Math.abs(vx) + Math.abs(vz) > 1e-4) p.heading = Math.atan2(vx, vz);
      p.walk = 1;
      p.phase += dt * p.speed * 5.2;
    }
  }

  // Moves you (on foot) with the joystick. Returns nothing; updates `player`.
  movePlayer(dt, stickX, stickY, cameraYaw, colliders, dynamic) {
    const p = this.player;
    const mag = Math.min(1, Math.hypot(stickX, stickY));
    const speed = mag < 0.1 ? 0 : mag > 0.85 ? 5.2 : 1.7 * (mag / 0.85) + 0.3;
    if (speed > 0) {
      // Stick up = away from the camera.
      const a = cameraYaw + Math.atan2(stickX, -stickY);
      let nx = p.x + Math.sin(a) * speed * dt;
      let nz = p.z + Math.cos(a) * speed * dt;
      const h = this.world.getHeight(nx, nz);
      if (h > SEA_LEVEL + 0.15 && Math.abs(h - p.y) < 1.2) {
        const hit = colliders.resolveCircle(nx, nz, 0.35);
        if (hit) {
          nx = hit.x;
          nz = hit.z;
        }
        for (const o of dynamic) {
          const dx = nx - o.x;
          const dz = nz - o.z;
          const d = Math.hypot(dx, dz);
          const min = o.r + 0.35;
          if (d < min && d > 1e-4) {
            nx = o.x + (dx / d) * min;
            nz = o.z + (dz / d) * min;
          }
        }
        p.x = nx;
        p.z = nz;
      }
      p.heading = a;
    }
    p.y = lerp(p.y, this.world.getHeight(p.x, p.z), 0.4);
    p.speed = speed;
    p.walk = clamp(speed / 1.8, 0, 1);
    p.phase += dt * (speed > 3 ? speed * 2.4 : speed * 5.2);
  }

  draw() {
    const { base, local, out, q, v, one, size } = this._tmp;
    let n = 0;
    for (const p of this.people) {
      if (p.hidden) continue;
      const run = p.kind === "player" && p.speed > 3;
      const swing = Math.sin(p.phase) * (run ? 0.85 : 0.5) * p.walk;
      const bob = Math.abs(Math.cos(p.phase)) * 0.035 * p.walk;
      Quaternion.RotationYawPitchRollToRef(p.heading, run ? 0.12 : 0, 0, q);
      v.set(p.x, p.y + bob, p.z);
      size.set(p.height, p.height, p.height);
      Matrix.ComposeToRef(size, q, v, base);
      const put = (key, lx, ly, lz, pitch, colour) => {
        Quaternion.RotationYawPitchRollToRef(0, pitch, 0, q);
        v.set(lx, ly, lz);
        Matrix.ComposeToRef(one, q, v, local);
        local.multiplyToRef(base, out);
        out.copyToArray(this.buffers[key].m, n * 16);
        this.buffers[key].c.set([colour[0], colour[1], colour[2], 1], n * 4);
      };
      const c = p.colours;
      put("legL", -0.1, 0.94, 0, swing, c.trousers);
      put("legR", 0.1, 0.94, 0, -swing, c.trousers);
      put("torso", 0, 1.22, 0, 0, c.shirt);
      put("armL", -0.27, 1.47, 0, -swing * 0.8, c.shirt);
      put("armR", 0.27, 1.47, 0, swing * 0.8, c.shirt);
      put("head", 0, 1.7, 0, 0, c.skin);
      put("hair", 0, 1.7, 0, 0, c.hair);
      n++;
    }
    for (const mesh of Object.values(this.meshes)) {
      mesh.thinInstanceCount = n;
      mesh.thinInstanceBufferUpdated("matrix");
      mesh.thinInstanceBufferUpdated("color");
    }
  }
}
