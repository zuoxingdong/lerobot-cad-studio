/* The five op popovers of the action bar: Stretch, Scale, Thicken, Mirror, Move.  Each builds
   its fields (mm / % / ° only) and answers `compute()` -> {entries:[{key, op}], error?, note?,
   copy?}; the bar owns preview, checks, Enter and Esc.  Needs features/ops.js. */

import * as THREE from 'three';
import { el } from './dom.js';
import { stretchAxes, stretchGate, defaultAxis, transformOps, SCAN_STEP_MM } from '../features/ops.js';
import { cutPlane, faceMarker } from '../scene/op-overlay.js';

const AX = ['X', 'Y', 'Z'];
const r1 = (v) => Math.round(v * 10) / 10;
const fmt = (v) => { const x = r1(v); return Number.isInteger(x) ? String(x) : x.toFixed(1); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** "12,5" and "12.5" both read 12.5; anything else is NaN */
export function parseNum(text) {
  let t = String(text == null ? '' : text).trim().replace(/[\s ']/g, '').replace(/^−/, '-');
  if (!t) return NaN;
  const comma = t.lastIndexOf(','), dotAt = t.lastIndexOf('.');
  if (comma >= 0 && dotAt >= 0) t = comma > dotAt ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (comma >= 0) t = (t.match(/,/g) || []).length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t) ? parseFloat(t) : NaN;
}

/** one labelled number field; `onSet(v)` on change, arrow keys nudge by `step` */
function numRow(label, value, unit, onSet, o = {}) {
  const row = el('div', 'oprow');
  const inp = el('input', 'num-in');
  inp.type = 'text';
  inp.inputMode = 'decimal';
  inp.value = fmt(value);
  inp.setAttribute('aria-label', label);
  if (o.role) inp.dataset.role = o.role;
  const set = (v) => { inp.value = fmt(v); inp.classList.remove('bad'); onSet(v); };
  inp.onchange = () => { const v = parseNum(inp.value); if (!Number.isFinite(v)) { inp.classList.add('bad'); return; } set(v); };
  inp.oninput = () => { const v = parseNum(inp.value); if (Number.isFinite(v)) { inp.classList.remove('bad'); onSet(v, true); } };
  inp.onkeydown = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const v = parseNum(inp.value);
    set((Number.isFinite(v) ? v : 0) + (e.key === 'ArrowUp' ? 1 : -1) * (o.step || 1) * (e.shiftKey ? 10 : 1));
  };
  row.append(el('span', 'k', label), inp, el('span', 'u', unit));
  if (o.hint) row.appendChild(el('span', 'hint', o.hint));
  return { row, inp, set: (v) => { inp.value = fmt(v); } };
}

/** a segmented choice; `items` [{id, label, title?, disabled?}] */
function seg(items, value, onPick, role) {
  const s = el('div', 'seg');
  if (role) s.dataset.role = role;
  const btns = new Map();
  for (const it of items) {
    const b = el('button', null, it.label);
    b.type = 'button';
    b.dataset.id = it.id;
    if (it.title) b.title = it.title;
    b.disabled = !!it.disabled;
    b.onclick = () => { for (const [k, x] of btns) x.classList.toggle('on', k === it.id); onPick(it.id); };
    btns.set(it.id, b);
    s.appendChild(b);
  }
  if (btns.get(value)) btns.get(value).classList.add('on');
  return s;
}

/* Stretch: axis auto/X/Y/Z, cut position (a plane in the viewport), change ± mm */
export function stretchPopover(A) {
  const key = A.keyOf(A.primary);
  const geo = A.geometryBefore(key);
  const mount = A.mount(key);
  if (!geo.boundingBox) geo.computeBoundingBox();
  const s = { choice: 'auto', axis: null, at: 0, by: 0, note: null, error: null };
  const axesFor = (by) => stretchAxes(geo, { mount, by });
  let axes = axesFor(-1);
  const pickAxis = (choice) => {
    s.choice = choice;
    if (choice === 'auto') { s.axis = axes.length ? axes[0].axis : defaultAxis(geo, mount); s.at = axes.length ? axes[0].at : null; }
    else {
      const i = AX.indexOf(choice);
      const hit = axes.find((a) => Math.abs(Math.abs(a.axis[i]) - 1) < 1e-9);
      s.axis = hit ? hit.axis : [0, 0, 0].map((_, k) => (k === i ? 1 : 0));
      s.at = hit ? hit.at : null;
    }
    s.error = s.at === null ? 'no clean plane on this axis' : null;
  };
  pickAxis('auto');
  const base = () => (mount ? dot(s.axis, mount.point) : 0);
  const items = [{ id: 'auto', label: 'Auto' }].concat(AX.map((n, i) => {
    const ok = axes.some((a) => Math.abs(Math.abs(a.axis[i]) - 1) < 1e-9);
    return { id: n, label: n, disabled: !ok, title: ok ? `stretch along ${n}` : 'no clean plane on this axis' };
  }));
  const axisSeg = seg(items, 'auto', (id) => { pickAxis(id); cut.set(s.at === null ? 0 : s.at - base()); regate(); A.update(); }, 'axis');
  const cut = numRow('Cut at', s.at === null ? 0 : s.at - base(), mount ? 'mm from mount' : 'mm', (v) => { s.at = v + base(); regate(); A.update(); }, { role: 'cut', step: SCAN_STEP_MM });
  const change = numRow('Change', 0, 'mm', (v, typing) => { s.by = v; if (!typing) regate(); A.update(); }, { role: 'change' });

  /* the gate: snap onto the nearest clean plane, or say there is none */
  function regate() {
    s.note = null;
    if (s.at === null) { s.error = 'no clean plane on this axis'; return; }
    const g = stretchGate(geo, s.axis, s.at, { by: s.by, mount });
    if (g.ok) { s.error = null; return; }
    if (g.nearest) { s.at = g.nearest.at; s.error = null; s.note = 'snapped to a clean plane'; cut.set(s.at - base()); return; }
    s.error = g.reason === 'mount' ? 'too close to the mount face' : 'no clean plane on this axis';
  }

  /* viewport: the cut plane + two handles (plane position, free-end arrow) */
  function drawHandles() {
    if (s.at === null) { A.overlay.clear(); A.setHandles([]); return; }
    const b = geo.boundingBox;
    const c = b.getCenter(new THREE.Vector3()).toArray();
    const onPlane = c.map((x, i) => x + s.axis[i] * (s.at - dot(c, s.axis)));
    let far = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) far = Math.max(far, dot([x, y, z], s.axis));
    const tip = onPlane.map((x, i) => x + s.axis[i] * (far + s.by - s.at));
    A.overlay.set([cutPlane(A.viewport, b, s.axis, s.at)]);
    A.setHandles([
      { id: 'cut', kind: 'translate', anchor: onPlane, axis: s.axis, value: s.at, step: SCAN_STEP_MM,
        onDrag: (v) => { s.at = v; cut.set(v - base()); A.overlay.set([cutPlane(A.viewport, b, s.axis, v)]); },
        onCommit: (v) => { s.at = v; regate(); drawHandles(); A.update(); } },
      { id: 'change', kind: 'translate', anchor: tip, axis: s.axis, value: s.by, step: 0.5,
        onDrag: (v) => { s.by = v; change.set(v); A.update(); },
        onCommit: (v) => { s.by = v; regate(); drawHandles(); A.update(); } },
    ]);
  }

  const noteEl = el('div', 'opnote');
  const body = el('div', 'opbody');
  body.append(el('div', 'oprow', null), cut.row, change.row, noteEl);
  body.firstChild.append(el('span', 'k', 'Axis'), axisSeg);
  if (s.error) cut.inp.disabled = true;
  return {
    title: 'Stretch', el: body, focus: change.inp,
    onUpdate: () => { noteEl.textContent = s.error || s.note || ''; noteEl.className = 'opnote' + (s.error ? ' err' : ''); cut.inp.disabled = s.at === null; drawHandles(); },
    compute() {
      if (s.error) return { error: s.error };
      if (!s.by) return { entries: [] };
      const op = { op: 'stretch', axis: s.axis.slice(), at: s.at, by: s.by };
      const Wp = A.worldRobot(A.primary);
      const entries = A.keys().map((k) => {
        if (k === key) return { key: k, op };
        const M = A.worldRobot(k).clone().invert().multiply(Wp);
        return { key: k, op: transformOps([op], M)[0] };
      });
      return { entries, note: s.note };
    },
  };
}

