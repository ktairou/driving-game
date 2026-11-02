import { ImportMeshAsync, TransformNode, Color3, DynamicTexture, Texture, PBRMaterial, Vector3, Mesh, VertexBuffer, Quaternion, Matrix } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

export const WHEEL_RADIUS = 0.38;
const WHEELS = [
  { name: "WheelFrontL", front: true, left: true },
  { name: "WheelFrontR", front: true, left: false },
  { name: "WheelRearL", front: false, left: true },
  { name: "WheelRearR", front: false, left: false },
];

function plateTexture(scene) {
  // glTF uvs expect textures that are not flipped vertically.
  const t = new DynamicTexture("plate", { width: 512, height: 128 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE, undefined, false);
  const c = t.getContext();
  c.fillStyle = "#f4f1e8";
  c.fillRect(0, 0, 512, 128);
  c.strokeStyle = "#20242a";
  c.lineWidth = 6;
  c.strokeRect(6, 6, 500, 116);
  c.fillStyle = "#1b1f24";
  c.font = "bold 78px Arial, Helvetica, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("DRIVE 1", 256, 68);
  t.update(false);
  return t;
}

// Babylon can only merge parts that carry the same vertex attributes; fill
// any missing ones (e.g. a second uv set) with zeros first.
function mergeParts(parts, multiMaterial) {
  const kinds = new Set();
  for (const m of parts) for (const k of m.getVerticesDataKinds()) kinds.add(k);
  for (const m of parts) {
    for (const k of kinds) {
      if (m.isVerticesDataPresent(k)) continue;
      const stride = VertexBuffer.DeduceStride(k);
      m.setVerticesData(k, new Float32Array(m.getTotalVertices() * stride), false, stride);
    }
  }
  // Sources are kept here: parts are parents of other parts, so disposing one
  // early would take its children with it. The caller disposes them after.
  const mirrored = parts[0].computeWorldMatrix(true).determinant() < 0;
  const merged = Mesh.MergeMeshes(parts, false, true, undefined, multiMaterial, multiMaterial);
  // Babylon skips the winding fix for a mirrored part when it is merged on
  // its own (the glTF importer mirrors everything), leaving it inside out.
  if (parts.length === 1 && mirrored) merged.flipFaces(false);
  return merged;
}

// The model's front wheels were saved turned ~30 degrees (a steering pose),
// so their axle isn't square to the car. Spinning them like that makes them
// wobble. Measure the axle (the wheel's local X) and return a matrix that
// squares it up around the wheel centre `p`.
function axleFix(node, p) {
  const axle = Vector3.TransformNormal(Vector3.Right(), node.computeWorldMatrix(true)).normalize();
  const square = Quaternion.Identity();
  Quaternion.FromUnitVectorsToRef(axle, axle.x >= 0 ? Vector3.Right() : Vector3.Left(), square);
  return Matrix.Translation(-p.x, -p.y, -p.z).multiply(Matrix.FromQuaternionToRef(square, new Matrix())).multiply(Matrix.Translation(p.x, p.y, p.z));
}

function fixMaterials(scene, materials, plate = true) {
  const license = [...materials].find((m) => m.name === "License");
  const logoTexture = license?.albedoTexture;
  for (const m of materials) {
    if (!(m instanceof PBRMaterial)) continue;
    // The sample model carries the Khronos logo on its plate, rims and calipers.
    if (logoTexture && m.emissiveTexture === logoTexture) {
      m.emissiveTexture = null;
      m.emissiveColor = Color3.Black();
    }
    // The paint has a fine metal-flake texture. On an iPad screen it sparkles
    // and shimmers under street lights, so keep only a hint of it.
    if (/^Paint/.test(m.name) && m.bumpTexture) m.bumpTexture.level = 0.08;
    if (m.name === "Glass") {
      m.subSurface.isRefractionEnabled = false;
      m.albedoColor = new Color3(0.02, 0.025, 0.03);
      m.metallic = 0;
      m.roughness = 0.04;
      m.alpha = 0.42;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      m.backFaceCulling = false;
    }
  }
  if (license) {
    license.albedoTexture = plate ? plateTexture(scene) : null;
    if (!plate) license.albedoColor = new Color3(0.9, 0.9, 0.86);
    if (license.albedoTexture) license.albedoTexture.wrapU = license.albedoTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
  }
}

// Light version for traffic and parked cars: everything merged into one
// mesh (one piece per material), ready to be drawn many times at once.
export async function loadCarLod(scene) {
  const result = await ImportMeshAsync("assets/car/concept_car_lod.glb", scene, {
    pluginOptions: { gltf: { createInstances: false, extensionOptions: { KHR_materials_transmission: { enabled: false } } } },
  });
  const gltfRoot = result.meshes[0];
  const materials = new Set(result.meshes.map((m) => m.material).filter(Boolean));
  fixMaterials(scene, materials, false);
  // Paint is white here; each car's colour comes from its own instance colour.
  for (const m of materials) if (/^Paint 1/.test(m.name)) m.albedoColor = new Color3(1, 1, 1);
  const wheelParts = [];
  const handled = new Set();
  for (const w of WHEELS) {
    const node = result.transformNodes.find((n) => n.name === w.name);
    if (!node) continue;
    const pos = node.getAbsolutePosition().clone();
    const parts = node.getChildMeshes(false).filter((m) => m.getTotalVertices() > 0);
    parts.forEach((m) => handled.add(m));
    const merged = mergeParts(parts, true);
    merged.bakeTransformIntoVertices(axleFix(node, pos));
    wheelParts.push(merged);
  }
  const bodyParts = result.meshes.filter((m) => m.getTotalVertices() > 0 && !handled.has(m));
  const mesh = mergeParts([...bodyParts, ...wheelParts], true);
  mesh.name = "carLod";
  gltfRoot.dispose();
  wheelParts.forEach((m) => m.dispose());
  mesh.isPickable = false;
  return mesh;
}

// Loads the car and rearranges it into:
//   root (position + heading + ground tilt)
//     body (extra lean from braking / cornering)
//       glTF model
//     wheel steer nodes -> wheel spin nodes -> wheel meshes
export async function loadCar(scene, onProgress) {
  const result = await ImportMeshAsync("assets/car/concept_car.glb", scene, {
    onProgress: (e) => e.lengthComputable && onProgress?.(e.loaded / e.total),
    pluginOptions: {
      gltf: {
        // Real meshes (not instances) so the parts can be merged below.
        createInstances: false,
        // Real glass refraction renders the whole scene a second time each
        // frame; far too costly on an iPad. We use simple tinted glass instead.
        extensionOptions: { KHR_materials_transmission: { enabled: false } },
      },
    },
  });
  const gltfRoot = result.meshes[0];

  const root = new TransformNode("car", scene);
  root.rotationQuaternion = null;
  const body = new TransformNode("carBody", scene);
  body.parent = root;
  gltfRoot.parent = body;

  // --- Materials ----------------------------------------------------------------
  const materials = new Set(result.meshes.map((m) => m.material).filter(Boolean));
  fixMaterials(scene, materials);

  // --- Wheels ---------------------------------------------------------------------
  root.computeWorldMatrix(true);
  body.computeWorldMatrix(true);
  const wheels = [];
  for (const w of WHEELS) {
    const node = scene.getTransformNodeByName(w.name);
    if (!node) throw new Error(`car model is missing ${w.name}`);
    node.computeWorldMatrix(true);
    const pos = node.getAbsolutePosition().clone();
    const steer = new TransformNode(`${w.name}_steer`, scene);
    steer.parent = root;
    steer.position = pos;
    const spin = new TransformNode(`${w.name}_spin`, scene);
    spin.parent = steer;
    node.setParent(spin);
    wheels.push({ ...w, steer, spin, rest: pos.clone(), offset: 0 });
  }

  // The model arrives as ~110 separate parts. Merge them by material (body)
  // and per wheel, so the iPad has far fewer pieces to draw each frame.
  const meshes = [];
  const wheelParts = new Set();
  for (const w of wheels) {
    const node = scene.getTransformNodeByName(w.name);
    const fix = axleFix(node, w.rest);

    const parts = w.spin.getChildMeshes(false).filter((m) => m.getTotalVertices() > 0);
    parts.forEach((m) => wheelParts.add(m));
    // Brake calipers turn with steering but must not spin with the wheel.
    const calipers = parts.filter((m) => /BrakePad/.test(m.name));
    const spinning = parts.filter((m) => !calipers.includes(m));
    const merged = mergeParts(spinning, true);
    merged.bakeTransformIntoVertices(fix);
    merged.name = `${w.name}_mesh`;
    merged.setParent(w.spin);
    meshes.push(merged);
    if (calipers.length) {
      const c = mergeParts(calipers, true);
      c.bakeTransformIntoVertices(fix);
      c.name = `${w.name}_caliper`;
      c.setParent(w.steer);
      meshes.push(c);
    }
  }
  // The steering wheel inside the cabin gets its own pivot so it can turn.
  // It spins around its own local Y axis (the steering column).
  let steeringPivot = null;
  let steeringAxis = null;
  const steeringRim = scene.getMeshByName("InteriorSteeringWheel01");
  if (steeringRim) {
    const parts = ["InteriorSteeringEmblem", "InteriorSteeringWheel01", "InteriorSteeringWheel02", "InteriorSteeringWheel03", "InteriorSteeringWheel04"]
      .map((n) => scene.getMeshByName(n))
      .filter((m) => m && m.getTotalVertices() > 0);
    const wm = steeringRim.computeWorldMatrix(true);
    steeringAxis = Vector3.TransformNormal(Vector3.Up(), wm).normalize();
    steeringPivot = new TransformNode("steeringPivot", scene);
    steeringPivot.parent = body;
    steeringPivot.position = steeringRim.getAbsolutePosition().clone();
    steeringPivot.rotationQuaternion = Quaternion.Identity();
    const merged = mergeParts(parts, true);
    merged.name = "car_steeringWheel";
    merged.setParent(steeringPivot);
    parts.forEach((m) => wheelParts.add(m));
    meshes.push(merged);
  }

  const byMaterial = new Map();
  for (const m of result.meshes) {
    if (m.getTotalVertices() === 0 || wheelParts.has(m) || !m.material) continue;
    if (!byMaterial.has(m.material)) byMaterial.set(m.material, []);
    byMaterial.get(m.material).push(m);
  }
  const noShadow = /^(Interior|Floormat|Dashboard|Glass)/;
  const shadowMeshes = [...meshes];
  for (const [material, parts] of byMaterial) {
    const merged = mergeParts(parts, false);
    merged.name = `car_${material.name}`;
    merged.material = material;
    merged.setParent(body);
    meshes.push(merged);
    if (!noShadow.test(material.name)) shadowMeshes.push(merged);
  }
  // Throw away the original parts and the glTF hierarchy they lived in.
  for (const w of WHEELS) scene.getTransformNodeByName(w.name)?.dispose();
  gltfRoot.dispose();
  for (const m of meshes) {
    m.isPickable = false;
    m.receiveShadows = true;
  }

  // Wheelbase and track from the model itself.
  const fl = wheels[0].rest;
  const rl = wheels[2].rest;
  const fr = wheels[1].rest;
  const geometry = {
    frontZ: fl.z,
    rearZ: rl.z,
    halfTrack: Math.abs(fl.x - fr.x) / 2,
  };

  // Driver's eye: centre seat, behind and above the steering wheel.
  const eye = steeringPivot ? steeringPivot.position.add(new Vector3(0, 0.3, -0.6)) : new Vector3(0, 0.95, 0.2);
  return { root, body, wheels, meshes, shadowMeshes, geometry, materials: [...materials], steeringPivot, steeringAxis, eye };
}

export function setPaint(car, color) {
  for (const m of car.materials) {
    if (m.name === "Paint 1 Carmine") m.albedoColor = color;
  }
}

export const tmpV = new Vector3();

// --- The downloaded vehicles (tools/prepare-models.mjs) ----------------------------
// Each one stands on the origin facing +Z: a body in a few parts (paint,
// glass, lights...) and separate wheels named wheel_N.

const vehicleOptions = {
  pluginOptions: { gltf: { createInstances: false, extensionOptions: { KHR_materials_transmission: { enabled: false } } } },
};

// Headlights and tail lights are both drawn on each model's "optics" picture.
// Glowing with that same picture lights each lamp in its own colour at night.
function prepareVehicleMaterials(materials) {
  const lights = [];
  for (const m of materials) {
    if (!(m instanceof PBRMaterial)) continue;
    if (/optic/i.test(m.name)) {
      m.emissiveTexture = m.albedoTexture;
      m.emissiveColor = Color3.Black();
      lights.push(m);
    }
    if (/glass/i.test(m.name)) m.backFaceCulling = false;
  }
  return lights;
}

const boundsOf = (meshes) => {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    min.minimizeInPlace(bb.minimumWorld);
    max.maximizeInPlace(bb.maximumWorld);
  }
  return { min, max };
};

