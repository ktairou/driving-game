import { Mesh, MeshBuilder, Matrix } from "@babylonjs/core";
import { GeometryBuilder, normalize, cross, sub, add, scale } from "../geom.js";
import { plainMaterial, rgb } from "./materials.js";
import { ISLANDS } from "./layout.js";

// The London Eye, built in code: a 120 m white wheel with 32 glass pods,
// held up on one side by a leaning A-frame, the way the real one is. It
// turns slowly (once every ten minutes), and the pods stay level as it goes.
//
// The wheel faces south, towards Kingsford's main street. `lm.x, lm.z` is the
// middle of its footprint: the wheel stands 14 m south of it and the A-frame
// leans back to the north.

const HUB = 68; // height of the hub above the ground
const R = 60; // the rim's outer tube
const R_IN = 56.5; // ...and its two inner tubes
const RIM_Z = 2.6; // how far the inner tubes sit in front of and behind the wheel's middle
const POD_R = 63.5; // where the pods' middles go round
const PODS = 32;
const STEPS = 96; // rim segments (three per pod)
const HUB_W = 8; // the hub reaches this far in front and behind; the spokes fan out from its ends
const WHEEL_Z = -14; // the wheel's plane, from the footprint's middle
const FEET = { x: 32, z: 30 }; // where the A-frame's legs stand
const TURN = (Math.PI * 2) / 600; // radians a second: one turn in ten minutes
const FAR = 3200; // further than this, the wheel isn't turned (it's too small to see move)

// A tube from p to q, `sides` faces round, radius r0 at p and r1 at q.
function tube(g, p, q, r0, r1 = r0, sides = 6) {
  const d = normalize(sub(q, p));
  const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(d, up));
  const v = cross(d, u);
  const len = Math.hypot(...sub(q, p));
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2;
    const a1 = ((k + 1) / sides) * Math.PI * 2;
    const n0 = add(scale(u, Math.cos(a0)), scale(v, Math.sin(a0)));
    const n1 = add(scale(u, Math.cos(a1)), scale(v, Math.sin(a1)));
    const mid = normalize(add(n0, n1));
    g.addQuad(add(p, scale(n0, r0)), add(p, scale(n1, r0)), add(q, scale(n1, r1)), add(q, scale(n0, r1)), mid, [0, 0], [1, 0], [1, len / 4], [0, len / 4], [n0, n1, n1, n0]);
  }
}

// A ring round the z axis (in the wheel's own frame), centred on c.
function ring(g, c, radius, thick, segs = 14, sides = 5) {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [c[0] + Math.cos(a0) * radius, c[1] + Math.sin(a0) * radius, c[2]];
    const p1 = [c[0] + Math.cos(a1) * radius, c[1] + Math.sin(a1) * radius, c[2]];
    tube(g, p0, p1, thick, thick, sides);
  }
}

// Where on the rim (in the wheel's frame, hub at 0,0,0) angle a is, at radius r and depth z.
const onRim = (a, r, z) => [Math.cos(a) * r, Math.sin(a) * r, z];