/* Scale: uniform % or per-axis %, pivot mount face / centre */
export function scalePopover(A) {
  const s = { mode: 'uniform', pct: 100, f: [100, 100, 100], about: A.mount(A.keyOf(A.primary)) ? 'mount' : 'center' };
  const u = numRow('Scale', 100, '%', (v) => { s.pct = v; A.update(); }, { role: 'pct' });
  const per = AX.map((n, i) => numRow(n, 100, '%', (v) => { s.f[i] = v; A.update(); }, { role: 'pct-' + n.toLowerCase() }));
  const perBox = el('div', 'opcols');
  perBox.append(...per.map((p) => p.row));
  perBox.hidden = true;
  const modeSeg = seg([{ id: 'uniform', label: 'Uniform' }, { id: 'axis', label: 'Per axis' }], 'uniform',
    (id) => { s.mode = id; u.row.hidden = id !== 'uniform'; perBox.hidden = id === 'uniform'; A.update(); }, 'mode');
  const hasMount = A.keys().some((k) => A.mount(k));
  const pivot = seg([{ id: 'mount', label: 'Mount face', disabled: !hasMount, title: hasMount ? 'the mount face stays put' : 'no mount face' },
    { id: 'center', label: 'Centre' }], s.about, (id) => { s.about = id; A.update(); }, 'pivot');
  const body = el('div', 'opbody');
  const r0 = el('div', 'oprow'); r0.append(el('span', 'k', 'Mode'), modeSeg);
  const r1x = el('div', 'oprow'); r1x.append(el('span', 'k', 'Pivot'), pivot);
  body.append(r0, u.row, perBox, r1x);
  return {
    title: 'Scale', el: body, focus: u.inp,
    compute() {
      const f = s.mode === 'uniform' ? [s.pct, s.pct, s.pct] : s.f;
      if (!f.every((x) => x > 0)) return { error: 'scale must be above 0 %' };
      if (f.every((x) => Math.abs(x - 100) < 1e-9)) return { entries: [] };
      const entries = A.keys().map((k) => {
        const g = A.geometryBefore(k);
        if (!g.boundingBox) g.computeBoundingBox();
        const about = s.about === 'mount' && A.mount(k) ? 'mount' : g.boundingBox.getCenter(new THREE.Vector3()).toArray();
        const op = s.mode === 'uniform' ? { op: 'scale', s: s.pct / 100, about } : { op: 'scale', factors: f.map((x) => x / 100), about };
        return { key: k, op };
      });
      return { entries };
    },
  };
}

