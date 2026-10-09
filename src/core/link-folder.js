/* The linked parts folder and the one-shot readers behind every fallback.
   Linked (File System Access): the handle is kept in IndexedDB, part folders are polled
   every 2 s while the tab is visible (FileSystemObserver where it exists), and a folder is
   offered once two scans in a row give the same signature.  One-shot: a directory handle,
   a dropped webkitGetAsEntry() entry, an <input webkitdirectory> FileList or a zip.
   Every path yields folders of the shape {id, files: Map<relpath, Blob>}. */

import { unzipSync } from 'fflate';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export const PICKER_ID = 'rps-parts';
export const HANDLE_KEY = 'rps-linked-folder';
export const POLL_MS = 2000;
export const PART_FILE = 'part.json';
const PART_FILES = new Set([PART_FILE, 'meta.json']);   // meta.json: an older export, or a misnamed part.json
const MAX_FILES = 256;
const MAX_DEPTH = 4;

const junk = (n) => n.startsWith('.') || n === '__MACOSX' || n === 'Thumbs.db' || n === 'desktop.ini';
const JUNK_DIRS = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv']);
const skipDir = (n) => junk(n) || n.startsWith('_');
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/)+/, '').replace(/^\//, '');
const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Every file under a directory handle as sorted [relpath, File] pairs.  Each directory lists
 * its files before its subdirectories, both by name, so the cap never hides a part.json
 * behind a script's cache.
 */
export async function walkHandle(dir, prefix = '', out = [], depth = 0) {
  if (depth > MAX_DEPTH) return out;
  const files = [], dirs = [];
  for await (const [name, h] of dir.entries()) {
    if (junk(name) || JUNK_DIRS.has(name)) continue;
    (h.kind === 'directory' ? dirs : files).push([name, h]);
  }
  for (const [name, h] of files.sort(byPath)) {
    if (out.length >= MAX_FILES) break;
    out.push([prefix + name, await h.getFile()]);
  }
  for (const [name, h] of dirs.sort(byPath)) {
    if (out.length >= MAX_FILES) break;
    await walkHandle(h, prefix + name + '/', out, depth + 1);
  }
  return depth === 0 ? out.sort(byPath) : out;
}

/** size + lastModified of every file: equal twice in a row means the writer is done. */
export function signature(entries) {
  return entries.map(([p, f]) => `${p}:${f.size}:${f.lastModified || 0}`).sort().join('|');
}

/**
 * Group loose [path, Blob] pairs into part folders.  A folder is the directory of a
 * part.json (the shallowest wins); with no part.json anywhere, each top directory is one
 * folder so the validator can say what is missing.  `_`-prefixed dirs are skipped.
 */
export function groupFiles(entries, rootName = 'part') {
  const clean = [];
  for (const [raw, blob] of entries) {
    const p = norm(raw);
    if (!p || p.endsWith('/')) continue;
    const seg = p.split('/');
    if (seg.some((s) => junk(s)) || seg.slice(0, -1).some((s) => s.startsWith('_'))) continue;
    clean.push([p, blob]);
  }
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  let roots = clean.filter(([p]) => /(^|\/)(part|meta)\.json$/i.test(p)).map(([p]) => dirOf(p));
  roots = [...new Set(roots)].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!roots.length) {
    const tops = new Set(clean.map(([p]) => (p.includes('/') ? p.split('/')[0] : '')));
    roots = tops.has('') || tops.size === 0 ? [''] : [...tops].sort();
  }
  const owner = (p) => roots.find((r) => r === '' || p.startsWith(r + '/'));
  const kept = [];
  for (const r of roots) if (!kept.some((k) => k === '' || r.startsWith(k + '/'))) kept.push(r);
  const out = new Map();
  for (const [p, blob] of clean) {
    const r = owner(p);
    if (r == null || !kept.includes(r)) continue;
    if (!out.has(r)) out.set(r, new Map());
    out.get(r).set(r ? p.slice(r.length + 1) : p, blob);
  }
  const base = String(rootName).replace(/\.zip$/i, '') || 'part';
  return kept.filter((r) => out.has(r)).map((r) => ({
    id: r ? r.split('/').pop() : base,
    files: new Map([...out.get(r)].sort(byPath)),
  }));
}

/* one-shot readers */

export async function readHandle(dir) {
  return groupFiles(await walkHandle(dir), dir.name);
}

export async function readZip(src, name = 'part.zip') {
  const u8 = src instanceof Uint8Array ? src
    : new Uint8Array(src instanceof ArrayBuffer ? src : await src.arrayBuffer());
  let files;
  try { files = unzipSync(u8, { filter: (f) => !f.name.endsWith('/') }); } catch (e) {
    throw new Error(`${name} is not a readable zip`);
  }
  return groupFiles(Object.entries(files).map(([p, b]) => [p, new Blob([b])]), name);
}

