/* The `ctx` of features/context-pack.js, built from the live design: the fitted parts of one
   slot with their ops applied (robot frame), the real hinge values, the camera poses and lenses,
   and the nearby parts at every preset, decimated.  Needs three, core/package.js (STL writer),
   features/hinge.js and features/printcheck.js. */

import * as THREE from 'three';
import { stlBytes } from '../core/package.js';
import { geometryStats } from './slot-anchors.js';
import { partOf, hingesOf, hingeValue, liveLabel } from './hinge.js';
import { printerProfile } from './printcheck.js';
import { DEFAULT_CONSTRAINTS } from './context-pack.js';

export const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21 };
const NEAR_MM = 120;            // a part whose box comes this close to the slot's is a neighbour
const NEIGHBOUR_TRIS = 40000;   // neighbours.stl budget
const FRAME = '+X right, +Y forward, +Z up';

const r3 = (v) => Math.round(v * 1000) / 1000;
const slug = (s) => String(s || 'part').replace(/^.*\//, '').replace(/\.stl$/i, '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 48);

/** The components the slot's fitted option draws, visible and with geometry. */
export function slotComponents(model, slots, design, slotId, shown) {
  const oid = slots.activeOption(design, slotId);
  let opt = null;
  try { opt = slots.option(slotId, oid); } catch (e) { opt = null; }
  const ids = (opt && opt.shows) || [];
  return ids.filter((id) => {
    const c = model.component(id);
    return c && c.geometry && (!shown || shown(id));
  });
}

function robotOf(model, manifestOf) {
  let m = model.manifest || {}, src = m.source || {};
  for (let i = 0; i < 4 && !src.repo && m.base && manifestOf; i++) {
    try { m = manifestOf(m.base) || {}; } catch (e) { m = {}; }
    src = m.source || {};
  }
  return {
    id: model.id, name: model.name || model.id, units: 'mm', frame: FRAME, groundZ: model.groundZ || 0,
    source: src.repo ? { repo: src.repo, commit: src.commit || null } : undefined,
  };
}

function boxOf(c, M) {
  if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
  return c.geometry.boundingBox.clone().applyMatrix4(M);
}

/** Every triangle of `items` ([{geometry, matrix}]) into one binary STL, every k-th kept. */
export function decimatedStl(items, budget = NEIGHBOUR_TRIS) {
  const count = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  const total = items.reduce((n, it) => n + count(it.geometry), 0);
  const step = Math.max(1, Math.ceil(total / budget));
  const kept = items.reduce((n, it) => n + Math.ceil(count(it.geometry) / step), 0);
  const buf = new ArrayBuffer(84 + kept * 50);
  const dv = new DataView(buf);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let o = 84, n = 0;
  for (const { geometry: g, matrix } of items) {
    const pos = g.attributes.position, idx = g.index;
    for (let t = 0; t < count(g); t += step) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, idx ? idx.getX(t * 3 + k) : t * 3 + k).applyMatrix4(matrix);
      o += 12;                                           // normal left zero: readers recompute it
      for (const p of v) { dv.setFloat32(o, p.x, true); dv.setFloat32(o + 4, p.y, true); dv.setFloat32(o + 8, p.z, true); o += 12; }
      o += 2;
      n++;
    }
  }
  dv.setUint32(80, n, true);
  return { bytes: new Uint8Array(buf, 0, 84 + n * 50), triangles: n, of: total };
}

/**
 * Nearby parts at the current pose and at every preset: a part on a moving link shows up once
 * per pose it reaches the slot in (the arm sweep), a fixed one once.
 */
export function neighbours(model, ids, shown, presets) {
  const own = new Set(ids);
  const robotM = (id) => (model._worldMatrix ? model._worldMatrix(id) : model.worldMatrix(id));
  const zone = new THREE.Box3();
  for (const id of ids) zone.union(boxOf(model.component(id), robotM(id)));
  if (zone.isEmpty()) return null;
  zone.expandByScalar(NEAR_MM);
  const saved = model.getJoints();
  const items = [], seen = new Set();
  const poses = [null, ...(presets || []).map((p) => p.q)];
  try {
    for (const q of poses) {
      if (q) model.setJoints({ ...saved, ...q });
      for (const c of model.components) {
        if (own.has(c.id) || !c.geometry || (shown && !shown(c.id))) continue;
        const M = robotM(c.id);
        const key = c.id + ':' + M.elements.map((x) => x.toFixed(1)).join(',');
        if (seen.has(key) || !boxOf(c, M).intersectsBox(zone)) continue;
        seen.add(key);
        items.push({ geometry: c.geometry, matrix: M.clone(), id: c.id });
      }
    }
  } finally { model.setJoints(saved); }
  if (!items.length) return null;
  const d = decimatedStl(items);
  const names = new Set(items.map((i) => i.id)).size;
  return {
    stlBytes: d.bytes,
    note: `${names} nearby parts at ${poses.length} poses, ${d.triangles} of ${d.of} triangles, robot frame`,
  };
}

