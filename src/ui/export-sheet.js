/* The Export sheet: printer, changed parts or all, one verdict per part, then the STL zip, the
   design file and the MJCF zip.  Only a fail holds a part back, and "Export anyway" (per
   failing row) lives here and nowhere else.  Opened from the top bar, Ctrl E and the inspector. */

import { openSession } from './sim-run.js';
import { openDialog } from './dialogs.js';
import { icon } from './icons.js';
import { el } from './dom.js';
import { PRINTERS, printerProfile } from '../features/printcheck.js';
import { partFamilies, DOT } from '../features/verdict.js';
import { isRemoved } from '../features/slot-options.js';
import { opsOf } from '../core/part-edits.js';
import { zipFiles } from '../core/package.js';
import { isModified, paramDefs } from '../features/parts.js';

/** @param {object} page the shared design-page state */
export function openExportSheet(page) {
  const { store, model, slots, ctx } = page;
  const d = openDialog({ title: 'Export', width: 'export' });
  const anyway = new Set();
  let scope = null;

  const top = el('div', 'exhead');
  const printer = document.createElement('select');
  printer.className = 'text-in';
  printer.setAttribute('aria-label', 'Printer');
  for (const p of PRINTERS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; printer.appendChild(o); }
  printer.onchange = () => { ctx.on.setPrinter(printer.value); paint(); };
  const ready = el('span', 'exready');
  top.append(el('span', 'k', 'Printer'), printer, el('div', 'sp'), ready);
  const scopeRow = el('div', 'exscope');
  const radios = {};
  for (const [id, label] of [['changed', 'Changed parts'], ['all', 'All printed parts']]) {
    const l = el('label', 'radio-l');
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'exscope';
    r.value = id;
    r.onchange = () => { scope = id; paint(); };
    const n = el('span', null, label);
    l.append(r, n);
    radios[id] = { r, n, label };
    scopeRow.appendChild(l);
  }
  const list = el('div', 'exlist');
  d.body.append(top, scopeRow, list);

  const zipBtn = el('button', 'btn accent');
  zipBtn.type = 'button';
  zipBtn.dataset.role = 'stl-zip';
  zipBtn.append(icon('download', 'i14'), document.createTextNode('Download STL zip'));
  const json = el('button', 'btn');
  json.type = 'button';
  json.dataset.role = 'design-json';
  json.append(icon('download', 'i14'), document.createTextNode('Design file (.json)'));
  json.onclick = () => page.doExport('design');
  const mjcf = el('button', 'btn');
  mjcf.type = 'button';
  mjcf.dataset.role = 'mjcf-zip';
  mjcf.append(icon('download', 'i14'), document.createTextNode('MJCF (.zip)'));
  mjcf.disabled = !page.simAvailable();
  mjcf.title = mjcf.disabled ? 'this robot has nothing to simulate' : 'the MuJoCo model of this design';
  mjcf.onclick = () => downloadMjcf(page, mjcf);
  d.footer.append(json, mjcf, el('div', 'sp'), zipBtn);

  /** a printable on the robot the user changed: another option, an edit, an import */
  function changed(st, c) {
    if (c.group === 'imported' || c.imported || c.edited || opsOf(st, c.id).length) return true;
    if (paramDefs(c.id).length && isModified(st, c.id)) return true;
    const sid = ctx.slotOf(c.id);
    return !!(sid && slots.slots[sid] && slots.activeOption(st, sid) !== slots.slots[sid].default);
  }

  function rows() {
    const st = store.getState();
    const report = page.designReport();
    const unfit = ctx.unfitted();
    const out = [];
    for (const r of report.components) {
      const c = model.component(r.component);
      if (!c || unfit.has(c.id) || isRemoved(st, c.id)) continue;
      const fam = partFamilies(r).print || { level: 'unknown', reason: '' };
      out.push({ id: c.id, label: r.label, level: r.fullVerdict === 'fail' ? 'fail' : fam.level, reason: fam.reason, why: fam.why, changed: changed(st, c) });
    }
    return out;
  }

  function paint() {
    printer.value = printerProfile(ctx.printer()).id;
    const all = rows();
    const nChanged = all.filter((r) => r.changed).length;
    if (!scope) scope = nChanged ? 'changed' : 'all';
    radios.changed.r.checked = scope === 'changed';
    radios.all.r.checked = scope === 'all';
    radios.changed.r.disabled = !nChanged;
    radios.changed.n.textContent = `${radios.changed.label} (${nChanged})`;
    radios.all.n.textContent = `${radios.all.label} (${all.length})`;
    const shown = scope === 'changed' ? all.filter((r) => r.changed) : all;
    list.innerHTML = '';
    for (const r of shown) {
      const row = el('div', 'exrow');
      row.dataset.id = r.id;
      row.dataset.level = r.level;
      const dot = el('span', 'dot ' + DOT[r.level]);
      const n = el('span', 'n', r.label);
      n.title = r.label;
      const why = el('span', 'why', r.level === 'pass' ? '' : r.reason);
      why.title = r.why || '';
      row.append(dot, n, why);
      if (r.level === 'fail') {
        const l = el('label', 'chk');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = anyway.has(r.id);
        cb.onchange = () => { if (cb.checked) anyway.add(r.id); else anyway.delete(r.id); paintButton(shown); };
        const box = document.createElement('i');
        box.appendChild(icon('check', 'i12'));
        l.append(cb, box, document.createTextNode('Export anyway'));
        row.appendChild(l);
      }
      list.appendChild(row);
    }
    if (!shown.length) list.appendChild(el('div', 'note', 'No printed parts'));
    const fail = shown.filter((r) => r.level === 'fail').length;
    ready.textContent = fail ? `${fail} fail` : `${shown.length} ${shown.length === 1 ? 'part' : 'parts'} ready`;
    ready.dataset.level = fail ? 'fail' : 'pass';
    paintButton(shown);
  }
  function paintButton(shown) {
    const ids = shown.filter((r) => r.level !== 'fail' || anyway.has(r.id)).map((r) => r.id);
    zipBtn.disabled = !ids.length;
    zipBtn.title = `${ids.length} of ${shown.length} ${shown.length === 1 ? 'part' : 'parts'}`;
    zipBtn.onclick = () => {
      page.doExport('printables', { ids, extras: true, force: true });
      d.close();
    };
  }

  paint();
  zipBtn.focus();
  return { dialog: d, paint, rows, get scope() { return scope; } };
}

/** the export-layout zip (scene.xml, meshes/, design.json) from a short-lived session */
async function downloadMjcf(page, btn) {
  const { model, meshes, ctx, store } = page;
  btn.disabled = true;
  const was = [...btn.childNodes];
  btn.textContent = 'Building…';
  let s = null;
  try {
    const edited = new Map();
    for (const [id, mesh] of meshes) { const c = model.component(id); if (c && mesh.geometry && mesh.geometry !== c.geometry) edited.set(id, mesh.geometry); }
    s = await openSession({ model, slots: ctx.slots, design: store.getState(), edited });
    page.download(`${model.id}-mjcf.zip`, zipFiles(s.files()), 'application/zip');
    page.setStatus('MJCF exported');
  } catch (e) {
    page.setStatus('MJCF export failed · ' + ((e && e.message) || e), 'err');
  } finally {
    if (s) s.free();
    page.applyPose();
    btn.replaceChildren(...was);
    btn.disabled = false;
  }
}
