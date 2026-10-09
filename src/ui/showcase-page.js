/* showcase.html's entry: loads the manifest's assets (lab, movers, run track; lightmaps and the probe
   when the bake has them), plays the recorded run with the edit's camera path, and exposes
   window.__showcase for the e2e suite. The manifest is inlined as window.__RPS_SHOWCASE. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBytes, decodeRun, fromFile } from './showcase-assets.js';
import { Looks } from './showcase-looks.js';
import { withLots, lotKey, printed, fabric, setFabricRest, coverPress, PRESS_EPS } from './robot-look.js';
import { DIR, bakedFiles, parseGlb, ktxLoader, parseLightmaps, parseNormals, probeTexture, setLooks, labMaterial } from './baked-lab.js';
import { shade } from './robot-shade.js';
import { createCables } from './robot-cables.js';
import { Player } from './showcase-player.js';
import { Stage, detectTier, HOUSING } from './showcase-render.js';
import { buildUi } from './showcase-ui.js';

const Q = new URLSearchParams(location.search);
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message || e.reason)));
const consoleError = console.error.bind(console);
console.error = (...a) => { errors.push(a.map(String).join(' ')); consoleError(...a); };

const S = { t: 0, playing: false, free: false, cams: false, quality: 'auto', loaded: 0, ready: false };

function placeLab(stage, M, gltf, looks, lms, nms) {
  const baked = stage.baked;
  // baked: the set's glass is fresnel glass drawn with the movers (layer 2), so the gantry behind the LH door
  // and the dashboard pills behind their cover are not cut by glass depth written in the first pass
  if (baked) looks = setLooks(M);
  const lit = { env: stage.scene.environment, rotation: stage.scene.environmentRotation, normals: nms };
  const objs = [];
  gltf.scene.traverse((o) => { if (o.isMesh) objs.push(o); });
  for (const o of objs) {
    const info = M.lab.nodes[o.name] || { mat: o.material.name, color: null };
    const m = labMaterial(looks, M, info, lms, lit);
    o.material = m;
    o.castShadow = !baked && !m.transparent;
    o.receiveShadow = !baked;
    o.updateMatrixWorld(true);
    stage.scene.attach(o);
    o.matrixAutoUpdate = false;
    o.layers.set(baked ? (m.transparent ? 2 : 1) : 0);
    if (baked && info.catcher) {
      const c = new THREE.Mesh(o.geometry, new THREE.ShadowMaterial({ opacity: (M.light || {}).shadow ?? 0.35 }));
      c.matrix.copy(o.matrix);
      c.matrixAutoUpdate = false;
      c.receiveShadow = true;
      c.layers.set(2);
      c.visible = stage.T.shadow > 0;
      stage.catchers.push(c);
      stage.scene.add(c);
    }
  }
  return objs.length;
}

/* the free camera: a 35 mm lens (the vertical fov of a 36 x 24 frame); the eye stays WALL (m) inside the room's
   walls and ceiling, FLOOR over the floor, and GAP in front of the first opaque surface between it and its target */
const FREE_FOV = 2 * Math.atan(12 / 35), WALL = 0.15, FLOOR = 0.12, GAP = 0.08;

function freeBounds(M, stage, solids, ceiling) {
  const r = M.room || { x: [-2100, 2300], y: [-1500, 1950] };
  const box = new THREE.Box3(new THREE.Vector3(r.x[0] / 1000 + WALL, r.y[0] / 1000 + WALL, FLOOR),
    new THREE.Vector3(r.x[1] / 1000 - WALL, r.y[1] / 1000 - WALL, ceiling - WALL));
  const room = box.clone().expandByScalar(WALL);
  const ray = new THREE.Raycaster(), dir = new THREE.Vector3(), last = [new THREE.Vector3(NaN), new THREE.Vector3()];
  ray.layers.enableAll();
  return {
    box,
    /** the shot's framing through the free lens: the fov widens and the eye dollies back by the same ratio */
    enter(target, aspect0) {
      const cam = stage.camera, k0 = Math.tan(cam.fov * Math.PI / 360);
      const k = Math.tan(FREE_FOV / 2) * Math.max(1, aspect0 / cam.aspect);
      cam.fov = 2 * Math.atan(k) * 180 / Math.PI;
      cam.updateProjectionMatrix();
      cam.position.sub(target).multiplyScalar(k0 / k).add(target);
    },
    apply(target) {
      const p = stage.camera.position;
      if (p.equals(last[0]) && target.equals(last[1])) return;
      room.clampPoint(target, target);
      box.clampPoint(p, p);
      dir.subVectors(p, target);
      const d = dir.length();
      if (d > 1e-6) {
        ray.set(target, dir.divideScalar(d));
        ray.near = 0.02;
        ray.far = d + GAP;
        const hit = ray.intersectObjects(solids, false)[0];
        if (hit) p.copy(target).addScaledVector(dir, Math.max(0.05, Math.min(d, hit.distance - GAP)));
      }
      last[0].copy(p);
      last[1].copy(target);
    },
  };
}

