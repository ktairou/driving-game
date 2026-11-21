import { Color3, DynamicTexture, GetTextureDataAsync, Mesh, MeshBuilder, PBRMaterial, Ray, Texture, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import { GeometryBuilder, normalize, cross, add, sub, scale } from "../geom.js";
import { clamp, lerp, smoothstep } from "../noise.js";

// The cockpit for the downloaded vehicles, which come with no interior: one kit
// of parts built in code (dashboard, steering wheel, live dials, a map screen,
// pillars, roof lining, door tops and a mirror), shaped to each vehicle from
// measurements of its own windows. It is shown only from the driver's seat.

const DEG = Math.PI / 180;
const tanD = (deg) => Math.tan(deg * DEG);
const atanD = (y, x) => Math.atan2(y, x) / DEG;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rightOf = (n) => normalize(sub([1, 0, 0], scale(n, n[0])));
const upOf = (n) => normalize(cross(rightOf(n), n));
const xs = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// Three kinds of cockpit. Distances are metres ahead of the eye.
//   wheelR: steering wheel radius   column: its tilt from upright (degrees)
const SHAPES = {
  car: { wheelR: 0.185, column: 24, wheelD: 0.42, lip: 0.6, clusterW: 0.27, screenW: 0.15, mirrorW: 0.19, visorW: 0.38, console: 0.11 },
  van: { wheelR: 0.205, column: 34, wheelD: 0.44, lip: 0.62, clusterW: 0.29, screenW: 0.17, mirrorW: 0.21, visorW: 0.42, console: 0.13 },
  bus: { wheelR: 0.26, column: 58, wheelD: 0.47, lip: 0.76, clusterW: 0.34, screenW: 0.19, mirrorW: 0.24, visorW: 0.5, console: 0 },
};

// Colours (linear) of the parts: dark and matt, so nothing glares.
const DASH = [0.035, 0.036, 0.04];
const TRIM = [0.055, 0.055, 0.06];
const LINING = [0.13, 0.125, 0.118];
const VENT = [0.01, 0.01, 0.012];
const SLAT = [0.09, 0.09, 0.1];
const SEAL = [0.012, 0.012, 0.012];
const RIM = [0.022, 0.022, 0.025];
const SPOKE = [0.2, 0.2, 0.22];
const MARK = [0.5, 0.48, 0.44];
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// The kit's light and shade are baked into its colours (light from above and
// ahead, through the windscreen), so drawing it costs next to nothing.
const LIGHT = normalize([0.2, 0.75, 0.6]);
const lit = (n) => 0.4 + 0.6 * Math.max(0, dot(n, LIGHT));

// GeometryBuilder plus a colour per vertex. Every face is turned toward the
// driver's eye, the only place the kit is ever seen from.
class Kit extends GeometryBuilder {
  constructor(eye) {
    super();
    this.eye = eye;
    this.colours = [];
    this.colour = DASH;
  }

  addVertex(p, n, uv) {
    const k = lit(n);
    this.colours.push(this.colour[0] * k, this.colour[1] * k, this.colour[2] * k, 1);
    return super.addVertex(p, n, uv);
  }

  facing(p, n) {
    return dot(n, sub(this.eye, p)) < 0 ? scale(n, -1) : n;
  }

  quad(p0, p1, p2, p3, colour) {
    this.colour = colour;
    const n = this.facing(p0, normalize(cross(sub(p1, p0), sub(p3, p0))));
    this.addQuad(p0, p1, p2, p3, n, [0, 0], [1, 0], [1, 1], [0, 1]);
  }

  // A smooth surface through a grid of points: rows[i][j], i along a profile.
  sheet(rows, colour) {
    this.colour = colour;
    const ni = rows.length;
    const nj = rows[0].length;
    const idx = [];
    for (let i = 0; i < ni; i++) {
      for (let j = 0; j < nj; j++) {
        const a = sub(rows[Math.min(i + 1, ni - 1)][j], rows[Math.max(i - 1, 0)][j]);
        const b = sub(rows[i][Math.min(j + 1, nj - 1)], rows[i][Math.max(j - 1, 0)]);
        idx.push(this.addVertex(rows[i][j], this.facing(rows[i][j], normalize(cross(a, b))), [j / (nj - 1), i / (ni - 1)]));
      }
    }
    for (let i = 0; i < ni - 1; i++) {
      for (let j = 0; j < nj - 1; j++) {
        const p = rows[i][j];
        const n = this.facing(p, normalize(cross(sub(rows[i][j + 1], p), sub(rows[i + 1][j], p))));
        const a = idx[i * nj + j];
        const c = idx[(i + 1) * nj + j + 1];
        this.addTriangle(a, idx[i * nj + j + 1], c, n);
        this.addTriangle(a, c, idx[(i + 1) * nj + j], n);
      }
    }
  }

  // A box (centre c, half-size along u, v, w): only the faces turned to the eye.
  box(c, u, v, w, colour) {
    for (const [a, b, d] of [[u, v, w], [v, w, u], [w, u, v]]) {
      for (const s of [1, -1]) {
        const fc = add(c, scale(a, s));
        if (dot(scale(a, s), sub(this.eye, fc)) <= 0) continue;
        this.quad(add(add(fc, b), d), add(sub(fc, b), d), sub(sub(fc, b), d), sub(add(fc, b), d), colour);
      }
    }
  }

  toMesh(name, scene) {
    this.extra = { name: VertexBuffer.ColorKind, stride: 4, data: this.colours };
    return super.toMesh(name, scene);
  }
}

// ---------- Measuring a vehicle ----------------------------------------------------

const fits = new Map();

// Where the driver sits and where the windows are, measured once per vehicle
// by casting rays at its own model (in the vehicle's own space, standing at the
// origin facing +z). Returns null if no windscreen is found.
export function measureCockpit(id, body, meshes, geometry) {
  if (!fits.has(id)) {
    let fit = null;
    try {
      fit = survey(body, meshes, geometry);
    } catch (err) {
      console.warn("cockpit measuring failed for", id, err);
    }
    fits.set(id, fit);
  }
  return fits.get(id);
}

function survey(body, meshes, g) {
  const glass = meshes.filter((m) => /^car_Glass/.test(m.name));
  const solid = meshes.filter((m) => /^car_(Panel|Headlight)/.test(m.name));
  if (!glass.length || !solid.length || !g.height) return null;
  const hw = g.halfWidth ?? 1;
  const wm = body.computeWorldMatrix(true);
  for (const m of meshes) m.computeWorldMatrix(true);
  const ray = new Ray(new Vector3(), new Vector3(0, 0, 1), 15);
  const dir = new Vector3();
  const hit = { kind: 0, x: 0, y: 0, z: 0 };
  // What a ray from o along d meets first: 1 glass, 2 body, 0 nothing.
  const cast = (ox, oy, oz, dx, dy, dz) => {
    dir.set(dx, dy, dz).normalize();
    Vector3.TransformCoordinatesFromFloatsToRef(ox, oy, oz, wm, ray.origin);
    Vector3.TransformNormalToRef(dir, wm, ray.direction);
    let best = Infinity;
    hit.kind = 0;
    for (const m of glass) {
      const p = ray.intersectsMesh(m, false);
      if (p.hit && p.distance < best) {
        best = p.distance;
        hit.kind = 1;
      }
    }
    for (const m of solid) {
      const p = ray.intersectsMesh(m, false);
      if (p.hit && p.distance < best) {
        best = p.distance;
        hit.kind = 2;
      }
    }
    if (hit.kind) {
      hit.x = ox + dir.x * best;
      hit.y = oy + dir.y * best;
      hit.z = oz + dir.z * best;
    }
    return hit;
  };
  const point = () => ({ x: hit.x, y: hit.y, z: hit.z });

  // Left-hand drive: the models are American, and vehicles cross borders.
  const ex = -clamp(hw * 0.4, 0.3, 0.5);

  // 1. The windscreen: rays from in front, back along the driver's line, at
  // every height. The tallest stretch of glass is the windscreen (headlight
  // covers and roof lights are short); a wiper or two may interrupt it.
  let run = null;
  let best = null;
  let miss = 0;
  for (let y = 0.25 * g.height; y <= g.height + 0.06; y += 0.02) {
    const h = cast(ex, y, g.front + 1, 0, 0, -1);
    if (h.kind === 1) {
      if (!run) run = { lo: { y, z: h.z }, hi: null };
      run.hi = { y, z: h.z };
      miss = 0;
      if (!best || run.hi.y - run.lo.y > best.hi.y - best.lo.y) best = run;
    } else if (run && ++miss > 2) {
      run = null;
      miss = 0;
    }
  }
  if (!best || best.hi.y - best.lo.y < 0.12) return null;
  const B = best.lo;
  const T = best.hi;

  // 2. The eye: far enough back and high enough that the windscreen's lower
  // edge is about 14 degrees below eye level (so the dash takes no more than
  // the bottom third of the view) and its top edge about 20 degrees above. A
  // tall windscreen (a bus) seats you higher, up to 60% of the way up it.
  const H = T.y - B.y;
  const L = Math.max(0, B.z - T.z);
  let D = clamp((H + tanD(20) * L) / (tanD(14) + tanD(20)), 0.55, 1.3);
  let ey = B.y + Math.max(D * tanD(14), Math.min(0.6 * H, H - (D - L) * tanD(20)));
  let roof = ey + 0.3;
  let open = true; // no roof found over the head: a convertible with its top down
  // Keep the head under the roof; a low roof (a sports car) moves the seat
  // forward instead, so the dash still sits low in the view.
  for (let i = 0; i < 2; i++) {
    const up = cast(ex, ey, B.z - D, 0, 1, 0);
    if (up.kind) {
      roof = up.y;
      open = false;
    }
    ey = Math.min(ey, roof - 0.08);
    D = clamp(Math.min(D, (ey - B.y) / tanD(14)), 0.55, 1.3);
  }
  const ez = B.z - D;
  // Some models have solid parts inside the cab (a dash or engine cover) that
  // would hide the road: sit higher until the windscreen is in clear view.
  const clear = () =>
    [0.35, 0.6, 0.85].every((t) => {
      const ty = B.y + t * H;
      const tz = B.z + t * (T.z - B.z);
      const h = cast(ex, ey, ez, 0, ty - ey, tz - ez);
      return h.kind !== 2 || Math.hypot(h.y - ey, h.z - ez) > Math.hypot(ty - ey, tz - ez) - 0.05;
    });
  for (let i = 0; i < 8 && ey + 0.04 < roof - 0.08 && !clear(); i++) ey += 0.04;
  const aB = atanD(ey - B.y, B.z - ez);
  const aT = T.z - ez > 0.05 ? atanD(T.y - ey, T.z - ez) : 60;

  // 3. Pillars: sweep sideways from the eye, just above the dash and just
  // under the roof, for where the glass stops (inner edge) and starts again
  // (outer edge). A pillar near the middle is a split windscreen's.
  const sweep = (s, pitch) => {
    const cp = Math.cos(pitch * DEG);
    const sp = Math.sin(pitch * DEG);
    const at = (yaw) => cast(ex, ey, ez, s * Math.sin(yaw * DEG) * cp, sp, Math.cos(yaw * DEG) * cp);
    const edges = [];
    let prevYaw = 0;
    let prev = at(0).kind === 1;
    for (let yaw = 3; yaw <= 84 && edges.length < 4; yaw += 3) {
      const now = at(yaw).kind === 1;
      if (now !== prev) {
        let a = prevYaw;
        let b = yaw;
        for (let i = 0; i < 6; i++) {
          const m = (a + b) / 2;
          if ((at(m).kind === 1) === prev) a = m;
          else b = m;
        }
        // The point on the pillar's side of the edge.
        const h = at(prev ? b : a);
        edges.push({ inner: prev, p: h.kind ? point() : null });
      }
      prev = now;
      prevYaw = yaw;
    }
    // Only real pillars of the windscreen's frame: not a wiper (too thin) or
    // a door pillar further back.
    const pillars = [];
    for (let i = 0; i < edges.length; i++) {
      if (!edges[i].inner || !edges[i].p) continue;
      const out = edges[i + 1] && !edges[i + 1].inner ? edges[i + 1].p : null;
      const p = edges[i].p;
      if (p.z < T.z - 0.25) continue;
      if (out && Math.hypot(out.x - p.x, out.y - p.y, out.z - p.z) < 0.025) continue;
      pillars.push({ inner: p, outer: out });
    }
    const centre = pillars.find((p) => Math.abs(p.inner.x) < 0.25 * hw) ?? null;
    return { a: pillars.find((p) => p !== centre) ?? null, centre };
  };
  const pillars = { left: null, right: null, centre: null };
  const same = (a, b) => Math.abs(a.inner.x - b.inner.x) < 0.35;
  for (const [key, s] of [["left", -1], ["right", 1]]) {
    const low = sweep(s, -(aB - 4));
    const high = sweep(s, Math.min(aT - 4, 25));
    if (low.a && high.a && same(low.a, high.a)) pillars[key] = { low: low.a, high: high.a };
    if (low.centre && high.centre) pillars.centre = { low: low.centre, high: high.centre };
  }
  // The models are symmetrical: a pillar found on one side only is copied.
  const flip = (pl) => {
    const f = (p) => p && { x: -p.x, y: p.y, z: p.z };
    return { low: { inner: f(pl.low.inner), outer: f(pl.low.outer) }, high: { inner: f(pl.high.inner), outer: f(pl.high.outer) } };
  };
  if (!pillars.left && pillars.right) pillars.left = flip(pillars.right);
  if (!pillars.right && pillars.left) pillars.right = flip(pillars.left);

  // 4. Window sills each side, at the seat and further forward.
  const zWin = B.z + ((ey - B.y) / Math.max(H, 0.01)) * (T.z - B.z); // windscreen at eye height
  const sill = (s, z) => {
    const at = (p) => cast(ex, ey, z, s * Math.cos(p * DEG), Math.sin(p * DEG), 0);
    let prev = at(-70).kind === 1;
    let prevP = -70;
    for (let p = -64; p <= 40; p += 4) {
      const now = at(p).kind === 1;
      if (now && !prev) {
        let a = prevP;
        let b = p;
        for (let i = 0; i < 6; i++) {
          const m = (a + b) / 2;
          if (at(m).kind === 1) b = m;
          else a = m;
        }
        at(b);
        return { x: hit.x, y: hit.y, z };
      }
      prev = now;
      prevP = p;
    }
    return null;
  };
  const zFwd = Math.min(ez + 0.4 * D, zWin - 0.08);
  // (The one further forward only counts if it carries on the same line.)
  const sillPair = (s) => {
    const a = sill(s, ez);
    const b = sill(s, zFwd);
    return a && b && (Math.abs(a.y - b.y) > 0.12 || Math.abs(a.x - b.x) > 0.15) ? [a, null] : [a, b];
  };
  const sills = { left: sillPair(-1), right: sillPair(1) };

  return {
    eye: new Vector3(ex, ey, ez),
    // A bus or cab-over truck has its windscreen right at the front.
    shape: g.length > 6.2 && g.front - B.z < 0.7 ? "bus" : g.height > 1.9 ? "van" : "car",
    base: B,
    top: T,
    aB,
    aT,
    roof,
    open,
    hw,
    pillars,
    sills,
    paint: null,
  };
}

// The body colour where a ray from outside meets the driver's door below the
// window, read once from the paint picture, for the door tops inside.
// (The pictures are compressed in graphics memory, so a small copy is read.)
export async function samplePaint(body, meshes, fit) {
  const solid = meshes.filter((m) => /^car_Panel/.test(m.name));
  const wm = body.computeWorldMatrix(true);
  const sill = fit.sills.left[0] ?? fit.sills.left[1];
  const y = sill ? sill.y : fit.eye.y - 0.3;
  const colours = [];
  const N = 64;
  const pictures = new Map();
  // Nine spots on the door; the middle colour wins, so a stripe or a badge can't.
  for (const dy of [0.1, 0.25, 0.4]) {
    for (const dz of [-0.25, 0, 0.25]) {
      const ray = new Ray(Vector3.TransformCoordinates(new Vector3(-(fit.hw + 1), y - dy, fit.eye.z + dz), wm), Vector3.TransformNormal(new Vector3(1, 0, 0), wm), 3);
      let pick = null;
      for (const m of solid) {
        const p = ray.intersectsMesh(m, false);
        if (p.hit && (!pick || p.distance < pick.distance)) pick = p;
      }
      const mat = pick?.pickedMesh?.material;
      if (!mat) continue;
      const tint = mat.albedoColor ?? Color3.White();
      let rgb = [1, 1, 1];
      const uv = mat.albedoTexture && pick.getTextureCoordinates();
      if (uv) {
        if (!pictures.has(mat.albedoTexture)) pictures.set(mat.albedoTexture, await GetTextureDataAsync(mat.albedoTexture, N, N));
        const data = pictures.get(mat.albedoTexture);
        const i = (clamp(Math.floor(uv.y * N), 0, N - 1) * N + clamp(Math.floor(uv.x * N), 0, N - 1)) * 4;
        rgb = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255].map((v) => v ** 2.2);
      }
      colours.push([rgb[0] * tint.r, rgb[1] * tint.g, rgb[2] * tint.b]);
    }
  }
  if (!colours.length) return null;
  // The colour most of the spots agree on (not a stripe, a badge or a sign).
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 0.12;
  const votes = colours.map((c) => colours.filter((d) => near(c, d)).length);
  return colours[votes.indexOf(Math.max(...votes))];
}

