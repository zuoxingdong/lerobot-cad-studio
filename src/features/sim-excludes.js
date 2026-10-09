/* The contact excludes the MJCF tree cannot state.  Bodies that share a joint are excluded
   outright.  A four-bar's fourth pin is not in the tree, so its two bodies overlap by one
   fixed amount at every configuration: a first compile sweeps the jaw's travel and every
   preset, keeps each pair that is PINNED (one point at rest in both bodies) and whose overlap
   is CONSTANT, and the model is compiled again with those excluded.  Everything else stays
   live.  The result is cached by a hash of the model inputs. */

import { compile, contacts } from './sim-engine.js';
import { CONTACT_TOL_MM } from './sim-physics.js';

const D2R = Math.PI / 180;
const _cache = new Map();

/** 53-bit hash of the xml and every mesh byte. */
export function designHash(xml, meshes) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const mix = (w) => { h1 = Math.imul(h1 ^ w, 2654435761); h2 = Math.imul(h2 ^ w, 1597334677); };
  for (let i = 0; i < xml.length; i++) mix(xml.charCodeAt(i));
  for (const [name, b] of meshes) {
    for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i));
    const n4 = b.byteLength >> 2;
    const w = new Uint32Array(b.buffer, b.byteOffset, (b.byteOffset & 3) ? 0 : n4);
    for (let i = 0; i < w.length; i++) mix(w[i]);
    for (let i = w.length * 4; i < b.byteLength; i++) mix(b[i]);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** (jaw deg, arm deg) samples: the jaw's whole travel, then every preset. */
export function sweepPoses(sw) {
  const out = [0, 1, 2, 3, 4].map((k) => ({ label: `jaw ${(sw.jawMax * k / 4).toFixed(1)} deg`, jaw: sw.jawMax * k / 4, q: {} }));
  for (const [id, q] of Object.entries(sw.presets)) out.push({ label: `preset ${id}`, jaw: 0, q });
  return out;
}

/** Put `d` at one pose: arm joints in degrees, the jaw and its mimics at jaw x multiplier. */
export function setPose(mj, m, d, sw, pose) {
  const T = mj.mjtObj.mjOBJ_JOINT.value;
  d.qpos.set(m.qpos0);
  d.qvel.fill(0);
  const put = (name, deg) => { const j = mj.mj_name2id(m, T, name); if (j >= 0) d.qpos[m.jnt_qposadr[j]] = deg * D2R; };
  for (const [n, k] of Object.entries(sw.mult)) put(n, pose.jaw * k);
  for (const [n, v] of Object.entries(pose.q)) put(n, v);
  mj.mj_forward(m, d);
}

/** {"a|b": overlap mm} for robot-on-robot contacts at the current pose. */
export function robotPairs(mj, m, d, env) {
  const cs = contacts(d);                  // allocates: read views after it
  const gb = m.geom_bodyid;
  const name = (b) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_BODY.value, b);
  const out = {};
  for (const [g1, g2, dist] of cs) {
    const a = name(gb[g1]), b = name(gb[g2]);
    if (a === b || env.has(a) || env.has(b)) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    out[k] = Math.max(out[k] ?? 0, -dist * 1000);
  }
  return out;
}

/* max deviation, mm, of B from sharing one fixed point with A over the samples */
export function pinResidualMm(A, B) {
  const M = A.map((a, i) => mulInv(a, B[i]));
  const rowsA = [], rowsB = [];
  for (const X of M.slice(1)) for (let r = 0; r < 3; r++) {
    rowsA.push([0, 1, 2].map((c) => X[r][c] - M[0][r][c]));
    rowsB.push(-(X[r][3] - M[0][r][3]));
  }
  if (rowsA.length < 3) return Infinity;
  const N = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rowsA.reduce((s, r) => s + r[i] * r[j], 0)));
  const y = [0, 1, 2].map((i) => rowsA.reduce((s, r, k) => s + r[i] * rowsB[k], 0));
  const q = solve3(N, y);
  let worst = 0;
  rowsA.forEach((r, k) => { worst = Math.max(worst, Math.abs(r[0] * q[0] + r[1] * q[1] + r[2] * q[2] - rowsB[k])); });
  return worst * 1000;
}
function mulInv(a, b) {                     // a^-1 b for rigid 3x4 [R|t]
  const out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[k][r] * (c < 3 ? b[k][c] : b[k][3] - a[k][3]);
    out[r][c] = s;
  }
  return out;
}
function solve3(A, b) {                     // least-squares normal equations, Cramer with a ridge
  const M = A.map((r, i) => r.map((v, j) => v + (i === j ? 1e-15 : 0)));
  const det = (X) => X[0][0] * (X[1][1] * X[2][2] - X[1][2] * X[2][1]) - X[0][1] * (X[1][0] * X[2][2] - X[1][2] * X[2][0]) + X[0][2] * (X[1][0] * X[2][1] - X[1][1] * X[2][0]);
  const D = det(M);
  return [0, 1, 2].map((c) => det(M.map((r, i) => r.map((v, j) => (j === c ? b[i] : v)))) / D);
}
function frames(m, d) {
  const X = d.xpos, R = d.xmat, out = [];
  for (let b = 0; b < m.nbody; b++) {
    out.push([0, 1, 2].map((r) => [R[9 * b + 3 * r], R[9 * b + 3 * r + 1], R[9 * b + 3 * r + 2], X[3 * b + r]]));
  }
  return out;
}

