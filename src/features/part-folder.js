/* A part folder from the agent loop (`<id>/part.json + mesh/ + print/`) checked against the
   open robot, and the swap-list entry it becomes.  Errors are one line each, ready for the
   card.  `robot` = {id, slots: {<id>: {label, anchor, provides?}}, partIds?}; `anchor` is a
   column-major 4x4 (robot mm), an [x, y, z] origin or {origin}. */

import { parseMesh } from '../core/mesh-parse.js';
import { validatePart, PART_SCHEMA, FRAMES } from '../core/compose.js';

export { PART_SCHEMA, FRAMES };
export const MAX_FACES = 500000;
export const MAX_REACH_MM = 1500;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const is16 = (m) => Array.isArray(m) && m.length === 16 && m.every(isNum);
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\//, '');
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function anchorPoint(slot) {
  const a = slot && slot.anchor;
  if (is16(a)) return [a[12], a[13], a[14]];
  if (Array.isArray(a) && a.length === 3 && a.every(isNum)) return a.slice();
  if (a && Array.isArray(a.origin)) return a.origin.slice(0, 3);
  if (a && is16(a.matrix)) return [a.matrix[12], a.matrix[13], a.matrix[14]];
  return [0, 0, 0];
}

function slotCameras(slot) {
  const p = (slot && (slot.provides || slot.cameras)) || [];
  return p.map((s) => String(s).replace(/^cameras\./, '')).filter(Boolean);
}

function uniqueId(id, taken) {
  if (!taken.has(id)) return id;
  for (let i = 2; ; i++) if (!taken.has(`${id}-${i}`)) return `${id}-${i}`;
}

/** Binary STL triangle count from the header, or null for ASCII. */
function binaryFaces(u8) {
  if (u8.byteLength < 84) return null;
  const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(80, true);
  return 84 + n * 50 === u8.byteLength ? n : null;
}

function bboxOf(pos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function reachOf(bb, local, origin) {
  let far = 0;
  for (let c = 0; c < 8; c++) {
    let p = [c & 1 ? bb.max[0] : bb.min[0], c & 2 ? bb.max[1] : bb.min[1], c & 4 ? bb.max[2] : bb.min[2]];
    if (local) p = [0, 1, 2].map((r) => local[r] * p[0] + local[4 + r] * p[1] + local[8 + r] * p[2] + local[12 + r]);
    far = Math.max(far, Math.hypot(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]));
  }
  return far;
}

/** Look a path up; a case-only mismatch is named in the error. */
function findFile(files, rel) {
  const want = norm(rel);
  if (files.has(want)) return { blob: files.get(want), path: want };
  const low = want.toLowerCase();
  for (const k of files.keys()) if (k.toLowerCase() === low) return { blob: null, near: k, path: want };
  return { blob: null, path: want };
}

