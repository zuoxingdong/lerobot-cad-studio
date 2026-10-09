/* What comes out of the design: STL bytes, the printables zip, the design JSON, the robot
   package, and the whole-design print report the export gate reads (cached per design
   revision).  Only a fail gates; the Export sheet is the one place to send it anyway.
   Installed by ui/design-page.js. */

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { strToU8 } from 'fflate';
import * as pkg from '../core/package.js';
import { exportGate } from '../features/printcheck.js';
import { isRemoved } from '../features/slot-options.js';
import { stlName, stlStem, uniqueName } from './design-helpers.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installExport(page) {
  const { store, model, slots, meshes, ctx, actions } = page;

  /* export */
  const exporter = new STLExporter();
  /**
   * Binary STL bytes for one geometry, always as a Uint8Array.
   * `STLExporter.parse(mesh, {binary:true})` answers with a **DataView**, and
   * `new Uint8Array(dataView)` takes the array-like path — `.length` is `undefined`, so it
   * builds an EMPTY array.  That is how every STL in the printables zip shipped 0 bytes
   * inside a zip that still looked plausible.  One helper, one conversion, no callers that
   * can get it wrong.
   */
  function stlOf(geometry, matrix) {
    const mesh = new THREE.Mesh(geometry);
    if (matrix) { mesh.matrixAutoUpdate = false; mesh.matrix.copy(matrix); mesh.matrixWorld.copy(matrix); }
    const dv = exporter.parse(mesh, { binary: true });
    if (dv instanceof Uint8Array) return dv;
    if (ArrayBuffer.isView(dv)) return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    return new Uint8Array(dv);              // an ASCII string would be a caller error
  }
  function download(name, data, type) {
    const blob = new Blob([data], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function doExport(kind, o = {}) {
    const st = store.getState();
    const vis = ctx.visible();
    if (kind === 'design') { download(model.id + '.design.json', store.exportJSON(), 'application/json'); page.setStatus('design JSON exported'); return; }
    if (kind === 'package') {
      try { download(model.id + '.package.zip', pkg.exportPackageZip(model, {}), 'application/zip'); page.setStatus('robot package saved'); }
      catch (e) { page.setStatus('package export failed · ' + e.message, 'err'); }
      return;
    }
    if (kind === 'selected') {
      const id = ctx.selection()[0];
      const c = id && model.component(id);
      if (!c) { page.setStatus('nothing printable selected', 'warn'); return; }
      if (isRemoved(st, id)) { page.setStatus('that component is deleted — Restore it first', 'warn'); return; }
      const V = ctx.validator();
      const g = V.geometryOf(st, id);
      if (!g.geometry) { page.setStatus('nothing printable selected', 'warn'); return; }
      const gate = exportGate(V.printOf(st, id));
      if (!gate.allowed && !o.force && !store.get('ui.exportAnyway')) { page.setStatus(gate.reason, 'err'); return; }
      /* An alternative SHIPS its bed orientation (`print/*.stl`).  Those bytes go out exactly
         as the designer wrote them — re-exporting our own parse of them would be a different
         file for no reason, and the print chips were measured on this very mesh. */
      const shipped = c.edited ? null : page.altShipped(id);
      if (shipped) {
        download(stlName(shipped.name), shipped.bytes);
        page.setStatus(`${c.label || id} exported · ${stlName(shipped.name)} as shipped`);
        return;
      }
      const geo = g.printTransform ? g.geometry.clone().applyMatrix4(g.printTransform) : g.geometry;
      download(stlName(page.plateName(c) || c.label || id), stlOf(geo));
      if (geo !== g.geometry) geo.dispose();
      page.setStatus(`${c.label || id} exported`);
      return;
    }
    if (kind === 'printables') {
      /* the whole-design gate; the Export sheet passes the rows it already gated (`ids`) */
      const failing = !o.ids && designReport().worst === 'fail';
      if (!o.force && !store.get('ui.exportAnyway') && failing) {
        page.setStatus(ctx.gateReason() + ' · open Export to send it anyway', 'err');
        return;
      }
      const files = printablesFiles(st, o.ids ? { ids: new Set(o.ids), extras: o.extras } : {});
      const n = Object.keys(files).length - 1;            // design.json is not a printable
      download(model.id + '.printables.zip', pkg.zipFiles(files), 'application/zip');
      /* UNGATED BYTES SAY SO.  A zip written past a failing print check left no sign at
         all — the user had to open the Export menu to find out the gate had been waived. */
      page.setStatus(`${n} part${n === 1 ? '' : 's'} exported`);
    }
  }
  /**
   * Everything the printables zip carries: entry name -> bytes.
   *
   * Every part goes through the validator, exactly as `selected` does — the five print chips are
   * measured in PRINT orientation, so a zip of robot-frame meshes would not be the geometry the
   * user was told passes.  A workspace alternative SHIPS that orientation as a file, and those
   * bytes go in verbatim.
   */
  function printablesFiles(design, o = {}) {
    const st = design || store.getState();
    const vis = ctx.visible();
    const V = ctx.validator();
    const files = {};
    const used = new Map();
    for (const c of model.printables().filter((x) => vis.get(x.id) !== false && x.geometry && (!o.ids || o.ids.has(x.id)))) {
      const shipped = c.edited ? null : page.altShipped(c.id);
      if (shipped) { files[uniqueName(used, stlStem(shipped.name)) + '.stl'] = shipped.bytes; continue; }
      const g = V.geometryOf(st, c.id);
      if (!g.geometry) continue;
      const geo = g.printTransform ? g.geometry.clone().applyMatrix4(g.printTransform) : g.geometry;
      files[uniqueName(used, stlStem(page.plateName(c) || c.label || c.id)) + '.stl'] = stlOf(geo);
      if (geo !== g.geometry) geo.dispose();
    }
    /* plates a fitted alternative ships that no single part of it carries — the corner mast's
       tilt shims are three wedges on one plate and belong to the kit, not to one component */
    if (!o.ids || o.extras) for (const p of page.altExtraPlates(st)) files[uniqueName(used, stlStem(p.name)) + '.stl'] = p.bytes;
    files['design.json'] = strToU8(store.exportJSON());
    return files;
  }
  /* The whole-design gate rebuilds every parametric part (a CSG pass each) and welds 39
     geometries — 150 ms warm, measured.  It is cached per design REVISION: the store is
     copy-on-write, so the slices that can move a print verdict are compared by IDENTITY
     first and only stringified when one of them is a fresh object (an undo restores a
     clone of a state whose values are unchanged). */
  function gateKey(st) {
    const printer = ctx.printer();
    if (page.gateIdent && page.gateIdent.slots === st.slots && page.gateIdent.params === st.params && page.gateIdent.parts === st.parts
      && page.gateIdent.components === st.components && page.gateIdent.printer === printer
      && page.gateIdent.stamp === page.designStamp) return page.gateIdent.key;
    const key = JSON.stringify([st.slots, st.params, st.parts, st.components, printer, page.designStamp]);
    page.gateIdent = { slots: st.slots, params: st.params, parts: st.parts, components: st.components, printer, stamp: page.designStamp, key };
    return key;
  }
  /** The authoritative report — the Print check dialog and the export gate wait for it. */
  function designReport() {
    const st = store.getState();
    const key = gateKey(st);
    if (page.gateCache && page.gateCache.key === key) return page.gateCache.value;
    const value = ctx.validator().validateDesign(st);
    page.gateCache = { key, value };
    /* "Export anyway" answers ONE failing design.  Leaving it set after the user fixed the
       part would silently wave the next failure through, so a passing gate takes it back. */
    if (value.worst !== 'fail' && st.ui && st.ui.exportAnyway) store.set('ui.exportAnyway', false);
    return value;
  }
  /** The last report, whatever its age — never a 150 ms recompute inside a repaint. */
  function worstComponent() {
    const r = page.gateCache ? page.gateCache.value : designReport();
    const bad = r.components.find((c) => c.verdict === 'fail') || r.components.find((c) => c.verdict === 'warn');
    if (!bad) return null;
    const chip = bad.chips.find((c) => c.level === bad.verdict && !c.preview);
    return { id: bad.component, level: bad.verdict, reason: chip ? chip.detail : bad.verdict };
  }
  /**
   * "Reset to defaults" — the package's startup design, by exactly the route boot takes.
   *
   * Blank the design's own answers, then `page.settleDesign()` (features/slots.js
   * `reconcile`, which fills every slot with the package default, derives visibility from
   * it and applies the options' parameters) and `page.applyAll()` (which adopts each
   * fitted option's camera).  The old version blanked `design.slots` and called
   * `applyAll()` on its own, pinning nothing: the robot came back with two wrist camera
   * assemblies on one seat, the slot reading `custom`, the top camera still on the mast
   * the reset had just taken off, and two plates in the zip for parts that were not on
   * the robot.  `parts` and `cameras` go too — a reset that left the user's lens edits
   * and their part edits behind is not the package's design.
   */
  function doResetDefaults() {
    /* ONE undo entry for the whole reset: the blank and the settle are one step, closed
       by `settleDesign`'s `commit`.  Labelling the blank would have made the settle a
       second entry, and the first Ctrl+Z would have undone only half of it. */
    store.update(({ tweaks, ...s }) => ({
      ...s, slots: {}, params: {}, parts: {}, components: {}, removed: {}, cameras: {}
    }));
    page.settleDesign({ reset: true, commit: 'reset to defaults' });
    page.applyAll();
    page.setStatus('reset to the package defaults');
  }

  Object.assign(page, {
    designReport, doExport, doResetDefaults, download, gateKey,
    printablesFiles, stlOf, worstComponent,
  });
}
