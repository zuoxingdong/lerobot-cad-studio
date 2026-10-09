/* Where a slot's geometry is fitted (its anchor frame, resolved against the model) and the
   two geometry readouts the swap popover and the import path quote.
   Needs three (Matrix4) and features/slot-state.js. */

import { Matrix4 } from 'three';
import { need } from './slot-state.js';

/**
 * Where a slot's geometry is fitted, resolved against the model.
 * @returns {{name, matrix:Matrix4|null, parent:string, data:object|null, source:string}}
 */
export function anchorOf(slotId, inst) {
  const I = need(inst);
  const slot = I.slots[slotId];
  const name = slot ? slot.anchor : null;
  const model = I.model;
  const out = { name, matrix: null, parent: 'world', data: null, source: 'identity', offset: null };
  if (!name) return out;
  const off = (I.anchorOffsets && I.anchorOffsets[slotId]) || null;
  const withOffset = (m) => {
    if (!m || !off) return m;
    out.offset = off.slice();
    return m.multiply(new Matrix4().makeTranslation(off[0], off[1], off[2]));
  };

  const tryFrame = (n) => { try { return model.frameMatrix(n); } catch (e) { return null; } };
  let m = tryFrame(name);
  let used = name, viaAttachment = null;
  if (!m) {
    for (const att of I.attachmentIds) {
      const q = att + '/' + name;
      const r = tryFrame(q);
      if (r) { m = r; used = q; viaAttachment = att; break; }
    }
  }
  if (m) {
    out.matrix = withOffset(m); out.source = `frames.${used}`;
    out.attachment = viaAttachment;
    try { out.data = model.frameData(used) || null; } catch (e) { /* not data */ }
    const spec = (model.manifest.frames || {})[name] || (out.data || {});
    if (spec && spec.link) out.parent = spec.link;
    /* a frame inside an attached package rides whatever link the attachment
       is mounted on, so an import placed there follows the arm */
    if (viaAttachment && out.parent === 'world') {
      const att = (model.attachments || []).find((a) => a.id === viaAttachment);
      const mount = att && (model.manifest.frames || {})[att.frame];
      if (mount && mount.link) out.parent = mount.link;
    }
    return out;
  }
  if (model.hasLink && model.hasLink(name)) { out.matrix = withOffset(model.fk(name)); out.parent = name; out.source = `fk(${name})`; return out; }
  const comp = model.component(name);
  if (comp) { out.matrix = withOffset(model.worldMatrix(name)); out.parent = comp.link || 'world'; out.source = `component ${name}`; return out; }
  try { out.data = model.frameData(name) || null; } catch (e) { /* nothing */ }
  return out;
}

export function geometryBBox(geometry) {
  if (!geometry) return null;
  if (geometry.boundingBox && geometry.boundingBox.min) {
    const b = geometry.boundingBox;
    return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
  }
  const a = geometry.attributes && geometry.attributes.position;
  const p = a ? a.array : (geometry.positions || (Array.isArray(geometry) ? geometry : null));
  if (!p || p.length < 3) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = p[i + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

export function geometryStats(geometry) {
  const a = geometry && geometry.attributes && geometry.attributes.position;
  const p = a ? a.array : (geometry && geometry.positions) || null;
  if (!p) return { faces: 0, volume_cm3: 0 };
  const idx = geometry.index ? (geometry.index.array || geometry.index) : null;
  const n = idx ? idx.length : p.length / 3;
  let vol = 0;
  for (let i = 0; i + 2 < n; i += 3) {
    const a0 = (idx ? idx[i] : i) * 3, b0 = (idx ? idx[i + 1] : i + 1) * 3, c0 = (idx ? idx[i + 2] : i + 2) * 3;
    vol += (p[a0] * (p[b0 + 1] * p[c0 + 2] - p[b0 + 2] * p[c0 + 1])
          - p[a0 + 1] * (p[b0] * p[c0 + 2] - p[b0 + 2] * p[c0])
          + p[a0 + 2] * (p[b0] * p[c0 + 1] - p[b0 + 1] * p[c0])) / 6;
  }
  return { faces: Math.floor(n / 3), volume_cm3: +(Math.abs(vol) / 1000).toFixed(3) };
}

/* Unicode letters and digits SURVIVE: stripping every non-ASCII character turned
   `\uc190\ubaa9.stl` / `Halterung_\u00e4\u00f6\u00fc.stl` into '' -> the bare fallback, so several
   imported files collapsed onto `part`, `part-2`, … and only `label` told them apart. */
export const slug = (s, fallback) => {
  const v = String(s == null ? '' : s).trim().normalize('NFKD').toLowerCase()
    .replace(/\.(stl|obj|step|stp|3mf|ply)$/i, '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  return v || fallback;
};
