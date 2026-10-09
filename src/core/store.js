/* The design state and its history: immutable updates along the changed path, a 50-entry
   undo stack with 400 ms coalescing, and a sessionStorage autosave.  Needs
   core/design-shape.js (both storages are feature-detected and injectable, so every path
   runs in Node). */

import { sanitiseDesign } from './design-shape.js';
import { withOp, withoutOp, withoutOps } from './part-edits.js';

export const DESIGN_SCHEMA = 'rps/design@1';
export const HISTORY_CAP = 50;
export const COALESCE_MS = 400;
const SESSION_KEY = 'rps/session@1';
const SAVED_KEY = 'rps/designs@1';

/* ------------------------------------------------------------------ default state -- */

/** A blank `rps/design@1` for a robot id. */
export function defaultDesign(robotId = null) {
  return {
    schema: DESIGN_SCHEMA,
    app: 'LeRobot CAD Studio',
    saved: null,
    robot: robotId,
    joints: {},        // joint name (qualified) -> degrees
    slots: {},         // slot id -> option id
    params: {},        // component id -> { param: value }
    parts: {},         // component or part id -> { ops?: [op], params?: {hinge: value}, copy_of? }
    components: {},    // component id -> { visible?, color?, transform?: [16] }
    removed: {},       // component id -> true  — deleted by the user, restorable
    /* where the robot stands: the driven base pose, mm + degrees about +Z, so collision,
       cameras and the sim agree about it */
    base: { x: 0, y: 0, yaw: 0 },
    cameras: {},       // camera id -> { hfov_deg?, aspect?, enabled? }
    ui: {
      page: 'home',           // 'home' | 'design'
      theme: 'auto',          // 'auto' | 'light' | 'dark'
      selected: null,
      multi: [],
      isolate: false,
      tree: { open: null },      // null = "the tree's own default" ([] would mean ALL COLLAPSED)
      grid: true,
      /* "Export anyway" — ONE flag for the top bar, the inspector footer and the print-check
         dialog.  UI state, not design state: a passing gate clears it. */
      exportAnyway: false,
      frustums: false,
      physics: true,
      /* the camera tiles: designed or measured pose */
      cameras: { calib: 'design' },
      panels: {}
    }
  };
}

/* immutability */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Copy-on-write `obj[path] = value`; untouched branches keep their identity. */
export function setIn(obj, path, value) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  if (!keys.length) return value;
  const [k, ...rest] = keys;
  const base = Array.isArray(obj) ? obj.slice() : { ...(obj || {}) };
  base[k] = rest.length ? setIn(base[k], rest, value) : value;
  return base;
}

/** Copy-on-write read. */
export function getIn(obj, path, fallback) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return fallback;
    cur = cur[k];
  }
  return cur === undefined ? fallback : cur;
}

/** Copy-on-write deep-merge; arrays and null replace, plain objects merge. */
export function mergeDeep(base, patch) {
  if (!isObj(patch)) return patch;
  const out = { ...(isObj(base) ? base : {}) };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : v;
  }
  return out;
}

/** Copy-on-write delete of a key.  An ARRAY stays an array: `deleteIn(d, 'list.0')` splices
 *  the element out instead of turning the list into `{"1": …}`. */
export function deleteIn(obj, path) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  if (!keys.length) return obj;
  const [k, ...rest] = keys;

  if (Array.isArray(obj)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= obj.length) return obj;
    if (!rest.length) return obj.slice(0, i).concat(obj.slice(i + 1));
    const next = deleteIn(obj[i], rest);
    if (next === obj[i]) return obj;
    const out = obj.slice();
    out[i] = next;
    return out;
  }

  if (!rest.length) {
    if (!obj || !(k in obj)) return obj;
    const out = { ...obj };
    delete out[k];
    return out;
  }
  if (!obj || !(k in obj)) return obj;
  const next = deleteIn(obj[k], rest);
  if (next === obj[k]) return obj;
  return { ...obj, [k]: next };
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * `ui` IS NOT DESIGN STATE, so a history move carries the live one across.
 *
 * Theme, mode, the selection and isolate are written without a history label, but they ride
 * inside the snapshot the next real commit pushes — so one Ctrl+Z rolled `ui.theme` back to
 * `auto` while the document stayed dark, and the store and the page disagreed for the rest
 * of the session.  Undo is about the design.
 */
