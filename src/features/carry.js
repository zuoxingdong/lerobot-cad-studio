/* Carry: a stretch or scale on one mesh moves what that mesh holds.  The other meshes of the
   same fitted part (or slot) lying wholly on the moving side, the part's hinge origins and its
   cameras are translated rigidly by the displacement there; a mesh across the plane stays and
   is named in a warning.  Pure; needs three, ops.js, hinge.js, mount-frame.js. */

import { Matrix4 } from 'three';
import { applyOps, stretchFrame, defaultAxis } from './ops.js';
import { partOf, partComponents } from './hinge.js';
import { mountOf } from './mount-frame.js';

const EPS = 1e-6;
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const add = (u, v) => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];
const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const isZero = (v) => !v || Math.hypot(v[0], v[1], v[2]) < 1e-9;
const mul3 = (M, v) => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];

/* a component's local as its package states it (no Move, hinge or carry) */
function baseLocal(c) {
  const raw = ((c.owner && c.owner.manifest && c.owner.manifest.components) || []).find((x) => x.id === c.localId);
  return raw && Array.isArray(raw.local) && raw.local.length === 16 ? new Matrix4().fromArray(raw.local) : c.local.clone();
}
const pristine = (c) => (c.geometry.userData && c.geometry.userData.opsBase) || c.geometry;

function boxOf(g) {
  if (!g.boundingBox) g.computeBoundingBox();
  const b = g.boundingBox;
  return { lo: b.min.toArray(), hi: b.max.toArray() };
}

/* the instances drawing one geometry (a mirrored pair shares it) */
function instancesOf(model, key) {
  const base = pristine(model.component(key));
  const ids = model.components.filter((x) => x.geometry && pristine(x) === base).map((x) => x.id);
  return ids.length ? ids : [key];
}

function slotMates(model, id, slots) {
  const sidOf = (x) => (slots && slots.slotOfComponent ? slots.slotOfComponent(x) : (model.component(x) || {}).slot);
  const sid = sidOf(id);
  return sid ? model.components.map((x) => x.id).filter((x) => sidOf(x) === sid) : [];
}

/* scale op -> {M 3×3, o pivot} (ops.js semantics) */
function scaleOf(op, box, mount) {
  const fac = typeof op.s === 'number' ? [op.s, op.s, op.s] : op.factors;
  const F = op.frame ? op.frame.map(unit) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += fac[k] * F[k][i] * F[k][j];
  const centre = [0, 1, 2].map((k) => (box.lo[k] + box.hi[k]) / 2);
  const about = op.about || 'mount';
  const o = Array.isArray(about) ? about : about === 'mount' && mount ? mount.point : centre;
  return { M, o, centre };
}

/**
 * The displacement steps of one op stack, in the key's geometry frame:
 * [{a, c, sides:[±1], disp(point) -> [x,y,z], what}].  A refused op ends the list.
 */
function stepsOf(model, key, ops, o) {
  const c = model.component(key);
  const base = pristine(c);
  const mount0 = mountOf(model, key, { slots: o.slots, geometry: base });
  let mount = mount0;
  const r = o.build ? o.build(key, ops) : applyOps(base, ops, { mount: mount0 });
  const n = r && r.refused ? r.refused.index : ops.length;
  const before = (i) => (i === 0 ? base : (o.build ? o.build(key, ops.slice(0, i)) : applyOps(base, ops.slice(0, i), { mount: mount0 })).geometry);
  const steps = [];
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    if (op.op === 'stretch' && op.by) {
      const f = stretchFrame(op.axis || defaultAxis(base, mount), op.at, op.by, mount);
      const d = f.a.map((x) => x * op.by);
      steps.push({ a: f.a, c: f.c, sides: [1], disp: () => d, what: 'cut' });
    } else if (op.op === 'scale') {
      const box = boxOf(before(i));
      const { M, o: pivot, centre } = scaleOf(op, box, mount);
      let a;
      if (mount) {
        a = unit(mount.axis || mount.normal);
        if (dot(centre, a) < dot(mount.point, a)) a = a.map((x) => -x);
      } else {
        const ext = [0, 1, 2].map((k) => box.hi[k] - box.lo[k]);
        const k = ext[0] >= ext[1] ? (ext[0] >= ext[2] ? 0 : 2) : (ext[1] >= ext[2] ? 1 : 2);
        a = [0, 0, 0]; a[k] = 1;
      }
      let lo = Infinity, hi = -Infinity;
      for (const x of [box.lo[0], box.hi[0]]) for (const y of [box.lo[1], box.hi[1]]) for (const z of [box.lo[2], box.hi[2]]) {
        const s = dot([x, y, z], a); lo = Math.min(lo, s); hi = Math.max(hi, s);
      }
      const mid = (lo + hi) / 2, sO = dot(pivot, a);
      const sides = Math.abs(sO - mid) < 0.25 * (hi - lo) ? [1, -1] : [sO <= mid ? 1 : -1];
      /* a held part rides the centre of the scaled part's end face on its side */
      const cS = dot(centre, a);
      const disp = (p) => {
        const face = dot(p, a) >= mid ? hi : lo;
        const q = centre.map((v, k) => v + a[k] * (face - cS));
        const s = mul3(M, [q[0] - pivot[0], q[1] - pivot[1], q[2] - pivot[2]]);
        return [pivot[0] + s[0] - q[0], pivot[1] + s[1] - q[1], pivot[2] + s[2] - q[2]];
      };
      steps.push({ a, c: mid, sides, disp, what: 'middle' });
      if (mount) mount = { ...mount, point: add(pivot, mul3(M, [0, 1, 2].map((k) => mount.point[k] - pivot[k]))) };
    } else if (op.op === 'mirror' && mount && op.plane) {
      const n0 = unit(op.plane.normal), p0 = op.plane.point || [0, 0, 0];
      const refl = (q, dir) => { const k = 2 * (dir ? dot(q, n0) : dot(q, n0) - dot(p0, n0)); return q.map((v, j) => v - k * n0[j]); };
      mount = { point: refl(mount.point), normal: refl(mount.normal, true), ...(mount.axis ? { axis: refl(mount.axis, true) } : {}) };
    }
  }
  return steps;
}

