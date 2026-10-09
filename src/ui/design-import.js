/* Importing geometry onto the robot: a part folder (part.json + mesh/ + print/) fitted into
   the slot it names, and a loose mesh added as an `imported/…` component.
   Installed by ui/design-page.js; it reaches the rest through `page.<name>()`. */

import * as THREE from 'three';
import { landing } from '../features/placement.js';

export function installImport(page) {
  const { store, model, viewport, picking, slots, meshes, ctx, actions } = page;

  /* a part folder goes through the agent loop's intake (ui/design-agent.js): validated,
     listed under its slot, and fitted */
  const fitParts = (res) => (ctx.on.importParts ? ctx.on.importParts(res.folders, { use: true }) : Promise.resolve(null));
  ctx.on.importIntoSlot = (slotId, res) => {
    if (res && res.kind === 'parts') return fitParts(res);
    const g = res.model.components.find((c) => c.geometry);
    if (!g) { page.setStatus('that import has no mesh'); return; }
    importComponent(g.geometry, res.model.name || 'imported', slotId, { base: landing(model, [g.geometry]) });
  };
  /* a loose set keeps its own layout; it lands clear of the robot as one */
  ctx.on.importLoose = (res) => {
    if (res && res.kind === 'parts') return fitParts(res);
    const list = res.model.components.filter((c) => c.geometry);
    const base = landing(model, list.map((c) => c.geometry));
    for (const c of list) importComponent(c.geometry, c.label || c.id, null, { base });
  };
  ctx.on.openSlot = (slotId) => {
    const owns = slots.slots[slotId].owns;
    if (owns && owns.length) { actions.select(owns[0]); if (page.inspector) page.inspector.setTab('options'); }
  };

  /* imported components */
  let importN = 0;
  /**
   * Keep an IMPORTED part in the collision world.
   *
   * A world built after the import picks the part up like any other component, because it
   * is in `model.components` by then.  A world that already existed never hears about it —
   * so an imported bracket was drawn, print-checked and exported, and collided with
   * nothing.  Register it as a dynamic, with `link` so it rides its parent, and re-point it
   * whenever the Placement section moves or reparents it.
   *
   * `c.local` is exactly what a dynamic's `base` means: the transform in the parent's
   * frame when there is a link, the robot frame when there is not.
   */
  function syncImportedBody(id, opts = {}) {
    const w = page.collideWorld;                       // never BUILD one just to register
    if (!w) return false;
    const rec = w.parts && w.parts.get(id);
    /* a package component is never a dynamic: the world builds it from `model.components`, FK tracks
       it, and `applyVisibility` takes a deleted one out of the active set */
    if (rec && rec.source === 'component') return false;
    /* a deleted part is not in the world; the design is the authority, not the caller */
    if (opts.removed || (store.get('removed') || {})[id]) {
      try { w.remove(id); } catch (e) { /* not a part */ }
      return true;
    }
    const c = model.component(id);
    if (!c || !c.geometry || c.group !== 'imported') return false;
    /* `frame:'robot'` without a link: the transform is in the ROBOT frame, so the body has to
       ride the driven base the way `model.worldMatrix` does */
    const meta = { link: c.link || null, frame: 'robot', label: c.label || id, group: 'imported' };
    try {
      if (rec) w.setDynamicMatrix(id, c.local, meta);
      else w.addDynamic(id, c.geometry, c.local, meta);
      return true;
    } catch (e) { return false; }
  }

  /**
   * @param {THREE.BufferGeometry} geometry
   * @param {string} label
   * @param {string|null} slotId
   * @param {{transform?:THREE.Matrix4, color?:string}} [o]  `transform` is the robot-frame
   *        matrix the copy starts at — an import passes the source's world matrix so
   *        the copy lands exactly on top of the piece it came from.  `base` is where it
   *        arrives without a transform (its pose before any Move).
   * @returns {string} the new component id
   */
  function importComponent(geometry, label, slotId, o = {}) {
    const id = 'imported/' + (++importN) + '-' + label.replace(/\W+/g, '_').slice(0, 24);
    const c = {
      id, localId: id, label, link: null, group: 'imported', slot: slotId || null,
      frame: 'robot', local: o.transform ? o.transform.clone() : o.base ? o.base.clone() : new THREE.Matrix4(),
      color: o.color || '#d08a3c', printable: true,
      print_source: null, mesh: id, source: 'import', visible: true, faces: null,
      geometry, owner: model, imported: true, note: null
    };
    model.ownComponents.push(c);
    model._flatten();
    page.designStamp++;
    const mesh = new THREE.Mesh(geometry, viewport.materials.forColor(c.color, 'imported'));
    mesh.name = id;
    mesh.matrixAutoUpdate = false;
    mesh.userData.componentId = id;
    mesh.userData.camClass = 'robot';
    viewport.robotRoot.add(mesh);
    meshes.set(id, mesh);
    picking.prepare(mesh);
    /* the pose it arrived at: where undoing past its first move puts it back */
    page.captureLocalBase(id);
    if (o.transform) store.set(['components', id, 'transform'], c.local.toArray(), { label: 'place ' + id });
    syncImportedBody(id);
    page.applyVisibility();
    page.syncMatrices();
    if (page.tree) page.tree.render();
    actions.select(id);
    if (page.inspector) page.inspector.setTab('shape');
    if (!o.quiet) page.setStatus(o.base && !o.transform ? `imported ${label} · placed beside the robot, clear of its body` : `imported ${label}`);
    return id;
  }

  Object.assign(page, { importComponent, syncImportedBody });
}
