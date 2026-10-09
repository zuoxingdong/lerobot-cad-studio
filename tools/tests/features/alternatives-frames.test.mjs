/* `meta.frame` — what a workspace alternative's `local` is relative to, and what carries its
 * camera block.  Both rules are pure functions in `features/slots.js`
 * (`alternativePlacement`, `alternativeCameraFrame`); this file tests those, never a copy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { studio, round } from './_harness.mjs';
import { alternativePlacement, alternativeCameraFrame } from '../../../src/features/slots.js';
import { createCameras } from '../../../src/features/cameras.js';

const SLOT = 'top_camera_mount';
/* the corner mast's own numbers (gen_corner_mast.Corner({}).matrix16()), ROBOT frame */
const ROBOT_LOCAL = [
  0.9848077530, -0.1736481777, 0.0, 0.0,
  0.1422418, 0.8067066, 0.5735742, 0.0,
  -0.0995999, -0.5648624, 0.8191520, 0.0,
  -74.7905545, -15.4557674, 500.0, 1.0,
];
const SENSOR = [-74.7905545, -15.4557674, 500.0];
const raw = (m) => new THREE.Vector3().setFromMatrixPosition(m).toArray();
const pos = (m) => raw(m).map((v) => round(v, 4));

test('frame:"robot" is used as it stands — the anchor is NOT applied', async () => {
  const { model, slots } = await studio();
  const a = slots.anchorOf(SLOT);
  const anchor = pos(a.matrix);
  const p = alternativePlacement(SLOT, { frame: 'robot', local: ROBOT_LOCAL }, slots);
  assert.equal(p.frame, 'robot');
  assert.equal(p.link, null);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(raw(p.robot)[i] - SENSOR[i]) < 1e-9,
    `axis ${i}: ${raw(p.robot)[i]} !== ${SENSOR[i]} — the anchor leaked back in`);
  /* and the anchor really is offset, or the test above would pass for the wrong reason */
  assert.ok(new THREE.Vector3().fromArray(anchor).length() > 1);
});

test('frame:"slot_anchor" is anchor · local (the unchanged import behaviour)', async () => {
  const { slots } = await studio();
  const anchor = slots.anchorOf(SLOT).matrix.clone();
  const local = new THREE.Matrix4().makeTranslation(0, 0, 100);
  const p = alternativePlacement(SLOT, { frame: 'slot_anchor', local: local.toArray() }, slots);
  const want = raw(anchor.clone().multiply(local));
  raw(p.robot).forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `axis ${i}`));
  /* the deck anchor hangs off no link, so it stays a robot-frame component */
  assert.equal(p.link, null);
});

test('a slot_anchor alternative on a MOVING anchor rides its link', async () => {
  const { model, slots } = await studio();
  const moving = Object.keys(slots.slots).find((sid) => {
    const a = slots.anchorOf(sid);
    return a && a.matrix && a.parent && a.parent !== 'world';
  });
  if (!moving) { console.log('  (this package has no slot on a link — skipped)'); return; }
  const a = slots.anchorOf(moving);
  const p = alternativePlacement(moving, { frame: 'slot_anchor', local: null }, slots);
  assert.equal(p.link, a.parent);
  assert.equal(p.frame, 'link');
  /* FK(link) · local must reproduce the anchor itself */
  const world = model.fk(p.link).multiply(p.local);
  const want = raw(a.matrix);
  raw(world).forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-6, `axis ${i}: ${v} !== ${want[i]}`));
});

test('null local is identity, whatever the frame says', async () => {
  const { slots } = await studio();
  const r = alternativePlacement(SLOT, { frame: 'robot', local: null }, slots);
  assert.deepEqual(pos(r.robot), [0, 0, 0]);
  const s = alternativePlacement(SLOT, { frame: 'slot_anchor', local: null }, slots);
  raw(s.robot).forEach((v, i) => assert.ok(Math.abs(v - raw(slots.anchorOf(SLOT).matrix)[i]) < 1e-9));
});

test('alternativeCameraFrame: "robot" stays robot, "slot_anchor" names the anchor', async () => {
  const { slots } = await studio();
  assert.equal(alternativeCameraFrame(SLOT, { frame: 'robot' }, slots), 'robot');
  assert.equal(alternativeCameraFrame(SLOT, {}, slots), 'robot');
  assert.equal(alternativeCameraFrame(SLOT, { frame: 'slot_anchor' }, slots), slots.anchorOf(SLOT).name);
  /* a NAME and never a matrix: registerFrames re-resolves a named carrier on every getPose */
  assert.equal(typeof alternativeCameraFrame(SLOT, { frame: 'slot_anchor' }, slots), 'string');
});

test('the camera block lands on the sensor for BOTH spellings of the same pose', async () => {
  const { model, slots } = await studio();
  const anchor = slots.anchorOf(SLOT).matrix.clone();
  const robotM = new THREE.Matrix4().fromArray(ROBOT_LOCAL);
  const anchorLocal = anchor.clone().invert().multiply(robotM);
  for (const [frame, local] of [['robot', ROBOT_LOCAL], ['slot_anchor', anchorLocal.toArray()]]) {
    const cams = createCameras(model);
    const alt = { id: 'x', slot: SLOT, label: 'x', frame, local: null,
      cameras: { top: { local, hfov_deg: 60 } }, source: 'inbox' };
    slots.registerAlternatives([alt], { slot: SLOT });
    const opt = slots.option(SLOT, 'alt:x');
    cams.registerFrames({ cam_top: opt.cameras.top },
      { frame: alternativeCameraFrame(SLOT, opt, slots), source: 'slot:' + SLOT });
    const p = cams.getPose('top', {});
    p.origin.toArray().forEach((v, i) => assert.ok(Math.abs(v - SENSOR[i]) < 0.05,
      `${frame}: axis ${i} is ${v}, wanted ${SENSOR[i]}`));
  }
  slots.clearAlternatives(SLOT);
});
