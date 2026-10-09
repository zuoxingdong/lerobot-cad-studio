/* The Design page: the frame, the viewport wiring, and the one place that owns the app
   context every other src/ui module is handed.  Needs scene/, core/ and the design-* modules
   it installs.  Frame: top 48 · tree 272 · viewport header 32 · canvas · inspector 320 ·
   status 24.  Nothing floats over the canvas but the action bar and toasts; the Check tab
   re-lays the same centre out with the camera tiles and the checks table. */

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

import { createViewport } from '../scene/viewport.js';
import { createPicking } from '../scene/picking.js';
import { createGizmo } from '../scene/gizmo.js';
import { createFrustums } from '../scene/frustums.js';
import * as pkg from '../core/package.js';

import { icon } from './icons.js';
import { closeOptions } from './options-list.js';
import { anyDialogOpen, closeAnyDialog } from './dialogs.js';
import { buildSlots } from '../features/slots.js';
import { createCameras } from '../features/cameras.js';
import { presetsFor } from '../features/validate.js';
import { slotOwnerOf } from '../features/slot-options.js';
import { configureGroups } from './tree.js';

import { createPageState, installContext } from './design-context.js';
import { installScene } from './design-scene.js';
import { installOps } from './design-ops.js';
import { installAlternatives } from './design-alternatives.js';
import { installImport } from './design-import.js';
import { installMenus } from './design-menus.js';
import { installChrome } from './design-chrome.js';
import { installExport } from './design-export.js';
import { installHistory } from './design-history.js';
import { installMotion } from './design-motion.js';
import { installPanels } from './design-panels.js';
import { installKeymap } from './design-keymap.js';
import { installAgent } from './design-agent.js';
import { installChecks } from './design-checks.js';
import { openExportSheet } from './export-sheet.js';
import { simSupport } from '../features/sim-mjcf.js';
import { mountActionBar } from './action-bar.js';
import { el } from './dom.js';
import { stlName, effectiveTheme, camClassOf, roleOf } from './design-helpers.js';

export { effectiveTheme, nextTheme } from './design-helpers.js';

/**
 * Mount the Design page into `root`.
 * @param {HTMLElement} root
 * @param {{store, model, onHome:Function}} opts
 * @returns {object} the page surface — what `main.js`'s `?debug=1` hooks and the e2e suite drive
 */
