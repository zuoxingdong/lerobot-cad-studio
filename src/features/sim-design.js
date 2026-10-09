/* The design's part edits on a RobotModel for the MJCF build, the way the Design page shows
   them: mirrored copies (`design.parts[key].copy_of`) as components, stored placements
   (`components[id].transform`), carried meshes and hinge turns (`parts[partId].params`) on `local`. */

import * as THREE from 'three';
import { mat4 } from '../core/robot-model.js';
import { visibilityFor } from './slot-options.js';
import { hingeTransforms, partComponents } from './hinge.js';
import { createPartOps, copyFrame, copyLabel } from './part-ops.js';
import { carryOf } from './carry.js';
import { parametricComponentsOf, rebuildComponent } from './parts.js';

/* an arm to carry a gripper, a drive to move the base */
export const armed = (model) => ((model.manifest.kinematics || {}).arm_joint_order || []).length > 0;
export const mobile = (model) => ((model.manifest.kinematics || {}).drive_joints || []).length > 0;

/** What the Sim tab can run for a robot: `reason` / `labReason` say why not (a tooltip). */
export function simSupport(model) {
  if (!model || !model.manifest) return { teleop: false, lab: false, reason: 'No robot loaded.', labReason: 'No robot loaded.' };
  const drive = (model.manifest.kinematics || {}).drive_joints || [];
  const teleop = mobile(model) || model.controlJoints().some((n) => !drive.includes(n));
  const lab = armed(model) && model.attachments.some((a) => !!a.model.ownFrames.fingertip_pad);
  return { teleop, lab,
    reason: teleop ? null : 'Nothing to simulate: this robot has no moving joint and no drive.',
    labReason: lab ? null : 'The lab task needs an arm carrying a two-finger gripper.' };
}

/** The parametric parts regenerated from the design onto the model, as the Design page does
    at boot (`rebuildParametric`): a page and a headless export then hold the same geometry. */
export function applyParametrics(model, design) {
  const over = (design && design.components) || {};
  for (const id of parametricComponentsOf(model)) {
    const c = model.component(id);
    const r = c ? rebuildComponent(model, design, id) : null;
    if (!r || !r.ok || !r.geometry) continue;
    c.geometry = r.geometry;
    c.faces = r.geometry.attributes.position.count / 3;
    if (r.place && c.frame === 'robot' && !(over[id] || {}).transform) c.local.copy(r.place);
  }
}

/* a component's local as its package states it */
function baseLocal(c) {
  const raw = ((c.owner && c.owner.manifest && c.owner.manifest.components) || []).find((x) => x.id === c.localId);
  return raw ? mat4(raw.local) : c.local.clone();
}

/** What the design's stretches and scales carry (carry.js), for the fitted parts. */
export function designCarry(model, slots, design) {
  const vis = visibilityFor(model, slots, design);
  const ops = createPartOps({ model, slots });
  return carryOf(model, design, { slots, visible: (id) => !!vis.get(id), build: ops.build });
}

/* `design.parts` and stored placements on the model for the build: mirrored copies (`copy_of`)
   as components, `components[id].transform` and the hinge turns (`params`) on `local`.  The
   same on a page that already applied them.  Returns the undo. */
export function designParts(model, slots, design) {
  const parts = (design && design.parts) || {}, over = (design && design.components) || {};
  const added = [];
  let ops = null;
  for (const [key, e] of Object.entries(parts)) {
    if (!e || !e.copy_of || model.component(key)) continue;
    const src = model.component(e.copy_of);
    if (!src) continue;
    ops = ops || createPartOps({ model, slots });
    const r = ops.build(e.copy_of, e.ops || []);
    if (!r.ok || !r.geometry || r.refused) continue;
    const at = copyFrame(model, src, baseLocal(src));
    added.push({ id: key, localId: key, label: copyLabel(model, src, key), link: at.link, group: 'imported',
      slot: null, frame: at.frame, local: at.local, color: src.color, printable: src.printable, mesh: key,
      source: 'mirror', visible: true, defaultVisible: true, geometry: r.geometry, owner: model, imported: true, edited: true });
  }
  if (added.length) { model.ownComponents.push(...added); model._flatten(); }
  const vis = visibilityFor(model, slots, design);
  const H = hingeTransforms(model, design, (pid) => partComponents(model, pid).some((id) => vis.get(id)), designCarry(model, slots, design));
  const kept = [];
  for (const c of model.components) {
    const t = (over[c.id] || {}).transform, h = H.get(c.id);
    const placed = Array.isArray(t) && t.length === 16;
    if (!h && !placed) continue;
    const L = placed ? new THREE.Matrix4().fromArray(t) : baseLocal(c);
    kept.push([c, c.local]);
    c.local = h ? L.multiply(h) : L;
  }
  return () => {
    for (const [c, L] of kept) c.local = L;
    if (!added.length) return;
    model.ownComponents.splice(0, model.ownComponents.length, ...model.ownComponents.filter((c) => !added.includes(c)));
    model._flatten();
  };
}
