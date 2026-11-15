import { Vector2, Vector4, Matrix, MeshBuilder, DynamicTexture, RawTexture, Engine, Texture, Color3, VertexBuffer } from "@babylonjs/core";
import { PBRCustomMaterial } from "@babylonjs/materials/custom/pbrCustomMaterial";
import { GeometryBuilder } from "../geom.js";
import { fbm, smoothstep, clamp } from "../noise.js";
import { loadTexture } from "./materials.js";
import { forestDensity } from "./nature.js";
import { ROAD_HALF_WIDTH, SEA_LEVEL } from "./layout.js";

const STEP = 6; // metres between terrain vertices
const CHUNK = 64; // vertices per chunk side (so off-screen chunks are skipped)
const GRASS_TILE = 6; // metres per ground texture repeat

// Shared by every weather-aware material: x = how wet, y = how snowy (0..1).
export const weatherFx = new Vector2(0, 0);

// Shader helpers for the farmland patchwork.
const FIELD_GLSL = `
  // A small hash with no sin(), so it comes out the same on every GPU.
  vec2 fieldHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.xx + q.yz) * q.zy);
  }
  // The field (a cell of a jittered grid) a point is in: xy = its id, z = how
  // far the point is from the border with the next field, in cell widths
  // (about twice the real distance; small means on the hedge).
  vec3 fieldCell(vec2 p) {
    vec2 base = floor(p);
    vec2 f = p - base;
    float d1 = 8.0;
    float d2 = 8.0;
    vec2 id = base;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = g + 0.15 + 0.7 * fieldHash(base + g) - f;
        float d = dot(o, o);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = base + g;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return vec3(id, sqrt(d2) - sqrt(d1));
  }
`;

// Rock projected from three sides, so cuttings and crags aren't smeared.
const ROCK_GLSL = `
    vec3 tw = pow(abs(vNormalW), vec3(4.0));
    tw /= (tw.x + tw.y + tw.z);
    vec3 rock = (toLinearSpace(texture2D(rockSampler, vPositionW.zy * 0.07).rgb) * tw.x
               + toLinearSpace(texture2D(rockSampler, wp * 0.07).rgb) * tw.y
               + toLinearSpace(texture2D(rockSampler, vPositionW.xy * 0.07).rgb) * tw.z) * 1.08;
`;

