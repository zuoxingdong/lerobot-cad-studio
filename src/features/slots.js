/* Slots: a functional position on the robot with interchangeable options, built from the
   robot package (`manifest.slots`) so the module is generic over any RobotModel.
   Needs the four features/slot-*.js modules. */

import { parametricFor } from './parts.js';
import {
  SLOTS_SCHEMA, ALTERNATIVE_SCHEMA, OPTION_KINDS, isObj, uniq, clone, need, setLast,
  options, findOption,
} from './slot-state.js';
import { anchorOf } from './slot-anchors.js';
import {
  registerAlternatives, alternativePlacement,
  alternativeCameraFrame, importOption,
} from './slot-alternatives.js';
import {
  applyOption, applyParametrics, deriveVisibility, cascade, cloneDesign, setComponent
} from './slot-apply.js';

export { SLOTS_SCHEMA, ALTERNATIVE_SCHEMA, options };
export { anchorOf } from './slot-anchors.js';
export {
  registerAlternatives, alternativePlacement,
  alternativeCameraFrame, importOption,
} from './slot-alternatives.js';
export { applyOption } from './slot-apply.js';

/* buildSlots(model) */

/**
 * @param {import('../core/robot-model.js').RobotModel} model
 * @param {{alternatives?:Array, order?:string[]}} [opts]
 * @returns {object} the slot set
 */
/* What a slot writes into the design (rps/design@1):
     design.slots[slotId]          = optionId      the active option
     design.components[id].visible = bool          every component the slot owns
     design.components[id].variant = '<name>'      parametric components only
     design.params[componentId]    = {...}         keyed by COMPONENT id, because two
                                                   components can share one part definition */
