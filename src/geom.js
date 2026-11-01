import { Mesh, VertexData } from "@babylonjs/core";

// Collects triangles with explicit normals/uvs and turns them into one mesh.
// Triangle winding is chosen from the wanted normal, matching the formula
// Babylon's own ComputeNormals uses, so faces always point the right way.
export class GeometryBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
    this.extra = null; // optional per-vertex custom data, e.g. { name, stride, data }
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  addVertex(p, n, uv) {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(uv[0], uv[1]);
    return this.vertexCount - 1;
  }

  // Adds a triangle (a, b, c are vertex indices) facing along `facing`.
  addTriangle(a, b, c, facing) {
    const P = this.positions;
    const p1p2 = [P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]];
    const p3p2 = [P[c * 3] - P[b * 3], P[c * 3 + 1] - P[b * 3 + 1], P[c * 3 + 2] - P[b * 3 + 2]];
    const n = [
      p1p2[1] * p3p2[2] - p1p2[2] * p3p2[1],
      p1p2[2] * p3p2[0] - p1p2[0] * p3p2[2],
      p1p2[0] * p3p2[1] - p1p2[1] * p3p2[0],
    ];
    if (n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  // Quad p0-p1-p2-p3 (in order around the edge), all vertices sharing normal n.
  addQuad(p0, p1, p2, p3, n, uv0, uv1, uv2, uv3, normals) {
    const i0 = this.addVertex(p0, normals ? normals[0] : n, uv0);
    const i1 = this.addVertex(p1, normals ? normals[1] : n, uv1);
    const i2 = this.addVertex(p2, normals ? normals[2] : n, uv2);
    const i3 = this.addVertex(p3, normals ? normals[3] : n, uv3);
    this.addTriangle(i0, i1, i2, n);
    this.addTriangle(i0, i2, i3, n);
    return i0;
  }

  toMesh(name, scene, { updatable = false } = {}) {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.normals = this.normals;
    vd.uvs = this.uvs;
    vd.indices = this.indices;
    vd.applyToMesh(mesh, updatable);
    if (this.extra) mesh.setVerticesData(this.extra.name, this.extra.data, false, this.extra.stride);
    return mesh;
  }
}

export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
