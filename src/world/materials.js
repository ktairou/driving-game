import { Texture, PBRMaterial, Color3 } from "@babylonjs/core";

// The .ktx2 copies (tools/compress-textures.mjs) use a quarter of the graphics
// memory of the .webp originals. They are stored upside down, so they come out
// the same way up as a .webp loaded with invertY.
export function loadTexture(scene, file, { gamma = true, uScale = 1, vScale = 1, aniso = 4, hasAlpha = false } = {}) {
  const t = new Texture(`assets/textures/${file}.ktx2`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.gammaSpace = gamma;
  t.uScale = uScale;
  t.vScale = vScale;
  t.anisotropicFilteringLevel = aniso;
  t.hasAlpha = hasAlpha;
  return t;
}

// A Poly Haven style surface: colour + OpenGL normal + ARM (ao, roughness, metal).
export function surfaceMaterial(scene, name, set, { tile = 1, tint = null, bump = 1, roughness = 1 } = {}) {
  const m = new PBRMaterial(name, scene);
  m.albedoTexture = loadTexture(scene, `${set}_color`, { uScale: tile, vScale: tile });
  m.bumpTexture = loadTexture(scene, `${set}_normal`, { gamma: false, uScale: tile, vScale: tile });
  m.bumpTexture.level = bump;
  m.metallicTexture = loadTexture(scene, `${set}_arm`, { gamma: false, uScale: tile, vScale: tile });
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = roughness;
  if (tint) m.albedoColor = tint;
  return m;
}

export function plainMaterial(scene, name, color, { metallic = 0, roughness = 0.6 } = {}) {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = color;
  m.metallic = metallic;
  m.roughness = roughness;
  return m;
}

export const rgb = (r, g, b) => new Color3(r, g, b);
