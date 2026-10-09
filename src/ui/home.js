/* The Home page: onboarding, not a dashboard.  Two primary actions — open the default
   package, or import a robot — plus the showcase link; packages and recent designs sit below.
   Needs core/package.js, ui/dom.js, ui/icons.js and ui/dialogs.js. */

import { ROBOTS, robotIds, isRobot } from '../data/assets.js';
import * as pkg from '../core/package.js';
import { icon } from './icons.js';
import { openImportDialog, openHelpDialog, closeAnyDialog } from './dialogs.js';
import { isModified } from '../features/parts.js';
import { packageCounts, fillCounts } from './package-counts.js';
import { themeTitle } from './design-helpers.js';
import { editedCount } from '../core/part-edits.js';
import { readDataTransfer } from '../core/link-folder.js';
import { isPartFolder } from '../features/agent-intake.js';
import { el } from './dom.js';

export const DEFAULT_ROBOT = 'lekiwi-pincopen';
/* the RESOLVED manifest: a composition counts its base, attachments and parts */
const manifest = (id) => pkg.embeddedManifest(id);

function sourceLines(id) {
  const out = [];
  const seen = new Set();
  const walk = (rid) => {
    if (!ROBOTS[rid] || seen.has(rid)) return;
    seen.add(rid);
    const m = manifest(rid);
    const s = m.source;
    if (s && s.repo) {
      const repo = String(s.repo).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      out.push(`${repo} @${(s.commit || m.version || '').slice(0, 7)}`);
    } else if (m.composition) out.push('composition');
    for (const a of m.attachments || []) walk(a.package);
  };
  walk(id);
  return out.length ? out : ['local package'];
}

const thumbSrc = (id) => (pkg.embeddedThumbnail(id) ? 'data:image/png;base64,' + pkg.embeddedThumbnail(id) : null);

/**
 * The committed thumbnails are rendered on their own dark ground, which reads as a
 * black slab on a light card.  Repaint just that ground with the card's surface token:
 * take the corner pixel as the ground colour and replace everything within a small
 * distance of it, feathering the last part of the range so the silhouette keeps its edge.
 * One pass over 320 × 240 per card, once, in a canvas that replaces the <img> in place —
 * no change to the package, and the robot's own pixels are untouched.
 */
function repaintGround(img, surface) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  let d;
  try { d = g.getImageData(0, 0, w, h); } catch (e) { return null; }   // tainted: leave it
  const px = d.data;
  if (px[3] < 255) return null;                  // a transparent ground needs no repaint
  const bg = [px[0], px[1], px[2]];
  const to = [parseInt(surface.slice(1, 3), 16), parseInt(surface.slice(3, 5), 16), parseInt(surface.slice(5, 7), 16)];
  const NEAR = 26, FAR = 52;                     // exact ground … feathered edge
  for (let i = 0; i < px.length; i += 4) {
    const dist = Math.hypot(px[i] - bg[0], px[i + 1] - bg[1], px[i + 2] - bg[2]);
    if (dist >= FAR) continue;
    const t = dist <= NEAR ? 1 : (FAR - dist) / (FAR - NEAR);
    px[i] += (to[0] - px[i]) * t;
    px[i + 1] += (to[1] - px[i + 1]) * t;
    px[i + 2] += (to[2] - px[i + 2]) * t;
  }
  g.putImageData(d, 0, 0);
  cv.className = img.className;
  return cv;
}

