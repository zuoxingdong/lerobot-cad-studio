/* The Sim view (`#/sim/<robot>`), mounted over the Design page it shares the viewport, the
   RobotModel and the meshes with: a header (mode, run, reset, speed, ⋯), the right rail, the
   camera feeds, the key map, and the rAF hook that steps MuJoCo and poses the scene.  Leaving
   frees the model and puts the Design camera and pose back. */

import * as THREE from 'three';
import { el } from './dom.js';
import { openSession, MAX_STEPS } from './sim-run.js';
import { createSimView } from './sim-view.js';
import { mountSimPanel } from './sim-panel.js';
import { mountSimCams } from './sim-cams.js';
import { installSimKeys, KEY_ROWS } from './sim-keys.js';
import { loadEngine } from '../features/sim-engine.js';
import { simSupport } from '../features/sim-mjcf.js';
import { zipFiles } from '../core/package.js';

const SPEEDS = [0.25, 0.5, 1, 2];
const STAGE = { engine: ['Loading MuJoCo…', 30], build: ['Building model from your design…', 70] };
const RING = 600;
const CAM_MS = 160;                                        // feed refresh, ~6 Hz
/* the opening view, robot-frame mm above the floor: inside the closed room from the south-east,
   150 mm in from the south wall (no wall is cut), the robot at the dock, the liquid handler, the
   incubator and the reader in frame */
export const OPEN_VIEW = { eye: [1300, -1350, 1900], at: [100, 600, 200] };

const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2); };

