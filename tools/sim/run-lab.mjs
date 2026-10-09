// The enzyme-screen lab task, headless on MuJoCo WASM: phase timeline, outcome, report.json + ctrl.f32.
//   node tools/sim/run-lab.mjs [out/work/sim/lab]
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, compile } from '../../src/features/sim-engine.js';
import { createLab } from '../../src/features/sim-lab.js';
import { readOut } from './lib.mjs';
import { SIM } from '../paths.mjs';

const DIR = path.resolve(process.argv[2] || path.join(SIM, 'lab'));

const t0 = performance.now();
const mj = await loadEngine();
const tInit = performance.now();
const src = readOut(DIR);
const m = compile(mj, src);
const d = new mj.MjData(m);
const scene = src.sidecar;
const tCompile = performance.now();

const rows = [];
const fmt = (p) => {
  const ik = p.ik ? `ik ${p.ik.pos_err_mm.toFixed(2)} mm/${p.ik.rot_err_deg.toFixed(2)} deg ${p.ik.via} via ${p.ik.ms} ms` : '';
  const g = p.grasp ? `grasp ${p.grasp.verified ? 'held' : 'FAILED'} @${p.grasp.contact_gap_mm} mm` : '';
  const ins = p.insertion ? `seat ${p.insertion.success ? 'OK' : 'FAILED'} (${p.insertion.offset_mm} mm off, ${p.insertion.above_floor_mm} mm up, ${p.insertion.tilt_deg} deg)` : '';
  const c = p.carry_held != null ? `carry ${p.carry_held ? 'held' : 'DROPPED'} tilt ${p.puck.tilt_deg} deg` : '';
  const w = p.wait ? `${p.wait.station} ${p.wait.state}` : '';
  const inst = Object.entries(p.instruments).map(([k, v]) => `${k}:${v}`).join(' ');
  return `  ${p.phase.padEnd(15)} t=${p.t_start.toFixed(2).padStart(6)}..${p.t_end.toFixed(2).padStart(6)} s  ${[ik, g, c, ins, w].filter(Boolean).join('  ')}  [${inst}]`;
};
const lab = createLab(mj, m, d, scene, {
  onCtrl: (u) => rows.push(Float32Array.from(u)),
  onPhase: (p) => console.log(fmt(p)),
});
const tRun = performance.now();
while (lab.step());
const tDone = performance.now();

const o = lab.outcome;
const props = {};
for (const n of scene.props.map((p) => p.name)) {
  const b = lab.ix.body(n);
  props[n] = { xpos: Array.from(d.xpos.subarray(3 * b, 3 * b + 3)), xquat: Array.from(d.xquat.subarray(4 * b, 4 * b + 4)) };
}
const ikMs = lab.records.filter((p) => p.ik).map((p) => p.ik.ms);
const ikTotal = ikMs.reduce((a, b) => a + b, 0);
const timing = {
  init_ms: Math.round(tInit - t0), compile_ms: Math.round(tCompile - tInit),
  task_wall_ms: Math.round(tDone - tRun), total_ms: Math.round(tDone - t0),
  ik_ms_total: Math.round(ikTotal), ik_ms_max: Math.max(...ikMs),
  step_ms_mean: +((tDone - tRun - ikTotal) / o.steps).toFixed(4),
  rss_mb: Math.round(process.memoryUsage().rss / 1e6),
};

const ctrl = new Float32Array(rows.length * m.nu);
rows.forEach((r, i) => ctrl.set(r, i * m.nu));
fs.writeFileSync(path.join(DIR, 'ctrl.f32'), Buffer.from(ctrl.buffer));
const report = {
  engine: '@mujoco/mujoco 3.14.0 (wasm, single thread)', model: 'scene.xml', design_hash: scene.design_hash,
  nq: m.nq, nv: m.nv, nu: m.nu, timestep: m.opt.timestep,
  ctrl_log: { file: 'ctrl.f32', dtype: 'float32', rows: rows.length, cols: m.nu,
    actuators: Array.from({ length: m.nu }, (_, i) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i)) },
  schema: 'rps/lab@2', outcome: o, final_props: props, timing, phases: lab.records,
};
fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 1) + '\n');

console.log(`\n${o.complete ? 'task complete' : 'TASK INCOMPLETE'}: transfers ${o.transfers}/${o.transfers_planned}; puck path ${o.puck_path.join(' -> ')} (ends in ${o.puck_seated_at}); grasps ${o.grasps_verified.join(', ') || 'none'} @ ${o.contact_gap_mm.join(', ')} mm; carry held ${o.carry_held.join(', ')}, carry tilt ${o.worst_carry_tilt_deg} deg (peak while held ${o.peak_held_tilt_deg} deg)`);
console.log(`instruments: ${o.instrument_events.map((e) => `${e.station}:${e.state}@${e.t}`).join(' ')}`);
console.log(`nav clearance min ${o.nav_clearance_min_mm} mm (${o.nav_clearance_to}); interlock min ${o.interlock_min_mm} mm (${o.interlock_station}); scenery contacts [${o.scenery_contacts.map((c) => `${c.pair} ${c.max_pen_mm} mm`).join(', ')}]`);
console.log(`peak torque ${o.peak_torque_max_Nm} N.m; saturated [${o.saturated}]; over usable [${o.over_usable}]; self-collision [${o.self_collision_pairs}]`);
console.log(`${o.steps} steps, ${o.sim_seconds} s sim; wall ${timing.task_wall_ms} ms (IK ${timing.ik_ms_total} ms, max ${timing.ik_ms_max} ms/phase), compile ${timing.compile_ms} ms`);
lab.free();
d.delete();
m.delete();
process.exitCode = o.complete ? 0 : 1;
