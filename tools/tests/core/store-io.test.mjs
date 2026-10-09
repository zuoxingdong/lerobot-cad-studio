/* core/store.js persistence: autosave, IndexedDB saves, JSON import/export and repair. */
import { createStore, defaultDesign, memoryStorage, DESIGN_SCHEMA } from '../../../src/core/store.js';
import { test, run, ok, eq, deep } from './_harness.mjs';
import { mk, fakeTimers } from './_store.mjs';

test('autosave is debounced and restores; hostile storage never throws', () => {
  const storage = memoryStorage();
  const timers = fakeTimers();
  const store = createStore({ robot: 'lekiwi' }, { storage, timers: timers.api });
  store.set('ui.theme', 'dark');
  eq(storage.getItem('rps/session@1'), null);
  timers.tick(700);
  ok(storage.getItem('rps/session@1'));
  const fresh = createStore(null, { storage, timers: timers.api });
  ok(fresh.restoreSession());
  eq(fresh.get('ui.theme'), 'dark');
  eq(fresh.history().past.length, 0, 'a restore is not an undo step');
  fresh.clearSession();
  eq(fresh.restoreSession(), false);
  const hostile = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} };
  const s2 = createStore(null, { storage: hostile, timers: timers.api });
  s2.set('ui.theme', 'dark');
  timers.tick(700);
  eq(s2.saveSession(), false); eq(s2.restoreSession(), false);
  eq(s2.get('ui.theme'), 'dark');
});

test('"Export anyway" is never written out and never read back in', () => {
  const storage = memoryStorage();
  const store = createStore({ robot: 'lekiwi-pincopen' }, { timers: fakeTimers().api, storage });
  store.set('ui.exportAnyway', true);
  eq(JSON.parse(store.exportJSON()).ui.exportAnyway, false);
  ok(store.saveSession());
  eq(JSON.parse(storage.getItem('rps/session@1')).design.ui.exportAnyway, false);
  eq(store.get('ui.exportAnyway'), true);
  const s2 = createStore({ robot: 'lekiwi-pincopen', ui: { exportAnyway: true } }, { storage: memoryStorage() });
  eq(s2.get('ui.exportAnyway'), false);
  s2.reset({ schema: DESIGN_SCHEMA, robot: 'lekiwi-pincopen', ui: { exportAnyway: true } });
  eq(s2.get('ui.exportAnyway'), false);
});

test('save / load / listSaved through IndexedDB; a blocked one degrades', async () => {
  const mem = new Map();
  const idb = { get: async (k) => mem.get(k), set: async (k, v) => { mem.set(k, v); }, del: async (k) => { mem.delete(k); } };
  const store = createStore({ robot: 'lekiwi' }, { storage: memoryStorage(), idb });
  store.set('ui.theme', 'dark');
  const rec = await store.save('d1', 'my design');
  eq(rec.id, 'd1'); ok(rec.design.saved);
  eq((await store.listSaved()).length, 1);
  store.set('ui.theme', 'light');
  await store.load('d1');
  eq(store.get('ui.theme'), 'dark');
  eq(await store.load('nope'), null);
  const boom = { get: async () => { throw new Error('blocked'); }, set: async () => {}, del: async () => {} };
  const b = createStore({ robot: 'x' }, { storage: memoryStorage(), idb: boom });
  eq(await b.save('d1', 'x'), false);
  deep(await b.listSaved(), []);
});

test('exportJSON / importJSON round-trip, forward-compatibly; a refusal changes nothing', () => {
  const { store } = mk();
  store.set('joints.arm_shoulder_pan', 25);
  store.set('components.corner_mast_printed_head.color', '#ff8800');
  store.update((st) => ({ ...st, removed: { 'Camera-Model-v3': true } }), { label: 'delete' });
  const text = store.exportJSON();
  eq(JSON.parse(text).schema, DESIGN_SCHEMA);
  const other = createStore(null, { storage: memoryStorage() });
  ok(other.importJSON(text).ok);
  eq(other.get('joints.arm_shoulder_pan'), 25);
  eq(other.get('components.corner_mast_printed_head.color'), '#ff8800');
  deep(other.get('removed'), { 'Camera-Model-v3': true });
  eq(other.history().past.length, 0, 'an import resets the history');
  ok(other.importJSON({ schema: DESIGN_SCHEMA, robot: 'lekiwi', future_feature: { hello: 1 } }).ok);
  deep(other.get('future_feature'), { hello: 1 }, 'unknown keys are kept');
  eq(other.get('ui.theme'), 'auto', 'missing keys come from defaultDesign()');
  eq(other.importJSON({ schema: 'rps/design@2', robot: 'lekiwi' }).warnings.length, 1, 'a newer schema warns');
  const before = other.getState();
  ok(!other.importJSON({ schema: 'some/other@1' }).ok);
  ok(!other.importJSON('{not json').ok);
  ok(other.getState() === before);
});

