/* The robot's display meshes as visual-only geoms on a compiled sim model: group 1, contype 0,
   conaffinity 0, density 0, the component colour; collision geoms move to group 3.  Placed
   from MuJoCo's own body frames at qpos0, so the physics model is untouched. */

import * as THREE from 'three';
import { compile } from './sim-engine.js';
import { designParts } from './sim-design.js';
import { sane } from './sim-mjcf.js';
import { liquidXml } from './sim-scene.js';

export const VISUAL_GROUP = 1, COLLISION_GROUP = 3;

const rgba = (hex) => {
  const c = new THREE.Color(hex || '#9aa3ad');
  return [c.r, c.g, c.b].map((v) => +v.toFixed(4)).join(' ') + ' 1';
};

/* positions of `geo` carried by `M`, welded on exact float32 bits, as a MuJoCo .msh with faces */
export function faceMesh(geo, M) {
  const p = geo.attributes.position.array, idx = geo.index ? geo.index.array : null;
  const n = idx ? idx.length : p.length / 3, e = M.elements;
  const f = new Float32Array(3 * n), u = new Uint32Array(f.buffer), face = new Int32Array(n);
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const slot = new Int32Array(size).fill(-1);
  let m = 0;
  for (let t = 0; t < n; t++) {
    const k = (idx ? idx[t] : t) * 3, x = p[k], y = p[k + 1], z = p[k + 2];
    f[3 * m] = e[0] * x + e[4] * y + e[8] * z + e[12];
    f[3 * m + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    f[3 * m + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const a = u[3 * m], b = u[3 * m + 1], c = u[3 * m + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (size - 1);
    for (;;) {
      const s = slot[h];
      if (s < 0) { slot[h] = m; face[t] = m++; break; }
      if (u[3 * s] === a && u[3 * s + 1] === b && u[3 * s + 2] === c) { face[t] = s; break; }
      h = (h + 1) & (size - 1);
    }
  }
  /* drop triangles that welded to a line or a point: MuJoCo rejects zero-area faces */
  const keep = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const [i, j, k] = [face[t], face[t + 1], face[t + 2]];
    if (i === j || j === k || i === k) continue;
    const ax = f[3 * j] - f[3 * i], ay = f[3 * j + 1] - f[3 * i + 1], az = f[3 * j + 2] - f[3 * i + 2];
    const bx = f[3 * k] - f[3 * i], by = f[3 * k + 1] - f[3 * i + 1], bz = f[3 * k + 2] - f[3 * i + 2];
    if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-9) continue;
    keep.push(i, j, k);
  }
  const nf = keep.length / 3;
  const out = new Uint8Array(16 + 12 * m + 12 * nf);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, m, true);                 // nvertex, 0 normals, 0 uv, nface
  dv.setInt32(12, nf, true);
  new Float32Array(out.buffer, 16, 3 * m).set(f.subarray(0, 3 * m));
  new Int32Array(out.buffer, 16 + 12 * m, 3 * nf).set(keep);
  return { bytes: out, triangles: nf };
}

/* a body's world frame at the current data, in studio mm (floor z = 0 -> ground_z) */
function bodyMatrix(d, b, groundZ) {
  const X = d.xmat, P = d.xpos, r = (i, j) => X[9 * b + 3 * i + j];
  return new THREE.Matrix4().set(
    r(0, 0), r(0, 1), r(0, 2), P[3 * b] * 1000,
    r(1, 0), r(1, 1), r(1, 2), P[3 * b + 1] * 1000,
    r(2, 0), r(2, 1), r(2, 2), P[3 * b + 2] * 1000 + groundZ,
    0, 0, 0, 1);
}

/**
 * @param mj the engine; `st` {model, slots, design, geometry}; `built` the buildMjcf result;
 *   `c` the compileDesign result (xml, sidecar).
 * @returns {{xml, meshes:Map<file,Uint8Array>, sidecar, triangles}} the visual model; the
 *   collision meshes are included, the sidecar counts are the visual model's.
 */
export function addVisuals(mj, st, built, c) {
  const { model, slots, design } = st;
  const m = compile(mj, { xml: c.xml, meshes: built.meshes });
  const d = new mj.MjData(m);
  const keepQ = model.getJoints(), keepBase = { ...model.basePose };
  const undo = designParts(model, slots, design);
  model.setBasePose(null);
  model.setJoints(Object.fromEntries(model.controlJoints().map((k) => [k, 0])));
  const meshes = new Map(built.meshes), geoms = new Map();
  let triangles = 0;
  try {
    mj.mj_resetData(m, d);
    mj.mj_forward(m, d);
    const G = mj.mjtObj.mjOBJ_GEOM.value, gb = m.geom_bodyid;
    for (const id of c.sidecar.visible_ids) {
      const comp = model.component(id), name = sane(id);
      const g = mj.mj_name2id(m, G, `col_${name}`);
      const geo = (st.geometry && st.geometry.get(id)) || (comp && comp.geometry);
      if (!comp || g < 0 || !geo || !geo.attributes || !geo.attributes.position) continue;
      const M = bodyMatrix(d, gb[g], c.sidecar.ground_z_mm).invert().multiply(model.worldMatrix(id));
      const { bytes, triangles: nf } = faceMesh(geo, M);
      if (!nf) continue;
      meshes.set(`vis_${name}.msh`, bytes);
      geoms.set(name, rgba(comp.color));
      triangles += nf;
    }
  } finally {
    undo();
    model.setJoints(keepQ);
    model.setBasePose(keepBase);
    d.delete();
    m.delete();
  }
  const xml = visualXml(c.xml, geoms, liquidXml(c.sidecar.lab));
  const vm = compile(mj, { xml, meshes });
  const counts = { nbody: vm.nbody, nq: vm.nq, nv: vm.nv, nu: vm.nu, ngeom: vm.ngeom, nmesh: vm.nmesh };
  vm.delete();
  const sidecar = { ...c.sidecar, model: { ...c.sidecar.model, ...counts },
    visual: { geoms: geoms.size, triangles, group: VISUAL_GROUP, collision_group: COLLISION_GROUP } };
  return { xml, meshes, sidecar, triangles };
}

/** The collision XML with the visual class, mesh assets, one `vis_` geom after each `col_` geom and
    the tubes' liquid (sim-scene.js liquidXml) in the puck. */
export function visualXml(xml, geoms, liquid = null) {
  const L = xml.split('\n'), out = [];
  for (const line of L) {
    if (/^ {6}<geom type="mesh" group="1" /.test(line)) {                 // the collision class
      out.push(line.replace('group="1"', `group="${COLLISION_GROUP}"`));
      continue;
    }
    if (line === '  </default>') {
      out.push('    <default class="visual">');
      out.push(`      <geom type="mesh" group="${VISUAL_GROUP}" contype="0" conaffinity="0" density="0"/>`);
      out.push('    </default>');
    }
    if (line === '  </asset>') {
      for (const n of geoms.keys()) out.push(`    <mesh name="vis_${n}" file="vis_${n}.msh" scale="0.001 0.001 0.001" inertia="shell"/>`);
    }
    out.push(line);
    const g = /^(\s*)<geom class="collision" name="col_([^"]+)"/.exec(line);
    if (g && geoms.has(g[2])) out.push(`${g[1]}<geom class="visual" name="vis_${g[2]}" mesh="vis_${g[2]}" rgba="${geoms.get(g[2])}"/>`);
    if (liquid && line.includes(` name="${liquid.after}" `)) out.push(...liquid.lines);
  }
  return out.join('\n');
}
