/* scene/viewport.js without a GPU: the named views in the robot frame and the section plane
   across the root's -90° rotation (robot +Z -> three +Y). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VIEWS, DEFAULTS, sectionPlane } from '../../../src/scene/viewport.js';

function rootMatrix() {
  const g = new THREE.Group();
  g.rotation.x = -Math.PI / 2;
  g.updateMatrixWorld(true);
  return g.matrixWorld;
}
const n9 = (p) => p.normal.toArray().map((v) => +v.toFixed(9));

test('the named views are robot-frame directions: front is +Y, top +Z, each has an opposite, iso is front-right-above', () => {
  assert.deepEqual([VIEWS.front, VIEWS.top, VIEWS.right], [[0, 1, 0], [0, 0, 1], [1, 0, 0]]);
  for (const [a, b] of [['front', 'back'], ['top', 'bottom'], ['left', 'right']]) {
    assert.ok(new THREE.Vector3(...VIEWS[a]).add(new THREE.Vector3(...VIEWS[b])).length() < 1e-9, a + ' / ' + b);
  }
  assert.ok(VIEWS.iso.every((v) => v > 0));
  assert.equal(DEFAULTS.groundZ, -32.9);
  assert.equal(DEFAULTS.gridMajor % DEFAULTS.gridStep, 0);
});

test('a robot section becomes the right world plane; a point on it stays on it; flip swaps the kept half', () => {
  const M = rootMatrix();
  assert.equal(sectionPlane(null, M), null);
  const z = sectionPlane({ axis: 'z', at: 57 }, M);
  assert.deepEqual(n9(z), [0, 1, 0]);
  assert.equal(+z.constant.toFixed(9), -57);
  assert.deepEqual(n9(sectionPlane({ axis: 'y', at: 100 }, M)), [0, 0, -1]);
  const x = sectionPlane({ axis: 'x', at: -12 }, M);
  assert.deepEqual([...n9(x), +x.constant.toFixed(9)], [1, 0, 0, 12]);
  for (const spec of [{ axis: 'z', at: 57, flip: true }, { axis: 'x', at: 0 }, { axis: 'y', at: -30, flip: true }]) {
    const pt = new THREE.Vector3(spec.axis === 'x' ? spec.at : 12, spec.axis === 'y' ? spec.at : 34, spec.axis === 'z' ? spec.at : -5).applyMatrix4(M);
    assert.ok(Math.abs(sectionPlane(spec, M).distanceToPoint(pt)) < 1e-9, JSON.stringify(spec));
  }
  const b = sectionPlane({ axis: 'z', at: 57, flip: true }, M);
  const above = new THREE.Vector3(0, 0, 120).applyMatrix4(M), below = new THREE.Vector3(0, 0, 10).applyMatrix4(M);
  assert.ok(z.distanceToPoint(above) > 0 && z.distanceToPoint(below) < 0 && b.distanceToPoint(above) < 0);
  assert.ok(Math.abs(sectionPlane({ axis: 'w', at: 0 }, M).normal.length() - 1) < 1e-9, 'an unknown axis degenerates');
  const src = new THREE.Plane(new THREE.Vector3(0, 0, 1), -57);
  const out = sectionPlane(src, M);
  assert.ok(out !== src && src.normal.z === 1 && n9(out)[1] === 1, 'a THREE.Plane is cloned, not mutated');
});
