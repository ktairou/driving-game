import { Vector3, Matrix, ParticleSystem, DynamicTexture, Color4 } from "@babylonjs/core";
import { clamp, lerp } from "../noise.js";

// Crash damage you can see: panels dent where you hit, sparks fly when metal
// hits or scrapes, and after a big enough knock the engine starts to smoke.
// The reset button or a trip to the garage puts it all right again.

// Outside parts of your car that can be bent.
const DENTABLE = /^car_(Paint|Panel|material2|Headlight|Brakelight|Signallight|Mirror|Glass|Mechanical|License)/;
const MAX_DENT = 0.17; // no panel folds in further than this, however many hits
const NORMAL_TILT = 1.6; // exaggerates how much a dent catches the light

const hash = (x) => {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
};

function dotTexture(scene, name, stops) {
  const size = 64;
  const t = new DynamicTexture(name, { width: size, height: size }, scene, false);
  const c = t.getContext();
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, colour] of stops) g.addColorStop(at, colour);
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  t.update();
  t.hasAlpha = true;
  return t;
}

export class CarDamage {
  constructor(scene, car) {
    this.damage = 0; // 0 = like new, 1 = badly smashed
    this._sparkTimer = 0;
    this.setCar(car);

    // Sparks: short-lived bright streaks that fall with gravity.
    const sparks = new ParticleSystem("sparks", 400, scene);
    sparks.particleTexture = dotTexture(scene, "sparkDot", [[0, "rgba(255,255,255,1)"], [0.35, "rgba(255,230,180,0.9)"], [1, "rgba(255,160,60,0)"]]);
    sparks.blendMode = ParticleSystem.BLENDMODE_ADD;
    sparks.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    sparks.color1 = new Color4(1, 0.9, 0.55, 1);
    sparks.color2 = new Color4(1, 0.6, 0.2, 1);
    sparks.colorDead = new Color4(0.5, 0.12, 0, 0);
    sparks.minSize = 0.03;
    sparks.maxSize = 0.07;
    sparks.minScaleY = 3;
    sparks.maxScaleY = 6;
    sparks.minLifeTime = 0.15;
    sparks.maxLifeTime = 0.55;
    sparks.minEmitPower = 2.5;
    sparks.maxEmitPower = 8;
    sparks.gravity = new Vector3(0, -9.81, 0);
    sparks.emitRate = 0;
    sparks.manualEmitCount = 0;
    sparks.emitter = new Vector3();
    this.sparkDir = sparks.createPointEmitter(new Vector3(-1, 0.2, -1), new Vector3(1, 1.2, 1));
    sparks.start();
    this.sparks = sparks;

    // Smoke from under the bonnet once the car is badly hurt.
    const smoke = new ParticleSystem("engineSmoke", 220, scene);
    smoke.particleTexture = dotTexture(scene, "smokePuff", [[0, "rgba(255,255,255,0.8)"], [0.5, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]]);
    smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    smoke.minLifeTime = 1.2;
    smoke.maxLifeTime = 2.6;
    smoke.minSize = 0.35;
    smoke.maxSize = 0.7;
    smoke.addSizeGradient(0, 0.4, 0.6);
    smoke.addSizeGradient(1, 1.8, 2.6);
    smoke.minEmitPower = 0.5;
    smoke.maxEmitPower = 1.2;
    smoke.minAngularSpeed = -0.6;
    smoke.maxAngularSpeed = 0.6;
    smoke.gravity = new Vector3(0, 0.7, 0);
    smoke.emitRate = 0;
    smoke.emitter = new Vector3();
    smoke.createPointEmitter(new Vector3(-0.35, 1, -0.35), new Vector3(0.35, 1.6, 0.35));
    smoke.start();
    this.smoke = smoke;
  }

  // Use this car (after swapping to another one): its bendable panels, like new.
  setCar(car) {
    this.car = car;
    this.damage = 0;
    if (this.smoke) this.smoke.emitRate = 0;
    // Keep each bendable part's original shape so it can be repaired.
    const toBody = Matrix.Invert(car.body.computeWorldMatrix(true));
    this.parts = car.meshes
      .filter((m) => DENTABLE.test(m.name))
      .map((mesh) => {
        const pos = Float32Array.from(mesh.getVerticesData("position"));
        const nrm = Float32Array.from(mesh.getVerticesData("normal"));
        // Car-body space -> this part's own space.
        const toLocal = Matrix.Invert(mesh.computeWorldMatrix(true).multiply(toBody));
        const bb = mesh.getBoundingInfo().boundingBox;
        return { mesh, pos, nrm, orig: pos.slice(), origNrm: nrm.slice(), moved: new Float32Array(pos.length / 3), toLocal, min: bb.minimum.clone(), max: bb.maximum.clone(), editable: false, bent: false };
      });
  }

  // Called by the car for each real knock. `hit` is in world space plus the
  // car's own space (x right, z forward); `speed` is how fast it went in.
  hit(hit) {
    const { speed } = hit;
    if (speed > 3.5) this._spray(hit, clamp(speed * 5, 12, 140));
    if (speed < 2.5) return;
    this.damage = Math.min(1, this.damage + (speed / 24) ** 2);
    this._dent(hit.lx, 0.55, hit.lz, hit.nlx, hit.nlz, speed);
  }

