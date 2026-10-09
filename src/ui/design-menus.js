/* The context menus (a stack, so a submenu keeps its parent up), the component menu, and
   delete / restore, one undo step either way.  Installed by ui/design-page.js. */

import { icon } from './icons.js';
import { emptyOptionOf, isRemoved, slotOptions, slotOwnerOf } from '../features/slot-options.js';
import { MODK } from '../core/keymap.js';
import { el } from './dom.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installMenus(page) {
  const { store, model, canvas, viewport, slots, ctx, actions } = page;

  /* menus */
  /* A STACK, not one node: `Swap ▸` opens a second panel beside the first and the parent
     must stay up behind it.  A click outside EVERY open
     panel closes the lot; Esc and ArrowLeft close one level. */
  let menuStack = [];
  const menuOpen = () => menuStack.length > 0;
  function closeMenu(depth = 0) {
    while (menuStack.length > depth) menuStack.pop().remove();
    if (!menuStack.length) document.removeEventListener('mousedown', onMenuDown, true);
  }
  function onMenuDown(e) { if (!menuStack.some((n) => n.contains(e.target))) closeMenu(); }

  /**
   * @param {HTMLElement|{x,y}} anchor
   * @param {Array<{label?,key?,note?,checked?,title?,disabled?,sep?,header?,run?,submenu?}>} rows
   *        `submenu` is an array of rows (or a function returning one) — the row then
   *        paints a `▸` and opens the nested panel instead of running.
   *        `note` prints a verdict inline after the label (the export gate, §6.6) and
   *        `checked` paints a tick — a row that is a toggle, not a command.
   * @param {{depth?:number, side?:boolean}} [o]
   */
  function openMenu(anchor, rows, o = {}) {
    const depth = o.depth || 0;
    closeMenu(depth);
    const m = el('div', 'menu');
    m.setAttribute('role', 'menu');
    let cursor = -1;
    const items = [];
    for (const r of rows) {
      if (r.sep) { m.appendChild(document.createElement('hr')); continue; }
      if (r.header) { m.appendChild(el('div', 'hd micro', r.header)); continue; }
      const b = el('button', null, r.label);
      b.setAttribute('role', r.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      /* rule: nothing is ever greyed out without a sentence saying why (§8) */
      if (r.title) b.title = r.title;
      if (r.disabled) { b.disabled = true; if (!r.title) b.title = 'not available for this component'; }
      if (r.checked !== undefined) {
        b.setAttribute('aria-checked', String(!!r.checked));
        b.classList.toggle('on', !!r.checked);
        const box = el('span', 'tick');
        if (r.checked) box.appendChild(icon('check', 'i14'));
        b.prepend(box);
      }
      /* a verdict the row is subject to, printed where the row is — never only in a tooltip */
      if (r.note) { const n = el('span', 'note-chip', r.note); n.title = r.title || ''; b.appendChild(n); }
      if (r.key) b.appendChild(el('span', 'k', r.key));
      if (r.submenu) {
        b.setAttribute('aria-haspopup', 'menu');
        const car = el('span', 'sub');
        car.appendChild(icon('chevron-right', 'i14'));
        b.appendChild(car);
        const open = () => openMenu(b, typeof r.submenu === 'function' ? r.submenu() : r.submenu,
          { depth: depth + 1, side: true });
        b.onclick = (e) => { e.stopPropagation(); open(); };
        b.onmouseenter = () => { if (menuStack.length > depth + 1) closeMenu(depth + 1); };
      } else {
        b.onclick = () => { closeMenu(); if (r.run) r.run(); };
        b.onmouseenter = () => { if (menuStack.length > depth + 1) closeMenu(depth + 1); };
      }
      m.appendChild(b);
      items.push(b);
    }
    document.body.appendChild(m);
    const a = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: anchor.x, top: anchor.y, bottom: anchor.y, right: anchor.x, width: 0, height: 0 };
    const left = o.side ? a.right - 2 : a.left;
    const top = o.side ? a.top - 4 : a.bottom + 4;
    m.style.left = Math.max(8, Math.min(left, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(top, window.innerHeight - m.offsetHeight - 8)) + 'px';
    menuStack.push(m);
    if (menuStack.length === 1) setTimeout(() => document.addEventListener('mousedown', onMenuDown, true), 0);
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeMenu(depth); return; }
      if (e.key === 'ArrowLeft' && depth) { e.preventDefault(); closeMenu(depth); return; }
      if (e.key === 'ArrowRight') { const b = items[cursor]; if (b && b.getAttribute('aria-haspopup')) { e.preventDefault(); b.click(); } return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cursor = (cursor + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[cursor].focus();
      }
    });
    if (items[0]) { items[0].focus(); cursor = 0; }
    return m;
  }
  ctx.on.menu = openMenu;

  /**
   * The right-click menu of one component (viewport, tree row and the inspector's `⋯`).
   * `Options…` leads when the slot has ≥ 2 options; `Delete` works on ANY component and is
   * restorable.
   * Nothing is ever disabled without a `title` that says why.
   */
  function componentMenu(id) {
    const c = model.component(id);
    const st = store.getState();
    const vis = ctx.visible();
    const sel = ctx.selection();
    const ids = sel.includes(id) && sel.length > 1 ? sel : [id];
    const many = ids.length > 1;
    const rows = [];
    const gone = isRemoved(st, id);
    const slotId = slotOwnerOf(model, slots, id);
    const entries = slotId ? slotOptions(model, slots, st, slotId, id) : [];

    if (gone) {
      rows.push({ label: many ? `Restore ${ids.length} components` : 'Restore',
        title: 'put it back in the scene, the cameras, the collision check and the export',
        run: () => restoreComponents(ids) }, { sep: true });
    }
    if (!gone && slotId && entries.length >= 2) {
      rows.push({ label: 'Options…', key: '[ ]', title: `${slots.slots[slotId].label} · ${entries.length} options`,
        run: () => actions.swapSlot(slotId, null, id) }, { sep: true });
    }
    rows.push(
      { label: 'Frame', key: 'z', run: () => actions.frame(id) },
      { label: vis.get(id) === false ? 'Show' : 'Hide', key: '⇧V',
        disabled: gone, title: gone ? 'this component is deleted — Restore it first' : '',
        run: () => actions.toggleVisible(id) },
      /* No `Colour…` row: colour is identity, not taste, and there are no per-object
         display overrides beyond hide / isolate. */
      { label: 'Isolate', key: 'i', disabled: gone,
        title: gone ? 'this component is deleted — Restore it first' : '',
        run: () => actions.isolate(id) },
      { sep: true }
    );
    rows.push({
      label: gone ? 'Delete' : (many ? `Delete ${ids.length} components` : 'Delete'),
      key: 'Del', disabled: gone,
      title: gone ? 'already deleted — use Restore'
        : 'hide it everywhere — scene, cameras, collision and export — and keep it under Removed',
      run: () => removeComponents(ids)
    });
    return rows;
  }

  /** **Remove** — empty the slot (its `none` option). One undo step, like any swap. */
  function removeFromSlot(slotId) {
    const empty = emptyOptionOf(slots, slotId);
    if (!empty) { page.setStatus('this slot has no empty option', 'warn'); return false; }
    page.applySwap(slotId, { kind: 'option', id: empty.id, label: empty.label });
    return true;
  }

  /**
   * **Delete** — any component, stock URDF links included.  `design.removed[id]` is the
   * user's answer and `design.components[id].visible=false` is how every consumer that
   * already reads the design (collision, the print check, every export path) sees it
   * without knowing the word.  One undo step, autosaved with the rest of the design.
   */
  function removeComponents(idsIn) {
    const ids = (Array.isArray(idsIn) ? idsIn : [idsIn]).filter((id) => model.component(id));
    if (!ids.length) return false;
    store.update((st) => {
      const removed = { ...(st.removed || {}) };
      const components = { ...(st.components || {}) };
      for (const id of ids) {
        removed[id] = true;
        components[id] = { ...(components[id] || {}), visible: false };
      }
      return { ...st, removed, components };
    }, { label: ids.length > 1 ? `delete ${ids.length} components` : 'delete ' + ids[0] });
    for (const id of ids) page.syncImportedBody(id, { removed: true });
    afterRemovalChange(ids);
    const c = model.component(ids[0]);
    page.setStatus(`${ids.length > 1 ? ids.length + ' components' : (c.label || ids[0])} deleted · `
      + `under Removed in the tree · ${MODK}Z to undo`);
    return true;
  }

  /** **Restore** — drop the `removed` flag and let the slot re-derive the visibility. */
  function restoreComponents(idsIn) {
    const ids = (Array.isArray(idsIn) ? idsIn : [idsIn]).filter((id) => model.component(id));
    if (!ids.length) return false;
    store.update((st) => {
      const removed = { ...(st.removed || {}) };
      const components = { ...(st.components || {}) };
      for (const id of ids) {
        delete removed[id];
        /* put the visibility back where the DESIGN says it belongs: a slot-owned piece
           follows its fitted option, anything else goes back on. */
        components[id] = { ...(components[id] || {}), visible: visibleWhenRestored(st, id) };
      }
      return { ...st, removed, components };
    }, { label: ids.length > 1 ? `restore ${ids.length} components` : 'restore ' + ids[0] });
    for (const id of ids) page.syncImportedBody(id);
    afterRemovalChange(ids);
    const c = model.component(ids[0]);
    page.setStatus(`${ids.length > 1 ? ids.length + ' components' : (c.label || ids[0])} restored`);
    return true;
  }

  /** what `Restore` must set: the fitted option's answer for a slot component, else on. */
  function visibleWhenRestored(st, id) {
    const sid = slotOwnerOf(model, slots, id);
    const slot = sid && slots.slots[sid];
    if (slot) {
      const act = slots.activeOption(st, sid);
      const opt = slot.optionById && slot.optionById[act];
      if (opt) return !!(opt.showSet && opt.showSet.has(id));
    }
    return true;
  }

  function afterRemovalChange(ids) {
    page.designStamp++;                       // the print gate is cached per design revision
    page.applyVisibility();
    page.syncCameras();
    if (page.tree) page.tree.render();
    if (page.inspector) page.inspector.render();
    if (page.inspector) page.inspector.invalidatePhysics();
    page.renderChrome();
    void ids;
  }
  function siblingIds(id) {
    const sid = slotOwnerOf(model, slots, id);
    if (!sid) return new Set();
    const own = (slots.slots[sid] && slots.slots[sid].owns) || [];
    return new Set(own.length ? own : model.componentsOfSlot(sid).map((x) => x.id));
  }
  /**
   * Which camera does this component carry?
   *
   * The MOUNT owns the camera: a package camera is a DEVICE with no link and no pose of
   * its own, so the question is about the SLOT that `provides` it and the OPTION that
   * draws this part.  `provided_by` and a shared link name are still read, for a package
   * that poses its own cameras.
   */
  function camerasAffectedBy(id) {
    const out = new Set();
    for (const cam of model.cameras) {
      const raw = (model.manifest.cameras || []).find((x) => x.id === cam.id) || {};
      if (raw.provided_by === id) out.add(cam.id);
      else if (cam.link && model.component(id) && model.component(id).link === cam.link) out.add(cam.id);
    }
    try {
      const sid = slotOwnerOf(model, slots, id);
      const slot = sid && slots.slots[sid];
      for (const p of (slot && slot.provides) || []) {
        if (!p.startsWith('cameras.')) continue;
        const cid = p.slice('cameras.'.length);
        const opt = slots.option(sid, slots.activeOption(store.getState(), sid));
        const block = ((opt || {}).cameras || {})[cid];
        if (!block) continue;                       // this option carries no camera
        if ((opt.shows || []).includes(id) || block.carrier === id
            || block.carrier === 'component:' + id) out.add(cid);
      }
    } catch (e) { /* a package with no slots */ }
    return [...out];
  }

  Object.assign(page, {
    afterRemovalChange, camerasAffectedBy, closeMenu, componentMenu, menuOpen, onMenuDown,
    openMenu, removeComponents, removeFromSlot, restoreComponents, siblingIds,
    visibleWhenRestored,
  });
}
