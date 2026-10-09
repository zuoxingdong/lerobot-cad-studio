/* The mesh core under features/ops.js: a welded triangle mesh, the plane split, stretch and
   shorten along any unit axis, and the prismatic gate.  Pure functions, positions in mm.
   A mesh is {p: Float64Array xyz, t: Int32Array triangles, src: Int32Array input triangle | -1}. */

import { BufferGeometry, BufferAttribute, Float32BufferAttribute } from 'three';

export const GATE_DEG = 2;
export const GATE_SIN = Math.sin((GATE_DEG * Math.PI) / 180);
export const SCAN_STEP_MM = 0.5;
export const MOUNT_CLEAR_MM = 2.5;   // no cut plane nearer the mount face (mount-frame.js too)
export const PLANE_EPS = 3e-3;       // a vertex this close to a cut plane lies on it (> the weld)
export const WELD_MM = 2e-3;         // new vertices closer than this merge (printcheck rounds to 1 µm)
const FLAT_MM = 1e-6;                // a triangle thinner than this is degenerate
const TJ_MM = 1e-5;                  // a T-junction vertex lies this close to an edge

const Q = 1e3;
const cache = new WeakMap();

/** The welded mesh of a BufferGeometry (cached per geometry; never mutate the result). */
export function meshOf(geo) {
  const attr = geo.attributes.position;
  const hit = cache.get(geo);
  if (hit && hit.attr === attr && hit.version === attr.version) return hit.mesh;
  const n = attr.count;
  const ids = new Int32Array(n);
  const head = new Map(), next = [], qs = [], p = [];
  for (let i = 0; i < n; i++) {
    const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i);
    const a = Math.round(x * Q), b = Math.round(y * Q), c = Math.round(z * Q);
    const h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791);
    const first = head.has(h) ? head.get(h) : -1;
    let w = first;
    while (w >= 0 && !(qs[3 * w] === a && qs[3 * w + 1] === b && qs[3 * w + 2] === c)) w = next[w];
    if (w < 0) {
      w = p.length / 3;
      p.push(x, y, z); qs.push(a, b, c); next.push(first); head.set(h, w);
    }
    ids[i] = w;
  }
  const idx = geo.index ? geo.index.array : null;
  const nt = Math.floor((idx ? idx.length : n) / 3);
  const t = [], src = [];
  for (let k = 0; k < nt; k++) {
    const i0 = ids[idx ? idx[3 * k] : 3 * k], i1 = ids[idx ? idx[3 * k + 1] : 3 * k + 1], i2 = ids[idx ? idx[3 * k + 2] : 3 * k + 2];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    t.push(i0, i1, i2); src.push(k);
  }
  const mesh = { p: Float64Array.from(p), t: Int32Array.from(t), src: Int32Array.from(src) };
  cache.set(geo, { attr, version: attr.version, mesh });
  return mesh;
}

/** Drop unused vertices, keeping order. */
export function compact(m) {
  const nv = m.p.length / 3, map = new Int32Array(nv).fill(-1);
  let k = 0;
  for (let i = 0; i < m.t.length; i++) if (map[m.t[i]] < 0) map[m.t[i]] = 0;
  for (let i = 0; i < nv; i++) if (map[i] === 0) map[i] = k++;
  if (k === nv) return m;
  const p = new Float64Array(k * 3);
  for (let i = 0; i < nv; i++) if (map[i] >= 0) { p[3 * map[i]] = m.p[3 * i]; p[3 * map[i] + 1] = m.p[3 * i + 1]; p[3 * map[i] + 2] = m.p[3 * i + 2]; }
  return { p, t: m.t.map((v) => map[v]), src: m.src };
}

