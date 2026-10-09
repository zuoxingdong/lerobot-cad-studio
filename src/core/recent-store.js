/* What the studio keeps outside a robot package: the IndexedDB cache of recent designs,
   imported zips and alternative blobs.  Needs idb-keyval (loaded lazily). */

/* recent designs */

const RECENT_KEY = 'rps/recent@1';
const RECENT_CAP = 24;
/* CROSS-TAB.  IndexedDB has no change event, so every write bumps one localStorage key and
   the other tabs re-read the list when they see the `storage` event.  Last writer wins, and
   a deleted row is never resurrected: every write re-reads the array before it writes. */
const RECENT_PING = 'rps/recent-ping@1';
function pingRecent() {
  try { localStorage.setItem(RECENT_PING, Date.now() + '.' + Math.random().toString(36).slice(2)); }
  catch (e) { /* no localStorage, so no other tab to tell */ }
}

/**
 * Call `fn` when ANOTHER tab changes the recents.
 * @param {()=>void} fn
 * @returns {()=>void} unsubscribe
 */
export function onRecentChange(fn) {
  if (typeof window === 'undefined' || !window.addEventListener) return () => {};
  const h = (e) => { if (!e || !e.key || e.key === RECENT_PING) fn(); };
  window.addEventListener('storage', h);
  return () => window.removeEventListener('storage', h);
}

let _idb = null;
async function idb() {
  if (_idb) return _idb;
  try {
    const m = await import('idb-keyval');
    if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
    _idb = { get: m.get, set: m.set, del: m.del };
  } catch (e) {
    /* file://, a worker without IDB, or Node: a memory store, so nothing throws */
    const mem = new Map();
    _idb = {
      get: async (k) => mem.get(k),
      set: async (k, v) => { mem.set(k, v); },
      del: async (k) => { mem.delete(k); },
      volatile: true
    };
  }
  return _idb;
}

/** Swap the IndexedDB store (tests pass a memory stub). */
export function setRecentStore(store) { _idb = store; }

/**
 * Remember a design.  `entry.id` identifies it (same id → overwrite, moved to the front).
 * @param {{id:string, robot:string, label?:string, design?:object, thumbnail?:string}} entry
 */
export async function saveRecent(entry) {
  if (!entry || !entry.id) throw new Error('package: saveRecent needs an { id }');
  const db = await idb();
  const list = (await db.get(RECENT_KEY)) || [];
  const rec = { ...entry, savedAt: Date.now() };
  const out = [rec, ...list.filter((x) => x.id !== rec.id)].slice(0, RECENT_CAP);
  await db.set(RECENT_KEY, out);
  pingRecent();
  return rec;
}

/** Recent designs, newest first. Never throws: an unavailable store reads as empty. */
export async function listRecent() {
  try {
    const db = await idb();
    return (await db.get(RECENT_KEY)) || [];
  } catch (e) { return []; }
}

/* ---- imported packages
 * A recent design names a robot id.  For a SHIPPED robot the bytes are in the bundle; for
 * an import they were only ever in memory, so the recent entry pointed at nothing (or,
 * worse, at a shipped package with the same id).  The zip is kept here, capped, so
 * `main.js` can rebuild the model on a reload.
 */
const IMPORTED_KEY = 'rps/imported@1';
const IMPORTED_CAP = 4;

/** Remember the zip an import came from, under its (unique) robot id. */
export async function saveImportedPackage(id, bytes) {
  if (!id || !bytes) return false;
  try {
    const db = await idb();
    const list = (await db.get(IMPORTED_KEY)) || [];
    const rec = { id, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), savedAt: Date.now() };
    await db.set(IMPORTED_KEY, [rec, ...list.filter((x) => x.id !== id)].slice(0, IMPORTED_CAP));
    return true;
  } catch (e) { return false; }
}

/** The zip an import came from, or null. */
export async function loadImportedPackage(id) {
  try {
    const db = await idb();
    const rec = ((await db.get(IMPORTED_KEY)) || []).find((x) => x.id === id);
    return rec ? rec.bytes : null;
  } catch (e) { return null; }
}
/* ---- alternatives
 * An imported alternative's bytes are not in the bundle, so they are kept here — the STLs under
 * their sha1 (two alternatives that reuse the same plate cost one copy), and one small record
 * per alternative naming which sha1s it is made of.  That is what lets a reload still draw the
 * alternative the design says is fitted.
 */
const ALT_KEY = 'rps/alt@1';
const ALT_BLOB = 'rps/altblob@1/';
const ALT_CAP = 32;

/** Keep one STL under its sha1.  Returns false when IndexedDB is unavailable. */
export async function saveAltBlob(sha1, bytes) {
  if (!sha1 || !bytes) return false;
  try {
    const db = await idb();
    await db.set(ALT_BLOB + sha1, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return true;
  } catch (e) { return false; }
}

/** The STL kept under `sha1`, or null. */
export async function loadAltBlob(sha1) {
  if (!sha1) return null;
  try {
    const db = await idb();
    const v = await db.get(ALT_BLOB + sha1);
    return v ? (v instanceof Uint8Array ? v : new Uint8Array(v)) : null;
  } catch (e) { return null; }
}

/**
 * Remember one alternative (its meta and the sha1 of every file), so the swap popover and the
 * viewport can rebuild it after a reload.  Never stores geometry — `saveAltBlob` does.
 * @param {string} robot
 * @param {{id:string, slot:string}} rec
 */
export async function saveAltRecord(robot, rec) {
  if (!robot || !rec || !rec.id || !rec.slot) return false;
  try {
    const db = await idb();
    const list = (await db.get(ALT_KEY)) || [];
    const key = (x) => `${x.robot}/${x.slot}/${x.id}`;
    const one = { ...rec, robot, savedAt: Date.now() };
    await db.set(ALT_KEY, [one, ...list.filter((x) => key(x) !== key(one))].slice(0, ALT_CAP));
    return true;
  } catch (e) { return false; }
}

/** Every remembered alternative for one robot, newest first. Never throws. */
export async function listAltRecords(robot) {
  try {
    const db = await idb();
    return ((await db.get(ALT_KEY)) || []).filter((x) => !robot || x.robot === robot);
  } catch (e) { return []; }
}

export async function removeRecent(id) {
  const db = await idb();
  const list = (await db.get(RECENT_KEY)) || [];
  await db.set(RECENT_KEY, list.filter((x) => x.id !== id));
  pingRecent();
}

export async function clearRecent() {
  const db = await idb();
  await db.del(RECENT_KEY);
  pingRecent();
}
