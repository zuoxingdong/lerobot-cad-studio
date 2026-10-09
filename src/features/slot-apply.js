/* Applying a slot option to a design: the pure transform that returns a NEW design plus the
   store patch, with the visibility, parametric and cascade rules it implies.
   Needs features/parts.js and features/slot-state.js. */

import { parametricFor } from './parts.js';
import { uniq, need, options, findOption } from './slot-state.js';

export function cloneDesign(d) {
  const out = Object.assign({}, d || {});
  out.slots = Object.assign({}, (d && d.slots) || {});
  out.params = Object.assign({}, (d && d.params) || {});
  out.removed = Object.assign({}, (d && d.removed) || {});
  out.components = {};
  for (const [k, v] of Object.entries((d && d.components) || {})) out.components[k] = Object.assign({}, v);
  return out;
}

export function setComponent(work, id, patch) {
  work.components[id] = Object.assign({}, work.components[id], patch);
}

/** The option a slot is showing while a design is being derived.  An ABSENT slot entry is
 *  the package default, never "no option" — reading it as "nothing fitted" empties every
 *  other slot on the next swap and writes those `visible:false` flags in for good. */
export function optionInForce(work, sid, I) {
  const slot = I.slots[sid];
  return findOption(sid, work.slots[sid], I) || findOption(sid, slot.default, I);
}

/** Visibility is DERIVED from `design.slots`, so the order of user actions
 *  cannot leave a stale component visible. */
export function deriveVisibility(work, I) {
  const vis = new Map();
  for (const sid of I.order) {
    const slot = I.slots[sid];
    const opt = optionInForce(work, sid, I);
    for (const id of slot.owns) vis.set(id, !!(opt && opt.showSet && opt.showSet.has(id)));
  }
  /* an attachment the active option does not enable disappears whole, including
     the components a sub-slot (fingertips) owns */
  for (const sid of I.order) {
    const slot = I.slots[sid];
    if (!slot.attachments.length) continue;
    const opt = optionInForce(work, sid, I);
    const on = new Set((opt && opt.attachments) || []);
    for (const att of slot.attachments) {
      if (on.has(att)) continue;
      for (const id of I.componentsOfAttachment(att)) vis.set(id, false);
    }
  }
  /* A DELETED component stays gone through every later swap: `design.removed` is the
     user's answer and a slot option may not overrule it.  Deriving it here — the one
     place slot visibility is computed — is what makes `collide.setActiveFromDesign()`,
     `validate.validateDesign()` and every export path exclude it without knowing the
     word "removed". */
  const gone = (work && work.removed) || {};
  for (const [id, v] of vis) setComponent(work, id, { visible: gone[id] ? false : v });
  return work;
}

/** apply the parametric side of one option (variant + parameters)
 *
 *  PRECEDENCE (and the order matters — `parts.buildParametric` uses the same one, so the
 *  design and the mesh can never disagree):
 *      part defaults  <  the variant's fixed params  <  THE USER'S TWEAK  <  the option's
 *  A user who dragged `extra_tilt_deg` to 11 keeps 11; only picking a different option
 *  that names the parameter explicitly overrides them. */
export function applyParametrics(work, slotId, opt, I) {
  for (const id of opt.shows || []) {
    const p = parametricFor(id);
    if (!p) continue;
    const merged = Object.assign({}, p.defaults, p.params, work.params[id], (opt.params && opt.params[id]) || {});
    work.params[id] = merged;
    if (p.variant) setComponent(work, id, { variant: p.variant });
  }
  if (opt.kind === 'alternative') {
    setComponent(work, opt.id, {
      visible: true, slot: slotId, source: 'alternative', alternative: opt.altId,
      path: opt.path || null, frame: opt.frame, transform: opt.local || null, printable: opt.printable !== false,
    });
    if (opt.params && Object.keys(opt.params).length) work.params[opt.id] = Object.assign({}, work.params[opt.id], opt.params);
  }
  return work;
}

