/* The as-installed camera calibration: a declared-but-empty slot, a hand-entered offset, and
   the frame a camera is carried in when the base moves. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withCameras, freshCameras, round, near } from './_harness.mjs';
import { createCameras, adoptAllSlotOptions, verdict, calibDefaultFor } from '../../../src/features/cameras.js';

const optionCamera = (model, slot, id, cam) =>
  ((model.manifest.slots[slot].options.find((o) => o.id === id) || {}).cameras || {})[cam];

test('as-installed calibration: the slot is declared, nothing is measured into it', async () => {
  const { model } = await withCameras();
  const C = await freshCameras();
  const raw = (id) => (model.manifest.cameras || []).find((c) => c.id === id) || {};

  /* nothing is measured, so nothing is offset — and `null` must never read as 0 degrees */
  for (const id of ['front', 'wrist', 'top']) {
    assert.equal(calibDefaultFor(raw(id)).tilt_deg, 0, `${id}: no measured offset`);
    assert.equal(C.hasCalib(id), false, `${id}: nothing to see when the mode flips`);
  }
  assert.equal(raw('top').verified.droop_deg, null, 'and the package says so explicitly');
  assert.equal(raw('top').verified.verified_tilt_deg, null);
  assert.ok(raw('top').verified.droop_note, 'with the reason beside it');
  assert.equal(calibDefaultFor(null).tilt_deg, 0);
  assert.equal(calibDefaultFor({}).source, null, 'no verified block, no source');
  /* the top and the wrist declare the SLOT, so the strip can offer "unmeasured" */
  assert.equal(C.hasCalibSlot('top'), true);
  assert.equal(C.hasCalibSlot('wrist'), true);
  assert.equal(C.hasCalibSlot('front'), false, 'the front camera has no verified block at all');

  /* a package that DOES declare a measurement still yields it (the machinery is intact) */
  assert.equal(calibDefaultFor({ tilt_deg: 65, verified: { verified_tilt_deg: 71.8 } }).tilt_deg, 6.8);
  assert.equal(calibDefaultFor({ verified: { design_tilt_deg: 45, verified_tilt_deg: 50 } }).tilt_deg, 5);
  assert.equal(calibDefaultFor({ tilt_deg: 45, verified: { verified_tilt_deg: null } }).tilt_deg, 0,
    'an explicit null is UNMEASURED, not "45° out"');

  /* mode 'design' is the shipped default and changes nothing at all */
  assert.equal(C.calibMode, 'design');
  const design = C.getPose('top');
  assert.ok(near(design.tilt_deg, 45, 1e-6), 'design pose is the package pose');
  assert.equal(design.calib, null);
  C.setCalibMode('installed');
  assert.ok(near(C.getPose('top').tilt_deg, 45, 1e-6), 'with no measurement the modes agree');

  /* now type one in, exactly as the strip will once the head is on an inclinometer */
  C.setCalib('top', { tilt_deg: 6.8 });
  const inst = C.getPose('top');
  assert.ok(near(inst.tilt_deg - design.tilt_deg, 6.8, 1e-6), 'exactly the offset that was typed');
  assert.deepEqual(inst.calib, { tilt_deg: 6.8, roll_deg: 0 });
  assert.match(inst.source, /calib/);
  assert.equal(inst.origin.distanceTo(design.origin), 0, 'a tilt is a ROTATION: the sensor point does not move');
  assert.equal(C.hasCalib('top'), true, 'and now there IS something to see');

  /* a camera with no offset is untouched by the mode */
  assert.ok(near(C.getPose('front').tilt_deg, -10, 1e-6), 'front is the same in both modes');
  assert.equal(C.getPose('front').calib, null);

  /* roll is about the TILTED optical axis, and 0 is a no-op */
  C.setCalib('top', { roll_deg: 5 });
  const rolled = C.getPose('top');
  assert.ok(near(rolled.tilt_deg, inst.tilt_deg, 1e-6), 'roll does not change the tilt');
  assert.ok(near(rolled.dir.angleTo(inst.dir) * 180 / Math.PI, 0, 1e-6), 'the optical axis is unmoved by roll');
  C.resetCalib('top');
  assert.deepEqual(C.getCalib('top'), { tilt_deg: 0, roll_deg: 0 }, 'reset goes back to UNMEASURED');

  C.setCalib('top', { tilt_deg: 4.25 });
  const j = C.toJSON();
  assert.deepEqual(j.top.calib, { tilt_deg: 4.25, roll_deg: 0 });
  const D = await freshCameras();
  /* the DESIGN datum is the fitted option's camera block; a calibration may never touch it */
  const optionPose = JSON.stringify(optionCamera(model, 'top_camera_mount', 'corner_mast_printed', 'top'));
  D.setCalibMode('installed');
  D.fromJSON(j);
  assert.ok(near(D.getPose('top').tilt_deg, 49.25, 1e-6), '45 + 4.25');
  assert.equal(JSON.stringify(optionCamera(model, 'top_camera_mount', 'corner_mast_printed', 'top')), optionPose,
    'the option pose is untouched — a calibration never edits a printable');
  assert.equal(optionCamera(model, 'top_camera_mount', 'corner_mast_printed', 'top').tilt_deg, 45,
    'and the option still declares the DESIGN tilt');

  /* back to design, and everything is exactly where it started */
  D.setCalibMode('design');
  assert.ok(near(D.getPose('top').tilt_deg, 45, 1e-6));
});

