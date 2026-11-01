import { PBRCustomMaterial } from "@babylonjs/materials/custom/pbrCustomMaterial";
import { GeometryBuilder } from "../geom.js";
import { fbm, smoothstep } from "../noise.js";
import { loadTexture } from "./materials.js";
import { ROAD_HALF_WIDTH, WORLD_HALF } from "./layout.js";

const SEGMENTS = 320; // 5 m between terrain vertices
const CHUNKS = 8; // split into 8 x 8 pieces so off-screen ones are skipped
const GRASS_TILE = 6; // metres per grass texture repeat

function terrainMaterial(scene) {
  const m = new PBRCustomMaterial("terrain", scene);
  m.albedoTexture = loadTexture(scene, "grass_color");
  m.bumpTexture = loadTexture(scene, "grass_normal", { gamma: false });
  m.bumpTexture.level = 0.8;
  m.metallicTexture = loadTexture(scene, "grass_arm", { gamma: false });
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;

  // Second layer for slopes, plus a large-scale colour wash so the grass
  // texture doesn't visibly repeat across the hills.
  m.AddUniform("rockSampler", "sampler2D", loadTexture(scene, "rock_color"));
  m.AddAttribute("terrainMask");
  m.Vertex_Definitions("attribute vec2 terrainMask;\nvarying vec2 vTerrainMask;");
  m.Vertex_MainEnd("vTerrainMask = terrainMask;");
  m.Fragment_Definitions("varying vec2 vTerrainMask;");
  m.Fragment_Custom_Albedo(`
    vec2 wp = vPositionW.xz;
    vec3 grassFar = toLinearSpace(texture2D(albedoSampler, wp * 0.021 + vec2(0.37, 0.71)).rgb);
    surfaceAlbedo = mix(surfaceAlbedo, grassFar, 0.4);
    float macro = vTerrainMask.y;
    surfaceAlbedo *= mix(vec3(0.80, 0.86, 0.74), vec3(1.14, 1.08, 0.94), macro);
    // Rock is projected from three sides so steep cuttings don't look smeared.
    vec3 tw = pow(abs(vNormalW), vec3(4.0));
    tw /= (tw.x + tw.y + tw.z);
    vec3 rock = (toLinearSpace(texture2D(rockSampler, vPositionW.zy * 0.07).rgb) * tw.x
               + toLinearSpace(texture2D(rockSampler, wp * 0.07).rgb) * tw.y
               + toLinearSpace(texture2D(rockSampler, vPositionW.xy * 0.07).rgb) * tw.z) * 1.08;
    float slope = 1.0 - clamp(vNormalW.y, 0.0, 1.0);
    float rockW = smoothstep(0.20, 0.36, slope + (macro - 0.5) * 0.12);
    surfaceAlbedo = mix(surfaceAlbedo, rock, rockW);
    vec3 dirt = rock * vec3(0.95, 0.86, 0.72);
    surfaceAlbedo = mix(surfaceAlbedo, dirt, vTerrainMask.x * 0.85);
  `);
  return m;
}

export function buildTerrain(scene, hf) {
  const material = terrainMaterial(scene);
  const step = (2 * WORLD_HALF) / SEGMENTS;
  const per = SEGMENTS / CHUNKS;
  const chunks = [];

  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      const g = new GeometryBuilder();
      const mask = [];
      for (let j = 0; j <= per; j++) {
        for (let i = 0; i <= per; i++) {
          const x = -WORLD_HALF + (cx * per + i) * step;
          const z = -WORLD_HALF + (cz * per + j) * step;
          const d = hf.getRoadDistance(x, z);
          let h = hf.getHeight(x, z);
          // Tuck the grass under the road surface so it never pokes through.
          if (d < ROAD_HALF_WIDTH + 1.5) h -= 0.35;
          g.addVertex([x, h, z], hf.getNormal(x, z, step), [x / GRASS_TILE, z / GRASS_TILE]);
          const shoulder = 1 - smoothstep(ROAD_HALF_WIDTH + 0.5, ROAD_HALF_WIDTH + 4.5, d);
          const macro = fbm(hf.noiseC, x / 140 + 5.1, z / 140 - 2.3, 3) * 0.5 + 0.5;
          mask.push(shoulder, macro);
        }
      }
      const row = per + 1;
      for (let j = 0; j < per; j++) {
        for (let i = 0; i < per; i++) {
          const a = j * row + i;
          const b = a + 1;
          const c = a + row;
          const d = c + 1;
          g.addTriangle(a, b, d, [0, 1, 0]);
          g.addTriangle(a, d, c, [0, 1, 0]);
        }
      }
      g.extra = { name: "terrainMask", stride: 2, data: mask };
      const mesh = g.toMesh(`terrain_${cx}_${cz}`, scene);
      mesh.material = material;
      mesh.receiveShadows = true;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
      chunks.push(mesh);
    }
  }
  return { chunks, material };
}
