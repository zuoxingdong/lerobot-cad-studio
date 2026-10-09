/* Soft shading for CAD meshes (STL facets, the web LOD's joined parts): crease-angle normals, smooth
   across facets that meet at under CREASE and sharp elsewhere, and a per-vertex ambient occlusion from
   short rays through a voxel grid of every mesh in its current pose (plus the floor), as a `color`
   attribute.  Pure maths on typed arrays; works in mm (opts.scale converts from the meshes' unit). */

const CREASE = 34 * Math.PI / 180;
export const AO = { rays: 14, reach_mm: 36, strength: 0.9, floor: 0.35, cells: 8e6 };

/* cosine-weighted directions about +z (a Fibonacci spiral) */
function hemisphere(n) {
  const d = new Float32Array(3 * n);
  for (let k = 0; k < n; k++) {
    const u = (k + 0.5) / n, r = Math.sqrt(u), a = k * 2.399963;
    d[3 * k] = r * Math.cos(a); d[3 * k + 1] = r * Math.sin(a); d[3 * k + 2] = Math.sqrt(1 - u);
  }
  return d;
}

/** corner positions of a geometry through a 4x4 (column-major elements) times s, as a Float32Array */
export function cornersOf(geo, e, s = 1) {
  const p = geo.attributes.position, idx = geo.index, n = idx ? idx.count : p.count, out = new Float32Array(3 * n);
  for (let c = 0; c < n; c++) {
    const i = idx ? idx.getX(c) : c, x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    out[3 * c] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * s;
    out[3 * c + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * s;
    out[3 * c + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * s;
  }
  return out;
}

/** welded vertices of corner positions (1 um): {vid per corner, nv, first/list: the corners of each vertex} */
export function weld(P, q = 1000) {
  const n = P.length / 3;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const slot = new Int32Array(size).fill(-1), key = new Int32Array(3 * n), vid = new Int32Array(n);
  let nv = 0;
  for (let c = 0; c < n; c++) {
    const a = Math.round(P[3 * c] * q), b = Math.round(P[3 * c + 1] * q), d = Math.round(P[3 * c + 2] * q);
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(d, 83492791)) & (size - 1);
    for (;;) {
      const s = slot[h];
      if (s < 0) { slot[h] = nv; key[3 * nv] = a; key[3 * nv + 1] = b; key[3 * nv + 2] = d; vid[c] = nv++; break; }
      if (key[3 * s] === a && key[3 * s + 1] === b && key[3 * s + 2] === d) { vid[c] = s; break; }
      h = (h + 1) & (size - 1);
    }
  }
  const first = new Int32Array(nv + 1), list = new Int32Array(n);
  for (let c = 0; c < n; c++) first[vid[c] + 1]++;
  for (let v = 0; v < nv; v++) first[v + 1] += first[v];
  const fill = first.slice(0, nv);
  for (let c = 0; c < n; c++) list[fill[vid[c]]++] = c;
  return { vid, nv, first, list };
}

/** per triangle: the area-weighted normal (|n| = 2 area) and the unit normal */
function faceNormals(P) {
  const nt = P.length / 9, W = new Float32Array(3 * nt), U = new Float32Array(3 * nt);
  for (let t = 0; t < nt; t++) {
    const o = 9 * t;
    const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
    const bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
    const x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx, l = Math.hypot(x, y, z) || 1;
    W[3 * t] = x; W[3 * t + 1] = y; W[3 * t + 2] = z;
    U[3 * t] = x / l; U[3 * t + 1] = y / l; U[3 * t + 2] = z / l;
  }
  return { W, U };
}

/** crease-angle normals per corner (the corners' own frame) */
export function creaseNormals(P, W, U, wv, crease = CREASE) {
  const n = P.length / 3, N = new Float32Array(3 * n), cos = Math.cos(crease), { vid, first, list } = wv;
  for (let c = 0; c < n; c++) {
    const t = (c / 3) | 0, v = vid[c];
    let x = 0, y = 0, z = 0;
    for (let k = first[v]; k < first[v + 1]; k++) {
      const t2 = (list[k] / 3) | 0;
      if (U[3 * t] * U[3 * t2] + U[3 * t + 1] * U[3 * t2 + 1] + U[3 * t + 2] * U[3 * t2 + 2] < cos) continue;
      x += W[3 * t2]; y += W[3 * t2 + 1]; z += W[3 * t2 + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    N[3 * c] = x / l; N[3 * c + 1] = y / l; N[3 * c + 2] = z / l;
  }
  return N;
}

/** a voxel grid of corner sets (mm) over their bounds and the reach */
export function voxelGrid(sets, reach = AO.reach_mm, cells = AO.cells) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const P of sets) for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) {
    if (P[i + k] < lo[k]) lo[k] = P[i + k];
    if (P[i + k] > hi[k]) hi[k] = P[i + k];
  }
  for (let k = 0; k < 3; k++) { lo[k] -= reach; hi[k] += reach; }
  const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  const v = Math.max(1.5, Math.cbrt(vol / cells));
  const d = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k] - lo[k]) / v)));
  const G = { lo, v, d, bits: new Uint8Array(d[0] * d[1] * d[2]) };
  const mark = (x, y, z) => {
    const i = ((x - lo[0]) / v) | 0, j = ((y - lo[1]) / v) | 0, k = ((z - lo[2]) / v) | 0;
    if (i >= 0 && j >= 0 && k >= 0 && i < d[0] && j < d[1] && k < d[2]) G.bits[(k * d[1] + j) * d[0] + i] = 1;
  };
  for (const P of sets) {
    for (let o = 0; o < P.length; o += 9) {
      const e1 = Math.hypot(P[o + 3] - P[o], P[o + 4] - P[o + 1], P[o + 5] - P[o + 2]);
      const e2 = Math.hypot(P[o + 6] - P[o], P[o + 7] - P[o + 1], P[o + 8] - P[o + 2]);
      const e3 = Math.hypot(P[o + 6] - P[o + 3], P[o + 7] - P[o + 4], P[o + 8] - P[o + 5]);
      const s = Math.max(1, Math.ceil(Math.max(e1, e2, e3) / (0.7 * v)));
      for (let i = 0; i <= s; i++) for (let j = 0; j <= s - i; j++) {
        const a = i / s, b = j / s, c = 1 - a - b;
        mark(c * P[o] + a * P[o + 3] + b * P[o + 6], c * P[o + 1] + a * P[o + 4] + b * P[o + 7], c * P[o + 2] + a * P[o + 5] + b * P[o + 8]);
      }
    }
  }
  return G;
}

