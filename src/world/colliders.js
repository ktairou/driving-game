// Flat (top-down) collision shapes for things the car can hit: tree trunks,
// lamp posts and rocks are circles; building walls and guard rails are line
// segments. Stored in a coarse grid so each query only checks nearby shapes.
const CELL = 16;

export class Colliders {
  constructor() {
    this.cells = new Map();
  }

  _key(gx, gz) {
    return gx * 73856093 ^ gz * 19349663;
  }

  _insert(minX, minZ, maxX, maxZ, shape) {
    const gx0 = Math.floor(minX / CELL);
    const gx1 = Math.floor(maxX / CELL);
    const gz0 = Math.floor(minZ / CELL);
    const gz1 = Math.floor(maxZ / CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = this._key(gx, gz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(shape);
      }
    }
  }

  addCircle(x, z, r) {
    this._insert(x - r, z - r, x + r, z + r, { type: 0, x, z, r });
  }

  addSegment(ax, az, bx, bz) {
    this._insert(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), { type: 1, ax, az, bx, bz });
  }

  // Box given by centre, half sizes and yaw (radians).
  addBox(cx, cz, hx, hz, yaw = 0) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const corner = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    const p = [corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)];
    for (let i = 0; i < 4; i++) {
      const a = p[i];
      const b = p[(i + 1) % 4];
      this.addSegment(a[0], a[1], b[0], b[1]);
    }
  }

  // Pushes a circle (x, z, r) out of everything it overlaps.
  // Returns { x, z, nx, nz, depth } for the deepest contact, or null.
  resolveCircle(x, z, r) {
    const seen = new Set();
    let hit = null;
    const gx0 = Math.floor((x - r) / CELL);
    const gx1 = Math.floor((x + r) / CELL);
    const gz0 = Math.floor((z - r) / CELL);
    const gz1 = Math.floor((z + r) / CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const list = this.cells.get(this._key(gx, gz));
        if (!list) continue;
        for (const s of list) {
          if (seen.has(s)) continue;
          seen.add(s);
          let px;
          let pz;
          let rr = r;
          if (s.type === 0) {
            px = s.x;
            pz = s.z;
            rr = r + s.r;
          } else {
            const abx = s.bx - s.ax;
            const abz = s.bz - s.az;
            const len2 = abx * abx + abz * abz || 1e-6;
            let t = ((x - s.ax) * abx + (z - s.az) * abz) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            px = s.ax + abx * t;
            pz = s.az + abz * t;
          }
          const dx = x - px;
          const dz = z - pz;
          const d = Math.hypot(dx, dz);
          if (d < rr && d > 1e-5) {
            const depth = rr - d;
            const nx = dx / d;
            const nz = dz / d;
            x += nx * depth;
            z += nz * depth;
            if (!hit || depth > hit.depth) hit = { nx, nz, depth };
          }
        }
      }
    }
    return hit ? { x, z, ...hit } : null;
  }
}
