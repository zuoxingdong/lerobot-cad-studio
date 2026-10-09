/* Ops on a parametric part (the Pi case): the op base (package mesh at default knobs, else the
 * knob build) takes the op stack in either order; with no ops the build is drawn.  The validator
 * checks and exports that mesh, the agent context measures it.  The page route is parts.js
 * rebuildComponent -> part-ops.js rebase; tools/sim/lib.mjs takes the same one. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as pkg from '../../../src/core/package.js';
import { buildSlots } from '../../../src/features/slots.js';
import { defaultDesign } from '../../../src/core/store.js';
import { createPartOps } from '../../../src/features/part-ops.js';
import { rebuildComponent, opsBase } from '../../../src/features/parts.js';
import { applyParametrics } from '../../../src/features/sim-design.js';
import { createValidator } from '../../../src/features/validate.js';
import { buildAgentContext } from '../../../src/features/agent-context.js';

const ID = 'pi_case_cradle';
const STRETCH = { op: 'stretch', axis: [0, 0, 1], at: 64.5, by: 5 };

let _s = null;
async function fresh() {
  if (_s) return _s;
  const model = await pkg.loadEmbedded('lekiwi-pincopen');
  const slots = buildSlots(model);
  const design = slots.applyDefaults(defaultDesign('lekiwi-pincopen'));
  _s = { model, slots, design, P: createPartOps({ model, slots }), V: createValidator({ model, slots }) };
  return _s;
}
const size = (g) => { g.computeBoundingBox(); return g.boundingBox.getSize(new THREE.Vector3()).toArray(); };
const near = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < tol);
const withKnob = (d, v) => ({ ...d, params: { ...(d.params || {}), [ID]: { height: v } } });
const withOps = (d, ops) => ({ ...d, parts: { ...(d.parts || {}), [ID]: { ops } } });

/** what the page does on a knob change or a reload: the knob base, then the stored ops */
function settle(s, design) {
  const r = rebuildComponent(s.model, design, ID);
  const ops = ((design.parts || {})[ID] || {}).ops || [];
  const b = s.P.rebase(ID, r.base, ops, r.geometry);
  const c = s.model.component(ID);
  c.geometry = b.geometry;
  c.edited = b.geometry !== r.geometry;
  return { base: r, built: b };
}

test('default knobs: the build is drawn, the stretch runs on the package mesh', async () => {
  const s = await fresh();
  const r = rebuildComponent(s.model, s.design, ID);
  assert.ok(r.base === s.model.packageGeometry(ID) && r.geometry !== r.base, 'base / drawn mesh');
  const plain = settle(s, s.design);
  assert.equal(plain.built.geometry, plain.base.geometry, 'no ops: not the build');
  const { built } = settle(s, withOps(s.design, [STRETCH]));
  assert.equal(built.refused, null);
  assert.ok(near(size(built.geometry), [87.5, 40.3, 102], 0.01), size(built.geometry).join());
  assert.equal(built.geometry.userData.opsBase, s.model.packageGeometry(ID));
});

test('op after knob: the stretch runs on the knob build', async () => {
  const s = await fresh();
  const d = withKnob(s.design, 105);
  const { base } = settle(s, d);
  assert.ok(base.base === base.geometry && near(size(base.geometry), [87.5, 40.3, 105], 0.01), 'height 105 base');
  const { built } = settle(s, withOps(d, [STRETCH]));
  assert.ok(near(size(built.geometry), [87.5, 40.3, 110], 0.01), size(built.geometry).join());
});

test('knob after op: the op stays, rebuilt on the new base, and back on the package mesh', async () => {
  const s = await fresh();
  const d0 = withOps(s.design, [STRETCH]);
  const z = (d) => size(settle(s, d).built.geometry)[2];
  assert.ok(Math.abs(z(d0) - 102) < 0.01);
  assert.ok(Math.abs(z(withKnob(d0, 110)) - 115) < 0.01, 'the knob dropped the op');
  const back = settle(s, d0).built.geometry;
  assert.equal(back.userData.opsBase, s.model.packageGeometry(ID), 'reset knobs: not on the package mesh');
  assert.equal(s.P.original(ID), s.model.packageGeometry(ID));
  /* the same stack on the same base is the same mesh: a reload reproduces it */
  const again = settle(s, JSON.parse(JSON.stringify(d0))).built.geometry;
  assert.equal(again.attributes.position.count, back.attributes.position.count);
  assert.deepEqual(size(again), size(back));
});

