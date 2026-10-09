/* The parts tree: PARTS YOU CAN CHANGE (one row per slot, expandable to its fitted parts, ⇄ on the
   slot row only), IMPORTED, STOCK ROBOT (collapsed) and REMOVED (only when not empty).
   Unfitted parts are never listed.  A filter box, a roving tabindex, and two-way hover and
   selection sync with the viewport.  Needs features/. */

import { icon } from './icons.js';
import { el } from './dom.js';
import { isModified, paramDefs } from '../features/parts.js';
import { slotOptions, partCounts } from '../features/slot-options.js';
import { opsOf } from '../core/part-edits.js';

/* the stock robot's own taxonomy, for its order and the crumb */
const STOCK_ORDER = ['base', 'wheels', 'electronics', 'arm', 'gripper', 'camera', 'upgrade', 'hardware'];
const GROUP_MAP = { base: 'base', wheels: 'wheels', electronics: 'electronics', arm: 'arm', camera: 'camera',
  upgrade: 'upgrade', imported: 'imported', gripper: 'gripper', body: 'gripper', linkage: 'gripper',
  finger: 'gripper', fingertip: 'gripper' };
let WHEEL_LINKS = new Set();

/** the links a drive joint turns: the wheels */
export function configureGroups(model) {
  WHEEL_LINKS = new Set();
  const K = (model && model.manifest && model.manifest.kinematics) || {};
  const byName = new Map((K.joints || []).map((j) => [j.name, j]));
  const childOf = new Map();
  for (const j of K.joints || []) {
    if (!childOf.has(j.parent)) childOf.set(j.parent, []);
    childOf.get(j.parent).push(j.child);
  }
  const walk = (link, depth = 0) => {
    if (!link || WHEEL_LINKS.has(link) || depth > 8) return;
    WHEEL_LINKS.add(link);
    for (const c of childOf.get(link) || []) walk(c, depth + 1);
  };
  for (const name of K.drive_joints || []) { const j = byName.get(name); if (j) walk(j.child); }
  return WHEEL_LINKS;
}

/** the stock taxonomy group of a component */
export function treeGroup(c) {
  if (!c) return 'base';
  if (c.imported || c.group === 'imported') return 'imported';
  const g = GROUP_MAP[c.group] || 'base';
  if (g === 'wheels' && c.link && WHEEL_LINKS.has(c.link)) return 'wheels';
  if (!c.printable && !c.slot && g !== 'camera' && g !== 'imported' && g !== 'upgrade') return 'hardware';
  return g;
}

const GROUPS = [['changes', 'Parts you can change'], ['imported', 'Imported'], ['stock', 'Stock robot'], ['removed', 'Removed']];
const DEFAULT_OPEN = ['changes', 'imported'];

/**
 * @param {HTMLElement} host  the left rail
 * @param {object} ctx  { model, store, slots, visible(), slotOf(id), isAgent(slot, opt), on: {…} }
 */
