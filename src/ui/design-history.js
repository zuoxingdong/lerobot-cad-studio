/* applyAll, undo / redo, and the minimal reconciliation between them.  Undo hands back a
   CLONE of the design, so the slices are compared by value and only the parts of the scene
   that really moved are rebuilt — microseconds against the ~78 ms a full parametric rebuild
   costs.  Installed by ui/design-page.js. */

import { parametricComponentsOf } from '../features/parts.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installHistory(page) {
  const { store, model, slots } = page;

  /* boot */
  function applyAll() {
    /* "Reset to defaults" and a design loaded from JSON both land here with a slot map
       that may not name the alternative whose parts are on the robot */
    page.pruneAlternatives();
    page.applyVisibility();
    page.reconcileParts();
    page.refreshFittedTip();
    for (const cid of parametricComponentsOf(model)) page.rebuildParametric(cid, true);
    /* AFTER the rebuilds, so a generated part's own build pose is what a placement is
       remembered against, and BEFORE the pose, which draws whatever `c.local` says */
    page.applyStoredTransforms();
    page.applyPose();
    /* THE POSE OF EVERY CAMERA COMES FROM THE FITTED OPTION, so the one function that
       makes the scene agree with the design has to adopt them.  Leaving it to the async
       alternatives boot (and to `afterHistory`) let "Reset to defaults" leave the previous
       option's camera on the fitted mount. */
    page.adoptAllSlotCameras();
    page.syncCameras();
    page.renderChrome();
    if (page.tree) page.tree.render();
    if (page.inspector) page.inspector.render();
    page.updateStatus();
    page.appliedState = store.getState();
  }

  /**
   * Settle a design against the package — the ONE implementation, used by boot, "Reset to
   * defaults" and a design loaded from JSON.  Blanking `design.slots` and letting
   * `applyAll()` settle it instead pins nothing, so two options of one slot are drawn.
   *
   * It writes no undo entry of its own: the settle is not a change the user made, so the
   * caller says what the step was worth — `baseline` for boot and a loaded JSON, `commit`
   * for Reset, so one Ctrl+Z puts the whole design back.
   *
   * @param {{reset?:boolean, baseline?:boolean, commit?:string}} [opts]  `reset` also
   *        drops every camera override and the user's lens/calibration edits, so Reset
   *        really is a fresh boot.
   * @returns {boolean} whether the design changed
   */
  function settleDesign(opts = {}) {
    /* 1. the slots: the design's own choice where it has one, the package default where it
          does not, inference only for a design that carries no slots map at all */
    const r = slots.reconcile(store.getState());
    if (r.changed) {
      store.patch({ slots: r.design.slots, components: r.design.components, params: r.design.params });
    }
    /* 2. an alternative the settled slot map does not name takes its parts with it */
    page.pruneAlternatives();
    /* 3. the cameras: on a reset every part/slot override and every user lens edit goes,
          then the package's own declared calibration is seeded back.  `applyAll()` adopts
          the fitted options' poses immediately afterwards. */
    if (opts.reset && page.cams) {
      for (const id of page.cams.ids) { page.cams.reset(id); page.cams.resetCalib(id); }
      if (page.cams.clearOverride) page.cams.clearOverride();
    }
    page.seedCameraCalib();
    if (opts.commit) store.commit(opts.commit);
    else if (opts.baseline) store.markBaseline();
    return !!r.changed;
  }

  /* The state the scene was last reconciled with.  Undo/redo hands back a CLONE, so the
     slices have to be compared by value — they are small (a slot map, eight parameter
     objects, the overrides), microseconds against the 78 ms a full parametric rebuild
     costs. */
  const sameSlice = (a, b) => a === b || JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

  function changedParams(before, after) {
    const out = new Set();
    const A0 = (before && before.params) || {}, B0 = (after && after.params) || {};
    for (const id of new Set([...Object.keys(A0), ...Object.keys(B0)])) if (!sameSlice(A0[id], B0[id])) out.add(id);
    return out;
  }
  function ownersOfChangedSlots(before, after) {
    const out = new Set();
    const A0 = (before && before.slots) || {}, B0 = (after && after.slots) || {};
    for (const sid of new Set([...Object.keys(A0), ...Object.keys(B0)])) {
      if (A0[sid] === B0[sid]) continue;
      for (const cid of ((slots.slots[sid] || {}).owns) || []) out.add(cid);
    }
    return out;
  }

  /**
   * One step back or forward.  Diff the slices and touch only what the step changed: a full
   * `applyAll()` costs a parametric rebuild (~78 ms) plus the whole-design gate (~150 ms)
   * for a step that moved one joint.  The label has to be read BEFORE the move —
   * `history().future[0]` after an undo is the entry just pushed onto the REDO stack.
   */
  function doHistory(dir) {
    const h = store.history();
    const label = dir === 'undo' ? h.past[h.past.length - 1] : h.future[h.future.length - 1];
    const moved = dir === 'undo' ? store.undo() : store.redo();
    if (!moved) { page.setStatus(dir === 'undo' ? 'nothing to undo' : 'nothing to redo'); return false; }
    afterHistory(`${dir} · ${label || 'change'}`);
    return true;
  }
  function afterHistory(message) {
    const before = page.appliedState;
    const st = store.getState();
    /* UNDO IS A SWAP TOO.  `applySwap` re-adopts the slot's camera block; history did not, so
       undoing a swap put the previous mount back and left the top camera at the other
       mount's sensor — geometry and camera disagreeing, with nothing in the design saying why.  `adoptSlotCameras` is idempotent and a slot that publishes no camera
       clears its own override, so running it whenever `design.slots` moved is the whole fix. */
    if (!before) { applyAll(); page.adoptAllSlotCameras(); page.syncCameras(); }
    else {
      const slotsChanged = !sameSlice(before.slots, st.slots);
      /* `removed` rides with `components` on a delete, but a component that was already
         hidden when it was deleted moves ONLY `removed` — and the tree, the cameras and
         the gate all have to follow it anyway. */
      const removedChanged = !sameSlice(before.removed, st.removed);
      const compsChanged = !sameSlice(before.components, st.components) || removedChanged;
      const params = changedParams(before, st);
      const owned = slotsChanged ? ownersOfChangedSlots(before, st) : null;
      /* UNDO UNFITS.  An alternative's parts are not the package's: nothing re-derives
         them, so the step that takes one off the robot has to take its components, its
         collision bodies and its tree rows with it — and the step that puts one back has
         to ask for its geometry again (`ensureAltGeometry` is memoised per alternative,
         so a slot that never moved costs nothing). */
      /* `realizeFittedAlternatives` is deliberately not awaited here — undo must repaint
         now, and each `ensureAltGeometry` inside it carries its own catch. */
      if (slotsChanged) { page.pruneAlternatives(); void page.realizeFittedAlternatives(); }
      if (slotsChanged || compsChanged) page.applyVisibility();
      /* `design.components[id].transform` is read here or nowhere: undo restored the design
         but left the part 130 mm from the origin with no placement recorded for it.
         Unconditional, and cheap: `appliedState` can be older than the last placement (an
         import writes no history entry of its own), so a diff would skip the very step
         that has to be undone. */
      /* unconditional and cheap (a hash compare per edited part): `appliedState` can predate the edit */
      page.reconcileParts();
      page.applyStoredTransforms();
      if (params.size || (owned && owned.size)) {
        for (const cid of parametricComponentsOf(model)) {
          if (params.has(cid) || (owned && owned.has(cid))) page.rebuildParametric(cid, true);
        }
      }
      if (!sameSlice(before.joints, st.joints) || !sameSlice(before.base, st.base)
        || slotsChanged || compsChanged) page.applyPose();
      else page.syncMatrices();
      /* unconditional, and cheap: one pass over six slots, and a slot that publishes no camera
         clears its own override.  Making it depend on the slot diff is what let a stale
         `appliedState` strand the camera on an undone option. */
      page.adoptAllSlotCameras();
      if (slotsChanged || removedChanged || !sameSlice(before.cameras, st.cameras)) page.syncCameras();
      if (removedChanged) page.designStamp++;
      page.renderChrome();
      if (page.tree) page.tree.render();
      if (page.inspector) page.inspector.render();
      page.updateStatus();
      page.appliedState = st;
    }
    page.syncSelection();
    page.setStatus(message || 'undo');
  }

  Object.assign(page, {
    afterHistory, applyAll, settleDesign, changedParams, doHistory,
    ownersOfChangedSlots, sameSlice,
  });
}