/** BufferGeometry from a mesh: indexed, or a triangle soup like STLLoader's. */
export function toGeometry(m, indexed) {
  const g = new BufferGeometry();
  if (indexed) {
    const c = compact(m);
    g.setAttribute('position', new Float32BufferAttribute(Float32Array.from(c.p), 3));
    g.setIndex(new BufferAttribute(Uint32Array.from(c.t), 1));
  } else {
    const out = new Float32Array(m.t.length * 3);
    for (let k = 0; k < m.t.length; k++) {
      const v = 3 * m.t[k];
      out[3 * k] = m.p[v]; out[3 * k + 1] = m.p[v + 1]; out[3 * k + 2] = m.p[v + 2];
    }
    g.setAttribute('position', new Float32BufferAttribute(out, 3));
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function sOf(p, a) {
  const s = new Float64Array(p.length / 3);
  for (let i = 0; i < s.length; i++) s[i] = p[3 * i] * a[0] + p[3 * i + 1] * a[1] + p[3 * i + 2] * a[2];
  return s;
}

const side = (x, c) => (Math.abs(x - c) <= PLANE_EPS ? 0 : x < c ? -1 : 1);

/** Split every triangle that straddles the plane s = c; vertices within PLANE_EPS snap onto it. */
export function splitAt(m, a, c) {
  const nv = m.p.length / 3, s = sOf(m.p, a);
  const p = Array.from(m.p), g = new Int8Array(nv);
  for (let i = 0; i < nv; i++) {
    g[i] = side(s[i], c);
    if (g[i] === 0 && s[i] !== c) { const d = s[i] - c; p[3 * i] -= d * a[0]; p[3 * i + 1] -= d * a[1]; p[3 * i + 2] -= d * a[2]; }
  }
  const cut = new Map();
  const edge = (i, j) => {
    const u = i < j ? i : j, v = i < j ? j : i, key = u * nv + v;
    let q = cut.get(key);
    if (q !== undefined) return q;
    const f = (c - s[u]) / (s[v] - s[u]);
    q = p.length / 3;
    for (let k = 0; k < 3; k++) p.push(m.p[3 * u + k] + f * (m.p[3 * v + k] - m.p[3 * u + k]));
    const e = p[3 * q] * a[0] + p[3 * q + 1] * a[1] + p[3 * q + 2] * a[2] - c;
    p[3 * q] -= e * a[0]; p[3 * q + 1] -= e * a[1]; p[3 * q + 2] -= e * a[2];
    cut.set(key, q);
    return q;
  };
  const t = [], src = [], L = [], R = [];
  const fan = (poly, sr) => { for (let k = 1; k + 1 < poly.length; k++) { t.push(poly[0], poly[k], poly[k + 1]); src.push(sr); } };
  for (let k = 0; k < m.t.length; k += 3) {
    const v0 = m.t[k], v1 = m.t[k + 1], v2 = m.t[k + 2];
    const lo = Math.min(g[v0], g[v1], g[v2]), hi = Math.max(g[v0], g[v1], g[v2]);
    if (lo >= 0 || hi <= 0) { t.push(v0, v1, v2); src.push(m.src[k / 3]); continue; }
    L.length = 0; R.length = 0;
    for (let j = 0; j < 3; j++) {
      const i = m.t[k + j], n = m.t[k + ((j + 1) % 3)];
      if (g[i] <= 0) L.push(i);
      if (g[i] >= 0) R.push(i);
      if (g[i] * g[n] < 0) { const q = edge(i, n); L.push(q); R.push(q); }
    }
    fan(L, m.src[k / 3]); fan(R, m.src[k / 3]);
  }
  /* cut points of a sliver fan can land closer than the weld: merge them, drop what collapses */
  const on = [];
  for (let i = 0; i < p.length / 3; i++) if (i >= nv || g[i] === 0) on.push(i);
  const rep = weldSet(p, on, WELD_MM), t2 = [], src2 = [];
  for (let k = 0; k < t.length; k += 3) {
    const i0 = rep[t[k]], i1 = rep[t[k + 1]], i2 = rep[t[k + 2]];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    t2.push(i0, i1, i2); src2.push(src[k / 3]);
  }
  return { p: Float64Array.from(p), t: Int32Array.from(t2), src: Int32Array.from(src2) };
}

/** Everything past s = c moves by `by` > 0; the section at c is extruded into the gap. */
export function stretchMesh(m, a, c, by) {
  const S = splitAt(m, a, c);
  const nv = S.p.length / 3, s = sOf(S.p, a), g = new Int8Array(nv);
  for (let i = 0; i < nv; i++) g[i] = side(s[i], c);
  const p = Array.from(S.p), twin = new Int32Array(nv).fill(-1);
  const tw = (u) => {
    if (twin[u] < 0) { twin[u] = p.length / 3; p.push(S.p[3 * u] + by * a[0], S.p[3 * u + 1] + by * a[1], S.p[3 * u + 2] + by * a[2]); }
    return twin[u];
  };
  const T = S.t, nt = T.length / 3, right = new Uint8Array(nt);
  const L = new Set(), R = new Set();
  for (let k = 0; k < nt; k++) {
    right[k] = g[T[3 * k]] > 0 || g[T[3 * k + 1]] > 0 || g[T[3 * k + 2]] > 0 ? 1 : 0;
    for (let j = 0; j < 3; j++) {
      const u = T[3 * k + j], w = T[3 * k + ((j + 1) % 3)];
      if (g[u] === 0 && g[w] === 0) (right[k] ? R : L).add(u * nv + w);
    }
  }
  const t = [], src = [];
  for (let k = 0; k < nt; k++) {
    for (let j = 0; j < 3; j++) { const v = T[3 * k + j]; t.push(right[k] && g[v] === 0 ? tw(v) : v); }
    src.push(S.src[k]);
  }
  for (let i = 0; i < nv; i++) if (g[i] > 0) { p[3 * i] += by * a[0]; p[3 * i + 1] += by * a[1]; p[3 * i + 2] += by * a[2]; }
  for (let k = 0; k < nt; k++) {
    if (right[k]) continue;
    for (let j = 0; j < 3; j++) {
      const u = T[3 * k + j], w = T[3 * k + ((j + 1) % 3)];
      if (g[u] !== 0 || g[w] !== 0 || L.has(w * nv + u) || !R.has(w * nv + u)) continue;
      t.push(w, u, tw(u), w, tw(u), tw(w)); src.push(-1, -1);
    }
  }
  return { p: Float64Array.from(p), t: Int32Array.from(t), src: Int32Array.from(src) };
}

/**
 * The slab (c, c+d] collapses onto s = c and everything past it moves by −d.  Each triangle
 * lies in one affine piece of the map, so nothing folds; the flattened slab is then welded,
 * its zero-area triangles dropped and the seam's T-junctions split.
 * @returns {{mesh, sealed:boolean}}
 */
export function shortenMesh(m, a, c, d) {
  const S = splitAt(splitAt(m, a, c), a, c + d);
  const nv = S.p.length / 3, s = sOf(S.p, a), p = Float64Array.from(S.p), flat = [];
  for (let i = 0; i < nv; i++) {
    const x = s[i];
    const ds = x <= c + PLANE_EPS ? 0 : x >= c + d - PLANE_EPS ? -d : c - x;
    if (ds) { p[3 * i] += ds * a[0]; p[3 * i + 1] += ds * a[1]; p[3 * i + 2] += ds * a[2]; }
    if (x >= c - PLANE_EPS && x <= c + d + PLANE_EPS) flat.push(i);
  }
  const rep = weldSet(p, flat, WELD_MM);
  const isFlat = new Uint8Array(nv);
  for (const i of flat) isFlat[i] = 1;
  const t = [], src = [];
  for (let k = 0; k < S.t.length; k += 3) {
    const i0 = rep[S.t[k]], i1 = rep[S.t[k + 1]], i2 = rep[S.t[k + 2]];
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
    t.push(i0, i1, i2); src.push(S.src[k / 3]);
  }
  const collapsed = { p, t: Int32Array.from(t), src: Int32Array.from(src) };
  const sealed = sealT(p, t, src, isFlat);
  return sealed ? { mesh: compact(sealed), sealed: true } : { mesh: compact(collapsed), sealed: false };
}

function height(p, i, j, k) {
  const ux = p[3 * j] - p[3 * i], uy = p[3 * j + 1] - p[3 * i + 1], uz = p[3 * j + 2] - p[3 * i + 2];
  const vx = p[3 * k] - p[3 * i], vy = p[3 * k + 1] - p[3 * i + 1], vz = p[3 * k + 2] - p[3 * i + 2];
  const wx = p[3 * k] - p[3 * j], wy = p[3 * k + 1] - p[3 * j + 1], wz = p[3 * k + 2] - p[3 * j + 2];
  const cr = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  const l = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(wx, wy, wz));
  return l > 0 ? cr / l : 0;
}

const cellKey = (x, y, z) => Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);