test('export geometry: package mesh + op in the declared print pose, closed, one body', async () => {
  const s = await fresh();
  const d = withOps(s.design, [STRETCH]);
  settle(s, d);
  const c = s.model.component(ID);
  const g = s.V.geometryOf(d, ID);
  assert.equal(g.geometry, c.geometry, 'the export is not the live mesh');
  assert.equal(g.orientation, 'declared');
  const plate = g.geometry.clone().applyMatrix4(g.printTransform);
  assert.ok(near(size(plate), [87.5, 40.3, 102], 0.01), size(plate).join());
  plate.computeBoundingBox();
  assert.ok(Math.abs(plate.boundingBox.min.z) < 1e-3, 'off the bed: ' + plate.boundingBox.min.z);
  const pc = s.V.printOf(d, ID);
  assert.equal(pc.preview, null);
  for (const k of ['closed', 'bodies', 'bed']) assert.equal(pc.chips.find((x) => x.key === k).level, 'pass', k);
  /* edited knobs + the op: the live mesh, flagged as the CSG preview */
  const d2 = withKnob(d, 105);
  settle(s, d2);
  const g2 = s.V.geometryOf(d2, ID);
  assert.equal(g2.geometry, c.geometry);
  assert.ok(near(size(g2.geometry), [87.5, 40.3, 110], 0.01));
  assert.equal(s.V.printOf(d2, ID).preview, 'csg');
  /* untouched: the package plate, as before */
  settle(s, s.design);
  assert.equal(s.V.geometryOf(s.design, ID).geometry, s.model.packageGeometry(ID));
});

test('a thicken on the package mesh stays closed and one body', async () => {
  const s = await fresh();
  const d = withOps(s.design, [{ op: 'offset_face', seed: { point: [0, -70, 57], normal: [0, 0, -1] }, by: 1 }]);
  const { built } = settle(s, d);
  assert.equal(built.refused, null);
  assert.ok(near(size(built.geometry), [87.5, 40.3, 98], 0.01), size(built.geometry).join());
  const pc = s.V.printOf(d, ID);
  for (const k of ['closed', 'bodies']) assert.equal(pc.chips.find((x) => x.key === k).level, 'pass', k);
  settle(s, s.design);
});

test('the agent context pack measures the stretched case', async () => {
  const s = await fresh();
  const d = withOps(s.design, [STRETCH]);
  settle(s, d);
  const ctx = buildAgentContext({ model: s.model, slots: s.slots, design: d, slotId: 'pi_case' });
  const p = ctx.parts.find((x) => x.id === 'cradle');
  assert.ok(p, ctx.parts.map((x) => x.id).join());
  assert.ok(Math.abs(p.bbox.max[2] - p.bbox.min[2] - 102) < 0.01, JSON.stringify(p.bbox));
  settle(s, s.design);
});

test('headless (tools/sim/lib.mjs): the build drawn, the ops on the package mesh', async () => {
  const s = await fresh();
  applyParametrics(s.model, s.design);
  const c = s.model.component(ID), P = createPartOps({ model: s.model, slots: s.slots });
  assert.notEqual(c.geometry, s.model.packageGeometry(ID), 'the default MJCF mesh moved off the build');
  const r = P.rebase(ID, opsBase(s.model, s.design, ID), [STRETCH], c.geometry);
  assert.equal(r.geometry.userData.opsBase, s.model.packageGeometry(ID));
  assert.ok(near(size(r.geometry), [87.5, 40.3, 102], 0.01));
  assert.equal(P.build(ID, []).geometry, c.geometry);
  assert.equal(opsBase(s.model, withKnob(s.design, 105), ID), null);
});
