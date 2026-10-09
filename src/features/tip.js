/* Where the fitted gripper actually reaches, and the tool tip in world mm.  Read by
   design-page.refreshFittedTip(), which feeds slots.setAnchorOffset('fingertips'), so a
   fingertip tweak or swap keeps moving the tip.  Needs three and features/gripper.js. */

import * as THREE from 'three';
import { fingertipPads } from './gripper.js';

/* ------------------------------------------------------------------ tip frames */

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * How far the fitted gripper reaches past a frame, measured on the geometry that is
 * actually on the robot — never a literal, or a fingertip tweak or swap moves the pads
 * while the tip stays put.  The fitted fingertip (`gripper.fingertipPads()` — the fingertips
 * slot, or the gripper slot for a stock single-sided jaw) is a mesh in the model, so the
 * reach is its farthest vertex along the frame's axis, in that frame.
 *
 * @returns {{reach:number, source:string, ids:string[], ok:boolean, warning:string|null}}
 */
export function tipReach(model, frameName = 'wrist_flange', axis = 'x', opts = {}) {
  const fallback = Number.isFinite(opts.fallback) ? opts.fallback : 70;
  const out = { reach: fallback, source: `fallback ${fallback} mm`, ids: [], ok: false, warning: null };
  /* MEASURE AT THE CLOSED POSE.  A four-bar coupler travels on an arc, so a fingertip's
     X in the flange frame grows by the coupler's own +5.36 mm as the jaw opens — measuring
     at whatever pose the robot happens to be in would read that as a longer fingertip.
     `frames.fingertip_pad` is declared shut; so is this. */
  const keepQ = opts.pose === false ? null : model.getJoints();
  if (keepQ) model.setJoints(model.zeroPose());
  try { return measureTip(model, frameName, axis, opts, out, fallback); }
  finally { if (keepQ) model.setJoints(keepQ); }
}

function measureTip(model, frameName, axis, opts, out, fallback) {
  let F = null;
  try { F = model.frameMatrix(frameName); } catch (e) { F = null; }
  if (!F) {
    out.warning = `ik: no frame "${frameName}" to measure the tip from — using ${fallback} mm`;
    return out;
  }
  const inv = F.clone().invert();
  const a = new THREE.Vector3(...(AXES[axis] || AXES.x));
  const pads = opts.pads || fingertipPads(model);
  const ids = (pads.ids || []).filter((id) => {
    const c = model.component(id);
    return c && c.geometry && c.geometry.attributes && c.geometry.attributes.position && c.visible !== false;
  });
  if (!ids.length) {
    out.warning = `ik: nothing fitted in ${pads.source} to measure the tip from — using ${fallback} mm`;
    return out;
  }
  const v = new THREE.Vector3();
  let best = -Infinity;
  for (const id of ids) {
    const M = model.worldMatrix(id);
    if (!M) continue;
    M.premultiply(inv);
    const pos = model.component(id).geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(M);
      const d = v.dot(a);
      if (d > best) best = d;
    }
  }
  if (!Number.isFinite(best)) return out;
  out.reach = best; out.ids = ids; out.ok = true;
  out.source = `${pads.source} → ${ids.join(' + ')}`;
  return out;
}

/**
 * A tip frame from a package frame: `reach` mm along one axis of `frameName`,
 * expressed in whichever link that frame hangs off.  For LeKiwi + PincOpen,
 * `flangeTip(model)` is the fitted PincOpen fingertip (+X of `wrist_flange`), and with the
 * stock jaw it is the real `Moving_Jaw_08d-v1` tip.
 * Pass `reach` to override the measurement; `null` (the default) measures.
 * @returns {{link, local:THREE.Matrix4, dirLocal:THREE.Vector3, name, reach, source, warning}}
 */
