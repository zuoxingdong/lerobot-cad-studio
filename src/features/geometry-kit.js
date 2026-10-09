/* The kit every parametric part in features/part-*.js is built from: small math, the
   non-indexed BufferGeometry primitives, bed placement for the print preview, parameter
   resolution and the shared colour table.  Needs three and its BufferGeometryUtils addon. */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function prep(g) {
  if (g.index) g = g.toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.computeVertexNormals();
  g.clearGroups();
  return g;
}

function merge(list) {
  const ok = list
    .filter((g) => g && g.attributes && g.attributes.position && g.attributes.position.count > 0)
    .map((g) => (g.index || !g.attributes.normal ? prep(g) : g));
  if (!ok.length) return prep(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([], 3)));
  if (ok.length === 1) return ok[0];
  const out = mergeGeometries(ok, false);
  if (!out) throw new Error('mergeGeometries failed (attribute mismatch)');
  return prep(out);
}

/** signed volume of a triangle soup (mm^3); over-counts where parts overlap. */
function soupVolume(g) {
  const p = g.attributes.position.array; let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/** flip winding if the closed mesh came out inside-out. */
function orientOutward(g) {
  if (soupVolume(g) < 0) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    }
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/** extrude a 2D polygon (+ holes) along Z from z0 to z1.  pts = [[x,y],...] */
function polyG(outer, holes, z0, z1) {
  const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of holes || []) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, steps: 1, curveSegments: 1 });
  g.translate(0, 0, z0);
  return orientOutward(prep(g));
}

function boxG(x0, x1, y0, y1, z0, z1) {
  [x0, x1] = x0 < x1 ? [x0, x1] : [x1, x0];
  [y0, y1] = y0 < y1 ? [y0, y1] : [y1, y0];
  [z0, z1] = z0 < z1 ? [z0, z1] : [z1, z0];
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return orientOutward(prep(g));
}

function circlePts(cx, cy, r, seg = 24, ccw = true) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (ccw ? 1 : -1) * (i / seg) * Math.PI * 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** CCW rounded rectangle */
function roundRectPts(x0, x1, y0, y1, r, seg = 6) {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2 - 1e-6, (y1 - y0) / 2 - 1e-6));
  if (r <= 1e-6) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const out = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * (Math.PI / 2); out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  };
  corner(x1 - r, y0 + r, -Math.PI / 2);
  corner(x1 - r, y1 - r, 0);
  corner(x0 + r, y1 - r, Math.PI / 2);
  corner(x0 + r, y0 + r, Math.PI);
  return out;
}

/** stadium / capsule: straight length `len` between cap centres, width `w`, at `ang` deg */
function capsulePts(cx, cy, len, w, ang, seg = 8) {
  const a = ang * D2R, ux = Math.cos(a), uy = Math.sin(a), r = w / 2;
  const out = [];
  for (let i = 0; i <= seg; i++) {
    const t = -Math.PI / 2 + (i / seg) * Math.PI;
    const px = Math.cos(t) * r, py = Math.sin(t) * r;
    out.push([cx + ux * (len / 2 + px) - uy * py, cy + uy * (len / 2 + px) + ux * py]);
  }
  for (let i = 0; i <= seg; i++) {
    const t = Math.PI / 2 + (i / seg) * Math.PI;
    const px = Math.cos(t) * r, py = Math.sin(t) * r;
    out.push([cx + ux * (-len / 2 + px) - uy * py, cy + uy * (-len / 2 + px) + ux * py]);
  }
  return out;
}

/** annular (or solid) cylinder along +Z */
function tubeZ(cx, cy, rOut, rIn, z0, z1, seg = 24) {
  const holes = rIn > 1e-6 ? [circlePts(cx, cy, rIn, seg, false)] : [];
  return polyG(circlePts(cx, cy, rOut, seg, true), holes, z0, z1);
}

function xf(g, m) { const c = g.clone(); c.applyMatrix4(m); return prep(c); }

/* print orientation */

/**
 * A print transform that drops a geometry onto the bed: rest on Z = 0, centred on XY.
 * The one copy — features/printcheck.js re-exports it; tools/build/robots/printmatch.py is
 * its Python twin.
 */
