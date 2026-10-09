/* Scrim + sheet: a focus-trapped role="dialog" aria-modal="true" where Esc closes, first
   focus lands on the primary action and focus is restored on close.  The import dialog, the
   keys overlay, package info, and the shell every other sheet uses.  Needs ui/dom.js. */

import * as pkg from '../core/package.js';
import { helpModel } from '../core/keymap.js';
import { icon } from './icons.js';
import { el } from './dom.js';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/* ONE SHEET AT A TIME, and the OPEN SHEET is the state.  A second dialog replaces the first
   (two `aria-modal` sheets are undescribable and unleavable), and a counter that only
   `close()` decremented survived a page unmount — `anyDialogOpen()` stayed true for ever and
   every later key press resolved in the `overlay` context. */
let liveDialog = null;
let titleSeq = 0;
export const anyDialogOpen = () => !!liveDialog;

/**
 * The shell every dialog uses.
 * @returns {{close:Function, sheet:HTMLElement, body:HTMLElement, footer:HTMLElement}}
 */
export function openDialog({ title, width = '', onClose, describedBy } = {}) {
  if (liveDialog) { try { liveDialog.close(); } catch (e) { /* already gone */ } liveDialog = null; }
  const prev = document.activeElement;
  const scrim = el('div', 'scrim');
  const sheet = el('div', 'sheet' + (width ? ' ' + width : ''));
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  if (describedBy) sheet.setAttribute('aria-describedby', describedBy);

  const head = el('div', 'dh');
  const h = el('div', 't', title || '');
  h.id = 'dlg-title-' + (++titleSeq);
  sheet.setAttribute('aria-labelledby', h.id);
  const x = el('button', 'btn icon ghost');
  x.appendChild(icon('close'));
  x.title = 'Close · Esc';
  x.setAttribute('aria-label', 'Close');
  head.append(h, el('div', 'sp'), x);

  const body = el('div', 'db');
  const footer = el('div', 'df');
  sheet.append(head, body, footer);
  scrim.appendChild(sheet);
  document.body.appendChild(scrim);

  function close() {
    if (!scrim.isConnected) return;
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
    if (liveDialog && liveDialog.close === close) liveDialog = null;
    if (onClose) onClose();
    if (prev && prev.focus) try { prev.focus(); } catch (e) { /* gone */ }
  }
  function onKey(e) {
    /* ONE LAYER PER PRESS.  The options popover listens on the same node in the same phase, so
       `stopPropagation` did not stop it and one Esc closed both; the sheet is the topmost
       layer, so it takes the press and nothing else sees it. */
    if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
    items[next].focus();
  }
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  x.onclick = close;
  const api = { close, scrim, sheet, head, body, footer, titleEl: h };
  liveDialog = api;
  return api;
}

/**
 * Close whatever sheet is open — what a page unmounting owes the next page.
 * The scrim is appended to `document.body`, not to `#app`, so emptying the app root left
 * it lying over Home with the whole keyboard still in the `overlay` context (D1).
 * @returns {boolean} whether anything was open
 */
export function closeAnyDialog() {
  const had = !!liveDialog;
  if (liveDialog) { try { liveDialog.close(); } catch (e) { /* already gone */ } }
  liveDialog = null;
  /* a sheet whose own close() was lost still has its scrim in the body */
  for (const s of [...document.querySelectorAll('body > .scrim')]) s.remove();
  return had;
}

/* import robot */

const FORMATS = [
  ['package .zip', 'full kinematics, slots, cameras'],
  ['URDF + meshes .zip', 'auto components, no slots'],
  ['part folder or .zip', 'part.json + mesh/ + print/, into its slot'],
  ['loose .stl / .3mf / .obj', 'assembly only, no kinematics']
];

/**
 * @param {{files?:File[], onImported:(res:object)=>void, title?:string,
 *          remember?:boolean}} opts  `remember:false` imports into the open robot
 */