/** First-come representative within `tol` for every vertex in `list` (cells of 2·tol, 8 looked at). */
function weldSet(p, list, tol) {
  const rep = new Int32Array(p.length / 3);
  for (let i = 0; i < rep.length; i++) rep[i] = i;
  const grid = new Map(), inv = 1 / (2 * tol), t2 = tol * tol;
  for (const i of list) {
    const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
    const fx = x * inv, fy = y * inv, fz = z * inv;
    const cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
    const sx = fx - cx < 0.5 ? -1 : 1, sy = fy - cy < 0.5 ? -1 : 1, sz = fz - cz < 0.5 ? -1 : 1;
    let found = -1;
    for (let n = 0; n < 8; n++) {
      const cell = grid.get(cellKey(cx + (n & 1 ? sx : 0), cy + (n & 2 ? sy : 0), cz + (n & 4 ? sz : 0)));
      if (!cell) continue;
      for (const j of cell) {
        const ex = x - p[3 * j], ey = y - p[3 * j + 1], ez = z - p[3 * j + 2];
        if (ex * ex + ey * ey + ez * ez <= t2 && (found < 0 || j < found)) found = j;
      }
    }
    if (found >= 0) { rep[i] = found; continue; }
    const key = cellKey(cx, cy, cz), cell = grid.get(key);
    if (cell) cell.push(i); else grid.set(key, [i]);
  }
  return rep;
}