async function readStl(files, rel, errors) {
  const f = findFile(files, rel);
  if (!f.blob) {
    errors.push(f.near ? `${f.path} missing (found ${f.near}; names are case-sensitive)` : `${f.path} missing`);
    return null;
  }
  if (!/\.stl$/i.test(f.path)) { errors.push(`${f.path} is not an .stl file`); return null; }
  const u8 = new Uint8Array(await f.blob.arrayBuffer());
  const pre = binaryFaces(u8);
  if (pre != null && pre > MAX_FACES) {
    errors.push(`${f.path} has ${fmtInt(pre)} faces; the limit is ${fmtInt(MAX_FACES)}`);
    return null;
  }
  let g;
  try { g = parseMesh(u8, f.path); } catch (e) {
    errors.push(String(e.message || e).replace(/^package: /, '').replace(/"/g, ''));
    return null;
  }
  const pos = g.attributes.position.array;
  return { path: f.path, geometry: g, faces: pos.length / 9, bbox: bboxOf(pos) };
}

/**
 * The document rules are compose.js `validatePart(doc, {strict: true})`; this adds what needs
 * the robot and the files.
 * @param {{id:string, files:Map<string, Blob>}} folder
 * @param {object} robot
 * @param {{taken?: Iterable<string>}} [opts]  ids already in the swap list
 * @returns {Promise<{ok:boolean, part:object|null, errors:string[], warnings:string[]}>}
 */
export async function validatePartFolder(folder, robot, opts = {}) {
  const errors = [], warnings = [];
  const files = new Map([...(folder.files || new Map())].map(([k, v]) => [norm(k), v]));
  const done = (part) => ({ ok: errors.length === 0, part, errors, warnings });

  if (!files.has('part.json')) {
    errors.push(files.has('meta.json') ? 'meta.json found: rename it part.json and use schema rps/part@1'
      : 'part.json missing');
    return done(null);
  }
  let raw;
  try { raw = JSON.parse(await files.get('part.json').text()); } catch (e) {
    errors.push(`part.json is not valid JSON (${String(e.message || e).split('\n')[0]})`);
    return done(null);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push('part.json is not an object'); return done(null); }

  errors.push(...validatePart(raw, { strict: true }));
  let id = typeof raw.id === 'string' ? raw.id : '';
  const taken = new Set([...(opts.taken || []), ...((robot && robot.partIds) || [])]);
  if (id && ID_RE.test(id) && taken.has(id)) {
    const next = uniqueId(id, taken);
    warnings.push(`id "${id}" is taken; shown as "${next}"`);
    id = next;
  }

  const slots = (robot && robot.slots) || {};
  const slot = raw.slot ? slots[raw.slot] : null;
  if (!raw.slot) errors.push('slot missing');
  else if (!slot) errors.push(`slot "${raw.slot}" is not on ${robot && robot.id ? robot.id : 'this robot'} (${Object.keys(slots).join(', ') || 'no slots'})`);
  if (raw.robot && robot && robot.id && raw.robot !== robot.id) warnings.push(`made for ${raw.robot}; the open robot is ${robot.id}`);

  const frame = raw.frame == null ? 'robot' : raw.frame;
  if (raw.frame == null) warnings.push('frame missing; read as "robot"');
  const local = is16(raw.local) ? raw.local : null;

  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id;
  if (!raw.label) warnings.push('label missing; the id is shown');

  const list = Array.isArray(raw.meshes) ? raw.meshes : [];
  const origin = frame === 'robot' ? anchorPoint(slot) : [0, 0, 0];
  const partIds = new Set((robot && robot.partIds) || []);
  const meshes = [];
  let faces = 0, plates = 0, printable = 0;
  const ids = new Set();
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const mid = String(m.id || `mesh${i + 1}`);
    if (ids.has(mid) || !m.file) continue;
    ids.add(mid);
    const s = await readStl(files, m.file, errors);
    const out = { id: mid, label: m.label || mid, file: norm(m.file), print: m.print || null,
      color: m.color || null, hardware: !!m.hardware, note: m.note || '',
      geometry: s ? s.geometry : null, faces: s ? s.faces : 0, bbox: s ? s.bbox : null, printGeometry: null };
    if (s) {
      faces += s.faces;
      const far = reachOf(s.bbox, local, origin);
      if (far > MAX_REACH_MM) errors.push(`${s.path} reaches ${(far / 1000).toFixed(1)} m from the slot anchor; the limit is ${MAX_REACH_MM / 1000} m`);
      const size = Math.max(...[0, 1, 2].map((k) => s.bbox.max[k] - s.bbox.min[k]));
      if (size < 1) warnings.push(`${s.path} is ${size.toFixed(3)} mm across: metres instead of millimetres?`);
    }
    if (!out.hardware) printable++;
    if (!out.hardware && m.print) {
      const pr = String(m.print);
      if (pr.startsWith('part:')) {
        if (partIds.size && !partIds.has(pr.slice(5))) warnings.push(`${mid}: print plate ${pr} is not a known part`);
        plates++;
      } else {
        const p = await readStl(files, pr, errors);
        if (p) { out.printGeometry = p.geometry; plates++; }
      }
    } else if (!out.hardware) warnings.push(`${mid} has no print plate; it prints as modelled`);
    meshes.push(out);
  }
  if (faces > MAX_FACES) errors.push(`${fmtInt(faces)} faces in all; the limit is ${fmtInt(MAX_FACES)}`);
  if (raw.printable !== false && printable > 0 && plates === 0) errors.push('no print plates: add meshes[].print (print/<id>.stl) for the printed meshes');

  const cams = raw.cameras && typeof raw.cameras === 'object' ? raw.cameras : {};
  for (const cid of slotCameras(slot)) if (!(cid in cams)) warnings.push(`no pose for camera "${cid}"; it is hidden with this part`);

  let bbox = null;
  for (const m of meshes) {
    if (!m.bbox) continue;
    if (!bbox) bbox = { min: m.bbox.min.slice(), max: m.bbox.max.slice() };
    else for (let k = 0; k < 3; k++) { bbox.min[k] = Math.min(bbox.min[k], m.bbox.min[k]); bbox.max[k] = Math.max(bbox.max[k], m.bbox.max[k]); }
  }

  return done({
    schema: PART_SCHEMA, id, folderId: folder.id, label, robot: raw.robot || null, slot: raw.slot || null,
    frame, local, meshes, cameras: raw.cameras || null, mount: raw.mount || null, params: raw.params || {},
    source: raw.source || 'agent', notes: typeof raw.notes === 'string' ? raw.notes : '',
    derived_from: raw.derived_from || null, faces, bbox, files, raw,
  });
}

/**
 * The swap-list entry for a validated folder, in the `slotOptions()` shape plus a verdict.
 * `raw` is what `slots.registerAlternatives()` takes.
 */
export function toSwapOption(res, o = {}) {
  const part = res.part || {};
  const id = part.id || o.id || 'agent-part';
  const verdict = !res.ok ? 'fail' : res.warnings.length ? 'warn' : 'pass';
  const meshes = part.meshes || [];
  const size = part.bbox ? part.bbox.max.map((v, k) => Math.round(v - part.bbox.min[k])).join(' × ') + ' mm' : '';
  const summary = !res.ok ? res.errors[0]
    : [`${meshes.length} mesh${meshes.length === 1 ? '' : 'es'}`, size, `${fmtInt(part.faces || 0)} faces`].filter(Boolean).join(' · ');
  return {
    key: 'o:alt:' + id, kind: 'alternative', id: 'alt:' + id, label: part.label || id,
    source: `${part.source || 'agent'} · linked folder`, parts: [], summary,
    group: 'agent', active: false, isNew: !!o.isNew,
    verdict, errors: res.errors.slice(), warnings: res.warnings.slice(), disabled: !res.ok,
    raw: {
      id, slot: part.slot, label: part.label || id, source: part.source || 'agent',
      frame: part.frame || 'robot', local: part.local || null, printable: meshes.some((m) => !m.hardware),
      params: part.params || {}, cameras: part.cameras || null,
      files: meshes.map((m) => m.file), print_files: meshes.filter((m) => m.print && !String(m.print).startsWith('part:')).map((m) => m.print),
      meta: part.raw || null, path: part.folderId || null, mtime: o.mtime || null, notes: part.notes || '',
    },
  };
}