// The part that turns: rim, spokes, and the rings the pods hang in.
function buildWheel() {
  const g = new GeometryBuilder();
  for (let i = 0; i < STEPS; i++) {
    const a0 = (i / STEPS) * Math.PI * 2;
    const a1 = ((i + 1) / STEPS) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    // Three tubes round the rim, a triangle seen end on.
    tube(g, onRim(a0, R, 0), onRim(a1, R, 0), 0.55);
    tube(g, onRim(a0, R_IN, -RIM_Z), onRim(a1, R_IN, -RIM_Z), 0.45);
    tube(g, onRim(a0, R_IN, RIM_Z), onRim(a1, R_IN, RIM_Z), 0.45);
    // Zig-zag bracing between them, and a cross bar.
    tube(g, onRim(a0, R, 0), onRim(am, R_IN, -RIM_Z), 0.22, 0.22, 4);
    tube(g, onRim(am, R_IN, -RIM_Z), onRim(a1, R, 0), 0.22, 0.22, 4);
    tube(g, onRim(a0, R, 0), onRim(am, R_IN, RIM_Z), 0.22, 0.22, 4);
    tube(g, onRim(am, R_IN, RIM_Z), onRim(a1, R, 0), 0.22, 0.22, 4);
    tube(g, onRim(a0, R_IN, -RIM_Z), onRim(a0, R_IN, RIM_Z), 0.22, 0.22, 4);
  }
  // Spokes: cables from each end of the hub to the rim, like a bicycle wheel.
  for (let i = 0; i < PODS; i++) {
    const a = (i / PODS) * Math.PI * 2;
    const b = a + Math.PI / PODS;
    tube(g, onRim(a, 2.6, -HUB_W), onRim(a, R_IN, -RIM_Z), 0.16, 0.16, 4);
    tube(g, onRim(b, 2.6, HUB_W), onRim(b, R_IN, RIM_Z), 0.16, 0.16, 4);
  }
  // Each pod's mount: two rings it turns in (so it stays level), and an arm
  // out from the rim. (Round rings look the same however the wheel has turned.)
  for (let i = 0; i < PODS; i++) {
    const a = (i / PODS) * Math.PI * 2;
    const c = onRim(a, POD_R, 0);
    ring(g, [c[0], c[1], -2.7], 1.85, 0.16);
    ring(g, [c[0], c[1], 2.7], 1.85, 0.16);
    tube(g, onRim(a, R, 0), onRim(a, POD_R - 1.7, 0), 0.3, 0.3, 4);
  }
  return g;
}

// The parts that stand still: the hub and its spindle, the A-frame, the
// cables tying it back, and (separately) the boarding platform.
function buildFrame(world, cx, cz, ground) {
  const g = new GeometryBuilder();
  const wz = cz + WHEEL_Z;
  const hubY = ground + HUB;
  // The hub (a drum the spokes leave from) and the spindle back to the A-frame.
  tube(g, [cx, hubY, wz - HUB_W - 0.6], [cx, hubY, wz + HUB_W + 0.6], 2.9, 2.9, 14);
  tube(g, [cx, hubY, wz + HUB_W], [cx, hubY, cz + 1], 1.9, 1.9, 10);
  // Where the legs meet: a block at the top of the A.
  const top = [cx, hubY, cz + 1];
  for (const s of [-1, 1]) {
    const footX = cx + s * FEET.x;
    const footZ = cz + FEET.z;
    const footY = world.getHeight(footX, footZ) - 1.5;
    tube(g, [cx + s * 1.6, hubY - 0.5, cz + 1], [footX, footY, footZ], 1.5, 2.1, 10);
  }
  // A cross brace between the legs, a third of the way up.
  const k = 0.68;
  const braceY = ground + HUB * (1 - k) - 1;
  tube(g, [cx - FEET.x * k, braceY, cz + 1 + (FEET.z - 1) * k], [cx + FEET.x * k, braceY, cz + 1 + (FEET.z - 1) * k], 0.8, 0.8, 8);
  // Four cables from the top back to anchors in the ground behind.
  const anchors = [];
  for (const ax of [-22, -8, 8, 22]) {
    const x = cx + ax;
    const z = cz + 64;
    const y = world.getHeight(x, z);
    tube(g, [top[0] + Math.sign(ax) * 0.8, hubY + 1.2, top[2] + 0.6], [x, y + 0.6, z], 0.22, 0.22, 5);
    anchors.push([x, y, z]);
  }
  return { g, top, anchors };
}

