/* features/sim-lab.js `sliceMs`: planning spread over step() calls gives the same ctrl log
 * and outcome as planning in one call, and no call runs long; sim-metrics.js sees the puck in
 * the reader and the instruments the lab reports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine } from '../../../src/features/sim-engine.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { createLab } from '../../../src/features/sim-lab.js';
import { createMetrics } from '../../../src/features/sim-metrics.js';

const s = await studio();
const mj = await loadEngine();
const built = compileDesign(mj, buildMjcf({ model: s.model, slots: s.slots, design: s.design, scene: await sceneDoc('lab') }));
const m = built.model, scene = built.sidecar;

function run(opts) {
  const d = new mj.MjData(m);
  const rows = [];
  const lab = createLab(mj, m, d, scene, { ...opts, onCtrl: (u) => rows.push(Float32Array.from(u)) });
  let worst = 0, calls = 0, planningCalls = 0;
  for (;;) {
    const t = performance.now();
    const more = lab.step();
    worst = Math.max(worst, performance.now() - t);
    calls++;
    if (lab.planning) planningCalls++;
    if (!more) break;
  }
  const met = createMetrics(mj, m, scene, { instruments: () => lab.instruments });
  met.sample(d);
  const out = { outcome: lab.outcome, rows, worst, calls, planningCalls, seatedAt: met.value.seatedAt, stations: met.value.stations };
  lab.free();
  d.delete();
  return out;
}

const a = run({});
const b = run({ sliceMs: 8 });

test('sliced planning replays the same ctrl log and outcome', () => {
  assert.equal(b.rows.length, a.rows.length);
  let diff = 0;
  for (let i = 0; i < a.rows.length; i++) for (let j = 0; j < m.nu; j++) if (!Object.is(a.rows[i][j], b.rows[i][j])) diff++;
  assert.equal(diff, 0);
  assert.equal(b.outcome.complete, true);
  assert.equal(b.seatedAt, 'reader', 'the metrics panel sees the puck in the reader');
  assert.equal(b.stations.reader.state, 'done');
  assert.equal(JSON.stringify(b.outcome.instrument_events), JSON.stringify(a.outcome.instrument_events));
  assert.equal(JSON.stringify(b.outcome.insertions), JSON.stringify(a.outcome.insertions));
});

test('no sliced step() call is long; planning calls do not step', () => {
  console.log(`  one-shot worst ${a.worst.toFixed(1)} ms; sliced worst ${b.worst.toFixed(1)} ms over ${b.calls} calls, ${b.planningCalls} planning`);
  assert.ok(a.worst > 100, `the one-shot plan should be the long call (${a.worst.toFixed(1)} ms)`);
  assert.ok(b.worst < 50, `worst sliced call ${b.worst.toFixed(1)} ms`);
  assert.equal(b.calls - b.planningCalls - 1, b.outcome.steps);
});

test.after(() => m.delete());
