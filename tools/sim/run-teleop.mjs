// A scripted teleop run, headless on MuJoCo WASM: the Sim tab's keys from a timeline file.
//   node tools/sim/run-teleop.mjs [out/work/sim/lab] [--script tools/sim/lab-tour.json] [--log <dir>]
// Writes <log>/ctrl.f32 + report.json (default <out>/teleop/), the run-lab.mjs format, for video.py.
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine, compile } from '../../src/features/sim-engine.js';
import { compileScript, playScript, DT } from './teleop.mjs';
import { args, readOut, STUDIO } from './lib.mjs';
import { SIM } from '../paths.mjs';

const a = args(process.argv.slice(2), { script: 'value', log: 'value' });
const DIR = path.resolve(a._[0] || path.join(SIM, 'lab'));
const file = path.resolve(a.script || path.join(STUDIO, 'tools/sim/lab-tour.json'));
const LOG = path.resolve(a.log || path.join(DIR, 'teleop'));

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const script = compileScript(doc);
const t0 = performance.now();
const mj = await loadEngine();
const src = readOut(DIR);
if (doc.robot && doc.robot !== src.sidecar.robot) throw new Error(`${path.basename(file)} is for "${doc.robot}", the export is "${src.sidecar.robot}"`);
const m = compile(mj, src);
const d = new mj.MjData(m);
const tCompile = performance.now();

const ctrl = new Float32Array(script.steps * m.nu);
let row = 0;
const peak = new Float64Array(m.nu);
const onStep = () => { const f = d.actuator_force; for (let i = 0; i < m.nu; i++) peak[i] = Math.max(peak[i], Math.abs(f[i])); };
const { phases, keys, events } = playScript(mj, m, d, src.sidecar, script, { onRow: (u) => { ctrl.set(u.subarray(0, m.nu), row * m.nu); row++; }, onStep });
const actNames = Array.from({ length: m.nu }, (_, i) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i));
const peakTorque = Object.fromEntries(actNames.map((n, i) => [n, +peak[i].toFixed(3)]).filter(([n]) => !n.startsWith('drive_')));
const tDone = performance.now();

const end = phases.at(-1), puckName = src.sidecar.props[0]?.name;
const lb = puckName ? mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, puckName) : -1;
const outcome = { steps: script.steps, sim_seconds: +(script.steps * DT).toFixed(3),
  carried: phases.some((p) => p.puck?.held && p.puck.lifted_mm > 20), puck_seated_at: end.puck?.seated_at ?? null,
  puck_path: [...new Set(phases.map((p) => p.puck?.seated_at).filter(Boolean))], instrument_events: events,
  instruments: end.instruments ?? {}, peak_torque_Nm: peakTorque };
const final = lb >= 0 ? { [puckName]: { xpos: Array.from(d.xpos.subarray(3 * lb, 3 * lb + 3)), xquat: Array.from(d.xquat.subarray(4 * lb, 4 * lb + 4)) } } : {};
fs.mkdirSync(LOG, { recursive: true });
fs.writeFileSync(path.join(LOG, 'ctrl.f32'), Buffer.from(ctrl.buffer));
const report = {
  kind: 'teleop', engine: '@mujoco/mujoco 3.14.0 (wasm, single thread)', model: path.relative(LOG, path.join(DIR, 'scene.xml')),
  design_hash: src.sidecar.design_hash, script: path.relative(STUDIO, file), nq: m.nq, nv: m.nv, nu: m.nu, timestep: m.opt.timestep,
  ctrl_log: { file: 'ctrl.f32', dtype: 'float32', rows: row, cols: m.nu,
    actuators: Array.from({ length: m.nu }, (_, i) => mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i)) },
  outcome, final_props: final,
  timing: { compile_ms: Math.round(tCompile - t0), run_ms: Math.round(tDone - tCompile) },
  phases, keys,
};
fs.writeFileSync(path.join(LOG, 'report.json'), JSON.stringify(report, null, 1) + '\n');

for (const p of phases) {
  const k = p.puck ? `puck ${p.puck.held ? 'held' : p.puck.both_pads ? 'touched' : '-'} ${p.puck.lifted_mm} mm${p.puck.seated_at ? ` seated ${p.puck.seated_at}` : ''}` : '';
  const inst = Object.entries(p.instruments || {}).map(([n, v]) => `${n}:${v}`).join(' ');
  console.log(`  ${p.label.padEnd(26)} t=${p.t_start.toFixed(2).padStart(6)}..${p.t_end.toFixed(2).padStart(6)} s  ${k}  [${inst}]`);
}
console.log(`\n${row} steps, ${outcome.sim_seconds} s sim; carried ${outcome.carried}, path ${outcome.puck_path.join(' -> ')}, ends in ${outcome.puck_seated_at}; wall ${report.timing.run_ms} ms`);
console.log(`instruments: ${events.map((e) => `${e.station}:${e.state}@${e.t}`).join(' ')}`);
console.log(`peak torque ${Object.entries(peakTorque).map(([n, v]) => `${n.replace('act_', '')} ${v}`).join(', ')} N.m`);
console.log(`wrote ${path.relative(process.cwd(), LOG)}/ctrl.f32, report.json`);
d.delete();
m.delete();
