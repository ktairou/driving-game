import { Quaternion } from "@babylonjs/core";
import { clamp, lerp } from "../noise.js";
import { WHEEL_RADIUS } from "./carModel.js";
import { WORLD_LIMIT, SEA_LEVEL } from "../world/layout.js";

const G = 9.81;
const STEP = 1 / 120;

// Arcade-leaning car physics: a "bicycle model" with tyre slip for the flat
// movement, and the ground height under the four wheels for the up/down part.
export class Vehicle {
  constructor(car, world, colliders, spec = {}) {
    this.world = world;
    this.colliders = colliders;
    this.gripScale = 1; // weather: lower on wet or snowy roads
    this.inWater = false;
    this.rpm = 900;
    this.gear = 1;
    this.slip = 0; // how hard the tyres are sliding, for the squeal sound
    this.dynamic = []; // moving things to bump into, refreshed every frame
    this.onBump = null;
    this.setCar(car, spec);

    this.x = 0;
    this.z = 0;
    this.y = 0;
    this.heading = 0;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.grounded = true;
    this.pitch = 0;
    this.roll = 0;
    this.bodyPitch = 0;
    this.bodyPitchVel = 0;
    this.bodyRoll = 0;
    this.bodyRollVel = 0;
    this.wheelSpin = 0;
    this.accLong = 0;
    this.accLat = 0;
    this.impact = 0;
    this._acc = 0;
    this.speed = 0;
    this.forwardSpeed = 0;
  }

  // Swap in a (possibly different) car model and its handling numbers.
  setCar(car, spec = {}) {
    this.car = car;
    const g = car.geometry;
    this.a = g.frontZ; // CG to front axle
    this.b = -g.rearZ; // CG to rear axle
    this.L = this.a + this.b;
    this.halfTrack = g.halfTrack;
    this.mass = spec.mass ?? 1350;
    this.inertia = this.mass * 1.7;
    this.cgHeight = 0.5;
    this.power = spec.power ?? 300000; // W
    this.maxDrive = spec.maxDrive ?? 10500; // N
    this.brakeForce = 15000 * (this.mass / 1350);
    this.reverseForce = 4200 * (this.mass / 1350);
    this.drag = spec.drag ?? 0.42;
    this.rolling = 32;
    this.corneringFront = 95000 * (this.mass / 1350);
    this.corneringRear = 102000 * (this.mass / 1350);
    this.baseGrip = spec.grip ?? 1.15;
    this.redline = spec.redline ?? 7800;
    this.gears = spec.gears ?? [3.2, 2.2, 1.65, 1.3, 1.05, 0.86];
  }

  get grip() {
    return this.baseGrip * this.gripScale;
  }