// ---------- The kit ----------------------------------------------------------------

const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const A0 = 135 * DEG; // dials run clockwise from bottom left...
const SWEEP = 270 * DEG; // ...to bottom right
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Unlit: shows the picture as drawn whatever the light, so it reads at night.
function glowMaterial(scene, name, texture) {
  const m = new PBRMaterial(name, scene);
  m.unlit = true;
  m.albedoTexture = texture;
  m.albedoColor = new Color3(0.9, 0.9, 0.9);
  m.backFaceCulling = false;
  m.fogEnabled = false;
  return m;
}

export class Cabin {
  constructor(scene, { vehicle, fuel, damage, daynight, settings, minimap }) {
    this.scene = scene;
    this.vehicle = vehicle;
    this.fuel = fuel;
    this.damage = damage;
    this.daynight = daynight;
    this.settings = settings;
    this.minimap = minimap;
    this.root = new TransformNode("cabin", scene);
    this.root.setEnabled(false);
    this.parts = [];
    this.car = null;
    this.shown = false;
    this.spin = null;

    // One material for the whole kit, dark and matt, unlit: its shading is in
    // the vertex colours. (Lit, it cost a millisecond or two a frame, as it
    // covers a third of the screen.) It just dims as night falls.
    this.trimMat = glowMaterial(scene, "cabinTrim", null);
    this.trimMat.albedoColor.set(1, 1, 1);
    this.light = -1;
    // (The mirror is dark glass. A real view behind, even small and every
    // third frame, cost 8 ms a frame on High, so there isn't one.)

    // Instrument cluster and centre screen: pictures drawn in code, glowing so
    // they read at night. (No mipmaps: they are always seen close up.)
    this.cluster = new DynamicTexture("cabinCluster", { width: 512, height: 256 }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
    this.screen = new DynamicTexture("cabinScreen", { width: 256, height: 160 }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
    this.clusterMat = glowMaterial(scene, "cabinClusterMat", this.cluster);
    this.screenMat = glowMaterial(scene, "cabinScreenMat", this.screen);
    // Blank to start with: a picture that was never drawn never counts as
    // ready, and the game waits for everything to be ready before it starts.
    for (const t of [this.cluster, this.screen]) {
      const c = t.getContext();
      c.fillStyle = "#020304";
      c.fillRect(0, 0, t.getSize().width, t.getSize().height);
      t.update();
    }
    // The dial faces (numbers and marks) are drawn once into here, then copied
    // under the needles at each redraw.
    this.face = document.createElement("canvas");
    this.face.width = 512;
    this.face.height = 256;
    this.shownDials = { speed: -1, rev: -1, fuel: -1, gear: -1, warn: -1, mph: null, electric: null, top: 0, redline: 0 };
    this.dialTimer = 0;
    this.screenTimer = 0;
    this.glow = -1;
  }

  // Use this vehicle. Call it before the old one is disposed: the kit hangs
  // off the vehicle's body, and goes with it otherwise.
  setCar(car) {
    if (this.car && this.car !== car) this._glass(this.car, true);
    // (Children before parents: the wheel hangs off its pivot.)
    for (let i = this.parts.length - 1; i >= 0; i--) if (!this.parts[i].isDisposed()) this.parts[i].dispose();
    this.parts = [];
    this.spin = null;
    this.car = car;
    this.root.parent = car.body;
    if (car.cockpit) this._build(car.cockpit);
    this.shownDials.speed = -1;
    this.shownDials.top = 0;
    this._apply();
  }

  // Whether the kit is on screen now (the concept car has its own cabin).
  get kitShown() {
    return this.shown && !!this.car?.cockpit;
  }

  // Only from the driver's seat; everywhere else the kit is hidden and the
  // windows are back.
  setShown(on) {
    if (on === this.shown) return;
    this.shown = on;
    this._apply();
  }

  _apply() {
    const kit = this.shown && !!this.car?.cockpit;
    this.root.setEnabled(kit);
    if (this.car) this._glass(this.car, !kit);
  }

  // The tinted windows darken the whole view from inside, so they go while
  // you sit there (the downloaded vehicles only; the concept car keeps its own).
  // A real car's own inside goes too: the kit is its cockpit, as in every
  // other vehicle (the two together would clash).
  _glass(car, visible) {
    if (!car.cockpit) return;
    for (const m of car.meshes) if (/^car_(Glass|Interior)/.test(m.name)) m.isVisible = visible;
  }

  // Every frame while shown.
  update(dt) {
    if (!this.car?.cockpit) return;
    const v = this.vehicle;
    // The same turn as the on-screen wheel (160 degrees each way).
    if (this.spin) this.spin.rotation.y = v.steerInput * 2.8;
    const lights = smoothstep(0.2, 0.55, this.daynight.night);
    const light = Math.round(lerp(1, 0.12, smoothstep(0.1, 0.9, this.daynight.night)) * 50) / 50;
    if (light !== this.light) {
      this.light = light;
      this.trimMat.albedoColor.set(light, light, light);
    }
    // Dimmer at night (the picture is brightened then), so it doesn't glare.
    const glow = Math.round(lerp(0.95, 0.5, lights) * 50) / 50;
    if (glow !== this.glow) {
      this.glow = glow;
      this.clusterMat.albedoColor.set(glow, glow, glow);
      this.screenMat.albedoColor.set(glow * 0.9, glow * 0.9, glow * 0.9);
    }
    this.dialTimer -= dt;
    if (this.dialTimer <= 0) this._dials(lights > 0.3);
    this.screenTimer -= dt;
    if (this.screenTimer <= 0) {
      this.screenTimer = 0.25;
      this._screen();
    }
  }

  // ---------- Building ----------

  _own(mesh, parent = this.root) {
    mesh.parent = parent;
    mesh.isPickable = false;
    // Drawn after the world, so the vehicle's own (black) inside never shows through.
    mesh.renderingGroupId = 1;
    this.parts.push(mesh);
    return mesh;
  }

  // A flat panel facing direction n (for the dials, screen and mirror glass),
  // with colours for its corners if given (bottom left, then anticlockwise).
  _panel(name, c, n, w, h, material, colours = null) {
    const r = rightOf(n);
    const u = upOf(n);
    const g = new GeometryBuilder();
    const p = (sx, sy) => add(add(c, scale(r, (sx * w) / 2)), scale(u, (sy * h) / 2));
    g.addQuad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), n, [0, 0], [1, 0], [1, 1], [0, 1]);
    const mesh = g.toMesh(name, this.scene);
    if (colours) mesh.setVerticesData(VertexBuffer.ColorKind, colours.flatMap((k) => [k[0], k[1], k[2], 1]));
    mesh.material = material;
    return this._own(mesh);
  }

