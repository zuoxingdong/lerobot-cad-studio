/* The showcase's asset bytes: fetched over http, or read from the classic-script wrappers
   (`<file>.js` sets window.__rpsLab[file] = base64) from file://, where fetch is blocked.
   Also the run track decoder (rps/run@1: deflate-raw, int16 delta blocks). */
import { versioned, versionOf } from '../core/asset-version.js';

const FILE = typeof location !== 'undefined' && location.protocol === 'file:';

function b64bytes(s) {
  const bin = atob(s), n = bin.length, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function script(src) {
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => { el.remove(); res(); };
    el.onerror = () => { el.remove(); rej(new Error('could not load ' + src)); };
    document.head.appendChild(el);
  });
}

async function fetchBytes(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  if (!r.body || !r.body.getReader) {
    const b = new Uint8Array(await r.arrayBuffer());
    onBytes(b.length);
    return b;
  }
  const reader = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** bytes of `dir/file`; onBytes(n) reports progress in raw file bytes; `v` is the file's hash (cache-busting) */
export async function loadBytes(dir, file, size, onBytes = () => {}, v = null) {
  const h = v || versionOf(dir + file);
  if (!FILE) return fetchBytes(versioned(dir + file, h), onBytes);
  const reg = (window.__rpsLab = window.__rpsLab || {});
  if (!reg[file]) await script(versioned(dir + file + '.js', h));
  const s = reg[file];
  if (typeof s !== 'string') throw new Error('no wrapper data for ' + file);
  delete reg[file];
  const b = b64bytes(s);
  onBytes(size || b.length);
  return b;
}

export async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/** one block of run.bin as Float32Array [n][frames][comps] (flattened) */
function block(raw, b) {
  const { n, frames: F, comps: C, offset } = b, out = new Float32Array(n * F * C);
  const size = { i16: 2, u8: 1 }[b.kind] || 4, bad = (why) => { throw new Error(`run.bin: block ${b.name} ${why}`); };
  if (offset + n * C * F * size > raw.length) bad(`ends at ${offset + n * C * F * size} B, past the ${raw.length} B run`);
  if (offset % size) bad(`offset ${offset} is not ${size}-aligned`);
  if (b.kind === 'i16' && !(b.lo?.length === n && b.span?.length === n && b.lo.every((r, i) => r.length === C && b.span[i].length === C))) {
    bad(`has lo/span for ${b.lo?.length} x ${b.lo?.[0]?.length}, not ${n} x ${C}`);
  }
  if (b.kind === 'i16') {
    const d = new Int16Array(raw.buffer, raw.byteOffset + offset, n * C * F);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < C; c++) {
        const lo = b.lo[i][c], sp = b.span[i][c], base = (i * C + c) * F;
        let acc = 0;
        for (let f = 0; f < F; f++) {
          acc = (acc + d[base + f]) << 16 >> 16;
          out[(i * F + f) * C + c] = lo + (acc + 32768) / 65535 * sp;
        }
      }
    }
  } else if (b.kind === 'u8') {
    const d = new Uint8Array(raw.buffer, raw.byteOffset + offset, n * C * F);
    for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) {
      for (let f = 0; f < F; f++) out[(i * F + f) * C + c] = d[(i * C + c) * F + f] / 255;
    }
  } else {
    const d = new Float32Array(raw.buffer, raw.byteOffset + offset, n * C * F);
    for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) {
      for (let f = 0; f < F; f++) out[(i * F + f) * C + c] = d[(i * C + c) * F + f];
    }
  }
  return { n, F, C, data: out };
}

/** the run track: {pose, shear, size, color, camera, rcams} blocks, each {n, F, C, data} */
export async function decodeRun(bytes, meta) {
  const raw = await inflateRaw(bytes);
  if (raw.length !== meta.bytes_raw) throw new Error('run.bin: ' + raw.length + ' bytes, expected ' + meta.bytes_raw);
  const out = {};
  for (const b of meta.blocks) out[b.name] = block(raw, b);
  return out;
}

export const fromFile = FILE;
