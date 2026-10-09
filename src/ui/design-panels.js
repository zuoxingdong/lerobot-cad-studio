/* Picking, the gizmo, and the panel mounts: the only file that knows how ui/{topbar,tree,
   inspector,camera-tiles,pose-popover}.js are wired up.  Each gets `ctx` (or the fields it
   asks for) and callbacks that are one `page.` call each.  Installed by ui/design-page.js. */

import { mountTopbar } from './topbar.js';
import { mountTree } from './tree.js';
import { mountInspector } from './inspector.js';
import { mountCameras } from './camera-tiles.js';
import { mountPose } from './pose-popover.js';
import { openHelpDialog, openPackageInfoDialog } from './dialogs.js';
import { simSupport } from '../features/sim-mjcf.js';
import { ROBOTS, isRobot } from '../data/assets.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installPanels(page) {
  const { store, model, onHome, topHost, railL, railR, vhead, checkSide, viewport, picking, gizmo, frustums, slots, cams, ctx, actions } = page;
  const tab = (id) => { location.hash = `#/${id}/${encodeURIComponent(model.id)}`; };
  const sim = simSupport(model);

  /* picking */
  picking.on('hover', (t) => { page.paintTag(t); if (tree) tree.setHover(t ? t.id : null); });
  picking.on('hovermove', page.paintTag);
  picking.on('selectionchange', ({ ids }) => {
    store.patch({ ui: { selected: ids[0] || null, multi: ids.slice(1) } });
    page.syncSelection();
  });
  picking.on('dblclick', ({ target }) => { if (target) actions.frame(target.id); else viewport.resetView(); });
  picking.on('contextmenu', ({ target, x, y }) => {
    if (!target) return;
    page.openMenu({ x, y }, page.componentMenu(target.id));
  });
  gizmo.onChange(() => viewport.invalidate());
  /* A DRAG IS A PLACEMENT, so it does exactly what the Placement section does: remember the
     pose it started from (undo needs somewhere to put the part down), re-point the collision
     body at the new matrix, and say so when the part landed inside the robot. */
  gizmo.onCommit(({ object }) => {
    const id = object && object.userData.componentId;
    if (!id) return;
    const c = model.component(id);
    if (!c) return;
    page.captureLocalBase(id);
    c.local.copy(object.matrix);
    store.set(['components', id, 'transform'], page.storedLocal(id), { label: 'Move · ' + (c.label || id) });
    page.syncImportedBody(id);
    page.warnPlacementHit(id);
    if (inspector) inspector.render();
  });

  /* panels */
  const topbar = mountTopbar(topHost, {
    model, store, checks: () => page.checks(),
    simAvailable: () => sim.teleop, simReason: sim.reason,
    on: {
      tab, home: onHome, undo: () => page.doHistory('undo'), redo: () => page.doHistory('redo'),
      exportSheet: () => page.openExportSheet(), help: () => openHelpDialog(page.km.context()),
      theme: () => page.cycleTheme(), menu: page.openMenu, resetDefaults: page.doResetDefaults,
      saveDesign: () => page.doExport('design'), openDesign: () => ctx.on.importDesign(),
      savePackage: () => page.doExport('package'), packageInfo: () => openPackageInfoDialog(model),
    }
  });
  if (!sim.teleop) { const b = topbar.el.querySelector('[data-tab="sim"]'); if (b) b.title = sim.reason; }

  const tree = mountTree(railL, {
    model, store, slots, visible: ctx.visible, slotOf: ctx.slotOf,
    on: {
      select: actions.select, hover: actions.hover, toggleVisible: actions.toggleVisible,
      frame: actions.frame, selectSlot: actions.selectSlot,
      swapSlot: (slotId, anchor) => actions.swapSlot(slotId, anchor),
      restore: (id) => page.restoreComponents([id]),
      contextmenu: (id, x, y) => page.openMenu({ x, y }, page.componentMenu(id)),
    }
  });

  const inspector = mountInspector(railR, ctx);
  page.onChecks(() => { if (!ctx.selection().length && inspector.view !== 'agent') inspector.render(); });
  const strip = mountCameras(checkSide, {
    model, store, cams, viewport, frustums, camCtx: page.camCtx,
    on: {
      menu: page.openMenu,
      camerasChanged: page.syncCameras,
      calibChanged: () => { page.syncCameras(); page.applyPose(); viewport.invalidate(); },
      lookThrough: page.setLookThrough,
      status: (msg, level) => page.setStatus(msg, level),
    }
  });
  /* the camera views stand in a room, whatever the theme */
  viewport.setRoom(true);

  const motion = mountPose(vhead.querySelector('.posehost') || vhead, {
    model, store, slots, presets: ctx.presets, activePreset: ctx.activePreset,
    presetPhysics: () => page.presetPhysics(),
    on: { setJoint: (j, v, commit) => page.setJoint(j, v, commit), preset: actions.preset, status: page.setStatus },
  });
  ctx.on.restore = (id) => page.restoreComponents(Array.isArray(id) ? id : [id]);
  ctx.on.delete = (id) => page.removeComponents(Array.isArray(id) ? id : [id]);
  ctx.on.removeFromSlot = (slotId) => page.removeFromSlot(slotId);
  ctx.on.swapSlot = (slotId, anchor, prefer) => actions.swapSlot(slotId, anchor, prefer);
  ctx.on.packageInfo = () => openPackageInfoDialog(model);
  ctx.on.resetDefaults = page.doResetDefaults;
  /** One design JSON, from wherever — the file picker below, or a test through `__rps`. */
  ctx.on.applyDesignJSON = (text) => {
    const r = store.importJSON(text, { merge: true });
    if (!r.ok) {
      let named = null;
      try { named = JSON.parse(text).robot; } catch (e) { /* the store's error says why */ }
      if (ROBOTS[named] && !isRobot(named)) r.errors[0] = `design is for ${ROBOTS[named].manifest.name} alone, an attachment, not a robot`;
      page.setStatus(r.errors[0], 'err');
      return r;
    }
    /* meshes imported into the previous design are not part of this one */
    const dropped = dropImports();
    /* the same settle boot and "Reset to defaults" run — a design JSON is just another
       stored design, and it gets the same slots, the same visibility and the same
       cameras as if it had been the autosave.  What settling drops (a v6 tweak with no
       clean cut) joins the warnings, and the whole answer is said once. */
    const said = [], notes = [], setStatus = page.setStatus;
    page.setStatus = (msg, level) => { if (msg) (level === 'warn' || level === 'err' ? said : notes).push(msg); };
    try {
      page.settleDesign({ baseline: true });
      page.applyAll();
    } finally { page.setStatus = setStatus; }
    r.warnings.push(...said);
    if (dropped) r.warnings.push(`${dropped} imported mesh${dropped === 1 ? '' : 'es'} of the previous design removed`);
    page.setStatus(['design loaded', ...notes, ...r.warnings].join(' · '), said.length ? 'warn' : null);
    return r;
  };
  function dropImports() {
    const ids = model.ownComponents.filter((c) => c.imported || c.group === 'imported').map((c) => c.id);
    if (!ids.length) return 0;
    for (const id of ids) {
      const i = model.ownComponents.findIndex((c) => c.id === id);
      if (i >= 0) model.ownComponents.splice(i, 1);
      const mesh = page.meshes.get(id);
      if (mesh) { viewport.robotRoot.remove(mesh); page.meshes.delete(id); }
      if (page.collideWorld) { try { page.collideWorld.remove(id); } catch (e) { /* not a body */ } }
      if (page.localBase) page.localBase.delete(id);
    }
    model._flatten();
    page.designStamp++;
    if (ids.includes(store.get('ui.selected'))) actions.select(null);
    return ids.length;
  }
  ctx.on.importDesign = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    /* an unreadable file (or none) must say so in the status bar, not become an
       unhandled rejection the user never sees */
    inp.onchange = async () => {
      try {
        const file = inp.files && inp.files[0];
        if (!file) return;
        ctx.on.applyDesignJSON(await file.text());
      } catch (e) {
        page.setStatus('could not read that file: ' + ((e && e.message) || e), 'err');
      }
    };
    inp.click();
  };
  ctx.on.export = page.doExport;
  ctx.on.exportAnyway = page.setExportAnyway;
  ctx.on.exportSheet = () => page.openExportSheet();
  ctx.on.selectSlot = actions.selectSlot;
  ctx.on.tab = tab;
  ctx.on.preset = actions.preset;

  Object.assign(page, {
    inspector, motion, strip, topbar, tree,
  });
}