/** ambient occlusion at sample points S (3m) about unit normals Nn (3m): 1 open .. 1 - strength closed;
    `floor`: the floor's z (mm) or null */
export function occlusionAt(S, Nn, G, floor = null, o = AO) {
  const m = S.length / 3, dirs = hemisphere(o.rays), out = new Float32Array(m);
  const { lo, v, d, bits } = G, R = o.reach_mm;
  for (let q = 0; q < m; q++) {
    const nx = Nn[3 * q], ny = Nn[3 * q + 1], nz = Nn[3 * q + 2];
    if (nx === 0 && ny === 0 && nz === 0) { out[q] = 1; continue; }
    // a tangent frame about n
    let tx = Math.abs(nz) < 0.9 ? -ny : 0, ty = Math.abs(nz) < 0.9 ? nx : -nz, tz = Math.abs(nz) < 0.9 ? 0 : ny;
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const px = S[3 * q] + nx * 1.5 * v, py = S[3 * q + 1] + ny * 1.5 * v, pz = S[3 * q + 2] + nz * 1.5 * v;
    let occ = 0;
    for (let k = 0; k < o.rays; k++) {
      const a = dirs[3 * k], b = dirs[3 * k + 1], e = dirs[3 * k + 2];
      const wx = tx * a + bx * b + nx * e, wy = ty * a + by * b + ny * e, wz = tz * a + bz * b + nz * e;
      for (let s = 0; s < R; s += v) {
        const x = px + wx * s, y = py + wy * s, z = pz + wz * s;
        if (floor !== null && z < floor) { occ += o.floor * (1 - s / R); break; }
        const i = ((x - lo[0]) / v) | 0, j = ((y - lo[1]) / v) | 0, kk = ((z - lo[2]) / v) | 0;
        if (i < 0 || j < 0 || kk < 0 || i >= d[0] || j >= d[1] || kk >= d[2]) break;
        if (bits[(kk * d[1] + j) * d[0] + i]) { occ += 1 - 0.5 * s / R; break; }
      }
    }
    out[q] = 1 - o.strength * occ / o.rays;
  }
  return out;
}