/** Mount over a mounted Design page (the `mountDesign` surface). */
export function mountSim(page, { store, model }) {
  const { viewport, meshes, picking, ctx } = page;
  const canvas = viewport.renderer.domElement;
  const host = canvas.parentElement, centre = canvas.closest('.centre'), app = canvas.closest('.app');
  const frame = app.querySelector('.frame');
  app.classList.add('sim-on');
  const picked = picking.enabled;
  picking.enabled = false;
  /* the Design camera panel keeps painting while connected: park it */
  const stripEl = page.strip && page.strip.el, stripAt = stripEl && [stripEl.parentNode, stripEl.nextSibling];
  if (stripEl) stripEl.remove();

  /* header */
  const head = el('div', 'sim-head');
  const modeSeg = el('div', 'seg');
  const bTele = el('button', null, 'Teleop'), bLab = el('button', null, 'Lab task');
  modeSeg.append(bTele, bLab);
  bLab.hidden = true;
  const bRun = el('button', 'btn sm', '▶ Run');
  const bStep = el('button', 'btn sm ghost', 'Step phase');
  const bReset = el('button', 'btn sm ghost', '⟲ Reset');
  bReset.title = 'Reset the scene · R';
  const speedSeg = el('div', 'seg');
  const speedBtns = SPEEDS.map((s) => { const b = el('button', null, s + '×'); b.onclick = () => setSpeed(s); speedSeg.append(b); return b; });
  const bMore = el('button', 'btn sm ghost icon', '⋯');
  bMore.setAttribute('aria-label', 'More');
  const menu = el('div', 'sim-menu');
  menu.hidden = true;
  const mZip = el('button', null, 'Download MJCF zip'), mRep = el('button', null, 'Download report JSON');
  const mShow = el('a', null, 'Photoreal showcase');
  mShow.href = 'showcase.html';
  mShow.target = '_blank';
  mShow.rel = 'noopener';
  mShow.onclick = () => { menu.hidden = true; };
  menu.append(mZip, mRep, mShow);
  head.append(modeSeg, el('div', 'vr'), bRun, bStep, bReset, el('div', 'vr'), el('span', 'lbl', 'Speed'), speedSeg,
    el('div', 'sp'), bMore, menu);
  for (const b of [bRun, bStep, bReset, bMore, ...speedBtns, bTele, bLab]) b.disabled = true;
  centre.insertBefore(head, host.closest('.stage') || host);

  /* overlays on the canvas */
  const load = el('div', 'sim-load');
  const loadText = el('div', 'lbl', STAGE.engine[0]);
  const loadBar = el('div', 'sim-bar');
  const loadFill = el('i');
  loadBar.append(loadFill);
  load.append(loadText, loadBar);
  const pill = el('div', 'sim-pill', '⌨ Keys active');
  pill.hidden = true;
  const card = el('div', 'sim-keys');
  const cardHead = el('button', 'sim-kh', 'Keys ▾');
  const cardBody = el('div', 'sim-kb');
  const selLine = el('div', 'sim-sel');
  for (const r of KEY_ROWS) {
    const line = el('div', 'sim-kr');
    for (const [k, what] of r) { line.append(el('kbd', null, k), el('span', null, what)); }
    cardBody.append(line);
  }
  cardBody.append(selLine);
  card.append(cardHead, cardBody);
  const foldKeys = (fold) => { cardBody.hidden = fold; cardHead.textContent = fold ? 'Keys ▸' : 'Keys ▾'; };
  cardHead.onclick = () => foldKeys(!cardBody.hidden);
  card.hidden = true;
  host.append(load, pill, card);

  const panel = mountSimPanel(frame);
  /* the grid's main cell is small: the key map starts folded there */
  const feeds = mountSimCams({ stage: host.closest('.stage'), canvasHost: host, canvas, viewport, frustums: ctx.frustums, cams: ctx.cams,
    onLayout: (grid) => foldKeys(grid) });
  requestAnimationFrame(() => viewport.resize(true));

  let session = null, view = null, keys = null, offBefore = null, offAfter = null, dead = false;
  let running = false, stepFrom = null, last = null, lastUi = 0, lastCam = 0, turbo = 0, error = null;
  const jsMs = [], gapMs = [], camMs = [];
  const designCam = { p: viewport.camera.position.clone(), t: viewport.controls.target.clone() };
  /* the Sim poses the shared model; leaving puts the Design pose back exactly (exports read it) */
  const designPose = { q: model.getJoints(), base: { ...model.basePose } };
  const push = (a, v) => { a.push(v); if (a.length > RING) a.shift(); };

  function setStage(s) { const [t, p] = STAGE[s] || [s, 50]; loadText.textContent = t; loadFill.style.width = p + '%'; }

  function setRunning(on) {
    running = !!on && !!session && !(session.mode === 'lab' && session.lab && session.lab.done);
    if (running) { last = null; viewport.hold('sim'); } else viewport.release('sim');
    bRun.textContent = running ? '⏸ Pause' : '▶ Run';
    bRun.classList.toggle('on', running);
  }
  function setSpeed(s) {
    if (!session) return;
    session.speed = s;
    speedBtns.forEach((b, i) => b.classList.toggle('on', SPEEDS[i] === s));
  }
  function setMode(mv) {
    if (!session) return;
    const got = session.setMode(mv);
    bTele.classList.toggle('on', got === 'teleop');
    bLab.classList.toggle('on', got === 'lab');
    bStep.hidden = got !== 'lab';
    card.hidden = got !== 'teleop';
    stepFrom = null;
    view.place(true);
    view.sync(0);
    setRunning(got === 'teleop');
    renderUi();
  }
  function doReset() {
    if (!session) return;
    session.reset();
    stepFrom = null;
    view.place(true);
    view.sync(0);
    setRunning(session.mode === 'teleop');
    renderUi();
  }

  function paintPill() {
    const on = document.activeElement === canvas && !!session;
    pill.classList.toggle('off', !on);
    pill.textContent = on ? '⌨ Keys active' : '⌨ Keys off';
    pill.title = on ? 'Esc releases the keyboard' : 'Click the view to drive';
  }

  function renderUi() {
    if (!session) return;
    paintPill();
    const done = session.mode === 'lab' && !!(session.lab && session.lab.done);
    bRun.disabled = bStep.disabled = done;
    bRun.title = done ? 'task complete · Reset to run it again' : 'Space';
    const ls = session.labState();
    panel.renderLab(ls, running);
    panel.renderMetrics(session.metrics.value, session.metrics.levels(), ls);
    const t = session.teleop, j = t.joints[t.selected];
    if (session.mode === 'teleop' && j) {
      const q = session.data.qpos[t.ix.armAdr[t.selected]] * 180 / Math.PI;
      selLine.textContent = `${j.replace(/^arm_/, '')} ${q.toFixed(1)}° · jaw ${t.jawOpen ? 'open' : 'closed'}${t.fast ? ' · fast' : ''}`;
    }
  }

  function tick(t) {
    if (!session || dead) return;
    const t0 = performance.now();
    const dt = last == null ? 0 : Math.min(0.1, (t - last) / 1000);
    if (running && last != null) push(gapMs, t - last);
    last = t;
    let r = { steps: 0, wallMs: 0, simDt: 0 };
    if (running) {
      r = session.advance(dt, turbo || MAX_STEPS);
      if (session.mode === 'lab') {
        const lab = session.lab;
        if (lab.done || (stepFrom != null && session.labState().records.length > stepFrom)) { stepFrom = null; setRunning(false); lastUi = 0; }
      }
    }
    view.sync(r.simDt);
    view.cut();
    session.metrics.sample(session.data, { steps: r.steps, wallMs: r.wallMs, simDt: r.simDt, frameMs: running ? dt * 1000 : 0 });
    /* before the render, so the frustums and the feeds painted after it see this frame's poses */
    if (camsDue(t) || store.get('ui.frustums')) page.syncCameras();
    if (t - lastUi > 200 || !running) { lastUi = t; renderUi(); }
    if (running) push(jsMs, performance.now() - t0);
  }
  const camsDue = (t) => feeds.on && t - lastCam > CAM_MS;
  function afterRender(t) {
    if (!session || dead || !camsDue(t)) return;
    lastCam = t;
    const t0 = performance.now();
    view.cut(false);
    view.claimOwn();
    feeds.paint();
    view.cut();
    push(camMs, performance.now() - t0);
  }

  /* wiring */
  bTele.onclick = () => setMode('teleop');
  bLab.onclick = () => setMode('lab');
  bRun.onclick = () => setRunning(!running);
  bStep.onclick = () => { if (!session || !session.lab) return; stepFrom = session.labState().records.length; setRunning(true); };
  bReset.onclick = doReset;
  bMore.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  const closeMenu = (e) => { if (!menu.contains(e.target)) menu.hidden = true; };
  document.addEventListener('pointerdown', closeMenu, true);
  mZip.onclick = () => { menu.hidden = true; save(mjcfZip(), `${model.id}-mjcf.zip`, 'application/zip'); };
  mRep.onclick = () => { menu.hidden = true; save(JSON.stringify(report(), null, 1), `${model.id}-sim-report.json`, 'application/json'); };

  function save(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const mjcfZip = () => zipFiles(session.files());
  function report() {
    const ls = session.labState();
    return {
      schema: 'rps/sim-report@1', robot: model.id, design_hash: session.hash, mode: session.mode,
      sim_time_s: +session.time.toFixed(3), speed: session.speed, timing: session.timing,
      metrics: { ...session.metrics.value, levels: session.metrics.levels() },
      lab: ls && { done: ls.done, phase: ls.phase, seated: ls.seated, tubes: ls.tubes, outcome: ls.outcome, phases: ls.records },
      frame: frameStats(),
    };
  }
  function frameStats() {
    return { js_p50_ms: pct(jsMs, 0.5), js_p95_ms: pct(jsMs, 0.95), js_max_ms: pct(jsMs, 1), raf_p50_ms: pct(gapMs, 0.5), raf_p95_ms: pct(gapMs, 0.95), frames: jsMs.length,
      cams_p50_ms: pct(camMs, 0.5), cams_p95_ms: pct(camMs, 0.95), cam_paints: camMs.length };
  }

  const actions = {
    joint: (d) => { session.teleop.select(d); renderUi(); },
    recentre: () => session.teleop.recentre(),
    gripper: () => { session.teleop.gripper(); renderUi(); },
    home: () => session.teleop.home(),
    preset: () => session.teleop.nextPreset(),
    stop: () => { if (session.mode === 'lab') setRunning(false); else session.teleop.stop(); },
    reset: doReset,
    release: () => canvas.blur(),
  };

  const ready = (async () => {
    setStage('engine');
    const edited = new Map();
    for (const [id, mesh] of meshes) { const c = model.component(id); if (c && mesh.geometry && mesh.geometry !== c.geometry) edited.set(id, mesh.geometry); }
    try {
      const s = await openSession({ model, slots: ctx.slots, design: store.getState(), edited, onStage: setStage });
      if (dead) { s.free(); return null; }
      session = s;
    } catch (e) {
      error = String((e && e.message) || e);
      loadText.textContent = 'Could not start the simulation';
      load.title = error;
      load.classList.add('err');
      throw e;
    }
    view = createSimView({ viewport, model, meshes, session, frustums: ctx.frustums, camIds: () => ctx.cams.ids });
    const gz = session.sidecar.ground_z_mm || 0, at = (v) => new THREE.Vector3(v[0], v[1], v[2] + gz);
    viewport.moveCamera(at(OPEN_VIEW.eye), at(OPEN_VIEW.at), 0);
    const t = session.teleop;
    keys = installSimKeys({
      canvas, held: t.held, actions,
      enabled: () => !!session,
      onFocus: paintPill,
      onFast: (on) => { if (session && session.teleop) session.teleop.fast = on; },
    });
    if (!t.hasBase) cardBody.firstChild.hidden = true;
    offBefore = viewport.onBeforeRender(tick);
    offAfter = viewport.onAfterRender(afterRender);
    const sup = simSupport(model);
    bLab.hidden = false;
    bLab.title = sup.lab ? '' : sup.labReason;
    for (const b of [bRun, bStep, bReset, bMore, ...speedBtns, bTele, bLab]) b.disabled = false;
    bLab.disabled = !(sup.lab && session.labOK);
    load.hidden = true;
    pill.hidden = false;
    setSpeed(1);
    setMode('teleop');
    canvas.focus();
    return session;
  })();
  ready.catch(() => {});

  const api = {
    ready,
    get session() { return session; },
    get running() { return running; },
    get error() { return error; },
    get view() { return view; },
    feeds,
    setMode, setSpeed, reset: doReset,
    run: () => setRunning(true), pause: () => setRunning(false),
    stepPhase: () => bStep.click(),
    turbo(n) { turbo = Math.max(0, n | 0); },
    frameStats, report, mjcfZip, renderUi,
    clearStats() { jsMs.length = 0; gapMs.length = 0; camMs.length = 0; },
    destroy() {
      if (dead) return;
      dead = true;
      setRunning(false);
      if (offBefore) offBefore();
      if (offAfter) offAfter();
      if (keys) keys.dispose();
      if (view) view.dispose();
      viewport.camera.position.copy(designCam.p);
      viewport.controls.target.copy(designCam.t);
      viewport.controls.update();
      if (session) session.free();
      session = null;
      document.removeEventListener('pointerdown', closeMenu, true);
      panel.destroy();
      feeds.destroy();
      head.remove(); load.remove(); pill.remove(); card.remove();
      app.classList.remove('sim-on');
      picking.enabled = picked;
      if (stripEl && stripAt[0]) stripAt[0].insertBefore(stripEl, stripAt[1] && stripAt[1].parentNode === stripAt[0] ? stripAt[1] : null);
      model.setJoints(designPose.q);
      model.setBasePose(designPose.base);
      page.applyPose();
      viewport.resize(true);
      viewport.invalidate();
    },
  };
  if (new URLSearchParams(location.search).get('debug') === '1') {
    window.__rpsSim = api;
    api.heapBytes = async () => { const mj = await loadEngine(); const b = new mj.DoubleBuffer(1); try { return b.GetView().buffer.byteLength; } finally { b.delete(); } };
  }
  return api;
}
