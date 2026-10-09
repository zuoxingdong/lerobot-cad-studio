/* The page chrome: the viewport header and crumb, the hover name, the selection outline, the
   one-message status bar, the theme and the two rails.  Nothing here owns design state.
   Installed by ui/design-page.js; it reaches the rest through `page.<name>()`. */

import { icon } from './icons.js';
import { paramDefs, paramValues, partTitle } from '../features/parts.js';
import { isRemoved, slotOwnerOf } from '../features/slot-options.js';
import { el } from './dom.js';
import { effectiveTheme, nextTheme } from './design-helpers.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installChrome(page) {
  const { store, model, app, railR, canvas, crumb, status, tag, live, viewport, picking, gizmo, frustums, slots, meshes, ctx, actions, theme, viewBtns, gridBtn, frustBtn, isoBtn, inspBtn } = page;

  /* chrome */
  function labelFor(id) {
    const c = model.component(id);
    if (!c) return null;
    const sid = slotOwnerOf(model, slots, id);
    const slot = sid ? slots.slots[sid] : null;
    return { title: partTitle(c.id) || c.label || c.id, sub: slot ? slot.label : '', slot: sid };
  }

  /* hover: a plain name after 300 ms, never a button */
  let tagTimer = null, tagOn = false;
  function paintTag(target, now) {
    clearTimeout(tagTimer);
    if (!target) { tag.hidden = true; tagOn = false; return; }
    if (!tagOn && !now) { tagTimer = setTimeout(() => { tagOn = true; paintTag(target, true); }, 300); return; }
    const info = picking.hoverTag(target, { width: 220, height: 44 });
    if (!info || !info.label) { tag.hidden = true; return; }
    tag.innerHTML = '';
    tag.append(el('div', 't', info.label.title));
    if (info.label.sub) tag.append(el('div', 's', info.label.sub));
    tag.hidden = false;
    tag.style.left = info.left + 'px';
    tag.style.top = info.top + 'px';
  }
  const hideTag = () => { clearTimeout(tagTimer); tagOn = false; tag.hidden = true; };

  function setActiveView(id) { for (const [k, b] of viewBtns) b.classList.toggle('on', k === id); }

  function renderChrome() {
    const st = store.getState();
    gridBtn.classList.toggle('on', st.ui.grid !== false);
    viewport.gridGroup.visible = st.ui.grid !== false;
    frustBtn.classList.toggle('on', !!st.ui.frustums);
    isoBtn.classList.toggle('on', !!st.ui.isolate);
    const sel = ctx.selection()[0];
    const c = sel && model.component(sel);
    crumb.innerHTML = '';
    if (!c) crumb.append(document.createTextNode(model.name));
    if (c) {
      const b = document.createElement('b');
      const full = partTitle(c.id) || c.label || c.id;
      const m = mountOfPart(sel);
      /* with the mount chip beside it, the part's own name is enough: "upper spar + yoke" */
      b.textContent = m && m.ids.length > 1 && full.includes(' · ') ? full.slice(full.lastIndexOf(' · ') + 3) : full;
      b.title = full;
      crumb.appendChild(b);
      if (m && m.ids.length > 1) {
        const cur = ctx.selection();
        const all = m.ids.every((id) => cur.includes(id));
        const chip = el('button', 'chip crumbchip', all ? `${m.label} · ${m.ids.length} parts`
          : `Part of ${m.label} · select all ${m.ids.length}`);
        chip.dataset.role = 'select-mount';
        chip.title = chip.textContent;
        chip.disabled = all;
        chip.onclick = () => actions.selectMany(m.ids);
        crumb.appendChild(chip);
      }
    }
    let pill = page.vhead.querySelector('.iso-pill');
    if (st.ui.isolate && !pill) {
      pill = el('button', 'btn sm iso-pill');
      pill.append(icon('isolate', 'i14'), document.createTextNode('Isolated'), icon('close', 'i12'));
      pill.onclick = () => actions.isolate(store.get('ui.isolate'));
      crumb.after(pill);
    } else if (!st.ui.isolate && pill) pill.remove();
    if (page.topbar) page.topbar.render();
    viewport.invalidate();
  }

  /** the fitted option a part belongs to: its label and its drawn parts */
  function mountOfPart(id) {
    const sid = slotOwnerOf(model, slots, id);
    if (!sid) return null;
    const st = store.getState();
    let opt = null;
    try { opt = slots.option(sid, slots.activeOption(st, sid)); } catch (e) { opt = null; }
    if (!opt || !(opt.shows || []).includes(id)) return null;
    const vis = ctx.visible();
    const ids = opt.shows.filter((x) => model.component(x) && vis.get(x) !== false && !isRemoved(st, x));
    const label = String(opt.label || slots.slots[sid].label || sid).split(/[,·(]/)[0].trim();
    return { slot: sid, label, ids };
  }

  function syncSelection() {
    hideTag();
    const sel = ctx.selection();
    viewport.outlines.set('select', sel.map((id) => meshes.get(id)).filter(Boolean));
    outlineSize();
    if (page.tree) page.tree.setSelection(sel, sel[0]);
    if (page.inspector) page.inspector.render();
    renderChrome();
    refreshHandles();
    if (page.opsBar) page.opsBar.onSelection();
    const c = sel[0] && model.component(sel[0]);
    canvas.setAttribute('aria-label', c ? 'Viewport · ' + (c.label || c.id) : 'Robot viewport');
    live.textContent = c ? `selected ${c.label || c.id}` : 'selection cleared';
    /* the gizmo exists for placing imported parts, and for nothing else (§6.4) */
    if (c && (c.group === 'imported') && !isRemoved(store.getState(), c.id)) {
      gizmo.attach(meshes.get(c.id));
      gizmo.setMode(store.get('ui.gizmo.mode', 'translate'));
    } else gizmo.detach();
    viewport.invalidate();
  }

  /* src/scene/materials.js builds an outline material the first time outline(kind) is
     asked for, and only viewport.resize() pushes `resolution` into the ones that exist —
     so a material born after the last resize keeps its (1,1) default and the shell covers
     the canvas.  The real fix belongs in scene/materials.js (build the three outline
     materials eagerly, or remember the last size); this keeps it correct meanwhile. */
  function outlineSize() {
    try { viewport.materials.setResolution(viewport.width, viewport.height); } catch (e) { /* older build */ }
  }

  function refreshHandles() {
    const sel = ctx.selection()[0];
    const c = sel && model.component(sel);
    /* a part the slot does not hold is not on the robot: no knobs in the rail, and no
       on-mesh handles over geometry the user cannot print either */
    if (c && !slots.isFitted(store.getState(), c.id)) { gizmo.clearHandles(); return; }
    const defs = c ? paramDefs(c.id) : [];
    const withHandles = defs.filter((d) => d.handle);
    if (!withHandles.length) { gizmo.clearHandles(); return; }
    const values = paramValues(store.getState(), c.id);
    gizmo.setHandles(withHandles.map((d) => ({
      id: c.id + '.' + d.key,
      kind: d.handle.kind, axis: d.handle.axis,
      anchor: typeof d.handle.anchor === 'function' ? d.handle.anchor(values) : (d.handle.anchor || [0, 0, 0]),
      value: values[d.key], min: d.min, max: d.max, step: d.step, perMm: d.handle.perMm || 1,
      onDrag: (v) => ctx.on.setParam(c.id, d.key, v, false),
      onCommit: (v) => { ctx.on.setParam(c.id, d.key, v, true); if (page.inspector) page.inspector.render(); }
    })));
    gizmo.setHandlesVisible(store.get('ui.handles', true) !== false);
  }

  /* status: one short, transient message on the left */
  const statusMsg = el('span', 'msg', '');
  const statusDot = el('span', 'dot');
  status.append(statusDot, statusMsg);
  function clearStatus(prefix) {
    if (prefix && !statusMsg.textContent.startsWith(prefix)) return;
    clearTimeout(page.statusTimer);
    statusMsg.textContent = '';
    statusDot.className = 'dot';
  }
  function setStatus(msg, level) {
    statusMsg.textContent = msg || '';
    statusMsg.title = msg || '';
    statusDot.className = 'dot ' + (!msg ? '' : level === 'warn' ? 'warn' : level === 'err' ? 'err' : 'ok');
    clearTimeout(page.statusTimer);
    page.statusTimer = setTimeout(() => clearStatus(), 4000);
  }
  ctx.on.status = setStatus;
  function updateStatus() { /* the bar holds messages only */ }

  /* theme */
  function cycleTheme() {
    const next = nextTheme(store.get('ui.theme', 'auto'));
    store.set('ui.theme', next);
    applyTheme(next);
    if (page.topbar) page.topbar.render();
    setStatus(`theme: ${next === 'auto' ? `auto (${effectiveTheme('auto')})` : next}`);
  }
  function applyTheme(name) {
    const eff = effectiveTheme(name);
    if (name === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', name);
    /* the NATIVE half of the theme: `src/main.js` writes this inline style once at boot and
       an inline style beats the `color-scheme` in tokens.css, so without this line the
       number spinners, the printer <select> popup and the scrollbars stayed light on dark */
    document.documentElement.style.colorScheme = eff;
    viewport.setTheme(eff);
    gizmo.setTheme();
    frustums.setTheme();
    page.syncCameras();
    viewport.invalidate();
  }

  /* rails: the viewport never goes below 640 px; the inspector becomes a drawer first */
  const MIN_CANVAS = 640;
  function railPx(name, fallback) {
    const n = parseFloat(getComputedStyle(app).getPropertyValue(name));
    return Number.isFinite(n) ? n : fallback;
  }
  function setInspectorDrawer(open) {
    page.inspectorOpen = !!open;
    if (app.classList.contains('insp-drawer')) {
      railR.hidden = !page.inspectorOpen;
      inspBtn.classList.toggle('on', page.inspectorOpen);
      inspBtn.setAttribute('aria-pressed', String(page.inspectorOpen));
      viewport.resize(true);
    }
  }
  function applyLayout() {
    const w = window.innerWidth || 1600;
    const drawer = w - railPx('--rail-l', 264) - railPx('--rail-r', 320) - 2 < MIN_CANVAS;
    app.classList.toggle('insp-drawer', drawer);
    inspBtn.hidden = !drawer;
    railR.hidden = drawer && !page.inspectorOpen;
    inspBtn.classList.toggle('on', drawer && page.inspectorOpen);
    viewport.resize(true);
  }

  function addGrip(rail, side) {
    const g = el('div', 'grip');
    rail.appendChild(g);
    let startX = 0, startW = 0;
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      g.classList.add('dragging');
      startX = e.clientX;
      startW = rail.getBoundingClientRect().width;
    });
    g.addEventListener('pointermove', (e) => {
      if (!g.classList.contains('dragging')) return;
      const d = side === 'l' ? e.clientX - startX : startX - e.clientX;
      const min = side === 'l' ? 208 : 288, max = side === 'l' ? 420 : 480;
      const w = Math.max(min, Math.min(max, startW + d));
      app.style.setProperty(side === 'l' ? '--rail-l' : '--rail-r', w + 'px');
      try { localStorage.setItem('rps/rail-' + side, String(w)); } catch (err) { /* blocked */ }
      viewport.resize(true);
    });
    const stop = () => { g.classList.remove('dragging'); viewport.resize(true); };
    g.addEventListener('pointerup', stop);
    g.addEventListener('pointercancel', stop);
    try {
      const saved = localStorage.getItem('rps/rail-' + side);
      if (saved) app.style.setProperty(side === 'l' ? '--rail-l' : '--rail-r', saved + 'px');
    } catch (err) { /* blocked */ }
  }

  Object.assign(page, {
    addGrip, applyLayout, applyTheme, clearStatus, cycleTheme, labelFor, hideTag,
    outlineSize, paintTag, railPx, refreshHandles, renderChrome, setActiveView, mountOfPart,
    setInspectorDrawer, setStatus, syncSelection, updateStatus,
  });
}
