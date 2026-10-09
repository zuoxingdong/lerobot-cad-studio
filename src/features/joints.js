/* The control joints the pose popover shows: order, labels, the package's `control_display`
   slider mapping, and which presets apply.  Needs nothing. */

const D2R = Math.PI / 180;

/* Arm presets come from `manifest.presets` when the package declares them;
   `features/validate.js` falls back to a built-in set. */

export const JOINT_LABEL = {
  arm_shoulder_pan: 'Shoulder pan', arm_shoulder_lift: 'Shoulder lift', arm_elbow_flex: 'Elbow flex',
  arm_wrist_flex: 'Wrist flex', arm_wrist_roll: 'Wrist roll', arm_gripper: 'Gripper',
  'pincopen/jaw': 'Jaw'
};
/**
 * `kinematics.control_display[<joint>]` — how a slider should SHOW a control joint.
 *
 * A four-bar gripper is driven by an angle and used in millimetres: PincOpen's `jaw` is a
 * revolute joint, 0…30.001°, and what a user dials is the gap between the fingers, 0…40 mm.
 * The package publishes the mapping as data rather than the UI hard-wiring a formula, so a
 * second gripper with a different geometry — or none at all — needs no code here.
 *
 * @returns {{unit, label, min, max, step, to(q):number, from(v):number}|null}
 *          `null` when the joint has no mapping, and the slider is then the joint itself.
 */
export function controlDisplay(model, qualified) {
  if (!model || !qualified) return null;
  const att = qualified.includes('/') ? qualified.split('/')[0] : null;
  const local = att ? qualified.slice(att.length + 1) : qualified;
  const owner = att ? (model.attachments || []).find((a) => a.id === att) : null;
  if (att && !owner) return null;
  const man = ((owner ? owner.model : model) || {}).manifest || {};
  const spec = (((man.kinematics || {}).control_display) || {})[local];
  if (!spec || typeof spec !== 'object') return null;

  let to = null, from = null;
  if (spec.kind === 'fourbar_gap') {
    /* gap(q) = 2·L·(sin θ₀ − sin(θ₀ − q)); the inverse is the same identity read backwards */
    const L = Number(spec.link_length_mm), th0 = Number(spec.closed_crank_deg) * D2R;
    if (!(L > 0) || !Number.isFinite(th0)) return null;
    const s0 = Math.sin(th0);
    to = (q) => 2 * L * (s0 - Math.sin(th0 - (Number(q) || 0) * D2R));
    from = (v) => (th0 - Math.asin(Math.max(-1, Math.min(1, s0 - (Number(v) || 0) / (2 * L))))) / D2R;
  } else if (spec.kind === 'linear') {
    const k = Number.isFinite(spec.scale) ? spec.scale : 1;
    const b = Number.isFinite(spec.offset) ? spec.offset : 0;
    if (!k) return null;
    to = (q) => k * (Number(q) || 0) + b;
    from = (v) => ((Number(v) || 0) - b) / k;
  } else {
    return null;                                          // a kind this build does not know
  }
  const r = Array.isArray(spec.range) && spec.range.length === 2 ? spec.range : null;
  const lim = (model.jointLimits() || {})[qualified] || {};
  const range = r || [to(Number.isFinite(lim.lower) ? lim.lower : 0),
                      to(Number.isFinite(lim.upper) ? lim.upper : 0)];
  return {
    unit: spec.unit || 'mm', label: spec.label || '',
    min: Math.min(range[0], range[1]), max: Math.max(range[0], range[1]),
    step: Number.isFinite(spec.step) ? spec.step : 0.5,
    to, from,
  };
}

