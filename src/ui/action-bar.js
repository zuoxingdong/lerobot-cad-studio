/* The action bar: a bottom-centre floating bar while something is selected — Stretch · Scale
   · Thicken · Mirror · Move · Options · Ask agent · ⋯ — one popover per op with a live preview
   (edited mesh + ghost), Enter applies, Esc cancels, and one verdict dot + the worst reason
   under the bar.  Mounted by ui/design-page.js; reaches the page through `page.<name>()`. */

import * as THREE from 'three';
import { icon } from './icons.js';
import { el } from './dom.js';
import { POPOVERS } from './op-popovers.js';
import { opsOf, REFUSED } from '../features/part-ops.js';
import { isRemoved, slotOwnerOf, slotOptions } from '../features/slot-options.js';
import { worstOf } from '../features/printcheck.js';
import { createOverlay } from '../scene/op-overlay.js';

const OPS = [['stretch', 'Stretch', 'stretch'], ['scale', 'Scale', 'scale'], ['thicken', 'Thicken', 'thicken'],
  ['mirror', 'Mirror', 'mirror'], ['move', 'Move', 'move']];
const WARN = { bolt_pattern: 'bolt pattern moves', mount_moves: 'mount face moves', beyond_face: 'more than the face moves',
  seam: 'seam kept', no_mount: 'no mount face' };
const DOT = { pass: 'ok', warn: 'warn', fail: 'err', unknown: '' };