/** Sweep a compiled model; the pinned, constant-overlap pairs are the loop closures. */
export function findLoops(mj, m, sw) {
  const d = new mj.MjData(m);
  try {
    const env = new Set([...sw.env, 'world']);
    const over = [], fr = [];
    for (const p of sweepPoses(sw)) {
      setPose(mj, m, d, sw, p);
      over.push(robotPairs(mj, m, d, env));
      fr.push(frames(m, d));
    }
    const bid = (n) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, n);
    const loops = [], baseline = {}, evidence = {};
    for (const k of Object.keys(over[0]).sort()) {
      const deep = over.map((s) => s[k] ?? 0);
      const [a, b] = k.split('|');
      const res = pinResidualMm(fr.map((f) => f[bid(a)]), fr.map((f) => f[bid(b)]));
      const lo = Math.min(...deep), hi = Math.max(...deep);
      if (!(res <= CONTACT_TOL_MM && lo >= CONTACT_TOL_MM && hi - lo <= CONTACT_TOL_MM)) continue;
      loops.push([a, b]);
      baseline[k] = +lo.toFixed(3);
      evidence[k] = { min_mm: +lo.toFixed(3), max_mm: +hi.toFixed(3), pin_residual_mm: +res.toFixed(4), samples: deep.length };
    }
    return { loops, baseline, evidence };
  } finally {
    d.delete();
  }
}

const sortPairs = (ps) => ps.map((p) => p.slice().sort()).sort((x, y) => (x.join('|') < y.join('|') ? -1 : x.join('|') > y.join('|') ? 1 : 0));

/**
 * Compile a `buildMjcf()` result with its loop closures excluded.
 * @param {object} mj  the engine
 * @param {object} built  from sim-mjcf.js buildMjcf()
 * @param {{cache?:{get(k):any, set(k,v):any}}} [opts]  default: an in-memory Map
 * @returns {{model, xml, sidecar, hash, cached:boolean, ms:{first?:number, compile:number}}}
 *   the caller deletes `model`
 */
export function compileDesign(mj, built, opts = {}) {
  const cache = opts.cache || _cache;
  const xml0 = built.emit(built.staticExcludes);
  const hash = designHash(xml0, built.meshes);
  let hit = cache.get(hash) || null;
  const ms = {};
  let model = null;
  if (!hit) {
    const t0 = performance.now();
    const m0 = compile(mj, { xml: xml0, meshes: built.meshes });
    try { hit = findLoops(mj, m0, built.sweep); } catch (e) { m0.delete(); throw e; }
    ms.first = +(performance.now() - t0).toFixed(0);
    if (!hit.loops.length) model = m0; else m0.delete();
    cache.set(hash, hit);
  }
  const xml = hit.loops.length ? built.emit(sortPairs([...built.staticExcludes, ...hit.loops])) : xml0;
  const t1 = performance.now();
  if (!model) model = compile(mj, { xml, meshes: built.meshes });
  ms.compile = +(performance.now() - t1).toFixed(0);
  const sidecar = { ...built.sidecar, design_hash: hash,
    model: { nbody: model.nbody, nq: model.nq, nv: model.nv, nu: model.nu, ngeom: model.ngeom, nmesh: model.nmesh,
      nexclude: model.nexclude, excludes_static: built.staticExcludes.length, baseline: hit.baseline, baseline_evidence: hit.evidence,
      baseline_rule: 'a pinned loop closure: one separation and one overlap over the jaw travel and every preset; excluded, every other pair live and reported as penetration minus baseline' } };
  return { model, xml, sidecar, hash, cached: !ms.first, ms };
}