// Countryside (Britain, France, the USA). vTerrainMask: x = road verge,
// y = macro (slow colour drift), z = forest density, w = farmland.
const GREEN_ALBEDO = `
    float slope = 1.0 - clamp(vNormalW.y, 0.0, 1.0);
    // The texture's own light and dark, about 1 on average, for the flat colours below.
    float grain = dot(surfaceAlbedo, vec3(0.3, 0.59, 0.11)) / 0.075;
    float h = vPositionW.y + (macro - 0.5) * 12.0;
    // Height bands: lush green low down, drier yellow-green higher up.
    surfaceAlbedo *= mix(vec3(0.84, 1.08, 0.74), vec3(1.2, 1.05, 0.62), smoothstep(14.0, 34.0, h));
    // Broad colour drift, wider far away so distant hills aren't one flat green.
    float drift = (macro - 0.5) * (1.2 + 0.8 * smoothstep(150.0, 900.0, camDist));
    surfaceAlbedo *= vec3(1.0 + drift * 0.4, 1.0 + drift * 0.22, 0.92 + drift * 0.04);
    // Fields on the flat lower ground: a patchwork of crops in cells about
    // 150 m across (warped a little so the borders aren't straight), with a
    // dark hedge along each border.
    float farm = vTerrainMask.w * (1.0 - smoothstep(0.05, 0.12, slope)) * (1.0 - smoothstep(28.0, 38.0, h));
    if (farm > 0.01) {
      vec3 cell = fieldCell(wp / 150.0 + (vec2(macro, vTerrainMask.z) - 0.5) * 0.3);
      vec2 pick = fieldHash(cell.xy + 17.0);
      vec3 tone = vec3(0.075, 0.115, 0.03); // fresh green
      if (pick.y > 0.22) tone = vec3(0.3, 0.215, 0.07); // wheat
      if (pick.y > 0.5) {
        // Ploughed earth, in furrows that fade out before they'd shimmer.
        float ph = dot(wp, vec2(cos(pick.x * 6.283), sin(pick.x * 6.283))) / 1.2;
        float furrow = (0.5 + 0.5 * sin(ph * 6.283)) * (1.0 - smoothstep(0.2, 0.4, px / 1.2));
        tone = vec3(0.12, 0.08, 0.045) * (1.0 - 0.3 * furrow);
      }
      if (pick.y > 0.75) tone = vec3(0.27, 0.24, 0.12); // pale hay
      float crop = step(0.12, fieldHash(cell.xy + 3.0).x); // a few stay meadow
      surfaceAlbedo = mix(surfaceAlbedo, tone * grain, farm * crop * 0.85);
      float aa = px / 75.0;
      float hedge = (1.0 - smoothstep(0.022 - aa, 0.022 + aa, cell.z)) * clamp(0.022 / aa, 0.35, 1.0);
      surfaceAlbedo = mix(surfaceAlbedo, vec3(0.022, 0.036, 0.012) * grain, farm * hedge);
    }
    // Forest floor: darker and browner where the trees are.
    surfaceAlbedo = mix(surfaceAlbedo, vec3(0.085, 0.062, 0.034) * grain, smoothstep(0.54, 0.68, vTerrainMask.z) * 0.7);
    ${ROCK_GLSL}
    // Worn earth on medium slopes, bare rock on steep ones...
    vec3 earth = mix(rock, vec3(0.13, 0.09, 0.05) * grain, 0.6);
    surfaceAlbedo = mix(surfaceAlbedo, earth, smoothstep(0.1, 0.19, slope + (macro - 0.5) * 0.08) * 0.65);
    surfaceAlbedo = mix(surfaceAlbedo, rock, smoothstep(0.2, 0.36, slope + (macro - 0.5) * 0.12));
    // ...and scree and bare rock on the highest ground.
    surfaceAlbedo = mix(surfaceAlbedo, rock * vec3(1.12, 1.1, 1.08), smoothstep(46.0, 60.0, h) * 0.85);
`;

