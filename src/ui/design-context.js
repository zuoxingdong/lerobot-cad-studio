/* The two objects the Design page is held together by — `page`, the mutable bag every
   design-* module installs itself onto, and `ctx`, the facade the panels get — plus
   installActions(page): select, hover, visibility, isolate, frame, swap, cycleSlot, preset
   and the `ctx.on.*` parameter-edit handlers.  Needs features/. */

import { visibilityFor, slotOwnerOf, isRemoved, emptyOptionOf, slotOptions } from '../features/slot-options.js';
import { makeCollision, createValidator, DEBOUNCE } from '../features/validate.js';
import { exportGate } from '../features/printcheck.js';
import { paramDefs, seededParams } from '../features/parts.js';
import { treeGroup } from './tree.js';
import { openOptions } from './options-list.js';
import { liveLabel } from '../features/hinge.js';
import { effectiveTheme, sourceLine } from './design-helpers.js';

/**
 * The shared mutable state of one mounted Design page.
 *
 * Everything a `design-*` module may read is a field here.  The IMMUTABLE half (the DOM
 * nodes, the viewport, the model, the maps) is filled by `mountDesign` before any module
 * installs, so a module may destructure it once; the MUTABLE half stays on `page` and is
 * always read through it.
 */
/** The MUTABLE bag: each design-* module reads the shared state off it and installs its own
 *  methods onto it, so a cross-module call is always `page.<name>()` and never a cycle. */
export function createPageState(o) {
  const page = {
    /* handed in */
    root: o.root, store: o.store, model: o.model, onHome: o.onHome,
    theme: () => effectiveTheme(o.store.get('ui.theme', 'auto')),

    /* DOM — filled by design-page.js once it has built the frame */
    app: null, topHost: null, railL: null, railR: null, centre: null,
    canvasHost: null, canvas: null, vhead: null, crumb: null, status: null,
    views: null, viewBtns: new Map(), tag: null, loadbar: null, live: null, motionHost: null,
    gridBtn: null, frustBtn: null, isoBtn: null, fitBtn: null, inspBtn: null, skip: null,

    /* scene — filled by design-page.js */
    viewport: null, picking: null, gizmo: null, frustums: null,
    meshes: new Map(),        // componentId -> THREE.Mesh
    generated: new Map(),     // componentId -> the geometry we built (to dispose)

    /* features */
    slots: null, cams: null, partOps: null, presets: [],
    collideWorld: null, validator: null,

    /* alternatives */
    altParts: new Map(),      // component id -> { slot, altId, print }
    altPending: new Map(),    // "<slot>/<altId>" -> Promise, so two swaps fetch once
    altExtras: new Map(),     // "<slot>/<altId>" -> [{name, bytes}] plates with no mesh
    altCache: new Map(),      // slot -> [alternative]
    altBoot: null,
    stlLoader: null,

    /* design-derived state */
    hingeT: null, hingeIds: null, // component id -> the hinge turn on its local (ui/design-ops.js)
    carry: null,              // what a stretch / scale moves: dependents, hinge origins, cameras (features/carry.js)
    opsBar: null,
    localBase: new Map(),     // component id -> the pose it had before a stored transform
    appliedState: null,       // the design the scene is showing, for design-history's diff
    padBaseline: null, padOffsetMM: 0,
    gateCache: null, gateIdent: null,
    designStamp: 0, destroyed: false,
    lookId: null, importN: 0, menuStack: [], rebuildTimer: null, statusTimer: null, presetTimer: null,
    fps: 60, inspectorOpen: false, narrowMotion: false,

    /* panels — filled after mount */
    topbar: null, tree: null, inspector: null, strip: null, motion: null,

    /* the facades */
    ctx: null, actions: null, km: null, kmActions: null,
  };
  return page;
}

/**
 * Build `page.ctx` — the facade every `src/ui/*` panel is handed — and `page.actions`.
 * Called by `mountDesign` once the scene exists and before any other module installs.
 * @param {object} page
 */
/** The read-only-ish facade the panels get: tree, inspector, camera tiles, the pose popover,
 *  the options list and dialogs all see this and never `page`. */
