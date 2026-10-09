/* The one Options list of a slot: package options (and parametric presets), designs from an
   agent (verdict dot, `new`), then Import… and Ask agent.  One line per option, ⓘ for the
   detail.  The inspector renders it inline; the action bar, the tree ⇄ and [ ] open it as a
   popover. */

import { icon } from './icons.js';
import { openImportDialog, anyDialogOpen } from './dialogs.js';
import { el } from './dom.js';
import { DOT } from '../features/verdict.js';
import { slotOptions, applySlotOption, compatLine } from '../features/slot-options.js';

const LINE = 60;
const clip = (s) => { const t = String(s || '').trim(); return t.length > LINE ? t.slice(0, LINE - 1).trimEnd() + '…' : t; };

/**
 * @param {object} ctx  the design-page context
 * @param {string} slotId
 * @param {{inline?:boolean, prefer?:string, onDone?:Function, onPreview?:(entry|null)=>void}} opts
 */
export function buildOptions(ctx, slotId, opts = {}) {
  const root = el('div', 'optlist' + (opts.inline ? ' inline' : ''));
  let items = [], focusIdx = 0, alive = true;

  function render() {
    if (!alive) return;
    const S = ctx.slots;
    const slot = S.slots[slotId];
    root.innerHTML = '';
    items = [];
    if (!slot) return;
    const design = ctx.store.getState();
    const alts = ctx.alternativesFor(slotId);
    const altIds = new Set(alts.flatMap((a) => [a.id, 'alt:' + a.id]));
    for (const e of slotOptions(ctx.model, S, design, slotId, opts.prefer)) {
      if (altIds.has(e.id)) continue;
      root.appendChild(row(e.label, e.summary || e.note || '', e.active, null, () => apply(e), e));
    }
    const failed = ctx.agent ? ctx.agent.cardsFor(slotId).filter((c) => !c.ok) : [];
    if (alts.length || failed.length) {
      root.appendChild(el('div', 'opth', 'From agent'));
      const fittedId = S.activeOption(design, slotId);
      for (const a of alts) {
        const info = ctx.agent ? ctx.agent.cardOf(a.id) : null;
        const r = row(a.label, info && info.reason ? info.reason : '', fittedId === 'alt:' + a.id,
          { agent: true, isNew: info && info.isNew, missing: info && info.missing, level: info ? info.verdict : null },
          () => (info ? ctx.agent.use(info.key) : ctx.on.applyAlternative(slotId, a)).then(() => render()));
        r.disabled = !!(info && info.missing && !ctx.agent.isFitted(info));
        r.onmouseenter = () => { if (info && ctx.agent) ctx.agent.preview(info.key); };
        r.onmouseleave = () => { if (info && ctx.agent) ctx.agent.preview(null); };
        root.appendChild(r);
      }
      for (const c of failed) {
        const r = row(c.label, (c.errors || []).join('\n'), false, { agent: true, level: 'fail', failed: c.reason }, null);
        r.disabled = true;
        root.appendChild(r);
      }
    }
    const acts = el('div', 'optacts');
    const imp = el('button', 'btn sm ghost');
    imp.type = 'button';
    imp.dataset.role = 'import';
    imp.append(icon('import', 'i14'), document.createTextNode('Import…'));
    imp.title = 'a mesh or a part folder, into this mount';
    imp.onclick = () => openImportDialog({ title: 'Import into ' + (slot.label || slotId), remember: false,
      onImported: (res) => ctx.on.importIntoSlot(slotId, res) });
    const ask = el('button', 'btn sm ghost');
    ask.type = 'button';
    ask.dataset.role = 'ask';
    ask.append(icon('sparkle', 'i14'), document.createTextNode('Ask agent'));
    ask.onclick = () => { if (opts.onDone) opts.onDone(null); if (ctx.on.openAgent) ctx.on.openAgent(slotId); };
    acts.append(imp, ask);
    root.appendChild(acts);
  }

  function apply(e) {
    const r = applySlotOption(ctx.model, ctx.slots, ctx.store.getState(), slotId, e);
    ctx.on.applySwap(slotId, e, r);
    if (opts.onDone) opts.onDone(e);
    render();
  }

  /** one option: ◉ label · badges · ⓘ */
  function row(label, detail, active, agent, onPick, entry) {
    const b = el('button', 'opt' + (active ? ' on' : ''));
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(!!active));
    b.dataset.label = label;
    b.append(el('span', 'radio'));
    if (agent && agent.level) { const d = el('span', 'dot ' + (DOT[agent.level] || 'unk')); d.title = agent.level; b.append(d); }
    const n = el('span', 'n', clip(label));
    n.title = label;
    b.append(n);
    if (agent && agent.isNew) b.append(el('span', 'tagnew', 'new'));
    if (agent && agent.missing) b.append(el('span', 'tagnew', 'missing'));
    if (agent && agent.failed) b.append(el('span', 'why', clip('failed: ' + agent.failed)));
    if (detail) {
      const i = el('span', 'info');
      i.append(icon('info', 'i14'));
      i.title = detail;
      b.append(i);
    }
    if (onPick) b.onclick = onPick;
    if (entry) {
      b.onmouseenter = () => { if (opts.onPreview) opts.onPreview(entry); compat(entry); };
      b.onmouseleave = () => { if (opts.onPreview) opts.onPreview(null); compat(null); };
    }
    items.push(b);
    return b;
  }

  let compatEl = null;
  function compat(e) {
    if (compatEl) { compatEl.remove(); compatEl = null; }
    if (!e || e.kind !== 'option') return;
    const line = compatLine(ctx.slots, ctx.store.getState(), slotId, e.id);
    if (!line) return;
    compatEl = el('div', 'compat', clip(line));
    compatEl.title = line;
    root.appendChild(compatEl);
  }

  render();
  return {
    el: root, refresh: render,
    focusFirst() { const c = items.find((x) => x.classList.contains('on')) || items[0]; if (c) c.focus(); focusIdx = Math.max(0, items.indexOf(c)); },
    move(d) { if (!items.length) return; focusIdx = Math.max(0, Math.min(items.length - 1, focusIdx + d)); items[focusIdx].focus(); },
    dispose() { alive = false; },
  };
}

