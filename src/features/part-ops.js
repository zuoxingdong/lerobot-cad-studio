/* Per-part op stacks on a live model: `design.parts[<key>] = {ops?, params?, copy_of?}`.
   The key is a component id (the first instance of a mirrored pair, which shares one
   geometry) or a part-folder id for hinge params.  Builds are cached by the op-stack hash.
   Also the v6 `design.tweaks` migration.  Needs three, ops.js, mount-frame.js. */

import { applyOps, opLabel } from './ops.js';
import { mountOf, mountFrame } from './mount-frame.js';
import { opsHash } from '../core/part-edits.js';

export { opsOf, opsHash, editedCount } from '../core/part-edits.js';

const CACHE_MAX = 32;

/** why applyOps refused an op, in a few words */
export const REFUSED = {
  crosses: 'the cut crosses a hole or a chamfer', mount: 'too close to the mount face',
  outside: 'the plane misses the part', no_face: 'no flat face there', invalid: 'not a valid edit',
};

/**
 * v6 `design.tweaks` -> op stacks.  length_mm -> stretch at the v6 plane, width/height scale ->
 * one per-axis scale about the mount origin, pad_mm -> offset_face on the contact face.
 * `frameOf(key)` answers the v6 mount frame (mount-frame.js `mountFrame`).
 * @returns {{parts:object, moved:string[], dropped:string[]}}
 */
export function migrateTweaks(tweaks, frameOf) {
  const parts = {}, moved = [], dropped = [];
  for (const [key, t] of Object.entries(tweaks || {})) {
    const f = t && frameOf(key);
    if (!f) { dropped.push(key); continue; }
    const e = (i, s) => { const v = [0, 0, 0]; v[i] = s; return v; };
    const ops = [];
    const len = +t.length_mm || 0;
    if (len) {
      const axis = e(f.ai, f.as);
      ops.push({ op: 'stretch', axis, at: f.origin[f.ai] * f.as + f.plane, by: len });
    }
    const w = t.width_scale == null ? 1 : +t.width_scale, h = t.height_scale == null ? 1 : +t.height_scale;
    if ((Math.abs(w - 1) > 1e-9 || Math.abs(h - 1) > 1e-9) && w > 0 && h > 0) {
      const factors = [1, 1, 1];
      factors[f.wi] = w; factors[f.ci] = h;
      ops.push({ op: 'scale', factors, about: f.origin.slice() });
    }
    const pad = +t.pad_mm || 0;
    if (pad) {
      const point = f.origin.slice();
      point[f.ci] = f.origin[f.ci] + f.cs * f.contact * h;
      ops.push({ op: 'offset_face', seed: { point, normal: e(f.ci, f.cs) }, by: pad });
    }
    if (ops.length) { parts[key] = { ops }; moved.push(key); }
  }
  return { parts, moved, dropped };
}

/**
 * Where a copy of `src` sits on the top model: its parent link, qualified through the
 * attachment when `src` comes from an attached package, so the copy rides the same link.
 * @returns {{link, frame, local}}  `local` is `src`'s local (or `local`) in that link's frame
 */
export function copyFrame(model, src, local) {
  const L = (local || src.local).clone();
  if (!src.owner || src.owner === model) return { link: src.link || null, frame: src.frame, local: L };
  const prefix = src.id.slice(0, src.id.length - String(src.localId).length - 1);
  if (src.link && (src.frame === 'link' || src.frame === 'mesh')) return { link: `${prefix}/${src.link}`, frame: src.frame, local: L };
  const root = src.owner.rootLink;
  return { link: `${prefix}/${root}`, frame: 'link', local: src.owner._fk(root).invert().multiply(L) };
}

/** "Removable Tip (mirror copy)", then "(mirror copy 2)" … unique on the model. */
export function copyLabel(model, src, key) {
  const stem = `${src.label || src.id} (mirror copy`;
  const taken = new Set(model.components.filter((c) => c.id !== key).map((c) => c.label));
  for (let n = 1; ; n++) { const l = n === 1 ? `${stem})` : `${stem} ${n})`; if (!taken.has(l)) return l; }
}

/**
 * The op-stack builder for one model.
 * @param {{model, slots?}} o
 */
