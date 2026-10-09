/* A detected part folder (linked, chosen or dropped) → validated, print-checked on its plates,
   and shaped as a card, a swap-list entry and the record `slots.registerAlternatives()` takes.
   A folder with only a `meta.json` is an older export: an `rps/alternative@1` one is upgraded,
   anything else is refused with "rename it part.json".
   Needs three, features/part-folder.js and features/printcheck.js. */

import { validatePartFolder, toSwapOption, PART_SCHEMA } from './part-folder.js';
import { printCheck, printerProfile } from './printcheck.js';
import { ALTERNATIVE_SCHEMA } from './slot-state.js';

const RANK = { unknown: 0, pass: 1, warn: 2, fail: 3 };
const worse = (a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a);

/** A folder that looks like a part (part.json or meta.json at its root). */
export const isPartFolder = (f) => !!(f && f.files && (f.files.has('part.json') || f.files.has('meta.json')));

/** What validatePartFolder() needs to know about the open robot. */
export function robotSummary(model, slots) {
  const unbase = model.baseMatrix().invert();
  const out = { id: model.id, slots: {}, partIds: Object.keys((model.manifest && model.manifest.parts) || {}) };
  for (const sid of slots.order) {
    const s = slots.slots[sid];
    let anchor = [0, 0, 0];
    try {
      const a = slots.anchorOf(sid);
      if (a && a.matrix) anchor = unbase.clone().multiply(a.matrix).toArray();
    } catch (e) { /* no anchor frame */ }
    out.slots[sid] = { label: s.label, anchor, provides: s.provides.slice() };
  }
  return out;
}

const stem = (p) => String(p).split('/').pop().replace(/\.stl$/i, '').replace(/[-_ ]?print$/i, '').toLowerCase();

/** rps/alternative@1 (root meshes + print/ plates) as rps/part@1. */
export function upgradeMeta(meta, folder) {
  const keys = [...folder.files.keys()];
  const plates = keys.filter((k) => /^print\/[^/]+\.stl$/i.test(k));
  const flat = new Set((meta.print_files || []).map((p) => String(p).split('/').pop().toLowerCase()));
  const printed = meta.printable !== false;
  const meshes = keys.filter((k) => /^[^/]+\.stl$/i.test(k) && !flat.has(k.toLowerCase())).map((k) => {
    const id = k.replace(/\.stl$/i, '');
    const plate = printed && plates.find((p) => stem(p) === stem(k));
    return plate ? { id, file: k, print: plate } : { id, file: k, hardware: true };
  });
  return {
    schema: PART_SCHEMA, id: meta.id || folder.id, label: meta.label || folder.id,
    robot: meta.robot || null, slot: meta.slot || null, frame: meta.frame || 'robot',
    local: Array.isArray(meta.local) ? meta.local : null, meshes, cameras: meta.cameras || {},
    params: {}, source: meta.source || 'imported', notes: meta.notes || meta.note || '',
    ...(printed ? {} : { printable: false }),
  };
}

/** part.json; an rps/alternative@1 meta.json upgraded to one; any other folder as it is. */
export async function withPartJson(folder) {
  const files = folder.files;
  if (files.has('part.json') || !files.has('meta.json')) return folder;
  let meta;
  try { meta = JSON.parse(await files.get('meta.json').text()); } catch (e) { meta = null; }
  if (!meta || meta.schema !== ALTERNATIVE_SCHEMA) return folder;
  const next = new Map(files);
  next.delete('meta.json');
  next.set('part.json', new Blob([JSON.stringify(upgradeMeta(meta, folder))]));
  return { ...folder, files: next, fromMeta: true };
}

/** Worst print check over the plates, as the file would be exported. */
export function printVerdict(part, printer) {
  const prof = printerProfile(printer);
  let verdict = 'unknown', reason = '';
  for (const m of part.meshes || []) {
    if (!m.printGeometry) continue;
    const r = printCheck(m.printGeometry, null, prof, { ownMesh: true });
    if (worse(verdict, r.verdict) !== verdict) {
      verdict = r.verdict;
      const chip = r.chips.find((c) => c.level === r.verdict);
      reason = chip && r.verdict !== 'pass' ? `${m.id}: ${chip.detail}` : '';
    }
  }
  return { verdict, reason };
}

/** The alternative record the design page draws: robot-frame meshes + print/ plates, as bytes. */
export async function toAltRecord(res, o = {}) {
  const part = res.part;
  const files = [], prints = [];
  const bytes = async (rel) => new Uint8Array(await part.files.get(rel).arrayBuffer());
  for (const m of part.meshes) {
    if (!m.geometry) continue;
    const b = await bytes(m.file);
    files.push({ name: `${m.id}.stl`, bytes: b, size: b.length });
    if (m.printGeometry && m.print) {
      const p = await bytes(String(m.print).replace(/^\.\//, ''));
      prints.push({ name: `print/${m.id}_PRINT.stl`, bytes: p, size: p.length });
    }
  }
  return {
    id: part.id, slot: part.slot, label: part.label, frame: part.frame, local: part.local,
    printable: part.meshes.some((m) => !m.hardware), params: part.params || {}, cameras: part.cameras || null,
    source: part.source || 'agent', notes: part.notes || '', badge: 'from agent',
    path: part.folderId, files, print_files: prints, mtime: o.mtime || Date.now() / 1000,
  };
}

/**
 * One folder, start to end.
 * @param {{id:string, files:Map<string, Blob>}} folder
 * @param {object} robot  robotSummary()
 * @param {{taken?:Iterable<string>, printer?:string, mtime?:number}} [o]
 */
export async function checkFolder(folder, robot, o = {}) {
  const f = await withPartJson(folder);
  const res = await validatePartFolder(f, robot, { taken: o.taken });
  const option = toSwapOption(res, { isNew: true, mtime: o.mtime, id: folder.id });
  let verdict = option.verdict;
  let reason = res.ok ? (res.warnings[0] || '') : res.errors[0];
  if (res.ok) {
    const pc = printVerdict(res.part, o.printer);
    if (worse(verdict, pc.verdict) !== verdict) { verdict = pc.verdict; reason = pc.reason; }
  }
  return {
    id: option.raw.id, slot: res.part ? res.part.slot : null, label: option.label, verdict, reason,
    errors: res.errors, warnings: res.warnings, ok: res.ok, part: res.part, option,
    record: res.ok ? await toAltRecord(res, o) : null, fromMeta: !!f.fromMeta,
  };
}
