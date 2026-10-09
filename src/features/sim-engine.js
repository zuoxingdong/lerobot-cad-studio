/* MuJoCo WASM (@mujoco/mujoco 3.14.0, single thread): load, compile, step, read back.
   Browser: injects site/vendor/mujoco-wasm.js (a classic script with the gzip+base64 WASM
   and the glue), so file:// and Pages work without COOP/COEP.  Node: node_modules.
   Views (`d.qpos`, `m.jnt_range`, ...) are fresh typed arrays on the WASM heap and ANY heap
   growth (a new MjData, a DoubleBuffer, `d.contact`) detaches the old ones: never keep one,
   re-read it.  Every embind object needs `.delete()`. */

import { gunzipSync } from 'fflate';
import { TIMESTEP } from './sim-physics.js';
import { versioned } from '../core/asset-version.js';

export const VENDOR_SCRIPT = 'vendor/mujoco-wasm.js';
export const VENDOR_GLOBAL = 'RPS_MUJOCO';
const isNode = () => typeof window === 'undefined' && typeof process === 'object' && !!(process.versions && process.versions.node);
let _engine = null;

function injectScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`sim: could not load ${url}`));
    document.head.appendChild(s);
  });
}

async function gunzip(u8) {
  if (typeof DecompressionStream === 'function') {
    return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return gunzipSync(u8).buffer;
}

async function loadBrowser(url) {
  if (!globalThis[VENDOR_GLOBAL]) await injectScript(versioned(url));
  const V = globalThis[VENDOR_GLOBAL];
  if (!V || typeof V.load !== 'function') throw new Error(`sim: ${url} did not define ${VENDOR_GLOBAL}`);
  const bin = atob(V.wasm), gz = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
  return V.load({ wasmBinary: await gunzip(gz), locateFile: () => '' });
}

async function loadNode() {
  const spec = '@mujoco/' + 'mujoco';               // not a bundle input
  const mod = await import(spec);
  return mod.default();
}

/** The engine module, once per page / process. */
export function loadEngine(opts = {}) {
  if (!_engine) {
    _engine = (isNode() ? loadNode() : loadBrowser(opts.url || VENDOR_SCRIPT)).catch((e) => { _engine = null; throw e; });
  }
  return _engine;
}

/** Compile {xml, meshes: Map<file, Uint8Array>} (meshdir "meshes") through the VFS; the caller deletes the model. */
export function compile(mj, { xml, meshes }) {
  const vfs = new mj.MjVFS();
  try {
    for (const [f, b] of meshes) vfs.addBuffer(`meshes/${f}`, b);
    vfs.addBuffer('scene.xml', new TextEncoder().encode(xml));
    return mj.MjModel.from_xml_path('scene.xml', vfs);
  } finally {
    vfs.delete();
  }
}

/** One live simulation: model + data, a fixed 2 ms step. */
export function createSim(mj, model) {
  if (Math.abs(model.opt.timestep - TIMESTEP) > 1e-12) throw new Error(`sim: timestep ${model.opt.timestep}, want ${TIMESTEP}`);
  const data = new mj.MjData(model);
  mj.mj_forward(model, data);
  let dead = false;
  return {
    mj, model, data,
    get time() { return data.time; },
    step(n = 1) { for (let i = 0; i < n; i++) mj.mj_step(model, data); },
    forward() { mj.mj_forward(model, data); },
    reset() { mj.mj_resetData(model, data); mj.mj_forward(model, data); },
    /** delete data and (unless kept) the model */
    free({ keepModel = false } = {}) {
      if (dead) return;
      dead = true;
      data.delete();
      if (!keepModel) model.delete();
    },
  };
}

/** Name -> id, -1 when missing. */
export function idOf(mj, m, type, name) {
  return mj.mj_name2id(m, mj.mjtObj[`mjOBJ_${type.toUpperCase()}`].value, name);
}

/** Everything a renderer reads, resolved once. `sidecar` is the scene.json of the build. */
export function indexSim(mj, m, sidecar) {
  const jnt = (n) => idOf(mj, m, 'joint', n);
  const qadr = m.jnt_qposadr, dadr = m.jnt_dofadr;
  const arm = sidecar.arm_joints.map((n) => ({ name: n, adr: qadr[jnt(n)] }));
  const jaw = (sidecar.jaw_joints || []).map((q) => ({ name: q, adr: qadr[jnt(q.replace(/\//g, '_'))] }));
  const base = ['base_x', 'base_y', 'base_yaw'].map((n) => ({ q: qadr[jnt(n)], v: dadr[jnt(n)] }));
  const props = (sidecar.props || []).map((p) => ({ ...p, body: idOf(mj, m, 'body', p.name) })).filter((p) => p.body >= 0);
  const act = (n) => idOf(mj, m, 'actuator', n);
  return { arm, jaw, base, props, groundZ: sidecar.ground_z_mm || 0,
    drive: ['drive_x', 'drive_y', 'drive_yaw'].map(act),
    armAct: sidecar.arm_joints.map((n) => act(`act_${n}`)),
    jawAct: jaw.map((j) => act(`act_${j.name.replace(/\//g, '_')}`)) };
}

/** MuJoCo state -> RobotModel: `model.setBasePose(r.base); model.setJoints(r.joints)`. mm, deg. */
export function robotPose(data, ix) {
  const q = data.qpos, R2D = 180 / Math.PI;
  const joints = {};
  for (const a of ix.arm) joints[a.name] = q[a.adr] * R2D;
  for (const j of ix.jaw) joints[j.name] = q[j.adr] * R2D;
  return { base: { x: q[ix.base[0].q] * 1000, y: q[ix.base[1].q] * 1000, yaw: q[ix.base[2].q] * R2D }, joints };
}

/** Free bodies in studio mm (floor z = 0 -> ground_z), quaternion w x y z. */
export function propPoses(data, ix) {
  const X = data.xpos, Q = data.xquat;
  return ix.props.map((p) => ({ name: p.name, kind: p.kind,
    pos_mm: [X[3 * p.body] * 1000, X[3 * p.body + 1] * 1000, X[3 * p.body + 2] * 1000 + ix.groundZ],
    quat: [Q[4 * p.body], Q[4 * p.body + 1], Q[4 * p.body + 2], Q[4 * p.body + 3]] }));
}

/** d.contact is a heap copy: read it into plain JS, free it, then touch views again. */
export function contacts(d) {
  const n = d.ncon;
  if (!n) return [];
  const vec = d.contact, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = vec.get(i);
    out[i] = [c.geom1, c.geom2, c.dist];
    c.delete();
  }
  vec.delete();
  return out;
}