test('merge keeps the current ui and refuses a design for another robot', () => {
  const { store } = mk();
  store.set('ui.selected', 'corner_mast_printed_head');
  store.set('ui.theme', 'dark');
  ok(store.importJSON({ schema: DESIGN_SCHEMA, robot: 'lekiwi-pincopen', ui: { theme: 'light' }, joints: { arm_wrist_roll: 12 } }, { merge: true }).ok);
  eq(store.get('ui.theme'), 'dark');
  eq(store.get('ui.selected'), 'corner_mast_printed_head');
  eq(store.get('joints.arm_wrist_roll'), 12);
  const r = store.importJSON({ schema: DESIGN_SCHEMA, robot: 'lekiwi', cameras: { top: { hfov_deg: 120 } } }, { merge: true });
  eq(r.ok, false);
  eq(r.errors[0], 'design is for lekiwi; open that robot first');
  eq(store.get('cameras.top'), undefined);
  store.importJSON({ schema: DESIGN_SCHEMA, robot: 'some-other-robot' });
  eq(store.get('robot'), 'some-other-robot', 'a non-merge import adopts the file\'s robot');
});

test('a merge load is the file exactly: the page keeps its ui, not its leftovers', () => {
  const { store } = mk();
  const clean = store.exportJSON();
  store.update((s) => ({ ...s, tweaks: {}, parts: { spar: { ops: [{ op: 'scale', factors: [2, 2, 2] }] } } }), { label: 'edit' });
  store.set('ui.theme', 'dark');
  ok(store.importJSON(clean, { merge: true }).ok);
  const strip = (t) => { const j = JSON.parse(t); delete j.saved; delete j.ui; return j; };
  deep(strip(store.exportJSON()), strip(clean), 'the round trip adds and keeps nothing');
  eq(store.get('ui.theme'), 'dark');
});

test('a malformed design or autosave is repaired on the way in, and says what it dropped', () => {
  const { store } = mk();
  const r = store.importJSON({
    schema: DESIGN_SCHEMA, robot: 'lekiwi-pincopen', joints: 'x', removed: ['a'],
    slots: { top_camera_mount: 7 }, cameras: 'nope', base: { x: 'left', y: 2, yaw: null },
  }, { merge: true });
  ok(r.ok);
  deep(store.get('joints'), {}); deep(store.get('removed'), {}); deep(store.get('cameras'), {});
  eq(store.get('slots.top_camera_mount'), undefined);
  deep(store.get('base'), { x: 0, y: 2, yaw: 0 });
  ok(r.warnings.length >= 4, r.warnings.join(' | '));
  const storage = memoryStorage();
  storage.setItem('rps/session@1', JSON.stringify({ when: Date.now(),
    design: { ...defaultDesign('lekiwi-pincopen'), joints: 'x', removed: ['a'], ui: { tipTarget: [1, 2, 3] } } }));
  const s2 = createStore(null, { storage });
  eq(s2.restoreSession(), true);
  deep(s2.get('joints'), {}); deep(s2.get('removed'), {});
});

test('reset clears history and notifies once', () => {
  const { store } = mk();
  store.set('ui.theme', 'dark'); store.commit('theme');
  const kinds = [];
  store.subscribe((s, i) => kinds.push(i.kind));
  store.reset(defaultDesign('lekiwi'));
  deep(kinds, ['reset']);
  eq(store.canUndo(), false);
});

await run('core/store — persistence and import');
