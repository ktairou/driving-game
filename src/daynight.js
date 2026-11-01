import { HDRCubeTexture, Vector3 } from "@babylonjs/core";
import { clamp, lerp } from "./noise.js";

// One game day lasts this many real seconds (24 minutes: an hour a minute).
const DAY_SECONDS = 24 * 60;

// The look of the world through a day. Values blend between neighbouring keys.
//   sky: which sky photo; sun/env: light strengths; exposure: camera brightness;
//   fog: haze colour; tint: sunlight colour; night: 0 = day, 1 = street lights on.
const KEYS = [
  { h: 0, sky: "night", sun: 0.6, env: 2.8, exposure: 1.7, fog: [0.07, 0.09, 0.14], tint: [0.6, 0.7, 1], night: 1 },
  { h: 4.9, sky: "night", sun: 0.6, env: 2.8, exposure: 1.7, fog: [0.07, 0.09, 0.14], tint: [0.6, 0.7, 1], night: 1 },
  { h: 5.9, sky: "sunset", sun: 1.3, env: 0.8, exposure: 1.3, fog: [0.46, 0.42, 0.45], tint: [1, 0.62, 0.4], night: 0.55 },
  { h: 7.2, sky: "day", sun: 3.6, env: 0.85, exposure: 1.05, fog: [0.62, 0.69, 0.77], tint: [1, 0.95, 0.9], night: 0 },
  { h: 8, sky: "day", sun: 4.2, env: 0.9, exposure: 1.05, fog: [0.64, 0.71, 0.79], tint: [1, 0.975, 0.945], night: 0 },
  { h: 17.5, sky: "day", sun: 4.2, env: 0.9, exposure: 1.05, fog: [0.64, 0.71, 0.79], tint: [1, 0.975, 0.945], night: 0 },
  { h: 18.6, sky: "day", sun: 3.1, env: 0.82, exposure: 1.08, fog: [0.66, 0.65, 0.66], tint: [1, 0.85, 0.7], night: 0 },
  { h: 19.4, sky: "sunset", sun: 2.0, env: 0.85, exposure: 1.2, fog: [0.62, 0.5, 0.42], tint: [1, 0.6, 0.35], night: 0.35 },
  { h: 20.4, sky: "night", sun: 0.6, env: 2.8, exposure: 1.7, fog: [0.07, 0.09, 0.14], tint: [0.6, 0.7, 1], night: 1 },
  { h: 24, sky: "night", sun: 0.6, env: 2.8, exposure: 1.7, fog: [0.07, 0.09, 0.14], tint: [0.6, 0.7, 1], night: 1 },
];

export const TIME_PRESETS = [
  { id: "day", name: "Day", hour: 12 },
  { id: "sunset", name: "Sunset", hour: 19.3 },
  { id: "night", name: "Night", hour: 23 },
];

// The sky photos are all saved at a similar brightness, but real dusk and
// night are much darker. These scale each photo (the day one is the reference).
const SKY_GAIN = { day: 1, sunset: 0.33, night: 0.045 };
// The sky itself is shown a little brighter than the light it gives, so the
// stars and the Milky Way still show up at night.
const SKY_SHOW = { day: 1, sunset: 0.4, night: 0.16 };

// Moonlight comes from high in the south-west.
const MOON = new Vector3(0.35, 0.78, -0.52).normalize();

export class DayNight {
  constructor(scene, sky, pipeline, weather, hour = 10) {
    this.scene = scene;
    this.sky = sky;
    this.pipeline = pipeline;
    this.weather = weather;
    this.hour = hour;
    this.night = 0;
    this.skies = { day: { tex: sky.env, box: sky.skybox, sun: sky.toSun.clone(), gain: 1 } };
    sky.skybox.alphaIndex = 0;
    this._dir = new Vector3();
    this._loadMore();
  }