export class LondonEye {
  constructor(scene, world, colliders) {
    this.lm = ISLANDS.flatMap((isl) => isl.landmarks).find((lm) => lm.type === "londonEye");
    this.meshes = [];
    this.casters = [];
    if (!this.lm) return;
    const lm = this.lm;
    // The ground's highest point under the platform: the wheel and platform stand on that.
    let ground = -Infinity;
    for (const dx of [-24, 0, 24]) for (const dz of [-7, 0, 7]) ground = Math.max(ground, world.getHeight(lm.x + dx, lm.z + WHEEL_Z + dz));
    const steel = plainMaterial(scene, "eyeSteel", rgb(0.9, 0.91, 0.93), { metallic: 0.25, roughness: 0.42 });
    const glass = plainMaterial(scene, "eyeGlass", rgb(0.3, 0.44, 0.52), { metallic: 0.75, roughness: 0.08 });
    const deckMat = plainMaterial(scene, "eyeDeck", rgb(0.56, 0.56, 0.54), { metallic: 0, roughness: 0.85 });
    this.hub = [lm.x, ground + HUB, lm.z + WHEEL_Z];

    // The wheel turns about its hub.
    const wheel = buildWheel().toMesh("londonEyeWheel", scene);
    wheel.material = steel;
    wheel.position.set(...this.hub);
    this.wheel = wheel;

    // The pods: one glass shape drawn 32 times, moved round with the wheel
    // but never turned, so they stay level.
    const pod = MeshBuilder.CreateSphere("londonEyePod", { diameterX: 4.3, diameterY: 3.8, diameterZ: 8.2, segments: 10 }, scene);
    pod.material = glass;
    pod.position.set(...this.hub);
    this.podMatrices = new Float32Array(16 * PODS);
    for (let i = 0; i < PODS; i++) Matrix.IdentityReadOnly.copyToArray(this.podMatrices, i * 16);
    pod.thinInstanceSetBuffer("matrix", this.podMatrices, 16, false);
    this.pod = pod;
    this.angle = null;
    this._place(0);
    pod.thinInstanceRefreshBoundingInfo(false);

    const frame = buildFrame(world, lm.x, lm.z, ground);
    const frameMesh = frame.g.toMesh("londonEyeFrame", scene);
    frameMesh.material = steel;

    // The boarding platform under the wheel, at the bottom of its turn.
    const wz = lm.z + WHEEL_Z;
    const deck = MeshBuilder.CreateBox("londonEyeDeck", { width: 48, height: 3.2, depth: 14 }, scene);
    deck.position.set(lm.x, ground + 0.2, wz);
    const steps = MeshBuilder.CreateBox("londonEyeSteps", { width: 16, height: 1.6, depth: 4 }, scene);
    steps.position.set(lm.x, ground + 0.1, wz - 8.5);
    const deckMesh = Mesh.MergeMeshes([deck, steps], true, true);
    deckMesh.material = deckMat;

    // Solid: the platform (so you can't drive under the pods), the two feet,
    // and the cable anchors.
    colliders.addBox(lm.x, wz, 24, 7);
    for (const s of [-1, 1]) colliders.addCircle(lm.x + s * FEET.x, lm.z + FEET.z, 2.6);
    for (const [x, , z] of frame.anchors) colliders.addCircle(x, z, 1);

    for (const m of [frameMesh, deckMesh]) {
      m.freezeWorldMatrix();
    }
    for (const m of [wheel, pod, frameMesh, deckMesh]) {
      m.receiveShadows = true;
      m.isPickable = false;
      this.meshes.push(m);
    }
    this.casters = [wheel, pod, frameMesh];
  }

  // Turns the wheel to where it is now (call every frame; `x, z` is where you are).
  update(x, z) {
    if (!this.lm) return;
    if (Math.hypot(x - this.lm.x, z - this.lm.z) > FAR && this.angle !== null) return;
    this._place((performance.now() / 1000) * TURN);
  }

  _place(angle) {
    // (It turns so slowly that a step this small isn't worth redrawing for.)
    if (this.angle !== null && Math.abs(angle - this.angle) < 1e-5) return;
    this.angle = angle;
    this.wheel.rotation.z = angle;
    const m = this.podMatrices;
    for (let i = 0; i < PODS; i++) {
      const a = angle + (i / PODS) * Math.PI * 2;
      m[i * 16 + 12] = Math.cos(a) * POD_R;
      m[i * 16 + 13] = Math.sin(a) * POD_R;
      m[i * 16 + 14] = 0;
    }
    this.pod.thinInstanceBufferUpdated("matrix");
  }
}
