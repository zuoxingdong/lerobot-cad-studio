/* The design's checks, one source for the top-bar pill, the inspector's Design line, the Check
   table and the Export sheet: a row per printed part (Print, Fit), per arm preset (Fit, Limits)
   and per camera (Cameras; every preset once "Sweep all" has measured this design), rolled up
   by features/verdict.js.  Debounced and cached per design revision.  Installed by ui/design-page.js. */

import { partFamilies, cameraFamily, sweepFamily, poseFamilies, rollUp } from '../features/verdict.js';
import { DEBOUNCE } from '../features/validate.js';

/** @param {object} page the shared design-page state (see `ui/design-context.js`) */
export function installChecks(page) {
  const { store, model, cams, ctx } = page;
  let cache = null, timer = null, shown = null;
  let sweep = null;                       // {key: gateKey, cams: {camId: [{preset, level, text}]}}
  const listeners = new Set();
  /* a sweep holds until the design, a lens or a removal changes; the arm pose does not matter */
  const sweepKey = (st) => [page.gateKey(st), JSON.stringify(st.cameras || {}), JSON.stringify(st.removed || {})].join('#');
  const swept = (st) => (sweep && sweep.key === sweepKey(st) ? sweep.cams : null);

  function key() {
    const st = store.getState();
    return [page.gateKey(st), JSON.stringify(st.joints || {}), JSON.stringify(st.cameras || {}),
      JSON.stringify(st.base || {}), JSON.stringify(st.removed || {})].join('#');
  }
  const mounted = (id) => { try { const p = cams.getPose(id, {}); return !!(p && p.ok); } catch (e) { return false; } };

  /** every row, measured now */
  function compute() {
    const st = store.getState();
    const V = ctx.validator();
    const rows = [];
    const report = page.designReport();
    for (const c of report.components) {
      rows.push({ kind: 'part', id: c.component, label: c.label, ...partFamilies(c) });
    }
    let P = null;
    try { P = V.physicsOf(st, { stage: 'presets' }); } catch (e) { P = null; }
    for (const p of (P && P.presets) || []) {
      rows.push({ kind: 'pose', id: 'pose:' + p.id, preset: p.id, label: 'Arm · ' + p.name, ...poseFamilies(p) });
    }
    let camRows = [];
    try { camRows = V.camerasOf(st, null, { ctx: ctx.camCtx() }); } catch (e) { camRows = []; }
    const sw = swept(st);
    for (const c of camRows) {
      if (!mounted(c.id) || store.get('cameras.' + c.id + '.enabled') === false) continue;
      const list = sw && sw[c.id] && sw[c.id].length ? sw[c.id] : null;
      rows.push({ kind: 'camera', id: 'cam:' + c.id, cam: c.id, label: c.label + ' camera',
        cameras: list ? sweepFamily(list) : cameraFamily(c), sweep: list });
    }
    return { key: key(), rows, printer: report.printer, ...rollUp(rows) };
  }

  /** the last answer, whatever its age; a stale one schedules the recompute */
  function checks() {
    if (cache && cache.key === key()) return cache;
    schedule();
    return cache;
  }
  /** the answer for the current design, measured now if stale (the Export sheet waits for it) */
  function checksNow() {
    if (!cache || cache.key !== key()) { cache = compute(); notify(); }
    return cache;
  }
  function schedule() {
    if (timer || page.destroyed) return;
    timer = setTimeout(() => {
      timer = null;
      if (page.destroyed) return;
      try { cache = compute(); } catch (e) { return; }
      notify();
    }, DEBOUNCE.presets_ms);
  }
  /** a "Sweep all" of the current design: its per-preset camera verdicts join the roll-up */
  function setSweep(cams) {
    sweep = { key: sweepKey(store.getState()), cams };
    cache = null;
    return checksNow();
  }
  function notify() {
    if (page.topbar) page.topbar.render();
    /* the inspector's Design line reads the same roll-up: repaint it when the roll-up moves */
    const now = cache ? `${cache.level}|${cache.reason}` : null;
    if (now !== shown) { shown = now; if (page.inspector && !page.destroyed) page.inspector.render(); }
    for (const fn of listeners) { try { fn(cache); } catch (e) { /* a panel that went away */ } }
  }
  function onChecks(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function dispose() { clearTimeout(timer); timer = null; listeners.clear(); }

  ctx.checks = checks;
  Object.assign(page, { checks, checksNow, onChecks, setSweep, disposeChecks: dispose });
  void model;
}
