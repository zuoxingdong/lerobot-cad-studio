/* Two kinds of direct manipulation on the canvas: the transform gizmo (a wrapper around
   three's TransformControls with snap steps, axis/plane constraints and onChange/onCommit)
   and the param handles that drag one numeric parameter of a parametric part.
   All anchors, axes and limits are in the ROBOT frame, millimetres.  Needs three. */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export const MODES = ['translate', 'rotate', 'scale'];
export const PLANES = { xy: [1, 1, 0], xz: [1, 0, 1], yz: [0, 1, 1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], all: [1, 1, 1] };

/* ------------------------------------------------------------------ pure helpers -- */
/** Quantise a dragged value to its step and clamp to [min, max]. */
export function quantise(value, { min = -Infinity, max = Infinity, step = 0 } = {}) {
  let v = value;
  if (step > 0) v = Math.round(v / step) * step;
  v = Math.min(max, Math.max(min, v));
  /* kill 1e-15 dust from the division above */
  return step > 0 ? +v.toFixed(Math.max(0, Math.ceil(-Math.log10(step)) + 2)) : v;
}

/**
 * How far a pointer drag of (dx, dy) CSS pixels moved along a direction whose screen
 * projection is `dpx` pixels per unit. Returns units (mm, or degrees for an arc).
 */
export function dragAmount(dx, dy, dpx) {
  const l2 = dpx.x * dpx.x + dpx.y * dpx.y;
  if (l2 < 1e-9) return 0;
  return (dx * dpx.x + dy * dpx.y) / l2;
}

/* ------------------------------------------------------------------ handle meshes -- */
function handleMesh(kind, color, ghost) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color, depthTest: !ghost, depthWrite: !ghost, transparent: true,
    opacity: ghost ? 0.30 : 0.95, toneMapped: false
  });
  if (kind === 'rotate') {
    g.add(new THREE.Mesh(new THREE.TorusGeometry(9, 1.3, 8, 32, Math.PI * 1.35), mat));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(2.6, 6, 10), mat);
    tip.position.set(9, 0, 0); tip.rotation.z = -Math.PI / 2;
    g.add(tip);
  } else {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 13, 8), mat);
    shaft.position.y = 6.5; g.add(shaft);
    const a = new THREE.Mesh(new THREE.ConeGeometry(2.8, 6.5, 12), mat);
    a.position.y = 15; g.add(a);
    const b = new THREE.Mesh(new THREE.ConeGeometry(2.8, 6.5, 12), mat);
    b.position.y = -2; b.rotation.z = Math.PI; g.add(b);
  }
  g.traverse(o => { o.renderOrder = 999; o.userData.pickable = false; o.userData.camClass = null; });
  return g;
}

function axisVector(a) {
  if (Array.isArray(a)) return new THREE.Vector3(a[0], a[1], a[2]).normalize();
  if (a && a.isVector3) return a.clone().normalize();
  return a === 'x' ? new THREE.Vector3(1, 0, 0)
    : a === 'y' ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
}

/* createGizmo */
/**
 * createGizmo(viewport, opts)
 *   opts.parent    Object3D for the param handles (default viewport.robotRoot)
 *   opts.picking   the picking module, so a drag's pointer-up never selects
 *   opts.onChange / opts.onCommit   defaults for the transform gizmo
 */
/**
 * Where a param handle points.  The anchor and the drag direction are both taken through
 * the part frame `F`, so the DRAWN arrow (local +Y) or arc normal (local +Z) has to be
 * too: orienting from the unrotated axis pointed the arrow one way while dragging moved
 * the part another, for any handle whose `frame` carries a rotation.
 * @returns {{axisLocal: THREE.Vector3, axisRobot: THREE.Vector3, quaternion: THREE.Quaternion}}
 */
export function handleOrientation(axis, frame, kind) {
  const axisLocal = axisVector(axis || 'z');
  const F = frame && frame.isMatrix4 ? frame : new THREE.Matrix4();
  const axisRobot = axisLocal.clone().transformDirection(F);
  const from = kind === 'rotate' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  return { axisLocal, axisRobot, quaternion: new THREE.Quaternion().setFromUnitVectors(from, axisRobot) };
}

