/* Every shipped robot compiles and teleops: stock LeKiwi drives and jogs its arm; simSupport
 * says which runs the lab; an attachment package is not a robot of its own. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMjcf, simSupport } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine, createSim, indexSim, robotPose } from '../../../src/features/sim-engine.js';
import { createTeleop } from '../../../src/features/sim-teleop.js';
import { createMetrics } from '../../../src/features/sim-metrics.js';
import { loadStudio } from '../../sim/lib.mjs';

const mj = await loadEngine();

async function open(robot) {
  const st = await loadStudio(robot);
  const c = compileDesign(mj, buildMjcf(st));
  const sim = createSim(mj, c.model);
  const tele = createTeleop(mj, c.model, sim.data, c.sidecar);
  const met = createMetrics(mj, c.model, c.sidecar);
  const ix = indexSim(mj, c.model, c.sidecar);
  tele.sync();
  const run = (sec) => {
    for (let i = 0; i < Math.round(sec / 0.002); i++) { tele.step(0.002); sim.step(1); met.afterStep(sim.data); }
    met.sample(sim.data);
    return robotPose(sim.data, ix);
  };
  return { st, c, sim, tele, met, run };
}

test('stock lekiwi: compiles, W drives, the arrows jog, F works the stock jaw servo; no lab', async () => {
  const r = await open('lekiwi');
  const sup = simSupport(r.st.model);
  assert.equal(sup.teleop, true);
  assert.equal(sup.lab, false);
  assert.equal(r.c.sidecar.jaw_joints.length, 0);
  r.tele.held.add('fwd');
  const p = r.run(0.6);
  r.tele.held.delete('fwd');
  r.tele.stop();
  assert.ok(p.base.y > 50, `y ${p.base.y}`);
  const j = r.tele.joints[r.tele.selected];
  const q0 = r.run(0.2).joints[j];
  r.tele.held.add('down');                                   // up ends at +5.2 deg, the limit, on this arm
  r.run(0.3);
  r.tele.held.delete('down');
  const q1 = r.run(0.4).joints[j];                           // the jog's speed ramps out over 0.25 s after the release
  assert.ok(Math.abs(q1 - q0) > 12, `${j} ${q0} -> ${q1}`);
  const g = r.tele.joints.find((n) => /gripper/.test(n));
  const g0 = r.run(0).joints[g];
  r.tele.gripper();
  const g1 = r.run(2.5).joints[g];
  assert.ok(Math.abs(g1 - g0) > 20, `${g} ${g0} -> ${g1}`);
  r.sim.free();
});

test('lekiwi-pincopen: simSupport offers the lab', async () => {
  const st = await loadStudio('lekiwi-pincopen');
  const sup = simSupport(st.model);
  assert.equal(sup.teleop && sup.lab, true);
  assert.equal(sup.reason, null);
});

test('the PincOpen package is an attachment: the sim tools refuse it as a robot', async () => {
  await assert.rejects(loadStudio('pincopen'), /not a robot/);
});

test('a robot with nothing to move says why', () => {
  const sup = simSupport({ manifest: { kinematics: {} }, controlJoints: () => [], attachments: [] });
  assert.equal(sup.teleop, false);
  assert.match(sup.reason, /no moving joint/);
});
