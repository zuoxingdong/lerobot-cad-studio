/* Generic tweak ops on any part mesh: stretch / shorten, scale, offset face (thicken), mirror,
   move.  Pure functions on three.js BufferGeometry, positions in mm, in the part's own frame.
   An op stack is plain JSON (`design.parts[<partId>].ops`); the mesh core is ops-gate.js. */

import { Matrix4 } from 'three';
import {
  meshOf, toGeometry, sOf, stretchMesh, shortenMesh, gateMesh,
  GATE_DEG, GATE_SIN, SCAN_STEP_MM, MOUNT_CLEAR_MM,
} from './ops-gate.js';

export { GATE_DEG, GATE_SIN, SCAN_STEP_MM, MOUNT_CLEAR_MM };
export const FACE_DEG = 1;            // offset_face grows a region coplanar within 1°
export const FACE_INSET_MM = 0.01;    // …and cuts this far inside it
const FACE_TOL_MM = 0.02;             // plane distance for the grown region

const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-12)) throw new Error('ops: zero-length vector');
  return [v[0] / l, v[1] / l, v[2] / l];
};
const num = (v, name) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`ops: ${name} must be a number`); return v; };
const vec3 = (v, name) => { if (!Array.isArray(v) || v.length !== 3) throw new Error(`ops: ${name} must be [x,y,z]`); return v.map((x, i) => num(x, `${name}[${i}]`)); };

function bboxOf(p) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k] < lo[k]) lo[k] = p[i + k];
    if (p[i + k] > hi[k]) hi[k] = p[i + k];
  }
  return { lo, hi, center: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) };
}

/** {point, normal[, axis]} with unit vectors, or null. */
function normMount(mt) {
  if (!mt || !mt.point || !mt.normal) return null;
  const out = { point: vec3(mt.point, 'mount.point'), normal: unit(vec3(mt.normal, 'mount.normal')) };
  if (mt.axis) out.axis = unit(vec3(mt.axis, 'mount.axis'));
  return out;
}

/** A mount-frame.js mount frame as an ops mount: the mount face normal plus its main stretch axis. */
export function mountFromFrame(frame) {
  if (!frame) return null;
  const e = (i, s) => { const v = [0, 0, 0]; v[i] = s; return v; };
  return { point: frame.origin.slice(), normal: e(frame.ci, frame.cs), axis: e(frame.ai, frame.as) };
}

/** The default stretch axis: the mount's axis or normal (pointing into the part), else the longest bbox axis. */
export function defaultAxis(geometry, mount) {
  const m = meshOf(geometry), b = bboxOf(m.p), mt = normMount(mount);
  if (mt) {
    const a = (mt.axis || mt.normal).slice();
    return dot(sub(b.center, mt.point), a) < 0 ? a.map((x) => -x) : a;
  }
  const ext = [0, 1, 2].map((k) => b.hi[k] - b.lo[k]);
  const i = ext[0] >= ext[1] ? (ext[0] >= ext[2] ? 0 : 2) : (ext[1] >= ext[2] ? 1 : 2);
  const a = [0, 0, 0]; a[i] = 1;
  return a;
}

/* the stretch plane, normalised so the moving side (s > c) never holds the mount */
export function stretchFrame(axis, at, by, mount) {
  let a = unit(vec3(axis, 'axis')), c = num(at, 'at');
  num(by, 'by');
  let sMount = null, flip = false;
  if (mount) {
    sMount = dot(mount.point, a);
    if (sMount > c) { flip = true; a = a.map((x) => -x); c = -c; sMount = -sMount; }
  }
  return { a, c, d: Math.max(0, -by), flip, sMount };
}

function gateOn(m, f) {
  const g = gateMesh(m, f.a, f.c, f.d, f.sMount);
  return {
    ok: g.ok, reason: g.reason, crossing: g.crossing, walls: g.walls,
    nearest: g.nearest === null ? null : { at: f.flip ? -g.nearest : g.nearest },
  };
}

/**
 * The prismatic gate for a stretch plane: every triangle straddling it (or, for by < 0, the
 * whole slab it collapses) must be a wall parallel to the axis within 2°.
 * @param {object} [opts] {by, mount:{point, normal}}
 * @returns {{ok, reason, crossing:number[], walls:number, nearest:{at}|null}}
 *   crossing = offending input triangle indices; nearest = closest clean plane in 0.5 mm steps
 */