// Desert. vTerrainMask.w is the dunes (0 in the hollows, 1 on the crests).
const DESERT_ALBEDO = `
    float slope = 1.0 - clamp(vNormalW.y, 0.0, 1.0);
    float dune = vTerrainMask.w;
    // Pale crests, darker and browner hollows between the dunes.
    surfaceAlbedo *= mix(vec3(0.8, 0.74, 0.66), vec3(1.08, 1.05, 1.0), smoothstep(0.04, 0.45, dune));
    surfaceAlbedo *= mix(vec3(0.84, 0.83, 0.8), vec3(1.12, 1.07, 1.0), macro);
    ${ROCK_GLSL}
    // Darker stony ground on the high plain between the dunes.
    float plain = vPositionW.y - dune * 9.0 + (macro - 0.5) * 3.0;
    float stony = smoothstep(8.0, 10.5, plain) * (1.0 - smoothstep(0.12, 0.4, dune));
    surfaceAlbedo = mix(surfaceAlbedo, rock * vec3(0.52, 0.47, 0.42), stony * 0.75);
    surfaceAlbedo = mix(surfaceAlbedo, rock, smoothstep(0.2, 0.36, slope + (macro - 0.5) * 0.12));
`;

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

  // No textures beyond these five: phones and tablets allow only a few per
  // shader, and the shadows and sky take some. Everything else is worked out.
  m.AddUniform("rockSampler", "sampler2D", loadTexture(scene, desert ? "sandstone_color" : "rock_color"));
  m.AddUniform("sandSampler", "sampler2D", loadTexture(scene, "sand_color"));
  m.AddUniform("weatherFx", "vec2", weatherFx);
  m.AddAttribute("terrainMask");
  m.Vertex_Definitions("attribute vec4 terrainMask;\nvarying vec4 vTerrainMask;");
  m.Vertex_MainEnd("vTerrainMask = terrainMask;");
  m.Fragment_Definitions(`varying vec4 vTerrainMask;\n${desert ? "" : FIELD_GLSL}`);
  m.Fragment_Custom_Albedo(`
    vec2 wp = vPositionW.xz;
    float macro = vTerrainMask.y;
    float camDist = distance(vPositionW, vEyePosition.xyz);
    // How many metres one screen pixel covers here (worked out before any
    // branch, where it is reliable): fine patterns fade out as it grows.
    float px = length(fwidth(wp));
    // Second, larger copy of the ground texture so it doesn't visibly repeat.
    vec3 far = toLinearSpace(texture2D(albedoSampler, wp * 0.021 + vec2(0.37, 0.71)).rgb);
    surfaceAlbedo = mix(surfaceAlbedo, far, 0.4);
    ${desert ? DESERT_ALBEDO : GREEN_ALBEDO}
    // Dirt verge beside the road.
    surfaceAlbedo = mix(surfaceAlbedo, rock * vec3(0.95, 0.86, 0.72), vTerrainMask.x * 0.85);
    // Beaches near the water line (not up the cliffs), damp and darker at the water's edge.
    vec3 sand = toLinearSpace(texture2D(sandSampler, wp * 0.12).rgb) * 1.1;
    sand *= mix(1.0, 0.58, 1.0 - smoothstep(0.3, 1.5, vPositionW.y + (macro - 0.5) * 0.8));
    float beach = (1.0 - smoothstep(1.6, 3.4, vPositionW.y + (macro - 0.5) * 1.5)) * (1.0 - smoothstep(0.3, 0.5, slope));
    surfaceAlbedo = mix(surfaceAlbedo, sand, beach);
    // Weather: rain darkens, snow settles on flatter ground.
    surfaceAlbedo *= mix(1.0, 0.62, weatherFx.x);
    float settle = smoothstep(0.72, 0.92, vNormalW.y) * (0.65 + 0.35 * macro);
    surfaceAlbedo = mix(surfaceAlbedo, vec3(0.86, 0.89, 0.93), weatherFx.y * settle);
  `);
  m.Fragment_Before_Lights(`
    // Fine grain close to the car: the ground's own normal map again at
    // 0.7 m (it repeats every 6 m otherwise), gone by 40 m.
    float grainNear = 1.0 - smoothstep(14.0, 40.0, distance(vPositionW, vEyePosition.xyz));
    vec3 grainN = texture2D(bumpSampler, vPositionW.xz / 0.7).xyz * 2.0 - 1.0;
    normalW = normalize(normalW + vec3(grainN.x, 0.0, grainN.y) * (0.4 * grainNear));
    ${
      desert
        ? `// Wind ripples on the dunes, running across the wind; faded out on
    // the steep faces, in the hollows and before they'd shimmer.
    float ripPh = dot(vPositionW.xz, vec2(0.928, 0.371)) / 0.85 + sin(dot(vPositionW.xz, vec2(0.11, -0.27))) * 1.5;
    float ripOn = (1.0 - smoothstep(0.08, 0.2, fwidth(ripPh))) * smoothstep(0.1, 0.35, vTerrainMask.w) * smoothstep(0.65, 0.8, vNormalW.y);
    normalW = normalize(normalW + vec3(0.928, 0.0, 0.371) * (cos(ripPh * 6.283) * 0.12 * ripOn));`
        : ""
    }
  `);
  m.Fragment_Custom_MetallicRoughness(`
    metallicRoughness.g *= mix(1.0, 0.55, weatherFx.x);
    // Damp sand at the water's edge is a little shiny.
    metallicRoughness.g *= mix(1.0, 0.6, 1.0 - smoothstep(0.3, 1.5, vPositionW.y));
  `);
  return m;
}

// 0..1 into a byte, for the packed per-vertex ground data.
const byte = (v) => Math.round(clamp(v, 0, 1) * 255);

