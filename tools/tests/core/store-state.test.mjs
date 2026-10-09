/* core/store.js state: immutability, subscription, undo/redo and drag coalescing. */
import { defaultDesign, setIn, getIn, mergeDeep, deleteIn, DESIGN_SCHEMA, HISTORY_CAP, COALESCE_MS } from '../../../src/core/store.js';
import { test, run, ok, eq, deep } from './_harness.mjs';
import { mk } from './_store.mjs';

test('defaultDesign is a complete rps/design@1', () => {
  const d = defaultDesign('lekiwi');
  eq(d.schema, DESIGN_SCHEMA);
  eq(d.robot, 'lekiwi');
  for (const k of ['joints', 'slots', 'params', 'components', 'removed', 'cameras', 'ui']) ok(k in d, k);
});

test('setIn / mergeDeep / deleteIn copy only the path they touch; arrays stay arrays', () => {
  const a = { x: { y: { z: 1 } }, other: { keep: true }, list: [1, 2] };
  const b = setIn(a, 'x.y.z', 2);
  eq(b.x.y.z, 2); eq(a.x.y.z, 1);
  ok(b.other === a.other, 'untouched branches keep their identity');
  const c = mergeDeep(a, { x: { y: { w: 9 } }, list: [3] });
  eq(c.x.y.z, 1); eq(c.x.y.w, 9);
  deep(c.list, [3], 'arrays replace');
  eq(deleteIn(a, 'x.y.z').x.y.z, undefined); eq(a.x.y.z, 1);
  eq(getIn(a, 'x.nope.z', 'fallback'), 'fallback');
  const r = deleteIn({ l: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, 'l.1');
  ok(Array.isArray(r.l)); deep(r.l.map((p) => p.id), ['a', 'c']);
  const same = { l: [{ id: 'a' }] };
  ok(deleteIn(same, 'l.5') === same && deleteIn(same, 'l.x') === same, 'a bad index changes nothing');
});

test('the store never mutates a state it handed out; the same value is a no-op', () => {
  const { store } = mk();
  const s0 = store.getState();
  store.set('ui.theme', 'dark');
  const s1 = store.getState();
  eq(s0.ui.theme, 'auto'); eq(s1.ui.theme, 'dark');
  ok(s0.components === s1.components, 'untouched slices are shared');
  store.set('ui.theme', 'dark');
  ok(store.getState() === s1);
});

test('subscribe / subscribePath; a throwing subscriber does not stop the rest; kinds are the contract', () => {
  const { store } = mk();
  const seen = [];
  const off = store.subscribe((s, info) => seen.push(info));
  const joints = [];
  const offPath = store.subscribePath('joints', (now) => joints.push(Object.keys(now).length));
  store.set('ui.grid', false);
  store.set('joints.arm_shoulder_pan', 30);
  store.set('ui.grid', false);
  eq(seen.length, 2); eq(joints.length, 1);
  store.commit('a change');
  eq(seen.at(-1).kind + ':' + seen.at(-1).label, 'commit:a change');
  store.patch({ cameras: { top: { hfov_deg: 55 } } });
  store.update((st) => ({ ...st }));
  store.remove('cameras.top');
  store.undo(); store.redo();
  store.restoreSession();
  store.importJSON({ schema: DESIGN_SCHEMA, robot: 'lekiwi-pincopen' });
  const KINDS = ['set', 'patch', 'update', 'delete', 'commit', 'undo', 'redo', 'reset', 'import', 'init'];
  for (const i of seen) ok(KINDS.includes(i.kind), `kind "${i.kind}"`);
  off(); offPath();
  const n = seen.length;
  store.set('ui.grid', true);
  eq(seen.length, n, 'unsubscribe stops it');
  let reached = false;
  store.subscribe(() => { throw new Error('boom'); });
  store.subscribe(() => { reached = true; });
  const err = console.error; console.error = () => {};
  store.set('ui.grid', false);
  console.error = err;
  ok(reached);
});

test('undo / redo: one commit is one step; a new commit clears redo', () => {
  const { store } = mk();
  store.set('slots.top_camera_mount', 'none'); store.commit('slot');
  store.set('joints.arm_shoulder_pan', 12); store.commit('joint');
  eq(store.history().past.join(','), 'slot,joint');
  ok(store.undo());
  eq(store.get('joints.arm_shoulder_pan'), undefined);
  eq(store.get('slots.top_camera_mount'), 'none');
  ok(store.undo()); eq(store.undo(), false);
  ok(store.redo()); ok(store.redo()); eq(store.redo(), false);
  eq(store.get('joints.arm_shoulder_pan'), 12);
  store.undo();
  store.set('params.x.y', 1); store.commit('param');
  eq(store.history().future.length, 0);
  eq(store.commit('nothing'), false, 'a commit with no change does nothing');
});

test('undo is about the design: ui.* is carried across a history move', () => {
  const { store } = mk();
  store.set('ui.theme', 'dark');
  store.set('ui.selected', 'pi_case_cradle');
  store.set('joints.arm_shoulder_pan', 20, { label: 'joint' });
  store.set('ui.theme', 'light');
  ok(store.undo());
  eq(store.get('joints.arm_shoulder_pan'), undefined);
  eq(store.get('ui.theme'), 'light');
  eq(store.get('ui.selected'), 'pi_case_cradle');
  ok(store.redo());
  eq(store.get('ui.theme'), 'light');
});

test('the history is capped, oldest dropped', () => {
  const { store } = mk();
  for (let i = 0; i < HISTORY_CAP + 20; i++) { store.set('joints.j', i); store.commit('jog ' + i); }
  eq(store.history().past.length, HISTORY_CAP);
  eq(store.history().past[0], 'jog 20');
});

test('coalescing: a drag is one step; another label flushes it; undo/export flush', () => {
  const { store, timers } = mk();
  for (let i = 1; i <= 40; i++) { store.set('joints.arm_shoulder_lift', i); store.commit('lift', { coalesce: true }); timers.tick(8); }
  eq(store.history().past.length, 0);
  timers.tick(COALESCE_MS);
  eq(store.history().past.length, 1);
  store.undo();
  eq(store.get('joints.arm_shoulder_lift'), undefined, 'one undo rewinds the drag');

  store.set('joints.a', 1); store.commit('joint a', { coalesce: true });
  store.set('joints.b', 2); store.commit('joint b', { coalesce: true });
  eq(store.history().past.join(','), 'joint a');
  timers.tick(COALESCE_MS);
  eq(store.history().past.join(','), 'joint a,joint b');

  store.set('joints.c', 3); store.commit('joint c', { coalesce: true });
  ok(store.canUndo());
  store.undo();
  eq(store.get('joints.c'), undefined);
  store.set('slots.s', 'none', { label: 'slot', coalesce: true });
  store.exportJSON();
  eq(store.history().pending, null, 'exportJSON flushes');
  const n = store.history().past.length;
  timers.tick(1000);
  eq(store.history().past.length, n, 'the cancelled timer does not fire');
});

test('set / patch / update / remove with {label} commit in one call', () => {
  const { store } = mk();
  store.set('slots.top_camera_mount', 'none', { label: 'slot' });
  store.patch({ cameras: { top: { hfov_deg: 55 } } }, { label: 'hfov' });
  store.update((s) => ({ ...s, removed: { x: true } }), { label: 'delete x' });
  store.remove('cameras.top', { label: 'remove override' });
  eq(store.history().past.join(','), 'slot,hfov,delete x,remove override');
  eq(store.get('cameras.top'), undefined);
  store.undo(); store.undo();
  deep(store.get('removed'), {}, 'a delete is undone whole');
});

await run('core/store — state and history');
