/* features/sim-mjcf.js honours design.parts the way Design shows it: a hinge detent turns the
 * `moves` geoms and the camera it carries, a mirrored copy is a geom of its own, and a page
 * that already applied both builds the same model.  A hull file does not depend on the
 * triangle order (the page's BVH reorders the index). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import * as THREE from 'three';
import { buildMjcf, hullCloud } from '../../../src/features/sim-mjcf.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { hingeTransforms } from '../../../src/features/hinge.js';

const s = await studio();
const scene = await sceneDoc('lab');
const build = (design) => buildMjcf({ model: s.model, slots: s.slots, design, scene });
const withParts = (parts) => ({ ...s.design, parts: { ...(s.design.parts || {}), ...parts } });
const MAST = 'corner_mast_printed';
const SPAR = 'corner_mast_printed_spar_lower';
const COPY = 'imported/spar-mirror-1';

function cloud(b) {
  const n = new DataView(b.buffer, b.byteOffset).getInt32(0, true);
  const f = new Float32Array(b.buffer.slice(b.byteOffset + 16, b.byteOffset + 16 + 12 * n));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < f.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], f[i + k]); hi[k] = Math.max(hi[k], f[i + k]); }
  return { n, lo, hi };
}
const same = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
const axisOf = (rows, c) => [rows[0][c], rows[1][c], rows[2][c]];
const angle = (a, b) => Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;

const base = build(s.design);
const at45 = build(withParts({ [MAST]: { params: { tilt_deg: 45 } } }));
const at55 = build(withParts({ [MAST]: { params: { tilt_deg: 55 } } }));

test('the design detent builds the default model', () => {
  assert.equal(at45.emit([]), base.emit([]));
  for (const [f, b] of base.meshes) assert.ok(same(b, at45.meshes.get(f)), f);
});

test('tilt 55 turns the head geoms and the top camera, nothing else', () => {
  const moved = [...base.meshes.keys()].filter((f) => !same(base.meshes.get(f), at55.meshes.get(f)));
  console.log(`  moved: ${moved.join(', ')}`);
  assert.ok(moved.includes(`${MAST}_head.msh`));
  assert.ok(moved.every((f) => f.startsWith(MAST + '_')), moved.join(', '));
  assert.ok(!moved.includes(`${SPAR}.msh`));
  const a = base.sidecar.cameras.top.local_mm, b = at55.sidecar.cameras.top.local_mm;
  const turn = angle(axisOf(a, 2), axisOf(b, 2));
  const shift = Math.hypot(a[0][3] - b[0][3], a[1][3] - b[1][3], a[2][3] - b[2][3]);
  console.log(`  top camera: axis turned ${turn.toFixed(4)} deg, moved ${shift.toFixed(2)} mm`);
  assert.ok(Math.abs(turn - 10) < 1e-3, `turn ${turn}`);
  assert.ok(shift > 1);
  assert.deepEqual(at55.sidecar.cameras.front, base.sidecar.cameras.front);
});

test('a page that already turned the hinge builds the same model', () => {
  const design = withParts({ [MAST]: { params: { tilt_deg: 55 } } });
  const H = hingeTransforms(s.model, design, () => true);
  const keep = new Map([...H.keys()].map((id) => [id, s.model.component(id).local.clone()]));
  for (const [id, M] of H) s.model.component(id).local.multiply(M);
  try {
    const again = build(design);
    assert.equal(again.emit([]), at55.emit([]));
    for (const [f, b] of at55.meshes) assert.ok(same(b, again.meshes.get(f)), f);
  } finally {
    for (const [id, L] of keep) s.model.component(id).local.copy(L);
  }
});

test('a mirrored copy is its own geom with the mirrored mesh, and leaves the model as it was', () => {
  const n0 = s.model.components.length;
  const b = build(withParts({ [COPY]: { copy_of: SPAR, ops: [{ op: 'mirror', plane: { point: [0, 0, 0], normal: [1, 0, 0] } }] } }));
  assert.equal(s.model.components.length, n0);
  assert.equal(s.model.component(COPY), null);
  const f = 'imported_spar-mirror-1.msh';
  assert.ok(b.meshes.has(f), [...b.meshes.keys()].filter((k) => k.startsWith('imp')).join(','));
  assert.match(b.emit([]), /<geom class="collision" name="col_imported_spar-mirror-1"/);
  const src = cloud(b.meshes.get(`${SPAR}.msh`)), cp = cloud(b.meshes.get(f));
  console.log(`  spar x ${src.lo[0].toFixed(2)}..${src.hi[0].toFixed(2)} -> copy x ${cp.lo[0].toFixed(2)}..${cp.hi[0].toFixed(2)}`);
  assert.equal(cp.n, src.n);
  assert.ok(Math.abs(cp.lo[0] + src.hi[0]) < 1e-3 && Math.abs(cp.hi[0] + src.lo[0]) < 1e-3);
  for (const k of [1, 2]) assert.ok(Math.abs(cp.lo[k] - src.lo[k]) < 1e-3 && Math.abs(cp.hi[k] - src.hi[k]) < 1e-3);
  assert.ok(b.sidecar.masses[COPY] && Math.abs(b.sidecar.masses[COPY].g - b.sidecar.masses[SPAR].g) < 0.05 * b.sidecar.masses[SPAR].g);
});

test('a hull file does not depend on the triangle order', () => {
  const g = s.model.component(SPAR).geometry;
  const idx = g.index ? Array.from(g.index.array) : Array.from({ length: g.attributes.position.count }, (_, i) => i);
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) tris.push(idx.slice(i, i + 3));
  tris.reverse();
  const h = g.clone();
  h.setIndex(tris.flat());
  const M = new THREE.Matrix4().makeRotationZ(0.3).setPosition(1, 2, 3);
  assert.ok(same(hullCloud(g, M), hullCloud(h, M)));
});
