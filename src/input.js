import { clamp } from "./noise.js";

const WHEEL_LOCK = 120; // degrees of on-screen wheel turn for full steering lock
const WHEEL_DEAD_PX = 18; // touches this close to the hub don't turn the wheel
const STICK_RANGE_PX = 60; // thumb travel for full speed on foot

// Combines keyboard (for testing on a computer) and on-screen touch controls.
// The lower-left pad is a steering wheel when driving and a joystick on foot.
export class Input {
  constructor() {
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = false;
    this.steerAnalog = false;
    this.footMode = false;
    this.stick = { x: 0, y: 0 };
    this.keys = new Set();
    this.touch = { steer: 0, steering: false, gas: false, brake: false, hand: false, stickX: 0, stickY: 0 };
    this.handlers = { camera: () => {}, reset: () => {}, any: () => {} };
  }

  attachKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === "KeyC") this.handlers.camera();
      if (e.code === "KeyR") this.handlers.reset();
      this.handlers.any();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  // True while a thumb is on any driving control (used to cancel self-driving).
  get touching() {
    return this.touch.steering || this.touch.gas || this.touch.brake || this.touch.hand;
  }

  attachTouch({ steerZone, wheel, stick, stickKnob, gas, brake, hand }) {
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
      const r = (this.footMode ? stick : wheel).getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      lastAngle = angleAt(e);
      wheel.classList.add("held");
      this.touch.steering = true;
      this.handlers.any();
      e.preventDefault();
    });
    steerZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== steerId) return;
      if (this.footMode) {
        // Joystick: offset from the pad centre.
        let dx = (e.clientX - cx) / STICK_RANGE_PX;
        let dy = (e.clientY - cy) / STICK_RANGE_PX;
        const m = Math.hypot(dx, dy);
        if (m > 1) {
          dx /= m;
          dy /= m;
        }
        this.touch.stickX = dx;
        this.touch.stickY = dy;
        stickKnob.style.transform = `translate(calc(-50% + ${dx * 44}px), calc(-50% + ${dy * 44}px))`;
        return;
      }
      // Steering wheel: the angle your thumb sweeps around the wheel's centre turns it.
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
      this.touch.stickX = 0;
      this.touch.stickY = 0;
      wheelAngle = 0;
      wheel.classList.remove("held"); // springs back to centre (CSS transition)
      stickKnob.style.transform = "translate(-50%, -50%)";
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
        this.handlers.any();
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
    const up = k.has("ArrowUp") || k.has("KeyW");
    const down = k.has("ArrowDown") || k.has("KeyS");
    const keySteer = (right ? 1 : 0) - (left ? 1 : 0);
    if (this.touch.steering && !this.footMode) {
      this.steer = this.touch.steer;
      this.steerAnalog = true;
    } else {
      this.steer = keySteer;
      this.steerAnalog = false;
    }
    this.throttle = this.touch.gas || up ? 1 : 0;
    this.brake = this.touch.brake || down ? 1 : 0;
    this.handbrake = this.touch.hand || k.has("Space");
    // On foot: joystick, or keys (hold Shift to run).
    if (this.touch.steering) {
      this.stick.x = this.touch.stickX;
      this.stick.y = this.touch.stickY;
    } else {
      const run = k.has("ShiftLeft") || k.has("ShiftRight") ? 1 : 0.6;
      this.stick.x = keySteer * run;
      this.stick.y = ((down ? 1 : 0) - (up ? 1 : 0)) * run;
    }
  }
}