// a robot camera's module (cover glass, lens barrel and hood): the insets do not draw it, its camera sits inside
const HOUSING_MATS = /^(touchscreen|smoked_glass|polymer_black)$/;

function placeMovers(stage, M, gltf, looks) {
  const out = [];
  const objs = [];
  const robot = new Set(Object.entries(M.run.bodies || {}).filter(([n]) => !/^puck/.test(n)).map(([, k]) => k));
  gltf.scene.traverse((o) => { if (o.isMesh) objs.push(o); });
  for (const o of objs) {
    const info = M.movers.nodes[o.name];
    if (!info) continue;
    const g = M.run.geoms[String(info.g)] || {};
    const own = info.tint || g.color !== undefined, mine = robot.has(g.pose);
    o.material = looks.get(mine ? lotKey(looks.specs, info.mat, o.name) : info.mat, info.color, own);
    o.castShadow = !o.material.transparent;
    o.receiveShadow = true;
    stage.scene.add(o);
    o.layers.set(mine && HOUSING_MATS.test(info.mat) ? HOUSING : stage.baked ? 2 : 0);
    out.push({ obj: o, info, robot: mine && !o.material.transparent });
  }
  return out;
}

/* the robot's parts at frame 0: an ambient occlusion per corner (own materials, vertex colours) and the print on
   printed looks (ui/robot-look.js, along frame 0's z) or the covers' faces; the web LOD keeps its own normals (smooth where the render LOD is) */
async function shadeRobot(movers, looks) {
  const parts = movers.filter((m) => m.robot).map((m) => m.obj);
  for (const o of parts) {
    if (o.geometry.index) { const g = o.geometry.toNonIndexed(); o.geometry.dispose(); o.geometry = g; }
    o.updateMatrix();
  }
  const res = await shade(parts.map((o) => ({ geometry: o.geometry, matrix: o.matrix })), { scale: 1000, floor: 0, crease: false, corners: true });
  for (const o of parts) {
    const s = res.get(o.geometry);
    if (!s) continue;
    if (s.normal) o.geometry.setAttribute('normal', new THREE.BufferAttribute(s.normal, 3, true));
    o.geometry.setAttribute('color', new THREE.BufferAttribute(s.color, 3, true));
    o.material = o.material.clone();
    o.material.vertexColors = true;
    const spec = looks.spec(o.material.name);
    printed(o.material, spec, o.matrix) || fabric(o.material, spec, o.matrix);
  }
  return parts.length;
}

