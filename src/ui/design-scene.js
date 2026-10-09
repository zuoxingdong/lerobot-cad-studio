/* The design -> scene reconciliation: everything that takes the design (slots, params,
   components and base pose; `design.parts` is ui/design-ops.js) and makes the three.js scene agree with it, plus the
   four Placement actions the inspector offers.  Installed by ui/design-page.js. */

import * as THREE from 'three';
import * as placement from '../features/placement.js';
import { visibilityFor } from '../features/slot-options.js';
import { rebuildComponent } from '../features/parts.js';
import { cameraSpec, cameraBuildFrame } from '../features/camera-frame.js';
import { adoptSlotOption } from '../features/cameras.js';
import { cameraAdjuster } from '../features/hinge.js';
import { tipReach, tipPoint } from '../features/tip.js';
import { fingertipPads } from '../features/gripper.js';
import { cssVar, roleOf, CAM_COLOR } from './design-helpers.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installScene(page) {
  const { store, model, centre, tag, live, viewport, gizmo, frustums, slots, cams, meshes, generated, altParts, ctx } = page;

  /* placement */
  /**
   * Remember where a part sat BEFORE the design first moved it.  `design.components[id]
   * .transform` is the only record of a placement, so undoing back past the first move has
   * to have somewhere to put the part down — the package's own pose, or an import's.
   */
  function captureLocalBase(id) {
    const c = model.component(id);
    if (c && c.local && !page.localBase.has(id)) page.localBase.set(id, c.local.clone());
  }

  /**
   * `design.components[id].transform` → `c.local`, the mesh and the collision body.
   *
   * The design is the only record of a placement: undo and load read it back from here.
   * A transform that is gone puts the part back on its captured base.
   * @returns {number} how many parts moved
   */
  function applyStoredTransforms() {
    const over = store.getState().components || {};
    const hinge = page.hingeT || new Map();
    const ids = new Set([...Object.keys(over), ...page.localBase.keys(), ...(page.hingeIds || [])]);
    const m = new THREE.Matrix4();
    let n = 0;
    for (const id of ids) {
      const c = model.component(id);
      if (!c || !c.local) continue;
      captureLocalBase(id);
      const t = (over[id] || {}).transform;
      let want = Array.isArray(t) && t.length === 16 ? m.fromArray(t) : page.localBase.get(id);
      if (hinge.has(id)) want = want.clone().multiply(hinge.get(id));
      if (!c.local.elements.every((v, i) => v === want.elements[i])) { c.local.copy(want); n++; }
      /* unconditional: the body also has to follow a delete or a restore, which move no
         matrix at all */
      page.syncImportedBody(id);
    }
    if (n) syncMatrices();
    return n;
  }

  /**
   * A part moved into the robot is reported the way a blocked joint is — the same sentence,
   * and only while "Stop at collisions" is on.  The three write paths (the gizmo, the Placement fields
   * and the four Placement buttons) all end here, so they cannot disagree.
   * @returns {string|null} the sentence, or null when it is clear
   */
  function warnPlacementHit(id) {
    const w = store.get('ui.physics') !== false ? ctx.collide() : null;
    if (!w || !w.checkTransform) return null;
    let r = null;
    try {
      r = w.checkTransform(id, model.worldMatrix(id), null,
        { pose: store.getState().joints || {}, firstOnly: true });
    } catch (e) { return null; }
    if (!r || r.ok || !r.hits.length) { page.clearStatus('blocked'); return null; }
    const h = r.hits[0];
    const msg = `blocked · ${w.label(h.a)} hits ${w.label(h.b)}`;
    page.setStatus(msg, 'warn');
    return msg;
  }

  ctx.on.setPlacement = (id, patch) => {
    const c = model.component(id);
    if (!c) return;
    captureLocalBase(id);
    const m = c.local.clone();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    if (patch.position) p.fromArray(patch.position);
    if (patch.rotation) q.setFromEuler(new THREE.Euler(...patch.rotation.map((d) => (d * Math.PI) / 180), 'ZYX'));
    c.local.compose(p, q, s);
    if (patch.parent) { c.link = patch.parent === 'world' ? null : patch.parent; c.frame = c.link ? 'link' : 'robot'; }
    store.set(['components', id, 'transform'], storedLocal(id), { label: 'Move · ' + (c.label || id) });
    page.syncImportedBody(id);
    syncMatrices();
    warnPlacementHit(id);
    if (page.inspector) page.inspector.render();
  };
  /** `c.local` as the design stores it: without the hinge turn applyStoredTransforms adds */
  function storedLocal(id) {
    const c = model.component(id);
    const H = page.hingeT && page.hingeT.get(id);
    return (H ? c.local.clone().multiply(H.clone().invert()) : c.local).toArray();
  }
  ctx.on.gizmoMode = (mode) => { store.set('ui.gizmo.mode', mode); gizmo.setMode(mode); };
  ctx.on.gizmoSnap = (i) => {
    store.set('ui.gizmo.snap', i);
    gizmo.setSnap({ mm: [1, 5, 20][i], deg: [5, 15, 90][i] });
  };
  /**
   * The four Placement buttons.  THE MATHS IS features/placement.js: it boxes the geometry
   * through the part's WORLD matrix, so a rotated part still lands on the floor, and it
   * snaps to the package's own `frames.deck_grid` instead of a hard-coded 20 mm / 57 mm.
   * The result comes back as a world matrix and is stored in the parent's frame.
   */
  ctx.on.placementAction = (id, action) => {
    const c = model.component(id);
    if (!c || !c.geometry) return;
    captureLocalBase(id);
    const P = placement;
    const world = model.worldMatrix(id);
    let r = null;
    if (action === 'ground') r = P.dropToGround(model, c.geometry, world);
    else if (action === 'deck') r = P.dropToDeck(model, c.geometry, world);
    else if (action === 'centerx') r = P.centreX(c.geometry, world, 0);
    else if (action === 'grid') {
      r = P.snapToGrid(model, c.geometry, world);
      if (!r.ok) { page.setStatus(r.why, 'warn'); return; }
    }
    if (!r) return;
    c.local.copy(P.toLocal(model, c.link || 'world', r.world));
    store.set(['components', id, 'transform'], storedLocal(id), { label: action });
    page.syncImportedBody(id);
    syncMatrices();
    warnPlacementHit(id);
    if (page.inspector) page.inspector.render();
    if (action === 'grid') page.setStatus(`snapped to the deck hole at ${r.hole.map((n) => n.toFixed(0)).join(', ')} mm`);
  };

  /* design -> scene */
  function applyPose() {
    const st = store.getState();
    model.setBasePose(st.base || null);
    model.setJoints(st.joints || {});
    syncMatrices();
    syncCameras();
    if (page.motion) page.motion.render();
    page.updateStatus();
  }

  function applyVisibility() {
    const st0 = store.getState();
    const vis = visibilityFor(model, slots, st0);
    /* An alternative's parts are DERIVED state, exactly like a package option's: visible while
       that alternative is the slot's choice, gone the moment it is not.  Deriving it here (and
       not from the component's own last-painted flag) is what stops a swap away from the mast
       leaving it standing, and a swap back from finding it hidden. */
    for (const [id, rec] of altParts) {
      const fitted = st0.slots && st0.slots[rec.slot] === 'alt:' + rec.altId;
      const over = ((st0.components || {})[id] || {}).visible;
      vis.set(id, !!fitted && !((st0.removed || {})[id]) && over !== false);
    }
    /* ISOLATE NAMES A PART THAT IS ON THE ROBOT.  Swapping its option away left the id in
       `ui.isolate` with no mesh to highlight, so the whole robot rendered as a grey ghost
       and only the "Isolated" pill got the user out of it. */
    const iso0 = store.get('ui.isolate');
    if (iso0 && (!model.component(iso0) || vis.get(iso0) === false)) {
      store.set('ui.isolate', null);
      if (page.setStatus) page.setStatus('isolate cleared · that part is not on the robot any more');
      if (page.renderChrome) page.renderChrome();
    }
    const iso = store.get('ui.isolate');
    for (const [id, mesh] of meshes) {
      const on = vis.get(id) !== false;
      mesh.visible = on;
      const dim = iso && id !== iso;
      const c = model.component(id);
      const override = ((store.get('components') || {})[id] || {}).color;
      viewport.materials.assign(mesh, dim ? viewport.materials.get('ghost')
        : override ? viewport.materials.forColor(override, roleOf(c || {}))
          : viewport.materials.get(roleOf(c || {})));
      if (model.component(id)) model.component(id).visible = on;
    }
    if (page.collideWorld) { try { page.collideWorld.setActiveFromDesign(store.getState()); } catch (e) { /* keep */ } }
    viewport.invalidate();
  }

  function syncMatrices() {
    /* Every moving part is a real link on a real joint — the PincOpen four-bar included, since
       its bars became `rod_*` / `rod2_*` links — so the model's world matrix is the whole
       answer and the renderer applies no corrections of its own. */
    for (const [id, mesh] of meshes) {
      const m = model.worldMatrix(id);
      if (!m) continue;
      mesh.matrix.copy(m);
      mesh.matrixWorldNeedsUpdate = true;
    }
    viewport.invalidate();
  }

  /** Rebuild one parametric component from its live parameters (features/parts.js). */
  function rebuildParametric(componentId, quiet) {
    const r = rebuildComponent(model, store.getState(), componentId);
    if (!r.ok || !r.geometry) { if (!quiet && r.error && r.error !== 'not parametric') page.setStatus('rebuild failed · ' + r.error, 'warn'); return; }
    const c = model.component(componentId);
    if (!c) return;
    const old = generated.get(componentId);
    generated.set(componentId, r.geometry);
    /* a mesh whose BUILD frame is not its ASSEMBLY frame says so with `place` (the camera
       retainer is generated lying on the print bed and bolts to the mast head) — without
       it the piece is drawn on the floor beside the robot */
    if (r.place && c.frame === 'robot' && !(store.get('components') || {})[componentId]?.transform) {
      c.local.copy(r.place);
    }
    /* the new base takes the part's op stack back on top (design-ops.js) */
    page.rebaseParts(componentId, r.geometry, r.base);
    if (old && old !== r.geometry) old.dispose();
    if (r.frames && Object.keys(r.frames).length) {
      /* only the FITTED part may move a camera: every variant of a slot is rebuilt at boot
         and on every swap, so the last one to run would otherwise win. */
      if (ctx.visible().get(componentId) !== false) {
        try {
          cams.registerFrames(r.frames, {
            frame: cameraBuildFrame(model, cams, componentId, r.frames), source: componentId });
        } catch (e) { /* no frame this build can adopt */ }
      } else if (cams.clearOverridesFrom) {
        cams.clearOverridesFrom(componentId);
      }
      syncCameras();
    }
    if (r.warnings && r.warnings.length && !quiet) page.setStatus(r.warnings[0], 'warn');
    refreshFittedTip();
    syncMatrices();
    if (page.inspector) page.inspector.repaintChips();
    if (page.tree) page.tree.render();
    viewport.invalidate();
  }

  /**
   * Re-measure the fitted fingertip and publish it as the slot anchor offset
   * (`slots.anchorOf`).
   * @returns {number} the offset in mm
   */
  function refreshFittedTip() {
    let m = null;
    try { m = tipReach(model); } catch (e) { m = null; }
    if (!m || !m.ok) return page.padOffsetMM;
    if (page.padBaseline === null) page.padBaseline = m.reach;
    page.padOffsetMM = m.reach - page.padBaseline;
    try {
      const pads = fingertipPads(model);
      const sid = (slots.slots && slots.slots.fingertips) ? 'fingertips' : (pads.ok ? pads.slot : null);
      if (sid && slots.setAnchorOffset && slots.slots[sid]) slots.setAnchorOffset(sid, [page.padOffsetMM, 0, 0]);
    } catch (e) { /* a package with no fingertip slot */ }
    return page.padOffsetMM;
  }

  /**
   * The fitted option owns the camera (features/camera-options.js holds the three rules).
   * `meta.frame` says which frame an option's camera pose is written in:
   *     "robot"        `cameras.<id>.local` is a robot-frame matrix, used as it stands
   *     "slot_anchor"  anchor · local, so an imported wrist mount rides the arm
   *     "attachment"   the attached package's frame, resolved through the anchor
   */
  function adoptSlotCameras(slotId) {
    if (!slotId || !cams) return [];
    let r = { moved: [], off: [] };
    const st = store.getState();
    try { r = adoptSlotOption(cams, slots, st, slotId, cameraAdjuster(model, st, page.carry)); } catch (e) { /* keep the pose */ }
    for (const id of r.moved) setCameraMounted(id, true);
    for (const id of r.off) setCameraMounted(id, false);
    return r.moved;
  }

  /** `design.cameras.<id>.enabled` — written without a history label, exactly like the
   *  boot-time calibration seed: it is DERIVED from the slot choice, not a user edit. */
  function setCameraMounted(camId, on) {
    if (!cams.has || !cams.has(camId)) return;
    const cur = ((store.getState().cameras || {})[camId] || {}).enabled;
    if (on) { if (cur === false) store.set(['cameras', camId, 'enabled'], true); return; }
    if (cur !== false) store.set(['cameras', camId, 'enabled'], false);
    /* NOTHING MOUNTS IT ANY MORE, so a measured as-installed offset describes a bracket
       that is not on the robot: the measurement goes with the mount. */
    if (!((store.getState().cameras || {})[camId] || {}).calib) return;
    try { cams.resetCalib(camId); } catch (e) { /* an older cameras build */ }
    store.remove(['cameras', camId, 'calib']);
  }

  /**
   * Adopt (or drop) EVERY slot's camera block — needed at boot as well as on a swap, because
   * a reload can open with an alternative already fitted.  The workspace listing arrives
   * after boot, so this runs again then; it is idempotent.
   */
  function adoptAllSlotCameras() {
    const moved = [];
    for (const sid of Object.keys(slots.slots || {})) {
      for (const id of adoptSlotCameras(sid) || []) moved.push(id);
    }
    syncCameras();
    if (page.strip) page.strip.render();
    return moved;
  }

  function syncCameras() {
    const st = store.getState();
    const show = !!st.ui.frustums;
    /* LOOK-THROUGH NEEDS A MOUNT.  Swapping the mast away (or hiding the camera) leaves the
       viewport rendering through a camera nothing poses any more: a frozen frame, no orbit
       and a HUD of stale chips.  Whatever unmounts it drops look-through back to the orbit. */
    let dropLook = false;
    for (const id of cams.ids) {
      const over = (st.cameras || {})[id] || {};
      if (over.hfov_deg) cams.setHfov(id, over.hfov_deg);
      /* the AS-INSTALLED offset is design state, never a part parameter */
      if (over.calib) cams.setCalib(id, over.calib);
      const spec = cameraSpec(cams, model, st, id, camCtx());
      if (!spec || !spec.matrix || over.enabled === false) { if (id === page.lookId) dropLook = true; }
      if (!spec || !spec.matrix) { frustums.setVisible(id, false); continue; }
      frustums.update(id, {
        matrix: spec.matrix, hfov_deg: spec.hfov_deg, aspect: spec.aspect,
        near: spec.near, far: spec.far, viewFar: 700,
        color: cssVar(CAM_COLOR[id] || '--accent'),
        visible: show && over.enabled !== false
      });
    }
    frustums.setFootprints(!!st.ui.footprints);
    if (dropLook && page.strip) {
      const gone = page.lookId;
      page.strip.lookThrough(null);
      page.setStatus(`${gone} is not mounted any more — back to the design view`, 'warn');
    }
    viewport.invalidate();
  }

  /**
   * `design.cameras.<id>.calib` — the AS-INSTALLED offset, seeded once from what the
   * package measured (`manifest.cameras[i].verified`).
   * It lives in the design so the user can see and edit it; it is applied in
   * `cameras.getPose()` and NEVER written back to a part parameter, or a calibration
   * would silently edit the STL.
   */
  function seedCameraCalib() {
    const st = store.getState();
    for (const id of cams.ids) {
      const have = ((st.cameras || {})[id] || {}).calib;
      if (have) { cams.setCalib(id, have); continue; }
      const d = cams.calibDefault(id);
      if (!d || (!d.tilt_deg && !d.roll_deg)) continue;
      store.set(['cameras', id, 'calib'], { tilt_deg: d.tilt_deg, roll_deg: d.roll_deg });
    }
  }

  function camCtx() {
    return {
      renderer: viewport.renderer, scene: viewport.scene,
      robotRoot: viewport.robotRoot,
      tag: (o) => (o && o.userData ? (o.userData.camClass !== undefined ? o.userData.camClass : 'robot') : null),
      tip: tipPoint(model),
      groundZ: model.groundZ
    };
  }

  Object.assign(page, {
    adoptAllSlotCameras, adoptSlotCameras, applyPose, applyStoredTransforms, applyVisibility,
    camCtx, captureLocalBase, rebuildParametric, refreshFittedTip, storedLocal,
    seedCameraCalib, setCameraMounted, syncCameras, syncMatrices, warnPlacementHit,
  });
}
