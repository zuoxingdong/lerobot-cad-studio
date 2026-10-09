/* The Sim tab's camera feeds: FRONT, WRIST, TOP at their own aspect, in a column docked on the
   viewport's right edge or in a 2×2 grid whose 4th cell is the main view.  Each is drawn by the
   frustums' PiP renderer at its on-screen size × the pixel ratio; a click enlarges one over the
   view.  Layout and Hide are kept per session. */

import * as THREE from 'three';
import { el } from './dom.js';
import { icon } from './icons.js';
import { CAM_COLOR, letterbox } from './design-helpers.js';

const ORDER = ['front', 'wrist', 'top'];
const KEY = 'rps/sim-cams@1';
const MIN_W = 260, MAX_W = 420, SHARE = 0.28, HEAD = 34, PAD = 8, GAP = 8;
const NARROW = 1200;                       // below this window width the feeds start hidden
const MAX_PX = 1600;                       // longest side of a feed's render target

function load() { try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch (e) { return null; } }
function save(s) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* no storage */ } }

function slot(id, cls) {
  const pic = el('div', 'sim-pic ' + cls);
  const cv = document.createElement('canvas');
  const tag = el('span', 'sim-tag');
  const dot = el('i');
  dot.style.background = `var(${CAM_COLOR[id] || '--ink-3'})`;
  tag.append(dot, document.createTextNode(id));
  pic.append(cv, tag);
  return { id, pic, cv, c2d: cv.getContext('2d'), target: null, px: null, img: null };
}