export function buildSlots(model, opts = {}) {
  if (!model || !Array.isArray(model.components)) {
    throw new Error('slots: buildSlots(model) needs a RobotModel');
  }
  const warnings = [];
  const block = model.slots || (model.manifest && model.manifest.slots) || {};
  /* upgrades the package marks `print_only` never become scene components */
  const printOnly = new Set(((model.manifest && model.manifest.upgrades) || [])
    .filter((u) => u.print_only).map((u) => u.part));
  const ids = Object.keys(block).filter((k) => k[0] !== '$' && isObj(block[k]));
  const order = (opts.order || []).filter((k) => ids.includes(k)).concat(ids.filter((k) => !(opts.order || []).includes(k)));

  /* component index, including attachment-qualified ids */
  const byId = new Map(model.components.map((c) => [c.id, c]));
  const byLocalId = new Map();
  for (const c of model.components) {
    const local = c.localId || c.id;
    if (!byLocalId.has(local)) byLocalId.set(local, []);
    byLocalId.get(local).push(c.id);
  }
  const attachmentIds = (model.attachments || []).map((a) => a.id);
  const ownedBy = (att) => model.components.filter((c) => c.owner === att || c.id.startsWith(att + '/')).map((c) => c.id);

  /** "tip_support" -> "pincopen/tip_support" when that is the only match. */
  function resolveComponent(raw, where) {
    if (raw == null) return null;
    const s = String(raw);
    if (byId.has(s)) return s;
    const hits = byLocalId.get(s) || [];
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) { warnings.push(`slots: "${s}" (${where}) is ambiguous — ${hits.join(', ')}`); return hits[0]; }
    return null;
  }

  /* pass 1: parse every slot, collect claims */
  const slots = {};
  const explicitClaim = new Map();      // component id -> slot id
  const attachClaim = [];               // {slot, attachment}

  for (const sid of order) {
    const raw = block[sid];
    const claims = [];                  // component ids named literally anywhere in this slot
    const attachments = [];

    const addClaim = (v, where) => {
      const s = String(v);
      if (s.startsWith('attachment:')) {
        const att = s.slice('attachment:'.length);
        if (!attachmentIds.includes(att)) { warnings.push(`slot "${sid}": covers "${s}" but nothing named "${att}" is attached`); return; }
        attachments.push(att);
        return;
      }
      const id = resolveComponent(s, `slot "${sid}" ${where}`);
      if (!id) {
        if (printOnly.has(s)) return;      // a print-only upgrade has no scene component, by design
        warnings.push(`slot "${sid}": ${where} "${s}" is not a component of ${model.id}`);
        return;
      }
      claims.push(id);
    };

    for (const c of raw.covers || []) addClaim(c, 'covers');

    const options = [];
    const optionById = {};
    for (const o of raw.options || []) {
      const kind = o.kind || 'components';
      if (!OPTION_KINDS.includes(kind)) warnings.push(`slot "${sid}" option "${o.id}": unknown kind "${kind}"`);
      const shows = [];
      const replaces = [];
      const atts = [];
      for (const p of o.parts || []) { const id = resolveComponent(p, `slot "${sid}" option "${o.id}".parts`); if (id) { shows.push(id); addClaim(p, `option "${o.id}".parts`); } else warnings.push(`slot "${sid}" option "${o.id}": part "${p}" is not a component`); }
      for (const p of o.show || []) { const id = resolveComponent(p, `slot "${sid}" option "${o.id}".show`); if (id) { shows.push(id); addClaim(p, `option "${o.id}".show`); } else warnings.push(`slot "${sid}" option "${o.id}": "${p}" is not a component`); }
      for (const p of o.replaces || []) { const id = resolveComponent(p, `slot "${sid}" option "${o.id}".replaces`); if (id) { replaces.push(id); addClaim(p, `option "${o.id}".replaces`); } else warnings.push(`slot "${sid}" option "${o.id}": replaces "${p}" is not a component`); }
      if (kind === 'attachment') {
        const att = o.package || o.attachment;
        if (attachmentIds.includes(att)) { atts.push(att); if (!attachments.includes(att)) attachments.push(att); }
        else warnings.push(`slot "${sid}" option "${o.id}": package "${att}" is not attached to ${model.id}`);
      }
      const opt = {
        id: o.id, slot: sid, label: o.label || o.id, kind, note: o.note || '',
        group: 'package', source: model.id,
        shows, replaces, attachments: atts,
        mount: o.mount || raw.anchor || null,
        requires: o.requires ? clone(o.requires) : null,
        params: o.params ? clone(o.params) : null,
        /* A PACKAGE OPTION MAY PUBLISH A CAMERA, exactly as a workspace alternative does —
           a part option (`assets/parts/<id>/part.json` cameras) carries
           the pose its head puts the sensor at, and `frame` says what that matrix is relative
           to, read by `alternativeCameraFrame()` like any other option's.  Without these two
           fields the same design moved the camera while it was a workspace folder and stopped
           the moment it graduated into the package. */
        cameras: o.cameras ? clone(o.cameras) : null,
        frame: o.frame || null,
        raw: o,
      };
      if (optionById[opt.id]) warnings.push(`slot "${sid}": duplicate option id "${opt.id}"`);
      optionById[opt.id] = opt;
      options.push(opt);
    }

    /* an `attachment_default` option shows exactly what the other options replace */
    const replacedHere = uniq(options.flatMap((o) => o.replaces));
    for (const o of options) if (o.kind === 'attachment_default') o.shows = replacedHere.slice();

    const def = raw.default && optionById[raw.default] ? raw.default
      : (options.find((o) => o.kind !== 'import' && o.kind !== 'none') || options[0] || {}).id || null;
    if (raw.default && !optionById[raw.default]) warnings.push(`slot "${sid}": default "${raw.default}" is not one of its options`);

    for (const id of claims) {
      const prev = explicitClaim.get(id);
      if (prev && prev !== sid) { warnings.push(`slots: component "${id}" is claimed by "${prev}" and "${sid}" — kept "${prev}"`); continue; }
      if (!prev) explicitClaim.set(id, sid);
    }
    for (const a of uniq(attachments)) attachClaim.push({ slot: sid, attachment: a });

    slots[sid] = {
      id: sid, label: raw.label || sid, hint: raw.hint || '',
      anchor: raw.anchor || null, mirrored: raw.mirrored === true,
      provides: (raw.provides || []).slice(),
      interface: raw.interface ? clone(raw.interface) : null,
      attachments: uniq(attachments),
      options, optionById, optionIds: options.map((o) => o.id), default: def,
      covers: [], owns: [], ownsSet: new Set(), raw,
    };
  }

  /* pass 2: ownership */
  const owner = new Map(explicitClaim);
  for (const { slot, attachment } of attachClaim) {
    for (const id of ownedBy(attachment)) if (!owner.has(id)) owner.set(id, slot);
  }
  for (const [id, sid] of owner) { slots[sid].owns.push(id); slots[sid].ownsSet.add(id); }
  for (const sid of order) {
    const slot = slots[sid];
    slot.owns.sort();
    slot.covers = slot.owns.slice();
    for (const o of slot.options) {
      /* an `attachment` option shows every component of that package this slot
         owns — the sub-slot components (fingertips) stay with their own slot */
      if (o.attachments.length) {
        const fromAtt = o.attachments.flatMap(ownedBy).filter((id) => slot.ownsSet.has(id));
        o.shows = uniq(o.shows.concat(fromAtt));
      }
      o.showSet = new Set(o.shows);
    }
  }

  /* the instance */
  const inst = {
    schema: SLOTS_SCHEMA, model, robot: model.id, order, slots, warnings,
    owner, attachmentIds,
    alternatives: Object.create(null),            // slot -> [alternative]
    componentsOfAttachment: ownedBy,
    /* slot -> [dx, dy, dz] in the ANCHOR FRAME's own axes.  A fitted part is not always the
       part the package declared the anchor for: stretch a fingertip, or swap to a longer
       nose, and the contact face is somewhere else.  The UI measures how far
       (`tip.tipReach`) and parks it here, so `anchorOf()` — the one place the anchor is
       resolved — answers with the frame the fitted geometry really has. */
    anchorOffsets: Object.create(null),
  };

  inst.slotOfComponent = (c) => slotOfComponent(c, inst);
  inst.describeComponent = (c) => describeComponent(c, inst);
  inst.options = (sid) => options(sid, inst);
  inst.optionsOf = inst.options;
  inst.option = (sid, oid) => findOption(sid, oid, inst);
  inst.registerAlternatives = (list, o) => registerAlternatives(list, inst, o);
  inst.clearAlternatives = (sid) => { if (sid) delete inst.alternatives[sid]; else inst.alternatives = Object.create(null); };
  inst.applyOption = (d, sid, oid, o) => applyOption(d, sid, oid, o, inst);
  inst.applyDefaults = (d, o) => applyDefaults(d, o, inst);
  inst.activeOption = (d, sid) => activeOption(d, sid, inst);
  inst.unfittedSet = (d) => unfittedSet(d, inst);
  inst.isFitted = (d, id) => isFitted(d, id, inst);
  inst.reconcile = (d) => reconcile(d, inst);
  inst.alternativePlacement = (sid, alt) => alternativePlacement(sid, alt, inst);
  inst.slotSummary = (d) => slotSummary(d, inst);
  inst.importOption = (sid, g, n, o) => importOption(sid, g, n, o, inst);
  inst.anchorOf = (sid) => anchorOf(sid, inst);
  inst.alternativeCameraFrame = (sid, alt) => alternativeCameraFrame(sid, alt, inst);
  /** offset the fitted anchor of one slot, in the anchor frame's own axes (mm) */
  inst.setAnchorOffset = (sid, off) => {
    if (!sid) return null;
    const v = Array.isArray(off) ? [off[0] || 0, off[1] || 0, off[2] || 0] : [0, 0, 0];
    if (!v[0] && !v[1] && !v[2]) delete inst.anchorOffsets[sid];
    else inst.anchorOffsets[sid] = v;
    return v;
  };
  inst.anchorOffset = (sid) => inst.anchorOffsets[sid] || null;
  inst.defaults = () => { const out = {}; for (const sid of order) out[sid] = slots[sid].default; return out; };
  inst.parametricsOf = (sid) => slots[sid].owns.map((id) => ({ component: id, parametric: parametricFor(id) })).filter((r) => r.parametric);

  setLast(inst);
  return inst;
}

