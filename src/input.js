import { clamp } from "./noise.js";

const STEER_RANGE_PX = 80; // finger travel for full steering lock

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

  attachTouch({ steerZone, steerBase, steerKnob, gas, brake, hand }) {
    let steerId = null;
    let originX = 0;
    const restBase = () => {
      steerBase.classList.remove("active");
      steerBase.style.transform = "";
      steerKnob.style.transform = "translate(-50%, -50%)";
    };
    steerZone.addEventListener("pointerdown", (e) => {
      if (steerId !== null) return;
      steerId = e.pointerId;
      steerZone.setPointerCapture(e.pointerId);
      originX = e.clientX;
      const br = steerBase.getBoundingClientRect();
      // Move the steering pad under the finger.
      const dx = e.clientX - (br.left + br.width / 2);
      const dy = e.clientY - (br.top + br.height / 2);
      steerBase.style.transform = `translate(${dx}px, ${dy}px)`;
      steerBase.classList.add("active");
      this.touch.steering = true;
      this.touch.steer = 0;
      e.preventDefault();
    });
    steerZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== steerId) return;
      const v = clamp((e.clientX - originX) / STEER_RANGE_PX, -1, 1);
      this.touch.steer = v;
      steerKnob.style.transform = `translate(calc(-50% + ${v * 38}px), -50%)`;
    });
    const endSteer = (e) => {
      if (e.pointerId !== steerId) return;
      steerId = null;
      this.touch.steering = false;
      this.touch.steer = 0;
      restBase();
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
