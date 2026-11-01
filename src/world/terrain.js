import { Vector2, MeshBuilder, PBRMaterial, DynamicTexture, Texture, Color3 } from "@babylonjs/core";
import { PBRCustomMaterial } from "@babylonjs/materials/custom/pbrCustomMaterial";
import { GeometryBuilder } from "../geom.js";
import { fbm, smoothstep } from "../noise.js";
import { loadTexture } from "./materials.js";
import { ROAD_HALF_WIDTH, SEA_LEVEL } from "./layout.js";

const STEP = 5; // metres between terrain vertices
const CHUNK = 64; // vertices per chunk side (so off-screen chunks are skipped)
const GRASS_TILE = 6; // metres per ground texture repeat

// Shared by every weather-aware material: x = how wet, y = how snowy (0..1).
export const weatherFx = new Vector2(0, 0);

function groundMaterial(scene, name, desert) {
  const m = new PBRCustomMaterial(name, scene);
  m.albedoTexture = loadTexture(scene, desert ? "sand_color" : "grass_color");
  m.bumpTexture = loadTexture(scene, desert ? "sand_normal" : "grass_normal", { gamma: false });
  m.bumpTexture.level = 0.8;
  m.metallicTexture = loadTexture(scene, desert ? "sand_arm" : "grass_arm", { gamma: false });
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;

  m.AddUniform("rockSampler", "sampler2D", loadTexture(scene, desert ? "sandstone_color" : "rock_color"));
  m.AddUniform("sandSampler", "sampler2D", loadTexture(scene, "sand_color"));
  m.AddUniform("weatherFx", "vec2", weatherFx);
  m.AddAttribute("terrainMask");
  m.Vertex_Definitions("attribute vec2 terrainMask;\nvarying vec2 vTerrainMask;");
  m.Vertex_MainEnd("vTerrainMask = terrainMask;");
  m.Fragment_Definitions("varying vec2 vTerrainMask;");
  m.Fragment_Custom_Albedo(`
    vec2 wp = vPositionW.xz;
    float macro = vTerrainMask.y;
    // Second, larger copy of the ground texture so it doesn't visibly repeat.
    vec3 far = toLinearSpace(texture2D(albedoSampler, wp * 0.021 + vec2(0.37, 0.71)).rgb);
    surfaceAlbedo = mix(surfaceAlbedo, far, 0.4);
    surfaceAlbedo *= mix(vec3(0.82, 0.86, 0.76), vec3(1.12, 1.07, 0.95), macro);
    // Rock on steep slopes, projected from three sides so cuttings aren't smeared.
    vec3 tw = pow(abs(vNormalW), vec3(4.0));
    tw /= (tw.x + tw.y + tw.z);
    vec3 rock = (toLinearSpace(texture2D(rockSampler, vPositionW.zy * 0.07).rgb) * tw.x
               + toLinearSpace(texture2D(rockSampler, wp * 0.07).rgb) * tw.y
               + toLinearSpace(texture2D(rockSampler, vPositionW.xy * 0.07).rgb) * tw.z) * 1.08;
    float slope = 1.0 - clamp(vNormalW.y, 0.0, 1.0);
    surfaceAlbedo = mix(surfaceAlbedo, rock, smoothstep(0.20, 0.36, slope + (macro - 0.5) * 0.12));
    // Dirt verge beside the road.
    surfaceAlbedo = mix(surfaceAlbedo, rock * vec3(0.95, 0.86, 0.72), vTerrainMask.x * 0.85);
    // Beaches near the water line.
    vec3 sand = toLinearSpace(texture2D(sandSampler, wp * 0.12).rgb) * 1.1;
    surfaceAlbedo = mix(surfaceAlbedo, sand, 1.0 - smoothstep(1.6, 3.4, vPositionW.y + (macro - 0.5) * 1.5));
    // Weather: rain darkens, snow settles on flatter ground.
    surfaceAlbedo *= mix(1.0, 0.62, weatherFx.x);
    float settle = smoothstep(0.72, 0.92, vNormalW.y) * (0.65 + 0.35 * macro);
    surfaceAlbedo = mix(surfaceAlbedo, vec3(0.86, 0.89, 0.93), weatherFx.y * settle);
  `);
  m.Fragment_Custom_MetallicRoughness("metallicRoughness.g *= mix(1.0, 0.55, weatherFx.x);");
  return m;
}