  // The sunset and night skies load in the background so the game starts sooner.
  async _loadMore() {
    for (const name of ["sunset", "night"]) {
      try {
        const sun = await (await fetch(`assets/sky/sun_${name}.json`)).json();
        const tex = await new Promise((resolve, reject) => {
          const t = new HDRCubeTexture(`assets/sky/sky_${name}_2k.hdr`, this.scene, 512, false, true, false, true, () => resolve(t), (m) => reject(new Error(m)));
        });
        const box = this.scene.createDefaultSkybox(tex, true, 1500, 0, false);
        box.name = `sky_${name}`;
        box.applyFog = false;
        box.infiniteDistance = true;
        box.isPickable = false;
        box.setEnabled(false);
        const dir = name === "night" ? MOON.clone() : new Vector3(...sun.direction).normalize();
        box.material.environmentIntensity = SKY_SHOW[name];
        this.skies[name] = { tex, box, sun: dir, gain: SKY_GAIN[name] };
      } catch (err) {
        console.warn("couldn't load sky", name, err);
      }
    }
  }

  jumpTo(id) {
    const p = TIME_PRESETS.find((t) => t.id === id);
    if (p) this.hour = p.hour;
  }

  // Which preset we're closest to, for the time button.
  get phase() {
    const h = this.hour;
    if (h >= 6 && h < 18.4) return "day";
    if (h >= 18.4 && h < 20.2) return "sunset";
    return "night";
  }

  get clock() {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  update(dt) {
    this.hour = (this.hour + (dt * 24) / DAY_SECONDS) % 24;
    let i = 0;
    while (i + 1 < KEYS.length && KEYS[i + 1].h <= this.hour) i++;
    const A = KEYS[i];
    const B = KEYS[Math.min(i + 1, KEYS.length - 1)];
    const t = B.h > A.h ? clamp((this.hour - A.h) / (B.h - A.h), 0, 1) : 0;
    const mix = (k) => lerp(A[k], B[k], t);
    const mix3 = (k) => [0, 1, 2].map((n) => lerp(A[k][n], B[k][n], t));

    // Sky: the earlier sky stays solid, the next one fades in over it.
    const skyA = this.skies[A.sky] ?? this.skies.day;
    const skyB = this.skies[B.sky] ?? skyA;
    for (const s of Object.values(this.skies)) if (s !== skyA && s !== skyB) s.box.setEnabled(false);
    skyA.box.setEnabled(true);
    skyA.box.visibility = 1;
    skyA.box.alphaIndex = 0;
    if (skyB !== skyA) {
      skyB.box.setEnabled(true);
      skyB.box.visibility = t;
      skyB.box.alphaIndex = 1;
    }
    const lighting = t < 0.5 ? skyA : skyB;
    if (this.scene.environmentTexture !== lighting.tex) this.scene.environmentTexture = lighting.tex;

    // Sun (or moon) direction and strength, combined with the weather.
    Vector3.LerpToRef(skyA.sun, skyB.sun, t, this._dir);
    this._dir.normalize();
    const w = this.weather.effect;
    const { light } = this.sky;
    light.direction.copyFrom(this._dir).scaleInPlace(-1);
    light.intensity = mix("sun") * w.sun + w.flash * 3;
    const tint = mix3("tint");
    light.diffuse.set(tint[0], tint[1], tint[2]);
    const gain = t < 0.5 ? skyA.gain : skyB.gain;
    this.scene.environmentIntensity = mix("env") * gain * w.env + w.flash * 1.5;
    const fog = mix3("fog").map((v, n) => v * w.fogTint[n]);
    this.scene.fogDensity = w.fogDensity;
    this.scene.fogColor.set(fog[0], fog[1], fog[2]);
    this.weather.domeMat.emissiveColor.set(fog[0] * (1 + w.flash), fog[1] * (1 + w.flash), fog[2] * (1 + w.flash));
    this.pipeline.imageProcessing.exposure = mix("exposure");
    this.night = mix("night");
  }
}