test('a hand-entered calibration moves the verdict, not the geometry', async () => {
  await withCameras();
  const C = await freshCameras();
  C.setHfov('top', 87.3);
  /* the two front omni-wheel top patches, robot mm */
  const wheels = [[-106.2, 60.6, 54.9], [107.3, 63.0, 54.8]];
  const vAt = () => {
    const p = C.getPose('top');
    const v = wheels.map((w) => C.project('top', new THREE.Vector3(...w), p));
    return (v[0].v + v[1].v) / 2;
  };
  const origin = C.getPose('top').origin.clone();
  const design = vAt();
  C.setCalib('top', { tilt_deg: 6.8 });
  C.setCalibMode('installed');
  const installed = vAt();
  assert.ok(Math.abs(installed - design) > 0.02, `the corner mast's landmarks moved ${design.toFixed(3)} → ${installed.toFixed(3)}`);
  assert.equal(C.getPose('top').origin.distanceTo(origin), 0, 'the sensor point is untouched');
});

test('a robot-frame part camera rides the DRIVEN base, exactly once', async () => {
  const { model } = await withCameras();
  const C = await freshCameras();
  const at = (id) => C.getPose(id).origin.clone();

  const home = { top: at('top'), wrist: at('wrist'), front: at('front') };
  assert.match(C.getPose('top').source, /slot:top_camera_mount|corner|part frame/);

  model.setBasePose({ x: 0, y: 250, yaw: 0 });
  try {
    for (const id of C.ids) {
      const moved = at(id).sub(home[id]);
      assert.ok(near(moved.length(), 250, 0.01),
        `${id} moved ${moved.length().toFixed(2)} mm for a 250 mm drive`);
      assert.ok(near(moved.y, 250, 0.01), `${id} moved the wrong way`);
    }

    model.setBasePose({ x: 0, y: 0, yaw: 90 });
    const t = C.getPose('top');
    assert.ok(near(t.origin.x, 18.571, 0.01) && near(t.origin.y, -75.34, 0.01),
      `a 90° yaw puts the top sensor at ${t.origin.x.toFixed(2)}, ${t.origin.y.toFixed(2)}, want 18.57, -75.34`);
    assert.ok(near(t.origin.z, 504.855, 0.01), 'and it does not change height');
    assert.ok(near(t.tilt_deg, 45, 1e-6), 'a yaw does not change the nose-down angle');
    assert.ok(near(t.right.y, Math.cos(10 * Math.PI / 180), 1e-5), 'the image did not turn with the robot');
  } finally {
    model.setBasePose({ x: 0, y: 0, yaw: 0 });
  }
  for (const id of C.ids) {
    assert.ok(near(at(id).distanceTo(home[id]), 0, 1e-6), `${id} came back to where it started`);
  }
});
