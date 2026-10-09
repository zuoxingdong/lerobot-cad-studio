/* The keyboard and mouse model: one declarative table (KEYS), one context function and one
   dispatcher.  A binding carries an ACTION NAME, not a closure, so this module is DOM-free
   and the help overlay is rendered from the same table.  Needs nothing. */

/* platform */

/** "⌘" on a Mac, "Ctrl" everywhere else. `nav` is injectable so this module has no DOM. */
export function modKeyLabel(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
  const s = n ? ((n.platform || '') + ' ' + (n.userAgent || '')) : '';
  return /Mac|iPhone|iPad/.test(s) ? '⌘' : 'Ctrl';
}

export const MODK = modKeyLabel();

/* contexts */

/* There is one tab, so `ALL_TABS` holds one entry: a binding on a tab the app never
   creates is a key the help overlay advertises and nothing answers. */
export const CONTEXTS = ['typing', 'overlay', 'design'];
const ALL_TABS = ['design'];

/**
 * The environment the dispatcher asks about the app.  Every field is optional and
 * defaults to "no".  Supply the ones your surface has.
 * @typedef {{isTyping?:(e:KeyboardEvent)=>boolean, overlay?:()=>(string|false|null),
 *            menuOpen?:()=>boolean,
 *            hasSelection?:()=>boolean,
 *            canvasFocused?:()=>boolean, gizmoDragging?:()=>boolean}} KeyEnv
 */

const NO = () => false;

function envOf(env) {
  const e = env || {};
  return {
    isTyping: e.isTyping || defaultIsTyping,
    overlay: e.overlay || (() => false),
    menuOpen: e.menuOpen || NO,
    hasSelection: e.hasSelection || NO,
    canvasFocused: e.canvasFocused || NO,
    gizmoDragging: e.gizmoDragging || NO
  };
}