export function openImportDialog(opts = {}) {
  const d = openDialog({ title: opts.title || 'Import robot' });
  const zone = el('div', 'dropzone');
  zone.append(icon('import'), el('div', null, 'Drop a file here, or click to choose'));
  zone.tabIndex = 0;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  /* `.json` so a part.json can be chosen with its STLs in one go */
  input.accept = '.zip,.urdf,.stl,.3mf,.obj,.ply,.dae,.json';
  input.style.display = 'none';
  const fmt = el('div');
  fmt.style.marginTop = 'var(--sp-5)';
  for (const [k, v] of FORMATS) {
    const r = el('div', 'fmt');
    r.append(el('span', 'k', k), el('span', 'd', v));
    fmt.appendChild(r);
  }
  const out = el('div');
  out.style.marginTop = 'var(--sp-5)';
  d.body.append(zone, input, fmt, out);

  const cancel = el('button', 'btn', 'Cancel');
  cancel.onclick = d.close;
  const open = el('button', 'btn accent', 'Open');
  open.disabled = true;
  /* §8: nothing is greyed out without a sentence saying why */
  open.title = 'choose or drop a file first';
  d.footer.append(el('div', 'sp'), cancel, open);

  let result = null;
  zone.onclick = () => input.click();
  zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  input.onchange = () => handle([...input.files]);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('drop');
    handle([...(e.dataTransfer.files || [])]);
  });
  d.sheet.addEventListener('dragover', (e) => e.preventDefault());
  d.sheet.addEventListener('drop', (e) => { e.preventDefault(); handle([...(e.dataTransfer.files || [])]); });

  async function handle(files) {
    if (!files || !files.length) return;
    out.innerHTML = '';
    out.appendChild(el('div', 'code dim', 'reading ' + files.map((f) => f.name).join(', ') + ' …'));
    try {
      const zip = files.find((f) => /\.zip$/i.test(f.name));
      /* `remember:false` — a component dropped into the OPEN robot is not a robot of its
         own, so it must not take one of the few kept import slots */
      const o = { remember: opts.remember !== false };
      result = zip ? await pkg.importZip(zip, o) : await pkg.importFiles(files, o);
      open.textContent = 'Open';
      renderSummary(result, files);
      open.disabled = false;
      open.title = 'open ' + files.map((f) => f.name).join(', ');
      open.focus();
    } catch (e) {
      result = null;
      open.disabled = true;
      open.title = 'the file could not be read — the parser message is below';
      out.innerHTML = '';
      const err = el('div', 'chip fail');
      err.append(icon('error', 'i14'), document.createTextNode('import failed'));
      out.append(err, el('div', 'detail', String(e && e.message || e)));
    }
  }

  function renderSummary(res, files) {
    out.innerHTML = '';
    if (res.kind === 'parts') { renderPartsSummary(res, files); return; }
    const m = res.model;
    const t = el('table', 'vtable');
    const row = (k, v) => {
      const tr = document.createElement('tr');
      tr.append(Object.assign(el('td', 'k'), { textContent: k }), Object.assign(el('td', 'v'), { textContent: v }));
      t.appendChild(tr);
    };
    row('name', m.name || m.id);
    row('kind', res.kind);
    row('components', String(m.components.length));
    row('printables', String(m.printables().length));
    row('joints', String(m.joints.filter((j) => j.moving).length));
    row('files', files.map((f) => f.name).join(', '));
    out.appendChild(t);
    const warns = [...(res.warnings || []), ...((res.report && res.report.warnings) || [])];
    for (const w of warns.slice(0, 8)) {
      const c = el('div', 'chip warn');
      c.append(icon('warn', 'i14'), document.createTextNode(String(w).slice(0, 120)));
      c.style.marginTop = 'var(--sp-3)';
      out.appendChild(c);
    }
  }

  /* a part folder is a design for one slot, not a robot: name the folders and their meshes */
  function renderPartsSummary(res, files) {
    const t = el('table', 'vtable');
    for (const f of res.folders) {
      const tr = document.createElement('tr');
      const stl = [...f.files.keys()].filter((k) => /\.stl$/i.test(k));
      tr.append(Object.assign(el('td', 'k'), { textContent: f.id }),
        Object.assign(el('td', 'v'), { textContent: `${stl.length} STL · ${stl.filter((k) => /^print\//i.test(k)).length} plates` }));
      t.appendChild(tr);
    }
    const tr = document.createElement('tr');
    tr.append(Object.assign(el('td', 'k'), { textContent: 'files' }), Object.assign(el('td', 'v'), { textContent: files.map((f) => f.name).join(', ') }));
    t.appendChild(tr);
    out.appendChild(t);
    open.textContent = 'Fit it';
  }

  open.onclick = () => { const r = result; d.close(); if (r && opts.onImported) opts.onImported(r); };
  if (opts.files && opts.files.length) handle(opts.files);
  else zone.focus();
  return d;
}

/**
 * One chip.  Accepts both shapes the app carries: the UI's `{text, num}` and a
 * `features/printcheck.js` chip `{key, level, name, detail, value, preview}` — the
 * feature chip's `name` is the word and `value` the number, so a print chip reads
 * `fits the bed 141 × 115 × 168 mm` and its `detail` becomes the tooltip.
 */
