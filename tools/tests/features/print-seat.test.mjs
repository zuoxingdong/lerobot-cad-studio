/* Every exported plate sits on the bed: `seatOnBed` moves the print pose along Z only, the
 * validator hands the export and the print check that seated pose, and a thicken on the bed
 * face lifts the part back onto Z = 0.  Plus the knob reset that saves as its own reload. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as pkg from '../../../src/core/package.js';
import { buildSlots } from '../../../src/features/slots.js';
import { createStore, defaultDesign, memoryStorage } from '../../../src/core/store.js';
import { createValidator } from '../../../src/features/validate.js';
import { createPartOps } from '../../../src/features/part-ops.js';
import { seatOnBed } from '../../../src/features/geometry-kit.js';
import { seededParams } from '../../../src/features/parts.js';

const EPS = 1e-6;
const SPAR = 'corner_mast_printed_spar_lower';
const cache = new Map();
async function robot(id) {
  if (!cache.has(id)) {
    const model = await pkg.loadEmbedded(id);
    const slots = buildSlots(model);
    cache.set(id, { model, slots, design: slots.applyDefaults(defaultDesign(id)), V: createValidator({ model, slots }) });
  }
  return cache.get(id);
}
const placed = (g, M) => { const p = g.clone().applyMatrix4(M); p.computeBoundingBox(); return p; };
/** every vertex of b minus a: one constant vector, or null */
function shift(a, b) {
  const pa = a.attributes.position, pb = b.attributes.position;
  if (pa.count !== pb.count) return null;
  const d = [pb.getX(0) - pa.getX(0), pb.getY(0) - pa.getY(0), pb.getZ(0) - pa.getZ(0)];
  for (let i = 1; i < pa.count; i++) {
    if (Math.abs(pb.getX(i) - pa.getX(i) - d[0]) > 1e-4 || Math.abs(pb.getY(i) - pa.getY(i) - d[1]) > 1e-4
      || Math.abs(pb.getZ(i) - pa.getZ(i) - d[2]) > 1e-4) return null;
  }
  return d;
}

test('seatOnBed: a Z translation on top of the pose, nothing else', () => {
  const g = new THREE.BoxGeometry(40, 20, 10);
  const M = new THREE.Matrix4().makeRotationX(0.7).premultiply(new THREE.Matrix4().makeTranslation(3, -4, 9));
  const S = seatOnBed(g, M);
  M.elements.forEach((v, i) => { if (i !== 14) assert.equal(S.elements[i], v, 'element ' + i); });
  assert.ok(Math.abs(placed(g, S).boundingBox.min.z) < EPS);
  const d = shift(placed(g, M), placed(g, S));
  assert.ok(d && Math.abs(d[0]) < EPS && Math.abs(d[1]) < EPS, 'X/Y moved: ' + d);
  assert.ok(Math.abs(placed(g, seatOnBed(g)).boundingBox.min.z) < EPS, 'identity pose');
});

for (const id of ['lekiwi-pincopen', 'lekiwi']) {
  test(`${id}: every default plate is on the bed, moved along Z only`, async () => {
    const { model, design, V } = await robot(id);
    let n = 0, moved = 0;
    for (const c of model.printables()) {
      const g = V.geometryOf(design, c.id);
      if (!g.geometry || !g.printTransform) continue;
      n++;
      const z = placed(g.geometry, g.printTransform).boundingBox.min.z;
      assert.ok(Math.abs(z) < EPS, `${c.id}: z min ${z}`);
      if (g.orientation !== 'declared') continue;
      /* the package pose, re-seated: same rotation, same X/Y */
      const P = c.printTransform.elements, S = g.printTransform.elements;
      for (let i = 0; i < 16; i++) if (i !== 14) assert.ok(Math.abs(S[i] - P[i]) < 1e-12, `${c.id}: element ${i}`);
      if (Math.abs(S[14] - P[14]) > EPS) moved++;
    }
    assert.ok(n >= 13, n + ' plates');
    assert.ok(moved > 0, 'no declared plate was off the bed — the reseat is untested here');
  });
}

