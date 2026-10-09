/* features/sim-teleop.js + sim-metrics.js on the default design: W drives forward, Q turns,
 * the arrows jog one joint inside its limits, F opens and closes the jaw, H ramps home. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine, createSim, indexSim, robotPose } from '../../../src/features/sim-engine.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { createTeleop } from '../../../src/features/sim-teleop.js';
import { createMetrics } from '../../../src/features/sim-metrics.js';

const s = await studio();
const mj = await loadEngine();
const c = compileDesign(mj, buildMjcf({ model: s.model, slots: s.slots, design: s.design, scene: await sceneDoc('lab') }));
const sim = createSim(mj, c.model);
const ix = indexSim(mj, c.model, c.sidecar);
const tele = createTeleop(mj, c.model, sim.data, c.sidecar);
const met = createMetrics(mj, c.model, c.sidecar);
tele.sync();

function run(sec) {
  for (let i = 0; i < Math.round(sec / 0.002); i++) {
    tele.step(0.002);
    sim.step(1);
    met.afterStep(sim.data);
  }
  met.sample(sim.data);
  return robotPose(sim.data, ix);
}

test('W for 1 s drives the base forward (+Y) by more than 0.1 m, then Space stops it', () => {
  tele.held.add('fwd');
  const p = run(1);
  tele.held.delete('fwd');
  console.log(`  y ${p.base.y.toFixed(1)} mm, x ${p.base.x.toFixed(1)} mm, yaw ${p.base.yaw.toFixed(2)} deg`);
  assert.ok(p.base.y > 100, `y ${p.base.y}`);
  assert.ok(Math.abs(p.base.x) < 5);
  tele.stop();
  const a = run(0.3).base.y, b = run(0.3).base.y;
  assert.ok(Math.abs(b - a) < 2, `still moving ${b - a} mm`);
});

test('Q turns left, Shift is faster', () => {
  const y0 = run(0).base.yaw;
  tele.held.add('turnL');
  const slow = run(0.5).base.yaw - y0;
  tele.fast = true;
  const y1 = run(0).base.yaw;
  const fast = run(0.5).base.yaw - y1;
  tele.held.delete('turnL');
  tele.fast = false;
  tele.stop();
  run(0.5);
  assert.ok(slow > 5 && fast > slow, `slow ${slow} fast ${fast}`);
});

test('the arrows pick a joint and jog it inside its limit', () => {
  const name = tele.select(1);
  const i = tele.selected;
  const q0 = run(0).joints[name];
  tele.held.add('up');
  const qa = run(0.5).joints[name];
  tele.held.delete('up');
  const q1 = run(0.6).joints[name];
  /* the speed ramps in over 0.25 s, and out after the release: the jog ends 30 deg on */
  assert.ok(qa - q0 > 15 && qa - q0 < 24, `${name} ${q0} -> ${qa} while held`);
  assert.ok(q1 - q0 > 28 && q1 - q0 < 31, `${name} ${q0} -> ${q1}`);
  tele.held.add('up');
  const hi = tele.limits()[i][1];
  run(8);
  tele.held.delete('up');
  const q2 = run(0.5).joints[name];
  assert.ok(q2 <= hi + 0.5 && q2 > hi - 3, `${q2} vs limit ${hi}`);
  assert.ok(met.value.limitHits >= 1);
  tele.recentre();
  assert.ok(Math.abs(run(6).joints[name]) < 1);
});

test('F opens the jaw, F again closes it', () => {
  const jaw = c.sidecar.jaw_joints[0];
  assert.equal(tele.gripper(), true);
  const open = run(1.2).joints[jaw];
  assert.equal(tele.gripper(), false);
  const shut = run(1.2).joints[jaw];
  console.log(`  jaw open ${open.toFixed(2)} deg, closed ${shut.toFixed(2)} deg`);
  assert.ok(open > 25 && shut < 2);
});

test('H ramps home; metrics read sane numbers', () => {
  tele.nextPreset();
  run(4);
  tele.home();
  const p = run(5);
  for (const n of c.sidecar.arm_joints) assert.ok(Math.abs(p.joints[n] - (c.sidecar.presets.stowed[n] || 0)) < 1.5, `${n} ${p.joints[n]}`);
  const v = met.value;
  assert.ok(v.peak > 0 && v.peak < 3, `peak ${v.peak}`);
  assert.equal(v.self, 0, v.selfPairs.join(','));
  assert.equal(met.levels().torque, v.peak > 2 ? 'warn' : 'pass');
});

test.after(() => sim.free());