/** Drop the flat zero-area triangles once, then split open edges at the open-boundary vertices lying on
    them until every edge pairs.  Returns the mesh, or null when the seam does not close. */
function sealT(p, t0, src0, isFlat) {
  const nv = p.length / 3, t = [], src = [];
  for (let k = 0; k < t0.length; k += 3) {
    if (isFlat[t0[k]] && isFlat[t0[k + 1]] && isFlat[t0[k + 2]] && height(p, t0[k], t0[k + 1], t0[k + 2]) < FLAT_MM) continue;
    t.push(t0[k], t0[k + 1], t0[k + 2]); src.push(src0[k / 3]);
  }
  /* only triangles with two flat vertices can own a seam edge */
  const cand = [];
  for (let k = 0; k < t.length; k += 3) if (isFlat[t[k]] + isFlat[t[k + 1]] + isFlat[t[k + 2]] >= 2) cand.push(k);
  const P = (w, d) => p[3 * w + d];
  for (let pass = 0; pass < 64; pass++) {
    const he = new Set();
    for (const k of cand) for (let j = 0; j < 3; j++) he.add(t[k + j] * nv + t[k + ((j + 1) % 3)]);
    const open = [], seen = new Set(), bv = [];
    let sum = 0;
    for (const k of cand) for (let j = 0; j < 3; j++) {
      const u = t[k + j], v = t[k + ((j + 1) % 3)];
      if (!isFlat[u] || !isFlat[v] || he.has(v * nv + u)) continue;
      open.push(k, j);
      sum += Math.hypot(P(v, 0) - P(u, 0), P(v, 1) - P(u, 1), P(v, 2) - P(u, 2));
      for (const w of [u, v]) if (!seen.has(w)) { seen.add(w); bv.push(w); }
    }
    if (!open.length) return { p, t: Int32Array.from(t), src: Int32Array.from(src) };
    const h = Math.max(sum / (open.length / 2), 1e-3), grid = new Map();
    const cell = (x) => Math.floor(x / h);
    for (const w of bv) {
      const key = cellKey(cell(P(w, 0)), cell(P(w, 1)), cell(P(w, 2))), c = grid.get(key);
      if (c) c.push(w); else grid.set(key, [w]);
    }
    let changed = false;
    const touched = new Set();
    for (let e = 0; e < open.length; e += 2) {
      const k = open[e], j = open[e + 1];
      if (touched.has(k)) continue;
      const u = t[k + j], v = t[k + ((j + 1) % 3)], x = t[k + ((j + 2) % 3)];
      const dx = P(v, 0) - P(u, 0), dy = P(v, 1) - P(u, 1), dz = P(v, 2) - P(u, 2);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len <= 2 * TJ_MM) continue;
      const lo = [0, 1, 2].map((d) => cell(Math.min(P(u, d), P(v, d)) - TJ_MM));
      const hi = [0, 1, 2].map((d) => cell(Math.max(P(u, d), P(v, d)) + TJ_MM));
      let best = -1, bt = Infinity;
      for (let cx = lo[0]; cx <= hi[0]; cx++) for (let cy = lo[1]; cy <= hi[1]; cy++) for (let cz = lo[2]; cz <= hi[2]; cz++) {
        for (const w of grid.get(cellKey(cx, cy, cz)) || []) {
          if (w === u || w === v || w === x) continue;
          const wx = P(w, 0) - P(u, 0), wy = P(w, 1) - P(u, 1), wz = P(w, 2) - P(u, 2);
          const along = (wx * dx + wy * dy + wz * dz) / len;
          if (along <= TJ_MM || along >= len - TJ_MM || along > bt || (along === bt && w > best)) continue;
          if (wx * wx + wy * wy + wz * wz - along * along > TJ_MM * TJ_MM) continue;
          best = w; bt = along;
        }
      }
      if (best < 0) continue;
      t[k + ((j + 1) % 3)] = best;
      cand.push(t.length);
      t.push(best, v, x); src.push(src[k / 3]);
      touched.add(k); changed = true;
    }
    if (!changed) return null;
  }
  return null;
}

