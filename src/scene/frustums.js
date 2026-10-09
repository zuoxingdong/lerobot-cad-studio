/* The camera frustum layer of the viewport: the frustum wireframes / ground footprints / PiP
   renders drawn under the robot root, and the class ID pass through them.
   Needs three, scene/frustum-math.js and scene/id-pass.js. */

import * as THREE from 'three';
import { specOf, frustumCorners, groundFootprint } from './frustum-math.js';
import { idPass } from './id-pass.js';

export {
  CLASS_COLORS, imageRay, frustumCorners, groundFootprint, projectPoint, hFovToV, vFovToH,
} from './frustum-math.js';

/* createFrustums */
/**
 * createFrustums(viewport, opts)
 *
 *   set(id, spec)          spec = { matrix|matrixRobot, hfov_deg, aspect, near, far,
 *                                   color, label, visible }
 *   remove(id) / clear()
 *   setVisible(id, bool) / setAll(bool)
 *   setFootprints(bool) / setFill(bool)
 *   camera(id)             a THREE.PerspectiveCamera under robotRoot, kept in sync
 *   renderPip(id|camera, target, opts)
 *   idPass(camera, tagFn, opts)
 */
export function createFrustums(viewport, opts = {}) {
  const renderer = viewport.renderer;
  const groundZ = () => (opts.groundZ != null ? opts.groundZ : viewport.groundZ);

  const group = new THREE.Group();
  group.name = 'frustums';
  group.userData.pickable = false;
  group.userData.camClass = null;
  viewport.overlayRoot.add(group);

  /* A grid drawn ONLY inside the PiPs: a synthetic view of a bare floor is unreadable. */
  const pipGrid = new THREE.Group();
  pipGrid.name = 'pipGrid';
  pipGrid.userData.pickable = false;
  pipGrid.userData.camClass = null;
  pipGrid.visible = false;
  viewport.overlayRoot.add(pipGrid);
  (function buildPipGrid() {
    const pts = [], half = 1200, step = 100;
    for (let i = -half; i <= half; i += step) pts.push(i, -half, 0, i, half, 0, -half, i, 0, half, i, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7d8794, transparent: true, opacity: 0.55 }));
    l.userData.pickable = false; l.userData.camClass = null;
    pipGrid.add(l);
  })();

  const entries = new Map();     // id -> { spec, group, wire, fill, foot, footLine, camera }
  let showFootprints = opts.footprints !== false;
  let showFill = !!opts.fill;
  const paletteFor = i => [tokenColor('--frustum'), 0x46a08b, 0xd08a3c, 0xb0566e, 0x7a68b8][i % 5];
  function tokenColor(name) {
    const c = viewport.tokens[name];
    try { return new THREE.Color(c).getHex(); } catch (e) { return 0x5b8fd6; }
  }

  function wirePositions(spec) {
    const c = frustumCorners(spec);
    const o = new THREE.Vector3().setFromMatrixPosition(specOf(spec).matrix);
    const seg = [];
    const push = (a, b) => seg.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (let i = 0; i < 4; i++) { push(c[i], c[(i + 1) % 4]); push(c[4 + i], c[4 + ((i + 1) % 4)]); push(c[i], c[4 + i]); }
    for (let i = 0; i < 4; i++) push(o, c[i]);          // the little pyramid at the lens
    /* an up-tick on the far plane's top edge so image "up" is unambiguous */
    const topMid = c[6].clone().add(c[7]).multiplyScalar(0.5);
    const botMid = c[4].clone().add(c[5]).multiplyScalar(0.5);
    push(topMid, topMid.clone().add(topMid.clone().sub(botMid).multiplyScalar(0.12)));
    return seg;
  }
  function fillPositions(spec) {
    const c = frustumCorners(spec);
    const pos = [];
    const quad = (a, b, cc, d) => { pos.push(a.x, a.y, a.z, b.x, b.y, b.z, cc.x, cc.y, cc.z, a.x, a.y, a.z, cc.x, cc.y, cc.z, d.x, d.y, d.z); };
    for (let i = 0; i < 4; i++) quad(c[i], c[(i + 1) % 4], c[4 + ((i + 1) % 4)], c[4 + i]);
    quad(c[4], c[5], c[6], c[7]);
    return pos;
  }
  /* Rewrite a position buffer in place when the vertex count is unchanged — which it is
     for every frustum whose intrinsics did not change.  A pose change on a joint drag
     then costs one `needsUpdate` flag instead of a dispose + allocate + GL upload. */
  function writePositions(geo, arr, normals) {
    const a = geo.getAttribute('position');
    if (a && a.array.length === arr.length) { a.array.set(arr); a.needsUpdate = true; }
    else geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    if (normals) geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  /** the drawn pyramid: `viewFar` shortens it without touching the camera's real far plane */
  function drawSpecOf(e) {
    const s = e.spec;
    return e.raw && e.raw.viewFar ? { ...s, far: Math.min(s.far, e.raw.viewFar) } : s;
  }

  /* The ground quad is a THREE.Shape whose corner COUNT changes with the pose (a camera
     that tips past the horizon has three corners, or none), so it cannot be rewritten in
     place — it is rebuilt, but only while footprints are actually drawn. */
  function buildFootprint(e) {
    for (const k of ['foot', 'footLine']) {
      const o = e[k];
      if (!o) continue;
      e.group.remove(o);
      o.geometry.dispose();
      o.material.dispose();
      e[k] = null;
    }
    e.footDirty = false;
    const fp = e.footprint;
    if (!fp || fp.polygon.length < 3) return;
    const color = e.color;
    const shape = new THREE.Shape(fp.polygon.map(p => new THREE.Vector2(p.x, p.y)));
    const fg = new THREE.ShapeGeometry(shape);
    fg.translate(0, 0, groundZ() + 1.2);
    e.foot = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false, toneMapped: false
    }));
    e.footLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(fp.polygon.map(p => new THREE.Vector3(p.x, p.y, groundZ() + 1.4))),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4, toneMapped: false }));
    for (const o of [e.foot, e.footLine]) { o.userData.pickable = false; o.userData.camClass = null; o.visible = showFootprints; }
    e.group.add(e.foot, e.footLine);
  }

  /** Push this entry's spec into its buffers.  Skipped (and deferred) while it is hidden. */
  function flush(e) {
    if (!e.dirty) return;
    e.dirty = false;
    const drawSpec = drawSpecOf(e);
    writePositions(e.wire.geometry, wirePositions(drawSpec));
    if (e.fill) writePositions(e.fill.geometry, fillPositions(drawSpec), true);
    e.footprint = groundFootprint(e.spec, groundZ(), opts.footprintOpts);
    if (showFootprints) buildFootprint(e);
    else e.footDirty = true;
  }

  function set(id, spec) {
    const prev = entries.get(id);
    /* a re-set keeps its palette slot: `remove()` empties `entries`, so
       `paletteFor(entries.size)` would give every frustum the same colour after a theme change */
    const index = prev ? prev.index : entries.size;
    remove(id);
    const s = specOf(spec);
    const color = spec.color != null ? new THREE.Color(spec.color).getHex() : paletteFor(index);
    const g = new THREE.Group();
    g.name = 'frustum:' + id;
    g.userData.pickable = false; g.userData.camClass = null;

    const wire = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
    wire.userData.pickable = false; wire.userData.camClass = null;
    g.add(wire);

    let fill = null;
    if (showFill) {
      fill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.055, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false
      }));
      fill.userData.pickable = false; fill.userData.camClass = null;
      g.add(fill);
    }

    group.add(g);
    const cam = camera(id);
    applyToCamera(cam, s);
    const e = { spec: s, raw: spec, color, index, group: g, wire, fill, foot: null, footLine: null,
      footprint: null, camera: cam, dirty: true, footDirty: true };
    entries.set(id, e);
    if (spec.visible === false) g.visible = false;
    flush(e);
    viewport.invalidate();
    return e;
  }

  /**
   * update(id, spec) — the same argument as `set`, applied to the entry that is already
   * there.  Nothing is disposed and nothing is allocated: the pyramid's vertices are
   * rewritten in place and the synthetic camera takes the new matrix, so a joint drag
   * costs no GL buffer churn.  A hidden frustum only records the spec (its camera still
   * tracks, because the PiPs render through it) and is redrawn when it is shown.
   * Falls back to `set` for a first spec or a change of shape (the fill toggle).
   */
  function update(id, spec) {
    const e = entries.get(id);
    if (!e || (!!e.fill !== !!showFill)) return set(id, spec);
    const s = specOf(spec);
    if (spec.color != null) {
      const color = new THREE.Color(spec.color).getHex();
      if (color !== e.color) {
        e.color = color;
        for (const o of [e.wire, e.fill, e.foot, e.footLine]) if (o) o.material.color.setHex(color);
      }
    }
    e.spec = s;
    e.raw = spec;
    e.dirty = true;
    if (spec.visible !== undefined) e.group.visible = spec.visible !== false;
    applyToCamera(e.camera, s);
    if (e.group.visible) flush(e);
    viewport.invalidate();
    return e;
  }

  function remove(id) {
    const e = entries.get(id);
    if (!e) return false;
    e.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    group.remove(e.group);
    entries.delete(id);
    /* the synthetic camera is part of the entry: leaving it in `cams`/`robotRoot` leaked
       one PerspectiveCamera per remove() and kept a stale matrix for renderPip */
    const cam = cams.get(id);
    if (cam) { viewport.robotRoot.remove(cam); cams.delete(id); }
    viewport.invalidate();
    return true;
  }
  function clear() { for (const id of [...entries.keys()]) remove(id); }

  function setVisible(id, v) {
    const e = entries.get(id);
    if (!e) return;
    e.group.visible = !!v;
    if (e.group.visible) flush(e);          // it was hidden while the pose moved
    viewport.invalidate();
  }
  function setAll(v) {
    group.visible = !!v;
    if (group.visible) for (const e of entries.values()) if (e.group.visible) flush(e);
    viewport.invalidate();
  }
  function setFootprints(v) {
    showFootprints = !!v;
    for (const e of entries.values()) {
      if (showFootprints && e.footDirty) { if (!e.footprint) e.footprint = groundFootprint(e.spec, groundZ(), opts.footprintOpts); buildFootprint(e); }
      if (e.foot) e.foot.visible = showFootprints;
      if (e.footLine) e.footLine.visible = showFootprints;
    }
    viewport.invalidate();
  }
  function setFill(v) { showFill = !!v; const specs = [...entries].map(([id, e]) => [id, { ...e.raw, color: e.raw.color != null ? e.raw.color : e.color }]); for (const [id, s] of specs) set(id, s); }

  /* synthetic cameras */
  const cams = new Map();
  function camera(id) {
    let c = cams.get(id);
    if (!c) {
      c = new THREE.PerspectiveCamera(50, 4 / 3, 10, 9000);
      c.name = 'cam:' + id;
      c.matrixAutoUpdate = false;
      c.userData.pickable = false;
      /* inside robotRoot, which is the ROBOT-millimetre frame.  The driven base pose is in
         the matrices themselves now (`model.setBasePose`), not in this group. */
      viewport.robotRoot.add(c);
      cams.set(id, c);
    }
    return c;
  }
  /** Push a spec onto a THREE.PerspectiveCamera (matrix + intrinsics). */
  function applyToCamera(cam, spec) {
    const s = specOf(spec);
    cam.matrix.copy(s.matrix);
    cam.matrix.decompose(cam.position, cam.quaternion, cam.scale);
    cam.matrixWorldNeedsUpdate = true;
    cam.fov = s.vfov;
    cam.aspect = s.aspect;
    cam.near = s.near;
    cam.far = s.far;
    cam.updateProjectionMatrix();
    return cam;
  }

  /* PiP */
  /* What must not appear inside a synthetic camera view: the viewport's registry
     (grid, axes, outlines, gizmos, handles — see viewport.hideInPip()), our own frustum
     wireframes, and anything the caller adds. */
  function pipHideList() {
    const l = [group, ...viewport.pipHidden];
    if (opts.hideInPip) for (const o of opts.hideInPip()) l.push(o);
    return l.filter(Boolean);
  }

  /**
   * renderPip(idOrCamera, target, opts)
   *   target: a DOM element, a rect { x, y, width, height } in CSS px from the canvas
   *           TOP-left, or a THREE.WebGLRenderTarget.
   * Returns the rect actually used (or the target).
   */
  function renderPip(idOrCamera, target, o = {}) {
    const cam = idOrCamera && idOrCamera.isCamera ? idOrCamera : camera(idOrCamera);
    const hide = pipHideList();
    const prev = hide.map(x => x.visible);
    const prevGrid = pipGrid.visible;
    for (const x of hide) x.visible = false;
    /* the room backdrop and anything else the DESIGN view hides but a camera must see
       (viewport.pipOnly) — on for the duration of this render only */
    const show = [...(viewport.pipOnly || [])].filter((x) => x && x.userData.pipVisible);
    const prevShow = show.map(x => x.visible);
    for (const x of show) x.visible = true;
    pipGrid.visible = o.grid !== false;
    pipGrid.position.z = groundZ() + 0.4;
    try {
      if (target && target.isWebGLRenderTarget) {
        const savedTarget = renderer.getRenderTarget();
        const savedView = renderer.getViewport(new THREE.Vector4());
        /* NO setViewport here.  `renderer.setViewport()` is in CSS px — three multiplies it
           by `_pixelRatio` — while a render target's width/height are DEVICE px.  On a 2x
           display `setViewport(0, 0, target.width, target.height)` therefore set a GL
           viewport of 2w x 2h on a w x h framebuffer and the tile captured the bottom-left
           QUADRANT of the camera frame, magnified: the robot appeared shoved to the top
           right of every PiP.  `setRenderTarget()` already sets the viewport from
           `target.viewport`, which is the target's own full size in device px. */
        renderer.setRenderTarget(target);
        renderer.setScissorTest(false);
        const draw = () => { renderer.clear(true, true, true); renderer.render(viewport.scene, cam); };
        if (viewport.neutral) viewport.neutral(draw); else draw();
        renderer.setRenderTarget(savedTarget);
        renderer.setViewport(savedView);        // CSS px again, for the canvas
        return target;
      }
      const rect = rectOf(target);
      if (!rect || rect.width < 8 || rect.height < 8) return null;
      /* GL coordinates count from the bottom-left of the drawing buffer */
      const x = Math.round(rect.x);
      const y = Math.round(viewport.height - rect.y - rect.height);
      renderer.setScissorTest(true);
      renderer.setViewport(x, y, Math.round(rect.width), Math.round(rect.height));
      renderer.setScissor(x, y, Math.round(rect.width), Math.round(rect.height));
      renderer.clear(true, true, false);
      renderer.render(viewport.scene, cam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, viewport.width, viewport.height);
      return rect;
    } finally {
      /* plain visibility restores only — never invalidate() from inside a render hook. */
      hide.forEach((x, i) => { x.visible = prev[i]; });
      show.forEach((x, i) => { x.visible = prevShow[i]; });
      pipGrid.visible = prevGrid;
    }
  }
  function rectOf(t) {
    if (!t) return null;
    if (t.getBoundingClientRect) {
      const cr = viewport.renderer.domElement.getBoundingClientRect();
      const br = t.getBoundingClientRect();
      return { x: br.left - cr.left, y: br.top - cr.top, width: br.width, height: br.height };
    }
    return { x: t.x || 0, y: t.y || 0, width: t.width, height: t.height };
  }

  /* theme */
  function setTheme() {
    const specs = [...entries].map(([id, e]) => [id, e.raw]);
    for (const [id, s] of specs) set(id, s);
  }

  function dispose() {
    clear();
    viewport.overlayRoot.remove(group);
    pipGrid.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    viewport.overlayRoot.remove(pipGrid);
    for (const c of cams.values()) viewport.robotRoot.remove(c);
    cams.clear();
  }

  return {
    group, pipGrid,
    set, update, remove, clear, setVisible, setAll, setFootprints, setFill, setTheme, dispose,
    camera, applyToCamera, renderPip,
    get ids() { return [...entries.keys()]; },
    get(id) { return entries.get(id) || null; },
    footprint: (id) => {
      const e = entries.get(id);
      if (!e) return null;
      if (e.dirty) { e.footprint = groundFootprint(e.spec, groundZ(), opts.footprintOpts); }
      return e.footprint;
    },
    /** ID pass over this viewport's scene: each object painted with its class colour. */
    idPass: (cameraOrId, tagFn, o) =>
      idPass(renderer, viewport.scene, cameraOrId && cameraOrId.isCamera ? cameraOrId : camera(cameraOrId), tagFn, o)
  };
}
