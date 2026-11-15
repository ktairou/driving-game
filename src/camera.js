import { Effect, FreeCamera, PostProcess, Vector3 } from "@babylonjs/core";
import { clamp, lerp, smoothstep } from "./noise.js";
import { ROAD_HALF_WIDTH, SEA_LEVEL } from "./world/layout.js";

// Camera views, in the order the camera button cycles through them.
// "attached" views ride with the car body; positions are in car space
// (+z forward, +y up). `fov`: field of view standing still and at top speed
// (it widens as you go faster, for a sense of speed).
export const CAMERA_MODES = [
  { name: "Chase", kind: "chase", dist: 6.4, height: 2.1, look: 1.1, fov: [0.88, 1.07] },
  { name: "Far chase", kind: "chase", dist: 9.5, height: 3.2, look: 1.0, fov: [0.84, 1.0] },
  { name: "Driver", kind: "attached", eye: "driver", fov: [1.08, 1.22], near: 0.03 },
  { name: "Bonnet", kind: "attached", pos: [0, 1.04, 1.45], view: "bonnet", fov: [0.98, 1.15] },
  { name: "Bumper", kind: "attached", pos: [0, 0.55, 2.55], view: "bumper", fov: [0.98, 1.18] },
  { name: "TV camera", kind: "tv" },
];

const tmp = new Vector3();
const tmpLook = new Vector3();

