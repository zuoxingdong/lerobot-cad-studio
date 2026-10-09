/* Part folders on a live model, and their hinge knobs (part.json `params.<key>.kind ===
   "hinge"`): a rigid turn of the `moves` meshes and the camera about `origin`/`axis`, snapped
   to `values`.  The value lives in `design.parts[<partId>].params[<key>]`.  An optional
   `carry` (carry.js) moves meshes, origins and cameras first.  Needs three. */

import { Matrix4, Vector3 } from 'three';

const INDEX = new WeakMap();

/** component id -> {id, doc, mesh} for every part-folder component of the model */
function indexOf(model) {
  let ix = INDEX.get(model);
  if (ix) return ix;
  ix = new Map();
  const m = (model && model.manifest) || {};
  const parts = m.parts || {};
  for (const c of m.components || []) {
    if (!c || !c.part_of || !parts[c.part_of]) continue;
    const doc = parts[c.part_of];
    ix.set(c.id, { id: c.part_of, doc, mesh: c.part_mesh || null });
  }
  INDEX.set(model, ix);
  return ix;
}

/**
 * A part folder that is not in the package (an agent design, a linked folder): its doc goes
 * into the model's part table and its meshes onto their drawn components, so its hinge knobs
 * work like a package part's.  `componentOf(meshId)` names the component drawing each mesh.
 */
export function registerPart(model, partId, doc, componentOf) {
  if (!model || !model.manifest || !partId || !doc) return false;
  const meshes = (doc.meshes || []).map((m) => ({ ...m, component: componentOf(m.id) || m.component || null }));
  const rec = { ...doc, id: partId, meshes };
  model.manifest.parts = { ...(model.manifest.parts || {}), [partId]: rec };
  const ix = indexOf(model);
  for (const [cid, p] of [...ix]) if (p.id === partId) ix.delete(cid);
  for (const m of meshes) if (m.component) ix.set(m.component, { id: partId, doc: rec, mesh: m.id });
  return true;
}

/** The part folder a component comes from, or null. */
export function partOf(model, componentId) {
  return (model && indexOf(model).get(componentId)) || null;
}

/** Every component id drawn from one part folder, in mesh order. */
export function partComponents(model, partId) {
  const out = [];
  for (const [id, p] of indexOf(model)) if (p.id === partId && model.component(id)) out.push(id);
  return out;
}

/** The part a slot option fits, or null. */
export function partOfOption(model, opt) {
  if (!opt) return null;
  const pid = opt.part || (opt.raw && opt.raw.part) || null;
  if (pid && model.manifest && model.manifest.parts && model.manifest.parts[pid]) return pid;
  const first = (opt.shows || []).map((id) => partOf(model, id)).find(Boolean);
  return first ? first.id : null;
}

/** [{key, def}] of a part's hinge params; with `carry`, `def.origin` is where the carry put it. */
export function hingesOf(model, partId, carry) {
  const doc = model && model.manifest && model.manifest.parts && model.manifest.parts[partId];
  const params = (doc && doc.params) || {};
  return Object.entries(params)
    .filter(([, d]) => d && d.kind === 'hinge' && Array.isArray(d.values) && d.values.length
      && Array.isArray(d.origin) && Array.isArray(d.axis))
    .map(([key, def]) => {
      const d = carry ? carry.point(partId, def.origin) : null;
      return { key, def: d && Math.hypot(...d) > 1e-9 ? { ...def, origin: def.origin.map((v, i) => v + d[i]) } : def };
    });
}

const translation = (d) => (d && Math.hypot(d[0], d[1], d[2]) > 1e-9 ? new Matrix4().makeTranslation(d[0], d[1], d[2]) : null);

/** The nearest declared detent. */
export function snapDetent(def, v) {
  let best = def.values[0];
  for (const x of def.values) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
  return best;
}

/** The design's value, snapped; the part's own `value` when the design has none. */
export function hingeValue(design, partId, key, def) {
  const p = design && design.parts && design.parts[partId];
  const v = p && p.params && Number.isFinite(p.params[key]) ? p.params[key] : def.value;
  return snapDetent(def, Number.isFinite(v) ? v : def.design);
}

