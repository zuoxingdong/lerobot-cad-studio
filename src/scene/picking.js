/* Hover, selection and the mouse model: hover outlines at most one
   raycast per frame, left click selects on pointer-up only if the pointer moved < 4 px,
   Shift extends, Ctrl/Cmd toggles, Alt cycles the hit list, double-click frames.
   Raycasts run against three-mesh-bvh bounds trees.  Needs three, three-mesh-bvh. */

import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

/* Patch once. acceleratedRaycast falls back to the stock raycast for any geometry with
   no bounds tree, so this is safe for every other mesh in the scene. */
let _patched = false;
function installBVH() {
  if (_patched) return;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  _patched = true;
}

export const CLICK_PX = 4;          // drag threshold, px
const CYCLE_PX = 6;          // how far the cursor may drift and still "be the same spot"

/* ------------------------------------------------------------------ pure helpers --
   These four functions carry all of the decision logic and are unit-tested in
   tests/scene/picking.test.mjs without a DOM or a GPU. */

/** Did this press/release pair count as a click? */
export function isClick(down, up, threshold = CLICK_PX) {
  if (!down || !up) return false;
  if (down.button !== up.button) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) <= threshold;
}

/** Has the pointer moved far enough to be a drag (and so cancel hover / the menu)? */
export function isDrag(down, x, y, threshold = CLICK_PX) {
  if (!down) return false;
  return Math.hypot(x - down.x, y - down.y) > threshold;
}

/**
 * The selection model. `current` and the result are arrays of component ids.
 *   'set'    replace with [id]            (plain click)
 *   'add'    append if absent             (Shift+click)
 *   'toggle' add or remove                (Ctrl/Cmd+click)
 * A null id with 'set' clears; with 'add'/'toggle' it is a no-op (only a plain
 * click on empty space clears).
 */
export function reduceSelection(current, id, mode = 'set') {
  const cur = current ? current.slice() : [];
  if (id == null) return mode === 'set' ? [] : cur;
  if (mode === 'add') return cur.includes(id) ? cur : cur.concat(id);
  if (mode === 'toggle') return cur.includes(id) ? cur.filter(x => x !== id) : cur.concat(id);
  return [id];
}

/**
 * Alt+click pick-through. `prev` is the previous cycle state ({x, y, i}) or null.
 * Returns { index, state }. The FIRST Alt+click at a fresh spot goes to the second hit
 * (index 1) — Alt means "the one behind" — and then walks the list, wrapping.
 */
export function cycleIndex(count, prev, x, y, radius = CYCLE_PX) {
  if (count <= 0) return { index: -1, state: null };
  const near = prev && Math.hypot(prev.x - x, prev.y - y) <= radius;
  const index = near ? (prev.i + 1) % count : (count > 1 ? 1 : 0);
  return { index, state: { x, y, i: index } };
}

/** Where to put the HTML hover tag, clamped inside the canvas rect. UI draws the node. */
export function tagPosition(rect, clientX, clientY, tagW = 170, tagH = 36, offset = 16) {
  const x = clientX - rect.left + offset;
  const y = clientY - rect.top + offset;
  const maxX = Math.max(6, rect.width - tagW - 6);
  const maxY = Math.max(6, rect.height - tagH - 6);
  /* If the tag would fall off the right/bottom edge, flip it to the other side of the
     cursor rather than letting it pile up in the corner. */
  const left = x > maxX ? Math.max(6, clientX - rect.left - tagW - offset) : Math.max(6, x);
  const top = y > maxY ? Math.max(6, clientY - rect.top - tagH - offset) : Math.max(6, y);
  return { left: Math.min(left, maxX), top: Math.min(top, maxY), flippedX: x > maxX, flippedY: y > maxY };
}

/* the factory */
/**
 * createPicking(viewport, opts)
 *
 * opts.roots        () => Object3D[]        what to raycast (default [viewport.robotRoot])
 * opts.resolve      (object) => id|null     component id for a hit (default walks userData)
 * opts.meshesFor    (id) => Mesh[]          meshes to outline for an id (default: subtree)
 * opts.labelFor     (id) => {title, sub}    what the hover tag says (UI may override)
 * opts.paint        boolean                 drive viewport.outlines (default true)
 * opts.enabled      boolean
 */
