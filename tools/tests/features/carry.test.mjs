/* features/carry.js on the shipped corner mast and the PincOpen fingertips: a shorten or a scale
 * of a spar carries the head, retainer, DF200, hinge origin and camera rigidly; the tilt then
 * turns about the carried origin; a mesh across the cut stays and is named; the sim build
 * follows.  Plus part-ops.js copyFrame: a mirrored copy of an attached part rides its link. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { studio, round } from './_harness.mjs';
import { carryOf } from '../../../src/features/carry.js';
import { createPartOps, copyFrame, copyLabel } from '../../../src/features/part-ops.js';
import { hingesOf, hingeTransforms, cameraAdjuster } from '../../../src/features/hinge.js';
import { applyOps, stretchAxes } from '../../../src/features/ops.js';
import { createCameras, adoptAllSlotOptions } from '../../../src/features/cameras.js';
import { visibilityFor } from '../../../src/features/slot-options.js';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { ROOT } from '../_root.mjs';

const MAST = 'corner_mast_printed';
const LOWER = `${MAST}_spar_lower`, UPPER = `${MAST}_spar_upper`;
const HELD = ['head', 'retainer', 'df200'].map((m) => `${MAST}_${m}`);
const s = await studio();
const ops = createPartOps({ model: s.model, slots: s.slots });
const vis = visibilityFor(s.model, s.slots, s.design);
const carry = (design) => carryOf(s.model, design, { slots: s.slots, visible: (id) => vis.get(id) !== false, build: ops.build });
const withParts = (parts) => ({ ...s.design, parts: { ...(s.design.parts || {}), ...parts } });
const shorten = (key, by = -20) => {
  const [{ axis, at }] = stretchAxes(ops.original(key), { mount: ops.mount(key), by });
  return { op: 'stretch', axis, at, by };
};
const camOrigin = (design, c) => {
  const cams = createCameras(s.model);
  adoptAllSlotOptions(cams, s.slots, design, cameraAdjuster(s.model, design, c));
  return cams.getPose('top', {}).origin.toArray();
};
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('the default design carries nothing', () => {
  const c = carry(s.design);
  assert.equal(c.ids().length, 0);
  assert.equal(c.warnings.length, 0);
});

test('shorten the lower spar −20: the spar above, head, retainer, DF200, hinge origin and camera drop 20.0 mm', () => {
  const d = withParts({ [LOWER]: { ops: [shorten(LOWER)] } });
  const c = carry(d);
  assert.deepEqual(c.ids().sort(), [UPPER, ...HELD].sort());
  for (const id of [UPPER, ...HELD]) assert.ok(near(c.mesh(id), [0, 0, -20], 0.01), `${id} ${c.mesh(id)}`);
  assert.equal(c.mesh(LOWER), null);
  const [{ def }] = hingesOf(s.model, MAST, c);
  const [{ def: def0 }] = hingesOf(s.model, MAST);
  assert.ok(near(def.origin, [def0.origin[0], def0.origin[1], def0.origin[2] - 20], 0.01), 'hinge origin ' + def.origin);
  const o0 = camOrigin(s.design, null), o1 = camOrigin(d, c);
  console.log(`  camera z ${round(o0[2], 3)} -> ${round(o1[2], 3)} mm`);
  assert.ok(near(o1, [o0[0], o0[1], o0[2] - 20], 0.01));
  /* without the carry nothing moves: the regression */
  assert.ok(near(camOrigin(d, null), o0, 1e-9));
});

test('then tilt 45 -> 60: the head and camera turn about the lowered hinge', () => {
  const d = withParts({ [LOWER]: { ops: [shorten(LOWER)] }, [MAST]: { params: { tilt_deg: 60 } } });
  const c = carry(d);
  const rec = JSON.parse(readFileSync(`${ROOT}/assets/parts/corner_mast_printed/record.json`, 'utf8'));
  const w = rec.params.detent_cam_mm['60'];
  const o = camOrigin(d, c);
  console.log(`  camera at 60°: ${o.map((v) => round(v, 3)).join(', ')} (record ${w.join(', ')} − 20 z)`);
  assert.ok(near(o, [w[0], w[1], w[2] - 20], 1e-3), 'camera ' + o);
  /* a head vertex: turned about the lowered origin = turned about the shipped one, then lowered */
  const H = hingeTransforms(s.model, d, null, c).get(HELD[0]);
  const H0 = hingeTransforms(s.model, withParts({ [MAST]: { params: { tilt_deg: 60 } } })).get(HELD[0]);
  const v = new THREE.Vector3(-80, -40, 500);
  const a = v.clone().applyMatrix4(H), b = v.clone().applyMatrix4(H0);
  assert.ok(near(a.toArray(), [b.x, b.y, b.z - 20], 1e-6), `${a.toArray()} vs ${b.toArray()}`);
  assert.ok(near(hingeTransforms(s.model, d, null, c).get(UPPER).elements.slice(12, 15), [0, 0, -20], 1e-9));
});

