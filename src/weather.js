import { Color3, Color4, Mesh, VertexData, ShaderMaterial, MeshBuilder, StandardMaterial, Vector2, Vector3, Effect } from "@babylonjs/core";
import { weatherFx } from "./world/terrain.js";
import { clamp, lerp } from "./noise.js";

// Each weather type is a set of target values; the game eases between them.
export const WEATHERS = [
  { id: "sunny", name: "Sunny", sun: 4.2, env: 0.9, fog: 0.0011, fogColor: [0.64, 0.71, 0.79], overcast: 0, wet: 0, snow: 0, rain: 0, flakes: 0, grip: 1 },
  { id: "cloudy", name: "Cloudy", sun: 1.7, env: 0.7, fog: 0.0015, fogColor: [0.6, 0.64, 0.68], overcast: 0.55, wet: 0, snow: 0, rain: 0, flakes: 0, grip: 1 },
  { id: "rain", name: "Rain", sun: 0.7, env: 0.5, fog: 0.0024, fogColor: [0.46, 0.5, 0.54], overcast: 0.88, wet: 1, snow: 0, rain: 1, flakes: 0, grip: 0.82 },
  { id: "storm", name: "Storm", sun: 0.35, env: 0.32, fog: 0.0031, fogColor: [0.28, 0.3, 0.34], overcast: 0.96, wet: 1, snow: 0, rain: 1.6, flakes: 0, grip: 0.76, lightning: true },
  { id: "snow", name: "Snow", sun: 1.1, env: 0.75, fog: 0.0028, fogColor: [0.78, 0.8, 0.84], overcast: 0.8, wet: 0.2, snow: 1, rain: 0, flakes: 1, grip: 0.62 },
  { id: "fog", name: "Fog", sun: 1.2, env: 0.65, fog: 0.011, fogColor: [0.72, 0.74, 0.76], overcast: 0.7, wet: 0.3, snow: 0, rain: 0, flakes: 0, grip: 0.95 },
];

Effect.ShadersStore.precipVertexShader = `
precision highp float;
attribute vec3 position;   // random spot inside the box (0..1)
attribute vec2 uv;         // corner of the streak / flake
uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform vec3 boxSize;
uniform float time;
uniform float fallSpeed;
uniform float sway;
uniform vec2 size;
uniform vec3 wind;
varying vec2 vUV;
varying float vFade;
void main() {
  vec3 p = position * boxSize;
  p.y -= time * fallSpeed * (0.8 + 0.4 * fract(position.x * 37.0));
  p += wind * time;
  p.x += sin(time * 1.3 + position.z * 40.0) * sway;
  p.z += cos(time * 1.1 + position.x * 40.0) * sway;
  // Wrap the box around the camera so precipitation is always nearby.
  vec3 origin = cameraPos - boxSize * 0.5;
  p = origin + mod(p - origin, boxSize);
  vec3 toCam = normalize(cameraPos - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = fallSpeed > 4.0 ? normalize(vec3(0.0, 1.0, 0.0) - wind * 0.08) : normalize(cross(toCam, right));
  vec3 world = p + right * (uv.x - 0.5) * size.x + up * (uv.y - 0.5) * size.y;
  vUV = uv;
  float d = length(p - cameraPos);
  vFade = smoothstep(boxSize.x * 0.5, boxSize.x * 0.2, d) * smoothstep(0.6, 2.0, d);
  gl_Position = viewProjection * vec4(world, 1.0);
}`;

Effect.ShadersStore.precipFragmentShader = `
precision highp float;
varying vec2 vUV;
varying float vFade;
uniform vec4 tint;
uniform float roundFlake;
void main() {
  vec2 c = vUV - 0.5;
  float a = roundFlake > 0.5 ? smoothstep(0.5, 0.15, length(c)) : (1.0 - abs(c.x) * 2.0) * smoothstep(0.5, 0.2, abs(c.y));
  a *= vFade * tint.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(tint.rgb, a);
}`;

function precipitationMesh(scene, name, count, flake) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < count; i++) {
    const p = [Math.random(), Math.random(), Math.random()];
    const base = i * 4;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      positions.push(...p);
      uvs.push(u, v);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh);
  mesh.alwaysSelectAsActiveMesh = true; // the vertex shader moves it to the camera
  mesh.isPickable = false;
  const m = new ShaderMaterial(name + "Mat", scene, "precip", {
    attributes: ["position", "uv"],
    uniforms: ["viewProjection", "cameraPos", "boxSize", "time", "fallSpeed", "sway", "size", "wind", "tint", "roundFlake"],
    needAlphaBlending: true,
  });
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.setVector3("boxSize", flake ? new Vector3(36, 22, 36) : new Vector3(40, 26, 40));
  m.setFloat("fallSpeed", flake ? 1.6 : 13);
  m.setFloat("sway", flake ? 0.6 : 0);
  m.setVector2("size", flake ? new Vector2(0.07, 0.07) : new Vector2(0.025, 0.75));
  m.setVector3("wind", flake ? new Vector3(0.6, 0, 0.3) : new Vector3(1.2, 0, 0.5));
  m.setColor4("tint", flake ? new Color4(1, 1, 1, 0.95) : new Color4(0.78, 0.82, 0.88, 0.42));
  m.setFloat("roundFlake", flake ? 1 : 0);
  mesh.material = m;
  mesh.setEnabled(false);
  return { mesh, material: m };
}

