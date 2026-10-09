/* Home's recent-designs list: the timestamp field it writes, and the cross-tab notice that
 * keeps two tabs from showing (and resurrecting) different lists.
 *
 *   run:  node tools/tests/core/recent-store.test.mjs
 */

import {
  saveRecent, listRecent, removeRecent, clearRecent, setRecentStore, onRecentChange
} from '../../../src/core/recent-store.js';
import { test, run, ok, eq } from './_harness.mjs';

/** the IndexedDB stand-in `setRecentStore` takes */
function memStore() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
    del: async (k) => { m.delete(k); },
    _map: m
  };
}

/** a localStorage + `storage`-event stand-in, so the cross-tab path runs in Node */
function fakeWindow() {
  const listeners = new Set();
  const store = new Map();
  const events = [];
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
      /* a real `storage` event fires in the OTHER tabs, never in the writer */
      events.push(k);
      for (const fn of [...listeners]) fn({ key: k, newValue: String(v) });
    },
    removeItem: (k) => { store.delete(k); }
  };
  globalThis.window = {
    addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'storage') listeners.delete(fn); }
  };
  return { events, listeners };
}

/* D23 */
test('saveRecent stamps `savedAt`, and that is the field Home ages a row by', async () => {
  setRecentStore(memStore());
  const t0 = Date.now();
  const rec = await saveRecent({ id: 'auto/lekiwi-pincopen', robot: 'lekiwi-pincopen', label: 'LeKiwi' });
  ok(rec.savedAt >= t0, 'no savedAt on the record it wrote');
  const [row] = await listRecent();
  ok(row.savedAt >= t0, 'no savedAt on the row that comes back');
  eq(row.savedAt, rec.savedAt);
  const renamed = await saveRecent({ ...row, label: 'My mast design' });
  ok(renamed.savedAt >= row.savedAt, 'the rename kept the old timestamp');
});

/* D22 */
test('every write tells the other tabs, and re-reads the list first so nothing is resurrected', async () => {
  const win = fakeWindow();
  setRecentStore(memStore());
  let seen = 0;
  const off = onRecentChange(() => { seen++; });

  await saveRecent({ id: 'auto/a', robot: 'a', label: 'A' });
  await saveRecent({ id: 'auto/b', robot: 'b', label: 'B' });
  eq((await listRecent()).length, 2);
  eq(seen, 2, 'a save did not notify the other tabs');

  /* "tab B" deletes a row; "tab A" is told, and its own next write does not bring it back */
  await removeRecent('auto/a');
  eq(seen, 3, 'a delete did not notify the other tabs');
  await saveRecent({ id: 'auto/b', robot: 'b', label: 'B again' });
  const ids = (await listRecent()).map((r) => r.id);
  eq(ids.join(','), 'auto/b', 'the deleted row came back: ' + ids.join(','));

  await clearRecent();
  eq(seen, 5, 'a clear did not notify the other tabs');
  off();
  await saveRecent({ id: 'auto/c', robot: 'c' });
  eq(seen, 5, 'the unsubscribe did not take');
  delete globalThis.window;
  delete globalThis.localStorage;
});

test('with no window (Node, a worker) subscribing is a no-op that still unsubscribes', () => {
  const off = onRecentChange(() => { throw new Error('never'); });
  eq(typeof off, 'function');
  off();
});

await run('core/recent-store — the recents list, its timestamp and its cross-tab notice');