export function stretchGate(geometry, axis, at, opts = {}) {
  const f = stretchFrame(axis, at, opts.by || 0, normMount(opts.mount));
  return gateOn(meshOf(geometry), f);
}

/** A gate-approved plane near the middle of the part (or MOUNT_CLEAR_MM past the mount), or null. */
export function suggestPlane(geometry, axis, opts = {}) {
  const m = meshOf(geometry), a = unit(axis), s = sOf(m.p, a);
  let lo = Infinity, hi = -Infinity;
  for (const x of s) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const mid = Math.round(((lo + hi) / 2) / SCAN_STEP_MM) * SCAN_STEP_MM;
  const g = stretchGate(geometry, a, mid, opts);
  return g.ok ? mid : g.nearest ? g.nearest.at : null;
}

/** The axes a stretch of `by` can use: the default first, then X/Y/Z, each with its suggested plane. */
export function stretchAxes(geometry, opts = {}) {
  const out = [], seen = [];
  for (const a of [defaultAxis(geometry, opts.mount), [1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    if (seen.some((b) => Math.abs(Math.abs(dot(a, b)) - 1) < 1e-9)) continue;
    seen.push(a);
    const at = suggestPlane(geometry, a, opts);
    if (at !== null) out.push({ axis: a, at });
  }
  return out;
}

/* the ops */

function opStretch(m, op, mount, geo) {
  const by = num(op.by, 'by');
  if (by === 0) return { mesh: m };
  const f = stretchFrame(op.axis || defaultAxis(geo, mount), op.at, by, mount);
  const g = gateOn(m, f);
  if (!g.ok) return { refused: { reason: g.reason, crossing: g.crossing.length, nearest: g.nearest } };
  if (by > 0) return { mesh: stretchMesh(m, f.a, f.c, by) };
  const r = shortenMesh(m, f.a, f.c, f.d);
  return { mesh: r.mesh, warn: r.sealed ? [] : [['seam', 'the shortened seam keeps zero-area triangles']] };
}

function scaleMatrix(op, m, mount) {
  const fac = typeof op.s === 'number' ? [op.s, op.s, op.s] : vec3(op.factors, 'factors');
  if (!fac.every((x) => x > 0)) throw new Error('ops: scale factors must be > 0 (use mirror to flip)');
  const F = op.frame ? op.frame.map((v, i) => unit(vec3(v, `frame[${i}]`))) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += fac[k] * F[k][i] * F[k][j];
  const about = op.about || 'mount';
  const o = Array.isArray(about) ? vec3(about, 'about')
    : about === 'mount' && mount ? mount.point : bboxOf(m.p).center;
  return { M, o, about, noMount: about === 'mount' && !mount };
}

const mul = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];

function opScale(m, op, mount) {
  const { M, o, noMount } = scaleMatrix(op, m, mount);
  const p = new Float64Array(m.p.length);
  for (let i = 0; i < p.length; i += 3) {
    const q = mul(M, [m.p[i] - o[0], m.p[i + 1] - o[1], m.p[i + 2] - o[2]]);
    p[i] = o[0] + q[0]; p[i + 1] = o[1] + q[1]; p[i + 2] = o[2] + q[2];
  }
  const warn = [];
  if (noMount) warn.push(['no_mount', 'no mount face: scaled about the centre']);
  let next = mount;
  if (mount) {
    const n = mount.normal;
    const e1 = unit(Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [-n[1], n[0], 0]);
    const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    const drift = (e) => Math.hypot(...sub(mul(M, e), e));
    if (drift(e1) > 1e-9 || drift(e2) > 1e-9) warn.push(['bolt_pattern', 'bolt pattern moves: the scale is in the plane of the mount face']);
    const pt = sub(mount.point, o), q = mul(M, pt);
    const point = [o[0] + q[0], o[1] + q[1], o[2] + q[2]];
    if (Math.hypot(...sub(point, mount.point)) > 1e-9) warn.push(['mount_moves', 'the mount face moves: scale about the mount to keep it']);
    next = { ...mount, point, normal: unit(solve3(M, n)) };
    if (mount.axis) next.axis = unit(mul(M, mount.axis));
  }
  return { mesh: { p, t: m.t, src: m.src }, mount: next, warn };
}

/* M⁻¹ v for the symmetric positive scale matrix (normals transform by the inverse transpose) */
function solve3(M, v) {
  const [a, b, c] = M, det = dot(a, [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]]);
  const col = (x, y, z) => dot(x, [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]) / det;
  const T = [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
  return [col(v, T[1], T[2]), col(T[0], v, T[2]), col(T[0], T[1], v)];
}

function opMirror(m, op, mount) {
  const pl = op.plane || {};
  const o = vec3(pl.point || [0, 0, 0], 'plane.point'), n = unit(vec3(pl.normal, 'plane.normal'));
  const refl = (q, isDir) => { const k = 2 * (isDir ? dot(q, n) : dot(sub(q, o), n)); return [q[0] - k * n[0], q[1] - k * n[1], q[2] - k * n[2]]; };
  const p = new Float64Array(m.p.length);
  for (let i = 0; i < p.length; i += 3) { const q = refl([m.p[i], m.p[i + 1], m.p[i + 2]]); p[i] = q[0]; p[i + 1] = q[1]; p[i + 2] = q[2]; }
  const t = new Int32Array(m.t.length);
  for (let k = 0; k < t.length; k += 3) { t[k] = m.t[k]; t[k + 1] = m.t[k + 2]; t[k + 2] = m.t[k + 1]; }
  const next = mount ? { point: refl(mount.point), normal: refl(mount.normal, true), ...(mount.axis ? { axis: refl(mount.axis, true) } : {}) } : null;
  return { mesh: { p, t, src: m.src }, mount: next };
}

function triNormal(m, k) {
  const P = m.p, i = 3 * m.t[3 * k], j = 3 * m.t[3 * k + 1], l = 3 * m.t[3 * k + 2];
  const u = [P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]], v = [P[l] - P[i], P[l + 1] - P[i + 1], P[l + 2] - P[i + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]);
  return { n: len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : null, area: len / 2, c: [0, 1, 2].map((d) => (P[i + d] + P[j + d] + P[l + d]) / 3) };
}

