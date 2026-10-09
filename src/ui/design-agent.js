/* The agent loop on the Design page: the linked folder (or a chosen / dropped one), the cards
   its part folders become, their toasts, a ghost preview and Use; drop anywhere; Save as part
   into the linked folder; and the context each prompt is built from.
   Installed by ui/design-page.js; it reaches the rest through `page.<name>()`. */

import * as THREE from 'three';
import * as pkg from '../core/package.js';
import { createLinkFolder, readDataTransfer, readFileList, writeTree } from '../core/link-folder.js';
import { checkFolder, isPartFolder, robotSummary } from '../features/agent-intake.js';
import { buildAgentContext } from '../features/agent-context.js';
import { buildPrompt, buildContextPack, packName, writeContextToFolder, removeContextPrompt } from '../features/context-pack.js';
import { partOf } from '../features/hinge.js';
import { slotOwnerOf } from '../features/slot-options.js';
import { createToasts } from './toast.js';
import { createAgentPanel } from './agent-panel.js';
import { icon } from './icons.js';
import { el } from './dom.js';

const MESH_EXT = /\.(stl|obj|3mf|ply|dae)$/i;
const SEEN_KEY = 'rps/agent-seen@1';      // "<folder>/<part>" -> signature, so a reload does not re-announce
const SOURCE_NOTE = { linked: 'linked folder', chosen: 're-choose the folder to refresh', drop: 're-drop to refresh', import: 're-import to refresh' };