function buildIsland(scene, world, island, material) {
  const def = island.def;
  const segs = Math.round((2 * def.half) / STEP);
  const chunks = Math.ceil(segs / CHUNK);
  const out = [];
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const i0 = cx * CHUNK;
      const j0 = cz * CHUNK;
      const ni = Math.min(CHUNK, segs - i0);
      const nj = Math.min(CHUNK, segs - j0);
      const g = new GeometryBuilder();
      const mask = [];
      let above = false;
      for (let j = 0; j <= nj; j++) {
        for (let i = 0; i <= ni; i++) {
          const x = island.minX + (i0 + i) * STEP;
          const z = island.minZ + (j0 + j) * STEP;
          const d = island.getRoadDistance(x, z);
          let h = island.getHeight(x, z);
          if (h > SEA_LEVEL - 1.5) above = true;
          // Tuck the ground under the road surface so it never pokes through.
          if (d < ROAD_HALF_WIDTH + 1.5) h -= 0.35;
          g.addVertex([x, h, z], world.getNormal(x, z, STEP), [x / GRASS_TILE, z / GRASS_TILE]);
          mask.push(1 - smoothstep(ROAD_HALF_WIDTH + 0.5, ROAD_HALF_WIDTH + 4.5, d), fbm(island.noiseC, x / 140 + 5.1, z / 140 - 2.3, 3) * 0.5 + 0.5);
        }
      }
      if (!above) continue; // all under the sea
      const row = ni + 1;
      for (let j = 0; j < nj; j++) {
        for (let i = 0; i < ni; i++) {
          const a = j * row + i;
          g.addTriangle(a, a + 1, a + row + 1, [0, 1, 0]);
          g.addTriangle(a, a + row + 1, a + row, [0, 1, 0]);
        }
      }
      g.extra = { name: "terrainMask", stride: 2, data: mask };
      const mesh = g.toMesh(`terrain_${def.id}_${cx}_${cz}`, scene);
      mesh.material = material;
      mesh.receiveShadows = true;
      mesh.isPickable = false;
      mesh.freezeWorldMatrix();
      out.push(mesh);
    }
  }
  return out;
}

// Tileable ripple normal map, made from a handful of waves that wrap exactly.
function waterNormals(scene) {
  const size = 256;
  const t = new DynamicTexture("waterNormals", { width: size, height: size }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = t.getContext();
  const img = ctx.createImageData(size, size);
  const waves = [
    [3, 1, 0.5, 0.2], [1, 4, 0.35, 1.3], [5, -2, 0.25, 2.1], [-2, 7, 0.18, 0.7], [8, 3, 0.12, 2.9], [-7, -5, 0.1, 4.1], [11, -6, 0.07, 1.7],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      for (const [kx, ky, a, p] of waves) {
        const ph = 2 * Math.PI * ((kx * x) / size + (ky * y) / size) + p;
        const c = Math.cos(ph) * a;
        dx += c * kx;
        dy += c * ky;
      }
      const nx = -dx * 0.12;
      const ny = -dy * 0.12;
      const l = Math.hypot(nx, ny, 1);
      const k = (y * size + x) * 4;
      img.data[k] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[k + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[k + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  t.update(false);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.gammaSpace = false;
  return t;
}

function buildSea(scene) {
  const sea = MeshBuilder.CreateGround("sea", { width: 9000, height: 9000, subdivisions: 1 }, scene);
  sea.position.y = SEA_LEVEL;
  const m = new PBRMaterial("seaMat", scene);
  m.albedoColor = new Color3(0.015, 0.07, 0.09);
  m.metallic = 0;
  m.roughness = 0.06;
  m.bumpTexture = waterNormals(scene);
  m.bumpTexture.uScale = m.bumpTexture.vScale = 9000 / 26;
  m.bumpTexture.level = 0.45;
  sea.material = m;
  sea.isPickable = false;
  sea.freezeWorldMatrix();
  // Slow drift of the ripples.
  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000;
    m.bumpTexture.uOffset = t * 0.0021;
    m.bumpTexture.vOffset = t * 0.0013;
  });
  return sea;
}

export function buildTerrain(scene, world) {
  const green = groundMaterial(scene, "groundGreen", false);
  const desert = groundMaterial(scene, "groundDesert", true);
  const chunks = [];
  for (const island of world.islands) chunks.push(...buildIsland(scene, world, island, island.def.climate === "desert" ? desert : green));
  const sea = buildSea(scene);
  return { chunks, sea, materials: [green, desert] };
}
