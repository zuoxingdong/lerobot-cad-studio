/* Motion approximations: a wrist camera's build frame is package data, a robot-framed body
 * rides the base pose and a free one does not, a mimic joint is not a DOF. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as pkg from '../../../src/core/package.js';
import * as FPlace from '../../../src/features/placement.js';
import { studio } from './_harness.mjs';
import { createCollisionWorld } from '../../../src/features/collide.js';
import { createCameras } from '../../../src/features/cameras.js';
import { cameraBuildFrame } from '../../../src/features/camera-frame.js';

const matrixNear = (a, b, tol = 1e-9) => {
  for (let i = 0; i < 16; i++) if (Math.abs(a.elements[i] - b.elements[i]) > tol) return false;
  return true;
};

test('a camera build frame is read off the package, not a table of three ids', async () => {
  const { model } = await studio();
  const cams = createCameras(model);
  const frames = { cam_wrist: { origin: [0, 0, 0], dir: [0, 1, 0] } };

  /* the shipped mount: the camera declares the datum it seats on */
  for (const id of ['df200_arch_arch', 'df200_arch_head', 'df200_arch_retainer']) {
    assert.equal(cameraBuildFrame(model, cams, id, frames), 'wrist_flange', id);
  }
  const alt = {
    id: 'wrist_cam_import', localId: 'wrist_cam_import', label: 'Wrist camera (import)', link: 'Wrist_Roll_08c-v1',
    group: 'upgrade', slot: 'wrist_camera_mount', frame: 'link',
    local: model.component('df200_arch_arch').local.clone(), color: '#46a08b', printable: true,
    mesh: 'wrist_cam_import', source: 'workspace', visible: true,
    geometry: model.component('df200_arch_arch').geometry,
    owner: model, note: null,
  };
  model.ownComponents.push(alt);
  model._flatten();
  try {
    assert.equal(cameraBuildFrame(model, cams, 'wrist_cam_import', frames), 'wrist_flange',
      'a fourth wrist mount seats on the same declared datum');
    /* with no camera datum at all it still rides the arm, through its own placement */
    assert.equal(cameraBuildFrame(model, cams, 'wrist_cam_import', { cam_nosuch: {} }), 'component:wrist_cam_import');
    /* and every spelling the resolver accepts really resolves */
    for (const n of ['wrist_flange', 'Wrist_Roll_08c-v1', 'component:wrist_cam_import']) {
      assert.ok(cams.liveBase(n), n + ' must resolve to a live matrix');
    }
    assert.equal(cams.liveBase('robot'), null);

    /* the pose really is re-resolved at the current arm pose */
    cams.registerFrames(frames, { frame: 'wrist_flange', source: 'wrist_cam_import' });
    const a = cams.getPose('wrist').origin.clone();
    model.setJoints({ arm_shoulder_lift: -40 });
    const b = cams.getPose('wrist').origin.clone();
    model.setJoints(model.zeroPose());
    assert.ok(a.distanceTo(b) > 20, 'the wrist camera must ride the arm');
    cams.clearOverridesFrom('wrist_cam_import');
  } finally {
    model.ownComponents.pop();
    model._flatten();
  }
});

test('a robot-framed body rides the driven base; a free body does not', async () => {
  const { model, design } = await studio();
  const W = createCollisionWorld({ model });
  W.setActiveFromDesign(design);
  W.checkPose({});
  const g = new THREE.BoxGeometry(20, 20, 20);
  const at = new THREE.Matrix4().makeTranslation(300, 0, 100);
  W.addDynamic('bolted', g, at, { label: 'bolted', frame: 'robot' });
  W.addDynamic('free', g, at, { label: 'a ball on the floor' });

  model.setBasePose({ x: 250, y: -40, yaw: 30 });
  W.applyPose(model.getJoints());
  const B = model.baseMatrix();
  const want = B.clone().multiply(at);
  assert.ok(matrixNear(W.worldMatrix('bolted'), want), 'a robot-framed body must drive away with the robot');
  assert.ok(matrixNear(W.worldMatrix('free'), at), 'a free body must stay where it was put');

  const local = FPlace.toLocal(model, 'world', want);
  assert.ok(matrixNear(local, at), 'toLocal("world") baked the base pose into the transform');
  assert.ok(matrixNear(FPlace.toWorld(model, 'world', local), want), 'toWorld("world") lost it');
  model.setBasePose(null);
  W.remove('bolted'); W.remove('free');
});

test('a mimic joint is never a degree of freedom', async () => {
  const id = 'lekiwi-pincopen';
  const model = await pkg.loadEmbedded(id);
  const W = createCollisionWorld({ model });
  const derived = new Set(Object.keys(model.derivedJoints()));
  assert.ok(derived.size > 0, 'the PincOpen four-bar has mimic joints');
  for (const n of W.armJoints) assert.ok(!derived.has(n), `${id}: collide offers the derived joint ${n}`);
  for (const n of model.controlJoints()) assert.ok(!derived.has(n), `${id}: controlJoints offers the derived joint ${n}`);
  assert.deepEqual(W.armJoints, W.armJoints.filter((n) => model.controlJoints().includes(n)));
});
