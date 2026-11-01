import { HDRCubeTexture, DirectionalLight, Vector3, Color3, Scene, CascadedShadowGenerator, ShadowGenerator } from "@babylonjs/core";

export async function setupSky(scene) {
  const sun = await (await fetch("assets/sky/sun.json")).json();
  const env = await new Promise((resolve, reject) => {
    const t = new HDRCubeTexture("assets/sky/sky_2k.hdr", scene, 512, false, true, false, true, () => resolve(t), (m) => reject(new Error(m)));
  });
  scene.environmentTexture = env;
  scene.environmentIntensity = 0.9;

  const skybox = scene.createDefaultSkybox(env, true, 1500, 0, false);
  skybox.applyFog = false;
  skybox.infiniteDistance = true;
  skybox.isPickable = false;

  const toSun = new Vector3(sun.direction[0], sun.direction[1], sun.direction[2]).normalize();
  const light = new DirectionalLight("sun", toSun.scale(-1), scene);
  light.intensity = 4.2;
  light.diffuse = new Color3(1.0, 0.975, 0.945);
  light.shadowMinZ = 0;
  light.shadowMaxZ = 600;

  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0011;
  scene.fogColor = new Color3(0.64, 0.71, 0.79);

  return { env, skybox, light, toSun };
}

export function createShadows(scene, light, camera, quality) {
  const csm = new CascadedShadowGenerator(quality.shadowSize, light, false, camera);
  csm.numCascades = quality.cascades;
  csm.shadowMaxZ = quality.shadowMaxZ;
  csm.lambda = 0.8;
  csm.stabilizeCascades = true;
  csm.cascadeBlendPercentage = 0.08;
  csm.usePercentageCloserFiltering = true;
  csm.filteringQuality = quality.shadowSize >= 2048 ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
  csm.bias = 0.0015;
  csm.normalBias = 0.015;
  csm.depthClamp = true;
  csm.darkness = 0.0;
  return csm;
}