export function mountActionBar(page) {
  const { store, model, canvasHost, viewport, gizmo, picking, ctx, actions } = page;
  const bar = el('div', 'opbar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Edit the selection');
  bar.hidden = true;
  const pop = el('div', 'oppop');
  pop.hidden = true;
  const btns = el('div', 'opbtns');
  const verdict = el('div', 'opverdict');
  bar.append(pop, btns, verdict);
  canvasHost.appendChild(bar);
  const overlay = createOverlay(viewport);

  let open = null;            // {kind, P, btn}
  let faceCb = null;
  let timer = null, checkTimer = null;
  const buttons = new Map();

  const keyOf = (id) => {
    const e = (store.getState().parts || {})[id];
    return e && e.copy_of ? id : page.partOps.designKey(id);
  };
  /** the selection that can take ops: fitted, not deleted, static geometry */
  function editable() {
    const st = store.getState();
    const unfit = ctx.unfitted();
    return ctx.selection().filter((id) => model.component(id) && model.component(id).geometry
      && !isRemoved(st, id) && !unfit.has(id));
  }
  const keys = () => [...new Set(editable().map(keyOf).filter(Boolean))];
  const worldRobot = (id) => (model._worldMatrix ? model._worldMatrix(id) : model.worldMatrix(id));

  function button(ico, label, fn, role) {
    const b = el('button', 'btn ghost');
    b.type = 'button';
    b.dataset.op = role;
    b.append(icon(ico, 'i'), el('span', 'tl', label));
    b.onclick = () => fn(b);
    btns.appendChild(b);
    buttons.set(role, b);
    return b;
  }
  for (const [kind, label, ico] of OPS) button(ico, label, (b) => toggle(kind, b), kind);
  btns.appendChild(el('span', 'opsep'));
  button('swap', 'Options', (b) => { cancel(); actions.swap(editable()[0], b); }, 'options');
  button('sparkle', 'Ask agent', () => askAgent(), 'ask');
  const more = button('dots-vertical', '', (b) => moreMenu(b), 'more');
  more.title = 'Frame · Hide · Isolate · Delete · Reset';
  more.setAttribute('aria-label', 'More');

  function askAgent() {
    cancel();
    if (page.openAgent) page.openAgent(editable());
  }

  function moreMenu(b) {
    const ids = ctx.selection();
    const st = store.getState();
    const edited = ids.some((id) => opsOf(st, keyOf(id)).length || ((st.components || {})[id] || {}).transform);
    page.openMenu(b, [
      { label: 'Frame', key: 'Z', run: () => actions.frame() },
      { label: 'Hide', run: () => ids.forEach((id) => actions.toggleVisible(id)) },
      { label: 'Isolate', key: 'I', run: () => actions.isolate(ids[0]) },
      { label: 'Delete', run: () => ctx.on.delete(ids) },
      { sep: true },
      { label: 'Reset', disabled: !edited, title: edited ? 'clear the changes of the selection' : 'nothing changed', run: () => ctx.on.resetOps(ids) },
      { label: 'Save as part…', disabled: ids.length !== 1, title: 'a part folder zip: part.json, mesh/, print/', run: () => ctx.on.savePart(ids[0]) },
    ]);
  }

  /* the popover */
  function api() {
    const primary = keyOf(editable()[0]);
    return {
      page, ctx, model, store, viewport, primary,
      keys, keyOf, worldRobot,
      geometryBefore: (k) => page.buildKey(k, opsOf(store.getState(), k)).geometry,
      mount: (k) => { const e = (store.getState().parts || {})[k]; return page.partOps.mount(e && e.copy_of ? e.copy_of : k); },
      update: schedule,
      overlay: {
        set: (children, id) => { overlay.set(children); overlay.follow(model.worldMatrix(id || primary)); },
        clear: () => overlay.clear(),
      },
      setHandles: (defs) => {
        const F = model.worldMatrix(primary);
        gizmo.setHandles(defs.map((d) => ({ ...d, frame: F })));
        gizmo.setHandlesVisible(true);
      },
      pickFace: (cb) => { faceCb = cb; },
      attachGizmo: (id) => {
        const c = model.component(id);
        if (!c || c.link || editable().length !== 1) return () => {};
        gizmo.attach(page.meshes.get(id));
        gizmo.setMode(store.get('ui.gizmo.mode', 'translate'));
        return () => page.syncSelection();
      },
    };
  }

  function toggle(kind, b) {
    if (open && open.kind === kind) { cancel(); return; }
    cancel();
    if (!keys().length && kind !== 'move') return;
    const P = POPOVERS[kind](api());
    open = { kind, P, btn: b };
    pop.innerHTML = '';
    const head = el('div', 'oph');
    head.append(el('span', 'n', P.title), el('div', 'sp'));
    const warnHost = el('div', 'opwarn');
    const foot = el('div', 'opfoot');
    const cancelBtn = el('button', 'btn sm', 'Cancel');
    cancelBtn.onclick = () => cancel();
    const applyBtn = el('button', 'btn sm accent', 'Apply');
    applyBtn.dataset.role = 'apply';
    applyBtn.title = 'Enter';
    applyBtn.onclick = () => apply();
    foot.append(el('div', 'sp'), cancelBtn, applyBtn);
    pop.append(head, P.el, warnHost, foot);
    open.applyBtn = applyBtn;
    open.warnHost = warnHost;
    pop.hidden = false;
    pop.dataset.open = kind;
    for (const [k, x] of buttons) x.classList.toggle('on', k === kind);
    if (P.focus) setTimeout(() => { try { P.focus.focus(); P.focus.select(); } catch (e) { /* detached */ } }, 0);
    setTimeout(keepInView, 0);
    schedule(0);
  }

  /** The selection's box on the canvas, CSS px: {x0, y0, x1, y1}, or null. */
  function selectionRect() {
    let r = null;
    const p = new THREE.Vector3();
    for (const id of editable()) {
      const g = model.component(id).geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox, W = model.worldMatrix(id);
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const s = viewport.worldToScreen(p.set(x, y, z).applyMatrix4(W), { frame: 'robot' });
        r = r ? { x0: Math.min(r.x0, s.x), y0: Math.min(r.y0, s.y), x1: Math.max(r.x1, s.x), y1: Math.max(r.y1, s.y) }
          : { x0: s.x, y0: s.y, x1: s.x, y1: s.y };
      }
    }
    return r;
  }

  /** The popover never hides the selection: pan the view until it sits above the popover. */
  function keepInView() {
    if (!open || pop.hidden) return;
    const sel = selectionRect();
    if (!sel) return;
    const cr = viewport.renderer.domElement.getBoundingClientRect(), pr = pop.getBoundingClientRect();
    const top = pr.top - cr.top, left = pr.left - cr.left, right = pr.right - cr.left;
    if (sel.x1 < left || sel.x0 > right || sel.y1 < top - 12 || sel.y1 - sel.y0 > 0.8 * top) return;
    const dy = Math.min(sel.y1 - (top - 24), sel.y0 - 8);
    if (!(dy > 0)) return;
    const cam = viewport.camera, target = viewport.controls.target;
    const id = editable()[0], g = model.component(id).geometry;
    const at = g.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(model.worldMatrix(id)).applyMatrix4(viewport.root.matrixWorld);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const shift = up.multiplyScalar(dy * viewport.mmPerPixel(at));
    const toRobot = viewport.qRoot.invert();
    viewport.moveCamera(cam.position.clone().sub(shift).applyQuaternion(toRobot), target.clone().sub(shift).applyQuaternion(toRobot), 200);
  }

  function schedule(ms = 120) {
    clearTimeout(timer);
    timer = setTimeout(runPreview, ms);
  }

  /** compute -> preview -> checks */
  function runPreview() {
    timer = null;
    if (!open) return;
    const { P } = open;
    const r = P.compute();
    if (P.onUpdate) P.onUpdate();
    open.warnHost.innerHTML = '';
    if (P.noPreview) { open.applyBtn.disabled = false; return; }
    if (r.error) { open.applyBtn.disabled = true; page.endPreview(false); paint('warn', r.error); return; }
    if (!r.entries || !r.entries.length) { open.applyBtn.disabled = true; page.endPreview(false); runChecks(); return; }
    const st = store.getState();
    const stacks = new Map(r.entries.map((e) => [e.key, [...opsOf(st, e.key), e.op]]));
    const res = page.setPreview(stacks);
    if (res.refused) {
      open.applyBtn.disabled = true;
      paint('warn', REFUSED[res.refused.reason] || res.refused.reason);
      return;
    }
    open.applyBtn.disabled = false;
    const seen = new Set();
    for (const w of res.warnings) {
      const k = w.code === 'carry' ? w.text : w.code;
      if (seen.has(k)) continue;
      seen.add(k);
      const chip = el('span', 'chip warn', WARN[w.code] || w.text || w.code);
      chip.title = w.text;
      open.warnHost.appendChild(chip);
    }
    runChecks(res.warnings[0] ? (WARN[res.warnings[0].code] || res.warnings[0].text) : null);
  }

  /** one verdict dot + the worst reason, for what is selected right now */
  function runChecks(warn) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = null;
      const ids = editable();
      if (!ids.length) { paint(null, ''); return; }
      const st = store.getState();
      const V = ctx.validator();
      const chips = [];
      ids.forEach((id, i) => {
        try {
          if (i === 0) chips.push(...V.validateComponent(st, id, { stages: ['print', 'cameras'], ctx: page.camCtx() }).chips);
          else {
            const pr = V.printOf(st, id);
            const bad = pr.chips.find((c) => !c.preview && c.level === 'fail') || pr.chips.find((c) => !c.preview && c.level === 'warn');
            chips.push(bad ? { level: bad.level, text: bad.name, tooltip: bad.detail } : { level: 'pass', text: 'print ok' });
          }
        } catch (e) { chips.push({ level: 'unknown', text: 'not checked' }); }
      });
      if (warn) chips.push({ level: 'warn', text: warn });
      const worst = worstOf(chips.filter((c) => c.level !== 'unknown').map((c) => ({ level: c.level })));
      const bad = chips.find((c) => c.level === worst && worst !== 'pass');
      paint(worst, bad ? (bad.tooltip && bad.tooltip.length < 70 ? bad.tooltip : bad.text) : 'checks pass');
    }, 120);
  }

  function paint(level, text) {
    verdict.innerHTML = '';
    verdict.dataset.level = level || '';
    if (!text) return;
    verdict.append(el('span', 'dot ' + (DOT[level] || '')), el('span', 't', text));
    verdict.title = text;
  }

  function apply() {
    if (!open) return false;
    clearTimeout(timer);
    const { P } = open;
    const r = P.compute();
    if (r.move) {
      const ids = editable();
      const c0 = model.component(ids[0]);
      const d = r.move.position.map((v, i) => v - c0.local.elements[12 + i]);
      ctx.on.setPlacement(ids[0], r.move);
      for (const id of ids.slice(1)) {
        const c = model.component(id);
        ctx.on.setPlacement(id, { position: [0, 1, 2].map((i) => c.local.elements[12 + i] + d[i]) });
      }
      close(false);
      return true;
    }
    if (r.error || !r.entries || !r.entries.length) { if (r.error) paint('warn', r.error); return false; }
    close(false, true);
    if (r.copy) ctx.on.mirrorCopy(r.entries);
    else if (!ctx.on.applyOps(r.entries)) return false;
    const said = store.history().past.slice(-1)[0] || 'applied';
    const cw = page.carry ? page.carry.warnings.filter((w) => r.entries.some((e) => e.key === w.key)) : [];
    page.setStatus(cw.length ? `${said} · ${cw[0].text}` : said, cw.length ? 'warn' : null);
    runChecks();
    return true;
  }

  function close(restore, keepPreview) {
    clearTimeout(timer); timer = null;
    if (!open) return;
    const { P } = open;
    open = null;
    faceCb = null;
    if (P.dispose) P.dispose();
    overlay.clear();
    page.refreshHandles();
    if (restore || !keepPreview) page.endPreview(!restore);
    pop.hidden = true;
    pop.innerHTML = '';
    for (const x of buttons.values()) x.classList.remove('on');
    runChecks();
  }
  const cancel = () => close(true);

  /* Enter applies, Esc cancels — from the popover fields or from anywhere while it is open */
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (e.target && e.target.tagName === 'INPUT' && e.target.onchange) e.target.onchange();
      apply();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  });
  const onKey = (e) => {
    if (!open || e.key !== 'Enter' || pop.contains(e.target)) return;
    const t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'BUTTON' || t === 'SELECT') return;
    e.preventDefault(); e.stopPropagation();
    apply();
  };
  window.addEventListener('keydown', onKey, true);

  picking.setIntercept((t) => {
    if (!open || !faceCb || !t || !t.object) return false;
    const key = keyOf(t.id);
    const point = t.object.worldToLocal(t.pointWorld.clone()).toArray();
    const normal = t.face ? t.face.normal.toArray() : null;
    if (!key || !normal) return false;
    return faceCb({ id: t.id, key, point, normal });
  });

  /** show/hide and enable per the selection */
  function render() {
    const sel = editable();
    const show = sel.length > 0 && !page.lookId;
    if (!show && open) cancel();
    bar.hidden = !show;
    if (!show) { paint(null, ''); return; }
    const n = keys().length;
    for (const [kind] of OPS) {
      const b = buttons.get(kind);
      let why = '';
      if (kind !== 'move' && !n) why = 'nothing editable selected';
      else if (kind === 'thicken' && n > 1) why = 'one part at a time';
      b.disabled = !!why;
      b.title = why || b.querySelector('.tl').textContent;
    }
    const sid = slotOwnerOf(model, page.slots, sel[0]);
    const nOpt = sid ? slotOptions(model, page.slots, store.getState(), sid, sel[0]).length : 0;
    buttons.get('options').disabled = nOpt < 2;
    buttons.get('options').title = nOpt < 2 ? 'no other options for this slot' : `${nOpt} options`;
    buttons.get('ask').disabled = !sid;
    buttons.get('ask').title = sid ? 'ask an AI agent for a new option' : 'not in a slot';
    fit();
    if (!open) runChecks();
  }

  /* keep the bar off the 128 px axis gizmo: centre it left of it, drop two labels, else lift it */
  const GIZMO = 128;
  function fit() {
    const W = canvasHost.clientWidth;
    if (!W || bar.hidden) return;
    const room = () => W - GIZMO - 16 - btns.offsetWidth;
    bar.classList.remove('compact', 'lift');
    if (room() < 0) bar.classList.add('compact');
    if (room() < 0) bar.classList.add('lift');
  }
  const offResize = viewport.onResize ? viewport.onResize(() => fit()) : null;

  function onSelection() { if (open) cancel(); render(); }

  return {
    el: bar, render, onSelection, apply, escape: () => { if (!open) return false; cancel(); return true; },
    open: (kind) => toggle(kind, buttons.get(kind)),
    get current() { return open ? open.kind : null; },
    get verdict() { return { level: verdict.dataset.level || null, text: verdict.textContent }; },
    destroy() {
      cancel(); clearTimeout(checkTimer);
      if (offResize) offResize();
      window.removeEventListener('keydown', onKey, true); picking.setIntercept(null); overlay.dispose(); bar.remove();
    },
  };
}