/** the row a single control joint contributes to the pose popover */
function motionRow(model, name, limits, label, gripper) {
  const L = limits[name] || {};
  const d = controlDisplay(model, name);
  const jointUnit = L.units === 'mm' ? 'mm' : '°';
  return {
    name, label, gripper,
    unit: d ? d.unit : jointUnit,
    min: d ? d.min : (Number.isFinite(L.lower) ? L.lower : -180),
    max: d ? d.max : (Number.isFinite(L.upper) ? L.upper : 180),
    step: d ? d.step : 0.5,
    jointUnit,
    /* identity unless the package published a mapping, so every caller can use them */
    toDisplay: d ? d.to : (q) => (Number(q) || 0),
    fromDisplay: d ? d.from : (v) => (Number(v) || 0),
  };
}

/**
 * The joints the pose popover shows, in order, with the unit and travel a SLIDER should use.
 *
 * `model.controlJoints()` is the authority: it drops the mimic joints, and on the repacked
 * PincOpen it ends with the revolute `pincopen/jaw` (degrees, 0…30.001).  That one carries a
 * `control_display` mapping, so its row reads 0…40 **mm of finger gap** and `toDisplay` /
 * `fromDisplay` convert either way — the joint itself stays an angle.  The gripper row is
 * whichever of the two is actually fitted — the jaw when the PincOpen is on the wrist, the
 * stock `arm_gripper` otherwise — so there is exactly one gripper slider.
 */
export function motionJoints(model, design, S) {
  let limits = {};
  let control = [];
  try { limits = model.jointLimits() || {}; control = model.controlJoints() || []; }
  catch (e) { return []; }                                // a package with no kinematics
  if (!control.length) return [];
  const drives = new Set(((model.manifest.kinematics || {}).drive_joints) || []);
  const jaw = control.find((n) => /(^|\/)jaw$/.test(n));
  const gripperFitted = !!(jaw && gripperIsAttached(model, design, S, jaw));
  const out = [];
  for (const name of control) {
    if (drives.has(name)) continue;                       // the base wheels are not arm joints
    if (name === jaw && !gripperFitted) continue;
    if (name === 'arm_gripper' && gripperFitted) continue;
    const isGrip = name === 'arm_gripper' || name === jaw;
    out.push(motionRow(model, name, limits,
      isGrip ? (name === jaw ? 'Jaw' : 'Gripper') : (JOINT_LABEL[name] || name.replace(/_/g, ' ')),
      isGrip));
  }
  /* A package whose only control joint IS the gripper (a gripper imported on its own) must
     still get its slider.  Nothing above may empty the panel while the model has
     something to drive. */
  if (!out.length && control.length) {
    for (const name of control) {
      if (drives.has(name)) continue;
      out.push(motionRow(model, name, limits,
        name === jaw ? 'Jaw'
          : (JOINT_LABEL[name] || name.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase())),
        name === jaw || name === 'arm_gripper'));
    }
  }
  return out;
}

/**
 * Has this robot an arm, or is it a gripper on its own?
 *
 * The pose popover's preset row is about an arm; on a gripper alone it would pose joints
 * the package does not have.  One gripper row and no arm row means: hide it.
 */
export function hasArmJoints(model, design, S) {
  return motionJoints(model, design, S).some((j) => !j.gripper);
}

/** Only the presets whose pose names a joint this robot actually has. */
export function applicablePresets(model, presets) {
  let control = [];
  try { control = model.controlJoints(); } catch (e) { control = []; }
  const set = new Set(control);
  return (presets || []).filter((p) => Object.keys((p && p.q) || {}).some((k) => set.has(k)));
}
/** is the attachment that owns this jaw joint actually fitted right now? */
function gripperIsAttached(model, design, S, jawName) {
  const att = jawName.includes('/') ? jawName.split('/')[0] : null;
  if (!att) return true;
  if (!model.attachments.some((a) => a.id === att)) return false;
  if (!S || !S.slots.gripper) return true;
  const active = S.activeOption(design, 'gripper');
  const opt = S.slots.gripper.optionById ? S.slots.gripper.optionById[active] : null;
  return !opt || (opt.attachments || []).includes(att) || opt.kind === 'attachment_default';
}
