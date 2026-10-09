/* The Check tab over the mounted Design page: a pose row (presets, sweep all), the camera
   tiles, and ONE checks table (part / camera × Print · Fit · Limits · Cameras, "Only problems"
   on by default, the printer).  A part row selects and frames it in Design. */

import { icon } from './icons.js';
import { chipEl } from './dialogs.js';
import { el } from './dom.js';
import { PRINTERS, printerProfile } from '../features/printcheck.js';
import { FAMILIES, DOT, rowVerdict } from '../features/verdict.js';

const cap = (s) => String(s || '').replace(/^\w/, (m) => m.toUpperCase());

export function mountCheck(page) {
  const { app, ctx, actions } = page;
  const { store, model } = ctx;
  app.classList.add('check-on');
  const frustWas = !!store.get('ui.frustums');
  if (!frustWas) { store.set('ui.frustums', true); page.syncCameras(); }
  let onlyProblems = store.get('ui.check.problems') !== false;
  const open = new Set();
  const current = new Map();               // camera id -> [{preset, level, text}] at the current pose

  /* pose row */
  const head = page.checkHead;
  head.innerHTML = '';
  const seg = el('div', 'seg poses');
  for (const p of page.presets) {
    const b = el('button', null, cap(p.label || p.name));
    b.type = 'button';
    b.dataset.preset = p.name || p.id;
    b.onclick = () => { actions.preset(b.dataset.preset); paintPoses(); };
    seg.appendChild(b);
  }
  const sweepBtn = el('button', 'btn sm');
  sweepBtn.type = 'button';
  sweepBtn.append(icon('play', 'i14'), document.createTextNode('Sweep all'));
  sweepBtn.title = 'every preset: collisions, limits and what each camera sees';
  sweepBtn.onclick = () => runSweep();
  const phys = el('label', 'chk');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = store.get('ui.physics') !== false;
  cb.onchange = () => store.set('ui.physics', cb.checked);
  const box = document.createElement('i');
  box.appendChild(icon('check', 'i12'));
  phys.append(cb, box, document.createTextNode('Stop at collisions'));
  phys.title = 'posing the arm stops where it would hit the robot';
  head.append(el('span', 'k', 'Pose'), seg, sweepBtn, el('div', 'sp'), phys);
  if (!page.presets.length) { seg.hidden = true; sweepBtn.hidden = true; }
  function paintPoses() {
    const a = store.get('ui.preset');
    for (const b of seg.children) b.classList.toggle('on', b.dataset.preset === a);
  }

  /* the table */
  const host = page.checkTable;
  host.innerHTML = '';
  const bar = el('div', 'ctbar');
  const only = el('label', 'chk');
  const ocb = document.createElement('input');
  ocb.type = 'checkbox';
  ocb.checked = onlyProblems;
  ocb.onchange = () => { onlyProblems = ocb.checked; store.set('ui.check.problems', onlyProblems); paint(); };
  const obox = document.createElement('i');
  obox.appendChild(icon('check', 'i12'));
  only.append(ocb, obox, document.createTextNode('Only problems'));
  const printer = document.createElement('select');
  printer.className = 'text-in';
  printer.setAttribute('aria-label', 'Printer');
  for (const p of PRINTERS) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    printer.appendChild(o);
  }
  printer.onchange = () => ctx.on.setPrinter(printer.value);
  const summary = el('span', 'ctsum');
  bar.append(el('span', 'h', 'Checks'), summary, el('div', 'sp'), only, el('span', 'k', 'Printer'), printer);
  const table = el('table', 'ctable');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const t of ['Part / camera', ...FAMILIES.map(([, n]) => n), 'Why']) hr.appendChild(el('th', null, t));
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  const scroll = el('div', 'ctscroll');
  scroll.appendChild(table);
  host.append(bar, scroll);

  function cell(f, extra) {
    const td = el('td', 'fam');
    if (!f && !extra) { td.textContent = '—'; td.classList.add('na'); return td; }
    if (extra && extra.length) {
      for (const s of extra) { const d = el('span', 'dot ' + DOT[s.level]); d.title = `${cap(s.preset)}: ${s.text}`; td.appendChild(d); }
      return td;
    }
    const d = el('span', 'dot ' + DOT[f.level]);
    td.appendChild(d);
    td.title = f.level === 'pass' ? 'ok' : f.reason + (f.why ? ' · ' + f.why : '');
    return td;
  }

  /* the current pose's camera dots; a sweep of this design (the row's `sweep`) replaces them */
  function currentPose() {
    if (!page.strip) return;
    const id = store.get('ui.preset');
    const p = page.presets.find((x) => (x.name || x.id) === id);
    const label = p ? (p.label || p.name) : 'current pose';
    current.clear();
    for (const [cid, v] of Object.entries(page.strip.verdicts())) current.set(cid, [{ preset: label, level: v.level, text: v.text }]);
  }

  function paint() {
    currentPose();
    const c = page.checks();
    printer.value = printerProfile(ctx.printer()).id;
    paintPoses();
    tbody.innerHTML = '';
    if (!c) { summary.textContent = 'measuring…'; return; }
    summary.textContent = c.level === 'pass' ? 'all ok'
      : [['fail', 'fail'], ['warn', 'warn'], ['unknown', 'not measured']].filter(([k]) => c.counts[k]).map(([k, w]) => `${c.counts[k]} ${w}`).join(' · ');
    summary.dataset.level = c.level;
    let shown = 0;
    for (const row of c.rows) {
      const v = rowVerdict(row);
      if (onlyProblems && v.level !== 'warn' && v.level !== 'fail') continue;
      shown++;
      const tr = document.createElement('tr');
      tr.dataset.id = row.id;
      tr.dataset.level = v.level;
      const name = el('td', 'n');
      const tw = el('button', 'rowbtn tw');
      tw.type = 'button';
      tw.append(icon(open.has(row.id) ? 'chevron-down' : 'chevron-right', 'i12'));
      tw.setAttribute('aria-label', 'details');
      tw.onclick = (e) => { e.stopPropagation(); if (open.has(row.id)) open.delete(row.id); else open.add(row.id); paint(); };
      name.append(tw, el('span', 't', row.label));
      name.title = row.label;
      tr.appendChild(name);
      for (const [k] of FAMILIES) tr.appendChild(cell(row[k], k === 'cameras' ? row.sweep || current.get(row.cam) : null));
      tr.appendChild(el('td', 'why', v.level === 'pass' ? '' : v.reason));
      tr.onclick = () => go(row);
      tbody.appendChild(tr);
      if (open.has(row.id)) {
        const dr = el('tr', 'detail');
        const td = el('td');
        td.colSpan = FAMILIES.length + 2;
        const chips = el('div', 'chips');
        for (const [k] of FAMILIES) for (const it of (row[k] && row[k].items) || []) {
          chips.appendChild(chipEl({ key: it.key, level: it.level, text: it.label, tooltip: it.why }));
        }
        td.appendChild(chips);
        dr.appendChild(td);
        tbody.appendChild(dr);
      }
    }
    if (!shown) {
      const tr = el('tr', 'empty');
      const td = el('td', null, onlyProblems ? 'No problems' : 'Nothing to check');
      td.colSpan = FAMILIES.length + 2;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  /** a part row: select and frame it in Design; a pose row poses the arm; a camera enlarges */
  function go(row) {
    if (row.kind === 'part') {
      location.hash = '#/design/' + encodeURIComponent(model.id);
      setTimeout(() => { actions.select(row.id); actions.frame(row.id); }, 0);
    } else if (row.kind === 'pose') { actions.preset(row.preset); paintPoses(); } else if (row.kind === 'camera' && page.strip) page.strip.enlarge(row.cam);
  }

  /**
   * Every preset in turn, posed on the model only (no undo step): the camera verdicts per
   * pose, which then feed the table, the summary and the pill.  The pose before it comes back.
   */
  function runSweep() {
    const q0 = model.getJoints();
    const out = {};
    try {
      for (const p of page.presets) {
        model.setJoints({ ...q0, ...(p.q || {}) });
        page.syncMatrices();
        page.syncCameras();
        page.strip.forceTick();
        for (const [cid, v] of Object.entries(page.strip.verdicts())) {
          (out[cid] = out[cid] || []).push({ preset: p.label || p.name || p.id, level: v.level, text: v.text });
        }
      }
    } finally {
      model.setJoints(q0);
      page.applyPose();
      page.strip.forceTick();
    }
    page.setSweep(out);
    paint();
    return out;
  }

  const offChecks = page.onChecks(() => paint());
  const unsub = store.subscribe(() => { page.checks(); paintPoses(); });
  if (page.strip) { page.strip.render(); requestAnimationFrame(() => page.strip.forceTick()); }
  page.viewport.resize(true);
  paint();
  if (!page.checks()) setTimeout(() => { if (!page.destroyed) { page.checksNow(); } }, 0);

  return {
    paint, sweep: runSweep,
    destroy() {
      offChecks(); unsub();
      if (page.strip) page.strip.restore();
      app.classList.remove('check-on');
      head.innerHTML = ''; host.innerHTML = '';
      if (!frustWas && !page.destroyed) { store.set('ui.frustums', false); page.syncCameras(); }
      if (!page.destroyed) page.viewport.resize(true);
    },
  };
}