/* the popover */
let current = null;
export const optionsOpen = () => !!current;
export function closeOptions() {
  if (!current) return;
  current.content.dispose();
  current.node.remove();
  document.removeEventListener('keydown', current.onKey, true);
  document.removeEventListener('mousedown', current.onDown, true);
  const back = current.opener;
  current = null;
  if (back && back.focus) try { back.focus(); } catch (e) { /* gone */ }
}

/** anchored under `anchorEl`, flipped and clamped on screen; Esc closes */
export function openOptions(anchorEl, ctx, slotId, opts = {}) {
  closeOptions();
  const slot = ctx.slots.slots[slotId];
  if (!slot) return null;
  const node = el('div', 'pop');
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', 'Options · ' + slot.label);
  const ph = el('div', 'ph');
  const x = el('button', 'btn icon ghost');
  x.append(icon('close', 'i14'));
  x.title = 'Close · Esc';
  x.onclick = closeOptions;
  ph.append(el('span', 'n', slot.label), el('div', 'sp'), x);
  const content = buildOptions(ctx, slotId, { prefer: opts.prefer, onDone: () => closeOptions(), onPreview: opts.onPreview });
  node.append(ph, content.el);
  document.body.appendChild(node);
  const a = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect()
    : { left: 120, top: 120, bottom: 120, right: 120 };
  const w = node.offsetWidth, h = node.offsetHeight;
  node.style.left = Math.min(Math.max(8, a.left), window.innerWidth - w - 8) + 'px';
  let top = a.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
  node.style.top = top + 'px';
  const onKey = (e) => {
    if (e.key === 'Escape' && !anyDialogOpen()) { e.stopImmediatePropagation(); e.preventDefault(); closeOptions(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); content.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); content.move(-1); }
  };
  const onDown = (e) => { if (!node.contains(e.target)) closeOptions(); };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  current = { node, content, onKey, onDown, opener: document.activeElement };
  content.focusFirst();
  return current;
}
