/* features/sim-lab.js on the default design, MuJoCo WASM: the enzyme-screen task completes (the
 * puck seated lh -> inc -> reader, both instruments cycle in order), no limit hit, the controller
 * writes ctrl only, IK within tolerance, the ctrl log replays to the same state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { studio } from './_harness.mjs';
import { buildMjcf } from '../../../src/features/sim-mjcf.js';
import { compileDesign } from '../../../src/features/sim-excludes.js';
import { loadEngine } from '../../../src/features/sim-engine.js';
import { sceneDoc } from '../../../src/features/sim-scene.js';
import { createLab, jawDegForGap } from '../../../src/features/sim-lab.js';
import { createMetrics } from '../../../src/features/sim-metrics.js';
import { PAD_COVER } from '../../../src/features/sim-physics.js';

const s = await studio();
const mj0 = await loadEngine();
const built = compileDesign(mj0, buildMjcf({ model: s.model, slots: s.slots, design: s.design, scene: await sceneDoc('lab') }));
const m = built.model, scene = built.sidecar;
const d = new mj0.MjData(m);

// Every mj_* call on the live data is seen; between two mj_steps its qpos/qvel must not move.
const guard = { steps: 0, stateWrites: 0, otherCalls: new Set() };
let snap = null;
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const mj = new Proxy(mj0, {
  get(t, k) {
    const f = t[k];
    if (typeof f !== 'function' || !String(k).startsWith('mj_')) return f;
    return (...args) => {
      if (args[1] !== d) return f.apply(t, args);
      if (k === 'mj_step') {
        if (snap && !(same(snap.q, d.qpos) && same(snap.v, d.qvel))) guard.stateWrites++;
        const r = f.apply(t, args);
        guard.steps++;
        snap = { q: Float64Array.from(d.qpos), v: Float64Array.from(d.qvel) };
        return r;
      }
      if (k !== 'mj_forward' && !(k === 'mj_resetData' && guard.steps === 0)) guard.otherCalls.add(k);
      return f.apply(t, args);
    };
  },
});

const rows = [];
const lab = createLab(mj, m, d, scene, { onCtrl: (u) => rows.push(Float32Array.from(u)) });
const met = createMetrics(mj0, m, scene);
let calls = 0;
while (lab.step()) { calls++; met.sample(d); }
const o = lab.outcome;

test('the task completes: 32 phases, the puck seated lh -> inc -> reader, 2/2 transfers', () => {
  console.log(`  ${o.steps} steps, ${o.sim_seconds} s sim, peak ${o.peak_torque_max_Nm} N.m, nav ${o.nav_clearance_min_mm} mm, offsets ${o.insertions.map((i) => i.offset_mm)}`);
  assert.equal(lab.done, true);
  assert.equal(lab.phases.length, 32);
  assert.equal(o.complete, true);
  assert.deepEqual(o.puck_path, ['lh', 'inc', 'reader']);
  assert.equal(o.puck_seated_at, 'reader');
  assert.equal(o.transfers, 2);
  assert.deepEqual(o.stations_visited, ['lh', 'inc', 'reader']);
  assert.deepEqual(o.insertions.map((i) => [i.station, i.success]), [['inc', true], ['reader', true]]);
  assert.equal(o.grasps_verified.length, 2);
  assert.ok(o.contact_gap_mm.every((g) => Math.abs(g - (16.8 + 2 * PAD_COVER.mm)) <= 0.4), `contact gap ${o.contact_gap_mm}`);   // the covers meet the post early
  assert.deepEqual(o.carry_held, [true, true]);
  assert.ok(o.worst_carry_tilt_deg < 5, `carry tilt ${o.worst_carry_tilt_deg}`);
  assert.ok(o.sim_seconds >= 45 && o.sim_seconds <= 75, `${o.sim_seconds} s`);
});

test('torque, clearance, contact: peak under 2.0 N.m, nav >= 80 mm, no scenery contact, lids clear by 150 mm', () => {
  assert.equal(o.saturated.length, 0);
  assert.ok(o.peak_torque_max_Nm < 2.0, `peak ${o.peak_torque_max_Nm} N.m`);
  assert.equal(o.self_collision_pairs.length, 0);
  assert.ok(o.nav_clearance_min_mm >= 80, `nav ${o.nav_clearance_min_mm} mm (${o.nav_clearance_to})`);
  assert.deepEqual(o.scenery_contacts, []);
  assert.ok(o.interlock_min_mm >= 150, `interlock ${o.interlock_min_mm} mm`);
});

test('the instruments cycle in order: the wait ends on inc done, the report on reader done', () => {
  const seq = o.instrument_events.map((e) => `${e.station}:${e.state}`);
  assert.deepEqual(seq, ['lh:running', 'inc:armed', 'inc:closing', 'inc:running', 'inc:opening', 'inc:done', 'inc:idle',
    'reader:armed', 'reader:closing', 'reader:running', 'reader:opening', 'reader:done']);
  assert.ok(o.incubated && o.read);
  const rec = (n) => lab.records.find((p) => p.phase === n);
  assert.equal(rec('wait_inc').wait.reached, true);
  assert.equal(rec('report').wait.reached, true);
  const incDone = o.instrument_events.find((e) => e.station === 'inc' && e.state === 'done');
  assert.ok(rec('return_inc').step_start >= incDone.step, 'left the backoff before the lid opened');
  const snap = lab.instruments.snapshot();
  assert.deepEqual(snap.stations.reader.bars, [0.22, 0.31, 0.93, 0.27]);
  assert.deepEqual(snap.loop, [true, false, false, true]);
});

test('a clean run touches no joint limit (sampled every step)', () => {
  assert.equal(met.value.limitHits, 0);
});

test('the controller writes ctrl only: one mj_step per step(), qpos/qvel untouched between steps', () => {
  assert.equal(guard.steps, calls);
  assert.equal(guard.steps, rows.length);
  assert.equal(guard.stateWrites, 0);
  assert.equal([...guard.otherCalls].join(','), '');
});

test('IK reaches every phase target within tolerance', () => {
  const arm = lab.records.filter((p) => p.kind === 'arm');
  assert.equal(arm.length, 1 + 2 * 4 + 2 * 4);
  for (const p of arm) {
    assert.ok(p.ik.ok, `${p.phase} not ok`);
    assert.ok(p.ik.pos_err_mm <= 0.2, `${p.phase} ${p.ik.pos_err_mm} mm`);
    assert.ok(p.ik.rot_err_deg <= 0.4, `${p.phase} ${p.ik.rot_err_deg} deg`);
    assert.equal(p.ik.path_hits.length, 0, `${p.phase} path hits`);
  }
});

test('the ctrl log replays open-loop to the same state (WASM)', () => {
  const d2 = new mj0.MjData(m);
  mj0.mj_resetData(m, d2);
  mj0.mj_forward(m, d2);
  for (const u of rows) {
    d2.ctrl.set(u);
    mj0.mj_step(m, d2);
  }
  const a = d.qpos, b = d2.qpos;
  let worst = 0;
  for (let i = 0; i < m.nq; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  d2.delete();
  assert.equal(worst, 0);
});

test('jawDegForGap inverts the four-bar gap', () => {
  const L = scene.linkage;
  assert.ok(Math.abs(jawDegForGap(0, L)) < 1e-9);
  const q = jawDegForGap(25, L);
  const gap = 2 * L.link_length_mm * (Math.sin(L.closed_crank_deg * Math.PI / 180) - Math.sin((L.closed_crank_deg - q) * Math.PI / 180));
  assert.ok(Math.abs(gap - 25) < 1e-9);
});

test('the guard itself catches a qpos write between steps', () => {
  const before = guard.stateWrites;
  d.qpos[0] += 1e-3;
  mj.mj_step(m, d);
  assert.equal(guard.stateWrites, before + 1);
});

test.after(() => { lab.free(); d.delete(); m.delete(); });
