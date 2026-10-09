/* Test doubles for the agent loop: an in-memory FileSystemDirectoryHandle with lastModified,
   a webkitGetAsEntry() tree, a Map-backed idb and a closed binary STL box. */

let clock = 1_700_000_000_000;
export const tick = (ms = 1000) => (clock += ms);

class FakeFileHandle {
  constructor(name, bytes) { this.kind = 'file'; this.name = name; this.set(bytes); }
  set(bytes) {
    this.bytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
    this.lastModified = tick(7);
  }
  async getFile() { return new File([this.bytes], this.name, { lastModified: this.lastModified }); }
  async createWritable() {
    const parts = [];
    return { write: async (b) => { parts.push(new Uint8Array(b)); }, close: async () => {
      const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      this.set(out);
    } };
  }
}

export class FakeDir {
  constructor(name, perm = 'granted') {
    this.kind = 'directory'; this.name = name; this.children = new Map();
    this.perm = perm; this.grant = 'granted'; this.asked = 0;
  }
  async *entries() { for (const [k, v] of [...this.children].sort()) yield [k, v]; }
  async getDirectoryHandle(n, o = {}) {
    let d = this.children.get(n);
    if (!d) { if (!o.create) throw Object.assign(new Error(n), { name: 'NotFoundError' }); d = new FakeDir(n); this.children.set(n, d); }
    return d;
  }
  async getFileHandle(n, o = {}) {
    let f = this.children.get(n);
    if (!f) { if (!o.create) throw Object.assign(new Error(n), { name: 'NotFoundError' }); f = new FakeFileHandle(n, new Uint8Array()); this.children.set(n, f); }
    return f;
  }
  async removeEntry(n) { if (!this.children.delete(n)) throw Object.assign(new Error(n), { name: 'NotFoundError' }); }
  async queryPermission() { return this.perm; }
  async requestPermission() { this.asked++; this.perm = this.grant; return this.perm; }

  /** put('a/b.stl', bytes): creates the dirs, bumps lastModified */
  put(path, bytes) {
    const seg = path.split('/');
    let d = this;
    for (const s of seg.slice(0, -1)) {
      if (!d.children.has(s)) d.children.set(s, new FakeDir(s));
      d = d.children.get(s);
    }
    const leaf = seg[seg.length - 1];
    const f = d.children.get(leaf);
    if (f) f.set(bytes); else d.children.set(leaf, new FakeFileHandle(leaf, bytes));
    return this;
  }
  rm(path) {
    const seg = path.split('/');
    let d = this;
    for (const s of seg.slice(0, -1)) d = d.children.get(s);
    d.children.delete(seg[seg.length - 1]);
    return this;
  }
  read(path) {
    let d = this;
    for (const s of path.split('/')) d = d && d.children.get(s);
    return d && d.bytes ? new TextDecoder().decode(d.bytes) : null;
  }
  paths(prefix = '') {
    const out = [];
    for (const [k, v] of this.children) {
      if (v.kind === 'directory') out.push(...v.paths(prefix + k + '/'));
      else out.push(prefix + k);
    }
    return out.sort();
  }
}

/** A webkitGetAsEntry() tree over a FakeDir; readEntries hands out `batch` at a time. */
export function asEntry(h, batch = 2, fullPath = '') {
  const path = fullPath + '/' + h.name;
  if (h.kind === 'file') {
    return { isFile: true, isDirectory: false, name: h.name, fullPath: path,
      file: (ok, bad) => h.getFile().then(ok, bad) };
  }
  return { isFile: false, isDirectory: true, name: h.name, fullPath: path,
    createReader() {
      const all = [...h.children.values()].map((c) => asEntry(c, batch, path));
      let i = 0;
      return { readEntries: (ok) => { const b = all.slice(i, i + batch); i += batch; setTimeout(() => ok(b), 0); } };
    } };
}

export function fakeIdb() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } };
}

/** window double: timers are recorded, never fired; tests drive tick()/scan(). */
export function fakeWindow(root, o = {}) {
  const listeners = new Map();
  const timers = [];
  const win = {
    pickerCalls: [], timers,
    document: {
      visibilityState: 'visible',
      addEventListener: (t, f) => listeners.set(t, f),
      removeEventListener: (t) => listeners.delete(t),
      fire: (t) => listeners.get(t) && listeners.get(t)(),
    },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  if (o.picker !== false) {
    win.showDirectoryPicker = async (opts) => {
      win.pickerCalls.push(opts);
      if (o.cancel) throw Object.assign(new Error('cancel'), { name: 'AbortError' });
      return root;
    };
  }
  return win;
}

/** A closed binary STL box (12 triangles) from min to max, mm. */
export function boxStl(min = [0, 0, 0], max = [10, 10, 10]) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + f.length * 50), dv = new DataView(buf);
  dv.setUint32(80, f.length, true);
  f.forEach((t, i) => {
    const o = 84 + i * 50 + 12;
    t.forEach((vi, k) => v[vi].forEach((c, j) => dv.setFloat32(o + k * 12 + j * 4, c, true)));
  });
  return new Uint8Array(buf);
}
