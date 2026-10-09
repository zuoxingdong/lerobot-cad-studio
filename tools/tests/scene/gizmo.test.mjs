/* scene/gizmo.js, the pure half: snapping, the param-handle drag maths, the plane table and
   the handle's drawn frame. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { quantise, dragAmount, PLANES, MODES, handleOrientation } from '../../../src/scene/gizmo.js';

test('quantise snaps, then clamps, and leaves no floating-point dust', () => {
  assert.equal(quantise(3.14159, { step: 0.25, min: 0, max: 5 }), 3.25);
  assert.equal(quantise(99, { min: 0, max: 5 }), 5);
  assert.equal(quantise(2.5, {}), 2.5);
  assert.equal(quantise(4.9, { step: 1, min: 0, max: 4 }), 4);
  assert.equal(quantise(0.4, { step: 1, min: 0.5, max: 9 }), 0.5);
  assert.equal(quantise(0.30000000000000004, { step: 0.1 }), 0.3);
  for (const v of [0.1, 0.3, 1.7, 12.35, -0.7]) {
    const q = quantise(v, { step: 0.1 });
    assert.ok((String(q).split('.')[1] || '').length <= 3 && Math.abs(q - v) <= 0.05 + 1e-9, v + ' -> ' + q);
  }
});

test('dragAmount projects the pointer onto the axis; a degenerate axis is 0; a full drag lands and clamps', () => {
  assert.equal(dragAmount(10, 0, { x: 2, y: 0 }), 5);
  assert.equal(dragAmount(10, 0, { x: 0, y: 2 }), 0);
  assert.equal(dragAmount(-6, 0, { x: 3, y: 0 }), -2);
  assert.equal(dragAmount(50, 50, { x: 0, y: 0 }), 0);
  assert.equal(dragAmount(3, 4, { x: 3, y: 4 }), 1);
  assert.ok(Math.abs(dragAmount(-4, 3, { x: 3, y: 4 })) < 1e-12);
  const def = { value: 250, min: 60, max: 520, step: 1, perMm: 1 }, dpx = { x: 0, y: -1.6 };
  assert.equal(quantise(def.value + dragAmount(0, -80, dpx), def), 300);
  assert.equal(quantise(def.value + dragAmount(0, 400, dpx), def), 60);
});

test('the plane table and the modes are what the UI and TransformControls take', () => {
  assert.deepEqual(Object.keys(PLANES).sort(), ['all', 'x', 'xy', 'xz', 'y', 'yz', 'z']);
  assert.deepEqual(PLANES.xy, [1, 1, 0]);
  for (const v of Object.values(PLANES)) assert.ok(v.length === 3 && v.every((n) => n === 0 || n === 1));
  assert.deepEqual(MODES, ['translate', 'rotate', 'scale']);
});

test('a handle is drawn in the frame it drags in: arrow along the drag axis, arc normal on the rotated axis', () => {
  const o = handleOrientation('z', new THREE.Matrix4().makeRotationX(Math.PI / 2), 'translate');
  assert.ok(Math.abs(o.axisLocal.z - 1) < 1e-12 && o.axisRobot.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-9);
  assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(o.quaternion).distanceTo(o.axisRobot) < 1e-9, 'the arrow points elsewhere');
  const r = handleOrientation('x', new THREE.Matrix4().makeRotationZ(Math.PI / 2), 'rotate');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(r.quaternion).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9);
  for (const [axis, want] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
    assert.ok(handleOrientation(axis, null, 'translate').axisRobot.distanceTo(new THREE.Vector3(...want)) < 1e-12, axis);
  }
});