function buildIsland(scene, world, island, material) {
  const def = island.def;
  const desert = def.climate === "desert";
  const segs = Math.round((2 * def.half) / STEP);
  const chunks = Math.ceil(segs / CHUNK);
  const out = [];
  // Farmland: away from towns, landmarks and woods, and only in some parts of
  // the country (a slow noise leaves the rest as open grass).
  const farmland = (x, z, forest) => {
    if (!def.fields) return 0;
    let away = 1 - island.townBlend(x, z, 160).w;
    for (const lm of def.landmarks) {
      const r = (lm.base ?? 30) / 2;
      away *= smoothstep(r + 20, r + 90, Math.hypot(x - lm.x, z - lm.z));
    }
    return away * (1 - smoothstep(0.54, 0.64, forest)) * smoothstep(-0.45, -0.1, fbm(island.noiseD, x / 900 + 11.1, z / 900 - 4.2, 2));
  };
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const i0 = cx * CHUNK;
      const j0 = cz * CHUNK;
      const ni = Math.min(CHUNK, segs - i0);
      const nj = Math.min(CHUNK, segs - j0);
      const g = new GeometryBuilder();
      // Per vertex, a byte each: road verge, macro colour drift (two scales,
      // stretched to use the whole range), forest density, and farmland (or,
      // in the desert, the dunes).
      const mask = new Uint8Array((ni + 1) * (nj + 1) * 4);
      let k = 0;
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
          const macro = 0.55 * fbm(island.noiseC, x / 140 + 5.1, z / 140 - 2.3, 3) + 0.45 * fbm(island.noiseC, x / 700 - 7.7, z / 700 + 3.1, 2);
          const forest = forestDensity(x, z);
          mask[k++] = byte(1 - smoothstep(ROAD_HALF_WIDTH + 0.5, ROAD_HALF_WIDTH + 4.5, d));
          mask[k++] = byte(0.5 + macro * 0.75);
          mask[k++] = byte(forest);
          mask[k++] = byte(desert ? island.dune(x, z) : farmland(x, z, forest));
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
      const mesh = g.toMesh(`terrain_${def.id}_${cx}_${cz}`, scene);
      // Bytes, read by the shader as 0..1: a quarter of the memory of floats.
      mesh.setVerticesBuffer(new VertexBuffer(scene.getEngine(), mask, "terrainMask", false, false, 4, false, 0, 4, VertexBuffer.UNSIGNED_BYTE, true));
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

// The ground height along the coasts, for the sea's foam and shallows. One
// small picture holds all four countries, one in each colour channel (512 px
// across a country: about 4 to 5 m a pixel), from 6 m under the water to 3 m
// above it. `rects` says where each country's square is: a column each of
// (west edge, south edge, 1 / width, unused).
const SHORE = 512;
const SHORE_LOW = -6;
const SHORE_HIGH = 3;
function shoreMap(scene, world) {
  const data = new Uint8Array(SHORE * SHORE * 4);
  const rects = Matrix.Zero();
  world.islands.slice(0, 4).forEach((isl, c) => {
    const size = 2 * isl.def.half;
    for (let j = 0; j < SHORE; j++) {
      const z = isl.minZ + ((j + 0.5) / SHORE) * size;
      for (let i = 0; i < SHORE; i++) {
        const h = isl.getHeight(isl.minX + ((i + 0.5) / SHORE) * size, z);
        data[(j * SHORE + i) * 4 + c] = byte((h - SHORE_LOW) / (SHORE_HIGH - SHORE_LOW));
      }
    }
    rects.m[c * 4] = isl.minX;
    rects.m[c * 4 + 1] = isl.minZ;
    rects.m[c * 4 + 2] = 1 / size;
    rects.m[c * 4 + 3] = 1;
  });
  const tex = new RawTexture(data, SHORE, SHORE, Engine.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.name = "shoreHeights";
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return { tex, rects };
}

function buildSea(scene, world) {
  const sea = MeshBuilder.CreateGround("sea", { width: 9000, height: 9000, subdivisions: 1 }, scene);
  sea.position.y = SEA_LEVEL;
  const m = new PBRCustomMaterial("seaMat", scene);
  m.albedoColor = new Color3(0.015, 0.07, 0.09);
  m.metallic = 0;
  m.roughness = 0.06;
  m.bumpTexture = waterNormals(scene);
  m.bumpTexture.uScale = m.bumpTexture.vScale = 9000 / 26;
  m.bumpTexture.level = 0.45;

  // Foam where the water meets the land, lighter water over the shallows, and
  // the hazy sky colour mixed in where you look across the water at a low
  // angle. All in the sea's own shader: no extra pass.
  const shore = shoreMap(scene, world);
  const seaTime = new Vector4(0, 0, 0, 0);
  m.AddUniform("shoreSampler", "sampler2D", shore.tex);
  m.AddUniform("shoreRects", "mat4", shore.rects);
  m.AddUniform("seaTime", "vec4", seaTime);
  // (The fog colour object itself, so it follows the time of day and weather.)
  m.AddUniform("seaSky", "vec3", scene.fogColor);
  m.Fragment_Definitions(`
    // Foam (0..1) here; set while working out the colour, read again for the shine.
    float seaFoam = 0.0;
    // Ground height under the water, from the coast picture (deep sea between countries).
    float seaGround(vec2 p) {
      vec2 uv = vec2(-1.0);
      vec4 pick = vec4(0.0);
      for (int i = 0; i < 4; i++) {
        vec2 u = (p - shoreRects[i].xy) * shoreRects[i].z;
        if (shoreRects[i].w > 0.0 && u.x > 0.0 && u.y > 0.0 && u.x < 1.0 && u.y < 1.0) {
          uv = u;
          pick = vec4(equal(ivec4(i), ivec4(0, 1, 2, 3)));
        }
      }
      if (uv.x < 0.0) return ${SHORE_LOW.toFixed(1)};
      return mix(${SHORE_LOW.toFixed(1)}, ${SHORE_HIGH.toFixed(1)}, dot(texture2D(shoreSampler, uv), pick));
    }
  `);
  m.Fragment_Custom_Albedo(`
    float seaDepth = -seaGround(vPositionW.xz);
    // Shallows: lighter and greener over the sand near the beach.
    surfaceAlbedo = mix(vec3(0.05, 0.15, 0.13), surfaceAlbedo, smoothstep(0.2, 5.0, seaDepth));
    // Foam: a band along the water's edge that washes in towards the beach,
    // broken up by the ripples (close up only; far off, a soft pale line).
    // Only worked out near the edge: none of it reaches deeper water, and
    // most of the sea on screen is deep.
    if (seaDepth < 1.5) {
      float seaFar = smoothstep(250.0, 700.0, distance(vPositionW, vEyePosition.xyz));
      vec2 seaRip = texture2D(bumpSampler, vPositionW.xz * 0.043 + seaTime.x * vec2(0.011, 0.007)).xy;
      vec2 seaRip2 = texture2D(bumpSampler, vPositionW.zx * 0.11 - seaTime.x * vec2(0.008, 0.013)).xy;
      float seaWash = 0.5 + 0.5 * sin(seaDepth * 4.5 + seaTime.x * 1.2 + (seaRip.x - 0.5) * 5.0);
      float seaBand = 1.0 - smoothstep(0.0, 0.55 + 0.75 * seaWash, seaDepth);
      float seaLace = seaRip.y * 0.55 + seaRip2.x * 0.45;
      seaFoam = seaBand * smoothstep(0.42, 0.78, seaLace + seaBand * 0.35 + seaWash * 0.12) * 0.85;
      seaFoam = mix(seaFoam, seaBand * 0.35, seaFar);
      surfaceAlbedo = mix(surfaceAlbedo, vec3(0.72, 0.75, 0.75), seaFoam);
    }
  `);
  // Foam is matt.
  m.Fragment_Custom_MetallicRoughness(`
    metallicRoughness.g = mix(metallicRoughness.g, 0.75, seaFoam);
  `);
  m.Fragment_Before_Fog(`
    // Looking across the water at a low angle, it takes on the hazy sky colour.
    float seaGlance = pow(1.0 - clamp(viewDirectionW.y, 0.0, 1.0), 5.0);
    finalColor.rgb = mix(finalColor.rgb, seaSky, seaGlance * 0.45 * (1.0 - seaFoam));
  `);
  sea.material = m;
  sea.isPickable = false;
  sea.freezeWorldMatrix();
  // Slow drift of the ripples; the foam's clock.
  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000;
    m.bumpTexture.uOffset = t * 0.0021;
    m.bumpTexture.vOffset = t * 0.0013;
    seaTime.x = t % 3600;
  });
  return sea;
}

export function buildTerrain(scene, world) {
  const green = groundMaterial(scene, "groundGreen", false);
  const desert = groundMaterial(scene, "groundDesert", true);
  const chunks = [];
  for (const island of world.islands) chunks.push(...buildIsland(scene, world, island, island.def.climate === "desert" ? desert : green));
  const sea = buildSea(scene, world);
  return { chunks, sea, materials: [green, desert] };
}