/* Thicken: pick a face in the viewport, ± mm */
export function thickenPopover(A) {
  const s = { seed: null, key: null, by: 2 };
  const by = numRow('Offset', 2, 'mm', (v) => { s.by = v; A.update(); }, { role: 'offset', step: 0.5 });
  const hint = el('div', 'opnote', 'click a flat face');
  const body = el('div', 'opbody');
  body.append(hint, by.row);
  A.pickFace((hit) => {
    if (!A.keys().includes(hit.key)) return false;
    s.seed = { point: hit.point, normal: hit.normal };
    s.key = hit.key;
    hint.textContent = 'face picked';
    A.overlay.set([faceMarker(A.viewport, hit.point, hit.normal)], hit.id);
    A.update();
    return true;
  });
  return {
    title: 'Thicken', el: body, focus: by.inp,
    compute() {
      if (!s.seed) return { error: 'click a flat face on the part' };
      if (!s.by) return { entries: [] };
      return { entries: [{ key: s.key, op: { op: 'offset_face', seed: s.seed, by: s.by } }] };
    },
  };
}

/* Mirror: in place (the part's own left/right mid-plane), across the robot (X = 0) or a part
   plane; "keep original" makes a copy under Imported */
export function mirrorPopover(A) {
  const boxOf = (k) => {
    const g = A.geometryBefore(k);
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox;
  };
  /* a part off the robot centre mirrors in place by default */
  const wb = boxOf(A.primary).clone().applyMatrix4(A.worldRobot(A.primary));
  const s = { plane: wb.min.x > 1e-6 || wb.max.x < -1e-6 ? 'self' : 'robot', keep: false };
  const planeSeg = seg([{ id: 'self', label: 'In place', title: 'a left/right version where it is: the plane through its own centre' },
    { id: 'robot', label: 'Across the robot', title: 'the robot mid-plane X = 0' },
    { id: 'X', label: 'X', title: 'the part plane normal to its X' }, { id: 'Y', label: 'Y', title: 'the part plane normal to its Y' },
    { id: 'Z', label: 'Z', title: 'the part plane normal to its Z' }], s.plane,
  (id) => { s.plane = id; A.update(); }, 'plane');
  const keep = el('label', 'chk');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.role = 'keep';
  cb.onchange = () => { s.keep = cb.checked; A.update(); };
  keep.append(cb, el('i'), document.createTextNode('keep original'));
  keep.title = 'the mirrored part becomes a copy under Imported';
  const body = el('div', 'opbody');
  const r0 = el('div', 'oprow'); r0.append(el('span', 'k', 'Plane'), planeSeg);
  body.append(r0, keep);
  return {
    title: 'Mirror', el: body,
    compute() {
      const entries = A.keys().map((k) => {
        const Wi = A.worldRobot(k).clone().invert();
        const centre = boxOf(k).getCenter(new THREE.Vector3()).toArray();
        const robotX = new THREE.Vector3(1, 0, 0).transformDirection(Wi).toArray();
        let plane;
        if (s.plane === 'robot') plane = { point: new THREE.Vector3(0, 0, 0).applyMatrix4(Wi).toArray(), normal: robotX };
        else if (s.plane === 'self') plane = { point: centre, normal: robotX };
        else plane = { point: centre, normal: [0, 1, 2].map((j) => (j === AX.indexOf(s.plane) ? 1 : 0)) };
        return { key: k, op: { op: 'mirror', plane } };
      });
      return { entries, copy: s.keep };
    },
  };
}

