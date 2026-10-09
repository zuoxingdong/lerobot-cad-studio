/* The canvas and everything true of it whatever robot is loaded: renderer, scene graph,
   camera and orbit controls, the orientation cube, framing, theme and render-on-demand.
   Needs three, its OrbitControls/ViewHelper addons, scene/materials.js and
   scene/scene-furniture.js. */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import { installFurniture } from './scene-furniture.js';
import { createMaterials, createOutlineLayer, TOKENS } from './materials.js';

export const DEFAULTS = {
  groundZ: -32.9,          // LeKiwi; every robot package overrides it via setGround()
  roomRadius: 3000,        // the backdrop walls, mm from the robot
  roomHeight: 2400,        // and their height, mm
  gridHalf: 1000,          // mm
  gridStep: 100,           // mm  (minor)
  gridMajor: 500,          // mm  (bold line every 5th)
  fov: 38,
  near: 1,
  far: 20000,
  minDistance: 60,
  maxDistance: 8000,
  pixelRatioCap: 2,
  shadows: false,
  preserveDrawingBuffer: true,   // screenshot() needs it
  viewHelper: true,
  reducedMotion: null            // null = ask the OS
};

/** Named views, in the ROBOT frame: [dirX, dirY, dirZ] from the target towards the eye. */
export const VIEWS = {
  front:  [0, 1, 0],      // the robot faces +Y, so "front" looks back down -Y
  back:   [0, -1, 0],
  right:  [1, 0, 0],
  left:   [-1, 0, 0],
  top:    [0, 0, 1],
  bottom: [0, 0, -1],
  iso:    [0.78, 0.86, 0.62],
  home:   [0.78, 0.86, 0.62]
};

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Build a clipping plane from a ROBOT-frame section spec and lift it into world space.
 *   spec = { axis: 'x'|'y'|'z', at: mm, flip } or a THREE.Plane already in robot mm.
 * Everything on the NEGATIVE side of the plane's normal is clipped away, so `flip`
 * chooses which half survives. Exported so it can be unit-tested without a GPU.
 */
export function sectionPlane(spec, rootMatrix) {
  if (!spec) return null;
  let plane;
  if (spec.isPlane) plane = spec.clone();
  else {
    const n = new THREE.Vector3(
      spec.axis === 'x' ? 1 : 0, spec.axis === 'y' ? 1 : 0, spec.axis === 'z' ? 1 : 0);
    if (n.lengthSq() === 0) n.set(0, 0, 1);
    const at = spec.at || 0;
    if (spec.flip) { n.negate(); plane = new THREE.Plane(n, at); }
    else plane = new THREE.Plane(n, -at);
  }
  if (rootMatrix) plane.applyMatrix4(rootMatrix);
  return plane;
}