async function boot() {
  const M = window.__RPS_SHOWCASE;
  if (!M) throw new Error('no showcase manifest');
  const duration = (M.run.frames - 1) / M.run.fps;
  let stage, player, controls, bounds;
  const ui = buildUi(document.getElementById('app'), M.run.edit, duration, {
    play: (fromCard) => {
      if (!S.ready) return;
      if (fromCard || S.t >= duration - 1e-3) S.t = 0;
      S.playing = !S.playing || !!fromCard;
    },
    seek: (t) => { S.t = Math.min(Math.max(t, 0), duration); },
    chapter: (d, fine) => {
      if (!player) return;
      if (fine) { S.t = Math.min(Math.max(S.t + 5 * d, 0), duration); return; }
      const k = Math.min(Math.max(player.chapter(S.t) + d, 0), M.run.edit.shots.length - 1);
      S.t = M.run.edit.shots[k].t + 0.001;
    },
    free: () => toggleFree(),
    cams: () => { S.cams = !S.cams; },
    quality: (q) => setQuality(q),
  });
  window.__showcase = api();
  stage = new Stage(ui.canvas, M);
  const det = detectTier(stage.renderer);
  S.gpu = det.gpu;
  const setQuality = (q) => {
    S.quality = q;
    stage.setQuality(q === 'auto' ? det.tier : q);
  };
  setQuality(Q.get('quality') || 'auto');
  // baked: the transmission pass sees only the lit layer (not the set), so the movers' glass is fresnel glass too
  const looks = new Looks(withLots(M.materials), M, { transmission: stage.T.transmission && !stage.baked });
  const files = bakedFiles(M, { run: true }), total = files.reduce((n, f) => n + (f.bytes || 0), 0) || 1;
  const onBytes = (n) => { S.loaded += n; ui.progress(S.loaded / total, `Loading the lab · ${(S.loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`); };
  const bytes = Object.fromEntries(await Promise.all(files.map(async (f) => [f.name, await loadBytes(DIR, f.name, f.bytes, onBytes, f.sha256)])));
  ui.progress(1, 'Preparing');
  await MeshoptDecoder.ready;
  const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  let lms = [], nms = [];
  if ((M.lightmaps || []).length) {
    const ktx = await ktxLoader(stage.renderer);
    gl.setKTX2Loader(ktx);
    lms = await parseLightmaps(ktx, M, bytes, Math.min(8, stage.renderer.capabilities.getMaxAnisotropy()));
    nms = await parseNormals(ktx, M, bytes);
  }
  const probe = M.probe ? probeTexture(bytes[M.probe.file]) : null;
  stage.environment(probe);
  const [lab, mov, tracks] = await Promise.all([parseGlb(gl, bytes[M.lab.file]), parseGlb(gl, bytes[M.movers.file]),
    decodeRun(bytes[M.run.file], M.run)]);
  for (const k in bytes) delete bytes[k];              // the parsed copies live on; the raw files need not
  const ceiling = new THREE.Box3().setFromObject(lab.scene).max.z;
  S.labNodes = placeLab(stage, M, lab, looks, lms, nms);
  const movers = placeMovers(stage, M, mov, looks);
  const solids = [];
  stage.scene.traverse((o) => { if (o.isMesh && !o.material.transparent && !o.material.isShadowMaterial) solids.push(o); });
  const robotParts = new Set(movers.filter((m) => m.robot).map((m) => m.obj));
  bounds = freeBounds(M, stage, solids.filter((o) => !robotParts.has(o)), ceiling);
  S.shaded = await shadeRobot(movers, looks);
  const cables = createCables(M.cables, looks);
  cables.group.traverse((o) => { o.layers.set(stage.baked ? 2 : 0); o.castShadow = true; });
  stage.scene.add(cables.group);
  S.cables = (M.cables || []).length;
  stage.disc.layers.set(stage.baked ? 2 : 0);
  player = new Player(M.run, tracks, movers, M.tint_strength);
  for (const b of player.movers) if (b.A) setFabricRest(b.obj.material, b.A);      // the covers' ribs in the body frame, as offline
  const press = coverPress(player.movers.filter((b) => b.A).map((b) => ({ mesh: b.obj, key: b.g.pose })), PRESS_EPS);
  S.movers = movers.length;
  controls = new OrbitControls(stage.camera, ui.canvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 4;
  controls.maxPolarAngle = 85 * Math.PI / 180;           // the eye stays above its target's horizon
  window.addEventListener('resize', () => stage.resize());
  // a lost context pauses the page; three restores buffers and textures, the stage its targets and probe
  let lostAt = 0;
  stage.onLost = () => {
    S.playing = false;
    lostAt = performance.now();
    ui.notice('The graphics context was lost. Restoring…');
    setTimeout(() => { if (stage.lost && lostAt) ui.notice('The graphics context was lost. Reload the page to continue.', true); }, 4000);
  };
  stage.onRestored = () => { lostAt = 0; ui.notice(null); };

  function toggleFree() {
    if (!player) return;
    S.free = !S.free;
    // leaving: the path camera sets the shot's pose and lens again on the next frame
    if (S.free) {
      controls.target.copy(player.camera(S.t, stage.camera).target);
      bounds.enter(controls.target, M.run.camera_aspect || 16 / 9);
    }
    controls.enabled = S.free;
    controls.update();
    if (S.free) bounds.apply(controls.target);
  }

  function insets() {
    const W = stage.size.w, top = Math.min(stage.size.h, ui.barTop()) - 14;
    if (S.cams) {
      const w = Math.round(Math.min(320, Math.max(180, W * 0.17))), hh = Math.round(w * 3 / 4);
      return M.run.cameras.map((c, n) => ({ n, name: c.name, rect: [W - w - 16, top - (3 - n) * (hh + 10), w, hh] }))
        .filter((r) => r.rect[1] > 48);
    }
    const p = player.pip(S.t);
    if (!p || p.alpha < 0.5 || stage.tier === 'low') return [];
    const w = Math.round(W * 0.22), hh = Math.round(w * 3 / 4);
    return [{ n: p.n, name: p.name, rect: [W - w - Math.round(0.025 * W), top - hh, w, hh] }];
  }

  let last = performance.now(), slow = 0;
  const STEP = { high: 'medium', medium: 'low' };
  // a hidden tab's frames stall: the frame-rate window starts again when it is back
  document.addEventListener('visibilitychange', () => { stage.frames = []; slow = 0; });
  const frame = (now) => {
    requestAnimationFrame(frame);
    const raw = (now - last) / 1000, dt = Math.min(0.1, raw);
    last = now;
    if (stage.lost) return;
    if (S.playing) {
      S.t = Math.min(S.t + dt, duration);
      if (S.t >= duration) S.playing = false;
    }
    player.apply(S.t);
    if (press) press();
    cables.update((b, out) => player.ride(b, S.t, out));
    if (S.free) { controls.update(); bounds.apply(controls.target); } else player.camera(S.t, stage.camera);
    stage.ground(player.base(S.t));
    const ins = insets();
    stage.render(ins, (n, cam) => player.robotCamera(n, S.t, cam));
    S.frame = (S.frame || 0) + 1;
    ui.update({ t: S.t, playing: S.playing, chapter: player.chapter(S.t), free: S.free, cams: S.cams,
      quality: S.quality, fade: S.free ? 1 : player.fade(S.t), captions: S.free ? [] : player.captions(S.t), labels: ins });
    ui.end(!S.playing && S.t >= duration - 1e-3);
    // auto quality: a step down after 3 s (wall time) under 40 fps while playing, each tier measured afresh
    if (S.quality === 'auto' && S.playing && STEP[stage.tier] && stage.span() > 1.5 && stage.fps() < 40) {
      if ((slow += raw) > 3) { stage.setQuality(STEP[stage.tier]); slow = 0; S.steps = (S.steps || []).concat(stage.tier); }
    } else slow = 0;
  };
  player.apply(0);
  if (press) press();
  cables.update((b, out) => player.ride(b, 0, out));
  player.camera(0, stage.camera);
  stage.render();
  S.ready = true;
  ui.ready();
  if (!Q.has('paused')) S.playing = true;
  requestAnimationFrame(frame);

  function api() {
    return {
      get ready() { return S.ready; },
      errors,
      state: () => ({ t: S.t, playing: S.playing, free: S.free, cams: S.cams, quality: S.quality, tier: stage && stage.tier,
        chapter: player ? player.chapter(S.t) : 0, duration, frame: S.frame || 0, loaded: S.loaded, file: fromFile,
        gpu: S.gpu, labNodes: S.labNodes, movers: S.movers, cables: S.cables || 0, shaded: S.shaded || 0, steps: S.steps || [], lost: !!(stage && stage.lost),
        stats: stage && stage.stats(), errors: errors.slice() }),
      chapters: () => M.run.edit.shots.map((s) => ({ id: s.id, label: s.label, t: s.t })),
      seek: (t) => { S.t = Math.min(Math.max(t, 0), duration); },
      play: () => { S.playing = true; },
      pause: () => { S.playing = false; },
      toggleFree: () => toggleFree(),
      toggleCams: () => { S.cams = !S.cams; },
      /** `from`: auto's first tier in place of the GPU guess */
      setQuality: (q, from) => { if (from) det.tier = from; setQuality(q); },
      camera: () => ({ p: stage.camera.position.toArray(), q: stage.camera.quaternion.toArray(), fov: stage.camera.fov }),
      controls: () => controls,
      freeBox: () => bounds && bounds.box.clone(),
      stage: () => stage,
      budget: M.budget || null,
    };
  }
}

boot().catch((e) => {
  errors.push(String(e && e.message || e));
  const el = document.querySelector('.sc-prog-l');
  if (el) { el.textContent = 'Could not load the showcase: ' + (e && e.message || e); el.classList.add('err'); }
  window.__showcase = window.__showcase || { ready: false, errors, state: () => ({ errors }) };
});