/** Focus is in a text field.  Reads the event only — no `document`. */
function defaultIsTyping(e) {
  const t = e && e.target;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Exactly one context, in priority order.
 * @param {KeyEnv} env
 * @param {KeyboardEvent} [e]
 */
export function keyContext(env, e) {
  const E = envOf(env);
  if (E.menuOpen() || E.overlay()) return 'overlay';
  if (e && E.isTyping(e)) return 'typing';
  return 'design';
}

/* the table */
/* Fields
 *   id          stable identifier (tests, settings, the help overlay's DOM ids)
 *   g           help group
 *   keys        what the overlay prints
 *   label       what it does
 *   action      the action name the UI binds (null for `display` rows)
 *   args        static args, or (e) => args
 *   k           e.key match, case-insensitive (a string or an array)
 *   code        e.code match (layout independent; positional keys use this)
 *   test        a custom (e) => boolean matcher
 *   mod         true = Ctrl/Cmd required; otherwise Ctrl/Cmd/Alt disqualify the binding
 *   shift       true = required, false = must NOT be held, undefined = don't care
 *   ctx         contexts it lives in ('*' = all)
 *   allowTyping also fires inside a text field
 *   repeat      honours the OS auto-repeat
 *   needs       'selection' | 'menu' | 'canvas' — an env guard
 *   display     help only, never dispatched (browser behaviour)
 *   hideInHelp  dispatched but not printed (aliases)
 */
export const KEYS = [
  /* view */
  { id: 'view.tab', g: 'View', keys: '1 2 3', action: 'view.tab', ctx: ALL_TABS,
    test: (e) => /^Digit[1-3]$/.test(e.code) || /^[1-3]$/.test(e.key),
    args: (e) => ({ tab: ['design', 'check', 'sim'][Number(/^Digit[1-3]$/.test(e.code) ? e.code.slice(5) : e.key) - 1] }),
    label: 'Design · Check · Sim' },
  { id: 'view.home', g: 'View', keys: 'Home', action: 'view.reset-camera', k: 'Home', ctx: ALL_TABS,
    label: 'reset the camera' },
  { id: 'view.frame', g: 'View', keys: 'Z', action: 'view.frame-selection', k: 'z', shift: false, ctx: ALL_TABS,
    label: 'frame the selection' },
  { id: 'view.grid', g: 'View', keys: 'G', action: 'view.grid', k: 'g', ctx: ALL_TABS,
    label: 'grid on / off' },
  { id: 'view.isolate', g: 'View', keys: 'I', action: 'view.isolate', k: 'i', ctx: ALL_TABS,
    label: 'isolate the selection' },
  { id: 'global.theme', g: 'View', keys: 'T', action: 'global.theme', k: 't', ctx: ALL_TABS,
    label: 'theme' },
  { id: 'view.hide', g: 'View', keys: 'Shift V', action: 'view.hide-selection', k: 'v', shift: true, ctx: ALL_TABS, hideInHelp: true,
    label: 'hide / show the selection' },

  /* select */
  { id: 'global.escape', g: 'Select', keys: 'Esc', action: 'global.escape', k: 'Escape', ctx: '*', allowTyping: true,
    label: 'back out, then clear the selection' },
  { id: 'design.variant', g: 'Select', keys: '[  ]', action: 'design.variant', k: ['[', ']'], ctx: ['design'],
    args: (e) => ({ delta: e.key === ']' ? 1 : -1 }),
    label: 'previous / next option' },
  { id: 'selection.delete', g: 'Select', keys: 'Del', action: 'selection.delete', k: ['Delete', 'Backspace'], ctx: ALL_TABS, needs: 'selection',
    label: 'delete the selection (restorable)' },
  { id: 'selection.open', g: 'Select', keys: 'Enter', action: 'selection.open', k: 'Enter', ctx: ALL_TABS, needs: 'canvasSelection', hideInHelp: true,
    label: 'focus the inspector' },

  /* edit */
  { id: 'global.undo', g: 'Edit', keys: MODK + ' Z · ⇧' + MODK + ' Z', action: 'global.undo', k: 'z', mod: true, shift: false, ctx: '*', allowTyping: true,
    label: 'undo · redo' },
  { id: 'global.redo', g: 'Edit', keys: MODK + ' Shift Z', action: 'global.redo', k: 'z', mod: true, shift: true, ctx: '*', allowTyping: true, hideInHelp: true,
    label: 'redo' },
  { id: 'global.redo-y', g: 'Edit', keys: MODK + ' Y', action: 'global.redo', k: 'y', mod: true, ctx: '*', allowTyping: true, hideInHelp: true,
    label: 'redo' },
  { id: 'global.save', g: 'Edit', keys: MODK + ' S', action: 'global.save-design', k: 's', mod: true, shift: false, ctx: '*', allowTyping: true,
    label: 'save the design' },
  { id: 'global.save-assembly', g: 'Edit', keys: MODK + ' Shift S', action: 'global.save-assembly', k: 's', mod: true, shift: true, ctx: '*', allowTyping: true, hideInHelp: true,
    label: 'save the robot package' },
  { id: 'global.open', g: 'Edit', keys: MODK + ' O', action: 'global.open', k: 'o', mod: true, ctx: '*', allowTyping: true,
    label: 'open a design' },
  { id: 'global.export', g: 'Edit', keys: MODK + ' E', action: 'global.export', k: 'e', mod: true, ctx: '*', allowTyping: true,
    label: 'Export' },

  /* arm */
  { id: 'arm.preset-next', g: 'Arm', keys: 'P', action: 'arm.preset', args: { delta: 1 }, k: 'p', shift: false, ctx: ALL_TABS,
    label: 'next pose (Shift P back)' },
  { id: 'arm.preset-prev', g: 'Arm', keys: 'Shift P', action: 'arm.preset', args: { delta: -1 }, k: 'p', shift: true, ctx: ALL_TABS, hideInHelp: true,
    label: 'previous pose' },
  { id: 'arm.home', g: 'Arm', keys: 'H', action: 'arm.home', k: 'h', ctx: ALL_TABS,
    label: 'stow the arm' },
  { id: 'arm.gripper', g: 'Arm', keys: 'F', action: 'arm.gripper', k: 'f', ctx: ALL_TABS,
    label: 'gripper open / close' },

  /* bound, not printed */
  { id: 'global.help', g: 'View', keys: '?', action: 'global.help', k: ['?', 'F1'], ctx: '*', hideInHelp: true,
    label: 'these keys' },
  { id: 'global.space', g: 'View', keys: 'Space', action: 'global.space-reserved', ctx: ALL_TABS, hideInHelp: true,
    test: (e) => e.key === ' ' && isBareTarget(e),
    label: 'swallowed on the canvas so the page never scrolls' },
  { id: 'assembly.translate', g: 'Edit', keys: 'W', action: 'gizmo.mode', args: { mode: 'translate' }, k: 'w', ctx: ALL_TABS, needs: 'selection', hideInHelp: true,
    label: 'gizmo: move' },
  { id: 'assembly.rotate', g: 'Edit', keys: 'E', action: 'gizmo.mode', args: { mode: 'rotate' }, k: 'e', ctx: ALL_TABS, needs: 'selection', hideInHelp: true,
    label: 'gizmo: rotate' },
  { id: 'menu.move', g: 'Select', keys: '↑ ↓', action: 'menu.move', k: ['ArrowUp', 'ArrowDown'], ctx: ['overlay'], needs: 'menu', hideInHelp: true,
    args: (e) => ({ delta: e.key === 'ArrowDown' ? 1 : -1 }),
    label: 'move through the menu' },
  { id: 'menu.activate', g: 'Select', keys: 'Enter', action: 'menu.activate', k: 'Enter', ctx: ['overlay'], needs: 'menu', hideInHelp: true,
    label: 'run the menu row' },
];

/** The mouse, for the keys overlay. */
export const MOUSE = [
  { keys: 'click · Shift click', label: 'select · add to the selection' },
  { keys: 'drag · right-drag · wheel', label: 'orbit · pan · zoom' },
];

/** Every action name the table can emit — the UI must cover these. */
export const ACTIONS = [...new Set(KEYS.filter((b) => b.action).map((b) => b.action))].sort();

/* matching */

function isBareTarget(e) {
  const t = e && e.target;
  if (!t) return true;
  const tag = (t.tagName || '').toUpperCase();
  return tag === 'BODY' || tag === 'CANVAS' || tag === 'HTML' || t.dataset?.keyTarget === 'canvas';
}

function ctxOK(b, ctx) { return b.ctx === '*' || (Array.isArray(b.ctx) && b.ctx.includes(ctx)); }

const normKey = (x) => (x && x.length === 1 ? x.toLowerCase() : x);

/** Does this binding match this event's keys + modifiers?  (Context is checked separately.) */
export function keyMatches(b, e) {
  /* Alt is never part of a binding, so it must not be ignored either: Ctrl+Alt+Z is
     AltGr+Z on a European layout, and that is not undo. */
  if (b.mod) { if (!(e.ctrlKey || e.metaKey) || e.altKey) return false; }
  else if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (b.shift === true && !e.shiftKey) return false;
  if (b.shift === false && e.shiftKey) return false;
  if (typeof b.test === 'function') return b.test(e);
  if (b.code) return (Array.isArray(b.code) ? b.code : [b.code]).includes(e.code);
  if (!b.k) return false;
  const k = normKey(e.key);
  return (Array.isArray(b.k) ? b.k : [b.k]).some((x) => normKey(x) === k);
}

function guardOK(b, E) {
  switch (b.needs) {
    case 'selection': return E.hasSelection();
    case 'menu': return E.menuOpen();
    case 'canvasSelection': return E.hasSelection() && E.canvasFocused();
    case 'canvas': return E.canvasFocused();
    default: return true;
  }
}

/**
 * What would this key event do, right now?  Pure — no side effects, no preventDefault.
 * @param {KeyboardEvent} e
 * @param {KeyEnv} env
 * @returns {{action:string, args:object, binding:object, context:string, preventDefault:boolean}
 *           | {action:null, kind:'repeat-swallow'|null, context:string, preventDefault:boolean}}
 */
export function resolveKey(e, env) {
  const E = envOf(env);
  const ctx = keyContext(env, e);

  for (const b of KEYS) {
    if (b.display || !b.action || !ctxOK(b, ctx)) continue;
    if (ctx === 'typing' && !b.allowTyping) continue;
    if (!guardOK(b, E)) continue;
    if (!keyMatches(b, e)) continue;
    if (e.repeat && !b.repeat) {
      return { action: null, kind: 'repeat-swallow', binding: b, context: ctx, preventDefault: true };
    }
    const args = typeof b.args === 'function' ? b.args(e) : (b.args || {});
    return { action: b.action, args, binding: b, context: ctx, preventDefault: true };
  }

  return { action: null, kind: null, context: ctx, preventDefault: false };
}

/* dispatcher */

/**
 * Wire the table to an action map.
 *
 *   const km = createDispatcher({ env, actions: { 'view.grid': () => …, … } });
 *   window.addEventListener('keydown', km.onKeyDown);
 *   window.addEventListener('keyup',   km.onKeyUp);
 *   window.addEventListener('blur',    km.releaseAll);
 *
 * @param {{env:KeyEnv, actions:Object<string,Function>, onAction?:Function,
 *          onShift?:(down:boolean)=>void, onMissing?:(action:string)=>void}} cfg
 */
export function createDispatcher(cfg) {
  const env = cfg.env || {};
  const actions = cfg.actions || {};
  let shiftDown = false;

  function fire(action, args, e, binding) {
    const fn = actions[action];
    if (!fn) {
      if (cfg.onMissing) cfg.onMissing(action, args, binding);
      return false;
    }
    fn(args, e, binding);
    if (cfg.onAction) cfg.onAction(action, args, binding, e);
    return true;
  }

  function onKeyDown(e) {
    if (shiftDown !== e.shiftKey) { shiftDown = e.shiftKey; if (cfg.onShift) cfg.onShift(e.shiftKey); }
    if (e.defaultPrevented) return null;
    const r = resolveKey(e, env);
    if (r.action) fire(r.action, r.args, e, r.binding);
    if (r.preventDefault && e.preventDefault) e.preventDefault();
    return r;
  }

  function onKeyUp(e) {
    if (shiftDown !== e.shiftKey) { shiftDown = e.shiftKey; if (cfg.onShift) cfg.onShift(e.shiftKey); }
  }

  /* A keyup can be lost to an OS dialog, a window switch or a hidden tab: `onShift` only
     fires again on the next key event, so alt-tabbing away with Shift down would leave the
     gizmo un-snapped.  Call from blur / pagehide / visibilitychange. */
  function releaseAll() {
    if (shiftDown) { shiftDown = false; if (cfg.onShift) cfg.onShift(false); }
  }

  return {
    onKeyDown, onKeyUp, releaseAll,
    get shiftDown() { return shiftDown; },
    resolve: (e) => resolveKey(e, env),
    context: (e) => keyContext(env, e)
  };
}

/* help model */

/**
 * The help overlay's content, generated FROM the table so it cannot drift.
 * @param {string} [ctx]  the live context — its group is marked `current`
 * @returns {{groups:Array<{name:string,current:boolean,rows:Array<{keys,label,inert}>}>, mouse:Array}}
 */
export function helpModel(ctx) {
  const order = ['View', 'Select', 'Edit', 'Arm', 'Mouse'];
  const byGroup = new Map();
  for (const b of KEYS) {
    if (b.hideInHelp) continue;
    if (!byGroup.has(b.g)) byGroup.set(b.g, []);
    byGroup.get(b.g).push({
      id: b.id,
      keys: b.keys,
      label: b.label,
      inert: !!ctx && !b.display && !ctxOK(b, ctx)
    });
  }
  byGroup.set('Mouse', MOUSE.map((m, i) => ({ id: 'mouse.' + i, keys: m.keys, label: m.label, inert: false })));
  const names = [...byGroup.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const groups = names.map((name) => ({ name, current: false, rows: byGroup.get(name) }));
  return { groups, mouse: MOUSE, context: ctx || null, rows: groups.reduce((n, g) => n + g.rows.length, 0) };
}

/* diagnostics */

/**
 * Static audit of the table: a key must not mean two things in one context (rule 3), and
 * no binding may honour auto-repeat (rule 9).  The keymap test runs this.
 */
export function auditKeymap() {
  const problems = [];
  for (const ctx of CONTEXTS) {
    const seen = new Map();
    for (const b of KEYS) {
      if (b.display || !b.action || !ctxOK(b, ctx)) continue;
      for (const sig of signatures(b)) {
        const key = sig;
        if (seen.has(key)) problems.push(`${ctx}: "${sig}" is bound by both ${seen.get(key)} and ${b.id}`);
        else seen.set(key, b.id);
      }
    }
  }
  for (const b of KEYS) {
    if (b.repeat) problems.push(`${b.id}: repeat:true on a discrete binding`);
    if (!b.display && !b.action) problems.push(`${b.id}: no action and not marked display`);
    if (!b.id || !b.keys || !b.label) problems.push(`a binding is missing id/keys/label: ${JSON.stringify(b.keys || b.id)}`);
  }
  return problems;
}

function signatures(b) {
  const mods = (b.mod ? 'mod+' : '') + (b.shift === true ? 'shift+' : '');
  if (b.test) return ['test:' + b.id];                     // custom matchers cannot collide statically
  const list = b.code ? (Array.isArray(b.code) ? b.code : [b.code])
    : (Array.isArray(b.k) ? b.k : (b.k ? [b.k] : []));
  return list.map((x) => mods + normKey(x) + (b.needs ? '#' + b.needs : ''));
}