/* who owns what */

/** @returns {string|null} the slot id that owns this component */
export function slotOfComponent(componentOrId, inst) {
  const d = describeComponent(componentOrId, inst);
  return d ? d.slot : null;
}

/** Accepts a component id, a component record, or an object carrying
 *  `userData.componentId` / `componentId` / `name` (walking up `parent`). */
export function describeComponent(componentOrId, inst) {
  const I = need(inst);
  if (componentOrId == null) return null;
  const hit = (key) => {
    if (key == null) return null;
    const sid = I.owner.get(String(key));
    if (!sid) return null;
    const slot = I.slots[sid];
    const comp = I.model.component(String(key));
    return {
      slot: sid, label: slot.label, hint: slot.hint, anchor: slot.anchor,
      id: String(key), component: comp || null,
      parametric: parametricFor(String(key)), optionCount: slot.options.length,
    };
  };
  if (typeof componentOrId === 'string') return hit(componentOrId);
  if (isObj(componentOrId)) {
    let o = componentOrId, guard = 0;
    while (o && guard++ < 16) {
      const u = o.userData || o;
      const r = hit(u.componentId) || hit(u.id) || hit(o.name);
      if (r) return r;
      o = o.parent;
    }
  }
  return null;
}

export function applyDefaults(design, opts = {}, inst) {
  const I = need(inst);
  let d = design || {};
  for (const sid of I.order) {
    const def = I.slots[sid].default;
    if (!def) continue;
    d = applyOption(d, sid, def, Object.assign({ cascade: false }, opts), I).design;
  }
  /* one derivation pass at the end so cross-slot rules settle once */
  const work = cloneDesign(d);
  deriveVisibility(work, I);
  for (const sid of I.order) {
    const o = findOption(sid, work.slots[sid], I);
    if (o) applyParametrics(work, sid, o, I);
  }
  return work;
}

