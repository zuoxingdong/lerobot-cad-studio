/* The CORE suites' harness (features/ has its own): assertions that print one row per check
 * with the measured number, so a run reads as a report.  Each core test file also runs
 * standalone as `node tools/tests/core/<file>.test.mjs`. */

import assert from 'node:assert/strict';
import * as THREE from 'three';

/* the option poses the camera */

/**
 * The world matrix of a camera under a package's DEFAULT design.
 *
 * A package declares the camera DEVICE and the fitted SLOT OPTION the mount, so
 * `model.cameraMatrix(id)` is null for every camera a slot poses.  This is the fold
 * `features/cameras.js adoptSlotOption` does, by hand, so a core test needs no features/ import.
 *
 * @returns {THREE.Matrix4|null}
 */
export function defaultCameraMatrix(model, camId) {
  const own = model.cameraMatrix(camId);
  if (own) return own;                              // a package that still poses its own
  const slots = (model.manifest && model.manifest.slots) || {};
  for (const [sid, slot] of Object.entries(slots)) {
    if (!(slot.provides || []).includes('cameras.' + camId)) continue;
    const opt = (slot.options || []).find((o) => o.id === slot.default);
    const block = ((opt || {}).cameras || {})[camId];
    if (!block || !Array.isArray(block.local)) return null;
    const local = new THREE.Matrix4().fromArray(block.local);
    const carrier = block.carrier
      || ((opt.frame || 'robot') === 'robot' ? 'robot' : slot.anchor);
    /* a ROBOT-frame pose knows nothing about where the robot is STANDING; a carrier
       resolves through `frameMatrix`/`fk`, which carry the base themselves.  Exactly the
       split `features/cameras.js getPose()` makes. */
    if (!carrier || carrier === 'robot') {
      const B = model.baseMatrix ? model.baseMatrix() : null;
      return B ? B.clone().multiply(local) : local;
    }
    let base = null;
    try { base = model.frameMatrix(carrier); } catch (e) { base = null; }
    if (!base && model.hasLink && model.hasLink(carrier)) base = model.fk(carrier);
    return base ? new THREE.Matrix4().multiplyMatrices(base, local) : local;
  }
  return null;
}

/* DOM shim */

let _domInstalled = false;

/**
 * urdf-loader needs `DOMParser`, `Document`, `Element` and exactly ONE CSS selector:
 * `robot.querySelector('child[link="…"]')` (URDFLoader.js:324, to find the root link).
 * @xmldom/xmldom (≈100 kB) supplies everything but `querySelector`, so we add that one
 * selector form.  jsdom would work too and is ~40× heavier for one method.
 * In a browser all of this is native and none of it runs.
 */
export async function installDOM() {
  if (_domInstalled) return;
  const { DOMParser, Document, Element } = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || DOMParser;
  globalThis.Document = globalThis.Document || Document;
  globalThis.Element = globalThis.Element || Element;
  if (!Element.prototype.querySelector) {
    const RE = /^([a-zA-Z0-9_-]+)\[([a-zA-Z0-9_:-]+)="([^"]*)"\]$/;
    const qs = function (sel) {
      const m = RE.exec(String(sel).trim());
      if (!m) throw new Error('test DOM shim: unsupported selector "' + sel + '"');
      const [, tag, attr, val] = m;
      const list = this.getElementsByTagName(tag);
      for (let i = 0; i < list.length; i++) if (list[i].getAttribute(attr) === val) return list[i];
      return null;
    };
    Element.prototype.querySelector = qs;
    Document.prototype.querySelector = qs;
  }
  _domInstalled = true;
}

/* runner */

const rows = [];
const tests = [];
let failures = 0;

/** Register a check. `fn` may be async and may call `metric()`. */
export function test(name, fn) { tests.push({ name, fn }); }

/** Record a measured number for the report table. */
export function metric(label, value, limit, unit = '') {
  rows.push({ label, value, limit, unit, ok: limit === undefined || limit === null || value <= limit });
}

export function note(label, text) { rows.push({ label, text }); }

/* Assertions that never hand a mesh/geometry object to node:assert's inspector:
   `assert.equal(bufferGeometry, null, msg)` from node:assert/strict inspects the failing object
   without bound (tens of GB) — it took the whole desktop session down. Objects are compared by
   identity and printed as [object Type]. */
