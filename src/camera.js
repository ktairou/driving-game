import { FreeCamera, Vector3 } from "@babylonjs/core";
import { clamp, lerp } from "./noise.js";

const MODES = [
  { name: "Chase", dist: 6.4, height: 2.1, look: 1.1, fov: [0.88, 1.02] },
  { name: "Far chase", dist: 9.5, height: 3.2, look: 1.0, fov: [0.84, 0.96] },
  { name: "Bumper", bumper: true, fov: [0.95, 1.1] },
];

export class ChaseCamera {
  constructor(scene, hf) {
    this.hf = hf;
    this.camera = new FreeCamera("cam", new Vector3(0, 10, -10), scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 2400;
    this.camera.inputs.clear();
    this.mode = 0;
    this.pos = new Vector3();
    this.target = new Vector3();
    this.dirX = 0;
    this.dirZ = 1;
    this.shake = 0;
    this._first = true;
  }

  cycle() {
    this.mode = (this.mode + 1) % MODES.length;
    this._first = true;
    return MODES[this.mode].name;
  }

  update(dt, v) {
    const m = MODES[this.mode];
    const s = Math.sin(v.heading);
    const c = Math.cos(v.heading);
    const speed = v.speed;
    const cam = this.camera;

    if (m.bumper) {
      const fx = s;
      const fz = c;
      const nose = v.a + 1.05;
      cam.position.set(v.x + fx * nose, v.y + 0.72 - Math.tan(v.pitch) * nose, v.z + fz * nose);
      this.target.set(v.x + fx * (nose + 20), v.y + 0.6 - Math.tan(v.pitch) * (nose + 20), v.z + fz * (nose + 20));
      cam.setTarget(this.target);
    } else {
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
      const want = new Vector3(v.x - ux * dist, v.y + m.height, v.z - uz * dist);
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
      cam.position.set(this.pos.x + (Math.random() - 0.5) * j, this.pos.y + (Math.random() - 0.5) * j, this.pos.z + (Math.random() - 0.5) * j);
      cam.setTarget(this.target);
    }
    const fovT = clamp(speed / 55, 0, 1);
    cam.fov = lerp(cam.fov, lerp(m.fov[0], m.fov[1], fovT), this._first ? 1 : 1 - Math.exp(-dt * 3));
    this._first = false;
  }
}
