import { FreeCamera, Vector3 } from "@babylonjs/core";
import { clamp, lerp } from "./noise.js";

// Camera views, in the order the camera button cycles through them.
// "attached" views ride with the car body; positions are in car space
// (+z forward, +y up).
export const CAMERA_MODES = [
  { name: "Chase", kind: "chase", dist: 6.4, height: 2.1, look: 1.1, fov: [0.88, 1.02] },
  { name: "Far chase", kind: "chase", dist: 9.5, height: 3.2, look: 1.0, fov: [0.84, 0.96] },
  { name: "Driver", kind: "attached", eye: "driver", fov: [1.08, 1.18], near: 0.03 },
  { name: "Bonnet", kind: "attached", pos: [0, 1.04, 1.45], fov: [0.98, 1.1] },
  { name: "Bumper", kind: "attached", pos: [0, 0.55, 2.55], fov: [0.98, 1.12] },
  { name: "TV camera", kind: "tv" },
];

const tmp = new Vector3();
const tmpLook = new Vector3();

export class ChaseCamera {
  constructor(scene, hf, car, mode = 0) {
    this.hf = hf;
    this.car = car;
    this.camera = new FreeCamera("cam", new Vector3(0, 10, -10), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 2400;
    this.camera.inputs.clear();
    this.mode = clamp(mode | 0, 0, CAMERA_MODES.length - 1);
    this.pos = new Vector3();
    this.target = new Vector3();
    this.dirX = 0;
    this.dirZ = 1;
    this.shake = 0;
    this.tv = null;
    this._first = true;
  }

  get modeName() {
    return CAMERA_MODES[this.mode].name;
  }

  cycle() {
    this.mode = (this.mode + 1) % CAMERA_MODES.length;
    this._first = true;
    this.tv = null;
    return this.modeName;
  }

  update(dt, v) {
    const m = CAMERA_MODES[this.mode];
    const cam = this.camera;
    cam.minZ = m.near ?? 0.1;
    if (m.kind === "attached") this._attached(m);
    else if (m.kind === "tv") this._tv(dt, v);
    else this._chase(dt, m, v);
    if (m.fov) {
      const fovT = clamp(v.speed / 55, 0, 1);
      cam.fov = lerp(cam.fov, lerp(m.fov[0], m.fov[1], fovT), this._first ? 1 : 1 - Math.exp(-dt * 3));
    }
    this._first = false;
  }

  // Fixed to the car: driver's seat, bonnet, bumper.
  _attached(m) {
    const body = this.car.body;
    body.computeWorldMatrix(true);
    const wm = body.getWorldMatrix();
    const local = m.eye === "driver" ? this.car.eye : tmp.set(m.pos[0], m.pos[1], m.pos[2]);
    Vector3.TransformCoordinatesToRef(local, wm, this.camera.position);
    tmpLook.set(local.x, local.y - 0.35, local.z + 10);
    Vector3.TransformCoordinatesToRef(tmpLook, wm, this.target);
    // Keep the horizon level-ish when the car rolls, like a real head would.
    this.camera.upVector.set(0, 1, 0);
    this.camera.setTarget(this.target);
  }

  _chase(dt, m, v) {
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    const speed = v.speed;
    // Look direction follows where the car is going when moving fast,
    // and where it is pointing when slow or reversing.
    let dx = s;
    let dz = c;
    if (speed > 4 && v.forwardSpeed > 0) {
      const w = clamp((speed - 4) / 12, 0, 1) * 0.5;
      dx = lerp(s, v.vx / speed, w);
      dz = lerp(c, v.vz / speed, w);
    }
    const k = this._first ? 1 : 1 - Math.exp(-dt * 7);
    this.dirX = lerp(this.dirX, dx, k);
    this.dirZ = lerp(this.dirZ, dz, k);
    const l = Math.hypot(this.dirX, this.dirZ) || 1;
    const ux = this.dirX / l;
    const uz = this.dirZ / l;

    const dist = m.dist + clamp(speed / 50, 0, 1) * 1.2;
    const want = tmp.set(v.x - ux * dist, v.y + m.height, v.z - uz * dist);
    const ground = this.hf.getHeight(want.x, want.z) + 0.7;
    if (want.y < ground) want.y = ground;
    if (this._first) this.pos.copyFrom(want);
    else {
      const kp = 1 - Math.exp(-dt * 10);
      this.pos.x = lerp(this.pos.x, want.x, kp);
      this.pos.z = lerp(this.pos.z, want.z, kp);
      this.pos.y = lerp(this.pos.y, want.y, 1 - Math.exp(-dt * 5));
    }
    this.target.set(v.x + ux * 2.5, v.y + m.look, v.z + uz * 2.5);

    // Bumps and crashes shake the view a touch.
    this.shake = Math.max(this.shake * Math.exp(-dt * 6), v.impact);
    const j = this.shake * 0.12;
    this.camera.position.set(this.pos.x + (Math.random() - 0.5) * j, this.pos.y + (Math.random() - 0.5) * j, this.pos.z + (Math.random() - 0.5) * j);
    this.camera.setTarget(this.target);
  }

  // A camera standing by the roadside ahead, zooming to keep the car framed.
  // When the car has gone past, it jumps to a new spot further on.
  _tv(dt, v) {
    const cam = this.camera;
    const dist = this.tv ? Math.hypot(this.tv.x - v.x, this.tv.z - v.z) : Infinity;
    const behind = this.tv ? (this.tv.x - v.x) * Math.sin(v.heading) + (this.tv.z - v.z) * Math.cos(v.heading) < -25 : true;
    if (!this.tv || dist > 160 || (behind && dist > 45)) this.tv = this._pickTvSpot(v);
    cam.position.set(this.tv.x, this.tv.y, this.tv.z);
    // Aim a little ahead of the car so it doesn't sit dead centre.
    this.target.set(v.x + v.vx * 0.15, v.y + 0.8, v.z + v.vz * 0.15);
    cam.setTarget(this.target);
    const d = Math.max(4, Math.hypot(this.tv.x - v.x, this.tv.y - v.y, this.tv.z - v.z));
    const fov = clamp(2 * Math.atan(7 / d), 0.12, 1.0);
    cam.fov = this._first ? fov : lerp(cam.fov, fov, 1 - Math.exp(-dt * 4));
  }

  _pickTvSpot(v) {
    const hf = this.hf;
    const pts = hf.road.points;
    const n = pts.length;
    const i = hf.nearestRoadSample(v.x, v.z);
    // Which way along the road is the car heading?
    const t = hf.road.tangents[i];
    const dir = t[0] * Math.sin(v.heading) + t[1] * Math.cos(v.heading) >= 0 ? 1 : -1;
    const ahead = (i + dir * (35 + Math.round(Math.random() * 20)) + n * 4) % n;
    const [px, pz] = pts[ahead];
    const [tx, tz] = hf.road.tangents[ahead];
    const side = Math.random() < 0.5 ? -1 : 1;
    const off = 9 + Math.random() * 6;
    const x = px + tz * side * off;
    const z = pz - tx * side * off;
    const y = Math.max(hf.getHeight(x, z), hf.road.heights[ahead]) + 1.6 + Math.random() * 2.5;
    return { x, y, z };
  }
}