/**
 * @param {object} o
 * @param {object} o.model  @param {object} o.slots  @param {object} o.design  @param {string} o.slotId
 * @param {(id:string)=>boolean} [o.shown]  drawn and fitted
 * @param {object} [o.cams]   createCameras() instance
 * @param {string} [o.printer] @param {Array} [o.presets] @param {object} [o.constraints]
 * @param {(id:string)=>Uint8Array|null} [o.plateOf]  the edited print plate of a component
 * @param {(id:string)=>object} [o.manifestOf]        a robot id -> its manifest (source lookup)
 * @param {object} [o.carry]  features/carry.js: a shortened part's hinge origin moves with it
 * @param {string} [o.folderName] @param {string} [o.date]
 */
export function buildAgentContext(o) {
  const { model, slots, design, slotId } = o;
  const slot = slots.slots[slotId];
  const ids = slotComponents(model, slots, design, slotId, o.shown);
  const unbase = model.baseMatrix().invert();
  const pid = ids.map((id) => partOf(model, id)).find(Boolean);
  const doc = pid ? pid.doc : null;
  const oid = slots.activeOption(design, slotId);
  let opt = null;
  try { opt = slots.option(slotId, oid); } catch (e) { opt = null; }
  const constraints = { ...DEFAULT_CONSTRAINTS, ...(o.constraints || {}) };
  const density = DENSITY[String(constraints.material).toUpperCase()] || DENSITY.PLA;

  const parts = ids.map((cid) => {
    const c = model.component(cid);
    const M = model._worldMatrix ? model._worldMatrix(cid) : unbase.clone().multiply(model.worldMatrix(cid));
    const g = c.geometry.clone().applyMatrix4(M);
    g.computeBoundingBox();
    const b = g.boundingBox;
    const md = doc ? (doc.meshes || []).find((m) => (m.component || `${pid.id}_${m.id}`) === cid) : null;
    const vol = geometryStats(c.geometry).volume_cm3;
    const hardware = md ? !!md.hardware : !c.printable;
    const printRef = md && md.print && String(md.print).startsWith('part:') ? md.print : null;
    const plate = !hardware && !printRef && o.plateOf ? o.plateOf(cid) : null;
    const out = {
      id: md ? md.id : slug(cid), name: c.label || cid,
      bbox: { min: b.min.toArray().map(r3), max: b.max.toArray().map(r3) }, volume: vol,
      mass: hardware ? undefined : Math.round(vol * density * 10) / 10,
      hardware, printRef, note: (md && md.note) || c.note || '', stlBytes: stlBytes(g),
      printStlBytes: plate || undefined,
    };
    g.dispose();
    return out;
  });

  const params = {};
  if (pid) for (const { key, def } of hingesOf(model, pid.id, o.carry)) params[key] = { ...def, value: hingeValue(design, pid.id, key, def) };

  const cameras = [];
  for (const cid of slot.provides.filter((p) => p.startsWith('cameras.')).map((p) => p.slice(8))) {
    const pose = o.cams ? o.cams.getPose(cid, {}) : null;
    if (!pose || !pose.ok) continue;
    const L = unbase.clone().multiply(pose.matrixRobot || pose.matrix);
    cameras.push({ id: cid, hfov: pose.hfov_deg, vfov: pose.vfov_deg, aspect: pose.aspect, local: L.toArray().map((x) => Math.round(x * 1e6) / 1e6) });
  }

  let anchor = { name: slot.anchor || 'robot', matrix: null };
  try {
    const a = slots.anchorOf(slotId);
    if (a && a.matrix) anchor = { name: a.name || slot.anchor, matrix: unbase.clone().multiply(a.matrix).toArray().map((x) => Math.round(x * 1e4) / 1e4) };
  } catch (e) { /* the robot origin */ }

  const prof = printerProfile(o.printer);
  const presets = o.presets || [];
  const keepOuts = presets.length ? [`the arm sweep at ${presets.map((p) => p.label || p.name).join(', ')}`] : [];
  return {
    robot: robotOf(model, o.manifestOf),
    slot: {
      id: slotId, label: slot.label, frame: (doc && doc.frame) || 'robot', anchor,
      interface: slot.interface ? Object.fromEntries(Object.entries(slot.interface).filter(([, v]) => v != null)) : {},
      mount: doc && doc.mount ? doc.mount : undefined, params, keepOuts,
      current: { id: pid ? pid.id : (opt ? String(opt.altId || opt.id) : null), label: opt ? liveLabel(model, design, opt, opt.label) : null, partJson: doc || undefined },
    },
    parts,
    neighbours: neighbours(model, ids, o.shown, presets) || undefined,
    cameras,
    printer: { name: prof.name, bed: prof.size.slice() },
    checks: { presets: presets.map((p) => p.label || p.name) },
    constraints,
    folderName: o.folderName || undefined,
    date: o.date || undefined,
  };
}
