/* Two rules that live outside the Cameras object: which slot option poses which camera, and
   the short verdict chips a PiP footer shows.  Needs nothing. */

/* -------------------------------------------------- the option poses the camera */

/**
 * Adopt the camera block of one slot's fitted option.  A camera is a DEVICE bolted to a
 * MOUNT: the package declares the device (lens, intrinsics, name), and whichever option is
 * fitted in the slot that `provides` the camera declares WHERE IT IS.  Three rules, and
 * this is the one place they live:
 *
 *   · a pose block is registered through its `carrier` (a declared frame, a link name,
 *     `component:<id>`, or `robot`), or the slot anchor when it names none, and is
 *     re-resolved live on every `getPose()` so a wrist camera rides the arm;
 *   · `cameras.<id>: null` — and equally a fitted option that publishes no pose at all —
 *     means THERE IS NO CAMERA ON THIS OPTION: the id comes back in `off` and the caller
 *     switches it off, rather than leaving it at the last mount's pose;
 *   · AN OPTION MAY NOT CHANGE THE LENS: `hfov_deg` / `vfov_deg` in an option's block are
 *     dropped.  The hFOV belongs to the device the package declares.
 *
 * @param {Cameras} cams
 * @param {object} slots   a `features/slots.js buildSlots()` instance
 * @param {object} design  an `rps/design@1`
 * @param {string} slotId
 * @param {(camId:string, pose:object, opt:object)=>object} [adjust]  e.g. a hinge knob's turn
 * @returns {{moved:string[], off:string[]}} cameras this slot posed, and ones it turned off
 */
export function adoptSlotOption(cams, slots, design, slotId, adjust) {
  const out = { moved: [], off: [] };
  const slot = slots && slots.slots && slots.slots[slotId];
  if (!cams || !cams.registerFrames || !slot) return out;
  let opt = null;
  try { opt = slots.option(slotId, slots.activeOption(design || {}, slotId)); } catch (e) { opt = null; }
  const spec = (opt && opt.cameras) || {};
  const source = 'slot:' + slotId;
  /* idempotent: whatever this slot published last goes first, so an option that publishes
     nothing really does leave nothing behind */
  if (cams.clearOverridesFrom) cams.clearOverridesFrom(source);
  let anchorFrame = 'robot';
  try { anchorFrame = slots.alternativeCameraFrame(slotId, opt || {}) || 'robot'; } catch (e) { anchorFrame = 'robot'; }
  for (const [key, f] of Object.entries(spec)) {
    const camId = key.startsWith('cam_') ? key.slice(4) : key;
    if (!f) continue;                                    // `null` — no camera on this option
    let pose = { ...f };
    delete pose.hfov_deg;
    delete pose.vfov_deg;
    if (adjust) pose = adjust(camId, pose, opt) || pose;
    const carrier = (typeof f.carrier === 'string' && f.carrier) || anchorFrame;
    try {
      for (const id of cams.registerFrames({ ['cam_' + camId]: pose }, { frame: carrier, source })) out.moved.push(id);
    } catch (e) { /* an unresolvable carrier is "no camera", not a crash */ }
  }
  /* THE OPTION'S OWN PARTS ARE THE CAMERA'S HOUSING (Cameras.setSelfParts): whatever this
     option draws is what the camera it poses is bolted inside, so it is left out of that
     camera's ID pass.  A camera this option switches off keeps no housing from the last. */
  const ownParts = (opt && Array.isArray(opt.shows)) ? opt.shows.slice() : [];
  if (cams.setSelfParts) for (const id of out.moved) cams.setSelfParts(id, ownParts);
  for (const p of (slot.provides || [])) {
    if (!p.startsWith('cameras.')) continue;
    const id = p.slice('cameras.'.length);
    if (out.moved.includes(id)) continue;
    out.off.push(id);
    if (cams.setSelfParts) cams.setSelfParts(id, []);
  }
  return out;
}

/** `adoptSlotOption` over every slot of a package — what boot, a swap, an undo and a
 *  reset all need, because a cascade moves slots the user never touched. */
export function adoptAllSlotOptions(cams, slots, design, adjust) {
  const out = { moved: [], off: [] };
  for (const sid of Object.keys((slots && slots.slots) || {})) {
    const r = adoptSlotOption(cams, slots, design, sid, adjust);
    out.moved.push(...r.moved);
    out.off.push(...r.off);
  }
  return out;
}

/* ---------------------------------------------------------------- verdict */

/**
 * Short chips for a camera tile, e.g. "gripper visible · ball visible · robot fills 12 %".
 * level: 'pass' | 'warn'.  Warn when robot_pct > 35 or the tip is out of frame.
 * Red is never used for a camera verdict.
 */
export function verdict(ev, opts = {}) {
  const warn = { robot_pct: 35, ...(opts.warn || {}) };
  const chips = [];
  if (!ev || !ev.ok) return { text: 'no pose', level: 'unknown', chips: [{ key: 'pose', text: 'no pose', level: 'unknown' }] };
  if (ev.tip) {
    if (!ev.tip.in) chips.push({ key: 'tip', text: 'gripper out of frame', level: 'warn' });
    else if (ev.tip.occluded) chips.push({ key: 'tip', text: 'gripper hidden', level: 'warn' });
    else chips.push({ key: 'tip', text: 'gripper visible', level: 'pass' });
  }
  for (const p of ev.props || []) {
    const nm = String(p.id || 'prop');
    if (!p.in) chips.push({ key: 'prop:' + nm, text: nm + ' out of frame', level: 'warn' });
    else if (p.occluded) chips.push({ key: 'prop:' + nm, text: nm + ' hidden', level: 'warn' });
    else chips.push({ key: 'prop:' + nm, text: nm + ' visible', level: 'pass' });
  }
  if (Number.isFinite(ev.robot_pct)) {
    const over = ev.robot_pct > warn.robot_pct;
    chips.push({ key: 'robot', text: `robot fills ${Math.round(ev.robot_pct)} %`, level: over ? 'warn' : 'pass' });
  }
  if (Number.isFinite(ev.reach_disc_pct) && ev.reach_disc_pct > 0 && !chips.some((c) => c.key === 'robot')) {
    chips.push({ key: 'reach', text: `reach ${Math.round(ev.reach_disc_pct)} %`, level: 'pass' });
  }
  if (!chips.length) chips.push({ key: 'ok', text: 'posed', level: 'pass' });
  const level = chips.some((c) => c.level === 'warn') ? 'warn' : 'pass';
  return { text: chips.map((c) => c.text).join(' · '), level, chips };
}
