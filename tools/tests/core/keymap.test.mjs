/* core/keymap.js: contexts, key resolution, the dispatcher, the help model and the audit that
 * refuses two actions on one key in one context. */

import { KEYS, MOUSE, ACTIONS, CONTEXTS, keyContext, resolveKey, createDispatcher,
  helpModel, auditKeymap, keyMatches, modKeyLabel } from '../../../src/core/keymap.js';
import { test, run, ok, eq, deep } from './_harness.mjs';

/** A KeyboardEvent stand-in: only the fields the dispatcher reads. */
function ev(key, opts = {}) {
  const code = opts.code || guessCode(key);
  let prevented = false;
  return {
    key, code,
    ctrlKey: !!opts.ctrl, metaKey: !!opts.meta, altKey: !!opts.alt, shiftKey: !!opts.shift,
    repeat: !!opts.repeat,
    target: opts.target || { tagName: 'BODY' },
    defaultPrevented: false,
    preventDefault() { prevented = true; },
    get prevented() { return prevented; }
  };
}
function guessCode(k) {
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (k === ' ') return 'Space';
  return k;
}

const ENV = (over = {}) => ({
  isTyping: (e) => (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target.tagName || '').toUpperCase())),
  overlay: () => false, menuOpen: () => false,
  hasSelection: () => false,
  canvasFocused: () => false, gizmoDragging: () => false,
  ...over
});

const act = (e, env) => resolveKey(e, env).action;

test('the table is consistent: unique ids, a key and a label each, no key means two things', () => {
  deep(auditKeymap(), []);
  for (const b of KEYS) ok(b.id && b.keys && b.label, JSON.stringify(b));
  eq(new Set(KEYS.map((b) => b.id)).size, KEYS.length);
  eq(KEYS.filter((b) => b.repeat).length, 0, 'nothing honours the OS auto-repeat');
});

test('keyContext: typing > overlay > design', () => {
  eq(keyContext(ENV(), ev('a')), 'design');
  eq(keyContext(ENV(), ev('a', { target: { tagName: 'INPUT' } })), 'typing');
  eq(keyContext(ENV({ overlay: () => 'help' }), ev('a')), 'overlay');
  eq(keyContext(ENV({ menuOpen: () => true }), ev('a')), 'overlay');
  deep(CONTEXTS, ['typing', 'overlay', 'design']);
});

test('the design keys, and the ones deliberately left unbound', () => {
  const d = ENV();
  const want = { t: 'global.theme', g: 'view.grid', '[': 'design.variant', '1': 'view.tab', p: 'arm.preset',
    h: 'arm.home', f: 'arm.gripper', a: null, c: null, d: null, y: null, o: null, v: null, u: null, b: null, w: null, '4': null };
  for (const [k, a] of Object.entries(want)) eq(act(ev(k), d), a, k);
  eq(resolveKey(ev('p', { shift: true }), d).args.delta, -1);
  ok(!KEYS.some((b) => /^drive\./.test(b.id)), 'a Drive binding is back');
  for (const k of ['t', 'g', '[', 'p']) {
    const r = resolveKey(ev(k, { repeat: true }), d);
    ok(r.action === null && r.kind === 'repeat-swallow' && r.preventDefault, k + ' re-fires on auto-repeat');
  }
});

test('1 2 3 are the tabs on e.code, so AZERTY works; off in an overlay', () => {
  const azerty = ev('&', { code: 'Digit1' });
  eq(resolveKey(azerty, ENV()).args.tab, 'design');
  deep(['1', '2', '3'].map((k) => resolveKey(ev(k), ENV()).args.tab), ['design', 'check', 'sim']);
  for (const k of ['1', '[', ']', 't']) eq(act(ev(k), ENV({ overlay: () => 'help' })), null, k);
});

test('? and F1 open the help everywhere but a text field', () => {
  for (const c of [ENV(), ENV({ overlay: () => 'help' }), ENV({ menuOpen: () => true })]) {
    eq(act(ev('?', { shift: true }), c), 'global.help');
    eq(act(ev('F1'), c), 'global.help');
  }
  eq(act(ev('?', { shift: true, target: { tagName: 'INPUT' } }), ENV()), null);
});

test('Ctrl / Cmd chords are global; Alt disqualifies them (AltGr is not undo)', () => {
  for (const env of [ENV(), ENV({ overlay: () => 'help' }), ENV({ isTyping: () => true })]) {
    eq(act(ev('s', { ctrl: true }), env), 'global.save-design');
    eq(act(ev('s', { meta: true }), env), 'global.save-design');
    eq(act(ev('s', { ctrl: true, shift: true }), env), 'global.save-assembly');
    eq(act(ev('e', { ctrl: true }), env), 'global.export');
    eq(act(ev('z', { ctrl: true }), env), 'global.undo');
    eq(act(ev('z', { ctrl: true, shift: true }), env), 'global.redo');
    eq(act(ev('y', { ctrl: true }), env), 'global.redo');
    eq(act(ev('o', { ctrl: true }), env), 'global.open');
  }
  for (const o of [{ ctrl: true, alt: true }, { meta: true, alt: true }]) eq(act(ev('z', o), ENV()), null);
  const undo = KEYS.find((x) => x.id === 'global.undo');
  ok(keyMatches(undo, ev('z', { ctrl: true })) && !keyMatches(undo, ev('z', { ctrl: true, alt: true })));
});