  _build(f) {
    const P = SHAPES[f.shape];
    const E = [f.eye.x, f.eye.y, f.eye.z];
    const [ex, ey, ez] = E;
    const B = f.base;
    const T = f.top;
    // Height of a point d metres ahead that sits `deg` degrees below eye level.
    const yAt = (d, deg) => ey - d * tanD(deg);
    const kit = new Kit(E);

    // Side walls: the doors' inside faces, where the sills were measured.
    const wall = (s) => {
      const p = (s < 0 ? f.sills.left : f.sills.right).find(Boolean);
      return p ? p.x - s * 0.015 : s * (f.hw - 0.1);
    };
    const xL = wall(-1);
    const xR = wall(1);
    const across = xs(xL, xR, 7);
    const along = (rows, x0, x1, n, colour) => kit.sheet(rows.map(([y, z]) => xs(x0, x1, n).map((x) => [x, y, z])), colour);

    // Dashboard. Its front edge meets the windscreen where the glass starts (it
    // hides the body's own black inside below that), but no higher than 14.5
    // degrees below eye level, so the road stays clear.
    const aF = Math.min(f.aB, 14.5);
    let fy = B.y;
    let fz = B.z;
    if (aF < f.aB - 0.01) {
      const t = tanD(aF);
      const dz = T.z - B.z;
      const s = clamp((ey - B.y - t * (B.z - ez)) / (T.y - B.y + t * dz), 0, 1);
      fy = B.y + s * (T.y - B.y);
      fz = B.z + s * dz;
    }
    fz += 0.02;
    const dL = Math.min(P.lip, fz - ez - 0.12);
    const aL = aF + 2.5;
    const yL = yAt(dL, aL);
    const zL = ez + dL;
    along([[fy, fz], [lerp(fy, yL, 0.55) + 0.01, lerp(fz, zL, 0.55)], [yL + 0.004, zL + 0.025], [yL - 0.012, zL], [yL - 0.04, zL + 0.006], [yL - 0.42, zL + 0.09]], xL, xR, 7, DASH);
    // How far ahead the dash's face is at height y (it slopes away lower down).
    const faceZ = (y) => zL + 0.006 + clamp((yL - 0.04 - y) / 0.38, 0, 1) * 0.084;

    // Instrument cluster under a hood, in front of the driver.
    const W = P.clusterW;
    const Hc = W / 2;
    const dC = dL - 0.035;
    const aCt = aL + 1.6;
    const C = [ex, yAt(dC, aCt + atanD(Hc / 2, dC)), ez + dC];
    const nC = normalize(sub(E, C));
    this._panel("cabinCluster", C, nC, W, Hc, this.clusterMat);
    kit.box(add(C, scale(nC, -0.006)), scale(rightOf(nC), W / 2 + 0.012), scale(upOf(nC), Hc / 2 + 0.012), scale(nC, 0.004), VENT);
    const topY = yAt(dC, aCt);
    const hx = [ex - W / 2 - 0.035, ex + W / 2 + 0.035];
    along([[topY + 0.028, C[2] + 0.04], [topY + 0.034, C[2] - 0.01], [topY + 0.022, C[2] - 0.055], [topY + 0.006, C[2] - 0.05]], hx[0], hx[1], 5, DASH);
    const bot = C[1] - Hc / 2 - 0.015;
    for (const x of hx) kit.quad([x, topY + 0.022, C[2] - 0.055], [x, topY + 0.028, C[2] + 0.04], [x, bot, C[2] + 0.04], [x, bot, C[2] - 0.035], DASH);

    // Steering wheel: its rim top just meets the dash line.
    const R = P.wheelR;
    const col = P.column * DEG;
    const dW = Math.min(P.wheelD, dC - 0.1);
    const yW = ey - tanD(aF - 0.5) * (dW + R * Math.sin(col)) - R * Math.cos(col);
    this._wheel([ex, yW, ez + dW], R, col);

    // Centre screen (the map), standing on top of the dash like the floating
    // screens in modern cars. (Lower down, in the dash face, it would sit
    // behind the on-screen pedals on a touch screen.)
    const ws = P.screenW;
    const hs = ws / 1.6;
    const sX = Math.min(0, hx[1] + 0.03 + ws / 2);
    const zS = zL + 0.06;
    const dashTop = yL + (fy - yL) * clamp((zS - zL) / Math.max(fz - zL, 0.01), 0, 1);
    const sBot = dashTop + 0.025;
    const S = [sX, sBot + hs / 2, zS];
    const nS = normalize(sub(E, S));
    this._panel("cabinScreen", S, nS, ws, hs, this.screenMat);
    kit.box(add(S, scale(nS, -0.012)), scale(rightOf(nS), ws / 2 + 0.012), scale(upOf(nS), hs / 2 + 0.012), scale(nS, 0.011), VENT);
    // Its stand, down to the dash.
    kit.box([sX, (dashTop + sBot) / 2, zS + 0.03], [0.03, 0, 0], [0, (sBot - dashTop) / 2 + 0.01, 0], [0, 0, 0.012], VENT);

    // Air vents: in the dash face below either side of the screen, and at each
    // end of the dash. (sY is the middle of that band; the console starts below.)
    const sY = yL - 0.05 - hs / 2;
    const vent = (x, y, w, h) => {
      const zt = faceZ(y + h / 2) - 0.004;
      const zb = faceZ(y - h / 2) - 0.004;
      kit.quad([x - w / 2, y - h / 2, zb], [x + w / 2, y - h / 2, zb], [x + w / 2, y + h / 2, zt], [x - w / 2, y + h / 2, zt], VENT);
      for (let i = 1; i <= 3; i++) {
        const sy = y - h / 2 + (h * i) / 4;
        const sz = lerp(zb, zt, i / 4) - 0.004;
        kit.quad([x - w / 2 + 0.005, sy - 0.003, sz + 0.002], [x + w / 2 - 0.005, sy - 0.003, sz + 0.002], [x + w / 2 - 0.005, sy + 0.003, sz - 0.002], [x - w / 2 + 0.005, sy + 0.003, sz - 0.002], SLAT);
      }
    };
    for (const sx of [-1, 1]) {
      const x = sX + sx * (ws / 2 + 0.05);
      if (x - 0.035 > hx[1] || x + 0.035 < hx[0]) vent(x, sY + hs * 0.15, 0.06, 0.045);
    }
    vent(xL + 0.1, yL - 0.075, 0.085, 0.055);
    vent(xR - 0.1, yL - 0.075, 0.085, 0.055);

    // Centre console, from below the screen back between the seats.
    if (P.console) {
      const cw = P.console;
      const y0 = sY - hs / 2 - 0.035;
      const prof = [[y0, faceZ(y0) - 0.01], [ey - 0.52, ez + 0.32], [ey - 0.54, ez - 0.15]];
      along(prof, -cw, cw, 2, TRIM);
      for (const sx of [-cw, cw]) {
        const [a, b, c] = prof;
        kit.quad([sx, a[0], a[1]], [sx, b[0], b[1]], [sx, ey - 0.9, b[1]], [sx, ey - 0.9, a[1] + 0.05], shade(TRIM, 0.8));
        kit.quad([sx, b[0], b[1]], [sx, c[0], c[1]], [sx, ey - 0.9, c[1]], [sx, ey - 0.9, b[1]], shade(TRIM, 0.8));
      }
    }

    // A-pillars (and a split windscreen's middle pillar), on the measured edges
    // of the glass, from the dash up into the roof lining.
    const yBot = fy - 0.03;
    const yTop = T.y + 0.05;
    const P3 = (p) => [p.x, p.y, p.z];
    const pillar = (pl, s) => {
      // Along the line through the two measured points (not too far beyond them).
      const lerpY = (a, b, y) => {
        if (Math.abs(b[1] - a[1]) < 0.06) return [a[0], y, a[2]];
        const p = add(a, scale(sub(b, a), clamp((y - a[1]) / (b[1] - a[1]), -0.6, 1.6)));
        return [p[0], y, p[2]];
      };
      const outer = (edge) => (edge.outer ? P3(edge.outer) : add(P3(edge.inner), [s * 0.07, 0, -0.02]));
      const iB = lerpY(P3(pl.low.inner), P3(pl.high.inner), yBot);
      const iT = lerpY(P3(pl.low.inner), P3(pl.high.inner), yTop);
      const oB = lerpY(outer(pl.low), outer(pl.high), yBot);
      const oT = lerpY(outer(pl.low), outer(pl.high), yTop);
      kit.quad(iB, oB, oT, iT, LINING);
      const toward = (p) => add(p, scale(normalize(sub(E, p)), 0.03));
      kit.quad(iB, iT, toward(iT), toward(iB), shade(LINING, 0.65));
    };
    // (None where the model has none: a bus's glass wraps round the corner.)
    if (f.pillars.left) pillar(f.pillars.left, -1);
    if (f.pillars.right) pillar(f.pillars.right, 1);
    if (f.pillars.centre) pillar(f.pillars.centre, 1);

    // Roof lining along the top of the windscreen, and the sun visors folded
    // up flat against it (only their front edges show). None with the top down.
    const roofY = Math.max(f.roof - 0.02, T.y + 0.03);
    const backZ = Math.min(ez + 0.05, T.z - 0.1);
    const lining = [[T.y - 0.014, T.z - 0.012], [T.y + 0.006, T.z - 0.045], [roofY, backZ]];
    if (!f.open) kit.sheet(lining.map(([y, z]) => across.map((x) => [x, y, z])), LINING);
    const [, l1, l2] = lining;
    const run = normalize([0, l2[0] - l1[0], l2[1] - l1[1]]);
    if (run[2] < -0.3 && !f.open) {
      const v0 = [0, l1[0] - 0.014, l1[1] - 0.012];
      const half = scale(run, 0.085);
      for (const vx of [ex, -ex]) {
        kit.box(add([vx, v0[1], v0[2]], half), [P.visorW / 2, 0, 0], scale([0, -run[2], run[1]], 0.01), half, shade(LINING, 1.2));
      }
    }

    // Rear-view mirror on a stem, hung off the top of the windscreen (a little
    // toward the driver, so it's in view).
    const mw = P.mirrorW;
    const mh = mw * 0.3;
    const glassZ = (y) => B.z + ((y - B.y) / Math.max(T.y - B.y, 0.01)) * (T.z - B.z);
    const my = Math.max(T.y - 0.03 - mh / 2 - clamp((T.y - ey) * 0.3, 0, 0.06), ey + 0.03 + mh / 2);
    const M = [ex * 0.3, my, Math.max(glassZ(my) - 0.05, ez + 0.3)];
    const nM = normalize(sub(E, M));
    kit.box(add(M, scale(nM, -0.012)), scale(rightOf(nM), mw / 2 + 0.008), scale(upOf(nM), mh / 2 + 0.008), scale(nM, 0.014), DASH);
    const s0 = [M[0], my + mh / 2, M[2] + 0.01];
    const s1 = [M[0], T.y + 0.01, glassZ(T.y) - 0.02];
    kit.box(scale(add(s0, s1), 0.5), [0.008, 0, 0], scale(sub(s1, s0), 0.5), scale(normalize(cross([1, 0, 0], sub(s1, s0))), 0.008), DASH);
    // Dark glass, catching a little sky at the top.
    const glass = [[0.025, 0.028, 0.032], [0.04, 0.045, 0.05], [0.13, 0.14, 0.16], [0.06, 0.066, 0.075]];
    this._panel("cabinMirror", add(M, scale(nM, 0.003)), nM, mw, mh, this.trimMat, glass);

    // Door tops: a rubber seal at the glass, a strip in the body colour, then
    // the door's trim going down.
    const paint = f.paint ?? [0.08, 0.08, 0.09];
    for (const s of [-1, 1]) {
      const [a, b] = s < 0 ? f.sills.left : f.sills.right;
      const p0 = a ?? b;
      if (!p0) continue;
      const p1 = b ?? a;
      const sillAt = (z) => {
        if (Math.abs(p1.z - p0.z) < 0.05) return [p0.x, p0.y];
        const t = clamp((z - p0.z) / (p1.z - p0.z), -0.6, 1.6);
        return [lerp(p0.x, p1.x, t), lerp(p0.y, p1.y, t)];
      };
      const zs = [fz - 0.04, lerp(fz, ez, 0.5), ez, ez - 1.0];
      const strip = (pts, colour) =>
        kit.sheet(
          zs.map((z) => {
            const [sx, sy] = sillAt(z);
            return pts.map(([dx, dy]) => [sx - s * dx, sy + dy, z]);
          }),
          colour,
        );
      strip([[0.002, 0.014], [0.02, 0.007]], SEAL);
      strip([[0.02, 0.007], [0.05, 0.004], [0.078, -0.005]], paint);
      strip([[0.078, -0.005], [0.092, -0.02], [0.1, -0.06], [0.1, -0.42]], TRIM);
    }

    const mesh = kit.toMesh("cabinTrim", this.scene);
    mesh.material = this.trimMat;
    this._own(mesh);
  }