const isZip = (f) => /\.zip$/i.test(f.name || '');

/** <input webkitdirectory> (or plain multi-file) FileList. */
export async function readFileList(list) {
  const files = [...list];
  if (files.length === 1 && isZip(files[0])) return readZip(files[0], files[0].name);
  const pairs = files.map((f) => [f.webkitRelativePath || f.name, f]);
  const root = norm(pairs[0] ? pairs[0][0] : '').split('/')[0] || 'part';
  return groupFiles(pairs, root);
}

const entryFile = (e) => new Promise((res, rej) => e.file(res, rej));
const readBatch = (r) => new Promise((res, rej) => r.readEntries(res, rej));

async function walkEntry(entry, prefix, out, depth) {
  if (out.length >= MAX_FILES || junk(entry.name) || (entry.isDirectory && JUNK_DIRS.has(entry.name))) return;
  if (entry.isFile) { out.push([prefix + entry.name, await entryFile(entry)]); return; }
  if (!entry.isDirectory || depth > MAX_DEPTH) return;
  const reader = entry.createReader();
  for (;;) {
    const batch = await readBatch(reader);                // readEntries returns ≤ 100 at a time
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out, depth + 1);
  }
}

/** A dropped `webkitGetAsEntry()` entry: a folder, a zip or a lone file. */
export async function readDropEntry(entry) {
  if (entry.isFile && isZip(entry)) return readZip(await entryFile(entry), entry.name);
  const out = [];
  await walkEntry(entry, '', out, 0);
  return groupFiles(out.sort(byPath), entry.name);
}

/**
 * Everything in a drop.  Must be called inside the drop handler: the item list dies with
 * the event, so handles and entries are taken synchronously before anything awaits.
 * Returns {folders, handles}; a directory handle in `handles` can be linked.
 */
export async function readDataTransfer(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const pending = items.map((i) => ({
    handle: typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle() : null,
    entry: typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null,
    file: typeof i.getAsFile === 'function' ? i.getAsFile() : null,
  }));
  const folders = [], handles = [];
  for (const p of pending) {
    const h = p.handle ? await p.handle.catch(() => null) : null;
    if (h && h.kind === 'directory') { handles.push(h); folders.push(...await readHandle(h)); continue; }
    if (p.entry) { folders.push(...await readDropEntry(p.entry)); continue; }
    if (p.file) folders.push(...await readFileList([p.file]));
  }
  if (!items.length && dt.files && dt.files.length) folders.push(...await readFileList(dt.files));
  return { folders, handles };
}