// The driveable version, in the same shape loadCar gives (so everything that
// works with the concept car works with these).
export async function loadVehicle(scene, id, onProgress) {
  const result = await ImportMeshAsync(`assets/vehicles/${id}.glb`, scene, {
    ...vehicleOptions,
    onProgress: (e) => e.lengthComputable && onProgress?.(e.loaded / e.total),
  });
  const gltfRoot = result.meshes[0];
  const root = new TransformNode("car", scene);
  root.rotationQuaternion = null;
  const body = new TransformNode("carBody", scene);
  body.parent = root;
  gltfRoot.parent = body;
  const parts = result.meshes.filter((m) => m.getTotalVertices() > 0);
  const materials = new Set(parts.map((m) => m.material).filter(Boolean));
  const head = prepareVehicleMaterials(materials);
  // Lighter windows on the one you drive, so the view from the driver's seat isn't dark.
  for (const m of materials) if (/glass/i.test(m.name)) m.alpha = Math.min(m.alpha, 0.45);

  // Wheels: one steer node at each wheel's middle, a spin node under it.
  const groups = new Map();
  for (const m of parts) {
    const k = /^wheel_(\d+)/.exec(m.name)?.[1];
    if (k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const wheels = [];
  for (const list of groups.values()) {
    const { min, max } = boundsOf(list);
    const c = min.add(max).scale(0.5);
    const steer = new TransformNode("wheelSteer", scene);
    steer.parent = root;
    steer.position = c.clone();
    const spin = new TransformNode("wheelSpin", scene);
    spin.parent = steer;
    for (const m of list) m.setParent(spin);
    wheels.push({ front: c.z > 0, left: c.x < 0, steer, spin, rest: c.clone(), offset: 0, radius: (max.y - min.y) / 2 });
  }
  // Front left, front right, rear left, rear right first (they follow the ground
  // under those corners); any extra rear wheels after.
  wheels.sort((a, b) => b.front - a.front || b.left - a.left || b.rest.z - a.rest.z);
  for (const w of wheels) w.groundIndex = (w.front ? 0 : 2) + (w.left ? 0 : 1);

  const meshes = [];
  const shadowMeshes = [];
  parts.forEach((m, i) => {
    if (!/^wheel_/.test(m.name)) {
      const mat = m.material?.name ?? "";
      // Named so crash dents work on them (see car/damage.js).
      m.name = /glass/i.test(mat) ? `car_Glass_${i}` : /optic/i.test(mat) ? `car_Headlight_${i}` : `car_Panel_${i}`;
      m.setParent(body);
    }
    m.isPickable = false;
    m.receiveShadows = true;
    meshes.push(m);
    if (!/glass/i.test(m.material?.name ?? "")) shadowMeshes.push(m);
  });
  gltfRoot.dispose(true, false);

  const { min, max } = boundsOf(meshes);
  const fronts = wheels.filter((w) => w.front);
  const rears = wheels.filter((w) => !w.front);
  const avg = (list, f) => list.reduce((s, w) => s + f(w), 0) / Math.max(1, list.length);
  const length = max.z - min.z;
  const width = max.x - min.x;
  const height = max.y;
  const geometry = {
    frontZ: fronts.length ? avg(fronts, (w) => w.rest.z) : max.z * 0.62,
    rearZ: rears.length ? avg(rears, (w) => w.rest.z) : min.z * 0.62,
    halfTrack: fronts.length ? avg(fronts, (w) => Math.abs(w.rest.x)) : width * 0.42,
    front: max.z,
    rear: min.z,
    halfWidth: width / 2,
    length,
    height,
  };
  // Where the driver's eyes are: big vehicles sit you right at the front.
  const big = length > 6.2;
  const eye = new Vector3(0, height * (big ? 0.78 : 0.86), big ? max.z - 1.1 : geometry.frontZ - 1.2);
  const views = {
    bonnet: big ? new Vector3(0, height * 0.55, max.z + 0.25) : new Vector3(0, height * 0.8, geometry.frontZ - 0.1),
    bumper: new Vector3(0, Math.min(0.6, height * 0.3), max.z + 0.15),
  };
  return {
    id,
    root,
    body,
    wheels,
    meshes,
    shadowMeshes,
    geometry,
    materials: [...materials],
    steeringPivot: null,
    steeringAxis: null,
    eye,
    views,
    lights: { head, tail: [] },
    wheelRadius: wheels.length ? avg(wheels, (w) => w.radius) : WHEEL_RADIUS,
    chase: { dist: Math.max(1, length / 4.6), height: Math.max(1, height / 1.4) },
  };
}

// The traffic version: the whole vehicle as one mesh (one piece per material),
// ready to be drawn many times at once. Also gives its size.
export async function loadVehicleLod(scene, id) {
  const result = await ImportMeshAsync(`assets/vehicles/${id}.glb`, scene, vehicleOptions);
  const gltfRoot = result.meshes[0];
  const parts = result.meshes.filter((m) => m.getTotalVertices() > 0);
  const materials = new Set(parts.map((m) => m.material).filter(Boolean));
  const lights = prepareVehicleMaterials(materials);
  const { min, max } = boundsOf(parts);
  const mesh = mergeParts(parts, true);
  mesh.name = `traffic_${id}`;
  gltfRoot.dispose();
  mesh.isPickable = false;
  return { mesh, lights, length: max.z - min.z, halfWidth: (max.x - min.x) / 2 };
}