/* one body (a point set in the key frame) through the steps -> {offset, crosses} */
function follow(steps, pts) {
  let off = [0, 0, 0], crosses = null;
  const n = pts.length / 3;
  for (const st of steps) {
    let lo = Infinity, hi = -Infinity;
    const cx = [Infinity, Infinity, Infinity], cX = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const x = pts[3 * i] + off[0], y = pts[3 * i + 1] + off[1], z = pts[3 * i + 2] + off[2];
      const s = x * st.a[0] + y * st.a[1] + z * st.a[2];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
      if (x < cx[0]) cx[0] = x; if (x > cX[0]) cX[0] = x;
      if (y < cx[1]) cx[1] = y; if (y > cX[1]) cX[1] = y;
      if (z < cx[2]) cx[2] = z; if (z > cX[2]) cX[2] = z;
    }
    const side = lo >= st.c - EPS ? 1 : hi <= st.c + EPS ? -1 : 0;
    if (!side) { if (st.sides.includes(1)) crosses = crosses || st.what; continue; }
    if (!st.sides.includes(side)) continue;
    off = add(off, st.disp([0, 1, 2].map((k) => (cx[k] + cX[k]) / 2)));
  }
  return { offset: off, crosses };
}

/* vertex positions of a geometry through a matrix (the same array when it is the identity) */
function positionsIn(geometry, M) {
  const src = geometry.attributes.position.array;
  if (M.equals(new Matrix4())) return src;
  const e = M.elements, out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

const NONE = { mesh: () => null, point: () => [0, 0, 0], ids: () => [], warnings: [], sig: '' };

/**
 * What the design's stretches and scales carry.
 * @param {object} model   a RobotModel
 * @param {object} design  its `design.parts` op stacks are read
 * @param {{slots?, visible?:(id)=>boolean, build?:(key, ops)=>{geometry, refused}}} [o]
 *   `build` is part-ops.js `build` (cached); without it the stack is re-run here.
 * @returns {{mesh(id):number[]|null, point(partId, xyz):number[], ids():string[],
 *   warnings:{key, id, text}[], sig:string}}
 *   mesh: the translation in that component's geometry frame; point: in the part frame
 */
export function carryOf(model, design, o = {}) {
  const parts = (design && design.parts) || {};
  const visible = o.visible || ((id) => { const c = model.component(id); return !!c && c.visible !== false; });
  const meshT = new Map(), byPart = new Map(), warnings = [];
  for (const [key, e] of Object.entries(parts)) {
    if (!e || e.copy_of || !Array.isArray(e.ops)) continue;
    const ops = e.ops.filter((x) => x && x.op !== 'move');
    if (!ops.some((x) => x.op === 'stretch' || x.op === 'scale')) continue;
    const kc = model.component(key);
    if (!kc || !kc.geometry) continue;
    let steps;
    try { steps = stepsOf(model, key, ops, o); } catch (err) { continue; }
    if (!steps.length) continue;
    for (const id of instancesOf(model, key)) {
      if (!visible(id)) continue;
      const inst = model.component(id);
      const toKey = baseLocal(inst).invert();
      const p = partOf(model, id);
      const deps = p ? partComponents(model, p.id) : slotMates(model, id, o.slots);
      for (const did of deps) {
        if (did === id || !visible(did)) continue;
        const d = model.component(did);
        if (!d || !d.geometry || d.owner !== inst.owner || (d.link || null) !== (inst.link || null)) continue;
        const rel = toKey.clone().multiply(baseLocal(d));
        const r = follow(steps, positionsIn(d.geometry, rel));
        if (r.crosses) warnings.push({ key, id: did, text: `${d.label || did} crosses the ${r.crosses === 'cut' ? 'cut' : 'scaled part'}: not moved` });
        if (isZero(r.offset)) continue;
        const R = rel.clone().invert();
        R.setPosition(0, 0, 0);
        const e2 = R.elements, v = r.offset;
        const back = [0, 1, 2].map((k) => e2[k] * v[0] + e2[4 + k] * v[1] + e2[8 + k] * v[2]);
        meshT.set(did, meshT.has(did) ? add(meshT.get(did), back) : back);
      }
      if (p) {
        if (!byPart.has(p.id)) byPart.set(p.id, []);
        byPart.get(p.id).push(steps);
      }
      if (p) break;
    }
  }
  if (!meshT.size && !byPart.size && !warnings.length) return NONE;
  const r6 = (v) => v.map((x) => x.toFixed(6)).join(',');
  return {
    mesh: (id) => meshT.get(id) || null,
    point(pid, xyz) {
      let sum = [0, 0, 0];
      for (const steps of byPart.get(pid) || []) sum = add(sum, follow(steps, xyz).offset);
      return sum;
    },
    ids: () => [...meshT.keys()],
    warnings,
    sig: [...meshT].map(([k, v]) => k + ':' + r6(v)).join('|'),
  };
}