export function createGizmo(viewport, opts = {}) {
  const canvas = viewport.renderer.domElement;
  const parent = opts.parent || viewport.robotRoot;

  /* 1. transform gizmo */
  const tc = new TransformControls(viewport.camera, canvas);
  const helper = typeof tc.getHelper === 'function' ? tc.getHelper() : tc;
  helper.visible = false;
  helper.traverse(o => { o.userData.pickable = false; o.userData.camClass = null; });
  helper.renderOrder = 1500;
  viewport.scene.add(helper);
  viewport.hideInPip(helper);          // a robot camera cannot see its own gizmo
  tc.setSize(0.85);

  const cbs = { change: new Set(), commit: new Set(), dragging: new Set() };
  if (opts.onChange) cbs.change.add(opts.onChange);
  if (opts.onCommit) cbs.commit.add(opts.onCommit);
  const fire = (set, payload) => { for (const fn of set) fn(payload); };

  let attached = null;
  let snap = { mm: 1, deg: 5, scale: 0.05 };
  let fine = false;              // Shift = un-snapped / fine
  let dragStart = null;

  tc.addEventListener('dragging-changed', e => {
    viewport.controls.enabled = !e.value;
    if (e.value) {
      dragStart = attached ? attached.matrix.clone() : null;
      viewport.hold('gizmo');
    } else {
      viewport.release('gizmo');
      if (opts.picking) opts.picking.suppressNext();
      if (attached) {
        attached.updateMatrix();
        fire(cbs.commit, { object: attached, mode: tc.mode, matrix: attached.matrix.clone(), from: dragStart });
      }
      dragStart = null;
    }
    fire(cbs.dragging, { dragging: e.value, object: attached, mode: tc.mode });
    viewport.invalidate();
  });
  tc.addEventListener('objectChange', () => {
    if (!attached) return;
    attached.updateMatrix();
    fire(cbs.change, { object: attached, mode: tc.mode, matrix: attached.matrix.clone() });
    viewport.invalidate();
  });
  tc.addEventListener('change', () => viewport.invalidate());

  function applySnap() {
    tc.setTranslationSnap(fine || !snap.mm ? null : snap.mm);
    tc.setRotationSnap(fine || !snap.deg ? null : THREE.MathUtils.degToRad(snap.deg));
    tc.setScaleSnap(fine || !snap.scale ? null : snap.scale);
  }
  applySnap();

  function attach(object) {
    attached = object || null;
    if (attached) { tc.attach(attached); helper.visible = true; }
    else { tc.detach(); helper.visible = false; }
    viewport.invalidate();
    return attached;
  }
  const detach = () => attach(null);

  function setMode(mode) { if (MODES.includes(mode)) { tc.setMode(mode); viewport.invalidate(); } return tc.mode; }
  function setSpace(space) { tc.setSpace(space === 'local' ? 'local' : 'world'); viewport.invalidate(); return tc.space; }
  function setSnap(next) { snap = { ...snap, ...next }; applySnap(); return { ...snap }; }
  function setFine(v) { fine = !!v; applySnap(); }
  /**
   * Constrain the gizmo. `plane` is one of PLANES, expressed in the ATTACHED OBJECT's
   * frame when space is 'local' (which is how a prop on the floor gets 'xy' = the robot's
   * ground plane), or in three's world axes when space is 'world'.
   */
  function setPlane(plane) {
    const p = PLANES[plane] || PLANES.all;
    tc.showX = !!p[0]; tc.showY = !!p[1]; tc.showZ = !!p[2];
    viewport.invalidate();
    return plane;
  }
  /** Hard translation limits, in the gizmo's working space. */
  function setLimits({ minX, maxX, minY, maxY, minZ, maxZ } = {}) {
    if (minX !== undefined) tc.minX = minX; if (maxX !== undefined) tc.maxX = maxX;
    if (minY !== undefined) tc.minY = minY; if (maxY !== undefined) tc.maxY = maxY;
    if (minZ !== undefined) tc.minZ = minZ; if (maxZ !== undefined) tc.maxZ = maxZ;
  }
  function clearLimits() {
    tc.minX = -Infinity; tc.maxX = Infinity; tc.minY = -Infinity; tc.maxY = Infinity;
    tc.minZ = -Infinity; tc.maxZ = Infinity;
  }

  /* 2. param handles */
  const handleGroup = new THREE.Group();
  handleGroup.name = 'paramHandles';
  handleGroup.renderOrder = 999;
  handleGroup.userData.pickable = false;
  handleGroup.userData.camClass = null;
  parent.add(handleGroup);
  viewport.hideInPip(handleGroup);
  let handles = [];
  let hDrag = null;
  let handleColor = new THREE.Color(viewport.tokens['--accent-hi'] || '#3f6fe6');

  /**
   * setHandles(defs) — defs: [{
   *   id, kind: 'translate' | 'rotate',
   *   anchor: [x, y, z],           // in `frame`, default the robot frame
   *   axis:   'x' | 'y' | 'z' | [x, y, z],
   *   frame:  THREE.Matrix4,       // optional part placement, robot frame
   *   value, min, max, step,
   *   perMm,                       // value units per mm of pointer travel (default 1)
   *   onDrag(value, def), onCommit(value, def)
   * }]
   */
  function setHandles(defs) {
    clearHandles();
    handleColor.set(viewport.tokens['--accent-hi'] || '#3f6fe6');
    for (const d of (defs || [])) {
      if (!d || !Array.isArray(d.anchor)) continue;
      const obj = handleMesh(d.kind || 'translate', handleColor);
      obj.add(handleMesh(d.kind || 'translate', handleColor, true));
      const F = d.frame && d.frame.isMatrix4 ? d.frame : new THREE.Matrix4();
      const o = handleOrientation(d.axis || 'z', F, d.kind || 'translate');
      obj.quaternion.copy(o.quaternion);
      obj.position.fromArray(d.anchor).applyMatrix4(F);
      obj.userData.handle = {
        def: d,
        axisLocal: o.axisLocal,
        axisRobot: o.axisRobot,
        anchorRobot: obj.position.clone()
      };
      handleGroup.add(obj);
      handles.push(obj);
    }
    viewport.invalidate();
    return handles.length;
  }
  function clearHandles() {
    for (const h of handles) h.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    handleGroup.clear();
    handles = [];
  }
  function setHandlesVisible(v) { handleGroup.visible = !!v; viewport.invalidate(); }

  /* constant apparent size, like every CAD gizmo */
  const offSize = viewport.onBeforeRender(() => {
    if (!handles.length || !handleGroup.visible) return;
    const s = viewport.camera.position.distanceTo(viewport.controls.target) / 620;
    const k = Math.min(4, Math.max(0.35, s));
    for (const h of handles) h.scale.setScalar(k);
  });

  /* handle drag */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function screenOf(robotPoint) {
    return viewport.worldToScreen(robotPoint, { frame: 'robot' });
  }
  function onHandleDown(ev) {
    if (!handleGroup.visible || !handles.length || ev.button !== 0 || tc.dragging) return;
    viewport.pointerNDC(ev, ndc);
    ray.setFromCamera(ndc, viewport.camera);
    ray.firstHitOnly = false;
    const hit = ray.intersectObjects(handles, true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && !o.userData.handle) o = o.parent;
    if (!o) return;
    const H = o.userData.handle;
    /* screen direction of one unit of travel */
    let dir = H.axisRobot.clone();
    if ((H.def.kind || 'translate') === 'rotate') {
      /* the arc's screen tangent: axis x (anchor -> eye) */
      const eye = viewport.camera.position.clone().applyQuaternion(viewport.qRoot.invert());
      const view = eye.sub(H.anchorRobot).normalize();
      const t = new THREE.Vector3().crossVectors(H.axisRobot, view);
      if (t.lengthSq() > 1e-8) dir = t.normalize();
    }
    const p0 = screenOf(H.anchorRobot);
    const p1 = screenOf(H.anchorRobot.clone().add(dir));
    const dpx = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y);
    if (dpx.lengthSq() < 1e-8) return;
    hDrag = { H, x0: ev.clientX, y0: ev.clientY, dpx, start: Number(H.def.value) || 0 };
    viewport.controls.enabled = false;
    viewport.hold('handle');
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onHandleMove(ev) {
    if (!hDrag) return;
    const d = hDrag.H.def;
    const units = dragAmount(ev.clientX - hDrag.x0, ev.clientY - hDrag.y0, hDrag.dpx);
    const v = quantise(hDrag.start + units * (d.perMm ?? 1), d);
    if (v !== d.value) { d.value = v; if (d.onDrag) d.onDrag(v, d); viewport.invalidate(); }
  }
  function onHandleUp(ev) {
    if (!hDrag) return;
    const d = hDrag.H.def;
    hDrag = null;
    viewport.controls.enabled = true;
    viewport.release('handle');
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (opts.picking) opts.picking.suppressNext();
    if (d.onCommit) d.onCommit(d.value, d);
    viewport.invalidate();
  }
  canvas.addEventListener('pointerdown', onHandleDown, true);
  canvas.addEventListener('pointermove', onHandleMove);
  canvas.addEventListener('pointerup', onHandleUp);
  canvas.addEventListener('pointercancel', onHandleUp);

  /* theme */
  function setTheme() {
    handleColor.set(viewport.tokens['--accent-hi'] || '#3f6fe6');
    for (const h of handles) h.traverse(o => { if (o.material && o.material.color) o.material.color.copy(handleColor); });
    viewport.invalidate();
  }

  function dispose() {
    offSize();
    canvas.removeEventListener('pointerdown', onHandleDown, true);
    canvas.removeEventListener('pointermove', onHandleMove);
    canvas.removeEventListener('pointerup', onHandleUp);
    canvas.removeEventListener('pointercancel', onHandleUp);
    clearHandles();
    parent.remove(handleGroup);
    tc.detach();
    viewport.scene.remove(helper);
    tc.dispose();
  }

  return {
    controls: tc, helper, handleGroup,
    /* transform gizmo */
    attach, detach, setMode, setSpace, setSnap, setFine, setPlane, setLimits, clearLimits,
    get object() { return attached; },
    get mode() { return tc.mode; },
    get space() { return tc.space; },
    get dragging() { return tc.dragging || !!hDrag; },
    get snap() { return { ...snap }; },
    set visible(v) { helper.visible = !!v && !!attached; viewport.invalidate(); },
    get visible() { return helper.visible; },
    onChange(fn) { cbs.change.add(fn); return () => cbs.change.delete(fn); },
    onCommit(fn) { cbs.commit.add(fn); return () => cbs.commit.delete(fn); },
    onDragging(fn) { cbs.dragging.add(fn); return () => cbs.dragging.delete(fn); },
    /* param handles */
    setHandles, clearHandles, setHandlesVisible,
    get handles() { return handles.slice(); },
    get handleDragging() { return !!hDrag; },
    setTheme, dispose
  };
}