export class Weather {
  constructor(scene, sky, world, quality, materials) {
    this.scene = scene;
    this.sky = sky;
    this.world = world;
    this.materials = materials; // { asphalt: [...], leaves: [...] }
    this.index = 0;
    this.cur = { ...WEATHERS[0], fogColor: [...WEATHERS[0].fogColor] };
    this.flash = 0;
    this.nextLightning = 8;
    this.onThunder = null;
    const drops = Math.round(2600 * quality.precip);
    this.rain = precipitationMesh(scene, "rain", drops, false);
    this.snow = precipitationMesh(scene, "snow", Math.round(drops * 0.8), true);

    // A grey dome just inside the sky that thickens for overcast weather.
    this.dome = MeshBuilder.CreateSphere("cloudDome", { diameter: 1300, segments: 12, sideOrientation: Mesh.BACKSIDE }, scene);
    const dm = new StandardMaterial("cloudDomeMat", scene);
    dm.disableLighting = true;
    dm.emissiveColor = new Color3(0.6, 0.64, 0.68);
    dm.alpha = 0;
    dm.fogEnabled = false;
    dm.backFaceCulling = false;
    this.dome.material = dm;
    this.dome.infiniteDistance = true;
    this.dome.isPickable = false;
    this.dome.applyFog = false;
    this.domeMat = dm;
    this.time = 0;
  }

  set(id) {
    const i = WEATHERS.findIndex((w) => w.id === id);
    this.index = i < 0 ? 0 : i;
  }

  get target() {
    return WEATHERS[this.index];
  }

  cycle() {
    this.index = (this.index + 1) % WEATHERS.length;
    return this.target;
  }

  update(dt, camera, vehicle) {
    this.time += dt;
    const t = this.target;
    const k = 1 - Math.exp(-dt * 0.8); // about 4 s to settle
    const c = this.cur;
    for (const key of ["sun", "env", "fog", "overcast", "wet", "snow", "rain", "flakes", "grip"]) c[key] = lerp(c[key], t[key], k);
    for (let i = 0; i < 3; i++) c.fogColor[i] = lerp(c.fogColor[i], t.fogColor[i], k);

    // Lightning in storms: a flash now, thunder a moment later.
    if (t.lightning) {
      this.nextLightning -= dt;
      if (this.nextLightning <= 0) {
        this.flash = 1;
        this.nextLightning = 6 + Math.random() * 12;
        const delay = 0.5 + Math.random() * 2.5;
        setTimeout(() => this.onThunder?.(delay), delay * 1000);
      }
    }
    this.flash = Math.max(0, this.flash - dt * 5);
    const flash = this.flash > 0.5 ? 1 : this.flash * 0.6;

    const { light } = this.sky;
    light.intensity = c.sun + flash * 3;
    this.scene.environmentIntensity = c.env + flash * 1.5;
    this.scene.fogDensity = c.fog;
    this.scene.fogColor.set(c.fogColor[0], c.fogColor[1], c.fogColor[2]);
    this.domeMat.alpha = clamp(c.overcast, 0, 0.97);
    this.domeMat.emissiveColor.set(c.fogColor[0] * (1 + flash), c.fogColor[1] * (1 + flash), c.fogColor[2] * (1 + flash));
    this.dome.setEnabled(c.overcast > 0.01);

    weatherFx.x = c.wet;
    weatherFx.y = c.snow;
    for (const m of this.materials.asphalt) {
      m.roughness = lerp(1, 0.32, c.wet);
      const s = lerp(lerp(1, 0.62, c.wet), 1.7, c.snow * 0.6);
      m.albedoColor.set(s * m._baseTint.r, s * m._baseTint.g, s * m._baseTint.b);
    }
    for (const m of this.materials.leaves) {
      const s = lerp(1, 1.6, c.snow * 0.5);
      m.albedoColor.set(s, s, s);
    }
    if (vehicle) vehicle.gripScale = c.grip;

    for (const [p, amount] of [[this.rain, c.rain], [this.snow, c.flakes]]) {
      const on = amount > 0.03;
      p.mesh.setEnabled(on);
      if (!on) continue;
      p.material.setVector3("cameraPos", camera.globalPosition);
      p.material.setFloat("time", this.time);
      const tint = p === this.rain ? new Color4(0.78, 0.82, 0.88, 0.42 * Math.min(1, amount)) : new Color4(1, 1, 1, 0.95 * amount);
      p.material.setColor4("tint", tint);
      if (p === this.rain) p.material.setFloat("fallSpeed", 13 + amount * 4);
    }
  }
}