export function bedTransform(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  return new THREE.Matrix4().makeTranslation(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
}

/**
 * `M` moved along Z so that `geometry` under it rests on Z = 0: a translation on top of the
 * print pose, never a rotation or scale, and X/Y untouched.  Every exported plate and the
 * print check go through it, so an op on the bed face cannot sink or lift the part.
 */
export function seatOnBed(geometry, M = new THREE.Matrix4()) {
  const pos = geometry.attributes.position, e = M.elements;
  let zMin = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    zMin = Math.min(zMin, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w);
  }
  return Number.isFinite(zMin) ? new THREE.Matrix4().makeTranslation(0, 0, -zMin).multiply(M) : M.clone();
}

/** `bedTransform` of the ROTATED geometry, with the rotation folded back in. */
function bedMatrix(geom, rot) {
  const R = rot || new THREE.Matrix4();
  const g = geom.clone(); g.applyMatrix4(R);
  return new THREE.Matrix4().multiplyMatrices(bedTransform(g), R);
}

function statsOf(geoms) {
  const g = merge(geoms.map((x) => x.clone()));
  g.computeBoundingBox();
  const b = g.boundingBox;
  return {
    volume_cm3: +(Math.abs(soupVolume(g)) / 1000).toFixed(2),
    bbox_mm: [+(b.max.x - b.min.x).toFixed(2), +(b.max.y - b.min.y).toFixed(2), +(b.max.z - b.min.z).toFixed(2)],
    bbox_min: [+b.min.x.toFixed(2), +b.min.y.toFixed(2), +b.min.z.toFixed(2)],
    bbox_max: [+b.max.x.toFixed(2), +b.max.y.toFixed(2), +b.max.z.toFixed(2)],
  };
}

/** Signed volume of a closed mesh, mm^3 (indexed or not) — negative means inside-out. */
function signedVolume(geo) {
  const p = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : p.length / 3;
  let vol = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3, c = (idx ? idx[i + 2] : i + 2) * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
          - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
          + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return vol;
}

/* polygon and prism helpers the part modules share */

function placePrism(g, face, off, dir) {
  const m = new THREE.Matrix4();
  if (face === 'YZ') m.set(0, 0, dir, off, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  else if (face === 'XZ') m.set(1, 0, 0, 0, 0, 0, dir, off, 0, 1, 0, 0, 0, 0, 0, 1);
  else m.makeTranslation(0, 0, off);
  return orientOutward(xf(g, m));
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);   // CCW
}

/** Sutherland–Hodgman: clip a convex polygon by another convex polygon (both CCW) */
function clipConvex(subject, clipPoly) {
  let out = subject;
  for (let i = 0; i < clipPoly.length; i++) {
    const a = clipPoly[i], b = clipPoly[(i + 1) % clipPoly.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const inter = (p, q) => {
      const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      const d2 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
      const t = d1 / (d1 - d2);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    const next = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j], q = out[(j + 1) % out.length];
      const pi = inside(p), qi = inside(q);
      if (pi) next.push(p);
      if (pi !== qi) next.push(inter(p, q));
    }
    out = next;
    if (!out.length) return [];
  }
  return out;
}

/* parameter resolution */

function defaultsOf(def) {
  const o = {};
  for (const p of def.params) o[p.key] = p.default;
  return o;
}

/** A part's defaults plus the caller's overrides, each clamped to its own range. */
function resolve(def, params) {
  const o = defaultsOf(def);
  for (const p of def.params) {
    const v = params ? params[p.key] : undefined;
    if (v === undefined || v === null || Number.isNaN(+v)) continue;
    o[p.key] = p.min !== undefined ? clamp(+v, p.min, p.max) : +v;
  }
  return o;
}

/* preview colours — one table, so the parts agree with each other */
const COL = { pi: '#9fd6a8', piPanel: '#79c48d', ghost: '#8a90a0' };

export {
  D2R, clamp,
  prep, merge, orientOutward, signedVolume,
  polyG, boxG, circlePts, roundRectPts, capsulePts, tubeZ, xf,
  bedMatrix, statsOf, placePrism, convexHull, clipConvex,
  defaultsOf, resolve, COL,
};
