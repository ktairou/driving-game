import { LoadAssetContainerAsync, TransformNode, Vector3 } from "@babylonjs/core";
import { ISLANDS, SEA_LEVEL } from "./layout.js";

// The real landmark models (downloaded from Sketchfab, Creative Commons
// Attribution; made game-ready by tools/prepare-models.mjs). Each one loads
// the first time you come within reach of it, so the game starts quickly and
// the iPad only fetches what you actually go and see.
const LOAD_DIST = 1700;

export class LandmarkModels {
  constructor(scene, world, colliders) {
    this.scene = scene;
    this.world = world;
    this.onLoaded = null; // (meshes) => {}
    this.items = ISLANDS.flatMap((isl) => isl.landmarks.filter((lm) => lm.type === "model"));
    // Solid where each one stands (roughly, from its footprint), from the start.
    for (const lm of this.items) if (!lm.sea) colliders.addBox(lm.x, lm.z, lm.base * 0.4, lm.base * 0.4, lm.yaw ?? 0);
  }

  // Starts loading any landmark you've come near. Call now and then with where you are.
  update(x, z) {
    for (const lm of this.items) {
      if (lm.state || Math.hypot(lm.x - x, lm.z - z) > LOAD_DIST) continue;
      lm.state = "loading";
      this._load(lm).catch((err) => {
        console.warn("landmark failed to load", lm.model, err);
        lm.state = "failed";
      });
    }
  }

  async _load(lm) {
    const c = await LoadAssetContainerAsync(`./assets/landmarks/${lm.model}.glb`, this.scene);
    const holder = new TransformNode(`landmark_${lm.model}`, this.scene);
    for (const n of c.rootNodes) n.parent = holder;
    c.addAllToScene();
    const meshes = c.meshes.filter((m) => m.getTotalVertices() > 0);
    // Its size as it comes, before scaling and turning.
    holder.computeWorldMatrix(true);
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min.minimizeInPlace(bb.minimumWorld);
      max.maximizeInPlace(bb.maximumWorld);
    }
    const size = max.subtract(min);
    const measure = lm.fit === "width" ? size.x : lm.fit === "length" ? Math.max(size.x, size.z) : size.y;
    const s = lm.size / Math.max(measure, 1e-6);
    holder.scaling.setAll(s);
    holder.rotation.y = lm.yaw ?? 0;
    // Stand it on the ground (or on the sea bed, for ones out in the water),
    // with its middle on its spot.
    const ground = lm.sea ? SEA_LEVEL - 1.5 : this.world.getHeight(lm.x, lm.z) - 0.2;
    holder.position.set(lm.x, ground - min.y * s, lm.z);
    holder.computeWorldMatrix(true);
    min.setAll(Infinity);
    max.setAll(-Infinity);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min.minimizeInPlace(bb.minimumWorld);
      max.maximizeInPlace(bb.maximumWorld);
    }
    holder.position.x += lm.x - (min.x + max.x) / 2;
    holder.position.z += lm.z - (min.z + max.z) / 2;
    for (const m of meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      m.computeWorldMatrix(true);
      m.freezeWorldMatrix();
    }
    lm.state = "ready";
    lm.meshes = meshes;
    this.onLoaded?.(meshes, lm);
  }
}