/**
 * The components the CURRENT slot configuration does not put on the robot.
 *
 * `design.components[id].visible` cannot answer this — the user's eye toggle and an
 * unfitted option write the same false.  Visibility is therefore derived from the slots
 * alone (ignoring `design.components` and `design.removed`), so "unfitted" is a question
 * about the PACKAGE's answer, not the user's.
 *
 * @param {object} design  an `rps/design@1`
 * @returns {Set<string>} component ids owned by a slot whose active option does not show them
 */
export function unfittedSet(design, inst) {
  const I = need(inst);
  const work = cloneDesign(design || {});
  work.components = {};
  work.removed = {};
  /* resolve every slot, so a design that has never had applyDefaults() run over it (a blank
     `rps/design@1`) is measured against the package's defaults and not against "no option" */
  for (const sid of I.order) {
    const explicit = work.slots[sid];
    work.slots[sid] = (explicit && findOption(sid, explicit, I)) ? explicit : activeOption(design || {}, sid, I);
  }
  deriveVisibility(work, I);
  const out = new Set();
  for (const [id, rec] of Object.entries(work.components)) if (rec && rec.visible === false) out.add(id);
  return out;
}

/**
 * Reconcile a LOADED design with the package's slots (an autosave, a recent, a design JSON).
 *
 * A stored design carries `components[id].visible` for the parts it knew about and nothing
 * for parts the package gained later, so trusting those flags draws two wrist mounts at
 * once.  Visibility of every slot-owned component is therefore RE-DERIVED from the slot
 * choices on load:
 *   - a slot naming an option the package no longer has falls back to the package default;
 *   - a part the active option does not show is hidden, whatever the stored flag says;
 *   - a part the option shows is shown — unless the user hid it (an explicit `false`), and
 *     never when it sits in `design.removed` (deriveVisibility honours that).
 * Untouched: components no slot owns, params, tweaks, cameras, joints, base.
 *
 * @returns {{design: object, changed: boolean}} a new design object when anything changed
 */