export function createPicking(viewport, opts = {}) {
  installBVH();
  const canvas = viewport.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;                    // three-mesh-bvh fast path
  const ndc = new THREE.Vector2();
  const rootInv = new THREE.Matrix4();
  const _n = new THREE.Vector3();
  const _m3 = new THREE.Matrix3();

  const listeners = new Map();
  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  }
  function emit(name, payload) {
    const s = listeners.get(name);
    if (s) for (const fn of s) fn(payload);
  }

  const state = {
    enabled: opts.enabled !== false,
    hover: null,            // target or null
    selection: [],          // component ids, [0] is the primary
    down: null,             // {x, y, button, t, moved, blocked}
    cycle: null,            // pick-through state
    suppress: false,        // one pointer-up belongs to a gizmo / handle drag
    pendingMove: null,
    rafId: 0,
    lastHoverT: 0
  };

  /* identity */
  const IDKEYS = ['componentId', 'pickId', 'partId', 'assetId', 'asmId', 'slotId'];
  function resolveId(object) {
    if (opts.resolve) return opts.resolve(object);
    for (let o = object; o; o = o.parent) {
      for (const k of IDKEYS) if (o.userData && o.userData[k] != null) return String(o.userData[k]);
    }
    return null;
  }
  /** Nearest ancestor (inclusive) that carries the id — the "piece" as a scene object. */
  function ownerOf(object) {
    if (opts.ownerOf) return opts.ownerOf(object);
    for (let o = object; o; o = o.parent) {
      for (const k of IDKEYS) if (o.userData && o.userData[k] != null) return o;
    }
    return object;
  }
  function meshesFor(id, object) {
    if (opts.meshesFor) return opts.meshesFor(id) || [];
    const owner = object ? ownerOf(object) : null;
    if (!owner) return [];
    if (owner.isMesh) return [owner];
    const out = [];
    owner.traverse(o => { if (o.isMesh && o.visible) out.push(o); });
    return out;
  }

  /* BVH bookkeeping */
  /** Build bounds trees for every mesh under `obj` that has none. Call after loading. */
  function prepare(obj, { minTriangles = 600 } = {}) {
    let built = 0, skipped = 0;
    (obj || viewport.robotRoot).traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      const tris = (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3;
      if (g.boundsTree) { skipped++; return; }
      if (tris < minTriangles) { skipped++; return; }   // a linear sweep is cheaper than the tree
      g.computeBoundsTree({ maxLeafTris: 10 });
      built++;
    });
    return { built, skipped };
  }
  function releaseBVH(obj) {
    (obj || viewport.robotRoot).traverse(o => {
      if (o.isMesh && o.geometry && o.geometry.boundsTree) o.geometry.disposeBoundsTree();
    });
  }

  /* raycasting */
  function visibleChain(o) { for (let n = o; n; n = n.parent) if (n.visible === false) return false; return true; }
  function pickableChain(o) { for (let n = o; n; n = n.parent) if (n.userData && n.userData.pickable === false) return false; return true; }

  function roots() { return (opts.roots ? opts.roots() : [viewport.robotRoot]) || []; }

  /**
   * All distinct pieces under the cursor, nearest first.
   *
   * `firstHitOnly` is three-mesh-bvh's fast path and it is per MESH, not per scene: the
   * ray still visits every mesh along it, it just stops at each mesh's nearest triangle.
   * Since the list is de-duplicated by component id straight away, keeping it on costs
   * the caller nothing and saves walking the full hit list of a 1.26 M-triangle scene on
   * every hover raycast.  It is restored around the call so
   * one pick can never leave the raycaster switched out of the fast path.
   */
  function hitsAt(clientX, clientY, { firstHitOnly = true } = {}) {
    viewport.pointerNDC({ clientX, clientY }, ndc);
    raycaster.setFromCamera(ndc, viewport.camera);
    const wasFirst = raycaster.firstHitOnly;
    raycaster.firstHitOnly = firstHitOnly;
    let hits;
    try { hits = raycaster.intersectObjects(roots(), true); }
    finally { raycaster.firstHitOnly = wasFirst; }
    rootInv.copy(viewport.root.matrixWorld).invert();
    const out = [];
    const seen = new Set();
    for (const h of hits) {
      const o = h.object;
      if (!o.isMesh || !visibleChain(o) || !pickableChain(o)) continue;
      const id = resolveId(o);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      out.push(makeTarget(h, id, clientX, clientY));
    }
    return out;
  }

  function makeTarget(hit, id, clientX, clientY) {
    const pointWorld = hit.point.clone();
    const point = pointWorld.clone().applyMatrix4(rootInv);
    let normalWorld = null, normal = null;
    if (hit.face) {
      _m3.getNormalMatrix(hit.object.matrixWorld);
      normalWorld = _n.copy(hit.face.normal).applyMatrix3(_m3).normalize().clone();
      normal = normalWorld.clone().applyQuaternion(viewport.qRoot.invert()).normalize();
    }
    return {
      id, componentId: id,
      object: hit.object,
      owner: ownerOf(hit.object),
      point, pointWorld,            // point is ROBOT mm, pointWorld is three world
      normal, normalWorld,          // same convention
      face: hit.face,
      faceIndex: hit.faceIndex,
      distance: hit.distance,
      screen: { x: clientX, y: clientY }
    };
  }

  /** One piece under the cursor. `through` = Alt held. */
  function pickAt(clientX, clientY, through) {
    const list = hitsAt(clientX, clientY);
    if (!list.length) { state.cycle = null; return null; }
    if (!through) { state.cycle = null; return list[0]; }
    const { index, state: next } = cycleIndex(list.length, state.cycle, clientX, clientY);
    state.cycle = next;
    return list[index] || list[0];
  }

  /* painting */
  const paint = opts.paint !== false;
  function paintHover() {
    if (!paint) return;
    const t = state.hover;
    const skip = t && state.selection.includes(t.id);
    viewport.outlines.set('hover', (!t || skip) ? [] : meshesFor(t.id, t.object));
    viewport.invalidate();
  }
  function paintSelection() {
    if (!paint) return;
    const meshes = [];
    for (const id of state.selection) {
      const ms = opts.meshesFor ? (opts.meshesFor(id) || []) : (selObjects.get(id) || []);
      for (const m of ms) meshes.push(m);
    }
    viewport.outlines.set('select', meshes);
    viewport.invalidate();
  }
  /* Without an opts.meshesFor the only way back from an id to its meshes is the object we
     picked, so remember it per selected id. */
  const selObjects = new Map();

  /* selection API */
  function setSelection(ids, { silent = false, objects = null } = {}) {
    const next = (ids || []).filter(Boolean);
    const same = next.length === state.selection.length && next.every((v, i) => v === state.selection[i]);
    state.selection = next;
    if (objects) for (const [k, v] of objects) selObjects.set(k, v);
    for (const k of [...selObjects.keys()]) if (!next.includes(k)) selObjects.delete(k);
    paintSelection();
    paintHover();
    if (!same && !silent) emit('selectionchange', { ids: next, primary: next[0] || null });
    return next;
  }
  function select(target, mode = 'set') {
    const id = target && typeof target === 'object' ? target.id : target;
    const next = reduceSelection(state.selection, id, mode);
    const objects = (target && typeof target === 'object' && target.object)
      ? [[id, meshesFor(id, target.object)]] : null;
    setSelection(next, { objects });
    emit('select', { id, target: typeof target === 'object' ? target : null, mode, ids: next });
    return next;
  }
  function clearSelection() { setSelection([]); }
  const isSelected = id => state.selection.includes(id);

  /* hover */
  function setHover(t) {
    const same = (!t && !state.hover) || (t && state.hover && t.id === state.hover.id);
    state.hover = t;
    canvas.style.cursor = t ? 'pointer' : '';
    if (!same) { paintHover(); emit('hover', t); }
    else if (t) emit('hovermove', t);
  }
  function clearHover() { if (state.hover || canvas.style.cursor) setHover(null); }

  /* Late-bound because the gizmo is created after picking (it takes `picking` itself). */
  let blockedFn = opts.blocked || null;
  let gizmoBusyFn = opts.gizmoBusy || null;
  function blocked() {
    if (!state.enabled) return true;
    if (blockedFn && blockedFn()) return true;
    return false;
  }
  /** setBlocked(() => driveOn || menuOpen() || helpOpen()) — suspend hover and select. */
  function setBlocked(fn) { blockedFn = fn || null; }
  /** setGizmoBusy(() => gizmo.dragging || !!gizmo.controls.axis) — a press that belongs
   *  to the gizmo must not also arm a selection. */
  function setGizmoBusy(fn) { gizmoBusyFn = fn || null; }

  /* One raycast per animation frame at most. */
  function scheduleHover(ev) {
    state.pendingMove = { x: ev.clientX, y: ev.clientY, alt: ev.altKey };
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      const m = state.pendingMove;
      state.pendingMove = null;
      if (!m || blocked()) return;
      if (state.down && state.down.moved) { clearHover(); return; }
      setHover(pickAt(m.x, m.y, false));
    });
  }

  /* DOM wiring */
  function onPointerMoveHover(ev) {
    if (ev.pointerType === 'touch') return;
    if (blocked() || (state.down && state.down.moved)) { clearHover(); return; }
    if (viewport.overViewHelper && viewport.overViewHelper(ev)) { clearHover(); return; }
    scheduleHover(ev);
  }
  function onPointerDown(ev) {
    state.down = {
      x: ev.clientX, y: ev.clientY, button: ev.button, t: performance.now(), moved: false,
      blocked: blocked() || (gizmoBusyFn ? gizmoBusyFn() : false)
    };
    emit('pointerdown', { event: ev, blocked: state.down.blocked });
  }
  function onPointerMoveDrag(ev) {
    if (state.down && isDrag(state.down, ev.clientX, ev.clientY)) state.down.moved = true;
  }
  function onPointerUp(ev) {
    const d = state.down;
    state.down = null;
    if (state.suppress) { state.suppress = false; return; }
    if (!d || d.button !== 0 || d.moved || d.blocked) return;
    if (blocked()) return;
    if (viewport.handleViewHelperClick && viewport.overViewHelper(ev)) {
      if (viewport.handleViewHelperClick(ev)) return;
    }
    const up = { x: ev.clientX, y: ev.clientY, button: ev.button };
    if (!isClick(d, up)) return;
    const t = pickAt(ev.clientX, ev.clientY, ev.altKey);
    if (t && state.intercept && state.intercept(t, ev)) return;
    const mode = ev.shiftKey ? 'add' : (ev.ctrlKey || ev.metaKey) ? 'toggle' : 'set';
    emit('click', { target: t, mode, event: ev });
    if (!t) { if (mode === 'set') { clearSelection(); emit('clickempty', { event: ev }); } return; }
    select(t, mode);
  }
  function onDblClick(ev) {
    if (blocked()) return;
    const t = pickAt(ev.clientX, ev.clientY, false);
    emit('dblclick', { target: t, event: ev });
    ev.preventDefault();
  }
  function onContextMenu(ev) {
    ev.preventDefault();
    if (blocked()) return;
    const d = state.down;
    if (d && d.moved) return;                        // that was a pan, not a click
    const t = pickAt(ev.clientX, ev.clientY, false);
    if (t && !isSelected(t.id)) select(t, 'set');
    emit('contextmenu', { target: t, event: ev, x: ev.clientX, y: ev.clientY });
  }
  function onPointerLeave() { clearHover(); }
  function onPointerCancel() { state.down = null; clearHover(); }

  canvas.addEventListener('pointermove', onPointerMoveHover);
  canvas.addEventListener('pointermove', onPointerMoveDrag);
  canvas.addEventListener('pointerdown', onPointerDown, true);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('contextmenu', onContextMenu, true);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointercancel', onPointerCancel);

  /* tag helper */
  /** Screen position for the HTML hover tag. The UI owns the node; this owns the maths. */
  function hoverTag(evOrTarget, size = {}) {
    const src = evOrTarget && evOrTarget.screen ? evOrTarget.screen : evOrTarget;
    if (!src) return null;
    const rect = canvas.getBoundingClientRect();
    const pos = tagPosition(rect, src.x ?? src.clientX, src.y ?? src.clientY,
      size.width ?? 170, size.height ?? 36, size.offset ?? 16);
    /* label the target we were handed (the hover event's), falling back to the live one */
    const t = (evOrTarget && evOrTarget.id != null) ? evOrTarget : state.hover;
    return {
      ...pos,
      id: t ? t.id : null,
      label: t && opts.labelFor ? opts.labelFor(t.id, t) : null
    };
  }

  function dispose() {
    canvas.removeEventListener('pointermove', onPointerMoveHover);
    canvas.removeEventListener('pointermove', onPointerMoveDrag);
    canvas.removeEventListener('pointerdown', onPointerDown, true);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('contextmenu', onContextMenu, true);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    if (state.rafId) cancelAnimationFrame(state.rafId);
    listeners.clear();
    if (paint) viewport.outlines.clearAll();
  }

  return {
    on, emit,
    get hover() { return state.hover; },
    get selection() { return state.selection.slice(); },
    get primary() { return state.selection[0] || null; },
    get enabled() { return state.enabled; },
    set enabled(v) { state.enabled = !!v; if (!v) clearHover(); },
    isSelected, select, setSelection, clearSelection, clearHover,
    setBlocked, setGizmoBusy,
    pickAt, hitsAt, hoverTag,
    prepare, releaseBVH,
    /** `fn(target, ev) => true` claims a click before it selects (a face pick). */
    setIntercept(fn) { state.intercept = fn || null; },
    /** Tell picking that this pointer-up belongs to a gizmo / handle drag, not to it. */
    suppressNext() { state.suppress = true; },
    dispose,
    /* exposed for tests and for the UI's own gating */
    _state: state
  };
}
