/* features/hinge.js: an option label follows the live hinge value, and a part folder that is
   not in the package (an agent design) gets working hinge knobs once registered. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { registerPart, partOf, hingesOf, hingeTransforms, liveLabel, cameraAdjuster } from '../../../src/features/hinge.js';

test('the fitted mast option reads its live tilt, not the 45° in its name', async () => {
  const { model, slots, design } = await studio();
  const sid = 'top_camera_mount';
  const opt = slots.option(sid, slots.activeOption(design, sid));
  assert.match(opt.label, /45°/);
  const pid = partOf(model, opt.shows[0]).id;
  const at55 = { ...design, parts: { [pid]: { params: { tilt_deg: 55 } } } };
  assert.equal(liveLabel(model, design, opt, opt.label), opt.label, 'the design detent keeps the name');
  assert.equal(liveLabel(model, at55, opt, opt.label), opt.label.replace('45°', '55°'));
  assert.equal(liveLabel(model, at55, { label: 'No overhead camera' }), 'No overhead camera', 'no hinge, no change');
});

test('a registered agent part: partOf, its hinge, the turn and the camera follow', async () => {
  const { model } = await studio();
  const cid = model.components.find((c) => c.geometry && !partOf(model, c.id)).id;
  const doc = {
    label: 'agent mast', meshes: [{ id: 'spar' }],
    params: { tilt_deg: { kind: 'hinge', values: [40, 45, 50], value: 45, design: 45,
      origin: [0, 0, 0], axis: [1, 0, 0], moves: ['spar'], camera: 'top' } },
  };
  assert.ok(registerPart(model, 'agent_mast', doc, (mid) => (mid === 'spar' ? cid : null)));
  assert.equal(partOf(model, cid).id, 'agent_mast');
  assert.equal(hingesOf(model, 'agent_mast').length, 1);
  const design = { parts: { agent_mast: { params: { tilt_deg: 50 } } } };
  const H = hingeTransforms(model, design, (pid) => pid === 'agent_mast');
  assert.ok(H.has(cid), 'the drawn component turns with the knob');
  const e = H.get(cid).elements;
  assert.ok(Math.abs(e[5] - Math.cos(5 * Math.PI / 180)) < 1e-9, 'a 5° turn about X');
  const local = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const turned = cameraAdjuster(model, design)('top', { local }, { shows: [cid] }).local;
  assert.ok(Math.abs(turned[5] - Math.cos(5 * Math.PI / 180)) < 1e-9, 'the camera it carries turns too');
  assert.equal(liveLabel(model, design, { shows: [cid] }, 'agent mast · 45°'), 'agent mast · 50°');
});
