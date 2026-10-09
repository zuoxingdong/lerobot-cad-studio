/* The two composition resolvers agree: src/core/compose.js (the page) and tools/build/robots/resolve.py (the
 * generator's checks), on the packages on disk.  The whole resolved document, then every slot option each
 * combination of tools/tests/fixtures/packages-snapshot.json picks.  The Python side runs on python3, stdlib only.
 *
 *   node --test tools/tests/build/resolve-parity.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../_root.mjs';
import { raw, ids, PART_DOCS } from '../_assets.mjs';
import { resolveRobot } from '../../../src/core/compose.js';

const SNAP = JSON.parse(readFileSync(join(ROOT, 'tools', 'tests', 'fixtures', 'packages-snapshot.json'), 'utf8'));
const PARTS = Object.keys(PART_DOCS).sort().map((id) => ({ doc: PART_DOCS[id], owner: 'part:' + id, from: `assets/parts/${id}/` }));

const py = (id) => JSON.parse(execFileSync('python3', [join(ROOT, 'tools/build/robots/resolve.py'), '--json', id],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }));

/** compose.js with the raw part.json files (the generator has no fitted plates), its mesh map applied the way the
    generator writes paths: relative to the composition's folder */
function js(id, cache = new Map()) {
  if (cache.has(id)) return cache.get(id);
  const doc = raw(id);
  const { manifest: m, meshes } = resolveRobot(doc, { robot: (b) => ({ doc: js(b, cache), meshes: new Map() }), parts: () => PARTS });
  if (m !== doc) {
    const pre = (owner) => (owner.startsWith('part:') ? `../../parts/${owner.slice(5)}/` : `../${owner}/`);
    const file = (owner, mesh) => (owner.startsWith('part:')
      ? PART_DOCS[owner.slice(5)].meshes.find((x) => x.id === mesh).file : mesh);
    for (const c of m.components) {
      const { owner, mesh } = meshes.get(c.mesh);
      c.mesh = pre(owner) + file(owner, mesh);
      if (c.print_file) c.print_file = pre(owner) + c.print_file;
    }
    for (const k of ['urdf', 'mesh_dir']) if (m.kinematics[k]) m.kinematics[k] = `../${doc.base}/` + m.kinematics[k];
  }
  cache.set(id, m);
  return m;
}

/* `undefined` and a dropped key are the same in JSON; numbers to 1e-9 (the attachment's matrix product) */
function diff(a, b, path, out) {
  if (out.length > 30) return;
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-9) out.push(`${path}: ${a} != ${b}`); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: js ${JSON.stringify(a)?.slice(0, 100)} != py ${JSON.stringify(b)?.slice(0, 100)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== b.length)) { out.push(`${path}: shape`); return; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === undefined && b[k] === undefined) continue;
    diff(a[k], b[k], `${path}.${k}`, out);
  }
}

for (const id of ids) {
  test(`${id}: compose.js and resolve.py resolve the same package`, () => {
    const J = JSON.parse(JSON.stringify(js(id))), P = py(id), out = [];
    diff(J, P, id, out);
    assert.deepEqual(out, []);
  });
}

for (const id of Object.keys(SNAP)) {
  test(`${id}: every slot option of the ${SNAP[id].combos.length} snapshot combinations resolves the same`, () => {
    const J = JSON.parse(JSON.stringify(js(id))), P = py(id), out = [];
    const comp = (m) => Object.fromEntries(m.components.map((c) => [c.id, c]));
    const CJ = comp(J), CP = comp(P);
    let n = 0;
    for (const row of SNAP[id].combos) {
      for (const [sid, oid] of Object.entries(row.slots)) {
        const pick = (m) => m.slots[sid].options.find((o) => o.id === oid);
        const oj = pick(J), op = pick(P);
        assert.ok(oj && op, `${id} ${sid}=${oid}: js ${!!oj}, py ${!!op}`);
        diff(oj, op, `${id}.${sid}=${oid}`, out);
        for (const cid of oj.parts || []) diff(CJ[cid], CP[cid], `${id}.${sid}=${oid}.${cid}`, out);
        n += 1;
      }
    }
    assert.ok(n > 0);
    assert.deepEqual(out, []);
  });
}