/* createViewport */
export function createViewport(canvas, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const host = cfg.host || canvas.parentElement || canvas;
  const reduced = cfg.reducedMotion != null ? cfg.reducedMotion
    : (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* renderer */
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    preserveDrawingBuffer: cfg.preserveDrawingBuffer
  });
  const wantPixelRatio = () => Math.min(globalThis.devicePixelRatio || 1, cfg.pixelRatioCap);
  let pixelRatio = wantPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !!cfg.shadows;
  if (cfg.shadows) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  /* scene graph */
  const scene = new THREE.Scene();
  scene.name = 'studio';

  /* Every module speaks the ROBOT frame, mm, +X right / +Y forward / +Z up.  `root` is the
     ONLY place robot Z-up becomes three Y-up; nothing outside this file may rotate. */
  const root = new THREE.Group();
  root.name = 'root';
  root.rotation.x = -Math.PI / 2;              // robot +Z -> three +Y. The ONLY place.
  root.updateMatrixWorld(true);
  scene.add(root);
  const qRoot = root.quaternion.clone();
  const qRootInv = qRoot.clone().invert();

  /** Everything that belongs to the robot (and carries its driven base pose). */
  const robotRoot = new THREE.Group();
  robotRoot.name = 'robotRoot';
  root.add(robotRoot);

  /** Robot-frame overlays that must never be picked or tagged (frustums, reach disc…). */
  const overlayRoot = new THREE.Group();
  overlayRoot.name = 'overlays';
  overlayRoot.userData.pickable = false;
  overlayRoot.userData.camClass = null;
  root.add(overlayRoot);

  /* theme + materials */
  const materials = createMaterials({ theme: cfg.theme || 'light', element: cfg.themeElement });
  let tokens = materials.tokens;

  const F = installFurniture({
    root, robotRoot, scene, cfg, tokens: () => tokens, markDirty: () => { dirty = true; },
  });
  const { ground, groundMat, gridGroup, axes, backdrop, wallMat, horizon, horizonMat,
          lights, setRoom, setGround } = F;

  const camera = new THREE.PerspectiveCamera(cfg.fov, 1, cfg.near, cfg.far);
  camera.name = 'viewCamera';
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = cfg.minDistance;
  controls.maxDistance = cfg.maxDistance;
  controls.screenSpacePanning = true;

  const HOME = {
    target: new THREE.Vector3(0, 0, 100),      // robot frame
    distance: 900,
    dir: VIEWS.iso.slice()
  };
  if (cfg.home) Object.assign(HOME, cfg.home);

  /* orientation cube */
  /* ViewHelper drives the camera it is given. We hand it a PROXY that lives in the
     ROBOT frame, so its X / Y / Z labels and its snap views mean the robot's axes, not
     three's. world = qRoot * robot, so proxy = qRoot^-1 * camera.  */
  const proxy = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  let viewHelper = null;
  if (cfg.viewHelper && typeof document !== 'undefined') {
    viewHelper = new ViewHelper(proxy, canvas);
    viewHelper.setLabels('X', 'Y', 'Z');       // robot axes, thanks to the proxy
  }
  function syncProxyFromCamera() {
    proxy.position.copy(camera.position).applyQuaternion(qRootInv);
    proxy.quaternion.copy(qRoot).invert().multiply(camera.quaternion);
    if (viewHelper) viewHelper.center.copy(controls.target).applyQuaternion(qRootInv);
  }
  function syncCameraFromProxy() {
    camera.position.copy(proxy.position).applyQuaternion(qRoot);
    camera.quaternion.copy(qRoot).multiply(proxy.quaternion);
  }
  /** Forward a pointerup to the cube; returns true if it consumed the click. */
  function handleViewHelperClick(ev) {
    if (!viewHelper) return false;
    syncProxyFromCamera();
    const took = viewHelper.handleClick(ev);
    if (took) { hold('viewcube'); controls.enabled = false; invalidate(); }
    return took;
  }
  /** Is the pointer inside the cube's 128 px corner? (UI needs this to suppress picking) */
  function overViewHelper(ev) {
    if (!viewHelper) return false;
    const r = canvas.getBoundingClientRect();
    return ev.clientX >= r.right - 128 && ev.clientY >= r.bottom - 128;
  }

  /* outline layer */
  const outlines = createOutlineLayer({ scene, materials });

  /* Objects that must not appear inside a synthetic camera view (gizmos, param handles,
     annotations, anything the robot's own camera could not possibly see). frustums.js
     hides everything in this set for the duration of a PiP. */
  const pipHidden = new Set([gridGroup, axes, outlines.groups.hover, outlines.groups.select,
    outlines.groups.blocked, horizon]);
  function hideInPip(obj) { if (obj) pipHidden.add(obj); return obj; }
  function showInPip(obj) { pipHidden.delete(obj); }
  /* The mirror image of `pipHidden`: objects the DESIGN view must never show but a synthetic
     camera view must (the room backdrop).  `frustums.renderPip` and look-through turn each
     one on for the duration of their render, if `userData.pipVisible` is true. */
  const pipOnly = new Set([backdrop]);
  function onlyInPip(obj) { if (obj) { pipOnly.add(obj); obj.visible = false; } return obj; }

  /* section plane (optional) */
  /** setSectionPlane({ axis:'x'|'y'|'z', at: mm, flip }) or a THREE.Plane in ROBOT mm, or null. */
  let section = null;
  function setSectionPlane(spec) {
    section = sectionPlane(spec, root.matrixWorld);
    renderer.clippingPlanes = section ? [section] : [];
    invalidate();
    return section;
  }

  /* render-on-demand */
  let dirty = true;
  const holds = new Set();
  let running = false, rafId = 0, lastT = 0, drawnOnce = false;
  const beforeHooks = new Set();
  const afterHooks = new Set();
  const resizeHooks = new Set();
  let sizeW = 1, sizeH = 1;

  /* Render on demand: nothing renders until invalidate().  Continuous rendering happens
     only while a hold() is out or OrbitControls damping is still settling. */
  const invalidate = () => { dirty = true; };
  function hold(token) { holds.add(token); dirty = true; return () => release(token); }
  function release(token) { holds.delete(token); dirty = true; }
  const continuous = () => holds.size > 0;

  controls.addEventListener('change', invalidate);
  controls.addEventListener('start', () => hold('orbit'));
  controls.addEventListener('end', () => release('orbit'));

  function onBeforeRender(fn) { beforeHooks.add(fn); return () => beforeHooks.delete(fn); }
  function onAfterRender(fn) { afterHooks.add(fn); return () => afterHooks.delete(fn); }
  function onResize(fn) { resizeHooks.add(fn); return () => resizeHooks.delete(fn); }

  /* resize */
  function resize(force) {
    const w = Math.max(1, Math.round(host.clientWidth || canvas.clientWidth || canvas.width));
    const h = Math.max(1, Math.round(host.clientHeight || canvas.clientHeight || canvas.height));
    /* the pixel ratio is re-read on every resize: a browser zoom or a move to another monitor changes it */
    const dpr = wantPixelRatio();
    if (dpr !== pixelRatio) { pixelRatio = dpr; renderer.setPixelRatio(dpr); force = true; }
    if (!force && w === sizeW && h === sizeH) return false;
    sizeW = w; sizeH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    materials.setResolution(w, h);
    for (const fn of resizeHooks) fn(w, h);
    dirty = true;
    /* setSize() clears the drawing buffer. With the rAF loop stopped nothing would ever
       redraw it, so repaint right here. */
    if (!running && drawnOnce) render();
    return true;
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => resize()); ro.observe(host); }
  const onWinResize = () => resize();
  /* a DPI change need not change the CSS size of anything, so `resize` is asked for it
     directly; the query is re-armed each time because it names the ratio it was made at */
  let dprQuery = null;
  function watchDpr() {
    if (typeof matchMedia !== 'function') return;
    try {
      if (dprQuery && dprQuery.removeEventListener) dprQuery.removeEventListener('change', onDpr);
      dprQuery = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
      if (dprQuery.addEventListener) dprQuery.addEventListener('change', onDpr);
    } catch (e) { dprQuery = null; }
  }
  function onDpr() { resize(true); watchDpr(); }
  if (typeof window !== 'undefined') { window.addEventListener('resize', onWinResize); watchDpr(); }

  /* camera tween */
  let tween = null;
  function moveCamera(posRobot, targetRobot, ms = 260) {
    const p1 = posRobot.clone().applyQuaternion(qRoot);
    const g1 = targetRobot.clone().applyQuaternion(qRoot);
    if (reduced || !ms) {
      camera.position.copy(p1); controls.target.copy(g1); controls.update();
      tween = null; dirty = true; return;
    }
    tween = { p0: camera.position.clone(), p1, g0: controls.target.clone(), g1, t0: now(), ms };
    hold('tween');
  }
  function stepTween(t) {
    if (!tween) return;
    const k = Math.min(1, Math.max(0, (t - tween.t0) / tween.ms));
    const e = easeInOut(k);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.g0, tween.g1, e);
    dirty = true;
    if (k >= 1) { tween = null; release('tween'); }
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /* framing */
  /** Distance that fits a bounding sphere of radius r in BOTH axes of the frustum. */
  function fitDistance(r, margin = 1.25) {
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const d = Math.max(r / Math.sin(vFov / 2), r / Math.sin(hFov / 2)) * margin;
    return THREE.MathUtils.clamp(d, controls.minDistance + 1, controls.maxDistance - 1);
  }
  /** frame(box) — box is a THREE.Box3 in the ROBOT frame. */
  function frame(box, o = {}) {
    if (!box || typeof box.isEmpty !== 'function' || box.isEmpty()) return false;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, o.minRadius ?? 25);
    const dist = fitDistance(r, o.margin ?? 1.25);
    let dir;
    if (o.view && VIEWS[o.view]) dir = new THREE.Vector3(...VIEWS[o.view]).normalize();
    else {
      dir = camera.position.clone().sub(controls.target).applyQuaternion(qRootInv);
      if (dir.lengthSq() < 1e-6) dir.set(...VIEWS.iso);
      dir.normalize();
    }
    moveCamera(c.clone().add(dir.multiplyScalar(dist)), c, o.ms ?? 260);
    return true;
  }
  /** frameObjects(objs) — world-space Object3Ds; converted back into the robot frame. */
  function frameObjects(objs, o = {}) {
    const list = Array.isArray(objs) ? objs : [objs];
    const box = new THREE.Box3();
    let any = false;
    const b = new THREE.Box3();
    for (const ob of list) {
      if (!ob) continue;
      b.setFromObject(ob);
      if (b.isEmpty()) continue;
      box.union(b); any = true;
    }
    if (!any) return false;
    /* world -> robot */
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const robotBox = new THREE.Box3().setFromPoints(boxCorners(box).map(p => p.applyMatrix4(inv)));
    return frame(robotBox, o);
  }
  function boxCorners(box) {
    const out = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
      out.push(new THREE.Vector3(x, y, z));
    return out;
  }
  /** Snap to a named view, keeping the current target and distance. */
  function setView(name, o = {}) {
    const v = VIEWS[name] || VIEWS.iso;
    const tgt = (name === 'home' ? HOME.target.clone() : controls.target.clone().applyQuaternion(qRootInv));
    const dist = (name === 'home' ? HOME.distance : camera.position.distanceTo(controls.target));
    const dir = new THREE.Vector3(...v).normalize().multiplyScalar(dist);
    moveCamera(tgt.clone().add(dir), tgt, o.ms ?? 260);
    return true;
  }
  function resetView(o = {}) {
    const dir = new THREE.Vector3(...HOME.dir).normalize().multiplyScalar(HOME.distance);
    moveCamera(HOME.target.clone().add(dir), HOME.target.clone(), o.ms ?? 260);
  }
  /** Remember the current camera as Home (the UI calls this after loading a robot). */
  function setHome({ target, distance, dir } = {}) {
    if (target) HOME.target.copy(target);
    if (distance) HOME.distance = distance;
    if (dir) HOME.dir = dir.slice ? dir.slice() : [dir.x, dir.y, dir.z];
    return HOME;
  }
  /* theme */
  function setTheme(next) {
    const r = materials.setTheme(next);
    tokens = r.tokens;
    F.setColors();
    renderer.setClearColor(new THREE.Color(tokens['--viewer-bg']), 1);
    materials.setResolution(sizeW, sizeH);
    dirty = true;
    return r;
  }

  /* the camera views' fixed environment: light materials, ground and walls in either theme */
  const NEUTRAL = { bg: new THREE.Color(TOKENS.light['--viewer-bg']), bg2: new THREE.Color(TOKENS.light['--viewer-bg-2']) };
  function neutral(fn) {
    const wall = wallMat.color.clone(), floor = groundMat.color.clone();
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    wallMat.color.copy(NEUTRAL.bg); groundMat.color.copy(NEUTRAL.bg2);
    renderer.setClearColor(NEUTRAL.bg, 1);
    try { return materials.neutral(fn); } finally {
      wallMat.color.copy(wall); groundMat.color.copy(floor);
      renderer.setClearColor(clear, alpha);
    }
  }

  /* look-through */
  /* The main view rendered through one of the ROBOT's cameras instead of the orbit
     camera: same intrinsics, letterboxed to the camera's own aspect so nothing is
     stretched, orbit controls off, the design-view furniture (grid, axes, outlines,
     frustums) hidden and the room backdrop on. */
  let look = null;                       // { camera, hide?:()=>[], id? }
  let lookRect = null;
  /** setLookThrough({ camera, hide, id }) | null → the id in force, or null. */
  function setLookThrough(spec) {
    const next = spec && spec.camera && spec.camera.isCamera ? spec : null;
    look = next;
    lookRect = null;
    controls.enabled = !next;
    if (!next) controls.update();
    dirty = true;
    return next ? (next.id || true) : null;
  }
  /** The letterbox rect inside the canvas, in CSS px from the top-left. */
  function lookThroughRect() {
    if (!look) return null;
    const a = look.camera.aspect > 0 ? look.camera.aspect : 4 / 3;
    let w = sizeW, h = Math.round(sizeW / a);
    if (h > sizeH) { h = sizeH; w = Math.round(sizeH * a); }
    return { x: Math.round((sizeW - w) / 2), y: Math.round((sizeH - h) / 2), width: w, height: h };
  }
  function renderLook() {
    const rect = lookThroughRect();
    lookRect = rect;
    if (!rect || rect.width < 8 || rect.height < 8) return;
    const hide = [...pipHidden, ...((look.hide && look.hide()) || [])].filter(Boolean);
    const prev = hide.map((o) => o.visible);
    const show = [...pipOnly].filter((o) => o && o.userData.pipVisible);
    const prevShow = show.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    for (const o of show) o.visible = true;
    try {
      const y = sizeH - rect.y - rect.height;       // GL counts from the bottom-left
      renderer.setScissorTest(true);
      renderer.setViewport(rect.x, y, rect.width, rect.height);
      renderer.setScissor(rect.x, y, rect.width, rect.height);
      neutral(() => { renderer.clear(true, true, false); renderer.render(scene, look.camera); });
    } finally {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, sizeW, sizeH);
      hide.forEach((o, i) => { o.visible = prev[i]; });
      show.forEach((o, i) => { o.visible = prevShow[i]; });
    }
  }

  /* the frame */
  /** One render of the main view. Overlays (PiPs, the cube) are drawn by render(). */
  const mainInfo = { calls: 0, triangles: 0, lines: 0, frame: 0 };
  let mainWrap = null;                   // the Sim's: its robot in the light palette in either theme
  function renderMain() {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, sizeW, sizeH);
    renderer.clear(true, true, true);
    if (look) renderLook();
    else if (mainWrap) mainWrap(() => renderer.render(scene, camera));
    else renderer.render(scene, camera);
    /* snapshot NOW: PiPs and the orientation cube render after this and would otherwise
       be counted as part of the main view. */
    mainInfo.calls = renderer.info.render.calls;
    mainInfo.triangles = renderer.info.render.triangles;
    mainInfo.lines = renderer.info.render.lines;
    mainInfo.frame = renderer.info.render.frame;
  }

  function render(t) {
    t = t || now();
    /* cleared first: an invalidate() raised by a hook must schedule ANOTHER frame, not be
       swallowed by the end of this one. */
    dirty = false;
    stepTween(t);
    if (materials.flash(t)) dirty = true;
    if (viewHelper && viewHelper.animating && !look) {
      syncProxyFromCamera();
      viewHelper.update(Math.min(0.05, (t - lastT) / 1000) || 0.016);
      syncCameraFromProxy();
      dirty = true;
      if (!viewHelper.animating) { release('viewcube'); controls.enabled = true; }
    } else {
      controls.update();
    }
    outlines.sync();
    for (const fn of beforeHooks) fn(t, api);
    renderMain();
    for (const fn of afterHooks) fn(t, api);       // PiPs / scissored extras go here
    if (viewHelper && !look) { syncProxyFromCamera(); viewHelper.render(renderer); }
    renderer.setScissorTest(false);
    lastT = t;
    drawnOnce = true;
  }

  function loop(t) {
    rafId = requestAnimationFrame(loop);
    if (dirty || continuous() || tween || (viewHelper && viewHelper.animating)) render(t);
  }
  function start() {
    if (running) return;
    running = true;
    resize(true);
    setTheme(cfg.theme || 'light');
    resetView({ ms: 0 });
    rafId = requestAnimationFrame(loop);
  }
  function stop() { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = 0; }

  /* screenshot */
  /** Forces a render, then reads the canvas. type/quality as in toDataURL. */
  function screenshot({ type = 'image/png', quality = 0.92, blob = false } = {}) {
    render(now());
    if (!blob) return canvas.toDataURL(type, quality);
    return new Promise(res => canvas.toBlob(res, type, quality));
  }

  /* pointer helpers */
  function pointerNDC(ev, out = new THREE.Vector2()) {
    const r = canvas.getBoundingClientRect();
    return out.set(((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1);
  }
  /** World (or robot, with `frame:'robot'`) point -> CSS pixels inside the canvas. */
  function worldToScreen(v, { frame: fr = 'world' } = {}) {
    const p = v.clone();
    if (fr === 'robot') p.applyMatrix4(root.matrixWorld);
    p.project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height, z: p.z, behind: p.z > 1 };
  }
  /** Scale factor that keeps an object at a constant apparent size (mm per CSS pixel). */
  function mmPerPixel(worldPoint) {
    const d = camera.position.distanceTo(worldPoint || controls.target);
    return 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * d / Math.max(1, sizeH);
  }

  /* stats */
  /** { drawCalls, trianglesDrawn } are the MAIN view only; `frameTriangles` includes
   *  every PiP and overlay drawn since the frame began. `heaviest` lists the biggest
   *  visible meshes, which is what actually decides the cost. */
  function stats({ heaviest = 0 } = {}) {
    const info = renderer.info;
    let sceneTris = 0, meshes = 0;
    const big = [];
    scene.traverse(o => {
      if (!o.isMesh || !o.visible || !o.geometry) return;
      meshes++;
      const g = o.geometry;
      const t = g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
      sceneTris += t;
      if (heaviest) big.push([o.name || o.type, t]);
    });
    return {
      drawCalls: mainInfo.calls,
      trianglesDrawn: mainInfo.triangles,
      frameDrawCalls: info.render.calls,
      frameTriangles: info.render.triangles,
      sceneTriangles: Math.round(sceneTris),
      meshes,
      heaviest: heaviest ? big.sort((a, b) => b[1] - a[1]).slice(0, heaviest) : undefined,
      programs: info.programs ? info.programs.length : 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      size: [sizeW, sizeH],
      pixelRatio: renderer.getPixelRatio(),
      outline: outlines.stats()
    };
  }

  /* dispose */
  function dispose() {
    stop();
    if (ro) ro.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWinResize);
    if (dprQuery && dprQuery.removeEventListener) dprQuery.removeEventListener('change', onDpr);
    controls.dispose();
    if (viewHelper) viewHelper.dispose();
    outlines.dispose();
    F.dispose();
    materials.dispose();
    renderer.dispose();
  }

  const api = {
    /* objects */
    renderer, scene, root, robotRoot, overlayRoot, ground, gridGroup, axes,
    camera, controls, materials, outlines, lights, pipHidden, hideInPip, showInPip,
    backdrop, horizon, pipOnly, onlyInPip, setRoom, neutral,
    get roomOn() { return F.roomOn; },
    setLookThrough, lookThroughRect,
    get lookThrough() { return look; },
    get lookThroughId() { return look ? (look.id || null) : null; },
    get lookRect() { return lookRect; },
    get grid() { return F.grid; },
    get viewHelper() { return viewHelper; },
    get groundZ() { return F.groundZ; },
    get theme() { return materials.theme; },
    get tokens() { return tokens; },
    get width() { return sizeW; },
    get height() { return sizeH; },
    get qRoot() { return qRoot.clone(); },
    /* lifecycle */
    start, stop, render, resize, dispose,
    invalidate, hold, release, isContinuous: continuous,
    onBeforeRender, onAfterRender, onResize,
    setMainWrap(fn) { mainWrap = fn || null; dirty = true; },
    /* view */
    frame, frameObjects, setView, resetView, setHome, fitDistance, moveCamera,
    /* look */
    setTheme, setGround, setSectionPlane,
    get sectionPlane() { return section; },
    /* interaction helpers */
    pointerNDC, worldToScreen, mmPerPixel,
    handleViewHelperClick, overViewHelper,
    /* output */
    screenshot, stats
  };
  return api;
}