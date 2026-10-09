/* `window.__rps`, the headless e2e suite's whole contract.  Published only with `?debug=1`;
   src/main.js calls installDebug() after every design mount, and every member here is read
   by name at runtime by tools/tests/e2e/cases/*.js.  Needs core/package.js and features/. */

import * as pkg from '../core/package.js';
import { fingertipPads } from '../features/gripper.js';
import { motionJoints } from '../features/joints.js';
import { slotOptions } from '../features/slot-options.js';
import { tipPoint, tipReach } from '../features/tip.js';

export function installDebug(env) {
  /* `model` and `page` are read live off `env`: the router replaces both, and a readout taken
     off a page that is no longer mounted would answer for the robot that just left. */
  const { store, errors: ERRORS, route, go } = env;
  window.__rps = {
    store, model: env.model, page: env.page,
    get ctx() { return env.page && env.page.ctx; },
    errors: ERRORS,
    go,
    /** run one `core/keymap.js` ACTION by name — what the key press would do */
    dispatch(action, args, ev) {
      const fns = env.page && env.page.ctx && env.page.ctx.kmActions;
      if (!fns || !fns[action]) return null;
      fns[action](args || {}, ev || {});
      return this.readouts();
    },
    resolveKey(code, opts = {}) {
      const km = env.page && env.page.ctx && env.page.ctx.km;
      if (!km) return null;
      const ev = new KeyboardEvent('keydown', {
        key: opts.key || code, code, shiftKey: !!opts.shift, ctrlKey: !!opts.ctrl, metaKey: !!opts.meta
      });
      const r = km.resolve(ev);
      return { action: r.action, kind: r.kind || null, context: r.context };
    },
    async importZip(buffer, name) {
      const res = await pkg.importZip(new Uint8Array(buffer));
      env.page.ctx.on.importLoose(res);
      void name;
      return this.readouts();
    },
    /** loose mesh bytes imported INTO the open robot, exactly as the dropzone does */
    async importFiles(buffer, name) {
      const res = await pkg.importFiles([{ name: name || 'part.stl', bytes: new Uint8Array(buffer) }],
        { remember: false });
      env.page.ctx.on.importLoose(res);
      return this.readouts();
    },
    /** one design JSON through the SAME door the file picker uses (warnings, settle and all) */
    loadDesign(text) { return env.page.ctx.on.applyDesignJSON(text); },
    /* physics — the base pose, the pads, the tip */
    /** the design's base pose and the one the MODEL is actually posing with */
    base() {
      const b = store.getState().base || {};
      return { design: { x: b.x || 0, y: b.y || 0, yaw: b.yaw || 0 }, model: { ...env.model.basePose },
               matrix: env.model.baseMatrix().toArray() };
    },
    /** set the base pose directly */
    setBase(pose) {
      store.set('base', { x: pose.x || 0, y: pose.y || 0, yaw: pose.yaw || 0 }, { label: 'base' });
      env.page.applyPose();
      return this.base();
    },
    /** the collision world, asked about the pose AND the base the model is standing in */
    collideNow(opts) {
      const w = env.page.ctx.collide();
      if (!w) return null;
      const q = env.model.getJoints();
      const a = w.checkPose(q, { maxHits: 8, ...(opts || {}) });
      const b = w.checkWorld ? w.checkWorld(q, { firstOnly: false }) : { ok: true, hits: [] };
      return { ok: !!(a.ok && b.ok),
               pose: { ok: a.ok, hits: a.hits.map((h) => [h.a, h.b]) },
               world: { ok: b.ok, hits: b.hits.map((h) => [h.a, h.b]) } };
    },
    /** the tool tip, the fitted fingertip's reach, and the slot anchor that follows it */
    tipInfo() {
      const m = tipReach(env.model);
      const pads = fingertipPads(env.model);
      let anchor = null;
      try {
        const a = env.page.ctx.slots.anchorOf(pads.ok ? (env.page.ctx.slots.slots.fingertips ? 'fingertips' : pads.slot) : 'fingertips');
        if (a && a.matrix) { const e = a.matrix.elements; anchor = [e[12], e[13], e[14]]; }
      } catch (e) { anchor = null; }
      return { reach: m.reach, ok: m.ok, source: m.source, ids: m.ids,
               tip: tipPoint(env.model),
               anchor, pads: { slot: pads.slot, links: pads.links, ids: pads.ids } };
    },
    /** the op stack of a part (design.parts), and one op applied as one undo step */
    ops(componentId) { return env.page.ctx.opsOf(componentId); },
    applyOp(componentId, op) {
      env.page.ctx.on.applyOps([{ key: env.page.ctx.partKey(componentId), op }]);
      return this.ops(componentId);
    },
    setHinge(partId, key, value) { env.page.ctx.on.setHinge(partId, key, value); return this.camPose(partId === 'df200_arch' ? 'wrist' : 'top'); },
    /** the Save-as-part folder of one component: file name -> byte length, plus part.json */
    partFolder(componentId) {
      const f = env.page.partFolder(componentId);
      return f ? { id: f.id, doc: f.doc, files: Object.fromEntries(Object.entries(f.files).map(([k, v]) => [k, v.length])) } : null;
    },
    /** the agent loop: link a folder handle (a test double is fine), its cards, a drop */
    get agent() {
      const a = env.page && env.page.agent;
      if (!a) return null;
      const row = (c) => ({ key: c.key, id: c.id, label: c.label, slot: c.slot, verdict: c.verdict, reason: c.reason,
        ok: c.ok, isNew: c.isNew, missing: c.missing, fitted: a.isFitted(c), source: c.source });
      return {
        link: (h) => a.linkFolder(h), unlink: () => a.unlink(), state: () => a.link(), scan: () => a.lf.scan(),
        cards: () => a.results().map(row), use: (key) => a.use(key), open: (ids, o) => a.openAgent(ids, o),
        panel: () => a.panel.state, toasts: () => a.toasts.keys(), drop: (dt) => a.handleDrop(dt), preview: (k) => a.preview(k),
      };
    },
    /** the action bar: what is open and what its verdict line says */
    opsBar() { const b = env.page.opsBar; return b ? { shown: !b.el.hidden, open: b.current, verdict: b.verdict } : null; },
    /** a camera's world matrix, so a test can watch it ride the arm */
    camPose(id) {
      const p = env.page.ctx.cams.getPose(id, env.page.ctx.camCtx ? env.page.ctx.camCtx() : {});
      if (!p || !p.ok) return null;
      return { origin: p.origin.toArray(), dir: p.dir.toArray(), source: p.source, tilt_deg: p.tilt_deg };
    },
    /** register an alternative record, then fit it; awaits its geometry */
    async fitAlternative(slotId, alt) {
      const p = env.page.ctx.on.applyAlternative(slotId, alt);
      if (p && typeof p.then === 'function') await p;
      return this.readouts();
    },
    /** every component a fitted alternative put on the robot */
    altComponents() { return env.page.altComponents ? env.page.altComponents() : []; },
    /** exactly the bytes `Export → selected STL` would download for one component */
    exportBytes(componentId) {
      const shipped = env.page.altShipped ? env.page.altShipped(componentId) : null;
      if (shipped) {
        return { name: shipped.name, length: shipped.bytes.length,
                 base64: bytesToB64(shipped.bytes), shipped: true };
      }
      const b = this.stlBytes(componentId);
      /* the REAL download name: a package may state the plate its part prints on
         (`print_name`), which is how a promoted alternative keeps exporting
         `head_PRINT.stl` and not `Corner_mast___camera_head.stl` */
      const name = (env.page.exportNameOf && env.page.exportNameOf(componentId)) || componentId + '.stl';
      return b ? { name, ...b, shipped: false,
                   plate: !!(env.page.plateName && env.page.plateName(env.model.component(componentId))) } : null;
    },
    /** the printables zip, as entry name -> byte length (the real export path) */
    printables() {
      if (!env.page.printablesFiles) return {};
      const f = env.page.printablesFiles();
      return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.length]));
    },
    /** what the IndexedDB alternative cache holds — the reload path */
    async altCached() {
      const recs = await pkg.listAltRecords(env.model.id);
      const out = [];
      for (const r of recs) {
        const all = [...(r.files || []), ...(r.print_files || [])];
        const blobs = await Promise.all(all.map((f) => pkg.loadAltBlob(f.sha1)));
        out.push({ id: r.id, slot: r.slot, frame: r.frame,
          files: (r.files || []).map((f) => f.name), prints: (r.print_files || []).map((f) => f.name),
          blobs: blobs.filter(Boolean).length, wanted: all.length });
      }
      return out;
    },
    /** wait for the boot-time "draw whatever alternative the design says is fitted" pass */
    async altReady() { try { await env.page.altBoot; } catch (e) { /* no cache */ } return this.altComponents(); },
    /** features/validate.js `physicsOf` over the package's own presets */
    presetCheck() {
      const P = env.page.ctx.validator().physicsOf(store.getState(), { stage: 'presets' });
      return (P.presets || []).map((r) => ({
        id: r.name, ok: r.ok, hits: (r.hits || []).length,
        limits: (r.limits || []).length, ms: r.ms, tooltip: r.tooltip
      }));
    },
    presets() { return env.page.ctx.presets().map((p) => ({ name: p.name, label: p.label, source: p.source })); },
    /** pose the arm at one preset, through the SAME clamp a slider goes through */
    applyPreset(pid) {
      const r = env.page.applyPreset(pid);
      return { ...(r || { preset: pid, reached: false, blocked: [] }),
               joints: { ...store.getState().joints }, collide: this.collideNow() };
    },
    /** the pose popover's per-preset verdicts (the preset collision pass, cached) */
    presetMarks() {
      const v = env.page.presetPhysics ? env.page.presetPhysics() : { fresh: false, rows: new Map() };
      return { fresh: !!v.fresh, rows: [...v.rows].map(([k, r]) => [k, r.ok]),
               marked: [...document.querySelectorAll('.posepop [data-preset]')]
                 .filter((b) => b.querySelector('.dot.warn')).map((b) => b.dataset.preset) };
    },
    /** the pose popover's joint rows — name, unit and travel */
    motionJoints() { return motionJoints(env.model, store.getState(), env.page.ctx.slots); },
    setJoint(name, value) { env.page.setJoint(name, value, true); return this.readouts(); },
    setTab(t) { env.page.inspector.setTab(t); return this.readouts(); },
    select(id, mode) { env.page.actions.select(id, mode || 'set'); return this.readouts(); },
    /* component actions — what the context menu runs */
    removeComponents(ids) { env.page.ctx.removeComponents(Array.isArray(ids) ? ids : [ids]); return this.readouts(); },
    restoreComponents(ids) { env.page.ctx.restoreComponents(Array.isArray(ids) ? ids : [ids]); return this.readouts(); },
    removeSlot(slotId) { env.page.ctx.removeFromSlot(slotId); return this.readouts(); },
    /** the component's bounding box in the ROBOT frame — where a piece is actually drawn */
    componentBox(id) {
      const c = env.model.component(id);
      if (!c || !c.geometry) return null;
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
      const m = env.model.worldMatrix(id);
      const b = c.geometry.boundingBox;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const e = m ? m.elements : null;
        const p = e ? [e[0] * x + e[4] * y + e[8] * z + e[12],
          e[1] * x + e[5] * y + e[9] * z + e[13],
          e[2] * x + e[6] * y + e[10] * z + e[14]] : [x, y, z];
        for (let i = 0; i < 3; i++) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; }
      }
      return { min: lo, max: hi };
    },
    swap(slotId, optionLabel) {
      const list = slotOptions(env.model, env.page.ctx.slots, store.getState(), slotId);
      const e = list.find((o) => o.label === optionLabel || o.id === optionLabel);
      if (!e) return null;
      env.page.ctx.on.applySwap(slotId, e);
      return this.readouts();
    },
    /** the camera tiles: the calibration mode and the transient enlarged / look-through state */
    cameraPanel() {
      const p = env.page.strip;
      const box = p.el.getBoundingClientRect();
      return { ...p.state, enlarged: p.enlarged, looking: p.looking,
        rect: { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } };
    },
    /** the design roll-up: the pill level, the counts and every row (measured now) */
    checks() {
      const c = env.page.checksNow();
      return { level: c.level, counts: c.counts, reason: c.reason,
        rows: c.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label,
          ...Object.fromEntries(['print', 'fit', 'limits', 'cameras'].filter((k) => r[k]).map((k) => [k, { level: r[k].level, reason: r[k].reason }])) })),
        pill: (document.querySelector('.topbar .checkspill') || {}).dataset ? document.querySelector('.topbar .checkspill').dataset.level : null };
    },
    /** enter / leave look-through, and what the VIEWPORT is actually rendering through */
    lookThrough(id) {
      if (id !== undefined) env.page.strip.lookThrough(id);
      const v = env.page.ctx.viewport;
      const cam = v.lookThrough ? v.lookThrough.camera : null;
      if (cam) cam.updateMatrixWorld(true);
      return {
        id: v.lookThroughId, orbit: v.controls.enabled,
        rect: v.lookThroughRect(),
        camera: cam ? { fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far,
          position: cam.position.toArray().map((n) => Math.round(n * 1000) / 1000 + 0),
          world: cam.matrixWorld.toArray() } : null,
        pose: v.lookThroughId ? this.camPose(v.lookThroughId) : null
      };
    },
    /** the as-installed calibration, per camera, and the mode in force */
    calib(id) {
      const cams = env.page.ctx.cams;
      const one = (cid) => ({ id: cid, calib: cams.getCalib(cid), declared: cams.calibDefault(cid),
        design: (store.getState().cameras || {})[cid] || null,
        tilt_deg: (cams.getPose(cid, env.page.ctx.camCtx()) || {}).tilt_deg });
      if (id) return one(id);
      return { mode: cams.calibMode, cameras: cams.ids.map(one) };
    },
    /** type the measured as-installed offset in, exactly as the strip will */
    setCalib(id, calib) { env.page.strip.setCalibValue(id, calib); return this.calib(id); },
    /**
     * Device-pixel bookkeeping + where the robot sits in each camera's frame.
     * The mast and the base are symmetric about X = 0, so `top.u` must be 0.5 at a
     * symmetric pose no matter what the display's pixel ratio is.
     */
    pixels() {
      const v = env.page.ctx.viewport;
      const cv = v.renderer.domElement;
      const c = env.page.ctx.camCtx();
      const cams = env.page.ctx.cams;
      const tiles = {};
      for (const id of cams.ids) {
        const cc = cams.idCentroid(id, c, { width: 160, height: 120 });
        const ev = env.page.strip.evaluation(id);
        const el = document.querySelector(`.camtiles .tile[data-cam="${id}"] canvas`);
        tiles[id] = {
          centroid: cc, tip: ev && ev.tip ? { u: ev.tip.u, v: ev.tip.v, in: ev.tip.in } : null,
          pct: ev ? { robot: ev.robot_pct, arm: ev.arm_pct, floor: ev.floor_pct, reach: ev.reach_disc_pct } : null,
          buffer: el ? [el.width, el.height] : null,
          box: el ? [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)] : null
        };
      }
      return {
        dpr: globalThis.devicePixelRatio || 1,
        pixelRatio: v.renderer.getPixelRatio(),
        canvasCss: [v.width, v.height],
        drawingBuffer: [cv.width, cv.height],
        /* the GL viewport the last render left behind — in DEVICE px */
        glViewport: (() => { try { const g = v.renderer.getContext(); return [...g.getParameter(g.VIEWPORT)]; } catch (e) { return null; } })(),
        tiles
      };
    },
    /** the room backdrop: is it in the scene, and is it camera-only? */
    room() {
      const v = env.page.ctx.viewport;
      return { on: v.roomOn, walls: v.backdrop.children.length,
        wallsVisible: v.backdrop.visible, horizonVisible: v.horizon.visible,
        pipVisible: !!v.backdrop.userData.pipVisible };
    },
    printCheck(componentId) {
      const r = env.page.ctx.validator().printOf(store.getState(), componentId);
      return r ? { verdict: r.verdict, actionable: r.actionable, preview: r.preview,
        orientation: r.orientation, orientationLabel: r.orientationLabel,
        orientationSource: r.orientationSource,
        chips: r.chips.map((c) => ({ key: c.key, level: c.level, name: c.name, detail: c.detail })),
        size: r.analysis ? [r.analysis.size.x, r.analysis.size.y, r.analysis.size.z] : null,
        bedArea_mm2: r.analysis ? +(r.analysis.bedArea || 0).toFixed(2) : null,
        volume_cm3: r.analysis ? r.analysis.volume_cm3 : null } : null;
    },
    designReport() {
      const r = env.page.ctx.designReport();
      return { worst: r.worst, printer: r.printer.id || r.printer, orientations: r.orientations,
        components: r.components.map((c) => ({ id: c.component, verdict: c.verdict, preview: c.preview,
          orientation: c.orientation, orientationLabel: c.orientationLabel,
          orientationSource: c.orientationSource })) };
    },
    /** the slot rows of PARTS YOU CAN CHANGE: label, the fitted option, badges */
    slotRows() {
      return [...document.querySelectorAll('.tree .row.slot')].map((r) => ({
        slot: r.dataset.slot, label: (r.querySelector('.n') || {}).textContent || '',
        option: (r.querySelector('.m') || {}).textContent || '', hole: r.classList.contains('hole'),
      }));
    },
    /**
     * Every FITTED printable, measured in the pose it is exported in (class D1).
     *
     * `zmin` is the bed plane of the exported STL and `size` its bounding box, both taken
     * off the very geometry `Export → selected STL` writes — so a suite can hold the
     * numbers against the upstream plate the package names (`plate`, and the extents
     * `print_bbox_mm` trimesh measured on that file at build time).
     */
    printPlates() {
      const st = store.getState();
      const vis = env.page.ctx.visible();
      const V = env.page.ctx.validator();
      const out = [];
      for (const c of env.model.printables()) {
        if (vis.get(c.id) === false) continue;
        const g = V.geometryOf(st, c.id);
        if (!g || !g.geometry) continue;
        const geo = g.printTransform ? g.geometry.clone().applyMatrix4(g.printTransform) : g.geometry;
        geo.computeBoundingBox();
        const b = geo.boundingBox;
        const r = {
          id: c.id, orientation: g.orientation || null,
          source: g.orientationSource || null,
          plate: c.print_source || null,
          note: c.printFitNote || null,
          plate_bbox_mm: c.printBbox || null,
          zmin: +b.min.z.toFixed(4),
          size: [+(b.max.x - b.min.x).toFixed(3), +(b.max.y - b.min.y).toFixed(3), +(b.max.z - b.min.z).toFixed(3)],
          xymid: [+((b.min.x + b.max.x) / 2).toFixed(4), +((b.min.y + b.max.y) / 2).toFixed(4)],
        };
        if (geo !== g.geometry) geo.dispose();
        out.push(r);
      }
      return out;
    },
    stlBytes(componentId) {
      const g = env.page.ctx.validator().geometryOf(store.getState(), componentId);
      if (!g || !g.geometry) return null;
      const geo = g.printTransform ? g.geometry.clone().applyMatrix4(g.printTransform) : g.geometry;
      const b = pkg.stlBytes(geo);
      if (geo !== g.geometry) geo.dispose();
      return { length: b.length, base64: bytesToB64(b) };
    },
    readouts() {
      const st = store.getState();
      const sel = env.page.ctx.selection();
      const vis = env.page.ctx.visible();
      const verdicts = env.page.strip.verdicts();
      return {
        route: route(),
        robot: env.model.id,
        components: env.model.components.length,
        printables: env.model.printables().length,
        visible: [...vis.values()].filter(Boolean).length,
        treeRows: document.querySelectorAll('.tree .row').length,
        treeGroups: document.querySelectorAll('.tree .grow').length,
        selected: sel[0] || null,
        tab: env.page.inspector.tab,
        view: env.page.topbar ? env.page.topbar.tab : null,
        slots: { ...st.slots },
        joints: { ...st.joints },
        controlJoints: env.model.controlJoints(),
        params: JSON.parse(JSON.stringify(st.params || {})),
        cameras: Object.fromEntries(env.page.ctx.cams.ids.map((id) => [id, env.page.ctx.cams.get(id).hfov_deg])),
        verdicts: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, { level: v.level, text: v.text }])),
        chips: [...document.querySelectorAll('.ibody .chip')].map((c) => c.textContent.trim()),
        theme: document.documentElement.getAttribute('data-theme') || 'auto',
        isolate: st.ui.isolate || null,
        removed: Object.keys(st.removed || {}),
        treeRemoved: document.querySelectorAll('.tree .row.rm').length,
        /* the parts a fitted alternative put on the robot (they list under its slot row) */
        treeAlt: (env.page.altComponents ? env.page.altComponents() : []).filter((a) => a.visible).map((a) => a.id),
        treeHoles: [...document.querySelectorAll('.tree .row.hole')].map((r) => r.dataset.slot),
        treeSlots: [...document.querySelectorAll('.tree .row.slot')].map((r) => r.dataset.slot),
        errors: ERRORS.slice()
      };
    }
  };
  window.dispatchEvent(new CustomEvent('rps:ready'));
}

function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