/** breadth-first `requires` propagation, then a repair pass */
export function cascade(work, originSlot, I, onCascade) {
  const locked = new Set([originSlot]);
  const queue = [originSlot];
  const log = [];
  let guard = 0;
  while (queue.length && guard++ < 64) {
    const sid = queue.shift();
    const cur = work.slots[sid];
    const opt = findOption(sid, cur, I);
    if (!opt || !opt.requires) continue;
    for (const [target, rule] of Object.entries(opt.requires)) {
      if (!I.slots[target]) continue;
      const now = work.slots[target];
      if (Array.isArray(rule.any) && rule.any.includes(now)) continue;
      if (!rule.else) continue;
      if (locked.has(target)) {
        log.push({ slot: target, option: now, why: `conflict: ${sid}=${cur} wants ${target} in [${(rule.any || []).join(', ')}], but it is pinned` });
        continue;
      }
      work.slots[target] = rule.else;
      locked.add(target); queue.push(target);
      log.push({ slot: target, option: rule.else, why: `required by ${sid}=${cur}` });
    }
  }
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const sid of I.order) {
      if (locked.has(sid)) continue;
      const cur = work.slots[sid];
      const opt = findOption(sid, cur, I);
      if (!opt || !opt.requires) continue;
      const bad = Object.entries(opt.requires).some(([t, rule]) =>
        I.slots[t] && Array.isArray(rule.any) && !rule.any.includes(work.slots[t]));
      if (!bad) continue;
      const fix = I.slots[sid].options.find((o) => o.id !== cur && Object.entries(o.requires || {}).every(
        ([t, rule]) => !I.slots[t] || !Array.isArray(rule.any) || rule.any.includes(work.slots[t])));
      if (!fix) continue;
      work.slots[sid] = fix.id;
      locked.add(sid); changed = true;
      log.push({ slot: sid, option: fix.id, why: `repaired: "${cur}" is not valid with the rest of the design` });
    }
    if (!changed) break;
  }
  if (onCascade) for (const c of log) onCascade(c.slot, c.option, c.why);
  return log;
}

/**
 * @param {object} design      rps/design@1 (never mutated)
 * @param {string} slotId
 * @param {string} optionId    a package option id, "alt:<id>", or "import"
 * @param {{cascade?:boolean, onCascade?:Function, select?:boolean}} [opts]
 * @returns {{design, patch, cascades, warnings, option, selected}}
 */
export function applyOption(design, slotId, optionId, opts = {}, inst) {
  const I = need(inst);
  const slot = I.slots[slotId];
  if (!slot) throw new Error(`slots: unknown slot "${slotId}"`);
  const opt = findOption(slotId, optionId, I);
  if (!opt) throw new Error(`slots: slot "${slotId}" has no option "${optionId}" (have: ${options(slotId, I).map((o) => o.id).join(', ')})`);

  const work = cloneDesign(design);
  work.slots[slotId] = optionId;
  const cascades = opts.cascade === false ? [] : cascade(work, slotId, I, opts.onCascade);

  deriveVisibility(work, I);
  /* ONLY the slot the user touched and the slots the cascade moved: re-applying every slot
     rewrites params on components this swap does not own, resetting the user's tweaks. */
  const touched = uniq([slotId, ...cascades.map((c) => c.slot)]).filter((sid) => I.slots[sid]);
  for (const sid of touched) {
    const o = findOption(sid, work.slots[sid], I);
    if (o) applyParametrics(work, sid, o, I);
  }

  const patch = diffPatch(design || {}, work);
  const selected = opt.shows && opt.shows.length ? opt.shows[0] : (opt.kind === 'alternative' ? opt.id : null);
  return { design: work, patch, cascades, warnings: [], option: opt, selected: opts.select === false ? null : selected };
}

/** minimal `{slots, params, components}` patch for `store.patch()` */
export function diffPatch(before, after) {
  const patch = {};
  const slots = {};
  for (const [k, v] of Object.entries(after.slots || {})) if (!before.slots || before.slots[k] !== v) slots[k] = v;
  if (Object.keys(slots).length) patch.slots = slots;
  const comps = {};
  for (const [k, v] of Object.entries(after.components || {})) {
    const prev = (before.components || {})[k];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(v)) comps[k] = v;
  }
  if (Object.keys(comps).length) patch.components = comps;
  const params = {};
  for (const [k, v] of Object.entries(after.params || {})) {
    const prev = (before.params || {})[k];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(v)) params[k] = v;
  }
  if (Object.keys(params).length) patch.params = params;
  return patch;
}