export function chipEl(ch) {
  const lvl = ch.level === 'neutral' ? '' : ' ' + ch.level;
  const c = el('span', 'chip' + lvl);
  if (ch.level === 'pass') c.appendChild(icon('check', 'i14'));
  else if (ch.level === 'warn') c.appendChild(icon('warn', 'i14'));
  else if (ch.level === 'fail') c.appendChild(icon('error', 'i14'));
  else if (ch.level === 'unknown') c.appendChild(icon('unknown', 'i14'));
  const view = ch.text != null ? ch : featureChip(ch);
  /* the label is its own element so CSS can ellipsise it: a chip never wraps and never
     clips mid-word — the sentence is in the tooltip */
  if (view.text) c.appendChild(el('span', 't', view.text));
  if (view.num) {
    const n = el('span', 'mono', view.num);
    if (view.text) n.style.marginLeft = '3px';
    c.appendChild(n);
  }
  const tip = ch.tooltip || ch.detail || view.detail;
  if (tip) c.title = tip;
  else if (view.text) c.title = view.text;
  if (ch.preview) c.style.opacity = '0.82';
  if (ch.live) c.setAttribute('role', 'status');
  return c;
}

/** a printcheck chip → the two halves a chip draws: a word and a mono number */
function featureChip(ch) {
  const name = (ch.name || ch.key || '').toLowerCase();
  const v = ch.value;
  if (ch.key === 'bed') {
    return { text: ch.level === 'fail' ? (ch.detail || 'too big for the bed') : 'fits bed',
      num: Array.isArray(v) ? v.map((n) => n.toFixed(0)).join(' × ') + ' mm' : null };
  }
  if (ch.key === 'overhang') return { text: 'overhangs', num: (v || 0) + ' %' };
  if (ch.key === 'clearance') return { text: ch.level === 'pass' ? 'no collisions' : 'hits a part', num: v ? String(v) : null };
  if (ch.key === 'closed') return { text: ch.level === 'pass' ? 'closed mesh' : `${v} open edges` };
  if (ch.key === 'bodies') return { text: ch.level === 'pass' ? 'single body' : `${v} bodies` };
  return { text: name, detail: ch.detail };
}

/* keys: the overlay is generated from core/keymap.js, at most 18 rows */

export function openHelpDialog(context) {
  const d = openDialog({ title: 'Keys', width: 'help' });
  const model = helpModel(context);
  for (const g of model.groups) {
    const sec = el('div', 'hgroup');
    sec.appendChild(el('h3', null, g.name));
    const grid = el('div', 'helpgrid');
    for (const r of g.rows) { grid.appendChild(el('kbd', null, r.keys)); grid.appendChild(el('div', r.inert ? 'inert' : '', r.label)); }
    sec.appendChild(grid);
    d.body.appendChild(sec);
  }
  const ok = el('button', 'btn accent', 'Close');
  ok.onclick = d.close;
  d.footer.append(el('div', 'sp'), ok);
  ok.focus();
  return d;
}

/* package info */

export function openPackageInfoDialog(model) {
  const d = openDialog({ title: model.name });
  const t = el('table', 'vtable');
  const row = (k, v) => {
    const tr = document.createElement('tr');
    tr.append(Object.assign(el('td', 'k'), { textContent: k }), Object.assign(el('td', 'v'), { textContent: v }));
    t.appendChild(tr);
  };
  row('id', model.id);
  row('version', model.version || '—');
  row('components', String(model.components.length));
  row('printable', String(model.printables().length));
  row('cameras', model.cameras.map((c) => c.id).join(', ') || '—');
  row('slots', Object.keys(model.slots || {}).join(', ') || '—');
  row('frame', `mm · +X right, +Y forward, +Z up · ground_z ${model.groundZ}`);
  d.body.appendChild(t);
  const srcs = el('div');
  srcs.style.marginTop = 'var(--sp-5)';
  const seen = new Set();
  const walk = (m) => {
    if (!m || seen.has(m.id)) return;
    seen.add(m.id);
    if (m.source && m.source.repo) {
      const r = el('div', 'fmt');
      r.append(el('span', 'k', String(m.source.repo).replace(/^https?:\/\/github\.com\//, '')),
        el('span', 'd', `${(m.source.commit || '').slice(0, 7)} · ${m.source.license || 'licence not stated'}`));
      srcs.appendChild(r);
    }
    for (const a of m.attachments || []) walk(a.model);
  };
  walk(model);
  d.body.appendChild(srcs);
  const ok = el('button', 'btn accent', 'Close');
  ok.onclick = d.close;
  d.footer.append(el('div', 'sp'), ok);
  ok.focus();
  return d;
}