/** Is `v` inside the part's usable range? */
export function isUsable(def, v) {
  const u = def.usable;
  return !Array.isArray(u) || u.length < 2 || (v >= u[0] - 1e-9 && v <= u[1] + 1e-9);
}

/** The turn about the hinge for `value`, in the part (geometry) frame. */
export function hingeMatrix(def, value) {
  const deg = value - (Number.isFinite(def.design) ? def.design : def.value);
  const M = new Matrix4();
  if (Math.abs(deg) < 1e-12) return M;
  const o = new Vector3().fromArray(def.origin);
  const a = new Vector3().fromArray(def.axis).normalize();
  const R = new Matrix4().makeRotationAxis(a, (deg * Math.PI) / 180);
  return M.makeTranslation(o.x, o.y, o.z).multiply(R).multiply(new Matrix4().makeTranslation(-o.x, -o.y, -o.z));
}

/**
 * Component id -> the transform to post-multiply onto its `local`: the hinge turn of every fitted
 * part off its design detent, after the `carry` translation (the turn is about the carried origin).
 * `fitted(partId)` filters to the parts on the robot.
 */
export function hingeTransforms(model, design, fitted, carry) {
  const out = new Map();
  const parts = (model && model.manifest && model.manifest.parts) || {};
  for (const pid of Object.keys(parts)) {
    if (fitted && !fitted(pid)) continue;
    for (const { key, def } of hingesOf(model, pid, carry)) {
      const v = hingeValue(design, pid, key, def);
      if (Math.abs(v - (Number.isFinite(def.design) ? def.design : def.value)) < 1e-9) continue;
      const H = hingeMatrix(def, v);
      const doc = parts[pid];
      for (const mid of def.moves || []) {
        const mesh = (doc.meshes || []).find((m) => m.id === mid);
        const cid = mesh ? (mesh.component || `${pid}_${mid}`) : null;
        if (!cid || !model.component(cid)) continue;
        out.set(cid, out.has(cid) ? out.get(cid).clone().multiply(H) : H.clone());
      }
    }
  }
  if (carry) {
    for (const cid of carry.ids()) {
      const T = translation(carry.mesh(cid));
      if (T && model.component(cid)) out.set(cid, out.has(cid) ? out.get(cid).clone().multiply(T) : T);
    }
  }
  return out;
}

/** A camera block's 16-number `local` (part frame), carried, then turned with its hinge. */
export function hingedCameraLocal(model, design, partId, camId, local, carry) {
  if (!partId || !Array.isArray(local) || local.length !== 16) return local;
  let M = carry ? translation(carry.point(partId, [local[12], local[13], local[14]])) : null;
  for (const { key, def } of hingesOf(model, partId, carry)) {
    if (def.camera !== camId) continue;
    const H = hingeMatrix(def, hingeValue(design, partId, key, def));
    M = M ? H.multiply(M) : H;
  }
  if (!M) return local;
  return M.multiply(new Matrix4().fromArray(local)).toArray();
}

/** `adoptSlotOption` hook: the pose block a fitted option publishes, carry and hinge applied. */
export function cameraAdjuster(model, design, carry) {
  return (camId, pose, opt) => {
    const pid = partOfOption(model, opt);
    if (!pid || !Array.isArray(pose.local)) return pose;
    return { ...pose, local: hingedCameraLocal(model, design, pid, camId, pose.local, carry) };
  };
}

/** An option label with its baked-in angle ("· 45°") replaced by the live hinge value. */
export function liveLabel(model, design, opt, label) {
  const text = label == null ? (opt && opt.label) || '' : label;
  const pid = partOfOption(model, opt);
  const h = pid ? hingesOf(model, pid)[0] : null;
  if (!h || !/\d\s*°/.test(text)) return text;
  const v = hingeValue(design, pid, h.key, h.def);
  return text.replace(/(\d+(?:\.\d+)?)\s*°(?!.*\d\s*°)/, `${v}°`);
}

/** Short label for one detent change: "Tilt · Corner mast · 55°". */
export function hingeLabel(key, partLabel, value) {
  const name = key.replace(/_deg$/, '').replace(/_/g, ' ');
  return `${name[0].toUpperCase()}${name.slice(1)} · ${partLabel} · ${value}°`;
}