test('with a selection: w / e set the gizmo, Delete deletes; no scale or local/world key', () => {
  const sel = ENV({ hasSelection: () => true });
  eq(act(ev('w'), sel), 'gizmo.mode');
  eq(resolveKey(ev('e'), sel).args.mode, 'rotate');
  eq(act(ev('Delete', { key: 'Delete' }), sel), 'selection.delete');
  eq(act(ev('r'), sel), null);
  eq(act(ev('x'), sel), null);
});

test('Tab is never captured; Space only off buttons; typing and overlays suspend letters; menus navigate', () => {
  for (const env of [ENV(), ENV({ overlay: () => 'help' })]) {
    const r = resolveKey(ev('Tab'), env);
    ok(r.action === null && r.preventDefault === false);
  }
  eq(act(ev(' ', { target: { tagName: 'CANVAS' } }), ENV()), 'global.space-reserved');
  eq(act(ev(' ', { target: { tagName: 'BUTTON' } }), ENV()), null);
  const typing = ENV({ isTyping: () => true });
  for (const k of ['t', 'g', 'v', 'i', 'p', 'h', 'f', 'z', '1']) eq(act(ev(k), typing), null, k);
  eq(act(ev('Escape'), typing), 'global.escape');
  eq(act(ev('Escape'), ENV({ overlay: () => 'help' })), 'global.escape');
  const menu = ENV({ overlay: () => 'menu', menuOpen: () => true });
  eq(act(ev('ArrowDown'), menu), 'menu.move');
  eq(resolveKey(ev('ArrowUp'), menu).args.delta, -1);
  eq(act(ev('Enter'), menu), 'menu.activate');
});

test('the dispatcher fires and preventDefaults handled keys, reports missing actions, skips handled events', () => {
  const fired = [];
  const km = createDispatcher({ env: ENV(), actions: { 'view.grid': () => fired.push('grid'), 'arm.gripper': () => fired.push('gripper') } });
  const e = ev('g'); km.onKeyDown(e);
  km.onKeyDown(ev('f'));
  deep(fired, ['grid', 'gripper']);
  ok(e.prevented);
  const d = ev('d'); km.onKeyDown(d);
  ok(!d.prevented, 'an unbound key is left to the browser');
  const missing = [];
  createDispatcher({ env: ENV(), actions: {}, onMissing: (a) => missing.push(a) }).onKeyDown(ev('g'));
  deep(missing, ['view.grid']);
  const handled = ev('g'); handled.defaultPrevented = true;
  eq(createDispatcher({ env: ENV(), actions: {} }).onKeyDown(handled), null);
});

test('Shift is reported once per transition, and releaseAll() releases it once', () => {
  const shifts = [];
  const km = createDispatcher({ env: ENV(), actions: {}, onShift: (d) => shifts.push(d) });
  km.onKeyDown(ev('Shift', { shift: true }));
  km.onKeyDown(ev('Shift', { shift: true, repeat: true }));
  km.onKeyUp(ev('Shift', { shift: false }));
  deep(shifts, [true, false]);
  km.onKeyDown(ev('Shift', { code: 'ShiftLeft', shift: true }));
  km.releaseAll();
  km.releaseAll();
  eq(km.shiftDown, false);
  deep(shifts, [true, false, true, false]);
});

test('helpModel comes from the table, ≤ 18 rows; keyMatches and the platform modifier label', () => {
  const h = helpModel('design');
  deep(h.groups.map((g) => g.name), ['View', 'Select', 'Edit', 'Arm', 'Mouse']);
  const all = h.groups.flatMap((g) => g.rows);
  eq(all.length, KEYS.filter((b) => !b.hideInHelp).length + MOUSE.length);
  ok(all.length <= 18 && all.every((r) => r.keys && r.label), all.length + ' rows');
  const b = KEYS.find((x) => x.id === 'view.grid');
  ok(keyMatches(b, ev('g')) && keyMatches(b, ev('G', { shift: true })));
  for (const m of [{ ctrl: true }, { alt: true }, { meta: true }]) ok(!keyMatches(b, ev('g', m)));
  eq(modKeyLabel({ platform: 'MacIntel', userAgent: '' }), '⌘');
  eq(modKeyLabel({ platform: 'Linux', userAgent: 'X11' }), 'Ctrl');
});

await run('core/keymap — contexts, bindings, dispatcher, help');
