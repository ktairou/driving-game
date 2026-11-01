import { clamp } from "./noise.js";

const WHEEL_LOCK = 120; // degrees of on-screen wheel turn for full steering lock
const WHEEL_DEAD_PX = 18; // touches this close to the hub don't turn the wheel

// Combines keyboard (for testing on a computer) and on-screen touch controls.
export class Input {
  constructor() {
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;
    this.steerAnalog = false;
    this.keys = new Set();
    this.touch = { steer: 0, steering: false, gas: false, brake: false, hand: false };
    this.handlers = { camera: () => {}, reset: () => {} };
  }

  attachKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "KeyC") this.handlers.camera();
      if (e.code === "KeyR") this.handlers.reset();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  attachTouch({ steerZone, wheel, gas, brake, hand }) {
    // Steering wheel: the angle your thumb sweeps around the wheel's centre
    // turns it. Full lock is WHEEL_LOCK degrees either way.
    let steerId = null;
    let lastAngle = 0;
    let wheelAngle = 0;
    let cx = 0;
    let cy = 0;
    const show = () => (wheel.style.transform = `rotate(${wheelAngle}deg)`);
    const angleAt = (e) => (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
    steerZone.addEventListener("pointerdown", (e) => {
      if (steerId !== null) return;
      steerId = e.pointerId;
      steerZone.setPointerCapture(e.pointerId);
      const r = wheel.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      lastAngle = angleAt(e);
      wheel.classList.add("held");
      this.touch.steering = true;
      e.preventDefault();
    });
    steerZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== steerId) return;
      const a = angleAt(e);
      // Near the hub the angle jumps about wildly, so ignore it there.
      if (Math.hypot(e.clientX - cx, e.clientY - cy) > WHEEL_DEAD_PX) {
        let d = a - lastAngle;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        wheelAngle = clamp(wheelAngle + d, -WHEEL_LOCK, WHEEL_LOCK);
        this.touch.steer = wheelAngle / WHEEL_LOCK;
        show();
      }
      lastAngle = a;
    });
    const endSteer = (e) => {
      if (e.pointerId !== steerId) return;
      steerId = null;
      this.touch.steering = false;
      this.touch.steer = 0;
      wheelAngle = 0;
      wheel.classList.remove("held"); // springs back to centre (CSS transition)
      show();
    };
    steerZone.addEventListener("pointerup", endSteer);
    steerZone.addEventListener("pointercancel", endSteer);

    const pedal = (el, key) => {
      const ids = new Set();
      const update = () => {
        this.touch[key] = ids.size > 0;
        el.classList.toggle("pressed", ids.size > 0);
      };
      el.addEventListener("pointerdown", (e) => {
        ids.add(e.pointerId);
        el.setPointerCapture(e.pointerId);
        update();
        e.preventDefault();
      });
      const up = (e) => {
        ids.delete(e.pointerId);
        update();
      };
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
    };
    pedal(gas, "gas");
    pedal(brake, "brake");
    pedal(hand, "hand");
  }

  update() {
    const k = this.keys;
    const left = k.has("ArrowLeft") || k.has("KeyA");
    const right = k.has("ArrowRight") || k.has("KeyD");
    const keySteer = (right ? 1 : 0) - (left ? 1 : 0);
    if (this.touch.steering) {
      this.steer = this.touch.steer;
      this.steerAnalog = true;
    } else {
      this.steer = keySteer;
      this.steerAnalog = false;
    }
    this.throttle = this.touch.gas || k.has("ArrowUp") || k.has("KeyW") ? 1 : 0;
    this.brake = this.touch.brake || k.has("ArrowDown") || k.has("KeyS") ? 1 : 0;
    this.handbrake = this.touch.hand || k.has("Space");
  }
}