test('scale the upper spar Z 105 % about the mount: what it holds moves as one rigid group', () => {
  const d = withParts({ [UPPER]: { ops: [{ op: 'scale', factors: [1, 1, 1.05], about: 'mount' }] } });
  const c = carry(d);
  const g = ops.original(UPPER);
  g.computeBoundingBox();
  const want = 0.05 * (g.boundingBox.max.z - 57);
  console.log(`  held parts rise ${round(want, 3)} mm (far end ${round(g.boundingBox.max.z, 2)} mm)`);
  for (const id of HELD) assert.ok(near(c.mesh(id), [0, 0, want], 1e-6), `${id} ${c.mesh(id)}`);
  assert.equal(c.mesh(LOWER), null, 'the spar below is not held');
});

test('a mesh across the cut stays and is named; a refused op carries nothing', () => {
  const key = 'pincopen/tip_support';
  const [{ axis, at }] = stretchAxes(ops.original(key), { mount: ops.mount(key), by: 3 });
  const c = carry(withParts({ [key]: { ops: [{ op: 'stretch', axis, at, by: 3 }] } }));
  assert.ok(c.warnings.some((w) => /^Removable Tip crosses the cut/.test(w.text)), JSON.stringify(c.warnings));
  assert.equal(c.mesh('pincopen/removable_tip'), null);
  const bad = carry(withParts({ [LOWER]: { ops: [{ ...shorten(LOWER), at: 58 }] } }));
  assert.equal(bad.ids().length, 0, 'a refused shorten moved ' + bad.ids());
});

test('the MJCF build carries the head geoms and the top camera down 20 mm', async () => {
  const scene = await sceneDoc('lab');
  const build = (design) => buildMjcf({ model: s.model, slots: s.slots, design, scene });
  const a = build(s.design), b = build(withParts({ [LOWER]: { ops: [shorten(LOWER)] } }));
  const za = a.sidecar.cameras.top.robot_mm.zero[2][3], zb = b.sidecar.cameras.top.robot_mm.zero[2][3];
  console.log(`  MJCF top camera z ${round(za, 3)} -> ${round(zb, 3)} mm`);
  assert.ok(Math.abs(zb - (za - 20)) < 0.01);
  const zOf = (bt, f) => {
    const m = bt.meshes.get(f);
    const n = new DataView(m.buffer, m.byteOffset).getInt32(0, true);
    const p = new Float32Array(m.buffer.slice(m.byteOffset + 16, m.byteOffset + 16 + 12 * n));
    let hi = -Infinity;
    for (let i = 2; i < p.length; i += 3) hi = Math.max(hi, p[i]);
    return hi;
  };
  assert.ok(Math.abs(zOf(b, `${HELD[0]}.msh`) - (zOf(a, `${HELD[0]}.msh`) - 20)) < 0.01, 'the head geom');
});

test('a mirrored copy of an attached fingertip rides the same finger at every jaw position', () => {
  const src = s.model.component('pincopen/removable_tip');
  const at = copyFrame(s.model, src);
  assert.equal(at.link, 'pincopen/finger_L');
  const g0 = ops.original(src.id);
  g0.computeBoundingBox();
  const centre = g0.boundingBox.getCenter(new THREE.Vector3()).toArray();
  const plane = { point: centre, normal: [1, 0, 0] };
  const geometry = applyOps(g0, [{ op: 'mirror', plane }]).geometry;
  const key = 'imported/test-mirror-1';
  const label = copyLabel(s.model, src, key);
  assert.equal(label, 'Removable Tip (mirror copy)');
  s.model.ownComponents.push({ id: key, localId: key, label, link: at.link, frame: at.frame, local: at.local,
    group: 'imported', geometry, owner: s.model, visible: true, imported: true });
  s.model._flatten();
  const keep = s.model.getJoints();
  const jaw = s.model.controlJoints().find((j) => /jaw/.test(j));
  try {
    for (const q of [0, 20]) {
      s.model.setJoints({ ...keep, [jaw]: q });
      const W = s.model.worldMatrix(src.id), Wc = s.model.worldMatrix(key);
      /* the original's vertices mirrored about the plane in the world -> the copy's box */
      const Pw = new THREE.Vector3(...centre).applyMatrix4(W), Nw = new THREE.Vector3(1, 0, 0).transformDirection(W);
      const want = new THREE.Box3(), got = new THREE.Box3();
      const pos = g0.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(W);
        want.expandByPoint(v.sub(Nw.clone().multiplyScalar(2 * v.clone().sub(Pw).dot(Nw))));
      }
      const cp = geometry.attributes.position;
      for (let i = 0; i < cp.count; i++) got.expandByPoint(v.fromBufferAttribute(cp, i).applyMatrix4(Wc));
      console.log(`  jaw ${q}: copy z ${round(got.min.z, 2)}..${round(got.max.z, 2)} mm`);
      assert.ok(near(got.min.toArray(), want.min.toArray(), 0.01) && near(got.max.toArray(), want.max.toArray(), 0.01),
        `jaw ${q}: ${got.min.toArray()} / ${want.min.toArray()}`);
    }
  } finally {
    s.model.setJoints(keep);
    s.model.ownComponents.splice(s.model.ownComponents.findIndex((c) => c.id === key), 1);
    s.model._flatten();
  }
});
