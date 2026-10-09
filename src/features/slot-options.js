/* What a slot offers and what is on the robot, in the shape the UI reads: the swap list, the
   compatibility line, visibility, removal and slot ownership.  Every function takes the
   `buildSlots()` instance.  Needs features/parts.js. */

import { parametricFor, COMPONENT_PARAMETRICS, paramDefs, paramValues, isModified } from './parts.js';
import { liveLabel } from './hinge.js';

/**
 * The slot a component really belongs to.
 *
 * `component.slot` is only what the manifest wrote on the component; a slot that claims a
 * whole attached package (`covers: ["attachment:pincopen"]`) names no component at all.
 * `buildSlots()` resolved the ownership into `S.owner`; ask it.
 */
export function slotOwnerOf(model, S, componentId) {
  if (!componentId || !S) return null;
  const c = model && model.component ? model.component(componentId) : null;
  if (c && c.slot && S.slots && S.slots[c.slot]) return c.slot;
  try { return (S.owner && S.owner.get(componentId)) || null; } catch (e) { return c ? c.slot || null : null; }
}

/**
 * The one list the swap popover shows for a slot: package options, the parametric
 * variants of whatever is fitted, and the registered alternatives — flattened, because to
 * the user "tilt 55" and "no overhead camera" are the same kind of choice.
 *
 *   { key, kind:'option'|'variant'|'alternative', id, label, source, summary, parts[], active }
 */
export function slotOptions(model, S, design, slotId, preferComponent) {
  const slot = S.slots[slotId];
  if (!slot) return [];
  const active = S.activeOption(design, slotId);
  const out = [];
  for (const o of S.options(slotId)) {
    if (o.kind === 'import') continue;
    out.push({
      key: 'o:' + o.id, kind: o.kind === 'alternative' ? 'alternative' : 'option', id: o.id,
      label: liveLabel(model, design, o, o.label), source: `${o.group === 'agent' ? o.source : model.id} · ${o.kind}`,
      parts: (o.shows || []).slice(), summary: o.note || o.notes || '',
      group: o.group || 'package', raw: o,
      active: o.id === active && !anyTweaked(design, o.shows)
    });
  }
  /* the parametric variants of the fitted option's primary part */
  const opt = S.options(slotId).find((o) => o.id === active);
  const shows = (opt && opt.shows) || [];
  const primary = (preferComponent && shows.includes(preferComponent) && parametricFor(preferComponent))
    ? preferComponent : shows.find((id) => parametricFor(id) && COMPONENT_PARAMETRICS[id]);
  if (primary) {
    const p = parametricFor(primary);
    const now = paramValues(design, primary);
    for (const v of (p.def.variants || [])) {
      const full = { ...p.defaults, ...p.params, ...v.params };
      const same = Object.keys(full).every((k) => Math.abs(full[k] - now[k]) < 1e-9);
      out.push({
        key: 'v:' + v.name, kind: 'variant', id: v.name, label: v.name, part: primary,
        params: v.params, source: `${model.id} · parametric`, parts: [primary],
        summary: summaryOf(primary, full) + (v.note ? '' : ''), note: v.note || '',
        group: 'package', active: same
      });
    }
  }
  /* exactly one card reads "fitted": a matching variant wins over its own option */
  const v = out.find((o) => o.kind === 'variant' && o.active);
  if (v) for (const o of out) if (o !== v) o.active = false;
  else if (!out.some((o) => o.active)) {
    const a = out.find((o) => o.kind !== 'variant' && o.id === active);
    if (a) a.active = true;
  }
  return out;
}
function anyTweaked(design, ids) {
  return (ids || []).some((id) => parametricFor(id) && isModified(design, id));
}

