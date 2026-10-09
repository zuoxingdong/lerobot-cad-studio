/* `design.parts` on the scene: op stacks -> geometry, hinge knobs -> local transforms and
   cameras, mirrored copies -> Imported components; the live preview (edited mesh + a 30 %
   ghost) and Save as part.  Installed by ui/design-page.js. */

import * as THREE from 'three';
import { strToU8 } from 'fflate';
import { zipFiles } from '../core/package.js';
import { createPartOps, opsOf, opsHash, REFUSED, copyFrame, copyLabel } from '../features/part-ops.js';
import { hingeTransforms, partOf, partComponents, hingesOf, hingeValue, hingeLabel } from '../features/hinge.js';
import { carryOf } from '../features/carry.js';
import { opLabel, applyOps, transformOps, transformMount, mirroredPrintTransform } from '../features/ops.js';
import { withEntry } from '../core/part-edits.js';
import { seatOnBed } from '../features/geometry-kit.js';
import { ghostMaterial } from '../scene/op-overlay.js';

const EMPTY = opsHash([]);

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installOps(page) {
  const { store, model, slots, meshes, viewport, picking, ctx } = page;
  const partOps = page.partOps = createPartOps({ model, slots });
  const applied = new Map();     // key -> op hash the scene shows
  const copies = new Map();      // copy key -> {hash}
  let hingeSig = '';
  let preview = null;            // {saved: Map id -> geometry, ghosts: Mesh[]}

  const nameOf = (id) => { const c = model.component(id); return (c && c.label) || id; };
  const entryOf = (st, key) => ((st.parts || {})[key]) || null;
  const refusedText = (key, r) => `${nameOf(key)}: op ${r.index + 1} skipped · ${REFUSED[r.reason] || r.reason}`;

  /** Geometry for a key's stack: a copy builds from its source's pristine mesh. */
  function buildKey(key, ops) {
    const e = entryOf(store.getState(), key);
    return partOps.build(e && e.copy_of ? e.copy_of : key, ops);
  }
  const groupIds = (key) => {
    const e = entryOf(store.getState(), key);
    return e && e.copy_of ? [key] : partOps.group(key).ids;
  };

  function setGeometry(ids, geometry, edited) {
    const w = page.collideWorld;
    for (const id of ids) {
      const c = model.component(id);
      if (!c) continue;
      c.geometry = geometry;
      c.faces = geometry.attributes.position.count / 3;
      c.edited = !!edited;
      const mesh = meshes.get(id);
      if (mesh && mesh.geometry !== geometry) {
        mesh.geometry = geometry;
        try { picking.prepare(mesh); } catch (e) { /* not indexed yet */ }
        try { viewport.outlines.refresh(mesh); } catch (e) { /* older build */ }
      }
      if (w) { try { w.updateDynamic(id, geometry); } catch (e) { /* not a body */ } }
    }
    viewport.invalidate();
  }

  /* v6 `design.tweaks` -> op stacks, once, with a status note */
  function migrate() {
    const st = store.getState();
    if (!st.tweaks || !Object.keys(st.tweaks).length) return;
    const r = partOps.migrate(st.tweaks);
    store.update((s) => {
      const { tweaks, ...rest } = s;
      void tweaks;
      return { ...rest, parts: { ...r.parts, ...(s.parts || {}) } };
    });
    const bits = [];
    if (r.moved.length) bits.push(`${r.moved.length} v6 tweak${r.moved.length > 1 ? 's' : ''} moved to Changes`);
    if (r.dropped.length) bits.push(`dropped (no clean cut): ${r.dropped.join(', ')}`);
    if (bits.length) page.setStatus(bits.join(' · '), r.dropped.length ? 'warn' : null);
  }

  /* copies ("keep original") */
  function createCopy(key, src, geometry, e) {
    const T = src.printTransform ? src.printTransform.clone() : null;
    let printTransform = null;
    const mirror = (e.ops || []).find((o) => o.op === 'mirror');
    if (T && mirror) {
      const before = (e.ops || []).slice(0, (e.ops || []).indexOf(mirror));
      const g = partOps.build(e.copy_of, before).geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const box = g.boundingBox.clone().applyMatrix4(T);
      printTransform = mirroredPrintTransform(T, mirror.plane, (box.min.x + box.max.x) / 2);
    }
    const at = copyFrame(model, src, page.localBase.get(src.id) || src.local);
    const c = {
      id: key, localId: key, label: copyLabel(model, src, key), link: at.link, group: 'imported',
      slot: null, frame: at.frame, local: at.local,
      color: src.color, printable: src.printable, print_source: null, mesh: key, source: 'mirror',
      visible: true, faces: geometry.attributes.position.count / 3, geometry, owner: model, imported: true,
      note: null, printTransform, printName: src.printName ? src.printName.replace(/(\.stl)?$/i, '_mirrored.stl') : null,
      edited: true,
    };
    model.ownComponents.push(c);
    model._flatten();
    const mesh = new THREE.Mesh(geometry, viewport.materials.forColor(c.color, 'imported'));
    mesh.name = key;
    mesh.matrixAutoUpdate = false;
    mesh.userData.componentId = key;
    mesh.userData.camClass = 'robot';
    viewport.robotRoot.add(mesh);
    meshes.set(key, mesh);
    picking.prepare(mesh);
    page.captureLocalBase(key);
    page.syncImportedBody(key);
  }

  function removeCopy(key) {
    const i = model.ownComponents.findIndex((c) => c.id === key);
    if (i >= 0) { model.ownComponents.splice(i, 1); model._flatten(); }
    const mesh = meshes.get(key);
    if (mesh) { viewport.robotRoot.remove(mesh); meshes.delete(key); }
    if (page.collideWorld) { try { page.collideWorld.remove(key); } catch (e) { /* not a body */ } }
    page.localBase.delete(key);
    const sel = ctx.selection();
    if (sel.includes(key)) page.actions.select(sel.filter((x) => x !== key)[0] || null);
  }

  function syncCopies(parts) {
    let n = 0;
    for (const [key, e] of Object.entries(parts)) {
      if (!e || !e.copy_of || !model.component(e.copy_of)) continue;
      const hash = opsHash(e.ops || []);
      const have = copies.get(key);
      if (have && have.hash === hash && model.component(key)) continue;
      const r = partOps.build(e.copy_of, e.ops || []);
      if (!r.ok || !r.geometry || r.refused) continue;
      const geo = r.geometry.clone();
      geo.userData = { copyOf: e.copy_of };
      if (model.component(key)) setGeometry([key], geo, true);
      else createCopy(key, model.component(e.copy_of), geo, e);
      copies.set(key, { hash });
      n++;
    }
    for (const key of [...copies.keys()]) {
      if (parts[key] && parts[key].copy_of) continue;
      removeCopy(key);
      copies.delete(key);
      n++;
    }
    return n;
  }

  /** Is any mesh of this part folder on the robot? */
  function fittedPart(pid) {
    const vis = ctx.visible();
    return partComponents(model, pid).some((id) => vis.get(id) !== false);
  }

  /** Carry + hinge turns of `design` onto the locals and cameras; true when anything moved. */
  function syncHinges(design) {
    const vis = ctx.visible();
    page.carry = carryOf(model, design, { slots, visible: (id) => vis.get(id) !== false, build: partOps.build });
    const H = hingeTransforms(model, design, fittedPart, page.carry);
    const sig = [...H].map(([id, M]) => id + M.elements.map((v) => v.toFixed(9)).join(',')).join('|');
    if (sig === hingeSig) return false;
    const was = page.hingeT || new Map();
    page.hingeT = H;
    page.hingeIds = new Set([...was.keys(), ...H.keys()]);
    hingeSig = sig;
    page.applyStoredTransforms();
    return true;
  }

  /** design.parts -> the scene.  Cheap when nothing moved (hash compare). */
  function reconcileParts() {
    if (preview) endPreview(false);
    migrate();
    const st = store.getState();
    const parts = st.parts || {};
    let n = syncCopies(parts);
    const keys = new Set([...Object.keys(parts).filter((k) => !(parts[k] || {}).copy_of), ...applied.keys()]);
    let refusal = null;
    for (const key of keys) {
      if (!model.component(key)) { applied.delete(key); continue; }
      const ops = opsOf(st, key).filter((o) => o.op !== 'move');
      const hash = opsHash(ops);
      if ((applied.get(key) || EMPTY) === hash) continue;
      const r = partOps.build(key, ops);
      if (!r.ok || !r.geometry) continue;
      setGeometry(r.group.ids, r.geometry, ops.length > 0);
      if (ops.length) applied.set(key, hash); else applied.delete(key);
      if (r.refused) refusal = refusedText(key, r.refused);
      n++;
    }
    if (syncHinges(st)) n++;
    if (refusal) page.setStatus(refusal, 'warn');
    if (n) { page.designStamp++; page.refreshFittedTip(); viewport.invalidate(); }
    return n;
  }

  /** A knob build replaced a parametric part's mesh: its op stack goes back on top of `base`. */
  function rebaseParts(componentId, shown, base) {
    if (preview) endPreview(false);
    const key = partOps.designKey(componentId) || componentId;
    const ops = opsOf(store.getState(), key).filter((o) => o.op !== 'move');
    const r = partOps.rebase(componentId, base || shown, ops, shown);
    const geo = r.ok && r.geometry ? r.geometry : shown;
    setGeometry(r.group.ids.length ? r.group.ids : [componentId], geo, geo !== shown);
    if (ops.length) applied.set(key, opsHash(ops)); else applied.delete(key);
    if (r.refused) page.setStatus(refusedText(key, r.refused), 'warn');
    if (ops.length && syncHinges(store.getState())) page.adoptAllSlotCameras();
    page.designStamp++;
  }

  /* after any committed edit */
  function settle() {
    page.adoptAllSlotCameras();
    page.syncCameras();
    if (page.inspector) { page.inspector.invalidatePhysics(); page.inspector.render(); }
    if (page.tree) page.tree.render();
    if (page.opsBar) page.opsBar.render();
    page.updateStatus();
    page.appliedState = store.getState();
  }

  /* live preview: the edited mesh solid, the original as a ghost */
  function startPreview(ids) {
    if (preview) return preview;
    preview = { saved: new Map(), ghosts: [] };
    const mat = ghostMaterial(viewport);
    for (const id of ids) {
      const c = model.component(id);
      const mesh = meshes.get(id);
      if (!c || !mesh) continue;
      preview.saved.set(id, { geometry: c.geometry, edited: !!c.edited });
      const g = new THREE.Mesh(c.geometry, mat);
      g.matrixAutoUpdate = false;
      g.matrix.copy(mesh.matrix);
      g.renderOrder = 5;
      g.userData.pickable = false;
      g.userData.camClass = null;
      viewport.robotRoot.add(g);
      viewport.hideInPip(g);
      preview.ghosts.push(g);
    }
    viewport.invalidate();
    return preview;
  }

  /** Show `stacks` (key -> full op stack) on the meshes; returns the first refusal/warnings. */
  function setPreview(stacks) {
    const ids = [...stacks.keys()].flatMap((k) => groupIds(k));
    startPreview(ids);
    const out = { refused: null, warnings: [] };
    const st = store.getState();
    const parts = { ...(st.parts || {}) };
    for (const [key, ops] of stacks) {
      const r = buildKey(key, ops);
      if (!r.ok || !r.geometry) continue;
      setGeometry(groupIds(key), r.geometry, true);
      if (r.refused && !out.refused) out.refused = { ...r.refused, key };
      for (const w of r.warnings || []) out.warnings.push({ ...w, key });
      parts[key] = { ...(parts[key] || {}), ops };
    }
    /* what the edit carries moves with the preview */
    if (!out.refused && syncHinges({ ...st, parts })) { preview.carried = true; page.adoptAllSlotCameras(); }
    if (!out.refused && page.carry) for (const w of page.carry.warnings) if (stacks.has(w.key)) out.warnings.push({ code: 'carry', text: w.text, key: w.key });
    page.designStamp++;
    return out;
  }

  function endPreview(commit) {
    if (!preview) return;
    const p = preview;
    preview = null;
    for (const g of p.ghosts) viewport.robotRoot.remove(g);
    if (!commit) for (const [id, was] of p.saved) setGeometry([id], was.geometry, was.edited);
    if (!commit && p.carried && syncHinges(store.getState())) page.adoptAllSlotCameras();
    page.designStamp++;
    viewport.invalidate();
  }

  /* the edit entry points (one call = one undo step) */
  /** Run the new stacks once; a stack that refuses is never stored.  Answers false then. */
  ctx.on.applyOps = (entries, label) => {
    const st = store.getState(), stacks = new Map();
    for (const e of entries) stacks.set(e.key, [...(stacks.get(e.key) || opsOf(st, e.key)), e.op]);
    for (const [key, ops] of stacks) {
      const r = ops.every((o) => o && typeof o.op === 'string') ? buildKey(key, ops) : { ok: false };
      const bad = !r.ok ? { index: ops.length - 1, reason: 'invalid' } : r.refused;
      if (!bad) continue;
      if (preview) endPreview(false);
      page.setStatus(refusedText(key, bad), 'warn');
      return false;
    }
    if (preview) endPreview(true);
    const mapped = entries.map((e) => ({ key: e.key, op: e.op }));
    store.pushOps(mapped, label || opLabel(mapped[0].op, nameOf(mapped[0].key)) + (mapped.length > 1 ? ` +${mapped.length - 1}` : ''));
    reconcileParts();
    settle();
    return true;
  };
  ctx.on.removeOp = (key, index) => {
    const op = opsOf(store.getState(), key)[index];
    if (!op) return;
    store.dropOp(key, index, 'Remove · ' + opLabel(op, nameOf(key)));
    reconcileParts();
    settle();
  };
  ctx.on.resetOps = (ids) => {
    const st = store.getState();
    const keys = [...new Set(ids.map((id) => (entryOf(st, id) && entryOf(st, id).copy_of ? id : partOps.designKey(id))).filter(Boolean))];
    const moved = ids.filter((id) => ((st.components || {})[id] || {}).transform && model.component(id)?.group !== 'imported');
    store.update((s) => {
      let d = keys.reduce((acc, k) => {
        const e = entryOf(acc, k);
        return e && e.copy_of ? acc : withEntry(acc, k, e ? { ...e, ops: [] } : null);
      }, s);
      for (const id of moved) {
        const { transform, ...rest } = d.components[id];
        void transform;
        d = { ...d, components: { ...d.components, [id]: rest } };
      }
      return d;
    }, { label: `Reset · ${nameOf(ids[0])}${ids.length > 1 ? ` +${ids.length - 1}` : ''}` });
    reconcileParts();
    page.applyStoredTransforms();
    settle();
  };
  /** "keep original": a mirrored copy under Imported, one undo step */
  ctx.on.mirrorCopy = (entries) => {
    const st = store.getState();
    const made = [];
    store.update((s) => entries.reduce((d, e) => {
      const src = entryOf(st, e.key);
      const from = src && src.copy_of ? src.copy_of : e.key;
      const base = src && src.ops ? src.ops.slice() : [];
      let n = 1;
      const stem = `imported/${from.replace(/\W+/g, '_').slice(0, 32)}-mirror`;
      while ((d.parts || {})[`${stem}-${n}`] || model.component(`${stem}-${n}`)) n++;
      made.push(`${stem}-${n}`);
      return withEntry(d, `${stem}-${n}`, { copy_of: from, ops: [...base, e.op] });
    }, s), { label: `Mirror copy · ${nameOf(entries[0].key)}` });
    reconcileParts();
    page.applyVisibility();
    page.syncMatrices();
    settle();
    if (made.length) page.actions.select(made[0]);
    return made;
  };
  ctx.on.setHinge = (pid, key, value) => {
    const def = (hingesOf(model, pid).find((h) => h.key === key) || {}).def;
    if (!def) return;
    const label = (model.manifest.parts[pid] || {}).label || pid;
    store.set(['parts', pid, 'params', key], value, { label: hingeLabel(key, label.split(',')[0], value) });
    reconcileParts();
    page.syncMatrices();
    settle();
    if (page.strip) page.strip.render();
  };

  /* Save as part: a part folder {part.json, mesh/, print/} for one component's part */
  function partFolder(componentId) {
    const st = store.getState();
    const c = model.component(componentId);
    if (!c) return null;
    const p = partOf(model, componentId);
    const ids = p ? partComponents(model, p.id) : [componentId];
    const stem = (p ? p.id : componentId.replace(/\W+/g, '_')).slice(0, 48);
    let id = stem + '_edited';
    for (let i = 2; model.manifest.parts && model.manifest.parts[id]; i++) id = `${stem}_edited${i}`;
    const doc = p ? JSON.parse(JSON.stringify(p.doc)) : {
      schema: 'rps/part@1', robot: model.id, slot: ctx.slotOf(componentId) || null, frame: 'robot',
      local: model.worldMatrix(componentId).toArray(), meshes: [{ id: 'mesh', file: 'mesh/mesh.stl' }],
      mount: null, params: {}, source: 'LeRobot CAD Studio',
    };
    Object.assign(doc, { id, label: `${(p ? p.doc.label : c.label) || id} · edited`, derived_from: p ? p.id : componentId, ops: {} });
    const files = {};
    for (const cid of ids) {
      const cc = model.component(cid);
      const meshDoc = p ? doc.meshes.find((m) => (m.component || `${p.id}_${m.id}`) === cid) : doc.meshes[0];
      if (!cc || !meshDoc) continue;
      const key = partOps.designKey(cid);
      const ops = opsOf(st, key).filter((o) => o.op !== 'move');
      if (ops.length) doc.ops[meshDoc.id] = ops;
      meshDoc.file = `mesh/${meshDoc.id}.stl`;
      const d = p && page.carry ? page.carry.mesh(cid) : null;
      files[meshDoc.file] = page.stlOf(d ? cc.geometry.clone().translate(d[0], d[1], d[2]) : cc.geometry);
      delete meshDoc.volume_cm3;
      if (meshDoc.hardware || (meshDoc.print && String(meshDoc.print).startsWith('part:'))) continue;
      if (!cc.printTransform) { delete meshDoc.print; continue; }
      const T = cc.printTransform;
      const plate = partOps.original(key).clone().applyMatrix4(T);
      const mt = partOps.mount(key);
      const r = ops.length ? applyOps(plate, transformOps(ops, T), { mount: mt ? transformMount(mt, T) : null }) : { geometry: plate };
      meshDoc.print = `print/${meshDoc.id}_PRINT.stl`;
      files[meshDoc.print] = page.stlOf(r.geometry, seatOnBed(r.geometry));
    }
    if (p) for (const { key, def } of hingesOf(model, p.id, page.carry)) doc.params[key] = { ...def, value: hingeValue(st, p.id, key, def) };
    /* a carried camera keeps its design-detent pose, moved with what holds it */
    for (const cam of Object.values((p && doc.cameras) || {})) {
      if (!cam || !Array.isArray(cam.local) || cam.local.length !== 16 || !page.carry) continue;
      const d = page.carry.point(p.id, cam.local.slice(12, 15));
      for (let k = 0; k < 3; k++) cam.local[12 + k] += d[k];
    }
    if (!Object.keys(doc.ops).length) delete doc.ops;
    files['part.json'] = strToU8(JSON.stringify(doc, null, 2) + '\n');
    return { id, doc, files };
  }
  function savePartZip(componentId) {
    const f = partFolder(componentId);
    if (!f) { page.setStatus('nothing to save', 'warn'); return null; }
    const zip = {};
    for (const [k, v] of Object.entries(f.files)) zip[`${f.id}/${k}`] = v;
    const bytes = zipFiles(zip);
    page.download(`${f.id}.part.zip`, bytes, 'application/zip');
    page.setStatus(`saved ${f.id}.part.zip · ${Object.keys(f.files).length} files`);
    return { ...f, bytes };
  }
  ctx.on.savePart = savePartZip;
  ctx.partKey = (id) => { const e = entryOf(store.getState(), id); return e && e.copy_of ? id : partOps.designKey(id); };
  ctx.opsOf = (id) => opsOf(store.getState(), ctx.partKey(id));
  ctx.on.resetPlacement = (id) => {
    store.update((s) => {
      const cur = (s.components || {})[id];
      if (!cur || !cur.transform) return s;
      const { transform, ...rest } = cur;
      void transform;
      return { ...s, components: { ...s.components, [id]: rest } };
    }, { label: 'Reset move · ' + nameOf(id) });
    page.applyStoredTransforms();
    page.syncMatrices();
    settle();
  };

  Object.assign(page, {
    reconcileParts, rebaseParts, setPreview, endPreview, buildKey, partFolder, savePartZip,
    previewing: () => !!preview,
  });
}