  // Rim, hub and three spokes, on a pivot tilted like a steering column. It
  // spins about the column; the pale mark shows the top.
  _wheel(pos, R, col) {
    const scene = this.scene;
    const pieces = [];
    // (Shaded for the column's tilt, as the rest of the kit.)
    const ca = Math.cos(col - Math.PI / 2);
    const sa = Math.sin(col - Math.PI / 2);
    const piece = (mesh, colour) => {
      const n = mesh.getTotalVertices();
      const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
      const c = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const [x, y, z] = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
        const k = lit([x, y * ca - z * sa, y * sa + z * ca]);
        c.set([colour[0] * k, colour[1] * k, colour[2] * k, 1], i * 4);
      }
      mesh.setVerticesData(VertexBuffer.ColorKind, c);
      pieces.push(mesh);
      return mesh;
    };
    piece(MeshBuilder.CreateTorus("cabinRim", { diameter: 2 * R, thickness: 0.032, tessellation: 36 }, scene), RIM);
    piece(MeshBuilder.CreateCylinder("cabinHub", { diameter: R * 0.6, height: 0.05, tessellation: 20 }, scene), RIM).position.y = -0.02;
    const len = R * 0.74;
    for (const sx of [-1, 1]) {
      const b = piece(MeshBuilder.CreateBox("cabinSpoke", { width: len, height: 0.014, depth: 0.05 }, scene), SPOKE);
      b.position.set(sx * (R * 0.27 + len / 2), -0.01, 0);
    }
    piece(MeshBuilder.CreateBox("cabinSpoke", { width: 0.05, height: 0.014, depth: len }, scene), SPOKE).position.set(0, -0.01, -(R * 0.27 + len / 2));
    piece(MeshBuilder.CreateBox("cabinMark", { width: 0.022, height: 0.036, depth: 0.036 }, scene), MARK).position.z = R;
    const wheel = Mesh.MergeMeshes(pieces, true, true);
    wheel.name = "cabinWheel";
    wheel.material = this.trimMat;
    const pivot = new TransformNode("cabinWheelPivot", scene);
    pivot.position.set(pos[0], pos[1], pos[2]);
    // Local +y is the column, pointing back up at the driver; +z is 12 o'clock.
    pivot.rotation.x = col - Math.PI / 2;
    this._own(pivot);
    this.spin = new TransformNode("cabinWheelSpin", scene);
    this._own(this.spin, pivot);
    this._own(wheel, this.spin);
  }

  // ---------- The dials ----------

  _dials(lights) {
    const v = this.vehicle;
    const f = this.fuel;
    const mph = this.settings.units === "mph";
    const electric = !!f.electric;
    // (Rounded the same way as the speed and fuel on the screen's corner.)
    const speed = Math.round(Math.abs(v.forwardSpeed) * (mph ? 2.23694 : 3.6));
    const rev = electric ? Math.round(clamp(v.throttle, 0, 1) * 50) * 2 : Math.round(v.rpm / 50) * 50;
    const fuel = Math.round(f.level * 100);
    const gear = v.forwardSpeed < -0.3 ? 0 : electric ? 1 : v.gear;
    const warn = (f.level <= 0.2 ? 1 : 0) | (this.damage.damage > 0.4 ? 2 : 0) | (lights ? 4 : 0);
    const top = this._dialTop(mph);
    const d = this.shownDials;
    const sameFace = d.mph === mph && d.electric === electric && d.top === top && d.redline === v.redline;
    if (sameFace && d.speed === speed && d.rev === rev && d.fuel === fuel && d.gear === gear && d.warn === warn) return;
    if (!sameFace) {
      d.mph = mph;
      d.electric = electric;
      d.top = top;
      d.redline = v.redline;
      this._drawFace(mph, electric, top);
    }
    d.speed = speed;
    d.rev = rev;
    d.fuel = fuel;
    d.gear = gear;
    d.warn = warn;
    // At most 15 redraws a second.
    this.dialTimer = 1 / 15;
    this._drawDials(mph, electric, top);
  }

  // The speedometer's top mark: a little over what this vehicle can reach.
  _dialTop(mph) {
    const v = this.vehicle;
    const geared = (v.redline / (v.gears[v.gears.length - 1] * 3.4 * 9.549)) * v.wheelRadius;
    const top = Math.min(geared, Math.cbrt(v.power / v.drag)) * (mph ? 2.23694 : 3.6) * 1.1;
    const step = top > 200 ? 40 : 20;
    return Math.max(step * 4, Math.ceil(top / step) * step);
  }

  _revTop() {
    return Math.ceil(this.vehicle.redline / 1000 + 0.5) * 1000;
  }

  _drawFace(mph, electric, top) {
    const c = this.face.getContext("2d");
    c.fillStyle = "#020304";
    c.fillRect(0, 0, 512, 256);
    // Left: revs (or power for an electric vehicle). Right: speed.
    if (electric) dialFace(c, 108, 132, 100, 100, 20, 10, (n) => n, 101, "POWER %");
    else {
      const max = this._revTop();
      dialFace(c, 108, 132, 100, max, 1000, 500, (n) => n / 1000, this.vehicle.redline, "x1000 rpm");
    }
    const major = top > 200 ? 40 : 20;
    dialFace(c, 404, 132, 100, top, major, major / 2, (n) => n, top + 1, null);
    c.fillStyle = "#7d8a98";
    c.font = `500 14px ${FONT}`;
    c.textAlign = "center";
    c.fillText(mph ? "mph" : "km/h", 404, 222);
    // Middle panel.
    roundRect(c, 214, 18, 84, 220, 12);
    c.fillStyle = "#06080b";
    c.fill();
    c.strokeStyle = "#1c2229";
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = "#56616d";
    c.font = `600 12px ${FONT}`;
    c.fillText(electric ? "BATTERY" : "FUEL", 256, 176);
  }

  _drawDials(mph, electric, top) {
    const c = this.cluster.getContext();
    const d = this.shownDials;
    c.drawImage(this.face, 0, 0);
    needle(c, 108, 132, 100, electric ? d.rev / 100 : d.rev / this._revTop());
    needle(c, 404, 132, 100, d.speed / top);
    c.textAlign = "center";
    c.fillStyle = "#eef3f8";
    c.font = `700 30px ${FONT}`;
    c.fillText(String(d.speed), 404, 200);
    // Gear.
    c.font = `700 40px ${FONT}`;
    c.fillText(d.gear === 0 ? "R" : electric ? "D" : `D${d.gear}`, 256, 138);
    // Fuel or battery: ten bars.
    const low = d.fuel <= 20;
    for (let i = 0; i < 10; i++) {
      const on = d.fuel > i * 10 + 2;
      c.fillStyle = !on ? "#151a20" : low ? "#ffb020" : electric ? "#52d0ff" : "#e8edf2";
      c.fillRect(222 + i * 7, 186, 5, 14);
    }
    c.fillStyle = low ? "#ffb020" : "#9aa7b4";
    c.font = `600 15px ${FONT}`;
    c.fillText(`${d.fuel}%`, 256, 222);
    // Warning lights: low fuel/charge, damage, headlights.
    icon(c, 232, 46, "fuel", d.warn & 1 ? "#ffb020" : "#1a1f25");
    icon(c, 256, 46, "warn", d.warn & 2 ? "#ff4433" : "#1a1f25");
    icon(c, 281, 46, "lamp", d.warn & 4 ? "#3ddc84" : "#1a1f25");
    this.cluster.update();
  }

  // ---------- The centre screen ----------

  _screen() {
    const c = this.screen.getContext();
    c.fillStyle = "#05080b";
    c.fillRect(0, 0, 256, 160);
    c.fillStyle = "#0e1822";
    c.beginPath();
    c.arc(80, 80, 72, 0, Math.PI * 2);
    c.fill();
    const map = this.minimap;
    if (map?.width) c.drawImage(map, 0, 0, map.width, map.height, 8, 8, 144, 144);
    c.textAlign = "center";
    c.fillStyle = "#e6edf3";
    c.font = `600 30px ${FONT}`;
    c.fillText(this.daynight.clock, 206, 70);
    const h = ((this.vehicle.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    c.fillStyle = "#8fa3b5";
    c.font = `600 20px ${FONT}`;
    c.fillText(COMPASS[Math.round(h / (Math.PI / 4)) % 8], 206, 108);
    this.screen.update();
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// A round dial: marks every `minor`, numbers every `major`, red from `red` up.
function dialFace(c, cx, cy, r, max, major, minor, label, red, caption) {
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fillStyle = "#0a0d11";
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = "#252c34";
  c.stroke();
  if (red < max) {
    c.beginPath();
    c.arc(cx, cy, r - 10, A0 + (SWEEP * red) / max, A0 + SWEEP);
    c.lineWidth = 8;
    c.strokeStyle = "#a8241c";
    c.stroke();
  }
  c.strokeStyle = "#c9d2dc";
  c.fillStyle = "#c9d2dc";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = `600 17px ${FONT}`;
  for (let n = 0; n <= max + 0.001; n += minor) {
    const a = A0 + (SWEEP * n) / max;
    const big = Math.abs(n / major - Math.round(n / major)) < 0.001;
    const r0 = r - (big ? 20 : 13);
    c.lineWidth = big ? 3 : 1.5;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    c.lineTo(cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5));
    c.stroke();
    if (big) c.fillText(String(label(n)), cx + Math.cos(a) * (r - 36), cy + Math.sin(a) * (r - 36));
  }
  c.textBaseline = "alphabetic";
  if (caption) {
    c.fillStyle = "#7d8a98";
    c.font = `500 13px ${FONT}`;
    c.fillText(caption, cx, cy + 52);
  }
}

function needle(c, cx, cy, r, frac) {
  c.save();
  c.translate(cx, cy);
  c.rotate(A0 + SWEEP * clamp(frac, 0, 1.03));
  c.beginPath();
  c.moveTo(-14, -4);
  c.lineTo(r - 16, -1.3);
  c.lineTo(r - 16, 1.3);
  c.lineTo(-14, 4);
  c.closePath();
  c.fillStyle = "#ff5a1f";
  c.fill();
  c.restore();
  c.beginPath();
  c.arc(cx, cy, 9, 0, Math.PI * 2);
  c.fillStyle = "#1b2026";
  c.fill();
}

// Small warning symbols, about 20 px across.
function icon(c, x, y, kind, colour) {
  c.fillStyle = colour;
  c.strokeStyle = colour;
  c.lineWidth = 2;
  if (kind === "fuel") {
    c.fillRect(x - 7, y - 8, 9, 16);
    c.beginPath();
    c.moveTo(x + 2, y - 4);
    c.lineTo(x + 7, y - 1);
    c.lineTo(x + 7, y + 6);
    c.stroke();
  } else if (kind === "warn") {
    c.beginPath();
    c.moveTo(x, y - 9);
    c.lineTo(x + 10, y + 8);
    c.lineTo(x - 10, y + 8);
    c.closePath();
    c.fill();
    c.fillStyle = "#020304";
    c.fillRect(x - 1.2, y - 3, 2.4, 6.5);
    c.fillRect(x - 1.2, y + 4.5, 2.4, 2);
  } else {
    c.beginPath();
    c.arc(x - 2, y, 7, -Math.PI / 2, Math.PI / 2);
    c.closePath();
    c.fill();
    for (const dy of [-5, 0, 5]) {
      c.beginPath();
      c.moveTo(x - 4, y + dy);
      c.lineTo(x - 11, y + dy + 1.5);
      c.stroke();
    }
  }
}