  place(x, z, heading) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.vx = this.vz = this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.y = this.world.getHeight(x, z);
    this.grounded = true;
    this._updateTilt(true);
    this.sync();
  }

  _wheelPoints() {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    const pts = [];
    for (const [lz, lx] of [[this.a, -this.halfTrack], [this.a, this.halfTrack], [-this.b, -this.halfTrack], [-this.b, this.halfTrack]]) {
      // forward = (s, c), right = (c, -s)
      const x = this.x + s * lz + c * lx;
      const z = this.z + c * lz - s * lx;
      pts.push(this.world.getHeight(x, z));
    }
    return pts; // FL, FR, RL, RR
  }

  _updateTilt(snap) {
    const [fl, fr, rl, rr] = this._wheelPoints();
    const front = (fl + fr) / 2;
    const rear = (rl + rr) / 2;
    const left = (fl + rl) / 2;
    const right = (fr + rr) / 2;
    let pitch = Math.atan2(rear - front, this.L);
    let roll = Math.atan2(right - left, this.halfTrack * 2);
    let k = snap ? 1 : 0.35;
    if (!this.grounded && !snap) {
      // In the air: nose follows the flight path gently, no snapping to the ground.
      pitch = clamp(-Math.atan2(this.vy, Math.max(this.speed, 1)) * 0.6, -0.45, 0.45);
      roll = 0;
      k = 0.03;
    }
    this.pitch = lerp(this.pitch, pitch, k);
    this.roll = lerp(this.roll, roll, k);
    this.groundUnderCar = (fl + fr + rl + rr) / 4;
    this.wheelGround = [fl, fr, rl, rr];
  }

  update(dt, input) {
    this._acc += Math.min(dt, 0.1);
    this.impact = Math.max(0, this.impact - dt * 2);
    while (this._acc >= STEP) {
      this._step(STEP, input);
      this._acc -= STEP;
    }
    this.sync();
  }

  _step(dt, input) {
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    // forward = (s, c), right = (c, -s)
    let vLong = this.vx * s + this.vz * c;
    let vLat = this.vx * c - this.vz * s;
    const speed = Math.hypot(this.vx, this.vz);

    // --- Steering: quick to turn in, quicker to centre, less lock at speed ---
    const maxSteer = lerp(0.6, 0.11, clamp(speed / 50, 0, 1));
    const target = input.steer * maxSteer;
    const rate = (Math.abs(target) < Math.abs(this.steer) ? 4.5 : 2.6) * (input.steerAnalog ? 2 : 1);
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);

    // --- Engine, brakes, reverse ----------------------------------------------
    let drive = 0;
    let brake = 0;
    const throttle = input.throttle;
    const pedalBrake = input.brake;
    if (throttle > 0) {
      if (vLong > -0.8) drive = throttle * Math.min(this.maxDrive, this.power / Math.max(Math.abs(vLong), 1));
      else brake += throttle;
    }
    if (pedalBrake > 0) {
      if (vLong > 0.8) brake += pedalBrake;
      else if (vLong > -8) drive -= pedalBrake * this.reverseForce; // reverse tops out near 18 mph
    }
    const handbrake = input.handbrake;

    let fLong = drive;
    if (this.grounded) {
      const brakeF = clamp(brake, 0, 1) * this.brakeForce + (handbrake ? 5500 : 0);
      // Brakes stop the car, they never push it backwards.
      const maxStop = (Math.abs(vLong) * this.mass) / dt;
      fLong -= Math.sign(vLong) * Math.min(brakeF, maxStop);
      fLong -= this.drag * vLong * Math.abs(vLong) + this.rolling * vLong;
    } else {
      fLong = 0;
    }

    // --- Tyres ----------------------------------------------------------------------
    let fLat = 0;
    let torque = 0;
    let slipAmount = 0;
    if (this.grounded) {
      const weight = this.mass * G;
      const transfer = (this.cgHeight / this.L) * this.mass * this.accLong;
      const nf = Math.max(0, (weight * this.b) / this.L - transfer);
      const nr = Math.max(0, (weight * this.a) / this.L + transfer);
      const dir = vLong >= 0 ? 1 : -1;
      const vAbs = Math.max(Math.abs(vLong), 0.5);
      const slipF = Math.atan2(vLat + this.yawRate * this.a, vAbs) - this.steer * dir;
      const slipR = Math.atan2(vLat - this.yawRate * this.b, vAbs);
      const rearGrip = this.grip * (handbrake ? 0.42 : 1) * (1 - 0.12 * throttle * clamp(1 - speed / 25, 0, 1));
      const fyF = clamp(-this.corneringFront * slipF, -this.grip * nf, this.grip * nf);
      const fyR = clamp(-this.corneringRear * slipR, -rearGrip * nr, rearGrip * nr);
      fLat = fyF * Math.cos(this.steer) + fyR;
      fLong += -fyF * Math.sin(this.steer);
      torque = this.a * fyF * Math.cos(this.steer) - this.b * fyR;
      slipAmount = speed > 3 ? Math.max(Math.abs(slipF), Math.abs(slipR)) + (handbrake ? 0.15 : 0) + (brake > 0 && speed > 12 ? 0.05 : 0) : 0;
    }
    this.slip = lerp(this.slip, slipAmount, 0.2);

    // Slow speeds: the slip model gets twitchy, so steer "on rails" instead.
    const lowSpeed = clamp(1 - speed / 5, 0, 1);

    const aLong = fLong / this.mass;
    const aLat = fLat / this.mass;
    this.accLong = lerp(this.accLong, aLong, 0.1);
    this.accLat = lerp(this.accLat, aLat, 0.1);
    vLong += aLong * dt;
    vLat += aLat * dt;
    if (this.grounded) {
      this.yawRate += (torque / this.inertia) * dt;
      const kinematic = (vLong * Math.tan(this.steer)) / this.L;
      this.yawRate = lerp(this.yawRate, kinematic, lowSpeed * 0.5);
      vLat *= 1 - lowSpeed * 0.3;
      this.yawRate *= 1 - 0.6 * dt; // a little yaw damping keeps it friendly
    } else {
      this.yawRate *= 1 - 0.8 * dt;
    }
    if (Math.abs(vLong) < 0.05 && throttle === 0 && pedalBrake === 0) vLong = 0;

    this.heading += this.yawRate * dt;
    const s2 = Math.sin(this.heading);
    const c2 = Math.cos(this.heading);
    this.vx = s2 * vLong + c2 * vLat;
    this.vz = c2 * vLong - s2 * vLat;

    // Gravity pulls you down hills (but a stopped car stays parked).
    if (this.grounded && !(throttle === 0 && pedalBrake === 0 && speed < 1.5)) {
      const n = this.world.getNormal(this.x, this.z, 1.5);
      this.vx += n[0] * G * n[1] * dt;
      this.vz += n[2] * G * n[1] * dt;
    }

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Cliffs and steep cuttings act like walls.
    if (this.grounded) {
      const n = this.world.getNormal(this.x, this.z, 1.5);
      if (n[1] < 0.66) {
        const h = Math.hypot(n[0], n[2]) || 1;
        const ox = n[0] / h;
        const oz = n[2] / h; // points downhill, away from the wall
        const into = this.vx * ox + this.vz * oz;
        if (into < 0) {
          this.vx -= ox * into * 1.2;
          this.vz -= oz * into * 1.2;
          this.x -= ox * into * dt;
          this.z -= oz * into * dt;
          this.impact = Math.max(this.impact, clamp(-into / 20, 0, 0.6));
        }
      }
    }

    this._collide();

    // --- Up and down ---------------------------------------------------------------
    this._updateTilt(false);
    const ground = this.groundUnderCar;
    if (this.grounded) {
      const predicted = this.y + this.vy * dt - G * dt * dt;
      if (ground < predicted - 0.03 && speed > 8) {
        this.grounded = false; // crest at speed: take off
        this.vy += -G * dt;
        this.y = predicted;
      } else {
        // Vertical speed from following the ground, capped so a sudden step in
        // the terrain can't store up a huge launch for the next crest.
        const newVy = clamp((ground - this.y) / dt, -15, 10);
        this.vy = lerp(this.vy, newVy, 0.5);
        this.y = ground;
      }
    } else {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      if (this.y <= ground) {
        const hit = Math.max(0, -this.vy);
        this.y = ground;
        this.vy = 0;
        this.grounded = true;
        this.bodyPitchVel += hit * 0.04;
        this.impact = Math.max(this.impact, clamp(hit / 12, 0, 1));
      }
    }

    // Fell off a bridge or drove into the sea.
    this.inWater = this.y < SEA_LEVEL - 0.7 && ground < SEA_LEVEL;
    if (this.inWater) {
      this.vx *= 0.96;
      this.vz *= 0.96;
    }

    // --- Engine revs (for the sound): a simple automatic gearbox -------------
    const wheelRpm = (Math.abs(vLong) / WHEEL_RADIUS) * 9.549;
    const finalDrive = 3.4;
    let geared = wheelRpm * this.gears[this.gear - 1] * finalDrive;
    if (geared > this.redline * 0.9 && this.gear < this.gears.length) this.gear++;
    else if (this.gear > 1 && wheelRpm * this.gears[this.gear - 2] * finalDrive < this.redline * 0.62) this.gear--;
    geared = wheelRpm * this.gears[this.gear - 1] * finalDrive;
    const free = 900 + throttle * (this.grounded ? 1400 : 4000); // revs when slow / in the air
    this.rpm = lerp(this.rpm, clamp(Math.max(geared, free), 800, this.redline), 0.12);
    this.throttle = throttle;

    // --- Body lean (springy) ------------------------------------------------------
    const pitchTarget = clamp(-this.accLong * 0.006, -0.06, 0.06);
    const rollTarget = clamp(this.accLat * 0.006, -0.07, 0.07);
    this.bodyPitchVel += ((pitchTarget - this.bodyPitch) * 120 - this.bodyPitchVel * 12) * dt;
    this.bodyPitch += this.bodyPitchVel * dt;
    this.bodyRollVel += ((rollTarget - this.bodyRoll) * 110 - this.bodyRollVel * 11) * dt;
    this.bodyRoll += this.bodyRollVel * dt;

    this.wheelSpin += (vLong / WHEEL_RADIUS) * dt;
    this.speed = speed;
    this.forwardSpeed = vLong;
  }

  _collide() {
    // Edge of the world.
    const lim = WORLD_LIMIT;
    if (Math.abs(this.x) > lim) {
      this.x = Math.sign(this.x) * lim;
      this.vx *= -0.3;
    }
    if (Math.abs(this.z) > lim) {
      this.z = Math.sign(this.z) * lim;
      this.vz *= -0.3;
    }
    // Three circles along the car's length.
    const s = Math.sin(this.heading);
    const c = Math.cos(this.heading);
    const radius = this.halfTrack * 0.98;
    for (const off of [this.a - 0.15, 0, -this.b + 0.1]) {
      const cx = this.x + s * off;
      const cz = this.z + c * off;
      let hit = this.colliders.resolveCircle(cx, cz, radius);
      // Moving things: other cars and people.
      for (const o of this.dynamic) {
        const hx = hit ? hit.x : cx;
        const hz = hit ? hit.z : cz;
        const dx = hx - o.x;
        const dz = hz - o.z;
        const d = Math.hypot(dx, dz);
        const min = radius + o.r;
        if (d < min && d > 1e-4) {
          const depth = min - d;
          hit = { x: hx + (dx / d) * depth, z: hz + (dz / d) * depth, nx: dx / d, nz: dz / d, depth };
          this.onBump?.(o, Math.hypot(this.vx, this.vz));
        }
      }
      if (!hit) continue;
      this.x += hit.x - cx;
      this.z += hit.z - cz;
      const vn = this.vx * hit.nx + this.vz * hit.nz;
      if (vn < 0) {
        this.vx -= hit.nx * vn * 1.25;
        this.vz -= hit.nz * vn * 1.25;
        this.vx *= 0.9;
        this.vz *= 0.9;
        this.yawRate *= 0.6;
        // Glancing hits on the nose or tail twist the car a little.
        this.yawRate += clamp(-vn * 0.02 * Math.sign(off) * (hit.nx * c - hit.nz * s), -0.6, 0.6);
        this.impact = Math.max(this.impact, clamp(-vn / 15, 0, 1));
      }
    }
  }

  sync() {
    const { root, body, wheels, steeringPivot, steeringAxis } = this.car;
    root.position.set(this.x, this.y, this.z);
    root.rotation.set(this.pitch, this.heading, this.roll);
    body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    // Cabin steering wheel turns 4.5x the front wheels' angle.
    if (steeringPivot) Quaternion.RotationAxisToRef(steeringAxis, this.steer * 4.5, steeringPivot.rotationQuaternion);
    // Wheels: steer the fronts, spin all, and let each follow the ground a bit.
    const planeAt = (lz, lx) => this.y - Math.tan(this.pitch) * lz + Math.tan(this.roll) * lx;
    wheels.forEach((w, i) => {
      w.steer.rotation.y = w.front ? this.steer : 0;
      w.spin.rotation.x = this.wheelSpin;
      const groundAt = this.wheelGround ? this.wheelGround[i] : this.y;
      const target = this.grounded ? clamp(groundAt - planeAt(w.rest.z, w.rest.x), -0.1, 0.1) : -0.08;
      w.offset = lerp(w.offset, target, 0.3);
      w.steer.position.y = w.rest.y + w.offset;
    });
  }
}