// The screen's edges blur towards the middle at speed (High graphics only:
// it is one more full-screen pass). Eight samples along the line to the centre.
Effect.ShadersStore.edgeBlurFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float strength;
void main(void) {
  vec2 d = vUV - 0.5;
  // Nothing in the middle, growing towards the edges and corners.
  float edge = smoothstep(0.22, 0.72, length(d * vec2(1.25, 1.0)));
  vec2 stepUV = -d * (strength * edge * 0.055 / 7.0);
  vec4 c = texture2D(textureSampler, vUV);
  for (int i = 1; i < 8; i++) c += texture2D(textureSampler, vUV + stepUV * float(i));
  gl_FragColor = c / 8.0;
}`;

export class EdgeBlur {
  constructor(camera) {
    this.camera = camera;
    this.strength = 0;
    // (Made attached, so it is ready by the time the game starts; it comes off
    // at the first slow frame.)
    this.pp = new PostProcess("edgeBlur", "edgeBlur", ["strength"], null, 1, camera);
    this.pp.onApply = (effect) => effect.setFloat("strength", this.strength);
    this.attached = true;
  }

  // From 100 km/h, full by 250 km/h. Below that it isn't drawn at all.
  update(speed) {
    this.strength = smoothstep(28, 70, speed);
    const want = this.strength > (this.attached ? 0.005 : 0.02);
    if (want === this.attached) return;
    this.attached = want;
    if (want) this.camera.attachPostProcess(this.pp);
    else this.camera.detachPostProcess(this.pp);
  }

  dispose() {
    this.pp.dispose(this.camera);
  }
}

export class ChaseCamera {
  constructor(scene, world, car, mode = 0) {
    this.world = world;
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
    this.footYaw = 0;
    this._first = true;
    // Driver's head: lean (car space, metres) and a glance sideways (radians).
    this.lean = { x: 0, z: 0 };
    this.look = 0;
    // Held to look behind (main.js sets it every frame).
    this.lookBack = false;
    this._lookedBack = false;
    // Shake over rough ground and at very high speed (see _rumble).
    this.rumble = 0;
    this.rough = 0;
    this.rumbleTime = 0;
    this.jolt = 0;
    this.lastVy = 0;
    this.wobX = 0;
    this.wobY = 0;
  }

  // Looking behind right now (the cockpit kit hides while the head is turned).
  get lookingBack() {
    return this.lookBack;
  }

  // In the driver's seat (the cockpit kit shows only then).
  get inDriverSeat() {
    return CAMERA_MODES[this.mode].eye === "driver";
  }

  // Which way the camera faces on the ground (for the on-foot joystick).
  get yaw() {
    const f = this.camera.getForwardRay(1).direction;
    return Math.atan2(f.x, f.z);
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
    // Looking behind cuts straight there and back, rather than swinging
    // through the car (in the driver's seat the head turns instead).
    if (this.lookBack !== this._lookedBack) {
      this._lookedBack = this.lookBack;
      if (m.eye !== "driver") this._first = true;
    }
    cam.minZ = m.near ?? 0.1;
    this._rumble(dt, v);
    if (m.kind === "attached") this._attached(m, dt, v);
    // (The roadside TV camera can't look behind: the chase camera does.)
    else if (m.kind === "tv" && !this.lookBack) this._tv(dt, v);
    else this._chase(dt, m.kind === "tv" ? CAMERA_MODES[0] : m, v);
    const fov = m.fov ?? (this.lookBack ? CAMERA_MODES[0].fov : null);
    if (fov) {
      // Wider as you go faster (most of it from 100 km/h up), and a touch
      // wider still while pulling away hard.
      const fovT = smoothstep(5, 65, v.speed);
      const kick = clamp(v.accLong, 0, 9) * 0.0025;
      cam.fov = lerp(cam.fov, lerp(fov[0], fov[1], fovT) + kick, this._first ? 1 : 1 - Math.exp(-dt * 3));
    }
    this._first = false;
  }

  // A little shake, so speed and rough ground can be felt: off the road, over
  // bumps and landings, and at very high speed. A smooth wobble rather than
  // random jumps; the views add it themselves (see wobX, wobY).
  _rumble(dt, v) {
    this.rumbleTime = (this.rumbleTime + dt) % 600;
    const jolt = Math.abs(v.vy - this.lastVy) / Math.max(dt, 1e-3);
    this.lastVy = v.vy;
    this.jolt = this._first ? 0 : Math.max(this.jolt * Math.exp(-dt * 7), clamp(jolt / 60, 0, 1));
    // (Rough ground keeps the car hopping, so the shake carries on through
    // short moments in the air and only fades on a long one.)
    if (v.grounded) this.rough = smoothstep(ROAD_HALF_WIDTH + 0.5, ROAD_HALF_WIDTH + 2, this.world.getRoadDistance(v.x, v.z)) * smoothstep(3, 16, v.speed);
    else this.rough *= Math.exp(-dt * 1.5);
    if (this._first) this.rough = 0;
    const fast = smoothstep(40, 75, v.speed);
    const want = clamp(this.rough * 0.7 + this.jolt * 0.6 + fast * 0.45, 0, 1);
    this.rumble = this._first ? want : lerp(this.rumble, want, 1 - Math.exp(-dt * 6));
    const t = this.rumbleTime;
    this.wobX = (Math.sin(t * 37.3) * 0.6 + Math.sin(t * 59.1 + 1.3) * 0.4) * this.rumble;
    this.wobY = (Math.sin(t * 43.7 + 0.7) * 0.6 + Math.sin(t * 67.9 + 2.1) * 0.4) * this.rumble;
  }

  // On foot: a little way behind and above you, turning slowly to follow.
  followPerson(dt, p) {
    const cam = this.camera;
    cam.minZ = 0.1;
    const k = this._first ? 1 : 1 - Math.exp(-dt * (p.speed > 0.2 ? 2.5 : 0.6));
    const want = p.heading;
    let d = want - this.footYaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    // Only swing round when walking forwards-ish, so walking toward the camera works.
    if (Math.abs(d) < 2.2 || this._first) this.footYaw += d * k;
    const dist = 4.4;
    const tx = p.x - Math.sin(this.footYaw) * dist;
    const tz = p.z - Math.cos(this.footYaw) * dist;
    const ty = Math.max(this.world.getHeight(tx, tz), SEA_LEVEL) + 0.6;
    const want3 = tmp.set(tx, Math.max(p.y + 2.0, ty), tz);
    if (this._first) this.pos.copyFrom(want3);
    else this.pos = Vector3.Lerp(this.pos, want3, 1 - Math.exp(-dt * 6));
    cam.position.copyFrom(this.pos);
    this.target.set(p.x, p.y + 1.45, p.z);
    cam.setTarget(this.target);
    cam.fov = lerp(cam.fov, 0.95, this._first ? 1 : 0.1);
    this._first = false;
  }

  // Fixed to the car: driver's seat, bonnet, bumper.
  _attached(m, dt, v) {
    const body = this.car.body;
    body.computeWorldMatrix(true);
    const wm = body.getWorldMatrix();
    // (Each downloaded vehicle has its own bonnet and bumper spots.)
    const own = m.view && this.car.views?.[m.view];
    let local = m.eye === "driver" ? tmp.copyFrom(this.car.eye) : own ? tmp.copyFrom(own) : tmp.set(m.pos[0], m.pos[1], m.pos[2]);
    let look = 0;
    // From a lorry's cab or a bus the back is a wall, so looking behind uses
    // the camera on the back of the vehicle instead of turning the head.
    const wall = this.lookBack && this.car.views?.seesBehind === false;
    if (m.eye === "driver" && !wall) {
      // The head moves a little: 2 to 3 cm into a turn, forward under braking
      // (back when speeding up), and a glance into the bend (up to 12 degrees)
      // when turning hard at low speed.
      const k = this._first ? 1 : 1 - Math.exp(-dt * 5);
      this.lean.x = lerp(this.lean.x, this._first ? 0 : clamp(v.accLat * 0.003, -0.03, 0.03), k);
      this.lean.z = lerp(this.lean.z, this._first ? 0 : clamp(-v.accLong * 0.0025, -0.025, 0.025), k);
      const steer = v.steerInput;
      let glance = Math.sign(steer) * smoothstep(0.35, 0.9, Math.abs(steer)) * smoothstep(9, 3, v.speed) * 0.21;
      // Looking behind: the head turns right round, over the shoulder nearer
      // the middle of the car, and leans in towards the middle.
      if (this.lookBack) glance = (local.x < 0 ? 1 : -1) * Math.PI * 0.97;
      const turning = this.lookBack || Math.abs(this.look) > 0.5;
      this.look = this._first ? 0 : lerp(this.look, glance, 1 - Math.exp(-dt * (turning ? 14 : 3)));
      const turned = smoothstep(0.5, 2.5, Math.abs(this.look));
      local.x += this.lean.x - local.x * 0.5 * turned;
      local.y += 0.04 * turned;
      local.z += this.lean.z;
      look = this.look;
    } else if (this.lookBack) {
      // Bonnet and bumper (and big vehicles' driver's seat): a camera on the
      // back of the vehicle, facing back.
      const g = this.car.geometry;
      local = this.car.views?.rear ? tmp.copyFrom(this.car.views.rear) : tmp.set(0, 0.85, (g.rear ?? g.rearZ - 0.95) - 0.2);
      look = Math.PI;
    }
    Vector3.TransformCoordinatesToRef(local, wm, this.camera.position);
    // (Rough-ground shake moves where it looks, not the eye: the cockpit stays put.)
    tmpLook.set(local.x + Math.sin(look) * 10 + this.wobX * 0.1, local.y - 0.35 + this.wobY * 0.08, local.z + Math.cos(look) * 10);
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

    // Further back and higher up for long and tall vehicles. Looking behind,
    // the same view from in front of the car, facing back.
    const size = this.car.chase ?? { dist: 1, height: 1 };
    const dist = (m.dist + clamp(speed / 50, 0, 1) * 1.2) * size.dist * (this.lookBack ? -1 : 1);
    const want = tmp.set(v.x - ux * dist, v.y + m.height * size.height, v.z - uz * dist);
    const ground = Math.max(this.world.getHeight(want.x, want.z), SEA_LEVEL) + 0.7;
    if (want.y < ground) want.y = ground;
    if (this._first) this.pos.copyFrom(want);
    else {
      const kp = 1 - Math.exp(-dt * 10);
      this.pos.x = lerp(this.pos.x, want.x, kp);
      this.pos.z = lerp(this.pos.z, want.z, kp);
      this.pos.y = lerp(this.pos.y, want.y, 1 - Math.exp(-dt * 5));
    }
    const ahead = 2.5 * size.dist * (this.lookBack ? -1 : 1);
    this.target.set(v.x + ux * ahead, v.y + m.look * size.height, v.z + uz * ahead);

    // Bumps and crashes shake the view a touch; rough ground and high speed
    // add a wobble.
    this.shake = Math.max(this.shake * Math.exp(-dt * 6), v.impact);
    const j = this.shake * 0.12;
    const w = 0.035;
    this.camera.position.set(
      this.pos.x + (Math.random() - 0.5) * j + uz * this.wobX * w,
      this.pos.y + (Math.random() - 0.5) * j + this.wobY * w,
      this.pos.z + (Math.random() - 0.5) * j - ux * this.wobX * w,
    );
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
    const world = this.world;
    const { road, index: i } = world.network.nearest(v.x, v.z);
    const n = road.count;
    // Which way along the road is the car heading?
    const t = road.tangents[i];
    const dir = t[0] * Math.sin(v.heading) + t[1] * Math.cos(v.heading) >= 0 ? 1 : -1;
    let ahead = i + dir * (35 + Math.round(Math.random() * 20));
    ahead = road.closed ? ((ahead % n) + n) % n : clamp(ahead, 0, n - 1);
    const [px, pz] = road.points[ahead];
    const [tx, tz] = road.tangents[ahead];
    const side = Math.random() < 0.5 ? -1 : 1;
    // (Beside Tower Bridge, stand clear of its towers.)
    const span = road.towerSpan;
    const off = (span && ahead > span.i0 - 6 && ahead < span.i1 + 6 ? 18 : 9) + Math.random() * 6;
    const x = px + tz * side * off;
    const z = pz - tx * side * off;
    const y = Math.max(world.getHeight(x, z), road.heights[ahead], SEA_LEVEL) + 1.6 + Math.random() * 2.5;
    return { x, y, z };
  }
}