function summaryOf(partId, values) {
  const defs = paramDefs(partId);
  const bits = [];
  for (const d of defs.slice(0, 2)) {
    const v = values[d.key];
    if (v === undefined) continue;
    bits.push(`${d.key.replace(/_deg$/, '').replace(/^ui_/, '')} ${fmtNum(v)}${d.unit === 'mm' ? ' mm' : d.unit}`);
  }
  return bits.join(' · ');
}
const fmtNum = (n) => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : (+n).toFixed(2));

/** Apply one `slotOptions()` entry.  Returns `{design, patch, cascades, label}`. */
export function applySlotOption(model, S, design, slotId, entry) {
  if (entry.kind === 'variant') {
    const p = parametricFor(entry.part);
    const params = { ...(design.params || {}) };
    params[entry.part] = { ...p.defaults, ...p.params, ...entry.params };
    return { design: { ...design, params }, patch: { params: { [entry.part]: params[entry.part] } },
      cascades: [], label: entry.label, selected: entry.part };
  }
  const r = S.applyOption(design, slotId, entry.id, {});
  return { design: r.design, patch: r.patch, cascades: r.cascades || [], label: entry.label, selected: r.selected };
}

/** One sentence naming every cross-slot rule an option would fire, or `''`. */
export function compatLine(S, design, slotId, optionId) {
  try {
    const r = S.applyOption(design, slotId, optionId, {});
    const cs = r.cascades || [];
    if (!cs.length) return '';
    return cs.map((c) => {
      const sid = c.slot || c[0];
      const oid = c.option || c[1];
      const s = S.slots[sid];
      const o = s && s.optionById[oid];
      return `${s ? s.label : sid} → ${o ? o.label : oid}`;
    }).join(' · ');
  } catch (e) { return ''; }
}

/**
 * componentId → visible.  features/slots.js writes `design.components[id].visible`.
 * A component in `design.removed` is never visible, whatever a slot option derived —
 * Delete is the user's answer and only Restore undoes it.
 * The slots are the authority on what is fitted: `design.components` may only hide a part
 * the slots fit, never show one they do not.
 */
export function visibilityFor(model, S, design) {
  const vis = new Map();
  const over = (design && design.components) || {};
  const gone = (design && design.removed) || {};
  let unfitted = null;
  try { unfitted = S.unfittedSet(design || {}); } catch (e) { unfitted = null; }
  for (const c of model.components) {
    const o = over[c.id];
    const pkg = c.defaultVisible === undefined ? c.visible : c.defaultVisible;
    const shown = gone[c.id] ? false : (o && typeof o.visible === 'boolean' ? o.visible : pkg);
    vis.set(c.id, shown && !(unfitted && unfitted.has(c.id)));
  }
  return vis;
}

/** `true` when the user deleted this component (it sits in the tree's Removed group). */
export function isRemoved(design, componentId) {
  return !!((design && design.removed) || {})[componentId];
}

/**
 * The one count every screen shows: `parts` are the components on the robot (fitted, not
 * removed), `printed` those of them that print and are shown.
 */
export function partCounts(model, S, design, visible) {
  const unfitted = S.unfittedSet(design);
  const vis = visible || visibilityFor(model, S, design);
  let parts = 0, printed = 0;
  for (const c of model.components) {
    if (unfitted.has(c.id) || isRemoved(design, c.id)) continue;
    parts++;
    if (c.printable && vis.get(c.id) !== false) printed++;
  }
  return { parts, printed };
}

/**
 * The option that empties a slot — what **Remove** picks.  A package declares it as
 * `kind:"none"`; an older manifest may only carry the id, and an option that shows
 * nothing is the same thing by another name.  `null` when the slot cannot be emptied.
 */
export function emptyOptionOf(S, slotId) {
  const slot = S && S.slots && S.slots[slotId];
  if (!slot) return null;
  const opts = slot.options || [];
  return opts.find((o) => o.kind === 'none')
    || opts.find((o) => o.id === 'none')
    || opts.find((o) => o.kind !== 'import' && !(o.shows || []).length)
    || null;
}