function show(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v);
  const t = v.constructor && v.constructor.name ? v.constructor.name : 'Object';
  return `[object ${t}${v.uuid ? ' ' + String(v.uuid).slice(0, 8) : ''}]`;
}
export function ok(v, msg) {
  if (!v) throw new assert.AssertionError({ message: msg || `expected truthy, got ${show(v)}`, actual: show(v), expected: true, operator: 'ok' });
}
export function eq(a, b, msg) {
  const isObj = (x) => x !== null && typeof x === 'object';
  if (isObj(a) || isObj(b)) {
    if (a === b) return;
    throw new assert.AssertionError({ message: msg || `${show(a)} !== ${show(b)}`, actual: show(a), expected: show(b), operator: 'eq' });
  }
  if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
    throw new assert.AssertionError({ message: msg ? `${msg}\n\n${show(a)} !== ${show(b)}` : `${show(a)} !== ${show(b)}`, actual: a, expected: b, operator: 'eq' });
  }
}
export const deep = assert.deepEqual;   // use only on plain data, never on geometry

/** |a − b| ≤ tol, with the difference recorded in the table. */
export function close(label, a, b, tol, unit = '') {
  const d = Math.abs(a - b);
  metric(label, d, tol, unit);
  assert.ok(d <= tol, `${label}: |${a} − ${b}| = ${d} > ${tol}`);
  return d;
}

/** Largest element-wise difference between two THREE.Matrix4, recorded and asserted. */
export function closeMatrix(label, A, B, tol) {
  let e = 0;
  for (let i = 0; i < 16; i++) e = Math.max(e, Math.abs(A.elements[i] - B.elements[i]));
  metric(label, e, tol, 'mm');
  assert.ok(e <= tol, `${label}: max |ΔM| = ${e.toExponential(3)} > ${tol}`);
  return e;
}

export function throws(label, fn, re) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  assert.ok(msg, `${label}: expected a throw, got none`);
  if (re) assert.ok(re.test(msg), `${label}: message ${JSON.stringify(msg)} does not match ${re}`);
  note(label, trim(msg));
  return msg;
}

export async function rejects(label, p, re) {
  let msg = null;
  try { await p; } catch (e) { msg = e.message; }
  assert.ok(msg, `${label}: expected a rejection, got none`);
  if (re) assert.ok(re.test(msg), `${label}: message ${JSON.stringify(msg)} does not match ${re}`);
  note(label, trim(msg));
  return msg;
}

const trim = (s) => (s.length > 88 ? s.slice(0, 85).replace(/\n.*/s, '') + '…' : s.split('\n')[0]);

/** Run everything, print the table, exit non-zero on failure. */
export async function run(title) {
  const t0 = Date.now();
  process.stdout.write(`\n${title}\n${'='.repeat(title.length)}\n`);
  for (const t of tests) {
    const mark = rows.length;
    try {
      await t.fn();
      process.stdout.write(`  ok    ${t.name}\n`);
    } catch (e) {
      failures += 1;
      process.stdout.write(`  FAIL  ${t.name}\n        ${e.message.split('\n').join('\n        ')}\n`);
      rows.splice(mark);
    }
  }
  if (rows.length) {
    const w = Math.max(...rows.map((r) => r.label.length), 10);
    process.stdout.write('\n  ' + 'measurement'.padEnd(w) + '  value            limit\n');
    process.stdout.write('  ' + '-'.repeat(w) + '  ---------------  ---------\n');
    for (const r of rows) {
      if (r.text !== undefined) {
        process.stdout.write('  ' + r.label.padEnd(w) + '  ' + r.text + '\n');
        continue;
      }
      const v = fmt(r.value) + (r.unit ? ' ' + r.unit : '');
      const lim = r.limit === undefined || r.limit === null ? '—' : fmt(r.limit) + (r.unit ? ' ' + r.unit : '');
      process.stdout.write('  ' + r.label.padEnd(w) + '  ' + v.padEnd(15) + '  ' + lim + (r.ok ? '' : '   ✗') + '\n');
    }
  }
  const ms = Date.now() - t0;
  process.stdout.write(`\n  ${tests.length - failures}/${tests.length} checks passed in ${ms} ms\n\n`);
  if (failures) process.exit(1);
}

function fmt(v) {
  if (typeof v !== 'number') return String(v);
  if (v === 0) return '0';
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
  return Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6 ? v.toExponential(3) : v.toFixed(4);
}
