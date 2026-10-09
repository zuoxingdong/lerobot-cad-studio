/* features/sim-wheels.js on the real LeKiwi package: the axles, rims and radius measured from the URDF
 * and the wheel mesh; the spin of each wheel on forward, strafe and turn; LeRobot's
 * _body_to_wheel_raw matrix up to the joint sign; no slip along the drive direction through the FK. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { studio } from './_harness.mjs';
import { wheelSpecs, wheelRates, createWheelSpin } from '../../../src/features/sim-wheels.js';

const s = await studio();
await s.model.loadGeometries();
const model = s.model;
model.setJoints(Object.fromEntries(model.controlJoints().map((k) => [k, 0])));
const W = wheelSpecs(model);
const by = Object.fromEntries(W.map((w) => [w.joint, w]));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('three drive wheels: 4-inch omni rims (r 50.8 mm), horizontal axles, back wheel on the forward axis', () => {
  assert.deepEqual(W.map((w) => w.joint).sort(), ['base_back_wheel', 'base_left_wheel', 'base_right_wheel']);
  for (const w of W) {
    near(w.radius_mm, 50.8, 0.1, `${w.joint} radius`);
    near(w.axle[2], 0, 1e-6, `${w.joint} axle horizontal`);
    near(w.rim_mm[2] - w.radius_mm, -32.98, 0.05, `${w.joint} rim bottom under the base frame`);
  }
  near(Math.abs(by.base_back_wheel.axle[1]), 1, 1e-6, 'back axle along the forward axis');
  near(by.base_back_wheel.rim_mm[1], -142.1, 0.2, 'back rim, y');
  for (const k of ['left', 'right']) near(Math.hypot(...by[`base_${k}_wheel`].rim_mm.slice(0, 2)), 122.5, 0.6, `${k} rim radius`);
});

test('forward: the back wheel does not turn, the front two spin opposite in joint sign, 0.866 v / r', () => {
  const r = Object.fromEntries(W.map((w, i) => [w.joint, wheelRates(W, 0, 0.2, 0)[i]]));
  near(r.base_back_wheel, 0, 1e-9, 'back');
  near(r.base_left_wheel, -r.base_right_wheel, 1e-9, 'left vs right');
  near(Math.abs(r.base_left_wheel), 0.866 * 0.2 / 0.0508, 0.01, 'front rate');
});

test('strafe: the back wheel rolls at v / r, the front two at half that, the same joint sign', () => {
  const r = Object.fromEntries(W.map((w, i) => [w.joint, wheelRates(W, 0.2, 0, 0)[i]]));
  near(Math.abs(r.base_back_wheel), 0.2 / 0.0508, 0.01, 'back');
  near(r.base_left_wheel, r.base_right_wheel, 1e-9, 'fronts');
  near(Math.abs(r.base_left_wheel), 0.5 * 0.2 / 0.0508, 0.01, 'front rate');
  assert.ok(Math.sign(r.base_back_wheel) !== Math.sign(r.base_left_wheel));
});

test('turn: all three spin the same way, rim speed = omega x the rim radius', () => {
  const r = wheelRates(W, 0, 0, 1);
  assert.ok(r.every((x) => x < 0) || r.every((x) => x > 0), r.join(' '));
  W.forEach((w, i) => near(Math.abs(r[i]) * w.radius_mm, Math.hypot(w.rim_mm[0], w.rim_mm[1]), 0.5, `${w.joint} rim speed per rad/s`));
});

test("LeRobot's matrix (mounts 240, 0, 120 deg minus 90, x forward) is ours up to the joint sign", () => {
  const L = { base_left_wheel: 150, base_back_wheel: -90, base_right_wheel: 30 };
  for (const w of W) {
    const a = L[w.joint] * Math.PI / 180;
    /* LeRobot row . [vx_L, vy_L] with vx_L = our +y, vy_L = our -x */
    const ours = [0, 1].map((k) => wheelRates([w], k ? 0 : -1, k ? 1 : 0, 0)[0] * w.radius_mm / 1000);
    near(ours[0], -Math.sin(a), 1e-3, `${w.joint} lateral`);         // vy_L = 1: our vx = -1
    near(ours[1], -Math.cos(a), 1e-3, `${w.joint} forward`);         // vx_L = 1: our vy = 1
    near(-wheelRates([w], 0, 0, 1)[0] * w.radius_mm / 1000, Math.hypot(w.rim_mm[0], w.rim_mm[1]) / 1000, 1e-3, `${w.joint} arm`);
  }
});

test('no slip through the FK: the rim point at the floor stays put along its drive direction', () => {
  const v = [0.21, 0.13, 0.9], dt = 1e-4;
  for (const w of W) {
    const rim = new THREE.Vector3(...w.rim_mm).applyMatrix4(model.baseMatrix());
    const cid = model.components.find((c) => /Omni-Directional-Wheel/.test(c.id)
      && new THREE.Vector3().setFromMatrixPosition(model.worldMatrix(c.id)).distanceTo(rim) < 60).id;
    const pose = (x, y, yaw, q) => { model.setBasePose({ x, y, yaw }); model.setJoints({ [w.joint]: q }); return model.worldMatrix(cid).clone(); };
    const M0 = pose(0, 0, 0, 0);
    const foot = rim.clone().add(new THREE.Vector3(0, 0, -w.radius_mm));
    const local = foot.clone().applyMatrix4(M0.clone().invert());
    const q = wheelRates([w], ...v)[0] * dt * 180 / Math.PI;
    const M1 = pose(v[0] * dt * 1000, v[1] * dt * 1000, v[2] * dt * 180 / Math.PI, q);
    const moved = local.clone().applyMatrix4(M1).sub(foot);
    const drive = new THREE.Vector3(w.axle[1], -w.axle[0], 0).normalize();
    const along = moved.dot(drive), base = Math.hypot(v[0], v[1]) * dt * 1000;
    assert.ok(Math.abs(along) < 0.002 * base, `${w.joint}: ${along} mm along the drive, base moved ${base} mm`);
  }
  model.setBasePose({ x: 0, y: 0, yaw: 0 });
  model.setJoints(Object.fromEntries(W.map((w) => [w.joint, 0])));
});

test('createWheelSpin integrates world velocity at any yaw into the same angles', () => {
  const a = createWheelSpin(W), b = createWheelSpin(W), yaw = 0.7, c = Math.cos(yaw), s = Math.sin(yaw);
  for (let k = 0; k < 100; k++) { a.step(0.01, [0, 0.2, 0.3], 0); b.step(0.01, [-s * 0.2, c * 0.2, 0.3], yaw); }
  for (const w of W) near(a.angles()[w.joint], b.angles()[w.joint], 1e-9, w.joint);
});
