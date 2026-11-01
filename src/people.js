import {
  LoadAssetContainerAsync,
  PBRMaterial,
  Texture,
  Matrix,
  Quaternion,
  Vector3,
  Animation,
  AnimationGroup,
  TransformNode,
  BakedVertexAnimationManager,
  VertexAnimationBaker,
} from "@babylonjs/core";
import { FBXFileLoader } from "@babylonjs/loaders/FBX";
import { clamp, lerp, mulberry32 } from "./noise.js";
import { ISLANDS, SEA_LEVEL } from "./world/layout.js";

// Realistic people from Microsoft's Rocketbox library (MIT licence), with
// motion-captured walking, jogging and standing clips.
//
// The crowd uses baked animation: every pose of every clip is worked out once
// at load and stored in a texture, and the graphics chip looks poses up from
// it. So a person costs no skeleton work at all, and everyone wearing the same
// outfit is a single draw. Only you get a live skeleton, so your walk can
// blend smoothly into a run.

// The FBX files name the original .tga textures, which aren't shipped (one
// combined .webp per person is used instead). Skip those lookups: each one
// would otherwise try six file types before giving up.
FBXFileLoader._createTexture = () => null;

const BASE = "./assets/people/";
const LOAD = { pluginOptions: { fbx: { unitScale: "meters" } } };
// The first outfit is yours; the rest make up the crowd.
const AVATARS = [
  ["Male_Adult_01", "m"],
  ["Female_Adult_01", "f"],
  ["Male_Adult_04", "m"],
  ["Female_Adult_04", "f"],
  ["Business_Male_02", "m"],
  ["Business_Female_01", "f"],
  ["Male_Adult_08", "m"],
  ["Female_Adult_08", "f"],
];
// Where each part sits in the combined texture: [u, v, width, height], with v
// measured from the bottom (made by tools/fetch-people.mjs).
const ATLAS = { body: [0, 1 / 3, 1, 2 / 3], head: [0, 0, 0.5, 1 / 3], opacity: [0.5, 0, 0.5, 1 / 3] };
// Baked poses per second. Standing still moves slowly, so it needs fewer.
const CLIPS = [
  ["walk", 60],
  ["run", 60],
  ["idle", 30],
];
const DRAW_DIST = 320;
const MIRROR_Z = Matrix.Scaling(1, 1, -1);

// (When the game is in the background frames stop, so just yield instead.)
const nextFrame = () => new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => r())));
const baseName = (n) => n.replace(/^Clone of /, "");

function turnTowards(a, b, maxStep) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + clamp(d, -maxStep, maxStep);
}