/* the prismatic gate */

/** Per-triangle span along `a` and whether it is a wall (|n̂·a| < sin 2°). */
export function triSpans(m, a) {
  const nt = m.t.length / 3, lo = new Float64Array(nt), hi = new Float64Array(nt), bad = new Uint8Array(nt);
  const P = m.p;
  for (let k = 0; k < nt; k++) {
    const i = 3 * m.t[3 * k], j = 3 * m.t[3 * k + 1], l = 3 * m.t[3 * k + 2];
    const s0 = P[i] * a[0] + P[i + 1] * a[1] + P[i + 2] * a[2];
    const s1 = P[j] * a[0] + P[j + 1] * a[1] + P[j + 2] * a[2];
    const s2 = P[l] * a[0] + P[l + 1] * a[1] + P[l + 2] * a[2];
    lo[k] = Math.min(s0, s1, s2); hi[k] = Math.max(s0, s1, s2);
    const ux = P[j] - P[i], uy = P[j + 1] - P[i + 1], uz = P[j + 2] - P[i + 2];
    const vx = P[l] - P[i], vy = P[l + 1] - P[i + 1], vz = P[l + 2] - P[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const n = Math.hypot(nx, ny, nz);
    bad[k] = n > 0 && Math.abs(nx * a[0] + ny * a[1] + nz * a[2]) >= GATE_SIN * n ? 1 : 0;
  }
  return { lo, hi, bad };
}

/**
 * Gate one plane (and slab length d ≥ 0) on the mesh, in the normalised frame where the
 * moving side is s > c.  A non-wall triangle blocks c when hi > c+ε and lo < c+d−ε.
 * @returns {{ok, reason:null|'crosses'|'mount'|'outside', crossing:number[], walls:number, nearest:number|null}}
 */
export function gateMesh(m, a, c, d, sMount) {
  const sp = triSpans(m, a), nt = sp.lo.length;
  let sMin = Infinity, sMax = -Infinity;
  for (let k = 0; k < nt; k++) { if (sp.lo[k] < sMin) sMin = sp.lo[k]; if (sp.hi[k] > sMax) sMax = sp.hi[k]; }
  const iv = [];
  for (let k = 0; k < nt; k++) {
    if (!sp.bad[k]) continue;
    const l = sp.lo[k] - d + PLANE_EPS, h = sp.hi[k] - PLANE_EPS;
    if (h > l) iv.push(l, h);
  }
  const order = Array.from({ length: iv.length / 2 }, (_, i) => i).sort((x, y) => iv[2 * x] - iv[2 * y] || iv[2 * x + 1] - iv[2 * y + 1]);
  const ml = [], mh = [];
  for (const i of order) {
    const l = iv[2 * i], h = iv[2 * i + 1];
    if (ml.length && l < mh[mh.length - 1]) { if (h > mh[mh.length - 1]) mh[mh.length - 1] = h; } else { ml.push(l); mh.push(h); }
  }
  const blocked = (x) => {
    let lo = 0, hi = ml.length - 1, f = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ml[mid] < x) { f = mid; lo = mid + 1; } else hi = mid - 1; }
    return f >= 0 && x < mh[f];
  };
  const inside = (x) => x > sMin + PLANE_EPS && x + d < sMax - PLANE_EPS;
  const clear = (x) => sMount == null || x >= sMount + MOUNT_CLEAR_MM - 1e-9;
  const clean = (x) => inside(x) && clear(x) && !blocked(x);
  const crossing = [];
  let walls = 0;
  for (let k = 0; k < nt; k++) {
    if (!(sp.hi[k] > c + PLANE_EPS && sp.lo[k] < c + d - PLANE_EPS)) continue;
    if (!sp.bad[k]) { walls++; continue; }
    if (m.src[k] >= 0 && crossing[crossing.length - 1] !== m.src[k]) crossing.push(m.src[k]);
  }
  const uniq = [...new Set(crossing)].sort((x, y) => x - y);
  const ok = clean(c);
  const reason = ok ? null : !inside(c) ? 'outside' : !clear(c) ? 'mount' : 'crosses';
  let nearest = null;
  if (!ok) {
    const K = Math.ceil((sMax - sMin) / SCAN_STEP_MM) + 1;
    for (let k = 1; k <= K && nearest === null; k++) {
      for (const x of [c + k * SCAN_STEP_MM, c - k * SCAN_STEP_MM]) if (clean(x)) { nearest = x; break; }
    }
  }
  return { ok, reason, crossing: uniq, walls, nearest, sMin, sMax };
}