/** The seed triangle of the current mesh: an input triangle index, or the nearest face matching {point, normal}. */
function seedTri(m, seed) {
  const cos = Math.cos((FACE_DEG * Math.PI) / 180);
  let best = -1, key = Infinity;
  if (typeof seed === 'number') {
    for (let k = 0; k < m.src.length; k++) if (m.src[k] === seed) { const a = triNormal(m, k).area; if (-a < key) { key = -a; best = k; } }
    return best;
  }
  const pt = vec3(seed.point, 'seed.point'), nn = unit(vec3(seed.normal, 'seed.normal'));
  for (let k = 0; k < m.t.length / 3; k++) {
    const f = triNormal(m, k);
    if (!f.n || dot(f.n, nn) < cos) continue;
    const off = Math.abs(dot(sub(pt, f.c), f.n));
    const d = off + Math.hypot(...sub(pt, f.c)) * 1e-3 + (inTri(m, k, pt, f.n) ? 0 : 1e3);
    if (d < key) { key = d; best = k; }
  }
  return best;
}

function inTri(m, k, q, n) {
  const P = m.p, v = [0, 1, 2].map((j) => { const i = 3 * m.t[3 * k + j]; return [P[i], P[i + 1], P[i + 2]]; });
  for (let j = 0; j < 3; j++) {
    const e = sub(v[(j + 1) % 3], v[j]), w = sub(q, v[j]);
    if (dot([e[1] * w[2] - e[2] * w[1], e[2] * w[0] - e[0] * w[2], e[0] * w[1] - e[1] * w[0]], n) < -1e-9) return false;
  }
  return true;
}

/** The coplanar region grown from triangle k: {tris, verts:Set, n, s} with s the face's plane offset. */
export function growFace(m, k) {
  const f0 = triNormal(m, k), n = f0.n, s = dot(f0.c, n), cos = Math.cos((FACE_DEG * Math.PI) / 180);
  const nv = m.p.length / 3, byEdge = new Map();
  for (let t = 0; t < m.t.length / 3; t++) for (let j = 0; j < 3; j++) {
    const u = m.t[3 * t + j], v = m.t[3 * t + ((j + 1) % 3)], key = u < v ? u * nv + v : v * nv + u;
    if (!byEdge.has(key)) byEdge.set(key, []);
    byEdge.get(key).push(t);
  }
  const on = new Uint8Array(m.t.length / 3), tris = [k], verts = new Set();
  on[k] = 1;
  for (let q = 0; q < tris.length; q++) {
    const t = tris[q];
    for (let j = 0; j < 3; j++) {
      const u = m.t[3 * t + j], v = m.t[3 * t + ((j + 1) % 3)];
      verts.add(u);
      for (const o of byEdge.get(u < v ? u * nv + v : v * nv + u)) {
        if (on[o]) continue;
        const f = triNormal(m, o);
        if (!f.n || dot(f.n, n) < cos) continue;
        if ([0, 1, 2].some((d) => { const i = 3 * m.t[3 * o + d]; return Math.abs(dot([m.p[i], m.p[i + 1], m.p[i + 2]], n) - s) > FACE_TOL_MM; })) continue;
        on[o] = 1; tris.push(o);
      }
    }
  }
  return { tris, verts, n, s };
}

