/* The parametric part library (preview tier): which part generates which package component,
   how one is built, and the parameter values a design gives it.
   Needs features/geometry-kit.js and features/part-pi-case.js. */

/* These are live previews, not ground truth: tools/cad/ regenerates the real solids from the
   same parameter keys.  Every bounding box matches the reference STL to 0.4 mm. */

import { defaultsOf } from './geometry-kit.js';
import { pi_case } from './part-pi-case.js';

/** every parametric part this build knows, by id. */
export const PARTS = { pi_case };

/**
 * Component id -> the parametric part that regenerates it.  EVERY key here must be a
 * component of a shipped package, or the Shape section offers knobs for a mesh that is not
 * on any robot (the parts unit suite asserts it).
 */
export const COMPONENT_PARAMETRICS = {
  pi_case_cradle: { part: 'pi_case', mesh: 'pi_case_cradle' },
  pi_case_panel:  { part: 'pi_case', mesh: 'pi_case_panel' },
};

const variantIndexOf = (def, name) =>
  (def && Array.isArray(def.variants)) ? def.variants.findIndex((v) => v.name === name) : -1;

/**
 * The parametric part behind a component id, or the part itself for a part id.
 * Returns null for anything this library does not generate.
 * @param {string} key component id (e.g. "pi_case_cradle") or part id
 * @returns {{id, def, mesh, variant, variantIndex, params, defaults, source}|null}
 */
export function parametricFor(key) {
  if (!key) return null;
  const rec = COMPONENT_PARAMETRICS[key];
  if (rec) {
    const def = PARTS[rec.part];
    if (!def) return null;
    const vi = variantIndexOf(def, rec.variant);
    return {
      id: rec.part, def, mesh: rec.mesh || null,
      variant: rec.variant || null, variantIndex: vi,
      params: Object.assign({}, (vi >= 0 ? def.variants[vi].params : null), rec.params || {}),
      defaults: defaultsOf(def), source: 'component',
    };
  }
  if (PARTS[key]) {
    const def = PARTS[key];
    return { id: key, def, mesh: null, variant: null, variantIndex: -1,
             params: {}, defaults: defaultsOf(def), source: 'part' };
  }
  return null;
}

/** A `ctx` for `build(params, ctx)` from a RobotModel: every part's parameters. */
export function modelContext(model, params = {}) {
  return { model: model || null, params };
}

/**
 * Build one parametric part, resolving its variant and the caller's overrides.
 * @returns {{ok, id, result, params, ms, error}}
 */
export function buildParametric(key, overrides, ctx) {
  const p = parametricFor(key);
  if (!p) return { ok: false, id: key, result: null, params: {}, ms: 0, error: `no parametric part for "${key}"` };
  const params = Object.assign({}, p.defaults, p.params, overrides || {});
  const t0 = Date.now();
  try {
    const result = p.def.build(params, ctx || { params: {} });
    return { ok: true, id: p.id, result, params, ms: Date.now() - t0, error: null };
  } catch (err) {
    return { ok: false, id: p.id, result: null, params, ms: Date.now() - t0, error: String((err && err.message) || err) };
  }
}

/* parameter values */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** The knob list of a component, or `[]` when nothing parametric generates it. */
export function paramDefs(componentId) {
  const p = parametricFor(componentId);
  return p && COMPONENT_PARAMETRICS[componentId] ? (p.def.params || []) : [];
}
export function paramDefaults(componentId) {
  const p = parametricFor(componentId);
  if (!p) return {};
  return { ...p.defaults, ...p.params };
}
/** defaults ∪ the component's variant ∪ `design.params[id]`, clamped into every range. */
export function paramValues(design, componentId) {
  const out = paramDefaults(componentId);
  const cur = ((design && design.params) || {})[componentId] || {};
  for (const d of paramDefs(componentId)) {
    const v = cur[d.key];
    if (v === undefined || v === null || Number.isNaN(+v)) continue;
    out[d.key] = d.min !== undefined ? clamp(+v, d.min, d.max) : +v;
  }
  return out;
}
export function isModified(design, componentId) {
  const def = paramDefaults(componentId), now = paramValues(design, componentId);
  return Object.keys(def).some((k) => Math.abs(def[k] - now[k]) > 1e-9);
}
/**
 * The knobs a load seeds for one component (`slots.reconcile` with its own unset), or
 * undefined when nothing seeds it.  A knob reset stores exactly this, so a design saved
 * right after one is byte-for-byte its own reload.
 */
export function seededParams(design, componentId, slots) {
  const params = { ...((design && design.params) || {}) };
  delete params[componentId];
  return slots.reconcile({ ...design, params }).design.params[componentId];
}
export function partTitle(componentId) {
  const p = parametricFor(componentId);
  return (p && p.def.title) || null;
}

/** the parametric components of this model, in tree order — what a rebuild must touch. */
export function parametricComponentsOf(model) {
  return model.components.filter((c) => !!COMPONENT_PARAMETRICS[c.id]).map((c) => c.id);
}

/**
 * The mesh a parametric component's ops run on: the package mesh while its knobs are at their
 * defaults (the export prints it), else null (the knob build itself).
 */
export function opsBase(model, design, componentId) {
  return COMPONENT_PARAMETRICS[componentId] && !isModified(design, componentId) ? model.packageGeometry(componentId) : null;
}

/**
 * Rebuild one parametric component from the design's parameters.  `geometry` is drawn while
 * the part has no ops (the default MJCF and its baked dress are hashed on it); `base` takes them.
 * @returns {{ok, geometry, base, printTransform, place, frames, warnings, stats, annotations, ms, error}}
 */
export function rebuildComponent(model, design, componentId) {
  const rec = COMPONENT_PARAMETRICS[componentId];
  if (!rec) return { ok: false, geometry: null, error: 'not parametric' };
  const all = {};
  for (const id of Object.keys(COMPONENT_PARAMETRICS)) {
    const p = parametricFor(id);
    if (p) all[p.id] = paramValues(design, id);
  }
  const r = buildParametric(componentId, paramValues(design, componentId), modelContext(model, all));
  if (!r.ok) return { ok: false, geometry: null, warnings: [], error: r.error, ms: r.ms };
  const meshes = (r.result && r.result.meshes) || [];
  const pick = (rec.mesh ? meshes.find((m) => m.name === rec.mesh) : null) || meshes[0] || null;
  return {
    ok: !!pick, geometry: pick ? pick.geometry : null, printTransform: pick ? pick.printTransform : null,
    base: (pick && opsBase(model, design, componentId)) || (pick ? pick.geometry : null),
    /* a mesh drawn somewhere other than where it is printed carries `place` */
    place: (pick && pick.place) || null,
    frames: (r.result && r.result.frames) || {}, warnings: (r.result && r.result.warnings) || [],
    stats: (r.result && r.result.stats) || null, annotations: (r.result && r.result.annotations) || [],
    ms: r.ms, error: null,
  };
}