/** ambient occlusion per welded vertex, about its area-weighted normal */
export function occlusion(P, W, wv, G, floor = null, o = AO) {
  const { nv, first, list } = wv, S = new Float32Array(3 * nv), Nn = new Float32Array(3 * nv);
  for (let q = 0; q < nv; q++) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = first[q]; k < first[q + 1]; k++) { const t = (list[k] / 3) | 0; nx += W[3 * t]; ny += W[3 * t + 1]; nz += W[3 * t + 2]; }
    const l = Math.hypot(nx, ny, nz), c = list[first[q]];
    if (l > 1e-12) { Nn[3 * q] = nx / l; Nn[3 * q + 1] = ny / l; Nn[3 * q + 2] = nz / l; }
    S[3 * q] = P[3 * c]; S[3 * q + 1] = P[3 * c + 1]; S[3 * q + 2] = P[3 * c + 2];
  }
  return occlusionAt(S, Nn, G, floor, o);
}

/* per corner, a little inside its triangle about the face normal: a coarse (decimated) mesh then does not
   carry a hole rim's darkness across a long triangle */
function cornerOcclusion(P, U, G, floor, pull = 0.35) {
  const n = P.length / 3, S = new Float32Array(3 * n), Nn = new Float32Array(3 * n);
  for (let c = 0; c < n; c++) {
    const t = (c / 3) | 0;
    for (let k = 0; k < 3; k++) {
      const cen = (P[9 * t + k] + P[9 * t + 3 + k] + P[9 * t + 6 + k]) / 3;
      S[3 * c + k] = P[3 * c + k] + pull * (cen - P[3 * c + k]);
      Nn[3 * c + k] = U[3 * t + k];
    }
  }
  return occlusionAt(S, Nn, G, floor);
}

const yieldNow = () => new Promise((r) => setTimeout(r, 0));

/**
 * items: [{geometry, matrix (Matrix4: the mesh's pose in a Z-up frame)}]; opts: {scale (to mm), floor
 * (mm, z) or null, crease: false to keep the normals, corners: the AO per corner (coarse meshes)}.  Resolves to Map<geometry, {normal (Int8, object space,
 * per corner; null for indexed geometry), color (Uint8)}>, both normalized attributes' arrays; the first item
 * of a shared geometry sets its shade.
 */
export async function shade(items, { scale = 1, floor = null, crease = true, corners = false, slice = 12 } = {}) {
  const seen = new Map();
  for (const it of items) if (!seen.has(it.geometry)) seen.set(it.geometry, it);
  const work = [...seen.values()].map((it) => ({ it, P: cornersOf(it.geometry, it.matrix.elements, scale) }));
  await yieldNow();
  const G = voxelGrid(work.map((w) => w.P));
  const out = new Map();
  let t0 = performance.now();
  for (const w of work) {
    const g = w.it.geometry, { W, U } = faceNormals(w.P), wv = weld(w.P);
    const ao = corners ? cornerOcclusion(w.P, U, G, floor) : occlusion(w.P, W, wv, G, floor);
    const n = w.P.length / 3, indexed = !!g.index;
    const count = indexed ? g.attributes.position.count : n, col = new Uint8Array(3 * count);
    for (let c = 0; c < n; c++) {
      const a = Math.round(255 * ao[corners ? c : wv.vid[c]]), i = indexed ? g.index.getX(c) : c;
      col[3 * i] = col[3 * i + 1] = col[3 * i + 2] = a;
    }
    let N = null;
    if (crease && !indexed) {
      const Nw = creaseNormals(w.P, W, U, wv), e = w.it.matrix.elements;
      N = new Int8Array(3 * n);
      for (let c = 0; c < n; c++) {                        // world -> object: the transpose of the linear part
        const x = Nw[3 * c], y = Nw[3 * c + 1], z = Nw[3 * c + 2];
        const ox = e[0] * x + e[1] * y + e[2] * z, oy = e[4] * x + e[5] * y + e[6] * z, oz = e[8] * x + e[9] * y + e[10] * z;
        const l = Math.hypot(ox, oy, oz) || 1;
        N[3 * c] = Math.round(127 * ox / l); N[3 * c + 1] = Math.round(127 * oy / l); N[3 * c + 2] = Math.round(127 * oz / l);
      }
    }
    out.set(g, { normal: N, color: col });
    if (performance.now() - t0 > slice) { await yieldNow(); t0 = performance.now(); }
  }
  return out;
}