export function installAgent(page) {
  const { store, model, slots, viewport, ctx } = page;
  const lf = page.linkFolder || createLinkFolder();
  const toasts = createToasts(page.canvasHost);
  const cards = new Map();            // "<source>:<folder id>" -> card
  const subs = new Set();
  let robot = null, ghost = null, ghostKey = null, ghostMat = null;
  const summary = () => robot || (robot = robotSummary(model, slots));
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { seen = {}; }
  const seenKey = (f) => `${lf.name()}/${f.id}`;
  function markSeen(f) {
    if (!f.sig) return;
    seen[seenKey(f)] = f.sig;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) { /* per session only */ }
  }
  /* one card at a time: a folder that changes while its Use is in flight waits for it */
  const locks = new Map();
  function serial(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }
  const fitted = (c) => !!c.slot && (store.getState().slots || {})[c.slot] === 'alt:' + c.id;
  const slotLabel = (sid) => (slots.slots[sid] ? slots.slots[sid].label : sid || 'no slot');

  function notify() {
    renderChip();
    for (const f of subs) { try { f(); } catch (e) { /* a closed view */ } }
  }

  /* the slot's alternatives: cached records the cards do not replace, then the cards */
  function syncSlot(sid) {
    if (!sid || !slots.slots[sid]) return;
    const mine = [...cards.values()].filter((c) => c.slot === sid && c.record);
    const ids = new Set(mine.map((c) => c.id));
    const kept = (page.altCache.get(sid) || []).filter((r) => !r._card && !ids.has(r.id));
    const list = [...kept, ...mine.map((c) => c.record)];
    if (list.length) page.altCache.set(sid, list); else page.altCache.delete(sid);
    slots.registerAlternatives(list, { slot: sid });
    page.reapplyAltShows();
    if (page.tree) page.tree.render();
  }

  function dropCard(key) {
    const c = cards.get(key);
    if (!c) return;
    if (ghostKey === key) preview(null);
    cards.delete(key);
    toasts.close('card:' + key);
    for (const m of (c.part && c.part.meshes) || []) {
      if (m.printGeometry) m.printGeometry.dispose();
      if (m.geometry) m.geometry.dispose();
    }
  }

  /**
   * Validate, print-check and list part folders; valid ones join their slot's options.
   * @param {Array<{id, files}>} folders
   * @param {{source?:string, use?:boolean, quiet?:boolean}} [o]
   */
  async function ingest(folders, o = {}) {
    const source = o.source || 'drop';
    const out = [];
    for (const f of folders) {
      const card = await serial(source + ':' + f.id, () => ingestOne(f, source, o));
      if (page.destroyed) return out;
      if (card) out.push(card);
    }
    notify();
    if (o.use) { const c = out.find((x) => x.ok); if (c) await use(c.key); }
    return out;
  }

  async function ingestOne(f, source, o) {
    const key = source + ':' + f.id;
    const taken = new Set([...cards.values()].filter((c) => c.key !== key && c.ok).map((c) => c.id));
    let r;
    try { r = await checkFolder(f, summary(), { taken, printer: ctx.printer() }); } catch (e) {
      const msg = String((e && e.message) || e);
      r = { id: f.id, slot: null, label: f.id, verdict: 'fail', reason: msg, errors: [msg], warnings: [], ok: false, part: null, record: null };
    }
    if (page.destroyed) return null;
    const prev = cards.get(key);
    const wasFitted = prev && prev.ok && fitted(prev);
    if (prev) dropCard(key);
    const known = !!f.sig && seen[seenKey(f)] === f.sig;
    markSeen(f);
    const card = { ...r, key, source, folderId: f.id, isNew: !known, missing: false, time: Date.now() };
    if (card.record) card.record._card = key;
    cards.set(key, card);
    syncSlot(card.slot);
    if (prev && prev.slot !== card.slot) syncSlot(prev.slot);
    if (wasFitted && card.ok && card.id === prev.id) {
      page.dropAltParts(card.slot, card.id);
      await page.ensureAltGeometry(card.slot, card.id);
    }
    if (!o.quiet && !known) announce(card, !!prev);
    return card;
  }

  function announce(c, again) {
    if (!c.ok) {
      toasts.show({ key: 'card:' + c.key, level: 'fail', text: `${c.label}: ${c.reason}`, title: c.errors.join('\n'),
        actions: [{ label: 'Why', run: () => openAgent(null, { results: true, why: c.key }) }] });
      return;
    }
    toasts.show({
      key: 'card:' + c.key, text: `${again ? 'Updated' : 'New'} design for ${slotLabel(c.slot)}: ${c.label}`,
      title: c.reason || '', onClose: () => { if (ghostKey === c.key) preview(null); },
      actions: [
        { label: 'Preview', keep: true, run: (b) => { const on = preview(ghostKey === c.key ? null : c.key); b.classList.toggle('on', on); } },
        { label: 'Use', accent: true, run: () => use(c.key) },
      ],
    });
  }

  function onRemoved(ids, source) {
    for (const id of ids) {
      const key = source + ':' + id;
      serial(key, () => {
        const c = cards.get(key);
        if (!c) return;
        if (c.ok && fitted(c)) c.missing = true;
        else { dropCard(key); syncSlot(c.slot); }
        notify();
      });
    }
  }

  /* a missing card leaves once it is off the robot */
  function pruneMissing() {
    const touched = new Set();
    for (const c of [...cards.values()]) if (c.missing && !fitted(c)) { dropCard(c.key); touched.add(c.slot); }
    for (const sid of touched) syncSlot(sid);
    if (touched.size) notify();
  }

  /** Swap the card's design in: one undo step. */
  function use(key) { return serial(key, () => useNow(key)); }
  async function useNow(key) {
    const c = cards.get(key);
    if (!c || !c.record || c.missing || !slots.slots[c.slot]) return null;
    preview(null);
    toasts.close('card:' + key);
    syncSlot(c.slot);
    c.isNew = false;
    const p = page.applySwap(c.slot, { kind: 'option', id: 'alt:' + c.id, label: c.label });
    notify();
    const ids = await p;
    notify();
    return ids;
  }

  /** The card's meshes as a ghost where they would sit; null clears it.  Returns whether one is shown. */
  function preview(key) {
    if (ghost) { viewport.robotRoot.remove(ghost); ghost = null; }
    const c = key ? cards.get(key) : null;
    ghostKey = null;
    if (!c || !c.part || !slots.slots[c.slot]) { viewport.invalidate(); return false; }
    if (!ghostMat) {
      const col = (viewport.tokens && viewport.tokens['--accent']) || '#2f5bd3';
      ghostMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.4, depthWrite: false });
    }
    const place = slots.alternativePlacement(c.slot, c.record || c.part);
    const g = new THREE.Group();
    g.name = 'agentPreview';
    g.matrixAutoUpdate = false;
    g.matrix.copy(model.baseMatrix().multiply(place.robot));
    for (const m of c.part.meshes) if (m.geometry) g.add(new THREE.Mesh(m.geometry, ghostMat));
    g.traverse((n) => { n.userData.pickable = false; n.userData.camClass = null; n.renderOrder = 998; });
    viewport.robotRoot.add(g);
    if (viewport.hideInPip) viewport.hideInPip(g);
    ghost = g; ghostKey = key;
    viewport.invalidate();
    return true;
  }

  /* the linked folder */
  lf.onChange(({ added, changed, removed }) => {
    if (added.length || changed.length) ingest([...added, ...changed], { source: 'linked' });
    if (removed.length) onRemoved(removed, 'linked');
  });
  lf.onState(() => notify());
  lf.restore().then(notify, notify);

  async function linkFolder(handle) {
    try {
      const h = handle ? await lf.link(handle) : await lf.pick();
      if (h) page.setStatus(`watching ${lf.name()}`);
    } catch (e) { page.setStatus(String((e && e.message) || e), 'warn'); }
    notify();
  }
  async function reconnect() {
    const ok = await lf.reconnect().catch(() => false);
    page.setStatus(ok ? `watching ${lf.name()}` : `no permission for ${lf.name()}`, ok ? undefined : 'warn');
    notify();
  }
  function chooseFolder() {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, webkitdirectory: true });
    input.onchange = async () => { await ingestParts(await readFileList(input.files), 'chosen'); };
    input.click();
  }
  async function ingestParts(folders, source) {
    const parts = folders.filter(isPartFolder);
    if (!parts.length) { page.setStatus('no part.json in that folder', 'warn'); return []; }
    return ingest(parts, { source });
  }

  function renderChip() {
    const host = page.topbar && page.topbar.folder;
    if (!host) return;
    const st = lf.state();
    host.innerHTML = '';
    host.hidden = st !== 'connected' && st !== 'reconnect';
    if (host.hidden) return;
    const b = el('button', 'btn ghost folderchip' + (st === 'reconnect' ? ' amber' : ''));
    b.type = 'button';
    b.append(icon('folder-link', 'i14'), el('span', 'tl', lf.name()), el('span', 'dot ' + (st === 'reconnect' ? 'warn' : 'ok')));
    b.title = st === 'reconnect' ? `Reconnect ${lf.name()}` : `${lf.name()} · watching`;
    b.onclick = () => openAgent(null, { results: true });
    host.appendChild(b);
  }

  /* drop anywhere */
  const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  const onDragOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); page.app.classList.add('dropping'); };
  const onDragLeave = (e) => { if (!e.relatedTarget || !page.app.contains(e.relatedTarget)) page.app.classList.remove('dropping'); };
  const onDrop = (e) => { if (!e.dataTransfer) return; e.preventDefault(); page.app.classList.remove('dropping'); handleDrop(e.dataTransfer); };
  page.app.addEventListener('dragover', onDragOver);
  page.app.addEventListener('dragleave', onDragLeave);
  page.app.addEventListener('drop', onDrop);

  /** A drop: part folders/zips join their slot; a mesh or other zip goes to Imported. */
  async function handleDrop(dt) {
    const files = [...(dt.files || [])];
    let got = { folders: [], handles: [] };
    const reading = readDataTransfer(dt).catch(() => null);
    got = (await reading) || got;
    const parts = got.folders.filter(isPartFolder);
    const h = got.handles.find((x) => !parts.some((p) => p.id === x.name));
    if (h && lf.supported() && lf.name() !== h.name) {
      toasts.show({ key: 'link', text: `Keep watching ${h.name}?`, ms: 20000,
        actions: [{ label: 'Link folder', accent: true, run: () => linkFolder(h) }] });
    }
    if (parts.length) return ingest(parts, { source: 'drop' });
    const zip = files.find((f) => /\.zip$/i.test(f.name));
    const meshes = files.filter((f) => MESH_EXT.test(f.name));
    try {
      if (zip) return ctx.on.importLoose(await pkg.importZip(zip, { remember: false }));
      if (meshes.length) return ctx.on.importLoose(await pkg.importFiles(meshes, { remember: false }));
      if (!h) page.setStatus('nothing to import in that drop', 'warn');
    } catch (e) { page.setStatus('import failed · ' + ((e && e.message) || e), 'err'); }
    return null;
  }

  /* Save as part: into the linked folder when there is one */
  const saveZip = ctx.on.savePart;
  ctx.on.savePart = async (id) => {
    if (lf.state() !== 'connected') return saveZip(id);
    const f = page.partFolder(id);
    if (!f) return saveZip(id);
    try {
      const dir = await lf.handle().getDirectoryHandle(f.id, { create: true });
      const order = Object.keys(f.files).sort((a, b) => (a === 'part.json') - (b === 'part.json'));
      await writeTree(dir, order.map((rel) => [rel, f.files[rel]]));
      page.setStatus(`saved ${lf.name()}/${f.id}/ · ${order.length} files`);
      return f;
    } catch (e) {
      page.setStatus(`cannot write to ${lf.name()} · ${(e && e.message) || e}`, 'warn');
      return saveZip(id);
    }
  };

  /* keep the cards in the registry whoever fits an alternative */
  const applyAlt = ctx.on.applyAlternative;
  ctx.on.applyAlternative = (sid, alt) => { const p = applyAlt(sid, alt); syncSlot(sid); return p; };
  ctx.on.importParts = (folders, o = {}) => ingest(folders.filter(isPartFolder), { source: 'import', use: o.use });

  /* the prompt */
  function contextFor(slotId, constraints) {
    const vis = ctx.visible();
    let folder;
    /* the plate as exported: a shipped file, the part folder's edited plate, else the mesh in
       its stated print pose; a part with no stated pose gets none (the prompt says lay it flat) */
    const plateOf = (cid) => {
      const shipped = page.altShipped(cid);
      if (shipped) return shipped.bytes;
      const p = partOf(model, cid);
      if (p) {
        if (folder === undefined) { try { folder = page.partFolder(cid); } catch (e) { folder = null; } }
        const b = folder && folder.files[`print/${p.mesh}_PRINT.stl`];
        if (b) return b;
      }
      let g = null;
      try { g = ctx.validator().geometryOf(store.getState(), cid); } catch (e) { g = null; }
      if (!g || !g.geometry || !g.orientation || g.orientation === 'unknown') return null;
      const geo = g.printTransform ? g.geometry.clone().applyMatrix4(g.printTransform) : g.geometry;
      const bytes = pkg.stlBytes(geo);
      if (geo !== g.geometry) geo.dispose();
      return bytes;
    };
    return buildAgentContext({
      model, slots, design: store.getState(), slotId, shown: (id) => vis.get(id) === true,
      cams: page.cams, printer: ctx.printer(), presets: page.presets, constraints, plateOf, carry: page.carry,
      manifestOf: (rid) => pkg.embeddedManifest(rid),
      folderName: lf.state() === 'connected' ? lf.name() : undefined,
    });
  }

  /** @returns {Promise<{prompt:string, contexts:Array, written:string[], error:string|null}>} */
  async function generate(targets, request, constraints) {
    const contexts = targets.filter((sid) => slots.slots[sid]).map((sid) => contextFor(sid, constraints));
    const prompt = contexts.map((c) => buildPrompt(c, request)).join('\n---\n\n');
    let written = [], error = null;
    if (lf.state() === 'connected') {
      try { for (const c of contexts) written = written.concat(await writeContextToFolder(lf.handle(), c, request)); }
      catch (e) { error = `cannot write to ${lf.name()}: ${(e && e.message) || e}`; }
    }
    return { prompt, contexts, written, error };
  }
  function forgetPrompts(slotIds) {
    if (lf.state() !== 'connected') return;
    for (const sid of slotIds) removeContextPrompt(lf.handle(), sid);
  }
  function downloadPacks(contexts, request) {
    for (const c of contexts) page.download(packName(c), buildContextPack(c, request), 'application/zip');
  }

  /* the inspector view */
  const targetsOf = (ids) => [...new Set((ids || []).map((id) => slotOwnerOf(model, slots, id)).filter(Boolean))];
  function openAgent(ids, o = {}) {
    if (ids) panel.setTargets(targetsOf(ids));
    else if (o.slot) panel.setTargets([o.slot]);
    if (page.inspector) page.inspector.openAgent();
    if (page.setInspectorDrawer && page.inspectorOpen === false && page.inspBtn && !page.inspBtn.hidden) page.setInspectorDrawer(true);
    panel.reveal(o);
  }
  ctx.on.openAgent = (slotId) => openAgent(null, { slot: slotId });

  const agent = {
    lf, cards, ingest, ingestParts, use, preview, generate, downloadPacks, forgetPrompts, contextFor, linkFolder, reconnect,
    chooseFolder, handleDrop, openAgent, slotLabel,
    unlink: async () => { await lf.unlink(); notify(); },
    results: () => { pruneMissing(); return [...cards.values()].sort((a, b) => b.time - a.time); },
    cardsFor: (sid) => [...cards.values()].filter((c) => c.slot === sid),
    cardOf: (altId) => [...cards.values()].find((c) => c.ok && c.id === altId) || null,
    isFitted: fitted,
    sourceNote: (c) => SOURCE_NOTE[c.source] || '',
    link: () => ({ state: lf.state(), name: lf.name(), supported: lf.supported(), error: lf.error() }),
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    previewing: () => ghostKey,
    toasts,
    close: () => { if (page.inspector) page.inspector.closeAgent(); },
    destroy() {
      unsub();
      lf.stop();
      preview(null);
      toasts.destroy();
      panel.destroy();
      page.app.removeEventListener('dragover', onDragOver);
      page.app.removeEventListener('dragleave', onDragLeave);
      page.app.removeEventListener('drop', onDrop);
    },
  };
  const panel = createAgentPanel(page, agent);
  agent.panel = panel;
  ctx.agent = agent;
  page.agent = agent;
  page.openAgent = openAgent;
  const unsub = store.subscribe(() => { if ([...cards.values()].some((c) => c.missing)) pruneMissing(); });
  renderChip();
}
