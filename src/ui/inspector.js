/* The inspector: ONE section stack, no tabs.  Title + crumb, then Options · Shape · Changes ·
   Placement (imports) · Checks · Export this part; with nothing selected, the robot summary.
   The Ask-an-agent panel is its alternate view.  Sections collapse, and that is remembered. */

import { icon } from './icons.js';
import { el } from './dom.js';
import { MODK } from '../core/keymap.js';
import { isRemoved, partCounts } from '../features/slot-options.js';
import { isModified } from '../features/parts.js';
import { DOT } from '../features/verdict.js';
import { makeRows } from './inspector-rows.js';
import { makeTweak } from './inspector-tweak.js';
import { makeChanges } from './inspector-changes.js';
import { makeChecks } from './inspector-checks.js';

export function mountInspector(host, ctx) {
  host.innerHTML = '';
  const ident = el('div', 'ident');
  const identName = el('div', 't');
  const identSub = el('div', 's');
  const more = el('button', 'btn icon ghost');
  more.type = 'button';
  more.append(icon('dots-vertical', 'i14'));
  more.title = 'Frame · hide · isolate · delete';
  more.setAttribute('aria-label', 'More');
  const left = el('div', 'il');
  left.append(identName, identSub);
  ident.append(left, more);
  const body = el('div', 'ibody');
  host.append(ident, body);

  const S = {
    tab: 'swap', view: null, swapContent: null, physicsTimer: null, chipTimer: null,
    lastResult: null, resetBtn: null, printCache: new Map(),
    slotIdOf: (c) => (c ? (ctx.slotOf ? ctx.slotOf(c.id) : c.slot) : null),
    body, identName, identSub, more,
  };
  Object.assign(S, makeRows(ctx, S), makeTweak(ctx, S), makeChanges(ctx, S), makeChecks(ctx, S));

  const closed = () => new Set(ctx.store.get('ui.panels.closed') || []);
  /** one collapsible section; `fill(host)` returning false drops it */
  function section(key, title, fill) {
    const s = el('div', 'sec');
    s.dataset.sec = key;
    const h = el('button', 'h');
    h.type = 'button';
    const shut = closed().has(key);
    h.append(icon(shut ? 'chevron-right' : 'chevron-down', 'i12'), el('span', null, title));
    h.setAttribute('aria-expanded', String(!shut));
    h.onclick = () => {
      const c = closed();
      if (c.has(key)) c.delete(key); else c.add(key);
      ctx.store.set('ui.panels.closed', [...c]);
      render();
    };
    const sb = el('div', 'sb');
    s.append(h, sb);
    if (fill(sb) === false) return null;
    if (shut) sb.hidden = true;
    body.appendChild(s);
    return s;
  }

  function render() {
    const st = ctx.store.getState();
    const sel = ctx.selection();
    const c = sel[0] ? ctx.model.component(sel[0]) : null;
    if (S.swapContent) { S.swapContent.dispose(); S.swapContent = null; }
    const agentView = S.view === 'agent' && !!ctx.agent;
    ident.style.display = agentView ? 'none' : '';
    if (agentView) { ctx.agent.panel.mount(body); return; }
    body.innerHTML = '';
    if (!c) { renderRobot(st); return; }
    S.renderIdentity(c, sel);
    if (isRemoved(st, c.id)) { S.renderRemoved(c); section('options', 'Options', (h) => S.optionsSection(c, h)); return; }
    if (S.notFitted(st, c)) { S.renderNotFitted(c, st); return; }
    section('options', 'Options', (h) => S.optionsSection(c, h));
    section('shape', 'Shape', (h) => (c.geometry ? S.shapeSection(c, st, h) : false) || S.paramSection(c, st, h));
    if (c.geometry) section('changes', 'Changes', (h) => S.changesSection(c, st, h));
    if (c.group === 'imported' || c.imported) section('placement', 'Placement', (h) => S.placementSection(c, st, h));
    section('checks', 'Checks', (h) => { S.checksSection(c, h); });
    renderExport(c);
  }

  /* Export this part: only a fail blocks it, and the Export sheet is the way past */
  let exportRow = null;
  function renderExport(c) {
    if (!c || !c.printable || sel1() !== c.id) { if (exportRow) exportRow.remove(); exportRow = null; return; }
    if (!exportRow || !exportRow.isConnected) {
      exportRow = el('div', 'sec expart');
      body.appendChild(exportRow);
    }
    exportRow.innerHTML = '';
    const pr = S.lastPrint(c.id);
    const fail = pr && pr.verdict === 'fail';
    const b = el('button', 'btn accent wide');
    b.type = 'button';
    b.dataset.role = 'export-part';
    b.append(icon('export', 'i14'), document.createTextNode('Export this part'));
    b.disabled = !!fail;
    b.title = fail ? ((pr.chips.find((x) => x.level === 'fail') || {}).detail || 'fails the print check') : `STL · ${MODK} E`;
    b.onclick = () => ctx.on.export('selected');
    exportRow.appendChild(b);
    if (fail) {
      const go = el('button', 'link', 'Open Export');
      go.onclick = () => ctx.on.exportSheet();
      exportRow.appendChild(go);
    }
  }
  const sel1 = () => ctx.selection().length === 1 ? ctx.selection()[0] : null;
  S.renderExport = renderExport;

  /* nothing selected: the robot */
  function renderRobot(st) {
    identName.textContent = ctx.model.name;
    identName.title = ctx.model.id;
    const vis = ctx.visible();
    const { printed } = partCounts(ctx.model, ctx.slots, st, vis);
    const nCams = ctx.cams.ids.filter((id) => { try { return ctx.cams.getPose(id, {}).ok; } catch (e) { return false; } }).length;
    identSub.textContent = `${printed} printed parts · ${nCams} cameras`;
    more.onclick = () => ctx.on.menu(more, [{ label: 'Package info', run: () => ctx.on.packageInfo() }]);
    section('parts', 'Parts you can change', (h) => {
      for (const row of ctx.slots.slotSummary(st)) {
        const r = el('div', 'slotline');
        r.dataset.slot = row.slot;
        const k = el('button', 'k', row.label);
        k.type = 'button';
        k.onclick = () => ctx.on.selectSlot(row.slot);
        const v = el('span', 'v' + (row.isDefault ? '' : ' changed'), ctx.optionLabel(row.slot));
        v.title = v.textContent;
        const b = el('button', 'rowbtn swap');
        b.type = 'button';
        b.append(icon('swap', 'i14'));
        b.title = 'Options';
        b.setAttribute('aria-label', 'Options for ' + row.label);
        b.onclick = () => ctx.on.swapSlot(row.slot, b);
        r.append(k, v, b);
        h.appendChild(r);
      }
      return h.children.length > 0;
    });
    section('checks', 'Checks', (h) => {
      const c = ctx.checks ? ctx.checks() : null;
      const line = el('button', 'fline');
      line.type = 'button';
      const level = c ? c.level : 'unknown';
      line.dataset.level = level;
      line.append(el('span', 'dot ' + DOT[level]), el('span', 'k', 'Design'),
        el('span', 'r', !c ? 'measuring…' : level === 'pass' ? 'ok' : level === 'unknown' ? 'not measured' : c.reason));
      line.title = 'Open Check';
      line.onclick = () => ctx.on.tab('check');
      h.appendChild(line);
    });
    if (ctx.agent) {
      const s = el('div', 'sec');
      const ask = el('button', 'btn wide');
      ask.type = 'button';
      ask.append(icon('sparkle', 'i14'), document.createTextNode('Ask an agent…'));
      ask.onclick = () => ctx.agent.openAgent([]);
      s.appendChild(ask);
      body.appendChild(s);
    }
  }

  function setTab(id) {
    S.tab = id;
    S.view = null;
    render();
    const n = body.querySelector(`.sec[data-sec="${id}"]`);
    if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
  }

  const fmt = (n, step) => {
    if (n == null) return '';
    const d = step && step < 1 ? Math.min(2, String(step).split('.')[1].length) : 0;
    return (+n).toFixed(Math.abs(n - Math.round(n)) < 1e-9 && !d ? 0 : d);
  };
  Object.assign(S, { render, setTab, fmt, renderFooter: () => {} });

  render();
  return {
    render, el: host, setTab,
    get tab() { return S.tab; },
    get view() { return S.view; },
    openAgent() { S.view = 'agent'; render(); },
    closeAgent() { S.view = null; render(); },
    invalidatePhysics() { S.lastResult = null; S.printCache.clear(); },
    invalidatePrinter() { S.lastResult = null; S.printCache.clear(); },
    /** the page rebuilt this part's geometry: re-measure and repaint what measured it */
    repaintChips() {
      const id = ctx.selection()[0];
      const c = id ? ctx.model.component(id) : null;
      if (!c) return;
      if (S.lastResult && S.lastResult.component === c.id) S.lastResult = null;
      S.printCache.delete(c.id);
      S.runValidate(c, ['print', 'cameras']);
      S.paintChecks(c);
      S.schedule(c, true);
      if (S.resetBtn && S.resetBtn.isConnected) S.resetBtn.disabled = !isModified(ctx.store.getState(), c.id);
    },
    destroy() {
      clearTimeout(S.chipTimer); S.chipTimer = null;
      clearTimeout(S.physicsTimer); S.physicsTimer = null;
      if (S.swapContent) S.swapContent.dispose();
      host.innerHTML = '';
    },
  };
}