/** Write `[relpath, bytes]` pairs under a directory handle, creating folders; in the order given. */
export async function writeTree(dir, entries) {
  for (const [rel, bytes] of entries) {
    const seg = rel.split('/');
    let d = dir;
    for (const s of seg.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
    const w = await (await d.getFileHandle(seg[seg.length - 1], { create: true })).createWritable();
    await w.write(bytes);
    await w.close();
  }
}

/* the linked folder */

/**
 * @param {object} [o]
 * @param {object} [o.window]  showDirectoryPicker, document, FileSystemObserver, setTimeout
 * @param {object} [o.idb]     {get, set, del}
 * @param {number} [o.pollMs]
 */
export function createLinkFolder(o = {}) {
  const win = o.window || globalThis;
  const idb = o.idb || { get: idbGet, set: idbSet, del: idbDel };
  const pollMs = o.pollMs || POLL_MS;
  const setT = (win.setTimeout || setTimeout).bind(win);
  const clearT = (win.clearTimeout || clearTimeout).bind(win);
  const doc = win.document || null;
  const changeCbs = new Set(), stateCbs = new Set();
  const seen = new Map(), pending = new Map();
  let handle = null, state = 'none', error = null, timer = null, observer = null, scanning = null;
  let gen = 0;                        // bumped by connect/unlink: a scan of an older handle is dropped

  const supported = () => typeof win.showDirectoryPicker === 'function';
  const visible = () => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
  const setState = (s, err = null) => {
    if (s === state && err === error) return;
    state = s; error = err;
    for (const cb of stateCbs) cb({ state, name: handle ? handle.name : null, error });
  };
  const emit = (ev) => { if (ev.added.length || ev.changed.length || ev.removed.length) for (const cb of changeCbs) cb(ev); };

  async function permission(h, ask) {
    const fn = ask ? h.requestPermission : h.queryPermission;
    if (typeof fn !== 'function') return 'granted';
    try { return await fn.call(h, { mode: 'readwrite' }); } catch (e) { return 'denied'; }
  }

  async function scanOnce() {
    const g = gen, h = handle;
    const found = [];
    for await (const [name, dir] of h.entries()) {
      if (dir.kind !== 'directory' || skipDir(name)) continue;
      found.push([name, await walkHandle(dir)]);
    }
    if (g !== gen) return;
    const added = [], changed = [], present = new Set();
    for (const [name, entries] of found) {
      if (!entries.some(([p]) => PART_FILES.has(p))) { pending.delete(name); continue; }
      present.add(name);
      const sig = signature(entries);
      if (seen.has(name) && seen.get(name).sig === sig) { pending.delete(name); continue; }
      if (pending.get(name) !== sig) { pending.set(name, sig); continue; }
      pending.delete(name);
      const folder = { id: name, files: new Map(entries), sig, source: 'linked' };
      (seen.has(name) ? changed : added).push(folder);
      seen.set(name, folder);
    }
    const removed = [...seen.keys()].filter((n) => !present.has(n));
    for (const n of removed) seen.delete(n);
    if (state === 'connected' && error) setState('connected');
    emit({ added, changed, removed });
  }

  /** One poll step; `await`s any scan already running instead of overlapping it. */
  async function scan() {
    if (!handle || state !== 'connected') return;
    if (scanning) return scanning;
    const g = gen;
    const run = scanOnce().catch((e) => {
      if (g !== gen) return;
      if (e && e.name === 'NotAllowedError') setState('reconnect');
      else setState('connected', `cannot read ${handle.name}: ${e && e.message ? e.message : e}`);
    }).finally(() => { if (scanning === run) scanning = null; });
    scanning = run;
    return run;
  }

  /** A timer tick: scans only while the tab is visible. */
  async function tick() { if (visible()) await scan(); }

  function loop() {
    clearT(timer);
    timer = setT(async () => { await tick(); if (state === 'connected') loop(); }, observer ? pollMs * 5 : pollMs);
  }
  const onVisible = () => { if (visible()) tick(); };

  async function start() {
    stop();
    if (typeof win.FileSystemObserver === 'function') {
      try {
        observer = new win.FileSystemObserver(() => {
          tick().then(() => setT(tick, pollMs));             // the second, confirming scan
        });
        await observer.observe(handle, { recursive: true });
      } catch (e) { observer = null; }
    }
    if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisible);
    loop();
    await tick();
  }

  function stop() {
    clearT(timer); timer = null;
    if (observer) { try { observer.disconnect(); } catch (e) { /* already gone */ } observer = null; }
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisible);
  }

  async function connect(h) {
    stop();
    gen++;
    scanning = null;
    const old = [...seen.keys()];
    seen.clear(); pending.clear();
    if (old.length) emit({ added: [], changed: [], removed: old });
    handle = h;
    setState('connected');
    await start();
  }

  return {
    supported,
    state: () => state,
    error: () => error,
    name: () => (handle ? handle.name : null),
    handle: () => handle,
    parts: () => new Map(seen),
    needsReconnect: () => state === 'reconnect',

    /** On boot: bring back the stored handle; permission needs a click after a reload. */
    async restore() {
      let h = null;
      try { h = await idb.get(HANDLE_KEY); } catch (e) { h = null; }
      if (!h) { setState(supported() ? 'none' : 'unsupported'); return state; }
      handle = h;
      if (await permission(h, false) === 'granted') await connect(h);
      else setState('reconnect');
      return state;
    },

    /** From a click only. */
    async reconnect() {
      if (!handle) return false;
      if (await permission(handle, true) !== 'granted') { setState('reconnect'); return false; }
      await connect(handle);
      return true;
    },

    /** From a click only.  Resolves to the handle, or null when the user cancels. */
    async pick() {
      if (!supported()) throw new Error('This browser cannot link a folder: use Choose folder or drop it here');
      let h;
      try { h = await win.showDirectoryPicker({ id: PICKER_ID, mode: 'readwrite' }); } catch (e) {
        if (e && e.name === 'AbortError') return null;
        throw e;
      }
      return this.link(h);
    },

    /** Link a directory handle, e.g. from a Chromium drop. */
    async link(h) {
      if (!h || h.kind !== 'directory') throw new Error('only a folder can be linked');
      if (await permission(h, false) !== 'granted' && await permission(h, true) !== 'granted') {
        throw new Error(`no permission to read ${h.name}`);
      }
      try { await idb.set(HANDLE_KEY, h); } catch (e) { /* works for this session only */ }
      await connect(h);
      return h;
    },

    async unlink() {
      stop();
      gen++;
      scanning = null;
      const old = [...seen.keys()];
      seen.clear(); pending.clear(); handle = null;
      try { await idb.del(HANDLE_KEY); } catch (e) { /* nothing stored */ }
      emit({ added: [], changed: [], removed: old });
      setState(supported() ? 'none' : 'unsupported');
    },

    scan, tick, stop,
    onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb); },
    onState(cb) { stateCbs.add(cb); return () => stateCbs.delete(cb); },
  };
}