export function mountTree(host, ctx) {
  host.innerHTML = '';
  if (!ctx.store.get('ui.tree.v7')) ctx.store.patch({ ui: { tree: { open: DEFAULT_OPEN.slice(), v7: true } } });
  const search = el('div', 'tree-search');
  search.appendChild(icon('search'));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Filter';
  input.setAttribute('aria-label', 'Filter parts');
  search.appendChild(input);
  const body = el('div', 'tree');
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'Parts');
  body.tabIndex = 0;
  const foot = el('div', 'treefoot');
  host.append(search, body, foot);

  const rows = new Map();            // component id -> row
  let order = [], cursor = null, query = '';
  input.oninput = () => { query = input.value; render(); };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; query = ''; render(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); body.focus(); moveCursor(0); }
  };
  const openSet = () => new Set((ctx.store.getState().ui.tree || {}).open || DEFAULT_OPEN);
  function setOpen(key, on) {
    const s = openSet();
    if (on) s.add(key); else s.delete(key);
    ctx.store.set('ui.tree.open', [...s]);
  }
  const match = (c) => !query || (String(c.label || '') + ' ' + c.id).toLowerCase().includes(query.trim().toLowerCase());
  const edited = (st, id) => { const c = ctx.model.component(id); return !!(c && c.edited)
    || (paramDefs(id).length > 0 && isModified(st, id)) || opsOf(st, id).length > 0
    || !!((st.components || {})[id] || {}).transform; };

  function render() {
    const st = ctx.store.getState();
    const open = openSet();
    const unfitted = ctx.slots.unfittedSet(st);
    const gone = st.removed || {};
    const q = query.trim();
    const onRobot = (c) => !unfitted.has(c.id) && !gone[c.id];
    const bySlot = new Map(), imported = [], stock = [];
    for (const c of ctx.model.components) {
      if (!onRobot(c)) continue;
      const sid = ctx.slotOf(c.id);
      if (sid && ctx.slots.slots[sid]) { if (!bySlot.has(sid)) bySlot.set(sid, []); bySlot.get(sid).push(c); }
      else if (treeGroup(c) === 'imported') imported.push(c);
      else stock.push(c);
    }
    stock.sort((a, b) => STOCK_ORDER.indexOf(treeGroup(a)) - STOCK_ORDER.indexOf(treeGroup(b)));
    const removed = ctx.model.components.filter((c) => gone[c.id]);
    if (removed.length && !open.has('removed') && !render.sawRemoved) { render.sawRemoved = true; setOpen('removed', true); open.add('removed'); }
    if (!removed.length) render.sawRemoved = false;

    body.innerHTML = '';
    rows.clear();
    order = [];
    body.classList.toggle('isolating', !!st.ui.isolate);
    let hidden = 0;
    const vis = ctx.visible();
    const slotIds = ctx.slots.slotSummary(st).map((r) => r.slot);

    for (const [g, label] of GROUPS) {
      let count = 0;
      const items = [];
      if (g === 'changes') {
        for (const sid of slotIds) {
          const parts = (bySlot.get(sid) || []);
          const s = ctx.slots.slots[sid];
          const shown = q ? parts.filter(match) : parts;
          if (q && !shown.length && !String(s.label || sid).toLowerCase().includes(q.toLowerCase())) continue;
          items.push({ slot: sid, parts: shown });
          count++;
        }
      } else {
        const list = (g === 'imported' ? imported : g === 'stock' ? stock : removed).filter(match);
        for (const c of list) items.push({ c });
        count = list.length;
      }
      if (!count && (g !== 'changes' || !slotIds.length || q)) continue;
      const isOpen = q ? true : open.has(g);
      const head = el('button', 'grow');
      head.type = 'button';
      head.dataset.group = g;
      head.setAttribute('role', 'treeitem');
      head.setAttribute('aria-expanded', String(isOpen));
      head.tabIndex = -1;
      head.append(icon(isOpen ? 'chevron-down' : 'chevron-right', 'i14'), el('span', 'n', label));
      head.appendChild(el('span', 'c', String(count)));
      head.onclick = () => { setOpen(g, !open.has(g)); render(); };
      body.appendChild(head);
      order.push('group:' + g);
      if (!isOpen) continue;
      for (const it of items) {
        if (it.slot) {
          const expanded = q ? it.parts.length > 0 : open.has('slot:' + it.slot);
          body.appendChild(slotRow(it.slot, st, expanded, it.parts.length));
          order.push('slot:' + it.slot);
          if (expanded) for (const c of it.parts) { body.appendChild(partRow(c, st, vis, true)); if (vis.get(c.id) === false) hidden++; }
        } else {
          body.appendChild(partRow(it.c, st, vis, false, g === 'removed'));
          if (vis.get(it.c.id) === false) hidden++;
        }
      }
    }
    if (q && !rows.size && !body.querySelector('.row.slot')) {
      const n = el('div', 'nomatch');
      const clr = el('button', 'link', 'clear');
      clr.onclick = () => { input.value = ''; query = ''; render(); };
      n.append(el('span', null, 'no match'), clr);
      body.appendChild(n);
    }
    const n = partCounts(ctx.model, ctx.slots, st, vis);
    foot.textContent = `${n.parts} parts · ${n.printed} printed` + (hidden ? ` · ${hidden} hidden` : '');
    applyCursor();
  }

  /** one slot: its label, the fitted option, ⇄, and ● / ✦ badges */
  function slotRow(sid, st, expanded, nParts) {
    const s = ctx.slots.slots[sid];
    const list = slotOptions(ctx.model, ctx.slots, st, sid);
    const act = list.find((o) => o.active) || null;
    const activeId = ctx.slots.activeOption(st, sid);
    let opt = null;
    try { opt = ctx.slots.option(sid, activeId); } catch (e) { opt = null; }
    /* an agent design is fitted before its meshes are drawn: never "None" */
    const agent = String(activeId || '').startsWith('alt:');
    const empty = !agent && (!opt || !(opt.shows || []).length);
    const row = el('div', 'row slot' + (empty ? ' hole' : ''));
    row.dataset.slot = sid;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(expanded));
    row.tabIndex = -1;
    const tw = el('button', 'rowbtn tw');
    tw.type = 'button';
    tw.tabIndex = -1;
    tw.append(icon(expanded ? 'chevron-down' : 'chevron-right', 'i12'));
    tw.setAttribute('aria-label', expanded ? 'collapse' : 'expand');
    tw.disabled = !nParts;
    tw.onclick = (e) => { e.stopPropagation(); setOpen('slot:' + sid, !expanded); render(); };
    const name = el('span', 'n', s.label || sid);
    const optLabel = empty ? 'None' : ctx.optionLabel ? ctx.optionLabel(sid) : (act ? act.label : (opt && opt.label) || '');
    row.title = `${s.label || sid}: ${optLabel}`;
    const meta = el('span', 'm', empty ? 'None' : '');
    const changed = activeId !== s.default || (opt && (opt.shows || []).some((id) => edited(st, id)));
    const badge = el('span', 'badge');
    if (agent) { badge.append(icon('sparkle', 'i12')); badge.title = 'from an agent'; badge.classList.add('agent'); } else if (changed) { badge.append(el('span', 'dot acc')); badge.title = 'changed'; }
    row.append(tw, name, meta, badge);
    if (list.length >= 2) {
      const b = el('button', 'rowbtn swap');
      b.type = 'button';
      b.tabIndex = -1;
      b.append(icon('swap', 'i14'));
      b.title = `Options · ${list.length}`;
      b.setAttribute('aria-label', 'Options for ' + (s.label || sid));
      b.onclick = (e) => { e.stopPropagation(); ctx.on.swapSlot(sid, b); };
      row.appendChild(b);
    }
    row.onclick = () => { setCursor('slot:' + sid); if (empty) ctx.on.swapSlot(sid, row); else ctx.on.selectSlot(sid); };
    row.ondblclick = () => { const ids = (opt && opt.shows) || []; if (ids[0]) ctx.on.frame(ids[0]); };
    return row;
  }

  function partRow(c, st, vis, nested, removed) {
    const visible = vis.get(c.id) !== false;
    const sel = st.ui.selected === c.id || (st.ui.multi || []).includes(c.id);
    const row = el('div', 'row' + (nested ? ' sub' : '') + (removed ? ' rm' : ''));
    row.dataset.id = c.id;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-selected', String(sel));
    row.tabIndex = -1;
    if (sel) row.classList.add('sel');
    if (st.ui.selected === c.id) row.classList.add('anchor');
    if (!visible) row.classList.add('hidden');
    if (st.ui.isolate === c.id) row.classList.add('iso');
    const name = el('span', 'n', c.label || c.id);
    name.title = c.label || c.id;
    row.appendChild(name);
    if (!removed && edited(st, c.id)) { const d = el('span', 'badge'); d.append(el('span', 'dot acc')); d.title = 'changed'; row.appendChild(d); }
    const acts = el('span', 'a');
    const b = el('button', 'rowbtn' + (removed ? ' restore' : ''));
    b.type = 'button';
    b.tabIndex = -1;
    b.append(icon(removed ? 'undo' : visible ? 'eye' : 'eye-off', 'i14'));
    b.title = removed ? 'Restore' : visible ? 'Hide' : 'Show';
    b.setAttribute('aria-label', b.title);
    b.onclick = (e) => { e.stopPropagation(); if (removed) ctx.on.restore(c.id); else ctx.on.toggleVisible(c.id); };
    acts.appendChild(b);
    row.appendChild(acts);
    row.onpointerenter = () => ctx.on.hover(c.id);
    row.onpointerleave = () => ctx.on.hover(null);
    row.onclick = (e) => { setCursor(c.id); ctx.on.select(c.id, e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'set'); };
    row.ondblclick = () => ctx.on.frame(c.id);
    row.oncontextmenu = (e) => { e.preventDefault(); if (!sel) ctx.on.select(c.id, 'set'); ctx.on.contextmenu(c.id, e.clientX, e.clientY); };
    rows.set(c.id, row);
    order.push(c.id);
    return row;
  }

  /* keyboard: a roving tabindex */
  function setCursor(id) { cursor = id; applyCursor(); }
  function nodeFor(key) {
    if (!key) return null;
    if (key.startsWith('group:')) return body.querySelector(`.grow[data-group="${key.slice(6)}"]`);
    if (key.startsWith('slot:')) return body.querySelector(`.row.slot[data-slot="${key.slice(5)}"]`);
    return rows.get(key) || null;
  }
  function applyCursor() {
    for (const r of body.querySelectorAll('[tabindex]')) r.tabIndex = -1;
    const n = nodeFor(cursor) || body.querySelector('.grow,.row');
    if (n) n.tabIndex = 0;
  }
  function moveCursor(d) {
    if (!order.length) return;
    let i = order.indexOf(cursor);
    i = i < 0 ? 0 : Math.max(0, Math.min(order.length - 1, i + d));
    cursor = order[i];
    applyCursor();
    const n = nodeFor(cursor);
    if (n) { n.focus(); n.scrollIntoView({ block: 'nearest' }); }
  }
  body.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); moveCursor(cursor ? 1 : 0); return; }
    if (k === 'ArrowUp') { e.preventDefault(); moveCursor(-1); return; }
    if (k === '/') { e.preventDefault(); input.focus(); input.select(); return; }
    if (!cursor) return;
    const n = nodeFor(cursor);
    if (cursor.startsWith('group:') || cursor.startsWith('slot:')) {
      const key = cursor.startsWith('group:') ? cursor.slice(6) : cursor;
      const isOpen = openSet().has(key);
      if ((k === 'ArrowRight' && !isOpen) || (k === 'ArrowLeft' && isOpen) || (cursor.startsWith('group:') && (k === 'Enter' || k === ' '))) {
        e.preventDefault(); setOpen(key, !isOpen); render(); const m = nodeFor(cursor); if (m) m.focus();
      } else if (k === 'Enter' && n) { e.preventDefault(); n.click(); }
      return;
    }
    if (k === 'Enter') { e.preventDefault(); ctx.on.select(cursor, 'set'); }
    else if (k === ' ') { e.preventDefault(); ctx.on.toggleVisible(cursor); }
  });

  return {
    render, el: host,
    setHover(id) { for (const [rid, r] of rows) r.classList.toggle('hover', rid === id); },
    /** selection from the viewport: reveal a slot part by expanding its slot, paint, scroll */
    setSelection(ids, primary) {
      const sid = primary ? ctx.slotOf(primary) : null;
      if (sid && ctx.slots.slots[sid] && !rows.has(primary) && !openSet().has('slot:' + sid)) { setOpen('slot:' + sid, true); render(); }
      const set = new Set(ids || []);
      for (const [rid, r] of rows) {
        r.classList.toggle('sel', set.has(rid));
        r.classList.toggle('anchor', rid === primary);
        r.setAttribute('aria-selected', String(set.has(rid)));
      }
      if (primary && rows.has(primary)) { cursor = primary; applyCursor(); rows.get(primary).scrollIntoView({ block: 'nearest' }); }
    },
    rowFor: (id) => rows.get(id) || null,
    destroy() { host.innerHTML = ''; },
  };
}
