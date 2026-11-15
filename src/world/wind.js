import { MaterialPluginBase } from "@babylonjs/core";

// The wind that plants sway in. `strength` follows the weather (weather.js
// sets it: about 0.1 in fog, 0.35 on a sunny day, 1.3 in a storm); `time` just
// runs on (main.js moves it every frame).
export const wind = { time: 0, strength: 0.35 };

export function updateWind(dt) {
  wind.time = (wind.time + dt) % 3600;
}

// Bends a material's geometry in the wind, all in one world direction, so a
// field of randomly turned plants sways together. The bend grows with height
// above the mesh's own origin (or, with `radial`, with distance out from it,
// for things that hang off a centre such as palm fronds): `bend` metres at
// `reach` metres up (and above), at strength 1. Each plant's timing comes from where it
// stands. Works on plain meshes and thin instances alike, so the trees can use
// it as they are.
//
// (The shadow pass draws without it: shadows of swaying parts don't move.)
export class WindSway extends MaterialPluginBase {
  constructor(material, { reach = 1, bend = 0.1, radial = false } = {}) {
    super(material, "WindSway", 210, { WINDSWAY: false });
    this.reach = reach;
    this.bend = bend;
    this.radial = radial;
    this._enable(true);
  }

  getClassName() {
    return "WindSway";
  }

  prepareDefines(defines) {
    defines.WINDSWAY = true;
  }

  getUniforms() {
    return {
      ubo: [{ name: "windSway", size: 4, type: "vec4" }],
      vertex: `#ifdef WINDSWAY
        uniform vec4 windSway;
      #endif`,
    };
  }

  bindForSubMesh(ubo) {
    ubo.updateFloat4("windSway", wind.time, wind.strength * this.bend, 1 / this.reach, this.radial ? 1 : 0);
  }

  getCustomCode(shaderType) {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_UPDATE_WORLDPOS: `
        #ifdef WINDSWAY
          // 0 at the base, 1 at reach and above; squared so the base stays put.
          float windK = mix(max(positionUpdated.y, 0.0), length(positionUpdated.xz), windSway.w) * windSway.z;
          windK = min(windK * windK, 1.0);
          vec2 windAt = finalWorld[3].xz;
          // A slow lean with the gusts, plus a quicker flutter on top.
          float windGust = 0.65 + 0.35 * sin(windSway.x * 0.45 + dot(windAt, vec2(0.012, 0.009)));
          float windWave = sin(windSway.x * 1.9 + dot(windAt, vec2(0.31, 0.23)) + positionUpdated.y * 0.6) * 0.5
                         + sin(windSway.x * 4.3 + dot(windAt, vec2(-0.19, 0.27)) + positionUpdated.x) * 0.15;
          worldPos.xz += vec2(0.83, 0.55) * (windSway.y * windK * (windGust + windWave));
          vPositionW = vec3(worldPos);
        #endif
      `,
    };
  }
}