function opOffsetFace(m, op, mount) {
  const by = num(op.by, 'by');
  if (by === 0) return { mesh: m };
  const k = seedTri(m, op.seed);
  if (k < 0 || !triNormal(m, k).n) return { refused: { reason: 'no_face' } };
  const face = growFace(m, k), d = Math.max(0, -by);
  const c = face.s - FACE_INSET_MM - d;
  const g = gateMesh(m, face.n, c, d, null);
  if (!g.ok) return { refused: { reason: g.reason, crossing: g.crossing.length, nearest: null } };
  const warn = [];
  const s = sOf(m.p, face.n);
  for (let i = 0; i < s.length; i++) if (s[i] > face.s + FACE_TOL_MM) { warn.push(['beyond_face', 'geometry past this face moves with it']); break; }
  if (mount && Math.abs(dot(mount.point, face.n) - face.s) <= FACE_TOL_MM) warn.push(['mount_moves', 'this is the mount face: the part moves off its mount']);
  if (by > 0) return { mesh: stretchMesh(m, face.n, c, by), warn };
  const r = shortenMesh(m, face.n, c, d);
  if (!r.sealed) warn.push(['seam', 'the thinned seam keeps zero-area triangles']);
  return { mesh: r.mesh, warn };
}

const RUN = { stretch: opStretch, scale: opScale, offset_face: opOffsetFace, mirror: opMirror };

/**
 * Apply an op stack.  Deterministic; `geometry` is never touched.
 * @param {import('three').BufferGeometry} geometry  part frame, mm
 * @param {Array<object>} ops
 * @param {{mount?:{point, normal, axis?}}} [ctx]
 * @returns {{geometry, warnings:Array<{index, op, code, text}>, refused?:{index, op, reason, crossing?, nearest?}}}
 *   on a refusal `geometry` is the result of the ops before it
 */
export function applyOps(geometry, ops, ctx = {}) {
  const warnings = [];
  if (!ops || !ops.length) return { geometry, warnings };
  let m = meshOf(geometry), mount = normMount(ctx.mount), changed = false;
  const done = () => {
    if (!changed) return geometry;
    const g = toGeometry(m, !!geometry.index);
    const u = geometry.userData || {};
    g.userData = { ...u, ops: JSON.parse(JSON.stringify(ops)), opsBase: u.opsBase || geometry };
    return g;
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    if (op.op === 'move') continue;
    const run = RUN[op.op];
    let r;
    try {
      if (!run) throw new Error(`ops: unknown op "${op.op}"`);
      r = run(m, op, mount, geometry);
    } catch (e) {
      r = { refused: { reason: 'invalid', error: String((e && e.message) || e) } };
    }
    for (const w of r.warn || []) warnings.push({ index: i, op: op.op, code: w[0], text: w[1] });
    if (r.refused) return { geometry: done(), warnings, refused: { index: i, op: op.op, ...r.refused } };
    if (r.mesh !== m) changed = true;
    m = r.mesh;
    if (r.mount !== undefined) mount = r.mount;
  }
  return { geometry: done(), warnings };
}

/* frames: running the same stack on a print plate */

function rigidParts(matrix) {
  const M = matrix && matrix.isMatrix4 ? matrix : new Matrix4().fromArray(matrix);
  const e = M.elements, R = [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]], t = [e[12], e[13], e[14]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const g = R[0][i] * R[0][j] + R[1][i] * R[1][j] + R[2][i] * R[2][j];
    if (Math.abs(g - (i === j ? 1 : 0)) > 1e-6) throw new Error('ops: the transform is not rigid');
  }
  const rot = (v) => mul(R, v);
  return { R, t, rot, pt: (v) => { const q = rot(v); return [q[0] + t[0], q[1] + t[1], q[2] + t[2]]; } };
}

