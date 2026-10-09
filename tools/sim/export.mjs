// Export a robot + design as the MuJoCo lab scene the Sim tab runs.
//   node tools/sim/export.mjs --robot lekiwi-pincopen [--design d.json] [--visual] [--lab] [--out out/work/sim/lab]
// --visual adds the display meshes as visual-only geoms (sim-visual.js); physics is unchanged.
// --lab then runs the lab task on the export (run-lab.mjs, in its own process).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../src/features/sim-engine.js';
import { buildMjcf } from '../../src/features/sim-mjcf.js';
import { compileDesign } from '../../src/features/sim-excludes.js';
import { addVisuals } from '../../src/features/sim-visual.js';
import { args, loadStudio, writeOut } from './lib.mjs';
import { SIM } from '../paths.mjs';

const a = args(process.argv.slice(2), { robot: 'value', design: 'value', out: 'value', visual: 'flag', lab: 'flag' });
const robot = a.robot || 'lekiwi-pincopen';
const out = path.resolve(a.out || path.join(SIM, 'lab'));

const t0 = performance.now();
const st = await loadStudio(robot, a.design ? path.resolve(a.design) : null);
const tLoad = performance.now();
const built = buildMjcf(st);
const tBuild = performance.now();
const mj = await loadEngine();
const tInit = performance.now();
const first = compileDesign(mj, built);
first.model.delete();
const again = compileDesign(mj, built);          // excludes cached: what a re-open costs
again.model.delete();

const sc = first.sidecar;
sc.timing_ms = { load: Math.round(tLoad - t0), build: Math.round(tBuild - tLoad), init: Math.round(tInit - tBuild),
  first_compile_with_sweep: first.ms.first + first.ms.compile, compile_cached: again.ms.compile };
fs.mkdirSync(out, { recursive: true });
let vis = null;
if (a.visual) {
  const tv = performance.now();
  vis = addVisuals(mj, st, built, first);
  vis.ms = Math.round(performance.now() - tv);
}
writeOut(out, vis ? { xml: vis.xml, meshes: vis.meshes, sidecar: vis.sidecar, design: st.design }
  : { xml: first.xml, meshes: built.meshes, sidecar: sc, design: st.design });

const mb = [...built.meshes.values()].reduce((s, b) => s + b.byteLength, 0) / 1e6;
const m = sc.model;
console.log(`wrote ${path.relative(process.cwd(), out)}/scene.xml  (hash ${first.hash})`);
console.log(`  design   ${JSON.stringify(sc.slots)}`);
console.log(`  bodies ${m.nbody}  nq ${m.nq}  nv ${m.nv}  nu ${m.nu}  geoms ${m.ngeom}  meshes ${m.nmesh}  excludes ${m.nexclude} (${m.excludes_static} static + ${Object.keys(m.baseline).length} loop)`);
console.log(`  ${sc.components} components (${sc.printable} printable), ${mb.toFixed(1)} MB of hull points; robot ${sc.robot_mass_kg} kg`);
console.log(`  loops    ${Object.entries(m.baseline).map(([k, v]) => `${k} ${v} mm`).join(', ') || 'none'}`);
console.log(`  time     load ${sc.timing_ms.load} ms, build ${sc.timing_ms.build} ms, wasm init ${sc.timing_ms.init} ms, `
  + `first compile + sweep ${sc.timing_ms.first_compile_with_sweep} ms, cached compile ${sc.timing_ms.compile_cached} ms`);
if (vis) console.log(`  visual   ${vis.sidecar.visual.geoms} display meshes, ${vis.triangles} triangles, geoms ${vis.sidecar.model.ngeom}; ${vis.ms} ms`);
for (const n of sc.notes) console.log(`  note: ${n}`);
if (a.lab) {
  const run = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-lab.mjs');
  process.exitCode = spawnSync(process.execPath, [run, out], { stdio: 'inherit' }).status ?? 1;
}