export function installContext(page) {
  const { store, model, canvas, viewport, picking, gizmo, frustums, slots, cams, meshes, theme } = page;

  /* the context */
  const ctx = {
    model, store, slots, cams, viewport, picking, gizmo, frustums,
    theme,
    selection: () => [store.get('ui.selected'), ...(store.get('ui.multi') || [])].filter(Boolean),
    visible: () => visibilityFor(model, slots, store.getState()),
    printer: () => store.get('ui.printer', 'bambu'),
    /* `makeCollision` answers null for a package with no kinematics — every caller here
       treats "no world" as "no physics", never as an error.  The zero-pose ignore list is
       asked for up front so the FIRST question is not answered about the zero pose. */
    collide: () => {
      if (page.collideWorld) return page.collideWorld;
      page.collideWorld = makeCollision(model, store.getState());
      return page.collideWorld;
    },
    validator: () => page.validator || (page.validator = createValidator({
      model, slots, cameras: cams, collide: ctx.collide(), printer: store.get('ui.printer', 'bambu') })),
    presets: () => page.presets,
    gizmoMode: () => store.get('ui.gizmo.mode', 'translate'),
    gizmoSnap: () => store.get('ui.gizmo.snap', 1),
    alternativesFor: (slotId) => page.altCache.get(slotId) || [],
    camerasAffectedBy: (...a) => page.camerasAffectedBy(...a),
    siblingIds: (...a) => page.siblingIds(...a),
    componentMenu: (...a) => page.componentMenu(...a),
    /* the slot a component really sits in — `component.slot` misses everything a slot
       claims through `attachment:<pkg>` (slot-options.slotOwnerOf) */
    slotOf: (id) => slotOwnerOf(model, slots, id),
    removeComponents: (...a) => page.removeComponents(...a), restoreComponents: (...a) => page.restoreComponents(...a), removeFromSlot: (...a) => page.removeFromSlot(...a),
    isRemoved: (id) => isRemoved(store.getState(), id),
    emptyOption: (slotId) => emptyOptionOf(slots, slotId),
    camCtx: (...a) => page.camCtx(...a),
    designReport: () => page.designReport(),
    /* what the tree is allowed to draw, and why — the inspector and the handles ask the
       same two questions */
    unfitted: () => slots.unfittedSet(store.getState()),
    treeGroupOf: (id) => treeGroup(model.component(id) || { id }),
    paramDefs: (id) => paramDefs(id),
    activePreset: () => store.get('ui.preset', null),
    /** the fitted option's label, its angle live ("None" when the slot is empty) */
    optionLabel: (sid) => {
      const st = store.getState();
      const s = slots.slots[sid];
      const oid = s ? slots.activeOption(st, sid) : null;
      let opt = null;
      try { opt = oid ? slots.option(sid, oid) : null; } catch (e) { opt = null; }
      const agent = String(oid || '').startsWith('alt:');
      if (!opt || (!agent && !(opt.shows || []).length)) return 'None';
      return liveLabel(model, st, opt, opt.label);
    },
    sourceLine: sourceLine(),
    gateReason: () => { const w = page.worstComponent(); return w ? w.reason : ''; },
    /* "Export anyway" lives in the Export sheet only.  UI state, not design state: it is not
       exported, and a passing design clears it. */
    exportAnyway: () => !!store.get('ui.exportAnyway'),
    setExportAnyway,
    /** the print verdict of what is selected right now, for the menu row that exports it */
    selectionGate: () => {
      const id = ctx.selection()[0];
      if (!id) return null;
      let pr = null;
      try { pr = ctx.validator().printOf(store.getState(), id); } catch (e) { return null; }
      const g = exportGate(pr);
      return { level: g.allowed ? (g.verdict || 'pass') : 'fail', reason: g.reason || '' };
    },
    on: {}
  };
  function setExportAnyway(on) {
    store.set('ui.exportAnyway', !!on);
    if (page.topbar) page.topbar.render();
    if (page.inspector) page.inspector.render();
    page.setStatus(on ? 'exporting failing parts anyway' : 'failing parts are held back again');
  }

  /* the actions */
  const actions = {
    select(id, mode = 'set') {
      const cur = ctx.selection();
      let next;
      if (mode === 'add') next = cur.includes(id) ? cur : [...cur, id];
      else if (mode === 'toggle') next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      else next = id ? [id] : [];
      store.patch({ ui: { selected: next[0] || null, multi: next.slice(1) } });
      picking.setSelection(next, { objects: next.map((x) => [x, [meshes.get(x)]]) });
      page.syncSelection();
    },
    /** a whole set at once (the crumb's "select all"), primary first */
    selectMany(ids) {
      const next = [...new Set(ids.filter(Boolean))];
      store.patch({ ui: { selected: next[0] || null, multi: next.slice(1) } });
      picking.setSelection(next, { objects: next.map((x) => [x, [meshes.get(x)]]) });
      page.syncSelection();
    },
    hover(id) {
      viewport.outlines.set('hover', id && meshes.get(id) ? [meshes.get(id)] : []);
      page.outlineSize();
      viewport.invalidate();
      if (page.tree) page.tree.setHover(id);
    },
    toggleVisible(id) {
      const vis = ctx.visible();
      store.set(['components', id, 'visible'], vis.get(id) === false, { label: 'visibility' });
    },
    isolate(id) {
      const cur = store.get('ui.isolate');
      const want = id || ctx.selection()[0];
      /* NOTHING SELECTED IS NOTHING TO ISOLATE.  `want` was `undefined`, which went into
         `ui.isolate`, vanished from the exported design and said nothing on screen. */
      if (!want) { page.setStatus('nothing selected — select a part, then I isolates it'); return; }
      store.set('ui.isolate', cur === want ? null : want);
      page.applyVisibility();
      page.renderChrome();
      if (page.tree) page.tree.render();
    },
    frame(id) {
      const ids = id ? [id] : ctx.selection();
      const objs = ids.map((x) => meshes.get(x)).filter(Boolean);
      if (objs.length) viewport.frameObjects(objs);
      else viewport.resetView();
    },
    swap(id, anchor) {
      const sid = slotOwnerOf(model, slots, id);
      if (!sid) { page.setStatus('no alternatives for this component'); return; }
      openOptions(anchor, ctx, sid, { prefer: id, onPreview: ctx.on.previewOption });
    },
    /** the same popover, addressed by SLOT — what an emptied slot's tree row opens. */
    swapSlot(slotId, anchor, prefer) {
      if (!slots.slots[slotId]) return;
      openOptions(anchor || canvas, ctx, slotId, { prefer, onPreview: ctx.on.previewOption });
    },
    /** a slot row: every drawn part of the fitted option */
    selectSlot(slotId) {
      const st = store.getState();
      let opt = null;
      try { opt = slots.option(slotId, slots.activeOption(st, slotId)); } catch (e) { opt = null; }
      const vis = ctx.visible();
      const ids = ((opt && opt.shows) || []).filter((x) => meshes.get(x) && vis.get(x) !== false && !isRemoved(st, x));
      if (ids.length) actions.selectMany(ids);
      else actions.swapSlot(slotId);
    },
    /* The index must come from the option that is RESOLVED as fitted,
       not from the `active` flag: `slotOptions()` clears it on the option whenever one of
       its parametric variants is the exact match ("exactly one card reads fitted"), and
       `findIndex` then answered −1, so every press landed back on the option already on
       the robot and `[` / `]` did nothing. */
    cycleSlot(delta, variants) {
      const id = ctx.selection()[0];
      const sid = id && slotOwnerOf(model, slots, id);
      if (!sid) return;
      const st = store.getState();
      const list = slotOptions(model, slots, st, sid, id)
        .filter((o) => (variants ? o.kind === 'variant' : o.kind !== 'variant'));
      if (!list.length) return;
      const activeId = slots.activeOption(st, sid);
      let i = list.findIndex((o) => o.active);
      if (i < 0) i = list.findIndex((o) => o.id === activeId);
      if (i < 0) i = 0;
      const next = list[(i + delta + list.length) % list.length];
      if (!next || next.id === list[i].id) return;
      page.applySwap(sid, next);
    },
    /**
     * Pose the arm at one of the package's presets.
     *
     * `design-motion.js applyPreset` moves the arm joint by joint through `clampJoint`.
     * Patching `design.joints` with the preset's whole `q` and calling `applyPose()`
     * would be the one path that skips the clamp every slider, key and jog goes through,
     * so a preset could drive the arm through the chassis in silence.
     */
    preset(pid) { return page.applyPreset(pid); }
  };

  /* param edits */
  ctx.on.setParam = (componentId, key, value, commit) => {
    store.set(['params', componentId, key], value,
      { label: `${componentId}.${key}`, coalesce: !commit });
    clearTimeout(page.rebuildTimer);
    page.rebuildTimer = setTimeout(() => page.rebuildParametric(componentId), commit ? 0 : DEBOUNCE.build_ms);
  };
  /* back to what a load seeds, so a save after a reset is its own reload */
  ctx.on.resetParams = (componentId) => {
    const seeded = seededParams(store.getState(), componentId, slots);
    if (seeded) store.set(['params', componentId], seeded, { label: 'reset ' + componentId });
    else store.remove('params.' + componentId, { label: 'reset ' + componentId });
    page.rebuildParametric(componentId);
    if (page.inspector) page.inspector.render();
  };
  ctx.on.handles = (on) => { gizmo.setHandlesVisible(on); page.refreshHandles(); };
  ctx.on.highlightHandle = (cid, key, on) => { void cid; void key; gizmo.setHandlesVisible(on || store.get('ui.handles', true) !== false); };
  ctx.on.focusHandle = (cid) => actions.frame(cid);
  /* a printer change re-measures every print verdict: the inspector, the checks, the sheet */
  ctx.on.setPrinter = (id) => {
    store.set('ui.printer', id);
    ctx.validator().setPrinter(id);
    page.renderChrome();
    if (page.inspector) { page.inspector.invalidatePrinter(); page.inspector.render(); }
  };
  /* swap */

  page.ctx = ctx;
  page.actions = actions;
  Object.assign(page, { setExportAnyway });
}