  _spray(at, count) {
    this.sparks.emitter.set(at.x, at.y, at.z);
    // Mostly away from what was hit, sideways along it, and up.
    const tx = -at.nz;
    const tz = at.nx;
    this.sparkDir.direction1.set(at.nx * 0.2 - tx, 0.15, at.nz * 0.2 - tz);
    this.sparkDir.direction2.set(at.nx * 1.1 + tx, 1.3, at.nz * 1.1 + tz);
    this.sparks.manualEmitCount = Math.max(0, this.sparks.manualEmitCount) + Math.round(count);
  }

  // Pushes the panels in around (px, py, pz), along (dx, 0, dz), in car-body space.
  _dent(px, py, pz, dx, dz, speed) {
    const depth = clamp((speed - 2) * 0.011, 0, 0.11);
    const R = clamp(0.35 + speed * 0.025, 0.35, 0.85);
    const R2 = R * R;
    const p = new Vector3();
    const d = new Vector3();
    for (const part of this.parts) {
      Vector3.TransformCoordinatesFromFloatsToRef(px, py, pz, part.toLocal, p);
      Vector3.TransformNormalFromFloatsToRef(dx, 0, dz, part.toLocal, d);
      d.normalize();
      if (p.x < part.min.x - R || p.x > part.max.x + R || p.y < part.min.y - R || p.y > part.max.y + R || p.z < part.min.z - R || p.z > part.max.z + R) continue;
      const { pos, nrm, orig, moved } = part;
      let changed = false;
      for (let i = 0, v = 0; i < pos.length; i += 3, v++) {
        const ox = pos[i] - p.x;
        const oy = (pos[i + 1] - p.y) * 1.2;
        const oz = pos[i + 2] - p.z;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 >= R2) continue;
        const t = 1 - d2 / R2;
        // Metal crumples unevenly, so vary the depth a little from place to place.
        const crumple = 0.6 + 0.4 * hash(orig[i] * 7.1 + orig[i + 1] * 5.7 + orig[i + 2] * 13.3);
        const push = Math.min(depth * t * t * crumple, MAX_DENT - moved[v]);
        if (push <= 0) continue;
        moved[v] += push;
        pos[i] += d.x * push;
        pos[i + 1] += d.y * push;
        pos[i + 2] += d.z * push;
        // Tilt the surface toward the middle of the dent so it catches the light.
        const nx = nrm[i];
        const ny = nrm[i + 1];
        const nz = nrm[i + 2];
        const along = ox * nx + oy * ny + oz * nz;
        let ux = ox - along * nx;
        let uy = oy - along * ny;
        let uz = oz - along * nz;
        const ul = Math.hypot(ux, uy, uz);
        if (ul > 1e-4) {
          const slope = ((4 * depth * ul) / R2) * t * crumple * NORMAL_TILT;
          ux = nx - (ux / ul) * slope;
          uy = ny - (uy / ul) * slope;
          uz = nz - (uz / ul) * slope;
          const l = Math.hypot(ux, uy, uz) || 1;
          nrm[i] = ux / l;
          nrm[i + 1] = uy / l;
          nrm[i + 2] = uz / l;
        }
        changed = true;
      }
      if (changed) this._upload(part);
    }
  }

  _upload(part) {
    const { mesh } = part;
    if (!part.editable) {
      // First dent: make the shape editable (recreates the buffers once).
      mesh.setVerticesData("position", part.pos, true);
      mesh.setVerticesData("normal", part.nrm, true);
      part.editable = true;
    } else {
      mesh.updateVerticesData("position", part.pos);
      mesh.updateVerticesData("normal", part.nrm);
    }
    part.bent = true;
  }

  // Good as new.
  repair() {
    for (const part of this.parts) {
      if (!part.bent) continue;
      part.pos.set(part.orig);
      part.nrm.set(part.origNrm);
      part.moved.fill(0);
      this._upload(part);
      part.bent = false;
    }
    this.damage = 0;
    this.smoke.emitRate = 0;
  }

  // `night` 0..1 dims the smoke so it doesn't glow in the dark.
  update(dt, vehicle, night) {
    // Sparks keep coming while you grind along a wall.
    this._sparkTimer -= dt;
    if (vehicle.scrape > 0.08 && vehicle.scrapeAt && this._sparkTimer <= 0) {
      this._sparkTimer = 0.05;
      this._spray(vehicle.scrapeAt, 4 + vehicle.scrape * 22);
    }
    // Engine smoke, thicker the worse the damage, from just behind the bonnet.
    const heavy = clamp((this.damage - 0.4) / 0.6, 0, 1);
    this.smoke.emitRate = this.damage > 0.4 ? lerp(5, 34, heavy) : 0;
    if (this.smoke.emitRate > 0) {
      const root = this.car.root;
      const front = vehicle.a * 0.7;
      this.smoke.emitter.set(root.position.x + Math.sin(vehicle.heading) * front, root.position.y + 0.95, root.position.z + Math.cos(vehicle.heading) * front);
      const grey = lerp(0.42, 0.22, heavy) * lerp(1, 0.18, night);
      this.smoke.color1.set(grey, grey, grey, 0.55);
      this.smoke.color2.set(grey * 1.15, grey * 1.15, grey * 1.15, 0.4);
      this.smoke.colorDead.set(grey * 1.3, grey * 1.3, grey * 1.3, 0);
    }
  }
}
