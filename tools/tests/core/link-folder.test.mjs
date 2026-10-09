/* core/link-folder.js against in-memory handles: the 2-scan write rule, skip rules,
   visibility, reconnect, the observer, and every one-shot reader. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
  createLinkFolder, readHandle, readZip, readFileList, readDropEntry, readDataTransfer, groupFiles,
  HANDLE_KEY, PICKER_ID,
} from '../../../src/core/link-folder.js';
import { FakeDir, asEntry, fakeIdb, fakeWindow, boxStl } from '../fixtures/agent/fake-fs.mjs';

const PART = (id) => JSON.stringify({ schema: 'rps/part@1', id, slot: 'top_camera_mount' });

function setup(o = {}) {
  const root = new FakeDir('designs', o.perm);
  const win = fakeWindow(root, o);
  const idb = fakeIdb();
  const lf = createLinkFolder({ window: win, idb });
  const events = [];
  lf.onChange((e) => events.push({ added: e.added.map((f) => f.id), changed: e.changed.map((f) => f.id), removed: e.removed }));
  return { root, win, idb, lf, events };
}

test('pick links read-write, stores the handle and scans at once', async () => {
  const { root, win, idb, lf } = setup();
  root.put('short/part.json', PART('short'));
  assert.equal(await lf.pick(), root);
  assert.deepEqual(win.pickerCalls, [{ id: PICKER_ID, mode: 'readwrite' }]);
  assert.equal(idb.m.get(HANDLE_KEY), root);
  assert.equal(lf.state(), 'connected');
  assert.equal(lf.name(), 'designs');
  assert.ok(win.timers.some((t) => t.ms === 2000), 'a 2 s poll is scheduled');
});

test('a folder is offered after two equal scans, once', async () => {
  const { root, lf, events } = setup();
  await lf.pick();
  root.put('short/part.json', PART('short')).put('short/mesh/a.stl', boxStl());
  await lf.scan();
  assert.equal(events.length, 0, 'first sighting only records the signature');
  await lf.scan();
  assert.deepEqual(events, [{ added: ['short'], changed: [], removed: [] }]);
  const f = lf.parts().get('short');
  assert.deepEqual([...f.files.keys()], ['mesh/a.stl', 'part.json']);
  assert.ok(f.files.get('part.json') instanceof Blob);
  await lf.scan();
  assert.equal(events.length, 1, 'no repeat while nothing changes');
});

test('a folder still being written waits; a rewrite is a change', async () => {
  const { root, lf, events } = setup();
  await lf.pick();
  root.put('p/part.json', PART('p')).put('p/mesh/a.stl', boxStl());
  await lf.scan();
  root.put('p/mesh/a.stl', boxStl([0, 0, 0], [20, 20, 20]));      // still growing
  await lf.scan();
  assert.equal(events.length, 0);
  await lf.scan();
  assert.deepEqual(events.map((e) => e.added), [['p']]);
  root.put('p/part.json', PART('p'));
  await lf.scan(); await lf.scan();
  assert.deepEqual(events[1], { added: [], changed: ['p'], removed: [] });
  root.rm('p');
  await lf.scan();
  assert.deepEqual(events[2], { added: [], changed: [], removed: ['p'] });
});

test('skips _dirs, dot dirs, loose files and folders without part.json', async () => {
  const { root, lf, events } = setup();
  await lf.pick();
  root.put('_context/top/part.json', PART('ctx')).put('.git/part.json', PART('git'))
    .put('loose.stl', boxStl()).put('wip/mesh/a.stl', boxStl()).put('ok/part.json', PART('ok'))
    .put('ok/.DS_Store', 'x');
  await lf.scan(); await lf.scan();
  assert.deepEqual(events, [{ added: ['ok'], changed: [], removed: [] }]);
  assert.deepEqual([...lf.parts().get('ok').files.keys()], ['part.json']);
  root.put('wip/part.json', PART('wip'));
  await lf.scan(); await lf.scan();
  assert.deepEqual(events[1].added, ['wip']);
});

test('a meta.json-only folder is offered (the intake refuses or upgrades it); caches never hide part.json', async () => {
  const { root, lf, events } = setup();
  await lf.pick();
  root.put('old/meta.json', PART('old'));
  for (let i = 0; i < 300; i++) root.put(`big/__pycache__/m${String(i).padStart(3, '0')}.pyc`, 'x');
  for (let i = 0; i < 300; i++) root.put(`big/aaa/m${String(i).padStart(3, '0')}.bin`, 'x');
  root.put('big/part.json', PART('big'));
  await lf.scan(); await lf.scan();
  assert.deepEqual(events.map((e) => e.added.sort()), [['big', 'old']]);
  const keys = [...lf.parts().get('big').files.keys()];
  assert.ok(keys.includes('part.json'), 'part.json survived the cap');
  assert.ok(!keys.some((k) => k.startsWith('__pycache__/')), 'the cache is skipped');
  assert.equal(keys.length, 256);
});

test('a clean scan clears a read error; a scan of the old handle cannot land after a relink', async () => {
  const { root, lf, events } = setup();
  await lf.pick();
  const entries = root.entries;
  root.entries = async function* broken() { throw new Error('disk gone'); };
  await lf.scan();
  assert.match(lf.error(), /disk gone/);
  root.entries = entries;
  await lf.scan();
  assert.equal(lf.error(), null);

  root.put('old/part.json', PART('old'));
  await lf.scan();
  let release;
  root.entries = async function* slow() { await new Promise((r) => { release = r; }); yield* entries.call(root); };
  const stale = lf.scan();
  const other = new FakeDir('other');
  other.put('fresh/part.json', PART('fresh'));
  await lf.link(other);
  release();
  await stale;
  await lf.scan(); await lf.scan();
  assert.ok(!events.some((e) => e.added.includes('old')), JSON.stringify(events));
  assert.deepEqual([...lf.parts().keys()], ['fresh']);
});

test('polls only while the tab is visible', async () => {
  const { root, win, lf, events } = setup();
  await lf.pick();
  root.put('p/part.json', PART('p'));
  win.document.visibilityState = 'hidden';
  await lf.tick(); await lf.tick(); await lf.tick();
  assert.equal(events.length, 0);
  win.document.visibilityState = 'visible';
  await lf.tick(); await lf.tick();
  assert.deepEqual(events.map((e) => e.added), [['p']]);
});

test('after a reload the handle needs a click to reconnect', async () => {
  const { root, idb, lf } = setup({ perm: 'prompt' });
  idb.m.set(HANDLE_KEY, root);
  const states = [];
  lf.onState((s) => states.push(s.state));
  assert.equal(await lf.restore(), 'reconnect');
  assert.equal(lf.needsReconnect(), true);
  assert.equal(lf.name(), 'designs');
  root.grant = 'denied';
  assert.equal(await lf.reconnect(), false);
  assert.equal(lf.needsReconnect(), true);
  root.grant = 'granted';
  assert.equal(await lf.reconnect(), true);
  assert.equal(lf.state(), 'connected');
  assert.deepEqual(states, ['reconnect', 'connected']);
});

test('restore with a granted handle reconnects silently; nothing stored is "none"', async () => {
  const a = setup();
  a.idb.m.set(HANDLE_KEY, a.root);
  assert.equal(await a.lf.restore(), 'connected');
  const b = setup();
  assert.equal(await b.lf.restore(), 'none');
  const c = setup({ picker: false });
  assert.equal(await c.lf.restore(), 'unsupported');
  await assert.rejects(() => c.lf.pick(), /cannot link a folder/);
  const d = setup({ cancel: true });
  assert.equal(await d.lf.pick(), null);
  assert.equal(d.lf.state(), 'none');
});

test('unlink forgets the handle and removes every offered part', async () => {
  const { root, idb, lf, events } = setup();
  root.put('p/part.json', PART('p'));
  await lf.pick(); await lf.scan();
  await lf.unlink();
  assert.equal(idb.m.has(HANDLE_KEY), false);
  assert.deepEqual(events.at(-1).removed, ['p']);
  assert.equal(lf.state(), 'none');
});

test('FileSystemObserver drives a scan plus a confirming one', async () => {
  const { root, win, lf, events } = setup();
  const obs = [];
  win.FileSystemObserver = class { constructor(cb) { this.cb = cb; obs.push(this); }
    async observe(h, o) { this.h = h; this.o = o; } disconnect() { this.gone = true; } };
  await lf.pick();
  assert.equal(obs.length, 1);
  assert.deepEqual(obs[0].o, { recursive: true });
  assert.ok(win.timers.some((t) => t.ms === 10000), 'the safety poll slows to 10 s');
  root.put('p/part.json', PART('p'));
  obs[0].cb([{ type: 'appeared' }]);
  await new Promise((r) => setTimeout(r, 10));
  const confirm = win.timers.at(-1);
  assert.equal(confirm.ms, 2000);
  await confirm.f();
  assert.deepEqual(events.map((e) => e.added), [['p']]);
});

test('one-shot: a parent handle, a part handle, a zip, a FileList, a drop entry', async () => {
  const root = new FakeDir('drop');
  root.put('a/part.json', PART('a')).put('a/mesh/x.stl', boxStl()).put('b/part.json', PART('b'))
    .put('_context/top/part.json', PART('ctx')).put('notes.txt', 'hi');
  const viaHandle = await readHandle(root);
  assert.deepEqual(viaHandle.map((f) => f.id), ['a', 'b']);
  assert.deepEqual([...viaHandle[0].files.keys()], ['mesh/x.stl', 'part.json']);

  const single = await readHandle(root.children.get('a'));
  assert.deepEqual(single.map((f) => f.id), ['a']);

  const zip = zipSync({ 'short/part.json': strToU8(PART('short')), 'short/print/x.stl': boxStl(),
    '__MACOSX/short/._part.json': strToU8('junk'), '_context/x/part.json': strToU8('{}') });
  const viaZip = await readZip(zip, 'short.zip');
  assert.deepEqual(viaZip.map((f) => [f.id, [...f.files.keys()]]), [['short', ['part.json', 'print/x.stl']]]);
  const flat = await readZip(zipSync({ 'part.json': strToU8(PART('flat')) }), 'flat.zip');
  assert.deepEqual(flat.map((f) => f.id), ['flat']);
  await assert.rejects(() => readZip(strToU8('not a zip'), 'bad.zip'), /bad.zip is not a readable zip/);

  const list = [['picked/a/part.json', PART('a')], ['picked/a/mesh/x.stl', 'x'], ['picked/_context/p/part.json', '{}']]
    .map(([p, t]) => Object.defineProperty(new File([t], p.split('/').pop()), 'webkitRelativePath', { value: p }));
  const viaList = await readFileList(list);
  assert.deepEqual(viaList.map((f) => [f.id, [...f.files.keys()]]), [['a', ['mesh/x.stl', 'part.json']]]);
  const zipList = await readFileList([new File([zip], 'short.zip')]);
  assert.deepEqual(zipList.map((f) => f.id), ['short']);

  const viaEntry = await readDropEntry(asEntry(root, 2));
  assert.deepEqual(viaEntry.map((f) => f.id), ['a', 'b']);
  const zipEntry = { isFile: true, isDirectory: false, name: 'short.zip', file: (ok) => ok(new File([zip], 'short.zip')) };
  assert.deepEqual((await readDropEntry(zipEntry)).map((f) => f.id), ['short']);
});

test('readDataTransfer prefers a directory handle, else the entry', async () => {
  const root = new FakeDir('drop');
  root.put('a/part.json', PART('a'));
  const chromium = { items: [{ kind: 'file', getAsFileSystemHandle: async () => root, webkitGetAsEntry: () => asEntry(root) }] };
  const r1 = await readDataTransfer(chromium);
  assert.deepEqual(r1.folders.map((f) => f.id), ['a']);
  assert.deepEqual(r1.handles, [root]);
  const firefox = { items: [{ kind: 'file', webkitGetAsEntry: () => asEntry(root) }] };
  const r2 = await readDataTransfer(firefox);
  assert.deepEqual([r2.folders.map((f) => f.id), r2.handles.length], [['a'], 0]);
});

test('groupFiles: no part.json groups by top dir; the shallowest part.json wins', () => {
  const b = new Blob(['x']);
  assert.deepEqual(groupFiles([['m/a.stl', b], ['n/b.stl', b]], 'r').map((f) => f.id), ['m', 'n']);
  assert.deepEqual(groupFiles([['a.stl', b]], 'r.zip').map((f) => f.id), ['r']);
  const nested = groupFiles([['p/part.json', b], ['p/mesh/part.json', b], ['p/mesh/a.stl', b]], 'r');
  assert.deepEqual(nested.map((f) => [f.id, [...f.files.keys()]]), [['p', ['mesh/a.stl', 'mesh/part.json', 'part.json']]]);
  assert.deepEqual(groupFiles([['.\\p\\part.json', b]], 'r').map((f) => [f.id, [...f.files.keys()]]), [['p', ['part.json']]]);
});