/* Move / rotate: numeric XYZ (mm) + RPY (°) of the part's placement, snap, the gizmo */
export function movePopover(A) {
  const id = A.primary;
  const c = A.model.component(id);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  c.local.decompose(p, q, sc);
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const s = { pos: p.toArray(), rot: [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI), dirty: false };
  const rows = [
    ...AX.map((n, i) => numRow(n, s.pos[i], 'mm', (v) => { s.pos[i] = v; s.dirty = true; }, { role: 'pos-' + n.toLowerCase() })),
    ...['Roll', 'Pitch', 'Yaw'].map((n, i) => numRow(n, s.rot[i], '°', (v) => { s.rot[i] = v; s.dirty = true; }, { role: 'rot-' + i, step: 15 })),
  ];
  const cols = el('div', 'opcols');
  cols.append(...rows.map((r) => r.row));
  const snap = seg([{ id: '0', label: '1 mm · 5°' }, { id: '1', label: '5 mm · 15°' }, { id: '2', label: '20 mm · 90°' }],
    String(A.ctx.gizmoSnap()), (v) => A.ctx.on.gizmoSnap(+v), 'snap');
  const body = el('div', 'opbody');
  const r0 = el('div', 'oprow'); r0.append(el('span', 'k', 'Snap'), snap);
  body.append(cols, r0);
  const detach = A.attachGizmo(id);
  return {
    title: 'Move', el: body, focus: rows[0].inp, noPreview: true,
    dispose: detach,
    compute() { return { entries: [], move: s.dirty ? { position: s.pos.slice(), rotation: s.rot.slice() } : null }; },
  };
}

export const POPOVERS = { stretch: stretchPopover, scale: scalePopover, thicken: thickenPopover, mirror: mirrorPopover, move: movePopover };
