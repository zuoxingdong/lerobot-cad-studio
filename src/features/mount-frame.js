/* The mount of one component in its own geometry frame: part.json `mount.face` when the
   component belongs to a part folder, else an axis-aligned frame from the slot anchor (or the
   bounding box).  Needs three; ops.js consumes the result. */

import { Vector3 } from 'three';
import { MOUNT_CLEAR_MM, mountFromFrame } from './ops.js';
import { partOf } from './hinge.js';

const NO_ANCHOR_PLANE = 0.35;     // no anchor: the plane sits this far along the axis
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function safeWorld(model, id) {
  try { return model.worldMatrix(id) || null; } catch (e) { return null; }
}

/**
 * Axis-aligned mount frame in the geometry frame.
 * ai/ci/wi: main axis / contact normal / width axis index; as/cs: their signs;
 * origin: on the mount face; plane: default cut, mm along the main axis from origin.
 */
export function mountFrame(model, componentId, opts = {}) {
  const c = model && model.component ? model.component(componentId) : null;
  const geo = opts.geometry || (c && c.geometry) || null;
  if (!c || !geo || !geo.attributes || !geo.attributes.position) return null;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const box = geo.boundingBox;
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (!(ext[0] > 1e-6 || ext[1] > 1e-6 || ext[2] > 1e-6)) return null;

  let anchor = null;
  let source = 'bbox';
  const slots = opts.slots || null;
  const sid = opts.slot !== undefined ? opts.slot
    : (slots && slots.slotOfComponent ? slots.slotOfComponent(componentId) : null);
  const W = safeWorld(model, componentId);
  if (sid && slots && slots.anchorOf && W) {
    let a = null;
    try { a = slots.anchorOf(sid); } catch (e) { a = null; }
    if (a && a.matrix) {
      anchor = new Vector3().setFromMatrixPosition(W.clone().invert().multiply(a.matrix));
      source = 'slot:' + sid;
    }
  }

  /* the parent link origin: which way is "away from the robot" */
  const link = new Vector3(0, 0, 0);
  let F = null;
  try { F = c.link && model.fk ? model.fk(c.link) : null; } catch (e) { F = null; }
  if (W && F) link.setFromMatrixPosition(W.clone().invert().multiply(F));
  else if (W) link.setFromMatrixPosition(W.clone().invert());

  let ai = -1, ci = -1, as = 1, cs = 1;
  if (anchor) {
    /* the contact face is the bbox face the anchor lies on */
    const o = [anchor.x, anchor.y, anchor.z];
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      if (ext[i] < 1e-6) continue;
      const dHi = Math.abs(o[i] - hi[i]) / ext[i];
      const dLo = Math.abs(o[i] - lo[i]) / ext[i];
      const d = Math.min(dHi, dLo);
      if (d < best) { best = d; ci = i; cs = dHi <= dLo ? 1 : -1; }
    }
    if (best > 0.12) { ci = -1; source = 'bbox'; anchor = null; }
  }
  if (ci >= 0) {
    for (let i = 0; i < 3; i++) if (i !== ci && (ai < 0 || ext[i] > ext[ai])) ai = i;
    as = (lo[ai] + hi[ai]) / 2 >= link.getComponent(ai) ? 1 : -1;
  } else {
    ai = ext[0] >= ext[1] ? (ext[0] >= ext[2] ? 0 : 2) : (ext[1] >= ext[2] ? 1 : 2);
    as = (lo[ai] + hi[ai]) / 2 >= link.getComponent(ai) ? 1 : -1;
    for (let i = 0; i < 3; i++) if (i !== ai && (ci < 0 || ext[i] > ext[ci])) ci = i;
    cs = (lo[ci] + hi[ci]) / 2 >= link.getComponent(ci) ? 1 : -1;
  }
  const wi = 3 - ai - ci;

  const origin = anchor ? [anchor.x, anchor.y, anchor.z]
    : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  origin[ci] = cs > 0 ? lo[ci] : hi[ci];
  if (!anchor) origin[ai] = as > 0 ? lo[ai] : hi[ai];

  const axisMax = ((as > 0 ? hi[ai] : lo[ai]) - origin[ai]) * as;
  const axisMin = ((as > 0 ? lo[ai] : hi[ai]) - origin[ai]) * as;
  const contact = ((cs > 0 ? hi[ci] : lo[ci]) - origin[ci]) * cs;
  let plane = anchor ? MOUNT_CLEAR_MM : NO_ANCHOR_PLANE * ext[ai];
  plane = clamp(plane, axisMin + 0.5, Math.max(axisMin + 0.5, axisMax - 0.5));
  return { ai, ci, wi, as, cs, ws: 1, origin, plane, contact, axisMin, axisMax, extent: ext, source };
}

/**
 * The ops mount `{point, normal, axis?}` of one component, geometry frame, or null.
 * A part folder's `mount.face` wins; its meshes all share the part frame.
 */
export function mountOf(model, componentId, opts = {}) {
  const p = partOf(model, componentId);
  const face = p && p.doc && p.doc.mount && p.doc.mount.face;
  if (face && Array.isArray(face.point) && Array.isArray(face.normal)) {
    return { point: face.point.slice(), normal: face.normal.slice(), source: 'part:' + p.id };
  }
  const f = mountFrame(model, componentId, opts);
  if (!f || f.source === 'bbox') return null;
  return { ...mountFromFrame(f), source: f.source };
}
