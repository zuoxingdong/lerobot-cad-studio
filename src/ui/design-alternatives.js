/* One slot changing what is on the robot, in all of its spellings: a package option, an
   imported alternative (zip or folder) and a loose STL.  Owns the
   lazy alternative-geometry path and the plate bookkeeping that decides what the export
   ships.  Installed by ui/design-page.js; it reaches the rest through `page.<name>()`. */

import * as THREE from 'three';
import { toArrayBuffer } from '../core/mesh-parse.js';
import * as pkg from '../core/package.js';
import { applySlotOption } from '../features/slot-options.js';
import { parametricComponentsOf } from '../features/parts.js';
import { camClassOf } from './design-helpers.js';
import { registerPart } from '../features/hinge.js';
import { MODK } from '../core/keymap.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installAlternatives(page) {
  const { store, model, viewport, picking, slots, meshes, generated, altParts, altPending, altExtras, stlLoader, ctx, actions } = page;

  function applySwap(slotId, entry) {
    const before = store.getState();
    const r = applySlotOption(model, slots, before, slotId, entry);
    store.patch(r.patch || {}, { label: 'swap ' + (r.label || slotId) });
    /* whatever this slot was showing before, if it was an ALTERNATIVE it is not on the
       robot any more — take its parts, its bodies and its tree rows with it */
    pruneAlternatives();
    page.applyVisibility();
    page.reconcileParts();
    /* only what this slot owns needs a rebuild — a CSG rebuild of all eight parametric
       components costs seconds, and nothing outside the slot changed. */
    const touched = new Set([...(slots.slots[slotId].owns || []),
      ...Object.keys((r.patch && r.patch.params) || {})]);
    for (const cid of parametricComponentsOf(model)) if (touched.has(cid)) page.rebuildParametric(cid, true);
    page.refreshFittedTip();
    /* EVERY slot whose choice moved, cascades included: `gripper → stock_jaw` pulls
       `wrist_camera_mount → stock`, and adopting only the slot the USER touched left the
       cascaded one on the DF200 arch's camera — a frustum over a bracket that had just
       come off.  Idempotent, one pass over seven slots. */
    page.adoptAllSlotCameras();
    page.syncCameras();
    if (page.tree) page.tree.render();
    if (page.inspector) page.inspector.render();
    if (page.inspector) page.inspector.invalidatePhysics();
    /* the §5.3 Compatibility confirmation: name every slot the rule moved */
    const cs = (r.cascades || []).map((x) => {
      const sid = x.slot || x[0];
      const oid = x.option || x[1];
      const sl = slots.slots[sid];
      const o = sl && sl.optionById && sl.optionById[oid];
      return `${sl ? sl.label : sid} → ${o ? o.label : oid}`;
    });
    page.setStatus(`${slots.slots[slotId].label} → ${r.label}`
      + (cs.length ? ` · also ${cs.join(' · ')}` : '') + `  ${MODK}Z to undo`);
    if (r.selected) actions.select(r.selected);
    /* An alternative is geometry that is not in the bundle: draw it, or the swap empties the
       slot.  Asynchronous; the promise is returned so a caller can wait for it. */
    /* THE SCENE NOW MATCHES THIS STATE, so `afterHistory` must be told.  `appliedState` was
       written only by `applyAll()`, so after a swap it still described the BOOT design — and
       the undo that followed diffed the undone state against the boot state, found them equal
       and skipped the work: the camera was left on the option that had just been undone.  A
       swap is a reconcile like any other; record it. */
    page.appliedState = store.getState();
    const chosen = (store.getState().slots || {})[slotId];
    if (typeof chosen === 'string' && chosen.startsWith('alt:')) {
      return ensureAltGeometry(slotId, chosen.slice(4)).then((ids) => {
        if (ids && ids.length && !store.get('ui.selected', null)) actions.select(ids[0]);
        return ids;
      });
    }
    return Promise.resolve(null);
  }
  ctx.on.applySwap = (slotId, entry) => applySwap(slotId, entry);
  ctx.on.applyAlternative = (slotId, alt) => {
    const one = [{ ...alt, slot: slotId }];
    slots.registerAlternatives(one, { slot: slotId });
    if (!page.altCache.has(slotId)) page.altCache.set(slotId, []);
    const cache = page.altCache.get(slotId);
    if (!cache.some((a) => a.id === alt.id)) cache.push(alt);
    return applySwap(slotId, { kind: 'option', id: 'alt:' + alt.id, label: alt.label });
  };
  ctx.on.previewOption = () => { /* a ghost preview needs a built mesh; the swap itself is one undo step */ };

  /* alternative geometry */
  /**
   * Draw what an alternative actually is.
   *
   * The bytes come from the record in hand (an imported zip carries its own bytes) or the
   * IndexedDB blob cache keyed by sha1.  They are parsed into real components, so from that
   * moment they are ordinary robot parts: drawn, picked, in the tree, in the collision world,
   * print-checked and exported.
   *
   * `meta.json` ships TWO sets of STLs and they are not interchangeable (core/recent-store.js):
   * the folder ROOT holds the robot-frame meshes — where each piece really sits, which is what
   * is drawn — and `print/` holds the bed-oriented plates, which is what is printed.  A mesh is
   * PRINTED exactly when the alternative ships a plate for it; that is what keeps bought
   * hardware (a metal tube, the camera module) out of the printables zip.
   */

  const altKey = (slotId, altId) => slotId + '/' + altId;
  /** `print/tube_base_PRINT.stl` and `tube_base.stl` are one part; this is the stem they share. */
  const printStem = (p) => String(p || '').split('/').pop().replace(/\.stl$/i, '')
    .replace(/[-_ ]?print$/i, '').toLowerCase();
  /**
   * The name a plate is EXPORTED under: `<alternative>_<plate>`.  Two mounts can ship a
   * `head_PRINT.stl`, so unqualified names collide inside one zip and which one gets the
   * `-2` depends on the design.  `make_robots.py plate_export_name()` qualifies the
   * package's own `print_name` the same way, so promoting an alternative into the package
   * does not change the file name.
   */
  const plateExportName = (altId, file) => {
    const base = String(file || '').split('/').pop();
    return (!altId || base.startsWith(altId + '_')) ? base : `${altId}_${base}`;
  };
  const altLabel = (name) => String(name).split('/').pop().replace(/\.stl$/i, '').replace(/[_-]+/g, ' ');
  const fileList = (x) => (x || []).filter((f) => f && f.name && /\.stl$/i.test(f.name)).map((f) => ({ ...f }));

  function b64ToBytes(b64) {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /** A stable content key for the blob cache, when the record carries no sha1. */
  async function contentKey(bytes) {
    try {
      const d = await crypto.subtle.digest('SHA-1', bytes);
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      let h = 0x811c9dc5;
      for (let i = 0; i < bytes.length; i += 97) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
      return 'len' + bytes.length.toString(16) + '-' + h.toString(16);
    }
  }

  /** Where an alternative's geometry sits — `features/slots.js alternativePlacement()`. */
  function altPlacement(slotId, alt) { return slots.alternativePlacement(slotId, alt); }

  /** The alternative record for `alt:<id>`, whoever registered it (an import or the cache). */
  function altRecord(slotId, altId) {
    try {
      const o = slots.option ? slots.option(slotId, 'alt:' + altId) : null;
      if (o && o.kind === 'alternative') return o;
    } catch (e) { /* not registered (yet) */ }
    const c = (page.altCache.get(slotId) || []).find((a) => a.id === altId);
    return c ? { ...c, altId: c.id, printFiles: c.print_files || [] } : null;
  }

  /** Keep an alternative's part in the collision world, exactly as an import is kept. */
  function syncAltBody(id, link) {
    const w = page.collideWorld;                       // never BUILD one just to register
    if (!w) return false;
    const c = model.component(id);
    if (!c || !c.geometry) return false;
    const meta = { link: link || null, frame: 'robot', label: c.label || id, group: 'upgrade' };
    try {
      const rec = w.parts && w.parts.get(id);
      if (rec && rec.source === 'dynamic') { w.setDynamicMatrix(id, c.local, meta); w.updateDynamic(id, c.geometry); }
      else if (!rec) w.addDynamic(id, c.geometry, c.local, meta);
      else return false;
      return true;
    } catch (e) { return false; }
  }

  /**
   * One robot-frame mesh of an alternative → one component.
   * @param {object} plate  the bed-oriented STL for this mesh, or null when it is not printed
   */
  function addAltComponent(slotId, alt, file, stlBytes, plate, opts = {}) {
    const altId = alt.altId || alt.id;
    const id = 'alt:' + altId + '/' + file.name;
    let geometry = null;
    try { geometry = stlLoader.parse(toArrayBuffer(stlBytes)); }
    catch (e) { page.setStatus(`could not read ${file.name} · ${e.message}`, 'err'); return null; }
    geometry.computeBoundingBox();
    generated.set(id, geometry);
    let printGeometry = null;
    if (plate) { try { printGeometry = stlLoader.parse(toArrayBuffer(plate.bytes)); } catch (e) { printGeometry = null; } }
    const place = altPlacement(slotId, alt);
    /* PRINTED iff a plate ships for it.  An alternative that ships no plates at all is the
       one-part layout, where `meta.printable` is the whole answer. */
    const printable = plate ? true : (opts.anyPlates ? false : alt.printable !== false);

    let c = model.component(id);
    if (c) {
      if (c.geometry && c.geometry !== geometry) { try { c.geometry.dispose(); } catch (e) { /* shared */ } }
      c.geometry = geometry;
      c.printGeometry = printGeometry;
      c.printBytes = plate ? plate.bytes : null;
      c.print_source = plate ? (plate.file || plate.name) : null;
      c.printable = printable;
      c.link = place.link; c.frame = place.frame; c.local.copy(place.local);
      c.faces = geometry.attributes.position.count / 3;
      const mesh = meshes.get(id);
      if (mesh) {
        mesh.geometry = geometry;
        try { picking.prepare(mesh); } catch (e) { /* not indexed yet */ }
        try { viewport.outlines.refresh(mesh); } catch (e) { /* older build */ }
      }
    } else {
      c = {
        id, localId: id, label: altLabel(file.name), link: place.link, group: 'upgrade',
        slot: slotId, frame: place.frame, local: place.local, color: null,
        printable, print_source: plate ? (plate.file || plate.name) : null, mesh: id, source: 'alternative',
        visible: true, faces: geometry.attributes.position.count / 3, geometry,
        printGeometry, printBytes: plate ? plate.bytes : null,
        owner: model, alternative: altId, note: null,
      };
      model.ownComponents.push(c);
      model._flatten();
      const mesh = new THREE.Mesh(geometry, viewport.materials.get('upgrade'));
      mesh.name = id;
      mesh.matrixAutoUpdate = false;
      mesh.userData.componentId = id;
      mesh.userData.camClass = camClassOf(c, slots.slots[slotId]);
      viewport.robotRoot.add(mesh);
      meshes.set(id, mesh);
      try { picking.prepare(mesh); } catch (e) { /* not indexed yet */ }
    }
    altParts.set(id, { slot: slotId, altId, print: plate ? { ...plate } : null });
    syncAltBody(id, place.link);
    return id;
  }

  /** sha1 → IndexedDB, and the record beside it, so a reload still draws it. */
  async function cacheAlt(slotId, alt, files, prints, bytes) {
    const keep = async (list) => {
      const out = [];
      for (const f of list) {
        const b = bytes.get(f.name);
        if (!b) continue;
        const sha1 = f.sha1 || (await contentKey(b));
        f.sha1 = sha1;
        await pkg.saveAltBlob(sha1, b);
        out.push({ name: f.name, sha1, bytes: b.length });
      }
      return out;
    };
    const rec = {
      id: alt.altId || alt.id, slot: slotId, label: alt.label || alt.id,
      frame: alt.frame || 'robot', local: alt.local || null,
      printable: alt.printable !== false, params: alt.params || {},
      cameras: alt.cameras || null, source: alt.source || 'inbox',
      notes: alt.notes || '', badge: alt.badge || 'from agent', path: alt.path || null,
      files: await keep(files), print_files: await keep(prints),
    };
    await pkg.saveAltRecord(model.id, rec);
  }

  async function realizeAlt(slotId, altId) {
    const alt = altRecord(slotId, altId);
    if (!alt) return null;
    let files = fileList(alt.files);
    let prints = fileList(alt.printFiles || alt.print_files);
    const bytes = new Map();
    for (const f of [...files, ...prints]) {
      const b = (f.stl_b64 && b64ToBytes(f.stl_b64)) || (f.bytes instanceof Uint8Array ? f.bytes : null)
        || (f.sha1 ? await pkg.loadAltBlob(f.sha1) : null);
      if (b) bytes.set(f.name, b);
    }
    if (page.destroyed) return null;
    /* a plate is not a mesh: in the one-part layout `print.stl` sits in the folder ROOT beside
       `part.stl`, and drawing it would stand a second copy of the part on the robot */
    const plates = new Set(prints.map((f) => String(f.name).split('/').pop()));
    files = files.filter((f) => !plates.has(f.name) && bytes.has(f.name));
    if (!files.length) return null;

    const ids = [];
    for (const f of files) {
      const t = prints.find((p) => printStem(p.name) === printStem(f.name) && bytes.has(p.name));
      const plate = t ? { name: plateExportName(altId, t.name), file: String(t.name).split('/').pop(),
        bytes: bytes.get(t.name) } : null;
      const id = addAltComponent(slotId, alt, f, bytes.get(f.name), plate, { anyPlates: prints.length > 0 });
      if (id) ids.push(id);
    }
    /* plates with no robot-frame mesh of their own — the corner mast's tilt shims — are still
       part of the kit, so the printables zip has to carry them */
    altExtras.set(altKey(slotId, altId), prints
      .filter((p) => bytes.has(p.name) && !files.some((f) => printStem(f.name) === printStem(p.name)))
      .map((p) => ({ name: plateExportName(altId, p.name), file: String(p.name).split('/').pop(),
        bytes: bytes.get(p.name) })));

    /* hinge knobs from the design's own part.json params */
    const hinges = Object.values(alt.params || {}).some((d) => d && d.kind === 'hinge');
    if (hinges) {
      const stem = (n) => String(n).split('/').pop().replace(/\.stl$/i, '');
      registerPart(model, alt.altId || alt.id, { label: alt.label, params: alt.params, meshes: files.map((f) => ({ id: stem(f.name) })) },
        (mid) => ids.find((cid) => stem(cid) === mid) || null);
    }
    reapplyAltShows();

    cacheAlt(slotId, alt, files, prints, bytes).catch(() => { /* IndexedDB blocked */ });
    return ids;
  }

  /**
   * Tell each alternative's OPTION record which components it now shows.
   *
   * `registerAlternatives()` builds a fresh record on every registration, and a fresh record
   * shows nothing — so this is re-applied after every registration, not once at realise time.  The
   * tree's "fitted" meta, the swap card's part list and `validate.clearanceOf`'s "these parts
   * belong together, do not flag them against each other" all read `shows`.
   */
  function reapplyAltShows() {
    const byAlt = new Map();
    for (const [id, rec] of altParts) {
      const k = altKey(rec.slot, rec.altId);
      if (!byAlt.has(k)) byAlt.set(k, { slot: rec.slot, altId: rec.altId, ids: [] });
      byAlt.get(k).ids.push(id);
    }
    for (const { slot: sid, altId, ids } of byAlt.values()) {
      try {
        const opt = slots.option(sid, 'alt:' + altId);
        if (opt && opt.kind === 'alternative') { opt.shows = ids.slice(); opt.showSet = new Set(ids); }
      } catch (e) { /* gone from the registry */ }
    }
  }

  /**
   * TAKE ONE ALTERNATIVE OFF THE ROBOT — the exact inverse of `realizeAlt`.
   *
   * Unfitting one (undo after "Fit it", a swap back, "Reset to defaults") must REMOVE its
   * parts, not hide them: hidden, they stay in `model.components`, in the tree, among the
   * printables and — because `collide.setActive()` never deactivates an `addDynamic`
   * record — in the collision world, where a ghost inside the fitted part is a permanent
   * hit for the rest of the session.
   *
   * The record and the sha1 blobs are kept (`page.altCache` + IndexedDB), so re-fitting is
   * one parse away.
   *
   * @returns {string[]} the component ids that were taken off
   */
  function dropAltParts(slotId, altId) {
    const key = altKey(slotId, altId);
    const ids = [];
    for (const [id, rec] of altParts) if (rec.slot === slotId && rec.altId === altId) ids.push(id);
    /* the fetch promise is the memo of "this one is already drawn": it has to go too, or
       re-fitting finds a resolved promise and draws nothing */
    altPending.delete(key);
    altExtras.delete(key);
    if (!ids.length) return ids;
    const w = page.collideWorld;
    for (const id of ids) {
      if (w) { try { w.remove(id); } catch (e) { /* never registered */ } }
      const mesh = meshes.get(id);
      if (mesh) { viewport.robotRoot.remove(mesh); meshes.delete(id); }
      const g = generated.get(id);
      if (g) { try { g.dispose(); } catch (e) { /* shared */ } generated.delete(id); }
      const i = model.ownComponents.findIndex((c) => c.id === id);
      if (i >= 0) model.ownComponents.splice(i, 1);
      altParts.delete(id);
    }
    model._flatten();
    try {
      const opt = slots.option(slotId, 'alt:' + altId);
      if (opt && opt.kind === 'alternative') { opt.shows = []; opt.showSet = new Set(); }
    } catch (e) { /* gone from the registry */ }
    return ids;
  }

  /**
   * Every alternative the design does NOT currently fit, off the robot.
   *
   * Called from the three places the fitted set can change: `applySwap` (which covers the
   * swap back to a package option and the swap to another alternative), `afterHistory`
   * (undo / redo) and `applyAll` ("Reset to defaults", a design loaded from JSON).
   * @returns {string[]} the component ids that were taken off
   */
  function pruneAlternatives() {
    const st = store.getState();
    const gone = new Map();
    for (const rec of altParts.values()) {
      const key = altKey(rec.slot, rec.altId);
      if (gone.has(key) || (st.slots || {})[rec.slot] === 'alt:' + rec.altId) continue;
      gone.set(key, rec);
    }
    if (!gone.size) return [];
    const dropped = [];
    for (const rec of gone.values()) dropped.push(...dropAltParts(rec.slot, rec.altId));
    if (!dropped.length) return dropped;
    const dead = new Set(dropped);
    /* an outline shell is a SIBLING of its source mesh, so one left over from a mesh that
       has left the scene graph keeps painting where that mesh stood */
    try { viewport.outlines.set('hover', []); } catch (e) { /* older build */ }
    const sel = [store.get('ui.selected', null), ...(store.get('ui.multi') || [])].filter(Boolean);
    if (sel.some((id) => dead.has(id))) actions.select(sel.filter((id) => !dead.has(id))[0] || null);
    if (dead.has(store.get('ui.isolate'))) store.set('ui.isolate', null);
    page.designStamp++;
    page.syncSelection();
    if (page.tree) page.tree.render();
    if (page.inspector) page.inspector.invalidatePhysics();
    viewport.invalidate();
    return dropped;
  }

  /** Fetch-and-draw one alternative, once. Returns the component ids (or null). */
  function ensureAltGeometry(slotId, altId) {
    const key = altKey(slotId, altId);
    if (altPending.has(key)) return altPending.get(key);
    const p = realizeAlt(slotId, altId).then((ids) => {
      if (!ids || !ids.length) { altPending.delete(key); return null; }
      if (page.destroyed) return ids;
      page.designStamp++;
      page.applyVisibility();
      page.syncMatrices();
      if (page.tree) page.tree.render();
      if (page.inspector) { page.inspector.render(); page.inspector.invalidatePhysics(); }
      viewport.invalidate();
      return ids;
    }).catch((e) => {
      altPending.delete(key);
      page.setStatus('alternative geometry · ' + ((e && e.message) || e), 'warn');
      return null;
    });
    altPending.set(key, p);
    return p;
  }

  /** Draw whatever alternative the DESIGN says is fitted — boot, a reload, an undo. */
  function realizeFittedAlternatives() {
    const st = store.getState();
    const out = [];
    for (const [sid, v] of Object.entries(st.slots || {})) {
      if (typeof v === 'string' && v.startsWith('alt:')) out.push(ensureAltGeometry(sid, v.slice(4)));
    }
    return Promise.all(out);
  }

  /**
   * The name a PACKAGE gives one component's plate (`print_name`), or null.
   *
   * A workspace alternative exports its plates under the designer's own file names, and a
   * design that graduates into the package must keep exporting those names — the kit is
   * the same kit either side of the promotion.
   */
  function plateName(c) { return (c && c.printName) || null; }

  /** the plate an alternative SHIPS for one component — exported verbatim, never re-sliced */
  function altShipped(id) {
    const rec = altParts.get(id);
    return rec && rec.print ? rec.print : null;
  }
  /** every plate of a FITTED alternative that no component of its own carries */
  function altExtraPlates(st) {
    const out = [];
    for (const [sid, v] of Object.entries((st && st.slots) || {})) {
      if (typeof v !== 'string' || !v.startsWith('alt:')) continue;
      for (const p of altExtras.get(altKey(sid, v.slice(4))) || []) out.push(p);
    }
    return out;
  }

  Object.assign(page, {
    addAltComponent, altExtraPlates, altKey, altLabel, altPlacement, altRecord,
    altShipped, applySwap, b64ToBytes, cacheAlt, contentKey, dropAltParts, ensureAltGeometry,
    fileList, plateName, printStem, pruneAlternatives, realizeAlt,
    realizeFittedAlternatives, reapplyAltShows, syncAltBody, toArrayBuffer,
  });
}