/** Set a thumbnail, repainting its ground once the bytes are decoded. */
function thumbOn(img, id) {
  const src = thumbSrc(id);
  if (!src) return;
  img.src = src;
  const swap = () => {
    const surface = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-3').trim() || '#eceff5';
    if (!/^#[0-9a-f]{6}$/i.test(surface)) return;
    const cv = repaintGround(img, surface);
    if (cv && img.parentElement) img.replaceWith(cv);
  };
  if (img.complete && img.naturalWidth) swap();
  else img.addEventListener('load', swap, { once: true });
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 172800) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * @param {HTMLElement} root
 * @param {{store:object, onOpen:(robotId:string, design?:object)=>void,
 *          onImportedModel:(res:object)=>void, setTheme:Function}} ctx
 * @returns {{destroy:Function, refresh:Function}}
 */
export function mountHome(root, ctx) {
  root.innerHTML = '';
  const page = el('div', 'home');
  page.setAttribute('data-page', 'home');

  /* top bar */
  const bar = el('div', 'home-bar');
  bar.appendChild(el('div', 'mark'));
  bar.appendChild(el('div', 'brand', 'LeRobot CAD Studio'));
  bar.appendChild(el('div', 'sp'));
  /* the same control on both pages, so it is the same button: icon-only, as on the Design
     page's top bar (the word "Theme" here and a glyph there read as two different things) */
  const themeBtn = el('button', 'btn icon ghost');
  themeBtn.appendChild(icon('theme'));
  themeBtn.title = themeTitle(ctx.store ? ctx.store.get('ui.theme', 'auto') : 'auto');
  themeBtn.setAttribute('aria-label', 'Theme');
  themeBtn.onclick = () => { themeBtn.title = themeTitle(ctx.setTheme('cycle')); };
  const helpBtn = el('button', 'btn icon ghost');
  helpBtn.appendChild(icon('help'));
  helpBtn.title = 'Keyboard & mouse · ?';
  helpBtn.setAttribute('aria-label', 'Keyboard and mouse help');
  helpBtn.onclick = () => openHelpDialog();
  bar.append(themeBtn, helpBtn);
  page.appendChild(bar);

  /* body */
  const main = el('main', 'home-main');
  page.appendChild(main);

  /* primary 1 — the default composition */
  const primary = el('div', 'primary');
  const defId = isRobot(DEFAULT_ROBOT) ? DEFAULT_ROBOT : robotIds()[0];
  primary.appendChild(bigCard(defId));
  primary.appendChild(importCard());
  primary.appendChild(showcaseCard());
  main.appendChild(primary);

  /* packages */
  const h2 = el('h2', 'sec micro', 'Packages');
  main.appendChild(h2);
  const grid = el('div', 'pkgs');
  /* the default package already has the primary card 200 px above — a second, byte-identical
     way to open it is not a choice, it is a duplicate.  And the `Add a package` tile was a
     `<div>` that could not be clicked, telling the user to go and edit files on disk
     (scaffolding text). */
  for (const id of robotIds()) if (id !== defId) grid.appendChild(smallCard(id));
  main.appendChild(grid);
  h2.hidden = !grid.children.length;
  grid.hidden = !grid.children.length;

  /* recent */
  const recentHead = el('h2', 'sec micro', 'Recent');
  const recentList = el('div', 'recent');
  recentHead.hidden = true;
  recentList.hidden = true;
  main.append(recentHead, recentList);

  function bigCard(id) {
    const m = manifest(id);
    const c = packageCounts(id);
    const card = el('button', 'card1');
    card.type = 'button';
    card.setAttribute('aria-label', 'Open ' + m.name);
    const img = document.createElement('img');
    img.className = 'shot';
    img.alt = '';
    card.appendChild(img);
    thumbOn(img, id);
    const body = el('div', 'body');
    const pill = el('span', 'default-pill', 'Default');
    const h1 = el('h1', 'h1', m.name);
    const src2 = el('div', 'srcline code');
    src2.innerHTML = sourceLines(id).map((s) => s.replace(/ /g, '&nbsp;')).join('<br>');
    const counts = el('div', 'counts');
    counts.innerHTML =
      `<span><b data-k="parts">…</b> parts</span><span><b data-k="printed">…</b> printed</span>` +
      `<span><b>${c.slots}</b> slots</span><span><b>${c.cameras}</b> cameras</span>`;
    counts.title = `${c.components} components in the package, options included`;
    fillCounts(counts, id);
    const spacer = el('div', 'sp');
    const actions = el('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:var(--sp-5)';
    const open = el('span', 'btn accent lg', 'Open');
    const last = el('span', 'code dim');
    actions.append(open, last);
    body.append(pill, h1, src2, counts, spacer, actions);
    card.appendChild(body);
    card.onclick = () => ctx.onOpen(id);
    card._lastSpan = last;
    return card;
  }

  function importCard() {
    const card = el('button', 'card2');
    card.type = 'button';
    card.appendChild(icon('import', 'i'));
    card.lastChild.style.cssText = 'width:22px;height:22px;color:var(--ink-2)';
    const t = el('div', null, 'Import robot…');
    t.style.cssText = 'font-size:20px;line-height:26px;font-weight:600';
    const fmts = el('div', 'dz code', 'package .zip · URDF + meshes .zip · .stl / .3mf / .obj');
    const choose = el('span', 'btn lg', 'Choose file');
    choose.style.marginTop = 'var(--sp-2)';
    const drop = el('div', 'code dim', 'or drop anywhere on this page');
    card.append(t, fmts, choose, drop);
    card.onclick = () => openImportDialog({ onImported: ctx.onImportedModel });
    return card;
  }

  /* the photoreal showcase is its own page; the poster is a site/ file, so the card drops it when missing */
  function showcaseCard() {
    const card = el('a', 'card3');
    card.href = 'showcase.html';
    const img = document.createElement('img');
    img.className = 'shot';
    img.alt = '';
    img.src = 'media/hero-poster.jpg';
    img.onerror = () => img.remove();
    const body = el('div', 'body');
    const t = el('div', 't', 'Watch the showcase');
    const sub = el('div', 'code dim', 'LeKiwi + PincOpen in a photoreal lab');
    const play = el('span', 'btn lg', '▶ Play');
    body.append(t, sub, play);
    card.append(img, body);
    return card;
  }

  function smallCard(id) {
    const m = manifest(id);
    const c = packageCounts(id);
    const card = el('button', 'pkg');
    card.type = 'button';
    const img = document.createElement('img');
    img.alt = '';
    card.appendChild(img);
    thumbOn(img, id);
    const b = el('div', 'b');
    b.append(el('div', 'n', m.name));
    b.append(el('div', 's code', sourceLines(id)[0]));
    const cc = el('div', 'c');
    cc.innerHTML = `<span><span class="mono" data-k="parts">…</span>&nbsp;parts</span>` +
      `<span><span class="mono" data-k="printed">…</span>&nbsp;printed</span>`;
    cc.title = `${c.components} components in the package, options included`;
    fillCounts(cc, id);
    b.appendChild(cc);
    card.appendChild(b);
    card.onclick = () => ctx.onOpen(id);
    return card;
  }

  /* recent designs (IndexedDB) */
  /** The ⋮ menu a recent row promises: rename · delete (delete asks first).
   *  There is no Duplicate: one autosave entry per robot is the whole model, so a copy could
   *  never be edited — every edit landed back in the original's row whichever was opened. */
  function rowMenu(anchor, r) {
    closeRowMenu();
    const m = el('div', 'menu');
    m.setAttribute('role', 'menu');
    const item = (label, run) => {
      const b = el('button', null, label);
      b.setAttribute('role', 'menuitem');
      b.onclick = async (e) => { e.stopPropagation(); closeRowMenu(); await run(); };
      m.appendChild(b);
    };
    item('Rename…', async () => {
      const name = window.prompt('Name this design', r.label || r.robot || '');
      if (name == null) return;
      await pkg.saveRecent({ ...r, label: name.trim() || r.label });
      refresh();
    });
    m.appendChild(document.createElement('hr'));
    item('Delete', async () => {
      if (!window.confirm(`Delete "${r.label || r.robot}"?  This cannot be undone.`)) return;
      await pkg.removeRecent(r.id);
      refresh();
    });
    document.body.appendChild(m);
    const a = anchor.getBoundingClientRect();
    m.style.left = Math.min(a.left, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(a.bottom + 4, window.innerHeight - m.offsetHeight - 8) + 'px';
    rowMenuNode = m;
    setTimeout(() => document.addEventListener('mousedown', onRowMenuDown, true), 0);
    const first = m.querySelector('button');
    if (first) first.focus();
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeRowMenu(); } });
  }
  let rowMenuNode = null;
  function closeRowMenu() {
    if (!rowMenuNode) return;
    rowMenuNode.remove();
    rowMenuNode = null;
    document.removeEventListener('mousedown', onRowMenuDown, true);
  }
  function onRowMenuDown(e) { if (rowMenuNode && !rowMenuNode.contains(e.target)) closeRowMenu(); }

  async function refresh() {
    let list = [];
    try { list = await pkg.listRecent(); } catch (e) { list = []; }
    /* a design for an attachment package (no longer a robot of its own) is not listed */
    list = (list || []).filter((r) => !ROBOTS[r.robot] || isRobot(r.robot)).slice(0, 6);
    recentHead.hidden = list.length === 0;
    recentList.hidden = list.length === 0;
    recentList.innerHTML = '';
    for (const r of list) {
      const row = el('div', 'rrow');
      const dot = el('span', 'dot' + (r.changed ? ' acc' : ''));
      const name = el('span', 'rn', r.label || r.id);
      const robot = el('span', 'rb', (ROBOTS[r.robot] ? manifest(r.robot).name : r.robot) || '');
      /* `saveRecent` stamps `savedAt`; `saved` is only there because `src/main.js` happens
         to write one too, and a row made by Rename carried the SOURCE row's timestamp */
      const when = el('span', 'rt mono', ago(r.savedAt || r.saved || r.time));
      const summ = el('span', 'rs code', summarise(r.design));
      const acts = el('span', 'ra');
      const open = el('button', 'btn', 'Open');
      open.onclick = (e) => { e.stopPropagation(); ctx.onOpen(r.robot, r.design); };
      const more = el('button', 'btn icon ghost');
      more.appendChild(icon('dots-vertical'));
      more.title = 'Rename · delete';
      /* the two actions the tooltip promises, behind a menu — never delete on one click */
      more.onclick = (e) => { e.stopPropagation(); rowMenu(more, r); };
      acts.append(open, more);
      row.append(dot, name, robot, when, summ, acts);
      row.onclick = () => ctx.onOpen(r.robot, r.design);
      recentList.appendChild(row);
    }
    const first = list[0];
    const card = primary.firstChild;
    if (card && card._lastSpan) {
      card._lastSpan.textContent = first && first.robot === defId
        ? 'last opened ' + ago(first.savedAt || first.saved || first.time) : '';
    }
  }

  /* WHAT DIFFERS FROM THE PACKAGE, not what the design happens to name.  The boot settle
     writes EVERY slot and seeds the parametric parameters, so counting keys read "6 slots
     changed · 2 tweaks" on a design nobody had touched — while the design page's own status
     bar, for the same state, correctly read 0 and 0. */
  function summarise(d) {
    if (!d) return 'defaults';
    const decl = slotDefaults(d.robot);
    const s = Object.keys(d.slots || {}).filter((k) => !decl.has(k) || d.slots[k] !== decl.get(k)).length;
    const p = Object.keys(d.params || {}).filter((id) => isModified(d, id)).length + editedCount(d);
    const parts = [];
    if (s) parts.push(`${s} slot${s > 1 ? 's' : ''} changed`);
    if (p) parts.push(`${p} tweak${p > 1 ? 's' : ''}`);
    return parts.join(' · ') || 'defaults';
  }

  /** slot id -> the option the package ships, attachments included */
  function slotDefaults(robotId) {
    const out = new Map();
    const seen = new Set();
    const walk = (rid) => {
      if (!ROBOTS[rid] || seen.has(rid)) return;
      seen.add(rid);
      const m = manifest(rid);
      for (const [k, v] of Object.entries(m.slots || {})) if (!out.has(k)) out.set(k, v && v.default);
      for (const a of m.attachments || []) walk(a.package);
    };
    walk(robotId);
    return out;
  }

  /* drop anywhere */
  const onDragOver = (e) => { e.preventDefault(); page.classList.add('dragging'); };
  const onDragLeave = () => page.classList.remove('dragging');
  const onDrop = async (e) => {
    e.preventDefault();
    page.classList.remove('dragging');
    const files = [...(e.dataTransfer.files || [])];
    const got = await readDataTransfer(e.dataTransfer).catch(() => null);
    const parts = got ? got.folders.filter(isPartFolder) : [];
    if (parts.length) { ctx.onImportedModel({ kind: 'parts', folders: parts, files: [] }); return; }
    if (files.length) openImportDialog({ files, onImported: ctx.onImportedModel });
  };
  page.addEventListener('dragover', onDragOver);
  page.addEventListener('dragleave', onDragLeave);
  page.addEventListener('drop', onDrop);

  /* ANOTHER TAB OWNS THE SAME LIST.  Without this a row deleted in tab B stayed on screen
     here — and this tab's next write put it back. */
  const offRecent = pkg.onRecentChange(() => { refresh(); });

  root.appendChild(page);
  /* the default card holds initial focus, so Enter opens it */
  requestAnimationFrame(() => { try { primary.firstChild.focus(); } catch (e) { /* headless */ } });
  refresh();

  return {
    refresh,
    destroy() {
      closeRowMenu();
      closeAnyDialog();
      offRecent();
      page.removeEventListener('dragover', onDragOver);
      page.removeEventListener('dragleave', onDragLeave);
      page.removeEventListener('drop', onDrop);
      root.innerHTML = '';
    }
  };
}