export function mountSimCams({ stage, canvasHost, canvas, viewport, frustums, cams, onLayout }) {
  const saved = load();
  const st = {
    hidden: saved ? !!saved.hidden : (globalThis.innerWidth || 1600) < NARROW,
    layout: saved && saved.layout === 'grid' ? 'grid' : 'column',
  };
  const col = el('aside', 'sim-camcol');
  col.setAttribute('aria-label', 'Camera feeds');
  const head = el('div', 'sim-camhead');
  const lay = el('div', 'seg');
  const bCol = el('button', null, 'Column'), bGrid = el('button', null, 'Grid');
  lay.append(bCol, bGrid);
  const bHide = el('button', 'btn sm ghost', 'Hide');
  head.append(el('span', 'micro', 'Cameras'), el('span', 'sp'), lay, bHide);
  const list = el('div', 'sim-tiles');
  col.append(head, list);
  const bShow = el('button', 'btn sm sim-camshow');
  bShow.append(icon('camera', 'i14'), document.createTextNode('Show'));
  bShow.title = 'Show the camera feeds';
  bShow.setAttribute('aria-label', 'Show cameras');

  const aspectOf = (id) => { const c = cams.get(id); return c && c.aspect > 0 ? c.aspect : 4 / 3; };
  const feeds = ORDER.filter((id) => cams.ids.includes(id)).map((id) => {
    const s = slot(id, '');
    s.tile = el('button', 'sim-tile');
    s.tile.type = 'button';
    s.tile.dataset.cam = id;
    s.tile.title = 'Enlarge';
    s.tile.setAttribute('aria-label', `${id} camera`);
    s.tile.append(s.pic);
    s.tile.onclick = () => open(id);
    list.append(s.tile);
    return s;
  });
  stage.insertBefore(col, canvasHost.nextSibling);
  canvasHost.append(bShow);

  /* enlarged feed */
  const big = el('div', 'sim-big');
  big.hidden = true;
  big.setAttribute('role', 'dialog');
  big.setAttribute('aria-label', 'Camera');
  let bigSlot = null, hadKeys = false;
  big.onclick = () => close();
  function open(id) {
    if (bigSlot) disposeSlot(bigSlot);
    bigSlot = slot(id, 'big');
    big.replaceChildren(bigSlot.pic);
    big.setAttribute('aria-label', `${id} camera`);
    (st.layout === 'grid' && !st.hidden ? stage : canvasHost).append(big);
    big.hidden = false;
    fit();
    paint();
  }
  function close() {
    if (!bigSlot) return false;
    big.hidden = true;
    disposeSlot(bigSlot);
    bigSlot = null;
    big.replaceChildren();
    if (hadKeys) canvas.focus();
    return true;
  }
  const onDown = (e) => { if (e.target.closest && e.target.closest('.sim-tile')) hadKeys = document.activeElement === canvas; };
  document.addEventListener('pointerdown', onDown, true);
  /* registered before the Sim keys (they install once the session is up and swallow every key),
     so Esc reaches the enlarged feed first */
  const onKey = (e) => { if (e.code === 'Escape' && bigSlot) { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
  window.addEventListener('keydown', onKey, true);

  function set(patch) {
    close();
    Object.assign(st, patch);
    save(st);
    apply();
  }
  bCol.onclick = () => set({ layout: 'column' });
  bGrid.onclick = () => set({ layout: 'grid' });
  bHide.onclick = () => set({ hidden: true });
  bShow.onclick = () => set({ hidden: false });

  function apply() {
    const grid = !st.hidden && st.layout === 'grid';
    col.hidden = st.hidden;
    bShow.hidden = !st.hidden;
    stage.classList.toggle('sim-grid', grid);
    stage.classList.toggle('sim-grid-wide', grid && feeds.length < 3);   // the view takes the free cell
    if (onLayout) onLayout(grid);
    bCol.classList.toggle('on', st.layout === 'column');
    bGrid.classList.toggle('on', st.layout === 'grid');
    fit();
  }

  /* column width: the feeds fill the height, within 260-420 px and 28 % of the stage; fewer feeds
     than fill it stack from the top at the column's width */
  function fit() {
    if (!st.hidden && st.layout === 'column') {
      const W = stage.clientWidth, H = stage.clientHeight, n = Math.max(1, feeds.length);
      const a = feeds.length ? aspectOf(feeds[0].id) : 4 / 3;
      const byH = ((H - HEAD - 2 * PAD - (n - 1) * GAP) / n) * a + 2 * PAD;
      const w = Math.round(Math.max(MIN_W, Math.min(MAX_W, byH, SHARE * W)));
      col.style.width = w + 'px';
      for (const f of feeds) f.tile.style.flex = `0 1 ${Math.round((w - 2 * PAD) / aspectOf(f.id))}px`;
    } else {
      col.style.width = '';
      for (const f of feeds) f.tile.style.flex = '';
    }
    for (const f of feeds) size(f, f.tile.clientWidth, f.tile.clientHeight);
    if (bigSlot) size(bigSlot, big.clientWidth * 0.9, big.clientHeight * 0.9);
  }
  function size(s, w, h) {
    const b = letterbox(w, h, aspectOf(s.id));
    s.pic.style.width = b.w + 'px';
    s.pic.style.height = b.h + 'px';
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  if (ro) ro.observe(stage);
  apply();

  /* one feed: PiP render into a target the size of its picture in device px, read back */
  function draw(s) {
    const cw = s.pic.clientWidth, ch = s.pic.clientHeight;
    if (cw < 8 || ch < 8) return;
    const dpr = viewport.renderer.getPixelRatio() || 1;
    const k = Math.min(dpr, MAX_PX / Math.max(cw, ch));
    const w = Math.round(cw * k), h = Math.round(ch * k);
    if (!s.target || s.target.width !== w || s.target.height !== h) {
      if (s.target) s.target.dispose();
      // tone-mapped and sRGB like the canvas: three does both only for the canvas and XR targets
      s.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, colorSpace: THREE.SRGBColorSpace, internalFormat: 'RGBA8' });
      s.target.isXRRenderTarget = true;
      s.cv.width = w; s.cv.height = h;
      s.px = new Uint8Array(w * h * 4);
      s.img = s.c2d.createImageData(w, h);
    }
    try {
      frustums.renderPip(s.id, s.target);
      viewport.renderer.readRenderTargetPixels(s.target, 0, 0, w, h, s.px);
      const row = w * 4;
      for (let y = 0; y < h; y++) s.img.data.set(s.px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      s.c2d.putImageData(s.img, 0, 0);
    } catch (e) { /* camera not mounted */ }
  }
  function paint() {
    if (!st.hidden) for (const f of feeds) draw(f);
    if (bigSlot) draw(bigSlot);
  }
  function disposeSlot(s) { if (s.target) s.target.dispose(); s.target = null; }

  return {
    el: col, paint, close,
    get on() { return !st.hidden || !!bigSlot; },
    get state() { return { ...st, enlarged: bigSlot ? bigSlot.id : null }; },
    destroy() {
      close();
      if (ro) ro.disconnect();
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      for (const f of feeds) disposeSlot(f);
      stage.classList.remove('sim-grid', 'sim-grid-wide');
      col.remove(); bShow.remove(); big.remove();
    },
  };
}
