/* Where the gripper's fingertip pads are: the slot whose anchor frame is the pad frame, in the
   root package or an attached gripper.  Needs nothing. */

/**
 * Where the contact pads are, resolved from the package — the answer features/tip.js and
 * the fingertip anchor offset need, so neither has to guess.
 *
 * A gripper's pads are named by a slot: the one whose `anchor` frame IS the pad frame and
 * whose `covers` are the parts bolted to it (PincOpen: `fingertips`, anchor
 * `fingertip_pad`, covering `tip_support` / `tip_support_2` on `finger_L` / `finger_R`).
 * The slot may live in the root package or inside an attached gripper, so the walk covers
 * both and qualifies every name the way `model.links` / `model.components` spell it.
 *
 * @param {import('../core/robot-model.js').RobotModel} model
 * @param {{padFrame?:string, visibleOnly?:boolean}} [opts]
 * @returns {{ok, slot, prefix, anchor, ids:string[], links:string[], mirrored:boolean,
 *            owner:object, source:string}}
 */
export function fingertipPads(model, opts = {}) {
  const none = { ok: false, slot: null, prefix: '', anchor: null, anchorBase: null, ids: [],
                 links: [], mirrored: false, owner: null, interface: null,
                 source: 'no fingertip slot' };
  if (!model || !model.manifest) return none;
  const cands = [];
  (function walk(m, prefix) {
    const sl = (m.manifest && m.manifest.slots) || {};
    for (const [id, sp] of Object.entries(sl)) {
      if (!sp || !sp.anchor || !Array.isArray(sp.covers) || !sp.covers.length) continue;
      if (opts.padFrame && sp.anchor !== opts.padFrame) continue;
      /* the fingertip slot is the answer when there is one; a bare `gripper` slot (the
         stock SO-101 jaw: one moving component, no fingertips) is the fallback */
      const score = (sp.mirrored ? 2 : 0)
        + (/finger|tip/i.test(id) ? 2 : (/grip|jaw|hand/i.test(id) ? 1 : 0));
      if (score > 0) cands.push({ id, spec: sp, prefix, owner: m, score });
    }
    for (const a of (m.attachments || [])) walk(a.model, prefix + a.id + '/');
  })(model, '');
  cands.sort((a, b) => b.score - a.score);
  if (!cands.length) return none;

  /* LINKS are kinematics — which links the pads ride — so they are read whatever is
     currently fitted.  IDS are geometry — which fingertip is ON the robot right now — so
     they are the VISIBLE covered components.  Conflating the two put a held prop on
     `Wrist_Roll` the moment the user swapped to a fingertip the root package models
     statically, and left IK measuring a fingertip that had just been hidden. */
  const resolve = (c) => {
    const byId = new Map((c.owner.manifest.components || []).map((x) => [x.id, x]));
    const ids = [], links = [];
    for (const id of c.spec.covers) {
      const raw = byId.get(id);
      const comp = model.component(c.prefix + id) || model.component(id);
      if (!raw && !comp) continue;
      const link = (comp && comp.link) || (raw && raw.link) || null;
      const qual = link && model.hasLink(c.prefix + link) ? c.prefix + link
        : (link && model.hasLink(link) ? link : null);
      if (qual && !links.includes(qual)) links.push(qual);
      if (comp && comp.geometry && comp.visible !== false) ids.push(comp.id);
    }
    return { ids, links };
  };
  const resolved = cands.map((c) => ({ c, ...resolve(c) }));
  /* every spelling of the SAME pad frame contributes its fitted geometry: the PincOpen
     package owns `fingertip_pad` and so does the composition, and a mod fitted through one
     of them is the fingertip for both */
  const union = (anchor) => {
    const out = [];
    for (const r of resolved) {
      if (r.c.spec.anchor !== anchor) continue;
      for (const id of r.ids) if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  let win = resolved.find((r) => r.links.length >= 2) || resolved.find((r) => r.links.length >= 1) || null;
  let ids = win ? union(win.c.spec.anchor) : [];
  if (!ids.length) {
    /* nothing on that pad frame is fitted — the PincOpen is swapped out for the stock jaw,
       say — so the gripper that IS on the robot answers, links and all */
    const alt = resolved.find((r) => r.ids.length);
    if (alt) { win = alt; ids = union(alt.c.spec.anchor); }
  }
  if (!win) return none;
  const base = win.c.spec.anchor;
  return {
    ok: true, slot: win.c.id, prefix: win.c.prefix,
    anchor: win.c.prefix + base, anchorBase: base,
    ids, links: win.links, mirrored: !!win.c.spec.mirrored, owner: win.c.owner,
    interface: win.c.spec.interface || null,
    source: `slots.${win.c.prefix}${win.c.id} (anchor ${win.c.prefix}${base})`,
  };
}