export function createPartOps(o) {
  const model = o.model;
  const slots = o.slots || null;
  const pristine = new Map();      // group key -> the untouched geometry
  const mounts = new Map();        // group key -> ops mount | null
  const cache = new Map();         // key|hash -> build result
  const plain = new Map();         // group key -> the mesh drawn with no ops, when not the base (rebase)

  /** The mirrored pair (components sharing one geometry); `key` is where the design stores it. */
  function group(componentId) {
    const c = model.component(componentId);
    if (!c || !c.geometry) return { key: null, ids: [], mirrored: false };
    const base = (c.geometry.userData && c.geometry.userData.opsBase) || c.geometry;
    const ids = model.components.filter((x) => x.geometry
      && ((x.geometry.userData && x.geometry.userData.opsBase) || x.geometry) === base).map((x) => x.id);
    if (!ids.length) ids.push(c.id);
    return { key: ids[0], ids, mirrored: ids.length > 1 };
  }
  const designKey = (id) => group(id).key;

  function original(componentId) {
    const g = group(componentId);
    if (!g.key) return null;
    if (!pristine.has(g.key)) {
      const c = model.component(g.key);
      const u = c && c.geometry && c.geometry.userData;
      pristine.set(g.key, (u && u.opsBase) || (c && c.geometry) || null);
    }
    return pristine.get(g.key);
  }

  function mount(componentId) {
    const g = group(componentId);
    if (!g.key) return null;
    if (!mounts.has(g.key)) mounts.set(g.key, mountOf(model, g.key, { slots, geometry: original(g.key) }));
    return mounts.get(g.key);
  }

  /** v6 frame for the migration */
  const frameOf = (key) => mountFrame(model, key, { slots, geometry: original(key) });

  /**
   * Geometry for `ops` on `componentId` (pristine when empty).
   * @returns {{ok, geometry, warnings, refused, cached, hash, group}}
   */
  function build(componentId, ops) {
    const g = group(componentId);
    const base = original(componentId);
    if (!g.key || !base) return { ok: false, geometry: null, warnings: [], refused: null, group: g };
    const list = (ops || []).filter((x) => x && x.op !== 'move');
    const hash = opsHash(list);
    if (!list.length) return { ok: true, geometry: plain.get(g.key) || base, warnings: [], refused: null, cached: true, hash, group: g };
    const ck = g.key + '|' + hash;
    if (cache.has(ck)) return { ...cache.get(ck), cached: true, group: g };
    const r = applyOps(base, list, { mount: mount(g.key) });
    const geometry = r.geometry;
    if (geometry !== base) {
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    const out = { ok: true, geometry, warnings: r.warnings, refused: r.refused || null, hash };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(ck, out);
    return { ...out, cached: false, group: g };
  }

  /**
   * v6 `design.tweaks` -> gated op stacks: a stretch the gate refuses snaps to the nearest clean
   * plane; an op that still cannot apply is dropped and named (`key.knob`).
   */
  function migrate(tweaks) {
    const r = migrateTweaks(tweaks, frameOf);
    const KNOB = { stretch: 'length_mm', scale: 'width/height_scale', offset_face: 'pad_mm' };
    const parts = {}, dropped = r.dropped.slice();
    for (const [key, e] of Object.entries(r.parts)) {
      const base = original(key), mt = mount(key), kept = [];
      for (const op of e.ops) {
        let res = applyOps(base, [...kept, op], { mount: mt });
        if (res.refused && op.op === 'stretch' && res.refused.nearest) {
          op.at = res.refused.nearest.at;
          res = applyOps(base, [...kept, op], { mount: mt });
        }
        if (res.refused) dropped.push(`${key}.${KNOB[op.op]}`);
        else kept.push(op);
      }
      if (kept.length) parts[key] = { ops: kept };
    }
    return { parts, moved: Object.keys(parts), dropped };
  }

  /** Can this component take ops at all? */
  function editable(componentId) {
    const c = model.component(componentId);
    return !!(c && c.geometry && c.geometry.attributes && c.geometry.attributes.position);
  }

  /** a swap or an import replaced the mesh */
  function forget(componentId) {
    const g = group(componentId);
    if (!g.key) return;
    pristine.delete(g.key); plain.delete(g.key); mounts.delete(g.key);
    for (const k of [...cache.keys()]) if (k.startsWith(g.key + '|')) cache.delete(k);
  }

  /** A parametric knob build: `ops` run on `base`, and no ops draw `shown` (default `base`). */
  function rebase(componentId, base, ops, shown) {
    forget(componentId);
    const g = group(componentId);
    if (!g.key || !base) return { ok: false, geometry: null, warnings: [], refused: null, group: g };
    pristine.set(g.key, base);
    if (shown && shown !== base) plain.set(g.key, shown);
    return build(componentId, ops);
  }

  return {
    model, group, designKey, original, mount, frameOf, build, editable, migrate, forget, rebase,
    label: (op, name) => opLabel(op, name),
    stats: () => ({ pristine: pristine.size, cached: cache.size }),
  };
}
