/* The camera tiles of the Check tab: one 4:3 tile per robot camera in a fixed neutral
   environment, a verdict dot and the worst reason, enlarge, look-through, and a ⋯ menu with
   Lens… and Calibrate tilt….  "Designed / Measured" shows only once a tilt is measured.
   Tiles paint only while visible; `forceTick()` measures regardless. */

import * as THREE from 'three';
import { icon } from './icons.js';
import { verdict } from '../features/cameras.js';
import { cameraFamily, DOT } from '../features/verdict.js';
import { CAM_COLOR, letterbox } from './design-helpers.js';
import { openLensDialog, openCalibDialog } from './cameras-calib.js';
import { el } from './dom.js';

const TICK_MS = 160;                       // ~6 Hz
const PIP_MIN = 120, PIP_MAX = 512, BIG_MAX = 760;

export function mountCameras(host, ctx) {
  const panel = el('section', 'camtiles');
  panel.setAttribute('aria-label', 'Cameras');
  const head = el('div', 'camhead');
  const calSeg = el('div', 'seg');
  const segBtns = new Map();
  for (const [mode, label] of [['design', 'Designed'], ['installed', 'Measured']]) {
    const b = el('button', null, label);
    b.type = 'button';
    b.onclick = () => setCalib(mode);
    calSeg.appendChild(b);
    segBtns.set(mode, b);
  }
  head.append(el('span', 'h', 'Cameras'), el('div', 'sp'), calSeg);
  const stack = el('div', 'tiles');
  panel.append(head, stack);
  host.appendChild(panel);

  const ids = ctx.cams.ids.slice();
  const rec = new Map();
  const evals = new Map();
  let calibMode = (ctx.store.get('ui.cameras') || {}).calib === 'installed' ? 'installed' : 'design';
  let enlarged = null, looking = null, overlay = null, lastTick = 0, disposed = false;

  if (!ids.length) stack.appendChild(el('p', 'nocams', 'no cameras'));
  for (const id of ids) stack.appendChild(buildTile(id));

  function buildTile(id) {
    const cam = ctx.cams.get(id);
    const name = cam ? cam.label || id : id;
    const tile = el('figure', 'tile');
    tile.dataset.cam = id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', name + ' camera');
    const th = el('div', 'th');
    const cdot = el('span', 'cdot');
    cdot.style.background = `var(${CAM_COLOR[id] || '--ink-3'})`;
    const nm = el('span', 'n', name);
    const vdot = el('span', 'dot');
    const look = el('button', 'iconbtn');
    look.append(icon('eye', 'i14'));
    look.title = 'Look through';
    look.setAttribute('aria-label', 'Look through');
    look.onclick = (e) => { e.stopPropagation(); toggleLook(id); };
    const menu = el('button', 'iconbtn');
    menu.append(icon('dots-vertical', 'i14'));
    menu.title = 'Lens · calibrate';
    menu.setAttribute('aria-label', 'Camera menu');
    menu.onclick = (e) => { e.stopPropagation(); ctx.on.menu(menu, camMenu(id)); };
    th.append(cdot, nm, vdot, el('div', 'sp'), look, menu);
    const pic = el('div', 'pic');
    const cv = document.createElement('canvas');
    cv.height = PIP_MIN; cv.width = Math.round(PIP_MIN * 4 / 3);
    const calChip = el('span', 'calchip');
    const none = el('div', 'nomount');
    none.hidden = true;
    pic.append(cv, calChip, none);
    const ft = el('figcaption', 'ft');
    tile.append(th, pic, ft);
    tile.onclick = () => toggleEnlarge(id);
    tile.ondblclick = () => toggleLook(id);
    tile.onkeydown = (e) => {
      if (e.target !== tile) return;
      if (e.key === 'Enter') { e.preventDefault(); toggleEnlarge(id); } else if (e.key === ' ') { e.preventDefault(); toggleLook(id); }
    };
    rec.set(id, { tile, cv, ctx2d: cv.getContext('2d'), target: null, pixels: null, ft, pic, calChip, vdot, none });
    return tile;
  }

  function camMenu(id) {
    return [
      { label: 'Lens…', run: () => openLensDialog({ cams: ctx.cams, store: ctx.store, model: ctx.model, id, done: changed }) },
      { label: 'Calibrate tilt…', run: () => calibrate(id) },
      { sep: true },
      { label: 'Look through', run: () => toggleLook(id) },
      { label: 'Reset to package default', run: () => {
        ctx.cams.reset(id); ctx.cams.resetCalib(id);
        ctx.store.remove('cameras.' + id, { label: 'camera default' });
        changed();
      } },
    ];
  }
  function calibrate(id) {
    return openCalibDialog({ cams: ctx.cams, store: ctx.store, ids, id,
      label: (ctx.cams.get(id) || {}).label || id,
      mode: () => calibMode, setMode: (m, o) => setCalib(m, o), setValue: (cid, v) => api.setCalibValue(cid, v),
      status: ctx.on.status, refresh: () => { render(); forceTick(); } });
  }
  function changed() { ctx.on.camerasChanged(); render(); forceTick(); }

  const measured = (id) => ctx.cams.hasCalib(id) || !!(((ctx.store.getState().cameras || {})[id] || {}).calib);
  /** `force`: the clear path, when nothing is measured any more */
  function setCalib(mode, o = {}) {
    if (!o.force && mode === 'installed' && !ids.some(measured)) return;
    calibMode = mode === 'installed' ? 'installed' : 'design';
    ctx.store.set('ui.cameras', { ...(ctx.store.get('ui.cameras') || {}), calib: calibMode });
    ctx.cams.setCalibMode(calibMode);
    ctx.on.calibChanged(calibMode);
    render();
    forceTick();
  }

  /* enlarge and look-through */
  const bigBar = el('div', 'bigbar');
  const btn = (ico, text, title, fn) => {
    const b = el('button', 'btn sm');
    b.type = 'button';
    b.append(icon(ico, 'i14'));
    if (text) b.append(document.createTextNode(text));
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = fn;
    return b;
  };
  const prevBtn = btn('chevron-left', '', 'Previous camera', () => step(-1));
  const nextBtn = btn('chevron-right', '', 'Next camera', () => step(1));
  const lookBtn = btn('eye', 'Look through', 'Look through · Esc returns', () => toggleLook(enlarged));
  const backBtn = btn('close', '', 'All cameras · Esc', () => toggleEnlarge(null));
  bigBar.append(prevBtn, nextBtn, el('div', 'sp'), lookBtn, backBtn);

  function toggleEnlarge(id) {
    enlarged = id && enlarged !== id ? id : null;
    panel.classList.toggle('big', !!enlarged);
    stack.innerHTML = '';
    if (enlarged) { stack.appendChild(rec.get(enlarged).tile); panel.appendChild(bigBar); } else {
      bigBar.remove();
      for (const x of ids) stack.appendChild(rec.get(x).tile);
    }
    render();
    forceTick();
  }
  function step(d) {
    if (!enlarged) return;
    const i = ids.indexOf(enlarged);
    toggleEnlarge(ids[(i + d + ids.length) % ids.length]);
  }
  /** Esc unwinds one layer: look-through, then enlarged */
  function restore() {
    if (looking) { toggleLook(null); return true; }
    if (enlarged) { toggleEnlarge(null); return true; }
    return false;
  }
  function toggleLook(id) {
    looking = id && looking !== id ? id : null;
    if (overlay) { overlay.remove(); overlay = null; }
    if (looking) {
      const cam = ctx.cams.get(looking);
      overlay = el('div', 'lookhud');
      overlay.dataset.cam = looking;
      const d = el('span', 'cdot');
      d.style.background = `var(${CAM_COLOR[looking] || '--ink-3'})`;
      const exit = btn('close', 'Exit', 'Back · Esc', () => toggleLook(null));
      overlay._chips = el('span', 'chips');
      overlay.append(d, el('span', 'n', cam ? cam.label || looking : looking), overlay._chips, el('div', 'sp'), exit);
    }
    ctx.on.lookThrough(looking, overlay);
    render();
    forceTick();
    return looking;
  }

  /* paint + measure */
  const visible = () => !!panel.offsetParent;
  const mounted = (id) => { try { const p = ctx.cams.getPose(id, {}); return !!(p && p.ok); } catch (e) { return false; } };
  /* shown: paint and measure at ~6 Hz; hidden: measure only, at ~2 Hz */
  function tick(now, force) {
    if (disposed) return;
    const paint = visible();
    if (!force && now - lastTick < (paint ? TICK_MS : 500)) return;
    lastTick = now;
    const evalCtx = ctx.camCtx() || {};
    const run = () => {
      for (const id of ids) {
        const r = rec.get(id);
        if (!r || ctx.store.get('cameras.' + id + '.enabled') === false || !mounted(id)) continue;
        if (paint && r.tile.isConnected) paintPip(id, r);
        try { evals.set(id, ctx.cams.evaluate(id, evalCtx, { width: 96, height: 72 })); } catch (e) { /* GL lost */ }
      }
    };
    run();
    paintVerdicts();
  }
  function forceTick() { tick(1e9, true); }

  function paintPip(id, r) {
    const cam = ctx.cams.get(id);
    const a = cam && cam.aspect > 0 ? cam.aspect : 4 / 3;
    const dpr = ctx.viewport.renderer.getPixelRatio ? (ctx.viewport.renderer.getPixelRatio() || 1) : 1;
    const drawn = letterbox(r.pic.clientWidth || 240, r.pic.clientHeight || 180, a);
    const h = Math.max(PIP_MIN, Math.min(enlarged === id ? BIG_MAX : PIP_MAX, Math.round(drawn.h * dpr)));
    const w = Math.max(16, Math.round(h * a));
    if (!r.target || r.target.width !== w || r.target.height !== h) {
      if (r.target) r.target.dispose();
      r.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
      r.cv.width = w; r.cv.height = h;
      r.pixels = null;
    }
    try {
      ctx.frustums.renderPip(id, r.target);
      const px = r.pixels && r.pixels.length === w * h * 4 ? r.pixels : (r.pixels = new Uint8Array(w * h * 4));
      ctx.viewport.renderer.readRenderTargetPixels(r.target, 0, 0, w, h, px);
      const img = r.ctx2d.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      r.ctx2d.putImageData(img, 0, 0);
    } catch (e) { /* no GL yet */ }
  }

  function paintVerdicts() {
    for (const id of ids) {
      const r = rec.get(id);
      const ev = mounted(id) ? evals.get(id) : null;
      if (!mounted(id)) evals.delete(id);
      if (!ev) { r.vdot.className = 'dot unk'; r.ft.textContent = ''; continue; }
      const v = verdict(ev, { warn: ctx.cams.warn });
      const f = cameraFamily(v);
      r.vdot.className = 'dot ' + DOT[f.level];
      r.vdot.title = v.text;
      r.ft.textContent = v.chips.filter((c) => c.key !== 'ok').map((c) => c.text).slice(0, 2).join(' · ');
      r.ft.title = v.text;
      if (overlay && overlay.dataset.cam === id) overlay._chips.textContent = r.ft.textContent;
    }
  }

  /* the tile width that fits the most picture: 1, 2 or 3 columns inside the panel */
  const CHROME_H = 56, GAP = 8;
  function layoutTiles() {
    const W = stack.clientWidth, H = stack.clientHeight;
    const n = enlarged ? 1 : ids.filter((id) => !rec.get(id).tile.hidden).length;
    if (!W || !H || !n) return;
    let best = { cols: Math.min(3, n), w: 0 };
    for (let cols = 1; cols <= Math.min(3, n); cols++) {
      const rows = Math.ceil(n / cols);
      const byW = (W - (cols - 1) * GAP) / cols;
      const byH = ((H - (rows - 1) * GAP) / rows - CHROME_H) / 0.75;
      const w = Math.floor(Math.min(byW, byH));
      if (w > best.w) best = { cols, w };
    }
    stack.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.max(140, best.w)}px)`;
  }

  function render() {
    layoutTiles();
    const any = ids.some(measured);
    if (calibMode === 'installed' && ids.length && !any) {
      calibMode = 'design';
      ctx.store.set('ui.cameras', { ...(ctx.store.get('ui.cameras') || {}), calib: 'design' });
      ctx.cams.setCalibMode('design');
      ctx.on.calibChanged('design');
    }
    calSeg.hidden = !any;
    for (const [m, b] of segBtns) { b.classList.toggle('on', calibMode === m); b.setAttribute('aria-pressed', String(calibMode === m)); }
    for (const id of ids) {
      const r = rec.get(id);
      const on = mounted(id);
      r.none.hidden = on;
      r.none.textContent = on ? '' : 'no camera on this mount';
      r.tile.classList.toggle('unmounted', !on);
      r.tile.hidden = on && ctx.store.get('cameras.' + id + '.enabled') === false;
      r.tile.classList.toggle('on', looking === id);
      const has = on && ctx.cams.hasCalib(id);
      r.calChip.hidden = !has;
      if (has) {
        const t = ctx.cams.getCalib(id).tilt_deg;
        r.calChip.textContent = (calibMode === 'installed' ? 'measured ' : 'designed · ') + (t > 0 ? '+' : '') + (Math.round(t * 10) / 10) + '°';
      }
    }
    prevBtn.disabled = nextBtn.disabled = ids.length < 2;
    lookBtn.classList.toggle('on', !!looking && looking === enlarged);
  }

  ctx.cams.setCalibMode(calibMode);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { render(); lastTick = 0; }) : null;
  if (ro) ro.observe(panel);
  render();

  const api = {
    el: panel, render, tick, forceTick, restore, calibrate,
    get enlarged() { return enlarged; },
    get looking() { return looking; },
    get state() { return { calib: calibMode }; },
    lookThrough: toggleLook,
    enlarge: toggleEnlarge,
    setCalibMode: setCalib,
    /** a measured offset is DESIGN state and never touches a part parameter */
    setCalibValue(id, calib) {
      const v = ctx.cams.setCalib(id, calib);
      if (v) ctx.store.set(['cameras', id, 'calib'], { ...v }, { label: 'camera calibration' });
      ctx.on.calibChanged(calibMode);
      render();
      forceTick();
      return v;
    },
    evaluation: (id) => { if (!evals.has(id) && mounted(id)) forceTick(); return evals.get(id) || null; },
    verdicts: () => {
      if (!evals.size && ids.some(mounted)) forceTick();
      const o = {};
      for (const [k, v] of evals) o[k] = verdict(v, { warn: ctx.cams.warn });
      return o;
    },
    destroy() {
      disposed = true;
      if (ro) ro.disconnect();
      if (overlay) { overlay.remove(); overlay = null; }
      for (const r of rec.values()) if (r.target) r.target.dispose();
      panel.remove();
    },
  };
  return api;
}