export function flangeTip(model, frameName = 'wrist_flange', reach = null, axis = 'x') {
  const spec = (model.manifest.frames || {})[frameName];
  if (!spec) throw new Error(`tip: the package has no frame "${frameName}"`);
  const link = spec.link || model.rootLink;
  const L = Array.isArray(spec.local) && spec.local.length === 16
    ? new THREE.Matrix4().fromArray(spec.local) : new THREE.Matrix4();
  const a = AXES[axis] || AXES.x;
  let r = reach, source = 'caller', warning = null;
  if (!Number.isFinite(r)) {
    const m = tipReach(model, frameName, axis);
    r = m.reach; source = m.source; warning = m.warning;
  }
  const local = L.clone().multiply(new THREE.Matrix4().makeTranslation(a[0] * r, a[1] * r, a[2] * r));
  const dirLocal = new THREE.Vector3(a[0], a[1], a[2]).transformDirection(L).normalize();
  return { link, local, dirLocal, reach: r, source, warning,
           name: `${frameName} +${r.toFixed(2)} mm ${axis.toUpperCase()}` };
}

/**
 * A tip frame for a jaw that pivots on the LAST arm joint: the hinge point plus
 * `reach` mm along the previous joint's axis (the finger direction), expressed in
 * the link that carries the hinge — so the tip does not move when the jaw opens.
 */
export function hingeTip(model, reach = 80, opts = {}) {
  const K = model.manifest.kinematics || {};
  const order = settableOrder(model, opts.armJoints || K.arm_joint_order);
  const grip = model.joint(order[order.length - 1]);
  const roll = model.joint(order[order.length - 2]);
  if (!grip || !roll) throw new Error('tip: the package has no gripper/roll joint to hang a tip on');
  const link = roll.child;
  const M = chainTo(model, link, grip.parent) || new THREE.Matrix4();
  M.multiply(grip.matrix(0));
  const hinge = new THREE.Vector3().setFromMatrixPosition(M);
  const dir = new THREE.Vector3(roll.axis[0], roll.axis[1], roll.axis[2]).normalize();
  const local = new THREE.Matrix4().makeTranslation(
    hinge.x + dir.x * reach, hinge.y + dir.y * reach, hinge.z + dir.z * reach);
  return { link, local, dirLocal: dir.clone(), hingeLocal: hinge.clone(), name: `${link} hinge +${reach} mm` };
}

/* -------------------------------------------------- chain helpers (hingeTip) */

/** the settable (non-mimic) joints, in the package's order when it declares one */
function settableOrder(model, order) {
  const ok = new Set(model.joints.filter((j) => j.settable).map((j) => j.name));
  const list = order || model.joints.filter((j) => j.settable).map((j) => j.name);
  return list.filter((n) => ok.has(n));
}

/** product of the joint origin matrices along the fixed chain `from` -> `to` (mm) */
function chainTo(model, from, to) {
  const q = [[from, new THREE.Matrix4()]];
  for (let guard = 0; guard < 64 && q.length; guard++) {
    const [cur, M] = q.shift();
    if (cur === to) return M;
    for (const j of model.joints) if (j.parent === cur) q.push([j.child, M.clone().multiply(j.matrix(0))]);
  }
  return null;
}


/**
 * The tool tip in WORLD mm — the fitted fingertip when there is one, else the jaw tip.
 * `flangeTip()` / `hingeTip()` return `{link, local}`: a frame is evaluated, not called.
 */
let _tipWarned = false;
export function tipPoint(model) {
  for (const make of [() => flangeTip(model), () => hingeTip(model)]) {
    try {
      const t = make();
      if (!t || !t.local) continue;
      const base = (model.hasLink && model.hasLink(t.link))
        ? model.fk(t.link) : (model.frameMatrix(t.link) || model.fk(t.link));
      const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(base, t.local));
      if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return [p.x, p.y, p.z];
    } catch (e) { /* try the next frame */ }
  }
  if (!_tipWarned) {
    _tipWarned = true;
    console.warn('tip.tipPoint: this package declares no tip frame (no `wrist_flange`, '
      + 'no gripper hinge) — the tip readout falls back to the robot origin.');
  }
  return [0, 0, 0];
}