export function mountDesign(root, opts) {
  const { store, model, onHome } = opts;
  root.innerHTML = '';

  /* ONE bag, created before anything else: the eleven modules below fill it in and read
     each other's work off it. */
  const page = createPageState({ root, store, model, onHome });
  const { theme, meshes, generated, altParts } = page;
  const slots = page.slots = buildSlots(model);
  const cams = page.cams = createCameras(model, { groundZ: model.groundZ });
  page.presets = presetsFor(model);
  page.stlLoader = new STLLoader();

  /* the frame */
  const app = el('div', 'app');
  app.setAttribute('data-page', 'design');
  const skip = el('a', 'skip', 'Skip to viewport');
  skip.href = '#rps-canvas';
  const topHost = el('div');
  const frame = el('div', 'frame');
  const railL = el('div', 'rail l');
  const centre = el('div', 'centre');
  const railR = el('div', 'rail r');
  const status = el('div', 'status');
  frame.append(railL, centre, railR);
  app.append(skip, topHost, frame, status);

  /* viewport header */
  const vhead = el('div', 'vhead');
  const crumb = el('div', 'crumb');
  const views = el('div', 'seg');
  const viewBtns = new Map();
  for (const [id, label] of [['front', 'Front'], ['right', 'Right'], ['top', 'Top'], ['iso', 'Iso']]) {
    const b = el('button', null, label);
    b.onclick = () => { viewport.setView(id); page.setActiveView(id); };
    views.appendChild(b);
    viewBtns.set(id, b);
  }
  const gridBtn = headBtn('grid', 'Ground grid · g', () => toggle('ui.grid'));
  const frustBtn = headBtn('frustum', 'Camera frustums', () => { toggle('ui.frustums'); page.syncCameras(); });
  const isoBtn = headBtn('isolate', 'Isolate selection · i', () => actions.isolate());
  const fitBtn = headBtn('fit', 'Frame selection · z', () => actions.frame());
  /* Only ever visible in the narrow layout: below the width at which the two rails and a
     640 px viewport all fit, the INSPECTOR is the rail that becomes an overlay drawer (the
     tree is the navigation and stays), and this is its handle. */
  const inspBtn = headBtn('cube', 'Inspector', () => page.setInspectorDrawer(!page.inspectorOpen));
  inspBtn.hidden = true;
  const poseHost = el('span', 'posehost');
  vhead.append(crumb, el('div', 'sp'), poseHost, views, gridBtn, frustBtn, isoBtn, fitBtn, inspBtn);
  const checkHead = el('div', 'checkhead');
  const checkSide = el('div', 'checkside');
  const checkTable = el('div', 'checktable');

  /* canvas */
  const canvasHost = el('div', 'canvas');
  const canvas = document.createElement('canvas');
  canvas.id = 'rps-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Robot viewport');
  const tag = el('div', 'tag');
  tag.hidden = true;
  const loadbar = el('div', 'loadbar');
  loadbar.appendChild(document.createElement('i'));
  const live = el('div', 'sr');
  live.setAttribute('aria-live', 'polite');
  canvasHost.append(canvas, tag, loadbar, live);
  const stage = el('div', 'stage');
  stage.append(canvasHost, checkSide);
  centre.append(vhead, checkHead, stage, checkTable);
  root.appendChild(app);

  function headBtn(ico, title, fn) {
    const b = el('button', 'btn icon ghost');
    b.appendChild(icon(ico, 'i14'));
    b.title = title;
    b.setAttribute('aria-label', title.split(' · ')[0]);
    b.onclick = fn;
    return b;
  }
  function toggle(path) { store.set(path, !store.get(path)); page.renderChrome(); }

  /* the viewport */
  const viewport = createViewport(canvas, {
    host: canvasHost, theme: theme(), groundZ: model.groundZ
  });
  const picking = createPicking(viewport, {
    roots: () => [viewport.robotRoot],
    meshesFor: (id) => (meshes.get(id) ? [meshes.get(id)] : []),
    labelFor: (id) => page.labelFor(id),
    blocked: () => anyDialogOpen() || page.menuOpen() || !!page.lookId
  });
  const gizmo = createGizmo(viewport, { picking });
  const frustums = createFrustums(viewport, { fill: true, footprints: false });
  picking.setGizmoBusy(() => gizmo.dragging || gizmo.handleDragging);

  /* the scene */
  configureGroups(model);

  for (const c of model.components) {
    if (!c.geometry) continue;
    const mesh = new THREE.Mesh(c.geometry, viewport.materials.get(roleOf(c)));
    mesh.name = c.id;
    mesh.matrixAutoUpdate = false;
    mesh.userData.componentId = c.id;
    mesh.userData.camClass = camClassOf(c, slots.slots[slotOwnerOf(model, slots, c.id)]);
    viewport.robotRoot.add(mesh);
    meshes.set(c.id, mesh);
  }
  picking.prepare(viewport.robotRoot);
  viewport.setGround(model.groundZ);

  const box = model.boundingBox({ visibleOnly: true });
  viewport.setHome({
    target: box.isEmpty() ? new THREE.Vector3(0, 40, 120) : box.getCenter(new THREE.Vector3()),
    distance: box.isEmpty() ? 900 : viewport.fitDistance(box.getSize(new THREE.Vector3()).length() / 2, 1.12),
    dir: [0.78, 0.86, 0.62]
  });
  viewport.resetView({ ms: 0 });
  viewport.start();
  loadbar.hidden = true;

  /* Publish what the frame and the scene just created, then install the collaborators.
     Each design-* module reads its shared state off this one mutable bag and installs its
     own methods onto it.  What keeps it cycle-free: no design-* module imports another —
     every cross-module call is `page.<name>()`, resolved at call time.
     ORDER MATTERS in exactly one way: a module that ASSIGNS another's method to a field
     (`ctx.on.export = page.doExport`) must run after it, which is why panels and
     the keymap are last. */
  Object.assign(page, { app, topHost, railL, railR, centre, canvasHost, canvas, vhead, crumb, status, views, tag, loadbar, live, checkHead, checkSide, checkTable, gridBtn, frustBtn, isoBtn, fitBtn, inspBtn, skip, viewport, picking, gizmo, frustums, toggle, headBtn });
  installContext(page);
  installScene(page);
  installOps(page);
  installAlternatives(page);
  installImport(page);
  installMenus(page);
  installChrome(page);
  installExport(page);
  installChecks(page);
  page.openExportSheet = () => openExportSheet(page);
  page.simAvailable = () => simSupport(model).teleop;
  installHistory(page);
  installMotion(page);
  installPanels(page);
  installKeymap(page);
  page.opsBar = mountActionBar(page);
  installAgent(page);

  const { ctx, actions } = page;
  /* the rail drag handles — `addGrip` is design-chrome's, so this waits for the installs */
  page.addGrip(railL, 'l');
  page.addGrip(railR, 'r');

  /* SETTLE THE DESIGN — the one function "Reset to defaults" and a loaded design JSON also
     call (`ui/design-history.js settleDesign`).  It pins every slot (the design's own
     choice, else the package default, inference only for a design that carries no slots
     map at all), re-derives slot-owned visibility from that — so an old autosave cannot draw
     two wrist mounts at once — and applies each option's parameters.
     Boot-time writes belong to the state the user STARTS from, not to an undo step:
     `markBaseline()` adopts them without an undo entry. */
  page.settleDesign({ baseline: true });
  /* the package's own fingertip, before any stored edit is reconciled — the datum every
     later measurement is an offset from */
  page.refreshFittedTip();
  /* An older autosave can name a preset this package does not declare.  Nothing throws,
     but the chip would name something that is not there, so replace it with the first
     real preset. */
  const savedPreset = store.get('ui.preset');
  if (!savedPreset || !page.presets.some((p) => (p.name || p.id) === savedPreset)) {
    store.set('ui.preset', (page.presets[0] || {}).name || 'stowed');
  }
  page.applyTheme(store.get('ui.theme', 'auto'));
  page.applyAll();
  page.setActiveView('iso');
  const offAfter = viewport.onAfterRender((t) => { page.strip.tick(t); });
  const offBefore = viewport.onBeforeRender(() => { page.refreshLookCamera(); });
  /* The only record of an imported alternative the design says is fitted is the IndexedDB
     cache written when it was imported.  Read it back and draw it. */
  const altBoot = (async () => {
    try {
      const cached = await pkg.listAltRecords(model.id);
      const byslot = new Map();
      for (const r of cached) {
        if (!slots.slots[r.slot]) continue;
        if (!byslot.has(r.slot)) byslot.set(r.slot, []);
        byslot.get(r.slot).push(r);
      }
      /* Register only what this design fits: the cache is every alternative this browser has
         seen for the robot, and re-offering all of it would resurrect cards the user has
         since unfitted.  The records and blobs stay cached, so re-fitting is a parse. */
      const boot = store.getState();
      for (const [sid, list] of byslot) {
        page.altCache.set(sid, list);
        const live = list.filter((r) => (boot.slots || {})[sid] === 'alt:' + r.id);
        if (!live.length) continue;
        slots.registerAlternatives(live, { slot: sid });
      }
      if (byslot.size) { page.reapplyAltShows(); if (page.tree) page.tree.render(); }
    } catch (e) { /* no IndexedDB */ }
    /* the cached cards are enough to put the camera back */
    page.adoptAllSlotCameras();
    if (page.destroyed) return null;
    const ids = await page.realizeFittedAlternatives();
    if (page.destroyed) return ids;
    page.adoptAllSlotCameras();
    page.syncCameras();
    return ids;
  })();
  const unsub = store.subscribe(() => { page.updateStatus(); page.checks(); if (page.topbar) page.topbar.render(); });
  window.addEventListener('resize', page.applyLayout);
  page.applyLayout();
  requestAnimationFrame(() => { viewport.resize(true); viewport.invalidate(); });

  return {
    ctx, viewport, picking, gizmo, frustums, meshes, actions, tree: page.tree, inspector: page.inspector, strip: page.strip, motion: page.motion, topbar: page.topbar,
    app, checkHead, checkSide, checkTable, presets: page.presets, syncMatrices: page.syncMatrices,
    gateKey: page.gateKey, checks: page.checks, checksNow: page.checksNow, onChecks: page.onChecks, setSweep: page.setSweep, openExportSheet: page.openExportSheet,
    simAvailable: () => page.simAvailable(), get destroyed() { return page.destroyed; },
    applyAll: page.applyAll, applyPose: page.applyPose, syncCameras: page.syncCameras, setStatus: page.setStatus, doExport: page.doExport,
    applyLayout: page.applyLayout, setInspectorDrawer: page.setInspectorDrawer,
    /* the alternatives seam: `altBoot` settles when the fitted alternative has been drawn */
    altBoot, ensureAltGeometry: page.ensureAltGeometry, realizeFittedAlternatives: page.realizeFittedAlternatives, altShipped: page.altShipped, printablesFiles: page.printablesFiles, plateName: page.plateName,
    /** exactly the file name `Export -> selected STL` writes for one component */
    exportNameOf(id) {
      const c = model.component(id);
      if (!c) return null;
      const shipped = page.altShipped(id);
      return stlName(shipped ? shipped.name : page.plateName(c) || c.label || id);
    },
    altComponents: () => [...altParts].map(([id, r]) => ({ id, slot: r.slot, alt: r.altId,
      print: r.print ? r.print.name : null,
      printable: !!(model.component(id) && model.component(id).printable),
      visible: !!(meshes.get(id) && meshes.get(id).visible) })),
    cycleTheme: page.cycleTheme, openMenu: page.openMenu, setJoint: page.setJoint, refreshFittedTip: page.refreshFittedTip, partOps: page.partOps,
    get opsBar() { return page.opsBar; }, partFolder: page.partFolder, savePartZip: page.savePartZip, agent: page.agent,
    /* the clamped preset path and the per-preset verdicts the pose popover marks with */
    applyPreset: page.applyPreset, presetPhysics: page.presetPhysics, pruneAlternatives: page.pruneAlternatives,
    setLookThrough: page.setLookThrough,
    get lookId() { return page.lookId; },
    destroy() {
      page.destroyed = true;
      unsub();
      window.removeEventListener('resize', page.applyLayout);
      clearTimeout(page.rebuildTimer);
      clearTimeout(page.statusTimer);
      clearTimeout(page.presetTimer);
      page.presetTimer = null;
      if (page.km) {
        window.removeEventListener('keydown', page.km.onKeyDown);
        window.removeEventListener('keyup', page.km.onKeyUp);
        window.removeEventListener('blur', page.km.releaseAll);
        window.removeEventListener('pagehide', page.km.releaseAll);
        page.km.releaseAll();
      }
      page.closeMenu();
      closeOptions();
      page.disposeChecks();
      /* the scrim lives on `document.body`, so emptying `#app` left the sheet over Home
         and the keyboard stuck in the `overlay` context (D1) */
      closeAnyDialog();
      offBefore(); offAfter();
      page.opsBar.destroy();
      page.agent.destroy();
      page.strip.destroy(); page.motion.destroy(); page.tree.destroy(); page.inspector.destroy(); page.topbar.destroy();
      picking.dispose();
      gizmo.dispose();
      frustums.dispose();
      try { cams.dispose(); } catch (e) { /* an older cameras build has none */ }
      for (const g of generated.values()) { try { g.dispose(); } catch (e) { /* shared */ } }
      generated.clear();
      meshes.clear();
      viewport.dispose();
      root.innerHTML = '';
    }
  };
}