/** A mount in another frame (e.g. the print plate's, through `print_transform`). */
export function transformMount(mount, matrix) {
  const mt = normMount(mount);
  if (!mt) return null;
  const X = rigidParts(matrix);
  return { point: X.pt(mt.point), normal: X.rot(mt.normal), ...(mt.axis ? { axis: X.rot(mt.axis) } : {}) };
}

/**
 * The same op stack in another frame, for a rigid `matrix` (part → print is `print_transform`).
 * Run it with `applyOps(printGeometry, transformOps(ops, T), {mount: transformMount(mount, T)})`.
 * offset_face seeds must be {point, normal}; scale 'center' is kept only under an axis-aligned rotation.
 */
export function transformOps(ops, matrix) {
  const X = rigidParts(matrix);
  const aligned = X.R.every((row) => row.every((v) => Math.abs(v) < 1e-6 || Math.abs(Math.abs(v) - 1) < 1e-6));
  return (ops || []).map((op) => {
    const o = JSON.parse(JSON.stringify(op));
    if (op.op === 'stretch') {
      if (!op.axis) throw new Error('ops: transformOps needs an explicit stretch axis');
      o.axis = X.rot(unit(op.axis)); o.at = op.at + dot(X.t, o.axis);
    } else if (op.op === 'scale') {
      o.frame = (op.frame || [[1, 0, 0], [0, 1, 0], [0, 0, 1]]).map((v) => X.rot(unit(v)));
      if (Array.isArray(op.about)) o.about = X.pt(op.about);
      else if (op.about === 'center' && !aligned) throw new Error('ops: resolve scale about "center" to a point first');
    } else if (op.op === 'mirror') {
      o.plane = { point: X.pt(op.plane.point || [0, 0, 0]), normal: X.rot(op.plane.normal) };
    } else if (op.op === 'offset_face') {
      if (typeof op.seed === 'number') throw new Error('ops: store offset_face seeds as {point, normal}');
      o.seed = { point: X.pt(op.seed.point), normal: X.rot(op.seed.normal) };
    }
    return o;
  });
}

/** {point, normal} of an input triangle, the portable form of an offset_face seed. */
export function seedOf(geometry, triIndex) {
  const m = meshOf(geometry), k = seedTri(m, triIndex);
  if (k < 0) return null;
  const f = triNormal(m, k);
  return f.n ? { point: f.c, normal: f.n } : null;
}

/**
 * For a mirrored copy of a part: the print transform that keeps the mirrored plate on the bed.
 * The plate is reflected across the vertical plane x = cx of the print frame (a rigid result).
 */
export function mirroredPrintTransform(printTransform, plane, cx = 0) {
  const P = printTransform && printTransform.isMatrix4 ? printTransform.clone() : new Matrix4().fromArray(printTransform);
  const n = unit(plane.normal), o = plane.point || [0, 0, 0], k = 2 * dot(o, n);
  const Mr = new Matrix4().set(
    1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[2], k * n[0],
    -2 * n[1] * n[0], 1 - 2 * n[1] * n[1], -2 * n[1] * n[2], k * n[1],
    -2 * n[2] * n[0], -2 * n[2] * n[1], 1 - 2 * n[2] * n[2], k * n[2],
    0, 0, 0, 1);
  const Rv = new Matrix4().set(-1, 0, 0, 2 * cx, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  return Rv.multiply(P).multiply(Mr);
}

/* labels */

const fmt = (v, unitStr) => {
  const r = Math.round(v * 10) / 10, s = Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(1);
  return `${r < 0 ? '−' : '+'}${s} ${unitStr}`;
};
const pct = (f) => `${Math.round(f * 1000) / 10} %`;

/** A short undo label: "Stretch · Corner mast · −20 mm". */
export function opLabel(op, partName) {
  const name = partName || 'part';
  switch (op && op.op) {
    case 'stretch': return `${op.by < 0 ? 'Shorten' : 'Stretch'} · ${name} · ${fmt(op.by, 'mm')}`;
    case 'scale': {
      const f = typeof op.s === 'number' ? [op.s] : (op.factors || []);
      const same = f.every((x) => Math.abs(x - f[0]) < 1e-9);
      return `Scale · ${name} · ${same ? pct(f[0]) : f.map((x) => Math.round(x * 1000) / 10).join('/') + ' %'}`;
    }
    case 'offset_face': return `${op.by < 0 ? 'Thin' : 'Thicken'} · ${name} · ${fmt(op.by, 'mm')}`;
    case 'mirror': return `Mirror · ${name}`;
    case 'move': return `Move · ${name}`;
    default: return `Edit · ${name}`;
  }
}