// Loads one animation clip and samples it. Walk and jog are recorded moving
// forward; that travel is taken out (the game moves people itself) and kept as
// the clip's natural speed, so feet can be matched to the ground.
async function loadClip(scene, file, rate) {
  const c = await LoadAssetContainerAsync(`${BASE}${file}.fbx`, scene, LOAD);
  const group = c.animationGroups[0];
  const tracks = [];
  let speed = 0;
  let restY = 1;
  let fps = 30;
  for (const ta of group.targetedAnimations) {
    const a = ta.animation;
    fps = a.framePerSecond;
    if (a.targetProperty === "rotationQuaternion") {
      tracks.push({ name: ta.target.name, prop: "rotationQuaternion", anim: a });
    } else if (a.targetProperty === "position" && ta.target.name === "Bip01") {
      const keys = a.getKeys();
      const first = keys[0];
      const last = keys[keys.length - 1];
      const span = Math.max(last.frame - first.frame, 1);
      const travel = last.value.z - first.value.z;
      speed = (travel * 0.01) / (span / fps);
      restY = first.value.y;
      const inPlace = new Animation("rootInPlace", "position", fps, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
      inPlace.setKeys(
        keys.map((k) => ({
          frame: k.frame,
          value: new Vector3(k.value.x, k.value.y, k.value.z - first.value.z - (travel * (k.frame - first.frame)) / span),
        })),
      );
      tracks.push({ name: "Bip01", prop: "position", anim: inPlace });
    }
  }
  const rows = Math.floor(((group.to - group.from) * rate) / fps) + 1;
  // Sample every track once; each outfit then only copies these numbers.
  const values = new Float32Array(rows * tracks.length * 4);
  for (let r = 0; r < rows; r++) {
    const frame = group.from + (r * fps) / rate;
    for (let i = 0; i < tracks.length; i++) {
      const v = tracks[i].anim.evaluate(frame);
      const o = (r * tracks.length + i) * 4;
      values[o] = v.x;
      values[o + 1] = v.y;
      values[o + 2] = v.z;
      values[o + 3] = v.w ?? 0;
    }
  }
  c.dispose();
  return { tracks, rows, rate, speed, restY, values };
}

// Loads one outfit and gives it a single material using the combined texture.
async function loadAvatar(scene, name) {
  const c = await LoadAssetContainerAsync(`${BASE}${name}.fbx`, scene, LOAD);
  for (const g of c.animationGroups) g.dispose();
  c.animationGroups.length = 0;
  const mesh = c.meshes.find((m) => m.skeleton);
  const multi = mesh.material;

  // Move each part's texture coordinates into its corner of the combined texture.
  const uv = mesh.getVerticesData("uv");
  const indices = mesh.getIndices();
  const done = new Uint8Array(uv.length / 2);
  for (const sm of mesh.subMeshes) {
    const matName = multi?.subMaterials?.[sm.materialIndex]?.name ?? "";
    const [u0, v0, w, h] = ATLAS[/head/i.test(matName) ? "head" : /opacity/i.test(matName) ? "opacity" : "body"];
    for (let i = sm.indexStart; i < sm.indexStart + sm.indexCount; i++) {
      const vi = indices[i];
      if (done[vi]) continue;
      done[vi] = 1;
      uv[vi * 2] = u0 + clamp(uv[vi * 2], 0, 1) * w;
      uv[vi * 2 + 1] = v0 + clamp(uv[vi * 2 + 1], 0, 1) * h;
    }
  }
  mesh.setVerticesData("uv", uv);
  mesh.releaseSubMeshes();
  mesh._createGlobalSubMesh(true);

  const mat = new PBRMaterial(`person-${name}`, scene);
  mat.albedoTexture = new Texture(`${BASE}${name}.webp`, scene);
  mat.albedoTexture.hasAlpha = true;
  mat.useAlphaFromAlbedoTexture = true;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  mat.alphaCutOff = 0.45;
  mat.metallic = 0;
  mat.roughness = 0.78;
  mesh.material = mat;
  for (const m of multi?.subMaterials ?? []) m?.dispose(true, true);
  multi?.dispose(true, true);
  c.materials.length = 0;
  c.multiMaterials.length = 0;
  c.textures.length = 0;

  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.setEnabled(false);
  c.addAllToScene();
  const nodes = new Map(c.transformNodes.map((n) => [baseName(n.name), n]));
  return { name, mesh, root: c.rootNodes[0], skeleton: mesh.skeleton, nodes, material: mat };
}

// Works out every pose of every clip for one outfit and stores the bone
// matrices in a texture, one row per pose. Done a slice at a time so the game
// keeps running smoothly meanwhile.
async function bake(scene, av, clips) {
  const { skeleton, mesh, nodes } = av;
  const perRow = (skeleton.bones.length + 1) * 16;
  const total = Object.values(clips).reduce((n, c) => n + c.rows, 0);
  const data = new Float32Array(perRow * total);
  const rootY = nodes.get("Bip01")?.position.y ?? 1;
  const ranges = {};
  let row = 0;
  for (const [key, clip] of Object.entries(clips)) {
    const targets = clip.tracks.map((t) => nodes.get(t.name));
    const s = rootY / clip.restY;
    const n = clip.tracks.length;
    ranges[key] = { start: row, end: row + clip.rows - 1, rows: clip.rows, rate: clip.rate };
    for (let r = 0; r < clip.rows; r++, row++) {
      for (let i = 0; i < n; i++) {
        const node = targets[i];
        if (!node) continue;
        const o = (r * n + i) * 4;
        const v = clip.values;
        if (clip.tracks[i].prop === "position") node.position.set(v[o] * s, v[o + 1] * s, v[o + 2] * s);
        else (node.rotationQuaternion ??= new Quaternion()).set(v[o], v[o + 1], v[o + 2], v[o + 3]);
      }
      skeleton.prepare(true);
      data.set(skeleton.getTransformMatrices(mesh), row * perRow);
      if (row % 100 === 99) await nextFrame();
    }
  }
  const manager = new BakedVertexAnimationManager(scene);
  manager.texture = new VertexAnimationBaker(scene, mesh).textureFromBakedVertexData(data);
  return { manager, ranges };
}

export class People {
  constructor(scene, world, pavementSpots, quality, onFoot) {
    this.scene = scene;
    this.world = world;
    this.rand = mulberry32(555);
    this.people = [];
    this.kinds = null;
    this.body = null;
    this.clock = 0;
    this._dt = 0;
    // Natural speeds of the clips (m/s); filled in properly once loaded.
    this.natural = { m: { walk: 1, run: 2.7 }, f: { walk: 1, run: 2.7 } };

    // Slot 0 is you, when you're out of the car.
    this.player = this._make({ kind: "player", x: 0, z: 0, avatar: 0 });
    this.player.hidden = !onFoot;

    // Walkers (and a few joggers) on town pavements.
    const walkers = Math.round(quality.people * 0.7);
    for (let i = 0; i < walkers && pavementSpots.length; i++) {
      const sp = pavementSpots[i % pavementSpots.length];
      const p = this._make({ kind: "pavement", spot: sp, x: lerp(sp.x0, sp.x1, this.rand()), z: sp.z + (this.rand() - 0.5) * 2.4 });
      p.dirX = this.rand() < 0.5 ? 1 : -1;
      p.heading = p.dirX > 0 ? Math.PI / 2 : -Math.PI / 2;
      p.jogger = this.rand() < 0.12;
      p.y = sp.y;
    }
    // Sightseers strolling round the landmarks.
    const landmarks = ISLANDS.flatMap((isl) => isl.landmarks);
    const tourists = quality.people - walkers;
    for (let i = 0; i < tourists; i++) {
      const lm = landmarks[i % landmarks.length];
      const r = (lm.base ?? 30) / 2 + 10 + this.rand() * 14;
      const a = this.rand() * Math.PI * 2;
      const p = this._make({ kind: "tourist", lm, radius: r, minRadius: (lm.base ?? 30) / 2 + 5, angle: a, x: lm.x + Math.sin(a) * r, z: lm.z + Math.cos(a) * r });
      p.dir = this.rand() < 0.5 ? 1 : -1;
      p.heading = a + (p.dir * Math.PI) / 2;
      p.y = world.getHeight(p.x, p.z);
    }
    this._tmp = { place: new Matrix(), out: new Matrix(), q: new Quaternion(), v: new Vector3(), s: new Vector3() };
  }

  _make(o) {
    const rand = this.rand;
    const p = {
      avatar: 1 + Math.floor(rand() * (AVATARS.length - 1)),
      rate: 0.88 + rand() * 0.22,
      offset: Math.floor(rand() * 1000),
      heading: 0,
      speed: 0,
      moving: true,
      jogger: false,
      pause: 0,
      nextPause: 8 + rand() * 30,
      y: 0,
      hidden: false,
      height: 0.96 + rand() * 0.08,
      ...o,
    };
    p.sex = AVATARS[p.avatar][1];
    this.people.push(p);
    return p;
  }

  // Downloads the people and their animations. Call once the game is running:
  // until then everyone still moves about, just unseen.
  async load() {
    const scene = this.scene;
    const clipJobs = {};
    for (const sex of ["m", "f"]) {
      clipJobs[sex] = Promise.all(CLIPS.map(([name, rate]) => loadClip(scene, `${name}_${sex}`, rate)));
    }
    const avatarJobs = AVATARS.map(([name]) => loadAvatar(scene, name));
    const clips = {};
    for (const sex of ["m", "f"]) {
      const [walk, run, idle] = await clipJobs[sex];
      clips[sex] = { walk, run, idle };
      this.natural[sex] = { walk: walk.speed, run: run.speed };
    }

    const kinds = [];
    for (let i = 0; i < AVATARS.length; i++) {
      const av = await avatarJobs[i];
      const sexClips = clips[AVATARS[i][1]];
      if (i === 0) {
        this.body = this._makeBody(scene, av, sexClips);
        kinds.push(null);
        continue;
      }
      const { manager, ranges } = await bake(scene, av, sexClips);
      const { mesh } = av;
      // The model's own scale and turn (centimetres, other-handed) go into each
      // person's placement instead; the mesh keeps a mirror so faces aren't
      // drawn inside out.
      const fix = mesh.computeWorldMatrix(true).clone();
      mesh.parent = null;
      mesh.position.setAll(0);
      mesh.rotationQuaternion = null;
      mesh.rotation.setAll(0);
      mesh.scaling.set(1, 1, -1);
      mesh.bakedVertexAnimationManager = manager;
      const cap = Math.max(1, this.people.filter((p) => p.avatar === i).length);
      const matrices = new Float32Array(cap * 16);
      const settings = new Float32Array(cap * 4);
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      mesh.thinInstanceSetBuffer("bakedVertexAnimationSettingsInstanced", settings, 4, false);
      mesh.alwaysSelectAsActiveMesh = true;
      kinds.push({ mesh, manager, ranges, fix, matrices, settings, count: 0 });
    }
    this.kinds = kinds;
  }

  // Your own body: a live skeleton with walk, jog and stand blended by speed.
  _makeBody(scene, av, clips) {
    const holder = new TransformNode("playerBody", scene);
    av.root.parent = holder;
    const rootY = av.nodes.get("Bip01")?.position.y ?? 1;
    const groups = {};
    for (const [key, clip] of Object.entries(clips)) {
      const g = new AnimationGroup(`player-${key}`, scene);
      for (const t of clip.tracks) {
        const node = av.nodes.get(t.name);
        if (!node) continue;
        let anim = t.anim;
        if (t.prop === "position") {
          const s = rootY / clip.restY;
          anim = anim.clone();
          anim.setKeys(anim.getKeys().map((k) => ({ frame: k.frame, value: k.value.scale(s) })));
        }
        g.addTargetedAnimation(anim, node);
      }
      g.play(true);
      g.weight = key === "idle" ? 1 : 0;
      groups[key] = g;
    }
    av.mesh.alwaysSelectAsActiveMesh = true;
    av.mesh.setEnabled(true);
    holder.setEnabled(false);
    return { holder, groups, mesh: av.mesh, nodes: av.nodes, weights: { walk: 0, run: 0, idle: 1 }, playing: true };
  }

  get meshList() {
    if (!this.kinds) return [];
    return [...this.kinds.filter(Boolean).map((k) => k.mesh), this.body.mesh];
  }

  // Bumpers for the car: one small circle per visible person.
  colliders() {
    return this.people.filter((p) => !p.hidden && p.kind !== "player").map((p) => ({ x: p.x, z: p.z, r: 0.35, person: p }));
  }

  update(dt, car) {
    this._dt = dt;
    this.clock += dt;
    const rand = this.rand;
    for (const p of this.people) {
      if (p.kind === "player" || p.hidden) continue;
      const nat = this.natural[p.sex];
      if (p.pause > 0) {
        // Standing for a moment: sightseers look at the landmark.
        p.pause -= dt;
        p.moving = false;
        if (p.kind === "tourist") p.heading = turnTowards(p.heading, Math.atan2(p.lm.x - p.x, p.lm.z - p.z), 2 * dt);
        else p.heading = turnTowards(p.heading, p.dirX > 0 ? Math.PI / 2 : -Math.PI / 2, 3.5 * dt);
      } else {
        p.moving = true;
        p.speed = (p.jogger ? nat.run : nat.walk) * p.rate;
        if (!p.jogger && (p.nextPause -= dt) <= 0) {
          p.pause = 3 + rand() * 7;
          p.nextPause = 15 + rand() * 35;
        }
        if (p.kind === "pavement") {
          p.x += p.dirX * p.speed * dt;
          // At the end of the pavement, stop, turn round and come back.
          if ((p.dirX > 0 && p.x > p.spot.x1) || (p.dirX < 0 && p.x < p.spot.x0)) {
            p.dirX = -p.dirX;
            p.pause = 0.8 + rand() * (p.jogger ? 0.4 : 2.5);
          }
          p.heading = turnTowards(p.heading, p.dirX > 0 ? Math.PI / 2 : -Math.PI / 2, 4 * dt);
          p.y = p.spot.y;
        } else {
          // Carry on round from wherever they are now (they may have been knocked aside).
          p.radius = Math.max(p.minRadius, Math.hypot(p.x - p.lm.x, p.z - p.lm.z));
          p.angle = Math.atan2(p.x - p.lm.x, p.z - p.lm.z);
          p.angle += (p.dir * p.speed * dt) / p.radius;
          p.x = p.lm.x + Math.sin(p.angle) * p.radius;
          p.z = p.lm.z + Math.cos(p.angle) * p.radius;
          p.heading = turnTowards(p.heading, p.angle + (p.dir * Math.PI) / 2, 4 * dt);
          p.y = this.world.getHeight(p.x, p.z);
        }
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
    }
  }

  // Moves you (on foot) with the joystick. Returns nothing; updates `player`.
  movePlayer(dt, stickX, stickY, cameraYaw, colliders, dynamic) {
    const p = this.player;
    const mag = Math.min(1, Math.hypot(stickX, stickY));
    // A gentle push walks; pushing the stick right out jogs.
    const speed = mag < 0.1 ? 0 : mag > 0.85 ? 4 : 0.5 + 1.2 * ((mag - 0.1) / 0.75);
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
      p.heading = turnTowards(p.heading, a, 9 * dt);
    }
    p.y = lerp(p.y, this.world.getHeight(p.x, p.z), 0.4);
    p.speed = speed;
  }

  draw() {
    if (this.body) this._drawBody();
    if (!this.kinds) return;
    const { place, out, q, v, s } = this._tmp;
    const cam = this.scene.activeCamera.globalPosition;
    for (const k of this.kinds) if (k) k.count = 0;
    for (const p of this.people) {
      if (p.hidden || p.kind === "player") continue;
      const dx = p.x - cam.x;
      const dz = p.z - cam.z;
      if (dx * dx + dz * dz > DRAW_DIST * DRAW_DIST) continue;
      const k = this.kinds[p.avatar];
      Quaternion.RotationYawPitchRollToRef(p.heading, 0, 0, q);
      v.set(p.x, p.y, p.z);
      s.setAll(p.height);
      Matrix.ComposeToRef(s, q, v, place);
      k.fix.multiplyToRef(place, out);
      out.multiplyToRef(MIRROR_Z, place);
      place.copyToArray(k.matrices, k.count * 16);
      const clip = !p.moving ? k.ranges.idle : p.jogger ? k.ranges.run : k.ranges.walk;
      const o = k.count * 4;
      k.settings[o] = clip.start;
      k.settings[o + 1] = clip.end;
      k.settings[o + 2] = p.offset % (clip.rows - 1);
      k.settings[o + 3] = clip.rate * (p.moving ? p.rate : 1);
      k.count++;
    }
    for (const k of this.kinds) {
      if (!k) continue;
      k.mesh.setEnabled(k.count > 0);
      k.manager.time = this.clock;
      if (!k.count) continue;
      k.mesh.thinInstanceCount = k.count;
      k.mesh.thinInstanceBufferUpdated("matrix");
      k.mesh.thinInstanceBufferUpdated("bakedVertexAnimationSettingsInstanced");
    }
  }

  _drawBody() {
    const p = this.player;
    const b = this.body;
    const show = !p.hidden;
    b.holder.setEnabled(show);
    // Don't keep animating a body nobody can see.
    if (show !== b.playing) {
      b.playing = show;
      for (const g of Object.values(b.groups)) show ? g.play(true) : g.pause();
    }
    if (!show) return;
    b.holder.position.set(p.x, p.y, p.z);
    b.holder.rotation.y = p.heading;
    const nat = this.natural[AVATARS[0][1]];
    const target = p.speed < 0.05 ? "idle" : p.speed > 2.5 ? "run" : "walk";
    const blend = Math.min(1, this._dt * 7);
    for (const [key, g] of Object.entries(b.groups)) {
      b.weights[key] += ((key === target ? 1 : 0) - b.weights[key]) * blend;
      g.weight = b.weights[key];
    }
    b.groups.walk.speedRatio = clamp(p.speed / nat.walk, 0.5, 1.8);
    b.groups.run.speedRatio = clamp(p.speed / nat.run, 0.7, 1.6);
  }
}