test('a thicken on the bed face: the plate is lifted back onto Z = 0, its shape only translated', async () => {
  const { model, slots, design, V } = await robot('lekiwi-pincopen');
  const c = model.component(SPAR);
  const T = c.printTransform;
  /* the largest down-facing triangle on the bed, in the part frame */
  const plate = placed(c.geometry, T), pos = plate.attributes.position, z0 = plate.boundingBox.min.z;
  let best = null, area = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < pos.count / 3; t++) {
    A.fromBufferAttribute(pos, 3 * t); B.fromBufferAttribute(pos, 3 * t + 1); C.fromBufferAttribute(pos, 3 * t + 2);
    if (Math.max(A.z, B.z, C.z) > z0 + 1e-3) continue;
    n.subVectors(B, A).cross(C.clone().sub(A));
    if (n.z < 0 && n.length() / 2 > area) { area = n.length() / 2; best = A.clone().add(B).add(C).divideScalar(3); }
  }
  const Ti = T.clone().invert();
  const seed = { point: best.applyMatrix4(Ti).toArray(), normal: new THREE.Vector3(0, 0, -1).transformDirection(Ti).toArray() };
  const b = createPartOps({ model, slots }).build(SPAR, [{ op: 'offset_face', seed, by: 1 }]);
  assert.ok(b.ok && !b.refused, 'the thicken was refused');
  const keep = { geometry: c.geometry, edited: c.edited };
  try {
    c.geometry = b.geometry; c.edited = true;
    const g = V.geometryOf(design, SPAR);
    const raw = placed(b.geometry, T), seated = placed(g.geometry, g.printTransform);
    assert.ok(Math.abs(raw.boundingBox.min.z + 1) < 1e-3, 'the raw pose is not 1 mm under the bed: ' + raw.boundingBox.min.z);
    assert.ok(Math.abs(seated.boundingBox.min.z) < EPS, 'z min ' + seated.boundingBox.min.z);
    const d = shift(raw, seated);
    assert.ok(d && Math.abs(d[0]) < EPS && Math.abs(d[1]) < EPS && Math.abs(d[2] - 1) < 1e-3, 'not a pure +1 mm lift: ' + d);
    const pc = V.printOf(design, SPAR);
    assert.equal(pc.analysis.bbox.min.z, seated.boundingBox.min.z, 'the check measured another mesh');
    assert.equal(pc.chips.find((x) => x.key === 'bedcontact').level, 'pass');
    assert.notEqual(pc.verdict, 'fail');
  } finally { Object.assign(c, keep); }
});

test('a knob reset saves exactly what its reload gives back', async () => {
  const { slots } = await robot('lekiwi-pincopen');
  const settle = (s) => { const r = slots.reconcile(s.getState()); if (r.changed) s.patch({ slots: r.design.slots, components: r.design.components, params: r.design.params }); };
  const mk = () => createStore({ robot: 'lekiwi-pincopen' }, { storage: memoryStorage() });
  const json = (s) => { const { saved, ...j } = JSON.parse(s.exportJSON()); void saved; return JSON.stringify(j); };
  const a = mk();
  settle(a);
  const fresh = json(a);
  a.set(['params', 'pi_case_cradle', 'height'], 105);
  /* what ctx.on.resetParams stores */
  const seeded = seededParams(a.getState(), 'pi_case_cradle', slots);
  assert.ok(seeded && seeded.height === 97, JSON.stringify(seeded));
  a.set(['params', 'pi_case_cradle'], seeded);
  const text = json(a);
  assert.equal(text, fresh, 'a reset is not the default design');
  const b = mk();
  assert.ok(b.importJSON(text, { merge: true }).ok);
  settle(b);
  assert.equal(json(b), text, 'the reload differs');
  /* nothing seeds a component no slot shows: its reset still removes it */
  assert.equal(seededParams(a.getState(), 'no_such_part', slots), undefined);
});
