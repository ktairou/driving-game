// Checks the real cars in the game (and makes their garage pictures):
//   node tools/check.mjs --level medium --script tools/check-cars.js --timeout 600
//   node tools/car-thumbs.mjs
// For each car in turn: drive it (swapCar), measure its graphics memory,
// triangles and frame cost, check its wheels steer and spin, and take three
// pictures: the garage thumbnail (a fixed camera, front three-quarter from the
// right), its back at night with the brakes on, its front at night, and the
// view from the driver's seat. To check just some: --url "http://localhost:5173/#cars=id1,id2".
// Run by tools/check.mjs: g = window.__game.
const ONLY = /cars=([^&]+)/.exec(location.hash)?.[1].split(",") ?? null;
const IDS = ONLY ?? ["sedan", ...g.GARAGE.filter((e) => e.real).map((e) => e.id)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HALF = new Set([33776, 33777, 35916, 35917, 36283, 36284, 36196, 37488, 37489, 37492, 37493, 37494, 37495, 35840, 35842]);
const memory = (id) => {
  const seen = new Set();
  let total = 0;
  let own = 0;
  for (const tex of g.scene.textures) {
    const it = tex.getInternalTexture && tex.getInternalTexture();
    if (!it || seen.has(it)) continue;
    seen.add(it);
    const faces = it.isCube ? 6 : 1;
    const compressed = it.format >= 0x8000;
    const bpp = compressed ? (HALF.has(it.format) ? 0.5 : 1) : it._compression ? 1 : it.type === 1 || it.type === 2 ? 16 : 4;
    const mb = (it.width * it.height * bpp * faces * (it.generateMipMaps ? 1.33 : 1)) / 1e6;
    total += mb;
    const u = String(it.url || tex.url || tex.name || "");
    if (id && u.includes(`vehicles/${id}.glb`)) own += mb;
  }
  return { total: +total.toFixed(1), own: +own.toFixed(2) };
};
const canvas = g.engine.getRenderingCanvas();
const small = (w = 480) => {
  const o = document.createElement("canvas");
  o.width = w;
  o.height = Math.round((w * canvas.height) / canvas.width);
  o.getContext("2d").drawImage(canvas, 0, 0, o.width, o.height);
  return o.toDataURL("image/jpeg", 0.85);
};
const setHour = (h) => {
  g.daynight.hour = h;
  g.daynight.update(0);
};
g.weather.set("sunny");
// (A long run would empty the tank otherwise.)
g.fuel.auto = true;
setHour(11);
const cam = g.chase.camera;
const V = cam.position.constructor;
const realChase = g.chase.update.bind(g.chase);
const view = (name) => {
  for (let i = 0; i < 8 && g.chase.modeName !== name; i++) g.chase.cycle();
  g.chase._first = true;
};
const spot = { x: -560, z: -1.9, yaw: 1.5708 };
const out = { start: memory(null), cars: [] };
for (const id of IDS) {
  const entry = g.GARAGE.find((e) => e.id === id);
  const r = { id };
  try {
    const t0 = performance.now();
    await g.swapCar(entry);
    r.loadMs = Math.round(performance.now() - t0);
    g.chase.update = realChase;
    view("Chase");
    g.vehicle.place(spot.x, spot.z, spot.yaw);
    g.step(10);
    await wait(2500);
    g.step(2);
    const car = g.car;
    r.mem = memory(entry.model);
    r.tris = Math.round(car.meshes.reduce((s, m) => s + (m.getTotalIndices() || 0) / 3, 0));
    r.meshes = car.meshes.length;
    r.wheels = car.wheels.length;
    r.lamps = (car.tailLamps ?? []).length;
    r.cockpit = !!car.cockpit;
    r.open = car.cockpit?.open ?? null;
    r.seesBehind = car.views?.seesBehind;
    r.size = [car.geometry.halfWidth * 2, car.geometry.height, car.geometry.length].map((v) => +v.toFixed(2));
    r.wheelRadius = +(car.wheelRadius ?? 0).toFixed(3);
    // Frame cost: the chase view, ten frames.
    const gl = g.engine._gl;
    const px = new Uint8Array(4);
    for (let i = 0; i < 3; i++) g.scene.render();
    let t = performance.now();
    for (let i = 0; i < 10; i++) {
      g.scene.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    r.msRender = +((performance.now() - t) / 10).toFixed(2);
    // (No traffic in the pictures.)
    g.traffic.cars = g.traffic.cars.filter((c) => c.racing || Math.hypot(c.x - spot.x, c.z - spot.z) > 60);
    // A fixed camera at the car (`at` in the car's own space: right, up, forward).
    const h = g.vehicle.heading;
    const f = [Math.sin(h), Math.cos(h)];
    const rt = [Math.cos(h), -Math.sin(h)];
    const L = car.geometry.length;
    const H = car.geometry.height;
    const [cx, cy, cz] = [g.vehicle.x, g.vehicle.y, g.vehicle.z];
    const fixed = (at, look) => {
      const set = () => {
        cam.position.set(cx + rt[0] * at[0] + f[0] * at[2], cy + at[1], cz + rt[1] * at[0] + f[1] * at[2]);
        cam.setTarget(new V(cx + rt[0] * look[0] + f[0] * look[2], cy + look[1], cz + rt[1] * look[0] + f[1] * look[2]));
      };
      g.chase.update = () => {};
      set();
      g.step(2);
      set();
      g.scene.render();
    };
    // 1. The garage picture: front three-quarter from the right, filling the frame.
    fixed([L * 0.62, 0.55 + H * 0.35, L * 0.62], [0, H * 0.38, L * 0.06]);
    r.shot = canvas.toDataURL("image/jpeg", 0.92);
    // 2. Its back at night with the brakes on.
    setHour(22);
    g.input.keys.add("ArrowDown");
    fixed([L * 0.35, 1.1, -L * 1.0], [0, H * 0.45, -L * 0.2]);
    g.step(2);
    g.scene.render();
    r.night = small();
    g.input.keys.clear();
    // 3. Its front at night, lamps on.
    fixed([L * 0.3, 1.0, L * 1.05], [0, H * 0.45, L * 0.2]);
    g.step(2);
    g.scene.render();
    r.front = small();
    setHour(11);
    // 4. From the driver's seat.
    g.chase.update = realChase;
    view("Driver");
    g.step(6);
    g.scene.render();
    r.driver = small();
    view("Chase");
    // Drive: full throttle with the wheel turned left, then see which way it went.
    const x0 = g.vehicle.x;
    const z0 = g.vehicle.z;
    g.input.keys.add("ArrowUp");
    g.input.keys.add("ArrowLeft");
    g.step(40);
    r.steer = car.wheels.map((wh) => +(wh.steer.rotation.y || 0).toFixed(2));
    r.spin = car.wheels.map((wh) => +(wh.spin.rotation.x || 0).toFixed(1));
    g.input.keys.clear();
    r.droveForward = +((g.vehicle.x - x0) * Math.sin(spot.yaw) + (g.vehicle.z - z0) * Math.cos(spot.yaw)).toFixed(1);
    r.speed = +g.vehicle.speed.toFixed(1);
    g.step(90);
  } catch (err) {
    r.error = String(err?.stack ?? err).slice(0, 400);
  }
  out.cars.push(r);
}
out.end = memory(null);
return out;