export function reconcile(design, inst) {
  const I = need(inst);
  const work = cloneDesign(design || {});
  /* THE INFERENCE ONLY ANSWERS A PRE-SLOTS DESIGN.  Read it BEFORE any slot is filled in,
     or the first default written would make the design look like a slots design to the
     second (C2: a design with only `components[id].visible = false` had its hides thrown
     away, because the caller applied the package defaults before reconciling). */
  const preSlots = !Object.keys(work.slots || {}).length;
  for (const sid of I.order) {
    const explicit = work.slots[sid];
    if (explicit && findOption(sid, explicit, I)) continue;
    /* An "alt:<id>" choice is KEPT even when no such option is registered yet.  The
       alternatives list arrives asynchronously (the IndexedDB cache, an import), and
       boot reconciles before it does — so a fallback here
       replaced every fitted alternative with the package default on reload, and
       `realizeFittedAlternatives()` then found no `alt:` slot left to draw. */
    if (typeof explicit === 'string' && explicit.startsWith('alt:')) continue;
    const inferred = preSlots ? activeOption(design || {}, sid, I) : 'custom';
    work.slots[sid] = inferred !== 'custom' ? inferred : (I.slots[sid].default || null);
    if (!work.slots[sid]) delete work.slots[sid];
  }
  const derived = cloneDesign(work);
  deriveVisibility(derived, I);
  const before = (design && design.components) || {};
  for (const [id, rec] of Object.entries(derived.components)) {
    if (!rec || typeof rec.visible !== 'boolean') continue;
    const cur = before[id] || {};
    const userHid = cur.visible === false && rec.visible === true;
    setComponent(work, id, { visible: userHid ? false : rec.visible });
  }
  /* the parametric half of every settled option — the variant and the parameters the
     option names.  `applyDefaults` did this and `reconcile` did not, which is why boot
     needed both and "Reset to defaults" (which called neither properly) put an unbuilt
     design on the robot. */
  for (const sid of I.order) {
    const o = findOption(sid, work.slots[sid], I);
    if (o) applyParametrics(work, sid, o, I);
  }
  const changed = JSON.stringify(work.slots) !== JSON.stringify((design && design.slots) || {})
    || JSON.stringify(work.components) !== JSON.stringify(before)
    || JSON.stringify(work.params) !== JSON.stringify((design && design.params) || {});
  return { design: changed ? work : design, changed };
}

/** `true` when the slot configuration puts this component on the robot. */
export function isFitted(design, componentId, inst) {
  return !unfittedSet(design, inst).has(componentId);
}

/**
 * @returns {string} option id, or 'custom' when the design matches none.
 *
 * Inference from component visibility is a MIGRATION DEVICE, not an answer: it reads a
 * genuinely pre-slots design (one with `components[id].visible` and no `slots` map) and
 * nothing else.  Once a design has a slots map it has answered the question — an entry
 * names the option, an absent entry is the package default.  Run against a partial map,
 * one stale `visible:true` invents a slot choice the design never asked for.
 */
export function activeOption(design, slotId, inst) {
  const I = need(inst);
  const slot = I.slots[slotId];
  if (!slot) return 'custom';
  const map = (design && design.slots) || {};
  const explicit = map[slotId];
  if (explicit && findOption(slotId, explicit, I)) return explicit;
  if (Object.keys(map).length) {
    return findOption(slotId, slot.default, I) ? slot.default : 'custom';
  }
  const comps = (design && design.components) || {};
  /* A component the design says nothing about falls back to THE PACKAGE'S answer
     (`hidden_by_default`), not to "visible" — or a slot whose only non-empty option is one
     part reads as if that part were fitted. */
  const visible = (id) => {
    const rec = comps[id];
    if (rec && typeof rec.visible === 'boolean') return rec.visible;
    const c = I.model.component(id);
    return c ? c.defaultVisible !== false : true;
  };
  let best = null, bestScore = -1;
  for (const o of slot.options) {
    if (o.kind === 'import') continue;
    let match = true;
    for (const id of slot.owns) if (visible(id) !== o.showSet.has(id)) { match = false; break; }
    if (!match) continue;
    const score = o.shows.length * 10 + (o.kind === 'none' ? 0 : 1);
    if (score > bestScore) { best = o.id; bestScore = score; }
  }
  return best || 'custom';
}

/** The inspector's empty-selection "Overview" table. */
export function slotSummary(design, inst) {
  const I = need(inst);
  return I.order.map((sid) => {
    const s = I.slots[sid];
    const active = activeOption(design, sid, I);
    const opt = findOption(sid, active, I);
    const alts = (I.alternatives[sid] || []).length;
    return {
      slot: sid, label: s.label, hint: s.hint, anchor: s.anchor,
      activeOption: active, activeLabel: opt ? opt.label : 'Custom',
      kind: opt ? opt.kind : 'custom', isDefault: active === s.default,
      optionCount: s.options.length + alts + 1, packageOptions: s.options.length, alternatives: alts,
      note: opt ? opt.note || '' : '', components: opt ? (opt.shows || []).slice() : [],
      provides: s.provides.slice(), select: opt && opt.shows && opt.shows.length ? opt.shows[0] : null,
    };
  });
}
