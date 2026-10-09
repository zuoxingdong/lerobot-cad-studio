/* The inspector rows: the title and crumb, the removed and not-fitted cards, the Options
   section and an imported mesh's Placement.  Needs three, features/ and the shared record
   ui/inspector.js hands in. */

import * as THREE from 'three';
import { icon } from './icons.js';
import { buildOptions } from './options-list.js';
import { el } from './dom.js';
import { partTitle } from '../features/parts.js';
import * as placement from '../features/placement.js';
const GIZMO_SNAPS = { mm: placement.SNAP_MM, deg: placement.SNAP_DEG };

export function makeRows(ctx, S) {
  /* title + crumb: the part, then the mount it belongs to */
  function renderIdentity(c, sel) {
    if (sel.length > 1) {
      S.identName.textContent = `${sel.length} parts`;
      S.identSub.textContent = 'ops apply to all';
      S.identName.title = sel.join(', ');
      return;
    }
    S.identName.textContent = partTitle(c.id) || c.label || c.id;
    S.identName.title = `${S.identName.textContent} · ${c.id}`;
    const sid = S.slotIdOf(c);
    const slot = sid ? ctx.slots.slots[sid] : null;
    S.identSub.textContent = slot ? slot.label : c.group === 'imported' ? 'Imported' : 'Stock robot';
    S.more.onclick = () => ctx.on.menu(S.more, ctx.componentMenu(c.id));
  }

  function card(ico, text, action) {
    const s = el('div', 'sec');
    const box = el('div', 'removedcard');
    const line = el('div', 't');
    line.append(icon(ico, 'i14'), document.createTextNode(text));
    if (action) line.append(el('div', 'sp'), action);
    box.appendChild(line);
    s.appendChild(box);
    S.body.appendChild(s);
  }
  function renderRemoved(c) {
    const back = el('button', 'link', 'Restore');
    back.onclick = () => ctx.on.restore(c.id);
    card('error', 'Removed', back);
  }
  /** a part of an option the slot does not hold */
  function notFitted(st, c) { return !!c && !ctx.isRemoved(c.id) && !ctx.slots.isFitted(st, c.id); }
  function renderNotFitted(c, st) {
    const sid = S.slotIdOf(c);
    const slot = sid ? ctx.slots.slots[sid] : null;
    const mine = slot ? (slot.options || []).find((o) => (o.shows || []).includes(c.id)) : null;
    let go = null;
    if (sid && mine) {
      go = el('button', 'link', 'Fit it');
      go.onclick = () => ctx.on.applySwap(sid, { ...mine, kind: mine.kind || 'option', id: mine.id });
    }
    card('swap', 'Not on the robot', go);
    void st;
  }

  /** Options: the one list, inline */
  function optionsSection(c, host) {
    const sid = S.slotIdOf(c);
    if (!sid) return false;
    S.swapContent = buildOptions(ctx, sid, { inline: true, prefer: c.id, onPreview: ctx.on.previewOption });
    host.appendChild(S.swapContent.el);
    return true;
  }

  /** Placement of an imported mesh: parent, XYZ / RPY, the gizmo, drop and snap */
  function placementSection(c, st, host) {
    const s = host;
    const over = (st.components || {})[c.id] || {};
    const m = new THREE.Matrix4();
    if (Array.isArray(over.transform) && over.transform.length === 16) m.fromArray(over.transform);
    else m.copy(c.local);
    const d = placement.decompose(m);

    const parentRow = el('div', 'frow');
    parentRow.appendChild(el('label', null, 'Parent'));
    const sel = document.createElement('select');
    sel.className = 'text-in';
    for (const opt of ['world', ...ctx.model.links]) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if ((c.link || over.parent || 'world') === opt) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => ctx.on.setPlacement(c.id, { parent: sel.value });
    parentRow.appendChild(sel);
    s.appendChild(parentRow);

    const mkXYZ = (labels, vals, apply) => {
      const g = el('div', 'xyz');
      labels.forEach((lb, i) => {
        const f = document.createElement('input');
        f.className = 'num-in';
        f.value = S.fmt(vals[i]);
        f.title = lb;
        f.setAttribute('aria-label', lb);
        f.onchange = () => { const v = parseFloat(f.value); if (Number.isFinite(v)) apply(i, v); };
        g.appendChild(f);
      });
      return g;
    };
    s.appendChild(el('div', 'sub', 'XYZ mm'));
    s.appendChild(mkXYZ(['X', 'Y', 'Z'], d.position, (i, v) => {
      const p = d.position.slice(); p[i] = v;
      ctx.on.setPlacement(c.id, { position: p });
    }));
    s.appendChild(el('div', 'sub', 'RPY °'));
    s.appendChild(mkXYZ(['Roll', 'Pitch', 'Yaw'], d.rotation, (i, v) => {
      const r = d.rotation.slice(); r[i] = v;
      ctx.on.setPlacement(c.id, { rotation: r });
    }));

    const modes = el('div', 'frow');
    modes.appendChild(el('label', null, 'Gizmo'));
    const seg = el('div', 'seg');
    for (const [mode, key, ico] of [['translate', 'w', 'move'], ['rotate', 'e', 'rotate']]) {
      const b = el('button');
      b.append(icon(ico, 'i14'));
      b.title = `${mode} · ${key}`;
      b.classList.toggle('on', ctx.gizmoMode() === mode);
      b.onclick = () => { ctx.on.gizmoMode(mode); S.render(); };
      seg.appendChild(b);
    }
    modes.appendChild(seg);
    const snapSel = document.createElement('select');
    snapSel.className = 'text-in';
    snapSel.style.width = '92px';
    GIZMO_SNAPS.mm.forEach((mm, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${mm} mm · ${GIZMO_SNAPS.deg[i]}°`;
      if (ctx.gizmoSnap() === i) o.selected = true;
      snapSel.appendChild(o);
    });
    snapSel.onchange = () => ctx.on.gizmoSnap(+snapSel.value);
    snapSel.title = 'Snap step · Shift = fine';
    modes.appendChild(snapSel);
    s.appendChild(modes);

    const acts = el('div', 'propchips');
    /* the deck is a PACKAGE frame, not a constant: an assembly-only import has none, so
       there is no "Drop to deck" for it */
    const deck = (() => { try { return placement.deckGrid(ctx.model); } catch (e) { return null; } })();
    for (const [label, action, title] of [
      ...(deck ? [['Drop to deck', 'deck', `Sit the part on the deck plate (Z ${Math.round(deck.z)})`]] : []),
      ['Drop to ground', 'ground', 'Sit the part on the floor'],
      ...(deck ? [['Snap to grid', 'grid', 'Snap XY to the deck hole grid']] : []),
      ['Center X', 'centerx', 'Put the part on the robot centreline']
    ]) {
      const b = el('button', 'btn sm', label);
      b.title = title;
      b.onclick = () => ctx.on.placementAction(c.id, action);
      acts.appendChild(b);
    }
    s.appendChild(acts);
    return true;
  }

  return { renderIdentity, renderRemoved, renderNotFitted, optionsSection, notFitted, placementSection };
}
