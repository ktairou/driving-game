// Makes a light version of the car for traffic and parked cars: no cabin
// interior, and far fewer triangles. Run after fetch-assets:
//   node tools/make-lod.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { weld, simplify, prune, dedup, textureCompress } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public", "assets", "car", "concept_car.glb");
const out = path.join(root, "public", "assets", "car", "concept_car_lod.glb");

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(src);

// Nobody sees inside traffic cars.
for (const node of doc.getRoot().listNodes()) {
  if (/^(Interior|Engine|Axles|BodyWindshieldWipers|BodyHoodInterior|BodyHoodUnder)/.test(node.getName())) {
    node.setMesh(null);
    for (const child of node.listChildren()) child.setMesh(null);
  }
}

await MeshoptSimplifier.ready;
await doc.transform(
  dedup(),
  prune(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: 0.04, error: 0.012 }),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [512, 512] }),
);

await io.write(out, doc);
let tris = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
console.log("wrote", out, "triangles:", Math.round(tris));