function carryUI(live, restored) {
  if (!isObj(live) || !isObj(live.ui) || !isObj(restored)) return restored;
  if (same(live.ui, restored.ui)) return restored;
  return { ...restored, ui: live.ui };
}

/** "Export anyway" waives a FAILING print check for the session that granted it — never
 *  for the next one.  It is stripped on the way out and reset on the way in. */
function withoutOverride(d) {
  if (!isObj(d) || !isObj(d.ui) || !d.ui.exportAnyway) return d;
  return { ...d, ui: { ...d.ui, exportAnyway: false } };
}

/* the store */

/**
 * @param {object} [initial]  a design object (merged over `defaultDesign()`)
 * @param {{historyCap?:number, coalesceMs?:number, autosaveMs?:number,
 *          storage?:Storage|null, idb?:object|null, timers?:{setTimeout:Function,clearTimeout:Function},
 *          sessionKey?:string}} [options]
 */
export function createStore(initial = null, options = {}) {
  const cfg = {
    historyCap: options.historyCap || HISTORY_CAP,
    coalesceMs: options.coalesceMs === undefined ? COALESCE_MS : options.coalesceMs,
    autosaveMs: options.autosaveMs === undefined ? 700 : options.autosaveMs,
    sessionKey: options.sessionKey || SESSION_KEY
  };
  const timers = options.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
  };
  const storage = options.storage !== undefined ? options.storage : detectSessionStorage();
  let idbBackend = options.idb !== undefined ? options.idb : null;

  let state = normalise(initial);
  let baseline = clone(state);           // the last committed state
  const past = [];                       // [{label, state}]
  const future = [];
  const subs = new Set();
  let pending = null;                    // {label, timer}
  let autosaveTimer = null;
  let applying = false;                  // true while undo/redo is restoring

  /* notification */

  function notify(info) {
    for (const fn of [...subs]) {
      try { fn(state, info); } catch (e) { reportError(e); }
    }
    scheduleAutosave();
  }

  /* mutation */

  function apply(next, info) {
    if (next === state) return state;
    state = next;
    notify(info);
    if (info && info.label && !applying) commit(info.label, info);
    return state;
  }

  /**
   * Replace the value at `path`.
   * @param {string|string[]} path  "ui.theme" or ['components', id, 'visible']
   * @param {*} value
   * @param {{label?:string, coalesce?:boolean}} [opts]
   */
  function set(path, value, opts = {}) {
    const prev = getIn(state, path);
    if (same(prev, value)) return state;
    return apply(setIn(state, path, value), { kind: 'set', path, prev, ...opts });
  }

  /** Deep-merge a partial design. */
  function patch(partial, opts = {}) {
    const next = mergeDeep(state, partial);
    if (same(next, state)) return state;
    return apply(next, { kind: 'patch', path: null, ...opts });
  }

  /** `fn(state) => newState` — must be pure; returning the same object is a no-op. */
  function update(fn, opts = {}) {
    const next = fn(state);
    if (!next || next === state) return state;
    return apply(next, { kind: 'update', path: null, ...opts });
  }

  /** Remove a key (a component override, a slot choice…). */
  function remove(path, opts = {}) {
    const next = deleteIn(state, path);
    if (same(next, state)) return state;
    return apply(next, { kind: 'delete', path, ...opts });
  }

  /* op stacks (`design.parts[key].ops`): one call = one named undo step */
  function pushOps(entries, label) {
    return update((s) => entries.reduce((d, e) => withOp(d, e.key, e.op), s), { label: label || 'edit' });
  }
  const dropOp = (key, index, label) => update((s) => withoutOp(s, key, index), { label: label || 'remove op' });
  const clearOps = (keys, label) => update((s) => keys.reduce((d, k) => withoutOps(d, k), s), { label: label || 'reset' });

  /* history */

  /* `snapshot` is the state the entry closes AT — for a coalesced commit that is the state
     when commit() was called, not when the timer fires, so a later, different action
     cannot be swallowed into the entry that is still pending. */
  function pushEntry(label, snapshot) {
    const snap = snapshot === undefined ? clone(state) : snapshot;
    if (same(baseline, snap)) return false;
    past.push({ label: label || 'change', state: baseline });
    while (past.length > cfg.historyCap) past.shift();
    baseline = snap;
    future.length = 0;
    return true;
  }

  /**
   * Close the current change into one undo entry.
   * @param {string} label
   * @param {{coalesce?:boolean, delay?:number}} [opts]  coalesce:true → wait `coalesceMs`
   */
  /* set/patch/update notify without history; commit closes one entry ({coalesce} waits 400 ms,
     a different label flushes first).  `{label}` on set/patch/update does both. */
  function commit(label, opts = {}) {
    if (applying) return false;
    const delay = opts.coalesce ? (opts.delay === undefined ? cfg.coalesceMs : opts.delay) : 0;
    if (!delay) {
      flushHistory();
      const done = pushEntry(label);
      if (done) notify({ kind: 'commit', label });
      return done;
    }
    /* a DIFFERENT action must never merge into the pending one */
    if (pending && pending.label !== label) flushHistory();
    if (pending) timers.clearTimeout(pending.timer);
    const snapshot = clone(state);
    pending = {
      label,
      snapshot,
      timer: timers.setTimeout(() => {
        const p = pending;
        pending = null;
        if (p && pushEntry(p.label, p.snapshot)) notify({ kind: 'commit', label: p.label });
      }, delay)
    };
    return true;
  }

  /**
   * Adopt the current state as the history baseline WITHOUT creating an undo entry.
   *
   * A page that applies the package defaults after `reset()` has changed the state but not
   * the baseline, so the first real undo entry would capture the state from BEFORE the
   * defaults and one Ctrl+Z would throw `design.slots` away.  Call it once the boot-time
   * writes are in.
   * @returns {object} the state it baselined
   */
  function markBaseline() {
    flushHistory();
    baseline = clone(state);
    return state;
  }

  /** Close any pending coalesced commit right now (undo/redo/export do this for you). */
  function flushHistory() {
    if (!pending) return false;
    timers.clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    const done = pushEntry(p.label, p.snapshot);
    if (done) notify({ kind: 'commit', label: p.label });
    return done;
  }

  function canUndo() { return past.length > 0 || (!!pending && !same(baseline, pending.snapshot)); }
  function canRedo() { return future.length > 0; }

  function undo() {
    flushHistory();
    const prev = past.pop();
    if (!prev) return false;
    future.push({ label: prev.label, state: baseline });
    applying = true;
    state = carryUI(state, prev.state);
    baseline = clone(state);
    applying = false;
    notify({ kind: 'undo', label: prev.label });
    return true;
  }

  function redo() {
    flushHistory();
    const next = future.pop();
    if (!next) return false;
    past.push({ label: next.label, state: baseline });
    applying = true;
    state = carryUI(state, next.state);
    baseline = clone(state);
    applying = false;
    notify({ kind: 'redo', label: next.label });
    return true;
  }

  /** `{past:[labels], future:[labels], pending}` — what the topbar's tooltips show. */
  function history() {
    return {
      past: past.map((e) => e.label),
      future: future.map((e) => e.label),
      pending: pending ? pending.label : null,
      cap: cfg.historyCap
    };
  }

  /* persistence */

  function scheduleAutosave() {
    if (!storage || applying) return;
    if (autosaveTimer) timers.clearTimeout(autosaveTimer);
    autosaveTimer = timers.setTimeout(() => { autosaveTimer = null; saveSession(); }, cfg.autosaveMs);
  }

  /** Write the design to sessionStorage now. Returns false when storage is unavailable. */
  function saveSession() {
    if (!storage) return false;
    try {
      storage.setItem(cfg.sessionKey, JSON.stringify({ when: Date.now(), design: withoutOverride(state) }));
      return true;
    } catch (e) { return false; }
  }

  /** Restore the sessionStorage autosave. Returns false when there is nothing usable. */
  function restoreSession() {
    if (!storage) return false;
    let raw = null;
    try { raw = storage.getItem(cfg.sessionKey); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const o = JSON.parse(raw);
      if (!o || !o.design) return false;
      /* `kind` stays one of the nine documented values; WHY the reset
         happened travels in `reason`. */
      reset(o.design, { reason: 'restore' });
      return true;
    } catch (e) { return false; }
  }

  function clearSession() {
    if (!storage) return false;
    try { storage.removeItem(cfg.sessionKey); return true; } catch (e) { return false; }
  }

  async function idb() {
    if (idbBackend) return idbBackend;
    try {
      const m = await import('idb-keyval');
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      idbBackend = { get: m.get, set: m.set, del: m.del };
    } catch (e) {
      const mem = new Map();
      idbBackend = { get: async (k) => mem.get(k), set: async (k, v) => { mem.set(k, v); }, del: async (k) => { mem.delete(k); }, volatile: true };
    }
    return idbBackend;
  }

  /** Explicit save to IndexedDB ("recent designs" on Home).
   *  Storage that throws (a blocked IndexedDB, a private window) returns `false`
   *  rather than rejecting — the same contract as `listSaved()` / `saveSession()`. */
  async function save(id, label) {
    flushHistory();
    try {
      const db = await idb();
      const list = (await db.get(SAVED_KEY)) || [];
      const rec = {
        id: id || 'design-' + Date.now(),
        label: label || state.robot || 'design',
        robot: state.robot,
        savedAt: Date.now(),
        design: clone({ ...withoutOverride(state), saved: new Date().toISOString() })
      };
      await db.set(SAVED_KEY, [rec, ...list.filter((x) => x.id !== rec.id)].slice(0, 24));
      return rec;
    } catch (e) { return false; }
  }

  async function listSaved() {
    try { const db = await idb(); return (await db.get(SAVED_KEY)) || []; } catch (e) { return []; }
  }

  async function load(id) {
    const list = await listSaved();
    const rec = list.find((x) => x.id === id);
    if (!rec) return null;
    reset(rec.design, { reason: 'load', label: rec.label });
    return rec;
  }

  /* ---------------------------------------------------------- import / export -- */

  /** The design as JSON text. */
  function exportJSON(pretty = true) {
    flushHistory();
    const out = { ...withoutOverride(state), saved: new Date().toISOString() };
    return JSON.stringify(out, null, pretty ? 2 : 0);
  }

  /**
   * Load a design from JSON, forward-compatibly: unknown keys are KEPT, missing keys come
   * from `defaultDesign()`, and a newer minor schema loads with a warning rather than an
   * error.  Returns `{ok, warnings, errors}`.
   * @param {string|object} json
   * @param {{robot?:string, merge?:boolean}} [opts]  merge:true keeps the current robot/ui
   */
  function importJSON(json, opts = {}) {
    const warnings = [], errors = [];
    let obj = json;
    if (typeof json === 'string') {
      try { obj = JSON.parse(json); } catch (e) { return { ok: false, warnings, errors: ['not valid JSON: ' + e.message] }; }
    }
    if (!isObj(obj)) return { ok: false, warnings, errors: ['the design must be a JSON object'] };
    const schema = obj.schema || '';
    if (schema !== DESIGN_SCHEMA) {
      if (/^rps\/design@/.test(schema)) warnings.push(`design schema "${schema}" ≠ "${DESIGN_SCHEMA}" — loaded anyway`);
      else if (/^lekiwi-studio\/design@/.test(schema)) warnings.push('a v3 design: only the keys v4 knows were kept');
      else if (schema) errors.push(`"${schema}" is not a LeRobot CAD Studio design`);
      else warnings.push('no schema field — assuming ' + DESIGN_SCHEMA);
    }
    if (errors.length) return { ok: false, warnings, errors };

    /* A DESIGN NAMES ITS ROBOT.  Merged onto a different package its slot ids, its camera
       overrides and its removed components mean something else, so the load is refused
       rather than half-applied — there is nothing sensible to keep. */
    if (opts.merge && typeof obj.robot === 'string' && obj.robot && state.robot && obj.robot !== state.robot) {
      return { ok: false, warnings, errors: [`design is for ${obj.robot}; open that robot first`] };
    }

    /* the file is DATA: every top-level field is type-checked and a wrong one is dropped */
    const clean = sanitiseDesign(obj);
    warnings.push(...clean.warnings);
    /* merge:true KEEPS the current robot and the current ui: a design
       dropped onto a robot that is already open must not silently re-point the page at
       a different package, nor throw away the panels/selection the user is looking at.
       Everything else is the file's or the default, never the page's leftovers. */
    const base = opts.merge ? { ...defaultDesign(state.robot), robot: state.robot, ui: state.ui }
      : defaultDesign(clean.design.robot || opts.robot || state.robot);
    const incoming = { ...clean.design, schema: DESIGN_SCHEMA };
    if (opts.merge) { delete incoming.robot; delete incoming.ui; }
    const next = mergeDeep(base, incoming);
    if (opts.robot) next.robot = opts.robot;
    reset(next, { kind: 'import', label: 'import design' });
    return { ok: true, warnings, errors };
  }

  /** Replace the whole state and clear the history (loading a different design). */
  function reset(next, info = {}) {
    flushHistory();
    applying = true;
    state = normalise(next);
    baseline = clone(state);
    past.length = 0;
    future.length = 0;
    applying = false;
    notify({ kind: 'reset', ...info });
    return state;
  }

  /* subscription */

  /**
   * @param {(state:object, info:{kind:string,label?:string,path?:string|string[]})=>void} fn
   * @param {{immediate?:boolean}} [opts]
   * @returns {()=>void} unsubscribe
   */
  function subscribe(fn, opts = {}) {
    subs.add(fn);
    if (opts.immediate) { try { fn(state, { kind: 'init' }); } catch (e) { reportError(e); } }
    return () => subs.delete(fn);
  }

  /** Subscribe to one path only — fires when `getIn(state, path)` changes identity. */
  function subscribePath(path, fn, opts = {}) {
    let last = getIn(state, path);
    if (opts.immediate) fn(last, undefined, { kind: 'init' });
    return subscribe((s, info) => {
      const now = getIn(s, path);
      if (now === last) return;
      const prev = last;
      last = now;
      fn(now, prev, info);
    });
  }

  return {
    /* state */
    get state() { return state; },
    getState: () => state,
    get: (path, fallback) => getIn(state, path, fallback),
    /* mutation */
    set, patch, update, remove, reset, pushOps, dropOp, clearOps,
    /* history */
    commit, flushHistory, markBaseline, undo, redo, canUndo, canRedo, history,
    /* subscription */
    subscribe, subscribePath,
    /* persistence */
    saveSession, restoreSession, clearSession, save, load, listSaved,
    exportJSON, importJSON,
    /* introspection (tests, debug overlay) */
    config: cfg,
    _internals: { get past() { return past; }, get future() { return future; }, get pending() { return pending; }, get baseline() { return baseline; } }
  };
}

/* helpers */

/* Every way in goes through here — the constructor, reset(), restoreSession(), load() — so a
   corrupted autosave is REPAIRED on boot instead of half-mounting the page. */
function normalise(d) {
  const clean = sanitiseDesign(d);
  const base = defaultDesign(clean.design.robot || null);
  const out = mergeDeep(base, clean.design);
  out.schema = DESIGN_SCHEMA;
  /* every way in goes through here, so a waiver can never arrive from a file or a restore */
  return withoutOverride(out);
}

function detectSessionStorage() {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    sessionStorage.setItem('rps/probe', '1');
    sessionStorage.removeItem('rps/probe');
    return sessionStorage;
  } catch (e) { return null; }
}

function reportError(e) {
  if (typeof console !== 'undefined' && console.error) console.error('store: subscriber threw —', e);
}

/** An in-memory Storage stand-in (tests, and `file://` where sessionStorage throws). */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null
  };
}
