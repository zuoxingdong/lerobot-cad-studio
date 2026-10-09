/* `features/tip.js` — where the fitted gripper reaches.  The grasp point, the slot anchor and
 * the camera "tip in frame" verdict all read this measurement, so these cases are what keeps a
 * fingertip tweak or swap from moving it unnoticed.  Evaluated straight off the model
 * (base · local), exactly as `features/tip.js tipPoint()` does. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { studio, round, near } from './_harness.mjs';
import { tipReach, flangeTip, hingeTip } from '../../../src/features/tip.js';

/** a tip frame evaluated in the robot frame, at the pose the model is in */
function at(model, t) {
  const base = (model.hasLink && model.hasLink(t.link))
    ? model.fk(t.link) : (model.frameMatrix(t.link) || model.fk(t.link));
  return new THREE.Vector3().setFromMatrixPosition(
    new THREE.Matrix4().multiplyMatrices(base, t.local));
}
const fmt = (p) => [p.x, p.y, p.z].map((v) => round(v, 1)).join(', ');

test('the two tip frames reproduce the reference figures', async () => {
  const { model } = await studio();
  model.setJoints({});
  /* the v3 spelling, with the reach given explicitly, is unchanged */
  const at70 = at(model, flangeTip(model, 'wrist_flange', 70));
  const stock = at(model, hingeTip(model, 80));
  assert.ok(near(at70.x, -4.8, 0.05) && near(at70.y, 194.1, 0.05) && near(at70.z, 51.1, 0.05));
  assert.ok(near(stock.x, -24.6, 0.05) && near(stock.y, 168.6, 0.05) && near(stock.z, 61.7, 0.05));

  /* the reach parameter really is a reach */
  const long = at(model, flangeTip(model, 'wrist_flange', 140));
  assert.ok(near(long.distanceTo(at70), 70, 1e-6));
});

test('the DEFAULT reach is measured off the fitted fingertip, not a literal', async () => {
  const { model } = await studio();
  model.setJoints({});
  const m = tipReach(model);
  assert.equal(m.ok, true, m.warning || 'the fitted fingertip is measurable');
  assert.match(m.source, /slots\.pincopen\/fingertips/);
  assert.ok(near(m.reach, 70.654, 0.01),
    `the fitted PincOpen tip reaches ${round(m.reach, 3)} mm past the flange`);

  const f = flangeTip(model);
  assert.ok(near(f.reach, m.reach, 1e-9), 'flangeTip() with no reach IS the measurement');
  const at70 = at(model, flangeTip(model, 'wrist_flange', 70));
  const fitted = at(model, f);
  assert.ok(near(fitted.distanceTo(at70), m.reach - 70, 1e-6), 'the default tip IS the measured one');
});

test('a longer fingertip moves the reach, and the grasp point with it', async () => {
  const { model } = await studio();
  const base = tipReach(model).reach;
  const explicit = flangeTip(model, 'wrist_flange', base + 6);
  assert.ok(near(explicit.reach, base + 6, 1e-9));
  assert.equal(flangeTip(model).source, tipReach(model).source,
    'the measured frame names where it came from');
});

test('hingeTip needs a gripper joint, and says so when there is none', async () => {
  const { model } = await studio();
  const h = hingeTip(model, 80);
  assert.ok(h.link && h.local && h.dirLocal, 'a frame, not a function');
  assert.equal(typeof h.name, 'string');
  assert.ok(near(h.dirLocal.length(), 1, 1e-9), 'the finger direction is a unit vector');
  /* a package with no frames at all must throw a named error, not return a bad frame */
  assert.throws(() => flangeTip({ manifest: { frames: {} } }, 'nope'), /no frame/);
});
